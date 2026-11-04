// Sessions read from capture nodes and their digests (S1). The signatures are the contract.
import type { SessionDetail, SessionQuery, SessionRow } from "../viewer/types";

export function listSessions(_sql: SqlStorage, _q: SessionQuery): { rows: SessionRow[]; next_cursor: string | null } {
	return { rows: [], next_cursor: null }; // stub: S1
}
export function sessionDetail(_sql: SqlStorage, _id: string): SessionDetail | null {
	return null; // stub: S1
}
