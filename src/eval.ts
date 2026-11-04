// eval_runs (R1): POST /v1/eval/runs validation and the account table. Scores and counts only; reports stay local.
import type { Outcome } from "./domain/types";
import { fail } from "./domain/types";
import type { EvalRun, EvalRunInput } from "./viewer/types";

/** Validates the job-token body; unknown fields and out-of-range scores are refused. */
export function parseEvalRun(_raw: unknown): Outcome<EvalRunInput> {
	return fail("validation", "stub: R1");
}
export function insertEvalRun(_sql: SqlStorage, _run: EvalRun): void {
	// stub: R1
}
export function listEvalRuns(_sql: SqlStorage, _q: { profile?: string; limit: number }): EvalRun[] {
	return []; // stub: R1
}
