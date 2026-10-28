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
| Settings | `src/settings.ts`, `src/api.ts` | Loads `@clerk/ui@1` and `@clerk/clerk-js@6` from the Frontend API, calls `Clerk.load({ ui: { ClerkUI }, telemetry: false })`, then signs in and lists, creates (token shown once) and revokes devices. A missing script or a failed `load()` shows which part failed. CSP limited to Clerk's documented sources ([live fix](#settings-sign-in-fix-after-deployment), [CSP correction](#csp-correction-clerks-documented-protect-sources)). |
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
| G5 vector channel returns the record once embedded; lexical answer within the time limit when Vectorize is slow or failing (since 2026-10-28, the shared 3 s deadline: see the [semantic deadline change](#semantic-deadline-change)); `EMBEDDINGS=off` says `lexical_only` | same | Local fakes for Workers AI and Vectorize (`test/fakes.js`) |
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
| `script-src` added `https://cdn.protect.clerk.com`. Superseded by the [CSP correction](#csp-correction-clerks-documented-protect-sources): an exact host is not enough. | `CSP` in `src/api.ts` |

That first CSP allowed only the exact protect loader host. It was wrong; see the correction below. `style-src 'unsafe-inline'` remains because Clerk's components inject runtime styles, as before.

| Check | Result |
|---|---|
| `test/mcp-auth.test.ts`, "Settings page start-up" (3 tests) | Passes. A fake ClerkJS enforces the rule above. On the old start-up (`load()` without `ui`) the first test fails with `Sign-in could not start: Clerk was not loaded with Ui components`, the live message. |
| Settings response test | Superseded by the full-policy test in the correction below |
| The served script from the production dry-run bundle, run in Node `vm` against the same fake | Mounted sign-in, passed `ui.ClerkUI` and `telemetry: false`; the bundle references no helper other than the shimmed `__name` |
| `npm run check` | Typecheck and lint clean; 4 files, 38 tests passed |

This shows the start-up follows ClerkJS's documented contract. It does not show that Clerk's UI renders in a real browser, which is Terra's check after redeploy. Owner, issuer, audience and `memory` scope checks are unchanged.

## CSP correction: Clerk's documented protect sources

The redeployed fix (version `0b2ef0d6-2149-48df-8f26-c3e8184f9efc`) rendered the real Clerk sign-in form. The console still reported two CSP violations: `img-src` blocked a `blob:` image, and `connect-src` blocked an instance-specific `client.protect.clerk.com` probe ([browser check](phase-1-verification.md#settings-correction-redeployment-and-browser-check)). The earlier choice to allow single protect hosts caused the second.

**Do not narrow these sources to single hosts.** Clerk's CSP guide (`https://clerk.com/docs/guides/secure/best-practices/csp-headers`, fetched 2026-10-28) lists the protect sources as required. Clerk serves its abuse and fraud protection from per-instance and per-client subdomains of `protect.clerk.com`. This instance's loader is on `cdn.` and the live probe went to a `client.` host, on ports other than 443. A source with no port matches only port 443, so `connect-src` needs `:*`.

| Directive | Sources | Why |
|---|---|---|
| `default-src` | `'none'` | Everything else is denied |
| `script-src` | `'self'`, the Frontend API, `https://challenges.cloudflare.com`, `https://*.protect.clerk.com` | Documented: clerk-js, `@clerk/ui` and their chunks; Turnstile; the protect loader |
| `connect-src` | `'self'`, the Frontend API, `https://*.protect.clerk.com:*` | Documented, including the port wildcard; `/api` calls go to `'self'` |
| `img-src` | `'self'`, `https://img.clerk.com`, `blob:` | `img.clerk.com` is documented; `blob:` is the image the live sign-in page created |
| `style-src` | `'self'`, `'unsafe-inline'` | Documented; Clerk's components inject runtime styles |
| `frame-src` | `https://challenges.cloudflare.com`, `https://*.protect.clerk.com` | Documented |
| `worker-src` | `'self'`, `blob:` | Documented; ClerkJS starts a timer worker from a blob URL |
| `form-action`, `base-uri`, `frame-ancestors` | `'self'`, `'none'`, `'none'` | Unchanged |

The only wildcard is Clerk's documented `*.protect.clerk.com` subdomain pattern; `:*` appears only in `connect-src`. No universal `*`, scheme-wide `https:`, `http:` or `data:`, `'unsafe-eval'` or script `'unsafe-inline'` is allowed, and no telemetry, Stripe or maps origin is added: telemetry is off, and billing and maps are unused. `blob:` appears only in `img-src` and `worker-src`.

| Check | Result |
|---|---|
| Settings response test in `test/mcp-auth.test.ts` | Compares the whole policy, directive by directive, with the table above. It also checks that every wildcard source is the protect pattern, with no universal or scheme-wide source and no script `'unsafe-inline'`. It fails on the committed `3e27817` policy and passes on the fix. |
| `npm run check` | Typecheck and lint clean; 4 files, 38 tests passed |
| `npx wrangler deploy --dry-run --env=""` | Bundles: 1,326.94 KiB, 240.88 KiB gzipped. The dry run deploys nothing. |

A clean console on the deployed page is still unproven. That needs Terra's redeploy and browser check: sign-in renders with no CSP violation, then device creation and revocation.

## Live signing-key 503: diagnosis and fix

After Codex and Claude completed real Clerk logins, `GET https://memory.wrick17.com/v1/whoami` with Codex's real access token returned 503 `temporarily_unavailable`, "signing keys are unavailable" ([evidence](phase-1-verification.md#isolated-codex-oauth-follow-up)).

**Repro.** `node /tmp/am-auth-repro/whoami.mjs` reads the access token from the isolated Codex store `/tmp/agent-memory-live-goBMur/codex/.credentials.json` inside the script. It prints only the token's public `kid`, claim booleans and the sanitized response. Against Worker version `0b2ef0d6-2149-48df-8f26-c3e8184f9efc` it printed `issOk`, `subOk`, `audOk` and `scopeOk` all true, about 24 hours left, then `{"status":503,"error":"temporarily_unavailable","description":"signing keys are unavailable"}`, on every run. A read-only `wrangler tail` of the same request showed outcome `ok`, response 503 and no log or exception, because the old code swallowed the cause.

**What was ruled out outside the Worker.**
- The public JWKS at `https://clerk.memory.wrick17.com/.well-known/jwks.json` returns 200 `application/json`, with no redirect and no block, for no user agent, `Python-urllib` and `curl`. It holds one RS256 key whose `kid` matches the token.
- WebCrypto imports that key with the Worker's parameters and verifies the real token's signature.
- So the token, the keys and the crypto were fine, and the failure was the Worker's own key fetch. The earlier Python 403 (error 1010) was on `memory.wrick17.com` and does not apply here.

**Actual cause, found live.** Version `8d80ae8f-b294-48a1-b298-d4db6bbf0fc6` carried the stage log below. It still returned 503 and logged stage `fetch`: Cloudflare Workers rejects `redirect: "error"`, which `src/egress.ts` passed to `fetch()`, and advises `manual` with a status check ([log](phase-1-verification.md)). The local Workers runtime accepted the option, so the tests had never caught it.

**Fix for the actual cause.** `egressFetch()` is the only `fetch()` call, and `fetchKeys()` in `src/auth.ts` its only caller. It now passes `redirect: "manual"`, which Workers supports. Any 3xx response is discarded and refused with an error, so a `Location` to another host is never followed. The HTTPS and exact-Clerk-host allowlist is unchanged, and so are the signature, issuer, owner, resource audience and `memory` scope checks.

| Regression in `test/mcp-auth.test.ts` | On the committed `3e27817` egress | With the fix |
|---|---|---|
| The key fetch uses `redirect: "manual"`; a 302 whose `Location` is another host gets 503 and logs stage `fetch` with "redirect (302)", after exactly one fetch to the Clerk host; then a plain 200 key set from the same host verifies | Fails | Passes |

**Earlier hypothesis, unconfirmed.** The section below was written before the live log and is kept as the record of that diagnosis. Its same-zone routing cause (error 1042) was an inference from documentation and DNS, never observed: the flag-off control was not run, and no 1042 appeared. `global_fetch_strictly_public` stays as the routing Cloudflare documents for a same-zone, Worker-backed hostname, not as a proven fix.

**Inferred cause (unconfirmed).** `clerk.memory.wrick17.com` is a DNS-only CNAME in the Worker's own zone, `wrick17.com`. It resolves through `frontend-api.clerk.services` to `worker.clerkprod-cloudflare.net`, Clerk's own Worker. Cloudflare documents two relevant rules:
- Without the `global_fetch_strictly_public` compatibility flag, a Worker's `fetch()` to a hostname on its own zone "is routed to the zone's origin server, ignoring any Workers mapped to the URL".
- Error 1042 is "Worker tried to fetch from another Worker on the same zone, which is only supported when the global_fetch_strictly_public compatibility flag is used".

The inference was that the signing-key fetch would get a Cloudflare error instead of the JWKS. The live log showed a different, earlier failure: the rejected redirect option. Ruled out outside the Worker: a block on Worker subrequests at Clerk, JSON parsing, key import.

**Changes made with that diagnosis (kept).**
- `wrangler.jsonc` adds `global_fetch_strictly_public`. The Worker's fetches now route as from the public Internet, through Cloudflare's normal routing and security settings. `egress.ts` still allows only the Clerk Frontend API over HTTPS; the later manual-redirect correction above supersedes the earlier redirect mode.
- No signature, issuer, audience, owner or `memory` scope check changed, and no key is pinned.
- `fetchKeys()` now logs one sanitized line, `{"event":"clerk_jwks_issue","stage":...}`, naming the failing stage. Stages: `fetch`, `status` with the HTTP status and any Cloudflare `error code`, `parse`, or `import` with the public `kid`. It never logs a token.
- Cold keys still fail closed with 503.
- The Cache API is now best-effort, because it only saves refetches: a failed cache read or write is logged and the keys are fetched directly. A key that fails to import is skipped and logged, so a token naming it gets 401 "unknown signing key".

| Regression in `test/mcp-auth.test.ts` | On the committed `3e27817` code | With the fix |
|---|---|---|
| A refused key fetch (Cloudflare `error code: 1042` page) returns 503 and logs `stage: "status"`, the status and `cf_error: "1042"`, with no token text | Fails: no log | Passes |
| A failing Cache API still verifies a valid token and still refuses a wrong audience | Fails: 503 | Passes |
| The deploy configuration keeps `global_fetch_strictly_public` | Fails | Passes |

These tests show the stage log, the fail-closed behavior and the configuration. They cannot reproduce Cloudflare's same-zone routing, which only exists on Cloudflare's network.

| Check | Result |
|---|---|
| `npm run check` | Typecheck and lint clean; 4 files, 41 tests passed |
| `npx wrangler types --strict-vars=false --check` | Types up to date (now generated with `global_fetch_strictly_public`) |
| `npx wrangler deploy --dry-run --env=""` | Bundles: 1,328.03 KiB, 241.17 KiB gzipped. The dry run deploys nothing. |
| Live repro after these source changes | Still 503, as expected: nothing is deployed |

**Live proof.** The deployed manual-redirect fix returned 200 with claims for the real Codex token; direct real-token MCP and device checks are recorded in [verification](phase-1-verification.md#manual-redirect-deployment-and-live-checks). Remaining gate items are listed below.

## Live vector channel: diagnosis

Terra's live recalls found the synthetic `test` journal only lexically. The calls reported embedding and vector-query timeouts ([live checks](phase-1-verification.md#manual-redirect-deployment-and-live-checks)). Diagnosed on Worker version `49233d08-70c4-46a6-ae26-42afe51bfb67` with read-only checks; no source, configuration, deployment or data change.

**The write path works live.**
- `get_memory` on the journal (`63d16625-df80-5241-95c9-84f41246d75f`, profile `test`) returns `embedding_status: "embedded"`, so the alarm's `embed` stage ran.
- `wrangler vectorize info agent-memory-cards`: 1,024 dimensions, 1 vector, processed at 2026-10-28T17:08:37Z.
- `wrangler vectorize list-vectors` and `get-vectors`: the one vector is `go25mc24teteg2:63d16625-…`, in namespace `user_3LKQ6KGbDJZfXH8o4UfNqcq6mig:test:go25mc24teteg2`, with metadata `{kind: "journal", gen: "o25mc24teteg2"}` and 1,024 values. Id, namespace and metadata all match what `src/profile/index.ts` writes and what the Durable Object's recall queries.
- `wrangler vectorize query --vector-id … --namespace …` returns it, with and without the `kind` filter. The index, the namespace and the `kind` metadata index serve it.

**The query path is starved by latency, not broken.** `/tmp/am-auth-repro/recall.mjs` runs live `recall_memories` calls in profile `test` with the isolated Codex token, read inside the script. It prints only timings, the whitelisted `embedding` and `vector` diagnostics and whether the journal was found. Across 8 calls, run back to back and 5 s apart:
- 5 calls: the query embedding exceeded the 1 s bound in `src/mcp.ts` (`embedding: "unavailable:timeout"`), so no Vectorize query was made.
- 3 calls: the embedding arrived, and the `test` profile's Vectorize query exceeded the 300 ms wait in `src/profile/store.ts` (`vector: "timeout"`).
- Every call returned the journal through full text.

`wrangler tail` gives each invocation's wall time, which runs until its pending provider call settles; `Authorization` was already redacted in the capture.
- Query embedding through Workers AI: about 0.18 s and 0.7 s when in time; about 1.04, 1.45 and 1.46 s when it missed the bound.
- The `test` Durable Object's Vectorize query: about 0.62 s and 1.4 s. The empty `me` namespace answered in about 0.2 s, which is why some responses show `lexical_only: false`: that flag covers the whole read set.
- Durable Object reads without a query vector took 5 to 15 ms.

**Cause.** The record, the index, the alarm and the query code are correct. Live provider latency on this account, from this location, is above both budgets: the approved 300 ms Vectorize wait (section 11) and the 1 s query-embedding bound, which was an author shortcut. So the vector channel rarely contributes, and recall falls back as designed. The local tests prove the channel's logic with fakes. What is missing is a live hit within budget, not a code fix. No source change is made: changing either budget is a decision, not a defect fix.

**Decision, 2026-10-28 (parent, under the owner's authorization).** Both limits are replaced by one 3 s semantic-enrichment deadline. The 300 ms Vectorize wait and the 1 s query-embedding bound excluded every observed semantic result. See the [semantic deadline change](#semantic-deadline-change).

**Terra repro (read-only).** Start `npx wrangler tail agent-memory --format json` into a mode-600 file. Run `node /tmp/am-auth-repro/recall.mjs semantic 4 5000`. The output gives, per call, `ms`, `embedding`, `vector`, `recordFound` and `matched_by`. A live vector hit shows `matched_by` containing `vector`.

## Semantic deadline change

**Flow.**
1. The Worker sets `deadline = now + 3 s` (`SEMANTIC_MS` in `src/profile/index.ts`). It fans out to the read set's profiles at once, passing `semantic` (`EMBEDDINGS` is not `off`) and the deadline. The Worker no longer embeds the keyword.
2. Each profile object requests the keyword's embedding from Workers AI first. It runs the exact, literal and full-text channels while that is in flight, and sends its Vectorize query when the embedding arrives (`ProfileStore.recall` in `src/profile/store.ts`).
3. Fusion waits for the semantic chain only until the deadline, clamped to at most 3 s, so a clock difference cannot stretch it. A late answer or failure has a handler attached and is dropped. It neither delays the response nor becomes an unhandled rejection.
4. Per-profile diagnostics are truthful:
   - `embedding`: `ok`, `timeout`, `error:<name>`, `off` or `unavailable`.
   - `vector`: `hits:<n>`, `no_results`, `timeout`, `error:<name>`, `skipped` (the embedding missed) or `off`.
   - With `EMBEDDINGS=off`, the top-level `diagnostics.embedding: "off"` stays.

**Unchanged:**
- Generation-qualified ids and namespaces; profile and token isolation.
- `type`, `kinds`, `scope` and history filters, applied to vector hits too.
- RRF fusion and ordering, the cross-profile merge, token-budget packing.
- Empty-keyword inventory and `EMBEDDINGS=off`, which makes no Workers AI call.
- No new option, dependency or cache.

The keyword is now embedded once per profile in the read set, so a work-plus-`me` recall makes two small calls. That keeps the change inside the existing recall call: no callback and no second round trip.

| Regression in `test/isolation-recall.test.ts` | On the committed `0798699` flow | With the change |
|---|---|---|
| An embedding that answers after 1.5 s (past the old 1 s bound), and a Vectorize query that answers after 2 s (past the old 300 ms), each still contributes `vector` to the record's `matched_by` | Fails | Passes |
| With the embedding still pending past the deadline, recall returns the full-text hit near 3 s while the fake embedding is still in flight (lexical work never waited for it), with `embedding: "timeout"`, `vector: "skipped"`. A Vectorize query past the deadline gives `vector: "timeout"`; a failing Vectorize or embedding gives `error:`; each returns the lexical hit. `EMBEDDINGS=off` returns lexically with no Workers AI call. | Fails | Passes |

Old flow means `src/mcp.ts`, `src/profile/store.ts`, `src/profile/index.ts` and `src/domain/types.ts` at `0798699`, with the same tests and fakes.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | No errors |
| `npx eslint` on the touched files | No issues |
| `npx vitest run` (all four files call recall) | 4 files, 43 tests passed |

**Live proof still needed (Terra).**
- `node /tmp/am-auth-repro/recall.mjs semantic 4 5000`: expect `matched_by` containing `vector` for record `63d16625-df80-5241-95c9-84f41246d75f`. Judge the record's own `matched_by`, not `lexical_only`, which covers the whole read set.
- If possible, a paraphrase with no shared literal, which should match only through `vector`.
- `kinds: ["journal"]` keeps it and `kinds: ["rule"]` drops it.
- A forced provider failure or timeout returns lexically by about 3 s.
- `EMBEDDINGS=off` is unchanged.

## Live gates still open

- **G1, T1 to T6.** Real Claude and Codex tokens now authenticate in direct MCP requests, but actual CLI tool calls, headless client configuration, negative real-token cases and refresh remain open. Terra reports that Clerk discovery publishes issuer `https://clerk.memory.wrick17.com`, which matches `CLERK_ISSUER`. The real access token must carry the resource in `aud` and `memory` in `scope` or `scp`; both stay required. If Clerk cannot satisfy them, the specified fallback (section 8) is the only alternative. Refresh (T4) is untested.
- **G5.** Direct real-token synthetic save, append and lexical recall passed on this Mac. Terra later reported actual Codex tool calls, a forced refresh and Claude `headersHelper` tool calls passing ([verification](phase-1-verification.md)). A live vector hit through recall is still open: before the shared 3 s semantic deadline, live latency kept the vector channel out ([diagnosis](#live-vector-channel-diagnosis)). After deployment, check the record's own `matched_by` for `vector` ([change](#semantic-deadline-change)). A second physical machine is deferred.
- **Settings page in a browser.** The later CSP correction is deployed; the pinned owner Settings view rendered without CSP or initialization errors, and a test device was created and revoked. See [live evidence](phase-1-verification.md#settings-correction-redeployment-and-browser-check).
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

- shortcut: `toLowerCase()` stands in for Python's `casefold()` in name normalization (`src/domain/ids.ts`); revisit in the migration import.
- A Worker crash after binding a `request_id` and before the profile write leaves a binding with no result. A retry with the same payload proceeds; a retry with a changed payload is refused until the id changes.
- The Origin check refuses browser-based MCP clients from other origins. Claude Code and Codex send no Origin.
- Replacing the content of a record with more than about 1,000 live append entries is refused with `size_budget`, because each entry row that becomes history counts against the 1,000-row bound. Journal compaction arrives in phase 3.
- Sensitive terms for the `me` guard come from routing-rule org names and owner-added terms only; entity terms arrive with `record_knowledge` in phase 3.
- Test output includes two `uncaught exception` lines from the intentional fake failures in `test/fakes.js`, and Wrangler warns that `env.test` omits `ai` and `vectorize` on purpose.
