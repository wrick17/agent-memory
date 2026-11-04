/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// Opt-in recall at prompt time (INJ1), for the UserPromptSubmit hook. Stub from L0: it fails open and returns nothing.
// Contract: the request names inject.profile, the profile the owner chose for this hook. Without one it sends nothing. It never
// sends a repo for routing, never infers work or personal from the prompt, never reads the job token, and on a timeout, an
// error or a missing read token returns null so the prompt goes through.

/**
 * The POST /v1/recall body, or null when injection is off or no profile is chosen:
 * { keyword: prompt, profile: config.inject.profile, channels: ["lexical"], token_budget: config.inject.max_tokens }.
 * @param {string} prompt @param {object} config loadConfig() output
 */
export function recallRequest(prompt, config) {
	return null; // stub: INJ1
}

/**
 * The text to print for the client, or null. Claude Code: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }.
 * Codex: per its official hooks documentation, or null if it cannot add context from this hook.
 * @param {"claude-code" | "codex"} client @param {object} recall the /v1/recall reply @param {number} maxTokens
 */
export function hookOutput(client, recall, maxTokens) {
	return null; // stub: INJ1
}

/**
 * The hook body. input is the raw hook JSON. Resolves to the text to print or null; never throws, never exceeds timeout_ms.
 * @param {"claude-code" | "codex"} client @param {string} input
 * @param {{ config: object, read?: { recall(body: object, o?: { timeoutMs?: number }): Promise<object> } }} opts
 * @returns {Promise<string | null>}
 */
export async function inject(client, input, { config, read } = {}) {
	return null; // stub: INJ1
}
