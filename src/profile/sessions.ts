// Sessions read from capture nodes and their digests (S1). The signatures are the contract.
// A session is the `session` node one client session id creates on its first upload (capture.ts). Everything here comes from
// that node, its attrs (device_id, first_at, ended, files_changed), its current digest parts, its project link and the evidence
// rows that cite it. Nothing is invented: no cwd, no original start or end time, no tool count.
import { Fail } from "../domain/types";
import type { Client, ReplayEvent, SessionDetail, SessionQuery, SessionRow } from "../viewer/types";
import { END_CURSOR, formatSessionCursor, parseSessionCursor } from "../sessions";
import { parseRange, type DigestBody } from "./capture";

/** Status turns completed once the last upload is this old, or at once when a SessionEnd batch arrived. */
const ACTIVE_MS = 30 * 60_000;
const LIMIT = 50, LIMIT_MAX = 100, PRODUCED_MAX = 200;
// shortcut: a detail returns at most this many events (counts still give the totals); add event paging if sessions outgrow it.
const EVENTS_MAX = 5_000;
type NodeRow = { id: string; key: string; attrs: string; created_at: string; updated_at: string; project: string | null };
type Attrs = { device_id?: unknown; first_at?: unknown; ended?: unknown; files_changed?: unknown };

// The project the session's digests link to: an upload's part_of link first, then the strongest identifier link.
const PROJECT = `(SELECT e.dst FROM edges e JOIN nodes p ON p.id = e.dst WHERE e.src = n.id AND e.dst_profile = '' AND e.ended_at IS NULL
	AND p.kind = 'project' AND p.status = 'active' ORDER BY e.rel = 'part_of' DESC, e.weight DESC, e.id LIMIT 1)`;
const SELECT = `SELECT n.id, n.key, n.attrs, n.created_at, n.updated_at, ${PROJECT} AS project FROM nodes n`;

/**
 * The digest parts that describe a session now, in transcript order: per range, its live heuristic digest until the range's
 * manifest supersedes it, else its live consolidated parts. Ranges order by start offset (first upload breaks ties across
 * transcript epochs), parts by their span.
 */
function currentParts(sql: SqlStorage, node: string) {
	const rows = sql.exec<{ rowid: number; range_id: string; capture_part: string; capture_status: string; body: string }>(`SELECT t.rowid, t.range_id, t.capture_part, t.capture_status, t.body
		FROM texts t WHERE t.node_id = ? AND t.part = 'capture' AND t.lane = 'capture' AND t.live = 1 AND t.chunk = 0 AND t.range_id IS NOT NULL
		AND t.capture_part IS NOT 'manifest' AND (t.capture_status = 'heuristic' OR NOT EXISTS (SELECT 1 FROM texts h
			WHERE h.range_id = t.range_id AND h.capture_status = 'heuristic' AND h.capture_part = '-' AND h.live = 1)) ORDER BY t.rowid`, node).toArray();
	const first = new Map<string, number>();
	for (const r of rows) if (!first.has(r.range_id)) first.set(r.range_id, r.rowid);
	const key = (r: (typeof rows)[number]) => {
		const range = parseRange(r.range_id);
		return [range?.start ?? 0, first.get(r.range_id)!, r.capture_part === "-" ? range?.start ?? 0 : Number(r.capture_part.split("-")[0])];
	};
	const sorted = rows.map((r) => ({ r, k: key(r) })).sort((a, b) => a.k[0]! - b.k[0]! || a.k[1]! - b.k[1]! || a.k[2]! - b.k[2]!);
	// The stored bytes passed checkBody on ingest, so they are read as stored; a later redaction rule never hides a held part.
	return sorted.flatMap(({ r }) => { try { return [{ part: r.capture_part, status: r.capture_status, body: JSON.parse(r.body) as DigestBody }]; } catch { return []; } });
}

type Part = ReturnType<typeof currentParts>[number];
const OUTCOMES = [["commits", "commit"], ["prs", "pr"], ["tests", "test"]] as const;

/** One part's events: asks, decisions and corrections by position (stable by kind on a tie), then its outcomes, which carry no position. */
function partEvents(p: Part): Omit<ReplayEvent, "i">[] {
	const items = ([["asks", "ask"], ["decisions", "decision"], ["corrections", "correction"]] as const)
		.flatMap(([field, kind], order) => p.body[field].map((x) => ({ kind, x, order })))
		.sort((a, b) => a.x.pos - b.x.pos || a.order - b.order)
		.map(({ kind, x }) => ({ kind, label: x.text, offset_ms: null, detail: { part: p.part, pos: String(x.pos) } }));
	const outcomes = OUTCOMES.flatMap(([field, outcome]) => (p.body.outcomes[field] ?? []).map((text) => ({ kind: "outcome" as const, label: text, offset_ms: null, detail: { part: p.part, outcome } })));
	return [...items, ...outcomes];
}

function toRow(sql: SqlStorage, n: NodeRow, now: number): { row: SessionRow; parts: Part[] } {
	const attrs = JSON.parse(n.attrs) as Attrs;
	const [, client, ...rest] = n.key.split(":");
	const parts = currentParts(sql, n.id);
	const sum = (f: (b: Part["body"]) => number) => parts.reduce((t, p) => t + f(p.body), 0);
	let firstAsk: string | null = null;
	for (const p of parts) { const a = [...p.body.asks].sort((x, y) => x.pos - y.pos)[0]; if (a) { firstAsk = a.text; break; } }
	const ended = attrs.ended === true;
	return {
		parts,
		row: {
			id: n.id, client: client as Client, session: rest.join(":"),
			device: typeof attrs.device_id === "string" ? attrs.device_id : null,
			project: n.project,
			// first_at is written when v2 creates the node; an older node was created by its first upload too.
			first_upload_at: typeof attrs.first_at === "string" ? attrs.first_at : n.created_at,
			last_upload_at: n.updated_at,
			status: !ended && now - Date.parse(n.updated_at) < ACTIVE_MS ? "active" : "completed",
			first_ask: firstAsk,
			counts: {
				asks: sum((b) => b.asks.length), decisions: sum((b) => b.decisions.length), corrections: sum((b) => b.corrections.length),
				outcomes: sum((b) => OUTCOMES.reduce((t, [f]) => t + (b.outcomes[f]?.length ?? 0), 0)),
				parts: parts.filter((p) => p.status === "consolidated").length,
				files_changed: typeof attrs.files_changed === "number" ? attrs.files_changed : null,
			},
		},
	};
}

/**
 * Newest last upload first, by (updated_at, id): every stored digest part or manifest moves updated_at (capture.ts), so it is the
 * last upload time. A cursor that does not parse is a validation error.
 */
export function listSessions(sql: SqlStorage, q: SessionQuery): { rows: SessionRow[]; next_cursor: string | null } {
	if (q.cursor === END_CURSOR) return { rows: [], next_cursor: null };
	const cursor = q.cursor === undefined ? null : parseSessionCursor(q.cursor);
	if (q.cursor !== undefined && !cursor) throw Fail.of("validation", "cursor is not valid");
	const limit = Math.min(Math.max(Math.trunc(q.limit ?? LIMIT), 1), LIMIT_MAX), now = Date.now();
	const where = ["n.kind = 'session'", "n.status = 'active'"], args: (string | number)[] = [];
	if (cursor) { where.push(`(n.updated_at < ? OR (n.updated_at = ? AND n.id ${cursor.inclusive ? "<=" : "<"} ?))`); args.push(cursor.at, cursor.at, cursor.id); }
	if (q.client) { where.push("substr(n.key, 1, ?) = ?"); const prefix = `session:${q.client}:`; args.push(prefix.length, prefix); }
	if (q.project) { where.push(`${PROJECT} IN (SELECT id FROM nodes WHERE kind = 'project' AND (id = ? OR key = ?))`); args.push(q.project, q.project); }
	const cutoff = new Date(now - ACTIVE_MS).toISOString(), ended = "coalesce(json_extract(n.attrs, '$.ended'), 0) = 1";
	if (q.status === "active") { where.push(`n.updated_at > ? AND NOT ${ended}`); args.push(cutoff); }
	else if (q.status === "completed") { where.push(`(n.updated_at <= ? OR ${ended})`); args.push(cutoff); }
	const nodes = sql.exec<NodeRow>(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, ...args, limit + 1).toArray();
	const rows = nodes.slice(0, limit).map((n) => toRow(sql, n, now).row);
	const last = rows[rows.length - 1];
	return { rows, next_cursor: nodes.length > limit && last ? formatSessionCursor({ at: last.last_upload_at, id: last.id, inclusive: false }) : null };
}

/** One session by its node id, with its digest events in transcript order and the records that cite it as evidence. */
export function sessionDetail(sql: SqlStorage, id: string): SessionDetail | null {
	const n = sql.exec<NodeRow>(`${SELECT} WHERE n.id = ? AND n.kind = 'session' AND n.status = 'active'`, id).toArray()[0];
	if (!n) return null;
	const { row, parts } = toRow(sql, n, Date.now());
	const events = parts.flatMap(partEvents).slice(0, EVENTS_MAX).map((e, i) => ({ i, ...e }));
	// Evidence cites a session by its node (kind node) or by its key or client:id (kind session).
	const produced = sql.exec<{ id: string; kind: string; name: string; origin: string }>(`SELECT DISTINCT m.id, m.kind, m.name, m.origin, m.updated_at
		FROM evidence ev JOIN nodes m ON m.id = substr(ev.owner, 3)
		WHERE ev.owner LIKE 'n:%' AND ((ev.kind = 'node' AND ev.ref = ?) OR (ev.kind = 'session' AND ev.ref IN (?, ?)))
		AND m.status = 'active' AND m.id <> ? ORDER BY m.updated_at DESC, m.id LIMIT ?`, n.id, n.key, `${row.client}:${row.session}`, n.id, PRODUCED_MAX).toArray()
		.map((m) => ({ id: m.id, kind: m.kind, title: m.name, via: m.origin === "inferred" && m.kind === "preference" ? "inferred_preference" as const : "evidence" as const }));
	return { ...row, events, produced };
}
