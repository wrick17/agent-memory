/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// Eval scoring (EV1). Pure functions over ids, so tests import this file alone. Stub from L0: the signatures are the contract.

/**
 * One case. expected: the subject ids the case names; got: the returned ids in rank order. k: the cutoff.
 * all: every expected id is in the top k. any: at least one is. rr: 1 / rank of the first expected id in the top k, else 0.
 * @returns {{ all: boolean, any: boolean, rr: number }}
 */
export function scoreCase(expected, got, k) {
	throw new Error("not_implemented:EV1");
}

/**
 * Every case. results: [{ case, expected, got }]. Returns the report's score fields; misses list the cases with all: false.
 * @returns {{ cases: number, k: number, recall_all_at_k: number, any_hit_at_k: number, mrr: number, misses: { case: string, expected: string[], got: string[] }[] }}
 */
export function score(results, k) {
	throw new Error("not_implemented:EV1");
}
