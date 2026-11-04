/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// `agent-memory eval` (EV1). Reads golden-query cases, calls POST /v1/recall with the read token and count_hits: false, writes the
// report on this machine, and sends only scores and counts to POST /v1/eval/runs with the job token. Stub from L0.
// The profile is always the caller's explicit --profile; nothing is routed from cwd, remote or text.

/** @typedef {{ id: string, query: string, expected: string[] }} EvalCase */
/** @typedef {"lexical" | "vector" | "hybrid"} Channels */

export const CHANNELS = { lexical: ["lexical"], vector: ["vector"], hybrid: ["lexical", "vector"] };

/** Cases in the golden-query schema (schema_version 1), normalized. Throws on an unreadable or invalid file. @returns {EvalCase[]} */
export function readCases(file) {
	throw new Error("not_implemented:EV1");
}

/**
 * The POST /v1/recall body for one case: { keyword, profile, limit: k, channels, count_hits: false }. No repo: the profile is explicit.
 * @param {EvalCase} c @param {{ profile: string, channels: Channels, k: number }} opts
 */
export function recallRequest(c, { profile, channels, k }) {
	throw new Error("not_implemented:EV1");
}

/**
 * Runs every case and returns the report: { cases, k, channels, at, recall_all_at_k, any_hit_at_k, mrr, misses }.
 * @param {{ cases: EvalCase[], profile: string, channels: Channels, k: number, read?: { recall(body: object, o?: { timeoutMs?: number }): Promise<object> }, now?: () => number }} opts
 */
export async function runEval({ cases, profile, channels, k, read, now = Date.now }) {
	throw new Error("not_implemented:EV1");
}

/** The scores-and-counts body for POST /v1/eval/runs: { profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr }. No query or id. */
export function runSummary(report, profile) {
	throw new Error("not_implemented:EV1");
}

/**
 * `eval export-candidates --profile P --out FILE`: appends accepted candidates to a local case file.
 * server is readServer(config) from agent-memory.mjs (read token only, never httpServer's job token); it pages with
 * server.acceptedCandidates({ profile, cursor, limit }) → { rows: EvalCandidate[], next_cursor: string | null }.
 * @returns {Promise<{ appended: number }>}
 */
export async function exportCandidates({ profile, out, server }) {
	throw new Error("not_implemented:EV1");
}

/**
 * `agent-memory eval --cases FILE --profile P [--channels lexical|vector|hybrid] [--k 5] [--out FILE] [--write-baseline FILE]`
 * and `agent-memory eval export-candidates --profile P --out FILE`. Resolves to the exit code.
 */
export async function main(argv, prog = "agent-memory eval") {
	process.stderr.write(`${prog}: not implemented yet\n`);
	return 1;
}
