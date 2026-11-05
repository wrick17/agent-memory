# Agent Memory

Give your coding agents a shared place to remember what matters. Agent Memory is being built to help Claude Code and Codex pick up decisions, notes, and context across sessions and machines, so you do not have to explain the same things again.

## Where it stands

Agent Memory is being prepared to replace BothQ for everyday use. The approved migration contains 1,374 Work records, 5,699 revisions, 4,173 requests and 5,291 audited texts with zero semantic mismatches or drift. Another 119 records remain held and excluded. These are selected sources, not complete chat histories. [Migration evidence](docs/import-verification.md#core-v1-source-and-runtime-checkpoint-2026-11-02).

- [x] Import and audit the approved records, history and request receipts at the recorded scope.
- [x] Exercise core save, journal, recall and history operations in the owner trial.
- [x] Restore full-size Account and Corpus data, verify Account checkpoint rollback, and reconcile the retained records, history, replay and corpus at the recorded scope.
- [x] Release the earlier reviewed recovery and capture privacy fixes to the everyday canonical service.
- [x] Verify authenticated read, write, journal and capture flows in the actual Claude, Codex and T3 clients and machines at the recorded scope.
- [x] Verify automatic preference learning from captured evidence, including owner controls, and enable the intended capture-to-learning path.
- [x] Switch the agreed everyday callers and competing native-memory writes using retained rollback snapshots.
- [ ] Release the keep-all manual export, then use it before the v2 fixture upgrade and the canonical migration.
- [ ] Add the v2 viewer and local workflows. Source for device `GET /v1/whoami` is in review (part of #4) and is not deployed. The other routes are unfinished.
- [ ] v2 recall channels, recall hit counts and eval records (#9): source in review, not deployed.
- [ ] v2 digest-backed session list, detail and provenance (#12): source in review, not deployed.
- [ ] v2 replay-safe maintenance leases, stale-record queue and recall-count retention (#10): source in review, not deployed.
- [ ] v2 device status reports and deterministic health checks (#11): source in review, not deployed.
- [ ] v2 activity summaries and project profiles (#15): source in review, not deployed.
- [ ] v2 owner-only live viewer events with cursor resume (#14): source in review, not deployed.
- [ ] v2 viewer snapshot with real counts, usage, health and version (#13): source in review, not deployed.
- [ ] v2 Lessons and Actions server reads (#27): source in review, not deployed; the tabs are separate.
- [ ] v2 CLI config defaults, read token and job client helpers (#6): source in review, not installed.
- [ ] Opt-in prompt recall for Claude Code and Codex (#19), off by default: source in review, not installed.
- [ ] Daily launchd job, device status report, doctor and backfill (#18): source in review, not installed.
- [ ] v2 recall eval runner, `agent-memory eval` (#20): source in review, not deployed.
- [ ] Capture before compaction, scheduled runs, session facts and device status (#16): source in review, not installed.
- [ ] Dashboard shell and live data client (#23, #24): source in review; not deployed.
- [ ] Memories tab and owner-only per-profile search (#26): source in review; not deployed.
- [ ] Lessons, Crystals and Actions tabs (#27): source in review; not deployed.
- [ ] Graph tab with accessible controls (#28): source in review; not deployed.
- [ ] Sessions and Replay tabs (#29): source in review; not deployed.
- [ ] Activity and Project profile tabs (#30): source in review; not deployed.
- [ ] Audit across profiles and restyled Admin pages (#31): source in review; not deployed.
- [ ] Overview and Health tabs (#25): source in review; not deployed.
- [ ] Add the source-only batch transport for issue #17, with retries, stable request IDs and lease handling, before runtime lease acceptance (#10) and trigger forwarding (#16).
- [ ] Local full-transcript replay, `agent-memory replay` (#22): source in review. `agent-memory install` copies it beside the CLI, but it is not installed on any machine.
- [ ] Self-host setup for the dashboard's replay player (#39): `npm run setup` writes the Text loader rule for `local/*-player.js`, and the self-host package includes `local/replay-player.js`. Source in review; scoped setup tests (5/5) and dry-run builds pass, and no deployment has used it yet.

Full-size Test Corpus restore opened with all 7,549 chunks and no findings. Account restore, preservation checks and checkpoint rollback passed in the isolated fixture. The later Account reconciliation and learning changes are deployed to canonical. Actual Claude, Codex and T3 client checks and ordinary cutover passed at their recorded scopes. Main's normal Work learning is enabled and has processed a batch. Native Claude refresh has not been observed. Thirty-two preserved capture entries predate activation and currently have missing sources; their disappearance time is unknown. [Current evidence](docs/import-verification.md#account-recovery-and-learning-preview-2026-11-02).

The reviewed profile-selection change is deployed to canonical and passed bounded checks on all four profiles. It lets agents choose an authorized profile without storage classifying memory content; legacy omitted-profile routing remains compatible. [Verification](docs/import-verification.md#profile-selection-local-verification-2026-11-04).

Project and strategic reviews, the broader dashboard and reader trial, full-size Work-wipe expansion, cosmetic polish and exhaustive test matrices are follow-up work. Proactive PR and Jira feeds remain excluded. BothQ stays running and readable as a legacy fallback; there are no ordinary dual writes. The [feature manifest](docs/feature-manifest.md) retains the broader historical commitments and their evidence.

## Connect a client

You need access to your own deployed server and its MCP URL before starting. The current hosted instance is private and owner-only; it is not a public service or open for registration. Replace `https://YOUR-DEPLOYMENT.example/mcp` below with your own URL.

For Claude Code, add the server, then use `/mcp` in Claude Code to sign in:

```sh
claude mcp add --transport http memory https://YOUR-DEPLOYMENT.example/mcp
```

For Codex, add the server and follow the sign-in prompts:

```sh
codex mcp add memory --url https://YOUR-DEPLOYMENT.example/mcp
codex mcp login memory
```

Codex may open a browser during setup. Sign-in uses Clerk; scoped device access is available for supported headless use. These commands connect to an existing deployment and do not provision one.

## Privacy and capture

The planned capture client builds bounded digests locally. Local raw transcript files are not uploaded, though a digest can include short excerpts. Personal capture hooks are enabled; bounded Main and T3 capture passed, while MacBook capture and full parity remain pending. The separate own-app model path remains blocked after eight diagnostic requests.

To review a full session on the machine that recorded it, run `agent-memory replay --list`, then `agent-memory replay --session ID`. The viewer listens on 127.0.0.1 only, behind a private URL token, and uploads nothing.

## Explore the project

The [feature manifest](docs/feature-manifest.md) tracks what is implemented, tested, and still planned. The [architecture](docs/architecture.md) explains the design and its checks. For local development, install dependencies with `npm ci` and run `npm run check` to run the repository checks.
