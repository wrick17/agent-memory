import { countOrigin, unownedCountHistory, purgePersonCounts, countRequestPage, countStatePage, purgeOriginCounts, type CommitReceipt, type CountPair } from "./work-counts";
import { drainCountArchives, redactCountArchives } from "./archive-operations";
// A profile's part of a wipe (section 9, steps 3, 4 and 6). It lists the ids a wipe purges here, names their request ids so the
// account can fence them first, purges them in bounded steps with their activity redacted first, reports hand-written matches
// without touching them, and clears a wiped generation. The Worker keeps the content-free plan in R2 before any purge.
import { archiveOperation, cancelArchivePage, nodeOperationAfter } from "./archive-operations";
import { meGuard, namedTerm } from "../domain/guard";
import { sha256 } from "../domain/ids";
import { Fail, ok, type Outcome } from "../domain/types";
import { nextSeq } from "../storage";
import { BudgetTx, type Row } from "./archive";
import { vectorId } from "./index";
import { bundleTexts, type Entry } from "./transfer";
import type { Who } from "./write";

/** One page of a wipe: the wiped profile, its wipe time, at most 100 node ids, and the terms the wiped profile had. */
/** keep: ids the me exception preserved in this wipe; never fenced, redacted or refused elsewhere, so the survivor can still move. */
export interface OriginWipe { profile: string; at: string; ids: string[]; terms: string[]; keep?: string[] }
export interface Page { ids: string[]; after: string | null }
export interface PurgeResult { done: boolean; purged: string[]; redacted: number; preserved: string[] }

export type WipeStep =
	| {op:"count_close"|"count_cleanup";profile:string;at:string}
	| {op:"count_requests"|"count_transfers"|"count_archives";profile:string;after:string}

	| { op: "origin"; profile: string; after: string }
	| { op: "requests"; wipe: OriginWipe; after: string }
	| { op: "purge"; wipe: OriginWipe }
	| { op: "handwritten"; profile: string; terms: string[]; after: string }
	| { op: "close" }
	| { op: "fence"; wipe: OriginWipe }
	| { op: "clear" };
export type WipeOut = Page | PurgeResult | { cleared: number };

const PAGE = 100;
const marker = (w: OriginWipe) => `wipe:${w.profile}:${w.at}`;

/** Ids to purge here: every node, archived node and tombstone whose first origin is the wiped profile (all of them in the profile itself). */
export function originPage(sql: SqlStorage, who: Who, profile: string, after: string): Page {
	const all = who.profile === profile ? 1 : 0;
	const ids = sql.exec<{ id: string }>(`SELECT id FROM (
		SELECT id FROM nodes WHERE source_profile = ? OR (? AND source_profile IS NULL)
		UNION SELECT json_extract(payload, '$.id') AS id FROM archive WHERE source = 'nodes' AND (json_extract(payload, '$.source_profile') = ? OR (? AND json_extract(payload, '$.source_profile') IS NULL))
		UNION SELECT json_extract(value,'$.node') AS id FROM profile_meta WHERE key>='archive-node:' AND key<'archive-node:~' AND (json_extract(value,'$.origin')=? OR ?)
	) WHERE id > ? ORDER BY id LIMIT ${PAGE}`, profile, all, profile, all, profile, all, after).toArray().map((r) => r.id);
	return { ids, after: ids.length === PAGE ? ids.at(-1)! : null };
}

/**
 * The one exception (section 9, step 5): a preference in me that landed with a company_free attestation survives, and only
 * while it still passes the me guard. Since issue #3 no work-term list decides it: the provenance and attestation do.
 */
export function survives(sql: SqlStorage, who: Who, id: string): boolean {
	if (who.profile !== "me") return false;
	const n = sql.exec<Row>("SELECT * FROM nodes WHERE id = ? AND kind = 'preference' AND status IN ('active','retired','superseded','moving') AND json_extract(attrs, '$.company_free') = 1", id).toArray()[0];
	if (!n) return false;
	const rows = [n, ...sql.exec<Row>("SELECT * FROM texts WHERE node_id = ?", id).toArray(), ...sql.exec<Row>("SELECT * FROM revisions WHERE node_id = ?", id).toArray()];
	return meGuard(bundleTexts(rows)).ok;
}

type Image = { wipe: string; terms: string; seq: number; key: string; entry: string; after: number; last?: true; clean?: true };
type Scan = { tx: BudgetTx; left: number };

/**
 * A staged archive operation moves a survivor's texts and revisions into archive rows before its node goes, so the same check
 * also reads those rows: every indexed operation's removal in key order, then the node's own unfinished operation, whose
 * removal can still grow, up to its end in the deciding call. Fence spends one work budget per call across all ids (index
 * entries, operation reads and archive rows) and keeps a fixed-size cursor against this wipe, its terms and the node's seq,
 * which every operation start and publish changes; any other value starts again.
 */
function image(sql: SqlStorage, w: OriginWipe, id: string, scan?: Scan): "clean" | "pending" | "sensitive" {
	if (!nodeOperationAfter(sql, id, "")) return "clean";
	const n = sql.exec<Row>("SELECT seq, status, attrs FROM nodes WHERE id = ?", id).one();
	const at = { wipe: marker(w), terms: sha256(JSON.stringify(w.terms)), seq: Number(n.seq) };
	const stored = sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = ?", `wipe-image:${id}`).toArray()[0];
	let v = stored ? JSON.parse(stored.value) as Image : undefined;
	if (!v || v.wipe !== at.wipe || v.terms !== at.terms || v.seq !== at.seq) v = { ...at, key: "", entry: "", after: 0 };
	if (v.clean) return "clean";
	if (!scan || scan.left <= 0) return "pending";
	const fence = n.status === "moving" ? (JSON.parse(String(n.attrs)) as { archive_operation?: string }).archive_operation : undefined;
	const own = fence ? archiveOperation(sql, fence) : undefined, active = own?.node === id ? own : undefined;
	let verdict: "clean" | "pending" | "sensitive" = "pending";
	while (scan.left > 0) {
		let removal: number;
		if (v.last) {
			if (!active) { verdict = "clean"; break; }
			removal = active.removal;
		} else {
			const e = nodeOperationAfter(sql, id, v.key); scan.left--;
			if (!e) { v.last = true; v.after = 0; continue; }
			if (e.key !== v.entry) { v.entry = e.key; v.after = 0; }
			if (e.operation === active?.id) { v.key = e.key; continue; }
			const o = archiveOperation(sql, e.operation); scan.left--;
			// Missing operation state is unknown, never empty.
			if (!o) { verdict = "sensitive"; break; }
			removal = o.removal;
			if (scan.left <= 0) break;
		}
		const take = scan.left;
		const rows = sql.exec<{ id: number; source: string; payload: string }>("SELECT id, source, payload FROM archive WHERE activity_id = ? AND id > ? ORDER BY id LIMIT ?", removal, v.after, take).toArray();
		scan.left -= Math.max(1, rows.length);
		const material = rows.filter((a) => a.source === "nodes" || a.source === "texts" || a.source === "revisions").map((a) => JSON.parse(a.payload) as Row);
		if (!meGuard(bundleTexts(material)).ok) { verdict = "sensitive"; break; }
		if (rows.length) v.after = rows.at(-1)!.id;
		if (rows.length < take) { if (v.last) { verdict = "clean"; break; } v.key = v.entry; v.after = 0; }
	}
	if (verdict === "sensitive") return verdict;
	if (verdict === "clean") v.clean = true;
	scan.tx.run("INSERT INTO profile_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `wipe-image:${id}`, JSON.stringify(v));
	return verdict;
}

/**
 * The page's ids this profile holds, as a node or as archived rows, that do not survive. A permanent fence never survives.
 * Only fence scans; elsewhere an unread image counts as not surviving.
 */
function held(sql: SqlStorage, who: Who, w: OriginWipe, scan?: Scan): { here: string[]; preserved: string[]; pending: string[] } {
	if (w.ids.length > PAGE || Buffer.byteLength(JSON.stringify(w)) > 100_000) throw Fail.of("validation", "a wipe page holds at most 100 ids and 100 KB");
	const json = JSON.stringify(w.ids);
	const present = new Set(sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?1))
		UNION SELECT coalesce(json_extract(payload, '$.node_id'), json_extract(payload, '$.src'), json_extract(payload, '$.id')) AS id FROM archive
		WHERE coalesce(json_extract(payload, '$.node_id'), json_extract(payload, '$.src'), json_extract(payload, '$.id')) IN (SELECT value FROM json_each(?1))
		UNION SELECT value AS id FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM profile_meta WHERE key='wiped:'||json_each.value)`, json).toArray().map((r) => r.id));
	const wiped = new Set(sql.exec<{ id: string }>("SELECT value AS id FROM json_each(?) WHERE EXISTS (SELECT 1 FROM profile_meta WHERE key='wiped:'||json_each.value)", json).toArray().map((r) => r.id));
	const here: string[] = [], preserved: string[] = [], pending: string[] = [];
	for (const id of w.ids) {
		if (!present.has(id)) continue;
		const verdict = who.profile === w.profile || wiped.has(id) || !survives(sql, who, id) ? "sensitive" : image(sql, w, id, scan);
		(verdict === "clean" ? preserved : verdict === "pending" && scan ? pending : here).push(id);
	}
	return { here, preserved, pending };
}

/** The page's ids this profile fences and redacts: all of them but the me exception's survivors. me decides from its own image. */
function fenced(who: Who, w: OriginWipe, spare: string[]): string[] {
	const spared = new Set([...spare, ...(who.profile === "me" ? [] : w.keep ?? [])]);
	return w.ids.filter((id) => !spared.has(id));
}

/** One transaction deletes a bounded prefix. Activity is redacted before any payload goes; each node row goes last. */
function purge(sql: SqlStorage, who: Who, w: OriginWipe): PurgeResult {
	const { here, preserved } = held(sql, who, w);
	const out: PurgeResult = { done: false, purged: [], redacted: 0, preserved };
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	// So a later write path can refuse to recreate a purged id here (assertNotWiped).
	for (const id of fenced(who, w, preserved)) tx.run("INSERT OR IGNORE INTO profile_meta (key, value) VALUES (?, ?)", `wiped:${id}`, marker(w));
	if(!cancelArchivePage(tx,fenced(who,w,preserved),10))return out;
	// Any activity row naming a purged id may hold its content (an update's undo, a move's record): only content-free facts stay.
	const activities = sql.exec<Row>(`SELECT id, op, targets FROM activity WHERE redacted IS NOT ? AND EXISTS
		(SELECT 1 FROM json_each(activity.targets) WHERE value IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 20`, marker(w), JSON.stringify(fenced(who, w, preserved))).toArray();
	for (const a of activities) {
		tx.run("UPDATE activity SET summary = ?, undo = NULL, redacted = ?, seq = ? WHERE id = ?",
			`${String(a.op)}, ${(JSON.parse(String(a.targets)) as unknown[]).length} records, redacted by wipe of ${w.profile}`, marker(w), tx.seq, a.id!);
		out.redacted++;
	}
	if (activities.length) return out;
	for (const id of here) {
		const edgeIds = sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ? ORDER BY id LIMIT 40", id).toArray().map((r) => r.id);
		const owners = JSON.stringify([`n:${id}`, ...edgeIds.map((e) => `e:${e}`)]);
		// Edges elsewhere that point at the id are kept: an opaque backlink (section 9, step 6).
		const batches: [string, SqlStorageValue[]][] = [
			["DELETE FROM requests WHERE request_id IN (SELECT request_id FROM requests WHERE node_id = ? LIMIT 100)", [id]],
			["DELETE FROM texts WHERE rowid IN (SELECT rowid FROM texts WHERE node_id = ? LIMIT 60)", [id]],
			["DELETE FROM revisions WHERE (node_id, revision) IN (SELECT node_id, revision FROM revisions WHERE node_id = ? LIMIT 100)", [id]],
			["DELETE FROM evidence WHERE (owner, kind, ref) IN (SELECT owner, kind, ref FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) LIMIT 100)", [owners]],
			["DELETE FROM edges WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(edgeIds)]],
			[`DELETE FROM archive WHERE id IN (SELECT id FROM archive WHERE
				(source = 'nodes' AND json_extract(payload, '$.id') = ?1) OR
				(source IN ('texts','revisions','requests') AND json_extract(payload, '$.node_id') = ?1) OR
				(source = 'edges' AND json_extract(payload, '$.src') = ?1) OR
				(source = 'evidence' AND (json_extract(payload, '$.owner') = ?2 OR json_extract(payload, '$.owner') IN
					(SELECT 'e:' || json_extract(payload, '$.id') FROM archive WHERE source = 'edges' AND json_extract(payload, '$.src') = ?1)))
				ORDER BY CASE source WHEN 'evidence' THEN 0 WHEN 'edges' THEN 1 ELSE 2 END LIMIT 30)`, [id, `n:${id}`]],
			["DELETE FROM maintenance WHERE id IN (SELECT maintenance.id FROM maintenance, json_each(subjects) WHERE value = ? LIMIT 40)", [id]],
			// v2: recall counts, and eval candidates whose expected ids or node evidence name the purged node (content-bearing).
			["DELETE FROM recall_daily WHERE (node_id, day) IN (SELECT node_id, day FROM recall_daily WHERE node_id = ? LIMIT 100)", [id]],
			[`DELETE FROM eval_candidates WHERE id IN (SELECT c.id FROM eval_candidates c WHERE EXISTS (SELECT 1 FROM json_each(c.expected_json) WHERE value = ?1)
				OR EXISTS (SELECT 1 FROM json_each(c.evidence_json) e WHERE json_extract(e.value, '$.kind') = 'node' AND json_extract(e.value, '$.ref') = ?1) LIMIT 40)`, [id]],
			// #127 guidance receipts naming the purged record (ids only, kept tidy so no stat outlives it).
			["DELETE FROM guidance_injections WHERE rowid IN (SELECT rowid FROM guidance_injections WHERE memory_id = ? LIMIT 100)", [id]],
			["DELETE FROM correction_matches WHERE rowid IN (SELECT rowid FROM correction_matches WHERE rule_id = ?1 OR session_id = ?1 LIMIT 100)", [id]],
			["DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT p.transfer_id, p.n FROM transfer_parts p JOIN transfers t ON t.id = p.transfer_id WHERE t.node_id = ? LIMIT 60)", [id]],
			["DELETE FROM transfers WHERE id IN (SELECT id FROM transfers WHERE node_id = ? LIMIT 40)", [id]],
		];
		for (const [q, args] of batches) {
			const before = tx.rows;
			tx.run(q, ...args);
			if (tx.rows > before) return out;
		}
		if(!purgePersonCounts(tx,id,who.profile))return out;
		if (sql.exec("SELECT 1 FROM nodes WHERE id = ?", id).toArray().length) {
			tx.run("DELETE FROM nodes WHERE id = ?", id);
			out.purged.push(id);
			return out;
		}
	}
	return { ...out, done: true };
}

/** Request ids of the page's purged records, which the account fences as wiped before their results are deleted. */
function requestPage(sql: SqlStorage, who: Who, w: OriginWipe, after: string): Page {
	const ids = sql.exec<{ request_id: string }>(`SELECT request_id FROM requests WHERE node_id IN (SELECT value FROM json_each(?)) AND request_id > ? ORDER BY request_id LIMIT ${PAGE}`,
		// A survivor's request ids are shared with its old tombstones' copies; they stay bound to the survivor.
		JSON.stringify(fenced(who,w,held(sql,who,w).preserved)), after).toArray().map((r) => r.request_id);
	return { ids, after: ids.length === PAGE ? ids.at(-1)! : null };
}

/** Surviving records whose text names a term of the wiped profile: listed for the owner, never changed (section 9, step 6). */
export function handwrittenPage(sql: SqlStorage, origin: string, terms: string[], after: string): Page {
	const rows = sql.exec<Row>(`SELECT * FROM nodes WHERE id > ? AND status <> 'moved' AND (source_profile IS NULL OR source_profile <> ?) ORDER BY id LIMIT 40`, after, origin).toArray();
	// A read-only report for the owner: nothing here moves, hides or deletes a record.
	const ids = rows.filter((n) => namedTerm(bundleTexts([n, ...sql.exec<Row>("SELECT body FROM texts WHERE node_id = ?", n.id!).toArray()]), terms) !== null).map((n) => String(n.id));
	return { ids, after: rows.length === 40 ? String(rows.at(-1)!.id) : null };
}

/** The wiped profile's own generation: its vectors by their generation-qualified ids, in pages, then every row. */
async function clear(storage: DurableObjectStorage, env: Env, who: Who): Promise<{ cleared: number }> {
	let cleared = 0;
	if (storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").toArray().length) {
		for (let after = ""; ;) {
			const ids = storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id > ? ORDER BY id LIMIT ${PAGE}`, after).toArray().map((r) => r.id);
			if (!ids.length) break;
			if (env.VECTORS) await env.VECTORS.deleteByIds(ids.map((id) => vectorId(who, id)));
			cleared += ids.length;
			after = ids.at(-1)!;
		}
	}
	await storage.deleteAlarm();
	await storage.deleteAll();
	storage.sql.exec("CREATE TABLE IF NOT EXISTS profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
	storage.sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('closed', 'wiped')");
	return { cleared };
}

/** ProfileStore.purgeOrigin(who, step), after bind(who). Internal RPC only: the owner's wipe route is the one caller. */
interface CountCleanup {phase:"requests"|"activity"|"archives"|"edges"|"state"|"done";after:string;id:number|null}
function cleanupCounts(sql:SqlStorage,origin:string,at:string):PurgeResult {
	const tx=new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString());
	const key=`count-cleanup:${origin}:${at}`;
	const old=sql.exec<{value:string}>("SELECT value FROM profile_meta WHERE key=?",key).toArray()[0];
	const v:CountCleanup=old?JSON.parse(old.value) as CountCleanup:{phase:"requests",after:"",id:0};
	let redacted=0;
	if(v.phase==="requests"){
		const rows=sql.exec<{request_id:string;commit_meta:string|null}>("SELECT request_id,commit_meta FROM requests WHERE request_id>? ORDER BY request_id LIMIT 10",v.after).toArray();
		for(const row of rows){
			const m=row.commit_meta?JSON.parse(row.commit_meta) as CommitReceipt:undefined;
			if(m?.origin===origin){
				if(m.local)tx.run("UPDATE activity SET undo=NULL,summary='upload redacted by origin wipe',redacted=?,seq=? WHERE id=? AND at=? AND json_extract(undo,'$.seq')=?",`wipe:${origin}:${at}`,tx.seq,m.owner.id,m.owner.at,m.owner.seq);
				tx.run("DELETE FROM requests WHERE request_id=?",row.request_id);
			}
			v.after=row.request_id;
		}
		if(rows.length<10){v.phase="activity";v.id=0;}
	}else if(v.phase==="activity"){
		const rows=sql.exec<{id:number;op:string;undo:string|null}>("SELECT id,op,undo FROM activity WHERE id>? ORDER BY id LIMIT 10",v.id).toArray();
		for(const a of rows){
			const inv=a.undo?JSON.parse(a.undo) as {commitReceipt?:CommitReceipt;countOrigins?:string[]}:undefined;
			if(inv?.commitReceipt?.origin===origin || inv?.countOrigins?.includes(origin)){
				tx.run("UPDATE activity SET undo=NULL,summary=?,redacted=?,seq=? WHERE id=?",`${a.op} redacted by origin wipe`,`wipe:${origin}:${at}`,tx.seq,a.id);redacted++;
			}
			v.id=a.id;
		}
		if(rows.length<10)v.phase="archives";
	}else if(v.phase==="archives"){
		if(redactCountArchives(tx,origin)){v.phase="edges";v.id=null;}
	}else if(v.phase==="edges"){
		// Ordinary history has no registered pair on a foreign profile. Page by the physical key before filtering.
		const rows=v.id===null?sql.exec<Row>("SELECT id,count_key,count_epoch FROM edges ORDER BY id LIMIT 10").toArray():sql.exec<Row>("SELECT id,count_key,count_epoch FROM edges WHERE id>? ORDER BY id LIMIT 10",v.id).toArray();
		for(const row of rows){
			if(unownedCountHistory(row) && countOrigin(row.count_key)===origin){
				tx.run("DELETE FROM evidence WHERE (owner,kind,ref) IN (SELECT owner,kind,ref FROM evidence WHERE owner=? LIMIT 25)",`e:${row.id}`);
				if(sql.exec("SELECT 1 FROM evidence WHERE owner=? LIMIT 1",`e:${row.id}`).toArray().length)break;
				tx.run("DELETE FROM edges WHERE id=?",row.id!);
			}
			v.id=Number(row.id);
			if(tx.spent(.5))break;
		}
		if(rows.length<10 && (!rows.length || v.id===rows.at(-1)!.id))v.phase="state";
	}else if(v.phase==="state"){
		if(purgeOriginCounts(tx,origin))v.phase="done";
	}
	if(v.phase==="done"){v.after="";v.id=0;}
	tx.run("INSERT INTO profile_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key,JSON.stringify(v));
	return {done:v.phase==="done",purged:[],redacted,preserved:[]};
}
function countTransfers(storage:DurableObjectStorage,origin:string,after:string):Page {
	return storage.transactionSync(()=>{
		const sql=storage.sql,tx=new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString()),ids=new Set<string>();
		const stop=(id:string|undefined)=>{
			if(!id)return;
			const t=sql.exec<{state:string}>("SELECT state FROM transfers WHERE id=?",id).toArray()[0];
			if(t && (!["committed","aborted"].includes(t.state)||sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id=? LIMIT 1",id).toArray().length)){
				ids.add(id);tx.run("INSERT OR REPLACE INTO profile_meta(key,value) VALUES(?,?)",`work-count-stop-transfer:${id}`,JSON.stringify({origin}));
			}
		};
		const moving=(person:SqlStorageValue)=>{
			const n=sql.exec<{attrs:string}>("SELECT attrs FROM nodes WHERE id=?",person).toArray()[0];
			stop(n?(JSON.parse(n.attrs) as {transfer?:{id?:string}}).transfer?.id:undefined);
		};
		const cursor=after.startsWith("{")?JSON.parse(after) as {phase:"edges"|"archives"|"parts";id:number|null;transfer?:string;n?:number}:undefined;
		if(!cursor){
			const page=countStatePage(sql,origin,after);
			for(const r of page.rows){const p=JSON.parse(r.value) as CountPair;if(p.kind==="pair"){moving(p.person);stop(p.transfer);}}
			return {ids:[...ids],after:page.after??JSON.stringify({phase:"edges",id:null})};
		}
		if(cursor.phase!=="parts"){
			const rows=cursor.phase==="edges"?(cursor.id===null?sql.exec<Row>("SELECT id,src,count_key FROM edges ORDER BY id LIMIT 10").toArray():sql.exec<Row>("SELECT id,src,count_key FROM edges WHERE id>? ORDER BY id LIMIT 10",cursor.id).toArray()):sql.exec<Row>("SELECT id,source,payload FROM archive WHERE id>? ORDER BY id LIMIT 10",cursor.id).toArray();
			for(const row of rows){const e=cursor.phase==="edges"?row:row.source==="edges"?JSON.parse(String(row.payload)) as Row:undefined;if(e && countOrigin(e.count_key)===origin)moving(e.src!);}
			return {ids:[...ids],after:JSON.stringify(rows.length===10?{...cursor,id:Number(rows.at(-1)!.id)}:{phase:cursor.phase==="edges"?"archives":"parts",id:0})};
		}
		// Source parts retain the original image; target ledgers retain only its origin labels. One immutable part per page.
		const part=sql.exec<{transfer_id:string;n:number;payload:string}>("SELECT transfer_id,n,payload FROM transfer_parts WHERE (transfer_id,n)>(?,?) ORDER BY transfer_id,n LIMIT 1",cursor.transfer??"",cursor.n??0).toArray()[0];
		if(!part)return {ids:[...ids],after:null};
		const payload=JSON.parse(part.payload) as Entry[]|{countOrigins?:string[]};
		const carries=Array.isArray(payload)?payload.some(([table,row])=>{const e=table==="edges"?row:table==="archive"&&row.source==="edges"?JSON.parse(String(row.payload)) as Row:undefined;return e && countOrigin(e.count_key)===origin;}):payload.countOrigins?.includes(origin);
		if(carries)stop(part.transfer_id);
		return {ids:[...ids],after:JSON.stringify({phase:"parts",id:0,transfer:part.transfer_id,n:part.n})};
	});
}

export async function purgeOrigin(storage: DurableObjectStorage, env: Env, who: Who, step: WipeStep): Promise<Outcome<WipeOut>> {
	try {
		const sql = storage.sql;
		switch (step.op) {
			case "count_close":
				return ok(storage.transactionSync(()=>{const tx=new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString());tx.run("INSERT OR IGNORE INTO profile_meta(key,value) VALUES(?,?)",`work-count-closed:${step.profile}`,JSON.stringify({at:tx.now,seq:tx.seq}));return {done:true,purged:[],redacted:0,preserved:[]};}));
			case "count_archives":return ok(drainCountArchives(storage,who,step.profile,step.after));
			case "count_transfers":return ok(countTransfers(storage,step.profile,step.after));
			case "count_requests":return ok(countRequestPage(sql,step.profile,step.after));
			case "count_cleanup":return ok(storage.transactionSync(()=>cleanupCounts(sql,step.profile,step.at)));

			case "close":
				storage.transactionSync(() => sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('closed', 'wiping')"));
				return ok({ cleared: 0 });
			case "fence": {
				for(let limit=25;;limit=Math.floor(limit/2))try{return ok(storage.transactionSync(() => {
					const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
					// A survivor is published to the driver's keep only once its whole image is read; until then the page is not done.
					const { preserved, pending } = held(sql, who, step.wipe, { tx, left: limit });
					const ids=fenced(who,step.wipe,[...preserved,...pending]);
					for (const id of ids) tx.run("INSERT OR IGNORE INTO profile_meta (key, value) VALUES (?, ?)", `wiped:${id}`, marker(step.wipe));
					tx.run("DELETE FROM profile_meta WHERE key IN (SELECT 'wipe-image:'||value FROM json_each(?))", JSON.stringify(ids));
					return { done: cancelArchivePage(tx,ids,limit) && !pending.length, purged: [], redacted: 0, preserved };
				}));}catch(e){if(!(e instanceof Fail)||e.failure.code!=="size_budget"||limit<=1)throw e;}
			}
			case "origin": return ok(originPage(sql, who, step.profile, step.after));
			case "requests": return ok(requestPage(sql, who, step.wipe, step.after));
			case "handwritten": return ok(handwrittenPage(sql, step.profile, step.terms, step.after));
			case "clear": return ok(await clear(storage, env, who));
			case "purge": {
				// Vectors go before their node row, so a failure leaves the node for the retry; ids are this generation's own.
				const live = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(held(sql, who, step.wipe).here)).toArray().map((r) => r.id);
				if (env.VECTORS && live.length) await env.VECTORS.deleteByIds(live.map((id) => vectorId(who, id)));
				return ok(storage.transactionSync(() => purge(sql, who, step.wipe)));
			}
		}
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		throw e;
	}
}

/** For the shared create, import and transfer paths: refuses to recreate an id a wipe purged from this profile. */
export function assertNotWiped(sql: SqlStorage, id: string): void {
	if (sql.exec("SELECT 1 FROM profile_meta WHERE key = ?", `wiped:${id}`).toArray().length) throw Fail.of("profile_wiped", "this record was purged by a profile wipe", { memory_id: id });
}

/** Checked inside every profile transaction, including replay, after the account's generation check. */
export function assertOpen(sql: SqlStorage): void {
	if (sql.exec("SELECT 1 FROM profile_meta WHERE key = 'closed'").toArray().length) throw Fail.of("profile_wiped", "this profile generation is closed");
}
