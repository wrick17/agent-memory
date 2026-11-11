#!/usr/bin/env node
// Repo facts v2 history replay (#120). Read-only and offline: reads the owner's local Claude Code and Codex transcripts, builds each
// session's redacted command digest (local/facts.mjs), runs the v2 detectors (local/facts-detect.mjs) per repo in session order, and
// replays the section 6 lifecycle under a sweep of thresholds. No model, no network, no writes outside --cache and --out.
//
// The lifecycle is a parameterised mirror of src/profile/facts.ts (recompute, activationOrder, injectable, injectableFacts and the
// session-report part of applyFacts), because REPO_FACT_RULES is frozen and the server's lifecycle is not exported as a pure function.
// One device, so every environment lane is the same lane; one profile, so a partition is a repo key. Not mirrored: proposals and
// learned facts (synthesis needs a model), flags, the dormant cap, receipts and the watermark.
//
// Usage: node local/facts-replay.mjs --cache <dir> --out <report.md> [--json <file>] [--roots a,b,c] [--max-files N]
// Prints only counts. The report holds counts, repo keys and fact literals (already redacted and grammar-checked by the detectors).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLines } from "./agent-memory.mjs";
import { commandDigest, mergeDigest, pairResolver, sliceDigest, usageOf } from "./facts.mjs";
import { describe, detect, familyHash, outcomes } from "./facts-detect.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const idOf = (raw) => sha(String(raw)).slice(0, 12);
const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "");
const CLASS = { command_repair: "environment", unavailable_tool: "environment", env_var: "environment", network: "environment", empty_vcs: "environment", form_repair: "environment", arg_repair: "repo" };
const LIMITS = { confirmations: 12, events: 16, live: 32, inject: 4, families: 32 };
const DEVICE = "d1", SHARED = "*";

function args(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
	return o;
}

// ---------- phase 1: transcripts to cached digests ----------

/** Every top-level transcript: Claude Code <root>/<project>/<session>.jsonl (subagent transcripts excluded), Codex rollouts. */
function transcripts(roots) {
	const out = [];
	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		const codex = root.includes(`${path.sep}.codex${path.sep}`);
		if (codex) {
			const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl")) out.push({ client: "codex", file: p }); } };
			walk(root);
		} else {
			for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
				if (!proj.isDirectory()) continue;
				for (const f of fs.readdirSync(path.join(root, proj.name))) if (f.endsWith(".jsonl")) out.push({ client: "claude-code", file: path.join(root, proj.name, f) });
			}
		}
	}
	return out;
}

/** Per command id: the characters it put into context (command text plus raw output). Kept only as numbers. */
function costs(client, lines) {
	const out = {};
	for (const { obj } of lines) {
		if (client === "codex") {
			const p = obj?.payload, it = p?.type === "item_completed" ? p.item : null;
			if (obj?.type === "event_msg" && it?.type === "CommandExecution") out[idOf(it.id ?? `${obj.timestamp}:${it.command}`)] = JSON.stringify(it.command ?? "").length + String(it.aggregated_output ?? "").length;
			else if (obj?.type === "event_msg" && p?.type === "exec_command_end") out[idOf(p.call_id ?? `${obj.timestamp}:${p.command}`)] = JSON.stringify(p.command ?? "").length + String(p.aggregated_output ?? `${p.stdout ?? ""}${p.stderr ?? ""}`).length;
		} else if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) if (b?.type === "tool_use" && b.name === "Bash") out[idOf(b.id)] = (out[idOf(b.id)] ?? 0) + String(b.input?.command ?? "").length;
		} else if (obj?.type === "user" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) if (b?.type === "tool_result" && typeof b.tool_use_id === "string") { const k = idOf(b.tool_use_id); if (k in out) out[k] += resultText(b.content).length; }
		}
	}
	return out;
}

/** Model calls in a session, for the per-call context estimate: distinct Claude message ids, or Codex token_count steps. */
function calls(client, lines) {
	const ids = new Set();
	let n = 0, last = -1;
	for (const { obj } of lines) {
		if (client === "codex") { const t = obj?.type === "event_msg" && obj.payload?.type === "token_count" ? obj.payload.info?.total_token_usage?.input_tokens : undefined; if (Number.isFinite(t) && t !== last) { n++; last = t; } }
		else if (obj?.type === "assistant" && obj.message?.usage && !obj.isSidechain && typeof obj.message.id === "string") ids.add(obj.message.id);
	}
	return client === "codex" ? n : ids.size;
}

function sessionInfo(client, lines, file) {
	if (client === "codex") {
		const m = lines.find((l) => l.obj?.type === "session_meta")?.obj?.payload;
		return { session: m?.id ?? path.basename(file, ".jsonl"), cwd: typeof m?.cwd === "string" ? m.cwd : null };
	}
	const l = lines.find((x) => typeof x.obj?.cwd === "string");
	return { session: l?.obj?.sessionId ?? path.basename(file, ".jsonl"), cwd: l?.obj?.cwd ?? null };
}

function scan(roots, cacheDir, maxFiles) {
	fs.mkdirSync(cacheDir, { recursive: true });
	const files = transcripts(roots).slice(0, maxFiles ?? Infinity), pairAt = pairResolver();
	const stats = { files: files.length, read: 0, cached: 0, failed: 0, with_commands: 0 };
	const sessions = new Map();
	for (const [i, { client, file }] of files.entries()) {
		const st = fs.statSync(file), key = sha(`${file}\n${st.size}\n${st.mtimeMs}`).slice(0, 24), cf = path.join(cacheDir, `${key}.json`);
		let rec = null;
		if (fs.existsSync(cf)) { rec = JSON.parse(fs.readFileSync(cf, "utf8")); stats.cached++; }
		else {
			try {
				const { lines } = readLines(file, 0);
				const { session, cwd } = sessionInfo(client, lines, file);
				const digest = commandDigest(client, lines, { session, cwd, pairAt });
				rec = digest ? { ref: digest.session, digest, costs: costs(client, lines), usage: usageOf(client, lines)?.total ?? null, calls: calls(client, lines) } : { ref: null };
				stats.read++;
			} catch { rec = { ref: null }; stats.failed++; }
			fs.writeFileSync(cf, JSON.stringify(rec), { mode: 0o600 });
		}
		if (i % 200 === 0) process.stderr.write(`scan ${i}/${files.length}\n`);
		if (!rec.ref || !rec.digest?.commands?.length) continue;
		stats.with_commands++;
		const prev = sessions.get(rec.ref);
		sessions.set(rec.ref, prev ? { ...prev, digest: mergeDigest(prev.digest, rec.digest), costs: { ...prev.costs, ...rec.costs }, calls: prev.calls + rec.calls } : rec);
	}
	return { sessions: [...sessions.values()], stats };
}

// ---------- phase 2: detection per (session, repo), threshold independent ----------

const endedAt = (slice) => slice.commands.map((c) => c.at).filter(Boolean).sort().at(-1) ?? slice.ended_at ?? "";

/**
 * Per repo-session: observations against every fact seen anywhere earlier (a superset of what the device would know; the replay filters
 * to the repo's own known set), labels, files, failed commands with their context cost.
 */
function detectAll(sessions) {
	const items = [];
	for (const s of sessions) {
		const byKey = new Map();
		for (const [id, p] of Object.entries(s.digest.pairs ?? {})) if (p?.key) (byKey.get(p.key) ?? byKey.set(p.key, []).get(p.key)).push(id);
		for (const [key, ids] of byKey) {
			const slice = sliceDigest(s.digest, ids, key);
			if (!slice.commands.length) continue;
			const perCall = s.usage && s.calls ? s.usage.input / s.calls : 0;
			items.push({ ref: s.ref, key, at: endedAt(slice), slice, perCall, calls: s.calls ?? 0, cost: s.costs, unattributed: s.digest.other?.length ?? 0 });
		}
	}
	items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.ref < b.ref ? -1 : 1));
	const known = new Map(); // fact_key -> { detector, literal }
	items.forEach((it, seq) => {
		it.seq = seq + 1;
		it.order = `${it.at}/${String(seq + 1).padStart(10, "0")}/${DEVICE}`;
		const r = detect(it.slice, { known: [...known.values()] });
		it.obs = r.observations.map(({ fact_key, kind, detector, literal, label }) => ({ fact_key, kind, detector, literal, label }));
		it.labels = r.labels;
		it.files = Array.isArray(it.slice.files) ? it.slice.files : null;
		it.failed = it.slice.commands.filter((c) => c.status === "failed");
		it.total = it.slice.commands.length + (it.slice.dropped ?? 0);
		for (const o of it.obs) if (o.kind === "confirm" && !known.has(o.fact_key)) known.set(o.fact_key, { detector: o.detector, literal: o.literal });
	});
	return { items, facts: known };
}

// ---------- phase 3: the lifecycle mirror ----------

const byOrder = (a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
const disjoint = (a, b) => { const s = new Set(a); return !b.some((h) => s.has(h)); };
const pushOrdered = (list, item, max) => [...list, item].sort(byOrder).slice(-max);

function activationOrder(lane, cls, P) {
	const c = [...lane.confirmations].sort(byOrder);
	if (cls === "environment" || !P.disjoint) {
		const seen = new Set();
		for (const x of c) { seen.add(x.session); if (seen.size >= P.activate) return x.order; }
		return null;
	}
	// The repo rule with P.activate confirmations (pairwise-disjoint known files); 3 is the server's triple check.
	let best = null;
	const pick = (start, chosen) => {
		if (chosen.length === P.activate) { const o = chosen.at(-1).order; if (best === null || o < best) best = o; return; }
		for (let i = start; i < c.length; i++) {
			const x = c[i];
			if (!x.files || chosen.some((y) => y.session === x.session || !disjoint(y.files, x.files))) continue;
			pick(i + 1, [...chosen, x]);
		}
	};
	pick(0, []);
	return best;
}

function recompute(lane, rec, P) {
	const n = P.retire, tail = lane.events.slice(-n);
	if (tail.length === n && tail.every((e) => e.kind === "contradict")) { lane.state = "retired"; return; }
	lane.activated ??= activationOrder(lane, rec.class, P) ?? undefined;
	if (lane.activated === undefined) delete lane.activated;
	lane.state = lane.activated ? "active" : "candidate";
}

const rate = (l) => (l.exercised ? (l.fired + l.prevented) / l.exercised : 0);
const injectable = (lane, P) => !!lane && lane.state === "active" && (!P.gate || (lane.exercised >= 4 && (lane.fired + lane.prevented) * 5 >= lane.exercised * 2));
const laneKeyOf = (rec) => (rec.class === "repo" ? SHARED : DEVICE);
const dormant = (rec) => Object.values(rec.lanes).length > 0 && Object.values(rec.lanes).every((l) => l.state === "retired");

/**
 * Replays every repo-session in order under one parameter set P = { activate, disjoint, retire, gate }. Returns per repo and per fact
 * what happened: activation, retirement, injections, prevented and harmful injections.
 */
function replay({ items }, P, outcomeCache) {
	const repos = new Map(); // key -> { nodes: Map(fact_key -> rec), known: Set, sessions, ... }
	const repo = (key) => repos.get(key) ?? repos.set(key, { key, nodes: new Map(), known: new Set(), sessions: 0, commands: 0, failed: 0, unattributed: 0, injections: 0, carry: 0, hit: { failed: 0, chars: 0, ctx: 0 }, harm: 0, prevented_outcomes: 0 }).get(key);
	const outcomeOf = (it, f) => {
		const k = `${it.seq}\n${f.fact_key}`;
		if (!outcomeCache.has(k)) outcomeCache.set(k, outcomes(it.slice, [{ fact_key: f.fact_key, detector: f.detector, literal: f.literal }])[0]?.outcome ?? "unexercised");
		return outcomeCache.get(k);
	};
	const matches = (c, f) => outcomes({ commands: [c] }, [f])[0]?.outcome === "fired";
	const fresh = (key, f) => { const label = describe(f.detector, f.literal).label; return { repo_key: key, fact_key: f.fact_key, detector: f.detector, literal: f.literal, class: CLASS[f.detector], label, family: familyHash(key, label), lanes: {}, log: {} }; };
	const newLane = () => ({ state: "candidate", confirmations: [], events: [], exercised: 0, fired: 0, prevented: 0 });

	for (const it of items) {
		const R = repo(it.key);
		R.sessions++; R.commands += it.total; R.failed += it.failed.length; R.unattributed += it.unattributed;
		const n = R.sessions;
		// Session start: the injection read (repo tier, then user tier), at most 4.
		const picks = [];
		for (const rec of R.nodes.values()) { const lane = rec.lanes[laneKeyOf(rec)]; if (injectable(lane, P)) picks.push({ rec, lane, tier: "repo" }); }
		const taken = new Set(picks.map((p) => p.rec.fact_key)), best = new Map(), active = new Map();
		for (const other of repos.values()) for (const rec of other.nodes.values()) if (rec.lanes[laneKeyOf(rec)]?.state === "active") (active.get(rec.fact_key) ?? active.set(rec.fact_key, new Set()).get(rec.fact_key)).add(other.key);
		for (const other of repos.values()) {
			if (other.key === it.key) continue;
			for (const rec of other.nodes.values()) {
				const lane = rec.lanes[laneKeyOf(rec)];
				if (taken.has(rec.fact_key) || !injectable(lane, P) || (active.get(rec.fact_key)?.size ?? 0) < 2) continue;
				if (R.nodes.get(rec.fact_key)?.lanes[laneKeyOf(rec)]?.state === "retired") continue;
				const prev = best.get(rec.fact_key);
				if (!prev || rate(lane) > rate(prev.lane)) best.set(rec.fact_key, { rec, lane, tier: "user" });
			}
		}
		picks.push(...best.values());
		const injected = picks.sort((x, y) => (x.tier === y.tier ? 0 : x.tier === "repo" ? -1 : 1) || rate(y.lane) - rate(x.lane) || (x.rec.fact_key < y.rec.fact_key ? -1 : 1)).slice(0, LIMITS.inject).map((p) => p.rec);
		for (const f of injected) R.known.add(f.fact_key);

		// What the injected facts would have changed: failed commands matching an injected fact are the waste it targets; an injected
		// fact contradicted in this session was wrong advice.
		const out = new Map();
		for (const f of injected) {
			R.injections++;
			// The fact's line stays in context for every model call of the session.
			R.carry += Math.ceil((describe(f.detector, f.literal).statement.length + 2) / 4) * Math.max(1, it.calls);
			const o = outcomeOf(it, f);
			out.set(f.fact_key, o);
			const hits = it.failed.filter((c) => matches(c, f));
			const { log } = R.nodes.get(f.fact_key) ?? f;
			log.hits = (log.hits ?? 0) + hits.length;
			for (const c of hits) { R.hit.failed++; R.hit.chars += it.cost[c.id] ?? (c.cmd?.length ?? 0); R.hit.ctx += it.perCall; }
			if (it.obs.some((x) => x.fact_key === f.fact_key && x.kind === "contradict")) { R.harm++; log.harm = (log.harm ?? 0) + 1; }
			if (o === "prevented") R.prevented_outcomes++;
		}

		// The report. Observations: the device reports contradictions only for facts it knows (its registry and injected facts).
		const obs = it.obs.filter((o) => o.kind === "confirm" || R.known.has(o.fact_key));
		const wanted = new Set([...obs.map((o) => o.label), ...injected.map((f) => f.label)].map((l) => familyHash(it.key, l)));
		const fams = new Set([...new Set(it.labels.map((l) => familyHash(it.key, l)))].sort((a, b) => (wanted.has(b) - wanted.has(a)) || (a < b ? -1 : 1)).slice(0, LIMITS.families));
		const touched = new Set();
		const live = () => [...R.nodes.values()].filter((r) => !dormant(r)).length;
		for (const o of obs) {
			let rec = R.nodes.get(o.fact_key);
			if (!rec) {
				const source = [...repos.values()].find((x) => x.key !== it.key && x.nodes.has(o.fact_key))?.nodes.get(o.fact_key);
				if (!source && o.kind !== "confirm") continue;
				if (live() >= LIMITS.live) continue;
				rec = fresh(it.key, o);
				rec.log.first = n;
				R.nodes.set(o.fact_key, rec);
			}
			const lane = rec.lanes[laneKeyOf(rec)] ??= newLane();
			lane.events = pushOrdered(lane.events, { order: it.order, session: it.ref, kind: o.kind, n }, LIMITS.events);
			if (o.kind === "confirm") { lane.confirmations = pushOrdered(lane.confirmations, { session: it.ref, order: it.order, files: it.files, n }, LIMITS.confirmations); rec.log.confirms = (rec.log.confirms ?? 0) + 1; }
			else rec.log.contradicts = [...(rec.log.contradicts ?? []), n];
			touched.add(rec);
			R.known.add(o.fact_key);
		}
		for (const [k, o] of out) if (o !== "unexercised" && !R.nodes.has(k)) {
			const source = injected.find((f) => f.fact_key === k);
			if (live() < LIMITS.live) { const rec = fresh(it.key, source); rec.log.first = n; rec.lanes[laneKeyOf(rec)] = newLane(); R.nodes.set(k, rec); touched.add(rec); }
		}
		const confirmed = new Set(obs.filter((o) => o.kind === "confirm").map((o) => o.fact_key)), observed = new Set(obs.map((o) => o.fact_key));
		for (const rec of R.nodes.values()) {
			const o = out.get(rec.fact_key);
			if (!(fams.has(rec.family) || observed.has(rec.fact_key) || o === "fired" || o === "prevented")) continue;
			const lane = rec.lanes[laneKeyOf(rec)];
			if (!lane) continue;
			touched.add(rec);
			lane.exercised++;
			if (confirmed.has(rec.fact_key) || o === "fired") lane.fired++;
			else if (o === "prevented") lane.prevented++;
		}
		for (const rec of touched) {
			const lane = rec.lanes[laneKeyOf(rec)], was = lane.state;
			recompute(lane, rec, P);
			if (lane.state === "active" && rec.log.activated === undefined) rec.log.activated = n;
			if (was === "active" && lane.state === "retired") rec.log.retired = [...(rec.log.retired ?? []), n];
		}
	}
	return repos;
}

// ---------- report ----------

const tok = (chars) => Math.round(chars / 4);
const fmt = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : String(Math.round(x)));

function summary(repos) {
	const t = { repos: repos.size, sessions: 0, commands: 0, failed: 0, candidates: 0, activated: 0, injectable_end: 0, false_act: 0, retired_after: 0, injections: 0, carry: 0, hit_failed: 0, hit_chars: 0, hit_ctx: 0, harm: 0 };
	for (const R of repos.values()) {
		t.sessions += R.sessions; t.commands += R.commands; t.failed += R.failed; t.injections += R.injections; t.carry += R.carry; t.harm += R.harm;
		t.hit_failed += R.hit.failed; t.hit_chars += R.hit.chars; t.hit_ctx += R.hit.ctx;
		for (const rec of R.nodes.values()) {
			if (rec.log.confirms) t.candidates++;
			if (rec.log.activated !== undefined) {
				t.activated++;
				if ((rec.log.contradicts ?? []).some((x) => x > rec.log.activated)) t.false_act++;
				if (rec.log.retired) t.retired_after++;
			}
			if (rec.lanes[laneKeyOf(rec)]?.state === "active") t.injectable_end++;
		}
	}
	return t;
}

function main() {
	const a = args(process.argv.slice(2));
	if (!a.cache || !a.out) { process.stderr.write("usage: facts-replay --cache <dir> --out <report.md> [--json <file>] [--roots a,b] [--max-files N]\n"); return 2; }
	const H = os.homedir();
	const roots = typeof a.roots === "string" ? a.roots.split(",") : [path.join(H, ".plaude", "projects"), path.join(H, ".claude", "projects"), path.join(H, ".codex", "sessions")];
	const t0 = Date.now();
	const { sessions, stats } = scan(roots, a.cache, a["max-files"] ? Number(a["max-files"]) : undefined);
	const data = detectAll(sessions);
	const cache = new Map();
	const BASE = { activate: 3, disjoint: true, retire: 2, gate: false };
	const DETAIL = typeof a.detail === "string" ? { ...BASE, ...JSON.parse(a.detail) } : BASE, label = DETAIL === BASE ? "baseline" : `detail ${a.detail}`;
	const base = replay(data, DETAIL, cache);
	const runs = [
		["baseline (current: 3, disjoint on, retire 2, no gate)", BASE],
		["activate 2", { ...BASE, activate: 2 }], ["activate 4", { ...BASE, activate: 4 }],
		["disjoint off (repo facts count sessions)", { ...BASE, disjoint: false }],
		["retire 1", { ...BASE, retire: 1 }], ["retire 3", { ...BASE, retire: 3 }],
		["firing gate on deterministic facts (learned proxy)", { ...BASE, gate: true }],
		["activate 2, retire 1", { ...BASE, activate: 2, retire: 1 }],
		["activate 2, disjoint off", { ...BASE, activate: 2, disjoint: false }],
	].map(([name, P]) => [name, P, summary(P === DETAIL ? base : replay(data, P, cache))]);

	// Per-repo table at baseline, top 10 by sessions.
	const top = [...base.values()].sort((x, y) => y.sessions - x.sessions).slice(0, 10);
	const L = [];
	L.push("# Repo facts replay (#120)", "", `Read-only replay of local Claude Code and Codex history through the v2 detectors and a mirror of the section 6 lifecycle. ${stats.files} transcripts, ${sessions.length} sessions with commands, ${data.items.length} repo-sessions in ${base.size} GitHub repos, ${data.facts.size} distinct candidate facts. Built in ${Math.round((Date.now() - t0) / 1000)} s.`, "");
	L.push("Waste = failed commands in a session where the fact was injected (top 4, after activation) whose failure matches the fact (detector `outcomes` = fired). Direct tokens = (command + raw output chars)/4. Turn tokens = the session's mean input tokens per model call, one call per failure (mostly cached). Carry tokens = each injected line's tokens times the session's model calls (the cost of injecting, also mostly cached).", "");
	L.push(`## Top 10 repos (${label})`, "", "| repo | sessions | failed cmds | candidates | activated (session #) | injectable at end | waste hit | direct tok | turn tok |", "|---|---|---|---|---|---|---|---|---|");
	for (const R of top) {
		const recs = [...R.nodes.values()];
		const act = recs.filter((r) => r.log.activated !== undefined).sort((x, y) => x.log.activated - y.log.activated);
		L.push(`| ${R.key} | ${R.sessions} | ${R.failed} | ${recs.filter((r) => r.log.confirms).length} | ${act.length ? act.map((r) => `#${r.log.activated}`).join(", ") : "0"} | ${recs.filter((r) => r.lanes[laneKeyOf(r)]?.state === "active").length} | ${R.hit.failed} | ${fmt(tok(R.hit.chars))} | ${fmt(R.hit.ctx)} |`);
	}
	L.push("", `## Activated facts (${label}, all repos)`, "", "| repo | detector | literal | confirms | activated # | contradicted at # | waste hits | wrong-advice sessions |", "|---|---|---|---|---|---|---|---|");
	for (const R of [...base.values()].sort((x, y) => y.sessions - x.sessions)) for (const r of R.nodes.values()) if (r.log.activated !== undefined)
		L.push(`| ${R.key} | ${r.detector} | \`${r.literal}\` | ${r.log.confirms ?? 0} | ${r.log.activated} | ${(r.log.contradicts ?? []).join(", ") || "-"} | ${r.log.hits ?? 0} | ${r.log.harm ?? 0} |`);
	const det = {};
	for (const R of base.values()) for (const r of R.nodes.values()) { const d = (det[r.detector] ??= { candidates: 0, activated: 0 }); if (r.log.confirms) d.candidates++; if (r.log.activated !== undefined) d.activated++; }
	L.push("", `## Candidates by detector (${label})`, "", "| detector | candidates | activated |", "|---|---|---|", ...Object.entries(det).map(([d, v]) => `| ${d} | ${v.candidates} | ${v.activated} |`));
	const tb = summary(base);
	L.push("", `## Totals (${label})`, "", `Sessions ${tb.sessions}, commands ${tb.commands}, failed ${tb.failed}. Candidates ${tb.candidates}, activated ${tb.activated}, active at end ${tb.injectable_end}. Injections ${tb.injections}. Waste hit ${tb.hit_failed} failures, ${fmt(tok(tb.hit_chars))} direct tokens, ${fmt(tb.hit_ctx)} turn tokens. Wrong-advice injections ${tb.harm}.`);
	L.push("", "## Threshold sweep", "", "| run | activated | false (contradicted after activation) | retired after activation | injections | carry tok | waste hit | direct tok | turn tok | wrong-advice injections |", "|---|---|---|---|---|---|---|---|---|---|");
	for (const [name, , s] of runs) L.push(`| ${name} | ${s.activated} | ${s.false_act} | ${s.retired_after} | ${s.injections} | ${fmt(s.carry)} | ${s.hit_failed} | ${fmt(tok(s.hit_chars))} | ${fmt(s.hit_ctx)} | ${s.harm} |`);
	L.push("", `Scan: ${stats.read} read, ${stats.cached} from cache, ${stats.failed} unreadable. Unattributed commands (no GitHub checkout): ${[...base.values()].reduce((n, R) => n + R.unattributed, 0)} counted on attributed sessions only.`);
	fs.writeFileSync(a.out, `${L.join("\n")}\n`, { mode: 0o600 });
	if (typeof a.json === "string") fs.writeFileSync(a.json, JSON.stringify({ stats, runs: runs.map(([name, P, s]) => ({ name, P, s })) }, null, 1), { mode: 0o600 });
	process.stdout.write(`${JSON.stringify({ stats, repo_sessions: data.items.length, repos: base.size, candidates: data.facts.size, baseline: tb })}\n`);
	return 0;
}

process.exitCode = main();
