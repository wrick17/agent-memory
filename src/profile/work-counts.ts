// Observed commit accounting. Request replay remains the generic writer's responsibility.
import { Fail } from "../domain/types";
import { sha256 } from "../domain/ids";
import { putRow, type ArchiveTx, type Row } from "./archive";
import type { Who } from "./write";

export interface ActivityOwner { id: number; at: string; seq: number }
export interface CountEdge { id: number; src: string; dst: string; dst_profile: string; rel: string; basis: string; recorded_at: string; request_id: string | null; seq: number }
export interface CommitReceipt {
	v: 1; home: string; generation: string; origin: string; request: string; owner: ActivityOwner;
	person: string | null; project: string; pair: string | null; epoch: string | null; at: string;
	active: number; counted: number; local: number; structural: CountEdge[];
}
export interface CountPair {
	v: 1; kind: "pair"; key: string; epoch: string; origin: string; person: string; project: string; dst_profile: string;
	n: number; first: string | null; last: string | null; base: number; baseFirst: string | null; baseLast: string | null;
	edge: CountEdge; archived: number | null; frozen: boolean; transfer?: string;
}
export interface EndpointClaim { id: string; expect: number; countOwner?: ActivityOwner }
const conflict = (reason: string) => Fail.of("revision_conflict", "observed commit ownership changed; review by hand", { reason });
export const edgeIdentity = (r: Row): CountEdge => ({ id: Number(r.id), src: String(r.src), dst: String(r.dst), dst_profile: String(r.dst_profile), rel: String(r.rel), basis: String(r.basis), recorded_at: String(r.recorded_at), request_id: r.request_id === null ? null : String(r.request_id), seq: Number(r.seq) });
export const sameCountEdge = (r: Row | undefined, e: CountEdge) => !!r && Object.entries(e).every(([k,v]) => r[k] === v);
/** The origin label survives after archive revokes ownership; explicit null is ordinary history, never count authority. */
export const unownedCountHistory=(row:Row)=>typeof row.count_key==='string' && row.count_epoch===null;
const prefix = (origin: string) => `work-count:${origin}:`;
export const countOrigin = (key:SqlStorageValue|undefined) => typeof key==="string" && key.startsWith("work-count:") ? key.split(":")[1]! : null;
export function countOriginClosed(sql:SqlStorage,origin:string):{at:string;seq:number}|undefined {
	const r=sql.exec<{value:string}>("SELECT value FROM profile_meta WHERE key=?",`work-count-closed:${origin}`).toArray()[0];
	return r?JSON.parse(r.value) as {at:string;seq:number}:undefined;
}
export function assertCountImageOpen(tx:ArchiveTx,row:Row):void {
	const origin=countOrigin(row.count_key),closed=origin?countOriginClosed(tx.sql,origin):undefined;
	if(!closed)return;
	const o=tx.archiveOperation?tx.sql.exec<{value:string}>("SELECT value FROM profile_meta WHERE key=?",`archive-op:${tx.archiveOperation}`).toArray()[0]:undefined;
	// An already accepted archive operation may quiesce before this wipe's bounded redaction pass.
	if(o && (JSON.parse(o.value) as {fenceSeq:number}).fenceSeq<closed.seq)return;
	throw Fail.of("profile_wiped","this aggregate's source origin is being wiped");
}
const pairKey = (origin: string, person: string, project: string) => `${prefix(origin)}pair:${person}:${project}`;
export function countPair(sql: SqlStorage, key: string): CountPair | undefined {
	const r = sql.exec<{value:string}>("SELECT value FROM profile_meta WHERE key=?",key).toArray()[0];
	return r ? JSON.parse(r.value) as CountPair : undefined;
}
export function saveCountPair(tx: ArchiveTx, p: CountPair): void {
	tx.run("INSERT INTO profile_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",p.key,JSON.stringify(p));
}
export function managedCount(sql: SqlStorage, p: CountPair): Row {
	if (p.archived !== null || p.frozen) throw conflict("aggregate_unavailable");
	return ownedCountRow(sql,p);
}
function ownedCountRow(sql:SqlStorage,p:CountPair):Row {
	const a=p.archived===null?undefined:sql.exec<{payload:string}>("SELECT payload FROM archive WHERE id=? AND source='edges'",p.archived).toArray()[0];
	const r=p.archived===null?sql.exec<Row>("SELECT * FROM edges WHERE id=?",p.edge.id).toArray()[0]:a?JSON.parse(a.payload) as Row:undefined;
	if (!sameCountEdge(r,p.edge) || r!.count_key !== p.key || r!.count_epoch!==p.epoch || r!.weight !== p.n
		|| (p.n > 0 && (r!.valid_from !== p.first || r!.valid_to !== p.last || r!.ended_at !== null))) throw conflict("aggregate_changed");
	return r!;
}
/** An older owned archive image names this epoch, never the value to overwrite its current arithmetic with. */
export function countRestore(tx:ArchiveTx,image:Row):{row:Row;pair:CountPair;existing?:number} {
	assertCountImageOpen(tx,image);
	const p=countPair(tx.sql,String(image.count_key));
	if(!p || image.count_epoch!==p.epoch || !sameCountBirth(image,p.edge))throw conflict("archive_count_binding");
	const row=ownedCountRow(tx.sql,p);
	return {row,pair:p,...(p.archived===null?{existing:p.edge.id}:{})};
}
const sameCountBirth=(row:Row,edge:CountEdge)=>['src','dst','dst_profile','rel','basis','recorded_at','request_id'].every(k=>row[k]===edge[k as keyof CountEdge]);
const min = (xs:(string|null)[]) => xs.filter((x):x is string=>x!==null).sort()[0] ?? null;
const max = (xs:(string|null)[]) => xs.filter((x):x is string=>x!==null).sort().at(-1) ?? null;

/** Called only after a new logical upload passed generic replay, in its existing transaction. */
export function observeCommit(tx: ArchiveTx, who: Who, request: string, person: string | null, project: string, at: string, owner: ActivityOwner, structural: CountEdge[]): CommitReceipt {
	const m: CommitReceipt = { v:1,home:who.profile,generation:who.generation,origin:who.profile,request,owner,person,project,pair:null,epoch:null,at,active:1,counted:0,local:1,structural };
	if (!person) return m;
	const key = pairKey(who.profile,person,project);
	let p = countPair(tx.sql,key);
	// A fully reversed upload may have archived both endpoints. A new creation owns a new epoch, never that old image.
	if(p?.archived!==null && p?.n===0 && p.base===0)p=undefined;
	if(p && p.archived!==null && !p.frozen){
		if(tx.sql.exec("SELECT 1 FROM edges WHERE src=? AND rel='works_on' AND dst_profile='' AND dst=? AND ended_at IS NULL LIMIT 1",person,project).toArray().length)return m;
		putRow(tx,'edges',ownedCountRow(tx.sql,p));
		p=countPair(tx.sql,key)!;
	}
	if (!p) {
		// Current judgment and unregistered identifier links keep the existing INSERT OR IGNORE policy.
		if (tx.sql.exec("SELECT 1 FROM edges WHERE src=? AND rel='works_on' AND dst_profile='' AND dst=? AND ended_at IS NULL",person,project).toArray().length) return m;
		const epoch=sha256(`${who.generation}:${request}:${tx.seq}`);
		const id = Number(tx.run("INSERT INTO edges(src,rel,dst,dst_profile,basis,weight,valid_from,valid_to,recorded_at,actor,request_id,seq,count_key,count_epoch) VALUES(?,'works_on',?,'','identifier',0,NULL,NULL,?,'index',?,?,?,?) RETURNING id",person,project,tx.now,request,tx.seq,key,epoch).one().id);
		p = { v:1,kind:"pair",key,epoch,origin:who.profile,person,project,dst_profile:"",n:0,first:null,last:null,base:0,baseFirst:null,baseLast:null,edge:edgeIdentity(tx.sql.exec<Row>("SELECT * FROM edges WHERE id=?",id).one()),archived:null,frozen:false };
	} else {
		if(p.frozen){if(p.archived!==null || p.dst_profile!=="")return m;p={...p,frozen:false,transfer:undefined};}
		managedCount(tx.sql,p);
	}
	p.n++;p.first=min([p.first,at]);p.last=max([p.last,at]);
	tx.run("UPDATE edges SET weight=?,valid_from=?,valid_to=?,ended_at=NULL,seq=? WHERE id=?",p.n,p.first,p.last,tx.seq,p.edge.id);
	p.edge.seq=tx.seq;saveCountPair(tx,p);
	m.pair=key;m.epoch=p.epoch;m.counted=1;
	return m;
}

export function liveCommit(sql: SqlStorage, m: CommitReceipt): boolean {
	if (!m.local || !m.active) return false;
	const a = sql.exec<{at:string;undo:string|null;undone_by:number|null;redacted:string|null}>("SELECT at,undo,undone_by,redacted FROM activity WHERE id=?",m.owner.id).toArray()[0];
	return !!a && a.at===m.owner.at && !a.redacted && a.undone_by===null && a.undo!==null && (JSON.parse(a.undo) as {seq:number}).seq===m.owner.seq;
}

/** Exact receipt and immutable activity identity, not a reusable activity integer alone. */
export function undoCommitReceipt(sql: SqlStorage, expected: CommitReceipt): {meta:CommitReceipt;pair?:CountPair} {
	const r=sql.exec<{commit_meta:string|null}>("SELECT commit_meta FROM requests WHERE request_id=?",expected.request).toArray()[0];
	if (!r?.commit_meta) throw conflict("commit_receipt_expired");
	const m=JSON.parse(r.commit_meta) as CommitReceipt;
	if (JSON.stringify(m)!==JSON.stringify(expected) || !liveCommit(sql,m)) throw conflict("commit_receipt_changed");
	const p=m.pair?countPair(sql,m.pair):undefined;
	if(m.counted && (!p || p.epoch!==m.epoch))throw conflict("aggregate_epoch");
	if(p)managedCount(sql,p);
	for(const e of m.structural){
		if(!sameCountEdge(sql.exec<Row>("SELECT * FROM edges WHERE id=?",e.id).toArray()[0],e)
			|| sql.exec("SELECT 1 FROM evidence WHERE owner=? AND seq<>? LIMIT 1",`e:${e.id}`,m.owner.seq).toArray().length)throw conflict("commit_structure_changed");
	}
	return {meta:m,pair:p};
}

/** Two indexed LIMIT 1 probes; count stays scalar and never scans held commits. */
export function reverseObservation(tx: ArchiveTx, m: CommitReceipt, p?: CountPair): void {
	const inactive={...m,active:0};
	tx.run("UPDATE requests SET commit_meta=?,seq=? WHERE request_id=?",JSON.stringify(inactive),tx.seq,m.request);
	if(!p)return;
	const extreme=(order:"ASC"|"DESC")=>tx.sql.exec<{at:string}>(`SELECT json_extract(commit_meta,'$.at') AS at FROM requests
		WHERE json_extract(commit_meta,'$.pair')=? AND json_extract(commit_meta,'$.epoch')=?
		AND json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1 AND json_extract(commit_meta,'$.counted')=1
		ORDER BY json_extract(commit_meta,'$.at') ${order},request_id ${order} LIMIT 1`,p.key,p.epoch).toArray()[0]?.at??null;
	p.n--;p.first=min([p.baseFirst,extreme("ASC")]);p.last=max([p.baseLast,extreme("DESC")]);
	if(p.n<0)throw conflict("negative_count");
	if(p.n)tx.run("UPDATE edges SET weight=?,valid_from=?,valid_to=?,seq=? WHERE id=?",p.n,p.first,p.last,tx.seq,p.edge.id);
	else tx.run("UPDATE edges SET weight=0,ended_at=?,seq=? WHERE id=?",tx.now,tx.seq,p.edge.id);
	p.edge.seq=tx.seq;saveCountPair(tx,p);
}

/** Seal one expired inverse or soon-to-be-pruned receipt. No identity token or replay-policy change. */
export function sealObservation(tx: ArchiveTx, request: string): void {
	// The v8 trigger owns folding on update/delete, so every generic deletion path has the same semantics.
	tx.run("UPDATE requests SET commit_meta=NULL,seq=? WHERE request_id=? AND commit_meta IS NOT NULL",tx.seq,request);
}

/** Native receipts that may receive an unchanged endpoint's original deletion claim. */
export function nextClaim(sql: SqlStorage, node:string, person:boolean, except:string): CommitReceipt | undefined {
	const role=person?"person":"project";
	const r=sql.exec<{commit_meta:string}>(`SELECT commit_meta FROM requests WHERE json_extract(commit_meta,'$.${role}')=?
		AND json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1 AND request_id<>? ORDER BY request_id LIMIT 1`,node,except).toArray()[0];
	if(!r)return undefined;
	const m=JSON.parse(r.commit_meta) as CommitReceipt;
	if(!liveCommit(sql,m))throw conflict("claim_owner_expired");
	return m;
}
export function sealedDependency(sql:SqlStorage,node:string,person:boolean): boolean {
	const role=person?"person":"project";
	return sql.exec(`SELECT 1 FROM profile_meta WHERE key GLOB 'work-count:*:pair:*' AND json_extract(value,'$.${role}')=? AND json_extract(value,'$.n')>0 LIMIT 1`,node).toArray().length>0;
}

export function archiveCountEdge(tx:ArchiveTx,row:Row,archive:number): void {
	if(typeof row.count_key!=="string")return;
	const p=countPair(tx.sql,row.count_key);
	if(p && sameCountEdge(row,p.edge) && row.count_epoch===p.epoch && row.weight===p.n
		&& (!p.n || (row.valid_from===p.first && row.valid_to===p.last && row.ended_at===null))){p.archived=archive;saveCountPair(tx,p);}
	else{
		// An independently changed historical row carries its content, never a managed epoch's restore authority.
		row.count_epoch=null;
		tx.run('UPDATE archive SET payload=? WHERE id=?',JSON.stringify(row),archive);
	}
}
export function restoreCountEdge(tx:ArchiveTx,image:Row,id:number): void {
	if(typeof image.count_key!=="string")return;
	assertCountImageOpen(tx,image);
	const p=countPair(tx.sql,image.count_key);
	if(!p || image.count_epoch!==p.epoch || !sameCountEdge(image,p.edge) || p.archived===null)throw conflict("archive_count_binding");
	p.edge={...p.edge,id,seq:tx.seq};p.archived=null;saveCountPair(tx,p);
}

/** The seal was written only after matching the original typed row. A later edit changes seq and loses that authority. */
export function sealedStructural(sql:SqlStorage,row:Row,node:string,person:boolean):number|undefined {
	if(typeof row.commit_seal!=="string" || row.actor!=='index' || row.basis!=='identifier' || row.ended_at!==null || row.dst_profile!=='')return;
	const seal=JSON.parse(row.commit_seal) as {seq:number;evidence:number};
	if(row.seq!==seal.seq || !Number.isSafeInteger(seal.evidence))return;
	if(person?row.rel!=='authored'||row.src!==node:row.rel!=='part_of'||row.dst!==node)return;
	const commit=person?row.dst:row.src;
	if(!sql.exec("SELECT 1 FROM nodes WHERE id=? AND kind='commit'",commit!).toArray().length)return;
	return seal.evidence;
}

export function foreignCommit(raw:SqlStorageValue): SqlStorageValue {
	if(typeof raw!=="string")return raw;
	const m=JSON.parse(raw) as CommitReceipt;
	return JSON.stringify({...m,local:0,active:0});
}

/** Only displayed totals enter immutable parts. Sealing private base dates cannot change a packed bundle. */
export function countSnapshot(sql:SqlStorage,row:Row): string | null {
	if(typeof row.count_key!=="string" || unownedCountHistory(row))return null;
	const p=countPair(sql,row.count_key);
	if(p && typeof row.count_epoch==='string' && row.count_epoch!==p.epoch && row.weight===0 && row.ended_at!==null)return null;
	if(!p || row.count_epoch!==p.epoch || !sameCountBirth(row,p.edge))throw conflict("transfer_count_binding");
	ownedCountRow(sql,p);
	// Historical images carry the same epoch's current arithmetic, never stale totals that a later restore could revive.
	row.weight=p.n;if(p.n>0){row.valid_from=p.first;row.valid_to=p.last;}
	return JSON.stringify({...p,edge:edgeIdentity(row),base:p.n,baseFirst:p.first,baseLast:p.last,archived:null,frozen:true,transfer:undefined});
}

/** The target never inherits the source activity or reversible receipt ownership. */
export function landCount(tx:ArchiveTx,original:Row,landed:Row,raw:string,transfer:string,node:string,archive:number|null=null):void {
	const p=JSON.parse(raw) as CountPair;
	if(countOriginClosed(tx.sql,p.origin))throw Fail.of("profile_wiped","the aggregate's source origin is being wiped");
	if(unownedCountHistory(original) || typeof p.epoch!=='string' || !/^[a-f0-9]{64}$/.test(p.epoch) || p.v!==1 || p.person!==node || original.src!==node || original.count_key!==p.key || original.count_epoch!==p.epoch || landed.count_epoch!==p.epoch || !sameCountEdge({...original,seq:p.edge.seq},p.edge)
		|| !Number.isSafeInteger(p.n) || p.n<0 || p.n!==original.weight || (p.n>0 && (p.first!==original.valid_from || p.last!==original.valid_to))
		|| !/^[a-z][a-z0-9_-]{0,31}$/.test(p.origin) || p.key!==pairKey(p.origin,p.person,p.project))throw conflict("foreign_count_state");
	const prior=countPair(tx.sql,p.key);
	if(prior){
		if(prior.transfer!==transfer || prior.epoch!==p.epoch || prior.n!==p.n || prior.first!==p.first || prior.last!==p.last || !sameCountBirth(landed,prior.edge))throw conflict("count_state_taken");
		return;
	}
	const frozen:CountPair={...p,edge:edgeIdentity(landed),dst_profile:String(landed.dst_profile),base:p.n,baseFirst:p.first,baseLast:p.last,archived:archive,frozen:true,transfer};
	saveCountPair(tx,frozen);
	tx.run("INSERT INTO profile_meta(key,value) VALUES(?,?)",`work-count-transfer:${transfer}:${p.key}`,JSON.stringify({key:p.key}));
}

/** Abort ownership is indexed independently of nodes, which may already have been removed by a previous step. */
export function cleanupTransferredCounts(tx:ArchiveTx,transfer:string,abort:boolean):boolean {
	const start=`work-count-transfer:${transfer}:`;
	const refs=tx.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 10",start,start+"~").toArray();
	for(const ref of refs){
		const key=(JSON.parse(ref.value) as {key:string}).key;
		const p=countPair(tx.sql,key);
		if(abort && p?.transfer===transfer)tx.run("DELETE FROM profile_meta WHERE key=?",key);
		tx.run("DELETE FROM profile_meta WHERE key=?",ref.key);
	}
	if(!refs.length)tx.run("DELETE FROM profile_meta WHERE key=?",`work-count-stop-transfer:${transfer}`);
	return refs.length===0;
}

export function closedTransferCounts(sql:SqlStorage,transfer:string):boolean {
	return sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`work-count-stop-transfer:${transfer}`).toArray().length>0;
}

/** Prefix discovery also finds state whose source node or archive row was already removed. */
export function countStatePage(sql:SqlStorage,origin:string,after:string):{rows:{key:string;value:string}[];after:string|null} {
	const start=prefix(origin);
	const rows=sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>? AND key<? ORDER BY key LIMIT 10",after||start,start+"~").toArray();
	return {rows,after:rows.length===10?rows.at(-1)!.key:null};
}

/** Drain state owned by a source person before its irreversible purge or a return landing. */
export function purgePersonCounts(tx:ArchiveTx,person:string,origin:string):boolean {
	const requests=new Set<string>();
	for(const role of ["person","project"]){
		for(const row of tx.sql.exec<{request_id:string}>(`SELECT request_id FROM requests WHERE json_extract(commit_meta,'$.${role}')=? AND json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1 LIMIT 5`,person))requests.add(row.request_id);
	}
	for(const request of requests)sealObservation(tx,request);
	if(requests.size)return false;
	const rows=tx.sql.exec<{key:string}>("SELECT key FROM profile_meta WHERE key GLOB 'work-count:*:pair:*' AND json_extract(value,'$.person')=? LIMIT 10",person).toArray();
	for(const row of rows)tx.run("DELETE FROM profile_meta WHERE key=?",row.key);
	tx.run("DELETE FROM profile_meta WHERE key=?",`${prefix(origin)}claim:${person}`);
	return rows.length===0;
}

/** A committed person move freezes all carried totals. Its source upload inverses must not regain ownership on return. */
export function sealMovingPerson(tx:ArchiveTx,person:string):boolean {
	const rows=tx.sql.exec<{request_id:string}>("SELECT request_id FROM requests WHERE json_extract(commit_meta,'$.person')=? AND json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1 LIMIT 5",person).toArray();
	for(const r of rows)sealObservation(tx,r.request_id);
	return rows.length===0;
}

/** A physical-key page first, then origin filtering. No unbounded JSON predicate scan. */
export function countRequestPage(sql:SqlStorage,origin:string,after:string):{ids:string[];after:string|null} {
	const rows=sql.exec<{request_id:string;commit_meta:string|null}>("SELECT request_id,commit_meta FROM requests WHERE request_id>? ORDER BY request_id LIMIT 25",after).toArray();
	return {ids:rows.filter(r=>r.commit_meta && (JSON.parse(r.commit_meta) as CommitReceipt).origin===origin).map(r=>r.request_id),after:rows.length===25?rows.at(-1)!.request_id:null};
}

/** Origin cleanup also runs when no ordinary node/id page exists. Driver fences copied requests first. */
export function purgeOriginCounts(tx:ArchiveTx,origin:string):boolean {
	const start=prefix(origin);
	const rows=tx.sql.exec<{key:string;value:string}>("SELECT key,value FROM profile_meta WHERE key>=? AND key<? ORDER BY key LIMIT 5",start,start+"~").toArray();
	for(const r of rows){
		const value=JSON.parse(r.value) as CountPair|{kind:"claim";node:string};
		if(value.kind==="pair"){
			const p=value;
			// Only this registered row's immutable identity is owned; unrelated replacement links survive.
			const edge=tx.sql.exec<Row>("SELECT * FROM edges WHERE id=?",p.edge.id).toArray()[0];
			if(edge && edge.count_key===p.key && edge.recorded_at===p.edge.recorded_at && edge.request_id===p.edge.request_id){
				tx.run("DELETE FROM evidence WHERE (owner,kind,ref) IN (SELECT owner,kind,ref FROM evidence WHERE owner=? LIMIT 25)",`e:${p.edge.id}`);
				if(tx.sql.exec("SELECT 1 FROM evidence WHERE owner=? LIMIT 1",`e:${p.edge.id}`).toArray().length)return false;
				tx.run("DELETE FROM edges WHERE id=?",p.edge.id);
			}
		}
		tx.run("DELETE FROM profile_meta WHERE key=?",r.key);
	}
	return rows.length===0;
}
