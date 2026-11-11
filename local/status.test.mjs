// node --test local/status.test.mjs: the local `status --json` view (#118): the repo-facts switches and synthesis slots, the client's
// report counts merged under `facts`, session-start latency from facts/inject/<day>.jsonl, and loop-guard fires from fires.jsonl.
// Every test runs in its own AGENT_MEMORY_HOME under a temporary directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-status-test-"));
process.env.AGENT_MEMORY_HOME = path.join(tmp, "home-0");
const { factsStatus, formatLocalStatus, injectLatency, loopGuardStatus } = await import("./status.mjs");

let n = 0, home = "";
beforeEach(() => { home = process.env.AGENT_MEMORY_HOME = path.join(tmp, `home-${++n}`); });

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY = 86_400_000;
const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const lines = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const run = (ago, ms, outcome = "ok") => ({ at: new Date(NOW - ago).toISOString(), ms, outcome });

describe("status facts", () => {
	it("reports the switches, the client's counts and a zeroed synthesis block on an empty home, with no latency invented", () => {
		const s = factsStatus({ facts: { inject: true, synthesis: false } }, NOW);
		assert.equal(s.inject, true);
		assert.equal(s.synthesis, false);
		assert.deepEqual(s.synth, { used_today: 0, cap: 3, queued: 0, unknown_attempts: 0 });
		for (const k of ["partitions", "pending_reports", "pending_v1", "conflicts", "unattributed_commands_7d"]) assert.equal(s[k], 0, k);
		assert.equal(s.inject_p95_ms, null);
		assert.equal(s.inject_timeouts_7d, 0);
		assert.equal(s.inject_runs_7d, 0);
	});

	it("takes today's synthesis slots from the synthesis state when synthesis is on", () => {
		write("facts/synth/state.json", JSON.stringify({ v: 1, day: "2026-11-11", used: 2, repos: {}, jobs: [], unacked: [] }));
		const s = factsStatus({ facts: { synthesis: true } }, NOW);
		assert.equal(s.synthesis, true);
		assert.equal(s.synth.used_today, 2);
		assert.equal(s.synth.cap, 3);
	});

	it("counts unattributed commands from the last 7 days only", () => {
		write("facts/stats/unattributed-2026-11-10.json", JSON.stringify({ count: 4 }));
		write("facts/stats/unattributed-2026-10-01.json", JSON.stringify({ count: 9 }));
		assert.equal(factsStatus({}, NOW).unattributed_commands_7d, 4);
	});
});

describe("status inject latency", () => {
	it("computes p95 and timeouts over the last 7 days, skipping older runs and torn lines", () => {
		const today = lines([run(1000, 100), run(2000, 200), run(3000, 300), run(4000, 1600, "timeout"), "{\"at\":", ""]);
		write("facts/inject/2026-11-11.jsonl", today);
		write("facts/inject/2026-11-08.jsonl", lines([run(3 * DAY, 400), run(3 * DAY, 1500, "timeout")]));
		write("facts/inject/2026-10-01.jsonl", lines([{ at: "2026-10-01T00:00:00.000Z", ms: 99_999, outcome: "timeout" }]));
		const r = injectLatency(NOW);
		assert.equal(r.inject_runs_7d, 6);
		assert.equal(r.inject_timeouts_7d, 2);
		assert.equal(r.inject_p95_ms, 1600); // nearest rank: the 6th of 6 sorted runs
		assert.equal(factsStatus({}, NOW).inject_p95_ms, 1600);
	});

	it("takes the 95th percentile, not the maximum, once there are enough runs", () => {
		write("facts/inject/2026-11-11.jsonl", lines(Array.from({ length: 40 }, (_, i) => run(1000, i === 39 ? 9000 : (i + 1) * 10))));
		assert.equal(injectLatency(NOW).inject_p95_ms, 380); // rank 38 of 40
	});
});

describe("status loop guard", () => {
	it("counts fires and shadow would-fires in the last 7 days, across the rotated log", () => {
		write("loop-guard/fires.jsonl.1", lines([{ v: 1, at: new Date(NOW - 2 * DAY).toISOString(), rule: "repeat", shadow: false }]));
		write("loop-guard/fires.jsonl", lines([{ v: 1, at: new Date(NOW - DAY).toISOString(), rule: "errors", shadow: true },
			{ v: 1, at: new Date(NOW - 30 * DAY).toISOString(), rule: "repeat", shadow: false }]));
		const g = loopGuardStatus({ loop_guard: { enabled: true, shadow: true } }, NOW);
		assert.deepEqual([g.enabled, g.shadow, g.fires_7d, g.shadow_fires_7d], [true, true, 1, 1]);
		assert.deepEqual(g.by_rule_7d, { repeat: 1, errors: 1 });
		assert.equal(g.last_fire_at, new Date(NOW - DAY).toISOString());
		const text = formatLocalStatus({ facts: factsStatus({}, NOW), loop_guard: g });
		assert.match(text, /Loop guard: on \(shadow\); fires in the last 7 days: 1, shadow would-fires: 1/);
		assert.match(text, /Inject p95 \(7 days\): no runs logged/);
	});
});
