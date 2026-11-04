import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { requestHash,sha256 } from "../src/domain/ids";
import { Fail, type WriteCommand, type WriteContext } from "../src/domain/types";
import { archiveCursor, archiveOperation, runArchive, type ArchiveCommand } from "../src/profile/archive-operations";
import { foldDue,foldStep } from "../src/profile/compact";
import { embedStep } from "../src/profile/index";
import { ingest } from "../src/profile/capture";
import { similarStep, SETTLE_MS } from "../src/profile/similar";
import { transferStep } from "../src/profile/transfer";
import { explore,trace,timeline } from "../src/profile/graph";
import { housekeep } from "../src/profile/housekeeping";
import { purgeOrigin, type PurgeResult } from "../src/profile/wipe";
import { readContent, runWrite } from "../src/profile/write";
import { wipeProfile, type WipePorts, type WipeRecord } from "../src/wipe";
import { registered } from "./helpers";

function measuredStore(storage:DurableObjectStorage){
	const committed:{rows:number;bytes:number;binds:number}[]=[],rolled:{rows:number;bytes:number}[]=[];
	let cursors:SqlStorageCursor<Record<string,SqlStorageValue>>[]=[],bytes=0,binds=0;
	const measured={sql:{exec(q:string,...p:SqlStorageValue[]){const c=storage.sql.exec(q,...p);cursors.push(c);bytes+=p.reduce<number>((n,v)=>n+(typeof v === "string"?Buffer.byteLength(v):0),0);binds=Math.max(binds,p.length);return c;},get databaseSize(){return storage.sql.databaseSize;}},transactionSync<T>(fn:()=>T):T{
		cursors=[];bytes=0;binds=0;
		try{const result=storage.transactionSync(fn);committed.push({rows:cursors.reduce((n,c)=>n+c.rowsWritten,0),bytes,binds});return result;}
		catch(e){rolled.push({rows:cursors.reduce((n,c)=>n+c.rowsWritten,0),bytes});throw e;}
	}} as unknown as DurableObjectStorage;
	return {measured,committed,rolled};
}
function logical(sql:SqlStorage,id:string){const node={...sql.exec("SELECT * FROM nodes WHERE id=?",id).one()};delete node.seq;delete node.embed_hash;return {node,body:readContent(sql,id),texts:sql.exec("SELECT part,revision,seq_no,chunk,body,separator,request_id,actor,created_at,live,lane FROM texts WHERE node_id=? ORDER BY part,seq_no,chunk",id).toArray(),history:sql.exec("SELECT revision,op,snapshot,delta,request_id,actor,device_id,at,content_hash,source_platform FROM revisions WHERE node_id=? ORDER BY revision",id).toArray(),links:sql.exec("SELECT src,dst,rel,reason,recorded_at,valid_from,valid_to,ended_at,basis FROM edges WHERE src=? OR dst=? ORDER BY src,dst",id,id).toArray(),evidence:sql.exec("SELECT e.src,e.dst,v.kind,v.ref,v.note FROM evidence v JOIN edges e ON v.owner='e:'||e.id WHERE e.src=? OR e.dst=? ORDER BY e.src,e.dst,v.ref",id,id).toArray()};}
it("stages a real overbudget appended journal through actor eviction, restore eviction, Undo and exact replay",async()=>{
	const {who,stub}=await registered();
	const proof:{rows:number;bytes:number;binds:number}[]=[],rolled:{rows:number;bytes:number}[]=[];
	const seed=await runInDurableObject(stub,async(_instance,state)=>{
		const m=measuredStore(state.storage),{write,run,resume}=harness(m.measured,who),sql=state.storage.sql;
		const id=String(write({op:"save",args:{name:"staged synthetic journal",type:"project",kind:"journal",description:"synthetic",content:"original body"}}).memory_id);
		for(let i=0;i<140;i++)write({op:"append",args:{memory_id:id,content:`entry ${i} `+"bounded text ".repeat(100),separator:" | ",request_id:`append-${i}`}});
		write({op:"save",args:{memory_id:id,expected_revision:141,compact:{through_seq:20,summary:"retained summary of twenty entries"},request_id:"journal-summary"}});
		while(foldDue(sql))foldStep(m.measured);
		const neighbor=String(write({op:"save",args:{name:"neighbor",type:"reference",description:"synthetic"}}).memory_id);
		write({op:"knowledge",args:{edges:[{from:{id:neighbor},to:{id},rel:"relates_to",reason:"incoming synthetic evidence",evidence:[{kind:"file",ref:"fixture.md"}]},{from:{id},to:{id:neighbor},rel:"relates_to",reason:"outgoing synthetic evidence",evidence:[{kind:"file",ref:"fixture2.md"}]}]}});
		const original=logical(sql,id);
		try{write({op:"owner",args:{action:"forget",memory_id:id}});throw Error("atomic forget unexpectedly fit");}catch(e){expect(e).toBeInstanceOf(Fail);expect((e as Fail).failure.code).toBe("size_budget");}
		expect(logical(sql,id)).toEqual(original);
		const start:ArchiveCommand={action:"forget",memory_id:id,expected_revision:142,request_id:"start-forget"},started=run(start),op=String(started.operation_id);
		while(!archiveOperation(sql,op)!.rows)resume(op);
		proof.push(...m.committed);rolled.push(...m.rolled);await state.storage.sync();
		return {id,neighbor,original,start,started,op};
	});
	await evictDurableObject(stub);
	const landing=await runInDurableObject(stub,async(_instance,state)=>{
		const m=measuredStore(state.storage),{write,run,resume}=harness(m.measured,who),sql=state.storage.sql;
		let result:Record<string,unknown>={},last:ArchiveCommand=seed.start,n=0;
		while(archiveOperation(sql,seed.op)!.state!=="complete"){
			const o=archiveOperation(sql,seed.op)!;last={action:"resume",operation_id:o.id,cursor:archiveCursor(o),request_id:`forget-page-${o.version}`};result=run(last);expect(++n).toBeLessThan(150);
		}
		expect(run(seed.start)).toEqual({...seed.started,action:"replayed"});expect(run(last)).toEqual({...result,action:"replayed"});
		expect(sql.exec("SELECT 1 FROM nodes WHERE id=?",seed.id).toArray()).toHaveLength(0);
		const foreign=String(write({op:"save",args:{name:"integer collision neighbor",type:"reference",description:"synthetic"}}).memory_id);
		write({op:"knowledge",args:{edges:[{from:{id:seed.neighbor},to:{id:foreign},rel:"relates_to",reason:"unrelated edge reuses integer id",evidence:[{kind:"file",ref:"foreign-fixture.md"}]}]}});
		const restore:ArchiveCommand={action:"restore",activity_id:Number(result.activity_id),request_id:"start-restore"},started=run(restore),op=String(started.operation_id);
		while(!archiveOperation(sql,op)!.rows)resume(op);
		expect(sql.exec("SELECT status FROM nodes WHERE id=?",seed.id).one().status).toBe("incoming");
		proof.push(...m.committed);rolled.push(...m.rolled);await state.storage.sync();return {op,restore,started};
	});
	await evictDurableObject(stub);
	await runInDurableObject(stub,(_instance,state)=>{
		const m=measuredStore(state.storage),{write,run,resume,drain}=harness(m.measured,who),sql=state.storage.sql;
		const restored=drain(landing.op);
		expect(logical(sql,seed.id)).toEqual(seed.original);expect(run(landing.restore)).toEqual({...landing.started,action:"replayed"});
		const undo=write({op:"undo",args:{activity_id:restored.activity,request_id:`undo:${restored.activity}`}});expect(undo.action).toBe("undo_started");
		expect(write({op:"undo",args:{activity_id:restored.activity,request_id:`undo:${restored.activity}`}}).action).toBe("replayed");
		let result=undo,n=0;
		while(archiveOperation(sql,String(undo.operation_id))!.state!=="complete"){result=resume(String(undo.operation_id));expect(++n).toBeLessThan(150);}
		expect(result.action).toBe("undone");expect(result.undo_of).toBe(restored.activity);
		expect(sql.exec("SELECT 1 FROM nodes WHERE id=?",seed.id).toArray()).toHaveLength(0);
		const again=run({action:"restore",activity_id:Number(result.activity_id),request_id:"restore-undone"});drain(String(again.operation_id));
		expect(logical(sql,seed.id)).toEqual(seed.original);proof.push(...m.committed);rolled.push(...m.rolled);
	});
	for(const c of proof){expect(c.rows).toBeLessThanOrEqual(1000);expect(c.bytes).toBeLessThanOrEqual(1_000_000);expect(c.binds).toBeLessThanOrEqual(100);}
	console.log("ARCHIVE_REAL_JOURNAL",JSON.stringify({appends:140,actorEvictions:2,transactions:proof.length,maxRows:Math.max(...proof.map(c=>c.rows)),maxBytes:Math.max(...proof.map(c=>c.bytes)),maxBinds:Math.max(...proof.map(c=>c.binds)),rolled}));
});

async function inArchive(fn:(storage:DurableObjectStorage,who:import("../src/profile/write").Who,instance:import("../src/profile/store").ProfileStore)=>Promise<void>|void,profile="personal"){
	const {who,stub}=await registered(profile);await runInDurableObject(stub,(instance,state)=>fn(state.storage,who,instance));
}
/** Rewrites a node's text rows the way older data could hold them, keeping the external-content FTS tables consistent. */
const retext=(sql:SqlStorage,id:string,from:string,to:string)=>{for(const r of sql.exec<{rowid:number;live:number}>("SELECT rowid,live FROM texts WHERE node_id=? AND instr(body,?)>0",id,from).toArray()){if(r.live)sql.exec("UPDATE texts SET live=0 WHERE rowid=?",r.rowid);sql.exec("UPDATE texts SET body=replace(body,?,?) WHERE rowid=?",from,to,r.rowid);if(r.live)sql.exec("UPDATE texts SET live=1 WHERE rowid=?",r.rowid);}};
function harness(storage:DurableObjectStorage,who:import("../src/profile/write").Who){
	const ctx:WriteContext={actor:"owner",platform:"test",routedBy:"explicit",userId:who.userId,payloadHash:"",...(who.profile === "me"?{meGuard:{explicit:true}}:{})};
	const write=(c:WriteCommand)=>runWrite(storage,who,c,{...ctx,payloadHash:requestHash(c.op,c.args as never)}).result;
	const make=(name:string)=>String(write({op:"save",args:{name,type:who.profile === "me"?"user":"reference",description:"synthetic",content:`body ${name}`}}).memory_id);
	const run=(c:ArchiveCommand)=>runArchive(storage,who,c,{...ctx,payloadHash:requestHash("archive",c)});
	const resume=(id:string)=>{const o=archiveOperation(storage.sql,id)!;return run({action:"resume",operation_id:id,cursor:archiveCursor(o),request_id:`resume-${id}-${o.version}`});};
	const drain=(id:string)=>{let n=0;for(;;){const o=archiveOperation(storage.sql,id)!;if((o.state === "complete"||o.state === "aborted")&&!o.cleanup)return o;resume(id);expect(++n).toBeLessThan(200);}};
	return {ctx,write,make,run,resume,drain};
}
it("keeps both local endpoints invisible and similarity retryable after vector awaits; excludes transfers in both orders including retained archived lanes",async()=>inArchive(async(storage,who)=>{
	const {make,run,drain}=harness(storage,who),sql=storage.sql;
	const a=make("A"),b=make("B");
	sql.exec("UPDATE nodes SET embed_hash=card_hash WHERE id IN (?,?)",a,b);
	sql.exec("INSERT INTO edges(src,rel,dst,dst_profile,basis,reason,recorded_at,actor,seq) VALUES (?,'relates_to',?,'','similarity',NULL,?,'index',7)",b,a,new Date().toISOString());
	const before=sql.exec("SELECT * FROM edges").toArray();
	const now=Date.now()+SETTLE_MS;
	sql.exec("INSERT INTO cursors(stage,cursor,due_at) VALUES('similar',?,0)",JSON.stringify({seq:100000,mark:null,pending:{[b]:{n:0,at:0,card:false}}}));
	let op="";
	await similarStep(storage,{...env,EMBEDDINGS:"on",VECTORS:{async getByIds(){return [{id:`g${who.generation}:${b}`,values:[1,0]}];},async query(){return {matches:[]};}}} as unknown as Env,who,now,async()=>{op=String(run({action:"forget",memory_id:a,expected_revision:1,request_id:"after-vector-fence"}).operation_id);});
	expect(sql.exec("SELECT * FROM edges").toArray()).toEqual(before);
	expect(JSON.parse(String(sql.exec("SELECT cursor FROM cursors WHERE stage='similar'").one().cursor)).pending[b]).toBeTruthy();
	const q={kind:"explore" as const,node:{id:b},depth:1,known:[],maxEdges:5000};
	expect(explore(sql,q).links).toHaveLength(0);
	expect((trace(sql,{kind:"trace",mode:"detail",nodes:[b],edges:[Number(before[0]!.id)],known:[],maxEdges:5000}) as {links:unknown[]}).links).toHaveLength(0);
	expect(timeline(sql,{kind:"timeline",from:"2020-01-01T00:00:00Z",to:"2090-01-01T00:00:00Z",known:[],limit:100}).events.some(e=>JSON.stringify(e).includes(a))).toBe(false);
	const incoming={...(sql.exec("SELECT * FROM nodes WHERE id=?",b).one()),id:"late-landing",name:"late landing",norm_name:"late landing"};
	const payload=JSON.stringify([["nodes",incoming],["edges",{...before[0],src:"late-landing",dst_profile:who.profile}]]);
	const late=await transferStep(storage,env,who,{op:"land",id:"late-landing-transfer",from:"work",nodeId:"late-landing",n:1,of:2,payload,sha256:sha256(payload),bundle:"0".repeat(64),revision:1});
	expect(late.ok).toBe(false);expect(sql.exec("SELECT 1 FROM nodes WHERE id='late-landing'").toArray()).toHaveLength(0);
	const blocked=await transferStep(storage,env,who,{op:"fence",id:"archive-first",nodeId:b,peer:"work"});
	expect(blocked.ok).toBe(false);expect(sql.exec("SELECT * FROM transfers").toArray()).toHaveLength(0);
	const o=archiveOperation(sql,op)!;run({action:"abort",operation_id:op,cursor:archiveCursor(o),request_id:"abort-A"});drain(op);
	expect(sql.exec("SELECT * FROM edges").toArray()).toEqual(before);
	const at=new Date().toISOString();
	sql.exec("INSERT INTO transfers(id,node_id,direction,peer,state,parts,created_at,updated_at,seq) VALUES('published-target',?,'in','work','published',1,?,?,7)",b,at,at);
	sql.exec("INSERT INTO transfer_parts(transfer_id,n,payload,sha256) VALUES('published-target',1,'{}',?)","0".repeat(64));
	expect(()=>run({action:"forget",memory_id:a,expected_revision:1,request_id:"published-authority"})).toThrow(/touching transfer/);
	expect((await transferStep(storage,env,who,{op:"settle",id:"published-target"})).ok).toBe(true);
	expect(()=>run({action:"forget",memory_id:a,expected_revision:1,request_id:"published-without-parts"})).toThrow(/touching transfer/);
	expect((await transferStep(storage,env,who,{op:"settle",id:"published-target"})).ok).toBe(true);
	const replayFence=String(run({action:"forget",memory_id:a,expected_revision:1,request_id:"terminal-replay-fence"}).operation_id);
	expect((await transferStep(storage,env,who,{op:"settle",id:"published-target"})).ok).toBe(true);
	run({action:"abort",operation_id:replayFence,cursor:archiveCursor(archiveOperation(sql,replayFence)!),request_id:"terminal-replay-abort"});drain(replayFence);
	// A source fenced while vectors were awaited cannot end or upsert its own edges either.
	sql.exec("UPDATE cursors SET cursor=? WHERE stage='similar'",JSON.stringify({seq:100000,mark:null,pending:{[b]:{n:0,at:0,card:false}}}));
	await similarStep(storage,{...env,EMBEDDINGS:"on",VECTORS:{async getByIds(){return [{id:`g${who.generation}:${b}`,values:[1,0]}];},async query(){return {matches:[{id:`g${who.generation}:${a}`,score:.96}]};}}} as unknown as Env,who,now,async()=>{op=String(run({action:"forget",memory_id:b,expected_revision:1,request_id:"source-after-vector"}).operation_id);});
	expect(sql.exec("SELECT * FROM edges").toArray()).toEqual(before);
	const held=archiveOperation(sql,op)!;run({action:"abort",operation_id:op,cursor:archiveCursor(held),request_id:"abort-B"});drain(op);
	expect((await transferStep(storage,env,who,{op:"fence",id:"transfer-first",nodeId:b,peer:"work"})).ok).toBe(true);
	expect(()=>run({action:"forget",memory_id:a,expected_revision:1,request_id:"late-archive"})).toThrow(/touching transfer/);
	expect(sql.exec("SELECT status FROM nodes WHERE id=?",a).one().status).toBe("active");
	expect((await transferStep(storage,env,who,{op:"pack",id:"transfer-first"})).ok).toBe(true);
	expect((await transferStep(storage,env,who,{op:"sent",id:"transfer-first"})).ok).toBe(true);
	for(let i=0;i<10&&sql.exec("SELECT 1 FROM edges WHERE src=?",b).toArray().length;i++)expect((await transferStep(storage,env,who,{op:"commit",id:"transfer-first"})).ok).toBe(true);
	expect(sql.exec("SELECT 1 FROM edges WHERE src=?",b).toArray()).toHaveLength(0);
	expect(sql.exec("SELECT 1 FROM archive WHERE source='edges'").toArray().length).toBeGreaterThan(0);
	expect(()=>run({action:"forget",memory_id:a,expected_revision:1,request_id:"archived-transfer-authority"})).toThrow(/touching transfer/);
}));
it("rolls back partial forget, preserves purge pins, refuses stale cursors and reused identities",async()=>inArchive((storage,who)=>{
	const {make,run,resume,drain}=harness(storage,who),sql=storage.sql;
	const id=make("rollback"),original=readContent(sql,id);
	let r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"rollback-forget"}),op=String(r.operation_id);
	const old=String(r.cursor);resume(op);
	expect(()=>run({action:"resume",operation_id:op,cursor:old,request_id:"stale"})).toThrow(/state changed/);
	while(!archiveOperation(sql,op)!.rows)resume(op);
	const held=Number(sql.exec("SELECT count(*) n FROM archive").one().n);
	const future=Date.now()+401*86400000;
	for(const stage of ["ttl","dedupe","queue","purge"])sql.exec("INSERT INTO cursors(stage,due_at) VALUES(?,?) ON CONFLICT(stage) DO UPDATE SET due_at=excluded.due_at",stage,stage === "purge"?0:future+86400000);
	housekeep(storage,who,future);expect(Number(sql.exec("SELECT count(*) n FROM archive").one().n)).toBe(held);
	r=run({action:"abort",operation_id:op,cursor:archiveCursor(archiveOperation(sql,op)!),request_id:"rollback-abort"});drain(op);
	expect(readContent(sql,id)).toBe(original);
	r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"forget-for-collision"});op=String(r.operation_id);const removed=drain(op).activity;
	// A newly created identical identity is a real collision, with all archived images retained.
	make("rollback");const count=sql.exec("SELECT count(*) n FROM archive WHERE activity_id=?",removed).one().n;
	expect(()=>run({action:"restore",activity_id:removed,request_id:"collision"})).toThrow(/state changed/);
	expect(sql.exec("SELECT count(*) n FROM archive WHERE activity_id=?",removed).one().n).toBe(count);
	sql.exec("UPDATE activity SET at='1900-01-01T00:00:00Z' WHERE id=?",removed);sql.exec("UPDATE archive SET purge_after='1900-01-01T00:00:00Z' WHERE activity_id=?",removed);
	sql.exec("UPDATE cursors SET due_at=0 WHERE stage='purge'");housekeep(storage,who,future);
	expect(archiveOperation(sql,op)).toBeUndefined();expect(sql.exec("SELECT status FROM nodes WHERE id=?",id).one().status).toBe("active");
}));
it("restores into me despite registered work terms, and aborts a personal-field restore without exposing landed rows",async()=>inArchive(async(storage,who)=>{
	const {make,run,drain}=harness(storage,who),sql=storage.sql,id=make("Cedar preference");
	// Issue #3: guard terms no longer decide what me may hold, so a restore completes.
	sql.exec("INSERT INTO guard_terms (term,source,added_at,seq) VALUES ('Cedar','work',?,1)",new Date().toISOString());
	let r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"guard-forget"});let removed=drain(String(r.operation_id)).activity;
	r=run({action:"restore",activity_id:removed,request_id:"guard-restore"});
	expect(drain(String(r.operation_id)).state).toBe("complete");expect(sql.exec("SELECT status FROM nodes WHERE id=?",id).one().status).toBe("active");
	const field=make("Contact preference");retext(sql,field,"body Contact preference","mail cedar@example.com");
	r=run({action:"forget",memory_id:field,expected_revision:1,request_id:"field-forget"});removed=drain(String(r.operation_id)).activity;
	r=run({action:"restore",activity_id:removed,request_id:"field-restore"});const op=String(r.operation_id);
	expect(()=>{for(let n=0;n<200;n++){const o=archiveOperation(sql,op)!;if(o.state === "complete")return;run({action:"resume",operation_id:op,cursor:archiveCursor(o),request_id:`field-resume-${o.version}`});}}).toThrow(/personal contact fields/);
	expect(sql.exec("SELECT status FROM nodes WHERE id=?",field).one().status).toBe("incoming");
	r=run({action:"abort",operation_id:op,cursor:archiveCursor(archiveOperation(sql,op)!),request_id:"field-abort"});drain(op);
	expect(sql.exec("SELECT 1 FROM nodes WHERE id=?",field).toArray()).toHaveLength(0);
	expect(sql.exec("SELECT 1 FROM archive WHERE activity_id=?",removed).toArray().length).toBeGreaterThan(0);
},"me"));
it("wipe cancels metadata-only operations with permanent fences, keeps request bytes until account fencing, and preserves accepted me survivors",async()=>{
	await inArchive(async(storage,who)=>{
		const {make,run,drain}=harness(storage,who),sql=storage.sql,id=make("work copy");sql.exec("UPDATE nodes SET source_profile='work' WHERE id=?",id);
		const r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"wipe-copy"}),op=String(r.operation_id),removed=drain(op).activity;
		const restored=run({action:"restore",activity_id:removed,request_id:"wipe-restore"}),inverse=String(restored.operation_id);drain(inverse);
		expect(sql.exec("SELECT 1 FROM profile_meta WHERE key>=? AND key<?",`archive-op:${inverse}:row:`,`archive-op:${inverse}:row:~`).toArray().length).toBeGreaterThan(0);
		// The retained inverse must be found after both ordinary discovery sources have disappeared.
		sql.exec("DELETE FROM nodes WHERE id=?",id);sql.exec("DELETE FROM archive WHERE activity_id=?",removed);
		const wipe={profile:"work",at:new Date().toISOString(),ids:[id],terms:[]};
		let done=false,pages=0;while(!done){const result=await purgeOrigin(storage,env,who,{op:"fence",wipe});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);done=(result.value as {done:boolean}).done;expect(++pages).toBeLessThan(20);}
		expect(archiveOperation(sql,op)).toBeUndefined();expect(archiveOperation(sql,inverse)).toBeUndefined();expect(sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`wiped:${id}`).toArray()).toHaveLength(1);
		expect(()=>run({action:"forget",memory_id:id,expected_revision:1,request_id:"wipe-copy"})).toThrow(/purged/);
		expect(sql.exec("SELECT result FROM requests WHERE request_id='wipe-copy'").toArray()).toHaveLength(1);
		const requestPage=await purgeOrigin(storage,env,who,{op:"requests",wipe,after:""});expect(requestPage.ok && "ids" in requestPage.value && requestPage.value.ids).toContain("wipe-copy");
		// The driver control separately proves account fencing before this destructive profile phase.
		let purged=false;pages=0;while(!purged){const result=await purgeOrigin(storage,env,who,{op:"purge",wipe});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);purged=(result.value as {done:boolean}).done;expect(++pages).toBeLessThan(30);}
		expect(sql.exec("SELECT 1 FROM texts WHERE node_id=?",id).toArray()).toHaveLength(0);expect(sql.exec("SELECT 1 FROM revisions WHERE node_id=?",id).toArray()).toHaveLength(0);
	});
	await inArchive(async(storage,who)=>{
		const {make,run}=harness(storage,who),sql=storage.sql,id=make("quiet preference");sql.exec("UPDATE nodes SET source_profile='work',attrs=json_set(attrs,'$.company_free',json('true')) WHERE id=?",id);
		const r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"surviving-copy"});
		const result=await purgeOrigin(storage,env,who,{op:"fence",wipe:{profile:"work",at:new Date().toISOString(),ids:[id],terms:["Cedar"]}});
		expect(result.ok&&"preserved" in result.value&&result.value.preserved).toContain(id);
		expect(archiveOperation(sql,String(r.operation_id))).toBeDefined();expect(sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`wiped:${id}`).toArray()).toHaveLength(0);
	},"me");
});
it("wipe decides the me exception from the complete live and staged image in bounded pages before keep",async()=>{let metrics={};await inArchive(async(storage,who)=>{
	const {write,run,resume,drain}=harness(storage,who),sql=storage.sql,m=measuredStore(storage);
	const pref=(name:string,body:string,entry:(i:number)=>string)=>{
		const id=String(write({op:"save",args:{name,type:"user",description:"synthetic",content:body}}).memory_id);
		for(let i=0;i<30;i++)write({op:"append",args:{memory_id:id,content:entry(i),request_id:`${name}-${i}`}});
		sql.exec("UPDATE nodes SET source_profile='work',attrs=json_set(attrs,'$.company_free',json('true')) WHERE id=?",id);return id;
	};
	// Every text moves into the archive; the revision and node stay live, so the live rows alone look clean.
	const stage=(id:string)=>{const op=String(run({action:"forget",memory_id:id,expected_revision:31,request_id:`stage-${id}`}).operation_id);while(archiveOperation(sql,op)!.phase!=="archive_revisions")resume(op);return op;};
	const unstaged=pref("unstaged preference","Cedar project body",i=>`entry ${i}`),partial=pref("partial preference","quiet body",i=>i === 28?"Cedar project detail":`entry ${i}`),clean=pref("clean preference","quiet body",i=>`entry ${i}`);
	const personal=String(write({op:"save",args:{name:"personal note",type:"user",description:"synthetic",content:"Cedar tree in the garden"}}).memory_id),cleanBody=readContent(sql,clean);
	// Issue #3: the wipe exception is decided by personal fields, not terms, so the refused images hold a contact field.
	for(const id of [unstaged,partial])retext(sql,id,"Cedar","cedar@example.com");
	const partialOp=stage(partial),cleanOp=stage(clean),removal=archiveOperation(sql,partialOp)!.removal;
	expect(sql.exec("SELECT 1 FROM revisions WHERE node_id=?",partial).toArray()).toHaveLength(1);expect(sql.exec("SELECT 1 FROM texts WHERE node_id=?",partial).toArray()).toHaveLength(0);
	expect(sql.exec("SELECT 1 FROM archive WHERE activity_id=? AND payload LIKE '%Cedar%'",removal).toArray()).toHaveLength(1);
	const wipe={profile:"work",at:new Date().toISOString(),ids:[unstaged,partial,clean],terms:["Cedar"]},preserved=new Set<string>(),fences:PurgeResult[]=[];
	while(!fences.at(-1)?.done){const r=await purgeOrigin(m.measured,env,who,{op:"fence",wipe:{...wipe,keep:[...preserved]}});if(!r.ok)throw Error(r.error.message);fences.push(r.value as PurgeResult);fences.at(-1)!.preserved.forEach(id=>preserved.add(id));expect(fences.length).toBeLessThan(20);}
	expect([...preserved]).toEqual([clean]);
	// Nothing reaches the driver's keep before its image is read to the end.
	expect(fences[0]).toMatchObject({done:false,preserved:[]});
	for(const id of [unstaged,partial])expect(sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`wiped:${id}`).toArray()).toHaveLength(1);
	expect(archiveOperation(sql,partialOp)).toBeUndefined();expect(archiveOperation(sql,cleanOp)).toBeDefined();expect(sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`wiped:${clean}`).toArray()).toHaveLength(0);
	const purges:PurgeResult[]=[];
	while(!purges.at(-1)?.done){const r=await purgeOrigin(m.measured,env,who,{op:"purge",wipe:{...wipe,keep:[...preserved]}});if(!r.ok)throw Error(r.error.message);purges.push(r.value as PurgeResult);expect(purges.at(-1)!.preserved).toEqual([clean]);expect(purges.length).toBeLessThan(40);}
	expect(sql.exec("SELECT 1 FROM archive WHERE payload LIKE '%Cedar%' OR activity_id=?",removal).toArray()).toHaveLength(0);
	for(const id of [unstaged,partial])for(const t of ["nodes WHERE id","texts WHERE node_id","revisions WHERE node_id","requests WHERE node_id"])expect(sql.exec(`SELECT 1 FROM ${t}=?`,id).toArray(),t).toHaveLength(0);
	expect(sql.exec("SELECT key FROM profile_meta WHERE (key>=?1 AND key<?1||'~') OR (key>=?2 AND key<?2||'~') OR key=?3 OR (key>='archive-pin:' AND key<'archive-pin:~' AND value=?4)",`archive-op:${partialOp}`,`archive-node:${partial}:`,`wipe-image:${partial}`,JSON.stringify(partialOp)).toArray()).toEqual([]);
	expect(sql.exec("SELECT 1 FROM cursors WHERE stage=?",`archive:${partialOp}`).toArray()).toHaveLength(0);
	expect(sql.exec("SELECT 1 FROM activity WHERE (undo IS NOT NULL OR redacted IS NULL) AND EXISTS (SELECT 1 FROM json_each(targets) WHERE value IN (?,?))",unstaged,partial).toArray()).toHaveLength(0);
	expect(()=>run({action:"abort",operation_id:partialOp,cursor:"",request_id:"late-abort"})).toThrow(/no archive operation/);
	// The accepted survivor keeps its operation and can still be restored; non-work me data is untouched.
	run({action:"abort",operation_id:cleanOp,cursor:archiveCursor(archiveOperation(sql,cleanOp)!),request_id:"survivor-abort"});drain(cleanOp);
	expect(readContent(sql,clean)).toBe(cleanBody);expect(sql.exec("SELECT status FROM nodes WHERE id=?",clean).one().status).toBe("active");expect(readContent(sql,personal)).toBe("Cedar tree in the garden");
	const max=(k:"rows"|"bytes"|"binds")=>Math.max(...m.committed.map(c=>c[k]));
	expect(max("rows")).toBeLessThanOrEqual(1000);expect(max("bytes")).toBeLessThanOrEqual(1_000_000);expect(max("binds")).toBeLessThanOrEqual(100);expect(m.rolled).toEqual([]);
	metrics={fences:fences.length,purges:purges.length,transactions:m.committed.length,maxRows:max("rows"),maxBytes:max("bytes"),maxBinds:max("binds")};
},"me");console.log("WIPE_COMPLETE_IMAGE",JSON.stringify(metrics));});
it("bounds each wipe fence call across retained operation history and publishes a survivor only after all of it",async()=>{let metrics={};await inArchive(async(storage,who)=>{
	const {write,run,resume,drain}=harness(storage,who),sql=storage.sql,statements:number[]=[];let count=0;
	const observed={sql:{exec(q:string,...p:SqlStorageValue[]){count++;return sql.exec(q,...p);},get databaseSize(){return sql.databaseSize;}},transactionSync<T>(fn:()=>T){count=0;try{return storage.transactionSync(fn);}finally{statements.push(count);}}} as unknown as DurableObjectStorage;
	// The independent review's valid state: 13 real forget/restore cycles with cleanup, then a partial forget, 27 retained operations.
	const history=(name:string,entry?:string)=>{
		const id=String(write({op:"save",args:{name,type:"user",description:"synthetic",content:"quiet preference"}}).memory_id);
		sql.exec("UPDATE nodes SET source_profile='work',attrs=json_set(attrs,'$.company_free',json('true')) WHERE id=?",id);
		for(let i=0;i<13;i++){const removed=drain(String(run({action:"forget",memory_id:id,expected_revision:1,request_id:`${name}-${i}-forget`}).operation_id));drain(String(run({action:"restore",activity_id:removed.activity,request_id:`${name}-${i}-restore`}).operation_id));}
		if(entry){write({op:"append",args:{memory_id:id,content:entry,request_id:`${name}-entry`}});retext(sql,id,"Cedar","cedar@example.com");}
		const op=String(run({action:"forget",memory_id:id,expected_revision:entry?2:1,request_id:`${name}-partial`}).operation_id);
		while(archiveOperation(sql,op)!.phase!=="archive_revisions")resume(op);
		expect(sql.exec("SELECT count(*) AS n FROM profile_meta WHERE key>=? AND key<?",`archive-node:${id}:`,`archive-node:${id}:~`).one().n).toBe(27);
		return {id,op};
	};
	const clean=history("history clean"),sensitive=history("history sensitive","Cedar project detail");
	const fence=async(ids:string[],terms=["Cedar"])=>{statements.length=0;const out:PurgeResult[]=[];while(!out.at(-1)?.done){const r=await purgeOrigin(observed,env,who,{op:"fence",wipe:{profile:"work",at:"2026-10-31T00:00:00Z",ids,terms}});if(!r.ok)throw Error(r.error.message);out.push(r.value as PurgeResult);expect(out.length).toBeLessThan(60);}return out;};
	const kept=await fence([clean.id]),perCall=Math.max(...statements);
	// Each call does fixed work however long the history is, so the survivor is published only by the call that reads its end.
	expect(perCall).toBeLessThanOrEqual(40);
	expect(kept.length).toBeGreaterThan(1);expect(kept.slice(0,-1).every(r=>!r.done&&!r.preserved.length)).toBe(true);expect(kept.at(-1)!.preserved).toEqual([clean.id]);
	expect((await fence([clean.id],["Juniper"]))[0]).toMatchObject({done:false,preserved:[]});
	const wiped=await fence([sensitive.id]);
	expect(wiped.flatMap(r=>r.preserved)).toEqual([]);expect(sql.exec("SELECT 1 FROM profile_meta WHERE key=?",`wiped:${sensitive.id}`).toArray()).toHaveLength(1);
	expect(sql.exec("SELECT 1 FROM archive WHERE payload LIKE '%Cedar%'").toArray()).toHaveLength(0);
	expect(sql.exec("SELECT 1 FROM profile_meta WHERE key>=? AND key<?",`archive-node:${sensitive.id}:`,`archive-node:${sensitive.id}:~`).toArray()).toHaveLength(0);
	// The survivor keeps its whole retained history and its running operation.
	expect(sql.exec("SELECT count(*) AS n FROM profile_meta WHERE key>=? AND key<?",`archive-node:${clean.id}:`,`archive-node:${clean.id}:~`).one().n).toBe(27);
	run({action:"abort",operation_id:clean.op,cursor:archiveCursor(archiveOperation(sql,clean.op)!),request_id:"history-abort"});drain(clean.op);expect(readContent(sql,clean.id)).toBe("quiet preference");
	metrics={retained:27,cleanCalls:kept.length,perCall,sensitiveCalls:wiped.length};
},"me");console.log("WIPE_RETAINED_HISTORY",JSON.stringify(metrics));});
it("safely refuses one unfit image after bounded pages and can abort without losing the original",async()=>inArchive((storage,who)=>{
	const {make,run,resume,drain}=harness(storage,who),sql=storage.sql,id=make("unfit");
	sql.exec("UPDATE revisions SET snapshot=? WHERE node_id=?",JSON.stringify({synthetic:"x".repeat(1_001_000)}),id);
	const original=readContent(sql,id),r=run({action:"forget",memory_id:id,expected_revision:1,request_id:"unfit-start"}),op=String(r.operation_id);
	while(archiveOperation(sql,op)!.phase!=="archive_revisions")resume(op);
	expect(()=>resume(op)).toThrow(/1,000,000 bytes/);expect(sql.exec("SELECT length(snapshot) n FROM revisions WHERE node_id=?",id).one().n).toBeGreaterThan(1_000_000);
	run({action:"abort",operation_id:op,cursor:archiveCursor(archiveOperation(sql,op)!),request_id:"unfit-abort"});drain(op);expect(readContent(sql,id)).toBe(original);
}));

it("validates a large inverse in bounded pages before archiving any concurrently changed edge",async()=>inArchive((storage,who)=>{
	const {make,write,run,resume,drain}=harness(storage,who),sql=storage.sql,a=make("inverse A"),b=make("inverse B");
	const linked=write({op:"knowledge",args:{edges:[{from:{id:b},to:{id:a},rel:"relates_to",reason:"inverse guarded neighbor",evidence:[{kind:"file",ref:"inverse.md"}]}]}});
	const edge=(linked.edges as {id:number}[])[0]!.id;
	let r=run({action:"forget",memory_id:a,expected_revision:1,request_id:"inverse-forget"});const removal=drain(String(r.operation_id));
	r=run({action:"restore",activity_id:removal.activity,request_id:"inverse-restore"});const restored=drain(String(r.operation_id));
	write({op:"knowledge",args:{end:[{edge,reason:"changed after publication",valid_to:new Date().toISOString()}]}});
	const started=write({op:"undo",args:{activity_id:restored.activity,request_id:`undo:${restored.activity}`}}),op=String(started.operation_id);
	expect(started.action).toBe("undo_started");expect(()=>{for(let i=0;i<30;i++)resume(op);}).toThrow(/state changed/);
	const pending=archiveOperation(sql,op)!;
	expect(sql.exec("SELECT 1 FROM archive WHERE activity_id=?",pending.activity).toArray()).toHaveLength(0);
	expect(sql.exec("SELECT undone_by FROM activity WHERE id=?",restored.activity).one().undone_by).toBeNull();
	run({action:"abort",operation_id:op,cursor:archiveCursor(pending),request_id:"inverse-abort"});drain(op);
	expect(sql.exec("SELECT status FROM nodes WHERE id=?",a).one().status).toBe("active");expect(sql.exec("SELECT ended_at FROM edges WHERE id=?",edge).one().ended_at).not.toBeNull();
}));
it("the real alarm resumes an archive page and pauses during account recovery",async()=>{
	const fixture=await registered(),{who,stub}=fixture;
	await runInDurableObject(stub,async(instance,state)=>{
		const {ctx}=harness(state.storage,who);
		const saved=await instance.write(who,{op:"save",args:{name:"archive alarm",type:"reference",description:"synthetic",content:"durable alarm body"}},ctx);expect(saved.ok).toBe(true);if(!saved.ok)return;
		const command:ArchiveCommand={action:"forget",memory_id:String(saved.value.memory_id),expected_revision:1,request_id:"alarm-start"};
		const started=await instance.archiveOperation(who,command,ctx);expect(started.ok).toBe(true);if(!started.ok)return;
		const op=String(started.value.operation_id),before=archiveOperation(state.storage.sql,op)!.version;
		await fixture.account(sql=>sql.exec("INSERT INTO account_meta(key,value) VALUES('recovery_state','synthetic')"));
		await instance.alarm();expect(archiveOperation(state.storage.sql,op)!.version).toBe(before);
		await fixture.account(sql=>sql.exec("DELETE FROM account_meta WHERE key='recovery_state'"));
		await instance.alarm();expect(archiveOperation(state.storage.sql,op)!.version).toBe(before+1);
	});
});
it("the wipe driver waits for bounded fence cancellation before account request fencing and purge",async()=>{
	const id=crypto.randomUUID(),record:WipeRecord={profile:"work",generations:[],wiped_at:new Date().toISOString(),marker_key:`synthetic-archive-wipe/${id}`,report:'{"state":"planning"}'};
	let fences=0,requestsFenced=false,purges=0;
	const ports:WipePorts={account:async c=>{
		if(c.op === "begin")return {ok:true,value:{record,refs:[{userId:id,profile:"personal",generation:id}],terms:[]}};
		if(c.op === "nodes")return {ok:true,value:{ids:[id],after:null}};
		if(c.op === "forget"&&c.requests.length)requestsFenced=true;
		return {ok:true,value:c.op === "finish"?{record:{...record,report:c.report}}:{}};
	},profile:async(_ref,s)=>{
		if(s.op === "fence"){fences++;return {ok:true,value:{done:fences>1,preserved:[],purged:[],redacted:0}};}
		if(s.op === "requests"){expect(fences).toBeGreaterThanOrEqual(2);return {ok:true,value:{ids:["synthetic-request"],after:null}};}
		if(s.op === "purge"){expect(requestsFenced).toBe(true);purges++;return {ok:true,value:{done:true,preserved:[],purged:[],redacted:0}};}
		if(s.op === "count_cleanup")return {ok:true,value:{done:true,preserved:[],purged:[],redacted:0}};
		return {ok:true,value:{ids:[],after:null}};
	}};
	const result=await wipeProfile(env,ports,{kind:"owner",userId:id,scopes:[],profiles:"*"},"work","work");expect(result.ok).toBe(true);expect(fences).toBe(2);expect(purges).toBe(1);
});

it("capture and the embedding final transaction cannot write through an archive fence",async()=>inArchive(async(storage,who)=>{
	const {make,run,drain}=harness(storage,who),sql=storage.sql,id=make("embedding fence");
	let gates=0,op="";
	await embedStep(storage,{...env,EMBEDDINGS:"on",AI:{async run(){return {data:[[1,0]]};}},VECTORS:{async upsert(){return {};}}} as unknown as Env,who,async()=>true,async()=>{
		if(++gates===4)op=String(run({action:"forget",memory_id:id,expected_revision:1,request_id:"embedding-final-fence"}).operation_id);
	});
	expect(gates).toBe(4);expect(sql.exec("SELECT seq FROM nodes WHERE id=?",id).one().seq).toBe(archiveOperation(sql,op)!.fenceSeq);
	run({action:"abort",operation_id:op,cursor:archiveCursor(archiveOperation(sql,op)!),request_id:"embedding-abort"});drain(op);
	const session={client:"codex" as const,id:"thr_archive"},body=JSON.stringify({asks:[],decisions:[],corrections:[],outcomes:{commits:[],prs:[],tests:[]},entities:[],dropped:{asks:0,decisions:0,corrections:0}});
	const digest=(range:string)=>({range_id:`codex:thr_archive:0a1b2c3d:${range}`,capture_status:"heuristic" as const,part_id:"-",sha256:sha256(body),body});
	expect(ingest(storage,who,{session,digests:[digest("0-100")],manifests:[]})[0]!.status).toBe("stored");
	const target=String(sql.exec("SELECT id FROM nodes WHERE key='session:codex:thr_archive'").one().id),before=sql.exec("SELECT count(*) n FROM texts WHERE node_id=?",target).one().n;
	op=String(run({action:"forget",memory_id:target,expected_revision:1,request_id:"capture-fence"}).operation_id);
	expect(()=>ingest(storage,who,{session,digests:[digest("100-200")],manifests:[]})).toThrow(/archive operation/);
	expect(sql.exec("SELECT count(*) n FROM texts WHERE node_id=?",target).one().n).toBe(before);
}));
