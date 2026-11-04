// Full local transcript reader for `agent-memory replay` (#22). Reuses readLines, extract, clientHome and redact from
// agent-memory.mjs, keeps tool calls and results in transcript order, redacts every label and detail and cuts each tool
// input and output at 8 KB after redaction. Nothing it reads leaves this machine.
import fs from "node:fs";
import path from "node:path";
import { clientHome, extract, readLines, redact } from "./agent-memory.mjs";

export const TOOL_OUTPUT_MAX = 8192;

/** @typedef {{ i: number, kind: "prompt" | "response" | "tool_call" | "tool_result", label: string, offset_ms: number | null, detail: Record<string, string> }} ReplayEvent */
/** @typedef {{ client: "claude-code" | "codex", session: string, file: string, modified_at: string, bytes: number }} LocalSession */

const CLIENTS = ["claude-code", "codex"];
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DATED = /^\d{1,4}$/;

const own = (st) => st.uid === process.getuid();
function entries(dir) {
	try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Sessions in the client stores, newest first. @param {{ client?: string, env?: NodeJS.ProcessEnv }} opts @returns {LocalSession[]} */
export function listTranscripts({ client, env = process.env } = {}) {
	if (client !== undefined && !CLIENTS.includes(client)) throw new Error("unknown_client");
	/** @type {LocalSession[]} */
	const out = [];
	for (const c of client ? [client] : CLIENTS) {
		const root = path.join(clientHome(c, env), c === "codex" ? "sessions" : "projects");
		// The store root may sit behind a symlinked client home; below it, readdir entries are lstat-typed, so symlinked
		// directories and files are never followed.
		try { const st = fs.statSync(root); if (!st.isDirectory() || !own(st)) continue; } catch { continue; }
		const add = (file, session) => {
			try {
				const st = fs.lstatSync(file);
				if (st.isFile() && own(st)) out.push({ client: c, session, file, modified_at: st.mtime.toISOString(), bytes: st.size });
			} catch { /* vanished while listing */ }
		};
		// Claude Code: projects/<project>/<session>.jsonl; subagent files (agent-*.jsonl) are not sessions.
		// Codex: sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl.
		const walk = (dir, depth) => {
			for (const e of entries(dir)) {
				const p = path.join(dir, e.name);
				if (e.isDirectory() && depth > 0) { if (c === "claude-code" || DATED.test(e.name)) walk(p, depth - 1); }
				else if (e.isFile() && depth === 0) {
					const id = c === "codex" ? ROLLOUT.exec(e.name)?.[1] : e.name.endsWith(".jsonl") && !e.name.startsWith("agent-") ? e.name.slice(0, -6) : null;
					if (id && SESSION_ID.test(id)) add(p, id);
				}
			}
		};
		walk(root, c === "codex" ? 3 : 1);
	}
	return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

/** The transcript for a validated session id, or null. @returns {LocalSession | null} */
export function findSession(id, { env = process.env } = {}) {
	// Matched against the listing rather than findTranscript, whose suffix match and missing owner check suit hooks only.
	if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
	return listTranscripts({ env }).find((s) => s.session === id) ?? null;
}

/** A tool value as display text: strings as-is, content blocks by their text, images as a marker, anything else as JSON. */
function text(v) {
	if (v === undefined || v === null) return "";
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map((b) => (typeof b === "string" ? b : /image/.test(b?.type ?? "") ? "[image]" : typeof b?.text === "string" ? b.text : JSON.stringify(b))).join("\n");
	if (typeof v === "object" && typeof v.text === "string" && Object.keys(v).length <= 2) return v.text;
	return JSON.stringify(v, null, 2);
}

/** Tool input as a reader expects it: the command line for shells, a lone string argument as itself, else JSON. */
function inputText(v) {
	if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v; } }
	if (v && typeof v === "object" && !Array.isArray(v)) {
		const cmd = v.command ?? v.cmd;
		if (Array.isArray(cmd)) return cmd.length === 3 && /^-l?c$/.test(cmd[1]) ? String(cmd[2]) : cmd.join(" ");
		if (typeof cmd === "string") return cmd;
		const vals = Object.values(v);
		if (vals.length === 1 && typeof vals[0] === "string") return vals[0];
	}
	return text(v);
}

/** Redacts, then cuts at TOOL_OUTPUT_MAX bytes; redacting first means a cut can never leave half a secret unmatched. */
function capped(s) {
	const r = redact(s), b = Buffer.from(r, "utf8");
	return b.length <= TOOL_OUTPUT_MAX ? { s: r, cut: false } : { s: b.subarray(0, TOOL_OUTPUT_MAX).toString("utf8").replace(/�+$/, ""), cut: true };
}

/**
 * Reads one transcript without following a symlink and refuses anything but a regular file owned by this user.
 * @param {"claude-code" | "codex"} client @param {string} file @returns {ReplayEvent[]} in order, offsets from transcript timestamps
 */
export function readFull(client, file) {
	if (!CLIENTS.includes(client)) throw new Error("unknown_client");
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	let lines;
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || !own(st)) throw new Error("transcript_not_owned");
		({ lines } = readLines(fd, 0));
	} finally { fs.closeSync(fd); }

	/** @type {ReplayEvent[]} */
	const events = [];
	const names = new Map(); // call id -> tool name, for results that carry only the id
	let t0 = null, last = null;
	const at = (obj) => {
		const t = Date.parse(obj?.timestamp ?? "");
		if (Number.isFinite(t)) { t0 ??= t; last = Math.max(0, t - t0); }
		return last;
	};
	const push = (kind, label, offset, detail) => {
		events.push({ i: events.length, kind, label: redact(label), offset_ms: offset, detail: Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, redact(v)])) });
	};
	const call = (offset, id, tool, input) => {
		if (id) names.set(id, tool);
		const c = capped(inputText(input));
		push("tool_call", tool, offset, { tool, input: c.s, ...(c.cut ? { truncated: "true" } : {}) });
	};
	const result = (offset, id, output, failed = false, tool = names.get(id) ?? "tool") => {
		const c = capped(text(output));
		push("tool_result", `${tool} ${failed ? "error" : "result"}`, offset, { tool, output: c.s, ...(c.cut ? { truncated: "true" } : {}) });
	};

	for (const line of lines) {
		const o = line.obj, offset = at(o);
		// Prompts and responses use the hook's own filters: injected context, reminders, thinking and meta records stay out.
		for (const m of extract(client, [line])) push(m.role === "owner" ? "prompt" : "response", m.text, offset, { role: m.role });
		if (client === "claude-code") {
			if ((o.type !== "user" && o.type !== "assistant") || o.isMeta || o.isSidechain || !Array.isArray(o.message?.content)) continue;
			for (const b of o.message.content) {
				if (b?.type === "tool_use") call(offset, b.id, String(b.name ?? "tool"), b.input);
				else if (b?.type === "tool_result") result(offset, b.tool_use_id, b.content, b.is_error === true);
			}
			continue;
		}
		const p = o.payload;
		if (o.type === "response_item") {
			if (p?.type === "function_call" || p?.type === "custom_tool_call") call(offset, p.call_id, String(p.name ?? "tool"), p.arguments ?? p.input);
			else if (p?.type === "local_shell_call") call(offset, p.call_id, "shell", p.action);
			else if (p?.type === "web_search_call") call(offset, p.call_id ?? p.id, "web_search", p.action);
			else if (p?.type === "function_call_output" || p?.type === "custom_tool_call_output") {
				const out = p.output && typeof p.output === "object" && !Array.isArray(p.output) && "content" in p.output ? p.output.content : p.output;
				result(offset, p.call_id, out, p.output?.success === false);
			}
		} else if (o.type === "event_msg" && p?.type === "item_completed") {
			// Codex 0.166+ completed items hold both the call and its result. Skip any already shown as a response_item.
			const it = p.item;
			if (!it || names.has(it.id)) continue;
			if (it.type === "CommandExecution") {
				call(offset, it.id, "shell", { command: it.command });
				result(offset, it.id, it.aggregated_output, typeof it.exit_code === "number" && it.exit_code !== 0);
			} else if (it.type === "McpToolCall") {
				const tool = `${it.server ?? "mcp"}.${it.tool ?? "tool"}`;
				call(offset, it.id, tool, it.arguments);
				const r = it.result;
				result(offset, it.id, Array.isArray(r?.content) ? r.content : r?.structuredContent ?? r ?? it.error, r?.isError === true || it.status === "failed");
			} else if (it.type === "FileChange") {
				call(offset, it.id, "apply_patch", it.changes);
				result(offset, it.id, [it.stdout, it.stderr].filter((s) => typeof s === "string" && s).join("\n"), it.status === "failed");
			}
		}
	}
	return events;
}
