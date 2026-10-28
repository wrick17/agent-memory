# Phase 1 independent verification

2026-10-28. Terra ran the combined local checks on the uncommitted author implementation. This is not phase-1 gate verification or a source-review clearance.

| Command | Result |
|---|---|
| `npm run check` | Passed typecheck, lint and 4 test files, 30 tests. |
| `npx wrangler types --strict-vars=false --check` | Passed; generated types current. |
| `npx wrangler deploy --dry-run --outdir /tmp/agent-memory-verify-bundle` | Passed; 1324.54 KiB, gzip 240.30 KiB. No deploy. The top-level environment was selected implicitly and Wrangler warned about that selection. |

The tests run in workerd with SQLite Durable Objects and local R2. AI and Vectorize are fakes; JWTs use a test key and stubbed JWKS. The suite logged intentional fake Vectorize and embedding failures and Wrangler warned that `env.test` omits AI and Vectorize, which are replaced by fakes. These results do not establish live OAuth, live vector retrieval, or cross-machine behavior.

A separate synthetic live Workers AI call measured 1024 dimensions. The requested R2 bucket and Vectorize index exist. The parent subsequently ran `npx wrangler vectorize list-metadata-index agent-memory-cards` and confirmed `kind` with type `String`; this does not prove live filtered retrieval. See [setup](phase-1-setup.md#infrastructure-verification-2026-10-28) for earlier provider and discovery evidence.

## Combined check after F1 to F5

On 2026-10-28, Terra ran `npm run check` once against the combined fixed source: typecheck and lint passed, followed by 4 files and 35 tests passed. This is separate from the earlier 30-test run above. The same local test limitations and intentional fake-failure logs apply. `npx wrangler types --strict-vars=false --check` passed. `npx wrangler deploy --dry-run --env="" --outdir /tmp/agent-memory-combined-verify` passed, 1325.72 KiB and 240.60 KiB gzipped, with the configured top-level bindings. It did not deploy.

The configured deployment route is the custom domain `memory.wrick17.com`. The earlier dashboard lookup found no record at that name; recheck the current authoritative state immediately before binding and stop for any unrelated conflict. `ACCOUNT` and `PROFILE` use SQLite migration `v1`; `AI`, `VECTORS` and `BACKUPS` retain the existing names in `wrangler.jsonc`. No phase-1 secrets are required.

After adding that route, `npx wrangler deploy --dry-run --env="" --outdir /tmp/agent-memory-domain-verify` and `npx wrangler types --strict-vars=false --check` both passed. The route change was configuration only; no Worker or DNS was changed.

## Local live-test handoff

After parent clearance, recheck the exact DNS name in the signed-in Cloudflare dashboard, then deploy with `npx wrangler deploy --env=""`. Record the version and check unauthenticated `/mcp` and protected-resource metadata before signing in. Use only owned Helium background tabs, record the baseline first, and keep the owner's login private.

Prepare separate temporary client configurations and verify their credential-store isolation before login; do not copy existing credentials or change the live MCP configuration. Local CLI help confirms `claude mcp add --transport http`, `claude mcp login --no-browser`, `codex mcp add --url`, and `codex mcp login --no-browser --scopes memory,offline_access`. The no-browser authorization and callback URLs can contain sensitive values: handle them privately, never in captured output. Isolation and successful login have not yet been established. The Codex add command also exposes `--oauth-resource` and `--oauth-client-registration`; use them only as supported by the observed discovery and gate requirements.

In Settings create uniquely labeled devices scoped to `test`, keep tokens in private mode-600 storage, and retain the test records. Exercise Claude's `headersHelper` and Codex's `--bearer-token-env-var` without logging credentials. For each OAuth client verify both resource audience and `memory` scope using sanitized claim results, then use uniquely labeled synthetic `test` records for save and recall. Check real vector retrieval and `kind` filtering, lexical fallback on a safely induced failure, and `EMBEDDINGS=off` only if the non-deleting configuration changes can be restored safely. Revoke the test device token and verify the next request is refused; retain its record. If T1 or T3 fails, retain sanitized evidence and return to the same Opus author for the approved fallback. T4 requires waiting the configured token lifetime and observing real refresh. A second physical machine remains a separate future check.

## Production deployment and first live observations

On 2026-10-28, after parent source-review clearance, Cloudflare's DNS dashboard search with no type filter returned the five Clerk subdomain records and no record at the exact name `memory.wrick17.com`. `npx wrangler deploy --env=""` deployed Worker `agent-memory`, custom domain `memory.wrick17.com`, version `6eb6b8d3-f626-4b65-811a-7d5a6ca59e5e`. Its bindings were `ACCOUNT` / `AccountStore`, `PROFILE` / `ProfileStore`, `AI`, `VECTORS` / `agent-memory-cards`, and `BACKUPS` / `agent-memory-backups`; migration `v1` declares both SQLite classes. Deployment used the uncommitted reviewed source atop Git HEAD `1770186a182d80296053742428b96eea4523be67`; the pre-deploy dry-run `worker.js` SHA-256 was `9852dc18c339c0a97ab34536bd8ecf0a065207be73da145f10ef4f8e5d239a11`. A bundle hash is not a Cloudflare server-side artifact attestation.

From the owned Helium tab, unauthenticated POST `/mcp` returned 401 with the expected resource-metadata challenge and `memory` scope. GET `/.well-known/oauth-protected-resource/mcp` returned 200 with the expected resource, Clerk issuer and scope. `/settings` returned the page, but it did not render sign-in: the browser console reported `Clerk was not loaded with Ui components`; CSP also blocked a Clerk protection bootstrap script. Return this production integration defect to the original Opus author. A Python HTTP request received Cloudflare 403 error 1010; a separate curl metadata request returned 200, so this does not establish a general CLI failure.

Fresh private client directories under `/tmp/agent-memory-live-goBMur` initially listed no MCP servers. Claude's local configuration was written inside that directory. Codex used a separate config directory and file-backed MCP OAuth credential setting. Both clients reached an authorization URL, but neither login was completed and credential-store isolation for a completed Claude login was not proved. The Codex add command unexpectedly initiated OAuth and printed its authorization URL in command output; that attempt was interrupted before authorization. No token or callback was issued in that attempt. Claude's interactive authorization attempt was also interrupted before login; its captured output is in a mode-600 local file. These are initiation checks, not G1 T1, T2 or T3 passes. No device, synthetic memory or vector record was created.

Still pending: owner Settings login, actual client OAuth and claims, headless device creation and revocation, live save/recall and vector/fallback checks, T4 real refresh after expiry, and the deferred physical second-machine checks. BothQ and ordinary client configuration remain live and unchanged. Browser MCP returned `Transport closed` when closing the owned Settings tab; DevTools showed it closed and the nine baseline pages present. Group removal is unconfirmed. Codex unexpectedly opened an additional Helium authorization tab outside Browser MCP ownership; the interrupted login makes that tab stale, and it remains open because this session cannot close it through the authorized tab manager.

At that checkpoint, the independent Sol recheck, parent clearance, deployment, G1 T1-T6, live G5, physical-machine and headless access were outstanding. The deployment and later observations are recorded below. Do not change `REQUIRED_SCOPE` or weaken audience checks to make a gate pass. The live BothQ system and client configurations remain unchanged.

## Settings correction redeployment and browser check

On 2026-10-28, Terra independently ran `npm run check` once against the cleared correction: typecheck and lint passed, with 4 files and 38 tests passed. `npx wrangler types --strict-vars=false --check` and `npx wrangler deploy --dry-run --env="" --outdir /tmp/agent-memory-ui-verify` passed. The dry-run bundle was 1326.89 KiB, 240.86 KiB gzipped, with SHA-256 `0a51e177fc8d34246d37342726f6fbc713c9cddc5614b8bc3df473841d571a8e`. The bundle hash is local evidence, not server-side artifact attestation.

`npx wrangler deploy --env=""` deployed version `0b2ef0d6-2149-48df-8f26-c3e8184f9efc` to `memory.wrick17.com`, from the uncommitted correction atop `822d128d3c105d5a60d9b7f4d9b6d4269a6328a9`. Existing bindings and `REQUIRED_SCOPE=memory` remained configured.

In an owned Helium tab, the real Clerk sign-in form rendered with email, password and Google sign-in. There was no Clerk initialization error. The console did report CSP violations: `img-src` blocked a `blob:` image and `connect-src` blocked an instance-specific `client.protect.clerk.com` probe. The requested clean-console check therefore failed and the CSP issue returns to the original author. No password was entered or read. The Settings tab remains open for the parent. The stale interrupted Codex authorization tab remains unowned and was not closed.

No live device, OAuth, save/recall, vector, fallback, refresh or second-machine gate was established in this check. BothQ remains the live memory system.

## Isolated Codex OAuth follow-up

On 2026-10-28, Codex used the existing isolated configuration under `/tmp/agent-memory-live-goBMur/codex`, with `mcp_oauth_credentials_store = "file"`, and `codex mcp login --no-browser --scopes memory,offline_access`. The authorization URL was captured in a mode-600 file and opened in a Browser MCP-owned Helium tab. Clerk's hosted consent page rendered using the existing signed-in session. Authorization completed and Codex stored its credentials in an isolated mode-600 file; no owner password was entered or read. The owned authorization tab was closed and its DevTools page disappeared. Settings remains open for the parent.

The issued JWT's decoded claims matched the configured issuer and owner, included the resource audience and `memory` scope, and a refresh token was present. This is claim inspection, not a successful authenticated Worker request or refresh test. A direct Python request received HTTP 403; a separate curl request reached the Worker and received HTTP 503 `temporarily_unavailable`, with description `signing keys are unavailable`. This blocks live Codex tool calls and needs investigation by the original author. It is not evidence of a failed Clerk consent or of missing audience or scope.

Claude completed-login credential-store isolation remains unproved, so no Claude login was completed in this follow-up. No device or synthetic record was created. Live client save/recall, vector and fallback behavior, actual refresh and second-machine tests remain open. BothQ and ordinary client configurations remain unchanged.

## Isolated Claude OAuth follow-up

On 2026-10-28, Claude Code 2.1.312 used `/tmp/agent-memory-live-goBMur/claude` for both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Inspection of the installed binary's service-name derivation showed that this explicit nonempty secure-storage path selects the distinct Keychain service `Claude Code-credentials-f2c4efdc`. A metadata-only lookup confirmed that isolated service exists. After login, reading only that isolated entry showed one `mcpOAuth` entry for the test server. Its JWT claims matched the configured issuer and pinned owner, included the resource audience and `memory` scope, and a refresh token was present. Ordinary credential items were not read, and the Keychain default and search list were not changed.

`claude mcp login --no-browser` wrote output to a mode-600 file. Its authorization URL was opened in a Browser MCP-owned Helium tab. Clerk's hosted consent named the authorized owner Google account; consent completed without a password prompt. The CLI reported success, and the isolated Keychain entry persisted. The owned authorization tab was closed and its DevTools page disappeared; Settings remains open. This proves login and inspected claims, not authenticated Worker tool calls or refresh. Those remain blocked on the independently observed signing-key 503, pending the author's correction and deployment. No live memory or device record was created.

## Combined JWKS and CSP deployment

On 2026-10-28, Terra independently ran `npm run check` once against the combined correction: typecheck and lint passed, and 4 files with 41 tests passed. Generated types were current and `npx wrangler deploy --dry-run --env="" --outdir /tmp/agent-memory-jwks-verify` passed (1328.03 KiB, 241.17 KiB gzipped). Its local bundle SHA-256 was `dfd00206a190c19c31dcfda069059af26ff3c668727e8de6bff69fcfd54049ea`; this is not a server-side artifact attestation.

The top-level Worker was deployed with the configured `global_fetch_strictly_public` flag as version `8d80ae8f-b294-48a1-b298-d4db6bbf0fc6`, from the uncommitted correction atop `3e278176ff1278b249a22151f3ca2f3ca90a0848`. A real isolated Codex token still received HTTP 503 from `/v1/whoami`. The sanitized `clerk_jwks_issue` log reported stage `fetch`: Cloudflare Workers rejects `redirect: "error"`, advising `manual` and a response status check. This is a source defect for the original author. The optional flag-off control was not run, and the prior same-zone cause remains an inference; error 1042 was not observed. Private raw diagnostics remain mode 600 outside Git.

In a new Browser MCP-owned Helium tab, Settings loaded the existing Clerk session for the pinned owner. The Settings view rendered and the console showed no CSP or initialization errors at inspection. The tab remains open for continued testing. This does not prove device APIs while signing-key fetch fails. Authenticated client save/recall, device create/revoke, live vector and fallback, refresh, and physical second-machine checks remain open.

## Manual redirect deployment and live checks

On 2026-10-28, the authorized `env.test.routes = []` safeguard was added; the test-environment custom-domain inheritance warning disappeared during checks. The test environment was not deployed. `npm run check` passed typecheck, lint and 4 files with 42 tests. `npx wrangler types --strict-vars=false --check` and the explicit top-level deploy dry run passed. The local dry-run bundle SHA-256 was `fb20c2dacd1b55aabbd7d87cfebc3db7594ffa38e2394c2b31313b22a615cf3f`; this is not a server-side attestation.

The top-level Worker with the manual-redirect fix and `global_fetch_strictly_public` was deployed as `76b8f25b-b019-4526-919c-ee5564601c39`, from the uncommitted correction atop `3e278176ff1278b249a22151f3ca2f3ca90a0848`. The isolated Codex token received HTTP 200 from `/v1/whoami`, with claims present and matching configured issuer, owner, audience and `memory` scope. The observed earlier 503 came from the unsupported redirect option; 1042 was not observed.

Direct MCP requests using the isolated CLI-issued tokens (not CLI tool invocations) listed four tools, created a uniquely labeled synthetic test-profile journal with the Codex token, appended with the Claude token and recalled it with the Claude token. Settings rendered for the pinned owner and created a test-only read/write device. Direct MCP requests with its token listed tools and recalled the record; work-profile recall was forbidden. Settings revoked the device, and its next request returned 401. The device and synthetic record are retained. These checks do not prove Claude `headersHelper` or Codex `bearer_token_env_var` execution.

Filtered live recall found the journal with `kinds: ["journal"]` and excluded it with `kinds: ["rule"]`. The record was not observed in the vector channel: separate calls reported vector-query and embedding timeouts and returned lexical results. This establishes functional lexical fallback under those observed timeouts, not live vector retrieval. A temporary `EMBEDDINGS=off` deployment `6cfe9449-d509-4d12-b49a-fabb2c651a5c` returned the record with `lexical_only: true` and `embedding: off`; the mismatched kind excluded it. The normal configuration was restored as `49233d08-70c4-46a6-ae26-42afe51bfb67`, with `EMBEDDINGS=on` in deployment output. A subsequent live recall showed embeddings not off.

Actual client tool invocations, headless client configuration paths, real refresh, negative real-token cases, vector-hit proof and second physical machine checks remain open. BothQ and ordinary client configurations remain live and unchanged.

## Isolated client and refresh follow-up

On 2026-10-28, the isolated Codex CLI app-server's experimental `mcpServer/tool/call` interface used its existing OAuth store to create and recall a uniquely labeled synthetic test-profile record. This is a real Codex client MCP invocation, using the app-server interface rather than an interactive model turn. The isolated Codex model-provider login status was `Not logged in`; the app-server MCP calls did not require a model-provider login.

Settings, in an owned Helium tab and with the pinned owner session, created another uniquely labeled read/write device restricted to `test`. In a separate private Codex configuration, `bearer_token_env_var` supplied that device token to the Codex app-server process. Actual MCP tool calls created and recalled a second synthetic test-profile record. The active test device and records remain for further testing; its token is in a mode-600 file in a mode-700 private directory. The Settings tab remains open.

Claude Code's isolated OAuth `mcp get` completed and reported the server connected. A separate isolated user-scope configuration used `headersHelper` to read the device token from the private file; its helper ran and `claude mcp get` reported connected. These are real CLI connection checks, not tool calls. A bounded isolated `claude -p` MCP tool-call attempt exited before a tool call because its Claude model-provider session was not logged in. No ordinary credentials or configuration were copied or changed. Actual Claude tool invocation requires a model-provider session for that isolated client or a supported model-free invocation path.

For a real Codex client refresh, only the isolated OAuth store's expiry metadata was forced into the past. The Codex app-server then successfully created and recalled a synthetic record; its access token and refresh token changed and the stored expiry advanced. This proves a forced-expiry client refresh, not a natural 24-hour expiry. Claude client refresh remains untested.

A real Codex token with its signature altered received 401. The pinned owner's real Clerk browser session token also received 401 at `/mcp`; decoded claim checks showed it lacked both the resource audience and `memory` scope, so this does not distinguish those two refusals independently. Different-owner, independently wrong-audience and independently missing-scope real-token cases remain unproved. No token, callback or credential values are recorded here.

## Claude model-provider isolation check

On 2026-10-28, `claude auth status` with the existing personal `~/.plaude` provider configuration reported logged in; only the authenticated boolean was retained. This is model-provider authentication, separate from Agent Memory MCP OAuth. The installed CLI offers `--strict-mcp-config`, `--mcp-config`, `--no-session-persistence`, `--setting-sources` and per-run `disableAllHooks`; documented environment flags can disable auto memory and CLAUDE.md loading. Managed hooks, if present, are not disabled by a non-managed `disableAllHooks`. The locally inspected managed settings file had no hooks or force-enabled plugins, but this alone does not prove every possible managed source.

A status-only check with a temporary `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointing at `~/.plaude` reported the provider logged in. The latter variable is recognized by this installed binary but is absent from the official environment-variable reference, so it is not established as a supported isolation interface. The documented flags do not establish that using `~/.plaude` directly would leave its ordinary configuration untouched. No model turn or MCP tool call was run under that split configuration. Actual Claude tool invocation and Claude refresh remain pending a supported path that preserves ordinary configuration and disables all relevant hooks and native memory. The individual real-token audience and scope negatives remain pending; no production auth configuration or signing keys were changed to manufacture tokens.

## Claude actual headersHelper tool calls

On 2026-10-28, the owner authorized normal use of the existing `~/.plaude` model-provider login, including incidental login and cache bookkeeping. Claude Code ran once in an empty private working directory with `--strict-mcp-config` and a private `--mcp-config` containing only the test-scoped `headersHelper` server. It used `--no-session-persistence`, an empty `--setting-sources` list, per-run `disableAllHooks`, and environment flags to disable auto memory and CLAUDE.md loading. Built-in tools were disabled and the permitted MCP tools were limited to save and recall. The locally inspected managed settings file had no hooks or force-enabled plugins.

The actual Claude Code run invoked `save_memory` and `recall_memories` through the helper. It created a uniquely labeled synthetic test-profile record and recalled the same record; both tool results had no errors. This proves the Claude headless headersHelper tool path, not the isolated OAuth tool path or refresh. Natural 24-hour refresh, individual real-token audience and scope negatives, and a second physical machine remain unproved.

The persistent personal settings and standalone MCP-config file hashes were unchanged. The personal `.claude.json` hash changed; MCP entries matched a recent prior backup, although that backup was not established as the exact pre-run baseline. The change has therefore not been classified completely; no restoration or deletion was attempted. Provider credentials were neither explicitly read nor copied. Private output remains mode 600, and all synthetic records and the test device are retained.

## Semantic deadline combined verification preparation

On 2026-10-28, Terra independently ran `npm run check` once against the frozen uncommitted semantic change atop `07986995bbff010d66c79b95179489767bae7166`: typecheck, lint and all 43 tests passed. `npx wrangler types --strict-vars=false --check` passed, as did the explicit top-level deploy dry run (1328.41 KiB, 241.31 KiB gzipped). The relevant source and test diff SHA-256 was `df2e7460d0a840a820b5d1672306674ad8b8df7173e71d8f22338d8883c8d2f3`; the dry-run bundle SHA-256 was `b9c142f22f4ef6e037dbb5a585350bd2279cec8d0d35e48b72f4e3cf0a82b032`. These local hashes are provenance, not server-side artifact attestation.

The local regressions use fake providers. They cover embeddings arriving after the old 1 s limit and vector results after the old 300 ms limit, hung embedding and vector stages, provider failures, lexical results at the shared deadline and embeddings-off behavior. The logged fake provider errors and `env.test` AI and Vectorize binding warnings are expected in this suite. These checks do not establish a live vector hit or a production latency guarantee.

A mode-600 read-only live probe was prepared and syntax-checked at `/tmp/am-auth-repro/semantic-after-clearance.mjs`. It uses the isolated Codex store and can independently query the existing test record for semantic, paraphrase, journal-filter and rule-filter scenarios, reporting that record's own vector match and sanitized diagnostics. It has not been run against the new flow. Deployment and live checks await the parent's independent review clearance; no production test bypass or repeat embeddings-off deployment was introduced.

## Semantic deadline deployment and live recall

On 2026-10-28, after the [independent semantic review](review-sol-semantic-deadline-2026-10-28.md) found no material P0/P1/P2 issue, the six reviewed source and test hashes matched. `npx wrangler deploy --env=""` deployed version `6e4e15a7-ae4b-40e7-b687-0b4932e295c9` with `EMBEDDINGS=on` to `memory.wrick17.com`. The deployed source was the uncommitted reviewed change atop `07986995bbff010d66c79b95179489767bae7166`; combined local checks and local bundle provenance are recorded above. Existing bindings and the normal routing configuration were used.

Four bounded read-only live queries used the isolated Codex OAuth token. For the existing test journal `63d16625-df80-5241-95c9-84f41246d75f`:

- The semantic query returned HTTP 200 and the record's own `matched_by` contained `vector`; embedding reported `ok`, and the vector stage reported hits.
- The paraphrase `fabricated diary note` returned that record with `vector` and no lexical match.
- `kinds: ["journal"]` retained the record with a vector match; `kinds: ["rule"]` excluded it and the vector stage reported no results.

These results establish live vector retrieval and the observed filter behavior for this record, not a benchmark or a general latency guarantee. Local fakes cover forced provider errors and deadline fallback; the earlier live embeddings-off check remains recorded above and was not repeated. The reviewer observed that late embedding can still start a Vectorize request and mutate a local diagnostic after the deadline; copied RPC results, hits and cleanup were unchanged in the review's test. This is extra provider work, not a demonstrated result regression.

Actual native Claude OAuth tool invocation and Claude refresh, natural 24-hour refresh, individually isolated real-token audience and scope negatives, and physical second-machine checks remain open. BothQ remains the live memory system.
