# Agent Memory

A shared memory for your coding agents. Claude Code and Codex save decisions, rules and context here, recall them in any session on any machine, and get a short brief at the start of each session. You stop explaining the same things twice.

It runs on your own Cloudflare account, with sign-in through your own Clerk application. Each deployment serves one owner; it is not a shared service.

## What it does

- **One memory for all your agents.** Claude Code and Codex connect over MCP. Desktop clients sign in through Clerk; headless machines use a revocable device token.
- **Separate profiles.** `work`, `personal` and `me` never share a database. The agent picks the profile; storage never guesses from the content. Recall reads the chosen profile plus `me`.
- **Linked knowledge.** Decisions carry their reasons and evidence, and records link to projects, people and work items. Agents can ask why something was decided, follow a path between records or read a timeline.
- **Search that works without AI.** Recall uses exact names and full-text search. Semantic search with Workers AI is optional.
- **Learning from every session.** The local client turns each finished session into a short redacted digest, with Claude Code sub-agents captured as their own sessions. A daily batch reads the digests and records lessons, decisions and preferences. Full transcripts never leave your machine.
- **Guidance while agents work.** Each session starts with a brief of at most 400 tokens: repo facts, the open journal, project rules and decisions, and your `me` preferences. The loop guard adds one short note when a turn keeps failing the same way.
- **Repo facts.** The client spots repeatable command failures in a GitHub repo, such as a missing tool or a command that needs a wrapper. A fact becomes active after 3 confirming sessions and retires on a contradiction.
- **A dashboard.** Browse memories, learnings, journals and projects, and see how they connect on the Map, at `/app`. Owner tools, devices included, sit behind the Settings gear (`/settings` redirects there).
- **Backups and recovery.** A nightly job writes encrypted exports to your own R2 bucket and keeps the two newest. Profiles and account state can be restored.
- **Careful cleanup.** Server housekeeping is rule-based and runs no model. The background batch never changes stated rules, pinned records or `me`, and every change can be undone.

The brief, fact synthesis and the loop guard are off in a new client. Turn them on with `facts.inject`, `facts.synthesis` and `loop_guard.enabled`; see [repo facts and loop guard settings](docs/self-host.md#repo-facts-and-loop-guard-settings).

## Architecture

![Agent Memory architecture: agents and the local client on your machine talk to one Cloudflare Worker, which stores data in per-profile SQLite Durable Objects, backs up to R2 and checks sign-in with your Clerk app.](docs/architecture.svg)

### The learning loop

1. **Capture.** When a session stops or ends, the client hooks redact the transcript into a short digest and upload it. The full transcript stays local.
2. **Detect.** In a GitHub checkout, the client also sends a repo-fact report: hashes, fact keys and outcomes, never command output or paths.
3. **Learn.** The server queues review items from digests and housekeeping rules. The batch leases them at most once a day per profile, judges each one locally with `codex exec`, and sends back lessons, decisions and preference updates.
4. **Guide.** At the next session start, the Worker builds the brief from the repo's profile and `me`. The client injects it into the agent's context.
5. **Measure.** `GET /api/profiles/:p/goal-metrics` reports repeat corrections, guided sessions, guidance followed and cost per session, per repo and week.

### Components

| Part | Where | Role |
|---|---|---|
| Worker | Cloudflare | Serves MCP, the REST API, the dashboard and Settings. Checks Clerk tokens with Clerk's public keys and needs no Clerk secret. |
| Profile store | Durable Object per profile | Memories, revisions, journals, the graph, sessions and repo facts, in SQLite. |
| Account store | Durable Object | Devices, routing rules and the profile list. |
| R2 | Cloudflare | Nightly encrypted exports and the identity ledger. |
| Vectorize and Workers AI | Cloudflare, optional | Semantic recall. Lexical recall works without them. |
| `agent-memory` client | Each machine | Hooks for capture, the brief and the loop guard; local replay; `doctor` and `status`. |
| Daily batch | Each machine | Runs after a session ends or on a schedule. Turns leased review items into lessons, decisions and preferences with your Codex CLI. |

The full design is in [architecture](docs/architecture.md).

## Deploy your own

**You need:**

- Node 24.
- A Cloudflare account, ideally on Workers Paid, with your own domain's zone or the account's workers.dev subdomain.
- A Wrangler login for that account (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN`). Setup never logs in for you.
- A Clerk production instance on your domain, with sign-ups closed, OAuth (CIMD and PKCE) turned on, and the `memory` scope. The [self-host guide](docs/self-host.md#create-the-clerk-application) lists every setting.

**Steps:**

1. Build the self-host package. The command prints the archive path.

	```sh
	npm ci
	npm run pack:self-host -- /absolute/existing/output-directory
	```

2. Unpack it into a new directory outside this repository, and install:

	```sh
	mkdir my-agent-memory
	tar -xzf /path/to/agent-memory-0.0.0.tgz -C my-agent-memory
	cd my-agent-memory/package
	npm ci --include=dev
	```

3. Write `agent-memory.setup.json` with your account id, Worker name, URL, Clerk issuer and publishable key, and routing rules. See [the settings](docs/self-host.md#write-the-settings).
4. Preview the plan, then apply it. Apply asks for your Clerk user id and stores it only as a Worker secret.

	```sh
	npm run setup
	npm run setup -- --apply
	```

5. Deploy, then check the public metadata:

	```sh
	npx wrangler deploy
	curl <your-url>/.well-known/oauth-protected-resource/mcp
	```

Setup creates only what it plans: the Worker config, an R2 bucket and, with semantic search on, a Vectorize index. It refuses to overwrite an existing deployment. Backups stay off until you set a backup key; see [backups and restore](docs/self-host.md#profile-backups-and-restore).

## Connect a client

Replace `https://YOUR-DEPLOYMENT.example/mcp` with your deployment's URL.

For Claude Code, add the server, then run `/mcp` in Claude Code to sign in:

```sh
claude mcp add --transport http memory https://YOUR-DEPLOYMENT.example/mcp
```

For Codex:

```sh
codex mcp add memory --url https://YOUR-DEPLOYMENT.example/mcp
codex mcp login memory
```

For a machine without a browser, see [headless machines](docs/self-host.md#headless-machines). Codex runs the capture hooks only after you trust them once in Codex; `agent-memory doctor` reports `codex_hook_trust` until then.

## Privacy

- Automatic capture uploads only short, redacted digests, never the full transcript. A digest can contain short excerpts. What an agent saves on purpose is stored as written.
- `agent-memory replay --list` and `agent-memory replay --session ID` open a viewer on 127.0.0.1 only, behind a private token, and upload nothing.
- Repo-fact reports carry hashes, fact keys, short detector literals, outcomes and token counts, never command output or paths.
- Fact synthesis (`facts.synthesis`) and the daily batch send redacted digests to the Codex CLI on your own Codex subscription.
- The server never calls GitHub or Jira and holds no credentials for them.

## Learn more

- [Self-host guide](docs/self-host.md): every setup step, setting and option.
- [Architecture](docs/architecture.md): the design and its decisions.
- [Feature manifest](docs/feature-manifest.md): what is built, tested and released.
- Development: run `npm ci`, then `npm run check`.
