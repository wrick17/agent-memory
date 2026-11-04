// health (H1): the deterministic cron health_sweep and its reads. It never calls a model and never changes records.
import type { ClientStatusRow, HealthCheck, HealthReport, LeaseFacts, ProfileSnapshotPart, SweepInput, Verdict } from "./viewer/types";

/** In the profile store: what the sweep needs from maintenance and profile_meta. */
export function leaseFacts(_sql: SqlStorage, _now: string): LeaseFacts {
	return { last_completed_at: null, last_outcome: null, expired_leases: 0, open_lease_until: null, next_due_at: null }; // stub: H1
}
/** In the account store: applies batch_overdue, lease_expired, capture_stale and backup_overdue, replaces the health rows, returns them. */
export function healthSweep(_sql: SqlStorage, _input: SweepInput): HealthCheck[] {
	return []; // stub: H1
}
export function readHealth(_sql: SqlStorage): HealthCheck[] {
	return []; // stub: H1
}
export function verdictOf(checks: HealthCheck[]): Verdict {
	return checks.some((c) => c.state === "fail") ? "fail" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
}
/** In the Worker: GET /api/health from the account's share, each profile's lease facts and its snapshot part (search counts). */
export function healthReport(account: { checks: HealthCheck[]; devices: ClientStatusRow[]; last_export_at: string | null; exports: string[] },
	_leases: { profile: string; facts: LeaseFacts }[], _parts: ProfileSnapshotPart[], embeddings: boolean): HealthReport {
	return { verdict: verdictOf(account.checks), checks: account.checks, devices: account.devices, consolidation: [],
		backups: { last_export_at: account.last_export_at, retained: [] }, search: { lexical_documents: 0, vectors: 0, embeddings, semantic_ms: 3000 } }; // stub: H1
}
