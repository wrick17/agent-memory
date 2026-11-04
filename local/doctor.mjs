// `agent-memory doctor` (LO1): the job token file, the read token file when injection is on, the registered hooks, the launchd job,
// the spool, local capture state and the server's whoami. One line per check, with a fix for each failure. Read only: it never
// prints a token, never edits client settings and never loads the job. Session ids it shows stay on this machine.
import fs from "node:fs";
import path from "node:path";
import { captureSummary, clientHome, expandHome, hookEvents, home, httpServer, LIMITS, loadConfig, readJson, readToken } from "./agent-memory.mjs";
import { launchdLabel, launchdLoaded, loadCommand, plistPath } from "./launchd.mjs";
import { spoolStats } from "./status.mjs";

/** @typedef {{ id: string, ok: boolean, detail: string, fix: string | null }} Check */

const DAY = 86_400_000;
const pass = (id, detail) => ({ id, ok: true, detail, fix: null });
const failed = (id, detail, fix) => ({ id, ok: false, detail, fix });

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
	// loadConfig turns injection on only when inject.enabled is true and inject.profile is set.
	if (!config.inject?.enabled) return pass("read_token", "injection is off; no read token needed");
	const file = expandHome(config.read_token_file), job = expandHome(config.token_file);
	if (readToken(config)) return pass("read_token", `${file} is private; injection reads profile ${config.inject.profile}`);
	if (file && job && path.resolve(file) === path.resolve(job)) {
		return failed("read_token", `${file} is the job token file`, "Set read_token_file in config.json to a separate file that holds a read-scoped device token.");
	}
	const p = file ? tokenFileProblem(file) ?? "unusable" : "not configured";
	return failed("read_token", `${file ?? "read_token_file"}: ${p}`, `Write a read-scoped device token to ${file}, then run: chmod 600 ${file}. Or set inject.enabled to false.`);
}

/** The events whose hook command runs this home's CLI, per client settings file. Reads the settings; never changes them. */
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
	const bin = path.join(home(), "bin", "agent-memory"), want = hookEvents(config), seen = [], gaps = [];
	for (const client of ["claude-code", "codex"]) {
		const r = registered(client, bin);
		if (!r.exists && !r.found.size) continue;
		seen.push(client);
		const missing = want.filter((e) => !r.found.has(e));
		if (missing.length) gaps.push({ client, file: r.file, missing });
	}
	if (!seen.length) return failed("hooks", "no Claude Code or Codex home found", "Run agent-memory install and add the printed hooks to your client settings.");
	if (gaps.length) {
		return failed("hooks", gaps.map((g) => `${g.client} is missing ${g.missing.join(", ")}`).join("; "),
			`Run agent-memory install and add the printed hooks to ${gaps.map((g) => g.file).join(" and ")}.`);
	}
	return pass("hooks", `${seen.join(" and ")} register ${want.join(", ")}`);
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

/** Pending, stuck and missing-source sessions, with their local ids. These ids are printed here only, never uploaded. */
function captureCheck(now) {
	const s = captureSummary({ ids: true });
	const ids = (rows) => [...new Set(rows.map((r) => `${r.client}:${r.session}`))].slice(0, 3).join(", ");
	const old = s.oldest_pending_at && now - Date.parse(s.oldest_pending_at) > 7 * DAY;
	const counts = `${s.pending_ranges} pending, ${s.stuck_ranges} stuck, ${s.missing_sources} with no transcript`;
	if (!s.stuck_ranges && !s.missing_sources && !old) return pass("capture", counts);
	const parts = [s.stuck_ranges && `stuck: ${ids(s.local.stuck)}`, s.missing_sources && `no transcript: ${ids(s.local.missing)}`, old && `oldest pending ${s.oldest_pending_at}`].filter(Boolean);
	return failed("capture", `${counts} (${parts.join("; ")})`,
		"Stuck ranges retry when the session grows; check the runner with agent-memory run. A session with no transcript stays preserved and cannot be recovered here.");
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
	return [job, guard("read_token", () => readTokenCheck(config)), guard("hooks", () => hooksCheck(config)), guard("launchd", () => launchdCheck(platform)),
		guard("spool", () => spoolCheck(now)), guard("capture", () => captureCheck(now)),
		await whoamiCheck(config, server ?? httpServer(config), job.ok).catch(() => failed("whoami", "the check could not run", "Check config.json."))];
}

/** One line per check: "ok   <id>  <detail>" or "FAIL <id>  <detail> — fix: <fix>". */
export function formatChecks(checks) {
	return checks.map((c) => (c.ok ? `ok   ${c.id}  ${c.detail}` : `FAIL ${c.id}  ${c.detail} — fix: ${c.fix}`)).join("\n") + "\n";
}

/** Resolves to 0 when every check passes, else 1. */
export async function main(argv, prog = "agent-memory doctor") {
	if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(`usage: ${prog}\nChecks this machine's Agent Memory setup and prints a fix for each failure.\n`); return 0; }
	if (argv.length) { process.stderr.write(`usage: ${prog}\n`); return 2; }
	const checks = await doctorChecks({ config: loadConfig() });
	process.stdout.write(formatChecks(checks));
	return checks.every((c) => c.ok) ? 0 : 1;
}
