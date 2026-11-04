// GET /api/viewer/events (V2): owner-only text/event-stream. Polls every 3 s, resumes from its cursor, and ends at the
// session token's exp or after 5 minutes, whichever comes first.
// shortcut: the Worker polls profile activity every 3 s per open stream. Upgrade to Durable Object WebSockets if more than one viewer stays open.
//
// Every frame's `id` is the cursor after that frame. The cursor maps each profile to the last activity id sent. When a
// profile's activity sequence is behind the cursor (a restore or a wipe replaced its history), the stream adopts the store's
// position, sends one health frame carrying that cursor, and ends; the client reloads the snapshot and streams from its cursor.
// A failed read also ends the stream, with no error text in it.
import { PROFILE_NAME } from "../domain/types";
import { READABLE_NODE } from "../profile/graph";
import type { FeedItem, FeedKind, HealthCheck, ViewerCursor, ViewerEvent } from "./types";

export const POLL_MS = 3_000;
export const STREAM_MAX_MS = 300_000;
/** Bounds a cursor from the query string: its encoded length and the profiles it may name. */
const CURSOR_MAX_CHARS = 4_096;
const CURSOR_MAX_PROFILES = 64;
const CHANGES_MAX = 100;
const SUMMARY_MAX = 280;

/** Opaque base64url of [1, { profile: activity id }], profiles sorted, so equal cursors encode the same. */
export function formatCursor(c: ViewerCursor): string {
	const sorted = Object.fromEntries(Object.keys(c).sort().map((p) => [p, c[p]]));
	return Buffer.from(JSON.stringify([1, sorted])).toString("base64url");
}

/** Null for anything formatCursor could not have produced: bad encoding, unknown version, bad names or ids. */
export function parseCursor(s: string): ViewerCursor | null {
	if (!s || s.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
	let v: unknown;
	try { v = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return null; }
	if (!Array.isArray(v) || v.length !== 2 || v[0] !== 1 || typeof v[1] !== "object" || v[1] === null || Array.isArray(v[1])) return null;
	const entries = Object.entries(v[1] as Record<string, unknown>);
	if (entries.length > CURSOR_MAX_PROFILES) return null;
	const out: ViewerCursor = {};
	for (const [p, n] of entries) {
		if (!PROFILE_NAME.test(p) || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
		out[p] = n;
	}
	return out;
}

/** The live-feed chip for one activity row. The batch is the maintenance actor; a preference is the target node's kind. */
export function feedKind(op: string, actor: string, targetKind: string | null): FeedKind {
	if (actor === "maintenance") return "BATCH";
	if (op === "import" || actor === "migration") return "IMPORT";
	if (["forget", "retire", "ttl", "purge", "transfer_out"].includes(op)) return "FORGET";
	return targetKind === "preference" ? "PREFERENCE" : "MEMORY";
}

/** What FEED_SELECT returns. target and target_kind come from the first target only while that node is readable here. */
export type ActivityFeedRow = { id: number; at: string; actor: string; op: string; summary: string; target: string | null; target_kind: string | null };
/** The activity columns a feed item needs, as `a`; append WHERE, ORDER BY and LIMIT. A wipe-redacted row names no target. */
export const FEED_SELECT = `SELECT a.id, a.at, a.actor, a.op, a.summary, n.id AS target, n.kind AS target_kind FROM activity a
	LEFT JOIN nodes n ON a.redacted IS NULL AND n.id = json_extract(a.targets, '$[0]') AND n.${READABLE_NODE}`;

/** One activity row as a feed item. id is the decimal activity id; summary is stored activity text (a wipe already redacted it). */
export function toFeedItem(profile: string, r: ActivityFeedRow): FeedItem {
	return { kind: feedKind(r.op, r.actor, r.target_kind), profile, id: String(r.id), summary: r.summary.slice(0, SUMMARY_MAX), at: r.at,
		...(r.target ? { target: r.target } : {}) };
}

/**
 * Runs inside a profile store: activity after `after`, oldest first, at most `limit`. `seq` is the last id returned, or
 * `after` when nothing is new. When the store's newest id is below `after`, its history was replaced: no items, and `seq`
 * is that newest id (0 for an empty store), which the stream reads as a cursor replacement.
 * shortcut: a numeric cursor cannot see a rewind that new writes have already passed; the client covers it by opening each stream with a freshly loaded snapshot's cursor. Add a store epoch to ViewerCursor if streams must survive a restore.
 */
export function changesSince(sql: SqlStorage, profile: string, after: number, limit: number): { items: FeedItem[]; seq: number } {
	const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
	const take = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), CHANGES_MAX) : CHANGES_MAX;
	const newest = Number(sql.exec<{ m: number | null }>("SELECT max(id) AS m FROM activity").one().m ?? 0);
	if (newest < from) return { items: [], seq: newest };
	const rows = sql.exec<ActivityFeedRow>(`${FEED_SELECT} WHERE a.id > ? ORDER BY a.id LIMIT ?`, from, take).toArray();
	return { items: rows.map((r) => toFeedItem(profile, r)), seq: rows.length ? rows.at(-1)!.id : from };
}

export interface StreamSource {
	/** Changes since the cursor across the owner's profiles, and the cursor after them. Throws when any profile read fails. */
	changes(cursor: ViewerCursor): Promise<{ items: FeedItem[]; cursor: ViewerCursor }>;
	health(): Promise<HealthCheck[]>;
}

/** Resolves after `ms`, or at once when the signal aborts; the timer never outlives the abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); };
		const t = setTimeout(done, ms);
		signal.addEventListener("abort", done);
	});
}

/** `expiresAt` is the token's exp in ms. The Worker checks the owner before calling this. */
export function eventStream(source: StreamSource, cursor: ViewerCursor, expiresAt: number, signal: AbortSignal): Response {
	const deadline = Math.min(expiresAt, Date.now() + STREAM_MAX_MS);
	const stop = new AbortController();
	const onAbort = () => stop.abort();
	if (signal.aborted) stop.abort(); else signal.addEventListener("abort", onAbort);
	const enc = new TextEncoder();
	let cur: ViewerCursor = { ...cursor };
	let lastHealth: string | null = null;

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			// The deadline closes the stream even while a read is pending; whatever that read returns later is dropped.
			const close = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				try { controller.close(); } catch { /* already closed or cancelled */ }
			};
			const timer = setTimeout(() => stop.abort(), Math.max(0, deadline - Date.now()));
			if (stop.signal.aborted) close(); else stop.signal.addEventListener("abort", close);
			const live = () => !stop.signal.aborted && Date.now() < deadline;
			const send = (e: ViewerEvent) => { if (live()) controller.enqueue(enc.encode(frame(e))); };
			const sendHealth = (checks: HealthCheck[]) => { lastHealth = JSON.stringify(checks); send({ event: "health", id: formatCursor(cur), data: checks }); };
			try {
				// The open sends the current checks, so the client has a resumable id before any change.
				if (live()) sendHealth(await source.health());
				while (live()) {
					const before = cur;
					const r = await source.changes(before);
					if (!live()) break;
					const replaced = Object.keys(r.cursor).some((p) => before[p] !== undefined && r.cursor[p]! < before[p]!);
					for (const item of r.items) {
						const id = Number(item.id);
						if (Number.isSafeInteger(id) && id > (cur[item.profile] ?? 0)) cur = { ...cur, [item.profile]: id };
						send({ event: "change", id: formatCursor(cur), data: item });
					}
					cur = { ...r.cursor };
					const checks = await source.health();
					if (replaced) { sendHealth(checks); break; }
					if (JSON.stringify(checks) !== lastHealth) sendHealth(checks);
					await sleep(Math.min(POLL_MS, deadline - Date.now()), stop.signal);
				}
			} catch {
				// A failed read ends the stream; the client reconnects. No error text reaches the stream.
			} finally {
				stop.abort();
			}
		},
		cancel() { stop.abort(); },
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** One SSE frame. data is one JSON line: JSON.stringify escapes newlines, and ids are base64url. */
export function frame(e: ViewerEvent): string {
	return `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
