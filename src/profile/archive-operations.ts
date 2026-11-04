import { assertCountImageOpen, countOrigin, countOriginClosed, countPair, countRestore, unownedCountHistory, saveCountPair, type CountPair } from "./work-counts";
// Bounded owner archive operations. Images live in archive; metadata holds only fences, hashes and applied keys.
import { meGuard } from "../domain/guard";
import { requestHash, sha256 } from "../domain/ids";
import { Fail, type WriteContext } from "../domain/types";
import { nextSeq } from "../storage";
import { archiveRows, BudgetTx, PK, purgeAfter, putRow, type ArchiveSource, type Row } from "./archive";
import { assertArchiveEndpoints, assertNoTouchingTransfer } from "./archive-fence";
import { bundleTexts } from "./transfer";
import { sizeLevel } from "./housekeeping";
import { mayChange } from "./protect";
import { assertNotWiped, assertOpen } from "./wipe";
import type { Who } from "./write";

export type ArchiveCommand =
	| { action: "forget"; memory_id: string; expected_revision: number; request_id: string }
	| { action: "restore"; activity_id: number; request_id: string }
	| { action: "resume" | "abort"; operation_id: string; cursor: string; request_id: string };
type Fence = { attrs: string; status: string; revision: number; seq: number };
type Applied = { archive: number; source: ArchiveSource; key: SqlStorageValue[]; seq: number; hash: string; countBefore?: CountPair; borrowed?:boolean };
export interface ArchiveOperation {
	id: string; node: string; profile: string; generation: string; origin: string | null; countOrigins?:string[];
	action: "forget" | "restore"; state: "running" | "rolling_back" | "complete" | "aborted";
	phase: string; version: number; activity: number; removal: number; source?: string; undoOf?: number;
	original: Fence | null; fenceSeq: number; after: number; rows: number; hash: string;
	checked: number; checkHash: string; guardVersion: string; cleanup: boolean;
	me: WriteContext["meGuard"]; validationSource?:string; inverseLane?:number; inverseKey?:SqlStorageValue[]; publishedSeq?: number; createdAt: string;
}
type Archived = { id: number; source: ArchiveSource; payload: string };
const opKey = (id: string) => `archive-op:${id}`;
const rowKey = (id: string, n: number) => `${opKey(id)}:row:${String(n).padStart(16, "0")}`;
const nodeKey = (node: string, id: string) => `archive-node:${node}:${id}`;
const pinKey = (activity: number) => `archive-pin:${activity}`;
const range = (prefix: string) => [prefix, `${prefix}~`] as const;
const read = <T>(sql: SqlStorage, key: string): T | undefined => {
	const r = sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = ?", key).toArray()[0];
	return r ? JSON.parse(r.value) as T : undefined;
};
export const archiveOperation = (sql: SqlStorage, id: string) => read<ArchiveOperation>(sql, opKey(id));
const save = (tx: BudgetTx, key: string, value: unknown) => tx.run("INSERT INTO profile_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
const conflict = (reason: string, id?: string, profile?:string) => Fail.of("revision_conflict", "archive state changed; inspect current status", { reason, ...(id && profile ? { status_url: `/api/profiles/${profile}/archive/operations/${id}` } : {}) });
const chain = (hash: string, a: Archived) => sha256(`${hash}\n${a.id}:${a.source}:${sha256(a.payload)}`);
const cursor = (o: ArchiveOperation) => Buffer.from(JSON.stringify([1, o.id, o.profile, o.generation, o.version])).toString("base64url");
// Since issue #3 the guard reads no term table, so its version changes only with the operation's own me selection.
const guardVersion = (_sql: SqlStorage, o: ArchiveOperation) => sha256(JSON.stringify([o.me?.explicit === true]));
function guard(sql: SqlStorage, o: ArchiveOperation, material: unknown): void {
	if (o.profile !== "me") return;
	if (!o.me?.explicit) throw Fail.of("validation", "me must be explicitly selected");
	const g = meGuard(bundleTexts(material));
	if (!g.ok) throw new Fail(g.error);
}
function status(o: ArchiveOperation, action = "progressed"): Record<string, unknown> {
	return { action, operation_id: o.id, profile: o.profile, generation: o.generation, state: o.state, phase: o.phase,
		cursor: cursor(o), status_url: `/api/profiles/${o.profile}/archive/operations/${o.id}`, activity_id: o.state === "complete" ? o.activity : null, rows_done: o.rows, cleanup_pending: o.cleanup,
		...(o.undoOf ? { undo_of: o.undoOf } : {}) };
}
export function archiveStatus(sql: SqlStorage, who: Who, id: string): Record<string, unknown> {
	const o = archiveOperation(sql, id);
	if (!o || o.profile !== who.profile || o.generation !== who.generation) throw Fail.of("not_found", "no archive operation");
	assertNotWiped(sql, o.node);
	return status(o, "status");
}
function activity(sql: SqlStorage, id: number) {
	return sql.exec<{ id: number; undo: string | null; undone_by: number | null; redacted: string | null; op: string }>("SELECT id,undo,undone_by,redacted,op FROM activity WHERE id=?", id).toArray()[0];
}
function node(sql: SqlStorage, id: string) { return sql.exec<Row>("SELECT * FROM nodes WHERE id=?", id).toArray()[0]; }
function parts(sql: SqlStorage, o: ArchiveOperation, after: number, limit: number): Applied[] {
	const prefix = `${opKey(o.id)}:row:`;
	return sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key > ? AND key < ? ORDER BY key LIMIT ?", rowKey(o.id, after), range(prefix)[1], limit).toArray().map(r => JSON.parse(r.value) as Applied);
}
function archived(sql: SqlStorage, activityId: number, after: number, limit: number): Archived[] {
	return sql.exec<Archived>("SELECT id,source,payload FROM archive WHERE activity_id=? AND id>? ORDER BY id LIMIT ?", activityId, after, limit).toArray();
}
function keyed(sql: SqlStorage, p: Applied): Row | undefined {
	return sql.exec<Row>(`SELECT * FROM ${p.source} WHERE ${PK[p.source].map(k => `${k}=?`).join(" AND ")}`, ...p.key).toArray()[0];
}
function remember(tx: BudgetTx, o: ArchiveOperation, a: Archived, row: Row, id?: number, countBefore?: CountPair): void {
	const key = PK[a.source].map(k => k === "id" && a.source === "edges" || k === "rowid" && a.source === "texts" ? id! : row[k]!);
	const borrowed=countBefore?.archived===null;
	const p: Applied = { archive: a.id, source: a.source, key, seq:borrowed?countBefore.edge.seq:tx.seq, hash: sha256(a.payload), ...(borrowed?{borrowed:true}:countBefore ? {countBefore} : {}) };
	save(tx, rowKey(o.id, a.id), p);
	if (a.source === "edges") save(tx, `${opKey(o.id)}:edge:${String(row.id)}`, id);
}
function copy(tx: BudgetTx, o: ArchiveOperation, a: Archived): void {
	const row = JSON.parse(a.payload) as Row;
	if (a.source === "evidence" && String(row.owner).startsWith("e:")) {
		const mapped = read<number>(tx.sql, `${opKey(o.id)}:edge:${String(row.owner).slice(2)}`);
		if (mapped === undefined) {
			if (o.state !== "rolling_back" || !tx.sql.exec("SELECT 1 FROM edges WHERE id=? AND (src=? OR (dst_profile='' AND dst=?))",Number(String(row.owner).slice(2)),o.node,o.node).toArray().length) throw conflict("edge_map_missing", o.id);
		} else row.owner = `e:${mapped}`;
	}
	guard(tx.sql, o, row);
	const countBefore=a.source === "edges" && typeof row.count_key === "string" && !unownedCountHistory(row) ? countRestore(tx,row).pair : undefined;
	const id = putRow(tx, a.source, row);
	remember(tx, o, a, row, id, countBefore);
}
/** Conservative bound before writing, with actual BudgetTx rollback-and-halving as the final authority. */
function fit<T>(rows:T[]):T[]{let bytes=0,n=0;for(const row of rows){const cost=2*Buffer.byteLength(JSON.stringify(row),"utf8")+1000;if(n&&bytes+cost>600_000)break;bytes+=cost;n++;}return rows.slice(0,n);}
function appendImages(tx: BudgetTx, o: ArchiveOperation, source: ArchiveSource, rows: Row[]): void {
	rows=fit(rows);
	const ids = archiveRows(tx, o.removal, source, rows, purgeAfter(tx.now));
	for (let i=0; i<rows.length; i++) {
		const a = { id: ids[i]!, source, payload: JSON.stringify(rows[i]) };
		o.hash = chain(o.hash, a); o.rows++;
	}
}
function begin(tx: BudgetTx, who: Who, c: Extract<ArchiveCommand, { action: "forget" | "restore" }>, ctx: WriteContext, undoOf?: number): ArchiveOperation {
	const sql = tx.sql, id = crypto.randomUUID();
	if(c.action === "restore"&&!undoOf&&sizeLevel(sql.databaseSize) === "shrink_only")throw Fail.of("size_budget","this profile accepts only shrinking operations and Undo",{reason:"shrink_only"});
	let n: Row, removal = 0, source: string | undefined;
	const countOrigins=new Set<string>();
	if (c.action === "forget") {
		n = node(sql, c.memory_id)!;
		if (!n || !["active","retired","superseded"].includes(String(n.status))) throw Fail.of("not_found", "no visible record to forget");
		if (n.revision !== c.expected_revision) throw conflict("revision", id);
		const why = mayChange({ origin: String(n.origin), pinned: Number(n.pinned) }, ctx.actor, who.profile);
		if (why) throw Fail.of("protected", "record is protected", { reason: why });
	} else {
		const a = activity(sql, c.activity_id);
		if (!a || a.redacted || a.undone_by) throw conflict("removal_unavailable");
		source = (JSON.parse(a.undo ?? "{}") as { archive_operation?: string }).archive_operation;
		const from = source ? archiveOperation(sql, source) : undefined;
		if (!from || from.action !== "forget" || from.state !== "complete" || from.cleanup) throw Fail.of("not_found", "no complete staged removal", { reason: "archive_missing" });
		for(const origin of from.countOrigins??[]){if(countOriginClosed(sql,origin))throw Fail.of("profile_wiped","an archived aggregate source origin is being wiped");countOrigins.add(origin);}
		const image = sql.exec<Archived>("SELECT id,source,payload FROM archive WHERE activity_id=? AND source='nodes'", c.activity_id).toArray()[0];
		if (!image) throw Fail.of("not_found", "archived node was purged", { reason: "archive_missing" });
		n = JSON.parse(image.payload) as Row; removal = c.activity_id;
		if (node(sql, String(n.id))) throw conflict("id_taken");
	}
	assertNotWiped(sql, String(n.id)); assertNoTouchingTransfer(sql, String(n.id));
	assertArchiveEndpoints(sql,String(n.id),String(n.id),"",true);
	for(const e of sql.exec<Row>("SELECT src,dst,dst_profile,count_key FROM edges WHERE src=?1 OR (dst_profile='' AND dst=?1)",String(n.id))){
		assertArchiveEndpoints(sql,String(e.src),String(e.dst),String(e.dst_profile));
		assertCountImageOpen(tx,e);
		const origin=countOrigin(e.count_key);if(origin)countOrigins.add(origin);
	}
	tx.archiveOperation=id;
	const act = Number(tx.run("INSERT INTO activity(at,actor,op,summary,targets,undo_of,seq) VALUES (?,'owner',?,'archive operation pending',?,?,?) RETURNING id",
		tx.now, undoOf ? "undo" : c.action, JSON.stringify([n.id]), undoOf ?? (c.action === "restore" ? removal : null), tx.seq).one().id);
	const o: ArchiveOperation = { id, node: String(n.id), ...(countOrigins.size?{countOrigins:[...countOrigins]}:{}), origin: n.source_profile === null ? null : String(n.source_profile), profile: who.profile, generation: who.generation,
		action: c.action, state: "running", phase: c.action === "forget" ? "archive_evidence" : "verify_archive", version: 1, activity: act, removal: removal || act,
		source, undoOf, original: { attrs: String(n.attrs), status: String(n.status), revision: Number(n.revision), seq: Number(n.seq) },
		fenceSeq: tx.seq, after: 0, rows: 0, hash: "", checked: 0, checkHash: "", guardVersion: "", cleanup: false, me: ctx.meGuard, createdAt: tx.now };
	if(undoOf&&c.action === "forget"){
		const source=(JSON.parse(activity(sql,undoOf)!.undo!) as {archive_operation:string}).archive_operation;
		o.validationSource=source;o.phase="validate_inverse";
	}
	if (c.action === "forget") {
		tx.run("UPDATE nodes SET status='moving',attrs=json_set(attrs,'$.archive_operation',?),seq=? WHERE id=?", id, tx.seq, o.node);
	} else {
		guard(sql,o,n);
		putRow(tx,"nodes",{ ...n,status:"incoming",attrs:JSON.stringify({ ...JSON.parse(String(n.attrs)),archive_operation:id }),embed_hash:null });
		save(tx, pinKey(removal), id);
	}
	save(tx, pinKey(act), id); save(tx, nodeKey(o.node,id), { operation:id, node:o.node, origin:o.origin });
	save(tx, opKey(id), o);
	tx.run("INSERT INTO cursors(stage,cursor,due_at) VALUES (?,?,?)",`archive:${id}`,JSON.stringify({operation:id}),Date.now());
	if(undoOf)save(tx,pinKey(undoOf),id);
	return o;
}
function checkFence(sql: SqlStorage, o: ArchiveOperation): void {
	assertNotWiped(sql,o.node);
	const n=node(sql,o.node);
	if (o.state !== "complete" && (!n || JSON.parse(String(n.attrs)).archive_operation !== o.id || n.seq !== o.fenceSeq || n.revision !== o.original?.revision)) throw conflict("node_fence",o.id,o.profile);
}
function advance(o: ArchiveOperation, phase: string): void { o.phase=phase;o.after=0; }
function forgetPage(tx: BudgetTx, o: ArchiveOperation, limit: number): void {
	const sql=tx.sql;
	let rows: Row[]=[];
	if(o.phase === "validate_inverse") {
		const from=archiveOperation(sql,o.validationSource!)!;
		const ps=parts(sql,from,o.after,limit);
		for(const p of ps){if(keyed(sql,p)?.seq!==p.seq)throw conflict("applied_row",o.id,o.profile);o.after=p.archive;}
		if(ps.length<limit){advance(o,"validate_inverse_extras");o.inverseLane=0;}
	} else if(o.phase === "validate_inverse_extras") {
		const from=archiveOperation(sql,o.validationSource!)!,lane=(["texts","revisions","edges","evidence"] as const)[o.inverseLane??0]!;
		const keys=PK[lane],tuple=["seq",...keys];
		const rows=sql.exec<Row>(`SELECT * FROM ${lane} WHERE seq>? AND seq<=? ${o.inverseKey?`AND (${tuple.join(",")})>(${tuple.map(()=>"?").join(",")})`:""} ORDER BY ${tuple.join(",")} LIMIT ?`,from.publishedSeq!,o.fenceSeq,...(o.inverseKey??[]),limit).toArray();
		for(const r of rows){
			let touches=lane === "edges"?r.src===o.node||(r.dst_profile === ""&&r.dst===o.node):lane !== "evidence"?r.node_id===o.node:r.owner===`n:${o.node}`;
			if(lane === "evidence"&&String(r.owner).startsWith("e:"))touches=Boolean(sql.exec("SELECT 1 FROM edges WHERE id=? AND (src=? OR (dst_profile='' AND dst=?))",Number(String(r.owner).slice(2)),o.node,o.node).toArray().length);
			if(touches)throw conflict("changed_since",o.id,o.profile);
			o.inverseKey=tuple.map(k=>r[k]!);
		}
		if(rows.length<limit){o.inverseLane=(o.inverseLane??0)+1;o.inverseKey=undefined;if(o.inverseLane===4)advance(o,"archive_evidence");}
	} else if(o.phase === "archive_evidence") {
		rows=sql.exec<Row>("SELECT * FROM evidence WHERE owner=? ORDER BY kind,ref LIMIT ?",`n:${o.node}`,limit).toArray();
		if(rows.length) appendImages(tx,o,"evidence",rows); else advance(o,"archive_edges");
	} else if(o.phase === "archive_edges") {
		const edges=sql.exec<Row>("SELECT * FROM edges WHERE id IN (SELECT id FROM (SELECT id FROM edges WHERE src=?1 ORDER BY rel,recorded_at,id LIMIT ?2) UNION SELECT id FROM (SELECT id FROM edges WHERE dst_profile='' AND dst=?1 ORDER BY rel,id LIMIT ?2)) ORDER BY id LIMIT ?2",o.node,limit).toArray();
		const evidence=edges.length ? sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner,kind,ref LIMIT ?",JSON.stringify(edges.map(e=>`e:${String(e.id)}`)),limit).toArray():[];
		if(evidence.length) appendImages(tx,o,"evidence",evidence); else if(edges.length) appendImages(tx,o,"edges",edges); else advance(o,"archive_texts");
	} else if(o.phase === "archive_texts" || o.phase === "archive_revisions") {
		const table=o.phase === "archive_texts" ? "texts":"revisions";
		rows=sql.exec<Row>(`SELECT * FROM ${table} WHERE node_id=? ORDER BY ${table === "texts"?"part,seq_no,chunk,rowid":"revision"} LIMIT ?`,o.node,limit).toArray();
		if(rows.length) appendImages(tx,o,table,rows); else advance(o,table === "texts"?"archive_revisions":"verify_forget");
	} else if(o.phase === "verify_forget") {
		const images=archived(sql,o.removal,o.after,limit);
		for(const a of images) {o.checkHash=chain(o.checkHash,a);o.checked++;o.after=a.id;}
		if(images.length<limit) {
			if(o.checked!==o.rows || o.checkHash!==o.hash) throw conflict("archive_manifest",o.id,o.profile);
			const n=node(sql,o.node)!;appendImages(tx,o,"nodes",[{...n,...o.original!}]);
			finish(tx,o);
		}
	}
}
const COPY_LANES: ArchiveSource[]=["edges","evidence","texts","revisions","requests"];
function restorePage(tx: BudgetTx, o: ArchiveOperation, limit: number, rollback=false): void {
	if(o.phase === "verify_archive") {
		const images=archived(tx.sql,o.removal,o.after,limit);
		for(const a of images){o.checkHash=chain(o.checkHash,a);o.checked++;o.after=a.id;}
		if(images.length<limit){
			const from=archiveOperation(tx.sql,o.source!)!;
			if(o.checked!==from.rows || o.checkHash!==from.hash)throw conflict("archive_manifest",o.id,o.profile);
			advance(o,"copy_edges");
		}
	} else if(o.phase.startsWith("copy_")) {
		// Each lane pages the removal by id on the existing index and copies only its own rows, so every page stays bounded.
		const lane=o.phase.slice(5) as ArchiveSource, offered=archived(tx.sql,o.removal,o.after,limit), images=fit(offered);
		for(const a of images){if(a.source === lane){copy(tx,o,a);o.rows++;if(rollback)tx.run("DELETE FROM archive WHERE id=?",a.id);}o.after=a.id;}
		if(images.length===offered.length && offered.length<limit){const next=COPY_LANES[COPY_LANES.indexOf(lane)+1];advance(o,next?`copy_${next}`:"validate");o.guardVersion=guardVersion(tx.sql,o);}
	} else if(o.phase === "validate") {
		const version=guardVersion(tx.sql,o);
		if(version!==o.guardVersion){o.after=0;o.guardVersion=version;}
		const rows=parts(tx.sql,o,o.after,limit);
		for(const p of rows){const r=keyed(tx.sql,p);if(!r||r.seq!==p.seq)throw conflict("applied_row",o.id,o.profile);guard(tx.sql,o,r);o.after=p.archive;}
		if(rows.length<limit){guard(tx.sql,o,node(tx.sql,o.node));advance(o,"publish");}
	} else if(o.phase === "publish") {
		if(o.guardVersion!==guardVersion(tx.sql,o)){advance(o,"validate");o.guardVersion=guardVersion(tx.sql,o);return;}
		tx.run("UPDATE nodes SET status=?,attrs=?,embed_hash=NULL,seq=? WHERE id=?",o.original!.status,o.original!.attrs,tx.seq,o.node);
		if(rollback){o.state="aborted";o.cleanup=true;advance(o,"cleanup_metadata");tx.run("UPDATE activity SET summary='archive operation aborted',undo=NULL,seq=? WHERE id=?",tx.seq,o.activity);}
		else {o.publishedSeq=tx.seq;finish(tx,o);}
	}
}
function finish(tx: BudgetTx, o: ArchiveOperation): void {
	o.state="complete";o.cleanup=o.action === "restore";advance(o,o.cleanup?"cleanup_archive":"done");
	const target=o.undoOf ?? (o.action === "restore"?o.removal:undefined);
	if(target)tx.run("UPDATE activity SET undone_by=?,seq=? WHERE id=? AND undone_by IS NULL",o.activity,tx.seq,target);
	tx.run("UPDATE activity SET summary=?,undo=?,seq=? WHERE id=?",`${o.action === "forget"?"forgot":"restored"} 1 record`,JSON.stringify({archive_operation:o.id}),tx.seq,o.activity);
	if(!o.cleanup){if(o.undoOf)tx.run("DELETE FROM profile_meta WHERE key=?",pinKey(o.undoOf));tx.run("DELETE FROM profile_meta WHERE key=?",pinKey(o.activity));tx.run("DELETE FROM cursors WHERE stage=?",`archive:${o.id}`);o.original=null;}
}
function rollbackRestore(tx: BudgetTx,o: ArchiveOperation,limit:number):void {
	const ps=parts(tx.sql,o,0,limit);
	for(const p of ps){const r=keyed(tx.sql,p);if(!r||r.seq!==p.seq)throw conflict("applied_row",o.id,o.profile);
		if(p.borrowed){tx.run("DELETE FROM profile_meta WHERE key=?",rowKey(o.id,p.archive));continue;}
		if(p.countBefore){
			const current=countPair(tx.sql,p.countBefore.key);
			if(!current || current.epoch!==p.countBefore.epoch || current.edge.id!==r.id || current.edge.seq!==p.seq)throw conflict("count_binding",o.id,o.profile);
			saveCountPair(tx,{...current,edge:p.countBefore.edge,archived:p.countBefore.archived});
		}
		tx.run(`DELETE FROM ${p.source} WHERE ${PK[p.source].map(k=>`${k}=?`).join(" AND ")} AND seq=?`,...p.key,p.seq);tx.run("DELETE FROM profile_meta WHERE key=?",rowKey(o.id,p.archive));}
	if(!ps.length){tx.run("DELETE FROM nodes WHERE id=? AND seq=?",o.node,o.fenceSeq);o.state="aborted";o.cleanup=true;advance(o,"cleanup_metadata");}
}
function cleanup(tx: BudgetTx,o: ArchiveOperation,limit:number):void {
	if(o.phase === "cleanup_archive"){
		const rows=archived(tx.sql,o.removal,0,limit);for(const a of rows)tx.run("DELETE FROM archive WHERE id=?",a.id);
		if(rows.length<limit){o.cleanup=false;advance(o,"done");o.original=null;tx.run("DELETE FROM profile_meta WHERE key=?",pinKey(o.removal));tx.run("DELETE FROM profile_meta WHERE key=?",pinKey(o.activity));tx.run("DELETE FROM cursors WHERE stage=?",`archive:${o.id}`);}
	} else {
		const prefix=`${opKey(o.id)}:`;
		const keys=tx.sql.exec<{key:string}>("SELECT key FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT ?",...range(prefix),limit).toArray();
		for(const k of keys)tx.run("DELETE FROM profile_meta WHERE key=?",k.key);
		if(keys.length<limit){o.cleanup=false;o.original=null;o.me=undefined;advance(o,"done");tx.run("DELETE FROM cursors WHERE stage=?",`archive:${o.id}`);for(const key of [pinKey(o.activity),pinKey(o.removal),...(o.undoOf?[pinKey(o.undoOf)]:[]),nodeKey(o.node,o.id)])tx.run("DELETE FROM profile_meta WHERE key=?",key);}
	}
}
function step(tx: BudgetTx, o: ArchiveOperation, limit:number):void {
	tx.archiveOperation=o.id;
	if(o.cleanup){cleanup(tx,o,limit);return;}
	if(o.action === "restore"&&o.state === "running"&&!o.undoOf&&sizeLevel(tx.sql.databaseSize) === "shrink_only")throw Fail.of("size_budget","restore is paused while the profile is over its size limit",{reason:"shrink_only"});
	checkFence(tx.sql,o);assertNoTouchingTransfer(tx.sql,o.node);
	if(o.state === "rolling_back") {
		if(o.action === "restore")rollbackRestore(tx,o,limit);else restorePage(tx,o,limit,true);
	} else if(o.action === "forget")forgetPage(tx,o,limit);else restorePage(tx,o,limit);
}
/** Exact receipts are immutable. The cursor owns progress; callers never provide a SQL position. */
export function runArchive(storage:DurableObjectStorage,who:Who,c:ArchiveCommand,ctx:WriteContext,undoOf?:number):Record<string,unknown>{
	if(ctx.actor!=="owner")throw Fail.of("forbidden","only the owner may run archive operations");
	for(let limit=25;;limit=Math.floor(limit/2))try{return storage.transactionSync(()=>{
		const sql=storage.sql;assertOpen(sql);
		const hash=undoOf?ctx.payloadHash:requestHash("archive",c);
		const prior=sql.exec<{payload_hash:string;result:string;node_id:string}>("SELECT payload_hash,result,node_id FROM requests WHERE request_id=?",c.request_id).toArray()[0];
		if(prior){assertNotWiped(sql,prior.node_id);if(prior.payload_hash!==hash)throw Fail.of("idempotency_mismatch","request id was used with different arguments");return {...JSON.parse(prior.result),action:"replayed"};}
		const tx=new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString());
		let o:ArchiveOperation;
		let action:string;
		if(c.action === "forget"||c.action === "restore"){if(undoOf) stagedUndo(sql,undoOf);o=begin(tx,who,c,ctx,undoOf);action=undoOf?"undo_started":`${c.action}_started`;}
		else {
			o=archiveOperation(sql,c.operation_id)!;
			if(!o||o.profile!==who.profile||o.generation!==who.generation)throw Fail.of("not_found","no archive operation");
			assertNotWiped(sql,o.node);
			if(c.cursor!==cursor(o))throw conflict("stale_cursor",o.id,o.profile);
			if(c.action === "abort"){
				if(o.state === "complete")throw conflict("published_use_undo",o.id,o.profile);
				checkFence(sql,o);o.state="rolling_back";o.after=0;o.rows=0;o.guardVersion=guardVersion(sql,o);advance(o,o.action === "forget"?"copy_edges":"rollback_restore");action="abort_started";
			}else {if(o.state!=="complete"&&o.state!=="aborted"||o.cleanup)step(tx,o,limit);action=o.state === "complete"?(o.undoOf?"undone":o.action === "forget"?"forgotten":"restored"):o.state === "aborted"?"aborted":"progressed";}
			o.version++;
		}
		const result=status(o,action);
		if((o.state === "running"||o.state === "rolling_back"||o.cleanup)&&c.action === "resume")tx.run("UPDATE cursors SET due_at=? WHERE stage=?",Date.now(),`archive:${o.id}`);
		save(tx,opKey(o.id),o);
		tx.run("INSERT INTO requests(request_id,op,payload_hash,result,node_id,at,seq) VALUES (?,?,?,?,?,?,?)",c.request_id,undoOf?"undo":"archive",hash,JSON.stringify(result),o.node,tx.now,tx.seq);
		return result;
	});}catch(e){if(!(e instanceof Fail)||e.failure.code!=="size_budget"||limit<=1)throw e;}
}

export function nextArchiveOperation(sql:SqlStorage):ArchiveOperation|undefined{
	const r=sql.exec<{cursor:string}>("SELECT cursor FROM cursors WHERE stage>='archive:' AND stage<'archive:~' AND due_at<=? ORDER BY due_at,stage LIMIT 1",Date.now()).toArray()[0];
	return r?archiveOperation(sql,(JSON.parse(r.cursor) as {operation:string}).operation):undefined;
}
export function stagedUndo(sql:SqlStorage,activityId:number):{operation:ArchiveOperation;command:Extract<ArchiveCommand,{action:"forget"|"restore"}>}|undefined{
	const a=activity(sql,activityId);if(!a)return;
	const id=(JSON.parse(a.undo??"{}") as {archive_operation?:string}).archive_operation;if(!id)return;
	const o=archiveOperation(sql,id);if(!o||a.redacted)throw conflict("undo_redacted");if(o.cleanup||o.state!=="complete")throw Fail.of("busy","archive cleanup is pending");
	if(a.undone_by)throw conflict("already_undone");
	if(o.action === "forget")return {operation:o,command:{action:"restore",activity_id:activityId,request_id:`undo:${activityId}`}};
	const n=node(sql,o.node);if(!n||n.seq!==o.publishedSeq)throw conflict("node_changed");
	return {operation:o,command:{action:"forget",memory_id:o.node,expected_revision:Number(n.revision),request_id:`undo:${activityId}`}};
}

export function stagedArchiveActivity(sql:SqlStorage,id:number):boolean {
	return Boolean((JSON.parse(activity(sql,id)?.undo??"{}") as {archive_operation?:string}).archive_operation);
}
export function archiveCursor(o:ArchiveOperation):string{return cursor(o);}

/** One keyset step over a node's indexed operations: the first entry after `key` ("" starts), with its operation id. */
export function nodeOperationAfter(sql:SqlStorage,node:string,key:string):{key:string;operation:string}|undefined {
	const e=sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>? AND key<? ORDER BY key LIMIT 1",key||`archive-node:${node}:`,`archive-node:${node}:~`).toArray()[0];
	return e?{key:e.key,operation:(JSON.parse(e.value) as {operation:string}).operation}:undefined;
}

/** Wipe owns this path. It never executes ordinary abort or restores any original fence fields. */
export function cancelArchivePage(tx:BudgetTx,ids:string[],limit=25):boolean {
	for(const id of ids){
		const prefix=`archive-node:${id}:`;
		const entry=tx.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 1",...range(prefix)).toArray()[0];
		if(!entry)continue;
		const operation=(JSON.parse(entry.value) as {operation:string}).operation;
		const o=archiveOperation(tx.sql,operation);
		if(!o){tx.run("DELETE FROM profile_meta WHERE key=?",entry.key);return false;}
		const ps=parts(tx.sql,o,0,limit);
		for(const p of ps){
			// Requests stay for the account's request-fence pass before ordinary purge deletes their result bytes.
			if(!p.borrowed&&o.state!=="complete"&&p.source!=="requests"&&keyed(tx.sql,p)?.seq===p.seq)tx.run(`DELETE FROM ${p.source} WHERE ${PK[p.source].map(k=>`${k}=?`).join(" AND ")} AND seq=?`,...p.key,p.seq);
			tx.run("DELETE FROM profile_meta WHERE key=?",rowKey(o.id,p.archive));
		}
		if(ps.length)return false;
		const images=archived(tx.sql,o.removal,0,limit);
		for(const a of images)tx.run("DELETE FROM archive WHERE id=?",a.id);
		if(images.length)return false;
		const keys=tx.sql.exec<{key:string}>("SELECT key FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT ?",...range(`${opKey(o.id)}:`),limit).toArray();
		for(const k of keys)tx.run("DELETE FROM profile_meta WHERE key=?",k.key);
		if(keys.length)return false;
		// Clear copied identity/fence material, keeping an ordinary source node available for request discovery and purge.
		if(o.action === "restore"&&o.state!=="complete")tx.run("DELETE FROM nodes WHERE id=? AND (seq=? OR seq=?)",o.node,o.fenceSeq,o.publishedSeq??-1);
		else tx.run("UPDATE nodes SET attrs=json_remove(attrs,'$.archive_operation'),seq=? WHERE id=? AND json_extract(attrs,'$.archive_operation')=?",tx.seq,o.node,o.id);
		tx.run("UPDATE activity SET undo=NULL,summary='archive operation redacted by wipe',redacted='wipe',seq=? WHERE id=?",tx.seq,o.activity);
		tx.run("DELETE FROM cursors WHERE stage=?",`archive:${o.id}`);
		for(const k of [opKey(o.id),pinKey(o.activity),pinKey(o.removal),...(o.undoOf?[pinKey(o.undoOf)]:[]),entry.key])tx.run("DELETE FROM profile_meta WHERE key=?",k);
		return false;
	}
	return true;
}

/** Called before an expired activity is deleted. Retained key maps disappear in measured pages, their node index last. */
export function retireArchivePage(tx:BudgetTx,activityId:number):boolean {
	const a=activity(tx.sql,activityId),id=(JSON.parse(a?.undo??"{}") as {archive_operation?:string}).archive_operation;
	if(!id)return true;
	const o=archiveOperation(tx.sql,id);if(!o)return true;
	if(o.cleanup||!["complete","aborted"].includes(o.state)||tx.sql.exec("SELECT 1 FROM archive WHERE activity_id=? LIMIT 1",o.removal).toArray().length)return false;
	const keys=tx.sql.exec<{key:string}>("SELECT key FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 25",...range(`${opKey(id)}:`)).toArray();
	for(const k of keys)tx.run("DELETE FROM profile_meta WHERE key=?",k.key);
	if(keys.length)return false;
	for(const k of [opKey(id),nodeKey(o.node,id)])tx.run("DELETE FROM profile_meta WHERE key=?",k);
	return true;
}

export function nextArchiveAlarm(sql:SqlStorage):number|null {
	return sql.exec<{at:number|null}>("SELECT min(due_at) AS at FROM cursors WHERE stage>='archive:' AND stage<'archive:~'").one().at;
}
export function deferArchive(tx:BudgetTx,id:string,reason:string):void {
	tx.run("UPDATE cursors SET due_at=?,last_error=? WHERE stage=?",Date.now()+60_000,reason,`archive:${id}`);
}

/** Quiesce only accepted archive operations carrying this origin's person-owned count state. */
export function drainCountArchives(storage:DurableObjectStorage,who:Who,origin:string,after:string):{ids:string[];after:string|null} {
	const scan=after==="!"?"":after;
	const rows=storage.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>? AND key<'archive-op:~' ORDER BY key LIMIT 10",scan||"archive-op:").toArray();
	for(const row of rows){
		const o=JSON.parse(row.value) as Partial<ArchiveOperation>;
		if(!o.id || !o.node || !o.state || !(["running","rolling_back"].includes(o.state)||o.cleanup))continue;
		const start=`work-count:${origin}:pair:${o.node}:`;
		if(!o.countOrigins?.includes(origin) && !storage.sql.exec("SELECT 1 FROM profile_meta WHERE key>=? AND key<? LIMIT 1",start,start+"~").toArray().length)continue;
		const closed=countOriginClosed(storage.sql,origin);
		const action=o.state==="running" && closed && o.fenceSeq!>closed.seq?"abort":"resume";
		const cmd={action,operation_id:o.id,cursor:cursor(o as ArchiveOperation),request_id:`count-wipe:${origin}:${o.id}:${o.version}:${action}`} as const;
		runArchive(storage,who,cmd,{actor:"owner",platform:"server",routedBy:"wipe",payloadHash:requestHash("archive",cmd),userId:who.userId});
		return {ids:[],after:scan||"!"};
	}
	return {ids:[],after:rows.length===10?rows.at(-1)!.key:null};
}

interface CountRedaction { phase:"archives"|"evidence"|"maps"|"manifests"|"cleanup"|"done"; after:number; key:string; edge?:{id:number;activity:number;owner:string;resume:number}; }
const countGone=(origin:string,id:number)=>`count-redacted:${origin}:${String(id).padStart(16,"0")}`;
const countManifest=(origin:string,id:number)=>`count-manifest:${origin}:${String(id).padStart(16,"0")}`;

function redactCountImage(tx:BudgetTx,origin:string,a:Archived & {activity_id:number}):void {
	const token={hash:sha256(a.payload)};
	save(tx,countGone(origin,a.id),token);
	const owner=activity(tx.sql,a.activity_id);
	if(owner?.undo){
		const inv=JSON.parse(owner.undo) as {archived?:number[];archive_operation?:string};
		if(inv.archived){inv.archived=inv.archived.filter(id=>id!==a.id);tx.run("UPDATE activity SET undo=?,seq=? WHERE id=?",JSON.stringify(inv),tx.seq,a.activity_id);}
		if(inv.archive_operation && !read(tx.sql,countManifest(origin,a.activity_id))){
			const o=archiveOperation(tx.sql,inv.archive_operation);
			if(o?.action==="forget" && o.state==="complete" && !o.cleanup)save(tx,countManifest(origin,a.activity_id),{operation:o.id,createdAt:o.createdAt,after:0,hash:"",rows:0});
		}
	}
	tx.run("DELETE FROM archive WHERE id=?",a.id);
}

/** Remove derived images while retaining every unrelated personal row and reseal its remaining manifest in pages. */
export function redactCountArchives(tx:BudgetTx,origin:string):boolean {
	const key=`count-redaction:${origin}`;
	const v=read<CountRedaction>(tx.sql,key)??{phase:"archives",after:0,key:""};
	if(v.phase==="archives"){
		const rows=tx.sql.exec<Archived&{activity_id:number}>("SELECT id,activity_id,source,payload FROM archive WHERE id>? ORDER BY id LIMIT 10",v.after).toArray();
		let held=false;
		for(const a of rows){
			if(a.source==="edges"){
				const e=JSON.parse(a.payload) as Row;
				if(countOrigin(e.count_key)===origin){v.edge={id:a.id,activity:a.activity_id,owner:`e:${String(e.id)}`,resume:a.id};v.phase="evidence";v.after=0;held=true;break;}
			}
			v.after=a.id;
		}
		if(!held && rows.length<10){v.phase="maps";v.key="";}
	}else if(v.phase==="evidence"){
		const e=v.edge!;
		const rows=tx.sql.exec<Archived&{activity_id:number}>("SELECT id,activity_id,source,payload FROM archive WHERE activity_id=? AND id>? ORDER BY id LIMIT 10",e.activity,v.after).toArray();
		for(const a of rows){if(a.source==="evidence" && (JSON.parse(a.payload) as Row).owner===e.owner)redactCountImage(tx,origin,a);v.after=a.id;}
		if(rows.length<10){
			const a=tx.sql.exec<Archived&{activity_id:number}>("SELECT id,activity_id,source,payload FROM archive WHERE id=?",e.id).toArray()[0];
			if(a)redactCountImage(tx,origin,a);
			v.phase="archives";v.after=e.resume;delete v.edge;
		}
	}else if(v.phase==="maps"){
		const rows=tx.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>? AND key<'archive-op:~' ORDER BY key LIMIT 10",v.key||"archive-op:").toArray();
		for(const r of rows){
			const p=JSON.parse(r.value) as Applied;
			const gone=p.archive?read<{hash:string}>(tx.sql,countGone(origin,p.archive)):undefined;
			if((gone && gone.hash===p.hash) || p.countBefore?.origin===origin){
				tx.run("DELETE FROM profile_meta WHERE key=?",r.key);
			}
			v.key=r.key;
		}
		if(rows.length<10){v.phase="manifests";v.key="";}
	}else if(v.phase==="manifests"){
		const start=`count-manifest:${origin}:`;
		const row=tx.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 1",start,start+"~").toArray()[0];
		if(!row){v.phase="cleanup";v.key="";}
		else{
			const m=JSON.parse(row.value) as {operation:string;createdAt:string;after:number;hash:string;rows:number};
			const o=archiveOperation(tx.sql,m.operation);
			if(!o || o.createdAt!==m.createdAt || o.state!=="complete" || o.cleanup)throw conflict("count_manifest_owner");
			const rows=archived(tx.sql,o.removal,m.after,10);
			for(const a of rows){m.hash=chain(m.hash,a);m.rows++;m.after=a.id;}
			if(rows.length<10){o.hash=m.hash;o.rows=m.rows;if(o.countOrigins)o.countOrigins=o.countOrigins.filter(x=>x!==origin);save(tx,opKey(o.id),o);tx.run("DELETE FROM profile_meta WHERE key=?",row.key);}
			else save(tx,row.key,m);
		}
	}else if(v.phase==="cleanup"){
		const start=`count-redacted:${origin}:`;
		const rows=tx.sql.exec<{key:string}>("SELECT key FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 10",start,start+"~").toArray();
		for(const r of rows)tx.run("DELETE FROM profile_meta WHERE key=?",r.key);
		if(!rows.length)v.phase="done";
	}
	save(tx,key,v);
	return v.phase==="done";
}
