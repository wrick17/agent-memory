// eval_candidates (R1): suggest_eval_case results the owner accepts or dismisses on the Health tab.
import type { EvalCandidate, EvalCandidateQuery, EvalCandidateStatus, Page, SuggestEvalCaseOp } from "../viewer/types";

/**
 * Runs inside the caller's transaction (M1's suggest_eval_case path). Throws Fail "profile_wiped" when an expected id or a
 * node evidence ref has a local `wiped:` fence, so no candidate can name a purged node. Ids from another profile are allowed.
 */
export function insertCandidate(_sql: SqlStorage, _seq: number, _now: string, _id: string, _op: Omit<SuggestEvalCaseOp, "op">): EvalCandidate {
	throw new Error("stub: R1");
}
export function listCandidates(_sql: SqlStorage, _q: EvalCandidateQuery): Page<EvalCandidate> {
	return { rows: [], next_cursor: null }; // stub: R1
}
/** null when the id is unknown. Deciding an already decided candidate returns it unchanged. */
export function decideCandidate(_sql: SqlStorage, _seq: number, _id: string, _status: Exclude<EvalCandidateStatus, "pending">): EvalCandidate | null {
	return null; // stub: R1
}
/** Accepted candidates for `agent-memory eval export-candidates`, oldest first. */
export function acceptedCandidates(_sql: SqlStorage, _cursor: string | null, _limit: number): Page<EvalCandidate> {
	return { rows: [], next_cursor: null }; // stub: R1
}
