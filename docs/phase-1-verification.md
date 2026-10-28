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
