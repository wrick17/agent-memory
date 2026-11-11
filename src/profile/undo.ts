import { managedCount, countPair, sameCountEdge, undoCommitReceipt, reverseObservation, nextClaim, sealedDependency, sealedStructural, liveCommit, type CommitReceipt, type EndpointClaim } from "./work-counts";
import { assertArchiveEndpoints } from "./archive-fence";
// Undo (section 12). Every write stores the inverse of what it changed in activity.undo, in the same transaction; undo runs
// that inverse through runWrite with request_id "undo:<activity id>", so a retried undo replays its first result. The inverse
// is row-level, which covers every op type alike: all rows a write touches carry its seq, so afterwards they say what changed,
// and images read before it say what to put back.
import { fenceOf, queueFold, Unfold } from "./compact";
import { normalizeName, requestHash } from "../domain/ids";
import { Fail, type ErrorCode, type WriteCommand, type WriteContext } from "../domain/types";
import { markUndone } from "./daily-proof";
import { archivedNodeIds, archiveNode, archiveRows, purgeAfter, putRow, REMOVALS, restoreArchived, type ArchiveTx, type Row } from "./archive";
import { readNode, runWrite, snapshot, type Who, type WriteOutput } from "./write";
import type { Consumed } from "./extract";
import { assertWritable } from "./transfer";
import { assertNotWiped } from "./wipe";
import { snapshotEdges, uploadKey, uploadNodeKeys } from "./work-upload";
import { liveFactIds } from "./facts";

/** At most this many candidate nodes, and edges around them, are imaged; a write that changes anything else stores no undo. */
const MAX_IMAGES = 200;
const MAX_EDGES = 500;
const COLUMN = /^[a-z_][a-z0-9_]*$/;

/**
 * Rows a write might change, read before it runs: candidate nodes with their head and body text, the whole evidence of every
 * owner in `owners` (those nodes and the edges around them), and the edges it may end.
 */
export interface Before { nodes: Record<string, { row: Row; texts: Row[] }>; owners: string[]; evidence: Row[]; edges: Record<string, Row> }

/** Stored in activity.undo. `seq` is the write's own sequence number. */
export interface Inverse {
	seq: number;
	/** Nodes it changed: columns and the head and body rows it replaced go back; entries it folded go live again. */
	nodes?: { id: string; expect: number; row: Row; texts: Row[] }[];
	/** Nodes it created: archived. */
	created?: EndpointClaim[];
	commitReceipt?: CommitReceipt;
	countOrigins?: string[];
	/** Standalone text rows restored on an existing session: archived while the row and owner remain unchanged. */
	texts?: { rowid: number; node_id: string; expect: number; ownerSeq: number }[];
	/** Edges it added between nodes that existed before: archived with their evidence. */
	edges?: number[];
	/** Evidence it added or overwrote on nodes and edges that existed before: archived. */
	evidence?: [string, string, string][];
	/** The evidence rows it overwrote: put back. */
	evidenceRows?: Row[];
	/** Edges it ended: open again with their earlier valid_to. */
	reopen?: { id: number; valid_to: SqlStorageValue }[];
	/** Rows it archived: restored. */
	archived?: number[];
	/** Flags it set without a new revision. */
	flags?: { id: string; flagged: SqlStorageValue }[];
	/** Pending mentions of earlier records it resolved into links: put back as they were, while each owner is at `expect`. */
	mentions?: Consumed[];
}

/** What revert needs beyond the archive's transaction (including its guard): write.ts's Tx fits. */
export interface UndoTx extends ArchiveTx { readonly ctx: Pick<WriteContext, "deviceId"> & { actor: string }; readonly requestId: string | null }

/** Images of every node `cmd` may change (by id, supersedes, name, key or edge endpoint), their evidence and that of their edges, and the edges a knowledge write may end. */
export function beforeImages(sql: SqlStorage, cmd: WriteCommand): Before {
	const a = cmd.args as unknown as Record<string, unknown>;
	const ids = new Set<string>(), names = new Set<string>(), keys = new Set<string>(), ends: number[] = [];
	const name = (v: unknown) => {
		try { if (typeof v === "string") names.add(normalizeName(v)); } catch { /* no usable name: the write itself refuses it */ }
	};
	for (const v of [a.memory_id, a.candidate_id, ...(Array.isArray(a.supersedes) ? a.supersedes : [a.supersedes])]) if (typeof v === "string") ids.add(v);
	name(a.name);
	if (cmd.op === "upload") {
		for (const k of uploadNodeKeys(cmd.args)) keys.add(k);
		if (cmd.args.item !== "commit") {
			// A newer snapshot may end its node's structural identifier edges; undo reopens them.
			const node = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved' LIMIT 1", uploadKey(cmd.args)).toArray()[0];
			if (node) ends.push(...snapshotEdges(sql, cmd.args.item, node.id).map((e) => e.id));
		}
	}
	// A fact report changes only the repo's live facts (at most 32); the ones it creates need no image.
	if (cmd.op === "fact") for (const id of liveFactIds(sql, cmd.args.repo_key)) ids.add(id);
	if (cmd.op === "knowledge") {
		for (const n of cmd.args.nodes ?? []) { name(n.name); if (n.key) keys.add(n.key); }
		for (const e of cmd.args.end ?? []) ends.push(e.edge);
		for (const e of cmd.args.edges ?? []) {
			for (const r of [e.from, e.to]) {
				if ("id" in r) ids.add(r.id);
				else if ("key" in r) keys.add(r.key);
				else if ("name" in r) name(r.name);
			}
		}
	}
	const json = (s: Iterable<unknown>) => JSON.stringify([...s]);
	const found = sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) OR norm_name IN (SELECT value FROM json_each(?))
		OR key${cmd.op === "upload" ? " COLLATE NOCASE" : ""} IN (SELECT value FROM json_each(?)) LIMIT ${MAX_IMAGES}`, json(ids), json(names), json(keys)).toArray().map((r) => r.id);
	const nodes: Before["nodes"] = {};
	for (const row of sql.exec<Row>("SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?))", json(found))) nodes[String(row.id)] = { row, texts: [] };
	for (const t of sql.exec<Row>("SELECT * FROM texts WHERE node_id IN (SELECT value FROM json_each(?)) AND (part IN ('head', 'body') OR (part = 'summary' AND live = 1))", json(found))) nodes[String(t.node_id)]?.texts.push(t);
	const around = sql.exec<{ id: number }>(`SELECT id FROM edges WHERE src IN (SELECT value FROM json_each(?1)) OR (dst IN (SELECT value FROM json_each(?1)) AND dst_profile = '')
		LIMIT ${MAX_EDGES}`, json(found)).toArray().map((e) => `e:${e.id}`);
	const owners = [...found.map((id) => `n:${id}`), ...around];
	const evidence = sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?))", json(owners)).toArray();
	const edges: Before["edges"] = {};
	for (const e of sql.exec<Row>("SELECT * FROM edges WHERE id IN (SELECT value FROM json_each(?))", json(ends))) edges[String(e.id)] = e;
	return { nodes, owners, evidence, edges };
}

/**
 * The inverse of the write that just ran in `tx`, from the rows stamped with its seq. null when it changed a node no image
 * covers: no undo is better than a wrong one. `after.created` are the node ids the write created.
 */
export function inverseOf(before: Before, after: { created: string[]; consumed?: Consumed[]; commitReceipt?: CommitReceipt }, tx: ArchiveTx): Inverse | null {
	const { sql, seq, now } = tx;
	const created = new Set(after.created);
	const inv: Required<Omit<Inverse, "seq" | "commitReceipt" | "countOrigins">> & { seq: number; commitReceipt?: CommitReceipt } = { seq, nodes: [], created: [], edges: [], evidence: [], evidenceRows: [], reopen: [], archived: [], flags: [], mentions: [], texts: [] };
	for (const n of sql.exec<{ id: string; revision: number }>("SELECT id, revision FROM nodes WHERE seq = ?", seq).toArray()) {
		if (created.has(n.id)) { inv.created.push({ id: n.id, expect: n.revision, ...(after.commitReceipt && (n.id === after.commitReceipt.person || n.id === after.commitReceipt.project) ? {countOwner:after.commitReceipt.owner} : {}) }); continue; }
		const b = before.nodes[n.id];
		if (!b) return null;
		// A row is kept only if it is still the imaged one: SQLite may have given its rowid to a row this write inserted.
		const now = new Map(sql.exec<{ rowid: number; seq: number }>("SELECT rowid, seq FROM texts WHERE rowid IN (SELECT value FROM json_each(?))", JSON.stringify(b.texts.map((t) => t.rowid))).toArray().map((r) => [r.rowid, r.seq]));
		inv.nodes.push({ id: n.id, expect: n.revision, row: b.row, texts: b.texts.filter((t) => now.get(Number(t.rowid)) !== t.seq) });
	}
	const covered = new Set([...created, ...inv.nodes.map((n) => n.id)]);
	for (const t of sql.exec<{ rowid: number; node_id: string; revision: number; owner_seq: number }>("SELECT t.rowid, t.node_id, n.revision, n.seq AS owner_seq FROM texts t JOIN nodes n ON n.id = t.node_id WHERE t.seq = ?", seq).toArray()) {
		if (!covered.has(t.node_id)) inv.texts.push({ rowid: t.rowid, node_id: t.node_id, expect: t.revision, ownerSeq: t.owner_seq });
	}
	const newEdges = new Set<number>();
	const commit=after.commitReceipt;
	inv.commitReceipt=commit;
	const pair=commit?.pair?countPair(sql,commit.pair):undefined;
	for (const e of sql.exec<{ id: number; src: string; dst: string; recorded_at: string; ended_at: string | null }>("SELECT id, src, dst, recorded_at, ended_at FROM edges WHERE seq = ?", seq).toArray()) {
		if(pair?.edge.id===e.id && commit?.counted && pair.epoch===commit.epoch)continue;
		if (e.ended_at === now && before.edges[String(e.id)]) {
			const b = before.edges[String(e.id)];
			if (!b) return null;
			inv.reopen.push({ id: e.id, valid_to: b.valid_to ?? null });
		} else {
			newEdges.add(e.id);
			if (!created.has(e.src) && !created.has(e.dst) && !commit?.structural.some(c=>c.id===e.id)) inv.edges.push(e.id);
		}
	}
	const owners = new Set(before.owners);
	const key = (r: { owner: SqlStorageValue; kind: SqlStorageValue; ref: SqlStorageValue }) => JSON.stringify([r.owner, r.kind, r.ref]);
	const prior = new Map(before.evidence.map((r) => [key(r as never), r]));
	for (const ev of sql.exec<{ owner: string; kind: string; ref: string }>("SELECT owner, kind, ref FROM evidence WHERE seq = ?", seq).toArray()) {
		const id = ev.owner.slice(2);
		// Evidence of a new node or edge goes with it.
		if (ev.owner.startsWith("n:") ? created.has(id) : newEdges.has(Number(id))) continue;
		if (!owners.has(ev.owner)) return null;
		inv.evidence.push([ev.owner, ev.kind, ev.ref]);
		const old = prior.get(key(ev));
		if (old) inv.evidenceRows.push(old);
	}
	inv.archived = sql.exec<{ id: number }>("SELECT id FROM archive WHERE seq = ?", seq).toArray().map((r) => r.id);
	// Only mentions that existed before this write, on records it did not create: those go back exactly; the rest go with their node.
	inv.mentions = (after.consumed ?? []).filter((m) => m.row.seq !== seq && !created.has(String(m.row.owner).slice(2)));
	return Object.fromEntries(Object.entries(inv).filter(([, v]) => !Array.isArray(v) || v.length)) as unknown as Inverse;
}

/** Wire hook for runWrite: after the op, store its inverse on the activity row it wrote. */
export function recordUndo(tx: ArchiveTx, before: Before, out: Pick<WriteOutput, "created" | "result"> & { consumed?: Consumed[]; commitReceipt?: CommitReceipt }): void {
	const id = out.result.activity_id;
	if (typeof id !== "number") return;
	const inv = inverseOf(before, out, tx);
	if(inv){
		const origins=new Set(out.commitReceipt?[out.commitReceipt.origin]:[]);
		for(const e of inv.reopen??[]){const row=tx.sql.exec<Row>("SELECT count_key FROM edges WHERE id=?",e.id).toArray()[0];if(typeof row?.count_key === "string"){const p=countPair(tx.sql,row.count_key);if(p)origins.add(p.origin);}}
		if(origins.size)inv.countOrigins=[...origins];
	}
	if(out.commitReceipt && !inv)throw Fail.of("size_budget","commit upload requires a complete typed inverse");
	const targets = tx.sql.exec<{ targets: string }>("SELECT targets FROM activity WHERE id = ?", id).one().targets;
	const dependencies = [...new Set<string>([...JSON.parse(targets), ...(inv?.mentions ?? []).map((m) => String(m.row.owner).slice(2)), ...(inv?.texts ?? []).map((t) => t.node_id)])];
	tx.run("UPDATE activity SET undo = ?, targets = ? WHERE id = ?", inv && JSON.stringify(inv), JSON.stringify(dependencies), id);
}

/**
 * The "undo" op, run by runWrite inside its transaction. Every record must still be as the change left it: nodes at the
 * revision it produced, and every edge, evidence row or flag it touched still stamped with its seq. Anything else is
 * revision_conflict ("changed since; review by hand"). Everything undo would put back passes tx.guard first, so in me it
 * meets the me guard with the terms registered by now. A wipe-redacted change returns undo_redacted. What undo removes goes to the archive, so nothing but the
 * 300-day purge is lost.
 */
export function revert(tx: UndoTx, args: { activity_id: number }, label = { op: "undo", summary: `undid activity ${args.activity_id}` }): WriteOutput {
	const sql = tx.sql, of = args.activity_id;
	const a = sql.exec<{ op: string; undo: string | null; redacted: string | null; undone_by: number | null; targets: string; at: string }>(
		"SELECT op, undo, redacted, undone_by, targets, at FROM activity WHERE id = ?", of).toArray()[0];
	if (!a) throw Fail.of("not_found", `no activity ${of}`);
	// wiring: ErrorCode gains "undo_redacted".
	if (a.redacted) throw Fail.of("undo_redacted" as ErrorCode, "a wipe removed this change's content; it cannot be undone", { reason: "undo_redacted" });
	if (a.undone_by !== null) throw Fail.of("validation", `activity ${of} was already undone`, { reason: "already_undone", undone_by: a.undone_by });
	if (!a.undo) throw Fail.of("validation", "this change has no undo", { reason: "no_undo" });
	const inv = JSON.parse(a.undo) as Inverse;
	if(inv.commitReceipt && (a.op!=="upload" || inv.commitReceipt.owner.id!==of || inv.commitReceipt.owner.at!==a.at || inv.commitReceipt.owner.seq!==inv.seq))throw Fail.of("revision_conflict","commit inverse belongs to another activity");
	const counted=inv.commitReceipt?undoCommitReceipt(sql,inv.commitReceipt):undefined;
	if(counted)reverseObservation(tx,counted.meta,counted.pair);
	const retained=new Map<string,CommitReceipt|"sealed">();
	if(counted)for(const c of inv.created??[]){
		const person=c.id===counted.meta.person,project=c.id===counted.meta.project;
		if(!person&&!project)continue;
		const next=nextClaim(sql,c.id,person,counted.meta.request);
		if(next)retained.set(c.id,next);else if(sealedDependency(sql,c.id,person))retained.set(c.id,"sealed");
	}
	const conflict = (details: Record<string, unknown>) => Fail.of("revision_conflict", "changed since; review by hand", details);
	for (const n of [...(inv.nodes ?? []), ...(inv.created ?? [])]) {
		const cur = sql.exec<{ revision: number }>("SELECT revision FROM nodes WHERE id = ?", n.id).toArray()[0];
		if (cur?.revision !== n.expect) throw conflict({ node: n.id, expected_revision: n.expect, actual_revision: cur?.revision ?? null });
	}
	const S = inv.seq, any = (q: string, ...p: SqlStorageValue[]) => sql.exec(q, ...p).toArray().length > 0;
	for (const t of inv.texts ?? []) {
		assertNotWiped(sql, t.node_id);
		assertWritable(sql, t.node_id);
		if (!any("SELECT 1 FROM texts t JOIN nodes n ON n.id = t.node_id WHERE t.rowid = ? AND t.node_id = ? AND t.seq = ? AND n.revision = ? AND n.seq = ? AND n.status NOT IN ('moved','moving','incoming')", t.rowid, t.node_id, S, t.expect, t.ownerSeq)) throw conflict({ text: t.rowid, node: t.node_id });
	}
	const around = "SELECT 'e:' || id FROM edges WHERE src = ?1 OR (dst = ?1 AND dst_profile = '')";
	for (const c of inv.created ?? []) {
		if(!counted){
			if(any(`SELECT 1 FROM edges WHERE (src = ?1 OR (dst = ?1 AND dst_profile = '')) AND seq <> ?2`,c.id,S) || any(`SELECT 1 FROM evidence WHERE (owner = 'n:' || ?1 OR owner IN (${around})) AND seq <> ?2`,c.id,S))throw conflict({node:c.id});
			continue;
		}
		const ownSeq=c.countOwner?.seq??S;
		const incident=sql.exec<Row>(`SELECT * FROM edges WHERE src=?1 OR (dst=?1 AND dst_profile='') LIMIT ${MAX_EDGES+1}`,c.id).toArray();
		if(incident.length>MAX_EDGES)throw Fail.of("size_budget","too many incident edges for a guarded commit Undo");
		if(any("SELECT 1 FROM evidence WHERE owner=? AND seq<>? LIMIT 1",`n:${c.id}`,ownSeq))throw conflict({node:c.id});
		for(const e of incident){
			let evidenceSeq=e.seq!;
			const registered=typeof e.count_key === "string" ? countPair(sql,e.count_key) : undefined;
			const managed=registered && sameCountEdge(e,registered.edge);
			if(managed)managedCount(sql,registered);
			if(!managed && e.seq!==ownSeq && !counted.meta.structural.some(t=>sameCountEdge(e,t))){
				const r=sql.exec<{commit_meta:string|null}>("SELECT commit_meta FROM requests WHERE request_id=?",e.request_id!).toArray()[0];
				const m=r?.commit_meta?JSON.parse(r.commit_meta) as CommitReceipt:undefined;
				const sealed=sealedStructural(sql,e,c.id,c.id===counted.meta.person);
				if(sealed!==undefined){if(!retained.has(c.id))retained.set(c.id,'sealed');evidenceSeq=sealed;}
				else if(!retained.has(c.id) || !m || !liveCommit(sql,m) || !m.structural.some(t=>sameCountEdge(e,t)))throw conflict({node:c.id,edge:e.id});
			}
			if(any("SELECT 1 FROM evidence WHERE owner=? AND seq<>? LIMIT 1",`e:${String(e.id)}`,managed?ownSeq:evidenceSeq))throw conflict({node:c.id,edge:e.id});
		}
	}
	for (const id of inv.edges ?? []) {
		if (!any("SELECT 1 FROM edges WHERE id = ? AND seq = ?", id, S) || any("SELECT 1 FROM evidence WHERE owner = ? AND seq <> ?", `e:${id}`, S)) throw conflict({ edge: id });
	}
	for (const [owner, kind, ref] of inv.evidence ?? []) {
		if (!any("SELECT 1 FROM evidence WHERE owner = ? AND kind = ? AND ref = ? AND seq = ?", owner, kind, ref, S)) throw conflict({ evidence: owner });
	}
	for (const e of inv.reopen ?? []) if (!any("SELECT 1 FROM edges WHERE id = ? AND ended_at IS NOT NULL AND seq = ?", e.id, S)) throw conflict({ edge: e.id });
	for (const f of inv.flags ?? []) if (!any("SELECT 1 FROM nodes WHERE id = ? AND seq = ?", f.id, S)) throw conflict({ node: f.id });
	// A mention goes back only to the record that held it, unchanged since, here and not in transfer, and only if nothing took its place.
	for (const m of inv.mentions ?? []) {
		const owner = String(m.row.owner).slice(2), cur = sql.exec<{ revision: number; status: string }>("SELECT revision, status FROM nodes WHERE id = ?", owner).toArray()[0];
		if (!cur || cur.status === "moved" || cur.revision !== m.expect) throw conflict({ node: owner });
		assertNotWiped(sql, owner);
		assertWritable(sql, owner);
		if (any("SELECT 1 FROM evidence WHERE owner = ? AND kind = ? AND ref = ?", m.row.owner!, m.row.kind!, m.row.ref!)) throw conflict({ evidence: m.row.owner });
	}
	tx.guard(restored(sql, inv));
	for (const n of inv.nodes ?? []) {
		const F = fenceOf(sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE id = ?", n.id).one().attrs), old = fenceOf(String(n.row.attrs));
		if (old < F && any("SELECT 1 FROM texts WHERE node_id = ? AND part = 'entry' AND live = 2 AND seq_no > ? AND seq_no <= ? LIMIT 1", n.id, old, F)) throw new Unfold(n.id, old, F);
	}
	const activityId = Number(tx.run("INSERT INTO activity (at, actor, device_id, op, summary, targets, undo_of, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
		tx.now, tx.ctx.actor, tx.ctx.deviceId ?? null, label.op, label.summary, a.targets, of, tx.seq).one().id);
	const keep = purgeAfter(tx.now);
	let embedDue = false;
	if (inv.texts?.length) archiveRows(tx, activityId, "texts", sql.exec<Row>("SELECT * FROM texts WHERE rowid IN (SELECT value FROM json_each(?))", JSON.stringify(inv.texts.map((t) => t.rowid))).toArray(), keep);
	if(counted)for(const e of counted.meta.structural){
		archiveRows(tx,activityId,"evidence",sql.exec<Row>("SELECT * FROM evidence WHERE owner=?",`e:${e.id}`).toArray(),keep);
		archiveRows(tx,activityId,"edges",sql.exec<Row>("SELECT * FROM edges WHERE id=?",e.id).toArray(),keep);
	}
	for(const c of inv.created??[]){
		const target=retained.get(c.id);
		if(target && target!=="sealed"){
			const a=sql.exec<{undo:string}>("SELECT undo FROM activity WHERE id=?",target.owner.id).one();
			const next=JSON.parse(a.undo) as Inverse;
			next.created=[...(next.created??[]).filter(old=>old.id!==c.id),c];
			tx.run("UPDATE activity SET undo=?,seq=? WHERE id=?",JSON.stringify(next),tx.seq,target.owner.id);
		}else if(target==="sealed"){
			tx.run("INSERT OR IGNORE INTO profile_meta(key,value) VALUES(?,?)",`work-count:${counted!.meta.origin}:claim:${c.id}`,JSON.stringify({kind:"claim",origin:counted!.meta.origin,node:c.id,expect:c.expect,owner:c.countOwner??counted!.meta.owner}));
		}else archiveNode(tx,activityId,c.id,keep);
	}
	for (const id of inv.edges ?? []) {
		const edge = sql.exec<Row>("SELECT * FROM edges WHERE id = ?", id).toArray();
		archiveRows(tx, activityId, "evidence", sql.exec<Row>("SELECT * FROM evidence WHERE owner = ?", `e:${id}`).toArray(), keep);
		archiveRows(tx, activityId, "edges", edge, keep);
	}
	if (inv.evidence?.length) {
		archiveRows(tx, activityId, "evidence", sql.exec<Row>(`SELECT * FROM evidence WHERE (owner, kind, ref) IN
			(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))`, JSON.stringify(inv.evidence)).toArray(), keep);
	}
	for (const r of inv.evidenceRows ?? []) putRow(tx, "evidence", r);
	for (const m of inv.mentions ?? []) putRow(tx, "evidence", m.row);
	for (const n of inv.nodes ?? []) embedDue = putBack(tx, activityId, n, inv.seq, keep) || embedDue;
	for (const e of inv.reopen ?? []) {
		const row=sql.exec<Row>("SELECT src,dst,dst_profile FROM edges WHERE id=?",e.id).toArray()[0];
		if(row)assertArchiveEndpoints(sql,String(row.src),String(row.dst),String(row.dst_profile));
		try {
			tx.run("UPDATE edges SET ended_at = NULL, valid_to = ?, seq = ? WHERE id = ?", e.valid_to, tx.seq, e.id);
		} catch (err) {
			if (err instanceof Error && /constraint failed/i.test(err.message)) throw conflict({ edge: e.id });
			throw err;
		}
	}
	if (inv.archived?.length) embedDue = restoreArchived(tx, inv.archived).nodes.length > 0 || embedDue;
	for (const f of inv.flags ?? []) tx.run("UPDATE nodes SET flagged = ?, seq = ? WHERE id = ?", f.flagged, tx.seq, f.id);
	// Undoing a restore removes the records again: like the removal it reverses, it stays restorable from the archive.
	if (a.op === "restore") {
		tx.run("UPDATE activity SET undo = ? WHERE id = ?", JSON.stringify({ seq: tx.seq, archived: sql.exec<{ id: number }>("SELECT id FROM archive WHERE activity_id = ? AND seq = ?", activityId, tx.seq).toArray().map((r) => r.id) }), activityId);
	}
	tx.run("UPDATE activity SET undone_by = ?, seq = ? WHERE id = ?", activityId, tx.seq, of);
	markUndone(tx, of, activityId);
	return { result: { ok: true, action: "undone", activity_id: activityId, undo_of: of }, created: [], embedDue };
}

/**
 * Everything an undo would make current again, as whole rows: node images with their head and body, folded entries,
 * overwritten evidence, reopened edges, archived rows and flags. Read before any write, for tx.guard.
 */
function restored(sql: SqlStorage, inv: Inverse): unknown {
	const json = (v: unknown) => JSON.stringify(v ?? []);
	return {
		nodes: inv.nodes, evidence: inv.evidenceRows, flags: inv.flags, mentions: inv.mentions?.map((m) => m.row),
		entries: (inv.nodes ?? []).map((n) => sql.exec(`SELECT * FROM texts WHERE node_id = ? AND part = 'entry' AND ((seq = ? AND live = 0) OR (live <> 0 AND seq_no > ? AND seq_no <= COALESCE((SELECT json_extract(attrs, '$.compacted_through') FROM nodes WHERE id = ?), 0)))`, n.id, inv.seq, fenceOf(String(n.row.attrs)), n.id).toArray()),
		edges: sql.exec("SELECT * FROM edges WHERE id IN (SELECT value FROM json_each(?))", json(inv.reopen?.map((e) => e.id))).toArray(),
		archived: sql.exec<{ payload: string }>("SELECT payload FROM archive WHERE id IN (SELECT value FROM json_each(?))", json(inv.archived)).toArray().map((a) => JSON.parse(a.payload) as Row),
	};
}

/** Puts one changed node back: its columns at a new revision, the text rows it lost, and folded entries live again. */
function putBack(tx: UndoTx, activityId: number, n: NonNullable<Inverse["nodes"]>[number], seq: number, keep: string): boolean {
	const sql = tx.sql;
	archiveRows(tx, activityId, "texts", sql.exec<Row>("SELECT * FROM texts WHERE node_id = ? AND seq = ? AND live = 1", n.id, seq).toArray(), keep);
	tx.run("UPDATE texts SET live = 1, seq = ? WHERE node_id = ? AND seq = ? AND live = 0 AND part = 'entry'", tx.seq, n.id, seq);
	for (const t of n.texts) putRow(tx, "texts", t);
	const cur = sql.exec<{ revision: number; card_hash: string }>("SELECT revision, card_hash FROM nodes WHERE id = ?", n.id).one();
	const revision = cur.revision + 1;
	const set: Row = { ...n.row, revision, updated_at: tx.now, seq: tx.seq };
	delete set.id;
	const due = set.card_hash !== cur.card_hash && set.memory_type !== null;
	if (due) set.embed_hash = null;
	const cols = Object.keys(set);
	if (!cols.every((c) => COLUMN.test(c))) throw Fail.of("validation", "a node image has an invalid column");
	try {
		tx.run(`UPDATE nodes SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => set[c]!), n.id);
	} catch (e) {
		if (e instanceof Error && /constraint failed/i.test(e.message)) throw Fail.of("revision_conflict", "changed since; review by hand", { node: n.id, reason: "identity_taken" });
		throw e;
	}
	// History: the snapshot recorded for the state put back, renumbered.
	tx.run(`INSERT INTO revisions (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq)
		SELECT node_id, ?, 'restored', json_set(snapshot, '$._version', ?, '$._updated', ?), ?, ?, ?, ?, ? FROM revisions WHERE node_id = ? AND revision = ?`,
		revision, revision, tx.now, tx.requestId, tx.ctx.actor, tx.ctx.deviceId ?? null, tx.now, tx.seq, n.id, Number(n.row.revision));
	// Undo is not an append: even an append-only prior state needs a snapshot marker for later compaction conflicts.
	if (!sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND revision = ?", n.id, revision).toArray().length) {
		tx.run("INSERT INTO revisions (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq) VALUES (?, ?, 'restored', ?, ?, ?, ?, ?, ?)",
			n.id, revision, snapshot(readNode(sql, n.id)!, undefined, sql), tx.requestId, tx.ctx.actor, tx.ctx.deviceId ?? null, tx.now, tx.seq);
	}
	queueFold(tx, n.id);
	return due;
}

/**
 * Undoes one activity row through runWrite, as request "undo:<id>": a retry replays the first result. `ctx` is the
 * caller's (the owner in the dashboard); its payload hash is fixed by the activity id.
 */
export function undo(storage: DurableObjectStorage, who: Who, activityId: number, ctx: Omit<WriteContext, "payloadHash">): WriteOutput {
	const args = { activity_id: activityId, request_id: `undo:${activityId}` };
	// wiring: WriteCommand gains { op: "undo"; args: { activity_id: number; request_id: string } }, dispatched to revert(tx, cmd.args).
	return runWrite(storage, who, { op: "undo", args } as unknown as WriteCommand, { ...ctx, payloadHash: requestHash("undo", args) });
}

/**
 * The owner's archive restore (section 15): one removal (a forget or a capture TTL) put back exactly as archived, through undo's
 * own checks inside the common write: wipe-redacted, already restored, purged, a key or identity taken since (revision_conflict),
 * the me guard, and the write's row and size budget. A record wiped or moving now is refused before anything changes. The restore
 * is itself a write with its activity row and undo: undoing it archives the records again.
 */
export function restore(tx: UndoTx, args: { activity_id: number }): WriteOutput {
	if(tx.sql.exec("SELECT 1 FROM activity WHERE id=? AND json_extract(undo,'$.archive_operation') IS NOT NULL",args.activity_id).toArray().length)throw Fail.of("size_budget","use the staged archive operations route for this removal",{reason:"staged_required"});
	if (tx.ctx.actor !== "owner") throw Fail.of("forbidden", "only the owner restores from the archive");
	const a = tx.sql.exec<{ op: string; undid: string | null }>("SELECT op, (SELECT u.op FROM activity u WHERE u.id = activity.undo_of) AS undid FROM activity WHERE id = ?", args.activity_id).toArray()[0];
	if (!a || !(REMOVALS.includes(a.op) || (a.op === "undo" && a.undid === "restore"))) throw Fail.of("not_found", `activity ${args.activity_id} is not a removal in the archive`, { reason: "not_a_removal" });
	const ids = archivedNodeIds(tx.sql, args.activity_id);
	const owners = tx.sql.exec<{ id: string }>("SELECT DISTINCT json_extract(payload, '$.node_id') AS id FROM archive WHERE activity_id = ? AND source = 'texts'", args.activity_id).toArray().map((r) => r.id);
	for (const id of owners.filter((id) => !ids.includes(id))) {
		assertNotWiped(tx.sql, id);
		assertWritable(tx.sql, id);
		if (!readNode(tx.sql, id) || readNode(tx.sql, id)!.status === "moved") throw Fail.of("revision_conflict", "the archived text's owner is missing", { node: id });
	}
	for (const id of ids) { assertNotWiped(tx.sql, id); assertWritable(tx.sql, id); }
	const out = revert(tx, args, { op: "restore", summary: `restored ${ids.length} records removed by activity ${args.activity_id}` });
	return { result: { ok: true, action: "restored", activity_id: out.result.activity_id, restored_from: args.activity_id, nodes: ids }, created: ids, embedDue: out.embedDue };
}
