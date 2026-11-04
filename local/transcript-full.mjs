/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// Full local transcript reader for `agent-memory replay` (RP1). Reuses readLines, findTranscript and redact from agent-memory.mjs,
// keeps tool calls and results, runs every string through redact and cuts each tool output at 8 KB. Nothing it reads leaves this
// machine. Stub from L0.

export const TOOL_OUTPUT_MAX = 8192;

/** @typedef {{ i: number, kind: "prompt" | "response" | "tool_call" | "tool_result" | "ask" | "decision" | "correction" | "outcome", label: string, offset_ms: number | null, detail: Record<string, string> }} ReplayEvent */
/** @typedef {{ client: "claude-code" | "codex", session: string, file: string, modified_at: string, bytes: number }} LocalSession */

/** Sessions in the client stores, newest first. @param {{ client?: string, env?: NodeJS.ProcessEnv }} opts @returns {LocalSession[]} */
export function listTranscripts({ client, env = process.env } = {}) {
	throw new Error("not_implemented:RP1");
}

/** The transcript file for a session id, or null. @returns {LocalSession | null} */
export function findSession(id, { env = process.env } = {}) {
	throw new Error("not_implemented:RP1");
}

/** Every event in order, offsets from the transcript timestamps. @param {"claude-code" | "codex"} client @param {string} file @returns {ReplayEvent[]} */
export function readFull(client, file) {
	throw new Error("not_implemented:RP1");
}
