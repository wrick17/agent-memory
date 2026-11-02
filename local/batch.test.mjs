// The confined daily batch (section 12) with a fake confined runtime and a fake job transport: nothing is leased before the
// runtime is proven, one profile per prompt, ops stay inside their item's subjects, every failure retains the work, and only
// the job token reaches the two job tools.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-batch-test-"));
let n = 0;
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const { batch, mcpJob, OPS_SCHEMA } = await import("./batch.mjs");
const { claudeEnv, claudeExec } = await import("./agent-memory.mjs");
beforeEach(() => { process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });

const ALL_OPS = ["save", "link", "end_link", "supersede", "flag", "dismiss"];
const item = (id, kind, subjects) => ({ item_id: id, kind, subjects, allowed_ops: ALL_OPS,
	context: { nodes: subjects.map((s) => ({ id: s, passage: `private passage ${s}` })), edges: [] } });
const lease = (id, items, ms = 900_000) => ({ lease_id: id, lease_until: new Date(Date.now() + ms).toISOString(), items });
const itemsIn = (prompt) => JSON.parse(prompt.split("<items>\n")[1].split("\n</items>")[0]);
const dismissAll = ({ prompt }) => ({ kind: "ok", part: { results: itemsIn(prompt).map((i) => ({ item_id: i.item_id, ops: [{ op: "dismiss" }] })) } });

function fakeServer(leases, complete = () => ({ results: [{ status: "done", ops: [{ op: "dismiss", status: "applied" }] }] })) {
	const calls = [];
	return { calls, async call(name, args) {
		calls.push({ name, args: structuredClone(args) });
		return name === "maintenance_next" ? (leases[args.profile] ?? { lease_id: null, items: [], next_allowed_at: "later" }) : complete(args);
	} };
}
const fakeRunner = (judge) => { const runs = []; return { available: true, classification: "denied", runs, async exec(a) { runs.push(a); return judge(a); } }; };
const config = { batch_profiles: ["work", "personal"] };

describe("confinement before any lease or model", () => {
	it("leases nothing and runs no model unless this run's controls passed and every probe was denied", async () => {
		const exec = () => { throw new Error("model ran"); };
		for (const [runner, reason] of [[null, "runtime_unavailable"], [{ available: false, classification: "indeterminate", reason: "probe_indeterminate:curl", exec }, "probe_indeterminate"],
			[{ available: false, classification: "allowed", reason: "probe_allowed:cat", exec }, "probe_allowed"], [{ available: true, classification: "denied" }, "runtime_unavailable"]]) {
			const server = fakeServer({ work: lease("L1", [item(1, "unlinked", ["a"])]) });
			const r = await batch({ runner, config, server });
			// Only the content-free skip status per configured profile: no lease, no item, no model.
			assert.deepEqual(server.calls, ["work", "personal"].map((profile) => ({ name: "maintenance_complete", args: { profile, status: "batch_skipped", reason } })));
			assert.deepEqual(Object.values(r.profiles).map((p) => [p.status, p.reported]), [["batch_skipped", true], ["batch_skipped", true]]);
			assert.equal(r.profiles.work.reason, `batch_skipped:${reason}`);
		}
	});

	it("still skips, and records it locally, when the skip status cannot be sent", async () => {
		const server = fakeServer({}, () => { throw new Error("offline"); });
		const r = await batch({ runner: null, config, server });
		assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_complete", "maintenance_complete"]);
		assert.deepEqual(Object.values(r.profiles).map((p) => [p.status, p.reported]), [["batch_skipped", false], ["batch_skipped", false]]);
	});
});

describe("job flow", () => {
	it("judges one profile and one model tier per prompt, then completes item by item on the job lease", async () => {
		const server = fakeServer({ work: lease("LW", [item(1, "unlinked", ["a", "b"]), item(2, "near_duplicate", ["c", "d"])]), personal: lease("LP", [item(3, "weekly_review", ["e"])]) });
		const runner = fakeRunner(dismissAll);
		const r = await batch({ runner, config, server });
		assert.deepEqual(runner.runs.map((x) => [x.model, x.effort, itemsIn(x.prompt).map((i) => i.item_id)]),
			[["gpt-6-luna", "low", [1]], ["gpt-6.1-terra", "high", [2]], ["gpt-6.1-terra", "high", [3]]]);
		assert.ok(runner.runs.every((x) => x.schema === OPS_SCHEMA));
		assert.ok(!runner.runs[2].prompt.includes("private passage a"), "a personal prompt carries no work passage");
		assert.deepEqual(server.calls.map((c) => [c.name, c.args.profile, c.args.lease_id ?? null, c.args.results?.map((x) => x.item_id) ?? null]), [
			["maintenance_next", "work", null, null], ["maintenance_complete", "work", "LW", [1]], ["maintenance_complete", "work", "LW", [2]],
			["maintenance_next", "personal", null, null], ["maintenance_complete", "personal", "LP", [3]]]);
		assert.deepEqual([server.calls[0].args.limit, server.calls[0].args.lease_seconds], [40, 900]);
		assert.deepEqual(r.profiles.work, { status: "completed", items: 2, completed: 2, rejected: 0, retained: 0, dropped_ops: 0, codes: { applied: 2 } });
	});

	it("sends only allowed ops on the item's own subjects, drops nulls and redacts model text", async () => {
		const first = item(1, "near_duplicate", ["a", "b"]);
		first.allowed_ops = ALL_OPS.filter((op) => op !== "flag");
		const server = fakeServer({ work: lease("LW", [first, item(2, "unlinked", ["c"])]) });
		const secret = `ghp_${"A".repeat(36)}`;
		const runner = fakeRunner(({ prompt }) => ({ kind: "ok", part: { results: itemsIn(prompt)[0].item_id === 2
			? [{ item_id: 1, ops: [{ op: "dismiss" }] }] // another run's item
			: [{ item_id: 1, ops: [
				{ op: "save", memory_id: "a", description: `token ${secret}`, content: null, why: null, how_to_apply: null, new_name: null, retire: null },
				{ op: "link", from: "a", to: "z", rel: "relates_to", reason: "outside the item subjects", evidence: [{ kind: "url", ref: "https://example.invalid" }] },
				{ op: "supersede", keep: "a", retire: [] },
				{ op: "flag", node: "a", reason: "not allowed for this item" }] },
			{ item_id: 99, ops: [{ op: "dismiss" }] }] } }));
		const r = await batch({ runner, config: { batch_profiles: ["work"] }, server });
		const sent = server.calls.filter((c) => c.name === "maintenance_complete");
		assert.deepEqual(sent.map((c) => c.args.results), [[{ item_id: 1, ops: [{ op: "save", memory_id: "a", description: "token [REDACTED]" }, { op: "supersede", keep: "a", retire: [] }] }]]);
		assert.deepEqual([r.profiles.work.dropped_ops, r.profiles.work.retained], [4, 1]);
	});

	it("keeps inference evidence and promotion targets on the item's subjects; from_op passes to the server's own check", async () => {
		const signal = item(1, "preference_signal", ["s"]);
		signal.allowed_ops = [...ALL_OPS, "infer_preference", "promote_to_me"];
		const server = fakeServer({ work: lease("LW", [signal]) });
		const secret = `ghp_${"B".repeat(36)}`;
		const infer = (ref) => ({ op: "infer_preference", name: "Prefers small diffs", description: `seen in corrections ${secret}`, why: null, how_to_apply: null, scope: null, evidence: [{ kind: "node", ref }] });
		const runner = fakeRunner(() => ({ kind: "ok", part: { results: [{ item_id: 1, ops: [infer("s"), infer("elsewhere"),
			{ op: "promote_to_me", memory_id: null, from_op: 0, company_free: true }, { op: "promote_to_me", memory_id: "elsewhere", from_op: null, company_free: true }] }] } }));
		const r = await batch({ runner, config: { batch_profiles: ["work"] }, server });
		assert.ok(OPS_SCHEMA.properties.results.items.properties.ops.items.anyOf.some((o) => o.properties.op.enum[0] === "promote_to_me"));
		assert.deepEqual(server.calls.find((c) => c.name === "maintenance_complete").args.results, [{ item_id: 1, ops: [
			{ op: "infer_preference", name: "Prefers small diffs", description: "seen in corrections [REDACTED]", evidence: [{ kind: "node", ref: "s" }] },
			{ op: "promote_to_me", from_op: 0, company_free: true }] }]);
		assert.equal(r.profiles.work.dropped_ops, 2);
	});

	it("sends a weekly review whose links and pointers stay on the item's board subjects, redacted, from a Terra run", async () => {
		const weekly = item(1, "weekly_review", ["t", "p"]);
		weekly.allowed_ops = ["strategic_review", "dismiss"];
		const server = fakeServer({ work: lease("LW", [weekly]) });
		const secret = `ghp_${"C".repeat(36)}`;
		const link = (to, ref = to) => ({ to, reason: `discussed this week ${secret}`, evidence: [{ kind: "node", ref }] });
		const review = (links) => ({ op: "strategic_review", summary: "Two open items.", content: `The ticket leads. ${secret}`, links });
		const runner = fakeRunner(() => ({ kind: "ok", part: { results: [{ item_id: 1, ops: [review([link("t"), link("p", "t")]), review([link("elsewhere")]), review([link("t", "elsewhere")])] }] } }));
		const r = await batch({ runner, config: { batch_profiles: ["work"] }, server });
		assert.deepEqual(runner.runs.map((x) => x.model), ["gpt-6.1-terra"]);
		assert.deepEqual(server.calls.find((c) => c.name === "maintenance_complete").args.results, [{ item_id: 1, ops: [
			{ op: "strategic_review", summary: "Two open items.", content: "The ticket leads. [REDACTED]",
				links: [{ to: "t", reason: "discussed this week [REDACTED]", evidence: [{ kind: "node", ref: "t" }] }, { to: "p", reason: "discussed this week [REDACTED]", evidence: [{ kind: "node", ref: "t" }] }] }] }]);
		assert.equal(r.profiles.work.dropped_ops, 2);
	});
});

describe("work is retained on every failure", () => {
	it("discards every tier and stops profiles when an ok runner returns schema-invalid output", async () => {
		const save = { op: "save", memory_id: "a", description: null, content: null, why: null, how_to_apply: null, new_name: null, retire: true };
		const invalid = [null,
			{ results: [{ item_id: 2, ops: [{ op: "dismiss", unexpected: true }] }] },
			{ results: [{ item_id: 2, ops: [{ ...save, memory_id: "b", content: 42 }] }] },
			{ results: [{ item_id: 2, ops: [{ op: "save", memory_id: "b" }] }] },
			{ results: [{ item_id: 2, ops: [{ op: "promote_to_me", memory_id: "b", from_op: null, company_free: false }] }] },
			{ results: [{ item_id: 2, ops: [{ op: "infer_preference", name: "n", description: "d", why: null, how_to_apply: null, scope: null, evidence: [{ kind: "url", ref: "b" }] }] }] }];
		for (const part of invalid) {
			const server = fakeServer({ work: lease("LW", [item(1, "unlinked", ["a"]), item(2, "near_duplicate", ["b"]) ]), personal: lease("LP", [item(3, "unlinked", ["c"])]) });
			const runner = fakeRunner(({ model }) => ({ kind: "ok", part: model === "gpt-6-luna" ? { results: [{ item_id: 1, ops: [save] }] } : part }));
			const report = await batch({ runner, config, server });
			assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"]);
			assert.deepEqual(server.calls[1].args, { profile: "work", lease_id: "LW", status: "batch_skipped", reason: "bad_output" });
			assert.equal(report.profiles.work.status, "discarded");
			assert.equal(report.profiles.work.reason, "bad_output");
			assert.equal(report.profiles.work.retained, 2);
			assert.equal(report.profiles.personal.status, "batch_skipped");
		}
	});

	it("discards the whole lease on a tool event or unusable output and stops the batch", async () => {
		for (const kind of ["tool_event", "runtime_warning", "bad_output"]) {
			const server = fakeServer({ work: lease("LW", [item(1, "unlinked", ["a"]), item(2, "near_duplicate", ["b"])]), personal: lease("LP", [item(3, "weekly_review", ["e"])]) });
			const runner = fakeRunner((a) => (a.model === "gpt-6-luna" ? dismissAll(a) : { kind }));
			const r = await batch({ runner, config, server });
			assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"], "status only, no result completion or second lease");
			assert.deepEqual(server.calls[1].args, { profile: "work", lease_id: "LW", status: kind === "tool_event" ? "stuck" : "batch_skipped", reason: kind });
			assert.deepEqual(r.profiles.work, { status: "discarded", reason: kind, items: 2, retained: 2, released: true });
			assert.equal(r.profiles.personal.status, "batch_skipped");
		}
	});

	it("keeps going past a refused item, stops at an expired lease, and never starts a run on a short lease", async () => {
		const refuse = (code) => (args) => { if (args.results[0].item_id === 1) throw Object.assign(new Error("x"), { code }); return { results: [{ ops: [] }] }; };
		const items = () => [item(1, "unlinked", ["a"]), item(2, "unlinked", ["b"])];
		let server = fakeServer({ work: lease("LW", items()) }, refuse("validation"));
		let r = await batch({ runner: fakeRunner(dismissAll), config: { batch_profiles: ["work"] }, server });
		assert.deepEqual(server.calls.slice(1).map((c) => c.args.results[0].item_id), [1, 2]);
		assert.deepEqual([r.profiles.work.status, r.profiles.work.completed, r.profiles.work.rejected, r.profiles.work.retained], ["completed", 1, 1, 1]);
		server = fakeServer({ work: lease("LW", items()) }, refuse("lease_expired"));
		r = await batch({ runner: fakeRunner(dismissAll), config: { batch_profiles: ["work"] }, server });
		assert.deepEqual(server.calls.slice(1).map((c) => c.args.results[0].item_id), [1]);
		assert.deepEqual([r.profiles.work.status, r.profiles.work.retained], ["lease_expired", 2]);
		const runner = fakeRunner(dismissAll);
		server = fakeServer({ work: lease("LW", items(), 30_000) });
		r = await batch({ runner, config: { batch_profiles: ["work"] }, server });
		assert.deepEqual([runner.runs.length, server.calls.length, r.profiles.work.status], [0, 2, "lease_short"]);
	});
});

describe("job transport and private files", () => {
	it("refuses redirects without forwarding a private completion body", async () => {
		let received = 0, status = 307;
		const sink = http.createServer((req, res) => { received++; req.resume(); res.end("{}"); });
		const redirector = http.createServer((req, res) => { req.resume(); res.writeHead(status, { location: `http://127.0.0.1:${sink.address().port}/sink` }); res.end(); });
		try {
			sink.listen(0, "127.0.0.1"); await once(sink, "listening");
			redirector.listen(0, "127.0.0.1"); await once(redirector, "listening");
			const tokenFile = path.join(process.env.AGENT_MEMORY_HOME, "dummy-token");
			fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
			fs.writeFileSync(tokenFile, "synthetic-job-token", { mode: 0o600 });
			const job = mcpJob({ server: `http://127.0.0.1:${redirector.address().port}`, token_file: tokenFile });
			for (status of [307, 308]) await assert.rejects(job.call("maintenance_complete", { profile: "work", lease_id: "L", results: [{ item_id: 1, ops: [{ op: "save", memory_id: "a", content: "synthetic private body" }] }] }));
			assert.equal(received, 0);
		} finally {
			await Promise.all([new Promise((resolve) => redirector.close(resolve)), new Promise((resolve) => sink.close(resolve))]);
		}
	});

	it("calls only the two job tools, each with a profile, using the job token from its file", async () => {
		const tokenFile = path.join(process.env.AGENT_MEMORY_HOME, "job-token");
		fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
		fs.writeFileSync(tokenFile, "am_job_secret\n", { mode: 0o600 });
		const seen = [];
		const fetchImpl = async (url, init) => {
			seen.push({ url: String(url), init });
			const body = JSON.parse(init.body);
			const value = body.params.name === "maintenance_next" ? { lease_id: null, items: [] } : { error: { code: "lease_expired", message: "expired" } };
			const result = { content: [{ type: "text", text: JSON.stringify(value) }], ...(body.params.name === "maintenance_next" ? {} : { isError: true }) };
			return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { status: 200 });
		};
		const job = mcpJob({ server: "https://memory.example.invalid", token_file: tokenFile }, fetchImpl);
		assert.deepEqual(await job.call("maintenance_next", { profile: "work", limit: 40 }), { lease_id: null, items: [] });
		await assert.rejects(job.call("maintenance_complete", { profile: "work", lease_id: "L", results: [] }), { code: "lease_expired" });
		await assert.rejects(job.call("save_memory", { profile: "work" }));
		await assert.rejects(job.call("maintenance_next", {}));
		await assert.rejects(mcpJob({ server: "https://memory.example.invalid" }, fetchImpl).call("maintenance_next", { profile: "work" }));
		assert.equal(seen.length, 2);
		for (const { url, init } of seen) {
			assert.equal(url, "https://memory.example.invalid/mcp");
			assert.equal(init.headers.authorization, "Bearer am_job_secret");
			assert.equal(JSON.parse(init.body).method, "tools/call");
		}
		assert.deepEqual(seen.map((s) => [s.init.headers["mcp-name"], JSON.parse(s.init.body).params.arguments.profile]), [["maintenance_next", "work"], ["maintenance_complete", "work"]]);
	});

	it("writes only a private, content-free report", async () => {
		const server = fakeServer({ work: lease("LW", [item(1, "unlinked", ["a"])]) });
		await batch({ runner: fakeRunner(({ prompt }) => ({ kind: "ok", part: { results: [{ item_id: itemsIn(prompt)[0].item_id, ops: [{ op: "flag", node: "a", reason: "secret flag reason text" }] }] } })),
			config: { batch_profiles: ["work"] }, server });
		const files = fs.readdirSync(process.env.AGENT_MEMORY_HOME, { recursive: true }).filter((f) => fs.statSync(path.join(process.env.AGENT_MEMORY_HOME, f)).isFile());
		assert.deepEqual(files, [path.join("batch", "last.json")]);
		const file = path.join(process.env.AGENT_MEMORY_HOME, "batch", "last.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const text = fs.readFileSync(file, "utf8");
		assert.ok(!text.includes("private passage") && !text.includes("secret flag reason"));
	});

	it("asks for strict structured output: every object closed and every field required", () => {
		const walk = (s) => {
			if (s?.type === "object") assert.deepEqual([s.additionalProperties, [...s.required].sort()], [false, Object.keys(s.properties).sort()]);
			for (const v of Object.values(s ?? {})) if (v && typeof v === "object") walk(v);
		};
		walk(OPS_SCHEMA);
	});
});


it("D1 compact output stays strict, redacted and confined to the leased subjects", async () => {
	const target = item(1, "stale_journal", ["journal"]);
	target.allowed_ops = ["compact"];
	const server = fakeServer({ work: lease("D1", [target]) });
	const runner = fakeRunner(() => ({ kind: "ok", part: { results: [{ item_id: 1, ops: [
		{ op: "compact", memory_id: "journal", through_seq: 7, summary: `short ghp_${"A".repeat(36)}`, expected_revision: 8 },
		{ op: "compact", memory_id: "outside", through_seq: 7, summary: "outside", expected_revision: 8 },
	] }] } }));
	const result = await batch({ runner, config: { batch_profiles: ["work"] }, server });
	assert.equal(result.profiles.work.dropped_ops, 1);
	const sent = server.calls.find((c) => c.name === "maintenance_complete");
	assert.deepEqual(sent.args.results, [{ item_id: 1, ops: [{ op: "compact", memory_id: "journal", through_seq: 7, summary: "short [REDACTED]", expected_revision: 8 }] }]);
});

// The Claude Code runner over a fake CLI process that behaves like a child process: "close" only after both streams end.
describe("Claude Code runner: gated, and decided only at process close", () => {
	const MODEL = "claude-sonnet-5-5";
	const frame = (e) => `${JSON.stringify(e)}\n`;
	const init = frame({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: MODEL, permissionMode: "dontAsk" });
	const gateOk = init + frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 });
	const answerFor = (id) => frame({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: JSON.stringify({ results: [{ item_id: id, ops: [{ op: "dismiss" }] }] }) });
	const answer = answerFor(1);
	const toolFrame = frame({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "<tool_use_error>Error: No such tool available: Bash</tool_use_error>", is_error: true }] } });
	function fakeClaude({ gate = gateOk, out = "", err = "", errFirst = false, code = 0, hang = false }) {
		// `out` may list one output per spawned process (one per model tier).
		const proc = { lines: [], signals: [], spawns: 0, closes: 0 };
		proc.spawnFn = () => {
			const tierOut = Array.isArray(out) ? out[proc.spawns] : out;
			proc.spawns++;
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			let closed = false;
			const close = (c, sig) => {
				if (closed) return;
				closed = true;
				let open = 2;
				for (const s of [child.stdout, child.stderr]) { s.on("end", () => { if (!--open) setImmediate(() => { proc.closes++; child.emit("close", c, sig); }); }); s.end(); }
			};
			child.kill = (sig) => { proc.signals.push(sig); close(null, sig); return true; };
			child.stdin = new Writable({ write(chunk, _enc, done) {
				const m = JSON.parse(chunk);
				proc.lines.push(m);
				setImmediate(() => {
					if (closed) return;
					if (m.shouldQuery === false) return void child.stdout.write(gate);
					if (hang) return;
					// A killed process writes nothing more; the parser may kill it during any of these writes.
					const write = (s, text) => { if (!closed) s.write(text); };
					if (errFirst) write(child.stderr, err);
					write(child.stdout, init + tierOut);
					if (!errFirst) write(child.stderr, err);
					close(code, null);
				});
				done();
			} });
			return child;
		};
		return proc;
	}
	const leased = () => fakeServer({ work: lease("LW", [{ ...item(1, "unlinked", ["a"]), context: { nodes: [{ id: "a", passage: "see @/etc/hosts" }], edges: [] } }]) });
	const run = async (proc) => {
		const server = leased();
		const runner = { available: true, classification: "denied", batchExec: claudeExec({ claude: "never-run", runDir: tmp, env: {}, spawnFn: proc.spawnFn }) };
		const report = await batch({ runner, config: { batch_runner: "claude", batch_profiles: ["work"], batch_luna_model: MODEL, batch_terra_model: MODEL }, server });
		return { server, report };
	};

	it("sends the untrusted items only after a zero-turn tool-free init, with every @ escaped, and applies a clean result", async () => {
		const proc = fakeClaude({ out: answer });
		const { server } = await run(proc);
		assert.equal(proc.lines.length, 2);
		assert.equal(proc.lines[0].shouldQuery, false);
		assert.ok(!proc.lines[0].message.content.includes("<items>"));
		assert.ok(!proc.lines[1].message.content.includes("@") && proc.lines[1].message.content.includes("\\u0040/etc/hosts"));
		assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"]);
		assert.deepEqual(server.calls[1].args.results, [{ item_id: 1, ops: [{ op: "dismiss" }] }]);
	});

	it("parks the whole lease as stuck on a tool frame or a stderr router rejection, before or after a valid result", async () => {
		for (const proc of [fakeClaude({ out: answer + toolFrame }), fakeClaude({ out: answer, err: "Error: No such tool available: Bash\n", code: 1 }),
			fakeClaude({ out: answer, err: "Error: unsupported call: Bash\n", errFirst: true })]) {
			const { server, report } = await run(proc);
			assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"], "no item operation");
			assert.deepEqual(server.calls[1].args, { profile: "work", lease_id: "LW", status: "stuck", reason: "tool_event" });
			assert.equal(report.profiles.work.status, "discarded");
		}
	});

	it("discards a result followed by unknown stderr, another frame, an incomplete line or an unclean exit", async () => {
		for (const [proc, reason] of [[fakeClaude({ out: answer, err: "warning: something\n" }), "runtime_warning"],
			[fakeClaude({ out: answer + frame({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }) }), "runtime_warning"],
			[fakeClaude({ out: answer + "{\"type\":" }), "bad_events"], [fakeClaude({ out: answer, code: 1 }), "runtime_error"]]) {
			const { server } = await run(proc);
			assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"], reason);
			assert.deepEqual(server.calls[1].args, { profile: "work", lease_id: "LW", status: "batch_skipped", reason });
		}
	});

	it("discards the whole two-tier lease, after killing and closing the process, on a non-object frame after a valid result", async () => {
		const proc = fakeClaude({ out: [answer, `${answerFor(2)}null\n`] });
		const server = fakeServer({ work: lease("LW", [item(1, "unlinked", ["a"]), item(2, "near_duplicate", ["b"])]) });
		const runner = { available: true, classification: "denied", batchExec: claudeExec({ claude: "never-run", runDir: tmp, env: {}, spawnFn: proc.spawnFn }) };
		const report = await batch({ runner, config: { batch_runner: "claude", batch_profiles: ["work"], batch_luna_model: MODEL, batch_terra_model: MODEL }, server });
		assert.deepEqual([proc.spawns, proc.closes, proc.signals], [2, 2, ["SIGKILL"]]);
		assert.deepEqual(server.calls.map((c) => c.name), ["maintenance_next", "maintenance_complete"], "no item operation");
		assert.deepEqual(server.calls[1].args, { profile: "work", lease_id: "LW", status: "batch_skipped", reason: "bad_events" });
		assert.equal(report.profiles.work.status, "discarded");
	});

	it("ignores only the exact ui_invalidate notice before the gate init; any other early or later notice still fails closed", async () => {
		const invalidate = (extra = {}) => frame({ type: "system", subtype: "ui_invalidate", event: "ui.render", instances: [{ surface: "x", component: "y", instance_id: "z" }], ...extra });
		const proc = fakeClaude({ gate: invalidate() + gateOk, out: answer });
		const { server } = await run(proc);
		assert.equal(proc.lines.length, 2);
		assert.deepEqual(server.calls[1].args.results, [{ item_id: 1, ops: [{ op: "dismiss" }] }]);
		const job = { prompt: "do it\n<items>\n[]\n</items>\n", schema: {}, model: MODEL, effort: "low" };
		const gateNotice = frame({ type: "system", subtype: "informational", content: "x" });
		for (const gate of [gateNotice + gateOk, invalidate({ event: "other" }) + gateOk, init + invalidate() + frame({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0 })]) {
			const p = fakeClaude({ gate, out: answer });
			assert.deepEqual(await claudeExec({ claude: "x", runDir: tmp, env: {}, spawnFn: p.spawnFn })(job), { kind: "runtime_warning" });
			assert.equal(p.lines.length, 1, "no untrusted text after a rejected gate");
		}
		const later = fakeClaude({ out: invalidate() + answer });
		assert.deepEqual(await claudeExec({ claude: "x", runDir: tmp, env: {}, spawnFn: later.spawnFn })(job), { kind: "runtime_warning" });
		assert.equal(later.lines.length, 2);
	});

	it("spawns Claude with only PATH, HOME, the OS-account USER and its config dir, inheriting no ambient identity or credential", async () => {
		const planted = { USER: "planted-user", LOGNAME: "planted-user", ANTHROPIC_API_KEY: "planted", ANTHROPIC_AUTH_TOKEN: "planted", CLAUDE_CODE_OAUTH_TOKEN: "planted",
			CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/planted", AGENT_MEMORY_WORK_TOKEN: "planted", MCP_TIMEOUT: "1" };
		const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
		Object.assign(process.env, planted);
		try {
			const proc = fakeClaude({ out: answer });
			let seen;
			const spawnFn = (cmd, args, opts) => { seen = opts; return proc.spawnFn(cmd, args, opts); };
			const job = { prompt: "do it\n<items>\n[]\n</items>\n", schema: {}, model: MODEL, effort: "low" };
			const out = await claudeExec({ claude: "x", runDir: tmp, env: claudeEnv({ claude_config_dir: "/Users/someone/.plaude" }), spawnFn })(job);
			assert.equal(out.kind, "ok");
			assert.deepEqual(seen.env, { PATH: saved.PATH ?? process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), USER: os.userInfo().username, CLAUDE_CONFIG_DIR: "/Users/someone/.plaude" });
			assert.notEqual(seen.env.USER, "planted-user");
		} finally {
			for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		}
	});

	it("writes no untrusted text when the gate init exposes a tool, and waits for the killed process on a timeout", async () => {
		const exposed = fakeClaude({ gate: frame({ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [], model: MODEL, permissionMode: "dontAsk" }) });
		const job = { prompt: "do it\n<items>\n[]\n</items>\n", schema: {}, model: MODEL, effort: "low" };
		assert.deepEqual(await claudeExec({ claude: "x", runDir: tmp, env: {}, spawnFn: exposed.spawnFn })(job), { kind: "runtime_warning" });
		assert.deepEqual([exposed.lines.length, exposed.signals], [1, ["SIGKILL"]]);
		const stalled = fakeClaude({ hang: true });
		assert.deepEqual(await claudeExec({ claude: "x", runDir: tmp, env: {}, spawnFn: stalled.spawnFn, timeoutMs: 50 })(job), { kind: "runtime_error" });
		assert.deepEqual(stalled.signals, ["SIGKILL"]);
	});
});
