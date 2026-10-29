// The import's transaction budget and cost estimate, shared by the planner (local/migrate.mjs), the server
// (profile/import.ts) and the tests. Pure, so Node and workerd load the same numbers.

/** One import command writes at most 1,000 rows and 1,000,000 UTF-8 bytes, counted by the server. */
export const IMPORT_BUDGET = { rows: 1000, bytes: 1_000_000 };
/** A text row holds at most 16,000 characters (the texts CHECK). */
export const TEXT_CHUNK = 16_000;
/**
 * Rows one staged row writes, as Workers SQLite reports them in rowsWritten (measured on schema v3; checked against the
 * server in test/import.test.ts): a live text row 5 (the row, two indexes, the full-text and trigram rows), a history
 * text row 3, a revision 2 (row and sequence index), a request 3 (row, sequence and node indexes).
 */
export const ROW_COST = { live: 5, history: 3, revision: 2, request: 3 };
/** A part's own writes: the sequence stamp, its ledger row and the record row, with room to spare. */
export const PART_OVERHEAD = { rows: 12, bytes: 8192 };

const utf8 = (s: string) => new TextEncoder().encode(s).length;

export type Table = "texts" | "revisions" | "requests";
type Row = Record<string, unknown> & { live?: boolean; body?: string };

/** A row's estimated cost. Bytes: its whole JSON, plus twice the body of a live text for its two index copies. */
export function rowCost(table: Table, row: Row): { rows: number; bytes: number } {
	const live = table === "texts" && row.live === true;
	return {
		rows: table === "texts" ? (live ? ROW_COST.live : ROW_COST.history) : table === "revisions" ? ROW_COST.revision : ROW_COST.request,
		bytes: utf8(JSON.stringify(row)) + (live ? 2 * utf8(String(row.body)) : 0),
	};
}

/** Publishing a record writes its node row and its live head text; an estimate from the node's own JSON. */
export function publishCost(node: Record<string, unknown>): { rows: number; bytes: number } {
	const head = ["name", "description", "why", "how_to_apply", "objective"].map((k) => String(node[k] ?? "")).join("\n") + JSON.stringify(node.steps ?? []);
	const headChunks = Math.max(1, Math.ceil(head.length / TEXT_CHUNK));
	return { rows: 40 + headChunks * ROW_COST.live, bytes: utf8(JSON.stringify(node)) + 3 * utf8(head) + PART_OVERHEAD.bytes };
}

export interface Part { rows: { texts: Row[]; revisions: Row[]; requests: Row[] }; cost: { rows: number; bytes: number } }

/** Rows into parts, in order, each within the budget with its overhead. Throws `oversize_row` for a row no part can hold. */
export function pack(rows: [Table, Row][]): Part[] {
	const parts: Part[] = [];
	let cur: Part | null = null;
	for (const [table, row] of rows) {
		const c = rowCost(table, row);
		if (c.rows + PART_OVERHEAD.rows > IMPORT_BUDGET.rows || c.bytes + PART_OVERHEAD.bytes > IMPORT_BUDGET.bytes) throw Object.assign(new Error("a single row exceeds the part budget"), { code: "oversize_row" });
		if (!cur || cur.cost.rows + c.rows > IMPORT_BUDGET.rows || cur.cost.bytes + c.bytes > IMPORT_BUDGET.bytes) {
			cur = { rows: { texts: [], revisions: [], requests: [] }, cost: { ...PART_OVERHEAD } };
			parts.push(cur);
		}
		cur.rows[table].push(row);
		cur.cost.rows += c.rows;
		cur.cost.bytes += c.bytes;
	}
	return parts;
}
