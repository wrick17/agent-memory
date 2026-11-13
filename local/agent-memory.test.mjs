// node --test local/ : the local capture client against recorded fixtures, stub model runners and an in-memory server that
// follows the /v1/ingest contract (the real server contract is tested in test/capture.test.ts). Probe tests use the real
// `codex sandbox` when it is installed on macOS.
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The status report and doctor ask launchd whether the batch job is loaded (launchd.mjs). No test runs the real launchctl:
// every launchctl call in this process, by name or by path, is recorded here and answered "not loaded".
const launchctlCalls = [], realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (cmd, args, ...rest) {
	if (path.basename(String(cmd)) !== "launchctl") return realSpawnSync.call(this, cmd, args, ...rest);
	launchctlCalls.push(args);
	return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: 1, signal: null };
};
syncBuiltinESMExports();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-local-test-"));
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const am = await import("./agent-memory.mjs");
const { batch } = await import("./batch.mjs");
// The file stops here unless the module's launchctl check reaches the recorder above.
assert.equal((await import("./launchd.mjs")).launchdLoaded("com.agent-memory.guard", { platform: "darwin" }), false);
assert.deepEqual(launchctlCalls.splice(0), [["print", `gui/${process.getuid()}/com.agent-memory.guard`]]);
const sha = (s) => createHash("sha256").update(s).digest("hex");
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); launchctlCalls.length = 0; });
// Only the read-only check of this test home's job label ever reaches launchctl.
afterEach(() => { for (const a of launchctlCalls) assert.deepEqual(a, ["print", `gui/${process.getuid()}/com.agent-memory.batch.test`]); });

/** The /v1/ingest and /v1/capture contract in memory, with switches to simulate a crash or an outage. */
function fakeServer() {
	const parts = new Map(), manifests = new Map(), log = [];
	const s = { parts, manifests, log, failAfter: Infinity, offline: false, calls: 0 };
	s.ingest = async (batch) => {
		if (s.offline || s.calls++ >= s.failAfter) throw new Error("network down");
		log.push(JSON.parse(JSON.stringify(batch)));
		const out = [];
		for (const d of batch.digests) {
			const key = `${d.range_id}|${d.capture_status}|${d.part_id}`;
			if (sha(d.body) !== d.sha256 || Buffer.byteLength(d.body) > 8192) { out.push({ status: "refused", reason: "invalid" }); continue; }
			const prior = parts.get(key);
			if (prior) { out.push({ status: prior.sha256 === d.sha256 ? "replayed" : "refused", reason: prior.sha256 === d.sha256 ? undefined : "hash_conflict" }); continue; }
			parts.set(key, { sha256: d.sha256, body: d.body });
			out.push({ status: "stored" });
		}
		for (const m of batch.manifests) {
			const [, a, b] = /(\d+)-(\d+)$/.exec(m.range_id).map(Number);
			const sorted = [...m.parts].sort((x, y) => Number(x.part_id.split("-")[0]) - Number(y.part_id.split("-")[0]));
			let at = a, ok = sorted.length > 0;
			for (const p of sorted) {
				const [x, y] = p.part_id.split("-").map(Number);
				const held = parts.get(`${m.range_id}|consolidated|${p.part_id}`);
				if (x !== at || !held || held.sha256 !== p.sha256 || JSON.parse(held.body).dropped.corrections || JSON.parse(held.body).dropped.decisions) ok = false;
				at = y;
			}
			if (!ok || at !== b) { out.push({ status: "refused", reason: "not_tiled" }); continue; }
			manifests.set(m.range_id, sorted);
			out.push({ status: "stored" });
		}
		return out;
	};
	s.state = async (ids) => {
		if (s.offline) throw new Error("network down");
		return Object.fromEntries(ids.map((id) => [id, { parts: [...parts.entries()].filter(([k]) => k.startsWith(`${id}|consolidated|`)).map(([k, v]) => ({ part_id: k.split("|")[2], sha256: v.sha256 })), consolidated: manifests.has(id) }]));
	};
	s.storedText = () => [...parts.values()].map((p) => p.body).join("\n");
	return s;
}

/** A model stand-in that keeps every owner sentence and assistant decision, and every literal, as an honest pass would. */
function keepAllRunner() {
	const r = { calls: 0, available: true };
	r.run = async (sub) => {
		r.calls++;
		const part = { asks: [], decisions: [], corrections: [], outcomes: { commits: [], prs: [], tests: [] }, entities: am.literals(sub.messages), dropped: { asks: 0, decisions: 0, corrections: 0 } };
		for (const m of sub.messages) {
			for (const s of m.text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean)) (m.role === "owner" ? part.corrections : part.decisions).push({ text: s.slice(0, 280), pos: m.pos });
		}
		return { kind: "ok", part };
	};
	return r;
}
const fixedRunner = (out) => ({ available: true, calls: 0, async run() { this.calls++; return out; } });

const claudeLine = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra }) + "\n";
const codexLine = (type, message) => JSON.stringify({ type: "event_msg", payload: { type, message } }) + "\n";
function transcript(name, lines) {
	const f = path.join(tmp, `${name}-${n}.jsonl`);
	fs.writeFileSync(f, lines.join(""));
	return f;
}
const trigger = (client, session, transcript_path, cwd = tmp) => ({ client, session, transcript_path, cwd, at: 0, first_at: 0 });

describe("hook", () => {
	it("writes a trigger file with no network I/O and ignores bad input", () => {
		const t0 = performance.now();
		am.hook("codex", JSON.stringify({ hook_event_name: "Stop", session_id: "thr_1", transcript_path: null, cwd: "/w", turn_id: "t1", last_assistant_message: "secret answer" }), { spawnRun: false });
		assert.ok(performance.now() - t0 < 100);
		const q = path.join(am.home(), "queue", "codex-thr_1.json");
		const t = JSON.parse(fs.readFileSync(q, "utf8"));
		assert.equal(t.turn_id, "t1");
		assert.ok(!JSON.stringify(t).includes("secret answer"));
		assert.equal(fs.statSync(q).mode & 0o777, 0o600);
		am.hook("codex", "not json", { spawnRun: false });
		am.hook("other-client", "{}", { spawnRun: false });
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "queue")), ["codex-thr_1.json"]);
	});
});

describe("origin", () => {
	it("searches for a missing Claude transcript only under the client home the hook ran in, whichever process runs the queue", async () => {
		const office = path.join(tmp, `office-${n}`), personal = path.join(tmp, `personal-${n}`), session = `origin-${n}`;
		for (const [dir, text] of [[office, "OFFICE canary"], [personal, "PERSONAL canary"]]) {
			fs.mkdirSync(path.join(dir, ".claude", "projects", "p"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".claude", "projects", "p", `${session}.jsonl`), claudeLine("user", text) + claudeLine("assistant", "Noted."));
		}
		const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
		const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
		try {
			// The personal Claude client fires its hook with its own config dir; its transcript path does not exist (yet).
			process.env.CLAUDE_CONFIG_DIR = path.join(personal, ".claude");
			am.hook("claude-code", JSON.stringify({ session_id: session, transcript_path: path.join(tmp, "missing.jsonl"), hook_event_name: "Stop" }), { spawnRun: false });
			// A legacy trigger with no recorded origin for another session.
			fs.writeFileSync(path.join(am.home(), "queue", `claude-code-legacy-${n}.json`), JSON.stringify({ client: "claude-code", session: session.replace("origin", "legacy"), gen: "g", event: "Stop", transcript_path: null, cwd: null, at: 0, first_at: 0 }));
			fs.copyFileSync(path.join(office, ".claude", "projects", "p", `${session}.jsonl`), path.join(office, ".claude", "projects", "p", `${session.replace("origin", "legacy")}.jsonl`));
			// The queue is then run by a process of another client: no CLAUDE_CONFIG_DIR, and a home whose default .claude is Office.
			delete process.env.CLAUDE_CONFIG_DIR;
			process.env.HOME = office;
			const server = fakeServer();
			await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
			const text = server.storedText() + JSON.stringify(server.log);
			assert.ok(text.includes("PERSONAL canary"));
			assert.ok(!text.includes("OFFICE canary"), "the runner never reads the Office store");
			const legacy = JSON.parse(fs.readFileSync(path.join(am.home(), "state", "claude-code", `${session.replace("origin", "legacy")}.json`), "utf8"));
			assert.ok(legacy.pending_source_since && !legacy.source, "a trigger without an origin waits instead of searching");
			const st = JSON.parse(fs.readFileSync(path.join(am.home(), "state", "claude-code", `${session}.json`), "utf8"));
			assert.equal(st.source.client_home, path.join(personal, ".claude"), "the SessionStart sweep requeues with the same origin");
		} finally { restore(); }
	});
});

describe("reading", () => {
	it("reads Codex 0.166 completed turn items as owner and assistant text, and none of the injected, tool or thinking records", () => {
		const item = (type, content, extra = {}) => ({ type: "event_msg", payload: { type: "item_completed", turn_id: "t", item: { type, id: "i", content, ...extra } } });
		const msg = (role, kinds, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
			internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
		const records = [
			{ type: "session_meta", payload: { base_instructions: "BASE INSTRUCTIONS", cwd: "/w" } },
			msg("developer", ["model.base_instructions"], "DEVELOPER CONTEXT"),
			msg("user", ["agents_md.instructions", "environments.environment_context"], "# AGENTS.md instructions\nINJECTED RULES"),
			msg("user", ["user.text"], "Use the staging database."),
			{ type: "turn_context", payload: { cwd: "/w", model: "m" } },
			item("UserMessage", [{ type: "text", text: "Use the staging database.", text_elements: [] }, { type: "image", url: "x" }]),
			item("UserMessage", [{ type: "text", text: "<environment_context>INJECTED ENV</environment_context>", text_elements: [] }]),
			{ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "THINKING" }] } },
			{ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "TOOL CALL" } },
			{ type: "response_item", payload: { type: "function_call_output", output: "TOOL OUTPUT" } },
			item("Reasoning", [{ type: "text", text: "THINKING ITEM" }]),
			item("CommandExecution", [{ type: "text", text: "TOOL ITEM" }]),
			msg("assistant", ["unknown"], "Switched to staging."),
			item("AgentMessage", [{ type: "Text", text: "Switched to staging.<system-reminder>REMINDER</system-reminder>" }], { phase: "final_answer" }),
			{ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Switched to staging." } },
		];
		const got = am.extract("codex", records.map((obj, i) => ({ pos: i * 100, next: i * 100 + 100, obj })));
		assert.deepEqual(got.map((m) => [m.role, m.text]), [["owner", "Use the staging database."], ["assistant", "Switched to staging."]]);
		// The pre-0.166 event records still read the same way.
		const legacy = am.extract("codex", [{ pos: 0, next: 1, obj: { type: "event_msg", payload: { type: "user_message", message: "Old owner text." } } }]);
		assert.deepEqual(legacy.map((m) => m.text), ["Old owner text."]);
	});

	it("keeps owner and assistant text only", () => {
		const claude = transcript("claude", [
			claudeLine("user", "Please fix the loop."),
			claudeLine("assistant", [{ type: "thinking", thinking: "private chain" }, { type: "text", text: "Moving refresh to one client instead of retrying." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }]),
			claudeLine("user", [{ type: "tool_result", content: "file list output" }]),
			claudeLine("user", "<system-reminder>injected hook text</system-reminder>"),
			claudeLine("user", "meta", { isMeta: true }),
			JSON.stringify({ type: "attachment", attachment: "x" }) + "\n",
		]);
		const msgs = am.extract("claude-code", am.readLines(claude, 0).lines);
		assert.deepEqual(msgs.map((m) => [m.role, m.text]), [["owner", "Please fix the loop."], ["assistant", "Moving refresh to one client instead of retrying."]]);
		const codex = transcript("codex", [
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } }) + "\n",
			codexLine("user_message", "Use pnpm."),
			JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }) + "\n",
			JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "tool output" } }) + "\n",
			codexLine("agent_message", "Switched to pnpm."),
		]);
		assert.deepEqual(am.extract("codex", am.readLines(codex, 0).lines).map((m) => m.text), ["Use pnpm.", "Switched to pnpm."]);
	});

	it("bounds UTF-8 reference outcomes without hanging when the other lists are empty", () => {
		const text = "这是一个很长的中文段落用于说明修复登录超时的问题".repeat(20);
		const messages = Array.from({ length: 10 }, (_, i) => ({ role: "assistant", pos: i, text: `https://github.com/acme/web/pull/${i + 1} ${text}${i}\nsha ${i}a1b2c3d4e5f60718293a4b5c6d7e8f9012345${i}` }));
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import fs from "node:fs"; import { heuristicDigest } from ${JSON.stringify(new URL("./agent-memory.mjs", import.meta.url).href)}; console.log(JSON.stringify(heuristicDigest(JSON.parse(fs.readFileSync(0, "utf8")))));`], { input: JSON.stringify(messages), encoding: "utf8", timeout: 3000 });
		assert.equal(child.status, 0, child.error?.message ?? child.stderr);
		const d = JSON.parse(child.stdout);
		assert.ok(Buffer.byteLength(JSON.stringify(d)) <= am.LIMITS.part);
		assert.ok(d.outcomes.prs.length > 0 && d.outcomes.prs.length < messages.length);
		assert.equal(am.bodyProblem(d), null);
	});

	it("keeps encountered PR, ticket and commit references literally, with the assistant's sentence as context", () => {
		const f = transcript("refs", [
			codexLine("user_message", "Fix PROJ-123: the login page times out after 30 seconds. Ticket: https://acme.atlassian.net/browse/PROJ-123?focus=1"),
			codexLine("agent_message", "Opened https://github.com/acme/web/pull/42 to fix the login timeout. Pushed acme/web@0a1b2c3d4e with the shorter retry."),
		]);
		const d = am.heuristicDigest(am.extract("codex", am.readLines(f, 0).lines));
		// The same body test/capture.test.ts ingests, which links the session to the PR, ticket and commit.
		assert.deepEqual(d, {
			asks: [{ text: "Fix PROJ-123: the login page times out after 30 seconds.", pos: 0 }], decisions: [], corrections: [],
			outcomes: { commits: ["Pushed acme/web@0a1b2c3d4e with the shorter retry.", "0a1b2c3d4e"], prs: ["Opened https://github.com/acme/web/pull/42 to fix the login timeout."], tests: [] },
			entities: ["PROJ-123", "https://acme.atlassian.net/browse/PROJ-123", "https://github.com/acme/web/pull/42", "acme/web@0a1b2c3d4e"], dropped: { asks: 0, decisions: 0, corrections: 0 },
		});
		assert.equal(am.bodyProblem(d), null);
	});
});

describe("capture protocol", () => {
	it("keeps a marker-free correction pending without a runtime, then consolidates it, and acknowledges only after the manifest", async () => {
		const f = transcript("killed", [claudeLine("user", "Can you look at the retry setting?"), claudeLine("assistant", "The timeout is 30 s."), claudeLine("user", "Thanks. Use the other timeout.")]);
		const server = fakeServer();
		const t = trigger("claude-code", "sess-killed", f);
		let r = await am.processSession(t, { server, runner: null });
		assert.equal(r.consolidated_to, 0);
		const heuristic = JSON.parse(server.log[0].digests[0].body);
		assert.equal(server.log[0].digests[0].capture_status, "heuristic");
		assert.ok(!JSON.stringify(heuristic).includes("Use the other timeout"), "the keyword digest misses the marker-free correction");
		assert.equal(fs.readdirSync(path.join(am.home(), "pending")).filter((x) => x.endsWith(".txt")).length, 1);
		r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.ok(server.storedText().includes("Use the other timeout."));
		assert.equal(server.manifests.size, 1);
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "pending")), []);
	});

	it("splits 100 literal-heavy corrections over 8 KB into tiling parts that keep every literal, with no inline pass", async () => {
		const lits = Array.from({ length: 100 }, (_, i) => `cfg.key_${String(i).padStart(3, "0")}_${"x".repeat(96)}`);
		const f = transcript("literals", [claudeLine("user", lits.map((l) => `Don't use the old value; set \`${l}\` instead.`).join("\n")), claudeLine("assistant", "Noted.")]);
		const server = fakeServer();
		const r = await am.processSession(trigger("claude-code", "sess-lits", f), { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		const [range, parts] = [...server.manifests.entries()][0];
		assert.ok(parts.length > 1);
		for (const p of parts) assert.ok(Buffer.byteLength(server.parts.get(`${range}|consolidated|${p.part_id}`).body) <= 8192);
		const stored = server.storedText();
		for (const l of lits) assert.ok(stored.includes(l), `literal ${l.slice(0, 12)} kept`);
	});

	it("leaves a range stuck and pending when parts overflow, drop corrections or show a tool event", async () => {
		for (const runner of [
			fixedRunner({ kind: "ok", part: { asks: [], decisions: [], corrections: [{ text: "y".repeat(280), pos: 0 }], outcomes: {}, entities: Array(40).fill("z".repeat(250)), dropped: { asks: 0, decisions: 0, corrections: 0 } } }),
			fixedRunner({ kind: "ok", part: { asks: [], decisions: [], corrections: [], outcomes: {}, entities: [], dropped: { asks: 0, decisions: 0, corrections: 1 } } }),
			fixedRunner({ kind: "tool_event" }),
		]) {
			process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`);
			const f = transcript("stuck", [claudeLine("user", "Never squash the release commits. ".repeat(200)), claudeLine("assistant", "Understood.")]);
			const server = fakeServer();
			const r = await am.processSession(trigger("claude-code", "sess-stuck", f), { server, runner });
			assert.equal(r.consolidated_to, 0);
			assert.equal(Object.values(r.outcomes)[0], "stuck");
			assert.equal(server.manifests.size, 0);
			assert.ok(fs.readdirSync(path.join(am.home(), "pending")).some((x) => x.endsWith(".txt")), "local text kept");
		}
	});

	it("resumes after a crash mid-upload with the kept part bytes, and after losing its part files adopts the server's parts", async () => {
		const owner = Array.from({ length: 30 }, (_, i) => claudeLine("user", `Rule ${i}: always pin \`tool-${i}@1.${i}\` in CI. ${"pad ".repeat(300)}`));
		const f = transcript("crash", owner);
		const server = fakeServer();
		const runner = keepAllRunner();
		const t = trigger("claude-code", "sess-crash", f);
		server.failAfter = 1; // the heuristic digest lands, then the network drops
		let r = await am.processSession(t, { server, runner });
		assert.equal(r.consolidated_to, 0);
		const madeFirst = runner.calls;
		assert.ok(madeFirst > 1);
		server.failAfter = Infinity;
		r = await am.processSession(t, { server, runner });
		assert.equal(runner.calls, madeFirst, "accepted parts are uploaded from their kept bytes, never regenerated");
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		// A second range: two parts reach the server, then the part files are lost before the manifest.
		fs.appendFileSync(f, Array.from({ length: 30 }, (_, i) => claudeLine("user", `Later rule ${i}: never edit \`gen-${i}.ts\`. ${"pad ".repeat(300)}`)).join(""));
		const before = runner.calls;
		const realIngest = server.ingest;
		let partUploads = 0;
		server.ingest = async (batch) => {
			if (batch.manifests.length) throw new Error("network down");
			if (batch.digests.some((d) => d.capture_status === "consolidated")) partUploads++;
			return realIngest(batch);
		};
		await am.processSession(t, { server, runner });
		const firstPass = runner.calls - before;
		fs.rmSync(path.join(am.home(), "pending"), { recursive: true, force: true, filter: undefined });
		fs.mkdirSync(path.join(am.home(), "pending"), { recursive: true });
		server.ingest = realIngest;
		r = await am.processSession(t, { server, runner });
		// Losing the pending text too leaves the range stuck rather than inventing content.
		assert.ok(Object.values(r.outcomes).every((o) => o === "stuck" || o === "consolidated"));
		assert.ok(partUploads > 0 && firstPass > 0);
	});

	it("adopts the server's parts and digests only the gaps when only the part files are lost", async () => {
		const f = transcript("adopt", Array.from({ length: 24 }, (_, i) => claudeLine("user", `Note ${i}: keep \`flag-${i}\` off. ${"pad ".repeat(400)}`)));
		const server = fakeServer();
		const runner = keepAllRunner();
		const t = trigger("claude-code", "sess-adopt", f);
		const realIngest = server.ingest;
		server.ingest = async (batch) => { if (batch.manifests.length) throw new Error("network down"); return realIngest(batch); };
		await am.processSession(t, { server, runner });
		const firstCalls = runner.calls;
		const partsDir = fs.readdirSync(path.join(am.home(), "pending")).find((x) => x.endsWith(".parts"));
		fs.rmSync(path.join(am.home(), "pending", partsDir), { recursive: true });
		server.ingest = realIngest;
		const r = await am.processSession(t, { server, runner });
		assert.equal(runner.calls, firstCalls, "every span was adopted from the server");
		assert.equal(r.consolidated_to, fs.statSync(f).size);
	});

	it("uploads a range with more parts than one batch allows in batches the server accepts", async () => {
		const f = transcript("many-parts", Array.from({ length: 260 }, (_, i) => claudeLine("user", `Rule ${i}: keep \`m-${i}\` on. ${"pad ".repeat(2200)}`)));
		const server = fakeServer(), realIngest = server.ingest, sizes = [];
		server.ingest = async (batch) => {
			sizes.push(batch.digests.length);
			if (batch.digests.length > am.LIMITS.digests) throw Object.assign(new Error("HTTP 400"), { status: 400 });
			return realIngest(batch);
		};
		const r = await am.processSession(trigger("claude-code", "sess-many", f), { server, runner: keepAllRunner() });
		assert.ok(server.parts.size > am.LIMITS.digests, `${server.parts.size} parts`);
		assert.ok(sizes.every((x) => x <= am.LIMITS.digests));
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.ok(Object.values(r.outcomes).every((o) => o === "consolidated"));
	});

	it("settles a session the server refuses (HTTP 403): nothing spooled or retried, no local text kept, and replay goes past it", async () => {
		const server = fakeServer(), ingest = server.ingest, state = server.state;
		const deny = () => Promise.reject(Object.assign(new Error("HTTP 403"), { status: 403 }));
		const a = transcript("allowed-a", [claudeLine("user", "Work note for the allowed repo."), claudeLine("assistant", "Done.")]);
		const b = transcript("refused-b", [claudeLine("user", "Personal note in a refused repo."), claudeLine("assistant", "Ok.")]);
		// An outage first: both sessions' heuristic digests spool, the refused session's file first.
		server.offline = true;
		await am.processSession(trigger("claude-code", "refused-b", b), { server, runner: keepAllRunner() });
		await new Promise((r) => setTimeout(r, 5));
		await am.processSession(trigger("claude-code", "allowed-a", a), { server, runner: keepAllRunner() });
		const spoolDir = path.join(am.home(), "spool"), pendingDir = path.join(am.home(), "pending");
		assert.equal(fs.readdirSync(spoolDir).length, 2);
		// Back online, the server refuses only session b's routed profile.
		server.offline = false;
		server.ingest = (batch) => (batch.session.id === "refused-b" ? deny() : ingest(batch));
		server.state = (ids, repo) => (ids.some((id) => id.includes(":refused-b:")) ? deny() : state(ids, repo));
		am.hook("claude-code", JSON.stringify({ session_id: "refused-b", transcript_path: b, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false });
		await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		assert.deepEqual(fs.readdirSync(spoolDir), [], "the refused file is dropped and the next one replays");
		assert.ok(server.log.some((x) => x.session.id === "allowed-a" && x.digests[0]?.capture_status === "heuristic"));
		const st = JSON.parse(fs.readFileSync(path.join(am.home(), "state", "claude-code", "refused-b.json"), "utf8"));
		assert.deepEqual(Object.values(st.ranges).map((r) => [r.status, r.reason]), [["refused", "http_403"]]);
		assert.ok(!fs.readdirSync(pendingDir).some((x) => x.includes("refused-b")), "no local text is kept for a refused range");
		assert.ok(!fs.existsSync(path.join(am.home(), "queue", "claude-code-refused-b.json")), "the refused session settles");
		// A later turn in the refused session is refused at once: not spooled, not kept.
		fs.appendFileSync(b, claudeLine("user", "Another personal note."));
		const r = await am.processSession(trigger("claude-code", "refused-b", b), { server, runner: keepAllRunner() });
		assert.ok(Object.values(r.outcomes).every((o) => o === "refused"));
		assert.deepEqual(fs.readdirSync(spoolDir), []);
		assert.ok(!fs.readdirSync(pendingDir).some((x) => x.includes("refused-b")));
	});

	it("settles a Codex session with a null hook path and no rollout as ephemeral, finds the rollout if it turns up, and starts a new epoch on a rewrite", async () => {
		const codexHome = path.join(tmp, `codex-home-${n}`);
		const t = { ...trigger("codex", "thr_null", null), client_home: codexHome };
		const server = fakeServer();
		let r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.deepEqual([r.status, r.reason], ["source_missing_settled", "ephemeral"]);
		assert.equal(server.log.length, 0);
		const dir = path.join(codexHome, "sessions", "2026", "10", "28");
		fs.mkdirSync(dir, { recursive: true });
		const f = path.join(dir, "rollout-2026-10-28T10-00-00-thr_null.jsonl");
		fs.writeFileSync(f, codexLine("user_message", "Use the staging database.") + codexLine("agent_message", "Switched."));
		r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.ok(server.storedText().includes("Use the staging database."));
		const calls = server.log.length;
		r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(server.log.length, calls, "a repeated event on an unchanged transcript uploads nothing");
		fs.writeFileSync(f, codexLine("user_message", "Rewritten history.") + codexLine("agent_message", "Ok."));
		r = await am.processSession(t, { server, runner: keepAllRunner() });
		const epochs = new Set([...server.manifests.keys()].map((k) => k.split(":")[2]));
		assert.equal(epochs.size, 2);
	});

	it("never uploads or spools a whole long message", async () => {
		const long = `I want this whole paragraph kept private. ${"Detail sentence about the internal system. ".repeat(40)}`;
		const f = transcript("privacy", [claudeLine("user", long), claudeLine("assistant", `${"Long explanation. ".repeat(80)}`)]);
		const server = fakeServer();
		server.offline = true;
		await am.processSession(trigger("claude-code", "sess-priv", f), { server, runner: keepAllRunner() });
		server.offline = false;
		await am.processSession(trigger("claude-code", "sess-priv", f), { server, runner: keepAllRunner() });
		const spoolDir = path.join(am.home(), "spool");
		const spooled = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).map((x) => fs.readFileSync(path.join(spoolDir, x), "utf8")).join("") : "";
		const uploaded = JSON.stringify(server.log);
		assert.ok(spooled.length > 0, "the offline heuristic digest was spooled");
		for (const text of [uploaded, spooled]) assert.ok(!text.includes(long.trim()) && !text.includes(long.slice(0, 400)));
	});
});

describe("confined runtime", () => {
	it("classifies probes: only a permission denial without the secret is denied", () => {
		assert.equal(am.classify({ status: 1, stdout: "", stderr: "cat: x: Operation not permitted" }, "n"), "denied");
		assert.equal(am.classify({ status: 0, stdout: "home-n", stderr: "" }, "home-n"), "allowed");
		assert.equal(am.classify({ status: 1, stdout: "home-n", stderr: "Operation not permitted" }, "home-n"), "allowed");
		assert.equal(am.classify({ status: 1, stdout: "", stderr: "cat: x: No such file or directory" }, "n"), "indeterminate");
		assert.equal(am.classify({ status: 6, stdout: "", stderr: "curl: (6) Could not resolve host: example.com" }, ""), "indeterminate");
		assert.equal(am.classify({ error: new Error("ENOENT") }, ""), "indeterminate");
	});

	it("parses the exec event stream: tool items discard the run; only a final agent message is output", () => {
		const ev = (...items) => items.map((i) => JSON.stringify(i)).join("\n");
		assert.equal(am.parseEvents(ev({ type: "thread.started" }, { type: "item.completed", item: { type: "reasoning", text: "…" } }, { type: "item.completed", item: { type: "agent_message", text: "{\"a\":1}" } }, { type: "turn.completed" })).kind, "ok");
		assert.equal(am.parseEvents(ev({ type: "item.started", item: { type: "command_execution", command: "cat ~/.ssh/id_rsa" } })).kind, "tool_event");
		assert.equal(am.parseEvents(ev({ type: "item.completed", item: { type: "something_new" } })).kind, "tool_event");
		assert.equal(am.parseEvents(ev({ type: "turn.completed" })).kind, "no_output");
		assert.equal(am.parseEvents(ev({ type: "item.completed", item: { type: "error", message: "Codex is ignoring 1 unrecognized configuration setting" } }, { type: "item.completed", item: { type: "agent_message", text: "{}" } })).kind, "runtime_warning");
		assert.equal(am.parseEvents("not json").kind, "bad_events");
		// The whole stream is read: a tool after a failure or a bad line still wins, and a notice outranks a failure.
		assert.equal(am.parseEvents(ev({ type: "turn.failed" }, { type: "item.started", item: { type: "command_execution" } })).kind, "tool_event");
		assert.equal(am.parseEvents(`not json\n${JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call" } })}`).kind, "tool_event");
		assert.equal(am.parseEvents(ev({ type: "error" }, { type: "runtime.notice" })).kind, "runtime_warning");
	});

	it("is indeterminate when Codex is missing or the platform is untested", async () => {
		assert.deepEqual(await am.confinedRunner({}, { platform: "linux" }), { available: false, classification: "indeterminate", reason: "untested_platform" });
		const missing = await am.confinedRunner({ codex_home: tmp }, {});
		assert.equal(missing.available, false);
		assert.equal(missing.classification, "indeterminate");
	});

	it("proves the denial on this Mac with the real `codex sandbox`, and classifies weakened, missing and DNS probes", async (t) => {
		// Resolve the native dependency only when this test actually runs, so filtered synthetic checks launch no child.
		// The login is checked first, so under a synthetic HOME this test starts no codex child at all.
		const real = process.platform === "darwin" && fs.existsSync(path.join(os.homedir(), ".codex", "auth.json")) && spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
		if (!real) { t.skip("codex sandbox not available"); return; }
		const r = await am.confinedRunner({});
		assert.deepEqual([r.available, r.classification], [true, "denied"], r.reason);
		r.cleanup();
		const ch = fs.mkdtempSync(path.join(os.tmpdir(), "am-weak-"));
		fs.writeFileSync(path.join(ch, "config.toml"), am.CONFIG_TOML.replace(/\[permissions\.am_batch\.filesystem\][\s\S]*?\[permissions\.am_batch\.network\]/, "[permissions.am_batch.network]"));
		const canary = path.join(am.home(), "probe", "canary");
		am.writePrivate(canary, "home-weak");
		const sandbox = (args, home = ch) => spawnSync("codex", ["sandbox", "-P", "am_batch", "--", ...args], { env: { PATH: process.env.PATH, HOME: os.homedir(), CODEX_HOME: home }, encoding: "utf8", timeout: 20_000 });
		assert.equal(am.classify(sandbox(["/bin/cat", canary]), "home-weak"), "allowed");
		const strict = fs.mkdtempSync(path.join(os.tmpdir(), "am-strict-"));
		fs.writeFileSync(path.join(strict, "config.toml"), am.CONFIG_TOML);
		assert.equal(am.classify(sandbox(["/bin/cat", path.join(am.home(), "probe", "no-such-canary")], strict), ""), "indeterminate", "a missing canary proves nothing");
		assert.equal(am.classify(sandbox(["/usr/bin/no-such-command"], strict), ""), "indeterminate");
		assert.equal(am.classify(sandbox(["/usr/bin/curl", "-sS", "-v", "--connect-timeout", "5", "https://example.invalid/"], strict), ""), "indeterminate");
		for (const d of [ch, strict]) fs.rmSync(d, { recursive: true, force: true });
	});

	it("matches spawnSync's ENOBUFS (combined bytes) and EPIPE results", async () => {
		const cases = [
			// 600 two-byte characters on each stream: under maxBuffer per stream in characters and in bytes, over it combined in bytes.
			[process.execPath, ["-e", "process.stdout.write('é'.repeat(600)); process.stderr.write('é'.repeat(600))"], { maxBuffer: 2000 }, "ENOBUFS"],
			// Valid output, then exit without reading a 4 MiB input.
			["/bin/sh", ["-c", "echo ok"], { input: "x".repeat(4 << 20) }, "EPIPE"],
			["/bin/cat", [], { input: "hi" }, undefined],
		];
		for (const [cmd, args, options, code] of cases) {
			const sync = spawnSync(cmd, args, { encoding: "utf8", ...options }), async = await am.spawnAsync(cmd, args, { encoding: "utf8", ...options });
			assert.equal(sync.error?.code, code, `${cmd} spawnSync`);
			assert.equal(async.error?.code, code, `${cmd} spawnAsync`);
			if (!code) assert.deepEqual([async.status, async.stdout], [sync.status, sync.stdout]);
		}
		// A child that ignores SIGTERM and writes 32 MiB past a 1 KiB limit: at most 1 KiB is kept and its group gets one SIGTERM.
		const terms = path.join(fs.mkdtempSync(path.join(tmp, "flood-")), "terms");
		const flood = `const fs = require("fs"); process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(terms)}, "t"));
			const b = Buffer.alloc(65536, 120); let n = 0; const w = () => { if (n++ < 512) process.stdout.write(b, w); }; w();`;
		const r = await am.spawnAsync(process.execPath, ["-e", flood], { encoding: "utf8", maxBuffer: 1024 });
		assert.equal(r.error?.code, "ENOBUFS");
		assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= 1024, "retained output stays within maxBuffer");
		assert.equal(fs.readFileSync(terms, "utf8"), "t", "the group is stopped once");
	});

	it("settles a timeout whose child left a worker holding stdout open, and stops that worker", { timeout: 20_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(tmp, "worker-")), pidFile = path.join(dir, "worker.pid");
		// The worker ignores SIGTERM and inherits stdout; the launcher waits on it, as the npm launcher waits on its native worker.
		const r = await am.spawnAsync("/bin/sh", ["-c", `(trap "" TERM; exec sleep 30) & echo $! > "${pidFile}"; wait`], { encoding: "utf8", timeout: 300 });
		const worker = Number(fs.readFileSync(pidFile, "utf8"));
		try {
			assert.equal(r.error?.code, "ETIMEDOUT");
			for (let i = 0; i < 20 && (() => { try { process.kill(worker, 0); return true; } catch { return false; } })(); i++) await new Promise((res) => setTimeout(res, 50));
			assert.throws(() => process.kill(worker, 0), { code: "ESRCH" }, "the worker is stopped");
		} finally { try { process.kill(worker, "SIGKILL"); } catch { /* already stopped */ } }
	});

	it("on SIGTERM stops the in-flight codex child, removes the run's temp dirs and lock entry; sweeps only dead runs' dirs", async (t) => {
		if (process.platform !== "darwin") { t.skip("the confined runner runs on macOS only"); return; }
		const root = fs.mkdtempSync(path.join(tmp, "signal-")), tdir = path.join(root, "tmp"), userHome = path.join(root, "user"), amHome = path.join(root, "am");
		for (const d of [tdir, path.join(userHome, "Library"), path.join(userHome, ".codex"), path.join(amHome, "spool")]) fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(userHome, ".codex", "auth.json"), "{}", { mode: 0o600 });
		// A scheduled run with a spooled batch drains; the fake codex blocks in the runner's first sandbox call, like the npm launcher
		// waiting on its native worker (a grandchild that a signal to the launcher alone would not stop), and records both pids.
		fs.writeFileSync(path.join(amHome, "spool", "x.json"), "{}");
		const fake = path.join(root, "fake-codex");
		fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = sandbox ] && [ "$5" = /bin/echo ]; then sleep 30 & echo $! > "$HOME/grandchild.pid"; echo $$ > "$HOME/child.pid"; wait; exit 1; fi\necho "Operation not permitted" >&2; exit 1\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(amHome, "config.json"), JSON.stringify({ codex_bin: fake, codex_home: path.join(userHome, ".codex") }));
		const deadPid = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout);
		const dead = path.join(tdir, `am-codex-home-${deadPid}-AbC123`), liveDir = path.join(tdir, `am-run-${process.pid}-AbC123`), unowned = path.join(tdir, "am-run-AbC123");
		const deadRun = path.join(tdir, `am-run-${deadPid}-AbC123`);
		for (const d of [dead, liveDir, unowned, deadRun]) fs.mkdirSync(d);
		// The dead run recorded three process groups with their leaders' start times: its own, still working in its am-run dir
		// (stopped by the sweep); one working elsewhere; and a reused id, working in the dir but started at another time (both left
		// alone and logged).
		const sleeper = (cwd) => spawn("/bin/sleep", ["30"], { cwd, detached: true, stdio: "ignore" });
		const orphan = sleeper(deadRun), stranger = sleeper(root), reused = sleeper(deadRun);
		const lstart = (pid) => spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
		for (const p of [orphan, stranger]) fs.writeFileSync(path.join(deadRun, `pgid-${p.pid}`), lstart(p.pid));
		fs.writeFileSync(path.join(deadRun, `pgid-${reused.pid}`), "Thu Jan  1 00:00:00 2026");
		const exists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
		const child = spawn(process.execPath, ["--import", "data:text/javascript,globalThis.fetch=async()=>({})", fileURLToPath(new URL("./agent-memory.mjs", import.meta.url)), "run", "--scheduled"],
			{ env: { PATH: process.env.PATH, HOME: userHome, TMPDIR: tdir, AGENT_MEMORY_HOME: amHome }, stdio: "ignore" });
		const pidFile = path.join(userHome, "child.pid");
		for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
		const codexPid = Number(fs.readFileSync(pidFile, "utf8")), workerPid = Number(fs.readFileSync(path.join(userHome, "grandchild.pid"), "utf8"));
		try {
			const own = fs.readdirSync(tdir).filter((n) => n.includes(`-${child.pid}-`));
			assert.equal(own.length, 2, "the runner's codex home and run dir");
			assert.deepEqual([fs.existsSync(dead), fs.existsSync(deadRun), fs.existsSync(liveDir), fs.existsSync(unowned)], [false, false, true, true]);
			assert.deepEqual([exists(orphan.pid), exists(stranger.pid), exists(reused.pid)], [false, true, true]);
			const log = fs.readFileSync(path.join(amHome, "logs", "capture.log"), "utf8");
			for (const p of [stranger, reused]) assert.match(log, new RegExp(`"event":"orphan_group_left","pgid":${p.pid}\\b`));
			assert.equal(fs.readdirSync(path.join(amHome, "run.lock.d")).length, 1);
			child.kill("SIGTERM");
			const [code] = await once(child, "exit");
			assert.equal(code, 143);
			assert.deepEqual(fs.readdirSync(tdir).filter((n) => n.includes(`-${child.pid}-`)), []);
			assert.deepEqual(fs.readdirSync(path.join(amHome, "run.lock.d")), []);
			await new Promise((r) => setTimeout(r, 200));
			assert.throws(() => process.kill(codexPid, 0), { code: "ESRCH" }, "the codex child is stopped");
			assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" }, "its worker is stopped");
		} finally { for (const pid of [codexPid, workerPid, orphan.pid, stranger.pid, reused.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } } }
	});
});

// Review L1-L8 (docs/review-sol-phase2a-local-2026-10-28.md), each from the reviewer's failing example.
describe("review regressions", () => {
	const emptyPart = () => ({ asks: [], decisions: [], corrections: [], outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
	const enqueue = (session, f, event = "Stop") => am.hook("claude-code", JSON.stringify({ session_id: session, transcript_path: f, hook_event_name: event }), { spawnRun: false });
	const queueDir = () => path.join(am.home(), "queue");

	it("L1: refuses a part that carries a whole long message in outcomes or any unknown field", async () => {
		const text = `Private detail ${"internal detail ".repeat(35)}.`;
		const f = transcript("raw", [claudeLine("user", text)]);
		const server = fakeServer();
		const raw = fixedRunner({ kind: "ok", part: { ...emptyPart(), outcomes: { commits: [], prs: [], tests: [text] } } });
		const r = await am.processSession(trigger("claude-code", "sess-raw", f), { server, runner: raw });
		assert.equal(r.consolidated_to, 0);
		assert.ok(!server.storedText().includes(text));
		assert.equal(am.rejectPart({ ...emptyPart(), outcomes: { commits: [], prs: [], tests: [text] } }, { messages: [] }), "bad_outcomes");
		assert.equal(am.rejectPart({ ...emptyPart(), whole_message: "x" }, { messages: [] }), "bad_shape");
		assert.equal(am.rejectPart({ ...emptyPart(), asks: [{ text: "a", pos: 1, raw: "x" }] }, { messages: [] }), "bad_items:asks:shape");
		assert.equal(am.rejectPart({ ...emptyPart(), corrections: [{ text: "Use token=abc123secret", pos: 1 }] }, { messages: [] }), "bad_items:corrections:redaction");
		assert.equal(am.rejectPart({ ...emptyPart(), corrections: [{ text: "Use token=[REDACTED]", pos: 1 }] }, { messages: [] }), null);
	});

	it("names the failed item check in a stuck range's reason, with the same gates and no part text", async () => {
		const reject = (part) => am.rejectPart({ ...emptyPart(), ...part }, { messages: [] });
		assert.equal(reject({ asks: "x" }), "bad_items:asks:array");
		assert.equal(reject({ decisions: [{ text: 7, pos: 1 }] }), "bad_items:decisions:type");
		assert.equal(reject({ decisions: [{ text: "x".repeat(281), pos: 1 }] }), "bad_items:decisions:length");
		assert.equal(reject({ corrections: [{ text: "x", pos: -1 }] }), "bad_items:corrections:position");
		assert.equal(reject({ corrections: [{ text: "x" }] }), "bad_items:corrections:position");
		// The bounds themselves are unchanged: exactly 160 and 280 characters pass, one more fails.
		assert.equal(reject({ asks: [{ text: "x".repeat(160), pos: 0 }], decisions: [{ text: "y".repeat(280), pos: 0 }] }), null);
		assert.equal(reject({ asks: [{ text: "x".repeat(161), pos: 0 }] }), "bad_items:asks:length");
		const ask = "Ship the amber widget for the review session demo and keep the decision log beside the sample folder for later.";
		const f = transcript("why", [claudeLine("user", "Ship it."), claudeLine("assistant", "Done.")]);
		const r = await am.processSession(trigger("claude-code", "sess-why", f), { server: fakeServer(), runner: fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: ask, pos: -1 }] } }) });
		const range = Object.values(JSON.parse(fs.readFileSync(path.join(am.home(), "state", "claude-code", "sess-why.json"), "utf8")).ranges)[0];
		assert.deepEqual([Object.values(r.outcomes)[0], range.status, range.reason, r.consolidated_to], ["stuck", "stuck", "bad_items:asks:position", 0]);
		assert.ok(!JSON.stringify(range).includes("amber"));
	});

	it("tells the model every bound the validator and the hosted schema enforce", () => {
		const server = fs.readFileSync(new URL("../src/profile/capture.ts", import.meta.url), "utf8");
		assert.deepEqual([am.LIMITS.ask, am.LIMITS.item], /const ASK_MAX = (\d+), ITEM_MAX = (\d+);/.exec(server).slice(1).map(Number));
		const props = am.PART_SCHEMA.properties, reject = (part) => am.rejectPart({ ...emptyPart(), ...part }, { messages: [] });
		for (const k of ["asks", "decisions", "corrections"]) {
			const { text, pos } = props[k].items.properties;
			assert.equal(text.maxLength, k === "asks" ? am.LIMITS.ask : am.LIMITS.item);
			assert.equal(pos.minimum, 0);
			assert.equal(reject({ [k]: [{ text: "x".repeat(text.maxLength), pos: 0 }] }), null);
			assert.equal(reject({ [k]: [{ text: "x".repeat(text.maxLength + 1), pos: 0 }] }), `bad_items:${k}:length`);
		}
		const max = props.entities.items.maxLength;
		assert.ok(["commits", "prs", "tests"].every((k) => props.outcomes.properties[k].items.maxLength === max));
		assert.equal(reject({ entities: ["x".repeat(max)], outcomes: { commits: [], prs: [], tests: ["y".repeat(max)] } }), null);
		assert.equal(reject({ entities: ["x".repeat(max + 1)] }), "bad_entities");
		assert.equal(reject({ outcomes: { commits: [], prs: [], tests: ["y".repeat(max + 1)] } }), "bad_outcomes");
		assert.ok(Object.values(props.dropped.properties).every((c) => c.minimum === 0));
	});

	it("cuts an over-long model ask with a marker instead of retrying the range to stuck", async () => {
		const f = transcript("long-ask", [claudeLine("user", "Ship it."), claudeLine("assistant", "Done.")]);
		const server = fakeServer(), runner = fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: "Ship the amber widget. ".repeat(20), pos: 0 }] } });
		const r = await am.processSession(trigger("claude-code", "sess-long-ask", f), { server, runner });
		assert.deepEqual([Object.values(r.outcomes)[0], r.consolidated_to, runner.calls], ["consolidated", fs.statSync(f).size, 1]);
		const [ask] = JSON.parse([...server.parts].find(([k]) => k.includes("|consolidated|"))[1].body).asks;
		assert.equal(ask.text.length, am.LIMITS.ask);
		assert.ok(ask.text.endsWith("…"));
	});

	it("keeps a path literal longer than an entity as its marked excerpt, without breaking the entities", async () => {
		const long = `src/${Array.from({ length: 1200 }, (_, i) => `dir${i}`).join("/")}/file.ts`;
		assert.ok(long.length > 5000);
		const f = transcript("long-path", [claudeLine("user", `Open ${long} and fix it.`), claudeLine("assistant", "Done.")]);
		const server = fakeServer(), runner = fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: "Open the long path and fix it.", pos: 0 }] } });
		const r = await am.processSession(trigger("claude-code", "sess-long-path", f), { server, runner });
		assert.deepEqual([Object.values(r.outcomes)[0], r.consolidated_to, runner.calls], ["consolidated", fs.statSync(f).size, 1]);
		const body = JSON.parse([...server.parts].find(([k]) => k.includes("|consolidated|"))[1].body);
		assert.equal(am.bodyProblem(body), null);
		assert.ok(body.entities.includes(`${long.slice(0, am.LIMITS.item - 1)}…`));
		assert.ok(am.literals([{ role: "owner", text: long }]).every((l) => l.length <= am.LIMITS.item));
	});

	it("retries a range stuck under an older digest revision once on the next start, and not again after", async () => {
		const f = transcript("old-stuck", [claudeLine("user", "Never squash release commits.")]);
		const server = fakeServer(), file = path.join(am.home(), "state", "claude-code", "sess-old-stuck.json");
		await am.processSession(trigger("claude-code", "sess-old-stuck", f), { server, runner: fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: "x", pos: -1 }] } }) });
		const runner = keepAllRunner();
		enqueue("sess-start-1", transcript("start-1", []), "SessionStart");
		await am.run({ server, runner, debounceMs: 0 });
		assert.equal(runner.calls, 0, "a range stuck under the current revision is not swept");
		// A state an older client left: the same stuck range, without a revision stamp.
		const st = JSON.parse(fs.readFileSync(file, "utf8"));
		for (const range of Object.values(st.ranges)) delete range.digest_rev;
		fs.writeFileSync(file, JSON.stringify(st));
		enqueue("sess-start-2", transcript("start-2", []), "SessionStart");
		const r = await am.run({ server, runner, debounceMs: 0 });
		assert.equal(r.results["claude-code-sess-old-stuck.json"].consolidated_to, fs.statSync(f).size);
		assert.ok(server.storedText().includes("Never squash release commits."));
	});

	it("settles the trigger of a range whose recovery stays stuck, so later drains do not call the model again, and keeps its data", async () => {
		const f = transcript("still-stuck", [claudeLine("user", "Never squash release commits.")]);
		const server = fakeServer(), runner = fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: "x", pos: -1 }] } });
		const file = path.join(am.home(), "state", "claude-code", "sess-still-stuck.json");
		await am.processSession(trigger("claude-code", "sess-still-stuck", f), { server, runner });
		const st = JSON.parse(fs.readFileSync(file, "utf8"));
		for (const range of Object.values(st.ranges)) delete range.digest_rev;
		fs.writeFileSync(file, JSON.stringify(st));
		const calls = runner.calls;
		enqueue("sess-start-a", transcript("start-a", []), "SessionStart");
		await am.run({ server, runner, debounceMs: 0 });
		// One recovery pass: a subrange under the 2 KB floor gets LIMITS.attempts model calls; the second drain makes none.
		assert.equal(runner.calls - calls, am.LIMITS.attempts);
		await am.run({ server, runner, debounceMs: 0 });
		assert.equal(runner.calls - calls, am.LIMITS.attempts, "the second drain does not call the model");
		assert.deepEqual(fs.readdirSync(queueDir()), []);
		const [id, range] = Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).ranges)[0];
		assert.deepEqual([range.status, range.digest_rev], ["stuck", 2]);
		assert.ok(fs.existsSync(path.join(am.home(), "pending", `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`)), "the pending text is kept");
	});

	it("does not require the sentence period after an unquoted path, and keeps quoted and backticked literals exact", () => {
		const owner = (text) => ({ messages: [{ role: "owner", text, pos: 0, next: text.length + 1 }] });
		const sub = owner("Read ~/notes/work/agents.md. Then open src/.. and a/b- too.");
		assert.deepEqual(am.literals(sub.messages), ["~/notes/work/agents.md", "src/..", "a/b-"]);
		const ask = [{ text: "Read the agents notes", pos: 0 }];
		assert.equal(am.rejectPart({ ...emptyPart(), asks: ask, entities: ["~/notes/work/agents.md", "src/..", "a/b-"] }, sub), null);
		assert.equal(am.rejectPart({ ...emptyPart(), asks: ask, entities: ["~/notes/work/agents", "src/..", "a/b-"] }, sub), "missing_literal");
		const quoted = owner('Use `docs/x.md.` and "notes/y.md." as written.');
		assert.ok(["docs/x.md.", "notes/y.md."].every((l) => am.literals(quoted.messages).includes(l)));
		assert.equal(am.rejectPart({ ...emptyPart(), asks: ask, entities: ["docs/x.md", "notes/y.md"] }, quoted), "missing_literal");
	});

	it("adds the literals a schema-valid model part paraphrased verbatim, instead of retrying the range to stuck", async () => {
		const f = transcript("paraphrase", [claudeLine("user", "Keep the UTF-8 bound and/or the 8 KB cap; follow AM-09 for the `pending` range.")]);
		const server = fakeServer();
		const runner = fixedRunner({ kind: "ok", part: { ...emptyPart(), asks: [{ text: "Keep the UTF-8 bound and the 8 KB cap.", pos: 0 }], entities: ["AM-09", "pending"] } });
		const r = await am.processSession(trigger("claude-code", "sess-paraphrase", f), { server, runner });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.equal(runner.calls, 1);
		assert.ok(server.storedText().includes("and/or"));
	});

	it("redacts a quoted structured secret before literals, prompt or upload, including pending text an older client kept", async () => {
		const value = "synthetic-only-value-42", tail = "synthetic-only/private-value-42";
		// An escaped quote stays inside the value; stopping there would leave a path-shaped tail for the literal append.
		const escaped = JSON.stringify({ api_key: `ignored-prefix" ${tail}` });
		assert.equal(am.redact(`{"api_key":"${value}"} {'github_token': '${value}'} ${escaped}`), `{"api_key":[REDACTED]} {'github_token':[REDACTED]} {"api_key":[REDACTED]}`);
		const f = transcript("structured", [claudeLine("user", `Inspect the diagnostic sample.\n{"api_key":"${value}"}\n${escaped}`)]);
		const seen = [];
		const runner = { available: true, calls: 0, async run(sub) { this.calls++; seen.push(JSON.stringify(sub.messages)); return { kind: "ok", part: { ...emptyPart(), asks: [{ text: "Inspect the diagnostic sample.", pos: 0 }] } }; } };
		// An older client's pending copy still holding the value: the same range is consolidated from re-redacted text.
		const server = fakeServer(), offline = { ...server, ingest: async () => { throw new Error("network down"); } };
		await am.processSession(trigger("claude-code", "sess-structured", f), { server: offline, runner: null });
		const pending = path.join(am.home(), "pending");
		const kept = fs.readdirSync(pending).find((x) => x.endsWith(".txt"));
		fs.writeFileSync(path.join(pending, kept), JSON.stringify(JSON.parse(fs.readFileSync(path.join(pending, kept), "utf8")).map((m) => ({ ...m, text: `${m.text}\n{"api_key":"${value}"}\n${escaped}` }))));
		const r = await am.processSession(trigger("claude-code", "sess-structured", f), { server, runner });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.equal(runner.calls, 1);
		for (const secret of [value, tail]) {
			assert.ok(!seen.join("").includes(secret));
			assert.ok(!JSON.stringify(server.log).includes(secret));
			assert.ok(!fs.readdirSync(path.join(am.home(), "spool"), { recursive: true }).some((x) => fs.readFileSync(path.join(am.home(), "spool", x), "utf8").includes(secret)));
		}
	});

	it("L2: a run started before the debounce deadline waits for it and then captures", async () => {
		const f = transcript("debounce", [claudeLine("user", "Use the other timeout.")]);
		enqueue("sess-debounce", f);
		const server = fakeServer();
		const t0 = Date.now();
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 60 });
		assert.ok(Date.now() - t0 >= 50);
		assert.equal(r.status, "ran");
		assert.equal(server.manifests.size, 1);
		assert.deepEqual(fs.readdirSync(queueDir()), []);
		assert.ok(am.takeLock(), "the run released its lock");
		am.dropLock();
	});

	it("L3: a trigger that arrives during a run is kept and handled, so the final correction is captured", async () => {
		const f = transcript("race", [claudeLine("user", "Use one timeout.")]);
		enqueue("sess-race", f);
		const server = fakeServer(), ingest = server.ingest;
		let inserted = false;
		server.ingest = async (b) => {
			if (!inserted) { inserted = true; fs.appendFileSync(f, claudeLine("user", "Never drop the final correction.")); enqueue("sess-race", f, "SessionEnd"); }
			return ingest(b);
		};
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		assert.ok(server.storedText().includes("Never drop the final correction."));
		assert.equal(Object.values(r.results)[0].consolidated_to, fs.statSync(f).size);
		assert.deepEqual(fs.readdirSync(queueDir()), []);
	});

	// L4 workers are child processes on the test home that call takeLock once and stay alive. A worker given `pause` stops
	// before it removes any lock path (not its own temporary one) until release-<pause> exists, as in the review's repro.
	const amUrl = new URL("./agent-memory.mjs", import.meta.url).href;
	const lockWorker = (pause) => {
		const k = spawn(process.execPath, ["--input-type=module", "-e", `
			const fs = await import("node:fs");
			const hold = (f) => { const p = String(f); if (${JSON.stringify(!!pause)} && p.startsWith(${JSON.stringify(path.join(am.home(), "run.lock"))}) && !p.endsWith(".tmp")) { console.log("paused"); while (!fs.existsSync(${JSON.stringify(path.join(am.home(), `release-${pause}`))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };
			for (const k of ["unlinkSync", "rmSync"]) { const real = fs.default[k]; fs.default[k] = function (f, ...a) { hold(f); return real.call(this, f, ...a); }; }
			const am = await import(${JSON.stringify(amUrl)});
			console.log(am.takeLock() ? "won" : "lost"); setInterval(() => {}, 1000);`], { env: { ...process.env, AGENT_MEMORY_HOME: am.home() }, stdio: ["ignore", "pipe", "inherit"] });
		k.out = [];
		k.stdout.on("data", (d) => k.out.push(...String(d).trim().split("\n")));
		return k;
	};
	const said = async (k, ...lines) => {
		for (let i = 0; i < 400 && !lines.some((l) => k.out.includes(l)); i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(lines.some((l) => k.out.includes(l)), JSON.stringify({ want: lines, got: k.out }));
	};
	const kill = async (k) => { if (k.exitCode === null && k.signalCode === null) { k.kill("SIGKILL"); await once(k, "exit"); } };
	const deadOwner = async () => { const k = lockWorker(); await said(k, "won"); await kill(k); };
	// A queued session whose text is kept pending (no runner yet), and the run that must capture it in full.
	const pendingSession = async (name) => {
		const f = transcript(name, [claudeLine("user", "Use the other timeout.")]);
		const server = fakeServer();
		await am.processSession(trigger("claude-code", `sess-${name}`, f), { server, runner: null });
		enqueue(`sess-${name}`, f);
		return { f, server };
	};
	const capturesAll = async ({ f, server }) => {
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		assert.equal(r.status, "ran");
		assert.equal(Object.values(r.results)[0].consolidated_to, fs.statSync(f).size);
		assert.deepEqual(fs.readdirSync(queueDir()), []);
	};

	it("L4: two workers reclaiming a dead worker's lock, each paused before it removes the lock, end with exactly one owner", async () => {
		await deadOwner();
		const a = lockWorker("a"), b = lockWorker("b");
		for (const k of [a, b]) await said(k, "paused", "lost");
		fs.writeFileSync(path.join(am.home(), "release-a"), "");
		await said(a, "won", "lost");
		fs.writeFileSync(path.join(am.home(), "release-b"), "");
		await said(b, "won", "lost");
		assert.deepEqual([...a.out, ...b.out].filter((x) => x === "won" || x === "lost").sort(), ["lost", "won"]);
		assert.equal(am.takeLock(), false, "the owner keeps its lock");
		await kill(a); await kill(b);
	});

	it("L4: a reclaimer killed before it removes a dead worker's lock does not block later runs", async () => {
		const s = await pendingSession("l4-crash");
		await deadOwner();
		const reclaimer = lockWorker("never");
		await said(reclaimer, "paused");
		await kill(reclaimer);
		await capturesAll(s);
	});

	it("L4: a stopped live owner keeps the lock, and the trigger and pending text wait until it is killed", async () => {
		const s = await pendingSession("l4-stopped");
		const owner = lockWorker();
		await said(owner, "won");
		owner.kill("SIGSTOP");
		assert.equal((await am.run({ server: s.server, runner: keepAllRunner(), debounceMs: 0 })).status, "locked");
		assert.equal(fs.readdirSync(queueDir()).length, 1);
		assert.equal(fs.readdirSync(path.join(am.home(), "pending")).length, 1);
		await kill(owner);
		await capturesAll(s);
	});

	it("L4 upgrade: a live run.lock of the previous version blocks, and a home it left stuck recovers on the first run", async () => {
		const s = await pendingSession("l4-legacy");
		const lock = path.join(am.home(), "run.lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "live" }));
		assert.equal(am.takeLock(), false);
		// The stuck state: a dead worker's lock and the marker of a reclaimer killed before it removed that lock.
		const held = JSON.stringify({ pid: Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout), at: Date.now(), nonce: "dead" });
		fs.writeFileSync(lock, held);
		fs.writeFileSync(`${lock}.reclaimed-${sha(held).slice(0, 16)}`, "");
		await capturesAll(s);
	});

	it("L5: an append to a short transcript keeps the epoch and captures only the new tail", async () => {
		const f = transcript("short", [claudeLine("user", "Never change the release branch.")]);
		const server = fakeServer();
		const t = trigger("claude-code", "sess-short", f);
		await am.processSession(t, { server, runner: keepAllRunner() });
		fs.appendFileSync(f, claudeLine("user", "Use the other timeout."));
		const r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.equal(new Set([...server.manifests.keys()].map((k) => k.split(":")[2])).size, 1);
		const copies = [...server.parts.entries()].filter(([k, p]) => k.includes("|consolidated|") && p.body.includes("Never change the release branch.")).length;
		assert.equal(copies, 1);
		// A rewrite of the checked bytes still starts a new epoch.
		fs.writeFileSync(f, claudeLine("user", "Rewritten start of the file."));
		await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(new Set([...server.manifests.keys()].map((k) => k.split(":")[2])).size, 2);
	});

	it("L6: consolidates kept pending text after the source transcript is gone", async () => {
		const f = transcript("gone", [claudeLine("user", "Use the other timeout.")]);
		const server = fakeServer();
		const t = trigger("claude-code", "sess-gone", f);
		await am.processSession(t, { server, runner: null });
		fs.unlinkSync(f);
		const runner = keepAllRunner();
		const r = await am.processSession(t, { server, runner });
		assert.equal(r.status, "source_missing");
		assert.ok(runner.calls > 0);
		assert.equal(server.manifests.size, 1);
		assert.ok(server.storedText().includes("Use the other timeout."));
		assert.equal(r.consolidated_to, r.digested_to);
	});

	it("L7: a crash during cleanup after the manifest is stored still acknowledges the range", async () => {
		const f = transcript("crash-clean", [claudeLine("user", "Use the other timeout.")]);
		const server = fakeServer();
		const t = trigger("claude-code", "sess-crash-clean", f);
		const rm = fs.rmSync;
		fs.rmSync = function (file, ...args) { if (String(file).endsWith(".txt")) throw new Error("simulated crash during cleanup"); return rm.call(this, file, ...args); };
		try { await assert.rejects(am.processSession(t, { server, runner: keepAllRunner() }), /simulated crash/); } finally { fs.rmSync = rm; }
		let r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f).size);
		assert.equal(fs.readdirSync(path.join(am.home(), "pending")).length, 0);
		// Text lost before the acknowledgement was saved: the durable manifest is adopted instead of marking the range stuck.
		const f2 = transcript("crash-ack", [claudeLine("user", "Keep the staging bucket.")]);
		const t2 = trigger("claude-code", "sess-crash-ack", f2);
		const st = path.join(am.home(), "state", "claude-code", "sess-crash-ack.json");
		const realIngest = server.ingest;
		server.ingest = async (b) => { const out = await realIngest(b); if (b.manifests.length) { fs.rmSync(path.join(am.home(), "pending"), { recursive: true, force: true }); throw new Error("crash after the manifest was stored"); } return out; };
		await am.processSession(t2, { server, runner: keepAllRunner() });
		server.ingest = realIngest;
		r = await am.processSession(t2, { server, runner: keepAllRunner() });
		assert.equal(r.consolidated_to, fs.statSync(f2).size);
		assert.equal(Object.values(JSON.parse(fs.readFileSync(st, "utf8")).ranges)[0].status, "consolidated");
	});

	it("L8: an unknown event envelope fails closed even when a valid final message follows", () => {
		const ev = (...items) => items.map((i) => JSON.stringify(i)).join("\n");
		const final = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(emptyPart()) } };
		assert.equal(am.parseEvents(ev({ type: "runtime.notice", message: "A confinement setting was ignored" }, final, { type: "turn.completed" })).kind, "runtime_warning");
		assert.equal(am.parseEvents(ev({ type: "item.completed" }, final)).kind, "bad_events");
		assert.equal(am.parseEvents(ev({ type: "thread.started" }, { type: "turn.started" }, final, { type: "turn.completed" })).kind, "ok");
	});
});

describe("recovery and install", () => {
	const enqueue = (session, f, event) => am.hook("claude-code", JSON.stringify({ session_id: session, transcript_path: f, cwd: tmp, hook_event_name: event }), { spawnRun: false });

	it("another session's start recovers a seen session's tail that no Stop queued, once and in exact tiling parts", async () => {
		const a = transcript("sweep-a", [claudeLine("user", "Never squash release commits.")]);
		const server = fakeServer(), runner = keepAllRunner();
		enqueue("sess-a", a, "Stop");
		await am.run({ server, runner, debounceMs: 0 });
		const first = fs.statSync(a).size;
		fs.appendFileSync(a, claudeLine("user", "Use the other timeout."));
		const b = transcript("sweep-b", [claudeLine("user", "Keep the staging bucket.")]);
		// A Stop of the starting session before the run still keeps its start.
		enqueue("sess-b", b, "SessionStart");
		enqueue("sess-b", b, "Stop");
		const r = await am.run({ server, runner, debounceMs: 0 });
		assert.equal(r.results["claude-code-sess-a.json"].consolidated_to, fs.statSync(a).size);
		assert.ok(server.storedText().includes("Use the other timeout."));
		assert.deepEqual([...server.manifests.keys()].filter((k) => k.includes(":sess-a:")).map((k) => k.split(":").at(-1)).sort(), [`0-${first}`, `${first}-${fs.statSync(a).size}`]);
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "queue")), []);
		// Nothing is behind now: another start uploads nothing for either session.
		const uploads = server.log.length;
		enqueue("sess-c", transcript("sweep-c", []), "SessionStart");
		await am.run({ server, runner, debounceMs: 0 });
		assert.equal(server.log.length, uploads);
		const keys = server.log.flatMap((x) => x.digests.map((d) => `${d.range_id}|${d.part_id}`).concat(x.manifests.map((m) => `${m.range_id}|manifest`)));
		assert.equal(new Set(keys).size, keys.length, "no part or manifest was uploaded twice");
	});

	it("reaches a known session idle for 9 days behind a full sweep of newer states, on the next start", async () => {
		const old = transcript("sweep-old", [claudeLine("user", "Never squash release commits.")]);
		const server = fakeServer(), runner = keepAllRunner();
		enqueue("zzz-old", old, "Stop");
		await am.run({ server, runner, debounceMs: 0 });
		fs.appendFileSync(old, claudeLine("user", "Use the old timeout."));
		const nine = new Date(Date.now() - 9 * 86_400_000);
		for (const f of [old, path.join(am.home(), "state", "claude-code", "zzz-old.json")]) fs.utimesSync(f, nine, nine);
		// Newer seen states that sort first fill one whole sweep.
		for (let i = 0; i < am.LIMITS.sweep; i++) am.writePrivate(path.join(am.home(), "state", "claude-code", `aaa-${i}.json`), "{}");
		enqueue("sess-new", transcript("sweep-new", []), "SessionStart");
		await am.run({ server, runner, debounceMs: 0 });
		assert.ok(!server.storedText().includes("Use the old timeout."), "the first sweep spent its bound on the newer states");
		enqueue("sess-new2", transcript("sweep-new2", []), "SessionStart");
		const r = await am.run({ server, runner, debounceMs: 0 });
		assert.equal(r.results["claude-code-zzz-old.json"].consolidated_to, fs.statSync(old).size);
		assert.ok(server.storedText().includes("Use the old timeout."));
	});

	// Review of 16a (am-capture-review-sol-qsp62r0c): an older Stop published over a SessionStart, and an equal-size rewrite.
	it("keeps a SessionStart's sweep when an older Stop of that session publishes after it", async () => {
		const a = transcript("overlap-a", [claudeLine("user", "Never use alpha.")]);
		const server = fakeServer(), runner = keepAllRunner();
		await am.processSession(trigger("claude-code", "overlap-a", a), { server, runner });
		fs.appendFileSync(a, claudeLine("user", "Use the other timeout."));
		const b = transcript("overlap-b", []), q = path.join(am.home(), "queue", "claude-code-overlap-b.json");
		const write = fs.writeFileSync;
		let fired = false;
		fs.writeFileSync = function (f, ...args) {
			if (!fired && String(f).startsWith(`${q}.`)) { fired = true; enqueue("overlap-b", b, "SessionStart"); }
			return write.call(this, f, ...args);
		};
		try { enqueue("overlap-b", b, "Stop"); } finally { fs.writeFileSync = write; }
		assert.ok(fired);
		assert.equal(JSON.parse(fs.readFileSync(q, "utf8")).event, "Stop", "the older Stop's trigger replaced the start's");
		await am.run({ server, runner, debounceMs: 0 });
		assert.ok(server.storedText().includes("Use the other timeout."));
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "queue")), []);
	});

	it("queues an equal-size rewrite whose checked prefix changed, and skips an unchanged one", async () => {
		const a = transcript("rewrite-a", [claudeLine("user", "Never use alpha.")]);
		const server = fakeServer(), runner = keepAllRunner();
		await am.processSession(trigger("claude-code", "rewrite-a", a), { server, runner });
		const uploads = server.log.length;
		enqueue("rewrite-b", transcript("rewrite-b", []), "SessionStart");
		await am.run({ server, runner, debounceMs: 0 });
		assert.equal(server.log.length, uploads, "an unchanged transcript is not swept");
		const size = fs.statSync(a).size;
		fs.writeFileSync(a, claudeLine("user", "Never use bravo."));
		assert.equal(fs.statSync(a).size, size);
		enqueue("rewrite-c", transcript("rewrite-c", []), "SessionStart");
		const r = await am.run({ server, runner, debounceMs: 0 });
		assert.ok(server.log.length > uploads && server.storedText().includes("Never use bravo."));
		assert.equal(r.results["claude-code-rewrite-a.json"].consolidated_to, size);
		assert.equal(new Set([...server.manifests.keys()].filter((k) => k.includes(":rewrite-a:")).map((k) => k.split(":")[2])).size, 2, "a new epoch");
	});

	it("installs one canonical CLI with a symlinked command, private files, and the existing config kept", async () => {
		const bin = path.join(am.home(), "bin", "agent-memory"), cfg = path.join(am.home(), "config.json");
		am.writePrivate(bin, "old regular copy");
		am.writePrivate(cfg, "{\"server\":\"https://kept.example\"}");
		const r = am.install({ platform: "linux" });
		assert.equal(r.bin, bin);
		assert.equal(fs.readlinkSync(bin), "agent-memory.mjs");
		assert.equal(fs.statSync(`${bin}.mjs`).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(am.home(), "bin", "batch.mjs")).mode & 0o777, 0o600);
		for (const file of ["corpus-cli.mjs", "corpus-git.mjs", "corpus-judgment.mjs", "corpus-refresh.mjs", "corpus-scan.mjs", "corpus-upload.mjs"]) {
			const installed = path.join(path.dirname(bin), file);
			assert.equal(fs.statSync(installed).mode & 0o777, 0o600);
			assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(new URL(`./${file}`, import.meta.url)));
		}
		for (const d of [am.home(), path.dirname(bin)]) assert.equal(fs.statSync(d).mode & 0o777, 0o700);
		assert.equal(fs.readFileSync(cfg, "utf8"), "{\"server\":\"https://kept.example\"}");
		assert.equal(fs.readFileSync(`${bin}.mjs`, "utf8"), fs.readFileSync(new URL("./agent-memory.mjs", import.meta.url), "utf8"));
		// One module instance through the command, the .mjs name and batch.mjs, so the lock owner is shared.
		const { pathToFileURL } = await import("node:url");
		const cmd = await import(pathToFileURL(bin).href), mjs = await import(pathToFileURL(`${bin}.mjs`).href);
		assert.equal(cmd, mjs);
		await import(pathToFileURL(path.join(path.dirname(bin), "batch.mjs")).href);
		await import(pathToFileURL(path.join(path.dirname(bin), "corpus-judgment.mjs")).href);
		assert.ok(cmd.takeLock());
		try { mjs.assertMachineLock(); } finally { cmd.dropLock(); }
		const usage = spawnSync(bin, [], { encoding: "utf8", env: { ...process.env, AGENT_MEMORY_HOME: am.home() } });
		assert.equal(usage.status, 2, usage.stderr);
		assert.match(usage.stderr, /^usage: agent-memory/);
		fs.rmSync(path.dirname(bin), { recursive: true });
		fs.symlinkSync(tmp, path.dirname(bin));
		assert.throws(() => am.install({ platform: "linux" }), /install_refused/);
		// A symlinked home is refused before anything is created through it.
		const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
		process.env.AGENT_MEMORY_HOME = path.join(tmp, `linked-home-${n}`);
		fs.symlinkSync(outside, am.home());
		assert.throws(() => am.install({ platform: "linux" }), /install_refused/);
		assert.deepEqual(fs.readdirSync(outside), []);
	});

	it("runs corpus-upload from the installed command alone, through the corpus CLI's arguments and uploader to a local fake server", async () => {
		const { DatabaseSync } = await import("node:sqlite"), http = await import("node:http");
		const { bin } = am.install({ platform: "linux" });
		const defaults = am.loadConfig();
		assert.deepEqual(defaults.batch_profiles, []);
		assert.equal(Object.hasOwn(defaults, "corpus_profile"), false);
		assert.equal(Object.hasOwn(defaults, "corpus_judgment"), false);
		// One synthetic table under its retained original DDL (src/corpus/families.ts); the email column never uploads.
		const ddl = "CREATE TABLE contributors(\n  repo TEXT,\n  rank INT,\n  commits INT,\n  name TEXT,\n  email TEXT\n)";
		const dir = fs.mkdtempSync(path.join(tmp, "corpus-")), file = path.join(dir, "sample.sqlite");
		const db = new DatabaseSync(file);
		db.exec(ddl);
		db.exec("INSERT INTO contributors (rowid, repo, rank, commits, name, email) VALUES (3, 'acme/web', 1, 2, 'Alice', 'alice@acme.example')");
		db.close();
		const family = { table: "contributors", schema_sha256: sha(ddl), key: ["rowid"], columns: ["rowid", "repo", "rank", "commits", "name"] };
		const seen = [];
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (d) => { body += d; }).on("end", () => {
				seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
				const c = body && JSON.parse(body);
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(req.url.startsWith("/v1/corpus/status") ? { generation: "g1", families: [family], held: {}, tables: [] }
					: { receipt: { status: "stored", sha256: c.sha256, last_key: c.rows.length ? [c.rows.at(-1)[0]] : c.after, complete: c.final } }));
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const token = path.join(dir, "import.token"), config = path.join(dir, "upload.json");
			fs.writeFileSync(token, "am_import_fake", { mode: 0o600 });
			fs.writeFileSync(config, JSON.stringify({ server: `http://127.0.0.1:${server.address().port}`, token_file: token }), { mode: 0o600 });
			const child = spawn(bin, ["corpus-upload", "--db", file, "--profile", "test", "--tables", "contributors", "--as-of", "2026-08-12T00:00:00Z", "--config", config],
				{ cwd: dir, env: { ...process.env, AGENT_MEMORY_HOME: am.home() } });
			let out = "", err = "";
			child.stdout.on("data", (d) => { out += d; });
			child.stderr.on("data", (d) => { err += d; });
			const [code] = await once(child, "close");
			assert.equal(code, 0, err);
			assert.deepEqual(JSON.parse(out), { status: "done", generation: "g1", tables: { contributors: { last_key: [3], rows: 1, complete: true } } });
			assert.deepEqual(seen.map((r) => `${r.method} ${r.url.split("?")[0]}`), ["GET /v1/corpus/status", "POST /v1/corpus/import"]);
			assert.ok(seen.every((r) => r.auth === "Bearer am_import_fake"));
			assert.deepEqual(seen[1].body.rows, [[3, "acme/web", 1, 2, "Alice"]]);
			assert.ok(fs.existsSync(path.join(am.home(), "migration", `corpus-test-127.0.0.1:${server.address().port}.json`)), "resume state is kept");
		} finally { server.close(); }
		const usage = spawnSync(bin, ["corpus-upload"], { encoding: "utf8", env: { ...process.env, AGENT_MEMORY_HOME: am.home() } });
		assert.equal(usage.status, 2);
		assert.match(usage.stderr, /^usage: agent-memory corpus-upload --db FILE/);
		// --git reaches the Git adapter: a directory without an origin is refused per checkout, with no request (the fake server is closed).
		const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
		const viaGit = spawnSync(bin, ["corpus-upload", "--git", plain, "--profile", "test", "--config", path.join(dir, "upload.json")], { encoding: "utf8", env: { ...process.env, AGENT_MEMORY_HOME: am.home() } });
		assert.equal(viaGit.status, 1, viaGit.stderr);
		assert.deepEqual(JSON.parse(viaGit.stdout), [{ checkout: plain, status: "refused", reason: "no_origin_repo" }]);
		assert.equal(spawnSync(bin, ["corpus-upload", "--git", plain, "--profile", "test", "--tables", "repos"], { encoding: "utf8" }).status, 2);
		// migrate.mjs's run lock excludes a corpus run too, before any source read or request.
		fs.writeFileSync(path.join(am.home(), "migration", "run.lock"), "{\"pid\":1}", { mode: 0o600 });
		const locked = spawnSync(bin, ["corpus-upload", "--db", path.join(tmp, "absent.sqlite"), "--profile", "test", "--tables", "contributors", "--as-of", "2026-08-12T00:00:00Z", "--config", path.join(dir, "upload.json")],
			{ encoding: "utf8", env: { ...process.env, AGENT_MEMORY_HOME: am.home() } });
		assert.equal(locked.status, 1);
		assert.match(locked.stderr, /another migrate run holds/);
	});
});

describe("general confined executor", () => {
	it("uses the proved config and environment for each requested schema and discards notices, tools, rejected calls and config drift", async () => {
		const dir = fs.mkdtempSync(path.join(tmp, "executor-")), configFile = path.join(dir, "config.toml");
		fs.writeFileSync(configFile, am.CONFIG_TOML);
		const env = { CODEX_HOME: dir, HOME: dir, PATH: "/usr/bin:/bin" };
		const { OPS_SCHEMA } = await import("./batch.mjs");
		let calls = 0, mode = "ok";
		const execute = am.confinedExec({ codex: "fake-codex", runDir: dir, env, configFile, configSha: sha(am.CONFIG_TOML), schemaDir: dir,
			exec(command, args, options) {
				calls++;
				assert.equal(command, "fake-codex"); assert.equal(options.env, env); assert.equal(options.cwd, dir);
				assert.equal(options.input, "private input");
				const features = fs.readFileSync(configFile, "utf8").split("[features]\n")[1]?.split("\n[")[0] ?? "";
				assert.match(features, /^view_image = false$/m);
				// Codex 0.168.0 warns on the deprecated multi_agent key, which fails every confined run.
				assert.match(features, /^multi_agent_v2 = false$/m); assert.doesNotMatch(features, /^multi_agent = /m);
				assert.ok(args.includes("model_reasoning_effort=high"));
				const schemaFile = args[args.indexOf("--output-schema") + 1];
				assert.deepEqual(JSON.parse(fs.readFileSync(schemaFile)), OPS_SCHEMA);
				assert.equal(fs.statSync(schemaFile).mode & 0o777, 0o400);
				if (mode === "drift") fs.writeFileSync(configFile, "changed");
				const item = mode.startsWith("tool") ? { type: "command_execution" } : mode.startsWith("notice") ? { type: "error" }
					: { type: "agent_message", text: JSON.stringify({ results: [] }) };
				return { status: mode === "unsupported_exit" || mode.endsWith("_exit") ? 1 : 0, stdout: JSON.stringify({ type: "item.completed", item }),
					stderr: mode.startsWith("unsupported") ? "WARN codex_core::tools::router: unsupported call: exec_command\n" : "Reading prompt from stdin...\n" };
			} });
		const args = { prompt: "private input", schema: OPS_SCHEMA, model: "fake-model", effort: "high" };
		// usage is null when the event stream carries no turn.completed token counts (unknown, never zero).
		assert.deepEqual(await execute(args), { kind: "ok", part: { results: [] }, usage: null });
		mode = "tool"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "notice"; assert.equal((await execute(args)).kind, "runtime_warning");
		mode = "unsupported"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "unsupported_exit"; assert.equal((await execute(args)).kind, "tool_event");
		// A nonzero exit never hides a tool or a notice in the events.
		mode = "tool_exit"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "notice_exit"; assert.equal((await execute(args)).kind, "runtime_warning");
		mode = "ok_exit"; assert.equal((await execute(args)).kind, "runtime_error");
		mode = "drift"; assert.equal((await execute(args)).kind, "runtime_warning");
		assert.equal((await execute(args)).kind, "runtime_warning"); assert.equal(calls, 9, "changed config cannot start another exec");
		assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".schema.json")).length, 0);
	});
});

// Daily cases remain reachable through the existing permanent local test entry.
await import("./daily-refresh.test.mjs");

describe("optional corpus refresh after SessionEnd", () => {
	it("runs only when corpus_profile is set, for checkouts whose session ended, through the import config, after the queue settles", async () => {
		const repo = fs.mkdtempSync(path.join(tmp, "corpus-cwd-"));
		spawnSync("git", ["init", "-q", repo]);
		const f = transcript(`corpus-end-${n}`, [claudeLine("user", "hello")]);
		const trigger = (session, event) => am.hook("claude-code", JSON.stringify({ session_id: session, transcript_path: f, cwd: repo, hook_event_name: event }), { spawnRun: false });
		let judgmentCalls = 0;
		const runner = { ...keepAllRunner(), exec: async () => { judgmentCalls++; throw new Error("judgment is disabled"); } };
		trigger("c1", "SessionEnd");
		assert.equal((await am.run({ server: fakeServer(), runner, debounceMs: 0 })).results.corpus, undefined, "no config, no corpus work");
		const token = path.join(tmp, `corpus-token-${n}`), cfg = path.join(tmp, `corpus-upload-${n}.json`);
		fs.writeFileSync(token, "am_import_fake", { mode: 0o600 });
		fs.writeFileSync(cfg, JSON.stringify({ server: "http://127.0.0.1:9", token_file: token }), { mode: 0o600 });
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ corpus_profile: "test", corpus_config: cfg }));
		trigger("c2", "Stop");
		assert.equal((await am.run({ server: fakeServer(), runner, debounceMs: 0 })).results.corpus, undefined, "only an ended session triggers it");
		trigger("c3", "SessionEnd");
		// The checkout has no origin, so the corpus CLI refuses it before any request (the configured server is a closed port).
		assert.deepEqual((await am.run({ server: fakeServer(), runner, debounceMs: 0 })).results.corpus, { status: "incomplete", checkouts: 1 });
		assert.equal(judgmentCalls, 0, "corpus_profile alone never opts into judgment");
	});
});


describe("self-host corpus judgment closure", () => {
	it("stages and loads the judgment module with its existing CLI closure", async () => {
		const { stageSelfHost } = await import("./package.mjs");
		const { fileURLToPath, pathToFileURL } = await import("node:url");
		const root = fileURLToPath(new URL("../", import.meta.url));
		const stage = path.join(fs.mkdtempSync(path.join(tmp, "judgment-package-")), "source");
		stageSelfHost(root, stage);
		const file = "local/corpus-judgment.mjs";
		for (const manifest of [JSON.parse(fs.readFileSync(path.join(root, "package.json"))), JSON.parse(fs.readFileSync(path.join(stage, "package.json")))]) {
			assert.ok(manifest.files.includes(file));
		}
		assert.deepEqual(fs.readFileSync(path.join(stage, file)), fs.readFileSync(path.join(root, file)));
		assert.equal(fs.statSync(path.join(stage, file)).mode & 0o777, 0o644);
		assert.equal(typeof (await import(pathToFileURL(path.join(stage, "local/corpus-cli.mjs")).href)).main, "function");
	});
});

describe("Claude Code stream gate: thinking-token progress frames", () => {
	const MODEL = "claude-sonnet-5-5";
	const frame = (e) => `${JSON.stringify(e)}\n`;
	const init = frame({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: MODEL, permissionMode: "dontAsk" });
	const gate = init + frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 });
	const answer = frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "{\"results\":[]}" });
	// The CLI 2.1.316 frame shape (SDK schema plus its stream-json wrapper, which adds uuid and session_id).
	const thinking = (extra = {}) => frame({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40, estimated_tokens_delta: 40, uuid: "u", session_id: "s", ...extra });
	// A fake CLI: the gate turn on the shouldQuery:false line, the query frames on the next; "close" only after both streams end.
	const fakeClaude = (gateOut, queryOut) => {
		const proc = { lines: [], signals: [] };
		proc.spawnFn = () => {
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			let closed = false;
			const close = (code, sig) => {
				if (closed) return;
				closed = true;
				let open = 2;
				for (const s of [child.stdout, child.stderr]) { s.on("end", () => { if (!--open) setImmediate(() => child.emit("close", code, sig)); }); s.end(); }
			};
			child.kill = (sig) => { proc.signals.push(sig); proc.atKill = proc.onKill?.(); close(null, sig); return true; };
			child.stdin = new Writable({ write(chunk, _enc, done) {
				const m = JSON.parse(chunk);
				proc.lines.push(m);
				setImmediate(() => {
					if (closed) return;
					if (m.shouldQuery === false) return void child.stdout.write(gateOut);
					child.stdout.write(queryOut);
					close(0, null);
				});
				done();
			} });
			return child;
		};
		return proc;
	};
	const job = { prompt: "do it\n<items>\n[]\n</items>\n", schema: {}, model: MODEL, effort: "low" };
	const exec = (proc) => am.claudeExec({ claude: "never-run", runDir: tmp, env: {}, spawnFn: proc.spawnFn })(job);

	it("applies the result of a query turn that streams exact thinking_tokens progress frames (P1 evidence sequence)", async () => {
		const proc = fakeClaude(gate, init + thinking() + thinking({ estimated_tokens: 90, estimated_tokens_delta: 50, user_message_uuid: "m" }) + answer);
		assert.deepEqual(await exec(proc), { kind: "ok", part: { results: [] } });
		assert.deepEqual([proc.lines.length, proc.signals], [2, []]);
		assert.ok(!fs.existsSync(path.join(am.home(), "diagnostics")), "a parsed result leaves no diagnostic");
	});

	it("keeps an unparsable query result only as a new redacted mode-600 file under the home, written before the kill", async () => {
		const diag = path.join(am.home(), "diagnostics");
		const secrets = ["Bearer abcdefghijklmnop", "sk-ABCDEFGHIJKLMNOPQRSTUV", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz", "hunter2pass"];
		// Two fenced objects are ambiguous, so this result is kept.
		const text = `\`\`\`json\n{"results":[]}\n\`\`\` ${secrets[0]} ${secrets[1]}\n\`\`\`json\n{"results":[]}\n\`\`\` ${secrets[2]} password: ${secrets[3]}`;
		const proc = fakeClaude(gate, init + thinking() + frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, token: "frame-level-token" }));
		proc.onKill = () => (fs.existsSync(diag) ? fs.readdirSync(diag) : []);
		assert.deepEqual(await exec(proc), { kind: "bad_output" });
		assert.deepEqual(proc.signals, ["SIGKILL"]);
		const files = fs.readdirSync(diag);
		assert.equal(files.length, 1);
		assert.deepEqual(proc.atKill, files, "retained before the kill");
		const file = path.join(diag, files[0]), st = fs.lstatSync(file);
		assert.ok(st.isFile() && (st.mode & 0o777) === 0o600 && (fs.statSync(diag).mode & 0o777) === 0o700);
		const kept = fs.readFileSync(file, "utf8");
		for (const s of [...secrets, "abcdefghijklmnop", "frame-level-token"]) assert.ok(!kept.includes(s), s);
		assert.ok(kept.includes("```json") && kept.includes("[REDACTED]") && kept.includes("\"subtype\":\"success\""), "the frame's shape survives");
		// A second failure gets its own new file; nothing is overwritten.
		await exec(fakeClaude(gate, init + frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "not json" })));
		assert.equal(fs.readdirSync(diag).length, 2);
	});

	it("still fails closed on a thinking_tokens frame in the gate turn, after the result, before the re-init or of any other shape", async () => {
		const gateResult = frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 });
		const cases = [[init + thinking() + gateResult, init + answer], [gate, init + answer + thinking()], [gate, thinking() + init + answer],
			[gate, init + thinking({ text: "x" }) + answer], [gate, init + thinking({ estimated_tokens: 1.5 }) + answer],
			[gate, init + thinking({ estimated_tokens_delta: "1" }) + answer], [gate, init + thinking({ uuid: undefined }) + answer],
			[gate, init + thinking({ user_message_uuid: 1 }) + answer]];
		for (const [g, q] of cases) assert.deepEqual(await exec(fakeClaude(g, q)), { kind: "runtime_warning" }, q);
	});
});

describe("Claude Code query result: pure JSON, or exactly one object with prose or one json fence around it", () => {
	const MODEL = "claude-sonnet-5-5";
	const ok = { results: [{ item_id: 1, ops: [{ op: "dismiss" }] }] }, okJson = JSON.stringify(ok);
	const frame = (e) => `${JSON.stringify(e)}\n`;
	const init = frame({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: MODEL, permissionMode: "dontAsk" });
	const gate = init + frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 });
	const thinking = frame({ type: "system", subtype: "thinking_tokens", estimated_tokens: 40, estimated_tokens_delta: 40, uuid: "u", session_id: "s" });
	// Batch 1 (06:06) and batch 2 (06:12) as observed: re-init, thinking-token frames, then (batch 2) a thinking and a text
	// assistant frame, an allowed rate-limit event and the result.
	const assistant = (block) => frame({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [block] } });
	const seq1 = (text) => init + thinking + frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text });
	const seq2 = (text) => init + thinking.repeat(7) + assistant({ type: "thinking", thinking: "t" }) + assistant({ type: "text", text })
		+ frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }) + frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text });
	const spawnFor = (queryOut) => () => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		let closed = false;
		const close = (code, sig) => {
			if (closed) return;
			closed = true;
			let open = 2;
			for (const st of [child.stdout, child.stderr]) { st.on("end", () => { if (!--open) setImmediate(() => child.emit("close", code, sig)); }); st.end(); }
		};
		child.kill = (sig) => { close(null, sig); return true; };
		child.stdin = new Writable({ write(chunk, _enc, done) {
			const m = JSON.parse(chunk);
			setImmediate(() => {
				if (closed) return;
				if (m.shouldQuery === false) return void child.stdout.write(gate);
				child.stdout.write(queryOut);
				close(0, null);
			});
			done();
		} });
		return child;
	};
	// The real caller: batch() validates every accepted value against the full OPS_SCHEMA before any item operation.
	const run = async (queryOut) => {
		const calls = [];
		const lease = { lease_id: "L", lease_until: new Date(Date.now() + 900_000).toISOString(), items: [{ item_id: 1, kind: "unlinked", subjects: ["a"], allowed_ops: ["dismiss"], context: { nodes: [{ id: "a", passage: "p" }], edges: [] } }] };
		const server = { async call(name, args) { calls.push({ name, args }); return name === "maintenance_next" ? lease : { results: [{ status: "done", ops: [{ op: "dismiss", status: "applied" }] }] }; } };
		const runner = { available: true, classification: "denied", batchExec: am.claudeExec({ claude: "never-run", runDir: tmp, env: {}, spawnFn: spawnFor(queryOut) }) };
		await batch({ runner, config: { batch_runner: "claude", batch_profiles: ["work"], batch_luna_model: MODEL, batch_terra_model: MODEL }, server });
		return calls[1].args;
	};
	const diagFiles = () => { const d = path.join(am.home(), "diagnostics"); return fs.existsSync(d) ? fs.readdirSync(d).length : 0; };

	it("applies a schema-valid result in both observed sequences: pure JSON, one json fence, or one object inside prose", async () => {
		const accepted = [okJson, `\`\`\`json\n${okJson}\n\`\`\``, `  \`\`\`json  \r\n${JSON.stringify(ok, null, 2)}\n\`\`\`\n`,
			`Here are the results, as "asked":\n\`\`\`json\n${okJson}\n\`\`\`\nThat's all.`, `Here's the result: ${okJson} (one item, it's done).`];
		for (const text of accepted) for (const seq of [seq1, seq2]) assert.deepEqual(await run(seq(text)), { profile: "work", lease_id: "L", results: ok.results }, text);
		assert.equal(diagFiles(), 0, "an accepted result is not retained");
	});

	it("fails closed on several objects or fences, an array around a full valid result, another fence language, an unclosed or malformed object, and a schema-invalid value", async () => {
		const rejected = [`${okJson}\n${okJson}`, `\`\`\`json\n${okJson}\n\`\`\`\n\`\`\`json\n${okJson}\n\`\`\``, `\`\`\`json\n${okJson}\n\`\`\`\n\`\`\`bash\nls\n\`\`\``,
			`\`\`\`python\n${okJson}\n\`\`\``, `\`\`\`json\n${okJson}`, `Use {placeholder} then ${okJson}`, `${okJson} then {`, `{"results": [`, "{results: []}", "no json here", "",
			`Results: [${okJson}]`];
		for (const text of rejected) assert.deepEqual(await run(seq2(text)), { profile: "work", lease_id: "L", status: "batch_skipped", reason: "bad_output" }, text);
		assert.equal(diagFiles(), rejected.length, "every unparsable result is retained");
		// Extracted, then refused by the full schema: an unknown op, an extra key, a missing field.
		for (const bad of [{ results: [{ item_id: 1, ops: [{ op: "nuke" }] }] }, { ...ok, extra: 1 }, { results: [{ item_id: 1 }] }]) {
			assert.deepEqual(await run(seq2(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``)), { profile: "work", lease_id: "L", status: "batch_skipped", reason: "bad_output" });
		}
	});

	it("scans strings quote- and escape-aware, so braces, quotes and fences inside them never split or add an object", () => {
		const tricky = { results: [], note: "a } b { c \\\" d ``` e \\\\" };
		assert.deepEqual(am.resultJson(`Result: ${JSON.stringify(tricky)} done.`), { value: tricky });
		assert.deepEqual(am.resultJson(`\`\`\`json\n${JSON.stringify(tricky)}\n\`\`\``), { value: tricky });
		assert.equal(am.resultJson('Result: {"a": "unclosed}'), null);
		assert.equal(am.resultJson("Result: [1, 2]"), null);
		assert.deepEqual(am.resultJson("[1]"), { value: [1] }, "pure JSON is unchanged; the schema rejects it later");
	});
});

describe("v2 config defaults and the separate read token", () => {
	const writeConfig = (c) => am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify(c));
	/** Records each request; answers 200 with {ok: true}. */
	const recordFetch = async (fn) => {
		const seen = [], real = globalThis.fetch;
		globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.authorization, redirect: init.redirect, body: init.body }); return new Response('{"ok":true}', { status: 200 }); };
		try { await fn(); } finally { globalThis.fetch = real; }
		return seen;
	};

	it("keeps a v1 config as written, adds the v2 defaults, and turns injection on only with enabled and an explicit profile", () => {
		const v1 = { server: "https://memory.example", token_file: "/x/job-token", batch_profiles: ["work"], debounce_ms: 5 };
		writeConfig(v1);
		const c = am.loadConfig();
		for (const [k, v] of Object.entries(v1)) assert.deepEqual(c[k], v);
		assert.equal(c.batch_hour, 4);
		assert.equal(c.read_token_file, path.join(am.home(), "read-token"));
		assert.deepEqual(c.inject, { enabled: false, profile: null, max_tokens: 600, timeout_ms: 1500 });
		assert.equal(am.withDefaults({ inject: { enabled: true } }).inject.enabled, false);
		assert.equal(am.withDefaults({ inject: { enabled: "true", profile: "work" } }).inject.enabled, false);
		assert.deepEqual(am.withDefaults({ inject: { enabled: true, profile: "Work Stuff" } }).inject, { enabled: false, profile: null, max_tokens: 600, timeout_ms: 1500 });
		assert.deepEqual(am.withDefaults({ inject: { enabled: true, profile: "personal", max_tokens: 900, timeout_ms: 0 } }).inject, { enabled: true, profile: "personal", max_tokens: 900, timeout_ms: 1500 });
		assert.equal(am.withDefaults({ batch_hour: 24 }).batch_hour, 4);
		assert.equal(am.withDefaults({ batch_hour: 0 }).batch_hour, 0);
	});

	it("recalls with the read token only, never the job token, and names the caller's profile", async () => {
		const job = path.join(am.home(), "job-token"), read = path.join(am.home(), "read-token");
		am.writePrivate(job, "job-secret\n");
		const config = am.withDefaults({ server: "https://memory.example", token_file: job });
		// No read token: refused before any request, with no job-token fallback.
		let seen = await recordFetch(() => assert.rejects(am.readServer(config).recall({ profile: "work", query: "q" }), { code: "read_token_missing" }));
		assert.deepEqual(seen, []);
		am.writePrivate(read, "read-secret\n");
		seen = await recordFetch(() => assert.rejects(am.readServer(config).recall({ query: "q" }), { code: "profile_required" }));
		assert.deepEqual(seen, []);
		seen = await recordFetch(async () => assert.deepEqual(await am.readServer(config).recall({ profile: "work", query: "q" }), { ok: true }));
		assert.deepEqual(seen, [{ url: "https://memory.example/v1/recall", method: "POST", auth: "Bearer read-secret", redirect: "error", body: '{"profile":"work","query":"q"}' }]);
		// read_token_file naming the job token file is refused, even though that file is private and valid.
		assert.equal(am.readToken({ ...config, read_token_file: job }), null);
		assert.equal(am.readToken({ ...config, read_token_file: `${path.dirname(job)}/./job-token` }), null);
		// A group-readable file or a symlink is refused.
		fs.chmodSync(read, 0o640);
		assert.equal(am.readToken(config), null);
		fs.chmodSync(read, 0o600);
		const link = path.join(am.home(), "read-link");
		fs.symlinkSync(read, link);
		assert.equal(am.readToken({ ...config, read_token_file: link }), null);
		assert.equal(am.readToken(config), "read-secret");
	});

	it("reads accepted candidates with the read token only, an explicit profile and checked paging arguments", async () => {
		const job = path.join(am.home(), "job-token"), read = path.join(am.home(), "read-token");
		am.writePrivate(job, "job-secret\n");
		const config = am.withDefaults({ server: "https://memory.example", token_file: job });
		const list = (q) => am.readServer(config).acceptedCandidates(q);
		let seen = await recordFetch(() => assert.rejects(list({ profile: "work" }), { code: "read_token_missing" }));
		assert.deepEqual(seen, []);
		am.writePrivate(read, "read-secret\n");
		seen = await recordFetch(async () => {
			for (const q of [{}, { profile: "" }, { profile: "Work" }, { profile: "a-profile-name" }]) await assert.rejects(list(q), { code: "profile_required" });
			for (const cursor of ["", "x".repeat(2049), 7]) await assert.rejects(list({ profile: "work", cursor }), { code: "cursor_invalid" });
			for (const limit of [0, 101, 1.5, "10"]) await assert.rejects(list({ profile: "work", limit }), { code: "limit_invalid" });
		});
		assert.deepEqual(seen, []);
		seen = await recordFetch(async () => {
			assert.deepEqual(await list({ profile: "work" }), { ok: true });
			await list({ profile: "work", cursor: "c/1&x=2", limit: 100 });
		});
		assert.deepEqual(seen, [
			{ url: "https://memory.example/v1/eval/candidates?profile=work", method: "GET", auth: "Bearer read-secret", redirect: "error", body: undefined },
			{ url: "https://memory.example/v1/eval/candidates?profile=work&cursor=c%2F1%26x%3D2&limit=100", method: "GET", auth: "Bearer read-secret", redirect: "error", body: undefined }]);
		const real = globalThis.fetch;
		globalThis.fetch = async () => new Response('{"error":{"code":"forbidden"}}', { status: 403 });
		try { await assert.rejects(list({ profile: "work" }), { status: 403 }); } finally { globalThis.fetch = real; }
	});

	it("sends status, eval runs and the device's own whoami with the job token", async () => {
		const job = path.join(am.home(), "job-token");
		am.writePrivate(job, "job-secret\n");
		const s = am.httpServer({ server: "https://memory.example", token_file: job });
		const seen = await recordFetch(async () => { await s.status({ device: "d" }); await s.evalRun({ profile: "work" }); await s.whoami(); });
		assert.deepEqual(seen.map((r) => [r.method, r.url, r.auth, r.redirect]), [
			["POST", "https://memory.example/v1/status", "Bearer job-secret", "error"],
			["POST", "https://memory.example/v1/eval/runs", "Bearer job-secret", "error"],
			["GET", "https://memory.example/v1/whoami", "Bearer job-secret", "error"]]);
	});

	it("keeps every default eval report when runs share a time and channels; an explicit --out is replaced", async () => {
		const { main } = await import("./eval.mjs");
		const job = path.join(am.home(), "job-token"), read = path.join(am.home(), "read-token"), cases = path.join(am.home(), "cases.json");
		am.writePrivate(job, "job-secret\n");
		am.writePrivate(read, "read-secret\n");
		writeConfig({ server: "https://memory.example", token_file: job });
		fs.writeFileSync(cases, JSON.stringify({ schema_version: 1, cases: [{ id: "c1", query: "one", expected: ["m1"] }, { id: "c2", query: "two", expected: ["m2"] }] }));
		const dir = path.join(am.home(), "eval"), old = path.join(dir, "2026-11-05-hybrid.json");
		am.writePrivate(old, "earlier default report\n");
		const realFetch = globalThis.fetch, realNow = Date.now;
		// work finds m1 and personal finds m2, so each report has a different miss.
		globalThis.fetch = async (url, init) => Response.json(new URL(url).pathname === "/v1/recall" ? { results: [{ memory_id: JSON.parse(init.body).profile === "work" ? "m1" : "m2" }] } : { ok: true });
		Date.now = () => Date.parse("2026-11-05T09:30:00.000Z");
		const quiet = process.stdout.write;
		process.stdout.write = () => true;
		const run = (...args) => main(["--cases", cases, "--channels", "hybrid", ...args]);
		try {
			assert.equal(await run("--profile", "work"), 0);
			assert.equal(await run("--profile", "personal"), 0);
			const out = path.join(am.home(), "chosen.json");
			am.writePrivate(out, "replace me\n");
			assert.equal(await run("--profile", "work", "--out", out), 0);
			assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).misses.map((m) => m.case), ["c2"]);
		} finally { globalThis.fetch = realFetch; Date.now = realNow; process.stdout.write = quiet; }
		assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-11-05-hybrid.json", "2026-11-05T093000.000Z-hybrid-2.json", "2026-11-05T093000.000Z-hybrid.json"]);
		assert.equal(fs.readFileSync(old, "utf8"), "earlier default report\n");
		const report = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		assert.deepEqual(report("2026-11-05T093000.000Z-hybrid.json").misses.map((m) => m.case), ["c2"]);
		assert.deepEqual(report("2026-11-05T093000.000Z-hybrid-2.json").misses.map((m) => m.case), ["c1"]);
		for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
	});
});

describe("capture hooks, scheduled runs and status (#16)", () => {
	const queuedTrigger = (name) => JSON.parse(fs.readFileSync(path.join(am.home(), "queue", name), "utf8"));

	it("queues PreCompact like Stop, never queues UserPromptSubmit, and keeps a SessionEnd's ended through a later trigger", () => {
		am.hook("claude-code", JSON.stringify({ hook_event_name: "PreCompact", session_id: "s-pc", transcript_path: null, cwd: "/w", trigger: "manual" }), { spawnRun: false });
		assert.equal(queuedTrigger("claude-code-s-pc.json").event, "PreCompact");
		am.hook("claude-code", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-up", prompt: "secret prompt", cwd: "/w" }), { spawnRun: false });
		assert.ok(!fs.existsSync(path.join(am.home(), "queue", "claude-code-s-up.json")));
		am.hook("codex", JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-end", cwd: "/w" }), { spawnRun: false });
		am.hook("codex", JSON.stringify({ hook_event_name: "Stop", session_id: "s-end", cwd: "/w" }), { spawnRun: false });
		assert.equal(queuedTrigger("codex-s-end.json").ended, true);
	});

	it("keeps ended from a SessionEnd a crashed run claimed, when a later Stop replaces it and recovery drops the claim", async () => {
		const f = transcript("ended", [claudeLine("user", "We decided to keep the end marker.")]);
		const hook = (event) => am.hook("claude-code", JSON.stringify({ session_id: "ended", transcript_path: f, cwd: tmp, hook_event_name: event }), { spawnRun: false });
		hook("SessionEnd");
		// A run claims the SessionEnd, then dies before it saves the session's ended state.
		fs.mkdirSync(path.join(am.home(), "claimed"), { recursive: true });
		fs.renameSync(path.join(am.home(), "queue", "claude-code-ended.json"), path.join(am.home(), "claimed", "claude-code-ended.json"));
		hook("Stop");
		const server = fakeServer();
		await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "claimed")), [], "recovery dropped the superseded claim");
		assert.ok(server.log.some((b) => b.session.ended === true), "the session still reports that it ended");
	});

	it("drops an injected text block beside the owner's own text, for Claude Code and Codex, before any digest or literal", () => {
		const claude = { pos: 0, next: 1, obj: { type: "user", message: { content: [{ type: "text", text: "owner text with `kept.ts`" }, { type: "text", text: "<environment_context>INJECTED /secret/path</environment_context>" }] } } };
		const codex = { pos: 0, next: 1, obj: { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "<user_instructions>INJECTED</user_instructions>" }, { type: "text", text: "do it" }] } } } };
		const m = [...am.extract("claude-code", [claude]), ...am.extract("codex", [codex])];
		assert.deepEqual(m.map((x) => x.text), ["owner text with `kept.ts`", "do it"]);
		assert.deepEqual(am.literals(m), ["kept.ts"]);
		assert.ok(!JSON.stringify(am.heuristicDigest(m)).includes("INJECTED"));
		// A command record stays out whole, as when its text is one string: its later blocks are command output, not the owner's.
		for (const lead of ["<command-name>/context</command-name>", "<local-command-stdout>ok</local-command-stdout>"]) {
			assert.deepEqual(am.extract("claude-code", [{ pos: 0, next: 1, obj: { type: "user", message: { content: [{ type: "text", text: lead }, { type: "text", text: "INJECTED /secret/path" }] } } }]), []);
		}
	});

	it("sends ended and the distinct edited-file count on the session, never a path, and reports an end with nothing new in an empty batch", async () => {
		const server = fakeServer();
		const edit = (name, input) => ({ type: "tool_use", name, input });
		const f = transcript("edits", [claudeLine("user", "change things"),
			claudeLine("assistant", [edit("Edit", { file_path: "/w/a.ts" }), edit("Write", { file_path: "b.ts" }), edit("MultiEdit", { file_path: "/w/a.ts" }), edit("Read", { file_path: "/w/r.ts" })], { version: "2.1.316" })]);
		await am.processSession(trigger("claude-code", "edits", f, "/w"), { server, runner: null });
		assert.deepEqual(server.log[0].session, { client: "claude-code", id: "edits", files_changed: 2 });
		const state = fs.readFileSync(am.statePath("claude-code", "edits"), "utf8");
		assert.ok(!state.includes("a.ts") && !state.includes("b.ts"), "only hashes of the paths are kept");
		await am.processSession({ ...trigger("claude-code", "edits", f, "/w"), event: "SessionEnd" }, { server, runner: null });
		assert.deepEqual(server.log.at(-1), { session: { client: "claude-code", id: "edits", ended: true, files_changed: 2 }, digests: [], manifests: [] });
		const sent = server.log.length;
		await am.processSession(trigger("claude-code", "edits", f, "/w"), { server, runner: null });
		assert.equal(server.log.length, sent, "the end is reported once");
		assert.ok(!server.log.some((b) => JSON.stringify(b).includes("/w/a.ts")));
		const s = am.captureSummary();
		assert.equal(s.clients["claude-code"], "2.1.316");
		assert.equal(s.pending_ranges, 1);
		assert.ok(!JSON.stringify(s).includes("edits"), "the report carries no session id");
		assert.equal(am.captureSummary({ ids: true }).local.pending[0].session, "edits");
	});

	it("resends a batch without ended and files_changed only on a pre-v2 server's exact refusal of them, leaving the batch unchanged", async () => {
		const job = path.join(am.home(), "job-token");
		am.writePrivate(job, "job-secret\n");
		const s = am.httpServer({ server: "https://memory.example", token_file: job });
		const sent = [], real = globalThis.fetch;
		let message = "session: Unrecognized keys: \"ended\", \"files_changed\"";
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(init.body);
			sent.push(body.session);
			return Object.keys(body.session).length > 2 ? new Response(JSON.stringify({ error: { code: "validation", message } }), { status: 400 }) : new Response('{"results":[]}', { status: 200 });
		};
		try {
			const batch = { session: { client: "codex", id: "x", ended: true, files_changed: 3 }, digests: [], manifests: [] };
			assert.deepEqual(await s.ingest(batch), []);
			assert.deepEqual(sent, [{ client: "codex", id: "x", ended: true, files_changed: 3 }, { client: "codex", id: "x" }]);
			assert.deepEqual(batch.session, { client: "codex", id: "x", ended: true, files_changed: 3 });
			sent.length = 0;
			message = "session: Unrecognized key: \"ended\"; digests.0: Unrecognized key: \"zz\"";
			await assert.rejects(s.ingest(batch), (e) => e.status === 400);
			assert.equal(sent.length, 1, "any other refusal is not retried");
		} finally { globalThis.fetch = real; }
	});

	it("installs PreCompact async for both clients, UserPromptSubmit only with injection on, and writes the test-label plist without loading it", () => {
		const fakeHome = fs.mkdtempSync(path.join(tmp, "user-home-")), saved = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			const r = am.install({ platform: "darwin" });
			assert.deepEqual(Object.keys(r.claude.hooks), ["Stop", "SessionEnd", "SessionStart", "PreCompact"]);
			assert.equal(r.claude.hooks.PreCompact[0].hooks[0].async, true);
			assert.match(r.codex, /\[\[hooks\.PreCompact\.hooks\]\]\ntype = "command"\ncommand = ".*hook codex"\nasync = true/);
			assert.equal(r.launchd.label, "com.agent-memory.batch.test");
			assert.equal(r.launchd.plist, path.join(fakeHome, "Library", "LaunchAgents", "com.agent-memory.batch.test.plist"));
			assert.equal(fs.statSync(r.launchd.plist).mode & 0o777, 0o644);
			// Compared with whitespace between tags removed; the test paths hold no characters the plist escapes besides & < >.
			const job = fs.readFileSync(r.launchd.plist, "utf8").replace(/>\s+</g, "><"), esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			assert.ok(job.includes(`<array><string>${esc(r.node)}</string><string>${esc(r.bin)}</string><string>run</string><string>--scheduled</string></array>`), "bin/node, then the CLI, then run --scheduled");
			assert.ok(job.includes(`<key>AGENT_MEMORY_HOME</key><string>${esc(am.home())}</string>`));
			assert.ok(job.includes(`<key>PATH</key><string>${esc(process.env.PATH)}</string>`));
			assert.match(r.launchd.load, /^launchctl bootstrap gui\//);
			for (const f of am.V2_LOCAL) assert.deepEqual(fs.readFileSync(path.join(path.dirname(r.bin), f)), fs.readFileSync(new URL(`./${f}`, import.meta.url)));
			am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ inject: { enabled: true, profile: "work", timeout_ms: 1500 } }));
			const on = am.install({ platform: "linux" });
			assert.equal(on.launchd, null);
			assert.deepEqual(on.claude.hooks.UserPromptSubmit[0].hooks[0], { type: "command", command: `${on.node} ${on.bin} hook claude-code`, timeout: 3 });
			assert.match(on.codex, /\[\[hooks\.UserPromptSubmit\.hooks\]\][^[]*timeout = 3/);
		} finally { process.env.HOME = saved; }
	});

	it("run --scheduled with nothing queued and no batch profile sends its status and returns without a runner", async () => {
		const reports = [], server = { ...fakeServer(), status: async (b) => { reports.push(b); } };
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [] }));
		const idle = await am.run({ server, runner: { available: false, run() { throw new Error("no runner"); } }, trigger: "scheduled" });
		assert.equal(idle.status, "idle");
		assert.equal(idle.results.status, "sent");
		assert.equal(reports[0].launchd_loaded, false);
		assert.deepEqual(launchctlCalls, process.platform === "darwin" ? [["print", `gui/${process.getuid()}/com.agent-memory.batch.test`]] : []);
		assert.deepEqual(Object.keys(reports[0]).sort(), ["clients", "hooks", "inject", "last_digest_at", "launchd_loaded", "missing_sources", "oldest_pending_at",
			"oldest_spool_at", "pending_ranges", "refused_since_last", "spool_bytes", "spool_files", "stuck_ranges"]);
		// The batch has no cooldown: a configured batch profile makes every scheduled run drain, so there is no due check to export.
		assert.equal(am.batchDue, undefined);
	});

	it("run --scheduled recovers a trigger a crashed run left claimed, instead of returning idle", async () => {
		const server = { ...fakeServer(), status: async () => {} };
		const f = transcript("stranded", [claudeLine("user", "We decided to keep the claim recovery.")]);
		// A claim is renamed out of queue/, so the queue directory exists whenever a claim does.
		fs.mkdirSync(path.join(am.home(), "queue"), { recursive: true });
		am.writePrivate(path.join(am.home(), "claimed", "claude-code-stranded.json"), JSON.stringify({ ...trigger("claude-code", "stranded", f), gen: "crashed" }));
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0, trigger: "scheduled" });
		assert.equal(r.status, "ran");
		assert.equal(r.results["claude-code-stranded.json"].status, "done");
		assert.ok(server.log.some((b) => b.session.id === "stranded"), "the stranded session was captured");
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "claimed")), []);
	});

	// One run() whose first maintenance_next fires a hook ("during"). `leases` maps a profile to the replies of its successive
	// maintenance_next calls (then idle); `judge` stands in for the confined model, `complete` for the server's per-item reply.
	// Each maintenance_next records whether "during" was already captured. With `late`, the first status report fires another
	// hook, so the run drains a second time.
	async function learnRun(profiles, leases, judge, { complete = { results: [{ status: "done", ops: [{ op: "dismiss", status: "applied" }] }] }, late = false, clock = Date.now } = {}) {
		const first = transcript("first", [claudeLine("user", "We decided to batch on every drain.")]), during = transcript("during", [claudeLine("user", "We decided to capture the hook.")]);
		const after = transcript("after", [claudeLine("user", "We decided to drain again.")]);
		const tokenFile = path.join(am.home(), "job-token");
		am.writePrivate(tokenFile, "job");
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: profiles, server: "https://memory.example.invalid", token_file: tokenFile }));
		am.hook("claude-code", JSON.stringify({ session_id: "first", transcript_path: first, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false });
		const asked = [], seen = [], real = globalThis.fetch;
		let statuses = 0;
		const server = { ...fakeServer(), status: async () => { if (late && !statuses++) am.hook("claude-code", JSON.stringify({ session_id: "after", transcript_path: after, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false }); } };
		globalThis.fetch = async (_url, init = {}) => {
			const { name, arguments: args } = JSON.parse(init.body).params;
			let reply = typeof complete === "function" ? complete(name) : complete;
			if (name === "maintenance_next") {
				seen.push(server.log.some((b) => b.session.id === "during"));
				if (asked.push(args.profile) === 1) am.hook("claude-code", JSON.stringify({ session_id: "during", transcript_path: during, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false });
				reply = leases[args.profile]?.shift() ?? { lease_id: null, items: [], next_allowed_at: null };
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(reply) }] } }), { status: 200 });
		};
		const runner = Object.assign(keepAllRunner(), { classification: "denied", exec: judge });
		try {
			const r = await am.run({ server, runner, debounceMs: 0, clock });
			assert.equal(r.results["claude-code-during.json"].status, "done", "the hook that fired during the batch was drained");
			const last = JSON.parse(fs.readFileSync(path.join(am.home(), "batch", "last.json"), "utf8"));
			assert.deepEqual(r.results.batch.profiles, last.profiles);
			return { asked, seen, r, last };
		} finally { globalThis.fetch = real; }
	}
	const leaseOf = (id) => ({ lease_id: id, lease_until: new Date(Date.now() + 900_000).toISOString(),
		items: [{ item_id: 1, kind: "unlinked", subjects: ["a"], allowed_ops: ["dismiss"], context: { nodes: [{ id: "a", passage: "p" }], edges: [] } }] });
	const dismiss = async () => ({ kind: "ok", part: { results: [{ item_id: 1, ops: [{ op: "dismiss" }] }] } });

	it("keeps leasing a profile in one drain until its queue is empty, capturing a hook that fired during a lease before the next one", async () => {
		const { asked, seen, r, last } = await learnRun(["work"], { work: [leaseOf("L1"), leaseOf("L2"), leaseOf("L3")] }, dismiss);
		assert.deepEqual(asked, ["work", "work", "work", "work"], "three clean leases, then an empty one");
		assert.deepEqual(seen, [false, true, true, true], "the hook from the first lease was captured before the second");
		assert.deepEqual([r.results.batch.leases, last.leases, last.profiles.work.status], [3, 3, "idle"]);
	});

	it("leases an idle profile again after a capture pass handles a session, until it is idle with nothing left to capture", async () => {
		// The queue is empty when the hook fires; capturing that session adds work, so learning starts again in the same drain.
		const empty = { lease_id: null, items: [], next_allowed_at: null };
		const { asked, seen, r } = await learnRun(["work"], { work: [empty, leaseOf("L1")] }, dismiss);
		assert.deepEqual(asked, ["work", "work", "work"], "idle, then the new item, then idle with no trigger waiting");
		assert.deepEqual(seen, [false, true, true]);
		assert.equal(r.results.batch.leases, 1);
	});

	it("leases a profile again in the same drain after a lease that ran out of time but settled items", async () => {
		// The first completion takes 15 minutes on the run's clock, so the lease's second item is never sent.
		let skew = 0, completes = 0;
		const complete = (name) => {
			if (name === "maintenance_complete" && !completes++) skew = 900_000;
			return { results: [{ status: "done", ops: [{ op: "dismiss", status: "applied" }] }] };
		};
		const two = leaseOf("L1");
		two.items.push({ ...two.items[0], item_id: 2 });
		const later = { ...leaseOf("L2"), lease_until: new Date(Date.now() + 1_800_000).toISOString() };
		const judge = async () => ({ kind: "ok", part: { results: [1, 2].map((id) => ({ item_id: id, ops: [{ op: "dismiss" }] })) } });
		const { asked, r } = await learnRun(["work"], { work: [two, later] }, judge, { complete, clock: () => Date.now() + skew });
		assert.deepEqual(asked, ["work", "work", "work"], "the time-limited lease, the next lease, then idle");
		assert.deepEqual([completes, r.results.batch.leases], [2, 2], "item 2 of the first lease was never sent");
	});

	it("handles a trigger that fired during one profile's lease before the next profile's lease", async () => {
		const { asked, seen } = await learnRun(["personal", "work"], { personal: [leaseOf("LP")], work: [leaseOf("LW")] }, dismiss);
		assert.deepEqual(asked, ["personal", "work", "personal", "work"]);
		assert.deepEqual(seen, [false, true, true, true], "the hook from personal's lease was captured before work's lease");
	});

	it("stops a profile after a discarded lease while a clean one continues, and every profile leases again on the next drain", async () => {
		let runs = 0;
		const judge = async (a) => (++runs === 2 ? { kind: "error" } : dismiss(a));
		const { asked, last } = await learnRun(["personal", "work"], { personal: [leaseOf("LP")], work: [leaseOf("LW"), leaseOf("LW2")] }, judge, { late: true });
		// Drain 1: personal is clean and goes again (idle); work is discarded and stops. Drain 2 (the late hook): both again.
		assert.deepEqual(asked, ["personal", "work", "personal", "personal", "work", "work"], "no per-run block after a failed lease");
		assert.deepEqual([last.profiles.personal.status, last.profiles.work.status, last.leases], ["idle", "idle", 3]);
	});

	it("stops a profile after a lease that settled no item, leaving the rest for the next run", async () => {
		// The model answers only on its second follow-up run, and the server rejects that answer.
		let runs = 0;
		const judge = async () => (++runs <= 2 ? { kind: "ok", part: { results: [] } } : dismiss());
		const complete = (name) => (name === "maintenance_complete"
			? { results: [{ item_id: 1, status: "rejected", reason: "moving", ops: [{ op: "dismiss", status: "rejected", code: "moving" }] }] } : {});
		const { asked, last } = await learnRun(["work"], { work: [leaseOf("L1"), leaseOf("L2")] }, judge, { complete });
		assert.deepEqual([asked, runs], [["work"], 3], "first run and 2 follow-ups, then no second lease");
		assert.deepEqual([last.profiles.work.status, last.profiles.work.completed, last.profiles.work.rejected], ["completed", 0, 1]);
	});

	it("run --scheduled drains a hook that fired while its idle status report held the lock", async () => {
		const f = transcript("late", [claudeLine("user", "We decided to keep the late hook.")]);
		let fired = 0;
		// The lock is held, so even a spawning hook would start no run; spawnRun: false keeps the test from ever spawning one.
		const server = { ...fakeServer(), status: async () => { if (!fired++) am.hook("claude-code", JSON.stringify({ session_id: "late", transcript_path: f, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false }); } };
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0, trigger: "scheduled" });
		assert.equal(r.status, "ran");
		assert.equal(r.results["claude-code-late.json"].status, "done");
		assert.ok(server.log.some((b) => b.session.id === "late"), "the late session was captured");
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "queue")), []);
	});

	it("keeps a recovered claim when returning it to the queue fails for any reason but a newer trigger", async () => {
		const f = transcript("nospace", [claudeLine("user", "We decided to keep the claim on a full disk.")]);
		fs.mkdirSync(path.join(am.home(), "queue"), { recursive: true });
		const claimed = path.join(am.home(), "claimed", "claude-code-nospace.json");
		am.writePrivate(claimed, JSON.stringify({ ...trigger("claude-code", "nospace", f), gen: "crashed" }));
		const server = { ...fakeServer(), status: async () => {} }, link = fs.linkSync;
		fs.linkSync = () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); };
		try { await assert.rejects(am.run({ server, runner: keepAllRunner(), debounceMs: 0, trigger: "scheduled" }), { code: "ENOSPC" }); } finally { fs.linkSync = link; }
		assert.ok(fs.existsSync(claimed), "the sole trigger survives");
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0, trigger: "scheduled" });
		assert.equal(r.results["claude-code-nospace.json"].status, "done");
		assert.ok(server.log.some((b) => b.session.id === "nospace"));
	});
});

describe("doctor and backfill (#18)", () => {
	it("doctor passes an installed setup with registered hooks and a private job token, and gives the bootstrap fix for an unloaded job", async () => {
		const fakeHome = fs.mkdtempSync(path.join(tmp, "user-home-")), saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
		Object.assign(process.env, { HOME: fakeHome, CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"), CODEX_HOME: path.join(fakeHome, ".codex") });
		try {
			const r = am.install({ platform: "darwin" });
			// The owner adds the printed hooks; doctor only reads them.
			am.writePrivate(path.join(fakeHome, ".claude", "settings.json"), JSON.stringify({ hooks: r.claude.hooks }));
			am.writePrivate(path.join(fakeHome, ".codex", "config.toml"), r.codex);
			am.writePrivate(path.join(am.home(), "job-token"), "device-job-token");
			const { doctorChecks, formatChecks } = await import("./doctor.mjs");
			const server = { whoami: async () => ({ kind: "device", device_id: "dev-1", scopes: ["ingest", "maintenance"] }) };
			const checks = await doctorChecks({ config: am.loadConfig(), server, platform: "darwin" });
			// codex_hook_trust fails: the printed hooks are not yet trusted in Codex (codex_hook_trust tests below).
			assert.deepEqual(checks.map((c) => [c.id, c.ok]), [["job_token", true], ["read_token", true], ["hooks", true], ["codex_hook_trust", false], ["launchd", false], ["spool", true],
				["capture", true], ["batch_learning", true], ["facts_profile_config", true], ["facts_pending", true], ["facts_inject_latency", true], ["loop_guard", true], ["facts_v1_pending", true], ["whoami", true]]);
			// The launchctl recorder answers "not loaded", so doctor prints the bootstrap command for the job install wrote.
			assert.equal(checks.find((c) => c.id === "launchd").fix, `Run: ${r.launchd.load}`);
			assert.ok(!formatChecks(checks).includes("device-job-token"), "doctor never prints the token");
			am.writePrivate(path.join(fakeHome, ".codex", "config.toml"), r.codex.split("\n\n").filter((h) => !h.includes("PreCompact")).join("\n\n"));
			const gap = (await doctorChecks({ config: am.loadConfig(), server, platform: "darwin" })).find((c) => c.id === "hooks");
			assert.deepEqual([gap.ok, gap.detail], [false, "codex is missing PreCompact"]);
		} finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
	});

	it("backfill queues each client's transcripts that are behind, the next run captures them, and a second backfill finds them current", async () => {
		const stores = fs.mkdtempSync(path.join(tmp, "stores-")), env = { CLAUDE_CONFIG_DIR: path.join(stores, "claude"), CODEX_HOME: path.join(stores, "codex") };
		const claude = path.join(env.CLAUDE_CONFIG_DIR, "projects", "-w", "bf-claude.jsonl"), id = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
		const codex = path.join(env.CODEX_HOME, "sessions", "2026", "11", "04", `rollout-2026-11-04T10-00-00-${id}.jsonl`);
		fs.mkdirSync(path.dirname(claude), { recursive: true });
		fs.mkdirSync(path.dirname(codex), { recursive: true });
		fs.writeFileSync(claude, claudeLine("user", "We decided to backfill the Claude session.", { cwd: tmp }));
		fs.writeFileSync(codex, JSON.stringify({ type: "session_meta", payload: { id, cwd: tmp } }) + "\n" + codexLine("user_message", "We decided to backfill the Codex session."));
		const { backfill } = await import("./backfill.mjs");
		const first = backfill({ env });
		assert.deepEqual([first.queued, first.current, first.already_queued], [2, 0, 0]);
		assert.match(first.warning, /cleanupPeriodDays \(30 days/);
		const server = fakeServer();
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		assert.equal(r.results["claude-code-bf-claude.json"].status, "done");
		assert.equal(r.results[`codex-${id}.json`].status, "done");
		assert.deepEqual([...new Set(server.log.map((b) => b.session.id))].sort(), [id, "bf-claude"].sort());
		const again = backfill({ env });
		assert.deepEqual([again.queued, again.current], [0, 2]);
	});
});

describe("repo facts integration", () => {
	it("keeps turn.completed token usage from the exec stream, and none when the stream has none", () => {
		const ev = (...items) => items.map((i) => JSON.stringify(i)).join("\n");
		const msg = { type: "item.completed", item: { type: "agent_message", text: "{\"facts\":[]}" } };
		assert.deepEqual(am.parseEvents(ev(msg, { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2 } })).usage, { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2 });
		assert.equal(am.parseEvents(ev(msg, { type: "turn.completed" })).usage, null);
	});

	it("leaves fact injection and synthesis off by default, never routes facts to `me`, and takes rates only when all three are numbers", () => {
		assert.deepEqual(am.withDefaults({}).facts, { inject: false, profile: null, timeout_ms: 1500, synthesis: false, synthesis_rates: null });
		const c = am.withDefaults({ facts: { inject: "true", synthesis: 1, profile: "me", synthesis_rates: { input: 1, output: 2 } } }).facts;
		assert.deepEqual([c.inject, c.synthesis, c.profile, c.synthesis_rates], [false, false, null, null]);
		assert.equal(am.withDefaults({ facts: { profile: "work" } }).facts.profile, "work");
	});

	it("installs every repo-fact module, and with injection on gives SessionStart a bounded timeout in both clients", () => {
		const fakeHome = fs.mkdtempSync(path.join(tmp, "user-home-")), saved = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			for (const f of ["facts.mjs", "facts-detect.mjs", "facts-client.mjs", "facts-inject.mjs", "facts-synth.mjs"]) assert.ok(am.V2_LOCAL.includes(f), f);
			const off = am.install({ platform: "linux" });
			assert.deepEqual(off.claude.hooks.SessionStart[0].hooks[0], { type: "command", command: `${off.node} ${off.bin} hook claude-code` });
			am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ facts: { inject: true } }));
			const on = am.install({ platform: "linux" });
			assert.equal(on.claude.hooks.SessionStart[0].hooks[0].timeout, 3);
			assert.match(on.codex, /\[\[hooks\.SessionStart\.hooks\]\]\ntype = "command"\ncommand = ".*hook codex"\ntimeout = 3/);
			for (const f of am.V2_LOCAL) assert.ok(fs.existsSync(path.join(path.dirname(on.bin), f)), f);
		} finally { process.env.HOME = saved; }
	});

	it("run --scheduled retries a pending fact report with synthesis off, and stays idle when only refused or sent reports remain", async () => {
		const sessions = path.join(am.home(), "facts", "sessions"), bytes = JSON.stringify({ repo: { remote: "github.com/o/r" }, facts: { session: "codex:000000000001", families: [], fired: [], observations: [] } });
		const write = (name, status) => am.writePrivate(path.join(sessions, name), JSON.stringify({ v: 1, repo_key: "github.com/o/r", digest: { session: "codex:000000000001" }, report: { bytes, status, pending: {} } }));
		const sent = [], server = { ...fakeServer(), status: async () => {}, facts: async (b) => { sent.push(b); return { profile: "personal", report: { action: "stored", facts: [] } }; } };
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [] }));
		write("codex-refused.json", "refused");
		assert.equal((await am.run({ server, runner: { available: false }, trigger: "scheduled" })).status, "idle", "a refused report is final");
		write("codex-pending.json", "pending");
		const ran = await am.run({ server, runner: { available: false }, trigger: "scheduled" });
		assert.equal(ran.status, "ran");
		assert.deepEqual([ran.results.facts.sent, sent], [1, [bytes]]);
		assert.equal((await am.run({ server, runner: { available: false }, trigger: "scheduled" })).status, "idle");
	});

	it("run --scheduled counts a waiting completion when synthesis is on, and stays idle and untouched when it is off", async () => {
		const sy = await import("./facts-synth.mjs"), server = { ...fakeServer(), status: async () => {} }, runner = { available: false };
		const { partitionId } = await import("./facts.mjs"), key = "github.com/o/r", part = partitionId("personal", key);
		sy.markCompleted(am.withDefaults({ facts: { synthesis: true } }), key, "codex:000000000001", { partition: part, profile: "personal", repo: { remote: key }, repo_key: key });
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [] }));
		assert.equal((await am.run({ server, runner, trigger: "scheduled" })).status, "idle", "off: the marker waits");
		assert.ok(fs.existsSync(path.join(sy.dueDir(), `${part}-codex_000000000001.json`)));
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [], facts: { synthesis: true } }));
		const ran = await am.run({ server, runner, trigger: "scheduled" });
		assert.equal(ran.status, "ran");
		assert.equal(ran.results.synthesis.counted, 1);
		assert.deepEqual(fs.readdirSync(sy.dueDir()), []);
	});

	it("synthesizes, in the same drain, the markers of a session whose debounced trigger was captured after the first pass", async () => {
		const sy = await import("./facts-synth.mjs"), { partitionId } = await import("./facts.mjs"), key = "github.com/o/r", part = partitionId("personal", key);
		const f = transcript("debounced", [claudeLine("user", "We decided to synthesize after the late capture.")]);
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [], facts: { synthesis: true } }));
		am.hook("claude-code", JSON.stringify({ session_id: "debounced", transcript_path: f, cwd: tmp, hook_event_name: "Stop" }), { spawnRun: false });
		// The capture stands in for observeSession: it leaves a completed-synthesis marker.
		const server = { ...fakeServer(), status: async () => {} }, ingest = server.ingest;
		server.ingest = async (b) => { sy.markCompleted(am.withDefaults({ facts: { synthesis: true } }), key, "codex:000000000001", { partition: part, profile: "personal", repo: { remote: key }, repo_key: key }); return ingest(b); };
		let skew = 0;
		const r = await am.run({ server, runner: keepAllRunner(), debounceMs: 45_000, clock: () => Date.now() + skew, sleep: async (ms) => { skew += ms; } });
		assert.equal(r.results["claude-code-debounced.json"].status, "done");
		assert.equal(r.results.synthesis.counted, 1, "synthesis ran after the debounced capture");
		assert.deepEqual(fs.readdirSync(sy.dueDir()), []);
	});
});

describe("capture gaps and hook trust (#128)", () => {
	const restoreEnv = (saved) => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

	it("finds a Codex rollout that `codex archive` moved to archived_sessions/", () => {
		const codexHome = fs.mkdtempSync(path.join(tmp, "codex-archived-")), id = "019a0000-0000-7000-8000-00000000a001";
		const f = path.join(codexHome, "archived_sessions", `rollout-2026-11-01T00-00-00-${id}.jsonl`);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
		assert.equal(am.findTranscript({ client: "codex", session: id, client_home: codexHome }), f);
		assert.equal(am.findTranscript({ client: "codex", session: "019a0000-0000-7000-8000-00000000ffff", client_home: codexHome }), null);
	});

	it("captures a Claude sub-agent as `<parent>:agent-<id>`, queued by its parent, with the parent agent's brief never taken as the owner's", async () => {
		const claudeHome = fs.mkdtempSync(path.join(tmp, "claude-sub-")), parent = "11111111-2222-4333-8444-555555555555";
		const proj = path.join(claudeHome, "projects", "-repo"), parentFile = path.join(proj, `${parent}.jsonl`), subFile = path.join(proj, parent, "subagents", "agent-a1b2c3.jsonl");
		fs.mkdirSync(path.dirname(subFile), { recursive: true });
		fs.writeFileSync(parentFile, claudeLine("user", "Please fix the build.") + claudeLine("assistant", [{ type: "text", text: "Delegating the review." }]));
		fs.writeFileSync(subFile, claudeLine("user", "Never touch the lockfile. I prefer small commits.", { isSidechain: true, agentId: "a1b2c3" })
			+ claudeLine("assistant", [{ type: "text", text: "Chose to read src/x.ts first because it is small." }], { isSidechain: true }));
		const sub = `${parent}:agent-a1b2c3`;
		assert.equal(am.findTranscript({ client: "claude-code", session: sub, client_home: claudeHome }), subFile, "found by id without a hook path");
		assert.equal(am.isSubagent("claude-code", sub, subFile), true);
		const server = fakeServer();
		am.writePrivate(path.join(am.home(), "queue", `claude-code-${parent}.json`), JSON.stringify({ ...trigger("claude-code", parent, parentFile), client_home: claudeHome, event: "SessionEnd", ended: true }));
		const ran = await am.run({ server, runner: { available: false }, debounceMs: 0 });
		assert.equal(ran.results[`claude-code-${am.safeName(sub)}.json`].status, "done", "the parent's run queued and captured its sub-agent");
		const batches = server.log.filter((b) => b.session.id === sub && b.digests.length);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].session.ended, true, "a parent that ended marks its sub-agents ended");
		const body = JSON.parse(batches[0].digests[0].body);
		assert.deepEqual([body.asks.length, body.corrections.length], [0, 0], "the brief is assistant text: no ask, no owner correction");
		assert.equal(body.decisions.length, 1);
		const messages = am.extract("claude-code", am.readLines(subFile, 0).lines, { subagent: true });
		assert.deepEqual(messages.map((m) => m.role), ["assistant", "assistant"]);
		assert.deepEqual(am.extract("claude-code", am.readLines(subFile, 0).lines), [], "a parent read still skips sidechain records");
		assert.equal(am.queueSubagents({ client: "claude-code", session: parent, client_home: claudeHome }, parentFile, false), 0, "a current sub-agent is not queued again");
	});

	it("treats a Codex thread spawned by another as a sub-agent from its session_meta", () => {
		const f = transcript("codex-child", [JSON.stringify({ type: "session_meta", payload: { id: "c", source: { subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } } } }) + "\n",
			codexLine("user_message", "Never edit the schema.")]);
		const root = transcript("codex-root", [JSON.stringify({ type: "session_meta", payload: { id: "r", source: "vscode" } }) + "\n"]);
		assert.equal(am.isSubagent("codex", "c", f), true);
		assert.equal(am.isSubagent("codex", "r", root), false);
		assert.deepEqual(am.extract("codex", am.readLines(f, 0).lines, { subagent: true }).map((m) => m.role), ["assistant"]);
	});

	it("settles a missing source as source_missing (Codex ephemeral, Claude not persisted, 7-day expiry), removes the trigger and logs ids only", async () => {
		const server = fakeServer(), codexHome = path.join(tmp, `codex-none-${n}`), claudeHome = path.join(tmp, `claude-none-${n}`), now = Date.now();
		let r = await am.processSession({ ...trigger("codex", "eph-1", null), client_home: codexHome, event: "SessionEnd", ended: true }, { server, runner: null, now });
		assert.deepEqual([r.status, r.reason], ["source_missing_settled", "ephemeral"]);
		r = await am.processSession({ ...trigger("claude-code", "np-1", path.join(claudeHome, "never.jsonl")), client_home: claudeHome, event: "SessionEnd", ended: true }, { server, runner: null, now });
		assert.deepEqual([r.status, r.reason], ["source_missing_settled", "not_persisted"]);
		const waiting = { ...trigger("claude-code", "wait-1", path.join(claudeHome, "later.jsonl")), client_home: claudeHome, event: "Stop" };
		r = await am.processSession(waiting, { server, runner: null, now });
		assert.equal(r.status, "source_missing", "a Stop with no transcript yet waits");
		assert.equal(am.captureSummary({ ids: true, now }).missing_sources, 1);
		r = await am.processSession(waiting, { server, runner: null, now: now + 7 * 86_400_000 + 1 });
		assert.deepEqual([r.status, r.reason], ["source_missing_settled", "expired"]);
		const s = am.captureSummary({ ids: true, now });
		assert.deepEqual([s.missing_sources, s.local.settled.map((x) => x.reason).sort()], [0, ["ephemeral", "expired", "not_persisted"]]);
		const log = fs.readFileSync(path.join(am.home(), "logs", "capture.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(log.map((e) => Object.keys(e).sort().join()), Array(3).fill("at,client,event,reason,session"), "time, ids and a code only");
		assert.equal(fs.statSync(path.join(am.home(), "logs", "capture.log")).mode & 0o777, 0o600);
		// A run removes a settled trigger from the queue.
		am.writePrivate(path.join(am.home(), "queue", "codex-eph-2.json"), JSON.stringify({ ...trigger("codex", "eph-2", null), client_home: codexHome, event: "SessionStart" }));
		const ran = await am.run({ server, runner: { available: false }, debounceMs: 0 });
		assert.equal(ran.results["codex-eph-2.json"].status, "source_missing_settled");
		assert.deepEqual(fs.readdirSync(path.join(am.home(), "queue")).filter((f) => f.endsWith(".json")), []);
		// A source that turns up later clears the settlement.
		fs.mkdirSync(claudeHome, { recursive: true });
		fs.writeFileSync(waiting.transcript_path, claudeLine("user", "We decided to come back."));
		r = await am.processSession(waiting, { server, runner: null, now });
		assert.equal(r.status, "done");
		assert.equal(am.readJson(am.statePath("claude-code", "wait-1"), {}).source_missing, undefined);
	});

	it("ports Codex's hook trust hash: it matches hashes Codex itself persisted", async () => {
		const { codexHookHash } = await import("./doctor.mjs");
		const command = 'bash "$HOME/dotfiles/ai/common/session-temp.sh" codex';
		assert.equal(codexHookHash("SessionStart", null, { type: "command", command, timeout: 30 }), "sha256:bafadea19bddb3774bb1da2929dad30c740469db175d338b10d6c89ab1a705e3");
		assert.equal(codexHookHash("SessionEnd", null, { type: "command", command, timeout: 3 }), "sha256:73861f1bda86c6c9fbef3dc1e75b61ba2cc9873c6e4aa5cb589c92bb5e810a41");
	});

	it("doctor's codex_hook_trust tells trusted, modified and untrusted agent-memory hooks apart", async () => {
		const { codexHookHash, codexHookTrust, doctorChecks } = await import("./doctor.mjs");
		const codexHome = fs.mkdtempSync(path.join(tmp, "codex-trust-")), bin = path.join(am.home(), "bin", "agent-memory"), file = path.join(codexHome, "config.toml");
		const cmd = `${am.home()}/bin/node ${bin} hook codex`, key = (e) => `${file}:${e}:0:0`;
		fs.writeFileSync(file, [
			'model = "x"', "", "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', `command = ${JSON.stringify(cmd)}`, "async = true", "",
			"[[hooks.SessionEnd]]", "[[hooks.SessionEnd.hooks]]", 'type = "command"', `command = ${JSON.stringify(cmd)}`, "timeout = 3", "",
			"[[hooks.SessionStart]]", "[[hooks.SessionStart.hooks]]", 'type = "command"', `command = ${JSON.stringify(cmd)}`, "", "[hooks.state]",
			`[hooks.state.${JSON.stringify(key("stop"))}]`, `trusted_hash = ${JSON.stringify(codexHookHash("Stop", null, { command: cmd, async: true }))}`, "",
			`[hooks.state.${JSON.stringify(key("session_end"))}]`, `trusted_hash = ${JSON.stringify(codexHookHash("SessionEnd", null, { command: `/old/fnm/v24.11.1/bin/node ${bin} hook codex`, timeout: 3 }))}`, "",
		].join("\n"));
		assert.deepEqual(codexHookTrust(codexHome, bin, ["Stop", "SessionEnd", "SessionStart"]).map((r) => `${r.event}:${r.status}`), ["Stop:trusted", "SessionEnd:modified", "SessionStart:untrusted"]);
		// SessionEnd's timeout is clamped to 1..3 before hashing, as Codex does: 10 and 3 hash the same.
		assert.equal(codexHookHash("SessionEnd", null, { command: cmd, timeout: 10 }), codexHookHash("SessionEnd", null, { command: cmd, timeout: 3 }));
		const saved = { CODEX_HOME: process.env.CODEX_HOME };
		process.env.CODEX_HOME = codexHome;
		try {
			const c = (await doctorChecks({ config: am.withDefaults({}), server: { whoami: async () => ({}) } })).find((x) => x.id === "codex_hook_trust");
			assert.equal(c.ok, false);
			assert.match(c.detail, /SessionEnd modified, SessionStart untrusted/);
			assert.match(c.fix, /Trust all and continue/);
		} finally { restoreEnv(saved); }
	});

	it("doctor warns, without failing, when a batch profile wrote no record for 3 days, and reads older last.json files defensively", async () => {
		const { doctorChecks, formatChecks } = await import("./doctor.mjs"), now = Date.parse("2026-11-11T12:00:00Z");
		const check = async (last) => {
			if (last) am.writePrivate(path.join(am.home(), "batch", "last.json"), JSON.stringify(last));
			return (await doctorChecks({ config: am.withDefaults({ batch_profiles: ["work", "personal"] }), now, server: { whoami: async () => ({}) } })).find((x) => x.id === "batch_learning");
		};
		assert.deepEqual([(await check(null)).ok, (await check(null)).warn], [true, undefined]);
		const idle = await check({ at: "2026-11-11T04:00:00Z", profiles: { work: { applied: {}, last_write_at: null, tracked_since: "2026-11-05T04:00:00Z" },
			personal: { applied: { save: 1 }, last_write_at: "2026-11-11T04:00:00Z", tracked_since: "2026-11-01T04:00:00Z" } } });
		assert.deepEqual([idle.ok, idle.warn], [true, true]);
		assert.match(formatChecks([idle]), /^WARN batch_learning {2}no record written for 3 days: work since 2026-11-05T04:00:00.000Z — fix: /);
		const old = await check({ at: "2026-11-11T04:00:00Z", profiles: { work: { status: "completed" } } });
		assert.deepEqual([old.ok, old.warn ?? false], [true, false]);
		assert.match(old.detail, /no learning clock yet for work, personal/);
	});

	it("`status` prints the local status as text, and as JSON with --json", () => {
		const env = { ...process.env, AGENT_MEMORY_HOME: am.home(), PATH: path.dirname(fs.realpathSync(process.execPath)) };
		am.writePrivate(path.join(am.home(), "facts", "inject", `${new Date().toISOString().slice(0, 10)}.jsonl`),
			`${JSON.stringify({ at: new Date().toISOString(), ms: 120, outcome: "ok" })}\n${JSON.stringify({ at: new Date().toISOString(), ms: 1600, outcome: "timeout" })}\n`);
		const cli = fileURLToPath(new URL("./agent-memory.mjs", import.meta.url));
		const json = spawnSync(process.execPath, [cli, "status", "--json"], { env, encoding: "utf8" });
		assert.equal(json.status, 0, json.stderr);
		const s = JSON.parse(json.stdout);
		assert.ok(["missing_sources", "facts", "loop_guard"].every((k) => k in s));
		assert.deepEqual([s.facts.inject_p95_ms, s.facts.inject_timeouts_7d], [1600, 1]);
		const text = spawnSync(process.execPath, [cli, "status"], { env, encoding: "utf8" });
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /^Repo facts: inject off/m);
		assert.match(text.stdout, /Inject p95 \(7 days\): 1600 ms over 2 runs; inject timeouts \(7 days\): 1/);
		const bad = spawnSync(process.execPath, [cli, "status", "--bad"], { env, encoding: "utf8" });
		assert.deepEqual([bad.status, bad.stderr], [2, "usage: agent-memory status [--json]\n"]);
	});

	it("install links bin/node to this Node, replaces a stale link, and every hook command names bin/node and bin/agent-memory", () => {
		const r = am.install({ platform: "linux" });
		assert.equal(r.node, path.join(am.home(), "bin", "node"));
		assert.equal(fs.readlinkSync(r.node), fs.realpathSync(process.execPath));
		fs.rmSync(r.node);
		fs.symlinkSync("/nonexistent/old-node", r.node);
		am.install({ platform: "linux" });
		assert.equal(fs.readlinkSync(r.node), fs.realpathSync(process.execPath));
		assert.deepEqual(fs.readdirSync(path.dirname(r.node)).filter((f) => f.endsWith(".tmp")), []);
		for (const [, groups] of Object.entries(r.claude.hooks)) assert.equal(groups[0].hooks[0].command, `${r.node} ${r.bin} hook claude-code`);
		const commands = [...r.codex.matchAll(/^command = (".*")$/gm)].map((m) => JSON.parse(m[1]));
		assert.ok(commands.length >= 4 && commands.every((c) => c === `${r.node} ${r.bin} hook codex`));
	});

	it("confinedExec passes -o only for an absolute replyFile", async () => {
		const dir = fs.mkdtempSync(path.join(tmp, "exec-")), configFile = path.join(dir, "config.toml"), calls = [];
		fs.writeFileSync(configFile, "x");
		const exec = (_cmd, args) => { calls.push(args); return { status: 0, stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } })}\n`, stderr: "" }; };
		const run = am.confinedExec({ exec, codex: "codex", runDir: dir, env: {}, configFile, configSha: sha(fs.readFileSync(configFile)), schemaDir: dir });
		const reply = path.join(dir, "reply.json");
		for (const replyFile of [reply, "reply.json", undefined]) assert.equal((await run({ prompt: "p", schema: {}, model: "m", effort: "low", replyFile })).kind, "ok");
		assert.deepEqual(calls[0].slice(-3), ["-o", reply, "-"]);
		assert.ok(!calls[1].includes("-o") && !calls[2].includes("-o"));
		assert.equal(calls[1].at(-1), "-");
	});

	it("redacts exactly as the server's src/domain/redact.ts on a sample set", async () => {
		const { redactText } = await import("../src/domain/redact.ts");
		const samples = ["GH_TOKEN=… gh pr list", "GH_TOKEN=abc gh pr list", "export API_KEY=$API_KEY", "password=${PASS}", "token: \"…\"", "Authorization: Bearer abc.def.ghi",
			"curl -u me:hunter2 https://x", "https://user:pw@host/path", "mysql -p secretpw db", "aws configure set aws_secret_access_key AKIAABCDEFGHIJKLMNOP", "sk-abcdefghijklmnop",
			"github_token=ghp_abcdefghijklmnopqrstuvwxyz", "--password hunter2", "plain text with no secret", "{\"client_secret\": \"s3cr3t\"}", "redis-cli -a pw123 ping"];
		for (const s of samples) assert.equal(am.redact(s), redactText(s), s);
		assert.equal(am.redact("GH_TOKEN=… gh pr list"), "GH_TOKEN=… gh pr list", "the … placeholder is kept");
		assert.equal(am.redact("GH_TOKEN=abc gh pr list"), "GH_TOKEN=[REDACTED] gh pr list");
	});
});


describe("capture project tagging", () => {
	const git = (...args) => assert.equal(spawnSync("git", args, { encoding: "utf8" }).status, 0, args.join(" "));
	const checkout = (dir, remote) => { fs.mkdirSync(dir, { recursive: true }); git("init", "-q", dir); if (remote) git("-C", dir, "remote", "add", "origin", remote); return dir; };

	it("derives the project key from the checkout root and the workspace from config, and skips fixtures and checkouts above the workspace", async () => {
		const ws = fs.mkdtempSync(path.join(tmp, "ws-"));
		const app = checkout(path.join(ws, "app"), "git@github.com:Owner/App.git"), sub = path.join(app, "src");
		fs.mkdirSync(sub);
		const fixture = checkout(path.join(ws, "tool", "fixtures", "web"), "https://github.com/acme/web-app");
		const plain = path.join(ws, "notes");
		fs.mkdirSync(plain);
		const outer = checkout(fs.mkdtempSync(path.join(tmp, "home-repo-")), "https://github.com/me/dotfiles"), inner = path.join(outer, "Projects");
		fs.mkdirSync(inner);
		assert.deepEqual(await am.placeOf(sub, "git@github.com:Owner/App.git", { apps: ws }), { project: "github:owner/app", workspace: "apps" });
		assert.deepEqual(await am.placeOf(sub, "https://user:secret@github.com/Owner/App.git/", {}), { project: "github:owner/app" });
		assert.deepEqual(await am.placeOf(sub, "https://gitlab.com/owner/app.git", { apps: ws }), { workspace: "apps" }, "not a GitHub remote");
		assert.deepEqual(await am.placeOf(fixture, "https://github.com/acme/web-app", {}), {}, "a checkout under fixtures is no project");
		assert.deepEqual(await am.placeOf(plain, undefined, { apps: ws }), { workspace: "apps" }, "a workspace folder with no repo");
		assert.deepEqual(await am.placeOf(inner, "https://github.com/me/dotfiles", { sequoia: inner }), { workspace: "sequoia" }, "the repo above the workspace root is not its project");
		assert.deepEqual(await am.placeOf("/no/such/dir", "https://github.com/o/r", { apps: ws }), {});
		assert.deepEqual(am.withDefaults({ capture: { workspaces: { sequoia: "~/Projects/sequioa", "Bad Name": "/x", rel: "Projects/x", apps: "/abs/apps/" } } }).capture.workspaces,
			{ sequoia: path.join(os.homedir(), "Projects/sequioa"), apps: "/abs/apps" });
		assert.deepEqual(am.withDefaults({}).capture, { workspaces: {} });
	});

	it("sends project and workspace on every batch of a tagged session, and an untagged session keeps the old body", async () => {
		const ws = fs.mkdtempSync(path.join(tmp, "ws-"));
		const app = checkout(path.join(ws, "app"), "https://github.com/Owner/App.git");
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ capture: { workspaces: { apps: ws } } }));
		const tagged = transcript(`tag-${n}`, [claudeLine("user", "We decided to tag sessions."), claudeLine("assistant", "Done.")]);
		const plain = transcript(`untagged-${n}`, [claudeLine("user", "We decided nothing here."), claudeLine("assistant", "Ok.")]);
		const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
		am.hook("claude-code", JSON.stringify({ session_id: `tag-${n}`, transcript_path: tagged, cwd: app, hook_event_name: "SessionEnd" }), { spawnRun: false });
		am.hook("claude-code", JSON.stringify({ session_id: `untagged-${n}`, transcript_path: plain, cwd: outside, hook_event_name: "SessionEnd" }), { spawnRun: false });
		const server = fakeServer();
		await am.run({ server, runner: keepAllRunner(), debounceMs: 0 });
		const of = (id) => server.log.filter((b) => b.session.id === id);
		assert.ok(of(`tag-${n}`).length >= 2, "heuristic and consolidated batches");
		for (const b of of(`tag-${n}`)) {
			assert.equal(b.project, "github:owner/app");
			assert.equal(b.workspace, "apps");
			assert.deepEqual(b.repo, { remote: "https://github.com/Owner/App.git", path: app }, "routing input unchanged");
		}
		assert.ok(of(`untagged-${n}`).length >= 1);
		for (const b of of(`untagged-${n}`)) assert.ok(!("project" in b) && !("workspace" in b), "no new fields without a project or workspace");
	});
});
