// node --test local/upload.test.mjs : the foreground uploader against a fake /v1/import that applies each command once
// and replays it after, as the server does. No network, no real server, no real memory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";
import { canonicalJson, normalizeName, sha256, uuid5 } from "../src/domain/ids.ts";
import { identityDigest, textDigest, textRowsDigest, attrsDigest, nodeDigest, requestDigest, requestSource, revisionDigest, rowsDigest } from "../src/domain/import-audit.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-upload-test-"));
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });
const m = await import("./migrate.mjs");
const u = await import("./upload.mjs");

const dt = { $neo4j: "DateTime", iso: "2026-01-02T03:04:05+00:00" };
const record = (i, scope = "personal", content = `note ${i}`) => ({ eid: `e${i}`, labels: ["Decision", "Entity"], anchors: [], steps: [], relationships: [], has_revision_links: 0, revisions: [], requests: [],
	props: { name: `Note ${i}`, content, _created: dt, _updated: dt, _version: 1 }, fingerprint: { version: 1 }, attempts: 1, bothq_type: "project",
	resolved_scope: scope, legacy_id: uuid5(`${scope}:project:note ${i}`) });

/** A planned export with `count` records: two commands each, so more than 50 commands make two batches. */
async function plannedExport(count = 30, rehearsal = "test", scopeOf = () => "personal", contentOf = (i) => `note ${i}`) {
	const dir = fs.mkdtempSync(path.join(tmp, "export-"));
	const records = Array.from({ length: count }, (_, i) => record(i, scopeOf(i), contentOf(i)));
	const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
	fs.mkdirSync(path.join(dir, "bothq"));
	fs.mkdirSync(path.join(dir, "markdown"));
	fs.writeFileSync(path.join(dir, "bothq", "records.jsonl"), jsonl(records));
	fs.writeFileSync(path.join(dir, "markdown", "files.jsonl"), "");
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, bothq: { records: count, records_jsonl_sha256: sha256(jsonl(records)) }, markdown: { distinct: 0, files_sha256: sha256("") } }));
	await m.plan({ exportDir: dir, rehearsal });
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
	it("offers only route-ready unrouted records to the review list, and the owner's assignments come back as a routes file the next plan imports", async () => {
		const dir = await plannedExport(3, null, (i) => (i === 0 ? "personal" : "nowhere-routed"));
		const review = m.readJsonl(path.join(dir, "plan", "review.jsonl"));
		assert.deepEqual(review.map((r) => [r.reasons, !!r.route_binding]), [[["unrouted_scope"], true], [["unrouted_scope"], true]]);
		const cfg = u.loadConfig(config({ rehearsal: false })), sent = [];
		const fetchImpl = async (url, init) => {
			if (init.method === "POST") { const b = JSON.parse(init.body); sent.push(b); return Response.json({ offered: b.items.length }); }
			// The owner assigned both to work; the server returns exactly what was offered, as route entries.
			return Response.json({ routes: sent.flatMap((b) => b.items.map((it) => ({ source: it.source, id: it.id, scope: it.scope, profile: "work", source_sha256: it.source_sha256 }))), next_after: null });
		};
		assert.deepEqual(await u.pushReview({ exportDir: dir, config: cfg, fetchImpl }), { status: "done", offered: 2 });
		assert.deepEqual(sent.map((x) => x.origin), ["work"]); // the owner's legacy imports belong to work unless --origin says otherwise
		assert.ok(!JSON.stringify(sent).includes("note 1") && !JSON.stringify(sent).includes("SECRET")); // metadata only, never content or the token
		await assert.rejects(u.pushReview({ exportDir: dir, config: { ...cfg, rehearsal: true }, fetchImpl }), /routed plan/);
		const out = path.join(m.migrationDir(), "routes.json");
		assert.deepEqual(await u.pullRoutes({ exportDir: dir, config: cfg, out, fetchImpl }), { status: "done", routes: 2, file: out });
		assert.equal(fs.statSync(out).mode & 0o077, 0);
		const r = await m.plan({ exportDir: dir, routes: out });
		assert.equal(r.manifest.reviewed_routes.routes, 2);
		assert.deepEqual(m.readJsonl(path.join(dir, "plan", "review.jsonl")), []);
		assert.deepEqual(m.readJsonl(path.join(dir, "plan", "commands.jsonl")).filter((c) => c.op === "finalize").map((c) => c.profile), ["personal", "work", "work"]);
	});

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

// The read-only audit client against a fake /v1/import/audit that digests what a faithful server would have stored.
describe("upload audit", () => {
	/**
	 * Pages per profile from the plan's own rows. `tamper` changes one stored snapshot byte; `status` changes one stored
	 * node's status without a new revision; `copy` puts a copy of a record into a second profile; `text` changes one stored
	 * text body of the record with that id; `chain` stores another import chain's wrapper hash for every record.
	 */
	function fakeAudit(dir, { sub = "plan-rehearsal-test", tamper, status, copy, paged, hosted, text, chain } = {}) {
		const recs = new Map();
		for (const c of m.readJsonl(path.join(dir, sub, "commands.jsonl"))) {
			if (c.op === "stage") {
				const r = recs.get(c.record_id) ?? { revisions: [], requests: [], texts: [] };
				r.revisions.push(...c.rows.revisions);
				r.requests.push(...c.rows.requests);
				r.texts.push(...c.rows.texts);
				recs.set(c.record_id, r);
			} else if (c.op === "finalize") {
				const published_at = "2026-02-01T00:00:00.000Z";
				Object.assign(recs.get(c.record_id), { profile: c.profile, record_sha256: c.record_sha256, node: c.node, published_at,
					stored: { ...c.node, created_at: c.node.created_at ?? published_at, updated_at: c.node.updated_at ?? published_at } });
			}
		}
		const ids = [...recs.keys()].sort();
		if (tamper !== undefined) { const r = recs.get(ids[tamper]); r.revisions[0] = { ...r.revisions[0], snapshot: `${r.revisions[0].snapshot} ` }; }
		if (status !== undefined) { const r = recs.get(ids[status]); r.stored = { ...r.node, status: "retired" }; }
		if (text !== undefined) { const r = recs.get(text); r.texts[0] = { ...r.texts[0], body: `${r.texts[0].body} ` }; }
		if (chain) for (const [id, r] of recs) r.record_sha256 = sha256(`another chain ${id}`);
		// The server's text cursor is the (part, revision, seq_no, chunk) tuple, compared element by element.
		const textAfter = (x, cursor) => { const k = [x.part, x.revision, x.seq_no, x.chunk]; const i = k.findIndex((v, j) => v !== cursor[j]); return i >= 0 && k[i] > cursor[i]; };
		const rowsIn = (profile) => ids.filter((id) => recs.get(id).profile === profile || (copy && copy.into === profile && id === ids[copy.index]));
		const digestsOf = (r) => ({ revisions: r.revisions.map(revisionDigest).sort((a, b) => a.revision - b.revision),
			requests: r.requests.map((q) => requestDigest({ ...q, source: requestSource(q) })).sort((a, b) => (a.request_id < b.request_id ? -1 : 1)) });
		return async (url, init) => {
			const u = new URL(url), after = u.searchParams.get("after"), profile = u.searchParams.get("profile"), record = u.searchParams.get("record");
			assert.equal([u.pathname, init.redirect, init.method ?? "GET"].join(" "), "/v1/import/audit manual GET");
			if (record) {
				const r = recs.get(record), table=u.searchParams.get("rows"), rows = table==="texts" ? r.texts.map(textDigest) : digestsOf(r)[table], limit = Number(u.searchParams.get("limit"));
				const page = rows.filter((x) => after === null || (table==="texts" ? textAfter(x, JSON.parse(after)) : "revision" in x ? x.revision > Number(after) : x.request_id > after)).slice(0, limit);
				const last = page.at(-1);
				return Response.json({ record_id: record, node_revision: r.stored.revision, ...(r.node.attrs.import_review || table==="texts" ? {record_sha256:r.record_sha256,node_sha256:nodeDigest(r.stored)} : {}), rows: page, next_after: page.length === limit ? table==="texts" ? JSON.stringify([last.part,last.revision,last.seq_no,last.chunk]) : String(last.revision ?? last.request_id) : null });
			}
			// Small pages, as a server stopping at its row bound returns them.
			const page = rowsIn(profile).filter((id) => !after || id > after).slice(0, 7);
			const records = page.map((id) => {
				const r = recs.get(id), d = digestsOf(r), big = paged !== undefined && id === ids[paged];
				// A record over the server's row bound comes with counts only; its rows are on the detail pages.
				return { record_id: id, state: "published", published_at: r.published_at, record_sha256: r.record_sha256, node_sha256: nodeDigest(r.node), ...(big ? { paged: true } : {}),
					node: { revision: r.stored.revision, created_at: r.stored.created_at, updated_at: r.stored.updated_at, row_sha256: nodeDigest(r.stored), ...attrsDigest(r.stored.attrs), ...(r.node.attrs.import_review ? {identity_sha256:identityDigest(r.stored.scope,r.stored.memory_type,normalizeName(r.stored.name))} : {}) },
					revisions: { count: d.revisions.length, sha256: big ? null : rowsDigest(d.revisions), hosted: 0 },
					requests: { count: d.requests.length, sha256: big ? null : rowsDigest(d.requests), hosted: hosted !== undefined && id === ids[hosted] ? 1 : 0 } };
			});
			return Response.json({ profile, records, next_after: page.length === 7 ? page.at(-1) : null });
		};
	}

	it("audits v2 policy text and identity and refuses changed text or page anchors",async()=>{
		const dir=fs.mkdtempSync(path.join(tmp,"policy-export-")),content="untrusted synthetic archive",f={system:"codex",rel:"skills/fixture/SKILL.md",category:"codex_reference_candidate",realpath:"~/fixture/SKILL.md",paths:["~/fixture/SKILL.md"],content,sha256:sha256(content),bytes:Buffer.byteLength(content),utf8:true,birthtime:"2026-01-01T00:00:00Z",mtime:"2026-01-01T00:00:00Z"};
		fs.mkdirSync(path.join(dir,"markdown"));const lines=JSON.stringify(f)+"\n";fs.writeFileSync(path.join(dir,"markdown/files.jsonl"),lines);const manifest={version:1,markdown:{distinct:1,files_jsonl_sha256:sha256(lines),files_sha256:sha256(`${f.realpath}\t${f.sha256}`)}};fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify(manifest));
		const it=m.markdownItem(f,[]),entry={source:it.key,id:it.id,scope:it.node.scope,profile:"work",source_sha256:sha256(canonicalJson(f))},exportHash=sha256(JSON.stringify(manifest)),decision={reference:"synthetic intent",answer:"archive in work",kind:"archival_reference",permitted_ids:[it.id]};
		const routes=path.join(dir,"routes.json"),policy=path.join(dir,"policy.json");fs.writeFileSync(routes,JSON.stringify({version:1,export_manifest_sha256:exportHash,routes:[entry]}),{mode:0o600});fs.writeFileSync(policy,JSON.stringify({version:1,export_manifest_sha256:exportHash,entries:[{...entry,kind:"archival_reference",owner_decision:decision,owner_decision_sha256:sha256(canonicalJson(decision)),profile_review_sha256:sha256("synthetic evidence")}]}),{mode:0o600});
		await m.plan({exportDir:dir,routes,sourcePolicy:policy});const cfg=u.loadConfig(config({rehearsal:false})),fetchImpl=fakeAudit(dir,{sub:"plan"});
		const clean=await u.audit({exportDir:dir,config:cfg,fetchImpl});assert.equal(clean.status,"ok");assert.equal(clean.mismatches.texts,0);assert.equal(clean.mismatches.identity,0);
		const changed=await u.audit({exportDir:dir,config:cfg,fetchImpl:async(url,init)=>{const r=await fetchImpl(url,init),d=await r.json();if(new URL(url).searchParams.get("rows")==="texts")d.rows[0].body_raw_utf8_sha256=sha256("changed");return Response.json(d);}});assert.equal(changed.mismatches.texts,1);
		const raced=await u.audit({exportDir:dir,config:cfg,fetchImpl:async(url,init)=>{const r=await fetchImpl(url,init),d=await r.json();if(new URL(url).searchParams.get("rows")==="texts")d.record_sha256="0".repeat(64);return Response.json(d);}});assert.equal(raced.status,"drift");
		assert.equal(textRowsDigest(m.planRecords(path.join(dir,"plan"))[0].texts.map(textDigest)).length,64);
	});

	it("checks every record's stored text, including none and past chunk 9, and reports another chain's wrapper hash only as provenance", async () => {
		const dir = await plannedExport(12, "test", undefined, (i) => (i === 0 ? "" : i === 1 ? "x".repeat(170000) : `note ${i}`));
		const cfg = u.loadConfig(config()), recs = m.planRecords(path.join(dir, "plan-rehearsal-test"));
		const empty = recs.find((r) => r.texts.length === 0), long = recs.find((r) => r.texts.length === 11);
		assert.ok(empty && long && recs.every((r) => !r.node.attrs.import_review));
		// Text pages of two rows, so the cursor crosses chunk 9 to 10; the record with no text still gets its one empty page.
		const faithful = fakeAudit(dir), reads = [];
		const small = async (url, init) => { const x = new URL(url); if (x.searchParams.get("rows") === "texts") { x.searchParams.set("limit", "2"); reads.push(x.searchParams.get("record")); } return faithful(x, init); };
		const clean = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: small });
		assert.deepEqual([clean.status, clean.mismatches.texts, clean.drift, clean.provenance.record_sha256_other], ["ok", 0, 0, 0]);
		assert.deepEqual([reads.filter((id) => id === empty.id).length, reads.filter((id) => id === long.id).length], [1, 6]);
		const reportPath = path.join(dir, "plan-rehearsal-test", "audit-memory-rehearsal.example.json"), report = () => JSON.parse(fs.readFileSync(reportPath, "utf8"));
		// Another chain's stored wrapper hashes with every stored row equal: the audit passes and lists each hash apart.
		const other = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { chain: true }) });
		assert.deepEqual([other.status, Object.values(other.mismatches).every((n) => n === 0), other.drift, other.provenance.record_sha256_other], ["ok", true, 0, 12]);
		assert.equal(report().mismatches.record, undefined);
		assert.equal(report().provenance.record_sha256.other.observed[long.id], sha256(`another chain ${long.id}`));
		// A matching wrapper hash never stands in for text: one changed stored body fails under either chain.
		for (const chain of [false, true]) {
			const changed = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { chain, text: long.id }) });
			assert.deepEqual([changed.status, changed.mismatches.texts, report().mismatches.texts.ids], ["mismatch", 1, [long.id]]);
		}
	});

	it("passes a faithful server over several pages, and names the one record whose stored bytes changed", async () => {
		const dir = await plannedExport();
		const cfg = u.loadConfig(config());
		const clean = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir) });
		assert.deepEqual([clean.status, clean.records, clean.found, Object.values(clean.mismatches).every((n) => n === 0), clean.drift], ["ok", 30, 30, true, 0]);
		const changed = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { tamper: 3 }) });
		assert.deepEqual([changed.status, changed.mismatches.revisions, changed.mismatches.requests, changed.mismatches.missing], ["mismatch", 1, 0, 0]);
		const reportPath = path.join(dir, "plan-rehearsal-test", "audit-memory-rehearsal.example.json");
		const report = fs.readFileSync(reportPath, "utf8");
		assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
		assert.ok(!report.includes("SECRET-TOKEN-VALUE"));
		const ids = m.readJsonl(path.join(dir, "plan-rehearsal-test", "commands.jsonl")).filter((c) => c.op === "finalize").map((c) => c.record_id).sort();
		assert.deepEqual(JSON.parse(report).mismatches.revisions.ids, [ids[3]]);
	});

	it("reads a record too large for a summary page through its detail pages, and fails on any hosted drift", async () => {
		const dir = await plannedExport();
		const cfg = u.loadConfig(config());
		const ids = m.readJsonl(path.join(dir, "plan-rehearsal-test", "commands.jsonl")).filter((c) => c.op === "finalize").map((c) => c.record_id).sort();
		assert.equal((await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { paged: 2 }) })).status, "ok");
		const changed = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { paged: 2, tamper: 2 }) });
		assert.deepEqual([changed.status, changed.mismatches.revisions], ["mismatch", 1]);
		// A full match is required: a hosted request since the import makes the audit unsuccessful, and names the record.
		const drifted = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { hosted: 4 }) });
		assert.deepEqual([drifted.status, drifted.drift, Object.values(drifted.mismatches).every((n) => n === 0)], ["drift", 1, true]);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "plan-rehearsal-test", "audit-memory-rehearsal.example.json"), "utf8")).drift.ids, [ids[4]]);
	});

	it("refuses a plan that is missing or not the one uploaded, before any request", async () => {
		const dir = await plannedExport();
		const cfg = u.loadConfig(config());
		let calls = 0;
		const counting = async () => { calls++; return Response.json({ records: [], next_after: null }); };
		const state = path.join(dir, "plan-rehearsal-test", "upload-memory-rehearsal.example.json");
		fs.writeFileSync(state, JSON.stringify({ commands_sha256: "0".repeat(64) }), { mode: 0o600 });
		await assert.rejects(u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: counting }), /plan changed since it was uploaded/);
		fs.rmSync(path.join(dir, "plan-rehearsal-test", "commands.jsonl"));
		await assert.rejects(u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: counting }), /commands\.jsonl does not match/);
		assert.equal(calls, 0);
	});

	it("checks null import dates against publication time, not the current stored dates", async () => {
		const dir = await plannedExport(1);
		const source = path.join(dir, "bothq", "records.jsonl"), row = JSON.parse(fs.readFileSync(source, "utf8"));
		row.props._created = null;
		row.props._updated = null;
		const data = `${JSON.stringify(row)}\n`;
		fs.writeFileSync(source, data);
		const manifestFile = path.join(dir, "manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		manifest.bothq.records_jsonl_sha256 = sha256(data);
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		await m.plan({ exportDir: dir, rehearsal: "test" });
		const node = m.readJsonl(path.join(dir, "plan-rehearsal-test", "commands.jsonl")).find((c) => c.op === "finalize").node;
		assert.equal(node.created_at, null);
		assert.equal(node.updated_at, null);
		const cfg = u.loadConfig(config());
		assert.equal((await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir) })).status, "ok");
		for (const field of ["created_at", "updated_at"]) {
			const faithful = fakeAudit(dir);
			// The changed stored row, as the summary and the text page anchor both report it.
			let stored;
			const fetchImpl = async (url, init) => {
				const page = await (await faithful(url, init)).json();
				for (const record of page.records ?? []) {
					stored = { ...node, created_at: record.node.created_at, updated_at: record.node.updated_at, [field]: "2040-12-31T00:00:00Z" };
					record.node = { ...record.node, [field]: stored[field], row_sha256: nodeDigest(stored) };
				}
				if (page.rows) page.node_sha256 = nodeDigest(stored);
				return Response.json(page);
			};
			const changed = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl });
			assert.deepEqual([changed.status, changed.mismatches.node, changed.drift], ["mismatch", 1, 0]);
		}
	});

	it("reports a stored node changed without a new revision, and a copy of a record in a second audited profile", async () => {
		const dir = await plannedExport();
		const cfg = u.loadConfig(config());
		const ids = m.readJsonl(path.join(dir, "plan-rehearsal-test", "commands.jsonl")).filter((c) => c.op === "finalize").map((c) => c.record_id).sort();
		const changed = await u.audit({ exportDir: dir, rehearsal: "test", config: cfg, fetchImpl: fakeAudit(dir, { status: 5 }) });
		assert.deepEqual([changed.status, changed.mismatches.node, changed.drift], ["mismatch", 1, 0]);
		const report = (base, name) => JSON.parse(fs.readFileSync(path.join(base, name, "audit-memory-rehearsal.example.json"), "utf8"));
		assert.deepEqual(report(dir, "plan-rehearsal-test").mismatches.node.ids, [ids[5]]);
		// A routed plan over two profiles; the server holds a copy of one personal record in work as well.
		const routed = await plannedExport(12, null, (i) => (i % 2 ? "sequoia" : "personal"));
		const rcfg = u.loadConfig(config({ rehearsal: false }));
		const personal = m.readJsonl(path.join(routed, "plan", "commands.jsonl")).filter((c) => c.op === "finalize" && c.profile === "personal").map((c) => c.record_id).sort();
		const all = m.readJsonl(path.join(routed, "plan", "commands.jsonl")).filter((c) => c.op === "finalize").map((c) => c.record_id).sort();
		const dup = await u.audit({ exportDir: routed, config: rcfg, fetchImpl: fakeAudit(routed, { sub: "plan", copy: { into: "work", index: all.indexOf(personal[0]) } }) });
		assert.deepEqual([dup.status, dup.records, dup.found, dup.mismatches.extra, dup.mismatches.missing], ["mismatch", 12, 13, 1, 0]);
		assert.deepEqual(report(routed, "plan").mismatches.extra.ids, [`work/${personal[0]}`]);
	});
});
