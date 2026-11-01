// node --test local/corpus-upload.test.mjs : the corpus CLI's read-only SQLite source and HTTP client, with the uploader core
// against a fake server. Synthetic files only; the Workers roundtrip is test/corpus.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileSha256, httpClient, sqliteSource } from "./corpus-cli.mjs";
import { chains, FAMILIES, planIdOf, planOps, rowHash, seedOf } from "./corpus-refresh.mjs";
import { chunkHash, snapshotCutOf, uploadCorpus } from "./corpus-upload.mjs";

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
		const s = await sqliteSource(file);
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
		const s = await sqliteSource(file);
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

	it("pins validation, rows and identity to one committed SQLite cut including WAL, without changing the original", async () => {
		const file = path.join(fs.mkdtempSync(path.join(tmp, "wal-")), "sample.sqlite");
		const writer = new DatabaseSync(file);
		writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE repos(full_name TEXT PRIMARY KEY, head_sha TEXT); CREATE TABLE refs(repo TEXT, refname TEXT, target_sha TEXT); INSERT INTO repos VALUES('acme/web','old'); INSERT INTO refs VALUES('acme/web','main','old'); PRAGMA wal_checkpoint(TRUNCATE)");
		const mainHash = await fileSha256(file), source = await sqliteSource(file);
		try {
			assert.deepEqual(source.repoRows("repos", ["full_name", "head_sha"], "acme/web"), [["acme/web", "old"]]);
			writer.exec("BEGIN; UPDATE repos SET head_sha='new'; UPDATE refs SET target_sha='new'; ALTER TABLE refs ADD COLUMN extra TEXT; COMMIT");
			const walHash = await fileSha256(`${file}-wal`);
			assert.equal(await fileSha256(file), mainHash);
			assert.deepEqual(source.repoRows("refs", ["repo", "refname", "target_sha"], "acme/web"), [["acme/web", "main", "old"]]);
			assert.equal(source.columns("refs").includes("extra"), false);
			assert.doesNotMatch(source.schema("refs"), /extra/);
			const fresh = await sqliteSource(file), same = await sqliteSource(file);
			try {
				assert.deepEqual(fresh.repoRows("repos", ["full_name", "head_sha"], "acme/web"), [["acme/web", "new"]]);
				assert.deepEqual(fresh.repoRows("refs", ["repo", "refname", "target_sha"], "acme/web"), [["acme/web", "main", "new"]]);
				assert.equal(fresh.columns("refs").includes("extra"), true);
				assert.match(fresh.schema("refs"), /extra/);
				assert.match(fresh.fileSha256, /^[a-f0-9]{64}$/);
				assert.notEqual(fresh.fileSha256, source.fileSha256);
				assert.equal(fresh.fileSha256, same.fileSha256);
				assert.equal(await fileSha256(file), mainHash);
				assert.equal(await fileSha256(`${file}-wal`), walHash);
			} finally { fresh.close(); same.close(); }
		} finally { source.close(); writer.close(); }
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
		const posts = [];
		const refreshing = httpClient({ config, sleep: async () => {}, fetchImpl: async (url, init) => { posts.push([String(url), init.method, init.body]); return Response.json({ receipt: { status: "stored" } }); } });
		assert.deepEqual(await refreshing.refresh({ command: "finish" }), { receipt: { status: "stored" } });
		assert.deepEqual(posts, [["https://memory.test/v1/corpus/refresh", "POST", '{"command":"finish"}']]);
		const unavailable = httpClient({ config, sleep: async () => {}, fetchImpl: async () => new Response(null, { status: 503 }) });
		await assert.rejects(unavailable.refresh({ command: "part" }), /^Error: HTTP 503$/);
		const disconnected = httpClient({ config, sleep: async () => {}, fetchImpl: async () => { throw Object.assign(new Error("offline"), { code: "ECONNRESET" }); } });
		await assert.rejects(disconnected.refresh({ command: "part" }), /^Error: network: ECONNRESET$/);
	});
});

describe("corpus refresh planner", () => {
	it("refuses a Git projection without base metadata before replacing an existing repo", async () => {
		const { refreshCorpus } = await import("./corpus-refresh.mjs");
		const zero = "0".repeat(64), state = {}, calls = [];
		const client = {
			status: async () => ({ generation: "g1", families: FAMILIES.map((table) => ({ table, schema_sha256: sha256(table), columns: [] })) }),
			refresh: async (cmd) => {
				calls.push(cmd.command);
				assert.equal(cmd.command, "inspect");
				return { page: { binding: { epoch: 1 }, rows: cmd.table === "repos" ? [[[], zero, 1]] : [], partition: { rows: cmd.table === "repos" ? 1 : 0, sum: zero }, next: null } };
			},
		};
		const source = { schema: (table) => table, columns: () => [], repoRows: () => { throw new Error("target_read"); } };
		const input = { source, client, profile: "test", repo: "acme/web", state, save: () => assert.fail("no plan is saved") };
		assert.deepEqual(await refreshCorpus({ ...input, requireNewRepo: true }), { status: "refused", reason: "repo_metadata_required" });
		assert.equal(state.plan, undefined);
		assert.ok(calls.length > 0 && calls.every((cmd) => cmd === "inspect"));
		await assert.rejects(refreshCorpus(input), /target_read/);
	});

	it("reads one repo's rows from the file and plans the server's ordered delta, keeping the smallest matched contributor rowids", async () => {
		const file = sourceFile();
		const s = await sqliteSource(file);
		assert.deepEqual(s.repoRows("contributors", ["repo", "rank", "commits", "name"], "acme/web"), [["acme/web", 1, 2, "Alice"], ["acme/web", 2, 1, "Bob"]]);
		assert.deepEqual(s.repoRows("commits", ["repo", "sha"], "acme/api"), [["acme/api", "1".repeat(40)]]);
		s.close();
		const fams = Object.fromEntries(FAMILIES.map((t) => [t, { schema_sha256: sha256(t), columns: t === "contributors" ? ["repo", "rank", "commits", "name"] : t === "commits" ? ["repo", "sha", "subject"]
			: t === "commit_paths" ? ["repo", "sha", "path", "top_component", "extension"] : t === "refs" ? ["repo", "refname", "subject"] : ["full_name", "description"] }]));
		const h = (t, v) => rowHash(t, fams[t].schema_sha256, v);
		const alice = ["acme/web", 1, 2, "Alice"], bob = ["acme/web", 2, 1, "Bob"];
		const base = { repos: [[[], h("repos", ["acme/web", "old"])]], commits: [[["1".repeat(40)], h("commits", ["acme/web", "1".repeat(40), "one"])], [["2".repeat(40)], h("commits", ["acme/web", "2".repeat(40), "two"])]],
			refs: [], commit_paths: [[["2".repeat(40), "a.ts"], h("commit_paths", ["acme/web", "2".repeat(40), "a.ts", "", "ts"])]],
			contributors: [[[9], h("contributors", alice)], [[5], h("contributors", alice)], [[7], h("contributors", bob)]] };
		const target = { repos: [["acme/web", "new"]], commits: [["acme/web", "1".repeat(40), "one"], ["acme/web", "3".repeat(40), "three"]], refs: [["acme/web", "main", "x"]], commit_paths: [],
			contributors: [alice, ["acme/web", 3, 1, "Cy"]] };
		assert.deepEqual(planOps(fams, base, target).map((op) => [op[0], op[1], op[0] === "d" ? op[2] : op[2].at(-1)]), [
			["d", "commit_paths", ["2".repeat(40), "a.ts"]], ["d", "commits", ["2".repeat(40)]], ["d", "contributors", [7]], ["d", "contributors", [9]],
			["p", "repos", "new"], ["p", "commits", "three"], ["p", "refs", "x"], ["p", "contributors", "Cy"]]);
		// The acyclic identity (design revision 2): a zero-op chain is the seed, and the plan id binds the final header with its chain.
		const header = { version: "corpus-refresh/1", repo: "acme/web", intent: "refresh", base: { kind: "published", epoch: 0 }, source: { kind: "sqlite-file", id: "ab".repeat(32), scope: "complete-repo-projection" },
			projection: "corpus-projection/1", schemas: Object.fromEntries(FAMILIES.map((t) => [t, fams[t].schema_sha256])), observed: FAMILIES, observed_at: "2026-09-07T10:26:00.162Z",
			targets: Object.fromEntries(FAMILIES.map((t) => [t, { rows: 0, sum: "0".repeat(64) }])), op_count: 0, chain: "" };
		const seed = seedOf("test", "g1", header);
		assert.deepEqual(chains(seed, []), [seed]);
		assert.equal(seedOf("test", "g1", { ...header, chain: seed }), seed);
		assert.notEqual(planIdOf("test", "g1", { ...header, chain: seed }), seed);
		assert.notEqual(planIdOf("test", "g1", { ...header, chain: seed }), planIdOf("test", "g2", { ...header, chain: seed }));
	});
});

describe("corpus Git adapter", () => {
	const gitAt = (dir, args, env = {}) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env } });
	const commit = (dir, who, at, msg) => gitAt(dir, ["-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@acme.example`, "commit", "-q", "-m", msg],
		{ GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
	/** A scratch checkout: a root commit, a branch commit with a co-author email, a PR merge, a revert, a cherry-pick, both tag kinds. */
	function scratch() {
		const dir = path.join(fs.mkdtempSync(path.join(tmp, "git-")), "web");
		execFileSync("git", ["init", "-q", "-b", "main", dir]);
		gitAt(dir, ["remote", "add", "origin", "git@github.com:acme/web.git"]);
		fs.writeFileSync(path.join(dir, "README"), "r"); fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src", "app.ts"), "a");
		gitAt(dir, ["add", "."]); commit(dir, "Alice", "2026-07-01T10:00:00+05:30", "Add the app (#12)\n\nCo-authored-by: Bob <bob@acme.example>\ncall +1 415 555 0100");
		gitAt(dir, ["checkout", "-q", "-b", "feat"]); fs.writeFileSync(path.join(dir, "src", "app.ts"), "b"); gitAt(dir, ["add", "."]); commit(dir, "Bob", "2026-07-02T09:00:00Z", "Tune retries");
		gitAt(dir, ["checkout", "-q", "main"]); gitAt(dir, ["-c", "user.name=Alice", "-c", "user.email=alice@acme.example", "merge", "-q", "--no-ff", "feat", "-m", "Merge pull request #7 from acme/feat"],
			{ GIT_AUTHOR_DATE: "2026-07-03T09:00:00Z", GIT_COMMITTER_DATE: "2026-07-03T09:00:00Z" });
		gitAt(dir, ["tag", "v1"]); gitAt(dir, ["-c", "user.name=Alice", "-c", "user.email=alice@acme.example", "tag", "-a", "v2", "-m", "Release two"], { GIT_COMMITTER_DATE: "2026-07-03T10:00:00Z" });
		return dir;
	}

	it("projects a checkout into the five families under the server's exact DDL, without reading any email", async () => {
		const { DDL, gitRows, repoOfCheckout, writeSnapshot } = await import("./corpus-git.mjs");
		const families = fs.readFileSync(new URL("../src/corpus/families.ts", import.meta.url), "utf8");
		for (const [t, ddl] of Object.entries(DDL)) assert.ok(families.includes(ddl), `${t} DDL matches src/corpus/families.ts byte for byte`);
		const dir = scratch(), repo = repoOfCheckout(dir);
		assert.equal(repo, "acme/web");
		const rows = gitRows(dir, repo);
		assert.deepEqual(rows.commits.map((c) => [c.subject, c.author_date, c.is_merge, c.pr_number, JSON.parse(c.parents).length]).sort(), [
			["Add the app (#12)", "2026-07-01T04:30:00Z", 0, 12, 0], ["Merge pull request #7 from acme/feat", "2026-07-03T09:00:00Z", 1, 7, 2], ["Tune retries", "2026-07-02T09:00:00Z", 0, null, 1]]);
		assert.deepEqual(rows.commit_paths.map((p) => [p.path, p.top_component, p.extension]).sort(), [["README", "", ""], ["src/app.ts", "src", "ts"], ["src/app.ts", "src", "ts"]]);
		assert.deepEqual(rows.refs.map((r) => [r.refname, r.namespace, r.short_name, r.object_type]), [["refs/heads/feat", "heads", "feat", "commit"], ["refs/heads/main", "heads", "main", "commit"],
			["refs/tags/v1", "tags", "v1", "commit"], ["refs/tags/v2", "tags", "v2", "tag"]]);
		assert.deepEqual(rows.contributors.map((c) => [c.rank, c.name, c.commits]), [[1, "Alice", 2], [2, "Bob", 1]]);
		assert.deepEqual(rows.repos, [{ full_name: "acme/web", owner: "acme", name: "web", description: null, archived: 0, private: 1, language: null, default_branch: "main", updated_at: null, url: null,
			commit_count: 3, ref_count: 4, head_sha: gitAt(dir, ["rev-parse", "HEAD"]).trim(), earliest_date: "2026-07-01", latest_date: "2026-07-03", empty: 0 }]);
		const snap = await writeSnapshot(rows), s = await sqliteSource(snap.file);
		try {
			for (const t of Object.keys(DDL)) assert.equal(s.schema(t), DDL[t]);
			const dump = new DatabaseSync(snap.file, { readOnly: true });
			const text = JSON.stringify(Object.keys(DDL).map((t) => dump.prepare(`SELECT * FROM ${t}`).all()));
			dump.close();
			assert.doesNotMatch(text.replace("bob@acme.example", ""), /@acme\.example/, "only the co-author trailer carries an email, and the refresh client redacts it");
		} finally { s.close(); snap.cleanup(); }
		assert.equal(fs.existsSync(path.dirname(snap.file)), false);
	});

	it("tracks non-HEAD local branch changes and deletion in refresh identity", async () => {
		const { refsDigest, gitRows } = await import("./corpus-git.mjs");
		const dir = scratch(), head = gitAt(dir, ["rev-parse", "HEAD"]).trim(), before = refsDigest(dir);
		const feature = gitAt(dir, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit-tree", `${head}^{tree}`, "-p", head, "-m", "Feature-only change"],
			{ GIT_AUTHOR_DATE: "2026-09-04T09:00:00Z", GIT_COMMITTER_DATE: "2026-09-04T09:00:00Z" }).trim();
		gitAt(dir, ["update-ref", "refs/heads/feat", feature]);
		assert.equal(gitAt(dir, ["rev-parse", "HEAD"]).trim(), head);
		assert.ok(gitRows(dir, "acme/web").commits.some((c) => c.sha === feature));
		const advanced = refsDigest(dir);
		assert.notEqual(advanced, before, "a branch-only commit changes the refresh identity");
		gitAt(dir, ["branch", "-D", "feat"]);
		assert.notEqual(refsDigest(dir), advanced, "deleting a local branch changes the refresh identity");
	});

	it("refreshes a changed checkout once a day, keeps an untouched one's as-of, resumes a saved plan, and carries loaded GitHub fields", async () => {
		const { refreshCheckouts } = await import("./corpus-git.mjs");
		const dir = scratch(), calls = [], saved = [];
		let reply = { status: "published", receipt: { status: "published" } };
		const refresh = async (a) => {
			calls.push({ repo: a.repo, observedAt: a.observedAt, commits: a.source?.repoRows("commits", ["sha"], a.repo).length ?? null, repos: a.source?.repoRows("repos", ["description", "private"], a.repo) ?? null });
			if (reply.status === "stopped") { a.state.plan = { header: { repo: a.repo } }; a.save(); }
			return reply;
		};
		const base = { repoRows: (t, cols, repo) => (repo === "acme/web" ? [["The web app", 0, 0, "TypeScript", "2026-08-01T00:00:00Z", "https://github.com/acme/web"]] : []) };
		const state = {}, run = (now, extra = {}) => refreshCheckouts({ checkouts: [dir], profile: "test", client: {}, state, save: (s) => saved.push(JSON.stringify(s)), now: new Date(now), base,
			openSource: sqliteSource, refresh, ...extra });
		assert.deepEqual((await run("2026-09-01T08:00:00Z")).map((r) => r.status), ["published"]);
		assert.deepEqual(calls.at(-1), { repo: "acme/web", observedAt: "2026-09-01T08:00:00.000Z", commits: 3, repos: [["The web app", 0]] });
		assert.deepEqual(await run("2026-09-02T08:00:00Z"), [{ checkout: dir, repo: "acme/web", status: "unchanged", as_of: "2026-09-01T08:00:00.000Z" }]);
		fs.writeFileSync(path.join(dir, "NEW.md"), "n"); gitAt(dir, ["add", "."]); commit(dir, "Cy", "2026-09-02T09:00:00Z", "Add notes");
		assert.equal((await run("2026-09-02T10:00:00Z", { base: null }))[0].status, "published");
		assert.equal(calls.at(-1).commits, 4);
		assert.deepEqual(calls.at(-1).repos, [["The web app", 0]], "later refreshes keep the last published metadata without reopening the base file");
		fs.writeFileSync(path.join(dir, "NEW.md"), "m"); gitAt(dir, ["add", "."]); commit(dir, "Cy", "2026-09-02T12:00:00Z", "Edit notes");
		assert.equal((await run("2026-09-02T13:00:00Z"))[0].status, "refreshed_today");
		assert.equal(calls.length, 2, "unchanged and already-refreshed checkouts make no request");
		// A stopped refresh keeps the marker and its saved plan; the next run resumes that plan whatever the day or digest.
		reply = { status: "stopped", reason: "unavailable" };
		assert.equal((await run("2026-09-03T08:00:00Z"))[0].status, "stopped");
		const mark = state.repos["acme/web"];
		assert.equal(mark.observed_at, "2026-09-02T10:00:00.000Z");
		assert.deepEqual(mark.pending.observed_at, "2026-09-03T08:00:00.000Z");
		assert.ok(saved.at(-1).includes('"plan"'), "the plan is durable before the run ends");
		reply = { status: "published", receipt: { status: "published" } };
		const resumed = await run("2026-09-03T09:00:00Z");
		assert.equal(resumed[0].status, "published");
		assert.deepEqual(calls.at(-1), { repo: "acme/web", observedAt: "2026-09-03T08:00:00.000Z", commits: null, repos: null }, "a resume reads no new source");
		assert.deepEqual([mark.observed_at, mark.day, mark.pending], ["2026-09-03T08:00:00.000Z", "2026-09-03", null]);
		// Not a checkout, or no origin: refused per checkout, never a request.
		const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
		assert.deepEqual((await refreshCheckouts({ checkouts: [plain], profile: "test", client: {}, state: {}, save: () => {}, openSource: sqliteSource, refresh })).map((r) => r.reason), ["no_origin_repo"]);
		assert.equal(calls.length, 4);
	});
});

describe("corpus checkout scans", () => {
	const g = (dir, args, env = {}) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Alice", GIT_AUTHOR_EMAIL: "alice@acme.example", GIT_COMMITTER_NAME: "Alice", GIT_COMMITTER_EMAIL: "alice@acme.example", ...env } });
	/** A frontend + API checkout: module federation, a route, API calls and endpoints, env and secret refs, a deploy workflow, a binary, a branch. */
	function frontend() {
		const dir = path.join(fs.mkdtempSync(path.join(tmp, "scan-")), "web");
		execFileSync("git", ["init", "-q", "-b", "main", dir]);
		const put = (p, body) => { fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), body); };
		put("package.json", JSON.stringify({ name: "@acme/web", version: "1.2.0", dependencies: { react: "^19.0.0", "@acme/api": "2.0.0" } }, null, 2));
		put("rspack.config.js", "module.exports = { plugins: [new ModuleFederationPlugin({\n  exposes: { './Cart': './src/features/cart/Cart.tsx' },\n  remotes: { checkout: 'checkout@https://cdn.acme-shop.io/remoteEntry.js' } })] };\n");
		put("src/features/cart/Cart.tsx", "import Pay from 'checkout/Pay';\nconst routes = [{ path: '/cart' }];\nexport const load = () => fetch(`${import.meta.env.VITE_API_URL}/api/cart/${id}`);\n");
		put("src/features/cart/Cart.test.tsx", "test('x', () => {});\n");
		put("server/app.js", "app.get('/api/cart/:id', requireAuth, handler);\nconst db = 'postgres://svc:hunter2@db.internal.acme.io:5432/app'; // owner ops@acme.example\n");
		put(".github/workflows/deploy.yml", "on:\n  push:\n  workflow_dispatch:\njobs:\n  deploy:\n    environment: production\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n        with:\n          apiToken: ${{ secrets.CF_API_TOKEN }}\n");
		put("node_modules/x/index.js", "x"); put("logo.png", "\0\x01bin");
		g(dir, ["add", "-A", "-f"]); g(dir, ["commit", "-q", "-m", "Init"], { GIT_AUTHOR_DATE: "2026-07-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-07-01T10:00:00Z" });
		g(dir, ["checkout", "-q", "-b", "feat"]); put("server/app.js", "app.post('/api/pay', handler);\n"); g(dir, ["commit", "-q", "-am", "Pay"]); g(dir, ["checkout", "-q", "main"]);
		g(dir, ["remote", "add", "origin", "https://github.com/acme/web.git"]);
		return dir;
	}

	it("scans HEAD into the 21 scan families under the server's exact DDL, by the documented extractors, keeping no credential", async () => {
		const { SCAN_DDL, scanRows } = await import("./corpus-scan.mjs");
		const { writeSnapshot } = await import("./corpus-git.mjs");
		const families = fs.readFileSync(new URL("../src/corpus/families.ts", import.meta.url), "utf8");
		assert.equal(Object.keys(SCAN_DDL).length, 21);
		for (const [t, ddl] of Object.entries(SCAN_DDL)) assert.ok(families.includes(`${t}: scan(${JSON.stringify(ddl)}`), `${t} DDL matches src/corpus/families.ts SCANS`);
		const dir = frontend(), rows = scanRows(dir, "acme/web");
		const pick = (t, ...cols) => rows[t].map((r) => cols.map((c) => r[c]));
		assert.deepEqual(pick("source_files", "path", "scanned", "skip_reason").sort(), [[".github/workflows/deploy.yml", 1, null], ["logo.png", 0, "binary"], ["node_modules/x/index.js", 0, "vendored_or_built"],
			["package.json", 1, null], ["rspack.config.js", 1, null], ["server/app.js", 1, null], ["src/features/cart/Cart.test.tsx", 1, null], ["src/features/cart/Cart.tsx", 1, null]]);
		assert.deepEqual(pick("api_endpoints", "method", "normalized_route", "kind", "security_signals"), [["GET", "/api/cart/:param", "express", '["requireAuth"]']]);
		assert.deepEqual(pick("api_callers", "category", "normalized_target", "base_env_refs"), [["fetch", "/api/cart/:param", '["VITE_API_URL"]']]);
		assert.deepEqual(pick("packages", "role", "package", "scope"), [["package", "@acme/web", null], ["dependency", "react", "dependencies"], ["dependency", "@acme/api", "dependencies"]]);
		assert.deepEqual(pick("env_refs", "name", "secret_reference").sort(), [["CF_API_TOKEN", 1], ["VITE_API_URL", 0]]);
		assert.deepEqual(pick("external_system_edges", "system", "system_type").sort(), [["cdn.acme-shop.io", "http"], ["db.internal.acme.io", "postgres"]]);
		assert.deepEqual(pick("architecture_workflows", "triggers", "environments", "deploy_targets", "secret_refs"), [['["push","workflow_dispatch"]', '["production"]', '["cloudflare/wrangler-action"]', '["CF_API_TOKEN"]']]);
		assert.deepEqual(pick("mf_exposes", "expose_key", "target_path"), [["./Cart", "./src/features/cart/Cart.tsx"]]);
		assert.deepEqual(pick("cross_mfe_imports", "source_alias", "import_path"), [["checkout", "checkout/Pay"]]);
		assert.deepEqual(pick("frontend_routes", "route_value"), [["/cart"]]);
		assert.deepEqual(pick("frontend_domain_modules", "kind", "name", "file_count", "test_count"), [["features", "cart", 2, 1]]);
		assert.deepEqual(pick("frontend_snapshots", "snapshot_id", "role", "branch", "dirty"), [["acme/web", "workspace", "main", 0]]);
		assert.deepEqual(pick("frontend_branch_comparisons", "ref_name", "ahead", "behind", "changed_paths"), [["feat", 1, 0, 1]]);
		assert.deepEqual(pick("frontend_branch_deltas", "to_snapshot", "path", "status"), [["acme/web@feat", "server/app.js", "M"]]);
		assert.ok(rows.frontend_files.every((f) => f.snapshot_id === "acme/web") && !rows.frontend_files.some((f) => f.path.startsWith("node_modules/")));
		const snap = await writeSnapshot(rows, SCAN_DDL), s = await sqliteSource(snap.file);
		try {
			assert.equal(s.schema("frontend_snapshots"), SCAN_DDL.frontend_snapshots);
			const dump = new DatabaseSync(snap.file, { readOnly: true });
			const all = JSON.stringify(Object.keys(SCAN_DDL).map((t) => dump.prepare(`SELECT * FROM ${t}`).all()));
			assert.deepEqual({ ...dump.prepare("SELECT root_path, id FROM frontend_snapshots, frontend_evidence LIMIT 1").get() }, { root_path: null, id: null });
			dump.close();
			assert.doesNotMatch(all, /hunter2|svc:/, "connection credentials are never kept");
			assert.ok(!all.includes(dir), "no local path");
		} finally { s.close(); snap.cleanup(); }
	});

	it("runs the scan group after history only with --scans, once per moved HEAD and UTC day, with its own marker and plan", async () => {
		const { refreshCheckouts } = await import("./corpus-git.mjs");
		const dir = frontend(), calls = [];
		const refresh = async (a) => { calls.push([a.group ?? "history", a.source ? a.source.repoRows(a.group ? "source_files" : "commits", ["sha"].slice(a.group ? 1 : 0).concat(a.group ? ["path"] : []), a.repo).length : null]); return { status: "published", receipt: {} }; };
		const state = {}, base = { repoRows: () => [["The web app", 0, 1, "TypeScript", null, null]] };
		const run = (now, scans = true) => refreshCheckouts({ checkouts: [dir], profile: "test", client: {}, state, save: () => {}, now: new Date(now), base, openSource: sqliteSource, refresh, scans });
		assert.deepEqual((await run("2026-09-01T08:00:00Z", false)).map((r) => r.group ?? "history"), ["history"]);
		assert.deepEqual((await run("2026-09-02T08:00:00Z")).map((r) => [r.group ?? "history", r.status]), [["history", "unchanged"], ["scans", "published"]]);
		assert.deepEqual(calls.at(-1), ["scans", 8]);
		assert.equal(state.scans["acme/web"].analysis_head, g(dir, ["rev-parse", "HEAD"]).trim());
		assert.deepEqual((await run("2026-09-03T08:00:00Z")).map((r) => r.status), ["unchanged", "unchanged"]);
		fs.writeFileSync(path.join(dir, "NEW.md"), "n"); g(dir, ["add", "NEW.md"]); g(dir, ["commit", "-q", "-m", "Notes"]);
		assert.deepEqual((await run("2026-09-03T09:00:00Z")).map((r) => r.status), ["published", "published"]);
		fs.writeFileSync(path.join(dir, "NEW.md"), "m"); g(dir, ["commit", "-q", "-am", "More notes"]);
		assert.deepEqual((await run("2026-09-03T10:00:00Z")).map((r) => r.status), ["refreshed_today", "refreshed_today"]);
		assert.deepEqual((await run("2026-09-04T09:00:00Z")).map((r) => r.status), ["published", "published"]);
		assert.deepEqual(calls.map((c) => c[0]), ["history", "scans", "history", "scans", "history", "scans"]);
	});
});

describe("corpus snapshot sets (uploader)", () => {
	const AS = "2026-08-12T00:00:00.000Z", FILE = "cd".repeat(32);
	const LINEAGE = "CREATE TABLE pattern_lineage_edges(\n  repo_a TEXT,\n  repo_b TEXT\n)", FINDINGS = "CREATE TABLE pattern_findings(\n  finding_id TEXT,\n  title TEXT\n)";
	/** The transport only: the status a server returns for a two-member set, stored receipts, and a publication the test sets. */
	function snapServer() {
		const members = [{ table: "pattern_lineage_edges", schema_sha256: sha256(LINEAGE), columns: ["rowid", "repo_a", "repo_b"], key: ["rowid"], set: "patterns" },
			{ table: "pattern_findings", schema_sha256: sha256(FINDINGS), columns: ["rowid", "finding_id", "title"], key: ["rowid"], set: "patterns" }];
		const s = { sent: [], members, published: null };
		s.status = async () => ({ generation: "g1", families: [], held: {}, tables: [], snapshot_families: members, snapshots: { patterns: { loading: null,
			published: s.published && { cut_id: s.published, tables: Object.fromEntries(members.map((m) => [m.table, { rows: 1, last: [2], final: true }])) } } } });
		s.send = async (c) => { s.sent.push(c); return { receipt: { status: "stored", sha256: c.sha256, last_key: c.rows.length ? [c.rows.at(-1)[0]] : c.after, complete: c.final } }; };
		return s;
	}

	it("sends a set only whole, is done only when the server publishes its exact cut, and leaves the bulk state untouched", async () => {
		const file = path.join(fs.mkdtempSync(path.join(tmp, "snap-")), "s.sqlite");
		const db = new DatabaseSync(file);
		db.exec(LINEAGE); db.exec(FINDINGS);
		db.exec("INSERT INTO pattern_lineage_edges (rowid, repo_a, repo_b) VALUES (2, 'acme/web', 'acme/api'); INSERT INTO pattern_findings (rowid, finding_id, title) VALUES (2, 'f-1', 'Ask ops@acme.example')");
		db.close();
		const source = await sqliteSource(file), server = snapServer();
		const bulk = { profile: "test", generation: "g1", source: "aa".repeat(32), as_of: "2026-08-01T00:00:00.000Z", tables: { commits: { last_key: ["acme/web", "1"], rows: 3, complete: false } } };
		const before = JSON.stringify(bulk);
		let saves = 0;
		const run = (tables) => uploadCorpus({ source, client: server, profile: "test", tables, asOf: AS, fileSha256: FILE, state: bulk, save: () => saves++ });
		try {
			assert.deepEqual(await run(["pattern_lineage_edges"]), { status: "refused", reason: "snapshot_set_incomplete", set: "patterns" });
			assert.equal(server.sent.length, 0);
			// Stored (or replayed) receipts for every member are not publication.
			assert.deepEqual(await run(["pattern_lineage_edges", "pattern_findings"]), { status: "stopped", reason: "snapshot_unpublished", set: "patterns" });
			assert.deepEqual(server.sent.map((c) => [c.table, c.after, c.final, c.rows]), [["pattern_lineage_edges", null, true, [[2, "acme/web", "acme/api"]]], ["pattern_findings", null, true, [[2, "f-1", "Ask [REDACTED]"]]]]);
			server.published = "f".repeat(64);
			assert.equal((await run(["pattern_lineage_edges", "pattern_findings"])).status, "stopped", "another published cut is not this one");
			// The server publishing this exact cut is done; its members are skipped without sending.
			server.published = snapshotCutOf("patterns", server.members, FILE, AS);
			const sent = server.sent.length;
			assert.equal((await run(["pattern_lineage_edges", "pattern_findings"])).status, "done");
			assert.equal(server.sent.length, sent);
			assert.equal(JSON.stringify(bulk), before, "a snapshot-only run never rewrites the bulk load's state");
			assert.equal(saves, 0);
		} finally { source.close(); }
	});
});

describe("corpus session metadata names (uploader)", () => {
	it("lets exactly the three session metadata snapshot tables past the session-name refusal, and still refuses raw and lineage session tables by name", async () => {
		let statuses = 0;
		const client = { status: async () => { statuses++; return { error: { code: "unavailable" } }; }, send: async () => assert.fail("nothing is sent") };
		const run = (tables) => uploadCorpus({ source: {}, client, profile: "test", tables, asOf: "2026-08-12T00:00:00.000Z", fileSha256: "cd".repeat(32), state: {} });
		for (const raw of ["session_messages", "session_decisions", "user_directives", "session_reference_index", "pattern_session_commit_links", "Codex_Sessions"]) {
			assert.deepEqual(await run([raw]), { status: "refused", table: raw, reason: "never_import" }, raw);
		}
		assert.deepEqual(await run(["codex_sessions", "session_messages"]), { status: "refused", table: "session_messages", reason: "never_import" });
		assert.equal(statuses, 0, "name refusals happen before any request");
		assert.deepEqual(await run(["codex_sessions", "session_commit_links", "session_ticket_links"]), { status: "stopped", reason: "unavailable" });
		assert.equal(statuses, 1);
	});
});

describe("curated judgment refresh", () => {
	// Exact existing schemas; the workflow row ensures a whole-set copy preserves the reserved trigger column too.
	const FACT_DDL = "CREATE TABLE frontend_business_facts(\n  fact_id TEXT,\n  repo_key TEXT,\n  domain TEXT,\n  fact_type TEXT,\n  statement TEXT,\n  confidence REAL,\n  snapshot_id TEXT,\n  evidence_json TEXT,\n  notes TEXT\n)";
	const FLOW_DDL = "CREATE TABLE frontend_workflows(\n  workflow_id TEXT,\n  repo_key TEXT,\n  domain TEXT,\n  name TEXT,\n  actor TEXT,\n  \"trigger\" TEXT,\n  steps_json TEXT,\n  outcomes_json TEXT,\n  confidence REAL,\n  snapshot_id TEXT,\n  evidence_json TEXT,\n  notes TEXT\n)";
	const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).trim();

	async function fixture({ evidence = [{ path: "src/rule.ts" }], touched = "src/rule.ts", repo = "acme/web", body = "export const total = 2; // ping fixture@example.invalid\n", facts = [evidence], remove = [] } = {}) {
		const dir = fs.mkdtempSync(path.join(tmp, "judgment-")), checkout = path.join(dir, "checkout");
		execFileSync("git", ["init", "-q", "-b", "main", checkout]);
		git(checkout, ["remote", "add", "origin", "git@github.com:acme/web.git"]);
		fs.mkdirSync(path.join(checkout, "src"));
		fs.writeFileSync(path.join(checkout, "src/rule.ts"), "export const total = 1;\n");
		for (const p of remove) fs.writeFileSync(path.join(checkout, p), "export const gone = 1;\n");
		const commit = () => { git(checkout, ["add", "."]); git(checkout, ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Synthetic evidence"]); return git(checkout, ["rev-parse", "HEAD"]); };
		const before = commit();
		fs.writeFileSync(path.join(checkout, touched), body);
		for (const p of remove) fs.rmSync(path.join(checkout, p));
		const head = commit();
		// A dirty working tree must never enter the model prompt.
		fs.writeFileSync(path.join(checkout, "src/rule.ts"), "WORKTREE_SHOULD_NOT_BE_READ");
		const dbfile = path.join(dir, "base.sqlite"), db = new DatabaseSync(dbfile);
		db.exec(FACT_DDL); db.exec(FLOW_DDL); db.exec("CREATE TABLE repos(full_name TEXT, head_sha TEXT)");
		db.prepare("INSERT INTO repos VALUES (?, ?)").run("acme/web", before);
		for (const [i, ev] of facts.entries()) db.prepare("INSERT INTO frontend_business_facts VALUES (?, ?, 'totals', 'rule', 'total is 2', 0.9, 'acme/web', ?, NULL)").run(`f${i + 1}`, repo, JSON.stringify(ev));
		db.exec("INSERT INTO frontend_workflows (workflow_id, repo_key, name, \"trigger\", evidence_json) VALUES ('w1', 'acme/web', 'Retained workflow', 'click pay', '[]')");
		const members = ["frontend_business_facts", "frontend_workflows"].map((table) => ({ table, set: "judgment", key: ["rowid"],
			schema_sha256: sha256(table === "frontend_business_facts" ? FACT_DDL : FLOW_DDL), columns: ["rowid", ...db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name)] }));
		db.close();
		const base = await sqliteSource(dbfile), calls = [], sent = [], saves = [], finals = new Set();
		const ledger = { published: { source_sha256: base.fileSha256, cut_id: "base-cut" }, loading: null };
		const client = {
			refuse: false,
			status: async () => structuredClone({ generation: "g1", families: [], tables: [], snapshot_families: members, snapshots: { judgment: ledger } }),
			send: async (c) => {
				sent.push(c);
				assert.ok(saves.at(-1).judgment.pending, "candidate identity was saved before the first send");
				if (client.refuse) return { error: { code: "validation", details: { reason: "fixture_refusal" } } };
				assert.equal(c.sha256, chunkHash(c));
				if (c.final) finals.add(c.table);
				if (finals.size === members.length) ledger.published = { source_sha256: c.source.file_sha256, cut_id: snapshotCutOf("judgment", members, c.source.file_sha256, c.as_of) };
				return { receipt: { status: "stored", sha256: c.sha256, last_key: c.rows.length ? [c.rows.at(-1)[0]] : c.after, complete: c.final } };
			},
		};
		const runner = { available: true, classification: "denied", exec: async (a) => { calls.push(a); return { kind: "ok", part: { supported: true } }; } };
		const options = { checkouts: [checkout], profile: "test", client, base, runner, state: {}, save: (s) => saves.push(structuredClone(s)), openSource: sqliteSource,
			candidateFile: path.join(dir, "prepared.sqlite"), writePrivate: (file, data) => fs.writeFileSync(file, data, { mode: 0o600 }), now: new Date("2026-11-01T10:00:00Z") };
		return { options, calls, sent, saves, head, close: () => { base.close(); fs.rmSync(dir, { recursive: true }); } };
	}

	it("selects only touched explicit evidence and refuses foreign, unknown or unsafe mappings without invoking a model", async () => {
		const { evidencePaths, refreshJudgment } = await import("./corpus-judgment.mjs");
		assert.deepEqual(evidencePaths('[{"path":"src/rule.ts"},{"path":"src/rule.ts"}]', "acme/web"), ["src/rule.ts"]);
		for (const evidence of [[{ path: "src/rule.ts", repo: "other/web" }], [{ path: "../rule.ts" }], [{ path: "src/rule.ts" }, { path: "auth.json" }],
			[{ path: "sessions/rollout.jsonl" }], [{ path: "/tmp/rule.ts" }], [{ path: ".env.json" }], [{ file: "src/rule.ts" }]]) {
			assert.deepEqual(evidencePaths(JSON.stringify(evidence), "acme/web"), []);
		}
		for (const args of [{ touched: "src/unrelated.ts" }, { repo: "other/web" }, { evidence: [{ path: "src/rule.ts", repo: "other/web" }] }, { evidence: [{ path: "auth.json" }] }]) {
			const f = await fixture(args);
			try {
				const r = await refreshJudgment(f.options);
				assert.equal(r.status, args.evidence ? "pending" : "unchanged");
				assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
			} finally { f.close(); }
		}
	});

	it("keeps facts pending for unproven runtimes and false, malformed or tool results", async () => {
		const { refreshJudgment } = await import("./corpus-judgment.mjs");
		const f = await fixture();
		try {
			for (const runner of [null, { ...f.options.runner, available: false }, { ...f.options.runner, classification: "indeterminate" }]) {
				assert.equal((await refreshJudgment({ ...f.options, state: {}, runner })).reason, "runtime_unavailable");
			}
			assert.equal(f.calls.length, 0);
			let attempted = 0;
			for (const result of [{ kind: "ok", part: { supported: false } }, { kind: "ok", part: { supported: "true" } },
				{ kind: "ok", part: { supported: true, extra: "injected" } }, { kind: "tool_event" }]) {
				const state = {};
				const runner = { ...f.options.runner, exec: async () => { attempted++; return result; } };
				assert.equal((await refreshJudgment({ ...f.options, runner, state })).reason, "fact_needs_review");
				assert.deepEqual(state.judgment.checked, {}); assert.equal(state.judgment.pending, undefined);
			}
			assert.equal(attempted, 4); assert.equal(f.sent.length, 0);
		} finally { f.close(); }
	});

	it("durably prepares a supported fact, resumes refused publication without a second model call, and advances its head only after whole-set publication", async () => {
		const { FACT_SCHEMA, refreshJudgment } = await import("./corpus-judgment.mjs");
		const f = await fixture();
		try {
			f.options.client.refuse = true;
			assert.equal((await refreshJudgment(f.options)).reason, "fixture_refusal");
			assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, "gpt-6.1-terra"); assert.equal(f.calls[0].effort, "high"); assert.deepEqual(f.calls[0].schema, FACT_SCHEMA);
			assert.match(f.calls[0].prompt, /total = 2/); assert.doesNotMatch(f.calls[0].prompt, /WORKTREE_SHOULD_NOT_BE_READ|fixture@example/);
			assert.deepEqual(f.options.state.judgment.checked, {});
			assert.equal(f.options.state.judgment.pending.head, f.head);
			assert.equal(fs.statSync(f.options.candidateFile).mode & 0o777, 0o600);
			// Simulate a new process: only the private saved state/candidate survive, and the runner is unavailable.
			const state = structuredClone(f.saves.at(-1));
			f.options.client.refuse = false;
			assert.deepEqual(await refreshJudgment({ ...f.options, state, runner: null }), { group: "judgment", status: "published", checked: 1 });
			assert.equal(f.calls.length, 1); assert.equal(state.judgment.pending, null);
			assert.deepEqual(Object.values(state.judgment.checked), [f.head]);
			assert.deepEqual(f.sent.slice(1).map((c) => c.table), ["frontend_business_facts", "frontend_workflows"]);
			const flow = f.sent.at(-1);
			assert.equal(flow.rows[0][flow.columns.indexOf("trigger")], "click pay");
			assert.equal((await refreshJudgment({ ...f.options, state })).status, "unchanged");
			assert.equal(f.calls.length, 1);
		} finally { f.close(); }
	});

	it("removes quoted, prefixed and camelCase credential values before the prompt, and refuses a nested secret config without a model call", async () => {
		const { refreshJudgment } = await import("./corpus-judgment.mjs");
		const body = `${JSON.stringify({ total: 2, password: "opaque-a1", db_password: "opaque-b2", "x-api-key": "opaque-c3", nested: { clientSecret: "opaque-d4", authToken: 12345678 } }, null, 2)}\n`;
		const f = await fixture({ evidence: [{ path: "config.json" }], touched: "config.json", body });
		try {
			await refreshJudgment(f.options);
			assert.equal(f.calls.length, 1);
			assert.doesNotMatch(f.calls[0].prompt, /opaque|12345678/);
			assert.match(f.calls[0].prompt, /db_password/); assert.match(f.calls[0].prompt, /\\"total\\": 2/);
		} finally { f.close(); }
		const g = await fixture({ evidence: [{ path: "config.json" }], touched: "config.json", body: `${JSON.stringify({ secrets: { stripe: "opaque-e5" } }, null, 2)}\n` });
		try {
			assert.equal((await refreshJudgment(g.options)).reason, "evidence_sensitive");
			assert.equal(g.calls.length, 0); assert.deepEqual(g.options.state.judgment.checked, {});
		} finally { g.close(); }
	});

	it("redacts bare YAML and wrapped source secrets, and refuses TOML secret sections and multi-line nested secrets without a model call", async () => {
		const { refreshJudgment } = await import("./corpus-judgment.mjs");
		for (const [file, body, keep] of [
			["config.yaml", "db_password: opaque-y1\nadmin_pwd: opaque-y2 # rotated\nretries: 3\n", /retries: 3/],
			["src/config.ts", 'export const api = { clientSecret: wrap("opaque-s1"), retries: 3 };\nexport const total = 2;\n', /total = 2/],
			["config.toml", 'retries = 3\n[secrets]\nstripe = "opaque-t1"\n', null],
			["config.yml", "credentials:\n  stripe: opaque-y3\n", null],
			["deploy.yaml", 'stripe_secret_key: >\n  opaque-y4\nwebhook_token: "opaque-y5\n  continued"\n', null],
			["src/keys.ts", 'export const config = {\n  secrets: {\n    stripe: "opaque-s2",\n  },\n};\n', null],
			["src/list.ts", 'export const apiKeys = [\n  "opaque-s3",\n];\n', null],
			// Bare keys the shared redactor also matches: its scalar replacement must not hide the block or brace opener.
			["app.yaml", "password: |\n  opaque-y6\n", null],
			["src/secret.ts", 'export const secret = {\n  stripe: "opaque-s4",\n};\n', null],
		]) {
			const f = await fixture({ evidence: [{ path: file }], touched: file, body });
			try {
				const r = await refreshJudgment(f.options);
				if (keep) {
					assert.equal(f.calls.length, 1, file); assert.match(f.calls[0].prompt, keep, file); assert.doesNotMatch(f.calls[0].prompt, /opaque/, file);
				} else {
					assert.equal(r.reason, "evidence_sensitive", file); assert.equal(f.calls.length, 0, file); assert.deepEqual(f.options.state.judgment.checked, {}, file);
				}
			} finally { f.close(); }
		}
	});

	it("persists a deleted-evidence fact as deferred so the next run rechecks a later eligible fact, without checking or retrying the deferred one", async () => {
		const { refreshJudgment } = await import("./corpus-judgment.mjs");
		const f = await fixture({ facts: [[{ path: "src/gone.ts" }], [{ path: "src/rule.ts" }]], remove: ["src/gone.ts"] });
		try {
			assert.equal((await refreshJudgment(f.options)).reason, "evidence_unavailable");
			assert.equal(f.calls.length, 0); assert.deepEqual(f.options.state.judgment.checked, {});
			// A new process sees only the saved state: the failed fact/head is durable and the later fact is selected.
			const state = structuredClone(f.saves.at(-1));
			assert.deepEqual(Object.values(state.judgment.deferred), [f.head]);
			assert.deepEqual(await refreshJudgment({ ...f.options, state }), { group: "judgment", status: "published", checked: 1 });
			assert.equal(f.calls.length, 1); assert.match(f.calls[0].prompt, /total = 2/);
			assert.deepEqual(Object.values(state.judgment.checked), [f.head]);
			assert.equal(Object.keys(state.judgment.deferred).some((id) => id in state.judgment.checked), false);
			// The deferred fact stays pending and unchecked until its evidence changes again.
			assert.equal((await refreshJudgment({ ...f.options, state })).reason, "fact_needs_review");
			assert.equal(f.calls.length, 1); assert.equal(Object.keys(state.judgment.checked).length, 1);
		} finally { f.close(); }
	});
});
