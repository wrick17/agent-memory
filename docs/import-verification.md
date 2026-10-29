# Import verification and rehearsal preparation

## Rehearsal link and recall fixes, 2026-10-29

The reviewed 56-file freeze, aggregate `e9bdbb3f717556716023d451874d589b906cce2aea2fe1750983c650b30bf35a`, matched the workspace, test snapshot and commit `c5a1c60331014d41b26118c3ba55734494261c4f`. The private snapshot archive SHA-256 is `d37a3916d9a36a9e9a163c87a9e7a1ec97a7bb625b4daedc2a135842061ae88a`. `npm run check` passed 71 Worker and 47 local tests; generated types and production and rehearsal dry runs passed. Production import profiles were empty and rehearsal used `test`. The sealed snapshot deployed to rehearsal version `6801c86e-b362-4c73-9e79-92a95dc9d0e5`.

The retained commands, batch schedule and stopped state matched their recorded hashes before the resumed upload. Batch 60 completed with nine replayed and five linked receipts; all 60 batches are acknowledged. The resulting state SHA-256 is `5232e406d439db0501c1a16584bef66419729c68d8b4de1a036c25134f4f244b`. C04 found all eight supersession links in both directions, and the C09 kind-filter check passed with five results.

The prepared 30 candidate recall cases are not an owner-selected set. The first run matched 28 expected records in the top five and had two network fetch failures. Retrying those two produced one match and one miss, G16, for 29 matches and one miss across the set. This is not a completed owner recall gate. Prior full body and history checks and 100 replay calls were not repeated. Hosted request ledger bytes and provenance remain unverified through the approved read API; production import, capture installation and cutover remain pending. Private logs and responses are in `/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/agent-memory-c0-y0_jxvjt/`.

## Restricted-profile isolation and expected integrity fixture, 2026-10-29

On the unchanged published rehearsal version `8e197b3c-ec10-4436-bed4-0fec8d848334`, C12 passed using a newly created `read`-only device restricted to `personal`, with default `personal`. Owner OAuth successfully read the pinned `test` record by ID. The restricted device received `forbidden` for that direct ID and for an explicit `test` inventory request. Its default and explicit `personal` inventories returned empty results; owner OAuth's `me` inventory also returned empty. An explicit `me` request by the restricted device was forbidden. The device is retained and its token is mode 0600; no test record or data was written.

Prepared the private expected-data fixture `/tmp/agent-memory-isolation-audit-20261029/expected-integrity-v1.json`, schema version 1, SHA-256 `89101631ec6963b290d1b8beb759bc44dea8687b53552d2ea75c1c1dbcda253f`. It derives solely from the pinned published stage/finalize commands and their published receipts. It covers 1,330 records, 4,678 revision rows and 3,182 request rows, with complete source identity coverage: 985 BothQ, 47 Claude Markdown and 298 Codex Markdown records. An independent pass checked every finalize node's attributes, source and node hashes and identity mapping, every staged request's operation/hash/result byte digest and every staged revision's selected hashes and identifiers: zero mismatches. The plan, batch schedule and stopped upload state stayed unchanged.

Each private record includes its published ID and profile; source system and source-ID mapping; canonical SHA-256 of the node, node attributes and source provenance; revision and request counts; selected revision fields and raw snapshot/delta UTF-8 hashes; and each original request ID, operation, legacy hash, raw result UTF-8 SHA-256 and byte length, and canonical request-source hash. BothQ source mapping uses the staged element ID and fingerprint; Markdown mapping uses the staged realpath and paths. Object canonicalization recursively sorts object keys with JavaScript string ordering, preserves array order, omits undefined object properties, applies `JSON.stringify`, and hashes UTF-8. Request result and revision snapshot/delta hashes use the exact staged strings' UTF-8 bytes without parsing or reserialization. This fixture does not include raw request results or revision bodies.

This is **expected data**, not hosted integrity evidence. The approved read API still cannot expose stored per-record request counts, hashes and raw result bytes or imported provenance attributes; verification 2 and complete provenance/source-ID reconciliation remain open until approved minimal read support exists. No endpoint, API policy, schema, hosted SQL or debug path was designed or changed here. The five link refusals and SQL-variable recall failure remain open, and the 30 prepared candidate queries are not an owner-selected set. This is not a rehearsal or production-readiness pass.

## Recovered historical request replay, 2026-10-29

On the unchanged published rehearsal version `8e197b3c-ec10-4436-bed4-0fec8d848334`, all 50 recovered original calls returned `replayed` with every saved logical result field matching, apart from the documented replacement of the action. All 50 changed-argument calls with the same request IDs returned `idempotency_mismatch`. The sample contains 46 append, three save and one update operation. It was randomly sampled from 3,171 recovered eligible requests, not uniformly from all 3,182 exported requests; eleven requests had no qualifying structured input in the searched sources. This is real recovered-payload replay evidence, not an assertion about the unrecovered eleven.

Before any calls, the fixture SHA-256 `f00de9156b963f073b034db0431d772819dd18df8aca5355a22bb7b1d40327e9`, manifest SHA-256 `c71d12ff974a9a7744d59e8339bf262fe16905d339838f166f0867f5502cb71f`, all manifest input and artifact hashes, and all 50 distinct request IDs, original hashes, results and target IDs matched the pinned plan and published receipts. The fixture and all these pins matched again after the run. Original argument normalization and the fixture's update-to-save translation were preserved; no argument was invented or silently removed.

Before and after, the complete history-inclusive inventory contained the same 1,330 unique IDs. All 33 affected records retained the same revision, content hash, complete-body SHA-256, history count and canonical returned-history SHA-256. Each call was followed immediately by a target revision/content-hash check; no change was observed. These checks show no new node or visible revision, body or history changes. The approved read API does not expose raw stored request rows, request count or raw result-text digest, so unchanged request-ledger bytes and raw-text equivalence remain unproved. Replay output establishes the logical result fields visible through the MCP wrapper.

Private baseline, post-run checks, call responses and scripts are in `/tmp/agent-memory-replay-gate-20261029/`, directory mode 0700 and files mode 0600. The retained upload state still has 59 acknowledged batches and the five link refusals; its SHA-256 remains `2539918786438c686d5e0f227c97efbfd50c1398eefdcc2979cd7857b898f4d2`. The separately reported SQL-variable recall failure remains open. No new test record, device, token, deployment, upload retry, source or plan edit, or production change occurred. BothQ remains the live system.

## Read-only hosted parity against the published snapshot, 2026-10-29

These checks use rehearsal version `8e197b3c-ec10-4436-bed4-0fec8d848334`, the retained export and fixed rehearsal plan, and the published 55-file cleared freeze as the source baseline. The author was concurrently fixing local code, so this is not a claim that current source still matches that freeze. All 12 inputs and 14 fixture artifacts in the private fixture manifest matched their hashes before and after the checks; the freeze file also matched. The candidate-query fixture manifest SHA-256 is `96d3ef0e0838ea9259a1a0191fb74c5ae5a5c8351bdb0c06646cfa04547ad5fa`. The export is an older snapshot; the separate live Markdown witness found three changed files and 44 missing paths, and does not establish live-source consistency.

Inventory found exactly 1,311 active and 1,330 including history, with the expected IDs, no duplicates and stable active order on a second enumeration. The isolated rehearsal `me` inventory was empty. For all 1,330 planned records, complete paged content SHA-256 matched the body reconstructed from the pinned staged text rows; returned content hashes and selected full fields matched the plan. Their IDs, types, profiles, revisions and statuses matched, as did history counts, returned history rows and `valid_from` values. The first private checker incorrectly compared raw body SHA-256 to the distinct BothQ content-hash algorithm and reported zero matches; the corrected comparison above uses staged body bytes and checks the returned content hash separately.

The largest journal reassembled over ten pages to 987,013 UTF-16 code units with SHA-256 `e46ec710cfe0c275c295d3445fcd3eb783d3a4169bcf011cebfee5e64f911663`. It returned 664 revisions and 663 append deltas. Its 664 imported request records are present in the pinned export; their hosted count and hashes are not exposed by the approved read API. A separate pinned-history check compared all 766 revision details across four records in ten pages, including canonical snapshot/delta hashes, request IDs and dates, with no mismatch.

The prepared 30-case candidate retrieval set is **not owner-selected**. An initial run yielded five matches and 25 tool errors. A diagnostic pass over those 25 yielded five further matches and 20 errors; all 20 were `SQLITE_ERROR` reporting too many SQL variables. Thus ten distinct candidates have matched across these attempts, 20 remain unscored due to errors, and there is no valid 30-case score or final owner recall gate. The private evidence preserves the calls and responses, including lexical/vector diagnostics for successful responses. A minimal private repro is candidate `G01` in `golden-queries.json` using its `hosted_call`; the diagnostic response is in `golden-diagnostic.json`. This material hosted recall failure needs the original author; it is separate from the five link refusals. One query string appeared in a tool result during diagnosis; later output was limited to IDs, counts and error categories.

| Companion | Observed result |
|---|---|
| C01, C02 | Complete-content paging and pinned body hashes passed, ten and two pages respectively. |
| C03 | All 766 pinned history details passed across ten pages. |
| C04 | Blocked: three of eight supersession links appear in both directions; five remain refused in batch 60. |
| C05 | Full rule fields matched. Imported source contexts are not exposed by the inspected get API. |
| C06 | Full routine fields and ordered steps matched. Seeded-routine write protection was not tested because this pass permits no new mutations. |
| C07 | Active and history-inclusive inventories matched all expected IDs and counts with no duplicates; active order was stable. |
| C08, C10, C11 | Absent type, other scope and authorized other-profile negative checks passed. |
| C09 | Kind-filter query returned an MCP error; its negative assertion remains unproved. |
| C12 | This earlier pass lacked a restricted read credential. The subsequent personal-only device check passed, as recorded above. |
| C13, C14 | Real cursors reused with another record or read set returned validation errors. The first private parser classified these as generic MCP errors; the retained response and corrected assessment establish the validation codes. |
| C15 | All seven curated Markdown representatives matched their body hashes, revisions and unknown validity. |

Per-record hosted request counts, request hashes/results, imported provenance attributes and full source-ID mapping cannot be inspected through the approved read API and remain open. At the time of this earlier parity pass, the request ledger did not contain original argument payloads, so no replay calls were guessed. The subsequent recovered-payload run is recorded above. The candidate retrieval set, seeded-routine mutation protection, complete supersession links, and the architecture's owner-selected golden set remain open. The upload state remains at 59 acknowledged batches, with the same 1,343 stored stages, 1,330 published records, three links and five refusals. State SHA-256 `2539918786438c686d5e0f227c97efbfd50c1398eefdcc2979cd7857b898f4d2`.

Private read evidence and helper scripts are under `/tmp/agent-memory-readonly-parity-20261029/`, mode 0700/0600. No production access beyond the already completed audience negative, new authentication, upload retry, deployment, plan/export rewrite or data mutation occurred in this parity pass. BothQ remains the live system.

## Cleared freeze and hosted rehearsal, 2026-10-29

After independent closure of the seven fixes, the 55-file freeze `/tmp/agent-memory-import-cleared-freeze-20261029T0445.json` matched before and after all checks, aggregate `d862af68b4826d606d5dfc397f4cfee5d6e3d03b42a3e0853970b25b6e9b9ca7`. `npm run check` passed typecheck, lint, all 70 Worker tests in six files and all 46 local tests in 12 suites, with no local skips, cancellations or todos. Generated types and explicit production and rehearsal dry runs passed. Production's dry-run `IMPORT_PROFILES` was empty; rehearsal's was `test`. The test configuration emitted its existing AI/Vectorize binding warnings and four fake failure diagnostics. Full logs are in `/tmp/agent-memory-cleared-check-20261029.Mr2YVN/`, private mode 0700/0600. The previous 69/1 failure below is historical: Opus corrected the test to observe the deterministic hash invariant, and this complete run passed.

The authoritative Cloudflare dashboard returned no records for the exact rehearsal hostname or a wildcard search. The isolated Worker deployed as version `8e197b3c-ec10-4436-bed4-0fec8d848334`. Curl returned correct protected-resource metadata and the expected 401 challenge. An earlier Python HTTP request received Cloudflare 403; curl and the authenticated checks reached the service, so that response is not evidence of an audience failure.

Isolated file-backed Codex OAuth credentials for both hosts independently had the expected issuer, owner, own-resource audience and `memory` scope. Each host returned whoami 200 to its own credential; each cross-audience request returned 401. The owner API created a rehearsal-only import device, id `3zkxm544righgciw`, and the empty import request returned schema-validation 400. The token and upload configuration remain private mode 0600.

The retained export passed its manifest integrity check; the current rehearsal plan passed its batch schedule hash and dry-run budget checks. It has 1,330 planned `test` records, 1,343 stage, 1,330 finalize and eight link commands in 60 batches. Commands SHA-256 `b6213e44ede36374d46a12952fce4d4e1dce8df4283cd175c982e3784f16687d`; batches SHA-256 `0feca7c9ca5b10a7fe3fd9d58b6c308edf1ed4f8242d40043cf6323282aae915`.

**The upload stopped on batch 60.** Receipts report 1,343 stored stage commands, 1,330 published finalize commands, three linked commands and five link commands refused with `invalid_endpoints`. The first 59 batches are acknowledged; batch 60 is not. The mode-0600 upload state and complete private log are retained. Return the failure to the original Opus author. No retry or code change was made, and the cause of the refusal is not yet established. The receipt counts are not hosted parity proof. Hosted verification 1, 2 and 5 to 8, including largest-journal paging, history, request replay and supersessions, remains open; golden queries remain pending. Do not proceed to production or rerouting.

The two explicitly opened OAuth tabs were closed. The installed CLI's `codex mcp add` unexpectedly started OAuth and opened a separate unmanaged tab before it was interrupted. Its authorization URL appeared in a tool result, so that attempt was discarded. Browser MCP later returned `Transport closed` while closing the owned DNS tab; a DevTools page list showed neither that DNS page nor the unexpected sign-in page. The designated owner tabs were not navigated or adopted. Future isolated setup should write the server entry into private `config.toml` directly and then use `codex mcp login --no-browser`, rather than `codex mcp add`.

BothQ remains the live system. Production was not deployed or imported into; capture was not installed. No fresh export, replanning, backup/restore, cross-machine test or cutover occurred.

## Earlier post-closure verification, superseded by the cleared run above

Post-closure combined verification, 2026-10-29

Freeze `/tmp/agent-memory-import-postfix-freeze-20261029.json` records 54 files and aggregate `3533cb03dbaa143e3a25ee3ef9219be8bd1960efcb948eef12620d1d7dd5805e`. All 54 individual SHA-256 pins matched before and after these checks. This document is outside the freeze. The older 66/41 results below predate the seven closure fixes and are historical, not current proof.

| Check | Result |
|---|---|
| `npm run check` | **Failed** after typecheck and lint passed. Workers: 69 passed, 1 failed, 6 files, no reported skips. `test/isolation-recall.test.ts:117` expected `pending`, received `embedded` in the journal re-embedding test. The chained local suite did not run in this command. Return this failure to the original Opus author through the parent; its cause is not established. |
| `npm run test:local` | Run separately because the chain stopped: 46 passed in 12 suites, 0 failed, skipped, cancelled or todo. |
| `npx wrangler types --strict-vars=false --check` | Passed; generated types are current. |
| `npx wrangler deploy --dry-run --env=''` | Passed; production `IMPORT_PROFILES` is empty. |
| `npx wrangler deploy --dry-run --env rehearsal` | Passed; rehearsal `IMPORT_PROFILES` is `test`. |

Warnings are separate from the failure: Wrangler reports that test AI and Vectorize bindings are not inherited; the tests supply fakes. Four fake Vectorize/embedding errors and the MCP JSON notification warning appeared in the Worker output. Full logs are in `/tmp/agent-memory-postfix-check-20261029.63YE45/`, directory mode 0700 and files mode 0600. No deployment or live authentication occurred.

## Path A runbook prepared before the hosted rehearsal

The architect accepted path A in [architecture section 16](architecture.md#16-migration-and-cutover) and [import implementation](import-implementation.md#rehearsal-resources-for-terra). The earlier mandatory Clerk origin or satellite gate below is superseded: use isolated CLI OAuth for the existing rehearsal `/mcp` resource, then the existing owner `POST /api/devices` API. No Clerk setting, hostname, paid addon or new auth path is required for path A. Its live audience and issuer gates remain unproven.

After the seven-fix closure and explicit parent technical clearance, repeat the authoritative DNS conflict preflight, then run:

```sh
npx wrangler deploy --env rehearsal
curl -sS -D - -o /dev/null https://memory-rehearsal.wrick17.com/mcp
curl -sS https://memory-rehearsal.wrick17.com/.well-known/oauth-protected-resource/mcp
```

Check the 401 challenge names the protected-resource metadata, and the metadata names `https://memory-rehearsal.wrick17.com/mcp`, the configured Clerk issuer and `memory` scope. In a newly created mode-0700 directory, set `CODEX_HOME` to that directory; create its mode-0600 `config.toml` with `mcp_oauth_credentials_store = "file"` and `[mcp_servers.rehearsal]` containing `url = "https://memory-rehearsal.wrick17.com/mcp"`, then:

```sh
CODEX_HOME="$REHEARSAL_CODEX_HOME" codex mcp login --no-browser --scopes memory,offline_access rehearsal
```

Installed CLI help on 2026-10-29 confirms both flags. Capture the authorization URL privately; use the approved owner Helium session for SSO and consent without opening unmanaged tabs. The owner handles any MFA. Do not print credentials, authorization URLs or private export text. Check issuer, owner, rehearsal audience and `memory` scope with boolean-only output. Require rehearsal `GET /v1/whoami` 200 and 401 for each cross-audience direction. Never accept a production audience on rehearsal. If a resource or audience check actually fails, stop and report it; do not classify expiry, network or JWKS errors as a domain issue. The architect's path B is a possible later decision, not an authorized change in this frozen pass.

After those gates, use the owner access token with the existing `POST /api/devices` body `{"name":"rehearsal-import","scopes":["import"],"profiles":["test"],"default_profile":"test"}`. Write the returned `am_imp` token directly to a private mode-0600 file. An empty `{"commands":[]}` POST to `/v1/import` must return 400, not 401 or 403. Create the mode-0600 upload config with `"rehearsal": true`, then follow the separately cleared rehearsal and parity steps in the implementation document. The existing index `agent-memory-cards-rehearsal` is 1,024-dimensional cosine with `kind` String READY, and R2 bucket `agent-memory-rehearsal-ledger` exists in personal account `480b9599b0a599f477e74551a1f82761`. No recreation is needed.

BothQ remains the only live memory system; production imports are disabled, capture is uninstalled, and L4 is deferred. No upload, token creation, backup/restore or physical cross-machine check took place in this pass.

## Historical verification before closure fixes

2026-10-29. Verification against freeze `/tmp/agent-memory-import-review-freeze-20261029.json`, aggregate `651198a4460d77f5979c7981ceee3d99b5e294e22420f37241ffcd0aa13fbbc5`. All 51 listed files matched their recorded SHA-256 hashes before and after the checks. Existing dirty files were preserved.

## Local checks

| Check | Result |
|---|---|
| `npm run check` | Passed typecheck, lint, 6 Worker test files with 66 tests, and 41 local tests in 10 suites. No local tests skipped, cancelled or marked todo; Vitest reported all 66 tests passed. |
| `npx wrangler types --strict-vars=false --check` | Passed; generated types are current. |
| `npx wrangler deploy --dry-run --env=""` | Passed. Production binds the existing index and bucket, and `IMPORT_PROFILES` is empty. |
| `npx wrangler deploy --dry-run --env rehearsal` | Passed. The bundle names the separate rehearsal index and ledger, and `IMPORT_PROFILES` is `test`. |

The Worker suite logged four deliberate fake Vectorize/embedding failure diagnostics while passing. Wrangler warned that `env.test` does not inherit AI and Vectorize bindings; the test configuration replaces them with fakes. Wrangler 4.154.0 also noted an available update. Full command logs are under `/tmp/agent-memory-import-verification-20261029/`, mode 0600. No deployment occurred.

## Rehearsal preparation

Wrangler OAuth identity metadata and the authenticated Cloudflare dashboard independently identify the personal account `480b9599b0a599f477e74551a1f82761`. The account lists the existing production index and bucket. Wrangler reported missing optional OAuth scopes, but the requested list and creation calls succeeded.

- Listed indexes and buckets before creation. Created `agent-memory-cards-rehearsal`; its returned specification is 1,024 dimensions, cosine. Created `agent-memory-rehearsal-ledger`, Standard storage, for the identity ledger only.
- Enqueued the `kind` String metadata index. The immediate list did not show it; the single follow-up list on 2026-10-29 returned `kind` of type `String`.
- The configuration names the separate Worker `agent-memory-rehearsal`, separate Durable Object bindings, index and ledger, with custom domain `memory-rehearsal.wrick17.com`. Durable Object storage is provisioned on deployment. No Worker was deployed or domain bound.
- The authoritative Cloudflare DNS dashboard search for the exact rehearsal host returned no records; a search for `*` also returned none. This is a point-in-time preflight, not proof that a later custom-domain bind will succeed. No DNS change was made.
- The approved Clerk production instance showed `memory.wrick17.com` as its verified primary domain. Its allowed-subdomains control accepts subdomains of that primary domain; the requested `memory-rehearsal.wrick17.com` is a sibling. Satellite domains are marked Pro. No supported exact-origin addition was established and no Clerk settings were changed. The earlier origin gate was superseded by path A above.
- The Clerk setup tab was closed. Browser MCP returned `Transport closed` while closing the Cloudflare setup tab. A follow-up DevTools page list showed the former agent-owned page 10 and its DNS page absent, with the owner Cloudflare home and Clerk instance pages still present. The recorded Browser MCP tab ID could not be independently queried through the closed connection. No other tab was closed.

## Remaining gates

Parent review clearance is required before deployment, upload or commits. Once cleared, repeat the authoritative DNS conflict preflight. This historical origin and Settings sign-in route is superseded by current path A above. Follow the current audience gates and owner API route before preparing the private upload configuration. Use the retained post-closure plans, including their `batches_sha256` values; validate without rewriting them before `node local/upload.mjs --rehearsal test` and hosted parity checks. Production copy follows only after the separate authorized validation and unambiguous routing gates.

These results establish local checks and resource preparation only. They do not establish a hosted rehearsal, production import, backup/restore, physical cross-machine parity, or installed capture.

## Exact-origin follow-up, 2026-10-29

The official [Clerk instance API](https://clerk.com/docs/reference/backend/instance/update) has an `allowedOrigins` setting, documented for browser-like native and extension clients. Clerk's [Electron guide](https://clerk.com/docs/electron/getting-started/quickstart) says its update sets the entire list. Those sources do not establish that adding this HTTPS sibling host enables ordinary ClerkJS web authentication. No setting was changed and no credentials were read.

Clerk's [production deployment guide](https://clerk.com/docs/guides/development/deployment/production) describes authentication across subdomains of the configured root. The observed dashboard primary domain is `memory.wrick17.com`, so `memory-rehearsal.wrick17.com` is not its subdomain. Clerk documents [satellite domains](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains) as a way to share authentication across domains, requiring a paid production plan, satellite registration and configuration, DNS or proxy, and primary redirect allowlisting. `allowedRedirectOrigins` is a client redirect setting, not evidence that the instance accepts the sibling as a normal frontend origin. The observed dashboard marks satellites Pro. This is a documented candidate, not an authorized upgrade or a demonstrated requirement for this exact deployment.

Unauthenticated public Frontend API `/v1/environment` requests from the primary and rehearsal origins returned HTTP 200 for both GET and OPTIONS. An unrelated `.invalid` origin received HTTP 400 for OPTIONS and HTTP 200 for GET; all three responses echoed their request origins. These HTTP results do not prove ClerkJS initialization, OAuth sign-in or session-cookie behavior on the rehearsal host. This was the earlier uncertainty. The architect subsequently selected path A above; its live audience gate remains open. No hostname or security change was made here.

The later path A decision replaces the Settings-session route with isolated CLI OAuth and the owner API, after the current clearance and live audience gates, without another general permission request. Interactive MFA, if prompted, still requires the owner. No credential was created in this preparation pass.
