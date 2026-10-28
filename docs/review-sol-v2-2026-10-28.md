# Independent review of Agent Memory v2

Reviewer: Sol, 2026-10-28. One fresh independent review, performed without subagents.

Reviewed artifact: `docs/architecture.md`, v2, 1,820 lines, 167,820 bytes. SHA256 `3b442b5976c8e83e525d1afe1894a2e39fffa577707f6d79470aafee29cd916d`. All architecture line references below refer to this pinned artifact. It remained unchanged during review.

Evidence: the governing instruction chain, the v1 review and retained baseline, research 00 through 04, and targeted read-only inspection of BothQ's memory contracts. Official platform documentation was fetched during this review. No implementation, configuration, installation, deployment, live hook exercise, or restore exercise was performed. Only this report was written. The parent owns the BothQ journal.

## Verdict

Withhold approval of the finished implementation plan as written. The Durable Object design remains feasible on Workers Paid without replacing the chosen storage or Vectorize architecture. Required changes concern concrete protocols, caller contracts, phase dependencies, and the owner decisions received during this review. They can be addressed within the existing components.

No P0 finding. The P1 and P2 findings below remain material even if ordinary save and recall work. A later implementation check may establish a platform assumption, but a check must exercise the stated invariant and have a safe failure outcome. Passing a source or fixture check does not establish deployed authentication, native hook behavior, or recovery.

## Owner decisions received during this review

These supersede the pinned artifact. They are required revisions, not unanswered questions or evidence that the author ignored an earlier instruction.

| Decision | Required revision |
|---|---|
| A. Hosted capture contains only locally prepared digests. Never full user or assistant messages. | Replace full-message uploads in lines 20, 992-1006, 1648 and 1733. Read and consolidate the complete relevant material locally into bounded, redacted digests with evidence positions and acknowledged immutable input ranges. Advance the local cursor only after the corresponding digest is durable. Hosted spools, logs, backups and session corpus imports must respect the same boundary. In particular, explicitly handle the old `session_messages` corpus table at line 1230 rather than bulk-importing conversation text through another endpoint. Preserve agreed learning parity with representative decisions, owner corrections and long-session recovery cases, rather than checking that raw messages arrived. |
| B. Both dummy-prompt live tests and recorded fixtures are allowed. | Keep both in phase 2, using the test profile with cleanup, after final plan approval. No further approval question is needed for this choice. |
| C. Keep real links through moves. Profiles primarily separate default context and allow independent work deletion. | Replace the restricted destination type at lines 443-444, 498 and 656, the lossy rule at line 968, and its check at line 1682. Retain stable endpoint ids, relation, reason and provenance. Resolve the current endpoint through the existing node index, including after another move. Keep default recall focused on the routed profile and `me`; allow explicit linked exploration when the caller may read the target profile. A scoped device token must not gain target content, labels, snippets or traversal through that target merely because an accessible node links there. An inaccessible target leaves the stored edge intact. No global sharing or merged default recall is required. |

For the owner's work-wipe use case, add one small deletion contract to this same revision. The current registry only has active/restoring/retired states at lines 737-738, and no profile-wipe operation appears at lines 1264-1278. Define an owner-only wipe that stops access and jobs for that profile, removes its ProfileStore and CorpusStore data, its vectors and transfer copies/archives, and its work payloads in the account review list. Other profiles keep their own records and opaque backlinks to deleted ids, rather than losing unrelated personal notes. Do not retain cached work target content in those backlinks.

Record source profile/id/revision on derived material so the wipe can distinguish a deliberately company-free preference from copied work detail. State what survives, including accepted company-free `me` memories, and what is removed or reduced to an opaque reference. Apply the deletion marker to restore and import reconciliation so an older account, profile or corpus export cannot resurrect wiped work. State when the two retained exports and 300-day archives cease to contain it, or remove those copies during wipe. This is a provenance/deletion rule, not an extensive new permissions system. Cross-profile links alone cannot provide deletion of copied or derived text.

## Disposition of the 11 prior findings

"Resolved" below means resolved in the design, subject to the designated implementation checks.

| Prior finding | Disposition | Evidence and remaining work |
|---|---|---|
| 1. Tool-free maintenance | Partial | Clean home/cwd and explicit tool settings at 1149-1167 improve prevention. Post-execution event rejection and a single negative canary do not prove tool absence. See F1. |
| 2. Move races, history and references | Partial | Intent, source fence, history/request transfer, collisions and recovery at 965-972 address the original lost-append race. The `me` check is before the fence, F2. References must now follow confirmed decision C instead of lossy notes. |
| 3. Consistent export | Unresolved | Sequence stamps and account export at 589, 722-724 and 1436-1444 are useful, but delete/reinsert ordering and a bounded final delta remain unspecified. Independent account/profile exports also need reconciliation. See F3-F4. |
| 4. PITR undo and reconciliation | Partial | Lines 1420-1428 persist the undo bookmark outside the resetting object and use a separate status endpoint, fixing the abort-return error. Joint recovery and derived-index generation ownership remain incomplete, F4 and F8. |
| 5. Capture completeness | Partial | Stop/recovery triggers and immutable acknowledged ranges at 975-1002 fix the HEAD-only key. Full-message retention is superseded by A. The null-path fallback at 997 and 1769 still loses owner material without a guaranteed discovery path. See F9. |
| 6. Work data entering `me` | Partial | Explicit routing/attestation and all-path guards at 452-457 and 932-938 fix automatic preference misrouting. The transfer validation race remains, F2. This restriction on copied content is compatible with authorized linked exploration. |
| 7. Id collisions | Resolved | Creation-profile/user seeds, preserved BothQ ids, node index and pair-keyed merge at 435-438. G4 checks distinct identities at 1632. |
| 8. Fabricated historical validity | Resolved | Defining revision or unknown validity at 1295, checked at 1315. Distillation must preserve evidence; this is not proof that any real migrated date has passed. |
| 9. Compatibility and idempotency | Partial | Original names and durable bindings at 463 and 852-870 are improvements. Original request/result import and read enumeration are incomplete, F5-F6. |
| 10. Identifier mentions asserting fixes | Resolved | Mentions only `relates_to`; stronger relations require structured closing references or reasoned writes at 390, 418-425 and 1191. |
| 11. Paid limits, traversal and phase-one scope | Resolved | Paid target at 778, corrected CPU at 1342-1345, graph work caps at 841, no core SQL tool, and versioned schema at 593-594. Phase dependency errors are separately F7. Benchmarks are not required. |

## Remaining technical findings

### F1. P1. Tool rejection after execution is not a preventive maintenance boundary

Evidence: section 12, lines 1158-1166; section 24, line 1767. The stated defense against an ignored tool setting is to discard the completed run. The phase-3 canary passes when one prompt produces no tool items. An available command tool can remain unused on that prompt, yet execute on a later injected digest. By the time the runner sees its event, a local file may already have entered the model request. Discarding the final operations cannot undo that disclosure.

Minimal fix: make the phase-3 batch safety check establish the effective tool inventory or deny dispatch before execution, for the supported runtime/version. Retain event inspection as detection. If preventive confinement cannot be established, skip the unattended judgment batch and leave its queue for normal inline processing; deterministic storage and capture can still work. Define this failure outcome in the plan. The ignored `unified_exec=false` setting does not by itself prove that `shell_tool=false` fails: the latter is the documented command-tool switch. The gap is the claimed detection fallback and insufficient gate. [Official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [sandbox behavior](https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations).

### F2. P1. The transfer validates an earlier version of the material entering `me`

Evidence: section 9, lines 953-966, versus section 5, lines 452-459. The intent passes the `me` guard, then a later request fences and copies the source. A concurrent append can add a known company term after validation but before the fence. The bundle includes that append and is published in `me`, which default personal recall reads.

Minimal fix: fence first, validate the actual immutable bundle and every copied field, bind validation to its revision/hash, and only then land/publish. Revalidate any newly materialized target data through the target guard. On rejection, abort/unfence without publishing. Retaining authorized links under decision C does not require copying their target's confidential content.

### F3. P1. Export replay can delete a row that exists at E

Evidence: section 5, lines 722-724; section 18, lines 1436-1442. Delete key K after S, then restore or reinsert K before E. The final export contains both the live row and K's delete tombstone. The specified restore upserts changed rows and then deletes every tombstoned key, leaving K missing. Archive restore and transfer-back operations make key reuse a normal scenario.

Minimal fix: reconcile live-row and deletion sequence numbers per key, or invalidate an older tombstone on reinsertion. Only the latest operation at E may win. Require this case in the existing concurrent-write restore check.

The same protocol also needs an actual bound on the final delta. Line 1438 reads every changed row before deciding it exceeds 20k; another pass does not bound that read, byte size, or concurrent growth. Specify bounded intermediate deltas and their ordering, with a bounded final cut and an explicit retry/fence fallback if necessary. This is recovery correctness within hard invocation/memory limits, not a benchmark request. Also give a recoverable definition for the control tables without `seq`, such as `cursors`, at 720. [Cloudflare limits](https://developers.cloudflare.com/durable-objects/platform/limits/) document the resource bounds.

### F4. P1. Separately consistent backups can restore an inconsistent ownership history

Evidence: section 18, lines 1425-1428 and 1444-1452. Each store has its own E. Suppose the source export contains a pre-move active record, while the destination export contains its published copy and AccountStore's older export has no completed transfer. Restoring these individually valid exports yields duplicate ownership. The reconciliation that replays completed account transfers cannot recover a transfer absent from the restored account ledger. An account restore can also restore older request bindings or token revocations while profiles remain newer.

Minimal fix: define a compatible recovery set or an authoritative durable transfer/deletion ledger used to reconcile independently restored stores before serving them. Rebuild/validate node and request ownership against selected generations; explicitly handle unfinished transfers as well as completed ones. Keep authentication closed until restored device grants/revocations are reconciled. Add this joint restore case to the existing drill. Atomic storage is per object, not across all objects. [Cloudflare storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The undo bookmark sequencing itself is corrected: the documented restore API returns an undo bookmark, and abort resets immediately. Those facts do not establish the multi-object recovery invariant. [PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#onnextsessionrestorebookmark), [abort behavior](https://developers.cloudflare.com/durable-objects/api/state/#abort).

### F5. P1. The final migration cannot implement old request replay from request ids alone

Evidence: section 16, lines 1293-1298 and 1317. Export lists revisions with their request ids; import binds old ids in AccountStore. It does not carry BothQ's separate MemoryRequest operation, original request hash and stored result into the profile requests table. A binding with no stored result leads to execution again, the exact behavior described at 1427. A delayed old append can therefore duplicate journal text, or a changed operation/hash scheme can reject a legitimate retry.

This is confirmed by current BothQ source: `graph-db/memory_store.py:149-190` stores request hash, operation, result and memory id separately from revisions.

Minimal fix: add a mechanical, lossless import of request records and original revision snapshots/deltas, separate from semantic distillation. Preserve the old canonical operation/hash interpretation for replay, including renamed update/retire calls. Define where original revision history lands, rather than exporting it and importing only current-state distillations. Extend the existing migration verification to compare these counts/hashes and replay both identical and changed payloads; importing ids alone is insufficient. This completes the approved one-final-migration plan without dual writes.

### F6. P2. The declared compatibility replacement cannot enumerate the full inventory

Evidence: section 7, lines 825-826 and 865. `list_memories` becomes empty-keyword recall, described as paginated, but that tool accepts no continuation cursor and returns none. Its limit stops at 100. On this corpus, repeated requests return the same newest records and leave older records unreachable through the replacement inventory call.

Minimal fix: define a continuation token and stable ordering for empty-keyword enumeration. Document and exercise it in the existing checklist. Full-content paging also needs a revision-bound cursor or a conflict response when replacement/compaction changes the content between pages; otherwise a caller can reconstruct text that never existed at one revision. This is a caller contract, not an argument for restoring all 52 BothQ tools.

### F7. P2. Phase 2 requires contracts whose dependencies are built in phase 3

Evidence: section 22. Phase 2 requires all checklist rows and migration checks at 1657-1658, including transfers and graph-tool replacements, while those tools and transfer protocol arrive at 1664-1668. Its PITR reconciliation creates dangling-reference maintenance items, but maintenance is built only at 1666. Phase-1 atomic supersession at 1631 also needs its relation/history representation before the phase-2 edges schema at 1641. These gates cannot pass in the declared order without silently implementing later phases early.

Minimal fix: move only required schema and safety dependencies earlier, or split checks into the subset available at that phase plus a mandatory combined check after phase 3. Re-run the full migration rehearsal after those dependencies exist, while preserving the one final production migration after all phases. Record decision A/C and the wipe contract in the relevant phase checks.

Remove redundant permission stops at 1608 and the dry-run portion of 1610. Final plan approval authorizes the listed resource/test work; B now settles scratch tests. Keep the explicit DNS approvals, actual hook-trust interaction and chosen cutover window. A demo is not an additional approval gate.

### F8. P2. Scratch restores write to the live vector index

Evidence: section 11, lines 1097-1099; section 18, lines 1450-1454. A scratch generation runs reconciliation and re-embeds into the same user/profile namespace with the same node ids. Restoring yesterday's card during a drill overwrites today's vector, while today's ProfileStore still thinks its current card hash is embedded. An old generation's alarm can similarly overwrite a restored generation after switch. Missing-id cleanup can delete an id still needed by the active generation.

Minimal fix: use a generation-specific namespace/vector identity or prevent scratch/retired generations from publishing or deleting live vectors. Only the active registry generation owns its index mutations. Keep the approved Vectorize service and 300 ms fallback. Vectorize upserts replace a vector by id, and namespace filtering is a query boundary rather than a restore transaction. [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/), [namespace behavior](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/#namespaces).

### F9. P2. The null-path fallback does not guarantee complete local extraction

Evidence: lines 997, 1653 and 1769. A null transcript path uploads only the last assistant message and passes the proposed check. The recovery sweep covers transcripts already seen, with no guaranteed resolver for this missing path. Owner corrections can remain absent permanently. Under decision A the local digest maker still needs that source material. Minimal fix: require transcript discovery or another complete local source for supported clients; otherwise record pending extraction without acknowledging completeness. Exercise recovery of the owner message in the existing phase-2 test, not only arrival of the fallback assistant text.

### F10. P1. Rollback does not restore the old callers or preserve new hosted writes

Evidence: lines 1325-1332 and 1725. After switching, instructions/skills change and native files move. Re-enabling old MCP entries and toggles does not restore those files or callers. If a hosted turn has already appended a checkpoint, returning to frozen BothQ also loses that acknowledged write because dual writes are forbidden.

Minimal fix: save and restore the exact prior caller/config/file state. Keep ordinary sessions frozen through cutover smoke checks so rollback can discard only known test changes. If ordinary hosted writes are admitted before the stated rollback boundary, specify a lossless reverse import before reopening BothQ. This needs a concrete runbook, not another approval gate.

## Implementation-time proof and exclusions

G1 remains an appropriate real-token gate for Clerk audience/redirect/refresh interop and its stated authorization-server fallback. Its fallback must satisfy the complete T1-T6 matrix, not just fix T1/T3. No live login has passed in this review.

The existing phase gates should establish atomic appends/replay, scoped-token denial on every direct/linked/evidence read, digest parity and recovery on both live dummy sessions and fixtures, crash recovery at transfer boundaries, compatible multi-store restore, scratch-index isolation, complete final migration and the rollback runbook. These are refinements to promised behavior, not benchmarks or new owner approval rounds.

Not verified: deployed quotas or cost, auth tokens, effective maintenance tool inventory, hook trust/runtime behavior, migration outputs, backup ciphertext/restore, work wipe, dashboard accessibility, or production continuity. No benchmarks or optimization work was requested or performed. No Postplan was changed and no third parties were contacted. No unresolved A/B/C owner choice remains; the revised document and finished plan still need the owner's approval before implementation.
