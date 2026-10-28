# Bounded JWKS correction review

What this change does: The correction enables Cloudflare public routing for the Clerk signing-key fetch, adds stage diagnostics, tolerates Cache API read/write failures, and skips individual keys that WebCrypto cannot import. It preserves signature and claim validation.

**Disposition: No material P0/P1/P2 finding in the reviewed correction.** No source rework requested. This is a source-review disposition, not proof that the deployed signing-key 503 is fixed.

## Scope and snapshot

Compared uncommitted changes with base `3e278176ff1278b249a22151f3ca2f3ca90a0848`. Reviewed `src/auth.ts`, unchanged `src/egress.ts`, the routing flag in `wrangler.jsonc`, and relevant `test/mcp-auth.test.ts` changes. Traced the verifier's callers in `src/worker.ts` and the owner authentication fallback in `src/api.ts`. The unrelated CSP correction, closed F1-F5 findings, other modules and deferred phases were excluded.

Read the recursive `~/dotfiles/ai/work/agents.md` instruction chain, repository `AGENTS.md`, feature manifest, implementation section "Live signing-key 503", and verification evidence for both real OAuth logins. Assumed the documented owner-only service load.

SHA-256 of the reviewed files:

| File | SHA-256 |
|---|---|
| `src/auth.ts` | `db4142e62f7b1be593df1d76bb85359079dbadc041be5e49b4d2f59fba877fbd` |
| `src/egress.ts` | `88adfedff409bf0e27b4354ce1efc177ca43b043f674b42552af62e55581b454` |
| `wrangler.jsonc` | `c5f5863007955e5e31b5e327aec0aea799a4509f5885d20fbc72557c810aad0c` |
| `test/mcp-auth.test.ts` | `505de3a7e8f3ee95ac2dda862f48d35eb21e46ba6b506243b865810e79bebd43` |

## Evidence and limits

- **Trust boundary:** `src/auth.ts:37-72` obtains keys from the configured JWKS URL. `src/egress.ts:2-7` still requires the configured HTTPS host and refuses redirects. Fetch/status/parse failures reach the generic 503 at `src/auth.ts:97-100`; unavailable or skipped keys cannot authenticate. Verification and issuer, owner, audience, scope and session-origin checks at lines 102-121 are unchanged.
- **Cache and rotation:** The existing one-hour TTL and unknown-key refresh logic at `src/auth.ts:75-82` are unchanged. Local assertions confirmed that sequential unknown-key requests within the cooldown do not refetch, and a rotated key verifies after 60,001 ms. This is a warm-isolate sequential cooldown, not a global or concurrent cold-start rate limit. The new best-effort handling covers `match` and `put`; the existing awaited `delete` remains fallible. Neither broader guarantee is established by this diff.
- **Diagnostics and privacy:** `src/auth.ts:33-34,48-69,97-100` logs stages, status, a numeric Cloudflare code, public JWKS key IDs and bounded error messages. These calls do not receive the inbound token, claims or authorization header. The non-OK response body is reduced to a numeric code rather than logged. Client responses retain the generic error.
- **Existing tests:** The three new auth cases at `test/mcp-auth.test.ts:88-113` meaningfully cover a synthetic 1042 response and stage log, simultaneous cache read/write rejection with audience refusal, and presence of the routing flag. The config assertion cannot prove Cloudflare routing. The retained cases do not exercise mixed usable/unusable JWKs or timed rotation; the local assertions below exercised those paths without adding files.

Cloudflare documents that `global_fetch_strictly_public` makes global fetch use public routing, including the Cloudflare front door for same-zone requests. It also documents 1042 for certain same-zone Worker fetches without the flag. The selected flag matches that documented behavior. [Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [Workers errors](https://developers.cloudflare.com/workers/observability/errors/#error-pages-generated-by-workers).

**Live evidence qualification:** The recorded OAuth claims and authenticated Worker 503 are observations. The exact 1042 response and same-zone routing cause remain an inference until the runtime control observes them. Successful public JWKS retrieval and crypto outside the Worker do not rule out every Worker-local cache, parsing, import or network failure. The stronger cause wording in the current implementation notes/config comments is not additional runtime evidence. Terra's concurrent deployment validation is outside this review's result.

## Checks performed

Ran only an ephemeral assertion harness through `rtk proxy node --input-type=module`, using Node 24.11.1 WebCrypto. It transpiled the current auth and egress files in memory, generated a synthetic RSA pair, stubbed all fetch/cache operations and advanced `Date.now` without waiting. No network request or credential read occurred.

| Scenario | Result |
|---|---|
| Warm old key; repeated unknown IDs; publish rotated key; advance 60,001 ms; verify rotated key; repeat unknown IDs | Passed. Exactly two upstream stub calls and one cache invalidation. |
| Cache `match` and `put` both reject; first JWK has incompatible `key_ops: ["sign"]`; second JWK is usable | Passed. Usable token verifies, skipped-key token returns 401, and wrong audience returns 401. Logs identify cache read/write and import stages without the synthetic JWT or owner. |

The first harness attempt used an empty RSA modulus as its import-failure fixture. Node accepted that import, so the expected import-log assertion failed. Replacing the fixture with incompatible key operations exercised the intended catch and passed. This was a fixture correction, not a product defect.

The author's 41 checks, type generation and deployment dry run were read as reported evidence and were not rerun. These local assertions are not a workerd or live-network result.

Not checked: live routing, provider calls, deployment, real-token requests, refresh or physical-machine behavior. No source edits, client changes, commits, pushes, deployment or BothQ writes were performed; only this review file was written.
