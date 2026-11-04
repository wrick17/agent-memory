// GET /api/sessions (S1): merges each readable profile's session page by last_upload_at.
import type { Page, ProfileSessionRow, SessionRow } from "./viewer/types";

/** The merged cursor carries each profile's own cursor; null when malformed. */
export function parseSessionsCursor(_cursor: string): Record<string, string> | null {
	return null; // stub: S1
}
export function mergeSessions(_pages: { profile: string; page: Page<SessionRow> }[], _limit: number): Page<ProfileSessionRow> {
	return { rows: [], next_cursor: null }; // stub: S1
}
