# Candidate B: stateless Worker over one D1 per profile

Runner B, architect Phase B, 2026-10-28. Premise: a stateless Worker owns all domain logic. Storage is one D1 database per (user, profile) plus one control-plane D1. Asynchronous work runs on Cron Triggers and Workflows. All LLM work runs on Workers AI under a hard budget guard (owner correction of 16:50 IST). No local worker, no job queue.

## Problem

Agent Memory replaces BothQ (Neo4j, stdio MCP, one trusted machine) with one hosted MCP server that several machines and three agent clients call at once. The BothQ write contracts assume interactive transactions with record locks: read the record, check `expected_revision`, write the revision, record the request, commit. D1 has no interactive transactions. It has auto-commit statements and `batch()`, which runs a list of statements as one SQL transaction and rolls the whole list back if any statement fails ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), read 2026-10-28). A batch counts as one query against the 50-queries-per-invocation Free limit ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), read 2026-10-28).

The data shape makes this harder. 94.5% of content is 706 rolling journals, the largest 987k characters with 664 revisions, and almost every write is an append. BothQ stores a journal as one growing text property, so each append rewrites the whole document. On D1 that shape fails outright: a row is capped at 2 MB, a statement at 100 KB, and an FTS5 index re-tokenizes the whole document on every update, which multiplies rows written against the 100k/day Free cap.

Constraints carried from Phase A that this design honors:

- BothQ ids: `uuid5(71dc20da-6406-5a6d-a888-8c0ae4cda566, "scope:type:normalized-name")`, assigned once and kept through renames and moves (`memory_config.py`).
- Request idempotency by payload hash over the redacted arguments, minus `request_id` (`memory_store.py:_prepare`).
- Append revisions store deltas. Save, update, retire, and supersede store full snapshots.
- Recall: exact-name and literal boosts, full-text, optional vectors, RRF with k=60, 200 candidates per channel, 700-character passages, token cost estimated as JSON length divided by 4 (`memory_search.py`).
- Redaction before persistence (`memory_privacy.py`), ported unchanged.
- Captures never appear in ordinary recall.
- D1 Free: 10 databases, 500 MB each, 5M rows read and 100k rows written per day, queries fail once the daily cap is hit (enforced since 2026-09-01, [D1 changelog](https://developers.cloudflare.com/changelog/product/d1/)). Index entries and virtual-table writes count as rows written.
- Workers Free: 10 ms CPU per invocation, 50 external subrequests and 1,000 Cloudflare-service subrequests per invocation ([changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)).
- Workflows on Free: included, 10 ms CPU per step, 1,024 steps per instance, 3,000 steps per day, 3-day retention ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [step billing changelog](https://developers.cloudflare.com/changelog/product-group/developer-platform/8/), read 2026-10-28).

## Usage (caller's view)

### Agent tool calls

Every write carries `context` so the server can route it. The agent never names a database.

Save a rule the owner just stated:

```json
{
  "method": "tools/call",
  "params": {
    "name": "save_memory",
    "arguments": {
      "type": "feedback",
      "name": "Use pnpm, never npm, in Sequoia repos",
      "description": "Package manager rule for Sequoia frontend repos",
      "body": "Run pnpm install and pnpm -w build. npm breaks the workspace lockfile.",
      "why": "Owner correction on 2026-10-28 after npm rewrote pnpm-lock.yaml.",
      "how_to_apply": "Before any install or script run in a Sequoia-Engineering repo.",
      "scope": "sequoia/web",
      "links": [{ "rel": "applies_to", "entity": { "kind": "repo", "key": "github:Sequoia-Engineering/web" } }],
      "request_id": "cc-7f3a-save-pnpm-rule",
      "context": { "git_remote": "git@github.com:Sequoia-Engineering/web.git", "cwd": "/Users/p/Projects/web", "client": "claude-code/2.4.1" }
    }
  }
}
```

```json
{
  "action": "created",
  "profile": "work",
  "routed_by": "rule:git_remote:github.com/Sequoia-Engineering/*",
  "memory_id": "5b0d4e52-3f7e-5c55-9a0e-6d1f0e2b9c11",
  "revision": 1,
  "origin": "stated"
}
```

Append to a journal from a second machine at the same moment as the first. No `expected_revision`, so the server retries a lost race itself:

```json
{
  "name": "append_memory",
  "arguments": {
    "name": "codex: BetterGit sync rewrite journal",
    "type": "project",
    "scope": "bettergit",
    "content": "2026-10-28 16:58 IST. Moved conflict detection into the merge step. Tests green.",
    "request_id": "codex-mbp2-0193-append-17",
    "context": { "git_remote": "git@github.com:wrick17/bettergit.git", "cwd": "/Users/p/Projects/bettergit", "client": "codex/0.98" }
  }
}
```

```json
{ "action": "appended", "profile": "personal", "memory_id": "c1e9...", "revision": 666, "entry_seq": 665, "retried": 1 }
```

Repeating the same call returns the same body with `"action": "replayed"`. Reusing the id with different content returns `{"error": "idempotency_mismatch"}`.

Profile-aware recall. The server routes the read the same way as a write, then searches that profile and `me`:

```json
{
  "name": "recall_memories",
  "arguments": {
    "query": "pnpm workspace lockfile",
    "types": ["feedback", "procedural", "user"],
    "token_budget": 2000,
    "context": { "git_remote": "git@github.com:Sequoia-Engineering/web.git", "cwd": "/Users/p/Projects/web" }
  }
}
```

```json
{
  "profile": "work",
  "searched": ["work", "me"],
  "results": [
    { "memory_id": "5b0d...", "profile": "work", "type": "feedback", "name": "Use pnpm, never npm, in Sequoia repos",
      "origin": "stated", "revision": 1, "passage": "Run pnpm install and pnpm -w build. npm breaks the workspace lockfile.",
      "score": 0.0325, "updated_at": "2026-10-28T11:20:04Z", "channels": ["exact", "fts", "vector"] },
    { "memory_id": "88a2...", "profile": "me", "type": "user", "name": "Prefers lockfile-preserving installs",
      "origin": "inferred", "evidence_count": 3, "passage": "...", "score": 0.0151 }
  ],
  "estimated_tokens": 412,
  "truncated": false
}
```

### End-of-session digest hook

One POSIX script serves Claude Code (`SessionEnd`) and Codex (`notify`). It posts to a plain HTTPS endpoint with a device token that has only the `capture` scope. It sends no transcript and no tool output.

```sh
#!/bin/sh
# ~/.agent-memory/digest.sh <client>; hook JSON arrives on stdin
set -eu
event=$(cat)
cwd=$(printf '%s' "$event" | jq -r '.cwd // empty')
remote=$(git -C "${cwd:-.}" remote get-url origin 2>/dev/null || true)
body=$(printf '%s' "$event" | jq -c --arg client "$1" --arg remote "$remote" '{
  request_id: ("digest:" + .session_id),
  kind: "digest",
  body: (.digest // .last_assistant_message // ""),
  source: { client: $client, session_id: .session_id, cwd: .cwd, git_remote: $remote,
            branch: (.branch // ""), ended_at: (now | todate) } }')
spool="$HOME/.agent-memory/spool.ndjson"
post() { curl -fsS --max-time 10 https://memory.wrick17.com/v1/capture \
  -H "Authorization: Bearer $AGENT_MEMORY_CAPTURE_TOKEN" -H 'content-type: application/json' --data "$1"; }
# Replay earlier failures first; request_id makes replays idempotent.
if [ -s "$spool" ]; then mv "$spool" "$spool.replay"; while read -r l; do post "$l" >/dev/null || echo "$l" >> "$spool"; done < "$spool.replay"; rm -f "$spool.replay"; fi
post "$body" >/dev/null || echo "$body" >> "$spool"
```

Response: `{"capture_id": "...", "profile": "work", "status": "pending", "action": "created"}`.

### Dashboard API

The dashboard is a static SPA served by Workers Static Assets. It calls `/api/*` with the Clerk session cookie.

```ts
const overview = await fetch("/api/overview", { credentials: "include" }).then((r) => r.json());
// { profiles: [{ slug: "work", active: 412, journals: 240, pendingCaptures: 12, lastActivityAt: "..." }],
//   ai: { day: "2026-10-28", usedNeurons: 812, capNeurons: 9000 }, flags: 3 }

const page = await fetch("/api/profiles/work/activity?limit=50", { credentials: "include" }).then((r) => r.json());

await fetch(`/api/profiles/work/activity/${page.items[0].id}/undo`, {
	method: "POST",
	credentials: "include",
	headers: { "x-request-id": crypto.randomUUID() },
});
// { undone: "act_01J...", restored: [{ memory_id: "...", revision: 14 }] }
```

## Shape

### Load-bearing decisions

1. **Isolation is a binding, not a filter.** Each profile is its own D1 database bound as `DB_<SLUG>`. Only `profiles.ts` reads `env.DB_*`. Domain code receives a branded `ProfileDb` handle and has no way to name another database. The read rule is fixed in code: a profile reads itself plus `me`. `work` cannot read `personal` because no code path produces a `ReadSet` holding both. Per `encode invariants in types`.
2. **Every write is one read plus one atomic batch, and the revision primary key is the compare-and-swap.** The Worker reads the head row and the request row, computes the next revision, and sends a batch whose statements insert the request row, insert `revisions(memory_id, revision)`, and update the head. If another writer committed that revision first, the primary key fails, D1 rolls the batch back, and the Worker re-reads. The request row commits in the same batch as the change, so the BothQ state `idempotency_incomplete` cannot occur.
3. **Journals are append-only entry rows.** An append inserts one `entries` row and indexes only that row. Write cost per append is constant, independent of journal size. A journal's `body` holds its compacted summary.
4. **Automation has one door.** Learning and cleanup change data only through `applySystemChange` in the memory store. That function turns any change to a protected record (owner-stated rules and preferences, everything in `me`) into a flag, and writes the change, its archive rows, and its activity row with the undo payload in one batch.
5. **Vectors live in SQLite at card level.** One 256-dimension int8 vector per memory card (name, description, first 2,000 body characters, or the journal summary). Brute-force cosine over about 1,100 cards per profile costs well under 1 ms of CPU. Vectorize stays out of v1 and becomes the switch at about 20,000 cards in one profile. This removes the unresolved Vectorize-on-Free question from the critical path.

### Data structures first

The per-profile schema has eight live tables plus a generic archive. The control plane has six tables. Section "Per-profile SQLite DDL" lists them.

Trace of the dominant access patterns:

| Pattern | Path through the structure | Cost |
|---|---|---|
| Append to a 987k-char journal | Read `memories` head and `requests` (1 batch). Batch: insert request, insert revision `(id, n+1)` with `entry_from/entry_to`, insert entry, update head `revision, entry_count, updated_at`. Triggers index only the new entry. | 2 queries, about 11 rows written |
| Two machines append at once | Both read revision n. D1 runs batches one at a time per database. The first commits n+1. The second fails on `revisions` primary key and rolls back. Without `expected_revision` the Worker re-reads and retries (at most 3 tries). With it, it returns `revision_conflict`. | 2 more queries for the loser |
| Retry of a committed request | Request row exists with the same hash. Return stored `result_json` with `action: replayed`. | 1 query |
| Recall with a token budget | One batch per database in the `ReadSet` (own and `me`, in parallel). Each batch runs exact name, literal `instr()` over cards, `memories_fts`, `entries_fts`, and loads card vectors. RRF fuses all lists from both databases at once. Second batch hydrates the top results. Passages come from the winning field or entry. | 4 queries, about 3k rows read |
| Cross-profile `me` read | Same recall batch on `DB_ME`. Merge happens in the Worker. No join across databases exists. | Included above |
| Nightly cleanup | Workflow step per (profile, task). Each step reads a bounded set, makes at most one Workers AI call, and calls `applySystemChange` once. | About 5 to 10k rows written per night |
| Dashboard overview | One `GROUP BY type, status, kind` per profile plus counts of pending captures and unundone activity. | About 1.5k rows read per profile |

No row in any pattern grows with journal length, and no write path rewrites the whole journal.

### Data flow

```
client -> index.ts -> auth.ts (Principal)
                   -> mcp.ts (validate input, parse into domain types)
                        -> routing.ts (profile decision, from control D1)
                        -> profiles.ts (ProfileDb or ReadSet)
                        -> memory/store.ts | memory/search.ts | capture.ts | graph.ts
cron  -> index.ts scheduled() -> tick (embeddings, capture classification, moves)
                              -> NightlyRun / WeeklyReview Workflows -> learn/*.ts -> memory/store.ts applySystemChange
```

A tool call crosses at most three files with domain logic: `mcp.ts` (shell), one domain module, and `profiles.ts`. `routing.ts` and `auth.ts` resolve values before the call and return plain data.

### Interface depth

The public interface is 12 MCP tools (13 with corpus), one capture endpoint, and the dashboard REST API. Behind it the design hides the batch protocol, retry on lost races, request replay, redaction, routing, cross-database fusion, FTS and vector channels, passage extraction, budget accounting, and archive mechanics. A caller learns one rule: pass `request_id` and `context` on writes. Tools merge BothQ operations where the input shape is the same (`save_memory` covers create and update; `get_memory` covers history; `review_candidates` covers list, promote, and dismiss). Wire types stay in `mcp.ts` and `api.ts`, which parse into domain types (per `parse at the boundary`).

### What the design deliberately does not do

- No Durable Objects, no Queues, no KV beyond what `workers-oauth-provider` needs if that auth topology wins.
- No background local process. Local Codex runs once, by hand, for the migration distillation.
- No LLM call on the write path. Writes do regex redaction and set `embed_state = 'dirty'`.
- No `last_recalled_at` writes on reads. Reads never write.
- No BothQ ticket guard (`force_unresolved_tickets`). The HQ ticket registry retires with the bot fleet.
- No raw transcript storage.

## Type sketch

```ts
// src/types.ts: domain types shared by modules. No D1 or MCP types here.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ProfileSlug = Brand<string, "ProfileSlug">; // "me" | "work" | "personal" | later additions
export type UserId = Brand<string, "UserId">; // Clerk user id
export type DeviceId = Brand<string, "DeviceId">;
export type MemoryId = Brand<string, "MemoryId">; // UUID5, assigned once, never recomputed
export type RequestId = Brand<string, "RequestId">;
export type ActivityId = Brand<string, "ActivityId">;
export type IsoTime = Brand<string, "IsoTime">;

export const ME = "me" as ProfileSlug;

export type MemoryType = "feedback" | "project" | "reference" | "procedural" | "user";
export type MemoryKind = "note" | "journal";
export type MemoryStatus = "active" | "retired" | "superseded" | "merged";
/** stated: explicit agent or dashboard write. inferred: learning pipeline. imported: migration. */
export type Origin = "stated" | "inferred" | "imported";

export interface Step {
	order: number; // positive, unique within the memory
	action: string;
	successCriteria: string;
}

/** Fields shared by every memory. Procedural fields are carried by the union below. */
interface MemoryBase {
	id: MemoryId;
	profile: ProfileSlug;
	userId: UserId;
	scope: string; // organizational label inside a profile, BothQ scope rules
	name: string;
	description: string;
	body: string; // note text, or the compacted summary for a journal
	why?: string;
	howToApply?: string;
	status: MemoryStatus;
	origin: Origin;
	pinned: boolean; // owner pinned in dashboard; automation never changes pinned records
	seeded: boolean; // system-seeded routine; protected from update, retire, supersede
	flags: Flag[]; // automation findings on protected records
	revision: number; // starts at 1, +1 per change, never reused
	contentHash: string;
	validFrom: IsoTime;
	validUntil?: IsoTime;
	createdAt: IsoTime;
	updatedAt: IsoTime;
}

/** Invariant: procedural memories have an objective and ordered steps, and are never journals. */
export type Memory =
	| (MemoryBase & { type: "procedural"; kind: "note"; objective: string; steps: Step[] })
	| (MemoryBase & { type: Exclude<MemoryType, "procedural">; kind: MemoryKind });

export type Journal = Extract<Memory, { kind: "journal" }> & {
	entryCount: number;
	compactedThrough: number; // entries with seq <= this are summarized into body and archived
};

/** One journal entry. Immutable once written. */
export interface Entry {
	memoryId: MemoryId;
	seq: number; // 1..n, gapless per journal
	body: string; // at most ENTRY_MAX_BYTES; longer appends split into several entries
	createdAt: IsoTime;
	actor: Actor;
	requestId?: RequestId;
}

export type RevisionOp = "saved" | "updated" | "appended" | "retired" | "superseded" | "merged" | "restored" | "compacted" | "moved";

/** Full snapshot for every op except "appended", which points at entries. */
export type Revision =
	| { memoryId: MemoryId; revision: number; op: Exclude<RevisionOp, "appended">; snapshot: MemorySnapshot; at: IsoTime; actor: Actor; requestId?: RequestId; activityId?: ActivityId }
	| { memoryId: MemoryId; revision: number; op: "appended"; entryFrom: number; entryTo: number; at: IsoTime; actor: Actor; requestId?: RequestId };

export type MemorySnapshot = Omit<Memory, "profile" | "userId">; // journals: excludes entries

/** Stored once per request_id. Same id plus different payloadHash is idempotency_mismatch. */
export interface RequestRecord {
	requestId: RequestId;
	op: "save" | "append" | "retire" | "capture" | "promote" | "dismiss" | "undo" | "import";
	payloadHash: string; // sha256 of redacted args without request_id, plus resolved profile
	memoryId?: MemoryId;
	result: unknown;
	createdAt: IsoTime;
}

export type EntityKind = "repo" | "project" | "person" | "tool" | "ticket" | "org" | "pr";
export interface Entity {
	id: string; // `${kind}:${key}`
	kind: EntityKind;
	key: string; // "github:Sequoia-Engineering/web", "jira:SEQ-1234"
	name: string;
	attrs: Record<string, string | number | boolean | null>;
	origin: Origin | "synced";
}

export type NodeRef = { type: "memory"; id: MemoryId } | { type: "entity"; id: string } | { type: "capture"; id: string };
/** Lives in the source node's profile. dstProfile is the source profile or "me", never a sibling. */
export interface Edge {
	src: NodeRef;
	rel: "applies_to" | "about" | "evidence_for" | "supersedes" | "merged_into" | "mentions" | "works_on" | "depends_on";
	dstProfile: ProfileSlug;
	dst: NodeRef;
	origin: Origin | "synced";
	createdAt: IsoTime;
}

export interface Capture {
	id: string;
	kind: "digest" | "observation";
	body: string; // redacted
	source: { client: string; sessionId?: string; cwd?: string; gitRemote?: string; branch?: string; endedAt?: IsoTime };
	status: "pending" | "promoted" | "dismissed" | "expired";
	promotedTo?: MemoryId[];
	dismissReason?: string;
	receivedAt: IsoTime;
	lastTouchedAt: IsoTime;
	expiresAt: IsoTime; // receivedAt + 60 days, extended by promotion (then null in storage)
}

export type Actor =
	| { kind: "agent"; userId: UserId; deviceId?: DeviceId; client: string }
	| { kind: "owner"; userId: UserId; via: "dashboard" }
	| { kind: "system"; job: SystemJob; runId: string };

export type SystemJob = "tick.embed" | "tick.classify" | "nightly.extract" | "nightly.compact" | "nightly.dedupe" | "nightly.link" | "nightly.expire" | "nightly.purge" | "nightly.backup" | "weekly.review" | "sync.github" | "sync.jira" | "move";

export interface Flag { code: "possible_duplicate" | "possible_contradiction" | "stale" | "compaction_candidate"; detail: string; activityId: ActivityId; at: IsoTime }

/** Every automated or dashboard change. Undo replays `undo` as new forward revisions. */
export interface Activity {
	id: ActivityId;
	at: IsoTime;
	actor: Actor;
	op: SystemChange["op"] | "owner_edit" | "undo";
	summary: string; // one plain sentence for the dashboard
	targets: NodeRef[];
	undo: UndoStep[];
	undoneAt?: IsoTime;
	undoneBy?: ActivityId;
}

export type UndoStep =
	| { do: "restore_revision"; memoryId: MemoryId; toRevision: number }
	| { do: "unarchive"; archiveIds: string[] }
	| { do: "delete_edges"; edges: Edge[] }
	| { do: "delete_memory"; memoryId: MemoryId } // undo of an inferred memory the pipeline created
	| { do: "unflag"; memoryId: MemoryId; activityId: ActivityId };

export interface RoutingRule {
	id: string;
	userId: UserId;
	priority: number; // lower runs first
	match: { kind: "git_remote"; pattern: string } | { kind: "path_prefix"; pattern: string };
	profile: ProfileSlug;
}

export type TokenScope = "memory:read" | "memory:write" | "capture" | "import";
export interface Device {
	id: DeviceId;
	userId: UserId;
	name: string; // "work-mbp", "vps"
	defaultProfile: ProfileSlug;
	allowedProfiles: ProfileSlug[]; // must include defaultProfile; "me" is always readable
	scopes: TokenScope[];
	createdAt: IsoTime;
	lastSeenAt?: IsoTime;
	revokedAt?: IsoTime;
}

export interface Profile { userId: UserId; slug: ProfileSlug; binding: `DB_${Uppercase<string>}`; label: string }
```

```ts
// src/profiles.ts: the only module that touches env.DB_*. Owns the isolation rule.

declare const profileDbBrand: unique symbol;
/** A handle to exactly one profile database. Constructed only here. */
export interface ProfileDb {
	readonly profile: ProfileSlug;
	readonly userId: UserId;
	readonly d1: D1Database;
	readonly [profileDbBrand]: true;
}
/** own plus "me". For profile "me", `me` is undefined. Never holds two non-me profiles. */
export interface ReadSet { readonly own: ProfileDb; readonly me?: ProfileDb }

export interface Principal {
	userId: UserId;
	via: "oauth" | "device" | "dashboard";
	deviceId?: DeviceId;
	scopes: TokenScope[];
	allowedProfiles: ProfileSlug[]; // oauth and dashboard: all registered profiles
	defaultProfile?: ProfileSlug;
}

/** Throws profile_forbidden when the principal may not write this profile, profile_unavailable when the binding is missing. */
export function openForWrite(env: Env, p: Principal, slug: ProfileSlug): Promise<ProfileDb> {
	throw new Error("not implemented");
}
/** Fixed rule: [slug, "me"]. No configuration can widen it. */
export function openForRead(env: Env, p: Principal, slug: ProfileSlug): Promise<ReadSet> {
	throw new Error("not implemented");
}
/** For cron and Workflows: every registered profile of every user, one handle each. */
export function allProfiles(env: Env): Promise<ProfileDb[]> {
	throw new Error("not implemented");
}
```

```ts
// src/routing.ts: owns the profile decision for writes and reads.

export interface WriteContext { gitRemote?: string; cwd?: string; client?: string }
export interface RouteDecision { profile: ProfileSlug; routedBy: `override` | `rule:${string}` | `device_default` | `oauth_default` }

/**
 * Order: explicit override, then rules by priority (git_remote before path_prefix at equal
 * priority), then device default, then the user's configured OAuth default.
 * The decision is pure given (rules, principal, ctx). Rules load from control D1 once per request.
 * Throws profile_forbidden when the winner is not in principal.allowedProfiles.
 */
export function route(rules: RoutingRule[], p: Principal, ctx: WriteContext, override?: ProfileSlug): RouteDecision {
	throw new Error("not implemented");
}
/** Normalizes git@github.com:Org/repo.git and https forms to "github.com/Org/repo". */
export function normalizeRemote(remote: string): string {
	throw new Error("not implemented");
}
```

```ts
// src/memory/index.ts: the only importable entry of src/memory/*. Lint bans deep imports.

export interface SaveInput {
	memoryId?: MemoryId; // present: update this memory (partial fields keep current values)
	type: MemoryType;
	name: string;
	newName?: string; // rename, id unchanged
	scope?: string; // destination scope on update
	description?: string;
	body?: string; // at most NOTE_MAX_BYTES
	why?: string;
	howToApply?: string;
	objective?: string;
	steps?: Step[];
	kind?: MemoryKind; // default "note"; "journal" makes append the write path
	supersedes?: MemoryId[];
	links?: { rel: Edge["rel"]; entity: Pick<Entity, "kind" | "key"> & { name?: string } }[];
	expectedRevision?: number;
	requestId?: RequestId;
}
export interface AppendInput { ref: MemoryRef; content: string; separator?: string; expectedRevision?: number; requestId: RequestId }
export interface RetireInput { ref: MemoryRef; reason?: string; expectedRevision?: number; requestId?: RequestId }
export type MemoryRef = { memoryId: MemoryId } | { name: string; type?: MemoryType; scope?: string };

export interface WriteResult {
	action: "created" | "updated" | "appended" | "retired" | "replayed";
	memoryId: MemoryId;
	revision: number;
	entrySeq?: number;
	superseded?: MemoryId[];
	retried?: number;
}

export type MemoryError =
	| { code: "idempotency_mismatch"; requestId: RequestId }
	| { code: "revision_conflict"; expected: number; actual: number }
	| { code: "already_exists"; memoryId: MemoryId }
	| { code: "not_found" | "ambiguous" | "seeded_routine" | "append_not_supported" | "missing_objective" | "invalid_steps" | "too_large" | "self_supersedes"; detail: string };

/**
 * Create or update. Invariants:
 * - One read batch, then one write batch. The write batch inserts revisions(id, rev+1) for the
 *   target and for every superseded id, so a concurrent change to any of them aborts the batch.
 * - On abort the store re-reads and classifies by state, not by error text: request present
 *   (replay or mismatch), revision moved (conflict or retry), active identity taken (already_exists).
 * - A lost race is retried only for appends without expectedRevision; saves return revision_conflict.
 * - Redaction runs before hashing, so replays of a secret-bearing payload still match.
 */
export function save(db: ProfileDb, input: SaveInput, actor: Actor): Promise<WriteResult> {
	throw new Error("not implemented");
}
/** O(1) rows regardless of journal length. Splits content above ENTRY_MAX_BYTES into consecutive entries in one batch. */
export function append(db: ProfileDb, input: AppendInput, actor: Actor): Promise<WriteResult> {
	throw new Error("not implemented");
}
export function retire(db: ProfileDb, input: RetireInput, actor: Actor): Promise<WriteResult> {
	throw new Error("not implemented");
}

export interface GetOptions {
	history?: { beforeRevision?: number; limit: number }; // newest window, returned in chronological order
	entries?: { beforeSeq?: number; limit: number; tokenBudget?: number }; // journals: newest entries first page
}
export interface MemoryView { memory: Memory; edges: Edge[]; history?: { revisions: Revision[]; nextBeforeRevision?: number }; entries?: { items: Entry[]; nextBeforeSeq?: number } }
/** Reads own, then me. Name lookups that match in both profiles return ambiguous with both ids. */
export function get(rs: ReadSet, ref: MemoryRef, opts?: GetOptions): Promise<MemoryView> {
	throw new Error("not implemented");
}

/** The only write path for automation. */
export type SystemChange =
	| { op: "promote"; captureIds: string[]; as: SaveInput } // creates or appends inferred memory with evidence edges
	| { op: "compact"; journalId: MemoryId; summary: string; throughSeq: number } // archives entries <= throughSeq
	| { op: "merge"; survivor: MemoryId; duplicates: MemoryId[]; mergedBody?: string }
	| { op: "supersede"; replacement: SaveInput; old: MemoryId[] }
	| { op: "link"; edges: Edge[] }
	| { op: "flag"; memoryId: MemoryId; flag: Omit<Flag, "activityId" | "at"> }
	| { op: "expire_captures"; before: IsoTime }
	| { op: "purge_archive"; before: IsoTime } // no undo; the activity row records counts only
	| { op: "restore"; activityId: ActivityId }; // undo

export interface SystemResult { activityId?: ActivityId; applied: boolean; convertedToFlag: MemoryId[] }

/**
 * Enforces the protection rule in one place:
 *   protected(m) = db.profile === "me" || m.pinned || m.seeded ||
 *                  (m.type in {feedback, user} && m.origin in {stated, imported})
 * Any merge, supersede, compact, or removal that touches a protected record is replaced by a flag.
 * Writes the change, archive rows, revisions, and the activity row with undo in one batch.
 * Idempotent per (actor.runId, op, targets): replays return the first activity id.
 */
export function applySystemChange(db: ProfileDb, change: SystemChange, actor: Extract<Actor, { kind: "system" | "owner" }>): Promise<SystemResult> {
	throw new Error("not implemented");
}

export interface RecallQuery { query: string; types?: MemoryType[]; scope?: string; limit?: number; tokenBudget?: number; includeJournals?: boolean }
export interface RecallHit { memoryId: MemoryId; profile: ProfileSlug; type: MemoryType; kind: MemoryKind; name: string; origin: Origin; revision: number; passage: string; entrySeq?: number; score: number; channels: ("exact" | "literal" | "fts" | "entry_fts" | "vector")[]; updatedAt: IsoTime }
export interface RecallResult { results: RecallHit[]; estimatedTokens: number; truncated: boolean; searched: ProfileSlug[] }
/**
 * Channels per database: exact normalized name, literal instr() over card fields, memories_fts,
 * entries_fts (deduplicated to the parent journal), card vectors. 200 candidates per channel.
 * RRF k=60 over all lists from all databases in the ReadSet. Inferred hits score x0.7 so a stated
 * record on the same topic outranks them. Passages 700 chars around the first match.
 * Budget: JSON length / 4 per hit, BothQ packing order. Only active, non-candidate records.
 * The query embedding is the only AI call; on budget refusal the vector channel is skipped.
 */
export function recall(rs: ReadSet, q: RecallQuery, ai: AiClient): Promise<RecallResult> {
	throw new Error("not implemented");
}
```

```ts
// src/capture.ts

export interface CaptureInput { kind: Capture["kind"]; body: string; source: Capture["source"]; requestId: RequestId }
/** Redacts, stores pending, never touches memories. Size cap 32 KB after redaction. */
export function ingest(db: ProfileDb, input: CaptureInput, actor: Actor): Promise<{ captureId: string; action: "created" | "replayed" }> {
	throw new Error("not implemented");
}
export function list(db: ProfileDb, q: { status?: Capture["status"] | "all"; query?: string; limit: number }): Promise<Capture[]> {
	throw new Error("not implemented");
}
/** Owner-driven promotion, same path as automation's promote but with origin "stated". */
export function promote(db: ProfileDb, captureId: string, as: SaveInput, actor: Actor): Promise<WriteResult> {
	throw new Error("not implemented");
}
export function dismiss(db: ProfileDb, captureId: string, reason: string, actor: Actor): Promise<void> {
	throw new Error("not implemented");
}
```

```ts
// src/graph.ts: entities, edges, traversal, timeline. Reads only; writes go through memory/index.ts.

export interface Traversal { start: NodeRef | { entityKey: string }; rels?: Edge["rel"][]; depth: 1 | 2 | 3; limit: number }
/** Recursive CTE per database; edges into "me" are followed in DB_ME. Never crosses into a sibling. */
export function explore(rs: ReadSet, t: Traversal): Promise<{ nodes: (Entity | RecallHit)[]; edges: Edge[] }> {
	throw new Error("not implemented");
}
export interface TimelineQuery { since: IsoTime; until?: IsoTime; kinds?: ("revision" | "activity" | "capture" | "entry")[]; limit: number }
export function timeline(rs: ReadSet, q: TimelineQuery): Promise<{ at: IsoTime; profile: ProfileSlug; kind: string; summary: string; ref: NodeRef }[]> {
	throw new Error("not implemented");
}
```

```ts
// src/sql.ts: read-only SQL for agents and the dashboard.

/**
 * Runs `SELECT * FROM (<sql>) LIMIT 200` against one database of the ReadSet.
 * Wrapping makes any non-SELECT a syntax error. A token check after stripping comments and
 * literals also rejects ATTACH, PRAGMA, and multiple statements. Max 100 bound params.
 */
export function readOnlyQuery(db: ProfileDb, sql: string, params: (string | number | null)[]): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
	throw new Error("not implemented");
}
```

```ts
// src/learn/ai.ts: all Workers AI calls. Owns model choice and the budget guard.

export type AiTask = "embed" | "classify_capture" | "extract_digest" | "compact_journal" | "judge_pair" | "strategic_review";
export type Lane = "per_write" | "batch";
export interface AiClient {
	/** 256-dim, L2-normalized, int8-quantized vectors. Batch of at most 32 texts. */
	embed(texts: string[], lane: Lane): Promise<Int8Array[]>;
	/** JSON-schema constrained output; parsed and validated before return. */
	complete<T>(task: Exclude<AiTask, "embed">, input: string, schema: JsonSchema<T>): Promise<T>;
}
export class BudgetExhausted extends Error {}
/**
 * Before each call: reserve estimated neurons with a conditional UPDATE in control D1
 * (`used + r <= cap` for per_write, `used + r <= cap - PER_WRITE_FLOOR` for batch). Zero rows
 * changed throws BudgetExhausted. After the call: reconcile to actual usage from the response.
 * Cap: 9,000 on Free (Cloudflare stops at 10,000), AI_DAILY_NEURON_CAP on Paid.
 */
export function aiClient(env: Env, control: D1Database): AiClient {
	throw new Error("not implemented");
}
```

```ts
// src/learn/nightly.ts

/** Instance id `nightly-YYYY-MM-DD` makes the cron trigger idempotent. */
export class NightlyRun extends WorkflowEntrypoint<Env, { day: string }> {
	async run(event: WorkflowEvent<{ day: string }>, step: WorkflowStep): Promise<void> {
		// for each profile from allProfiles(env):
		//   step.do(`expire:${p}`)   -> applySystemChange(expire_captures, now - 60d)
		//   step.do(`purge:${p}`)    -> applySystemChange(purge_archive, now - 90d)
		//   for each pending digest batch (<= 8 digests, <= 24k chars): step.do(`extract:${p}:${i}`)
		//        -> ai.complete("extract_digest") -> promote / link / flag changes
		//   for each finished journal (no append for 7 days, uncompacted entries > 8k chars): step.do(`compact:${p}:${id}`)
		//   dedupe: pairs with card cosine >= 0.92 or same (type, entity) -> step.do(`judge:${p}:${a}:${b}`)
		//   step.do(`backup:${p}:${table}:${page}`) per 256 KB page, then `drive:${p}` copy
		// Each step: <= 1 AI call, <= 3 D1 queries, CPU well under 10 ms. Per-night caps keep steps < 600.
		throw new Error("not implemented");
	}
}
```

## Per-profile SQLite DDL sketch

```sql
-- schema/profile/0001_init.sql, applied to every DB_<SLUG>

CREATE TABLE memories (
	rid INTEGER PRIMARY KEY,                -- stable rowid for FTS external content
	id TEXT NOT NULL UNIQUE,                -- UUID5, assigned at creation
	user_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('feedback','project','reference','procedural','user')),
	kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','journal')),
	name TEXT NOT NULL,
	norm_name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL DEFAULT '',
	why TEXT, how_to_apply TEXT, objective TEXT, steps_json TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','superseded','merged')),
	origin TEXT NOT NULL CHECK (origin IN ('stated','inferred','imported')),
	pinned INTEGER NOT NULL DEFAULT 0,
	seeded INTEGER NOT NULL DEFAULT 0,
	flags_json TEXT,
	revision INTEGER NOT NULL,
	content_hash TEXT NOT NULL,
	entry_count INTEGER NOT NULL DEFAULT 0,
	compacted_through INTEGER NOT NULL DEFAULT 0,
	valid_from TEXT NOT NULL, valid_until TEXT,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
	created_by TEXT NOT NULL, updated_by TEXT NOT NULL,   -- Actor JSON
	embed_state TEXT NOT NULL DEFAULT 'dirty' CHECK (embed_state IN ('dirty','done','failed')),
	embedding TEXT,                          -- base64 int8[256]; D1 returns BLOBs as number arrays
	CHECK (type <> 'procedural' OR (objective IS NOT NULL AND steps_json IS NOT NULL AND kind = 'note'))
);
CREATE UNIQUE INDEX memories_active_identity ON memories(scope, type, norm_name) WHERE status = 'active';
CREATE INDEX memories_updated ON memories(updated_at);
CREATE INDEX memories_dirty ON memories(embed_state) WHERE embed_state <> 'done';

CREATE TABLE entries (
	rid INTEGER PRIMARY KEY,
	memory_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	actor TEXT NOT NULL,
	request_id TEXT,
	UNIQUE (memory_id, seq)                  -- second compare-and-swap for concurrent appends
);

CREATE TABLE revisions (
	memory_id TEXT NOT NULL,
	revision INTEGER NOT NULL,
	op TEXT NOT NULL,
	snapshot_json TEXT,                      -- null only for op = 'appended'
	entry_from INTEGER, entry_to INTEGER,    -- set only for op = 'appended'
	request_id TEXT, activity_id TEXT,
	actor TEXT NOT NULL, created_at TEXT NOT NULL,
	PRIMARY KEY (memory_id, revision),       -- the compare-and-swap
	CHECK ((op = 'appended') = (snapshot_json IS NULL))
) WITHOUT ROWID;

CREATE TABLE requests (
	request_id TEXT PRIMARY KEY,
	op TEXT NOT NULL,
	payload_hash TEXT NOT NULL,
	memory_id TEXT,
	result_json TEXT NOT NULL,               -- committed in the same batch as the change
	created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE entities (
	id TEXT PRIMARY KEY,                     -- kind:key
	kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
	attrs_json TEXT NOT NULL DEFAULT '{}',
	origin TEXT NOT NULL,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX entities_kind_name ON entities(kind, name);

CREATE TABLE edges (
	src_type TEXT NOT NULL, src_id TEXT NOT NULL, rel TEXT NOT NULL,
	dst_profile TEXT NOT NULL, dst_type TEXT NOT NULL, dst_id TEXT NOT NULL,
	origin TEXT NOT NULL, evidence_json TEXT, created_at TEXT NOT NULL,
	PRIMARY KEY (src_type, src_id, rel, dst_profile, dst_type, dst_id)
) WITHOUT ROWID;
CREATE INDEX edges_dst ON edges(dst_profile, dst_type, dst_id);

CREATE TABLE captures (
	id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL CHECK (kind IN ('digest','observation')),
	body TEXT NOT NULL,
	source_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','dismissed','expired')),
	promoted_to_json TEXT, dismiss_reason TEXT,
	classified_json TEXT,                    -- tick.classify output: profile hint, kinds, is_correction
	received_at TEXT NOT NULL, last_touched_at TEXT NOT NULL,
	expires_at TEXT                          -- null once promoted
) WITHOUT ROWID;
CREATE INDEX captures_status ON captures(status, received_at);

CREATE TABLE activity (
	id TEXT PRIMARY KEY,                     -- ULID, time-sortable
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	run_key TEXT UNIQUE,                     -- runId:op:targets hash; makes Workflow step retries idempotent
	op TEXT NOT NULL,
	summary TEXT NOT NULL,
	targets_json TEXT NOT NULL,
	undo_json TEXT NOT NULL,
	undone_at TEXT, undone_by TEXT
) WITHOUT ROWID;

-- Removed rows, kept 90 days. row_json is built in SQL with json_object(...) by INSERT ... SELECT,
-- so large rows never pass through bound parameters. Column lists come from src/memory/schema.ts,
-- and a test compares them with PRAGMA table_info so a schema change without a list change fails CI.
CREATE TABLE archive (
	id TEXT PRIMARY KEY,
	activity_id TEXT NOT NULL,
	table_name TEXT NOT NULL CHECK (table_name IN ('memories','entries','revisions','edges','captures')),
	row_key TEXT NOT NULL,
	row_json TEXT NOT NULL,
	archived_at TEXT NOT NULL,
	purge_after TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX archive_purge ON archive(purge_after);
CREATE INDEX archive_activity ON archive(activity_id);

CREATE TABLE sync_state (
	source TEXT PRIMARY KEY,                 -- 'github:Sequoia-Engineering', 'jira:SEQ'
	cursor TEXT, last_run_at TEXT, last_error TEXT
) WITHOUT ROWID;

-- Full text. Identifiers like #123, foo.bar, SEQ-1234 stay single tokens.
CREATE VIRTUAL TABLE memories_fts USING fts5(
	name, description, body, why, how_to_apply, objective,
	content = 'memories', content_rowid = 'rid',
	tokenize = "unicode61 tokenchars '-_./#@:'"
);
CREATE VIRTUAL TABLE entries_fts USING fts5(
	body, content = 'entries', content_rowid = 'rid',
	tokenize = "unicode61 tokenchars '-_./#@:'"
);

-- Re-index memories only when indexed text changes, so appends do not re-tokenize the head row.
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, name, description, body, why, how_to_apply, objective)
	VALUES (new.rid, new.name, new.description, new.body, new.why, new.how_to_apply, new.objective);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF name, description, body, why, how_to_apply, objective ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, name, description, body, why, how_to_apply, objective)
	VALUES ('delete', old.rid, old.name, old.description, old.body, old.why, old.how_to_apply, old.objective);
	INSERT INTO memories_fts(rowid, name, description, body, why, how_to_apply, objective)
	VALUES (new.rid, new.name, new.description, new.body, new.why, new.how_to_apply, new.objective);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, name, description, body, why, how_to_apply, objective)
	VALUES ('delete', old.rid, old.name, old.description, old.body, old.why, old.how_to_apply, old.objective);
END;
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
	INSERT INTO entries_fts(rowid, body) VALUES (new.rid, new.body);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
	INSERT INTO entries_fts(entries_fts, rowid, body) VALUES ('delete', old.rid, old.body);
END;
```

The owner model has no table of its own. It is the set of `type = 'user'` memories (plus `feedback` rules) in `me` and in each profile, with `origin`, `pinned`, and `evidence_for` edges to captures and entries. The dashboard view is a query.

```sql
-- schema/control/0001_init.sql, applied to DB_CONTROL
CREATE TABLE profiles (user_id TEXT, slug TEXT, binding TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, slug)) WITHOUT ROWID;
CREATE TABLE devices (
	id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
	token_hash TEXT NOT NULL,                -- sha256 of the secret half of am_dev_<id>_<secret>
	default_profile TEXT NOT NULL, allowed_profiles_json TEXT NOT NULL, scopes_json TEXT NOT NULL,
	created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
) WITHOUT ROWID;
CREATE TABLE routing_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, priority INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('git_remote','path_prefix')), pattern TEXT NOT NULL, profile TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE ai_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE TABLE moves (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_id TEXT NOT NULL, from_profile TEXT NOT NULL, to_profile TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('intent','copied','done')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE migration_review (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_ref TEXT NOT NULL, suggested_profile TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved_profile TEXT, resolved_at TEXT) WITHOUT ROWID;
```

### Write amplification per operation

Rows written count table rows, index entries, and FTS5 shadow-table rows. FTS5 cost per indexed document is an estimate of about 5 rows (`_data` segment, `_docsize`, `_idx`, occasional merges). Phase 1 must measure it with `meta.rows_written`.

| Operation | Rows written (estimate) | Detail |
|---|---:|---|
| `save_memory`, new note | 12 | memories 1, unique id 1, identity 1, updated 1, dirty 1, FTS 5, revision 1, request 1 |
| `save_memory`, update with text change | 15 | memories 1, index changes 2 to 3, FTS delete plus insert 10, revision 1, request 1 |
| `append_memory` | 11 | entry 1, entry unique 1, entries FTS 5, head 1, updated index 1, revision 1, request 1. Head FTS untouched (trigger is column-scoped). |
| `retire_memory` | 5 | memories 1, identity index 1, updated 1, revision 1, request 1 |
| Supersede k records | 12 + 4k | each old record: head, identity index, revision, edge |
| `capture` | 4 | captures 1, request unique 1, status index 1, plus device `last_seen_at` at most hourly |
| tick embedding of one card | 3 | memories 1, dirty index removal 1, embedding column (same row) |
| Compact a 664-entry journal | about 5,300 | archive 664 plus index 1,328, entries delete 664 plus unique 664, FTS delete about 2,000, head plus FTS 11, revision, activity |

At about 99 writes per day the write path costs about 1,200 rows. Compaction is the large item, and nightly caps it at the row budget described below.

## MCP tool list

Twelve core tools, one Paid-only. BothQ's `find_rule` and `find_routine` become `recall_memories` with `types`. `list_memories` becomes `query_sql` or the dashboard.

| Tool | Input (beyond `context`) | Output | Contract notes |
|---|---|---|---|
| `save_memory` | `SaveInput` | `WriteResult` | Create, or update when `memory_id` or an active identity plus `expected_revision` is given. Rename keeps id. `supersedes` retires old ids in the same batch. Procedural needs `objective` and `steps`. `profile` override, or a different `profile` on update, starts the move protocol. |
| `append_memory` | `AppendInput` | `WriteResult` | `request_id` required. Rejected for procedural. Lost race retried up to 3 times unless `expected_revision` is set. |
| `retire_memory` | `RetireInput` | `WriteResult` | Status `retired`, `valid_until` set, history kept. |
| `get_memory` | `MemoryRef`, `history?`, `entries?` | `MemoryView` | Notes return full body. Journals return summary plus newest entries within `entries.token_budget` and a cursor. History paging replaces `memory_history`. Retired records readable by id. |
| `recall_memories` | `RecallQuery` | `RecallResult` | Routed profile plus `me`. Candidates excluded. |
| `capture_memory` | `CaptureInput` | `{capture_id, action}` | Same function as `/v1/capture`. Untrusted evidence. |
| `review_candidates` | `{action: "list" \| "promote" \| "dismiss", ...}` | list or `WriteResult` | Manual review is optional; the pipeline promotes automatically. |
| `explore_graph` | `Traversal` | nodes and edges | Depth at most 3, own profile plus `me`. |
| `timeline` | `TimelineQuery` | dated items | Revisions, entries, captures, activity, merged across the `ReadSet`. |
| `query_sql` | `{profile, sql, params?}` | columns, rows | Read-only, 200-row cap, one database per call. |
| `priority_board` | `{profile?}` | ranked tickets and PRs | Computed from synced `ticket` and `pr` entities (phase 5). |
| `strategic_review` | `{profile?, week?}` | latest review memory plus signals | Produced weekly by `WeeklyReview`. |
| `corpus` (Paid) | `{mode: "search" \| "get" \| "sql", ...}` | rows or passages | One `CORPUS_<SLUG>` D1 per profile, read-only. |

Undo, devices, tokens, and routing rules are dashboard operations only. Agents cannot revoke tokens or rewrite routing.

## Module map

```
src/
	index.ts            fetch() routes /mcp, /v1/capture, /v1/import, /api/*, OAuth endpoints; scheduled() dispatches crons
	auth.ts             Principal from Clerk JWT or OAuth props, device tokens, dashboard session; one adapter kept after the phase-1 test
	profiles.ts         profile registry, ProfileDb and ReadSet construction, isolation rule, binding check
	routing.ts          route(), normalizeRemote(); rules loaded from control D1
	mcp.ts              tool table (name, zod schema, handler) and error mapping; createMcpHandler wiring
	api.ts              dashboard REST and capture/import endpoints; parses into domain types
	sql.ts              read-only query runner
	capture.ts          ingest, list, promote, dismiss
	graph.ts            explore, timeline
	memory/
		index.ts          public interface (save, append, retire, get, recall, applySystemChange)
		store.ts          batch protocol, request replay, revisions, supersession, protection rule, archive and undo
		search.ts         channels, RRF, passages, budget packing
		vectors.ts        card text, quantize, cosine (internal seam for a later Vectorize adapter)
		redact.ts         port of memory_privacy.py
		schema.ts         column lists used by archive SQL, checked against PRAGMA table_info in tests
	learn/
		ai.ts             model table, budget guard, JSON-schema validation of outputs
		tick.ts           embed dirty cards, classify captures, advance moves
		nightly.ts        NightlyRun Workflow
		weekly.ts         WeeklyReview Workflow
		backup.ts         dump, encrypt, R2 and Drive upload
	work/sync.ts        GitHub and Jira sync into entities (phase 5)
	corpus/             Paid-only module (phase 6)
schema/profile/*.sql, schema/control/*.sql
cli/digest.sh, cli/migrate/ (local, manual), cli/restore/
```

`memory/index.ts` is the only importable file under `memory/`. An ESLint `no-restricted-imports` rule fails the build on any deep import, so `store.ts` internals cannot become interface. The tool table in `mcp.ts` is data: the MCP handler and, if needed, a hand-written JSON-RPC dispatcher both read it, so tool names live in one list.

## Learning and cleanup pipeline

### Where it runs

| Trigger | Cron | Runs in | Work |
|---|---|---|---|
| `tick` | `*/10 * * * *` | `scheduled()` directly | Embed up to 16 dirty cards per profile in one AI call. Classify new captures with one call per 8 captures. Advance unfinished `moves`. Exits after one cheap query per profile when idle. |
| `nightly` | `17 21 * * *` (02:47 IST) | `NightlyRun` Workflow | Expire, purge, extract, compact, dedupe, link, backup. |
| `weekly` | `0 22 * * 0` | `WeeklyReview` Workflow | Strategic review per profile, saved as a `project` memory `strategic-review YYYY-Www`. |

Three of the five Free cron slots. Work-graph sync (phase 5) runs inside `tick` every third firing, as a Workflow instance because GitHub paging can exceed 50 external subrequests.

### Models per step

| Step | Model | Why |
|---|---|---|
| Card embedding, query embedding | `@cf/qwen/qwen3-embedding-0.6b`, truncated to 256 dims and renormalized | 1,075 neurons per M tokens. Fallback: `@cf/baai/bge-m3` at 1,024 dims int8 if truncation quality is poor. |
| Capture classification (profile hint, contains owner correction, entity mentions) | `@cf/ibm-granite/granite-4.0-h-micro` | Short JSON output, 1,542 / 10,158 neurons per M. |
| Digest extraction (decisions, preferences, facts, entities, corrections) | `@cf/qwen/qwen3-30b-a3b-fp8` | Judgment with JSON schema at 4,625 / 30,475. |
| Journal compaction | `@cf/qwen/qwen3-30b-a3b-fp8` | Finished journals average 7k chars, about 1,750 tokens in. |
| Duplicate and contradiction judgment | `@cf/qwen/qwen3-30b-a3b-fp8` | One pair per call, yes or no with reason. |
| Weekly strategic review | `@cf/openai/gpt-oss-120b` | One call per profile per week; quality matters more than cost. |

Rough check against the owner's estimate: 25k input tokens of digests per day plus about 10 compactions and 20 judgments comes to about 300k input and 15k output tokens per day on qwen3-30b, near 1.9k neurons. The weekly review adds about 1.2k neurons once a week. Per-write embedding and classification add under 100 a day. The orchestrator finalizes the budget table.

### Budget guard

One row per UTC day in `ai_budget`. Before a call, `ai.ts` estimates neurons from `chars / 4` input and the call's `max_tokens`, then runs `UPDATE ai_budget SET used = used + ?r WHERE day = ?d AND used + ?r <= ?limit`. Zero rows changed means refusal. The `per_write` lane uses the full cap. The `batch` lane stops 1,500 neurons early so recall embeddings and classification keep working after a heavy night. After the call, `ai.ts` writes the actual usage. On refusal, nightly steps record `deferred` in the run output and the items stay eligible tomorrow. Recall drops the vector channel and still returns literal and FTS results.

### Contracts that keep automation safe

- Every pipeline change is a `SystemChange` passed to `applySystemChange`. No pipeline module holds a D1 handle for writing.
- Protected records (everything in `me`, pinned, seeded, and stated or imported `feedback` and `user` memories) only receive flags. The rule lives in `store.ts` next to the code that would delete, so a new pipeline step cannot skip it.
- Inferred preferences go live with `origin = 'inferred'` and `evidence_for` edges. Recall scores them lower. The owner can pin (makes them protected) or delete them in the dashboard.
- Work-learned preferences go to `me` only when extraction marks them company-free and a deterministic filter finds no work entity names, routing patterns, or ticket keys in the text. Otherwise they stay in `work`. This is the only cross-profile write, and it runs inside `NightlyRun` with handles for both databases.
- Each Workflow step carries `run_key = runId:op:targets-hash` into the activity row. A retried step that already committed finds the `UNIQUE` row and returns the first result.
- Undo writes forward: `restore_revision` creates a new revision with the old snapshot, `unarchive` moves rows back with `INSERT ... SELECT` from `json_extract`, and the activity row gets `undone_at` with `WHERE undone_at IS NULL` in the same batch, so a double click undoes once.

### Expiry and purge

- Captures: `expires_at = received_at + 60 days`, cleared on promotion. `review_candidates(list)` and evidence links refresh `last_touched_at` and extend `expires_at` to 60 days from that touch. Nightly marks expired captures `expired` and archives their bodies.
- Archive: nightly deletes rows with `purge_after < now`. Purge has no undo. Its activity row keeps counts and ids only.
- Requests: rows older than 90 days are deleted with the archive purge. The idempotency window is therefore 90 days.
- Row budget: nightly stops compaction once the run has written 40k rows (measured from `meta.rows_written`), which keeps the Free day under 100k even on the night after migration.

## Routing of writes to profiles

The decision lives in `routing.ts` and reads rules from control D1. `mcp.ts` calls it before opening any database.

1. An explicit `profile` argument wins, if the principal may write it.
2. Routing rules, by priority. Default rules for the owner: `git_remote github.com/Sequoia-Engineering/*` to `work`; `git_remote github.com/wrick17/*` to `personal`; `path_prefix ~/Projects/sequoia` to `work`.
3. The device's `default_profile`.
4. For OAuth clients without a device record, the user's default (`personal` for the owner).

The response always includes `profile` and `routed_by`, so an agent sees a misroute at once. Device tokens restrict `allowed_profiles`, so a token leaked from the work laptop cannot read `personal`. Reads use the same decision and then add `me`.

Moving a memory between profiles is two databases, so it cannot be one batch. The move protocol: insert a `moves` intent in control D1, copy the memory (same id, revisions, entries, edges) into the target with `INSERT OR IGNORE`, archive it in the source with a `moved` revision that names the target, then mark the intent `done`. Each step is idempotent. `tick` resumes intents older than 5 minutes. Between the copy and the archive, the record is visible in both profiles for at most one tick.

Migration records that match no rule go to `migration_review` in control D1. They stay outside every profile until the owner assigns one in the dashboard, which then calls `save` with `origin = 'imported'`.

## Migration path

The owner runs local Codex in the foreground (Terra for judgment, Luna for mechanical) over a BothQ export and the native memory files. It writes NDJSON records with BothQ ids, dates, provenance, a suggested profile, and journals split into entries at their original append boundaries. `cli/migrate` posts batches of 200 records to `/v1/import` with an `import`-scope device token. Each record uses `request_id = import:<bothq_id>:<content_hash>`, so the upload can stop and resume. Expected cost: about 1,100 memories and 4,000 entries, near 60k rows written, which fits one Free day, or two with margin. Card embeddings for 1,100 cards cost about 600 neurons.

## Backups

### Point-in-time restore

D1 Time Travel restores any minute in the last 7 days on Free and 30 days on Paid, per database. The owner runs `wrangler d1 time-travel restore` by hand. Restoring one profile does not touch the others.

### Nightly encrypted export

`wrangler d1 export` fails on databases with FTS5 virtual tables (S11), so the backup is a logical dump of base tables only.

- `NightlyRun` dumps each base table in pages of about 256 KB, ordered by primary key, one Workflow step per page.
- Each page is NDJSON, encrypted with AES-256-GCM through WebCrypto. The key is the Worker secret `BACKUP_KEY`. Each object has a random 96-bit IV, and the object key is the AAD. No compression, to keep each step inside 10 ms CPU.
- Objects go to R2 as `backups/<date>/<profile>/<table>-<page>.enc`, then a manifest with row counts and SHA-256 per object. An R2 lifecycle rule deletes backups older than 30 days.
- The Drive step copies the night's objects into a dated Drive folder through the Drive API with a refresh token held as a secret, and deletes folders older than 14 days. It is optional in the template. Drive sees ciphertext only.
- `cli/restore` downloads and decrypts a night, recreates the schema from `schema/profile/*.sql`, loads rows with `wrangler d1 execute --file`, and rebuilds FTS with `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')` and the same for entries.

### Free-plan quota fit (owner volume)

| Resource | Free limit | Expected daily use | Headroom |
|---|---|---|---|
| Worker requests | 100k/day | 1k to 3k tool calls plus dashboard | Large |
| Worker CPU | 10 ms per invocation | Write about 2 to 4 ms, recall about 3 to 6 ms excluding MCP SDK setup | Tight; see risks |
| D1 databases | 10 | 4 (control, me, work, personal) | 6 more profiles |
| D1 storage | 500 MB per DB, 5 GB total | about 30 MB per profile with FTS | Large |
| D1 rows written | 100k/day | about 1.2k writes plus up to 40k nightly (usually under 10k) | Good |
| D1 rows read | 5M/day | about 3k per recall times 300 recalls, plus dashboard and backup dump, under 1.5M | Good |
| Queries per invocation | 50 | Write 2 to 6, recall 4, nightly step 3 or fewer | Large |
| Workers AI | 10k neurons/day | About 2k typical; guard caps at 9k | Good |
| Workflows steps | 3,000/day | Nightly 300 to 600, weekly about 20, sync about 150 | Good |
| Cron Triggers | 5 | 3 | 2 spare |
| R2 | 10 GB-month, 1M Class A | About 20 MB per night times 30 days; about 100 objects per night | Large |
| KV writes | 1k/day | OAuth token issue and refresh only, if `workers-oauth-provider` wins | Fine for one user |
| Vectorize | Unresolved | Not used | None needed |

## Unresolved items and switch points

| Question | Design works either way because | Switch point |
|---|---|---|
| Vectorize on Free | v1 uses card vectors in SQLite only | Add a Vectorize adapter behind `memory/vectors.ts` when one profile passes about 20k cards, or for the Paid corpus |
| MCP SDK CPU on Free | Tools are data in `mcp.ts` | If `createMcpHandler` setup plus a recall exceeds about 7 ms CPU in the phase-1 benchmark, replace it with a hand-written JSON-RPC dispatcher for `server/discover`, `tools/list`, and `tools/call` over the same tool table |
| Clerk RFC 8707 audience and loopback redirect | `auth.ts` returns a `Principal`; nothing else sees tokens | Phase-1 token test picks Clerk-as-AS or `workers-oauth-provider` fronting Clerk; the losing adapter is deleted, not kept as an option |
| Headless devices | Device tokens are our own rows in control D1 in both topologies | None |

## Tradeoffs accepted

- We accept two round trips per write (read, then batch) in exchange for transaction semantics on D1 without a coordinator.
- We accept that adding a profile needs a new D1 database, a wrangler binding, and a deploy, in exchange for isolation that no query bug can bypass.
- We accept that `get_memory` on a journal returns a summary plus paged entries instead of BothQ's full concatenated text, in exchange for constant-cost appends and responses that fit a token budget.
- We accept semantic recall at card level only, so a fact deep in a journal's tail is found by FTS and not by meaning, in exchange for a vector scan under 1 ms and no Vectorize dependency.
- We accept up to 10 minutes of lag before a new memory joins the vector channel, in exchange for a write path with no AI call.
- We accept a capped body size (48 KB per note field, 32 KB per entry, longer appends split) in exchange for staying under D1's 100 KB statement limit whatever the answer on bound parameters.
- We accept a 90-day idempotency window in exchange for a bounded `requests` table.
- We accept a moving memory being visible in two profiles for up to one tick, in exchange for not building cross-database transactions.

## Alternatives considered

- **One shared D1 with a `profile` column.** Simpler binding setup and no redeploy for new profiles. It lost because isolation becomes a `WHERE` clause in every query, so the one query an agent writes without it leaks `work` into `personal`. It exposes the isolation rule to every caller instead of hiding it in `profiles.ts`.
- **BothQ's journal shape, one growing text column.** Preserves `get_memory` returning the whole text. It lost on hard limits: a 987k-char journal approaches the 2 MB row cap, cannot be written in one 100 KB statement, and every append re-tokenizes the whole document into FTS, costing hundreds of rows per append.
- **Queues for per-write follow-up work.** A message per write is the textbook shape. It lost because a `dirty` flag plus the `tick` cron does the same job with zero queue operations and one less product in the template.
- **LLM extraction on the write path.** Gives instant structure. It lost on the 10 ms CPU limit, write latency, and a neuron cost proportional to calls instead of to nightly batches.
- **Mirror archive tables per live table.** Keeps typed columns for archived rows. It lost because each schema change needs a second table change; the generic `archive` table with a CI-checked column list has one list.

## Open questions and risks

1. Does D1's 100 KB statement limit count bound parameter bytes? If not, the note and entry caps can rise to the 2 MB row limit.
2. Do FTS5 external-content triggers behave in D1 as in stock SQLite, and what is the real `rows_written` per indexed document? The write table above rests on an estimate of 5.
3. Is the riskiest assumption true: does a recall stay under 10 ms CPU on Free once the MCP SDK, Clerk JWT verification, and parsing two D1 result sets are counted? If not, is the hand-written dispatcher acceptable, or does the owner prefer to say the core needs Paid?
4. Where does the digest text come from? A Claude Code `Stop` hook can block once and ask the agent to call `capture_memory` with a digest. Codex `notify` passes the last assistant message. Is a hook-requested agent digest acceptable as the Claude Code path?
5. Does `qwen3-embedding-0.6b` on Workers AI keep its quality when truncated to 256 dims? If not, `bge-m3` at 1,024 int8 dims costs 1 KB per card and still scans 1,100 cards in about 1 ms.
6. Does a Workflow step on Free get its own 50 external subrequests, or does the instance share them? It decides how many Drive uploads one step can do.
7. Is the 90-day request window long enough for the owner's retry habits, given the spool replay in `digest.sh`?
8. Is the owner fine with profile creation being a deploy step rather than a dashboard button?

## Next implementation step

Write `schema/profile/0001_init.sql` and `memory/store.ts` `save` and `append` with the batch protocol, plus one Miniflare test that fires two concurrent appends and a replayed `request_id` at a local D1 and records `meta.rows_written` per operation.

## Synthesis decision

Not applicable. This file is one candidate for the orchestrator's synthesis.

## Red-flag screen

| Flag | Checked | Result |
|---|---|---|
| Shallow module | Yes | `memory/index.ts` hides batch protocol, retries, replay, protection, archive, and fusion behind six functions. `mcp.ts` merges BothQ tools that shared one input shape. |
| Information leakage | Yes | D1 and MCP types stay in `profiles.ts`, `mcp.ts`, and `api.ts`. Storage column lists appear in DDL and `schema.ts` only, checked by a test. |
| Temporal decomposition | Yes | Modules follow ownership (store, search, capture, routing), not stages. The nightly Workflow orders steps but owns no domain rule. |
| Pass-through method | Yes | `capture_memory` and `/v1/capture` are two transports for one `ingest`. Each adds parsing and auth, not a forward. |
| Split ownership | Yes | Only `store.ts` writes memories, entries, revisions, archive, and activity. Learning proposes `SystemChange` values. Only `routing.ts` decides profiles. Only `ai.ts` touches `ai_budget`. |
| Two ways to do one task | Yes, one finding fixed | The brief's Vectorize-plus-SQLite fallback would be two vector paths. v1 keeps one; Vectorize replaces it later. Auth keeps one adapter after the test. |
| Importable internals | Yes | Lint rule bans deep imports under `memory/`. `ProfileDb` is branded and constructed only in `profiles.ts`. |
| Hand-synced list | Yes, mitigated | Profile bindings exist in wrangler config and the `profiles` table; `profiles.ts` fails closed with `profile_unavailable` when they disagree. Archive column lists are tested against `PRAGMA table_info`. Tool names live only in the `mcp.ts` table. |

Sources looked up for this candidate, all read 2026-10-28: [D1 Database API, batch](https://developers.cloudflare.com/d1/worker-api/d1-database/); [D1 limits, batch counts as one query, 100 KB statement, 2 MB row, 50-byte LIKE pattern](https://developers.cloudflare.com/d1/platform/limits/); [Workers pricing, index rows count as rows written](https://developers.cloudflare.com/workers/platform/pricing/); [SQLite storage API, virtual-table writes count](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); [Workflows pricing, included on Free](https://developers.cloudflare.com/workflows/reference/pricing/); [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/); [Workflows step billing, 3,000 steps/day on Free](https://developers.cloudflare.com/changelog/product-group/developer-platform/8/); [Free subrequest limits](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/); [D1 Free daily caps enforced](https://developers.cloudflare.com/changelog/product/d1/).
