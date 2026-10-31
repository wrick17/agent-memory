# Agent Memory

Give your coding agents a shared place to remember what matters. Agent Memory is being built to help Claude Code and Codex pick up decisions, notes, and context across sessions and machines, so you do not have to explain the same things again.

## Where it stands

Agent Memory has imported and refreshed 1,374 approved Work records: 1,014 from BothQ, 310 from Codex Markdown, and 50 from Claude Markdown. Another 119 records remain held. These are selected sources, not complete chat histories. Fresh Codex and Claude conversations can use the installed, authenticated clients for core memory calls; start a new conversation to load the current tools.

The [dashboard](https://memory.wrick17.com/) opens the Work graph with 1,379 records and 174 links. Dark canvas text contrast and fresh owner Google sign-in passed selected live checks. [Verification](docs/combined-verification-2026-10-30.md#live-whole-graph-2026-10-31).

In [Review](https://memory.wrick17.com/#/review/work), the owner can review captured suggestions and promote or dismiss them. Migration review queues remain open.

Move, wipe preview and copying eligible current text to another profile are deployed; public TLS and control checks passed. Browser acceptance remains open. Copy creates a new memory without history or links and excludes unsupported, inactive, archived, unreadable or oversized items. [Evidence](docs/combined-verification-2026-10-30.md#move-wipe-preview-and-copy-source-verification-2026-10-31).

The graph includes an unsaved what-if view with local draft items and a metadata comparison. It is deployed with public TLS and control checks; browser acceptance remains open. [Evidence](docs/combined-verification-2026-10-30.md#what-if-graph-deployment-2026-11-01).

The hosted Work profile and Account both passed recovery drills. [Evidence](docs/combined-verification-2026-10-30.md#hosted-work-import-and-recovery-2026-10-31).

Automatic capture source is adopted, but capture is off and not installed; runtime acceptance remains blocked. Sign-in and model selection succeeded, but all eight diagnostic requests are spent. The eighth omitted Content-Type and encountered an undocumented event; the production MIME gate would refuse it. The project corpus, self-host setup, first scheduled backup execution, and multi-machine use remain open. BothQ remains running and readable as a legacy archive; its ordinary bridges are fenced.

## Completed development milestones

- [x] Lifecycle, daily server and observed-count source delivered with local verification; feed collection is no longer a product goal.
- [x] Imported and audited 1,374 approved Work records, then completed the guarded final refresh. The 119 held records were not imported.
- [x] Restored the hosted Work profile and Account; created and verified the new Agent Memory task journal.
- [x] Deployed the dashboard and verified a synthetic Work reference save, retry, edit and history in the owner browser session.
- [x] Deployed the whole Work graph and verified its live metadata, search, selection and navigation controls.

## Feature acceptance

A checked item works for the stated scope. **Owner trial** means it was exercised in the isolated trial, not yet adopted for everyday use. The [feature manifest](docs/feature-manifest.md) and [trial evidence](docs/import-verification.md#isolated-core-trial-2026-10-30) contain the detailed status.

### Remember and find memories

- [x] Save a memory and add to a journal (owner trial).
- [x] Find a memory by searching and read its history (owner trial).
- [x] Explore a simple connection between two items (owner trial).
- [ ] Find memories as they were at a chosen point in time.
- [ ] Manage a memory's full lifecycle, including renaming, moving, retiring, and restoring it.
- [x] Review captured suggestions and turn them into memories (canonical owner flow).

### Bring existing memory

- [x] Import and check an older copy of BothQ and curated memory files (owner trial).
- [x] Migrate and audit the latest approved Work library: 1,374 records migrated; 119 remain held.
- [x] Run the guarded final anchored refresh while preserving checked history and requests. This is not ongoing automatic synchronization.

### Automatic memory, journals, and preferences

- [x] Summarize a journal and undo the summary (owner trial).
- [x] Store a preference with its supporting evidence (owner trial).
- [ ] Capture useful context automatically after agent sessions.
- [ ] Learn and maintain preferences automatically, with evidence and owner control.
- [ ] Clean up old or duplicate material safely, with history and undo.

### Work and project context

- [ ] Remember project, commit, pull request and Jira references encountered during work, including IDs, URLs and useful context, so they can be found later. Do not read or manage PR or Jira feeds.
- [ ] Search and explore the project corpus; it is not available yet.
- [ ] Provide current work boards and regular project reviews.

### Dashboard, control, and privacy

- [ ] Use a finished dashboard to browse memories and activity, explore a visual map, and try unsaved what-if changes.
- [ ] Manage and fully verify separation of personal and work profiles, their links, access, moves, and undo.
- [ ] Remove work-origin data safely while preserving unrelated personal memory.

### Setup, recovery, and everyday use

- [x] Sign in to the private memory service with an isolated client (owner trial).
- [ ] Set up and run your own independent deployment. A separate test deployment passed sign-in and selected memory checks; everyday setup remains unfinished.
- [ ] Back up and restore memories in everyday use. Hosted profile and account recovery passed; nightly export is scheduled, but its first execution has not been observed.
- [ ] Use and verify the same memories across multiple machines.
- [ ] Switch everyday Claude, Codex, and headless agents to Agent Memory after migration and acceptance checks.

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

The planned capture client builds bounded digests locally. Local raw transcript files are not uploaded, though a digest can include short excerpts. A private ChatGPT sign-in works, but automatic capture remains off while model compatibility is checked.

## Explore the project

The [feature manifest](docs/feature-manifest.md) tracks what is implemented, tested, and still planned. The [architecture](docs/architecture.md) explains the design and its checks. For local development, install dependencies with `npm ci` and run `npm run check` to run the repository checks.
