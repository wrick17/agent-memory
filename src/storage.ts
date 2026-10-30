// Shared SQLite conventions for both stores: versioned migrations, write sequence stamps and delete tombstones (section 5).

export type Migration = string[];

/** Runs every migration above the stored schema_version, each in one transaction. Call from blockConcurrencyWhile. */
export function migrate(storage: DurableObjectStorage, metaTable: string, migrations: Migration[]): void {
	const sql = storage.sql;
	sql.exec(`CREATE TABLE IF NOT EXISTS ${metaTable} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
	const current = Number(sql.exec<{ value: string }>(`SELECT value FROM ${metaTable} WHERE key = 'schema_version'`).toArray()[0]?.value ?? 0);
	migrations.slice(current).forEach((statements, i) => {
		storage.transactionSync(() => {
			for (const s of statements) sql.exec(s);
			sql.exec(`INSERT OR REPLACE INTO ${metaTable} (key, value) VALUES ('schema_version', ?)`, String(current + i + 1));
		});
	});
}

/** Takes the next write sequence number, and the rows taking it wrote. Every row a transaction touches is stamped with it. */
export function takeSeq(sql: SqlStorage, metaTable: string): { seq: number; rows: number } {
	const cursor = sql.exec<{ value: string }>(
		`INSERT INTO ${metaTable} (key, value) VALUES ('write_seq', '1')
		 ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`);
	return { seq: Number(cursor.one().value), rows: cursor.rowsWritten };
}
export const nextSeq = (sql: SqlStorage, metaTable: string): number => takeSeq(sql, metaTable).seq;

/** AFTER DELETE writes a tombstone at the current write_seq; AFTER INSERT removes the key's tombstone. */
export function tombstoneTriggers(metaTable: string, table: string, pkExpr: (row: "OLD" | "NEW") => string): string[] {
	const seq = `(SELECT CAST(value AS INTEGER) FROM ${metaTable} WHERE key = 'write_seq')`;
	return [
		`CREATE TRIGGER ${table}_tomb_del AFTER DELETE ON ${table} BEGIN
			INSERT OR REPLACE INTO deleted_rows (tbl, pk, seq) VALUES ('${table}', ${pkExpr("OLD")}, ${seq}); END`,
		`CREATE TRIGGER ${table}_tomb_ins AFTER INSERT ON ${table} BEGIN
			DELETE FROM deleted_rows WHERE tbl = '${table}' AND pk = ${pkExpr("NEW")}; END`,
	];
}

export const DELETED_ROWS = [
	"CREATE TABLE deleted_rows (tbl TEXT NOT NULL, pk TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (tbl, pk)) WITHOUT ROWID",
	"CREATE INDEX deleted_rows_seq ON deleted_rows (seq, tbl, pk)",
];
