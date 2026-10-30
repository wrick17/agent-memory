// The owner-model read (section 12, About you in section 15) on the real profile schema, in disposable profile objects of
// its own user. The ProfileStore.read case and the API route are the integrator's wiring and are not exercised here.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Fail } from "../src/domain/types";
import { OWNER_EVIDENCE_MAX, OWNER_MODEL_MAX, ownerModel, type OwnerModelPage } from "../src/profile/owner-model";

let n = 0;
const inProfile = <T>(fn: (sql: SqlStorage) => T, profile = "personal") =>
	runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`om-test:${profile}:g${++n}-${Date.now()}`)), (_i, s) => fn(s.storage.sql));

/** Test-only rows written straight into the profile: the owner model reads shapes several write paths make. */
function pref(sql: SqlStorage, id: string, o: { origin?: string; pinned?: number; at?: string; status?: string; kind?: string; flagged?: string; source?: string } = {}) {
	const at = o.at ?? "2026-10-01T00:00:00.000Z";
	sql.exec(`INSERT INTO nodes (id, kind, memory_type, name, norm_name, description, status, origin, pinned, flagged, content_hash, card_hash, recorded_at, created_at, updated_at, source_profile, seq)
		VALUES (?, ?, 'user', ?, ?, 'd', ?, ?, ?, ?, 'h', 'c', ?, ?, ?, ?, 1)`, id, o.kind ?? "preference", id, id.toLowerCase(), o.status ?? "active", o.origin ?? "agent",
	o.pinned ?? 0, o.flagged ?? null, at, at, at, o.source ?? null);
}
const evidence = (sql: SqlStorage, id: string, kind: string, ref: string) =>
	sql.exec("INSERT INTO evidence (owner, kind, ref, note, seq) VALUES (?, ?, ?, NULL, 1)", `n:${id}`, kind, ref);
const all = (sql: SqlStorage, limit: number) => {
	const ids: string[] = [];
	for (let after: string | null = null, pages = 0; pages < 50; pages++) {
		const page: OwnerModelPage = ownerModel(sql, { kind: "owner_model", after, limit });
		ids.push(...page.items.map((i) => i.id));
		if (!(after = page.next_after)) return ids;
	}
	throw new Error("paging did not end");
};
const refused = (fn: () => unknown) => {
	try { fn(); } catch (e) { return e instanceof Fail ? e.failure.code : e; }
	return "accepted";
};

describe("owner model", () => {
	it("orders stated, then pinned, then newest with ties on id, and pages through every active preference once", () =>
		inProfile((sql) => {
			pref(sql, "agent-old", { at: "2026-09-01T00:00:00.000Z" });
			pref(sql, "inferred-new", { origin: "inferred", at: "2026-10-20T00:00:00.000Z" });
			pref(sql, "pinned-agent", { pinned: 1, at: "2026-08-01T00:00:00.000Z" });
			pref(sql, "stated-old", { origin: "stated", at: "2026-01-01T00:00:00.000Z" });
			pref(sql, "stated-pinned", { origin: "stated", pinned: 1, at: "2026-02-01T00:00:00.000Z" });
			for (const id of ["tie-a", "tie-b", "tie-c"]) pref(sql, id); // same updated_at as each other
			for (const status of ["retired", "superseded", "candidate", "incoming", "moving", "moved"]) pref(sql, `gone-${status}`, { status, origin: "stated", pinned: 1 });
			pref(sql, "a-rule", { kind: "rule", origin: "stated" });
			const expected = ["stated-pinned", "stated-old", "pinned-agent", "inferred-new", "tie-c", "tie-b", "tie-a", "agent-old"];
			expect(all(sql, 200)).toEqual(expected);
			// Every page size gives the same sequence, with no repeat and no gap across the tie.
			for (const limit of [1, 2, 3]) expect(all(sql, limit)).toEqual(expected);
			const first = ownerModel(sql, { kind: "owner_model", after: null, limit: 8 });
			expect(first.next_after).toBeNull();
			expect(first.items[0]).toMatchObject({ origin: "stated", pinned: true, flagged: null, revision: 1, source_profile: null, links: 0 });
		}));

	it("returns evidence in a bounded, truthful slice and marks inferred preferences that have none", () =>
		inProfile((sql) => {
			pref(sql, "inferred-with", { origin: "inferred" });
			evidence(sql, "inferred-with", "session", "session:codex:thr_1");
			pref(sql, "inferred-without", { origin: "inferred" });
			pref(sql, "stated-without", { origin: "stated" });
			pref(sql, "many", { flagged: "protected: stated" });
			for (let i = 0; i < OWNER_EVIDENCE_MAX + 2; i++) evidence(sql, "many", "url", `https://example.test/${String(i).padStart(2, "0")}`);
			evidence(sql, "many", "entry", "e1");
			// Only current edges count; an ended one is history.
			sql.exec("INSERT INTO edges (src, rel, dst, basis, recorded_at, actor, seq) VALUES ('many', 'relates_to', 'x', 'identifier', 't', 'test', 1)");
			sql.exec("INSERT INTO edges (src, rel, dst, basis, recorded_at, ended_at, actor, seq) VALUES ('many', 'relates_to', 'y', 'identifier', 't', 't', 'test', 1)");
			const by = Object.fromEntries(ownerModel(sql, { kind: "owner_model", after: null, limit: 10 }).items.map((i) => [i.id, i]));
			expect(by["inferred-with"]).toMatchObject({ evidence: [{ kind: "session", ref: "session:codex:thr_1", note: null }], evidence_truncated: false, evidence_missing: false });
			expect(by["inferred-without"]).toMatchObject({ evidence: [], evidence_truncated: false, evidence_missing: true });
			expect(by["stated-without"]).toMatchObject({ evidence: [], evidence_missing: false });
			const many = by.many!;
			expect(many).toMatchObject({ flagged: "protected: stated", links: 1, evidence_truncated: true, evidence_missing: false });
			expect(many.evidence.map((e) => e.ref)).toEqual(["e1", ...Array.from({ length: OWNER_EVIDENCE_MAX - 1 }, (_, i) => `https://example.test/${String(i).padStart(2, "0")}`)]);
		}));

	it("reports a me survivor's stored source profile as stored, and writes nothing", () =>
		inProfile((sql) => {
			pref(sql, "from-work", { origin: "stated", source: "work" });
			evidence(sql, "from-work", "node", "a-work-node-id");
			const meta = () => sql.exec("SELECT key, value FROM profile_meta ORDER BY key").toArray();
			const before = meta();
			const [item] = ownerModel(sql, { kind: "owner_model", after: null, limit: 5 }).items;
			// The node pointer stays an opaque ref; nothing is looked up in another profile.
			expect(item).toMatchObject({ id: "from-work", source_profile: "work", evidence: [{ kind: "node", ref: "a-work-node-id", note: null }] });
			expect(meta()).toEqual(before);
			expect(sql.exec("SELECT count(*) AS c FROM nodes WHERE source_profile = 'work' AND status = 'active'").one().c).toBe(1);
		}, "me"));

	it("caps the limit and refuses invalid limits and cursors", () =>
		inProfile((sql) => {
			for (let i = 0; i < OWNER_MODEL_MAX + 5; i++) pref(sql, `p${String(i).padStart(3, "0")}`);
			const page = ownerModel(sql, { kind: "owner_model", after: null, limit: 10_000 });
			expect(page.items).toHaveLength(OWNER_MODEL_MAX);
			expect(ownerModel(sql, { kind: "owner_model", after: page.next_after, limit: 10_000 }).items.map((i) => i.id)).toEqual(["p004", "p003", "p002", "p001", "p000"]);
			for (const limit of [0, -1, 1.5, Number.NaN]) expect(refused(() => ownerModel(sql, { kind: "owner_model", after: null, limit }))).toBe("validation");
			const bad = ["", "x", "{}", "[1,1]", "[2,0,\"t\",\"id\"]", "[1,0,\"t\",\"\"]", "[1,0,5,\"id\"]", "[\"1\",0,\"t\",\"id\"]", JSON.stringify([0, 0, "t".repeat(600), "id"])];
			for (const after of bad) expect(refused(() => ownerModel(sql, { kind: "owner_model", after, limit: 5 })), after).toBe("validation");
			expect(refused(() => ownerModel(sql, { kind: "owner_model", after: 7 as unknown as string, limit: 5 }))).toBe("validation");
		}));
});
