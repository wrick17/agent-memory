// Shared types and the phase-1 ontology. One list each; schemas and SQL CHECKs derive from these.

export const NODE_KINDS = ["project", "component", "person", "bug", "feature", "ticket", "pr", "commit", "release",
	"decision", "rule", "preference", "session", "journal", "document", "other"] as const;
export const RELATIONS = ["works_on", "authored", "reviewed", "reported", "assigned", "part_of", "depends_on",
	"implements", "fixes", "introduced_by", "caused_by", "blocked_by", "decided_because", "supersedes", "contradicts",
	"relates_to", "other"] as const;
export const MEMORY_KINDS = ["decision", "rule", "preference", "journal", "document"] as const;

type Kind = (typeof NODE_KINDS)[number];
const TRACKER: Kind[] = ["bug", "feature", "ticket"];
const NOTES: Kind[] = ["decision", "rule", "preference", "journal", "document"];
/**
 * The endpoint table (section 4): the node kinds each typed relation may connect, from and to. `relates_to` and `other`
 * connect anything; `supersedes` needs the same kind on both ends. A judgment edge outside this table fails with validation.
 * Memory supersession (save_memory's `supersedes`, the import's link) follows BothQ instead: any two memories.
 */
export const RELATION_ENDPOINTS: Partial<Record<(typeof RELATIONS)[number], { from: Kind[]; to: Kind[] }>> = {
	works_on: { from: ["person"], to: ["project", "component", ...TRACKER] },
	authored: { from: ["person"], to: ["commit", "pr", "release", "document"] },
	reviewed: { from: ["person"], to: ["pr"] },
	reported: { from: ["person"], to: TRACKER },
	assigned: { from: ["person"], to: TRACKER },
	part_of: { from: ["component", "commit", "pr", "session", "project", ...TRACKER], to: ["project", "component", "pr", "feature", "release"] },
	depends_on: { from: ["project", "component"], to: ["project", "component"] },
	implements: { from: ["commit", "pr"], to: ["feature", "ticket"] },
	fixes: { from: ["commit", "pr"], to: ["bug", "ticket"] },
	introduced_by: { from: ["bug"], to: ["commit", "pr", "release"] },
	caused_by: { from: TRACKER, to: ["commit", "pr", "release", "component", "decision", ...TRACKER] },
	blocked_by: { from: [...TRACKER, "pr"], to: [...TRACKER, "pr", "component"] },
	decided_because: { from: ["decision"], to: [...NODE_KINDS] },
	contradicts: { from: NOTES, to: NOTES },
};
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
	| "protected" | "forbidden" | "route_required" | "me_sensitive_term" | "size_budget"
	| "moving" | "busy" | "unauthorized" | "unavailable" | "transfer_collision" | "profile_wiped" | "undo_redacted" | "lease_expired";

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
	new_name?: string; retire?: boolean; supersedes?: string | string[];
	expected_revision?: number; request_id?: string;
	compact?: { through_seq: number; summary: string };
	/** `inferred` is internal: only the maintenance batch's infer_preference, record_lesson and record_decision set it. MCP exposes `evidence`, never `inferred`. */
	origin?: "stated" | "agent" | "inferred";
	evidence?: { kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note?: string }[];
	/** Judgment links from the saved node to nodes of its profile, as record_knowledge edges with an implicit `from`. */
	links?: Omit<NonNullable<KnowledgeArgs["edges"]>[number], "from">[];
	/** Internal: only the maintenance batch's strategic_review sets it, as the document's attrs (kind strategic_review). MCP has no attrs. */
	review?: { as_of: string; item: number; coverage: object };
}
export interface AppendArgs {
	name?: string; memory_id?: string; type?: MemoryType; scope?: string; content: string; separator?: string;
	expected_revision?: number; request_id: string;
}

/** capture_memory: redacted, untrusted evidence kept as a candidate outside ordinary recall. */
export interface CaptureArgs { content: string; kind?: "observation" | "correction"; name?: string; source?: Record<string, string>; scope?: string; request_id?: string }
/** review_candidates promote or dismiss. Promotion creates the memory and links it to the capture in one transaction. */
export interface CandidateArgs { action: "promote" | "dismiss"; candidate_id: string; into?: { name: string; type: "feedback" | "project" | "reference" | "user"; description?: string }; reason?: string; request_id?: string }

export const EVIDENCE_KINDS = ["entry", "commit", "pr", "ticket", "session", "file", "node", "url", "corpus"] as const;
/** Entity kinds record_knowledge may create; memories (rules, preferences, journals, documents) go through save_memory. */
export const KNOWLEDGE_KINDS = ["project", "component", "person", "bug", "feature", "ticket", "pr", "commit", "release", "decision", "other"] as const;
export type KnowledgeRef = { id: string } | { kind: string; key: string } | { kind: string; name: string; scope?: string } | { ref: number };
export interface KnowledgeArgs {
	nodes?: { kind: (typeof KNOWLEDGE_KINDS)[number]; key?: string; name: string; scope?: string; other_label?: string; description?: string; why?: string; attrs?: Record<string, string | number | boolean | null>; evidence?: { kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note?: string }[]; valid_from?: string; valid_to?: string }[];
	edges?: { from: KnowledgeRef; rel: (typeof RELATIONS)[number]; other_label?: string; to: KnowledgeRef; reason: string; evidence: { kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note?: string }[]; valid_from?: string; valid_to?: string }[];
	end?: { edge: number; valid_to: string; reason: string }[];
	request_id?: string;
}

/**
 * One uploaded work item (section 10), already validated, redacted and stripped of personal fields by the Worker. `repo` is
 * the GitHub namespace `Org/repo`; `request_id` is the item's natural id, so a repeat replays and a changed item is refused.
 */
export interface CommitUploadArgs { item: "commit"; repo: string; sha: string; at: string; title: string; author?: string; request_id: string }
/**
 * A PR snapshot at GitHub's `updated_at`, read locally with gh. Handles and full SHAs are lowercase, `closes` holds the
 * `github:<repo>#<n>` keys of GitHub's closingIssuesReferences, `unknown` names fields gh could not supply in full, and
 * `review_requested_from_owner` is present only when the caller named the owner's login. `as_of` is when it was read.
 */
export interface PRUploadArgs {
	item: "pr"; repo: string; number: number; title: string; state: "open" | "closed"; updated_at: string; head: string; author?: string;
	reviewers: string[]; commits: string[]; closes: string[]; unknown: string[]; review_requested_from_owner?: boolean; as_of: string; request_id: string;
}
/**
 * A Jira ticket snapshot at Jira's own `updated` time, read locally through the read-only connector (work only). `key` is
 * `PROJECT-N`; `type` is Jira's issue type name and `kind` its ontology kind. Handles are Jira account ids, never names or
 * emails. `blocked_by` and `blocks` come from Jira's directional blocks links and `related` from its other links. A field the
 * connector could not read is named in `unknown`; an absent optional field (no priority, unassigned) is known to be empty.
 */
export interface TicketUploadArgs {
	item: "ticket"; key: string; kind: "bug" | "feature" | "ticket"; type: string; title: string; updated_at: string; state?: "open" | "closed"; status?: string;
	priority?: string; due?: string; assignee?: string; reporter?: string; assignee_is_owner?: boolean; blocked_by: string[]; blocks: string[]; related: string[];
	unknown: string[]; as_of: string; request_id: string;
}
export type UploadArgs = CommitUploadArgs | PRUploadArgs | TicketUploadArgs;

// ---------- Repo facts v2: the shared contract in docs/repo-facts-v2-contract.md. ----------

export const REPO_FACT_DETECTORS = ["command_repair", "unavailable_tool", "env_var", "network", "empty_vcs", "form_repair", "arg_repair", "learned"] as const;
export type FactDetector = (typeof REPO_FACT_DETECTORS)[number];
/** environment: eligible, retired and activated per device, no disjoint-files rule. repo: one shared lane, disjoint edited files. */
export const FACT_CLASSES = ["environment", "repo"] as const;
export type FactClass = (typeof FACT_CLASSES)[number];
export const DETECTOR_CLASS: Readonly<Record<Exclude<FactDetector, "learned">, FactClass>> = Object.freeze({
	command_repair: "environment", unavailable_tool: "environment", env_var: "environment", network: "environment", empty_vcs: "environment",
	form_repair: "environment", arg_repair: "repo",
});
/** form_repair fixes: the failing program run through exactly one of these launchers. */
export const FORM_WRAPPERS = ["python -m", "python3 -m", "npx", "npm exec", "pnpm exec", "pnpm dlx", "yarn", "bunx", "uv run", "poetry run", "bundle exec"] as const;
/** Programs a learned fix may never start with: shells, evaluators, privilege, network and deletion. */
export const FIX_DENY = ["sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", "sudo", "doas", "su", "env", "xargs", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "rm", "dd", "mkfs", "chmod", "chown"] as const;
/** The lane key of a repo-class fact; environment lanes are keyed by device id. */
export const SHARED_LANE = "*";

/**
 * Named so a replay can recalibrate them. The firing-rate gate (exercised, rate_num, rate_den) applies to learned facts only:
 * (fired + prevented) * rate_den >= exercised * rate_num. Deterministic facts inject as soon as their lane is active.
 */
export const REPO_FACT_RULES = Object.freeze({ activate: 3, retire: 1, retire_high_stakes: 1, learned_citations: 2, exercised: 4, rate_num: 2, rate_den: 5, user_tier_repos: 2, repair_window: 5 });
export const REPO_FACT_LIMITS = Object.freeze({
	observations: 32, families: 32, files: 32, injected: 16, citations: 8, proposal_facts: 8, live: 32, dormant: 32, devices: 8, inject: 4,
	confirmations: 12, events: 16, evidence: 20, legacy_seen: 64, literal: 120, learned_literal: 400, signature_set: 3, signature_string: 80,
	fix: 120, fix_tokens: 8, held: 64, receipts: 4000, receipt_days: 120, day_rows_days: 400, flag_reason: 200,
});

const PROG = "[a-z0-9_][a-z0-9_.+-]{0,39}", WORD = "[a-z][a-z0-9_:.-]{0,39}", HEAD = `${PROG}(?: ${WORD}){0,2}`, VAR = "[A-Za-z_][A-Za-z0-9_]{0,63}";
const ARG = "(?:--|--?[A-Za-z][A-Za-z0-9-]{0,31}(?:=[A-Za-z0-9_.:,/@+-]{1,40})?)";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Literal grammars; every literal is also one line, at most REPO_FACT_LIMITS.literal (120) chars, with no backtick, quote or secret. */
export const FACT_LITERAL: Readonly<Record<Exclude<FactDetector, "learned">, RegExp>> = Object.freeze({
	command_repair: new RegExp(`^(?=env -u |${VAR}=… )(?:env(?: -u ${VAR})+ )?(?:${VAR}=… )*${HEAD}$`),
	unavailable_tool: new RegExp(`^(?:import ${VAR}(?:\\.${VAR}){0,7}|${PROG}|${HEAD} needs [A-Za-z0-9_][A-Za-z0-9_.+-]{0,39})$`),
	env_var: new RegExp(`^${HEAD} needs [A-Z][A-Z0-9_]{2,63}$`),
	network: new RegExp(`^(?=.{1,120}$)${LABEL}(?:\\.${LABEL})+$`),
	empty_vcs: new RegExp(`^git(?: ${WORD}){0,2}$`),
	form_repair: new RegExp(`^(${PROG}) => (?:${FORM_WRAPPERS.join("|")}) \\1$`),
	arg_repair: new RegExp(`^${HEAD} (?:with|without) ${ARG}(?: ${ARG}){0,2}$`),
});
/** A learned signature's head. */
export const FACT_HEAD = new RegExp(`^${HEAD}$`);
/**
 * A learned fix: one plain command, program then at most 7 argument tokens, at most 120 chars. The token charset excludes every shell
 * metacharacter (; & | ` $ ( ) < > quotes, globs, newline). Also checked: no `://`, no `user@host:` token, program not in FIX_DENY,
 * and head's program is one of its tokens.
 */
export const FACT_FIX = new RegExp(`^(?=.{2,120}$)${PROG}(?: [A-Za-z0-9_.,:@%+=/-]{1,64}){0,7}$`);
/** One signature string (scope, confirm, contradict): 3 to 80 chars of lowercase printable ASCII without ` " ; | < > or doubled spaces. */
export const FACT_SIGNATURE_STRING = /^(?=.{3,80}$)(?!.* {2})[a-z0-9 !#$%&'()*+,./:=?@[\\\]^_{}~-]+$/;

/** Session order: ended_at (ISO UTC, ms) then the device's per-session counter, shared by every report of that session. */
export interface FactOrder { ended_at: string; seq: number }
/** `<ended_at>/<seq, 10 digits>/<device>`: sorts in session order. */
export const orderKey = (o: FactOrder, device: string) => `${o.ended_at}/${String(o.seq).padStart(10, "0")}/${device}`;
export const LEGACY_ORDER = "1970-01-01T00:00:00.000Z/0000000000/legacy";

/**
 * A learned fact's checkable signature: three bounded sets of lowercase plain substrings, never a regex. A step is in scope when its
 * text holds every `scope` string; a failed in-scope step whose error lines hold any `confirm` string confirms; a proven-ok in-scope
 * step holding any `contradict` string contradicts. head names the operation; fix (FACT_FIX) is optional.
 * Identity is head, scope, confirm, fix and class; a revision may only add to `contradict`.
 */
export interface FactSignature { head: string; scope: string[]; confirm: string[]; contradict: string[]; fix?: string }
/** The canonical learned literal (the identity the fact key hashes): sets sorted, joined with `; `. Excludes contradict. */
export const learnedLiteral = (s: FactSignature, cls: FactClass) =>
	`${s.head} | scope: ${[...s.scope].sort().join("; ")} | confirm: ${[...s.confirm].sort().join("; ")}${s.fix ? ` | fix: ${s.fix}` : ""} | class: ${cls}`;
/** One HEAD's family label: `prog:<head>` for one word, else `head:<head>`. Family hash: sha256(repo_key + "\n" + label)[0:16]. */
export const headLabel = (head: string) => (head.includes(" ") ? `head:${head}` : `prog:${head}`);

/** One observation. No statement: the server derives it. class, signature and citations only on proposals of `learned`. */
export interface FactReportObservation {
	fact_key: string; kind: "confirm" | "contradict" | "propose"; detector: FactDetector; literal: string;
	signature?: FactSignature; class?: FactClass; citations?: string[];
	/** Retire on REPO_FACT_RULES.retire_high_stakes contradictions. A revision may set it, never clear it. */
	high_stakes?: boolean;
}
/**
 * One item injected at this session's start and what happened to it: fired (its failure recurred), prevented (exercised, no failure),
 * unexercised. `memory` items come from the session briefing; the facts lifecycle ignores them and the receipt keeps them.
 */
export type FactInjected = { kind: "fact"; fact_key: string; outcome: "fired" | "prevented" | "unexercised" }
	| { kind: "memory"; memory_id: string; outcome: "fired" | "prevented" | "unexercised" };
/** Cache-aware token use. input includes cached_input and cache_write. */
export interface FactUsage { input: number; cached_input: number; output: number; cache_write?: number }
export interface FactCommandCounts { total: number; failed: number; repeated_failures: number }
/**
 * Every fact route's location. remote is the raw origin URL (SSH aliases kept) and path the checkout toplevel: both route through
 * routeWrite. repo_key is the canonical github.com/<owner>/<repo> the client resolved; the server checks it against the remote.
 */
export interface FactRoute { repo: { remote: string; path?: string }; repo_key: string; profile?: string }

/**
 * device: the authenticated token's device. machine: the client's stable machine id (32 lowercase hex, random, generated once per
 * machine), which keys environment lanes. A v2 request without it reaches no environment lane; only v1 legacy reports use the device.
 */
interface FactReportBase { repo_key: string; device: string; machine?: string; request_id: string; observations: FactReportObservation[] }
/**
 * A completed session's report. attribution `legacy` marks a v1 report the Worker mapped in: order from receipt time, no files, no
 * injected, and per-command repo attribution unknown. files absent = unknown (overlaps every set).
 */
export interface FactSessionReport extends FactReportBase {
	type: "session"; session: string; order: FactOrder; attribution: "command" | "legacy";
	families: string[]; files?: string[]; injected: FactInjected[]; usage?: FactUsage; commands?: FactCommandCounts;
}
/** A synthesis proposal: propose observations only. The proposal id is the idempotency key. */
export interface FactProposalReport extends FactReportBase { type: "proposal"; proposal: string; /** legacy: a v1 proposal the Worker mapped in. */ attribution?: "legacy" }
/** The validated report the Worker hands the store (`op: "fact"` in phase B). The receipt stores it whole. */
export type FactReport = FactSessionReport | FactProposalReport;

export type FactLaneState = "candidate" | "active" | "retired";
export interface FactConfirmation { session: string; device: string; order: string; files: string[] | null }
export interface FactEvent { order: string; session: string; kind: "confirm" | "contradict" | "flag" }
/**
 * One lane. state is recomputed from the ordered history after every accepted report unless retired_reason is `flagged` (terminal).
 * activated is the order key at which the activation rule first held (sticky). updated_at drives oldest-updated eviction.
 */
export interface FactLane {
	state: FactLaneState; confirmations: FactConfirmation[]; events: FactEvent[]; activated?: string;
	exercised: number; fired: number; prevented: number; retired_reason?: "contradicted" | "flagged"; updated_at: string;
}
/** attrs.fact, v2. lanes: SHARED_LANE for repo class, device ids for environment class. label: the family label (section 4). */
export interface FactRecord {
	v: 2; repo_key: string; fact_key: string; detector: FactDetector; literal: string; signature?: FactSignature;
	class: FactClass; label: string; family: string; lanes: Record<string, FactLane>; high_stakes?: boolean;
	/** The owner's reason, set by a flag (redacted, at most 200 characters). */
	flag_reason?: string;
	/** v1 sessions this fact already counted; a later report for one of them skips this fact only. */
	legacy_seen?: string[];
}

/** The injectable-facts read (src/profile/facts.ts `injectableFacts`), shared by POST /v1/facts and POST /v1/brief. device: the lane id (machine, else token device). */
export interface FactInjectQuery { profile: string; repo_key: string; device: string }
/** One injectable fact. line is the template-rendered bullet; renderFactBlock wraps lines in the fixed boundary. */
export interface FactInjection {
	fact_key: string; detector: FactDetector; class: FactClass; tier: "repo" | "user"; literal: string; signature?: FactSignature;
	statement: string; line: string; exercised: number; fired: number; prevented: number;
}
/** The owner's flag: retire now, terminal, undoable through its activity. scope user retires the key in every repo of the profile. */
export interface FactFlagArgs { memory_id?: string; repo_key?: string; fact_key?: string; scope: "repo" | "user"; reason: string; request_id: string }
export interface FactListItem {
	memory_id: string; repo_key: string; fact_key: string; detector: FactDetector; class: FactClass; literal: string; signature?: FactSignature;
	statement: string; state: FactLaneState; user_tier: boolean; pinned: boolean; high_stakes: boolean; dormant: boolean; revision: number; flag_reason?: string;
	lanes: { lane: string; state: FactLaneState; exercised: number; fired: number; prevented: number; rate: number | null; eligible: boolean; confirmations: number; last_event: FactEvent | null; updated_at: string }[];
	evidence: { kind: string; ref: string; note: string | null }[]; created_at: string; updated_at: string;
}
/** Per repo per UTC day (of ended_at), summed from stored session receipts. usage_sessions counts sessions that carried usage. */
export interface FactEfficiencyRow {
	repo_key: string; day: string; sessions: number; usage_sessions: number; input: number; cached_input: number; output: number; cache_write: number;
	commands: number; failed: number; repeated_failures: number; injected: number; prevented: number; fired: number;
}

export type WriteCommand = { op: "save"; args: SaveArgs } | { op: "append"; args: AppendArgs } | { op: "capture"; args: CaptureArgs } | { op: "candidate"; args: CandidateArgs } | { op: "knowledge"; args: KnowledgeArgs } | { op: "undo"; args: { activity_id: number; request_id: string } }
	| { op: "owner"; args: OwnerArgs } | { op: "upload"; args: UploadArgs } | { op: "restore"; args: { activity_id: number; request_id: string } } | { op: "fact"; args: FactReport } | { op: "fact_flag"; args: FactFlagArgs };
/** The owner's dashboard actions on one node (section 15). */
export interface OwnerArgs { action: "pin" | "unpin" | "forget" | "unflag"; memory_id: string; request_id?: string }

export interface WriteContext {
	actor: "agent" | "owner" | "keep" | "index" | "maintenance";
	deviceId?: string;
	platform: string;
	routedBy: string;
	/** BothQ-style request hash over the redacted arguments, computed by the Worker and bound in AccountStore. */
	payloadHash: string;
	/** BothQ's hash of the same call (domain/legacy.ts), compared instead when the request id was imported from BothQ. */
	legacyHash?: string;
	userId: string;
	/** A daily refresh item: its write and any replay happen only while this claim is open at this part (daily-proof.ts). */
	refresh?: { claim_id: string; part: number; device_id: string };
	/** Required on every write to `me`: whether the caller named `me` itself. Checked after a committed replay, before any change. */
	meGuard?: { explicit: boolean };
}

export interface Identity { memory_id?: string; name?: string; scope?: string; type?: MemoryType }

export type ReadQuery =
	| { kind: "get"; target: Identity; includeRetired: boolean; history?: { limit: number; beforeRevision?: number }; content?: { complete: boolean; cursor?: string }; asOf?: string }
	| { kind: "recall"; keyword: string; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; limit: number; includeHistory: boolean; includeCaptures?: boolean; semantic: boolean; deadline: number; expand: boolean; asOf?: string }
	| { kind: "inventory"; after: number; limit: number; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; includeHistory: boolean; includeCaptures?: boolean; asOf?: string }
	| { kind: "has"; id: string }
	| { kind: "candidates"; status: "pending" | "promoted" | "dismissed" | "all"; limit: number; asOf?: string }
	| { kind: "import_audit"; after: string | null; limit: number; record?: string; rows?: "revisions" | "requests" | "texts" }
	| { kind: "batch_status" }
	| { kind: "owner_model"; after: string | null; limit: number; kinds?: ("preference" | "rule")[] }
	| ExploreQuery | TraceQuery | TimelineQuery | BoardQuery
	// The owner's page reads (section 15); src/profile/pages.ts takes the same shapes.
	| { kind: "entity"; node: { id: string } | { key: string }; asOf?: string; before?: number; content?: { cursor?: string }; known: string[] }
	| { kind: "journals"; after: string | null; limit: number }
	| { kind: "journal"; id: string; after: number; limit: number }
	| { kind: "map"; center?: { id: string } | { key: string }; depth: number; asOf?: string; known: string[] }
	| { kind: "page_timeline"; from: string; to: string; node?: { id: string } | { key: string }; kinds?: NodeKind[]; limit: number; known: string[] }
	| { kind: "activity"; before: number | null; limit: number; actor?: string }
	| { kind: "shown"; ids: string[] }
	| { kind: "graph"; part: "nodes" | "edges"; after: string | null; limit: number }
	| { kind: "archive"; before: number | null; limit: number }
	// GET /v1/markers (section 7): `repo` is the GitHub namespace, or null for another remote.
	| { kind: "markers"; repo: string | null; session?: { client: "claude-code" | "codex"; id: string } }
	| { kind: "wipe_preview"; profile: string; terms: string[]; part: "purge" | "handwritten"; after: string };

// Graph reads (section 7), defined here so domain/ imports nothing from a store; src/profile/graph.ts takes the same shapes.
type GraphRef = { id: string } | { key: string } | { name: string; kind?: NodeKind; scope?: string };
export interface ExploreQuery { kind: "explore"; node: GraphRef; depth: number; rels?: (typeof RELATIONS)[number][]; asOf?: string; known: string[]; maxEdges: number }
export type TraceQuery = { kind: "trace"; known: string[]; maxEdges: number; asOf?: string } & (
	| { mode: "why"; from: GraphRef; maxDepth: number }
	| { mode: "step"; ids: string[]; similarity: boolean }
	| { mode: "detail"; nodes: string[]; edges: number[] });
export interface TimelineQuery { kind: "timeline"; from: string; to: string; node?: GraphRef; kinds?: NodeKind[]; limit: number; known: string[] }
/** work_board (section 13); src/profile/board.ts takes the same shape. The Worker supplies asOf. */
export interface BoardQuery { kind: "board"; asOf: string; limit: number; known: string[]; state?: "open" | "closed" | "all" }

/** With as_of, the record's stored state then: a field its history does not hold is null, never the current value. */
export interface RecallHit {
	import_source?: {name:string;content_hash:string;revision:number}; classification?: "archival_reference"; trust?: "untrusted"; instruction_authority?: false;
	memory_id: string; profile: string; kind: string; type: string | null; name: string | null; scope: string | null; origin: string;
	status: string | null; revision: number; passage: string; matched_by: string[]; score: number;
	objective: string | null; step_count: number;
	provenance: { source_platform: string | null; updated_source_platform: string | null; source_hash: string | null; hosted_view_hash?: string };
	freshness: { created_at: string | null; updated_at: string | null; valid_from: string | null; valid_until: string | null };
	/** Set with as_of: when the revision in effect was recorded, whether the record was valid then, and whether its content was rebuilt. */
	as_of?: { recorded_at: string; valid: boolean; content_known: boolean; current?: string[] };
	/** Row position, used by the inventory cursor. */
	row: number;
	/** Set only on a non-inferred preference a profile returns from below its recall cap: its true position there. */
	rank?: number;
	/** Set when the graph channel found it: the strongest link from a seed. */
	via?: { from: string; rel: string; basis: string; reason: string | null };
}

export interface RecallPage { hits: RecallHit[]; diagnostics: Record<string, string>; vectorUsed: boolean }
