import { enqueue, next, complete } from "../src/profile/maintenance";
import { reviewedMarkdown } from "./fixtures/source-policy";
// The staged BothQ import through the real /v1/import endpoint, Workers SQLite Durable Objects and AccountStore
// (docs/import-implementation.md). Synthetic records only; the part shapes are the real largest parts' lengths, no text.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalJson, newMemoryId, sha256 } from "../src/domain/ids";
import { pack, PART_OVERHEAD, type Table } from "../src/domain/import-cost";
import { legacyRequestHash } from "../src/domain/legacy";
import { migrate } from "../src/storage";
import { PROFILE_MIGRATIONS } from "../src/profile/schema";
import { runWrite } from "../src/profile/write";
import { ACCOUNT_MIGRATIONS } from "../src/account/schema";
import historicalShapes from "./fixtures/import-historical-shapes.json";
import shapes from "./fixtures/import-part-shapes.json";
import { call, contextFor, deviceToken, outcome } from "./helpers";

const origin = new URL(env.RESOURCE_URL).origin;
const AT = "2026-03-01T00:00:00+00:00";
type Row = Record<string, unknown>;

async function post(token: string, payload: unknown, raw?: string) {
	const res = await exports.default.fetch(new Request(`${origin}/v1/import`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: raw ?? JSON.stringify(payload) }));
	return { status: res.status, data: await res.json() as { receipts: { op: string; status: string; reason?: string; rows_written?: number; bytes?: number }[] } };
}
const send = (token: string, commands: unknown[]) => post(token, { commands });

function node(id: string, over: Row = {}): Row {
	return { id, kind: "journal", memory_type: "project", scope: "personal", name: `Journal ${id.slice(0, 8)}`, description: "imported journal", why: null, how_to_apply: null,
		objective: null, steps: null, status: "active", origin: "import", revision: 1, chars: 0, content_hash: "0".repeat(64), valid_from: null, valid_to: null,
		created_at: AT, updated_at: AT, source_platform: "codex", updated_source_platform: "codex", attrs: { validity: "unknown", source: { system: "bothq" } }, ...over };
}

/** Stage and finalize commands for one record, packed as the planner packs them (src/domain/import-cost.ts). */
function commandsFor(profile: string, n: Row, rows: [Table, Row][], refresh?: { no: number; base_record_sha256: string; base_revision: number; base_content_hash: string; body_revision?: number }) {
	const parts = pack(rows);
	if(!parts.length) parts.push({rows:{texts:[],revisions:[],requests:[]},cost:{...PART_OVERHEAD}});
	const policy = { ...((n.attrs as Row)?.import_review ? {policy_version:1} : {}), ...(((n.attrs as Row)?.source as Row)?.owner_classification ? {classification_version:1} : {}) };
	const recordSha = sha256(canonicalJson({ profile, node: n, ...(refresh ? { base_record_sha256: refresh.base_record_sha256, refresh: refresh.no } : {}), parts: parts.map((p) => p.rows) }));
	const stages = parts.map((p, i) => {
		const body = { ...policy, op: "stage", record_id: n.id, record_sha256: recordSha, profile, part: i + 1, parts: parts.length, rows: p.rows, cost: p.cost,
			...(refresh ? { refresh: { no: refresh.no, base_record_sha256: refresh.base_record_sha256 } } : {}) };
		return { ...body, part_id: `${n.id}${refresh ? `#r${refresh.no}` : ""}:${recordSha.slice(0, 16)}:${i + 1}`, sha256: sha256(canonicalJson(body)) };
	});
	const fin = { ...policy, op: "finalize", record_id: n.id, record_sha256: recordSha, profile, node: n, parts: stages.map((s) => ({ part_id: s.part_id, sha256: s.sha256 })),
		request_ids: rows.filter(([t]) => t === "requests").map(([, q]) => q.request_id), ...(refresh ? { refresh } : {}) };
	return { stages, finalize: { ...fin, sha256: sha256(canonicalJson(fin)) } };
}
const linkCommand = (src: string, dst: string, profile = "test") => { const l = { op: "link", src, rel: "supersedes", dst, basis: "identifier", profile }; return { ...l, sha256: sha256(canonicalJson(l)) }; };

/** A BothQ journal: a save, then appends, each with its revision and its request, the way memory_store.py records them. */
function journal(id: string, appends: number, entry: (i: number) => string) {
	let content = "start";
	const rows: [Table, Row][] = [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: content, created_at: AT, live: true }]];
	const revisions: Row[] = [{ revision: 1, op: "saved", snapshot: canonicalJson({ content, memory_id: id }), delta: null, request_id: `${id}:r1`, at: AT, content_hash: null, revision_id: `${id}:1`, source_platform: "codex", source_platform_version: "1" }];
	const requests: Row[] = [{ request_id: `${id}:r1`, legacy_op: "save", legacy_hash: sha256("save"), result: canonicalJson({ ok: true, memory_id: id, revision: 1 }), memory_id: id, at: AT, completed_at: AT }];
	for (let i = 0; i < appends; i++) {
		const text = entry(i), rev = i + 2, rid = `${id}:r${rev}`;
		content += `\n${text}`;
		rows.push(["texts", { part: "entry", revision: rev, seq_no: i + 1, chunk: 0, body: text, separator: "\n", request_id: rid, created_at: AT, live: true }]);
		revisions.push({ revision: rev, op: "appended", snapshot: canonicalJson({ memory_id: id, _version: rev }), delta: canonicalJson({ content: text, separator: "\n" }), request_id: rid, at: AT, content_hash: null, revision_id: `${id}:${rev}`, source_platform: "codex", source_platform_version: "1" });
		requests.push({ request_id: rid, legacy_op: "append", legacy_hash: legacyRequestHash("append_memory", { memory_id: id, content: text, separator: "\n" })!, result: canonicalJson({ ok: true, action: "appended", memory_id: id, revision: rev }), memory_id: id, at: AT, completed_at: AT });
	}
	rows.push(...revisions.map((r): [Table, Row] => ["revisions", r]), ...requests.map((q): [Table, Row] => ["requests", q]));
	return { rows, content, revisions: revisions.length, requests: requests as { request_id: string; legacy_hash: string; result: string }[] };
}

const profileSql = async <T,>(profile: string, fn: (sql: SqlStorage) => T) => {
	const ref = (await contextFor()).account.profiles.find((p) => p.profile === profile)!;
	return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)), (_i, s) => fn(s.storage.sql));
};
const accountSql = <T,>(fn: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)), (_i, s) => fn(s.storage.sql));

describe("profile schema v3 and v4", () => {
	it("upgrades a v2 profile in place and keeps every revision, request and activity row", async () => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "personal")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`)), (_i, s) => {
			const sql = s.storage.sql;
			// Put this profile back into its deployed v2 shape, with v2 data, then run the migrations again.
			for (const name of ["recall_daily", "recall_totals", "eval_candidates", "fact_reports", "fact_report_facts", "fact_days", "guidance_injections", "guidance_sessions", "correction_matches"]) sql.exec("DROP TABLE " + name);
			for (const name of ["count_receipt_seal", "count_receipt_delete", "count_activity_expiry"]) sql.exec("DROP TRIGGER " + name);
			for (const name of ["count_dates", "count_person", "count_project", "count_pair_person", "count_pair_project"]) sql.exec("DROP INDEX " + name);
			for (const q of ["ALTER TABLE requests DROP COLUMN commit_meta", "ALTER TABLE edges DROP COLUMN commit_seal", "ALTER TABLE edges DROP COLUMN count_epoch", "ALTER TABLE edges DROP COLUMN count_key"]) sql.exec(q);
			for (const q of ["DROP TRIGGER upload_receipts_gone", "DROP TRIGGER refresh_node_gone", "DROP TRIGGER refresh_archive_gone", "DROP TABLE upload_receipts", "DROP TABLE upload_revisions",
				"DROP TABLE refresh_claims", "DROP TABLE refresh_refs", "DROP TABLE refresh_parts"]) sql.exec(q);
			for (const q of ["DROP TABLE import_refreshes", "DROP TRIGGER nodes_refresh_fence", "ALTER TABLE import_records DROP COLUMN published_revision", "ALTER TABLE import_records DROP COLUMN published_content_hash", "DROP TABLE archive", "DROP TABLE transfers", "DROP TABLE transfer_parts", "ALTER TABLE activity DROP COLUMN redacted"]) sql.exec(q);
			for (const q of ["DROP TRIGGER nodes_import_fence", "DROP TABLE import_records", "DROP TABLE import_parts", "DROP INDEX requests_node", "ALTER TABLE requests DROP COLUMN completed_at", "ALTER TABLE requests DROP COLUMN source", "DROP TABLE revisions"]) sql.exec(q);
			for (const q of PROFILE_MIGRATIONS[0]!.filter((x) => /\brevisions\b/.test(x))) sql.exec(q);
			sql.exec("UPDATE profile_meta SET value = '2' WHERE key = 'schema_version'");
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq) VALUES ('n-v2', 1, 'saved', '{\"content\":\"kept\"}', 'r-v2', 'agent', 'd1', ?, 7)", AT);
			sql.exec("INSERT INTO requests (request_id, op, payload_hash, result, node_id, at, seq) VALUES ('r-v2', 'save_memory', 'h', '{\"ok\":true}', 'n-v2', ?, 7)", AT);
			const act = Number(sql.exec("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'agent', 'saved', 'v2 row', '[\"n-v2\"]', 7) RETURNING id", AT).one().id);
			migrate(s.storage, "profile_meta", PROFILE_MIGRATIONS);
			expect(sql.exec("SELECT value FROM profile_meta WHERE key = 'schema_version'").one().value).toBe(String(PROFILE_MIGRATIONS.length));
			expect(sql.exec("EXPLAIN QUERY PLAN SELECT id FROM archive WHERE activity_id = 1").toArray().map((r) => String(r.detail)).join(" ")).toContain("archive_activity");
			expect(sql.exec("PRAGMA index_list('refresh_refs')").toArray()).toContainEqual(expect.objectContaining({ name: "refresh_refs_request", unique: 1 }));
			expect(sql.exec("EXPLAIN QUERY PLAN SELECT 1 FROM refresh_refs WHERE request_id = 'request' AND claim_id = 'claim'").toArray().map((r) => String(r.detail)).join(" ")).toContain("refresh_refs_request");
			expect(sql.exec("SELECT summary, redacted FROM activity WHERE id = ?", act).one()).toEqual({ summary: "v2 row", redacted: null });
			expect(sql.exec("SELECT node_id, revision, op, snapshot, request_id, actor, device_id, at, seq, delta, revision_id FROM revisions WHERE node_id = 'n-v2'").toArray())
				.toEqual([{ node_id: "n-v2", revision: 1, op: "saved", snapshot: '{"content":"kept"}', request_id: "r-v2", actor: "agent", device_id: "d1", at: AT, seq: 7, delta: null, revision_id: null }]);
			expect(sql.exec("SELECT request_id, payload_hash, result, completed_at FROM requests WHERE request_id = 'r-v2'").one()).toEqual({ request_id: "r-v2", payload_hash: "h", result: '{"ok":true}', completed_at: null });
			// The rebuilt table takes BothQ's operations and keeps its tombstone triggers.
			sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('write_seq', '8')");
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES ('n-v2', 2, 'appended', '{}', 'migration', ?, 8)", AT);
			sql.exec("DELETE FROM revisions WHERE node_id = 'n-v2' AND revision = 2");
			expect(sql.exec("SELECT count(*) AS n FROM deleted_rows WHERE tbl = 'revisions'").one().n).toBe(1);
			// v4's exported tables keep tombstones; transfer parts are control state and keep none.
			const arch = Number(sql.exec("INSERT INTO archive (activity_id, at, purge_after, source, payload, seq) VALUES (?, ?, ?, 'texts', '{}', 8) RETURNING id", act, AT, AT).one().id);
			sql.exec("INSERT INTO transfers (id, node_id, direction, peer, state, created_at, updated_at, seq) VALUES ('t1', 'n-v2', 'out', 'work', 'fenced', ?, ?, 8)", AT, AT);
			sql.exec("INSERT INTO transfer_parts (transfer_id, n, payload, sha256) VALUES ('t1', 1, '{}', 's')");
			for (const q of ["DELETE FROM archive", "DELETE FROM transfers", "DELETE FROM transfer_parts"]) sql.exec(q);
			expect(sql.exec("SELECT tbl, pk FROM deleted_rows WHERE tbl IN ('archive', 'transfers', 'transfer_parts') ORDER BY tbl").toArray()).toEqual([{ tbl: "archive", pk: String(arch) }, { tbl: "transfers", pk: "t1" }]);
		});
	});
});

describe("account schema v1 to v7", () => {
	it("upgrades a v1 account in place and keeps every modern binding as it was", async () => {
		await contextFor();
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)), (_i, s) => {
			const sql = s.storage.sql;
			// Back to the deployed v1 shape, with a v1 binding, then run the migrations again.
			for (const q of ["DROP TABLE eval_runs", "DROP TABLE client_status", "DROP TABLE health", "DROP TABLE review_items", "DROP TABLE refresh_days", "DROP TABLE transfers", "DROP TABLE wipes", "ALTER TABLE request_index DROP COLUMN pending", "ALTER TABLE request_index DROP COLUMN legacy"]) sql.exec(q);
			sql.exec("UPDATE account_meta SET value = '1' WHERE key = 'schema_version'");
			sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES ('v1-binding', 'personal', 'save_memory', 'hash-v1', ?, 1)", AT);
			migrate(s.storage, "account_meta", ACCOUNT_MIGRATIONS);
			expect(sql.exec("SELECT value FROM account_meta WHERE key = 'schema_version'").one().value).toBe("7");
			expect(sql.exec("SELECT request_id, profile, op, payload_hash, at, seq, legacy, pending FROM request_index WHERE request_id = 'v1-binding'").one())
				.toEqual({ request_id: "v1-binding", profile: "personal", op: "save_memory", payload_hash: "hash-v1", at: AT, seq: 1, legacy: 0, pending: 0 });
			sql.exec("INSERT INTO wipes (profile, generations, wiped_at, node_count, marker_key, report, seq) VALUES ('test', '[]', ?, 0, 'k', '{}', 2)", AT);
			sql.exec("INSERT INTO transfers (id, node_id, from_profile, to_profile, state, created_at, seq) VALUES ('t1', 'n1', 'test', 'personal', 'fenced', ?, 2)", AT);
			expect(sql.exec("SELECT intent, retry_at FROM transfers WHERE id = 't1'").one()).toEqual({ intent: null, retry_at: null });
			for (const q of ["DELETE FROM wipes", "DELETE FROM transfers"]) sql.exec(q);
			expect(sql.exec("SELECT tbl, pk FROM deleted_rows WHERE tbl IN ('wipes', 'transfers') ORDER BY tbl").toArray()).toEqual([{ tbl: "transfers", pk: "t1" }, { tbl: "wipes", pk: JSON.stringify(["test", AT]) }]);
		});
	});
});

describe("staged import", () => {
	it("keeps a two-part record invisible until it is published, then reads it back with its history and replays its BothQ requests", async () => {
		const { token } = await deviceToken("import-job", ["import"], ["test"], "test");
		const id = "72ea0e74-aca8-5e4f-b1d3-3878342b6973";
		const j = journal(id, 210, (i) => `entry ${i} é日本語🙂`);
		// The BothQ fixture request (memory_store._prepare), with its stored result: an append to this id.
		const known = { request_id: "r-1", legacy_op: "append", legacy_hash: "9d3c7d543343980cc49ac4c2b002fb1fb58c2a3a2c07210d7e3d05270e9da8fe",
			result: canonicalJson({ action: "appended", memory_id: id, revision: 9, ok: true }), memory_id: id, at: AT, completed_at: AT };
		const n = node(id, { name: "Imported two-part journal", revision: j.revisions, chars: j.content.length });
		const { stages, finalize } = commandsFor("test", n, [...j.rows, ["requests", known]]);
		expect(stages.length).toBeGreaterThan(1);
		const c = await contextFor();
		const first = await send(token, [stages[0]]);
		expect(first.data.receipts[0], JSON.stringify(first.data)).toMatchObject({ status: "stored" });
		expect((await send(token, [stages[0]])).data.receipts[0]!.status).toBe("replayed");
		for (const st of stages.slice(1)) { const r = await send(token, [st]); expect(r.data.receipts[0]!.status, JSON.stringify(r.data)).toBe("stored"); }
		// Staged, not published: no read path sees it, and its request ids neither replay nor run.
		expect(await outcome(c, "get_memory", { memory_id: id, include_retired: true, history: { limit: 5 } })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await outcome(c, "get_memory", { name: "Imported two-part journal", profile: "test" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const off = { ...c, env: { ...c.env, EMBEDDINGS: "off" } };
		expect((await call<{ results: unknown[] }>(off, "recall_memories", { keyword: "entry 7", profile: "test", include_history: true })).results).toHaveLength(0);
		expect((await call<{ results: { memory_id: string }[] }>(c, "recall_memories", { keyword: "", profile: "test", include_history: true })).results.some((r) => r.memory_id === id)).toBe(false);
		expect(await outcome(c, "save_memory", { name: "x", type: "user", description: "y", request_id: "r-1", profile: "test" })).toMatchObject({ ok: false, error: { code: "busy" } });
		const pub = await send(token, [finalize]);
		expect(pub.data.receipts[0]).toMatchObject({ op: "finalize", status: "published" });
		expect((await send(token, [finalize])).data.receipts[0]!.status).toBe("replayed");
		const got = await call<{ content: string; revision: number; origin: string; revisions: { operation: string; snapshot: unknown }[] }>(c, "get_memory", { memory_id: id, content: { complete: true }, history: { limit: 2, before_revision: 3 } });
		expect([got.content, got.revision, got.origin]).toEqual([j.content, j.revisions, "import"]);
		expect(got.revisions.map((r) => [r.operation, r.snapshot])).toEqual([["saved", { content: "start", memory_id: id }], ["appended", { memory_id: id, _version: 2 }]]);
		expect((await call<{ results: { memory_id: string }[] }>(off, "recall_memories", { keyword: "entry 7", profile: "test" })).results.map((r) => r.memory_id)).toContain(id);
		// The same BothQ call replays the original result; a changed one is refused, and neither writes.
		const replay = await call<Record<string, unknown>>(c, "append_memory", { memory_id: id, content: "Entry with ünïcode — and \"quotes\"\nline2\ttab", separator: "\n\n", request_id: "r-1", profile: "test" });
		expect(replay).toMatchObject({ action: "replayed", memory_id: id, revision: 9 });
		expect(await outcome(c, "append_memory", { memory_id: id, content: "changed", separator: "\n\n", request_id: "r-1" })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		const rid = j.requests[100]!;
		expect(await call(c, "append_memory", { memory_id: id, content: "entry 99 é日本語🙂", separator: "\n", request_id: rid.request_id })).toMatchObject({ action: "replayed", revision: 101 });
		expect((await call<{ revision: number }>(c, "get_memory", { memory_id: id })).revision).toBe(j.revisions);
		await profileSql("test", (sql) => {
			expect(sql.exec("SELECT count(*) AS n FROM requests WHERE node_id = ? AND legacy_hash IS NOT NULL", id).one().n).toBe(j.requests.length + 1);
			expect(sql.exec("SELECT result FROM requests WHERE request_id = 'r-1'").one().result).toBe(known.result);
		});
	});

	it("stays inside 1,000 rows and 1,000,000 bytes on the real largest parts' shapes, and the planner's estimate is never below the actual cost", async () => {
		const { token } = await deviceToken("import-shapes", ["import"], ["test"], "test");
		// Text of exactly `bytes` UTF-8 bytes and at most 16,000 UTF-16 units, as a real chunk can be.
		const text = (bytes: number) => bytes <= 16_000 ? "x".repeat(bytes) : "日".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
		const json = (bytes: number) => (bytes ? JSON.stringify({ p: "x".repeat(bytes - 8) }) : null);
		type Shape = { cost: { rows: number; bytes: number }; texts: number[][]; revisions: number[][]; requests: number[] };
		const all = [shapes.maxRows, shapes.maxBytes, ...shapes.journal] as Shape[];
		for (const [k, s] of all.entries()) {
			const id = `00000000-0000-5000-8000-${String(k).padStart(12, "0")}`;
			const rows: [Table, Row][] = [
				...s.texts.map(([entry, live, bytes], i): [Table, Row] => ["texts", { part: entry ? "entry" : "body", revision: i + 1, seq_no: entry ? i + 1 : 0, chunk: entry ? 0 : i, body: text(bytes!), ...(entry ? { separator: "\n", request_id: null } : {}), created_at: AT, live: live === 1 }]),
				...s.revisions.map(([snap, delta], i): [Table, Row] => ["revisions", { revision: i + 1, op: "appended", snapshot: json(snap!)!, delta: json(delta!), request_id: null, at: AT, content_hash: null, revision_id: null, source_platform: null, source_platform_version: null }]),
				...s.requests.map((bytes, i): [Table, Row] => ["requests", { request_id: `${id}:q${i}`, legacy_op: "append", legacy_hash: sha256(`${id}${i}`), result: JSON.stringify({ r: "x".repeat(Math.max(0, bytes - 8)) }), memory_id: id, at: AT, completed_at: AT }]),
			];
			const { stages } = commandsFor("test", node(id), rows);
			expect(stages.length).toBe(1);
			const r = (await send(token, stages)).data.receipts[0]!;
			expect(r.status).toBe("stored");
			expect(r.rows_written!).toBeLessThanOrEqual(1000);
			expect(r.bytes!).toBeLessThanOrEqual(1_000_000);
			expect(stages[0]!.cost.rows).toBeGreaterThanOrEqual(r.rows_written!);
			expect(stages[0]!.cost.bytes).toBeGreaterThanOrEqual(r.bytes!);
		}
		// A part over the budget is refused whole: nothing of it is staged.
		const over = "99999999-0000-5000-8000-000000000000";
		const big: [Table, Row][] = Array.from({ length: 210 }, (_, i): [Table, Row] => ["texts", { part: "entry", revision: i + 1, seq_no: i + 1, chunk: 0, body: `e${i}`, separator: "\n", request_id: null, created_at: AT, live: true }]);
		const body = { op: "stage", record_id: over, record_sha256: "a".repeat(64), profile: "test", part: 1, parts: 1, rows: { texts: big.map(([, t]) => t), revisions: [], requests: [] }, cost: { rows: 1, bytes: 1 } };
		const cmd = { ...body, part_id: `${over}:${"a".repeat(16)}:1`, sha256: sha256(canonicalJson(body)) };
		expect((await send(token, [cmd])).data.receipts[0]).toMatchObject({ status: "refused", reason: "size_budget" });
		await profileSql("test", (sql) => {
			expect(sql.exec("SELECT count(*) AS n FROM texts WHERE node_id = ?", over).one().n).toBe(0);
			expect(sql.exec("SELECT count(*) AS n FROM import_parts WHERE record_id = ?", over).one().n).toBe(0);
		});
	});

	it("binds all 664 requests before publishing and resumes after a crash before or after publication", async () => {
		const { token } = await deviceToken("import-crash", ["import"], ["test"], "test");
		const id = "11111111-2222-5333-8444-555555555555";
		const j = journal(id, 663, (i) => `crash entry ${i}`);
		expect(j.requests.length).toBe(664);
		const { stages, finalize } = commandsFor("test", node(id, { revision: j.revisions, chars: j.content.length }), j.rows);
		for (const s of stages) expect((await send(token, [s])).data.receipts[0]!.status).toBe("stored");
		// A crash after prepare and the first binding batch: the record is still invisible and its ids still refuse new calls.
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "test")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)) as unknown as { importStep(w: unknown, s: unknown): Promise<{ ok: boolean; value: { requests: { request_id: string; op: string; hash: string }[] } }> };
		const fin = { record_id: id, record_sha256: finalize.record_sha256, node: finalize.node, parts: finalize.parts, request_ids: finalize.request_ids };
		const prep = await stub.importStep(ref, { op: "prepare", ...fin });
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)) as unknown as { bindImport(b: unknown): Promise<{ ok: boolean }> };
		expect((await account.bindImport({ profile: "test", recordId: id, requests: prep.value.requests.slice(0, 400) })).ok).toBe(true);
		const c = await contextFor();
		expect(await outcome(c, "append_memory", { memory_id: id, content: "crash entry 1", separator: "\n", request_id: j.requests[2]!.request_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await send(token, [finalize])).data.receipts[0]).toMatchObject({ status: "published" });
		expect(await accountSql((sql) => sql.exec("SELECT count(*) AS n FROM request_index WHERE legacy = 1 AND profile = 'test' AND request_id LIKE ?", `${id}:%`).one().n)).toBe(664);
		// A crash after publication, before the response: the retry replays.
		expect((await send(token, [finalize])).data.receipts[0]!.status).toBe("replayed");
		expect(await call(c, "append_memory", { memory_id: id, content: "crash entry 1", separator: "\n", request_id: j.requests[2]!.request_id })).toMatchObject({ action: "replayed" });
		expect((await call<{ content: string }>(c, "get_memory", { memory_id: id, content: { complete: true } })).content).toBe(j.content);
	});

	it("never lets publication replace a hosted write that took the record's identity meanwhile", async () => {
		const { token } = await deviceToken("import-identity", ["import"], ["test"], "test");
		const id = "33333333-2222-5333-8444-555555555555";
		const j = journal(id, 2, (i) => `identity entry ${i}`);
		const { stages, finalize } = commandsFor("test", node(id, { name: "Shared identity", revision: j.revisions, chars: j.content.length }), j.rows);
		expect((await send(token, stages)).data.receipts.every((r) => r.status === "stored")).toBe(true);
		const c = await contextFor();
		const hosted = await call<{ memory_id: string }>(c, "save_memory", { name: "Shared identity", type: "project", kind: "journal", description: "written in Agent Memory", scope: "personal", profile: "test" });
		expect((await send(token, [finalize])).data.receipts[0]).toMatchObject({ status: "refused", reason: "identity_conflict" });
		expect(await outcome(c, "get_memory", { memory_id: id })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect((await call<{ description: string }>(c, "get_memory", { memory_id: hosted.memory_id })).description).toBe("written in Agent Memory");
	});

	it("links BothQ supersessions between published memories of any kinds, and refuses every other endpoint", async () => {
		const c = await contextFor();
		const { token } = await deviceToken("import-links", ["import"], ["test"], "test");
		const [a, b, r, d, j] = ["a", "b", "c", "d", "e"].map((x) => `44444444-0000-5000-8000-00000000000${x}`) as [string, string, string, string, string];
		const one = (id: string, over: Row) => commandsFor("test", node(id, { name: `link ${id.slice(-1)}`, ...over }), [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: `body ${id}`, created_at: AT, live: true }],
			["revisions", { revision: 1, op: "legacy_snapshot", snapshot: "{}", delta: null, request_id: null, at: AT, content_hash: null, revision_id: null, source_platform: null, source_platform_version: null }]]);
		const gone = { status: "superseded", valid_to: AT };
		const [ca, cb, cr, cd, cj] = [one(a, {}), one(b, gone), one(r, { kind: "rule", memory_type: "feedback" }), one(d, { kind: "document", memory_type: "reference" }),
			one(j, { kind: "journal", memory_type: "project", ...gone })];
		await send(token, [...ca.stages, ...cb.stages, ...cr.stages, ...cd.stages, ...cj.stages, ca.finalize]);
		expect((await send(token, [linkCommand(a, b)])).data.receipts[0]).toMatchObject({ status: "refused", reason: "endpoint_unpublished" });
		await send(token, [cb.finalize, cr.finalize, cd.finalize, cj.finalize]);
		expect((await send(token, [linkCommand(a, b)])).data.receipts[0]!.status).toBe("linked");
		expect((await send(token, [linkCommand(a, b)])).data.receipts[0]!.status).toBe("replayed");
		// The rehearsal's refused pairs: BothQ lets a feedback rule replace a project decision, and a reference a project journal.
		const crossed = [linkCommand(r, b), linkCommand(d, j)];
		expect((await send(token, crossed)).data.receipts.map((x) => x.status)).toEqual(["linked", "linked"]);
		expect((await send(token, crossed)).data.receipts.map((x) => x.status)).toEqual(["replayed", "replayed"]);
		// Refused: a self-link, a knowledge-graph node that is not a memory, and a memory of another profile.
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "component", name: "link endpoint component" }] });
		const component = await profileSql("test", (sql) => sql.exec<{ id: string }>("SELECT id FROM nodes WHERE name = 'link endpoint component'").one().id);
		const other = await call<{ memory_id: string }>(c, "save_memory", { name: "personal link endpoint", type: "reference", description: "elsewhere", profile: "personal" });
		const refused = await send(token, [linkCommand(a, a), linkCommand(a, component), linkCommand(component, b), linkCommand(a, other.memory_id)]);
		expect(refused.data.receipts.map((x) => x.reason)).toEqual(["invalid_endpoints", "invalid_endpoints", "invalid_endpoints", "endpoint_unpublished"]);
		expect(await profileSql("test", (sql) => sql.exec("SELECT src, dst FROM edges WHERE rel = 'supersedes' ORDER BY src").toArray())).toEqual([{ src: a, dst: b }, { src: r, dst: b }, { src: d, dst: j }]);
	});

	it("refuses callers without the import scope or the profile, me, oversized or tampered batches, changed parts and text that needs redaction", async () => {
		const { token } = await deviceToken("import-auth", ["import"], ["test"], "test");
		const { token: writer } = await deviceToken("import-writer", ["read", "write"], ["test"], "test");
		const { token: personalOnly } = await deviceToken("import-personal", ["import"], ["personal"], "personal");
		const id = "55555555-0000-5000-8000-000000000001";
		const rows: [Table, Row][] = [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "clean body", created_at: AT, live: true }]];
		const { stages } = commandsFor("test", node(id), rows);
		expect((await send(writer, stages)).status).toBe(403);
		expect((await send(personalOnly, stages)).data.receipts[0]).toMatchObject({ status: "refused", reason: "forbidden" });
		expect((await send(token, commandsFor("me", node(id), rows).stages)).data.receipts[0]).toMatchObject({ status: "refused", reason: "me" });
		expect((await send(token, Array(51).fill(stages[0]))).status).toBe(400);
		expect((await post(token, null, JSON.stringify({ commands: stages, pad: "x".repeat(1_000_001) }))).status).toBe(413);
		expect((await send(token, [{ ...stages[0], sha256: "0".repeat(64) }])).data.receipts[0]).toMatchObject({ status: "refused", reason: "hash_mismatch" });
		const secret = commandsFor("test", node(id), [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "use token=abc123secret", created_at: AT, live: true }]]);
		expect((await send(token, secret.stages)).data.receipts[0]).toMatchObject({ status: "refused", reason: "needs_redaction" });
		expect((await send(token, stages)).data.receipts[0]!.status).toBe("stored");
		// The same part id with other content, and the same record with other content, are both refused.
		const changed = { ...stages[0]!, rows: { ...stages[0]!.rows, texts: [{ ...rows[0]![1], body: "other body" }] } };
		const body = Object.fromEntries(Object.entries(changed).filter(([k]) => k !== "sha256" && k !== "part_id"));
		expect((await send(token, [{ ...changed, sha256: sha256(canonicalJson(body)) }])).data.receipts[0]).toMatchObject({ status: "refused", reason: "part_conflict" });
		expect((await send(token, commandsFor("test", node(id, { name: "renamed" }), rows).stages)).data.receipts[0]).toMatchObject({ status: "refused", reason: "record_changed" });
	});

	// Closure review S3-S5 (docs/review-sol-import-server-uploader-2026-10-29.md), from the reviewer's probes.
	it("S3: a staged request id is reserved account-wide, so an ordinary call in another profile gets busy and the import still publishes", async () => {
		const { token } = await deviceToken("import-s3", ["import"], ["work"], "work");
		const id = "66666666-0000-5000-8000-000000000003";
		const args = { scope: "work", name: "Probe source save", type: "project", description: "fixture note", content: "fixture source content" };
		const rid = "probe-staged-global-q";
		const result = canonicalJson({ memory_id: id, revision: 1, ok: true });
		const cmd = commandsFor("work", node(id, { scope: "work", name: args.name }), [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: args.content, created_at: AT, live: true }],
			["requests", { request_id: rid, legacy_op: "save", legacy_hash: legacyRequestHash("save_memory", args)!, result, memory_id: id, at: AT, completed_at: AT }]]);
		expect((await send(token, cmd.stages)).data.receipts[0]!.status).toBe("stored");
		const c = await contextFor();
		expect(await outcome(c, "save_memory", { ...args, profile: "personal", request_id: rid })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await outcome(c, "save_memory", { ...args, profile: "work", request_id: rid })).toMatchObject({ ok: false, error: { code: "busy" } });
		// A bytes-identical retry of the stage repairs, and the reservation never displaces a binding another call already holds.
		expect((await send(token, cmd.stages)).data.receipts[0]!.status).toBe("replayed");
		expect((await send(token, [cmd.finalize])).data.receipts[0]!.status).toBe("published");
		expect(await call(c, "save_memory", { ...args, profile: "work", request_id: rid })).toMatchObject({ action: "replayed", memory_id: id });
		const taken = "probe-modern-taken";
		await call(c, "save_memory", { name: "Modern first", type: "user", description: "x", profile: "personal", request_id: taken });
		const clash = commandsFor("work", node("66666666-0000-5000-8000-000000000004", { scope: "work", name: "clash" }), [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "b", created_at: AT, live: true }],
			["requests", { request_id: taken, legacy_op: "save", legacy_hash: sha256("other"), result, memory_id: id, at: AT, completed_at: AT }]]);
		expect((await send(token, clash.stages)).data.receipts[0]).toMatchObject({ status: "refused", reason: "request_conflict" });
		expect(await accountSql((sql) => sql.exec("SELECT profile, legacy, pending FROM request_index WHERE request_id = ?", taken).one())).toEqual({ profile: "personal", legacy: 0, pending: 0 });
	});

	it("S4: no hosted creation can take the id of a record being imported, and no stage attaches to a node that exists", async () => {
		const { token } = await deviceToken("import-s4", ["import"], ["test"], "test");
		const c = await contextFor();
		const id = newMemoryId(c.caller.userId, "test", "personal", "project", "Probe hosted creation");
		const two = (part: number, body: string) => {
			const b = { op: "stage", record_id: id, record_sha256: "c".repeat(64), profile: "test", part, parts: 2,
				rows: { texts: [{ part: "entry", revision: part + 1, seq_no: part, chunk: 0, body, separator: "\n", created_at: AT, live: true }], revisions: [], requests: [] }, cost: { rows: 1, bytes: 1 } };
			return { ...b, part_id: `${id}:${"c".repeat(16)}:${part}`, sha256: sha256(canonicalJson(b)) };
		};
		expect((await send(token, [two(1, "staged-only-marker")])).data.receipts[0]!.status).toBe("stored");
		expect(await outcome(c, "save_memory", { profile: "test", scope: "personal", type: "project", name: "Probe hosted creation", description: "hosted", content: "hosted-only" }))
			.toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await outcome(c, "get_memory", { memory_id: id, include_retired: true, history: { limit: 5 } })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect((await send(token, [two(2, "later-stage-marker")])).data.receipts[0]!.status).toBe("stored");
		// The other side: a node that already exists makes every new part of that id refuse, while an accepted part still replays.
		const hosted = await call<{ memory_id: string }>(c, "save_memory", { profile: "test", scope: "personal", type: "project", name: "Exists first", description: "hosted" });
		const pre = (part: number) => {
			const b = { op: "stage", record_id: hosted.memory_id, record_sha256: "d".repeat(64), profile: "test", part, parts: 1,
				rows: { texts: [{ part: "entry", revision: 2, seq_no: 1, chunk: 0, body: "x", separator: "\n", created_at: AT, live: true }], revisions: [], requests: [] }, cost: { rows: 1, bytes: 1 } };
			return { ...b, part_id: `${hosted.memory_id}:${"d".repeat(16)}:${part}`, sha256: sha256(canonicalJson(b)) };
		};
		expect((await send(token, [pre(1)])).data.receipts[0]).toMatchObject({ status: "refused", reason: "record_exists" });
		expect((await send(token, [two(1, "staged-only-marker")])).data.receipts[0]!.status).toBe("replayed");
	});

	it("S5: an import whose node carries attributes the personal-field rule removes is refused, not rewritten, and benign provenance passes", async () => {
		const { token } = await deviceToken("import-s5", ["import"], ["test"], "test");
		const id = "77777777-0000-5000-8000-000000000005";
		const body: [Table, Row][] = [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "ordinary note", created_at: AT, live: true }]];
		const bad = commandsFor("test", node(id, { attrs: { phone: "+1 202 555 0184", email: "fixture@example.test", validity: "unknown", source: { system: "bothq" } } }), body);
		const r = await send(token, [...bad.stages, bad.finalize]);
		expect(r.data.receipts.map((x) => [x.op, x.status, x.reason ?? null])).toEqual([["stage", "stored", null], ["finalize", "refused", "personal_fields"]]);
		expect(await profileSql("test", (sql) => sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n)).toBe(0);
		const good = commandsFor("test", node("77777777-0000-5000-8000-000000000006", { attrs: { validity: "unknown", first_recorded_at: AT, source: { system: "bothq", properties: { auth_method: "oauth" } } } }), body);
		expect((await send(token, [...good.stages, good.finalize])).data.receipts.map((x) => x.status)).toEqual(["stored", "published"]);
	});
});


describe("import refresh", () => {
	it("publishes an invisible delta atomically, replays retries and preserves BothQ requests and history", async () => {
		const { token } = await deviceToken("refresh", ["import"], ["test"], "test");
		const id = newMemoryId("test-user", "test", "personal", "project", "refresh"), j = journal(id, 2, (i) => `refresh-old-${i}`);
		const n = node(id, { revision: 3, chars: j.content.length });
		const base = commandsFor("test", n, j.rows);
		expect((await send(token, [...base.stages, base.finalize])).data.receipts.at(-1)?.status).toBe("published");
		const full = journal(id, 4, (i) => i < 2 ? `refresh-old-${i}` : `refresh-new-${i}`);
		const delta = full.rows.filter(([t, r]) => t === "requests" ? !j.requests.some((q) => q.request_id === r.request_id) : Number(r.revision) > 3);
		const next = commandsFor("test", { ...n, revision: 5, chars: full.content.length, content_hash: sha256(full.content) }, delta,
			{ no: 1, base_record_sha256: base.finalize.record_sha256, base_revision: 3, base_content_hash: String(n.content_hash) });
		for (const st of next.stages) expect((await send(token, [st])).data.receipts[0], "refresh stage").toMatchObject({ status: "stored" });
		const ctx = await contextFor(), off = { ...ctx, env: { ...ctx.env, EMBEDDINGS: "off" } };
		expect((await call<{ content: string }>(ctx, "get_memory", { memory_id: id, content: { complete: true }, history: { limit: 100 } })).content).toBe(j.content);
		expect((await call<{ results: { memory_id: string }[] }>(off, "recall_memories", { keyword: "refresh-new", profile: "test" })).results.map((r) => r.memory_id)).not.toContain(id);
		expect(await outcome(ctx, "append_memory", { memory_id: id, content: "refresh-new-2", separator: "\n", request_id: `${id}:r4` })).toMatchObject({ ok: false, error: { code: "busy" } });
		const pub = (await send(token, [next.finalize])).data.receipts[0]!;
		expect(pub).toMatchObject({ status: "published" });
		expect(pub.rows_written).toBeLessThanOrEqual(1000);
		expect((await send(token, [...next.stages, next.finalize])).data.receipts.map((r) => r.status)).toEqual([...next.stages.map(() => "replayed"), "replayed"]);
		expect((await call<{ content: string; revision: number }>(ctx, "get_memory", { memory_id: id, content: { complete: true } }))).toMatchObject({ content: full.content, revision: 5 });
		expect(await call(ctx, "append_memory", { memory_id: id, content: "refresh-new-2", separator: "\n", request_id: `${id}:r4` })).toMatchObject({ action: "replayed", revision: 4 });
		await profileSql("test", (sql) => {
			expect(sql.exec("SELECT count(*) AS n FROM revisions WHERE node_id = ?", id).one().n).toBe(5);
			expect(sql.exec("SELECT card_hash FROM nodes WHERE id = ?", id).one().card_hash).toBeTypeOf("string");
		});
	});

	it("holds a refresh after a hosted write without exposing staged rows or changing the hosted content", async () => {
		const { token } = await deviceToken("refresh-conflict", ["import"], ["test"], "test");
		const id = newMemoryId("test-user", "test", "personal", "project", "refresh-conflict"), j = journal(id, 0, () => ""), n = node(id, { chars: j.content.length });
		const base = commandsFor("test", n, j.rows);
		await send(token, [...base.stages, base.finalize]);
		const ctx = await contextFor();
		await call(ctx, "append_memory", { memory_id: id, content: "hosted writer", separator: "\n", request_id: `hosted-${id}` });
		const next = commandsFor("test", { ...n, revision: 3 }, [["revisions", { revision: 3, op: "retired", snapshot: "{}", delta: null, request_id: null, at: AT, content_hash: null, revision_id: null, source_platform: null, source_platform_version: null }]],
			{ no: 1, base_record_sha256: base.finalize.record_sha256, base_revision: 1, base_content_hash: String(n.content_hash) });
		expect((await send(token, [...next.stages, next.finalize])).data.receipts.at(-1)).toMatchObject({ status: "refused", reason: "hosted_changed" });
		expect((await call<{ content: string; revision: number }>(ctx, "get_memory", { memory_id: id, content: { complete: true } }))).toMatchObject({ content: "start\nhosted writer", revision: 2 });
		// The hosted append keeps its delta as an entry, not a revision row; the held refresh's row stays under its shadow id.
		await profileSql("test", (sql) => expect([id, `${id}#r1`].map((x) => sql.exec("SELECT count(*) AS n FROM revisions WHERE node_id = ?", x).one().n)).toEqual([1, 1]));
	});
});

describe("shared write budget at its edge", () => {
	it("charges the write's sequence row too: a write of exactly 1,001 real rows rolls back, one entry fewer commits", async () => {
		const { token } = await deviceToken("budget-edge", ["import"], ["test"], "test");
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "test")!;
		let journals = 0;
		/** An imported journal of `entries` live entries, replaced by a body of `chunks` text rows; every statement's real rows summed. */
		const replace = async (entries: number, chunks: number) => {
			const id = newMemoryId("test-user", "test", "personal", "project", `budget-edge-${++journals}`), j = journal(id, entries, (i) => `line ${i}`);
			const base = commandsFor("test", node(id, { revision: entries + 1, chars: j.content.length }), j.rows);
			for (const c of [...base.stages, base.finalize]) expect((await send(token, [c])).data.receipts[0]!.status).not.toBe("refused");
			return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, s) => {
				let rows = 0, code = "ok";
				const sql = { exec(query: string, ...params: SqlStorageValue[]) { const c = s.storage.sql.exec(query, ...params); rows += c.rowsWritten; return c; } };
				try {
					runWrite({ sql, transactionSync: s.storage.transactionSync.bind(s.storage) } as unknown as DurableObjectStorage, ref,
						{ op: "save", args: { memory_id: id, content: "r".repeat(16_000 * (chunks - 1) + 1), request_id: `budget-edge-${journals}` } },
						{ actor: "owner", platform: "test", routedBy: "explicit", payloadHash: sha256(`budget-edge-${journals}`), userId: ref.userId } as never);
				} catch (e) { code = (e as { failure?: { code: string } }).failure?.code ?? String(e); }
				return { code, rows, revision: Number(s.storage.sql.exec("SELECT revision FROM nodes WHERE id = ?", id).one().revision),
					saved: Number(s.storage.sql.exec("SELECT count(*) AS n FROM requests WHERE request_id = ?", `budget-edge-${journals}`).one().n) };
			});
		};
		// Each live entry that leaves costs 4 rows and each body text row 5 (measured), so one probe gives the fixed part, and
		// some chunk count puts a write at exactly 1,001 real rows, one row past the bound, whatever the fixed part is.
		const probe = await replace(200, 1);
		expect(probe.code).toBe("ok");
		const fixed = probe.rows - 4 * 200;
		const chunks = [1, 2, 3, 4].find((k) => (1001 - fixed - 5 * (k - 1)) % 4 === 0)!;
		const entries = (1001 - fixed - 5 * (chunks - 1)) / 4;
		const over = await replace(entries, chunks), under = await replace(entries - 1, chunks);
		expect(over).toMatchObject({ code: "size_budget", revision: entries + 1, saved: 0 });
		expect(under).toMatchObject({ code: "ok", rows: 997, revision: entries + 1, saved: 1 }); // its own journal, one revision on
	});
});

describe("import refresh, body replacement and adoption", () => {
	const rev = (revision: number, op: string, extra: Row = {}): [Table, Row] => ["revisions", { revision, op, snapshot: "{}", delta: null, request_id: null, at: AT, content_hash: null,
		revision_id: null, source_platform: null, source_platform_version: null, ...extra }];
	it("replaces the body losslessly: earlier body and entries stay as history, the new body and later entries are current", async () => {
		const { token } = await deviceToken("refresh-body", ["import"], ["test"], "test");
		const id = newMemoryId("test-user", "test", "personal", "project", "refresh-body"), j = journal(id, 2, (i) => `body-old-${i}`);
		const n = node(id, { revision: 3, chars: j.content.length });
		const base = commandsFor("test", n, j.rows);
		await send(token, [...base.stages, base.finalize]);
		const delta: [Table, Row][] = [["texts", { part: "body", revision: 4, seq_no: 0, chunk: 0, body: "replaced body", created_at: AT, live: true }],
			["texts", { part: "entry", revision: 5, seq_no: 3, chunk: 0, body: "after", separator: "\n", request_id: `${id}:r5`, created_at: AT, live: true }],
			rev(4, "updated", { snapshot: canonicalJson({ content: "replaced body" }) }), rev(5, "appended", { delta: canonicalJson({ content: "after", separator: "\n" }), request_id: `${id}:r5` }),
			["requests", { request_id: `${id}:r5`, legacy_op: "append", legacy_hash: sha256("r5"), result: canonicalJson({ ok: true, revision: 5 }), memory_id: id, at: AT, completed_at: AT }]];
		const next = commandsFor("test", { ...n, revision: 5, chars: "replaced body\nafter".length, content_hash: sha256("replaced") }, delta,
			{ no: 1, base_record_sha256: base.finalize.record_sha256, base_revision: 3, base_content_hash: String(n.content_hash), body_revision: 4 });
		expect((await send(token, [...next.stages, next.finalize])).data.receipts.at(-1)).toMatchObject({ status: "published" });
		const ctx = await contextFor(), off = { ...ctx, env: { ...ctx.env, EMBEDDINGS: "off" } };
		expect(await call(ctx, "get_memory", { memory_id: id, content: { complete: true } })).toMatchObject({ content: "replaced body\nafter", revision: 5 });
		expect((await call<{ results: { memory_id: string }[] }>(off, "recall_memories", { keyword: "body-old-1", profile: "test" })).results.map((r) => r.memory_id)).not.toContain(id);
		await profileSql("test", (sql) => {
			// Nothing was deleted: the first body and both earlier entries are still stored, no longer live.
			expect(sql.exec("SELECT part, body FROM texts WHERE node_id = ? AND part IN ('body','entry') AND live = 0 ORDER BY part, seq_no", id).toArray().map((t) => t.body))
				.toEqual(["start", "body-old-0", "body-old-1"]);
			expect(sql.exec("SELECT count(*) AS n FROM revisions WHERE node_id = ?", id).one().n).toBe(5);
		});
	});

	it("replaces the synthetic legacy snapshot with BothQ's identical adoption, and refuses an adoption with other content", async () => {
		const { token } = await deviceToken("refresh-adopt", ["import"], ["test"], "test");
		const hash = sha256("legacy content");
		const make = (name: string) => {
			const id = newMemoryId("test-user", "test", "personal", "project", name);
			const n = node(id, { kind: "document", memory_type: "reference", name, revision: 1, chars: "legacy body".length, content_hash: hash });
			const base = commandsFor("test", n, [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "legacy body", created_at: AT, live: true }],
				rev(1, "legacy_snapshot", { content_hash: hash })]);
			return { id, n, base };
		};
		const good = make("adopt-good"), bad = make("adopt-bad");
		await send(token, [...good.base.stages, good.base.finalize, ...bad.base.stages, bad.base.finalize]);
		const adoption = (r: ReturnType<typeof make>, adoptedHash: string) => commandsFor("test", { ...r.n, revision: 2, chars: "legacy body\nlater".length }, [
			["texts", { part: "entry", revision: 2, seq_no: 1, chunk: 0, body: "later", separator: "\n", request_id: `${r.id}:r2`, created_at: AT, live: true }],
			rev(1, "legacy_adopted", { snapshot: canonicalJson({ adopted: true }), content_hash: adoptedHash }), rev(2, "appended", { delta: canonicalJson({ content: "later", separator: "\n" }), request_id: `${r.id}:r2` }),
			["requests", { request_id: `${r.id}:r2`, legacy_op: "append", legacy_hash: sha256("adopt-r2"), result: canonicalJson({ ok: true, revision: 2 }), memory_id: r.id, at: AT, completed_at: AT }]],
			{ no: 1, base_record_sha256: r.base.finalize.record_sha256, base_revision: 1, base_content_hash: hash });
		const ok = adoption(good, hash), wrong = adoption(bad, sha256("other content"));
		expect((await send(token, [...ok.stages, ok.finalize])).data.receipts.at(-1)).toMatchObject({ status: "published" });
		expect((await send(token, [...wrong.stages, wrong.finalize])).data.receipts.at(-1)).toMatchObject({ status: "refused", reason: "history_rewritten" });
		await profileSql("test", (sql) => {
			expect(sql.exec("SELECT revision, op FROM revisions WHERE node_id = ? ORDER BY revision", good.id).toArray()).toEqual([{ revision: 1, op: "legacy_adopted" }, { revision: 2, op: "appended" }]);
			expect(sql.exec("SELECT revision, op FROM revisions WHERE node_id = ? ORDER BY revision", bad.id).toArray()).toEqual([{ revision: 1, op: "legacy_snapshot" }]);
		});
	});
});

describe("import audit", () => {
	type Digest = { count: number; sha256: string; hosted: number };
	type AuditRecord = { record_id: string; state: string; record_sha256: string; node_sha256: string | null;
		node: { revision: number; row_sha256: string; attrs_sha256: string; source_sha256: string; source_system: string | null } | null; revisions: Digest; requests: Digest };
	type Page = { totals?: unknown; records: AuditRecord[]; rows: Row[]; node_revision: number | null; next_after: string | null; error?: { code: string } };
	const auditGet = async (token: string | null, q: Record<string, string | number>) => {
		const url = new URL(`${origin}/v1/import/audit`);
		for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
		const res = await exports.default.fetch(new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
		return { status: res.status, data: await res.json() as Page };
	};
	// The audit's row and record digests, written out here from the fixture's definition, independent of the server's module.
	const revRow = (r: Row) => ({ revision: r.revision, op: r.op, snapshot_raw_utf8_sha256: sha256(r.snapshot as string), delta_raw_utf8_sha256: r.delta === null ? null : sha256(r.delta as string),
		request_id: r.request_id, at: r.at, content_hash: r.content_hash, revision_id: r.revision_id, source_platform: r.source_platform, source_platform_version: r.source_platform_version });
	const reqRow = (q: Row) => ({ request_id: q.request_id, legacy_op: q.legacy_op, legacy_hash: q.legacy_hash, result_raw_utf8_sha256: sha256(q.result as string),
		result_raw_utf8_bytes: new TextEncoder().encode(q.result as string).length, memory_id: q.memory_id ?? null, at: q.at, completed_at: q.completed_at,
		source_canonical_sha256: sha256(canonicalJson({ ...(q.extra ? { extra: q.extra } : {}), memory_id: q.memory_id })) });
	const expected = (cmds: ReturnType<typeof commandsFor>, rows: [Table, Row][]) => {
		const n = cmds.finalize.node as Row & { attrs: Row & { source?: Row } };
		const revs = rows.filter(([t]) => t === "revisions").map(([, r]) => revRow(r)).sort((a, b) => Number(a.revision) - Number(b.revision));
		const reqs = rows.filter(([t]) => t === "requests").map(([, q]) => reqRow(q)).sort((a, b) => String(a.request_id) < String(b.request_id) ? -1 : 1);
		return { revs, reqs, summary: { record_id: n.id, state: "published", record_sha256: cmds.finalize.record_sha256, node_sha256: sha256(canonicalJson(n)),
			node: expect.objectContaining({ revision: n.revision, row_sha256: sha256(canonicalJson(n)), attrs_sha256: sha256(canonicalJson(n.attrs)), source_sha256: sha256(canonicalJson(n.attrs.source)) }),
			revisions: { count: revs.length, sha256: sha256(canonicalJson(revs)), hosted: 0 }, requests: { count: reqs.length, sha256: sha256(canonicalJson(reqs)), hosted: 0 } } };
	};

	it("reports exactly what the import stored, byte for byte, in bounded pages, and changes nothing", async () => {
		const c = await contextFor();
		const { token } = await deviceToken("import-audit", ["import"], ["test"], "test");
		const [jid, lid, sid] = ["fffffff1-0000-5000-8000-000000000001", "fffffff1-0000-5000-8000-000000000002", "fffffff1-0000-5000-8000-000000000003"];
		const j = journal(jid, 3, (i) => `audit entry ${i} é日本語🙂`);
		// A stored result that is not canonical JSON (spacing, key order, non-ASCII): it is hashed as stored, never reserialized.
		j.rows.find(([t, r]) => t === "requests" && r.request_id === `${jid}:r2`)![1].result = '{"revision": 2,  "ok":true, "note":"é"}';
		const jc = commandsFor("test", node(jid), j.rows);
		const lrows: [Table, Row][] = [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "legacy body", created_at: AT, live: true }],
			["revisions", { revision: 1, op: "legacy_snapshot", snapshot: canonicalJson({ name: "audit legacy note" }), delta: null, request_id: null, at: AT, content_hash: null, revision_id: null, source_platform: null, source_platform_version: null }]];
		const lc = commandsFor("test", node(lid, { kind: "document", memory_type: "reference", name: "audit legacy note",
			attrs: { validity: "unknown", source: { system: "claude", realpath: "/x/notes.md", paths: ["/x/notes.md", "/y/notes.md"] } } }), lrows);
		const sc = commandsFor("test", node(sid, { name: "audit staged only" }), [["texts", { part: "body", revision: 1, seq_no: 0, chunk: 0, body: "staged", created_at: AT, live: true }]]);
		// Storage is shared across this file's tests: totals are checked as deltas, and pages start past the other tests' ids.
		type Totals = { records: Record<string, number>; revisions: number; requests: number };
		const base = (await auditGet(token, { profile: "test", limit: 1 })).data.totals as Totals;
		const ours = { profile: "test", after: "fffffff0" };
		const sent = await send(token, [...jc.stages, jc.finalize, ...lc.stages, lc.finalize, ...sc.stages]);
		expect(sent.data.receipts.every((x) => x.status === "stored" || x.status === "published")).toBe(true);
		const [ej, el] = [expected(jc, j.rows), expected(lc, lrows)];
		const state = async () => [await profileSql("test", (sql) => [...["nodes", "texts", "revisions", "requests", "import_records", "import_parts", "activity"].map((t) => sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n),
			sql.exec("SELECT value FROM profile_meta WHERE key = 'write_seq'").one().value]), await accountSql((sql) => sql.exec("SELECT count(*) AS n, sum(pending) AS p FROM request_index").one())];
		// The import arms the profile's alarm for its follow-up background work, which writes on its own schedule (it re-arms at most a
		// second ahead while work remains). Drive it until none is due, so the no-write window below measures only the audit. An alarm
		// the runtime fired itself reads null until it re-arms (every run does), so null waits for that run instead of passing as settled.
		const ref = c.account.profiles.find((p) => p.profile === "test")!, stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`));
		const armed = async () => {
			for (let i = 0; i < 250; i++) {
				const at = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
				if (at !== null) return at;
				await new Promise((r) => setTimeout(r, 20));
			}
			throw new Error("the profile's running alarm did not re-arm in 5s");
		};
		for (let i = 0; ; i++) {
			if (i === 20) throw new Error("the profile's background work did not settle in 20 alarms");
			await runDurableObjectAlarm(stub);
			if ((await armed()) > Date.now() + 10_000) break;
		}
		const before = await state();

		expect((await auditGet(token, { profile: "test", limit: 1 })).data.totals).toEqual({ records: { staging: base.records.staging! + 1, prepared: base.records.prepared, published: base.records.published! + 2 },
			revisions: base.revisions + ej.summary.revisions.count + 1, requests: base.requests + ej.summary.requests.count });
		const first = await auditGet(token, { ...ours, limit: 2 });
		expect(first.status).toBe(200);
		expect(first.data.records).toEqual([expect.objectContaining(ej.summary), expect.objectContaining(el.summary)]);
		expect(first.data.records[1]!.node!.source_system).toBe("claude");
		expect(first.data.next_after).toBe(lid);
		const second = await auditGet(token, { profile: "test", limit: 2, after: lid });
		expect(second.data.totals).toBeUndefined();
		expect(second.data.records).toEqual([expect.objectContaining({ record_id: sid, state: "staging", node: null, node_sha256: null })]);
		expect(second.data.next_after).toBeNull();
		// Detail pages reassemble every request row, including the non-canonical result's exact UTF-8 byte count.
		const rows: Row[] = [];
		for (let after: string | null = null, i = 0; i < 10; i++) {
			const page = await auditGet(token, { profile: "test", record: jid, rows: "requests", limit: 3, ...(after ? { after } : {}) });
			expect(page.data.node_revision).toBe((jc.finalize.node as Row).revision);
			rows.push(...page.data.rows);
			if (!(after = page.data.next_after)) break;
		}
		expect(rows).toEqual(ej.reqs);
		expect((await auditGet(token, { profile: "test", record: jid, rows: "revisions", limit: 200 })).data.rows).toEqual(ej.revs);
		expect(await state()).toEqual(before);
		// The audit took no binding: a BothQ request still replays its stored result.
		expect(await call(c, "append_memory", { memory_id: jid, content: "audit entry 2 é日本語🙂", separator: "\n", request_id: `${jid}:r4`, profile: "test" })).toMatchObject({ action: "replayed", revision: 4 });

		// A later hosted write shows as drift (its request, and the node revision; an append keeps its delta as an entry, not a
		// revision row), and the imported digests stay as they were.
		await call(c, "append_memory", { memory_id: jid, content: "hosted entry", request_id: "audit-hosted-1", profile: "test" });
		const drifted = (await auditGet(token, { ...ours, limit: 1 })).data.records[0]!;
		expect([drifted.node!.revision, drifted.revisions, drifted.requests]).toEqual([Number((jc.finalize.node as Row).revision) + 1, ej.summary.revisions, { ...ej.summary.requests, hosted: 1 }]);
		// A stored node changed without a new revision: the row digest moves; the published node's hash and the attrs stay.
		await profileSql("test", (sql) => sql.exec("UPDATE nodes SET status = 'retired' WHERE id = ?", lid));
		const retired = (await auditGet(token, { ...ours, limit: 2 })).data.records[1]!;
		expect([retired.node!.revision, retired.node_sha256, retired.node!.attrs_sha256, retired.node!.row_sha256 === sha256(canonicalJson(lc.finalize.node))])
			.toEqual([1, el.summary.node_sha256, first.data.records[1]!.node!.attrs_sha256, false]);
		// One changed stored byte shows on that record only, in the class it belongs to.
		await profileSql("test", (sql) => {
			sql.exec("UPDATE requests SET result = result || ' ' WHERE request_id = ?", `${jid}:r2`);
			sql.exec("UPDATE nodes SET attrs = json_set(attrs, '$.validity', 'changed') WHERE id = ?", lid);
		});
		const [tj, tl] = (await auditGet(token, { ...ours, limit: 2 })).data.records;
		expect([tj!.requests.sha256 === ej.summary.requests.sha256, tj!.revisions.sha256 === ej.summary.revisions.sha256]).toEqual([false, true]);
		const lattrs = (lc.finalize.node as Row).attrs as Row;
		expect([tl!.node!.attrs_sha256 === sha256(canonicalJson(lattrs)), tl!.node!.source_sha256 === sha256(canonicalJson(lattrs.source)), tl!.revisions]).toEqual([false, true, el.summary.revisions]);
	});

	it("hashes at most 5,000 rows for a summary page, and lists a larger record with counts only for its detail pages", async () => {
		const { token } = await deviceToken("import-audit-b", ["import"], ["test"], "test");
		const ids = ["fffffff2-0000-5000-8000-000000000001", "fffffff2-0000-5000-8000-000000000002", "fffffff2-0000-5000-8000-000000000003"];
		await profileSql("test", (sql) => {
			for (const [i, id] of ids.entries()) {
				sql.exec("INSERT INTO import_records (record_id, record_sha256, parts, state, staged_at, seq) VALUES (?, ?, 1, 'staging', ?, 1)", id, "0".repeat(64), AT);
				for (let r = 1; r <= (i < 2 ? 3000 : 5001); r++) sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, ?, 'appended', '{}', 'migration', ?, 1)", id, r, AT);
			}
		});
		const pages: string[][] = [];
		for (let after = "fffffff1-~", i = 0; after && i < 5; i++) {
			const page = (await auditGet(token, { profile: "test", after, limit: 50 })).data;
			pages.push(page.records.map((r) => `${r.record_id}:${r.revisions.count}:${r.revisions.sha256 === null ? "paged" : "hashed"}`));
			after = page.next_after!;
		}
		expect(pages).toEqual([[`${ids[0]}:3000:hashed`], [`${ids[1]}:3000:hashed`, `${ids[2]}:5001:paged`]]);
		// The paged record's rows are all on its detail pages, each at most 200 rows.
		let rows = 0, calls = 0;
		for (let after: string | null = null; calls < 40; calls++) {
			const page: Page = (await auditGet(token, { profile: "test", record: ids[2]!, rows: "revisions", limit: 200, ...(after ? { after } : {}) })).data;
			rows += page.rows.length;
			if (!(after = page.next_after)) break;
		}
		expect([rows, calls + 1]).toEqual([5001, 26]);
	});

	it("is open only to the owner or an import device that may use the profile, and checks every parameter", async () => {
		const { token } = await deviceToken("import-audit-a", ["import"], ["test"], "test");
		const { token: reader } = await deviceToken("import-audit-r", ["read", "write"], ["test"], "test");
		const { token: personalOnly } = await deviceToken("import-audit-p", ["import"], ["personal"], "personal");
		expect((await auditGet(null, { profile: "test" })).status).toBe(401);
		expect((await auditGet(reader, { profile: "test" })).status).toBe(403);
		expect((await auditGet(personalOnly, { profile: "test" })).status).toBe(403);
		expect((await auditGet(token, { profile: "me" })).status).toBe(400);
		expect((await auditGet(token, { profile: "nosuch" })).status).toBe(404);
		for (const q of <Record<string, string | number>[]>[{ profile: "test", sql: "SELECT 1" }, { profile: "test", limit: 51 }, { profile: "test", record: "x" }, { profile: "test", rows: "requests" }, { profile: "test", record: "x", rows: "nodes" }, { profile: "test", record: "x", rows: "texts", after: "abc" }, { profile: "test", record: "x", rows: "texts", limit: 201 }, { profile: "test", record: "x", rows: "revisions", after: "abc" }]) {
			expect((await auditGet(token, q)).status, JSON.stringify(q)).toBe(400);
		}
		expect((await auditGet(token, { profile: "test", after: "ffffffff" })).data).toMatchObject({ profile: "test", records: [], next_after: null });
	});
});


it("reads pinned normalized legacy and append history without inventing unknown fields", async () => {
	const c = await contextFor(), {token} = await deviceToken("historical-normalized", ["import"], ["test"], "test");
	for (const item of historicalShapes) {
		const rows: [Table, Row][] = [...item.texts.map((r): [Table, Row] => ["texts", r]), ...item.revisions.map((r): [Table, Row] => ["revisions", r])];
		const cmd = commandsFor("test", item.node, rows);
		expect((await send(token, [...cmd.stages, cmd.finalize])).data.receipts.at(-1)).toMatchObject({status: "published"});
		const get = (as_of: string) => call(c, "get_memory", {memory_id: item.id, as_of});
		if (item.node.name === "Synthetic legacy history") {
			expect(await get("2026-01-03T00:00:00Z")).toMatchObject({name: item.node.name, description: "retained description", content: "known legacy body", freshness: {valid_from: null}, as_of: {content_known: true}});
		} else {
			expect(await get("2026-01-03T00:00:00Z")).toMatchObject({content: "start", revision: 1});
			expect(await get("2026-02-02T00:00:00Z")).toMatchObject({description: "retained description", content: "start\nmore", revision: 2, freshness: {created_at: item.node.created_at, valid_from: null}});
		}
	}
});


describe("source-policy import vertical",()=>{
	it("publishes both suffixed sources, preserves original rows, and refuses changed policy, ledgers and wire on replay",async()=>{
		const {token}=await deviceToken("source-policy-import",["import"],["work"],"work");
		const a=reviewedMarkdown("~/fixture-one/MEMORY.md","original one","source_suffix"),b=reviewedMarkdown("~/fixture-two/MEMORY.md","original two","source_suffix");
		for(const f of [a,b]) {
			const oversized={...f.finalize,node:{...f.node,attrs:{...f.node.attrs,padding:"é".repeat(500000)}}};expect((await send(token,[...f.stages,oversized])).status).toBe(413);
			expect(await profileSql("work",sql=>sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?",f.node.id).one().n)).toBe(0);
			const r=await send(token,[...f.stages,f.finalize]);expect(r.status).toBe(200);expect(r.data.receipts.every(r=>r.status!=="refused")).toBe(true);
			expect((await send(token,[...f.stages,f.finalize])).data.receipts.every(r=>r.status==="replayed")).toBe(true);
			await profileSql("work",sql=>{expect(sql.exec("SELECT norm_name FROM nodes WHERE id = ?",f.node.id).one().norm_name).toBe(f.node.name.toLowerCase());expect(sql.exec("SELECT snapshot FROM revisions WHERE node_id = ?",f.node.id).one().snapshot).toBe(f.revisions[0]!.snapshot);expect(sql.exec("SELECT count(*) AS n FROM requests WHERE node_id = ? AND legacy_op IS NOT NULL",f.node.id).one().n).toBe(0);});
			const changed={...f.finalize,node:{...f.node,name:"changed"}};changed.sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(changed).filter(([k])=>k!=="sha256"))));expect((await send(token,[changed])).data.receipts[0]!.status).toBe("refused");
			const missing={...f.finalize} as Row;delete missing.policy_version;missing.sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(missing).filter(([k])=>k!=="sha256"))));expect((await send(token,[missing])).data.receipts[0]!.reason).toBe("policy_version");
			const altered={...f.finalize,parts:[{...f.finalize.parts[0]!,sha256:"0".repeat(64)}]};altered.sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(altered).filter(([k])=>k!=="sha256"))));expect((await send(token,[altered])).data.receipts[0]!.reason).toBe("policy_ledger_changed");
		}
		expect(a.node.id).not.toBe(b.node.id);expect(a.node.name).not.toBe(b.node.name);
	});
	it("refreshes exact source body versions including empty files, audits text/index drift, and retains source bodies through ordinary write and Undo",async()=>{
		const c=await contextFor(),{token}=await deviceToken("policy-refresh-audit",["import"],["work"],"work"),path="~/refresh-fixture/MEMORY.md",first=reviewedMarkdown(path,"original UTF8 é","source_suffix");
		expect((await send(token,[...first.stages,first.finalize])).data.receipts.at(-1)!.status).toBe("published");
		let recordHash=first.finalize.record_sha256,hostedHash=first.node.content_hash,latest=first.node;
		for(const [i,content] of ["changed source", ""].entries()) {
			const f=reviewedMarkdown(path,content,"source_suffix"),revision=i+2,at=`2026-0${i+3}-01T00:00:00Z`;
			f.node.revision=revision;f.node.updated_at=at;
			(f.node.attrs.source as Row).mtime=at;const policy=f.node.attrs.import_review as {source_head:{revision:number};witness:{export_manifest_sha256:string;source_row_sha256:string}};policy.source_head.revision=revision;policy.witness.export_manifest_sha256=sha256(`fresh ${i}`);policy.witness.source_row_sha256=sha256(`fresh row ${i}`);
			const rows:[Table,Row][]=[...f.texts.map(t=>["texts",{...t,revision}] as [Table,Row]),...f.revisions.map(r=>["revisions",{...r,revision,at}] as [Table,Row])];
			const cmd=commandsFor("work",f.node as unknown as Row,rows,{no:i+1,base_record_sha256:recordHash,base_revision:revision-1,base_content_hash:hostedHash,body_revision:revision});
			expect((await send(token,[...cmd.stages,cmd.finalize])).data.receipts.at(-1)!.status).toBe("published");
			expect((await send(token,[cmd.finalize])).data.receipts[0]!.status).toBe("replayed");
			recordHash=cmd.finalize.record_sha256;hostedHash=f.node.content_hash;latest=f.node;
			const current=await call(c,"get_memory",{profile:"work",memory_id:first.node.id});expect(current.content).toBe(content);
		}
		const metadata=structuredClone(latest);(metadata.attrs.import_review as any).witness.export_manifest_sha256=sha256("metadata-only fresh export");
		const only=commandsFor("work",metadata as unknown as Row,[],{no:3,base_record_sha256:recordHash,base_revision:3,base_content_hash:hostedHash});
		expect((await send(token,[...only.stages,only.finalize])).data.receipts.at(-1)!.status).toBe("published");recordHash=only.finalize.record_sha256;
		const then=await call(c,"get_memory",{profile:"work",memory_id:first.node.id,as_of:"2026-02-01T00:00:00Z",include_retired:true});expect(then).toMatchObject({content:"original UTF8 é",name:"synthetic source document",scope:null,content_hash:(first.node.attrs.import_review as any).source_head.content_hash});
		const getAudit=async(q:string)=>{const r=await exports.default.fetch(new Request(`${origin}/v1/import/audit?profile=work&${q}`,{headers:{authorization:`Bearer ${token}`}}));expect(r.status).toBe(200);return await r.json() as any;};
		const page=await getAudit(`record=${first.node.id}&rows=texts&limit=1`);expect(page.rows).toHaveLength(1);expect(page.record_sha256).toBe(recordHash);expect(page.rows[0].body_raw_utf8_sha256).toBe(sha256("original UTF8 é"));expect(page.rows[0].live).toBe(false);
		const continuation=await getAudit(`record=${first.node.id}&rows=texts&limit=1&after=${encodeURIComponent(page.next_after)}`);expect(continuation.rows[0].revision).toBe(2);expect(continuation.node_sha256).toBe(page.node_sha256);
		const summary=(await getAudit("limit=50")).records.find((r:any)=>r.record_id===first.node.id);expect(summary.node.identity_sha256).toBeTruthy();
		await profileSql("work",sql=>{sql.exec("UPDATE nodes SET norm_name = 'corrupt index' WHERE id = ?",first.node.id);sql.exec("UPDATE texts SET body = 'corrupt body' WHERE node_id = ? AND part = 'body' AND revision = 1",first.node.id);});
		expect((await getAudit(`record=${first.node.id}&rows=texts&limit=1`)).rows[0].body_raw_utf8_sha256).not.toBe(page.rows[0].body_raw_utf8_sha256);
		expect((await getAudit("limit=50")).records.find((r:any)=>r.record_id===first.node.id).node.identity_sha256).not.toBe(summary.node.identity_sha256);
		await profileSql("work",sql=>{sql.exec("UPDATE nodes SET norm_name = ? WHERE id = ?",first.node.name.toLowerCase(),first.node.id);sql.exec("UPDATE texts SET body = ? WHERE node_id = ? AND part = 'body' AND revision = 1","original UTF8 é",first.node.id);});
		const edited=await call(c,"save_memory",{profile:"work",memory_id:first.node.id,content:"hosted replacement",request_id:"policy-hosted-replace"});
		expect((await call(c,"get_memory",{profile:"work",memory_id:first.node.id,as_of:"2026-02-01T00:00:00Z",include_retired:true})).content).toBe("original UTF8 é");
		const who=c.account.profiles.find(p=>p.profile==="work")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:work:${who.generation}`)),(_i,s)=>{runWrite(s.storage,who,{op:"undo",args:{activity_id:Number(edited.activity_id),request_id:"policy-undo-request"}},{actor:"owner",platform:"test",routedBy:"explicit",payloadHash:"policy-undo",userId:who.userId});expect(s.storage.sql.exec("SELECT count(*) AS n FROM texts WHERE node_id = ? AND actor = 'migration' AND part = 'body'",first.node.id).one().n).toBe(2);});

		expect((await call(c,"get_memory",{profile:"work",memory_id:first.node.id,as_of:"2026-02-01T00:00:00Z",include_retired:true})).content).toBe("original UTF8 é");
	});

	it("keeps an archival reference labeled, blocks ordinary rewriting, and refuses published policy drift",async()=>{
		const {token}=await deviceToken("archive-policy-import",["import"],["work"],"work"),f=reviewedMarkdown("~/fixture-archive/SKILL.md","untrusted archived reference");
		expect((await send(token,[...f.stages,f.finalize])).data.receipts.at(-1)!.status).toBe("published");
		const unsupported={...f.finalize,policy_version:2};expect((await send(token,[unsupported])).status).toBe(400);
		const omitted=structuredClone(f.finalize);delete (omitted.node.attrs.import_review as any).profile_review_sha256;omitted.sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(omitted).filter(([k])=>k!=="sha256"))));expect((await send(token,[omitted])).data.receipts[0]!.reason).toBe("policy_invalid");
		const c=await contextFor();const got=await call(c,"get_memory",{memory_id:f.node.id,profile:"work"});expect(got).toMatchObject({classification:"archival_reference",trust:"untrusted",instruction_authority:false});
		for(const as_of of [undefined,"2026-02-01T00:00:00Z"]){
			const historical=await call(c,"get_memory",{memory_id:f.node.id,profile:"work",include_retired:true,...(as_of?{as_of}: {})});expect(historical).toMatchObject({classification:"archival_reference",trust:"untrusted",instruction_authority:false});
			const recalled=await call<{results:Row[]}>(c,"recall_memories",{keyword:"untrusted archived reference",profile:"work",include_history:true,...(as_of?{as_of}: {})});expect(recalled.results.find(r=>r.memory_id===f.node.id)).toMatchObject({classification:"archival_reference",trust:"untrusted",instruction_authority:false});
		}
		const changed=await outcome(c,"save_memory",{memory_id:f.node.id,profile:"work",content:"rewrite",request_id:"archive-new-write"});expect(changed).toMatchObject({ok:false,error:{details:{reason:"archival_reference"}}});
		expect(await accountSql(sql=>sql.exec("SELECT count(*) AS n FROM request_index WHERE request_id = 'archive-new-write'").one().n)).toBe(0);
		expect(await outcome(c,"record_knowledge",{profile:"work",nodes:[{kind:"project",name:"forged source marker",attrs:{import_review:"forged"}}]})).toMatchObject({ok:false,error:{details:{reason:"reserved_import_policy"}}});
		const who=c.account.profiles.find(p=>p.profile==="work")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:work:${who.generation}`)),(_i,s)=>{
			enqueue(s.storage,[{kind:"preference_signal",subjects:[f.node.id]}]);const lease=next(s.storage,{kinds:["preference_signal"]});expect(JSON.stringify(lease.items[0]!.context)).not.toContain("untrusted archived reference");
			const out=complete(s.storage,who,{lease_id:lease.lease_id!,results:[{item_id:lease.items[0]!.item_id,ops:[{op:"infer_preference",name:"fabricated preference",description:"derived from archive",evidence:[{kind:"node",ref:f.node.id}]}]}]},{platform:"test",userId:who.userId});expect(out.results[0]!.ops![0]).toMatchObject({status:"rejected",reason:"archival_reference"});
		});
		await profileSql("work",sql=>sql.exec("UPDATE nodes SET name = 'tampered' WHERE id = ?",f.node.id).toArray());expect((await send(token,[f.finalize])).data.receipts[0]!.reason).toBe("hosted_changed");
		await profileSql("work",sql=>sql.exec("UPDATE nodes SET name = ?, attrs = json_set(attrs, '$.import_review.profile_review_sha256', ?) WHERE id = ?",f.node.name,"0".repeat(64),f.node.id).toArray());expect((await send(token,[f.finalize])).data.receipts[0]!.reason).toBe("hosted_changed");
	});
});

describe("legacy Work owner classification import",()=>{
	const rehash=(c:Row)=>({...c,sha256:sha256(canonicalJson(Object.fromEntries(Object.entries(c).filter(([k])=>k!=="sha256"))))});
	const classified=(id:string,over:Row={},answer="synthetic: all old items go to work",fresh="")=>{
		const eid=`lw-${id.slice(0,8)}`,owner={reference:"synthetic owner decision",answer,roster_sha256:sha256(`synthetic roster${fresh}`)};
		const k={version:1,effect:"legacy_work_owner",profile:"work",owner_decision:owner,owner_decision_sha256:sha256(canonicalJson(owner)),
			witness:{export_manifest_sha256:sha256(`synthetic export${fresh}`),source_key_sha256:sha256(`bothq:${eid}`),source_row_sha256:sha256(`synthetic row${fresh}`),id,scope:"personal",memory_type:"project"}};
		return node(id,{attrs:{validity:"unknown",source:{system:"bothq",element_id:eid,owner_classification:k}},...over});
	};
	it("publishes only an exact Work classification and refuses another destination, wire version, witness or forged reserved field",async()=>{
		const {token}=await deviceToken("legacy-work",["import"],["work","personal"],"work"),c=await contextFor();
		const other=newMemoryId("test-user","test","personal","project","legacy-elsewhere"),elsewhere=commandsFor("personal",classified(other,{chars:5}),journal(other,0,()=>"").rows);
		expect((await send(token,[...elsewhere.stages,elsewhere.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"classification_witness"});
		const id=newMemoryId("test-user","test","personal","project","legacy-work"),j=journal(id,1,i=>`legacy-${i}`),n=classified(id,{revision:2,chars:j.content.length}),cmd=commandsFor("work",n,j.rows);
		expect(cmd.stages.every(s=>s.classification_version===1)&&cmd.finalize.classification_version===1).toBe(true);
		for(const st of cmd.stages) expect((await send(token,[st])).data.receipts[0]).toMatchObject({status:"stored"});
		expect((await send(token,[{...cmd.finalize,classification_version:2}])).status).toBe(400);
		const missing={...cmd.finalize} as Row;delete missing.classification_version;expect((await send(token,[rehash(missing)])).data.receipts[0]).toMatchObject({reason:"classification_version"});
		const scoped=structuredClone(cmd.finalize);(scoped.node.attrs as any).source.owner_classification.witness.scope="sequoia";expect((await send(token,[rehash(scoped)])).data.receipts[0]).toMatchObject({reason:"classification_witness"});
		const unsigned=structuredClone(cmd.finalize);(unsigned.node.attrs as any).source.owner_classification.owner_decision.answer="edited";expect((await send(token,[rehash(unsigned)])).data.receipts[0]).toMatchObject({reason:"classification_invalid"});
		expect((await send(token,[cmd.finalize])).data.receipts[0]).toMatchObject({status:"published"});
		expect((await send(token,[...cmd.stages,cmd.finalize])).data.receipts.every(r=>r.status==="replayed")).toBe(true);
		const got=await call<{scope:string;name:string;revision:number}>(c,"get_memory",{profile:"work",memory_id:id});expect([got.scope,got.name,got.revision]).toEqual(["personal",n.name,2]);
		const ordinary=commandsFor("work",node(id,{revision:2,chars:j.content.length}),j.rows);expect((await send(token,[ordinary.finalize])).data.receipts[0]).toMatchObject({reason:"classification_version"});
		const forged={kind:"project",name:"forged owner classification",attrs:{source:{owner_classification:{}}}};
		expect(await outcome(c,"record_knowledge",{profile:"work",nodes:[forged]})).toMatchObject({ok:false,error:{code:"validation"}});
		const who=c.account.profiles.find(p=>p.profile==="work")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:work:${who.generation}`)),(_i,s)=>{
			expect(()=>runWrite(s.storage,who,{op:"knowledge",args:{nodes:[forged as never],request_id:"forged-owner-classification"}},{actor:"owner",platform:"test",routedBy:"explicit",payloadHash:"forged-owner",userId:who.userId})).toThrow(/reserved for authenticated/);
		});
	});
	it("takes unchanged Work classification and source-policy witnesses into an admitted test profile, and still refuses Personal, me and changed witnesses",async()=>{
		const {token}=await deviceToken("legacy-rehearsal",["import"],["test","personal"],"test"),{token:workOnly}=await deviceToken("legacy-rehearsal-work",["import"],["work"],"work");
		const legacyCommands=(profile:string,label:string,edit?:(n:Row)=>void)=>{const id=newMemoryId("test-user","test","personal","project",`legacy-rehearsal-${label}`),j=journal(id,1,i=>`${label}-${i}`),n=classified(id,{revision:2,chars:j.content.length});edit?.(n);return {id,n,cmd:commandsFor(profile,n,j.rows)};};
		const t=legacyCommands("test","test");
		expect((await send(workOnly,[t.cmd.stages[0]])).data.receipts[0]).toMatchObject({status:"refused",reason:"forbidden"});
		expect((await send(token,[...t.cmd.stages,t.cmd.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		expect((await send(token,[...t.cmd.stages,t.cmd.finalize])).data.receipts.every(r=>r.status==="replayed")).toBe(true);
		expect(JSON.parse(String(await profileSql("test",sql=>sql.exec("SELECT attrs FROM nodes WHERE id = ?",t.id).one().attrs))).source.owner_classification).toEqual((t.n.attrs as any).source.owner_classification);
		const personal=legacyCommands("personal","personal");expect((await send(token,[...personal.cmd.stages,personal.cmd.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"classification_witness"});
		const me=legacyCommands("me","me");expect((await send(token,me.cmd.stages)).data.receipts[0]).toMatchObject({status:"refused",reason:"me"});
		const moved=legacyCommands("test","moved",n=>{(n.attrs as any).source.owner_classification.witness.scope="sequoia";});expect((await send(token,[...moved.cmd.stages,moved.cmd.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"classification_witness"});
		const reference=(profile:string,path:string,edit?:(f:ReturnType<typeof reviewedMarkdown>)=>void)=>{const f=reviewedMarkdown(path,"untrusted rehearsal reference");edit?.(f);return commandsFor(profile,f.node as unknown as Row,[...f.texts.map(x=>["texts",{...x}] as [Table,Row]),...f.revisions.map(r=>["revisions",{...r}] as [Table,Row])]);};
		const ref=reference("test","~/fixture-rehearsal/SKILL.md");expect((await send(token,[...ref.stages,ref.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		expect(((ref.finalize.node as any).attrs.import_review.witness.profile)).toBe("work");
		const elsewhere=reference("personal","~/fixture-rehearsal-personal/SKILL.md");expect((await send(token,[...elsewhere.stages,elsewhere.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"policy_witness"});
		const scoped=reference("test","~/fixture-rehearsal-scoped/SKILL.md",f=>{(f.node.attrs.import_review as any).witness.scope="elsewhere";});expect((await send(token,[...scoped.stages,scoped.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"policy_witness"});
	});
	const delta=(full:ReturnType<typeof journal>,known:ReturnType<typeof journal>,after:number)=>full.rows.filter(([t,r])=>t==="requests"?!known.requests.some(q=>q.request_id===r.request_id):Number(r.revision)>after);
	const imported=async(label:string,over:Row={})=>{
		const {token}=await deviceToken(`legacy-${label}`,["import"],["work","personal"],"work"),id=newMemoryId("test-user","test","personal","project",`legacy-${label}`),j=journal(id,1,i=>`${label}-${i}`);
		const n=classified(id,{revision:2,chars:j.content.length,...over}),cmd=commandsFor("work",n,j.rows);
		expect((await send(token,[...cmd.stages,cmd.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		return {token,id,j,n,cmd,next:(answer?:string)=>{const two=journal(id,2,i=>`${label}-${i}`);return {two,cmd:commandsFor("work",classified(id,{revision:3,chars:two.content.length,content_hash:sha256(two.content),...over},answer," fresh"),delta(two,j,2),{no:1,base_record_sha256:cmd.finalize.record_sha256,base_revision:2,base_content_hash:String(n.content_hash)})};}};
	};
	it("holds a classified refresh after hosted metadata drift, and still refreshes over null dates and derived embedding state",async()=>{
		const drift=await imported("metadata-drift");
		await profileSql("work",sql=>sql.exec("UPDATE nodes SET description = 'owner-reviewed metadata; preserve this' WHERE id = ?",drift.id).toArray());
		const held=drift.next().cmd;expect((await send(drift.token,[...held.stages,held.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"hosted_changed"});
		expect(await profileSql("work",sql=>sql.exec("SELECT revision, description FROM nodes WHERE id = ?",drift.id).one())).toMatchObject({revision:2,description:"owner-reviewed metadata; preserve this"});
		const derived=await imported("derived-control",{created_at:null,updated_at:null});
		await profileSql("work",sql=>sql.exec("UPDATE nodes SET embed_hash = card_hash, seq = seq + 1 WHERE id = ?",derived.id).toArray());
		const next=derived.next().cmd;expect((await send(derived.token,[...next.stages,next.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		expect((await send(derived.token,[next.finalize])).data.receipts[0]).toMatchObject({status:"replayed"});
	});
	it("refuses an import finalize replay after an owner pin, while a legacy request replay keeps its original result",async()=>{
		const b=await imported("pinned"),c=await contextFor(),who=c.account.profiles.find(p=>p.profile==="work")!,rid=b.j.requests[1]!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:work:${who.generation}`)),(_i,s)=>{
			runWrite(s.storage,who,{op:"owner",args:{action:"pin",memory_id:b.id,request_id:"legacy-pin"}},{actor:"owner",platform:"test",routedBy:"explicit",payloadHash:"legacy-pin",userId:who.userId});
		});
		expect(await profileSql("work",sql=>sql.exec("SELECT revision, pinned FROM nodes WHERE id = ?",b.id).one())).toMatchObject({revision:3,pinned:1});
		expect((await send(b.token,[b.cmd.finalize])).data.receipts[0]).toMatchObject({status:"refused",reason:"hosted_changed"});
		expect(await call(c,"append_memory",{profile:"work",memory_id:b.id,content:"pinned-0",separator:"\n",request_id:rid.request_id})).toMatchObject({action:"replayed",revision:2});
		expect(await profileSql("work",sql=>sql.exec("SELECT result FROM requests WHERE request_id = ?",rid.request_id).one().result)).toBe(rid.result);
	});
	it("refuses a stage without classification_version before any account reservation, so the request stays usable",async()=>{
		const b=await imported("preflight"),{two,cmd}=b.next(),rid=two.requests.at(-1)!.request_id;
		const stage={...cmd.stages[0]} as Row;delete stage.classification_version;stage.sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(stage).filter(([k])=>k!=="sha256"&&k!=="part_id"))));
		expect(await accountSql(sql=>sql.exec("SELECT count(*) AS n FROM request_index WHERE request_id = ?",rid).one().n)).toBe(0);
		expect((await send(b.token,[stage])).data.receipts[0]).toMatchObject({status:"refused",reason:"classification_version"});
		expect(await accountSql(sql=>sql.exec("SELECT profile, pending, legacy FROM request_index WHERE request_id = ?",rid).toArray())).toEqual([]);
		expect(await profileSql("work",sql=>sql.exec("SELECT count(*) AS n FROM import_refreshes WHERE record_id = ?",b.id).one().n)).toBe(0);
		expect(await outcome(await contextFor(),"append_memory",{profile:"work",memory_id:b.id,content:"actual requested write",request_id:rid})).toMatchObject({ok:true});
	});
	it("refreshes the same identity with a fresh witness and refuses a changed classification or in-place adoption of an existing copy",async()=>{
		const {token}=await deviceToken("legacy-work-refresh",["import"],["work","personal"],"work");
		const id=newMemoryId("test-user","test","personal","project","legacy-refresh"),j=journal(id,1,i=>`old-${i}`),n=classified(id,{revision:2,chars:j.content.length});
		const base=commandsFor("work",n,j.rows);expect((await send(token,[...base.stages,base.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		const two=journal(id,2,i=>`old-${i}`),fresh=classified(id,{revision:3,chars:two.content.length,content_hash:sha256(two.content)},undefined," fresh");
		const next=commandsFor("work",fresh,delta(two,j,2),{no:1,base_record_sha256:base.finalize.record_sha256,base_revision:2,base_content_hash:String(n.content_hash)});
		expect((await send(token,[...next.stages,next.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		const three=journal(id,3,i=>`old-${i}`),changed=classified(id,{revision:4,chars:three.content.length,content_hash:sha256(three.content)},"another answer"," fresh");
		const drift=commandsFor("work",changed,delta(three,two,3),{no:2,base_record_sha256:next.finalize.record_sha256,base_revision:3,base_content_hash:String(fresh.content_hash)});
		expect((await send(token,[...drift.stages,drift.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"classification_changed"});
		const plain=newMemoryId("test-user","test","personal","project","legacy-plain"),pj=journal(plain,0,()=>""),pn=node(plain,{scope:"personal",chars:5});
		const copy=commandsFor("work",pn,pj.rows);expect((await send(token,[...copy.stages,copy.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		const adopt=commandsFor("work",classified(plain,{chars:5}),[],{no:1,base_record_sha256:copy.finalize.record_sha256,base_revision:1,base_content_hash:String(pn.content_hash)});
		expect((await send(token,[...adopt.stages,adopt.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"classification_changed"});
		const mine=newMemoryId("test-user","test","personal","project","legacy-personal-copy"),rows=journal(mine,0,()=>"").rows.filter(([t])=>t!=="requests");
		const personal=commandsFor("personal",node(mine,{chars:5}),rows);expect((await send(token,[...personal.stages,personal.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
		const moved=commandsFor("work",classified(mine,{chars:5}),rows);expect((await send(token,[...moved.stages,moved.finalize])).data.receipts.at(-1)).toMatchObject({status:"refused",reason:"node_conflict"});
		expect(await profileSql("work",sql=>sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?",mine).one().n)).toBe(0);
	});
});


describe("combined classified policy date controls", () => {
 const make = (path:string, kind:"source_suffix"|"archival_reference", unknown:boolean, fresh:number) => {
  const f=reviewedMarkdown(path,"unchanged synthetic policy body",kind);
  const source=f.node.attrs.source as Row, policy=f.node.attrs.import_review as any;
  f.node.scope=`synthetic-combined-${kind}-${unknown}`;policy.witness.scope=f.node.scope;
  if(unknown){source.birthtime=null;source.mtime=null;f.node.created_at=null;f.node.updated_at=null;}
  const owner={reference:"synthetic owner decision 454",answer:"all old items to Work",roster_sha256:sha256(`synthetic roster ${fresh}`)};
  const k={version:1,effect:"legacy_work_owner",profile:"work",owner_decision:owner,owner_decision_sha256:sha256(canonicalJson(owner)),
   witness:{export_manifest_sha256:sha256(`synthetic export ${fresh}`),source_key_sha256:sha256(`${source.system}:${path}`),source_row_sha256:sha256(`synthetic source ${fresh}`),id:f.node.id,scope:f.node.scope,memory_type:f.node.memory_type}};
  source.owner_classification=k;
  policy.witness.export_manifest_sha256=k.witness.export_manifest_sha256;policy.witness.source_row_sha256=k.witness.source_row_sha256;
  if(kind==="archival_reference")policy.profile_review_sha256=sha256(canonicalJson(k));
  return f;
 };
 for(const [kind,unknown] of [["source_suffix",true],["archival_reference",true],["archival_reference",false]] as const) {
  it(`${kind} ${unknown?"unknown":"known"} source dates refresh and replay`,async()=>{
   const path=`~/synthetic-combined-${kind}-${unknown}/MEMORY.md`,f=make(path,kind,unknown,0);
   const {token}=await deviceToken(`combined-${kind}-${unknown}`,["import"],["work"],"work");
   const rows:[Table,Row][]=[...f.texts.map(t=>["texts",{...t}] as [Table,Row]),...f.revisions.map(r=>["revisions",{...r}] as [Table,Row])];
   const first=commandsFor("work",f.node as unknown as Row,rows);
   expect((await send(token,[...first.stages,first.finalize])).data.receipts.at(-1)).toMatchObject({status:"published"});
   expect((await send(token,[first.finalize])).data.receipts[0]).toMatchObject({status:"replayed"});
   const original=await profileSql("work",sql=>sql.exec("SELECT n.created_at,n.updated_at,r.published_at FROM nodes n JOIN import_records r ON r.record_id=n.id WHERE n.id = ?",f.node.id).one());
   const next=make(path,kind,unknown,1);
   const refresh=commandsFor("work",next.node as unknown as Row,[],{no:1,base_record_sha256:first.finalize.record_sha256,base_revision:1,base_content_hash:f.node.content_hash});
   const r1=(await send(token,[...refresh.stages,refresh.finalize])).data.receipts;
   expect(r1.at(-1)).toMatchObject({status:"published"});
   const after=await profileSql("work",sql=>sql.exec("SELECT n.created_at,n.updated_at,r.published_at FROM nodes n JOIN import_refreshes r ON r.record_id=n.id AND r.refresh_no=1 WHERE n.id = ?",f.node.id).one());
   expect(after.published_at).not.toBe(original.published_at);
   const replay=(await send(token,[refresh.finalize])).data.receipts[0];
   const last=make(path,kind,unknown,2);
   const refresh2=commandsFor("work",last.node as unknown as Row,[],{no:2,base_record_sha256:refresh.finalize.record_sha256,base_revision:1,base_content_hash:f.node.content_hash});
   const r2=(await send(token,[...refresh2.stages,refresh2.finalize])).data.receipts;
   console.log(JSON.stringify({kind,unknown,original,after,r1,replay,r2}));
   expect.soft(replay).toMatchObject({status:"replayed"});
   expect.soft(r2.at(-1)).toMatchObject({status:"published"});
   const held=await profileSql("work",sql=>sql.exec("SELECT revision, created_at, updated_at FROM nodes WHERE id = ?",f.node.id).one());
   expect(held.created_at).toBe(original.created_at);
   const latest=await profileSql("work",sql=>sql.exec<{published_at:string}>("SELECT published_at FROM import_refreshes WHERE record_id = ? AND refresh_no = 2",f.node.id).one());
   expect(latest.published_at).not.toBe(original.published_at);
   await profileSql("work",sql=>sql.exec("UPDATE nodes SET created_at = ? WHERE id = ?",latest.published_at,f.node.id).toArray());
   expect((await send(token,[refresh2.finalize])).data.receipts[0]).toMatchObject({status:"refused",reason:"hosted_changed"});
  });
 }
});
