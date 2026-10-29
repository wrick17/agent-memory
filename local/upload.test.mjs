// node --test local/upload.test.mjs : the foreground uploader against a fake /v1/import that applies each command once
// and replays it after, as the server does. No network, no real server, no real memory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";
import { sha256, uuid5 } from "../src/domain/ids.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-upload-test-"));
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });
const m = await import("./migrate.mjs");
const u = await import("./upload.mjs");

const dt = { $neo4j: "DateTime", iso: "2026-01-02T03:04:05+00:00" };
const record = (i) => ({ eid: `e${i}`, labels: ["Decision", "Entity"], anchors: [], steps: [], relationships: [], has_revision_links: 0, revisions: [], requests: [],
	props: { name: `Note ${i}`, content: `note ${i}`, _created: dt, _updated: dt, _version: 1 }, fingerprint: { version: 1 }, attempts: 1, bothq_type: "project",
	resolved_scope: "personal", legacy_id: uuid5(`personal:project:note ${i}`) });

/** A planned rehearsal export with `count` records: two commands each, so more than 50 commands make two batches. */
async function plannedExport(count = 30) {
	const dir = fs.mkdtempSync(path.join(tmp, "export-"));
	const records = Array.from({ length: count }, (_, i) => record(i));
	const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
	fs.mkdirSync(path.join(dir, "bothq"));
	fs.mkdirSync(path.join(dir, "markdown"));
	fs.writeFileSync(path.join(dir, "bothq", "records.jsonl"), jsonl(records));
	fs.writeFileSync(path.join(dir, "markdown", "files.jsonl"), "");
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, bothq: { records: count, records_jsonl_sha256: sha256(jsonl(records)) }, markdown: { distinct: 0, files_sha256: sha256("") } }));
	await m.plan({ exportDir: dir, rehearsal: "test" });
	return dir;
}

function config({ rehearsal = true, mode = 0o600 } = {}) {
	fs.mkdirSync(m.migrationDir(), { recursive: true, mode: 0o700 });
	const tokenFile = path.join(m.migrationDir(), "rehearsal.token");
	fs.writeFileSync(tokenFile, "am_imp_testid_SECRET-TOKEN-VALUE\n", { mode });
	fs.chmodSync(tokenFile, mode);
	const file = path.join(m.migrationDir(), "upload.json");
	fs.writeFileSync(file, JSON.stringify({ server: "https://memory-rehearsal.example", token_file: tokenFile, rehearsal }), { mode: 0o600 });
	return file;
}

/** The server's idempotence in miniature: a command applies once, then replays; `script` can lose a response, fail or refuse. */
function fakeServer(script = {}) {
	const applied = new Map();
	const s = { applied, calls: 0, tokens: new Set() };
	s.fetch = async (url, init) => {
		s.calls++;
		s.tokens.add(init.headers.authorization);
		const body = JSON.parse(init.body);
		if (script.fail?.(body.batch)) return new Response("{}", { status: 503 });
		const receipts = body.commands.map((c, index) => {
			if (script.refuse?.(c)) return { index, op: c.op, record_id: c.record_id, status: "refused", reason: "identity_conflict" };
			const seen = applied.get(c.sha256) ?? 0;
			applied.set(c.sha256, seen + 1);
			return { index, op: c.op, record_id: c.record_id ?? c.src, status: seen ? "replayed" : c.op === "stage" ? "stored" : c.op === "finalize" ? "published" : "linked" };
		});
		if (script.lose?.(body.batch)) { script.lose = null; throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); }
		return new Response(JSON.stringify({ receipts }), { status: 200, headers: { "content-type": "application/json" } });
	};
	return s;
}
const noSleep = async () => {};
const firstApply = (s) => [...s.applied.values()].every((x) => x >= 1);

describe("upload", () => {
	it("resends a batch whose response was lost and finishes with every command applied, keeping the token out of its state", async () => {
		const dir = await plannedExport();
		const server = fakeServer({ lose: (b) => b === 1 });
		const r = await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(config()), fetchImpl: server.fetch, sleep: noSleep });
		assert.deepEqual([r.status, r.done, r.batches], ["done", 2, 2]);
		assert.equal(server.applied.size, 60);
		assert.ok(firstApply(server));
		const state = fs.readFileSync(path.join(dir, "plan-rehearsal-test", "upload-memory-rehearsal.example.json"), "utf8");
		assert.equal(fs.statSync(path.join(dir, "plan-rehearsal-test", "upload-memory-rehearsal.example.json")).mode & 0o777, 0o600);
		assert.ok(!state.includes("SECRET-TOKEN-VALUE") && !JSON.stringify(r).includes("SECRET-TOKEN-VALUE"));
		assert.ok(JSON.parse(state).receipts["1"].some((x) => x.status === "replayed"), "the resent batch replayed on the server");
	});

	it("stops after bounded retries, then resumes at the first batch not acknowledged", async () => {
		const dir = await plannedExport();
		const down = fakeServer({ fail: (b) => b === 2 });
		const first = await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(config()), fetchImpl: down.fetch, sleep: noSleep });
		assert.deepEqual([first.status, first.batch, first.failure, first.done], ["stopped", 2, "HTTP 503", 1]);
		assert.equal(down.calls, 1 + 5);
		const up = fakeServer();
		const second = await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(path.join(m.migrationDir(), "upload.json")), fetchImpl: up.fetch, sleep: noSleep });
		assert.equal(second.status, "done");
		assert.equal(up.calls, 1, "batch 1 is not sent again");
	});

	it("stops at a refusal and reports the record and reason, sending nothing after it", async () => {
		const dir = await plannedExport();
		const victim = uuid5("personal:project:note 3");
		const server = fakeServer({ refuse: (c) => c.op === "finalize" && c.record_id === victim });
		const r = await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(config()), fetchImpl: server.fetch, sleep: noSleep });
		assert.deepEqual([r.status, r.batch, r.refused.map((x) => [x.record_id, x.reason])], ["refused", 1, [[victim, "identity_conflict"]]]);
		assert.equal(server.calls, 1);
	});

	it("refuses a changed plan under an old state, a rehearsal plan to another server, and token files others can read", async () => {
		const dir = await plannedExport();
		const cfg = config();
		const server = fakeServer({ fail: () => true });
		await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(cfg), fetchImpl: server.fetch, sleep: noSleep });
		const statePath = path.join(dir, "plan-rehearsal-test", "upload-memory-rehearsal.example.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
		fs.writeFileSync(statePath, JSON.stringify({ ...state, commands_sha256: "0".repeat(64) }));
		await assert.rejects(u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(cfg), fetchImpl: server.fetch, sleep: noSleep }), /plan changed since this upload began/);
		await assert.rejects(u.upload({ exportDir: dir, rehearsal: "test", config: { ...u.loadConfig(cfg), rehearsal: false }, fetchImpl: server.fetch, sleep: noSleep }), /only to the rehearsal server/);
		await assert.rejects(u.upload({ exportDir: dir, rehearsal: null, config: u.loadConfig(cfg), fetchImpl: server.fetch, sleep: noSleep }), /never goes to the rehearsal server/);
		assert.throws(() => u.loadConfig(config({ mode: 0o644 })), /must not be readable by group or others/);
	});
});

// Closure review S1 and S2 (docs/review-sol-import-server-uploader-2026-10-29.md), from the reviewer's probes.
describe("upload closure fixes", () => {
	it("S1: a redirect stops the upload, and the redirect target receives no request, with the real fetch", async () => {
		const dir = await plannedExport(1);
		const file = config();
		let reached = 0;
		const sink = http.createServer((req, res) => { reached++; req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end('{"receipts":[]}'); });
		await new Promise((r) => sink.listen(0, "127.0.0.1", r));
		const redirect = http.createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/v1/import` }); res.end(); });
		await new Promise((r) => redirect.listen(0, "127.0.0.1", r));
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			fs.writeFileSync(file, JSON.stringify({ ...raw, server: `http://127.0.0.1:${redirect.address().port}` }));
			const r = await u.upload({ exportDir: dir, rehearsal: "test", config: u.loadConfig(file), sleep: noSleep });
			assert.deepEqual([r.status, r.done, /redirect refused/.test(r.failure)], ["stopped", 0, true]);
			assert.equal(reached, 0);
		} finally { await Promise.all([new Promise((r) => sink.close(r)), new Promise((r) => redirect.close(r))]); }
	});

	it("S2: a changed batch schedule refuses to resume instead of skipping unsent commands", async () => {
		const dir = await plannedExport();
		const cfg = u.loadConfig(config());
		const first = await u.upload({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeServer({ fail: (b) => b === 2 }).fetch, sleep: noSleep });
		assert.equal(first.done, 1);
		const sub = path.join(dir, "plan-rehearsal-test");
		const batches = m.readJsonl(path.join(sub, "batches.jsonl"));
		fs.writeFileSync(path.join(sub, "batches.jsonl"), [batches[0], { ...batches[1], batch: 1 }].map((x) => JSON.stringify(x)).join("\n") + "\n");
		const next = fakeServer();
		await assert.rejects(u.upload({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: next.fetch, sleep: noSleep }), /batches\.jsonl/);
		assert.equal(next.calls, 0);
		// A valid schedule with a different hash than the state's is refused too, before any acknowledgement is skipped.
		fs.writeFileSync(path.join(sub, "batches.jsonl"), batches.map((x) => JSON.stringify(x)).join("\n") + "\n");
		const statePath = path.join(sub, "upload-memory-rehearsal.example.json");
		fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), batches_sha256: "0".repeat(64) }));
		await assert.rejects(u.upload({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: next.fetch, sleep: noSleep }), /plan changed since this upload began/);
		assert.equal(next.calls, 0);
	});
});
