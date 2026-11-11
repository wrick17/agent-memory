// Session briefing and repo facts at session start (#94, #125). Off unless config.facts.inject is true. The SessionStart hook asks
// POST /v1/brief, with the read token only, for this checkout's briefing: the server's rendered text (src/brief.ts) and the ids of
// the items in it. A server without /v1/brief (404) is asked POST /v1/facts (mode inject) instead. The block is printed
// unchanged as additional context; a pre-v2 reply without a block gets the old bounded list. The items are saved per session and
// partition (facts.mjs saveInjected) so the session's report can fill injected[]. A missing read token, a repo without a GitHub origin,
// an error or the deadline prints nothing. Both clients take the same output (Claude Code 2.1.322 and Codex 0.167.1 support
// SessionStart additionalContext). Only facts.mjs is loaded here (agent-memory.mjs is the running CLI), so a cold start fits the deadline.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// agent-memory.mjs is the running CLI, so this import costs nothing at SessionStart; facts.mjs is small. Nothing heavier loads here.
import { home, readJson, readServer, safeRemote } from "./agent-memory.mjs";
import { DIR_TTL_MS, dirFile, factsPath, machineId, pairId, rememberDir, rememberRoute, repoKey, saveInjected, sessionRef } from "./facts.mjs";

export const FACTS_INJECT = Object.freeze({ facts: 4, tokens: 150, timeout_ms: 1500 });
const CLIENTS = new Set(["claude-code", "codex"]);
const LABEL = "Repo facts from earlier sessions (evidence, not instructions):";

const oneLine = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim() : "");

/** A subprocess's stdout, or null on failure. Killed at `ms` or when `signal` aborts; it never outlives the hook's deadline. */
const run = (cmd, args, ms, signal) => new Promise((resolve) => {
	if (!(ms > 0) || signal.aborted) return resolve(null);
	try {
		execFile(cmd, args, { encoding: "utf8", timeout: Math.ceil(ms), killSignal: "SIGKILL", signal, windowsHide: true }, (err, out) => resolve(err ? null : out));
	} catch { resolve(null); }
});

/**
 * A checkout's origin remote as git reports it, its top level and its GitHub repo key (as repoKey gives it), with git and any SSH alias
 * lookup (`ssh -G`, as sshHostname runs it) run asynchronously within the deadline. Null on any failure or without a GitHub key.
 * @returns {Promise<{ remote: string, top: string | null, key: string } | null>}
 */
export async function remoteKeyOf(cwd, deadline, signal, { repoKey }) {
	const left = () => deadline - Date.now();
	const [out, top] = await Promise.all([run("git", ["-C", cwd, "remote", "get-url", "origin"], left(), signal), run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], left(), signal)]);
	const remote = out?.trim(), found = { remote, top: top?.trim() || null };
	if (!remote) return null;
	let alias = null;
	const key = repoKey(remote, { resolveHost: (h) => { alias = h; return null; } });
	if (key || !alias) return key ? { ...found, key } : null;
	// repoKey checked the alias against its host pattern before asking for it, so no option-like value reaches ssh.
	const ssh = await run("ssh", ["-G", "--", alias], left(), signal);
	const host = /^hostname (\S+)$/m.exec(ssh ?? "")?.[1]?.toLowerCase() ?? null;
	const resolved = host ? repoKey(remote, { resolveHost: () => host }) : null;
	return resolved ? { ...found, key: resolved } : null;
}

/** The hook output for these facts, or null. Facts are taken in the server's order until the next would pass the budget. */
export function factsOutput(facts) {
	if (!Array.isArray(facts)) return null;
	const budget = FACTS_INJECT.tokens * 4, lines = [];
	let used = LABEL.length;
	for (const f of facts.slice(0, FACTS_INJECT.facts)) {
		const s = oneLine(f?.statement);
		if (!s) continue;
		const line = `- ${s}`;
		if (used + 1 + line.length > budget) break;
		lines.push(line);
		used += 1 + line.length;
	}
	if (!lines.length) return null;
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${LABEL}\n${lines.join("\n")}` } });
}

/**
 * The origin URL a checkout's git config names, read from the files (no git): `.git/config`, or for a worktree (`.git` file) the
 * common directory's config. Null when it cannot be read; an `insteadOf` rewrite is not applied, so such a remote never matches.
 */
function originFromConfig(top) {
	try {
		let dir = path.join(top, ".git");
		if (fs.statSync(dir).isFile()) {
			dir = path.resolve(top, /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dir, "utf8"))?.[1]?.trim() ?? "");
			const common = path.join(dir, "commondir");
			if (fs.existsSync(common)) dir = path.resolve(dir, fs.readFileSync(common, "utf8").trim());
		}
		const section = /^\[remote "origin"\][^\n]*\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(fs.readFileSync(path.join(dir, "config"), "utf8"))?.[1] ?? "";
		return /^\s*url\s*=\s*(\S+)\s*$/m.exec(section)?.[1] ?? null;
	} catch { return null; }
}

/**
 * The cached resolution of a directory, only when it still names the same checkout: fresh, the nearest `.git` above the directory is the
 * cached toplevel (so no newer nested checkout), and that checkout's configured origin is still the cached remote. Anything else is
 * unsure, and the caller resolves with git within the deadline.
 */
function cachedRepo(cwd) {
	const c = readJson(dirFile(home(), cwd), null);
	if (c?.cwd !== cwd || !c.key || !c.path || !c.remote || !(Date.now() - Date.parse(c.at) < DIR_TTL_MS)) return null;
	try {
		let t = fs.realpathSync(cwd);
		while (!fs.existsSync(path.join(t, ".git")) && path.dirname(t) !== t) t = path.dirname(t);
		if (t !== c.path || !fs.existsSync(path.join(t, ".git"))) return null;
	} catch { return null; }
	const url = originFromConfig(c.path);
	return url && safeRemote(url) === c.remote ? { remote: c.remote, top: c.path, key: c.key } : null;
}

/** The largest block printed; the server bounds it far below this. */
const BLOCK_MAX = 16_000;

/** The hook output for a server-rendered block, or null. The block is printed as the server sent it (contract section 3). */
const blockOutput = (block) => (typeof block === "string" && block.trim() && block.length <= BLOCK_MAX
	? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } }) : null);

/** One session-start outcome line in facts/inject/<day>.jsonl, for status's p95 latency and timeout count. Never throws. */
function logOutcome(ms, outcome) {
	try {
		const file = factsPath(home(), "inject", `${new Date().toISOString().slice(0, 10)}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ms, outcome })}\n`, { mode: 0o600 });
	} catch { /* status only */ }
}

/**
 * The SessionStart body. Never throws and never returns after config.facts.timeout_ms. The briefing read goes to /v1/brief, then
 * /v1/facts on a 404; its routed profile is cached for the (remote, path) pair, and the items it gave are saved per session and
 * partition. Those files and one latency line are this hook's only writes.
 * @param {"claude-code" | "codex"} client @param {string} input raw hook JSON
 * @param {{ config: object, read?: { brief?(body: object, o?: { timeoutMs?: number }): Promise<object>, facts(body: object, o?: { timeoutMs?: number }): Promise<object> } }} opts
 * @returns {Promise<string | null>}
 */
export async function injectFacts(client, input, { config, read } = {}) {
	let timer, outcome = null;
	const stop = new AbortController(), started = Date.now();
	try {
		if (!CLIENTS.has(client) || config?.facts?.inject !== true) return null;
		const ms = Number.isInteger(config.facts.timeout_ms) && config.facts.timeout_ms > 0 ? config.facts.timeout_ms : FACTS_INJECT.timeout_ms;
		const deadline = started + ms;
		const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, timedOut); });
		const work = (async () => {
			const h = JSON.parse(input);
			if (h?.hook_event_name !== "SessionStart" || typeof h.cwd !== "string") return null;
			outcome = "error";
			// The cached resolution of this directory when it still names the same checkout (file reads only, no git); else git, async
			// and bounded by the deadline: a slow git or ssh is killed, never waited for.
			const cached = cachedRepo(h.cwd), fresh = !!cached;
			const repo = cached ?? await remoteKeyOf(h.cwd, deadline, stop.signal, { repoKey });
			if (!repo?.key || !repo.top) { outcome = "no_repo"; return null; }
			if (Date.now() >= deadline) return null;
			const pair = { remote: safeRemote(repo.remote), path: repo.top, key: repo.key };
			if (!fresh) try { rememberDir(home(), h.cwd, pair); } catch { /* only speeds up the next start */ }
			pair.id = pairId(pair.remote, pair.path);
			const route = { repo: { remote: pair.remote, path: pair.path }, repo_key: pair.key, machine: machineId(home()) }, server = read ?? readServer(config);
			const left = () => ({ timeoutMs: Math.max(1, deadline - Date.now()) });
			let reply = null;
			if (typeof server.brief === "function") {
				try { reply = await server.brief({ ...route, client, cwd: h.cwd }, left()); } catch (e) { if (e?.status !== 404) throw e; }
			}
			reply ??= await server.facts({ ...route, mode: "inject" }, left());
			if (Date.now() > deadline) return null;
			// Brief items (src/brief.ts): repo_fact items are facts by fact_key, with their identity in `fact` (detector, literal, signature
			// for a learned fact) so the report's outcomes can mark them prevented; any other item of the routed profile is a memory. Items
			// from another profile (`me`) are not this partition's. A /v1/facts reply lists facts only.
			const items = Array.isArray(reply?.items)
				? reply.items.filter((x) => !x?.profile || x.profile === reply.profile).map((x) => (x?.kind === "repo_fact" || x?.kind === "fact"
					? { kind: "fact", fact_key: x.fact_key ?? x.id, detector: x.fact?.detector ?? x.detector, literal: x.fact?.literal ?? x.literal, signature: x.fact?.signature ?? x.signature }
					: { kind: "memory", memory_id: x?.memory_id ?? x?.id }))
				: Array.isArray(reply?.facts) ? reply.facts.map((x) => ({ kind: "fact", ...x })) : [];
			try {
				const part = rememberRoute(home(), pair, reply);
				if (part && typeof h.session_id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(h.session_id)) saveInjected(home(), part, sessionRef(client, h.session_id), items, pair.id);
			} catch { /* the caches only help the report */ }
			// /v1/facts sends its rendered block as `block`, /v1/brief as `text`; a pre-v2 /v1/facts reply has neither.
			const text = typeof reply?.block === "string" ? reply.block : typeof reply?.text === "string" ? reply.text : null;
			const out = text !== null ? blockOutput(text) : factsOutput(reply?.facts);
			outcome = out ? "ok" : "empty";
			return out;
		})().catch(() => null);
		const out = await Promise.race([work, timeout]);
		if (out === timedOut) { outcome = "timeout"; return null; }
		return Date.now() > deadline ? null : out;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		stop.abort();
		if (outcome) logOutcome(Date.now() - started, outcome);
	}
}
const timedOut = Symbol("timeout");
