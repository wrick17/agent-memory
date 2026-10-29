# Agent Memory

Give your coding agents a shared place to remember what matters. Agent Memory is being built to help Claude Code and Codex pick up decisions, notes, and context across sessions and machines, so you do not have to explain the same things again.

## Where it stands

This is an early build under active development. The private MCP server is deployed for owner testing, with selected live checks for reading and recall through Claude and Codex OAuth and scoped device access. The existing memory system, BothQ, stays live until cutover. This is not yet a one-click deployment template.

## Progress

- [x] Approve the architecture and feature manifest.
- [x] Deploy the private MCP server and Clerk sign-in for owner testing.
- [x] Copy initial record bodies into an isolated rehearsal and read them back with history.
- [ ] Complete and verify the core memory features.
- [ ] Finish import validation and copy to production. Rehearsal completed its upload and link checks; one of 30 prepared recall candidates missed, and the owner-selected recall gate remains pending.
- [ ] Install and verify automatic capture.
- [ ] Complete graph moves, maintenance, and wipe.
- [ ] Complete the dashboard, work context, corpus, and self-host packaging.
- [ ] Verify backup and restore and cross-machine use, then complete cutover.

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
