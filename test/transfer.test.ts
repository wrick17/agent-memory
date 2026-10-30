import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountTransfer } from "../src/account/transfers";
import { ACCOUNT_MIGRATIONS } from "../src/account/schema";
import { sha256 } from "../src/domain/ids";
import { Fail, type Caller, type Outcome, type ProfileRef } from "../src/domain/types";
import { assertWritable, dueTransfers, transferStep, type TransferStep } from "../src/profile/transfer";
import { readContent, runWrite } from "../src/profile/write";
import { migrate } from "../src/storage";
import { call, contextFor, outcome } from "./helpers";
import { accountStub } from "../src/mcp";
import { transferPorts } from "../src/transfer";
import { archiveRows, restoreArchived, BudgetTx, purgeAfter } from "../src/profile/archive";
import { nextSeq } from "../src/storage";
import { foldStep, foldDue } from "../src/profile/compact";
import { undo } from "../src/profile/undo";
import { get } from "../src/profile/read";
import { runImport, type ImportNode } from "../src/profile/import";
import { purgeOrigin } from "../src/profile/wipe";
import { wipeAccount, wipeProfile, type WipePorts } from "../src/wipe";
import { driveTransfer, type TransferInput, type TransferPorts } from "../src/transfer";

export const unwrap = <T>(r: Outcome<T>): T => { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.value; };
export async function rig() {
	const caller: Caller = { userId: env.OWNER_USER_ID, kind: "owner", profiles: "*", scopes: ["read", "write"] };
	const refs = ["work", "personal", "me", "test"].map((profile): ProfileRef => ({ profile, userId: caller.userId, generation: crypto.randomUUID().slice(0, 8) }));
	const account = env.ACCOUNT.get(env.ACCOUNT.newUniqueId());
	const onAccount = <T,>(f: (s: DurableObjectStorage) => T) => runInDurableObject(account, (_, s) => f(s.storage));
	await onAccount((s) => {
		migrate(s, "account_meta", ACCOUNT_MIGRATIONS);
		s.sql.exec("INSERT OR REPLACE INTO account_meta (key,value) VALUES ('user_id',?)", caller.userId);
		for (const r of refs) {
			s.sql.exec("INSERT INTO profiles (name,object_name,generation,status,created_at,seq) VALUES (?,?,?,'active',?,1)", r.profile, `${r.userId}:${r.profile}:${r.generation}`, r.generation, new Date().toISOString());
			s.sql.exec("INSERT INTO generations (id,profile,purpose,state,reserved_at,seq) VALUES (?,?,'live','active',?,1)", r.generation, r.profile, new Date().toISOString());
		}
	});
	const ref = (name: string) => refs.find((r) => r.profile === name)!;
	const profile = <T,>(r: ProfileRef, f: (s: DurableObjectStorage) => T | Promise<T>): Promise<T> => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${r.userId}:${r.profile}:${r.generation}`)), (_, s) => f(s.storage));
	const ports: TransferPorts = { account: (cmd) => onAccount((s) => accountTransfer(s, cmd)), profile: (r, cmd) => profile(r, (s) => transferStep(s, env, r, cmd)) };
	const save = async (name: string, profileName = "work", content = "initial", request = crypto.randomUUID(), kind: "journal" | "preference" = "journal") => {
		const r = ref(profileName);
		const result = await profile(r, (s) => runWrite(s, r, { op: "save", args: { name, type: kind === "preference" ? "user" : "project", kind, description: "fixture", content, request_id: request } },
			{ actor: "owner", platform: "test", routedBy: "explicit", payloadHash: sha256(name), userId: caller.userId, ...(profileName === "me" ? { meGuard: { explicit: true, context: null, companyFree: true, sensitiveTerms: [] } } : {}) }));
		const id = String(result.result.memory_id);
		await onAccount((s) => { s.sql.exec("INSERT INTO node_index (node_id,profile,seq) VALUES (?,?,1)", id, profileName); s.sql.exec("INSERT INTO request_index (request_id,profile,op,payload_hash,at,seq) VALUES (?,?,'save_memory',?,?,1)", request, profileName, sha256(name), new Date().toISOString()); });
		return { id, request, result };
	};
	return { refs, ref, caller, ports, profile, onAccount, save };
}

const inputFor = (id: string, to = "personal"): TransferInput => ({ id: crypto.randomUUID(), nodeId: id, from: "work", to, companyFree: true, context: "work" });

// Crash faults are transport failures, so the driver leaves persisted progress for a later invocation.
describe("bounded profile transfer", () => {
	it("moves exact history and requests, preserves first origin, and replays old request ids", async () => {
		const r = await rig(), saved = await r.save("history"), input = inputFor(saved.id);
		unwrap(await driveTransfer(r.ports, input, r.caller));
		await r.profile(r.ref("personal"), (s) => {
			expect(s.sql.exec("SELECT status,source_profile,source_id,revision FROM nodes WHERE id=?", saved.id).one()).toMatchObject({ status: "active", source_profile: "work", source_id: saved.id, revision: 2 });
			const replay = runWrite(s, r.ref("personal"), { op: "save", args: { name: "history", request_id: saved.request } }, { actor: "owner", platform: "test", routedBy: "explicit", payloadHash: sha256("history"), userId: r.caller.userId });
			expect(replay.result.action).toBe("replayed");
		});
		await r.profile(r.ref("work"), (s) => {
			expect(s.sql.exec("SELECT status,name FROM nodes WHERE id=?", saved.id).one()).toEqual({ status: "moved", name: "" });
			expect(s.sql.exec("SELECT count(*) n FROM archive WHERE source='texts'").one().n).toBeGreaterThan(0);
			expect(s.sql.exec("SELECT count(*) n FROM requests WHERE node_id=?", saved.id).one().n).toBe(1);
		});
		await r.onAccount((s) => expect(s.sql.exec("SELECT profile FROM request_index WHERE request_id=?", saved.request).one().profile).toBe("personal"));
		unwrap(await driveTransfer(r.ports, { ...input, id: crypto.randomUUID(), from: "personal", to: "test" }, r.caller));
		await r.profile(r.ref("test"), (s) => expect(s.sql.exec("SELECT source_profile FROM nodes WHERE id=?", saved.id).one().source_profile).toBe("work"));
	});

	it("resumes after a transport crash at every durable phase, keeping writes after publish", async () => {
		for (const stop of ["begin", "fence", "pack", "sent", "land", "decide", "publish", "rebind", "done", "settle", "commit"]) {
			const r = await rig(), saved = await r.save(`crash-${stop}`), input = inputFor(saved.id);
			let hit = false;
			const fault: TransferPorts = {
				account: async (cmd) => { const out = await r.ports.account(cmd); if (!hit && cmd.op === stop) { hit = true; throw new Error("crash"); } return out; },
				profile: async (ref, cmd) => {
					const out = await r.ports.profile(ref, cmd);
					if (!hit && cmd.op === stop) {
						hit = true;
						if (stop === "publish") await r.profile(ref, (s) => {
							for (const n of [1, 2]) runWrite(s, ref, { op: "append", args: { memory_id: saved.id, content: `after publish ${n}`, request_id: `${input.id}:${n}` } }, { actor: "owner", platform: "test", routedBy: "explicit", payloadHash: `h${n}`, userId: ref.userId });
						});
						throw new Error("crash");
					}
					return out;
				},
			};
			await expect(driveTransfer(fault, input, r.caller)).rejects.toThrow("crash");
			expect(hit, stop).toBe(true);
			const resumed = unwrap(await driveTransfer(r.ports, input, undefined));
			expect(resumed.state, stop).toBe("committed");
			await r.profile(r.ref("personal"), (s) => {
				expect(s.sql.exec("SELECT status,revision FROM nodes WHERE id=?", saved.id).one()).toMatchObject({ status: "active", revision: stop === "publish" ? 4 : 2 });
			});
		}
	});

	it("aborts on exact-bundle me guard failure and target collision without publishing", async () => {
		for (const collision of [false, true]) {
			const r = await rig(), saved = await r.save("blocked", "work", "Acme-Private right before fence"), input = inputFor(saved.id, collision ? "personal" : "me");
			if (collision) await r.save("blocked", "personal");
			const out = await driveTransfer(r.ports, input, r.caller, ["Acme-Private"]);
			expect(out).toMatchObject({ ok: false, error: { code: collision ? "transfer_collision" : "me_sensitive_term" } });
			await r.profile(r.ref("work"), (s) => expect(s.sql.exec("SELECT status FROM nodes WHERE id=?", saved.id).one().status).toBe("active"));
			await r.profile(r.ref(input.to), (s) => expect(s.sql.exec("SELECT count(*) n FROM nodes WHERE id=?", saved.id).one().n).toBe(0));
		}
	});

	it("fences incoming and moving writes, validates part replay and observes new local me guard terms", async () => {
		const r = await rig(), saved = await r.save("local guard"), input = inputFor(saved.id, "me");
		unwrap(await r.ports.account({ op: "begin", id: input.id, nodeId: saved.id, from: "work", to: "me", caller: r.caller }));
		unwrap(await r.ports.profile(r.ref("work"), { op: "fence", id: input.id, nodeId: saved.id, peer: "me" }));
		await r.profile(r.ref("work"), (s) => {
			expect(() => assertWritable(s.sql, saved.id)).toThrow(Fail);
			s.sql.exec("UPDATE transfers SET updated_at=?", new Date(Date.now() - 300001).toISOString());
			expect(dueTransfers(s.sql)).toEqual([input.id]);
		});
		const p = unwrap(await r.ports.profile(r.ref("work"), { op: "pack", id: input.id }));
		const bytes = unwrap(await r.ports.profile(r.ref("work"), { op: "part", id: input.id, n: 1 }));
		await r.profile(r.ref("me"), (s) => s.sql.exec("INSERT INTO guard_terms (term,source,added_at,seq) VALUES ('fixture','work',?,1)", new Date().toISOString()));
		const land: TransferStep = { op: "land", id: input.id, from: "work", nodeId: saved.id, n: 1, of: p.parts!, payload: bytes.payload!, sha256: bytes.sha256!, bundle: p.sha256!, revision: 1, terms: [] };
		expect(await r.ports.profile(r.ref("me"), land)).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		expect(await r.ports.profile(r.ref("personal"), { ...land, sha256: "0".repeat(64) })).toMatchObject({ ok: false, error: { details: { reason: "part_hash" } } });
	});
});

describe("transfer bounds, links, vectors and late guards", () => {
	const ctx = (r: Awaited<ReturnType<typeof rig>>, hash: string) => ({ actor: "owner" as const, platform: "test", routedBy: "explicit", payloadHash: hash, userId: r.caller.userId });

	it("moves a large journal in several bounded parts and commit steps, byte for byte", async () => {
		const r = await rig(), saved = await r.save("big journal", "work", "start");
		await r.profile(r.ref("work"), (s) => {
			for (let i = 0; i < 150; i++) runWrite(s, r.ref("work"), { op: "append", args: { memory_id: saved.id, content: `entry ${i} ${"x".repeat(9000)}`, request_id: `big:${i}` } }, ctx(r, `a${i}`));
		});
		const before = await r.profile(r.ref("work"), (s) => readContent(s.sql, saved.id));
		const calls: Record<string, number> = {};
		const counted: TransferPorts = { account: r.ports.account, profile: async (ref, cmd) => { calls[cmd.op] = (calls[cmd.op] ?? 0) + 1; return r.ports.profile(ref, cmd); } };
		// Every step runs in BudgetTx, which throws past 1,000 rows or 1 MB, so success means each transaction stayed inside both.
		unwrap(await driveTransfer(counted, inputFor(saved.id), r.caller));
		expect(calls.land).toBeGreaterThan(2);
		expect(calls.commit).toBeGreaterThan(2);
		expect(await r.profile(r.ref("personal"), (s) => readContent(s.sql, saved.id))).toBe(before);
		await r.onAccount((s) => expect(s.sql.exec("SELECT count(*) AS n FROM request_index WHERE profile = 'personal'").one().n).toBe(1));
		await r.profile(r.ref("personal"), (s) => expect(s.sql.exec("SELECT count(*) AS n FROM requests WHERE node_id = ?", saved.id).one().n).toBe(151));
	});

	it("keeps a link's target, reason and evidence through two moves, and moves vectors to the new generation", async () => {
		const r = await rig(), m = await r.save("mover"), b = await r.save("anchor");
		await r.profile(r.ref("work"), (s) => runWrite(s, r.ref("work"), { op: "knowledge", args: { edges: [
			{ from: { id: m.id }, rel: "relates_to", to: { id: b.id }, reason: "mover builds on anchor", evidence: [{ kind: "url", ref: "https://example.test/1" }] },
			{ from: { id: b.id }, rel: "relates_to", to: { id: m.id }, reason: "anchor points back at mover", evidence: [{ kind: "url", ref: "https://example.test/2" }] },
		] } }, ctx(r, "k")));
		const vec = env.VECTORS as unknown as { upsert(v: unknown[]): Promise<unknown>; _ids(): Promise<string[]> };
		const old = `g${r.ref("work").generation}:${m.id}`;
		await vec.upsert([{ id: old, values: Array.from({ length: 64 }, () => 1), namespace: "fixture" }]);
		unwrap(await driveTransfer(r.ports, inputFor(m.id), r.caller));
		expect(await vec._ids()).not.toContain(old);
		await r.profile(r.ref("personal"), (s) => expect(s.sql.exec("SELECT status, embed_hash FROM nodes WHERE id = ?", m.id).one()).toEqual({ status: "active", embed_hash: null }));
		unwrap(await driveTransfer(r.ports, { ...inputFor(m.id), from: "personal", to: "test" }, r.caller));
		await r.profile(r.ref("test"), (s) => {
			const e = s.sql.exec<{ id: number; dst: string; dst_profile: string; reason: string }>("SELECT id, dst, dst_profile, reason FROM edges WHERE src = ?", m.id).one();
			expect(e).toMatchObject({ dst: b.id, dst_profile: "work", reason: "mover builds on anchor" });
			expect(s.sql.exec("SELECT ref FROM evidence WHERE owner = ?", `e:${e.id}`).one().ref).toBe("https://example.test/1");
		});
		// The link into the moved record stays in its own profile with the same id.
		await r.profile(r.ref("work"), (s) => expect(s.sql.exec("SELECT dst, reason FROM edges WHERE src = ?", b.id).one()).toEqual({ dst: m.id, reason: "anchor points back at mover" }));
	});

	it("aborts after the commit decision when me registers a term before publication, and needs the attestation from a work context", async () => {
		const r = await rig(), saved = await r.save("late term", "work", "mentions Quillfeather once");
		const input = inputFor(saved.id, "me");
		const late: TransferPorts = { account: async (cmd) => {
			// A registration that commits in me after landing and before publish (section 5, rule 3).
			if (cmd.op === "decide" && cmd.outcome === "commit") await r.profile(r.ref("me"), (s) => s.sql.exec("INSERT INTO guard_terms (term, source, added_at, seq) VALUES ('Quillfeather', 'work', ?, 1)", new Date().toISOString()));
			return r.ports.account(cmd);
		}, profile: r.ports.profile };
		expect(await driveTransfer(late, input, r.caller)).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		await r.profile(r.ref("work"), (s) => expect(s.sql.exec("SELECT status FROM nodes WHERE id = ?", saved.id).one().status).toBe("active"));
		await r.profile(r.ref("me"), (s) => expect(s.sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", saved.id).one().n).toBe(0));
		await r.onAccount((s) => expect(s.sql.exec("SELECT state FROM transfers WHERE id = ?", input.id).one().state).toBe("aborted"));
		const other = await r.save("unattested");
		expect(await driveTransfer(r.ports, { ...inputFor(other.id, "me"), companyFree: false }, r.caller)).toMatchObject({ ok: false, error: { code: "me_requires_company_free" } });
		await r.onAccount((s) => expect(s.sql.exec("SELECT count(*) AS n FROM transfers WHERE node_id = ?", other.id).one().n).toBe(0));
	});
});

// The public dispatcher and actual store RPCs exercise the shared wiring, not just the transfer driver.
describe("transfer review regressions through MCP", () => {
	it("keeps a refused transfer refused on retry instead of reporting it started", async () => {
		const c = await contextFor(), request_id = crypto.randomUUID();
		const m = await call<{ memory_id: string }>(c, "save_memory", { name: "refused move", type: "user", description: "fixture", content: "mentions Vexmoor", profile: "personal" });
		await accountStub(env, c.caller.userId).admin({ op: "addSensitiveTerm", term: "Vexmoor" });
		const fresh = await contextFor(), args = { memory_id: m.memory_id, profile: "me", company_free: true, request_id };
		expect(await outcome(fresh, "save_memory", args)).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		expect(await outcome(fresh, "save_memory", args)).toMatchObject({ ok: false, error: { details: { reason: "transfer_aborted" } } });
		expect(await call(fresh, "get_memory", { memory_id: m.memory_id })).toMatchObject({ profile: "personal", status: "active" });
	});

	it("binds before moving and replays one fixed transfer result after later moves", async () => {
		const c = await contextFor(), original = crypto.randomUUID();
		const m = await call<{ memory_id: string }>(c, "save_memory", { name: "transfer request", type: "project", kind: "journal", description: "fixture", profile: "personal", request_id: original });
		expect(await outcome(c, "save_memory", { memory_id: m.memory_id, profile: "test", request_id: original })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		expect(await call(c, "get_memory", { memory_id: m.memory_id })).toMatchObject({ profile: "personal" });
		const request_id = crypto.randomUUID(), args = { memory_id: m.memory_id, profile: "test", request_id };
		const first = await call(c, "save_memory", args);
		expect(await call(c, "save_memory", args)).toEqual(first);
		await call(c, "save_memory", { memory_id: m.memory_id, profile: "work" });
		expect(await call(c, "save_memory", args)).toEqual(first);
		expect(await call(c, "get_memory", { memory_id: m.memory_id })).toMatchObject({ profile: "work" });
	});

	it("refuses both changed and unchanged keyed upserts with evidence while fenced", async () => {
		const c = await contextFor();
		const node = { kind: "component", key: "public-fence", name: "Component", description: "fixture" };
		const made = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { nodes: [node], profile: "personal" });
		const id = made.nodes[0]!.id, ports = transferPorts(env, c.caller.userId), tid = crypto.randomUUID();
		unwrap(await ports.account({ op: "begin", id: tid, nodeId: id, from: "personal", to: "test", caller: c.caller }));
		const from = c.account.profiles.find((p) => p.profile === "personal")!;
		unwrap(await ports.profile(from, { op: "fence", id: tid, nodeId: id, peer: "test" }));
		for (const name of ["Component", "Changed"]) expect(await outcome(c, "record_knowledge", { nodes: [{ ...node, name, evidence: [{ kind: "url", ref: "https://example.test/proof" }] }], profile: "personal" })).toMatchObject({ ok: false, error: { code: "moving" } });
		unwrap(await driveTransfer(ports, { id: tid, nodeId: id, from: "personal", to: "test", context: null, companyFree: false }));
	});

	it("returns a 401-request history through public RPCs and keeps archived edge evidence through two moves", async () => {
		const c = await contextFor();
		const m = await call<{ memory_id: string }>(c, "save_memory", { name: "public long history", type: "project", kind: "journal", description: "fixture", profile: "work", request_id: crypto.randomUUID() });
		for (let i = 0; i < 400; i++) await call(c, "append_memory", { memory_id: m.memory_id, content: "x", separator: "", request_id: crypto.randomUUID() });
		const b = await call<{ memory_id: string }>(c, "save_memory", { name: "public evidence anchor", type: "project", kind: "journal", description: "fixture", profile: "work" });
		await call(c, "record_knowledge", { profile: "work", edges: [{ from: { id: m.memory_id }, rel: "relates_to", to: { id: b.memory_id }, reason: "preserve archived supporting evidence", evidence: [{ kind: "url", ref: "https://example.test/archived" }] }] });
		const ref = c.account.profiles.find((p) => p.profile === "work")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
		await runInDurableObject(stub, (_, state) => state.storage.transactionSync(() => {
			const tx = new BudgetTx(state.storage.sql, nextSeq(state.storage.sql, "profile_meta"), new Date().toISOString());
			const edge = state.storage.sql.exec("SELECT * FROM edges WHERE src = ?", m.memory_id).one();
			archiveRows(tx, 123, "evidence", state.storage.sql.exec("SELECT * FROM evidence WHERE owner = ?", `e:${edge.id}`).toArray(), purgeAfter(tx.now));
			archiveRows(tx, 123, "edges", [edge], purgeAfter(tx.now));
		}));
		await call(c, "save_memory", { memory_id: m.memory_id, profile: "personal" });
		await call(c, "save_memory", { memory_id: m.memory_id, profile: "work" });
		expect(await call(c, "get_memory", { memory_id: m.memory_id })).toMatchObject({ profile: "work", content: "x".repeat(400) });
		await runInDurableObject(stub, (_, state) => state.storage.transactionSync(() => {
			const sql = state.storage.sql;
			const ids = sql.exec<{ id: number }>("SELECT id FROM archive WHERE source IN ('edges','evidence') AND activity_id <> 123").toArray().map((a) => a.id);
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString(), () => {});
			restoreArchived(tx, ids);
			const edge = sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ?", m.memory_id).one();
			expect(sql.exec("SELECT ref FROM evidence WHERE owner = ?", `e:${edge.id}`).one().ref).toBe("https://example.test/archived");
			expect(sql.exec("SELECT count(*) AS n FROM requests WHERE node_id = ?", m.memory_id).one().n).toBe(401);
		}));
	});
});


describe("final review regressions", () => {
const ctx = (r: Awaited<ReturnType<typeof rig>>, h = "h") => ({ actor: "owner" as const, platform: "test", routedBy: "explicit", payloadHash: h, userId: r.caller.userId });
const move = (r: Awaited<ReturnType<typeof rig>>, nodeId: string, from = "work", to = "personal") => driveTransfer(r.ports, { id: crypto.randomUUID(), nodeId, from, to, companyFree: true, context: "work" }, r.caller);
const wipes = (r: Awaited<ReturnType<typeof rig>>): WipePorts => ({account: cmd => r.onAccount(s => wipeAccount(s,cmd)), profile: (ref,step) => r.profile(ref,s=>purgeOrigin(s,env,ref,step))});
async function landFixture(r: Awaited<ReturnType<typeof rig>>, id: string) {
 const tid = crypto.randomUUID(), from = r.ref("work"), to = r.ref("personal");
 unwrap(await r.ports.profile(from,{op:"fence",id:tid,nodeId:id,peer:"personal"}));
 const packed=unwrap(await r.ports.profile(from,{op:"pack",id:tid}));
 const p=unwrap(await r.ports.profile(from,{op:"part",id:tid,n:1}));
 unwrap(await r.ports.profile(to,{op:"land",id:tid,from:"work",nodeId:id,n:1,of:packed.parts!,payload:p.payload!,sha256:p.sha256!,bundle:packed.sha256!,revision:packed.revision!,terms:[]}));
 return tid;
}
describe("C3 independent concrete repros",()=>{
 it("keyed knowledge preserves the fence on changed and evidence-only upserts", async()=>{
  const r=await rig(), ref=r.ref("work");
  const id=await r.profile(ref,s=>String((runWrite(s,ref,{op:"knowledge",args:{nodes:[{kind:"component",key:"moving-key",name:"Original",description:"before"}]}},ctx(r)).result.nodes as {id:string}[])[0]!.id));
  const tid=crypto.randomUUID(); unwrap(await r.ports.profile(ref,{op:"fence",id:tid,nodeId:id,peer:"personal"}));
  await expect(r.profile(ref,s=>runWrite(s,ref,{op:"knowledge",args:{nodes:[{kind:"component",key:"moving-key",name:"Changed",description:"concurrent"}]}},ctx(r,"changed")))).rejects.toMatchObject({failure:{code:"moving"}});
  await expect(r.profile(ref,s=>runWrite(s,ref,{op:"knowledge",args:{nodes:[{kind:"component",key:"moving-key",name:"Original",description:"before",evidence:[{kind:"url",ref:"https://example.test/no-op"}]}]}},ctx(r,"evidence")))).rejects.toMatchObject({failure:{code:"moving"}});
  unwrap(await r.ports.profile(ref,{op:"pack",id:tid}));
 });
 it("include_retired hides incoming content before publication",async()=>{
  const r=await rig(), m=await r.save("incoming secret","work","pending payload"); await landFixture(r,m.id);
  await r.profile(r.ref("personal"),s=>{
   expect(()=>get(s.sql,r.ref("personal"),{target:{name:"incoming secret"},includeRetired:false})).toThrow();
   expect(()=>get(s.sql,r.ref("personal"),{target:{name:"incoming secret"},includeRetired:true})).toThrow();
  });
 });
 it("source request replay omits moved_to",async()=>{
  const r=await rig(), m=await r.save("source replay"); unwrap(await move(r,m.id));
  await r.profile(r.ref("work"),s=>{
   const replay=runWrite(s,r.ref("work"),{op:"save",args:{name:"source replay",request_id:m.request}},ctx(r,sha256("source replay"))).result;
   expect(replay.action).toBe("replayed"); expect(replay).not.toHaveProperty("moved_to"); expect(replay.profile).toBe("work");
  });
 });
 it("returning to an old tombstone drains 401 requests",async()=>{
  const r=await rig(), m=await r.save("large request history");
  await r.profile(r.ref("work"),s=>{for(let i=0;i<400;i++)runWrite(s,r.ref("work"),{op:"append",args:{memory_id:m.id,content:"x",request_id:`${m.id}:${i}`}},ctx(r,`h${i}`));});
  unwrap(await move(r,m.id));
  const back=await move(r,m.id,"personal","work");
  
  expect(back).toMatchObject({ok:true,value:{state:"committed"}});
 });
 it("archived edge evidence restores in the new owner after two moves",async()=>{
  const r=await rig(), m=await r.save("archived evidence"), b=await r.save("evidence anchor");
  await r.profile(r.ref("work"),s=>s.transactionSync(()=>{
   runWrite(s,r.ref("work"),{op:"knowledge",args:{edges:[{from:{id:m.id},rel:"relates_to",to:{id:b.id},reason:"archived supporting link",evidence:[{kind:"url",ref:"https://example.test/archived-proof"}]}]}},ctx(r));
   const tx=new BudgetTx(s.sql,nextSeq(s.sql,"profile_meta"),new Date().toISOString());
   const e=s.sql.exec("SELECT * FROM edges WHERE src=?",m.id).one();
   archiveRows(tx,123,"evidence",s.sql.exec("SELECT * FROM evidence WHERE owner=?",`e:${e.id}`).toArray(),purgeAfter(tx.now));
   archiveRows(tx,123,"edges",[e],purgeAfter(tx.now));
  }));
  unwrap(await move(r,m.id)); unwrap(await move(r,m.id,"personal","test"));
  await r.profile(r.ref("test"),s=>{
   expect(s.sql.exec("SELECT count(*) n FROM archive WHERE source='edges'").one().n).toBe(1);
   expect(s.sql.exec("SELECT count(*) n FROM archive WHERE source='evidence'").one().n).toBe(1);
   s.transactionSync(()=>{
    const ids=s.sql.exec<{id:number}>("SELECT id FROM archive WHERE source IN ('edges','evidence')").toArray().map(x=>x.id);
    const tx=new BudgetTx(s.sql,nextSeq(s.sql,"profile_meta"),new Date().toISOString(),()=>{});
    restoreArchived(tx,ids);
    const edge=s.sql.exec<{id:number}>("SELECT id FROM edges WHERE src=?",m.id).one();
    expect(s.sql.exec("SELECT ref FROM evidence WHERE owner=?",`e:${edge.id}`).one().ref).toBe("https://example.test/archived-proof");
   });
  });
  await r.profile(r.ref("work"),s=>expect(s.sql.exec("SELECT count(*) n FROM archive WHERE source='evidence'").one().n).toBe(1));
 });
 it("knowledge creation refuses the exact id purged from a surviving profile",async()=>{
  const r=await rig(), ref=r.ref("personal");
  const a={nodes:[{kind:"component" as const,key:"purged-key",name:"Component"}]};
  const id=await r.profile(ref,s=>String((runWrite(s,ref,{op:"knowledge",args:a},ctx(r)).result.nodes as {id:string}[])[0]!.id));
  unwrap(await move(r,id,"personal","work")); unwrap(await wipeProfile(env,wipes(r),r.caller,"work","work"));
  await r.profile(ref,s=>{
   expect(s.sql.exec("SELECT count(*) n FROM profile_meta WHERE key=?",`wiped:${id}`).one().n).toBe(1);
   expect(s.sql.exec("SELECT count(*) n FROM nodes WHERE id=?",id).one().n).toBe(0);
   expect(()=>runWrite(s,ref,{op:"knowledge",args:a},ctx(r,"recreate"))).toThrow(Fail);
  });
 });
 it("import refuses a purged id at every step",async()=>{
  const r=await rig(), m=await r.save("import resurrection"); unwrap(await move(r,m.id)); unwrap(await wipeProfile(env,wipes(r),r.caller,"work","work"));
  await r.profile(r.ref("personal"),s=>{
   expect(s.sql.exec("SELECT count(*) n FROM profile_meta WHERE key=?",`wiped:${m.id}`).one().n).toBe(1);
   const rows={texts:[],revisions:[],requests:[]}, h=sha256("import"), part=sha256("part"), partId=`${m.id}:part`;
   const n:ImportNode={id:m.id,kind:"journal",memory_type:"project",scope:"default",name:"Restored",description:"restored payload",why:null,how_to_apply:null,objective:null,steps:null,status:"active",origin:"import",revision:1,chars:0,content_hash:h,valid_from:null,valid_to:null,created_at:null,updated_at:null,source_platform:null,updated_source_platform:null,attrs:{}};
   expect(()=>runImport(s,{op:"stage",record_id:m.id,record_sha256:h,part:1,parts:1,part_id:partId,sha256:part,rows})).toThrow(Fail);
   const c={record_id:m.id,record_sha256:h,node:n,parts:[{part_id:partId,sha256:part}],request_ids:[]};
   expect(()=>runImport(s,{...c,op:"prepare"})).toThrow(Fail); expect(()=>runImport(s,{...c,op:"publish"})).toThrow(Fail);
   expect(s.sql.exec("SELECT 1 FROM nodes WHERE id=?",m.id).toArray()).toHaveLength(0);
  });
 });
 it("a context obtained before close cannot write into the wiping profile",async()=>{
  const c=await contextFor(), account=env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID));
  unwrap(await runInDurableObject(account,(_,s)=>wipeAccount(s.storage,{op:"begin",caller:c.caller,profile:"test",typed:"test"})));
  const out=await outcome(c,"save_memory",{name:"late after close",type:"project",kind:"journal",description:"late write",profile:"test",request_id:crypto.randomUUID()});
  
  expect(out).toMatchObject({ok:false,error:{code:"profile_wiped"}});
 });
});

});


it("D1 lifecycle preserves a partially folded journal through transfer, archive and restoration", async () => {
	const r = await rig(), saved = await r.save("compact lifecycle"), input = inputFor(saved.id);
	await r.profile(r.ref("work"), (s) => {
		const who = r.ref("work"), ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId };
		for (let i = 1; i <= 120; i++) runWrite(s, who, { op: "append", args: { memory_id: saved.id, content: `hiddenentry${i}`, request_id: `life-${i}` } }, { ...ctx, payloadHash: `life-${i}` });
		runWrite(s, who, { op: "save", args: { memory_id: saved.id, compact: { through_seq: 120, summary: "lifecycle summary" }, expected_revision: 121, request_id: "life-compact" } }, { ...ctx, payloadHash: "life-compact" });
		expect(foldStep(s).changed).toBe(100);
		expect(readContent(s.sql, saved.id)).toBe("initiallifecycle summary");
	});
	unwrap(await driveTransfer(r.ports, input, r.caller));
	await r.profile(r.ref("personal"), async (s) => {
		expect(readContent(s.sql, saved.id)).toBe("initiallifecycle summary");
		// Restoration and transfer queue discovery must retain hidden history, including live=2 rows.
		const who = r.ref("personal"), ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId };
		const forgotten = runWrite(s, who, { op: "owner", args: { memory_id: saved.id, action: "forget", request_id: "life-forget" } }, { ...ctx, payloadHash: "life-forget" });
		expect(s.sql.exec("SELECT 1 FROM nodes WHERE id = ?", saved.id).toArray()).toHaveLength(0);
		undo(s, who, Number(forgotten.result.activity_id), ctx);
		expect(readContent(s.sql, saved.id)).toBe("initiallifecycle summary");
		while (foldDue(s.sql)) foldStep(s);
		expect(s.sql.exec("SELECT COUNT(*) n FROM texts WHERE node_id = ? AND part = 'entry'", saved.id).one().n).toBe(120);
		const wipe = { profile: "work", at: new Date().toISOString(), ids: [saved.id], terms: [] };
		let done = false;
		for (let i = 0; i < 100 && !done; i++) {
			const out = unwrap(await purgeOrigin(s, env, who, { op: "purge", wipe }));
			done = "done" in out && out.done;
		}
		expect(done).toBe(true);
		for (const table of ["texts", "revisions", "requests"]) expect(s.sql.exec(`SELECT 1 FROM ${table} WHERE node_id = ?`, saved.id).toArray()).toHaveLength(0);
		expect(s.sql.exec("SELECT undo FROM activity WHERE EXISTS (SELECT 1 FROM json_each(targets) WHERE value = ?) AND undo IS NOT NULL", saved.id).toArray()).toHaveLength(0);
	});
});


describe("C3 accepted intent alarm recovery", () => {
	async function freshContext() {
		const userId = `c3-${crypto.randomUUID().slice(0, 8)}`;
		const account = unwrap(await accountStub(env, userId).context({ kind: "owner", userId }));
		return { env, caller: account.caller, account, platform: "test" };
	}
	async function interrupted(to = "me", job = false, decided = false) {
		const c = await freshContext(), account = env.ACCOUNT.get(env.ACCOUNT.idFromName(c.caller.userId));
		const m = await call<{ memory_id: string }>(c, "save_memory", { name: crypto.randomUUID(), type: "user", description: "mentions Moonthistle", profile: "work" });
		const device = job ? unwrap(await accountStub(env, c.caller.userId).admin({ op: "createDevice", name: `job-${crypto.randomUUID()}`, scopes: ["maintenance"], profiles: ["work", "me"] })) as { id: string } : null;
		const caller: Caller = device ? { userId: c.caller.userId, kind: "device", deviceId: device.id, scopes: ["maintenance"], profiles: ["work", "me"] } : c.caller;
		const input: TransferInput = { id: crypto.randomUUID(), nodeId: m.memory_id, from: "work", to, companyFree: true, context: "work", protect: job };
		const ports = transferPorts(env, c.caller.userId);
		await expect(driveTransfer({ ...ports, account: async (cmd) => {
			const out = await ports.account(cmd);
			if ((!decided && cmd.op === "begin") || (decided && cmd.op === "decide" && cmd.outcome === "commit")) throw new Error("synthetic after account commit");
			return out;
		} }, input, caller)).rejects.toThrow("synthetic");
		const inAccount = <T,>(f: (s: DurableObjectStorage) => T) => runInDurableObject(account, (_, s) => f(s.storage));
		const fire = async () => {
			await inAccount((s) => s.sql.exec("UPDATE transfers SET retry_at = 0 WHERE id = ?", input.id));
			expect(await runDurableObjectAlarm(account)).toBe(true);
		};
		const source = c.account.profiles.find((p) => p.profile === "work")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${source.userId}:work:${source.generation}`));
		return { c, account, input, device, inAccount, fire, stub };
	}

	it.each(["busy", "transport"])("keeps an accepted intent scheduled after recovery %s and completes on the next real alarm", async (fault) => {
		const r = await interrupted("personal");
		let original: unknown;
		if (fault === "busy") await r.inAccount((s) => s.sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'closed')"));
		else await runInDurableObject(r.account, (instance) => {
			original = Reflect.get(instance, "env");
			Reflect.set(instance, "env", { ...env, PROFILE: { idFromName: (n: string) => env.PROFILE.idFromName(n), get: () => ({ transfer: () => { throw new Error("synthetic transport"); } }) } });
		});
		await r.fire();
		await r.inAccount(async (s) => {
			expect(s.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", r.input.id).one()).toMatchObject({ state: "open", retry_at: expect.any(Number) });
			expect(await s.getAlarm()).not.toBeNull();
			s.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'");
		});
		if (original) await runInDurableObject(r.account, (instance) => Reflect.set(instance, "env", original));
		await r.fire();
		expect(await call(r.c, "get_memory", { memory_id: r.input.nodeId })).toMatchObject({ profile: "personal" });
	});

	it("aborts a new me guard refusal, retries interrupted cleanup, and leaves the source writable", async () => {
		const r = await interrupted();
		unwrap(await accountStub(env, r.c.caller.userId).admin({ op: "addSensitiveTerm", term: "Moonthistle" }));
		let original: unknown;
		await runInDurableObject(r.account, (instance) => {
			original = Reflect.get(instance, "env");
			Reflect.set(instance, "env", { ...env, PROFILE: { idFromName: (n: string) => env.PROFILE.idFromName(n), get: (id: DurableObjectId) => {
				const real = env.PROFILE.get(id) as any;
				return { transfer: (who: ProfileRef, step: TransferStep) => { if (step.op === "abort") throw new Error("synthetic cleanup loss"); return real.transfer(who, step); } };
			} } });
		});
		await r.fire();
		await r.inAccount((s) => expect(s.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", r.input.id).one()).toMatchObject({ state: "aborted", retry_at: expect.any(Number) }));
		await runInDurableObject(r.account, (instance) => Reflect.set(instance, "env", original));
		await r.fire();
		await r.inAccount((s) => expect(s.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", r.input.id).one()).toEqual({ state: "aborted", retry_at: null }));
		expect(await call(r.c, "append_memory", { memory_id: r.input.nodeId, content: "still writable", request_id: crypto.randomUUID() })).toMatchObject({ ok: true });
	});

	it.each(["source", "target", "closed", "wiped", "ownership"])("aborts an undecided %s change without touching a replacement generation", async (change) => {
		const r = await interrupted("personal");
		await r.inAccount((s) => {
			if (change === "source" || change === "target") s.sql.exec("UPDATE profiles SET generation = 'replacement' WHERE name = ?", change === "source" ? "work" : "personal");
			if (change === "closed") s.sql.exec("UPDATE profiles SET status = 'retired' WHERE name = 'personal'");
			if (change === "wiped") s.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, '1')", `wiped:${r.input.nodeId}`);
			if (change === "ownership") s.sql.exec("UPDATE node_index SET profile = 'test' WHERE node_id = ?", r.input.nodeId);
		});
		await r.fire();
		await r.inAccount((s) => expect(s.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", r.input.id).one()).toEqual({ state: "aborted", retry_at: null }));
		await runInDurableObject(r.stub, (_, s) => {
			expect(s.storage.sql.exec("SELECT status FROM nodes WHERE id = ?", r.input.nodeId).one().status).toBe("active");
		});
	});

	it.each(["revoked", "expired", "profiles", "scopes", "pinned"])("revalidates an accepted job's %s at the alarm without owner fallback", async (change) => {
		const r = await interrupted("me", true);
		await r.inAccount((s) => {
			if (change === "revoked") s.sql.exec("UPDATE devices SET revoked_at = ?, enabled = 0 WHERE id = ?", new Date().toISOString(), r.device!.id);
			if (change === "expired") s.sql.exec("UPDATE devices SET expires_at = ? WHERE id = ?", new Date(0).toISOString(), r.device!.id);
			if (change === "profiles") s.sql.exec("UPDATE devices SET profiles = '[\"work\"]' WHERE id = ?", r.device!.id);
			if (change === "scopes") s.sql.exec("UPDATE devices SET scopes = '[]' WHERE id = ?", r.device!.id);
		});
		if (change === "pinned") await runInDurableObject(r.stub, (_, s) => s.storage.sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", r.input.nodeId));
		await r.fire();
		await r.inAccount((s) => expect(s.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", r.input.id).one()).toEqual({ state: "aborted", retry_at: null }));
		expect(await call(r.c, "append_memory", { memory_id: r.input.nodeId, content: "still writable", request_id: crypto.randomUUID() })).toMatchObject({ ok: true });
	});

	it("completes a decided job after revocation and preserves interactive-owner moves of pinned records", async () => {
		const r = await interrupted("me", true, true);
		await r.inAccount((s) => s.sql.exec("UPDATE devices SET enabled = 0 WHERE id = ?", r.device!.id));
		await r.fire();
		expect(await call(r.c, "get_memory", { memory_id: r.input.nodeId })).toMatchObject({ profile: "me" });
		const owner = await interrupted("personal");
		await runInDurableObject(owner.stub, (_, s) => s.storage.sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", owner.input.nodeId));
		await owner.fire();
		expect(await call(owner.c, "get_memory", { memory_id: owner.input.nodeId })).toMatchObject({ profile: "personal" });
	});

	it("keeps a terminal abort fenced against a late same-transfer driver and permits a fresh move", async () => {
		const r = await interrupted("personal");
		const ports = transferPorts(env, r.c.caller.userId);
		unwrap(await ports.account({ op: "decide", id: r.input.id, outcome: "abort" }));
		await r.fire();
		const source = r.c.account.profiles.find((p) => p.profile === "work")!;
		// The paused original driver can still send its fence after the abort cleanup has finished.
		expect(unwrap(await ports.profile(source, { op: "fence", id: r.input.id, nodeId: r.input.nodeId, peer: "personal" })).state).toBe("aborted");
		expect(await call(r.c, "append_memory", { memory_id: r.input.nodeId, content: "late fence refused", request_id: crypto.randomUUID() })).toMatchObject({ ok: true });
		const input = { ...r.input, id: crypto.randomUUID() };
		const concurrent = await Promise.all([driveTransfer(ports, input, r.c.caller), driveTransfer(ports, input, r.c.caller)]);
		expect(concurrent).toMatchObject([{ ok: true, value: { state: "committed" } }, { ok: true, value: { state: "committed" } }]);
		await r.inAccount((s) => expect(s.sql.exec("SELECT state FROM transfers WHERE id = ?", input.id).one().state).toBe("committed"));
		expect(await call(r.c, "get_memory", { memory_id: r.input.nodeId })).toMatchObject({ profile: "personal" });
	});

	it.each(["begin", "fence", "unkeyed"])("recovers public save_memory after %s transport failure without caller replay", async (stop) => {
		const c = await freshContext(), account = env.ACCOUNT.get(env.ACCOUNT.idFromName(c.caller.userId));
		const saved = await call<{ memory_id: string }>(c, "save_memory", { name: `automatic-${stop}`, type: "project", description: "fixture", profile: "work" });
		const args = { memory_id: saved.memory_id, profile: "personal", ...(stop === "unkeyed" ? {} : { request_id: crypto.randomUUID() }) };
		const failAccount = stop !== "fence";
		let hit = false;
		const namespace = (ns: DurableObjectNamespace, fail: boolean) => ({
			idFromName: (name: string) => ns.idFromName(name),
			get: (id: DurableObjectId) => {
				const real = ns.get(id) as any;
				return new Proxy(real, { get: (target, key) => key === "transfer" ? async (...a: any[]) => {
					const cmd = a[a.length - 1];
					if (!hit && fail && cmd.op === "fence") { hit = true; throw new Error("synthetic before fence"); }
					const out = await target.transfer(...a);
					if (!hit && fail && cmd.op === "begin") { hit = true; throw new Error("synthetic after begin commit"); }
					return out;
				} : typeof target[key] === "function" ? (...a: any[]) => target[key](...a) : target[key] });
			},
		});
		const broken = { ...c, env: { ...c.env, ACCOUNT: namespace(env.ACCOUNT, failAccount), PROFILE: namespace(env.PROFILE, !failAccount) } as Env };
		await expect(call(broken, "save_memory", args)).rejects.toThrow("synthetic");
		expect(hit).toBe(true);
		const tid = await runInDurableObject(account, async (_, state) => {
			const row = state.storage.sql.exec<{ id: string; state: string }>("SELECT id, state FROM transfers WHERE node_id = ?", saved.memory_id).one();
			expect(row.state).toBe("open");
			expect(wipeAccount(state.storage, { op: "begin", caller: c.caller, profile: "work", typed: "work" })).toMatchObject({ ok: false, error: { code: "moving" } });
			expect.soft(await state.storage.getAlarm()).not.toBeNull();
			return row.id;
		});
		const source = c.account.profiles.find((p) => p.profile === "work")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${source.userId}:work:${source.generation}`));
		await runInDurableObject(stub, (_, state) => expect(state.storage.sql.exec("SELECT 1 FROM transfers WHERE id = ?", tid).toArray()).toHaveLength(0));
		// Due rows model five minutes passing; run the actual registered DO alarm, not the driver helper.
		await runInDurableObject(account, (_, state) => {
			if (state.storage.sql.exec("PRAGMA table_info(transfers)").toArray().some((c) => c.name === "retry_at")) state.storage.sql.exec("UPDATE transfers SET retry_at = 0 WHERE id = ?", tid);
		});
		expect(await runDurableObjectAlarm(account)).toBe(true);
		expect(await call(c, "get_memory", { memory_id: saved.memory_id })).toMatchObject({ profile: "personal", revision: 2 });
		await runInDurableObject(account, (_, state) => {
			expect(state.storage.sql.exec("SELECT state, retry_at FROM transfers WHERE id = ?", tid).one()).toEqual({ state: "committed", retry_at: null });
			expect(state.storage.sql.exec("SELECT count(*) n FROM transfers WHERE node_id = ?", saved.memory_id).one().n).toBe(1);
		});
		if ("request_id" in args) {
			const result = await runInDurableObject(account, (_, state) => JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = ?", `transfer_request:${args.request_id}`).one().value).result);
			expect(result).toMatchObject({ state: "committed", transfer_id: tid, memory_id: saved.memory_id });
			await call(c, "save_memory", { memory_id: saved.memory_id, profile: "test" });
			expect(await call(c, "save_memory", args)).toEqual(result);
			expect(await outcome(c, "save_memory", { ...args, profile: "me" })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		}
	});
});
