# Phase 1 setup readiness

Observed 2026-10-28. This is setup evidence, not implementation or gate evidence.

- The private repository is `https://github.com/wrick17/agent-memory`. Its initial `main` commit is `d90f14da9d60c8148e42dd8585bda5221b82ec3c`, containing only the existing planning documents and root `AGENTS.md`.
- GitHub API identity is `wrick17`. Default SSH authenticates as `pratyush-poddar_seq`; use HTTPS with the `wrick17` gh credential for this repository, and clear inherited GitHub token overrides. HTTPS transport was verified by listing and pushing the baseline.
- Wrangler 4.67.0 is authenticated to the personal Cloudflare account. It listed R2 buckets and Vectorize indexes. The `wrick17.com` zone is active. The zone's Free Website plan does not establish the Workers subscription; the billing subscriptions API returned 403, so Workers Paid remains unverified.
- The Cloudflare DNS records API returned 403. Public DNS returned no A, AAAA or CNAME answer for `memory.wrick17.com`; that does not establish the full authoritative record state. The planned Worker custom domain is `memory.wrick17.com`. Obtain its exact proposed record and current authoritative state before requesting its individual approval. Clerk records are unknown until app setup. Do not change DNS without individual approval.
- No Clerk CLI or management credential was found in the current environment. The Agent Memory Clerk app has not been created or checked. An owner must sign in to Clerk or provide an authorized management credential through the parent's secret mechanism. Configure sign-ups off and owner-only access, then check OAuth and CIMD settings. The real-token G1 tests decide the authorization-server topology.
- Local tools: Node 24.11.1, npm 11.6.2, Bun 1.4.4, pnpm 10.28.2, Codex 0.165.0, Claude Code 2.1.312 and Playwright 1.57.0. Cached Playwright Chromium and headless-shell binaries are present. The Workers test pool, Vitest and Miniflare are not installed in this workspace; their actual prerequisites and tests depend on the author's package setup.
- The linked-machine listing tool was unavailable in this session. A second machine and headless device-token flow remain unverified.

Next: obtain Clerk management access and verify Workers Paid and authoritative DNS visibility. Wait for Opus's binding names and embedding dimensions before provisioning Cloudflare resources. After author handoff and independent review, run the phase checks, request each DNS change separately, and deploy the reviewed code. BothQ remains live; no cutover or dual writes are authorized here.

## Helium setup attempt

The owner authorized the existing Helium session. On 2026-10-28, Helium was running with remote debugging on port 9222 and the DevTools MCP process was configured for that port. Browser MCP opened a new Clerk dashboard tab in the `Agent Memory setup` group, tab ID `1355925921`. Its transport then closed on the close-tab attempt and repeated list-tab calls. DevTools subsequently showed one fewer Clerk dashboard tab, but Browser MCP did not confirm closure or group removal. No Clerk settings were inspected or changed. Restore Browser MCP connectivity and verify cleanup before continuing. Clerk configuration and DNS proposals remain unknown; G1 remains untested.

On the resumed attempt, this session's first Browser MCP `browser_list_tabs` call again returned `Transport closed`. The parent reported a working separate Browser MCP session, which does not establish this session's tab ownership or cleanup. No new tab was opened and no Clerk settings were changed during the resumed attempt.

## Clerk setup, fresh session

On 2026-10-28, a fresh Browser MCP session listed no owned tabs. DevTools listed nine pages before a new background tab was opened; the new page was identified by the delta as page 10. Helium was running with port 9222 and DevTools was configured for that port. The earlier tab and group cleanup remains unconfirmed; this session's empty owned-tab list does not resolve it.

Created Clerk application `Agent Memory` (`app_3LKOfhjWWkS9uCUTUlQ9F3DeM8t`) and production instance `ins_3LKOqGARK9NsjTwXYqM0OWZ4OyN`, cloned from development with invite-only access. Production Users showed no users. No owner user ID exists yet. The dashboard's create-user form has a password field; owner provisioning and sign-in remain pending. Google sign-in also requires custom production credentials according to Clerk's setup checklist.

Production OAuth settings show CIMD published, admission of any compatible CIMD client, DCR off, S256 PKCE required, JWT access tokens and Include Audience enabled. The advertised custom scope `memory` is allowed for dynamic clients; `offline_access` is included in their allowed and default scopes. Refresh behavior and token lifetime were not verified. The production Frontend API is `https://clerk.memory.wrick17.com`; the dashboard displays discovery URL `https://clerk.memory.wrick17.com/.well-known/openid-configuration` and publishable key `pk_live_Y2xlcmsubWVtb3J5LndyaWNrMTcuY29tJA`. The issuer claim remains unverified until discovery is reachable.

Clerk shows the domain and all records unverified. Proposed CNAMEs in the `wrick17.com` zone are:

| Name | Target |
|---|---|
| `clerk.memory` | `frontend-api.clerk.services` |
| `accounts.memory` | `accounts.clerk.services` |
| `clkmail.memory` | `mail.y1pdlga1re5i.clerk.services` |
| `clk._domainkey.memory` | `dkim1.y1pdlga1re5i.clerk.services` |
| `clk2._domainkey.memory` | `dkim2.y1pdlga1re5i.clerk.services` |

These are proposals only. Check authoritative existing records and obtain individual owner approval before each DNS change. No Cloudflare integration was connected. G1 real-token checks remain untested. Browser MCP returned `Transport closed` while closing this session's owned tab `1355925923`; DevTools then reported the selected page closed and returned to the nine-page baseline. Browser MCP did not confirm closure or group removal.

## Owner user confirmed

On 2026-10-28, the production Users list contained exactly one user. Its ID is `user_3LKQ6KGbDJZfXH8o4UfNqcq6mig`, for `OWNER_USER_ID`. This supersedes the earlier empty-list observation. No credentials or user settings were inspected or changed. The public Frontend API discovery and issuer remain unverified until DNS works; G1 is untested.

The same read-only session inspected the signed-in Cloudflare DNS dashboard; see [the DNS lookup](phase-1-dns.md#signed-in-dashboard-lookup). Helium ran on CDP 9222. Browser MCP reported `Transport closed` during the owned tab's close; DevTools confirmed that page closed. Two baseline pages disappeared independently during the session, so the full baseline was not restored. Group removal and earlier cleanup remain unconfirmed.

## Infrastructure verification, 2026-10-28

The owner’s latest authorization supersedes the earlier approval gates. The app remains undeployed and BothQ remains live. See [DNS evidence](phase-1-dns.md#completed-clerk-records-2026-10-28) and [independent checks](phase-1-verification.md).

- Clerk’s production domain is verified, including all five CNAMEs and issued Frontend API and account portal certificates. Discovery reports issuer `https://clerk.memory.wrick17.com`, matching `CLERK_ISSUER`, and its JWKS endpoint returned one RSA RS256 signing key. Discovery advertises authorization-code, refresh-token and device-code grants, S256, `memory` and `offline_access`. It did not publish a resource-parameter support flag. The dashboard shows CIMD publication and admission of compatible clients enabled, DCR disabled, PKCE required, JWT access tokens and Include Audience enabled. `memory` is allowed for dynamic clients but is not among their defaults. Real token claims and refresh remain untested.
- Wrangler 4.154.0 authenticated to the personal account. Cloudflare’s domain overview lists Workers Paid under Active Subscriptions. The earlier billing API 403 remains a separate limitation.
- Created R2 bucket `agent-memory-backups`, APAC, Standard. `wrangler r2 bucket info` reported zero objects and zero bytes.
- One live Workers AI call with a synthetic sentence to `@cf/qwen/qwen3-embedding-0.6b` returned shape `[1,1024]`. Created `agent-memory-cards`; `wrangler vectorize get` reports 1024 dimensions and cosine. The `kind` string metadata index creation was accepted and enqueued (mutation `8a3094ab-10a0-404c-9344-b2b39670c901`), but the immediate list returned no metadata indexes. Its availability must be checked before live G5; no polling was performed.
- `ACCOUNT` and `PROFILE` are configured as SQLite classes in migration `v1`, which will be created by deployment. `AI`, `VECTORS`, and `BACKUPS` bindings already name the intended resources. The route is not bound. Once review clearance and deployment readiness are confirmed, the intended Wrangler custom-domain route is `{"pattern":"memory.wrick17.com","custom_domain":true}`; recheck the exact hostname for conflicting DNS immediately before binding. No Worker or route was deployed in this session.
- The T3 environment-links callable was unavailable in this session. No second physical machine or headless host was identified or accessed. G1 T1-T6 and live G5 require reviewed deployment, a second physical machine, a suitable headless host and any needed owner login; T4 also requires the real token lifetime to elapse.
