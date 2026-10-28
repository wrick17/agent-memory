# Platform research: hosted memory MCP on Cloudflare with Clerk

Source: Opus (claude-opus-5-5, high) research task, 2026-10-28. All limits and prices read from official pages that day. [S#] ids map to the sources table. "Inference" marks reasoning; "unverified" marks claims not confirmed.

## 1. Cloudflare building blocks

| Item | Free | Paid | Src |
|---|---|---|---|
| Workers requests | 100k/day (Error 1027 when exceeded) | 10M/mo included, then $0.30/M | S1, S2 |
| Workers CPU per request | 10 ms | 30 s default, up to 5 min; 30M CPU-ms/mo included | S1, S2 |
| Subrequests per request | 50 | 10,000 | S1 |
| CPU accounting | Waiting on fetch, KV, DB does not count | same | S1 |
| Egress | No charge | No charge | S2 |
| Cron Triggers per account | 5 | 250 | S1 |
| DO SQLite storage per object | 1 GB per FAQ; limits table says 10 GB for all plans (doc contradicts itself) | 10 GB | S3 |
| DO storage per account | 5 GB | Unlimited | S3 |
| DO row/blob max, SQL statement, bound params | 2 MB, 100 KB, 100 | same | S3 |
| DO billing | 100k req/day, 13,000 GB-s/day, 5M rows read/day, 100k rows written/day | 1M req, 400k GB-s, 25B rows read, 50M rows written, 5 GB-mo included | S4 |
| DO SQLite extensions | FTS5 (with fts5vocab), JSON, math | same | S5 |
| DO point-in-time recovery | Any point in last 30 days; no plan split stated | 30 days | S5 |
| D1 max DB size | 500 MB, 10 DBs, 5 GB total | 10 GB, 50k DBs, 1 TB | S6 |
| D1 queries per invocation | 50 | 1,000 | S6 |
| D1 rows | 5M read/day, 100k written/day | 25B read, 50M written per month included | S7 |
| D1 FTS5 | Supported | same | S8 |
| D1 Time Travel | 7 days | 30 days, per-minute | S9 |
| D1 export | Fails on DBs with virtual tables (FTS5), blocks other requests while running | same | S11 |
| Vectorize | 100 indexes; 5M stored dims, 30M queried dims/mo | 50k indexes; 10M stored, 50M queried included, then $0.05/100M stored, $0.01/M queried | S12, S13 |
| Vectorize per-index | 1,536 max dims, 20M vectors, 10 KiB metadata, 10 metadata indexes, topK 50 with metadata / 100 without | same | S12 |
| Vectorize on Free | Vectorize pages list Free allotments; Workers pricing page says Paid only (conflict) | | S2, S13 |
| Workers AI | 10k neurons/day | $0.011 per 1k neurons above | S14 |
| Embedding prices per M tokens | bge-m3 $0.012; qwen3-embedding-0.6b $0.012; bge-small $0.020; bge-base $0.067; bge-large $0.204; reranker bge-reranker-base $0.003 | | S14 |
| embeddinggemma-300m | `@cf/google/embeddinggemma-300m`, beta; price and dims unverified | | S15 |
| AI Search (ex AutoRAG) | 100 instances, 100k files each | 5k instances, 1M files | S16 |
| AI Search pricing (billing from 2026-11-01) | Included/mo: 5M ingestion tokens, 10 GB-mo, 1k semantic + 1k full-text queries; then $0.75/M tokens, $2/GB-mo, $0.75/1k semantic, $0.10/1k full-text | same | S16 |
| R2 | 10 GB-mo, 1M Class A, 10M Class B, free egress | $0.015/GB-mo, $4.50/M A, $0.36/M B | S17 |
| KV | 100k reads/day, 1,000 writes/day, 1 GB, 1 write/s per key | Unlimited | S18 |
| Queues | 10k ops/day, 24 h retention | 1M/mo then $0.40/M | S19 |
| Workflows | 10 ms CPU/step, 1,024 steps, 100 concurrent, 3-day retention | 30 s to 5 min CPU/step, 10k to 25k steps, 30-day retention | S20 |
| Hyperdrive | Postgres/MySQL; 100k queries/day | Unlimited | S21, S22 |
| Containers | Not available | Lite 1/16 vCPU 256 MiB up to 4 vCPU 12 GiB; ephemeral disk; sleeps after 10 min; no runtime guarantee | S23, S24 |
| Native graph DB | None. Community pattern: graph tables in DO SQLite (Boris Tane, Oct 2025) | | search |

## 2. Remote MCP on Cloudflare

- `createMcpHandler` is recommended: Streamable HTTP only, new server per request, no MCP session, GET/DELETE return 405, no Durable Object required. [S25, S27]
- `McpAgent` is deprecated (migration guide exists). SSE is deprecated. [S25]
- Cross-request state goes in DO, D1, KV or R2 keyed by authenticated user, not session id. [S27]
- Auth: wrap the handler in `OAuthResourceServer` from `@cloudflare/workers-oauth-provider`; tools read identity via `getMcpAuthContext()`. `requiredScopes` is advertised only; handler must check scopes. [S26, S27]
- workers-oauth-provider classes: `OAuthAuthorizationServer`, `OAuthResourceServer` (via Service Binding), combined `OAuthProvider`. Supports PKCE, RFC 8707 resource binding, DCR, CIMD (needs `global_fetch_strictly_public` compat flag), pre-registered clients, RFC 7009 revocation. Stores hashed tokens in KV (`OAUTH_KV`), encrypted props; you build `/authorize` and consent; `beginUpstream()`/`finishUpstream()` delegate login upstream. [S26, S28]
- Cloudflare guides cover Stytch, Auth0, WorkOS, Descope, Access. Not Clerk. [S26]
- Tokens bind to `MCP_SERVER_URL`, which must match the client URL exactly. [S26]
- Per-session DO cost trap applied only to `McpAgent`. Stateless handler plus one DO per user/profile avoids it (inference). Supermemory still runs a DO per session. [S44]

## 3. MCP authorization, revision 2026-07-28

- Latest revision 2026-07-28 (previous 2025-11-25). [S29]
- Protocol sessions and `Mcp-Session-Id` removed; `initialize` removed, each request carries version in `_meta`; new mandatory `server/discover`; SSE resumability removed; `subscriptions/listen` replaces GET. [S29]
- Multi round-trip requests replace server-to-client requests; Tasks moved to an extension; Roots, Sampling, Logging deprecated. [S29]
- DCR deprecated in favor of CIMD (SHOULD support CIMD, DCR is MAY). ASes SHOULD send `iss` (RFC 9207); clients MUST validate it. Clients key credentials by issuer. [S29, S30]
- Servers MUST serve RFC 9728 protected resource metadata; ASes MUST serve RFC 8414 or OIDC discovery. 401 carries `resource_metadata` and SHOULD carry `scope`; 403 `insufficient_scope` for step-up. [S30]
- Clients MUST send RFC 8707 `resource` on authorize and token; servers MUST validate audience and MUST NOT pass tokens through. [S30]
- Refresh: clients MAY request `offline_access`; AS decides. [S30]
- Stable auth extensions: OAuth Client Credentials, Enterprise-Managed Authorization. [S31]

## 4. Clerk

- Full OAuth AS: auth code + PKCE, refresh via `offline_access`, Device Authorization Grant (RFC 8628). Client credentials not mentioned. [S32]
- Access tokens JWT by default (local verification) or opaque; 1 day lifetime; refresh tokens never expire; rotation undocumented. [S32]
- CIMD and DCR are separate dashboard toggles; Clerk recommends CIMD; DCR forces a consent screen. Default scopes configurable. [S32, S33]
- AS metadata at `/.well-known/oauth-authorization-server` on the Frontend API host. [S32]
- `@clerk/mcp-tools` (MIT): Express, Hono, Next adapters; no Workers mention; `fetchClerkAuthorizationServerMetadata` marked incomplete. [S34]
- `@clerk/backend` `authenticateRequest({ acceptsToken: 'oauth_token' })` verifies without network if `jwtKey` set; has `audience` option; no official Workers guide. [S35]
- RFC 8707 to `aud` mapping unverified; community PRs mention `aud_claim_enabled` and an SDK bug dropping `aud`. [search]
- Hobby plan: 50k monthly retained users per app, 3 seats, fixed 7-day session, Clerk branding, no MFA/passkeys. Pro $25/mo. [S36]
- API keys (GA 2026-04): 1k creations, 100k verifications/mo free. M2M tokens: 2.5k creations, 100k verifications/mo free. [S37]
- Owner's account (observed in Helium 2026-10-28): two production apps exist, "Bot Dashboard" (botter.wrick17.com) and "Postplan" (drafts.wrick17.com). No memory app yet.

## 5. MCP clients

| Client | Remote + OAuth | CIMD | Tokens and refresh | Headless | Static fallback | Src |
|---|---|---|---|---|---|---|
| Claude Code | HTTP; `/mcp` or `claude mcp login` | Yes | Auto refresh, requests `offline_access` when advertised, retries once on 401 | `--no-browser` prints URL, paste redirect back; `claude -p` and SDK cannot complete OAuth | `--header`; `headersHelper` re-runs on 401/403 | S38 |
| Codex CLI | `codex mcp login`; validates `iss` | CIMD hosted at chatgpt.com, then DCR | `mcp_oauth_credentials_store` auto/file/keyring; refresh undocumented | `mcp_oauth_callback_url` and port settings | `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper` | S39 |
| Cursor | Streamable HTTP + SSE; PKCE; DCR | Unverified | Refreshes if refresh token exists | Undocumented | `headers` with `${env:NAME}` | S40 |
| claude.ai / Desktop / mobile | Needs real 401; first `authorization_servers` entry only; callback `https://claude.ai/api/mcp/auth_callback`; calls from 160.79.104.0/21 | Only if AS metadata has `client_id_metadata_document_supported: true` and `none` auth method | Refresh on 401 and up to 5 min before expiry; wants rotated refresh tokens | n/a | `static_headers` beta only | S41 |
| T3 Code | Drives installed Claude Code and Codex CLIs | n/a | Same as CLIs (inference) | Same | Same | S42 |

Claude Code CIMD declares `http://localhost/callback` and `http://127.0.0.1/callback`; AS must match loopback URIs on any port. Clerk behavior unverified. [S41]

## 6. Prior art

| Project | Storage | Change over time | Auth | License | Copy / avoid |
|---|---|---|---|---|---|
| Cloudflare Agent Memory (private beta) | One DO (SQLite+FTS) + one Vectorize index per profile; Workers AI | Content-addressed message ids with INSERT OR IGNORE; LLM extraction plus verifier; types fact/event/instruction/task; topic-key supersession with version chains; 5-channel retrieval (FTS, key, raw FTS, vector, HyDE) fused by RRF | Binding/REST, no MCP | Free for now | Copy idempotent ids, supersession chains, RRF, raw-text fallback, date math in code |
| Supermemory | Graph engine + embeddings | Supersedes, expires temporary facts, forgets | OAuth + `sm_` API keys; Workers, DO per session, Hono | MIT | Copy API-key fallback; avoid DO per session |
| mem0 | Vectors + BM25 + entity linking | April 2026 algorithm is single-pass ADD-only, no LLM UPDATE/DELETE | API key | Apache-2.0 | Signal: dropped LLM-driven update/delete |
| Graphiti (Zep) | Temporal KG on Neo4j/FalkorDB/Neptune | Bi-temporal invalidation, not deletion; episodes for provenance | Reference MCP has no auth | Apache-2.0 | Copy validity windows and provenance; avoid heavy LLM pipeline and graph DB |
| Letta | DB | Editable memory blocks pinned in context | n/a | Apache-2.0 | Copy a small pinned core block |
| Basic Memory | Markdown + SQLite index (or Postgres), hybrid search | Wikilinks form the graph | Cloud $15/mo | AGPL-3.0 | Copy human-readable markdown export |
| Community CF repos (Puliczek/mcp-memory, frank-memory, memoryvault, cf-agent-memory) | D1 or DO + Vectorize | Varies | Access or OAuth | Mostly MIT | Not inspected in depth |

## 7. Cost traps (inference, about 4 chars per token)

- Initial embedding of 5.5M chars (about 1.4M tokens): bge-m3 about 1.5k neurons (under one free day); bge-base about 8.5k; bge-large about 26k (about $0.18).
- Vectorize: 5,500 chunks x 1,024 dims = 5.6M stored dims, over Free 5M; 768 dims = 4.2M fits.
- Vectorize query billing (queries + stored vectors) x dims: at 5.5k vectors x 768, Free allows about 33k queries/month.
- Rows written: FTS5 shadow tables and indexes multiply writes; Free cap 100k/day; bulk import may span days.
- Storage: 5.5 MB text plus FTS far below limits.
- CPU: awaiting bindings is free; RRF over about 100 hits well under 10 ms; MCP SDK per-request setup on Free unmeasured (benchmark).
- KV: workers-oauth-provider writes tokens to KV, 1k/day Free, fine for one user.
- Neo4j in Containers: ephemeral disk, Paid only, about $26/mo memory alone. Aura Free pauses after 3 days without writes, deleted after 30 paused days. Neon Free 1 GB, suspends after 5 min idle.

## Storage options

| Criterion | DO SQLite | D1 | Postgres via Hyperdrive | Neo4j |
|---|---|---|---|---|
| Fits Free | Yes, 1 GB/object, 5 GB/account | Yes, 500 MB/DB | Neon Free 1 GB | Aura Free auto-delete risk; Container Paid only |
| Full-text | FTS5 | FTS5 | tsvector | Separate |
| Vectors | Vectorize | Vectorize | pgvector | Not on Aura Free |
| Point-in-time restore | 30 days | 7 Free / 30 Paid | Neon Free 6 h | Not checked |
| Export | Custom R2 dumps needed | Blocked by FTS5 virtual tables | pg_dump | Not checked |
| Write model | Single object serializes writes (suits idempotent appends) | Shared DB | Standard | n/a |
| Graph | Edge tables + recursive CTEs | Same | Same | Native |
| Ops | Co-located, no outside vendor | Same | Outside vendor, cold starts | Outside vendor or unreliable container |

## Auth options

| Criterion | Clerk as AS directly | workers-oauth-provider fronting Clerk |
|---|---|---|
| Build | Resource server only (RFC 9728 metadata to Clerk issuer + JWT checks) | Own AS; `/authorize` signs in with Clerk then `completeAuthorization({ userId })` |
| Audience binding (spec MUST) | Unverified | Built in (RFC 8707) |
| CIMD/DCR | Clerk toggles; DCR forces consent | Library flags; own consent |
| Loopback any-port | Unverified | Under our control |
| Refresh | Never expire; rotation undocumented | Library-managed |
| Scopes | Clerk set; custom unverified | Own |
| Free cost | No KV | KV writes per issue/refresh (1k/day Free) |
| Risk | Clerk interop quirks | More security-critical code |

Headless fallback works with either: static bearer tokens via Claude Code `headersHelper`, Codex `bearer_token_env_var`, Cursor `${env:}` headers. This is outside MCP OAuth, a deliberate spec deviation.

## Verified Free-plan blockers

1. Containers not on Free, so self-hosted Neo4j is out. [S23]
2. 10 ms CPU per request, 100k requests/day. [S1]
3. DO SQLite 1 GB/object and 5 GB/account (doc conflict with 10 GB row). [S3]
4. D1 500 MB/DB, 50 queries per invocation. [S6]
5. DO and D1 100k rows written/day. [S4, S7]
6. Vectorize 5M stored and 30M queried dims/month; one CF page says Paid only. [S2, S13]
7. Workers AI 10k neurons/day. [S14]
8. KV 1k writes/day, Queues 10k ops/day, Workflows 10 ms CPU/step, 5 cron triggers, 50 subrequests. [S1, S18, S19, S20]

Only item 1 rules out a design. The rest constrain bulk import, LLM consolidation and multi-user scale.

## Sources

| ID | URL | Updated |
|---|---|---|
| S1 | https://developers.cloudflare.com/workers/platform/limits/ | 2026-10-12 |
| S2 | https://developers.cloudflare.com/workers/platform/pricing/ | 2026-10-02 |
| S3 | https://developers.cloudflare.com/durable-objects/platform/limits/ | 2026-06-01 |
| S4 | https://developers.cloudflare.com/durable-objects/platform/pricing/ | 2026-10-18 |
| S5 | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ | 2026-09-21 |
| S6 | https://developers.cloudflare.com/d1/platform/limits/ | 2026-10-24 |
| S7 | https://developers.cloudflare.com/d1/platform/pricing/ | 2026-04-21 |
| S8 | https://developers.cloudflare.com/d1/sql-api/sql-statements/ | 2026-04-21 |
| S9 | https://developers.cloudflare.com/d1/reference/time-travel/ | 2026-04-21 |
| S10 | https://developers.cloudflare.com/d1/best-practices/read-replication/ | 2026-08-10 |
| S11 | https://developers.cloudflare.com/d1/best-practices/import-export-data/ | 2026-04-21 |
| S12 | https://developers.cloudflare.com/vectorize/platform/limits/ | 2026-08-05 |
| S13 | https://developers.cloudflare.com/vectorize/platform/pricing/ | 2026-04-21 |
| S14 | https://developers.cloudflare.com/workers-ai/platform/pricing/ | 2026-10-20 |
| S15 | https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/ | undated |
| S16 | https://developers.cloudflare.com/ai-search/platform/limits-pricing/ | 2026-10-01 |
| S17 | https://developers.cloudflare.com/r2/pricing/ | 2026-10-26 |
| S18 | https://developers.cloudflare.com/kv/platform/limits/ | 2026-10-08 |
| S19 | https://developers.cloudflare.com/queues/platform/pricing/ | 2026-04-21 |
| S20 | https://developers.cloudflare.com/workflows/reference/limits/ | 2026-09-21 |
| S21 | https://developers.cloudflare.com/hyperdrive/ | 2026-10-21 |
| S22 | https://developers.cloudflare.com/hyperdrive/platform/pricing/ | 2026-06-18 |
| S23 | https://developers.cloudflare.com/containers/pricing/ | 2026-10-05 |
| S24 | https://developers.cloudflare.com/containers/faq/ | 2026-10-05 |
| S25 | https://developers.cloudflare.com/agents/model-context-protocol/transport/ | 2026-10-27 |
| S26 | https://developers.cloudflare.com/agents/model-context-protocol/authorization/ | 2026-10-27 |
| S27 | https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/ | 2026-10-27 |
| S28 | https://github.com/cloudflare/workers-oauth-provider | undated |
| S29 | https://modelcontextprotocol.io/specification/latest/changelog | rev 2026-07-28 |
| S30 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization | rev 2026-07-28 |
| S31 | https://github.com/modelcontextprotocol/ext-auth | undated |
| S32 | https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth | undated |
| S33 | https://clerk.com/docs/nextjs/guides/ai/mcp/build-mcp-server | undated |
| S34 | https://github.com/clerk/mcp-tools | undated |
| S35 | https://clerk.com/docs/reference/backend/authenticate-request | undated |
| S36 | https://clerk.com/pricing | undated |
| S37 | https://clerk.com/changelog/2026-04-17-api-keys-ga and https://clerk.com/docs/guides/development/machine-auth/m2m-tokens | 2026-04-17 / undated |
| S38 | https://code.claude.com/docs/en/mcp | undated |
| S39 | https://learn.chatgpt.com/docs/extend/mcp?surface=cli and https://developers.openai.com/codex/config-reference | undated |
| S40 | https://cursor.com/docs/context/mcp | undated |
| S41 | https://claude.com/docs/connectors/building/authentication | undated |
| S42 | https://github.com/pingdotgg/t3code | undated |
| S43 | https://blog.cloudflare.com/introducing-agent-memory/ and https://developers.cloudflare.com/agent-memory/platform/pricing/ | 2026-04-17 / 2026-06-02 |
| S44 | https://github.com/supermemoryai/supermemory | undated |
| S45 | https://github.com/mem0ai/mem0 | undated |
| S46 | https://github.com/getzep/graphiti | undated |
| S47 | https://docs.letta.com/guides/agents/memory | undated |
| S48 | https://github.com/basicmachines-co/basic-memory | undated |
| S49 | https://neo4j.com/pricing/ | undated |
| S50 | https://neon.com/pricing | undated |

Not checked: Letta archival/sleep-time agents; Clerk custom domain and custom scopes on free plan; Cursor CLI headless auth; whether DO/Vectorize/AI bindings count as subrequests; MCP SDK per-request CPU on Free.
