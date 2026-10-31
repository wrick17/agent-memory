import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { takeLock, dropLock, home } from "./agent-memory.mjs";
import { refreshDaily } from "./daily-refresh.mjs";
import { observedAcquisition, canonicalJson as C } from "./daily-acquisition.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex"), H = (v) => sha(C(v));
const origin = "https://synthetic.invalid", as_of = "2026-10-30T12:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "am-selected-acquisition-")); let serial = 0;
const prSource = { source_id: "github-selected", kind: "pr", namespace: "synthetic/repo", selector_hash: H("synthetic explicit selected PR read, not default inventory") };
const jiraSource = { source_id: "jira-selected", kind: "ticket", namespace: "jira:work", selector_hash: H("synthetic explicit selected keys, not assigned inventory") };
const prRow = (number = 1, changes = {}) => ({ number, title: "Résumé bob@example.com token=syntheticPrivate", state: "OPEN", updatedAt: "2026-10-30T11:00:00Z", headRefName: "branch", repository: { nameWithOwner: "Synthetic/Repo" },
	author: { login: "WRICK17", __typename: "User" }, reviews: { nodes: [{ state: "APPROVED", author: { login: "Reviewer" }, body: "never retained" }], pageInfo: { hasNextPage: false } },
	commits: { nodes: [{ commit: { oid: "a".repeat(40) } }], pageInfo: { hasNextPage: false } }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
	reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "WRICK17" } }], pageInfo: { hasNextPage: false } }, ...changes });
const ticketRow = (key = "SYN-1", changes = {}) => ({ key, fields: { summary: "Synthetic contact bob@example.com", issuetype: { name: "Bug" }, updated: "2026-10-30T16:30:00+0530",
	status: { name: "In progress", statusCategory: { key: "indeterminate" } }, priority: null, duedate: null, assignee: { accountId: "synthetic-owner", emailAddress: "never@example.com" },
	reporter: null, issuelinks: [], ...changes } });
const selected = () => [
	{ source: prSource, account: "wrick17", owner: "wrick17", requested: [1], rows: [prRow()] },
	{ source: jiraSource, account: "~/.claude", owner: "synthetic-owner", requested: ["SYN-1"], rows: [ticketRow()] },
];
function fixture(sources = selected(), profile = "work") {
	process.env.AGENT_MEMORY_HOME = path.join(root, `home-${serial++}`); assert(takeLock());
	const namespace = path.join(home(), "pending/work-refresh", sha(JSON.stringify([origin, profile]))), stateFile = path.join(namespace, "state.json");
	const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
	const statePath = (name) => path.join(namespace, `${s.binding.day}.${s.binding.claim_id}`, name);
	const s = { binding: null, manifest: null, sent: [], loss: null, mutate: null, receipts: [], terminal: false };
	const server = { refresh: async (op, input) => {
		if (op === "markers") return { profile, refresh_context: { profile, generation: "g1", device_id: "d1", utc_day: "2026-10-30" } };
		if (op === "status") return { operation: "status", profile, utc_day: "2026-11-01", claim: { ...s.binding, state: s.terminal ? "done" : "pending" }, progress: null };
		const b = JSON.parse(input); s.sent.push({ op, input });
		if (op === "claim") s.binding = { profile, generation: "g1", device_id: "d1", day: b.day, claim_id: b.claim_id };
		if (op === "plan") s.manifest = b.manifest_hash;
		if (s.loss === op) { s.loss = null; throw new Error("synthetic response lost"); }
		if (op === "part") {
			const kind = b.prs ? "pr" : "ticket", rows = b.prs ?? b.tickets;
			// Independent expected server arguments: the existing normalizers already emit UTC, redacted and sorted fields.
			const items = rows.map((w, index) => {
				const key = kind === "pr" ? `github:synthetic/repo#${w.number}` : `jira:${w.key}`;
				const args = { item: kind, ...(kind === "pr" ? { repo: "synthetic/repo" } : {}), ...w };
				const payload_hash = H({ operation: `upload_${kind}`, arguments: args });
				return { index, kind, key, source_revision: w.updated_at, item_hash: H(w), request_id: `upload:${profile}:${key}:${w.updated_at}`,
					payload_hash, original_result_hash: sha(C({ action: "stored", key, synthetic: true })), original_action: "stored", disposition: "stored", unknown: w.unknown };
			});
			const proof = { version: 1, operation: "part", binding: { ...s.binding }, manifest_hash: s.manifest, part: b.refresh.part, part_hash: b.refresh.part_hash, body_sha256: sha(input), items };
			if (s.mutate) s.mutate(proof);
			const receipt = { proof, receipt_hash: H(proof) }; s.receipts.push(receipt);
			return { refresh: { status: "acknowledged", ...receipt } };
		}
		if (op === "finish") {
			assert(state().attempt.receipts.length === 0 || fs.existsSync(statePath(`acq.ack-${state().attempt.receipts.length - 1}.json`)));
			s.terminal = true;
		}
		const proof = { version: 1, operation: op, binding: s.binding, request_id: b.request_id, body_sha256: sha(input), manifest_hash: op === "claim" ? null : s.manifest, outcome: op === "finish" ? b.outcome : null };
		return { operation: op, profile, claim: { ...s.binding, state: s.terminal ? b.outcome : "pending" }, refresh_receipt: { proof, receipt_hash: H(proof) } };
	} };
	let acquisition = observedAcquisition({ profile, origin, sources });
	const requiredSources = sources?.map((s) => s.source) ?? [prSource, jiraSource];
	return { s, state, statePath, namespace, get acquisition() { return acquisition; },
		restart: (nextSources, io) => { acquisition = observedAcquisition({ profile, origin, sources: nextSources, ...(io ? { io } : {}) }); },
		call: (extra = {}) => refreshDaily({ profile, requiredSources, as_of, acquisition, server, config: { server: origin }, ...extra }) };
}

test("daily acquisition selected PR and ticket pages traverse the real client and durable source acknowledgements", async () => {
	const f = fixture(); try {
		assert.equal((await f.call()).status, "done"); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim", "plan", "part", "part", "finish"]);
		const plan = JSON.parse(f.s.sent.find((x) => x.op === "plan").input).parts;
		assert.equal(plan.sources.length, 2); assert.deepEqual(plan.frames.map((x) => x.item_count), [1, 1]);
		const files = fs.readdirSync(path.dirname(f.statePath("acq.seal.json"))).map((n) => path.join(path.dirname(f.statePath("acq.seal.json")), n));
		const data = files.filter((n) => n.endsWith(".json") || n.endsWith(".body")).map((n) => fs.readFileSync(n, "utf8")).join();
		assert.doesNotMatch(data, /bob@example|syntheticPrivate|never retained|never@example/);
		for (let i = 0; i < 2; i++) { const ack = JSON.parse(fs.readFileSync(f.statePath(`acq.ack-${i}.json`), "utf8")); assert.equal(ack.native_receipt_sha256, sha(C(f.s.receipts[i]))); assert.equal(ack.receipt_hash, f.s.receipts[i].receipt_hash);
			assert.equal(fs.readFileSync(f.statePath(`part-${i}.receipt.json`), "utf8"), C(f.s.receipts[i])); }
		assert.equal(f.state().attempt, null);
	} finally { dropLock(); }
});

test("daily acquisition retained replay ignores newer source input and pure methods perform no filesystem or dispatch", async () => {
	const f = fixture(); try {
		f.s.loss = "part"; await assert.rejects(f.call(), /response lost/); const original = fs.readFileSync(f.statePath("acq.seal.json"), "utf8");
		const newer = selected(); newer[0].rows = [prRow(1, { title: "newer must not replace original" })];
		let reads = 0; const io = { ...fs, readFileSync(...args) { reads++; return fs.readFileSync(...args); } };
		f.restart(newer, io); assert.equal((await f.call()).status, "done");
		assert.equal(fs.readFileSync(f.statePath("acq.seal.json"), "utf8"), original);
		const parts = f.s.sent.filter((x) => x.op === "part"); assert.equal(parts[0].input, parts[1].input);
		const record = JSON.parse(original), before = reads;
		assert(f.acquisition.checkReceipt({ binding: f.s.binding, frame: record.plan.frames[0], receipt: f.s.receipts[0] }));
		assert(f.acquisition.complete({ binding: f.s.binding, parts: record.plan.parts, receipts: f.s.receipts.map((r) => sha(C(r))) }));
		assert.equal(reads, before);
		assert(!f.acquisition.complete({ binding: { ...f.s.binding, generation: "other" }, parts: record.plan.parts, receipts: f.s.receipts.map((r) => sha(C(r))) }));
		assert(!f.acquisition.checkReceipt({ binding: { ...f.s.binding, device_id: "other" }, frame: record.plan.frames[0], receipt: f.s.receipts[0] }));
	} finally { dropLock(); }
});

test("daily acquisition preserves honest unknown fields and rejects forged normalized authority", async () => {
	for (const corrupt of [null, (p) => p.items[0].payload_hash = H("wrong normalized payload"), (p) => p.items[0].unknown = [], (p) => p.items[0].original_action = "replayed", (p) => p.items[0].original_result_hash = "missing"]) {
		const sources = selected(); sources[0].rows[0].reviews.pageInfo.hasNextPage = true;
		const f = fixture(sources); try {
			f.s.mutate = corrupt;
			if (corrupt) { await assert.rejects(f.call(), /acquisition_receipt|item_receipt/); assert(!fs.existsSync(f.statePath("acq.ack-0.json"))); }
			else { assert.equal((await f.call()).status, "done"); assert.deepEqual(f.s.receipts[0].proof.items[0].unknown, ["reviews"]); }
		} finally { dropLock(); }
	}
});

test("daily acquisition missing, invalid, future, foreign-account or over-cap observations never seal a prefix", async () => {
	const cases = [
		(s) => s[1].rows.pop(), (s) => s[1].rows[0].fields.updated = "invalid", (s) => s[0].rows[0].updatedAt = "2026-11-01T00:00:00Z",
		(s) => s[0].account = "other", (s) => s[1].owner = "bad email@example.com", (s) => { s[0].requested = Array.from({ length: 1601 }, (_, i) => i + 1); s[0].rows = s[0].requested.map((i) => prRow(i)); },
	];
	for (const change of cases) {
		const sources = selected(); change(sources); const f = fixture(sources);
		try { await assert.rejects(f.call()); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]); assert(!fs.existsSync(f.statePath("acq.seal.json"))); }
		finally { dropLock(); }
	}
});

test("daily acquisition durable preparation start prevents restart recapture after an invalid read", async () => {
	const broken = selected(); broken[1].rows = []; const f = fixture(broken);
	try {
		await assert.rejects(f.call(), /incomplete/); assert(fs.existsSync(f.statePath("acq.started.json")));
		f.restart(selected()); await assert.rejects(f.call(), /preparation_uncertain/);
		assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]); assert(!fs.existsSync(f.statePath("acq.seal.json")));
	} finally { dropLock(); }
});

test("daily acquisition rejects early/conflicting acknowledgement and recovers durable ack after local response loss", async () => {
	const f = fixture(); try {
		const ack = f.acquisition.acknowledge; let lost = true;
		f.acquisition.acknowledge = (input) => { const r = ack(input); if (lost) { lost = false; throw new Error("local ack response lost"); } return r; };
		await assert.rejects(f.call(), /local ack/); const held = fs.readFileSync(f.statePath("acq.ack-0.json"), "utf8");
		f.restart(); assert.equal((await f.call()).status, "done"); assert.equal(fs.readFileSync(f.statePath("acq.ack-0.json"), "utf8"), held);
		assert.equal(f.s.sent.filter((x) => x.op === "part").length, 2);
		const receipt = structuredClone(f.s.receipts[0]); receipt.proof.items[0].payload_hash = H("other"); receipt.receipt_hash = H(receipt.proof);
		assert.throws(() => f.acquisition.acknowledge({ binding: f.s.binding, part: 0, receipt }), /ack_invalid/);
	} finally { dropLock(); }
});

test("daily acquisition fsync failure at source ack stops delivery and healthy fresh reader stays fenced", async () => {
	const f = fixture(); let triggered = false; const fdNames = new Map();
	try {
		const io = { ...fs, openSync(name, ...args) { const fd = fs.openSync(name, ...args); fdNames.set(fd, String(name)); return fd; },
			fsyncSync(fd) { if (!triggered && /acq\.ack-0\.json\..*\.tmp$/.test(fdNames.get(fd) ?? "")) { triggered = true; throw new Error("source ack fsync"); } return fs.fsyncSync(fd); } };
		f.restart(selected(), io); await assert.rejects(f.call(), /source ack fsync/); assert(triggered); assert.equal(f.state().attempt.delivered, 0);
		assert(!f.s.sent.some((x) => x.op === "finish")); assert.throws(() => f.restart(), /publication_failed/);
	} finally { dropLock(); }
});

test("daily acquisition no default inventory, Jira personal scope or missing lock is accepted", async () => {
	const f = fixture(undefined); try {
		f.restart(); await assert.rejects(f.call(), /inventory_unavailable/); assert(!fs.existsSync(f.statePath("acq.seal.json")));
	} finally { dropLock(); }
	assert.throws(() => observedAcquisition({ profile: "work", origin, sources: selected() }), /lock_required/);
	const g = fixture(selected(), "personal"); try { await assert.rejects(g.call(), /reader_binding/); assert(!g.s.sent.some((x) => x.op === "part")); }
	finally { dropLock(); }
});

test("daily acquisition preserves explicit personal PR routing and holds the 65th frame", async () => {
	const f = fixture(selected().slice(0, 1), "personal");
	try { assert.equal((await f.call()).status, "done"); assert(f.s.sent.filter((x) => x.op === "part").every((x) => JSON.parse(x.input).profile === "personal")); }
	finally { dropLock(); }
	const sources = selected(); sources[0].requested = Array.from({ length: 1600 }, (_, i) => i + 1); sources[0].rows = sources[0].requested.map((i) => prRow(i));
	const g = fixture(sources); try { await assert.rejects(g.call(), /frame_limit/); assert.deepEqual(g.s.sent.map((x) => x.op), ["claim"]); assert(!fs.existsSync(g.statePath("acq.seal.json"))); }
	finally { dropLock(); }
});

test("daily acquisition refuses source acknowledgement before native receipt publication", async () => {
	const f = fixture(); try {
		f.s.mutate = (proof) => {
			const receipt = { proof, receipt_hash: H(proof) };
			assert.throws(() => f.acquisition.acknowledge({ binding: f.s.binding, part: proof.part, receipt }), /native_receipt_required/);
			assert(!fs.existsSync(f.statePath(`acq.ack-${proof.part}.json`)));
		};
		assert.equal((await f.call()).status, "done");
	} finally { dropLock(); }
});

test("daily acquisition canonical encoder matches the accepted operation/device/Unicode vector", () => {
	const binding = { profile: "work", generation: "synthetic-g1", device_id: "synthetic-device", day: "2026-10-30", claim_id: "synthetic-claim" };
	const payload = { profile: "work", as_of, tickets: [{ key: "SYN-1", kind: "ticket", type: "Task", title: "Résumé synthetic", updated_at: "2026-10-30T11:00:00.000Z", blocked_by: [], blocks: [], related: [], unknown: [] }] };
	const part_hash = H({ version: 1, operation: "part", binding, part: 0, source_id: "jira-work", payload });
	assert.equal(part_hash, "ea7f604fb059bdc3540a98586fb42644b596148e8ee6ff9f199046b44b769076");
	assert.equal(sha(C({ ...payload, refresh: { day: binding.day, claim_id: binding.claim_id, part: 0, part_hash } })), "1e8873ad1c6c3811027ab17b5d6bb84929b6b14b28c488dba8ae2e8ba276d0e4");
});

test("daily acquisition refuses an oversized single observation without sealing an empty or partial plan", async () => {
	const sources = selected(); sources[0].rows[0].closingIssuesReferences.nodes = [{ number: 1, url: `https://github.com/${"a".repeat(910000)}/repo/issues/1` }];
	const f = fixture(sources); try { await assert.rejects(f.call(), /item_too_large/); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]); assert(!fs.existsSync(f.statePath("acq.seal.json"))); }
	finally { dropLock(); }
});

test("daily acquisition collapses exact repeated observations and holds conflicting duplicates", async () => {
	for (const conflict of [false, true]) {
		const sources = selected(); sources[0].rows.push(prRow(1, conflict ? { title: "conflicting reread" } : {})); const f = fixture(sources);
		try {
			if (conflict) { await assert.rejects(f.call(), /observation_conflict/); assert(!f.s.sent.some((x) => x.op === "plan")); }
			else { assert.equal((await f.call()).status, "done"); const plan = JSON.parse(f.s.sent.find((x) => x.op === "plan").input); assert.equal(plan.parts.sources[0].observed_items, 1); }
		} finally { dropLock(); }
	}
});


test("daily acquisition matches server cleaning after clipping PR and Jira title redaction", async () => {
	for (const kind of ["pr", "ticket"]) {
		const sources = kind === "pr" ? selected().slice(0, 1) : selected().slice(1);
		const title = "x".repeat(230) + " token=x".repeat(3);
		if (kind === "pr") sources[0].rows[0].title = title; else sources[0].rows[0].fields.summary = title;
		const f = fixture(sources);
		try {
			f.s.mutate = (proof) => {
				const body = JSON.parse(f.s.sent.at(-1).input), wire = (body.prs ?? body.tickets)[0];
				assert.equal(wire.title.length, 280); assert(wire.title.endsWith("token=[REDACTED"));
				const args = { item: kind, ...(kind === "pr" ? { repo: "synthetic/repo" } : {}), ...wire, title: `${wire.title}]` };
				assert.equal(args.title.length, 281);
				proof.items[0].payload_hash = H({ operation: `upload_${kind}`, arguments: args });
			};
			assert.equal((await f.call()).status, "done");
			assert(fs.existsSync(f.statePath("part-0.receipt.json"))); assert(fs.existsSync(f.statePath("acq.ack-0.json")));
			assert.equal(f.s.sent.filter((x) => x.op === "part").length, 1);
		} finally { dropLock(); }
	}
});
