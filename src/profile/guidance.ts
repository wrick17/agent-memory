// Guidance receipts (#127): whether injected lessons, rules and decisions helped. A session report lists the memory items its
// briefing injected; each becomes one pending row per (session, memory). The nightly batch processes the session's digest
// (its preference_signal and unprocessed_capture items); once none of them is open, every pending row of the session settles:
// failed when a correction of that session matched the lesson (record_lesson with matches, or a same-name merge), else followed.
// A correction match is also stored on its own row, which gives the Goals tab an exact repeat-correction count.
import { sha256 } from "../domain/ids";

/** An inferred lesson leaves briefings once it failed at least `drop_failed` times and in more than `drop_ratio` of processed sessions. */
export const GUIDANCE_RULES = Object.freeze({ drop_failed: 3, drop_ratio: 0.5 });
/** Rows kept per table: injections 120 days (as fact receipts), correction matches 400 days (as daily cost rows). */
const KEEP_DAYS = { injections: 120, matches: 400 } as const;
const PRUNE_ROWS = 200;

export interface GuidanceStats { injected: number; processed: number; failed: number; followed: number; followed_rate: number | null }
type RunTx = { sql: SqlStorage; seq: number; now: string; run(q: string, ...p: SqlStorageValue[]): unknown };

/** The facts client's session ref for a session node key `session:<client>:<id>`: client and sha256(id)[0:12]. */
export function sessionRefOf(key: string | null): string | null {
	const [kind, client, ...rest] = (key ?? "").split(":");
	return kind === "session" && client && rest.length ? `${client}:${sha256(rest.join(":")).slice(0, 12)}` : null;
}
const ago = (now: string, days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

/** Per memory id: sessions it was injected in, how many the batch processed, how many failed. Ids without rows are absent. */
export function guidanceStats(sql: SqlStorage, ids: string[]): Map<string, GuidanceStats> {
	if (!ids.length) return new Map();
	return new Map(sql.exec<{ memory_id: string; injected: number; processed: number; failed: number }>(`SELECT memory_id, count(*) AS injected,
		sum(state <> 'pending') AS processed, sum(state = 'failed') AS failed FROM guidance_injections WHERE memory_id IN (SELECT value FROM json_each(?)) GROUP BY memory_id`,
		JSON.stringify([...new Set(ids)])).toArray().map((r) => [r.memory_id, { injected: r.injected, processed: r.processed, failed: r.failed, followed: r.processed - r.failed,
		followed_rate: r.processed ? (r.processed - r.failed) / r.processed : null }]));
}

/** Whether an inferred lesson keeps failing and leaves briefings; stated records are never dropped automatically. */
export const failing = (origin: string, s: GuidanceStats | undefined) =>
	origin === "inferred" && !!s && s.failed >= GUIDANCE_RULES.drop_failed && s.failed / s.processed > GUIDANCE_RULES.drop_ratio;

/**
 * A session report's injected memory items (report time). Only memories of this profile count; `me` items live elsewhere. A
 * session the batch already processed settles at once, so a late report still counts. Repeats of the same pair are ignored.
 */
export function recordInjections(tx: RunTx, session: string, memoryIds: string[]): void {
	const sql = tx.sql;
	const local = memoryIds.length ? sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND memory_type IS NOT NULL AND scope <> 'repo-fact'`,
		JSON.stringify([...new Set(memoryIds)])).toArray().map((r) => r.id) : [];
	const processed = sql.exec("SELECT 1 FROM guidance_sessions WHERE session_ref = ?", session).toArray().length > 0;
	for (const id of local) {
		const failed = processed && sql.exec("SELECT 1 FROM correction_matches WHERE session_ref = ? AND rule_id = ? LIMIT 1", session, id).toArray().length > 0;
		tx.run("INSERT OR IGNORE INTO guidance_injections (session_ref, memory_id, state, at, seq) VALUES (?, ?, ?, ?, ?)",
			session, id, processed ? (failed ? "failed" : "followed") : "pending", tx.now, tx.seq);
	}
	tx.run(`DELETE FROM guidance_injections WHERE rowid IN (SELECT rowid FROM guidance_injections WHERE at < ? LIMIT ${PRUNE_ROWS})`, ago(tx.now, KEEP_DAYS.injections));
	tx.run(`DELETE FROM correction_matches WHERE rowid IN (SELECT rowid FROM correction_matches WHERE at < ? LIMIT ${PRUNE_ROWS})`, ago(tx.now, KEEP_DAYS.matches));
}

/**
 * When the batch finishes an item for sessions (batch time, in the item's own transaction): stores each correction match
 * (`index`: the record_lesson op's position in the item) and, for every session with no open digest item left, marks it processed
 * and settles its pending injections.
 */
export function settleSessions(tx: RunTx, sessions: string[], matches: { rule: string; index: number }[]): void {
	const sql = tx.sql;
	for (const s of sql.exec<{ id: string; key: string; first: string }>(`SELECT id, key, coalesce(json_extract(attrs, '$.first_at'), created_at) AS first FROM nodes
		WHERE id IN (SELECT value FROM json_each(?)) AND kind = 'session'`, JSON.stringify(sessions)).toArray()) {
		const ref = sessionRefOf(s.key);
		if (!ref) continue;
		for (const m of matches) {
			const created = sql.exec<{ created_at: string }>("SELECT created_at FROM nodes WHERE id = ?", m.rule).toArray()[0]?.created_at;
			tx.run(`INSERT OR IGNORE INTO correction_matches (session_ref, session_id, rule_id, correction_index, repeat, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				ref, s.id, m.rule, m.index, created !== undefined && created < s.first ? 1 : 0, tx.now, tx.seq);
		}
		const open = sql.exec(`SELECT 1 FROM maintenance m, json_each(m.subjects) j WHERE m.kind IN ('preference_signal', 'unprocessed_capture')
			AND m.state IN ('open', 'leased', 'stuck') AND j.value = ? LIMIT 1`, s.id).toArray().length > 0;
		if (open) continue;
		tx.run("INSERT OR IGNORE INTO guidance_sessions (session_ref, session_id, processed_at, seq) VALUES (?, ?, ?, ?)", ref, s.id, tx.now, tx.seq);
		// Every row of the session, not only pending ones: a later capture range of the same session may add a match that turns
		// a followed item into a failed one.
		tx.run(`UPDATE guidance_injections SET state = CASE WHEN EXISTS (SELECT 1 FROM correction_matches c WHERE c.session_ref = guidance_injections.session_ref
			AND c.rule_id = guidance_injections.memory_id) THEN 'failed' ELSE 'followed' END, seq = ? WHERE session_ref = ?`, tx.seq, ref);
	}
}
