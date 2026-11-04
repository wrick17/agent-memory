// health (H1): the deterministic cron health_sweep and its reads. It never calls a model and never changes records.
// Health rows outlive a profile wipe, so every detail is a fixed template filled only with ids, counts and times.
import { listClientStatus } from "./client-status";
import { BATCH_GAP_MS, SEMANTIC_MS } from "./profile/store";
import type { ClientStatusBody, ClientStatusRow, ConsolidationRow, HealthCheck, HealthCheckId, HealthReport, LeaseFacts, ProfileSnapshotPart, SweepInput, Verdict } from "./viewer/types";

const HOUR = 3_600_000;
const BATCH_OVERDUE_MS = 26 * HOUR, CAPTURE_STALE_MS = 48 * HOUR, BACKUP_OVERDUE_MS = 30 * HOUR, PENDING_OLD_MS = 7 * 24 * HOUR;

/** In the profile store: what the sweep needs from maintenance and its cursors. Read-only. */
export function leaseFacts(sql: SqlStorage, now: string): LeaseFacts {
	const done = sql.exec<{ at: string | null }>("SELECT max(done_at) AS at FROM maintenance WHERE lease_id IS NOT NULL AND state IN ('done','dismissed')").one().at;
	const leases = sql.exec<{ expired: number; open_until: string | null }>(`SELECT count(DISTINCT CASE WHEN lease_until < ? THEN lease_id END) AS expired,
		max(CASE WHEN lease_until >= ? THEN lease_until END) AS open_until FROM maintenance WHERE state = 'leased'`, now, now).one();
	// Work waiting for a batch: open items and expired leases, which the next lease takes back.
	const waiting = sql.exec<{ since: string | null }>("SELECT min(created_at) AS since FROM maintenance WHERE state = 'open' OR (state = 'leased' AND lease_until < ?)", now).one().since;
	const lastLease = sql.exec<{ at: string | null }>("SELECT max(last_run_at) AS at FROM cursors WHERE stage = 'maintenance_batch'").one().at;
	const skip = sql.exec<{ last_run_at: string | null; stats: string | null }>("SELECT last_run_at, stats FROM cursors WHERE stage = 'batch_status'").toArray()[0];
	const skipStatus = skip?.stats ? (JSON.parse(skip.stats) as { status?: unknown }).status : undefined;
	// The newer of the last completed item and the last recorded skip or park decides the outcome.
	const skipped = (skipStatus === "batch_skipped" || skipStatus === "stuck") && skip?.last_run_at && (!done || skip.last_run_at > done) ? skipStatus : null;
	const gate = lastLease ? new Date(Date.parse(lastLease) + BATCH_GAP_MS).toISOString() : null;
	return {
		last_completed_at: done,
		last_outcome: skipped ?? (done ? "completed" : null),
		expired_leases: leases.expired,
		open_lease_until: leases.open_until,
		// When the next lease may take waiting work: when work started waiting, or the 20-hour gate's end if later. Null when nothing waits.
		next_due_at: waiting && gate && gate > waiting ? gate : waiting,
	};
}

const row = (check_id: HealthCheckId, subject: string, state: Verdict, detail: string, at: string): HealthCheck => ({ check_id, subject, state, detail, at });
/** An ISO time for a template, or a fixed phrase: no stored string reaches a detail unchecked. */
const time = (v: string | null | undefined) => (v && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : "an unknown time");
const older = (v: string | null | undefined, now: number, ms: number) => !!v && now - Date.parse(v) > ms;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function profileChecks(profile: string, f: LeaseFacts, nowIso: string, now: number): HealthCheck[] {
	// The plan's rule: the last completed lease is more than 26 hours old. A profile with no completed lease has none in that window either.
	const batch = !f.last_completed_at
		? row("batch_overdue", profile, "warn", "No batch has completed in this profile yet.", nowIso)
		: older(f.last_completed_at, now, BATCH_OVERDUE_MS)
			? row("batch_overdue", profile, "warn", `The last batch completed at ${time(f.last_completed_at)}, more than 26 hours ago.`, nowIso)
			: row("batch_overdue", profile, "ok", `The last batch completed at ${time(f.last_completed_at)}.`, nowIso);
	const lease = f.expired_leases > 0
		? row("lease_expired", profile, "warn", `${plural(f.expired_leases, "lease", "leases")} expired without maintenance_complete.`, nowIso)
		: row("lease_expired", profile, "ok", f.open_lease_until ? `No lease has expired. One is open until ${time(f.open_lease_until)}.` : "No lease has expired.", nowIso);
	return [batch, lease];
}

/**
 * Only what the device measured gets a row. A v1 runner sends no status, a report without a digest time has nothing to age,
 * and an older runner leaves out the pending fields: none of those is flagged, and none is shown as passing.
 */
function deviceChecks(id: string, b: ClientStatusBody | undefined, nowIso: string, now: number): HealthCheck[] {
	if (!b) return [];
	const rows: HealthCheck[] = [];
	if (b.last_digest_at) {
		rows.push(older(b.last_digest_at, now, CAPTURE_STALE_MS)
			? row("capture_stale", id, "warn", `The last digest was at ${time(b.last_digest_at)}, more than 48 hours ago.`, nowIso)
			: row("capture_stale", id, "ok", `The last digest was at ${time(b.last_digest_at)}.`, nowIso));
	}
	if ((b.stuck_ranges ?? 0) > 0) {
		rows.push(row("capture_pending", id, "warn", `${plural(b.stuck_ranges!, "capture range is", "capture ranges are")} stuck. Run agent-memory doctor on this device.`, nowIso));
	} else if (older(b.oldest_pending_at, now, PENDING_OLD_MS)) {
		rows.push(row("capture_pending", id, "warn", `A capture range has been pending since ${time(b.oldest_pending_at)}, more than 7 days.`, nowIso));
	} else if (b.stuck_ranges !== undefined && b.oldest_pending_at !== undefined) {
		rows.push(row("capture_pending", id, "ok", b.oldest_pending_at ? `No capture range is stuck. The oldest pending one is from ${time(b.oldest_pending_at)}.` : "No capture range is stuck or pending.", nowIso));
	}
	return rows;
}

function backupCheck(last: string | null, nowIso: string, now: number): HealthCheck {
	if (!last) return row("backup_overdue", "account", "warn", "No encrypted export is recorded yet.", nowIso);
	return older(last, now, BACKUP_OVERDUE_MS)
		? row("backup_overdue", "account", "warn", `The last encrypted export was at ${time(last)}, more than 30 hours ago.`, nowIso)
		: row("backup_overdue", "account", "ok", `The last encrypted export was at ${time(last)}.`, nowIso);
}

/** Every health row the input implies. Pure, so the sweep and a fake-clock check give the same rows. */
export function sweepRows(input: SweepInput, status: Map<string, ClientStatusBody>): HealthCheck[] {
	const now = Date.parse(input.now), nowIso = new Date(now).toISOString();
	return [
		...[...input.profiles].sort((a, b) => a.profile.localeCompare(b.profile)).flatMap((p) => profileChecks(p.profile, p.facts, nowIso, now)),
		...input.devices.filter((d) => !d.revoked).flatMap((d) => deviceChecks(d.id, status.get(d.id), nowIso, now)),
		backupCheck(input.last_export_at, nowIso, now),
	];
}

/**
 * In the account store, inside its write transaction: applies the five rules and replaces the health rows. Rows for a subject
 * that is gone (a retired profile, a revoked device) or no longer measured are removed. An active profile whose lease facts
 * could not be read keeps its earlier rows and their times, so the sweep neither clears nor invents its state.
 * Repeating a sweep with the same input writes the same rows.
 */
export function healthSweep(sql: SqlStorage, input: SweepInput): HealthCheck[] {
	const read = new Set(input.profiles.map((p) => p.profile));
	const unread = sql.exec<{ name: string }>("SELECT name FROM profiles WHERE status = 'active'").toArray().map((r) => r.name).filter((n) => !read.has(n));
	const status = new Map(listClientStatus(sql).map((r) => [r.device_id, r.body]));
	const rows = sweepRows(input, status);
	sql.exec(`DELETE FROM health WHERE NOT EXISTS (SELECT 1 FROM json_each(?) j
		WHERE json_extract(j.value, '$[0]') = health.check_id AND json_extract(j.value, '$[1]') = health.subject)
		AND NOT (check_id IN ('batch_overdue', 'lease_expired') AND subject IN (SELECT value FROM json_each(?)))`,
		JSON.stringify(rows.map((r) => [r.check_id, r.subject])), JSON.stringify(unread));
	for (const r of rows) {
		sql.exec(`INSERT INTO health (check_id, subject, state, detail, at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (check_id, subject) DO UPDATE SET state = excluded.state, detail = excluded.detail, at = excluded.at`,
			r.check_id, r.subject, r.state, r.detail, r.at);
	}
	return rows;
}

export function readHealth(sql: SqlStorage): HealthCheck[] {
	return sql.exec<{ check_id: HealthCheckId; subject: string; state: Verdict; detail: string; at: string }>(
		"SELECT check_id, subject, state, detail, at FROM health ORDER BY check_id, subject").toArray().map((r) => row(r.check_id, r.subject, r.state, r.detail, r.at));
}
export function verdictOf(checks: HealthCheck[]): Verdict {
	return checks.some((c) => c.state === "fail") ? "fail" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
}

/** An export id (backup.ts: the ISO time without separators, a dash, 8 hex) back to its time. */
function exportAt(id: string): string | null {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{8}$/.exec(id);
	return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null;
}

/**
 * In the Worker: GET /api/health from the account's share, each profile's lease facts and one search-count slot per active
 * profile. A profile whose counts could not be read is passed as null, so the lexical count reads as unknown, not a subtotal.
 */
export function healthReport(account: { checks: HealthCheck[]; devices: ClientStatusRow[]; last_export_at: string | null; exports: string[] },
	leases: { profile: string; facts: LeaseFacts }[], parts: ({ usage: Pick<ProfileSnapshotPart["usage"], "lexical_documents" | "vectors"> } | null)[], embeddings: boolean): HealthReport {
	const read = parts.filter((p) => p !== null);
	const flagged = (p: string, id: "batch_overdue" | "lease_expired") => account.checks.some((c) => c.check_id === id && c.subject === p && c.state !== "ok");
	const consolidation: ConsolidationRow[] = [...leases].sort((a, b) => a.profile.localeCompare(b.profile)).map(({ profile, facts }) => ({
		profile, last_batch_at: facts.last_completed_at, outcome: facts.last_outcome, next_due_at: facts.next_due_at,
		flags: (["batch_overdue", "lease_expired"] as const).filter((id) => flagged(profile, id)),
	}));
	const retained = account.exports.flatMap((id) => { const at = exportAt(id); return at ? [{ id, at }] : []; }).sort((a, b) => b.at.localeCompare(a.at));
	return {
		verdict: verdictOf(account.checks), checks: account.checks, devices: account.devices, consolidation,
		backups: { last_export_at: account.last_export_at, retained },
		search: { lexical_documents: read.length && read.length === parts.length ? read.reduce((n, p) => n + p.usage.lexical_documents, 0) : null,
			// shortcut: vectors is a number in the contract, so a profile whose part failed is left out of it; the null lexical count marks that.
			vectors: read.reduce((n, p) => n + p.usage.vectors, 0), embeddings, semantic_ms: SEMANTIC_MS },
	};
}
