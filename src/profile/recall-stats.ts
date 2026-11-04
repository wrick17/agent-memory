// recall_daily and recall_totals (R1). Recall stays a read for records: only these two tables change, never nodes.
import type { RecallStrength, RecallTotals } from "../viewer/types";

/**
 * One transaction at one write sequence; rows bounded by the result limit. In that same transaction it counts only ids that
 * are nodes here with no local `wiped:` fence: a count that arrives after a wipe, or for an id another profile returned, adds no row.
 */
export function noteRecall(_sql: SqlStorage, _seq: number, _day: string, _ids: string[], _tokens: number): void {
	// stub: R1
}
/** Strength for each id over the 90 UTC days ending `today`; ids with no hit get { hits_90d: 0, strength: 0, last_recalled: null }. */
export function recallStrength(_sql: SqlStorage, ids: string[], _today: string): Record<string, RecallStrength> {
	return Object.fromEntries(ids.map((id) => [id, { hits_90d: 0, strength: 0, last_recalled: null }])); // stub: R1
}
export function recallTotals(_sql: SqlStorage, day: string): RecallTotals {
	return { day, recalls: 0, tokens: 0 }; // stub: R1
}
/** The 400-day purge stage (M1 calls it from housekeeping). Returns rows deleted. */
export function purgeRecallBefore(_sql: SqlStorage, _day: string): number {
	return 0; // stub: R1
}
