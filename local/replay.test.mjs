// `agent-memory replay` (#22) against synthetic Claude Code and Codex stores in a scratch home: discovery and refusal of
// symlinks, extraction without thinking, system or injected text, redaction before the 8 KB cut, the loopback server's
// token, Host, Origin, method and path refusals, the installed command's import closure, and the served page mounting the
// real shared player in a VM.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-replay-test-"));
process.env.AGENT_MEMORY_HOME = path.join(tmp, "am");
const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), CODEX_HOME: path.join(tmp, "codex"), AGENT_MEMORY_HOME: path.join(tmp, "am") };
const { listTranscripts, findSession, readFull, TOOL_OUTPUT_MAX } = await import("./transcript-full.mjs");
const { startReplay, HEADERS } = await import("./replay.mjs");
const am = await import("./agent-memory.mjs");

// Fake credentials built at run time; each matches one of the shared redaction patterns.
const GH = `ghp_${"q".repeat(30)}`, AWS = `AKIA${"Z".repeat(16)}`, PW = "hunter2hunter2";
const SECRETS = [GH, AWS, PW];
const CLAUDE_ID = "11111111-1111-4111-8111-111111111111", CODEX_ID = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-11-04T10:00:00Z"), ts = (s) => new Date(T0 + s * 1000).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
// A secret straddling the 8 KB boundary: cutting before redacting would leave a partial key that no pattern matches.
const BIG = `${"a".repeat(TOOL_OUTPUT_MAX - 16)} ${GH} tail ${"b".repeat(4000)}`;

const project = path.join(env.CLAUDE_CONFIG_DIR, "projects", "-scratch-proj");
const claudeFile = path.join(project, `${CLAUDE_ID}.jsonl`);
const day = path.join(env.CODEX_HOME, "sessions", "2026", "11", "04");
const codexFile = path.join(day, `rollout-2026-11-04T10-00-00-${CODEX_ID}.jsonl`);
before(() => {
	fs.mkdirSync(project, { recursive: true });
	fs.writeFileSync(claudeFile, jsonl([
		{ type: "user", timestamp: ts(0), message: { role: "user", content: `Fix the build. password=${PW}` } },
		{ type: "user", timestamp: ts(0), isMeta: true, message: { role: "user", content: "META-ONLY" } },
		{ type: "user", timestamp: ts(0), message: { role: "user", content: "<environment_context>INJECTED-CONTEXT</environment_context>" } },
		{ type: "assistant", timestamp: ts(2), message: { content: [{ type: "thinking", thinking: "PRIVATE-THINKING" },
			{ type: "text", text: "Running tests.<system-reminder>REMINDER-TEXT</system-reminder>" },
			{ type: "tool_use", id: "tu1", name: `Bash token=${PW}`, input: { command: `npm test --key ${AWS}` } }] } },
		{ type: "user", timestamp: ts(5), message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: BIG, is_error: true }] } },
		{ type: "system", timestamp: ts(6), content: "SYSTEM-TEXT" },
		{ type: "assistant", timestamp: ts(7), isSidechain: true, message: { content: [{ type: "text", text: "SIDECHAIN-TEXT" }] } },
		{ type: "assistant", timestamp: ts(9), message: { content: [{ type: "text", text: "Fixed." }] } },
	]));
	fs.writeFileSync(path.join(project, "agent-abc.jsonl"), jsonl([{ type: "user", message: { content: "subagent" } }]));
	fs.symlinkSync(claudeFile, path.join(project, "33333333-3333-4333-8333-333333333333.jsonl"));
	fs.mkdirSync(day, { recursive: true });
	fs.writeFileSync(codexFile, jsonl([
		{ type: "response_item", timestamp: ts(0), payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "DEVELOPER-TEXT" }] } },
		{ type: "event_msg", timestamp: ts(1), payload: { type: "user_message", message: "List files" } },
		{ type: "response_item", timestamp: ts(2), payload: { type: "reasoning", summary: [{ type: "summary_text", text: "PRIVATE-THINKING" }] } },
		{ type: "response_item", timestamp: ts(3), payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }) } },
		{ type: "response_item", timestamp: ts(4), payload: { type: "function_call_output", call_id: "c1", output: `file-a\n${AWS}` } },
		{ type: "event_msg", timestamp: ts(5), payload: { type: "agent_message", message: "Done." } },
	]));
	// Not a dated directory: ignored.
	fs.mkdirSync(path.join(env.CODEX_HOME, "sessions", "misc", "x", "y"), { recursive: true });
	fs.copyFileSync(codexFile, path.join(env.CODEX_HOME, "sessions", "misc", "x", "y", `rollout-2026-11-04T10-00-00-${"4".repeat(8)}-4444-4444-8444-${"4".repeat(12)}.jsonl`));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const leaks = (s) => SECRETS.filter((x) => s.includes(x)).concat(["PRIVATE-THINKING", "META-ONLY", "INJECTED-CONTEXT", "REMINDER-TEXT", "SYSTEM-TEXT", "SIDECHAIN-TEXT", "DEVELOPER-TEXT", "subagent"].filter((x) => s.includes(x)));

describe("local transcripts", () => {
	it("lists only regular, owned Claude project and dated Codex rollout files, and validates ids", () => {
		const rows = listTranscripts({ env });
		assert.deepEqual(rows.map((r) => [r.client, r.session]).sort(), [["claude-code", CLAUDE_ID], ["codex", CODEX_ID]]);
		assert.equal(findSession("33333333-3333-4333-8333-333333333333", { env }), null, "a symlinked transcript is not listed");
		for (const bad of ["../x", "", "a/b", ".hidden", "x".repeat(200)]) assert.equal(findSession(bad, { env }), null);
		assert.equal(findSession(CODEX_ID, { env }).file, codexFile);
	});

	it("refuses a symlink at read time", () => {
		const link = path.join(tmp, "link.jsonl");
		fs.symlinkSync(claudeFile, link);
		assert.throws(() => readFull("claude-code", link), { code: "ELOOP" });
	});

	it("keeps prompts, responses and tool events, redacts every label and detail, and cuts tool text at 8 KB after redaction", () => {
		const events = readFull("claude-code", claudeFile);
		assert.deepEqual(events.map((e) => [e.kind, e.offset_ms]), [["prompt", 0], ["response", 2000], ["tool_call", 2000], ["tool_result", 5000], ["response", 9000]]);
		assert.deepEqual(leaks(JSON.stringify(events)), []);
		assert.equal(events[0].label, "Fix the build. password=[REDACTED]");
		assert.equal(events[1].label, "Running tests.");
		assert.equal(events[2].label, "Bash token=[REDACTED]");
		assert.equal(events[2].detail.input, "npm test --key [REDACTED]");
		const out = events[3];
		assert.equal(out.label, "Bash token=[REDACTED] error");
		assert.equal(out.detail.truncated, "true");
		assert.ok(Buffer.byteLength(out.detail.output) <= TOOL_OUTPUT_MAX);
		assert.match(out.detail.output, /a \[REDACTED\] tail$/);
		assert.ok(!out.detail.output.includes("ghp_"));

		const codex = readFull("codex", codexFile);
		assert.deepEqual(codex.map((e) => [e.kind, e.label]), [["prompt", "List files"], ["tool_call", "shell"], ["tool_result", "shell result"], ["response", "Done."]]);
		assert.equal(codex[1].detail.input, "ls -la");
		assert.equal(codex[2].detail.output, "file-a\n[REDACTED]");
		assert.equal(codex[2].detail.truncated, undefined);
		assert.deepEqual(leaks(JSON.stringify(codex)), []);
	});

	it("keeps Claude text and tool blocks in source order with the same filters", () => {
		const file = path.join(tmp, "mixed.jsonl");
		fs.writeFileSync(file, jsonl([
			{ type: "assistant", timestamp: ts(0), message: { content: [{ type: "text", text: "First." }, { type: "thinking", thinking: "PRIVATE-THINKING" },
				{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }, { type: "text", text: `Second. password=${PW}` }] } },
			{ type: "user", timestamp: ts(5), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "tests failed" },
				{ type: "text", text: "Please fix that failure.<system-reminder>REMINDER-TEXT</system-reminder>" }, { type: "text", text: "<environment_context>INJECTED-CONTEXT</environment_context>" }] } },
			// A record the hook drops as a whole keeps its text out even when a later block alone would pass.
			{ type: "user", timestamp: ts(6), message: { content: [{ type: "text", text: "<command-name>INJECTED-CONTEXT" }, { type: "text", text: "META-ONLY" }] } },
			// A secret split across text blocks, or across a tool block, is redacted as in the whole message.
			{ type: "user", timestamp: ts(8), message: { content: [{ type: "text", text: "password=" }, { type: "text", text: PW }] } },
			{ type: "assistant", timestamp: ts(9), message: { content: [{ type: "text", text: "Checking. api_key=" }, { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }, { type: "text", text: PW }] } },
		]));
		const events = readFull("claude-code", file);
		assert.deepEqual(events.map((e) => [e.kind, e.label]), [["response", "First."], ["tool_call", "Bash"], ["response", "Second. password=[REDACTED]"],
			["tool_result", "Bash result"], ["prompt", "Please fix that failure."], ["prompt", "password=[REDACTED]"],
			["response", "Checking. api_key=[REDACTED]"], ["tool_call", "Bash"]]);
		assert.deepEqual(leaks(JSON.stringify(events)), []);
	});

	it("keeps a lone sensitive argument's key so Claude and Codex tool inputs are redacted", () => {
		const file = path.join(tmp, "lone-claude.jsonl"), rollout = path.join(tmp, "lone-codex.jsonl");
		fs.writeFileSync(file, jsonl([{ type: "assistant", timestamp: ts(0), message: { content: [
			{ type: "tool_use", id: "k1", name: "Login", input: { api_key: PW } }, { type: "tool_use", id: "k2", name: "Read", input: { file_path: "src/a.ts" } }] } }]));
		fs.writeFileSync(rollout, jsonl([
			{ type: "response_item", timestamp: ts(0), payload: { type: "function_call", name: "login", call_id: "k3", arguments: JSON.stringify({ password: PW }) } },
			{ type: "event_msg", timestamp: ts(1), payload: { type: "item_completed", item: { type: "McpToolCall", id: "k4", server: "gh", tool: "auth", arguments: { github_token: PW }, result: { content: [] } } } },
		]));
		const calls = [...readFull("claude-code", file), ...readFull("codex", rollout)].filter((e) => e.kind === "tool_call");
		assert.deepEqual(calls.map((e) => e.detail.input), ['{\n  "api_key":[REDACTED]\n}', "src/a.ts", '{\n  "password":[REDACTED]\n}', '{\n  "github_token":[REDACTED]\n}']);
		assert.deepEqual(leaks(JSON.stringify(calls)), []);
	});
});

function get(port, p, { method = "GET", headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
			const chunks = [];
			res.on("data", (d) => chunks.push(d)).on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject).end();
	});
}

describe("loopback server", () => {
	let viewer;
	before(async () => { viewer = await startReplay({ env }); });
	after(() => viewer.close());

	it("binds 127.0.0.1 on a random port with a 32-byte token", () => {
		assert.ok(viewer.port > 0);
		assert.equal(Buffer.from(viewer.token, "base64url").length, 32);
		assert.equal(viewer.url, `http://127.0.0.1:${viewer.port}/${viewer.token}/`);
		const lsof = spawnSync("lsof", ["-nP", "-a", `-p${process.pid}`, `-iTCP:${viewer.port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		if (lsof.error) return; // shortcut: lsof missing, address() below still proves the bind
		assert.match(lsof.stdout, new RegExp(`TCP 127\\.0\\.0\\.1:${viewer.port} \\(LISTEN\\)`));
		assert.equal(lsof.stdout.trim().split("\n").length, 2, lsof.stdout);
	});

	it("refuses a missing or wrong token, a foreign Host or Origin, other methods and escaped paths without detail", async () => {
		const { port, token } = viewer;
		const other = token.replace(/^./, (c) => (c === "A" ? "B" : "A"));
		const refusals = [
			["/", {}], [`/${other}/`, {}], [`/${token.slice(1)}/`, {}], [`/x/../${token}/api/sessions`, {}],
			[`/${token}/`, { headers: { host: `localhost:${port}` } }],
			[`/${token}/`, { headers: { host: `127.0.0.1:${port + 1}` } }],
			[`/${token}/api/sessions`, { headers: { origin: "http://evil.example" } }],
			[`/${token}/api/sessions`, { headers: { origin: "null" } }],
			[`/${token}/api/sessions`, { headers: { origin: `http://localhost:${port}` } }],
		];
		for (const [p, opts] of refusals) {
			const r = await get(port, p, opts);
			assert.equal(r.status, 403, `${p} ${JSON.stringify(opts)}`);
			assert.equal(r.body.toString(), "forbidden\n");
			assert.equal(r.headers["content-security-policy"], HEADERS["Content-Security-Policy"]);
		}
		assert.equal((await get(port, `/${token}/api/sessions`, { method: "POST" })).status, 405);
		for (const p of [`/${token}/../api/sessions`, `/${token}/%2e%2e/api/sessions`, `/${token}/replay.mjs`, `/${token}/..%2fagent-memory.mjs`]) {
			const r = await get(port, p);
			assert.ok([403, 404].includes(r.status), p);
			assert.ok(r.body.length < 32, p);
		}
		const missing = await get(port, `/${token}/api/session?id=${encodeURIComponent("../../etc/passwd")}`);
		assert.equal(missing.status, 404);
		assert.equal(missing.body.toString(), "{\"error\":\"not_found\"}");
	});

	it("serves the page, the unchanged player and redacted events with restrictive headers", async () => {
		const { port, token } = viewer;
		const page = await get(port, `/${token}/`, { headers: { origin: `http://127.0.0.1:${port}` } });
		assert.equal(page.status, 200);
		for (const [k, v] of Object.entries(HEADERS)) assert.equal(page.headers[k.toLowerCase()], v);
		assert.match(page.headers["content-security-policy"], /default-src 'none'; script-src 'self'; style-src 'self'/);
		assert.equal(page.headers.location, undefined);
		assert.doesNotMatch(page.body.toString(), /<script>|<style|\sstyle=|\son[a-z]+=/i, "no inline script, style or handler");
		const player = await get(port, `/${token}/replay-player.js`);
		assert.deepEqual(player.body, fs.readFileSync(new URL("./replay-player.js", import.meta.url)));
		const head = await get(port, `/${token}/viewer.css`, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.body.length, 0);
		const list = JSON.parse((await get(port, `/${token}/api/sessions`)).body);
		assert.deepEqual(Object.keys(list[0]).sort(), ["bytes", "client", "modified_at", "session"], "no local paths");
		const s = await get(port, `/${token}/api/session?id=${CLAUDE_ID}`);
		assert.equal(s.status, 200);
		assert.deepEqual(leaks(s.body.toString()), []);
		assert.ok(!s.body.toString().includes(tmp), "no local paths");
	});
});

// Just the DOM the viewer and player use. innerHTML throws, so any HTML path fails.
function makeDom() {
	const doc = { listeners: {}, byId: {} };
	class Node {
		constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), nodeType: 1, ownerDocument: doc, children: [], attrs: {}, listeners: {}, dataset: {}, parentNode: null, text: "", className: "" }); }
		appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
		removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
		get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
		set textContent(v) { this.children = []; this.text = String(v); }
		set innerHTML(_v) { throw new Error("innerHTML used"); }
		setAttribute(k, v) { this.attrs[k] = String(v); }
		getAttribute(k) { return this.attrs[k] ?? null; }
		addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
		querySelectorAll(tag) { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); }); walk(this); return out; }
		contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
		get isConnected() { return doc.documentElement.contains(this); }
		getClientRects() { return [{}]; }
		focus() {}
	}
	doc.createElement = (tag) => new Node(tag);
	doc.addEventListener = (t, f) => (doc.listeners[t] ||= []).push(f);
	doc.removeEventListener = () => {};
	doc.documentElement = new Node("html");
	doc.body = doc.documentElement.appendChild(new Node("body"));
	for (const [id, tag] of [["sessions", "ul"], ["status", "p"], ["player", "div"]]) doc.byId[id] = doc.body.appendChild(new Node(tag));
	doc.getElementById = (id) => doc.byId[id] ?? null;
	return doc;
}

describe("installed command", () => {
	it("installs the replay closure beside the CLI and serves a session that mounts the real shared player", async () => {
		// Off macOS, so install writes no LaunchAgents plist into the real home.
		const { bin } = am.install({ platform: "linux" });
		const dir = path.dirname(bin);
		for (const f of ["replay.mjs", "transcript-full.mjs", "replay-player.js"]) {
			assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
			assert.deepEqual(fs.readFileSync(path.join(dir, f)), fs.readFileSync(new URL(`./${f}`, import.meta.url)));
		}
		const list = spawnSync(bin, ["replay", "--list"], { encoding: "utf8", env });
		assert.equal(list.status, 0, list.stderr);
		assert.match(list.stdout, new RegExp(`codex\\s+${CODEX_ID}`));
		assert.equal(spawnSync(bin, ["replay", "--port", "x"], { encoding: "utf8", env }).status, 2);
		const none = spawnSync(bin, ["replay", "--session", "nope"], { encoding: "utf8", env });
		assert.equal(none.status, 1);
		assert.equal(none.stderr, "agent-memory replay: no local session with that id\n");

		const child = spawn(bin, ["replay", "--session", CLAUDE_ID, "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
		const closed = once(child, "close");
		try {
			let out = "";
			for await (const d of child.stdout) { out += d; if (out.includes("\n")) break; }
			const url = new URL(/Replay viewer: (\S+)/.exec(out)[1]);
			assert.equal(url.hostname, "127.0.0.1");
			assert.equal(url.hash, `#${CLAUDE_ID}`);
			assert.equal((await fetch(`${url.origin}/`)).status, 403, "missing token");

			// The served page's own scripts, in order: the shared player bytes, then the viewer that fetches and mounts.
			const doc = makeDom();
			const context = { document: doc, location: { hash: url.hash }, history: { replaceState() {} }, setTimeout, clearTimeout,
				fetch: (p, o) => fetch(new URL(p, url), o) };
			context.globalThis = context;
			vm.createContext(context);
			for (const s of ["replay-player.js", "viewer.js"]) vm.runInContext(await (await fetch(new URL(s, url))).text(), context);
			const status = doc.byId.status;
			for (let i = 0; i < 100 && !/events$/.test(status.textContent); i++) await new Promise((r) => setTimeout(r, 20));
			assert.equal(status.textContent, `claude-code session ${CLAUDE_ID}: 5 events`);
			const find = (n, cls) => [n.className === cls ? [n] : [], ...n.children.map((c) => find(c, cls))].flat();
			assert.equal(find(doc.byId.player, "replay").length, 1);
			assert.equal(find(doc.byId.player, "replay-event").length, 5);
			assert.match(find(doc.byId.player, "replay-detail")[0].textContent, /Prompt · event 1 of 5 · 0:00.*Fix the build\. password=\[REDACTED\]/);
			assert.deepEqual(leaks(doc.body.textContent), []);
			assert.equal(doc.byId.sessions.querySelectorAll("button").length, 2);
		} finally {
			child.kill("SIGINT");
		}
		const [code] = await closed;
		assert.equal(code, 0);
	});
});
