// Compaction publishes a fence first; bounded folding removes hidden entries from the search indexes afterwards.
import { sha256 } from "../domain/ids";
import { Fail, type SaveArgs } from "../domain/types";
import { nextSeq } from "../storage";
import { BudgetTx, type ArchiveTx } from "./archive";
import { assertWritable } from "./transfer";
import { assertOpen } from "./wipe";
import { activity, cardText, chunks, contentHash, readContent, readNode, result, writeRevision, type NodeRow, type Tx, type WriteOutput } from "./write";

export const fenceOf = (attrs: string): number => Number((JSON.parse(attrs) as { compacted_through?: number }).compacted_through ?? 0);
/** Shared by content readers, recall channels and passages, with aliases t and n. */
export const VISIBLE = `t.live <> 0 AND (t.part <> 'entry' OR t.seq_no > COALESCE(json_extract(n.attrs, '$.compacted_through'), 0))`;
export function contentRows(sql: SqlStorage, id: string) {
	return sql.exec<{ part: string; chunk: number; separator: string | null; body: string }>(`SELECT t.part, t.chunk, t.separator, t.body FROM texts t LEFT JOIN nodes n ON n.id = t.node_id
		WHERE t.node_id = ? AND t.part IN ('body','summary','entry') AND ${VISIBLE} ORDER BY CASE t.part WHEN 'body' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END, t.seq_no, t.chunk`, id);
}

/** One content-free cursor per node avoids a growing shared JSON list. */
export function queueFold(tx: ArchiveTx, id: string): void {
	tx.run(`INSERT INTO cursors (stage, due_at) VALUES (?, 0) ON CONFLICT(stage) DO UPDATE SET due_at = 0`, `fold:${id}`);
}
export const foldDue = (sql: SqlStorage): boolean => sql.exec("SELECT 1 FROM cursors WHERE stage LIKE 'fold:%' LIMIT 1").toArray().length > 0;

export function compact(tx: Tx, a: SaveArgs, node: NodeRow): WriteOutput {
	const c = a.compact!;
	if (node.kind !== "journal" || !a.request_id || !Number.isSafeInteger(a.expected_revision) || a.expected_revision! < 1
		|| !c || !Number.isSafeInteger(c.through_seq) || typeof c.summary !== "string" || !c.summary.trim() || c.summary.length > 64_000
		|| ["content", "description", "why", "how_to_apply", "objective", "steps", "new_name", "retire", "supersedes", "origin", "evidence", "links"].some((k) => k in a)) {
		throw Fail.of("validation", "compact needs a journal, expected_revision, request_id, through_seq and a summary, with no other changes", { reason: "invalid_compact" });
	}
	const F = fenceOf(node.attrs);
	if (a.expected_revision! > node.revision || tx.sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND revision > ? LIMIT 1", node.id, a.expected_revision!).toArray().length) {
		throw Fail.of("revision_conflict", "the journal changed beyond appends", { actual_revision: node.revision, expected_revision: a.expected_revision });
	}
	const newest = Number(tx.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq_no), 0) AS n FROM texts WHERE node_id = ? AND part = 'entry' AND revision <= ?", node.id, a.expected_revision!).one().n);
	if (c.through_seq <= F) throw Fail.of("validation", "this prefix is already compacted", { reason: "already_compacted" });
	const selected = tx.sql.exec<{ chars: number; rows: number }>(`SELECT COALESCE(SUM(length(body) + CASE WHEN chunk = 0 THEN length(COALESCE(separator, '')) ELSE 0 END), 0) AS chars, COUNT(*) AS rows
		FROM texts WHERE node_id = ? AND part = 'entry' AND live <> 0 AND seq_no > ? AND seq_no <= ?`, node.id, F, c.through_seq).one();
	if (c.through_seq > newest || !selected.rows) throw Fail.of("validation", "through_seq must name a visible prefix seen at expected_revision", { reason: "invalid_prefix" });
	if (tx.ctx.actor === "maintenance" && selected.chars > 24_000) throw Fail.of("size_budget", "maintenance compacts at most 24,000 characters at once");
	const revision = node.revision + 1;
	tx.run("UPDATE texts SET live = 0, seq = ? WHERE node_id = ? AND part = 'summary' AND live = 1", tx.seq, node.id);
	chunks(c.summary).forEach((body, chunk) => tx.run(`INSERT INTO texts (node_id, part, revision, chunk, body, request_id, actor, created_at, seq) VALUES (?, 'summary', ?, ?, ?, ?, ?, ?, ?)`,
		node.id, revision, chunk, body, tx.requestId, tx.ctx.actor, tx.now, tx.seq));
	tx.run("UPDATE nodes SET attrs = ?, seq = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(node.attrs), compacted_through: c.through_seq }), tx.seq, node.id);
	const body = readContent(tx.sql, node.id);
	const hash = contentHash({ ...node, type: node.memory_type!, content: body, steps: [] });
	const card = sha256(cardText(node, body));
	tx.run("UPDATE nodes SET revision = ?, chars = ?, content_hash = ?, card_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?",
		revision, body.length, hash, card, tx.now, tx.ctx.platform, tx.seq, node.id);
	const updated = readNode(tx.sql, node.id)!;
	writeRevision(tx, updated, "compacted", undefined);
	tx.run("UPDATE revisions SET delta = ? WHERE node_id = ? AND revision = ?", JSON.stringify({ from_seq: F, through_seq: c.through_seq, summary_revision: revision }), node.id, revision);
	const activityId = activity(tx, "compact", `compacted journal prefix through ${c.through_seq}`, [node.id]);
	queueFold(tx, node.id);
	return { result: result(updated, "compacted", { through_seq: c.through_seq, activity_id: activityId }), created: [], embedDue: card !== node.card_hash };
}

/** An undo has passed all conflict and guard checks, but must reindex these rows before publishing its old fence. */
export class Unfold { constructor(readonly id: string, readonly after: number, readonly through: number) {} }
export function unfoldStep(storage: DurableObjectStorage, pending: Unfold): void {
	storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		assertWritable(sql, pending.id);
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
		tx.run(`UPDATE texts SET live = 1, seq = ? WHERE rowid IN (SELECT rowid FROM texts WHERE node_id = ? AND part = 'entry' AND live = 2 AND seq_no > ? AND seq_no <= ? ORDER BY seq_no, chunk LIMIT 100)`,
			tx.seq, pending.id, pending.after, pending.through);
	});
}

/** At most 100 text rows per transaction; Workers counts both FTS triggers and the seq index through BudgetTx. */
export function foldStep(storage: DurableObjectStorage): { changed: number; rows: number; more: boolean } {
	if (!foldDue(storage.sql)) return { changed: 0, rows: 0, more: false };
	return storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const stage = sql.exec<{ stage: string }>("SELECT stage FROM cursors WHERE stage LIKE 'fold:%' ORDER BY due_at, stage LIMIT 1").one().stage;
		const id = stage.slice(5), node = readNode(sql, id);
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
		let changed = 0;
		if (node && !["moving", "incoming", "moved"].includes(node.status)) {
			const F = fenceOf(node.attrs);
			const rows = sql.exec<{ rowid: number }>(`SELECT rowid FROM texts WHERE node_id = ? AND part = 'entry' AND ((live = 1 AND seq_no <= ?) OR (live = 2 AND seq_no > ?)) ORDER BY seq_no, chunk LIMIT 100`, id, F, F).toArray();
			changed = rows.length;
			if (changed) tx.run("UPDATE texts SET live = CASE WHEN seq_no <= ? THEN 2 ELSE 1 END, seq = ? WHERE rowid IN (SELECT value FROM json_each(?))", F, tx.seq, JSON.stringify(rows.map((r) => r.rowid)));
		}
		if ((!node || node.status === "moved") || (node && !["moving", "incoming"].includes(node.status) && changed < 100)) tx.run("DELETE FROM cursors WHERE stage = ?", stage);
		return { changed, rows: tx.rows, more: foldDue(sql) };
	});
}
