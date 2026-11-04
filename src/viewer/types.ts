// v2 contracts (X0 checkpoint A): every new response, request and stub signature shape. Types only; no runtime code.
// Profile choice follows #3: the calling agent names the target, storage validates it and never classifies text, names or
// paths as work or personal. Every new request field is optional so v1 runners behave as they do today.
import type { EVIDENCE_KINDS, RepoRef } from "../domain/types";

// ---- Shared ----------------------------------------------------------------------------------------------------------

/** The plan's Evidence[]: the same pointer shape maintenance ops and record_knowledge use. `kind: "node"` refs are node ids. */
export type Evidence = { kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note?: string };
export type Client = "claude-code" | "codex";
export type Verdict = "ok" | "warn" | "fail";
/** From the version_metadata binding (X wires CF_VERSION_METADATA in wrangler.jsonc). */
export interface VersionInfo { version: string; deployed_at: string }
export interface Page<T> { rows: T[]; next_cursor: string | null }

// ---- Recall (R1) -----------------------------------------------------------------------------------------------------

export type RecallChannel = "lexical" | "vector";
/** recall() options from POST /v1/recall and /api/profiles/:p/recall. recall_memories' MCP schema does not change. */
export interface RecallOptions { channels?: RecallChannel[]; count_hits?: boolean } // defaults: both channels, count_hits true
/**
 * POST /v1/recall: the owner or a device with the read scope; a job token gets 403. Same read set and routing as
 * recall_memories: an explicit `profile` reads exactly that profile plus the authorized me overlay; an omitted profile uses
 * the legacy mappings, then the device default, then me. `repo` is only the legacy fallback. No include_me field.
 * The reply is recall_memories' data, unchanged.
 */
export interface RecallRequest {
	keyword: string; repo?: RepoRef; profile?: string; limit?: number; token_budget?: number;
	channels?: RecallChannel[]; count_hits?: boolean;
}
/** Per-node recall strength from recall_daily: hits in the last 90 UTC days. strength is min(hits_90d, 10). */
export interface RecallStrength { hits_90d: number; strength: number; last_recalled: string | null }
/**
 * One profile's recall_totals day. A recall counts once in each profile that returned hits to it, so a sum across profiles
 * is profile participations, not unique recalls or MCP calls (label it so).
 */
export interface RecallTotals { day: string; recalls: number; tokens: number }

// ---- Eval (R1, EV1) --------------------------------------------------------------------------------------------------

export type EvalChannels = "lexical" | "vector" | "hybrid";
/**
 * POST /v1/eval/runs body, job token. `profile` is explicit (eval --profile is required); the Worker accepts it only when the
 * job device may use that profile, and never infers one. Scores and counts only: k 1-100, cases 0-10,000, scores 0-1.
 */
export interface EvalRunInput {
	profile: string; at: string; channels: EvalChannels; k: number; cases: number;
	recall_all_at_k: number; any_hit_at_k: number; mrr: number;
}
/** An eval_runs row; the Worker sets id and device_id from the token. Content-free, kept on profile wipe and merged on restore. */
export interface EvalRun extends EvalRunInput { id: string; device_id: string }
export type EvalCandidateStatus = "pending" | "accepted" | "dismissed";
/**
 * An eval_candidates row. query is at most 280 characters, expected 1-20 node ids, evidence 1-20 pointers. expected ids and
 * evidence refs of kind "node" are queryable, so a wipe purges every candidate naming a purged node, in every status, even when
 * the node lived in another profile (the me overlay). Insertion refuses a wiped id in the same transaction, and a restored
 * generation gets every permanent wipe identity back, with matching candidates and recall_daily rows removed, before it opens.
 */
export interface EvalCandidate {
	id: string; query: string; expected: string[]; evidence: Evidence[]; status: EvalCandidateStatus; created_at: string;
}
/** The suggest_eval_case maintenance op (M1 validates; R1 stores through insertCandidate). */
export interface SuggestEvalCaseOp { op: "suggest_eval_case"; query: string; expected: string[]; evidence: Evidence[] }
export interface EvalCandidateQuery { status?: EvalCandidateStatus | "all"; cursor?: string; limit?: number }
/** POST /api/profiles/:p/eval-candidates/:id */
export interface EvalCandidateDecision { action: "accept" | "dismiss" }

// ---- Client status and health (H1) -----------------------------------------------------------------------------------

/**
 * POST /v1/status body, job token. The device comes from the token; `device`, when sent, must match it. The server keeps
 * only these allowlisted fields: counts, booleans, timestamps, hook names and client versions (each matching
 * ^[0-9A-Za-z.+-]{1,32}$). No text, no paths and no session ids; doctor shows those locally.
 * The pending fields are optional so an older runner still validates: capture ranges pending or stuck (section 10, steps 2 and 6),
 * the oldest pending range's time, and sessions whose transcript was not found.
 */
export interface ClientStatusBody {
	device?: string; clients: Partial<Record<Client, string>>;
	hooks: ("Stop" | "SessionEnd" | "SessionStart" | "PreCompact" | "UserPromptSubmit")[]; inject: boolean;
	spool_files: number; spool_bytes: number; oldest_spool_at: string | null;
	last_digest_at: string | null; refused_since_last: number; launchd_loaded: boolean;
	pending_ranges?: number; stuck_ranges?: number; oldest_pending_at?: string | null; missing_sources?: number;
}
export interface ClientStatusRow { device_id: string; device_name: string | null; revoked: boolean; reported_at: string; body: ClientStatusBody }
/** capture_pending: warn when a device reports stuck ranges or a pending range older than 7 days. */
export type HealthCheckId = "batch_overdue" | "lease_expired" | "capture_stale" | "capture_pending" | "backup_overdue";
/**
 * A health row. subject is a profile name (batch_overdue, lease_expired), a device id (capture_stale, capture_pending), or
 * "account" (backup_overdue). detail comes only from fixed server templates filled with ids, counts and times, never record
 * text, so rows can survive a wipe; the dashboard sets it as text.
 */
export interface HealthCheck { check_id: HealthCheckId; subject: string; state: Verdict; detail: string; at: string }
/** What one profile reports to the sweep (read in the profile store, deterministic, no model). */
export interface LeaseFacts {
	last_completed_at: string | null; last_outcome: "completed" | "batch_skipped" | "stuck" | null;
	expired_leases: number; open_lease_until: string | null; next_due_at: string | null;
}
/** Everything health_sweep reads; the account store gathers it, then healthSweep writes rows. */
export interface SweepInput {
	now: string;
	profiles: { profile: string; facts: LeaseFacts }[];
	devices: { id: string; revoked: boolean }[];
	last_export_at: string | null;
}
export interface ConsolidationRow { profile: string; last_batch_at: string | null; outcome: LeaseFacts["last_outcome"]; next_due_at: string | null; flags: ("batch_overdue" | "lease_expired")[] }
/** GET /api/health: the Health tab beyond the snapshot. */
export interface HealthReport {
	verdict: Verdict; checks: HealthCheck[]; devices: ClientStatusRow[]; consolidation: ConsolidationRow[];
	backups: { last_export_at: string | null; retained: { id: string; at: string }[] };
	search: { lexical_documents: number; vectors: number; embeddings: boolean; semantic_ms: number };
}

// ---- Sessions and replay (S1, P1) ------------------------------------------------------------------------------------

/**
 * One replay event. label is the digest excerpt or transcript text. detail keys, all optional strings:
 * hosted digest events: part (the digest part id), pos (transcript byte offset), outcome ("commit", "pr" or "test");
 * local transcript events: role ("owner" or "assistant"), tool, input, output, truncated ("true" when cut at 8 KB).
 * Digests store no reasons or file lists, so no other key appears.
 */
export type ReplayEvent = {
	i: number;
	kind: "prompt" | "response" | "tool_call" | "tool_result" | "ask" | "decision" | "correction" | "outcome";
	label: string;
	offset_ms: number | null; // null for hosted digests: they keep order, not time
	detail: Record<string, string>;
};
export interface SessionRow {
	id: string; client: Client; session: string;
	device: string | null;  // attrs.device_id from the ingest token; null for sessions stored before v2
	project: string | null; // the project node the digests link to
	first_upload_at: string; last_upload_at: string; // upload times, not the session's own start and end
	status: "active" | "completed"; first_ask: string | null;
	// files_changed: the runner's cumulative count of distinct files edited in the session (session.files_changed on ingest,
	// counted locally; paths never leave the machine). The largest count received is kept; null for runners that never send it.
	counts: { asks: number; decisions: number; corrections: number; outcomes: number; parts: number; files_changed: number | null };
}
/** A row in a list that spans profiles (GET /api/sessions, snapshot recent_sessions). The Worker stamps profile. */
export type ProfileSessionRow = SessionRow & { profile: string };
export interface SessionDetail extends SessionRow {
	events: ReplayEvent[];
	produced: { id: string; kind: string; title: string; via: "evidence" | "inferred_preference" }[];
}
export type SessionQuery = { cursor?: string; project?: string; client?: string; status?: string; limit?: number };
/** Owner queue requests (TG4 "Queue link maintenance", TG5 "Queue consolidation"): fingerprinted, so a repeat queues nothing. */
export type OwnerQueue = { kind: "unlinked"; ids: string[] } | { kind: "unprocessed_capture"; session: string };

// ---- Viewer snapshot and events (V1, V2) -----------------------------------------------------------------------------

export type FeedKind = "MEMORY" | "IMPORT" | "FORGET" | "PREFERENCE" | "BATCH";
/** One live-feed entry, and the data of an `event: change`. summary is activity text the dashboard sets as text. */
export interface FeedItem { kind: FeedKind; profile: string; id: string; summary: string; at: string }
export interface LayerState { layer: "digests" | "parts" | "memories" | "preferences" | "me"; count: number; state: "ok" | "waiting" | "off"; waits_for: string | null }
export interface FeatureFlag { id: "embeddings" | "corpus" | "capture" | "inject" | "scheduled_batch"; state: "on" | "off" | "inactive"; tabs: string[]; how: string }
export interface SnapshotCounts {
	memories: number; revisions: number; observations: number; sessions: number; sessions_active: number;
	lessons: number; crystals: number; actions: number; graph_nodes: number; graph_edges: number;
}
export interface SnapshotUsage {
	recalls_today: number; recall_tokens_today: number; writes_today: number; // UTC day, from recall_totals and activity
	storage_bytes: number; storage_limit: number; vectors: number;            // vectors: nodes whose embed_hash equals card_hash
}
/** GET /api/viewer/snapshot, owner only. `cursor` is the events cursor (formatCursor in src/viewer/events.ts). */
export type Snapshot = {
	at: string; version: string; deployed_at: string; profiles: string[]; cursor: string;
	counts: SnapshotCounts; usage: SnapshotUsage;
	health: { verdict: Verdict; checks: HealthCheck[] };
	recent_sessions: ProfileSessionRow[]; feed: FeedItem[]; layers: LayerState[]; flags: FeatureFlag[];
};
/** One profile's share of the snapshot, computed inside its store (profilePart in src/viewer/snapshot.ts). */
export interface ProfileSnapshotPart {
	profile: string; seq: number; counts: SnapshotCounts; usage: Omit<SnapshotUsage, "storage_limit">;
	recent_sessions: SessionRow[]; feed: FeedItem[]; layers: LayerState[];
}
/** The account's share: health rows and the facts behind the feature flags. */
export interface AccountSnapshotPart { checks: HealthCheck[]; devices_reporting: number; inject_devices: number; scheduled_devices: number }
/** Profile cursor -> last activity id seen. Serialized opaque by formatCursor/parseCursor. */
export type ViewerCursor = Record<string, number>;
/** GET /api/viewer/events?cursor=, text/event-stream, owner only; device tokens get 403. */
export type ViewerEvent = { event: "change"; id: string; data: FeedItem } | { event: "health"; id: string; data: HealthCheck[] };

// ---- Insights (IN1) --------------------------------------------------------------------------------------------------

/** GET /api/profiles/:p/activity-summary?from=&to= (UTC days, at most one year). */
export interface ActivitySummaryQuery { from: string; to: string }
export interface ActivitySummary {
	from: string; to: string; active_days: number; sessions: number; observations: number; busiest_day: string | null;
	days: { day: string; count: number }[]; // active days only (count > 0), ascending; the heatmap fills the rest with 0
	kinds: { asks: number; decisions: number; corrections: number; commits: number; tests: number; prs: number };
	top_files: { path: string; count: number }[]; // from commit paths, which uploads carry only when the corpus is on; else empty
	busiest_sessions: { id: string; title: string | null; observations: number }[];
	latest: { session: string; kind: "ask" | "decision" | "correction" | "outcome"; text: string; at: string }[];
}
/** GET /api/profiles/:p/projects: the Profile tab's picker. */
export interface ProjectSummary { key: string; name: string; sessions: number; last_activity: string | null }
/** GET /api/profiles/:p/projects/:key/profile, computed on request within the graph work budgets. */
export interface ProjectProfile extends ProjectSummary {
	concepts: { id: string; name: string; kind: string; count: number }[];
	files: { path: string; count: number }[]; // same source as ActivitySummary.top_files
	conventions: { id: string; name: string; kind: "rule" | "preference"; origin: string }[];
	recurring_errors: { entity_id: string; entity: string; count: number; corrections: { id: string; text: string }[] }[];
	highlights: { id: string; title: string; at: string }[];
}

// ---- Route and auth table --------------------------------------------------------------------------------------------

/**
 * Every v2 route. auth: "owner" is a Clerk session or OAuth access token (/api/* refuses am_ device tokens with 403);
 * "read" is the owner or a device with the read scope (a job token gets 403); "job" is a device token with ingest and
 * maintenance; "owner_or_device" is any authenticated owner or enabled, unrevoked device token. Type-level only; F0 samples type against `reply`.
 */
export interface V2Routes {
	"POST /v1/recall": { auth: "read"; body: RecallRequest; reply: unknown };
	"POST /api/profiles/:p/recall": { auth: "owner"; body: RecallRequest; reply: unknown };
	"POST /v1/status": { auth: "job"; body: ClientStatusBody; reply: { reported_at: string } };
	"POST /v1/eval/runs": { auth: "job"; body: EvalRunInput; reply: { id: string } };
	"GET /api/eval/runs": { auth: "owner"; query: { profile?: string; limit?: number }; reply: { runs: EvalRun[] } };
	"GET /api/profiles/:p/eval-candidates": { auth: "owner"; query: EvalCandidateQuery; reply: Page<EvalCandidate> };
	"POST /api/profiles/:p/eval-candidates/:id": { auth: "owner"; body: EvalCandidateDecision; reply: EvalCandidate };
	"GET /api/health": { auth: "owner"; reply: HealthReport };
	"POST /api/health/sweep": { auth: "owner"; reply: { checks: HealthCheck[] } };
	"GET /api/profiles/:p/sessions": { auth: "owner"; query: SessionQuery; reply: Page<SessionRow> };
	"GET /api/profiles/:p/sessions/:id": { auth: "owner"; reply: SessionDetail };
	"GET /api/sessions": { auth: "owner"; query: SessionQuery; reply: Page<ProfileSessionRow> };
	"GET /api/viewer/snapshot": { auth: "owner"; reply: Snapshot };
	"GET /api/viewer/events": { auth: "owner"; query: { cursor?: string }; reply: ViewerEvent };
	"GET /api/profiles/:p/activity-summary": { auth: "owner"; query: ActivitySummaryQuery; reply: ActivitySummary };
	"GET /api/profiles/:p/projects": { auth: "owner"; reply: { projects: ProjectSummary[] } };
	"GET /api/profiles/:p/projects/:key/profile": { auth: "owner"; reply: ProjectProfile };
	/** Existing route. The owner reply is unchanged; an authenticated, enabled device token gets only its own facts. Never anonymous. */
	/** Up to 100 comma-separated ids; ids with no hit get zeros. Serves the Memories and Lessons tables and detail panels. */
	"GET /api/profiles/:p/recall-strength": { auth: "owner"; query: { ids: string }; reply: { strength: Record<string, RecallStrength> } };
	/** Accepted candidates for `agent-memory eval export-candidates`: explicit profile the read token may use; oldest first. */
	"GET /v1/eval/candidates": { auth: "read"; query: { profile: string; cursor?: string; limit?: number }; reply: Page<EvalCandidate> };
	/** 1-40 active memory node ids of this profile. */
	"POST /api/profiles/:p/maintenance/queue": { auth: "owner"; body: Extract<OwnerQueue, { kind: "unlinked" }>; reply: { queued: number } };
	"POST /api/profiles/:p/sessions/:id/consolidate": { auth: "owner"; reply: { queued: number } };
	"GET /v1/whoami": { auth: "owner_or_device"; reply: { claims: unknown } | { kind: "device"; device_id: string; scopes: string[]; profiles: string[] } };
}
