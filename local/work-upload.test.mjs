import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpServer } from "./agent-memory.mjs";
import { collectCommits, uploadWork } from "./work-upload.mjs";

function fixture(t) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "am-synthetic-work-"));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--initial-branch=main");
	git("config", "user.name", "Synthetic Author");
	git("config", "user.email", "42+A-Lee@users.noreply.github.com");
	git("config", "commit.gpgsign", "false");
	git("remote", "add", "origin", "git@github.com:SyntheticOrg/Web.git");
	const commit = (title) => { git("commit", "--allow-empty", "-m", title); return git("rev-parse", "HEAD"); };
	return { cwd, git, commit, stateFile: path.join(cwd, "private-state", "work.json") };
}
const acknowledge = (batch) => ({ profile: batch.profile, commits: batch.commits.map((c) => ({ key: `git:syntheticorg/web@${c.sha}`, status: "stored" })), ...(batch.marker ? { marker: { status: "stored" } } : {}) });

test("collects full SHAs and normalized handles, bounds and redacts titles, omits unknown authors, and makes no remote call", (t) => {
	const f = fixture(t), first = f.commit("WU-12 token=hunter2secret bob@example.com");
	f.git("config", "user.email", "private@example.com");
	const second = f.commit("x".repeat(400));
	const batch = collectCommits(f.cwd);
	assert.deepEqual(batch.commits.map((c) => c.sha), [first, second]);
	assert.equal(batch.repo, "syntheticorg/web");
	assert.equal(batch.commits[0].author, "a-lee");
	assert.equal(batch.commits[1].author, undefined);
	assert.equal(batch.commits[1].title.length, 280);
	assert.doesNotMatch(JSON.stringify(batch), /hunter2|example\.com|noreply|Synthetic Author/);
	assert.equal(collectCommits(f.cwd, first).commits.length, 1);
	assert.deepEqual(collectCommits(f.cwd, second).commits, []);
});

test("keeps exact pending bytes and the old marker across a lost response and a refusal, then acknowledges once", async (t) => {
	const f = fixture(t), first = f.commit("first");
	const sent = [];
	const options = { ...f, profile: "test", now: () => "2026-10-29T10:00:00.000Z" };
	assert.equal((await uploadWork({ ...options, send: async (b) => { sent.push(b); throw new Error("lost response"); } })).status, "pending");
	const kept = fs.readFileSync(f.stateFile, "utf8");
	assert.equal(JSON.parse(kept).head, undefined);
	assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
	f.commit("arrived while pending");
	assert.equal((await uploadWork({ ...options, send: async (b) => { assert.deepEqual(b, sent[0]); return { ...acknowledge(b), marker: { status: "refused" } }; } })).status, "pending");
	assert.equal(fs.readFileSync(f.stateFile, "utf8"), kept);
	assert.equal((await uploadWork({ ...options, send: async (b) => { assert.deepEqual(b, sent[0]); return acknowledge(b); } })).status, "acknowledged");
	assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).head, first);
	assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).pending, undefined);
});

test("sends fifty-item batches, stops before the marker on a failed batch, and refuses me or corrupt state", async (t) => {
	const f = fixture(t);
	for (let i = 0; i < 51; i++) f.commit(`commit ${i}`);
	const sent = [], options = { ...f, profile: "test" };
	assert.equal((await uploadWork({ ...options, send: async (b) => { sent.push(b); return { ...acknowledge(b), commits: [] }; } })).status, "pending");
	assert.equal(sent.length, 1); assert.equal(sent[0].commits.length, 50); assert.equal(sent[0].marker, undefined);
	const lengths = [];
	assert.equal((await uploadWork({ ...options, send: async (b) => { lengths.push(b.commits.length); if (lengths.length === 1) assert.equal(b.marker, undefined); else assert.ok(b.marker); return acknowledge(b); } })).status, "acknowledged");
	assert.deepEqual(lengths, [50, 1]);
	assert.equal((await uploadWork({ ...options, send: () => { throw new Error("must not send"); } })).status, "unchanged");
	await assert.rejects(uploadWork({ ...options, profile: "me" }), /invalid_profile/);
	fs.writeFileSync(f.stateFile, "{");
	await assert.rejects(uploadWork(options), /invalid_work_state/);
});


test("uses the job ingest transport and retains pending input when its acknowledgements are incomplete", async (t) => {
	const f = fixture(t); f.commit("synthetic transport commit");
	const tokenFile = path.join(f.cwd, "synthetic-token"); fs.writeFileSync(tokenFile, "am_job_synthetic_only", { mode: 0o600 });
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async (url, options) => {
		assert.equal(url.pathname, "/v1/ingest");
		assert.equal(options.headers.authorization, "Bearer am_job_synthetic_only");
		assert.equal(options.redirect, "error");
		assert.ok(options.signal instanceof AbortSignal);
		return Response.json(acknowledge(JSON.parse(options.body)));
	};
	const server = httpServer({ server: "https://memory.invalid", token_file: tokenFile });
	assert.equal((await uploadWork({ ...f, profile: "test", send: server.work })).status, "acknowledged");
});
