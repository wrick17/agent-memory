// Phase-2 capture lane through the real /v1/ingest and /v1/capture endpoints with a job-scoped device token.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/domain/ids";
import { call, contextFor, deviceToken, outcome } from "./helpers";

const origin = new URL(env.RESOURCE_URL).origin;
const session = { client: "codex" as const, id: "thr_fixture1" };
const RANGE = "codex:thr_fixture1:0a1b2c3d:0-5000";
const digest = (extra: Partial<{ asks: unknown[]; decisions: unknown[]; corrections: unknown[]; dropped: Record<string, number> }> = {}) => JSON.stringify({
	asks: [{ text: "Fix the refresh loop", pos: 10 }], decisions: [{ text: "Moved refresh into one client.", pos: 900 }],
	corrections: [{ text: "Use the other timeout.", pos: 1200 }], outcomes: { commits: [], prs: [], tests: [] }, entities: ["jira:SEQ-1"], dropped: { asks: 0, decisions: 0, corrections: 0 }, ...extra,
});
const part = (part_id: string, body: string, capture_status: "heuristic" | "consolidated" = "consolidated", range_id = RANGE) => ({ range_id, capture_status, part_id, sha256: sha256(body), body });

async function post(token: string, path: string, payload: unknown) {
	const res = await exports.default.fetch(new Request(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
	return { status: res.status, data: await res.json() as Record<string, unknown> & { results?: { part_id: string; status: string; reason?: string }[] } };
}

describe("capture ingest", () => {
	it("stores parts, accepts only a tiling manifest, replays the same bytes and refuses a changed part", async () => {
		const { token } = await deviceToken("capture-job", ["ingest"], ["test"], "test");
		const a = part("0-2500", digest()), b = part("2500-5000", digest({ decisions: [], corrections: [] }));
		const first = await post(token, "/v1/ingest", { session, digests: [part("-", digest(), "heuristic"), a, b] });
		expect(first.status).toBe(200);
		expect(first.data.profile).toBe("test");
		expect(first.data.results!.map((r) => r.status)).toEqual(["stored", "stored", "stored"]);
		expect((await post(token, "/v1/ingest", { session, digests: [a] })).data.results![0]!.status).toBe("replayed");
		const changed = part("0-2500", digest({ asks: [{ text: "something else", pos: 1 }] }));
		expect((await post(token, "/v1/ingest", { session, digests: [changed] })).data.results![0]).toMatchObject({ status: "refused", reason: "hash_conflict" });
		const manifest = (parts: { part_id: string; sha256: string }[]) => post(token, "/v1/ingest", { session, manifests: [{ range_id: RANGE, parts }] });
		expect((await manifest([{ part_id: "0-2500", sha256: a.sha256 }])).data.results![0]).toMatchObject({ status: "refused", reason: "not_tiled" });
		expect((await manifest([{ part_id: "0-3000", sha256: a.sha256 }, { part_id: "2500-5000", sha256: b.sha256 }])).data.results![0]!.reason).toBe("not_tiled");
		expect((await manifest([{ part_id: "0-2500", sha256: b.sha256 }, { part_id: "2500-5000", sha256: b.sha256 }])).data.results![0]!.reason).toBe("part_missing:0-2500");
		const state = await post(token, "/v1/capture", { range_ids: [RANGE] });
		expect(state.data.ranges).toEqual({ [RANGE]: { parts: [{ part_id: "0-2500", sha256: a.sha256 }, { part_id: "2500-5000", sha256: b.sha256 }], heuristic: true, consolidated: false } });
		expect((await manifest([{ part_id: "2500-5000", sha256: b.sha256 }, { part_id: "0-2500", sha256: a.sha256 }])).data.results![0]!.status).toBe("stored");
		expect((await manifest([{ part_id: "0-2500", sha256: a.sha256 }, { part_id: "2500-5000", sha256: b.sha256 }])).data.results![0]!.status).toBe("replayed");
		expect(((await post(token, "/v1/capture", { range_ids: [RANGE] })).data.ranges as Record<string, { consolidated: boolean }>)[RANGE]!.consolidated).toBe(true);
		// The heuristic digest left the capture index; the parts and their maintenance items are there; ordinary recall never sees capture text.
		const c = await contextFor();
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, s) => {
			const sql = s.storage.sql;
			expect(sql.exec("SELECT capture_status, capture_part, live FROM texts WHERE range_id = ? ORDER BY rowid", RANGE).toArray())
				.toEqual([{ capture_status: "heuristic", capture_part: "-", live: 0 }, { capture_status: "consolidated", capture_part: "0-2500", live: 1 }, { capture_status: "consolidated", capture_part: "2500-5000", live: 1 }, { capture_status: "consolidated", capture_part: "manifest", live: 0 }]);
			expect(sql.exec("SELECT kind FROM maintenance ORDER BY id").toArray().map((r) => r.kind)).toEqual(["unprocessed_capture", "preference_signal"]);
			expect(sql.exec<{ n: number }>("SELECT count(*) AS n FROM captures_fts WHERE captures_fts MATCH 'timeout'").one().n).toBe(1);
		});
		const recall = await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "Use the other timeout", profile: "test" });
		expect(recall.results).toHaveLength(0);
		const inventory = await call<{ results: { name: string }[] }>(c, "recall_memories", { keyword: "", profile: "test" });
		expect(inventory.results.some((r) => r.name.startsWith("session:"))).toBe(false);
	});

	it("links the session to the PR, ticket and commit references its digest names, keeping the literal URLs and context", async () => {
		const { token } = await deviceToken("capture-refs", ["ingest"], ["test"], "test");
		const c = await contextFor();
		type Link = { rel: string; from?: { id: string; name: string }; to?: { id: string; name: string } };
		const linkedFrom = async (key: string) => Object.values((await call<{ links: Record<string, Link[]> }>(c, "explore", { node: { key }, profile: "test" })).links).flat()
			.filter((l) => l.rel === "relates_to").map((l) => l.from?.name);
		// The PR is already known; the ticket is recorded only after the session mentions it.
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "pr", key: "github:acme/web#42", name: "Fix login timeout" }] });
		const sessionRefs = { client: "codex" as const, id: "thr_refs" };
		// The heuristic digest local/agent-memory.test.mjs builds from a synthetic transcript naming these references.
		const body = JSON.stringify({
			asks: [{ text: "Fix PROJ-123: the login page times out after 30 seconds.", pos: 0 }], decisions: [], corrections: [],
			outcomes: { commits: ["Pushed acme/web@0a1b2c3d4e with the shorter retry.", "0a1b2c3d4e"], prs: ["Opened https://github.com/acme/web/pull/42 to fix the login timeout."], tests: [] },
			entities: ["PROJ-123", "https://acme.atlassian.net/browse/PROJ-123", "https://github.com/acme/web/pull/42", "acme/web@0a1b2c3d4e"], dropped: { asks: 0, decisions: 0, corrections: 0 },
		});
		const up = part("-", body, "heuristic", "codex:thr_refs:0a1b2c3d:0-900");
		expect((await post(token, "/v1/ingest", { session: sessionRefs, digests: [up] })).data.results![0]!.status).toBe("stored");
		expect(await linkedFrom("github:acme/web#42")).toEqual(["session:codex:thr_refs"]);
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "ticket", key: "jira:PROJ-123", name: "Login page times out" }] });
		expect(await linkedFrom("jira:PROJ-123")).toEqual(["session:codex:thr_refs"]);
		// A replay links again without a duplicate; the literal references and their context stay in the capture lane, out of recall.
		expect((await post(token, "/v1/ingest", { session: sessionRefs, digests: [up] })).data.results![0]!.status).toBe("replayed");
		expect(await linkedFrom("github:acme/web#42")).toEqual(["session:codex:thr_refs"]);
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, s) => {
			const sql = s.storage.sql;
			const node = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'session:codex:thr_refs'").one().id;
			expect(sql.exec("SELECT kind, ref FROM evidence WHERE owner = ? ORDER BY ref", `n:${node}`).toArray()).toEqual([{ kind: "mention", ref: "git:acme/web@0a1b2c3" }, { kind: "mention", ref: "git:acme/web@0a1b2c3d4e" }]);
			expect(sql.exec<{ body: string }>("SELECT body FROM texts WHERE node_id = ? AND part = 'capture'", node).one().body).toBe(body);
		});
		expect((await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "login timeout", profile: "test" })).results.every((r) => !(r as { name: string }).name.startsWith("session:"))).toBe(true);
	});

	it("refuses lossy, oversized or whole-message parts, foreign ranges, me, and tokens without the ingest scope", async () => {
		const { token } = await deviceToken("capture-job-2", ["ingest"], ["test", "me"], "test");
		const range = "codex:thr_fixture2:0a1b2c3d:0-100";
		const lossy = part("0-100", digest({ dropped: { asks: 0, decisions: 1, corrections: 0 } }), "consolidated", range);
		const results = (await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_fixture2" }, digests: [
			lossy,
			part("0-100", JSON.stringify({ asks: [], decisions: [], corrections: [{ text: "x".repeat(281), pos: 0 }], outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } }), "heuristic", range),
			{ ...part("0-50", digest(), "consolidated", range), body: "x".repeat(9000), sha256: sha256("x".repeat(9000)) },
			part("0-100", digest(), "consolidated", "codex:thr_other:0a1b2c3d:0-100"),
			{ ...part("50-100", digest(), "consolidated", range), sha256: "0".repeat(64) },
		] })).data.results!;
		expect(results.map((r) => r.reason ?? r.status)).toEqual(["stored", "bad_part_id", "over_8kb", "bad_range_id", "hash_mismatch"]);
		expect((await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_fixture2" }, manifests: [{ range_id: range, parts: [{ part_id: "0-100", sha256: lossy.sha256 }] }] })).data.results![0]!.reason).toBe("part_dropped:0-100");
		expect((await post(token, "/v1/ingest", { session, profile: "me", digests: [] })).status).toBe(403);
		const { token: reader } = await deviceToken("not-a-job", ["read", "write"], ["test"], "test");
		expect((await post(reader, "/v1/ingest", { session, digests: [] })).status).toBe(403);
		expect((await post(token, "/v1/ingest", { session, digests: [{ ...part("-", digest(), "heuristic"), whole_message: "…" }] })).status).toBe(400);
	});

	// Review F1, F2 and F8 (docs/review-sol-phase2a-hosted-2026-10-28.md) and local L1, each from the reviewer's failing example.
	const empty = () => ({ asks: [], decisions: [], corrections: [], outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
	const textsOf = async (range: string) => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "test")!;
		return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, st) =>
			st.storage.sql.exec<{ body: string; sha256: string; chunk: number }>("SELECT body, sha256, chunk FROM texts WHERE range_id = ? ORDER BY rowid", range).toArray());
	};

	it("F1/L1: refuses unknown fields at any level and outcome strings over the excerpt limit, storing nothing", async () => {
		const { token } = await deviceToken("capture-strict", ["ingest"], ["test"], "test");
		const raw = "PRIVATE RAW MESSAGE ".repeat(200);
		const range = "codex:thr_strict:abcdef01:0-100";
		const bodies = [{ ...empty(), outcomes: { ...empty().outcomes, whole_message: raw } }, { ...empty(), whole_message: raw },
			{ ...empty(), outcomes: { ...empty().outcomes, tests: [raw.slice(0, 576)] } }, { ...empty(), asks: [{ text: "ask", pos: 1, raw }] }].map((b) => JSON.stringify(b));
		const r = await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_strict" }, digests: bodies.map((b, i) => part(`${i * 10}-${i * 10 + 10}`, b, "consolidated", range)) });
		expect(r.data.results!.map((x) => x.reason)).toEqual(["bad_body:outcomes", "bad_body:unrecognized_keys", "bad_body:outcomes.tests.0", "bad_body:asks.0"]);
		expect(await textsOf(range)).toEqual([]);
	});

	it("F2: stores the exact accepted bytes of an already-redacted part, refuses one that redaction would change, and completes its manifest", async () => {
		const { token } = await deviceToken("capture-redacted", ["ingest"], ["test"], "test");
		const range = "codex:redacted:abcdef01:0-100", s = { client: "codex", id: "redacted" };
		const body = JSON.stringify({ ...empty(), corrections: [{ text: "Use token=[REDACTED]", pos: 5 }] });
		const ok = part("0-100", body, "consolidated", range);
		expect((await post(token, "/v1/ingest", { session: s, digests: [ok] })).data.results![0]!.status).toBe("stored");
		const [row] = await textsOf(range);
		expect([row!.body, sha256(row!.body), row!.sha256]).toEqual([body, ok.sha256, ok.sha256]);
		const secret = part("0-50", JSON.stringify({ ...empty(), corrections: [{ text: "Use token=abc123secret", pos: 5 }] }), "consolidated", range);
		expect((await post(token, "/v1/ingest", { session: s, digests: [secret] })).data.results![0]).toMatchObject({ status: "refused", reason: "needs_redaction" });
		expect((await post(token, "/v1/ingest", { session: s, manifests: [{ range_id: range, parts: [{ part_id: "0-100", sha256: ok.sha256 }] }] })).data.results![0]!.status).toBe("stored");
	});

	it("F8: stores a valid 160-part manifest over 16,000 characters in chunks, replays it and reports the range consolidated", async () => {
		const { token } = await deviceToken("capture-large", ["ingest"], ["test"], "test");
		const id = "large_manifest", range = `codex:${id}:abcdef01:0-16000`, body = JSON.stringify(empty()), hash = sha256(body);
		const digests = Array.from({ length: 160 }, (_, i) => ({ range_id: range, capture_status: "consolidated", part_id: `${i * 100}-${(i + 1) * 100}`, sha256: hash, body }));
		for (let i = 0; i < digests.length; i += 64) expect((await post(token, "/v1/ingest", { session: { client: "codex", id }, digests: digests.slice(i, i + 64) })).data.results!.every((x) => x.status === "stored")).toBe(true);
		const parts = digests.map(({ part_id, sha256: h }) => ({ part_id, sha256: h }));
		expect(JSON.stringify({ range_id: range, parts }).length).toBeGreaterThan(16_000);
		const m = () => post(token, "/v1/ingest", { session: { client: "codex", id }, manifests: [{ range_id: range, parts }] });
		expect((await m()).data.results![0]!.status).toBe("stored");
		expect((await m()).data.results![0]!.status).toBe("replayed");
		expect(((await post(token, "/v1/capture", { range_ids: [range] })).data.ranges as Record<string, { consolidated: boolean; parts: unknown[] }>)[range]).toMatchObject({ consolidated: true });
		const chunks = (await textsOf(range)).filter((r) => r.body.startsWith("{\"parts\"") || r.chunk > 0);
		expect(chunks.length).toBeGreaterThan(1);
		expect(JSON.parse(chunks.map((r) => r.body).join("")).parts).toHaveLength(160);
	});
});

describe("capture_memory and review_candidates", () => {
	it("keeps captures out of recall until promoted, links the promoted memory, replays, and never captures into me", async () => {
		const c = await contextFor();
		const cap = await call(c, "capture_memory", { content: "Prefer the staging bucket for zeppelin uploads.", kind: "correction", name: "Bucket note", source: { session: "thr_x" }, profile: "test", request_id: "cap-1" });
		expect(cap).toMatchObject({ status: "candidate", profile: "test" });
		expect(await call(c, "capture_memory", { content: "Prefer the staging bucket for zeppelin uploads.", kind: "correction", name: "Bucket note", source: { session: "thr_x" }, profile: "test", request_id: "cap-1" })).toMatchObject({ action: "replayed", capture_id: cap.capture_id });
		expect((await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "zeppelin uploads", profile: "test" })).results).toHaveLength(0);
		const listed = await call<{ candidates: { capture_id: string; status: string; content: string }[] }>(c, "review_candidates", { action: "list", profile: "test" });
		expect(listed.candidates.find((x) => x.capture_id === cap.capture_id)).toMatchObject({ status: "pending", content: "Prefer the staging bucket for zeppelin uploads." });
		const promoted = await call(c, "review_candidates", { action: "promote", candidate_id: cap.capture_id, into: { name: "Staging bucket for uploads", type: "feedback", description: "upload bucket" }, request_id: "promote-1" });
		expect(promoted).toMatchObject({ action: "promoted", capture_id: cap.capture_id, profile: "test" });
		expect(await call(c, "review_candidates", { action: "promote", candidate_id: cap.capture_id, into: { name: "Staging bucket for uploads", type: "feedback", description: "upload bucket" }, request_id: "promote-1" })).toMatchObject({ action: "replayed" });
		expect(await outcome(c, "review_candidates", { action: "dismiss", candidate_id: cap.capture_id, reason: "late" })).toMatchObject({ ok: false, error: { details: { reason: "already_reviewed" } } });
		const memory = await call(c, "get_memory", { memory_id: promoted.memory_id });
		expect(memory).toMatchObject({ content: "Prefer the staging bucket for zeppelin uploads.", relationships: { belongs_to: "default" } });
		expect((memory.edges as { rel: string; to_id: string }[]).some((e) => e.rel === "relates_to" && e.to_id === cap.capture_id)).toBe(true);
		expect((await call<{ results: { memory_id: string }[] }>(c, "recall_memories", { keyword: "zeppelin uploads", profile: "test" })).results.map((r) => r.memory_id)).toEqual([promoted.memory_id]);
		expect((await call<{ candidates: { status: string }[] }>(c, "review_candidates", { action: "list", status: "promoted", profile: "test" })).candidates[0]).toMatchObject({ status: "promoted", promoted_to: promoted.memory_id });
		const other = await call(c, "capture_memory", { content: "noise", profile: "test" });
		expect(await outcome(c, "review_candidates", { action: "dismiss", candidate_id: other.capture_id })).toMatchObject({ ok: false, error: { details: { reason: "missing_reason" } } });
		expect(await call(c, "review_candidates", { action: "dismiss", candidate_id: other.capture_id, reason: "not useful" })).toMatchObject({ action: "dismissed" });
		expect(await outcome(c, "capture_memory", { content: "x", profile: "me" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});
});
