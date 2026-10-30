// The archive (profile v4, section 5): a removed row is kept whole, as JSON of `SELECT *`, until purge_after. Every removal
// except the 300-day purge can therefore be undone by putting the same columns back. Shared by C3 transfers and C4 cleanup.
import { Fail } from "../domain/types";

export const ARCHIVE_DAYS = 300;
export const ARCHIVE_SOURCES = ["nodes", "texts", "edges", "evidence", "revisions", "requests"] as const;
export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];
export type Row = Record<string, SqlStorageValue>;

/** Primary-key columns of each source, as declared in schema.ts. */
const PK: Record<ArchiveSource, string[]> = {
	nodes: ["id"], texts: ["rowid"], edges: ["id"], evidence: ["owner", "kind", "ref"], revisions: ["node_id", "revision"], requests: ["request_id"],
};
/** Restore order: a node before its texts, an edge before its evidence. */
const ORDER: ArchiveSource[] = ["nodes", "edges", "evidence", "texts", "revisions", "requests"];
const COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * What the archive needs from a write transaction. write.ts's Tx fits: run() counts rows and bytes against the 1,000-row,
 * 1 MB budget, and guard() checks restored material against the me guard inside the transaction (a no-op outside me).
 */
export interface ArchiveTx {
	readonly sql: SqlStorage;
	readonly seq: number;
	readonly now: string;
	run(query: string, ...params: SqlStorageValue[]): { one(): Record<string, SqlStorageValue> };
	guard(material: unknown): void;
}

const ROWS = 1_000, BYTES = 1_000_000;

/**
 * The import.ts Budget pattern for C4's own transactions (housekeeping, flags, leases): the real rowsWritten of every
 * statement, including index and trigger rows, and the bytes of every string bound. Past 1,000 rows or 1 MB it throws, which
 * rolls the transaction back. `spent()` lets a bounded step stop early with headroom for one more item.
 */
export class BudgetTx implements ArchiveTx {
	/** Starts charged with the nextSeq allocation that gives the transaction its seq: one profile_meta row, measured. */
	rows = 1;
	bytes = 0;
	/** `guard` defaults to none: C4's own transactions remove or flag, they never restore content. */
	constructor(readonly sql: SqlStorage, readonly seq: number, readonly now: string, readonly guard: (material: unknown) => void = () => {}) {}
	run(query: string, ...params: SqlStorageValue[]): { one(): Record<string, SqlStorageValue>; all: Record<string, SqlStorageValue>[] } {
		const cursor = this.sql.exec(query, ...params);
		const all = cursor.toArray();
		this.rows += cursor.rowsWritten;
		for (const p of params) if (typeof p === "string") this.bytes += Buffer.byteLength(p, "utf8");
		if (this.rows > ROWS || this.bytes > BYTES) throw Fail.of("size_budget", `one transaction may write at most 1,000 rows and 1,000,000 bytes; this one reached ${this.rows} rows and ${this.bytes} bytes`);
		return { one: () => { if (all.length !== 1) throw new Error(`expected one row, got ${all.length}`); return all[0]!; }, all };
	}
	/** True once this transaction used `share` of either budget. */
	spent(share: number): boolean {
		return this.rows > ROWS * share || this.bytes > BYTES * share;
	}
}

export const purgeAfter = (now: string, days = ARCHIVE_DAYS) => new Date(Date.parse(now) + days * 86_400_000).toISOString();

/**
 * Archives rows that this transaction read with `SELECT * FROM <source>`, then deletes them; their tombstones take this
 * write's seq. Returns the archive ids in input order, for the inverse `restore` command.
 */
export function archiveRows(tx: ArchiveTx, activityId: number, source: ArchiveSource, rows: Row[], purgeAfterAt: string): number[] {
	if (!rows.length) return [];
	const pk = PK[source];
	const ids = rows.map((r) => {
		if (pk.some((c) => r[c] === undefined || r[c] === null)) throw Fail.of("validation", `an archived ${source} row needs its key columns`);
		return Number(tx.run("INSERT INTO archive (activity_id, at, purge_after, source, payload, seq) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
			activityId, tx.now, purgeAfterAt, source, JSON.stringify(r), tx.seq).one().id);
	});
	// Keys as one JSON parameter, so any number of rows stays within 100 bound parameters.
	tx.run(`DELETE FROM ${source} WHERE (${pk.join(", ")}) IN (SELECT ${pk.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?))`,
		JSON.stringify(rows.map((r) => pk.map((c) => r[c]))));
	return ids;
}

/**
 * Puts archived rows back with the same columns, stamped with this write's seq, and removes their archive rows. Every
 * restored row passes tx.guard first. Returns the restored node ids; restored memory nodes are due for embedding again. A key or unique identity taken since is a
 * revision_conflict and the transaction rolls back. An integer key SQLite reused meanwhile gets a fresh one instead: a text
 * takes any free rowid, and a restored edge's evidence follows its new id.
 */
export function restoreArchived(tx: ArchiveTx, archiveIds: number[]): { nodes: string[] } {
	const wanted = [...new Set(archiveIds)];
	const rows = tx.sql.exec<{ id: number; source: ArchiveSource; payload: string }>(
		"SELECT id, source, payload FROM archive WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(wanted)).toArray();
	if (rows.length !== wanted.length) throw Fail.of("not_found", "some archived rows are gone: purged after 300 days, or already restored", { reason: "archive_missing" });
	rows.sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source) || a.id - b.id);
	tx.guard(rows.map((a) => JSON.parse(a.payload) as Row));
	const edgeIds = new Map<string, number>();
	const nodes: string[] = [];
	for (const a of rows) {
		const row = JSON.parse(a.payload) as Row;
		if (a.source === "nodes") {
			nodes.push(String(row.id));
			// Its vector may have been cleaned up lazily while it was archived.
			if (row.memory_type !== null) row.embed_hash = null;
		}
		if (a.source === "evidence" && typeof row.owner === "string" && edgeIds.has(row.owner)) row.owner = `e:${edgeIds.get(row.owner)}`;
		const id = putRow(tx, a.source, row);
		if (a.source === "edges") edgeIds.set(`e:${String(row.id)}`, id!);
	}
	tx.run("DELETE FROM archive WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(wanted));
	return { nodes };
}

/**
 * Inserts one row image stamped with this write's seq. A text or edge whose integer key was reused gets a fresh key; an
 * edge returns its id. Any other key or unique identity taken since is a revision_conflict.
 */
export function putRow(tx: ArchiveTx, source: ArchiveSource, image: Row): number | undefined {
	const row: Row = { ...image, seq: tx.seq };
	if (source === "texts" && tx.sql.exec("SELECT 1 FROM texts WHERE rowid = ?", row.rowid!).toArray().length) delete row.rowid;
	if (source === "edges" && tx.sql.exec("SELECT 1 FROM edges WHERE id = ?", row.id!).toArray().length) delete row.id;
	const cols = Object.keys(row);
	if (!cols.every((c) => COLUMN.test(c))) throw Fail.of("validation", `a ${source} row image has an invalid column`);
	try {
		// evidence, revisions and requests are WITHOUT ROWID, so only an edge returns its (possibly new) id.
		const cursor = tx.run(`INSERT INTO ${source} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${source === "edges" ? " RETURNING id" : ""}`,
			...cols.map((c) => row[c]!));
		return source === "edges" ? Number(cursor.one().id) : undefined;
	} catch (e) {
		if (e instanceof Error && !(e instanceof Fail) && /constraint failed/i.test(e.message)) {
			throw Fail.of("revision_conflict", "changed since; review by hand", { reason: "key_taken", source });
		}
		throw e;
	}
}

/**
 * Forget: archives a node with everything that hangs off it in this profile (texts, revisions, its edges in both directions
 * and their evidence). Request records stay, so a retried request still replays. Callers check mayChange first.
 */
export function archiveNode(tx: ArchiveTx, activityId: number, id: string, purgeAfterAt: string): number[] {
	const sql = tx.sql;
	const edges = sql.exec<Row>("SELECT * FROM edges WHERE src = ? OR (dst = ? AND dst_profile = '')", id, id).toArray();
	const owners = JSON.stringify([`n:${id}`, ...edges.map((e) => `e:${String(e.id)}`)]);
	return [
		...archiveRows(tx, activityId, "evidence", sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?))", owners).toArray(), purgeAfterAt),
		...archiveRows(tx, activityId, "edges", edges, purgeAfterAt),
		...archiveRows(tx, activityId, "texts", sql.exec<Row>("SELECT * FROM texts WHERE node_id = ?", id).toArray(), purgeAfterAt),
		...archiveRows(tx, activityId, "revisions", sql.exec<Row>("SELECT * FROM revisions WHERE node_id = ?", id).toArray(), purgeAfterAt),
		...archiveRows(tx, activityId, "nodes", sql.exec<Row>("SELECT * FROM nodes WHERE id = ?", id).toArray(), purgeAfterAt),
	];
}
