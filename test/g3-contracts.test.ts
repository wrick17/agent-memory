// G3 contract checks (section 22), against real SQLite Durable Objects in workerd.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountStub } from "../src/mcp";
import { call, contextFor, deviceToken, devicePrincipal, journal, outcome } from "./helpers";

const rule = { name: "Use pnpm in Sequoia repos", type: "feedback", description: "Package manager rule",
	content: "Run pnpm install. npm rewrites pnpm-lock.yaml — never use it.", why: "Owner correction", profile: "personal" };

describe("G3 contracts", () => {
	it("replays a stored result and refuses a changed payload", async () => {
		const c = await contextFor();
		const first = await call(c, "save_memory", { ...rule, request_id: "g3-replay-1" });
		expect(first.action).toBe("created");
		expect(first.revision).toBe(1);
		const again = await call(c, "save_memory", { ...rule, request_id: "g3-replay-1" });
		expect(again).toEqual({ ...first, action: "replayed" });
		const changed = await outcome(c, "save_memory", { ...rule, content: "different", request_id: "g3-replay-1" });
		expect(changed).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
	});

	it("hashes saved content exactly as BothQ does", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { ...rule, name: "BothQ hash parity", profile: "test" });
		// Python: BothQ memory_store._hash(content_source(...)) for the same fields.
		const bothq = await call(c, "get_memory", { memory_id: saved.memory_id });
		expect(bothq.content_hash).toBe(saved.content_hash);
		const parity = await call(c, "save_memory", { ...rule, profile: "work", request_id: "g3-hash" });
		expect(parity.content_hash).toBe("385cb67b0ec35e4da0b95ee1b8309848f865689759384386b673ba9198972265");
	});

	it("refuses a stale revision on update and append", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { ...rule, name: "Stale revision target" });
		const stale = await outcome(c, "save_memory", { memory_id: saved.memory_id, content: "new body", expected_revision: 7 });
		expect(stale).toMatchObject({ ok: false, error: { code: "revision_conflict", details: { expected_revision: 7, actual_revision: 1 } } });
		const updated = await call(c, "save_memory", { memory_id: saved.memory_id, content: "new body", expected_revision: 1 });
		expect(updated).toMatchObject({ action: "updated", revision: 2 });
		const j = await journal(c, "codex: stale append journal");
		const appendStale = await outcome(c, "append_memory", { memory_id: j.memory_id, content: "x", request_id: "g3-stale-append", expected_revision: 5 });
		expect(appendStale).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
		// The refused request id was released, so a corrected retry with the same id is accepted (BothQ rolls its request node back).
		const fixed = await call(c, "append_memory", { memory_id: j.memory_id, content: "x", request_id: "g3-stale-append", expected_revision: 1 });
		expect(fixed).toMatchObject({ action: "appended", revision: 2, entry_seq: 1 });
	});

	it("keeps 200 concurrent appends from two machines, gapless and none lost", async () => {
		const owner = await contextFor({ kind: "owner", userId: env.OWNER_USER_ID, device: "work-mbp" });
		const { token } = await deviceToken("headless-box", ["read", "write"], ["personal", "me"], "personal");
		const device = await contextFor(devicePrincipal(token));
		const j = await journal(owner, "codex: concurrent journal");
		const sends = [owner, device].flatMap((c, m) => Array.from({ length: 100 }, (_, i) =>
			call(c, "append_memory", { memory_id: j.memory_id, content: `m${m}-${i}`, request_id: `g3-conc-${m}-${i}` })));
		const results = await Promise.all(sends);
		expect(results.every((r) => r.action === "appended")).toBe(true);
		const seqs = results.map((r) => r.entry_seq as number).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
		const got = await call(owner, "get_memory", { memory_id: j.memory_id });
		expect(got.revision).toBe(201);
		const lines = (got.content as string).split("\n");
		expect(lines).toHaveLength(200);
		expect(new Set(lines).size).toBe(200);
	});

	it("supersedes atomically, and a failed supersede changes nothing", async () => {
		const c = await contextFor();
		const old = await call(c, "save_memory", { ...rule, name: "Old timeout rule", content: "Use 30 s." });
		const bad = await outcome(c, "save_memory", { ...rule, name: "New timeout rule", content: "Use 10 s.", supersedes: [old.memory_id, "00000000-0000-5000-8000-000000000000"] });
		expect(bad).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await outcome(c, "get_memory", { name: "New timeout rule", profile: "personal" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await call(c, "get_memory", { memory_id: old.memory_id })).toMatchObject({ status: "active", revision: 1 });
		const fresh = await call(c, "save_memory", { ...rule, name: "New timeout rule", content: "Use 10 s.", supersedes: old.memory_id });
		expect(fresh.superseded).toEqual([old.memory_id]);
		const prior = await call(c, "get_memory", { memory_id: old.memory_id, include_retired: true });
		expect(prior).toMatchObject({ status: "superseded", revision: 2, relationships: { superseded_by: [fresh.memory_id] } });
		expect(await outcome(c, "save_memory", { ...rule, name: "Self", supersedes: "x", memory_id: fresh.memory_id })).toMatchObject({ ok: false });
	});

	it("validates procedural memories as BothQ does", async () => {
		const c = await contextFor();
		const base = { name: "Deploy routine", type: "procedural", description: "How to deploy", profile: "personal" };
		const reason = async (args: Record<string, unknown>) => {
			const r = await outcome(c, "save_memory", { ...base, ...args });
			return r.ok ? "ok" : [r.error.code, r.error.details?.reason, r.error.message].join(" | ");
		};
		expect(await reason({ steps: [{ order: 1, action: "a", success_criteria: "b" }] })).toBe("validation | missing_objective | objective is required for procedural memories");
		expect(await reason({ objective: "Ship", steps: [] })).toBe("validation | invalid_steps | steps must be a non-empty list");
		expect(await reason({ objective: "Ship", steps: [{ order: 0, action: "a", success_criteria: "b" }] })).toBe("validation | invalid_steps | step 0 order must be a positive integer");
		expect(await reason({ objective: "Ship", steps: [{ order: 1, action: "a", success_criteria: "b" }, { order: 1, action: "c", success_criteria: "d" }] })).toBe("validation | invalid_steps | duplicate step order 1");
		expect(await reason({ objective: "Ship", steps: [{ order: 1, action: " ", success_criteria: "b" }] })).toBe("validation | invalid_steps | step 0 needs action and success_criteria");
		expect(await reason({ type: "feedback", steps: [{ order: 1, action: "a", success_criteria: "b" }] })).toBe("validation | steps_not_supported | steps are only valid for procedural memories");
		const saved = await call(c, "save_memory", { ...base, objective: "Ship safely", steps: [{ order: 2, action: "Deploy", success_criteria: "Healthy" }, { order: 1, action: "Test", success_criteria: "Green" }] });
		const got = await call(c, "get_memory", { memory_id: saved.memory_id });
		expect(got.content).toBe("Ship safely\n1. Test\n2. Deploy");
		expect((got.steps as { order: number }[]).map((s) => s.order)).toEqual([1, 2]);
		expect(await outcome(c, "append_memory", { memory_id: saved.memory_id, content: "x", request_id: "g3-proc-append" }))
			.toMatchObject({ ok: false, error: { code: "validation", details: { reason: "append_not_supported" } } });
	});

	it("replays a retry in the original profile after a routing-rule change", async () => {
		const c = await contextFor();
		const args = { ...rule, name: "Routed before the change", repo: { remote: "git@github.com:wrick17/bettergit.git" }, request_id: "g3-route-1" };
		delete (args as Record<string, unknown>).profile;
		const first = await call(c, "save_memory", args);
		expect(first).toMatchObject({ profile: "personal", routed_by: "rule:github.com/wrick17/*" });
		await accountStub(env, env.OWNER_USER_ID).admin({ op: "setRules", rules: [{ priority: 10, match: "remote", pattern: "github.com/wrick17/*", profile: "work", enabled: true }] });
		const later = await contextFor();
		const retry = await call(later, "save_memory", args);
		expect(retry).toMatchObject({ action: "replayed", profile: "personal", memory_id: first.memory_id });
		const fresh = await call(later, "save_memory", { ...args, name: "Routed after the change", request_id: "g3-route-2" });
		expect(fresh.profile).toBe("work");
		await accountStub(env, env.OWNER_USER_ID).admin({ op: "setRules", rules: [
			{ priority: 10, match: "remote", pattern: "github.com/Sequoia-Engineering/*", profile: "work", enabled: true },
			{ priority: 20, match: "remote", pattern: "github.com/wrick17/*", profile: "personal", enabled: true },
			{ priority: 30, match: "path", pattern: "/Users/test/work", profile: "work", enabled: true }] });
	});

	it("enumerates 250 records completely through next_cursor with an empty keyword", async () => {
		const c = await contextFor();
		for (let i = 0; i < 250; i++) await call(c, "save_memory", { name: `inventory record ${i}`, type: "reference", description: `record ${i}`, content: `body ${i}`, profile: "test" });
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: { results: { name: string; profile: string }[]; next_cursor: string | null } =
				await call(c, "recall_memories", { keyword: "", profile: "test", limit: 40, token_budget: 4000, ...(cursor ? { cursor } : {}) });
			seen.push(...page.results.filter((r) => r.profile === "test" && r.name.startsWith("inventory record")).map((r) => r.name));
			cursor = page.next_cursor;
			pages++;
		} while (cursor && pages < 100);
		expect(cursor).toBeNull();
		expect(seen).toHaveLength(250);
		expect(new Set(seen).size).toBe(250);
		expect(seen.slice(0, 3)).toEqual(["inventory record 0", "inventory record 1", "inventory record 2"]);
	});

	it("returns revision_conflict when an append lands between content pages", async () => {
		const c = await contextFor();
		const j = await journal(c, "codex: large journal");
		for (let i = 0; i < 3; i++) await call(c, "append_memory", { memory_id: j.memory_id, content: `${i}`.repeat(60_000), request_id: `g3-big-${i}` });
		const head = await call(c, "get_memory", { memory_id: j.memory_id });
		expect(head).toMatchObject({ complete: false, content_chars: 180_002 });
		const p1 = await call(c, "get_memory", { memory_id: j.memory_id, content: { complete: true } });
		expect((p1.content as string).length).toBe(100_000);
		const p2 = await call(c, "get_memory", { memory_id: j.memory_id, content: { complete: true, cursor: p1.cursor } });
		expect((p1.content as string) + (p2.content as string)).toHaveLength(180_002);
		expect(p2).toMatchObject({ complete: true, cursor: null });
		await call(c, "append_memory", { memory_id: j.memory_id, content: "late entry", request_id: "g3-big-late" });
		expect(await outcome(c, "get_memory", { memory_id: j.memory_id, content: { complete: true, cursor: p1.cursor } }))
			.toMatchObject({ ok: false, error: { code: "revision_conflict" } });
	});
});
