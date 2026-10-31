# Agent Memory

Give your coding agents a shared place to remember what matters. Agent Memory is being built to help Claude Code and Codex pick up decisions, notes, and context across sessions and machines, so you do not have to explain the same things again.

## Where it stands

Your everyday agents still use BothQ. Agent Memory has a private owner trial where basic saving, searching, history, and connection exploration work, and an older copy of your memories has been imported and checked. Your latest memory library has not been migrated to production, and your agents have not switched over.

The current source groups, including the daily server, authenticated scope and observed-commit counts, have passed local combined and self-host package checks; this does not establish everyday readiness. [Verification](docs/combined-verification-2026-10-30.md#counter-and-backend-local-verification-2026-10-31).

A private Work migration planning checkpoint has been accepted; reconciliation and migration are still pending. [Scope](docs/module-contracts.md#current-private-work-planning-checkpoint-2026-10-31).

Automatic capture is not running. The dashboard, work and project corpus, self-host setup, backups, and multi-machine use are not ready. BothQ will remain running and readable after the eventual caller transition.

## Completed development milestones

- [x] Lifecycle, daily server and observed-count source delivered with local verification.
- [x] Personal acquisition, exact retry and durable acknowledgements verified with synthetic data against a local Worker. The client is unwired and uninstalled.
- [x] Private plan for 1,370 Work records accepted. Migration has not run.

## Feature acceptance

A checked item works for the stated scope. **Owner trial** means it was exercised in the isolated trial, not yet adopted for everyday use. The [feature manifest](docs/feature-manifest.md) and [trial evidence](docs/import-verification.md#isolated-core-trial-2026-10-30) contain the detailed status.

### Remember and find memories

- [x] Save a memory and add to a journal (owner trial).
- [x] Find a memory by searching and read its history (owner trial).
- [x] Explore a simple connection between two items (owner trial).
- [ ] Find memories as they were at a chosen point in time.
- [ ] Manage a memory's full lifecycle, including renaming, moving, retiring, and restoring it.
- [ ] Review captured suggestions and turn them into memories.

### Bring existing memory

- [x] Import and check an older copy of BothQ and curated memory files (owner trial).
- [ ] Reconcile the latest memory library, resolve routing decisions, and migrate it to production.
- [ ] Keep the imported copy up to date while preserving history and preventing conflicting changes.

### Automatic memory, journals, and preferences

- [x] Summarize a journal and undo the summary (owner trial).
- [x] Store a preference with its supporting evidence (owner trial).
- [ ] Capture useful context automatically after agent sessions.
- [ ] Learn and maintain preferences automatically, with evidence and owner control.
- [ ] Clean up old or duplicate material safely, with history and undo.

### Work and project context

- [ ] Keep project, commit, pull request, and Jira context current as work happens. Pull request and Jira collection is not live.
- [ ] Search and explore the project corpus; it is not available yet.
- [ ] Provide current work boards and regular project reviews.

### Dashboard, control, and privacy

- [ ] Use a finished dashboard to browse memories and activity, explore a visual map, and try unsaved what-if changes.
- [ ] Manage and fully verify separation of personal and work profiles, their links, access, moves, and undo.
- [ ] Remove work-origin data safely while preserving unrelated personal memory.

### Setup, recovery, and everyday use

- [x] Sign in to the private memory service with an isolated client (owner trial).
- [ ] Set up and run your own independent deployment. A separate test deployment passed sign-in and selected memory checks; everyday setup remains unfinished.
- [ ] Back up and restore memories; backups have not been built yet.
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
