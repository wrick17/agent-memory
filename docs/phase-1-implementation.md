# Phase 1 implementation

Author: Opus (`claude-opus-5-5`), 2026-10-28, revised the same day for review findings F1 to F5 ([review](review-sol-phase1-2026-10-28.md#must-fix), [fixes](#review-fixes-f1-to-f5)). This records what phase 1 builds, what the local checks prove, and what still needs live evidence. It is implementation evidence, not gate evidence: nothing here is deployed, and the application tests used no real Clerk token, Workers AI call or Vectorize index. Infrastructure evidence (discovery, measured embedding size, provisioned resources) is Terra's, in [phase-1-setup.md](phase-1-setup.md) and [phase-1-verification.md](phase-1-verification.md).

Design source: [architecture v3.2](architecture.md), section 22 (phase 1) and section 25. Setup evidence: [phase-1-setup.md](phase-1-setup.md), owned by Terra.

## What exists

| Area | Files | Behavior |
|---|---|---|
| Worker | `src/worker.ts` | `/mcp`, `/v1/whoami`, `/api/*`, `/settings`, protected-resource metadata. Fails closed with 503 when `OWNER_USER_ID` is unset. |
| Auth | `src/auth.ts`, `src/egress.ts` | Clerk JWTs verified locally with WebCrypto (RS256, known `kid`, `iss`, `aud` containing `RESOURCE_URL`, `exp`/`nbf` with 60 s skew, `sub` = owner). Access tokens need both the audience and the `memory` scope; an unset `REQUIRED_SCOPE` refuses every access token rather than skipping the check. Keys cached in isolate memory and the Cache API for an hour; an unknown `kid` refetches at most once a minute; a cold cache with Clerk unreachable returns 503. Dashboard session tokens are checked against `azp`. Device tokens `am_<tag>_<id>_<secret>`. `egress.ts` is the only `fetch` and allows only the Clerk Frontend API host over HTTPS. |
| Routing | `src/routing.ts` | Pure `routeWrite()` and `readSet()` in the section 9 order: bound `request_id`, explicit profile, remote globs then path prefixes, device default, else `route_required`. Nothing routes to `me` by default. |
| `me` guard | `src/domain/guard.ts`, run in `src/profile/write.ts` | Explicit `profile: "me"`, `company_free` from a `work` context, sensitive terms (org names from `work` routing rules plus owner-added terms), and no emails or phone numbers. It runs inside the `me` profile's write transaction, after the check for a committed request result and before any change, so only a committed result can replay without it. A refused write releases its request binding. |
| AccountStore v1 | `src/account/store.ts`, `src/account/schema.ts` | Profiles `me`, `work`, `personal`, `test`; devices; routing rules seeded from `ROUTING_DEFAULTS`; `node_index`; `request_index` bound before any profile write; the `generations` mirror; daily embedding meter. Every row carries `seq`, with `deleted_rows` tombstones. |
| Generation identities | `src/account/store.ts` | Each live generation id is 64 random bits (13 base32 characters), reserved as `generations/<id>.json` in R2 before use and marked `active`; an id already in the ledger is drawn again. Namespaces and vector ids over 64 bytes are refused. |
| ProfileStore v1 | `src/profile/schema.ts`, `write.ts`, `read.ts`, `index.ts`, `store.ts` | Schema v1 tables only (section 5 v1 list), FTS5 porter and trigram indexes kept to live recall rows by triggers, seq stamps and tombstones on every base table. One `transactionSync` per write, refused past 1,000 rows or 1 MB of UTF-8 parameters. Replacing content keeps earlier append entries as non-live history. |
| Tools | `src/mcp.ts` | `save_memory`, `append_memory`, `get_memory`, `recall_memories`, filtered by token scope. Exact, literal (trigram), full-text (bm25) and vector channels, RRF k=60, BothQ literal boosts, origin weights, cross-profile second RRF, token-budget packing. Empty keyword pages the whole inventory through `next_cursor`. |
| Embeddings | `src/profile/index.ts` | The card is the kind, name, description, why and the first 1,200 characters of the current content (body, then live entries), read without scanning the whole record; an append that changes that prefix makes the card due. Alarm stage `embed`: 16 cards per call to `@cf/qwen/qwen3-embedding-0.6b`, upserted as `g<generation>:<node id>` into `<userId>:<profile>:g<generation>` with metadata `{kind, gen}`; `embed_hash` recorded only if the card did not change. `EMBEDDINGS=off` skips both the stage and the vector channel. |
| Settings | `src/settings.ts`, `src/api.ts` | Loads `@clerk/ui@1` and `@clerk/clerk-js@6` from the Frontend API, calls `Clerk.load({ ui: { ClerkUI }, telemetry: false })`, then signs in and lists, creates (token shown once) and revokes devices. A missing script or a failed `load()` shows which part failed. Strict CSP with exact hosts ([live fix](#settings-sign-in-fix-after-deployment)). |
| Tooling | `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.github/workflows/ci.yml` | CI runs `wrangler types --check`, typecheck, lint and the Workers test pool. |

## Protocol and library checks

- `@modelcontextprotocol/server` 2.3.1 (the v2 SDK) serves MCP `2026-07-28` and, through its stateless legacy leg, 2025-era clients (`2025-11-25` and earlier). The v1 SDK, 1.32.2, stops at `2025-11-25`. `agents` 0.31.0 `createMcpHandler` is a wrapper over the same v2 handler, so the Worker uses the v2 SDK directly and the hand-written dispatcher is not needed.
- On `2026-07-28` the client must send `MCP-Protocol-Version`, `Mcp-Method` (and `Mcp-Name` for `tools/call`) headers and the `_meta` envelope; the test client does.
- `@cloudflare/vitest-pool-workers` is deprecated and renamed `@cloudflare/vitest-plugin` (1.4.9 here). `typescript-eslint` 8.72 supports TypeScript below 6.1, so TypeScript is pinned at 6.0.3.
- `@cf/qwen/qwen3-embedding-0.6b` is documented at 1,024 dimensions, cosine (Cloudflare AI Search supported-models table and the 2026-04-09 changelog). Terra's synthetic live call measured 1,024 ([setup](phase-1-setup.md#infrastructure-verification-2026-10-28)).

## Scoped checks run

| Command | Result |
|---|---|
| `npm run typecheck` | No errors |
| `npm run lint` | No errors. A probe file calling `fetch` outside `egress.ts` and one importing `./profile/write` from outside the folder each fail lint. |
| `npx wrangler types --strict-vars=false --check` | Types up to date |
| `npx wrangler deploy --dry-run --env="" --outdir /tmp/am-bundle` | Bundles: 1,326.89 KiB, 240.86 KiB gzipped after the Settings fix; bindings listed below. The dry run deploys nothing. |
| `npm test` | 4 files, 38 tests passed, in workerd with real SQLite Durable Objects and local R2 (35 before the Settings fix) |
| Reviewer harness, `node node_modules/vitest/vitest.mjs run --config /private/tmp/am-phase1-review-gb0ebmnc/vitest.config.ts` | 7 passed, including the F1, F1b, F2, F3, F4 and F5 reproductions, against the fixed source |

### Test coverage by gate

| Gate item | Test | Scope of the evidence |
|---|---|---|
| G3 replay returns the stored result; changed payload `idempotency_mismatch` | `test/g3-contracts.test.ts` | Local |
| G3 stale revision `revision_conflict` (update and append) | same | Local |
| G3 two machines, 100 concurrent appends each: 200 entries, gapless `entry_seq` 1 to 200, none lost | same; one OAuth context with a device header, one device token | Local, one workerd process; not two physical machines |
| G3 supersession atomic, and a failed supersede changes nothing | same | Local |
| G3 procedural validation matches BothQ messages | same | Local |
| G3 retry after a routing-rule change replays in the original profile | same | Local |
| G3 empty keyword enumerates 250 records through `next_cursor` | same | Local |
| G3 content paging returns `revision_conflict` when an append lands between pages | same | Local |
| BothQ `content_hash` parity | same; expected value computed with BothQ's `_hash(content_source())` | Local |
| G4 personal device token cannot read work; recall routed to work reads only work and me; same name in work and me gets two ids, both recalled; `me` refused without `company_free` | `test/isolation-recall.test.ts` | Local |
| G5 vector channel returns the record once embedded; lexical answer within the time limit when Vectorize is slow or failing; `EMBEDDINGS=off` says `lexical_only` | same | Local fakes for Workers AI and Vectorize (`test/fakes.js`) |
| Generation ids reserved in the R2 ledger; redraw on collision; 64-byte refusal | same | Local R2 |
| `/mcp` end to end on `2026-07-28`, 2025-era stateless client, tools by scope, revocation on the next request, foreign Origin refused | `test/mcp-auth.test.ts` | Tokens signed by a test key; JWKS served by a stubbed `fetch` |
| JWT refusals: issuer, audience, owner, expiry, signature, unknown `kid`, missing scope (403); 503 on unreachable keys | same | Verifier rules only, not Clerk's real tokens |
| Owner API: create and list devices with a session token, refuse device tokens and foreign `azp` | same | Local |
| Rename and scope move keep the id; retire; history window with append deltas; redaction before hashing; seq stamps and tombstones | `test/write-details.test.ts` | Local |

## Bindings for provisioning

Non-secret names, as in `wrangler.jsonc`:

| Binding | Resource | Notes |
|---|---|---|
| `ACCOUNT` | Durable Object class `AccountStore` | SQLite, migration tag `v1` |
| `PROFILE` | Durable Object class `ProfileStore` | SQLite, migration tag `v1` |
| `AI` | Workers AI | Model `@cf/qwen/qwen3-embedding-0.6b` |
| `VECTORS` | Vectorize index `agent-memory-cards` | 1,024 dimensions, cosine; a string metadata index on `kind` (used by the `kinds` filter) |
| `BACKUPS` | R2 bucket `agent-memory-backups` | Holds the generation ledger under `generations/` in phase 1 |

Variables: `RESOURCE_URL`, `CLERK_ISSUER`, `CLERK_FRONTEND_API`, `CLERK_PUBLISHABLE_KEY`, `REQUIRED_SCOPE`, `DASHBOARD_ORIGIN`, `EMBEDDINGS`, `ROUTING_DEFAULTS`, `OWNER_USER_ID`. No secrets are needed in phase 1 (`BACKUP_KEY` arrives with exports in phase 2). No route or custom domain is configured.

## Review fixes F1 to F5

Each finding from the [phase-1 review](review-sol-phase1-2026-10-28.md#must-fix) has a regression in an existing suite. All five regressions failed against the unfixed source for the reason the review gives, then passed after the fix.

| Finding | Fix | Regression |
|---|---|---|
| F1 P1: a pending request binding skipped the `me` guard (crash after binding; overlapping identical calls) | The guard moved from the Worker into the `me` profile's write transaction (`runWrite` in `src/profile/write.ts`). It runs after the check for a committed request result and before any change. A committed result still replays without it; any call that can still write passes it. | `test/isolation-recall.test.ts`: "never lets a pending request binding skip the me guard" (a seeded pre-guard binding, and two overlapping identical calls); "still replays a committed me write after the guard would refuse it" |
| F1 replay after routing-rule changes | Unchanged: a committed result replays in its bound profile | `test/g3-contracts.test.ts` routing-change case, still passing |
| F2 P1: replacing content deleted earlier append deltas | `writeBody()` deletes only the earlier body, whose text is in the previous revision snapshot. Earlier entries become `live = 0` with this write's `seq`, which removes them from current content and both FTS indexes through the existing triggers. The rows count against the 1,000-row bound before the update runs. | `test/write-details.test.ts`: the history case now replaces content and appends again; revisions 1 to 7 keep every delta, current content is only the new text, and recall no longer finds the old entry |
| F3 P2: appends left the embedding card stale | `readPrefix()` reads the first 1,200 characters across the body and live entries, stopping at the rows it needs. Create, update, append and the `embed` stage all use it. An append recomputes the card only while the content is shorter than 1,200 characters, and makes it due only if the hash changed. | `test/isolation-recall.test.ts`: "re-embeds a journal when an append changes its first 1,200 characters, and only then" |
| F4 P2: the 1 MB bound counted characters | `Tx` counts `Buffer.byteLength(param, "utf8")`. Overflow throws inside the transaction, so nothing commits and the request binding is released. | `test/write-details.test.ts`: "counts UTF-8 bytes and rolls the whole write back past 1 MB" (90 supersedes of 4,000 CJK characters: refused, nothing changed, the request id reusable) |
| F5 P2: expiry compared ISO strings lexically | `createDevice` stores expiry as UTC ISO; `deviceCaller` compares parsed epoch times, and an unreadable stored date refuses the token | `test/mcp-auth.test.ts`: "refuses an expired device token whatever the timezone offset, and fails closed on a bad stored date" |

The implementation report no longer suggests emptying `REQUIRED_SCOPE`; `src/auth.ts` now refuses access tokens when it is unset.

## Settings sign-in fix after deployment

The first production check of Worker version `6eb6b8d3-f626-4b65-811a-7d5a6ca59e5e` showed no sign-in on `/settings`. The console reported `Clerk was not loaded with Ui components`, and CSP blocked a Clerk protection script ([live evidence](phase-1-verification.md#production-deployment-and-first-live-observations)).

**Cause, traced in the current SDK.** In the `@clerk/clerk-js@6` browser bundle served by the Frontend API, `load()` creates the component layer only when its options carry `ui.ClerkUI`, and `mountSignIn` then calls `assertComponentsReady`, which throws that exact message. The page loaded only `clerk.browser.js` and called `Clerk.load()` with no options. Clerk's current JavaScript quickstart (script-tag setup) loads `https://<Frontend API>/npm/@clerk/ui@1/dist/ui.browser.js` first and calls `Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })`. The blocked script was this instance's protect loader. `/v1/environment` names it in `protect_config`: `https://cdn.protect.clerk.com/ins_3LKOqGARK9NsjTwXYqM0OWZ4OyN/c/{cid}/bootstrap.js`.

| Change | Where |
|---|---|
| Load `@clerk/ui@1` before `@clerk/clerk-js@6`, both `defer` and `crossorigin="anonymous"`, as in Clerk's quickstart | `SETTINGS_HTML` in `src/settings.ts` |
| `Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, telemetry: false })`. A missing ClerkJS or UI bundle, a failed `load()` and a failed `mountSignIn` each show their reason in the status line. | `settingsMain` in `src/settings.ts` |
| The browser code is a TypeScript function served by `toString()`, so tests run the code the browser gets. A one-line `__name` shim covers the helper that Wrangler's esbuild `keep_names` inserts. | `SETTINGS_JS` in `src/settings.ts` |
| `script-src` adds the exact host `https://cdn.protect.clerk.com`. `connect-src` stays `'self'` and the Frontend API, since telemetry is off. | `CSP` in `src/api.ts` |

The CSP after the fix is `default-src 'none'; script-src 'self' <Frontend API> https://challenges.cloudflare.com https://cdn.protect.clerk.com; connect-src 'self' <Frontend API>; img-src 'self' https://img.clerk.com; style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. Clerk's CSP guide also lists `https://*.protect.clerk.com` for `script-src` and `frame-src`, and `https://*.protect.clerk.com:*` for `connect-src`. Those wildcards are left out. The protect bootstrap fetched for this instance, with an anonymous client id, returned a 121-byte stub that loads nothing else. If the browser reports another blocked protect host, add that exact host and port. `style-src 'unsafe-inline'` remains because Clerk's components inject runtime styles, as before.

| Check | Result |
|---|---|
| `test/mcp-auth.test.ts`, "Settings page start-up" (3 tests) | Passes. A fake ClerkJS enforces the rule above. On the old start-up (`load()` without `ui`) the first test fails with `Sign-in could not start: Clerk was not loaded with Ui components`, the live message. |
| Settings response test | The CSP has the exact `script-src`, and no `*`, bare `https:`, `'unsafe-eval'` or script `'unsafe-inline'` |
| The served script from the production dry-run bundle, run in Node `vm` against the same fake | Mounted sign-in, passed `ui.ClerkUI` and `telemetry: false`; the bundle references no helper other than the shimmed `__name` |
| `npm run check` | Typecheck and lint clean; 4 files, 38 tests passed |

This shows the start-up follows ClerkJS's documented contract. It does not show that Clerk's UI renders in a real browser, which is Terra's check after redeploy. Owner, issuer, audience and `memory` scope checks are unchanged.

## Live gates still open

- **G1, all of T1 to T6.** Needs real tokens from Claude Code and Codex against the deployed Worker. Terra reports that Clerk discovery publishes issuer `https://clerk.memory.wrick17.com`, which matches `CLERK_ISSUER`. The real access token must carry the resource in `aud` and `memory` in `scope` or `scp`; both stay required. If Clerk cannot satisfy them, the specified fallback (section 8) is the only alternative. Refresh (T4) is untested.
- **G5.** Local real Claude Code, Codex and headless checks after the reviewed deployment, then a second machine later. Terra measured 1,024 dimensions from a synthetic live call and the parent confirmed the `kind` String metadata index; live vector retrieval through the Worker and the query-embedding latency are untested.
- **Settings page in a browser.** The correction is deployed and the sign-in form renders, but the console reports CSP violations for a blob image and a Clerk protection probe. The original author must address those before the clean-console check and device tests can pass. See [live evidence](phase-1-verification.md#settings-correction-redeployment-and-browser-check).
- **G3 across physical machines.** The local test runs both callers in one process.

## Deviations and interpretations

- `action` is `created` for a new record, as the design table says; BothQ said `saved`. Other BothQ result fields (`ok`, `memory_id`, `name`, `type`, `scope`, `revision`, `content_hash`) are kept.
- `type: "project"` without `kind` becomes a `decision` when `why` is given and a `journal` otherwise, so BothQ-style journal saves keep working. An explicit `decision` needs `why`. The evidence-pointer rule for decisions is left to `record_knowledge` in phase 3.
- Appends chain the content hash (`sha256(previous + sha256(separator + entry))`) so an append costs the same on a large journal. Saved and updated records hash exactly as BothQ does.
- Name lookups match the normalized, case-insensitive name; BothQ matched the stored name exactly.
- `retired` and `superseded` revision snapshots record `content_unchanged: true` instead of repeating the content, to keep one write under 1 MB when 100 records are superseded.
- A changed `profile` on an existing record is refused with `validation`; transfers arrive in phase 3. `expand` and `include_captures` are accepted and have no effect until phases 3 and 2.
- `activity.undo` is left null; undo arrives in phase 3.
- `OWNER_USER_ID` is a public variable, not a secret, per the parent's note.

## Known limits

- shortcut: the query embedding has its own 1 s bound in `src/mcp.ts`; measure live latency in G5 and tighten.
- shortcut: `toLowerCase()` stands in for Python's `casefold()` in name normalization (`src/domain/ids.ts`); revisit in the migration import.
- A Worker crash after binding a `request_id` and before the profile write leaves a binding with no result. A retry with the same payload proceeds; a retry with a changed payload is refused until the id changes.
- The Origin check refuses browser-based MCP clients from other origins. Claude Code and Codex send no Origin.
- Replacing the content of a record with more than about 1,000 live append entries is refused with `size_budget`, because each entry row that becomes history counts against the 1,000-row bound. Journal compaction arrives in phase 3.
- Sensitive terms for the `me` guard come from routing-rule org names and owner-added terms only; entity terms arrive with `record_knowledge` in phase 3.
- Test output includes two `uncaught exception` lines from the intentional fake failures in `test/fakes.js`, and Wrangler warns that `env.test` omits `ai` and `vectorize` on purpose.
