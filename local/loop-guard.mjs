// Rule-based loop nudge (#102). Deterministic: no model call, no network, no file I/O. The caller persists the state between
// tool results and shows the note to the agent. The note is fixed text with counts and a sanitized tool name only, so no tool
// input or output, which may hold untrusted instructions or secrets, ever reaches the agent through it. The state holds hashes
// and counts, never raw text.
import { createHash } from "node:crypto";

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
