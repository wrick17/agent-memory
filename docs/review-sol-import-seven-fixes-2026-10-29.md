# Seven import fixes, independent closure, 2026-10-29

What this change does: It removes the remaining ambiguous-path and URL-password failures, confines uploader requests, binds resume acknowledgements to the batch schedule, reserves imported requests before staging, fences ordinary creation at staged IDs, and applies the existing personal-field rule at import. This review covers only those seven findings and their directly affected controls.

**All seven are closed. No remaining material P0/P1/P2 was reproduced in this scope.** The frozen source is cleared for an isolated rehearsal, subject to Terra's combined verification and live authentication checks. This is not proof of a real upload, a hosted rehearsal, or production readiness.

## Scope and continuity

Sol reviewed the shared `phase2-capture` checkout, HEAD `dc749dc9aad26751d56b02829c39b2cc1ae262f8`. The recursive `~/dotfiles/ai/work/agents.md` instructions and the delegation, Ponytail review, RTK, BothQ and task-journal skills were read. The parent remains the sole BothQ journal writer; this reviewer made no BothQ writes and used no subagents.

The prior thread could not be read because T3 returned `thread_not_found`. The preserved private directory supplied the probe source, frozen implementation copies, synthetic fixtures and four completed safe-outcome results:

```text
/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-seven-majdwwkw
```

Its 47 copied application, local, test and configuration inputs match the corresponding freeze pins. Completed export probes were not rerun. Their saved results and derivative artifacts were validated read-only. The interrupted Workers run had no terminal result, so its eight focused tests were completed. Uploader fixture state alone was insufficient completion evidence; its two focused safe-outcome probes were run with retained output. Old defect-asserting probes were not counted as closure evidence.

## Seven dispositions

| Finding | Verdict | Safe outcome and source |
|---|---|---|
| E2, P1, repeated encoded separators | Closed | All four existing `a/.b`, `a--b`, `a._b`, `a_-b` paths enumerate. Conflicting work/personal rules produce `ambiguous_project_path`, zero planned records and zero commands. Ordinary `a/b`, `a-b`, `a_b`, `a.b` ambiguity is held; a unique path routes. A cutoff at step 118, after one candidate was found, returns `null`, discarding that partial set. The caller holds `null`. `local/migrate.mjs:237`, `:392`. |
| URL scheme cap, P2 | Closed | Both redactors mask the password for `"a" + "1".repeat(64)`. The planner holds it and the local digest rejects it. Ordinary, 64-character, all-digit and original semantic controls retain their old results in both copies. One-million-character plain input and a one-million-digit scheme suffix complete below the focused 2 s guard. `src/domain/redact.ts:14`, `local/agent-memory.mjs:38`. |
| S1, P1, redirect disclosure | Closed | `redirect: "manual"` and the full 300-399 refusal branch prevent forwarding. Actual Node fetch through two loopback listeners checks 300-308 and 399: the target receives zero requests and zero bytes. Direct 200 success remains intact. `local/upload.mjs:66`. |
| S2, P2, changed resume schedule | Closed | `batches_sha256`, contiguous batch numbering, exact ordered command coverage and maximum 50 commands are checked before acknowledgements can be skipped. Twelve malformed, missing, hash or structural changes produce no fetch. A valid resealed 40/20 rebatching passes structural checks but cannot reuse the original 50/10 acknowledgements. Restoring the schedule sends the remaining ten commands; lost responses replay successfully. `local/migrate.mjs:616`, `local/upload.mjs:45`. |
| S3, P2, request taken by another profile | Closed | Account-wide pending reservation occurs before stage dispatch/acknowledgement. A reservation-only crash fixture has no staged part and returns `busy` for the same ordinary request in `work`, `personal` and `me`; exact API retry repairs it. Wrong-hash binding fails without clearing pending state. Binding alone still cannot replay before publication. After publication, the correct legacy request replays and changed arguments fail. A conflicting modern binding is unchanged. `src/api.ts:185`, `src/account/store.ts:145`, `:184`, `:199`, `src/profile/write.ts:573`. |
| S4, P2, hosted creation at a staged ID | Closed | `nodes_import_fence` rejects ordinary save, candidate promotion, knowledge creation, capture creation and digest-session creation at chosen staged IDs. No unpublished node/history becomes readable and inspected text, revision, request, activity and part rows remain unchanged. Each new part also refuses an existing node even when an import ledger already exists. Accepted parts replay before and after publication. `src/profile/schema.ts:199`, `src/profile/import.ts:65`, `:79`, `src/profile/store.ts:55`. |
| S5, P2, explicit contact attributes | Closed | Server finalization refuses `personal_fields` for explicit email/phone attributes on every allowed memory kind tested: journal, rule, document, preference and decision. No node containing those attributes is persisted or silently rewritten. Benign attributes/provenance publish exactly; stored legacy hash/result bytes survive and replay. `src/api.ts:179`, `src/domain/personal.ts:15`. |

For S4, ordinary save accepts only `agent` or `stated` origins; the publication exception is not exposed through its public input. The database trigger also protects the separate creation statements. Digest ingestion raises `import_pending` in the probe; the asserted protection is transaction rollback and absence of leaked rows.

For S5, the constants and complete `stripPersonal` implementation match the original guard byte-for-byte after accounting for the two newly exported constants. Core callers retain the same rule. The planner uses fixed node attributes, so the direct server finalization probe is the material contact-attribute boundary. This is not a new audit of historical prose or nested provenance.

## Preserved and migration controls

- E1 remains closed. The retained complete-outgoing probe has nine privacy holds covering nested provenance keys/values, anchors, relationships, raw steps, parsed snapshots/deltas/results and request extras. All nine private derivatives omit their synthetic markers. One benign nested-provenance/result record imports unchanged. The four retained synthetic export bundles still pass their manifest integrity checks; no re-export or replanning was done.
- Genuine deployed account v1 has neither `legacy` nor `pending`. The corrected fixture verifies exactly the six original `request_index` columns, upgrades with both new columns defaulting to zero, preserves all original binding fields, replays a modern request, refuses a changed payload and retains the `me` guard. The old control that removed only `legacy` while retaining `pending` was half-migrated; its failure was not dismissed as a passing migration. The genuine-v1 replacement passes.
- Profile v2-to-v3 migration preserves the tested revision/request fields and bytes, adds the new fields with null defaults, accepts an appended revision and preserves its deletion tombstone. Both migration controls pass on actual local workerd SQLite.
- Focused core F3/F4 regressions pass 4/4, including discarded-contact replay and the in-flight `me` race. Committed modern replay, BothQ content hashing and routing-change replay pass 3/3. Pending-binding guarding and committed `me` replay pass 2/2. These preserve existing closures without reopening their audits.
- Existing two-part invisibility/history/legacy-replay and 664-request crash-recovery controls pass 2/2. S3's separate probe verifies byte-exact legacy result storage and no revision advancement on replay.

A refused stage may retain a pending reservation and keep that request `busy`. The probe reproduces this fail-safe limit. Cleanup was not added to scope. Direct reservation calls over 400 refuse; 400-plus-5 bounded calls and identical retries succeed.

## Focused commands and retained evidence

Run these from the private directory above. All 22 selected tests pass across the seven test invocations. Name filters intentionally skip unrelated tests; no full or combined suite ran.

```sh
rtk proxy npx vitest run test/review-seven.test.ts --reporter=verbose --silent=false
rtk proxy node --test local/review-seven.test.mjs
rtk proxy npx vitest run test/write-details.test.ts -t 'F3:|F4:' --reporter=verbose
rtk proxy npx vitest run test/g3-contracts.test.ts -t 'replays a stored result|hashes saved content|replays a retry' --reporter=verbose
rtk proxy npx vitest run test/isolation-recall.test.ts -t 'pending request binding|committed me write' --reporter=verbose
rtk proxy npx vitest run test/import.test.ts -t 'two-part record invisible|binds all 664' --reporter=verbose
rtk proxy node --test --test-name-pattern='URL passwords redact for every scheme length' local/migrate.test.mjs
rtk proxy node resume-controls.mjs
```

Outputs are `resumed-workers.log`, `resumed-uploader.log`, `resumed-core.log`, `resumed-hash.log`, `resumed-me.log`, `resumed-import-controls.log`, `resumed-url-long.log` and `resumed-retained-controls.log`. `results.json` and `closure.mjs` preserve the four previously completed groups. The extra validator checks retained bundle integrity, derivative privacy, the partial-search cutoff and unchanged personal-field extraction. Its initial invocation omitted `checkExport`'s manifest argument; correcting that private probe call produced the retained passing result, with no product edit.

Workers tests use actual workerd/SQLite Durable Objects and local R2, with the configured AI/Vectorize fakes and remote bindings disabled. Existing binding-configuration and MCP notification warnings remain in the logs. They are not live model or provider evidence. The unrelated immediate pending-versus-embedded test was not run or changed here.

## Budget and live gates

The canonical budget is Cloudflare-surfaced per-statement `rowsWritten` plus UTF-8 parameter bytes and the two live-text index copies. Source accounting and the updated contract agree. The preserved 956 reported versus 3,499 `total_changes()` observation compares different counters, not a reproduced Cloudflare limit failure. No platform 1,000-row transaction limit or bound on every internal FTS commit write is claimed. No new performance, export, backup or recovery audit was performed.

Path A still needs Terra's live rehearsal-audience proof, including acceptance on the rehearsal resource and cross-audience refusal. Local authentication source and tests do not satisfy that gate. Production import enablement and any real-data upload are outside this closure.

## Source pins and preservation

All **54/54** pins in `/tmp/agent-memory-import-postfix-freeze-20261029.json` match at resume and after this report. The SHA-256 aggregate of the sorted compact JSON path-to-hash map is unchanged:

```text
3533cb03dbaa143e3a25ee3ef9219be8bd1960efcb948eef12620d1d7dd5805e
```

Freeze-file SHA-256:

```text
ee4d82a8ea9d4c5c50941900f154773261993674313baa38a28c16cf23656205
```

Selected exact pins, with the complete mapping in the freeze and `resumed-before-report.json` / `resumed-after-report.json`:

```text
local/migrate.mjs        35f0148846110b01fe3d129b228a4611aa3bd7c69b4a0c8027bb9c2ac3138daa
local/upload.mjs         9389be5a21248ba7fd7c492ab3ce482efd78e8db229e4726d8ad94520429ef47
local/agent-memory.mjs   4de83d60a4add83ab26a27fb12ed2c2f5121a4db9e3c14a478309d13db2d7e2e
src/domain/redact.ts     a66feba3c382251e763e1903bd3df175fc0d2abce492bb3a258905d7756dc441
src/domain/personal.ts   f7541b61e5cb34ac4c8bc1bf105af052b456f5e1bb52ff3a71436d9db0f56e23
src/account/store.ts     51fb9456c18160248683f4fec5ede1ee5c67e6897f395f1b1bbf18cf039b9e68
src/account/schema.ts    2cb5f28eafbdf1b8764ba1be0d5edcbb97ea2f160d6ca7123cafa430c09e8e5c
src/api.ts               f33056bb14ce7ad0186ecf1d8d99a73581f4346db2428a61d4f8e430eb43db72
src/profile/import.ts    50c430db3a0d8297f2e1d905744ec8574c5b3027a5a8ba3dc1608ee5d28c679f
src/profile/schema.ts    6dc30e83dffe0f713dd4c6f05f41489523ef64b7083eaf7cc2d83438e64ad3b2
src/profile/write.ts     5414086c482b2467fc4a8a43c878ccbff137f86747284cad1651ea1812c6bcb5
```

The original review reports remain immutable. The report was absent at resume and is the only repository file written by this reviewer. Existing dirty/staged files, HEAD and index are preserved; final audit evidence is in the private directory. The parent can journal this checkpoint and continue Terra's combined and live gates without further source fixes for these seven findings.

Verdict: Ship to isolated rehearsal for this bounded source review.

Not checked: full/combined suites, live services, real exports or uploads, live audience acceptance, model calls, Git delivery, deployment, backup/restore or physical cross-machine behavior.

Risk: refused-stage reservations can remain busy; local closure does not establish hosted rehearsal or real-data upload success. BothQ remains the sole live system.
