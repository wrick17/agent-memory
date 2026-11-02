# Same-machine Claude OAuth follow-up — 2026-10-29

## Disposable Codex downscope recheck

The earlier owner mismatch below was a helper error: its hard-coded owner value differed from the production pin. A fresh comparison of the exact stored access token sent to `/v1/whoami` showed its subject, the returned claim, and the production and rehearsal configuration pins all match. The test fixture pin is different. The full-scope token passed signature, issuer, owner, resource audience and time checks, included `memory`, and received 200 from production `/v1/whoami`.

One refresh grant requested `offline_access` with the production resource and the original test client ID. The authorization server returned 200 and issued a token that passed the same signature, issuer, owner, audience and time checks, but still included `memory`. This route therefore did not yield a missing-scope token; no negative request was sent, and no conclusion about the live missing-scope rejection follows. The original store was left unchanged; the refresh response, which may contain rotated credentials, is retained only in the private 0600 artifact `/tmp/agent-memory-downscope-6Sgt3VwY/downscope-once-private.json`. Sanitized comparison and result files are in the same 0700 directory. The original refresh grant may have been consumed by rotation. Native Claude refresh and natural expiry remain separate gates.

## Disposable Codex control check

The owner authorized sole use of the old isolated Phase 1 Codex store at `/tmp/agent-memory-live-goBMur/codex/.credentials.json`. It was a current-user-owned regular file with mode 0600. Exactly one entry matched the production resource URL. HTTPS discovery and JWKS returned 200 without redirects. Local JWT verification found a valid signature, the expected issuer and resource audience, a currently valid time window, and the `memory` scope. The JWT subject did **not** match the owner ID in `wrangler.jsonc` and `docs/phase-1-setup.md`. A single read-only request with that token nevertheless returned HTTP 200 from production `/v1/whoami`. The later recheck above resolved this discrepancy as a helper error.

Because the owner check did not pass, no refresh grant or downscope was attempted. The real missing-scope rejection remains unproved. The original store was only read and not modified. Sanitized checks and the private script are in `/tmp/agent-memory-downscope-6Sgt3VwY`, with files mode 0600 in a mode 0700 directory. No token values were printed. This check does not prove native Claude refresh or natural expiry.

## Fresh BrowserMCP recheck

A fresh BrowserMCP context was tried after the prior worker completed. Its recorded terminal activity shows the previous isolated login exited with status 1. The new task-group request and the single tab-list recheck both returned `Chrome extension not connected after 5 retries`. No tab inventory was exposed, no task tab was opened, and no new login was started because the required browser transport was unavailable. The private client remains at `/tmp/agent-memory-scope-followup-IZTibGSe`.

The real missing-scope token, live `/v1/whoami` rejection, and same-host full-scope control remain unverified. No conclusion about the deployed scope enforcement follows from this transport failure. Forced refresh and natural expiry remain separate gates.

## Missing-memory-scope follow-up

A fresh private Codex home at `/tmp/agent-memory-scope-followup-IZTibGSe` used a directly written `config.toml` with file-backed OAuth storage and one test server. Installed CLI help advertises `mcp login --no-browser --scopes`. A no-browser login requested only `offline_access`; inspection of the resulting authorization request confirmed it contained `offline_access` and did not request `memory`. The first launch had no terminal input and exited before consent; a second launch supplied a terminal and reached the callback wait. Browser MCP returned `Transport closed` both for naming the task group and the single tab-list recheck. No task tab was opened, no consent occurred, and the waiting process was stopped. No OAuth credential store was created. No authorization URL or token was printed.

No token was issued, so issuer, owner, signature, time, audience and missing-scope claims were not established; neither `/v1/whoami` negative nor a same-host full-scope control was run. This is a browser-transport blocker, not evidence that Clerk refuses a reduced-scope grant or that the product fails the scope check. The optional refresh downscope was not attempted without an own refresh token. All test files were created mode 0600 in a mode 0700 directory.

Read-only current source inspection shows `verifyJwt` returns status 403 with `insufficient_scope` when a valid resource token lacks the required scope, and the owner API forwards that status. This is source evidence only, not a live result or proof of the currently deployed Worker’s behavior; the requested expectation of 401 therefore needs reconciliation if a live test returns 403. Native Claude forced refresh, natural expiry and the real missing-scope negative remain open.

## Targeted native recall follow-up

A single further Claude model turn reused the existing private project configuration and native OAuth credential; it performed no new login or browser flow. Before the turn, a literal occurring once in the target record body and the record’s actual scope and kind were derived from the previous private `get_memory` output. The turn used those values with profile `test`, a limit of 100 and a 10,000-token budget. Its two native MCP calls succeeded: `get_memory` returned the exact target ID, and `recall_memories` returned six results including that exact ID with a literal match and no truncation. Arguments and raw results remain private in the test directory.

The prior query used a different semantic phrase and limit 1, and did not specify the target’s actual scope and kind. It returned a different result; the available evidence does not isolate whether ranking, query wording, filters, or their combination caused the omission. The successful targeted call does not establish a general ranking guarantee.

Fresh pre/post hash and JSON-structure comparisons covered the same seven ordinary and managed paths listed below. All were unchanged except `~/.plaude/.claude.json`, where four cached experiment/feature data keys changed. Root MCP and project entries were unchanged. The private project `.mcp.json` was not included in this fresh exact-hash baseline; the strict run loaded that file. The prior pre-baseline gap remains unresolved. No source change, record write, deletion, new authentication, forced refresh, or missing-scope test was performed.

## Private project-scoped follow-up

The later owner-authorized project-scoped experiment supersedes the per-run login blocker described below. Claude Code 2.1.312 created a uniquely named HTTP server with `mcp add --scope project` in a new private, empty directory. Its private `.mcp.json` contained only that server. The first `mcp login --no-browser` stopped at project approval; a per-run `--settings` approval for that server and `disableAllHooks` allowed the same CLI login to finish. The inspected managed settings file contained no hooks or force-enabled plugins; this does not establish the absence of every possible managed source. [Claude Code documentation](https://code.claude.com/docs/en/mcp) describes both project scope and the approval behavior.

The actual model turn used the existing personal provider login and `claude-opus-5-5`, loaded the private project file through `--strict-mcp-config` and `--mcp-config`, disabled built-in tools, auto memory, CLAUDE.md loading, session persistence and non-managed hooks, and allowed only `get_memory` and `recall_memories`. Exactly those two native MCP tools ran; neither result had an MCP error. `get_memory` returned the specified synthetic record `63d16625-df80-5241-95c9-84f41246d75f`. `recall_memories` returned one result for `fabricated diary note`, but it was not the specified record. Thus native OAuth read and a successful recall invocation are proved; recall of the target record is not.

Before this follow-up, a private hash and JSON-structure baseline captured `~/.plaude/settings.json`, `~/.plaude/.mcp.json`, `~/.plaude/.claude.json`, `~/.claude.json`, `~/.mcp.json`, and the managed settings and managed MCP paths. The exact post-run comparison found all unchanged except `~/.plaude/.claude.json`. Its root MCP entries and project entries were unchanged; changed top-level keys were cached experiment and feature data, client data cache slots, plugin usage and answer/choice timestamps. This classifies observed bookkeeping at the captured paths, not changes before the baseline or changes to files outside that set. No restoration was attempted.

The consent tab was opened in the task group. Browser MCP reported `Transport closed` when closing it; DevTools subsequently showed the owned consent page absent and both Cloudflare and Clerk keeper pages present. Browser MCP could not confirm group removal. A tab-navigation tool result inadvertently exposed authorization parameters in intermediate tool output; no token value was printed. The authorization completed, but this exposure must not be represented as fully private.

Forced Claude refresh was not attempted: no documented control was established to expire only this test server credential without reading or rewriting other credentials. Natural expiry remains a separate untested gate. The optional missing-scope test was not attempted. The main task owns cross-audience evidence; it was not repeated. Private files, including the baseline and model output, remain in `/tmp/agent-memory-auth-followup-qGfg1xqO`; all files are mode 0600 and the directories mode 0700. No production source or existing document was edited by this verification.

## Earlier per-run probe (superseded)

## Native route

**Blocked before OAuth and model invocation.** Installed Claude Code reports version 2.1.312. Its `mcp login --help` supports `--no-browser`, but does not list a per-run MCP configuration option. In a new private directory, a per-run MCP JSON defined a uniquely named probe server at an unreachable loopback address. Passing that file as `claude --mcp-config=<file> mcp login --no-browser <probe>` produced “No MCP server named” for the probe: the login command did not use the per-run server. Passing `--mcp-config` to `mcp login` instead produced `unknown option`. No OAuth flow, browser tab, model turn, real MCP call, credential read, or credential mutation was attempted.

The official [MCP documentation](https://code.claude.com/docs/en/mcp) describes `mcp login` for a configured server and `/mcp` for interactive authentication. It does not establish a supported no-browser login for a server supplied solely by the per-run file. Adding a persistent ordinary MCP entry, opening an uncontrolled browser, copying credentials, or using the undocumented secure-storage split would exceed the authorized route. No inference is made that another supported path cannot exist.

The private probe configuration and sanitized command logs are under `/tmp/agent-memory-auth-followup-qGfg1xqO` (directory mode 0700; files mode 0600). The probe invoked the CLI with the normal personal provider configuration, but exact pre-probe hashes and JSON-key baselines were not captured. Therefore incidental configuration changes from these CLI probes cannot be classified or ruled out; no restoration was attempted. No production source, settings, MCP configuration, manifest, or existing document was deliberately modified by this verification.

## Evidence layers and remaining gates

- Native OAuth login and actual Claude read and recall: **not attempted**, blocked by the per-run login route above. Previous `headersHelper` and `mcp get` evidence is separate and was not repeated.
- Claude client forced refresh: **not attempted**; no supported isolated credential expiry edit was established. Natural 24-hour expiry is a separate gate and no due date was established here.
- Individually isolated real-token missing-scope negative: **not attempted**. Cross-audience verification belongs to the main task.
- Same-machine source inspection: `src/auth.ts` still contains issuer, owner, resource-audience, and required-scope checks; this is source inspection, not a live negative test. Existing concurrent worktree changes prevent treating the whole worktree as a clean production snapshot.
- Production deploy, imports, backup/restore, full suite, cross-machine checks, and synthetic data writes: **not performed**. BothQ remains the live system per task context.
