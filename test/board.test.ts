// work_board (section 13) on the real profile schema: every scoring term and its reason, staleness, links dated by as_of, the
// work budgets, the latest strategic review, and what stays off the board or opaque. Each case seeds its own fresh profile
// object, never the shared owner profiles. Handler cases check refusals only; the store wiring is the integrator's.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { workBoard } from "../src/board-tools";
import { board, type BoardQuery } from "../src/profile/board";
import { contextFor, devicePrincipal, deviceToken } from "./helpers";

const AS_OF = "2026-10-29T12:00:00.000Z", DAY = 86_400_000;
/** The instant `d` days before as_of (negative: after it). */
const ago = (d: number) => new Date(Date.parse(AS_OF) - d * DAY).toISOString();

type NodeSeed = { kind?: string; attrs?: Record<string, unknown>; status?: string; name?: string; recorded?: number; updated?: number };
function node(sql: SqlStorage, id: string, s: NodeSeed = {}) {
	const recorded = ago(s.recorded ?? 30), name = s.name ?? id;
	sql.exec(`INSERT INTO nodes (id, kind, name, norm_name, attrs, status, origin, content_hash, card_hash, recorded_at, created_at, updated_at, seq)
		VALUES (?, ?, ?, ?, ?, ?, 'upload', 'h', 'c', ?, ?, ?, 1)`, id, s.kind ?? "ticket", name, name.toLowerCase(), JSON.stringify(s.attrs ?? { state: "open" }),
	s.status ?? "active", recorded, recorded, ago(s.updated ?? 1));
}
type EdgeSeed = { dstProfile?: string; recorded?: number; ended?: number; validFrom?: number; validTo?: number };
function edge(sql: SqlStorage, src: string, rel: string, dst: string, e: EdgeSeed = {}) {
	const t = (d?: number) => (d === undefined ? null : ago(d));
	sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, valid_from, valid_to, recorded_at, ended_at, actor, seq) VALUES (?, ?, ?, ?, 'identifier', ?, ?, ?, ?, 'test', 1)`,
		src, rel, dst, e.dstProfile ?? "", t(e.validFrom), t(e.validTo), ago(e.recorded ?? 20), t(e.ended));
}

/** Seeds a fresh profile object and reads its board at as_of. */
function boardOf(seed: (sql: SqlStorage) => void, q: Partial<BoardQuery> = {}) {
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`board-test:${crypto.randomUUID()}`));
	return runInDurableObject(stub, (_i, s) => {
		seed(s.storage.sql);
		return board(s.storage.sql, { kind: "board", asOf: AS_OF, limit: 50, known: [], ...q });
	});
}
type Result = Awaited<ReturnType<typeof boardOf>>;
const item = (r: Result, id: string) => r.items.find((i) => i.id === id)!;

describe("work_board scoring", () => {
	it("scores every term with one reason each, in a fixed order, and breaks ties by id", async () => {
		const r = await boardOf((sql) => {
			node(sql, "t-all", { attrs: { state: "open", priority: "High", due: "2026-11-05", assignee_is_owner: true } });
			node(sql, "b-1", { attrs: { state: "open", priority: "Low" } });
			node(sql, "b-2", { kind: "bug", attrs: { state: "open", priority: "Low" } });
			node(sql, "x-blocker", { kind: "feature", attrs: { state: "open", priority: "Medium" } });
			node(sql, "j-1", { kind: "journal", updated: 2 });
			edge(sql, "b-1", "blocked_by", "t-all");
			edge(sql, "b-2", "blocked_by", "t-all");
			edge(sql, "t-all", "blocked_by", "x-blocker");
			edge(sql, "j-1", "relates_to", "t-all");
			node(sql, "pr-1", { kind: "pr", attrs: { state: "open", due: "2026-10-20T09:00:00Z", review_requested_from_owner: true } });
		});
		const all = item(r, "t-all");
		expect(all.reasons).toEqual([
			{ term: "priority", points: 30, text: "Priority High (+30)." },
			{ term: "due", points: 12.5, text: "Due 2026-11-05, in 7 days (+12.5)." },
			{ term: "owner_action", points: 15, text: "Assigned to the owner (+15)." },
			{ term: "blocking", points: 6.67, text: "Blocks 2 open items (+6.67)." },
			{ term: "recent_activity", points: 10, text: "1 linked journal, commit or PR active in the last 7 days (+10)." },
			{ term: "blocked", points: -20, text: "Has 1 open blocked_by link (-20)." },
		]);
		expect(all.score).toBe(54.17);
		expect(all.blocks).toEqual([{ id: "b-1", kind: "ticket", name: "b-1" }, { id: "b-2", kind: "bug", name: "b-2" }]);
		expect(all.blocked_by).toEqual([{ id: "x-blocker", kind: "feature", name: "x-blocker" }]);
		expect(item(r, "pr-1").reasons.map((x) => x.text)).toEqual(["No recognized priority (+16).", "Overdue since 2026-10-20T09:00:00Z (+25).", "Review requested from the owner (+15)."]);
		expect(item(r, "pr-1").score).toBe(56);
		// b-1 and b-2 tie at 10 - 20 = -10; id breaks the tie. x-blocker: Medium (+20) and blocks t-all (+3.33).
		expect(r.items.map((i) => [i.id, i.score])).toEqual([["pr-1", 56], ["t-all", 54.17], ["x-blocker", 23.33], ["b-1", -10], ["b-2", -10]]);
		expect(r.items.map((i) => i.id)).not.toContain("j-1");
	});

	it("lists unrecognized fields and scores them conservatively, never as the owner's", async () => {
		const r = await boardOf((sql) => node(sql, "odd", { attrs: { state: "open", priority: "P1", due: "next week", assignee_is_owner: "yes", review_requested_from_owner: 1 } }));
		const odd = item(r, "odd");
		expect(odd.unrecognized).toEqual(["priority", "due", "assignee_is_owner", "review_requested_from_owner"]);
		expect(odd.reasons).toEqual([{ term: "priority", points: 16, text: "No recognized priority (+16)." }]);
		expect([odd.priority, odd.due]).toEqual(["P1", "next week"]);
	});

	it("marks an item stale after 14 days without an upload or linked activity, and credits only activity within 7 days", async () => {
		const r = await boardOf((sql) => {
			node(sql, "quiet", { updated: 15 });
			node(sql, "linked", { updated: 15 });
			node(sql, "c-1", { kind: "commit", updated: 10, recorded: 10 });
			edge(sql, "c-1", "part_of", "linked", { recorded: 10 });
			node(sql, "fresh", { updated: 13 });
			// Changed after as_of: only its recorded_at (20 days ago) is credited.
			node(sql, "later", { updated: 15 });
			node(sql, "j-late", { kind: "journal", updated: -2, recorded: 20 });
			edge(sql, "j-late", "relates_to", "later", { recorded: 20 });
		});
		expect(item(r, "quiet")).toMatchObject({ stale: true, last_activity_at: ago(15) });
		expect(item(r, "linked")).toMatchObject({ stale: false, last_activity_at: ago(10) });
		expect(item(r, "linked").reasons.map((x) => x.term)).toEqual(["priority"]);
		expect(item(r, "fresh").stale).toBe(false);
		expect(item(r, "later")).toMatchObject({ stale: true, last_activity_at: ago(15) });
	});

	it("does not credit a retired linked journal as activity", async () => {
		const r = await boardOf((sql) => {
			node(sql, "quiet", { updated: 20 });
			node(sql, "retired-journal", { kind: "journal", status: "retired", recorded: 30, updated: 1 });
			edge(sql, "retired-journal", "relates_to", "quiet", { recorded: 20 });
		});
		expect(item(r, "quiet")).toMatchObject({ score: 16, stale: true, last_activity_at: ago(20) });
		expect(item(r, "quiet").reasons.map((x) => x.term)).not.toContain("recent_activity");
	});

	it("keeps future-recorded blockers opaque, including a blocker now marked closed", async () => {
		const r = await boardOf((sql) => {
			node(sql, "waiting-open", { updated: 20 });
			node(sql, "waiting-closed", { updated: 20 });
			node(sql, "future-open", { recorded: -1, name: "unseen open blocker" });
			node(sql, "future-closed", { recorded: -1, attrs: { state: "closed" }, name: "unseen closed blocker" });
			edge(sql, "waiting-open", "blocked_by", "future-open");
			edge(sql, "waiting-closed", "blocked_by", "future-closed");
		});
		expect(r.items.map(({ id, score, blocked_by }) => ({ id, score, blocked_by }))).toEqual([
			{ id: "waiting-closed", score: -4, blocked_by: [{ id: "future-closed", readable: false }] },
			{ id: "waiting-open", score: -4, blocked_by: [{ id: "future-open", readable: false }] },
		]);
		expect(JSON.stringify(r)).not.toContain("unseen");
	});

	it("uses only links recorded by as_of, valid then and not ended then", async () => {
		const r = await boardOf((sql) => {
			node(sql, "t", {});
			for (const b of ["future-recorded", "not-yet-valid", "ended", "ended-early", "ended-later"]) node(sql, b, {});
			edge(sql, "t", "blocked_by", "future-recorded", { recorded: -1 });
			edge(sql, "t", "blocked_by", "not-yet-valid", { validFrom: -2 });
			edge(sql, "t", "blocked_by", "ended", { ended: 1 });
			// The graph would count this one (valid_to is later); the board also needs it not ended at as_of.
			edge(sql, "t", "blocked_by", "ended-early", { ended: 1, validTo: -5 });
			edge(sql, "t", "blocked_by", "ended-later", { ended: -1 });
			node(sql, "too-new", { recorded: -1 });
		});
		expect(item(r, "t").blocked_by).toEqual([{ id: "ended-later", kind: "ticket", name: "ended-later" }]);
		expect(r.items.map((i) => i.id)).not.toContain("too-new");
		expect(item(r, "ended-later").reasons.map((x) => x.text)).toContain("Blocks 1 open item (+3.33).");
	});
});

describe("work_board boundaries", () => {
	it("keeps closed, unstated, moving, incoming and moved items off the board and opaque", async () => {
		const r = await boardOf((sql) => {
			node(sql, "open", {});
			node(sql, "closed", { attrs: { state: "closed" } });
			node(sql, "unstated", { attrs: {} });
			node(sql, "shouting", { attrs: { state: "OPEN" } });
			for (const status of ["moving", "incoming", "moved", "retired"]) node(sql, status, { status, name: `secret ${status}` });
			node(sql, "done-blocker", { attrs: { state: "closed" } });
			edge(sql, "open", "blocked_by", "moving");
			edge(sql, "open", "blocked_by", "done-blocker");
			edge(sql, "incoming", "blocked_by", "open");
		});
		expect(r.items.map((i) => i.id)).toEqual(["open"]);
		expect(r.without_state).toBe(2);
		expect(item(r, "open").blocked_by).toEqual([{ id: "moving", readable: false }]);
		expect(item(r, "open").blocks).toEqual([]);
		expect(JSON.stringify(r)).not.toContain("secret");
	});

	it("never follows dst_profile: a far end elsewhere stays opaque and earns nothing", async () => {
		const r = await boardOf((sql) => {
			node(sql, "t", {});
			edge(sql, "t", "blocked_by", "elsewhere-1", { dstProfile: "work" });
			edge(sql, "t", "relates_to", "elsewhere-journal", { dstProfile: "me", recorded: 1 });
			// Written while t lived in personal; found through known.
			node(sql, "waiting", {});
			edge(sql, "waiting", "blocked_by", "t", { dstProfile: "personal" });
		}, { known: ["me", "personal", "work"] });
		const t = item(r, "t");
		expect(t.blocked_by).toEqual([{ id: "elsewhere-1", readable: false }]);
		expect(t.blocks).toEqual([{ id: "waiting", kind: "ticket", name: "waiting" }]);
		expect(t.reasons.map((x) => x.term)).toEqual(["priority", "blocking", "blocked"]);
	});

	it("stops at 200 candidates and says exactly how many it left out", async () => {
		const r = await boardOf((sql) => {
			sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 203)
				INSERT INTO nodes (id, kind, name, norm_name, attrs, status, origin, content_hash, card_hash, recorded_at, created_at, updated_at, seq)
				SELECT printf('c-%03d', i), 'ticket', 'c', 'c', '{"state":"open"}', 'active', 'upload', 'h', 'c', ?, ?, ?, 1 FROM n`, ago(30), ago(30), ago(1));
		}, { limit: 10 });
		expect(r.budget).toMatchObject({ candidates: 200, skipped: 3, exhausted: true, stopped: "candidates" });
		expect([r.total, r.items.length, r.truncated]).toEqual([200, 10, true]);
	});

	it("stops reading links at 5,000 edge rows and says so", async () => {
		const r = await boardOf((sql) => {
			node(sql, "hub", {});
			sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5100)
				INSERT INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, seq) SELECT 'ghost-' || i, 'relates_to', 'hub', '', 'identifier', ?, 'test', 1 FROM n`, ago(20));
		});
		expect(r.budget).toMatchObject({ candidates: 1, exhausted: true, stopped: "item links" });
		expect(r.budget.edges_read).toBeLessThanOrEqual(5_000);
		expect(item(r, "hub").reasons.map((x) => x.term)).toEqual(["priority"]);
	});

	it("returns the latest published strategic review with its age, and none when there is none", async () => {
		const r = await boardOf((sql) => {
			const doc = (id: string, recorded: number, attrs: Record<string, unknown>, status = "active") => node(sql, id, { kind: "document", attrs, status, recorded, updated: recorded });
			doc("review-old", 10, { kind: "strategic_review" });
			doc("review-new", 3, { kind: "strategic_review" });
			doc("review-retired", 1, { kind: "strategic_review" }, "retired");
			doc("review-moving", 1, { kind: "strategic_review" }, "moving");
			doc("review-future", -1, { kind: "strategic_review" });
			doc("plain-doc", 0, {});
		});
		expect(r.review).toEqual({ id: "review-new", name: "review-new", description: "", recorded_at: ago(3), age_days: 3 });
		const none = await boardOf(() => {});
		expect(none).toMatchObject({ as_of: AS_OF, covers_only_uploaded_data: true, items: [], total: 0, review: null, budget: { exhausted: false, stopped: null } });
	});
});

describe("work_board handler", () => {
	/** A PROFILE namespace that records every lookup and refuses it, so a refusal is proved to touch no profile. */
	const spy = () => {
		const calls: string[] = [];
		const ns = { idFromName: (n: string) => { calls.push(n); throw new Error("profile touched"); }, get: () => { calls.push("get"); throw new Error("profile touched"); } };
		return { calls, ns: ns as unknown as Env["PROFILE"] };
	};

	it("refuses a token without read scope before touching a profile", async () => {
		const { token } = await deviceToken("board-writer", ["write"], ["personal"], "personal");
		const s = spy(), c = await contextFor(devicePrincipal(token), { PROFILE: s.ns });
		const r = await workBoard(c, { profile: "personal" });
		expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(s.calls).toEqual([]);
	});

	it("refuses a profile the token may not read before touching a profile", async () => {
		const { token } = await deviceToken("board-reader", ["read"], ["personal"], "personal");
		const s = spy(), c = await contextFor(devicePrincipal(token), { PROFILE: s.ns });
		expect(await workBoard(c, { profile: "work" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await workBoard(c, { profile: "nope" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(s.calls).toEqual([]);
	});
});
