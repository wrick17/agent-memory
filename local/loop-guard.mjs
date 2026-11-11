// Rule-based loop nudge (#102). Deterministic: no model call and no network. observe() and scan() are pure; loopHook() is the
// PostToolUse / PostToolUseFailure hook, which keeps each session's state in a private file between hook processes. The note is
// fixed text with counts and a sanitized tool name only, so no tool input or output, which may hold untrusted instructions or
// secrets, ever reaches the agent through it. The state holds hashes and counts, never raw text or the hook payload.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { home, loadConfig, readJson, writePrivate } from "./agent-memory.mjs";

/**
 * Thresholds. repeat: the same invocation failing with the same normalized error this many times in one turn. errors: this
 * many failed results among the last `window` results of the turn, so scattered errors in a long productive turn never reach
 * it, while a stretch of nearly all failures does even when each command differs. keys: distinct failing invocations kept.
 */
export const LOOP_GUARD = Object.freeze({ repeat: 3, window: 10, errors: 8, keys: 200 });

/** @typedef {{ turn: string, tool: string, input?: unknown, output?: unknown, failed: boolean }} ToolOutcome */
/** @typedef {{ v: 1, turn: string, nudged: boolean, recent: number[], fails: Record<string, { out: string, n: number }> }} GuardState */

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Keys sorted at every level, so the same arguments in another order are the same invocation. */
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
	: v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
	: JSON.stringify(v) ?? "null";

/** What the tool was asked to do: the command line for shells (ignoring descriptions and timeouts), else all arguments. */
function invocation(input) {
	if (typeof input === "string") { try { input = JSON.parse(input); } catch { return input.replace(/\s+/g, " ").trim(); } }
	const cmd = input && typeof input === "object" && !Array.isArray(input) ? input.command ?? input.cmd : undefined;
	if (Array.isArray(cmd)) return (cmd.length === 3 && /^-l?c$/.test(cmd[1]) ? String(cmd[2]) : cmd.join(" ")).replace(/\s+/g, " ").trim();
	if (typeof cmd === "string") return cmd.replace(/\s+/g, " ").trim();
	return stable(input ?? null);
}

/** The error as a fingerprint: digit runs (times, pids, durations) and whitespace runs folded, the first 64 KB only. */
function fingerprint(output) {
	const s = typeof output === "string" ? output : stable(output ?? null);
	return hash(s.slice(0, 65536).replace(/\d+/g, "#").replace(/\s+/g, " ").trim());
}

const fresh = (turn) => ({ v: 1, turn, nudged: false, recent: [], fails: {} });
const valid = (s) => s && s.v === 1 && typeof s.turn === "string" && typeof s.nudged === "boolean" && Array.isArray(s.recent)
	&& s.fails && typeof s.fails === "object" && !Array.isArray(s.fails);
const toolName = (t) => (typeof t === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(t) ? t : "a tool");

const NOTES = {
	repeat: (tool) => `Loop guard (local rule, not the user): ${tool} has failed ${LOOP_GUARD.repeat} times in this turn with the same input and the same error. Stop repeating it. Read the error, then change the approach or ask the user.`,
	errors: () => `Loop guard (local rule, not the user): ${LOOP_GUARD.errors} of the last ${LOOP_GUARD.window} tool calls in this turn failed. Pause, check what is failing and why, then change the approach or ask the user.`,
};

/**
 * Folds one tool result into the turn's state and returns the note to show, at most once per turn.
 * A new `turn` starts a new state. Without a turn id there is no per-turn limit to keep, so nothing fires.
 * With `enabled: false` it returns the state unchanged and never a note.
 * @param {GuardState | null | undefined} state the previous return value, or null; anything malformed starts afresh
 * @param {ToolOutcome} outcome @param {{ enabled?: boolean }} [opts]
 * @returns {{ state: GuardState | null, note: string | null, reason: "repeat" | "errors" | null }}
 */
export function observe(state, outcome, { enabled = true } = {}) {
	const turn = outcome?.turn;
	if (enabled !== true || typeof turn !== "string" || !turn) return { state: state ?? null, note: null, reason: null };
	const s = valid(state) && state.turn === turn ? structuredClone(state) : fresh(turn);
	const failed = outcome.failed === true;
	s.recent = [...s.recent, failed ? 1 : 0].slice(-LOOP_GUARD.window);
	const key = hash(`${typeof outcome.tool === "string" ? outcome.tool : ""}\0${invocation(outcome.input)}`);
	let reason = null;
	if (!failed) delete s.fails[key]; // the same invocation succeeding is progress
	else {
		const out = fingerprint(outcome.output), prior = s.fails[key];
		delete s.fails[key]; // re-inserted last, so the oldest key is the one dropped at the cap
		s.fails[key] = { out, n: prior?.out === out ? prior.n + 1 : 1 };
		const keys = Object.keys(s.fails);
		if (keys.length > LOOP_GUARD.keys) delete s.fails[keys[0]];
		if (s.fails[key].n >= LOOP_GUARD.repeat) reason = "repeat";
		else if (s.recent.reduce((a, b) => a + b, 0) >= LOOP_GUARD.errors) reason = "errors";
	}
	if (!reason || s.nudged) return { state: s, note: null, reason: null };
	s.nudged = true;
	return { state: s, note: reason === "repeat" ? NOTES.repeat(toolName(outcome.tool)) : NOTES.errors(), reason };
}

/**
 * Runs the rules over a transcript read by readFull (transcript-full.mjs), for evaluation. Each prompt event starts a turn;
 * a result pairs with the oldest unanswered call of the same tool, and fails when its label ends in " error".
 * @param {import("./transcript-full.mjs").ReplayEvent[]} events @param {{ enabled?: boolean }} [opts]
 * @returns {{ i: number, turn: string, reason: "repeat" | "errors", note: string }[]} one entry per nudge, at the result that fired it
 */
export function scan(events, opts) {
	const fired = [], calls = new Map();
	let state = null, turn = "t0", n = 0;
	for (const e of events) {
		if (e.kind === "prompt") { turn = `t${++n}`; calls.clear(); }
		else if (e.kind === "tool_call") { const q = calls.get(e.detail.tool) ?? []; q.push(e.detail.input); calls.set(e.detail.tool, q); }
		else if (e.kind === "tool_result") {
			const tool = e.detail.tool, r = observe(state, { turn, tool, input: calls.get(tool)?.shift() ?? "", output: e.detail.output, failed: e.label.endsWith(" error") }, opts);
			state = r.state;
			if (r.note) fired.push({ i: e.i, turn, reason: r.reason, note: r.note });
		}
	}
	return fired;
}

// ---------- hook ----------

const SEEN_MAX = 64, STALE_LOCK_MS = 5000, STATE_DAYS = 7;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * One hook payload as a ToolOutcome plus its dedupe id, or null when it must not count. Claude Code: PostToolUse is a success,
 * PostToolUseFailure a failure unless the user interrupted it; the turn is prompt_id. Codex: PostToolUse with turn_id, and only
 * an MCP result with an explicit boolean isError says whether it failed; shell and other results are skipped, never guessed
 * from their text or exit code.
 * @param {"claude-code" | "codex"} client @param {any} h the parsed hook input
 * @returns {{ outcome: ToolOutcome, id: string, scope: string } | null}
 */
export function hookOutcome(client, h) {
	const event = h?.hook_event_name, session = str(h?.session_id), id = str(h?.tool_use_id), tool = str(h?.tool_name);
	if (!session || !ID.test(session) || !id || !tool) return null;
	let turn, failed, output;
	if (client === "claude-code") {
		turn = str(h.prompt_id);
		if (event === "PostToolUse") failed = false;
		else if (event === "PostToolUseFailure" && h.is_interrupt !== true) { failed = true; output = h.error; }
		else return null;
	} else if (client === "codex" && event === "PostToolUse") {
		turn = str(h.turn_id);
		const r = h.tool_response;
		if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.isError !== "boolean") return null;
		failed = r.isError;
		output = failed ? r.content ?? r.structuredContent ?? null : undefined;
	} else return null;
	if (!turn) return null;
	// Subagents keep their own state: their tool calls are not the parent's turn.
	const scope = hash(`${client}\0${session}\0${str(h.agent_id) ?? ""}`);
	return { outcome: { turn: hash(`${client}\0${turn}`), tool, input: h.tool_input, output, failed }, id: hash(id), scope };
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** An exclusive lock file per state file, waited for until the deadline; a lock older than STALE_LOCK_MS is a dead hook's. */
function lock(file, deadline) {
	while (Date.now() < deadline) {
		try { fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 }); return true; } catch (e) { if (e.code !== "EEXIST") throw e; }
		// shortcut: a hook stalled past STALE_LOCK_MS can lose its lock to another; the cost is one miscounted result, not data.
		try { if (Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS) fs.rmSync(file, { force: true }); } catch { /* released meanwhile */ }
		pause(20);
	}
	return false;
}

/** Removes state and lock files idle over STATE_DAYS. Run when a session's first state file is made, so once per session. */
function prune(dir, now) {
	for (const f of fs.readdirSync(dir)) {
		if (!/\.(?:json|lock)$/.test(f)) continue;
		try { if (now - fs.statSync(path.join(dir, f)).mtimeMs > STATE_DAYS * 86_400_000) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* gone */ }
	}
}

/**
 * The hook: reads the payload, folds it into the session's state under a lock and returns the client's output, or null.
 * Output, for both clients: { hookSpecificOutput: { hookEventName: <the triggering event>, additionalContext: <note> } }.
 * A tool_use_id seen before (the last SEEN_MAX per session) is not counted again.
 * @param {"claude-code" | "codex"} client @param {string} input @param {{ deadline: number, now?: number }} opts
 */
export function loopHook(client, input, { deadline, now = Date.now() }) {
	if (loadConfig().loop_guard?.enabled !== true) return null;
	let h;
	try { h = JSON.parse(input); } catch { return null; }
	const r = hookOutcome(client, h);
	if (!r) return null;
	const dir = path.join(home(), "loop-guard"), file = path.join(dir, `${r.scope}.json`), lockFile = path.join(dir, `${r.scope}.lock`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!lock(lockFile, deadline)) return null;
	let note = null;
	try {
		const prior = readJson(file, null);
		if (!prior) prune(dir, now);
		const seen = Array.isArray(prior?.seen) ? prior.seen.filter((x) => typeof x === "string") : [];
		if (seen.includes(r.id)) return null;
		const o = observe(prior?.guard, r.outcome);
		writePrivate(file, JSON.stringify({ v: 1, seen: [...seen, r.id].slice(-SEEN_MAX), guard: o.state }));
		note = o.note;
	} finally { fs.rmSync(lockFile, { force: true }); }
	return note ? JSON.stringify({ hookSpecificOutput: { hookEventName: h.hook_event_name, additionalContext: note } }) : null;
}
