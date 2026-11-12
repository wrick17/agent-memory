// Phase-2 capture lane through the real /v1/ingest and /v1/capture endpoints with a job-scoped device token.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RecallHit } from "../src/domain/types";
import { sha256 } from "../src/domain/ids";
import { call, contextFor, deviceToken, OWNER, outcome } from "./helpers";
import { captureProjectKey, ingest, type IngestBatch } from "../src/profile/capture";
import { learningFor } from "../src/profile/lessons";
import { runWrite } from "../src/profile/write";
import { listSessions, sessionDetail } from "../src/profile/sessions";
import { mergeSessions, parseSessionsCursor } from "../src/sessions";
import type { SessionRow } from "../src/viewer/types";

type CaptureRecall = { results: RecallHit[]; next_cursor: string | null; estimated_tokens: number; lexical_only: boolean };

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
		const opted = await call<CaptureRecall>(c, "recall_memories", { keyword: "Use the other timeout", profile: "test", include_captures: true });
		expect(opted.results).toHaveLength(1);
		expect(opted.results[0]).toMatchObject({ profile: "test", kind: "session", type: null, name: "session:codex:thr_fixture1",
			trust: "untrusted", instruction_authority: false, provenance: { source_hash: a.sha256 } });
		expect(opted.results[0]!.passage).toContain("Use the other timeout.");
		expect(opted.results[0]!.passage.length).toBeLessThanOrEqual(706);
		expect(opted.results[0]!.matched_by).toContain("fulltext");
		const exact = await call<CaptureRecall>(c, "recall_memories", { keyword: "session:codex:thr_fixture1", profile: "test", include_captures: true });
		expect(exact.results.map((r) => r.memory_id)).toEqual([opted.results[0]!.memory_id]);
		for (const filter of [{ type: "feedback" }, { kinds: ["document"] }, { scope: "another-scope" }]) {
			expect((await call<CaptureRecall>(c, "recall_memories", { keyword: "other timeout", profile: "test", include_captures: true, ...filter })).results).toEqual([]);
		}
		const capped = await call<CaptureRecall>(c, "recall_memories", { keyword: "other timeout", profile: "test", include_captures: true, token_budget: 64 });
		expect(capped.results).toEqual([]);
		expect(capped.estimated_tokens).toBeLessThanOrEqual(64);
		const inventory = await call<{ results: { name: string }[] }>(c, "recall_memories", { keyword: "", profile: "test" });
		expect(inventory.results.some((r) => r.name.startsWith("session:"))).toBe(false);
	});

	it("recalls only digest context stored by the historical cutoff, including a superseded heuristic", async () => {
		const c = await contextFor(undefined, { EMBEDDINGS: "off" });
		const { token } = await deviceToken("capture-recall-history", ["ingest"], ["test"], "test");
		// Storage lasts for the whole file, so this case owns its session and range instead of the first case's fixture.
		const session = { client: "codex" as const, id: "thr_history" }, range = "codex:thr_history:0a1b2c3d:0-5000";
		const tick = async () => { await new Promise((r) => setTimeout(r, 5)); const at = new Date().toISOString(); await new Promise((r) => setTimeout(r, 5)); return at; };
		const before = await tick();
		const early = part("-", digest({ asks: [], decisions: [], corrections: [{ text: "earlykestrel uses the old timeout.", pos: 1 }] }), "heuristic", range);
		expect((await post(token, "/v1/ingest", { session, digests: [early] })).data.results![0]!.status).toBe("stored");
		const heuristicCut = await tick();
		const late = part("0-5000", digest({ asks: [], decisions: [], corrections: [{ text: "latekestrel uses the corrected timeout.", pos: 1 }] }), "consolidated", range);
		expect((await post(token, "/v1/ingest", { session, digests: [late], manifests: [{ range_id: range, parts: [{ part_id: late.part_id, sha256: late.sha256 }] }] })).data.results!.map((r) => r.status)).toEqual(["stored", "stored"]);
		const completedCut = await tick();
		const recallAt = (keyword: string, as_of: string) => call<CaptureRecall>(c, "recall_memories", { keyword, as_of, profile: "test", include_captures: true });
		expect((await recallAt("earlykestrel", before)).results).toEqual([]);
		// The same instant expressed with an offset must retain the earlier heuristic after consolidation.
		const offsetCut = new Date(Date.parse(heuristicCut) + 330 * 60_000).toISOString().replace("Z", "+05:30");
		const historical = await recallAt("earlykestrel", offsetCut);
		expect(historical.lexical_only).toBe(true);
		expect(historical.results).toHaveLength(1);
		expect(historical.results[0]).toMatchObject({ passage: expect.stringContaining("earlykestrel uses the old timeout."), provenance: { source_hash: early.sha256 }, as_of: { content_known: true } });
		expect((await recallAt("latekestrel", heuristicCut)).results).toEqual([]);
		expect((await recallAt("earlykestrel", completedCut)).results).toEqual([]);
		const completed = await recallAt("latekestrel", completedCut);
		expect(completed.results).toHaveLength(1);
		expect(completed.results[0]).toMatchObject({ passage: expect.stringContaining("latekestrel uses the corrected timeout."), provenance: { source_hash: late.sha256 } });
		expect((await call<CaptureRecall>(c, "recall_memories", { keyword: "earlykestrel", profile: "test", include_captures: true })).results).toEqual([]);
	});

	it("paginates opted-in inventory without duplicates and binds its cursor to the capture flag", async () => {
		const c = await contextFor(undefined, { EMBEDDINGS: "off" });
		const { token } = await deviceToken("capture-recall-inventory", ["ingest"], ["test"], "test");
		// Storage lasts for the whole file: this case owns its session and range, and earlier cases' sessions list before its own.
		const session = { client: "codex" as const, id: "thr_inventory" }, range = "codex:thr_inventory:0a1b2c3d:0-5000";
		const args = { keyword: "", profile: "test", limit: 1 };
		const walk = async () => {
			const pages = [await call<CaptureRecall>(c, "recall_memories", { ...args, include_captures: true })];
			while (pages.at(-1)!.next_cursor) pages.push(await call<CaptureRecall>(c, "recall_memories", { ...args, include_captures: true, cursor: pages.at(-1)!.next_cursor }));
			return pages;
		};
		const prior = (await walk()).flatMap((p) => p.results.map((r) => r.memory_id));
		const a = part("0-2500", digest(), "consolidated", range), b = part("2500-5000", digest({ decisions: [], corrections: [] }), "consolidated", range);
		expect((await post(token, "/v1/ingest", { session, digests: [a, b], manifests: [{ range_id: range, parts: [a, b].map(({ part_id, sha256 }) => ({ part_id, sha256 })) }] })).data.results!.every((r) => r.status === "stored")).toBe(true);
		const saved = await call(c, "save_memory", { name: "Ordinary inventory note", type: "reference", description: "ordinary", content: "saved memory", profile: "test" });
		const pages = await walk(), first = pages[0]!, listed = pages.flatMap((p) => p.results);
		expect(pages.slice(0, -1).every((p) => p.results.length === 1 && typeof p.next_cursor === "string")).toBe(true);
		expect(pages.at(-1)).toMatchObject({ results: [], next_cursor: null });
		expect(listed.at(-2)).toMatchObject({ kind: "session", name: "session:codex:thr_inventory", trust: "untrusted", instruction_authority: false });
		expect(listed.map((r) => r.memory_id)).toEqual([...prior, listed.at(-2)!.memory_id, saved.memory_id]);
		expect(new Set(listed.map((r) => r.memory_id)).size).toBe(listed.length);
		expect(await outcome(c, "recall_memories", { ...args, cursor: first.next_cursor })).toMatchObject({ ok: false, error: { code: "validation" } });
		const ordinary = await call<CaptureRecall>(c, "recall_memories", args);
		expect(ordinary.results.map((r) => r.memory_id)).toEqual([saved.memory_id]);
		expect(await outcome(c, "recall_memories", { ...args, include_captures: true, cursor: ordinary.next_cursor })).toMatchObject({ ok: false, error: { code: "validation" } });
		const ordinaryEnd = await call<CaptureRecall>(c, "recall_memories", { ...args, include_captures: false, cursor: ordinary.next_cursor });
		expect(ordinaryEnd.results).toEqual([]);
		expect(ordinaryEnd.next_cursor).toBeNull();
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
		const captured = await call<CaptureRecall>(c, "recall_memories", { keyword: "zeppelin uploads", profile: "test", include_captures: true });
		expect(captured.results).toHaveLength(1);
		expect(captured.results[0]).toMatchObject({ memory_id: cap.capture_id, kind: "other", status: "candidate", trust: "untrusted", instruction_authority: false,
			passage: "Prefer the staging bucket for zeppelin uploads.", provenance: { source_hash: sha256("Prefer the staging bucket for zeppelin uploads.") } });
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

describe("sessions (S1)", () => {
	it("recalls only an accepted manifest's consolidated parts, now and as of a time", async () => {
		const c = await contextFor(), ref = c.account.profiles.find((p) => p.profile === "test")!, tag = crypto.randomUUID().slice(0, 8);
		const one = (word: string) => JSON.stringify({ asks: [{ text: word, pos: 1 }], decisions: [], corrections: [], outcomes: { commits: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
		const session = await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, st) => {
			const range = `codex:rc-${tag}:0a1b2c3d:0-10`;
			const whole = part("0-10", one(`kept${tag}`), "consolidated", range), a = part("0-5", one(`dropped${tag}`), "consolidated", range), b = part("5-10", one(`dropped${tag}`), "consolidated", range);
			expect(ingest(st.storage, {} as never, { session: { client: "codex", id: `rc-${tag}` }, digests: [whole, a, b],
				manifests: [{ range_id: range, parts: [{ part_id: "0-10", sha256: whole.sha256 }] }] }).map((r) => r.status)).toEqual(["stored", "stored", "stored", "stored"]);
			return st.storage.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ?", `session:codex:rc-${tag}`).one().id;
		});
		const at = new Date(Date.now() + 1000).toISOString();
		for (const extra of [{}, { as_of: at }]) {
			const hits = async (word: string) => (await call<CaptureRecall>(c, "recall_memories", { keyword: word, profile: "test", include_captures: true, ...extra })).results.map((r) => r.memory_id);
			// The session is recalled by its listed part only. Other records the shared test profile holds may still match a word
			// through the vector channel (the test fakes hash words into 63 buckets), so the check is on the session itself.
			expect(await hits(`kept${tag}`), JSON.stringify(extra)).toContain(session);
			expect(await hits(`dropped${tag}`), JSON.stringify(extra)).not.toContain(session);
		}
	});

	const S1 = "codex:s1-main:0a1b2c3d", body = (asks: [string, number][], decisions: [string, number][], commits: string[] = [], entities: string[] = []) => JSON.stringify({
		asks: asks.map(([text, pos]) => ({ text, pos })), decisions: decisions.map(([text, pos]) => ({ text, pos })), corrections: [], outcomes: { commits }, entities, dropped: { asks: 0, decisions: 0, corrections: 0 } });
	const p1 = body([["First ask", 10]], [["Pick the queue", 900]]), p2 = body([], [["Retry twice", 3000]], ["Pushed 0a1b2c3d4e"], ["https://github.com/acme/sessions"]);

	it("stores trusted metadata, reads current digest parts in order, and pages, filters and merges", async () => {
		const c = await contextFor();
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "project", key: "github:acme/sessions", name: "Sessions project" }] });
		// A v1 body through the real endpoint: no ended and no files count; the device comes from the job token.
		const { id: device, token } = await deviceToken("s1-job", ["ingest"], ["test"], "test");
		expect((await post(token, "/v1/ingest", { session: { client: "claude-code", id: "s1-v1" }, digests: [part("-", body([["Old runner", 1]], []), "heuristic", "claude-code:s1-v1:0a1b2c3d:0-10")] })).status).toBe(200);
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const ids = await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, st) => {
			const sql = st.storage.sql, run = (b: IngestBatch) => ingest(st.storage, {} as never, b).map((r) => r.status);
			// Earlier tests in this file share the profile; assertions look only at this test's sessions.
			const mine = (rows: SessionRow[]) => rows.map((r) => r.session).filter((x) => x.startsWith("s1-"));
			const main = { client: "codex" as const, id: "s1-main" };
			// A direct ingest with no token device, as a session stored before v2: its device stays unknown.
			expect(run({ session: { client: "claude-code", id: "s1-legacy" }, digests: [part("-", body([["Legacy ask", 1]], []), "heuristic", "claude-code:s1-legacy:0a1b2c3d:0-10")], manifests: [] })).toEqual(["stored"]);
			// The later range arrives first; its heuristic digest is current until a manifest supersedes it.
			expect(run({ session: { ...main, files_changed: 3 }, device_id: "dev_a", digests: [part("-", body([["Later ask", 6000]], []), "heuristic", `${S1}:5000-9000`)], manifests: [] })).toEqual(["stored"]);
			const a = part("0-2500", p1, "consolidated", `${S1}:0-5000`), b = part("2500-5000", p2, "consolidated", `${S1}:0-5000`);
			expect(run({ session: { ...main, files_changed: 2 }, device_id: "dev_b", digests: [part("-", body([["Superseded ask", 5]], []), "heuristic", `${S1}:0-5000`), a, b],
				manifests: [{ range_id: `${S1}:0-5000`, parts: [{ part_id: "0-2500", sha256: a.sha256 }, { part_id: "2500-5000", sha256: b.sha256 }] }] })).toEqual(["stored", "stored", "stored", "stored"]);
			const project = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'github:acme/sessions'").one().id;
			const row = () => listSessions(sql, { client: "codex" }).rows[0]!;
			const before = row();
			expect(before).toMatchObject({ client: "codex", session: "s1-main", device: "dev_b", project, status: "active", first_ask: "First ask",
				counts: { asks: 2, decisions: 2, corrections: 0, outcomes: 1, parts: 2, files_changed: 3 } });
			// A replay with ended and a lower count: ended sticks, the count and device stay, and the upload time does not move.
			expect(run({ session: { ...main, ended: true, files_changed: 1 }, device_id: "dev_c", digests: [a], manifests: [] })).toEqual(["replayed"]);
			expect(row()).toMatchObject({ status: "completed", device: "dev_b", last_upload_at: before.last_upload_at, first_upload_at: before.first_upload_at, counts: { files_changed: 3 } });
			// A digest-free SessionEnd batch ends a session it does not upload to.
			const other = { client: "codex" as const, id: "s1-other" };
			run({ session: other, digests: [part("-", body([["Other ask", 2]], []), "heuristic", "codex:s1-other:0a1b2c3d:0-10")], manifests: [] });
			expect(run({ session: { ...other, ended: true }, digests: [], manifests: [] })).toEqual([]);
			expect(mine(listSessions(sql, { status: "completed" }).rows).sort()).toEqual(["s1-main", "s1-other"]);
			expect(mine(listSessions(sql, { status: "active" }).rows).sort()).toEqual(["s1-legacy", "s1-v1"]);
			const named = (session: string) => listSessions(sql, { client: "claude-code", limit: 100 }).rows.find((r) => r.session === session)!;
			const old = named("s1-legacy");
			expect(old).toMatchObject({ device: null, status: "active", counts: { files_changed: null, parts: 0 } });
			expect(named("s1-v1")).toMatchObject({ device, status: "active", counts: { files_changed: null, parts: 0 } });
			// Events: range start, then part span, then position; outcomes after their part's items; order only, no time.
			const d = sessionDetail(sql, before.id)!;
			expect(d.events.map((e) => [e.i, e.kind, e.label, e.offset_ms, e.detail])).toEqual([
				[0, "ask", "First ask", null, { part: "0-2500", pos: "10" }], [1, "decision", "Pick the queue", null, { part: "0-2500", pos: "900" }],
				[2, "decision", "Retry twice", null, { part: "2500-5000", pos: "3000" }], [3, "outcome", "Pushed 0a1b2c3d4e", null, { part: "2500-5000", outcome: "commit" }],
				[4, "ask", "Later ask", null, { part: "-", pos: "6000" }]]);
			expect(sessionDetail(sql, old.id)!.events).toHaveLength(1);
			expect(sessionDetail(sql, project)).toBeNull();
			// Filters and pages.
			expect(listSessions(sql, { project }).rows.map((r) => r.session)).toEqual(["s1-main"]);
			expect(listSessions(sql, { project: "github:acme/sessions" }).rows.map((r) => r.session)).toEqual(["s1-main"]);
			const seen: string[] = [];
			for (let cursor: string | undefined, n = 0; n < 50; n++) {
				const page = listSessions(sql, { limit: 1, ...(cursor ? { cursor } : {}) });
				seen.push(...page.rows.map((r) => r.session));
				if (!page.next_cursor) break;
				cursor = page.next_cursor;
			}
			const all = listSessions(sql, {}).rows.map((r) => r.session);
			expect(seen).toEqual(all);
			expect(mine(listSessions(sql, {}).rows)).toHaveLength(4);
			expect(() => listSessions(sql, { cursor: "not-a-cursor" })).toThrow("cursor is not valid");
			// Two profiles over the same rows: every (profile, id) appears once, newest first, until both cursors end.
			const merged: { profile: string; at: string }[] = [];
			let cursors: Record<string, string> = {};
			for (let n = 0; n < 50; n++) {
				const page = mergeSessions(["test", "work"].map((profile) => ({ profile, page: listSessions(sql, { limit: 2, ...(cursors[profile] ? { cursor: cursors[profile] } : {}) }) })), 2);
				merged.push(...page.rows.map((r) => ({ profile: `${r.profile}:${r.session}`, at: r.last_upload_at })));
				if (!page.next_cursor) break;
				cursors = parseSessionsCursor(page.next_cursor)!;
			}
			expect(new Set(merged.map((m) => m.profile)).size).toBe(2 * all.length);
			expect(merged).toHaveLength(2 * all.length);
			expect(merged.map((m) => m.at)).toEqual([...merged.map((m) => m.at)].sort().reverse());
			return { main: before.id };
		});
		expect(parseSessionsCursor("e30")).toBeNull();
		expect(parseSessionsCursor(btoa(JSON.stringify({ test: "garbage" })))).toBeNull();
		// Records citing the session by key or by its node are produced from it; the session's own mention rows are not.
		await call(c, "save_memory", { profile: "test", name: "Queue retry rule", type: "feedback", description: "Retry the queue twice", content: "Retry twice.", evidence: [{ kind: "session", ref: "session:codex:s1-main" }] });
		await call(c, "save_memory", { profile: "test", name: "Queue pick", type: "reference", description: "Queue chosen in a session", content: "The queue.", evidence: [{ kind: "node", ref: ids.main }] });
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, st) => {
			const produced = sessionDetail(st.storage.sql, ids.main)!.produced;
			expect(produced.map((p) => [p.title, p.via]).sort()).toEqual([["Queue pick", "evidence"], ["Queue retry rule", "evidence"]]);
		});
	});

	it("reads only the manifest's parts, and keeps the last upload apart from owner actions", async () => {
		const c = await contextFor(), ref = c.account.profiles.find((p) => p.profile === "test")!;
		const one = (ask: string) => JSON.stringify({ asks: [{ text: ask, pos: 1 }], decisions: [], corrections: [], outcomes: { commits: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, st) => {
			const sql = st.storage.sql, run = (b: IngestBatch) => ingest(st.storage, {} as never, b).map((r) => r.status);
			// Overlapping consolidated parts are all stored; the accepted manifest selects 0-10 alone.
			const tiling = { client: "codex" as const, id: "s1-tiling" }, range = "codex:s1-tiling:0a1b2c3d:0-10";
			const whole = part("0-10", one("Whole range"), "consolidated", range), a = part("0-5", one("First half"), "consolidated", range), b = part("5-10", one("Second half"), "consolidated", range);
			expect(run({ session: tiling, digests: [whole, a, b], manifests: [{ range_id: range, parts: [{ part_id: "0-10", sha256: whole.sha256 }] }] })).toEqual(["stored", "stored", "stored", "stored"]);
			const t = listSessions(sql, { client: "codex", limit: 100 }).rows.find((r) => r.session === "s1-tiling")!;
			expect(sessionDetail(sql, t.id)!.events.map((e) => e.label)).toEqual(["Whole range"]);
			expect(t.counts).toMatchObject({ asks: 1, parts: 1 });
			// An owner action is not an upload: pinning a session last uploaded two hours ago keeps it completed, in place, with that time.
			const pinned = { client: "codex" as const, id: "s1-pinned" };
			expect(run({ session: pinned, digests: [part("-", one("Pinned ask"), "heuristic", "codex:s1-pinned:0a1b2c3d:0-10")], manifests: [] })).toEqual(["stored"]);
			const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
			const id = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'session:codex:s1-pinned'").one().id;
			// As if that upload happened two hours ago: the node, its stored part and any recorded upload time say so.
			sql.exec("UPDATE nodes SET updated_at = ?, attrs = CASE WHEN json_extract(attrs, '$.last_upload_at') IS NULL THEN attrs ELSE json_set(attrs, '$.last_upload_at', ?) END WHERE id = ?", earlier, earlier, id);
			sql.exec("UPDATE texts SET created_at = ? WHERE node_id = ? AND part = 'capture'", earlier, id);
			const order = () => listSessions(sql, { limit: 100 }).rows.map((r) => r.id);
			const before = { row: listSessions(sql, { limit: 100 }).rows.find((r) => r.id === id)!, order: order() };
			expect(before.row).toMatchObject({ status: "completed", last_upload_at: earlier });
			for (const action of ["pin", "unpin"] as const) runWrite(st.storage, { userId: ref.userId, profile: "test", generation: ref.generation }, { op: "owner", args: { memory_id: id, action } },
				{ actor: "owner", platform: "test", routedBy: "test", userId: ref.userId, payloadHash: `owner-${action}` });
			expect(sql.exec<{ updated_at: string }>("SELECT updated_at FROM nodes WHERE id = ?", id).one().updated_at > earlier).toBe(true);
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === id)).toMatchObject({ status: "completed", last_upload_at: earlier });
			expect(order()).toEqual(before.order);
			expect(listSessions(sql, { status: "active", limit: 100 }).rows.map((r) => r.id)).not.toContain(id);
			// A real upload still moves it: a new part makes it active and newest.
			expect(run({ session: pinned, digests: [part("-", one("Pinned later"), "heuristic", "codex:s1-pinned:0a1b2c3d:10-20")], manifests: [] })).toEqual(["stored"]);
			expect(listSessions(sql, { limit: 100 }).rows[0]).toMatchObject({ id, status: "active" });
		});
	});

	it("keeps rows of a profile that the merged page did not show", () => {
		const row = (id: string, at: string): SessionRow => ({ id, client: "codex", session: id, device: null, project: null, project_key: null, workspace: null, first_upload_at: at, last_upload_at: at, status: "completed", first_ask: null,
			counts: { asks: 0, decisions: 0, corrections: 0, outcomes: 0, parts: 0, files_changed: null } });
		const page = mergeSessions([{ profile: "work", page: { rows: [row("a", "2026-11-03T00:00:00.000Z")], next_cursor: null } },
			{ profile: "personal", page: { rows: [row("b", "2026-11-01T00:00:00.000Z")], next_cursor: null } }], 1);
		expect(page.rows.map((r) => r.profile)).toEqual(["work"]);
		const cursors = parseSessionsCursor(page.next_cursor!)!;
		expect(cursors.work).toBe("end");
		expect(cursors.personal).not.toBe("end");
		expect(mergeSessions([{ profile: "work", page: { rows: [], next_cursor: null } }], 5).next_cursor).toBeNull();
	});
});

describe("capture project tagging", () => {
	const nodeOf = (id: string) => sha256(`session:codex:${id}`).slice(0, 32);
	const heuristic = (id: string, start: number) => part("-", digest(), "heuristic", `codex:${id}:0a1b2c3d:${start}-${start + 100}`);
	const inProfile = async <T>(profile: string, fn: (sql: SqlStorage) => T) => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === profile)!;
		return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)), (_i, s) => fn(s.storage.sql));
	};

	it("normalizes project keys and refuses fixtures and malformed keys", () => {
		expect(captureProjectKey("github:Owner/Repo.git")).toBe("github:owner/repo");
		expect(captureProjectKey(" github:wrick17/agent-memory ")).toBe("github:wrick17/agent-memory");
		expect(captureProjectKey("github:wrick17/test-utils")).toBe("github:wrick17/test-utils");
		for (const bad of ["github:am-accept-refs-59c5/synthetic-repo", "github:wrick17/am-accept-x", "github:fixture/v1", "github:o/dashboard-smoke", "github:wrick17/bothq",
			"github:openai/codex", "github.com/owner/repo", "github:owner", "github:owner/repo/extra", "github:-bad/repo", "github:o/..", undefined, ""]) expect(captureProjectKey(bad)).toBeNull();
	});

	it("links a session to its project once, creates the node only when absent, and its lessons and decisions inherit it", async () => {
		const { token } = await deviceToken("capture-tag", ["ingest"], ["test"], "test");
		const id = "thr_tag1", s = { client: "codex" as const, id };
		const first = await post(token, "/v1/ingest", { session: s, repo: { remote: "git@github.com:Owner-X/Repo.One.git", path: "/w/repo" }, project: "github:Owner-X/Repo.One", workspace: "Apps", digests: [heuristic(id, 0)] });
		expect(first.status).toBe(200);
		expect((await post(token, "/v1/ingest", { session: s, project: "github:owner-x/repo.one", workspace: "apps", digests: [heuristic(id, 100)] })).status).toBe(200);
		await inProfile("test", (sql) => {
			const project = sql.exec<{ id: string; key: string; name: string; kind: string }>("SELECT id, key, name, kind FROM nodes WHERE key = 'github:owner-x/repo.one'").toArray();
			expect(project).toEqual([expect.objectContaining({ key: "github:owner-x/repo.one", name: "owner-x/repo.one", kind: "project" })]);
			expect(sql.exec("SELECT rel, basis, actor FROM edges WHERE src = ? AND dst = ?", nodeOf(id), project[0]!.id).toArray()).toEqual([{ rel: "part_of", basis: "judgment", actor: "index" }]);
			expect(sql.exec<{ n: number }>("SELECT count(*) AS n FROM activity WHERE op = 'knowledge' AND targets LIKE ?", `%${project[0]!.id}%`).one().n).toBe(1);
			const row = listSessions(sql, { project: "github:owner-x/repo.one" }).rows;
			expect(row).toEqual([expect.objectContaining({ id: nodeOf(id), project: project[0]!.id, project_key: "github:owner-x/repo.one", workspace: "apps" })]);
			expect(sessionDetail(sql, nodeOf(id))!.produced).toEqual([]);
			const learned = learningFor(sql, [nodeOf(id)]);
			expect([learned.project?.id, learned.scope]).toEqual([project[0]!.id, "repo.one"]);
		});
	});

	it("reuses an existing project node without rewriting it, and skips a fixture key", async () => {
		const c = await contextFor();
		await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "project", key: "github:Acme/Widget", name: "Widget", description: "Owner's own text." }] });
		const { token } = await deviceToken("capture-tag2", ["ingest"], ["test"], "test");
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_tag2" }, project: "github:acme/widget", digests: [heuristic("thr_tag2", 0)] });
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_tag3" }, project: "github:am-accept-refs-59c5/synthetic-repo", digests: [heuristic("thr_tag3", 0)] });
		await inProfile("test", (sql) => {
			expect(sql.exec("SELECT name, description, revision FROM nodes WHERE key = 'github:Acme/Widget'").toArray()).toEqual([{ name: "Widget", description: "Owner's own text.", revision: 1 }]);
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_tag2"))).toMatchObject({ project_key: "github:Acme/Widget", workspace: null });
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_tag3"))).toMatchObject({ project: null, project_key: null });
			expect(sql.exec("SELECT 1 FROM nodes WHERE key LIKE 'github:am-accept%' COLLATE NOCASE").toArray()).toEqual([]);
		});
	});

	type Store = { ingest(who: unknown, batch: IngestBatch): Promise<{ ok: boolean }>; access(who: unknown, ids?: string[]): Promise<void>; register(who: unknown, ids: string[]): Promise<void> };
	const onStore = async <T>(profile: string, fn: (store: Store, storage: DurableObjectStorage, who: { userId: string; profile: string; generation: string }) => Promise<T> | T) => {
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === profile)!;
		const who = { userId: ref.userId, profile, generation: ref.generation };
		return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${profile}:${ref.generation}`)), (i, st) => fn(i as unknown as Store, st.storage, who));
	};
	const batchOf = (id: string, project: string, start = 0): IngestBatch => ({ session: { client: "codex", id }, project, digests: [heuristic(id, start)], manifests: [] });

	it("links an owner's project created while the link awaited the account, without overwriting it or adding a second one", async () => {
		await onStore("test", async (store, storage, who) => {
			const access = store.access.bind(store);
			store.access = async (w, ids = []) => {
				await access(w, ids);
				// The owner's record_knowledge lands during the link's account call, under another key casing.
				if (ids.length) runWrite(storage, who, { op: "knowledge", args: { nodes: [{ kind: "project", key: "github:Race/Repo", name: "Race Repo", description: "Owner's text." }] } },
					{ actor: "owner", platform: "test", routedBy: "test", userId: who.userId, payloadHash: "owner-race" });
			};
			try { expect((await store.ingest(who, batchOf("thr_race", "github:race/repo"))).ok).toBe(true); } finally { store.access = access; }
			const sql = storage.sql;
			expect(sql.exec("SELECT key, name, description, revision FROM nodes WHERE key = 'github:race/repo' COLLATE NOCASE").toArray())
				.toEqual([{ key: "github:Race/Repo", name: "Race Repo", description: "Owner's text.", revision: 1 }]);
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_race"))).toMatchObject({ project_key: "github:Race/Repo" });
			expect(sql.exec("SELECT 1 FROM profile_meta WHERE key LIKE 'capture-register:%'").toArray()).toEqual([]);
		});
	});

	it("retries a created project's registration on a later batch after it failed past the commit", async () => {
		const indexed = (id: string) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => st.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).toArray());
		const project = await onStore("test", async (store, storage, who) => {
			const register = store.register.bind(store);
			store.register = async () => { throw new Error("account unavailable"); };
			try { expect((await store.ingest(who, batchOf("thr_reg", "github:owner/registered"))).ok).toBe(true); } finally { store.register = register; }
			const id = storage.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'github:owner/registered'").one().id;
			expect(storage.sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = ?", `capture-register:${id}`).one().value).toMatch(/^\d{4}-\d\d-\d\dT\S+Z [0-9a-f-]{36}$/);
			return id;
		});
		expect(await indexed(project)).toEqual([]);
		// The session's edge already exists, so this batch links nothing; the obligation is retried anyway.
		await onStore("test", (store, _st, who) => store.ingest(who, batchOf("thr_reg", "github:owner/registered", 100)));
		expect(await indexed(project)).toEqual([{ profile: "test" }]);
		expect(await inProfile("test", (sql) => sql.exec("SELECT 1 FROM profile_meta WHERE key LIKE 'capture-register:%'").toArray())).toEqual([]);
	});

	it("never lets a drain that began earlier clear an obligation written while it awaited the account", async () => {
		const indexed = (id: string) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => st.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).toArray());
		const pending = (storage: DurableObjectStorage) => storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key LIKE 'capture-register:%' ORDER BY key").toArray();
		const x = await onStore("test", async (store, storage, who) => {
			const register = store.register.bind(store), sql = storage.sql;
			const keyOf = (k: string) => sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ?", k).one().id;
			store.register = async () => { throw new Error("account unavailable"); };
			try {
				// X and Y are created, and both registrations fail. Undo removes X but leaves its row.
				await store.ingest(who, batchOf("thr_x1", "github:owner/stale-x"));
				await store.ingest(who, batchOf("thr_y", "github:owner/stale-y"));
				const xId = keyOf("github:owner/stale-x"), yId = keyOf("github:owner/stale-y");
				const undo = sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'knowledge' AND targets LIKE ? ORDER BY id DESC LIMIT 1", `%${xId}%`).one().id;
				runWrite(storage, who, { op: "undo", args: { activity_id: undo, request_id: "undo-stale-x" } }, { actor: "owner", platform: "test", routedBy: "test", userId: who.userId, payloadHash: "undo-stale-x" });
				expect(pending(storage).map((r) => r.key)).toEqual([`capture-register:${xId}`, `capture-register:${yId}`].sort());
				// Capture A drains Y. While it awaits the account, capture B recreates X for another session, and B's registration fails.
				let calls = 0;
				store.register = async (w, ids) => {
					if (++calls > 1) throw new Error("account unavailable");
					expect(ids).toEqual([yId]);
					expect(pending(storage).map((r) => r.key)).toEqual([`capture-register:${yId}`]);
					await store.ingest(who, batchOf("thr_x2", "github:owner/stale-x"));
					expect(sql.exec("SELECT status FROM nodes WHERE id = ?", xId).toArray()).toEqual([{ status: "active" }]);
					return register(w, ids);
				};
				await store.ingest(who, { session: { client: "codex", id: "thr_a" }, digests: [heuristic("thr_a", 0)], manifests: [] });
				expect(calls).toBeGreaterThan(1);
				expect(pending(storage).map((r) => r.key)).toEqual([`capture-register:${xId}`]);
				return xId;
			} finally { store.register = register; }
		});
		expect(await indexed(x)).toEqual([]);
		await onStore("test", (store, _st, who) => store.ingest(who, { session: { client: "codex", id: "thr_a" }, digests: [heuristic("thr_a", 100)], manifests: [] }));
		expect(await indexed(x)).toEqual([{ profile: "test" }]);
		expect(await inProfile("test", (sql) => sql.exec("SELECT 1 FROM profile_meta WHERE key LIKE 'capture-register:%'").toArray())).toEqual([]);
	});

	it("undoes a tagging link and its new project, keeps the undo on the session's next batch, and never links across profiles or into me", async () => {
		const { token } = await deviceToken("capture-tag5", ["ingest"], ["test", "work", "me"], "test");
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_undo" }, project: "github:owner/undone", digests: [heuristic("thr_undo", 0)] });
		await onStore("test", (_s, storage, who) => {
			const sql = storage.sql, activity = sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'knowledge' ORDER BY id DESC LIMIT 1").one().id;
			runWrite(storage, who, { op: "undo", args: { activity_id: activity, request_id: "undo-capture-tag" } }, { actor: "owner", platform: "test", routedBy: "test", userId: who.userId, payloadHash: "undo-capture-tag" });
			expect(sql.exec("SELECT 1 FROM nodes WHERE key = 'github:owner/undone' AND status = 'active'").toArray()).toEqual([]);
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_undo"))).toMatchObject({ project: null, project_key: null });
		});
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_undo" }, project: "github:owner/undone", digests: [heuristic("thr_undo", 100)] });
		expect(await inProfile("test", (sql) => listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_undo"))?.project)).toBeNull();
		// The same key in work gets work's own project; no edge points into another profile.
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_cross" }, profile: "work", project: "github:acme/widget", digests: [heuristic("thr_cross", 0)] });
		await inProfile("work", (sql) => {
			const id = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'github:acme/widget'").one().id;
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_cross"))?.project).toBe(id);
			expect(sql.exec("SELECT 1 FROM edges WHERE dst_profile <> ''").toArray()).toEqual([]);
		});
		const me = await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_me" }, profile: "me", project: "github:owner/app", digests: [heuristic("thr_me", 0)] });
		expect(me.status).toBe(403);
	});

	it("keeps an old client's batch untagged, gives a workspace-only session the workspace scope, and guards me with a new work project", async () => {
		const { token } = await deviceToken("capture-tag4", ["ingest"], ["test", "work"], "test");
		expect((await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_old" }, repo: { remote: "https://github.com/o/r", path: "/w" }, digests: [heuristic("thr_old", 0)] })).status).toBe(200);
		await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_ws" }, workspace: "sequoia", digests: [heuristic("thr_ws", 0)] });
		expect((await post(token, "/v1/ingest", { session: { client: "codex", id: "thr_work" }, profile: "work", project: "github:sequoia-engineering/kernel-tag-frontend", digests: [heuristic("thr_work", 0)] })).data.profile).toBe("work");
		await inProfile("test", (sql) => {
			expect(listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_old"))).toMatchObject({ project: null, project_key: null, workspace: null });
			expect(learningFor(sql, [nodeOf("thr_old")]).scope).toBe("default");
			expect(learningFor(sql, [nodeOf("thr_ws")])).toMatchObject({ project: null, scope: "sequoia" });
		});
		expect(await inProfile("work", (sql) => listSessions(sql, { limit: 100 }).rows.find((r) => r.id === nodeOf("thr_work"))?.project_key)).toBe("github:sequoia-engineering/kernel-tag-frontend");
		expect(await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => s.storage.sql.exec<{ term: string }>("SELECT term FROM sensitive_terms WHERE term LIKE '%kernel-tag-frontend%'").toArray().map((r) => r.term)))
			.toEqual(expect.arrayContaining(["sequoia-engineering/kernel-tag-frontend"]));
	});
});
