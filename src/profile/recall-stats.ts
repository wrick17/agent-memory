// recall_daily and recall_totals (R1). Recall stays a read for records: only these two tables change, never nodes.
import { Fail } from "../domain/types";
import type { RecallStrength, RecallTotals } from "../viewer/types";
import { assertOpen } from "./wipe";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The recall result limit; strength reads take the same number of ids. */
const MAX_IDS = 100;
const STRENGTH_DAYS = 90, STRENGTH_CAP = 10;
/**
 * Rows one purge call deletes in total, across recall_daily and recall_totals. Measured in workerd, each deleted row writes
 * 3 rows (the row, its secondary index entries, its deleted_rows tombstone), so a full call is about 300 written rows plus the
 * seq row: under half of BudgetTx's 1,000. A return equal to PURGE_ROWS means rows may remain; less means none remain before the cutoff.
 */
export const PURGE_ROWS = 100;

const ids100 = (ids: unknown): ids is string[] =>
	Array.isArray(ids) && ids.length <= MAX_IDS && ids.every((i) => typeof i === "string" && i.length >= 1 && i.length <= 128);
const validDay = (day: unknown): day is string => typeof day === "string" && DAY_RE.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));

/**
 * One transaction at one write sequence; rows bounded by the result limit. In that same transaction it counts only ids that
 * are nodes here with no local `wiped:` fence: a count that arrives after a wipe, or for an id another profile returned, adds no row.
 * A call left with no countable id writes nothing, so totals count only the profiles that returned hits.
 */
export function noteRecall(sql: SqlStorage, seq: number, day: string, ids: string[], tokens: number): void {
	if (!validDay(day) || !ids100(ids) || !Number.isSafeInteger(tokens) || tokens < 0) throw Fail.of("validation", "noteRecall takes a UTC day, at most 100 ids and a token count");
	assertOpen(sql);
	const kept = sql.exec<{ id: string }>(`SELECT DISTINCT n.id FROM nodes n WHERE n.id IN (SELECT value FROM json_each(?))
		AND NOT EXISTS (SELECT 1 FROM profile_meta m WHERE m.key = 'wiped:' || n.id)`, JSON.stringify(ids)).toArray();
	if (!kept.length) return;
	for (const { id } of kept) sql.exec(
		`INSERT INTO recall_daily (node_id, day, hits, seq) VALUES (?, ?, 1, ?)
		 ON CONFLICT (node_id, day) DO UPDATE SET hits = hits + 1, seq = excluded.seq`, id, day, seq);
	sql.exec(`INSERT INTO recall_totals (day, recalls, tokens, seq) VALUES (?, 1, ?, ?)
		ON CONFLICT (day) DO UPDATE SET recalls = recalls + 1, tokens = tokens + excluded.tokens, seq = excluded.seq`, day, tokens, seq);
}

/** Strength for each id over the 90 UTC days ending `today`; ids with no hit get { hits_90d: 0, strength: 0, last_recalled: null }. */
export function recallStrength(sql: SqlStorage, ids: string[], today: string): Record<string, RecallStrength> {
	if (!validDay(today) || !ids100(ids)) throw Fail.of("validation", "recall strength takes a UTC day and at most 100 ids");
	const from = new Date(Date.parse(`${today}T00:00:00Z`) - (STRENGTH_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
	const rows = sql.exec<{ node_id: string; hits: number; last: string | null }>(`SELECT node_id,
		sum(CASE WHEN day >= ?1 THEN hits ELSE 0 END) AS hits, max(day) AS last
		FROM recall_daily WHERE node_id IN (SELECT value FROM json_each(?3)) AND day <= ?2 GROUP BY node_id`, from, today, JSON.stringify(ids)).toArray();
	const found = new Map(rows.map((r) => [r.node_id, r]));
	return Object.fromEntries(ids.map((id) => {
		const r = found.get(id), hits = r?.hits ?? 0;
		return [id, { hits_90d: hits, strength: Math.min(hits, STRENGTH_CAP), last_recalled: r?.last ?? null }];
	}));
}

export function recallTotals(sql: SqlStorage, day: string): RecallTotals {
	if (!validDay(day)) throw Fail.of("validation", "recall totals take a UTC day");
	const r = sql.exec<{ recalls: number; tokens: number }>("SELECT recalls, tokens FROM recall_totals WHERE day = ?", day).toArray()[0];
	return { day, recalls: r?.recalls ?? 0, tokens: r?.tokens ?? 0 };
}

/**
 * The 400-day purge stage (M1 calls it from housekeeping with the cutoff day). Deletes rows of days before `day`, at most
 * PURGE_ROWS rows in total per call, daily rows first. Returns rows deleted.
 */
export function purgeRecallBefore(sql: SqlStorage, day: string): number {
	if (!validDay(day)) throw Fail.of("validation", "the purge takes a UTC cutoff day");
	const daily = sql.exec<{ node_id: string; day: string }>("SELECT node_id, day FROM recall_daily WHERE day < ? ORDER BY day LIMIT ?", day, PURGE_ROWS).toArray();
	if (daily.length) sql.exec("DELETE FROM recall_daily WHERE (node_id, day) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))",
		JSON.stringify(daily.map((r) => [r.node_id, r.day])));
	const totals = daily.length < PURGE_ROWS
		? sql.exec<{ day: string }>("SELECT day FROM recall_totals WHERE day < ? ORDER BY day LIMIT ?", day, PURGE_ROWS - daily.length).toArray() : [];
	if (totals.length) sql.exec("DELETE FROM recall_totals WHERE day IN (SELECT value FROM json_each(?))", JSON.stringify(totals.map((r) => r.day)));
	return daily.length + totals.length;
}
