# Import implementation

Author: Opus (`claude-opus-5-5`), 2026-10-29, on `phase2-capture`. This is the [import vertical](architecture.md#import-vertical-bothq-and-curated-markdown-memory) of the owner priority of 2026-10-29. It covers a read-only export of BothQ and the curated Markdown memory, a deterministic staged plan, the server import, and the uploader. Local and Workers checks pass. Nothing is deployed, nothing real has been uploaded, and production imports are switched off (`IMPORT_PROFILES` is empty). BothQ stays the only live system. The export reads the sources and changes none of them.

## What exists

| Piece | Files | Role |
|---|---|---|
| Export | `local/migrate/export_bothq.py`, `local/migrate.mjs` | The exporter runs under BothQ's own interpreter and configured driver, in a `READ`-mode session with `execute_read` only. It reads every memory record with its properties, anchors, steps, relationships, revisions and requests. Each record is read between two equal fingerprints and read again if a writer changed it; membership is listed again at the end. Markdown files are read between two equal stat witnesses and retried; a file that keeps changing is exported with no content and held. Outputs are 0700 folders and 0600 files; standard output carries counts and hashes only. |
| Plan | `local/migrate.mjs` (`plan`, `verify`, `dry-run`) | Before any reuse or new plan, it checks the export bundle against its manifest (file hashes, counts, every Markdown body's hash). It normalizes, routes, holds and packs every record into staged commands. Deterministic: the same export and rules give byte-identical commands. |
| Cost model | `src/domain/import-cost.ts` | The budget, the measured row costs and the packer, shared by the planner, the server and the tests. |
| Server | `src/profile/import.ts`, `src/api.ts` (`/v1/import`), `src/account/store.ts` (`bindImport`, legacy bindings), `src/domain/legacy.ts`, `src/profile/write.ts` (replay fence), `src/profile/read.ts` (history) | The staged protocol: stage, prepare, bind, publish, link ([architecture section 16](architecture.md#the-staged-import-protocol)). |
| Schema | `src/profile/schema.ts` v3, `src/account/schema.ts` v2 | Profile v3 rebuilds `revisions` to take BothQ's operations (`appended`, `legacy_adopted`, `legacy_snapshot`) and keep `delta`, `revision_id`, `content_hash` and the source platform, copying every existing row. It adds `requests.completed_at` and `requests.source`, the `import_records` and `import_parts` ledgers, and a `requests_node` index. Account v2 marks a request binding imported from BothQ (`request_index.legacy`). Phase 3's planned v3 is now v4. |
| Uploader | `local/upload.mjs` | Foreground. It reads a private config and token file, sends batches in order, saves an acknowledgement after each one, and resumes at the first batch not acknowledged. It retries the network and 5xx or 429 responses 5 times with backoff, never follows a redirect, and resumes only under the same commands and batch schedule; any refusal stops the run with a report. |
| Rehearsal Worker | `wrangler.jsonc` `env.rehearsal` | The same code as a separate Worker with its own Durable Objects, Vectorize index and R2 ledger ([rehearsal isolation](architecture.md#rehearsal-isolation)). |

## Commands

```sh
node local/migrate.mjs export                    # BothQ (read transactions) + Markdown (read) into export-<UTC>-<rand>/
node local/migrate.mjs plan                      # routed plan: work and personal, nothing to me
node local/migrate.mjs plan --rehearsal test     # every record with an identity and no hold, to test (rehearsal Worker only)
node local/migrate.mjs verify                    # a fresh read of the sources compared with the export
node local/migrate.mjs dry-run [--rehearsal test]   # checks every command, part and batch against the budget; no network
node local/upload.mjs [--rehearsal test] [--config FILE]   # sends a checked plan; resumable
```

Upload config, mode 0600, default `~/.agent-memory/migration/upload.json`:

```json
{ "server": "https://memory-rehearsal.wrick17.com", "token_file": "~/.agent-memory/migration/rehearsal.token", "rehearsal": true }
```

The token file holds one `import`-scoped device token (mode 0600). It is read only when a request is sent and never written to logs, state or output. The upload state, `plan…/upload-<host>.json` (0600), holds batch numbers and receipts: record ids, operations, statuses and reasons, never memory text.

## Export review fixes, 2026-10-29

The [independent review](review-sol-import-export-2026-10-29.md) found six defects. Each now has a regression in `local/migrate.test.mjs`, built from the reviewer's counterexample. All six fail on the checkpoint code (`dc749dc`) and pass now. Against the fixed code, the reviewer's own repros fail at their defect assertions: `repro.mjs` at its first case (2 holds now, not 0), and `markdown-race.mjs` because the export now carries the current file's hash, not a mix.

| Finding | Fix |
|---|---|
| E1 (P1) secrets in provenance or request results passed | The hold check runs the server's `redactPayload` over everything a record would send: node and provenance, texts, revisions with their snapshot and delta parsed, requests with their result parsed. It catches patterns and values under sensitive keys. Any change holds the record; the held copy is redacted too. |
| E2 (P1) an ambiguous Claude folder name picked the first match | `decodeProjectDirs` lists every existing path the name can stand for. More than one means `ambiguous_project_path` and a hold, never a guess. |
| E3 (P2) a rewrite during a read could export a mixed body | The file is read between two equal stat witnesses (device, inode, size, mtime, ctime) and retried; a file that never holds still is held as `unstable_read` with no content. |
| E4 (P2) supersession properties were dropped | Every relationship, `SUPERSEDES` included, stays raw in `attrs.source.relationships`, as well as becoming a link. |
| E5 (P2) a finalize command could exceed 1 MB | Every command must fit one request with its envelope, and its publish transaction the budget (`publishCost`). Otherwise the record is held as `oversize_command`. `dry-run` checks every command and every batch envelope. |
| E6 (P2) a changed export reused an old plan | `checkExport` verifies the bundle against its manifest before any reuse or plan, and refuses a stale or edited bundle. |

Fixing E5 also exposed a defect in the shared redactor. `URL_PASSWORD`'s unbounded scheme `[a-z][a-z0-9+.-]*` backtracked quadratically on a long alphanumeric run: 40,000 characters took 0.8 s, and 1 MB would take minutes. On the server, that applies to any long save or append. The scheme is now bounded to 64 characters in `src/domain/redact.ts` and its mirror in `local/agent-memory.mjs`; output differs only for schemes longer than that. A 1 MB run now redacts in 155 ms, which a test checks.

## Closure fixes, 2026-10-29

Two independent reviews followed: the [export closure](review-sol-import-export-fixes-2026-10-29.md) and the [server and uploader review](review-sol-import-server-uploader-2026-10-29.md). They found seven defects; each is fixed. Each regression is built from the reviewer's counterexample. Every one fails on the reviewed source, kept privately as `/tmp/am-orig-import-review`, and passes now. Against the fixed source, the reviewers' own probes fail at their defect assertions, while their controls pass. Two server-review controls fail only because they simulate account v1 without the new `pending` column; the `me` guard control passes when run on its own, and `test/import.test.ts` checks the v1 to v2 upgrade with both columns removed.

| Finding | Fix | Regression |
|---|---|---|
| E2 (P1) consecutive separators | `decodeProjectDirs` treats every encoded `-` as an independent choice of `/`, `.`, `_` or `-`, so `a/.b`, `a--b`, `a._b` and `a_-b` are all listed and held. A search that outgrows its bound returns no candidates and holds the record; it never routes a partial set. | `local/migrate.test.mjs` E2 |
| URL scheme cap (P2) | Both redactors match a URL password from its `://` and accept it when the run of scheme characters just before it holds a letter: the original pattern's rule, checked by one backward scan per `://`, so a long run stays linear. | Parity with the original pattern on ordinary, 64-character, 65-character (`a` + 64 digits), all-digit and mixed cases, in both copies; 1 MB runs under 2 s |
| S1 (P1) redirects | The uploader sends with `redirect: "manual"` and stops on any 3xx; nothing is followed. | `local/upload.test.mjs` S1, with the real `fetch` and two loopback listeners: the target receives no request |
| S2 (P2) changed batch schedule | The plan manifest records `batches_sha256`. `dry-run` checks it and the schedule itself: batches numbered 1 to N in order, every command exactly once in order, at most 50 per batch. The upload state's identity is the commands and the schedule, so a changed schedule refuses to resume. | `local/migrate.test.mjs` S2, `local/upload.test.mjs` S2 |
| S3 (P2) staged request ids taken elsewhere | Before a part is staged, `AccountStore.reserveImport` reserves its request ids account-wide as pending bindings (account v2 `request_index.pending`, at most 400 per transaction). An ordinary call with one gets `busy` in every profile. An identical reservation is kept, so a bytes-identical retry repairs a crash between reservation and stage. A different existing binding refuses the stage. `bindImport` turns the reservations into bindings before publication. | `test/import.test.ts` S3 |
| S4 (P2) hosted creation on an id being imported | A trigger on `nodes` (schema v3, `nodes_import_fence`) refuses any creation but publication for an id whose import is not published; the write returns `busy`. Every new part also refuses if a node now has its id, while an accepted part still replays. | `test/import.test.ts` S4 |
| S5 (P2) contact attributes on an imported node | The existing personal-field rule, `stripPersonal`, now lives in `src/domain/personal.ts`, so the Worker and the planner share one copy. A finalize whose node it would change is refused as `personal_fields`, and the planner holds such a record; nothing is rewritten. Benign provenance passes. | `test/import.test.ts` S5 |

The real plans were made again with these rules, from the same export, with no re-export. Their command hashes are unchanged (`e7eff1cf…5ae3` routed, `b6213e44…687d` rehearsal), so no real record gained a hold; the new `batches_sha256` values are `5144610b…244b` and `0feca7c9…e915`. The plans from before these fixes are kept beside them as `plan-checkpoint-20261029-pre-closure` and `plan-rehearsal-test-checkpoint-20261029-pre-closure`.

## Link contract fix, 2026-10-29

The hosted rehearsal stopped on batch 60. Five of its eight links were refused as `invalid_endpoints` ([verification](import-verification.md#cleared-freeze-and-hosted-rehearsal-2026-10-29)).

**Cause.** The import's link step required one kind on both ends. That is the knowledge graph's rule for judgment edges, not BothQ's. BothQ's `_supersede` lets any memory replace any other, except a seeded routine, and so does hosted `save_memory` with `supersedes` (`supersede` in `src/profile/write.ts`). Typed trace of the eight links:
- Each is a real BothQ `SUPERSEDES` edge, present on both records.
- Both endpoints of each are adopted BothQ records, published in the rehearsal; none is a self-link.
- Each target was superseded in BothQ.
- The refused five join different memory types: feedback to project (rule to decision) twice, and reference to project (document to journal) three times. The three linked ones join the same type.

No planner identity, privacy or partial-publish fault was involved.

**Fix.**
- `link` in `src/profile/import.ts` now joins two different published memories of the profile, of any kinds, as `save_memory` does. It still refuses an unpublished endpoint, a self-link, a knowledge-graph node that is not a memory, and a record of another profile. The judgment-edge table is unchanged.
- The planner had a related gap. It linked to any ready record, including one held later as oversize, and ignored the profile. It now links only to a record the plan publishes in the same profile, and lists any other supersession for review. BothQ's raw relationship stays in the record's provenance.

No real link changes:
- Every link in both real plans has a planned target in its own profile: eight in rehearsal, six routed.
- Neither plan was made again. Their command and batch hashes are unchanged.
- Batch 60's resend replays its six stage and finalize commands and its three made links, and links the other five.

| Regression | Before the fix | After |
|---|---|---|
| `test/import.test.ts`, links: a rule superseding a decision and a document superseding a journal, replayed; refusals for an unpublished endpoint, a self-link, a component node at either end and a memory of another profile; exactly three edges | Fails: `["refused", "refused"]` for the two pairs | Passes |
| `local/migrate.test.mjs`, links only to records the plan publishes in the same profile | Fails: links to an oversize and a cross-profile target emitted | Passes |

## Real read-only run

The export is `~/.agent-memory/migration/export-20261028T192847Z-c696`, read once on 2026-10-28T19:28:47Z. It was not read again for the fixes.

**BothQ:**
- 1,101 records (407 adopted, 694 legacy).
- 3,755 revisions and 3,182 requests, all linked to records.
- 114 steps and 8 supersessions.

**Markdown:**
- Claude: 54 paths, 50 distinct files.
- Codex: 309 files, 11 of them reference candidates.
- 348 distinct named-memory files, 2,872,921 bytes.

The counts match research 05.

The plans below were made after all fixes, with the measured costs.

| Plan | Records | Review | Holds | Commands | Largest part (estimate) | Largest command | Over budget | Commands SHA-256 |
|---|---|---|---|---|---|---|---|---|
| Routed (`plan/`) | 969: 755 `work`, 214 `personal`, 0 `me` | 491 | 28 | 970 stage, 969 finalize, 6 link; 41 batches | 999 rows, 824,938 bytes | 605,283 bytes | 0 | `e7eff1cf…5ae3` |
| Rehearsal (`plan-rehearsal-test/`) | 1,330 to `test` | 130 | 28 | 1,343 stage, 1,330 finalize, 8 link; 60 batches | 999 rows, 998,644 bytes | 990,895 bytes | 0 | `b6213e44…687d` |

Review reasons in the routed plan (an entry can have several):

| Reason | Count |
|---|---:|
| `unrouted_scope` | 224 |
| `unrouted_path` | 168 |
| `missing_scope` | 92 |
| `needs_redaction` | 28 |
| `reference_candidate` | 11 |

The 28 holds are 27 earlier ones plus one record the key-based check now catches. 26 are legacy BothQ records written before BothQ redacted at write time; BothQ's own redactor changes them too.

The largest journal, `72ea0e74-aca8-5e4f-b1d3-3878342b6973`, plans into 8 parts. Its live text reassembles to 987,013 characters with SHA-256 `e46ec710cfe0c275c295d3445fcd3eb783d3a4169bcf011cebfee5e64f911663`, the same as research 05. It carries 664 revisions and 664 requests.

## Server costs, measured

Workers SQLite reports these `rowsWritten` per staged row on schema v3:

| Row | Rows written | Why |
|---|---:|---|
| Live text | 5 | the row, two indexes, and its full-text and trigram rows |
| History text (not live) | 3 | the row and two indexes |
| Revision | 2 | the row and its sequence index |
| Request | 3 | the row, its sequence index and `requests_node` |

The first estimate, 3 per text row, was too optimistic. The measured values replaced it. A test then caught requests at 3, after v3 added `requests_node`.

The server counts bytes as the UTF-8 length of every parameter, plus twice the body of a live text for its two index copies. Each part adds a fixed overhead of 12 rows and 8 KB.

What the budget means: SQLite's per-statement `rowsWritten` as Cloudflare surfaces it, plus the UTF-8 bytes of the parameters. That caps the `seq`-stamped base-table rows, and their index entries, that one transaction adds for the export (architecture section 5). It is not a bound on every internal SQLite mutation. In the server review, one accepted 190-live-row part surfaced 956 `rowsWritten`, while SQLite's connection-wide `total_changes()` rose by 3,499, including full-text writes made at commit. Those are different counters; neither of the extra writes is exported, and Cloudflare documents no 1,000-row transaction limit, so the bound is this design's own and is kept as defined. If a literal bound on all internal mutations were ever required, the minimum check would be to read `total_changes()` before and after each import transaction, commit included, on the largest real part shapes. At about 18 changes per live text row, the planner would then need parts several times smaller.

On real Workers SQLite, every real extreme part shape keeps the server's surfaced count within 1,000 rows and 1,000,000 bytes, and within the planner's estimate. The shapes tested are the largest-row part, the largest-byte part and all 8 parts of the largest journal (`test/fixtures/import-part-shapes.json`, lengths only, no text). A part over the budget is refused whole, and nothing of it stays staged. The API reports no cost below SQLite's per-statement `rowsWritten`; full-text segment writes that SQLite defers to commit are not attributed to a statement.

## Rehearsal resources for Terra

Created by Terra on 2026-10-29: the Vectorize index `agent-memory-cards-rehearsal` (1,024 dimensions, cosine, `kind` String metadata index) and the R2 bucket `agent-memory-rehearsal-ledger`. Still to do, after clearance:

1. Repeat the DNS preflight, then deploy the Worker `agent-memory-rehearsal` with its custom domain `memory-rehearsal.wrick17.com`: `npx wrangler deploy --env rehearsal`.
2. Check `/.well-known/oauth-protected-resource/mcp` on the rehearsal host: it names the rehearsal resource and the Clerk issuer. An unauthenticated `/mcp` returns 401 with a `resource_metadata` challenge.
3. Owner OAuth for the rehearsal resource (path A, no Clerk change): in a fresh private `CODEX_HOME` with a file credential store and the rehearsal `/mcp` as server, run `codex mcp login --no-browser --scopes memory,offline_access`. The owner completes consent in the approved session; MFA is the only manual step.
4. A script reads the credential file and prints only true or false: issuer, owner, `aud` containing `https://memory-rehearsal.wrick17.com/mcp`, and scope `memory`.
5. With that token, rehearsal `GET /v1/whoami` returns 200. Production's returns 401 for wrong audience, and an existing production-audience token gets 401 on the rehearsal Worker.
6. A script sends `POST /api/devices` to the rehearsal Worker with that token: `{ "name": "rehearsal-import", "scopes": ["import"], "profiles": ["test"], "default_profile": "test" }`. It writes the returned token straight to a mode-0600 file and prints only the device id. That token works only on the rehearsal Worker, whose `AccountStore` is its own.
7. Write the mode-0600 upload config with `"rehearsal": true`. `POST /v1/import` with `{"commands": []}` returns 400 (validation), which proves the token is accepted before any data is sent. Then run `node local/upload.mjs --rehearsal test`.

If step 4 or 5 fails, stop and use path B: change `env.rehearsal` to the nested host `rehearsal.memory.wrick17.com`, under Clerk's root (route, `RESOURCE_URL`, `DASHBOARD_ORIGIN`), add it in Clerk's allowed subdomains if that list is on, redeploy, and create the token through owner sign-in on its Settings page. The rehearsal's audience and scope checks are never relaxed.

Production stays closed to imports (`IMPORT_PROFILES` empty). After the rehearsal passes and the change is reviewed, the copy is enabled by setting `IMPORT_PROFILES` to `work,personal` and creating a production `import` token.

## Copying into production

After the independent review and a passing rehearsal, every record that is routed with confidence and passes every check is copied without a further owner prompt; the owner authorized the non-deleting ingest. Only held and ambiguous records wait:
- missing or mixed scope;
- an ambiguous or unrouted path;
- a redaction hold or an unstable read;
- an identity conflict or an oversized command;
- a reference candidate.

They are classified from existing evidence first. An owner question comes only when the evidence cannot decide.

No original source is rewritten or deleted. A refresh from a fresh export still comes before cutover. A record that changed in BothQ after its copy is refused as `record_changed`, not overwritten. It takes the refresh and conflict path, which is not built yet.

## Checks

| Command | Result |
|---|---|
| `npx tsc --noEmit`, `npm run lint` | No errors (after the closure fixes) |
| `npx vitest run test/import.test.ts` | 11 tests passed (after the closure fixes) |
| `npx vitest run test/capture.test.ts test/write-details.test.ts test/g3-contracts.test.ts test/isolation-recall.test.ts` | 42 tests passed: the redactor, guard and request-binding paths the fixes touch |
| `node --test local/migrate.test.mjs local/upload.test.mjs local/agent-memory.test.mjs` | 19 + 6 + 21 tests passed |
| After the link fix: `npx vitest run test/import.test.ts test/g3-contracts.test.ts test/write-details.test.ts`, `node --test local/migrate.test.mjs`, `npx tsc --noEmit`, ESLint on the changed files | 35 and 20 tests passed; no type or lint errors. The full suites are Terra's combined check |
| `npx vitest run` and `npm run test:local`, before the closure fixes | 66 and 41 passed; the full suites were not repeated after the fixes, which Terra's combined check covers |
| `npx wrangler deploy --dry-run` for production and `--env rehearsal` | Both bundle, 1,398.70 KiB; nothing deployed |
| `npx wrangler types --strict-vars=false --check` | Types up to date (`IMPORT_PROFILES` added) |

`test/import.test.ts` covers:
- The v2 → v3 upgrade, which keeps every revision and request.
- A multi-part record that is invisible before publication to get with retired and history, name lookup, inventory and full-text recall, with its request ids answering `busy`; after publication it reads back byte for byte with BothQ's original snapshots.
- BothQ's fixture request replaying its stored result while a changed call is refused.
- The real part shapes against the budget, and an over-budget part refused whole.
- 664 requests bound in two batches, with resume after a crash before and after publication.
- A hosted write that takes the identity making publication refuse.
- Supersessions between published memories of any kinds, with replay, and refusals for an unpublished endpoint, a self-link, a non-memory node and another profile's record.
- Refusals: no `import` scope, profile not allowed, `me`, more than 50 commands, more than 1,000,000 bytes, a tampered hash, text that needs redaction, a changed part, a changed record.

`local/upload.test.mjs` covers:
- A lost response resent and replayed.
- A stop after bounded retries, then a resume that skips acknowledged batches.
- A refusal stopping the run.
- A changed plan refused under its old state.
- A rehearsal plan kept off any non-rehearsal server, and the reverse.
- Group-readable token files refused.

## Not proved, and gates still open

- **Not done yet:**
  - No rehearsal on the rehearsal Worker. It needs Terra's resources and a deploy.
  - No production copy.
  - No hosted verification 1, 2 and 5 to 8 on real data.
  - No golden queries (verification 4).
- **Not built yet:**
  - The refresh and conflict path for records that changed after their copy.
  - Distillation and session digests.
  - Tests for every memory-tool row of the BothQ compatibility checklist (architecture section 7). Only replay and history are covered here.
- `record_knowledge`'s work-term registration does not run for imported records: they are memories, not entities.
- The import never writes to `me`. An explicit `me` import path is not built.
- Backup and restore stay in the final stage, and cross-machine parity in the final rehearsal.
