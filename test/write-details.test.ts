// BothQ write details beyond G3: identity-preserving rename and scope moves, retire, history windows,
// redaction before hashing, and the sequence stamps and tombstones the export depends on.
import { runInDurableObject } from "cloudflare:test";
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
