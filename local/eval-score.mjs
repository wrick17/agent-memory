// Eval scoring and request shaping (EV1). No imports and no I/O, so the Node CLI (eval.mjs) and the Workers synthetic gate
// (test/eval-synthetic.test.ts) run the same case parsing, recall body, scorer and baseline rule.

/** @typedef {{ id: string, query: string, expected: string[], filters?: string[] }} EvalCase */
/** @typedef {"lexical" | "vector" | "hybrid"} Channels */

export const CHANNELS = { lexical: ["lexical"], vector: ["vector"], hybrid: ["lexical", "vector"] };
export const METRICS = ["recall_all_at_k", "any_hit_at_k", "mrr"];

const PROFILE = /^[a-z][a-z0-9-]{0,11}$/; // src/domain/types.ts PROFILE_NAME
const QUERY_MAX = 4096; // POST /v1/recall keyword bound
export const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/\s/.test(v);
export const isProfile = (v) => typeof v === "string" && PROFILE.test(v);

/**
 * One case. expected: the subject ids the case names; got: the returned ids in rank order. k: the cutoff.
 * all: every expected id is in the top k. any: at least one is. rr: 1 / rank of the first expected id in the top k, else 0.
 * @returns {{ all: boolean, any: boolean, rr: number }}
 */
export function scoreCase(expected, got, k) {
	if (!Number.isInteger(k) || k < 1) throw new Error("k must be a positive integer");
	if (!Array.isArray(expected) || expected.length === 0) throw new Error("a case needs at least one expected id");
	const top = got.slice(0, k);
	const want = new Set(expected);
	const first = top.findIndex((id) => want.has(id));
	return { all: expected.every((id) => top.includes(id)), any: first >= 0, rr: first >= 0 ? 1 / (first + 1) : 0 };
}

/**
 * Every case. results: [{ case, expected, got }]. Returns the report's score fields; misses list the cases with all: false.
 * @returns {{ cases: number, k: number, recall_all_at_k: number, any_hit_at_k: number, mrr: number, misses: { case: string, expected: string[], got: string[] }[] }}
 */
export function score(results, k) {
	let all = 0, any = 0, rr = 0;
	const misses = [];
	for (const r of results) {
		const s = scoreCase(r.expected, r.got, k);
		all += s.all ? 1 : 0;
		any += s.any ? 1 : 0;
		rr += s.rr;
		if (!s.all) misses.push({ case: r.case, expected: r.expected, got: r.got.slice(0, k) });
	}
	const n = results.length;
	return { cases: n, k, recall_all_at_k: n ? all / n : 0, any_hit_at_k: n ? any / n : 0, mrr: n ? rr / n : 0, misses };
}

/**
 * One case, in either form the golden-query schema file holds: an owner-selected golden case (id, hosted_call with
 * recall_memories and its keyword, expected.source_top1.hosted_memory_id) or an exported candidate (id, query, expected ids).
 * The case's own profile is ignored: the profile is --profile. /v1/recall takes no type, kinds or scope filter, so a golden case
 * that sets one runs unfiltered and keeps the filter names in `filters`; the report lists those cases (a known gap, not a skip).
 * Errors name the case by position and id only, never its query.
 */
function normalizeCase(c, i) {
	const where = `case ${i}${isId(c?.id) ? ` (${c.id})` : ""}`;
	if (!c || typeof c !== "object" || Array.isArray(c) || !isId(c.id)) throw new Error(`${where}: id is required`);
	let query, expected, filters = [];
	if (c.hosted_call !== undefined) {
		if (c.hosted_call?.tool !== "recall_memories") throw new Error(`${where}: only recall_memories cases can be run`);
		const a = c.hosted_call.arguments ?? {};
		query = a.keyword;
		expected = [c.expected?.source_top1?.hosted_memory_id];
		filters = ["type", "kinds", "scope"].filter((f) => a[f] !== undefined && !(f === "type" && a.type === "all"));
	} else {
		query = c.query;
		expected = c.expected;
	}
	if (typeof query !== "string" || !query.trim() || query.length > QUERY_MAX) throw new Error(`${where}: the query must be 1 to ${QUERY_MAX} characters`);
	if (!Array.isArray(expected) || expected.length === 0 || expected.length > 100 || !expected.every(isId)) throw new Error(`${where}: expected must list 1 to 100 ids`);
	return { id: c.id, query, expected: [...new Set(expected)], ...(filters.length ? { filters } : {}) };
}

/** The cases of a parsed schema_version 1 case file, normalized; `file` names it in errors. @returns {EvalCase[]} */
export function casesOf(doc, file) {
	if (!doc || typeof doc !== "object" || doc.schema_version !== 1 || !Array.isArray(doc.cases)) throw new Error(`${file}: not a schema_version 1 case file`);
	const cases = doc.cases.map(normalizeCase);
	const ids = new Set();
	for (const c of cases) {
		if (ids.has(c.id)) throw new Error(`${file}: case id ${c.id} appears twice`);
		ids.add(c.id);
	}
	return cases;
}

/**
 * The POST /v1/recall body for one case: { keyword, profile, limit: k, channels, count_hits: false }. No repo: the profile is explicit.
 * @param {EvalCase} c @param {{ profile: string, channels: Channels, k: number }} opts
 */
export function recallRequest(c, { profile, channels, k }) {
	return { keyword: c.query, profile, limit: k, channels: CHANNELS[channels], count_hits: false };
}

export function checkRun({ profile, channels, k }) {
	if (!isProfile(profile)) throw new Error("--profile is required: a profile name such as work or personal");
	if (!Object.hasOwn(CHANNELS, channels)) throw new Error("--channels must be lexical, vector or hybrid");
	if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("--k must be an integer from 1 to 100");
}

/**
 * Runs every case through read.recall and returns the report:
 * { cases, k, channels, at, recall_all_at_k, any_hit_at_k, mrr, misses, unsupported_filters }.
 * @param {{ cases: EvalCase[], profile: string, channels: Channels, k: number, read: { recall(body: object): Promise<object> }, now?: () => number }} opts
 */
export async function runCases({ cases, profile, channels, k, read, now = Date.now }) {
	checkRun({ profile, channels, k });
	const at = new Date(now()).toISOString();
	const results = [];
	// One case at a time: a failed recall fails the run, since a skipped case would change every score.
	for (const c of cases) {
		const reply = await read.recall(recallRequest(c, { profile, channels, k }));
		if (!Array.isArray(reply?.results)) throw new Error(`case ${c.id}: the recall reply has no results`);
		results.push({ case: c.id, expected: c.expected, got: reply.results.map((r) => r?.memory_id).filter(isId) });
	}
	const s = score(results, k);
	const unsupported_filters = cases.filter((c) => c.filters).map((c) => ({ case: c.id, filters: c.filters }));
	return { cases: s.cases, k, channels, at, recall_all_at_k: s.recall_all_at_k, any_hit_at_k: s.any_hit_at_k, mrr: s.mrr, misses: s.misses, unsupported_filters };
}

/** The scores-and-counts body for POST /v1/eval/runs: { profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr }. No query or id. */
export function runSummary(report, profile) {
	const { at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr } = report;
	return { profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr };
}

/**
 * The baseline only rises: a new summary replaces `old` (a parsed baseline, or null when there is none) only when it has the same
 * channels and k, no metric is lower and one is higher. → { write: boolean, reason?: string }
 */
export function baselineDecision(old, summary) {
	if (old === null) return { write: true };
	if (old?.channels !== summary.channels || old?.k !== summary.k) return { write: false, reason: `the baseline is for ${old?.channels} at k ${old?.k}; this run is ${summary.channels} at k ${summary.k}` };
	const lower = METRICS.filter((m) => !(summary[m] >= old[m]));
	if (lower.length) return { write: false, reason: `${lower.join(", ")} would drop below the baseline` };
	if (!METRICS.some((m) => summary[m] > old[m])) return { write: false, reason: "the scores equal the baseline" };
	return { write: true };
}
