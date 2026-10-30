// The row meter (sections 5 and 6): every statement's real rowsWritten in this profile object, flushed into the durable
// `cursors.meter` count after each mutating entry point, reported to AccountStore.meter once per alarm step. Background stages
// pause for the rest of the UTC day once the account's daily count reaches ROW_PAUSE; agent writes never wait on it.

/**
 * Free allows 100,000 rows written a day per account. AccountStore's own rows are not counted:
 * shortcut: AccountStore rows are uncounted and covered by 20,000 rows of headroom; count them if Free ever becomes a gate.
 */
export const ROW_PAUSE = 80_000;

type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;
const open = new WeakMap<SqlStorage, { cursors: Cursor[]; pending: number }>();

/**
 * Wraps this object's `sql.exec` once, summing its cursor's rowsWritten, including index, trigger, tombstone, full-text and
 * unread RETURNING rows. A failed cursor read is retained for retry. Rows a
 * rolled-back transaction wrote are counted as well, and the flush's own upsert is counted by the next flush: both overcount.
 * An eviction before a flush loses the in-memory count, including counts retained across flush failures.
 */
export function countRows(storage: DurableObjectStorage): void {
	const sql = storage.sql;
	if (open.has(sql)) return;
	const state = { cursors: [] as Cursor[], pending: 0 };
	open.set(sql, state);
	const exec = sql.exec.bind(sql);
	sql.exec = ((query: string, ...params: SqlStorageValue[]) => {
		const cursor = exec(query, ...params);
		// Workers materializes writes, including unread RETURNING, at exec. Read-only calls retain no cursor.
		try { state.pending += cursor.rowsWritten; } catch { state.cursors.push(cursor); }
		return cursor;
	}) as SqlStorage["exec"];
}

/** Adds the rows counted since the last flush to `cursors.meter`. An unbound or closed object writes no meter state. */
export function flushRows(storage: DurableObjectStorage): number {
	const sql = storage.sql, state = open.get(sql);
	if (!state) return 0;
	state.cursors = state.cursors.filter((c) => {
		try { state.pending += c.rowsWritten; return false; } catch { return true; }
	});
	const rows = state.pending;
	if (!rows) return 0;
	try {
		const meta = sql.exec<{ key: string }>("SELECT key FROM profile_meta WHERE key IN ('user_id', 'closed')").toArray().map((r) => r.key);
		if (!meta.includes("user_id") || meta.includes("closed")) return 0;
		sql.exec(`INSERT INTO cursors (stage, cursor, due_at) VALUES ('meter', ?, 0)
			ON CONFLICT (stage) DO UPDATE SET cursor = CAST(COALESCE(cursor, '0') AS INTEGER) + CAST(excluded.cursor AS INTEGER)`, String(rows));
		state.pending -= rows;
		return rows;
	} catch { return 0; } // Metering fails open; retain the pending count for the next flush.
}

/** The flushed count not yet acknowledged by AccountStore. */
export const pendingRows = (sql: SqlStorage): number =>
	Number(sql.exec<{ n: string | null }>("SELECT cursor AS n FROM cursors WHERE stage = 'meter'").toArray()[0]?.n ?? 0);

/** Takes an acknowledged report off the durable count; rows flushed since the report stay. */
export function ackRows(sql: SqlStorage, reported: number): void {
	sql.exec("UPDATE cursors SET cursor = CAST(COALESCE(cursor, '0') AS INTEGER) - ?, last_run_at = ?, last_error = NULL WHERE stage = 'meter'", reported, new Date().toISOString());
}

/** The next 00:00 UTC, when the account's daily count starts again. */
export const nextUtcDay = (now: number): number => (Math.floor(now / 86_400_000) + 1) * 86_400_000;
