// BothQ write details beyond G3: identity-preserving rename and scope moves, retire, history windows,
// redaction before hashing, and the sequence stamps and tombstones the export depends on.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, contextFor, journal, outcome } from "./helpers";

const note = { type: "reference", description: "a note", content: "first body", profile: "personal" };

describe("save and update", () => {
	it("renames and moves scope without changing the id, then retires", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { ...note, name: "Rename me" });
		expect(await outcome(c, "save_memory", { ...note, name: "Rename me" })).toMatchObject({ ok: false, error: { code: "already_exists" } });
		const viaSave = await call(c, "save_memory", { ...note, name: "Rename me", content: "second body", expected_revision: 1 });
		expect(viaSave).toMatchObject({ action: "updated", memory_id: saved.memory_id, revision: 2 });
		const renamed = await call(c, "save_memory", { memory_id: saved.memory_id, new_name: "Renamed note", scope: "bettergit" });
		expect(renamed).toMatchObject({ memory_id: saved.memory_id, name: "Renamed note", scope: "bettergit", revision: 3 });
		expect(await call(c, "get_memory", { name: "Renamed note", scope: "bettergit", profile: "personal" })).toMatchObject({ memory_id: saved.memory_id, content: "second body" });
		expect(await outcome(c, "save_memory", { memory_id: saved.memory_id })).toMatchObject({ ok: false, error: { details: { reason: "no_changes" } } });
		const retired = await call(c, "save_memory", { memory_id: saved.memory_id, retire: true, expected_revision: 3 });
		expect(retired).toMatchObject({ action: "retired", revision: 4 });
		expect(await outcome(c, "get_memory", { memory_id: saved.memory_id })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await call(c, "get_memory", { memory_id: saved.memory_id, include_retired: true })).toMatchObject({ status: "retired" });
	});

	it("returns a BothQ history window with append deltas and next_before_revision", async () => {
		const c = await contextFor();
		const j = await journal(c, "codex: history journal");
		for (let i = 1; i <= 4; i++) await call(c, "append_memory", { memory_id: j.memory_id, content: `entry ${i}`, request_id: `hist-${i}` });
		const h = await call<{ revisions: { revision: number; operation: string; delta?: { content: string; separator: string } }[]; next_before_revision: number | null }>(
			c, "get_memory", { memory_id: j.memory_id, history: { limit: 3 } });
		expect(h.revisions.map((r) => r.revision)).toEqual([3, 4, 5]);
		expect(h.revisions[0]).toMatchObject({ operation: "appended", delta: { content: "entry 2", separator: "\n" } });
		expect(h.next_before_revision).toBe(3);
		const older = await call<{ revisions: { revision: number; operation: string }[]; next_before_revision: number | null }>(
			c, "get_memory", { memory_id: j.memory_id, history: { limit: 3, before_revision: 3 } });
		expect(older.revisions.map((r) => [r.revision, r.operation])).toEqual([[1, "saved"], [2, "appended"]]);
		expect(older.next_before_revision).toBeNull();
		const got = await call(c, "get_memory", { memory_id: j.memory_id });
		expect(got.content).toBe("entry 1\nentry 2\nentry 3\nentry 4");
		// Replacing the content keeps every earlier append delta in history, out of current content and search.
		await call(c, "save_memory", { memory_id: j.memory_id, content: "replacement body" });
		await call(c, "append_memory", { memory_id: j.memory_id, content: "after replace", request_id: "hist-after" });
		const all = await call<{ revisions: { revision: number; operation: string; delta?: { content: string } }[] }>(c, "get_memory", { memory_id: j.memory_id, history: { limit: 100 } });
		expect(all.revisions.map((r) => [r.revision, r.operation])).toEqual([[1, "saved"], [2, "appended"], [3, "appended"], [4, "appended"], [5, "appended"], [6, "updated"], [7, "appended"]]);
		expect(all.revisions.find((r) => r.revision === 3)?.delta?.content).toBe("entry 2");
		expect((await call(c, "get_memory", { memory_id: j.memory_id })).content).toBe("replacement body\nafter replace");
		const search = await call<{ results: { memory_id: string }[] }>(c, "recall_memories", { keyword: "entry 2", profile: "personal" });
		expect(search.results.some((r) => r.memory_id === j.memory_id)).toBe(false);
	});

	it("redacts secrets before storage and before hashing, so a replay still matches", async () => {
		const c = await contextFor();
		const args = { ...note, name: "Has a secret", content: "token=abc123 and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", request_id: "redact-1" };
		const first = await call(c, "save_memory", args);
		const got = await call(c, "get_memory", { memory_id: first.memory_id });
		expect(got.content).toBe("token=[REDACTED] and [REDACTED]");
		expect(await call(c, "save_memory", args)).toMatchObject({ action: "replayed" });
	});
});

describe("transaction bound", () => {
	it("counts UTF-8 bytes and rolls the whole write back past 1 MB", async () => {
		const c = await contextFor();
		const targets: string[] = [];
		for (let i = 0; i < 90; i++) targets.push((await call(c, "save_memory", { name: `unicode old ${i}`, type: "reference", description: "界".repeat(4000), profile: "test" })).memory_id as string);
		const r = await outcome(c, "save_memory", { name: "unicode replacement", type: "reference", description: "new", profile: "test", supersedes: targets, request_id: "f4-unicode" });
		expect(r).toMatchObject({ ok: false, error: { code: "size_budget" } });
		expect(await outcome(c, "get_memory", { name: "unicode replacement", profile: "test" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await call(c, "get_memory", { memory_id: targets[89]! })).toMatchObject({ status: "active", revision: 1 });
		// The refused request id was released, so a smaller corrected write may reuse it.
		expect(await call(c, "save_memory", { name: "unicode replacement", type: "reference", description: "new", profile: "test", supersedes: targets.slice(0, 10), request_id: "f4-unicode" })).toMatchObject({ action: "created" });
	});
});

describe("sequence stamps and tombstones", () => {
	it("stamps every row of one write with one seq, and tombstones replaced rows", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { ...note, name: "Stamped note", profile: "test" });
		await call(c, "save_memory", { memory_id: saved.memory_id, content: "replaced body" });
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
		await runInDurableObject(stub, async (_i, state) => {
			const sql = state.storage.sql;
			const node = sql.exec<{ seq: number }>("SELECT seq FROM nodes WHERE id = ?", saved.memory_id).one();
			const touched = sql.exec<{ seq: number }>(
				"SELECT seq FROM texts WHERE node_id = ? AND part = 'body' UNION ALL SELECT seq FROM revisions WHERE node_id = ? AND revision = 2 UNION ALL SELECT seq FROM activity WHERE targets LIKE ?",
				saved.memory_id, saved.memory_id, `%${saved.memory_id}%`).toArray();
			expect(touched.filter((r) => r.seq === node.seq).length).toBeGreaterThanOrEqual(3);
			const tombs = sql.exec<{ tbl: string; seq: number }>("SELECT tbl, seq FROM deleted_rows WHERE tbl = 'texts'").toArray();
			expect(tombs.length).toBeGreaterThan(0);
			expect(tombs.every((t) => t.seq === node.seq || t.seq < node.seq)).toBe(true);
			const fts = sql.exec<{ n: number }>("SELECT count(*) AS n FROM texts_fts WHERE texts_fts MATCH '\"first body\"'").one();
			expect(fts.n).toBe(0);
		});
	});
});

describe("record_knowledge", () => {
	it("upserts entities, writes judgment edges with evidence, ends edges as history, and feeds work terms to the me guard", async () => {
		const c = await contextFor();
		const args = {
			nodes: [{ kind: "ticket", key: "jira:ZEP-7", name: "ZEP-7 refresh loop" }, { kind: "component", name: "Zephyr Billing", description: "billing service" }],
			edges: [{ from: { ref: 0 }, rel: "blocked_by", to: { ref: 1 }, reason: "The ticket waits on the billing service migration.", evidence: [{ kind: "ticket", ref: "jira:ZEP-7" }] }],
			profile: "work", request_id: "rk-1",
		};
		const first = await call<{ nodes: { id: string; action: string }[]; edges: { id: number; action: string }[] }>(c, "record_knowledge", args);
		expect(first.nodes.map((n) => n.action)).toEqual(["created", "created"]);
		expect(first.edges[0]!.action).toBe("created");
		expect((await contextFor()).account.sensitiveTerms).toEqual(expect.arrayContaining(["ZEP-7 refresh loop", "ZEP-7", "Zephyr Billing"]));
		expect(await call(c, "record_knowledge", args)).toMatchObject({ action: "replayed" });
		const again = await call<{ nodes: { id: string; action: string }[]; edges: { action: string }[] }>(c, "record_knowledge", { ...args, request_id: "rk-2" });
		expect(again.nodes.map((n) => n.action)).toEqual(["matched", "matched"]);
		expect(again.edges[0]!.action).toBe("matched");
		const ended = await call<{ ended: number[] }>(c, "record_knowledge", { end: [{ edge: first.edges[0]!.id, valid_to: "2026-10-29T00:00:00Z", reason: "migration finished" }], profile: "work" });
		expect(ended.ended).toEqual([first.edges[0]!.id]);
		const ref = c.account.profiles.find((x) => x.profile === "work")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:work:${ref.generation}`)), (_i, s) => {
			const e = s.storage.sql.exec<{ ended_at: string | null; basis: string; reason: string }>("SELECT ended_at, basis, reason FROM edges WHERE id = ?", first.edges[0]!.id).one();
			expect(e).toMatchObject({ basis: "judgment", reason: "The ticket waits on the billing service migration." });
			expect(e.ended_at).not.toBeNull();
			expect(s.storage.sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `e:${first.edges[0]!.id}`).toArray()).toEqual([{ kind: "ticket", ref: "jira:ZEP-7" }]);
		});
		const fresh = await contextFor();
		expect(await outcome(fresh, "save_memory", { name: "Billing habit", type: "user", description: "a preference", content: "Prefers Zephyr Billing dashboards.", profile: "me", company_free: true }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "Zephyr Billing" } } });
	});

	it("refuses an edge without a reason or evidence, a decision without why, and person nodes in me", async () => {
		const c = await contextFor();
		const nodes = [{ kind: "component", name: "Alpha" }, { kind: "component", name: "Beta" }];
		expect(await outcome(c, "record_knowledge", { nodes, edges: [{ from: { ref: 0 }, rel: "depends_on", to: { ref: 1 }, reason: "short", evidence: [{ kind: "url", ref: "https://x" }] }], profile: "personal" }))
			.toMatchObject({ ok: false, error: { details: { reason: "missing_reason" } } });
		expect(await outcome(c, "record_knowledge", { nodes, edges: [{ from: { ref: 0 }, rel: "depends_on", to: { ref: 1 }, reason: "Alpha imports Beta at build time.", evidence: [] }], profile: "personal" }))
			.toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await outcome(c, "record_knowledge", { nodes: [{ kind: "decision", name: "Use pnpm" }], profile: "personal" })).toMatchObject({ ok: false, error: { details: { reason: "missing_why" } } });
		expect(await outcome(c, "record_knowledge", { nodes: [{ kind: "person", name: "A. Colleague" }], profile: "me", company_free: true })).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
	});

	// Review F3-F7 and F9 (docs/review-sol-phase2a-hosted-2026-10-28.md), each from the reviewer's failing example.
	const rows = async (profile: string, query: string, ...params: SqlStorageValue[]) => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === profile)!;
		return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)), (_i, st) => st.storage.sql.exec(query, ...params).toArray());
	};
	const ev = [{ kind: "url", ref: "https://example.invalid/adr-7" }];

	it("F3: drops contact fields before storage on every profile and keeps handles and role", async () => {
		const c = await contextFor();
		const r = await call<{ nodes: { id: string; stripped?: string[] }[] }>(c, "record_knowledge", { profile: "work", nodes: [
			{ kind: "person", name: "Contact Person", attrs: { email: "colleague@example.invalid", phone: "+1 202 555 0147", github: "contact-gh", role: "reviewer", home_town: "x" } },
			{ kind: "component", name: "Contact Service", attrs: { owner_mail: "team@example.invalid", tier: "gold" } }] });
		expect(r.nodes[0]!.stripped).toEqual(["email", "phone", "home_town"]);
		const stored = await rows("work", "SELECT attrs FROM nodes WHERE id IN (?, ?) ORDER BY name", r.nodes[0]!.id, r.nodes[1]!.id);
		expect(stored.map((x) => JSON.parse(String(x.attrs)))).toEqual([{ github: "contact-gh", role: "reviewer" }, { tier: "gold" }]);
	});

	it("F4: registers a work person's handle as a me term before the write succeeds", async () => {
		const c = await contextFor();
		await call(c, "record_knowledge", { profile: "work", nodes: [{ kind: "person", key: "person:colleague", name: "Colleague Name", attrs: { github: "privatecolleague42" } }] });
		const fresh = await contextFor();
		expect(fresh.account.sensitiveTerms).toEqual(expect.arrayContaining(["Colleague Name", "privatecolleague42", "colleague"]));
		expect(await outcome(fresh, "save_memory", { profile: "me", company_free: true, name: "handle preference", type: "user", description: "Ask privatecolleague42 for reviews" }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "privatecolleague42" } } });
	});

	// Closure review (docs/review-sol-phase2a-hosted-fixes-2026-10-29.md): F4 with a me call already in flight, and F3 hashing.
	it("F4: a me write already in flight cannot miss a work handle registered before the work write", async () => {
		const [reader, writer] = await Promise.all([contextFor(), contextFor()]);
		let release!: () => void, entered!: () => void;
		const paused = new Promise<void>((r) => (release = r)), started = new Promise<void>((r) => (entered = r));
		// Only scheduling is intercepted: the me call stops before its request binding, with its earlier context.
		const ns = { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: (id: DurableObjectId) => {
			const real = env.ACCOUNT.get(id) as unknown as Record<string | symbol, unknown>;
			return new Proxy(real, { get(t, k) {
				if (k === "bindRequest") return async (a: unknown) => { entered(); await paused; return (t.bindRequest as (x: unknown) => unknown)(a); };
				const v = t[k];
				return typeof v === "function" ? (...x: unknown[]) => (t[k] as (...y: unknown[]) => unknown)(...x) : v;
			} });
		} };
		const inFlight = outcome({ ...reader, env: { ...reader.env, ACCOUNT: ns } as unknown as Env }, "save_memory",
			{ profile: "me", company_free: true, request_id: "race-me", name: "Concurrent handle preference", type: "user", description: "Ask racingcolleague42 for reviews" });
		await started;
		try { await call(writer, "record_knowledge", { profile: "work", nodes: [{ kind: "person", key: "person:race", name: "Race Colleague", attrs: { github: "racingcolleague42" } }] }); } finally { release(); }
		expect(await inFlight).toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "racingcolleague42" } } });
		expect(await rows("me", "SELECT id FROM nodes WHERE name = 'Concurrent handle preference'")).toEqual([]);
	});

	it("F3: a retry whose only change is a discarded contact value replays the same request", async () => {
		const c = await contextFor();
		const args = { profile: "work", request_id: "contact-hash", nodes: [{ kind: "person", name: "Hash Person", attrs: { github: "hash-gh", email: "first@example.invalid" } }] };
		const first = await call<{ nodes: { id: string; stripped?: string[] }[] }>(c, "record_knowledge", args);
		expect(first.nodes[0]!.stripped).toEqual(["email"]);
		const retry = await call<{ action: string; nodes: { id: string; stripped?: string[] }[] }>(c, "record_knowledge", { ...args, nodes: [{ ...args.nodes[0]!, attrs: { github: "hash-gh", email: "second@example.invalid" } }] });
		expect([retry.action, retry.nodes[0]!.id, retry.nodes[0]!.stripped]).toEqual(["replayed", first.nodes[0]!.id, ["email"]]);
		expect(await outcome(c, "record_knowledge", { ...args, nodes: [{ ...args.nodes[0]!, attrs: { github: "other-gh" } }] })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		const [stored] = await rows("work", "SELECT attrs FROM nodes WHERE id = ?", first.nodes[0]!.id);
		expect(JSON.parse(String(stored!.attrs))).toEqual({ github: "hash-gh" });
	});

	it("F5: a keyed update keeps revisions, refreshes the searchable head and marks the card for embedding", async () => {
		const c = await contextFor();
		const one = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "test", nodes: [{ kind: "decision", key: "decision:cache", name: "cache setting", description: "orchidbefore", why: "memory is bounded", evidence: ev }] });
		const id = one.nodes[0]!.id;
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`));
		await runDurableObjectAlarm(stub);
		const [before] = await rows("test", "SELECT card_hash, embed_hash FROM nodes WHERE id = ?", id);
		expect(before!.embed_hash).toBe(before!.card_hash);
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "decision", key: "decision:cache", name: "cache setting", description: "zeppelinafter", why: "memory is bounded", evidence: ev }] });
		const got = await call<{ revision: number; revisions: { revision: number; snapshot: { description: string } }[] }>(c, "get_memory", { memory_id: id, history: { limit: 10 } });
		expect(got.revision).toBe(2);
		expect(got.revisions.map((r) => [r.revision, r.snapshot.description])).toEqual([[1, "orchidbefore"], [2, "zeppelinafter"]]);
		const off = { ...c, env: { ...c.env, EMBEDDINGS: "off" } };
		expect((await call<{ results: { memory_id: string }[] }>(off, "recall_memories", { keyword: "zeppelinafter", profile: "test" })).results.map((x) => x.memory_id)).toEqual([id]);
		expect((await call<{ results: unknown[] }>(off, "recall_memories", { keyword: "orchidbefore", profile: "test" })).results).toHaveLength(0);
		// The changed card was scheduled for embedding: running the alarm embeds the new card.
		await runDurableObjectAlarm(stub);
		const [after] = await rows("test", "SELECT card_hash, embed_hash FROM nodes WHERE id = ?", id);
		expect(after!.card_hash).not.toBe(before!.card_hash);
		expect(after!.embed_hash).toBe(after!.card_hash);
	});

	it("F6: refuses typed edges outside the endpoint table and allows other", async () => {
		const c = await contextFor();
		const nodes = [{ kind: "component", name: "service" }, { kind: "bug", name: "bad refresh" }];
		expect(await outcome(c, "record_knowledge", { profile: "test", nodes, edges: [{ from: { ref: 0 }, rel: "reviewed", to: { ref: 1 }, reason: "I inspected the change.", evidence: ev }] }))
			.toMatchObject({ ok: false, error: { code: "validation", details: { reason: "invalid_endpoints", allowed: { from: ["person"], to: ["pr"] } } } });
		expect(await rows("test", "SELECT id FROM nodes WHERE name = 'bad refresh'")).toEqual([]);
		const r = await call<{ edges: { action: string }[] }>(c, "record_knowledge", { profile: "test", nodes, edges: [{ from: { ref: 0 }, rel: "other", other_label: "inspected_for", to: { ref: 1 }, reason: "I inspected the change.", evidence: ev }] });
		expect(r.edges[0]!.action).toBe("created");
		expect(await outcome(c, "record_knowledge", { profile: "test", edges: [{ from: { kind: "component", name: "service" }, rel: "relates_to", to: { kind: "bug", name: "bad refresh" }, reason: "Seen in the same trace.", evidence: [{ kind: "node", ref: "missing-node" }] }] }))
			.toMatchObject({ ok: false, error: { details: { reason: "bad_evidence" } } });
	});

	it("F7: refuses a key that belongs to another kind and leaves the node unchanged", async () => {
		const c = await contextFor();
		const a = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "test", nodes: [{ kind: "person", key: "person:foo", name: "Original Person" }] });
		expect(await outcome(c, "record_knowledge", { profile: "test", nodes: [{ kind: "component", key: "person:foo", name: "Replacement Component" }] }))
			.toMatchObject({ ok: false, error: { details: { reason: "key_kind_conflict", kind: "person" } } });
		expect(await rows("test", "SELECT kind, name, revision FROM nodes WHERE id = ?", a.nodes[0]!.id)).toEqual([{ kind: "person", name: "Original Person", revision: 1 }]);
	});

	it("F9: a decision needs evidence, stored with it in the same write", async () => {
		const c = await contextFor();
		expect(await outcome(c, "record_knowledge", { profile: "test", nodes: [{ kind: "decision", key: "decision:nocache", name: "no cache setting", why: "memory is bounded" }] }))
			.toMatchObject({ ok: false, error: { details: { reason: "missing_evidence" } } });
		expect(await rows("test", "SELECT id FROM nodes WHERE key = 'decision:nocache'")).toEqual([]);
		const r = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "test", nodes: [{ kind: "decision", key: "decision:nocache", name: "no cache setting", why: "memory is bounded", evidence: ev }] });
		expect(await rows("test", "SELECT kind, ref FROM evidence WHERE owner = ?", `n:${r.nodes[0]!.id}`)).toEqual([{ kind: "url", ref: "https://example.invalid/adr-7" }]);
	});
});
