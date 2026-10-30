# Agent Memory

Give your coding agents a shared place to remember what matters. Agent Memory is being built to help Claude Code and Codex pick up decisions, notes, and context across sessions and machines, so you do not have to explain the same things again.

## Where it stands

The private MCP server is running for owner testing. Selected memory reads and recall have been checked through Claude, Codex and scoped device access. BothQ remains the live memory system until the replacement passes its remaining checks and cutover is ready. This is not yet a one-click deployment template.

## Progress

The [feature manifest](docs/feature-manifest.md) has feature-level status and evidence. Checked items below are specific milestones, not completed features.

The immediate priority is to verify the main MCP as a replacement for BothQ. The reviewed core is deployed to a separate trial. Its isolated authentication checks passed, the retained 1,330-record copy matched the import audit, and the owner-selected recall gate passed 29 of 30. Synthetic client writes and replay passed in the trial. Production migration, refresh, capture and cutover remain open. Detailed evidence is in [import verification](docs/import-verification.md#isolated-core-trial-2026-10-30).

The older rehearsal dashboard page is reachable, but signed-in use has not been verified. Dashboard work is deferred until after the main MCP. The planned dashboard will let the owner explore memory connections and try unsaved what-if changes on a visual canvas; those experiments must not change stored memories.

### Core and import

- [x] Approve the architecture and feature manifest.
- [x] Deploy the private MCP server for owner testing and pass selected client, read, and recall checks.
- [x] Close four core integration findings in independent review of frozen source.
- [x] Pass the 121-file candidate's combined checks: typecheck, lint, 185 Worker tests, 75 local tests, generated types, and deployment dry runs.
- [x] Pass the earlier 126-file candidate's combined checks: typecheck, lint, 218 Worker tests, 76 local tests, generated types, and deployment dry runs.
- [ ] Verify core memory on the updated hosted build and finish client authentication gates.
- [x] Build read-only export and import planning; check bodies and history for 1,330 records in isolation.
- [x] Exercise 100 recovered request replay calls in the rehearsal.
- [x] Complete all 60 rehearsal batches and check supersession links and kind filtering.
- [x] Audit the rehearsal test profile: 1,330 records, 4,678 revisions, and 3,182 requests matched with no mismatch, extra, or drift.
- [x] Run the owner-selected 30-query recall gate on the isolated updated build: 29 of 30 matched the expected top-five result.
- [x] Close the three refresh review findings on the corrected frozen source.
- [ ] Verify refresh, rollback, and write bounds on the updated hosted build.
- [x] Validate the reviewed routing input locally: 158 bindings plan, two identity conflicts remain held, and all 969 earlier record hashes stay unchanged.
- [ ] Resolve routing holds, reconcile a fresh source, and validate the production copy.
- [ ] Complete cutover. BothQ remains the sole live memory system until then.

### Capture and memory tools

- [x] Close the capture lock recovery finding and integrate its fix with local tests.
- [ ] Verify capture parity and install automatic capture.
- [x] Close the six graph fixes in scoped source review, including MCP and ingest checks.
- [ ] Verify the graph fixes on the updated hosted build.
- [x] Close seven transfer and wipe findings in independent review of frozen source.
- [ ] Verify transfer and wipe on the updated hosted build.
- [x] Close the earlier maintenance review findings and fix undo for edges changed within the same millisecond.
- [x] Complete a synthetic local job through the real model, job token, Worker and database; verify scope refusals and a skip that leaves work queued.
- [ ] Verify maintenance and undo on the updated hosted build, including jobs, leases, saves, and owner actions.
- [ ] Complete the daily batch, queue, pruning, and size limits. The production tool-inventory gate and browser proof of the batch-status indicator remain open.
- [ ] Complete journal compaction, preference inference, and promotion to `me`.
- [x] Build and independently review owner-model reads in source, including the local route integration.
- [ ] Complete the inferred-preference lifecycle and the About you page.

### Dashboard and remaining work

- [x] Build and locally test the first read-only dashboard source; load its signed-out shell in the rehearsal.
- [ ] Verify signed-in dashboard flows, reader access, and accessibility. An earlier Google sign-in attempt reported a missing client ID; browser setup inspection was blocked by a disconnected extension.
- [ ] Complete the remaining dashboard pages and actions outside backup and restore.
- [x] Build and locally test deterministic work-board reads and the reviewed Work page in source.
- [ ] Complete work-context uploads, daily refresh, and strategic reviews.
- [ ] Build the optional Paid corpus ingestion, query, and refresh flows.
- [ ] Complete self-host setup and verify client connections to a separate deployment.
- [ ] Build and verify backup and restore in the final stage, after the other features.
- [ ] Verify physical cross-machine use and the final cutover.

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

The planned capture client builds bounded digests locally. Local raw transcript files are not uploaded, though a digest can include short excerpts. Capture is still being developed and is not running automatically.

## Explore the project

The [feature manifest](docs/feature-manifest.md) tracks what is implemented, tested, and still planned. The [architecture](docs/architecture.md) explains the design and its checks. For local development, install dependencies with `npm ci` and run `npm run check` to run the repository checks.
