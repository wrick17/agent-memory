// node --test local/migrate.test.mjs : the import's first slice (docs/import-implementation.md) on synthetic exports and
// private temporary Markdown folders. No database, server or real memory file is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { canonicalJson, requestHash, sha256, uuid5 } from "../src/domain/ids.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-migrate-test-"));
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });
const m = await import("./migrate.mjs");

const writeJsonl = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
const readJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const dt = (s) => ({ $neo4j: "DateTime", iso: s });

/** An exported BothQ record in export_bothq.py's shape. */
function record({ eid, memoryId = null, legacyId = null, type = "project", scope = null, name, props = {}, revisions = [], requests = [], steps = [], rels = [] }) {
	return {
		eid, labels: memoryId ? ["Decision", "Entity", "MemoryRecord"] : ["Decision", "Entity"], anchors: [], steps, relationships: rels, has_revision_links: revisions.length,
		props: { name, _created: dt("2026-01-02T03:04:05+00:00"), _updated: dt("2026-02-03T04:05:06+00:00"), _valid_from: dt("2026-01-02T03:04:05+00:00"), _version: 1,
			...(memoryId ? { memory_id: memoryId, memory_type: type, scope, status: "active" } : {}), ...props },
		revisions, requests, fingerprint: { version: 1 }, attempts: 1, bothq_type: type, resolved_scope: scope, legacy_id: legacyId,
	};
}

/** A BothQ journal built the way memory_store.py builds one: a save, appends, an update that replaces the content, more appends. */
function journal(id, { appends = 120, size = 3000, scope = "personal" } = {}) {
	const fields = { name: `Journal ${id}`, memory_type: "project", description: "a journal", why: "", how_to_apply: "", objective: "" };
	let content = "", rev = 0;
	const revisions = [], requests = [];
	const push = (op, snapshot, delta) => {
		rev++;
		const hash = m.bothqContentHash({ ...fields, content });
		revisions.push({ revision_id: `${id}:${rev}`, memory_id: id, revision: rev, operation: op, content_hash: hash, snapshot_json: canonicalJson(snapshot),
			delta_json: delta ? canonicalJson(delta) : null, request_id: `req-${id}-${rev}`, _created: dt(`2026-03-01T00:00:${String(rev % 60).padStart(2, "0")}+00:00`), _source_platform: "codex", _source_platform_version: "1" });
		requests.push({ request_id: `req-${id}-${rev}`, operation: op === "appended" ? "append" : op === "saved" ? "save" : "update", request_hash: sha256(`h${rev}`),
			result: canonicalJson({ ok: true, memory_id: id, revision: rev }), memory_id: id, _created: dt("2026-03-01T00:00:00+00:00"), _completed: dt("2026-03-01T00:00:01+00:00") });
	};
	push("saved", { ...fields, content: "", memory_id: id, _version: 1 });
	const append = (entry, separator = "\n\n") => { const used = content ? separator : ""; content += used + entry; push("appended", { memory_id: id, _version: rev + 1 }, { content: entry, separator }); };
	append("First entry after an empty save: no separator is used.");
	for (let i = 0; i < appends; i++) append(`Entry ${i} ${"é日本語🙂".repeat(5)} ${"x".repeat(size)}`);
	// One entry longer than a text row, with a surrogate pair right at the 16,000-character cut.
	append(`${"a".repeat(15_999)}🙂${"b".repeat(5000)}`);
	content = "Replaced by an update.";
	push("updated", { ...fields, content, memory_id: id, _version: rev + 1 });
	for (let i = 0; i < 3; i++) append(`After update ${i}`, "\n");
	return record({ eid: `e-${id}`, memoryId: id, scope, name: fields.name,
		props: { ...fields, content, rule: content, content_hash: m.bothqContentHash({ ...fields, content }), _version: rev }, revisions, requests });
}

/** A synthetic export bundle with a manifest that pins its bytes, as `export` writes one. */
function makeExport(records, files = []) {
	const dir = fs.mkdtempSync(path.join(tmp, "export-"));
	writeJsonl(path.join(dir, "bothq", "records.jsonl"), records);
	writeJsonl(path.join(dir, "markdown", "files.jsonl"), files);
	const hash = (f) => sha256(fs.readFileSync(f, "utf8"));
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, synthetic: dir,
		bothq: { records: records.length, records_jsonl_sha256: hash(path.join(dir, "bothq", "records.jsonl")) },
		markdown: { distinct: files.length, files_sha256: sha256(files.map((f) => `${f.realpath}\t${f.sha256}`).join("\n")), files_jsonl_sha256: hash(path.join(dir, "markdown", "files.jsonl")) } }));
	return dir;
}
const planned = (dir, sub = "plan") => readJsonl(path.join(dir, sub, "commands.jsonl"));
const reviewOf = (dir, sub = "plan") => readJsonl(path.join(dir, sub, "review.jsonl"));
const liveContent = (stages) => stages.flatMap((s) => s.rows.texts).filter((t) => t.live)
	.sort((a, b) => (a.part === "entry") - (b.part === "entry") || a.seq_no - b.seq_no || a.chunk - b.chunk)
	.map((t) => (t.chunk === 0 && t.separator ? t.separator : "") + t.body).join("");

describe("BothQ compatibility", () => {
	it("hashes and ids match values computed by BothQ's own memory_store.py and memory_config.py", () => {
		// Computed once with BothQ's interpreter: memory_store._prepare(args, op, ...)["request_hash"], content_hash, _json, stable_memory_id.
		assert.equal(requestHash("append", { request_id: "r-1", memory_id: "72ea0e74-aca8-5e4f-b1d3-3878342b6973", content: "Entry with ünïcode — and \"quotes\"\nline2\ttab", separator: "\n\n" }),
			"9d3c7d543343980cc49ac4c2b002fb1fb58c2a3a2c07210d7e3d05270e9da8fe");
		assert.equal(requestHash("save", { request_id: "r-2", name: "Use pnpm", type: "feedback", description: "pkg manager", content: "Always pnpm.", scope: "personal", expected_revision: 0 }),
			"a2a43fb834511969055926a605e0c098fc4736338ccdc1353ec57376ef4d7650");
		assert.equal(requestHash("update", { request_id: "r-3", memory_id: "abc", description: "x", steps: [{ order: 1, action: "a", success_criteria: "b" }], supersedes: ["id1", "id2"] }),
			"a85035bf53a8c155e29b6119277c4a76846be540e0f4b8a9fb6a8c865702c1ed");
		const fields = { name: "Journal X", memory_type: "project", description: "d", content: "cé\n", why: null, how_to_apply: "", objective: null };
		assert.equal(m.bothqContentHash(fields), "bdd01074c76e455b4417189f73c6f3df5c3c603147ccf3de921acc6b3406cb92");
		assert.equal(m.bothqContentHash(fields, [{ order: 1, action: "do", success_criteria: "done" }]), "36942652d231b1e3163fd810ca3bd4a1074710cf770412e30eb4a35ea8b09d4c");
		assert.equal(canonicalJson({ b: [1, { z: " \u0001" }], a: true, c: null }), '{"a":true,"b":[1,{"z":" \\u0001"}],"c":null}');
		assert.equal(uuid5("sequoia:project:some name"), "31275195-8a2d-598e-ab30-bf8616ecb301");
	});

	it("redaction stays linear on a long run and still redacts URL passwords", async () => {
		const { redactText } = await import("../src/domain/redact.ts");
		const t0 = performance.now();
		assert.equal(redactText("x".repeat(1_000_000)), "x".repeat(1_000_000));
		assert.ok(performance.now() - t0 < 2000, "a 1 MB run took minutes before the scheme was bounded");
		assert.equal(redactText("see https://user:hunter2@host/x"), "see https://user:[REDACTED]@host/x");
	});

	it("the exporter rereads a record that changed during its read and reports one that vanished", () => {
		const r = spawnSync("python3", [path.join(import.meta.dirname, "migrate", "export_bothq.py"), "--self-test"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).self_test, "ok");
	});
});

describe("plan", () => {
	it("splits a huge journal into parts inside the budget and keeps its text, revisions and requests byte for byte", async () => {
		const j = journal("11111111-1111-5111-8111-111111111111", { appends: 400 });
		const dir = makeExport([j]);
		const r = await m.plan({ exportDir: dir });
		assert.equal(r.manifest.planned, 1);
		const cmds = planned(dir);
		const stages = cmds.filter((c) => c.op === "stage"), fin = cmds.find((c) => c.op === "finalize");
		assert.ok(stages.length > 1, "more than one part");
		for (const s of stages) {
			assert.ok(s.cost.rows <= m.BUDGET.rows && s.cost.bytes <= m.BUDGET.bytes && Buffer.byteLength(JSON.stringify(s)) <= m.BUDGET.bytes, JSON.stringify(s.cost));
			for (const t of s.rows.texts) assert.ok(t.body.length <= m.CHUNK && t.body.isWellFormed());
		}
		assert.equal(liveContent(stages), j.props.content);
		const texts = stages.flatMap((s) => s.rows.texts);
		const entries = texts.filter((t) => t.part === "entry" && t.chunk === 0);
		assert.equal(entries[0].separator, "", "the first append after an empty save used no separator");
		assert.ok(entries.filter((e) => !e.live).length > 100 && entries.filter((e) => e.live).length === 3, "entries before the update are history");
		assert.ok(texts.some((t) => t.part === "entry" && t.chunk === 1 && t.separator === null), "a long entry is chunked");
		assert.deepEqual(stages.flatMap((s) => s.rows.revisions).map((x) => [x.op, x.snapshot, x.delta]), j.revisions.map((x) => [x.operation, x.snapshot_json, x.delta_json]));
		assert.deepEqual(stages.flatMap((s) => s.rows.requests).map((q) => [q.request_id, q.legacy_op, q.legacy_hash, q.result]), j.requests.map((q) => [q.request_id, q.operation, q.request_hash, q.result]));
		assert.deepEqual(fin.parts.map((p) => p.sha256), stages.map((s) => s.sha256));
		assert.equal(fin.request_ids.length, j.requests.length);
		assert.equal(fin.node.content_hash, j.props.content_hash);
		assert.equal(fin.node.kind, "journal");
		assert.equal(fin.node.valid_from, j.revisions.at(-1)._created.iso, "the revision that set the current content");
	});

	it("legacy records keep a computed id and their rule text with validity unknown; missing and unrouted scopes go to review", async () => {
		const id = uuid5("sequoia:feedback:use pnpm");
		const dir = makeExport([
			record({ eid: "l1", legacyId: id, type: "feedback", scope: "sequoia", name: "Use pnpm", props: { content: "", rule: "Always pnpm.", description: "pkg" } }),
			record({ eid: "l2", type: "feedback", name: "No scope" }),
			record({ eid: "a3", memoryId: "33333333-3333-5333-8333-333333333333", scope: "bot_hq", name: "Mixed", props: { content: "x", content_hash: m.bothqContentHash({ name: "Mixed", memory_type: "project", content: "x" }) } }),
		]);
		await m.plan({ exportDir: dir });
		const cmds = planned(dir), fin = cmds.find((c) => c.op === "finalize");
		assert.equal(cmds.filter((c) => c.op === "finalize").length, 1);
		assert.deepEqual([fin.record_id, fin.profile, fin.node.kind, fin.node.valid_from, fin.node.attrs.validity, fin.node.attrs.first_recorded_at, fin.node.attrs.source.content_from],
			[id, "work", "rule", null, "unknown", "2026-01-02T03:04:05+00:00", "rule"]);
		const stage = cmds.find((c) => c.op === "stage");
		assert.equal(liveContent([stage]), "Always pnpm.");
		assert.deepEqual(stage.rows.revisions.map((x) => x.op), ["legacy_snapshot"]);
		assert.equal(fin.node.attrs.source.properties._valid_from.iso, "2026-01-02T03:04:05+00:00", "the legacy date stays provenance");
		const rv = Object.fromEntries(reviewOf(dir).map((x) => [x.key, x.reasons]));
		assert.deepEqual([rv["bothq:l2"], rv["bothq:a3"]], [["missing_scope"], ["unrouted_scope"]]);
	});

	it("holds a record that redaction would change in a private file and never plans or prints its text", async () => {
		const dir = makeExport([record({ eid: "s1", legacyId: uuid5("personal:project:creds"), scope: "personal", name: "Creds", props: { content: "Use token=abc123secret for the job." } })]);
		const r = await m.plan({ exportDir: dir });
		assert.equal(r.manifest.holds, 1);
		assert.deepEqual(reviewOf(dir)[0].reasons, ["needs_redaction"]);
		const [hold] = fs.readdirSync(path.join(dir, "plan", "holds"));
		const file = path.join(dir, "plan", "holds", hold);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.ok(fs.readFileSync(file, "utf8").includes("token=[REDACTED]"));
		for (const f of ["commands.jsonl", "review.jsonl", "manifest.json", "batches.jsonl"]) assert.ok(!fs.readFileSync(path.join(dir, "plan", f), "utf8").includes("abc123secret"), f);
		assert.ok(!JSON.stringify(r.manifest).includes("abc123secret"));
		assert.equal(fs.statSync(path.join(dir, "plan")).mode & 0o777, 0o700);
	});

	it("lists identity conflicts and duplicate content for review instead of merging them", async () => {
		const mk = (eid, id) => record({ eid, memoryId: id, scope: "personal", name: "Same name", props: { content: eid, content_hash: m.bothqContentHash({ name: "Same name", memory_type: "project", content: eid }) } });
		const dir = makeExport([mk("c1", "44444444-4444-5444-8444-444444444444"), mk("c2", "55555555-5555-5555-8555-555555555555")]);
		await m.plan({ exportDir: dir });
		assert.deepEqual(reviewOf(dir).map((x) => x.reasons), [["identity_conflict"], ["identity_conflict"]]);
		assert.equal(planned(dir).length, 0);
	});

	it("is deterministic and resumable, and never takes over a lock it did not create", async () => {
		const dir = makeExport([journal("66666666-6666-5666-8666-666666666666", { appends: 5, size: 10 })]);
		const a = await m.plan({ exportDir: dir });
		assert.equal((await m.plan({ exportDir: dir })).status, "unchanged");
		const b = await m.plan({ exportDir: dir, force: true });
		assert.equal(b.manifest.commands_sha256, a.manifest.commands_sha256);
		const lock = path.join(m.migrationDir(), "run.lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: "2026-01-01" }));
		await assert.rejects(m.plan({ exportDir: dir, force: true }), /another migrate run holds .*run\.lock/);
		assert.ok(fs.existsSync(lock), "the lock is left for the owner");
		assert.equal(m.dryRun({ exportDir: dir }).over_budget_parts, 0);
	});
});

describe("markdown", () => {
	function sources() {
		const root = fs.mkdtempSync(path.join(tmp, "md-"));
		const repo = path.join(root, "proj");
		fs.mkdirSync(repo);
		spawnSync("git", ["init", "-q", repo]);
		spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:wrick17/proj.git"]);
		const claude = path.join(root, "claude-projects");
		const folder = repo.replace(/[/._]/g, "-");
		fs.mkdirSync(path.join(claude, folder, "memory"), { recursive: true });
		fs.writeFileSync(path.join(claude, folder, "memory", "MEMORY.md"), "- [Topic](topic.md)\n");
		fs.writeFileSync(path.join(claude, folder, "memory", "topic.md"), "---\nname: prefer-pnpm\ndescription: package manager\nmetadata:\n  type: feedback\n---\n\nAlways pnpm. ünïcode\n");
		fs.symlinkSync(path.join(claude, folder), path.join(claude, `${folder}-alias`));
		const codex = path.join(root, "codex-memories");
		fs.mkdirSync(path.join(codex, "rollout_summaries"), { recursive: true });
		fs.mkdirSync(path.join(codex, "skills", "s"), { recursive: true });
		fs.mkdirSync(path.join(codex, ".git", "objects"), { recursive: true });
		fs.writeFileSync(path.join(codex, "MEMORY.md"), "global memory\n");
		fs.writeFileSync(path.join(codex, "rollout_summaries", "r1.md"), `thread_id: t1\ncwd: ${repo}\n\nOutcome: done.\n`);
		fs.writeFileSync(path.join(codex, "skills", "s", "SKILL.md"), "skill\n");
		fs.writeFileSync(path.join(codex, ".git", "objects", "x"), "blob");
		return { claudeRoots: [claude], codexRoot: codex, folder, repo };
	}

	it("imports an aliased file once with every path, routes by the project's remote, and classifies Codex files", async () => {
		const src = sources();
		const md = m.enumerateMarkdown(src);
		assert.deepEqual([md.paths, md.files.length, md.gitFiles], [7, 5, 1]);
		const topic = md.files.find((f) => f.rel === "topic.md");
		assert.equal(topic.paths.length, 2, "the alias folder adds a path, not a file");
		assert.deepEqual(md.files.map((f) => f.category).sort(), ["claude_index", "claude_topic", "codex_memory", "codex_reference_candidate", "codex_rollout_summary"]);
		const dir = makeExport([], md.files);
		await m.plan({ exportDir: dir });
		const fins = planned(dir).filter((c) => c.op === "finalize");
		const byCat = Object.fromEntries(fins.map((f) => [f.node.attrs.source.category, f]));
		assert.deepEqual([byCat.claude_topic.profile, byCat.claude_topic.node.kind, byCat.claude_topic.node.name, byCat.claude_topic.node.attrs.validity], ["personal", "rule", "prefer-pnpm", "unknown"]);
		assert.equal(byCat.codex_rollout_summary.profile, "personal");
		const stage = planned(dir).find((c) => c.op === "stage" && c.record_id === byCat.claude_topic.record_id);
		assert.equal(liveContent([stage]), topic.content, "byte-exact, frontmatter included");
		const rv = Object.fromEntries(reviewOf(dir).map((x) => [x.key.split(":")[0] + ":" + path.basename(x.key), x.reasons]));
		assert.deepEqual([rv["codex:MEMORY.md"], rv["codex:SKILL.md"]], [["unrouted_path"], ["reference_candidate", "unrouted_path"]]);
	});

	it("verify reports a file rewritten after the export and nothing for an unchanged rerun", async () => {
		const src = sources();
		const { dir } = await m.exportAll(src, { bothq: false });
		assert.deepEqual((await m.verify({ exportDir: dir, sources: src, bothq: false })).markdown, { changed: 0, added: 0, vanished: 0 });
		fs.appendFileSync(path.join(src.codexRoot, "MEMORY.md"), "edited\n");
		assert.deepEqual((await m.verify({ exportDir: dir, sources: src, bothq: false })).markdown, { changed: 1, added: 0, vanished: 0 });
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(dir, "markdown", "files.jsonl")).mode & 0o777, 0o600);
	});
});

// Review E1-E6 (docs/review-sol-import-export-2026-10-29.md), each from the reviewer's counterexample.
describe("export review fixes", () => {
	const legacy = (name, props = {}, extra = {}) => record({ eid: `eid-${name}`, legacyId: uuid5(`personal:project:${name}`), scope: "personal", name, props: { content: "safe", ...props }, ...extra });

	it("E1: holds a record whose provenance or stored request result carries a secret, by pattern or by key", async () => {
		const b = legacy("private-result");
		b.requests = [{ request_id: "fake-req", operation: "save", request_hash: sha256("fake-hash"), result: JSON.stringify({ password: "FAKE-REVIEW-VALUE" }), _created: dt("2026-01-01T00:00:00Z") }];
		const dir = makeExport([legacy("private-provenance", { source_note: "token=FAKE-REVIEW-VALUE" }), b]);
		const r = await m.plan({ exportDir: dir });
		assert.deepEqual([r.manifest.planned, r.manifest.holds], [0, 2]);
		assert.deepEqual(reviewOf(dir).map((x) => x.reasons), [["needs_redaction"], ["needs_redaction"]]);
		for (const f of ["commands.jsonl", "review.jsonl", "manifest.json"]) assert.ok(!fs.readFileSync(path.join(dir, "plan", f), "utf8").includes("FAKE-REVIEW-VALUE"), f);
		for (const h of fs.readdirSync(path.join(dir, "plan", "holds"))) assert.ok(!fs.readFileSync(path.join(dir, "plan", "holds", h), "utf8").includes("FAKE-REVIEW-VALUE"), "the held copy is redacted too");
	});

	it("E2: holds a Claude folder name that more than one existing checkout encodes to", () => {
		const base = fs.mkdtempSync(path.join(tmp, "amb-"));
		const work = path.join(base, "a", "b"), personal = path.join(base, "a-b");
		for (const [d, remote] of [[work, "git@github.com:Sequoia-Engineering/review.git"], [personal, "git@github.com:wrick17/review.git"]]) {
			fs.mkdirSync(d, { recursive: true });
			spawnSync("git", ["init", "-q", d]);
			spawnSync("git", ["-C", d, "remote", "add", "origin", remote]);
		}
		const project = personal.replace(/[/._]/g, "-");
		assert.equal(project, work.replace(/[/._]/g, "-"));
		assert.deepEqual(m.decodeProjectDirs(project), [work, personal].sort());
		const it = m.markdownItem({ system: "claude", project, rel: "topic.md", category: "claude_topic", content: "Personal project note", realpath: path.join(base, "t.md"), paths: [],
			sha256: sha256("Personal project note"), bytes: 21, birthtime: "2026-01-01T00:00:00Z", mtime: "2026-01-01T00:00:00Z" }, m.defaultRouting());
		assert.equal(it.route, null);
		assert.deepEqual(it.review, ["ambiguous_project_path"]);
	});

	it("E3: never accepts a Markdown body that was rewritten during its read", () => {
		const root = fs.mkdtempSync(path.join(tmp, "race-"));
		const file = path.join(root, "raw_memories.md");
		const old = "A".repeat(1_048_576), fresh = "B".repeat(1_048_576);
		fs.writeFileSync(file, old);
		const orig = fs.readSync;
		let fired = 0;
		// The rewrite lands after the first half of the first read, as in the review's repro; then once more on the retry.
		fs.readSync = function (fd, buffer, offset, length, position) {
			const n = orig.call(this, fd, buffer, offset, Math.min(length, 524_288), position);
			if (fired < 1) { fired++; fs.writeFileSync(file, fresh); }
			return n;
		};
		let got;
		try { got = m.enumerateMarkdown({ claudeRoots: [], codexRoot: root }).files[0]; } finally { fs.readSync = orig; }
		assert.equal(got.sha256, sha256(fresh), "the stable reread, never a mix");
		assert.equal(got.content, fresh);
		// A file that never holds still for a read is held with no content.
		fs.readSync = function (fd, buffer, offset, length, position) { const n = orig.call(this, fd, buffer, offset, Math.min(length, 524_288), position); fs.writeFileSync(file, `${Date.now()}${Math.random()}`.repeat(1000)); return n; };
		try { got = m.enumerateMarkdown({ claudeRoots: [], codexRoot: root }).files[0]; } finally { fs.readSync = orig; }
		assert.deepEqual([got.unstable, got.content, got.sha256], [true, undefined, null]);
		assert.deepEqual(m.markdownItem(got, m.defaultRouting()).review.includes("unstable_read"), true);
	});

	it("E4: keeps a supersession's raw relationship and properties in provenance as well as the link", async () => {
		const oldId = uuid5("personal:project:old");
		const rel = { type: "SUPERSEDES", outgoing: true, props: { _created: dt("2026-01-01T00:00:00Z"), reason: "renamed" }, other_memory_id: oldId, other_eid: "old-eid", other_labels: ["MemoryRecord"] };
		const item = m.bothqItem(legacy("successor", {}, { rels: [rel] }));
		assert.deepEqual(item.node.attrs.source.relationships, [rel]);
		assert.deepEqual(item.supersedes, [oldId]);
	});

	it("links a supersession only to a record the plan publishes in the same profile, and lists the rest for review", async () => {
		const rel = (id) => ({ type: "SUPERSEDES", outgoing: true, props: {}, other_memory_id: id, other_eid: `eid-${id}`, other_labels: ["MemoryRecord"] });
		const [old, big, work] = [uuid5("personal:project:old"), uuid5("personal:project:oversize-old"), uuid5("sequoia:project:work-old")];
		const dir = makeExport([legacy("new", {}, { rels: [rel(old), rel(big), rel(work)] }), legacy("old"), legacy("oversize-old", { legacy_notes: "x".repeat(1_020_000) }),
			record({ eid: "eid-work-old", legacyId: work, scope: "sequoia", name: "work-old", props: { content: "safe" } })]);
		await m.plan({ exportDir: dir });
		assert.deepEqual(planned(dir).filter((c) => c.op === "link").map((c) => c.dst), [old]);
		assert.deepEqual(reviewOf(dir).filter((x) => x.reasons.includes("link_endpoint_unresolved")).map((x) => x.link.dst).sort(), [big, work].sort());
	});

	it("E5: holds a record whose finalize command would not fit one request, and dry-run checks every command and batch", async () => {
		const dir = makeExport([legacy("oversize-finalize", { legacy_notes: "x".repeat(1_020_000) }), legacy("ordinary")]);
		const r = await m.plan({ exportDir: dir });
		assert.equal(r.manifest.planned, 1);
		assert.deepEqual(reviewOf(dir).find((x) => x.key === "bothq:eid-oversize-finalize").reasons, ["oversize_command"]);
		const d = m.dryRun({ exportDir: dir });
		assert.deepEqual([d.over_budget_parts, d.over_budget_commands, d.over_budget_batches], [0, 0, 0]);
		assert.ok(d.max_command_bytes < m.BUDGET.bytes);
	});

	it("E6: refuses an export whose files changed after their manifest was written, before reuse or planning", async () => {
		const r = legacy("rewrite", { content: "before" });
		const dir = makeExport([r]);
		await m.plan({ exportDir: dir });
		r.props.content = "after";
		writeJsonl(path.join(dir, "bothq", "records.jsonl"), [r]);
		await assert.rejects(m.plan({ exportDir: dir }), /does not match its manifest \(bothq\/records\.jsonl hash\)/);
		await assert.rejects(m.plan({ exportDir: dir, force: true }), /does not match its manifest/);
		const md = makeExport([], [{ system: "codex", rel: "MEMORY.md", category: "codex_memory", realpath: "~/x/MEMORY.md", paths: ["~/x/MEMORY.md"], content: "one", sha256: sha256("one"), bytes: 3 }]);
		const files = readJsonl(path.join(md, "markdown", "files.jsonl"));
		files[0].content = "two";
		writeJsonl(path.join(md, "markdown", "files.jsonl"), files);
		await assert.rejects(m.plan({ exportDir: md }), /markdown\/files\.jsonl hash/);
	});
});

// Closure review (docs/review-sol-import-export-fixes-2026-10-29.md): E2 with consecutive separators, and the URL scheme cap.
describe("export closure fixes", () => {
	it("E2: every reading of consecutive separators is listed, hidden folders included, and the record is held", () => {
		const base = fs.mkdtempSync(path.join(tmp, "amb2-"));
		const dirs = ["a/.b", "a--b", "a._b", "a_-b"].map((d) => path.join(base, d));
		for (const d of dirs) fs.mkdirSync(d, { recursive: true });
		const project = path.join(base, "a--b").replace(/[/._]/g, "-");
		for (const d of dirs) assert.equal(d.replace(/[/._]/g, "-"), project, "all four encode to one folder name");
		assert.deepEqual(m.decodeProjectDirs(project), [...dirs].sort());
		const it = m.markdownItem({ system: "claude", project, rel: "t.md", category: "claude_topic", content: "note", realpath: path.join(base, "t.md"), paths: [],
			sha256: sha256("note"), bytes: 4, birthtime: "2026-01-01T00:00:00Z", mtime: "2026-01-01T00:00:00Z" }, m.defaultRouting());
		assert.deepEqual([it.route, it.review], [null, ["ambiguous_project_path"]]);
		// A search that outgrows its bound reports no candidates rather than a partial set.
		assert.equal(m.decodeProjectDirs(project, 3), null);
	});

	it("URL passwords redact for every scheme length, as the original pattern did, and a long run stays fast", async () => {
		const { redactText } = await import("../src/domain/redact.ts");
		const { redact } = await import("./agent-memory.mjs");
		// BothQ's original pattern, unbounded: correct, but quadratic on long runs, so it only sees short inputs here.
		const original = (s) => s.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi, (_m, h, a) => `${h}[REDACTED]${a}`);
		const cases = ["see https://user:hunter2@host/x", `${"a".repeat(64)}://u:pw@h/p`, `a${"1".repeat(64)}://u:pw@h/p`, "1111://u:pw@h/p", "+.-://u:pw@h",
			"x1a://u:pw@h and B2://v:qq@k", "a://u:p@b://v:q@c", "AB+c.d-e://U:P@H", "mailto:u@h", "no url here", "://u:p@h", "a ://u:p@h"];
		for (const c of cases) {
			assert.equal(redactText(c), original(c), c);
			assert.equal(redact(c), original(c), `local mirror: ${c}`);
		}
		assert.ok(!redactText(`a${"1".repeat(64)}://user:SECRETPW@host/p`).includes("SECRETPW"), "the 65-character scheme");
		for (const big of ["x".repeat(1_000_000), `a${"1".repeat(1_000_000)}://u:SECRETPW@h`]) {
			const t0 = performance.now();
			const out = redactText(big), local = redact(big);
			assert.ok(performance.now() - t0 < 2000, "linear on a 1 MB run");
			assert.equal(out, local);
			assert.ok(!out.includes("SECRETPW"));
		}
	});

	it("S2: dry-run refuses a batch schedule that was changed, renumbered or left without its hash", async () => {
		const dir = makeExport(Array.from({ length: 30 }, (_, i) => record({ eid: `b${i}`, legacyId: uuid5(`personal:project:n${i}`), scope: "personal", name: `n${i}`, props: { content: `c${i}` } })));
		await m.plan({ exportDir: dir, rehearsal: "test" });
		assert.equal(m.dryRun({ exportDir: dir, rehearsal: "test" }).batches, 2);
		const sub = path.join(dir, "plan-rehearsal-test");
		const batches = readJsonl(path.join(sub, "batches.jsonl"));
		writeJsonl(path.join(sub, "batches.jsonl"), [batches[0], { ...batches[1], batch: 1 }]);
		assert.throws(() => m.dryRun({ exportDir: dir, rehearsal: "test" }), /batches\.jsonl is missing or does not match/);
		// Resealed in the manifest, the renumbered schedule still fails its coverage check.
		const manifest = JSON.parse(fs.readFileSync(path.join(sub, "manifest.json"), "utf8"));
		fs.writeFileSync(path.join(sub, "manifest.json"), JSON.stringify({ ...manifest, batches_sha256: sha256(fs.readFileSync(path.join(sub, "batches.jsonl"), "utf8")) }));
		assert.throws(() => m.dryRun({ exportDir: dir, rehearsal: "test" }), /exactly once, in order/);
		fs.writeFileSync(path.join(sub, "manifest.json"), JSON.stringify({ ...manifest, batches_sha256: undefined }));
		assert.throws(() => m.dryRun({ exportDir: dir, rehearsal: "test" }), /missing or does not match/);
	});
});
