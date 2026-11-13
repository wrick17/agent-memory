# Deploy your own Agent Memory

Agent Memory runs on your own Cloudflare account and signs you in through your own Clerk application. Each deployment serves one owner. It is not a shared service.

**Status:** Reviewed self-host source is integrated with the locally adopted corpus source. Local package, normal-install and configuration checks have passed on retained source snapshots. Setup tests use an injected Wrangler and Cloudflare API, not a real account. Nobody has run this package end to end on a separate Cloudflare and Clerk account yet, and setup is not proven for everyday use. Setup does not read or check the Clerk settings below. Backup exports and profile/account restore are implemented in source, but require the manual configuration in [Profile backups and restore](#profile-backups-and-restore).

## Unpack and install

Extract the supplied `agent-memory-0.0.0.tgz` into a new directory outside any existing Wrangler project, then enter its `package` directory:

```sh
mkdir my-agent-memory
tar -xzf /path/to/agent-memory-0.0.0.tgz -C my-agent-memory
cd my-agent-memory/package
npm ci --include=dev
npm run setup -- --help
```

The archive contains `npm-shrinkwrap.json`, which pins the same dependency graph as the source lockfile. Include development dependencies because they contain the pinned Wrangler CLI. Nothing installs globally. The version `0.0.0` is an unreleased private artifact, not a published npm package.

## Before you start

You need:

- Node 24 and the unpacked archive, with dependencies installed as above.
- A Cloudflare account. For your own hostname, such as `memory.<your domain>`, the account needs that domain's zone. Without a zone, use the Worker's own workers.dev URL. The account must already have a workers.dev subdomain, which you register in the Cloudflare dashboard. The design targets Workers Paid. Free-plan capacity and runtime limits have not been verified by this package. Corpus remains optional and Paid-only.
- A Wrangler login for that account. Run `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` to a token for that account. Setup never logs in for you.
- A Clerk account.

## Create the Clerk application

Use a production instance on your own domain. Its Frontend API, such as `clerk.<your domain>`, must be a different host from the Worker.

1. Create the application and its production instance. Add the DNS records Clerk lists for your domain, and wait until Clerk verifies them.
2. Close sign-ups. Make access invite-only or restricted, then create your own user.
3. Copy your user id (`user_…`). Setup asks for it once and stores it only as the Worker secret `OWNER_USER_ID`. The Worker accepts tokens for this user only.
4. Under OAuth applications, turn on the following:
	- Client ID Metadata Documents (CIMD): publish, and admit compatible clients. Claude Code and Codex both use CIMD.
	- PKCE (S256) required. Leave dynamic client registration off.
	- JWT access tokens with **Include audience**. The Worker requires the audience `https://<your host>/mcp`.
	- The custom scope `memory`, allowed for dynamic clients, and `offline_access` for refresh.
5. Copy the publishable key (`pk_live_…`). Open `https://<Frontend API>/.well-known/openid-configuration` and copy its `issuer`. It must equal the Frontend API URL. Setup refuses settings where the two differ.

The Worker verifies tokens against Clerk's public signing keys at `<Frontend API>/.well-known/jwks.json`. It needs no Clerk secret key, and no GitHub or Jira credentials.

## Write the settings

Create `agent-memory.setup.json` in the source directory. All values are public. Setup refuses unknown keys, so a typo never becomes a silent default.

```json
{
	"account_id": "<32-character Cloudflare account id>",
	"worker": "agent-memory",
	"public_url": "https://memory.<your domain>",
	"clerk_issuer": "https://clerk.<your domain>",
	"clerk_publishable_key": "pk_live_…",
	"routing": ["github.com/<your-org>/*=work", "path:/Users/<you>/work=work", "github.com/<your-user>/*=personal"],
	"embeddings": "on",
	"corpus": "off"
}
```

| Setting | Meaning |
|---|---|
| `account_id` | The Cloudflare account to use. Setup checks that your Wrangler login can use it before anything else. |
| `worker` | The Worker name, 2 to 26 lowercase letters, digits, or dashes. It also names the R2 bucket `<worker>-ledger` and the Vectorize index `<worker>-cards`. |
| `public_url` | The https origin of the Worker, with no path. The MCP URL is `<public_url>/mcp`, and the dashboard is at `<public_url>/app`. Use either your own hostname, which deploy attaches as a Workers custom domain, or the Worker's own workers.dev URL, `https://<worker>.<your account's workers.dev subdomain>.workers.dev`. For workers.dev, setup reads the account's subdomain with your Wrangler login's token (`wrangler auth token --json`, one read-only Cloudflare API request) and refuses any other subdomain. It never prints or saves the token. |
| `clerk_issuer` | The issuer from Clerk's discovery document. |
| `clerk_publishable_key` | The publishable key. Setup reads the Frontend API host from it. |
| `routing` | Rules that pick a profile for writes from a repo: `host/owner/repo-glob=profile` or `path:/absolute/dir=profile`. Profiles are `work`, `personal`, and `test`. `me` is never a routing target. The Worker copies these rules into your account once, on its first authenticated request. Later changes to the setup setting do not reach the stored rules. Use the dashboard Routing page to edit the saved rules and test a repository route. |
| `embeddings` | `on` adds Workers AI and a Vectorize index for semantic recall. `off` keeps recall lexical (SQLite FTS5) and creates neither. |
| `corpus` | Start with `off`. The current source exports `CorpusStore`, so setup can render `on` with its binding and migration. Corpus is optional and Workers Paid only. Combined self-host and live corpus acceptance remain pending. |

## Run setup

1. Plan without changing anything:

	```sh
	npm run setup
	```

	Setup checks the settings and your login, reads the account, and prints one line for each item: `create`, `keep`, or `refuse`.
2. If the plan is right, apply it:

	```sh
	npm run setup -- --apply
	```

	When it asks in an interactive terminal, enter your Clerk user id. Input is hidden; Ctrl-C or Ctrl-D at the empty prompt cancels before any write and restores terminal input. Setup sends it to `wrangler secret put` on stdin, never on a command line, and never prints or saves it.

Apply first acquires `agent-memory.setup.lock` in this source directory, before reading settings, receipts or account/resource state. It holds the lock through the hidden owner prompt, resource writes and successful creation receipts. A competing apply refuses before inspection; after the first finishes, a new retry inspects current state and keeps an existing owner secret. Plan-only runs do not acquire a lock.

The lock contains only a process id and timestamp. Setup releases its own lock on normal completion, refusal or prompt cancellation; it never reclaims an existing lock by PID or age. A killed process can leave its lock behind. Verify independently that no setup apply is running before removing a leftover yourself. Removing a live process's lock breaks the exclusion.

Setup writes and creates only what the plan says:

- `wrangler.jsonc`, the Worker config. It holds no secrets.
- `agent-memory.setup-receipts.json`, local creation receipts keyed by account, resource kind and name. Keep it with this source directory; it holds no owner id or secret and is excluded from the package.
- The R2 bucket `<worker>-ledger` under the `BACKUPS` binding. Initially it holds the permanent ledger of profile generation ids. After backup configuration, it also holds encrypted exports. Never delete or recreate it as a setup retry.
- With embeddings on, the Vectorize index `<worker>-cards` (1,024 dimensions, cosine) and its string metadata index on `kind`.
- The Worker secret `OWNER_USER_ID`. If the Worker does not exist yet, Wrangler creates it as an empty draft with the secret. Deploy uploads the code.

The Durable Object classes `AccountStore` and `ProfileStore` are SQLite classes in migration `v1`. With corpus on, setup also adds `CorpusStore` in migration `v2`. Deploy creates them.

Setup refuses, and changes nothing, when:

- the settings are invalid or unsafe, such as a non-https or reserved hostname, a path or port in a URL, an issuer that does not match the key, or a routing rule to an unknown profile;
- Wrangler would use any other config, such as an existing `wrangler.jsonc` from another deployment, a `wrangler.toml`, or a config in a parent directory;
- Wrangler has no login, or the login cannot use `account_id`;
- a workers.dev `public_url` is not `https://<worker>.<subdomain>.workers.dev` for this `worker` and this account's own subdomain, or the account has no workers.dev subdomain;
- a bucket, index, or Worker with a planned name already exists without a successful creation receipt for this account;
- an existing index or metadata index has a different shape from the one this source needs.

To resume after a failure, fix the cause and run `npm run setup -- --apply` again. Setup keeps resources with a successful creation receipt and creates only the missing ones. A matching `wrangler.jsonc` proves no ownership. Receipts are atomically written and flushed before creation as pending intent, then after Wrangler reports success as completed creation. A crash, timeout or failed receipt write can leave a resource present with only pending intent. Setup refuses to reuse it or set a secret on an unproven Worker. Inspect the account yourself and choose fresh names, or remove only a leftover you independently verified is yours before retrying. Setup never deletes or adopts it for you. Losing the receipts also makes existing resources unproven; do not fabricate receipts to bypass that refusal.

Metadata belongs to a proven index; a missing owner secret can be set only on a proven Worker or a newly created draft. An existing `OWNER_USER_ID` is never changed. To change that secret, run `npx wrangler secret put OWNER_USER_ID` yourself.

## Deploy

Run the deploy in an interactive terminal:

```sh
npx wrangler deploy
```

With your own hostname, deploy attaches it as a custom domain. If a DNS record or another Worker's custom domain already uses that hostname, Wrangler asks before it replaces it. Answer no unless you mean to move that hostname. Without a terminal, for example in CI, Wrangler 4.154 replaces both without asking.

With a workers.dev URL, the config sets `workers_dev: true` and `preview_urls: false` and has no route. Deploy serves the Worker at its own workers.dev URL only, and changes no DNS record, route or custom domain.

Then check the public metadata:

```sh
curl <public_url>/.well-known/oauth-protected-resource/mcp
```

It returns your MCP URL as `resource` and your Clerk issuer in `authorization_servers`.

## Connect your agents

Replace the example below with the `public_url` from your settings plus `/mcp`. These commands add a connection to your existing client configuration. Run them only after you have deployed and checked your own server.

For Claude Code:

```sh
claude mcp add --transport http memory https://YOUR-DEPLOYMENT.example/mcp
```

Then use `/mcp` in Claude Code to sign in. For Codex:

```sh
codex mcp add memory --url https://YOUR-DEPLOYMENT.example/mcp
codex mcp login memory
```

Adding a connection alone does not switch ordinary memory callers or install capture.

### Headless machines

A machine without a browser uses a device token instead of OAuth sign-in. Use these steps on that machine in place of the commands above.

1. In any browser, sign in to the dashboard at `<public_url>`, open Settings (⚙) › Devices and tokens (`<public_url>/#/devices`; the old `/settings` address redirects there), and create a device with only the permissions and profiles that machine needs. The page shows the token once.
2. On the headless machine, store the token in a private file. Paste it at the hidden prompt and press Enter:

	```sh
	mkdir -p -m 700 ~/.config/agent-memory
	(umask 077; IFS= read -rs t && printf '%s' "$t" > ~/.config/agent-memory/device-token)
	```

	The file has mode 0600. Keep the token out of client configuration, command lines, logs and Git.
3. For Claude Code, add a helper that prints the request header. Claude Code runs it on each connection and reads a JSON object of headers from its output. Add the server at user scope, with the helper's absolute path:

	```sh
	cat > ~/.config/agent-memory/headers.sh <<'EOF'
	#!/bin/sh
	printf '{"Authorization":"Bearer %s"}' "$(cat "$HOME/.config/agent-memory/device-token")"
	EOF
	chmod 700 ~/.config/agent-memory/headers.sh
	claude mcp add-json memory '{"type":"http","url":"https://YOUR-DEPLOYMENT.example/mcp","headersHelper":"'"$HOME"'/.config/agent-memory/headers.sh"}' --scope user
	```

4. For Codex, add the server to `~/.codex/config.toml` with the name of an environment variable, not the token:

	```toml
	[mcp_servers.memory]
	url = "https://YOUR-DEPLOYMENT.example/mcp"
	bearer_token_env_var = "AGENT_MEMORY_TOKEN"
	```

	Start Codex with that variable read from the file:

	```sh
	AGENT_MEMORY_TOKEN="$(cat ~/.config/agent-memory/device-token)" codex
	```

To retire the machine, revoke its device in Settings. The server refuses the token on its next request.

## Optional parts

- **Embeddings off:** recall stays lexical. You can turn embeddings on later only through a fresh setup run. Setup never edits an existing config, so move the old one aside first.
- **Corpus:** Workers Paid only. The current source exports `CorpusStore`; setup with `"corpus": "on"` binds it as `CORPUS_STORE`, adds migration `v2`, and sets `CORPUS`. This is reviewed source with prior local corpus checks, not combined self-host or live acceptance. Turning it off again is not supported by setup.
- **Capture client:** still under separate verification and excluded from this archive. Setup does not install capture or change client settings. Connect to the MCP explicitly with the commands above.
- **Maintenance batch:** the runner is excluded with capture from this archive. A separately installed client keeps `batch_profiles` empty by default. The Claude batch path is opt-in: set `batch_runner` to `claude`, give both `batch_luna_model` and `batch_terra_model` explicit full Claude model IDs, and set `claude_bin` to a pinned Claude Code CLI executable. Its initial no-query gate requires no tools or MCP servers before untrusted text is sent; this is a runtime gate, not OS confinement. Current live Claude authentication and P1 acceptance remain open. This package does not install, activate or downgrade a model runtime.
- **Repo facts and the loop guard:** client settings in `~/.agent-memory/config.json`. Injection, synthesis and the loop guard are off by default; deterministic fact reports follow capture. They are source only and not verified on a live client. Before you turn one on, read [what each setting sends](#repo-facts-and-loop-guard-settings) and decide whether that fits your privacy needs.

### Repo facts and loop guard settings

A separately installed capture client reads these keys. A config without them keeps today's behaviour.

```json
{
	"facts": { "inject": false, "profile": null, "timeout_ms": 1500, "synthesis": false, "synthesis_rates": null },
	"loop_guard": { "enabled": false, "shadow": false }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `facts.inject` | `false` | At session start, add the checkout's brief: up to 4 injectable repo facts, a pointer to the open journal, the project's rules and preferences, your `me` preferences and rules, and recent decisions, in at most 400 tokens. Needs a read-scoped token in `read_token_file`; `agent-memory doctor` checks it. |
| `facts.profile` | `null` | No longer read since the v2 client (PR #132): the server routes by the remote and checkout path with your routing rules, and `agent-memory doctor` warns while it is set. |
| `facts.timeout_ms` | `1500` | How long session start waits for the brief, at most 10,000 ms. On a timeout it adds nothing. |
| `facts.synthesis` | `false` | Send redacted command digests to the Codex CLI on your Codex subscription to propose facts: at most 3 calls per UTC day on each machine, retries included. Keep it off until you have reviewed what it sends and accept that your Codex provider receives those digests. |
| `facts.synthesis_rates` | `null` | USD per million `input`, `cached_input` and `output` tokens. Used only to fill `cost_usd` in `~/.agent-memory/facts/synth/cost.jsonl`; without it, `cost_usd` is null. |
| `loop_guard.enabled` | `false` | Register the tool-result hooks and add one fixed note to a turn that keeps failing. No network or model call. |
| `loop_guard.shadow` | `false` | With `loop_guard.enabled`, run the rules and log each would-fire to `~/.agent-memory/loop-guard/fires.jsonl`, but print no note. The log holds hashes, rule names and counts only. |

### Capture project tagging

Each captured session is tagged with the GitHub project of the folder it ran in. The client reads the checkout's root and `origin` remote with read-only git and sends the key `github:<owner>/<repo>`, in lowercase, with SSH aliases folded to github.com through `ssh -G`. The server links the session to that project node in the routed profile, and creates the node if no node has that key. Lessons and decisions that the daily batch learns from the session take the repo name as their scope and link to the project. Keys of acceptance fixtures (`am-accept*`, `fixture*`, `dashboard-smoke`) and the `bot_hq`, `bothq` and `codex` labels are skipped. A checkout under a `fixtures` folder is skipped too.

Workspaces are optional folders that group repos:

```json
{ "capture": { "workspaces": { "work": "~/Projects/work", "oss": "~/Projects/oss" } } }
```

A session in a configured workspace also sends the workspace name. If the session has no project, for example one started at the workspace root, its lessons and decisions take the workspace name as their scope. A checkout that sits above the workspace root, such as a home-directory repo, is not treated as a project of that workspace. Names are lowercase letters, digits, `.`, `_` and `-`; roots start with `/` or `~/`.

The dashboard's Projects page and Map group records by project and workspace. You can name your projects in a project registry: in each profile, save a memory named `dashboard-project-registry` (type `reference`) whose text is JSON, and edit that memory to change it. The dashboard reads it when it loads, merges the registries of all profiles, skips any entry it cannot read, and never shows the text itself. Without a registry, the tags above and GitHub keys still place records. The shape:

```json
{ "workspaces": [{ "id": "labs", "name": "Labs", "order": 1 }],
  "owners": ["acme-corp"],
  "default_workspace": "labs",
  "repos": [{ "key": "acme-corp/widget", "name": "widget", "workspaces": ["labs"] }],
  "aliases": { "widget-app": "acme-corp/widget", "lab": "ws:labs", "old-name": "acme-corp/widget?" },
  "drop": ["tool-label"],
  "not_projects": ["acme-corp/notes"] }
```

Workspaces and owners belong to the profile that holds the record: a repo whose GitHub owner is listed there shows that profile's tag. With a registry, only its `repos` are projects; a key it does not list shows only its workspace. `aliases` map a record's scope to a repo or, with `ws:`, to a workspace; a trailing `?` marks the mapping as likely rather than certain. A `ws:` alias also applies to a session's workspace tag, so after you merge two workspaces, an alias from the old folder name to the merged workspace places records already tagged with the old name. `drop` lists scopes that never name a project.

Deploy the Worker before the client: an older Worker refuses a batch with these fields, and the client keeps such batches spooled or pending and sends them again after the Worker is upgraded. Nothing is lost, but capture stalls until then.

Deterministic fact detection follows capture and has no switch of its own: with capture installed, the client reports detector results for each completed session in a GitHub repository, whatever these settings say. Those reports hold hashes, fact keys, detector literals, injected-item outcomes, token counts and command counts, never command output or paths. The v2 server writes every statement itself. Turning `facts.synthesis` off stops only synthesis. After you change `facts.inject` or `loop_guard.enabled`, run `agent-memory install` again so the client registers the hooks.

## Profile backups and restore

Encrypted exports of profiles and account state keep up to two complete exports per store. Restore into a fresh profile generation is implemented through the owner-only backup and recovery HTTP API. Account-state restore is also implemented in source. List account exports with owner-authenticated `GET /api/account/exports`, then begin with `POST /api/account/restore` and `{"export":"<export id>"}` or `{"export":"latest"}`. Use `GET /api/recovery` for status and `POST /api/recovery/step`, `/api/recovery/open` or `/api/recovery/abort` to advance, reopen or roll back. The permanent R2 generation ledger and wipe refusals remain authoritative; unresolved recovery stays closed until abort reapplies the pre-restore checkpoint. A successful account restore disables every device token, so the owner must reissue needed tokens. Full current combined and actual-dataset account restore checks remain pending. Point-in-time profile restore and corpus recovery are implemented in source. Actual point-in-time restore and corpus recovery acceptance remain open. The recovery dashboard and scratch restore drill are implemented in source; actual point-in-time, drill and browser acceptance remain open.

Setup does not generate a backup key or enable a schedule. Before using backups, generate a unique random key of at least 32 characters and retain an offline copy in your password manager. After deploying your Worker, set it through Wrangler's interactive secret prompt:

```sh
npx wrangler secret put BACKUP_KEY
```

Keep the key out of settings, Wrangler variables, command-line arguments and Git. Losing it makes encrypted exports unreadable.

After the secret is configured, enable nightly exports by adding `"triggers": { "crons": ["17 3 * * *"] }` to your generated `wrangler.jsonc`, keeping its other fields, and deploy again. This runs at 03:17 UTC. The shipped example and setup-generated configuration leave the schedule off until you configure the key.

Without a key, exports fail closed. Restores require the same schema version and keep the account closed until reconciliation succeeds; unresolved transfers require owner intervention. Profile and Account exports pause writes during export. Corpus export uses resumable keyset pages and a change journal while writes continue, with a fallback write fence that expires within 30 seconds if catch-up falls behind. These local checks do not establish complete disaster-recovery readiness.

## Packaging from the source repository

Maintainers create the self-host archive with:

```sh
npm run pack:self-host -- /absolute/existing/output-directory
```

The command stages a new private (0700) directory under the output directory and prints the tarball path. Every packaged file has mode 0644, whatever the maintainer's umask or source file modes. It leaves the staged source for review. It never changes the source README, ordinary client configuration or Wrangler config. Raw `npm pack` in the source repository refuses with this command's instructions.

The archive contains the current Worker `src/`, the replay player `local/replay-player.js` that the dashboard embeds, `local/setup.mjs`, the corpus uploader `local/corpus-cli.mjs` with its helper modules `local/corpus-git.mjs`, `local/corpus-judgment.mjs`, `local/corpus-refresh.mjs`, `local/corpus-scan.mjs` and `local/corpus-upload.mjs`, `wrangler.example.jsonc`, this guide at both `README.md` and `docs/self-host.md`, `package.json`, and `npm-shrinkwrap.json`. The guide is self-contained. It does not link to architecture, manifest or verification files omitted from the archive. Capture, migration tools, tests, research, account settings, setup receipts, credentials, and the maintainer's Wrangler config are excluded. The packaged scripts expose only setup. `"private": true` stays set; publication, licensing and a release version require separate review.
