// GET /api/sessions (S1): merges each readable profile's session page by last_upload_at.
import { PROFILE_NAME } from "./domain/types";
import type { Page, ProfileSessionRow, SessionRow } from "./viewer/types";

const encode = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (s: string): unknown => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The per-profile cursor of a profile that has no more rows; listSessions answers it with an empty page. */
export const END_CURSOR = "end";

/** A cursor names a row by its order key; `inclusive` re-reads that row (the merged list did not show it yet). */
export interface SessionCursor { at: string; id: string; inclusive: boolean }
export const formatSessionCursor = (c: SessionCursor): string => encode([c.at, c.id, c.inclusive ? 1 : 0]);
/** Null when malformed. END_CURSOR is not a position; callers check it first. */
export function parseSessionCursor(cursor: string): SessionCursor | null {
	try {
		const v = decode(cursor);
		if (!Array.isArray(v) || v.length !== 3) return null;
		const [at, id, inc] = v as unknown[];
		return typeof at === "string" && ISO.test(at) && typeof id === "string" && ID.test(id) && (inc === 0 || inc === 1) ? { at, id, inclusive: inc === 1 } : null;
	} catch { return null; }
}

/** The merged cursor carries each profile's own cursor; null when malformed. */
export function parseSessionsCursor(cursor: string): Record<string, string> | null {
	try {
		const v = decode(cursor);
		if (!v || typeof v !== "object" || Array.isArray(v)) return null;
		const entries = Object.entries(v as Record<string, unknown>);
		if (!entries.length || entries.length > 64) return null;
		for (const [p, c] of entries) if (!PROFILE_NAME.test(p) || typeof c !== "string" || (c !== END_CURSOR && !parseSessionCursor(c))) return null;
		return Object.fromEntries(entries) as Record<string, string>;
	} catch { return null; }
}

/**
 * Newest last upload first across profiles; ties by session id, then profile. Each page is that profile's next rows in the same
 * order, so the shown rows of a profile are a prefix of its page. Its next cursor resumes after the last shown row, re-reads the
 * first row when none was shown, takes the page's own cursor when all were shown, and is END_CURSOR once it has no more.
 */
export function mergeSessions(pages: { profile: string; page: Page<SessionRow> }[], limit: number): Page<ProfileSessionRow> {
	const all = pages.flatMap(({ profile, page }) => page.rows.map((r) => ({ ...r, profile })));
	const cmp = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
	all.sort((a, b) => cmp(a.last_upload_at, b.last_upload_at) || cmp(a.id, b.id) || -cmp(a.profile, b.profile));
	const rows = all.slice(0, Math.max(1, limit));
	const cursors: Record<string, string> = {};
	for (const { profile, page } of pages) {
		const shown = rows.filter((r) => r.profile === profile).length, last = page.rows[shown - 1];
		cursors[profile] = shown === page.rows.length ? page.next_cursor ?? END_CURSOR
			: last ? formatSessionCursor({ at: last.last_upload_at, id: last.id, inclusive: false })
				: formatSessionCursor({ at: page.rows[0]!.last_upload_at, id: page.rows[0]!.id, inclusive: true });
	}
	return { rows, next_cursor: Object.values(cursors).every((c) => c === END_CURSOR) ? null : encode(cursors) };
}
