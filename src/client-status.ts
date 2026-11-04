// client_status (H1): POST /v1/status validation and the account table. The payload is an allowlist of counts,
// booleans, timestamps, hook names and client versions: no text, no paths.
import type { Outcome } from "./domain/types";
import { fail } from "./domain/types";
import type { ClientStatusBody, ClientStatusRow } from "./viewer/types";

/** At most this many bytes in a /v1/status body. */
export const STATUS_MAX_BYTES = 4096;
/** Refuses unknown fields, oversized bodies, and a `device` that differs from the token's device. */
export function parseClientStatus(_raw: unknown, _deviceId: string): Outcome<ClientStatusBody> {
	return fail("validation", "stub: H1");
}
/** Replaces the device's latest report. */
export function storeClientStatus(_sql: SqlStorage, _deviceId: string, _at: string, _body: ClientStatusBody): void {
	// stub: H1
}
export function listClientStatus(_sql: SqlStorage): ClientStatusRow[] {
	return []; // stub: H1
}
