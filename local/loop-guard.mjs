// Rule-based loop nudge (#102). Deterministic: no model call and no network. observe() and scan() are pure; loopHook() is the
// PostToolUse / PostToolUseFailure hook, which keeps each session's state in a private file between hook processes. The note is
// fixed text with counts and a sanitized tool name only, so no tool input or output, which may hold untrusted instructions or
// secrets, ever reaches the agent through it. The state and the fire log hold hashes and counts, never raw text or the payload.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { home, loadConfig, readJson, writePrivate } from "./agent-memory.mjs";

/**
 * Thresholds. repeat: the same invocation failing with the same normalized error this many times in one turn. errors: this
 * many failed results among the last `window` results of the turn, so scattered errors in a long productive turn never reach
 * it, while a stretch of nearly all failures does even when each command differs. variant: this many failures of the same
 * shell program and subcommand among the last `window` results, with at least two different command lines and no success of
 * that program or file edit in between, so a test-fix cycle (edit, rerun) never counts. keys: distinct failing invocations kept.
 */
export const LOOP_GUARD = Object.freeze({ repeat: 3, window: 10, errors: 8, variant: 4, keys: 200 });

/** @typedef {{ turn: string, tool: string, input?: unknown, output?: unknown, failed: boolean, cwd?: string }} ToolOutcome */
/** @typedef {{ f: 0 | 1, h: string | null, i: string, e: 0 | 1 }} TailEntry one result: failed, program head hash, invocation hash, an edit */
/** @typedef {{ v: 2, turn: string, nudged: boolean, tail: TailEntry[], fails: Record<string, { out: string, n: number }> }} GuardState */
/** @typedef {"repeat" | "errors" | "variant"} Rule */

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Keys sorted at every level, so the same arguments in another order are the same invocation. */
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]`
	: v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
	: JSON.stringify(v) ?? "null";

/** The shell command line, whitespace folded, when the input is a shell call (`command` or `cmd`); else null. */
function shellCommand(input) {
	const cmd = input && typeof input === "object" && !Array.isArray(input) ? input.command ?? input.cmd : undefined;
	if (Array.isArray(cmd)) return (cmd.length === 3 && /^-l?c$/.test(cmd[1]) ? String(cmd[2]) : cmd.join(" ")).replace(/\s+/g, " ").trim();
	return typeof cmd === "string" ? cmd.replace(/\s+/g, " ").trim() : null;
}

const parse = (input) => { if (typeof input !== "string") return input; try { return JSON.parse(input); } catch { return input; } };

/** What the tool was asked to do: the command line for shells (ignoring descriptions and timeouts), else all arguments. */
function invocation(input) {
	if (typeof input === "string") return input.replace(/\s+/g, " ").trim();
	return shellCommand(input) ?? stable(input ?? null);
}

// Prefixes that are not the program itself, and programs whose nonzero exit is an answer ("no match", "differs"), not an error.
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "rtk", "proxy"]);
const SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset", "true", ":"]);
const ANSWERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "diff", "cmp", "test", "[", "[[", "which", "pgrep", "git grep", "git diff"]);

/**
 * The program and subcommand a shell command runs, such as "git push" or "npm test": the first part of the line that is not
 * setup (cd, export) after env assignments and wrappers, with its first argument unless that is a flag. Null for anything else.
 */
export function programHead(command) {
	if (typeof command !== "string") return null;
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const words = part.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']+|["']+$/g, ""));
		while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || WRAPPERS.has(words[0]))) words.shift();
		if (!words.length || SETUP.has(words[0])) continue;
		const prog = words[0].split("/").pop();
		if (!prog || prog.startsWith("-")) return null;
		const head = words[1] && !words[1].startsWith("-") ? `${prog} ${words[1]}` : prog;
		return ANSWERS.has(prog) || ANSWERS.has(head) ? null : head;
	}
	return null;
}

/** File-editing tools: a successful edit between two failures means the retry tests a changed state, not a loop. */
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);

/** The error as a fingerprint: digit runs (times, pids, durations) and whitespace runs folded, the first 64 KB only. */
function fingerprint(output) {
	const s = typeof output === "string" ? output : stable(output ?? null);
	return hash(s.slice(0, 65536).replace(/\d+/g, "#").replace(/\s+/g, " ").trim());
}

const fresh = (turn) => ({ v: 2, turn, nudged: false, tail: [], fails: {} });
const valid = (s) => s && s.v === 2 && typeof s.turn === "string" && typeof s.nudged === "boolean" && Array.isArray(s.tail)
	&& s.tail.every((x) => x && typeof x === "object") && s.fails && typeof s.fails === "object" && !Array.isArray(s.fails);
const toolName = (t) => (typeof t === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(t) ? t : "a tool");

const NOTES = {
	repeat: (tool) => `Loop guard (local rule, not the user): ${tool} has failed ${LOOP_GUARD.repeat} times in this turn with the same input and the same error. Stop repeating it. Read the error, then change the approach or ask the user.`,
	errors: () => `Loop guard (local rule, not the user): ${LOOP_GUARD.errors} of the last ${LOOP_GUARD.window} tool calls in this turn failed. Pause, check what is failing and why, then change the approach or ask the user.`,
	variant: (tool) => `Loop guard (local rule, not the user): ${tool} has failed ${LOOP_GUARD.variant} times in this turn running the same program with different arguments. Stop varying the command. Read the error, then change the approach or ask the user.`,
};

/** The variant rule's counts at the newest tail entry, which failed with program head `h`: failures and distinct command lines. */
function variantCounts(tail, h) {
	let n = 0;
	const invs = new Set();
	for (let k = tail.length - 1; k >= 0; k--) {
		const x = tail[k];
		if (x.e === 1 || (x.h === h && x.f === 0)) break;
		if (x.h === h && x.f === 1) { n++; invs.add(x.i); }
	}
	return { n, distinct: invs.size };
}

/**
 * Folds one tool result into the turn's state and returns the note to show, at most once per turn.
 * A new `turn` starts a new state. Without a turn id there is no per-turn limit to keep, so nothing fires.
 * With `enabled: false` it returns the state unchanged and never a note.
 * @param {GuardState | null | undefined} state the previous return value, or null; anything malformed starts afresh
 * @param {ToolOutcome} outcome @param {{ enabled?: boolean }} [opts]
 * @returns {{ state: GuardState | null, note: string | null, reason: Rule | null, counts?: Record<string, number> }} counts only with a reason
 */
export function observe(state, outcome, { enabled = true } = {}) {
	const turn = outcome?.turn;
	if (enabled !== true || typeof turn !== "string" || !turn) return { state: state ?? null, note: null, reason: null };
	const s = valid(state) && state.turn === turn ? structuredClone(state) : fresh(turn);
	const failed = outcome.failed === true, tool = typeof outcome.tool === "string" ? outcome.tool : "", input = parse(outcome.input);
	// The working directory is part of the invocation: the same command in another directory is another attempt.
	const cwd = typeof outcome.cwd === "string" ? outcome.cwd : "", inv = hash(`${cwd}\0${invocation(input)}`), key = hash(`${tool}\0${inv}`);
	const prog = programHead(shellCommand(input)), h = prog ? hash(`${tool}\0${cwd}\0${prog}`) : null;
	s.tail = [...s.tail, { f: failed ? 1 : 0, h, i: inv, e: !failed && EDITS.has(tool) ? 1 : 0 }].slice(-LOOP_GUARD.window);
	let reason = null, counts;
	if (!failed) delete s.fails[key]; // the same invocation succeeding is progress
	else {
		const out = fingerprint(outcome.output), prior = s.fails[key];
		delete s.fails[key]; // re-inserted last, so the oldest key is the one dropped at the cap
		s.fails[key] = { out, n: prior?.out === out ? prior.n + 1 : 1 };
		const keys = Object.keys(s.fails);
		if (keys.length > LOOP_GUARD.keys) delete s.fails[keys[0]];
		const errors = s.tail.reduce((a, x) => a + (x.f === 1 ? 1 : 0), 0), v = h ? variantCounts(s.tail, h) : null;
		if (s.fails[key].n >= LOOP_GUARD.repeat) { reason = "repeat"; counts = { n: s.fails[key].n }; }
		else if (v && v.n >= LOOP_GUARD.variant && v.distinct >= 2) { reason = "variant"; counts = v; }
		else if (errors >= LOOP_GUARD.errors) { reason = "errors"; counts = { failed: errors, window: s.tail.length }; }
	}
	if (!reason || s.nudged) return { state: s, note: null, reason: null };
	s.nudged = true;
	return { state: s, note: reason === "errors" ? NOTES.errors() : NOTES[reason](toolName(outcome.tool)), reason, counts };
}

/**
 * Runs the rules over a transcript read by readFull (transcript-full.mjs), for evaluation. Each prompt event starts a turn;
 * a result pairs with the oldest unanswered call of the same tool, and fails when its label ends in " error".
 * @param {import("./transcript-full.mjs").ReplayEvent[]} events @param {{ enabled?: boolean }} [opts]
 * @returns {{ i: number, turn: string, reason: Rule, note: string }[]} one entry per nudge, at the result that fired it
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
const ROLLOUT_TAIL = 1 << 20, ROLLOUT_WAIT_MS = 200, LOG_MAX = 256 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const str = (v) => (typeof v === "string" && v ? v : null);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A Codex shell command's exit code, read from the session rollout. Codex's PostToolUse gives a shell result as its output text
 * only, with no exit status (openai/codex#34289, #42864), but the rollout at transcript_path records each finished command as an
 * item_completed event whose item.id is the hook's tool_use_id, with an integer exit_code. Reads the last ROLLOUT_TAIL bytes
 * and, since the record can land a moment after the hook starts, retries until ROLLOUT_WAIT_MS or the deadline. Null when not found.
 */
export function rolloutExitCode(transcript, id, deadline = Date.now() + ROLLOUT_WAIT_MS) {
	if (typeof transcript !== "string" || !path.isAbsolute(transcript) || !/^rollout-[\w.:-]+\.jsonl$/.test(path.basename(transcript))) return null;
	const until = Math.min(deadline, Date.now() + ROLLOUT_WAIT_MS), needle = JSON.stringify(id);
	for (;;) {
		let fd;
		try {
			fd = fs.openSync(transcript, "r");
			const size = fs.fstatSync(fd).size, len = Math.min(size, ROLLOUT_TAIL), buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			const lines = buf.toString("utf8").split("\n");
			for (let k = lines.length - 1; k >= (len < size ? 1 : 0); k--) { // a cut first line is skipped
				const line = lines[k];
				if (!line.includes(needle) || !line.includes('"item_completed"')) continue;
				let p;
				try { p = JSON.parse(line)?.payload; } catch { continue; }
				const item = p?.type === "item_completed" ? p.item : null;
				if (item?.id === id && item.type === "CommandExecution" && Number.isInteger(item.exit_code)) return item.exit_code;
			}
		} catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
		if (Date.now() + 25 > until) return null;
		pause(25);
	}
}

/**
 * One hook payload as a ToolOutcome plus its dedupe id, or null when it must not count. Claude Code: PostToolUse is a success,
 * PostToolUseFailure a failure unless the user interrupted it; the turn is prompt_id. Codex: PostToolUse with turn_id. An MCP
 * result counts by its explicit boolean isError; a shell result (tool_name Bash, including a command that finished after the
 * call returned) by the exit code its rollout records. Any other result, or a shell result without a recorded exit code, is
 * skipped, never guessed from its text.
 * @param {"claude-code" | "codex"} client @param {any} h the parsed hook input @param {{ deadline?: number }} [opts]
 * @returns {{ outcome: ToolOutcome, id: string, scope: string } | null}
 */
export function hookOutcome(client, h, { deadline } = {}) {
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
		if (!turn) return null;
		const r = h.tool_response;
		if (r && typeof r === "object" && !Array.isArray(r) && typeof r.isError === "boolean") {
			failed = r.isError;
			output = failed ? r.content ?? r.structuredContent ?? null : undefined;
		} else if (tool === "Bash") {
			const code = rolloutExitCode(h.transcript_path, id, deadline);
			if (code === null) return null;
			failed = code !== 0;
			output = failed ? `${code}\0${typeof r === "string" ? r : ""}` : undefined;
		} else return null;
	} else return null;
	if (!turn) return null;
	// Subagents keep their own state: their tool calls are not the parent's turn.
	const scope = hash(`${client}\0${session}\0${str(h.agent_id) ?? ""}`);
	return { outcome: { turn: hash(`${client}\0${turn}`), tool, input: h.tool_input, output, failed, cwd: str(h.cwd) ?? undefined }, id: hash(id), scope };
}

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
 * Appends one fire, or would-fire in shadow mode, to fires.jsonl: time, client, hashed session and turn, rule and counts only.
 * Past LOG_MAX the file becomes fires.jsonl.1, replacing the older one, so the log stays under twice LOG_MAX. Never throws.
 */
function logFire(dir, entry) {
	try {
		const file = path.join(dir, "fires.jsonl");
		try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, `${file}.1`); } catch { /* none yet */ }
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	} catch { /* evidence only; never block the hook */ }
}

/**
 * The hook: reads the payload, folds it into the session's state under a lock and returns the client's output, or null.
 * Output, for both clients: { hookSpecificOutput: { hookEventName: <the triggering event>, additionalContext: <note> } }.
 * With loop_guard.shadow the rules still run and log, but no note is printed. A tool_use_id seen before (the last SEEN_MAX per
 * session) is not counted again.
 * @param {"claude-code" | "codex"} client @param {string} input @param {{ deadline: number, now?: number }} opts
 */
export function loopHook(client, input, { deadline, now = Date.now() }) {
	const config = loadConfig();
	if (config.loop_guard?.enabled !== true) return null;
	let h;
	try { h = JSON.parse(input); } catch { return null; }
	const r = hookOutcome(client, h, { deadline });
	if (!r) return null;
	const dir = path.join(home(), "loop-guard"), file = path.join(dir, `${r.scope}.json`), lockFile = path.join(dir, `${r.scope}.lock`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!lock(lockFile, deadline)) return null;
	let o;
	try {
		const prior = readJson(file, null);
		if (!prior) prune(dir, now);
		const seen = Array.isArray(prior?.seen) ? prior.seen.filter((x) => typeof x === "string") : [];
		if (seen.includes(r.id)) return null;
		o = observe(prior?.guard, r.outcome);
		writePrivate(file, JSON.stringify({ v: 1, seen: [...seen, r.id].slice(-SEEN_MAX), guard: o.state }));
	} finally { fs.rmSync(lockFile, { force: true }); }
	if (!o.note) return null;
	const shadow = config.loop_guard.shadow === true;
	logFire(dir, { v: 1, at: new Date(now).toISOString(), client, session: r.scope, turn: r.outcome.turn, rule: o.reason, shadow, counts: o.counts });
	return shadow ? null : JSON.stringify({ hookSpecificOutput: { hookEventName: h.hook_event_name, additionalContext: o.note } });
}
