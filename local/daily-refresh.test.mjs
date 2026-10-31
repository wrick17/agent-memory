import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { refreshDaily } from "./daily-refresh.mjs";
import { takeLock, dropLock, httpServer, LIMITS } from "./agent-memory.mjs";

// Exact canonicalJson convention from domain/ids.ts, supplied by the trusted synthetic acquisition.
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
	? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])])) : v;
const C = (v) => JSON.stringify(sortKeys(v));
const sha = (s) => createHash("sha256").update(s).digest("hex"), H = (v) => sha(C(v));
const config = { server: "https://synthetic.invalid" };
const requiredSources = [{ source_id: "jira-work", kind: "ticket", namespace: "jira:work", selector_hash: H("assigned-open") }];
const as_of = "2026-10-30T12:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-daily-test-"));
let sequence = 0;
function fixture() {
	process.env.AGENT_MEMORY_HOME = path.join(root, `home-${sequence++}`);
	assert(takeLock()); const h = process.env.AGENT_MEMORY_HOME;
	const log = [], s = { day: "2026-10-30", generation: "g1", device_id: "device1", binding: null, manifest: null, state: "pending", fail: null, corrupt: null, prepared: 0, acks: [], lostAck: false };
	const namespace = () => path.join(h, "pending", "work-refresh", sha(JSON.stringify([config.server, "work"])));
	const state = () => JSON.parse(fs.readFileSync(path.join(namespace(), "state.json"), "utf8"));
	const attemptFile = (name) => path.join(namespace(), state().attempt.name, name);
	const acquisition = {
		canonicalJson: C,
		prepareRefresh: async ({ binding, as_of, requiredSources }) => {
			s.prepared++; log.push("prepare");
			const ticket = { key: "SYN-1", kind: "ticket", type: "Task", title: "Résumé synthetic", updated_at: "2026-10-30T11:00:00.000Z", blocked_by: [], blocks: [], related: [], unknown: [] };
			const payload = { profile: "work", as_of, tickets: [ticket] }, part_hash = H({ version: 1, operation: "part", binding, part: 0, source_id: "jira-work", payload });
			const parts = { version: 1, selection_hash: H(requiredSources), as_of, sources: [{ ...requiredSources[0], enumeration_hash: H("synthetic-complete"), observed_items: 1 }],
				frames: [{ part: 0, source_id: "jira-work", kind: "ticket", item_count: 1, part_hash }] };
			const wire_bytes = C({ ...payload, refresh: { day: binding.day, claim_id: binding.claim_id, part: 0, part_hash } });
			return { parts, manifest_hash: H({ version: 1, operation: "plan", binding, parts }), frames: [{ wire_bytes, wire_sha256: sha(wire_bytes),
				items: [{ kind: "ticket", key: "jira:SYN-1", source_revision: ticket.updated_at, base_request_id: `upload:work:jira:SYN-1:${ticket.updated_at}`, item_hash: H(ticket) }] }] };
		},
		checkReceipt: () => true,
		acknowledge: async ({ receipt }) => {
			log.push("ack"); assert(fs.existsSync(attemptFile("part-0.receipt.json"))); assert.equal(state().attempt.receipts[0], sha(C(receipt)));
			s.acks.push(C(receipt)); if (s.lostAck) { s.lostAck = false; throw new Error("lost local acknowledgement"); } return true;
		},
		complete: () => s.acks.length > 0,
	};
	const server = { refresh: async (op, input) => {
		log.push(op);
		if (op === "markers") return { profile: "work", refresh_context: { profile: "work", generation: s.generation, device_id: s.device_id, utc_day: s.day } };
		if (op === "status") { if (s.unknown || !s.binding) throw Object.assign(new Error("unknown"), { status: 404 });
			return { operation: "status", profile: "work", utc_day: s.day, claim: { ...s.binding, state: s.state, reason: null }, progress: null }; }
		const body = JSON.parse(input), st = state().attempt;
		assert.equal(fs.readFileSync(attemptFile(st.pending.body_file), "utf8"), input);
		assert.equal(st.pending.body_sha256, sha(input)); assert.equal(st.pending.method, "POST");
		if (op === "claim") s.binding = { profile: "work", generation: s.generation, device_id: s.device_id, day: body.day, claim_id: body.claim_id };
		if (s.fail === op) { s.fail = null; (s.sent ??= []).push({ op, input }); throw new Error("response lost"); }
		(s.sent ??= []).push({ op, input });
		if (op === "part") {
			assert(fs.existsSync(attemptFile("plan.receipt.json")));
			const ticket = body.tickets[0], part_hash = body.refresh.part_hash;
			const proof = { version: 1, operation: "part", binding: s.binding, manifest_hash: s.manifest, part: 0, part_hash, body_sha256: sha(input), items: [{ index: 0, kind: "ticket", key: "jira:SYN-1",
				source_revision: ticket.updated_at, item_hash: H(ticket), request_id: `upload:work:jira:SYN-1:${ticket.updated_at}`, payload_hash: H("payload"), original_result_hash: H("result"),
				original_action: "stored", disposition: "stored", unknown: [] }] };
			if (s.corrupt) s.corrupt(proof);
			return { refresh: { status: "acknowledged", proof, receipt_hash: H(proof) } };
		}
		if (op === "plan") s.manifest = body.manifest_hash;
		if (op === "finish") s.state = body.outcome;
		const proof = { version: 1, operation: op, binding: s.binding, request_id: body.request_id, body_sha256: sha(input), manifest_hash: op === "claim" ? null : s.manifest, outcome: op === "finish" ? body.outcome : null };
		return { operation: op, profile: "work", claim: { ...s.binding, state: s.state, reason: null }, refresh_receipt: { proof, receipt_hash: H(proof) } };
	} };
	const call = (extra = {}) => refreshDaily({ profile: "work", requiredSources, as_of, acquisition, server, config, ...extra });
	return { s, log, call, state, namespace, attemptFile, acquisition, server, h };
}

it("daily private main flow retains exact bytes and orders intent, receipt and acquisition acknowledgement", async () => {
	const f = fixture(); try {
		assert.equal((await f.call()).status, "done");
		assert.deepEqual(f.log, ["markers", "claim", "prepare", "plan", "part", "ack", "finish"]);
		assert.equal(f.state().attempt, null); assert.equal(f.state().last.outcome, "done");
		assert.equal((await f.call()).status, "skipped");
		assert.equal(f.s.prepared, 1);
	} finally { dropLock(); }
});

it("daily private lost responses replay identical control and part bodies with no recapture", async () => {
	for (const op of ["claim", "plan", "part", "finish"]) {
		const f = fixture(); try {
			f.s.fail = op; await assert.rejects(f.call(), /response lost/);
			assert.equal((await f.call()).status, "done");
			const sends = f.s.sent.filter((x) => x.op === op); assert.equal(sends.length, 2); assert.equal(sends[0].input, sends[1].input);
			assert.equal(f.s.prepared, 1);
		} finally { dropLock(); }
	}
});

it("daily private local ack loss redelivers the durable proof before finish", async () => {
	const f = fixture(); try { f.s.lostAck = true; await assert.rejects(f.call(), /lost local/);
		assert.equal((await f.call()).status, "done"); assert.equal(f.s.acks.length, 2); assert.equal(f.s.acks[0], f.s.acks[1]);
		assert.equal(f.s.sent.filter((x) => x.op === "part").length, 1); assert.equal(f.s.prepared, 1);
	} finally { dropLock(); }
});

it("daily private old D+2 closure uses the old binding before current generation; unknown404 holds", async () => {
	for (const external of ["failed", "abandoned", "unknown"]) {
		const f = fixture(); try { f.s.fail = "plan"; await assert.rejects(f.call()); const before = fs.readFileSync(path.join(f.namespace(), "state.json"));
			f.s.day = "2026-11-01"; f.s.generation = "g2"; f.s.unknown = external === "unknown"; f.s.state = external;
			const sent = f.s.sent.length, r = await f.call(); assert.equal(r.status, external === "unknown" ? "pending" : external);
			assert.equal(f.s.sent.length, sent); if (external === "unknown") assert.deepEqual(fs.readFileSync(path.join(f.namespace(), "state.json")), before);
		} finally { dropLock(); }
	}
});

it("daily private midnight resumes D and device or generation changes never rebind", async () => {
	for (const drift of ["none", "device_id", "generation"]) {
		const f = fixture(); try { f.s.fail = "part"; await assert.rejects(f.call()); const day = f.state().attempt.binding.day; f.s.day = "2026-11-01";
			if (drift !== "none") { f.s[drift] = "other"; await assert.rejects(f.call(), /binding_drift/); }
			else { assert.equal((await f.call()).status, "done"); assert.equal(f.state().last.binding.day, day); }
			assert.equal(f.s.sent.filter((x) => x.op === "claim").length, 1);
		} finally { dropLock(); }
	}
});

it("daily private missing, reordered, flagged or changed item proof never acknowledges", async () => {
	for (const corrupt of [(p) => p.items.pop(), (p) => p.items[0].index++, (p) => p.items[0].item_hash = H("other"), (p) => p.items[0].original_action = "flagged", (p) => p.binding.generation = "g2"]) {
		const f = fixture(); try { f.s.corrupt = corrupt; await assert.rejects(f.call(), /receipt/); assert.equal(f.s.acks.length, 0); assert(!f.log.includes("finish")); }
		finally { dropLock(); }
	}
});

it("daily private actual machine lock is required and tampered or symlinked authority is retained", async () => {
	const f = fixture(); try {
		assert.equal(takeLock(), false); f.s.fail = "part"; await assert.rejects(f.call());
		const wire = f.attemptFile("part-0.body"), original = fs.readFileSync(wire); fs.appendFileSync(wire, " ");
		const sends = f.s.sent.length; await assert.rejects(f.call(), /wire|corrupt/); assert.equal(f.s.sent.length, sends); assert.equal(fs.readFileSync(wire).length, original.length + 1);
	} finally { dropLock(); }
	await assert.rejects(f.call(), /lock_required/);
	const g = fixture(); try { g.s.fail = "part"; await assert.rejects(g.call()); const wire = g.attemptFile("part-0.body"), target = `${wire}.target`;
		fs.renameSync(wire, target); fs.symlinkSync(target, wire); const bytes = fs.readFileSync(target); await assert.rejects(g.call(), /foreign_path/);
		assert.deepEqual(fs.readFileSync(target), bytes); assert(fs.lstatSync(wire).isSymbolicLink());
	} finally { dropLock(); }
});

it("daily private every fsync failure stops effects and a fresh reader cannot trust a failed publication", async () => {
	// Inject once at every sync in the smallest complete flow. Each failed authority remains private and is never deleted.
	const baseline = fixture(); let total = 0;
	try { const io = { ...fs, fsyncSync(fd) { total++; return fs.fsyncSync(fd); } }; await baseline.call({ io }); } finally { dropLock(); }
	let covered = 0;
	for (let nth = 1; nth <= total; nth++) {
		const f = fixture(); let calls = 0, failed = false, sendsAtFailure = 0, acksAtFailure = 0;
		const io = { ...fs, fsyncSync(fd) { if (++calls === nth) { failed = true; sendsAtFailure = f.s.sent?.length ?? 0; acksAtFailure = f.s.acks.length; throw new Error("injected fsync"); } return fs.fsyncSync(fd); } };
		try {
			await assert.rejects(f.call({ io })); assert(failed); covered++;
			assert.equal(f.s.sent?.length ?? 0, sendsAtFailure); assert.equal(f.s.acks.length, acksAtFailure);
			// Fresh module instance, same actual CLI lock. Keep fsync unavailable until authority is explicitly re-established.
			const fresh = (await import(`./daily-refresh.mjs?fresh=${nth}`)).refreshDaily;
			await assert.rejects(fresh({ profile: "work", requiredSources, as_of, acquisition: f.acquisition, server: f.server, config,
				io: { ...fs, fsyncSync() { throw new Error("fresh fsync unavailable"); } } }));
			assert.equal(f.s.sent?.length ?? 0, sendsAtFailure); assert.equal(f.s.acks.length, acksAtFailure);
			if (fs.existsSync(f.namespace()) && fs.readdirSync(f.namespace()).some((n) => n.startsWith("FAILED."))) {
				await assert.rejects(fresh({ profile: "work", requiredSources, as_of, acquisition: f.acquisition, server: f.server, config }), /publication_failed/);
				assert.equal(f.s.sent?.length ?? 0, sendsAtFailure); assert.equal(f.s.acks.length, acksAtFailure);
			}
		} finally { dropLock(); }
	}
	assert.equal(covered, total); assert(total > 80); process.stdout.write(`daily fsync positions checked: ${total}\n`);
});

it("daily private spool limits reserve receipt space and explicit abandonment keeps all bytes", async () => {
	const f = fixture(); const old = LIMITS.spoolBytes;
	try { LIMITS.spoolBytes = 100000; await assert.rejects(f.call(), /storage_full/); assert.equal(f.s.sent?.length ?? 0, 0); }
	finally { LIMITS.spoolBytes = old; dropLock(); }
	const g = fixture(); try { g.s.fail = "part"; await assert.rejects(g.call()); const wire = g.attemptFile("part-0.body"), before = fs.readFileSync(wire);
		assert.equal((await g.call({ outcome: "abandoned", reason: "explicit_test" })).status, "abandoned"); assert.deepEqual(fs.readFileSync(wire), before);
		assert.equal((await g.call()).status, "skipped");
	} finally { dropLock(); }
});

it("daily private closed HTTP seam sends retained bytes with redirect refusal and no arbitrary operation", async () => {
	const f = fixture(), original = globalThis.fetch;
	try {
		const token_file = path.join(f.h, "synthetic-token"); fs.writeFileSync(token_file, "synthetic-only", { mode: 0o600 });
		const calls = []; globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => ({ synthetic: true }) }; };
		const server = httpServer({ ...config, token_file }); const body = "{ \"profile\": \"work\" }\n";
		await server.refresh("claim", body); assert.equal(calls[0].options.body, body); assert.equal(calls[0].options.redirect, "error"); assert(calls[0].options.signal);
		assert.equal(calls[0].url, "https://synthetic.invalid/v1/refresh/claim");
		await assert.rejects(server.refresh("https://other.invalid", body), /operation/);
		await assert.rejects(server.refresh("part", {}), /bytes_required/);
		await server.refresh("status", { profile: "work", day: "2026-10-30", claim_id: "synthetic" }); assert.equal(calls[1].options.method, "GET");
		await server.refresh("markers", { profile: "work" }); assert.equal(calls[2].url, "https://synthetic.invalid/v1/markers?profile=work");
		await server.refresh("markers", { profile: "personal", refresh_scope: "1" }); assert.equal(calls[3].url, "https://synthetic.invalid/v1/markers?profile=personal&refresh_scope=1");
		const uncredentialed = httpServer({ ...config, token_file: path.join(f.h, "does-not-exist") });
		for (const q of [{ profile: "work", refresh_scope: false }, { profile: "work", refresh_scope: "0" }, { profile: "work", refresh_scope: "1", extra: "x" }, { refresh_scope: "1" }]) await assert.rejects(uncredentialed.refresh("markers", q), /refresh_query/);
		assert.equal(calls.length, 4);
		for (const profile of ["me", "", "Work", "a_b", "a.b", "a/b", "a b", "a?", "a#", "a\n", "1x", "-x", "a".repeat(13), "é", "a$", "a:"]) {
			await assert.rejects(uncredentialed.refresh("markers", { profile, refresh_scope: "1" }), /refresh_query/);
			await assert.rejects(server.refresh("markers", { profile, refresh_scope: "1" }), /refresh_query/);
		}
		assert.equal(calls.length, 4);
		for (const profile of ["work", "personal", "test", "a1-z"]) {
			await server.refresh("markers", { profile, refresh_scope: "1" });
			assert.equal(new URL(calls.at(-1).url).searchParams.get("profile"), profile);
		}
		for (const profile of ["me", "Work"]) await server.refresh("markers", { profile });
		await server.refresh("status", { profile: "me", day: "2026-10-30", claim_id: "synthetic" });
		assert.equal(calls.length, 11);
	} finally { globalThis.fetch = original; dropLock(); }
});

it("daily private failed pointer publication stays fenced with a fresh healthy reader", async () => {
	const f = fixture(); let renamed = false;
	try {
		const io = { ...fs,
			renameSync(from, to) { const r = fs.renameSync(from, to); if (to.endsWith("state.json") && fs.existsSync(path.join(f.namespace(), "namespace.json"))) renamed = true; return r; },
			fsyncSync(fd) { if (renamed) { renamed = false; throw new Error("post-rename directory fsync"); } return fs.fsyncSync(fd); },
		};
		await assert.rejects(f.call({ io }), /post-rename/);
		assert.equal(f.s.sent?.length ?? 0, 0);
		const fresh = (await import("./daily-refresh.mjs?healthy-after-failed-publication")).refreshDaily;
		await assert.rejects(fresh({ profile: "work", requiredSources, as_of, acquisition: f.acquisition, server: f.server, config }), /publication_failed/);
		assert.equal(f.s.sent?.length ?? 0, 0); assert.equal(f.s.acks.length, 0);
	} finally { dropLock(); }
});

it("daily private failure before a plan and lost failure receipt resume the frozen terminal choice", async () => {
	const f = fixture(); try {
		f.acquisition.prepareRefresh = async () => { throw new Error("synthetic acquisition unavailable"); };
		await assert.rejects(f.call(), /unavailable/); f.s.fail = "finish";
		await assert.rejects(f.call({ outcome: "failed", reason: "source_unavailable" }), /response lost/);
		assert.equal((await f.call()).status, "failed");
		const bodies = f.s.sent.filter((x) => x.op === "finish"); assert.equal(bodies[0].input, bodies[1].input);
		assert(!f.log.includes("part")); assert.equal(f.s.acks.length, 0);
	} finally { dropLock(); }
});

it("daily private counts or pending control responses cannot replace sealed receipts", async () => {
	const f = fixture(); const send = f.server.refresh;
	try {
		f.server.refresh = async (op, body) => {
			const r = await send(op, body);
			if (op === "plan") return { operation: "plan", profile: "work", claim: { ...f.s.binding, state: "pending" }, refresh: { status: "pending", reason: "descriptor" } };
			return r;
		};
		await assert.rejects(f.call(), /control_receipt/); assert(!f.log.includes("part"));
		f.server.refresh = send; assert.equal((await f.call()).status, "done"); assert.equal(f.s.prepared, 1);
	} finally { dropLock(); }
});

it("daily private accepted hash vector fixes operation, binding, Unicode and wire domains", () => {
	const binding = { profile: "work", generation: "synthetic-g1", device_id: "synthetic-device", day: "2026-10-30", claim_id: "synthetic-claim" };
	const payload = { profile: "work", as_of, tickets: [{ key: "SYN-1", kind: "ticket", type: "Task", title: "Résumé synthetic", updated_at: "2026-10-30T11:00:00.000Z", blocked_by: [], blocks: [], related: [], unknown: [] }] };
	const part_hash = H({ version: 1, operation: "part", binding, part: 0, source_id: "jira-work", payload });
	assert.equal(part_hash, "ea7f604fb059bdc3540a98586fb42644b596148e8ee6ff9f199046b44b769076");
	const wire = C({ ...payload, refresh: { day: binding.day, claim_id: binding.claim_id, part: 0, part_hash } });
	assert.equal(Buffer.byteLength(wire), 382); assert.equal(sha(wire), "1e8873ad1c6c3811027ab17b5d6bb84929b6b14b28c488dba8ae2e8ba276d0e4");
});

it("daily private unavailable acquisition cannot fabricate an empty plan or model readiness", async () => {
	const f = fixture(); try {
		let models = 0;
		await assert.rejects(f.call({ acquisition: null, runner: { available: true, run() { models++; } } }), /acquisition_unavailable/);
		assert.equal(f.log.length, 0); assert.equal(models, 0);
		f.acquisition.prepareRefresh = async () => { throw new Error("synthetic inventory incomplete"); };
		await assert.rejects(f.call(), /incomplete/); assert.deepEqual(f.log, ["markers", "claim"]); assert.equal(f.s.acks.length, 0);
	} finally { dropLock(); }
});

it("daily private midnight or prior-busy no-reservation proof retires only the unaccepted intent", async () => {
	for (const why of ["day_mismatch", "prior_refresh_pending"]) {
		const f = fixture(); const send = f.server.refresh;
		try {
			f.server.refresh = async (op, body) => { if (op === "claim") throw Object.assign(new Error("synthetic no reservation"), { noReservation: why }); return send(op, body); };
			assert.equal((await f.call()).reason, why); assert.equal(f.state().attempt, null); assert.equal(f.s.prepared, 0);
			assert.equal(f.state().last, null); f.s.day = "2026-11-01"; f.server.refresh = send;
			assert.equal((await f.call()).status, "done"); assert.equal(f.state().last.binding.day, "2026-11-01");
		} finally { dropLock(); }
	}
});

it("daily private missing or foreign namespace authority refuses without repair", async () => {
	for (const anomaly of ["state", "namespace", "mode", "files"]) {
		const f = fixture(); const limit = LIMITS.spoolFiles;
		try {
			f.s.fail = "part"; await assert.rejects(f.call()); const before = f.s.sent.length;
			if (anomaly === "state") fs.writeFileSync(path.join(f.namespace(), "state.json"), "{malformed");
			if (anomaly === "namespace") fs.renameSync(path.join(f.namespace(), "namespace.json"), path.join(f.namespace(), "retained-namespace.json"));
			if (anomaly === "mode") fs.chmodSync(f.attemptFile("part-0.body"), 0o644);
			if (anomaly === "files") LIMITS.spoolFiles = 1;
			await assert.rejects(f.call()); assert.equal(f.s.sent.length, before); assert.equal(f.s.acks.length, 0);
		} finally { LIMITS.spoolFiles = limit; dropLock(); }
	}
});
