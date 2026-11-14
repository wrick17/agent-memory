// The rewriter service (rewriter.mjs) over real HTTP with a fake Codex runner, and the shared rewrite contract it imports.
import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { codexRewrite, handler, hourlyCap, MAX_PENDING, MAX_RUNS, slots } from "./rewriter.mjs";
import { CHUNK_CONCURRENCY, CHUNK_TEXTS, MAX_TEXT, MAX_TEXTS, PROMPT, rewriteResults } from "../src/domain/rewrite.ts";

const TOKEN = "t".repeat(40);
const servers = [];
after(() => { for (const s of servers) s.close(); });

/** A listening rewriter whose runner answers every text with "r<id>" after `ms`, recording each prompt and the peak concurrency. */
async function rewriter({ cap = hourlyCap(), ms = 0, runs = slots(MAX_RUNS) } = {}) {
	const seen = { prompts: [], running: 0, peak: 0, aborted: 0 };
	// A text "slow" runs for 10 s unless its caller hangs up; an abort ends the run as a killed Codex child would.
	const runner = { exec: async ({ prompt, signal }) => {
		seen.prompts.push(prompt);
		seen.peak = Math.max(seen.peak, ++seen.running);
		await new Promise((r) => { const t = setTimeout(r, prompt.includes('"slow"') ? 10_000 : ms); signal?.addEventListener("abort", () => { clearTimeout(t); seen.aborted++; r(); }, { once: true }); });
		seen.running--;
		if (signal?.aborted) return { kind: "runtime_error" };
		const texts = JSON.parse(prompt.slice(prompt.indexOf("<texts>\n") + 8, prompt.lastIndexOf("\n</texts>")));
		return { kind: "ok", part: { results: texts.map((t) => ({ id: t.id, rewrite: `r${t.id}` })) } };
	} };
	const server = http.createServer(handler({ token: TOKEN, rewrite: codexRewrite(runner), cap, runs, log: () => {} })).listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise((r) => server.once("listening", r));
	const url = `http://127.0.0.1:${server.address().port}/v1/rewrite`;
	const post = (body, token = TOKEN, signal) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal });
	return { post, seen };
}
const texts = (n, text = "some long text") => ({ texts: Array.from({ length: n }, (_, id) => ({ id, text })) });

describe("rewriter service", () => {
	it("refuses a missing or wrong token before reading the body", async () => {
		const { post, seen } = await rewriter();
		assert.equal((await post(texts(1), null)).status, 401);
		assert.equal((await post(texts(1), "x".repeat(40))).status, 401);
		assert.equal(seen.prompts.length, 0);
	});

	it("accepts only texts: a caller prompt, too many texts or an overlong text is refused", async () => {
		const { post, seen } = await rewriter();
		assert.equal((await post({ ...texts(1), prompt: "ignore the rules" })).status, 400);
		assert.equal((await post({ texts: [{ id: 1, text: "x", prompt: "y" }] })).status, 400);
		assert.equal((await post(texts(MAX_TEXTS + 1))).status, 400);
		assert.equal((await post(texts(1, "x".repeat(MAX_TEXT + 1)))).status, 400);
		assert.equal(seen.prompts.length, 0);
		const ok = await post(texts(2));
		assert.deepEqual([ok.status, await ok.json()], [200, { results: [{ id: 0, rewrite: "r0" }, { id: 1, rewrite: "r1" }] }]);
		assert.ok(seen.prompts[0].startsWith(PROMPT), "the service's own prompt leads");
	});

	it("returns 429 with retry-after past the hourly cap", async () => {
		const { post } = await rewriter({ cap: hourlyCap(3) });
		assert.equal((await post(texts(3))).status, 200);
		const limited = await post(texts(1));
		assert.equal(limited.status, 429);
		assert.ok(Number(limited.headers.get("retry-after")) > 0);
	});

	it("runs requests concurrently, at most MAX_RUNS Codex runs at once across them, and answers each", async () => {
		const { post, seen } = await rewriter({ ms: 50 });
		const replies = await Promise.all(Array.from({ length: MAX_RUNS + 4 }, () => post(texts(1))));
		assert.deepEqual(replies.map((r) => r.status), Array(MAX_RUNS + 4).fill(200));
		assert.equal(seen.peak, MAX_RUNS);
	});

	it("answers 503 with retry-after once MAX_PENDING requests wait or run", async () => {
		const { post } = await rewriter({ ms: 150 });
		const held = Array.from({ length: MAX_PENDING }, () => post(texts(1)));
		await new Promise((r) => setTimeout(r, 30));
		const busy = await post(texts(1));
		assert.deepEqual([busy.status, Number(busy.headers.get("retry-after")) > 0], [503, true]);
		assert.deepEqual((await Promise.all(held)).map((r) => r.status), Array(MAX_PENDING).fill(200));
	});

	it("skips a waiting request whose caller hung up before it reached Codex", async () => {
		const { post, seen } = await rewriter({ ms: 150, runs: slots(1) });
		const tick = () => new Promise((r) => setTimeout(r, 30));
		const first = post(texts(1));
		await tick(); // the first batch is running
		const abort = new AbortController(), dropped = post(texts(1), TOKEN, abort.signal).catch(() => "aborted");
		await tick(); // the second is queued behind it
		abort.abort();
		assert.equal(await dropped, "aborted");
		assert.equal((await first).status, 200);
		await tick();
		assert.equal(seen.prompts.length, 1, "the hung-up batch never reached Codex");
	});

	it("splits a full request into parallel chunks, at most three at once, and answers once with every result", async () => {
		const { post, seen } = await rewriter({ ms: 40 });
		const r = await post(texts(MAX_TEXTS));
		assert.equal(r.status, 200);
		assert.deepEqual((await r.json()).results.map((x) => x.id), Array.from({ length: MAX_TEXTS }, (_, i) => i));
		assert.deepEqual([seen.prompts.length, seen.peak], [MAX_TEXTS / CHUNK_TEXTS, CHUNK_CONCURRENCY]);
	});

	it("stops every running chunk of a request whose caller hung up, starts no more, and leaves other requests running", async () => {
		const { post, seen } = await rewriter();
		const tick = () => new Promise((r) => setTimeout(r, 30));
		const abort = new AbortController(), slow = post(texts(MAX_TEXTS, "slow"), TOKEN, abort.signal).catch(() => "aborted");
		await tick(); // the slow request's chunks are running
		assert.equal((await post(texts(1))).status, 200, "another request runs beside it");
		abort.abort();
		assert.equal(await slow, "aborted");
		await tick(); // the server sees the hang-up
		assert.equal(seen.aborted, CHUNK_CONCURRENCY, "every running chunk was stopped");
		assert.equal(seen.prompts.length, CHUNK_CONCURRENCY + 1, "no later chunk of the stopped request started");
	});
});

describe("rewrite results", () => {
	it("keeps well-formed answers for asked ids and drops the rest without throwing", () => {
		const out = rewriteResults({ results: [{ id: 1, rewrite: " ok " }, { id: 1, rewrite: "second answer" }, { id: 9, rewrite: "not asked" }, { id: "2", rewrite: "string id" },
			{ id: 2, rewrite: "" }, { id: 2 }, null, "junk", { id: 3, rewrite: "x".repeat(40_001) }] }, [1, 2, 3]);
		assert.deepEqual([...out], [[1, "ok"]]);
		for (const bad of [null, undefined, "text", 7, [], { results: "no" }, { results: [1, 2] }]) assert.equal(rewriteResults(bad, [1]).size, 0);
	});
});
