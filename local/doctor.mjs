// `agent-memory doctor` (LO1): the job token file, the read token file when injection is on, the registered hooks and Codex's trust
// of them, the launchd job, the spool, local capture state and queue age, batch learning, repo-fact warnings and the server's whoami. One line per check, with a fix for each failure. Read only: it never
// prints a token, never edits client settings and never loads the job. Session ids it shows stay on this machine.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureSummary, clientHome, expandHome, hookEvents, home, httpServer, LIMITS, loadConfig, readJson, readToken } from "./agent-memory.mjs";
import { launchdLabel, launchdLoaded, loadCommand, plistPath } from "./launchd.mjs";
import { factsStatus, loopGuardStatus, spoolStats } from "./status.mjs";

/** @typedef {{ id: string, ok: boolean, warn?: boolean, detail: string, fix: string | null }} Check */

const DAY = 86_400_000;
const pass = (id, detail) => ({ id, ok: true, detail, fix: null });
const failed = (id, detail, fix) => ({ id, ok: false, detail, fix });
/** A warning: printed with its fix, but it does not fail the doctor. */
const warned = (id, detail, fix) => ({ id, ok: true, warn: true, detail, fix });

/** A private token file: a regular file (not a link) owned by this user with no group or other access, holding one word. */
function tokenFileProblem(file) {
	let st;
	try { st = fs.lstatSync(file); } catch { return "missing"; }
	if (!st.isFile()) return "not a regular file";
	if (st.uid !== process.getuid()) return "owned by another user";
	if ((st.mode & 0o077) !== 0) return `mode ${(st.mode & 0o777).toString(8)}, expected 600`;
	let t;
	try { t = fs.readFileSync(file, "utf8").trim(); } catch { return "unreadable"; }
	return !t || /\s/.test(t) ? "empty or malformed" : null;
}

function jobTokenCheck(config) {
	const file = expandHome(config.token_file);
	if (!file) return failed("job_token", "config.json names no token_file", "Run agent-memory install, then write this device's job token to the job-token file it names.");
	const p = tokenFileProblem(file);
	return p ? failed("job_token", `${file}: ${p}`, `Write this device's job token to ${file}, then run: chmod 600 ${file}`) : pass("job_token", `${file} is private`);
}

function readTokenCheck(config) {
	// loadConfig turns prompt injection on only when inject.enabled is true and inject.profile is set; repo facts with facts.inject.
	const uses = [config.inject?.enabled ? `injection reads profile ${config.inject.profile}` : null, config.facts?.inject ? "repo facts are read at session start" : null].filter(Boolean);
	if (!uses.length) return pass("read_token", "injection is off; no read token needed");
	const file = expandHome(config.read_token_file), job = expandHome(config.token_file);
	if (readToken(config)) return pass("read_token", `${file} is private; ${uses.join("; ")}`);
	if (file && job && path.resolve(file) === path.resolve(job)) {
		return failed("read_token", `${file} is the job token file`, "Set read_token_file in config.json to a separate file that holds a read-scoped device token.");
	}
	const p = file ? tokenFileProblem(file) ?? "unusable" : "not configured";
	return failed("read_token", `${file ?? "read_token_file"}: ${p}`, `Write a read-scoped device token to ${file}, then run: chmod 600 ${file}. Or set inject.enabled and facts.inject to false.`);
}

/**
 * The events whose hook command runs this home's CLI, per client settings file. Reads the settings; never changes them. A command
 * matches by "<bin> hook <client>" anywhere in it, so the stable `<home>/bin/node <bin> hook …` form, an older versioned Node path
 * before bin, and a bare bin all count.
 */
function registered(client, bin) {
	const dir = clientHome(client);
	if (client === "claude-code") {
		const file = path.join(dir, "settings.json"), s = readJson(file, null), found = new Set();
		for (const [event, groups] of Object.entries(s?.hooks ?? {})) {
			for (const g of Array.isArray(groups) ? groups : []) {
				if ((Array.isArray(g?.hooks) ? g.hooks : []).some((h) => typeof h?.command === "string" && h.command.includes(`${bin} hook claude-code`))) found.add(event);
			}
		}
		return { file, exists: fs.existsSync(dir), found };
	}
	const file = path.join(dir, "config.toml"), found = new Set();
	let text = "";
	try { text = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
	let event = null;
	for (const line of text.split("\n")) {
		const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
		if (header) { event = /^hooks\.([A-Za-z]+)(?:\.hooks)?$/.exec(header[1])?.[1] ?? null; continue; }
		const cmd = /^\s*command\s*=\s*"((?:\\.|[^"\\])*)"/.exec(line);
		if (event && cmd && cmd[1].includes(`${bin} hook codex`)) found.add(event);
	}
	return { file, exists: fs.existsSync(dir), found };
}

function hooksCheck(config) {
	const bin = path.join(home(), "bin", "agent-memory"), seen = [], gaps = [];
	for (const client of ["claude-code", "codex"]) {
		const r = registered(client, bin);
		if (!r.exists && !r.found.size) continue;
		seen.push(client);
		const missing = hookEvents(config, client).filter((e) => !r.found.has(e));
		if (missing.length) gaps.push({ client, file: r.file, missing });
	}
	if (!seen.length) return failed("hooks", "no Claude Code or Codex home found", "Run agent-memory install and add the printed hooks to your client settings.");
	if (gaps.length) {
		return failed("hooks", gaps.map((g) => `${g.client} is missing ${g.missing.join(", ")}`).join("; "),
			`Run agent-memory install and add the printed hooks to ${gaps.map((g) => g.file).join(" and ")}.`);
	}
	return pass("hooks", seen.map((c) => `${c} registers ${hookEvents(config, c).join(", ")}`).join("; "));
}

function launchdCheck(platform) {
	if (platform !== "darwin") return pass("launchd", "not macOS; schedule agent-memory run --scheduled daily with this system's scheduler");
	const label = launchdLabel(home()), file = plistPath(label);
	let st;
	try { st = fs.lstatSync(file); } catch { return failed("launchd", `${file} is missing`, "Run agent-memory install to write the daily job."); }
	// launchd skips a job file that is a link, owned by someone else, or writable by group or others.
	if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0) return failed("launchd", `${file} must be a regular file that you own and only you can write`, `Run: chmod 644 ${file}, or run agent-memory install again.`);
	const loaded = launchdLoaded(label);
	if (loaded === true) return pass("launchd", `${label} is loaded`);
	return failed("launchd", loaded === false ? `${label} is not loaded` : `cannot tell whether ${label} is loaded`, `Run: ${loadCommand(file)}`);
}

function spoolCheck(now) {
	const s = spoolStats();
	if (!s.files) return pass("spool", "empty");
	const detail = `${s.files} files, ${s.bytes} bytes, oldest ${s.oldest_at}`;
	const full = s.files >= LIMITS.spoolFiles * 0.9 || s.bytes >= LIMITS.spoolBytes * 0.9;
	if (full || now - Date.parse(s.oldest_at) > DAY) {
		return failed("spool", `${detail}${full ? " (near its limit)" : ""}`, "Check that the server in config.json is reachable; the next run sends the spool.");
	}
	return pass("spool", `${detail}; the next run sends it`);
}

/** Queued triggers first written more than 7 days ago: a run settles or removes every trigger within 7 days. */
function staleTriggers(now) {
	const out = [];
	for (const dir of ["queue", "claimed"]) {
		const d = path.join(home(), dir);
		for (const f of fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith(".json")) : []) {
			const t = readJson(path.join(d, f), null);
			if (Number.isFinite(t?.first_at) && now - t.first_at > 7 * DAY) out.push({ client: t.client, session: t.session });
		}
	}
	return out;
}

/**
 * Pending, stuck and missing-source sessions and triggers queued over 7 days, with their local ids. These ids are printed here only,
 * never uploaded. A session settled as source_missing (Codex ephemeral, Claude not persisted, or no source after 7 days) is reported, not failed.
 */
function captureCheck(now) {
	const s = captureSummary({ ids: true, now });
	const ids = (rows) => [...new Set(rows.map((r) => `${r.client}:${r.session}`))].slice(0, 3).join(", ");
	const old = s.oldest_pending_at && now - Date.parse(s.oldest_pending_at) > 7 * DAY;
	const stale = staleTriggers(now);
	const counts = `${s.pending_ranges} pending, ${s.stuck_ranges} stuck, ${s.missing_sources} with no transcript yet, ${s.local.settled.length} settled with no source`;
	if (!s.stuck_ranges && !s.missing_sources && !old && !stale.length) return pass("capture", counts);
	const parts = [s.stuck_ranges && `stuck: ${ids(s.local.stuck)}`, s.missing_sources && `no transcript: ${ids(s.local.missing)}`, old && `oldest pending ${s.oldest_pending_at}`,
		stale.length && `${stale.length} queued over 7 days: ${ids(stale)}`].filter(Boolean);
	return failed("capture", `${counts} (${parts.join("; ")})`,
		"Run agent-memory run: it settles a session with no transcript after 7 days and drains the queue. Stuck ranges retry when the session grows.");
}

// ---------- Codex hook trust ----------

// Codex 0.167.1 (codex-rs/hooks): a configured hook runs only when [hooks.state."<source file>:<event>:<group>:<handler>"].trusted_hash
// equals the hash of its normalized declaration (engine/discovery.rs hook_hash; config fingerprint.rs version_for_toml), unless the
// invocation passes --dangerously-bypass-hook-trust. A missing hash is untrusted; a different one is modified. Neither runs.
const CODEX_EVENT_KEYS = { PreToolUse: "pre_tool_use", PermissionRequest: "permission_request", PostToolUse: "post_tool_use", PreCompact: "pre_compact",
	PostCompact: "post_compact", SessionStart: "session_start", SessionEnd: "session_end", UserPromptSubmit: "user_prompt_submit",
	SubagentStart: "subagent_start", SubagentStop: "subagent_stop", Stop: "stop" };
// Events whose group matcher is kept in the identity (hooks/src/events/common.rs matcher_pattern_for_event).
const MATCHER_EVENTS = new Set(["PreToolUse", "PermissionRequest", "PostToolUse", "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact"]);
// Events that keep additionalContextLimit, and its default, which normalizes to unset.
const CONTEXT_EVENTS = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]), CONTEXT_DEFAULT = 2500;

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

/** Codex's trust hash of one command handler, as discovery.rs computes it: sha256 of the sorted-key JSON of its normalized identity. */
export function codexHookHash(event, matcher, h) {
	const timeout = event === "SessionEnd" ? Math.min(Math.max(h.timeout ?? 1, 1), 3) : Math.max(h.timeout ?? 600, 1);
	const limit = CONTEXT_EVENTS.has(event) && Number.isInteger(h.additionalContextLimit) && h.additionalContextLimit !== CONTEXT_DEFAULT ? h.additionalContextLimit : undefined;
	const handler = { type: "command", command: h.command, timeout, async: h.async === true,
		...(typeof h.statusMessage === "string" ? { statusMessage: h.statusMessage } : {}), ...(limit !== undefined ? { additionalContextLimit: limit } : {}) };
	const identity = { event_name: CODEX_EVENT_KEYS[event], ...(MATCHER_EVENTS.has(event) && typeof matcher === "string" ? { matcher } : {}), hooks: [handler] };
	return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex")}`;
}

/** A TOML scalar: a basic or literal string, an integer or a boolean; anything else is undefined. */
function tomlScalar(raw) {
	const v = raw.trim();
	const basic = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(v);
	if (basic) { try { return JSON.parse(`"${basic[1]}"`); } catch { return undefined; } }
	const literal = /^'([^']*)'\s*(?:#.*)?$/.exec(v);
	if (literal) return literal[1];
	if (/^(true|false)\s*(?:#.*)?$/.test(v)) return v.startsWith("true");
	if (/^[+-]?\d[\d_]*\s*(?:#.*)?$/.test(v)) return Number(v.replace(/[_\s]|#.*$/g, ""));
	return undefined;
}

/**
 * Hook groups and [hooks.state] entries of a Codex config.toml, in the [[hooks.<Event>]] / [[hooks.<Event>.hooks]] form that install
 * prints. Inline-table hooks are not read. Returns { groups: { event: [{ matcher, hooks: [handler] }] }, state: { key: { trusted_hash, enabled } } }.
 */
export function parseCodexHooks(text) {
	const groups = {}, state = {};
	let target = null, inState = false;
	for (const line of text.split("\n")) {
		const header = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
		if (header) {
			const name = header[2], array = header[1] === "[[";
			inState = name === "hooks.state";
			const ev = /^hooks\.([A-Za-z]+)$/.exec(name)?.[1], handler = /^hooks\.([A-Za-z]+)\.hooks$/.exec(name)?.[1];
			const st = /^hooks\.state\."((?:\\.|[^"\\])+)"$/.exec(name);
			if (array && ev && ev !== "state") { (groups[ev] ??= []).push({ matcher: null, hooks: [] }); target = groups[ev].at(-1); }
			else if (array && handler && groups[handler]?.length) { const h = {}; groups[handler].at(-1).hooks.push(h); target = h; }
			else if (!array && st) { let key; try { key = JSON.parse(`"${st[1]}"`); } catch { key = st[1]; } target = state[key] ??= {}; }
			else target = null;
			continue;
		}
		const inline = inState && /^\s*"((?:\\.|[^"\\])+)"\s*=\s*\{(.*)\}\s*(?:#.*)?$/.exec(line);
		if (inline) {
			let key;
			try { key = JSON.parse(`"${inline[1]}"`); } catch { key = inline[1]; }
			const entry = state[key] ??= {};
			for (const m of inline[2].matchAll(/(trusted_hash|enabled)\s*=\s*("(?:\\.|[^"\\])*"|true|false)/g)) entry[m[1]] = tomlScalar(m[2]);
			continue;
		}
		const kv = target && /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
		if (kv) { const v = tomlScalar(kv[2]); if (v !== undefined) target[kv[1]] = v; }
	}
	return { groups, state };
}

/**
 * Trust of each agent-memory Codex hook in config.toml and hooks.json under the Codex home: trusted, modified (hash changed since it
 * was trusted), untrusted (never trusted) or disabled. Codex skips all but trusted ones in an interactive session.
 */
export function codexHookTrust(dir, bin, events) {
	const configFile = path.join(dir, "config.toml"), jsonFile = path.join(dir, "hooks.json");
	let text = "";
	try { text = fs.readFileSync(configFile, "utf8"); } catch { /* none */ }
	const { groups, state } = parseCodexHooks(text);
	const sources = [[configFile, groups]];
	const json = readJson(jsonFile, null)?.hooks;
	if (json && typeof json === "object") sources.push([jsonFile, Object.fromEntries(Object.entries(json).map(([e, gs]) => [e, Array.isArray(gs) ? gs.map((g) => ({ matcher: g?.matcher ?? null, hooks: Array.isArray(g?.hooks) ? g.hooks : [] })) : []]))]);
	const out = [];
	for (const [file, byEvent] of sources) {
		for (const event of events) {
			(byEvent[event] ?? []).forEach((g, gi) => g.hooks.forEach((h, hi) => {
				if (h?.type !== "command" || typeof h.command !== "string" || !h.command.includes(`${bin} hook codex`) || !CODEX_EVENT_KEYS[event]) return;
				const key = `${file}:${CODEX_EVENT_KEYS[event]}:${gi}:${hi}`, s = state[key];
				const status = s?.enabled === false ? "disabled" : typeof s?.trusted_hash !== "string" ? "untrusted" : s.trusted_hash === codexHookHash(event, g.matcher, h) ? "trusted" : "modified";
				out.push({ event, key, status });
			}));
		}
	}
	return out;
}

function codexTrustCheck(config) {
	const dir = clientHome("codex"), bin = path.join(home(), "bin", "agent-memory");
	if (!fs.existsSync(dir)) return pass("codex_hook_trust", "no Codex home");
	const rows = codexHookTrust(dir, bin, hookEvents(config, "codex"));
	if (!rows.length) return pass("codex_hook_trust", "no agent-memory hooks in Codex config");
	const bad = rows.filter((r) => r.status !== "trusted");
	if (!bad.length) return pass("codex_hook_trust", `${rows.map((r) => r.event).join(", ")} trusted`);
	return failed("codex_hook_trust", bad.map((r) => `${r.event} ${r.status}`).join(", "),
		"Start codex in a terminal and choose \"Trust all and continue\" at \"Hooks need review\"; until then Codex skips these hooks (only --dangerously-bypass-hook-trust runs run them).");
}

// ---------- batch learning ----------

/**
 * A configured batch profile whose learning clock (batch/last.json: profiles[p].last_write_at, else tracked_since) is more than 3 days
 * old: the batch applied no record for 3 days, a warning (not a failure). A missing or unreadable file, or a profile with neither field, is reported, not failed.
 */
function batchCheck(config, now) {
	const profiles = Array.isArray(config.batch_profiles) ? config.batch_profiles.filter((p) => typeof p === "string") : [];
	if (!profiles.length) return pass("batch_learning", "batch is off (no batch_profiles)");
	const last = readJson(path.join(home(), "batch", "last.json"), null);
	if (!last || typeof last !== "object") return pass("batch_learning", "no batch run recorded yet");
	const idle = [], unknown = [];
	for (const p of profiles) {
		const r = last.profiles?.[p], at = Date.parse(r?.last_write_at ?? r?.tracked_since ?? "");
		if (Number.isNaN(at)) unknown.push(p);
		else if (now - at > 3 * DAY) idle.push(`${p} since ${new Date(at).toISOString()}`);
	}
	if (idle.length) return warned("batch_learning", `no record written for 3 days: ${idle.join("; ")}`, "Check the batch's skip reasons in batch/last.json and logs/batch.log; a runtime that is not proved writes nothing.");
	return pass("batch_learning", `records written within 3 days${unknown.length ? `; no learning clock yet for ${unknown.join(", ")}` : ""}`);
}

// ---------- repo facts (contract section 7) ----------

/** facts_profile_config, facts_pending, facts_inject_latency and facts_v1_pending. They warn; none fails the doctor. */
async function factsChecks(config, now) {
	const out = [];
	// The raw config: loadConfig drops an invalid facts.profile, and any value set is a leftover.
	const raw = readJson(path.join(home(), "config.json"), null)?.facts?.profile;
	out.push(raw != null ? warned("facts_profile_config", "facts.profile is set in config.json; the client no longer reads it", "Remove facts.profile from config.json: repo facts route by the remote, like capture.")
		: pass("facts_profile_config", "facts.profile is not set"));
	let s;
	try { s = factsStatus(config, now); } catch { return [...out, warned("facts_pending", "the facts status could not be read", "Run agent-memory install, then try again.")]; }
	const oldDays = s.oldest_pending_at ? (now - Date.parse(s.oldest_pending_at)) / DAY : 0;
	out.push(s.pending_reports > 20 || oldDays > 3
		? warned("facts_pending", `${s.pending_reports} pending reports, oldest ${s.oldest_pending_at}`, "Check that the server is reachable; each run sends pending reports.")
		: pass("facts_pending", `${s.pending_reports} pending reports`));
	out.push(s.inject_p95_ms > 1500
		? warned("facts_inject_latency", `session-start p95 ${s.inject_p95_ms} ms over 7 days (${s.inject_timeouts_7d} timeouts)`, "Check the network to the server; injection gives up at facts.timeout_ms.")
		: pass("facts_inject_latency", s.inject_p95_ms === null ? "no session-start runs logged in 7 days" : `session-start p95 ${s.inject_p95_ms} ms over 7 days, ${s.inject_timeouts_7d} timeouts`));
	// The loop guard, for information: its hooks' registration and Codex trust are the hooks and codex_hook_trust checks.
	const g = loopGuardStatus(config, now);
	out.push(pass("loop_guard", `${g.enabled ? "on" : "off"}${g.shadow ? " (shadow)" : ""}; ${g.fires_7d} fires and ${g.shadow_fires_7d} shadow would-fires in 7 days`));
	out.push(s.pending_v1 > 0
		? warned("facts_v1_pending", `${s.pending_v1} v1 reports pending`, "Let the next runs migrate them; v1 acceptance ends only after every device shows 0.")
		: pass("facts_v1_pending", "no v1 reports pending"));
	return out;
}

async function whoamiCheck(config, server, jobOk) {
	if (!jobOk) return failed("whoami", "skipped: the job token file is not usable", "Fix job_token first.");
	if (typeof config.server !== "string" || !config.server) return failed("whoami", "config.json names no server", "Run agent-memory install, or set server in config.json.");
	try {
		const r = await server.whoami();
		const device = typeof r?.device_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.device_id) ? r.device_id : null;
		const scopes = Array.isArray(r?.scopes) ? r.scopes.filter((x) => typeof x === "string" && /^[a-z_]{1,32}$/.test(x)) : [];
		if (r?.kind !== "device" || !device) return failed("whoami", "the server did not answer as a device token", `Write a device job token, not an owner token, to ${config.token_file}.`);
		const missing = ["ingest", "maintenance"].filter((x) => !scopes.includes(x));
		if (missing.length) return failed("whoami", `device ${device} lacks ${missing.join(", ")}`, "Create this device's job token with the ingest and maintenance scopes.");
		return pass("whoami", `device ${device}, scopes ${scopes.join(",")}`);
	} catch (e) {
		if (e?.status === 401 || e?.status === 403) return failed("whoami", `the server refused the job token (HTTP ${e.status})`, `The token is revoked or wrong: create a new job token for this device and write it to ${config.token_file}.`);
		return failed("whoami", Number.isInteger(e?.status) ? `HTTP ${e.status} from ${config.server}` : `cannot reach ${config.server}`, "Check the network and the server URL in config.json.");
	}
}

/** @param {{ config: object, server?: object, now?: number, platform?: string }} opts @returns {Promise<Check[]>} */
export async function doctorChecks({ config, server, now = Date.now(), platform = process.platform } = {}) {
	const guard = (id, f) => { try { return f(); } catch { return failed(id, "the check could not run", "Run agent-memory install, then try again."); } };
	const job = guard("job_token", () => jobTokenCheck(config));
	return [job, guard("read_token", () => readTokenCheck(config)), guard("hooks", () => hooksCheck(config)), guard("codex_hook_trust", () => codexTrustCheck(config)),
		guard("launchd", () => launchdCheck(platform)), guard("spool", () => spoolCheck(now)), guard("capture", () => captureCheck(now)), guard("batch_learning", () => batchCheck(config, now)),
		...await factsChecks(config, now).catch(() => [warned("facts_pending", "the facts checks could not run", "Run agent-memory install, then try again.")]),
		await whoamiCheck(config, server ?? httpServer(config), job.ok).catch(() => failed("whoami", "the check could not run", "Check config.json."))];
}

/** One line per check: "ok   <id>  <detail>", "WARN <id>  <detail> — fix: <fix>" or "FAIL <id>  <detail> — fix: <fix>". */
export function formatChecks(checks) {
	return checks.map((c) => (c.warn ? `WARN ${c.id}  ${c.detail} — fix: ${c.fix}` : c.ok ? `ok   ${c.id}  ${c.detail}` : `FAIL ${c.id}  ${c.detail} — fix: ${c.fix}`)).join("\n") + "\n";
}

/** Resolves to 0 when every check passes (warnings included), else 1. */
export async function main(argv, prog = "agent-memory doctor") {
	if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(`usage: ${prog}\nChecks this machine's Agent Memory setup and prints a fix for each failure.\n`); return 0; }
	if (argv.length) { process.stderr.write(`usage: ${prog}\n`); return 2; }
	const checks = await doctorChecks({ config: loadConfig() });
	process.stdout.write(formatChecks(checks));
	return checks.every((c) => c.ok) ? 0 : 1;
}
