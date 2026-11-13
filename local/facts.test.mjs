// node --test local/facts.test.mjs : repo facts v2 on this device (docs/repo-facts-v2-contract.md). The recorded fixtures
// (test/fixtures/repo-facts) are real redacted digests; every other transcript or digest here is synthetic and built in the test.
// No network, no model, no real home: every test gets its own AGENT_MEMORY_HOME, and `git` is a fake on PATH that reads a checkout's
// origin from its .git/config (FAKE_GIT_SLEEP makes it slow), so attribution and the SessionStart deadline are tested without real git.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-facts-test-"));
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
[ "$1" = "-C" ] || exit 2
t="$2"; shift 2
[ -n "$FAKE_GIT_SLEEP" ] && sleep "$FAKE_GIT_SLEEP"
while [ ! -e "$t/.git" ] && [ "$t" != "/" ]; do t=$(dirname "$t"); done
[ -e "$t/.git" ] || exit 128
case "$1 $2" in
"rev-parse --show-toplevel") cd "$t" && pwd -P ;;
"remote get-url") u=$(sed -n '/^\\[remote "origin"\\]/,/^\\[/s/^[[:space:]]*url = //p' "$t/.git/config" 2>/dev/null | head -1); [ -n "$u" ] && echo "$u" || exit 2 ;;
*) exit 2 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const am = await import("./agent-memory.mjs");
const { repoKey, commandDigest, mergeDigest, scrub, partitionId, rememberDir, machineId } = await import("./facts.mjs");
const { detect, factKey, outcomes } = await import("./facts-detect.mjs");
const fc = await import("./facts-client.mjs");
const { injectFacts, factsOutput, FACTS_INJECT } = await import("./facts-inject.mjs");
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); delete process.env.FAKE_GIT_SLEEP; });

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
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A checkout the fake git knows: a .git directory whose config names its origin. Returns its path. */
const setOrigin = (d, remote) => fs.writeFileSync(path.join(d, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
const checkout = (name, remote, dir = path.join(tmp, `repos-${n}`, name)) => {
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	if (remote) setOrigin(dir, remote);
	return dir;
};
const plainDir = (name) => { const d = path.join(tmp, `repos-${n}`, name); fs.mkdirSync(d, { recursive: true }); return d; };
const real = (d) => fs.realpathSync(d);

// Claude Code transcript lines: a Bash call (with the line's cwd and usage) and its result.
let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 11, 10, 0, ++clock)).toISOString();
const use = (id, command, cwd, usage = null) => ({ type: "assistant", timestamp: at(), cwd, message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command } }], ...(usage ? { usage } : {}) } });
const res = (id, text, isError) => ({ type: "user", timestamp: at(), toolUseResult: isError ? "Error" : { stdout: "" }, message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const transcript = (lines) => { const f = path.join(tmp, `t-${n}-${++clock}.jsonl`); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f; };
const USAGE = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 };

// A synthetic Codex rollout: session_meta, then one completed CommandExecution per command (with the cwd as Codex records it).
function rollout(file, { id, cwd, cmds = [] }) {
	const lines = [{ type: "session_meta", timestamp: "2026-11-11T00:00:00.000Z", payload: { id, cwd } },
		...cmds.map(([c, exit, out = ""], i) => ({ type: "event_msg", timestamp: `2026-11-11T00:00:${String(i + 1).padStart(2, "0")}.000Z`, payload: { type: "item_completed", item: { type: "CommandExecution", id: `${id}-c${i}`, cwd: `file://${cwd}`, command: ["/bin/zsh", "-lc", c], exit_code: exit, aggregated_output: out } } }))];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}
const VITEST = [["vitest run", 127, "zsh: command not found: vitest"], ["npx vitest run", 0]];

/** A fact server: records every body, replies like src/api.ts (flat v2 shape), routing by path through `profileOf`. */
const ingest = (sent, { profileOf = () => "work", refuse = {}, report = "stored" } = {}) => ({ facts: async (bytes) => {
	sent.push(bytes);
	const b = JSON.parse(bytes);
	return { ok: true, action: "stored", report, profile: profileOf(b), routed_by: "rule", repo_key: b.repo_key,
		facts: (b.facts.observations ?? []).map((o) => refuse[o.fact_key] ? { fact_key: o.fact_key, status: "refused", reason: refuse[o.fact_key] } : { fact_key: o.fact_key, status: "stored", state: "candidate" }) };
} });
const failing = (status, reason, calls = []) => ({ facts: async (bytes) => { calls.push(bytes); throw Object.assign(new Error(`HTTP ${status}`), { status, error: { code: "x", details: reason ? { reason } : {} } }); } });
const config = (facts = {}) => am.withDefaults({ facts: { inject: true, timeout_ms: 5000, ...facts } });
const codexSession = async (id, cwd, { cmds = VITEST, ended = true, server, read = null }) =>
	fc.observeSession({ client: "codex", session: id, cwd }, rollout(path.join(tmp, `rollouts-${n}`, `${id}.jsonl`), { id, cwd, cmds }), null, { server, ended, config: config(), read });
const bodies = (sent) => sent.map((b) => JSON.parse(b));
/**
 * Marks a directory as resolved, as the run does for each session's start directory, so a SessionStart test that is not about git needs
 * no subprocess (process start-up alone can take seconds on a loaded machine). The deadline test below runs git.
 */
const known = (cwd, remote, key) => rememberDir(am.home(), cwd, { remote, path: real(cwd), key });

describe("repo key", () => {
	it("gives one GitHub key for HTTPS, ssh:// and scp forms, resolves only a valid SSH alias, and refuses everything else", () => {
		const seen = [], resolveHost = (h) => { seen.push(h); return h === "personal" ? "github.com" : "gitlab.com"; };
		for (const r of ["https://github.com/Org/Repo.git", "git@github.com:org/repo", "ssh://git@github.com:22/org/repo/", "https://x-access-token:secret@github.com/org/repo"]) assert.equal(repoKey(r, { resolveHost }), "github.com/org/repo");
		assert.equal(repoKey("git@personal:org/repo.git", { resolveHost }), "github.com/org/repo");
		for (const r of ["git@github.com:Pratyush-Poddar_seq/spur.git", "https://github.com/pratyush-poddar_seq/spur"]) assert.equal(repoKey(r, { resolveHost }), "github.com/pratyush-poddar_seq/spur", "an EMU owner keeps its underscore");
		assert.equal(repoKey("git@github.com:owner_/repo", { resolveHost }), null, "an owner never ends in _");
		assert.equal(repoKey("git@work:org/repo.git", { resolveHost }), null, "an alias for another host gives no key");
		for (const r of ["git@-oProxyCommand=x:o/r", "git@a;b:o/r", "git@$(id):o/r", "https://gitlab.com/o/r", "git@github.com:o/r/extra", "file:///o/r", "", null]) assert.equal(repoKey(r, { resolveHost }), null, String(r));
		assert.deepEqual(seen, ["personal", "work"], "only valid aliases ever reach ssh");
		assert.equal(repoKey("https://gitlab.com/o/r", { resolveHost: () => "github.com" }), null, "an HTTPS host is never resolved");
	});
});

describe("redaction", () => {
	it("removes the review's leaked forms from commands, errors and uploads, and keeps references and elided values", () => {
		for (const [input, secret] of [
			["AWS_SECRET_ACCESS_KEY=abcd1234 aws s3 ls", "abcd1234"], ["export GH_TOKEN=xyz123; gh pr list", "xyz123"], ["NPM_KEY=foo123 npm i", "foo123"],
			["PGPASSWORD=hunter2 psql", "hunter2"], ["curl -H 'Authorization: Bearer abc.def' x", "abc.def"], ["curl -H \"Authorization: token abcdef\" x", "abcdef"],
			["mysql -u root --password hunter2", "hunter2"], ["mysql -uroot -phunter2 db", "hunter2"], ["curl -u alice:pw1 https://x", "pw1"],
			[`echo ghp_${"a".repeat(30)}`, "ghp_"], [`gho_${"b".repeat(30)}`, "gho_"], [`github_pat_${"c".repeat(30)}`, "github_pat_"], ["sk-proj-abcdefghijklmnop", "sk-proj"],
			["xoxb-1234567890-abc", "xoxb"], ["AKIAABCDEFGHIJKLMNOP", "AKIA"], ["cat /home/alice/.ssh/id", "alice"], ["cd /Users/bob/proj", "bob"], ["ls /root/.ssh", "/root"],
			["type C:\\Users\\carol\\x", "carol"],
		]) assert.ok(!scrub(input).includes(secret), `${input} -> ${scrub(input)}`);
		// Sol review P1: expansions and substitutions can carry the literal; quoted curl credentials keep only the user name.
		for (const [input, secret] of [["PGPASSWORD=${PGPASSWORD:-fakePassword123} psql", "fakePassword123"], ["API_TOKEN=$(printf fakeToken123) x", "fakeToken123"],
			["PASSWORD=${UNSET:=fakePw456} x", "fakePw456"], ["TOKEN=`echo fakeTok789` x", "fakeTok789"], ["GH_TOKEN=$(gh auth token) gh api", "gh auth token"],
			['curl -u "alice:fakePassword123" https://x', "fakePassword123"], ["curl -u 'alice:fakePw2' https://x", "fakePw2"], ["curl --user=alice:fakePw3 https://x", "fakePw3"]]) {
			assert.ok(!scrub(input).includes(secret), `${input} -> ${scrub(input)}`);
			if (input.startsWith("curl")) assert.ok(scrub(input).includes("alice:"), "the user name stays");
		}
		for (const kept of ["TOKEN=$(cat ~/.tok) gh api", "TOKEN=$(<~/.tok) gh api", "X=${TOKEN} y", 'curl -u "alice:$PW" https://x', "API_KEY=\"$(cat file)\" x", "GH_TOKEN=$GH_TOKEN_WORK gh", "curl -H \"Authorization: Bearer $TOKEN\" x", "GH_TOKEN=… gh pr list",
			"mkdir -p dir", "ssh -p 22 host", "psql -p 5433", "repo_key: github.com/o/r"]) assert.equal(scrub(kept), kept);
		for (const s of ["AWS_SECRET_ACCESS_KEY=abcd1234 x", "TOKEN=$(cat /home/alice/t)"]) assert.equal(scrub(scrub(s)), scrub(s), "scrubbing twice changes nothing");
		assert.equal(scrub("TOKEN=$(cat /home/alice/t)"), "TOKEN=$(cat ~/t)", "a reference stays, its path is still scrubbed");
		assert.ok(scrub(`GH_TOKEN=${"x".repeat(250)}`).length < 250);
	});

	it("stays linear on long runs that look almost like secrets", () => {
		const started = Date.now();
		for (const s of ["a-".repeat(100_000), "--a-".repeat(50_000), "key=".repeat(50_000), `mysql ${"a ".repeat(100_000)}`]) scrub(s);
		assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
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
		assert.equal(codex.v, 2);
		assert.deepEqual(codex.commands.map((c) => [c.status, c.exit]), [["failed", 127], ["unknown", null], ["ok", 0]]);
		assert.deepEqual(codex.commands[0].err, ["sh: vitest: command not found"]);
		assert.equal(Object.values(codex.files).flat().length, 2, "an apply_patch call and one inside a shell command both count");
		assert.equal(codex.session, `codex:${sha12("s1")}`, "client:sha256(session id)[0:12], as capture names it");

		const u = (id, command) => L({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
		const result = (id, content, is_error, toolUseResult = { stdout: "" }) => L({ type: "user", toolUseResult, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
		const first = commandDigest("claude-code", [u("t1", "make"), u("t2", "ls"), u("t3", "rm x"), u("t4", "long-job"), result("t2", "ok", false), result("t3", "Permission denied", true, "Error")],
			{ repoKey: key, session: "s2", cwd });
		assert.deepEqual(first.commands.map((c) => c.status), ["pending", "ok", "error", "pending"]);
		const later = commandDigest("claude-code", [result("t1", "Exit code 2\nmake: *** [all] Error 2", true, "Error"), result("t4", "Command running in background with ID: x", false, { backgroundTaskId: "x" }),
			result("t9", "Exit code 1\nnever called here", true, "Error")], { repoKey: key, session: "s2", cwd, prior: first });
		const merged = mergeDigest(first, later);
		assert.deepEqual(merged.commands.map((c) => [c.cmd, c.status, c.exit]), [["make", "failed", 2], ["ls", "ok", null], ["rm x", "error", null], ["long-job", "unknown", null]],
			"a result whose call was never seen has no directory, so it is not attributed");
		assert.equal(commandDigest("codex", [], { repoKey: null, session: "s" }), null, "no repo key and no resolver, no digest");
	});

	it("attributes each command to the checkout of its own directory: recorded cwd, then leading cd steps; else it is unattributed", async () => {
		const { pairResolver } = await import("./facts.mjs");
		const A = checkout("a", "https://github.com/o/a.git"), B = checkout("b", "git@github.com:o/b.git"), C = plainDir("plain"), G = checkout("g", "https://gitlab.com/o/g.git");
		fs.mkdirSync(path.join(A, "pkg"));
		const lines = [use("1", "npm test", A), use("2", "cd ../b && make", A), use("3", "cd pkg && ls", A), use("4", "ls", C), use("5", "ls", G), use("6", "cd $X && ls", A),
			use("7", "make", path.join(tmp, "gone"))].map((obj) => ({ obj }));
		const d = commandDigest("claude-code", lines, { session: "s", cwd: A, pairAt: pairResolver() });
		const keyOf = (c) => d.pairs[c.pair].key;
		assert.deepEqual(d.commands.map((c) => [c.cmd, keyOf(c)]), [["npm test", "github.com/o/a"], ["cd ../b && make", "github.com/o/b"], ["cd pkg && ls", "github.com/o/a"]]);
		assert.equal(d.other.length, 4, "a plain directory, a non-GitHub origin, a variable cd and a missing directory are unattributed");
		assert.deepEqual(Object.values(d.pairs).map((p) => p.path).sort(), [real(A), real(B)], "the checkout path is git's toplevel");
		const later = commandDigest("claude-code", [{ obj: res("4", "Exit code 1\nboom", true) }], { session: "s", cwd: A, prior: d, pairAt: pairResolver() });
		assert.equal(mergeDigest(d, later).commands.length, 3, "an unattributed call's later result is not taken up");
		// Sol review P1: a wrapped script's own leading cd counts; a script that changes directory again is ambiguous and unattributed.
		const wrapped = commandDigest("claude-code", [`rtk proxy sh -c 'cd ${B} && pytest'`, `bash -lc "cd ../b && make"`, `env FOO=1 sh -c 'cd ../b && make'`, "rtk proxy env -u GH_TOKEN npm test",
			"npm test && cd ../b && make", "git -C ../b status", "(cd ../b && make)", "rtk git -C ../b log"].map((c, i) => ({ obj: use(`w${i}`, c, A) })), { session: "w", cwd: A, pairAt: pairResolver() });
		assert.deepEqual(wrapped.commands.map((c) => [c.cmd, wrapped.pairs[c.pair].key]), [[`rtk proxy sh -c 'cd ${B} && pytest'`.replace(B, scrub(B)), "github.com/o/b"],
			[`bash -lc "cd ../b && make"`, "github.com/o/b"], ["env FOO=1 sh -c 'cd ../b && make'", "github.com/o/b"], ["rtk proxy env -u GH_TOKEN npm test", "github.com/o/a"]]);
		assert.equal(wrapped.other.length, 4, "later cd, git -C and a subshell cd are ambiguous");
		const codex = commandDigest("codex", [{ obj: { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "x", cwd: `file://${B}`, command: ["/bin/zsh", "-lc", "ls"], exit_code: 0 } } } }],
			{ session: "s", cwd: A, pairAt: pairResolver() });
		assert.equal(codex.pairs[codex.commands[0].pair].key, "github.com/o/b", "a Codex item's file:// cwd wins over the session directory");
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
		assert.equal(Object.values(current.files).flat().length, 1);
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
	it("splits a two-repo session into one report per partition with a shared order, usage only where it started, and routes by raw remote and path", async () => {
		const A = checkout("a", "https://tok@github.com/o/a.git"), B = checkout("b", "git@github.com:o/b.git"), C = plainDir("plain");
		const reads = [], read = { facts: async (b) => { reads.push(b); return { profile: b.repo.path === real(B) ? "personal" : "work", routed_by: "rule", facts: [] }; } };
		const sent = [], server = ingest(sent, { profileOf: (b) => (b.repo.path === real(B) ? "personal" : "work") });
		const file = transcript([use("1", "vitest run", A, USAGE), res("1", "Exit code 127\nzsh: command not found: vitest", true), use("2", "npx vitest run", A, USAGE), res("2", "ok", false),
			use("3", "cd ../b && make", A, USAGE), res("3", "Exit code 2\nmake: *** No rule. Stop.", true), use("4", "ls", C, USAGE), res("4", "x", false),
			use("5", "AWS_SECRET_ACCESS_KEY=abcd1234 vitest run", A, USAGE), res("5", "Exit code 127\nzsh: command not found: vitest", true)]);
		// Claude Code writes one line per content block and repeats the message's usage on each: this text block must not count again.
		fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", timestamp: at(), cwd: A, message: { id: "m-5", content: [{ type: "text", text: "done" }], usage: USAGE } })}\n`);
		const t = { client: "claude-code", session: "two", cwd: A };
		assert.equal((await fc.observeSession(t, file, null, { server, ended: false, config: config(), read })).status, "open");
		assert.equal(sent.length, 0, "a session that has not ended never reports");
		const done = await fc.observeSession(t, file, null, { server, ended: true, config: config(), read });
		assert.deepEqual([done.completed, done.status, done.session], [true, "sent", `claude-code:${sha12("two")}`]);
		const [a, b] = ["github.com/o/a", "github.com/o/b"].map((k) => bodies(sent).find((x) => x.repo_key === k));
		assert.deepEqual(a.repo, { remote: "https://github.com/o/a.git", path: real(A) }, "raw remote without credentials, and the checkout toplevel");
		assert.deepEqual(b.repo, { remote: "git@github.com:o/b.git", path: real(B) });
		assert.deepEqual(a.facts.order, b.facts.order, "every report of a session shares its order");
		assert.match(a.facts.order.ended_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		assert.ok(Number.isInteger(a.facts.order.seq) && a.facts.order.seq >= 1);
		assert.deepEqual(a.facts.usage, { input: 575, cached_input: 500, output: 35, cache_write: 25 }, "5 messages; a repeated message line counts once");
		assert.equal(b.facts.usage, undefined, "usage only in the partition where the session started");
		assert.deepEqual(a.facts.commands, { total: 3, failed: 2, repeated_failures: 1 });
		assert.deepEqual(b.facts.commands, { total: 1, failed: 1, repeated_failures: 0 });
		for (const x of [a, b]) {
			assert.equal(x.facts.v, 2);
			assert.ok(!("profile" in x) && !("statement" in (x.facts.observations[0] ?? {})) && !("fired" in x.facts));
		}
		assert.ok(a.facts.observations.some((o) => o.detector === "form_repair"), "the session's repair is observed in its own repo");
		assert.ok(!sent.join("").includes("abcd1234") && !sent.join("").includes("tok@"), "no secret is uploaded");
		const machine = machineId(am.home());
		assert.deepEqual(reads, [{ repo: { remote: "https://github.com/o/a.git", path: real(A) }, repo_key: "github.com/o/a", machine, mode: "inject" },
			{ repo: { remote: "git@github.com:o/b.git", path: real(B) }, repo_key: "github.com/o/b", machine, mode: "inject" }], "one injection read per pair without a cached route");
		assert.deepEqual([a.facts.machine, b.facts.machine], [machine, machine], "every v2 report names this machine (facts.machine, src/api.ts factsV2)");
		assert.ok(!("machine" in a), "the outer report body is strict: machine is never top level");
		const status = fc.factsStatus();
		assert.equal(status.unattributed_commands_7d, 1, "the plain-directory command is counted, never reported");
		assert.deepEqual(fc.pendingReportSummary().partitions.map((p) => [p.profile, p.repo_key, p.sent]).sort(), [["personal", "github.com/o/b", 1], ["work", "github.com/o/a", 1]]);
		const again = await fc.observeSession(t, file, null, { server, ended: true, config: config(), read });
		assert.deepEqual([again.completed, sent.length], [false, 2], "a built session is never built or sent again");
	});

	it("resends the saved bytes after a network failure and settles 409 report_conflict, 400, 410 and 413 without retrying", async () => {
		const A = checkout("a", "https://github.com/o/r.git"), read = { facts: async () => ({ profile: "work", facts: [] }) };
		const attempts = [];
		let down = true;
		const flaky = { facts: async (bytes) => { attempts.push(bytes); if (down) { down = false; throw Object.assign(new Error("offline"), { status: 503 }); } return ingest([]).facts(bytes); } };
		assert.equal((await codexSession("s1", A, { server: flaky, read })).status, "pending");
		assert.ok(fc.hasPending());
		assert.deepEqual(await fc.flushPending(flaky, { config: config(), read }), { sent: 1, pending: 0, refused: 0, conflicts: 0, stale: 0 });
		assert.equal(attempts[1], attempts[0], "the resend is the saved bytes");
		for (const [status, reason, outcome] of [[409, "report_conflict", "conflicts"], [400, "invalid_body", "refused"], [410, null, "refused"], [413, null, "refused"]]) {
			const calls = [], server = failing(status, reason, calls);
			await codexSession(`f${status}`, A, { server, read });
			const before = fc.pendingReportSummary();
			assert.deepEqual(await fc.flushPending(server, { config: config(), read }), { sent: 0, pending: 0, refused: 0, conflicts: 0, stale: 0 }, `${status} is final`);
			assert.equal(calls.length, 1, `${status} is not retried`);
			assert.equal(before.pending, 0);
			assert.ok(before[outcome] >= 1, `${status} counts as ${outcome}`);
		}
		assert.equal(fc.factsStatus().conflicts, 1);
		await codexSession("stale", A, { server: ingest([], { report: "stale" }), read });
		assert.equal(fc.pendingReportSummary().stale, 1, "a stale reply is settled");
		assert.ok(!fc.hasPending());
	});

	it("learns an unknown pair's profile from the ingest reply, then reuses the cached route, and keeps a forgotten fact out of the registry", async () => {
		const A = checkout("a", "https://github.com/o/r.git"), reads = [];
		const offline = { facts: async (b) => { reads.push(b); throw Object.assign(new Error("read_token_missing"), { code: "read_token_missing" }); } };
		const sent = [], forgot = factKey("unavailable_tool", "vitest");
		assert.equal((await codexSession("u1", A, { server: ingest(sent, { refuse: { [forgot]: "fact_forgotten" } }), read: offline })).status, "sent", "a report is sent without a known route");
		const part = partitionId("work", "github.com/o/r");
		assert.deepEqual(fc.partitions().map((p) => [p.id, p.profile, p.repo_key]), [[part, "work", "github.com/o/r"]], "the reply named the partition");
		assert.ok(!fc.known(part).some((f) => f.literal === "vitest"), "a forgotten fact is dropped locally");
		assert.ok(fc.known(part).some((f) => f.detector === "form_repair"), "a stored fact is known for later sessions");
		assert.equal(fc.recentDigests(part).length, 1, "the settled digest is retained in its partition");
		await codexSession("u2", A, { server: ingest(sent), read: offline });
		assert.equal(reads.length, 1, "the second session uses the cached route");
		assert.equal(bodies(sent).at(-1).facts.observations.find((o) => o.fact_key === forgot)?.kind, "confirm", "a forgotten fact is not suppressed locally");
	});

	it("moves only the re-routed checkout's evidence when one path of a repo changes profile, and keeps the other path's history", async () => {
		const A1 = checkout("a1", "https://github.com/o/r.git"), A2 = checkout("a2", "https://github.com/o/r.git");
		let rule = () => "personal";
		const sent = [], server = ingest(sent, { profileOf: (b) => rule(b) }), read = { facts: async (b) => ({ profile: rule({ repo: b.repo }), facts: [] }) };
		await codexSession("p1", A1, { server, read });
		await codexSession("p2", A2, { server, read, cmds: [["git fetch", 128, "fatal: Could not resolve host: github.com"]] });
		const personal = partitionId("personal", "github.com/o/r"), work = partitionId("work", "github.com/o/r");
		assert.ok(fc.known(personal).some((f) => f.detector === "network") && fc.known(personal).some((f) => f.literal === "vitest"), "both paths share one partition");
		rule = (b) => (b.repo.path === real(A2) ? "work" : "personal");
		await codexSession("p3", A2, { server, read, cmds: [["ls", 0]] });
		assert.ok(fc.known(personal).some((f) => f.literal === "vitest"), "the path still routed to personal keeps its facts");
		assert.ok(!fc.known(personal).some((f) => f.detector === "network"), "the re-routed path's fact left personal");
		assert.ok(fc.known(work).some((f) => f.detector === "network"), "and arrived in work");
		assert.deepEqual(fc.recentDigests(personal).map((d) => d.session), [`codex:${sha12("p1")}`]);
		assert.deepEqual(fc.recentDigests(work).map((d) => d.session).sort(), [`codex:${sha12("p2")}`, `codex:${sha12("p3")}`].sort());
		await codexSession("p4", A1, { server, read });
		assert.equal(bodies(sent).at(-1).repo.path, real(A1));
		assert.ok(fc.known(personal).some((f) => f.literal === "vitest"));
	});

	it("records provenance per observation: one session over two paths of a repo, then rerouting one path moves only that path's facts", async () => {
		const A1 = checkout("a1", "https://github.com/o/r.git"), A2 = checkout("a2", "https://github.com/o/r.git");
		let rule = () => "personal";
		const sent = [], server = ingest(sent, { profileOf: (b) => rule(b) }), read = { facts: async (b) => ({ profile: rule({ repo: b.repo }), facts: [] }) };
		const file = transcript([use("1", "vitest run", A1), res("1", "Exit code 127\nzsh: command not found: vitest", true), use("2", "npx vitest run", A1), res("2", "ok", false),
			use("3", "git fetch", A2), res("3", "Exit code 128\nfatal: Could not resolve host: github.com", true)]);
		await fc.observeSession({ client: "claude-code", session: "both", cwd: A1 }, file, null, { server, ended: true, config: config(), read });
		assert.equal(sent.length, 1, "both paths route to one partition, so one report");
		const personal = partitionId("personal", "github.com/o/r"), work = partitionId("work", "github.com/o/r");
		rule = (b) => (b.repo.path === real(A2) ? "work" : "personal");
		await codexSession("later", A2, { server, read, cmds: [["ls", 0]] });
		assert.deepEqual(fc.known(work).map((f) => f.detector).sort(), ["network"], "only the fact A2's own commands produced moved");
		assert.ok(fc.known(personal).some((f) => f.literal === "vitest") && !fc.known(personal).some((f) => f.detector === "network"), "A1's facts stay in personal");
	});

	it("names this machine with one stable random id, created once, private", () => {
		const a = machineId(am.home()), b = machineId(am.home()), file = path.join(am.home(), "facts", "machine");
		assert.match(a, /^[0-9a-f]{32}$/, "src/api.ts MACHINE");
		assert.equal(b, a, "stable across calls");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.ok(![os.hostname(), os.userInfo().username].some((x) => a.includes(x.toLowerCase().slice(0, 6))), "not derived from host or user");
		process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`);
		assert.notEqual(machineId(am.home()), a, "another install gets its own id");
	});

	it("keeps a learned fact's signature and class when a later report is settled, so it can be confirmed again", async () => {
		const { learnedLiteral } = await import("./facts-detect.mjs");
		const A = checkout("a", "https://github.com/o/r.git"), read = { facts: async () => ({ profile: "work", facts: [] }) }, sent = [];
		await codexSession("l0", A, { server: ingest(sent), read, cmds: [["ls", 0]] });
		const part = partitionId("work", "github.com/o/r"), signature = { head: "pytest", scope: ["pytest"], confirm: ["no module named"], contradict: [] };
		const literal = learnedLiteral(signature, "repo"), key = factKey("learned", literal);
		fc.rememberProposals(part, [{ detector: "learned", literal, signature, class: "repo" }]);
		for (const id of ["l1", "l2"]) {
			await codexSession(id, A, { server: ingest(sent), read, cmds: [["pytest", 1, "ModuleNotFoundError: No module named 'x'"]] });
			assert.equal(bodies(sent).at(-1).facts.observations.find((o) => o.fact_key === key)?.kind, "confirm", `${id} confirms the learned fact`);
			assert.deepEqual(fc.known(part).find((f) => f.detector === "learned"), { detector: "learned", literal, signature, class: "repo" });
		}
	});

	it("rebuilds a pending v1 report from its transcript, and sends one without a transcript as its v1 bytes unchanged", async () => {
		const A = checkout("a", "https://github.com/o/r.git"), read = { facts: async () => ({ profile: "work", facts: [] }) };
		const sessions = path.join(am.home(), "facts", "sessions");
		fs.mkdirSync(sessions, { recursive: true });
		const v1 = (bytes) => JSON.stringify({ v: 1, repo_key: "github.com/o/r", remote: "github.com/o/r", root: A, read_to: 1, digest: {}, report: { bytes, status: "pending" } });
		const legacy = JSON.stringify({ repo: { remote: "github.com/o/r" }, repo_key: "github.com/o/r", facts: { session: "codex:000000000001", families: [], fired: [], observations: [] } });
		fs.writeFileSync(path.join(sessions, "codex-old.json"), v1(legacy));
		const src = rollout(path.join(tmp, `rollouts-${n}`, "s-v1.jsonl"), { id: "s-v1", cwd: A, cmds: VITEST });
		am.writePrivate(am.statePath("codex", "s-v1"), JSON.stringify({ source: { transcript_path: src, cwd: A } }));
		fs.writeFileSync(path.join(sessions, "codex-s-v1.json"), v1("{\"stale\":true}"));
		assert.equal(fc.pendingReportSummary().pending_v1, 2);
		const sent = [];
		assert.deepEqual(await fc.flushPending(ingest(sent), { config: config(), read }), { sent: 2, pending: 0, refused: 0, conflicts: 0, stale: 0 });
		assert.ok(sent.includes(legacy), "the v1 bytes are sent unchanged as legacy evidence");
		const rebuilt = bodies(sent).find((b) => b.facts.v === 2);
		assert.equal(rebuilt.facts.session, `codex:${sha12("s-v1")}`);
		assert.ok(!sent.includes("{\"stale\":true}"), "a rebuilt report replaces its v1 bytes");
		assert.equal(fc.pendingReportSummary().pending_v1, 0);
		fs.writeFileSync(path.join(sessions, "codex-c.json"), v1("{\"x\":1}"));
		await fc.flushPending(failing(409, "report_conflict"), { config: config(), read });
		assert.equal(fc.pendingReportSummary().conflicts_v1, 1, "a v1 409 report_conflict is settled");
	});

	it("reports what the session-start items did: fact outcomes from facts-detect, briefing memories by memory_id", async () => {
		const A = checkout("a", "https://github.com/o/r.git"), sent = [];
		const brief = { brief: async () => ({ profile: "work", routed_by: "rule", text: "Agent Memory brief", items: [
			{ id: factKey("unavailable_tool", "vitest"), kind: "repo_fact", profile: "work", line: "-", fact: { detector: "unavailable_tool", literal: "vitest", class: "environment", tier: "repo" } },
			{ id: factKey("network", "api.example.com"), kind: "repo_fact", profile: "work", line: "-", fact: { detector: "network", literal: "api.example.com", class: "environment", tier: "repo" } },
			{ id: "mem-1", kind: "rule", profile: "work", line: "-" }, { id: "mem-me", kind: "rule", profile: "me", line: "-" }] }), facts: async () => ({ profile: "work", facts: [] }) };
		known(A, "https://github.com/o/r.git", "github.com/o/r");
		assert.ok(await injectFacts("codex", JSON.stringify({ hook_event_name: "SessionStart", cwd: A, session_id: "inj" }), { config: config(), read: brief }));
		await codexSession("inj", A, { server: ingest(sent), read: brief });
		assert.deepEqual(bodies(sent)[0].facts.injected, [
			{ kind: "fact", fact_key: factKey("unavailable_tool", "vitest"), outcome: "fired" },
			{ kind: "fact", fact_key: factKey("network", "api.example.com"), outcome: "unexercised" },
			{ kind: "memory", memory_id: "mem-1", outcome: "unexercised" }], "another profile's (me) items are not this partition's");
	});

	it("takes injected outcomes from facts-detect outcomes(): a contradiction or a key-only fact is never counted as prevented by the client", () => {
		const slice = { commands: [cmd("ls")], files: [], session: "codex:000000000001", dropped: 0 };
		const net = { kind: "fact", fact_key: factKey("network", "api.example.com"), detector: "network", literal: "api.example.com" };
		const contradiction = [{ fact_key: net.fact_key, kind: "contradict", detector: "network", literal: "api.example.com" }];
		assert.deepEqual(fc.injectedOutcomes(slice, [net], contradiction), outcomes(slice, [net]), "the detector's outcome, not the client's guess");
		assert.equal(fc.injectedOutcomes(slice, [net], contradiction)[0].outcome, "unexercised");
		assert.equal(fc.injectedOutcomes(slice, [{ kind: "fact", fact_key: "0123456789abcdef" }], [{ fact_key: "0123456789abcdef", kind: "contradict" }])[0].outcome, "unexercised");
		assert.equal(fc.injectedOutcomes(slice, [{ kind: "fact", fact_key: "0123456789abcdef" }], [{ fact_key: "0123456789abcdef", kind: "confirm" }])[0].outcome, "fired");
		const ran = { ...slice, commands: [cmd("curl -fsS https://api.example.com/health")] };
		assert.deepEqual(fc.injectedOutcomes(ran, [net], []), outcomes(ran, [net]));
	});
});

describe("session-start briefing", () => {
	const start = (cwd, session_id = "s") => JSON.stringify({ hook_event_name: "SessionStart", cwd, session_id });

	it("asks /v1/brief, falls back to /v1/facts on 404, prints the server's block unchanged, and prints nothing when off, refused or tokenless", async () => {
		const A = checkout("a", "https://tok@github.com/o/r.git"), calls = [];
		const block = "<repo-facts source=\"agent-memory\">\nObserved in past sessions in this repo.\n- `vitest` is not available.\n</repo-facts>";
		const read = { brief: async (b) => { calls.push(["brief", b]); throw Object.assign(new Error("HTTP 404"), { status: 404 }); },
			facts: async (b) => { calls.push(["facts", b]); return { profile: "work", routed_by: "rule", facts: [], block }; } };
		known(A, "https://github.com/o/r.git", "github.com/o/r");
		assert.equal(await injectFacts("codex", start(A), { config: am.withDefaults({}), read }), null, "off by default");
		assert.equal(calls.length, 0);
		const out = JSON.parse(await injectFacts("claude-code", start(A), { config: config(), read }));
		assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } });
		const route = { repo: { remote: "https://github.com/o/r.git", path: real(A) }, repo_key: "github.com/o/r", machine: machineId(am.home()) };
		assert.deepEqual(calls, [["brief", { ...route, client: "claude-code", cwd: A }], ["facts", { ...route, mode: "inject" }]]);
		const briefed = JSON.parse(await injectFacts("codex", start(A), { config: config(), read: { brief: async () => ({ profile: "work", text: "Agent Memory brief\n- x", items: [] }), facts: read.facts } }));
		assert.equal(briefed.hookSpecificOutput.additionalContext, "Agent Memory brief\n- x");
		assert.equal(await injectFacts("codex", start(A), { config: config(), read: { facts: async () => { throw Object.assign(new Error("HTTP 403"), { status: 403 }); } } }), null);
		assert.equal(await injectFacts("codex", start(A), { config: { ...config(), read_token_file: path.join(tmp, "missing-token"), server: "https://memory.invalid" } }), null);
		assert.equal(await injectFacts("codex", start(plainDir("plain")), { config: config(), read }), null, "no GitHub origin");
		const legacy = JSON.parse(factsOutput([{ statement: "Fact one." }])).hookSpecificOutput.additionalContext;
		assert.ok(legacy.length <= FACTS_INJECT.tokens * 4 && legacy.endsWith("- Fact one."), "a pre-v2 reply without a block keeps the old bounded list");
	});

	it("trusts a cached directory only while it is the same checkout with the same origin, else resolves it again", async () => {
		const A = checkout("a", "https://github.com/o/old.git"), bodiesSeen = [];
		const read = { facts: async (b) => { bodiesSeen.push(b.repo_key); return { profile: "work", facts: [], block: "<repo-facts>\n</repo-facts>" }; } };
		known(A, "https://github.com/o/old.git", "github.com/o/old");
		await injectFacts("codex", start(A), { config: config(), read });
		setOrigin(A, "https://github.com/o/new.git");
		await injectFacts("codex", start(A), { config: config(), read });
		const sub = path.join(A, "sub");
		fs.mkdirSync(sub);
		known(sub, "https://github.com/o/new.git", "github.com/o/new");
		checkout("nested", "https://github.com/o/nested.git", sub);
		await injectFacts("codex", start(sub), { config: config(), read });
		assert.deepEqual(bodiesSeen, ["github.com/o/old", "github.com/o/new", "github.com/o/nested"], "a changed origin or a newer nested checkout is never served from the cache");
	});

	it("returns within its deadline when git is slow, kills it, and writes nothing after the deadline", async () => {
		const A = checkout("slow", "https://github.com/o/r.git"), facts = path.join(am.home(), "facts");
		let called = false;
		const read = { facts: async () => { called = true; return { profile: "work", facts: [], block: "<repo-facts>\n</repo-facts>" }; } };
		process.env.FAKE_GIT_SLEEP = "2";
		const started = Date.now();
		assert.equal(await injectFacts("codex", start(A, "late"), { config: config({ timeout_ms: 300 }), read }), null);
		const took = Date.now() - started;
		assert.ok(took < 800, `returned after ${took} ms`);
		await new Promise((r) => setTimeout(r, 2500));
		assert.equal(called, false, "no read after the deadline");
		const written = fs.existsSync(facts) ? fs.readdirSync(facts) : [];
		assert.deepEqual(written, ["inject"], "only the timeout line is written; no route, directory or injected-item file");
		assert.match(fs.readFileSync(path.join(facts, "inject", fs.readdirSync(path.join(facts, "inject"))[0]), "utf8"), /"outcome":"timeout"/);
		known(A, "https://github.com/o/r.git", "github.com/o/r");
		const cachedStart = Date.now();
		assert.ok(await injectFacts("codex", start(A, "cached"), { config: config({ timeout_ms: 1500 }), read }), "a known directory needs no git at all, slow or not");
		assert.ok(Date.now() - cachedStart < 1500);
	});
});
