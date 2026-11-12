// C4: the archive, undo, protection, leases, TTL, purge and dedupe, on the real profile v4 schema and through runWrite with
// the proposed wiring: write.ts takes beforeImages before the op, dispatches "undo" to revert and calls recordUndo after it,
// and types.ts gains the "undo" command, the background actors and the two error codes. Without that wiring the undo cases fail.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { requestHash, sha256 } from "../src/domain/ids";
import { foldDue, foldStep, queueFold } from "../src/profile/compact";
import { get, lexicalChannels } from "../src/profile/read";
import { readContent, readPrefix } from "../src/profile/write";
import { redactText } from "../src/domain/redact";
import type { Outcome, WriteCommand, WriteContext } from "../src/domain/types";
import { MAINTENANCE_TOOLS } from "../src/maintenance-tools";
import { archiveNode, archivePage, archiveRows, BudgetTx, purgeAfter, restoreArchived, type Row } from "../src/profile/archive";
import { cleanupPurge, housekeep, OBJECT_LIMIT, sizeLevel, type Stage } from "../src/profile/housekeeping";
import { batchStatus, complete, enqueue, finishBatch, next, nextPreview } from "../src/profile/maintenance";
import { mayChange } from "../src/profile/protect";
import { undo } from "../src/profile/undo";
import { runWrite, type Who } from "../src/profile/write";
import { nextSeq } from "../src/storage";
import { call, contextFor, devicePrincipal, deviceToken, outcome, OWNER, registered, tempDir } from "./helpers";
import { accountTransfer } from "../src/account/transfers";
import { uuid5 } from "../src/domain/ids";
import { statedFirst } from "../src/domain/rank";
import type { Caller } from "../src/domain/types";
import type { ToolContext } from "../src/mcp";
import { ownerModel } from "../src/profile/owner-model";
import type { ProfileStore } from "../src/profile/store";
import { purgeOrigin } from "../src/profile/wipe";
import { RESUME_MS } from "../src/profile/transfer";
import { driveTransfer, transferPorts } from "../src/transfer";
import { wipeAccount, wipeProfile } from "../src/wipe";
import { danglingPage, enqueueDangling } from "../src/profile/dangling";
import { flushRows, pendingRows, ROW_PAUSE } from "../src/profile/meter";
import { noteRecall } from "../src/profile/recall-stats";
import { ingest } from "../src/profile/capture";

it("embedding failures keep housekeeping running and retain the embedding retry", async () => {
	const who = (await contextFor()).account.profiles.find((p) => p.profile === "personal")!;
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${who.profile}:${who.generation}`));
	await runInDurableObject(stub, async (instance, state) => {
		const storage = state.storage;
		expect((await instance.write(who, { op: "save", args: { name: "Alarm isolation", type: "reference", description: "synthetic" } },
			{ actor: "agent", platform: "test", routedBy: "explicit", userId: who.userId, payloadHash: "alarm-isolation" })).ok).toBe(true);
		await storage.deleteAlarm();
		for (const stage of ["ttl", "dedupe", "purge", "queue"]) storage.sql.exec("INSERT INTO cursors(stage, due_at) VALUES(?, ?) ON CONFLICT(stage) DO UPDATE SET due_at=excluded.due_at", stage, stage === "queue" ? 0 : Date.now() + 86_400_000);
		const originalEnv = Reflect.get(instance, "env");
		let fail = true, calls = 0;
		Reflect.set(instance, "env", { ...env, EMBEDDINGS: "on", AI: { async run(_model: string, args: { text: string[] }) {
			calls++;
			if (fail) throw new Error("synthetic embedding outage");
			return { data: args.text.map(() => [1, 0]) };
		} }, VECTORS: { async upsert() { return {}; }, async getByIds() { return []; } } });
		try {
			await instance.alarm();
			await instance.alarm();
			expect(calls).toBe(2);
			expect(storage.sql.exec("SELECT kind FROM maintenance").toArray()).toEqual([{ kind: "weekly_review" }]);
			expect(storage.sql.exec("SELECT last_run_at FROM cursors WHERE stage='queue'").one().last_run_at).not.toBeNull();
			expect(storage.sql.exec("SELECT last_error FROM cursors WHERE stage='embed'").one().last_error).toContain("synthetic embedding outage");
			const retry = await storage.getAlarm();
			expect(retry).not.toBeNull();
			expect(retry!).toBeLessThanOrEqual(Date.now() + 60_000);
			expect(storage.sql.exec("SELECT embed_hash FROM nodes WHERE name = 'Alarm isolation'").one().embed_hash).toBeNull();
			fail = false;
			await instance.alarm();
			expect(storage.sql.exec("SELECT last_error FROM cursors WHERE stage='embed'").one().last_error).toBeNull();
		} finally {
			await storage.deleteAlarm();
			Reflect.set(instance, "env", originalEnv);
		}
	});
});

it("an alarm whose generation closes or recovers during a similarity or cleanup await writes nothing after it", async () => {
	for (const [seam, recover] of [["similar", false], ["similar_error", false], ["cleanup", false], ["cleanup", true]] as const) {
		const r = await registered();
		await runInDurableObject(r.stub, async (instance, state) => {
			const storage = state.storage, sql = storage.sql, original = Reflect.get(instance, "env");
			const ids: string[] = [];
			// With embeddings on, a save arms an immediate alarm that can start before deleteAlarm and then run alongside the alarm
			// called below; with them off it arms only the delayed one deleteAlarm removes. The cards are marked embedded below anyway.
			Reflect.set(instance, "env", { ...env, EMBEDDINGS: "off" });
			for (const name of ["late a", "late b"]) {
				const out = await instance.write(r.who, { op: "save", args: { name, type: "reference", description: "synthetic" } },
					{ actor: "owner", platform: "test", routedBy: "explicit", userId: r.who.userId, payloadHash: name });
				if (!out.ok) throw new Error(out.error.message);
				ids.push(String(out.value.memory_id));
			}
			await storage.deleteAlarm();
			sql.exec("UPDATE nodes SET embed_hash = card_hash");
			const writeSeq = Number(sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = 'write_seq'").one().value);
			sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('similar', ?, 0)", JSON.stringify({ seq: 0, id: "", mark: { seq: writeSeq, at: Date.now() - 61_000 }, pending: {}, evicted: 0 }));
			if (seam === "cleanup") sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('purge_cleanup', ?, 0)", JSON.stringify({ nodes: ["purged"], requests: ["purged-request"] }));
			for (const stage of ["ttl", "dedupe", "purge", "queue"]) sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?)", stage, stage === "queue" ? 0 : Date.now() + 86_400_000);
			// The close (or recovery) lands while the alarm awaits vector I/O; everything the object holds then must stay as it is.
			let at: unknown;
			const close = async () => {
				if (recover) await r.account((a) => a.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
				else {
					await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping'"));
					sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'wiping')");
				}
				at = ["cursors", "edges", "maintenance", "activity"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray());
			};
			Reflect.set(instance, "env", { ...env, EMBEDDINGS: seam === "cleanup" ? "off" : "on", VECTORS: {
				async getByIds(v: string[]) { await close(); if (seam === "similar_error") throw new Error("synthetic similarity failure"); return v.map((id) => ({ id, values: [1, 0] })); },
				async query() { return { matches: [{ id: `g${r.who.generation}:${ids[1]}`, score: 0.95 }] }; },
				async deleteByIds() { await close(); return {}; },
			} });
			try {
				await instance.alarm();
				expect(at, seam).toBeDefined();
				expect(["cursors", "edges", "maintenance", "activity"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray()), `${seam} ${recover}`).toEqual(at);
				const alarm = await storage.getAlarm();
				// A recovery ends, so the alarm comes back; a closed generation never does.
				if (recover) expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000); else expect(alarm).toBeNull();
			} finally {
				Reflect.set(instance, "env", original);
				await storage.deleteAlarm();
			}
		});
	}
});

const USER = "c4-test";
let n = 0;
/** A fresh, disposable profile object per test. */
async function inStore<T>(fn: (storage: DurableObjectStorage, who: Who) => T | Promise<T>, profile = "personal"): Promise<T> {
	const who = { userId: USER, profile, generation: `g${++n}-${Date.now()}` };
	return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${who.profile}:${who.generation}`)), (_i, s) => fn(s.storage, who));
}

const ctx = (who: Who): WriteContext => ({ actor: "agent", platform: "test", routedBy: "test", payloadHash: crypto.randomUUID(), userId: who.userId,
	...(who.profile === "me" ? { meGuard: { explicit: true } } : {}) });

/** One write through the real dispatcher, which stores its undo. */
function wired(storage: DurableObjectStorage, who: Who, cmd: WriteCommand): Record<string, unknown> & { activity_id: number } {
	return runWrite(storage, who, cmd, ctx(who)).result as Record<string, unknown> & { activity_id: number };
}

const undoIt = (storage: DurableObjectStorage, who: Who, activityId: number) => undo(storage, who, activityId, ctx(who));
const conflict = expect.objectContaining({ failure: expect.objectContaining({ code: "revision_conflict" }) });

const MOVED = new Set(["revision", "updated_at", "seq", "embed_hash"]);
/** Everything a reader sees, without the fields an undo moves forward (revision, updated_at, seq, embed_hash) or row ids. */
function state(sql: SqlStorage) {
	return {
		nodes: sql.exec<Row>("SELECT * FROM nodes ORDER BY id").toArray().map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !MOVED.has(k)))),
		texts: sql.exec("SELECT node_id, part, revision, seq_no, chunk, body, separator, lane FROM texts WHERE live = 1 ORDER BY node_id, part, seq_no, chunk").toArray(),
		edges: sql.exec("SELECT src, rel, dst, basis, reason, valid_to, ended_at FROM edges ORDER BY src, rel, dst").toArray(),
		evidence: sql.exec("SELECT owner, kind, ref FROM evidence WHERE owner LIKE 'n:%' ORDER BY 1, 2, 3").toArray(),
	};
}

/** A new memory gets a type and description; an update or retire passes only what it changes. */
const save = (args: Record<string, unknown>): WriteCommand => ({ op: "save", args: (args.memory_id ? args : { type: "reference", description: "d", ...args }) as never });
const ev = [{ kind: "url" as const, ref: "https://example.invalid/c4" }];

describe("archive rows (profile v4)", () => {
	it("archives a node with its texts, edges and evidence, then restores the same columns at a new seq", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const a = wired(storage, who, save({ name: "Archive me", content: "searchable zebrafish body" }));
			const b = wired(storage, who, save({ name: "Other note", content: "x" }));
			wired(storage, who, { op: "knowledge", args: { edges: [{ from: { id: b.memory_id as string }, rel: "relates_to", to: { id: a.memory_id as string }, reason: "linked for the archive check", evidence: ev }] } });
			const before = state(sql);
			const fts = () => sql.exec("SELECT count(*) AS c FROM texts_fts WHERE texts_fts MATCH 'zebrafish'").one().c;
			expect(fts()).toBe(1);
			const ids = storage.transactionSync(() => {
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
				const out = archiveNode(tx, 1, a.memory_id as string, purgeAfter(tx.now));
				// Every archive row and every tombstone carries this transaction's seq.
				expect(sql.exec("SELECT DISTINCT seq FROM archive").toArray()).toEqual([{ seq: tx.seq }]);
				expect(sql.exec("SELECT count(*) AS c FROM deleted_rows WHERE seq = ? AND tbl IN ('nodes','texts','edges','evidence','revisions')", tx.seq).one().c).toBe(out.length);
				return out;
			});
			expect(sql.exec("SELECT count(*) AS c FROM nodes WHERE id = ?", a.memory_id as string).one().c).toBe(0);
			expect(fts()).toBe(0);
			const restoreSeq = storage.transactionSync(() => {
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
				expect(restoreArchived(tx, ids).nodes).toEqual([a.memory_id]);
				return tx.seq;
			});
			const after = state(sql);
			expect(after).toEqual(before);
			expect(fts()).toBe(1);
			expect(sql.exec("SELECT count(*) AS c FROM archive").one().c).toBe(0);
			expect(sql.exec("SELECT seq, embed_hash FROM nodes WHERE id = ?", a.memory_id as string).one()).toEqual({ seq: restoreSeq, embed_hash: null });
		});
	});

	it("gives a reused edge id a fresh one and moves its evidence; a re-created node is a conflict that changes nothing", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const a = wired(storage, who, save({ name: "Edge source", content: "x" }));
			const b = wired(storage, who, save({ name: "Edge target", content: "y" }));
			const c = wired(storage, who, save({ name: "Edge third", content: "z" }));
			const link = (to: unknown) => wired(storage, who, { op: "knowledge", args: { edges: [{ from: { id: a.memory_id as string }, rel: "relates_to", to: { id: to as string }, reason: "a link for the key reuse check", evidence: ev }] } });
			const first = (link(b.memory_id) as unknown as { edges: { id: number }[] }).edges[0]!.id;
			const archived = storage.transactionSync(() => {
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
				return [...archiveRows(tx, 1, "evidence", sql.exec<Row>("SELECT * FROM evidence WHERE owner = ?", `e:${first}`).toArray(), purgeAfter(tx.now)),
					...archiveRows(tx, 1, "edges", sql.exec<Row>("SELECT * FROM edges WHERE id = ?", first).toArray(), purgeAfter(tx.now))];
			});
			// SQLite hands the freed largest id to the next edge.
			expect((link(c.memory_id) as unknown as { edges: { id: number }[] }).edges[0]!.id).toBe(first);
			storage.transactionSync(() => restoreArchived(new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString()), archived));
			const moved = sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ? AND dst = ?", a.memory_id as string, b.memory_id as string).one().id;
			expect(moved).not.toBe(first);
			expect(sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `e:${moved}`).toArray()).toEqual([{ kind: "url", ref: ev[0]!.ref }]);

			const nodeIds = storage.transactionSync(() => {
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
				return archiveNode(tx, 1, c.memory_id as string, purgeAfter(tx.now));
			});
			wired(storage, who, save({ name: "Edge third", content: "z again" }));
			const snapshot = state(sql);
			expect(() => storage.transactionSync(() => restoreArchived(new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString()), nodeIds)))
				.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "revision_conflict" }) }));
			expect(state(sql)).toEqual(snapshot);
			expect(sql.exec("SELECT count(*) AS c FROM archive").one().c).toBe(nodeIds.length);
		});
	});
});

describe("undo round trips", () => {
	it("restores the exact readable state for every op type", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const old = wired(storage, who, save({ name: "Old rule", type: "feedback", content: "old" }));
			const note = wired(storage, who, save({ name: "Note", content: "first body" }));
			const j = wired(storage, who, save({ name: "Journal", type: "project", kind: "journal", content: "" }));
			wired(storage, who, { op: "append", args: { memory_id: j.memory_id as string, content: "entry one", request_id: "c4-a1" } });
			const cap = wired(storage, who, { op: "capture", args: { content: "a captured observation" } });
			const cap2 = wired(storage, who, { op: "capture", args: { content: "another captured observation" } });
			const k = wired(storage, who, { op: "knowledge", args: { nodes: [{ kind: "component", name: "Billing", description: "first" }, { kind: "project", name: "Platform" }],
				edges: [{ from: { ref: 0 }, rel: "part_of", to: { ref: 1 }, reason: "billing belongs to the platform", evidence: ev }] } }) as unknown as { edges: { id: number }[] };
			const ops: WriteCommand[] = [
				save({ name: "New rule", type: "feedback", content: "new", supersedes: [old.memory_id] }),
				save({ memory_id: note.memory_id, new_name: "Renamed note", content: "second body", why: "changed" }),
				save({ memory_id: note.memory_id, retire: true }),
				{ op: "append", args: { memory_id: j.memory_id as string, content: "entry two", request_id: "c4-a2" } },
				save({ memory_id: j.memory_id, content: "replaced journal body" }),
				{ op: "capture", args: { content: "third capture" } },
				{ op: "candidate", args: { action: "dismiss", candidate_id: cap.capture_id as string, reason: "not useful" } },
				{ op: "candidate", args: { action: "promote", candidate_id: cap2.capture_id as string, into: { name: "Promoted", type: "reference" } } },
				{ op: "knowledge", args: { nodes: [{ kind: "component", name: "Billing", description: "second" }, { kind: "ticket", key: "jira:C4-1", name: "C4-1" }],
					edges: [{ from: { ref: 1 }, rel: "relates_to", to: { ref: 0 }, reason: "the ticket touches billing", evidence: ev }],
					end: [{ edge: k.edges[0]!.id, valid_to: "2026-10-29T00:00:00.000Z", reason: "moved out" }] } },
			];
			for (const cmd of ops) {
				const before = state(sql);
				const done = wired(storage, who, cmd);
				expect(state(sql), `${cmd.op} changed something`).not.toEqual(before);
				const undone = undoIt(storage, who, done.activity_id);
				expect(state(sql), `undo of ${cmd.op}`).toEqual(before);
				expect(sql.exec("SELECT undone_by FROM activity WHERE id = ?", done.activity_id).one().undone_by).toBe(undone.result.activity_id);
			}
		});
	});

	it("refuses a record that changed since and a wipe-redacted change; a retried undo replays", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const note = wired(storage, who, save({ name: "Drift", content: "one" }));
			const first = wired(storage, who, save({ memory_id: note.memory_id, content: "two" }));
			wired(storage, who, save({ memory_id: note.memory_id, content: "three" }));
			const snapshot = state(sql);
			expect(() => undoIt(storage, who, first.activity_id)).toThrow(conflict);
			expect(state(sql)).toEqual(snapshot);
			const last = sql.exec<{ id: number }>("SELECT max(id) AS id FROM activity").one().id;
			const done = undoIt(storage, who, last), retry = undoIt(storage, who, last);
			expect(retry.result).toMatchObject({ action: "replayed", activity_id: done.result.activity_id });
			expect(sql.exec("SELECT count(*) AS c FROM requests WHERE request_id = ?", `undo:${last}`).one().c).toBe(1);
			sql.exec("UPDATE activity SET redacted = 'wipe:test:2026-10-29' WHERE id = ?", first.activity_id);
			expect(() => undoIt(storage, who, first.activity_id)).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "undo_redacted" }) }));
		});
	});
});

describe("protection and the maintenance queue", () => {
	it("refuses stated, pinned and me nodes only to background actors", () => {
		expect(mayChange({ origin: "stated", pinned: 0 }, "maintenance", "work")).toBe("stated");
		expect(mayChange({ origin: "agent", pinned: 1 }, "keep", "work")).toBe("pinned");
		expect(mayChange({ origin: "agent", pinned: 0 }, "index", "me")).toBe("me");
		expect(mayChange({ origin: "agent", pinned: 0 }, "maintenance", "work")).toBeNull();
		expect(mayChange({ origin: "stated", pinned: 1 }, "agent", "me")).toBeNull();
	});

	it("leases at most 40 items for at most 900 s once in 20 hours, confines ops to subjects and flags protected nodes", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const a = wired(storage, who, save({ name: "Keep this", content: "same" }));
			const b = wired(storage, who, save({ name: "Stated twin", content: "same", origin: "stated" }));
			const c = wired(storage, who, save({ name: "Outsider", content: "other" }));
			enqueue(storage, [{ kind: "near_duplicate", subjects: [a.memory_id as string, b.memory_id as string] },
				...Array.from({ length: 44 }, (_, i) => ({ kind: "unlinked", subjects: [`missing-${i}`] }))]);
			enqueue(storage, [{ kind: "near_duplicate", subjects: [b.memory_id as string, a.memory_id as string] }]);
			expect(sql.exec("SELECT count(*) AS c FROM maintenance").one().c).toBe(45);
			const lease = next(storage, { limit: 100, lease_seconds: 5000 });
			expect(lease.items).toHaveLength(40);
			expect(Date.parse(lease.lease_until!) - Date.now()).toBeLessThanOrEqual(900_000);
			expect(next(storage, {})).toMatchObject({ lease_id: null, items: [], next_allowed_at: expect.any(String) });
			const item = lease.items.find((i) => i.kind === "near_duplicate")!;
			const job = { platform: "test", userId: USER };
			const stated = sql.exec("SELECT * FROM nodes WHERE id = ?", b.memory_id as string).one();
			const out = complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: item.item_id, ops: [
				{ op: "supersede", keep: a.memory_id as string, retire: [b.memory_id as string] },
				{ op: "link", from: a.memory_id as string, to: c.memory_id as string, rel: "relates_to", reason: "outside the item subjects", evidence: ev },
				{ op: "save", memory_id: a.memory_id as string, description: "tidied by the batch" },
			] }] }, job);
			expect(out.results[0]).toMatchObject({ status: "done", ops: [{ op: "supersede", status: "flagged" }, { op: "link", status: "rejected", code: "outside_subjects" }, { op: "save", status: "applied" }] });
			const flagged = sql.exec<Row>("SELECT * FROM nodes WHERE id = ?", b.memory_id as string).one();
			expect({ ...flagged, flagged: null, seq: stated.seq }).toEqual(stated);
			expect(flagged.flagged).toBe("supersede: stated");
			const flagAct = sql.exec<{ id: number; summary: string; targets: string }>("SELECT id, summary, targets FROM activity WHERE op = 'flag'").one();
			expect(flagAct).toMatchObject({ summary: "flagged instead of supersede", targets: JSON.stringify([b.memory_id]) });
			expect(sql.exec("SELECT actor FROM activity WHERE op = 'update' ORDER BY id DESC LIMIT 1").one().actor).toBe("maintenance");
			// A retried completion replays the stored, content-free outcome.
			expect(complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: item.item_id, ops: [] }] }, job).results[0]).toMatchObject({ replayed: true, status: "done" });
			undoIt(storage, who, flagAct.id);
			expect(sql.exec("SELECT flagged FROM nodes WHERE id = ?", b.memory_id as string).one().flagged).toBeNull();
			// An expired lease applies nothing and returns its items to the queue.
			sql.exec("UPDATE maintenance SET lease_until = '2000-01-01T00:00:00.000Z' WHERE state = 'leased'");
			const other = lease.items.find((i) => i.kind === "unlinked")!;
			expect(() => complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: other.item_id, ops: [{ op: "dismiss" }] }] }, job))
				.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "lease_expired" }) }));
			expect(sql.exec("SELECT count(*) AS c FROM maintenance WHERE state = 'open'").one().c).toBe(44);
		});
	});

	it("previews exactly the next normal lease (expired reopen, stuck park, cooldown) without leasing or changing anything", async () => {
		await inStore((storage) => {
			const sql = storage.sql, T0 = Date.parse("2026-11-02T00:00:00.000Z");
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(T0);
			try {
				const KINDS = ["near_duplicate", "possible_contradiction", "unlinked", "unprocessed_capture", "preference_signal", "stale_journal", "weekly_review", "dangling_link"];
				enqueue(storage, Array.from({ length: 48 }, (_, i) => ({ kind: KINDS[i % KINDS.length]!, subjects: [`missing-${i}`] })));
				// Creation order differs from id order; the special rows are among the oldest, so each is inside the first 40.
				sql.exec("UPDATE maintenance SET created_at = '2026-10-01T00:00:00.000Z' WHERE id % 3 = 0");
				const [reopen, cap, held, done] = [5, 6, 7, 8];
				sql.exec("UPDATE maintenance SET created_at = '2026-09-01T00:00:00.000Z' WHERE id IN (?, ?, ?, ?)", reopen, cap, held, done);
				sql.exec("UPDATE maintenance SET state = 'leased', lease_id = 'old', lease_until = '2026-11-01T00:00:00.000Z', attempts = 1 WHERE id = ?", reopen);
				sql.exec("UPDATE maintenance SET state = 'leased', lease_id = 'old', lease_until = '2026-11-01T00:00:00.000Z', attempts = 3 WHERE id = ?", cap);
				sql.exec("UPDATE maintenance SET state = 'leased', lease_id = 'live', lease_until = '2026-11-02T00:10:00.000Z', attempts = 1 WHERE id = ?", held);
				sql.exec("UPDATE maintenance SET state = 'done' WHERE id = ?", done);
				const snapshot = () => ({ items: sql.exec("SELECT * FROM maintenance ORDER BY id").toArray(), cursors: sql.exec("SELECT * FROM cursors ORDER BY stage").toArray(),
					meta: sql.exec("SELECT * FROM profile_meta ORDER BY 1").toArray(), activity: sql.exec("SELECT count(*) AS c FROM activity").one().c });
				const before = snapshot();
				// The documented order over open items and reopened expired leases: created_at, then id; the cap, the live lease and done are out.
				const expected = sql.exec<{ id: number }>("SELECT id FROM maintenance WHERE id NOT IN (?, ?, ?) ORDER BY created_at, id LIMIT 40", cap, held, done).toArray().map((r) => r.id);
				expect(expected).not.toEqual([...expected].sort((a, b) => a - b));

				const p = nextPreview(sql);
				expect(snapshot()).toEqual(before);
				expect(p).toMatchObject({ observation: "not_a_lease", lease_id: null, observed_at: new Date(T0).toISOString(), cooldown: { status: "open", next_allowed_at: null }, leasable_now: true, parks_as_stuck: [cap] });
				expect(p.candidates.map((c) => c.item_id)).toEqual(expected);
				expect(p.candidates.find((c) => c.item_id === reopen)).toEqual({ item_id: reopen, kind: KINDS[(reopen - 1) % KINDS.length], created_at: "2026-09-01T00:00:00.000Z",
					attempts: 1, expired_lease: true, subjects: [`missing-${reopen - 1}`] });
				expect(new Set(p.candidates.map((c) => c.kind))).toEqual(new Set(KINDS));
				// Ids, kinds, dates and counts only: no item carries a passage, context or other text.
				for (const c of p.candidates) expect(Object.keys(c).sort()).toEqual(["attempts", "created_at", "expired_lease", "item_id", "kind", "subjects"]);

				// The actual normal lease takes exactly the previewed items, in order, and parks the capped expired lease.
				const lease = next(storage, {});
				expect(lease.items.map((i) => i.item_id)).toEqual(p.candidates.map((c) => c.item_id));
				expect(sql.exec("SELECT state FROM maintenance WHERE id = ?", cap).one().state).toBe("stuck");
				expect(sql.exec("SELECT state, attempts FROM maintenance WHERE id = ?", reopen).one()).toEqual({ state: "leased", attempts: 2 });

				// Inside the cooldown the preview reports the gate and names candidates, never as leasable now; next() agrees and leases nothing.
				vi.setSystemTime(T0 + 3_600_000);
				const gatedBefore = snapshot(), g = nextPreview(sql);
				expect(snapshot()).toEqual(gatedBefore);
				expect(g).toMatchObject({ lease_id: null, cooldown: { status: "gated", next_allowed_at: new Date(T0 + 20 * 3_600_000).toISOString() }, leasable_now: false });
				expect(g.candidates.length).toBeGreaterThan(0);
				expect(next(storage, {})).toEqual({ lease_id: null, items: [], next_allowed_at: g.cooldown.next_allowed_at });
				expect(snapshot()).toEqual(gatedBefore);

				// After the cooldown the first lease and the held lease have expired: they come back as expired leases, and the next lease matches again.
				vi.setSystemTime(T0 + 20 * 3_600_000);
				const later = nextPreview(sql), expired = new Set([...lease.items.map((i) => i.item_id), held]);
				expect(later).toMatchObject({ cooldown: { status: "open" }, leasable_now: true, parks_as_stuck: [] });
				for (const c of later.candidates) expect([c.item_id, c.expired_lease]).toEqual([c.item_id, expired.has(c.item_id)]);
				expect(later.candidates.some((c) => c.item_id === held)).toBe(true);
				expect(next(storage, {}).items.map((i) => i.item_id)).toEqual(later.candidates.map((c) => c.item_id));
			} finally { vi.useRealTimers(); }
		});
	});

	it("shows the last completed lease's stored per-op outcomes as codes and ids only, read-only", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			expect(batchStatus(sql).last_completed_lease).toBeNull();
			const digest = String(wired(storage, who, save({ name: "correction digest" })).memory_id);
			enqueue(storage, [{ kind: "preference_signal", subjects: [digest] }, { kind: "unlinked", subjects: [digest] }, { kind: "weekly_review", subjects: [digest] }]);
			const lease = next(storage, {}), item = (kind: string) => lease.items.find((i) => i.kind === kind)!;
			const job = { platform: "test", userId: USER };
			complete(storage, who, { lease_id: lease.lease_id!, results: [
				{ item_id: item("preference_signal").item_id, ops: [
					{ op: "infer_preference", name: "Prefers short commits", description: "private preference text", evidence: [{ kind: "node", ref: digest }] },
					{ op: "promote_to_me", from_op: 0, company_free: true }, { op: "secret op text" } as never] },
				{ item_id: item("unlinked").item_id, ops: [{ op: "flag", node: digest, reason: "secret flag reason text" }] },
			] }, job);
			// A legacy row whose stored strings are not codes.
			sql.exec("UPDATE maintenance SET state = 'done', done_at = '2000-01-01T00:00:00.000Z', outcome = ? WHERE id = ?",
				JSON.stringify({ status: "done", ops: [{ op: "save", status: "rejected", code: "validation", reason: "legacy free text", created: ["ok-id", "not an id"] }] }), item("weekly_review").item_id);
			const before = { m: sql.exec("SELECT * FROM maintenance ORDER BY id").toArray(), c: sql.exec("SELECT * FROM cursors ORDER BY stage").toArray(), a: sql.exec("SELECT count(*) AS c FROM activity").one().c };
			const shown = batchStatus(sql).last_completed_lease!;
			expect({ m: sql.exec("SELECT * FROM maintenance ORDER BY id").toArray(), c: sql.exec("SELECT * FROM cursors ORDER BY stage").toArray(), a: sql.exec("SELECT count(*) AS c FROM activity").one().c }).toEqual(before);
			const inferred = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE kind = 'preference'").one().id;
			expect(shown).toEqual({ lease_id: lease.lease_id, items: [...lease.items].sort((a, b) => a.item_id - b.item_id).map((i) => ({ item_id: i.item_id, kind: i.kind, state: "done", done_at: expect.any(String), status: "done",
				ops: i.kind === "preference_signal" ? [{ op: "infer_preference", status: "applied", activity_id: expect.any(Number), created: [inferred] },
					{ op: "promote_to_me", status: "rejected", code: "forbidden" }, { op: "unrecognized", status: "rejected", code: "validation", reason: "op_not_allowed" }]
					: i.kind === "unlinked" ? [{ op: "flag", status: "applied", activity_id: expect.any(Number) }]
					: [{ op: "save", status: "rejected", code: "validation", reason: "unrecognized", created: ["ok-id"] }] })) });
			expect(JSON.stringify(shown)).not.toMatch(/secret|private|legacy|not an id|Prefers/);
		});
	});

	it("a correction capture's preference_signal applies an OPS_SCHEMA-shaped inference; a refused one keeps its reason code", async () => {
		const { token } = await deviceToken("infer-capture-job", ["ingest"], ["test"], "test");
		const body = JSON.stringify({ asks: [{ text: "Fix it", pos: 10 }], decisions: [], corrections: [{ text: "Use tabs, not spaces.", pos: 1200 }],
			outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
		const RANGE = "codex:thr_infer:0a1b2c3d:0-5000", session = { client: "codex", id: "thr_infer" }, sha = sha256(body);
		const post = (payload: unknown) => exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/v1/ingest`, { method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
		expect((await post({ session, digests: [{ range_id: RANGE, capture_status: "consolidated", part_id: "0-5000", sha256: sha, body }] })).status).toBe(200);
		expect((await post({ session, manifests: [{ range_id: RANGE, parts: [{ part_id: "0-5000", sha256: sha }] }] })).status).toBe(200);
		const ref = (await contextFor()).account.profiles.find((p) => p.profile === "test")!;
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:test:${ref.generation}`)), (_i, s) => {
			const who = { userId: ref.userId, profile: "test", generation: ref.generation };
			const lease = next(s.storage, {}), item = lease.items.find((i) => i.kind === "preference_signal")!;
			const evidence = [{ kind: "node" as const, ref: item.subjects[0]! }];
			// What confine sends for OPS_SCHEMA output with why, how_to_apply and scope null: those fields dropped. A work-only job has no me.
			const out = complete(s.storage, who, { lease_id: lease.lease_id!, results: [{ item_id: item.item_id, ops: [
				{ op: "infer_preference", name: "Prefers tabs", description: "Indents with tabs.", evidence },
				{ op: "infer_preference", name: "Prefers short commits", description: "d", scope: "all projects", evidence },
				{ op: "promote_to_me", from_op: 0, company_free: true }] }] }, { platform: "test", userId: ref.userId, deviceId: "job-device" });
			expect(out.results[0]!.ops).toEqual([{ op: "infer_preference", status: "applied", activity_id: expect.any(Number), created: [expect.any(String)] },
				{ op: "infer_preference", status: "rejected", code: "validation", reason: "invalid_scope" }, { op: "promote_to_me", status: "rejected", code: "forbidden" }]);
			expect(batchStatus(s.storage.sql).last_completed_lease!.items.find((i) => i.item_id === item.item_id)!.ops[1]).toEqual({ op: "infer_preference", status: "rejected", code: "validation", reason: "invalid_scope" });
		});
	});

	it("turns every change in me into a flag", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Me note", content: "mine" }));
			enqueue(storage, [{ kind: "unlinked", subjects: [a.memory_id as string] }]);
			const lease = next(storage, {});
			const out = complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: lease.items[0]!.item_id, ops: [{ op: "save", memory_id: a.memory_id as string, description: "batch edit" }] }] }, { platform: "test", userId: USER });
			expect(out.results[0]).toMatchObject({ ops: [{ op: "save", status: "flagged" }] });
			expect(storage.sql.exec("SELECT description, revision FROM nodes WHERE id = ?", a.memory_id as string).one()).toEqual({ description: "d", revision: 1 });
		}, "me");
	});
});

describe("housekeeping", () => {
	const only = (storage: DurableObjectStorage, who: Who, stage: Stage) => {
		for (const s of ["dedupe", "ttl", "purge", "queue"]) {
			storage.sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", s, s === stage ? 0 : Date.now() + 86_400_000);
		}
		return housekeep(storage, who);
	};

	it("archives unused captures after 90 days with undo, then purges them after 300 days with their requests", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const old = wired(storage, who, { op: "capture", args: { content: "stale capture", request_id: "c4-cap-old" } });
			const fresh = wired(storage, who, { op: "capture", args: { content: "fresh capture" } });
			sql.exec("UPDATE nodes SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", old.capture_id as string);
			const before = state(sql);
			expect(only(storage, who, "ttl")).toMatchObject({ stage: "ttl", more: false });
			const ids = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE other_label = 'capture'").toArray().map((r) => r.id);
			expect(ids).toEqual([fresh.capture_id]);
			const ttl = sql.exec<{ id: number; summary: string }>("SELECT id, summary FROM activity WHERE op = 'ttl'").one();
			expect(ttl.summary).toBe("archived 1 captures and 0 digest rows unused for 90 days");
			undoIt(storage, who, ttl.id);
			expect(state(sql)).toEqual(before);

			sql.exec("UPDATE cursors SET due_at = 0 WHERE stage = 'ttl'");
			only(storage, who, "ttl");
			sql.exec("UPDATE archive SET purge_after = '2000-01-01T00:00:00.000Z'");
			expect(sql.exec("SELECT count(*) AS c FROM requests WHERE request_id = 'c4-cap-old'").one().c).toBe(1);
			const p = only(storage, who, "purge");
			expect(p).toMatchObject({ stage: "purge", purged: [old.capture_id] });
			expect(sql.exec("SELECT count(*) AS c FROM archive").one().c).toBe(0);
			expect(sql.exec("SELECT count(*) AS c FROM requests WHERE request_id = 'c4-cap-old'").one().c).toBe(0);
			expect(sql.exec("SELECT undo FROM activity WHERE op = 'purge'").one().undo).toBeNull();
		});
	});

	it("supersedes the newer exact duplicate and only flags a pinned one", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const a = wired(storage, who, save({ name: "Twin A", content: "same" }));
			const b = wired(storage, who, save({ name: "Twin B", content: "same" }));
			const c = wired(storage, who, save({ name: "Twin C", content: "same" }));
			// Exact duplicates arrive by import; the save path cannot make two with one hash.
			sql.exec("UPDATE nodes SET content_hash = 'dup' WHERE id IN (?, ?, ?)", a.memory_id as string, b.memory_id as string, c.memory_id as string);
			sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", c.memory_id as string);
			expect(only(storage, who, "dedupe")).toMatchObject({ stage: "dedupe", more: false });
			const rows = sql.exec<{ id: string; status: string; flagged: string | null }>("SELECT id, status, flagged FROM nodes ORDER BY rowid").toArray();
			expect(rows).toEqual([{ id: a.memory_id, status: "active", flagged: null }, { id: b.memory_id, status: "superseded", flagged: null },
				{ id: c.memory_id, status: "active", flagged: "dedupe: pinned" }]);
			expect(sql.exec("SELECT actor FROM activity WHERE op = 'supersede'").one().actor).toBe("keep");
		});
	});
	it("retains a durable purge outbox until vector and account cleanup both succeed", async () => {
		await inStore(async (storage, who) => {
			const a = wired(storage, who, { op: "capture", args: { content: "stale", request_id: "outbox-request" } });
			runWrite(storage, who, { op: "owner", args: { memory_id: a.capture_id as string, action: "forget" } }, { ...ctx(who), actor: "owner" });
			storage.sql.exec("UPDATE archive SET purge_after = '2000-01-01'");
			only(storage, who, "purge");
			let calls = 0;
			await expect(cleanupPurge(storage, async (ids) => { calls++; expect(ids).toEqual({ nodes: [a.capture_id], requests: ["outbox-request"] }); throw new Error("offline"); })).rejects.toThrow("offline");
			expect(storage.sql.exec("SELECT 1 FROM cursors WHERE stage = 'purge_cleanup'").toArray()).toHaveLength(1);
			await cleanupPurge(storage, async () => { calls++; });
			await cleanupPurge(storage, async () => { calls++; });
			expect(calls).toBe(2);
			expect(storage.sql.exec("SELECT 1 FROM cursors WHERE stage = 'purge_cleanup'").toArray()).toHaveLength(0);
		});
	});

	it("queues eligible nodes once per card and weekly slot and returns a real job lease", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Unlinked note", content: "note" }));
			storage.sql.exec("UPDATE nodes SET created_at = '2026-01-01' WHERE id = ?", a.memory_id as string);
			only(storage, who, "queue"); only(storage, who, "queue");
			expect(storage.sql.exec("SELECT kind FROM maintenance ORDER BY kind").toArray()).toEqual([{ kind: "unlinked" }, { kind: "weekly_review" }]);
			const lease = next(storage, {});
			expect(lease.items.find((i) => i.kind === "unlinked")!.subjects).toEqual([a.memory_id]);
			const skipped = finishBatch(storage, { lease_id: lease.lease_id!, status: "batch_skipped", reason: "bad_output" }, { userId: who.userId, platform: "test" });
			expect(skipped).toEqual({ status: "batch_skipped", released: 2 });
			expect(storage.sql.exec("SELECT DISTINCT state FROM maintenance").one().state).toBe("open");
			expect(storage.sql.exec("SELECT summary, undo FROM activity WHERE op = 'batch_skipped'").one()).toEqual({ summary: "bad_output", undo: null });
			expect(finishBatch(storage, { lease_id: lease.lease_id!, status: "stuck", reason: "tool_event" }, { userId: who.userId, platform: "test" }).released).toBe(0);
		});
	});

	it("the shared writer flags a protected direct background save with undo and keeps content unchanged", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Stated note", content: "original", origin: "stated" }));
			const snapshot = state(storage.sql);
			const out = runWrite(storage, who, save({ memory_id: a.memory_id, retire: true }), { ...ctx(who), actor: "keep" });
			expect(out.result.action).toBe("flagged");
			expect(storage.sql.exec("SELECT status, revision FROM nodes WHERE id = ?", a.memory_id as string).one()).toEqual({ status: "active", revision: 1 });
			undoIt(storage, who, out.result.activity_id as number);
			expect(state(storage.sql)).toEqual(snapshot);
		});
	});

	it("classifies both caps and refuses growth at 90% while keeping retirement available", async () => {
		expect([0, .7, .9].map((v) => sizeLevel(OBJECT_LIMIT * v))).toEqual(["ok", "uploads_refused", "shrink_only"]);
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "At capacity", content: "body" }));
			const sql = new Proxy(storage.sql, { get(t, k) { const v = k === "databaseSize" ? OBJECT_LIMIT : Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } });
			const full = { sql, transactionSync: storage.transactionSync.bind(storage) } as DurableObjectStorage;
			const at70 = new Proxy(storage.sql, { get(t, k) { const v = k === "databaseSize" ? .7 * OBJECT_LIMIT : Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } });
			const warm = { sql: at70, transactionSync: storage.transactionSync.bind(storage) } as DurableObjectStorage;
			expect(() => runWrite(warm, who, { op: "knowledge", args: { nodes: [{ kind: "commit", name: "aggregate" }] } }, { ...ctx(who), actor: "index" })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
			expect(wired(warm, who, save({ name: "Memory still accepted" })).action).toBe("created");
			expect(() => wired(full, who, save({ memory_id: a.memory_id, content: "larger" }))).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
			expect(wired(full, who, save({ memory_id: a.memory_id, retire: true })).action).toBe("retired");
		});
	});

});

describe("job tools", () => {
	it("refuse the owner, a token without maintenance, and a profile the job token may not use", async () => {
		const [nextTool] = MAINTENANCE_TOOLS;
		const refuse = async (c: Awaited<ReturnType<typeof contextFor>>, profile: string) =>
			expect(await nextTool.run(c, { profile })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		await refuse(await contextFor(), "personal");
		const reader = await deviceToken(`c4-reader-${Date.now()}`, ["read", "write"], ["personal"]);
		await refuse(await contextFor(devicePrincipal(reader.token)), "personal");
		const job = await deviceToken(`c4-job-${Date.now()}`, ["maintenance"], ["personal"]);
		await refuse(await contextFor(devicePrincipal(job.token)), "work");
	});
});

describe("review fixes (C4-R1 to C4-R6)", () => {
	const link = (storage: DurableObjectStorage, who: Who, from: unknown, to: unknown, ref: string, note = "first note") =>
		wired(storage, who, { op: "knowledge", args: { edges: [{ from: { id: from as string }, rel: "relates_to", to: { id: to as string }, reason: "a link the review relies on", evidence: [{ kind: "url", ref, note }] }] } }) as unknown as { edges: { id: number }[]; activity_id: number };
	const evidenceOf = (sql: SqlStorage, edge: number) => sql.exec("SELECT kind, ref, note FROM evidence WHERE owner = ? ORDER BY ref", `e:${edge}`).toArray();

	it("R1: redacts model text before it is stored, hashed or flagged", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Maintenance target", content: "initial" }));
			enqueue(storage, [{ kind: "unlinked", subjects: [a.memory_id as string] }]);
			const lease = next(storage, {}), secret = `ghp_${"A".repeat(36)}`;
			const out = complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: lease.items[0]!.item_id, ops: [
				{ op: "save", memory_id: a.memory_id as string, content: `synthetic ${secret}` },
				{ op: "flag", node: a.memory_id as string, reason: `synthetic ${secret}` },
			] }] }, { platform: "test", userId: USER });
			expect(out.results[0]).toMatchObject({ ops: [{ status: "applied" }, { status: "applied" }] });
			const dump = JSON.stringify(storage.sql.exec("SELECT n.flagged, t.body, a.summary, a.undo, r.payload_hash FROM nodes n JOIN texts t ON t.node_id = n.id, activity a, requests r").toArray());
			expect(dump).not.toContain(secret);
			expect(storage.sql.exec("SELECT body FROM texts WHERE node_id = ? AND part = 'body'", a.memory_id as string).one().body).toBe(redactText(`synthetic ${secret}`));
			expect(storage.sql.exec("SELECT flagged FROM nodes WHERE id = ?", a.memory_id as string).one().flagged).toBe(`flag: ${redactText(`synthetic ${secret}`)}`);
		});
	});

	it("R2: undo rechecks restored me content against the me guard; registered work terms refuse neither an undo nor a save", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Personal note", content: "PrivateOrionProject detail" }));
			const change = wired(storage, who, save({ memory_id: a.memory_id, content: "safe detail" }));
			storage.sql.exec("INSERT INTO guard_terms (term, source, added_at, seq) VALUES ('PrivateOrionProject', 'work', ?, 0)", new Date().toISOString());
			// A contact field in what undo would put back (as older data might hold) is refused before any change.
			const plain = storage.sql.exec<{ undo: string }>("SELECT undo FROM activity WHERE id = ?", change.activity_id as number).one().undo;
			storage.sql.exec("UPDATE activity SET undo = ? WHERE id = ?", plain.replaceAll("PrivateOrionProject", "orion@example.com"), change.activity_id as number);
			const field = expect.objectContaining({ failure: expect.objectContaining({ code: "me_sensitive_term", details: { term: "personal_field" } }) });
			const snapshot = state(storage.sql);
			expect(() => undoIt(storage, who, change.activity_id)).toThrow(field);
			expect(state(storage.sql)).toEqual(snapshot);
			storage.sql.exec("UPDATE activity SET undo = ? WHERE id = ?", plain, change.activity_id as number);
			expect(() => undoIt(storage, who, change.activity_id)).not.toThrow();
			expect(wired(storage, who, save({ memory_id: a.memory_id, content: "PrivateOrionProject detail again" })).action).toBe("updated");
		}, "me");
	});

	it("R3: undo restores the head when SQLite reused its rowid", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Single empty node" }));
			const head = () => storage.sql.exec("SELECT part, body FROM texts WHERE node_id = ?", a.memory_id as string).toArray();
			const before = head();
			const change = wired(storage, who, save({ memory_id: a.memory_id, description: "replacement description" }));
			undoIt(storage, who, change.activity_id);
			expect(head()).toEqual(before);
			expect(storage.sql.exec("SELECT count(*) AS c FROM texts_fts WHERE texts_fts MATCH 'replacement'").one().c).toBe(0);
		});
	});

	it("R4: undo removes evidence newly asserted on an existing edge and puts an overwritten note back", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Edge A", content: "a" })), b = wired(storage, who, save({ name: "Edge B", content: "b" }));
			const edge = link(storage, who, a.memory_id, b.memory_id, "https://example.invalid/first").edges[0]!.id;
			const before = evidenceOf(storage.sql, edge);
			const added = link(storage, who, a.memory_id, b.memory_id, "https://example.invalid/second");
			undoIt(storage, who, added.activity_id);
			expect(evidenceOf(storage.sql, edge)).toEqual(before);
			const rewritten = link(storage, who, a.memory_id, b.memory_id, "https://example.invalid/first", "rewritten note");
			undoIt(storage, who, rewritten.activity_id);
			expect(evidenceOf(storage.sql, edge)).toEqual(before);
		});
	});

	it("R5: undo refuses to remove an edge or a node that gained later evidence or links", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Drift A", content: "a" })), b = wired(storage, who, save({ name: "Drift B", content: "b" }));
			const first = link(storage, who, a.memory_id, b.memory_id, "https://example.invalid/first");
			link(storage, who, a.memory_id, b.memory_id, "https://example.invalid/later");
			const snapshot = { ...state(storage.sql), evidence: evidenceOf(storage.sql, first.edges[0]!.id) };
			expect(() => undoIt(storage, who, first.activity_id)).toThrow(conflict);
			expect({ ...state(storage.sql), evidence: evidenceOf(storage.sql, first.edges[0]!.id) }).toEqual(snapshot);
			const c = wired(storage, who, save({ name: "Drift C", content: "c" }));
			link(storage, who, a.memory_id, c.memory_id, "https://example.invalid/to-c");
			expect(() => undoIt(storage, who, c.activity_id)).toThrow(conflict);
		});
	});

	it("R6: an undo past 1,000 real rows written is refused and changes nothing", async () => {
		await inStore((storage, who) => {
			// 60 new nodes fit one write; archiving them all costs about twice as many real rows (archive row, index and
			// full-text deletes), so their undo crosses the bound. A body replacement over hundreds of entries is now refused forward.
			const made = wired(storage, who, { op: "knowledge", args: { nodes: Array.from({ length: 60 }, (_, i) => ({ kind: "component" as const, name: `Bulk component ${i}`, description: "a component" })) } });
			const snapshot = state(storage.sql);
			expect(() => undoIt(storage, who, made.activity_id)).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
			expect(state(storage.sql)).toEqual(snapshot);
			expect(storage.sql.exec("SELECT count(*) AS c FROM archive").one().c).toBe(0);
		});
	});

	it("control: BudgetTx refuses an over-budget archive and the transaction rolls back", async () => {
		await inStore((storage, who) => {
			const a = wired(storage, who, save({ name: "Budget control", content: "one" }));
			const snapshot = state(storage.sql);
			expect(() => storage.transactionSync(() => {
				const tx = new BudgetTx(storage.sql, nextSeq(storage.sql, "profile_meta"), new Date().toISOString());
				tx.rows = 999;
				archiveNode(tx, 1, a.memory_id as string, purgeAfter(tx.now));
			})).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
			expect(state(storage.sql)).toEqual(snapshot);
			expect(storage.sql.exec("SELECT count(*) AS c FROM archive").one().c).toBe(0);
		});
	});

	it("control: a job token's next and complete reach its profile with the device context", async () => {
		const job = await deviceToken(`c4-job-rpc-${Date.now()}`, ["ingest", "maintenance"], ["personal"]);
		const c = await contextFor(devicePrincipal(job.token));
		const ref = c.account.profiles.find((p) => p.profile === "personal")!;
		const calls: { cmd: { op: string }; job: { deviceId?: string } }[] = [];
		const PROFILE = { idFromName: (name: string) => { expect(name).toBe(`${ref.userId}:personal:${ref.generation}`); return name; },
			get: () => ({ maintenance: async (_who: unknown, cmd: { op: string }, j: { deviceId?: string }) => { calls.push({ cmd, job: j }); return { ok: true, value: { results: [] } }; } }) };
		const spied = { ...c, env: { ...c.env, PROFILE } as unknown as Env };
		expect(await MAINTENANCE_TOOLS[0].run(spied, { profile: "personal" })).toMatchObject({ ok: true });
		expect(await MAINTENANCE_TOOLS[1].run(spied, { profile: "personal", lease_id: crypto.randomUUID(), results: [{ item_id: 1, ops: [{ op: "dismiss" }] }] })).toMatchObject({ ok: true });
		expect(calls.map((x) => x.cmd.op)).toEqual(["next", "complete"]);
		expect(calls[0]!.job.deviceId).toBe(c.caller.deviceId);
	});
});


it.each(["supersedes", "relates_to"] as const)("undo reopens an existing %s edge ended in its creation millisecond", async (rel) => {
	await inStore((storage, who) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-29T08:00:00.000Z"));
		try {
			const a = wired(storage, who, save({ name: "same-ms older note" }));
			const b = wired(storage, who, save({ name: "same-ms newer note", ...(rel === "supersedes" ? { supersedes: [a.memory_id] } : {}) }));
			if (rel === "relates_to") wired(storage, who, { op: "knowledge", args: { edges: [{ from: { id: b.memory_id as string }, to: { id: a.memory_id as string }, rel, reason: "same-ms relationship", evidence: ev }] } });
			const before = storage.sql.exec<{ id: number }>("SELECT id, src, rel, dst, valid_to, ended_at FROM edges WHERE src = ? AND dst = ? AND rel = ?", b.memory_id as string, a.memory_id as string, rel).one();
			const ended = wired(storage, who, { op: "knowledge", args: { end: [{ edge: before.id, valid_to: new Date().toISOString(), reason: "end this edge" }] } });
			const dates = storage.sql.exec("SELECT recorded_at, ended_at FROM edges WHERE id = ?", before.id).one();
			expect(dates.recorded_at).toBe(dates.ended_at);
			expect(undoIt(storage, who, ended.activity_id).result.action).toBe("undone");
			expect(storage.sql.exec("SELECT id, src, rel, dst, valid_to, ended_at FROM edges WHERE id = ?", before.id).one()).toEqual(before);
		} finally { vi.useRealTimers(); }
	});
});


describe("account purge bindings", () => {
	it("prunes only the current generation's profile bindings and leaves the others intact", async () => {
		const c = await contextFor(), ref = c.account.profiles.find((p) => p.profile === "test")!;
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(ref.userId));
		const node = crypto.randomUUID(), request = crypto.randomUUID();
		await account.recordNodes(ref.profile, [node]);
		await account.bindRequest({ requestId: request, profile: ref.profile, op: "save", payloadHash: "original" });
		await account.prunePurged({ ...ref, generation: "obsolete" }, { nodes: [node], requests: [request] });
		expect(await account.resolveNode(node)).toBe("test");
		expect(await account.bindRequest({ requestId: request, profile: "personal", op: "save", payloadHash: "different" })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		await account.prunePurged(ref, { nodes: [node], requests: [request] });
		expect(await account.resolveNode(node)).toBeNull();
		expect(await account.bindRequest({ requestId: request, profile: "personal", op: "save", payloadHash: "different" })).toMatchObject({ ok: true });
	});
});


describe("D1 compaction", () => {
	it("664 entries retain bytes and replay ledgers, fold within real Workers limits, and undo restores lexical recall before any alarm", async () => { const proof = await inStore((storage, who) => {
		const sql = storage.sql, measured: { rows: number; bytes: number; binds: number }[] = [];
		let current = { rows: 0, bytes: 0, binds: 0 };
		const metered = { sql: { get databaseSize() { return sql.databaseSize; }, exec(q: string, ...p: SqlStorageValue[]) {
			const c = sql.exec(q, ...p); current.rows += c.rowsWritten;
			current.bytes += p.reduce<number>((n, v) => n + (typeof v === "string" ? Buffer.byteLength(v) : 0), 0); current.binds = Math.max(current.binds, p.length); return c;
		} }, transactionSync<T>(fn: () => T): T {
			current = { rows: 0, bytes: 0, binds: 0 };
			try { return storage.transactionSync(fn); } finally { measured.push({ ...current }); }
		} } as unknown as DurableObjectStorage;
		const write = (cmd: WriteCommand, use = storage) => runWrite(use, who, cmd, { actor: "owner", platform: "test", routedBy: "explicit", payloadHash: requestHash(cmd.op, cmd.args as never), userId: who.userId });
		const made = write({ op: "save", args: { name: "large compact journal", type: "project", description: "synthetic", content: "base" } });
		const id = String(made.result.memory_id);
		for (let i = 1; i <= 664; i++) write({ op: "append", args: { memory_id: id, content: `archivedneedles${i} café`, separator: i % 2 ? "\n\n" : " | ", request_id: `entry-${i}` } });
		const original = readContent(sql, id), originalRows = sql.exec("SELECT body, separator, revision, seq_no, chunk, request_id, actor, created_at FROM texts WHERE node_id = ? AND part = 'entry' ORDER BY seq_no, chunk", id).toArray();
		const requests = sql.exec("SELECT * FROM requests ORDER BY request_id").toArray();
		const recall = (keyword: string) => lexicalChannels(sql, { keyword, type: "all", limit: 100, includeHistory: false }, {});
		expect(recall("archivedneedles1").fulltext).toHaveLength(1);
		const compactCmd: WriteCommand = { op: "save", args: { memory_id: id, expected_revision: 665, request_id: "compact-664", compact: { through_seq: 664, summary: "summary retained" } } };
		const folded = write(compactCmd, metered);
		expect(folded.result.action).toBe("compacted");
		expect(readContent(sql, id)).toBe("basesummary retained");
		expect(readPrefix(sql, id)).toBe("basesummary retained");
		expect(get(sql, who, { target: { memory_id: id }, includeRetired: false }).content).toBe("basesummary retained");
		expect(recall("archivedneedles1").fulltext).toHaveLength(0);
		expect(recall("archivedneedles1").literal).toHaveLength(0);
		// An append while folding remains visible. Undo of that append lets compaction's expected revision be tested.
		const mid = write({ op: "append", args: { memory_id: id, content: "tail visible", separator: "\n", request_id: "mid-fold" } });
		expect(readContent(sql, id)).toBe("basesummary retained\ntail visible");
		const steps: number[] = [];
		while (foldDue(sql)) { const f = foldStep(metered); steps.push(f.changed); expect(f.rows).toBeLessThanOrEqual(1000); }
		expect(steps.reduce((n, c) => n + c, 0)).toBe(664);
		expect(sql.exec("SELECT * FROM requests WHERE request_id LIKE 'entry-%' ORDER BY request_id").toArray()).toEqual(requests);
		expect(sql.exec("SELECT body, separator, revision, seq_no, chunk, request_id, actor, created_at FROM texts WHERE node_id = ? AND part = 'entry' AND seq_no <= 664 ORDER BY seq_no, chunk", id).toArray()).toEqual(originalRows);
		expect(write(compactCmd).result.action).toBe("replayed");
		expect(() => undo(metered, who, Number(folded.result.activity_id), { actor: "owner", platform: "test", routedBy: "explicit", userId: who.userId })).toThrow(/changed since/);
		// Undo of the later append preserves revision conflict on the earlier compaction.
		undo(storage, who, Number(mid.result.activity_id), { actor: "owner", platform: "test", routedBy: "explicit", userId: who.userId });
		// The compaction inverse contains no entry images.
		const compactActivity = sql.exec<{ undo: string }>("SELECT undo FROM activity WHERE id = ?", Number(folded.result.activity_id)).one();
		expect(JSON.stringify(JSON.parse(compactActivity.undo))).not.toContain("archivedneedles");
		expect(Buffer.byteLength(compactActivity.undo)).toBeLessThan(5000);
		expect(original).toContain("archivedneedles664");
		expect(measured.every((m) => m.rows <= 1000 && m.bytes <= 1_000_000 && m.binds <= 100)).toBe(true);
		return { measured, steps };
	}); console.log("D1 664-entry commit/fold counters", JSON.stringify(proof)); });

	it("undo reindexes a folded prefix in bounded transactions before it publishes the old content", async () => { const proof = await inStore((storage, who) => {
		const ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId };
		const write = (cmd: WriteCommand) => runWrite(storage, who, cmd, { ...ctx, payloadHash: requestHash(cmd.op, cmd.args as never) });
		const id = String(write({ op: "save", args: { name: "undo compact", type: "project", description: "test", content: "base" } }).result.memory_id);
		for (let i = 1; i <= 664; i++) write({ op: "append", args: { memory_id: id, content: `originaltoken${i}`, separator: i % 2 ? "\n\n" : "::", request_id: `undo-entry-${i}` } });
		const before = readContent(storage.sql, id);
		const saved = write({ op: "save", args: { memory_id: id, expected_revision: 665, request_id: "undo-compact", compact: { through_seq: 664, summary: "summarized" } } });
		while (foldDue(storage.sql)) foldStep(storage);
		let rows = 0, bytes = 0, binds = 0, interrupted = false;
		const counters: { rows: number; bytes: number; binds: number; folded: number; fence: unknown }[] = [];
		const measured = { sql: { get databaseSize() { return storage.sql.databaseSize; }, exec(q: string, ...p: SqlStorageValue[]) {
			const c = storage.sql.exec(q, ...p); rows += c.rowsWritten; bytes += p.reduce<number>((n, v) => n + (typeof v === "string" ? Buffer.byteLength(v) : 0), 0); binds = Math.max(binds, p.length); return c;
		} }, transactionSync<T>(fn: () => T): T {
			rows = 0; bytes = 0; binds = 0;
			try { return storage.transactionSync(fn); } finally { counters.push({ rows, bytes, binds, folded: Number(storage.sql.exec("SELECT COUNT(*) n FROM texts WHERE node_id = ? AND part = 'entry' AND live = 2", id).one().n), fence: storage.sql.exec("SELECT json_extract(attrs, '$.compacted_through') F FROM nodes WHERE id = ?", id).one().F }); expect(rows).toBeLessThanOrEqual(1000); expect(bytes).toBeLessThanOrEqual(1_000_000); expect(binds).toBeLessThanOrEqual(100); }
		} } as unknown as DurableObjectStorage;
		// Kill after the first committed reindex step. The old compacted view must still be exact and its old text hidden.
		const normal = measured.transactionSync.bind(measured);
		measured.transactionSync = <T,>(fn: () => T) => { const v = normal(fn); if (!interrupted) { interrupted = true; throw new Error("synthetic interruption"); } return v; };
		expect(() => undo(measured, who, Number(saved.result.activity_id), ctx)).toThrow("synthetic interruption");
		expect(readContent(storage.sql, id)).toBe("basesummarized");
		expect(lexicalChannels(storage.sql, { keyword: "originaltoken1", type: "all", limit: 100, includeHistory: false }, {}).fulltext).toHaveLength(0);
		measured.transactionSync = normal;
		undo(measured, who, Number(saved.result.activity_id), ctx);
		expect(readContent(storage.sql, id)).toBe(before);
		expect(() => write({ op: "save", args: { memory_id: id, expected_revision: 666, request_id: "stale-after-undo", compact: { through_seq: 664, summary: "stale" } } })).toThrow(/changed beyond appends/);
		const channels = lexicalChannels(storage.sql, { keyword: "originaltoken664", type: "all", limit: 100, includeHistory: false }, {});
		expect(channels.literal).toHaveLength(1); expect(channels.fulltext).toHaveLength(1);
		expect(undo(measured, who, Number(saved.result.activity_id), ctx).result.action).toBe("replayed");
		const revision = Number(storage.sql.exec("SELECT revision FROM nodes WHERE id = ?", id).one().revision);
		write({ op: "save", args: { memory_id: id, expected_revision: revision, request_id: "compact-again", compact: { through_seq: 664, summary: "short" } } });
		expect(write({ op: "save", args: { memory_id: id, content: "replacement" } }).result.action).toBe("updated");
		expect(readContent(storage.sql, id)).toBe("replacement");
		return counters;
	}); console.log("D1 immediate undo real rows per transaction", JSON.stringify(proof)); });
	it("keeps appends beyond the chosen expected-revision prefix, refuses stale snapshots and preserves replacement undo", async () => inStore((storage, who) => {
		const ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId };
		const write = (cmd: WriteCommand) => runWrite(storage, who, cmd, { ...ctx, payloadHash: requestHash(cmd.op, cmd.args as never) });
		const id = String(write({ op: "save", args: { name: "prefix", type: "project", description: "test", content: "body" } }).result.memory_id);
		for (let i = 1; i <= 3; i++) write({ op: "append", args: { memory_id: id, content: `entry${i}`, separator: " | ", request_id: `prefix-${i}` } });
		const a = { memory_id: id, expected_revision: 3, request_id: "chosen-prefix", compact: { through_seq: 2, summary: "short" } };
		const compact = write({ op: "save", args: a });
		expect(readContent(storage.sql, id)).toBe("bodyshort | entry3");
		expect(() => write({ op: "save", args: { ...a, request_id: "same-prefix" } })).toThrow(/changed beyond appends|already compacted/);
		expect(() => write({ op: "save", args: { ...a, compact: { through_seq: 3, summary: "changed" } } })).toThrow(/different arguments/);
		const rep = write({ op: "save", args: { memory_id: id, content: "replaced", request_id: "replace-after-prefix" } });
		expect(readContent(storage.sql, id)).toBe("replaced");
		undo(storage, who, Number(rep.result.activity_id), ctx);
		expect(readContent(storage.sql, id)).toBe("bodyshort | entry3");
		expect(lexicalChannels(storage.sql, { keyword: "short", type: "all", limit: 100, includeHistory: false }, {}).fulltext).toHaveLength(1);
		expect(() => undo(storage, who, Number(compact.result.activity_id), ctx)).toThrow(/changed since/);
		const rev = Number(storage.sql.exec("SELECT revision FROM nodes WHERE id = ?", id).one().revision);
		const again = write({ op: "save", args: { memory_id: id, expected_revision: rev, request_id: "next-prefix", compact: { through_seq: 3, summary: "all" } } });
		while (foldDue(storage.sql)) foldStep(storage);
		undo(storage, who, Number(again.result.activity_id), ctx);
		expect(readContent(storage.sql, id)).toBe("bodyshort | entry3");
		expect(lexicalChannels(storage.sql, { keyword: "entry3", type: "all", limit: 100, includeHistory: false }, {}).literal).toHaveLength(1);
	}));

	it("maintenance supplies a bounded prefix, applies only subject compaction and flags protected journals", async () => inStore((storage, who) => {
		const write = (cmd: WriteCommand, actor: WriteContext["actor"] = "owner") => runWrite(storage, who, cmd, { actor, platform: "test", routedBy: "explicit", payloadHash: requestHash(cmd.op, cmd.args as never), userId: who.userId });
		const id = String(write({ op: "save", args: { name: "maintenance compact", type: "project", description: "test" } }).result.memory_id);
		write({ op: "append", args: { memory_id: id, content: "first".repeat(1700), request_id: "maintenance-entry" } });
		enqueue(storage, [{ kind: "stale_journal", subjects: [id] }]);
		const lease = next(storage, {}), item = lease.items[0]!;
		expect(item.allowed_ops).toContain("compact");
		expect(item.context.nodes[0]).toMatchObject({ through_seq: 1, compacted_through: 0, revision: 2, uncompacted_prefix: "first".repeat(1700) });
		const c = { lease_id: lease.lease_id!, results: [{ item_id: item.item_id, ops: [{ op: "compact" as const, memory_id: id, through_seq: 1, summary: "short", expected_revision: 2 }] }] };
		expect(complete(storage, who, c, { platform: "test", userId: who.userId }).results[0]).toMatchObject({ status: "done", ops: [{ status: "applied" }] });
		expect(complete(storage, who, c, { platform: "test", userId: who.userId }).results[0]).toMatchObject({ replayed: true });
		expect(readContent(storage.sql, id)).toBe("short");
		write({ op: "append", args: { memory_id: id, content: "second", request_id: "second-entry" } });
		write({ op: "owner", args: { memory_id: id, action: "pin" } });
		const revision = Number(storage.sql.exec("SELECT revision FROM nodes WHERE id = ?", id).one().revision);
		expect(write({ op: "save", args: { memory_id: id, expected_revision: revision, request_id: "protected-compact", compact: { through_seq: 2, summary: "blocked" } } }, "maintenance").result.action).toBe("flagged");
		expect(readContent(storage.sql, id)).toBe("short\nsecond");
	}));

	it("guards a me summary and restored entries before any reindex, and refuses closed or moving generations", async () => inStore((storage, who) => {
		const ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId, meGuard: { explicit: true } };
		const write = (cmd: WriteCommand) => runWrite(storage, who, cmd, { ...ctx, payloadHash: requestHash(cmd.op, cmd.args as never) });
		const id = String(write({ op: "save", args: { name: "guard compact", type: "project", description: "test" } }).result.memory_id);
		write({ op: "append", args: { memory_id: id, content: "pastorgterm", request_id: "guard-entry" } });
		const saved = write({ op: "save", args: { memory_id: id, expected_revision: 2, request_id: "guard-compact", compact: { through_seq: 1, summary: "safe" } } });
		while (foldDue(storage.sql)) foldStep(storage);
		expect(() => write({ op: "save", args: { memory_id: id, expected_revision: 3, request_id: "unsafe-summary", compact: { through_seq: 2, summary: "mail pastorg@example.com" } } })).toThrow(/personal contact fields/);
		// Restored entries meet the same guard: a contact field in the archived entries refuses the undo before any change.
		// Folded entries are not indexed (only live = 1 is), so this rewrite leaves the FTS tables consistent.
		storage.sql.exec("UPDATE texts SET body = replace(body, 'pastorgterm', 'pastorg@example.com') WHERE node_id = ? AND live <> 1 AND instr(body, 'pastorgterm') > 0", id);
		const before = ["nodes","texts","activity","requests","profile_meta"].map((t) => storage.sql.exec(`SELECT * FROM ${t}`).toArray());
		expect(() => undo(storage, who, Number(saved.result.activity_id), ctx)).toThrow(/personal contact fields/);
		expect(["nodes","texts","activity","requests","profile_meta"].map((t) => storage.sql.exec(`SELECT * FROM ${t}`).toArray())).toEqual(before);
		storage.sql.exec("UPDATE nodes SET status = 'moving' WHERE id = ?", id);
		expect(() => write({ op: "save", args: { memory_id: id, expected_revision: 3, request_id: "moving-compact", compact: { through_seq: 2, summary: "safe" } } })).toThrow(/transferred/);
		storage.sql.exec("INSERT INTO profile_meta(key,value) VALUES ('closed','test')");
		queueFold(new BudgetTx(storage.sql, nextSeq(storage.sql, "profile_meta"), new Date().toISOString()), id);
		expect(() => foldStep(storage)).toThrow(/wiped|closed/);
		expect(() => write({ op: "save", args: { memory_id: id, expected_revision: 3, request_id: "closed-compact", compact: { through_seq: 2, summary: "safe" } } })).toThrow(/wiped|closed/);
	}, "me"));

	it("accepts compact-only writes at 90 percent, limits maintenance input and validates the required contract", async () => inStore((storage, who) => {
		const ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId };
		const write = (cmd: WriteCommand, use = storage, actor: WriteContext["actor"] = "owner") => runWrite(use, who, cmd, { ...ctx, actor, payloadHash: requestHash(cmd.op, cmd.args as never) });
		const id = String(write({ op: "save", args: { name: "size compact", type: "project", description: "test" } }).result.memory_id);
		write({ op: "append", args: { memory_id: id, content: "a".repeat(25_000), request_id: "size-entry" } });
		const cmd: WriteCommand = { op: "save", args: { memory_id: id, expected_revision: 2, request_id: "size-compact", compact: { through_seq: 1, summary: "short" } } };
		expect(() => write(cmd, storage, "maintenance")).toThrow(/24,000/);
		expect(() => write({ ...cmd, args: { ...cmd.args, expected_revision: undefined } } as WriteCommand)).toThrow(/expected_revision/);
		const full = { sql: { get databaseSize() { return OBJECT_LIMIT; }, exec: storage.sql.exec.bind(storage.sql) }, transactionSync: storage.transactionSync.bind(storage) } as unknown as DurableObjectStorage;
		expect(write(cmd, full).result.action).toBe("compacted");
		expect(readContent(storage.sql, id)).toBe("short");
	}));

	it("arms and drains folding with embeddings off, and re-arms when the queue discovers more fold work", async () => {
		const r = await registered();
		await runInDurableObject(r.stub, async (instance, state) => {
			const storage = state.storage, ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: r.who.userId };
			const original = Reflect.get(instance, "env");
			Reflect.set(instance, "env", { ...env, EMBEDDINGS: "off" });
			try {
				const made = await instance.write(r.who, { op: "save", args: { name: "fold alarm", type: "project", description: "test" } }, { ...ctx, payloadHash: "alarm-journal" });
				if (!made.ok) throw new Error(made.error.message);
				const id = String(made.value.memory_id);
				await instance.write(r.who, { op: "append", args: { memory_id: id, content: "old", request_id: "alarm-entry" } }, { ...ctx, payloadHash: "alarm-entry" });
				const compact = await instance.write(r.who, { op: "save", args: { memory_id: id, expected_revision: 2, request_id: "alarm-compact", compact: { through_seq: 1, summary: "short" } } }, { ...ctx, payloadHash: "alarm-compact" });
				expect(compact.ok).toBe(true);
				expect(await storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1000);
				await storage.deleteAlarm();
				for (const stage of ["dedupe", "ttl", "purge", "queue"]) storage.sql.exec("INSERT INTO cursors(stage, due_at) VALUES(?, ?) ON CONFLICT(stage) DO UPDATE SET due_at=excluded.due_at", stage, stage === "queue" ? 0 : Date.now() + 86_400_000);
				await instance.alarm();
				// queue runs later in this alarm and discovers the journal again, so its new fold cursor must be due immediately.
				expect(foldDue(storage.sql)).toBe(true);
				expect(await storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1100);
				await instance.alarm();
				expect(storage.sql.exec("SELECT live FROM texts WHERE node_id = ? AND part = 'entry'", id).one().live).toBe(2);
			} finally { Reflect.set(instance, "env", original); await storage.deleteAlarm(); }
		});
	});

});

describe("D2 inferred preferences and D3 promotion to me", () => {
	const agent = (who: Who, actor: WriteContext["actor"] = "agent"): WriteContext => ({ ...ctx(who), actor });
	const job = { platform: "test", userId: USER, deviceId: "job-device", me: "g-me" };
	/**
	 * Runs the profile's real scheduled alarm with its outbox rows due, as five minutes later. A write's own immediate alarm may
	 * still be running, so it first waits until the next alarm is scheduled in the future. A closed generation's alarm stops and
	 * never re-arms, so with `expectRun` false none may be left to run.
	 */
	async function fireAlarm(stub: DurableObjectStub<ProfileStore>, expectRun = true) {
		for (let i = 0, idle = 0; i < 200 && idle < 25; i++) {
			const at = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
			if (at !== null && at > Date.now() + 500) break;
			idle = at === null ? idle + 1 : 0;
			await new Promise((x) => setTimeout(x, 20));
		}
		await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("UPDATE cursors SET due_at = 0 WHERE stage LIKE 'outbox:%'"));
		const ran = await runDurableObjectAlarm(stub);
		if (expectRun) expect(ran).toBe(true);
	}
	/** The armed wakeup; while a write's own immediate alarm is still running it reads null, so this waits for that run to re-arm. */
	async function armed(stub: DurableObjectStub<ProfileStore>) {
		let at: number | null = null;
		for (const end = Date.now() + 10_000; at === null && Date.now() < end;) if ((at = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())) === null) await new Promise((x) => setTimeout(x, 20));
		return at;
	}
	type Op = { op: string; status: string; code?: string; reason?: string; created?: string[]; memory_id?: string; transfer_id?: string; activity_id?: number };
	const infer = (name: string, ref: string, description = "Owner corrections keep asking for this.") =>
		({ op: "infer_preference" as const, name, description, evidence: [{ kind: "node" as const, ref }] });

	it("refuses inference outside its item kind and subjects, keeps stated and existing identities, and never raises origin or pins", async () => inStore((storage, who) => {
		const sql = storage.sql;
		const digest = String(wired(storage, who, save({ name: "correction digest" })).memory_id), other = String(wired(storage, who, save({ name: "unrelated note" })).memory_id);
		const taken = String(wired(storage, who, { op: "save", args: { name: "Prefers tabs", type: "user", description: "agent preference" } }).memory_id);
		const stated = String(wired(storage, who, { op: "save", args: { name: "Prefers spaces", type: "user", description: "the owner said so", origin: "stated" } }).memory_id);
		const before = sql.exec<Row>("SELECT * FROM nodes WHERE id IN (?, ?) ORDER BY id", taken, stated).toArray();
		enqueue(storage, [{ kind: "preference_signal", subjects: [digest] }, { kind: "unlinked", subjects: [digest] }, { kind: "near_duplicate", subjects: [stated, taken] }]);
		const lease = next(storage, {}), item = (kind: string) => lease.items.find((i) => i.kind === kind)!;
		expect(item("preference_signal").allowed_ops).toEqual(expect.arrayContaining(["infer_preference", "promote_to_me"]));
		expect(item("unlinked").allowed_ops).not.toContain("infer_preference");
		const out = complete(storage, who, { lease_id: lease.lease_id!, results: [
			{ item_id: item("unlinked").item_id, ops: [infer("Prefers short commits", digest)] },
			{ item_id: item("preference_signal").item_id, ops: [
				{ ...infer("url evidence", digest), evidence: [{ kind: "url", ref: "https://example.invalid/x" }] } as never,
				infer("foreign evidence", other), { ...infer("no evidence", digest), evidence: [] },
				infer("Prefers tabs", digest), infer("Prefers spaces", digest), infer("Prefers short commits", digest),
				{ op: "promote_to_me", from_op: 7, company_free: true }, { op: "promote_to_me", from_op: 0, company_free: true },
				{ op: "promote_to_me", memory_id: digest, company_free: true }, { op: "promote_to_me", from_op: 5, company_free: true }] },
			{ item_id: item("near_duplicate").item_id, ops: [{ op: "promote_to_me", memory_id: stated, company_free: true }, { op: "promote_to_me", memory_id: taken, company_free: true }] }] }, job);
		const ops = (i: number) => (out.results[i] as unknown as { ops: Op[] }).ops;
		expect(ops(0)).toEqual([{ op: "infer_preference", status: "rejected", code: "validation", reason: "op_not_allowed" }]);
		const created = ops(1)[5]!.created![0]!;
		expect(ops(1)).toMatchObject([{ status: "rejected", code: "outside_subjects" }, { status: "rejected", code: "outside_subjects" }, { status: "rejected", reason: "bad_evidence" },
			{ status: "rejected", code: "already_exists" }, { status: "flagged" }, { status: "applied", created: [created] },
			{ status: "rejected", reason: "bad_target" }, { status: "rejected", reason: "bad_target" }, { status: "rejected", reason: "not_promotable" },
			{ status: "transfer_started", memory_id: created, transfer_id: uuid5(`${USER}:promote:${lease.lease_id}:${item("preference_signal").item_id}:9`) }]);
		// A stated target is only flagged for the owner; an unprotected subject preference is handed to the Worker's transfer.
		expect(ops(2)).toMatchObject([{ status: "flagged" }, { status: "transfer_started", memory_id: taken }]);
		expect(sql.exec("SELECT flagged FROM nodes WHERE id = ?", stated).one().flagged).toBe("promote_to_me: stated");
		// Nothing was overwritten; the stated preference only carries a flag for the owner.
		expect(sql.exec<Row>("SELECT * FROM nodes WHERE id IN (?, ?) ORDER BY id", taken, stated).toArray().map((r) => ({ ...r, flagged: null, seq: 0 })))
			.toEqual(before.map((r) => ({ ...r, flagged: null, seq: 0 })));
		expect(sql.exec("SELECT origin, kind, memory_type, scope FROM nodes WHERE id = ?", created).one()).toEqual({ origin: "inferred", kind: "preference", memory_type: "user", scope: "default" });
		expect(sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `n:${created}`).toArray()).toEqual([{ kind: "node", ref: digest }]);
		// The shared writer: background actors never state, and an inference needs evidence on every path.
		for (const actor of ["maintenance", "index", "keep"] as const) {
			expect(() => runWrite(storage, who, { op: "save", args: { name: `stated by ${actor}`, type: "user", description: "d", origin: "stated" } }, agent(who, actor)))
				.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "forbidden", details: { reason: "background_stated" } }) }));
		}
		expect(() => runWrite(storage, who, { op: "save", args: { name: "bare inference", type: "user", description: "d", origin: "inferred" } }, agent(who)))
			.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "validation", details: { reason: "missing_evidence" } }) }));
		// Updates keep the first origin, and only the owner pins; a pin then protects the inference from the batch.
		runWrite(storage, who, { op: "save", args: { memory_id: created, description: "agent edit", origin: "stated" } }, agent(who));
		runWrite(storage, who, { op: "save", args: { memory_id: created, description: "batch edit" } }, agent(who, "maintenance"));
		expect(sql.exec("SELECT origin, description FROM nodes WHERE id = ?", created).one()).toEqual({ origin: "inferred", description: "batch edit" });
		expect(() => runWrite(storage, who, { op: "owner", args: { action: "pin", memory_id: created } }, agent(who, "maintenance"))).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "forbidden" }) }));
		runWrite(storage, who, { op: "owner", args: { action: "pin", memory_id: created } }, agent(who, "owner"));
		expect(runWrite(storage, who, { op: "save", args: { memory_id: created, description: "after pin" } }, agent(who, "maintenance")).result.action).toBe("flagged");
		expect(sql.exec("SELECT origin, pinned, description FROM nodes WHERE id = ?", created).one()).toEqual({ origin: "inferred", pinned: 1, description: "batch edit" });
	}));

	it("owner model shows the evidence; owner pin, forget, undo and undo of the batch's inference all work on inferred rows", async () => inStore((storage, who) => {
		const sql = storage.sql, owner = agent(who, "owner");
		const digest = String(wired(storage, who, save({ name: "digest for the owner model" })).memory_id);
		enqueue(storage, [{ kind: "unprocessed_capture", subjects: [digest] }]);
		const lease = next(storage, {});
		const ops = (complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: lease.items[0]!.item_id, ops: [infer("Prefers dark mode", digest), infer("Prefers mornings", digest)] }] }, job)
			.results[0] as unknown as { ops: Op[] }).ops;
		const kept = ops[0]!.created![0]!, dropped = ops[1]!.created![0]!;
		const model = () => ownerModel(sql, { kind: "owner_model", after: null, limit: 200 }).items.map((i) => ({ id: i.id, origin: i.origin, pinned: i.pinned, evidence: i.evidence, missing: i.evidence_missing }));
		const evidence = [{ kind: "node", ref: digest, note: null }];
		expect(model()).toEqual(expect.arrayContaining([{ id: kept, origin: "inferred", pinned: false, evidence, missing: false }, { id: dropped, origin: "inferred", pinned: false, evidence, missing: false }]));
		expect(undo(storage, who, ops[1]!.activity_id!, owner).result.action).toBe("undone");
		expect(model().map((m) => m.id)).toEqual([kept]);
		runWrite(storage, who, { op: "owner", args: { action: "pin", memory_id: kept } }, owner);
		const forgot = runWrite(storage, who, { op: "owner", args: { action: "forget", memory_id: kept } }, owner).result.activity_id as number;
		expect(model()).toEqual([]);
		undo(storage, who, forgot, owner);
		expect(model()).toEqual([{ id: kept, origin: "inferred", pinned: true, evidence, missing: false }]);
	}));

	it("registers an inferred preference for its generation before acknowledging; after a failure a retry or the real alarm registers it, and a closed generation never does", async () => {
		for (const mode of ["retry", "alarm", "close"] as const) {
			const r = await registered("work");
			let created = "";
			await runInDurableObject(r.stub, async (instance, state) => {
				const sql = state.storage.sql, original = Reflect.get(instance, "env");
				const node = await instance.write(r.who, { op: "save", args: { name: "registration digest", type: "reference", description: "synthetic" } }, agent(r.who));
				if (!node.ok) throw new Error(node.error.message);
				const digest = String(node.value.memory_id);
				enqueue(state.storage, [{ kind: "preference_signal", subjects: [digest] }]);
				const jobCtx = { platform: "test", userId: r.userId };
				const lease = (await instance.maintenance(r.who, { op: "next" }, jobCtx)) as { ok: true; value: { lease_id: string; items: { item_id: number }[] } };
				const cmd = { op: "complete" as const, lease_id: lease.value.lease_id, results: [{ item_id: lease.value.items[0]!.item_id, ops: [infer("Prefers registered ids", digest)] }] };
				let failing = true;
				Reflect.set(instance, "env", { ...env, ACCOUNT: { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: (id: DurableObjectId) => {
					const real = env.ACCOUNT.get(id) as unknown as { profileAccess(...a: unknown[]): Promise<unknown>; recordNodes(...a: unknown[]): Promise<void> };
					return { profileAccess: (...a: unknown[]) => real.profileAccess(...a),
						recordNodes: async (...a: unknown[]) => { if (failing) throw new Error("synthetic registration outage"); return real.recordNodes(...a); } };
				} } });
				const indexed = (id: string) => r.account((a) => a.exec("SELECT profile FROM node_index WHERE node_id = ?", id).toArray());
				try {
					expect(await instance.maintenance(r.who, cmd, jobCtx)).toMatchObject({ ok: false, error: { code: "unavailable" } });
					created = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE origin = 'inferred'").one().id;
					expect(sql.exec("SELECT state FROM maintenance").one().state).toBe("done");
					expect(await indexed(created)).toEqual([]);
					// The completed item left a content-free intent and a wakeup, armed before it could commit.
					expect(JSON.parse(sql.exec<{ cursor: string }>("SELECT cursor FROM cursors WHERE stage LIKE 'outbox:%'").one().cursor)).toEqual({ created: [created], promote: [] });
					expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + RESUME_MS);
					failing = false;
					if (mode === "close") await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'work'"));
					if (mode !== "alarm") {
						const retry = await instance.maintenance(r.who, cmd, jobCtx);
						if (mode === "close") expect(retry).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
						else expect(retry).toMatchObject({ ok: true, value: { results: [{ replayed: true, ops: [{ status: "applied", created: [created] }] }] } });
					}
				} finally {
					Reflect.set(instance, "env", original);
				}
			});
			// Five minutes on, without any client replay: the scheduled alarm itself. A closed generation may already have stopped
			// the write's own in-flight alarm without re-arming, so there it need not run again.
			await fireAlarm(r.stub, mode !== "close");
			expect(await r.account((a) => a.exec("SELECT profile FROM node_index WHERE node_id = ?", created).toArray())).toEqual(mode === "close" ? [] : [{ profile: "work" }]);
			if (mode === "alarm") await runInDurableObject(r.stub, (_i, s) => expect(s.storage.sql.exec("SELECT count(*) AS n FROM cursors WHERE stage LIKE 'outbox:%'").one().n).toBe(0));
		}
	});

	/** A synthetic account with work, me and personal at fresh generations, and job-token tool contexts for it (the Worker checks only the caller). */
	async function jobRig() {
		const r = await registered("work", "me", "personal");
		const names = ["work", "me", "personal"], refs = names.map((p) => r.of(p).who), now = new Date().toISOString();
		await r.account((a) => {
			for (const w of refs) a.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", w.generation, w.profile, now);
			// The job tokens' device rows: the account rereads them at a job begin.
			for (const grant of [["work", "me"], ["work"]]) a.exec("INSERT INTO devices (id, name, token_hash, scopes, profiles, created_at, seq) VALUES (?, ?, ?, '[\"ingest\",\"maintenance\"]', ?, ?, 1)",
				`job-${grant.join("-")}`, `job-${grant.join("-")}`, `hash-${grant.join("-")}`, JSON.stringify(grant), now);
		});
		const tool = (profiles: string[], envOverride: Partial<Env> = {}): ToolContext => {
			const caller: Caller = { userId: r.userId, kind: "device", deviceId: `job-${profiles.join("-")}`, scopes: ["ingest", "maintenance"], profiles };
			return { env: { ...env, ...envOverride } as Env, caller, account: { caller, rules: [], profiles: refs, known: names }, platform: "test" };
		};
		const on = <T,>(p: string, f: (sql: SqlStorage) => T) => runInDurableObject(r.of(p).stub, (_i, s) => f(s.storage.sql));
		const digest = await runInDurableObject(r.of("work").stub, (_i, s) => String(runWrite(s.storage, r.of("work").who, save({ name: "synthetic correction digest" }), agent(r.of("work").who)).result.memory_id));
		await runInDurableObject(r.of("work").stub, (_i, s) => enqueue(s.storage, [{ kind: "preference_signal", subjects: [digest] }]));
		/** Leases the signal and completes it with an inference and its promotion, through the real MCP job tools. */
		const run = async (c: ToolContext, description?: string) => {
			const lease = await call<{ lease_id: string; items: { item_id: number; allowed_ops: string[] }[] }>(c, "maintenance_next", { profile: "work" });
			const args = { profile: "work", lease_id: lease.lease_id, results: [{ item_id: lease.items[0]!.item_id, ops: [infer("Prefers small reviewable diffs", digest, description), { op: "promote_to_me", from_op: 0, company_free: true }] }] };
			const out = await call<{ results: { ops: Op[]; replayed?: boolean }[] }>(c, "maintenance_complete", args);
			return { args, ops: out.results[0]!.ops, out, allowed: lease.items[0]!.allowed_ops, transfer: uuid5(`${r.userId}:promote:${lease.lease_id}:${lease.items[0]!.item_id}:1`) };
		};
		/** The real scheduled alarm of the source, once its outbox rows are due (five minutes on). */
		const alarm = (expectRun = true) => fireAlarm(r.of("work").stub, expectRun);
		const outbox = () => on("work", (sql) => sql.exec<{ cursor: string }>("SELECT cursor FROM cursors WHERE stage LIKE 'outbox:%'").toArray().map((x) => JSON.parse(x.cursor) as { created: string[]; promote: unknown[] }));
		return { ...r, tool, on, digest, run, alarm, outbox };
	}

	it("infers, then promotes with from_op through the real job tools; a replay moves nothing twice and the company-free record survives a work wipe", async () => {
		const r = await jobRig(), c = r.tool(["work", "me"]);
		const first = await r.run(c);
		const id = first.ops[0]!.created![0]!;
		expect(first.allowed).toContain("promote_to_me");
		expect(first.ops).toMatchObject([{ op: "infer_preference", status: "applied", created: [id] }, { op: "promote_to_me", status: "applied", memory_id: id, transfer_id: first.transfer }]);
		await r.on("me", (sql) => {
			expect(sql.exec("SELECT status, origin, kind, source_profile, json_extract(attrs, '$.company_free') AS cf FROM nodes WHERE id = ?", id).one()).toEqual({ status: "active", origin: "inferred", kind: "preference", source_profile: "work", cf: 1 });
			expect(sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `n:${id}`).toArray()).toEqual([{ kind: "node", ref: r.digest }]);
		});
		await r.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("moved"));
		await r.account((a) => {
			expect(a.exec("SELECT profile FROM node_index WHERE node_id = ?", id).one().profile).toBe("me");
			expect(a.exec("SELECT id, state FROM transfers WHERE node_id = ?", id).toArray()).toEqual([{ id: first.transfer, state: "committed" }]);
		});
		// A replay returns the stored outcome and re-drives the same transfer id: one record, one transfer.
		const again = await call<{ results: { ops: Op[]; replayed?: boolean }[] }>(c, "maintenance_complete", first.args);
		expect(again.results[0]).toMatchObject({ replayed: true, ops: [{ status: "applied", created: [id] }, { status: "applied", transfer_id: first.transfer }] });
		await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'inferred'").one().n).toBe(1));
		await r.account((a) => expect(a.exec("SELECT count(*) AS n FROM transfers").one().n).toBe(1));
		// The alarm still settles the item's intent: the committed move re-drives as a no-op and the row goes.
		await r.alarm();
		expect(await r.outbox()).toEqual([]);
		await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'inferred'").one().n).toBe(1));
		await r.account((a) => expect(a.exec("SELECT count(*) AS n FROM transfers").one().n).toBe(1));
		// The work wipe keeps the company-free preference in me, with its first origin.
		const ownerCaller: Caller = { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" };
		const wipes = { account: (cmd: Parameters<typeof wipeAccount>[1]) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)), (_i, s) => wipeAccount(s.storage, cmd)),
			profile: (ref: Who, step: Parameters<typeof purgeOrigin>[3]) => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)), (_i, s) => purgeOrigin(s.storage, env, ref, step)) };
		const wiped = await wipeProfile(env, wipes, ownerCaller, "work", "work");
		if (!wiped.ok) throw new Error(wiped.error.message);
		expect(JSON.parse(wiped.value.report)).toMatchObject({ state: "done", preserved: [id] });
		await r.on("me", (sql) => expect(sql.exec("SELECT status, source_profile FROM nodes WHERE id = ?", id).one()).toEqual({ status: "active", source_profile: "work" }));
	});

	it("refuses a token without me and keeps the job begin narrow: only into me, from a profile the token may also use", async () => {
		const r = await jobRig();
		const refused = await r.run(r.tool(["work"]));
		const id = refused.ops[0]!.created![0]!;
		// A work-only job is not offered promotion; one sent anyway still meets the forbidden backstop.
		expect(refused.allowed).toEqual(expect.arrayContaining(["infer_preference"]));
		expect(refused.allowed).not.toContain("promote_to_me");
		expect(refused.ops[1]).toMatchObject({ status: "rejected", code: "forbidden" });
		// A work-only job leaves registration only: no executable me intent, and the alarm moves nothing.
		expect(await r.outbox()).toEqual([{ created: [id], promote: [] }]);
		await r.alarm();
		await r.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("active"));
		await r.account((a) => {
			expect(a.exec("SELECT count(*) AS n FROM transfers").one().n).toBe(0);
			expect(a.exec("SELECT profile FROM node_index WHERE node_id = ?", id).one().profile).toBe("work");
		});
		const begin = (to: string, profiles: string[], deviceId?: string) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)), (_i, s) =>
			accountTransfer(s.storage, { op: "begin", id: crypto.randomUUID(), nodeId: id, from: "work", to, caller: { userId: r.userId, kind: "device", ...(deviceId ? { deviceId } : {}), scopes: ["ingest", "maintenance"], profiles } }));
		expect(await begin("personal", ["work", "me", "personal"], "job-work-me")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await begin("me", ["work"], "job-work")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		// The carried caller is not trusted: the device row must still grant both profiles.
		expect(await begin("me", ["work", "me"], "job-work")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await begin("me", ["work", "me"])).toMatchObject({ ok: false, error: { code: "forbidden" } });
		await r.account((a) => a.exec("UPDATE devices SET revoked_at = ?, enabled = 0 WHERE id = 'job-work-me'", new Date().toISOString()));
		expect(await begin("me", ["work", "me"], "job-work-me")).toMatchObject({ ok: false, error: { code: "forbidden" } });
		await r.account((a) => a.exec("UPDATE devices SET revoked_at = NULL, enabled = 1 WHERE id = 'job-work-me'"));
		expect(await begin("me", ["work", "me"], "job-work-me")).toMatchObject({ ok: true, value: { state: "open" } });
		// The job token still has no generic write path.
		expect(await outcome(r.tool(["work", "me"]), "save_memory", { memory_id: id, profile: "me", company_free: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});

	it("rejects a guarded promotion and leaves the record writable in work; a transport failure stays resumable and replays once", async () => {
		const guarded = await jobRig();
		const out = await guarded.run(guarded.tool(["work", "me"]), "Learned while pairing; mail vexmoor@example.com.");
		const id = out.ops[0]!.created![0]!;
		expect(out.ops[1]).toMatchObject({ status: "rejected", code: "me_sensitive_term" });
		await guarded.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n).toBe(0));
		await guarded.account((a) => expect(a.exec("SELECT state FROM transfers WHERE id = ?", out.transfer).one().state).toBe("aborted"));
		await runInDurableObject(guarded.of("work").stub, (_i, s) => {
			expect(s.storage.sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("active");
			expect(runWrite(s.storage, guarded.of("work").who, { op: "save", args: { memory_id: id, description: "still writable" } }, agent(guarded.of("work").who)).result.action).toBe("updated");
		});

		const flaky = await jobRig();
		let fail = true;
		const PROFILE = { idFromName: (n: string) => env.PROFILE.idFromName(n), get: (oid: DurableObjectId) => {
			const real = env.PROFILE.get(oid) as unknown as { maintenance(...a: unknown[]): Promise<unknown>; transfer(ref: Who, step: { op: string }): Promise<unknown> };
			return { maintenance: (...a: unknown[]) => real.maintenance(...a),
				transfer: async (ref: Who, step: { op: string }) => { if (fail && ref.profile === "me" && step.op === "land") { fail = false; throw new Error("synthetic transport failure"); } return real.transfer(ref, step); } };
		} } as unknown as Env["PROFILE"];
		const c = flaky.tool(["work", "me"], { PROFILE });
		const moving = await flaky.run(c);
		const mid = moving.ops[0]!.created![0]!;
		expect(moving.ops[1]).toMatchObject({ status: "moving", transfer_id: moving.transfer });
		await flaky.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", mid).one().status).toBe("moving"));
		// The source's real alarm finishes it from the stored intent; a later replay re-drives the same id and moves nothing again.
		await flaky.alarm();
		await flaky.account((a) => expect(a.exec("SELECT state FROM transfers WHERE id = ?", moving.transfer).one().state).toBe("committed"));
		await flaky.on("me", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", mid).one().status).toBe("active"));
		expect(await flaky.outbox()).toEqual([]);
		const replay = await call<{ results: { ops: Op[] }[] }>(c, "maintenance_complete", moving.args);
		expect(replay.results[0]!.ops[1]).toMatchObject({ status: "applied", transfer_id: moving.transfer });
		await flaky.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'inferred'").one().n).toBe(1));
		await flaky.account((a) => expect(a.exec("SELECT count(*) AS n FROM transfers").one().n).toBe(1));
	});

	/** A job-tool context whose live drive dies once at one transfer step: before any account call, or after begin and before the fence. */
	const crashing = (r: Awaited<ReturnType<typeof jobRig>>, at: "begin" | "fence") => {
		let armed = true;
		const ACCOUNT = { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: (oid: DurableObjectId) => {
			const real = env.ACCOUNT.get(oid) as unknown as { transfer(cmd: { op: string }): Promise<unknown> };
			return { transfer: async (cmd: { op: string }) => { if (armed && at === "begin" && cmd.op === "begin") { armed = false; throw new Error("synthetic crash before the first drive"); } return real.transfer(cmd); } };
		} } as unknown as Env["ACCOUNT"];
		const PROFILE = { idFromName: (n: string) => env.PROFILE.idFromName(n), get: (oid: DurableObjectId) => {
			const real = env.PROFILE.get(oid) as unknown as { maintenance(...a: unknown[]): Promise<unknown>; transfer(ref: Who, step: { op: string }): Promise<unknown> };
			return { maintenance: (...a: unknown[]) => real.maintenance(...a),
				transfer: async (ref: Who, step: { op: string }) => { if (armed && at === "fence" && step.op === "fence") { armed = false; throw new Error("synthetic transport failure before the fence"); } return real.transfer(ref, step); } };
		} } as unknown as Env["PROFILE"];
		return r.tool(["work", "me"], { ACCOUNT, PROFILE });
	};
	const wipeWork = (r: Awaited<ReturnType<typeof jobRig>>) => wipeProfile(env, {
		account: (cmd) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)), (_i, s) => wipeAccount(s.storage, cmd)),
		profile: (ref, step) => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)), (_i, s) => purgeOrigin(s.storage, env, ref, step)),
	}, { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" }, "work", "work");

	it("a crash before the first drive, or after begin and before the fence, is settled once by the source's real alarm and stops blocking a wipe", async () => {
		for (const at of ["begin", "fence"] as const) {
			const r = await jobRig();
			const out = await r.run(crashing(r, at));
			const id = out.ops[0]!.created![0]!;
			expect(out.ops[1], at).toMatchObject({ status: "moving", transfer_id: out.transfer });
			await r.account((a) => expect(a.exec("SELECT state FROM transfers").toArray()).toEqual(at === "begin" ? [] : [{ state: "open" }]));
			await r.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("active"));
			// The content-free intent: ids, the me generation and the job device it was authorized for; no token or content.
			expect(await r.outbox()).toEqual([{ created: [id], promote: [{ id: out.transfer, node: id, me: r.of("me").who.generation, device: "job-work-me", company_free: true }] }]);
			expect(await armed(r.of("work").stub)).toBeLessThanOrEqual(Date.now() + RESUME_MS);
			if (at === "fence") expect(await wipeWork(r)).toMatchObject({ ok: false, error: { code: "moving" } });
			// Recovery still drives the real promotion while the account's daily background work is paused.
			await r.account((a) => a.exec("INSERT INTO counters (day, name, value) VALUES (?, 'rows', ?) ON CONFLICT (day, name) DO UPDATE SET value = excluded.value", new Date().toISOString().slice(0, 10), ROW_PAUSE));
			await r.alarm();
			await r.alarm();
			await r.account((a) => {
				expect(a.exec("SELECT id, state FROM transfers").toArray()).toEqual([{ id: out.transfer, state: "committed" }]);
				expect(a.exec("SELECT profile FROM node_index WHERE node_id = ?", id).one().profile).toBe("me");
			});
			await r.on("me", (sql) => expect(sql.exec("SELECT id, status, origin FROM nodes WHERE origin = 'inferred'").toArray()).toEqual([{ id, status: "active", origin: "inferred" }]));
			await r.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("moved"));
			expect(await r.outbox()).toEqual([]);
			const wiped = await wipeWork(r);
			expect(wiped.ok && JSON.parse(wiped.value.report)).toMatchObject({ state: "done", preserved: [id] });
		}
	});

	it("after begin and before the fence, the account's real alarm finishes the promotion first; the source's outbox then settles the same id without a second move", async () => {
		const r = await jobRig();
		const out = await r.run(crashing(r, "fence"));
		const id = out.ops[0]!.created![0]!;
		await r.account((a) => {
			expect(a.exec("SELECT state FROM transfers").toArray()).toEqual([{ state: "open" }]);
			a.exec("UPDATE transfers SET retry_at = 0");
		});
		expect(await runDurableObjectAlarm(env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)))).toBe(true);
		await r.account((a) => expect(a.exec("SELECT state, retry_at FROM transfers").toArray()).toEqual([{ state: "committed", retry_at: null }]));
		await r.on("me", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("active"));
		expect(await r.outbox()).toHaveLength(1);
		await r.alarm();
		expect(await r.outbox()).toEqual([]);
		await r.account((a) => expect(a.exec("SELECT id, state FROM transfers").toArray()).toEqual([{ id: out.transfer, state: "committed" }]));
		await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'inferred'").one().n).toBe(1));
		await r.on("work", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("moved"));
	});

	it("on resume, a new contact field, a regenerated me, a revoked job device or a closed source refuses; the record stays writable and nothing stays open", async () => {
		for (const change of ["guard", "me", "revoked", "begun_me", "begun_revoked", "closed"] as const) {
			const r = await jobRig();
			const begun = change === "begun_me" || change === "begun_revoked";
			const out = await r.run(crashing(r, begun ? "fence" : "begin"), "Learned while pairing on the Vexmoor rollout.");
			const id = out.ops[0]!.created![0]!;
			await r.account((a) => {
				if (change === "me" || change === "begun_me") a.exec("UPDATE profiles SET generation = 'regenerated' WHERE name = 'me'");
				// begun_revoked: the intent is already open at the account, so its retry must recheck the device too.
				if (change === "revoked" || change === "begun_revoked") a.exec("UPDATE devices SET revoked_at = ?, enabled = 0 WHERE id = 'job-work-me'", new Date().toISOString());
				if (change === "closed") a.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'work'");
			});
			if (change === "guard") await r.on("work", (sql) => sql.exec("UPDATE nodes SET description = 'mail vexmoor@example.com' WHERE id = ?", id));
			await r.alarm(change !== "closed");
			if (change === "closed") expect(await runInDurableObject(r.of("work").stub, (_i, s) => s.storage.getAlarm())).toBeNull();
			await r.account((a) => expect(a.exec("SELECT state FROM transfers").toArray(), change).toEqual(change === "guard" || begun ? [{ state: "aborted" }] : []));
			await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n).toBe(0));
			await runInDurableObject(r.of("work").stub, (_i, s) => {
				expect(s.storage.sql.exec("SELECT status, json_extract(attrs, '$.transfer') AS fence FROM nodes WHERE id = ?", id).one(), change).toEqual({ status: "active", fence: null });
				if (change !== "closed") expect(runWrite(s.storage, r.of("work").who, { op: "save", args: { memory_id: id, description: "still writable" } }, agent(r.of("work").who)).result.action).toBe("updated");
			});
			// A closed source runs nothing more; every other outcome is final, so the intent is gone.
			expect((await r.outbox()).length, change).toBe(change === "closed" ? 1 : 0);
		}
	});

	it("on resume, a sensitive term registered since does not refuse the promotion (issue #3)", async () => {
		const r = await jobRig();
		const out = await r.run(crashing(r, "begin"), "Learned while pairing on the Vexmoor rollout.");
		const id = out.ops[0]!.created![0]!;
		await r.account((a) => a.exec("INSERT INTO sensitive_terms (term, source, updated_at, seq) VALUES ('Vexmoor', 'owner', ?, 1)", new Date().toISOString()));
		await r.alarm();
		await r.account((a) => expect(a.exec("SELECT state FROM transfers").toArray()).toEqual([{ state: "committed" }]));
		await r.on("me", (sql) => expect(sql.exec("SELECT status FROM nodes WHERE id = ?", id).one().status).toBe("active"));
	});

	/** Runs `body` while the profile's own account calls run `after(method, args)` once each real call has returned (an await window). */
	async function hooked(stub: DurableObjectStub<ProfileStore>, after: (method: string, args: unknown[]) => Promise<void>, body: () => Promise<void>) {
		let original: unknown;
		let hookError: unknown;
		const ACCOUNT = { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: (oid: DurableObjectId) => {
			const real = env.ACCOUNT.get(oid) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			return Object.fromEntries(["context", "recordNodes", "profileAccess", "transfer", "meter", "prunePurged"].map((m) => [m, async (...a: unknown[]) => {
				const v = await real[m]!(...a);
				try { await after(m, a); } catch (e) { hookError = e; throw e; }
				return v;
			}]));
		} };
		await runInDurableObject(stub, (i) => { original = Reflect.get(i, "env"); Reflect.set(i, "env", { ...env, ACCOUNT }); });
		try { await body(); } catch (e) { throw hookError ?? e; } finally { await runInDurableObject(stub, (i) => { Reflect.set(i, "env", original); }); }
	}
	const once = (f: (a: unknown[]) => Promise<void>) => { let ran = false; return async (m: string, a: unknown[]) => { if (m === "recordNodes" && !ran && (a[1] as string[]).length) { ran = true; await f(a); } }; };

	it("R2: a pin committed during the registration await is enforced by the source fence, immediately or by alarm; an interactive move is unchanged", async () => {
		for (const path of ["immediate", "alarm"] as const) {
			const r = await jobRig(), work = r.of("work");
			const pin = once((a) => runInDurableObject(r.of("work").stub, (_i, s) => { runWrite(s.storage, work.who, { op: "owner", args: { action: "pin", memory_id: (a[1] as string[])[0]! } }, agent(work.who, "owner")); }));
			let out: Awaited<ReturnType<typeof r.run>>;
			if (path === "immediate") await hooked(work.stub, pin, async () => { out = await r.run(r.tool(["work", "me"])); });
			else { out = await r.run(crashing(r, "begin")); await hooked(work.stub, pin, () => r.alarm()); }
			const id = out!.ops[0]!.created![0]!;
			if (path === "immediate") expect(out!.ops[1]).toMatchObject({ status: "rejected", code: "protected" });
			else expect(await r.outbox()).toEqual([]);
			await r.on("work", (sql) => expect(sql.exec("SELECT status, pinned, flagged, json_extract(attrs, '$.transfer') AS fence FROM nodes WHERE id = ?", id).one(), path)
				.toEqual({ status: "active", pinned: 1, flagged: "promote_to_me: pinned", fence: null }));
			await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n).toBe(0));
			await r.account((a) => expect(a.exec("SELECT id, state FROM transfers").toArray(), path).toEqual([{ id: out!.transfer, state: "aborted" }]));
			if (path === "immediate") {
				await r.alarm();
				expect(await r.outbox()).toEqual([]);
				await r.account((a) => expect(a.exec("SELECT count(*) AS n FROM transfers").one().n).toBe(1));
			}
			// The owner's own move of the pinned record keeps C3's interactive behavior.
			const owner: Caller = { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" };
			expect(await driveTransfer(transferPorts(env, r.userId), { id: crypto.randomUUID(), nodeId: id, from: "work", to: "personal", companyFree: false }, owner))
				.toMatchObject({ ok: true, value: { state: "committed" } });
		}
	});

	it("R3: a me generation replaced during either drive's registration await is never promoted into; a begun open transfer aborts at begin", async () => {
		for (const path of ["immediate", "alarm", "begun"] as const) {
			const r = await jobRig(), work = r.of("work"), old = r.of("me").who.generation;
			const regenerate = () => r.account((a) => { a.exec("UPDATE profiles SET generation = 'replacement' WHERE name = 'me'"); });
			let out: Awaited<ReturnType<typeof r.run>>;
			if (path === "immediate") await hooked(work.stub, once(regenerate), async () => { out = await r.run(r.tool(["work", "me"])); });
			else if (path === "alarm") { out = await r.run(crashing(r, "begin")); await hooked(work.stub, once(regenerate), () => r.alarm()); }
			else { out = await r.run(crashing(r, "fence")); await regenerate(); }
			const id = out!.ops[0]!.created![0]!;
			expect((await r.outbox())[0]?.promote ?? [], path).toEqual(path === "alarm" ? [] : [expect.objectContaining({ id: out!.transfer, me: old })]);
			if (path === "immediate") expect(out!.ops[1]).toMatchObject({ status: "rejected", code: "validation" });
			await r.alarm();
			expect(await r.outbox()).toEqual([]);
			const replacement = env.PROFILE.get(env.PROFILE.idFromName(`${r.userId}:me:replacement`));
			expect(await runInDurableObject(replacement, (_i, s) => s.storage.sql.exec("SELECT count(*) AS n FROM nodes").one().n), path).toBe(0);
			await r.on("me", (sql) => expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n).toBe(0));
			await r.on("work", (sql) => expect(sql.exec("SELECT status, json_extract(attrs, '$.transfer') AS fence FROM nodes WHERE id = ?", id).one(), path).toEqual({ status: "active", fence: null }));
			await r.account((a) => expect(a.exec("SELECT state FROM transfers").toArray(), path).toEqual(path === "begun" ? [{ state: "aborted" }] : []));
		}
	});

	it("R4: a same-lease retry merges its newly accepted promotion into the unsettled outbox, keeping the earlier intent exactly; the alarm moves both", async () => {
		const r = await jobRig(), work = r.of("work");
		const mk = (name: string) => runInDurableObject(work.stub, (_i, s) => String(runWrite(s.storage, work.who, { op: "save", args: { name, type: "user", description: "synthetic preference" } }, agent(work.who)).result.memory_id));
		const early = await mk("Prefers early intents"), held = await mk("Prefers held records");
		await runInDurableObject(work.stub, (_i, s) => { s.storage.sql.exec("DELETE FROM maintenance"); enqueue(s.storage, [{ kind: "preference_signal", subjects: [r.digest, early, held] }]); });
		// A real competing C3 move of `held`: account begin, then the source fence.
		const hold = crypto.randomUUID(), owner: Caller = { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" };
		const onAccount = <T,>(f: (s: DurableObjectStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId)), (_i, st) => f(st.storage));
		expect(await onAccount((st) => accountTransfer(st, { op: "begin", id: hold, nodeId: held, from: "work", to: "personal", caller: owner }))).toMatchObject({ ok: true });
		expect(await work.stub.transfer(work.who, { op: "fence", id: hold, nodeId: held, peer: "personal" })).toMatchObject({ ok: true, value: { state: "fenced" } });
		const c = crashing(r, "begin"), lease = await call<{ lease_id: string; items: { item_id: number }[] }>(c, "maintenance_next", { profile: "work" });
		const item = lease.items[0]!.item_id;
		const args = { profile: "work", lease_id: lease.lease_id, results: [{ item_id: item, ops: [infer("Prefers merged intents", r.digest),
			{ op: "promote_to_me", memory_id: early, company_free: true }, { op: "promote_to_me", memory_id: held, company_free: true }] }] };
		const first = await call<{ results: { reason?: string; ops: Op[] }[] }>(c, "maintenance_complete", args);
		expect(first.results[0]).toMatchObject({ reason: "moving", ops: [{ status: "applied" }, { status: "moving" }, { status: "rejected", code: "moving" }] });
		const id = first.results[0]!.ops[0]!.created![0]!, me = r.of("me").who.generation;
		const intent = (n: number, node: string) => ({ id: uuid5(`${r.userId}:promote:${lease.lease_id}:${item}:${n}`), node, me, device: "job-work-me", company_free: true });
		expect(await r.outbox()).toEqual([{ created: [id], promote: [intent(1, early)] }]);
		// The competing move aborts through the account decision and the source's abort step; the same lease is retried.
		expect(await onAccount((st) => accountTransfer(st, { op: "decide", id: hold, outcome: "abort" }))).toMatchObject({ ok: true, value: { state: "aborted" } });
		expect(await work.stub.transfer(work.who, { op: "abort", id: hold, side: "out" })).toMatchObject({ ok: true, value: { state: "aborted" } });
		// Refuse every immediate begin on this retry, so neither accepted intent can rely on the client to settle it.
		const ACCOUNT = { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: () => ({ transfer: () => { throw new Error("synthetic first-drive outage"); } }) } as unknown as Env["ACCOUNT"];
		const second = await call<{ results: { status?: string; ops: Op[] }[] }>(r.tool(["work", "me"], { ACCOUNT }), "maintenance_complete", args);
		expect(second.results[0]).toMatchObject({ status: "done", ops: [{ status: "applied", created: [id] }, { status: "moving" }, { status: "moving" }] });
		expect(await r.outbox()).toEqual([{ created: [id], promote: [intent(1, early), intent(2, held)] }]);
		await r.alarm();
		expect(await r.outbox()).toEqual([]);
		await r.on("work", (sql) => expect(sql.exec("SELECT id, status FROM nodes WHERE id IN (?, ?) ORDER BY id", early, held).toArray()).toEqual([early, held].sort().map((x) => ({ id: x, status: "moved" }))));
		await r.account((a) => expect(a.exec("SELECT id, state FROM transfers WHERE id <> ? ORDER BY id", hold).toArray()).toEqual([intent(1, early).id, intent(2, held).id].sort().map((x) => ({ id: x, state: "committed" }))));
	});

	it("R1: capped recall equals the uncapped stated-first prefix at every limit, within one profile and across work and me", async () => {
		const r = await jobRig(), work = r.of("work"), me = r.of("me");
		const owner: Caller = { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" };
		const c: ToolContext = { ...r.tool([]), caller: owner, env: { ...env, EMBEDDINGS: "off" } as Env };
		c.account = { ...c.account, caller: owner };
		const meCtx = { ...agent(me.who), meGuard: { explicit: true } };
		await runInDurableObject(work.stub, (_i, s) => {
			runWrite(s.storage, work.who, save({ name: "Kestrel spacing guide", content: "guide" }), agent(work.who));
			runWrite(s.storage, work.who, { op: "save", args: { name: "Kestrel spacing", type: "user", description: "inferred", origin: "inferred", evidence: [{ kind: "node", ref: r.digest }] } }, agent(work.who));
			runWrite(s.storage, work.who, { op: "save", args: { name: "Spacing habit", type: "user", description: "stated", content: "kestrel careful spacing always", origin: "stated" } }, agent(work.who));
		});
		await runInDurableObject(me.stub, (_i, s) => runWrite(s.storage, me.who, { op: "save", args: { name: "Kestrel spacing hint", type: "user", description: "inferred", origin: "inferred", evidence: [{ kind: "file", ref: "synthetic-fixture" }] } }, meCtx));
		type Hit = { memory_id: string; kind: string; origin: string; name: string };
		const recall = (limit: number) => call<{ results: Hit[]; truncated: boolean }>(c, "recall_memories", { keyword: "kestrel spacing", limit, profile: "work" });
		const full = (await recall(10)).results;
		expect(full.filter((h) => h.kind === "preference").map((h) => h.origin)).toEqual(["stated", "inferred", "inferred"]);
		for (let k = 1; k <= full.length; k++) {
			const capped = await recall(k);
			expect(capped.results.map((h) => h.memory_id), `limit ${k}`).toEqual(full.slice(0, k).map((h) => h.memory_id));
			expect(capped.truncated, `limit ${k}`).toBe(k < full.length);
		}
		expect((await recall(1)).results.map((h) => [h.origin, h.name])).toEqual([["stated", "Spacing habit"]]);
	});

	it("recall ranks stated preferences above inferred ones before the cap, keeps every other kind in place, and inventory pages without loss", async () => {
		const r = await jobRig(), work = r.of("work"), me = r.of("me");
		const owner: Caller = { userId: r.userId, kind: "owner", scopes: ["read", "write"], profiles: "*" };
		const c: ToolContext = { ...r.tool([]), caller: owner, env: { ...env, EMBEDDINGS: "off" } as Env };
		c.account = { ...c.account, caller: owner };
		await runInDurableObject(work.stub, (_i, s) => {
			runWrite(s.storage, work.who, { op: "save", args: { name: "Kestrel spacing", type: "user", description: "inferred from corrections", origin: "inferred", evidence: [{ kind: "node", ref: r.digest }] } }, agent(work.who));
			runWrite(s.storage, work.who, { op: "save", args: { name: "Kestrel spacing rule", type: "feedback", description: "a rule about kestrel spacing" } }, agent(work.who));
		});
		await runInDurableObject(me.stub, (_i, s) => runWrite(s.storage, me.who, { op: "save", args: { name: "Spacing habit", type: "user", description: "stated", content: "kestrel spacing, always", origin: "stated" } }, agent(me.who)));
		type Hit = { name: string; kind: string; origin: string; score: number; profile_score: number; memory_id: string };
		const recall = (keyword: string, limit = 10) => call<{ results: Hit[] }>(c, "recall_memories", { keyword, limit, profile: "work" }).then((x) => x.results);
		const full = await recall("kestrel spacing");
		const raw = [...full].sort((a, b) => b.score - a.score || b.profile_score - a.profile_score);
		const prefs = (l: Hit[]) => l.filter((h) => h.kind === "preference").map((h) => h.origin);
		expect(prefs(raw)).toEqual(["inferred", "stated"]);
		expect(prefs(full)).toEqual(["stated", "inferred"]);
		expect(full.map((h) => (h.kind === "preference" ? null : h.memory_id))).toEqual(raw.map((h) => (h.kind === "preference" ? null : h.memory_id)));
		expect(full).toEqual(statedFirst(raw));
		expect((await recall("kestrel spacing", 1)).map((h) => h.name)).toEqual(["Spacing habit"]);
		// Without an inferred match the order is the fused order itself.
		const plain = await recall("kestrel spacing rule");
		expect(plain).toEqual([...plain].sort((a, b) => b.score - a.score || b.profile_score - a.profile_score));
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { results: Hit[]; next_cursor: string | null } = await call(c, "recall_memories", { keyword: "", limit: 1, profile: "work", ...(cursor ? { cursor } : {}) });
			seen.push(...page.results.map((h) => h.memory_id));
			cursor = page.next_cursor;
		} while (cursor);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toHaveLength(4);
	});
});

describe("D4 dangling links and D5 row meter", () => {
	const DAY = 86_400_000;
	const owner = (who: Who): WriteContext => ({ actor: "owner", platform: "test", routedBy: "explicit", userId: who.userId, payloadHash: crypto.randomUUID() });
	async function made(instance: ProfileStore, who: Who, name: string, type = "reference"): Promise<string> {
		const out = await instance.write(who, { op: "save", args: { name, type, description: "synthetic" } } as WriteCommand, owner(who));
		if (!out.ok) throw new Error(out.error.message);
		return String(out.value.memory_id);
	}
	/** A current identifier edge, as an upload or an earlier write leaves it; its target may be foreign or absent here. */
	const link = (sql: SqlStorage, src: string, dst: string, profile = "") => Number(sql.exec<{ id: number }>(`INSERT INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, seq)
		VALUES (?, 'relates_to', ?, ?, 'identifier', ?, 'agent', 1) RETURNING id`, src, dst, profile, new Date().toISOString()).one().id);
	/** Parks every housekeeping stage and the dangling check a day ahead, except those named. */
	const park = (sql: SqlStorage, due: string[] = []) => {
		for (const stage of ["dedupe", "ttl", "purge", "queue", "dangling"]) sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", stage, due.includes(stage) ? 0 : Date.now() + DAY);
	};
	const items = (sql: SqlStorage, kind = "dangling_link") => sql.exec<{ subjects: string }>("SELECT subjects FROM maintenance WHERE kind = ? ORDER BY id", kind).toArray().map((r) => JSON.parse(r.subjects) as string[]);
	/** The AccountStore the alarm reaches, with nodeStates and the row reports observed; a hook runs after the answer or before the report. */
	function spied(hooks: { states?: () => Promise<void>; report?: (rows: number) => Promise<void> } = {}) {
		const asked: string[][] = [], reports: number[] = [];
		const ACCOUNT = { idFromName: (n: string) => env.ACCOUNT.idFromName(n), get: (oid: DurableObjectId) => {
			const real = env.ACCOUNT.get(oid) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			return new Proxy(real, { get(t, k) {
				if (k === "nodeStates") return async (w: Who, ids: string[]) => { asked.push(ids); const out = await t.nodeStates!(w, ids); await hooks.states?.(); return out; };
				if (k === "meter") return async (m: { rowsWritten?: number }) => { if (m.rowsWritten !== undefined) { reports.push(m.rowsWritten); await hooks.report?.(m.rowsWritten); } return t.meter!(m); };
				// Any other method passes through; a stub's members are RPC calls, so nothing here may touch them otherwise.
				return k === "then" ? undefined : (...a: unknown[]) => t[k as string]!(...a);
			} });
		} } as unknown as Env["ACCOUNT"];
		return { ACCOUNT, asked, reports };
	}
	async function withEnv<T>(instance: ProfileStore, state: DurableObjectState, over: Partial<Env>, fn: () => Promise<T>): Promise<T> {
		const original = Reflect.get(instance, "env");
		Reflect.set(instance, "env", { ...env, EMBEDDINGS: "off", ...over });
		try { return await fn(); } finally { Reflect.set(instance, "env", original); await state.storage.deleteAlarm(); }
	}

	it("queues only edges whose target is in no profile and no wipe tombstone, asks only about foreign or absent targets, and skips fenced sources", async () => {
		const r = await registered("work", "personal"), { who, stub } = r.of("work");
		const id = { absent: crypto.randomUUID(), wiped: crypto.randomUUID(), indexed: crypto.randomUUID(), foreign: crypto.randomUUID(), transfer: crypto.randomUUID(), behindFence: crypto.randomUUID() };
		await r.account((a) => {
			a.exec("INSERT INTO account_meta (key, value) VALUES (?, '1')", `wiped:${id.wiped}`);
			a.exec("INSERT INTO node_index (node_id, profile, seq) VALUES (?, 'personal', 1)", id.indexed);
			a.exec("INSERT INTO transfers (id, node_id, from_profile, to_profile, state, created_at, seq) VALUES ('transfer-backed', ?, 'work', 'personal', 'committing', '2026-10-30', 1)", id.transfer);
		});
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId));
		expect(await account.nodeStates(who, Array.from({ length: 201 }, () => crypto.randomUUID()))).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await account.nodeStates({ ...who, generation: "stale" }, [id.absent])).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		await runInDurableObject(stub, async (instance, state) => {
			const sql = state.storage.sql, spy = spied();
			await withEnv(instance, state, { ACCOUNT: spy.ACCOUNT }, async () => {
				const src = await made(instance, who, "linking source"), fenced = await made(instance, who, "fenced source");
				const present = await made(instance, who, "present target"), moving = await made(instance, who, "moving target");
				sql.exec("UPDATE nodes SET status = 'moving' WHERE id IN (?, ?)", fenced, moving);
				for (const [s, d, p] of [[src, id.absent, ""], [src, id.wiped, "personal"], [src, id.indexed, "personal"], [src, present, ""], [src, moving, ""], [fenced, id.behindFence, "personal"], [src, id.foreign, "personal"], [src, id.transfer, "personal"]] as const) link(sql, s, d, p);
				await state.storage.deleteAlarm();
				park(sql, ["dangling"]);
				await instance.alarm();
				// The account answers for foreign and locally absent targets only, with booleans; present, moving and fenced links never reach it.
				expect(spy.asked).toEqual([[id.absent, id.wiped, id.indexed, id.foreign, id.transfer]]);
				expect(items(sql)).toEqual([[src, id.absent].sort(), [src, id.foreign].sort()]);
				const cursor = sql.exec<{ cursor: string | null; due_at: number }>("SELECT cursor, due_at FROM cursors WHERE stage = 'dangling'").one();
				expect(cursor.cursor).toBeNull();
				expect(cursor.due_at).toBeGreaterThan(Date.now() + DAY - 60_000);
				// The next night's pass queues nothing twice.
				sql.exec("UPDATE cursors SET due_at = 0 WHERE stage = 'dangling'");
				await instance.alarm();
				expect(items(sql)).toHaveLength(2);
			});
		});
	});

	it("a close or recovery while the account answers writes nothing afterwards: no item, cursor, stage, error, and no re-arm when closed", async () => {
		for (const recover of [false, true]) {
			const r = await registered("work"), { who, stub } = r.of("work");
			await runInDurableObject(stub, async (instance, state) => {
				const sql = state.storage.sql, tables = () => ["cursors", "maintenance", "activity", "edges"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray());
				let at: unknown;
				const spy = spied({ states: async () => {
					if (recover) await r.account((a) => a.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
					else {
						await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping'"));
						sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'wiping')");
					}
					at = tables();
				} });
				await withEnv(instance, state, { ACCOUNT: spy.ACCOUNT }, async () => {
					link(sql, await made(instance, who, "late source"), crypto.randomUUID());
					await state.storage.deleteAlarm();
					park(sql, ["dangling"]);
					await instance.alarm();
					expect(spy.asked).toHaveLength(1);
					expect(tables(), String(recover)).toEqual(at);
					const alarm = await state.storage.getAlarm();
					if (recover) expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000); else expect(alarm).toBeNull();
				});
			});
		}
	});

	it("the real job tools lease a dangling link with end_link, flag and dismiss only; end_link ends it from its real source, another item's edge is refused and a protected source is flagged", async () => {
		for (const targetProfile of ["", "personal"]) {
			const r = await registered("work"), { who, stub } = r.of("work");
			const fixture = await runInDurableObject(stub, async (instance, state) => withEnv(instance, state, {}, async () => {
				const sql = state.storage.sql, src = await made(instance, who, "plain source"), pinned = await made(instance, who, "pinned source");
				sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", pinned);
				const a = link(sql, src, crypto.randomUUID(), targetProfile), b = link(sql, pinned, crypto.randomUUID(), "personal");
				await state.storage.deleteAlarm();
				park(sql, ["dangling"]);
				await instance.alarm();
				return { src, pinned, a, b };
			}));
			const caller: Caller = { userId: r.userId, kind: "device", deviceId: "job-dangling", scopes: ["ingest", "maintenance"], profiles: ["work"] };
			const c: ToolContext = { env, caller, account: { caller, rules: [], profiles: [who], known: ["work"] }, platform: "test" };
			type Item = { item_id: number; kind: string; subjects: string[]; allowed_ops: string[]; context: { edges: { id: number }[] } };
			const lease = await call<{ lease_id: string; items: Item[] }>(c, "maintenance_next", { profile: "work" });
			expect(lease.items.map((i) => [i.kind, i.allowed_ops, i.context.edges.map((e) => e.id)])).toEqual([
				["dangling_link", ["end_link", "flag", "dismiss"], [fixture.a]], ["dangling_link", ["end_link", "flag", "dismiss"], [fixture.b]]]);
			const reason = "its target was purged for good";
			const out = await call<{ results: { status: string; ops: { status: string; code?: string; reason?: string; activity_id?: number }[] }[] }>(c, "maintenance_complete", { profile: "work", lease_id: lease.lease_id, results: [
				{ item_id: lease.items[0]!.item_id, ops: [{ op: "save", memory_id: fixture.src, description: "not for this kind" }, { op: "end_link", edge: fixture.b, reason }, { op: "end_link", edge: fixture.a, reason }] },
				{ item_id: lease.items[1]!.item_id, ops: [{ op: "end_link", edge: fixture.b, reason }] }] });
			expect(out.results.map((x) => x.ops)).toMatchObject([
				[{ status: "rejected", reason: "op_not_allowed" }, { status: "rejected", code: "outside_subjects" }, { status: "applied" }], [{ status: "flagged" }]]);
			await runInDurableObject(stub, (_i, state) => {
				const sql = state.storage.sql;
				expect(sql.exec("SELECT id, ended_at IS NOT NULL AS ended FROM edges ORDER BY id").toArray()).toEqual([{ id: fixture.a, ended: 1 }, { id: fixture.b, ended: 0 }]);
				expect(sql.exec("SELECT flagged IS NOT NULL AS flagged FROM nodes WHERE id = ?", fixture.pinned).one().flagged).toBe(1);
				const ended = out.results[0]!.ops[2]!.activity_id!;
				expect(sql.exec("SELECT actor, op, undo IS NOT NULL AS undo FROM activity WHERE id = ?", ended).one()).toEqual({ actor: "maintenance", op: "knowledge", undo: 1 });
				expect(sql.exec("SELECT state FROM maintenance ORDER BY id").toArray()).toEqual([{ state: "done" }, { state: "done" }]);
			});
		}
	});

	it("rechecks both edge endpoints after the account await, including a reused edge id", async () => {
		const r = await registered("work"), { who, stub } = r.of("work");
		await runInDurableObject(stub, async (instance, state) => {
			const sql = state.storage.sql;
			let edge = 0, replacement = "";
			const spy = spied({ states: async () => { sql.exec("UPDATE edges SET dst = ? WHERE id = ?", replacement, edge); } });
			await withEnv(instance, state, { ACCOUNT: spy.ACCOUNT }, async () => {
				const src = await made(instance, who, "replaced edge source");
				replacement = crypto.randomUUID();
				edge = link(sql, src, crypto.randomUUID());
				await state.storage.deleteAlarm(); park(sql, ["dangling"]);
				await instance.alarm();
				expect(spy.asked).toHaveLength(1);
				expect(items(sql)).toEqual([]);
				expect(sql.exec("SELECT dst, ended_at FROM edges WHERE id = ?", edge).one()).toEqual({ dst: replacement, ended_at: null });
			});
		});
	});

	it("each dangling page reads at most 200 edges and commits in one transaction within 1,000 rows, 1 MB and 100 bound parameters", async () => inStore((storage, who) => {
		const src = String(wired(storage, who, save({ name: "many links" })).memory_id);
		const targets = Array.from({ length: 450 }, () => crypto.randomUUID());
		for (const t of targets) link(storage.sql, src, t);
		const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
		let binds = 0, bytes = 0;
		const sql = new Proxy(storage.sql, { get(t, k) {
			if (k === "exec") return (q: string, ...p: SqlStorageValue[]) => {
				binds = Math.max(binds, p.length);
				for (const v of p) if (typeof v === "string") bytes += Buffer.byteLength(v, "utf8");
				const c = t.exec(q, ...p);
				cursors.push(c);
				return c;
			};
			const v = Reflect.get(t, k, t);
			return typeof v === "function" ? v.bind(t) : v;
		} });
		const metered = { sql, transactionSync: storage.transactionSync.bind(storage) } as DurableObjectStorage;
		const now = Date.now(), pages: { edges: number; rows: number; bytes: number }[] = [];
		for (let page = danglingPage(sql, now); page.due <= now && pages.length < 20; page = danglingPage(sql, now)) {
			cursors.length = 0; bytes = 0;
			enqueueDangling(metered, page, new Set(page.edges.map((e) => e.dst)), now);
			pages.push({ edges: page.edges.length, rows: cursors.reduce((s, c) => s + c.rowsWritten, 0), bytes });
		}
		expect(pages.length).toBeGreaterThan(2);
		for (const p of pages) { expect(p.edges).toBeLessThanOrEqual(200); expect(p.rows).toBeLessThanOrEqual(1000); expect(p.bytes).toBeLessThan(1_000_000); }
		expect(binds).toBeLessThanOrEqual(100);
		const queued = items(storage.sql).map((s) => s.find((x) => x !== src));
		expect(queued.sort()).toEqual([...targets].sort());
	}));

	it("the meter counts every statement's real rowsWritten: unread RETURNING, index and full-text rows, a rolled-back write and its own upsert; a closed object keeps nothing", async () => {
		const r = await registered("work"), { who, stub } = r.of("work");
		await runInDurableObject(stub, async (instance, state) => withEnv(instance, state, {}, async () => {
			const storage = state.storage, sql = storage.sql;
			// One SqlStorage per object, so the wrapper installed at construction sees every caller's statements.
			expect(storage.sql).toBe(sql);
			const note = await made(instance, who, "metered note");
			// The write's rows are durable in the meter before it returns.
			expect(pendingRows(sql)).toBeGreaterThan(20);
			flushRows(storage);
			const before = pendingRows(sql);
			const returning = sql.exec("INSERT INTO cursors (stage, due_at) VALUES ('probe:a', 0), ('probe:b', 0) RETURNING stage");
			expect(returning.rowsWritten).toBe(2);
			returning.toArray();
			let rolled: SqlStorageCursor<Record<string, SqlStorageValue>> | undefined;
			expect(() => storage.transactionSync(() => { rolled = sql.exec("INSERT INTO cursors (stage, due_at) VALUES ('probe:c', 0)"); throw new Error("roll back"); })).toThrow("roll back");
			expect(rolled!.rowsWritten).toBe(1);
			expect(sql.exec("SELECT count(*) AS n FROM cursors WHERE stage = 'probe:c'").one().n).toBe(0);
			const text = sql.exec("INSERT INTO texts (node_id, part, revision, chunk, body, actor, created_at, live, seq) VALUES (?, 'body', 99, 0, 'indexed probe words', 'agent', '2026-10-30', 1, 1)", note);
			expect(text.rowsWritten).toBe(5);
			// 1 for the previous flush's own upsert, then 2 + 1 (rolled back, an overcount) + 5.
			expect(flushRows(storage)).toBe(1 + 2 + 1 + 5);
			expect(pendingRows(sql)).toBe(before + 9);
			sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'wiping')");
			sql.exec("DELETE FROM cursors WHERE stage LIKE 'probe:%'");
			expect(flushRows(storage)).toBe(0);
			expect(pendingRows(sql)).toBe(before + 9);
		}));
	});

	it("at 80,000 rows today the alarm pauses similarity, the dangling check and housekeeping until 00:00 UTC; agent writes, embedding, fold, the outbox and purge cleanup go on, and the next day resumes", async () => {
		const r = await registered("work"), { who, stub } = r.of("work");
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2027-03-01T23:50:00.000Z"));
		try {
			await r.account((a) => a.exec("INSERT INTO counters (day, name, value) VALUES ('2027-03-01', 'rows', ?)", ROW_PAUSE));
			await runInDurableObject(stub, async (instance, state) => {
				const sql = state.storage.sql, spy = spied(), calls = { upsert: 0, getByIds: 0, deleteByIds: 0 };
				await withEnv(instance, state, { EMBEDDINGS: "on", ACCOUNT: spy.ACCOUNT,
					AI: { async run(_m: string, a: { text: string[] }) { return { data: a.text.map(() => [1, 0]) }; } } as unknown as Ai,
					VECTORS: { async upsert() { calls.upsert++; return {}; }, async getByIds() { calls.getByIds++; return []; }, async query() { return { matches: [] }; }, async deleteByIds() { calls.deleteByIds++; return {}; } } as unknown as VectorizeIndex }, async () => {
					const note = await made(instance, who, "paused note");
					const j = await made(instance, who, "paused journal", "project");
					await instance.write(who, { op: "append", args: { memory_id: j, content: "old entry", request_id: "paused-entry" } }, owner(who));
					expect((await instance.write(who, { op: "save", args: { memory_id: j, expected_revision: 2, request_id: "paused-compact", compact: { through_seq: 1, summary: "short" } } }, owner(who))).ok).toBe(true);
					link(sql, note, crypto.randomUUID());
					const writeSeq = Number(sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = 'write_seq'").one().value);
					const similar = JSON.stringify({ seq: 0, id: "", mark: { seq: writeSeq, at: Date.now() - 61_000 }, pending: {}, evicted: 0 });
					sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('similar', ?, 0)", similar);
					sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('outbox:paused:1', ?, 0)", JSON.stringify({ created: [note], promote: [] }));
					sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('purge_cleanup', ?, 0)", JSON.stringify({ nodes: ["purged-node"], requests: [] }));
					await state.storage.deleteAlarm();
					park(sql, ["queue", "dangling"]);
					for (let i = 0; i < 5 && ((await state.storage.getAlarm()) ?? 0) <= Date.now() + 1_000; i++) await instance.alarm();
					// Paused stages wait for the new day, and nothing else is due: no spin.
					expect(await state.storage.getAlarm()).toBe(Date.parse("2027-03-02T00:00:00.000Z"));
					expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE status = 'active' AND embed_hash IS NOT card_hash").one().n).toBe(0);
					expect(calls.upsert).toBeGreaterThan(0);
					expect(foldDue(sql)).toBe(false);
					expect(sql.exec("SELECT live FROM texts WHERE node_id = ? AND part = 'entry'", j).one().live).toBe(2);
					expect(sql.exec("SELECT count(*) AS n FROM cursors WHERE stage LIKE 'outbox:%' OR stage = 'purge_cleanup'").one().n).toBe(0);
					expect(calls.deleteByIds).toBeGreaterThan(0);
					await r.account((a) => expect(a.exec("SELECT profile FROM node_index WHERE node_id = ?", note).one().profile).toBe("work"));
					expect(calls.getByIds).toBe(0);
					expect(sql.exec("SELECT cursor, last_run_at FROM cursors WHERE stage = 'similar'").one()).toEqual({ cursor: similar, last_run_at: null });
					expect(spy.asked).toEqual([]);
					expect(items(sql)).toEqual([]);
					expect(items(sql, "weekly_review")).toEqual([]);
					expect(sql.exec("SELECT last_run_at FROM cursors WHERE stage = 'queue'").one().last_run_at).toBeNull();
					expect((await instance.write(who, { op: "save", args: { name: "agent write while paused", type: "reference", description: "synthetic" } }, { ...owner(who), actor: "agent" })).ok).toBe(true);
					await r.account((a) => expect(a.exec("SELECT value FROM counters WHERE day = '2027-03-01' AND name = 'rows'").one().value).toBeGreaterThan(ROW_PAUSE));
					// 00:00 UTC: a new day's count, so every background stage runs again.
					vi.setSystemTime(new Date("2027-03-02T00:00:01.000Z"));
					await instance.alarm();
					expect(spy.asked).toHaveLength(1);
					expect(items(sql)).toHaveLength(1);
					expect(items(sql, "weekly_review")).toHaveLength(1);
					expect(sql.exec("SELECT last_run_at FROM cursors WHERE stage = 'similar'").one().last_run_at).not.toBeNull();
				});
			});
		} finally { vi.useRealTimers(); }
	});

	it("while paused, a profile under size pressure still runs housekeeping; similarity and the dangling check still wait", async () => {
		const r = await registered("work"), { who, stub } = r.of("work");
		await r.account((a) => a.exec("INSERT INTO counters (day, name, value) VALUES (?, 'rows', ?)", new Date().toISOString().slice(0, 10), ROW_PAUSE));
		await runInDurableObject(stub, async (instance, state) => {
			const sql = state.storage.sql, spy = spied();
			await withEnv(instance, state, { ACCOUNT: spy.ACCOUNT }, async () => {
				link(sql, await made(instance, who, "pressed source"), crypto.randomUUID());
				await state.storage.deleteAlarm();
				park(sql, ["queue", "dangling"]);
				Object.defineProperty(sql, "databaseSize", { configurable: true, get: () => 0.9 * OBJECT_LIMIT });
				try { await instance.alarm(); } finally { Reflect.deleteProperty(sql, "databaseSize"); }
				expect(items(sql, "weekly_review")).toHaveLength(1);
				expect(sql.exec("SELECT last_run_at FROM cursors WHERE stage = 'queue'").one().last_run_at).not.toBeNull();
				expect(spy.asked).toEqual([]);
				expect(items(sql)).toEqual([]);
			});
		});
	});

	it("a failed row report fails open and keeps its count; the next report sends it once per step and takes off only what was acknowledged", async () => {
		const r = await registered("work"), { who, stub } = r.of("work"), day = new Date().toISOString().slice(0, 10);
		await r.account((a) => a.exec("INSERT INTO counters (day, name, value) VALUES (?, 'rows', ?)", day, ROW_PAUSE));
		await runInDurableObject(stub, async (instance, state) => {
			const sql = state.storage.sql;
			let failing = true, during = 0;
			const spy = spied({ report: async () => {
				if (failing) throw new Error("synthetic meter outage");
				// Another entry point's rows, flushed while the report is in flight, are not taken off by its acknowledgement.
				const before = pendingRows(sql);
				await made(instance, who, "written during the report");
				during = pendingRows(sql) - before;
			} });
			await withEnv(instance, state, { ACCOUNT: spy.ACCOUNT }, async () => {
				for (const name of ["one", "two", "three"]) await made(instance, who, name);
				const held = pendingRows(sql);
				await state.storage.deleteAlarm();
				park(sql, ["queue"]);
				await instance.alarm();
				expect(spy.reports).toEqual([held]);
				// Fails open: housekeeping ran although the account is past the day's rows.
				expect(items(sql, "weekly_review")).toHaveLength(1);
				expect(pendingRows(sql)).toBeGreaterThan(held);
				expect(sql.exec("SELECT last_error FROM cursors WHERE stage = 'meter'").one().last_error).toContain("synthetic meter outage");
				await r.account((a) => expect(a.exec("SELECT value FROM counters WHERE day = ? AND name = 'rows'", day).one().value).toBe(ROW_PAUSE));
				failing = false;
				await r.account((a) => a.exec("UPDATE counters SET value = 0 WHERE day = ? AND name = 'rows'", day));
				const sent = pendingRows(sql);
				await instance.alarm();
				expect(spy.reports).toEqual([held, sent]);
				await r.account((a) => expect(a.exec("SELECT value FROM counters WHERE day = ? AND name = 'rows'", day).one().value).toBe(sent));
				expect(during).toBeGreaterThan(0);
				const left = pendingRows(sql);
				expect(left).toBeGreaterThanOrEqual(during);
				expect(left).toBeLessThan(sent + during);
				expect(sql.exec("SELECT last_error FROM cursors WHERE stage = 'meter'").one().last_error).toBeNull();
			});
		});
	});

	it("a failed acknowledgement fails open too: the account's pause does not stop background work, and the count stays pending", async () => {
		const r = await registered("work"), { who, stub } = r.of("work");
		await r.account((a) => a.exec("INSERT INTO counters (day, name, value) VALUES (?, 'rows', ?)", new Date().toISOString().slice(0, 10), ROW_PAUSE));
		await runInDurableObject(stub, async (instance, state) => {
			const sql = state.storage.sql, exec = sql.exec.bind(sql);
			await withEnv(instance, state, {}, async () => {
				await made(instance, who, "acknowledged later");
				await state.storage.deleteAlarm();
				park(sql, ["queue"]);
				flushRows(state.storage);
				const held = pendingRows(sql);
				sql.exec = ((q: string, ...p: SqlStorageValue[]) => {
					if (q.startsWith("UPDATE cursors SET cursor = CAST")) throw new Error("synthetic acknowledgement outage");
					return exec(q, ...p);
				}) as SqlStorage["exec"];
				try { await instance.alarm(); } finally { sql.exec = exec; }
				expect(pendingRows(sql)).toBeGreaterThanOrEqual(held);
				expect(sql.exec("SELECT last_error FROM cursors WHERE stage = 'meter'").one().last_error).toContain("synthetic acknowledgement outage");
				expect(items(sql, "weekly_review")).toHaveLength(1);
			});
		});
	});
});

describe("D5 late meter and counter failures", () => {
	it("a recovery or account close during a transfer step's vector await refuses the step and flushes no meter row; a healthy step still flushes", async () => {
		for (const mode of ["healthy", "recovering", "closing"] as const) {
			const r = await registered("work");
			await runInDurableObject(r.stub, async (instance, state) => {
				const sql = state.storage.sql, original = Reflect.get(instance, "env");
				const cursors = () => sql.exec("SELECT * FROM cursors ORDER BY stage").toArray();
				let at: unknown, hit = 0;
				Reflect.set(instance, "env", { ...env, EMBEDDINGS: "off", VECTORS: { async deleteByIds() {
					hit++;
					if (mode === "recovering") await r.account((a) => a.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
					// Only the account marks the profile; the local close comes later, so the local marker alone cannot stop the flush.
					if (mode === "closing") await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping'"));
					at = cursors();
				} } });
				try {
					const made = await instance.write(r.who, { op: "save", args: { name: "transfer source", type: "reference", description: "synthetic" } }, { actor: "owner", platform: "test", routedBy: "explicit", userId: r.userId, payloadHash: "late transfer" });
					if (!made.ok) throw new Error(made.error.message);
					const nodeId = String(made.value.memory_id), id = crypto.randomUUID();
					await state.storage.deleteAlarm();
					expect(await instance.transfer(r.who, { op: "fence", id, nodeId, peer: "personal" })).toMatchObject({ ok: true });
					expect(await instance.transfer(r.who, { op: "pack", id })).toMatchObject({ ok: true, value: { done: true } });
					expect(await instance.transfer(r.who, { op: "sent", id })).toMatchObject({ ok: true });
					// The commit deletes the source's vectors after its transaction; the stop happens during that await.
					for (let n = 0; n < 12 && !hit; n++) {
						const out = await instance.transfer(r.who, { op: "commit", id });
						expect(out, mode).toMatchObject(!hit || mode === "healthy" ? { ok: true } : { ok: false, error: { code: mode === "recovering" ? "busy" : "profile_wiped" } });
					}
					expect(hit).toBe(1);
					if (mode === "healthy") expect(cursors()).not.toEqual(at);
					else expect(cursors(), mode).toEqual(at);
				} finally { Reflect.set(instance, "env", original); await state.storage.deleteAlarm(); }
			});
		}
	});

	it("a close or recovery during a row, neuron, AI or vector await prevents every later local write", async () => {
		for (const [seam, recover] of (["rows", "neurons", "ai", "vectors"] as const).flatMap((seam) => [false, true].map((recover) => [seam, recover] as const))) {
			const r = await registered("work");
			await runInDurableObject(r.stub, async (instance, state) => {
				const sql = state.storage.sql, original = Reflect.get(instance, "env");
				const snapshot = () => ["profile_meta", "cursors", "nodes", "maintenance", "activity", "edges"].map((t) => sql.exec(`SELECT * FROM ${t}`).toArray());
				let at: unknown, ai = 0;
				const real = env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId));
				const stop = async () => {
					if (recover) await r.account((a) => a.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'reconciling')"));
					else { await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping'")); sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'wiping')"); }
					at = snapshot();
				};
				Reflect.set(instance, "env", { ...env, EMBEDDINGS: "on", ACCOUNT: { idFromName: () => r.userId, get: () => ({
					profileAccess: (...a: Parameters<typeof real.profileAccess>) => real.profileAccess(...a),
					meter: async (m: Parameters<typeof real.meter>[0]) => {
						const out = await real.meter(m);
						if (seam === "rows" && m.rowsWritten !== undefined || seam === "neurons" && m.neurons !== undefined) await stop();
						return out;
					}
				}) }, AI: { async run() { ai++; if (seam === "ai") await stop(); return { data: [[1, 0]] }; } }, VECTORS: { async upsert() { if (seam === "vectors") await stop(); }, async deleteByIds() {} } });
				try {
					await instance.write(r.who, { op: "save", args: { name: "late report", type: "reference", description: "synthetic" } }, { actor: "owner", platform: "test", routedBy: "explicit", userId: r.userId, payloadHash: "late" });
					await state.storage.deleteAlarm();
					await instance.alarm();
					expect(ai).toBe(seam === "rows" || seam === "neurons" ? 0 : 1);
					expect(snapshot(), `${seam} ${recover}`).toEqual(at);
					if (!recover) expect(await state.storage.getAlarm()).toBeNull();
				} finally { Reflect.set(instance, "env", original); await state.storage.deleteAlarm(); }
			});
		}
	});

	it("daily row counters combine profiles, reset at UTC midnight and keep the existing neuron boundary", async () => {
		const r = await registered("work", "personal"), a = env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId));
		expect(await a.meter({ day: "2027-03-01", rowsWritten: 40_000, neurons: 7999 })).toEqual({ embed: true, background: true });
		expect(await a.meter({ day: "2027-03-01", rowsWritten: 40_000, neurons: 1 })).toEqual({ embed: false, background: false });
		expect(await a.meter({ day: "2027-03-02" })).toEqual({ embed: true, background: true });
		await runInDurableObject(a, async (instance) => {
			for (const m of [{ day: "2027-02-30" }, { day: "2027-03-01", rowsWritten: -1 }, { day: "2027-03-01", neurons: NaN }]) await expect(instance.meter(m)).rejects.toThrow();
		});
		expect(await a.meter({ day: "2027-03-01" })).toEqual({ embed: false, background: false });
	});

	it("a failed durable counter flush leaves agent writes successful and retains the count for retry", async () => {
		const r = await registered("work");
		await runInDurableObject(r.stub, async (instance, state) => {
			const sql = state.storage.sql, exec = sql.exec.bind(sql);
			sql.exec = ((q: string, ...p: SqlStorageValue[]) => {
				if (q.includes("INSERT INTO cursors") && q.includes("'meter'")) throw new Error("synthetic counter outage");
				return exec(q, ...p);
			}) as SqlStorage["exec"];
			try {
				const out = await instance.write(r.who, { op: "save", args: { name: "counter outage", type: "reference", description: "synthetic" } }, { actor: "agent", platform: "test", routedBy: "explicit", userId: r.userId, payloadHash: "counter" });
				expect(out.ok).toBe(true);
			} finally { sql.exec = exec; await state.storage.deleteAlarm(); }
			expect(flushRows(state.storage)).toBeGreaterThan(20);
			expect(pendingRows(sql)).toBeGreaterThan(20);
		});
	});
});

it("core job context hides fenced subjects and incoming candidate reasons while retaining its own capture candidate", async () => {
	const owner = await contextFor(), profile = "personal", suffix = crypto.randomUUID();
	const moving = await call<{ memory_id: string }>(owner, "save_memory", { profile, name: `Core fence ${suffix}`, type: "project",
		description: "CORE_JOB_PRIVATE_DESCRIPTION", content: "CORE_JOB_PRIVATE_BODY" });
	const anchor = await call<{ memory_id: string }>(owner, "save_memory", { profile, name: `Core anchor ${suffix}`, type: "project", description: "Readable anchor" });
	const capture = await call<{ capture_id: string }>(owner, "capture_memory", { profile, name: `Core candidate ${suffix}`, content: "CORE_CAPTURE_OWN_BODY" });
	await call(owner, "record_knowledge", { profile, edges: [
		{ from: { id: moving.memory_id }, rel: "relates_to", to: { id: anchor.memory_id }, reason: "CORE_JOB_PRIVATE_MOVING_REASON", evidence: [{ kind: "node", ref: moving.memory_id }] },
		{ from: { id: capture.capture_id }, rel: "relates_to", to: { id: anchor.memory_id }, reason: "CORE_JOB_PRIVATE_CANDIDATE_REASON", evidence: [{ kind: "node", ref: capture.capture_id }] },
	] });
	const who = owner.account.profiles.find((p) => p.profile === profile)!, stub = env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${profile}:${who.generation}`));
	await runInDurableObject(stub, (_i, s) => {
		enqueue(s.storage, [{ kind: "unlinked", subjects: [moving.memory_id, anchor.memory_id] }, { kind: "unprocessed_capture", subjects: [capture.capture_id] }]);
	});
	expect(await stub.transfer(who, { op: "fence", id: crypto.randomUUID(), nodeId: moving.memory_id, peer: "work" })).toMatchObject({ ok: true, value: { state: "fenced" } });
	const job = await deviceToken(`core-context-${suffix}`, ["maintenance"], [profile], profile);
	const context = await contextFor(devicePrincipal(job.token));
	try {
		const lease = await call<{ items: { kind: string; context: { nodes: { id: string }[]; edges: { src: string; dst: string }[] } }[] }>(context, "maintenance_next", { profile, kinds: ["unlinked", "unprocessed_capture"] });
		const ordinary = lease.items.find((i) => i.kind === "unlinked")!, ownCapture = lease.items.find((i) => i.kind === "unprocessed_capture")!;
		expect(ordinary.context.nodes.map((n) => n.id)).toEqual([anchor.memory_id]);
		expect(JSON.stringify(ordinary.context)).not.toContain("CORE_JOB_PRIVATE");
		expect(JSON.stringify(ownCapture.context)).toContain("CORE_CAPTURE_OWN_BODY");
		expect(JSON.stringify(ownCapture.context)).toContain("CORE_JOB_PRIVATE_CANDIDATE_REASON");
	} finally { await runInDurableObject(stub, (_i, s) => s.storage.deleteAlarm()); }
});

it("leases an ingest-queued session capture with its current digest part, never its manifest or the superseded heuristic", async () => {
	const owner = await contextFor(), profile = "personal", id = `ctx-${crypto.randomUUID()}`, range = `claude-code:${id}:0a1b2c3d:0-1800`;
	const body = (correction: string) => JSON.stringify({ asks: [{ text: "Plan a reading schedule.", pos: 0 }], decisions: [], corrections: [{ text: correction, pos: 2 }],
		outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
	const heuristic = body("SESSION_CTX_SUPERSEDED_HEURISTIC"), consolidated = body("SESSION_CTX_CORRECTION: write dates as YYYY-MM-DD.");
	const job = await deviceToken(`session-context-${id}`, ["ingest", "maintenance"], [profile], profile);
	// The normal upload path: heuristic digest, consolidated part and the tiling manifest that queues both capture items.
	const res = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/v1/ingest`, { method: "POST",
		headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" }, body: JSON.stringify({ session: { client: "claude-code", id }, profile,
			digests: [{ range_id: range, capture_status: "heuristic", part_id: "-", sha256: sha256(heuristic), body: heuristic },
				{ range_id: range, capture_status: "consolidated", part_id: "0-1800", sha256: sha256(consolidated), body: consolidated }],
			manifests: [{ range_id: range, parts: [{ part_id: "0-1800", sha256: sha256(consolidated) }] }] }) }));
	expect((await res.json() as { results: { status: string }[] }).results.map((r) => r.status)).toEqual(["stored", "stored", "stored"]);
	const node = sha256(`session:claude-code:${id}`).slice(0, 32);
	const who = owner.account.profiles.find((p) => p.profile === profile)!, stub = env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${profile}:${who.generation}`));
	// This file shares profile storage: an earlier test leased this profile, so its 20-hour batch gate is reset for this lease.
	await runInDurableObject(stub, (_i, s) => { s.storage.sql.exec("DELETE FROM cursors WHERE stage = 'maintenance_batch'"); });
	try {
		const lease = await call<{ lease_id: string | null; items: { kind: string; subjects: string[]; allowed_ops: string[]; context: { nodes: { id: string; passage: string }[] } }[] }>(
			await contextFor(devicePrincipal(job.token)), "maintenance_next", { profile, kinds: ["unprocessed_capture", "preference_signal"] });
		expect(lease.lease_id).toEqual(expect.any(String));
		const items = lease.items.filter((i) => i.subjects.includes(node));
		expect(items.map((i) => i.kind).sort()).toEqual(["preference_signal", "unprocessed_capture"]);
		for (const item of items) {
			expect(item.allowed_ops).toContain("infer_preference");
			// The model sees the stored correction it may cite with a node pointer to this session, and nothing else of the lane.
			expect(item.context.nodes.find((n) => n.id === node)?.passage).toBe(consolidated);
		}
	} finally { await runInDurableObject(stub, (_i, s) => s.storage.deleteAlarm()); }
});

describe("owner archive restore", () => {
	const owner = (who: Who, cmd: WriteCommand) => ({ actor: "owner" as const, platform: "test", routedBy: "explicit", userId: who.userId, payloadHash: requestHash(cmd.op, cmd.args as never) });
	const run = (storage: DurableObjectStorage, who: Who, cmd: WriteCommand) => runWrite(storage, who, cmd, owner(who, cmd)).result as Record<string, unknown>;
	const fails = (storage: DurableObjectStorage, who: Who, cmd: WriteCommand) => { try { run(storage, who, cmd); } catch (e) { return (e as { failure?: { code: string; details?: { reason?: string } } }).failure; } return null; };
	const restoreCmd = (activity_id: number, request_id = `restore:${activity_id}`): WriteCommand => ({ op: "restore", args: { activity_id, request_id } });
	const forget = (storage: DurableObjectStorage, who: Who, id: string) => Number(run(storage, who, { op: "owner", args: { action: "forget", memory_id: id } }).activity_id);
	/** Every row a record owns, without the write stamp a restore renews (and the embedding mark it resets). */
	const rows = (sql: SqlStorage, id: string) => {
		const drop = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "seq" && k !== "embed_hash"));
		const edges = sql.exec("SELECT * FROM edges WHERE src = ? OR dst = ? ORDER BY id", id, id).toArray().map(drop);
		return {
			node: sql.exec("SELECT * FROM nodes WHERE id = ?", id).toArray().map(drop), edges,
			texts: sql.exec("SELECT * FROM texts WHERE node_id = ? ORDER BY rowid", id).toArray().map(drop),
			revisions: sql.exec("SELECT * FROM revisions WHERE node_id = ? ORDER BY revision", id).toArray().map(drop),
			evidence: sql.exec("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, kind, ref", JSON.stringify([`n:${id}`, ...edges.map((e) => `e:${String(e.id)}`)])).toArray().map(drop),
		};
	};

	it("lists a forget with its purge date and restores body, entries, summary, links and evidence exactly, with replay and undo", () => inStore((storage, who) => {
		const sql = storage.sql;
		const j = String(wired(storage, who, { op: "save", args: { name: "Archived journal", type: "project", kind: "journal", description: "work log", content: "opening body" } }).memory_id);
		for (const [i, text] of ["first entry", "second entry", "third entry"].entries()) wired(storage, who, { op: "append", args: { memory_id: j, content: text, request_id: `arch-e${i}` } });
		run(storage, who, { op: "save", args: { memory_id: j, expected_revision: 4, request_id: "arch-compact", compact: { through_seq: 1, summary: "first summary" } } });
		const other = String(wired(storage, who, save({ name: "Archive neighbour" })).memory_id);
		wired(storage, who, { op: "save", args: { memory_id: j, links: [{ rel: "relates_to", to: { id: other }, reason: "the neighbour explains it", evidence: [{ kind: "file", ref: "notes.md" }] }], evidence: [{ kind: "url", ref: "https://example.com/j" }] } });
		const before = rows(sql, j), content = readContent(sql, j);
		const removal = forget(storage, who, j);
		expect(sql.exec("SELECT 1 FROM nodes WHERE id = ?", j).toArray()).toHaveLength(0);
		const page = archivePage(sql, { before: null, limit: 20 });
		expect(page.items[0]).toMatchObject({ activity_id: removal, op: "forget", restorable: true, nodes: [{ id: j, name: "Archived journal", kind: "journal" }] });
		expect(Date.parse(page.items[0]!.purge_after!) - Date.now()).toBeGreaterThan(299 * 86_400_000);
		const restored = run(storage, who, restoreCmd(removal));
		expect(restored).toMatchObject({ action: "restored", restored_from: removal, nodes: [j] });
		expect(rows(sql, j)).toEqual(before);
		expect(readContent(sql, j)).toBe(content);
		expect(archivePage(sql, { before: null, limit: 20 }).items.map((i) => i.activity_id)).not.toContain(removal);
		expect(run(storage, who, restoreCmd(removal))).toMatchObject({ action: "replayed" });
		expect(fails(storage, who, restoreCmd(removal, "restore-again"))).toMatchObject({ code: "validation", details: { reason: "already_undone" } });
		// Undoing the restore removes the record again; that removal is listed and restores the same rows.
		const undone = undo(storage, who, Number(restored.activity_id), owner(who, restoreCmd(0))).result;
		expect(sql.exec("SELECT 1 FROM nodes WHERE id = ?", j).toArray()).toHaveLength(0);
		expect(archivePage(sql, { before: null, limit: 20 }).items[0]).toMatchObject({ activity_id: undone.activity_id, op: "undo", restorable: true, nodes: [{ id: j }] });
		expect(run(storage, who, restoreCmd(Number(undone.activity_id)))).toMatchObject({ action: "restored", nodes: [j] });
		expect(rows(sql, j)).toEqual(before);
	}));

	it("refuses a taken identity, a record moving or wiped now, a redacted or purged removal, other activity, a non-owner and a full profile", () => inStore((storage, who) => {
		const sql = storage.sql;
		const make = (name: string) => String(wired(storage, who, save({ name, content: `${name} body` })).memory_id);
		const unchanged = (removal: number) => expect(archivePage(sql, { before: null, limit: 50 }).items.find((i) => i.activity_id === removal)).toMatchObject({ restorable: true });
		// The same identity saved again since: its key is taken, nothing changes.
		const a = make("Taken name"), ra = forget(storage, who, a);
		expect(make("Taken name")).toBe(a);
		expect(fails(storage, who, restoreCmd(ra))).toMatchObject({ code: "revision_conflict" });
		unchanged(ra);
		// Moving now: refused with moving before anything is written.
		run(storage, who, save({ memory_id: a, retire: true }));
		sql.exec("UPDATE nodes SET status = 'moving' WHERE id = ?", a);
		expect(fails(storage, who, restoreCmd(ra))).toMatchObject({ code: "moving" });
		// Wiped since: the wipe ledger refuses it.
		const b = make("Wiped later"), rb = forget(storage, who, b);
		sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, '1')", `wiped:${b}`);
		expect(fails(storage, who, restoreCmd(rb))).toMatchObject({ code: "profile_wiped" });
		// Redacted by a wipe, or partly purged: listed as not restorable, and refused.
		const c = make("Redacted"), rc = forget(storage, who, c);
		sql.exec("UPDATE activity SET redacted = 'wipe:test:now' WHERE id = ?", rc);
		const d = make("Purged"), rd = forget(storage, who, d);
		sql.exec("DELETE FROM archive WHERE id = (SELECT min(id) FROM archive WHERE activity_id = ?)", rd);
		const listed = archivePage(sql, { before: null, limit: 50 }).items;
		expect([listed.find((i) => i.activity_id === rc), listed.find((i) => i.activity_id === rd)]).toMatchObject([{ restorable: false, reason: "undo_redacted" }, { restorable: false, reason: "purged" }]);
		expect(fails(storage, who, restoreCmd(rc))).toMatchObject({ code: "undo_redacted" });
		expect(fails(storage, who, restoreCmd(rd))).toMatchObject({ code: "not_found", details: { reason: "archive_missing" } });
		// Not a removal, not the owner, or a profile at 90% of its limit.
		const e = make("Plain update");
		const updated = Number(run(storage, who, save({ memory_id: e, content: "changed" })).activity_id);
		expect(fails(storage, who, restoreCmd(updated))).toMatchObject({ code: "not_found", details: { reason: "not_a_removal" } });
		const f = make("Owner only"), rf = forget(storage, who, f);
		expect(() => runWrite(storage, who, restoreCmd(rf), { ...owner(who, restoreCmd(rf)), actor: "maintenance" })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "forbidden" }) }));
		const full = { sql: new Proxy(sql, { get(t, k) { const v = k === "databaseSize" ? OBJECT_LIMIT : Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } }),
			transactionSync: storage.transactionSync.bind(storage) } as DurableObjectStorage;
		expect(() => runWrite(full, who, restoreCmd(rf), owner(who, restoreCmd(rf)))).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
		unchanged(rf);
		expect(run(storage, who, restoreCmd(rf))).toMatchObject({ action: "restored", nodes: [f] });
	}));
});

it("undo of a TTL digest restore archives the restored text again", async () => {
 const p = await registered("test");
 const range_id = "codex:review_ttl:01234567:0-100";
 const body = JSON.stringify({asks: [], decisions: [], corrections: [], outcomes: {}, entities: [], dropped: {asks: 0, decisions: 0, corrections: 0}});
 expect(await p.stub.ingest(p.who, {session: {client: "codex", id: "review_ttl"}, digests: [{range_id, capture_status: "heuristic", part_id: "-", sha256: sha256(body), body}], manifests: []})).toMatchObject({ok: true, value: [{status: "stored"}]});
 const removal = await runInDurableObject(p.stub, (_i, state) => {
  const sql = state.storage.sql, now = Date.now();
  sql.exec("UPDATE texts SET created_at = ? WHERE range_id = ?", new Date(now - 91 * 86400000).toISOString(), range_id);
  for (const stage of ["dedupe", "purge", "queue"]) sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?)", stage, now + 86400000);
  sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('ttl', ?, 0)", JSON.stringify({lane: "texts", after: 0}));
  expect(housekeep(state.storage, p.who, now).stage).toBe("ttl");
  expect(sql.exec("SELECT 1 FROM texts WHERE range_id = ?", range_id).toArray()).toHaveLength(0);
  return Number(sql.exec("SELECT id FROM activity WHERE op = 'ttl'").one().id);
 });
 const write = (cmd: WriteCommand) => p.stub.write(p.who, cmd, {actor: "owner", platform: "test", routedBy: "explicit", userId: p.userId, payloadHash: requestHash(cmd.op, cmd.args as never)}) as Promise<Outcome<Record<string, unknown>>>;
 // Re-ingesting a TTL range before restore must refuse a duplicate, leaving the removal restorable.
 await p.stub.ingest(p.who, {session: {client: "codex", id: "review_ttl"}, digests: [{range_id, capture_status: "heuristic", part_id: "-", sha256: sha256(body), body}], manifests: []});
 expect(await write({op: "restore", args: {activity_id: removal, request_id: `restore:${removal}`}})).toMatchObject({ok: false, error: {code: "revision_conflict"}});
 await runInDurableObject(p.stub, (_i, state) => state.storage.sql.exec("DELETE FROM texts WHERE range_id = ?", range_id));
 const restored = await write({op: "restore", args: {activity_id: removal, request_id: `restore:${removal}`}});
 expect(restored).toMatchObject({ok: true, value: {action: "restored"}});
 if (!restored.ok) return;
 await runInDurableObject(p.stub, (_i, state) => expect(state.storage.sql.exec("SELECT 1 FROM texts WHERE range_id = ?", range_id).toArray()).toHaveLength(1));
 const id = Number(restored.value.activity_id);
 expect(await write({op: "undo", args: {activity_id: id, request_id: `undo:${id}`}})).toMatchObject({ok: true, value: {action: "undone"}});
 await runInDurableObject(p.stub, (_i, state) => expect(state.storage.sql.exec("SELECT 1 FROM texts WHERE range_id = ?", range_id).toArray()).toHaveLength(0));
 const undone = await write({op: "undo", args: {activity_id: id, request_id: `undo:${id}`}});
 expect(undone).toMatchObject({ok: true, value: {action: "replayed"}});
 if (!undone.ok) return;
 const removalAgain = Number(undone.value.activity_id);
 const again = await write({op: "restore", args: {activity_id: removalAgain, request_id: "restore-again"}});
 expect(again).toMatchObject({ok: true, value: {action: "restored"}});
 if (!again.ok) return;
 expect(await write({op: "restore", args: {activity_id: removalAgain, request_id: "restore-again"}})).toMatchObject({ok: true, value: {action: "replayed", activity_id: again.value.activity_id}});
 const restoreId = Number(again.value.activity_id);
 const session = await runInDurableObject(p.stub, (_i, state) => {
  const sql = state.storage.sql;
  expect(sql.exec("SELECT 1 FROM texts WHERE range_id = ?", range_id).toArray()).toHaveLength(1);
  const n = sql.exec<{id: string; seq: number}>("SELECT n.id, n.seq FROM nodes n JOIN texts t ON n.id = t.node_id WHERE t.range_id = ?", range_id).one();
  sql.exec("UPDATE nodes SET seq = seq + 1 WHERE id = ?", n.id);
  return n;
 });
 const inverse = {op: "undo" as const, args: {activity_id: restoreId, request_id: "guarded-text-undo"}};
 expect(await write(inverse)).toMatchObject({ok: false, error: {code: "revision_conflict"}});
 await runInDurableObject(p.stub, (_i, state) => state.storage.sql.exec("UPDATE nodes SET seq = ?, status = 'moving' WHERE id = ?", session.seq, session.id));
 expect(await write(inverse)).toMatchObject({ok: false, error: {code: "moving"}});
 await runInDurableObject(p.stub, (_i, state) => {
  state.storage.sql.exec("UPDATE nodes SET status = 'active' WHERE id = ?", session.id);
  state.storage.sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, '1')", `wiped:${session.id}`);
 });
 expect(await write(inverse)).toMatchObject({ok: false, error: {code: "profile_wiped"}});
 await runInDurableObject(p.stub, (_i, state) => expect(state.storage.sql.exec("SELECT 1 FROM texts WHERE range_id = ?", range_id).toArray()).toHaveLength(1));
});

describe("Weekly strategic review", () => {
	const origin = new URL(env.RESOURCE_URL).origin, PROTOCOL = "2026-07-28";
	type Board = { as_of: string; coverage: Record<string, unknown>; items: { id: string; score: number }[] };
	type Lease = { lease_id: string; items: { item_id: number; kind: string; subjects: string[]; allowed_ops: string[]; board?: Board; context: { nodes: { id: string }[]; edges: { src: string; dst: string; reason: string }[] } }[] };
	type Done = { results: { status: string; ops: { op: string; status: string; code?: string; reason?: string; created?: string[]; activity_id?: number }[] }[] };
	/** The local batch's job client (local/batch.mjs mcpJob): tools/call on the Worker's /mcp with the job token, no other route. */
	async function job<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
		const res = await exports.default.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
			accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, "mcp-method": "tools/call", "mcp-name": name },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL,
			"io.modelcontextprotocol/clientInfo": { name: "agent-memory-batch", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
		expect(res.status).toBe(200);
		const text = await res.text(), sse = text.split("\n").find((l) => l.startsWith("data: "));
		const msg = JSON.parse(text.startsWith("{") ? text : sse!.slice(6)) as { result: { content: { text: string }[]; isError?: boolean }; error?: { code: number } };
		if (msg.error) throw Object.assign(new Error(`rpc ${msg.error.code}`), { code: `rpc_${msg.error.code}` });
		const text0 = msg.result.content[0]!.text;
		// The transport's own input validation answers in plain text, before any tool runs.
		if (msg.result.isError && !text0.startsWith("{")) throw Object.assign(new Error(text0.slice(0, 200)), { code: "input_invalid" });
		const value = JSON.parse(text0) as T & { error?: { code: string } };
		if (msg.result.isError) throw Object.assign(new Error(value.error?.code), { code: value.error?.code });
		return value;
	}
	/** The profile's real alarm with only the queue stage due and embeddings off: the nightly producer. */
	const produce = (stub: DurableObjectStub<ProfileStore>) => runInDurableObject(stub, async (instance, state) => {
		const original = Reflect.get(instance, "env");
		Reflect.set(instance, "env", { ...env, EMBEDDINGS: "off" });
		try {
			for (const s of ["dedupe", "ttl", "purge", "queue", "dangling"]) state.storage.sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", s, s === "queue" ? 0 : Date.now() + 86_400_000);
			await state.storage.deleteAlarm();
			await instance.alarm();
		} finally { Reflect.set(instance, "env", original); await state.storage.deleteAlarm(); }
	});
	/**
	 * A fresh profile of the owner's account (tests share that account) with one open High ticket assigned to the owner, one open
	 * PR awaiting the owner's review and one closed ticket, written through record_knowledge, and a job token for it.
	 */
	async function workBoardRig() {
		await contextFor();
		const name = `wr${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`, generation = crypto.randomUUID().slice(0, 8);
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => {
			const now = new Date().toISOString();
			s.storage.sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${generation}`, generation, now);
			s.storage.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", generation, name, now);
		});
		const owner = await contextFor(), who: Who = { userId: OWNER, profile: name, generation };
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${name}:${generation}`));
		const out = await call<{ nodes: { id: string }[] }>(owner, "record_knowledge", { profile: name, nodes: [
			{ kind: "ticket", key: "jira:REV-1", name: "Ship the weekly review", attrs: { state: "open", priority: "High", assignee_is_owner: true } },
			{ kind: "pr", key: "github:acme/web#7", name: "Board as-of fix", attrs: { state: "open", review_requested_from_owner: true } },
			{ kind: "ticket", key: "jira:REV-2", name: "Already done", attrs: { state: "closed" } }] });
		const [ticket, pr, closed] = out.nodes.map((n) => n.id) as [string, string, string];
		const { token } = await deviceToken(`review-${name}`, ["ingest", "maintenance"], [name], name);
		return { owner, name, who, stub, ticket, pr, closed, token };
	}
	const summary = "Two open uploaded items; the High ticket assigned to the owner leads.";
	const reviewOp = (ticket: string, pr: string) => ({ op: "strategic_review", summary, content: "As of the board's date, two uploaded items are open. The ticket leads; the PR waits on the owner's review.",
		links: [{ to: ticket, reason: "Highest-scoring open item this week", evidence: [{ kind: "node", ref: ticket }] },
			{ to: pr, reason: "Review requested from the owner", evidence: [{ kind: "node", ref: pr }, { kind: "node", ref: ticket }] }] });

	it("replays model output under OPS_SCHEMA through the local batch's confine to a real ingest, lease and completion: a default-scope preference, no promotion offered to a work-only job", async () => {
		const { name, stub, token } = await workBoardRig();
		const body = JSON.stringify({ asks: [{ text: "Fix it", pos: 10 }], decisions: [], corrections: [{ text: "Use tabs, not spaces.", pos: 1200 }],
			outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
		const RANGE = "codex:thr_replay:0a1b2c3d:0-5000", session = { client: "codex", id: "thr_replay" }, sha = sha256(body);
		const ingest = (payload: unknown) => exports.default.fetch(new Request(`${origin}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
		expect((await ingest({ session, digests: [{ range_id: RANGE, capture_status: "consolidated", part_id: "0-5000", sha256: sha, body }] })).status).toBe(200);
		expect((await ingest({ session, manifests: [{ range_id: RANGE, parts: [{ part_id: "0-5000", sha256: sha }] }] })).status).toBe(200);
		// @ts-expect-error local/ is plain JavaScript without declarations
		const { batch, OPS_SCHEMA } = await import("../local/batch.mjs") as { batch: (o: unknown) => Promise<{ profiles: Record<string, { status: string; dropped_ops: number; receipts: { kind: string; ops: { op: string; status: string; created?: string[] }[] }[] }> }>; OPS_SCHEMA: unknown };
		expect(JSON.stringify(OPS_SCHEMA)).not.toContain('"scope"');
		const seen: { kind: string; subjects: string[]; allowed_ops: string[] }[] = [];
		// Strict structured output under OPS_SCHEMA: every field present, null where unused; promotion is attempted anyway.
		const runner = { available: true, classification: "denied", async exec({ prompt }: { prompt: string }) {
			const items = JSON.parse(prompt.split("<items>\n")[1]!.split("\n</items>")[0]!) as typeof seen;
			seen.push(...items);
			return { kind: "ok", part: { results: items.map((i) => ({ item_id: (i as unknown as { item_id: number }).item_id, ops: i.kind === "preference_signal"
				? [{ op: "infer_preference", name: "Prefers tabs", description: "Indents with tabs.", why: null, how_to_apply: null, evidence: [{ kind: "node", ref: i.subjects[0] }] },
					{ op: "promote_to_me", memory_id: null, from_op: 0, company_free: true }] : [{ op: "dismiss" }] })) } };
		} };
		process.env.AGENT_MEMORY_HOME = tempDir("am-replay-");
		const report = await batch({ runner, config: { batch_profiles: [name] }, server: { call: (tool: string, args: Record<string, unknown>) => job(token, tool, args) } });
		const signal = seen.find((i) => i.kind === "preference_signal")!;
		expect(signal.allowed_ops).toContain("infer_preference");
		expect(seen.every((i) => !i.allowed_ops.includes("promote_to_me"))).toBe(true);
		const r = report.profiles[name]!;
		expect(r).toMatchObject({ status: "completed", dropped_ops: 1 });
		const ops = r.receipts.find((x) => x.kind === "preference_signal")!.ops;
		expect(ops).toEqual([{ op: "infer_preference", status: "applied", activity_id: expect.any(Number), created: [expect.any(String)] }]);
		await runInDurableObject(stub, async (_i, s) => {
			const sql = s.storage.sql, id = ops[0]!.created![0]!;
			expect(sql.exec("SELECT kind, memory_type, origin, scope, status FROM nodes WHERE id = ?", id).one()).toEqual({ kind: "preference", memory_type: "user", origin: "inferred", scope: "default", status: "active" });
			expect(sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `n:${id}`).toArray()).toEqual([{ kind: "node", ref: signal.subjects[0] }]);
			await s.storage.deleteAlarm();
		});
	});

	it("over the job HTTP route the weekly item names the board's open items, the review becomes one document with reasoned links, and work_board returns it", async () => {
		const { owner, name, stub, ticket, pr, token } = await workBoardRig();
		await produce(stub);
		const lease = await job<Lease>(token, "maintenance_next", { profile: name, limit: 40, lease_seconds: 900 });
		const item = lease.items.find((i) => i.kind === "weekly_review")!;
		expect([...item.subjects].sort()).toEqual([ticket, pr].sort());
		expect(item.allowed_ops).toEqual(["strategic_review", "dismiss"]);
		expect(item.board).toMatchObject({ covers_only_uploaded_data: true, coverage: { open: 2, scored: 2, without_state: 0, partial: false, reviewed: 2, profile_local: true } });
		expect(item.board!.items.map((i) => i.id)).toEqual([ticket, pr]);
		const done = await job<Done>(token, "maintenance_complete", { profile: name, lease_id: lease.lease_id, results: [{ item_id: item.item_id, ops: [reviewOp(ticket, pr)] }] });
		expect(done.results[0]).toMatchObject({ status: "done", ops: [{ op: "strategic_review", status: "applied" }] });
		// The new document's embedding wakeup is not under test; it must not fire after the test ends.
		await runInDurableObject(stub, (_i, s) => s.storage.deleteAlarm());
		const id = done.results[0]!.ops[0]!.created![0]!;
		await runInDurableObject(stub, (_i, s) => {
			const sql = s.storage.sql;
			const n = sql.exec<{ kind: string; memory_type: string; origin: string; attrs: string; description: string }>("SELECT kind, memory_type, origin, attrs, description FROM nodes WHERE id = ?", id).one();
			expect({ ...n, attrs: JSON.parse(n.attrs) }).toEqual({ kind: "document", memory_type: "reference", origin: "agent", description: summary,
				attrs: { kind: "strategic_review", item: item.item_id, as_of: item.board!.as_of, coverage: item.board!.coverage } });
			const links = sql.exec<{ id: number; dst: string; rel: string; basis: string; reason: string; actor: string }>("SELECT id, dst, rel, basis, reason, actor FROM edges WHERE src = ? ORDER BY reason", id).toArray();
			expect(links.map((l) => ({ dst: l.dst, rel: l.rel, basis: l.basis, reason: l.reason, actor: l.actor }))).toEqual([
				{ dst: ticket, rel: "relates_to", basis: "judgment", reason: "Highest-scoring open item this week", actor: "maintenance" },
				{ dst: pr, rel: "relates_to", basis: "judgment", reason: "Review requested from the owner", actor: "maintenance" }]);
			expect(sql.exec("SELECT owner, ref FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, ref", JSON.stringify(links.map((l) => `e:${l.id}`))).toArray())
				.toEqual([{ owner: `e:${links[0]!.id}`, ref: ticket }, ...[pr, ticket].sort().map((ref) => ({ owner: `e:${links[1]!.id}`, ref }))]);
			// The items it discusses are untouched.
			expect(sql.exec("SELECT revision FROM nodes WHERE id IN (?, ?)", ticket, pr).toArray()).toEqual([{ revision: 1 }, { revision: 1 }]);
		});
		// Registered for this generation before the result came back.
		expect(await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => s.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).toArray())).toEqual([{ profile: name }]);
		const b = await call<{ review: Record<string, unknown> }>(owner, "work_board", { profile: name });
		expect(b.review).toMatchObject({ id, profile: name, description: summary, age_days: 0, data_as_of: item.board!.as_of, coverage: item.board!.coverage });
	});

	it("refuses links and pointers outside the subjects, other ops, a moving subject and payloads over the schema caps, writing nothing", async () => {
		const { name, stub, ticket, pr, closed, token } = await workBoardRig();
		await produce(stub);
		const lease = await job<Lease>(token, "maintenance_next", { profile: name });
		const item = lease.items.find((i) => i.kind === "weekly_review")!, base = reviewOp(ticket, pr), link = base.links[0]!;
		const send = (ops: unknown[]) => job<Done>(token, "maintenance_complete", { profile: name, lease_id: lease.lease_id, results: [{ item_id: item.item_id, ops }] });
		for (const op of [{ ...base, links: Array.from({ length: 21 }, () => link) }, { ...base, summary: "s".repeat(601) }, { ...base, content: "c".repeat(20_001) },
			{ ...base, links: [{ ...link, evidence: [{ kind: "ticket", ref: "REV-1" }] }] }]) await expect(send([op])).rejects.toMatchObject({ code: "input_invalid" });
		await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("UPDATE nodes SET status = 'moving' WHERE id = ?", pr));
		const out = await send([{ op: "save", memory_id: ticket, description: "not for this kind" }, { ...base, links: [{ ...link, to: closed }] },
			{ ...base, links: [{ ...link, evidence: [{ kind: "node", ref: closed }] }] }, base]);
		expect(out.results[0]!.ops).toMatchObject([{ status: "rejected", reason: "op_not_allowed" }, { status: "rejected", code: "outside_subjects" },
			{ status: "rejected", code: "outside_subjects" }, { status: "rejected", code: "not_found" }]);
		await runInDurableObject(stub, async (_i, s) => {
			const sql = s.storage.sql;
			expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'document'").one().n).toBe(0);
			expect(sql.exec("SELECT count(*) AS n FROM requests WHERE request_id LIKE 'maint:%'").one().n).toBe(0);
			expect(sql.exec("SELECT count(*) AS n FROM activity WHERE actor = 'maintenance'").one().n).toBe(0);
			expect(sql.exec("SELECT revision FROM nodes WHERE id = ?", ticket).one().revision).toBe(1);
			await s.storage.deleteAlarm();
		});
	});

	it("a repeated completion replays; one interrupted before its outcome reports and re-registers the same document on a new lease; the owner's undo removes it with its links", async () => {
		const { owner, name, who, stub, ticket, pr, token } = await workBoardRig();
		await produce(stub);
		const lease = await job<Lease>(token, "maintenance_next", { profile: name });
		const item = lease.items.find((i) => i.kind === "weekly_review")!;
		const args = { profile: name, lease_id: lease.lease_id, results: [{ item_id: item.item_id, ops: [reviewOp(ticket, pr)] }] };
		const id = (await job<Done>(token, "maintenance_complete", args)).results[0]!.ops[0]!.created![0]!;
		expect(await job<Done>(token, "maintenance_complete", args)).toMatchObject({ results: [{ status: "done", replayed: true }] });
		// As if the process died after the document committed and before the item's outcome: still leased, no outbox, unregistered.
		const index = () => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => s.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).toArray());
		await runInDurableObject(stub, async (_i, s) => {
			const sql = s.storage.sql, past = (ms: number) => new Date(Date.now() - ms).toISOString();
			sql.exec("UPDATE maintenance SET state = 'leased', done_at = NULL, outcome = NULL, lease_until = ? WHERE id = ?", past(1_000), item.item_id);
			sql.exec("DELETE FROM cursors WHERE stage LIKE 'outbox:%'");
			sql.exec("UPDATE cursors SET last_run_at = ? WHERE stage = 'maintenance_batch'", past(21 * 3_600_000));
			await s.storage.deleteAlarm();
		});
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => s.storage.sql.exec("DELETE FROM node_index WHERE node_id = ?", id));
		expect(await index()).toEqual([]);
		const again = await job<Lease>(token, "maintenance_next", { profile: name });
		expect(again.items.find((i) => i.kind === "weekly_review")?.item_id).toBe(item.item_id);
		const retry = await job<Done>(token, "maintenance_complete", { profile: name, lease_id: again.lease_id, results: [{ item_id: item.item_id, ops: [{ ...reviewOp(ticket, pr), summary: "A different second draft." }] }] });
		expect(retry.results[0]).toMatchObject({ status: "done", ops: [{ status: "applied", reason: "already_written", created: [id] }] });
		expect(await index()).toEqual([{ profile: name }]);
		const activityId = await runInDurableObject(stub, async (_i, s) => {
			const sql = s.storage.sql;
			expect(sql.exec("SELECT id, description FROM nodes WHERE kind = 'document'").toArray()).toEqual([{ id, description: summary }]);
			await s.storage.deleteAlarm();
			return sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'save' AND actor = 'maintenance' AND targets LIKE ?", `%${id}%`).one().id;
		});
		await runInDurableObject(stub, (_i, s) => {
			const out = undo(s.storage, who, activityId, { actor: "owner", platform: "test", routedBy: "explicit", userId: OWNER });
			expect(out.result).toMatchObject({ action: "undone" });
			expect(s.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", id).one().n).toBe(0);
			expect(s.storage.sql.exec("SELECT count(*) AS n FROM edges WHERE src = ?", id).one().n).toBe(0);
			expect(s.storage.sql.exec("SELECT revision, status FROM nodes WHERE id IN (?, ?)", ticket, pr).toArray()).toEqual([{ revision: 1, status: "active" }, { revision: 1, status: "active" }]);
		});
		expect((await call<{ review: unknown }>(owner, "work_board", { profile: name })).review).toBeNull();
	});

	it("an empty board gets one truthful weekly item per slot; a review in the last seven days skips the next slot; me gets none and refuses one; a closing generation writes nothing", async () => {
		const r = await registered("work", "me"), { who, stub } = r.of("work"), meStub = r.of("me").stub;
		const caller: Caller = { userId: r.userId, kind: "device", deviceId: "job-review", scopes: ["ingest", "maintenance"], profiles: ["work", "me"] };
		const c: ToolContext = { env, caller, account: { caller, rules: [], profiles: [who, r.of("me").who], known: ["work", "me"] }, platform: "test" };
		const weekly = (st = stub) => runInDurableObject(st, (_i, s) => s.storage.sql.exec<{ subjects: string }>("SELECT subjects FROM maintenance WHERE kind = 'weekly_review'").toArray());
		// A first job call binds each fresh store (its alarm runs nothing before that) and finds nothing queued yet.
		for (const p of ["work", "me"]) expect(await call<Lease>(c, "maintenance_next", { profile: p })).toMatchObject({ lease_id: null, items: [] });
		await produce(stub);
		await produce(stub);
		await produce(meStub);
		expect(await weekly()).toEqual([{ subjects: "[]" }]);
		expect(await weekly(meStub)).toEqual([]);
		const lease = await call<Lease>(c, "maintenance_next", { profile: "work" }), item = lease.items[0]!;
		expect(item.board).toMatchObject({ coverage: { open: 0, scored: 0, without_state: 0, reviewed: 0, partial: false }, items: [] });
		const empty = { op: "strategic_review", summary: "No open uploaded items as of this board.", content: "The uploaded board had no open items.", links: [] };
		const complete = (ops: unknown[], profile = "work", l = lease, i = item) => outcome(c, "maintenance_complete", { profile, lease_id: l.lease_id, results: [{ item_id: i.item_id, ops }] });
		await r.account((a) => a.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'work'"));
		expect(await complete([empty])).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		await r.account((a) => a.exec("UPDATE profiles SET status = 'active' WHERE name = 'work'"));
		expect(await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'document'").one().n)).toBe(0);
		const out = await complete([{ ...empty, links: [{ to: "not-a-subject", reason: "nothing here to link", evidence: [{ kind: "node", ref: "not-a-subject" }] }] }, empty]);
		expect(out).toMatchObject({ ok: true, value: { results: [{ status: "done", ops: [{ status: "rejected", code: "outside_subjects" }, { status: "applied" }] }] } });
		await runInDurableObject(stub, (_i, s) => s.storage.deleteAlarm());
		// The next slot: a review written in the last seven days skips it; without one it is queued.
		const DAY = 86_400_000, nextSlot = (Math.floor(Date.now() / (7 * DAY)) + 1) * 7 * DAY + 1;
		const queueAt = (now: number) => runInDurableObject(stub, async (_i, s) => {
			s.storage.sql.exec("UPDATE cursors SET due_at = 0 WHERE stage = 'queue'");
			housekeep(s.storage, who, now);
			await s.storage.deleteAlarm();
		});
		await queueAt(nextSlot);
		expect(await weekly()).toHaveLength(1);
		await runInDurableObject(stub, (_i, s) => s.storage.sql.exec("UPDATE nodes SET status = 'retired' WHERE kind = 'document'"));
		await queueAt(nextSlot);
		expect(await weekly()).toHaveLength(2);
		// No background write lands in me, even from an item put there by hand.
		await runInDurableObject(meStub, (_i, s) => enqueue(s.storage, [{ kind: "weekly_review", subjects: [] }]));
		const meLease = await call<Lease>(c, "maintenance_next", { profile: "me" });
		expect(await complete([empty], "me", meLease, meLease.items[0]!)).toMatchObject({ ok: true, value: { results: [{ ops: [{ status: "rejected", code: "forbidden" }] }] } });
		expect(await runInDurableObject(meStub, (_i, s) => s.storage.sql.exec("SELECT count(*) AS n FROM nodes").one().n)).toBe(0);
	});
 it("regression privacy: a weekly lease keeps a now-moving subject and its edges opaque",async()=>{
  const r=await workBoardRig();await produce(r.stub);
  await runInDurableObject(r.stub,(_i,s)=>{
   s.storage.sql.exec("UPDATE nodes SET description='L3_MOVING_PRIVATE_PAYLOAD' WHERE id=?",r.ticket);
   s.storage.sql.exec("INSERT INTO edges(src,rel,dst,dst_profile,basis,reason,recorded_at,actor,seq) VALUES (?,'relates_to',?,'','judgment','L3_MOVING_PRIVATE_REASON',?,'test',1)",r.ticket,r.pr,new Date().toISOString());
  });
  const fence=await r.stub.transfer(r.who,{op:"fence",id:crypto.randomUUID(),nodeId:r.ticket,peer:"personal"});
  expect(fence).toMatchObject({ok:true,value:{state:"fenced"}});
  const lease=await job<Lease>(r.token,"maintenance_next",{profile:r.name});const item=lease.items.find(i=>i.kind==="weekly_review")!;
  expect(item.board!.items.some(i=>i.id===r.ticket)).toBe(false);
  expect(JSON.stringify(item)).not.toContain("L3_MOVING_PRIVATE");
 });
 it.each(["undo", "forget"] as const)("regression receipt: owner %s between write commit and item outcome survives a new lease",async(action)=>{
  const r=await workBoardRig();await produce(r.stub);
  const lease=await job<Lease>(r.token,"maintenance_next",{profile:r.name});const item=lease.items.find(i=>i.kind==="weekly_review")!;
  let created="", receipt="";
  await runInDurableObject(r.stub,async (_i,s)=>{
   let calls=0;const storage={sql:s.storage.sql,transactionSync:(fn:()=>unknown)=>{if(++calls===2)throw new Error("injected outcome crash");return s.storage.transactionSync(fn);}} as DurableObjectStorage;
   expect(()=>complete(storage,r.who,{lease_id:lease.lease_id,results:[{item_id:item.item_id,ops:[reviewOp(r.ticket,r.pr) as never]}]},{platform:"review",userId:OWNER})).toThrow("injected outcome crash");
   const row=s.storage.sql.exec<{id:string}>("SELECT id FROM nodes WHERE json_extract(attrs,'$.kind')='strategic_review'").one();created=row.id;
   receipt=JSON.stringify(s.storage.sql.exec("SELECT * FROM requests WHERE node_id=? AND op='save'",created).toArray());
   expect(s.storage.sql.exec("SELECT state FROM maintenance WHERE id=?",item.item_id).one().state).toBe("leased");
   const aid=s.storage.sql.exec<{id:number}>("SELECT id FROM activity WHERE actor='maintenance' AND op='save'").one().id;
   const owner = {actor:"owner" as const,platform:"review",routedBy:"explicit",userId:OWNER};
   if (action === "undo") undo(s.storage,r.who,aid,owner);
   else runWrite(s.storage,r.who,{op:"owner",args:{memory_id:created,action:"forget"}},{...owner,payloadHash:"forget"});
   expect(s.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE id=?",created).one().n).toBe(0);
   s.storage.sql.exec("UPDATE maintenance SET lease_until=? WHERE id=?",new Date(Date.now()-1000).toISOString(),item.item_id);
   s.storage.sql.exec("UPDATE cursors SET last_run_at=? WHERE stage='maintenance_batch'",new Date(Date.now()-21*3600000).toISOString());
   await s.storage.deleteAlarm();
  });
  const again=await job<Lease>(r.token,"maintenance_next",{profile:r.name});
  const done=await job<Done>(r.token,"maintenance_complete",{profile:r.name,lease_id:again.lease_id,results:[{item_id:item.item_id,ops:[{...reviewOp(r.ticket,r.pr),summary:"A changed retry draft",content:"Never recreate this owner-undone review."}]}]});
  await runInDurableObject(r.stub,async (_i,s)=>{await s.storage.deleteAlarm();
   expect(done.results[0]!.ops[0]).toMatchObject({status:"applied",reason:"already_written"});
   expect(s.storage.sql.exec("SELECT count(*) AS n FROM activity WHERE actor='maintenance' AND op='save'").one().n).toBe(1);
   expect(s.storage.sql.exec("SELECT count(*) AS n FROM nodes WHERE id=?",created).one().n).toBe(0);
   expect(JSON.stringify(s.storage.sql.exec("SELECT * FROM requests WHERE node_id=? AND op='save'",created).toArray())).toBe(receipt);
  });
  await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)),(_i,s)=>expect(s.storage.sql.exec("SELECT count(*) AS n FROM node_index WHERE node_id=?",created).one().n).toBe(0));
 });

	it("regression privacy: candidate payload stays in its capture item and readable backlinks keep opaque targets", async () => {
		const r = await workBoardRig();
		const cap = await call<{ capture_id: string }>(r.owner, "capture_memory", { profile: r.name,
			content: "L3_CANDIDATE_BODY pending owner review", name: "L3_CANDIDATE_NAME" });
		await call(r.owner, "record_knowledge", { profile: r.name, edges: [{ from: { id: cap.capture_id }, rel: "relates_to", to: { id: r.ticket },
			reason: "L3_CANDIDATE_REASON", evidence: [{ kind: "file", ref: "L3_CANDIDATE_EVIDENCE" }] }] });
		await runInDurableObject(r.stub, (_i, s) => {
			enqueue(s.storage, [{ kind: "unprocessed_capture", subjects: [cap.capture_id] }]);
			s.storage.sql.exec("INSERT INTO edges (src, rel, dst, dst_profile, basis, reason, recorded_at, actor, seq) VALUES (?, 'relates_to', 'opaque-absent', '', 'judgment', 'Readable source reason', ?, 'test', 1)", r.ticket, new Date().toISOString());
		});
		await produce(r.stub);
		const lease = await job<Lease>(r.token, "maintenance_next", { profile: r.name });
		const weekly = lease.items.find((i) => i.kind === "weekly_review")!, capture = lease.items.find((i) => i.kind === "unprocessed_capture")!;
		expect(JSON.stringify(weekly)).not.toContain("L3_CANDIDATE_");
		expect(weekly.context.edges).toContainEqual(expect.objectContaining({ src: r.ticket, dst: "opaque-absent", reason: "Readable source reason" }));
		expect(JSON.stringify(capture.context)).toContain("L3_CANDIDATE_BODY");
		expect(JSON.stringify(capture.context)).toContain("L3_CANDIDATE_REASON");
		await runInDurableObject(r.stub, (_i, s) => s.storage.deleteAlarm());
	});

});

describe("v2 M1: replay-safe leases, stale records, eval suggestions and recall retention", () => {
	it("gives a capture item only the parts its accepted manifest lists", async () => {
		await inStore((storage, who) => {
			const one = (text: string) => JSON.stringify({ asks: [{ text, pos: 1 }], decisions: [], corrections: [], outcomes: {}, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
			const range = "codex:ctx-m:0a1b2c3d:0-10", p = (id: string, text: string) => { const body = one(text); return { range_id: range, capture_status: "consolidated" as const, part_id: id, sha256: sha256(body), body }; };
			const whole = p("0-10", "listed whole"), a = p("0-5", "unlisted half"), b = p("5-10", "unlisted other half");
			expect(ingest(storage, who, { session: { client: "codex", id: "ctx-m" }, digests: [whole, a, b], manifests: [{ range_id: range, parts: [{ part_id: "0-10", sha256: whole.sha256 }] }] })
				.map((r) => r.status)).toEqual(["stored", "stored", "stored", "stored"]);
			const item = next(storage, { kinds: ["unprocessed_capture"] }).items[0]!;
			const text = JSON.stringify(item.context);
			expect(text).toContain("listed whole");
			expect(text).not.toContain("unlisted");
		});
	});

	const DAY = 86_400_000, job = { platform: "test", userId: USER };
	const only = (storage: DurableObjectStorage, who: Who, stage: Stage) => {
		for (const s of ["dedupe", "ttl", "purge", "queue"]) {
			storage.sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", s, s === stage ? 0 : Date.now() + DAY);
		}
		return housekeep(storage, who);
	};
	const queued = (sql: SqlStorage, kind: string) => sql.exec<{ subjects: string }>("SELECT subjects FROM maintenance WHERE kind = ? ORDER BY id", kind).toArray().map((r) => JSON.parse(r.subjects)[0] as string);

	it("returns one lease per request_id without a second attempt, refuses changed arguments and reports an expired lease", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			enqueue(storage, [{ kind: "unlinked", subjects: ["m1-a"] }, { kind: "unlinked", subjects: ["m1-b"] }]);
			const first = next(storage, { request_id: "run-1", lease_seconds: 60 });
			const clock = sql.exec("SELECT last_run_at FROM cursors WHERE stage = 'maintenance_batch'").one().last_run_at;
			const again = next(storage, { request_id: "run-1", lease_seconds: 60 });
			expect(again).toMatchObject({ lease_id: first.lease_id, lease_until: first.lease_until, replayed: true });
			expect(again.items.map((i) => i.item_id)).toEqual(first.items.map((i) => i.item_id));
			expect(sql.exec("SELECT attempts FROM maintenance ORDER BY id").toArray().map((r) => r.attempts)).toEqual([1, 1]);
			expect(sql.exec("SELECT last_run_at FROM cursors WHERE stage = 'maintenance_batch'").one().last_run_at).toBe(clock);
			// A v1 runner without an id is gated as before; the same id with other arguments is refused.
			expect(next(storage, { lease_seconds: 60 })).toMatchObject({ lease_id: null, items: [], next_allowed_at: expect.any(String) });
			expect(() => next(storage, { request_id: "run-1", lease_seconds: 30 })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "idempotency_mismatch" }) }));
			// Only items still leased come back once one is completed.
			complete(storage, who, { lease_id: first.lease_id!, results: [{ item_id: first.items[0]!.item_id, ops: [{ op: "dismiss" }] }] }, job);
			expect(next(storage, { request_id: "run-1", lease_seconds: 60 }).items.map((i) => i.item_id)).toEqual([first.items[1]!.item_id]);
			sql.exec("UPDATE profile_meta SET value = json_set(value, '$.lease_until', ?) WHERE key LIKE 'lease\\_request%' ESCAPE '\\'", new Date(Date.now() - 60_000).toISOString());
			expect(next(storage, { request_id: "run-1", lease_seconds: 60 })).toMatchObject({ lease_id: null, items: [], reason: "lease_expired" });
			// A later run's lease keeps run-1's binding: a delayed run-1 retry, past both gates, still finds it expired, and with other
			// arguments is still refused; it never becomes a new run.
			const past = () => sql.exec("UPDATE cursors SET last_run_at = ? WHERE stage = 'maintenance_batch'", new Date(Date.now() - 21 * 3_600_000).toISOString());
			sql.exec("UPDATE maintenance SET lease_until = '2000-01-01T00:00:00.000Z' WHERE state = 'leased'");
			past();
			const second = next(storage, { request_id: "run-2", lease_seconds: 60 });
			expect(second.lease_id).toEqual(expect.any(String));
			sql.exec("UPDATE maintenance SET lease_until = '2000-01-01T00:00:00.000Z' WHERE state = 'leased'");
			past();
			const attempts = () => sql.exec("SELECT attempts FROM maintenance ORDER BY id").toArray().map((r) => r.attempts);
			const before = attempts();
			expect(next(storage, { request_id: "run-1", lease_seconds: 60 })).toMatchObject({ lease_id: null, items: [], reason: "lease_expired" });
			expect(() => next(storage, { request_id: "run-1", lease_seconds: 30 })).toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "idempotency_mismatch" }) }));
			expect(attempts()).toEqual(before);
		});
	});

	it("queues stale_memory only for unprotected, unrecalled records untouched for 90 days, and only retires or flags them", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql, old = new Date(Date.now() - 91 * DAY).toISOString(), today = new Date().toISOString().slice(0, 10);
			const id = (name: string, extra: Record<string, unknown> = {}) => String(wired(storage, who, save({ name, content: name, ...extra })).memory_id);
			const plain = id("Plain old"), stated = id("Stated old", { origin: "stated" }), pinned = id("Pinned old"), pref = id("Preference old"), fresh = id("Fresh");
			const recalled = id("Recalled old"), longAgo = id("Recalled long ago"), toPin = id("Pinned after queueing");
			const journal = String(wired(storage, who, save({ name: "Journal old", type: "project", kind: "journal", content: "" })).memory_id);
			// Graph nodes without a memory type (an uploaded session, a component) cannot take the retire-only save: never stale_memory.
			const digest = JSON.stringify({ asks: [{ text: "old ask", pos: 1 }], decisions: [], corrections: [], outcomes: {}, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
			expect(ingest(storage, who, { session: { client: "codex", id: "stale-session" }, manifests: [],
				digests: [{ range_id: "codex:stale-session:0a1b2c3d:0-10", capture_status: "heuristic", part_id: "-", sha256: sha256(digest), body: digest }] }).map((r) => r.status)).toEqual(["stored"]);
			wired(storage, who, { op: "knowledge", args: { nodes: [{ kind: "component", name: "Stale component", description: "a component" }] } });
			const graphOnly = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE memory_type IS NULL AND kind IN ('session', 'component') AND status = 'active'").toArray().map((r) => r.id);
			expect(graphOnly).toHaveLength(2);
			sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", pinned);
			sql.exec("UPDATE nodes SET kind = 'preference' WHERE id = ?", pref);
			sql.exec("UPDATE nodes SET updated_at = ? WHERE id <> ?", old, fresh);
			noteRecall(sql, nextSeq(sql, "profile_meta"), today, [recalled], 10);
			noteRecall(sql, nextSeq(sql, "profile_meta"), new Date(Date.now() - 120 * DAY).toISOString().slice(0, 10), [longAgo], 10);
			only(storage, who, "queue");
			expect(queued(sql, "stale_memory").sort()).toEqual([plain, longAgo, toPin].sort());
			expect([stated, pinned, pref, fresh, recalled, journal, ...graphOnly].some((n) => queued(sql, "stale_memory").includes(n))).toBe(false);

			const lease = next(storage, { kinds: ["stale_memory"] });
			expect(lease.items.every((i) => JSON.stringify(i.allowed_ops) === JSON.stringify(["save", "flag", "dismiss"]))).toBe(true);
			sql.exec("UPDATE nodes SET pinned = 1 WHERE id = ?", toPin);
			const item = (n: string) => lease.items.find((i) => i.subjects[0] === n)!.item_id;
			const out = complete(storage, who, { lease_id: lease.lease_id!, results: [
				{ item_id: item(plain), ops: [{ op: "save", memory_id: plain, description: "rewritten" }, { op: "save", memory_id: plain, retire: true, new_name: "Renamed" },
					{ op: "infer_preference", name: "x", description: "x", evidence: [{ kind: "node", ref: plain }] }, { op: "save", memory_id: plain, retire: true }] },
				{ item_id: item(toPin), ops: [{ op: "save", memory_id: toPin, retire: true }] },
			] }, job);
			expect(out.results[0]).toMatchObject({ status: "done", ops: [{ status: "rejected", reason: "retire_only" }, { status: "rejected", reason: "retire_only" },
				{ status: "rejected", reason: "op_not_allowed" }, { op: "save", status: "applied" }] });
			expect(out.results[1]).toMatchObject({ ops: [{ op: "save", status: "flagged" }] });
			expect(sql.exec("SELECT id, status FROM nodes WHERE id IN (?, ?) ORDER BY id", plain, toPin).toArray())
				.toEqual([{ id: plain, status: "retired" }, { id: toPin, status: "active" }].sort((a, b) => a.id.localeCompare(b.id)));
		});
		// No background item is queued for me records.
		await inStore((storage, who) => {
			wired(storage, who, save({ name: "Me old", content: "me" }));
			storage.sql.exec("UPDATE nodes SET updated_at = ?", new Date(Date.now() - 91 * DAY).toISOString());
			only(storage, who, "queue");
			expect(queued(storage.sql, "stale_memory")).toEqual([]);
		}, "me");
	});

	it("stores suggest_eval_case only from capture items, with the item's node evidence, a deterministic id and no wiped id", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql;
			const capture = String(wired(storage, who, { op: "capture", args: { content: "the owner corrected a date format" } }).capture_id);
			const target = String(wired(storage, who, save({ name: "Date format", content: "YYYY-MM-DD" })).memory_id);
			sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, '1')", "wiped:gone-node");
			enqueue(storage, [{ kind: "unprocessed_capture", subjects: [capture] }, { kind: "near_duplicate", subjects: [target, capture] }]);
			const lease = next(storage, {});
			const cap = lease.items.find((i) => i.kind === "unprocessed_capture")!, dup = lease.items.find((i) => i.kind === "near_duplicate")!;
			expect(cap.allowed_ops).toContain("suggest_eval_case");
			expect(dup.allowed_ops).not.toContain("suggest_eval_case");
			const good = { op: "suggest_eval_case" as const, query: "how should dates be written", expected: [target], evidence: [{ kind: "node" as const, ref: capture }] };
			const out = complete(storage, who, { lease_id: lease.lease_id!, results: [
				{ item_id: cap.item_id, ops: [good, { ...good, evidence: [{ kind: "node", ref: target }] }, { ...good, evidence: [{ kind: "url", ref: "https://example.invalid" }] },
					{ ...good, query: " " }, { ...good, expected: [] }, { ...good, expected: ["gone-node"] }] },
				{ item_id: dup.item_id, ops: [good] },
			] }, job);
			expect(out.results[0]).toMatchObject({ status: "done", ops: [{ status: "applied" }, { code: "outside_subjects" }, { code: "outside_subjects" },
				{ reason: "bad_query" }, { reason: "bad_expected" }, { status: "rejected", code: "profile_wiped" }] });
			expect(out.results[1]).toMatchObject({ ops: [{ status: "rejected", reason: "op_not_allowed" }] });
			const rows = sql.exec<{ id: string; expected_json: string; evidence_json: string; status: string }>("SELECT id, expected_json, evidence_json, status FROM eval_candidates").toArray();
			expect(rows).toEqual([{ id: uuid5(`${USER}:eval:${lease.lease_id}:${cap.item_id}:0`), expected_json: JSON.stringify([target]), evidence_json: JSON.stringify(good.evidence), status: "pending" }]);
			// A retried completion replays the stored outcome and adds no candidate.
			expect(complete(storage, who, { lease_id: lease.lease_id!, results: [{ item_id: cap.item_id, ops: [good] }] }, job).results[0]).toMatchObject({ replayed: true });
			expect(sql.exec("SELECT count(*) AS c FROM eval_candidates").one().c).toBe(1);
		});
	});

	it("purges recall counts older than 400 days in pages of PURGE_ROWS inside the soft budget", async () => {
		await inStore((storage, who) => {
			const sql = storage.sql, today = new Date().toISOString().slice(0, 10);
			for (let i = 0; i < 230; i++) sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES (?, '2024-01-01', 1, 1)", `old-${i}`);
			for (let d = 1; d <= 20; d++) sql.exec("INSERT INTO recall_totals (day, recalls, tokens, seq) VALUES (?, 1, 1, 1)", `2024-02-${String(d).padStart(2, "0")}`);
			sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES ('kept', ?, 1, 1)", today);
			sql.exec("INSERT INTO recall_totals (day, recalls, tokens, seq) VALUES (?, 1, 1, 1)", today);
			const pages = [0, 1, 2].map(() => {
				const r = only(storage, who, "purge");
				return { more: r.more, recall: JSON.parse(String(sql.exec("SELECT stats FROM cursors WHERE stage = 'purge'").one().stats)).recall as number };
			});
			expect(pages).toEqual([{ more: true, recall: 100 }, { more: true, recall: 100 }, { more: false, recall: 50 }]);
			expect(sql.exec("SELECT (SELECT count(*) FROM recall_daily) AS d, (SELECT count(*) FROM recall_totals) AS t").one()).toEqual({ d: 1, t: 1 });
			expect(sql.exec("SELECT count(*) AS c FROM deleted_rows WHERE tbl IN ('recall_daily', 'recall_totals')").one().c).toBe(250);
		});
	});
});
