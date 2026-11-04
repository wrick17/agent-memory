// client_status (H1): POST /v1/status validation and the account table. The payload is an allowlist of counts,
// booleans, timestamps, hook names and client versions: no text, no paths.
import { z } from "zod";
import type { Outcome } from "./domain/types";
import { fail, ok } from "./domain/types";
import type { ClientStatusBody, ClientStatusRow } from "./viewer/types";

/** At most this many bytes in a /v1/status body. */
export const STATUS_MAX_BYTES = 4096;

const version = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Any ISO 8601 time with a zone; stored as UTC so templates and comparisons see one form.
const at = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());
const HOOKS = ["Stop", "SessionEnd", "SessionStart", "PreCompact", "UserPromptSubmit"] as const;
const schema = z.strictObject({
	device: z.string().min(1).max(128).optional(),
	clients: z.strictObject({ "claude-code": version.optional(), codex: version.optional() }),
	hooks: z.array(z.enum(HOOKS)).max(HOOKS.length).refine((h) => new Set(h).size === h.length),
	inject: z.boolean(),
	spool_files: count, spool_bytes: count, oldest_spool_at: at.nullable(),
	last_digest_at: at.nullable(), refused_since_last: count, launchd_loaded: z.boolean(),
	pending_ranges: count.optional(), stuck_ranges: count.optional(), oldest_pending_at: at.nullable().optional(), missing_sources: count.optional(),
});

/** Refuses unknown fields, oversized bodies, and a `device` that differs from the token's device. */
export function parseClientStatus(raw: unknown, deviceId: string): Outcome<ClientStatusBody> {
	if (new TextEncoder().encode(JSON.stringify(raw) ?? "").length > STATUS_MAX_BYTES) return fail("validation", `a status report is at most ${STATUS_MAX_BYTES} bytes`);
	const r = schema.safeParse(raw);
	// The message names the fields only; a refused value is never echoed back or logged.
	if (!r.success) return fail("validation", `status report refused: ${[...new Set(r.error.issues.map((i) => i.path.join(".") || "body"))].slice(0, 8).join(", ")}`);
	if (r.data.device !== undefined && r.data.device !== deviceId) return fail("validation", "device does not match this token's device");
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the row is keyed by the token's device; the sent copy is not kept
	const { device, ...body } = r.data;
	return ok(body);
}

/** Replaces the device's latest report. */
export function storeClientStatus(sql: SqlStorage, deviceId: string, at: string, body: ClientStatusBody): void {
	sql.exec(`INSERT INTO client_status (device_id, reported_at, body) VALUES (?, ?, ?)
		ON CONFLICT (device_id) DO UPDATE SET reported_at = excluded.reported_at, body = excluded.body`, deviceId, at, JSON.stringify(body));
}

/**
 * Each device's latest report, newest first, with its name and whether it is revoked or disabled. A row whose device is gone
 * reads as revoked. Stored bodies pass the same allowlist again (a restore brings rows back), and a row that fails is skipped.
 */
export function listClientStatus(sql: SqlStorage): ClientStatusRow[] {
	return sql.exec<{ device_id: string; name: string | null; revoked: number; reported_at: string; body: string }>(
		`SELECT c.device_id, d.name, (d.id IS NULL OR d.revoked_at IS NOT NULL OR d.enabled = 0) AS revoked, c.reported_at, c.body
		FROM client_status c LEFT JOIN devices d ON d.id = c.device_id ORDER BY c.reported_at DESC, c.device_id`).toArray().flatMap((r) => {
		const b = parseClientStatus(JSON.parse(r.body) as unknown, r.device_id);
		return b.ok ? [{ device_id: r.device_id, device_name: r.name, revoked: r.revoked === 1, reported_at: r.reported_at, body: b.value }] : [];
	});
}
