// node --test local/ : the local capture client against recorded fixtures, stub model runners and an in-memory server that
// follows the /v1/ingest contract (the real server contract is tested in test/capture.test.ts). Probe tests use the real
// `codex sandbox` when it is installed on macOS.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-local-test-"));
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const am = await import("./agent-memory.mjs");
const { batch } = await import("./batch.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex");
let n = 0;
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });

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

	it("finds a Codex rollout when the hook path is null, waits while it is missing, and starts a new epoch on a rewrite", async () => {
		const codexHome = path.join(tmp, `codex-home-${n}`);
		const t = { ...trigger("codex", "thr_null", null), client_home: codexHome };
		const server = fakeServer();
		let r = await am.processSession(t, { server, runner: keepAllRunner() });
		assert.equal(r.status, "source_missing");
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
	});

	it("is indeterminate when Codex is missing or the platform is untested", async () => {
		assert.deepEqual(await am.confinedRunner({}, { platform: "linux" }), { available: false, classification: "indeterminate", reason: "untested_platform" });
		const missing = await am.confinedRunner({ codex_home: tmp }, {});
		assert.equal(missing.available, false);
		assert.equal(missing.classification, "indeterminate");
	});

	it("proves the denial on this Mac with the real `codex sandbox`, and classifies weakened, missing and DNS probes", async (t) => {
		// Resolve the native dependency only when this test actually runs, so filtered synthetic checks launch no child.
		const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
		const real = process.platform === "darwin" && codex.status === 0 && fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
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
				assert.match(fs.readFileSync(configFile, "utf8").split("[features]\n")[1]?.split("\n[")[0] ?? "", /^view_image = false$/m);
				assert.ok(args.includes("model_reasoning_effort=high"));
				const schemaFile = args[args.indexOf("--output-schema") + 1];
				assert.deepEqual(JSON.parse(fs.readFileSync(schemaFile)), OPS_SCHEMA);
				assert.equal(fs.statSync(schemaFile).mode & 0o777, 0o400);
				if (mode === "drift") fs.writeFileSync(configFile, "changed");
				const item = mode === "tool" ? { type: "command_execution" } : mode === "notice" ? { type: "error" }
					: { type: "agent_message", text: JSON.stringify({ results: [] }) };
				return { status: mode === "unsupported_exit" ? 1 : 0, stdout: JSON.stringify({ type: "item.completed", item }),
					stderr: mode.startsWith("unsupported") ? "WARN codex_core::tools::router: unsupported call: exec_command\n" : "Reading prompt from stdin...\n" };
			} });
		const args = { prompt: "private input", schema: OPS_SCHEMA, model: "fake-model", effort: "high" };
		assert.deepEqual(await execute(args), { kind: "ok", part: { results: [] } });
		mode = "tool"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "notice"; assert.equal((await execute(args)).kind, "runtime_warning");
		mode = "unsupported"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "unsupported_exit"; assert.equal((await execute(args)).kind, "tool_event");
		mode = "drift"; assert.equal((await execute(args)).kind, "runtime_warning");
		assert.equal((await execute(args)).kind, "runtime_warning"); assert.equal(calls, 6, "changed config cannot start another exec");
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
			assert.ok(job.includes(`<array><string>${esc(process.execPath)}</string><string>${esc(r.bin)}</string><string>run</string><string>--scheduled</string></array>`), "node, then the CLI, then run --scheduled");
			assert.ok(job.includes(`<key>AGENT_MEMORY_HOME</key><string>${esc(am.home())}</string>`));
			assert.ok(job.includes(`<key>PATH</key><string>${esc(process.env.PATH)}</string>`));
			assert.match(r.launchd.load, /^launchctl bootstrap gui\//);
			for (const f of am.V2_LOCAL) assert.deepEqual(fs.readFileSync(path.join(path.dirname(r.bin), f)), fs.readFileSync(new URL(`./${f}`, import.meta.url)));
			am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ inject: { enabled: true, profile: "work", timeout_ms: 1500 } }));
			const on = am.install({ platform: "linux" });
			assert.equal(on.launchd, null);
			assert.deepEqual(on.claude.hooks.UserPromptSubmit[0].hooks[0], { type: "command", command: `${on.bin} hook claude-code`, timeout: 3 });
			assert.match(on.codex, /\[\[hooks\.UserPromptSubmit\.hooks\]\][^[]*timeout = 3/);
		} finally { process.env.HOME = saved; }
	});

	it("run --scheduled with nothing queued or due sends its status and returns without a runner, and a batch lease within 20 hours is not due", async () => {
		const reports = [], server = { ...fakeServer(), status: async (b) => { reports.push(b); } };
		am.writePrivate(path.join(am.home(), "config.json"), JSON.stringify({ batch_profiles: [] }));
		const idle = await am.run({ server, runner: { available: false, run() { throw new Error("no runner"); } }, trigger: "scheduled" });
		assert.equal(idle.status, "idle");
		assert.equal(idle.results.status, "sent");
		assert.deepEqual(Object.keys(reports[0]).sort(), ["clients", "hooks", "inject", "last_digest_at", "launchd_loaded", "missing_sources", "oldest_pending_at",
			"oldest_spool_at", "pending_ranges", "refused_since_last", "spool_bytes", "spool_files", "stuck_ranges"]);
		am.writePrivate(path.join(am.home(), "batch", "last.json"), JSON.stringify({ at: new Date().toISOString(), profiles: { work: { status: "completed" } } }));
		assert.equal(am.batchDue({ batch_profiles: ["work"] }), false);
		assert.equal(am.batchDue({ batch_profiles: ["work", "personal"] }), true);
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
