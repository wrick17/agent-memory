// Issue #20 synthetic recall gate (runs in `npm test`, so in CI). It seeds the invented records of
// fixtures/eval/synthetic-cases.json, runs every case through POST /v1/recall with a read-only device token and count_hits: false
// on the lexical, vector and hybrid channels, and scores them with local/eval-score.mjs, the CLI's scorer. It fails when lexical
// recall_all_at_k drops below the recorded baseline. `npm run eval:baseline` records the baselines; they only rise.
// Synthetic records and the fake bag-of-words embeddings of test/fakes.js: no live provider, and not a semantic-quality result.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
// @ts-expect-error local/ is plain JavaScript without declarations; this is the CLI's own scorer
import { casesOf, runCases, runSummary } from "../local/eval-score.mjs";
import fixture from "./fixtures/eval/synthetic-cases.json";
import { call, contextFor, deviceToken } from "./helpers";

const PROFILE = "personal", K = 5, CHANNEL_NAMES = ["lexical", "vector", "hybrid"] as const;
const SOURCE = "synthetic fixture test/fixtures/eval/synthetic-cases.json with the fake embeddings of test/fakes.js; not a live provider or semantic-quality result";
type Summary = { channels: string; k: number; cases: number; recall_all_at_k: number; any_hit_at_k: number; mrr: number; source?: string };

it("scores the synthetic cases on all three channels, counts no recall hits, and holds the lexical baseline", async () => {
	const owner = await contextFor();
	const ids = new Map<string, string>();
	for (const m of fixture.memories) ids.set(m.name, (await call<{ memory_id: string }>(owner, "save_memory", { ...m, profile: PROFILE })).memory_id);
	const ref = owner.account.profiles.find((p) => p.profile === PROFILE)!;
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
	// Each alarm embeds at most 16 cards and re-arms while more are due, so one alarm can leave some of the 24 unindexed, and vector
	// or hybrid scoring would record false misses. Run alarms until every fixture card is embedded; an alarm already in flight reports
	// ran: false, so wait briefly for it. Bounded, and asserted before any scoring.
	const unembedded = () => runInDurableObject(stub, (_i, s) => [...ids.values()].filter((id) =>
		!s.storage.sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status = 'active' AND embed_hash = card_hash", id).toArray().length));
	for (let i = 0; i < 50 && (await unembedded()).length; i++) if (!(await runDurableObjectAlarm(stub))) await new Promise((r) => setTimeout(r, 20));
	expect(await unembedded(), "fixture cards still waiting for an embedding").toEqual([]);
	const idOf = (name: string) => {
		const id = ids.get(name);
		if (!id) throw new Error(`the fixture names no record called ${name}`);
		return id;
	};
	const cases = casesOf({ schema_version: 1, cases: fixture.cases.map((c) => (Array.isArray(c.expected)
		? { ...c, expected: c.expected.map(idOf) }
		: { ...c, expected: { source_top1: { hosted_memory_id: idOf(c.expected.source_top1.hosted_memory_id) } } })) }, "synthetic-cases.json");

	const { token } = await deviceToken("eval-synthetic-reader", ["read"], [PROFILE], PROFILE);
	const recall = async (body: object) => {
		const r = await exports.default.fetch(new Request(new URL("/v1/recall", env.RESOURCE_URL), {
			method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
		if (!r.ok) throw new Error(`POST /v1/recall: HTTP ${r.status} ${await r.text()}`);
		return r.json() as Promise<{ results: { memory_id: string }[] }>;
	};
	const hits = () => runInDurableObject(stub, (_i, s) => s.storage.sql.exec<{ daily: string; totals: string }>(
		"SELECT (SELECT json_group_array(json_array(node_id, day, hits)) FROM recall_daily) AS daily, (SELECT json_group_array(json_array(day, recalls)) FROM recall_totals) AS totals").one());

	const before = await hits();
	const summaries: Record<string, Summary> = {};
	for (const channels of CHANNEL_NAMES) {
		const report = await runCases({ cases, profile: PROFILE, channels, k: K, read: { recall } });
		expect(report.cases).toBe(fixture.cases.length);
		// The known golden-filter gap stays visible: /v1/recall takes no type filter, so these cases ran unfiltered.
		expect(report.unsupported_filters).toEqual([{ case: "syn-golden-21", filters: ["type"] }, { case: "syn-golden-22", filters: ["type"] }]);
		summaries[channels] = { ...runSummary(report, PROFILE), source: SOURCE };
	}
	// One counted recall afterwards: once its hits land, recall_daily holds exactly its own rows, so the eval runs added none.
	const control = await recall({ keyword: "Moonbeam", profile: PROFILE, limit: K });
	expect(control.results.length).toBeGreaterThan(0);
	let after = before;
	for (let i = 0; i < 50 && after.daily === before.daily; i++) {
		await new Promise((r) => setTimeout(r, 100));
		after = await hits();
	}
	expect(before).toEqual({ daily: "[]", totals: "[]" });
	expect((JSON.parse(after.daily) as [string, string, number][]).map(([id, , n]) => [id, n]).sort())
		.toEqual(control.results.map((r) => [r.memory_id, 1]).sort());
	expect((JSON.parse(after.totals) as [string, number][]).map(([, n]) => n)).toEqual([1]);

	const writer = inject("evalBaselineUrl");
	if (writer) {
		for (const s of Object.values(summaries)) {
			const r = await (await fetch(writer, { method: "POST", body: JSON.stringify(s) })).json() as { written?: boolean; reason?: string; error?: string };
			console.log(`eval:baseline ${s.channels}: recall_all_at_k ${s.recall_all_at_k}, any_hit_at_k ${s.any_hit_at_k}, mrr ${s.mrr}; ${r.written ? "written" : `not written (${r.reason ?? r.error})`}`);
			expect(r.written || r.reason === "the scores equal the baseline", r.reason ?? r.error).toBe(true);
		}
		return;
	}
	const baselines = inject("evalBaselines");
	for (const channels of CHANNEL_NAMES) {
		const b = baselines[channels] as Summary | null;
		expect(b, `no synthetic ${channels} baseline: run npm run eval:baseline`).not.toBeNull();
		expect({ channels: b!.channels, k: b!.k, cases: b!.cases, source: b!.source }, `the ${channels} baseline is for another fixture or k`)
			.toEqual({ channels, k: K, cases: fixture.cases.length, source: SOURCE });
	}
	expect(summaries.lexical!.recall_all_at_k, "lexical recall_all_at_k fell below the synthetic baseline")
		.toBeGreaterThanOrEqual((baselines.lexical as Summary).recall_all_at_k);
});
