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

async function uploaded(dir, opts = {}) {
	const p = await m.plan({ exportDir: dir, ...opts });
	fs.writeFileSync(path.join(p.dir, "upload-example.test.json"), JSON.stringify({ server: "https://example.test", commands_sha256: p.manifest.commands_sha256,
		batches_sha256: p.manifest.batches_sha256, done: Array.from({ length: p.manifest.batches }, (_, i) => i + 1), receipts: {} }));
	return p;
}
function advanceRecord(base, count) {
	const r = structuredClone(base);
	for (let i = 0; i < count; i++) {
		const revision = ++r.props._version, entry = `new entry ${i}`;
		r.props.content += `\n${entry}`;
		r.props.rule = r.props.content;
		r.props.content_hash = m.bothqContentHash(r.props);
		r.revisions.push({ revision_id: `${r.props.memory_id}:${revision}`, revision, operation: "appended", snapshot_json: canonicalJson({ memory_id: r.props.memory_id, _version: revision }),
			delta_json: canonicalJson({ content: entry, separator: "\n" }), request_id: `advance-${r.props.memory_id}-${revision}`, _created: dt("2026-04-01T00:00:00Z"), content_hash: r.props.content_hash });
		r.requests.push({ request_id: `advance-${r.props.memory_id}-${revision}`, operation: "append", request_hash: sha256(`advance-${revision}`), result: canonicalJson({ ok: true, revision }), memory_id: r.props.memory_id,
			_created: dt("2026-04-01T00:00:00Z"), _completed: dt("2026-04-01T00:00:00Z") });
	}
	return r;
}

describe("refresh plan", () => {
	it("requires a completed base upload and splits 200 appends into bounded consecutive anchored refreshes", async () => {
		const base = journal("refresh-large", { appends: 0, size: 1 }), baseDir = makeExport([base]);
		await m.plan({ exportDir: baseDir });
		const fresh = advanceRecord(base, 200), dir = makeExport([fresh]);
		await assert.rejects(m.plan({ exportDir: dir, refreshFrom: baseDir }), /finish.*base upload/i);
		const initial = await uploaded(baseDir);
		const result = await m.plan({ exportDir: dir, refreshFrom: baseDir });
		const commands = planned(dir), fins = commands.filter((c) => c.op === "finalize");
		assert.ok(fins.length > 1);
		assert.equal(result.manifest.planned, 1);
		let hash = planned(baseDir).find((c) => c.op === "finalize").record_sha256, revision = base.props._version;
		for (const [i, f] of fins.entries()) {
			assert.equal(f.refresh.no, i + 1);
			assert.equal(f.refresh.base_record_sha256, hash);
			assert.equal(f.refresh.base_revision, revision);
			assert.ok(f.node.revision > revision);
			hash = f.record_sha256; revision = f.node.revision;
		}
		assert.equal(revision, fresh.props._version);
		assert.deepEqual(commands.filter((c) => c.op === "stage").flatMap((c) => c.rows.revisions), m.bothqItem(fresh).revisions.slice(base.revisions.length));
		assert.equal(m.dryRun({ exportDir: dir }).over_budget_parts, 0);
		assert.equal(initial.manifest.planned, 1);
	});

	it("marks the body replaced when an update empties it, though no body row is left to send", async () => {
		const base = journal("refresh-empty", { appends: 2, size: 1 }), baseDir = makeExport([base]);
		await uploaded(baseDir);
		const fresh = structuredClone(base), revision = ++fresh.props._version;
		Object.assign(fresh.props, { content: "", rule: "" });
		fresh.props.content_hash = m.bothqContentHash(fresh.props);
		fresh.revisions.push({ revision_id: `${fresh.props.memory_id}:${revision}`, revision, operation: "updated", snapshot_json: canonicalJson({ ...fresh.props }), delta_json: null,
			request_id: null, _created: dt("2026-04-01T00:00:00Z"), content_hash: fresh.props.content_hash });
		const dir = makeExport([fresh]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir });
		const commands = planned(dir), fin = commands.find((c) => c.op === "finalize");
		assert.equal(fin.refresh.body_revision, revision);
		assert.deepEqual([fin.node.chars, commands.flatMap((c) => c.rows?.texts ?? []).length], [0, 0]);
	});

	it("carries an identical legacy adoption into the first of 200 split appends", async () => {
		const id = uuid5("personal:project:adoption");
		const legacy = record({ eid: "e-adoption", legacyId: id, name: "Adoption", scope: "personal", props: { content: "legacy", rule: "legacy" } });
		const baseDir = makeExport([legacy]);
		await uploaded(baseDir);
		const fresh = structuredClone(legacy);
		fresh.props = { ...fresh.props, memory_id: id, memory_type: "project", status: "active", content_hash: m.bothqContentHash({ ...fresh.props, memory_type: "project" }) };
		fresh.labels.push("MemoryRecord");
		fresh.revisions = [{ revision: 1, operation: "legacy_adopted", revision_id: `${id}:1`, snapshot_json: canonicalJson({ ...fresh.props, content: "legacy" }), delta_json: null,
			request_id: null, _created: dt("2026-03-01T00:00:00Z"), content_hash: fresh.props.content_hash }];
		const dir = makeExport([advanceRecord(fresh, 200)]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir });
		assert.deepEqual(reviewOf(dir), []);
		const fins = planned(dir).filter((c) => c.op === "finalize"), stages = planned(dir).filter((c) => c.op === "stage");
		assert.ok(fins.length > 1);
		// The adoption row goes in the first refresh only; each later one extends the adopted history.
		assert.deepEqual(stages.flatMap((c) => c.rows.revisions).filter((r) => r.op === "legacy_adopted").map((r) => r.revision), [1]);
		assert.ok(stages.filter((c) => c.refresh.no === 1).some((c) => c.rows.revisions.some((r) => r.op === "legacy_adopted")));
		assert.equal(fins.at(-1).node.revision, 201);
	});

	it("holds rewritten, vanished and rerouted sources without emitting replacement writes", async () => {
		const a = journal("refresh-a", { appends: 0 }), b = journal("refresh-b", { appends: 0 }), c = journal("refresh-c", { appends: 0 });
		const base = makeExport([a, b, c]); await uploaded(base);
		const changed = advanceRecord(a, 1); changed.revisions[0].snapshot_json = canonicalJson({ content: "rewritten" });
		const moved = advanceRecord(c, 1); moved.resolved_scope = "sequoia";
		const dir = makeExport([changed, moved]); await m.plan({ exportDir: dir, refreshFrom: base });
		assert.equal(planned(dir).length, 0);
		const reasons = reviewOf(dir).flatMap((r) => r.reasons);
		for (const reason of ["history_rewritten", "source_vanished", "route_changed"]) assert.ok(reasons.includes(reason), reason);
	});
});

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

// Reviewed routes (`plan --routes FILE`): exact sources of one export, bound to their exported rows, routed only where no rule routes.
describe("reviewed routes", () => {
	const legacy = (name, scope, props = {}) => record({ eid: `rr-${name}`, legacyId: uuid5(`${scope}:project:${name}`), scope, name, props: { content: "safe", ...props } });
	const rollout = (rel, content) => ({ system: "codex", rel, category: "codex_rollout_summary", realpath: `~/rr/${rel}`, paths: [`~/rr/${rel}`], content, sha256: sha256(content),
		bytes: Buffer.byteLength(content), utf8: true, birthtime: "2026-01-01T00:00:00Z", mtime: "2026-01-01T00:00:00Z" });
	/** A reviewed routes file for this export, as the owner's reviewed input binds it; `edit` changes the document. */
	function routesFile(dir, picks, edit = (d) => d) {
		const rows = [...readJsonl(path.join(dir, "bothq", "records.jsonl")), ...readJsonl(path.join(dir, "markdown", "files.jsonl"))];
		const routes = picks.map(([source, profile]) => {
			const row = rows.find((r) => (r.eid ? `bothq:${r.eid}` : `${r.system}:${r.realpath}`) === source);
			const it = row.eid ? m.bothqItem(row) : m.markdownItem(row, []);
			return { source, id: it.id, scope: it.node.scope, profile, source_sha256: sha256(canonicalJson(row)) };
		});
		const file = path.join(fs.mkdtempSync(path.join(tmp, "routes-")), "routes.json");
		fs.writeFileSync(file, JSON.stringify(edit({ version: 1, export_manifest_sha256: sha256(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")), routes })));
		return file;
	}
	const outputs = (dir) => Object.fromEntries(["commands.jsonl", "batches.jsonl", "records.jsonl", "review.jsonl", "manifest.json"].map((f) => [f, fs.readFileSync(path.join(dir, "plan", f), "utf8")]));

	it("routes only the reviewed sources, keeps their provenance and every other hold, and leaves a plan without routes byte-identical", async () => {
		const mixed = legacy("mixed", "bot_hq"), secret = legacy("secret", "bot_hq", { content: "Use token=abc123secret." }), work = legacy("work", "sequoia");
		const note = rollout("r1.md", "Outcome: done.\n");
		const dir = makeExport([mixed, secret, work], [note]);
		const before = await m.plan({ exportDir: dir }), first = outputs(dir);
		assert.deepEqual(before.manifest.reasons, { unrouted_scope: 2, needs_redaction: 1, unrouted_path: 1 });
		const file = routesFile(dir, [["bothq:rr-mixed", "personal"], ["bothq:rr-secret", "work"], ["codex:~/rr/r1.md", "work"]]);
		const r = await m.plan({ exportDir: dir, routes: file });
		assert.deepEqual(r.manifest.reviewed_routes, { sha256: sha256(fs.readFileSync(file, "utf8")), routes: 3 });
		assert.notEqual(r.manifest.input_sha256, before.manifest.input_sha256);
		const fins = Object.fromEntries(planned(dir).filter((c) => c.op === "finalize").map((c) => [c.node.name, c]));
		assert.deepEqual(Object.keys(fins).sort(), ["codex/r1.md", "mixed", "work"]);
		assert.deepEqual([fins.mixed.profile, fins["codex/r1.md"].profile, fins.work.profile], ["personal", "work", "work"]);
		// Nothing but the profile comes from the route: scope, provenance, history and requests are the exported record's own.
		assert.deepEqual(fins.mixed.node, m.bothqItem(mixed).node);
		assert.deepEqual(planned(dir).filter((c) => c.op === "stage" && c.record_id === fins.mixed.record_id).flatMap((c) => c.rows.revisions), m.bothqItem(mixed).revisions);
		assert.deepEqual(reviewOf(dir).map((x) => [x.key, x.reasons, x.proposed]), [["bothq:rr-secret", ["needs_redaction"], { profile: "work", rule: "reviewed" }]]);
		const repeated = await m.plan({ exportDir: dir, routes: file });
		assert.equal(repeated.status, "planned");
		assert.equal(repeated.manifest.commands_sha256, r.manifest.commands_sha256);
		// A changed review file is a new input: the dropped source is unrouted again.
		const fewer = routesFile(dir, [["bothq:rr-mixed", "personal"]]);
		const again = await m.plan({ exportDir: dir, routes: fewer });
		assert.deepEqual([again.status, again.manifest.reviewed_routes.sha256, again.manifest.reasons], ["planned", sha256(fs.readFileSync(fewer, "utf8")), { unrouted_scope: 1, needs_redaction: 1, unrouted_path: 1 }]);
		// Routes that change no command still make another plan, with its own review and manifest, so the cache must not reuse it.
		const heldOnly = await m.plan({ exportDir: dir, routes: routesFile(dir, [["bothq:rr-secret", "work"]]) });
		assert.equal(heldOnly.manifest.commands_sha256, before.manifest.commands_sha256);
		assert.equal((await m.plan({ exportDir: dir })).status, "planned");
		assert.deepEqual(outputs(dir), first);
	});

	it("refuses another export, a changed or unknown source, me, a bad schema, a rule-routed source and a rehearsal, before any output", async () => {
		const repo = fs.mkdtempSync(path.join(tmp, "rr-repo-"));
		spawnSync("git", ["init", "-q", repo]);
		spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:Sequoia-Engineering/app.git"]);
		const dir = makeExport([legacy("mixed", "bot_hq"), legacy("work", "sequoia")], [rollout("r2.md", `cwd: ${repo}\n\nOutcome.\n`)]);
		const one = (edit) => routesFile(dir, [["bothq:rr-mixed", "work"]], edit);
		const route = (patch) => one((d) => ({ ...d, routes: [{ ...d.routes[0], ...patch }] }));
		const cases = [
			[one((d) => ({ ...d, export_manifest_sha256: sha256("another export") })), /made for another export/],
			[route({ id: uuid5("bot_hq:project:other") }), /route 1 no longer matches/],
			[route({ scope: "personal" }), /route 1 no longer matches/],
			[route({ source_sha256: sha256("edited row") }), /route 1 no longer matches/],
			[route({ source: "bothq:mixed" }), /route 1 names a source this export does not have/],
			[route({ profile: "me" }), /nothing is routed into me/],
			[route({ profile: "test" }), /route 1 profile/],
			[route({ evidence: "extra" }), /route 1 schema/],
			[one((d) => ({ ...d, routes: [d.routes[0], d.routes[0]] })), /route 2 repeats a source/],
			[one((d) => ({ ...d, version: 2 })), /refused: schema/],
			[routesFile(dir, [["bothq:rr-work", "work"]]), /route 1 conflicts with an existing routing rule/],
			// A work remote comes first: no reviewed route sends its checkout elsewhere.
			[routesFile(dir, [["codex:~/rr/r2.md", "personal"]]), /route 1 conflicts with an existing routing rule/],
		];
		for (const [file, error] of cases) await assert.rejects(m.plan({ exportDir: dir, routes: file }), error);
		await assert.rejects(m.plan({ exportDir: dir, rehearsal: "test", routes: one() }), /rehearsal ignores routing/);
		assert.ok(!fs.existsSync(path.join(dir, "plan")) && !fs.existsSync(path.join(m.migrationDir(), "state.json")), "no plan, review or state written");
	});

	it("rechecks a reviewed source after its checkout gains a work remote", async () => {
		const repo = fs.mkdtempSync(path.join(tmp, "rr-cache-repo-"));
		assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
		const dir = makeExport([], [rollout("reroute.md", `cwd: ${repo}\n\nOutcome.\n`)]);
		const opts = { exportDir: dir, routes: routesFile(dir, [["codex:~/rr/reroute.md", "personal"]]) };
		assert.equal((await m.plan(opts)).manifest.records_by_profile.personal, 1);
		const before = outputs(dir);
		assert.equal(spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:Sequoia-Engineering/cache-fixture.git"]).status, 0);
		await assert.rejects(m.plan({ ...opts, force: true }), /conflicts with an existing routing rule/);
		await assert.rejects(m.plan(opts), /conflicts with an existing routing rule/);
		assert.deepEqual(outputs(dir), before);
	});

	it("keeps refresh route_changed protection: the same reviewed route fast-forwards, none or another profile holds", async () => {
		const base = journal("rr-refresh", { appends: 0, size: 1, scope: "bot_hq" }), baseDir = makeExport([base]), key = `bothq:${base.eid}`;
		await uploaded(baseDir, { routes: routesFile(baseDir, [[key, "personal"]]) });
		const dir = makeExport([advanceRecord(base, 2)]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir });
		assert.deepEqual([planned(dir).length, reviewOf(dir)[0].reasons], [0, ["unrouted_scope", "route_changed"]]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir, routes: routesFile(dir, [[key, "work"]]) });
		assert.deepEqual([planned(dir).length, reviewOf(dir)[0].reasons], [0, ["route_changed"]]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir, routes: routesFile(dir, [[key, "personal"]]) });
		const fin = planned(dir).find((c) => c.op === "finalize");
		assert.deepEqual([fin.profile, fin.refresh.no, fin.node.revision, reviewOf(dir)], ["personal", 1, base.props._version + 2, []]);
	});
});


describe("source policy", () => {
	const md = (realpath, content = "retained source") => ({system:"claude",project:"same-project",rel:"MEMORY.md",category:"claude_index",realpath,paths:[realpath],content,sha256:sha256(content),bytes:Buffer.byteLength(content),utf8:true,birthtime:"2026-01-01T00:00:00Z",mtime:"2026-02-01T00:00:00Z"});
	function approvals(dir, files, kind = "source_suffix", profile = "work") {
		const items=files.map(f=>m.markdownItem(f,[])), decision={reference:"synthetic owner intent",answer:"retain distinct sources",kind,permitted_ids:items.map(it=>it.id)};
		const exportHash=sha256(fs.readFileSync(path.join(dir,"manifest.json"),"utf8"));
		const routes=items.map((it,i)=>({source:it.key,id:it.id,scope:it.node.scope,profile,source_sha256:sha256(canonicalJson(files[i]))}));
		const entries=routes.map(r=>({...r,kind,owner_decision:decision,owner_decision_sha256:sha256(canonicalJson(decision)),...(kind==="archival_reference"?{profile_review_sha256:sha256("synthetic individual profile evidence")}: {})}));
		const rp=path.join(dir,"routes.json"),sp=path.join(dir,"policy.json");
		fs.writeFileSync(rp,JSON.stringify({version:1,export_manifest_sha256:exportHash,routes}),{mode:0o600});
		fs.writeFileSync(sp,JSON.stringify({version:1,export_manifest_sha256:exportHash,entries}),{mode:0o600});
		return {routes:rp,sourcePolicy:sp};
	}
	it("keeps two colliding source IDs and exact history, and applies source-first changed and empty refreshes",async()=>{
		const files=[md("~/synthetic-one/MEMORY.md"),md("~/synthetic-two/MEMORY.md","second source")],dir=makeExport([],files),opts=approvals(dir,files);
		await m.plan({exportDir:dir,routes:opts.routes});assert.equal(reviewOf(dir).filter(r=>r.reasons.includes("identity_conflict")).length,2);
		const initial=await uploaded(dir,opts),records=m.planRecords(initial.dir);assert.equal(records.length,2);assert.equal(initial.manifest.version,2);
		for(const r of records){const original=m.markdownItem(files.find(f=>r.key.endsWith(f.realpath)),[]);assert.equal(r.node.name,original.node.name+` [source ${r.id.slice(0,8)}]`);assert.equal(r.id,original.id);assert.deepEqual(r.revisions,original.revisions);assert.deepEqual(r.texts,original.texts);assert.deepEqual(r.requests,[]);assert.equal(r.node.attrs.import_review.source_head.content_hash,original.node.content_hash);assert.equal(r.node.content_hash,m.bothqContentHash({...r.node,content:r.content}));}
		const identical=makeExport([],files);fs.copyFileSync(path.join(dir,"manifest.json"),path.join(identical,"manifest.json"));await m.plan({exportDir:identical,...approvals(identical,files),refreshFrom:dir});assert.equal(planned(identical).length,0);
		const changed=[md(files[0].realpath,"changed source"),files[1]],fresh=makeExport([],changed);await uploaded(fresh,{...approvals(fresh,changed),refreshFrom:dir});
		const after=m.planRecords(path.join(fresh,"plan")).find(r=>r.id===records[0].id);assert.equal(after.node.revision,2);assert.equal(after.revisions.length,2);assert.equal(after.texts.filter(t=>!t.live)[0].body,"retained source");assert.equal(after.node.attrs.import_review.source_head.revision,2);
		const empty=[md(files[0].realpath,""),files[1]],last=makeExport([],empty);await m.plan({exportDir:last,...approvals(last,empty),refreshFrom:fresh});const fin=planned(last).find(c=>c.op==="finalize");assert.equal(fin.refresh.base_content_hash,after.node.content_hash);assert.equal(fin.refresh.body_revision,3);assert.equal(fin.node.chars,0);assert.equal(fin.node.name,after.node.name);assert.equal(fin.policy_version,1);
		const missing=makeExport([],empty);await m.plan({exportDir:missing,routes:approvals(missing,empty).routes,refreshFrom:fresh});assert.ok(reviewOf(missing).some(r=>r.reasons.includes("policy_changed")));
	});
	it("requires exact archive/profile witnesses and never waives redaction or creates a profile",async()=>{
		const file={...md("~/synthetic/skills/archive/SKILL.md"),system:"codex",category:"codex_reference_candidate",rel:"skills/archive/SKILL.md"},dir=makeExport([],[file]),opts=approvals(dir,[file],"archival_reference","work");
		await assert.rejects(m.plan({exportDir:dir,sourcePolicy:opts.sourcePolicy}),/cannot route/);
		const p=await m.plan({exportDir:dir,...opts});assert.equal(p.manifest.planned,1);assert.equal(planned(dir).find(c=>c.op==="finalize").node.attrs.import_review.kind,"archival_reference");
		const mismatch=JSON.parse(fs.readFileSync(opts.sourcePolicy));mismatch.entries[0].profile="personal";fs.writeFileSync(opts.sourcePolicy,JSON.stringify(mismatch));await assert.rejects(m.plan({exportDir:dir,...opts}),/cannot route/);
		approvals(dir,[file],"archival_reference","work");
		const policy=JSON.parse(fs.readFileSync(opts.sourcePolicy));policy.entries[0].source_sha256="0".repeat(64);fs.writeFileSync(opts.sourcePolicy,JSON.stringify(policy));await assert.rejects(m.plan({exportDir:dir,...opts}),/exact exported source/);
		const secret={...file,content:"token=abc123secret",sha256:sha256("token=abc123secret"),bytes:18},held=makeExport([],[secret]);await m.plan({exportDir:held,...approvals(held,[secret],"archival_reference","work")});assert.equal(planned(held).length,0);assert.ok(reviewOf(held)[0].reasons.includes("reference_candidate"));assert.ok(reviewOf(held)[0].reasons.includes("needs_redaction"));
	});
});

// Owner decision: every legacy identity of one export goes to Work under an exact closed v2 route document (docs/import-implementation.md).
describe("legacy Work owner classification", () => {
	const legacy = (name, scope, props = {}) => record({ eid: `lw-${name}`, legacyId: uuid5(`${scope}:project:${name}`), scope, name, props: { content: "safe", ...props } });
	const keyOf = (r) => (r.eid ? `bothq:${r.eid}` : `${r.system}:${r.realpath}`);
	const exportSha = (dir) => sha256(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
	const sign = (d) => { d.owner_decision.roster_sha256 = sha256(canonicalJson(d.roster)); d.owner_decision_sha256 = sha256(canonicalJson(d.owner_decision)); return d; };
	/** The v2 owner document: the export's roster (or the named sources), sorted by source key and bound into the owner decision. */
	function ownerFile(dir, keys = null, edit = (d) => d) {
		const rows = [...readJsonl(path.join(dir, "bothq", "records.jsonl")), ...readJsonl(path.join(dir, "markdown", "files.jsonl"))];
		const roster = rows.filter((r) => !keys || keys.includes(keyOf(r))).map((row) => {
			const it = row.eid ? m.bothqItem(row) : m.markdownItem(row, []);
			return { source: keyOf(row), id: it.id ?? null, scope: it.node.scope ?? null, source_sha256: sha256(canonicalJson(row)) };
		}).sort((a, b) => (a.source < b.source ? -1 : 1));
		const doc = sign({ version: 2, effect: "legacy_work_owner", export_manifest_sha256: exportSha(dir), owner_decision: { reference: "synthetic owner decision", answer: "synthetic: all old items go to work" }, roster });
		const file = path.join(fs.mkdtempSync(path.join(tmp, "owner-")), "routes.json");
		fs.writeFileSync(file, JSON.stringify(edit(doc)));
		return file;
	}
	function v1File(dir, row, profile) {
		const it = m.bothqItem(row), file = path.join(fs.mkdtempSync(path.join(tmp, "routes-")), "routes.json");
		fs.writeFileSync(file, JSON.stringify({ version: 1, export_manifest_sha256: exportSha(dir), routes: [{ source: keyOf(row), id: it.id, scope: it.node.scope, profile, source_sha256: sha256(canonicalJson(row)) }] }));
		return file;
	}
	const finalizes = (dir) => Object.fromEntries(planned(dir).filter((c) => c.op === "finalize").map((c) => [c.record_id, c]));

	it("sends an automatically Personal legacy member to Work only under exact v2 authority, while v1 still refuses it", async () => {
		const mine = legacy("mine", "personal"), mixed = legacy("mixed", "bot_hq"), outside = legacy("outside", "personal"), secret = legacy("secret", "personal", { content: "Use token=abc123secret." });
		const scopeless = record({ eid: "lw-scopeless", name: "no scope", props: { content: "safe" } });
		const dir = makeExport([mine, mixed, outside, scopeless, secret]), id = (r) => m.bothqItem(r).id;
		await m.plan({ exportDir: dir });
		assert.deepEqual(Object.values(finalizes(dir)).map((c) => c.profile), ["personal", "personal"]);
		await assert.rejects(m.plan({ exportDir: dir, routes: v1File(dir, mine, "work") }), /route 1 conflicts with an existing routing rule/);
		const p = await m.plan({ exportDir: dir, routes: ownerFile(dir, [mine, mixed, scopeless, secret].map(keyOf)) });
		const fins = finalizes(dir), w = fins[id(mine)].node.attrs.source.owner_classification;
		assert.deepEqual([p.manifest.version, fins[id(mine)].profile, fins[id(mixed)].profile, fins[id(outside)].profile], [2, "work", "work", "personal"]);
		assert.ok(planned(dir).filter((c) => c.record_id !== id(outside)).every((c) => c.classification_version === 1));
		assert.ok(planned(dir).filter((c) => c.record_id === id(outside)).every((c) => c.classification_version === undefined && !c.node?.attrs.source.owner_classification));
		assert.deepEqual([w.effect, w.profile, w.witness.id, w.witness.scope, fins[id(mine)].node.scope, fins[id(mine)].node.name], ["legacy_work_owner", "work", id(mine), "personal", "personal", "mine"]);
		assert.deepEqual(m.planRecords(p.dir).find((r) => r.id === id(mine)).route, { profile: "work", rule: "legacy_work_owner", automatic: { profile: "personal", rule: "scope:personal" } });
		assert.deepEqual([p.manifest.reviewed_routes.classified, reviewOf(dir).map((r) => [r.key, r.reasons, r.proposed?.profile])], [3, [[keyOf(scopeless), ["missing_scope"], undefined], [keyOf(secret), ["needs_redaction"], "work"]]]);
		m.dryRun({ exportDir: dir });
		const text = fs.readFileSync(path.join(dir, "plan", "commands.jsonl"), "utf8");
		fs.writeFileSync(path.join(dir, "plan", "commands.jsonl"), text.replace('"classification_version":1,', ""));
		assert.throws(() => m.dryRun({ exportDir: dir }), /classification command version differs/);
	});

	it("owner holds stage nothing for an old privacy hold or a new Personal candidate, leave unheld commands unchanged, and refuse a wrong binding", async () => {
		const oldHold = legacy("old-hold", "bot_hq"), kept = legacy("kept", "bot_hq"), fresh = legacy("fresh", "personal"), other = legacy("other", "personal");
		const dir = makeExport([oldHold, kept, fresh, other]), id = (r) => m.bothqItem(r).id, routes = ownerFile(dir, [oldHold, kept].map(keyOf));
		const holdsFile = (holds, edit = (d) => d) => {
			const file = path.join(fs.mkdtempSync(path.join(tmp, "holds-")), "holds.json");
			fs.writeFileSync(file, JSON.stringify(edit({ version: 1, export_manifest_sha256: exportSha(dir), holds: holds.map(([r, reason]) => ({ source: keyOf(r), source_sha256: sha256(canonicalJson(r)), reason })) })), { mode: 0o600 });
			return file;
		};
		const before = await m.plan({ exportDir: dir, routes });
		const all = planned(dir);
		const p = await m.plan({ exportDir: dir, routes, ownerHolds: holdsFile([[fresh, "unreviewed_new"], [oldHold, "privacy_hold"]].sort((a, b) => (keyOf(a[0]) < keyOf(b[0]) ? -1 : 1))) });
		const heldIds = [id(oldHold), id(fresh)];
		assert.deepEqual(planned(dir), all.filter((c) => !heldIds.includes(c.record_id)));
		assert.deepEqual([p.manifest.version, p.manifest.owner_holds.holds, p.manifest.planned, before.manifest.planned, m.planRecords(p.dir).map((r) => r.id).sort()], [2, 2, 2, 4, [id(kept), id(other)].sort()]);
		assert.deepEqual(reviewOf(dir).map((r) => [r.key, r.reasons, r.proposed, r.planned]), [[keyOf(fresh), ["owner_hold:unreviewed_new"], undefined, false], [keyOf(oldHold), ["owner_hold:privacy_hold"], undefined, false]]);
		const one = [[oldHold, "privacy_hold"]];
		const cases = [
			[holdsFile(one, (d) => ({ ...d, export_manifest_sha256: "0".repeat(64) })), /made for another export/],
			[holdsFile([[record({ eid: "not-exported", name: "x" }), "privacy_hold"]]), /names a source this export does not have/],
			[holdsFile(one, (d) => ({ ...d, holds: [{ ...d.holds[0], source_sha256: "0".repeat(64) }] })), /no longer matches its exported source/],
			[holdsFile([...one, ...one]), /not strictly sorted/],
			[holdsFile([[oldHold, "approved"]]), /hold 1 reason/],
			[holdsFile(one, (d) => ({ ...d, holds: [{ ...d.holds[0], profile: "work" }] })), /hold 1 schema/],
			[holdsFile([]), /schema/],
		];
		const last = fs.readFileSync(path.join(dir, "plan", "manifest.json"), "utf8");
		for (const [file, error] of cases) await assert.rejects(m.plan({ exportDir: dir, routes, ownerHolds: file }), error);
		fs.chmodSync(cases[0][0], 0o644);
		await assert.rejects(m.plan({ exportDir: dir, ownerHolds: cases[0][0] }), /private owner file/);
		assert.equal(fs.readFileSync(path.join(dir, "plan", "manifest.json"), "utf8"), last, "a refused holds file writes no plan");
	});

	it("refuses an unknown, stale, retargeted or unsigned owner document before any output", async () => {
		const mine = legacy("strict", "personal"), dir = makeExport([mine]), key = keyOf(mine);
		const entry = (over) => (d) => sign({ ...d, roster: [{ ...d.roster[0], ...over }] });
		const cases = [
			[entry({ source: "bothq:not-exported" }), /names a source this export does not have/],
			[entry({ source_sha256: "0".repeat(64) }), /no longer matches its exported source/],
			[entry({ id: null }), /no longer matches its exported source/],
			[entry({ scope: "sequoia" }), /no longer matches its exported source/],
			[entry({ profile: "personal" }), /roster 1 schema/],
			[(d) => sign({ ...d, roster: [d.roster[0], d.roster[0]] }), /sorted/],
			[(d) => ({ ...d, roster: [{ ...d.roster[0], scope: "sequoia" }] }), /owner decision/],
			[(d) => ({ ...d, owner_decision_sha256: "0".repeat(64) }), /owner decision/],
			[(d) => ({ ...d, export_manifest_sha256: "0".repeat(64) }), /made for another export/],
			[(d) => ({ ...d, version: 3 }), /schema/],
			[(d) => ({ ...d, effect: "legacy_personal_owner" }), /schema/],
			[(d) => ({ ...d, profile: "personal" }), /schema/],
		];
		for (const [edit, error] of cases) await assert.rejects(m.plan({ exportDir: dir, routes: ownerFile(dir, [key], edit) }), error);
		await assert.rejects(m.plan({ exportDir: dir, rehearsal: "test", routes: ownerFile(dir) }), /rehearsal ignores routing/);
		assert.ok(!fs.existsSync(path.join(dir, "plan")) && !fs.existsSync(path.join(m.migrationDir(), "state.json")), "no plan, review or state written");
	});

	it("recomputes all-Work collisions: a newly exposed collision stays held and only the approved D1 sources take suffixes", async () => {
		const md = (realpath, content, extra = {}) => ({ system: "claude", project: "same-project", rel: "MEMORY.md", category: "claude_index", realpath, paths: [realpath], content,
			sha256: sha256(content), bytes: Buffer.byteLength(content), utf8: true, birthtime: "2026-01-01T00:00:00Z", mtime: "2026-02-01T00:00:00Z", ...extra });
		const files = [md("~/lw-one/MEMORY.md", "first source"), md("~/lw-two/MEMORY.md", "second source"),
			md("~/lw/skills/archive/SKILL.md", "archived reference", { system: "codex", category: "codex_reference_candidate", rel: "skills/archive/SKILL.md" })];
		const twins = [legacy("twin", "bot_hq"), record({ eid: "lw-twin-b", legacyId: uuid5("bot_hq:project:twin-b"), scope: "bot_hq", name: "twin", props: { content: "safe" } })];
		const dir = makeExport(twins, files), routes = ownerFile(dir), reviewed = m.readReviewedRoutes(routes, dir);
		await m.plan({ exportDir: dir });
		assert.deepEqual(reviewOf(dir).filter((r) => r.key.startsWith("bothq:")).map((r) => r.reasons), [["unrouted_scope"], ["unrouted_scope"]]);
		const items = files.map((f) => m.markdownItem(f, [])), kinds = ["source_suffix", "source_suffix", "archival_reference"];
		const entries = items.map((it, i) => {
			const decision = { reference: "synthetic owner intent", answer: "retain distinct sources", kind: kinds[i], permitted_ids: items.filter((_, j) => kinds[j] === kinds[i]).map((x) => x.id) };
			return { source: it.key, id: it.id, scope: it.node.scope, profile: "work", source_sha256: sha256(canonicalJson(files[i])), kind: kinds[i], owner_decision: decision, owner_decision_sha256: sha256(canonicalJson(decision)),
				...(kinds[i] === "archival_reference" ? { profile_review_sha256: sha256(canonicalJson(m.ownerWitness(reviewed, reviewed.routes.get(it.key), it))) } : {}) };
		});
		const sourcePolicy = path.join(dir, "policy.json"), writePolicy = () => fs.writeFileSync(sourcePolicy, JSON.stringify({ version: 1, export_manifest_sha256: exportSha(dir), entries }), { mode: 0o600 });
		writePolicy();
		await m.plan({ exportDir: dir, routes, sourcePolicy });
		const fins = Object.values(finalizes(dir));
		assert.deepEqual([fins.length, fins.every((c) => c.profile === "work" && c.classification_version === 1), fins.filter((c) => / \[source [0-9a-f]{8}\]$/.test(c.node.name)).length], [3, true, 2]);
		assert.equal(fins.find((c) => c.node.attrs.import_review?.kind === "archival_reference").policy_version, 1);
		assert.deepEqual(reviewOf(dir).map((r) => [r.reasons, r.proposed.profile, r.planned]), [[["identity_conflict"], "work", false], [["identity_conflict"], "work", false]]);
		entries[2].profile_review_sha256 = sha256("superseded individual profile review");
		writePolicy();
		await assert.rejects(m.plan({ exportDir: dir, routes, sourcePolicy }), /profile receipt differs from the owner classification/);
	});

	it("refreshes the same classified identity with a fresh witness, provenance-only when unchanged, and holds a missing or changed classification", async () => {
		const base = journal("lw-refresh", { appends: 0, size: 1, scope: "personal" }), baseDir = makeExport([base]);
		await uploaded(baseDir, { routes: ownerFile(baseDir) });
		const old = planned(baseDir).find((c) => c.op === "finalize");
		assert.equal(old.profile, "work");
		const dir = makeExport([advanceRecord(base, 1)]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir });
		assert.deepEqual([planned(dir).length, reviewOf(dir)[0].reasons.includes("classification_changed")], [0, true]);
		await assert.rejects(m.plan({ exportDir: dir, refreshFrom: baseDir, routes: ownerFile(baseDir) }), /made for another export/);
		await m.plan({ exportDir: dir, refreshFrom: baseDir, routes: ownerFile(dir) });
		const fin = planned(dir).find((c) => c.op === "finalize"), w = fin.node.attrs.source.owner_classification.witness, was = old.node.attrs.source.owner_classification.witness;
		assert.deepEqual([fin.profile, fin.refresh.no, fin.classification_version, fin.node.revision, reviewOf(dir)], ["work", 1, 1, base.props._version + 1, []]);
		assert.deepEqual([w.export_manifest_sha256 !== was.export_manifest_sha256, w.source_row_sha256 !== was.source_row_sha256, w.source_key_sha256 === was.source_key_sha256, w.id === was.id], [true, true, true, true]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir, routes: ownerFile(dir, null, (d) => { d.owner_decision.answer = "another answer"; d.owner_decision_sha256 = sha256(canonicalJson(d.owner_decision)); return d; }) });
		assert.deepEqual([planned(dir).length, reviewOf(dir)[0].reasons.includes("classification_changed")], [0, true]);
		const same = makeExport([base]);
		await m.plan({ exportDir: same, refreshFrom: baseDir, routes: ownerFile(same) });
		const meta = planned(same).find((c) => c.op === "finalize"), stage = planned(same).find((c) => c.op === "stage");
		assert.deepEqual([meta.node.revision, meta.refresh.base_revision, meta.refresh.body_revision, stage.rows.revisions.length + stage.rows.texts.length], [base.props._version, base.props._version, undefined, 0]);
		assert.notEqual(meta.node.attrs.source.owner_classification.witness.export_manifest_sha256, was.export_manifest_sha256);
	});

	it("never adopts an existing Personal or unclassified copy into Work in place", async () => {
		const base = journal("lw-personal", { appends: 0, size: 1, scope: "personal" }), baseDir = makeExport([base]);
		await uploaded(baseDir);
		assert.equal(planned(baseDir).find((c) => c.op === "finalize").profile, "personal");
		const dir = makeExport([advanceRecord(base, 1)]);
		await m.plan({ exportDir: dir, refreshFrom: baseDir, routes: ownerFile(dir) });
		assert.equal(planned(dir).length, 0);
		assert.ok(["route_changed", "classification_changed"].every((r) => reviewOf(dir)[0].reasons.includes(r)));
		const work = journal("lw-work", { appends: 0, size: 1, scope: "sequoia" }), workDir = makeExport([work]);
		await uploaded(workDir);
		const same = makeExport([work]);
		await m.plan({ exportDir: same, refreshFrom: workDir, routes: ownerFile(same) });
		assert.deepEqual([planned(same).length, reviewOf(same)[0].reasons.includes("classification_changed")], [0, true]);
	});
});
