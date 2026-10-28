# Phase 1 fixes recheck

2026-10-28. Independent Sol review, bounded to F1 to F5 from [the original review](review-sol-phase1-2026-10-28.md). No subagents.

What this change does: Guards every still-pending `me` write inside its transaction, preserves replaced append history, updates embedding cards after relevant appends, counts UTF-8 transaction parameters, and enforces device expiry by time.

**Verdict: F1 to F5 closed. No remaining reproducible P0/P1/P2 defect established in these fixes or their connected paths. These five findings no longer block the reviewed deployment for live gate testing.** This is source-level clearance, not completion of phase 1 or permission to cut over from BothQ.

## Per-finding disposition

### F1 closed: pending binding, guard and committed replay

- `src/mcp.ts:95-140` still checks write scope, binds the request to its payload and original profile, checks profile authorization, and passes the explicit-profile flag, company-free flag, current context and sensitive terms to the profile. An existing account binding no longer bypasses the guard.
- `src/profile/write.ts:404-431` checks for the profile's committed request result inside `transactionSync`. A matching result replays; a mismatched payload fails. Without a stored result, `me` requires an explicit profile and passes `meGuard` before `nextSeq` or any mutation. The result and mutation commit in the same transaction. Neither overlapping calls nor a crash after account binding creates an unguarded mutation path.
- Connected evidence: `src/domain/guard.ts:17-44`, `src/routing.ts:36-57`, `src/account/store.ts:139-159`, and the sole `runWrite` caller at `src/profile/store.ts:44-53`. A refused newly bound request releases its account binding. A pre-existing pending binding remains bound to its payload, as already documented; it still cannot authorize an unsafe write.
- Original isolated tests `F1` and `F1b` passed in this recheck. The existing committed-`me` replay test at `test/isolation-recall.test.ts:74-81` and original-profile replay test at `test/g3-contracts.test.ts:100-115` also passed. The pending-binding regression is at `test/isolation-recall.test.ts:60-71`. Committed replay survives changed guard terms and routing rules without repeating a mutation.

### F2 closed: retained history, current content, search and row bounds

- `src/profile/write.ts:143-150` deletes the old body, whose content remains in its revision snapshot. It retains append rows with `live = 0`, stamps them with the replacement transaction's sequence, and counts all live entry rows through `Tx.touch` before their bulk update. That count includes chunks, not merely logical entries. `Tx.check` at lines 39-46 refuses an overflow inside the same transaction.
- Current-content reads at `src/profile/write.ts:166-170` filter `live = 1`. The FTS and trigram removal triggers at `src/profile/schema.ts:77-79` remove newly non-live entries from both indexes. History at `src/profile/read.ts:55-77` intentionally reads entries regardless of `live`, preserving their original revision, delta, separator, request ID and actor.
- Original isolated `F2` passed. The focused existing history test at `test/write-details.test.ts:27-50` passed: revisions 1 to 7 retain earlier append deltas through replacement and another append; current content contains only the replacement and new append; recall no longer returns the old entry. The row-bound check is source evidence, not a newly run boundary test. Replacement beyond the bounded number of live chunks still refuses atomically, as the implementation report documents.

### F3 closed: current-content prefix and embedding due state

- `src/profile/write.ts:153-164` assembles at most the first 1,200 characters from body then live entries, including the stored separators. Its ordering and live filter match current content. It stops consuming rows once it has that prefix. `cardText` at lines 117-120 applies the same content slice used by create and update at lines 263 and 323-337.
- Append at `src/profile/write.ts:384-397` recomputes the card after inserting entries only while the previous content is shorter than the prefix. It reports embedding due only if the card hash changed. Appends after the prefix retain the card hash. `src/profile/store.ts:47-48` arms the alarm for a changed card; `src/profile/schema.ts:52` identifies due cards by hash mismatch.
- The alarm uses that same live prefix at `src/profile/index.ts:25-29` and records `embed_hash` only while the originally selected card hash still matches at lines 37-40. Retained F2 history therefore does not enter a new card.
- Original isolated `F3` passed. The focused existing regression at `test/isolation-recall.test.ts:108-127` passed: the first substantive append becomes pending, embedding then supplies a vector hit for the new text, and an append past 1,200 characters preserves the embedded card. This is local functional proof with fake embeddings and vectors, not a production query-cost or latency measurement.

### F4 closed: UTF-8 byte count and transaction rollback

- `src/profile/write.ts:32-46` counts string parameters with `Buffer.byteLength(p, "utf8")`, rather than JavaScript string length, and throws `size_budget` past 1,000,000 bytes. This is the application's SQL-parameter byte budget; it is not a measurement of SQLite pages or FTS storage overhead.
- The counter runs within the encompassing `transactionSync` at `src/profile/write.ts:404-431`. Overflow can occur after statements execute, but the thrown failure rolls back nodes, text/index changes, edges, revisions, activity, stored request result and profile sequence together. `src/profile/store.ts:50-52` converts the failure only after it leaves the transaction. `src/mcp.ts:134-136` releases a newly created account binding after refusal.
- Original isolated `F4` passed for 90 records with 4,000 CJK characters each. The harness also queries revisions for the refused request, but its assertion checks the refusal code. The focused existing regression at `test/write-details.test.ts:64-73` passed: the replacement is absent, a prior target stays active at revision 1, and a smaller corrected operation reuses the released request ID successfully. Full rollback follows from the common synchronous transaction; the test samples its visible effects rather than asserting every table separately.

### F5 closed: offset expiry and unreadable dates

- The owner API still forwards expiry to the shared device creation path at `src/api.ts:68-75`. `src/account/store.ts:200-207` validates a supplied date and stores its UTC ISO representation.
- Authentication at `src/account/store.ts:122-136` checks the stored secret and revocation first, then parses any non-null expiry and rejects `NaN` or an expiry at or before `Date.now()`. This also handles an existing non-normalized offset timestamp. An unreadable stored expiry cannot become an unlimited token. Successful caller construction remains after all these checks.
- Original isolated `F5` passed. The focused existing regression at `test/mcp-auth.test.ts:130-143` passed for an expired `+14:00` date, an unexpired offset date, and refusal after corrupting the stored expiry to `not a date`.

## Commands and results

The original isolated harness was run **once**, unmodified, from `/private/tmp/am-phase1-review-gb0ebmnc`:

```sh
rtk proxy node /Users/pratyush.poddar/Projects/personal/memory/node_modules/vitest/vitest.mjs run --config /private/tmp/am-phase1-review-gb0ebmnc/vitest.config.ts
```

Result: exit 0, **1 file, 7 tests passed**, 3.69 s. That includes F1, F1b, F2, F3, F4, F5 and the original query-embedding timeout check. The timeout check is retained evidence from the required harness, not a broader recall audit.

One focused existing-test command filled concrete gaps in that harness: committed replay, replay after routing changes, current content/search after replacement, actual local embedding execution, rollback/reusable request ID, and invalid-date refusal. It ran from the repository root:

```sh
rtk proxy node node_modules/vitest/vitest.mjs run test/isolation-recall.test.ts test/g3-contracts.test.ts test/write-details.test.ts test/mcp-auth.test.ts -t 'still replays a committed me write|replays a retry in the original profile|returns a BothQ history window|re-embeds a journal|counts UTF-8 bytes|refuses an expired device token'
```

Result: exit 0, **4 files, 6 passed, 29 skipped**, 3.23 s. No full-suite, types, lint or bundle rerun was done by this reviewer. The author reports regression-first red/green results; this review independently reran only the fixed source. Terra's updated [verification report](phase-1-verification.md#combined-check-after-f1-to-f5) separately records 35 passing tests, typecheck/lint, current generated types and passing dry-run bundles.

Both review runs used local workerd, real SQLite Durable Objects and local R2, with `remoteBindings: false` and the existing AI/Vectorize fakes. Wrangler warned that `env.test` inherits the concurrently added custom-domain route and omits AI/Vectorize. Neither command deploys. This source review does not clear deployment of `env.test`; Terra's intended deployment is the top-level environment.

## Source snapshot and scope

- Baseline HEAD: `1770186a182d80296053742428b96eea4523be67`. The implementation and tests were untracked, so this review identifies working-file bytes rather than treating HEAD as the implementation snapshot. Existing dirty files were preserved.
- Before/after SHA-256 checks found no changes to any of the 30 application, test or tooling files: all `src/**/*.ts`, immediate files under `test/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts` and `worker-configuration.d.ts`.
- Their aggregate SHA-256 is `62544ecb9ca75f0b6805f1084fd6825b80005859f39007f89b3e254606566335`. It is computed over UTF-8 JSON mapping sorted relative paths to their individual SHA-256 values, using compact JSON separators and sorted keys. This defines the reviewed source snapshot; it is not a deployed version.
- The feature manifest, implementation report and original review also remained byte-identical during the before/after check. Terra concurrently updated deployment configuration and its verification report. `wrangler.jsonc` changed from `655b6a1d5b36bd6ff7e5fddecdb150976f71c8e87de37d1a9a64c5c391cf9b49` to `5836ce9818dcf7e575c6516aaea726ddf97f5920e0ed5379addd5bf3643be318`. The test runs observed the new route. This is separate from the frozen source and tests.

Key reviewed file hashes:

| File | SHA-256 |
|---|---|
| `src/mcp.ts` | `5ed5af75e905ea16524cfb350edf2ec8f463b4320b6ba8a7e132b2e5d59640c1` |
| `src/profile/write.ts` | `a84c80b282f16ba48d044f0c437636fab19441fc82bd1e8f558e7089ce6474c8` |
| `src/profile/read.ts` | `2e58fac2bc1d146136845e34e600890a7be188cfa2113757117d5d6a7f74e7ba` |
| `src/profile/schema.ts` | `f426e98248e5cf1708c643da6e88f7be5c6b40f757a278e999950f8ce917a9ef` |
| `src/profile/index.ts` | `c74629df46d8f965166094d0151cb12c6c9058e37c30b57a8e8d631844f53abc` |
| `src/account/store.ts` | `87d5d67877e8781d8338a5bc8b20ea9c71b5a77d2811fd1e1ed490c18cbdf63a` |
| `src/auth.ts` | `174b6147458e00242f73ae3e4971974ff648a7745522148c5aeb412c0a486b2d` |

Original harness SHA-256 values under `/private/tmp/am-phase1-review-gb0ebmnc`:

| File | SHA-256 |
|---|---|
| `review.test.ts` | `89b61c8fbaf891ca574aa3062640e8ae07d400906c9d2a79bf0c7da9685a8392` |
| `vitest.config.ts` | `bcd188592692e7477c4f357ae37bbd35e76ffad92664bed99e641d10e4250f43` |
| `fakes.js` | `fb30c88cf0a6bd7c37d598d16fee386ee634c4cd733e964777eeca5d6a19de92` |

## Deployment disposition and live limits

Proceeding to the reviewed deployment and same-Mac live checks has no remaining blocker from F1 to F5. Preserve resource audience **and** the `memory` scope. Source inspection at `src/auth.ts:80-87` confirms both checks and refusal when `REQUIRED_SCOPE` is unset; the current deployment configuration sets it to `memory`. No auth weakening is recommended or needed for this clearance.

G1 T1 to T6 remain live gates, including actual Claude Code and Codex authentication, real token audience and scope, negative token cases, refresh and headless access. Same-Mac live G5 still needs Worker-mediated vectors, filtered retrieval and fallback evidence. Browser Settings sign-in remains unverified here. Run the owner's requested Claude/Codex/headless checks on this Mac first. A second physical machine remains explicitly deferred; local callers and local workerd do not prove cross-machine behavior. BothQ remains the live system pending the later cutover gates.

Only this report was intentionally written in the workspace. No source or harness edit, added app test, commit, push, deploy, provider call, resource change, client/hook change, deletion or BothQ write was made by this reviewer. The parent remains the sole journal writer.

Not checked: later-phase features, full-suite re-verification, live providers/clients or physical cross-machine behavior. The remaining risk is unproven live integration, not an open F1 to F5 source finding.
