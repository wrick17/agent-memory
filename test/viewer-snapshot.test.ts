// The viewer snapshot (V1) on the real profile schema, in disposable profile objects. Rows are written straight into SQLite, so
// each count can be checked against what is stored. The /api/viewer/snapshot route is the integrator's wiring, not tested here.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/domain/ids";
import { ingest } from "../src/profile/capture";
import { OBJECT_LIMIT } from "../src/profile/housekeeping";
import { runWrite } from "../src/profile/write";
import { parseCursor } from "../src/viewer/events";
import { assembleSnapshot, profilePart } from "../src/viewer/snapshot";
import type { ProfileSnapshotPart } from "../src/viewer/types";

let n = 0;
const inProfile = <T>(fn: (sql: SqlStorage) => T, profile = "personal") =>
	runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`snap-test:${profile}:g${++n}-${Date.now()}`)), (_i, s) => fn(s.storage.sql));

const OLD = "2026-01-01T00:00:00.000Z";
const day = () => new Date().toISOString().slice(0, 10);

function node(sql: SqlStorage, id: string, kind: string, extra: Record<string, SqlStorageValue> = {}) {
	const row: Record<string, SqlStorageValue> = { id, kind, name: id, norm_name: id, status: "active", origin: "stated", content_hash: "h", card_hash: "c",
		recorded_at: OLD, created_at: OLD, updated_at: OLD, seq: 1, ...extra };
	sql.exec(`INSERT INTO nodes (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
}
const body = (asks: number, commits: string[]) => JSON.stringify({ asks: Array.from({ length: asks }, (_, i) => ({ text: `ask ${i}`, pos: i })),
	decisions: [{ text: "d", pos: 50 }], corrections: [], outcomes: { commits }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
const capture = (sql: SqlStorage, nodeId: string, range: string, part: string, status: string, text: string, live = 1) =>
	sql.exec(`INSERT INTO texts (node_id, part, revision, body, actor, created_at, live, lane, seq, range_id, capture_part, capture_status)
		VALUES (?, 'capture', 1, ?, 'index', ?, ?, 'capture', 1, ?, ?, ?)`, nodeId, text, OLD, live, range, part, status);
const activity = (sql: SqlStorage, at: string, actor: string, op: string, summary: string, targets: string[]) =>
	sql.exec("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, ?, ?, ?, ?, 1)", at, actor, op, summary, JSON.stringify(targets));

/** One profile with every kind of row the snapshot counts, plus rows it must leave out. */
function seed(sql: SqlStorage, now: string) {
	node(sql, "m1", "decision", { memory_type: "project", why: "w", revision: 3, embed_hash: "c" });
	node(sql, "m2", "rule", { memory_type: "feedback" });
	node(sql, "pref1", "preference", { memory_type: "user" });
	node(sql, "j1", "journal", { memory_type: "project", attrs: JSON.stringify({ compacted_through: 4 }) });
	node(sql, "j2", "journal", { memory_type: "project", embed_hash: "stale" });
	node(sql, "t1", "ticket", { attrs: JSON.stringify({ state: "open" }) });
	node(sql, "t2", "pr", { attrs: JSON.stringify({ state: "closed" }) });
	node(sql, "gone", "rule", { memory_type: "feedback", status: "retired", embed_hash: "c" });
	node(sql, "s1", "session", { key: "session:claude-code:a", updated_at: now, attrs: JSON.stringify({ device_id: "dev1", last_upload_at: now }) }); // uploaded now, as ingest records it
	node(sql, "s2", "session", { key: "session:codex:b", attrs: JSON.stringify({ ended: true }) });
	for (const r of [1, 2]) sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES ('m1', ?, 'saved', '{}', 'owner', ?, 1)", r, OLD);
	sql.exec("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES ('gone', 1, 'saved', '{}', 'owner', ?, 1)", OLD);
	sql.exec("INSERT INTO edges (src, rel, dst, basis, recorded_at, actor, seq) VALUES ('m1', 'relates_to', 'm2', 'identifier', ?, 'owner', 1)", OLD);
	sql.exec("INSERT INTO edges (src, rel, dst, basis, recorded_at, ended_at, actor, seq) VALUES ('m1', 'relates_to', 'pref1', 'identifier', ?, ?, 'owner', 1)", OLD, OLD);
	// s1: a live heuristic digest (2 asks, 1 decision, 1 commit). s2: its heuristic digest was superseded, so its consolidated
	// part (1 ask, 1 decision) is current. A consolidated part whose heuristic digest is still live is not current yet.
	capture(sql, "s1", "claude-code:a:0123abcd:0-100", "-", "heuristic", body(2, ["c1"]));
	capture(sql, "s1", "claude-code:a:0123abcd:0-100", "0-100", "consolidated", body(9, []));
	capture(sql, "s2", "codex:b:0123abcd:0-100", "0-100", "consolidated", body(1, []));
	capture(sql, "s2", "codex:b:0123abcd:0-100", "-", "heuristic", body(5, []), 0);
	sql.exec("INSERT INTO texts (node_id, part, revision, body, actor, created_at, seq) VALUES ('m1', 'body', 1, 'live', 'owner', ?, 1)", OLD);
	sql.exec("INSERT INTO texts (node_id, part, revision, body, actor, created_at, live, seq) VALUES ('m1', 'body', 0, 'old', 'owner', ?, 0, 1)", OLD);
	sql.exec("INSERT INTO maintenance (kind, subjects, fingerprint, state, created_at, seq) VALUES ('preference_signal', '[]', 'f1', 'open', ?, 1)", OLD);
	sql.exec("INSERT INTO maintenance (kind, subjects, fingerprint, state, created_at, seq) VALUES ('unprocessed_capture', '[]', 'f2', 'done', ?, 1)", OLD);
	activity(sql, OLD, "owner", "save", "Saved: m1", ["m1"]);
	activity(sql, now, "agent", "save", "Saved pref", ["pref1"]);
	activity(sql, now, "maintenance", "batch", "Batch done", []);
	activity(sql, now, "owner", "forget", "Forgot a purged record", ["purged-node"]);
	sql.exec("INSERT INTO recall_totals (day, recalls, tokens, seq) VALUES (?, 2, 300, 1)", day());
}

describe("viewer snapshot", () => {
	it("counts as vectors only nodes that embed: not sessions or bare entities marked equal to skip the embed stage", async () => {
		await inProfile((sql) => {
			// Every writer sets embed_hash = card_hash ("c") for a node the embed stage skips, and after a node's vector lands.
			node(sql, "sess", "session", { key: "session:codex:v", embed_hash: "c" });
			node(sql, "bare", "component", { embed_hash: "c" });
			node(sql, "described", "component", { description: "a component", embed_hash: "c" });
			node(sql, "current", "rule", { memory_type: "feedback", embed_hash: "c" });
			node(sql, "stale", "rule", { memory_type: "feedback", embed_hash: "old" });
			expect(profilePart(sql, "personal", day(), 0).usage.vectors).toBe(2);
		});
	});

	it("counts only an accepted manifest's parts, and an owner pin does not make a session running", async () => {
		const who = { userId: "snap-test", profile: "personal", generation: `g${++n}-${Date.now()}` };
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${who.profile}:${who.generation}`)), (_i, st) => {
			const sql = st.storage.sql, range = "codex:snap-m:0a1b2c3d:0-10";
			const part = (id: string, asks: number) => { const b = body(asks, []); return { range_id: range, capture_status: "consolidated" as const, part_id: id, sha256: sha256(b), body: b }; };
			const whole = part("0-10", 1), a = part("0-5", 4), b = part("5-10", 4);
			expect(ingest(st.storage, who, { session: { client: "codex", id: "snap-m" }, digests: [whole, a, b],
				manifests: [{ range_id: range, parts: [{ part_id: "0-10", sha256: whole.sha256 }] }] }).map((r) => r.status)).toEqual(["stored", "stored", "stored", "stored"]);
			const id = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = 'session:codex:snap-m'").one().id;
			// One part, with its one ask and one decision; the unlisted 0-5 and 5-10 add nothing.
			const fresh = profilePart(sql, who.profile, day(), 0);
			expect(fresh.counts).toMatchObject({ observations: 2, sessions: 1, sessions_active: 1 });
			expect(fresh.layers.find((l) => l.layer === "parts")!.count).toBe(1);
			// Uploaded two hours ago, then pinned: still completed.
			const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
			sql.exec("UPDATE nodes SET updated_at = ?, attrs = CASE WHEN json_extract(attrs, '$.last_upload_at') IS NULL THEN attrs ELSE json_set(attrs, '$.last_upload_at', ?) END WHERE id = ?", earlier, earlier, id);
			sql.exec("UPDATE texts SET created_at = ? WHERE node_id = ? AND part = 'capture'", earlier, id);
			runWrite(st.storage, who, { op: "owner", args: { memory_id: id, action: "pin" } }, { actor: "owner", platform: "test", routedBy: "test", userId: who.userId, payloadHash: "snap-pin" });
			expect(profilePart(sql, who.profile, day(), 0).counts).toMatchObject({ sessions: 1, sessions_active: 0 });
		});
	});

	it("counts stored rows in one profile, with S1's current parts and active rule, and feed ids that are activity ids", () =>
		inProfile((sql) => {
			seed(sql, new Date().toISOString());
			const p = profilePart(sql, "personal", day(), 4096);
			expect(p.seq).toBe(4);
			expect(p.counts).toEqual({ memories: 5, revisions: 2, observations: 6, sessions: 2, sessions_active: 1, lessons: 1, crystals: 2,
				actions: 1, graph_nodes: 9, graph_edges: 1 });
			expect(p.usage).toEqual({ recalls_today: 2, recall_tokens_today: 300, writes_today: 3, storage_bytes: 4096, vectors: 1, lexical_documents: 1 });
			expect(p.layers).toEqual([
				{ layer: "digests", count: 1, state: "ok", waits_for: null }, { layer: "parts", count: 1, state: "ok", waits_for: null },
				{ layer: "memories", count: 5, state: "ok", waits_for: null }, { layer: "preferences", count: 1, state: "waiting", waits_for: null }]);
			expect(p.feed.map((f) => [f.id, f.kind, f.target])).toEqual([["4", "FORGET", undefined], ["3", "BATCH", undefined], ["2", "PREFERENCE", "pref1"], ["1", "MEMORY", "m1"]]);
			expect(p.feed.every((f) => !("target" in f) || typeof f.target === "string")).toBe(true);
			expect(p.recent_sessions.map((r) => [r.id, r.status])).toEqual([["s1", "active"], ["s2", "completed"]]);
		}));

	it("reads an empty profile as real zeros at seq 0, with the me layer only in me", () =>
		inProfile((sql) => {
			const p = profilePart(sql, "me", day(), 0);
			expect(p.seq).toBe(0);
			expect(Object.values(p.counts).every((v) => v === 0)).toBe(true);
			expect(p.usage).toEqual({ recalls_today: 0, recall_tokens_today: 0, writes_today: 0, storage_bytes: 0, vectors: 0, lexical_documents: 0 });
			expect(p.layers.map((l) => l.layer)).toEqual(["digests", "parts", "memories", "preferences", "me"]);
			expect(p.feed).toEqual([]);
		}, "me"));

	it("links a feed item only to a readable target of an unredacted row, as the event stream does", () =>
		inProfile((sql) => {
			node(sql, "kept", "rule", { memory_type: "feedback", status: "retired" });
			node(sql, "away", "rule", { memory_type: "feedback", status: "moved" });
			node(sql, "maybe", "preference", { memory_type: "user", status: "candidate" });
			node(sql, "wiped", "preference", { memory_type: "user" });
			activity(sql, OLD, "owner", "retire", "Retired", ["kept"]);
			activity(sql, OLD, "owner", "save", "Moved out", ["away"]);
			activity(sql, OLD, "agent", "save", "Candidate", ["maybe"]);
			activity(sql, OLD, "owner", "save", "Redacted", ["wiped"]);
			sql.exec("UPDATE activity SET redacted = 'wipe' WHERE id = 4");
			const p = profilePart(sql, "personal", day(), 0);
			expect(p.feed.map((f) => [f.id, f.kind, f.target])).toEqual([["4", "MEMORY", undefined], ["3", "MEMORY", undefined], ["2", "MEMORY", undefined], ["1", "FORGET", "kept"]]);
		}));

	it("assembles parts into the snapshot shape: summed counts, a cursor of each profile's seq, merged lists and truthful flags", async () => {
		const now = new Date().toISOString();
		const personal = await inProfile((sql) => { seed(sql, now); return profilePart(sql, "personal", day(), 4096); });
		const me = await inProfile((sql) => profilePart(sql, "me", day(), 1024), "me");
		const meta = { version: "v-test", deployed_at: now, at: now, embeddings: true, corpus: false };
		const s = assembleSnapshot([personal, me], { checks: [], devices_reporting: 0, inject_devices: 0, scheduled_devices: 0 }, meta);
		expect(Object.keys(s).sort()).toEqual(["at", "counts", "cursor", "deployed_at", "feed", "flags", "health", "layers", "profiles", "recent_sessions", "usage", "version"]);
		expect(Object.keys(s.usage).sort()).toEqual(["recall_tokens_today", "recalls_today", "storage_bytes", "storage_limit", "vectors", "writes_today"]);
		expect(parseCursor(s.cursor)).toEqual({ personal: 4, me: 0 });
		expect(s.profiles).toEqual(["personal", "me"]);
		expect(s.counts.memories).toBe(5);
		expect(s.usage).toMatchObject({ storage_bytes: 5120, storage_limit: 2 * OBJECT_LIMIT, recalls_today: 2 });
		expect(s.health).toEqual({ verdict: "ok", checks: [] });
		expect(s.recent_sessions.map((r) => [r.profile, r.id])).toEqual([["personal", "s1"], ["personal", "s2"]]);
		expect(s.feed.map((f) => f.id)).toEqual(["4", "3", "2", "1"]);
		expect(s.layers.find((l) => l.layer === "me")).toEqual({ layer: "me", count: 0, state: "ok", waits_for: null });
		expect(s.layers.find((l) => l.layer === "preferences")).toEqual({ layer: "preferences", count: 1, state: "waiting", waits_for: "a batch run (agent-memory run)" });
		// No device has reported, so device-backed features are inactive, not off; sessions exist, so capture is inactive too.
		expect(s.flags.map((f) => [f.id, f.state])).toEqual([["embeddings", "on"], ["corpus", "off"], ["capture", "inactive"], ["inject", "inactive"], ["scheduled_batch", "inactive"]]);
		const TABS = ["overview", "memories", "lessons", "crystals", "graph", "sessions", "actions", "replay", "activity", "profile", "health", "audit"];
		expect(s.flags.flatMap((f) => f.tabs).every((t) => TABS.includes(t))).toBe(true);

		// Without the me profile there is no me layer; with reporting devices the flags read their counts.
		const only = assembleSnapshot([personal] as ProfileSnapshotPart[], { checks: [{ check_id: "batch_overdue", subject: "personal", state: "warn", detail: "d", at: now }],
			devices_reporting: 2, inject_devices: 0, scheduled_devices: 1 }, meta);
		expect(only.layers.map((l) => l.layer)).toEqual(["digests", "parts", "memories", "preferences"]);
		expect(only.health.verdict).toBe("warn");
		expect(only.layers.find((l) => l.layer === "preferences")!.waits_for).toBe("the next scheduled batch");
		expect(only.flags.map((f) => [f.id, f.state])).toEqual([["embeddings", "on"], ["corpus", "off"], ["capture", "on"], ["inject", "off"], ["scheduled_batch", "on"]]);
		expect(only.usage.storage_limit).toBe(OBJECT_LIMIT);
	});
});
