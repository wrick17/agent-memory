# Deploy your own Agent Memory

Agent Memory runs on your own Cloudflare account and signs you in through your own Clerk application. Each deployment serves one owner. It is not a shared service.

**Status:** Reviewed self-host source is integrated with the locally adopted corpus source. Combined package, normal-install and configuration verification is pending. Setup tests use an injected Wrangler and Cloudflare API, not a real account. Nobody has run this package end to end on a separate Cloudflare and Clerk account yet, and setup is not proven for everyday use. Setup does not read or check the Clerk settings below. Backups do not exist yet. See [Backups come last](#backups-come-last).

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
| `routing` | Rules that pick a profile for writes from a repo: `host/owner/repo-glob=profile` or `path:/absolute/dir=profile`. Profiles are `work`, `personal`, and `test`. `me` is never a routing target. The Worker copies these rules into your account once, on its first authenticated request. Later changes to `routing` do not reach them, and no page or tool edits them yet. |
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
- The R2 bucket `<worker>-ledger` under the `BACKUPS` binding. Despite the binding name, it is not a backup. It is the permanent ledger of profile generation ids that keeps identities unique.
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

For headless use, create a scoped device token on `<public_url>/settings` after you sign in. Adding a connection alone does not switch ordinary memory callers or install capture.

## Optional parts

- **Embeddings off:** recall stays lexical. You can turn embeddings on later only through a fresh setup run. Setup never edits an existing config, so move the old one aside first.
- **Corpus:** Workers Paid only. The current source exports `CorpusStore`; setup with `"corpus": "on"` binds it as `CORPUS_STORE`, adds migration `v2`, and sets `CORPUS`. This is reviewed source with prior local corpus checks, not combined self-host or live acceptance. Turning it off again is not supported by setup.
- **Capture client:** still under separate verification and excluded from this archive. Setup does not install capture or change client settings. Connect to the MCP explicitly with the commands above.
- **Daily maintenance batch:** the local runner is excluded with capture. This package does not install, activate or downgrade a model runtime.

## Backups come last

Backups, restore, and recovery are built in the final stage of the project, after every other feature. No backup key, nightly export, backup bucket, or restore command exists yet. Setup creates none of them. Until that stage ships, your deployment has no Agent Memory backup or restore.

## Packaging from the source repository

Maintainers create the self-host archive with:

```sh
npm run pack:self-host -- /absolute/existing/output-directory
```

The command stages a new private (0700) directory under the output directory and prints the tarball path. Every packaged file has mode 0644, whatever the maintainer's umask or source file modes. It leaves the staged source for review. It never changes the source README, ordinary client configuration or Wrangler config. Raw `npm pack` in the source repository refuses with this command's instructions.

The archive contains the current Worker `src/`, `local/setup.mjs`, `wrangler.example.jsonc`, this guide at both `README.md` and `docs/self-host.md`, `package.json`, and `npm-shrinkwrap.json`. The guide is self-contained. It does not link to architecture, manifest or verification files omitted from the archive. Capture, migration tools, tests, research, account settings, setup receipts, credentials, and the maintainer's Wrangler config are excluded. The packaged scripts expose only setup. `"private": true` stays set; publication, licensing and a release version require separate review.
