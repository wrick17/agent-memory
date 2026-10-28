# Hosted fixes closure review, 2026-10-29

What this change does: Closes the nine prior hosted findings against the frozen, uncommitted fixes on `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9`. This is an independent closure review, with only regressions directly connected to those fixes in scope.

**Verdict: Fix F4 and the remaining F3 hash ordering before shipping this boundary. Seven findings are closed; two remain.**

## Evidence

Read the original hosted review and the phase-2 implementation's Review fixes section. Adapted the original ten probes to assert corrected behavior, adding decision evidence so F5 reaches actual history, search and embedding outcomes. Added checks for F3 request hashing, concurrent F4 contexts, full-limit F8 and F9 evidence.

The [13 scoped probes](/tmp/sol-hosted-closure-al41leqe/test/hosted-review.test.ts) ran against copied source in real workerd/SQLite Durable Objects and local R2, with AI/Vectorize fakes. Command from that directory: `./node_modules/.bin/vitest run --config vitest.config.ts`. [Final output](/tmp/sol-hosted-closure-al41leqe/run-final.log): **11 passed, two failed**, precisely the remaining F3/F4 expectations below. Both original access/rollback controls passed. These are focused closure checks, not Terra's combined verification.

All 26 pinned source/test/config files have identical [before](/tmp/sol-hosted-closure-al41leqe/hashes-before.json) and [after](/tmp/sol-hosted-closure-al41leqe/hashes-after.json) SHA-256s. SHA-256 over their sorted-key JSON mapping is `9e5ab365329094f1c522bf4c893d9156ac297f4f63102e5f7111f90e4c061a05`. Every copied source file matches the checkout. No app, test or config file was edited in the checkout.

## F1-F9 disposition

| Finding | Result and observed evidence |
|---|---|
| F1 | Closed. Both original raw-message fields are refused without stored rows. Unknown excerpt/dropped keys, 281-character outcomes/entities and 161-character asks are refused; a 280-character outcome stores. Strict schemas cover every nested object in `src/profile/capture.ts:31-55`. |
| F2 | Closed. The original `Use token=[REDACTED]` correction, including formatted JSON and trailing whitespace, stores byte-for-byte with its accepted hash and valid JSON. Redaction is idempotent. Unredacted input returns `needs_redaction`; accepted part and manifest retries replay. |
| F3 | **P2 remains.** Contacts no longer persist, and changing discarded contacts leaves the node's attributes, content hash and revision unchanged. Request hashing still happens before contact stripping. Repro and fix below. |
| F4 | **P1 remains.** Fresh contexts correctly reject names, prefixed keys and both GitHub/Jira handles. A concurrent context still persists a newly registered work handle into `me`. Repro and fix below. |
| F5 | Closed. With valid evidence, the keyed decision update produces revision snapshots `[1, orchidbefore]` and `[2, zeppelinafter]`. The current head and lexical recall contain the new description; old lexical recall has no hit. Running the embedding alarm changes the card hash and brings `embed_hash` to the new hash. Actual values appear in the final log. |
| F6 | Closed. Component-to-bug `reviewed` with valid URL evidence returns `invalid_endpoints`, naming person-to-PR, and rolls back its nodes. Valid person-to-PR `reviewed` and explicit `other` edges persist. |
| F7 | Closed. Cross-kind key reuse returns `key_kind_conflict`. The original person and revisions remain byte-equivalent; a preceding node and the failed request result roll back. A corrected retry can reuse that request ID. |
| F8 | Closed. All 512 parts, each with a maximum-length 64-character part ID, store. Their 79,422-byte manifest persists in five rows, each within 16,000 characters. Ordered reconstruction matches canonical bytes/hash; replay adds no maintenance items; recovery returns all 512 parts and consolidated state; the heuristic leaves the live index. An instrumented second manifest transaction reports 29 SQLite row writes and 80,573 UTF-8 parameter bytes, within 1,000 rows/1 MB. |
| F9 | Closed. Missing, empty and malformed decision evidence is refused. Nonexistent and foreign-profile node evidence returns `bad_evidence` and rolls back all nodes. Existing same-profile node evidence persists atomically on the decision. |

## Remaining must-fix findings

1. **F4, P1: Concurrent contexts retain stale guard terms.** `src/mcp.ts:171-184` registers work terms before dispatch but forwards `c.account.sensitiveTerms` from the earlier request context. The probe pauses an in-flight `me` call before account request binding, commits a work person with GitHub handle `racingcolleague42`, then resumes. The call returns `created`; SQL contains `Ask racingcolleague42 for reviews` in `me`. A fresh-context control returns `me_sensitive_term`. Only scheduling is intercepted; registration, binding and both profile writes use real RPC/SQLite. Fix by registering terms into the guard state used atomically by the `me` write transaction before dispatching the work write. Refreshing a request snapshot alone leaves a check/commit race. Skipping this permits work identifiers in globally recalled personal memory.

2. **F3, P2: Discarded contacts affect idempotency.** `src/mcp.ts:136-137` hashes before `src/profile/write.ts:486` strips attributes. Create a work person with request ID `contact-hash` and email `first@example.invalid`; retry the same accepted data with email `second@example.invalid`. Observed `idempotency_mismatch`, despite both emails being discarded. Fix by stripping contact attributes before `requestHash`/`bindRequest`, retaining stripped field names for reporting and the profile-side filter. Skipping this violates the advertised before-hashing behavior and rejects equivalent sanitized retries.

Not checked: Full suite, local L1-L8, real-model parity, deployment, installation or production behavior. BothQ remains the sole live system and the parent's journal responsibility. The intentional phase-1 `save_memory` decision-without-evidence behavior is outside F9; final backup/restore and cross-machine checks are not demanded here.
