# Agent Memory architecture

Status: design for owner approval, 2026-10-28. Author: Opus design sub-agent (architect Phases A to C). Inputs: `research/00-requirements.md` with every owner update through 18:45 IST, `research/01` to `03`, the BothQ memory sources, and two independent candidate designs in `docs/candidates/`.

Agent Memory is a hosted memory at `https://memory.wrick17.com`. It stores what the owner's agents learn, indexes how every record links to every other record and why, and returns that knowledge through MCP. It is a storage system. It never acts on the owner's behalf: no outbound internet calls, no syncing, no LLM judgment. The owner's agents do the thinking and write the results through MCP.

## Decisions at a glance

| Area | Decision |
|---|---|
| Shape | One SQLite Durable Object per (user, profile), `ProfileStore`, owns all data and rules for that profile. One `AccountStore` Durable Object per user holds devices, routing rules, the profile registry and the migration review list. A stateless Worker authenticates, routes, fans out to at most two profiles and merges. |
| Server role | Storage, deterministic indexing, retrieval, authorization, dashboard, deterministic housekeeping. No LLM on the server. |
| Outbound calls | None. Bindings only: Durable Objects, R2, Workers AI (embeddings), Static Assets. |
| Knowledge model | Typed graph with a fixed core ontology (16 node kinds, 17 relations, promotable `other`). Judgment edges and decisions require a reason and evidence. Edges and facts carry valid time and record time. Files are evidence, never nodes. |
| Links | The server derives identifier links and embedding-similarity `relates_to` links without an LLM. Agents add judgment links with reasons. |
| Recall | Exact, literal (FTS5 trigram), full text (FTS5 porter) and vector channels fused with RRF k=60, then expanded one hop through the graph, then merged across the profile and `me`, then packed to a token budget. |
| Embeddings | Workers AI `@cf/qwen/qwen3-embedding-0.6b` through the `AI` binding, truncated to 256 dimensions, int8 in SQLite. Switchable off for FTS5-only recall. About 80 to 550 neurons a day. |
| Auth | Clerk is the OAuth authorization server. The Worker verifies JWTs locally with a pinned public key. Revocable device tokens for headless machines and the local run. |
| Capture and work data | One shared end-of-session hook for Claude Code and Codex. It spools, then starts one short detached run that uploads a session digest, new commits, PR metadata, Jira context and checkout analyses, and runs the daily maintenance batch. Nothing stays resident. |
| Cleanup | Agents consolidate inline at task end and in the daily maintenance batch (`codex exec`, Luna for mechanical work, Terra for judgment). The server only computes which records need attention, and runs TTL, purge, exact dedupe and size caps, all logged with undo. |
| Retention | Unused captures archived after 90 days. Archive purged after 300 days. |
| Backups | Durable Object point-in-time restore (30 days) plus a nightly encrypted export to R2. Only the two most recent exports are kept. |
| Plans | Core fits Workers Free. Only the corpus module is Paid-only. |

## 1. Problem and constraints

BothQ is a local Neo4j memory with 52 stdio MCP tools, used from one trusted machine. It holds about 1,100 memories and 5.5M characters, and 94.5% of that is 706 rolling journals. The largest journal has 987k characters and 664 revisions. Every append rewrites the whole journal string. Memories have almost no links to repos, tickets or people, and recall is text search only.

The replacement must serve several machines and three agent clients at once, keep the BothQ write contracts, and understand the owner's projects, the people who worked on them, the bugs, features and architecture, and how all of it links and why. These constraints shape the design:

1. **Free plan fit for the core.** Workers and Durable Objects get 10 ms CPU per invocation, 100k Durable Object rows written per day, 5 GB of Durable Object storage per account, 1 GB per object (the design limit; see section 17), and 10k Workers AI neurons per day.
2. **Append-dominated journals.** A journal must not be one growing string. Re-tokenizing 1M characters on each append breaks the CPU limit, and a 2 MB row cap exists.
3. **Hard isolation.** Every profile reads `me`. `work` and `personal` never read each other. Colleagues live only in `work`.
4. **No agency on the server.** The Worker makes no outbound calls and holds no GitHub, Jira or Google credentials. It never edits or deletes by judgment.
5. **Nothing recurring on the owner's machine** beyond what runs at session end while the owner works. Capture hooks are inherent to agent use. The daily batch rides on the first session end of the day and exits when done.

BothQ contracts carried over unchanged: UUID5 stable ids from `scope:type:normalized-name` that survive renames and moves; snapshot revisions for save, update, retire and supersede, and delta revisions for append; `request_id` stores the operation, payload hash and result, and reuse with a different payload returns `idempotency_mismatch`; `expected_revision` returns `revision_conflict` on mismatch; `supersedes` retires older records atomically; procedural memories need an objective and ordered steps; captures never appear in ordinary recall; recall uses exact and literal boosts, full text, optional vectors, RRF k=60, a 200-candidate cap per channel, 700-character passages, and a token cost of JSON length divided by 4; redaction runs before persistence.

## 2. Usage (caller's view)

### An agent saves a rule the owner stated

The agent passes repo identity. The server picks the profile and says why.

```json
{
	"name": "save_memory",
	"arguments": {
		"kind": "rule",
		"type": "feedback",
		"name": "Use pnpm in Sequoia repos",
		"content": "Run pnpm install and pnpm -w build. npm rewrites pnpm-lock.yaml.",
		"why": "Owner correction on 2026-10-28 after npm broke the lockfile.",
		"how_to_apply": "Before any install or script run in a Sequoia-Engineering repo.",
		"origin": "stated",
		"links": [{ "rel": "part_of", "to": { "kind": "project", "key": "github:Sequoia-Engineering/web" } }],
		"repo": { "remote": "git@github.com:Sequoia-Engineering/web.git", "path": "/Users/p/work/web" },
		"request_id": "cc-7f3a-save-1"
	}
}
```

```json
{ "memory_id": "5b0d4e52-3f7e-5c55-9a0e-6d1f0e2b9c11", "profile": "work", "routed_by": "rule:github.com/Sequoia-Engineering/*", "revision": 1, "action": "created", "activity_id": 812 }
```

### An agent appends to its task journal from a second machine

```json
{
	"name": "append_memory",
	"arguments": {
		"name": "codex: bettergit sync rewrite",
		"content": "2026-10-28 16:58 IST. Moved conflict detection into the merge step. Tests green.",
		"request_id": "codex-mbp2-0193-append-17",
		"repo": { "remote": "git@github.com:wrick17/bettergit.git" }
	}
}
```

```json
{ "memory_id": "c1e9d3a0-…", "profile": "personal", "revision": 666, "entry_seq": 665, "action": "appended" }
```

The same call again returns `"action": "replayed"`. The same `request_id` with different content returns `{"error": {"code": "idempotency_mismatch"}}`.

### An agent records a decision and why

Judgment edges need a `reason` and `evidence`. Nodes are referenced by key, by id, or by `$n` for a node created in the same call.

```json
{
	"name": "record_knowledge",
	"arguments": {
		"nodes": [{ "kind": "decision", "name": "Detect sync conflicts in the merge step", "summary": "Conflict detection moved from pre-merge to merge.", "valid_from": "2026-10-28" }],
		"edges": [
			{
				"from": { "ref": "$0" }, "rel": "decided_because",
				"to": { "kind": "bug", "key": "github:wrick17/bettergit#41" },
				"reason": "Pre-merge detection missed commits rewritten by rebase.",
				"evidence": [{ "kind": "entry", "ref": "c1e9d3a0-…#665" }, { "kind": "commit", "ref": "git:wrick17/bettergit@9f2c1ab" }]
			}
		],
		"repo": { "remote": "git@github.com:wrick17/bettergit.git" },
		"request_id": "codex-mbp2-0193-k-3"
	}
}
```

### An agent recalls inside a work repo

```json
{ "name": "recall_memories", "arguments": { "query": "pnpm workspace lockfile", "token_budget": 2000, "repo": { "remote": "git@github.com:Sequoia-Engineering/web.git" } } }
```

```json
{
	"read_set": ["work", "me"],
	"hits": [
		{ "id": "5b0d…", "profile": "work", "kind": "rule", "name": "Use pnpm in Sequoia repos", "origin": "stated", "revision": 1,
		  "passage": "Run pnpm install and pnpm -w build. npm rewrites pnpm-lock.yaml.", "channels": ["exact", "fts", "vector"], "score": 0.033 },
		{ "id": "a771…", "profile": "work", "kind": "decision", "name": "Pin pnpm 9 in CI", "channels": ["graph"],
		  "via": { "from": "5b0d…", "rel": "relates_to", "basis": "similarity" }, "score": 0.012 },
		{ "id": "88a2…", "profile": "me", "kind": "preference", "name": "Prefers lockfile-preserving installs", "origin": "inferred", "evidence": 3, "score": 0.011 }
	],
	"estimated_tokens": 640, "truncated": false, "lexical_only": false
}
```

### An agent asks why

```json
{ "name": "trace", "arguments": { "from": { "kind": "decision", "name": "Detect sync conflicts in the merge step" }, "mode": "why" } }
```

```json
{
	"chain": [
		{ "from": "Detect sync conflicts in the merge step", "rel": "decided_because", "to": "bettergit#41 rebase drops conflicts",
		  "reason": "Pre-merge detection missed commits rewritten by rebase.", "valid_from": "2026-10-28",
		  "evidence": [{ "kind": "commit", "ref": "git:wrick17/bettergit@9f2c1ab" }] },
		{ "from": "bettergit#41 rebase drops conflicts", "rel": "introduced_by", "to": "git:wrick17/bettergit@51d0e7c",
		  "reason": "The rebase helper rewrote SHAs before the check ran.", "valid_from": "2026-10-20" }
	]
}
```

### The end-of-session hook

**Historical example:** The Claude hook example below describes the v1 design. For current hook output use the `agent-memory install` instructions in the current installer; see [self-host setup](self-host.md). Installation does not enable hooks automatically.

Claude Code and Codex run the same script. It returns in under 100 ms and leaves the work to a detached run.

```jsonc
// ~/.claude/settings.json
{ "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.agent-memory/bin/agent-memory hook claude-code" }] }],
             "PreCompact": [{ "hooks": [{ "type": "command", "command": "~/.agent-memory/bin/agent-memory hook claude-code" }] }] } }
```

```toml
# ~/.codex/config.toml
[[hooks.SessionEnd]]
[[hooks.SessionEnd.hooks]]
type = "command"
command = "~/.agent-memory/bin/agent-memory hook codex"
timeout = 3
```

The detached run uploads one bundle per session with a job-scoped device token:

```http
POST /v1/ingest HTTP/1.1
Authorization: Bearer am_job_…
Content-Type: application/json

{ "request_id": "bundle:codex:thr_123:9f2c1ab", "repo": { "remote": "git@github.com:Sequoia-Engineering/web.git" },
  "digest": { "session": "thr_123", "client": "codex", "done": ["…"], "decisions": ["…"], "corrections": ["…"], "outcomes": ["…"] },
  "commits": [{ "sha": "9f2c1ab", "author": "pratyush-poddar_seq", "at": "2026-10-28T10:01:00Z", "title": "SEQ-1234 fix token refresh" }],
  "prs": [{ "number": 812, "title": "SEQ-1234 fix token refresh", "state": "open", "author": "pratyush-poddar_seq", "reviewers": ["a-lee"] }],
  "tickets": [{ "key": "SEQ-1234", "type": "Bug", "status": "In Review", "priority": "High", "assignee": "pratyush-poddar_seq" }],
  "marker": { "head": "9f2c1ab", "as_of": "2026-10-28T11:40:00Z" } }
```

### The daily maintenance batch

```json
{ "name": "maintenance_next", "arguments": { "profile": "work", "limit": 20 } }
```

```json
{ "lease_id": "ls_01J…", "lease_until": "2026-10-28T12:10:00Z",
  "items": [{ "item_id": 4411, "kind": "possible_contradiction", "subjects": ["5b0d…", "77c3…"], "context": { "passages": ["…", "…"] },
              "allowed_ops": ["supersede", "link", "flag", "dismiss"] }] }
```

```json
{ "name": "maintenance_complete", "arguments": { "lease_id": "ls_01J…", "results": [
	{ "item_id": 4411, "ops": [{ "op": "link", "from": "77c3…", "rel": "supersedes", "to": "5b0d…", "reason": "Owner switched the rule to pnpm 9 on 2026-10-27.", "evidence": [{ "kind": "entry", "ref": "c1e9…#640" }] }] }
] } }
```

### The dashboard

```ts
const token = await clerk.session.getToken();
const page = await fetch("/api/profiles/work/nodes/by-key/github:Sequoia-Engineering%2Fweb", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
// { node, people: [...], links: { structural: [...], work: [...], reasoning: [...] }, timeline: [...], related: [...] }
await fetch("/api/profiles/work/activity/8812/undo", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
// 200 { undone: 8812, by: 8840 } or 409 { error: { code: "revision_conflict" } }
```

## 3. System overview

```mermaid
flowchart LR
	subgraph Machines["Owner machines"]
		CC["Claude Code"]
		CX["Codex"]
		T3["T3 Code (drives both)"]
		HK["agent-memory hook + detached run"]
		BR["Browser (dashboard)"]
	end
	subgraph Clerk["Clerk (Agent Memory app)"]
		AS["OAuth authorization server"]
	end
	subgraph CF["Cloudflare account"]
		W["Worker: auth, routing, MCP, REST, static assets"]
		ACC["AccountStore DO (one per user)"]
		PME["ProfileStore DO: me"]
		PWK["ProfileStore DO: work"]
		PPS["ProfileStore DO: personal"]
		COR["CorpusStore DO per profile (Paid)"]
		AI["Workers AI binding (embeddings)"]
		R2["R2: encrypted nightly exports"]
	end
	CC -->|"OAuth login"| AS
	CX -->|"OAuth login"| AS
	BR -->|"Clerk sign-in"| AS
	CC -->|"MCP /mcp (JWT)"| W
	CX -->|"MCP /mcp (JWT)"| W
	HK -->|"/v1/ingest, maintenance (job token)"| W
	BR -->|"/api (session JWT)"| W
	W --> ACC
	W --> PME
	W --> PWK
	W --> PPS
	W --> COR
	PWK --> AI
	PPS --> AI
	PME --> AI
	PWK --> R2
	PPS --> R2
	PME --> R2
```

Clients talk to Clerk for login and to the Worker for everything else. The Worker never calls Clerk: it verifies tokens with a pinned key. Arrows into Workers AI and R2 are bindings inside Cloudflare, not internet calls.

| Component | Owns | Does not do |
|---|---|---|
| Worker (`src/worker.ts` and friends) | Token verification, `Caller` construction, routing decision, MCP and REST parsing, fan-out to at most two profiles, cross-profile RRF merge, token-budget packing, static dashboard | Hold state between requests. Call anything outside Cloudflare. |
| `AccountStore` DO (`idFromName(userId)`) | Devices and token hashes, routing rules, profile registry (profile name to object name), migration review list, daily counters (embedding neurons, rows-written estimate), cached sensitive-terms list | Hold memory content |
| `ProfileStore` DO (`idFromName("<userId>:<profile>:<generation>")`) | Every node, text chunk, edge, evidence row, revision, request, vector, capture, activity row, archive row, maintenance item and repo marker of one profile. Its own alarm for indexing, housekeeping and export. | Read another profile, except that writes into `me` arrive through the Worker |
| `CorpusStore` DO (Paid module) | Bulk-loaded corpus tables and their FTS index, per profile | Run on Free |
| Workers AI `AI` binding | Embeddings only | Generate text |
| R2 bucket `agent-memory-backups` | Encrypted nightly exports, two kept per profile | Hold plaintext |
| Clerk "Agent Memory" app | OAuth authorization server, dashboard sign-in, sign-ups disabled | See memory data |
| Hook and detached run (local) | Digest building, local redaction, uploads from local git, `gh` and the Jira connector, checkout scanners, daily maintenance batch with `codex exec` | Stay resident. Run between sessions. |

No Queues, Workflows, KV, Vectorize or Cron fan-out are needed. One Cron Trigger (`30 20 * * *` UTC, 02:00 IST) calls `tick("nightly")` on every profile so housekeeping and export run even on days with no writes. Everything else runs on each object's own alarm.

### Module map

```text
src/
	worker.ts            fetch(): /mcp, /v1/*, /api/*, /.well-known/*, static assets. scheduled(): nightly tick.
	auth.ts              Principal from a Clerk JWT (pinned key) or a device token. No network.
	routing.ts           Pure routeWrite() and readSet().
	mcp.ts               Tool table (zod schemas built once at module scope), tools/list filtered by scope,
	                     arguments to WriteCommand or ReadQuery, fan-out, mergeRecall(), packing.
	api.ts               Dashboard REST and /v1/ingest, /v1/import. Builds the same commands as mcp.ts.
	domain/
		types.ts           Shared types and the ontology (one list; schemas and CHECKs derive from it).
		ids.ts             stableMemoryId(), nodeKey normalization, UUID5.
		redact.ts          Port of memory_privacy.py.
		extract.ts         Deterministic identifier extractors (pure).
	account/store.ts     AccountStore DO (interface). Internals in account/*.ts.
	profile/store.ts     ProfileStore DO: write(), read(), tick(), alarm() (interface).
	profile/schema.ts    DDL, triggers, schema migrations.
	profile/write.ts     The one write path: idempotency, revisions, chunks, edges, evidence, protection, activity, archive.
	profile/read.ts      get, recall channels, graph expansion, explore, trace, timeline, board, sql.
	profile/index.ts     Alarm stages: embeddings, similarity edges, maintenance queue, exact dedupe.
	profile/keep.ts      Alarm stages: TTL, purge, size caps, nightly export, restore load.
	corpus/store.ts      CorpusStore DO (Paid).
dashboard/             Static app (Workers Static Assets).
local/
	agent-memory         Node single-file CLI: hook, run, install, migrate, restore, corpus-upload.
	scanners/            Deterministic checkout scanners (phase 6).
	schemas/             JSON Schemas for codex exec outputs (maintenance ops, distillation records).
```

An ESLint `no-restricted-imports` rule makes `profile/*` and `account/*` internals unreachable from outside their folders, and bans `fetch(` to anything but bindings in `src/`. A tool call crosses three files: `mcp.ts`, `profile/store.ts`, then `profile/write.ts` or `profile/read.ts`.

## 4. Knowledge model

The knowledge model is the centre of the storage design. Everything the server stores is a node or an edge in one typed graph per profile. Memories (rules, preferences, decisions, documents, journals) and entities (projects, people, bugs, tickets and the rest) share one `nodes` table, so one traversal covers both. The server stores, indexes and retrieves the graph. Agents supply judgment and reasons through MCP.

### Core ontology

One list in `src/domain/types.ts` defines the ontology. The zod schemas, the SQL `CHECK` constraints and the dashboard legend are generated from it, so adding a kind is one edit and a mismatch fails the build.

| Node kind | Holds | Key form (when the thing has an identifier) | BothQ type |
|---|---|---|---|
| `project` | A repo or product | `github:Sequoia-Engineering/web` | |
| `component` | Module, package, service or API endpoint | `pkg:@seq/auth`, `api:POST /v2/token` | |
| `person` | Name, handles, role, what they worked on | `person:github:a-lee` | |
| `bug`, `feature`, `ticket` | Tracker items. Jira type Bug maps to `bug`, Story and Epic to `feature`, the rest to `ticket` | `jira:SEQ-1234`, `github:wrick17/bettergit#41` | |
| `pr` | Pull request | `github:Sequoia-Engineering/web#812` | |
| `commit` | Commit | `git:Sequoia-Engineering/web@9f2c1ab` | |
| `release` | Release or tag | `release:Sequoia-Engineering/web@v4.2.0` | |
| `decision` | A choice and its reason | | `project` |
| `rule` | Guidance the owner or an agent set | | `feedback` |
| `preference` | The model of the owner, stated or inferred | | `user` |
| `session` | One agent session, with its digest | `session:codex:thr_123` | |
| `journal` | Rolling task journal | | `project` |
| `document` | Reference notes, routines with steps, reviews | | `reference` or `procedural` |
| `other` | Anything else, with `other_label`. The dashboard counts labels so a frequent one can be promoted to a kind. | | |

| Class | Relations | Typical endpoints |
|---|---|---|
| Structural | `works_on`, `authored`, `reviewed`, `reported`, `assigned`, `part_of`, `depends_on` | person to project, person to commit or pr, component part_of project, component depends_on component |
| Work | `implements`, `fixes`, `introduced_by`, `caused_by`, `blocked_by` | commit or pr implements feature or ticket, pr fixes bug, bug introduced_by commit |
| Reasoning | `decided_because`, `supersedes`, `contradicts` | decision decided_because bug, rule supersedes rule |
| Weak | `relates_to` | anything |
| Escape | `other` with `other_label` | anything |

`src/domain/types.ts` also holds a short endpoint table per relation (for example `reviewed` is person to pr). A write that breaks it fails with `validation` and names the allowed kinds, or the agent uses `other`.

### Every edge says how it was made

| `basis` | Made by | Reason and evidence |
|---|---|---|
| `identifier` | The server, from ids in text or uploaded fields | Optional. Evidence points at the text or upload row the id came from. |
| `similarity` | The server, from embeddings (cosine at least 0.85, at most 5 per node, recomputed when a card changes) | None. `score` holds the cosine. |
| `judgment` | An agent through MCP, or the migration distillation | Required: a reason of 8 to 600 characters and at least one evidence pointer. |

A `decision` node also requires `why` and at least one evidence pointer. "Why is X like this?" is a walk over `decided_because`, `caused_by`, `introduced_by`, `blocked_by` and `supersedes` that returns each reason with its evidence (section 11).

### Time

Nodes and edges carry four timestamps:

- `valid_from` and `valid_to` are domain time: when the fact was true.
- `recorded_at` is when the server stored it.
- `ended_at` is when the server stopped treating it as current, because it was superseded, retired or contradicted.

Superseding never overwrites. The old node or edge gets `valid_to` and `ended_at`, a `supersedes` edge points from new to old, and both stay queryable. Every read accepts `as_of` (valid time). "Why did we do X in March" runs the why-walk with `as_of: "2026-03-15"`.

### People

A `person` node holds `name`, `handles` (`github`, `jira`), `role` and links to what they worked on. The ingest path drops email addresses, phone numbers and any other personal field before storage. `works_on` edges from commits are aggregates: `weight` counts commits, and `valid_from` and `valid_to` hold the first and last seen dates. Work colleagues exist only in `work`: the `me` write guard rejects any `person` node except the owner's own.

### Files are evidence, not nodes

The corpus has 44k frontend files and 1.7M commit paths. Files appear only as `evidence` rows (`file:Sequoia-Engineering/web:src/auth/token.ts#L40`) and as `attrs.paths` on components. The `evidence_ref` index answers "which decisions and bugs cite this file" without a file node.

### How the graph gets populated

| Source | Who | What it creates |
|---|---|---|
| Uploaded commits, PRs, tickets, sessions | Server, deterministic, at write time | `authored`, `reviewed`, `assigned`, `reported`, `part_of`; `implements` or `fixes` when a ticket key appears in a commit or PR title, branch or body (`fixes` when the ticket is a bug); `blocked_by` from uploaded Jira links; aggregated `works_on` |
| Ids inside any text (journal entries, rules, digests) | Server, deterministic, at write time | `relates_to` or `part_of` with basis `identifier` to repos, tickets, PRs, commits, people and sessions it can resolve; file evidence rows |
| Embeddings | Server, alarm step | `relates_to` with basis `similarity` |
| Agents during work | Inline MCP calls | Judgment edges with reasons, decisions, bugs, features, components |
| Daily maintenance batch | Local `codex exec` through MCP | Judgment edges for unlinked records, contradictions, supersessions, inferred preferences, journal compactions |
| One-time migration | Local Codex distillation | Nodes, judgment edges with reasons and evidence, routing |

Time adjacency is computed at read time from timestamps, not stored as edges.

## 5. Storage

### Why a Durable Object per profile

A `ProfileStore` object is addressed by `idFromName("<userId>:<profile>:<generation>")`. It is single-threaded, so every write runs in one `ctx.storage.transactionSync` with real read-check-write semantics. `expected_revision`, `request_id` replay and supersession need no retry loop and no compare-and-swap trick. A new profile is a new name in the `AccountStore` registry, not a new binding and a deploy. Point-in-time restore covers 30 days per object. Section 20 compares this with the D1 candidate.

### Isolation

- Each profile is a separate object with its own SQLite database. No query can join two profiles.
- The Worker builds every cross-profile read from one type, `ReadSet = { primary: ProfileName; withMe: boolean }`. It cannot express "work plus personal".
- Edges carry `dst_profile`, which is `''` (same profile) or `'me'`. A work decision may point at a preference in `me`. A node in `me` never points out of `me`.
- Device tokens list the profiles they may touch. A token from the work laptop can be limited to `work` and `me`.
- The owner's dashboard shows each profile separately and never merges `work` and `personal` results into one list.

### Reading `me` from other profiles

For a read routed to `work`, the Worker calls `work.read(q)` and `me.read(q)` in parallel, then merges the ranked lists with a second RRF pass. For `me` itself, `withMe` is false. Writes into `me` go through a deterministic guard in the Worker: no `person` node other than the owner, and no text containing a sensitive term. `AccountStore` derives sensitive terms each night from the `work` profile: org names from routing rules, project keys, Jira project keys and colleague names and handles. A blocked write returns `me_sensitive_term` with the matched term, and the agent saves the record in `work` instead.

### Type sketch

```ts
// src/domain/types.ts
export const NODE_KINDS = ["project", "component", "person", "bug", "feature", "ticket", "pr", "commit", "release",
	"decision", "rule", "preference", "session", "journal", "document", "other"] as const;
export const RELATIONS = ["works_on", "authored", "reviewed", "reported", "assigned", "part_of", "depends_on",
	"implements", "fixes", "introduced_by", "caused_by", "blocked_by", "decided_because", "supersedes", "contradicts",
	"relates_to", "other"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type Rel = (typeof RELATIONS)[number];
export type Basis = "identifier" | "similarity" | "judgment";
export type Origin = "stated" | "agent" | "inferred" | "import" | "upload" | "index";
export type Status = "active" | "retired" | "superseded" | "candidate" | "dismissed";
export type MemoryType = "feedback" | "project" | "reference" | "user" | "procedural";
export type ProfileName = string & { readonly __brand: "ProfileName" };
export type NodeId = string & { readonly __brand: "NodeId" }; // UUID5, assigned once, never recomputed

/** Memory kinds keep BothQ identity: unique (scope, memoryType, normName) while active. */
export const MEMORY_KINDS = ["decision", "rule", "preference", "journal", "document"] as const satisfies readonly NodeKind[];

export interface Evidence { kind: "entry" | "commit" | "pr" | "ticket" | "session" | "file" | "node" | "url" | "corpus"; ref: string; note?: string }
export type NodeRef = { id: NodeId } | { kind: NodeKind; key: string } | { kind: NodeKind; name: string; scope?: string } | { ref: `$${number}` };

export interface Node {
	id: NodeId; profile: ProfileName; kind: NodeKind; otherLabel?: string; key?: string;
	memoryType?: MemoryType; scope: string; name: string; summary: string;
	why?: string; howToApply?: string; objective?: string; steps?: Step[];
	attrs: Record<string, string | number | boolean | null | string[]>;
	status: Status; origin: Origin; pinned: boolean; flagged?: string;
	revision: number; validFrom?: string; validTo?: string; recordedAt: string; endedAt?: string;
}
export interface Edge {
	id: number; src: NodeId; rel: Rel; otherLabel?: string; dst: NodeId; dstProfile: "" | "me";
	basis: Basis; reason?: string; score?: number; weight: number; evidence: Evidence[];
	validFrom?: string; validTo?: string; recordedAt: string; endedAt?: string;
}
export interface Step { order: number; action: string; success_criteria: string }

/** Every mutation from every source. ProfileStore.write is the only path to storage. */
export type WriteCommand =
	| { op: "save"; target?: NodeRef; kind: NodeKind; memoryType?: MemoryType; name: string; summary?: string; content?: string;
	    why?: string; howToApply?: string; objective?: string; steps?: Step[]; scope?: string; newName?: string; origin: Origin;
	    attrs?: Node["attrs"]; retire?: boolean; supersedes?: NodeId[]; links?: LinkInput[];
	    compact?: { throughSeq: number; summary: string }; expectedRevision?: number; requestId?: string }
	| { op: "append"; target: NodeRef; content: string; separator?: string; expectedRevision?: number; requestId: string }
	| { op: "knowledge"; nodes: NodeInput[]; edges: LinkInput[]; end?: { edge: number; validTo: string; reason: string }[]; requestId?: string }
	| { op: "ingest"; bundle: IngestBundle; requestId: string }
	| { op: "capture"; kind: "observation" | "correction"; content: string; name?: string; source: Record<string, string>; requestId?: string }
	| { op: "candidate"; candidate: NodeId; action: "promote" | "dismiss"; into?: NodeInput; reason?: string; requestId?: string }
	| { op: "maintenance"; leaseId: string; itemId: number; ops: MaintenanceOp[] }
	| { op: "owner"; action: "pin" | "unpin" | "forget" | "unflag"; node: NodeId; requestId?: string }
	| { op: "undo"; activityId: number }
	| { op: "restore"; archiveIds: number[] };

export interface LinkInput { from: NodeRef; rel: Rel; otherLabel?: string; to: NodeRef & { profile?: "me" }; reason?: string; evidence?: Evidence[]; validFrom?: string; validTo?: string }
export type NodeInput = Omit<Partial<Node>, "id" | "profile" | "revision" | "recordedAt"> & { kind: NodeKind; name: string };

export interface WriteContext { actor: "agent" | "hook" | "owner" | "index" | "keep" | "maintenance" | "migration"; deviceId?: string; routedBy: string; session?: string }
export interface WriteResult { id?: NodeId; profile: ProfileName; revision?: number; entrySeq?: number; action: string; activityId: number; created?: NodeId[] }

export type ReadQuery =
	| { kind: "get"; target: NodeRef; history?: { limit: number; beforeRevision?: number }; entries?: { tail: number; beforeSeq?: number } }
	| { kind: "recall"; query: string; vector?: Int8Array; kinds?: NodeKind[]; scope?: string; asOf?: string; includeCaptures: boolean; includeHistory: boolean; expand: boolean; limit: number }
	| { kind: "explore"; target: NodeRef; depth: 1 | 2; rels?: Rel[]; asOf?: string; limit: number }
	| { kind: "trace"; from: NodeRef; to?: NodeRef; mode: "why" | "path"; asOf?: string; maxDepth: 2 | 3 | 4 }
	| { kind: "timeline"; from: string; to: string; target?: NodeRef; limit: number }
	| { kind: "board"; asOf?: string }
	| { kind: "sql"; sql: string; params: (string | number | null)[] }
	| { kind: "maintenance_next"; kinds?: MaintenanceKind[]; limit: number; leaseSeconds: number }
	| { kind: "stats" } | { kind: "activity"; beforeId?: number; limit: number } | { kind: "archive"; limit: number }
	| { kind: "markers"; repo: string } | { kind: "sensitive_terms" };

/** Errors are values. Thrown errors lose their fields across Durable Object RPC. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };
export type ErrorCode = "not_found" | "ambiguous" | "revision_conflict" | "idempotency_mismatch" | "already_exists" | "validation"
	| "protected" | "forbidden" | "route_required" | "me_sensitive_term" | "size_budget" | "lease_expired";

/** The only cross-profile read shape. */
export interface ReadSet { primary: ProfileName; withMe: boolean }
```

```ts
// src/profile/store.ts
export class ProfileStore extends DurableObject<Env> {
	/** One transactionSync per call. Order: redact, replay or reject by request_id, resolve identity, check expected_revision,
	 *  check protection, apply, extract identifier links, write revision or entry, write activity with its inverse command,
	 *  store the request result, mark embedding due, arm the alarm. Never awaits I/O inside the transaction. */
	async write(cmd: WriteCommand, ctx: WriteContext): Promise<Outcome<WriteResult>> { throw new Error("not implemented"); }
	/** All reads. SQL plus in-memory ranking. Vectors stay in object memory after the first load. */
	async read<Q extends ReadQuery>(q: Q): Promise<Outcome<ReadResultFor<Q>>> { throw new Error("not implemented"); }
	/** Nightly cron entry. Arms the alarm and schedules housekeeping and export. Idempotent. */
	async tick(reason: "nightly" | "config"): Promise<void> { throw new Error("not implemented"); }
	/** Runs one bounded step of the most overdue stage (under about 5 ms CPU), then re-arms. Steps write through write(). */
	async alarm(): Promise<void> { throw new Error("not implemented"); }
}

// src/account/store.ts
export class AccountStore extends DurableObject<Env> {
	/** Principal to Caller. Rejects revoked tokens and any Clerk user except OWNER_USER_ID. Updates last_used_at at most hourly. */
	async caller(p: Principal, deviceHeader?: string): Promise<Outcome<Caller>> { throw new Error("not implemented"); }
	/** Owner-only: devices (create returns the token once), routing rules, profiles, review list, restore switch. */
	async admin(cmd: AccountCommand): Promise<Outcome<AccountResult>> { throw new Error("not implemented"); }
	/** Daily counters: embedding neurons and rows written. Returns whether background stages may proceed. */
	async meter(m: { day: string; neurons?: number; rowsWritten?: number }): Promise<{ embed: boolean; background: boolean }> { throw new Error("not implemented"); }
}

// src/routing.ts (pure)
export function routeWrite(caller: Caller, input: { profile?: string; repo?: RepoRef; kind: NodeKind; origin: Origin; text: string }): Outcome<{ profile: ProfileName; routedBy: string }> { throw new Error("not implemented"); }
export function readSet(caller: Caller, input: { profile?: string; repo?: RepoRef; includeMe?: boolean }): Outcome<ReadSet> { throw new Error("not implemented"); }
```

### Per-profile schema

```sql
-- profile/schema.ts, version 1. Every table lives inside one ProfileStore object.
CREATE TABLE profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID; -- user_id, profile, generation, schema_version

CREATE TABLE nodes (
	id TEXT PRIMARY KEY,                      -- UUID5. Memories: scope:memory_type:norm_name (BothQ). Entities: kind:key or kind:scope:norm_name.
	kind TEXT NOT NULL,                       -- CHECK generated from NODE_KINDS
	other_label TEXT,
	key TEXT,                                 -- canonical identifier, for example jira:SEQ-1234
	memory_type TEXT,                         -- BothQ type, set for memory kinds only
	scope TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL, norm_name TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',         -- BothQ description
	why TEXT, how_to_apply TEXT, objective TEXT,
	steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
	attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
	status TEXT NOT NULL CHECK (status IN ('active','retired','superseded','candidate','dismissed')),
	origin TEXT NOT NULL CHECK (origin IN ('stated','agent','inferred','import','upload','index')),
	pinned INTEGER NOT NULL DEFAULT 0,
	flagged TEXT,                             -- why housekeeping or maintenance wanted to change a protected node
	revision INTEGER NOT NULL DEFAULT 1,
	chars INTEGER NOT NULL DEFAULT 0,
	content_hash TEXT NOT NULL,               -- exact dedupe and request hashing
	card_hash TEXT NOT NULL, embed_hash TEXT, -- card_hash differs from embed_hash: embedding due
	valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, ended_at TEXT,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
	CHECK (kind <> 'other' OR other_label IS NOT NULL),
	CHECK (memory_type IS NOT 'procedural' OR (objective IS NOT NULL AND steps IS NOT NULL)),
	CHECK (kind <> 'decision' OR why IS NOT NULL)
);
CREATE UNIQUE INDEX nodes_key ON nodes (key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX nodes_memory_identity ON nodes (scope, memory_type, norm_name) WHERE memory_type IS NOT NULL AND status IN ('active','candidate');
CREATE INDEX nodes_kind ON nodes (kind, status, updated_at);
CREATE INDEX nodes_embed_due ON nodes (id) WHERE embed_hash IS NOT card_hash AND status = 'active';

-- Text in chunks of at most 16k characters. head: name, summary, why, how_to_apply, rendered steps.
-- body: saved content. entry: one append (the delta revision). summary: compaction output. digest: session capture text.
CREATE TABLE texts (
	rowid INTEGER PRIMARY KEY,
	node_id TEXT NOT NULL,
	part TEXT NOT NULL CHECK (part IN ('head','body','entry','summary','digest')),
	revision INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, chunk INTEGER NOT NULL DEFAULT 0,
	body TEXT NOT NULL CHECK (length(body) <= 16000),
	separator TEXT, request_id TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL,
	live INTEGER NOT NULL DEFAULT 1,          -- 0 once folded, compacted or archived
	lane TEXT NOT NULL DEFAULT 'recall' CHECK (lane IN ('recall','capture'))  -- capture: candidates and digests
);
CREATE INDEX texts_node ON texts (node_id, part, seq, chunk);
CREATE VIRTUAL TABLE texts_fts USING fts5 (body, content='texts', content_rowid='rowid', tokenize="porter unicode61 remove_diacritics 2 tokenchars '-_./#@:'");
CREATE VIRTUAL TABLE texts_tri USING fts5 (body, content='texts', content_rowid='rowid', tokenize='trigram');
CREATE VIRTUAL TABLE captures_fts USING fts5 (body, content='texts', content_rowid='rowid', tokenize='porter unicode61');
-- Triggers keep texts_fts and texts_tri equal to {live = 1 AND lane = 'recall'} and captures_fts equal to
-- {live = 1 AND lane = 'capture'}. Body text never changes in place; live and lane transitions issue FTS 'delete' commands.

CREATE TABLE edges (
	id INTEGER PRIMARY KEY,
	src TEXT NOT NULL, rel TEXT NOT NULL, other_label TEXT,
	dst TEXT NOT NULL, dst_profile TEXT NOT NULL DEFAULT '' CHECK (dst_profile IN ('','me')),
	basis TEXT NOT NULL CHECK (basis IN ('identifier','similarity','judgment')),
	reason TEXT, score REAL, weight INTEGER NOT NULL DEFAULT 1,
	valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, ended_at TEXT,
	actor TEXT NOT NULL, request_id TEXT,
	CHECK (basis <> 'judgment' OR length(reason) BETWEEN 8 AND 600),
	CHECK (rel <> 'other' OR other_label IS NOT NULL)
);
CREATE UNIQUE INDEX edges_current ON edges (src, rel, dst_profile, dst) WHERE ended_at IS NULL;
CREATE INDEX edges_dst ON edges (dst_profile, dst, rel);
CREATE INDEX edges_src_all ON edges (src, rel, recorded_at);

CREATE TABLE evidence (
	owner TEXT NOT NULL,                      -- 'e:<edge id>' or 'n:<node id>'
	kind TEXT NOT NULL, ref TEXT NOT NULL, note TEXT,
	PRIMARY KEY (owner, kind, ref)
) WITHOUT ROWID;
CREATE INDEX evidence_ref ON evidence (kind, ref);

CREATE TABLE revisions (                    -- snapshots only; append revisions are texts rows with part = 'entry'
	node_id TEXT NOT NULL, revision INTEGER NOT NULL,
	op TEXT NOT NULL CHECK (op IN ('saved','updated','retired','superseded','restored','moved','compacted')),
	snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
	request_id TEXT, actor TEXT NOT NULL, device_id TEXT, at TEXT NOT NULL,
	PRIMARY KEY (node_id, revision)
) WITHOUT ROWID;

CREATE TABLE requests (                     -- written in the same transaction as the effect; pruned after 300 days
	request_id TEXT PRIMARY KEY, op TEXT NOT NULL, payload_hash TEXT NOT NULL,
	result TEXT NOT NULL, node_id TEXT, at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE vectors (node_id TEXT PRIMARY KEY, card_hash TEXT NOT NULL, model TEXT NOT NULL, v BLOB NOT NULL) WITHOUT ROWID; -- int8 x 256

CREATE TABLE activity (
	id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, device_id TEXT, stage TEXT,
	op TEXT NOT NULL, summary TEXT NOT NULL, targets TEXT NOT NULL,
	undo TEXT CHECK (undo IS NULL OR json_valid(undo)),   -- the inverse WriteCommand; null for undo rows and purges
	undone_by INTEGER, undo_of INTEGER
);
CREATE INDEX activity_at ON activity (at);

CREATE TABLE archive (                      -- removed rows; restorable until purge_after (300 days)
	id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL, at TEXT NOT NULL, purge_after TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('nodes','texts','edges','evidence','vectors','revisions')),
	payload TEXT NOT NULL                     -- one source row as JSON, at most about 17k characters
);
CREATE INDEX archive_purge ON archive (purge_after);

CREATE TABLE maintenance (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('near_duplicate','possible_contradiction','unlinked','unprocessed_digest','preference_signal','stale_journal','weekly_review')),
	subjects TEXT NOT NULL CHECK (json_valid(subjects)),
	fingerprint TEXT NOT NULL UNIQUE,         -- hash of kind plus subject ids and card hashes; changed records requeue
	state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','leased','done','dismissed','stuck')),
	lease_id TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL, done_at TEXT, outcome TEXT
);
CREATE INDEX maintenance_open ON maintenance (state, kind, created_at);

CREATE TABLE markers (                      -- per repo: last uploaded HEAD, last analysis, as-of dates
	repo TEXT PRIMARY KEY, head TEXT, uploaded_at TEXT, analyzed_at TEXT, analysis_head TEXT
) WITHOUT ROWID;

CREATE TABLE cursors (                      -- alarm stages and daily flags: embed, similar, queue, ttl, purge, dedupe, export, daily_refresh, daily_batch
	stage TEXT PRIMARY KEY, cursor TEXT, due_at INTEGER NOT NULL, last_run_at TEXT, last_error TEXT, stats TEXT
) WITHOUT ROWID;

CREATE VIEW owner_model AS
	SELECT n.id, n.name, n.summary, n.origin, n.pinned, n.revision, n.updated_at,
	       (SELECT count(*) FROM edges e WHERE e.src = n.id AND e.ended_at IS NULL) AS links
	FROM nodes n WHERE n.kind = 'preference' AND n.status = 'active'
	ORDER BY n.origin = 'stated' DESC, n.pinned DESC, n.updated_at DESC;
```

```sql
-- account/schema.ts
CREATE TABLE profiles (name TEXT PRIMARY KEY, object_name TEXT NOT NULL, generation INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('active','restoring','retired')), created_at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, -- null for OAuth machines named by header
	scopes TEXT NOT NULL, profiles TEXT NOT NULL, default_profile TEXT,
	created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT) WITHOUT ROWID;
CREATE TABLE routing_rules (id TEXT PRIMARY KEY, priority INTEGER NOT NULL, match TEXT NOT NULL CHECK (match IN ('remote','path')),
	pattern TEXT NOT NULL, profile TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID;
CREATE TABLE review_list (id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, suggested_profile TEXT, payload TEXT NOT NULL,
	created_at TEXT NOT NULL, resolved_profile TEXT, resolved_at TEXT) WITHOUT ROWID;
CREATE TABLE counters (day TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, name)) WITHOUT ROWID;
CREATE TABLE sensitive_terms (term TEXT PRIMARY KEY, source TEXT NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID;
```

### Journals are entry chunks

A journal is a `journal` node. Each append inserts one `texts` row with `part = 'entry'` and the next `seq`. That row is the append revision, so journal content has one source of truth. FTS5 tokenizes only the new entry, and the head row is untouched, so an append costs the same on a 987k-character journal as on an empty one. `get_memory` returns the head, the latest summary and the newest entries within a token budget, with a cursor for older entries. Compaction (by an agent) writes a `summary` chunk and a `compacted` revision, and moves the folded entries to the archive.

### Write amplification

Estimates per operation with one-chunk text. Index entries and FTS5 shadow rows count as rows written. Phase 1 measures them with the SQL cursor's `rowsWritten`.

| Operation | Rows written | Breakdown |
|---:|---:|---|
| `append_memory` | about 19 | entry row and index 2, two FTS inserts about 7, node row and index 2, request 1, activity 2, about one identifier edge with evidence 5 |
| `save_memory`, new rule | about 35 | node and 3 indexes 4, head and body chunks 4, FTS about 14, revision 1, request 1, activity 2, two edges with evidence 9 |
| `save_memory`, content replaced | about 30 | old body leaves FTS about 7, new body about 9, node 2, revision 1, request 1, activity 2, edges about 8 |
| Session digest | about 50 | session node, digest chunk, captures FTS, about 5 identifier edges with evidence |
| Uploaded commit, kept | about 16 | node and indexes, head and FTS, `authored`, `part_of`, `implements` |
| Uploaded commit, aggregated | about 3 | `works_on` weight and dates updated |
| Embedding one card plus similarity edges | about 18 | vector 1, node 2, up to 5 edges at 3 rows each |
| Agent compaction of a 664-entry journal | about 6,000 once | entries leave FTS and move to archive, summary chunk, revision |

## 6. Size and row budgets

### Per-object size

Sizing for the busiest profile, `work`, after one year at measured volume (about 103 writes and 42 sessions a day, about 60% of activity in work, about 300 uploaded commits a day of which about 30% carry a ticket or PR link).

| Table | Rows after year 1 | Size |
|---|---:|---:|
| `nodes` (about 4.4k memories, 15k sessions, 30k kept commits, 3k PRs, 3k tracker items, 1k people, 2k components) | about 60k | about 35 MB |
| `texts` live and archived (about 25M characters a year) | about 45k chunks | about 30 MB |
| `texts_fts` and `texts_tri` | | about 90 MB (trigram is about 3x the text) |
| `captures_fts` (90-day window) | | about 5 MB |
| `edges` and two indexes (about 5 per node) | about 250k | about 65 MB |
| `evidence` | about 150k | about 20 MB |
| `revisions` snapshots | about 25k | about 30 MB |
| `vectors` (memory cards and described entities only) | about 5k | about 1.5 MB |
| `activity` (kept 400 days) | about 70k | about 25 MB |
| `archive`, `requests`, `maintenance`, `markers`, `cursors` | | about 40 MB |
| Total | | about 340 MB, growing about 300 MB a year |

`personal` grows about 100 MB a year and `me` under 20 MB. The migration adds about 60 MB across profiles.

| Limit | Free | Paid | Fit |
|---|---|---|---|
| Per object | 1 GB design limit (the FAQ says 1 GB on Free; the limits table says 10 GB) | 10 GB | `work` reaches 70% of 1 GB after about two years on Free; decades on Paid |
| Per account | 5 GB | Unlimited | Three profiles use under 0.5 GB in year 1 |
| Row or blob | 2 MB | 2 MB | Largest row is a 16k-character chunk or an archived row of about 17k characters |
| SQL statement, bound parameters | 100 KB, 100 | same | Chunks cap bound text at 16k characters; batch inserts stay under 100 parameters |

Size caps run in the write path, so they hold whatever the source:

- Note content up to 64k characters (chunked at 16k), an append up to 100k characters (the BothQ limit, chunked), a capture or digest up to 32 KB, an upload bundle up to 1 MB.
- At 70% of the object limit the profile refuses aggregated commit uploads and corpus-adjacent uploads with `size_budget` and the dashboard shows the warning. Memories and journals are still accepted.
- At 90% the profile accepts only retire, compaction, forget and undo, so agents can shrink it.

### Rows written per day

Durable Object rows written are counted per account: 100k a day on Free. Each `ProfileStore` reports `rowsWritten` from its cursors to `AccountStore.meter()` once per alarm step. Background stages (similarity edges, queue computation, dedupe, purge) pause when the account's day passes 80k, so agent writes keep the remaining room. Agent writes are never deferred. Section 17 has the daily totals.

## 7. MCP tools

Thirteen tools for interactive agents (twelve on Free, since `corpus` is Paid-only) and two for the job-scoped token, down from BothQ's 52. `tools/list` is filtered by the caller's scopes, so an interactive agent never sees the maintenance tools and the job token sees only those. Every tool accepts `profile` (explicit override) and `repo` (`{remote, path}`). Reads accept `as_of`. Write results always include `profile`, `routed_by`, `action` and `activity_id`.

### Memory tools (BothQ port)

| Tool | Input | Output | Contract |
|---|---|---|---|
| `save_memory` | `kind`, `type` (BothQ type), `name`, optional `memory_id` or identity, `summary` (BothQ `description`), `content`, `why`, `how_to_apply`, `scope`, `new_name`, `objective`, `steps`, `origin` (`stated` or `agent`), `retire`, `supersedes`, `links`, `compact`, `expected_revision`, `request_id` | `memory_id`, `revision`, `action` (`created`, `updated`, `retired`, `replayed`), `superseded[]` | No identity: create, or `already_exists` if the active identity is taken and `expected_revision` is absent. With identity: update, rename (id kept), scope move, profile move, retire or supersede. Procedural needs `objective` and ordered `steps`. A `decision` needs `why` and one evidence pointer. `compact: {through_seq, summary}` folds journal entries into a summary. |
| `append_memory` | identity, `content` (up to 100k characters), `request_id` (required), `expected_revision`, `separator` | `memory_id`, `revision`, `entry_seq`, `action` | Atomic. Rejected for procedural memories. Without `expected_revision`, concurrent appends from two machines both land, in arrival order. |
| `get_memory` | `memory_id`, key or name, `history {limit, before_revision}`, `entries {tail, before_seq}` | The node, its steps, its current edges with reasons, the history window and `next_before_revision` | Replaces `memory_history`. Content over 32k characters returns head, latest summary and the newest entries with a cursor. Retired records are readable by id. |
| `recall_memories` | `query`, `kinds`, `type`, `scope`, `limit` (1 to 100), `token_budget` (64 to 32,000), `include_captures`, `include_history`, `expand` (default true) | `read_set`, `hits[]` with `passage`, `channels`, `via`, `origin`, `revision`, `estimated_tokens`, `truncated`, `lexical_only` | Section 11. Covers BothQ `find_rule`, `find_routine` and `list_memories` through `kinds` and an empty query. |
| `capture_memory` | `content`, `kind` (`observation` or `correction`), `name`, `source`, `request_id` | `capture_id`, `status: candidate` | Redacted, untrusted, outside ordinary recall. Session digests arrive through `/v1/ingest` and become `session` nodes. |
| `review_candidates` | `action` (`list`, `promote`, `dismiss`), `candidate_id`, `into`, `reason`, `status`, `limit` | candidates, or the promoted memory | Promotion creates or appends the target and links it to the capture in one transaction. |

### Knowledge tools

| Tool | Input | Output | Contract |
|---|---|---|---|
| `record_knowledge` | `nodes[]` (kind, key or name, summary, attrs, valid times), `edges[]` (from, rel, to, reason, evidence, valid times), `end[]` (edge id, `valid_to`, reason), `request_id` | created and matched node ids, edge ids | The one tool agents use to write the graph: ticket and PR context they read, components, people, bugs, decisions and judgment links. Nodes upsert by key. Judgment edges need a reason and evidence. Ending an edge keeps it as history. |
| `explore` | node ref, `depth` (1 or 2), `rels`, `limit`, `as_of` | Entity page: `node`, `people` (who worked on it, with counts and dates), `links` grouped by class with reasons and evidence, `timeline`, `related` memories, `corpus` counts on Paid | "What is connected to X". Follows edges into `me`, never into a sibling profile. |
| `trace` | `from`, optional `to`, `mode` (`why` or `path`), `max_depth` (2 to 4), `as_of` | `chain[]` or up to three `paths[]`, each edge with its reason, evidence and valid times | `why` walks `decided_because`, `caused_by`, `introduced_by`, `blocked_by` and `supersedes`. `path` is a bidirectional breadth-first search over non-similarity edges, then similarity edges if nothing else connects. |
| `timeline` | `from`, `to`, optional node, `kinds`, `limit` | Dated events: entries, revisions, edges recorded or ended, commits, PRs, ticket changes | Merged across the read set by time. |
| `work_board` | `profile`, `as_of` | Ranked tickets, bugs, features and PRs with score reasons, `as_of`, and the latest strategic review with its age | Computed at read time (section 13). Covers only what the owner's machines uploaded. |
| `query_sql` | `sql`, `params`, `profile` | `columns`, `rows` (at most 500), `truncated` | Read-only, one profile per call. |
| `corpus` (Paid) | `action` (`search`, `get`, `sql`), `query`, `key`, `sql`, `profile` | Rows or passages with `as_of` per table | Section 14. |

### Job tools (job-scoped token only)

| Tool | Input | Output | Contract |
|---|---|---|---|
| `maintenance_next` | `profile`, `kinds`, `limit` (up to 40), `lease_seconds` (up to 900) | `lease_id`, `lease_until`, `items[]` with `kind`, `subjects`, `context` (passages, current edges, candidate pairs) and `allowed_ops`; or an empty list with `next_allowed_at` | Leases open items. Returns nothing if this profile already ran a batch in the last 20 hours. An expired lease returns its items to the queue. |
| `maintenance_complete` | `lease_id`, `results[]` of `{item_id, ops[], outcome}` | per item `applied`, `flagged`, `rejected` with reasons | Ops are `save`, `link`, `end_link`, `supersede`, `compact`, `infer_preference`, `flag`, `dismiss`. Each op must stay within its item's subjects. Ops go through the normal write path with actor `maintenance`. Changes to protected nodes become flags. |

`/v1/ingest` (scope `ingest`) takes the session bundle shown in section 2. `GET /v1/markers?repo=` returns the repo marker and the daily-slot flags. Both are REST for shell-friendliness. They build the same `WriteCommand` values the MCP tools build.

### A stateless Streamable HTTP handler

`mcp.ts` uses `createMcpHandler` from the Cloudflare Agents SDK. It creates a server per request with no MCP session and no Durable Object for the transport, which matches the 2026-07-28 revision (no `Mcp-Session-Id`, no `initialize`, version in `_meta`, mandatory `server/discover`). GET and DELETE return 405 because the server sends no notifications. The handler receives `authContext` from `auth.ts`. All cross-request state lives in `AccountStore` and `ProfileStore`, keyed by the authenticated user. Zod schemas are built once at module scope, not per request.

If the phase-1 benchmark shows the SDK costs too much CPU (gate G2), `mcp.ts` swaps the SDK for a hand-written JSON-RPC dispatcher of about 150 lines that handles `server/discover`, `tools/list` and `tools/call` over the same tool table. The tool table is data, so tool names live in one list either way.

## 8. Auth

### Clerk is the authorization server

```mermaid
sequenceDiagram
	participant C as Claude Code or Codex
	participant W as Worker /mcp
	participant K as Clerk (Agent Memory app)
	C->>W: POST /mcp (no token)
	W-->>C: 401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"
	C->>W: GET protected resource metadata
	W-->>C: resource, authorization_servers [Clerk issuer], scopes_supported
	C->>K: authorize (PKCE, CIMD client id, resource=https://memory.wrick17.com/mcp, loopback redirect)
	K-->>C: code (and iss)
	C->>K: token (code, verifier, resource)
	K-->>C: JWT access token (aud = resource), refresh token (offline_access)
	C->>W: POST /mcp Authorization: Bearer JWT
	W->>W: verify RS256 with pinned key, iss, aud, exp, sub = owner
	W-->>C: tool result
```

- `/.well-known/oauth-protected-resource/mcp` (and the root form) returns `{"resource": "https://memory.wrick17.com/mcp", "authorization_servers": ["<Clerk issuer>"], "scopes_supported": ["memory"], "bearer_methods_supported": ["header"], "resource_name": "Agent Memory"}`.
- A 401 carries `WWW-Authenticate: Bearer resource_metadata="…", scope="memory"`. A token without the needed scope gets 403 `insufficient_scope`.
- Clerk app "Agent Memory": OAuth applications on, CIMD on (Claude Code and Codex both use CIMD), DCR off unless the test needs it, JWT access tokens, `offline_access` for refresh, sign-ups off, Clerk on its own frontend-API subdomain of `wrick17.com` (DNS change asked at build time).
- `auth.ts` verifies with WebCrypto against `CLERK_JWT_KEYS` (one or two pinned PEM public keys): algorithm RS256, a known `kid`, `iss` equal to `CLERK_ISSUER`, `aud` containing the resource, `exp` and `nbf` with 60 s skew, and `sub` equal to `OWNER_USER_ID`. There is no JWKS fetch. If Clerk rotates its signing key, verification fails with `unknown_kid`, the 401 body and the dashboard say so, and the owner runs `wrangler secret put CLERK_JWT_KEYS`. Holding two keys lets a planned rotation pass with no gap.
- The dashboard signs in with Clerk JS and sends the Clerk session token as a bearer token. `auth.ts` verifies it with the same keys, checks `azp` against the dashboard origin, and accepts only the owner.

### Phase-1 gate G1: the real-token test

| Test | Pass condition |
|---|---|
| T1 Claude Code login | `claude mcp add --transport http memory https://memory.wrick17.com/mcp`, then `/mcp` login completes. Clerk accepts the loopback redirect on whatever port Claude Code picks. |
| T2 Codex login | `codex mcp login memory` completes, and Codex accepts the `iss` it validates (RFC 9207). |
| T3 Audience | `GET /v1/whoami` (owner only, returns claims without the signature) shows `aud` containing `https://memory.wrick17.com/mcp`, set from the RFC 8707 `resource` parameter. |
| T4 Refresh | After the one-day access-token lifetime, both clients refresh without a new login. |
| T5 Negative | A token from the Postplan Clerk app, a token with another audience, and a token for a non-owner Clerk user are all rejected. |
| T6 Headless | A device token works through Claude Code `headersHelper` and Codex `bearer_token_env_var`. |

All six pass: Clerk as the authorization server is final, and nothing on the server calls Clerk. If T1 or T3 fails, the fallback is `@cloudflare/workers-oauth-provider` running the authorization server on `memory.wrick17.com` in front of Clerk:

- `/authorize` serves a sign-in page with Clerk JS. The page posts the Clerk session token back, the Worker verifies it locally with the pinned key, and calls `completeAuthorization({ userId })`.
- The library issues audience-bound tokens with PKCE and refresh, and stores hashed tokens in a KV namespace (`OAUTH_KV`, a few writes per login or refresh).
- Clients register with DCR, not CIMD, because CIMD would make the Worker fetch client metadata from the internet.
- With that setup the fallback also makes no outbound call. The only allowed exception, used only if local session verification cannot work, is one server-side call to Clerk at login.

### Device tokens

- Format `am_<tag>_<id>_<secret>` with a 32-byte random secret. `AccountStore` stores only the SHA-256 of the secret. The dashboard shows the token once.
- Scopes: `read`, `write` (interactive headless agents), `ingest` and `maintenance` (the job-scoped token used by the hook's detached run), `import` (migration and corpus bulk load). Each token lists its profiles and an optional default profile and expiry.
- Revocation takes effect on the next request, because `AccountStore.caller()` checks every request. No cache sits in front of it.
- On machines, tokens live in the macOS Keychain (`security add-generic-password -s agent-memory`) or a mode-600 file on Linux. Claude Code reads them through `headersHelper`. Codex reads them through `bearer_token_env_var`.

OAuth machines have no token row. They identify themselves with a non-secret `X-Agent-Memory-Device: work-mbp` header, set once in the client's MCP config. The header only selects the device's default profile and the activity label. OAuth callers are the owner and may use every profile.

## 9. Routing

`AccountStore` owns the data (rules, devices, profiles). `routing.ts` owns the decision as one pure function. The Worker calls it once per write, and the profile records the reason in `activity`. Every write response returns `profile` and `routed_by`, so an agent sees a misroute at once.

1. An explicit `profile` argument wins if the caller may use it. Otherwise the call fails with `forbidden`.
2. A `preference` with origin `stated` goes to `me`, unless its text contains a sensitive term.
3. Rules by priority. Remote globs match the normalized remote (`git@github.com:Org/repo.git` and the https form both become `github.com/Org/repo`), then path prefixes. Defaults: `github.com/Sequoia-Engineering/*` to `work`, `github.com/Sequoia-US/*` to `work`, `github.com/wrick17/*` to `personal`, `github.com/pratyush-poddar_seq/*` to `work`.
4. The device's default profile.
5. Otherwise `route_required`, and the error tells the agent to pass `profile`.

Reads use the same order to pick the primary profile, but with no match they read `me` only.

Agents send repo identity on every call: the agent-memory skill tells them to pass `git remote get-url origin` and the working directory, and the hook adds both to every bundle. A memory moves between profiles with `save_memory` and a new `profile`. The source object copies the node, its texts, edges and evidence to the target with request id `move:<id>:<revision>`, then marks its own copy `moved` in a second transaction. A pending move sits in the source's `cursors` until both steps finish, so a crash between them is retried by the alarm and cannot duplicate.

Migrated records that match no rule go to `AccountStore.review_list`, outside every profile, until the owner assigns them in the dashboard. Unrouted data never lands in `me`.

## 10. Capture and the local run

### Hook events (verified 2026-10-28)

| Client | Event | Behavior that matters | Source |
|---|---|---|---|
| Claude Code | `SessionEnd` | Gets `session_id`, `transcript_path`, `cwd`, `reason`. Default budget 1.5 s, raised per hook `timeout` up to 60 s. Cannot block exit. | code.claude.com/docs/en/hooks |
| Claude Code | `PreCompact` | Fires before manual or automatic compaction, with `transcript_path`. Gives long sessions a checkpoint. | same |
| Codex | `SessionEnd` | Gets `session_id`, `transcript_path`, `cwd`. Fires on normal close, on archive or delete of an open thread, and after 30 minutes idle with no client attached, which covers threads that T3 Code keeps open. Always synchronous. Default timeout 600 s. Hooks are on by default (`[features] hooks`). | developers.openai.com/codex/hooks |

Both clients hand the transcript path to the hook. Codex warns that its transcript format is not a stable interface, so the parser is tolerant and falls back to a minimal digest built from the hook input and git facts.

### The hook returns at once

`agent-memory hook <client>` reads the hook JSON from stdin, writes it to `~/.agent-memory/spool/<client>-<session>.json`, starts `agent-memory run` as a detached process (`spawn(..., { detached: true, stdio: "ignore" }).unref()`), and exits 0. It does no network I/O, so it finishes well inside Claude Code's 1.5 s budget and never delays a Codex exit.

### The detached run

One run at a time per machine, guarded by a lock file. A run that finds the lock exits, and the next session end picks up whatever is spooled. Each step has its own time box, and the whole run is killed after 20 minutes. It holds the job-scoped token (`ingest` and `maintenance` for the device's profiles) and nothing else.

```mermaid
flowchart TD
	S["Spooled session(s)"] --> D["1. Build digest from transcript (deterministic, redacted locally)"]
	D --> M{"2. Repo HEAD differs from server marker?"}
	M -->|no| J
	M -->|yes| G["Commits since marker (local git)"]
	G --> P["PR metadata (local gh)"]
	P --> J["3. Jira context for touched tickets (work only, Claude Code Jira connector, read-only)"]
	J --> A{"4. Corpus on and repo not analyzed today?"}
	A -->|yes| X["Scan changed files; codex exec only for judgment tables"]
	A -->|no| U
	X --> U["5. Upload bundle to /v1/ingest (spool on failure)"]
	U --> R{"6. First session end today for this profile?"}
	R -->|yes| F["Daily refresh: assigned Jira tickets, open PRs"]
	F --> Q
	R -->|no| Q{"7. Daily batch due for this profile?"}
	Q -->|yes| B["maintenance_next, codex exec (Luna, Terra), maintenance_complete"]
	Q -->|no| E["Replay spool, exit"]
	B --> E
```

1. **Digest.** A deterministic parser reads the Claude Code JSONL or Codex rollout and builds the digest below. It never sends raw transcript lines or tool output. Local redaction (the same patterns as the server) runs before upload.
2. **Repo delta.** `GET /v1/markers?repo=` returns the last uploaded HEAD. If HEAD moved, the run collects `git log <marker>..HEAD --no-merges` (sha, author name, author time, subject, trailers; paths only when the corpus is on) and PRs updated since the marker date with `gh pr list --state all --search "updated:>=<date>" --json …`. It uses the GitHub account that the owner's `github-accounts` mapping assigns to the repo owner. If the marker is not an ancestor of HEAD (rebase or force push), it sends the last 200 commits and the server upserts them by key. Teammates' commits arrive after the owner pulls them.
3. **Jira context (work only).** Ticket keys come from the digest, branch name, commits and PR titles. Per the owner's `jira-connector` rule, only the `~/.claude` work account reaches Jira, so the run calls Claude Code headless on that account with Sonnet, read-only Jira tools, and a fixed prompt that returns JSON for at most 20 tickets (summary, type, status, priority, assignee, reporter, links, due date, sprint, updated). The run validates the JSON against a schema before upload.
4. **Checkout analyses (Paid corpus only).** Debounced to once per repo per day. Section 14.
5. **Upload.** One bundle per session with `request_id = bundle:<client>:<session>:<head>`. On any failure the bundle stays in the spool (at most 1,000 files or 64 MiB, the BothQ bounds) and replays on the next run. Replays are idempotent.
6. **Daily refresh (default on).** On the first session end of the UTC day for a profile, on a machine that has the credentials, the run uploads assigned open Jira tickets (work) and open PRs authored by or awaiting review from the owner (`gh search prs --author @me` and `--review-requested @me`, scoped to the profile's orgs). The server marks the profile's `daily_refresh` slot atomically, so two machines never both run it. `daily_refresh = false` in `~/.agent-memory/config.toml` turns it off.
7. **Daily maintenance batch.** Section 12.

The run exits when the steps finish. Nothing stays resident, and no launchd job exists.

### Digest shape

```json
{
	"session": "thr_123", "client": "codex", "client_version": "0.98.0", "model": "gpt-6.1-terra",
	"started_at": "2026-10-28T09:12:00Z", "ended_at": "2026-10-28T11:40:00Z",
	"repo": { "remote": "github.com/Sequoia-Engineering/web", "branch": "feat/token-refresh", "head_before": "51d0e7c", "head_after": "9f2c1ab" },
	"asked": ["Owner prompts, first 500 characters each, at most 20"],
	"done": ["Final assistant message of each turn, first 800 characters, at most 20"],
	"decisions": ["Assistant sentences with decision markers: decided, chose, going with, instead of"],
	"corrections": ["Owner messages with correction markers: don't, never, always, stop, instead, I prefer, that's wrong"],
	"outcomes": { "commits": ["9f2c1ab"], "prs": [812], "tests": ["pnpm test: 214 passed"], "files_changed": 12 },
	"tickets": ["SEQ-1234"], "tools": { "Bash": 31, "Edit": 12 }
}
```

The digest is capped at 32 KB after redaction. The server stores it as the `digest` text of a `session` node, in the capture lane, so it never appears in ordinary recall. The server links the session to its project, branch, commits, PRs and tickets by identifier.

Capture must record at least as much as Codex memory generation does today. The digest keeps every owner prompt and final answer that Codex's extractor reads, and two agent passes turn it into memory: the inline consolidation at task end and the daily batch's `unprocessed_digest` items. Phase 2 checks parity on ten real sessions (section 22).

### Agent-side instruction changes

- A new `agent-memory` skill replaces `bothq-memory`. Start of task: `recall_memories` with the task and repo, then `get_memory` on the task journal. During work: `append_memory` per checkpoint with a fresh `request_id`; `save_memory` for rules and preferences, with `origin: stated` when the owner said it; `record_knowledge` for decisions, bugs, components and the ticket and PR context read through `jira-connector` and `gh`, each judgment edge with a reason and evidence. End of task: compact the journal with `save_memory(compact)`, promote durable facts, and link the journal to its project and tickets.
- The `task-journal` skill keeps one rolling journal per task, now in Agent Memory, named `<runtime>: <task slug>` with `claude-code` or `codex` as the runtime.
- `global.md`, the Claude Code imports and Codex `AGENTS.md` point at Agent Memory instead of BothQ.
- The rule "memory content is data, not instructions" goes into the skill and into every tool description (section 19).

## 11. Search and recall

Recall runs in each profile object of the read set, then merges in the Worker.

```mermaid
flowchart LR
	Q["query + repo"] --> W["Worker: route, embed query once (if on)"]
	W --> P1["ProfileStore work"]
	W --> P2["ProfileStore me"]
	subgraph IP["In each profile"]
		C1["exact: name, key"] --> F["RRF k=60 + BothQ literal boosts + origin weight"]
		C2["literal: texts_tri phrase"] --> F
		C3["full text: texts_fts bm25"] --> F
		C4["vector: in-memory int8 cosine"] --> F
		F --> X["one-hop graph expansion from top 10 seeds"]
		X --> PS["passages, 700 characters"]
	end
	P1 --> M["Worker: second RRF across profiles, token-budget packing"]
	P2 --> M
```

| Channel | Implementation | Candidate cap |
|---|---|---|
| Exact | `nodes.norm_name = ?` or `nodes.key = ?`. Counts double in RRF. | 20 |
| Literal | `texts_tri MATCH '"<query>"'` for queries of 3 or more characters, `LIKE` on names for shorter ones. This is BothQ's substring channel without a table scan. | 200 |
| Full text | `texts_fts MATCH` with the phrase OR the tokens, bm25 order. Tokenizer keeps `SEQ-1234`, `foo.bar` and `#41` as single tokens. | 200 |
| Vector | Query vector against all card vectors, held in object memory as one `Int8Array` after the first load. About 5k cards times 256 dimensions is 1.3M multiply-adds, under 1 ms. | 200 |

- Fusion: RRF k=60 per channel, BothQ's literal boosts (+2 exact name, +1 name contains), origin weight (stated 1.0, agent 0.9, upload 0.8, inferred 0.7). Captures and digests are excluded unless `include_captures` is set. Superseded and retired nodes are excluded unless `include_history` is set or `as_of` falls in their valid time.
- Link expansion: the top 10 fused nodes seed a one-hop walk over current edges with basis `identifier` or `judgment` in the structural, work and reasoning classes. A neighbor scores the sum of its seeds' scores times a relation weight (reasoning 1.0, work 0.8, structural 0.6), divided by `1 + log(degree)` so hubs do not flood the list. Neighbors join as a `graph` channel, and each carries `via {from, rel, basis, reason}`. `expand: false` turns this off.
- Passages: 700 characters around the best match in the best chunk, from FTS5 `snippet()` offsets.
- Merge: the Worker runs a second RRF over the lists from `work` and `me`, dedupes by node id, and packs results in rank order until `token_budget` is spent, with the cost of each hit estimated as JSON length divided by 4, as BothQ does.
- FTS5-only mode: with `EMBEDDINGS=off` the vector channel and similarity edges are skipped, and every response says `lexical_only: true`. BothQ works this way today.
- Vectorize: not used in v1 (open question 3). The vector channel sits behind one function, `vectorTopK(query, k)`, so a Vectorize adapter replaces the in-memory scan when a profile passes about 20k cards or recall CPU passes 7 ms.

Embeddings use `@cf/qwen/qwen3-embedding-0.6b` through the `AI` binding: 1,075 neurons per million input tokens and an 8,192-token context. Output vectors are truncated to the first 256 dimensions, renormalized and stored as int8. The upstream model is trained for this kind of truncation. Workers AI does not document the output size, so phase 2 checks it, and the golden-query gate compares 256 dimensions against the full vector. If 256 loses recall quality, the fallback is `@cf/baai/bge-m3` at 1,024 dimensions int8, at the same price. A card is the kind, name, summary, why and the first 1,200 characters of the body or summary. Only memory kinds and described entities (components, bugs, features, tickets and PRs with summaries) get cards. Commits, people and sessions are found by identifier and full text.

## 12. Indexing, housekeeping and consolidation

The server never decides what a record means. It computes, deterministically, which records need attention, and agents decide.

### At write time, inside the write transaction

- Redaction of every string field (port of `memory_privacy.py`: private keys, bearer and basic auth, `sk-`, `ghp_`, `github_pat_`, Slack tokens, AWS keys, JWTs, `key=value` secrets, URL passwords, sensitive object keys).
- Identifier extraction (`domain/extract.ts`, pure). Jira keys are matched only for project keys the profile already knows (from routing config and uploaded tickets), so `UTF-8` never becomes a ticket. GitHub refs are matched only for known orgs. SHAs are matched only with repo context. File paths become evidence rows. Each resolved id becomes a basis `identifier` edge, and an unknown key becomes a stub node that a later upload fills in.
- Exact dedupe of captures: the same content hash in the same profile returns the existing capture and merges the source.
- The node's `card_hash` changes when its card text changes, which makes its embedding due.

### On each object's alarm (one bounded step per invocation, under about 5 ms CPU)

| Stage | Trigger | Step bound | Effect |
|---|---|---|---|
| `embed` | `card_hash` differs from `embed_hash` | 16 cards per Workers AI call | Upserts `vectors`. Publishes only if `card_hash` still matches, the BothQ rule. Pauses when the account's embedding counter passes 8,000 neurons for the day. |
| `similar` | After `embed` | 20 cards | Up to 5 `relates_to` edges per card with cosine at least 0.85, basis `similarity`. Old similarity edges end. |
| `queue` | Nightly, and after `similar` | 200 nodes | Writes `maintenance` items (below). |
| `dedupe` | Nightly | 100 nodes | Active memory nodes with the same kind, scope and content hash: the newer gets `superseded` by the older with a `supersedes` edge. Protected nodes get `flagged` instead. |
| `ttl` | Nightly | 100 nodes | Candidates and digests neither promoted, consolidated nor used within 90 days move to the archive. |
| `purge` | Nightly | 200 rows | Archive rows older than 300 days are deleted. Requests older than 300 days and activity older than 400 days are deleted too. |
| `size` | After each write batch | 1 check | Enforces the 70% and 90% caps (section 6). |
| `export` | Nightly tick | one 512 KB part | Section 18. |

Background stages pause when the account's rows-written counter for the day passes 80k.

### The maintenance queue

| Item kind | Deterministic rule | Model in the daily batch |
|---|---|---|
| `near_duplicate` | Two active nodes of the same kind with card cosine at least 0.92 | Terra |
| `possible_contradiction` | Two active rules, preferences or decisions with cosine between 0.80 and 0.92 that share a project, component or scope | Terra |
| `unlinked` | A memory node with no edge to any project, component or person after 24 hours | Luna |
| `unprocessed_digest` | A session digest not yet consolidated | Terra |
| `preference_signal` | A digest or capture with owner-correction markers not yet processed | Terra |
| `stale_journal` | A journal idle for 7 days with at least 8k uncompacted characters | Luna |
| `weekly_review` | Seven days since the profile's last strategic review | Terra |

Each item has a fingerprint (kind, subject ids, card hashes), so an unchanged item is never queued twice and a changed record queues again.

### The daily batch in the local run

The run takes at most one batch per profile per day, and never mixes profiles in one prompt.

```sh
agent-memory maintenance work   # internally:
# 1. maintenance_next {profile: "work", limit: 40}
# 2. split items: Luna gets unlinked and stale_journal; Terra gets the rest
codex exec --ephemeral --sandbox read-only -c 'mcp_servers={}' -m gpt-6-luna -c model_reasoning_effort=low \
	--output-schema ~/.agent-memory/schemas/maintenance-ops.json - < /tmp/am-luna.json > /tmp/am-luna.out.json
codex exec --ephemeral --sandbox read-only -c 'mcp_servers={}' -m gpt-6.1-terra -c model_reasoning_effort=high \
	--output-schema ~/.agent-memory/schemas/maintenance-ops.json - < /tmp/am-terra.json > /tmp/am-terra.out.json
# 3. maintenance_complete {lease_id, results} with the validated ops
```

The model sees the items and returns ops that fit the schema. It has no tools and no network, and it never holds the token. The runner script validates the output against the schema and posts it. The server validates it again through the normal write path. A prompt injection planted in stored text can, at worst, propose a bad op for one of its own item's subjects. The server keeps that op inside the item's subjects, logs it with undo, and turns any change to a protected node into a flag. Model slugs come from the owner's current Codex catalog.

### Inline consolidation at task end

The rewritten `task-journal` skill makes the agent that finishes a task do the cheap, high-context part itself: compact its own journal, promote durable facts, record decisions with reasons, and link the journal to the project and tickets. The daily batch handles cross-record work that no single session sees.

### Protection, activity and undo

- `mayChange(node, actor)` in `profile/write.ts` is the one gate for every retire, supersede, archive, merge and forget. For actors `keep`, `index` and `maintenance`, it refuses nodes with origin `stated`, nodes with `pinned = 1`, and every node in `me`. A refusal sets `flagged` with the reason, logs activity, and leaves the node unchanged. The owner decides in the dashboard. An interactive agent acting on the owner's explicit instruction may change them.
- Every write stores its inverse `WriteCommand` in `activity.undo` in the same transaction. Undo runs that command through `write()` with `request_id = "undo:<activity id>"` and the `expected_revision` that the change produced. If the record changed since, undo returns `revision_conflict` and the dashboard shows "changed since; review by hand". Purge is the one change without undo. Its activity row records counts and ids.

### The model of the owner

`preference` nodes with origin `stated` (the owner said it) or `inferred` (an agent concluded it, with at least one evidence pointer). Inferred preferences go live at once with the label, rank below stated ones in recall, and appear on the dashboard with their evidence, where the owner can pin them (which protects them) or forget them (archive, with undo). Work-learned preferences go to `me` only through the `me` write guard (section 5).

## 13. Work graph

Cloudflare never talks to GitHub or Jira and holds none of their credentials. All repos and Jira projects are private, and work data enters memory only from the owner's machines while work happens:

- The session bundle: commits from local git, PR metadata from local `gh`, Jira context for touched tickets through the Claude Code Jira connector.
- Explicit agent writes during work: `record_knowledge` with the ticket and PR context an agent read through `jira-connector` or `gh`.
- The daily refresh of assigned tickets (work) and open PRs (both profiles), on by default.

The server turns uploads into nodes and identifier edges (section 4) and computes views at read time. Each view shows its `as_of`, and the board says in its header that it covers only what the owner's machines have uploaded.

`work_board` scores open `ticket`, `bug`, `feature` and `pr` nodes with one formula and returns the reasons in words:

```text
score = 40 * priority            (Highest 1.0, High 0.75, Medium 0.5, Low 0.25, none 0.4)
      + 25 * due                 (1.0 if overdue, else max(0, 1 - days_to_due / 14))
      + 15 * owner_action        (assigned to the owner, or review requested from the owner)
      + 10 * blocking            (open items it blocks, capped at 3, divided by 3)
      + 10 * recent_activity     (linked journal entries, commits or PRs in the last 7 days)
      - 20 * blocked             (has an open blocked_by edge)
stale = no upload or linked activity for 14 days
```

The strategic review is a `document` node (`attrs.kind = "strategic_review"`) that Terra writes in the daily batch when the `weekly_review` item comes due. It links the items it discusses, each with a reason. `work_board` returns the latest review and its age.

Heal sweeps retire. Their jobs split three ways: deterministic housekeeping and the maintenance queue on the server, judgment in the daily batch, and staleness flags on the board.

## 14. Corpus module (Paid only)

The corpus is too big for Free: 3.2 GB, 525k commits, 292k tickets, 135k PRs and 1.7M search documents, against a 1 GB object limit on Free. Its limit is storage, not compute.

### Storage

One `CorpusStore` object per profile (10 GB object limit on Paid) holds the corpus tables with their original schemas, the FTS5 `corpus_search_documents` index, and two bookkeeping tables: `corpus_meta(table, source, as_of, refresh)` and `markers` per repo. Corpus rows are not graph nodes, because 1.7M commit paths as nodes would bloat every traversal. `explore` and `corpus` look corpus rows up by key (a commit SHA, PR number, ticket key or repo), so "what is connected to X" includes corpus records on Paid.

### One-time bulk load

`agent-memory corpus-upload --profile work --db ~/.bothq/corpus/sequoia.sqlite` streams each table in batches of 5,000 rows to `/v1/corpus/import` with an `import` token. A checkpoint file records `(table, last rowid)`, and each batch has `request_id = corpus:<table>:<first rowid>`, so an interrupted upload resumes without duplicates. The full load writes about 12M rows, inside the Paid plan's 50M rows a month.

### Incremental updates

Only from the owner's machines, through the session bundle. The classification below is inferred from table names, row counts and the corpus metadata (`frontend_metadata` labels business facts and workflows as curated). The original builders are not in any repo: `corpus_metadata` shows the corpus was assembled on 2026-08-12 from scratch databases under `/tmp`, so phase 6 writes new scanners.

| Group | Tables (rows) | Built from | Refresh |
|---|---|---|---|
| Git history | `commits` (525k), `refs` (310k), `commit_paths` (1.74M), `contributors` (998), `repos` (87) | Local git, deterministic | Session bundle: commits since the marker, with paths |
| Delivery | `pull_requests` (135k), `pr_tickets`, `releases` (41.8k), `github_tags`, `delivery_workflows`, `pr_commit_links`, `delivery_repo_snapshots` | GitHub through local `gh`, deterministic | Session bundle: PRs updated since the marker, releases and tags of the session repo |
| Tickets | `tickets` (292k), `ticket_episodes` (7.2k) | Jira export | Touched and assigned tickets through the session bundle and daily refresh. All other tickets stay a dated snapshot. |
| Sessions | `codex_sessions` (455), `session_messages` (8.9k), `session_decisions` (11.8k), `user_directives` (7.7k), `session_commit_links`, `session_ticket_links` | Codex session databases | Frozen at the bulk-load date. New sessions arrive as digests in the memory graph. |
| Architecture, deterministic | `source_files` (83.6k), `architecture_repos`, `api_endpoints` (564), `api_callers` (2.2k), `api_endpoint_matches`, `packages` (50), `package_edges`, `external_system_edges` (1.3k), `env_refs` (444), `architecture_workflows` (138) | Checkout scanning | Local scanners on changed files, once per repo per day |
| Frontend, deterministic | `frontend_repositories`, `frontend_snapshots`, `frontend_files` (44.4k), `frontend_evidence` (73.8k), `mf_exposes` (657), `cross_mfe_imports` (29.4k), `frontend_api_endpoints` (9k), `frontend_routes` (1.1k), `frontend_domain_modules` (312), `frontend_dependencies` (1.2k), `frontend_branch_refs`, `frontend_branch_deltas` (4.2k), `frontend_branch_comparisons` | Checkout scanning | Local scanners on changed files, once per repo per day |
| Judgment, curated | `validated_contracts` (9), `frontend_business_facts` (63), `frontend_workflows` (15), `frontend_relationships` (99), `frontend_uncertainties` (5), `pattern_findings` (15), `ownership` (18), `predecessor_links` (6), `journey_edges` (253) | Agent curation | Dated snapshot. The local run asks Terra to re-check one fact only when changed files touch that fact's evidence files. |
| Pattern statistics | `pattern_coordinated_changes` (509), `pattern_synchronized_migrations` (104), `pattern_release_batches` (740), `pattern_bus_factor` (65), `pattern_revert_stats` (86), `pattern_cherry_pick_edges`, `pattern_lineage_edges`, `pattern_release_actor_yearly`, `pattern_branch_strategy_yearly`, `pattern_current_repo_policies` (75), `pattern_workflow_dependencies`, `delivery_clusters` | SQL over history and delivery | Read-time SQL views over the uploaded rows where the query fits 30 s of Paid CPU. Heavier ones stay dated snapshots. |
| Builder bookkeeping | `github_api_calls`, `delivery_exceptions`, `evidence_provenance` | Build logs | Frozen |

The local refresh for checkout tables follows the owner's rule: the hook compares HEAD against the repo's `analysis_head` marker, and if the repo changed and was not analyzed today, the detached run scans only `git diff --name-only <analysis_head>..HEAD`, uploads replaced rows keyed by `(repo, path)` with an `as_of`, and calls `codex exec` (Luna for mechanical summaries, Terra for judgment) only for the curated tables. Repos nobody works in keep their last snapshot and its date.

### Query tools

`corpus` with `search` (FTS5 over search documents, passages), `get` (exact commit, PR, ticket, repo, person or session by key), and `sql` (read-only, 500-row cap, 30 s CPU on Paid). Every response carries the `as_of` of the tables it read.

## 15. Dashboard

Workers Static Assets serves a small static app (Preact plus Cytoscape.js for the map) from the same Worker at `/app`. Clerk JS signs the owner in. The app calls `/api/*` with the Clerk session token. The API runs the same commands as MCP with actor `owner`.

| Page | What a non-technical reader sees first | Drill-down |
|---|---|---|
| Home | One card per profile: projects, people, open work, decisions this month, last backup, storage used against its limit | Counters, recent activity, health warnings |
| Map | Projects at the centre, people, components, bugs and features around them. Colour by kind, line style by relation class, a time slider, a profile switch. | Click a node for its entity page |
| Entity page | What it is, who worked on it, what it links to and why (each link with its reason), its timeline | Evidence, history (`as_of`), raw node and edges |
| Path finder | Pick two things and see how they connect, with the reason on each step | Alternative paths |
| Timeline | What happened, by day or week | Entries, revisions, uploads |
| Journals | Active and compacted journals | Entries, summaries, compaction history |
| About you | Stated and inferred preferences, with evidence | Pin, forget, undo |
| Work | The priority board with its as-of date and the latest strategic review | Score reasons per item |
| Activity | Every change in plain words, filtered by who made it | Undo, with conflicts shown |
| Archive | Removed items and when they purge | Restore |
| Review | Migrated records with no profile | Assign a profile |
| Settings | Devices and tokens, routing rules (with a "test this remote" box), profiles, embeddings switch, retention values, backups and restore drill | Create token (shown once), revoke, edit rules |

API (owner only):

```text
GET  /api/overview                         GET  /api/profiles/:p/nodes/:id | /by-key/:key
GET  /api/profiles/:p/map?center=&depth=   GET  /api/profiles/:p/path?from=&to=
GET  /api/profiles/:p/timeline?from=&to=   GET  /api/profiles/:p/journals
GET  /api/profiles/:p/owner-model          GET  /api/profiles/:p/board
GET  /api/profiles/:p/activity?before=     POST /api/profiles/:p/activity/:id/undo
GET  /api/profiles/:p/archive              POST /api/profiles/:p/archive/restore
POST /api/profiles/:p/nodes/:id/pin|unpin|forget|unflag
GET  /api/review                           POST /api/review/:id/assign
GET  /api/devices                          POST /api/devices   DELETE /api/devices/:id
GET  /api/rules   PUT /api/rules           POST /api/rules/test
GET  /api/profiles  POST /api/profiles     GET  /api/backups   POST /api/backups/drill
POST /api/admin/profiles/:p/pitr {at}      POST /api/admin/profiles/:p/restore {export}
```

Map and path endpoints cap their output (300 nodes for the map, 3 paths of at most 4 hops), so a request stays inside 10 ms of CPU.

## 16. Migration and cutover

The migration is one-time work on the owner's machine, run in the foreground with Codex on the ChatGPT subscription: Luna for mechanical steps, Terra for judgment. The owner leaves the machine online for it.

| Step | Who | Output |
|---|---|---|
| 1. Export | Luna | Read-only Cypher export of BothQ to JSONL (adopted `MemoryRecord` shapes, legacy `Rule`, `Decision`, `Resource`, `Routine` shapes with `rule`-field content, revisions for dates), the 17 Claude Code memory files, and Codex `MEMORY.md`, `raw_memories.md`, rollout summaries and extension notes. A manifest with a count and hash per source. |
| 2. Distill | Terra, batches of about 20 records | Current-state snapshots: kind, BothQ type, name, content, why, how_to_apply, steps, scope, profile with confidence, dates (`valid_from` from the original creation), provenance (source, source id, path), entities and judgment edges with reasons and evidence, and journals split into entries at their date headings. Finished journals become a summary plus decision nodes. The `sequioa` typo becomes `work`. |
| 3. Mechanical pass | Luna | Name normalization, exact-hash dedupe, schema validation of every record, and chunking above 16k characters |
| 4. Route | Terra's proposal plus routing rules | Records with no rule match or low confidence go to the review list |
| 5. Import | `agent-memory migrate upload` | Batches of 50 commands to `/v1/import` (`import` token, actor `migration`, original dates kept). `request_id = migrate:<source>:<source id>:<content hash>`. |
| 6. Embed | Cloudflare | Alarm steps embed the imported cards (about 2,600 neurons once) |

Every batch writes its output file atomically and records itself in `migration/state.json` (source cursor, batch number, request ids sent). A rerun skips finished batches, and the server replays any request it already applied, so a sleep, crash or network drop loses nothing and creates no duplicates. On Free the uploader stops at 60k rows written per UTC day.

Verification before cutover:

1. Counts per source, type and profile match the manifest. Every source id appears in the provenance map or in an explicit drop list with a reason.
2. Thirty golden queries chosen by the owner: the hosted top 5 contains BothQ's top result for at least 28.
3. Twenty random judgment edges have a reason and evidence that point at real entries or commits.
4. The largest journal's entry count matches its BothQ append count.
5. A deterministic scan finds no work sensitive term in `me`.
6. A restore drill from the newest R2 export passes (section 18).

Cutover:

1. Point every machine's Claude Code and Codex MCP config at `https://memory.wrick17.com/mcp` and log in. Remove the BothQ MCP entries.
2. Turn off native memory. Claude Code: `"autoMemoryEnabled": false` in `~/.claude/settings.json` and `~/.plaude/settings.json`, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Codex: `[features] memories = false` and `[memories] generate_memories = false`, `use_memories = false` in `~/.codex/config.toml`.
3. Move the old files to a dated archive folder (`~/.plaude/projects/*/memory`, `~/.codex/memories`). Do not delete them.
4. Install the `agent-memory` skill, rewrite `task-journal`, `global.md` and the Codex `AGENTS.md`, and retire `bothq-memory`.
5. Re-export BothQ writes made since the export and import them. Request ids make the catch-up idempotent.

BothQ shuts down when all of these hold: 14 consecutive days of hosted-only use with zero BothQ MCP calls in its logs, the verification above passed, a restore drill passed, and the owner signs off. A final encrypted BothQ export goes to R2 under `migration/` as the provenance record. Open question 4 covers the corpus tools.

## 17. Quotas

Volume inputs, measured from BothQ for 2026-10-01 to 10-28: about 103 writes a day (peak 545 on Oct 17), about 42 agent sessions a day (peak about 110 on Oct 22). "Busy day" below is three times the average.

### Recurring work on Workers Free (the core)

| Resource | Free limit | Average day | Busy day | Notes |
|---|---|---|---|---|
| Worker requests | 100k/day | about 900 | about 3k | about 600 tool calls, 42 bundles and marker checks, dashboard, one maintenance batch per profile |
| Worker CPU | 10 ms per invocation | JWT check under 1 ms; MCP parse and merge; SDK cost unmeasured | | Gate G2 |
| Durable Object CPU | 10 ms per invocation | append about 1 to 2 ms, recall about 3 to 6 ms (estimates), alarm steps under 5 ms | | Gate G2 |
| Durable Object requests | 100k/day | about 2.5k | about 7k | AccountStore plus one or two profiles per call, plus alarm steps |
| Durable Object duration | 13,000 GB-s/day | about 2k GB-s | about 5k GB-s | Assumes up to 10 s of billed time at 128 MB per burst of activity |
| Rows written (account) | 100k/day | about 14k | about 43k | Breakdown below. Background stages pause at 80k. |
| Rows read | 5M/day | about 1.6M | about 2.4M | Recall reads about 600 rows with vectors in memory. The nightly full export reads every row (about 0.85M in year 1). |
| Storage | 5 GB/account, 1 GB/object | about 1.2 MB/day added | | `work` about 340 MB after year 1 (section 6) |
| Workers AI | 10k neurons/day | about 105 | about 320 | Embeddings only (below) |
| R2 | 10 GB-month, 1M Class A/month | about 0.6 GB (two exports of three profiles) | | about 17k Class A operations a month |
| Cron Triggers | 5/account | 1 | 1 | |
| Subrequests | 50/invocation | at most 5 per tool call | | Bindings only |
| KV, Queues, Workflows, Vectorize | | not used | | KV only if the G1 fallback runs (a few writes per login) |
| Clerk Hobby | 50k monthly retained users | 1 | 1 | |

| Rows written by source | Average day | Busy day |
|---|---:|---:|
| Appends (80 or 440 at about 19 rows) | 1,520 | 8,360 |
| Saves and updates (23 or 105 at about 33) | 760 | 3,470 |
| `record_knowledge` (30 or 90 at about 25) | 750 | 2,250 |
| Session digests (42 or 110 at about 50) | 2,100 | 5,500 |
| Commits kept (90 or 270 at about 16) | 1,440 | 4,320 |
| Commits aggregated (210 or 630 at about 3) | 630 | 1,890 |
| PRs and tickets (60 or 180 at about 20) | 1,200 | 3,600 |
| Embeddings with similarity edges (200 or 600 at about 18) | 3,600 | 10,800 |
| Maintenance ops (about 60 at 25) | 1,500 | 1,500 |
| Housekeeping, queue, cursors | 800 | 1,000 |
| Total | about 14,300 | about 42,700 |

### Embedding neurons

| Item | Average day | Busy day |
|---|---:|---:|
| Cards embedded (about 400 tokens each) | 200 cards, about 86 neurons | 600 cards, about 260 neurons |
| Query embeddings (about 30 tokens each) | 600 queries, about 19 neurons | 1,800 queries, about 58 neurons |
| Total | about 105 | about 320 |

Price: 1,075 neurons per million input tokens (Workers AI pricing, updated 2026-10-20). The account counter stops embedding at 8,000 neurons a day. On Free, Cloudflare stops at 10,000. Paused cards embed after 00:00 UTC, and recall stays lexical for them meanwhile. There is no other LLM spend on the server.

### One-time work

| Job | Runs on | Free | Paid |
|---|---|---|---|
| Migration distillation | Owner's machine, Codex on the ChatGPT subscription | No Cloudflare cost | No Cloudflare cost |
| Migration import (about 100k rows written) | Cloudflare | Two days at the 60k/day throttle | One run |
| Migration embeddings (about 6k cards, about 2.4M tokens) | Workers AI | About 2,600 neurons, inside one free day | Same |
| Corpus bulk load (about 12M rows written, about 4.5 GB) | Owner's machine to `CorpusStore` | Not available | Inside the 50M rows a month included. Storage above 5 GB-month costs $0.20 per GB-month. |
| Full restore of `work` from an export (about 0.8M rows written with FTS) | Cloudflare | About 9 days under 100k/day; use point-in-time restore instead | One run |

### Everything on Workers Paid

| Resource | Included | Owner use per month | Extra cost |
|---|---|---|---|
| Plan | | | $5 |
| Requests, CPU | 10M requests, 30M CPU-ms | about 30k to 90k requests, under 1M CPU-ms | $0 |
| Durable Object requests, duration | 1M, 400k GB-s | about 100k, about 100k GB-s | $0 |
| Rows written, rows read | 50M, 25B | about 0.5M (plus 12M once for the corpus), about 60M | $0 |
| Storage | 5 GB-month | about 1 GB core plus about 4.5 GB corpus | about $0.10 |
| Workers AI | 10k neurons/day | about 3k to 10k a month | $0 |
| R2 | 10 GB-month | about 0.6 GB core plus about 7 GB for two weekly corpus exports | about $0 |

Paid-only: the corpus module. Everything else runs on Free.

## 18. Reliability and backups

### Failure modes

| Failure | Effect | Handling |
|---|---|---|
| A tool call fails mid-write | The client sees an error | The write is one transaction, so nothing half-applies. The client retries with the same `request_id` and gets the stored result. |
| A machine is offline at session end | The bundle cannot upload | It stays in the spool and replays on the next run. |
| A bad agent run edits many records | Wrong memory | Undo per activity row in the dashboard. For a bulk mistake, point-in-time restore of that profile. |
| Clerk is down | New logins and refreshes fail | Access tokens stay valid until they expire (one day). Device tokens keep working. |
| Clerk rotates its signing key | 401 `unknown_kid` | Update `CLERK_JWT_KEYS` (section 8). |
| Workers AI is down or the counter is spent | No new embeddings | Recall answers lexically and says `lexical_only`. Cards embed later. |
| A Free daily cap is hit | Platform errors until 00:00 UTC | Background stages pause at 80k rows. The dashboard shows counters against limits. |
| A profile nears its size limit | Uploads refused at 70%, writes at 90% | Dashboard warning. Agents compact and retire. |
| The nightly export fails | The newest backup is stale | The dashboard health card shows the age. Tool responses add a `health` note after 48 hours. |
| An export part is corrupt | That export cannot restore | The manifest hash check catches it. The other kept export and point-in-time restore remain. |
| The Cloudflare account is lost | Everything is lost | Accepted by the owner (no off-Cloudflare copy). `agent-memory export --download` makes a one-off local copy on demand. |

### Point-in-time restore

Each `ProfileStore` keeps 30 days of SQLite history. `POST /api/admin/profiles/work/pitr {"at": "2026-10-27T09:00:00Z"}` makes the object call `ctx.storage.getBookmarkForTime(at)`, then `onNextSessionRestoreBookmark(bookmark)`, then `ctx.abort()`. The object restarts at that point. The call returns the undo bookmark, which `AccountStore` keeps, so a wrong restore can itself be reversed. This is the first tool for bad writes.

### Nightly encrypted export to R2

- The nightly tick starts `export` in each profile. Each alarm step reads base tables in primary-key order (never FTS shadow tables), writes up to 512 KB of NDJSON, encrypts it with AES-256-GCM (key derived with HKDF from the `BACKUP_KEY` secret, a random 96-bit IV per part, the object key as additional data), and puts `exports/<profile>/<date>/<nnnn>.enc` to R2.
- A final step writes an encrypted `manifest` with the schema version, row counts per table and a SHA-256 per part.
- After the manifest lands, the step deletes every export of that profile except the two newest complete ones.
- The corpus exports weekly the same way, also keeping two.
- The owner keeps a copy of `BACKUP_KEY` in a password manager. Without it, exports cannot be read. Point-in-time restore does not need it.

### Restore procedure

1. **Bad writes in the last 30 days:** use point-in-time restore on the affected profile, as above. Check the result in the dashboard. If it is wrong, apply the returned undo bookmark.
2. **Object loss or corruption, or older than 30 days:** run `agent-memory restore --profile work --export latest` (or a date). The owner endpoint makes `AccountStore` register generation `g+1` of `work` with status `restoring`.
3. The new object fetches, decrypts and verifies each part against the manifest, then inserts rows through the normal triggers so FTS rebuilds as it goes. Alarm steps keep each piece under the CPU limit.
4. The new object compares its row counts and table hashes with the manifest and reports.
5. The owner confirms in the dashboard. `AccountStore` switches `work` to generation `g+1` in one write. Traffic moves at once. The old generation stays until the next export, then is cleared with `deleteAll()`.
6. **Restore drill:** monthly, from the dashboard. It restores the newest export into a scratch generation, compares counts and hashes, records the result, and deletes the scratch object. On Free, a full drill of a large profile is limited by rows written per day, so the drill there restores `me` plus a sample of the other profiles' tables.

### Monitoring

Workers Observability logs and metrics (including CPU time per invocation) are on. `GET /healthz` returns `ok` and the version, with no data. The dashboard health card shows, per profile, the age of the last export, counters against Free limits, storage against the size caps, the last upload per device, open queue items by kind, and write errors from the last 24 hours.

## 19. Security and privacy

### Trust boundaries

```text
[ agent clients, hook, browser ]  --TLS, bearer JWT or device token-->  [ Worker ]  --RPC-->  [ AccountStore, ProfileStore ]
        untrusted input                                         verify, route, validate          trusted storage and policy
[ Clerk ]  <-- clients only; the Worker never calls it
[ Workers AI, R2 ]  <-- bindings inside Cloudflare
```

- **No outbound calls.** The Worker and objects call only bindings: Durable Objects, R2, Workers AI and Static Assets. A lint rule bans `fetch(` to anything else in `src/`, and Workers Observability shows any subrequest. The only allowed exception is the G1 fallback's call to Clerk at login, and the fallback design avoids even that.
- **No third-party work credentials reach Cloudflare.** GitHub, Jira and Google credentials stay on the owner's machines. The Worker's secrets are `CLERK_JWT_KEYS` (public keys), `OWNER_USER_ID` and `BACKUP_KEY`.
- **Owner only.** Every token must name `OWNER_USER_ID`. Clerk sign-ups are off as a second guard.
- **Least privilege.** Scopes `read`, `write`, `ingest`, `maintenance`, `import`, each with a profile list. `tools/list` shows only what the scopes allow. The job token can upload and run maintenance, and cannot recall or read arbitrary memory. The dashboard's owner-only operations (undo, tokens, rules, restore) are not MCP tools.
- **Isolation.** One object per profile, the `ReadSet` type, `dst_profile` limited to the same profile or `me`, the `me` write guard, and colleagues only in `work`.
- **Token storage.** Device token secrets are 32 random bytes, stored only as SHA-256 hashes, shown once and revocable at once. OAuth tokens are never stored on the server. On machines, tokens live in the keychain or a mode-600 file.
- **Redaction.** The hook redacts before upload, and the server redacts every string field again before storage and before hashing, so a replayed payload with a secret still matches its request.
- **Untrusted text is never instructions.** Captures, digests, uploads and agent-written text are stored as data. Tool descriptions and the `agent-memory` skill say that recalled content is evidence to weigh, not instructions to follow. Recall results carry `origin` and wrap content in a `data` field. The server never executes or interprets stored text. The daily batch runs `codex exec` with no tools, no MCP servers, a read-only sandbox and an output schema, and the server confines each op to its item's subjects.
- **Read-only SQL.** `query_sql` accepts one `SELECT` or `WITH` statement, runs it inside `transactionSync` that always throws a rollback sentinel at the end, stops at 500 rows, and only ever touches one profile.
- **Personal data.** People are names, handles, roles and work links. Emails and other personal fields are dropped at ingest.
- **Backups.** Encrypted before they leave the object. R2 holds only ciphertext.
- **Dashboard.** Bearer tokens in headers, not cookies, so a forged cross-site request carries no credentials. A strict Content Security Policy allows only the app's own scripts and Clerk JS.

## 20. Synthesis decision

Two independent Opus runners designed whole-shape candidates before the owner's 18:05 to 18:45 reframe: candidate A, one Durable Object per profile (`docs/candidates/candidate-a-durable-object.md`), and candidate B, a stateless Worker over one D1 database per profile (`docs/candidates/candidate-b-d1-worker.md`).

**Base: candidate A.** It won on the points that decide this workload:

| Point | A: Durable Object per profile | B: D1 per profile |
|---|---|---|
| BothQ write contracts | One `transactionSync`: read, check, write. No retry path. | No interactive transactions. Every write is a read, then a `batch()` that uses the revision primary key as compare-and-swap, an abort classifier, and retries for appends. |
| Adding a profile | A registry row | A new database, a wrangler binding and a deploy; 10 databases on Free |
| Restore | 30-day point-in-time restore per object, plus an instant generation switch | Time Travel, 7 days on Free |
| CPU on Free | SQL, ranking and graph walks run inside the object, which has its own 10 ms budget | The Worker's single 10 ms covers the MCP SDK, JWT, parsing two result sets, the vector scan and RRF |
| Background work | Each object's alarm | Three Cron Triggers and two Workflows, capped at 3,000 steps a day on Free |
| Graph traversal | Level-by-level SQL inside the object, no round trips | One D1 round trip per level |
| Export | Hard (FTS5 shadow tables), solved with page-based dumps | Equally hard (`wrangler d1 export` fails with FTS5) |

**Adapted from B:** one small vector per card in SQLite (256 dimensions, int8) instead of Vectorize; reads that never write, except touching captures; `routed_by` in every response; an explicit, resumable move protocol between profiles; pausing background work at a daily rows budget; one `save_memory` for create and update; column-scoped FTS triggers so an append never touches the head row; the page-based encrypted export.

**Kept from A:** the three-method `ProfileStore` interface over two command unions; `AccountStore` as a Durable Object for immediate revocation; chunked text with entry rows as append revisions; two FTS5 indexes (porter and trigram) for BothQ's substring parity; one protection gate; undo by stored inverse commands that carry `expected_revision`.

**Removed by the owner's reframe:** both candidates ran consolidation on Workers AI (qwen3-30b and gpt-oss-120b) behind a neuron budget guard, candidate A synced GitHub and Jira from the server, and both copied backups to Google Drive. None of that survives. The server has no LLM, no outbound calls, no sync and no Drive copy.

**New in the synthesis:** the typed ontology with reasons, evidence and bi-temporal fields; one `nodes` table for memories and entities; the `evidence` table; deterministic identifier indexing and similarity edges; the maintenance queue with job tools and the job-scoped token; the local detached run; the `me` write guard with sensitive terms; generation-named objects for instant restore; scope-filtered `tools/list`.

### Red flags checked

| Flag | Result |
|---|---|
| Shallow module | `ProfileStore` has four methods (`write`, `read`, `tick`, `alarm`) behind two unions. Promotion, supersession, moves and undo are each one `write`. |
| Information leakage | The SQL schema stays in `profile/`. MCP and REST types are parsed in `mcp.ts` and `api.ts` and never reach the objects. The ontology is one list. |
| Temporal decomposition | Modules follow ownership: the write path, reads, indexing, housekeeping. Not request stages. |
| Pass-through method | `mcp.ts` adds parsing, routing, fan-out and merge. `store.ts` adds the transaction and alarm arming. |
| Split ownership | Every table has one writer, `profile/write.ts`. Indexing and housekeeping write through it. FTS tables are written only by triggers. Counters are written only by `AccountStore`. |
| Two ways to do one task | One write path for agents, the hook, the dashboard, housekeeping, maintenance and migration. One vector path in v1. Capture has two transports (MCP and `/v1/ingest`) that build one command. |
| Importable internals | A lint rule blocks imports of `profile/*` and `account/*` internals. |
| Hand-synced list | The ontology generates zod schemas, SQL checks and the dashboard legend. Tool schemas and commands come from one table. One leftover: the embedding price constant must match Cloudflare's page. |

## 21. Open-source template

The repo is a self-host template. Each user deploys it on their own Cloudflare and Clerk accounts. It is not a multi-tenant service, but every record still carries a user id.

```jsonc
// wrangler.jsonc
{
	"name": "agent-memory",
	"main": "src/worker.ts",
	"compatibility_date": "2026-10-01",
	"routes": [{ "pattern": "memory.example.com", "custom_domain": true }],
	"assets": { "directory": "dashboard/dist", "binding": "ASSETS", "run_worker_first": ["/api/*", "/mcp", "/v1/*", "/.well-known/*"] },
	"durable_objects": { "bindings": [
		{ "name": "ACCOUNT", "class_name": "AccountStore" },
		{ "name": "PROFILE", "class_name": "ProfileStore" },
		{ "name": "CORPUS", "class_name": "CorpusStore" }
	] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["AccountStore", "ProfileStore", "CorpusStore"] }],
	"r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "agent-memory-backups" }],
	"ai": { "binding": "AI" },
	"triggers": { "crons": ["30 20 * * *"] },
	"observability": { "enabled": true },
	"vars": {
		"PUBLIC_URL": "https://memory.example.com",
		"CLERK_ISSUER": "https://clerk.example.com",
		"PROFILES": "me,work,personal",
		"EMBEDDINGS": "on",
		"CORPUS": "off",
		"CAPTURE_TTL_DAYS": "90",
		"ARCHIVE_PURGE_DAYS": "300",
		"EXPORTS_KEPT": "2"
	}
	// secrets: CLERK_JWT_KEYS, OWNER_USER_ID, BACKUP_KEY
}
```

A self-hoster configures:

1. A Clerk application with OAuth applications and CIMD on, sign-ups off, and a custom domain. Copy the issuer, the instance public key and your user id.
2. `PUBLIC_URL`, `CLERK_ISSUER` and the profile list.
3. `npm run setup`, which generates `BACKUP_KEY`, prints it once for offline storage, and sets the three secrets.
4. `npx wrangler deploy`.
5. In the dashboard: routing rules and device tokens.
6. On each machine: `npx agent-memory install`, which adds the MCP server and the hooks to Claude Code and Codex and stores the job token in the keychain.

Optional parts: embeddings (`EMBEDDINGS=off` gives FTS5-only recall), the corpus (`CORPUS=on`, Paid only), the daily refresh and the Jira step (local config), and the maintenance batch. The batch runner command is local config: Codex `exec` by default, or Claude Code headless (`claude -p --output-format json`) for users without Codex. Without either, the queue waits on the dashboard and inline consolidation by agents still works.

## 22. Phased delivery

The order follows the requirements. Each phase ends with checks that must pass before the next one starts.

### Phase 1: save and recall from two machines through Clerk login

The smallest end-to-end slice:

- The owner creates the Clerk app and approves the DNS records for `memory.wrick17.com` and the Clerk subdomain.
- Worker, `AccountStore` and `ProfileStore` with the full v1 schema.
- Tools: `save_memory`, `append_memory`, `get_memory`, `recall_memories` (exact, literal and full text; no vectors yet).
- Routing with seeded rules, explicit `profile` and the device header.
- Protected resource metadata, JWT verification with the pinned key, device tokens, and a Settings page that creates and revokes them.

| Gate | Pass condition |
|---|---|
| G1 auth | T1 to T6 in section 8. Decides Clerk as the authorization server or the fallback. |
| G2 CPU | On a seeded copy of the real `work` data, including the 987k-character journal: append and recall p95 under 7 ms CPU per invocation in Workers Observability, for the Worker and the object separately. `createMcpHandler` serves `server/discover` and `tools/call` to both clients. If it fails, switch to the hand-written dispatcher and re-measure. |
| G3 contracts | Replay returns the stored result. A changed payload returns `idempotency_mismatch`. A stale revision returns `revision_conflict`. Two machines each send 100 concurrent appends to one journal: 200 entries, gapless `seq`, none lost. Supersession is atomic. Procedural validation matches BothQ. |
| G4 isolation | A device token for `personal` cannot read `work`. Recall routed to `work` returns only `work` and `me`. The `me` guard blocks a sensitive term. |
| G5 two machines | Save on the Mac through Claude Code (OAuth), recall on a second machine through Codex (OAuth) and on a headless box with a device token, each within 5 s. |

Exit: the owner uses Agent Memory alongside BothQ.

### Phase 2: capture, migration and native cutover

Build: the hook and detached run (digest, spool, upload), `/v1/ingest` for digests, `capture_memory` and `review_candidates`, `record_knowledge`, embeddings with the vector channel and the FTS5-only switch, the nightly R2 export with point-in-time and generation restore, the migration CLI and distillation, the cutover, and the skill rewrites.

Checks:

- Digest parity on ten real sessions: every decision and correction that Codex memory generation extracted appears in the digest or in the consolidated memory.
- The hook adds under 100 ms to session exit. A bundle survives an offline run and replays.
- Migration checks 1 to 6 (section 16).
- Golden queries with 256-dimension vectors score at least as well as with full vectors, or the design switches to bge-m3.

### Phase 3: knowledge indexing, housekeeping, consolidation, model of the owner

Build: identifier extraction, similarity edges, `explore`, `trace`, `timeline`, link-expanded recall, the maintenance queue with the job tools and the daily batch, TTL, purge, dedupe and size caps, undo for every op, the owner model, and the derived sensitive-terms list.

Checks:

- On a fixture with known ids, identifier extraction has precision of at least 0.95, and `UTF-8` never becomes a ticket.
- `trace why` returns reasons with evidence for ten migrated decisions.
- `trace path` finds the expected three-hop paths.
- Undo round-trips for every op type.
- Protected nodes are only flagged.
- The daily batch runs at most once per profile per day, never mixes profiles, and finishes within 20 minutes.

### Phase 4: dashboard

Build: the pages in section 15.

Checks:

- A reader the owner picks answers five questions ("who worked on X", "why did we choose Y", "what is blocked") from the map and entity pages without help.
- Server CPU per dashboard request stays under 10 ms.
- Keyboard navigation and contrast pass an axe check.

### Phase 5: work graph

Build: repo deltas (commits through git, PRs through `gh`), Jira context through the Claude Code connector, the daily refresh, `work_board` and the weekly review item.

Checks:

- After a week, the board shows assigned tickets and open PRs with their as-of dates.
- Teammates' commits appear after a pull.
- Workers Observability shows zero subrequests outside bindings.

### Phase 6: corpus (Paid)

Build: `CorpusStore`, the bulk upload, the `corpus` tool, `explore` integration, new scanners, the local refresh and the pattern views.

Checks:

- Row counts match `sequoia.sqlite` per table.
- Twenty BothQ `corpus_*` queries return the same answers.
- A changed repo refreshes its tables within a day of a session there.
- An untouched repo keeps its as-of date.

## 23. Tradeoffs and alternatives

### Tradeoffs accepted

- We accept two Durable Object hops per tool call (`AccountStore`, then the profile) in exchange for immediate token revocation and one owner for devices and rules.
- We accept that a journal's full text is a join of entry chunks, in exchange for appends whose cost does not grow with the journal. `get_memory` returns a summary, the newest entries and a cursor, not one 987k-character string.
- We accept the trigram index's storage (about 3x the text) in exchange for BothQ's substring recall without a table scan that would break 10 ms.
- We accept that judgment work happens only when the owner's machines run sessions, in exchange for a server that never acts. The queue waits and memory keeps working meanwhile.
- We accept that the board and the corpus cover only what the owner's machines uploaded, with as-of dates, in exchange for Cloudflare never touching GitHub or Jira.
- We accept 256-dimension embeddings in exchange for a vector scan under 1 ms and no Vectorize replica.
- We accept no off-Cloudflare backup (owner decision) in exchange for a server with no outbound calls.
- We accept that unrouted migrated records stay invisible until the owner assigns them, in exchange for keeping unrouted data out of `me`.
- We accept that a `request_id` is unique per profile, because routing is deterministic for the same input.
- We accept that the sensitive-terms guard is a deterministic substring check, which can miss a company detail phrased without any known term.

### Alternatives considered

- **D1 per profile (candidate B).** Section 20. It exposes compare-and-swap retries and per-profile deploys to save nothing the object model does not already give.
- **One store per user with a profile column (one D1 or one Durable Object).** Isolation becomes a `WHERE` clause that every query must carry, so one missed filter leaks `work` into `personal`. One object would also serialize every profile's writes and share one 1 GB limit.
- **Separate memory and entity tables.** Two traversal paths and two FTS sets. The unified `nodes` table gives one walk and one entity page for everything.
- **Files as nodes.** 1.7M commit paths would dominate the graph and the size limit. Evidence rows answer the file questions.
- **A server-side LLM pipeline on Workers AI** (both candidates before the reframe). Removed by the owner. The measured volume also makes it expensive at quality: gpt-oss-120b needs about 13k neurons on an average day and about 30k to 89k on busy days.
- **Vectorize first.** It adds a replica that must track the source of truth, at a size where an in-memory scan costs under 1 ms. It stays the switch at about 20k cards per profile.
- **`workers-oauth-provider` as the default authorization server.** More security-critical code of our own, plus KV writes. It stays as the G1 fallback.

## 24. Open questions and risks

### Open questions

1. **G1 outcome.** Does Clerk bind the RFC 8707 `resource` into `aud` and accept loopback redirects on any port? The phase-1 test decides between Clerk as the authorization server and the fallback (section 8).
2. **G2 outcome.** Do append and recall stay under 7 ms CPU p95 on Free, and does `createMcpHandler` serve the 2026-07-28 protocol to both clients? If not, the hand-written dispatcher is the fallback.
3. **Vectorize deferral.** The Storage row names Vectorize as the semantic index with SQLite vectors as the fallback. This design starts on SQLite vectors on both the owner's Paid deployment and the template, because at about 5k cards per profile the scan costs under 1 ms and backups include the vectors. Vectorize turns on at about 20k cards per profile or when recall CPU passes 7 ms. Do you accept the deferral?
4. **BothQ corpus gap.** Memory parity arrives in phase 2, but the corpus tools arrive in phase 6. The recommendation is to stop BothQ memory use after phase 2 (with the 14-day rule) and keep BothQ's corpus tools running read-only until phase 6 passes, then shut BothQ down. Is that the order you want?
5. **T3 Code sessions.** Does Claude Code fire `SessionEnd` for sessions that T3 Code drives through the Agent SDK? Phase 2 checks this. If not, `PreCompact` plus a flush of spooled sessions on the next `SessionStart` covers it.
6. **Point-in-time restore on Free.** The docs do not say whether it exists on Free. A Free test account at build time answers it, and that account is yours to create.
7. **Template restores on Free.** A full restore of a large profile from an export takes days under the 100k rows a day cap. Point-in-time restore is the fast path there. Is that acceptable for template users?

### Risks

| Risk | Mitigation |
|---|---|
| CPU on Free is tighter than estimated | G2 before anything builds on recall. Fallbacks: hand-written dispatcher, fewer channels per query, deferred trigram indexing for writes over 32k characters. |
| FTS5 trigram writes more rows per insert than estimated | Phase 1 measures `rowsWritten` per op. The 80k pause protects agent writes. |
| Clerk interop quirks | G1, with a fallback that also needs no outbound call. |
| Transcript formats change (Codex says its format is unstable) | A tolerant parser and a minimal fallback digest from hook input and git facts. |
| Bad merges or links from the daily batch | Schema-validated ops, ops confined to item subjects, protected nodes only flagged, undo for everything. |
| A company detail leaks into `me` | The deterministic sensitive-terms guard, the person-node rule, and dashboard review of `me`. Residual risk accepted. |
| `work` outgrows 1 GB on Free in about two years | Size caps, compaction, the 300-day purge, and Paid's 10 GB. |
| Losing `BACKUP_KEY` | An offline copy. Point-in-time restore does not need the key. |
| Account-level loss | Accepted. `agent-memory export --download` on demand. |
| Prompt injection through stored text | Data-not-instructions envelopes and skill rules, and maintenance runs with no tools. |

### Risks from the requirements, resolved

| Risk in `00-requirements.md` | Resolution |
|---|---|
| Clerk audience binding and loopback matching | Gate G1 with both auth paths specified (section 8) |
| Vectorize on Free | Not needed in v1 (open question 3) |
| Durable Object size per object on Free | Designed to 1 GB, sized in section 6 |
| MCP handler CPU against 10 ms | Gate G2 with a fallback dispatcher |
| Hook events for digests, turning off native memory | Verified (sections 10 and 16) |
| Google Drive API from a Worker | Verified (`drive.file` is non-sensitive and needs no app verification; a "Testing" app's refresh tokens expire in 7 days), then removed by the owner's backup decision |

## 25. Next implementation step

Write `profile/schema.ts`, `profile/write.ts` (`save` and `append` with `request_id` and `expected_revision`) and `profile/read.ts` (recall without vectors). Load them with the real 987k-character journal and the `work` export, and measure CPU per invocation (G2), while the owner creates the Clerk app for the token test (G1).

## Sources

All read on 2026-10-28. "Updated" is the page's own date where it shows one.

| Fact | Source | Updated |
|---|---|---|
| Workers Free: 10 ms CPU per request, 50 subrequests, 5 Cron Triggers, 10 ms per Cron invocation | https://developers.cloudflare.com/workers/platform/limits/ | 2026-10-12 |
| Durable Objects on Free are SQLite-only; Vectorize "only on the Workers paid plan" note | https://developers.cloudflare.com/workers/platform/pricing/ | 2026-10-02 |
| Durable Objects Free CPU 10 ms per invocation; Workflows 10 ms; D1, Queues, Vectorize, Workers AI allotments | https://www.cloudflare.com/plans.md | undated |
| Durable Object storage: 10 GB per object in the limits table, "1 GB on the Free plan" in the FAQ, 5 GB per account on Free | https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-06-01 |
| Durable Object Free limits: 100k requests, 13,000 GB-s, 5M rows read, 100k rows written per day; operations fail past a limit | https://developers.cloudflare.com/durable-objects/platform/pricing/ | 2026-10-18 |
| SQLite storage API: 30-day point-in-time restore, FTS5, index and virtual-table writes count as rows written | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ | 2026-09-21 |
| Vectorize Free allotments: 5M stored, 30M queried dimensions a month | https://developers.cloudflare.com/vectorize/platform/pricing/ | 2026-04-21 |
| Workers AI: 10k free neurons a day on both plans, $0.011 per 1k after; model prices | https://developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-10-20 |
| `qwen3-embedding-0.6b`: 8,192-token context, batch input; output size not documented | https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/ | undated |
| `bge-m3`: batch input | https://developers.cloudflare.com/workers-ai/models/bge-m3/ | undated |
| `createMcpHandler`: one server per request, no session, no Durable Object, `authContext` | https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/ | 2026-10-27 |
| MCP authorization 2026-07-28: protected resource metadata, RFC 8707, CIMD preferred | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization | rev 2026-07-28 |
| Claude Code hooks: `SessionEnd` input and 1.5 s default budget, `PreCompact`, async hooks | https://code.claude.com/docs/en/hooks | undated |
| Claude Code auto memory: `autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | https://code.claude.com/docs/en/memory | undated |
| Codex hooks: `SessionEnd` triggers, synchronous, 600 s default timeout, unstable transcript format | https://developers.openai.com/codex/hooks | undated |
| Codex memories: `features.memories`, `memories.generate_memories`, `memories.use_memories` | https://developers.openai.com/codex/memories and https://developers.openai.com/codex/config-reference | undated |
| `codex exec`: `--output-schema`, `--ephemeral`, `--sandbox` | https://developers.openai.com/codex/noninteractive | undated |
| Google OAuth: 7-day refresh tokens for "Testing" apps; `drive.file` non-sensitive | https://developers.google.com/identity/protocols/oauth2 and https://developers.google.com/workspace/drive/api/guides/api-specific-auth | 2026-10-16, 2026-09-03 |
| Clerk OAuth server, CIMD and DCR toggles, `authenticateRequest` with `jwtKey` | `research/03-platform-research.md` S32 to S35 | undated |
| Corpus build provenance (assembled 2026-08-12 from `/tmp` scratch databases) | `corpus_metadata` and `frontend_metadata` in `~/.bothq/corpus/sequoia.sqlite`, read-only | 2026-08-12 |
