import { BudgetTx, restoreArchived } from "../src/profile/archive";
import { runArchive } from "../src/profile/archive-operations";
import { commitArgs } from "../src/profile/work-upload";
import { resumeTransfer } from "../src/transfer";
// The profile wipe (section 9) on real Workers SQLite, local R2 and the Vectorize fake: synthetic fixtures only. Transfers
// copy records out of `test` first; the wipe then closes it, purges its copies elsewhere and clears it.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { accountTransfer } from "../src/account/transfers";
import { ACCOUNT_MIGRATIONS } from "../src/account/schema";
import { sha256 } from "../src/domain/ids";
import { Fail, type Caller, type Outcome, type ProfileRef } from "../src/domain/types";
import { transferStep } from "../src/profile/transfer";
import { assertNotWiped, purgeOrigin } from "../src/profile/wipe";
import { readContent, runWrite } from "../src/profile/write";
import { migrate, nextSeq } from "../src/storage";
import { driveTransfer, type TransferPorts } from "../src/transfer";
import { wipeAccount, wipeProfile, type WipePorts } from "../src/wipe";
import { call } from "./helpers";

const unwrap = <T>(r: Outcome<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value; };
const vectors = env.VECTORS as unknown as { upsert(v: { id: string; values: number[]; namespace: string }[]): Promise<unknown>; _ids(): Promise<string[]> };

async function rig() {
	const caller: Caller = { userId: env.OWNER_USER_ID, kind: "owner", profiles: "*", scopes: ["read", "write"] };
	const refs = ["work", "personal", "me", "test"].map((profile): ProfileRef => ({ profile, userId: caller.userId, generation: crypto.randomUUID().slice(0, 8) }));
	const account = env.ACCOUNT.get(env.ACCOUNT.newUniqueId());
	const onAccount = <T,>(f: (s: DurableObjectStorage) => T | Promise<T>): Promise<T> => runInDurableObject(account, (_, s) => f(s.storage));
	const now = new Date().toISOString();
	await onAccount((s) => {
		migrate(s, "account_meta", ACCOUNT_MIGRATIONS);
		s.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('user_id', ?)", caller.userId);
		for (const r of refs) {
			s.sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", r.profile, `${r.userId}:${r.profile}:${r.generation}`, r.generation, now);
			s.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", r.generation, r.profile, now);
		}
		s.sql.exec("INSERT INTO devices (id, name, token_hash, scopes, profiles, default_profile, created_at, seq) VALUES ('d1', 'laptop', 'h', '[\"read\"]', '[\"test\",\"personal\"]', 'test', ?, 1)", now);
		s.sql.exec("INSERT INTO routing_rules (id, priority, match, pattern, profile, enabled, seq) VALUES ('r1', 10, 'remote', 'github.com/Zephyrcorp/*', 'test', 1, 1)");
	});
	const ref = (name: string) => refs.find((r) => r.profile === name)!;
	const profile = <T,>(r: ProfileRef, f: (s: DurableObjectStorage) => T | Promise<T>): Promise<T> =>
		runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${r.userId}:${r.profile}:${r.generation}`)), (_, s) => f(s.storage));
	const transfers: TransferPorts = { account: (cmd) => onAccount((s) => accountTransfer(s, cmd)), profile: (r, cmd) => profile(r, (s) => transferStep(s, env, r, cmd)) };
	const wipes: WipePorts = { account: (cmd) => onAccount((s) => wipeAccount(s, cmd)), profile: (r, step) => profile(r, (s) => purgeOrigin(s, env, r, step)) };
	const ctx = (name: string, hash: string) => ({ actor: "owner" as const, platform: "test", routedBy: "explicit", payloadHash: hash, userId: caller.userId });
	const save = async (name: string, where: string, type: "project" | "user" | "feedback", content: string) => {
		const request = crypto.randomUUID();
		const out = await profile(ref(where), (s) => runWrite(s, ref(where), { op: "save", args: { name, type, ...(type === "project" ? { kind: "journal" as const } : {}), description: "fixture", content, request_id: request } }, ctx(name, sha256(name))));
		const id = String(out.result.memory_id);
		await onAccount((s) => {
			s.sql.exec("INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, 1)", id, where);
			s.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES (?, ?, 'save_memory', ?, ?, 1)", request, where, sha256(name), now);
		});
		return { id, request };
	};
	const move = async (id: string, from: string, to: string, companyFree = false) =>
		unwrap(await driveTransfer(transfers, { id: crypto.randomUUID(), nodeId: id, from, to, companyFree, context: null }, caller));
	return { caller, ref, profile, onAccount, save, move, wipes, ctx };
}

describe("profile wipe", () => {
	it("redacts consumed-owner undo after an MCP work-to-personal transfer and completed work wipe", async () => {
		const userId = `wc-${crypto.randomUUID().slice(0, 8)}`, testEnv = { ...env, OWNER_USER_ID: userId, EMBEDDINGS: "off" } as Env;
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(userId));
		const fresh = unwrap(await account.context({ kind: "owner", userId }));
		const c = { env: testEnv, caller: fresh.caller, account: fresh, platform: "test" };
		const note = await call<{ memory_id: string }>(c, "save_memory", { profile: "work", name: "transferred pending mention", type: "reference", description: "fixture", content: "WRCASE-7404" });
		await call(c, "save_memory", { profile: "personal", memory_id: note.memory_id });
		const personal = fresh.profiles.find((p) => p.profile === "personal")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${userId}:personal:${personal.generation}`));
		expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT source_profile FROM nodes WHERE id = ?", note.memory_id).one().source_profile)).toBe("work");
		const made = await call<{ activity_id: number }>(c, "record_knowledge", { profile: "personal", nodes: [{ kind: "bug", key: "jira:WRCASE-7404", name: "personal target" }] });
		const before = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT targets, undo FROM activity WHERE id = ?", made.activity_id).one());
		expect(JSON.parse(String(before.undo)).mentions).toMatchObject([{ row: { owner: `n:${note.memory_id}`, kind: "mention", ref: "jira:WRCASE-7404" } }]);
		const wiped = unwrap(await account.admin({ op: "wipeProfile", profile: "work", typed: "work" })) as { report: string };
		expect(JSON.parse(String(wiped.report))).toMatchObject({ state: "done", purged: 1 });
		await runInDurableObject(stub, (_i, s) => {
			const sql = s.storage.sql;
			expect(sql.exec("SELECT * FROM nodes WHERE id = ?", note.memory_id).toArray()).toEqual([]);
			expect(sql.exec("SELECT * FROM evidence WHERE owner = ?", `n:${note.memory_id}`).toArray()).toEqual([]);
			const after = sql.exec("SELECT undo, redacted FROM activity WHERE id = ?", made.activity_id).one();
			expect(after.undo).toBeNull();
			expect(after.redacted).not.toBeNull();
		});
	});

	it("purges every copy and its traces, redacts activity, keeps survivors, backlinks and hand-written notes, and leaves no resurrection path", async () => {
		const r = await rig();
		const native = await r.save("native", "test", "project", "test-only journal");
		const moved = await r.save("moved", "test", "project", "body from test");
		const pref = await r.save("concise answers", "test", "user", "prefers short answers");
		const rule = await r.save("house rule", "test", "feedback", "always run the checks");
		await r.move(moved.id, "test", "personal");
		await r.move(pref.id, "test", "me", true);
		await r.move(rule.id, "test", "me", true);
		// The moved record gets a new body in personal: its activity now carries the record.
		await r.profile(r.ref("personal"), (s) => runWrite(s, r.ref("personal"), { op: "save", args: { memory_id: moved.id, content: "rewritten in personal" } }, r.ctx("edit", "e1")));
		const unrelated = await r.save("groceries", "personal", "project", "milk and eggs");
		await r.profile(r.ref("personal"), (s) => runWrite(s, r.ref("personal"), { op: "save", args: { memory_id: unrelated.id, content: "milk, eggs, bread" } }, r.ctx("edit2", "e2")));
		const note = await r.save("trip notes", "personal", "project", "Ask Zephyrcorp about the visa letter");
		await r.profile(r.ref("personal"), (s) => s.sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, reason, recorded_at, actor, seq)
			VALUES (?, 'relates_to', ?, 'test', 'judgment', 'links to a test record', ?, 'agent', 1)`, note.id, native.id, new Date().toISOString()));
		await r.onAccount((s) => s.sql.exec("INSERT INTO sensitive_terms (term, source, updated_at, seq) VALUES ('Zephyrcorp', 'owner', ?, 1)", new Date().toISOString()));
		const vid = (p: string, id: string) => `g${r.ref(p).generation}:${id}`;
		await vectors.upsert([vid("personal", moved.id), vid("test", native.id), vid("personal", note.id)].map((id) => ({ id, values: Array.from({ length: 64 }, (_, i) => (i === 1 ? 1 : 0)), namespace: "fixture" })));

		const done = unwrap(await wipeProfile(env, r.wipes, r.caller, "test", "test"));
		const report = JSON.parse(done.report) as { state: string; purged: number; redacted: number; preserved: string[] };
		expect(report).toMatchObject({ state: "done", preserved: [pref.id] });
		expect(report.redacted).toBeGreaterThan(0);

		await r.onAccount((s) => {
			expect(s.sql.exec("SELECT status FROM profiles WHERE name = 'test'").one().status).toBe("wiped");
			expect(s.sql.exec("SELECT count(*) AS n FROM routing_rules WHERE profile = 'test'").one().n).toBe(0);
			expect(s.sql.exec("SELECT profiles, default_profile FROM devices WHERE id = 'd1'").one()).toEqual({ profiles: "[\"personal\"]", default_profile: null });
			expect(s.sql.exec("SELECT node_id FROM node_index WHERE node_id IN (?, ?, ?, ?)", native.id, moved.id, pref.id, rule.id).toArray()).toEqual([{ node_id: pref.id }]);
			// A late retry of a purged record's request gets a content-free refusal instead of creating it again.
			expect(s.sql.exec("SELECT op, payload_hash FROM request_index WHERE request_id = ?", moved.request).one()).toEqual({ op: "wiped", payload_hash: "" });
			expect(s.sql.exec("SELECT state FROM generations WHERE profile = 'test'").one().state).toBe("wiped");
		});
		expect(await r.onAccount((s) => accountTransfer(s, { op: "begin", id: "late", nodeId: native.id, from: "test", to: "personal", caller: r.caller }))).toMatchObject({ ok: false, error: { code: "profile_wiped" } });

		await r.profile(r.ref("personal"), (s) => {
			for (const t of ["nodes WHERE id", "texts WHERE node_id", "revisions WHERE node_id", "requests WHERE node_id"]) expect(s.sql.exec(`SELECT count(*) AS n FROM ${t} = ?`, moved.id).one().n, t).toBe(0);
			const touched = s.sql.exec<{ summary: string; undo: string | null; redacted: string | null }>("SELECT summary, undo, redacted FROM activity WHERE EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?)", moved.id).toArray();
			expect(touched.length).toBeGreaterThanOrEqual(2);
			for (const a of touched) {
				expect(a.undo).toBeNull();
				expect(a.redacted).toBe(`wipe:test:${done.wiped_at}`);
				expect(a.summary).toMatch(/^\w+, 1 records, redacted by wipe of test$/);
			}
			expect(s.sql.exec("SELECT count(*) AS n FROM activity WHERE redacted IS NULL AND EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?)", unrelated.id).one().n).toBe(2);
			expect(readContent(s.sql, unrelated.id)).toBe("milk, eggs, bread");
			// The opaque backlink and the hand-written note stay; the note is reported, not changed.
			expect(s.sql.exec("SELECT dst, dst_profile, reason FROM edges WHERE src = ?", note.id).one()).toEqual({ dst: native.id, dst_profile: "test", reason: "links to a test record" });
			expect(s.sql.exec("SELECT flagged FROM nodes WHERE id = ?", note.id).one().flagged).toBeNull();
			expect(() => assertNotWiped(s.sql, moved.id)).toThrow(Fail);
		});
		await r.profile(r.ref("me"), (s) => {
			expect(s.sql.exec("SELECT source_profile, status FROM nodes WHERE id = ?", pref.id).one()).toEqual({ source_profile: "test", status: "active" });
			expect(s.sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", rule.id).one().n).toBe(0);
		});
		await r.profile(r.ref("test"), (s) => expect(s.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'nodes'").one().n).toBe(0));
		const left = await vectors._ids();
		expect(left).toContain(vid("personal", note.id));
		expect(left).not.toContain(vid("personal", moved.id));
		expect(left).not.toContain(vid("test", native.id));

		// The permanent tombstone holds ids only: every copied id, and nothing of their content.
		const listed = await env.BACKUPS.list({ prefix: done.marker_key });
		const bodies = await Promise.all(listed.objects.map(async (o) => (await env.BACKUPS.get(o.key))!.text()));
		const all = bodies.join("\n");
		for (const id of [native.id, moved.id, pref.id, rule.id]) expect(all).toContain(id);
		for (const text of ["test-only journal", "body from test", "rewritten in personal", "always run the checks", "concise answers"]) expect(all).not.toContain(text);
		const handwritten = listed.objects.filter((o) => o.key.includes("/handwritten/"));
		expect(handwritten.length).toBe(1);
		expect(JSON.parse(bodies[listed.objects.indexOf(handwritten[0]!)]!)).toEqual([note.id]);
		const ledger = await env.BACKUPS.get(`generations/${r.ref("test").generation}.json`);
		expect(JSON.parse(await ledger!.text())).toMatchObject({ state: "wiped" });

		// The accepted survivor is spared everywhere: not fenced elsewhere, its request still bound, and it can still move.
		for (const p of ["personal", "work"]) await r.profile(r.ref(p), (s) => expect(s.sql.exec("SELECT count(*) AS n FROM profile_meta WHERE key = ?", `wiped:${pref.id}`).one().n).toBe(0));
		await r.onAccount((s) => expect(s.sql.exec("SELECT profile, op FROM request_index WHERE request_id = ?", pref.request).one()).toEqual({ profile: "me", op: "save_memory" }));
		await r.move(pref.id, "me", "personal");
		await r.profile(r.ref("personal"), (s) => expect(s.sql.exec("SELECT status FROM nodes WHERE id = ?", pref.id).one().status).toBe("active"));

		// A second call replays the finished wipe.
		expect(unwrap(await wipeProfile(env, r.wipes, r.caller, "test", "test")).wiped_at).toBe(done.wiped_at);
	});

	it("needs the owner and the exact typed name, and waits for open transfers", async () => {
		const r = await rig();
		expect(await wipeProfile(env, r.wipes, r.caller, "test", "tset")).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await wipeProfile(env, r.wipes, { ...r.caller, kind: "device" }, "test", "test")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const rec = await r.save("pending", "test", "project", "fixture");
		unwrap(await r.onAccount((s) => accountTransfer(s, { op: "begin", id: "open", nodeId: rec.id, from: "test", to: "personal", caller: r.caller })));
		expect(await wipeProfile(env, r.wipes, r.caller, "test", "test")).toMatchObject({ ok: false, error: { code: "moving" } });
		await r.onAccount((s) => expect(s.sql.exec("SELECT status FROM profiles WHERE name = 'test'").one().status).toBe("active"));
	});
});


it("rejects stale contexts at binding, replay and every public profile entry after close", async () => {
	const { contextFor, call, outcome } = await import("./helpers");
	const { accountStub, profileStub } = await import("../src/mcp");
	const c = await contextFor(), account = accountStub(env, c.caller.userId);
	const ref = c.account.profiles.find((p) => p.profile === "test")!;
	const q = crypto.randomUUID(), args = { name: "before close", type: "project", kind: "journal", description: "fixture", profile: "test", request_id: q };
	await call(c, "save_memory", args);
	unwrap(await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(c.caller.userId)), (_, state) => wipeAccount(state.storage, { op: "begin", caller: c.caller, profile: "test", typed: "test" })));
	for (const request_id of [q, crypto.randomUUID()]) expect(await outcome(c, "save_memory", { ...args, request_id })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	const stub = profileStub(env, ref);
	expect(await stub.read(ref, { kind: "has", id: "any" })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	expect(await stub.captureState(ref, [])).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	expect(await stub.ingest(ref, { items: [] } as never)).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	expect(await stub.importStep(ref, { op: "link", src: "a", dst: "b" })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	expect(await account.reserveImport({ profile: "test", requests: [] })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	const personal = c.account.profiles.find((p) => p.profile === "personal")!;
	const wrong = { ...personal, generation: "retired-generation" };
	expect(await (env.ACCOUNT.get(env.ACCOUNT.idFromName(c.caller.userId)) as unknown as Pick<import("../src/account/store").AccountStore, "profileAccess">).profileAccess(wrong)).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
});


describe("observed count origin wipe",()=>{
	it("erases metadata-only work copies, preserves personal archive restoration, and drains decided personal transfers",{timeout:60_000},async()=>{
		const run=BudgetTx.prototype.run;let peak={rows:0,bytes:0,binds:0};
		const meter=vi.spyOn(BudgetTx.prototype,'run').mockImplementation(function(this:BudgetTx,q,...params){try{return run.call(this,q,...params);}finally{peak={rows:Math.max(peak.rows,this.rows),bytes:Math.max(peak.bytes,this.bytes),binds:Math.max(peak.binds,params.length)};}});
		try{

		for(const stop of ["archive","restore","land","publish"]){
			const r=await rig(),personal=r.ref('personal'),work=r.ref('work');
			const note=await r.save('unrelated personal note','personal','project','personal payload stays');
			const person=await r.profile(personal,s=>{
				const out=runWrite(s,personal,{op:'knowledge',args:{nodes:[{kind:'person',key:'person:github:count-origin',name:'count-origin'}]}},r.ctx('person','person'));
				return out.created[0]!;
			});
			await r.onAccount(s=>s.sql.exec("INSERT INTO node_index(node_id,profile,seq) VALUES(?,'personal',1)",person));
			await r.move(person,'personal','work');
			const uploaded=await r.profile(work,s=>{
				const args=commitArgs('wipe/count-origin',{sha:'e'.repeat(40),at:'2001-02-03T04:05:06.000Z',title:'work count source',author:'count-origin'});
				const out=runWrite(s,work,{op:'upload',args},{actor:'index',platform:'test',routedBy:'test',payloadHash:sha256(JSON.stringify(args)),userId:work.userId});
				return {out,args,project:String(s.sql.exec("SELECT id FROM nodes WHERE kind='project'").one().id)};
			});
			await r.onAccount(s=>{
				for(const id of uploaded.out.created)s.sql.exec("INSERT INTO node_index(node_id,profile,seq) VALUES(?,'work',1)",id);
				s.sql.exec("INSERT INTO request_index(request_id,profile,op,payload_hash,at,seq) VALUES(?,'work','upload','count',?,1)",uploaded.args.request_id,new Date().toISOString());
			});
			await r.move(person,'work','personal');
			await r.profile(personal,s=>{
				expect(s.sql.exec("SELECT source_profile FROM nodes WHERE id=?",person).one().source_profile).toBe('personal');
				s.sql.exec("INSERT INTO edges(src,rel,dst,dst_profile,basis,reason,recorded_at,actor,seq) VALUES(?,'relates_to',?,'work','judgment','personal opaque backlink',?,'owner',1)",note.id,uploaded.project,new Date().toISOString());
			});
			let removal:number|undefined;
			if(stop==='archive'||stop==='restore'){
				removal=await r.profile(personal,s=>{
					let out=runArchive(s,personal,{action:'forget',memory_id:person,expected_revision:Number(s.sql.exec("SELECT revision FROM nodes WHERE id=?",person).one().revision),request_id:'count-person-forget'},r.ctx('archive','forget'));
					for(let i=0;i<100 && (out.state!=='complete'||out.cleanup_pending);i++)out=runArchive(s,personal,{action:'resume',operation_id:String(out.operation_id),cursor:String(out.cursor),request_id:'count-forget-'+i},r.ctx('archive','forget-'+i));
					expect(out.state).toBe('complete');return Number(out.activity_id);
				});
				if(stop==='restore')await r.profile(personal,s=>{
					const out=runArchive(s,personal,{action:'restore',activity_id:removal!,request_id:'count-paused-restore'},r.ctx('restore','paused'));
					expect(out.state).toBe('running');
				});
			}else{
				const ports:TransferPorts={account:c=>r.onAccount(s=>accountTransfer(s,c)),profile:(ref,c)=>r.profile(ref,s=>transferStep(s,env,ref,c))};
				r.wipes.resumeCountTransfer=(id,terms)=>resumeTransfer(ports,id,terms);
				const input={id:crypto.randomUUID(),nodeId:person,from:'personal',to:'test',companyFree:false,context:null};
				const fault:TransferPorts={...ports,profile:async(ref,c)=>{const out=await ports.profile(ref,c);if(c.op===stop)throw new Error('paused count transfer');return out;}};
				await expect(driveTransfer(fault,input,r.caller)).rejects.toThrow('paused count transfer');
			}
			unwrap(await wipeProfile(env,r.wipes,r.caller,'work','work'));
			await r.profile(personal,s=>{
				expect(readContent(s.sql,note.id)).toContain('personal payload stays');
				expect(s.sql.exec("SELECT reason FROM edges WHERE src=? AND dst=?",note.id,uploaded.project).one().reason).toBe('personal opaque backlink');
			});
			for(const where of ['personal','test'])await r.profile(r.ref(where),s=>{
				expect(s.sql.exec("SELECT key FROM profile_meta WHERE key GLOB 'work-count:work:*'").toArray()).toEqual([]);
				const rows=['nodes','texts','revisions','requests','activity','archive','profile_meta','transfer_parts'].map(t=>({table:t,rows:s.sql.exec('SELECT * FROM '+t).toArray()}));
				// Existing opaque authored backlinks retain their own validity time. They are not accounting metadata.
				const residue=rows.flatMap(t=>t.rows.filter(row=>{
					if(t.table==='archive' && row.source==='edges'){const e=JSON.parse(String(row.payload));if(e.rel==='authored' && e.dst_profile==='work' && e.count_key===null)return false;}
					return JSON.stringify(row).includes('2001-02-03T04:05:06.000Z');
				}).map(row=>({table:t.table,key:row.key??row.id??row.request_id})));
				expect(residue).toEqual([]);
			});
			if(stop==='archive')await r.profile(personal,s=>{
				let out=runArchive(s,personal,{action:'restore',activity_id:removal!,request_id:'count-person-restore'},r.ctx('restore','restore'));
				for(let i=0;i<100 && (out.state!=='complete'||out.cleanup_pending);i++)out=runArchive(s,personal,{action:'resume',operation_id:String(out.operation_id),cursor:String(out.cursor),request_id:'count-restore-'+i},r.ctx('restore','restore-'+i));
				expect(out.state).toBe('complete');expect(s.sql.exec("SELECT name FROM nodes WHERE id=?",person).one().name).toBe('count-origin');
				expect(s.sql.exec("SELECT id FROM edges WHERE rel='works_on'").toArray()).toEqual([]);
			});
			else await r.profile(stop==='restore'?personal:r.ref('test'),s=>expect(s.sql.exec("SELECT name FROM nodes WHERE id=?",person).one().name).toBe('count-origin'));
		}
		}finally{meter.mockRestore();}
		expect(peak.rows).toBeGreaterThan(0);expect(peak.rows).toBeLessThanOrEqual(1000);expect(peak.bytes).toBeLessThanOrEqual(1000000);expect(peak.binds).toBeLessThanOrEqual(100);
		console.log('COUNT_WIPE_RESOURCES',JSON.stringify(peak));

	});
});


describe('counter correction retired history wipe',()=>{
 it('keeps retired-epoch origin labels through transfer and erases them on the real origin wipe',async()=>{
  const r=await rig(),personal=r.ref('personal'),work=r.ref('work');
  const person=await r.profile(personal,s=>runWrite(s,personal,{op:'knowledge',args:{nodes:[{kind:'person',key:'person:github:retired-origin',name:'retired-origin'}]}},r.ctx('person','retired-person')).created[0]!);
  await r.onAccount(s=>s.sql.exec("INSERT INTO node_index(node_id,profile,seq) VALUES(?,'personal',1)",person));await r.move(person,'personal','work');
  const created=await r.profile(work,s=>{
   const upload=(i:number)=>{const args=commitArgs('wipe/retired-origin',{sha:i.toString(16).padStart(40,'0'),at:'2026-02-01T00:00:00.000Z',title:'retired origin '+i,author:'retired-origin'});return runWrite(s,work,{op:'upload',args},{actor:'index',platform:'test',routedBy:'test',payloadHash:sha256(JSON.stringify(args)),userId:work.userId});};
   const a=upload(1);runWrite(s,work,{op:'undo',args:{activity_id:Number(a.result.activity_id),request_id:'retired-undo'}},r.ctx('undo','retired-undo'));
   return upload(2).created;
  });
  await r.onAccount(s=>{for(const id of created)s.sql.exec("INSERT OR IGNORE INTO node_index(node_id,profile,seq) VALUES(?,'work',1)",id);});await r.move(person,'work','personal');
  await r.profile(personal,s=>expect(s.sql.exec("SELECT count(*) AS n FROM archive WHERE source='edges' AND json_extract(payload,'$.rel')='works_on' AND json_extract(payload,'$.weight')=0 AND json_extract(payload,'$.count_key') LIKE 'work-count:work:%'").one().n).toBe(1));
  unwrap(await wipeProfile(env,r.wipes,r.caller,'work','work'));
  await r.profile(personal,s=>{
   expect(s.sql.exec('SELECT name FROM nodes WHERE id=?',person).one().name).toBe('retired-origin');
   expect(s.sql.exec("SELECT key FROM profile_meta WHERE key GLOB 'work-count:work:*'").toArray()).toEqual([]);
   expect(s.sql.exec("SELECT 1 FROM archive WHERE source='edges' AND json_extract(payload,'$.count_key') LIKE 'work-count:work:%'").toArray()).toEqual([]);
   expect(s.sql.exec("SELECT 1 FROM edges WHERE count_key LIKE 'work-count:work:%'").toArray()).toEqual([]);
  });
 });
});


describe('null-epoch history origin wipe',()=>{
 it('drains history-only transfers and erases live/archive content without purging personal people or opaque backlinks',async()=>{
  const run=BudgetTx.prototype.run;let peak={rows:0,bytes:0,binds:0};
  const meter=vi.spyOn(BudgetTx.prototype,'run').mockImplementation(function(this:BudgetTx,q,...params){try{return run.call(this,q,...params);}finally{peak={rows:Math.max(peak.rows,this.rows),bytes:Math.max(peak.bytes,this.bytes),binds:Math.max(peak.binds,params.length)};}});
  try{
   for(const archived of [false,true])for(const stop of ['complete','fence','land']){
    const r=await rig(),personal=r.ref('personal'),work=r.ref('work'),test=r.ref('test');
    const person=await r.profile(personal,s=>runWrite(s,personal,{op:'knowledge',args:{nodes:[{kind:'person',key:'person:github:null-wipe',name:'null-wipe'}]}},r.ctx('person','null-person')).created[0]!);
    await r.onAccount(s=>s.sql.exec("INSERT INTO node_index(node_id,profile,seq) VALUES(?,'personal',1)",person));await r.move(person,'personal','work');
    const f=await r.profile(work,s=>{
     const args=commitArgs('fixture/null-wipe',{sha:'b'.repeat(40),at:'2001-02-03T04:05:06.000Z',title:'origin history',author:'null-wipe'}),out=runWrite(s,work,{op:'upload',args},{...r.ctx('upload','upload'),actor:'index',payloadHash:sha256(JSON.stringify(args))});
     const row=s.sql.exec("SELECT id,dst FROM edges WHERE rel='works_on'").one();
     runWrite(s,work,{op:'knowledge',args:{end:[{edge:Number(row.id),valid_to:'2002-03-04T05:06:07.000Z',reason:'ordinary history must be wiped'}]}},r.ctx('end','null-end'));
     for(let i=0;i<80;i++)s.sql.exec("INSERT INTO evidence(owner,kind,ref,note,seq) VALUES(?,'link',?,'origin history evidence',?)",`e:${row.id}`,'https://example.test/origin-history/'+i,nextSeq(s.sql,'profile_meta'));
     const forgotten=runWrite(s,work,{op:'owner',args:{action:'forget',memory_id:person,request_id:'wipe-null-forget'}},r.ctx('forget','null-forget'));
     runWrite(s,work,{op:'restore',args:{activity_id:Number(forgotten.result.activity_id),request_id:'wipe-null-restore'}},r.ctx('restore','null-restore'));
     if(archived)runWrite(s,work,{op:'owner',args:{action:'forget',memory_id:String(row.dst),request_id:'wipe-null-project'}},r.ctx('forget','null-project'));
     return {created:out.created,project:String(row.dst)};
    });
    await r.onAccount(s=>{for(const id of f.created)s.sql.exec("INSERT OR IGNORE INTO node_index(node_id,profile,seq) VALUES(?,'work',1)",id);});
    await r.move(person,'work','test');
    if(!archived && stop==='complete')await r.profile(test,s=>{
     const queries=[['edges','SELECT id,src,count_key FROM edges WHERE id>? ORDER BY id LIMIT 10',[0]],['archive','SELECT id,source,payload FROM archive WHERE id>? ORDER BY id LIMIT 10',[0]],['parts','SELECT transfer_id,n,payload FROM transfer_parts WHERE (transfer_id,n)>(?,?) ORDER BY transfer_id,n LIMIT 1',['',0]]] as const;
     const plans=queries.map(([name,q,params])=>({name,detail:s.sql.exec('EXPLAIN QUERY PLAN '+q,...params).toArray().map(row=>String(row.detail)).join('; ')}));
     for(const plan of plans)expect(plan.detail).toMatch(/SEARCH .* (INTEGER PRIMARY KEY|PRIMARY KEY)/);
     console.log('NULL_HISTORY_DISCOVERY_PLANS',JSON.stringify(plans));
    });
    await r.profile(test,s=>expect(s.sql.exec("SELECT key FROM profile_meta WHERE key GLOB 'work-count:work:*'").toArray()).toEqual([]));
    const note=await r.save('personal survivor','personal','project','personal payload stays');
    await r.profile(personal,s=>s.sql.exec("INSERT INTO edges(src,rel,dst,dst_profile,basis,reason,recorded_at,actor,seq) VALUES(?,'relates_to',?,'work','judgment','personal opaque backlink',?,'owner',1)",note.id,f.project,new Date().toISOString()));
    const ports:TransferPorts={account:c=>r.onAccount(s=>accountTransfer(s,c)),profile:(ref,c)=>r.profile(ref,s=>transferStep(s,env,ref,c))};
    r.wipes.resumeCountTransfer=(id,terms)=>resumeTransfer(ports,id,terms);
    const input={id:crypto.randomUUID(),nodeId:person,from:'test',to:'personal',companyFree:false,context:null};
    if(stop==='complete'){
     unwrap(await driveTransfer(ports,input,r.caller));
     if(archived)await r.profile(personal,s=>s.transactionSync(()=>{
      const a=s.sql.exec("SELECT id,activity_id,payload FROM archive WHERE source='edges' AND json_extract(payload,'$.rel')='works_on'").one(),row=JSON.parse(String(a.payload));
      expect(row.id).toBeLessThan(0);
      const evidence=s.sql.exec("SELECT id FROM archive WHERE source='evidence' AND activity_id=? AND json_extract(payload,'$.owner')=?",a.activity_id!,`e:${row.id}`).toArray();
      restoreArchived(new BudgetTx(s.sql,nextSeq(s.sql,"profile_meta"),new Date().toISOString()),[Number(a.id),...evidence.map(e=>Number(e.id))]);
      expect(s.sql.exec('SELECT count_epoch FROM edges WHERE id=?',Number(row.id)).one().count_epoch).toBe(null);
     }));
    }
    else{
     const fault:TransferPorts={...ports,profile:async(ref,c)=>{const out=await ports.profile(ref,c);if(c.op===stop)throw new Error('pause history-only transfer');return out;}};
     await expect(driveTransfer(fault,input,r.caller)).rejects.toThrow('pause history-only transfer');
     if(stop==='land')await r.profile(personal,s=>s.sql.exec('DELETE FROM nodes WHERE id=?',person));
    }
    unwrap(await wipeProfile(env,r.wipes,r.caller,'work','work'));
    await r.profile(personal,s=>{
     expect(readContent(s.sql,note.id)).toContain('personal payload stays');
     expect(s.sql.exec('SELECT reason FROM edges WHERE src=? AND dst=?',note.id,f.project).one().reason).toBe('personal opaque backlink');
    });
    for(const ref of [personal,test])await r.profile(ref,s=>{
     expect(s.sql.exec("SELECT 1 FROM edges WHERE count_key LIKE 'work-count:work:%'").toArray()).toEqual([]);
     expect(s.sql.exec("SELECT 1 FROM archive WHERE source='edges' AND json_extract(payload,'$.count_key') LIKE 'work-count:work:%'").toArray()).toEqual([]);
     expect(s.sql.exec("SELECT key FROM profile_meta WHERE key GLOB 'work-count:work:*' OR key GLOB 'work-count-transfer:*'").toArray()).toEqual([]);
     expect(s.sql.exec('SELECT n FROM transfer_parts').toArray()).toEqual([]);
     for(const table of ['evidence','archive','requests','activity','profile_meta'])expect(JSON.stringify(s.sql.exec('SELECT * FROM '+table).toArray())).not.toContain('origin history evidence');
    });
    const holder=stop==='complete'?personal:test;
    await r.profile(holder,s=>expect(s.sql.exec('SELECT name,source_profile FROM nodes WHERE id=?',person).one()).toEqual({name:'null-wipe',source_profile:'personal'}));
   }
  }finally{meter.mockRestore();}
  expect(peak.rows).toBeGreaterThan(0);expect(peak.rows).toBeLessThanOrEqual(1000);expect(peak.bytes).toBeLessThanOrEqual(1000000);expect(peak.binds).toBeLessThanOrEqual(100);
  console.log('NULL_HISTORY_WIPE_RESOURCES',JSON.stringify(peak));
 });
});
