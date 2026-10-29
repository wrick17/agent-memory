// The staged BothQ import through the real /v1/import endpoint, Workers SQLite Durable Objects and AccountStore
// (docs/import-implementation.md). Synthetic records only; the part shapes are the real largest parts' lengths, no text.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalJson, newMemoryId, sha256 } from "../src/domain/ids";
import { pack, type Table } from "../src/domain/import-cost";
import { legacyRequestHash } from "../src/domain/legacy";
import { migrate } from "../src/storage";
import { PROFILE_MIGRATIONS } from "../src/profile/schema";
import { ACCOUNT_MIGRATIONS } from "../src/account/schema";
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
function commandsFor(profile: string, n: Row, rows: [Table, Row][]) {
	const parts = pack(rows);
	const recordSha = sha256(canonicalJson({ profile, node: n, parts: parts.map((p) => p.rows) }));
	const stages = parts.map((p, i) => {
		const body = { op: "stage", record_id: n.id, record_sha256: recordSha, profile, part: i + 1, parts: parts.length, rows: p.rows, cost: p.cost };
		return { ...body, part_id: `${n.id}:${recordSha.slice(0, 16)}:${i + 1}`, sha256: sha256(canonicalJson(body)) };
	});
	const fin = { op: "finalize", record_id: n.id, record_sha256: recordSha, profile, node: n, parts: stages.map((s) => ({ part_id: s.part_id, sha256: s.sha256 })),
		request_ids: rows.filter(([t]) => t === "requests").map(([, q]) => q.request_id) };
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

describe("schema v3", () => {
	it("upgrades a v2 profile in place and keeps every revision and request", async () => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "personal")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`)), (_i, s) => {
			const sql = s.storage.sql;
			// Put this profile back into its deployed v2 shape, with v2 data, then run the migrations again.
			for (const q of ["DROP TRIGGER nodes_import_fence", "DROP TABLE import_records", "DROP TABLE import_parts", "DROP INDEX requests_node", "ALTER TABLE requests DROP COLUMN completed_at", "ALTER TABLE requests DROP COLUMN source", "DROP TABLE revisions"]) sql.exec(q);
			for (const q of PROFILE_MIGRATIONS[0]!.filter((x) => /\brevisions\b/.test(x))) sql.exec(q);
			sql.exec("UPDATE profile_meta SET value = '2' WHERE key = 'schema_version'");
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq) VALUES ('n-v2', 1, 'saved', '{\"content\":\"kept\"}', 'r-v2', 'agent', 'd1', ?, 7)", AT);
			sql.exec("INSERT INTO requests (request_id, op, payload_hash, result, node_id, at, seq) VALUES ('r-v2', 'save_memory', 'h', '{\"ok\":true}', 'n-v2', ?, 7)", AT);
			migrate(s.storage, "profile_meta", PROFILE_MIGRATIONS);
			expect(sql.exec("SELECT value FROM profile_meta WHERE key = 'schema_version'").one().value).toBe("3");
			expect(sql.exec("SELECT node_id, revision, op, snapshot, request_id, actor, device_id, at, seq, delta, revision_id FROM revisions WHERE node_id = 'n-v2'").toArray())
				.toEqual([{ node_id: "n-v2", revision: 1, op: "saved", snapshot: '{"content":"kept"}', request_id: "r-v2", actor: "agent", device_id: "d1", at: AT, seq: 7, delta: null, revision_id: null }]);
			expect(sql.exec("SELECT request_id, payload_hash, result, completed_at FROM requests WHERE request_id = 'r-v2'").one()).toEqual({ request_id: "r-v2", payload_hash: "h", result: '{"ok":true}', completed_at: null });
			// The rebuilt table takes BothQ's operations and keeps its tombstone triggers.
			sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('write_seq', '8')");
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES ('n-v2', 2, 'appended', '{}', 'migration', ?, 8)", AT);
			sql.exec("DELETE FROM revisions WHERE node_id = 'n-v2' AND revision = 2");
			expect(sql.exec("SELECT count(*) AS n FROM deleted_rows WHERE tbl = 'revisions'").one().n).toBe(1);
		});
	});
});

describe("account schema v2", () => {
	it("upgrades a v1 account in place and keeps every modern binding as it was", async () => {
		await contextFor();
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)), (_i, s) => {
			const sql = s.storage.sql;
			// Back to the deployed v1 shape, with a v1 binding, then run the migrations again.
			for (const q of ["ALTER TABLE request_index DROP COLUMN pending", "ALTER TABLE request_index DROP COLUMN legacy"]) sql.exec(q);
			sql.exec("UPDATE account_meta SET value = '1' WHERE key = 'schema_version'");
			sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES ('v1-binding', 'personal', 'save_memory', 'hash-v1', ?, 1)", AT);
			migrate(s.storage, "account_meta", ACCOUNT_MIGRATIONS);
			expect(sql.exec("SELECT value FROM account_meta WHERE key = 'schema_version'").one().value).toBe("2");
			expect(sql.exec("SELECT request_id, profile, op, payload_hash, at, seq, legacy, pending FROM request_index WHERE request_id = 'v1-binding'").one())
				.toEqual({ request_id: "v1-binding", profile: "personal", op: "save_memory", payload_hash: "hash-v1", at: AT, seq: 1, legacy: 0, pending: 0 });
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

