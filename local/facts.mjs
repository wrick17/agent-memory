// Repo facts, P0 primitives (#90, #93): the GitHub repo key and the local command digest. Nothing here uploads or calls a model.
// The digest is built from transcript lines on this machine, redacted and bounded; raw command output never leaves this module.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { editedPaths, redact } from "./agent-memory.mjs";

/** Per digest: at most `commands` commands (newest kept), each text at most `text` characters, `errLines` lines per failure. */
export const FACT_LIMITS = Object.freeze({ commands: 400, text: 200, errLines: 2 });

const sha = (s) => createHash("sha256").update(s).digest("hex");
// A cut never splits a "[REDACTED]" marker, so a cut text is still stable under scrub.
const cut = (s, n = FACT_LIMITS.text) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\[(?:R(?:E(?:D(?:A(?:C(?:T(?:E(?:D)?)?)?)?)?)?)?)?$/, "")}…`);

// ---------- repo key ----------

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);
// A host or SSH alias: DNS-style labels only, so no option-like (leading "-"), spaced or shell-special value reaches ssh.
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/, REPO = /^(?!\.{1,2}$)[a-z0-9._-]{1,100}$/;
const aliases = new Map();

/**
 * The hostname `ssh -G` resolves for an SSH alias, from the owner's SSH config. No network: -G only prints the configuration.
 * Run without a shell, after `--`, with a validated alias. A `Match exec` line in the owner's own config still runs, as for any ssh.
 */
export function sshHostname(alias) {
	if (!HOST.test(alias)) return null;
	if (!aliases.has(alias)) {
		const r = spawnSync("ssh", ["-G", "--", alias], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		aliases.set(alias, r.status === 0 ? (/^hostname (\S+)$/m.exec(r.stdout)?.[1]?.toLowerCase() ?? null) : null);
	}
	return aliases.get(alias);
}

/**
 * `github.com/<owner>/<repo>` (lowercase) for a GitHub origin remote, else null. HTTPS, ssh:// and scp-style forms of one repo give
 * one key; an SSH alias counts only when ssh resolves it to GitHub. Only the key is derived here: profile routing still takes the
 * raw remote through the server's existing rules, so explicit and rule-based routing are unchanged.
 */
export function repoKey(remote, { resolveHost = sshHostname } = {}) {
	if (typeof remote !== "string" || !remote.trim() || remote.length > 512) return null;
	const r = remote.trim();
	let m = /^https:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::443)?\/([^\s]+)$/i.exec(r), ssh = false;
	if (!m) { m = /^ssh:\/\/(?:[^@/\s]+@)?([^/:@\s]+)(?::\d{1,5})?\/([^\s]+)$/i.exec(r); ssh = !!m; }
	if (!m && !r.includes("://")) { m = /^(?:[^@/:\s]+@)?([^/:@\s]+):(?!\/)([^\s]+)$/.exec(r); ssh = !!m; }
	if (!m) return null;
	let host = m[1].toLowerCase();
	if (!HOST.test(host)) return null;
	if (!GITHUB_HOSTS.has(host)) {
		if (!ssh) return null;
		host = resolveHost(host);
		if (!GITHUB_HOSTS.has(host ?? "")) return null;
	}
	const parts = m[2].replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase().split("/");
	if (parts.length !== 2 || !OWNER.test(parts[0]) || !REPO.test(parts[1])) return null;
	return `github.com/${parts[0]}/${parts[1]}`;
}

// ---------- scrub ----------

const HOME = os.homedir(), USER = os.userInfo().username;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SCRUB = [
	[new RegExp(escape(HOME), "g"), "~"],
	[/\/Users\/[A-Za-z0-9._-]+/g, "~"],
	[/(?:\/private)?\/(?:tmp|var\/folders)(?:\/[^\s'"`)\]]*)?(?![\w.-])/g, "<tmp>"],
	[/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, "<email>"],
	// A bare 32-hex value is an account or key id in practice; git object ids (40 or 64 hex) stay.
	[/\b[0-9a-f]{32}\b/g, "<hex32>"],
	// The local user name with any of its separators (a.b, a-b, a_b), also inside a longer login.
	...(USER.length >= 3 ? [[new RegExp(`\\b${USER.split(/[._-]/).map(escape).join("[._-]")}`, "gi"), "<user>"]] : []),
];
/** The client's secret redaction, then the home directory, temp paths, emails, account-like ids and the local user name. */
export const scrub = (s) => SCRUB.reduce((t, [re, to]) => t.replace(re, to), redact(String(s)));

// ---------- command digest ----------

// agent-memory.mjs's PATCH_HEADER: one apply_patch file header; inside a string literal the path ends at an escaped newline or quote.
const PATCH_HEADER = /\*\*\* (?:(?:Add|Update|Delete) File|Move to): ([^\n\r"'`\\]+)/g;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ERRORISH = /error|fail|not found|denied|refused|no such|cannot|can't|could not|couldn't|fatal|unable|missing|not set|required|enoent|econn|traceback|exception|being used for authentication/i;
const WRAPPERS = new Set(["sudo", "command", "exec", "time", "nohup", "xargs"]);

/** The command line as run: a Codex [shell, -c|-lc, script] array gives its script; anything else its joined words. */
// Newlines become "; " in the digest, so a reader still sees where one shell command ended (an exit status is the last one's).
const commandText = (c) => (Array.isArray(c) ? (c.length === 3 && /^-l?c$/.test(c[1]) ? String(c[2]) : c.map(String).join(" ")) : typeof c === "string" ? c : "");

/** The program a command runs, skipping leading `cd` steps, `rtk [proxy]`, `env` options and VAR=value words. Null when unclear. */
export function familyOf(cmd) {
	const seg = cmd.split(/\s*(?:&&|\|\||;|\n)\s*/).find((s) => s.trim() && !/^cd(?:\s|$)/.test(s.trim()));
	const w = (seg ?? "").trim().split(/\s+/);
	let i = 0;
	for (;;) {
		if (w[i] === "rtk") { i += w[i + 1] === "proxy" ? 2 : 1; continue; }
		if (w[i] === "env") { i++; while (w[i] && (/^-/.test(w[i]) || /^[A-Za-z_]\w*=/.test(w[i]))) i += /^-[uSC]$/.test(w[i]) ? 2 : 1; continue; }
		if (/^[A-Za-z_]\w*=/.test(w[i] ?? "") || WRAPPERS.has(w[i])) { i++; continue; }
		break;
	}
	const name = path.basename(w[i] ?? "").toLowerCase();
	return /^[\w.+-]{1,40}$/.test(name) ? name : null;
}

/** At most errLines lines of a failure: error-like lines first, then the first other lines. */
function errorLines(text) {
	const lines = String(text).replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean);
	const picked = lines.filter((l) => ERRORISH.test(l)).slice(0, FACT_LIMITS.errLines);
	for (const l of lines) { if (picked.length >= FACT_LIMITS.errLines) break; if (!picked.includes(l)) picked.push(l); }
	return picked.map((l) => cut(scrub(l)));
}

const idOf = (raw) => sha(String(raw)).slice(0, 12);
const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "");

/**
 * The redacted command digest of some transcript lines (readLines output) of one session in one repo, or null without a repo key.
 *
 * Each command: { id, at, cmd, family, status, exit, err }. id is a hash of the client's call id, so a call and its result pair across
 * incremental reads: pass the session's digest so far as `prior`, then mergeDigest the two. status is only what the transcript records:
 * - "ok": Codex exit_code 0, or a Claude Code Bash result that is not an error, not interrupted and not sent to the background.
 * - "failed": a recorded nonzero exit (Codex exit_code, Claude Code's "Exit code N" error prefix); exit holds it.
 * - "error": an error result with no exit code (refused, blocked, timed out). "unknown": no outcome recorded (interrupted, backgrounded,
 *   a Codex item without exit_code). "pending": the call is in these lines and its result is not yet. Detectors use only ok and failed.
 * exit is the recorded code or null; it is never inferred. Output is kept only as err lines of failed and error results.
 *
 * files: 16-hex hashes of repo_key + ":" + the repo-relative path of each edited file, for the local disjointness check only:
 * editedPaths (Edit, Write, MultiEdit, NotebookEdit, apply_patch calls and Codex file changes) plus apply_patch headers inside Codex
 * shell commands. Paths outside `root` are left out.
 */
export function commandDigest(client, lines, { repoKey: key, session, cwd, root = cwd, prior = null } = {}) {
	if (!key || typeof session !== "string" || !session) return null;
	const earlier = new Set((prior?.commands ?? []).filter((c) => c.status === "pending").map((c) => c.id));
	const patched = [];
	const byId = new Map(), order = [];
	const put = (id, c) => { if (!byId.has(id)) order.push(id); byId.set(id, { ...byId.get(id), ...c }); };
	let first = null, last = null;
	for (const { obj } of lines) {
		const at = typeof obj?.timestamp === "string" ? obj.timestamp : null;
		if (at) { first ??= at; last = at; }
		if (client === "codex") {
			const p = obj?.payload, it = p?.type === "item_completed" ? p.item : null;
			if (obj?.type === "event_msg" && it?.type === "CommandExecution") {
				const cmd = commandText(it.command);
				if (cmd.includes("*** Begin Patch")) for (const h of cmd.matchAll(PATCH_HEADER)) patched.push(h[1].trim());
				put(idOf(it.id ?? `${at}:${cmd}`), { at, cmd, exit: Number.isInteger(it.exit_code) ? it.exit_code : undefined, out: it.aggregated_output ?? "" });
			} else if (obj?.type === "event_msg" && p?.type === "exec_command_end" && Number.isInteger(p.exit_code)) {
				put(idOf(p.call_id ?? `${at}:${commandText(p.command)}`), { at, cmd: commandText(p.command), exit: p.exit_code, out: p.aggregated_output ?? `${p.stdout ?? ""}\n${p.stderr ?? ""}` });
			}
		} else if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) if (b?.type === "tool_use" && b.name === "Bash" && typeof b.input?.command === "string") put(idOf(b.id), { at, cmd: b.input.command, pending: true });
		} else if (obj?.type === "user" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) {
				if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
				const id = idOf(b.tool_use_id);
				// Only Bash results: a call seen in these lines, or one whose result text has the Bash exit prefix.
				const text = resultText(b.content), code = /^Exit code (\d+)/.exec(text);
				if (!byId.has(id) && !earlier.has(id) && !code) continue;
				// toolUseResult describes the line's single tool result; with several results per line it is not attributed.
				const r = obj.message.content.filter((x) => x?.type === "tool_result").length === 1 ? obj.toolUseResult : undefined;
				const undecided = !b.is_error && !(r && typeof r === "object" && !r.interrupted && !r.backgroundTaskId);
				put(id, { pending: false, ok: !b.is_error && !undecided, exit: b.is_error && code ? Number(code[1]) : undefined, out: b.is_error ? text.replace(/^Exit code \d+\n?/, "") : "" });
			}
		}
	}
	const commands = order.map((id) => {
		const c = byId.get(id), cmd = typeof c.cmd === "string" ? cut(scrub(c.cmd).replace(/[ \t]*\r?\n\s*/g, "; ").replace(/\s+/g, " ").trim()) : null;
		const status = c.pending ? "pending" : Number.isInteger(c.exit) ? (c.exit === 0 ? "ok" : "failed")
			: client === "codex" ? "unknown" : c.ok ? "ok" : c.out ? "error" : "unknown";
		return { id, at: c.at ?? null, cmd, family: cmd ? familyOf(cmd) : null, status, exit: Number.isInteger(c.exit) ? c.exit : null, err: status === "failed" || status === "error" ? errorLines(c.out) : [] };
	});
	const base = typeof root === "string" && path.isAbsolute(root) ? root : null;
	const files = new Set();
	for (const f of [...editedPaths(client, lines), ...patched]) {
		if (!base) break;
		const rel = path.relative(base, path.resolve(typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : base, f));
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) files.add(sha(`${key}:${rel.split(path.sep).join("/")}`).slice(0, 16));
	}
	return bound({ v: 1, client, session: `${client}:${sha(session).slice(0, 12)}`, repo: key, started_at: first, ended_at: last, files: [...files].sort(), commands, dropped: 0 });
}

/**
 * Over the command limit, evidence is kept first: every command without an ok status, the 5 commands after each failure (a repair) and the
 * first ok run of each program (so the session still counts as running it); the newest other ok commands fill what is left.
 */
function bound(d) {
	const over = d.commands.length - FACT_LIMITS.commands;
	if (over <= 0) return d;
	const keep = new Set(), seen = new Set();
	d.commands.forEach((c, i) => {
		if (c.status !== "ok") { keep.add(i); if (c.status === "failed") for (let j = i + 1; j <= i + 5 && j < d.commands.length; j++) keep.add(j); }
		else if (c.family && !seen.has(c.family)) { seen.add(c.family); keep.add(i); }
	});
	let order = [...keep].sort((a, b) => a - b).slice(-FACT_LIMITS.commands);
	for (let i = d.commands.length - 1; i >= 0 && order.length < FACT_LIMITS.commands; i--) if (!keep.has(i)) { keep.add(i); order.push(i); }
	order = order.sort((a, b) => a - b);
	return { ...d, commands: order.map((i) => d.commands[i]), dropped: d.dropped + d.commands.length - order.length };
}

/**
 * One session's digest from two digests of it (later lines, or another copy of the same transcript): commands joined by id in first-seen
 * order, a later known field winning over an unknown one, file hashes united, the time span widened, still bounded.
 */
export function mergeDigest(a, b) {
	if (!a) return b;
	if (!b) return a;
	if (a.session !== b.session || a.repo !== b.repo) throw new Error("digest_mismatch");
	const byId = new Map(a.commands.map((c) => [c.id, c]));
	for (const c of b.commands) {
		const p = byId.get(c.id);
		byId.set(c.id, !p ? c : { ...p, ...Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && !(k === "status" && v === "pending") && !(k === "err" && !v.length))) });
	}
	const t = (x, y, pick) => (x && y ? pick(x, y) : x ?? y);
	return bound({ ...a, started_at: t(a.started_at, b.started_at, (x, y) => (x < y ? x : y)), ended_at: t(a.ended_at, b.ended_at, (x, y) => (x > y ? x : y)),
		files: [...new Set([...a.files, ...b.files])].sort(), commands: [...byId.values()], dropped: a.dropped + b.dropped });
}
