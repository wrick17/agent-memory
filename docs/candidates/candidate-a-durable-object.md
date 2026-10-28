# Candidate A: one Durable Object per profile

Runner A, architect Phase B, 2026-10-28. Premise: one SQLite-backed Durable Object per (user, profile) is the deep module. Requirements are from `research/00-requirements.md`, with the owner's 16:50 IST correction applied. All LLM work runs on Workers AI under a hard budget guard. There is no local job runner. Local Codex is used only for the one-time migration distillation, which the owner runs in the foreground.

## Problem

Agent Memory replaces local BothQ (Neo4j) and the native memory of Claude Code and Codex with one hosted MCP server at `https://memory.wrick17.com`. It must keep BothQ's memory contracts: UUID5 stable ids, snapshot and delta revisions, `request_id` idempotency, `expected_revision` concurrency, supersession, candidates, routines, journals, and lexical recall with passages and token budgets. On top of those contracts it adds isolated profiles, automatic learning and cleanup with undo, a work graph, and a dashboard.

Four constraints make the shape non-obvious:

1. The core must fit the Workers Free plan. That plan allows 10 ms CPU per invocation for Workers and for Durable Objects, 100k DO rows written per day, 5 GB of DO storage per account, a 1 GB design limit per object, 50 subrequests per invocation, and 10k Workers AI neurons per day.
2. The data is dominated by append-heavy journals. Journals hold 94.5% of 5.5M characters, and the largest has 987k characters and 664 revisions. BothQ stores each journal as one growing string property, so every append rewrites the whole string and its full-text index. At 10 ms CPU, re-tokenizing a 1M-character document on every append is impossible.
3. Isolation is a hard rule. Every profile reads `me`. `work` and `personal` never read each other.
4. Learning and cleanup run without approval. Every automated change is undoable. Owner-stated rules and anything in `me` are never auto-deleted.

## Usage (caller's view)

### An agent saves a rule

The agent sends its repo identity. The server routes the write to a profile.

```jsonc
// tools/call save_memory
{
  "name": "save_memory",
  "arguments": {
    "type": "feedback",
    "name": "Run RTK for shell commands",
    "description": "Route shell commands through the rtk hook; use rtk proxy for exact output.",
    "why": "Owner wants compact command output in every session.",
    "how_to_apply": "Prefix with rtk proxy only when exact output matters.",
    "origin": "stated",
    "repo": { "remote": "git@github.com:wrick17/dotfiles.git", "path": "/Users/pratyush.poddar/dotfiles" },
    "request_id": "claude-code:7f3a:save:1"
  }
}
// result
{
  "memory_id": "5b0f6c4e-2a1d-5d4e-9a63-0e1c0b7d9a11",
  "profile": "personal",
  "routed_by": "rule:remote github.com/wrick17/*",
  "revision": 1,
  "action": "created"
}
```

### An agent appends to its task journal

`request_id` is required. A retry with the same id and payload replays the stored result. A retry with the same id and a different payload returns `idempotency_mismatch`.

```jsonc
{
  "name": "append_memory",
  "arguments": {
    "name": "claude-code journal: agent-memory architecture",
    "scope": "agent-memory",
    "content": "## 2026-10-28 17:05 IST\nCandidate A written. Next: orchestrator synthesis.",
    "request_id": "claude-code:7f3a:journal:12",
    "expected_revision": 11,
    "repo": { "path": "/Users/pratyush.poddar/Projects/personal/memory" }
  }
}
// result
{ "memory_id": "c1e2...", "profile": "personal", "revision": 12, "chars": 41873, "action": "appended" }
// a retry with a changed payload under the same id
{ "error": { "code": "idempotency_mismatch", "request_id": "claude-code:7f3a:journal:12" } }
```

### An agent recalls inside a work repo

The repo routes the read to `work`. The read set is `work` plus `me`. The Worker embeds the query once and sends the query and the vector to both profile objects in parallel. It then merges the two ranked lists and packs the merged list into the token budget.

```jsonc
{
  "name": "recall_memories",
  "arguments": {
    "keyword": "PR description format for Sequoia repos",
    "type": "feedback",
    "token_budget": 2000,
    "repo": { "remote": "git@github.com:Sequoia-Engineering/web-app.git" }
  }
}
// result
{
  "read_set": ["work", "me"],
  "hits": [
    { "memory_id": "...", "profile": "work", "name": "Sequoia PR protocol", "type": "feedback",
      "origin": "stated", "revision": 4, "passage": "...700 chars around the match...",
      "score": 0.031, "updated_at": "2026-10-20T09:12:00Z", "channels": ["exact", "fts", "vector"] },
    { "memory_id": "...", "profile": "me", "name": "Prefers terse PR bodies", "type": "user",
      "origin": "inferred", "evidence": 3, "passage": "...", "score": 0.022, "channels": ["vector"] }
  ],
  "used_tokens": 1840,
  "truncated": true,
  "lexical_only": false
}
```

### The hook posts an end-of-session digest

One shared script, `agent-memory-digest`, runs from the Claude Code and Codex session-end hooks. Which hook events exist is verified separately. The script sends only facts it builds locally: repo identity, the commits and diffstat from the session, and the agent's final summary message. It never sends the raw transcript or tool output. It authenticates with the machine's device token. If the request fails, the script writes the payload to `~/.agent-memory/spool/` (at most 200 files) and replays the spool on its next run.

```sh
curl -sS https://memory.wrick17.com/api/capture \
  -H "Authorization: Bearer $AGENT_MEMORY_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "kind": "digest",
  "request_id": "digest:claude-code:7f3a",
  "content": "## Done\n...\n## Decisions\n...\n## Outcomes\n...\n## Owner corrections\n...",
  "repo": { "remote": "git@github.com:Sequoia-Engineering/web-app.git", "path": "/Users/pratyush.poddar/work/web-app" },
  "source": { "client": "claude-code", "session_id": "7f3a", "branch": "feat/x", "ended_at": "2026-10-28T11:40:00Z" }
}
JSON
# 200 {"capture_id":"...","profile":"work","status":"candidate","action":"captured"}
```

`/api/capture` and the `capture_memory` tool build the same `capture` write command. The server has one capture path and two transports.

### The dashboard calls its API

The dashboard is a static app served by Workers Static Assets. It signs in with Clerk in the browser and sends the Clerk session token as a bearer token. Only the configured owner gets a session caller.

```ts
const token = await clerk.session.getToken();
const overview = await fetch("/api/overview", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
// { profiles: [{ name: "work", memories: 731, journals: 230, captures_pending: 12, last_cleanup: "...", bytes: 41_200_000 }, ...],
//   budget: { day: "2026-10-28", spent: 2140, cap: 9000 }, activity: [...latest 50 across profiles...] }

await fetch("/api/profiles/work/activity/8812/undo", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
// 200 { undone: 8812, by: 8840 }  or  409 { error: { code: "revision_conflict", detail: "memory changed after the automated edit" } }
```

## Shape

### Load-bearing decisions

1. **The profile object owns every byte and every rule of its profile.** `ProfileStore` is a SQLite-backed Durable Object addressed by `idFromName("<userId>:<profile>")`. It holds memories, revisions, idempotency requests, text chunks with two FTS5 indexes, vectors, entities and edges, captures, the activity log with undo, the archive, sync cursors, and its own pipeline schedule through one alarm. Its public interface has three RPC methods: `write`, `read`, and `tick`. Every mutation from any source goes through `write`: agents, the hook, the dashboard, the pipeline, sync, and migration. Redaction, idempotency, revision checks, protection policy, and activity logging therefore live in one place.
2. **Text is stored as bounded chunks, and a journal is a memory with entry chunks.** A memory row holds metadata. Its text lives in `texts` rows of at most 16k characters each, in four parts: `head`, `body`, `entry`, and `summary`. An append inserts one entry, and FTS5 tokenizes only that entry. The entry row is also the append revision (the delta), so journal content has one source of truth. This is what keeps a 987k-character, 664-revision journal inside the 10 ms CPU limit.
3. **A read set is one profile plus `me`, merged in the Worker.** The type `ReadSet = { primary: ProfileName; withMe: boolean }` cannot express "work plus personal". The Worker fans out to at most two objects, merges ranks with RRF (k=60), and applies the token budget once. State stays per profile (per shared-state discipline). The merge happens at the read boundary.

A small `AccountStore` Durable Object per user is the control plane. It holds devices and token hashes, routing rules, the profile registry, the account-wide Workers AI neuron ledger, and the migration review list. I chose a DO over KV because revocation must take effect on the next request, which KV's eventual consistency does not give. KV's 1k writes per day on Free would also cap `last_used_at` updates and ledger writes.

The Worker is a stateless shell. It authenticates, asks `AccountStore` for a `Caller`, routes the write or builds the read set, calls one or two profile objects, merges, and returns. It keeps no state between requests.

### Interface depth

`ProfileStore` hides FTS5 schema and triggers, chunking, the delta and snapshot revision model, idempotency, optimistic concurrency, supersession, protection policy, inverse commands for undo, archive and purge, vector storage and the Vectorize switch, every LLM prompt, sync adapters, and chunked backup. Callers learn three methods and two discriminated unions (`WriteCommand` and `ReadQuery`). The MCP tools and the dashboard API are thin parsers into those unions. Transport types never cross into the object. The Worker parses MCP arguments into domain commands before the RPC call (per boundary discipline).

What stays exposed: `expected_revision` and `request_id`, because they are the caller's own correctness tools, and `profile` and `repo`, because routing intent belongs to the caller.

### Type sketch

```ts
// src/domain.ts : shared domain types and pure helpers. No I/O.

/** Profile names come from the AccountStore registry. "me" is the only special name. */
export type ProfileName = string & { readonly __brand: "ProfileName" };
export const ME = "me" as ProfileName;

/** UUID5(namespace, "<scope>:<type>:<normalized name>") computed at creation. Never recomputed on rename or scope move. */
export type MemoryId = string & { readonly __brand: "MemoryId" };
/** UUID5(namespace, "<kind>:<normalized key>"). The same entity gets the same id in every profile, so read-set merges dedupe by id. */
export type EntityId = string & { readonly __brand: "EntityId" };

export type MemoryType = "feedback" | "project" | "reference" | "user" | "procedural";
/** "candidate" and "dismissed" are captures. Ordinary recall returns only "active". */
export type Status = "active" | "retired" | "superseded" | "candidate" | "dismissed";
/** stated: owner said it. agent: an agent asserted it. inferred: the pipeline learned it. */
export type Origin = "stated" | "agent" | "inferred" | "migration" | "sync";
export type Actor = "agent" | "hook" | "owner" | "auto" | "sync" | "migration";

export interface Step { order: number; action: string; success_criteria: string; notes?: string }

export interface Memory {
  id: MemoryId; profile: ProfileName; scope: string; type: MemoryType;
  name: string; description: string; why?: string; howToApply?: string;
  /** Required and non-empty when type is "procedural". Orders are unique positive integers. */
  objective?: string; steps?: Step[];
  status: Status; origin: Origin; pinned: boolean;
  revision: number;            // increases by 1 on every write, including appends
  chars: number;               // live head + body + entries + summary
  createdAt: string; updatedAt: string; validTo?: string;
  supersededBy?: MemoryId;
  /** Current content. For memories longer than 32k chars, get returns body, summary and a tail of entries plus a cursor. */
  content: string;
}

/** Snapshot revision for save, update, retire, supersede, restore and move. Appends are EntryRevision. */
export interface Revision {
  memoryId: MemoryId; revision: number;
  op: "saved" | "updated" | "retired" | "superseded" | "restored" | "moved" | "compacted";
  snapshot: { head: Pick<Memory, "name" | "description" | "why" | "howToApply" | "scope" | "type" | "status">;
              body: string; steps?: Step[]; foldedEntries?: [fromRev: number, toRev: number] };
  requestId?: string; actor: Actor; deviceId?: string; at: string;
}
export interface EntryRevision { memoryId: MemoryId; revision: number; op: "appended"; entry: string; separator: string; requestId: string; actor: Actor; at: string }

/** Written in the same transaction as the effect, so there is no "incomplete" state to recover. */
export interface RequestRecord { requestId: string; op: WriteCommand["op"]; payloadHash: string; result: WriteResult; at: string }

export interface Entity { id: EntityId; kind: "repo" | "org" | "project" | "person" | "tool" | "ticket" | "pr" | "topic"; key: string; name: string; attrs: Record<string, string | number | null>; origin: Origin; updatedAt: string }
/** One edge table for memory-entity, entity-entity and memory-memory links (supersedes, promoted_to, evidence). */
export interface Edge { src: MemoryId | EntityId; rel: string; dst: MemoryId | EntityId; origin: Origin; evidence?: MemoryId; validFrom: string; validTo?: string }

/** A capture is a Memory with status "candidate". Same table, same archive, same export. */
export type Capture = Memory & { status: "candidate" | "dismissed"; kind: "digest" | "observation" | "correction"; source: Record<string, string>; lastRecalledAt?: string };

export interface Activity {
  id: number; at: string; actor: Actor; deviceId?: string; stage?: PipelineStage;
  op: string; summary: string; targets: (MemoryId | EntityId)[];
  /** The inverse command. Running it through write() with request_id "undo:<id>" is idempotent. Null for undo rows themselves. */
  undo: WriteCommand | null; undoneBy?: number; undoOf?: number;
}

export interface RoutingRule { id: string; priority: number; remoteGlob?: string; pathPrefix?: string; profile: ProfileName; enabled: boolean }
export interface Device {
  id: string; name: string; via: "device" | "oauth";
  scopes: ("read" | "write" | "capture")[];
  /** Write targets. Reads add "me" implicitly. Never contains both work and personal unless the owner sets that explicitly. */
  profiles: ProfileName[]; defaultProfile?: ProfileName;
  createdAt: string; lastUsedAt?: string; revokedAt?: string;
}
export interface Profile { name: ProfileName; createdAt: string; archived: boolean }

/** The authenticated, authorized identity of one request. Built only by AccountStore.caller(). */
export interface Caller { userId: string; deviceId: string; owner: boolean; scopes: Set<Device["scopes"][number]>; profiles: ProfileName[]; defaultProfile?: ProfileName; rules: RoutingRule[]; sensitiveTerms: string[] }

/** The only shape a cross-profile read can take. Two non-me profiles cannot be expressed. */
export interface ReadSet { primary: ProfileName; withMe: boolean }

export type Identity = { memoryId: MemoryId } | { name: string; scope?: string };
export interface RepoRef { remote?: string; path?: string }

export type WriteCommand =
  | { op: "save"; type: MemoryType; name: string; description: string; content?: string; why?: string; howToApply?: string;
      scope?: string; objective?: string; steps?: Step[]; origin: Origin; supersedes?: MemoryId[]; expectedRevision?: number; requestId?: string }
  | { op: "update"; target: Identity; fromScope?: string; scope?: string; newName?: string; description?: string; content?: string;
      why?: string; howToApply?: string; objective?: string; steps?: Step[]; retire?: boolean; expectedRevision?: number; requestId?: string }
  | { op: "append"; target: Identity; content: string; separator?: string; expectedRevision?: number; requestId: string }
  | { op: "capture"; kind: Capture["kind"]; content: string; name?: string; scope?: string; source: Record<string, string>; requestId?: string }
  | { op: "resolve_candidate"; candidateId: MemoryId; action: "promote" | "dismiss"; into?: Identity | { type: MemoryType; name: string; description?: string }; reason?: string; requestId?: string }
  | { op: "link"; src: MemoryId | EntityId; rel: string; dst: { id: EntityId } | Omit<Entity, "id" | "updatedAt">; origin: Origin; requestId?: string }
  | { op: "owner"; action: "pin" | "unpin" | "forget"; memoryId: MemoryId; requestId?: string }
  | { op: "undo"; activityId: number }
  | { op: "restore"; archiveIds: number[] };

export interface WriteContext { actor: Actor; deviceId?: string; routedBy: string; at?: string /* honored only for actor "migration" */ }
export interface WriteResult { memoryId?: MemoryId; entityId?: EntityId; profile: ProfileName; revision?: number; chars?: number; action: string; activityId: number; superseded?: MemoryId[] }

export type ReadQuery =
  | { kind: "get"; target: Identity; history?: { limit: number; beforeRevision?: number }; entries?: { tail: number; beforeRevision?: number } }
  | { kind: "recall"; keyword?: string; vector?: Float32Array; type?: MemoryType | "all"; scope?: string; includeCaptures: boolean; limit: number }
  | { kind: "candidates"; status: "candidate" | "dismissed" | "all"; limit: number }
  | { kind: "graph"; start: { entityId: EntityId } | { name: string; kind?: Entity["kind"] }; rel?: string; depth: 1 | 2 | 3; limit: number }
  | { kind: "timeline"; from: string; to: string; kinds?: ("memory" | "entry" | "activity" | "ticket")[]; limit: number }
  | { kind: "board"; includeReview: boolean }
  | { kind: "sql"; sql: string; params: (string | number | null)[] }
  | { kind: "stats" } | { kind: "activity"; beforeId?: number; limit: number } | { kind: "archive"; limit: number };

export interface RecallHit { memoryId: MemoryId; profile: ProfileName; name: string; type: MemoryType; scope: string; status: Status; origin: Origin; revision: number; passage: string; rank: number; channels: ("exact" | "literal" | "fts" | "vector")[]; updatedAt: string }

export type ErrorCode = "not_found" | "ambiguous" | "revision_conflict" | "idempotency_mismatch" | "already_exists" | "validation" | "protected" | "forbidden" | "route_required" | "budget_exhausted";
export interface MemoryError { code: ErrorCode; message: string; details?: Record<string, unknown> }
/** RPC returns errors as values. Thrown errors lose their fields across the DO boundary. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: MemoryError };

export type PipelineStage = "index" | "embed" | "classify" | "extract" | "dedupe" | "compact" | "expire" | "purge" | "sync" | "review" | "backup";

export function stableMemoryId(scope: string, type: MemoryType, name: string): MemoryId { throw new Error("not implemented"); }
export function normalizeName(name: string): string { throw new Error("not implemented"); } // collapse whitespace, casefold
/** Port of memory_privacy.py. Applied inside ProfileStore.write to every string field, so no write path can skip it. */
export function redact<T>(value: T): T { throw new Error("not implemented"); }
export function payloadHash(cmd: WriteCommand): string { throw new Error("not implemented"); } // sha-256 of cmd minus requestId
```

```ts
// src/profile/store.ts : the deep module. The only file outside src/profile/ may import.
import { DurableObject } from "cloudflare:workers";

export class ProfileStore extends DurableObject<Env> {
  /**
   * The single mutation path. Runs in one ctx.storage.transactionSync, so a crash leaves nothing half-applied.
   * Order: redact, replay or reject by request_id, resolve identity, check expected_revision,
   * check protection policy (actor "auto" may not remove stated or pinned memories or anything in "me"),
   * apply, write the revision or entry, write activity with the inverse command, store the request result.
   * If the embedding card changed, mark the memory and arm the alarm. Never awaits I/O inside the transaction.
   */
  async write(cmd: WriteCommand, ctx: WriteContext): Promise<Outcome<WriteResult>> { throw new Error("not implemented"); }

  /** All reads. Pure SQL plus in-memory ranking. Recall on captures updates lastRecalledAt (the only write a read makes). */
  async read<Q extends ReadQuery>(q: Q): Promise<Outcome<ReadResultFor<Q>>> { throw new Error("not implemented"); }

  /** Called by the nightly cron and after config changes. Ensures the alarm is armed and starts the nightly backup. Idempotent. */
  async tick(reason: "nightly" | "config"): Promise<void> { throw new Error("not implemented"); }

  /**
   * Runs one bounded step of the most urgent due stage, then re-arms.
   * Each step stays under about 5 ms CPU. Waiting on Workers AI, R2 and GitHub does not count against CPU.
   * Steps are idempotent: they write through this.write() with request_id "auto:<stage>:<input hash>".
   */
  async alarm(): Promise<void> { throw new Error("not implemented"); }
}
```

```ts
// src/account/store.ts : control plane, one object per user (idFromName(userId)).
export class AccountStore extends DurableObject<Env> {
  /** Resolves a Principal into a Caller. Rejects revoked device tokens and any Clerk user other than OWNER_USER_ID. Updates lastUsedAt at most hourly. */
  async caller(p: Principal): Promise<Outcome<Caller>> { throw new Error("not implemented"); }

  /** Owner-only changes: devices (create returns the token once, stores only its SHA-256), rules, profiles, review-list resolution. */
  async admin(cmd: AccountCommand): Promise<Outcome<AccountResult>> { throw new Error("not implemented"); }

  /**
   * Account-wide neuron ledger keyed by UTC day. Workers AI's free allotment is per account, so one owner per account.
   * reserve() grants only if spent + estimate <= cap minus the reserve held for higher-priority stages.
   * settle() records the actual neurons computed from the model's token usage.
   */
  async budget(req: { op: "reserve"; stage: PipelineStage; estimate: number } | { op: "settle"; grantId: string; actual: number }): Promise<{ granted: boolean; grantId?: string; retryAt?: string }> { throw new Error("not implemented"); }
}
```

```ts
// src/auth.ts : identity only. Two adapters at one seam; the phase-1 token test picks one.
export type Principal =
  | { via: "oauth"; userId: string; clientId: string }   // Clerk JWT checked locally (iss, aud, exp), or workers-oauth-provider props
  | { via: "session"; userId: string }                   // dashboard Clerk session token
  | { via: "device"; tokenHash: string };                // "am_dev_" bearer, checked in AccountStore
export async function principal(req: Request, env: Env): Promise<Principal | null> { throw new Error("not implemented"); }

// src/routing.ts : pure.
/** Order: explicit profile (must be in caller.profiles), then rules by priority (remote glob, then path prefix), then the device default.
 *  type "user" with origin "stated" defaults to "me", unless the content contains one of caller.sensitiveTerms. Then it stays in the routed profile. */
export function routeWrite(caller: Caller, input: { profile?: string; repo?: RepoRef; type?: MemoryType; origin?: Origin; content: string }): Outcome<{ profile: ProfileName; reason: string }> { throw new Error("not implemented"); }
export function readSet(caller: Caller, input: { profile?: string; repo?: RepoRef; includeMe?: boolean }): Outcome<ReadSet> { throw new Error("not implemented"); }

// src/tools.ts : MCP tool table. Zod schemas are built once at module scope, not per request.
export function handleMcp(req: Request, caller: Caller, env: Env, ctx: ExecutionContext): Promise<Response> { throw new Error("not implemented"); }
/** Second-level RRF (k=60) across the read set's ranked lists, dedupe by memoryId, then pack to token_budget (JSON chars / 4). The only place budgets apply. */
export function mergeRecall(lists: RecallHit[][], limit: number, tokenBudget?: number): { hits: RecallHit[]; usedTokens: number; truncated: boolean } { throw new Error("not implemented"); }

// src/api.ts : dashboard REST and /api/capture. Builds the same WriteCommand and ReadQuery values as tools.ts.
export function handleApi(req: Request, caller: Caller, env: Env): Promise<Response> { throw new Error("not implemented"); }

// src/worker.ts : entry points.
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> { throw new Error("not implemented"); },
  async scheduled(evt: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> { throw new Error("not implemented"); }, // tick every profile
};
```

### Per-profile SQLite schema

Every table below lives inside one profile object. `profile_meta` records the user id and profile name, so exports stay self-describing.

```sql
CREATE TABLE profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;  -- user_id, profile, schema_version

CREATE TABLE memories (
  id TEXT PRIMARY KEY,                       -- UUID5 at creation; never changes
  scope TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('feedback','project','reference','user','procedural')),
  name TEXT NOT NULL, norm_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', why TEXT, how_to_apply TEXT,
  objective TEXT, steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  status TEXT NOT NULL CHECK (status IN ('active','retired','superseded','candidate','dismissed')),
  origin TEXT NOT NULL CHECK (origin IN ('stated','agent','inferred','migration','sync')),
  pinned INTEGER NOT NULL DEFAULT 0, flagged TEXT,           -- flagged: reason the pipeline wanted to remove a protected item
  capture_kind TEXT, capture_source TEXT, last_recalled_at TEXT,   -- captures only
  revision INTEGER NOT NULL, chars INTEGER NOT NULL,
  card_hash TEXT NOT NULL, embed_hash TEXT,                  -- card_hash != embed_hash means an embedding is due
  superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, valid_to TEXT,
  CHECK (type <> 'procedural' OR (objective IS NOT NULL AND steps IS NOT NULL))
);
CREATE UNIQUE INDEX memories_identity ON memories (scope, type, norm_name) WHERE status IN ('active','candidate');
CREATE INDEX memories_status_updated ON memories (status, updated_at);
CREATE INDEX memories_embed_due ON memories (id) WHERE embed_hash IS NOT card_hash AND status = 'active';

-- Text chunks of at most 16k chars. part: head (name, description, why, how_to_apply, steps rendered),
-- body (save/update content), entry (one append revision, possibly several chunks), summary (compaction output).
CREATE TABLE texts (
  rowid INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, part TEXT NOT NULL CHECK (part IN ('head','body','entry','summary')),
  revision INTEGER NOT NULL, chunk INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
  separator TEXT, request_id TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 1,           -- 0 when folded by an update or replaced; kept for history, removed from FTS
  indexed INTEGER NOT NULL DEFAULT 1         -- 0 only for chunks past the first 32k chars of one write (deferred-index switch)
);
CREATE INDEX texts_memory ON texts (memory_id, part, revision, chunk);

CREATE VIRTUAL TABLE texts_fts USING fts5 (body, content='texts', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE texts_tri USING fts5 (body, content='texts', content_rowid='rowid', tokenize='trigram');
-- Triggers keep both indexes equal to {texts WHERE live = 1 AND indexed = 1}. Only these triggers write the FTS tables.
CREATE TRIGGER texts_ai AFTER INSERT ON texts WHEN new.live = 1 AND new.indexed = 1 BEGIN
  INSERT INTO texts_fts (rowid, body) VALUES (new.rowid, new.body);
  INSERT INTO texts_tri (rowid, body) VALUES (new.rowid, new.body);
END;
-- texts_au: AFTER UPDATE OF live, indexed. Two triggers in the real schema: one issues the FTS 'delete' commands
-- when a row leaves the indexed set, the other inserts when a row enters it. Body text is never updated in place.
CREATE TRIGGER texts_ad AFTER DELETE ON texts WHEN old.live = 1 AND old.indexed = 1 BEGIN
  INSERT INTO texts_fts (texts_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO texts_tri (texts_tri, rowid, body) VALUES ('delete', old.rowid, old.body);
END;

CREATE TABLE revisions (                     -- snapshots only; append revisions are texts rows with part = 'entry'
  memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('saved','updated','retired','superseded','restored','moved','compacted')),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),   -- head + body + steps + folded entry range, never a copy of entries
  request_id TEXT, actor TEXT NOT NULL, device_id TEXT, at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision)
) WITHOUT ROWID;

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY, op TEXT NOT NULL, payload_hash TEXT NOT NULL,
  result TEXT NOT NULL, memory_id TEXT, at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE vectors (                       -- source of truth for embeddings; Vectorize is an optional replica
  memory_id TEXT PRIMARY KEY, card_hash TEXT NOT NULL, model TEXT NOT NULL, v BLOB NOT NULL   -- Float32 x 1024 = 4 KiB
) WITHOUT ROWID;

CREATE TABLE entities (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)), origin TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (kind, key)
);
CREATE TABLE edges (
  src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, origin TEXT NOT NULL, evidence TEXT,
  valid_from TEXT NOT NULL, valid_to TEXT, PRIMARY KEY (src, rel, dst)
) WITHOUT ROWID;
CREATE INDEX edges_dst ON edges (dst, rel);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, device_id TEXT, stage TEXT,
  op TEXT NOT NULL, summary TEXT NOT NULL, targets TEXT NOT NULL,
  undo TEXT CHECK (undo IS NULL OR json_valid(undo)), undone_by INTEGER, undo_of INTEGER
);
CREATE INDEX activity_at ON activity (at);

CREATE TABLE archive (                       -- removed rows, restorable until purge_after
  id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL, at TEXT NOT NULL, purge_after TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('memories','texts','vectors','edges','entities','revisions')),
  payload TEXT NOT NULL                      -- one source row as JSON; at most 16k chars of text, so far below the 2 MB row limit
);
CREATE INDEX archive_purge ON archive (purge_after);

CREATE TABLE cursors (                       -- pipeline and sync state, one row per stage or source
  stage TEXT PRIMARY KEY, cursor TEXT, due_at INTEGER NOT NULL, last_run_at TEXT, last_error TEXT, stats TEXT
) WITHOUT ROWID;

CREATE VIEW owner_model AS                   -- the model of the owner: user memories, stated first
  SELECT id, name, description, origin, pinned, revision, updated_at,
         (SELECT count(*) FROM edges e WHERE e.src = m.id AND e.rel = 'evidence') AS evidence
  FROM memories m WHERE type = 'user' AND status = 'active'
  ORDER BY origin = 'stated' DESC, pinned DESC, updated_at DESC;
```

The `owner_model` view is the model of the owner. Stated preferences outrank inferred ones in recall through an origin weight (stated 1.0, agent 0.9, inferred 0.7), so the view and recall order agree. Sync state for GitHub and Jira lives in `cursors`, keyed `sync:github` and `sync:jira`.

#### Write amplification

These are estimated rows written per operation, with one-chunk text. Cloudflare bills each row written, and each index entry a write touches likely counts as one more row. An FTS5 insert of one small document writes about 3 or 4 shadow rows per index (segment data, docsize, structure).

| Operation | Rows written | Breakdown |
|---|---:|---|
| `append_memory` (entry under 16k chars) | about 14 | texts 1 + index 1, two FTS inserts about 7, memories 1 + index 1, requests 1, activity 1 + index 1 |
| `save_memory` (new, short body) | about 25 | memories 1 + 3 indexes, texts 2 + 2, FTS about 14, revisions 1, requests 1, activity 2 |
| `update_memory` (body replaced) | about 30 | old body chunk live 0 (FTS deletes about 7), new body chunk (about 9), revision 1, memories 2, requests 1, activity 2 |
| `capture` (digest, about 4k chars) | about 25 | a memory row with status candidate plus head and body chunks |
| Embedding one memory | 3 | vectors 1, memories 1 + partial index 1 |
| Supersede N memories | about 25 + 4N | each superseded memory gets a status change, a revision, and an edge |
| Compact a 664-entry journal | about 6,000 once | 664 entries move to archive (live 0, FTS deletes about 7 each), plus the summary chunk and a revision |

At about 99 agent writes a day, mostly appends, agent traffic writes about 1,500 rows a day. That is 1.5% of the Free cap.

### MCP tools

There are 11 core tools and one Paid tool, down from 52 in BothQ. All tools accept `profile` (an explicit override) and `repo` (`{remote, path}`). Reads also accept `include_me`, which defaults to true. Write results always include `profile`, `revision`, `action`, and `activity_id`.

| Tool | Input | Output | Notes |
|---|---|---|---|
| `save_memory` | `type, name, description`, optional `content, why, how_to_apply, scope, objective, steps, origin ('stated' or 'agent'), supersedes, expected_revision, request_id` | `memory_id, revision, action ('created', 'replaced' or 'replayed'), superseded[]` | Procedural requires `objective` and ordered `steps`. A duplicate active identity returns `already_exists` unless `expected_revision` matches. |
| `update_memory` | identity (`memory_id`, or `name` with `scope`/`from_scope`), any changed field, `new_name`, destination `scope`, `retire: true`, `expected_revision, request_id` | `memory_id, revision, action` | A rename or scope move keeps the id. `retire` replaces BothQ's `retire_memory`. Replacing `content` folds live entries into the snapshot's range. It does not copy them. |
| `append_memory` | identity, `content` (at most 100k chars), `request_id` (required), `expected_revision, separator` | `memory_id, revision, chars, action ('appended' or 'replayed')` | Rejected for procedural memories. Creates nothing. Save the journal first. |
| `get_memory` | identity, optional `history {limit, before_revision}`, `entries {tail, before_revision}` | full `Memory`, steps, edges, and optionally the history window with `next_before_revision` | Content over 32k chars returns head, body, summary, and the last entries, plus a cursor. This replaces `memory_history`. |
| `recall_memories` | `keyword` (optional, so an empty keyword lists recent memories), `type` (with `feedback` and `procedural` covering `find_rule` and `find_routine`), `scope, limit (1 to 100), token_budget (64 to 32000), include_captures` | `read_set, hits[], used_tokens, truncated, lexical_only` | Uses the exact, literal (trigram), full-text (porter) and vector channels with RRF k=60, a 200-candidate cap per channel, 700-char passages, and a second RRF across the read set. |
| `capture_memory` | `content, kind ('digest', 'observation' or 'correction'), name, scope, source, request_id` | `capture_id, status 'candidate'` | Redacted. Captures are untrusted evidence and never appear in recall unless `include_captures` is set. |
| `list_candidates` | `status, limit` | `candidates[]` | Read only. |
| `resolve_candidate` | `candidate_id, action ('promote' or 'dismiss'), into, reason, request_id` | `memory_id, action` | Promotion creates or appends to the target and adds a `promoted_to` edge, all in one transaction. |
| `explore_graph` | `start {entity_id}` or `{name, kind}`, `rel, depth (1 to 3), limit (at most 200)` | `nodes[], edges[]` | Uses a recursive CTE over `edges` in each profile of the read set. The Worker merges nodes by `EntityId`. |
| `timeline` | `from, to, kinds, limit` | `events[]`, each with `at, profile, kind, memory_id or entity_id, summary` | Built from memories, entries, activity, and ticket changes. The Worker merges by time across the read set. |
| `board` | `include_review` | `priorities[]` (tickets and PRs with score and reasons), `review` (the latest strategic review memory and its signals) | Scoring is deterministic code. The review is written weekly by the pipeline. One profile only, with no `me` merge. |
| `query_sql` | `sql, params, profile` | `columns, rows (at most 500), truncated` | Read only, one profile, never fanned out. |
| `corpus` (Paid) | `action ('search', 'get' or 'sql'), query, ids, sql` | depends on the action | Served by `CorpusStore`, one per profile. Phase 6. |

`query_sql` enforces read-only access three ways. The statement must start with `SELECT` or `WITH` and contain a single statement. It runs inside `transactionSync`, which always throws a rollback sentinel at the end, so no write can persist. The object stops reading the cursor at 500 rows. An expensive query that exceeds 10 ms CPU fails only its own invocation.

Owner-only operations are not MCP tools: undo, restore from archive, pin, forget, devices, rules, and resolving the migration review list. The dashboard calls them through `/api/*`. They become the same `WriteCommand` values with actor `owner`.

### Module map

```
src/
  worker.ts          entry: fetch (/mcp, /api/*, static assets) and scheduled; builds the Caller
  auth.ts            Principal from a request: Clerk JWT adapter or workers-oauth-provider adapter; device token parsing
  routing.ts         pure routeWrite() and readSet()
  tools.ts           MCP tool table and schemas; args to WriteCommand or ReadQuery; fan-out, mergeRecall, packing
  api.ts             dashboard REST and /api/capture; the same commands as tools.ts, plus owner commands
  domain.ts          shared types, ids, normalizeName, redact, payloadHash
  account/store.ts   AccountStore DO: devices, rules, profiles, neuron ledger, migration review list
  profile/store.ts   ProfileStore DO class: write, read, tick, alarm (the interface)
  profile/schema.ts  DDL, triggers, migrations (run once per object version)
  profile/write.ts   the write path: idempotency, revisions, chunks, edges, protection, inverse commands, archive
  profile/read.ts    get, history, recall channels and RRF, passages, graph, timeline, board, sql
  profile/learn.ts   pipeline stages, prompts, model choices, budget calls
  profile/sync.ts    GitHub and Jira adapters for the work graph
  profile/backup.ts  chunked encrypted export to R2 and chunked restore
  corpus/store.ts    CorpusStore DO (Paid module)
dashboard/           static app (Workers Static Assets)
hook/agent-memory-digest   shared session-end hook script
cli/am               migrate (import of distilled snapshots), restore, corpus upload
```

Call chains stay short. Every tool call follows `tools.ts`, then `profile/store.ts`, then one of `profile/write.ts` or `profile/read.ts`: three files from tool name to SQL. `worker.ts`, `auth.ts`, and `routing.ts` only produce a `Caller` and a target before the chain starts. The pipeline follows `profile/store.ts` (alarm), then `profile/learn.ts`, then `profile/write.ts`.

An ESLint `no-restricted-imports` rule makes `profile/*` and `account/*` internals unreachable from outside their folders. Only `profile/store.ts` and `account/store.ts` are importable, so an agent that tries to call `write.ts` directly from `tools.ts` fails the build.

### Data flow of the dominant access patterns

**Append to a 987k-character journal.** `worker.ts` verifies the JWT locally with WebCrypto (well under 1 ms) and calls `AccountStore.caller()`. The await does not count as CPU. `routing.ts` matches the remote. The profile object's `write()` reads `requests` by primary key, finds the memory by id or `(scope, type, norm_name)`, compares `revision`, inserts one entry chunk (FTS tokenizes about 1.5k chars), updates `memories`, and inserts the request and activity rows. Nothing proportional to journal size runs. The embedding card is the name, the description, and the first 1,500 chars of the body or summary, so appends do not trigger re-embedding.

**Recall with a token budget.** Each profile object runs four bounded channels. Exact uses the identity index. Literal uses a `texts_tri MATCH '"<q>"' LIMIT 200` phrase query for queries of 3 or more chars, and falls back to name `LIKE` for shorter ones. Full-text uses `texts_fts MATCH` with bm25 and `LIMIT 200`. Vector is a brute-force cosine over the `vectors` rows of active memories: about 700 rows times 1,024 floats for `work`, roughly 0.7M multiply-adds in a `Float32Array` loop. The object fuses the channels with RRF k=60 (exact counts double), groups chunks by memory, and cuts a 700-char passage from the best chunk. The Worker runs a second RRF across `work` and `me`, then packs. If the query embedding fails or the budget is exhausted, the vector channel is skipped and `lexical_only: true` is returned.

**Cross-profile `me` reads.** The Worker makes at most two RPC calls, in parallel. `me` itself has `withMe: false`.

**Dashboard reads.** `/api/overview` fans out `read({kind: "stats"})` to every profile in the registry. Three objects means three subrequests. The owner sees each profile's data separately. Isolation applies to agent read sets, not to the owner.

### Learning and cleanup pipeline

The pipeline runs inside each profile object on its own alarm. A Durable Object has one alarm, so `cursors.due_at` holds the schedule for every stage. The alarm handler picks the most overdue stage, runs one bounded step, and sets the alarm to the next `due_at`. A write that changes an embedding card sets `due_at` for `embed` to now + 30 s. One account cron trigger (`30 20 * * *` UTC, 02:00 IST) calls `tick("nightly")` on every profile, which also starts the backup. That is one of the five Free cron triggers.

I did not use Workflows or Queues. Workflows on Free give the same 10 ms CPU per step, and Queues add 10k ops/day of accounting. The object already serializes its own work and holds its own cursors. A second scheduler would split ownership of the pipeline state.

| Stage | Trigger | Step bound | Model | Effect (always through `write()` with actor `auto`) |
|---|---|---|---|---|
| `index` | chunks with `indexed = 0` | 1 chunk | none | sets `indexed = 1` (deferred-index switch only) |
| `embed` | `embed_hash` differs from `card_hash` | 20 cards | `@cf/baai/bge-m3`, 1,024 dims | upserts `vectors`; publishes only if `card_hash` still matches (BothQ rule) |
| `classify` | new captures | 10 captures | `@cf/ibm-granite/granite-4.0-h-micro` | labels each capture (preference, correction, decision, fact, or noise), finds entity mentions (repos and ticket keys by regex, people and tools by model), and decides `me`-eligibility |
| `extract` | classified captures, hourly | 5 captures | `@cf/qwen/qwen3-30b-a3b-fp8` | promotes captures into memories: inferred `user` memories with `evidence` edges, decisions, and journal appends. Supersedes contradicted facts. Links entities. Sends `me`-eligible preferences to the `me` object. |
| `dedupe` | nightly | 20 pairs | cosine over 0.92 within one type, then `qwen3-30b` to confirm | retires the duplicate as `superseded`, unions its edges. A protected item gets `flagged` instead. |
| `compact` | journal idle for 7 days | 1 journal | `qwen3-30b` | writes a `summary` chunk and a `compacted` revision. Live entries move to archive. |
| `expire` | nightly | 100 rows | none | captures neither promoted nor recalled within 60 days move to archive |
| `purge` | nightly | 200 rows | none | deletes archive rows past `purge_after` (90 days) |
| `sync` | every 30 min, 08:00 to 22:00 IST | at most 40 fetches | none | GitHub (both profiles) and Jira (work) updates since the cursor go to `ticket`/`pr` entities and edges |
| `review` | weekly, Monday 03:00 IST | 1 call | `@cf/openai/gpt-oss-120b`, or `qwen3-30b` when the budget is short | writes memory `strategic review <ISO week>` (type `project`) from open tickets, PRs, decisions, and journal summaries |
| `backup` | nightly tick | 512 KB part | none | see the backups section |

Every model step follows the same order. It reads its inputs synchronously, reserves neurons from `AccountStore.budget()`, and awaits Workers AI with no transaction open. It then applies the result through `write()` with `request_id = "auto:<stage>:<sha256 of inputs>"` and `expected_revision` set to the revision it read. If a write landed in between, the step gets `revision_conflict` and leaves that item for the next pass. If the alarm retries after a crash (alarms retry automatically), the request id replays the stored result or returns `idempotency_mismatch`, which the step treats as already done. Last, it settles the actual neurons from the model's `usage` token counts against a price table in `learn.ts`.

**Budget guard.** The ledger cap is 9,000 neurons per UTC day on Free. The other 1,000 cover query embeddings, which are not metered per call (a recall's query is about 20 tokens, roughly 0.02 neurons), and rounding error. Priority order is `embed`, `classify`, `extract`, `compact`, `dedupe`, then `review`. A lower stage gets a grant only when the remaining budget exceeds a floor held for the stages above it (2,000 until 18:00 UTC). On Paid the cap is an owner setting, defaulting to 20,000 (about $0.11 a day of overage at most). A denied grant sets that stage's `due_at` to the next UTC midnight. Nothing fails; work waits.

**Estimated daily neurons** (the orchestrator finalizes this table): embeddings for about 100k new chars (25k tokens) come to about 30. Classification of about 30 captures and writes on granite comes to about 150. Extraction plus compaction on `qwen3-30b-a3b-fp8` comes to about 1,000 to 2,000, per the owner's figure. The weekly review on `gpt-oss-120b`, about 50k input and 5k output tokens, costs about 1,950 once a week, or about 280 a day on average. The total is about 1.5k to 2.5k a day, well under 9k. `gpt-oss-120b` for extraction would cost about 5k a day. That still fits, but it leaves too little room for catch-up after downtime, so it is not the default.

**Activity log with undo.** `write.ts` computes the inverse command in the same transaction as each change. Examples: the inverse of `retire` is an `update` restoring status and revision fields, the inverse of a dedupe merge restores the loser's status and removes the union edges, and the inverse of an archive move is `restore {archiveIds}`. The inverse carries `expectedRevision` set to the revision the change produced. An undo after a later edit therefore returns `revision_conflict`, and the dashboard shows "changed since; review by hand" instead of silently overwriting. An undo writes its own activity row with `undo_of`.

**Protection policy.** One function in `write.ts`, `mayRemove(memory, actor, profile)`, guards every removal: retire, supersede, archive, and purge of a source row. For actor `auto` it returns false when `origin = 'stated'`, when `pinned = 1`, when the type is `feedback` with origin stated, or when the profile is `me`. A refused removal sets `flagged` with the reason and logs activity. The owner then decides in the dashboard. Purge of archive rows is the one automated deletion. It only removes rows that a permitted move put in the archive at least 90 days earlier.

**Work-learned preferences going to `me`.** The `extract` stage in `work` proposes a preference. A deterministic check runs first: the content must not contain any of the caller's `sensitiveTerms`, which `AccountStore` derives from routing rule orgs, synced repo names, and Jira project keys. The granite classifier's "no company details" label must also be true. The `work` object then calls the `me` object's `write()` with `request_id = "from-work:<work activity id>"`, so a retry cannot duplicate. If either check fails, the preference stays in `work`.

### Routing writes to profiles

`AccountStore` owns the data: rules, device defaults, and profile permissions. `routing.ts` owns the decision as one pure function. The Worker calls it once per write, and the profile object records the reason in `activity`. The order is:

1. An explicit `profile` argument wins if it is in `caller.profiles`. Otherwise the call fails with `forbidden`.
2. `type: "user"` with `origin: "stated"` goes to `me`, unless the content contains a sensitive term.
3. Rules apply in priority order. A remote glob matches first (for example `github.com/Sequoia-Engineering/*` maps to `work` and `github.com/wrick17/*` maps to `personal`), then a path prefix.
4. The device default applies next.
5. Otherwise the call fails with `route_required`, and the error tells the agent to pass `profile`.

OAuth clients get a device row on first use with no default. The owner sets the default in the dashboard. Headless devices require a default at creation. Reads use the same order to pick the primary profile, but with no match they fall back to `me` only.

Migration writes that match no rule do not go to any profile. They wait in `AccountStore`'s review list until the owner assigns them in the dashboard. This keeps unrouted data out of `me`, which every profile can read.

### Auth switch point

The `Principal` seam has two adapters. Both exist because the phase-1 token test picks one.

- **Clerk as the authorization server.** The Worker serves RFC 9728 metadata pointing to Clerk's issuer and verifies Clerk JWTs locally with `@clerk/backend` and a pinned `jwtKey`. It checks `iss`, `exp`, and `aud == https://memory.wrick17.com/mcp`. This topology is chosen only if the test shows Clerk binds the RFC 8707 `resource` to `aud` and accepts loopback redirects on any port.
- **`workers-oauth-provider` fronting Clerk.** `OAuthProvider` wraps `worker.ts`. `/authorize` signs in with Clerk and calls `completeAuthorization({ userId })`. Tool handlers read `props.userId`. This topology needs `OAUTH_KV`, which on Free writes about 2 to 5 rows per token issue or refresh and stays well under 1k a day for one owner.

Device tokens (`am_dev_` plus 32 random bytes) bypass OAuth in both topologies. `AccountStore` stores only their SHA-256 and checks revocation on every request. Both topologies reject any Clerk user other than `OWNER_USER_ID`, because a Clerk app may allow sign-ups.

### Backups

- **Point-in-time restore.** Durable Object SQLite keeps 30 days of history (`getBookmarkForTime`, `onNextSessionRestoreBookmark`). This is the first line of recovery, for example after a bad pipeline run. Whether it exists on Free is not stated, so the nightly export is the backup that the template guarantees.
- **Nightly encrypted export.** `tick("nightly")` starts `backup` in each profile. Each alarm step reads base tables in primary-key order, never the FTS shadow tables, and serializes up to 512 KB of NDJSON. It encrypts the part with AES-256-GCM using a key derived with HKDF from the `BACKUP_KEY` secret, with a random 96-bit IV per part. It writes `backups/<date>/<profile>/<nnnn>.ndjson.enc` to R2 and finishes with an encrypted `manifest.json` that lists part hashes and row counts. A 40 MB profile needs about 80 steps, each under the CPU limit. An R2 lifecycle rule keeps 30 days.
- **Google Drive copy (optional).** After a manifest completes, `AccountStore`'s alarm copies the parts from R2 to a Drive folder, at most 40 parts per step. It streams the R2 body into the Drive upload, refreshing the OAuth access token from a `GDRIVE_REFRESH_TOKEN` secret. Drive holds only ciphertext.
- **Restore.** `cli/am restore <date> <profile>` calls an owner-only endpoint. The object fetches and decrypts parts in alarm steps and inserts rows through the normal triggers, so FTS rebuilds incrementally. A single `'rebuild'` command over 5.5M chars would exceed 10 ms.

### Migration and native cutover

The owner runs the distillation locally in the foreground with Codex (Terra for judgment, Luna for mechanical work). The output is current-state snapshot JSONL with dates, provenance, and a proposed profile per record, from BothQ, Claude Code memory files, and Codex memories. `cli/am migrate` posts batches of 50 `WriteCommand` values to the owner-only `/api/import` with actor `migration`, `at` set to the original date, and `request_id = "migrate:<source id>"`, so a rerun is safe. Legacy single-string journals are split into entries at date headings, and any piece over 16k chars is chunked. The CLI tracks estimated rows written and stops at 60k per UTC day. The import (about 1,100 memories and about 4k entry chunks, roughly 70k rows) finishes in two days. The `sequioa` typo is fixed by the distillation, and routing applies normally.

### Free-plan quota fit

The table assumes 500 tool calls, 20 digests, 200 dashboard requests, and 3 profiles per day.

| Limit (Free) | Expected use | Fit | Switch point |
|---|---|---|---|
| Workers requests, 100k/day | about 750 | 0.8% | none |
| Worker CPU, 10 ms/request | JWT check under 1 ms, MCP parse, merge of at most 200 hits | unmeasured | if phase-1 p95 exceeds 7 ms with `createMcpHandler`, replace it with a stateless JSON-RPC handler for `server/discover`, `tools/list` and `tools/call` with precomputed schemas, about 150 lines |
| DO CPU, 10 ms/invocation | append about 1 ms; recall with 4 channels about 3 to 6 ms (estimate); each pipeline step under 5 ms | recall is the tight one | if recall p95 exceeds 7 ms, enable the Vectorize replica first, then store int8 vectors |
| DO requests, 100k/day | about 2 per tool call, plus a third for `me`, plus about 300 alarms per profile | about 3k | none |
| DO rows written, 100k/day (account) | agents about 1.5k, pipeline about 2 to 6k, compaction bursts up to 10k | under 20% on normal days | migration throttled to 60k/day |
| DO rows read, 5M/day | recall about 1.5k rows (vector scan plus FTS), nightly backup about 100k | about 1M | none |
| DO storage, 5 GB/account and 1 GB/object design limit | about 6 MB text, about 30 MB for two FTS indexes, 8 MB revisions, 5 MB vectors, entities. About 60 MB total, growing about 100 MB/year before compaction | under 2% | if a profile passes 700 MB, alert in the dashboard and shorten the compaction idle threshold |
| Subrequests, 50/invocation | tool call at most 5 (Account, 2 profiles, AI); sync step at most 40 | fits | none |
| Workers AI, 10k neurons/day | about 1.5k to 2.5k | about 25% | hard stop at 9k through the ledger |
| Vectorize, 5M stored and 30M queried dims/month | off by default. If on: 1,100 x 1,024 = 1.1M stored, 500 x 30 x 1,024 = 15M queried | fits if available | turn on when brute-force recall exceeds 7 ms CPU or a profile passes 5k vectors. If Vectorize is Paid only, int8 SQLite vectors are the fallback |
| Cron triggers, 5/account | 1 | fits | none |
| KV, 1k writes/day | 0 in the Clerk topology; under 50 with workers-oauth-provider | fits | none |
| R2, 10 GB-month | about 40 MB/night times 30 days = 1.2 GB | fits | none |
| Clerk Hobby | 1 user | fits | none |
| Corpus | 3.2 GB, 1.7M FTS rows | does not fit Free | Paid only. `CorpusStore` per profile on the 10 GB object limit. |

## Synthesis decision

Not applicable to a single candidate. The orchestrator records the synthesis.

## Tradeoffs accepted

- We accept two RPC hops per tool call (`AccountStore`, then the profile) in exchange for immediate token revocation and one owner for devices, rules, and the ledger. A per-isolate cache would save about 5 ms of latency but would let a revoked token work for up to the cache lifetime.
- We accept that a journal's full text exists only as a join of entry chunks in exchange for appends whose cost does not grow with journal size. `get_memory` returns a tail and a cursor above 32k chars, which differs from BothQ's full-string return. The full string of a 987k-char journal would not fit an agent's context anyway.
- We accept two FTS5 indexes (porter and trigram), about 4x the raw text in storage, in exchange for indexed literal substring search. A `LIKE` scan over 5.5 MB would exceed 10 ms CPU.
- We accept brute-force vector search in SQLite as the default in exchange for no Vectorize dependency, no replica sync on the hot path, and backups that include vectors. It stops being viable at a few thousand vectors per profile, and the switch point says so.
- We accept that compaction moves journal entries to the archive, where they purge after 90 days. Detailed journal history is then gone, leaving the summary and the `compacted` revision. The owner asked for compaction and a 90-day purge. Undo works within the 90 days.
- We accept one alarm per profile multiplexing all stages through `cursors.due_at` in exchange for no Workflows or Queues and no second owner of pipeline state.
- We accept that a `request_id` is unique per profile, not per account. Routing is deterministic for the same input, so a retry lands in the same profile.
- We accept that unmatched migration records wait outside every profile, in `AccountStore`, until the owner routes them. Agents cannot recall them in the meantime.
- We accept that `sensitiveTerms` matching is a deterministic substring check plus one classifier label. It can miss a company detail phrased without any known term. That risk applies to inferred preferences moving from `work` to `me`.

## Alternatives considered

- **One D1 database with a `profile` column.** It exposes isolation as a `WHERE` clause that every query must carry, so one missed filter leaks `work` into `personal`. D1 export also fails on FTS5 virtual tables, and Free allows 50 queries per invocation. It hides less behind a larger interface (every module touches the shared schema), so it lost on depth and on isolation.
- **One Durable Object per user holding all profiles.** It concentrates state well but puts isolation back into queries. It also serializes every profile's writes and pipeline in one object, so `work` compaction would block `personal` appends, and the 1 GB Free object limit would cover the sum of all profiles. It lost because the profile is the real isolation and failure unit.
- **Stateless Worker logic over a dumb per-profile DO (SQL passthrough).** The object would expose `exec(sql)`, and policy would live in the Worker. That is the shallow-module and split-ownership red flag: the pipeline, migration, and tools would each re-implement idempotency and protection. Every multi-statement operation would also need several RPC round trips with no single transaction.
- **Journals as a single growing text column, as in BothQ.** It is simpler to read, but every append re-tokenizes the whole document. That breaks the 10 ms CPU limit at a few hundred thousand chars and writes far more FTS rows. The structure was wrong for the dominant access pattern, so chunks were the only viable shape.

## Open questions and risks

- Does recall over two FTS indexes plus a 700-vector scan stay under 7 ms CPU p95 in a Free-plan DO? This is the riskiest assumption in the candidate. Phase 1 should benchmark it with the real work-profile corpus before building anything else on recall.
- How much CPU does FTS5 trigram indexing of a 16k-char chunk cost? If two such chunks exceed the budget, the deferred-index switch (`indexed = 0`) must turn on for writes larger than 32k chars, and fresh large text becomes searchable only after the next alarm.
- Is point-in-time restore available to SQLite DOs on Free? If not, the template's only restore path is the nightly export, with up to 24 hours of loss.
- Should owner-stated `feedback` rules be in `me` by default, like stated preferences? Today routing sends them by repo, so a dotfiles rule learned in a work repo lands in `work`.
- Is a 7-day idle threshold right for "finished" journals? A journal reopened after compaction gets new entries after the summary. Is that acceptable, or should reopening restore the archived entries?
- Does `createMcpHandler` support the 2026-07-28 revision (`server/discover`, no `initialize`)? If not, the hand-rolled handler at the CPU switch point is needed anyway.
- Do Durable Object RPC calls count as subrequests on Free? Research did not confirm. The design uses at most 5 per request, so either answer fits.

### Red flags checked

| Flag | Result |
|---|---|
| Shallow module | `ProfileStore` has three methods behind two unions. Callers never coordinate several calls to finish one operation. Promotion, supersession, and undo are each one `write`. |
| Information leakage | The SQL schema stays inside `profile/`. MCP and REST types are parsed in `tools.ts` and `api.ts` and never reach the object. The neuron price table lives only in `learn.ts`. |
| Temporal decomposition | Modules follow ownership (write path, reads, pipeline, sync, backup), not request stages. The pipeline's stages sit in one module because they share one cursor table and one budget protocol. |
| Pass-through method | `tools.ts` is not a pass-through. It adds parsing, routing, fan-out, and merge. `store.ts` methods add the transaction and the alarm arming. |
| Split ownership | Each table has one writer: `write.ts`, plus `learn.ts`/`sync.ts`/`backup.ts` only through `write.ts` or their own `cursors` rows. FTS tables are written only by triggers. The ledger is written only by `AccountStore`. Vectorize, if enabled, is a replica fed from `vectors`. |
| Two ways to do one task | Capture has two transports and one command. `retire_memory` and `memory_history` merged into `update_memory` and `get_memory`. Dashboard and agent writes share `WriteCommand`. |
| Importable internals | A lint rule blocks imports of `profile/*` and `account/*` internals from outside their folders. |
| Hand-synced list | Profile names come only from the `AccountStore` registry. Tool schemas and commands are both derived from the Zod definitions in `tools.ts`. The two FTS indexes are kept equal by triggers, not by code paths. One remaining risk: the model price table in `learn.ts` must match Cloudflare's pricing page by hand. |

## Next implementation step

Build `profile/schema.ts` and `profile/write.ts` for `save` and `append` with `request_id` and `expected_revision`, plus `read.ts` recall. Load them with the real 987k-character journal and the work-profile export, and measure CPU per invocation on a Free-plan account before writing the Worker shell.
