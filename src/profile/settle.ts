// Recovery settlement of transfers by the fixed rules of section 18, step 4. The account reads each side's facts for one
// transfer id, `settleRule` picks the action, and each side runs it here with the transfer protocol's own steps where one
// exists. Anything the rules do not name stays unresolved and keeps the account closed; nothing here merges two copies.
import { meGuard } from "../domain/guard";
import { Fail, fail, ok, type Outcome } from "../domain/types";
import { nextSeq } from "../storage";
import { BudgetTx, restoreArchived, type ArchiveTx, type Row } from "./archive";
import { bundleTexts, transferStep } from "./transfer";
import { assertOpen } from "./wipe";
import type { Who } from "./write";

/** A transfer's identity: its id, the bundle's SHA-256 and the bound source revision. */
export interface Identity { id: string; sha256?: string; revision: number }
/** One side of one transfer: its own row, the node's status and revision, and the identity it holds for this transfer. */
export interface SettleFacts {
	row: { direction: "out" | "in"; state: string; peer: string } | null;
	/** `transfer`: the transfer id the node is fenced or tombstoned for, whatever transfer this fact is about. */
	node: { status: string; revision: number; transfer: string | null } | null;
	identity: Identity | null;
}
export interface TransferScanRow { id: string; node_id: string; direction: "out" | "in"; peer: string; state: string }
export type SettleAction = "abort_in" | "abort_out" | "commit_out" | "settle_in" | "tombstone_out" | "undo_move" | "flag_tombstone";
/**
 * One profile's copy of a node, for the owner's choice between two copies (section 18, step 4): bounded card fields, the
 * transfer the node is fenced or tombstoned for, and an unpublished incoming landing, if any. Null when the profile has no row.
 */
export interface RecoveryCopy {
	status: string; revision: number; kind: string; name: string; description: string; updated_at: string; flagged: string | null;
	chars: number; content_hash: string; transfer: string | null; incoming: { id: string; from: string } | null;
	/** Every unfinished transfer row of the node here, which the owner's choice ends. */
	rows: { id: string; direction: "out" | "in"; state: string; peer: string }[];
	/** A moved copy only: whether undo_move can bring the whole record back now (undoPreflight), else why not. */
	restorable?: { ok: true } | { ok: false; reason: string };
}
export interface SettlePlan { source: SettleAction[]; target: SettleAction[]; owner: "source" | "target" | null; unresolved?: string }

const json = (s: unknown) => { try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; } };

/** Read only: what this profile holds for transfer `id` of node `nodeId` on `side`. */
export function settleFacts(sql: SqlStorage, id: string, nodeId: string, side: "out" | "in"): SettleFacts {
	const row = sql.exec<{ direction: "out" | "in"; state: string; peer: string }>("SELECT direction, state, peer FROM transfers WHERE id = ?", id).toArray()[0] ?? null;
	const node = sql.exec<{ status: string; revision: number; attrs: string }>("SELECT status, revision, attrs FROM nodes WHERE id = ?", nodeId).toArray()[0];
	let identity: Identity | null = null;
	if (side === "out" && node) {
		const t = json(node.attrs).transfer as { id?: string; sha256?: string; revision?: number } | undefined;
		if (t?.id === id && typeof t.revision === "number") identity = { id, ...(t.sha256 ? { sha256: t.sha256 } : {}), revision: t.revision };
	}
	if (side === "in") {
		const snap = sql.exec<{ snapshot: string }>("SELECT snapshot FROM revisions WHERE node_id = ? AND op = 'transferred_in' AND json_extract(snapshot, '$.transfer.id') = ? ORDER BY revision DESC LIMIT 1", nodeId, id).toArray()[0];
		const t = snap ? json(snap.snapshot).transfer as { sha256?: string; source_revision?: number } | undefined : undefined;
		if (t && typeof t.source_revision === "number") identity = { id, ...(t.sha256 ? { sha256: t.sha256 } : {}), revision: t.source_revision };
	}
	const fence = node ? (json(node.attrs).transfer as { id?: unknown } | undefined)?.id : undefined;
	return { row: row && row.direction === side ? row : null, node: node ? { status: node.status, revision: node.revision, transfer: typeof fence === "string" ? fence : null } : null, identity };
}

/** Read only. Names and descriptions are cut to 280 and 500 characters; the owner reads the whole record after the choice. */
export function recoveryCopy(storage: DurableObjectStorage, who: Who, nodeId: string): RecoveryCopy | null {
	const sql = storage.sql;
	const n = sql.exec<{ status: string; revision: number; kind: string; name: string; description: string; updated_at: string; flagged: string | null; chars: number; content_hash: string; attrs: string }>(
		"SELECT status, revision, kind, name, description, updated_at, flagged, chars, content_hash, attrs FROM nodes WHERE id = ?", nodeId).toArray()[0];
	if (!n) return null;
	const t = json(n.attrs).transfer as { id?: unknown } | undefined;
	const incoming = n.status === "incoming" ? sql.exec<{ id: string; from: string }>("SELECT id, peer AS \"from\" FROM transfers WHERE node_id = ? AND direction = 'in' AND state IN ('sent', 'landed') ORDER BY updated_at DESC LIMIT 1", nodeId).toArray()[0] ?? null : null;
	const rows = sql.exec<{ id: string; direction: "out" | "in"; state: string; peer: string }>("SELECT id, direction, state, peer FROM transfers WHERE node_id = ? AND state NOT IN ('committed', 'aborted') ORDER BY id LIMIT 20", nodeId).toArray();
	const transfer = typeof t?.id === "string" ? t.id : null;
	const pre = n.status === "moved" && transfer ? undoPreflight(storage, who, transfer, nodeId) : undefined;
	return { status: n.status, revision: n.revision, kind: n.kind, name: String(n.name ?? "").slice(0, 280), description: String(n.description ?? "").slice(0, 500), updated_at: n.updated_at,
		flagged: n.flagged, chars: n.chars, content_hash: n.content_hash, transfer, incoming, rows,
		...(n.status === "moved" ? { restorable: pre?.ok ? { ok: true as const } : { ok: false as const, reason: pre && !pre.ok ? String(pre.error.details?.reason ?? pre.error.code) : "no_transfer" } } : {}) };
}

const same = (a: Identity | null, b: Identity | null) => !!a && !!b && a.id === b.id && !!a.sha256 && a.sha256 === b.sha256 && a.revision === b.revision;
const LIVE = ["active", "retired", "superseded"];

/**
 * Section 18, step 4, one rule per line. `s` is the source's out side, `t` the target's in side; null is a profile the record
 * is not in. A node id that is in only one profile and in no transfer state needs nothing.
 */
export function settleRule(id: string, s: SettleFacts | null, t: SettleFacts | null): SettlePlan {
	const none: SettlePlan = { source: [], target: [], owner: null };
	const sNode = s?.node ?? null, tNode = t?.node ?? null;
	const sMoving = sNode?.status === "moving" && s!.identity?.id === id, sMoved = sNode?.status === "moved" && s!.identity?.id === id;
	const sLive = !!sNode && LIVE.includes(sNode.status);
	const unresolved = (why: string): SettlePlan => ({ ...none, unresolved: why });
	if (tNode?.status === "incoming" && t!.row) {
		// The target landed parts but never published. Its identity is written with the last part, so before it the id alone binds.
		const matches = (x: Identity | null) => !t!.identity || same(x, t!.identity);
		if (sMoving && matches(s!.identity)) return { source: ["abort_out"], target: ["abort_in"], owner: "source" };
		if (sLive && !s!.row) return { source: ["abort_out"], target: ["abort_in"], owner: "source" };
		if (sLive && s!.row && ["fenced", "sent", "aborted"].includes(s!.row.state)) return { source: ["abort_out"], target: ["abort_in"], owner: "source" };
		if (sMoved && matches(s!.identity)) return { source: ["undo_move"], target: ["abort_in"], owner: "source" };
		return unresolved("incoming_without_matching_source");
	}
	if (tNode && tNode.status !== "incoming" && t!.identity) {
		const settleIn: SettleAction[] = t!.row?.state === "published" ? ["settle_in"] : [];
		if (sMoving && same(s!.identity, t!.identity)) return { source: ["commit_out"], target: settleIn, owner: "target" };
		if (sMoved && same(s!.identity, t!.identity)) return { source: [], target: settleIn, owner: "target" };
		if (sLive && !s!.row && sNode!.revision <= t!.identity.revision) return { source: ["tombstone_out"], target: settleIn, owner: "target" };
		if (!sNode && !s?.row) return { source: [], target: settleIn, owner: "target" };
		return unresolved(sNode && LIVE.includes(sNode.status) && sNode.revision > t!.identity.revision ? "source_revision_past_bound" : "identities_differ");
	}
	if (!tNode) {
		if (sMoved) return { source: ["undo_move"], target: [], owner: "source" };
		if (sMoving) return { source: ["abort_out"], target: [], owner: "source" };
		return { ...none, owner: "source" };
	}
	// The target holds the id with no identity for this transfer: a source still fenced or tombstoned for it is a second copy.
	return sMoving || sMoved ? unresolved("target_holds_another_copy") : none;
}

/** One bounded settlement action on this profile; call again while `done` is false. Runs only inside an open recovery. */
export async function settleStep(storage: DurableObjectStorage, env: Env, who: Who, a: { action: SettleAction; id: string; nodeId: string; peer: string; identity?: Identity; flag?: string }): Promise<Outcome<{ done: boolean }>> {
	const sql = storage.sql;
	const step = async (s: Parameters<typeof transferStep>[3]) => {
		const r = await transferStep(storage, env, who, s);
		if (!r.ok) throw new Fail(r.error);
		return r.value;
	};
	try {
		assertOpen(sql);
		switch (a.action) {
			case "abort_in": return ok({ done: !!(await step({ op: "abort", id: a.id, side: "in", nodeId: a.nodeId, from: a.peer })).done });
			case "abort_out": return ok({ done: !!(await step({ op: "abort", id: a.id, side: "out", nodeId: a.nodeId, peer: a.peer })).done });
			case "settle_in": return ok({ done: !!(await step({ op: "settle", id: a.id })).done });
			case "commit_out": {
				// A restore can catch the source fenced after packing: the identity matched, so the bundle was validated and sent.
				if (sql.exec<{ state: string }>("SELECT state FROM transfers WHERE id = ?", a.id).toArray()[0]?.state === "fenced") await step({ op: "sent", id: a.id });
				return ok({ done: !!(await step({ op: "commit", id: a.id })).done });
			}
			case "tombstone_out": {
				// Restored to before the fence: fence it now under the target's identity, then the ordinary commit tombstones it.
				if (!sql.exec("SELECT 1 FROM transfers WHERE id = ?", a.id).toArray().length) {
					const n = sql.exec<{ status: string; revision: number }>("SELECT status, revision FROM nodes WHERE id = ?", a.nodeId).toArray()[0];
					if (!n || !LIVE.includes(n.status) || !a.identity || n.revision > a.identity.revision) throw Fail.of("validation", "the source record changed since the rule was chosen", { reason: "source_changed" });
					storage.transactionSync(() => {
						const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
						tx.run("INSERT INTO transfers (id, node_id, direction, peer, state, parts, created_at, updated_at, seq) VALUES (?, ?, 'out', ?, 'sent', 0, ?, ?, ?)", a.id, a.nodeId, a.peer, tx.now, tx.now, tx.seq);
						tx.run("UPDATE nodes SET status = 'moving', attrs = json_set(attrs, '$.transfer', json(?)), seq = ? WHERE id = ?",
							JSON.stringify({ id: a.id, to: a.peer, status: n.status, revision: a.identity!.revision, sha256: a.identity!.sha256 }), tx.seq, a.nodeId);
					});
				}
				return ok({ done: !!(await step({ op: "commit", id: a.id })).done });
			}
			case "undo_move": {
				// The whole restore is checked first, outside the restoring transactions; nothing changes on a refusal.
				if (sql.exec<{ status: string }>("SELECT status FROM nodes WHERE id = ?", a.nodeId).toArray()[0]?.status === "moved") {
					const pre = undoPreflight(storage, who, a.id, a.nodeId);
					if (!pre.ok) return pre;
				}
				return ok(storage.transactionSync(() => undoMove(sql, who, a.id, a.nodeId)));
			}
			case "flag_tombstone": {
				// The losing copy of an owner's choice: its tombstone says why, for the owner's later review.
				if ((json(sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE id = ? AND status = 'moved'", a.nodeId).toArray()[0]?.attrs).transfer as { id?: string } | undefined)?.id !== a.id) {
					throw Fail.of("validation", "the tombstone belongs to another transfer", { reason: "identities_differ" });
				}
				storage.transactionSync(() => { const seq = nextSeq(sql, "profile_meta"); sql.exec("UPDATE nodes SET flagged = ?, seq = ? WHERE id = ?", a.flag ?? "recovery: owner kept another copy", seq, a.nodeId); });
				return ok({ done: true });
			}
		}
	} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
}

/**
 * The guard a record restored into `me` passes (section 5): personal fields over every string of the material, JSON columns
 * decoded too (bundleTexts, the transfer guard's extraction). Outside me there is nothing to check.
 */
function restoreGuard(who: Who): (material: unknown) => void {
	if (who.profile !== "me") return () => {};
	return (material) => {
		const r = meGuard(bundleTexts(material));
		if (!r.ok) throw new Fail(r.error);
	};
}

/** The activity whose archive holds a moved record's image: its latest transfer_out with archive rows. */
const moveActivity = (sql: SqlStorage, nodeId: string) => sql.exec<{ id: number; redacted: string | null }>(`SELECT a.id, a.redacted FROM activity a WHERE a.op = 'transfer_out'
	AND EXISTS (SELECT 1 FROM json_each(a.targets) WHERE value = ?) AND EXISTS (SELECT 1 FROM archive r WHERE r.activity_id = a.id) ORDER BY a.id DESC LIMIT 1`, nodeId).toArray()[0];

/**
 * The record a restore makes readable again, beyond its archive: the revisions and request results the move left in place,
 * which can hold an older name or replaced content. All of it passes the guard, in pages.
 */
function guardRetained(sql: SqlStorage, guard: (material: unknown) => void, nodeId: string): void {
	for (const [table, key] of [["revisions", "revision"], ["requests", "request_id"]] as const) {
		for (let after: SqlStorageValue = table === "revisions" ? -1 : ""; ;) {
			const rows = sql.exec<Row>(`SELECT * FROM ${table} WHERE node_id = ? AND ${key} > ? ORDER BY ${key} LIMIT 200`, nodeId, after).toArray();
			if (!rows.length) break;
			guard(rows);
			after = rows.at(-1)![key]!;
		}
	}
}

/** This transfer's tombstone and its restorable move activity, or the refusal that names why not. Read only. */
function undoSource(sql: SqlStorage, id: string, nodeId: string): { activity: number; image: number } {
	const node = sql.exec<{ status: string; attrs: string }>("SELECT status, attrs FROM nodes WHERE id = ?", nodeId).toArray()[0];
	if (node?.status !== "moved" || (json(node.attrs).transfer as { id?: string } | undefined)?.id !== id) throw Fail.of("validation", "the record is not this transfer's tombstone here", { reason: "identities_differ" });
	const a = moveActivity(sql, nodeId);
	const image = a && sql.exec<{ id: number }>("SELECT id FROM archive WHERE activity_id = ? AND source = 'nodes' AND json_extract(payload, '$.id') = ?", a.id, nodeId).toArray()[0];
	if (!a || !image) throw Fail.of("not_found", "the moved record's archive is gone", { reason: "archive_missing" });
	if (a.redacted) throw Fail.of("validation", "a wipe redacted this move; it cannot be undone", { reason: "undo_redacted" });
	return { activity: a.id, image: image.id };
}

/** The first step of an undo, in the caller's transaction: the tombstone gives way to the archived image, flagged, with a `restored` revision. */
function restoreImage(tx: ArchiveTx, id: string, nodeId: string, src: { activity: number; image: number }): void {
	const sql = tx.sql, moved = Number(sql.exec<{ revision: number }>("SELECT revision FROM nodes WHERE id = ?", nodeId).one().revision);
	tx.run("DELETE FROM nodes WHERE id = ?", nodeId);
	restoreArchived(tx, [src.image]);
	tx.run("UPDATE nodes SET revision = ?, flagged = ?, seq = ? WHERE id = ?", moved + 1, "transfer: move undone by recovery; review", tx.seq, nodeId);
	tx.run("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, ?, 'restored', ?, 'recovery', ?, ?)", nodeId, moved + 1,
		JSON.stringify({ memory_id: nodeId, status: sql.exec<{ status: string }>("SELECT status FROM nodes WHERE id = ?", nodeId).one().status, _version: moved + 1, transfer_undone: id, activity: src.activity }), tx.now, tx.seq);
	tx.run("UPDATE transfers SET state = 'aborted', updated_at = ?, seq = ? WHERE id = ? AND direction = 'out'", tx.now, tx.seq, id);
}

/** Rolls back the dry run of undoPreflight once it has passed every constraint. */
class DryRun { }
/** The dry run's transaction: the real statements, the guard, and no row budget, since nothing it writes is kept. */
const unbounded = (sql: SqlStorage, guard: (material: unknown) => void): ArchiveTx => ({
	sql, seq: nextSeq(sql, "profile_meta"), now: new Date().toISOString(), guard,
	run: (query: string, ...params: SqlStorageValue[]) => {
		const all = sql.exec(query, ...params).toArray();
		return { one: () => { if (all.length !== 1) throw new Error(`expected one row, got ${all.length}`); return all[0]!; } };
	},
});

/**
 * Read only: whether undo_move of transfer `id` can bring the whole record back here now. It checks the tombstone, the archive
 * and any wipe redaction, guards the complete readable record in me (archive, retained revisions and requests), then runs the
 * whole restore in one transaction and rolls it back, so every unique key and identity, edge, fence and guard the real restore
 * meets is met here first. Every caller runs this before it changes either profile, and outside any other transaction.
 */
export function undoPreflight(storage: DurableObjectStorage, who: Who, id: string, nodeId: string): Outcome<null> {
	const sql = storage.sql;
	try {
		const src = undoSource(sql, id, nodeId), guard = restoreGuard(who);
		guardRetained(sql, guard, nodeId);
		try {
			storage.transactionSync(() => {
				const tx = unbounded(sql, guard);
				restoreImage(tx, id, nodeId, src);
				const rest = sql.exec<{ id: number }>("SELECT id FROM archive WHERE activity_id = ?", src.activity).toArray().map((r) => r.id);
				if (rest.length) restoreArchived(tx, rest);
				throw new DryRun();
			});
		} catch (e) { if (!(e instanceof DryRun)) throw e; }
		return ok(null);
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		if (e instanceof Error && /constraint failed/i.test(e.message)) return fail("revision_conflict", "the archived record collides with one held here now", { reason: "key_taken" });
		throw e;
	}
}

/**
 * The source restores a moved record from its archive and flags it, so the move is undone, not lost (section 18, step 4).
 * The tombstone gives way to the archived node image first, then the move's archived texts, edges and evidence come back in
 * bounded batches. History stays; a `restored` revision records the undo. The complete readable record passes the me guard
 * first, and every batch again. settleStep runs undoPreflight before the first transaction.
 */
function undoMove(sql: SqlStorage, who: Who, id: string, nodeId: string): { done: boolean } {
	const guard = restoreGuard(who), tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString(), guard);
	if (sql.exec<{ status: string }>("SELECT status FROM nodes WHERE id = ?", nodeId).toArray()[0]?.status === "moved") {
		const src = undoSource(sql, id, nodeId);
		guardRetained(sql, guard, nodeId);
		restoreImage(tx, id, nodeId, src);
		return { done: false };
	}
	// Only the archive of the move this undo restored, never an earlier move's leftovers.
	const undone = sql.exec<{ a: number | null }>("SELECT json_extract(snapshot, '$.activity') AS a FROM revisions WHERE node_id = ? AND op = 'restored' AND json_extract(snapshot, '$.transfer_undone') = ? ORDER BY revision DESC LIMIT 1", nodeId, id).toArray()[0]?.a;
	if (undone === undefined || undone === null) return { done: true };
	const left = sql.exec<{ id: number }>("SELECT id FROM archive WHERE activity_id = ? ORDER BY CASE source WHEN 'edges' THEN 0 WHEN 'evidence' THEN 1 ELSE 2 END, id LIMIT 25", undone).toArray();
	if (!left.length) return { done: true };
	restoreArchived(tx, left.map((r) => r.id));
	return { done: false };
}
