// AM-14 corpus vertical: the real Worker fetch with CORPUS on, its CorpusStore objects, and the local uploader core.
// Synthetic rows only. The source is a throwaway CorpusStore SQLite, whose tables carry the retained original DDL byte for byte.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/domain/ids";
import { refresh as reviewedRefresh } from "../src/corpus/refresh";
import type { Outcome } from "../src/domain/types";
import worker from "../src/worker";
// @ts-expect-error local/ is plain JavaScript without declarations
import { chains, refreshCorpus, seedOf } from "../local/corpus-refresh.mjs";
// @ts-expect-error local/ is plain JavaScript without declarations
import { uploadCorpus } from "../local/corpus-upload.mjs";
import { call, contextFor, deviceToken, OWNER } from "./helpers";

const origin = new URL(env.RESOURCE_URL).origin;
const AS_OF = "2026-08-12T13:30:59.154Z";
const FILE = "ab".repeat(32);
const sha = (n: number) => n.toString(16).padStart(40, "0");
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
type Json = Record<string, any>;

/** A fresh active profile on the owner's account, an import token and a read token for it alone, and the env with CORPUS on. */
async function isolated() {
	await contextFor();
	const name = `cp${rand()}`, generation = rand();
	await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => {
		const now = new Date().toISOString(), sql = s.storage.sql;
		sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${generation}`, generation, now);
		sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", generation, name, now);
	});
	const importer = (await deviceToken(`imp-${name}`, ["import"], [name])).token;
	const reader = (await deviceToken(`rd-${name}`, ["read"], [name])).token;
	const on = { ...env, CORPUS: "on", IMPORT_PROFILES: `${env.IMPORT_PROFILES},${name}` } as Env;
	const fetchOn = (req: Request, e: Env = on) => worker.fetch(req as Parameters<typeof worker.fetch>[0], e);
	const http = async (token: string, path: string, body?: unknown, e: Env = on) => {
		const res = await fetchOn(new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), e);
		return { status: res.status, data: await res.json() as Json };
	};
	const client = { status: async (p: string) => (await http(importer, `/v1/corpus/status?profile=${p}`)).data, send: async (c: unknown) => (await http(importer, "/v1/corpus/import", c)).data };
	let rpcId = 1;
	const rpc = async (method: string, params: Json = {}, token = reader, e: Env = on) => {
		const res = await fetchOn(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) }), e);
		const text = await res.text();
		const sse = text.split("\n").find((l) => l.startsWith("data: "));
		return JSON.parse(text.startsWith("{") ? text : sse!.slice(6)) as Json;
	};
	const tool = async (args: Json) => {
		const r = (await rpc("tools/call", { name: "corpus", arguments: { profile: name, ...args } })).result as { content: { text: string }[]; isError?: boolean };
		return { error: r.isError === true, value: (r.isError ? JSON.parse(r.content[0]!.text) : JSON.parse(r.content[0]!.text).data) as Json, bytes: Buffer.byteLength(r.content[0]!.text) };
	};
	const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${generation}`));
	const inCorpus = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(store, (_i, s) => f(s.storage.sql));
	return { name, generation, who: { userId: OWNER, profile: name, generation }, on, http, client, rpc, tool, inCorpus, importer, reader };
}

/** A synthetic source with the original DDL: a CorpusStore object nobody binds, filled directly. */
async function syntheticSource(fill: (sql: SqlStorage) => void = seed) {
	const stub = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`source:${crypto.randomUUID()}`));
	const inSource = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(stub, (_i, s) => f(s.storage.sql));
	await inSource(fill);
	return {
		inSource,
		source: {
			schema: (t: string) => inSource((sql) => { const r = sql.exec<{ type: string; sql: string }>("SELECT type, sql FROM sqlite_master WHERE name = ?", t).toArray()[0]; return r?.type === "table" ? r.sql : null; }),
			columns: (t: string) => inSource((sql) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_xinfo(?)", t).toArray().map((r) => r.name)),
			rows: (t: string, cols: string[], key: string[], after: unknown[] | null, limit: number) => inSource((sql) => [...sql.exec(`SELECT ${cols.join(", ")} FROM ${t}${after ? ` WHERE (${key.join(", ")}) > (${after.map(() => "?").join(", ")})` : ""} ORDER BY ${key.join(", ")} LIMIT ?`,
				...(after ?? []) as SqlStorageValue[], limit).raw()]),
			repoRows: (t: string, cols: string[], repo: string, column?: string) => inSource((sql) => [...sql.exec(`SELECT ${cols.join(", ")} FROM ${t} WHERE ${column ?? (t === "repos" ? "full_name" : "repo")} = ?`, repo).raw()]),
		},
	};
}

function seed(sql: SqlStorage) {
	sql.exec(`INSERT INTO repos (rowid, full_name, owner, name, description, archived, private, language, default_branch, updated_at, url, commit_count, ref_count, head_sha, earliest_date, latest_date, empty)
		VALUES (1, 'acme/web', 'acme', 'web', 'The web app; owner ops@acme.example', 0, 1, 'TypeScript', 'main', '2026-08-01T00:00:00Z', 'https://github.com/acme/web', 2, 1, ?, '2026-07-01', '2026-08-01', 0)`, sha(2));
	sql.exec(`INSERT INTO commits VALUES ('acme/web', ?, '[]', 'Alice', 'alice@acme.example', '2026-07-01T10:00:00Z', 'Alice', 'alice@acme.example', '2026-07-01T10:00:00Z',
		'Fix the token refresh loop', 'Fix the token refresh loop\n\nCo-authored-by: Bob <bob@acme.example>\ntoken=hunter2secret', 0, 0, 12, NULL)`, sha(1));
	sql.exec(`INSERT INTO commits VALUES ('acme/web', ?, ?, 'Bob', 'bob@acme.example', '2026-08-01T09:00:00Z', 'Bob', 'bob@acme.example', '2026-08-01T09:00:00Z',
		'Add retry backoff', 'Add retry backoff', 0, 0, NULL, NULL)`, sha(2), JSON.stringify([sha(1)]));
	sql.exec("INSERT INTO refs VALUES ('acme/web', 'refs/heads/main', 'heads', 'main', ?, 'commit', '2026-08-01T09:00:00Z', 'Bob', 'bob@acme.example', 'Add retry backoff')", sha(2));
	for (const [s, p, top, ext] of [[1, "src/app.ts", "src", "ts"], [1, "src/auth/token.ts", "src", "ts"], [2, "src/auth/token.ts", "src", "ts"]] as const) sql.exec("INSERT INTO commit_paths VALUES ('acme/web', ?, ?, ?, ?)", sha(s), p, top, ext);
	sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (1, 'acme/web', 1, 1, 'Alice', 'alice@acme.example'), (2, 'acme/web', 2, 1, 'Bob', 'bob@acme.example')");
}

const TABLES = ["repos", "commits", "refs", "commit_paths", "contributors"];

describe("corpus main flow", () => {
	it("loads a synthetic sample through the uploader and answers get, search and sql with as_of over /mcp", async () => {
		const p = await isolated();
		const { source } = await syntheticSource();
		const state: Json = {};
		const out = await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state, chunkRows: 2 });
		expect(out).toMatchObject({ status: "done", generation: p.generation });
		expect(state.tables).toEqual({
			repos: { last_key: [1], rows: 1, complete: true }, commits: { last_key: ["acme/web", sha(2)], rows: 2, complete: true },
			refs: { last_key: ["acme/web", "refs/heads/main"], rows: 1, complete: true }, commit_paths: { last_key: ["acme/web", sha(2), "src/auth/token.ts"], rows: 3, complete: true },
			contributors: { last_key: [2], rows: 2, complete: true },
		});
		// Sample row counts match the source, and no contact field or secret reached the store.
		const counts = await p.inCorpus((sql) => Object.fromEntries(TABLES.map((t) => [t, sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n])));
		expect(counts).toEqual({ repos: 1, commits: 2, refs: 1, commit_paths: 3, contributors: 2 });
		const dump = await p.inCorpus((sql) => JSON.stringify(TABLES.concat("corpus_search_documents").map((t) => sql.exec(`SELECT * FROM ${t}`).toArray())));
		expect(dump).not.toMatch(/@acme\.example|hunter2/);

		const listed = await p.rpc("tools/list");
		expect((listed.result.tools as { name: string }[]).map((t) => t.name)).toContain("corpus");
		const got = await p.tool({ action: "get", kind: "commit", key: `acme/web@${sha(1)}` });
		expect(got.error).toBe(false);
		expect(got.value).toMatchObject({ profile: p.name, action: "get", found: true, paths_truncated: false,
			commits: [{ repo: "acme/web", sha: sha(1), subject: "Fix the token refresh loop", message: "Fix the token refresh loop\n\nCo-authored-by: Bob <[REDACTED]>\ntoken=[REDACTED]", pr_number: 12 }] });
		expect(got.value.commits[0]).not.toHaveProperty("author_email");
		expect(got.value.paths.map((r: Json) => r.path)).toEqual(["src/app.ts", "src/auth/token.ts"]);
		const snapshot = { as_of: AS_OF, as_of_max: AS_OF, basis: "declared_snapshot", refresh: "snapshot", complete: true, source_sha256: FILE, partitions: 1 };
		expect(got.value.as_of).toEqual({ commit_paths: { ...snapshot, rows: 3 }, commits: { ...snapshot, rows: 2 } });
		expect(got.value.repo_as_of).toEqual({ commits: AS_OF, commit_paths: AS_OF });

		const found = await p.tool({ action: "search", query: "token" });
		expect(found.value.results.map((r: Json) => r.evidence_id).sort()).toEqual([`commit:commits:acme/web@${sha(1)}`, "path:commit_paths:acme/web:src/auth/token.ts"]);
		expect(Object.keys(found.value.as_of).sort()).toEqual(["commit_paths", "commits"]);
		const repo = await p.tool({ action: "get", kind: "repo", key: "acme/web" });
		expect(repo.value).toMatchObject({ found: true, repos: [{ rowid: 1, full_name: "acme/web", description: "The web app; owner [REDACTED]" }], contributors: [{ name: "Alice" }, { name: "Bob" }] });

		const q = await p.tool({ action: "sql", sql: "SELECT c.sha, count(p.path) AS paths FROM commits c JOIN commit_paths p ON p.repo = c.repo AND p.sha = c.sha GROUP BY c.sha ORDER BY c.sha" });
		expect(q.value).toMatchObject({ columns: ["sha", "paths"], rows: [[sha(1), 2], [sha(2), 1]], truncated: false, tables_read: ["commit_paths", "commits"] });
		expect(Object.keys(q.value.as_of)).toEqual(["commit_paths", "commits"]);
	});

	it("adds corpus counts to explore of a project or commit node, with as_of, only while the corpus is on", async () => {
		const p = await isolated();
		const { source } = await syntheticSource();
		await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state: {} });
		await call(await contextFor(), "record_knowledge", { profile: p.name, nodes: [{ kind: "project", key: "github:acme/web", name: "acme/web" },
			{ kind: "commit", key: `git:acme/web@${sha(1)}`, name: "Fix the token refresh loop" }, { kind: "project", key: "github:o'x/y", name: "quoted" }, { kind: "person", name: "Alice" }] });
		const explore = async (key: string, e?: Env) => {
			const r = (await p.rpc("tools/call", { name: "explore", arguments: { profile: p.name, node: { key } } }, p.reader, e)).result as { content: { text: string }[]; isError?: boolean };
			expect(r.isError).not.toBe(true);
			return JSON.parse(r.content[0]!.text).data as Json;
		};
		const repo = await explore("github:acme/web");
		expect(repo.corpus).toMatchObject({ profile: p.name, kind: "repo", key: "acme/web", counts: { repos: 1, commits: 2, refs: 1, commit_paths: 3, contributors: 2 } });
		expect(Object.keys(repo.corpus.as_of)).toEqual(["commit_paths", "commits", "contributors", "refs", "repos"]);
		expect((await explore(`git:acme/web@${sha(1)}`)).corpus).toMatchObject({ kind: "commit", key: `acme/web@${sha(1)}`, counts: { commits: 1, commit_paths: 2 } });
		// A quote in a stored key stays a literal; it neither escapes nor errors.
		expect((await explore("github:o'x/y")).corpus).toMatchObject({ key: "o'x/y", counts: { repos: 0, commits: 0, refs: 0, commit_paths: 0, contributors: 0 } });
		const off = await explore("github:acme/web", env);
		expect(off).not.toHaveProperty("corpus");
		expect(off.node).toMatchObject({ key: "github:acme/web" });
	});
});

/** A valid chunk body built like the uploader builds it, for direct protocol checks. */
async function body(p: Awaited<ReturnType<typeof isolated>>, table: string, rows: unknown[][], over: Json = {}) {
	const st = await p.client.status(p.name);
	const fam = st.families.find((f: Json) => f.table === table);
	const { chunkHash } = await import("../src/corpus/families");
	const c = { profile: p.name, generation: p.generation, table, schema_sha256: fam?.schema_sha256 ?? "0".repeat(64), source: { file_sha256: FILE }, as_of: AS_OF, columns: fam?.columns ?? ["x"], after: null, rows, final: false, ...over };
	return { ...c, sha256: over.sha256 ?? chunkHash(c as never) };
}
const commit = (n: number, message = "plain", over: Json = {}) => ({ ...Object.fromEntries(Object.entries({ repo: "acme/web", sha: sha(n), parents: "[]", author_name: "Alice", author_date: "2026-07-01T10:00:00Z",
	committer_name: "Alice", committer_date: "2026-07-01T10:00:00Z", subject: `subject ${n}`, message, is_merge: 0, is_revert: 0, pr_number: null, cherry_pick_source: null })), ...over });
const row = (o: Json) => Object.values(o);
/** The store's own argument: the HTTP body without its routing fields. */
const chunkOf = (b: Json) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "profile" && k !== "generation")) as never;

describe("corpus load controls", () => {
	it("replays a resent chunk, refuses a changed one, and resumes an interrupted upload without duplicates", async () => {
		const p = await isolated();
		const { source } = await syntheticSource();
		// The connection drops after the third chunk is stored: the server keeps it, the client never sees the receipt.
		let sends = 0;
		const flaky = { status: p.client.status, send: async (c: Json) => { const r = await p.client.send(c); if (++sends === 3) throw new Error("connection reset"); return r; } };
		const state: Json = {};
		expect(await uploadCorpus({ source, client: flaky, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state, chunkRows: 1 })).toMatchObject({ status: "stopped", table: "commits", reason: "connection reset" });
		expect(state.tables.commits).toEqual({ last_key: ["acme/web", sha(1)], rows: 1, complete: false });
		const resumed = await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state, chunkRows: 1 });
		expect(resumed.status).toBe("done");
		expect(await p.inCorpus((sql) => sql.exec<{ n: number }>("SELECT (SELECT count(*) FROM commits) + (SELECT count(*) FROM commit_paths) + (SELECT count(*) FROM contributors) AS n").one().n)).toBe(7);
		// A rerun of a finished load sends nothing and changes nothing.
		const before = await p.inCorpus((sql) => sql.exec("SELECT request_id, sha256 FROM corpus_requests ORDER BY request_id").toArray());
		expect(await uploadCorpus({ source, client: { status: p.client.status, send: () => { throw new Error("no send expected"); } }, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state, chunkRows: 1 })).toMatchObject({ status: "done" });
		expect(before).toHaveLength(9);
		expect(await p.inCorpus((sql) => sql.exec("SELECT request_id, sha256 FROM corpus_requests ORDER BY request_id").toArray())).toEqual(before);

		const q = await isolated();
		const first = await body(q, "commits", [row(commit(1))]);
		const stored = await q.http(q.importer, "/v1/corpus/import", first);
		expect(stored.data.receipt).toMatchObject({ status: "stored", request_id: `corpus:commits:k${(await import("../src/domain/ids")).sha256(JSON.stringify(["acme/web", sha(1)])).slice(0, 32)}`, rows: 1, complete: false });
		expect((await q.http(q.importer, "/v1/corpus/import", first)).data.receipt).toMatchObject({ status: "replayed", rows: 1, sha256: first.sha256 });
		const changed = await body(q, "commits", [row(commit(1, "rewritten"))]);
		expect(await q.http(q.importer, "/v1/corpus/import", changed)).toMatchObject({ status: 409, data: { error: { code: "idempotency_mismatch" } } });
		// Gaps, reordering and a second source are refused; nothing is appended blindly.
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(3))]))).data.error.details).toMatchObject({ reason: "out_of_order", expected_after: ["acme/web", sha(1)] });
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(3)), row(commit(2))], { after: ["acme/web", sha(1)] }))).data.error.details.reason).toBe("order");
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(2))], { after: ["acme/web", sha(1)], as_of: "2026-09-07T10:26:00.162Z" }))).data.error.details.reason).toBe("source_changed");
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(2))], { after: ["acme/web", sha(1)], source: { file_sha256: "cd".repeat(32) } }))).data.error.details.reason).toBe("source_changed");
		expect((await q.http(q.importer, "/v1/corpus/import", { ...await body(q, "commits", [row(commit(2))], { after: ["acme/web", sha(1)] }), sha256: "0".repeat(64) })).data.error.details.reason).toBe("hash_mismatch");
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(2))], { after: ["acme/web", sha(1)], final: true }))).data.receipt).toMatchObject({ status: "stored", complete: true });
		expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [row(commit(4))], { after: ["acme/web", sha(2)] }))).data.error.details.reason).toBe("table_complete");
	});

	it("enforces the row, byte, type and privacy budgets, refusing and never rewriting", async () => {
		const p = await isolated();
		const post = async (b: unknown) => p.http(p.importer, "/v1/corpus/import", b);
		expect((await post(await body(p, "commits", Array.from({ length: 5001 }, (_, i) => row(commit(i + 1)))))).status).toBe(400);
		expect(await post(JSON.stringify(await body(p, "commits", [row(commit(1, "x".repeat(1_000_001)))])))).toMatchObject({ status: 413, data: { error: { details: { reason: "chunk_bytes" } } } });
		const reason = async (rows: unknown[][], over: Json = {}) => (await post(await body(p, "commits", rows, over))).data.error?.details?.reason;
		expect(await reason([row(commit(1)).slice(1)])).toBe("row_shape");
		expect(await reason([row(commit(1, "plain", { is_merge: "no" }))])).toBe("row_type");
		expect(await reason([row(commit(1, "plain", { is_merge: 1.5 }))])).toBe("row_type");
		expect(await reason([row(commit(1, "plain", { sha: null }))])).toBe("row_key");
		expect(await reason([row(commit(1, "Co-authored-by: Bob <bob@acme.example>"))])).toBe("needs_redaction");
		expect(await reason([row(commit(1, "Authorization: Bearer abcdefghijklmnop"))])).toBe("needs_redaction");
		expect(await reason([row(commit(1, "plain", { repo: "bob@acme.example/web" }))])).toBe("row_key_private");
		// Contact columns cannot be named, under the original name or by widening the projection.
		const st = await p.client.status(p.name);
		const fam = st.families.find((f: Json) => f.table === "commits");
		expect(await reason([[...row(commit(1)), "alice@acme.example"]], { columns: [...fam.columns, "author_email"] })).toBe("columns");
		expect(await reason([row(commit(1))], { schema_sha256: "1".repeat(64) })).toBe("schema_mismatch");
		expect(await p.inCorpus((sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM commits").one().n)).toBe(0);
	});
});

describe("corpus refusals by lineage", () => {
	it("refuses forbidden, derived, held and renamed tables by name, before any read, and copied evidence ids by value", async () => {
		const p = await isolated();
		const names = ["session_messages", "session_decisions", "user_directives", "Session_Messages", "safe_session_messages", "session_messages_v2", "main.session_messages", "user directives",
			"directive_relations", "corpus_search_documents", "corpus_search_fts", "corpus_search_fts_docsize", "corpus_search_fts_data", "session_reference_index", "corpus_metadata",
			"corpus_search_manifest", "sqlite_stat1", "commits; DROP TABLE commits", "__proto__", "constructor", "sqlite_master", "corpus_meta", "corpus_requests"];
		for (const table of names) {
			const r = await p.http(p.importer, "/v1/corpus/import", await body(p, table, []));
			expect([table, r.status, r.data.error.code]).toEqual([table, 403, "forbidden"]);
		}
		// The v5 record tables load only as dated snapshots under their exact DDL; a chunk without it is refused by the snapshot check.
		for (const table of ["codex_sessions", "pull_requests", "tickets"]) {
			const r = await p.http(p.importer, "/v1/corpus/import", await body(p, table, []));
			expect([table, r.status, r.data.error.details.reason]).toEqual([table, 400, "schema_mismatch"]);
		}
		expect((await p.http(p.importer, "/v1/corpus/import", await body(p, "session_messages", []))).data.error.details.reason).toBe("never_import");
		expect((await p.http(p.importer, "/v1/corpus/import", await body(p, "corpus_search_documents", []))).data.error.details.reason).toBe("session_derived");
		expect((await p.http(p.importer, "/v1/corpus/import", await body(p, "Session_Messages", []))).data.error.details.reason).toBe("never_import");
		// The uploader refuses before reading anything, even when the server would be asked last.
		let reads = 0;
		const watched = { schema: () => { reads++; return null; }, columns: () => { reads++; return []; }, rows: () => { reads++; return []; } };
		expect(await uploadCorpus({ source: watched, client: p.client, profile: p.name, tables: ["repos", "user_directives"], asOf: AS_OF, fileSha256: FILE })).toMatchObject({ status: "refused", reason: "never_import" });
		expect(reads).toBe(0);
		expect(await uploadCorpus({ source: watched, client: p.client, profile: p.name, tables: ["repos"], asOf: AS_OF, fileSha256: FILE })).toMatchObject({ status: "refused", reason: "schema_mismatch" });
		expect(reads).toBe(1);
		for (const t of ["Session_Messages", "session_decisions_copy", "pull_requests"]) expect((await uploadCorpus({ source: watched, client: p.client, profile: p.name, tables: [t], asOf: AS_OF, fileSha256: FILE })).status).toBe("refused");
		expect(reads).toBe(1);
		// A view or a renamed table under an approved name does not carry the original DDL, so the uploader holds it.
		const renamed = await syntheticSource((sql) => { sql.exec("DROP TABLE refs"); sql.exec("CREATE VIEW refs AS SELECT session_id AS repo FROM (SELECT 'x' AS session_id)"); });
		expect(await uploadCorpus({ source: renamed.source, client: p.client, profile: p.name, tables: ["refs"], asOf: AS_OF, fileSha256: FILE })).toMatchObject({ status: "refused", table: "refs", reason: "schema_mismatch" });
		// A legacy session search document copied into an approved column is refused by its evidence id.
		const doc = await p.http(p.importer, "/v1/corpus/import", await body(p, "commits", [row(commit(1, "session:session_messages:019a-uuid:12 raw prefix"))]));
		expect(doc.data.error.details.reason).toBe("forbidden_lineage");
		expect(await p.inCorpus((sql) => sql.exec<{ n: number }>("SELECT (SELECT count(*) FROM corpus_meta) + (SELECT count(*) FROM corpus_search_documents) AS n").one().n)).toBe(0);
		// Raw session tables stay absent; v5 creates only the approved session metadata table.
		expect(await p.inCorpus((sql) => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_messages','session_decisions','user_directives','directive_relations','codex_sessions')").toArray())).toEqual([{ name: "codex_sessions" }]);
	});
});

async function loaded() {
	const p = await isolated();
	const { source } = await syntheticSource();
	const state: Json = {};
	expect((await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state })).status).toBe("done");
	return { ...p, state, source };
}
const counts = (sql: SqlStorage) => sql.exec("SELECT table_name, rows, last_key, complete FROM corpus_meta ORDER BY table_name").toArray()
	.concat(sql.exec("SELECT count(*) AS commits, (SELECT count(*) FROM corpus_search_documents) AS docs, (SELECT count(*) FROM corpus_requests) AS requests FROM commits").toArray());

describe("corpus read-only SQL", () => {
	it("runs one bounded SELECT, refuses every write and escape, and sees only its own profile", async () => {
		const p = await loaded();
		const before = await p.inCorpus(counts);
		const attacks = ["DELETE FROM commits", "UPDATE commits SET subject = 'x'", "INSERT INTO commits SELECT * FROM commits", "REPLACE INTO corpus_meta SELECT * FROM corpus_meta",
			"DROP TABLE commits", "CREATE TABLE x (a)", "ALTER TABLE commits RENAME TO c2", "CREATE TEMP TRIGGER t AFTER INSERT ON commits BEGIN SELECT 1; END", "PRAGMA writable_schema = ON",
			"ATTACH DATABASE ':memory:' AS x", "VACUUM", "REINDEX", "ANALYZE", "BEGIN; DELETE FROM commits; COMMIT", "SAVEPOINT a",
			"INSERT INTO corpus_search_fts(corpus_search_fts) VALUES('delete-all')", "WITH d AS (DELETE FROM commits RETURNING *) SELECT * FROM d",
			"SELECT 1; DELETE FROM commits", "SELECT 1) ; DELETE FROM commits; SELECT (1", "SELECT 1 FROM commits WHERE (1)) ; DELETE FROM commits ; SELECT ((1",
			"SELECT ';' ; DELETE FROM commits", "SELECT 1 /* ; */ ; DELETE FROM commits", "SELECT 1 -- x\n; DELETE FROM commits", "SELECT \"a;\" FROM commits ; DROP TABLE commits",
			"SELECT `x FROM commits ; DELETE FROM commits", "SELECT [x ; DELETE FROM commits", "SELECT 'x ; DELETE FROM commits", "SELECT 1 /* ; DELETE FROM commits", "SELECT (1"];
		for (const sql of attacks) {
			const r = await p.tool({ action: "sql", sql });
			expect([sql, r.error]).toEqual([sql, true]);
		}
		expect(await p.inCorpus(counts)).toEqual(before);
		expect((await p.tool({ action: "sql", sql: "SELECT ';' AS semi, '()' AS parens -- (\n;" })).value).toMatchObject({ columns: ["semi", "parens"], rows: [[";", "()"]], tables_read: [] });
		const many = await p.tool({ action: "sql", sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 600) SELECT i FROM n" });
		expect(many.value.rows).toHaveLength(500);
		expect(many.value.truncated).toBe(true);
		// The object holds this profile's corpus and nothing else: no profile tables, no other profile's rows.
		const other = await isolated();
		await other.http(other.importer, "/v1/corpus/import", await body(other, "commits", [row(commit(9))], { final: true }));
		expect((await other.tool({ action: "sql", sql: "SELECT repo, sha FROM commits" })).value.rows).toEqual([["acme/web", sha(9)]]);
		expect((await p.tool({ action: "sql", sql: "SELECT sha FROM commits ORDER BY sha" })).value.rows).toEqual([[sha(1)], [sha(2)]]);
		const tables = (await p.tool({ action: "sql", sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" })).value.rows.flat();
		expect(tables).not.toContain("nodes");
		const { SCAN_ORDER } = await import("../src/corpus/families");
		// The intended snapshot tables by name (migration 4 patterns, migration 5 records), each with its stage.
		const dated = ["pattern_coordinated_changes", "pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits", "pattern_lineage_edges",
			"pattern_findings", "pattern_finding_repos", "pull_requests", "pr_tickets", "pr_commit_links", "releases", "github_tags", "tickets", "ticket_episodes", "codex_sessions",
			"session_commit_links", "session_ticket_links", "validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties",
			"ownership", "predecessor_links", "journey_edges"];
		expect(tables.filter((t: string) => !t.startsWith("corpus_search_fts"))).toEqual(["commit_paths", "commits", "contributors", "corpus_meta", "corpus_partitions", "corpus_refresh", "corpus_refresh_parts", "corpus_requests", "corpus_search_documents", "corpus_store_meta", "refs", "repos", ...SCAN_ORDER,
			"corpus_snapshots", ...dated.flatMap((t) => [t, `corpus_stage_${t}`])].sort());
		expect(tables).toContain("corpus_search_fts");
		// A PR get answers from the (empty) pull_requests snapshot; me is refused by the tool; the search index reports its source tables' as_of.
		expect((await p.tool({ action: "get", kind: "pr", key: "acme/web#1" })).value).toMatchObject({ kind: "pr", found: false, pull_requests: [] });
		const me = (await p.rpc("tools/call", { name: "corpus", arguments: { profile: "me", action: "sql", sql: "SELECT 1" } })).result;
		expect(me.isError).toBe(true);
		expect(Object.keys((await p.tool({ action: "sql", sql: "SELECT count(*) FROM corpus_search_documents" })).value.as_of).sort()).toEqual(["commit_paths", "commits", "refs", "repos"]);
	});
});

describe("corpus generations and wipe", () => {
	it("pins the generation, keeps callers to their scopes and profiles, and clears on wipe with no late chunk or resurrection", async () => {
		const p = await loaded();
		const late = await body(p, "repos", [], { final: true });
		expect(await p.http(p.importer, "/v1/corpus/import", { ...late, generation: "old00000" })).toMatchObject({ status: 409, data: { error: { details: { reason: "generation_changed" } } } });
		expect((await p.http(p.importer, "/v1/corpus/import", { ...late, profile: "me" })).status).toBe(403);
		expect((await p.http(p.importer, "/v1/corpus/import", late, { ...p.on, IMPORT_PROFILES: env.IMPORT_PROFILES })).data.error.details.reason).toBe("import_disabled");
		expect((await p.http(p.reader, "/v1/corpus/import", late)).status).toBe(403);
		expect((await p.http(p.reader, `/v1/corpus/status?profile=${p.name}`)).status).toBe(403);
		const stranger = (await deviceToken(`imp-other-${p.name}`, ["import"], ["personal"])).token;
		expect((await p.http(stranger, "/v1/corpus/import", late)).status).toBe(403);
		// An import token reads nothing over MCP: it has no tools at all.
		expect(((await p.rpc("tools/list", {}, p.importer)).result?.tools as Json[] | undefined ?? []).map((t) => t.name)).not.toContain("corpus");

		const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${p.generation}`));
		const wiped = await (await import("../src/mcp")).accountStub(env, OWNER).admin({ op: "wipeProfile", profile: p.name, typed: p.name });
		expect(wiped.ok).toBe(true);
		await p.inCorpus((sql) => {
			expect(sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([{ name: "corpus_store_meta" }]);
			expect(sql.exec("SELECT key, value FROM corpus_store_meta").toArray()).toEqual([{ key: "closed", value: "wiped" }]);
		});
		// A late chunk after the wipe gets nowhere: the route no longer finds the profile, and the old object refuses directly.
		expect((await p.http(p.importer, "/v1/corpus/import", late)).status).toBeGreaterThanOrEqual(400);
		expect(await store.importChunk(p.who, chunkOf(late))).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(await store.query(p.who, { action: "sql", sql: "SELECT 1" })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(await store.wipe(p.who, "clear")).toMatchObject({ ok: true });
		await p.inCorpus((sql) => expect(sql.exec("SELECT name FROM sqlite_master").toArray()).toEqual([{ name: "corpus_store_meta" }]));

		// The same name on a new generation starts empty, and the old upload state cannot resume into it.
		const generation = rand();
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => {
			s.storage.sql.exec("UPDATE profiles SET status = 'active', generation = ?, object_name = ? WHERE name = ?", generation, `${OWNER}:${p.name}:${generation}`, p.name);
			s.storage.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", generation, p.name, new Date().toISOString());
		});
		const fresh = (await deviceToken(`imp2-${p.name}`, ["import"], [p.name])).token;
		const client = { status: async (q: string) => (await p.http(fresh, `/v1/corpus/status?profile=${q}`)).data, send: async (c: unknown) => (await p.http(fresh, "/v1/corpus/import", c)).data };
		expect(await client.status(p.name)).toMatchObject({ generation, tables: [] });
		expect(await uploadCorpus({ source: p.source, client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state: p.state })).toMatchObject({ status: "refused", reason: "generation_changed" });
		expect((await p.http(fresh, "/v1/corpus/import", late)).data.error.details.reason).toBe("generation_changed");
	});

	it("refuses a chunk that waited out the close step, while the account still says active", async () => {
		const p = await loaded();
		const chunk = await body(p, "repos", [], { final: true });
		const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${p.generation}`));
		expect(await store.wipe(p.who, "close")).toMatchObject({ ok: true, value: { closed: "wiping" } });
		expect(await store.importChunk(p.who, chunkOf(chunk))).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect((await p.http(p.importer, "/v1/corpus/import", chunk)).status).toBe(409);
		expect(await store.wipe({ ...p.who, generation: "other000" }, "clear")).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await p.inCorpus((sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM commits").one().n)).toBe(2);
	});
});

describe("corpus off", () => {
	it("keeps tools/list, tool calls and routes exactly as a deployment without the module", async () => {
		const p = await isolated();
		const names = async (e: Env) => ((await p.rpc("tools/list", {}, p.reader, e)).result.tools as Json[]).map((t) => t.name).sort();
		const without = (await names(p.on)).filter((n) => n !== "corpus");
		for (const e of [env, { ...p.on, CORPUS: "off" }, { ...p.on, CORPUS_STORE: undefined }] as Env[]) {
			expect(await names(e)).toEqual(without);
			const called = await p.rpc("tools/call", { name: "corpus", arguments: { profile: p.name, action: "sql", sql: "SELECT 1" } }, p.reader, e);
			expect(called.error ?? called.result?.isError).toBeTruthy();
			for (const [path, b] of [[`/v1/corpus/status?profile=${p.name}`, undefined], ["/v1/corpus/import", {}]] as const) {
				const unknown = await p.http(p.importer, path.replace("corpus", "no-such-route"), b, e);
				expect(await p.http(p.importer, path, b, e)).toEqual(unknown);
			}
		}
		const c = await contextFor(undefined, { CORPUS: "off" });
		expect(await (await import("./helpers")).outcome(c, "corpus", { profile: p.name, action: "sql", sql: "SELECT 1" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});
});

/** A fresh owner account (as test/wipe.test.ts does) with its seeded me and work profiles, CORPUS on, and two device tokens. */
async function workAccount() {
	const userId = `cg-${rand()}`;
	const e = { ...env, OWNER_USER_ID: userId, CORPUS: "on", EMBEDDINGS: "off" } as Env;
	const { accountStub } = await import("../src/mcp");
	const account = accountStub(e, userId);
	const seeded = await account.context({ kind: "owner", userId });
	if (!seeded.ok) throw new Error(seeded.error.message);
	const ref = (name: string) => seeded.value.profiles.find((r) => r.profile === name)!;
	const token = async (name: string, scopes: string[], profiles: string[]) => ((await account.admin({ op: "createDevice", name, scopes: scopes as never, profiles })) as { value: { token: string } }).value.token;
	const importer = await token("importer", ["import"], ["work"]), meWriter = await token("me-writer", ["read", "write"], ["me"]);
	const http = async (path: string, body?: unknown) => {
		const res = await worker.fetch(new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${importer}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }) }) as Parameters<typeof worker.fetch>[0], e);
		return { status: res.status, data: await res.json() as Json };
	};
	const client = { status: async (p: string) => (await http(`/v1/corpus/status?profile=${p}`)).data, send: async (c: unknown) => (await http("/v1/corpus/import", c)).data };
	const saveMe = async (args: Json) => {
		const res = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${meWriter}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_memory", arguments: { profile: "me", type: "user", description: "a preference", company_free: true, ...args } } }) }) as Parameters<typeof worker.fetch>[0], e);
		const text = await res.text();
		const r = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result as { content: { text: string }[]; isError?: boolean };
		return { error: r.isError === true, value: JSON.parse(r.content[0]!.text) as Json };
	};
	const onAccount = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(userId)), (_i, s) => f(s.storage.sql));
	const onProfile = <T,>(name: string, f: (sql: SqlStorage) => T) => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${userId}:${name}:${ref(name).generation}`)), (_i, s) => f(s.storage.sql));
	const corpus = () => env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${userId}:work:${ref("work").generation}`));
	const terms = () => onAccount((sql) => sql.exec<{ term: string }>("SELECT term FROM sensitive_terms ORDER BY term").toArray().map((r) => r.term));
	const guard = () => onProfile("me", (sql) => sql.exec<{ term: string; source: string }>("SELECT term, source FROM guard_terms ORDER BY term").toArray());
	return { userId, e, account, ref, http, client, saveMe, onAccount, onProfile, corpus, terms, guard };
}

/** Synthetic people: one repo, two named committers (one with an email name the uploader redacts), and two contributors. */
function people(sql: SqlStorage) {
	sql.exec(`INSERT INTO commits VALUES ('acme/web', ?, '[]', 'Alice Example', 'alice@acme.example', '2026-07-01T10:00:00Z', 'ci@acme.example', NULL, '2026-07-01T10:00:00Z',
		'Fix the token refresh loop', 'plain', 0, 0, NULL, NULL)`, sha(1));
	sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (1, 'acme/web', 1, 1, 'Alice Example', 'alice@acme.example'), (2, 'acme/web', 2, 1, 'Bo Builder', 'bo@acme.example')");
}

describe("corpus work guard terms", () => {
	it("registers a work chunk's repos and people in the account and me guard before storing it; me writes naming them are refused, and protected me is untouched", async () => {
		const w = await workAccount();
		// Before the chunk, a company-free me preference may still name the person; the owner pins it.
		const pref = await w.saveMe({ name: "release pairing", content: "Ask Alice Example before a release." });
		expect(pref.error).toBe(false);
		const id = String(pref.value.memory_id);
		const me = w.ref("me");
		const pinned = await (await import("../src/mcp")).profileStub(env, me).write(me, { op: "owner", args: { action: "pin", memory_id: id } },
			{ actor: "owner", platform: "test", routedBy: "explicit", userId: w.userId, payloadHash: sha256(`pin:${id}`), meGuard: { explicit: true, context: null, companyFree: false, sensitiveTerms: [] } });
		expect(pinned.ok).toBe(true);
		const before = await w.onProfile("me", (sql) => sql.exec("SELECT revision, pinned, flagged, updated_at FROM nodes WHERE id = ?", id).one());

		const { source } = await syntheticSource(people);
		const state: Json = {};
		expect(await uploadCorpus({ source, client: w.client, profile: "work", tables: ["commits", "contributors"], asOf: AS_OF, fileSha256: FILE, state })).toMatchObject({ status: "done" });
		// The repo and both people, never the redacted email-shaped committer name or any contact field.
		expect(await w.terms()).toEqual(expect.arrayContaining(["acme/web", "Alice Example", "Bo Builder"]));
		expect((await w.terms()).join(" ")).not.toMatch(/@|REDACTED/);
		expect(await w.guard()).toEqual(expect.arrayContaining([{ term: "Alice Example", source: "work" }, { term: "Bo Builder", source: "work" }, { term: "acme/web", source: "work" }]));
		expect(JSON.stringify(state)).not.toMatch(/Alice|Bo Builder/);
		// The me guard refuses a new write or an update naming them; the pinned record itself was not changed or flagged.
		expect(await w.saveMe({ name: "review buddy", content: "Pair with bo builder on reviews." })).toMatchObject({ error: true, value: { error: { code: "me_sensitive_term", details: { term: "Bo Builder" } } } });
		expect(await w.saveMe({ memory_id: id, content: "Ask Alice Example and the team before a release." })).toMatchObject({ error: true, value: { error: { code: "me_sensitive_term" } } });
		expect(await w.onProfile("me", (sql) => sql.exec("SELECT revision, pinned, flagged, updated_at FROM nodes WHERE id = ?", id).one())).toEqual(before);
		expect(before).toMatchObject({ pinned: 1, flagged: null });
		expect((await w.saveMe({ name: "editor", content: "Prefer tabs in editors." })).error).toBe(false);
	});

	it("stores nothing until every term page is confirmed: a guard outage, recovery or closed generation stops the chunk, and the resend replays exactly", async () => {
		const w = await workAccount();
		const { source } = await syntheticSource(people);
		const state: Json = {};
		const run = () => uploadCorpus({ source, client: w.client, profile: "work", tables: ["contributors"], asOf: AS_OF, fileSha256: FILE, state });
		const loaded = () => w.client.status("work").then((s) => s.tables);
		// The me guard is unavailable: the account kept its terms, me did not, and the chunk was not stored or acknowledged.
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'me'"));
		expect(await run()).toMatchObject({ status: "stopped", table: "contributors", reason: "unavailable" });
		expect(await loaded()).toEqual([]);
		expect(state.tables.contributors).toBeUndefined();
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'active' WHERE name = 'me'"));
		// The account is recovering: the generation-bound registration refuses before any term or row.
		await w.onAccount((sql) => sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
		const held = await w.terms();
		expect(await run()).toMatchObject({ status: "stopped", reason: "busy" });
		expect(await w.terms()).toEqual(held);
		await w.onAccount((sql) => sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'"));
		// The resend replays the registration and stores the chunk; a lost receipt replays again with no second copy.
		let lost = true;
		const flaky = { status: w.client.status, send: async (c: unknown) => { const r = await w.client.send(c); if (lost) { lost = false; throw new Error("connection reset"); } return r; } };
		expect(await uploadCorpus({ source, client: flaky, profile: "work", tables: ["contributors"], asOf: AS_OF, fileSha256: FILE, state })).toMatchObject({ status: "stopped", reason: "connection reset" });
		expect(await run()).toMatchObject({ status: "done" });
		expect((await w.guard()).map((g) => g.term)).toEqual(expect.arrayContaining(["Alice Example", "Bo Builder"]));
		expect(await loaded()).toMatchObject([{ table: "contributors", rows: 2, complete: true }]);
		const st = await w.client.status("work");
		const again = await w.http("/v1/corpus/import", await chunkFor(st, "contributors", [[1, "acme/web", 1, 1, "Alice Example"], [2, "acme/web", 2, 1, "Bo Builder"]], { final: true }));
		expect(again.data.receipt).toMatchObject({ status: "replayed", rows: 2 });
		expect(await w.onAccount((sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM sensitive_terms WHERE term IN ('Alice Example', 'Bo Builder')").one().n)).toBe(2);

		// A registration whose context predates a wipe is refused inside the account; after the wipe nothing registers or loads.
		const work = w.ref("work");
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'work'"));
		expect(await w.account.admin({ op: "addSensitiveTerms", terms: ["Late Person"], profile: "work", generation: work.generation })).toMatchObject({ ok: false, error: { code: "busy" } });
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'active' WHERE name = 'work'"));
		expect((await w.account.admin({ op: "wipeProfile", profile: "work", typed: "work" })).ok).toBe(true);
		const late = await w.http("/v1/corpus/import", await chunkFor(st, "commits", [row(commit(7, "plain", { author_name: "Late Person" }))]));
		expect(late.status).toBeGreaterThanOrEqual(400);
		expect(await w.terms()).not.toContain("Late Person");
		expect(await w.corpus().importChunk(work, chunkOf(await chunkFor(st, "commits", [row(commit(7, "plain", { author_name: "Late Person" }))])))).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	});

	it("registers a large chunk's people in bounded pages, one account and one me transaction each", async () => {
		const w = await workAccount();
		const st = await w.client.status("work");
		const rows = Array.from({ length: 450 }, (_, i) => [i + 1, "acme/web", i + 1, 1, `Dev ${String(i + 1).padStart(3, "0")} Example`]);
		expect((await w.http("/v1/corpus/import", await chunkFor(st, "contributors", rows, { final: true }))).data.receipt).toMatchObject({ status: "stored", rows: 450 });
		const pages = (sql: SqlStorage, table: string) => sql.exec<{ n: number; s: number }>(`SELECT count(*) AS n, count(DISTINCT seq) AS s FROM ${table} WHERE term LIKE 'Dev % Example' OR term = 'acme/web'`).one();
		expect(await w.onAccount((sql) => pages(sql, "sensitive_terms"))).toEqual({ n: 451, s: 3 });
		expect(await w.onProfile("me", (sql) => pages(sql, "guard_terms"))).toEqual({ n: 451, s: 3 });
	});
});

/** A chunk body for a status's own families and generation, hashed like the uploader hashes it. */
async function chunkFor(st: Json, table: string, rows: unknown[][], over: Json = {}) {
	const { chunkHash } = await import("../src/corpus/families");
	const fam = st.families.find((f: Json) => f.table === table);
	const c = { profile: st.profile, generation: st.generation, table, schema_sha256: fam.schema_sha256, source: { file_sha256: FILE }, as_of: AS_OF, columns: fam.columns, after: null, rows, final: false, ...over };
	return { ...c, sha256: chunkHash(c as never) };
}

// Review findings C2 and C3 (am-corpus-review-sol-fsg_6imv), reproduced first on the guard snapshot (137 + 657739f5).
describe("corpus review regressions", () => {
	it("refuses a completed table from another source or as_of even with fresh local state, and skips only the identical snapshot", async () => {
		const p = await loaded();
		const silent = { status: p.client.status, send: () => { throw new Error("no send expected"); } };
		const again = (over: Json) => uploadCorpus({ source: p.source, client: silent, profile: p.name, tables: ["contributors"], asOf: AS_OF, fileSha256: FILE, state: {}, ...over });
		expect(await again({ fileSha256: "cd".repeat(32) })).toMatchObject({ status: "refused", table: "contributors", reason: "source_changed" });
		expect(await again({ asOf: "2026-09-07T10:26:00.162Z" })).toMatchObject({ status: "refused", table: "contributors", reason: "source_changed" });
		expect(await again({})).toMatchObject({ status: "done", tables: { contributors: { rows: 2, complete: true } } });
	});

	it("wraps corpus data at transport only and refuses an envelope that crosses the shared byte limit", async () => {
		const p = await isolated();
		const result = (await p.rpc("tools/call", {name: "corpus", arguments: {profile: p.name, action: "sql", sql: "SELECT 1 AS n"}})).result;
		const raw = JSON.parse(result.content[0].text);
		expect(Object.keys(raw).sort()).toEqual(["data", "origin"]);
		expect(raw.origin).toEqual({system: "agent-memory", trust: "untrusted"});
		expect(raw.data.rows).toEqual([[1]]);
		const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${p.generation}`));
		const head = {profile: p.name, routed_by: "explicit", action: "sql"};
		const columns = Array.from({length: 10}, (_, i) => `c${i}`);
		const seed = await store.query(p.who, {action: "sql", sql: "SELECT " + columns.map((c) => `'' AS ${c}`).join(", ")}, head) as Outcome<Json>;
		if (!seed.ok) throw new Error("synthetic corpus control failed");
		const room = 1_000_000 - Buffer.byteLength(JSON.stringify(seed.value));
		// SQL keeps each cell at 100k characters; ten bounded cells exercise the whole answer limit.
		const sql = "SELECT " + columns.map((c, i) => `printf('%${i < 9 ? 100_000 : room - 900_000 - 20}s', '') AS ${c}`).join(", ");
		const domain = await store.query(p.who, {action: "sql", sql}, head) as Outcome<Json>;
		expect(domain).toMatchObject({ok: true, value: {truncated: false}});
		if (!domain.ok) return;
		expect(Buffer.byteLength(JSON.stringify(domain.value))).toBe(999_980);
		expect(domain.value).not.toHaveProperty("data");
		const over = await p.tool({action: "sql", sql});
		expect(over).toMatchObject({error: true, value: {error: {code: "size_budget", details: {reason: "envelope_bytes"}}}});
		expect(over.bytes).toBeLessThanOrEqual(1_000_000);
	});

	it("keeps every corpus answer within 1,000,000 UTF-8 bytes, cutting whole rows and saying so", async () => {
		const p = await loaded();
		const wide = "replace(printf('%100000s', ''), ' ', '漢')";
		const four = await p.tool({ action: "sql", sql: `WITH n(i) AS (VALUES (1), (2), (3), (4)) SELECT ${wide} AS text FROM n` });
		expect(four.bytes).toBeLessThanOrEqual(1_000_000);
		expect(four.value).toMatchObject({ truncated: true });
		expect(four.value.rows).toHaveLength(3);
		// One row over the budget alone is never returned, whole or in part.
		const one = await p.tool({ action: "sql", sql: `SELECT a || a || a || a AS text FROM (SELECT ${wide} AS a)` });
		expect(one).toMatchObject({ error: false, value: { rows: [], truncated: true } });
		expect(one.bytes).toBeLessThanOrEqual(1_000_000);
		// A row that fits alone must still leave room for routing, columns, provenance and the truncation flag.
		const edge = await p.tool({ action: "sql", sql: "SELECT a||a||a||a||a||a||a||a||a||printf('%99900s', '') AS text FROM (SELECT printf('%100000s', '') AS a)" });
		expect(edge).toMatchObject({ error: false, value: { rows: [], truncated: true } });
		expect(edge.bytes).toBeLessThanOrEqual(1_000_000);
		const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${p.generation}`));
		expect(await store.query(p.who, { action: "sql", sql: "SELECT 1" }, { metadata: "x".repeat(1_000_000) })).toMatchObject({ ok: false, error: { code: "size_budget" } });
		// Search and get read rows whose text the chunk budget allows; their answers obey the same byte budget.
		const q = await isolated();
		const big = (n: number) => row(commit(n, "plain", { repo: `acme/r${n}`, sha: sha(77), subject: `token ${"漢".repeat(200_000)}` }));
		for (const n of [1, 2]) expect((await q.http(q.importer, "/v1/corpus/import", await body(q, "commits", [big(n)], { after: n === 1 ? null : ["acme/r1", sha(77)], final: n === 2 }))).data.receipt).toMatchObject({ status: "stored" });
		const found = await q.tool({ action: "search", query: "token" });
		expect(found.bytes).toBeLessThanOrEqual(1_000_000);
		expect(found.value.truncated).toBe(true);
		const got = await q.tool({ action: "get", kind: "commit", key: sha(77) });
		expect(got.bytes).toBeLessThanOrEqual(1_000_000);
		expect(got.value).toMatchObject({ found: true, truncated: true });
		expect(got.value.commits).toHaveLength(1);
		expect((await p.tool({ action: "get", kind: "commit", key: `acme/web@${sha(1)}` })).value).toMatchObject({ found: true, truncated: false, paths_truncated: false });
	});
});

// Refresh (design revision 2): the real client, Worker route and CorpusStore, synthetic rows only.
const CUT = "2026-09-07T10:26:00.162Z", LATER = "2026-09-08T00:00:00.000Z", EARLIER = "2026-09-01T00:00:00.000Z";
const FILE2 = "cd".repeat(32);

/** acme/web from seed, plus an untouched second repo, acme/api. */
function twoRepos(sql: SqlStorage) {
	seed(sql);
	sql.exec(`INSERT INTO repos (rowid, full_name, owner, name, description, archived, private, language, default_branch, updated_at, url, commit_count, ref_count, head_sha, earliest_date, latest_date, empty)
		VALUES (2, 'acme/api', 'acme', 'api', 'The API', 0, 1, 'Go', 'main', '2026-08-02T00:00:00Z', 'https://github.com/acme/api', 1, 1, ?, '2026-08-02', '2026-08-02', 0)`, sha(9));
	sql.exec("INSERT INTO commits VALUES ('acme/api', ?, '[]', 'Dana', NULL, '2026-08-02T10:00:00Z', 'Dana', NULL, '2026-08-02T10:00:00Z', 'Serve health checks', 'Serve health checks', 0, 0, NULL, NULL)", sha(9));
	sql.exec("INSERT INTO refs VALUES ('acme/api', 'refs/heads/main', 'heads', 'main', ?, 'commit', '2026-08-02T10:00:00Z', 'Dana', NULL, 'Serve health checks')", sha(9));
	sql.exec("INSERT INTO commit_paths VALUES ('acme/api', ?, 'cmd/health.go', 'cmd', 'go')", sha(9));
	sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (3, 'acme/api', 1, 1, 'Dana', NULL)");
}

/** The next cut of acme/web: a reworded message, a commit gone with its paths, a new commit that now represents token.ts, the ref moved, contributors reshuffled. */
function nextCut(sql: SqlStorage) {
	twoRepos(sql);
	sql.exec("UPDATE commits SET message = 'Fix the token refresh loop with a flux capacitor' WHERE repo = 'acme/web' AND sha = ?", sha(1));
	sql.exec("DELETE FROM commits WHERE repo = 'acme/web' AND sha = ?", sha(2));
	sql.exec("DELETE FROM commit_paths WHERE repo = 'acme/web' AND (sha = ? OR path = 'src/app.ts' OR (sha = ? AND path = 'src/auth/token.ts'))", sha(2), sha(1));
	sql.exec("INSERT INTO commits VALUES ('acme/web', ?, '[]', 'Cy', NULL, '2026-09-01T09:00:00Z', 'Cy', NULL, '2026-09-01T09:00:00Z', 'Move token code into core', 'Move token code into core', 0, 0, NULL, NULL)", sha(3));
	sql.exec("INSERT INTO commit_paths VALUES ('acme/web', ?, 'src/auth/token.ts', 'core', 'ts')", sha(3));
	sql.exec("UPDATE refs SET target_sha = ?, subject = 'Move token code into core' WHERE repo = 'acme/web'", sha(3));
	sql.exec("UPDATE repos SET description = 'The web app', commit_count = 2 WHERE full_name = 'acme/web'");
	sql.exec("DELETE FROM contributors WHERE repo = 'acme/web'");
	sql.exec("INSERT INTO contributors (repo, rank, commits, name, email) VALUES ('acme/web', 1, 1, 'Alice', NULL), ('acme/web', 1, 1, 'Alice', NULL), ('acme/web', 2, 1, 'Cy', NULL)");
}

/** A loaded corpus of twoRepos, the refresh client for it, and raw route calls. */
async function refreshable(fill: (sql: SqlStorage) => void = twoRepos) {
	const p = await isolated();
	const { source } = await syntheticSource(fill);
	expect(await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state: {} })).toMatchObject({ status: "done" });
	const route = (b: Json) => p.http(p.importer, "/v1/corpus/refresh", { profile: p.name, generation: p.generation, ...b });
	const refresher = { status: p.client.status, refresh: async (b: Json) => (await p.http(p.importer, "/v1/corpus/refresh", b)).data };
	const hashes = async (repo: string) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await route({ command: "inspect", table: t, repo, after: null })).data.page.rows])));
	return { ...p, route, refresher, hashes };
}

describe("corpus refresh", () => {
	it("refreshes one repo through the client, Worker and store: rows, search, rowids and as_of change there only", async () => {
		const p = await refreshable();
		const api = await p.hashes("acme/api");
		const { source } = await syntheticSource(nextCut);
		const state: Json = {};
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "published", receipt: { epoch: 1, observed_at: CUT } });
		expect(state.plan).toBeNull();
		// Search follows the new rows: the reworded message and the new representative path appear; the deleted commit and the last-row path disappear.
		const hits = async (q: string) => (await p.tool({ action: "search", query: q })).value.results.map((r: Json) => r.key);
		expect(await hits("flux")).toEqual([`acme/web@${sha(1)}`]);
		expect(await hits("backoff")).toEqual([]);
		expect(await hits("core")).toEqual(expect.arrayContaining(["acme/web:src/auth/token.ts", `acme/web@${sha(3)}`]));
		expect(await hits("app")).not.toContain("acme/web:src/app.ts");
		const got = await p.tool({ action: "get", kind: "commit", key: `acme/web@${sha(3)}` });
		expect(got.value).toMatchObject({ found: true, repo_as_of: { commits: CUT, commit_paths: CUT } });
		expect(got.value.as_of.commits).toEqual({ as_of: AS_OF, as_of_max: CUT, basis: "mixed", refresh: "refresh", complete: true, rows: 3, source_sha256: null, partitions: 2 });
		expect((await p.tool({ action: "get", kind: "commit", key: `acme/web@${sha(2)}` })).value.found).toBe(false);
		expect((await p.tool({ action: "get", kind: "repo", key: "acme/api" })).value.repo_as_of).toEqual({ repos: AS_OF, contributors: AS_OF });
		// Matched rows keep their rowids; the excess Bob row goes by rowid; new occurrences get server rowids after the current maximum.
		const sql = async (q: string) => (await p.tool({ action: "sql", sql: q })).value.rows;
		expect(await sql("SELECT rowid, name FROM contributors WHERE repo = 'acme/web' ORDER BY rowid")).toEqual([[1, "Alice"], [4, "Alice"], [5, "Cy"]]);
		expect(await sql("SELECT rowid, description FROM repos WHERE full_name = 'acme/web'")).toEqual([[1, "The web app"]]);
		expect(await p.hashes("acme/api")).toEqual(api);
		expect(await sql("SELECT table_name, part, basis, observed_at FROM corpus_partitions WHERE table_name = 'refs' ORDER BY part")).toEqual([
			["refs", '"acme/api"', "declared_snapshot", AS_OF], ["refs", '"acme/web"', "observed", CUT]]);
		// An unchanged later cut confirms with no operations: only that repo's dates move, and the client's inspect audit agrees with every digest.
		const again = await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: LATER, sourceId: FILE2, state });
		expect(again).toMatchObject({ status: "published", receipt: { epoch: 2 } });
		expect((await p.tool({ action: "get", kind: "ref", key: "acme/web:refs/heads/main" })).value).toMatchObject({ repo_as_of: { refs: LATER }, as_of: { refs: { as_of: AS_OF, as_of_max: LATER } } });
	});

	it("closes every corpus read while a plan applies; a lost acknowledgement or changed retry writes nothing twice; receipts replay after publication", async () => {
		const p = await refreshable();
		const { source } = await syntheticSource(nextCut);
		let parts = 0;
		const lossy = { ...p.refresher, refresh: async (b: Json) => { const r = await p.refresher.refresh(b); if (b.command === "part" && ++parts === 1) throw new Error("connection reset"); return r; } };
		const state: Json = {};
		expect(await refreshCorpus({ source, client: lossy, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state, partOps: 3 })).toMatchObject({ status: "stopped", reason: "connection reset" });
		const plan = structuredClone(state.plan) as Json, steps = chains(seedOf(p.name, p.generation, plan.header), plan.ops) as string[];
		// Search, get and SQL (bookkeeping tables through a CTE included) answer busy; a bulk chunk and the bulk uploader stop too.
		for (const args of [{ action: "search", query: "token" }, { action: "get", kind: "repo", key: "acme/web" }, { action: "sql", sql: "WITH x AS (SELECT * FROM corpus_partitions) SELECT count(*) FROM x" }])
			expect(await p.tool(args)).toMatchObject({ error: true, value: { error: { code: "busy", details: { reason: "corpus_refreshing" } } } });
		expect(await p.http(p.importer, "/v1/corpus/import", await body(p, "commits", [], { final: true }))).toMatchObject({ status: 503, data: { error: { details: { reason: "corpus_refreshing" } } } });
		expect(await uploadCorpus({ source, client: p.client, profile: p.name, tables: TABLES, asOf: AS_OF, fileSha256: FILE, state: {} })).toEqual({ status: "stopped", reason: "corpus_refreshing" });
		expect((await p.client.status(p.name)).refresh).toMatchObject({ plan_id: plan.plan_id, repo: "acme/web", state: "applying", next_op: 3, op_count: plan.ops.length, chain: steps[3], base_epoch: 0, unpublished: ["commit_paths"] });
		// The lost part replays its stored receipt; changed bytes at that start conflict; a start inside the applied prefix reports the cursor.
		const first = { command: "part", plan_id: plan.plan_id, start: 0, ops: plan.ops.slice(0, 3) };
		const replay = await p.route(first);
		expect(replay).toMatchObject({ status: 200, data: { receipt: { status: "stored", start: 0, count: 3, next_op: 3, chain: steps[3] } } });
		expect(await p.route({ ...first, ops: plan.ops.slice(0, 2) })).toMatchObject({ status: 409, data: { error: { code: "idempotency_mismatch", details: { reason: "part_changed" } } } });
		expect(await p.route({ ...first, start: 1, ops: plan.ops.slice(1, 3) })).toMatchObject({ status: 400, data: { error: { details: { reason: "stale_part", next_op: 3, chain: steps[3] } } } });
		expect((await p.client.status(p.name)).refresh.next_op).toBe(3);
		// The saved plan resumes at the server's cursor and publishes.
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state, partOps: 3 })).toMatchObject({ status: "published" });
		const maxRowid = async () => (await p.tool({ action: "sql", sql: "SELECT max(rowid) FROM contributors" })).value.rows;
		expect(await maxRowid()).toEqual([[5]]);
		// After publication every receipt replays unchanged, and nothing is applied again.
		expect(await p.route(first)).toEqual(replay);
		const fin = await p.route({ command: "finish", plan_id: plan.plan_id });
		expect(fin).toMatchObject({ status: 200, data: { receipt: { status: "published", plan_id: plan.plan_id, epoch: 1, observed_at: CUT } } });
		expect(await p.route({ command: "finish", plan_id: plan.plan_id })).toEqual(fin);
		expect(await p.route({ command: "begin", header: plan.header })).toMatchObject({ status: 200, data: { receipt: { status: "active", plan_id: plan.plan_id, next_op: 0, chain: steps[0] } } });
		expect(await maxRowid()).toEqual([[5]]);
		expect((await p.client.status(p.name)).refresh).toBeNull();
	});

	it("takes a lost plan over for the same repo only, and keeps every table the old chain changed until a takeover observes it", async () => {
		const p = await refreshable();
		const { source } = await syntheticSource(nextCut);
		let parts = 0;
		const dies = { ...p.client, refresh: async (b: Json) => { if (b.command === "part" && ++parts === 2) throw new Error("machine lost"); return p.refresher.refresh(b); } };
		const lost: Json = {};
		expect(await refreshCorpus({ source, client: dies, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state: lost, partOps: 4 })).toMatchObject({ status: "stopped" });
		const old = lost.plan as Json, st = (await p.client.status(p.name)).refresh;
		expect(st).toMatchObject({ plan_id: old.plan_id, next_op: 4, unpublished: ["commits", "commit_paths"] });
		const base = { kind: "active", plan_id: st.plan_id, next_op: st.next_op, chain: st.chain };
		const zero = (h: Json) => ({ ...h, op_count: 0, chain: seedOf(p.name, p.generation, { ...h, op_count: 0 }) });
		const reason = async (header: Json) => (await p.route({ command: "begin", header })).data.error?.details;
		expect(await reason(zero({ ...old.header, repo: "acme/api", base }))).toMatchObject({ reason: "repo_mismatch" });
		expect(await reason(zero({ ...old.header, base, observed: ["repos", "refs", "contributors"] }))).toEqual({ reason: "unobserved_changed", tables: ["commits", "commit_paths"] });
		expect(await reason(zero({ ...old.header, base: { ...base, next_op: 3 } }))).toMatchObject({ reason: "base_changed" });
		expect((await p.client.status(p.name)).refresh).toMatchObject({ plan_id: old.plan_id, state: "applying", next_op: 4 });
		// With its plan gone, the client takes the chain over from status and publishes the complete target.
		const state: Json = {};
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "published" });
		expect(state.published.plan_id).not.toBe(old.plan_id);
		expect((await p.tool({ action: "sql", sql: "SELECT rowid, name FROM contributors WHERE repo = 'acme/web' ORDER BY rowid" })).value.rows).toEqual([[1, "Alice"], [4, "Alice"], [5, "Cy"]]);
		expect((await p.tool({ action: "search", query: "flux" })).value.results.map((r: Json) => r.key)).toEqual([`acme/web@${sha(1)}`]);
		// The superseded plan's stored part still replays; a new slice of it does not apply.
		expect(await p.route({ command: "part", plan_id: old.plan_id, start: 0, ops: old.ops.slice(0, 4) })).toMatchObject({ status: 200, data: { receipt: { status: "stored", next_op: 4 } } });
		expect(await p.route({ command: "part", plan_id: old.plan_id, start: 4, ops: old.ops.slice(4, 5) })).toMatchObject({ status: 400, data: { error: { details: { reason: "plan_not_applying", state: "superseded" } } } });
		// A later confirm audits every inspected page against the maintained digests and publishes with no operations.
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: LATER, sourceId: FILE2, state })).toMatchObject({ status: "published", receipt: { epoch: 2 } });
	});

	it("removes a repo into zero-row partitions that keep its observation, refusing an older cut and accepting a newer one", async () => {
		const p = await refreshable();
		expect(await refreshCorpus({ source: null, client: p.refresher, profile: p.name, repo: "acme/api", intent: "remove", observedAt: CUT, sourceId: FILE2, state: {} })).toMatchObject({ status: "published" });
		const parts = async () => (await p.tool({ action: "sql", sql: "SELECT table_name, rows, basis, observed_at FROM corpus_partitions WHERE part = '\"acme/api\"' ORDER BY table_name" })).value.rows;
		expect(await parts()).toEqual(["commit_paths", "commits", "contributors", "refs", "repos"].map((t) => [t, 0, "observed", CUT]));
		// Zero-row partitions do not date the table; acme/web's snapshot alone covers its rows.
		expect((await p.tool({ action: "get", kind: "commit", key: `acme/web@${sha(1)}` })).value.as_of.commits).toMatchObject({ as_of: AS_OF, as_of_max: AS_OF, basis: "declared_snapshot", rows: 2, partitions: 1 });
		expect((await p.tool({ action: "get", kind: "repo", key: "acme/api" })).value).toMatchObject({ found: false, repo_as_of: { repos: CUT, contributors: CUT } });
		const { source } = await syntheticSource(twoRepos);
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/api", observedAt: EARLIER, sourceId: FILE2, state: {} })).toMatchObject({ status: "refused", reason: "stale_observation" });
		expect(await refreshCorpus({ source, client: p.refresher, profile: p.name, repo: "acme/api", observedAt: LATER, sourceId: FILE2, state: {} })).toMatchObject({ status: "published" });
		expect((await p.tool({ action: "get", kind: "repo", key: "acme/api" })).value).toMatchObject({ found: true, repo_as_of: { repos: LATER } });
		// An empty target for a loaded repo is refused unless the removal is explicit.
		const { source: empty } = await syntheticSource(() => {});
		expect(await refreshCorpus({ source: empty, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: LATER, sourceId: FILE2, state: {} })).toMatchObject({ status: "refused", reason: "removal_needs_intent" });
	});

	it("holds parts to 5,000 operations, 1,000,000 request bytes, 900,000-byte rows and 5,000,000 expanded bytes, in key order, reporting rows written", async () => {
		const bigText = (i: number) => `big ${i}${" ".repeat(400_000)}`;
		const p = await refreshable((sql) => { twoRepos(sql); for (let i = 0; i < 8; i++) sql.exec("INSERT INTO commits VALUES ('acme/big', ?, '[]', 'Eve', NULL, '2026-08-03T00:00:00Z', 'Eve', NULL, '2026-08-03T00:00:00Z', ?, ?, 0, 0, NULL, NULL)", sha(100 + i), `big ${i}`, bigText(i)); });
		// Seven ~400 KB deletes, each with its ~400 KB document, are over 5,000,000 expanded bytes: refused whole, then halved slices apply.
		const sent: Json[] = [];
		const watch = { ...p.refresher, refresh: async (b: Json) => { const r = await p.refresher.refresh(b); if (b.command === "part") sent.push({ start: b.start, count: b.ops.length, ...(r.error ? { error: r.error.details.reason } : { rows_written: r.receipt.rows_written, expanded: r.receipt.expanded_bytes }) }); return r; } };
		const { source } = await syntheticSource((sql) => { twoRepos(sql); sql.exec("INSERT INTO commits VALUES ('acme/big', ?, '[]', 'Eve', NULL, '2026-08-03T00:00:00Z', 'Eve', NULL, '2026-08-03T00:00:00Z', ?, ?, 0, 0, NULL, NULL)", sha(100), "big 0", bigText(0)); });
		expect(await refreshCorpus({ source, client: watch, profile: p.name, repo: "acme/big", observedAt: CUT, sourceId: FILE2, state: {} })).toMatchObject({ status: "published" });
		expect(sent.map((s) => [s.start, s.count, s.error ?? "stored"])).toEqual([[0, 7, "expanded_bytes"], [0, 4, "stored"], [4, 3, "stored"]]);
		for (const s of sent.slice(1)) { expect(s.rows_written).toBeGreaterThan(s.count); expect(s.expanded).toBeLessThanOrEqual(5_000_000); }
		expect((await p.tool({ action: "sql", sql: "SELECT count(*) FROM commits WHERE repo = 'acme/big'" })).value.rows).toEqual([[1]]);
		// Wire bounds refuse before any store sees the part.
		const pid = "e".repeat(64);
		expect(await p.route({ command: "part", plan_id: pid, start: 0, ops: Array.from({ length: 5001 }, () => ["d", "commits", [sha(1)], pid]) })).toMatchObject({ status: 400 });
		expect(await p.route({ command: "finish", plan_id: pid, pad: "x".repeat(1_000_001) })).toMatchObject({ status: 413, data: { error: { details: { reason: "request_bytes" } } } });
		// A put row over 900,000 bytes and a part out of key order each refuse whole, with no receipt.
		const st = await p.client.status(p.name);
		const fams = Object.fromEntries(st.families.map((f: Json) => [f.table, f]));
		const page = async (repo: string) => (await p.route({ command: "inspect", table: "commits", repo, after: null })).data.page;
		const header = (ops: Json[], base: Json) => {
			const h: Json = { version: "corpus-refresh/1", repo: "acme/big", intent: "refresh", base, source: { kind: "sqlite-file", id: FILE2, scope: "complete-repo-projection" }, projection: "corpus-projection/1",
				schemas: Object.fromEntries(TABLES.map((t) => [t, fams[t].schema_sha256])), observed: TABLES, observed_at: LATER,
				targets: Object.fromEntries(TABLES.map((t) => [t, { rows: t === "commits" ? 1 : 0, sum: (t === "commits" ? "1" : "0").repeat(64) }])), op_count: ops.length, chain: "" };
			h.chain = (chains(seedOf(p.name, p.generation, h), ops) as string[]).at(-1);
			return h;
		};
		const huge = ["p", "commits", ["acme/big", sha(200), "[]", "Eve", "2026-08-03T00:00:00Z", "Eve", "2026-08-03T00:00:00Z", "huge", `huge${" ".repeat(950_000)}`, 0, 0, null, null], null];
		const h1 = header([huge], { kind: "published", epoch: (await page("acme/big")).binding.epoch });
		const b1 = (await p.route({ command: "begin", header: h1 })).data.receipt;
		expect(await p.route({ command: "part", plan_id: b1.plan_id, start: 0, ops: [huge] })).toMatchObject({ status: 413, data: { error: { details: { reason: "row_bytes" } } } });
		const rows = (await page("acme/big")).rows as [string[], string][];
		const misordered = [["d", "commits", rows[0]![0], rows[0]![1]], ["d", "commits", [sha(99)], rows[0]![1]]];
		const { binding } = await page("acme/big");
		const h2 = header(misordered, { kind: "active", ...binding });
		const b2 = (await p.route({ command: "begin", header: h2 })).data.receipt;
		expect(await p.route({ command: "part", plan_id: b2.plan_id, start: 0, ops: misordered })).toMatchObject({ status: 400, data: { error: { details: { reason: "order" } } } });
		expect((await p.client.status(p.name)).refresh).toMatchObject({ plan_id: b2.plan_id, next_op: 0 });
		expect(await p.inCorpus((sql) => sql.exec("SELECT count(*) AS n FROM commits WHERE repo = 'acme/big'").one().n)).toBe(1);
	});

	it("in work, registers put rows' people before the store sees a part, and fences every part and replay by account state, generation and wipe", async () => {
		const w = await workAccount();
		const { source } = await syntheticSource(people);
		expect(await uploadCorpus({ source, client: w.client, profile: "work", tables: TABLES, asOf: AS_OF, fileSha256: FILE, state: {} })).toMatchObject({ status: "done" });
		const route = async (b: Json) => (await w.http("/v1/corpus/refresh", b)).data;
		const bodies: Json[] = [];
		const client = { status: w.client.status, refresh: async (b: Json) => { if (b.command === "part") bodies.push(b); return route(b); } };
		const { source: next } = await syntheticSource((sql) => { people(sql); sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (3, 'acme/web', 3, 1, 'Dee Developer', NULL)"); });
		// The me guard is down: the part's new person cannot be confirmed, so nothing is stored and the cursor stays.
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'me'"));
		const state: Json = {};
		expect(await refreshCorpus({ source: next, client, profile: "work", repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "stopped", reason: "unavailable" });
		expect((await w.client.status("work")).refresh.next_op).toBe(0);
		await w.onAccount((sql) => sql.exec("UPDATE profiles SET status = 'active' WHERE name = 'me'"));
		expect(await refreshCorpus({ source: next, client, profile: "work", repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "published" });
		expect(await w.guard()).toEqual(expect.arrayContaining([{ term: "Dee Developer", source: "work" }]));
		const stored = bodies.at(-1)!;
		expect((await route(stored)).receipt).toMatchObject({ status: "stored" });
		// Recovery stops even an exact replay before the store; another generation and a closed corpus refuse it too.
		await w.onAccount((sql) => sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
		expect((await route(stored)).error).toMatchObject({ code: "busy" });
		await w.onAccount((sql) => sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'"));
		expect((await w.http("/v1/corpus/refresh", { ...stored, generation: "elsewhere" }))).toMatchObject({ status: 409, data: { error: { code: "profile_wiped" } } });
		await (w.corpus() as unknown as { wipe: (who: unknown, op: string) => Promise<unknown> }).wipe(w.ref("work"), "close");
		expect((await route(stored)).error).toMatchObject({ code: "profile_wiped" });
		expect((await route({ profile: "work", generation: w.ref("work").generation, command: "finish", plan_id: state.published.plan_id })).error).toMatchObject({ code: "profile_wiped" });
	});
});



describe("F1 implementation fix regressions", () => {
	it("reconciles an uncertain HTTP failure before halving an unapplied slice and stops at one failing operation", async () => {
		const p = await refreshable();
		const { source } = await syntheticSource(sql => { twoRepos(sql); sql.exec("INSERT INTO contributors (repo,rank,commits,name) VALUES ('acme/web',3,1,'Zed'), ('acme/web',4,1,'Yan')"); });
		const state: Json = {}, lengths: number[] = [], events: string[] = [];
		const client = { status: async (profile: string) => { events.push("status"); return p.refresher.status(profile); }, refresh: async (b: Json) => {
			if (b.command === "part") { events.push(`part:${b.ops.length}`); lengths.push(b.ops.length); if (b.ops.length > 1) throw new Error("HTTP 503"); }
			return p.refresher.refresh(b);
		} };
		expect(await refreshCorpus({ source, client, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "published" });
		expect(lengths).toEqual([2, 1, 1]);
		expect(events.slice(events.indexOf("part:2"), events.indexOf("part:2") + 3)).toEqual(["part:2", "status", "part:1"]);
		expect((await p.client.status(p.name)).refresh).toBeNull();

		const q = await refreshable(), failed: Json = {}, attempts: number[] = [];
		const blocked = { ...q.refresher, refresh: async (b: Json) => {
			if (b.command === "part") { attempts.push(b.ops.length); throw new Error("HTTP 503"); }
			return q.refresher.refresh(b);
		} };
		expect(await refreshCorpus({ source, client: blocked, profile: q.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state: failed })).toMatchObject({ status: "stopped", reason: "HTTP 503" });
		expect(attempts).toEqual([2, 1]);
		expect(failed.plan.ops).toHaveLength(2);
		expect((await q.client.status(q.name)).refresh.next_op).toBe(0);
		expect(await q.tool({ action: "sql", sql: "SELECT 1" })).toMatchObject({ error: true, value: { error: { code: "busy" } } });
	});

	it("uses the committed cursor after a lost HTTP acknowledgement and refuses a mismatched chain before re-slicing", async () => {
		const p = await refreshable();
		const { source } = await syntheticSource(sql => { twoRepos(sql); sql.exec("INSERT INTO contributors (repo,rank,commits,name) VALUES ('acme/web',3,1,'Zed'), ('acme/web',4,1,'Yan')"); });
		const sent: Json[] = [], state: Json = {};
		const lossy = { ...p.refresher, refresh: async (b: Json) => {
			const result = await p.refresher.refresh(b);
			if (b.command === "part") { sent.push(b); throw new Error("HTTP 503"); }
			return result;
		} };
		expect(await refreshCorpus({ source, client: lossy, profile: p.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state })).toMatchObject({ status: "published" });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.ops).toHaveLength(2);
		const replay = await p.route(sent[0]!);
		expect(await p.route(sent[0]!)).toEqual(replay);
		expect(await p.route({ ...sent[0], ops: sent[0]!.ops.slice(0, 1) })).toMatchObject({ status: 409, data: { error: { code: "idempotency_mismatch" } } });
		expect((await p.tool({ action: "sql", sql: "SELECT count(*) FROM contributors WHERE repo = 'acme/web'" })).value.rows).toEqual([[4]]);

		const q = await refreshable();
		let failed = false, attempts = 0;
		const changed = { status: async (profile: string) => {
			const status = await q.refresher.status(profile);
			if (failed) status.refresh.chain = "0".repeat(64);
			return status;
		}, refresh: async (b: Json) => {
			if (b.command === "part") { failed = true; attempts++; throw new Error("HTTP 503"); }
			return q.refresher.refresh(b);
		} };
		expect(await refreshCorpus({ source, client: changed, profile: q.name, repo: "acme/web", observedAt: CUT, sourceId: FILE2, state: {} })).toMatchObject({ status: "refused", reason: "chain_mismatch" });
		expect(attempts).toBe(1);
		expect((await q.client.status(q.name)).refresh.next_op).toBe(0);
	});
	it("refuses a held-text view, changed DDL and missing projected columns before reading targets or persisting a plan", async () => {
		const p = await refreshable();
		const s = await syntheticSource(twoRepos);
		await s.inSource(sql => {
			sql.exec("DROP TABLE refs");
			sql.exec("CREATE TABLE session_messages (repo TEXT, body TEXT)");
			sql.exec("INSERT INTO session_messages VALUES ('acme/web', 'SYNTHETIC_HELD_SESSION_CANARY')");
			sql.exec("CREATE VIEW refs AS SELECT repo, 'refs/heads/main' AS refname, 'heads' AS namespace, 'main' AS short_name, '0000000000000000000000000000000000000001' AS target_sha, 'commit' AS object_type, '2026-09-01T00:00:00Z' AS creator_date, 'Alice' AS author_name, body AS subject FROM session_messages");
		});
		expect(await s.source.schema("refs")).toBeNull();
		const fresh = await isolated();
		expect(await uploadCorpus({source:s.source,client:fresh.client,profile:fresh.name,tables:["refs"],asOf:AS_OF,fileSha256:FILE2,state:{}})).toMatchObject({status:"refused",reason:"schema_mismatch"});
		let reads=0, saves=0, begins=0;
		const client={...p.refresher,refresh:async(b:Json)=>{if(b.command==="begin") begins++;return p.refresher.refresh(b);}};
		const source={...s.source,repoRows:async(...args:Parameters<typeof s.source.repoRows>)=>{reads++;return s.source.repoRows(...args);}};
		const state:Json={};
		const run=(selected=source)=>refreshCorpus({source:selected,client,profile:p.name,repo:"acme/web",observedAt:CUT,sourceId:FILE2,state,save:()=>{saves++;}});
		expect(await run()).toMatchObject({status:"refused",table:"refs",reason:"schema_mismatch"});
		const original=await syntheticSource(twoRepos);
		expect(await run({...source,schema:async(t:string)=>(await original.source.schema(t))+" "})).toMatchObject({status:"refused",reason:"schema_mismatch"});
		expect(await run({...source,schema:original.source.schema,columns:async()=>[]})).toMatchObject({status:"refused",reason:"columns"});
		expect({reads,saves,begins,state}).toEqual({reads:0,saves:0,begins:0,state:{}});
		expect((await p.tool({action:"get",kind:"ref",key:"acme/web:refs/heads/main"})).value.refs[0].subject).not.toBe("SYNTHETIC_HELD_SESSION_CANARY");
		expect((await p.client.status(p.name)).refresh).toBeNull();
	});
	it("counts cursor and receipt writes in the exact stored and replayed receipt on real SQLite", async () => {
		const p = await refreshable();
		const s = await syntheticSource(sql=>{twoRepos(sql);sql.exec("INSERT INTO contributors (repo,rank,commits,name) VALUES ('acme/web',3,1,'Zed')");});
		const state:Json={};
		const halted={...p.refresher,refresh:async(b:Json)=>{if(b.command==="part") throw new Error("hold before part"); return p.refresher.refresh(b);}};
		expect(await refreshCorpus({source:s.source,client:halted,profile:p.name,repo:"acme/web",observedAt:CUT,sourceId:FILE2,state})).toMatchObject({status:"stopped"});
		expect(state.plan.ops).toHaveLength(1);
		const store=env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${p.generation}`));
		const measured=await runInDurableObject(store,(_i,s)=>{
			const writes:Json[]=[];
			const measuredSql={exec:(q:string,...a:SqlStorageValue[])=>{
				const c=s.storage.sql.exec(q,...a),rows=c.toArray();
				if(c.rowsWritten) writes.push({statement:q.split(/\s+/).slice(0,4).join(" "),rows:c.rowsWritten});
				return {toArray:()=>rows,rowsWritten:c.rowsWritten};
			}} as unknown as SqlStorage;
			const text=s.storage.transactionSync(()=>reviewedRefresh(measuredSql,p.who,{command:"part",plan_id:state.plan.plan_id,start:0,ops:state.plan.ops}));
			const stored=s.storage.sql.exec<{receipt:string}>("SELECT receipt FROM corpus_refresh_parts WHERE plan_id = ? AND start = 0",state.plan.plan_id).one().receipt;
			const replay=s.storage.transactionSync(()=>reviewedRefresh(measuredSql,p.who,{command:"part",plan_id:state.plan.plan_id,start:0,ops:state.plan.ops}));
			return {receipt:JSON.parse(text as string),text,stored,replay,writes,actual:writes.reduce((n,w)=>n+w.rows,0)};
		});
		expect(measured.receipt.rows_written).toBe(3);
		expect(measured.receipt.rows_written).toBe(measured.actual);
		expect(measured.text).toBe(measured.stored);
		expect(measured.text).toBe(measured.replay);
		expect(measured.writes.slice(-2).map(w=>w.statement)).toEqual(["UPDATE corpus_refresh SET next_op","INSERT INTO corpus_refresh_parts (plan_id,"]);

	});
});

describe("corpus checkout scans and read-time views", () => {
	const scans = (files: [string, number][]) => (sql: SqlStorage) => {
		for (const [path, n] of files) sql.exec("INSERT INTO source_files (repo, path, blob_sha, size, scanned, skip_reason) VALUES ('acme/web', ?, ?, 10, 1, NULL)", path, sha(n));
		sql.exec(`INSERT INTO packages (id, repo, sha, path, role, package, version, scope) VALUES (NULL, 'acme/web', ?, 'package.json', 'dependency', '@acme/api', '1.0.0', 'dependencies'),
			(NULL, 'acme/api', ?, 'package.json', 'package', '@acme/api', '1.0.0', NULL)`, sha(1), sha(2));
		sql.exec("INSERT INTO frontend_files (snapshot_id, path, blob_sha, size, language, is_test, top_domain) VALUES ('acme/web', 'src/a.ts', ?, 10, 'typescript', 0, 'src')", sha(1));
		sql.exec("INSERT INTO env_refs (repo, sha, path, line, name, secret_reference) VALUES ('acme/web', ?, 'src/a.ts', 3, 'API_URL', 0)", sha(1));
	};

	it("refreshes the scan group per repo beside history: changed rows only, history never touches them, bulk loads refused, views carry as_of", async () => {
		const p = await refreshable();
		const sql = async (q: string) => (await p.tool({ action: "sql", sql: q })).value;
		const run = async (fill: (sql: SqlStorage) => void, repo: string, at: string, state: Json = {}) =>
			refreshCorpus({ source: (await syntheticSource(fill)).source, client: p.refresher, profile: p.name, repo, observedAt: at, sourceId: FILE2, state, group: "scans" });
		expect(await run(scans([["src/a.ts", 1], ["src/b.ts", 2], ["src/c.ts", 3]]), "acme/web", CUT)).toMatchObject({ status: "published", receipt: { targets: { source_files: { rows: 3 } } } });
		expect(await run(scans([]), "acme/api", CUT)).toMatchObject({ status: "published" });
		const kept = (await sql("SELECT rowid FROM source_files WHERE path = 'src/a.ts'")).rows;
		// b.ts changed and c.ts was deleted; a.ts keeps its row, so only the changed paths' rows were replaced.
		expect(await run(scans([["src/a.ts", 1], ["src/b.ts", 9], ["src/d.ts", 4]]), "acme/web", LATER)).toMatchObject({ status: "published" });
		expect((await sql("SELECT path, blob_sha FROM source_files WHERE repo = 'acme/web' ORDER BY path")).rows).toEqual([["src/a.ts", sha(1)], ["src/b.ts", sha(9)], ["src/d.ts", sha(4)]]);
		expect((await sql("SELECT rowid FROM source_files WHERE path = 'src/a.ts'")).rows).toEqual(kept);
		const files = await sql("SELECT count(*) AS n FROM source_files");
		expect(files.as_of.source_files).toMatchObject({ as_of: LATER, as_of_max: LATER, basis: "observed", refresh: "refresh", complete: true, rows: 3 });
		// A Git-history refresh of the same repo leaves every scan row and partition alone.
		expect(await refreshCorpus({ source: (await syntheticSource(nextCut)).source, client: p.refresher, profile: p.name, repo: "acme/web", observedAt: LATER, sourceId: FILE2, state: {} }))
			.toMatchObject({ status: "published" });
		expect((await sql("SELECT count(*) FROM source_files")).rows).toEqual([[3]]);
		expect((await sql("SELECT snapshot_id, path FROM frontend_files")).rows).toEqual([["acme/web", "src/a.ts"]]);
		// Read-time views: derived from loaded rows, with the as_of of the tables they read.
		const edges = await sql("SELECT consumer_repo, provider_repo, package, confidence FROM package_edges");
		expect(edges.rows).toEqual([["acme/web", "acme/api", "@acme/api", "declared_name"]]);
		expect(Object.keys(edges.as_of)).toEqual(["packages"]);
		const reverts = await sql("SELECT repo, reverts, total_commits FROM pattern_revert_stats ORDER BY repo");
		expect(reverts.rows.map((r: unknown[]) => r[0])).toEqual(["acme/api", "acme/web"]);
		expect(Object.keys(reverts.as_of)).toEqual(["commits"]);
		expect((await sql("SELECT repo, top_author_name, top_author_email, identity_caveat FROM pattern_bus_factor WHERE repo = 'acme/web'")).rows[0]).toMatchObject(["acme/web", expect.any(String), null, "author names; emails are never stored"]);
		// Scan tables never bulk load, under any source.
		const refused = await p.http(p.importer, "/v1/corpus/import", await body(p, "source_files", []));
		expect(refused).toMatchObject({ status: 403, data: { error: { details: { reason: "scan" } } } });
		const status = (await p.http(p.importer, `/v1/corpus/status?profile=${p.name}`)).data;
		expect(status.scan_families.map((f: Json) => f.table)).toContain("frontend_files");
		expect(status.families.map((f: Json) => f.table)).toEqual(TABLES);
	});
});

describe("corpus dated snapshots", () => {
	const SNAP = ["pattern_coordinated_changes", "pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits", "pattern_lineage_edges",
		"pattern_findings", "pattern_finding_repos"];
	/** One synthetic `patterns` cut under the original DDL; `tag` marks which cut a reader sees. Authors: a string array, null, and a contact in text. */
	const patterns = (tag: string) => (sql: SqlStorage) => {
		sql.exec(`INSERT INTO pattern_coordinated_changes (rowid, episode_id, ticket, classification, confidence, first_at, last_at, span_days, repo_count, commit_count, non_merge_repos, layers_json)
			VALUES (3, ?, 'XP-1', 'feature', 'high', '2026-07-01', '2026-07-03', 2.5, 2, 4, 2, '["api","web"]')`, `ep-${tag}`);
		sql.exec(`INSERT INTO pattern_coordinated_change_repos (rowid, episode_id, repo, layer, first_at, last_at, commits, non_merge_commits, authors_json, subjects_json)
			VALUES (7, ?, 'acme/web', 'web', '2026-07-01', '2026-07-02', 2, 2, '["Alice Example"]', '[]'), (9, ?, 'acme/api', 'api', '2026-07-02', '2026-07-03', 2, 2, NULL, '[]')`, `ep-${tag}`, `ep-${tag}`);
		sql.exec(`INSERT INTO pattern_synchronized_migrations (rowid, episode_id, normalized_subject, confidence, first_at, last_at, span_hours, repo_count, commit_count, authors_json, common_paths_json)
			VALUES (1, ?, 'bump deps', 'high', '2026-07-01', '2026-07-01', 1.5, 2, 2, '["Bo Builder"]', '["package.json"]')`, `mg-${tag}`);
		sql.exec(`INSERT INTO pattern_migration_commits (rowid, episode_id, repo, sha, committer_at, author_name, author_email, subject, paths_json)
			VALUES (5, ?, 'acme/web', ?, '2026-07-01', 'Alice Example', 'alice@acme.example', 'Bump deps; ping alice@acme.example', '["package.json"]')`, `mg-${tag}`, sha(5));
		sql.exec(`INSERT INTO pattern_lineage_edges (rowid, repo_a, repo_b, shared_commits, pct_of_smaller, first_shared_at, last_shared_at, first_unique_a, first_unique_b, last_unique_a, last_unique_b,
			explicit_cherry_a_to_b, explicit_cherry_b_to_a, confidence, inference) VALUES (1, 'acme/web', 'acme/api', 3, 50.0, '2026-01-01', '2026-02-01', NULL, NULL, NULL, NULL, 0, 1, 'medium', 'fork')`);
		sql.exec(`INSERT INTO pattern_findings (rowid, finding_id, category, title, confidence, evidence_type, temporal_scope, summary, first_at, last_at, repo_count, commit_count, evidence_json, reproducible_sql)
			VALUES (2, 'f-1', 'delivery', 'Coordinated releases', 'medium', 'pattern', 'yearly', ?, '2026-01-01', '2026-07-01', 2, 4, '[]', 'SELECT 1')`, `summary ${tag}`);
		sql.exec("INSERT INTO pattern_finding_repos (rowid, finding_id, repo, role, first_at, last_at, metric, evidence_json) VALUES (4, 'f-1', 'acme/web', 'lead', '2026-01-01', '2026-07-01', 1.0, '[]')");
	};
	type Rpc = { query(who: unknown, q: unknown): Promise<Json> };

	it("publishes the whole patterns set atomically in work: rowids, as_of, guard terms and privacy; malformed authors and stage reads refused", async () => {
		const w = await workAccount();
		const sql = (q: string) => (w.corpus() as unknown as Rpc).query(w.ref("work"), { action: "sql", sql: q });
		const st = await w.client.status("work");
		const fam = st.snapshot_families.find((f: Json) => f.table === "pattern_coordinated_change_repos");
		const { chunkHash } = await import("../src/corpus/families");
		const c = { table: fam.table, schema_sha256: fam.schema_sha256, source: { file_sha256: FILE }, as_of: AS_OF, columns: fam.columns, after: null, final: false,
			rows: [[1, "e", "acme/web", "web", null, null, 1, 1, '[{"name":"Mallory"}]', null]] };
		expect(await w.http("/v1/corpus/import", { profile: "work", generation: st.generation, ...c, sha256: chunkHash(c) }))
			.toMatchObject({ status: 400, data: { error: { details: { reason: "people_json" } } } });
		const { source } = await syntheticSource(patterns("a"));
		// A run that stops before the last member's final chunk publishes nothing: the live tables stay empty.
		let sends = 0;
		const flaky = { status: w.client.status, send: async (x: unknown) => { if (++sends > 6) throw new Error("offline"); return w.client.send(x); } };
		expect(await uploadCorpus({ source, client: flaky, profile: "work", tables: SNAP, asOf: AS_OF, fileSha256: FILE, state: {} })).toMatchObject({ status: "stopped", reason: "offline" });
		expect((await sql("SELECT count(*) FROM pattern_coordinated_change_repos")).value).toMatchObject({ rows: [[0]] });
		expect(await sql("SELECT * FROM corpus_stage_pattern_coordinated_change_repos")).toMatchObject({ ok: false, error: { details: { reason: "sql_refused" } } });
		expect(await uploadCorpus({ source, client: w.client, profile: "work", tables: SNAP, asOf: AS_OF, fileSha256: FILE, state: {} })).toMatchObject({ status: "done" });
		const repos = (await sql("SELECT rowid, repo, authors_json FROM pattern_coordinated_change_repos ORDER BY rowid")).value!;
		expect(repos.rows).toEqual([[7, "acme/web", '["Alice Example"]'], [9, "acme/api", null]]);
		expect(repos.as_of.pattern_coordinated_change_repos).toMatchObject({ as_of: AS_OF, basis: "declared_snapshot", refresh: "snapshot", complete: true, rows: 2, source_sha256: FILE });
		expect((await sql("SELECT author_name, author_email, subject FROM pattern_migration_commits")).value!.rows).toEqual([["Alice Example", null, "Bump deps; ping [REDACTED]"]]);
		expect(await runInDurableObject(w.corpus(), (_i, s) => SNAP.map((t) => s.storage.sql.exec(`SELECT count(*) AS n FROM corpus_stage_${t}`).one().n))).toEqual(SNAP.map(() => 0));
		expect(await w.terms()).toEqual(expect.arrayContaining(["acme/web", "acme/api", "Alice Example", "Bo Builder"]));
		expect((await w.terms()).join(" ")).not.toMatch(/@|REDACTED|Mallory/);
	});

	it("replays published chunks and refuses stale cuts; abandoning clears stage and receipts at once; an abandoned cut restarts; a restored loading cut resends whole", async () => {
		const p = await isolated();
		const { cutIdOf } = await import("../src/corpus/snapshots");
		const { accountStub } = await import("../src/mcp");
		const { readManifest } = await import("../src/backup");
		const admin = async (cmd: Json) => { const r = await accountStub(env, OWNER).admin(cmd as never); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value as Json; };
		const load = async (tag: string, file: string, asOf: string, client: Json = p.client) =>
			uploadCorpus({ source: (await syntheticSource(patterns(tag))).source, client, profile: p.name, tables: SNAP, asOf, fileSha256: file, state: {} });
		const stopAfter = (n: number) => { let k = 0; return { status: p.client.status, send: async (x: unknown) => { if (++k > n) throw new Error("offline"); return p.client.send(x); } }; };
		const inStore = <T,>(g: string, f: (sql: SqlStorage) => T) => runInDurableObject(env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${g}`)), (_i, s) => f(s.storage.sql));
		const receipts = (g: string, id: string) => inStore(g, (sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM corpus_requests WHERE substr(request_id, 1, ?) = ?",
			`corpus:snapshot:${id}:`.length, `corpus:snapshot:${id}:`).one().n);
		const view = (g: string) => inStore(g, (sql) => ({ ledger: sql.exec<{ cut_id: string; state: string }>("SELECT cut_id, state FROM corpus_snapshots ORDER BY as_of").toArray().map((r) => [r.cut_id, r.state]),
			live: sql.exec<{ e: string }>("SELECT episode_id AS e FROM pattern_coordinated_changes").toArray().map((r) => r.e), stage: sql.exec<{ n: number }>("SELECT count(*) AS n FROM corpus_stage_pattern_coordinated_changes").one().n }));
		const C3 = "ef".repeat(32), A = cutIdOf("patterns", FILE, AS_OF), B = cutIdOf("patterns", FILE2, CUT), C = cutIdOf("patterns", C3, LATER);
		const sent: Json[] = [];
		expect(await load("a", FILE, AS_OF, { status: p.client.status, send: async (x: Json) => { sent.push(x); return p.client.send(x); } })).toMatchObject({ status: "done" });
		expect(await p.client.send(sent[0])).toMatchObject({ receipt: { status: "replayed", snapshot: { cut_id: A, state: "published" } } });
		expect(await load("z", "12".repeat(32), AS_OF)).toMatchObject({ status: "refused", reason: "stale_snapshot" });
		// B starts; a newer C abandons it in the same transaction: its stage rows and its request receipts go together.
		expect(await load("b", FILE2, CUT, stopAfter(1))).toMatchObject({ status: "stopped" });
		expect(await receipts(p.generation, B)).toBe(1);
		expect(await load("c", C3, LATER, stopAfter(1))).toMatchObject({ status: "stopped" });
		expect(await receipts(p.generation, B)).toBe(0);
		expect(await view(p.generation)).toEqual({ ledger: [[A, "published"], [B, "abandoned"], [C, "loading"]], live: ["ep-a"], stage: 1 });
		// The abandoned B restarts from its first chunk on a reset ledger and publishes whole, abandoning C; A is superseded.
		expect(await load("b", FILE2, CUT)).toMatchObject({ status: "done" });
		expect(await view(p.generation)).toEqual({ ledger: [[A, "superseded"], [B, "published"], [C, "abandoned"]], live: ["ep-b"], stage: 0 });
		expect(await receipts(p.generation, B)).toBe(7);
		// Export with C loading: stages are not exported; the restored C is abandoned with its receipts before the generation opens.
		expect(await load("c", C3, LATER, stopAfter(1))).toMatchObject({ status: "stopped" });
		const exportId = (await admin({ op: "export", profile: p.name, corpus: true }))[`corpus-${p.name}`].id as string;
		const m = await readManifest(env, `corpus-${p.name}`, exportId, OWNER);
		expect(m.ok && Object.keys(m.value.counts).filter((t) => t.startsWith("corpus_stage_"))).toEqual([]);
		expect(m.ok && m.value.counts.corpus_snapshots).toBe(3);
		const g2 = rand();
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => {
			s.storage.sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g2, `${OWNER}:${p.name}:${g2}`, p.name);
			s.storage.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g2, p.name, new Date().toISOString());
		});
		await admin({ op: "beginCorpusRestore", profile: p.name, export: exportId });
		expect(await admin({ op: "restoreStep" })).toMatchObject({ state: "ready" });
		await admin({ op: "openRestore" });
		expect(await view(g2)).toEqual({ ledger: [[A, "superseded"], [B, "published"], [C, "abandoned"]], live: ["ep-b"], stage: 0 });
		expect([await receipts(g2, C), await receipts(g2, B)]).toEqual([0, 7]);
		// The uploader resends C from its first chunk; B stays live until C publishes whole.
		expect(await load("c", C3, LATER)).toMatchObject({ status: "done", generation: g2 });
		expect(await view(g2)).toEqual({ ledger: [[A, "superseded"], [B, "superseded"], [C, "published"]], live: ["ep-c"], stage: 0 });
	});
});

describe("corpus v5 record snapshots", () => {
	const TICKETS = ["tickets", "ticket_episodes"], PRS = ["pull_requests", "pr_tickets", "pr_commit_links"], SESSIONS = ["codex_sessions", "session_commit_links", "session_ticket_links"];
	const JUDGMENT = ["validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties", "ownership", "predecessor_links", "journey_edges"];
	/** Tiny record fixtures under the original DDL; builder keys, local paths and relevance text sit in columns that never upload. */
	const records = (tag = "a") => (sql: SqlStorage) => {
		for (const [i, repo] of [[1, "acme/api"], [2, "acme/web"], [3, "acme/web"]] as const) sql.exec("INSERT INTO tickets (ticket, repo, sha) VALUES ('XP-1', ?, ?)", repo, sha(i));
		for (let i = 0; i < 501; i++) sql.exec("INSERT INTO tickets (ticket, repo, sha) VALUES ('XP-9', 'acme/web', ?)", sha(100 + i));
		sql.exec(`INSERT INTO ticket_episodes (rowid, episode_id, ticket, episode_no, repo_count, commit_count, unique_sha_count, non_merge_repos, first_date, last_date, span_days, classification, confidence)
			VALUES (4, ?, 'XP-1', 1, 2, 3, 3, 2, '2026-07-01', '2026-07-03', 2.0, 'feature', 'high')`, `ep-${tag}`);
		sql.exec(`INSERT INTO pull_requests (rowid, pr_key, repo, number, title, body, state, is_draft, author, created_at, updated_at, closed_at, merged_at, merged_by, base_ref, base_sha, head_ref,
			head_sha, head_repo, merge_sha, commit_count, labels_json, milestone_json, requested_reviewers_json, requested_teams_json, tickets_json, url, rest_present, "pr_key:1")
			VALUES (6, 'acme/web#12', 'acme/web', 12, 'Fix XP-1', 'Body; ping ops@acme.example', 'merged', 0, 'alice-gh', '2026-07-01', '2026-07-02', '2026-07-02', '2026-07-02', 'bob-gh',
			'main', ?, 'fix', ?, 'acme/web', ?, 1, '[]', NULL, '["carol-gh"]', '[]', '["XP-1"]', 'https://github.com/acme/web/pull/12', 1, 'builder')`, sha(1), sha(2), sha(3));
		sql.exec("INSERT INTO pr_tickets (rowid, repo, number, ticket) VALUES (1, 'acme/web', 12, 'XP-1')");
		sql.exec("INSERT INTO pr_commit_links (rowid, repo, number, relation, sha) VALUES (1, 'acme/web', 12, 'head', ?)", sha(2));
		sql.exec(`INSERT INTO codex_sessions (rowid, session_id, source_file, store, created_at, cwd, originator, cli_version, git_repo, git_branch, git_commit, events, relevant, relevance_json)
			VALUES (2, 's-1', '/Users/owner/.codex/s-1.jsonl', 'codex', '2026-07-01T00:00:00Z', '/Users/owner/code/web', 'codex_cli', '0.9', '/Users/owner/code/web', 'main', ?, 10, 1, '{"text":"private prose"}')`, sha(2));
		sql.exec("INSERT INTO session_commit_links (rowid, session_id, commit_ref, repo, sha, resolution) VALUES (1, 's-1', 'abc1234', 'acme/web', ?, 'exact')", sha(2));
		sql.exec("INSERT INTO session_ticket_links (rowid, session_id, ticket) VALUES (1, 's-1', 'XP-1')");
	};
	type Rpc = { query(who: unknown, q: unknown): Promise<Json> };

	it("keeps the v4 patterns identity and migration 4 bytes under migration 5", async () => {
		const { cutIdOf, snapshotRequestId, SNAPSHOT_SETS } = await import("../src/corpus/snapshots");
		const { CORPUS_MIGRATIONS } = await import("../src/corpus/store");
		// Pinned from the ROOT v4 module (snapshots.ts 32644075) before migration 5 existed.
		expect(cutIdOf("patterns", FILE, AS_OF)).toBe("30fe79fb4f277c2ec29013f34fef9247bb9eba86280ec3bc0885b445a5e53006");
		expect(sha256(JSON.stringify(CORPUS_MIGRATIONS[3]))).toBe("14cf1051272801bdc5f564dc8367ce352c5fe6a514db9f6595cad5bbb54b8626");
		expect(snapshotRequestId("c".repeat(64), "pattern_findings", [2])).toBe(`corpus:snapshot:${"c".repeat(64)}:pattern_findings:2`);
		expect(SNAPSHOT_SETS.patterns).toEqual(["pattern_coordinated_changes", "pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits",
			"pattern_lineage_edges", "pattern_findings", "pattern_finding_repos"]);
		expect(CORPUS_MIGRATIONS).toHaveLength(5);
	});

	it("pages, replays and restarts WITHOUT ROWID tickets by composite key; answers pr, ticket and session gets and explore; restores exact-NULL pr_key:1", async () => {
		const p = await isolated();
		const { cutIdOf } = await import("../src/corpus/snapshots");
		const { chunkHash } = await import("../src/corpus/families");
		const { accountStub } = await import("../src/mcp");
		const load = async (tables: string[], tag: string, file: string, asOf: string, client: Json = p.client, chunkRows = 200) =>
			uploadCorpus({ source: (await syntheticSource(records(tag))).source, client, profile: p.name, tables, asOf, fileSha256: file, state: {}, chunkRows });
		const stopAfter = (n: number, sent: Json[] = []) => { let k = 0; return { status: p.client.status, send: async (x: Json) => { if (++k > n) throw new Error("offline"); sent.push(x); return p.client.send(x); } }; };
		const store = (g: string) => env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${g}`)) as unknown as Rpc;
		const get = (kind: string, key: string, g = p.generation) => store(g).query({ ...p.who, generation: g }, { action: "get", kind, key });
		// Composite paging: the first chunk ends inside XP-9; a cursor behind the stage's greatest key is refused; a resend replays under a hashed first key.
		const sent: Json[] = [];
		expect(await load(TICKETS, "a", FILE, AS_OF, stopAfter(1, sent))).toMatchObject({ status: "stopped" });
		const last = sent[0]!.rows.at(-1).slice(0, 3);
		const st = await p.client.status(p.name);
		expect(st.snapshots.tickets.loading.tables.tickets).toMatchObject({ rows: 200, last, final: false });
		expect(st.snapshot_families.find((f: Json) => f.table === "tickets").key).toEqual(["ticket", "repo", "sha"]);
		const behind: Json = { ...sent[0]!, after: sent[0]!.rows[0].slice(0, 3), rows: sent[0]!.rows.slice(1, 3), sha256: undefined };
		expect(await p.client.send({ ...behind, sha256: chunkHash(behind as never) })).toMatchObject({ error: { details: { reason: "out_of_order", expected_after: last } } });
		const replay = await p.client.send(sent[0]);
		expect(replay.receipt).toMatchObject({ status: "replayed", last_key: last });
		expect(replay.receipt.request_id).toMatch(new RegExp(`^corpus:snapshot:${cutIdOf("tickets", FILE, AS_OF)}:tickets:k[0-9a-f]{32}$`));
		expect(await load(TICKETS, "a", FILE, AS_OF)).toMatchObject({ status: "done" });
		// Restart: a newer cut abandons B, and B restarts whole from its first composite chunk.
		expect(await load(TICKETS, "b", FILE2, CUT, stopAfter(1))).toMatchObject({ status: "stopped" });
		expect(await load(TICKETS, "c", "ef".repeat(32), LATER, stopAfter(1))).toMatchObject({ status: "stopped" });
		expect(await load(TICKETS, "b", FILE2, CUT)).toMatchObject({ status: "done" });
		expect((await p.client.status(p.name)).snapshots.tickets).toMatchObject({ published: { cut_id: cutIdOf("tickets", FILE2, CUT) }, loading: null });
		expect(await load(PRS, "a", FILE, AS_OF)).toMatchObject({ status: "done" });
		expect(await load(SESSIONS, "a", FILE, AS_OF)).toMatchObject({ status: "done" });

		const ticket = await get("ticket", "XP-1");
		expect(ticket.value).toMatchObject({ kind: "ticket", found: true, episodes: [{ episode_id: "ep-b", ticket: "XP-1" }], commits_truncated: false, truncated: false });
		expect(ticket.value.commits.map((r: Json) => [r.repo, r.sha])).toEqual([["acme/api", sha(1)], ["acme/web", sha(2)], ["acme/web", sha(3)]]);
		expect(ticket.value.as_of.tickets).toMatchObject({ as_of: CUT, basis: "declared_snapshot", refresh: "snapshot", source_sha256: FILE2, rows: 504 });
		const many = await get("ticket", "XP-9");
		expect([many.value.commits.length, many.value.commits_truncated]).toEqual([500, true]);
		expect((await get("ticket", "NOPE-1")).value).toMatchObject({ found: false, episodes: [], commits: [] });
		const pr = await get("pr", "acme/web#12");
		expect(pr.value).toMatchObject({ found: true, pull_requests: [{ rowid: 6, number: 12, title: "Fix XP-1", body: "Body; ping [REDACTED]", author: "alice-gh" }],
			tickets: [{ ticket: "XP-1" }], commits: [{ relation: "head", sha: sha(2) }], tickets_truncated: false, commits_truncated: false });
		expect(Object.keys(pr.value.as_of)).toEqual(["pr_commit_links", "pr_tickets", "pull_requests"]);
		expect(pr.value.pull_requests[0]).not.toHaveProperty("pr_key");
		expect((await get("pr", "acme/web#99")).value.found).toBe(false);
		expect(await get("pr", "acme/web")).toMatchObject({ ok: false, error: { code: "validation" } });
		const session = await get("session", "s-1");
		expect(session.value).toMatchObject({ found: true, sessions: [{ session_id: "s-1", originator: "codex_cli", git_branch: "main" }], commits: [{ commit_ref: "abc1234" }], tickets: [{ ticket: "XP-1" }] });
		expect(Object.keys(session.value.sessions[0])).not.toEqual(expect.arrayContaining(["cwd"]));
		const hidden = await p.inCorpus((sql) => [sql.exec("SELECT pr_key, \"pr_key:1\" AS k1 FROM pull_requests").one(),
			sql.exec("SELECT source_file, store, cwd, git_repo, relevance_json FROM codex_sessions").one()]);
		expect(hidden).toEqual([{ pr_key: null, k1: null }, { source_file: null, store: null, cwd: null, git_repo: null, relevance_json: null }]);

		// Explore counts for PR and ticket nodes.
		await call(await contextFor(), "record_knowledge", { profile: p.name, nodes: [{ kind: "pr", key: "github:acme/web#12", name: "PR 12" }, { kind: "ticket", key: "jira:XP-1", name: "XP-1" }] });
		const explore = async (key: string) => JSON.parse(((await p.rpc("tools/call", { name: "explore", arguments: { profile: p.name, node: { key } } })).result as { content: { text: string }[] }).content[0]!.text).data as Json;
		expect((await explore("github:acme/web#12")).corpus).toMatchObject({ kind: "pr", key: "acme/web#12", counts: { pull_requests: 1, pr_tickets: 1, pr_commit_links: 1 } });
		expect((await explore("jira:XP-1")).corpus).toMatchObject({ kind: "ticket", key: "XP-1", counts: { tickets: 3, ticket_episodes: 1, pr_tickets: 1, session_ticket_links: 1 } });

		// Export/restore at schema 5: the never-uploaded pr_key:1 exports NULL and restores; a non-NULL value there refuses the restore.
		const admin = (cmd: Json) => accountStub(env, OWNER).admin(cmd as never) as Promise<Json>;
		const onAccount = (f: (sql: SqlStorage) => void) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => f(s.storage.sql));
		const move = (g: string) => onAccount((sql) => {
			sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g, `${OWNER}:${p.name}:${g}`, p.name);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g, p.name, new Date().toISOString());
		});
		const exportNow = async () => ((await admin({ op: "export", profile: p.name, corpus: true })).value as Json)[`corpus-${p.name}`].id as string;
		const first = await exportNow(), g2 = rand();
		await move(g2);
		expect(await admin({ op: "beginCorpusRestore", profile: p.name, export: first })).toMatchObject({ ok: true });
		expect(await admin({ op: "restoreStep" })).toMatchObject({ ok: true, value: { state: "ready" } });
		expect(await admin({ op: "openRestore" })).toMatchObject({ ok: true });
		expect((await get("pr", "acme/web#12", g2)).value).toMatchObject({ found: true, pull_requests: [{ rowid: 6 }] });
		expect((await get("ticket", "XP-1", g2)).value.commits).toHaveLength(3);
		await runInDurableObject(env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${p.name}:${g2}`)), (_i, s) => s.storage.sql.exec("UPDATE pull_requests SET \"pr_key:1\" = 'builder'"));
		const second = await exportNow(), g3 = rand();
		await move(g3);
		expect(await admin({ op: "beginCorpusRestore", profile: p.name, export: second })).toMatchObject({ ok: true });
		expect(await admin({ op: "restoreStep" })).toMatchObject({ ok: false, error: { code: "validation" } });
		await admin({ op: "abortRestore" });
	});

	it("registers judgment and PR repo and people terms in work, and loads the three session metadata tables", async () => {
		const w = await workAccount();
		const judged = (sql: SqlStorage) => {
			records()(sql);
			sql.exec(`INSERT INTO validated_contracts (rowid, key, name, journey, repository, sha, confidence, auth_contract_json, failure_boundaries_json, provenance_json)
				VALUES (1, 'c-1', 'Checkout auth', 'checkout', 'acme/contracts-repo', ?, 'high', '{}', '[]', '[]')`, sha(1));
			sql.exec(`INSERT INTO frontend_business_facts (rowid, fact_id, repo_key, domain, fact_type, statement, confidence, snapshot_id, evidence_json, notes)
				VALUES (1, 'f-1', 'acme/quokka-private', 'cart', 'rule', 'Totals round half up', 0.9, 'acme/quokka-private', '[]', NULL)`);
			sql.exec(`INSERT INTO frontend_workflows (rowid, workflow_id, repo_key, domain, name, actor, "trigger", steps_json, outcomes_json, confidence, snapshot_id, evidence_json, notes)
				VALUES (1, 'w-1', 'acme/flows-repo', 'cart', 'Checkout', 'buyer', 'click pay', '[]', '[]', 0.8, 'acme/flows-repo', '[]', NULL)`);
		};
		const { source } = await syntheticSource(judged);
		for (const tables of [JUDGMENT, PRS, SESSIONS]) expect(await uploadCorpus({ source, client: w.client, profile: "work", tables, asOf: AS_OF, fileSha256: FILE, state: {} })).toMatchObject({ status: "done" });
		expect(await w.terms()).toEqual(expect.arrayContaining(["acme/contracts-repo", "acme/quokka-private", "acme/flows-repo", "acme/web", "alice-gh", "bob-gh"]));
		expect((await w.terms()).join(" ")).not.toMatch(/@|REDACTED|carol-gh/);
		const rows = await (w.corpus() as unknown as Rpc).query(w.ref("work"), { action: "sql", sql: "SELECT \"trigger\" FROM frontend_workflows" });
		expect(rows.value.rows).toEqual([["click pay"]]);
	});
});
