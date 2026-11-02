// BothQ write details beyond G3: identity-preserving rename and scope moves, retire, history windows,
// redaction before hashing, and the sequence stamps and tombstones the export depends on.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Fail, type Outcome, type ProfileRef, type WriteCommand } from "../src/domain/types";
import { sha256 } from "../src/domain/ids";
import { callTool, type ToolContext } from "../src/mcp";
import type { ProfileStore } from "../src/profile/store";
import { enqueue, next } from "../src/profile/maintenance";
import { undo } from "../src/profile/undo";
import { purgeOrigin } from "../src/profile/wipe";
import { runWrite } from "../src/profile/write";
import { call, contextFor, devicePrincipal, deviceToken, journal, OWNER, outcome, registered } from "./helpers";

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
		// A quoted structured key, as the local capture client recognizes it: the whole value goes before storage and hashing.
		const json = { ...note, name: "Has a JSON secret", content: `Inspect the diagnostic sample.\n{"api_key":"synthetic-only-value-42"} {'github_token': 'synthetic-only-value-42'}\n{"api_key":"ignored-prefix\\" synthetic-only/private-value-42"}`, request_id: "redact-json-1" };
		const saved = await call(c, "save_memory", json);
		expect((await call(c, "get_memory", { memory_id: saved.memory_id })).content).toBe(`Inspect the diagnostic sample.\n{"api_key":[REDACTED]} {'github_token':[REDACTED]}\n{"api_key":[REDACTED]}`);
		expect(await call(c, "save_memory", json)).toMatchObject({ action: "replayed", memory_id: saved.memory_id });
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

	it("counts every row a write really changes, index and full-text rows included, and rolls it all back past 1,000", async () => {
		const c = await contextFor();
		const j = await journal(c, "codex: wide journal", "test");
		for (let i = 0; i < 260; i++) await call(c, "append_memory", { memory_id: j.memory_id, content: `entry ${i}`, request_id: `r6-entry-${i}` });
		const before = await call<{ revision: number; content: string }>(c, "get_memory", { memory_id: j.memory_id, content: { complete: true } });
		// Each live entry that leaves writes 4 rows (measured: the row, its seq index entry, two full-text deletes), so 260
		// entries pass 1,000 rows in one statement; counting statements instead saw about 270.
		const r = await outcome(c, "save_memory", { memory_id: j.memory_id, content: "replaced", request_id: "r6-wide" });
		expect(r).toMatchObject({ ok: false, error: { code: "size_budget" } });
		const after = await call<{ revision: number; content: string }>(c, "get_memory", { memory_id: j.memory_id, content: { complete: true } });
		expect([after.revision, after.content]).toEqual([before.revision, before.content]);
		expect((await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "entry 259", profile: "test" })).results.length).toBeGreaterThan(0);
		// A narrow replace still fits, and the refused request id was released for it.
		const k = await journal(c, "codex: narrow journal", "test");
		for (let i = 0; i < 5; i++) await call(c, "append_memory", { memory_id: k.memory_id, content: `small ${i}`, request_id: `r6-small-${i}` });
		expect(await call(c, "save_memory", { memory_id: k.memory_id, content: "replaced", request_id: "r6-wide" })).toMatchObject({ action: "updated" });
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
		// Each alarm embeds 16 due cards in row order, and this file's earlier tests can leave more due: run it until this card is in.
		const embedded = async () => {
			for (let i = 0; i < 10; i++) {
				await runDurableObjectAlarm(stub);
				const [r] = await rows("test", "SELECT card_hash, embed_hash FROM nodes WHERE id = ?", id);
				if (r!.embed_hash === r!.card_hash) return r!;
			}
			throw new Error("the card was not embedded in 10 alarms");
		};
		const before = await embedded();
		expect(before!.embed_hash).toBe(before!.card_hash);
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "decision", key: "decision:cache", name: "cache setting", description: "zeppelinafter", why: "memory is bounded", evidence: ev }] });
		const got = await call<{ revision: number; revisions: { revision: number; snapshot: { description: string } }[] }>(c, "get_memory", { memory_id: id, history: { limit: 10 } });
		expect(got.revision).toBe(2);
		expect(got.revisions.map((r) => [r.revision, r.snapshot.description])).toEqual([[1, "orchidbefore"], [2, "zeppelinafter"]]);
		const off = { ...c, env: { ...c.env, EMBEDDINGS: "off" } };
		expect((await call<{ results: { memory_id: string }[] }>(off, "recall_memories", { keyword: "zeppelinafter", profile: "test" })).results.map((x) => x.memory_id)).toEqual([id]);
		expect((await call<{ results: unknown[] }>(off, "recall_memories", { keyword: "orchidbefore", profile: "test" })).results).toHaveLength(0);
		// The changed card was scheduled for embedding: running the alarm embeds the new card.
		const after = await embedded();
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

describe("maintenance through MCP (C4 wiring)", () => {
	it("leases an item to a job token, applies its op as maintenance with undo, and the owner's undo restores it", async () => {
		const owner = await contextFor();
		const a = await call(owner, "save_memory", { name: "Maintained note", type: "reference", description: "before maintenance", content: "kept body", profile: "personal" });
		const ref = owner.account.profiles.find((p) => p.profile === "personal")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`));
		await runInDurableObject(stub, (_i, s) => enqueue(s.storage, [{ kind: "unlinked", subjects: [a.memory_id as string] }]));
		// Only a job token sees the job tools; the owner's session does not.
		expect(await outcome(owner, "maintenance_next", { profile: "personal" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const job = await contextFor(devicePrincipal((await deviceToken(`c4-wiring-job-${Date.now()}`, ["ingest", "maintenance"], ["personal"])).token));
		const lease = await call<{ lease_id: string; items: { item_id: number; subjects: string[] }[] }>(job, "maintenance_next", { profile: "personal" });
		// Other producers (the weekly review among them) may have queued items too; this test works on its own.
		const mine = lease.items.find((i) => i.subjects.length === 1 && i.subjects[0] === a.memory_id)!;
		expect(mine).toBeDefined();
		const done = await call<{ results: Record<string, unknown>[] }>(job, "maintenance_complete", { profile: "personal", lease_id: lease.lease_id,
			results: [{ item_id: mine.item_id, ops: [{ op: "save", memory_id: a.memory_id, description: "after maintenance" }] }] });
		const activityId = Number(/"activity_id":(\d+)/.exec(JSON.stringify(done.results))?.[1]);
		expect(activityId).toBeGreaterThan(0);
		expect(await call(owner, "get_memory", { memory_id: a.memory_id })).toMatchObject({ description: "after maintenance", content: "kept body", revision: 2 });
		await runInDurableObject(stub, (_i, s) => {
			expect(s.storage.sql.exec("SELECT actor, undo IS NOT NULL AS has_undo FROM activity WHERE id = ?", activityId).one()).toEqual({ actor: "maintenance", has_undo: 1 });
			undo(s.storage, ref, activityId, { actor: "owner", platform: "test", routedBy: "explicit", userId: ref.userId });
		});
		expect(await call(owner, "get_memory", { memory_id: a.memory_id })).toMatchObject({ description: "before maintenance", content: "kept body", revision: 3 });
	});
});

describe("transfer and wipe wiring with undo, graph, maintenance and purge cleanup (C3 with C4)", () => {
	const ctxOf = (userId: string) => ({ actor: "owner" as const, platform: "test", routedBy: "explicit" as const, userId, payloadHash: "undo" });

	it("refuses to undo a write once its record has moved to another profile", async () => {
		const owner = await contextFor();
		const a = await call<{ memory_id: string; activity_id: number }>(owner, "save_memory", { name: `Moved before undo ${Date.now()}`, type: "project", description: "fixture", content: "moves", profile: "personal" });
		const ref = owner.account.profiles.find((p) => p.profile === "personal")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`));
		const [made] = await runInDurableObject(stub, (_i, s) => s.storage.sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'save' AND targets = ?", JSON.stringify([a.memory_id])).toArray());
		await call(owner, "save_memory", { memory_id: a.memory_id, profile: "work" });
		const r = await stub.write(ref, { op: "undo", args: { activity_id: made!.id, request_id: `undo:${made!.id}` } }, ctxOf(ref.userId));
		expect(r).toMatchObject({ ok: false, error: { code: "revision_conflict", details: { node: a.memory_id, reason: "moved" } } });
		expect(await call(owner, "get_memory", { memory_id: a.memory_id })).toMatchObject({ profile: "work" });
	});

	it("never shows a record that is still landing through the graph tools", async () => {
		const owner = await contextFor();
		const name = `Landing record ${Date.now()}`;
		const a = await call<{ memory_id: string }>(owner, "save_memory", { name, type: "project", description: "fixture", profile: "personal" });
		const ref = owner.account.profiles.find((p) => p.profile === "personal")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`));
		const explore = { kind: "explore" as const, node: { name }, depth: 1, known: [], maxEdges: 50 };
		expect(await stub.read(ref, explore)).toMatchObject({ ok: true });
		await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("UPDATE nodes SET status = 'incoming' WHERE id = ?", a.memory_id));
		expect(await stub.read(ref, explore)).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("checks the account before a maintenance call, so a closed generation leases nothing and stays unbound", async () => {
		const owner = await contextFor();
		const stale = { ...owner.account.profiles.find((p) => p.profile === "personal")!, generation: `closed-${Date.now()}` };
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${stale.userId}:personal:${stale.generation}`));
		expect(await stub.maintenance(stale, { op: "next" }, { platform: "test", userId: stale.userId })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT value FROM profile_meta WHERE key = 'user_id'").toArray())).toEqual([]);
	});

	it("prunes purged bindings only for the active generation, and never a wipe fence", async () => {
		const owner = await contextFor();
		const ref = owner.account.profiles.find((p) => p.profile === "personal")!;
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ref.userId));
		const [fence, plain, later] = [`fence-${Date.now()}`, `plain-${Date.now()}`, `later-${Date.now()}`];
		await runInDurableObject(account, (_i, s) => {
			for (const [rid, op] of [[fence, "wiped"], [plain, "save_memory"], [later, "save_memory"]]) {
				s.storage.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES (?, 'personal', ?, '', ?, 1)", rid, op, new Date().toISOString());
			}
		});
		await account.prunePurged({ ...ref, generation: "an-old-generation" }, { nodes: [], requests: [later] });
		await account.prunePurged(ref, { nodes: [], requests: [fence, plain] });
		const left = await runInDurableObject(account, (_i, s) => s.storage.sql.exec<{ request_id: string }>("SELECT request_id FROM request_index WHERE request_id IN (?, ?, ?) ORDER BY request_id", fence, plain, later).toArray().map((r) => r.request_id));
		expect(left).toEqual([fence, later].sort());
	});

	// The RPC stub types erase these results, so the calls below are typed against the class.
	type Side = { who: ProfileRef; stub: ProfileStore };
	const side = (x: { who: ProfileRef; stub: unknown }): Side => ({ who: x.who, stub: x.stub as ProfileStore });
	const saved = async (side: Side, name: string) => {
		const out = await side.stub.write(side.who, { op: "save", args: { name, type: "reference", description: "synthetic" } }, ctxOf(side.who.userId));
		if (!out.ok) throw new Error(out.error.message);
		return String(out.value.memory_id);
	};
	/** Fences, packs and lands one record through the real transfer steps, leaving it incoming at the target; `packed` runs in between. */
	const land = async (from: Side, to: Side, nodeId: string, packed?: () => Promise<void>) => {
		const id = crypto.randomUUID();
		expect((await from.stub.transfer(from.who, { op: "fence", id, nodeId, peer: to.who.profile, companyFree: true })).ok).toBe(true);
		const pack = await from.stub.transfer(from.who, { op: "pack", id });
		if (!pack.ok || !pack.value.done) throw new Error("pack did not finish");
		await packed?.();
		for (let n = 1; n <= pack.value.parts!; n++) {
			const part = await from.stub.transfer(from.who, { op: "part", id, n });
			if (!part.ok) throw new Error(part.error.message);
			expect((await to.stub.transfer(to.who, { op: "land", id, from: from.who.profile, nodeId, n, of: pack.value.parts!, payload: part.value.payload!, sha256: part.value.sha256!,
				bundle: pack.value.sha256!, revision: pack.value.revision!, terms: [], companyFree: true })).ok).toBe(true);
		}
		return id;
	};

	it("undo of a knowledge write puts back the exact mentions it resolved, and refuses once a mentioning record changed", async () => {
		const r = await registered();
		await runInDurableObject(r.stub, (_i, state) => {
			const storage = state.storage, sql = storage.sql;
			const w = (cmd: WriteCommand, hash: string) => runWrite(storage, r.who, cmd, { ...ctxOf(r.userId), payloadHash: hash });
			const mentions = (key: string) => sql.exec("SELECT owner, kind, ref, note FROM evidence WHERE kind = 'mention' AND ref = ? ORDER BY owner", `jira:${key}`).toArray();
			const round = (key: string) => {
				const notes = [1, 2].map((i) => String(w({ op: "save", args: { name: `note ${i} for ${key.slice(0, 4)}`, type: "reference", description: "fixture", content: `investigate ${key}` } }, `${key}-note-${i}`).result.memory_id));
				const before = mentions(key);
				expect(before.map((m) => m.owner)).toEqual(notes.map((n) => `n:${n}`).sort());
				const made = w({ op: "knowledge", args: { nodes: [{ kind: "bug", key: `jira:${key}`, name: `bug ${key}` }] } }, `${key}-bug`);
				expect(mentions(key)).toEqual([]);
				return { notes, before, activity: Number(made.result.activity_id) };
			};
			const ok = `SIBA-${Math.floor(Math.random() * 9_000_000) + 1_000}`, a = round(ok);
			expect(undo(storage, r.who, a.activity, ctxOf(r.userId)).result.action).toBe("undone");
			expect(mentions(ok)).toEqual(a.before);
			expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE key = ? AND status = 'active'", `jira:${ok}`).one().n).toBe(0);
			// A mentioning record edited since: the restored mention may no longer be true, so undo refuses and changes nothing.
			const late = `SIBB-${Math.floor(Math.random() * 9_000_000) + 1_000}`, b = round(late);
			w({ op: "save", args: { memory_id: b.notes[1]!, description: "edited later" } }, `${late}-edit`);
			const snapshot = () => ["nodes", "edges", "evidence", "activity"].map((t) => sql.exec(`SELECT * FROM ${t} ORDER BY 1`).toArray());
			const kept = snapshot();
			let failure: unknown;
			try { undo(storage, r.who, b.activity, ctxOf(r.userId)); } catch (e) { failure = e instanceof Fail ? e.failure : e; }
			expect(failure).toMatchObject({ code: "revision_conflict", details: { node: b.notes[1] } });
			expect(snapshot()).toEqual(kept);
		});
	});

	it("refuses undo of a consumed mention after the real wipe fence, before purge, without changing state", async () => {
		const r = await registered();
		await runInDurableObject(r.stub, async (_i, state) => {
			const storage = state.storage, sql = storage.sql;
			const w = (cmd: WriteCommand, hash: string) => runWrite(storage, r.who, cmd, { ...ctxOf(r.userId), payloadHash: hash });
			const owner = String(w({ op: "save", args: { name: "wipe-fenced mention", type: "reference", description: "fixture", content: "WRCASE-7404" } }, "mention-owner").result.memory_id);
			const made = w({ op: "knowledge", args: { nodes: [{ kind: "bug", key: "jira:WRCASE-7404", name: "published target" }] } }, "mention-target");
			const activity = Number(made.result.activity_id);
			expect(JSON.parse(String(sql.exec("SELECT undo FROM activity WHERE id = ?", activity).one().undo)).mentions)
				.toMatchObject([{ row: { owner: `n:${owner}`, kind: "mention", ref: "jira:WRCASE-7404" } }]);
			sql.exec("UPDATE nodes SET source_profile = 'work' WHERE id = ?", owner);
			const wipe = { profile: "work", at: new Date().toISOString(), ids: [owner], terms: [] };
			expect((await purgeOrigin(storage, { ...env, EMBEDDINGS: "off" }, r.who, { op: "fence", wipe })).ok).toBe(true);
			expect(sql.exec("SELECT id FROM nodes WHERE id = ?", owner).toArray()).toHaveLength(1);
			const snapshot = () => ["nodes", "texts", "edges", "evidence", "activity", "archive", "revisions", "requests", "profile_meta", "deleted_rows", "cursors"]
				.map((t) => sql.exec(`SELECT * FROM ${t} ORDER BY 1`).toArray());
			const before = snapshot();
			expect(() => undo(storage, r.who, activity, ctxOf(r.userId)))
				.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "profile_wiped" }) }));
			expect(snapshot()).toEqual(before);
			expect(sql.exec("SELECT * FROM evidence WHERE owner = ? AND kind = 'mention'", `n:${owner}`).toArray()).toEqual([]);
		});
	});

	it("never shows the links of a landed record before it is published, and shows them once it is", async () => {
		const r = await registered("personal", "me"), src = side(r.of("personal")), me = side(r.of("me"));
		const a = await saved(src, "Landing source"), b = await saved(src, "Published neighbour");
		expect((await src.stub.write(src.who, { op: "knowledge", args: { edges: [{ from: { id: a }, to: { id: b }, rel: "relates_to", reason: "unpublished source edge payload",
			evidence: [{ kind: "url", ref: "https://example.invalid/unpublished-source-evidence" }] }] } }, ctxOf(r.userId))).ok).toBe(true);
		expect((await me.stub.transfer(me.who, { op: "publish", id: await land(src, me, b), terms: [] })).ok).toBe(true);
		const moving = await land(src, me, a);
		await r.account((sql) => sql.exec("INSERT INTO node_index (node_id, profile, seq) VALUES (?, 'me', 1)", b));
		const caller = { userId: r.userId, kind: "device" as const, profiles: ["me"], scopes: ["read" as const] };
		const c = { env, caller, account: { caller, profiles: [src.who, me.who], known: ["personal", "me"], rules: [], sensitiveTerms: [] }, platform: "test" } as unknown as ToolContext;
		const shown = async () => JSON.stringify(await callTool(c, "explore", { node: { id: b }, profile: "me" }));
		expect(await shown()).not.toMatch(/unpublished source edge payload|unpublished-source-evidence/);
		expect((await me.stub.transfer(me.who, { op: "publish", id: moving, terms: [] })).ok).toBe(true);
		expect(await shown()).toMatch(/unpublished source edge payload[\s\S]*unpublished-source-evidence/);
	});

	it("refuses a maintenance flag on a packed record and keeps its item queued, so the published record matches", async () => {
		const r = await registered("personal", "work"), src = side(r.of("personal")), dst = side(r.of("work"));
		const id = await saved(src, "Flag while moving");
		const lease = await runInDurableObject(r.of("personal").stub, (_i, s) => { enqueue(s.storage, [{ kind: "unlinked", subjects: [id] }]); return next(s.storage, {}); });
		const move = await land(src, dst, id, async () => {
			const out = await src.stub.maintenance(src.who, { op: "complete", lease_id: lease.lease_id!, results: [{ item_id: lease.items[0]!.item_id, ops: [{ op: "flag", node: id, reason: "late flag" }] }] },
				{ platform: "test", userId: r.userId });
			expect(out).toMatchObject({ ok: true, value: { results: [{ status: "rejected", reason: "moving", ops: [{ status: "rejected", code: "moving" }] }] } });
			expect(await runInDurableObject(r.of("personal").stub, (_i, s) => s.storage.sql.exec("SELECT (SELECT flagged FROM nodes WHERE id = ?) AS flagged, (SELECT state FROM maintenance) AS state", id).one()))
				.toEqual({ flagged: null, state: "leased" });
		});
		expect((await dst.stub.transfer(dst.who, { op: "publish", id: move, terms: [] })).ok).toBe(true);
		expect(await runInDurableObject(r.of("work").stub, (_i, s) => s.storage.sql.exec("SELECT flagged FROM nodes WHERE id = ?", id).one().flagged)).toBeNull();
	});

	it("prunes nothing while the account recovers, not even a sequence number, so the profile keeps its cleanup outbox", async () => {
		const r = await registered();
		await r.account((sql) => {
			sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')");
			sql.exec("INSERT INTO node_index (node_id, profile, seq) VALUES ('ordinary', ?, 1)", r.who.profile);
			for (const [rid, op] of [["ordinary", "save_memory"], ["fence", "wiped"]]) {
				sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES (?, ?, ?, '', ?, 1)", rid, r.who.profile, op, new Date().toISOString());
			}
		});
		const state = () => r.account((sql) => ["account_meta", "node_index", "request_index"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray()));
		const before = await state();
		expect(await env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)).prunePurged(r.who, { nodes: ["ordinary"], requests: ["ordinary", "fence"] }))
			.toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await state()).toEqual(before);
	});
});


it("D1 save_memory exposes compact with replay, exact history and summary redaction", async () => {
	const c = await contextFor(), j = await journal(c, "D1 public journal");
	await call(c, "append_memory", { memory_id: j.memory_id, content: "oldlexicaltoken", separator: "\n\n", request_id: "D1-public-entry" });
	const args = { memory_id: j.memory_id, expected_revision: 2, request_id: "D1-public-compact", compact: { through_seq: 1, summary: `short ghp_${"A".repeat(36)}` } };
	const accountState = () => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(c.caller.userId)), (_, state) => ({
		requests: state.storage.sql.exec("SELECT * FROM request_index ORDER BY request_id").toArray(),
		transfers: state.storage.sql.exec("SELECT * FROM transfers ORDER BY id").toArray(),
	}));
	const before = await accountState();
	for (const [i, changes] of [{ content: "ignored replacement", expected_revision: undefined }, {}].entries()) {
		expect(await outcome(c, "save_memory", { ...args, ...changes, request_id: `D1-public-invalid-move-${i}`, profile: "work" }))
			.toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await accountState()).toEqual(before);
		expect(await call(c, "get_memory", { memory_id: j.memory_id })).toMatchObject({ profile: "personal", revision: 2, content: "oldlexicaltoken" });
	}
	expect(await call(c, "save_memory", args)).toMatchObject({ action: "compacted", revision: 3 });
	expect(await call(c, "save_memory", args)).toMatchObject({ action: "replayed", revision: 3 });
	const got = await call<{ content: string; revisions: { operation: string; delta?: unknown }[] }>(c, "get_memory", { memory_id: j.memory_id, history: { limit: 10 } });
	expect(got.content).toBe("short [REDACTED]");
	expect(got.revisions.map((r) => r.operation)).toEqual(["saved", "appended", "compacted"]);
	expect(got.revisions[1]!.delta).toEqual({ content: "oldlexicaltoken", separator: "" });
	const recall = await call<{ results: { memory_id: string }[] }>(c, "recall_memories", { keyword: "oldlexicaltoken", profile: "personal" });
	expect(recall.results.some((r) => r.memory_id === j.memory_id)).toBe(false);
});

describe("save_memory evidence and links", () => {
	const ctxOf = (userId: string) => ({ actor: "owner" as const, platform: "test", routedBy: "explicit" as const, userId, payloadHash: "undo" });
	const undoIn = async (c: ToolContext, profile: string, activityId: number) => {
		const ref = c.account.profiles.find((p) => p.profile === profile)!;
		return env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)).write(ref, { op: "undo", args: { activity_id: activityId, request_id: `undo:${activityId}` } }, ctxOf(ref.userId));
	};
	type Saved = { memory_id: string; activity_id: number; revision: number; links?: { id: number; action: string }[] };
	type Got = { evidence: { kind: string; ref: string; note: string | null }[]; edges: { id: number; from_id: string; to_id: string; rel: string; basis: string; reason: string | null; evidence: { kind: string; ref: string }[] }[] };

	it("runs the architecture's save example: link with reason and evidence, get, explore, replay, mismatch and undo", async () => {
		const c = await contextFor();
		const project = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { nodes: [{ kind: "project", key: "github:Sequoia-Engineering/web", name: "Sequoia web" }], profile: "work" });
		// docs/architecture.md section 2, "An agent saves a rule the owner stated", verbatim.
		const args = {
			kind: "rule", type: "feedback", name: "Use pnpm in Sequoia repos", description: "Package manager rule for Sequoia frontend repos",
			content: "Run pnpm install and pnpm -w build. npm rewrites pnpm-lock.yaml.", why: "Owner correction on 2026-10-28 after npm broke the lockfile.",
			how_to_apply: "Before any install or script run in a Sequoia-Engineering repo.", origin: "stated",
			links: [{ rel: "relates_to", to: { kind: "project", key: "github:Sequoia-Engineering/web" }, reason: "The rule governs installs in this repo.",
				evidence: [{ kind: "session", ref: "session:claude:cc-7f3a", note: "owner correction in this session" }] }],
			repo: { remote: "git@github.com:Sequoia-Engineering/web.git", path: "/Users/p/work/web" }, request_id: "cc-7f3a-save-1",
		};
		const saved = await call<Saved & { profile: string; routed_by: string; action: string }>(c, "save_memory", args);
		expect(saved).toMatchObject({ profile: "work", action: "created", revision: 1, links: [{ action: "created" }] });
		expect(saved.routed_by).toMatch(/^rule:/);
		const link = saved.links![0]!.id;
		const got = await call<Got>(c, "get_memory", { memory_id: saved.memory_id });
		expect(got.edges.find((e) => e.id === link)).toEqual(expect.objectContaining({ from_id: saved.memory_id, to_id: project.nodes[0]!.id, rel: "relates_to", basis: "judgment",
			reason: "The rule governs installs in this repo.", evidence: [{ kind: "session", ref: "session:claude:cc-7f3a", note: "owner correction in this session" }] }));
		const explored = await call<{ links: Record<string, { id: number; reason: string; evidence: unknown[]; to: { id: string; name?: string } }[]> }>(c, "explore", { node: { id: saved.memory_id } });
		expect(Object.values(explored.links).flat().find((l) => l.id === link)).toMatchObject({ reason: "The rule governs installs in this repo.", to: { id: project.nodes[0]!.id, name: "Sequoia web" },
			evidence: [{ kind: "session", ref: "session:claude:cc-7f3a" }] });
		expect(await call(c, "save_memory", args)).toMatchObject({ action: "replayed", memory_id: saved.memory_id, links: [{ id: link, action: "created" }] });
		expect(await outcome(c, "save_memory", { ...args, links: [{ ...args.links[0]!, reason: "A different reason for the same link." }] })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		expect(await undoIn(c, "work", saved.activity_id)).toMatchObject({ ok: true, value: { action: "undone" } });
		expect(await outcome(c, "get_memory", { memory_id: saved.memory_id })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const after = await call<{ links: Record<string, { id: number }[]> }>(c, "explore", { node: { id: project.nodes[0]!.id } });
		expect(Object.values(after.links).flat().some((l) => l.id === link)).toBe(false);
	});

	const inProfile = async (c: ToolContext, profile: string, query: string, ...params: SqlStorageValue[]) => {
		const ref = c.account.profiles.find((p) => p.profile === profile)!;
		return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)), (_i, st) => st.storage.sql.exec(query, ...params).toArray());
	};
	const bound = (requestId: string) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => st.storage.sql.exec("SELECT profile FROM request_index WHERE request_id = ?", requestId).toArray());
	const ev = [{ kind: "pr", ref: "github:wrick17/bettergit#41" }];

	it("refuses a new decision without evidence, keeps evidence through updates, and undo restores what an update overwrote", async () => {
		const c = await contextFor();
		const name = `Detect conflicts in merge ${Date.now()}`, q = crypto.randomUUID();
		const decision = { name, type: "project", description: "Conflict detection moved into the merge step.", why: "Pre-merge detection missed rebased commits.", profile: "personal", request_id: q };
		expect(await outcome(c, "save_memory", decision)).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "missing_evidence" } } });
		expect(await bound(q)).toEqual([]);
		expect(await inProfile(c, "personal", "SELECT id FROM nodes WHERE name = ?", name)).toEqual([]);
		const made = await call<Saved & { kind: string }>(c, "save_memory", { ...decision, evidence: [{ kind: "commit", ref: "git:wrick17/bettergit@9f2c1ab", note: "first note" }] });
		expect(made).toMatchObject({ action: "created", kind: "decision" });
		expect((await call<Got>(c, "get_memory", { memory_id: made.memory_id })).evidence).toEqual([{ kind: "commit", ref: "git:wrick17/bettergit@9f2c1ab", note: "first note" }]);
		await call(c, "save_memory", { memory_id: made.memory_id, content: "Now checked inside merge." });
		expect((await call<Got>(c, "get_memory", { memory_id: made.memory_id })).evidence).toHaveLength(1);
		const added = await call<Saved>(c, "save_memory", { memory_id: made.memory_id, evidence: [{ kind: "commit", ref: "git:wrick17/bettergit@9f2c1ab", note: "second note" }, ...ev] });
		expect(added.revision).toBe(2);
		expect((await call<Got>(c, "get_memory", { memory_id: made.memory_id })).evidence).toEqual([
			{ kind: "commit", ref: "git:wrick17/bettergit@9f2c1ab", note: "second note" }, { kind: "pr", ref: "github:wrick17/bettergit#41", note: null }]);
		expect(await undoIn(c, "personal", added.activity_id)).toMatchObject({ ok: true });
		expect((await call<Got>(c, "get_memory", { memory_id: made.memory_id })).evidence).toEqual([{ kind: "commit", ref: "git:wrick17/bettergit@9f2c1ab", note: "first note" }]);
		// A decision that has no pointer (as an imported one may) must gain one in the same update; nothing fills it in.
		await inProfile(c, "personal", "DELETE FROM evidence WHERE owner = ?", `n:${made.memory_id}`);
		expect(await outcome(c, "save_memory", { memory_id: made.memory_id, description: "edited" })).toMatchObject({ ok: false, error: { details: { reason: "missing_evidence" } } });
		expect(await call(c, "save_memory", { memory_id: made.memory_id, description: "edited", evidence: ev })).toMatchObject({ action: "updated", revision: 3 });
	});

	it("rejects malformed or oversized evidence and links at the schema, and keeps inferred internal", async () => {
		const c = await contextFor();
		const base = { name: `Strict ${Date.now()}`, type: "reference", description: "d", profile: "personal" };
		const link = { rel: "relates_to", to: { id: "x" }, reason: "A reason long enough.", evidence: ev };
		for (const bad of [
			{ evidence: [] }, { evidence: [{ kind: "file", ref: "   " }] }, { evidence: [{ kind: "file", ref: "a", extra: 1 }] }, { evidence: [{ kind: "blob", ref: "a" }] }, { evidence: Array.from({ length: 21 }, (_, i) => ({ kind: "url", ref: `u${i}` })) },
			{ links: [] }, { links: Array.from({ length: 21 }, () => link) }, { links: [{ ...link, to: { ref: 0 } }] }, { links: [{ ...link, to: { kind: "project", key: "k", profile: "work" } }] },
			{ links: [{ ...link, evidence: [] }] }, { links: [{ ...link, from: { id: "y" } }] }, { links: [{ ...link, reason: "x".repeat(601) }] }, { origin: "inferred", evidence: ev },
		]) expect(await outcome(c, "save_memory", { ...base, ...bad })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await inProfile(c, "personal", "SELECT id FROM nodes WHERE name = ?", base.name)).toEqual([]);
		// Retire and compact take no other change, evidence and links included.
		const j = await journal(c, `Strict journal ${Date.now()}`);
		await call(c, "append_memory", { memory_id: j.memory_id, content: "entry", request_id: crypto.randomUUID() });
		expect(await outcome(c, "save_memory", { memory_id: j.memory_id, retire: true, evidence: ev })).toMatchObject({ ok: false, error: { details: { reason: "invalid_arguments" } } });
		expect(await outcome(c, "save_memory", { memory_id: j.memory_id, expected_revision: 2, request_id: crypto.randomUUID(), compact: { through_seq: 1, summary: "s" }, evidence: ev }))
			.toMatchObject({ ok: false, error: { details: { reason: "invalid_compact" } } });
		expect(await call(c, "get_memory", { memory_id: j.memory_id })).toMatchObject({ revision: 2, status: "active", evidence: [] });
	});

	it("validates each link's reason, endpoints and target, rolls everything back on a refusal, and merges a duplicate's evidence", async () => {
		const c = await contextFor();
		const stamp = Date.now();
		const kn = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: [{ kind: "project", key: `github:wrick17/links-${stamp}`, name: "links project" }] });
		const project = kn.nodes[0]!.id;
		const to = { kind: "project", key: `github:wrick17/links-${stamp}` }, reason = "The note documents this repository.";
		const name = `Linked note ${stamp}`, q = crypto.randomUUID();
		const save = (links: unknown[], extra: Record<string, unknown> = {}) => outcome(c, "save_memory", { name, type: "reference", description: "d", profile: "personal", request_id: q, links, ...extra });
		const activity = async () => (await inProfile(c, "personal", "SELECT count(*) AS n FROM activity"))[0]!.n;
		const before = await activity();
		for (const [links, reason_] of [
			[[{ rel: "relates_to", to, reason: "short", evidence: ev }], "missing_reason"],
			[[{ rel: "part_of", to, reason, evidence: ev }], "invalid_endpoints"],
			[[{ rel: "other", to, reason, evidence: ev }], "invalid_rel"],
			[[{ rel: "relates_to", to, reason, evidence: ev }, { rel: "relates_to", to: { id: crypto.randomUUID() }, reason, evidence: ev }], undefined],
			[[{ rel: "relates_to", to, reason, evidence: [{ kind: "node", ref: crypto.randomUUID() }] }], "bad_evidence"],
		] as [unknown[], string | undefined][]) {
			const r = await save(links);
			expect(r).toMatchObject({ ok: false });
			if (reason_) expect(r).toMatchObject({ error: { details: { reason: reason_ } } }); else expect(r).toMatchObject({ error: { code: "not_found" } });
		}
		// Nothing of a refused save stays: no node, head, revision, activity, request row or account binding.
		expect(await inProfile(c, "personal", "SELECT id FROM nodes WHERE name = ?", name)).toEqual([]);
		expect(await activity()).toBe(before);
		expect(await inProfile(c, "personal", "SELECT 1 FROM requests WHERE request_id = ?", q)).toEqual([]);
		expect(await bound(q)).toEqual([]);
		const made = await save([{ rel: "relates_to", to, reason, evidence: ev, valid_from: "2026-10-01" }]);
		expect(made).toMatchObject({ ok: true, value: { action: "created", links: [{ action: "created" }] } });
		expect(await bound(q)).toEqual([{ profile: "personal" }]);
		const id = (made as { value: Saved }).value.memory_id, edge = (made as { value: Saved }).value.links![0]!.id;
		expect(await outcome(c, "save_memory", { memory_id: id, links: [{ rel: "relates_to", to: { id }, reason, evidence: ev }] })).toMatchObject({ ok: false, error: { details: { reason: "self_edge" } } });
		const again = await call<Saved>(c, "save_memory", { memory_id: id, links: [{ rel: "relates_to", to: { id: project }, reason: "Another reason, kept out.", evidence: [{ kind: "url", ref: "https://example.invalid/adr" }] }] });
		expect(again).toMatchObject({ action: "updated", revision: 1, links: [{ id: edge, action: "matched" }] });
		const got = await call<Got>(c, "get_memory", { memory_id: id });
		expect(got.edges.find((e) => e.id === edge)).toMatchObject({ reason, basis: "judgment", evidence: [{ kind: "pr", ref: "github:wrick17/bettergit#41" }, { kind: "url", ref: "https://example.invalid/adr" }] });
		expect(await undoIn(c, "personal", again.activity_id)).toMatchObject({ ok: true });
		expect((await call<Got>(c, "get_memory", { memory_id: id })).edges.find((e) => e.id === edge)?.evidence).toEqual([{ kind: "pr", ref: "github:wrick17/bettergit#41", note: null }]);
		// A link added by an update goes with its undo; the record keeps its other links.
		const other = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: [{ kind: "component", name: `links component ${stamp}` }] });
		const linked = await call<Saved>(c, "save_memory", { memory_id: id, content: "with a component", links: [{ rel: "relates_to", to: { id: other.nodes[0]!.id }, reason, evidence: ev }] });
		expect(linked).toMatchObject({ revision: 2, links: [{ action: "created" }] });
		expect(await undoIn(c, "personal", linked.activity_id)).toMatchObject({ ok: true });
		const undone = await call<Got & { content: string }>(c, "get_memory", { memory_id: id });
		expect(undone.content).toBe("");
		expect(undone.edges.map((e) => e.id)).toEqual([edge]);
	});

	it("refuses changes on a move before binding or transferring, and keeps link targets opaque and guarded", async () => {
		const c = await contextFor();
		const stamp = Date.now();
		const m = await call<Saved>(c, "save_memory", { name: `Move with changes ${stamp}`, type: "reference", description: "d", profile: "personal" });
		const transfers = () => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => st.storage.sql.exec("SELECT count(*) AS n FROM transfers WHERE node_id = ?", m.memory_id).one().n);
		for (const change of [{ links: [{ rel: "relates_to", to: { id: m.memory_id }, reason: "A reason long enough.", evidence: ev }] }, { evidence: ev }, { content: "new body" }]) {
			const q = crypto.randomUUID();
			expect(await outcome(c, "save_memory", { memory_id: m.memory_id, profile: "work", request_id: q, ...change })).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "move_with_changes" } } });
			expect(await bound(q)).toEqual([]);
		}
		expect(await transfers()).toBe(0);
		expect(await call(c, "get_memory", { memory_id: m.memory_id })).toMatchObject({ profile: "personal", revision: 1 });
		// A node of another profile, one still landing and one that never existed answer alike.
		const work = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "work", nodes: [{ kind: "component", name: `Foreign target ${stamp}` }] });
		const landing = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: ["incoming", "moving", "moved"].map((status) => ({ kind: "component", name: `Hidden target ${status} ${stamp}` })) });
		for (const [i, status] of ["incoming", "moving", "moved"].entries()) await inProfile(c, "personal", "UPDATE nodes SET status = ? WHERE id = ?", status, landing.nodes[i]!.id);
		const device = await deviceToken(`links-${stamp}`, ["read", "write"], ["personal"]);
		const scoped = await contextFor(devicePrincipal(device.token));
		for (const [caller, target] of [[c, work.nodes[0]!.id], [scoped, work.nodes[0]!.id], ...landing.nodes.map((n) => [c, n.id]), [c, crypto.randomUUID()]] as [ToolContext, string][]) {
			const r = await outcome(caller, "save_memory", { memory_id: m.memory_id, links: [{ rel: "relates_to", to: { id: target }, reason: "A reason long enough.", evidence: ev }] });
			expect(r).toEqual({ ok: false, error: { code: "not_found", message: `no node with id '${target}' in this profile; links across profiles are not written here` } });
			expect(await outcome(caller, "save_memory", { memory_id: m.memory_id, evidence: [{ kind: "node", ref: target }] }))
				.toEqual({ ok: false, error: { code: "not_found", message: `evidence names no node '${target}' in this profile`, details: { reason: "bad_evidence" } } });
		}
		// New reasons, refs and notes are redacted before hashing and storage, and meet the me guard.
		const local = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: [{ kind: "component", name: `Local target ${stamp}` }] });
		const secret = await call<Saved>(c, "save_memory", { memory_id: m.memory_id, evidence: [{ kind: "url", ref: "https://example.invalid/x?token=abc123secret", note: "password=hunter2secret" }],
			links: [{ rel: "relates_to", to: { id: local.nodes[0]!.id }, reason: "Configured with api_key=livesecret999 there.", evidence: [{ kind: "url", ref: "https://example.invalid", note: "token=abc123secret" }] }] });
		expect(secret).toMatchObject({ action: "updated", links: [{ action: "created" }] });
		const stored = JSON.stringify(await call(c, "get_memory", { memory_id: m.memory_id }));
		expect(stored).not.toMatch(/abc123secret|hunter2secret|livesecret999/);
		expect(stored).toContain("Configured with");
		await call(c, "record_knowledge", { profile: "work", nodes: [{ kind: "component", name: `Quillfeather Ledger ${stamp}` }] });
		const fresh = await contextFor();
		const mine = await call<Saved>(fresh, "save_memory", { name: `Me note ${stamp}`, type: "user", description: "d", profile: "me", company_free: true });
		const peer = await call<{ nodes: { id: string }[] }>(fresh, "record_knowledge", { profile: "me", company_free: true, nodes: [{ kind: "other", other_label: "tool", name: `me tool ${stamp}` }] });
		expect(await outcome(fresh, "save_memory", { memory_id: mine.memory_id, profile: "me", company_free: true, evidence: [{ kind: "url", ref: "https://example.invalid", note: `from Quillfeather Ledger ${stamp}` }] }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		expect(await outcome(fresh, "save_memory", { memory_id: mine.memory_id, profile: "me", company_free: true,
			links: [{ rel: "relates_to", to: { id: peer.nodes[0]!.id }, reason: `Seen with Quillfeather Ledger ${stamp}.`, evidence: ev }] })).toMatchObject({ ok: false, error: { code: "me_sensitive_term" } });
		expect((await call<Got>(fresh, "get_memory", { memory_id: mine.memory_id })).edges).toEqual([]);
	});

	it("replays an evidence update after a move and refuses a changed payload before a new move", async () => {
		const c = await contextFor();
		const made = await call<Saved>(c, "save_memory", { name: `Replay after move ${crypto.randomUUID()}`, type: "reference", description: "d", profile: "personal" });
		const args = { memory_id: made.memory_id, profile: "personal", description: "updated", evidence: ev, request_id: crypto.randomUUID() };
		const updated = await call<Saved>(c, "save_memory", args);
		expect(await call(c, "save_memory", { memory_id: made.memory_id, profile: "test", request_id: crypto.randomUUID() })).toMatchObject({ action: "transfer_started", state: "committed" });
		expect(await outcome(c, "save_memory", args)).toMatchObject({ ok: true, value: { ...updated, action: "replayed" } });
		expect(await outcome(c, "save_memory", { ...args, evidence: [{ kind: "file", ref: "changed" }] })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		expect(await call(c, "get_memory", { memory_id: made.memory_id })).toMatchObject({ profile: "test", description: "updated", evidence: [{ ...ev[0], note: null }] });
	});

	it("refuses links whose rows pass the write budget, as one rollback", async () => {
		const c = await contextFor();
		const stamp = Date.now();
		const kn = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: Array.from({ length: 20 }, (_, i) => ({ kind: "component", name: `budget target ${stamp} ${i}` })) });
		const name = `Budget note ${stamp}`;
		const links = kn.nodes.map((n, i) => ({ rel: "relates_to", to: { id: n.id }, reason: "Each link carries its own evidence.", evidence: Array.from({ length: 20 }, (_, j) => ({ kind: "file", ref: `wrick17/x:src/${i}/${j}.ts` })) }));
		expect(await outcome(c, "save_memory", { name, type: "reference", description: "d", profile: "personal", links })).toMatchObject({ ok: false, error: { code: "size_budget" } });
		expect(await inProfile(c, "personal", "SELECT id FROM nodes WHERE name = ?", name)).toEqual([]);
		expect(await inProfile(c, "personal", "SELECT count(*) AS n FROM evidence WHERE ref LIKE 'wrick17/x:src/%'")).toEqual([{ n: 0 }]);
	});
});

describe("as_of reads (valid time, section 4)", () => {
	const tick = async () => { await new Promise((r) => setTimeout(r, 5)); const at = new Date().toISOString(); await new Promise((r) => setTimeout(r, 5)); return at; };
	type Got = { content: string | null; revision: number; status: string; name: string; description: string; revisions?: { revision: number; created_at: string }[]; as_of?: Record<string, unknown> };

	it("get_memory returns the stored state at as_of, never later revisions, entries or the current row", async () => {
		const c = await contextFor();
		const before = await tick();
		const j = await call(c, "save_memory", { name: "asof journal", type: "project", kind: "journal", description: "first description", content: "v1", profile: "personal" });
		const t1 = await tick();
		await call(c, "append_memory", { memory_id: j.memory_id, content: "e1", request_id: "asof-e1" });
		const t2 = await tick();
		await call(c, "save_memory", { memory_id: j.memory_id, content: "v2", description: "second description" });
		const t3 = await tick();
		await call(c, "save_memory", { memory_id: j.memory_id, retire: true });
		const t4 = await tick();
		const at = (as_of: string, more: Record<string, unknown> = {}) => call<Got>(c, "get_memory", { memory_id: j.memory_id, as_of, ...more });
		expect(await outcome(c, "get_memory", { memory_id: j.memory_id, as_of: before })).toMatchObject({ ok: false, error: { code: "not_found", details: { reason: "not_recorded_by_as_of" } } });
		expect(await at(t1, { history: { limit: 10 } })).toMatchObject({ content: "v1", revision: 1, status: "active", description: "first description", as_of: { at: t1, revision: 1, content_known: true } });
		expect((await at(t1, { history: { limit: 10 } })).revisions!.map((r) => r.revision)).toEqual([1]);
		expect(await at(t2)).toMatchObject({ content: "v1\ne1", revision: 2, description: "first description" });
		expect(await at(t3)).toMatchObject({ content: "v2", revision: 3, description: "second description" });
		expect(await outcome(c, "get_memory", { memory_id: j.memory_id, as_of: t4 })).toMatchObject({ ok: false, error: { code: "not_found", details: { reason: "not_active_at_as_of" } } });
		expect(await at(t4, { include_retired: true })).toMatchObject({ status: "retired", revision: 4, content: "v2" });
		// The same instant written with an offset is the same boundary: a revision recorded exactly then is included, a millisecond earlier is not.
		const r2 = (await call<Got>(c, "get_memory", { memory_id: j.memory_id, include_retired: true, history: { limit: 10 } })).revisions!.find((r) => r.revision === 3)!.created_at;
		const offset = (iso: string, ms = 0) => new Date(Date.parse(iso) + 2 * 3_600_000 + ms).toISOString().replace("Z", "+02:00");
		expect(await at(offset(r2))).toMatchObject({ revision: 3, content: "v2" });
		expect(await at(offset(r2, -1))).toMatchObject({ revision: 2, content: "v1\ne1" });
		// A date alone is 00:00 UTC that day; an unparseable or out-of-range value is refused, never ignored.
		expect(await outcome(c, "get_memory", { memory_id: j.memory_id, as_of: "not a date" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await outcome(c, "get_memory", { memory_id: j.memory_id, as_of: "+010000-01-01T00:00:00Z" })).toMatchObject({ ok: false, error: { code: "validation" } });
	});

	it("rebuilds a compacted journal at as_of and says when an undo makes the past content unknown", async () => {
		const c = await contextFor(), j = await journal(c, "asof compacted journal");
		await call(c, "append_memory", { memory_id: j.memory_id, content: "alpha", request_id: "asof-c1" });
		await call(c, "append_memory", { memory_id: j.memory_id, content: "beta", request_id: "asof-c2" });
		await call(c, "save_memory", { memory_id: j.memory_id, expected_revision: 3, request_id: "asof-compact", compact: { through_seq: 1, summary: "alpha summary" } });
		await call(c, "append_memory", { memory_id: j.memory_id, content: "gamma", request_id: "asof-c3" });
		const now = await tick();
		const current = await call<Got>(c, "get_memory", { memory_id: j.memory_id });
		expect(await call<Got>(c, "get_memory", { memory_id: j.memory_id, as_of: now })).toMatchObject({ content: current.content, revision: current.revision, as_of: { content_known: true } });
		const appended = await call<{ activity_id: number }>(c, "append_memory", { memory_id: j.memory_id, content: "delta", request_id: "asof-c4" });
		const t = await tick();
		const ref = c.account.profiles.find((p) => p.profile === "personal")!;
		const undone = await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`)) as DurableObjectStub<ProfileStore>,
			(_i, state) => undo(state.storage, { userId: ref.userId, profile: "personal", generation: ref.generation }, appended.activity_id, { actor: "owner", platform: "test", routedBy: "explicit", userId: ref.userId }));
		expect(undone.result).toMatchObject({ action: "undone" });
		// The undone entry left for the archive, so the state between the append and the undo is not rebuilt from what remains.
		expect(await call<Got>(c, "get_memory", { memory_id: j.memory_id, as_of: t })).toMatchObject({ content: null, complete: false, as_of: { content_known: false } });
	});

	it("recall_memories and the inventory read the records and text of as_of, lexical only", async () => {
		const c = await contextFor();
		const old = await call(c, "save_memory", { name: "asof quokka rule", type: "feedback", description: "the quokka rule", content: "quokka early text", profile: "personal" });
		const t1 = await tick();
		await call(c, "save_memory", { memory_id: old.memory_id, new_name: "asof wombat rule", content: "wombat later text" });
		await call(c, "save_memory", { name: "asof quokka newcomer", type: "feedback", description: "created after t1", content: "quokka newcomer", profile: "personal" });
		type Recall = { results: { memory_id: string; name: string; passage: string; revision: number }[]; lexical_only: boolean; as_of: string | null; next_cursor: string | null };
		const past = await call<Recall>(c, "recall_memories", { keyword: "quokka", profile: "personal", as_of: t1 });
		expect(past.as_of).toBe(t1);
		expect(past.lexical_only).toBe(true);
		expect(past.results.map((r) => [r.memory_id, r.name, r.revision])).toEqual([[old.memory_id, "asof quokka rule", 1]]);
		expect(past.results[0]!.passage).toContain("quokka early text");
		// Text written after as_of matches nothing then; the current name matches only now.
		expect((await call<Recall>(c, "recall_memories", { keyword: "wombat", profile: "personal", as_of: t1 })).results).toEqual([]);
		expect((await call<Recall>(c, "recall_memories", { keyword: "wombat", profile: "personal" })).results.map((r) => r.memory_id)).toContain(old.memory_id);
		const listed = await call<Recall>(c, "recall_memories", { keyword: "", profile: "personal", as_of: t1, limit: 100 });
		const mine = listed.results.filter((r) => r.name?.startsWith("asof ") && r.name.includes("rule") || r.name?.includes("newcomer"));
		expect(mine.map((r) => r.name)).toEqual(["asof quokka rule"]);
		// A cursor belongs to its as_of.
		const page = await call<Recall>(c, "recall_memories", { keyword: "", profile: "personal", as_of: t1, limit: 1 });
		expect(await outcome(c, "recall_memories", { keyword: "", profile: "personal", limit: 1, cursor: page.next_cursor })).toMatchObject({ ok: false, error: { code: "validation" } });
	});

	it("review_candidates list reports each capture's status at as_of, unknown when the history cannot say", async () => {
		const c = await contextFor();
		const cap = await call<{ capture_id: string }>(c, "capture_memory", { content: "asof capture text", name: "asof capture", profile: "test", request_id: "asof-cap-1" });
		const t1 = await tick();
		await call(c, "review_candidates", { action: "dismiss", candidate_id: cap.capture_id, reason: "not useful here", profile: "test" });
		const t2 = await tick();
		const later = await call<{ capture_id: string }>(c, "capture_memory", { content: "asof later capture", name: "asof later", profile: "test", request_id: "asof-cap-2" });
		type List = { candidates: { capture_id: string; status: string; reason?: string }[]; as_of?: string };
		const list = async (as_of: string, status = "all") => (await call<List>(c, "review_candidates", { action: "list", status, limit: 100, profile: "test", as_of })).candidates.filter((x) => [cap.capture_id, later.capture_id].includes(x.capture_id));
		expect(await list(t1)).toEqual([expect.objectContaining({ capture_id: cap.capture_id, status: "pending" })]);
		expect((await list(t1))[0]).not.toHaveProperty("reason");
		expect(await list(t1, "pending")).toHaveLength(1);
		expect(await list(t1, "dismissed")).toHaveLength(0);
		expect(await list(t2)).toEqual([expect.objectContaining({ capture_id: cap.capture_id, status: "dismissed", reason: "not useful here" })]);
	});
});

describe("get_memory compaction fence and imported history", () => {
	const tick = async () => { await new Promise((r) => setTimeout(r, 5)); const at = new Date().toISOString(); await new Promise((r) => setTimeout(r, 5)); return at; };
	type Fence = { compacted_through: number | null; summary_revision: number | null; latest_entry_seq: number };

	it("reports a journal's fence now and at as_of, and says unknown once an undo restored an older one", async () => {
		const c = await contextFor(), j = await journal(c, "fence journal");
		const fence = async (as_of?: string) => (await call<{ compaction: Fence }>(c, "get_memory", { memory_id: j.memory_id, ...(as_of ? { as_of } : {}) })).compaction;
		expect(await fence()).toEqual({ compacted_through: 0, summary_revision: null, latest_entry_seq: 0 });
		for (const [i, text] of ["one", "two", "three"].entries()) await call(c, "append_memory", { memory_id: j.memory_id, content: text, request_id: `fence-${i}` });
		const before = await tick();
		const compacted = await call<{ activity_id: number }>(c, "save_memory", { memory_id: j.memory_id, expected_revision: 4, request_id: "fence-compact", compact: { through_seq: 2, summary: "one and two" } });
		const after = await tick();
		expect(await fence()).toEqual({ compacted_through: 2, summary_revision: 5, latest_entry_seq: 3 });
		expect(await fence(before)).toEqual({ compacted_through: 0, summary_revision: null, latest_entry_seq: 3 });
		expect(await fence(after)).toEqual({ compacted_through: 2, summary_revision: 5, latest_entry_seq: 3 });
		const ref = c.account.profiles.find((p) => p.profile === "personal")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:personal:${ref.generation}`)) as DurableObjectStub<ProfileStore>,
			(_i, state) => undo(state.storage, { userId: ref.userId, profile: "personal", generation: ref.generation }, compacted.activity_id, { actor: "owner", platform: "test", routedBy: "explicit", userId: ref.userId }));
		const undone = await tick();
		expect(await fence()).toEqual({ compacted_through: 0, summary_revision: null, latest_entry_seq: 3 });
		expect(await fence(undone)).toEqual({ compacted_through: null, summary_revision: null, latest_entry_seq: 3 });
		// Rows a record without journal history keeps nothing else: only journals carry the field.
		expect(await call(c, "get_memory", { memory_id: (await call<{ memory_id: string }>(c, "save_memory", { ...note, name: "fence note" })).memory_id })).not.toHaveProperty("compaction");
	});

	it("reads BothQ-shaped imported history at as_of: full snapshot fields survive an append snapshot, and unknown history fails closed", async () => {
		const r = await registered("personal");
		const T = (min: number) => new Date(Date.UTC(2026, 2, 1, 12, min)).toISOString();
		const id = "imp-asof-1", full = { memory_id: id, name: "Imported log", memory_type: "project", scope: "bot_hq", description: "first description", content: "start", why: "", how_to_apply: "",
			objective: "", status: "active", _version: 1, _valid_from: T(0), _valid_until: null, _created: T(0), _updated: T(0), steps: [], relationships: { belongs_to: "bot_hq" }, content_hash: "h1" };
		// An append snapshot holds only identity, scope, status, version, hash and relationships (BothQ memory_store._write_revision).
		const append = { memory_id: id, name: "Imported log renamed", memory_type: "project", scope: "bot_hq", status: "active", _version: 2, content_hash: "h2", relationships: { belongs_to: "bot_hq" } };
		await runInDurableObject(r.stub, (_i, s) => s.storage.transactionSync(() => {
			const sql = s.storage.sql;
			sql.exec(`INSERT INTO nodes (id, kind, memory_type, scope, name, norm_name, description, status, origin, revision, chars, content_hash, card_hash, valid_from, recorded_at, created_at, updated_at, seq)
				VALUES (?, 'journal', 'project', 'bot_hq', 'Imported log renamed', 'imported log renamed', 'first description', 'active', 'import', 2, 11, 'h2', 'c', ?, ?, ?, ?, 1)`, id, T(5), new Date().toISOString(), T(0), T(5));
			sql.exec("INSERT INTO texts (node_id, part, revision, chunk, body, actor, created_at, seq) VALUES (?, 'body', 1, 0, 'start', 'migration', ?, 1)", id, T(0));
			sql.exec("INSERT INTO texts (node_id, part, revision, seq_no, chunk, body, separator, actor, created_at, seq) VALUES (?, 'entry', 2, 1, 0, 'more', '\n', 'migration', ?, 1)", id, T(5));
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, 1, 'saved', ?, 'migration', ?, 1)", id, JSON.stringify(full), T(0));
			sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, delta, actor, at, seq) VALUES (?, 2, 'appended', ?, ?, 'migration', ?, 1)", id, JSON.stringify(append), JSON.stringify({ content: "more", separator: "\n" }), T(5));
		}));
		const get = async (asOf: string) => r.stub.read(r.who, { kind: "get", target: { memory_id: id }, includeRetired: false, asOf });
		expect(await get(T(1))).toMatchObject({ ok: true, value: { name: "Imported log", description: "first description", content: "start", revision: 1, content_hash: "h1" } });
		expect(await get(T(6))).toMatchObject({ ok: true, value: { name: "Imported log renamed", description: "first description", content: "start\nmore", revision: 2, content_hash: "h2",
			freshness: { valid_from: T(0), created_at: T(0) }, as_of: { content_known: true } } });
		// A history step this rebuild does not know, or an append whose entry is gone, leaves the content unknown, never guessed.
		await runInDurableObject(r.stub, (_i, s) => s.storage.sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, 3, 'legacy_snapshot', '{}', 'migration', ?, 1)", id, T(7)));
		await runInDurableObject(r.stub, (_i, s) => s.storage.sql.exec("UPDATE nodes SET revision = 3 WHERE id = ?", id));
		expect(await get(T(8))).toMatchObject({ ok: true, value: { revision: 3, content: null, description: "first description", as_of: { content_known: false } } });
		expect(await get(T(6))).toMatchObject({ ok: true, value: { content: "start\nmore" } });
		await runInDurableObject(r.stub, (_i, s) => s.storage.sql.exec("UPDATE texts SET revision = 99 WHERE node_id = ? AND part = 'entry'", id));
		expect(await get(T(6))).toMatchObject({ ok: true, value: { content: null, as_of: { content_known: false } } });
	});
});

it("does not acknowledge a whole capture range from one incomplete consolidated part", async () => {
 const p = await registered("test");
 const session = { client: "codex" as const, id: "review_partial" };
 const range_id = "codex:review_partial:01234567:0-100";
 const body = JSON.stringify({asks: [], decisions: [], corrections: [], outcomes: {}, entities: [], dropped: {asks: 0, decisions: 0, corrections: 0}});
 const stored = await p.stub.ingest(p.who, {session, digests: [{range_id, capture_status: "consolidated", part_id: "0-50", sha256: sha256(body), body}], manifests: []});
 expect(stored).toMatchObject({ok: true, value: [{status: "stored"}]});
 const r = await p.stub.read(p.who, {kind: "markers", repo: null, session}) as Outcome<unknown>;
 expect(r.ok).toBe(true);
 if (!r.ok) return;
 const completed = await p.stub.ingest(p.who, {session, digests: [{range_id, capture_status: "consolidated", part_id: "50-100", sha256: sha256(body), body}], manifests: [{range_id, parts: [{part_id: "0-50", sha256: sha256(body)}, {part_id: "50-100", sha256: sha256(body)}]}]});
 expect(completed).toMatchObject({ok: true, value: [{status: "stored"}, {status: "stored"}]});
 expect(await p.stub.read(p.who, {kind: "markers", repo: null, session})).toMatchObject({ok: true, value: {captures: {acknowledged: {"01234567": {digested_to: 100, consolidated_to: 100}}}}});
 expect(r.value).toMatchObject({captures: {ranges: [{heuristic: false, consolidated: false}], acknowledged: {"01234567": {digested_to: 0, consolidated_to: 0}}}});
 // Losing an upload response is safe: replay the stored manifest and read its coverage.
 expect(await p.stub.ingest(p.who, {session, digests: [], manifests: [{range_id, parts: [{part_id: "0-50", sha256: sha256(body)}, {part_id: "50-100", sha256: sha256(body)}]}]})).toMatchObject({ok: true, value: [{status: "replayed"}]});
 // A durable manifest with a missing part, or an invalid manifest body, cannot acknowledge coverage.
 await runInDurableObject(p.stub, (_i, state) => state.storage.sql.exec("DELETE FROM texts WHERE range_id = ? AND capture_part = '50-100'", range_id));
 expect(await p.stub.read(p.who, {kind: "markers", repo: null, session})).toMatchObject({ok: true, value: {captures: {acknowledged: {"01234567": {digested_to: 0, consolidated_to: 0}}}}});
 await runInDurableObject(p.stub, (_i, state) => state.storage.sql.exec("UPDATE texts SET body = '{}' WHERE range_id = ? AND capture_part = 'manifest'", range_id));
 expect(await p.stub.captureState(p.who, [range_id])).toMatchObject({ok: true, value: {[range_id]: {consolidated: false}}});
 const digest = (range_id: string) => ({range_id, capture_status: "heuristic" as const, part_id: "-", sha256: sha256(body), body});
 await p.stub.ingest(p.who, {session, digests: [digest("codex:review_partial:01234567:0-40"), digest("codex:review_partial:01234567:60-100")], manifests: []});
 expect(await p.stub.read(p.who, {kind: "markers", repo: null, session})).toMatchObject({ok: true, value: {captures: {acknowledged: {"01234567": {digested_to: 40}}}}});
 await p.stub.ingest(p.who, {session, digests: [digest("codex:review_partial:01234567:40-60")], manifests: []});
 expect(await p.stub.read(p.who, {kind: "markers", repo: null, session})).toMatchObject({ok: true, value: {captures: {acknowledged: {"01234567": {digested_to: 100, consolidated_to: 0}}}}});
});

it("does not traverse an edge recorded after the map as_of", async () => {
 const p = await registered("test");
 const early = "2026-01-01T00:00:00.000Z", late = "2026-03-01T00:00:00.000Z";
 await runInDurableObject(p.stub, (_i, state) => {
  const sql = state.storage.sql;
  for (const id of ["review-a", "review-b", "review-c"]) sql.exec(`INSERT INTO nodes (id, kind, name, norm_name, status, origin, content_hash, card_hash, recorded_at, created_at, updated_at, seq) VALUES (?, 'project', ?, ?, 'active', 'agent', 'h', 'h', ?, ?, ?, 1)`, id, id, id, early, early, early);
  for (const [src, dst, at] of [["review-a", "review-b", late], ["review-b", "review-c", early]]) sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, reason, recorded_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'judgment', 'synthetic review edge', ?, 'agent', 1)`, src!, dst!, at!);
 });
 expect(await p.stub.read(p.who, {kind: "map", center: {id: "review-a"}, depth: 1, asOf: "2026-02-01T00:00:00.000Z", known: ["test"]})).toMatchObject({ok: true, value: {nodes: [{id: "review-a"}], links: []}});
 const r = await p.stub.read(p.who, {kind: "map", center: {id: "review-a"}, depth: 2, asOf: "2026-02-01T00:00:00.000Z", known: ["test"]}) as Outcome<unknown>;
 expect(r.ok).toBe(true);
 if (!r.ok) return;
 expect(r.value).toMatchObject({nodes: [{id: "review-a"}], links: []});
 // Other graph consumers retain their accepted valid-time-only policy.
 expect(await p.stub.read(p.who, {kind: "explore", node: {id: "review-a"}, depth: 2, maxEdges: 5000, known: ["test"], asOf: "2026-02-01T00:00:00.000Z"})).toMatchObject({ok: true, value: {links: expect.arrayContaining([expect.objectContaining({src: "review-a", dst: "review-b"})])}});
 // Eligible historical edges must still reach their own frontier, without reaching B/C through the future A-B.
 await runInDurableObject(p.stub, (_i, state) => {
  const sql = state.storage.sql;
  for (const id of ["review-d", "review-e"]) sql.exec(`INSERT INTO nodes (id, kind, name, norm_name, status, origin, content_hash, card_hash, recorded_at, created_at, updated_at, seq) VALUES (?, 'project', ?, ?, 'active', 'agent', 'h', 'h', ?, ?, ?, 1)`, id, id, id, early, early, early);
  for (const [src, dst] of [["review-a", "review-d"], ["review-d", "review-e"]]) sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'identifier', ?, 'agent', 1)`, src!, dst!, early);
 });
 expect(await p.stub.read(p.who, {kind: "map", center: {id: "review-a"}, depth: 2, asOf: "2026-02-01T00:00:00.000Z", known: ["test"]})).toMatchObject({ok: true, value: {nodes: [{id: "review-a"}, {id: "review-d"}, {id: "review-e"}], links: [expect.objectContaining({from: {id: "review-a", readable: true}, to: {id: "review-d", readable: true}}), expect.objectContaining({from: {id: "review-d", readable: true}, to: {id: "review-e", readable: true}})]}});

});

it("searches historical tokens after the current body was replaced", async () => {
 const c = await contextFor();
 const saved = await call(c, "save_memory", {name: "review token history", type: "reference", description: "synthetic fixture", content: "quokka separated wombat", profile: "personal"});
 const ref = c.account.profiles.find(p => p.profile === "personal")!;
 const ps = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as DurableObjectStub<ProfileStore>;
 await call(c, "save_memory", {memory_id: saved.memory_id, content: "replacement unrelated body"});
 await runInDurableObject(ps, (_i, state) => {
  const sql = state.storage.sql;
  sql.exec("UPDATE nodes SET valid_from = ?, created_at = ?, recorded_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", saved.memory_id as string);
  sql.exec("UPDATE revisions SET at = CASE revision WHEN 1 THEN ? ELSE ? END WHERE node_id = ?", "2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", saved.memory_id as string);
 });
 expect(await call(c, "get_memory", {memory_id: saved.memory_id, as_of: "2026-02-01T00:00:00.000Z"})).toMatchObject({content: "quokka separated wombat", revision: 1});
 const control = await call<{results: {memory_id: string}[]}>(c, "recall_memories", {keyword: "quokka", profile: "personal", as_of: "2026-02-01T00:00:00.000Z", expand: false});
 expect(control.results.map(r => r.memory_id)).toContain(saved.memory_id);
 const got = await call<{results: {memory_id: string; matched_by: string[]}[]}>(c, "recall_memories", {keyword: "quokka wombat", profile: "personal", as_of: "2026-02-01T00:00:00.000Z", expand: false});
 expect(got.results.map(r => r.memory_id)).toContain(saved.memory_id);
 expect(got.results.find(r => r.memory_id === saved.memory_id)?.matched_by).toContain("fulltext");
 expect(got.results.find(r => r.memory_id === saved.memory_id)?.matched_by).not.toContain("literal");
 const current = await call<{results: {memory_id: string}[]}>(c, "recall_memories", {keyword: "quokka wombat", profile: "personal", expand: false});
 expect(current.results.map(r => r.memory_id)).not.toContain(saved.memory_id);
});
