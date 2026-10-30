// Alarm stage `dangling` (section 12): nightly, one page of current edges per step. An edge whose target is in no profile and
// in no wipe tombstone, for example after a purge or a restore, becomes a `dangling_link` item for the daily batch. Only the
// account can place a foreign or locally absent target, so the store asks it first, passes its gate, then calls
// enqueueDangling. A target present here (moved, moving and landing ones included) is never asked about or queued.
import { nextSeq } from "../storage";
import { BudgetTx } from "./archive";
import { enqueueIn } from "./maintenance";
import { assertOpen } from "./wipe";

export const PAGE = 200;
const DAY = 86_400_000;
/** Links belong to their source: one being moved, landing or left behind as a tombstone is not this profile's to report. */
const FENCED = "('incoming','moving','moved')";

export type DanglingPage = { due: number; edges: { id: number; src: string; dst: string }[]; last: number; more: boolean };

/** The next page of up to 200 current edges after the cursor, keeping those whose target only the account can place. */
export function danglingPage(sql: SqlStorage, now: number): DanglingPage {
	const cur = sql.exec<{ cursor: string | null; due_at: number }>("SELECT cursor, due_at FROM cursors WHERE stage = 'dangling'").toArray()[0];
	const after = Number(cur?.cursor ?? 0);
	if (cur && cur.due_at > now) return { due: cur.due_at, edges: [], last: after, more: false };
	const rows = sql.exec<{ id: number; src: string; dst: string; remote: number; here: number; fenced: number | null }>(
		`SELECT e.id, e.src, e.dst, e.dst_profile <> '' AS remote, EXISTS (SELECT 1 FROM nodes d WHERE d.id = e.dst) AS here, s.status IN ${FENCED} AS fenced
		FROM edges e LEFT JOIN nodes s ON s.id = e.src WHERE e.id > ? AND e.ended_at IS NULL ORDER BY e.id LIMIT ?`, after, PAGE).toArray();
	return { due: now, edges: rows.filter((r) => r.fenced === 0 && (r.remote || !r.here)).map(({ id, src, dst }) => ({ id, src, dst })),
		last: rows.at(-1)?.id ?? after, more: rows.length === PAGE };
}

/**
 * One transaction after the account's answer and the gate: rechecks that each edge is current, its source unfenced and a local
 * target still absent, queues `[src, dst]` with slot `e:<edge id>` for each absent target, and advances the cursor. It stops
 * early at half the row or byte budget and resumes there. Returns when the stage is next due.
 */
export function enqueueDangling(storage: DurableObjectStorage, page: DanglingPage, absent: Set<string>, now = Date.now()): number {
	return storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString());
		const asked = page.edges.filter((e) => absent.has(e.dst));
		const live = new Map(asked.length ? sql.exec<{ id: number; src: string; dst: string }>(`SELECT e.id, e.src, e.dst FROM edges e JOIN nodes s ON s.id = e.src WHERE e.id IN (SELECT value FROM json_each(?))
			AND e.ended_at IS NULL AND s.status NOT IN ${FENCED} AND (e.dst_profile <> '' OR NOT EXISTS (SELECT 1 FROM nodes d WHERE d.id = e.dst))`,
			JSON.stringify(asked.map((e) => e.id))).toArray().map((r) => [r.id, r] as const) : []);
		let last = page.last, more = page.more, queued = 0;
		for (const e of asked) {
			if (tx.spent(0.5)) { last = e.id - 1; more = true; break; }
			if (live.get(e.id)?.src === e.src && live.get(e.id)?.dst === e.dst) queued += enqueueIn(sql, () => tx, [{ kind: "dangling_link", subjects: [e.src, e.dst], slot: `e:${e.id}` }]);
		}
		const due = more ? now : now + DAY;
		tx.run(`INSERT INTO cursors (stage, cursor, due_at, last_run_at, last_error, stats) VALUES ('dangling', ?, ?, ?, NULL, ?)
			ON CONFLICT (stage) DO UPDATE SET cursor = excluded.cursor, due_at = excluded.due_at, last_run_at = excluded.last_run_at, last_error = NULL, stats = excluded.stats`,
			more ? String(last) : null, due, tx.now, JSON.stringify({ checked: asked.length, queued }));
		return due;
	});
}
