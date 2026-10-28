// Shared types and the phase-1 ontology. One list each; schemas and SQL CHECKs derive from these.

export const NODE_KINDS = ["project", "component", "person", "bug", "feature", "ticket", "pr", "commit", "release",
	"decision", "rule", "preference", "session", "journal", "document", "other"] as const;
export const RELATIONS = ["works_on", "authored", "reviewed", "reported", "assigned", "part_of", "depends_on",
	"implements", "fixes", "introduced_by", "caused_by", "blocked_by", "decided_because", "supersedes", "contradicts",
	"relates_to", "other"] as const;
export const MEMORY_KINDS = ["decision", "rule", "preference", "journal", "document"] as const;
export const MEMORY_TYPES = ["feedback", "project", "reference", "user", "procedural"] as const;
export const ORIGINS = ["stated", "agent", "inferred", "import", "upload", "index"] as const;
export const STATUSES = ["active", "retired", "superseded", "candidate", "dismissed", "incoming", "moving", "moved"] as const;
export const SCOPES = ["read", "write", "ingest", "maintenance", "import"] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type Origin = (typeof ORIGINS)[number];
export type Status = (typeof STATUSES)[number];
export type Scope = (typeof SCOPES)[number];

/** BothQ type to the kinds it may be stored as; the first is the default. */
export const KINDS_FOR_TYPE: Record<MemoryType, readonly MemoryKind[]> = {
	feedback: ["rule"],
	user: ["preference"],
	procedural: ["document"],
	reference: ["document"],
	project: ["decision", "journal"],
};

/** Profiles that exist from day one. Profile names are at most 12 bytes (section 11). */
export const PROFILES = ["me", "work", "personal", "test"] as const;
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,11}$/;

export type ErrorCode = "not_found" | "ambiguous" | "revision_conflict" | "idempotency_mismatch" | "already_exists" | "validation"
	| "protected" | "forbidden" | "route_required" | "me_requires_company_free" | "me_sensitive_term" | "size_budget"
	| "moving" | "busy" | "unauthorized" | "unavailable";

export interface Failure { code: ErrorCode; message: string; details?: Record<string, unknown> }
/** Errors are values. Thrown errors lose their fields across Durable Object RPC. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Failure };

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): { ok: false; error: Failure } =>
	({ ok: false, error: details ? { code, message, details } : { code, message } });

/** Thrown inside a write transaction to roll it back; converted to an Outcome at the store boundary. */
export class Fail extends Error {
	constructor(readonly failure: Failure) { super(failure.message); }
	static of(code: ErrorCode, message: string, details?: Record<string, unknown>): Fail {
		return new Fail(details ? { code, message, details } : { code, message });
	}
}

export interface RepoRef { remote?: string; path?: string }

/** Who is calling, after authentication. OAuth callers are the owner and may use every profile. */
export interface Caller {
	userId: string;
	kind: "owner" | "device";
	deviceId?: string;
	deviceName?: string;
	scopes: Scope[];
	profiles: "*" | string[];
	defaultProfile?: string;
}

export interface RoutingRule { id: string; priority: number; match: "remote" | "path"; pattern: string; profile: string; enabled: boolean }

/** The routed profile plus `me`. Recall never reads two non-me profiles. */
export interface ReadSet { primary: string; withMe: boolean }

/** Where a profile's current generation lives (section 11). */
export interface ProfileRef { userId: string; profile: string; generation: string }

export interface Step { order: number; action: string; success_criteria: string }

/** Validated and redacted save_memory arguments, in BothQ names. */
export interface SaveArgs {
	name?: string; memory_id?: string; type?: MemoryType; kind?: MemoryKind; description?: string; content?: string;
	why?: string; how_to_apply?: string; objective?: string; steps?: Step[]; scope?: string; from_scope?: string;
	new_name?: string; origin?: "stated" | "agent"; retire?: boolean; supersedes?: string | string[];
	expected_revision?: number; request_id?: string;
}
export interface AppendArgs {
	name?: string; memory_id?: string; type?: MemoryType; scope?: string; content: string; separator?: string;
	expected_revision?: number; request_id: string;
}

export type WriteCommand = { op: "save"; args: SaveArgs } | { op: "append"; args: AppendArgs };

export interface WriteContext {
	actor: "agent" | "owner";
	deviceId?: string;
	platform: string;
	routedBy: string;
	/** BothQ-style request hash over the redacted arguments, computed by the Worker and bound in AccountStore. */
	payloadHash: string;
	userId: string;
	/** Inputs for the `me` guard; required on every write to `me`. Checked after a committed replay, before any change. */
	meGuard?: { explicit: boolean; context: string | null; companyFree: boolean; sensitiveTerms: string[] };
}

export interface Identity { memory_id?: string; name?: string; scope?: string; type?: MemoryType }

export type ReadQuery =
	| { kind: "get"; target: Identity; includeRetired: boolean; history?: { limit: number; beforeRevision?: number }; content?: { complete: boolean; cursor?: string } }
	| { kind: "recall"; keyword: string; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; limit: number; includeHistory: boolean; semantic: boolean; deadline: number }
	| { kind: "inventory"; after: number; limit: number; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; includeHistory: boolean }
	| { kind: "has"; id: string };

export interface RecallHit {
	memory_id: string; profile: string; kind: string; type: string | null; name: string; scope: string; origin: string;
	status: string; revision: number; passage: string; matched_by: string[]; score: number;
	objective: string | null; step_count: number;
	provenance: { source_platform: string | null; updated_source_platform: string | null; source_hash: string };
	freshness: { created_at: string; updated_at: string; valid_from: string | null; valid_until: string | null };
	/** Row position, used by the inventory cursor. */
	row: number;
}

export interface RecallPage { hits: RecallHit[]; diagnostics: Record<string, string>; vectorUsed: boolean }
