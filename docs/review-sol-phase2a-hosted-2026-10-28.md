# Hosted capture review, 2026-10-28

What this change does: Adds hosted digest ingestion and recovery, candidate review, and graph writes. This review covers the hosted boundary against AM-07/08/09/10 and architecture sections 4, 5, 7 and 10.

**Verdict: Fix F1-F9 before shipping this boundary.** Four P1 and five P2 findings follow. No production authority exercised.

## Evidence and source pin

Base and HEAD: `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9`, plus the uncommitted vertical. All ten scoped source files and three relevant test files have identical before/after SHA-256s. Exact hashes: [before](/tmp/sol-hosted-repros-p34mrnhz/hashes-before.json), [after](/tmp/sol-hosted-repros-p34mrnhz/hashes-after.json). Both sorted path/hash aggregate digests are `36e60a88f6ddd80605999e85c776d86618e075557198b23a7e0ccb66ec70567b`.

Independent [repros](/tmp/sol-hosted-repros-p34mrnhz/test/hosted-review.test.ts) ran against copied source in real workerd/SQLite Durable Objects and local R2, with AI/Vectorize fakes. Run from that temporary directory: `./node_modules/.bin/vitest run --config vitest.config.ts`. [Output](/tmp/sol-hosted-repros-p34mrnhz/run-final.log): 10/10 probes passed, asserting the defects and controls below. These passes confirm observed defects, not release readiness.

## Material findings

1. **F1, P1: Raw messages pass inside digest bodies.** `src/profile/capture.ts:32-43,98-100`. Upload an otherwise empty valid digest with `outcomes.whole_message = "PRIVATE RAW MESSAGE ".repeat(200)`, or the same top-level field. Observed HTTP 200, `stored`, and all 4,000 characters persisted. Expected refusal of unknown fields and oversized outcome values. This bypasses the digest-only privacy boundary. Fix with strict nested body schemas and bounded outcome strings before persistence. This is independent of short excerpts legitimately containing whole short messages.

2. **F2, P1: Redaction corrupts accepted immutable parts.** `src/profile/capture.ts:87-100,124`. Upload a valid part containing `corrections:[{text:"Use token=[REDACTED]",pos:5}]` and its correct hash. Observed `stored`, but stored bytes have a different hash and invalid JSON because string redaction consumes the closing quote. Its manifest throws `SyntaxError`; retries cannot replace the immutable part. Expected exact accepted bytes and successful completion. Validate redaction structurally, refuse parts needing changes, and persist the exact validated bytes.

3. **F3, P1: Work contact fields persist.** `src/mcp.ts:70-73`; `src/profile/write.ts:486-490`. `record_knowledge` with a work person and `attrs:{email:"colleague@example.invalid",phone:"+1 202 555 0147"}` succeeds and stores both values unchanged. Expected stripping before storage on every profile, per architecture section 5. This uploads personal contact data through the new path. Strip prohibited contact fields before hashing/persistence, keeping the `me` refusal behavior.

4. **F4, P1: Work handles do not enter the me guard.** `src/profile/write.ts:495`; `src/mcp.ts:185`. Create a work person named `Colleague Name`, key `person:colleague`, with `attrs.github:"privatecolleague42"`. A fresh context guards the name but omits the handle; a subsequent company-free `me` preference mentioning that handle succeeds. Expected `me_sensitive_term` and no write. Company identifiers enter globally recalled `me`. Register supported handles alongside names and keys before returning success.

5. **F5, P2: Graph memory updates lose search freshness and history.** `src/profile/write.ts:471-491,532`. Create a keyed decision with description `orchidbefore`, then upsert it with `zeppelinafter`. Observed revision 2, zero history revisions, no lexical hit for the new description, and a hit for the old description. Expected preserved revisions and refreshed search text. Updates never rewrite the head or schedule changed embeddings. Reuse the existing head/revision helpers and return embedding work for changed cards.

6. **F6, P2: Invalid typed relations are committed.** `src/profile/write.ts:507-521`; `src/domain/types.ts:5-8`. A component-to-bug `reviewed` edge with a valid reason and evidence is stored as judgment. Expected validation naming allowed person-to-PR kinds. The current API already admits false typed graph states; labeling the endpoint table phase 3 does not protect existing writes. Enforce endpoint kinds before inserting, with `other` as the explicit escape.

7. **F7, P2: A key collision overwrites another entity kind.** `src/profile/write.ts:465-477`. Create person key `person:foo`, then upsert component key `person:foo`, name `Replacement Component`. Observed success on the same ID, with persisted kind `person` and replacement component metadata. Expected a kind conflict and unchanged person. Entity identity and the actual kind diverge. Check the matched node's kind before updating and refuse mismatches.

8. **F8, P2: Valid large manifests cannot become durable.** `src/api.ts:62`; `src/profile/capture.ts:116-130`; `src/profile/schema.ts:61`. Store 160 valid parts spanning `0-100` through `15900-16000`, then submit their tiling manifest. All parts store; the manifest throws `CHECK constraint failed: length(body) <= 16000`. Recovery stays unconsolidated indefinitely. Expected durable acknowledgement within the advertised 512-part contract. Store manifests in bounded chunks and reconstruct them for replay/state, preserving transaction budgets.

9. **F9, P2: Decisions need no evidence.** `src/mcp.ts:70-74`; `src/profile/write.ts:463,486-491`. `{kind:"decision",key:"decision:cache",name:"cache setting",why:"memory is bounded"}` succeeds alone; SQL confirms no node evidence. Expected refusal without the evidence required by architecture section 4. Unsupported decisions enter ordinary memory recall. Accept and validate decision evidence, then persist it atomically with the decision.

## Limits

Focused controls confirmed cross-profile ingestion refusal, read-only promotion refusal, failed-promotion rollback, and candidate exclusion from get/ordinary/history recall. Only the requested report was added to the checkout; all repro fixtures are temporary and synthetic. No full suite, real-model parity, local-client algorithm/confinement review, live auth, browser, remote service, deployment, secret access, or client-state change. BothQ remains the parent's journal responsibility.
