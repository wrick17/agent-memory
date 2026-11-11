// The per-device capture report sent to POST /v1/status at the end of each run (LO1 builds it, C1 sends it), and the local
// `status --json` view (localStatus), which adds repo facts and loop-guard activity under `facts` and `loop_guard`.
// Ids, versions and counts only: no transcript text, path contents, session ids or token.
import fs from "node:fs";
import path from "node:path";
import { captureSummary, hookEvents, home } from "./agent-memory.mjs";
import { factsStatus as clientFacts } from "./facts-client.mjs";
import { factsPath } from "./facts.mjs";
import { synthStatus, SYNTH_LIMITS } from "./facts-synth.mjs";
import { launchdLabel, launchdLoaded as loadedCheck } from "./launchd.mjs";

const WEEK_MS = 7 * 86_400_000;

// The server's allowlist (src/client-status.ts). The loop guard's PostToolUse and PostToolUseFailure are not on it, so the
// report leaves them out; doctor checks them locally.
const HOOKS = new Set(["Stop", "SessionEnd", "SessionStart", "PreCompact", "UserPromptSubmit"]);

/** The spool's file count, bytes and oldest file time. The spool holds digests and manifests only; none of it is read here. */
export function spoolStats() {
	const dir = path.join(home(), "spool");
	let files = 0, bytes = 0, oldest = Infinity;
	for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
		try {
			const st = fs.statSync(path.join(dir, f));
			files++; bytes += st.size;
			if (st.mtimeMs < oldest) oldest = st.mtimeMs;
		} catch { /* removed meanwhile */ }
	}
	return { files, bytes, oldest_at: oldest < Infinity ? new Date(oldest).toISOString() : null };
}

/**
 * The report body for the H1 schema. `device` is left out: the server takes it from the job token. launchd_loaded is false off
 * macOS or when launchd cannot tell, because the schema takes a boolean only.
 * @returns {{ clients: Record<string, string>, hooks: string[], inject: boolean, spool_files: number, spool_bytes: number,
 *   oldest_spool_at: string | null, last_digest_at: string | null, refused_since_last: number, launchd_loaded: boolean,
 *   pending_ranges: number, stuck_ranges: number, oldest_pending_at: string | null, missing_sources: number }}
 * @param {{ config: object, hooks?: string[], launchdLoaded?: boolean | null }} opts
 */
export function statusReport({ config, hooks, launchdLoaded } = {}) {
	const s = captureSummary(), spool = spoolStats();
	const loaded = launchdLoaded === undefined ? loadedCheck(launchdLabel(home())) : launchdLoaded;
	return {
		clients: s.clients,
		hooks: [...new Set((hooks ?? hookEvents(config)).filter((h) => HOOKS.has(h)))],
		inject: config?.inject?.enabled === true,
		spool_files: spool.files, spool_bytes: spool.bytes, oldest_spool_at: spool.oldest_at,
		last_digest_at: s.last_digest_at, refused_since_last: s.refused_since_last, launchd_loaded: loaded === true,
		pending_ranges: s.pending_ranges, stuck_ranges: s.stuck_ranges, oldest_pending_at: s.oldest_pending_at, missing_sources: s.missing_sources,
	};
}

/** Sends the report with the job token; a v1 server's 404 or any failure is returned, never thrown. @returns {Promise<{ status: "sent" | "failed", reason?: string }>} */
export async function reportStatus({ config, server } = {}) {
	if (typeof server?.status !== "function") return { status: "failed", reason: "no_status_route" };
	let body;
	try { body = statusReport({ config }); } catch { return { status: "failed", reason: "report_unreadable" }; }
	try {
		await server.status(body);
		return { status: "sent" };
	} catch (e) {
		return { status: "failed", reason: Number.isInteger(e?.status) ? `http_${e.status}` : "unreachable" };
	}
}

/** A time as ISO, or null. */
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * Session-start injection over the last 7 days, from facts/inject/<day>.jsonl (facts-inject.mjs writes one { at, ms, outcome } line
 * per SessionStart run). p95 is the nearest-rank 95th percentile of ms; null when no run was logged, never zero.
 */
export function injectLatency(now = Date.now()) {
	const dir = factsPath(home(), "inject"), since = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10), ms = [];
	let timeouts = 0;
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since); } catch { /* no runs logged */ }
	for (const f of files) {
		let text = "";
		try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
		for (const line of text.split("\n")) {
			let r;
			try { r = JSON.parse(line); } catch { continue; } // a torn or empty line
			const at = Date.parse(r?.at ?? "");
			if (!Number.isFinite(at) || now - at > WEEK_MS || at - now > WEEK_MS) continue;
			if (Number.isFinite(r.ms) && r.ms >= 0) ms.push(r.ms);
			if (r.outcome === "timeout") timeouts++;
		}
	}
	ms.sort((a, b) => a - b);
	return { inject_p95_ms: ms.length ? ms[Math.ceil(ms.length * 0.95) - 1] : null, inject_timeouts_7d: timeouts, inject_runs_7d: ms.length };
}

/**
 * status --json `facts` (contract section 7): the config switches, the client's partition, report and attribution counts
 * (facts-client.mjs factsStatus), injection latency from its own log, and the synthesis slots (facts-synth.mjs synthStatus; zero
 * used when synthesis is off, since nothing is read then).
 */
export function factsStatus(config, now = Date.now()) {
	return {
		inject: config?.facts?.inject === true, synthesis: config?.facts?.synthesis === true,
		...clientFacts(now), ...injectLatency(now),
		synth: synthStatus(config, now) ?? { used_today: 0, cap: SYNTH_LIMITS.daily, queued: 0, unknown_attempts: 0 },
	};
}

/**
 * The loop guard's switches and its fires in the last 7 days, from the hash-only fires.jsonl (and its rotated .1). `fires_7d` are
 * notes the agent saw; `shadow_fires_7d` are would-fires logged in shadow mode. Each line holds a time, client, hashed ids, the rule
 * and counts; only the time, shadow flag and rule are read.
 */
export function loopGuardStatus(config, now = Date.now()) {
	const dir = path.join(home(), "loop-guard"), out = { enabled: config?.loop_guard?.enabled === true, shadow: config?.loop_guard?.shadow === true,
		fires_7d: 0, shadow_fires_7d: 0, by_rule_7d: {}, last_fire_at: null };
	let last = 0;
	for (const f of ["fires.jsonl.1", "fires.jsonl"]) {
		let text = "";
		try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
		for (const line of text.split("\n")) {
			let e;
			try { e = JSON.parse(line); } catch { continue; }
			const at = Date.parse(e?.at ?? "");
			if (!Number.isFinite(at) || now - at > WEEK_MS || at - now > WEEK_MS) continue;
			if (e.shadow === true) out.shadow_fires_7d++;
			else out.fires_7d++;
			const rule = typeof e.rule === "string" && /^[a-z_]{1,32}$/.test(e.rule) ? e.rule : "other";
			out.by_rule_7d[rule] = (out.by_rule_7d[rule] ?? 0) + 1;
			last = Math.max(last, at);
		}
	}
	out.last_fire_at = iso(last);
	return out;
}

/**
 * `status --json`: the server report's fields plus `facts` and `loop_guard`. Local only: the /v1/status schema is strict, so these
 * two keys never go in statusReport's body.
 * @param {{ config: object, now?: number, hooks?: string[], launchdLoaded?: boolean | null }} opts
 */
export function localStatus({ config, now = Date.now(), ...opts } = {}) {
	return { ...statusReport({ config, ...opts }), facts: factsStatus(config, now), loop_guard: loopGuardStatus(config, now) };
}

/** Text lines for `status` without --json. */
export function formatLocalStatus(s) {
	const f = s.facts, g = s.loop_guard, on = (b) => (b ? "on" : "off"), na = (v) => (v === null || v === undefined ? "not recorded" : String(v));
	return [
		`Repo facts: inject ${on(f.inject)}, synthesis ${on(f.synthesis)}, ${f.partitions} partitions`,
		`  Pending reports: ${f.pending_reports} (${f.pending_v1} legacy v1)${f.oldest_pending_at ? `, oldest ${f.oldest_pending_at}` : ""}; conflicts ${f.conflicts}; last report ${f.last_report_at ?? "never"}`,
		`  Synthesis slots today: ${f.synth.used_today} of ${f.synth.cap} used; ${f.synth.queued} queued, ${f.synth.unknown_attempts} unknown attempts`,
		`  Inject p95 (7 days): ${f.inject_p95_ms === null ? "no runs logged" : `${f.inject_p95_ms} ms over ${f.inject_runs_7d} runs`}; inject timeouts (7 days): ${na(f.inject_timeouts_7d)}; unattributed commands (7 days): ${na(f.unattributed_commands_7d)}`,
		`Loop guard: ${on(g.enabled)}${g.shadow ? " (shadow)" : ""}; fires in the last 7 days: ${g.fires_7d}, shadow would-fires: ${g.shadow_fires_7d}${g.last_fire_at ? `, last ${g.last_fire_at}` : ""}`,
		...Object.entries(g.by_rule_7d).map(([rule, n]) => `  ${rule}: ${n}`),
	].join("\n");
}
