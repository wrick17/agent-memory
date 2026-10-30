// node --test local/corpus-upload.test.mjs : the corpus CLI's read-only SQLite source and HTTP client, with the uploader core
// against a fake server. Synthetic files only; the Workers roundtrip is test/corpus.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileSha256, httpClient, sqliteSource } from "./corpus-cli.mjs";
import { chunkHash, uploadCorpus } from "./corpus-upload.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-corpus-test-"));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// The retained original DDL of two families (src/corpus/families.ts), one WITHOUT ROWID and one rowid table.
const COMMITS = `CREATE TABLE commits (
    repo TEXT NOT NULL, sha TEXT NOT NULL, parents TEXT NOT NULL,
    author_name TEXT, author_email TEXT, author_date TEXT,
    committer_name TEXT, committer_email TEXT, committer_date TEXT,
    subject TEXT, message TEXT, is_merge INTEGER NOT NULL,
    is_revert INTEGER NOT NULL, pr_number INTEGER, cherry_pick_source TEXT,
    PRIMARY KEY (repo, sha)
  ) WITHOUT ROWID`;
const CONTRIBUTORS = `CREATE TABLE contributors(
  repo TEXT,
  rank INT,
  commits INT,
  name TEXT,
  email TEXT
)`;
const families = [
	{ table: "commits", schema_sha256: sha256(COMMITS), key: ["repo", "sha"], columns: ["repo", "sha", "parents", "author_name", "author_date", "committer_name", "committer_date", "subject", "message", "is_merge", "is_revert", "pr_number", "cherry_pick_source"] },
	{ table: "contributors", schema_sha256: sha256(CONTRIBUTORS), key: ["rowid"], columns: ["rowid", "repo", "rank", "commits", "name"] },
];

function sourceFile() {
	const file = path.join(fs.mkdtempSync(path.join(tmp, "src-")), "sample.sqlite");
	const db = new DatabaseSync(file);
	db.exec(COMMITS); db.exec(CONTRIBUTORS);
	db.exec("CREATE VIEW refs AS SELECT 'x' AS repo");
	const c = db.prepare("INSERT INTO commits VALUES (?, ?, '[]', 'Alice', 'alice@acme.example', '2026-07-01', 'Alice', 'alice@acme.example', '2026-07-01', ?, ?, 0, 0, NULL, NULL)");
	for (const [repo, n] of [["acme/web", 2], ["acme/api", 1], ["acme/web", 1]]) c.run(repo, String(n).repeat(40), `subject ${n}`, `body ${n}\nCo-authored-by: Bob <bob@acme.example>`);
	db.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (5, 'acme/web', 1, 2, 'Alice', 'alice@acme.example'), (9, 'acme/web', 2, 1, 'Bob', 'bob@acme.example')");
	db.close();
	return file;
}

/** The server's order, replay and progress rules in memory, enough for the client side. */
function fakeServer() {
	const tables = new Map(), requests = new Map(), sent = [];
	return {
		sent,
		status: async () => ({ generation: "g1", families, held: { session_messages: "never_import" }, tables: [...tables.entries()].map(([table, t]) => ({ table, ...t })) }),
		send: async (c) => {
			sent.push(c);
			assert.equal(c.sha256, chunkHash(c));
			const id = `${c.table}:${JSON.stringify(c.rows[0] ?? "end")}`;
			if (requests.has(id)) return { receipt: requests.get(id) };
			const t = tables.get(c.table) ?? { rows: 0, last_key: null, complete: false, as_of: c.as_of, source_sha256: c.source.file_sha256 };
			if (JSON.stringify(t.last_key) !== JSON.stringify(c.after)) return { error: { code: "validation", details: { reason: "out_of_order" } } };
			const fam = families.find((f) => f.table === c.table);
			const last = c.rows.length ? fam.key.map((k) => c.rows.at(-1)[fam.columns.indexOf(k)]) : c.after;
			tables.set(c.table, { ...t, rows: t.rows + c.rows.length, last_key: last, complete: c.final });
			const receipt = { status: "stored", sha256: c.sha256, last_key: last, complete: c.final };
			requests.set(id, receipt);
			return { receipt };
		},
	};
}

describe("corpus CLI source", () => {
	it("reads exact DDL for tables only, pages by the stable key, and never writes the file", async () => {
		const file = sourceFile();
		const before = await fileSha256(file);
		const s = sqliteSource(file);
		assert.equal(s.schema("commits"), COMMITS);
		assert.equal(s.schema("refs"), null);
		assert.deepEqual(s.columns("contributors"), ["repo", "rank", "commits", "name", "email"]);
		assert.deepEqual(s.rows("contributors", ["rowid", "name"], ["rowid"], null, 10), [[5, "Alice"], [9, "Bob"]]);
		assert.deepEqual(s.rows("contributors", ["rowid", "name"], ["rowid"], [5], 10), [[9, "Bob"]]);
		assert.deepEqual(s.rows("commits", ["repo", "sha"], ["repo", "sha"], ["acme/api", "1".repeat(40)], 10), [["acme/web", "1".repeat(40)], ["acme/web", "2".repeat(40)]]);
		assert.throws(() => s.rows("commits; DROP TABLE commits", ["repo"], ["repo"], null, 1), /unsafe identifier/);
		s.close();
		assert.equal(await fileSha256(file), before);
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sample.sqlite"]);
	});

	it("uploads redacted key-ordered chunks, resumes from the server, and refuses forbidden or held tables before reading", async () => {
		const file = sourceFile();
		const server = fakeServer(), state = {};
		const s = sqliteSource(file);
		const run = (tables, client = server) => uploadCorpus({ source: s, client, profile: "test", tables, asOf: "2026-08-12T13:30:59.154Z", fileSha256: "ab".repeat(32), state, chunkRows: 2 });
		assert.deepEqual(await run(["session_messages"]), { status: "refused", table: "session_messages", reason: "never_import" });
		assert.deepEqual(await run(["refs"]), { status: "refused", table: "refs", reason: "unknown_table" });
		assert.equal(server.sent.length, 0);
		assert.equal((await run(["commits", "contributors"])).status, "done");
		assert.deepEqual(server.sent.map((c) => [c.table, c.rows.length, c.final]), [["commits", 2, false], ["commits", 1, true], ["contributors", 2, true]]);
		assert.equal(server.sent[0].rows[0][8], "body 1\nCo-authored-by: Bob <[REDACTED]>");
		assert.ok(!JSON.stringify(server.sent).includes("@acme.example"));
		assert.deepEqual(state.tables.commits, { last_key: ["acme/web", "2".repeat(40)], rows: 3, complete: true });
		assert.equal((await run(["commits", "contributors"])).status, "done");
		assert.equal(server.sent.length, 3);
		assert.deepEqual(await run(["commits"], { ...server, status: async () => ({ ...(await server.status()), generation: "g2" }) }), { status: "refused", reason: "generation_changed" });
		s.close();
	});
});

describe("corpus CLI client", () => {
	it("retries server errors, never follows a redirect, and sends the token only as a header", async () => {
		const tokenFile = path.join(tmp, "token");
		fs.writeFileSync(tokenFile, "am_x_id_secret\n", { mode: 0o600 });
		const config = { server: "https://memory.test", tokenFile };
		const calls = [];
		const replies = [new Response("busy", { status: 503 }), Response.json({ generation: "g1" })];
		const client = httpClient({ config, sleep: async () => {}, fetchImpl: async (url, init) => { calls.push([String(url), init.redirect, init.headers.authorization]); return replies.shift(); } });
		assert.deepEqual(await client.status("test"), { generation: "g1" });
		assert.deepEqual(calls, Array(2).fill(["https://memory.test/v1/corpus/status?profile=test", "manual", "Bearer am_x_id_secret"]));
		const redirecting = httpClient({ config, sleep: async () => {}, fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
		await assert.rejects(redirecting.send({ table: "commits" }), /redirect refused/);
	});
});
