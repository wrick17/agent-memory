import { purgePersonCounts, sealObservation } from "./work-counts";
// Housekeeping (section 12): deterministic alarm stages, one bounded step per call, with cursors. Exact dedupe, the 90-day
// capture TTL into the archive, the 300-day purge and the 400-day recall count purge. Every change except purge keeps its undo; protected nodes are only
// flagged. The size level (section 6) is measured on every call.
import { retireArchivePage } from "./archive-operations";
import { cleanupTerminal } from "./daily-proof";
import { fenceOf, queueFold } from "./compact";
import { requestHash } from "../domain/ids";
import { Fail, type WriteContext } from "../domain/types";
import { nextSeq } from "../storage";
import { archiveNode, archiveRows, BudgetTx, purgeAfter, type Row } from "./archive";
import { flagProtected, mayChange } from "./protect";
import { board, REVIEW_ITEMS } from "./board";
import { enqueue } from "./maintenance";
import { purgeRecallBefore, PURGE_ROWS } from "./recall-stats";
import { runWrite, type Who } from "./write";

export const TTL_DAYS = 90;
export const ACTIVITY_DAYS = 400;
/** stale_memory: untouched and unrecalled for this many days (the recall strength window). */
export const STALE_DAYS = 90;
/**
 * Rows one full purgeRecallBefore call writes as measured in workerd (PURGE_ROWS deletes with their tombstones and index
 * entries, plus the seq row). Its raw SQL bypasses BudgetTx, so the stage reserves this much of the soft share and charges it.
 */
const RECALL_WRITES = 301;
/** 10 GB per Durable Object on the Paid plan. */
export const OBJECT_LIMIT = 10 * 1024 ** 3;
const DAY = 86_400_000;
const STEP = { dedupe: 100, ttl: 100, purge: 200, queue: 200 } as const;
export type Stage = keyof typeof STEP;
/** A step stops taking items once it used half of the 1,000-row, 1 MB budget, which leaves room for the largest item. */
const SOFT = 0.5;

export type SizeLevel = "ok" | "uploads_refused" | "shrink_only";
/** At 70% of the object limit uploads are refused; at 90% only retire, compaction, forget and undo are accepted. */
export const sizeLevel = (bytes: number): SizeLevel => bytes >= 0.9 * OBJECT_LIMIT ? "shrink_only" : bytes >= 0.7 * OBJECT_LIMIT ? "uploads_refused" : "ok";

type StepResult = { more: boolean; cursor?: string; stats: Record<string, number>; purged?: string[] };
export type PurgeCleanup = { nodes: string[]; requests: string[] };

/** The purge transaction leaves a durable, content-free outbox. Failed external cleanup retries before the next purge. */
export async function cleanupPurge(storage: DurableObjectStorage, remove: (ids: PurgeCleanup) => Promise<void>): Promise<void> {
	const raw = storage.sql.exec<{ cursor: string }>("SELECT cursor FROM cursors WHERE stage = 'purge_cleanup'").toArray()[0]?.cursor;
	if (!raw) return;
	await remove(JSON.parse(raw) as PurgeCleanup);
	storage.sql.exec("DELETE FROM cursors WHERE stage = 'purge_cleanup' AND cursor = ?", raw);
}

/**
 * One terminal refresh cleanup page, otherwise one step of the most overdue stage. Stages with work left stay due now; finished stages wait a day.
 * Returns the purged node ids (the caller deletes their vectors) and when the next stage is due, for the alarm.
 */
export function housekeep(storage: DurableObjectStorage, who: Who, now = Date.now()): { stage: Stage | null; more: boolean; purged: string[]; size: SizeLevel; nextDue: number } {
	const sql = storage.sql;
	const size = sizeLevel(sql.databaseSize);
	if (cleanupTerminal(storage, who)) return { stage: null, more: true, purged: [], size, nextDue: now };
	const due = new Map(sql.exec<{ stage: string; cursor: string | null; due_at: number }>("SELECT stage, cursor, due_at FROM cursors WHERE stage IN ('dedupe', 'ttl', 'purge', 'queue')").toArray().map((r) => [r.stage, r]));
	const stages = (Object.keys(STEP) as Stage[]).map((s) => ({ stage: s, cursor: due.get(s)?.cursor ?? null, dueAt: due.get(s)?.due_at ?? 0 })).sort((a, b) => a.dueAt - b.dueAt);
	const first = stages[0]!;
	if (first.dueAt > now) return { stage: null, more: false, purged: [], size, nextDue: first.dueAt };
	const r: StepResult = first.stage === "dedupe" ? dedupe(storage, who, Number(first.cursor ?? 0)) : first.stage === "ttl" ? ttl(storage, who, now, first.cursor)
		: first.stage === "queue" ? queueStep(storage, who, Number(first.cursor ?? 0), now) : purge(storage, who, now);
	const dueAt = r.more ? now : now + DAY;
	sql.exec(`INSERT INTO cursors (stage, cursor, due_at, last_run_at, last_error, stats) VALUES (?, ?, ?, ?, NULL, ?)
		ON CONFLICT (stage) DO UPDATE SET cursor = excluded.cursor, due_at = excluded.due_at, last_run_at = excluded.last_run_at, last_error = NULL, stats = excluded.stats`,
		first.stage, r.more ? (r.cursor ?? null) : null, dueAt, new Date(now).toISOString(), JSON.stringify(r.stats));
	return { stage: first.stage, more: r.more, purged: r.purged ?? [], size, nextDue: Math.min(dueAt, ...stages.slice(1).map((s) => s.dueAt)) };
}

/** Flags once: a node already flagged is left for the owner. */
function flag(storage: DurableObjectStorage, id: string, why: string, op: string): void {
	storage.transactionSync(() => {
		const tx = new BudgetTx(storage.sql, nextSeq(storage.sql, "profile_meta"), new Date().toISOString());
		flagProtected(tx, id, why, op, "keep");
	});
}

/** Active memory nodes with the same kind, scope and content hash: the newer is superseded by the oldest, through runWrite. */
function dedupe(storage: DurableObjectStorage, who: Who, after: number): StepResult {
	const rows = storage.sql.exec<{ r: number; id: string; origin: string; pinned: number; flagged: string | null; keep: string | null }>(
		`SELECT n.rowid AS r, n.id, n.origin, n.pinned, n.flagged, (SELECT o.id FROM nodes o WHERE o.kind = n.kind AND o.scope = n.scope
			AND o.content_hash = n.content_hash AND o.status = 'active' AND o.memory_type IS NOT NULL AND o.rowid < n.rowid ORDER BY o.rowid LIMIT 1) AS keep
		FROM nodes n WHERE n.rowid > ? AND n.status = 'active' AND n.memory_type IS NOT NULL AND n.scope <> 'repo-fact' ORDER BY n.rowid LIMIT ?`, after, STEP.dedupe).toArray();
	const stats = { superseded: 0, flagged: 0, failed: 0 };
	for (const n of rows) {
		if (!n.keep) continue;
		const why = mayChange(n, "keep", who.profile);
		if (why) {
			if (!n.flagged) { flag(storage, n.id, why, "dedupe"); stats.flagged++; }
			continue;
		}
		const survivor = storage.sql.exec<{ origin: string; pinned: number }>("SELECT origin, pinned FROM nodes WHERE id = ?", n.keep).one();
		if (mayChange(survivor, "keep", who.profile)) {
			if (!n.flagged) { flag(storage, n.id, "protected survivor", "dedupe"); stats.flagged++; }
			continue;
		}
		const args = { memory_id: n.keep, supersedes: [n.id] };
		try {
			runWrite(storage, who, { op: "save", args }, {
				// wiring: WriteContext.actor gains "keep" | "index" | "maintenance".
				actor: "keep" as WriteContext["actor"], platform: "server", routedBy: "housekeeping", payloadHash: requestHash("dedupe", args), userId: who.userId,
			});
			stats.superseded++;
		} catch (e) {
			// One bad pair must not stall the stage; it is counted in the stage's stats.
			if (!(e instanceof Fail)) throw e;
			stats.failed++;
		}
	}
	return { more: rows.length === STEP.dedupe, cursor: String(rows.at(-1)?.r ?? after), stats };
}

/**
 * Capture candidates and heuristic digests neither promoted, consolidated nor used within 90 days move to the archive, in one
 * transaction with one activity row whose undo restores them.
 */
function ttl(storage: DurableObjectStorage, who: Who, now: number, cursor: string | null): StepResult {
	const sql = storage.sql, cutoff = new Date(now - TTL_DAYS * DAY).toISOString();
	const cur = cursor ? JSON.parse(cursor) as { lane: string; after: number } : { lane: "nodes", after: 0 };
	const nodes = cur.lane === "nodes";
	const rows = nodes ? sql.exec<Row & { r: number; id: string; origin: string; pinned: number }>(`SELECT rowid AS r, * FROM nodes WHERE rowid > ? AND kind = 'other' AND other_label = 'capture'
		AND status = 'candidate' AND flagged IS NULL AND updated_at < ? AND (last_used_at IS NULL OR last_used_at < ?) ORDER BY rowid LIMIT ?`, cur.after, cutoff, cutoff, STEP.ttl).toArray()
		: sql.exec<Row & { r: number; origin: string; pinned: number }>(`SELECT t.rowid AS r, t.*, n.origin, n.pinned FROM texts t JOIN nodes n ON n.id = t.node_id
		WHERE t.rowid > ? AND t.lane = 'capture' AND t.capture_status = 'heuristic' AND t.created_at < ? AND n.flagged IS NULL
		AND (n.last_used_at IS NULL OR n.last_used_at < ?) AND NOT EXISTS
		(SELECT 1 FROM texts c WHERE c.range_id = t.range_id AND c.capture_status = 'consolidated') ORDER BY t.rowid LIMIT ?`, cur.after, cutoff, cutoff, STEP.ttl).toArray();
	const stats = { captures: 0, digests: 0, flagged: 0, failed: 0 };
	for (const row of rows) {
		const id = String(nodes ? row.id : row.node_id), why = mayChange(row, "keep", who.profile);
		if (why) { flag(storage, id, why, "ttl"); stats.flagged++; continue; }
		try {
			storage.transactionSync(() => {
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString());
				const activityId = Number(tx.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'keep', 'ttl', ?, ?, ?) RETURNING id", tx.now,
					`archived ${nodes ? 1 : 0} captures and ${nodes ? 0 : 1} digest rows unused for ${TTL_DAYS} days`, JSON.stringify([id]), tx.seq).one().id);
				const { r: _r, origin: _origin, pinned: _pinned, ...text } = row;
				const archived = nodes ? archiveNode(tx, activityId, id, purgeAfter(tx.now)) : archiveRows(tx, activityId, "texts", [text], purgeAfter(tx.now));
				tx.run("UPDATE activity SET undo = ? WHERE id = ?", JSON.stringify({ seq: tx.seq, archived }), activityId);
			});
			if (nodes) stats.captures++; else stats.digests++;
		} catch (e) {
			if (!(e instanceof Fail)) throw e;
			// A single oversized capture stays intact for manual review; the cursor still reaches later captures.
			stats.failed++;
		}
	}
	const more = rows.length === STEP.ttl;
	const textsDue = nodes && sql.exec(`SELECT 1 FROM texts t JOIN nodes n ON n.id = t.node_id WHERE t.lane = 'capture' AND t.capture_status = 'heuristic'
		AND t.created_at < ? AND n.flagged IS NULL AND (n.last_used_at IS NULL OR n.last_used_at < ?) AND NOT EXISTS
		(SELECT 1 FROM texts c WHERE c.range_id = t.range_id AND c.capture_status = 'consolidated') LIMIT 1`, cutoff, cutoff).toArray().length > 0;
	return { more: more || textsDue, cursor: JSON.stringify(more ? { lane: cur.lane, after: rows.at(-1)!.r } : { lane: "texts", after: 0 }), stats };
}

/**
 * Archive rows past purge_after are deleted for good, the one change without undo. A purged node's request records go with
 * it, a bounded batch per step. Activity and recall counts older than 400 days are deleted. The activity row keeps counts and ids only.
 */
function purge(storage: DurableObjectStorage, who: Who, now: number): StepResult {
	if (storage.sql.exec("SELECT 1 FROM cursors WHERE stage = 'purge_cleanup'").toArray().length) return { more: true, stats: { pending_cleanup: 1 } };
	const main: StepResult = storage.transactionSync(() => {
		const sql = storage.sql;
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString());
		const rows = sql.exec<{ id: number; node: string | null }>(`SELECT id, CASE WHEN source = 'nodes' THEN json_extract(payload, '$.id') END AS node
			FROM archive WHERE NOT EXISTS (SELECT 1 FROM profile_meta WHERE key='archive-pin:'||archive.activity_id) AND purge_after < ? ORDER BY purge_after, id LIMIT ?`, tx.now, STEP.purge).toArray();
		const purged: string[] = [];
		const requests: string[] = [];
		let more = rows.length === STEP.purge, done = 0;
		for (const r of rows) {
			if (tx.spent(SOFT) || requests.length + purged.length >= 100) { more = true; break; }
			if (r.node && !sql.exec("SELECT 1 FROM nodes WHERE id = ?", r.node).toArray().length) {
				const offered = sql.exec<{ request_id: string }>("SELECT request_id FROM requests WHERE node_id = ? ORDER BY request_id LIMIT ?", r.node, 100 - requests.length - purged.length).toArray().map((q) => q.request_id);
				const ids:string[]=[];
				for(const id of offered){if(tx.spent(0.35))break;sealObservation(tx,id);ids.push(id);}
				if (ids.length) tx.run("DELETE FROM requests WHERE request_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
				requests.push(...ids);
				// A node with more request records than one batch keeps its archive row until the next step finishes them.
				if (sql.exec("SELECT 1 FROM requests WHERE node_id = ? LIMIT 1", r.node).toArray().length) { more = true; break; }
				if(!purgePersonCounts(tx,r.node,who.profile)){more=true;break;}
				purged.push(r.node);
			}
			tx.run("DELETE FROM archive WHERE id = ?", r.id);
			done++;
			if (requests.length + purged.length >= 100) { more = true; break; }
		}
		const old = new Date(now - ACTIVITY_DAYS * DAY).toISOString();
		const stale = tx.spent(SOFT) ? [] : sql.exec<{ id: number }>("SELECT id FROM activity WHERE NOT EXISTS (SELECT 1 FROM profile_meta WHERE key='archive-pin:'||activity.id) AND at < ? ORDER BY id LIMIT 100", old).toArray().map((a) => a.id);
		let expired=0;
		for(const id of stale){
			if(tx.spent(SOFT)){more=true;break;}
			if(retireArchivePage(tx,id)){
				// Charge this row's expiry triggers before taking another item, leaving the existing half-budget headroom.
				tx.run("DELETE FROM activity WHERE id=?",id);expired++;
			}else more=true;
		}
		more ||= stale.length === 100;
		if (done || stale.length) {
			tx.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'keep', 'purge', ?, ?, ?)", tx.now,
				`purged ${done} archived rows (${purged.length} nodes) and ${expired} activity rows older than ${ACTIVITY_DAYS} days`, JSON.stringify(purged), tx.seq);
		}
		if (purged.length || requests.length) tx.run("INSERT INTO cursors (stage, cursor, due_at) VALUES ('purge_cleanup', ?, 0)", JSON.stringify({ nodes: purged, requests }));
		return { more, purged, stats: { rows: done, nodes: purged.length, activity: expired } };
	});
	const recall = purgeRecall(storage, now);
	return { ...main, more: main.more || recall.more, stats: { ...main.stats, recall: recall.deleted } };
}

/**
 * Recall counts (recall_daily, recall_totals) for days more than 400 days old, one bounded page in its own transaction so
 * the archive purge keeps its whole budget. The rows hold ids and counts only, so they go without undo, like old activity.
 */
function purgeRecall(storage: DurableObjectStorage, now: number): { deleted: number; more: boolean } {
	const sql = storage.sql, cutoff = new Date(now - ACTIVITY_DAYS * DAY).toISOString().slice(0, 10);
	if (!sql.exec("SELECT 1 FROM recall_daily WHERE day < ?1 UNION ALL SELECT 1 FROM recall_totals WHERE day < ?1 LIMIT 1", cutoff).toArray().length) return { deleted: 0, more: false };
	return storage.transactionSync(() => {
		// The tombstones the deletes write take this transaction's seq, so exports and the change feed see the removal.
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString());
		// The page runs only with room for a full call inside the soft share; its untracked writes are then charged to tx.
		if (tx.spent(SOFT - RECALL_WRITES / 1_000)) return { deleted: 0, more: true };
		const deleted = purgeRecallBefore(sql, cutoff);
		tx.rows += RECALL_WRITES - 1; // tx already counted the seq row
		return { deleted, more: deleted === PURGE_ROWS };
	});
}

/** Nightly node scan, bounded to 200 nodes. Fingerprints make repeats harmless and changed cards eligible again. */
function queueStep(storage: DurableObjectStorage, who: Who, after: number, now: number): StepResult {
	const sql = storage.sql;
	// stale_memory (decay without deletion): an active memory, not a journal or preference, untouched for 90 days and with no
	// recall hit in the 90 UTC days ending today. Never stated, pinned or in me, so a protected record is never queued. Graph
	// nodes without a memory type (sessions, entities) are excluded: the retire-only save cannot find them.
	const staleBefore = new Date(now - STALE_DAYS * DAY).toISOString(), hitsFrom = new Date(now - (STALE_DAYS - 1) * DAY).toISOString().slice(0, 10);
	const rows = sql.exec<{ r: number; id: string; kind: string; attrs: string; memory_type: string | null; chars: number; updated_at: string; created_at: string; stale: number }>(
		`SELECT rowid AS r, id, kind, attrs, memory_type, chars, updated_at, created_at, (status = 'active' AND memory_type IS NOT NULL AND kind NOT IN ('journal', 'preference') AND origin <> 'stated'
			AND pinned = 0 AND ?1 <> 'me' AND updated_at < ?2 AND NOT EXISTS (SELECT 1 FROM recall_daily d WHERE d.node_id = nodes.id AND d.day >= ?3)) AS stale
		FROM nodes WHERE rowid > ?4 AND status IN ('active','candidate') AND scope <> 'repo-fact' ORDER BY rowid LIMIT ?5`, who.profile, staleBefore, hitsFrom, after, STEP.queue).toArray();
	let items = 0;
	for (const n of rows) {
		const kinds: string[] = [];
		if (n.memory_type && Date.parse(n.created_at) <= now - DAY && !sql.exec(`SELECT 1 FROM edges e JOIN nodes p ON p.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
			WHERE (e.src = ? OR (e.dst = ? AND e.dst_profile = '')) AND e.dst_profile = '' AND e.ended_at IS NULL AND p.kind IN ('project','component','person') LIMIT 1`, n.id, n.id, n.id).toArray().length) kinds.push("unlinked");
		if (n.kind === "journal") storage.transactionSync(() => {
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString());
			queueFold(tx, n.id);
		});
		const F = fenceOf(n.attrs);
		const uncompacted = n.kind === "journal" ? Number(sql.exec<{ chars: number }>("SELECT COALESCE(SUM(length(body) + CASE WHEN chunk = 0 THEN length(COALESCE(separator, '')) ELSE 0 END), 0) AS chars FROM texts WHERE node_id = ? AND part = 'entry' AND live <> 0 AND seq_no > ?", n.id, F).one().chars) : 0;
		if (n.kind === "journal" && uncompacted >= 8000 && Date.parse(n.updated_at) <= now - 7 * DAY) kinds.push("stale_journal");
		if (n.stale) kinds.push("stale_memory");
		const digests = sql.exec<{ body: string; capture_status: string }>(`SELECT body, capture_status FROM texts t WHERE node_id = ? AND lane = 'capture' AND live = 1 AND capture_part IS NOT 'manifest'
			AND NOT EXISTS (SELECT 1 FROM texts m WHERE m.range_id = t.range_id AND m.capture_part = 'manifest') ORDER BY rowid LIMIT 100`, n.id).toArray();
		if (digests.length) kinds.push("unprocessed_capture");
		if (digests.some((d) => { try { return ((JSON.parse(d.body) as { corrections?: unknown[] }).corrections?.length ?? 0) > 0; } catch { return false; } })) kinds.push("preference_signal");
		if (kinds.length) { enqueue(storage, kinds.map((kind) => ({ kind, subjects: [n.id], ...(kind === "stale_journal" ? { slot: String(F) } : {}) }))); items += kinds.length; }
	}
	// One weekly slot per profile, an empty board included, never in me (no background writes there); a completed or dismissed
	// slot is never queued again, and a review written in the last seven days skips it. Its subjects are the board's top items
	// as of now, the only nodes the review may link to; the lease shows their board rows as of the item's creation.
	const slot = Math.floor(now / (7 * DAY));
	const queued = sql.exec("SELECT 1 FROM maintenance WHERE kind = 'weekly_review' AND created_at >= ? LIMIT 1", new Date(slot * 7 * DAY).toISOString()).toArray().length;
	const recent = sql.exec("SELECT 1 FROM nodes WHERE kind = 'document' AND status = 'active' AND json_extract(attrs, '$.kind') = 'strategic_review' AND recorded_at > ? LIMIT 1",
		new Date(now - 7 * DAY).toISOString()).toArray().length;
	if (who.profile !== "me" && !queued && !recent) {
		const top = board(sql, { kind: "board", asOf: new Date(now).toISOString(), limit: REVIEW_ITEMS, known: [] }).items.map((i) => i.id);
		enqueue(storage, [{ kind: "weekly_review", subjects: top, slot: String(slot) }]);
	}
	return { more: rows.length === STEP.queue, cursor: String(rows.at(-1)?.r ?? after), stats: { scanned: rows.length, items } };
}
