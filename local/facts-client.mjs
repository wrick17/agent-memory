// Repo facts v2, the device side of docs/repo-facts-v2-contract.md (sections 1, 2 and 8). Per session on this device it keeps the
// command digest as the transcript grows, with every command attributed to the (remote, path) pair of its own directory. When the
// session has ended it gives the session its order, groups its pairs into partitions (routed profile, repo key), builds one v2 report
// per partition, saves its exact bytes before sending, and settles the reply. Only the run-lock holder calls observeSession and
// flushPending; the SessionStart hook (facts-inject.mjs) writes only routes/, dirs/, p/<id>/meta.json, p/<id>/seen/ and inject/.
//
// Files under <home>/facts/, all private:
//   device.json                          { seq }: the per-device session counter (contract order.seq)
//   routes/<pair>.json                   a (remote, path) pair's routed profile, learned from fact-route replies
//   sessions/<client>-<session>.json     v2: { v: 2, ref, cwd, origin, read_to, digest, usage, order, built, reports }; v1 files until migrated
//   p/<partition>/meta.json              { profile, repo_key, remote, path }
//   p/<partition>/registry.json          { facts: { <fact_key>: { detector, literal } } }: facts reported or proposed here
//   p/<partition>/seen/<session>.json    what the session-start read gave this partition, per session
//   p/<partition>/digests/<session>.json the newest 16 settled session digests, for synthesis
//   p/<partition>/queue/<session>.json   the session's report: { bytes, status, ... }
//   unrouted/<session>-<pair>.json       a report whose pair has no known route yet; it moves to its partition on the reply
//   stats/unattributed-<day>.json        commands no pair could be established for, per UTC day
//   dirs/<cwd hash>.json                 a working directory's resolved pair, so SessionStart runs no git for a known directory

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { home, readJson, readLines, safeName, safeRemote, statePath, writePrivate } from "./agent-memory.mjs";
import { commandDigest, factsPath, machineId, rememberDir, mergeDigest, pairResolver, partitionDir, partitionId, refName, rememberRoute, routedProfile, routeFile, sessionRef, sliceDigest, usageOf } from "./facts.mjs";
import { DETECT_LIMITS, commandCounts as countCommands, describe, detect, factKey, familyHash, outcomes } from "./facts-detect.mjs";

/** Settled digests kept per partition for synthesis. */
export const RETAINED_DIGESTS = 16;
/** Contract limits on one session report. */
const REPORT = Object.freeze({ bytes: 64_000, families: 32, files: 32, injected: 16, observations: 32, usage: 1e10, seq: 2 ** 31 - 1 });
const SEEN_KEPT = 32, SETTLED_DAYS = 14, INJECT_LOG_DAYS = 8;

const F = (...p) => factsPath(home(), ...p);
const P = (part, ...p) => partitionDir(home(), part, ...p);
const sessionFile = (client, session) => F("sessions", `${client}-${safeName(session)}.json`);
const listJson = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).sort() : []);
const day = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Deprecated: the contract routes fact reports by remote and path only, so config.facts.profile is no longer read. Always null. */
export const factsProfile = () => null;

// ---------- partitions ----------

/** Every partition this device knows: { id, profile, repo_key, remote, path } from its meta.json. */
export function partitions() {
	const d = F("p");
	return (fs.existsSync(d) ? fs.readdirSync(d).sort() : []).map((id) => ({ id, ...readJson(P(id, "meta.json"), null) })).filter((m) => m.profile && m.repo_key);
}

/** A partition's fact route, as proposals send it (contract section 5): the last pair that routed there. Null for an unknown partition. */
export function partitionRoute(part) {
	const m = readJson(P(part, "meta.json"), null);
	return m?.repo_key && m.remote ? { repo: { remote: m.remote, ...(m.path ? { path: m.path } : {}) }, repo_key: m.repo_key } : null;
}

/** The v1 per-repo store id (registry/<id>.json, seen/<id>.json), read once when a partition is first used. */
const v1Id = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** Creates a partition's files once; the v1 registry and injection cache of its repo key move in when their profile matches. */
function ensurePartition(part, profile, key, pair) {
	if (!fs.existsSync(P(part, "meta.json"))) writePrivate(P(part, "meta.json"), JSON.stringify({ profile, repo_key: key, remote: pair?.remote ?? null, path: pair?.path ?? null, at: new Date().toISOString() }));
	if (fs.existsSync(P(part, "registry.json"))) return;
	const facts = {}, old = readJson(F("registry", `${v1Id(key)}.json`), null), seen = readJson(F("seen", `${v1Id(key)}.json`), null);
	if (old?.facts && (old.profile === profile || old.profile == null)) for (const [k, f] of Object.entries(old.facts)) if (f?.detector && f?.literal) facts[k] = { detector: f.detector, literal: f.literal };
	for (const f of seen?.facts ?? []) if (f?.detector && f?.literal) facts[factKey(f.detector, f.literal)] = { detector: f.detector, literal: f.literal };
	writePrivate(P(part, "registry.json"), JSON.stringify({ facts }));
}

/**
 * A registry entry merged into an existing one: detector and literal from the newer, a learned fact's signature and class kept from
 * whichever has them, and the (remote, path) pairs whose reports carried it united (route provenance, for moveRoute).
 */
function mergeFact(old, f, pairs = []) {
	const signature = old?.signature ?? f.signature, cls = old?.class ?? f.class, all = [...new Set([...(old?.pairs ?? []), ...(f.pairs ?? []), ...pairs])].sort();
	return { detector: f.detector, literal: f.literal, ...(signature ? { signature } : {}), ...(cls ? { class: cls } : {}), ...(all.length ? { pairs: all } : {}) };
}

/**
 * Moves one (remote, path) pair's evidence from the partition it used to route to into its new one (a routing rule changed its profile):
 * registry facts it carried, its session-start items and its commands in retained digests. Evidence of the partition's other pairs,
 * and facts without provenance (v1 imports, synthesis proposals), stay where they are.
 */
function moveRoute(pid, from, to, route) {
	if (from === to || !fs.existsSync(P(from))) return;
	ensurePartition(to, route.profile, route.repo_key, { remote: route.remote, path: route.path });
	const src = readJson(P(from, "registry.json"), { facts: {} }), dst = readJson(P(to, "registry.json"), { facts: {} });
	for (const [k, f] of Object.entries(src.facts ?? {})) {
		if (!f?.pairs?.includes(pid)) continue;
		dst.facts[k] = mergeFact(dst.facts[k], { ...f, pairs: [pid] });
		f.pairs = f.pairs.filter((x) => x !== pid);
		if (!f.pairs.length) delete src.facts[k];
	}
	writePrivate(P(from, "registry.json"), JSON.stringify(src));
	writePrivate(P(to, "registry.json"), JSON.stringify(dst));
	for (const f of listJson(P(from, "seen"))) if (readJson(P(from, "seen", f), {})?.pair === pid) { fs.mkdirSync(P(to, "seen"), { recursive: true }); fs.renameSync(P(from, "seen", f), P(to, "seen", f)); }
	for (const f of listJson(P(from, "digests"))) {
		const d = readJson(P(from, "digests", f), null), cmds = Array.isArray(d?.commands) ? d.commands : [], mine = cmds.filter((c) => c.pair === pid);
		if (!mine.length) continue;
		writePrivate(P(to, "digests", f), JSON.stringify({ ...d, commands: mine }));
		if (mine.length === cmds.length) fs.rmSync(P(from, "digests", f), { force: true });
		else writePrivate(P(from, "digests", f), JSON.stringify({ ...d, commands: cmds.filter((c) => c.pair !== pid) }));
	}
}

/** Applies a pending route move (rememberRoute's moved_from, written by the run or by SessionStart), once. */
function applyRouteMove(pid) {
	const route = readJson(routeFile(home(), pid), null), profile = routedProfile(route?.profile);
	if (!route?.moved_from || !profile || !route.repo_key) return;
	moveRoute(pid, route.moved_from, partitionId(profile, route.repo_key), route);
	delete route.moved_from;
	writePrivate(routeFile(home(), pid), JSON.stringify(route));
}

/** Facts this device knows in a partition: its reported and accepted proposed facts, and what recent session-start reads gave it. */
export function known(part) {
	const out = new Map();
	for (const [k, f] of Object.entries(readJson(P(part, "registry.json"), {})?.facts ?? {})) if (f?.detector && f?.literal) out.set(k, { detector: f.detector, literal: f.literal, ...(f.signature ? { signature: f.signature, class: f.class } : {}) });
	for (const s of listJson(P(part, "seen")).slice(-8)) for (const f of readJson(P(part, "seen", s), {})?.items ?? []) {
		if (f?.kind === "fact" && f.detector && f.literal) out.set(f.fact_key, { detector: f.detector, literal: f.literal, ...(f.signature ? { signature: f.signature } : {}) });
	}
	return [...out.values()];
}

/**
 * Records facts the server accepted from a synthesis proposal, so later sessions in the partition can confirm them with their own evidence.
 * A learned fact keeps its signature and class, which its detector matches with plain `includes` (contract section 5).
 * @param {string} part partition id @param {{ detector: string, literal: string, signature?: object, class?: string }[]} facts accepted proposals
 */
export function rememberProposals(part, facts) {
	if (!fs.existsSync(P(part, "meta.json"))) return;
	const reg = readJson(P(part, "registry.json"), { facts: {} });
	for (const f of Array.isArray(facts) ? facts : []) {
		if (typeof f?.detector !== "string" || typeof f?.literal !== "string") continue;
		const k = factKey(f.detector, f.literal);
		reg.facts[k] = mergeFact(reg.facts[k], { detector: f.detector, literal: f.literal, ...(f.signature && typeof f.signature === "object" ? { signature: f.signature, ...(typeof f.class === "string" ? { class: f.class } : {}) } : {}) });
	}
	writePrivate(P(part, "registry.json"), JSON.stringify(reg));
}

/** The newest settled, redacted digests of a partition, newest first, for synthesis. Never a transcript. */
export function recentDigests(part, limit = 8) {
	return listJson(P(part, "digests")).map((f) => readJson(P(part, "digests", f), null)).filter((x) => x?.session && Array.isArray(x.commands))
		.sort((a, b) => (a.ended_at < b.ended_at ? 1 : a.ended_at > b.ended_at ? -1 : 0)).slice(0, limit);
}

function retain(part, digest) {
	writePrivate(P(part, "digests", `${refName(digest.session)}.json`), JSON.stringify(digest));
	const files = listJson(P(part, "digests")).map((f) => ({ f, at: readJson(P(part, "digests", f), {})?.ended_at ?? "" })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	for (const { f } of files.slice(RETAINED_DIGESTS)) fs.rmSync(P(part, "digests", f), { force: true });
}

// ---------- the report ----------

/** A fact's family label from its detector and literal (facts-detect describe), or null for one it cannot describe. */
const labelOf = (f) => { try { return describe(f.detector, f.literal, f.signature)?.label ?? null; } catch { return null; } };

/**
 * What happened to each item the session-start read gave this partition (contract section 2). A fact with its detector and literal gets
 * facts-detect's outcome (fired, prevented or unexercised); one known by key only is fired when this session confirmed it, else
 * unexercised. Briefing memories have no detector, so they are unexercised. Input order is kept, at most 16.
 */
export function injectedOutcomes(slice, items, observations) {
	const confirmed = new Set(observations.filter((o) => o.kind === "confirm").map((o) => o.fact_key)), out = [];
	for (const it of Array.isArray(items) ? items : []) {
		if (it?.kind === "memory") out.push({ kind: "memory", memory_id: it.memory_id, outcome: "unexercised" });
		else if (it?.kind === "fact") {
			const [o] = it.detector && it.literal ? outcomes(slice, [it]) : [];
			out.push(o ? { ...o, fact_key: it.fact_key ?? o.fact_key } : { kind: "fact", fact_key: it.fact_key, outcome: confirmed.has(it.fact_key) ? "fired" : "unexercised" });
		}
	}
	return out.slice(0, REPORT.injected);
}

/** A slice's command counts (facts-detect commandCounts), with the commands the digest bound left out added to the total. */
export const commandCounts = (slice) => { const c = countCommands(slice); return { ...c, total: c.total + (slice.dropped ?? 0) }; };

const clampUsage = (u) => Object.fromEntries(["input", "cached_input", "output", "cache_write"].map((k) => [k, Math.min(REPORT.usage, Math.max(0, Math.floor(u?.[k] ?? 0)))]));

/**
 * The v2 report body for one partition of a completed session, pure: the same inputs always give the same bytes (contract section 2).
 * Families: the session's trigger labels in this partition, observed and injected facts' labels first, at most 32. files: omitted when
 * unknown or over 32. usage only for the partition where the session started.
 * @param {object} slice sliceDigest output @param {string} key repo key
 * machine: this machine's id (facts.mjs machineId), so the server keys the per-device lanes by machine.
 * @param {{ remote: string, path: string, order: { ended_at: string, seq: number }, machine?: string, known?: object[], injected?: object[], usage?: object | null, commands?: object }} o
 */
export function reportBody(slice, key, { remote, path: dirPath, order, machine = null, known: facts = [], injected = [], usage = null, commands = commandCounts(slice) }) {
	const { observations, labels } = detect(slice, { known: facts });
	const obs = observations.slice(0, REPORT.observations).map(({ fact_key, kind, detector, literal }) => ({ fact_key, kind, detector, literal }));
	const injectedOut = injectedOutcomes(slice, injected, observations);
	const wanted = new Set([...observations.map((o) => o.label), ...injected.filter((i) => i?.detector && i?.literal).map(labelOf)].filter(Boolean).map((l) => familyHash(key, l)));
	const fams = [...new Set(labels.map((l) => familyHash(key, l)))].sort((a, b) => (wanted.has(b) - wanted.has(a)) || (a < b ? -1 : 1)).slice(0, Math.min(REPORT.families, DETECT_LIMITS.max)).sort();
	// repo.path is bounded at 1024 characters by the server; a longer checkout path is left out (path is optional on the wire).
	return { repo: { remote, ...(typeof dirPath === "string" && dirPath.length <= 1024 ? { path: dirPath } : {}) }, repo_key: key, facts: { v: 2, ...(machine ? { machine } : {}), session: slice.session, order, families: fams, ...(Array.isArray(slice.files) && slice.files.length <= REPORT.files ? { files: slice.files } : {}),
		observations: obs, injected: injectedOut, ...(usage ? { usage: clampUsage(usage) } : {}), commands } };
}

/**
 * Each observation's provenance: the pairs (checkouts) whose own commands produce it, so a later reroute of one path moves only its own
 * facts. When no single pair produces it alone (evidence spread across checkouts), the pairs whose commands ran its trigger; else all.
 */
function provenanceOf(slice, gids, facts, observations) {
	if (gids.length < 2) return Object.fromEntries(observations.map((o) => [o.fact_key, gids]));
	const per = gids.map((id) => [id, detect({ ...slice, commands: slice.commands.filter((c) => c.pair === id) }, { known: facts })]);
	return Object.fromEntries(observations.map((o) => {
		let ids = per.filter(([, r]) => r.observations.some((x) => x.fact_key === o.fact_key)).map(([id]) => id);
		const label = ids.length ? null : labelOf(facts.find((f) => factKey(f.detector, f.literal) === o.fact_key) ?? o);
		if (label) ids = per.filter(([, r]) => r.labels.includes(label)).map(([id]) => id);
		return [o.fact_key, ids.length ? ids : gids];
	}));
}

/** The session order (contract section 2): its last command time, else its last line, else now; never in the future. */
function endedAt(digest) {
	const ats = (digest?.commands ?? []).map((c) => c.at).filter((a) => typeof a === "string" && !Number.isNaN(Date.parse(a))).sort((a, b) => Date.parse(a) - Date.parse(b));
	const t = Date.parse(ats.at(-1) ?? digest?.ended_at ?? "") || Date.now();
	return new Date(Math.min(t, Date.now())).toISOString();
}
/** The next per-device session counter, persisted before the session's reports are built. */
function nextSeq() {
	const seq = Math.min(REPORT.seq, (Number.isInteger(readJson(F("device.json"), {})?.seq) ? readJson(F("device.json"), {}).seq : 0) + 1);
	writePrivate(F("device.json"), JSON.stringify({ seq }));
	return seq;
}

function countUnattributed(n) {
	if (!(n > 0)) return;
	const f = F("stats", `unattributed-${day()}.json`);
	writePrivate(f, JSON.stringify({ count: (readJson(f, {})?.count ?? 0) + n }));
}

/** The cached profile of a pair, or one injection read (mode inject) to learn it (contract section 1). Null when it cannot be learned. */
async function routeOf(pid, pair, read) {
	const cached = routedProfile(readJson(routeFile(home(), pid), null)?.profile);
	if (cached || !read?.facts) return cached;
	try {
		const reply = await read.facts({ repo: { remote: pair.remote, path: pair.path }, repo_key: pair.key, machine: machineId(home()), mode: "inject" }, { timeoutMs: 10_000 });
		return rememberRoute(home(), { id: pid, ...pair }, reply) ? routedProfile(reply.profile) : null;
	} catch { return null; }
}

/**
 * Builds the session's reports: its pairs grouped by (routed profile, repo key); a pair whose route cannot be learned gets a report of
 * its own (unrouted) and learns its partition from the reply. The partition the session started in always gets a report (usage).
 * Returns the queue files written.
 */
async function build(state, read) {
	const d = state.digest ?? { client: state.client, session: state.ref, pairs: {}, files: {}, commands: [], dropped: {} };
	const pairs = { ...d.pairs, ...(state.origin && state.origin_pair ? { [state.origin]: state.origin_pair } : {}) };
	const ids = [...new Set([...(state.origin ? [state.origin] : []), ...d.commands.map((c) => c.pair), ...Object.keys(d.files ?? {})])].filter((id) => pairs[id]?.key);
	const groups = new Map();
	for (const id of ids) {
		applyRouteMove(id);
		const p = pairs[id], profile = await routeOf(id, p, read);
		const g = profile ? `p:${partitionId(profile, p.key)}` : `u:${id}`;
		if (!groups.has(g)) groups.set(g, { profile, key: p.key, ids: [] });
		groups.get(g).ids.push(id);
	}
	const files = [];
	for (const [g, { profile, key, ids: gids }] of groups) {
		const part = profile ? partitionId(profile, key) : null;
		// The report names the pair the session started in when it is here, else the pair with the most commands.
		const counts = (id) => d.commands.filter((c) => c.pair === id).length;
		const lead = gids.includes(state.origin) ? state.origin : [...gids].sort((a, b) => counts(b) - counts(a) || (a < b ? -1 : 1))[0];
		if (part) ensurePartition(part, profile, key, pairs[lead]);
		// Brief items name facts by key only: their detector and literal come from this partition's registry when it knows them.
		const reg = part ? readJson(P(part, "registry.json"), {})?.facts ?? {} : {};
		const injected = (part ? readJson(P(part, "seen", `${refName(state.ref)}.json`), {})?.items ?? [] : [])
			.map((it) => (it?.kind === "fact" && !it.detector && reg[it.fact_key] ? { ...it, ...reg[it.fact_key] } : it));
		const slice = sliceDigest(d, gids, key), facts = part ? known(part) : [];
		const body = reportBody(slice, key, { remote: pairs[lead].remote, path: pairs[lead].path, order: state.order, machine: machineId(home()), known: facts, injected,
			usage: gids.includes(state.origin) ? state.usage?.total ?? null : null, commands: commandCounts(slice) });
		while (JSON.stringify(body).length > REPORT.bytes && body.facts.observations.length) body.facts.observations.pop();
		const entry = { v: 2, session: state.ref, profile, partition: part, repo_key: key, lead, pairs: gids.map((id) => ({ id, ...pairs[id] })), bytes: JSON.stringify(body),
			provenance: provenanceOf(slice, gids, facts, body.facts.observations),
			status: "pending", created_at: new Date().toISOString(), digest: slice };
		const file = part ? P(part, "queue", `${refName(state.ref)}.json`) : F("unrouted", `${refName(state.ref)}-${g.slice(2)}.json`);
		writePrivate(file, JSON.stringify(entry));
		files.push(file);
	}
	countUnattributed(d.other?.length ?? 0);
	return files;
}

// ---------- sending and settling ----------

const conflictOf = (e) => e?.status === 409 && (e.error?.details?.reason ?? e.error?.reason) === "report_conflict";
/**
 * Final answers other than a conflict (src/api.ts factsIngest): 400 (a body the server will never take), 403 (not allowed), 410 (the
 * routed profile was wiped) and 413 (over the size budget). 503, other 409s and the network are retried.
 */
const finalOf = (e) => [400, 403, 410, 413].includes(e?.status);

/**
 * Applies an accepted reply (or a settled conflict, reply null): the pairs learn the routed profile, a changed profile moves the
 * partition's state, the registry follows the per-fact results, the digest is retained for synthesis and the synthesis cadence counts the
 * session once. The v1 disjointness ledger is deleted after the first v2 report the server accepts.
 */
async function settle(file, entry, reply, config) {
	const profile = routedProfile(reply?.profile) ?? entry.profile;
	if (profile) {
		const part = partitionId(profile, entry.repo_key);
		// The server routed the report by its repo (the lead pair), so only that pair learns the reply's profile; a changed profile moves
		// that pair's evidence alone.
		const lead = (entry.pairs ?? []).find((p) => p.id === entry.lead) ?? entry.pairs?.[0];
		if (reply && lead) { rememberRoute(home(), { id: lead.id, remote: lead.remote, path: lead.path, key: lead.key }, { ...reply, profile }); applyRouteMove(lead.id); }
		ensurePartition(part, profile, entry.repo_key, lead);
		if (reply) {
			const reg = readJson(P(part, "registry.json"), { facts: {} }), sent = new Map(JSON.parse(entry.bytes).facts.observations.map((o) => [o.fact_key, o]));
			for (const r of Array.isArray(reply.facts) ? reply.facts : []) {
				const o = sent.get(r?.fact_key);
				if (r?.status === "refused" && ["fact_forgotten", "fact_flagged"].includes(r.reason)) delete reg.facts[r.fact_key];
				// Merged, never replaced: a learned fact keeps its signature and class, so later sessions can still confirm or contradict it.
				else if ((r?.status === "stored" || r?.status === "seen") && o) reg.facts[r.fact_key] = mergeFact(reg.facts[r.fact_key], o, entry.provenance?.[r.fact_key] ?? (entry.pairs ?? []).map((p) => p.id));
				if (r?.state === "retired") delete reg.facts[r.fact_key];
			}
			writePrivate(P(part, "registry.json"), JSON.stringify(reg));
		}
		if (entry.digest) {
			retain(part, entry.digest);
			try { (await import("./facts-synth.mjs")).markCompleted(config, entry.repo_key, entry.session, { partition: part, profile, ...partitionRoute(part) }); } catch { /* synthesis counts it on a later run */ }
		}
		Object.assign(entry, { profile, partition: part });
		if (reply && reply.report !== "stale") fs.rmSync(F("ledger"), { recursive: true, force: true });
	}
	delete entry.digest;
	entry.settled_at = new Date().toISOString();
	const dest = entry.partition ? P(entry.partition, "queue", path.basename(file)) : file;
	writePrivate(dest, JSON.stringify(entry));
	if (dest !== file) fs.rmSync(file, { force: true });
}

/** Sends one saved report (same bytes every time). Network trouble keeps it pending; a refusal, a conflict or a stale reply settles it. */
async function sendEntry(file, entry, server, config) {
	if (entry?.status !== "pending" || typeof server?.facts !== "function") return entry?.status ?? null;
	let reply;
	try { reply = await server.facts(entry.bytes); } catch (e) {
		if (conflictOf(e)) { entry.status = "conflict"; await settle(file, entry, null, config); return "conflict"; }
		if (finalOf(e)) { entry.status = "refused"; entry.reason = e.error?.details?.reason ?? e.error?.code ?? `http_${e.status}`; delete entry.digest; writePrivate(file, JSON.stringify(entry)); return "refused"; }
		return "pending";
	}
	entry.status = reply?.report === "stale" ? "stale" : "sent";
	entry.reply = { profile: reply?.profile ?? null, routed_by: reply?.routed_by ?? null, report: reply?.report ?? null };
	await settle(file, entry, reply, config);
	return entry.status;
}

/** Every queue file: partition queues and unrouted reports. */
function queueFiles() {
	const out = listJson(F("unrouted")).map((f) => F("unrouted", f));
	const d = F("p");
	for (const part of fs.existsSync(d) ? fs.readdirSync(d).sort() : []) for (const f of listJson(P(part, "queue"))) out.push(P(part, "queue", f));
	return out;
}

// ---------- the session ----------

/**
 * One step of a session, called by processSession with the trigger, its found transcript and repoOf(cwd). Reads the transcript from this
 * module's own cursor, attributes each new command to its pair, and once the session has ended gives it its order, builds and saves its
 * reports, then sends them. Never throws to the caller's capture path. A v1 session state still open, or holding an unsent v1 report, is
 * rebuilt here as v2 from the transcript (contract section 8).
 * @param {{ read?: { facts(body: object, o?: object): Promise<object> } }} [o] the read server for route learning (readServer by default)
 * @returns {Promise<{ repo_key: string | null, session?: string, completed: boolean, status: string } | null>} completed is true only on
 * the call that built the reports
 */
export async function observeSession(t, src, _repo, { server, ended, config, read } = {}) {
	if (typeof t?.session !== "string" || !t.session) return null;
	const file = sessionFile(t.client, t.session);
	let state = readJson(file, null);
	if (state && state.v !== 2) {
		if (state.report && state.report.status !== "pending") return { repo_key: state.repo_key ?? null, completed: false, status: state.report.status };
		state = null;
	}
	const pairAt = pairResolver({ safe: safeRemote });
	if (!state) {
		const origin = pairAt(t.cwd);
		try { if (origin) rememberDir(home(), t.cwd, origin); } catch { /* only speeds up SessionStart */ }
		state = { v: 2, client: t.client, ref: sessionRef(t.client, t.session), cwd: t.cwd ?? null, origin: origin?.id ?? null,
			origin_pair: origin ? { remote: origin.remote, path: origin.path, key: origin.key } : null, read_to: 0, digest: null, usage: null, order: null, built: false, reports: [] };
	}
	const save = () => writePrivate(file, JSON.stringify(state));
	const originKey = state.origin_pair?.key ?? null;
	if (state.built) return { repo_key: originKey, completed: false, status: await sendAll(state.reports, server, config) };
	let size = 0;
	try { size = fs.statSync(src).size; } catch { return { repo_key: originKey, completed: false, status: "source_missing" }; }
	// A transcript that shrank was rewritten: read it again from the start; commands already held merge by call id, usage restarts.
	if (size < state.read_to) { state.read_to = 0; state.usage = null; }
	if (size > state.read_to) {
		const { end, lines } = readLines(src, state.read_to);
		state.digest = mergeDigest(state.digest, commandDigest(t.client, lines, { session: t.session, cwd: state.cwd ?? t.cwd ?? undefined, prior: state.digest, pairAt }));
		state.usage = usageOf(t.client, lines, state.usage) ?? state.usage;
		state.read_to = end;
	}
	// Only a session the existing pipeline marks ended (SessionEnd, sticky) is complete; a Stop can still be followed by more commands.
	if (!ended) { save(); return { repo_key: originKey, completed: false, status: "open" }; }
	// The order is saved before any report is built, so a crash rebuilds with the same {ended_at, seq}.
	if (!state.order) { state.order = { ended_at: endedAt(state.digest), seq: nextSeq() }; save(); }
	let reader = read;
	if (!reader) try { reader = (await import("./agent-memory.mjs")).readServer(config); } catch { reader = null; }
	state.reports = await build(state, reader);
	state.built = true;
	state.digest = null;
	save();
	return { repo_key: originKey, session: state.ref, completed: true, status: await sendAll(state.reports, server, config) };
}

/** Sends a session's queued reports; returns "sent" when all settled, else the first other status. The entries may have moved on settle. */
async function sendAll(files, server, config) {
	let status = "sent";
	for (const f of files) {
		const entry = readJson(f, null);
		const s = entry ? await sendEntry(f, entry, server, config) : "sent";
		if (s === "pending" && status === "sent") status = "pending";
	}
	return status;
}

// ---------- v1 migration, flushing and status ----------

/** v1 session files whose report is still pending: [file, client, session id, state]. */
function v1Pending() {
	return listJson(F("sessions")).map((f) => [f, readJson(F("sessions", f), null)]).filter(([, s]) => s && s.v !== 2 && s.report?.status === "pending")
		.map(([f, s]) => { const m = /^(claude-code|codex)-(.+)\.json$/.exec(f); return m ? [F("sessions", f), m[1], m[2], s] : null; }).filter(Boolean);
}

/**
 * A pending v1 report (contract section 8): rebuilt as v2 reports from its transcript when capture still knows where that is; otherwise
 * its saved v1 bytes are sent unchanged as legacy evidence. A 409 report_conflict settles it like any final answer.
 */
async function migrateV1(file, client, session, state, server, config, read) {
	const src = readJson(statePath(client, session), null)?.source;
	if (typeof src?.transcript_path === "string" && fs.existsSync(src.transcript_path)) {
		const r = await observeSession({ client, session, cwd: src.cwd ?? null }, src.transcript_path, null, { server, ended: true, config, read });
		return r?.status ?? "pending";
	}
	let reply;
	try { reply = await server.facts(state.report.bytes); } catch (e) {
		if (conflictOf(e)) state.report.status = "conflict";
		else if (finalOf(e)) { state.report.status = "refused"; state.report.reason = e.error?.details?.reason ?? e.error?.code ?? `http_${e.status}`; }
		else return "pending";
		writePrivate(file, JSON.stringify(state));
		return state.report.status;
	}
	const profile = routedProfile(reply?.profile);
	if (profile && state.repo_key) {
		const part = partitionId(profile, state.repo_key);
		ensurePartition(part, profile, state.repo_key, { remote: state.remote, path: state.root });
		const sent = JSON.parse(state.report.bytes).facts?.observations ?? [];
		rememberProposals(part, sent.filter((o) => (reply?.report?.facts ?? reply?.facts ?? []).some((r) => r?.fact_key === o.fact_key && (r.status === "stored" || r.status === "seen"))));
	}
	state.report.status = "sent";
	state.report.reply = { profile: reply?.profile ?? null };
	delete state.digest;
	writePrivate(file, JSON.stringify(state));
	return "sent";
}

/** Whether any report is still pending (v2 queue or v1), for the scheduled run's idle check. */
export function hasPending() {
	return queueFiles().some((f) => readJson(f, null)?.status === "pending") || v1Pending().length > 0;
}

/** Sends every pending report: v1 reports migrate first, then the v2 queues. Prunes old settled entries and session-start logs. */
export async function flushPending(server, { config, read } = {}) {
	const cfg = config ?? (await import("./agent-memory.mjs")).loadConfig();
	const out = { sent: 0, pending: 0, refused: 0, conflicts: 0, stale: 0 }, count = (s) => { out[s === "conflict" ? "conflicts" : s in out ? s : "pending"]++; };
	let reader = read;
	for (const [file, client, session, state] of v1Pending()) {
		if (reader === undefined) try { reader = (await import("./agent-memory.mjs")).readServer(cfg); } catch { reader = null; }
		count(await migrateV1(file, client, session, state, server, cfg, reader));
	}
	const cutoff = Date.now() - SETTLED_DAYS * 86_400_000;
	for (const f of queueFiles()) {
		const entry = readJson(f, null);
		if (entry?.status === "pending") count(await sendEntry(f, entry, server, cfg));
		else if (entry?.settled_at && Date.parse(entry.settled_at) < cutoff) fs.rmSync(f, { force: true });
	}
	for (const part of partitions()) for (const f of listJson(P(part.id, "seen")).slice(0, -SEEN_KEPT)) fs.rmSync(P(part.id, "seen", f), { force: true });
	const logs = F("inject"), keepFrom = day(Date.now() - INJECT_LOG_DAYS * 86_400_000);
	for (const f of fs.existsSync(logs) ? fs.readdirSync(logs) : []) if (f.slice(0, 10) < keepFrom) fs.rmSync(path.join(logs, f), { force: true });
	return out;
}

/**
 * Report counts for status and doctor, so they never read this module's file layout. pending and conflicts cover v2 queue entries;
 * pending_v1 and conflicts_v1 the v1 session files not yet migrated. unrouted: v2 reports whose pair has no known route yet.
 * @returns {{ pending: number, pending_v1: number, conflicts: number, conflicts_v1: number, refused: number, stale: number, unrouted: number,
 *   oldest_pending_at: string | null, last_report_at: string | null,
 *   partitions: { id: string, profile: string, repo_key: string, pending: number, conflicts: number, refused: number, stale: number, sent: number, last_report_at: string | null }[] }}
 */
export function pendingReportSummary() {
	const parts = new Map(partitions().map((m) => [m.id, { id: m.id, profile: m.profile, repo_key: m.repo_key, pending: 0, conflicts: 0, refused: 0, stale: 0, sent: 0, last_report_at: null }]));
	const out = { pending: 0, pending_v1: 0, conflicts: 0, conflicts_v1: 0, refused: 0, stale: 0, unrouted: 0, oldest_pending_at: null, last_report_at: null, partitions: [] };
	const key = { pending: "pending", conflict: "conflicts", refused: "refused", stale: "stale", sent: "sent" };
	for (const f of queueFiles()) {
		const e = readJson(f, null), k = key[e?.status];
		if (!k) continue;
		if (k !== "sent") out[k]++;
		if (k === "pending") {
			if (!e.partition) out.unrouted++;
			if (e.created_at && (!out.oldest_pending_at || e.created_at < out.oldest_pending_at)) out.oldest_pending_at = e.created_at;
		}
		if (e.settled_at && (!out.last_report_at || e.settled_at > out.last_report_at)) out.last_report_at = e.settled_at;
		const p = parts.get(e.partition);
		if (p) { p[k]++; if (e.settled_at && (!p.last_report_at || e.settled_at > p.last_report_at)) p.last_report_at = e.settled_at; }
	}
	for (const f of listJson(F("sessions"))) {
		const st = readJson(F("sessions", f), null);
		if (!st || st.v === 2) continue;
		if (st.report?.status === "pending") out.pending_v1++;
		else if (st.report?.status === "conflict") out.conflicts_v1++;
	}
	out.partitions = [...parts.values()];
	return out;
}

/**
 * The local facts part of `status --json` (contract section 7) that this module owns: partitions, pending reports (v2 and v1), the
 * oldest pending report, the last settled report, conflicts and unattributed commands over 7 days. status.mjs adds the config switches,
 * the session-start latency fields (from facts/inject/) and the synthesis block.
 */
export function factsStatus(now = Date.now()) {
	const r = pendingReportSummary(), since = day(now - 6 * 86_400_000);
	let unattributed = 0;
	for (const f of listJson(F("stats"))) if (/^unattributed-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(13, 23) >= since) unattributed += readJson(F("stats", f), {})?.count ?? 0;
	return { partitions: r.partitions.length, pending_reports: r.pending, pending_v1: r.pending_v1, oldest_pending_at: r.oldest_pending_at, last_report_at: r.last_report_at,
		conflicts: r.conflicts + r.conflicts_v1, unattributed_commands_7d: unattributed };
}
