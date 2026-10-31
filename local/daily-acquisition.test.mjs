import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { takeLock, dropLock, home, httpServer, LIMITS } from "./agent-memory.mjs";
import { refreshDaily } from "./daily-refresh.mjs";
import { observedAcquisition, defaultAcquisition, canonicalJson as C } from "./daily-acquisition.mjs";
import { inventoryQueries } from "./daily-inventory.mjs";
import { ghReader } from "./pr-upload.mjs";

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
	return { s, state, statePath, namespace, server, get acquisition() { return acquisition; },
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

function defaultFixture() {
	process.env.AGENT_MEMORY_HOME = path.join(root, `default-home-${serial++}`); assert(takeLock());
	const h = home(), profile = "personal", token_file = path.join(h, "fixture-token"), bin = path.join(h, "owned-fake-gh");
	fs.writeFileSync(token_file, "synthetic-only", { mode: 0o600 }); fs.writeFileSync(bin, "synthetic executor only", { mode: 0o700 });
	const ns = path.join(h, "pending/work-refresh", sha(JSON.stringify([origin, profile]))), state = () => JSON.parse(fs.readFileSync(path.join(ns, "state.json"), "utf8"));
	const s = { calls: [], sent: [], binding: null, manifest: null, state: "pending", mutation: null, loss: null, day: "2026-10-30", generation: "g1", device: "d1", unknown: false };
	const file = (name) => path.join(ns, `${s.binding.day}.${s.binding.claim_id}`, name);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, options) => {
		const u = new URL(input); assert.equal(u.origin, origin); assert.equal(options.redirect, "error"); assert(options.signal); s.calls.push(u.pathname);
		if (u.pathname === "/v1/markers") {
			const ctx = { profile, generation: s.generation, device_id: s.device, utc_day: s.day };
			const scope = { version: 1, origin, ...ctx, issued_at: `${s.day}T12:00:00.000Z`, policy_version: H("fixture policy"), github: [{ kind: "owner", name: "synthetic" }], jira: null };
			if (s.scopeChange && s.binding) scope.policy_version = H("different policy");
			if (s.onMarkers) await s.onMarkers();
			return { ok: true, json: async () => ({ profile, refresh_context: ctx, ...(u.searchParams.get("refresh_scope") === "1" ? { refresh_scope: { scope, scope_hash: H(scope) } } : {}) }) };
		}
		if (u.pathname.endsWith("/status")) return s.unknown ? { ok: false, status: 404, json: async () => ({ error: {} }) }
			: { ok: true, json: async () => ({ operation: "status", utc_day: s.day, claim: { ...s.binding, state: s.state }, progress: null }) };
		const body = JSON.parse(options.body), op = u.pathname.endsWith("/claim") ? "claim" : u.pathname.endsWith("/plan") ? "plan" : u.pathname.endsWith("/finish") ? "finish" : "part";
		if (op === "claim") s.binding = { profile, generation: s.generation, device_id: s.device, day: body.day, claim_id: body.claim_id };
		assert.equal(fs.readFileSync(file(op === "part" ? `part-${body.refresh.part}.body` : `${op}.body`), "utf8"), options.body);
		s.sent.push({ op, bytes: options.body }); if (op === "plan") s.manifest = body.manifest_hash;
		if (s.loss === op) { s.loss = null; throw new Error("fixture lost response"); }
		if (op === "part") {
			assert(fs.existsSync(file("plan.receipt.json")));
			const proof = { version: 1, operation: "part", binding: s.binding, manifest_hash: s.manifest, part: body.refresh.part, part_hash: body.refresh.part_hash, body_sha256: sha(options.body),
				items: body.prs.map((w, index) => ({ index, kind: "pr", key: `github:${body.repo.remote.slice("https://github.com/".length)}#${w.number}`, source_revision: w.updated_at, item_hash: H(w), request_id: `upload:${profile}:github:${body.repo.remote.slice("https://github.com/".length)}#${w.number}:${w.updated_at}`,
					payload_hash: H({ operation: "upload_pr", arguments: { item: "pr", repo: body.repo.remote.slice("https://github.com/".length), ...w } }), original_result_hash: H("fixture stored"), original_action: "stored", disposition: "stored", unknown: w.unknown })) };
			return { ok: true, json: async () => ({ refresh: { status: "acknowledged", proof, receipt_hash: H(proof) } }) };
		}
		if (op === "finish") { assert(state().attempt.receipts.length === 0 || fs.existsSync(file("acq.ack-0.json")) || body.outcome !== "done"); s.state = body.outcome; }
		const proof = { version: 1, operation: op, binding: s.binding, request_id: body.request_id, body_sha256: sha(options.body), manifest_hash: op === "claim" ? null : s.manifest, outcome: op === "finish" ? body.outcome : null };
		return { ok: true, json: async () => ({ operation: op, profile, claim: { ...s.binding, state: s.state }, refresh_receipt: { proof, receipt_hash: H(proof) } }) };
	};
	const server = httpServer({ server: origin, token_file });
	const exec = async (executable, args, env) => {
		assert.equal(executable, bin); assert(fs.existsSync(file("claim.receipt.json"))); assert.notEqual(state().attempt.phase, "claim");
		s.calls.push(args[0] === "auth" ? "gh-token" : "gh-read");
		if (s.onExec) await s.onExec(args);
		const attemptDir = path.dirname(file("claim.receipt.json")), intents = fs.readdirSync(attemptDir).filter((n) => /^inventory.intent-\d+\.json$/.test(n)); assert(intents.length > 0);
		if (args[0] === "auth") { assert.deepEqual(args, ["auth", "token", "--hostname", "github.com", "--user", "wrick17"]); assert.equal(env.GH_TOKEN, undefined); return "fixture-token"; }
		assert.equal(env.GH_TOKEN, "fixture-token");
		if (args.at(-1) === ".login") return "wrick17\n";
		const wrap = (v) => `HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, read:org\r\n\r\n${JSON.stringify(v)}`;
		if (args[1] === "user") return wrap({ id: 1, node_id: "U1", login: "wrick17" });
		let response;
		const viewer = { id: "U1", login: "wrick17" };
		if (args.includes(`query=${inventoryQueries.OWNER_REPOS}`)) response = { data: { viewer, repositoryOwner: { id: "O1", login: "synthetic", __typename: "Organization", viewerIsAMember: true,
			repositories: { totalCount: 1, nodes: [{ id: "R1", nameWithOwner: "synthetic/repo", owner: { id: "O1", login: "synthetic" }, viewerPermission: "READ" }], pageInfo: { hasNextPage: false, endCursor: "repo-end" } } } } };
		else { assert(args.includes(`query=${inventoryQueries.REPO_OPEN}`)); const r = prRow(); r.id = "P1"; r.createdAt = "2026-10-29T00:00:00Z"; r.author.id = "U1"; r.reviewRequests.totalCount = 1; r.reviewRequests.nodes[0].requestedReviewer.id = "U1";
			response = { data: { viewer, repository: { id: "R1", nameWithOwner: "synthetic/repo", owner: { id: "O1", login: "synthetic" }, viewerPermission: "READ",
				pullRequests: { totalCount: 1, nodes: [r], pageInfo: { hasNextPage: false, endCursor: "pr-end" } } } } };
		}
		if (s.mutation) s.mutation(response, args); if (s.readLoss) throw new Error("fixture source lost");
		return wrap(response);
	};
	let acquisition;
	const restart = (io = fs) => { acquisition = defaultAcquisition({ profile, origin, server, io, github: { bin, env: { GH_TOKEN: "ambient-not-allowed", GITHUB_TOKEN: "ambient-not-allowed" }, exec } }); };
	restart();
	return { s, file, ns, state, restart, server, exec, bin, acquisition: () => acquisition,
		call: (extra = {}) => refreshDaily({ profile, inventory: "default-v1", acquisition, server, config: { server: origin }, ...extra }),
		close: () => { globalThis.fetch = originalFetch; dropLock(); } };
}

test("default personal actual GH reader, HTTP markers and native client reach durable source ack and done", async () => {
	const f = defaultFixture(); try {
		assert.equal((await f.call()).status, "done"); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim", "plan", "part", "finish"]);
		assert(f.s.calls.indexOf("gh-token") > f.s.calls.indexOf("/v1/refresh/claim"));
		const ack = JSON.parse(fs.readFileSync(f.file("acq.ack-0.json"), "utf8")); assert.equal(ack.native_receipt_sha256, sha(fs.readFileSync(f.file("part-0.receipt.json"), "utf8")));
		const text = fs.readdirSync(path.dirname(f.file("inventory.sources.json"))).filter((n) => n.endsWith(".json")).map((n) => fs.readFileSync(f.file(n), "utf8")).join();
		assert.doesNotMatch(text, /bob@example|syntheticPrivate|never retained|ambient-not-allowed|X-OAuth-Scopes|fixture-token/);
		assert.equal(f.state().attempt, null);
	} finally { f.close(); }
});

test("default personal sealed replay keeps original bytes across midnight without any source reader", async () => {
	const f = defaultFixture(); try {
		f.s.loss = "part"; await assert.rejects(f.call(), /lost response/); const seal = fs.readFileSync(f.file("acq.seal.json"), "utf8");
		const reads = f.s.calls.filter((c) => c.startsWith("gh-")).length; f.s.day = "2026-11-01";
		f.restart(); assert.equal((await f.call()).status, "done"); assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, reads);
		const sends = f.s.sent.filter((x) => x.op === "part"); assert.equal(sends[0].bytes, sends[1].bytes); assert.equal(fs.readFileSync(f.file("acq.seal.json"), "utf8"), seal);
	} finally { f.close(); }
});

test("default personal EOF, identity, predicate, partial and policy errors never seal a prefix", async () => {
	const changes = [
		(r) => r.errors = [{ message: "partial" }],
		(r) => r.data.viewer.id = "other",
		(r) => { if (r.data.repositoryOwner) r.data.repositoryOwner.viewerIsAMember = false; },
		(r) => { if (r.data.repository) r.data.repository.pullRequests.totalCount = 2; },
		(r) => { if (r.data.repository) r.data.repository.pullRequests.pageInfo.hasNextPage = true; },
		(r) => { if (r.data.repository) r.data.repository.pullRequests.nodes[0].updatedAt = "2026-11-01T00:00:00Z"; },
		(r) => { if (r.data.repository) { const row = r.data.repository.pullRequests.nodes[0]; row.author = null; row.reviewRequests.nodes = []; row.reviewRequests.totalCount = 101; row.reviewRequests.pageInfo.hasNextPage = true; } },
		(r) => { if (r.data.repository) r.data.repository.pullRequests.nodes.push(r.data.repository.pullRequests.nodes[0]); },
	];
	for (const change of changes) { const f = defaultFixture(); try {
		f.s.mutation = change; await assert.rejects(f.call()); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]);
		assert(!fs.existsSync(f.file("inventory.sources.json"))); const reads = f.s.calls.length; f.s.mutation = null; f.restart();
		await assert.rejects(f.call(), /preparation_uncertain/); assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, reads === 0 ? 0 : f.s.calls.slice(0, reads).filter((c) => c.startsWith("gh-")).length);
	} finally { f.close(); } }
	const f = defaultFixture(); try { f.s.scopeChange = true; await assert.rejects(f.call(), /inventory_binding/); assert(!f.s.calls.includes("gh-token")); } finally { f.close(); }
});

test("default personal lost read and unknown old claim hold the same context without refetch or reselection", async () => {
	for (const phase of ["read", "claim"]) {
		const f = defaultFixture(); try {
			if (phase === "read") f.s.readLoss = true; else f.s.loss = "claim";
			await assert.rejects(f.call()); const scope = fs.readFileSync(f.file("inventory.scope.json"), "utf8"), reads = f.s.calls.filter((c) => c.startsWith("gh-")).length;
			f.s.readLoss = false; f.s.day = "2026-11-01"; f.restart();
			if (phase === "claim") { f.s.unknown = true; assert.equal((await f.call()).status, "pending"); }
			else await assert.rejects(f.call(), /preparation_uncertain/);
			assert.equal(fs.readFileSync(f.file("inventory.scope.json"), "utf8"), scope); assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, reads); assert.equal(f.s.sent.length, 1);
		} finally { f.close(); }
	}
});

test("default Work is unavailable before fresh claim, while retained explicit Work seals still replay", async () => {
	const f = defaultFixture(); try {
		assert.throws(() => defaultAcquisition({ profile: "work", origin, server: f.server }), /office_unavailable/);
		await assert.rejects(refreshDaily({ profile: "work", inventory: "default-v1", acquisition: f.acquisition(), server: f.server, config: { server: origin } }), /office_unavailable/);
		assert.equal(f.s.calls.length, 0);
	} finally { f.close(); }
	const g = fixture(); try {
		g.s.loss = "part"; await assert.rejects(g.call());
		const acquisition = defaultAcquisition({ profile: "work", origin, server: g.server });
		assert.equal((await refreshDaily({ profile: "work", inventory: "default-v1", acquisition, server: g.server, config: { server: origin } })).status, "done");
	} finally { dropLock(); }
});

test("default personal limits, missing authority and scope/EOF corruption refuse before further effects", async () => {
	for (const corrupt of ["scope", "eof", "sources", "symlink", "generation", "device", "quota"]) {
		const f = defaultFixture(); const beforeLimit = LIMITS.spoolBytes;
		try {
			f.s.loss = "part"; await assert.rejects(f.call()); const sends = f.s.sent.length;
			if (["scope", "eof", "sources"].includes(corrupt)) fs.appendFileSync(f.file(`inventory.${corrupt}.json`), " ");
			if (corrupt === "symlink") { const p = f.file("inventory.eof.json"); fs.renameSync(p, p + ".retained"); fs.symlinkSync(p + ".retained", p); }
			if (corrupt === "generation") f.s.generation = "other"; if (corrupt === "device") f.s.device = "other";
			if (corrupt === "quota") LIMITS.spoolBytes = 1000;
			await assert.rejects((async () => { f.restart(); return f.call(); })()); assert.equal(f.s.sent.length, sends);
		} finally { LIMITS.spoolBytes = beforeLimit; f.close(); }
	}
});

test("default GH guards complete arguments before token lookup and rejects insufficient coverage", async () => {
	const f = defaultFixture(); try {
		f.s.readLoss = true; await assert.rejects(f.call());
		const scope = JSON.parse(fs.readFileSync(f.file("inventory.scope.json"), "utf8"));
		const inventory = { scope, binding: f.s.binding, as_of, selector: scope.github[0], claim_body: fs.readFileSync(f.file("claim.body"), "utf8"), claim_receipt: JSON.parse(fs.readFileSync(f.file("claim.receipt.json"), "utf8")) };
		let calls = 0; const reader = ghReader("synthetic", { inventory, server: f.server, bin: f.bin, exec: async () => { calls++; throw new Error("should not dispatch"); } });
		for (const input of [{ operation: "mutation", namespace: "synthetic", after: null }, { operation: "repoOpen", namespace: "foreign/repo", after: null }, { operation: "identity", namespace: "wrick17", after: "cursor" }, { operation: "identity", namespace: "wrick17", after: null, query: "mutation" }]) await assert.rejects(reader.defaultPage(input));
		assert.equal(calls, 0);
		for (const header of ["X-OAuth-Scopes: public_repo", "X-OAuth-Scopes: repo, read:org\r\nX-GitHub-SSO: partial-results; organizations=1"]) {
			const r = ghReader("synthetic", { inventory, server: f.server, bin: f.bin, exec: async (_bin, args) => args[0] === "auth" ? "synthetic" : args.at(-1) === ".login" ? "wrick17\n" : `HTTP/2.0 200 OK\r\n${header}\r\n\r\n${JSON.stringify({ id: 1, node_id: "U1", login: "wrick17" })}` });
			await assert.rejects(r.defaultPage({ operation: "identity", namespace: "wrick17", after: null }), /gh_inventory_unavailable/);
		}
	} finally { f.close(); }
});

test("default personal direct-owner filtering, explicit cursor EOF and verified empty owner are truthful", async () => {
	for (const empty of [false, true]) {
		const f = defaultFixture(); try {
			f.s.mutation = (r, args) => {
				if (empty && r.data.repositoryOwner) { const c = r.data.repositoryOwner.repositories; c.totalCount = 0; c.nodes = []; }
				if (!empty && r.data.repository) {
					const c = r.data.repository.pullRequests, next = args.includes("after=cursor-1"); c.totalCount = 2;
					const row = c.nodes[0]; row.number = next ? 2 : 1; row.id = next ? "P2" : "P1"; row.author = { __typename: "User", id: "OTHER", login: "other" };
					if (!next) { row.reviewRequests.nodes = [{ requestedReviewer: { __typename: "Team" } }]; row.reviewRequests.totalCount = 1; }
					c.pageInfo = { hasNextPage: !next, endCursor: next ? "end" : "cursor-1" };
				}
			};
			assert.equal((await f.call()).status, "done"); const plan = JSON.parse(f.s.sent.find((x) => x.op === "plan").bytes).parts;
			assert.equal(plan.sources.length, empty ? 0 : 1); assert.equal(plan.frames.length, empty ? 0 : 1);
			if (!empty) assert.equal(JSON.parse(f.s.sent.find((x) => x.op === "part").bytes).prs[0].number, 2);
		} finally { f.close(); }
	}
});

test("default personal new authority publication failures fence every phase and a fresh reader", async () => {
	for (const name of ["inventory.scope", "inventory.context", "inventory.intent-0", "inventory.page-0", "inventory.eof", "inventory.sources"]) {
		for (const phase of ["file", "directory"]) {
			const f = defaultFixture(); const descriptors = new Map(); let published = false, failed = false, sourceReads = 0, sends = 0;
			const io = { ...fs, openSync(p, ...args) { const fd = fs.openSync(p, ...args); descriptors.set(fd, String(p)); return fd; },
				linkSync(from, to) { const r = fs.linkSync(from, to); if (String(to).endsWith(`${name}.json`)) published = true; return r; },
				fsyncSync(fd) { const p = descriptors.get(fd) ?? "";
					if (!failed && (phase === "file" ? p.includes(`${name}.json.`) && p.endsWith(".tmp") : published && fs.fstatSync(fd).isDirectory())) { failed = true; sourceReads = f.s.calls.filter((c) => c.startsWith("gh-")).length; sends = f.s.sent.length; throw new Error("new authority fsync fault"); }
					return fs.fsyncSync(fd); } };
			try { f.restart(io); await assert.rejects(f.call({ io }), /fsync fault/); assert(failed);
				assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, sourceReads); assert.equal(f.s.sent.length, sends);
				assert.throws(() => f.restart(), /publication_failed/); assert.equal(f.s.sent.length, sends);
			} finally { f.close(); }
		}
	}
});

test("default personal quota and 65-repository overflow never become empty or prefix success", async () => {
	for (const limit of ["bytes", "files", "sources"]) {
		const f = defaultFixture(), bytes = LIMITS.spoolBytes, files = LIMITS.spoolFiles;
		try {
			if (limit === "bytes") LIMITS.spoolBytes = 40 * 1024 * 1024; if (limit === "files") LIMITS.spoolFiles = 500;
			if (limit === "sources") f.s.mutation = (r, args) => { if (r.data.repositoryOwner) {
				const c = r.data.repositoryOwner.repositories, next = args.includes("after=repo-next"); c.totalCount = 65;
				c.nodes = Array.from({ length: next ? 15 : 50 }, (_, i) => ({ id: `R${i + (next ? 50 : 0)}`, nameWithOwner: `synthetic/repo-${i + (next ? 50 : 0)}`, owner: { id: "O1", login: "synthetic" }, viewerPermission: "READ" }));
				c.pageInfo = { hasNextPage: !next, endCursor: next ? "end" : "repo-next" };
			} };
			await assert.rejects(f.call(), /storage_full|inventory_limit/); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]);
			if (limit !== "sources") assert(!f.s.calls.includes("gh-token"));
			assert(!fs.existsSync(f.file("inventory.sources.json")));
		} finally { LIMITS.spoolBytes = bytes; LIMITS.spoolFiles = files; f.close(); }
	}
});

test("default personal compound publication/fence failure cannot authorize effects in a fresh failed reader", async () => {
	for (const name of ["inventory.page-0", "inventory.sources"]) {
		const f = defaultFixture(), descriptors = new Map(); let published = false, failed = false;
		const io = { ...fs, openSync(p, ...args) { if (failed && String(p).includes("FAILED.")) throw new Error("fence unavailable"); const fd = fs.openSync(p, ...args); descriptors.set(fd, String(p)); return fd; },
			linkSync(from, to) { const r = fs.linkSync(from, to); if (String(to).endsWith(`${name}.json`)) published = true; return r; },
			fsyncSync(fd) { if (!failed && published && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error("compound directory failure"); } return fs.fsyncSync(fd); } };
		try {
			f.restart(io); await assert.rejects(f.call({ io }), /compound/); assert(failed); const sends = f.s.sent.length, reads = f.s.calls.filter((c) => c.startsWith("gh-")).length;
			assert.throws(() => f.restart({ ...fs, fsyncSync() { throw new Error("fresh sync unavailable"); } }), /fresh sync/);
			assert.equal(f.s.sent.length, sends); assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, reads);
			// A healthy reader may re-establish an entire published resolution, but may never refetch an incomplete chain.
			f.restart();
			if (name === "inventory.sources") assert.equal((await f.call()).status, "done");
			else await assert.rejects(f.call(), /preparation_uncertain/);
			assert.equal(f.s.calls.filter((c) => c.startsWith("gh-")).length, reads);
		} finally { f.close(); }
	}
});

test("default personal resolved-source pointer failure stops before plan and fences a fresh reader", async () => {
	for (const phase of ["file", "directory"]) {
		const f = defaultFixture(), descriptors = new Map(), resolutionWrites = new Set(); let published = false, failed = false;
		const io = { ...fs, openSync(p, ...args) { const fd = fs.openSync(p, ...args); descriptors.set(fd, String(p)); return fd; },
			writeSync(fd, buffer, ...args) { if ((descriptors.get(fd) ?? "").includes("state.json.") && /"sources_sha256":"[0-9a-f]{64}"/.test(String(buffer))) resolutionWrites.add(fd); return fs.writeSync(fd, buffer, ...args); },
			renameSync(from, to) { const r = fs.renameSync(from, to); if (String(to).endsWith("state.json") && JSON.parse(fs.readFileSync(to, "utf8")).attempt?.inventory?.sources_sha256) published = true; return r; },
			fsyncSync(fd) { if (!failed && (phase === "file" ? resolutionWrites.has(fd) : published && fs.fstatSync(fd).isDirectory())) { failed = true; throw new Error("resolution pointer fsync"); } return fs.fsyncSync(fd); } };
		try { f.restart(io); await assert.rejects(f.call({ io }), /pointer fsync/); assert(failed); assert.deepEqual(f.s.sent.map((x) => x.op), ["claim"]);
			const reads = f.s.calls.length; assert.throws(() => f.restart(), /publication_failed/); assert.equal(f.s.calls.length, reads);
		} finally { f.close(); }
	}
});

test("default personal credential and page awaits recheck authentic policy and actual lock before further effects", async () => {
	for (const when of ["token", "login", "identity", "owner"]) {
		for (const loss of ["policy", "lock"]) {
			const f = defaultFixture(); let triggered = false;
			try {
				f.s.onExec = async (args) => {
					const matches = when === "token" ? args[0] === "auth" : when === "login" ? args.at(-1) === ".login" : when === "identity" ? args[1] === "user" && args.includes("--include") : args.includes(`query=${inventoryQueries.OWNER_REPOS}`);
					if (!triggered && matches) { triggered = true; await Promise.resolve(); if (loss === "lock") dropLock(); else f.s.scopeChange = true; }
				};
				await assert.rejects(f.call(), loss === "lock" ? /lock_required/ : /daily_inventory_binding/); assert(triggered);
				const reads = f.s.calls.filter((c) => c === "gh-read").length;
				assert.equal(reads, ["token", "login", "identity", "owner"].indexOf(when));
				assert(!fs.existsSync(f.file(when === "owner" ? "inventory.page-1.json" : "inventory.page-0.json")));
				assert(fs.existsSync(f.file(when === "owner" ? "inventory.intent-1.json" : "inventory.intent-0.json")));
				assert(!fs.existsSync(f.file("inventory.sources.json"))); assert.deepEqual(f.s.sent.map((s) => s.op), ["claim"]);
				const binding = f.state().attempt.binding, scope = fs.readFileSync(f.file("inventory.scope.json"), "utf8");
				if (loss === "lock") assert(takeLock());
				f.s.onExec = null; f.s.scopeChange = false; f.s.day = "2026-11-01"; f.restart();
				await assert.rejects(f.call(), /preparation_uncertain/);
				assert.equal(f.s.calls.filter((c) => c === "gh-read").length, reads); assert.deepEqual(f.state().attempt.binding, binding);
				assert.equal(fs.readFileSync(f.file("inventory.scope.json"), "utf8"), scope);
			} finally { f.close(); }
		}
	}
});

test("default personal loses no lock, claim or credential authority through an awaited scope check", async () => {
	for (const loss of ["check-lock", "claim", "credential"]) {
		const f = defaultFixture(); let triggered = false;
		try {
			f.s.onExec = async (args) => {
				if (!triggered && args[0] === "auth") {
					triggered = true; await Promise.resolve();
					if (loss === "check-lock") f.s.onMarkers = async () => { await Promise.resolve(); dropLock(); };
					if (loss === "claim") { const p = path.join(f.ns, "state.json"), held = f.state(); held.attempt.phase = "finish"; fs.writeFileSync(p, JSON.stringify(held), { mode: 0o600 }); }
					if (loss === "credential") throw new Error("synthetic credential unavailable");
				}
			};
			await assert.rejects(f.call()); assert(triggered); assert.equal(f.s.calls.filter((c) => c === "gh-read").length, 0);
			assert(!fs.existsSync(f.file("inventory.page-0.json"))); assert(!fs.existsSync(f.file("inventory.sources.json")));
			assert.deepEqual(f.s.sent.map((s) => s.op), ["claim"]);
		} finally { f.close(); }
	}
});
