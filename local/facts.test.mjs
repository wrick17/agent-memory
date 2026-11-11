// node --test local/facts.test.mjs : repo facts P0/P1 on this device. The recorded fixtures (test/fixtures/repo-facts) are real redacted
// digests; every other transcript or digest here is synthetic and built in the test. No network, no model, no real home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-facts-test-"));
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const am = await import("./agent-memory.mjs");
const { repoKey, commandDigest, mergeDigest, scrub } = await import("./facts.mjs");
const { detect, factKey } = await import("./facts-detect.mjs");
const fc = await import("./facts-client.mjs");
const { injectFacts, factsOutput, FACTS_INJECT } = await import("./facts-inject.mjs");
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });

const FIXTURES = new URL("../test/fixtures/repo-facts/", import.meta.url);
const fixture = (dir) => ({
	digests: fs.readFileSync(new URL(`${dir}/digests.jsonl`, FIXTURES), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
	expected: JSON.parse(fs.readFileSync(new URL(`${dir}/expected-facts.json`, FIXTURES), "utf8")),
});
const GH = "env -u GITHUB_TOKEN -u GH_TOKEN gh auth switch";
const cmd = (c, status = "ok", err = [], i = Math.random()) => ({ id: String(i), at: null, cmd: c, family: null, status, exit: status === "ok" ? 0 : status === "failed" ? 1 : null, err });
const digest = (commands, files = [], session = "codex:000000000001") => ({ v: 1, client: "codex", session, repo: "github.com/o/r", started_at: null, ended_at: null, files, commands, dropped: 0 });
const kinds = (d, known = []) => detect(d, { known }).observations.map((o) => `${o.kind}:${o.literal}`);
const TOKEN_FAIL = ["The value of the GITHUB_TOKEN environment variable is being used for authentication."];

// A synthetic Codex rollout: session_meta, then one completed CommandExecution per command and FileChange items for edits.
function rollout(file, { id, cwd, cmds = [], edits = [] }) {
	const lines = [{ type: "session_meta", timestamp: "2026-11-11T00:00:00Z", payload: { id, cwd } },
		...cmds.map(([c, exit, out = ""], i) => ({ type: "event_msg", timestamp: `2026-11-11T00:00:${String(i + 1).padStart(2, "0")}Z`, payload: { type: "item_completed", item: { type: "CommandExecution", id: `${id}-c${i}`, command: ["/bin/zsh", "-lc", c], exit_code: exit, aggregated_output: out, status: exit === 0 ? "completed" : "failed" } } })),
		...edits.map((p, i) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id: `${id}-f${i}`, status: "completed", changes: { [path.join(cwd, p)]: {} } } } }))];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const ghRepair = [["gh auth switch --user x", 1, TOKEN_FAIL[0]], [`${GH} --user x`, 0]];

describe("repo key", () => {
	it("gives one GitHub key for HTTPS, ssh:// and scp forms, resolves only a valid SSH alias, and refuses everything else", () => {
		const seen = [], resolveHost = (h) => { seen.push(h); return h === "personal" ? "github.com" : "gitlab.com"; };
		for (const r of ["https://github.com/Org/Repo.git", "git@github.com:org/repo", "ssh://git@github.com:22/org/repo/", "https://x-access-token:secret@github.com/org/repo"]) assert.equal(repoKey(r, { resolveHost }), "github.com/org/repo");
		assert.equal(repoKey("git@personal:org/repo.git", { resolveHost }), "github.com/org/repo");
		assert.equal(repoKey("git@work:org/repo.git", { resolveHost }), null, "an alias for another host gives no key");
		for (const r of ["git@-oProxyCommand=x:o/r", "git@a;b:o/r", "git@$(id):o/r", "https://gitlab.com/o/r", "git@github.com:o/r/extra", "file:///o/r", "", null]) assert.equal(repoKey(r, { resolveHost }), null, String(r));
		assert.deepEqual(seen, ["personal", "work"], "only valid aliases ever reach ssh");
		assert.equal(repoKey("https://gitlab.com/o/r", { resolveHost: () => "github.com" }), null, "an HTTPS host is never resolved");
	});
});

describe("command digest", () => {
	it("records only the outcomes a transcript states, pairs a Claude call with a result read later, and hashes repo-relative edits", () => {
		const key = "github.com/o/r", cwd = path.join(tmp, "repo");
		const L = (obj) => ({ obj });
		const codex = commandDigest("codex", [
			L({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "a", command: ["/bin/zsh", "-lc", "npm test"], exit_code: 127, aggregated_output: "sh: vitest: command not found" } } }),
			L({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "b", command: ["/bin/zsh", "-lc", "sleep 9"], aggregated_output: "" } } }),
			L({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" } }),
			L({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "c", command: ["/bin/zsh", "-lc", "apply_patch <<'P'\n*** Begin Patch\n*** Add File: docs/b.md\n*** End Patch\nP"], exit_code: 0 } } }),
		], { repoKey: key, session: "s1", cwd });
		assert.deepEqual(codex.commands.map((c) => [c.status, c.exit]), [["failed", 127], ["unknown", null], ["ok", 0]]);
		assert.deepEqual(codex.commands[0].err, ["sh: vitest: command not found"]);
		assert.equal(codex.files.length, 2, "an apply_patch call and one inside a shell command both count");
		assert.match(codex.session, /^codex:[0-9a-f]{12}$/, "a hashed session ref, never the raw id");

		const use = (id, command) => L({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
		const result = (id, content, is_error, toolUseResult = { stdout: "" }) => L({ type: "user", toolUseResult, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
		const first = commandDigest("claude-code", [use("t1", "make"), use("t2", "ls"), use("t3", "rm x"), use("t4", "long-job"), result("t2", "ok", false), result("t3", "Permission denied", true, "Error")],
			{ repoKey: key, session: "s2", cwd });
		assert.deepEqual(first.commands.map((c) => c.status), ["pending", "ok", "error", "pending"]);
		const later = commandDigest("claude-code", [result("t1", "Exit code 2\nmake: *** [all] Error 2", true, "Error"), result("t4", "Command running in background with ID: x", false, { backgroundTaskId: "x" })],
			{ repoKey: key, session: "s2", cwd, prior: first });
		const merged = mergeDigest(first, later);
		assert.deepEqual(merged.commands.map((c) => [c.cmd, c.status, c.exit]), [["make", "failed", 2], ["ls", "ok", null], ["rm x", "error", null], ["long-job", "unknown", null]]);
		assert.equal(commandDigest("codex", [], { repoKey: null, session: "s" }), null, "no repo key, no digest");
	});

	it("scrubs secrets, home and temp paths and emails from commands and errors, without splitting a redaction marker", () => {
		const home = os.homedir();
		const d = commandDigest("codex", [{ obj: { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "a",
			command: ["/bin/zsh", "-lc", `curl -H 'Authorization: Bearer abcdefghijklmnop' ${home}/x /private/tmp/y me@example.com`], exit_code: 1, aggregated_output: `token=ghp_${"a".repeat(30)}\n${home}/z` } } } }],
			{ repoKey: "github.com/o/r", session: "s" });
		const text = JSON.stringify(d);
		for (const bad of ["abcdefghijklmnop", home, "/private/tmp", "me@example.com", "ghp_"]) assert.ok(!text.includes(bad), bad);
		assert.equal(scrub(`GH_TOKEN=${"x".repeat(250)}`).length < 250, true);
	});
});

describe("review regressions (synthetic data)", () => {
	const codexLine = (item) => ({ obj: { type: "event_msg", payload: { type: "item_completed", item } } });
	const KEY_BLOCK = "-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETICTESTONLYNOTAREALKEYMATERIAL0000\n-----END OPENSSH PRIVATE KEY-----";

	it("removes a whole private-key block from failure output before choosing error lines, for both clients", () => {
		// No error-like line: the first lines are chosen, so a per-line scrub would keep the header and the material.
		const out = `${KEY_BLOCK}\ndone`;
		const codex = commandDigest("codex", [codexLine({ type: "CommandExecution", id: "k", command: ["/bin/zsh", "-lc", "ssh-add k"], exit_code: 1, aggregated_output: out })], { repoKey: "github.com/o/r", session: "s" });
		const claude = commandDigest("claude-code", [
			{ obj: { type: "assistant", message: { content: [{ type: "tool_use", id: "k", name: "Bash", input: { command: "ssh-add k" } }] } } },
			{ obj: { type: "user", toolUseResult: "Error", message: { content: [{ type: "tool_result", tool_use_id: "k", content: `Exit code 1\n${out}`, is_error: true }] } } }], { repoKey: "github.com/o/r", session: "s" });
		for (const d of [codex, claude]) {
			const text = JSON.stringify(d);
			assert.ok(!text.includes("PRIVATE KEY") && !text.includes("SYNTHETICTESTONLY"), text);
		}
	});

	it("hashes an apply_patch edit from a legacy exec_command_end as it does from a CommandExecution item", () => {
		const patch = "apply_patch <<'P'\n*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\nP", cwd = path.join(tmp, "repo");
		const opts = { repoKey: "github.com/o/r", session: "s", cwd };
		const current = commandDigest("codex", [codexLine({ type: "CommandExecution", id: "p", command: ["/bin/zsh", "-lc", patch], exit_code: 0 })], opts);
		const legacy = commandDigest("codex", [{ obj: { type: "event_msg", payload: { type: "exec_command_end", call_id: "p", command: ["/bin/zsh", "-lc", patch], exit_code: 0, stdout: "", stderr: "" } } }], opts);
		assert.equal(current.files.length, 1);
		assert.deepEqual(legacy.files, current.files);
	});

	it("contradicts a network fact only by a proven network operation to that host, never by text that merely names it", () => {
		const known = [{ detector: "network", literal: "api.example.com" }];
		for (const c of [
			"rg api.example.com README.md", "echo api.example.com", "curl -H 'Host: api.example.com' https://other.example.org/", "git fetch",
			"curl --url https://other.example/health --referer https://api.example.com",
			"ssh other.example echo api.example.com", "wget -O api.example.com https://other.example/health",
			"git ls-remote https://other.example/repo.git https://api.example.com", "nc -l api.example.com 443",
		]) {
			assert.deepEqual(kinds(digest([cmd(c)]), known), [], c);
			assert.ok(!detect(digest([cmd(c)]), { known }).labels.includes("host:api.example.com"), c);
		}
		for (const c of [
			"curl -fsS https://api.example.com/health", "curl --url https://api.example.com/health",
			"env -u GITHUB_TOKEN curl -fsS https://api.example.com/health", "git ls-remote https://api.example.com/o/r.git",
			"git ls-remote git@api.example.com:o/r.git", "ssh -T git@api.example.com", "ssh api.example.com echo other.example",
		]) assert.deepEqual(kinds(digest([cmd(c)]), known), ["contradict:api.example.com"], c);
	});
});

describe("detectors", () => {
	for (const dir of fs.readdirSync(FIXTURES)) {
		it(`reproduces the recorded expectations for ${dir}: the same observations in the same sessions, quiet controls silent`, () => {
			const { digests, expected } = fixture(dir);
			const known = [], got = [];
			for (const d of digests) {
				const obs = detect(d, { known }).observations;
				if (obs.length) got.push({ session: d.session, observations: obs.map((o) => ({ fact_key: o.fact_key, kind: o.kind })) });
				for (const o of obs) if (o.kind === "confirm" && !known.some((k) => factKey(k.detector, k.literal) === o.fact_key)) known.push({ detector: o.detector, literal: o.literal });
			}
			assert.deepEqual(got, expected.timeline.map((t) => ({ session: t.session, observations: t.observations.map(({ fact_key, kind }) => ({ fact_key, kind })) })));
			assert.deepEqual(known.map((k) => k.literal).sort(), expected.facts.map((f) => f.literal).sort());
			for (const q of expected.quiet_sessions) assert.deepEqual(detect(digests.find((d) => d.session === q)).observations, [], q);
			for (const m of expected.must_not_produce) assert.deepEqual(m.produced, [], m.signal);
		});
	}

	it("proves a success only for a single command or an && chain, inside 5 commands", () => {
		const fail = cmd("gh auth switch --user x", "failed", TOKEN_FAIL);
		assert.deepEqual(kinds(digest([fail, cmd(`${GH} --user x && gh api user`)])), [`confirm:${GH}`]);
		assert.deepEqual(kinds(digest([fail, cmd("unset GITHUB_TOKEN GH_TOKEN; gh auth switch --user x")])), [`confirm:${GH}`], "setup before the last ';' group counts");
		// ||, a pipe, a cut command and a step before a later ';' group prove nothing about the fix.
		for (const fix of [`${GH} --user x || true`, `${GH} --user x | cat`, `${GH} --user x --hostname github.co…`, `${GH} --user x; ssh -T git@github.com`])
			assert.deepEqual(kinds(digest([fail, cmd(fix)])), [], fix);
		assert.deepEqual(kinds(digest([fail, cmd(`${GH} --user x`, "failed")])), [], "a failed fix is no repair");
		assert.deepEqual(kinds(digest([fail, cmd(`${GH} --user x`, "unknown")])), [], "an unknown outcome is no success");
		assert.deepEqual(kinds(digest([fail, ...Array.from({ length: 5 }, (_, i) => cmd(`ls ${i}`)), cmd(`${GH} --user x`)])), [], "a fix after 5 commands is too late");
	});

	it("confirms a known repair when its fix runs again, lets a contradiction win, never contradicts env facts, and ignores loopback", () => {
		const known = [{ detector: "command_repair", literal: GH }];
		assert.deepEqual(kinds(digest([cmd(`${GH} --user x`)]), known), [`confirm:${GH}`]);
		assert.deepEqual(kinds(digest([cmd(`${GH} --user x`), cmd("gh auth switch --user x")]), known), [`contradict:${GH}`]);
		assert.deepEqual(detect(digest([cmd(`${GH} --user x`), cmd("gh auth switch --user x")]), { known }).fired, [], "fired never exceeds a confirmation");
		assert.deepEqual(kinds(digest([cmd("npm run build")]), [{ detector: "env_var", literal: "npm run build needs API_URL" }]), []);
		assert.deepEqual(kinds(digest([cmd("curl http://127.0.0.1:9223/json", "failed", ["curl: (7) Failed to connect to 127.0.0.1 port 9223"])])), []);
		assert.deepEqual(kinds(digest([cmd("git fetch", "failed", ["fatal: Could not resolve host: github.com"])])), ["confirm:github.com"]);
		assert.deepEqual(kinds(digest([cmd("cat a && npm test", "failed", ["sh: vitest: command not found"])])), [], "a chained failure is not attributed to its first step");
	});
});

describe("session reports", () => {
	const REPO = { remote: "git@github.com:o/r.git" }, KEY = "github.com/o/r";
	const replying = (sent, { profile = "personal", refuse = {} } = {}) => ({ facts: async (bytes) => {
		sent.push(bytes);
		const b = JSON.parse(bytes);
		return { profile, report: { action: "stored", facts: b.facts.observations.map((o) => refuse[o.fact_key] ? { fact_key: o.fact_key, status: "refused", reason: refuse[o.fact_key] } : { fact_key: o.fact_key, status: "stored", state: "candidate" }) } };
	} });
	const run = async (id, { cmds = ghRepair, edits = [], ended = true, server }) => {
		const cwd = path.join(tmp, `cwd-${n}`), file = path.join(tmp, `rollouts-${n}`, `${id}.jsonl`);
		fs.mkdirSync(cwd, { recursive: true });
		if (!fs.existsSync(file)) rollout(file, { id, cwd, cmds, edits });
		return fc.observeSession({ client: "codex", session: id, cwd }, file, REPO, { server, ended, config: am.withDefaults({}) });
	};

	it("reports only an ended session, once, with the same bytes on every resend, and treats 400 and 403 as final", async () => {
		const sent = [];
		let fail = true;
		const flaky = { facts: async (b) => { if (fail) { fail = false; throw Object.assign(new Error("offline"), { status: 503 }); } return replying(sent).facts(b); } };
		assert.equal((await run("s1", { ended: false, server: flaky })).status, "open");
		assert.equal(sent.length, 0, "a Stop never reports");
		const done = await run("s1", { server: flaky });
		assert.deepEqual([done.repo_key, done.completed, done.status], [KEY, true, "pending"]);
		assert.match(done.session, /^codex:[0-9a-f]{12}$/);
		const saved = JSON.parse(fs.readFileSync(path.join(am.home(), "facts", "sessions", "codex-s1.json"), "utf8")).report.bytes;
		assert.deepEqual(await fc.flushPending(flaky), { sent: 1, pending: 0, refused: 0 });
		assert.equal(sent[0], saved, "the resend is the saved bytes");
		assert.equal((await run("s1", { server: flaky })).status, "sent");
		assert.equal(sent.length, 1, "a sent report is never built or sent again");
		const body = JSON.parse(saved);
		assert.deepEqual(Object.keys(body.facts).sort(), ["families", "fired", "observations", "session"]);
		assert.ok(!saved.includes(tmp) && !saved.includes(os.homedir()), "no local path is uploaded");
		await run("s2", { server: { facts: async () => { throw Object.assign(new Error("bad"), { status: 400, error: { code: "idempotency_mismatch" } }); } } });
		assert.deepEqual(await fc.flushPending(replying(sent)), { sent: 0, pending: 0, refused: 0 }, "a refused report is not sent again");
	});

	it("attests disjoint file sets only from local history, drops overlap, and starts over on a lost ledger or another profile", async () => {
		const sent = [], server = replying(sent), disjoint = () => JSON.parse(sent.at(-1)).facts.observations[0].disjoint_from;
		await run("a1", { edits: ["src/a.ts"], server });
		assert.equal(disjoint(), undefined, "no history: unknown, never proof");
		await run("a2", { edits: [], server });
		assert.deepEqual(disjoint(), [JSON.parse(sent[0]).facts.session], "an empty set is disjoint");
		await run("a3", { edits: ["src/a.ts"], server });
		assert.deepEqual(disjoint(), [JSON.parse(sent[1]).facts.session], "an overlapping session is left out");
		fs.rmSync(path.join(am.home(), "facts", "ledger"), { recursive: true });
		await run("a4", { server });
		assert.equal(disjoint(), undefined, "a lost ledger gives no attestation");
		await run("a5", { server: replying(sent, { profile: "work" }) });
		await run("a6", { server: replying(sent, { profile: "work" }) });
		assert.deepEqual(disjoint(), [JSON.parse(sent.at(-2)).facts.session], "the work profile's chain holds only its own sessions");
	});

	it("drops a forgotten fact locally without suppressing it, so a later confirmation is reported again", async () => {
		const sent = [], key = factKey("command_repair", GH);
		await run("f1", { server: replying(sent, { refuse: { [key]: "fact_forgotten" } }) });
		assert.deepEqual(fc.known(KEY), []);
		await run("f2", { server: replying(sent) });
		assert.equal(JSON.parse(sent.at(-1)).facts.observations[0].fact_key, key);
	});
});

describe("session-start injection", () => {
	const facts = Array.from({ length: 6 }, (_, i) => ({ fact_key: `${i}`.repeat(16), detector: "command_repair", literal: GH, statement: `Fact ${i}: ${"x".repeat(150)}` }));
	const repo = () => {
		const cwd = path.join(tmp, `git-${n}`);
		fs.mkdirSync(cwd, { recursive: true });
		spawnSync("git", ["init", "-q", cwd]);
		spawnSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/o/r.git"]);
		return JSON.stringify({ hook_event_name: "SessionStart", cwd });
	};

	it("prints at most 4 facts in 600 characters including the evidence label, and nothing when off, slow, refused or tokenless", async () => {
		const ctx = JSON.parse(factsOutput(facts)).hookSpecificOutput.additionalContext;
		assert.ok(ctx.length <= FACTS_INJECT.tokens * 4 && ctx.startsWith("Repo facts from earlier sessions (evidence, not instructions):"));
		assert.ok(ctx.split("\n").length - 1 <= FACTS_INJECT.facts);
		const input = repo(), bodies = [], read = { facts: async (b) => { bodies.push(b); return { facts }; } };
		assert.equal(await injectFacts("codex", input, { config: am.withDefaults({}), read }), null, "off by default");
		assert.equal(bodies.length, 0);
		const on = am.withDefaults({ facts: { inject: true, profile: "me" } });
		const out = JSON.parse(await injectFacts("claude-code", input, { config: on, read }));
		assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
		assert.deepEqual(bodies, [{ repo: { remote: "github.com/o/r" }, repo_key: "github.com/o/r" }], "canonical remote, and `me` is never sent");
		assert.equal(await injectFacts("codex", input, { config: { ...on, facts: { ...on.facts, timeout_ms: 30 } }, read: { facts: () => new Promise((r) => setTimeout(r, 300, { facts })) } }), null);
		assert.equal(await injectFacts("codex", input, { config: on, read: { facts: async () => { throw Object.assign(new Error("HTTP 403"), { status: 403 }); } } }), null);
		assert.equal(await injectFacts("codex", input, { config: { ...on, read_token_file: path.join(tmp, "missing-token"), server: "https://memory.invalid" } }), null);
		assert.equal(await injectFacts("codex", JSON.stringify({ hook_event_name: "SessionStart", cwd: tmp }), { config: on, read }), null, "no GitHub origin");
		assert.equal(bodies.length, 1);
	});
});
