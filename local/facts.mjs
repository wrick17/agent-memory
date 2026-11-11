// Repo facts, P0 primitives (#90, #93): the GitHub repo key and the local command digest. Nothing here uploads or calls a model.
// The digest is built from transcript lines on this machine, redacted and bounded; raw command output never leaves this module.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editedPaths, redact, writePrivate } from "./agent-memory.mjs";

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
	// Any user's home: macOS, Linux and Windows.
	[/\/(?:Users|home)\/[A-Za-z0-9._-]+|(?<![\w.-])\/root(?![\w.-])/g, "~"],
	[/\b[A-Za-z]:\\Users\\[^\\\s]+/g, "~"],
	[/(?:\/private)?\/(?:tmp|var\/folders)(?:\/[^\s'"`)\]]*)?(?![\w.-])/g, "<tmp>"],
	// Starts only at the start of a run, so a long run without "@" is scanned once, not once per character.
	[/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, "<email>"],
	// A bare 32-hex value is an account or key id in practice; git object ids (40 or 64 hex) stay.
	[/\b[0-9a-f]{32}\b/g, "<hex32>"],
	// The local user name with any of its separators (a.b, a-b, a_b), also inside a longer login.
	...(USER.length >= 3 ? [[new RegExp(`\\b${USER.split(/[._-]/).map(escape).join("[._-]")}`, "gi"), "<user>"]] : []),
];
/**
 * The shared secret redaction (agent-memory.mjs redact, identical to the server's), then the facts-only rules: the home directory,
 * other users' homes, temp paths, emails, account-like ids and the local user name. Secret references ($VAR, $(cat f)) are kept by
 * redact, and their paths are still scrubbed here.
 */
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

/** The words of a command's first step from its program on, skipping leading `cd` steps, `rtk [proxy]`, `env` options and VAR=value words. */
function programWords(cmd) {
	const seg = cmd.split(/\s*(?:&&|\|\||;|\n)\s*/).find((s) => s.trim() && !/^cd(?:\s|$)/.test(s.trim()));
	const w = (seg ?? "").trim().split(/\s+/);
	let i = 0;
	for (;;) {
		if (w[i] === "rtk") { i += w[i + 1] === "proxy" ? 2 : 1; continue; }
		if (w[i] === "env") { i++; while (w[i] && (/^-/.test(w[i]) || /^[A-Za-z_]\w*=/.test(w[i]))) i += /^-[uSC]$/.test(w[i]) ? 2 : 1; continue; }
		if (/^[A-Za-z_]\w*=/.test(w[i] ?? "") || WRAPPERS.has(w[i])) { i++; continue; }
		break;
	}
	return w.slice(i);
}

/** The program a command runs, skipping leading `cd` steps, `rtk [proxy]`, `env` options and VAR=value words. Null when unclear. */
export function familyOf(cmd) {
	const name = path.basename(programWords(cmd)[0] ?? "").toLowerCase();
	return /^[\w.+-]{1,40}$/.test(name) ? name : null;
}

/**
 * The script a command really runs: `rtk [proxy]`, `env` (with -u NAME, flags and NAME=value words), leading NAME=value words, `time`,
 * `nohup`, `command`, `exec` and a whole-command `sh|bash|zsh|dash|ksh -c '<script>'` are taken off, repeatedly.
 */
export function unwrapCommand(cmd) {
	let c = String(cmd).trim();
	for (let prev = null; prev !== c;) {
		prev = c;
		c = c.replace(/^rtk(?:[ \t]+proxy)?[ \t]+/, "")
			.replace(/^env(?:[ \t]+(?:-u[ \t]+\S+|-[A-Za-z]+|[A-Za-z_]\w*=\S*))*[ \t]+/, "")
			.replace(/^(?:[A-Za-z_]\w*=\S*[ \t]+)+/, "")
			.replace(/^(?:time|nohup|command|exec)[ \t]+/, "");
		const sh = /^(?:\S*\/)?(?:ba|z|da|k)?sh[ \t]+-[A-Za-z]*c[A-Za-z]*[ \t]+(?:'([^']*)'|"((?:\\.|[^"\\])*)")[ \t]*$/.exec(c);
		if (sh) c = (sh[1] ?? sh[2]).trim();
	}
	return c;
}

/**
 * The directory a command runs in: the recorded working directory, then each leading `cd` or `pushd` step of the unwrapped script
 * (unwrapCommand). Null when a step's target is not a plain path (`cd -`, a variable, a glob, a subshell), when there is no absolute
 * directory to start from, or when the rest of the script changes directory again (a later `cd`, `pushd`, `popd`, `git -C`, a
 * subshell `cd`): such a command is ambiguous and is not attributed to any one checkout.
 */
export function runDir(cmd, base) {
	let dir = typeof base === "string" && path.isAbsolute(base) ? base : null;
	const segs = unwrapCommand(cmd).split(/\s*(?:&&|\|\||;|\n)\s*/);
	let i = 0;
	for (; i < segs.length; i++) {
		const m = /^(?:cd|pushd)(?:\s+(.*))?$/.exec(segs[i].trim());
		if (!m) break;
		let a = (m[1] ?? "").trim().replace(/^(?:-[LPe]+\s+)+/, "");
		const q = /^"([^"]*)"$|^'([^']*)'$/.exec(a);
		a = q ? (q[1] ?? q[2]) : a.replace(/\\ /g, " ");
		if (!a || a === "~") { dir = os.homedir(); continue; }
		if (a === "-" || /[$`*?|<>(){}\\]/.test(a) || (!q && /\s/.test(a))) return null;
		a = a.replace(/^~(?=\/)/, os.homedir());
		if (!path.isAbsolute(a) && !dir) return null;
		dir = path.resolve(dir ?? "/", a);
	}
	if (/(?:^|[\s;&|(`])(?:cd|pushd|popd)(?=\s|$|[;&|)])|\bgit[ \t]+(?:\S+[ \t]+)*?-C\b/.test(segs.slice(i).join(" ; "))) return null;
	return dir;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// ---------- pairs and partitions ----------

/** A (remote, path) pair's id: the route cache key. remote is the credential-free origin, path the checkout's git toplevel. */
export const pairId = (remote, top) => sha(`${remote}\n${top}`).slice(0, 16);
/** A partition's id (contract section 1): sha256(profile + "\n" + repo_key)[0:16]. */
export const partitionId = (profile, key) => sha(`${profile}\n${key}`).slice(0, 16);
/** A session's ref, as every report and cache names it: `<client>:<sha256(session id)[0:12]>`. */
export const sessionRef = (client, session) => `${client}:${sha(String(session)).slice(0, 12)}`;
/** The file-name form of a session ref. */
export const refName = (ref) => ref.replace(":", "-");

/**
 * A resolver from a command's directory to its pair: the git toplevel holding it, that checkout's origin remote (credentials removed)
 * and its GitHub key. Each checkout runs git once; a directory that no longer exists, one in no checkout, or a checkout without a
 * GitHub origin gives null (the command is unattributed).
 * @param {{ gitOf?: (dir: string) => { top: string | null, remote: string | null }, safe?: (remote: string) => string }} [o]
 * @returns {(dir: string | null) => { id: string, remote: string, path: string, key: string } | null}
 */
export function pairResolver({ gitOf = gitCheckout, safe = (r) => r } = {}) {
	const byTop = new Map(), byDir = new Map();
	const at = (dir) => {
		if (!fs.existsSync(dir)) return null;
		let t = real(dir);
		while (!fs.existsSync(path.join(t, ".git")) && path.dirname(t) !== t) t = path.dirname(t);
		if (!fs.existsSync(path.join(t, ".git"))) return null;
		if (!byTop.has(t)) {
			const g = gitOf(t), remote = g?.remote ? safe(g.remote) : null, top = g?.top || t, key = remote ? repoKey(remote) : null;
			byTop.set(t, key ? { id: pairId(remote, top), remote, path: top, key } : null);
		}
		return byTop.get(t);
	};
	return (dir) => {
		if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
		if (!byDir.has(dir)) byDir.set(dir, at(dir));
		return byDir.get(dir);
	};
}
// The background run only (SessionStart resolves asynchronously within its own deadline): a loaded machine can take seconds to start
// a process, and a timed-out lookup would mark the checkout's commands unattributed.
const RUN_GIT_TIMEOUT_MS = 30_000;
function gitCheckout(dir) {
	const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: RUN_GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
	const top = git("rev-parse", "--show-toplevel"), remote = git("remote", "get-url", "origin");
	return { top: top.status === 0 ? top.stdout.trim() : null, remote: remote.status === 0 ? remote.stdout.trim() : null };
}
/** The pair of an edited file: the resolver at its nearest existing directory. */
const fileDir = (f) => { let d = path.dirname(f); while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d); return d; };

/** A recorded working directory: a path, or a file:// URL as Codex items give it. */
const dirOf = (v) => { if (typeof v !== "string" || !v) return null; if (/^file:\/\//i.test(v)) { try { return fileURLToPath(v); } catch { return null; } } return path.isAbsolute(v) ? v : null; };

/** At most errLines lines of a failure: error-like lines first, then the first other lines. */
function errorLines(text) {
	// The whole output is scrubbed before it is split: a multi-line secret such as a private-key block is only recognized whole.
	const lines = scrub(String(text).replace(ANSI, "")).split("\n").map((l) => l.trim()).filter(Boolean);
	const picked = lines.filter((l) => ERRORISH.test(l)).slice(0, FACT_LIMITS.errLines);
	for (const l of lines) { if (picked.length >= FACT_LIMITS.errLines) break; if (!picked.includes(l)) picked.push(l); }
	return picked.map((l) => cut(l));
}

const idOf = (raw) => sha(String(raw)).slice(0, 12);
const resultText = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "");

/** Most edited-file hashes a pair keeps; past the report cap (32) the set is only "too many", sent as unknown. */
const FILES_KEPT = 33;

/**
 * The redacted command digest of some transcript lines (readLines output) of one session, with every command attributed to its pair.
 *
 * Each command: { id, at, cmd, family, status, exit, err, pair }. id is a hash of the client's call id, so a call and its result pair
 * across incremental reads: pass the session's digest so far as `prior`, then mergeDigest the two. status is only what the transcript
 * records:
 * - "ok": Codex exit_code 0, or a Claude Code Bash result that is not an error, not interrupted and not sent to the background.
 * - "failed": a recorded nonzero exit (Codex exit_code, Claude Code's "Exit code N" error prefix); exit holds it.
 * - "error": an error result with no exit code (refused, blocked, timed out). "unknown": no outcome recorded (interrupted, backgrounded,
 *   a Codex item without exit_code). "pending": the call is in these lines and its result is not yet. Detectors use only ok and failed.
 * exit is the recorded code or null; it is never inferred. Output is kept only as err lines of failed and error results.
 *
 * pair: the pair id of the directory the command ran in (the line's recorded cwd, else `cwd`, then its leading `cd` steps; runDir),
 * from `pairAt` (pairResolver). pairs maps each id to { remote, path, key }. A command whose pair cannot be established is left out
 * and its id kept in `other` (unattributed), so its result in later lines is not taken up either. Without pairAt, every command is
 * attributed to the one pair { repoKey, root }.
 *
 * files: per pair id, 16-hex hashes of repo_key + ":" + the repo-relative path of each edited file (at most FILES_KEPT): editedPaths
 * (Edit, Write, MultiEdit, NotebookEdit, apply_patch calls and Codex file changes) plus apply_patch headers inside shell commands,
 * relative paths resolved against `cwd`, each in the pair of its own directory.
 */
export function commandDigest(client, lines, { repoKey: key = null, session, cwd, root = cwd, prior = null, pairAt = null } = {}) {
	if (typeof session !== "string" || !session) return null;
	const top = typeof root === "string" && path.isAbsolute(root) ? root : null;
	const fixed = key ? { id: pairId(key, top ?? ""), remote: key, path: top, key } : null;
	if (!pairAt && !fixed) return null;
	const pairs = { ...(prior?.pairs ?? {}) };
	const resolve = (dir) => { const p = pairAt ? pairAt(dir) : fixed; if (p) pairs[p.id] ??= { remote: p.remote, path: p.path, key: p.key }; return p; };
	const earlier = new Set((prior?.commands ?? []).filter((c) => c.status === "pending").map((c) => c.id));
	const other = new Set(prior?.other ?? []);
	// The command's pair id, or null (and the id kept in other) when its pair cannot be established.
	const pairOf = (id, cmd, recorded) => {
		if (other.has(id)) return null;
		const p = resolve(runDir(cmd, dirOf(recorded) ?? cwd));
		if (!p) other.add(id);
		return p?.id ?? null;
	};
	// apply_patch headers inside a shell command, read from the original command text (before any newline compaction or cut).
	const patched = [], patchHeaders = (cmd, dir) => { if (cmd.includes("*** Begin Patch")) for (const h of cmd.matchAll(PATCH_HEADER)) patched.push([h[1].trim(), dir]); };
	const byId = new Map(), order = [];
	const put = (id, c) => { if (!byId.has(id)) order.push(id); byId.set(id, { ...byId.get(id), ...c }); };
	let first = null, last = null;
	for (const { obj } of lines) {
		const at = typeof obj?.timestamp === "string" ? obj.timestamp : null;
		if (at) { first ??= at; last = at; }
		if (client === "codex") {
			const p = obj?.payload, it = p?.type === "item_completed" ? p.item : null;
			if (obj?.type === "event_msg" && it?.type === "CommandExecution") {
				const cmd = commandText(it.command), id = idOf(it.id ?? `${at}:${cmd}`), pair = pairOf(id, cmd, it.cwd);
				if (!pair) continue;
				patchHeaders(cmd, runDir(cmd, dirOf(it.cwd) ?? cwd));
				put(id, { at, cmd, pair, exit: Number.isInteger(it.exit_code) ? it.exit_code : undefined, out: it.aggregated_output ?? "" });
			} else if (obj?.type === "event_msg" && p?.type === "exec_command_end" && Number.isInteger(p.exit_code)) {
				const cmd = commandText(p.command), id = idOf(p.call_id ?? `${at}:${cmd}`), pair = pairOf(id, cmd, p.cwd);
				if (!pair) continue;
				patchHeaders(cmd, runDir(cmd, dirOf(p.cwd) ?? cwd));
				put(id, { at, cmd, pair, exit: p.exit_code, out: p.aggregated_output ?? `${p.stdout ?? ""}\n${p.stderr ?? ""}` });
			}
		} else if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) {
				if (b?.type !== "tool_use" || b.name !== "Bash" || typeof b.input?.command !== "string") continue;
				const pair = pairOf(idOf(b.id), b.input.command, obj.cwd);
				// A call line seen again after its result (a rewritten or replayed transcript) never makes the command pending again.
				if (pair) put(idOf(b.id), { at, cmd: b.input.command, pair, ...(byId.get(idOf(b.id))?.pending === false ? {} : { pending: true }) });
			}
		} else if (obj?.type === "user" && Array.isArray(obj.message?.content)) {
			for (const b of obj.message.content) {
				if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
				const id = idOf(b.tool_use_id);
				if (other.has(id)) continue;
				// Only Bash results of calls seen in these lines or pending from earlier ones; a result alone has no directory to attribute.
				if (!byId.has(id) && !earlier.has(id)) continue;
				const text = resultText(b.content), code = /^Exit code (\d+)/.exec(text);
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
		return { id, at: c.at ?? null, cmd, family: cmd ? familyOf(cmd) : null, status, exit: Number.isInteger(c.exit) ? c.exit : null,
			err: status === "failed" || status === "error" ? errorLines(c.out) : [], ...(c.pair ? { pair: c.pair } : {}) };
	});
	const files = {};
	const base = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : typeof root === "string" && path.isAbsolute(root) ? root : null;
	for (const [f, dir] of [...editedPaths(client, lines).map((f) => [f, null]), ...patched]) {
		const from = dir ?? base;
		if (!from && !path.isAbsolute(f)) continue;
		const abs = path.resolve(from ?? "/", f), p = pairAt ? resolve(fileDir(abs)) : fixed;
		if (!p?.path) continue;
		// The checkout path is git's (symlinks resolved); a recorded path may not be, so it is compared both ways.
		const plain = path.relative(p.path, abs), rel = plain.startsWith("..") ? path.relative(p.path, path.join(real(fileDir(abs)), path.relative(fileDir(abs), abs))) : plain;
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		const set = (files[p.id] ??= []), h = sha(`${p.key}:${rel.split(path.sep).join("/")}`).slice(0, 16);
		if (!set.includes(h) && set.length < FILES_KEPT) set.push(h);
	}
	for (const id of Object.keys(files)) files[id].sort();
	return bound({ v: 2, client, session: sessionRef(client, session), started_at: first, ended_at: last, pairs, files, commands, dropped: {},
		...(other.size ? { other: [...other].slice(-FACT_LIMITS.commands) } : {}) });
}

/**
 * Over the command limit, evidence is kept first: every command without an ok status, the 5 commands after each failure (a repair) and the
 * first ok run of each program (so the session still counts as running it); the newest other ok commands fill what is left. dropped counts
 * the left-out commands per pair, so command totals stay whole.
 */
function bound(d) {
	const over = d.commands.length - FACT_LIMITS.commands;
	if (over <= 0) return d;
	const keep = new Set(), seen = new Set();
	d.commands.forEach((c, i) => {
		if (c.status !== "ok") { keep.add(i); if (c.status === "failed") for (let j = i + 1; j <= i + 5 && j < d.commands.length; j++) keep.add(j); }
		else if (c.family && !seen.has(`${c.pair}\n${c.family}`)) { seen.add(`${c.pair}\n${c.family}`); keep.add(i); }
	});
	let order = [...keep].sort((a, b) => a - b).slice(-FACT_LIMITS.commands);
	for (let i = d.commands.length - 1; i >= 0 && order.length < FACT_LIMITS.commands; i--) if (!keep.has(i)) { keep.add(i); order.push(i); }
	order = order.sort((a, b) => a - b);
	const kept = new Set(order), dropped = { ...d.dropped };
	d.commands.forEach((c, i) => { if (!kept.has(i)) dropped[c.pair ?? "-"] = (dropped[c.pair ?? "-"] ?? 0) + 1; });
	return { ...d, commands: order.map((i) => d.commands[i]), dropped };
}

/**
 * One session's digest from two digests of it (later lines, or another copy of the same transcript): commands joined by id in first-seen
 * order, a later known field winning over an unknown one, pairs and file hashes united, the time span widened, still bounded.
 */
export function mergeDigest(a, b) {
	if (!a) return b;
	if (!b) return a;
	if (a.session !== b.session) throw new Error("digest_mismatch");
	const byId = new Map(a.commands.map((c) => [c.id, c]));
	for (const c of b.commands) {
		const p = byId.get(c.id);
		byId.set(c.id, !p ? c : { ...p, ...Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && !(k === "status" && v === "pending") && !(k === "err" && !v.length))) });
	}
	const files = { ...a.files };
	for (const [id, hs] of Object.entries(b.files ?? {})) files[id] = [...new Set([...(files[id] ?? []), ...hs])].sort().slice(0, FILES_KEPT);
	const dropped = { ...a.dropped };
	for (const [id, n] of Object.entries(b.dropped ?? {})) dropped[id] = (dropped[id] ?? 0) + n;
	const other = [...new Set([...(a.other ?? []), ...(b.other ?? [])])].slice(-FACT_LIMITS.commands);
	const t = (x, y, pick) => (x && y ? pick(x, y) : x ?? y);
	return bound({ ...a, started_at: t(a.started_at, b.started_at, (x, y) => (x < y ? x : y)), ended_at: t(a.ended_at, b.ended_at, (x, y) => (x > y ? x : y)),
		pairs: { ...a.pairs, ...b.pairs }, files, commands: [...byId.values()], dropped, ...(other.length ? { other } : {}) });
}

/**
 * One partition's slice of a session digest: its pairs' commands, file hashes (null when more than 32 or unknown), and commands
 * dropped by the bound. This is what detectors, the report and synthesis read; v and the fields digestText reads stay as they were.
 * @param {object} d a session digest @param {string[]} ids the partition's pair ids @param {string} key its repo key
 */
export function sliceDigest(d, ids, key) {
	const set = new Set(ids), commands = d.commands.filter((c) => set.has(c.pair));
	const hashes = [...new Set(ids.flatMap((id) => d.files?.[id] ?? []))].sort();
	const ats = commands.map((c) => c.at).filter(Boolean).sort();
	return { v: 2, client: d.client, session: d.session, repo: key, started_at: ats[0] ?? d.started_at ?? null, ended_at: ats.at(-1) ?? d.ended_at ?? null,
		files: hashes.length > 32 ? null : hashes, commands, dropped: ids.reduce((n, id) => n + (d.dropped?.[id] ?? 0), 0) };
}

// ---------- usage ----------

const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
/**
 * A session's cache-aware token use, carried across incremental reads in `prior` ({ total, recent }). Claude Code repeats one message's
 * usage on each of its lines, so the latest line of a message id replaces that message's earlier count (the newest 32 ids are
 * remembered). Codex token_count events carry running totals, so the newest one wins. input includes cached_input and cache_write
 * (contract section 2).
 * @returns {{ total: { input: number, cached_input: number, output: number, cache_write: number }, recent: [string, object][] } | null}
 */
export function usageOf(client, lines, prior = null) {
	let total = prior?.total ? { ...prior.total } : null;
	const recent = new Map(Array.isArray(prior?.recent) ? prior.recent : []);
	const add = (u, sign) => { for (const k of ["input", "cached_input", "output", "cache_write"]) total[k] += sign * u[k]; };
	for (const { obj } of lines) {
		if (client === "codex") {
			const t = obj?.type === "event_msg" && obj.payload?.type === "token_count" ? obj.payload.info?.total_token_usage : null;
			if (t && typeof t === "object") total = { input: n(t.input_tokens), cached_input: n(t.cached_input_tokens), output: n(t.output_tokens), cache_write: n(t.cache_write_input_tokens) };
		} else if (obj?.type === "assistant" && obj.message?.usage && typeof obj.message.usage === "object" && !obj.isSidechain) {
			const u = obj.message.usage, id = typeof obj.message.id === "string" ? obj.message.id : null;
			const c = { input: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), cached_input: n(u.cache_read_input_tokens), output: n(u.output_tokens), cache_write: n(u.cache_creation_input_tokens) };
			total ??= { input: 0, cached_input: 0, output: 0, cache_write: 0 };
			if (id && recent.has(id)) add(recent.get(id), -1);
			add(c, 1);
			if (id) { recent.delete(id); recent.set(id, c); if (recent.size > 32) recent.delete(recent.keys().next().value); }
		}
	}
	return total ? { total, recent: [...recent] } : null;
}

// ---------- local partition store (shared by the run and the SessionStart hook) ----------

/** Files under <home>/facts. The hook writes only routes/, dirs/, p/<id>/meta.json, p/<id>/seen/ and inject/; the run lock holder writes the rest. */
export const factsPath = (home, ...p) => path.join(home, "facts", ...p);
/** The cached route of a pair: { remote, path, repo_key, profile, routed_by, at }, learned from a fact-route reply. */
export const routeFile = (home, pair) => factsPath(home, "routes", `${pair}.json`);
export const partitionDir = (home, part, ...p) => factsPath(home, "p", part, ...p);
/** A working directory's resolved pair, so SessionStart runs no git when the directory is known: { cwd, remote, path, key, at }. */
export const dirFile = (home, cwd) => factsPath(home, "dirs", `${sha(String(cwd)).slice(0, 16)}.json`);
/** How long a cached directory resolution is used at SessionStart; the run refreshes it for every session it observes. */
export const DIR_TTL_MS = 7 * 86_400_000;
/** Caches a directory's pair (written by the run for each session's start directory and by SessionStart after a git lookup). */
export const rememberDir = (home, cwd, pair) => { if (typeof cwd === "string" && pair?.key && pair.path && pair.remote) writePrivate(dirFile(home, cwd), JSON.stringify({ cwd, remote: pair.remote, path: pair.path, key: pair.key, at: new Date().toISOString() })); };
/**
 * This machine's id (32 lowercase hex, random, never derived from host or user; src/api.ts MACHINE), sent on every v2 report and
 * session-start read so the server keys per-device fact lanes by machine, not by token (the job and read tokens are different devices). Created once, exclusively
 * (link of a finished file), so the hook and the run can never create two different ids.
 */
export function machineId(home) {
	const file = factsPath(home, "machine"), ok = (v) => (/^[0-9a-f]{32}$/.test(v ?? "") ? v : null);
	const read = () => { try { return ok(fs.readFileSync(file, "utf8").trim()); } catch { return null; } };
	const have = read();
	if (have) return have;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, randomBytes(16).toString("hex"), { mode: 0o600 });
	try { fs.linkSync(tmp, file); } catch (e) { if (e?.code !== "EEXIST") throw e; if (!read()) fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
	return read();
}

/** A routed profile name (the server's PROFILE_NAME); `me` never holds repo facts. */
export const PROFILE_RE = /^[a-z][a-z0-9-]{0,11}$/;
export const routedProfile = (p) => (typeof p === "string" && PROFILE_RE.test(p) && p !== "me" ? p : null);

/**
 * Caches a pair's routed profile from a fact-route reply and names the partition it routes to. Returns the partition id, or null when the
 * reply names no usable profile. p/<id>/meta.json says which (profile, repo_key) a partition is and the last pair that routed to it.
 * @param {string} home @param {{ id: string, remote: string, path: string, key: string }} pair @param {{ profile?: string, routed_by?: string }} reply
 */
export function rememberRoute(home, pair, reply) {
	const profile = routedProfile(reply?.profile);
	if (!profile || !pair?.id || !pair.key) return null;
	const at = new Date().toISOString(), part = partitionId(profile, pair.key);
	// A changed profile (a routing rule changed) is kept as moved_from until the run moves this pair's evidence (facts-client).
	let old = null;
	try { old = JSON.parse(fs.readFileSync(routeFile(home, pair.id), "utf8")); } catch { /* first route */ }
	const from = old?.moved_from ?? (routedProfile(old?.profile) && old.profile !== profile && old.repo_key === pair.key ? partitionId(old.profile, pair.key) : null);
	writePrivate(routeFile(home, pair.id), JSON.stringify({ remote: pair.remote, path: pair.path, repo_key: pair.key, profile, routed_by: typeof reply.routed_by === "string" ? reply.routed_by : null, at,
		...(from && from !== part ? { moved_from: from } : {}) }));
	writePrivate(partitionDir(home, part, "meta.json"), JSON.stringify({ profile, repo_key: pair.key, remote: pair.remote, path: pair.path, at }));
	return part;
}

/**
 * Saves what a session-start read gave a partition, keyed by session (contract section 2): facts by fact_key (with detector and literal
 * when the reply has them, so the session's report can count them) and briefing memories by memory_id. At most 16 items. pair: the
 * (remote, path) pair id the read was for, so a later routing change moves only that pair's evidence.
 * @param {string} home @param {string} part partition id @param {string} ref session ref @param {object[]} items reply items @param {string | null} [pair]
 */
export function saveInjected(home, part, ref, items, pair = null) {
	const hex16 = /^[0-9a-f]{16}$/, out = [];
	for (const it of Array.isArray(items) ? items : []) {
		const kind = it?.kind ?? (it?.fact_key ? "fact" : null);
		if (kind === "fact") {
			const fact_key = it.fact_key ?? it.id;
			if (!hex16.test(fact_key ?? "")) continue;
			out.push({ kind, fact_key, ...(typeof it.detector === "string" && typeof it.literal === "string" ? { detector: it.detector, literal: it.literal } : {}), ...(it.signature && typeof it.signature === "object" ? { signature: it.signature } : {}) });
		} else if (kind === "memory") {
			const memory_id = it.memory_id ?? it.id;
			if (typeof memory_id === "string" && memory_id.length >= 1 && memory_id.length <= 128) out.push({ kind, memory_id });
		}
		if (out.length >= 16) break;
	}
	writePrivate(partitionDir(home, part, "seen", `${refName(ref)}.json`), JSON.stringify({ session: ref, ...(pair ? { pair } : {}), at: new Date().toISOString(), items: out }));
}
