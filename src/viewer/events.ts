// GET /api/viewer/events (V2): owner-only text/event-stream. Polls every 3 s, resumes from its cursor, and ends at the
// session token's exp or after 5 minutes, whichever comes first.
// shortcut: the Worker polls profile activity every 3 s per open stream. Upgrade to Durable Object WebSockets if more than one viewer stays open.
import type { FeedItem, HealthCheck, ViewerCursor, ViewerEvent } from "./types";

export const POLL_MS = 3_000;
export const STREAM_MAX_MS = 300_000;
export function formatCursor(_c: ViewerCursor): string {
	return ""; // stub: V2
}
export function parseCursor(_s: string): ViewerCursor | null {
	return null; // stub: V2
}
/** Runs inside a profile store: activity after `after`, oldest first, at most `limit`. */
export function changesSince(_sql: SqlStorage, _profile: string, _after: number, _limit: number): { items: FeedItem[]; seq: number } {
	return { items: [], seq: 0 }; // stub: V2
}
export interface StreamSource {
	/** Changes since the cursor across the owner's profiles, and the cursor after them. */
	changes(cursor: ViewerCursor): Promise<{ items: FeedItem[]; cursor: ViewerCursor }>;
	health(): Promise<HealthCheck[]>;
}
/** `expiresAt` is the token's exp in ms. The Worker checks the owner before calling this. */
export function eventStream(_source: StreamSource, _cursor: ViewerCursor, _expiresAt: number, _signal: AbortSignal): Response {
	return new Response("", { status: 501 }); // stub: V2
}
/** One SSE frame. */
export function frame(_e: ViewerEvent): string {
	return ""; // stub: V2
}
