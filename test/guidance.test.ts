// Automatic learning ops (record_lesson, record_decision, #126) and guidance receipts (#127) on a fresh account's profile: sessions
// come in through the real capture ingest, items through the real lease and completion, guidance through the real fact report
// write path. The brief read and the Goals metric read the same tables.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/domain/ids";
import type { FactSessionReport } from "../src/domain/types";
import { ingest } from "../src/profile/capture";
import { guidanceStats, sessionRefOf } from "../src/profile/guidance";
import { complete, next } from "../src/profile/maintenance";
import { goalMetrics } from "../src/profile/metrics";
import { briefRead, projectScopes } from "../src/profile/read";
import { runWrite, type Who } from "../src/profile/write";
import { registered } from "./helpers";

const uniq = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const ctx = (who: Who, actor: "agent" | "owner" = "agent") => ({ actor, platform: "test", routedBy: "explicit", userId: who.userId, payloadHash: uniq(), deviceId: "dev-1" });
const digest = (corrections: string[]) => JSON.stringify({ asks: [{ text: "do it", pos: 1 }], decisions: [], corrections: corrections.map((text, i) => ({ text, pos: 100 + i })),
	outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
/** One consolidated capture range of a session, with its manifest: queues the session's preference_signal and capture items. */
function capture(storage: DurableObjectStorage, who: Who, id: string, corrections: string[], range = "0-5000"): string {
	const body = digest(corrections), range_id = `codex:${id}:0a1b2c3d:${range}`, sha = sha256(body);
	ingest(storage, who, { session: { client: "codex", id }, digests: [{ range_id, capture_status: "consolidated", part_id: range, sha256: sha, body }], manifests: [{ range_id, parts: [{ part_id: range, sha256: sha }] }] });
	return String(storage.sql.exec("SELECT id FROM nodes WHERE key = ?", `session:codex:${id}`).one().id);
}
/** Leases every due item (past the batch cooldown) and completes each session's items: preference_signal ops per session, others dismissed. */
function batch(storage: DurableObjectStorage, who: Who, ops: (subject: string) => Record<string, unknown>[], captureOps: (subject: string) => Record<string, unknown>[] = () => [{ op: "dismiss" }]) {
	storage.sql.exec("UPDATE cursors SET last_run_at = '2000-01-01T00:00:00.000Z' WHERE stage = 'maintenance_batch'");
	const lease = next(storage, {});
	return complete(storage, who, { lease_id: lease.lease_id!, results: lease.items.map((i) => ({ item_id: i.item_id,
		ops: (i.kind === "preference_signal" ? ops(i.subjects[0]!) : i.kind === "unprocessed_capture" ? captureOps(i.subjects[0]!) : [{ op: "dismiss" }]) as never })) }, { platform: "test", userId: who.userId, deviceId: "dev-1" });
}
/** A session report from this device that lists memory items as injected (attribution command). */
function injectReport(storage: DurableObjectStorage, who: Who, id: string, memories: string[]) {
	const args: FactSessionReport = { type: "session", repo_key: "github.com/acme/guidance", device: "dev-1", request_id: `facts2:${uniq()}`, session: sessionRefOf(`session:codex:${id}`)!,
		order: { ended_at: new Date().toISOString(), seq: 1 }, attribution: "command", families: [], injected: memories.map((m) => ({ kind: "memory" as const, memory_id: m, outcome: "unexercised" as const })), observations: [] };
	return runWrite(storage, who, { op: "fact", args }, ctx(who));
}
const lesson = (name: string, ev: string, matches?: string) => ({ op: "record_lesson", name, description: `${name} description`, why: "the mistake", how_to_apply: "do it right",
	evidence: [{ kind: "node", ref: ev }], ...(matches ? { matches } : {}) });

describe("record_lesson and record_decision (#126)", () => {
	it("creates an inferred lesson, merges a repeat into it with evidence, and never writes me", async () => {
		const p = await registered("personal", "me");
		await runInDurableObject(p.stub, (_i, st) => {
			const s1 = capture(st.storage, p.who, `a${uniq()}`, ["use tabs"]);
			const first = batch(st.storage, p.who, (s) => (s === s1 ? [lesson("Indent with tabs", s1)] : []));
			const created = first.results.flatMap((r) => (r as { ops?: { created?: string[] }[] }).ops ?? []).flatMap((o) => o.created ?? []);
			expect(created).toHaveLength(1);
			const L = created[0]!;
			expect(st.storage.sql.exec("SELECT kind, origin, scope FROM nodes WHERE id = ?", L).one()).toEqual({ kind: "rule", origin: "inferred", scope: "default" });
			const s2 = capture(st.storage, p.who, `b${uniq()}`, ["tabs again"]);
			const again = batch(st.storage, p.who, (s) => (s === s2 ? [lesson("Indent with tabs", s2, L)] : []));
			expect(again.results.flatMap((r) => (r as { ops?: unknown[] }).ops ?? [])).toContainEqual(expect.objectContaining({ op: "record_lesson", status: "applied", memory_id: L }));
			expect(st.storage.sql.exec("SELECT ref FROM evidence WHERE owner = ? AND kind = 'node' ORDER BY ref", `n:${L}`).toArray().map((r) => r.ref).sort()).toEqual([s1, s2].sort());
			const d = capture(st.storage, p.who, `c${uniq()}`, ["x"]);
			batch(st.storage, p.who, () => [], (s) => (s === d ? [{ op: "record_decision", name: "Use SQLite", description: "store in SQLite", why: "simple", evidence: [{ kind: "node", ref: d }] }] : [{ op: "dismiss" }]));
			expect(st.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'decision' AND origin = 'inferred'").one().n).toBe(1);
		});
		const me = p.of("me");
		await runInDurableObject(me.stub, (_i, st) => {
			const s = capture(st.storage, me.who, `m${uniq()}`, ["no"]);
			const out = batch(st.storage, me.who, (x) => (x === s ? [lesson("Me lesson", s)] : []));
			expect(out.results.flatMap((r) => (r as { ops?: unknown[] }).ops ?? [])).toContainEqual(expect.objectContaining({ op: "record_lesson", status: "rejected", code: "forbidden" }));
			expect(st.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'rule'").one().n).toBe(0);
		});
	});

	it("records a correction that repeats a protected lesson without flagging it, so briefs keep it (review item 6)", async () => {
		const p = await registered("personal");
		await runInDurableObject(p.stub, (_i, st) => {
			const stated = String(runWrite(st.storage, p.who, { op: "save", args: { name: "Run the linter", type: "feedback", description: "lint first", scope: "default", origin: "stated" } }, ctx(p.who, "owner")).result.memory_id);
			const s = capture(st.storage, p.who, `p${uniq()}`, ["you forgot lint"]);
			const out = batch(st.storage, p.who, (x) => (x === s ? [lesson("Run the linter", s, stated)] : []));
			expect(out.results.flatMap((r) => (r as { ops?: unknown[] }).ops ?? [])).toContainEqual({ op: "record_lesson", status: "applied", reason: "protected_match", memory_id: stated });
			expect(st.storage.sql.exec("SELECT flagged, revision FROM nodes WHERE id = ?", stated).one()).toEqual({ flagged: null, revision: 1 });
			expect(st.storage.sql.exec("SELECT count(*) AS n FROM correction_matches WHERE rule_id = ?", stated).one().n).toBe(1);
			expect(st.storage.sql.exec("SELECT count(*) AS n FROM evidence WHERE owner = ? AND ref = ?", `n:${stated}`, s).one().n).toBe(1);
		});
	});
});

describe("guidance receipts (#127)", () => {
	it("settles followed and failed per session, recounts a later range, drops a failing inferred lesson from briefs and keeps a stated one", async () => {
		const p = await registered("personal");
		await runInDurableObject(p.stub, (_i, st) => {
			const sql = st.storage.sql, repo = `guide${uniq()}`;
			const save = (name: string, origin?: "inferred") => String(runWrite(st.storage, p.who, { op: "save", args: { name, type: "feedback", kind: "rule", description: `${name} d`, why: "w", how_to_apply: "h",
				scope: "default", ...(origin ? { origin, evidence: [{ kind: "file", ref: "x.md" }] } : {}) } }, ctx(p.who)).result.memory_id);
			const L = save("Inferred lesson", "inferred"), S = save("Stated rule");
			const ids = Array.from({ length: 5 }, () => `g${uniq()}`);
			const sessions = ids.map((id) => capture(st.storage, p.who, id, ["correction"]));
			// Two reports arrive before the batch, the rest after it (late reports settle at once).
			injectReport(st.storage, p.who, ids[0]!, [L, S]);
			injectReport(st.storage, p.who, ids[1]!, [L, S]);
			batch(st.storage, p.who, (x) => { const i = sessions.indexOf(x); return i >= 0 && i < 3 ? [lesson("Inferred lesson", x, L), lesson("Stated rule", x, S)] : []; });
			for (const id of ids.slice(2)) injectReport(st.storage, p.who, id, [L, S]);
			let stats = guidanceStats(sql, [L, S]);
			expect(stats.get(L)).toMatchObject({ injected: 5, processed: 5, failed: 3, followed: 2 });
			expect(stats.get(S)).toMatchObject({ injected: 5, processed: 5, failed: 3 });
			// A later capture range of session 4 matches L: followed turns into failed there (review item 7).
			capture(st.storage, p.who, ids[3]!, ["again"], "5000-9000");
			batch(st.storage, p.who, (x) => (x === sessions[3] ? [lesson("Inferred lesson", x, L)] : []));
			stats = guidanceStats(sql, [L]);
			expect(stats.get(L)).toMatchObject({ processed: 5, failed: 4, followed_rate: 0.2 });
			// The brief: the inferred lesson (4 of 5 failed) is dropped; the stated rule stays, shown with its rate.
			sql.exec("UPDATE nodes SET scope = ? WHERE id IN (?, ?)", repo, L, S);
			const scopes = projectScopes(`https://github.com/acme/${repo}.git`);
			const b = briefRead(sql, { kind: "brief", part: "profile", repo_key: null, device: "", scopes, checkout: [] });
			expect(b.rules.map((r) => r.id)).toEqual([S]);
			expect((b.rules[0] as { guidance?: unknown }).guidance).toMatchObject({ processed: 5, failed: 3 });
		});
	});

	it("gives the Goals tab an exact repeat-correction count from correction matches", async () => {
		const p = await registered("personal");
		await runInDurableObject(p.stub, (_i, st) => {
			const sql = st.storage.sql;
			const L = String(runWrite(st.storage, p.who, { op: "save", args: { name: "Old lesson", type: "feedback", description: "d" } }, ctx(p.who)).result.memory_id);
			sql.exec("UPDATE nodes SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", L);
			const a = capture(st.storage, p.who, `r${uniq()}`, ["one", "two"]), b = capture(st.storage, p.who, `r${uniq()}`, ["three"]);
			// Session a repeats the old lesson once (of two corrections); session b learns a new one, which is no repeat.
			batch(st.storage, p.who, (x) => (x === a ? [lesson("Old lesson", x, L)] : x === b ? [lesson("Brand new", x)] : []));
			expect(sql.exec("SELECT session_id, repeat FROM correction_matches ORDER BY session_id").toArray()).toEqual([{ session_id: a, repeat: 1 }]);
			const m = goalMetrics(sql, { now: new Date().toISOString() });
			const week = m.repos.flatMap((r) => r.weeks).reduce((t, w) => ({ total: t.total + w.corrections.total, learned: t.learned + w.corrections.learned, repeats: t.repeats + w.corrections.repeats }), { total: 0, learned: 0, repeats: 0 });
			expect(week).toEqual({ total: 3, learned: 3, repeats: 1 });
		});
	});
});
