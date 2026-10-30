// G4 isolation and the local half of G5 (vector channel, 300 ms fallback, EMBEDDINGS=off), plus generation identities.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountStore } from "../src/account/store";
import { requestHash } from "../src/domain/ids";
import { redactPayload } from "../src/domain/redact";
import { accountStub } from "../src/mcp";
import { call, contextFor, deviceToken, devicePrincipal, OWNER, outcome } from "./helpers";

const workRepo = { remote: "git@github.com:Sequoia-Engineering/web.git" };
const profileStub = (c: Awaited<ReturnType<typeof contextFor>>, name: string) => {
	const ref = c.account.profiles.find((p) => p.profile === name)!;
	return env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
};

describe("G4 isolation", () => {
	it("keeps a personal device token out of work", async () => {
		const owner = await contextFor();
		const w = await call(owner, "save_memory", { name: "Work secret plan", type: "reference", description: "work only", content: "quarterly roadmap", repo: workRepo });
		expect(w.profile).toBe("work");
		const { token } = await deviceToken("personal-box", ["read", "write"], ["personal", "me"], "personal");
		const device = await contextFor(devicePrincipal(token));
		expect(await outcome(device, "get_memory", { memory_id: w.memory_id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(device, "recall_memories", { keyword: "roadmap", profile: "work" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(device, "recall_memories", { keyword: "roadmap", repo: workRepo })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const own = await call<{ read_set: string[]; results: unknown[] }>(device, "recall_memories", { keyword: "roadmap" });
		expect(own.read_set).toEqual(["personal", "me"]);
		expect(own.results).toHaveLength(0);
	});

	it("reads only work and me when routed to work, and keeps same-named records apart", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "personal copy", content: "personal lockfile note", profile: "personal" });
		const work = await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "work copy", content: "work lockfile note", repo: workRepo });
		const me = await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "me copy", content: "me lockfile note", profile: "me", company_free: true, repo: workRepo });
		expect(work.memory_id).not.toBe(me.memory_id);
		const r = await call<{ read_set: string[]; results: { profile: string; memory_id: string }[] }>(c, "recall_memories", { keyword: "lockfile habit", repo: workRepo });
		expect(r.read_set).toEqual(["work", "me"]);
		expect(new Set(r.results.map((x) => x.profile))).toEqual(new Set(["work", "me"]));
		expect(r.results.map((x) => x.memory_id)).toEqual(expect.arrayContaining([work.memory_id, me.memory_id]));
		expect(await outcome(c, "get_memory", { name: "Lockfile habit", repo: workRepo })).toMatchObject({ ok: false, error: { code: "ambiguous" } });
	});

	it("guards every write into me", async () => {
		const c = await contextFor();
		const base = { name: "Prefers small diffs", type: "user", description: "a preference", content: "Keep changes small." };
		expect(await outcome(c, "save_memory", { ...base, profile: "me", repo: workRepo, request_id: "g4-me-1" })).toMatchObject({ ok: false, error: { code: "me_requires_company_free" } });
		expect(await outcome(c, "save_memory", { ...base, content: "Learned at Sequoia-Engineering standups.", profile: "me", company_free: true, repo: workRepo }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "Sequoia-Engineering" } } });
		expect(await outcome(c, "save_memory", { ...base, content: "Mail me at a@b.co", profile: "me", company_free: true })).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		// The refused request id was released, so the corrected write may reuse it.
		const ok = await call(c, "save_memory", { ...base, profile: "me", company_free: true, repo: workRepo, request_id: "g4-me-1" });
		expect(ok.profile).toBe("me");
		expect(await outcome(c, "append_memory", { memory_id: ok.memory_id, content: "more", request_id: "g4-me-2" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await outcome(c, "save_memory", { ...base, name: "Unrouted" })).toMatchObject({ ok: false, error: { code: "route_required" } });
		const path = await call(c, "save_memory", { ...base, name: "Path routed", repo: { path: "/Users/test/work/api" } });
		expect(path.profile).toBe("work");
	});
	it("never lets a pending request binding skip the me guard (crash after binding, or overlapping identical calls)", async () => {
		const c = await contextFor();
		const unsafe = { name: "Guard bypass probe", type: "user", description: "a preference", content: "Sequoia-Engineering private roadmap", profile: "me", repo: workRepo };
		// Durable state when the Worker binds the request and dies before the guard runs.
		const crashed = { ...unsafe, request_id: "f1-crash-after-bind" };
		await accountStub(env, OWNER).bindRequest({ requestId: crashed.request_id, profile: "me", op: "save_memory", payloadHash: requestHash("save_memory", redactPayload(crashed)) });
		expect(await outcome(c, "save_memory", crashed)).toMatchObject({ ok: false, error: { code: "me_requires_company_free" } });
		const overlapping = { ...unsafe, name: "Guard bypass probe 2", request_id: "f1-overlap" };
		const both = await Promise.all([outcome(c, "save_memory", overlapping), outcome(c, "save_memory", overlapping)]);
		expect(both.every((r) => !r.ok)).toBe(true);
		const leaked = await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "private roadmap", profile: "me" });
		expect(leaked.results).toHaveLength(0);
	});

	it("still replays a committed me write after the guard would refuse it", async () => {
		const c = await contextFor();
		const args = { name: "Committed me replay", type: "user", description: "a preference", content: "Prefers rebase over merge.", profile: "me", company_free: true, request_id: "f1-committed" };
		const first = await call(c, "save_memory", args);
		await accountStub(env, OWNER).admin({ op: "addSensitiveTerm", term: "rebase" });
		const later = await contextFor();
		expect(await call(later, "save_memory", args)).toMatchObject({ action: "replayed", memory_id: first.memory_id, profile: "me" });
		expect(await outcome(later, "save_memory", { ...args, name: "Fresh me write", request_id: "f1-fresh" })).toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "rebase" } } });
	});
});

describe("recall channels and the vector fallback", () => {
	it("finds a record by exact name, literal substring and full text, and by vector once embedded", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { name: "Token refresh client", type: "project", description: "Moved refresh into one shared client",
			why: "Three call sites each retried", content: "The SEQ-1234 refresh loop came from per-call retries in web.", evidence: [{ kind: "ticket", ref: "jira:SEQ-1234" }], profile: "test" });
		const lexical = await call<{ results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean }>(c, "recall_memories", { keyword: "SEQ-1234", profile: "test" });
		expect(lexical.results[0]).toMatchObject({ memory_id: saved.memory_id });
		expect(lexical.results[0]!.matched_by).toEqual(expect.arrayContaining(["fulltext", "literal"]));
		const exact = await call<{ results: { memory_id: string; matched_by: string[] }[] }>(c, "recall_memories", { keyword: "token refresh client", profile: "test" });
		expect(exact.results[0]!.matched_by).toContain("exact");
		// The write armed the alarm for now; it may already have run. Run it if it is still pending, then wait for the card.
		await runDurableObjectAlarm(profileStub(c, "test"));
		for (let i = 0; i < 40 && (await call(c, "get_memory", { memory_id: saved.memory_id })).embedding_status !== "embedded"; i++) await new Promise((r) => setTimeout(r, 50));
		const semantic = await call<{ results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean }>(c, "recall_memories", { keyword: "shared client retried", profile: "test" });
		expect(semantic.lexical_only).toBe(false);
		expect(semantic.results.find((r) => r.memory_id === saved.memory_id)?.matched_by).toContain("vector");
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const ids = await (env as unknown as { VECTORS: { _ids(): Promise<string[]> } }).VECTORS._ids();
		expect(ids).toContain(`g${ref.generation}:${saved.memory_id}`);
		const got = await call(c, "get_memory", { memory_id: saved.memory_id });
		expect(got.embedding_status).toBe("embedded");
	});

	it("re-embeds a journal when an append changes its first 1,200 characters, and only then", async () => {
		const c = await contextFor();
		const j = await call(c, "save_memory", { name: "codex: semantic journal", type: "project", kind: "journal", description: "journal", profile: "test" });
		const settle = async () => {
			await runDurableObjectAlarm(profileStub(c, "test"));
			for (let i = 0; i < 40 && (await call(c, "get_memory", { memory_id: j.memory_id })).embedding_status !== "embedded"; i++) await new Promise((r) => setTimeout(r, 50));
		};
		const hash = async () => runInDurableObject(profileStub(c, "test"), (_i, s) => s.storage.sql.exec<{ card_hash: string; embed_hash: string | null }>(
			"SELECT card_hash, embed_hash FROM nodes WHERE id = ?", j.memory_id).one());
		await settle();
		const first = await hash();
		await call(c, "append_memory", { memory_id: j.memory_id, content: "distinctive zeppelin harbour notes", request_id: "f3-first" });
		// The alarm may finish before the next read, so check the card itself: the prefix append changed it.
		expect((await hash()).card_hash).not.toBe(first.card_hash);
		await settle();
		const fresh = await hash();
		expect(fresh.embed_hash).toBe(fresh.card_hash);
		const found = await call<{ results: { memory_id: string; matched_by: string[] }[] }>(c, "recall_memories", { keyword: "zeppelin harbour", profile: "test" });
		expect(found.results.find((r) => r.memory_id === j.memory_id)?.matched_by).toContain("vector");
		await call(c, "append_memory", { memory_id: j.memory_id, content: "x".repeat(1300), request_id: "f3-fill" });
		await settle();
		const full = await hash();
		await call(c, "append_memory", { memory_id: j.memory_id, content: "past the card prefix", request_id: "f3-tail" });
		expect(await hash()).toEqual({ card_hash: full.card_hash, embed_hash: full.card_hash }); // card unchanged, nothing became due
		expect((await call(c, "get_memory", { memory_id: j.memory_id })).embedding_status).toBe("embedded");
	});

	// One 3 s deadline covers the query embedding and the Vectorize query (decision of 2026-10-28; it replaced a 300 ms wait).
	type Recall = { results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean; diagnostics: Record<string, Record<string, string> | string> };
	const fake = () => (env as unknown as { AI: { _pending(): Promise<number>; _calls(): Promise<number> } }).AI;
	const probe = async (c: Awaited<ReturnType<typeof contextFor>>, name: string) => {
		const saved = await call(c, "save_memory", { name, type: "reference", description: "deadline", content: "deadline probe body", profile: "test" });
		await runDurableObjectAlarm(profileStub(c, "test"));
		for (let i = 0; i < 40 && (await call(c, "get_memory", { memory_id: saved.memory_id })).embedding_status !== "embedded"; i++) await new Promise((r) => setTimeout(r, 50));
		return saved.memory_id as string;
	};
	const timed = async (c: Awaited<ReturnType<typeof contextFor>>, keyword: string) => {
		const at = Date.now();
		const r = await call<Recall>(c, "recall_memories", { keyword, profile: "test" });
		return { r, ms: Date.now() - at, d: r.diagnostics.test as Record<string, string> };
	};

	it("lets semantic results that arrive after the old limits contribute within the shared 3 s deadline", async () => {
		const c = await contextFor();
		const id = await probe(c, "Deadline probe late");
		const slowEmbedding = await timed(c, "deadline probe [[embed-slow]]");
		expect(slowEmbedding.ms).toBeGreaterThanOrEqual(1500);
		expect(slowEmbedding.d).toMatchObject({ embedding: "ok", vector: expect.stringMatching(/^hits:/) });
		expect(slowEmbedding.r.results.find((x) => x.memory_id === id)?.matched_by).toContain("vector");
		const slowVector = await timed(c, "deadline probe [[vector-slow]]");
		expect(slowVector.ms).toBeGreaterThanOrEqual(2000);
		expect(slowVector.ms).toBeLessThan(3000);
		expect(slowVector.r.results.find((x) => x.memory_id === id)?.matched_by).toContain("vector");
	});

	it("returns the ready lexical results at the deadline or on a provider failure, and says which stage missed", async () => {
		const c = await contextFor();
		const id = await probe(c, "Deadline probe missed");
		const found = (r: Recall) => r.results.find((x) => x.memory_id === id)?.matched_by;
		// The embedding is still pending when the lexical results come back: lexical work never waits for it.
		const hungEmbedding = await timed(c, "deadline probe [[embed-hang]]");
		expect(await fake()._pending()).toBeGreaterThan(0);
		expect(hungEmbedding.ms).toBeGreaterThanOrEqual(2900);
		expect(hungEmbedding.ms).toBeLessThan(3800);
		expect(hungEmbedding.d).toMatchObject({ embedding: "timeout", vector: "skipped" });
		expect(hungEmbedding.r.lexical_only).toBe(true);
		expect(found(hungEmbedding.r)).toEqual(expect.arrayContaining(["fulltext"]));
		expect(found(hungEmbedding.r)).not.toContain("vector");
		const hungVector = await timed(c, "deadline probe [[vector-hang]]");
		expect(hungVector.ms).toBeLessThan(3800);
		expect(hungVector.d).toMatchObject({ embedding: "ok", vector: "timeout" });
		expect(found(hungVector.r)).not.toContain("vector");
		const vectorFails = await timed(c, "deadline probe [[vector-fail]]");
		expect(vectorFails.ms).toBeLessThan(1500);
		expect(vectorFails.d.vector).toMatch(/^error:/);
		expect(found(vectorFails.r)).toBeDefined();
		const embeddingFails = await timed(c, "deadline probe [[embed-fail]]");
		expect(embeddingFails.d).toMatchObject({ embedding: expect.stringMatching(/^error:/), vector: "skipped" });
		expect(found(embeddingFails.r)).toBeDefined();
		const off = await contextFor(undefined, { EMBEDDINGS: "off" });
		const calls = await fake()._calls();
		const lexical = await call<Recall>(off, "recall_memories", { keyword: "deadline probe", profile: "test" });
		expect(lexical).toMatchObject({ lexical_only: true, diagnostics: { embedding: "off", test: { embedding: "off", vector: "off" } } });
		expect(found(lexical)).toBeDefined();
		expect(await fake()._calls()).toBe(calls);
	});

	it("fuses more candidates than one statement's 100 bound parameters, with and without filters, and keeps every one", async () => {
		const c = await contextFor();
		// 130 records share the query's words, so the lexical channels and the 100 vector hits pass 100 distinct candidates.
		for (let i = 0; i < 130; i++) {
			await call(c, "save_memory", { name: `wombat ledger ${i}`, type: i < 110 ? "reference" : "feedback", description: "wombat ledger", content: "wombat ledger", profile: "test" });
		}
		const target = await call(c, "save_memory", { name: "Wombat ledger", type: "feedback", description: "wombat ledger", content: "wombat ledger", profile: "test" });
		const stub = profileStub(c, "test");
		for (let i = 0; i < 40; i++) {
			await runDurableObjectAlarm(stub);
			if (!await runInDurableObject(stub, (_i, s) => s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE embed_hash IS NOT card_hash AND status = 'active'").one().n)) break;
		}
		type R = { results: { memory_id: string; type: string; kind: string; score: number; matched_by: string[] }[]; diagnostics: Record<string, Record<string, string>> };
		const recall = (extra: Record<string, unknown>) => call<R>(c, "recall_memories", { keyword: "wombat ledger", profile: "test", limit: 100, ...extra });
		const all = await recall({});
		expect(all.diagnostics.test!.vector).toBe("hits:100");
		// The exact-name record was created after the other 130 candidates and still ranks first, over the full candidate set.
		expect(all.results[0]).toMatchObject({ memory_id: target.memory_id, matched_by: ["exact", "fulltext", "literal", "vector"] });
		expect(new Set(all.results.map((r) => r.memory_id)).size).toBe(100);
		expect(all.results.every((r, i) => i === 0 || r.score <= all.results[i - 1]!.score)).toBe(true);
		// Filters on 100 vector hits: the hosted G01 shape (type) and the kind filter.
		const feedback = await recall({ type: "feedback" });
		expect(feedback.results).toHaveLength(21);
		expect(feedback.results[0]!.memory_id).toBe(target.memory_id);
		expect(feedback.results.every((r) => r.type === "feedback")).toBe(true);
		const documents = await recall({ kinds: ["document"] });
		expect(documents.diagnostics.test!.vector).toBe("hits:100");
		expect(documents.results).toHaveLength(100);
		expect(documents.results.every((r) => r.kind === "document" && r.matched_by.includes("literal"))).toBe(true);
	});

	it("packs results to the token budget", async () => {
		const c = await contextFor();
		for (let i = 0; i < 5; i++) await call(c, "save_memory", { name: `budget note ${i}`, type: "reference", description: "budget", content: "budget ".repeat(150), profile: "test" });
		const r = await call<{ results: unknown[]; estimated_tokens: number; truncated: boolean }>(c, "recall_memories", { keyword: "budget", profile: "test", token_budget: 400 });
		expect(r.estimated_tokens).toBeLessThanOrEqual(400);
		expect(r.truncated).toBe(true);
	});
});

describe("generation identities", () => {
	it("reserves every live generation in the R2 ledger and qualifies vector ids with it", async () => {
		const c = await contextFor();
		for (const p of c.account.profiles) {
			expect(p.generation).toMatch(/^[a-z2-7]{13}$/);
			const ledger = await env.BACKUPS.get(`generations/${p.generation}.json`);
			expect(await ledger!.json()).toMatchObject({ id: p.generation, profile: p.profile, purpose: "live", state: "active" });
		}
	});

	it("draws again instead of reusing an id already in the ledger", async () => {
		const c = await contextFor();
		const taken = c.account.profiles[0]!.generation;
		const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER));
		const fresh = await runInDurableObject(stub, async (instance: AccountStore) => {
			const draws = [taken, "freshgenera7a"];
			return instance.reserveGeneration(OWNER, "test", "scratch", () => draws.shift()!);
		});
		expect(fresh).toBe("freshgenera7a");
		expect(await (await env.BACKUPS.get(`generations/${taken}.json`))!.json()).toMatchObject({ state: "active" });
		await expect(runInDurableObject(stub, (instance: AccountStore) => instance.reserveGeneration("u".repeat(60), "test", "scratch"))).rejects.toThrow("64 bytes");
		void accountStub;
	});
});
