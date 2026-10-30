// The archive (profile v4, section 5): a removed row is kept whole, as JSON of `SELECT *`, until purge_after. Every removal
// except the 300-day purge can therefore be undone by putting the same columns back. Shared by C3 transfers and C4 cleanup.
import { assertArchiveEndpoints } from "./archive-fence";
import { Fail } from "../domain/types";

export const ARCHIVE_DAYS = 300;
export const ARCHIVE_SOURCES = ["nodes", "texts", "edges", "evidence", "revisions", "requests"] as const;
export type ArchiveSource = (typeof ARCHIVE_SOURCES)[number];
export type Row = Record<string, SqlStorageValue>;

/** Primary-key columns of each source, as declared in schema.ts. */
export const PK: Record<ArchiveSource, string[]> = {
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
	readonly archiveOperation?:string;
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
	archiveOperation?:string;
	/** `guard` defaults to none: C4's own transactions remove or flag, they never restore content. */
	constructor(readonly sql: SqlStorage, readonly seq: number, readonly now: string, readonly guard: (material: unknown) => void = () => {}) {}
	run(query: string, ...params: SqlStorageValue[]): { one(): Record<string, SqlStorageValue>; all: Record<string, SqlStorageValue>[] } {
		if (params.length > 100) throw Fail.of("size_budget", "one statement may bind at most 100 parameters");
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

function edgeFence(tx:ArchiveTx,source:ArchiveSource,row:Row):void {
	const node=source === "nodes"?row.id:["texts","revisions","requests"].includes(source)?row.node_id:source === "evidence"&&String(row.owner).startsWith("n:")?String(row.owner).slice(2):undefined;
	if(node!==undefined)assertArchiveEndpoints(tx.sql,String(node),String(node),"",false,tx.archiveOperation);
	let edge=source === "edges"?row:undefined;
	if(source === "evidence"&&String(row.owner).startsWith("e:"))edge=tx.sql.exec<Row>("SELECT src,dst,dst_profile FROM edges WHERE id=?",Number(String(row.owner).slice(2))).toArray()[0];
	if(edge)assertArchiveEndpoints(tx.sql,String(edge.src),String(edge.dst),String(edge.dst_profile),false,tx.archiveOperation);
}

/**
 * Archives rows that this transaction read with `SELECT * FROM <source>`, then deletes them; their tombstones take this
 * write's seq. Returns the archive ids in input order, for the inverse `restore` command.
 */
export function archiveRows(tx: ArchiveTx, activityId: number, source: ArchiveSource, rows: Row[], purgeAfterAt: string): number[] {
	if (!rows.length) return [];
	const pk = PK[source];
	for(const row of rows)edgeFence(tx,source,row);
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
	edgeFence(tx,source,image);
	const row: Row = { ...image, seq: tx.seq };
	if (source === "texts" && tx.sql.exec("SELECT 1 FROM texts WHERE rowid = ?", row.rowid!).toArray().length) delete row.rowid;
	if (source === "edges" && tx.sql.exec("SELECT 1 FROM edges WHERE id = ?", row.id!).toArray().length) delete row.id;
	const cols = Object.keys(row);
	if (!cols.every((c) => COLUMN.test(c))) throw Fail.of("validation", `a ${source} row image has an invalid column`);
	try {
		// evidence, revisions and requests are WITHOUT ROWID, so only an edge returns its (possibly new) id.
		const cursor = tx.run(`INSERT INTO ${source} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${source === "edges" ? " RETURNING id" : source === "texts" ? " RETURNING rowid" : ""}`,
			...cols.map((c) => row[c]!));
		return source === "edges" ? Number(cursor.one().id) : source === "texts" ? Number(cursor.one().rowid) : undefined;
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

/**
 * The removals an owner may restore from the archive: a forget, the 90-day capture TTL, and an undo of a restore. Other undo,
 * transfer and purge rows are not: their archived rows are an inverse or a moved record's leftovers.
 */
export const REMOVALS = ["forget", "ttl"];
export const ARCHIVE_PAGE_MAX = 50;

/** The node ids one removal archived. */
export const archivedNodeIds = (sql: SqlStorage, activityId: number): string[] =>
	sql.exec<{ id: string }>("SELECT json_extract(payload, '$.id') AS id FROM archive WHERE activity_id = ? AND source = 'nodes' ORDER BY id", activityId).toArray().map((r) => r.id);

/**
 * The owner's archive page (section 15): removals not yet restored, newest first, each with when it purges, what it holds and
 * whether a restore can still run (not wipe-redacted and not partly purged). Names are stored text, cut to 280 characters.
 */
export function archivePage(sql: SqlStorage, q: { before: number | null; limit: number }) {
	const limit = Math.min(Math.max(1, Math.trunc(q.limit)), ARCHIVE_PAGE_MAX);
	const acts = sql.exec<{ id: number; at: string; actor: string; op: string; summary: string; redacted: string | null; undo: string | null }>(
		`SELECT id, at, actor, op, summary, redacted, undo FROM activity a WHERE (op IN (SELECT value FROM json_each(?)) OR (op = 'undo' AND (EXISTS (SELECT 1 FROM activity r WHERE r.id = a.undo_of AND r.op = 'restore') OR EXISTS (SELECT 1 FROM profile_meta m WHERE m.key='archive-op:'||json_extract(a.undo,'$.archive_operation') AND json_extract(m.value,'$.action')='forget'))))
		AND undone_by IS NULL AND id < ? ORDER BY id DESC LIMIT ?`,
		JSON.stringify(REMOVALS), q.before ?? Number.MAX_SAFE_INTEGER, limit + 1).toArray();
	const page = acts.slice(0, limit);
	const rows = page.length ? sql.exec<{ activity_id: number; id: number; source: ArchiveSource; purge_after: string; payload: string }>(
		"SELECT activity_id, id, source, purge_after, CASE WHEN source = 'nodes' THEN payload END AS payload FROM archive WHERE activity_id IN (SELECT value FROM json_each(?))",
		JSON.stringify(page.map((a) => a.id))).toArray() : [];
	return {
		items: page.map((a) => {
			const mine = rows.filter((r) => r.activity_id === a.id), inverse = JSON.parse(a.undo ?? "{}") as { archived?: number[]; archive_operation?:string }, wanted = inverse.archived ?? [];
			const held = new Set(mine.map((r) => r.id));
			const staged=inverse.archive_operation?sql.exec<{value:string}>("SELECT value FROM profile_meta WHERE key=?",`archive-op:${inverse.archive_operation}`).toArray()[0]:undefined;
			const manifest=staged?JSON.parse(staged.value) as {state:string;action:string;rows:number}:undefined;
			const complete = manifest ? manifest.state === "complete" && manifest.action === "forget" && manifest.rows === mine.length : wanted.length > 0 && wanted.every((id) => held.has(id));
			return {
				activity_id: a.id, at: a.at, actor: a.actor, op: a.op, summary: a.summary, purge_after: mine.map((r) => r.purge_after).sort()[0] ?? null,
				rows: Object.fromEntries(ARCHIVE_SOURCES.map((s) => [s, mine.filter((r) => r.source === s).length]).filter(([, n]) => n)),
				nodes: mine.filter((r) => r.source === "nodes").map((r) => {
					const n = JSON.parse(r.payload) as Row;
					return { id: n.id, kind: n.kind, other_label: n.other_label, type: n.memory_type, scope: n.scope, status: n.status, name: String(n.name ?? "").slice(0, 280) };
				}),
				restorable: !a.redacted && complete, ...(a.redacted ? { reason: "undo_redacted" } : !complete ? { reason: "purged" } : {}),
			};
		}),
		next_before: acts.length > limit ? page.at(-1)!.id : null,
	};
}
