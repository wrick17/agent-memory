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
node local/migrate.mjs plan --routes FILE        # the same, plus the owner's reviewed routes for exact sources of this export
node local/migrate.mjs plan --owner-holds FILE   # owner-bound exclusions before every route; combine with --routes/--source-policy as needed
node local/migrate.mjs plan --rehearsal test     # every record with an identity and no hold, to test (rehearsal Worker only)
node local/migrate.mjs plan --routes FILE --source-policy FILE --owner-holds FILE --rehearsal test
                                                 # the routed plan's holds, classification and policy first; only its accepted records, unchanged, to test
node local/migrate.mjs preview-held [--routes FILE] [--out DIR]
                                                 # private preview of privacy-held records and a draft held-migration input; no plan, no network
node local/migrate.mjs plan --routes FILE --owner-holds FILE --held-migration FILE --refresh-from DIR
                                                 # adds owner-approved held records to a refresh of a completed base
node local/migrate.mjs verify                    # a fresh read of the sources compared with the export
node local/migrate.mjs dry-run [--rehearsal test]   # checks every command, part and batch against the budget; no network
node local/upload.mjs [--rehearsal test] [--config FILE]   # sends a checked plan; resumable
```

Upload config, mode 0600, default `~/.agent-memory/migration/upload.json`:

```json
{ "server": "https://memory-rehearsal.wrick17.com", "token_file": "~/.agent-memory/migration/rehearsal.token", "rehearsal": true }
```

The token file holds one `import`-scoped device token (mode 0600). It is read only when a request is sent and never written to logs, state or output. The upload state, `plan…/upload-<host>.json` (0600), holds batch numbers and receipts: record ids, operations, statuses and reasons, never memory text.

## Owner hold exclusions, 2026-10-31

`plan --owner-holds FILE` takes an owner-owned private JSON file, kept outside the repository with mode0600. Its closed top-level fields are `version: 1`, `export_manifest_sha256` and a nonempty `holds` array. The export hash must match this export's `manifest.json`. Each hold has exactly `source`, `source_sha256` and `reason`; the row hash is the SHA-256 of that exported row's canonical JSON. Sources must be strictly sorted with no duplicates. Reasons are only `privacy_hold` or `unreviewed_new`. Foreign ownership, group/other access, unknown fields, invalid reasons and mismatched bindings refuse the whole input before plan output.

Holds clear automatic routing and take precedence over reviewed routes, owner454 overrides and rehearsal routing. Held sources remain in review as `owner_hold:<reason>` with no route or commands; other privacy and identity guards remain. Absent sources cannot be named, so exclusions neither delete nor resurrect them. The hold-file hash binds the plan input/manifest; without the flag, prior input hashing and unheld command behavior are unchanged. This is reviewed planner source support only. The current fresh plan remains private and has not been uploaded.

## Held-record migration, 2026-11-02

The completed final refresh left 119 sources held: 92 scopeless BothQ records (89 with no other reason, 3 also privacy-held), 25 more privacy-held records, Codex `raw_memories.md` held by the owner, and one new Personal journal quarantined as `unreviewed_new`. The owner decided:

| Decision | Planner behavior |
|---|---|
| Q1, scopeless records | Migrate to Work with assigned identities. Skip duplicates of records already in Work. |
| Q2 and Q3, privacy-held records | Never automatic. Only owner-approved records migrate, as redacted copies. |
| Q4, `raw_memories.md` | Stays held by its owner hold. |
| Q5, quarantined journal | Remove its `unreviewed_new` entry from the owner-holds file. Its `personal/…` scope routes it to Personal with its revisions and requests. No code change. |
| Q6, absent sources | Keep their accounting. Holds and routes cannot name them, so nothing is resurrected. |

`plan --held-migration FILE` takes a private owner file (mode 0600) and requires `--refresh-from` a completed base. Its closed fields are `version: 1`, `export_manifest_sha256`, `owner_decision` (`reference`, `answer`), `assign` and `redacted`. At least one list is nonempty. Each list is strictly sorted by `source`. An `assign` entry is `{source, source_sha256}`, with an optional sorted `distinct_from` id list. A `redacted` entry is `{source, source_sha256, redacted_sha256}`. A stale binding, an unknown source, a wrong record kind or a schema change refuses the whole input before any output.

Identity assignment (`assign`):

- Applies only to a BothQ record with no id, no scope and the `missing_scope` reason. It runs after owner holds and routes, so a held record stays held.
- The id is `uuid5("held-migration:" + source key)`. The source key is `bothq:<element id>`, so a replan gives the same id and an unchanged record emits no commands.
- The scope is `bothq/unscoped`, and the route is Work. The original `legacy_snapshot` revision keeps `scope: null`.
- `attrs.source.held_migration` records the owner-decision digest, the source-key digest and `assigned: {id, scope, recovered: false, original_scope: null}`.
- The record is compared with Work records of other sources in the completed base that have the same type and normalized name, or the same whitespace-collapsed, lowercased text.
- A match with the same content hash, status, revision operations and hashes, and request hashes is skipped as `duplicate_of_migrated` with `duplicate_of: <id>`.
- Any other match is held as `possible_duplicate` with `possible_duplicate_of: [ids]`. The owner keeps it as a distinct record by setting `distinct_from` to exactly those ids.
- Assigned records that conflict with each other stay held as `identity_conflict`.
- A refresh first gives each source that the base assigned its identity back, without an input file, and only then compares other sources. A newer snapshot of an assigned record is added after the base history as a refresh, as for a changed Markdown file. A rewritten snapshot with the same or a lower version is held as `history_rewritten`.

Redaction, for every item:

- Each complete text value is checked as a whole, as well as row by row. This covers the body and every entry, live or historical. A secret split across two 16,000-character text rows therefore holds the record as `needs_redaction`. Before this change, such a record with no other secret was planned unredacted.
- Every state a reader can see is checked. For each revision and each entry revision, the planner rebuilds the fields and content that the hosted `as_of` reader would show. The rebuild is a port of `pastOf` and `contentAt` in `src/profile/read.ts`:
  - The fields come from the newest snapshot with a description, with the name of any newer name-only snapshot.
  - The content is the newest content snapshot plus later entries. Without a content snapshot, it is the body rows plus later entries.
  - The current node and its content form one more state.
  - Each field is checked alone, and all fields are checked joined with newlines.
  - The port drops the reader's fail-closed nulls, so it rebuilds at least every state the reader can show. This covers intermediate append states and past fields beside later appends.
- A match only in a rebuilt state holds the record as `needs_redaction`. Such a match cannot be mapped back onto the stored parts, so its redacted copy is never `complete`, and an approval holds it as `redaction_incomplete`.

Redacted approval (`redacted`):

- `preview-held --refresh-from BASE [--routes FILE]` writes `preview.json` and `held-migration.draft.json`, both mode 0600. The default folder is `~/.agent-memory/migration-base/previews/held-<UTC>-<rand>/`, outside git. It applies routes, restored identities, assignment and duplicate matching as the plan would, but not owner holds.
- For each record that the redactor would change, the preview holds its source binding, `redacted_sha256`, name, kind, destination and `already_hosted` id. It also holds `findings` and the redacted fields and text. Each finding gives a field and the rules that fired there: `private_key`, `auth_header`, `vendor_token`, `aws_key`, `jwt`, `key_value`, `url_password` or `sensitive_key`. A finding never includes the matched text.
- The preview also lists skipped and possible duplicates, each with a ready-to-copy `distinct_from` binding.
- The draft lists every scopeless record in `assign` and leaves `redacted` empty.
- To approve a record, copy its three binding fields into `redacted` and remove its `privacy_hold` entry from the owner-holds file. A record that is still owner-held refuses the input.
- The redacted copy redacts each complete text value before it is split into rows again. Every other field, revision and request is the server redactor's output. Stored JSON is serialized again only where redaction changed it. The node's `chars` and `content_hash` are computed again.
- `redacted_sha256` covers the destination profile and the copy's full outgoing payload: node, id, scope, text rows, revisions and requests. Only held-migration provenance is left out. A changed route or payload refuses the approval until the owner approves it again.
- A copy that the redactor would still change is held as `redaction_incomplete`.
- `attrs.source.held_migration.redacted` records the binding and the number of changed values. The original text is never sent.
- A refresh keeps an approved copy while its binding is unchanged. Otherwise the record is held again.

Unapproved records keep `needs_redaction` and their private hold derivative.

The held-migration file hash binds the plan input. The plan manifest reports `held_migration` counts: `assigned`, `duplicates`, `possible_duplicates` and `approved_redacted`. The offline projection against the retained base is private; this repository holds no record text or names.

Offline projection, 2026-11-02, against the retained final completed refresh without a fresh BothQ export. No network was used and nothing was uploaded. Two runs gave the same commands hash. After the reader-state check, the counts and the commands hash are unchanged, so no retained record has a match only in a rebuilt state. A plan of the retained export now takes about 19 seconds.

| Result | Count |
|---|---|
| New Work records with assigned identities | 86 (172 commands) |
| New Personal record (the Q5 journal: 2 revisions, 1 request) | 1 (2 commands) |
| Batches | 4 |
| Duplicates skipped | 0 |
| Held for owner selection: `possible_duplicate` | 2 |
| Still held: privacy owner hold | 25 |
| Still held: privacy hold and missing scope | 3 |
| Still held: `raw_memories.md` | 1 |
| Still held: assigned record that the current redactor now flags | 1 |
| Already-migrated Work records that the current redactor now flags (`route_changed`, no commands) | 3 |
| Preview entries (all complete; 3 already hosted) | 32 |

The redactor change in `27a85c4` came after the final plan and causes the last two held rows. For the 3 hosted records, the only rule that fires is `key_value`. In two records it fires in legacy source properties. In the third it fires in the description, its revision snapshot and its body text. A fresh export would also pick up BothQ changes made since 2026-10-31: new or edited records, new scopeless records, and changed row hashes. Every bound input (routes, holds, policy, held migration) must then be regenerated for the new manifest.

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

## Import integrity audit, 2026-10-29

The hosted parity check proved content and history, but the read API does not return each record's request ledger or provenance. This read-only audit closes that gap for migration verification 1 and 2 ([design](import-integrity-design.md)).

- **`GET /v1/import/audit`** (owner, or an `import` device that may use the profile; `me` refused). Summary pages carry, per record:
  - its stored `record_sha256` and `node_sha256`;
  - its current node revision, plus digests of the stored attributes and their source;
  - digests of its imported revisions and request ledger, with a count of later hosted rows.

  Each summary also carries the stored node row's digest (`row_sha256`) and its two dates. Detail pages return the per-row digests. Results are hashed as their exact stored UTF-8 bytes. A summary page holds at most 50 records and hashes at most 5,000 rows, counted before they are read. A larger record comes with its counts only, marked `paged`. Detail pages hold at most 200 rows. The audit only reads: it takes no binding and never replays.
- **`node local/upload.mjs audit [--export DIR] [--rehearsal test]`** computes the same digests from the uploaded plan with the shared module and pages the server. It writes `audit-<host>.json` (mode 0600) beside the upload state, listing record ids by class: missing, extra, state, node, attrs, source, revisions, requests, texts (every record), identity (v2 policy records), and hosted drift. The stored `record_sha256` is listed apart under `provenance`, as a count of matching plan hashes and the ids and observed hashes of the others; it is never a mismatch and never a pass.
  - It checks the plan with `dryRun` first, and refuses one that differs from an upload state. A missing upload state does not block a read-only audit; the report records it as `provenance.upload_state: absent`.
  - It identifies records by profile and id, and compares each stored node row with the plan's node while the revision is unchanged.
  - It reads paged records through the detail pages.
  - It reads every record's text rows through the `rows=texts` detail pages, including one empty page for a record with no text, and checks each page's anchors against the summary.
  - It exits 0 only on a full semantic match, with no mismatch and no drift. Provenance never changes the status.
- **Review corrections, 2026-10-29.** The independent review found five P2 defects in the first version: a missing plan passed with 0 records; current node fields went unchecked; a copy of a record in a second profile was hidden; a page could pass its row bound; and drift still passed. Each is fixed. Each regression fails on the reviewed patch (`ef364020…a238`) and passes now.
- **Semantic text correction, 2026-11-02.** The first canonical audit of the accepted first-copy plan reported only `record` mismatches for all 1,374 records. The server stores the import chain's claimed wrapper hash and never recomputes it, and the auditor read stored texts only for policy records. So the wrapper class now is provenance, and every record's stored texts are compared. The hosted audit of the accepted plan with this correction has not run.
- **Against the fixture:** the shared module reproduces Terra's expected-integrity fixture (`89101631…a253f`) for all 1,330 rehearsal records, with 0 mismatches. The hosted run is pending deployment.

| Regression | Result |
|---|---|
| `test/import.test.ts`, audit: a journal with a non-canonical, non-ASCII result, a Markdown record and a staged-only record | Totals, summary pages, detail pages and exact byte counts equal digests written out independently in the test |
| Same test, read only | Table counts, `write_seq` and AccountStore bindings are unchanged; a BothQ request still replays |
| Same test, drift and tampering | A hosted append raises the node revision and the hosted request count, and leaves the imported digests unchanged. One changed result byte or attribute shows on that record, in that class only |
| `test/import.test.ts`, access | No token 401; `read`/`write` device 403; device for another profile 403; `me` 400; unknown profile 404; unknown parameter, oversized page or incomplete detail query 400 |
| `local/upload.test.mjs`, audit | A faithful server over five pages gives `ok`; one changed snapshot byte gives `mismatch`, naming that record under `revisions`; the report is mode 0600 and holds no token |
| `local/upload.test.mjs`, semantic text correction | Every record's texts are read: a record with no text gets one empty page, and two-row pages cross chunk 9 to 10. Another chain's wrapper hashes with equal stored rows give `ok` and list all 12 under provenance; one changed stored body of a non-policy record gives a `texts` mismatch, with or without a matching wrapper hash. The fake server returns real text-page anchors and compares cursor tuples |
| `local/upload.test.mjs`, review corrections | A missing `commands.jsonl` or a plan that differs from the upload state is refused before any request. A node whose stored status changed without a new revision is a `node` mismatch. A copy of a personal record in work is `extra` as `work/<id>`. A paged record is read through its detail pages, and a byte changed in it is found. One hosted request gives status `drift` |
| `test/import.test.ts`, review corrections | `row_sha256` equals the plan's node, and changes when the status changes with no new revision. Two records of 3,000 rows go on two pages. A 5,001-row record is listed `paged` with its count, and its rows come back on 26 detail pages of at most 200. A non-numeric revision cursor is refused |

## Import refresh (schema v5), 2026-10-29

A fresh export reconciles into the hosted copy before cutover ([design](import-refresh-design.md)): `node local/migrate.mjs plan --export FRESH --refresh-from BASE [--rehearsal test]`, then the usual upload.
- **Planner.** It runs only when exactly one server has a complete upload of the base plan. Each record is classified against the base:
  - unchanged: nothing;
  - BothQ history extended: a fast-forward refresh. One too large to publish whole is split at revision boundaries into consecutive anchored refreshes, each a true BothQ state;
  - BothQ adoption of a legacy record: the synthetic snapshot is replaced;
  - Markdown changed: a new revision. With only path aliases changed, the provenance alone is updated;
  - held, never written: `history_rewritten`, `source_vanished`, `route_changed`, `oversize_refresh` and every first-copy hold.

  Links the base already made are not re-sent.
- **Server.** A refresh stages under the shadow id `<record>#r<n>`, which has no node, so nothing reads it, and its request ids answer `busy`.
  - Prepare checks the base anchor and the hosted node: a hosted write since makes it refuse `hosted_changed`. It also checks that the delta only extends history.
  - Publish re-keys the rows onto the record in one transaction under the 1,000-row budget, and updates the node. A body replacement keeps the earlier body and entries as history (`live = 0`).
  - Retries replay.

| Regression | Result |
|---|---|
| `test/import.test.ts`, fast-forward | A two-append delta stays invisible to get, recall and replay until publish. It publishes in one bounded transaction, replays on retry, and keeps every BothQ request replayable |
| `test/import.test.ts`, conflict | After a hosted append the refresh is refused `hosted_changed`; the hosted content is unchanged and the staged row stays under its shadow id |
| `test/import.test.ts`, body replacement | Content becomes the new body and later entry; the first body and both earlier entries are still stored as `live = 0`; old text no longer recalls |
| `test/import.test.ts`, adoption | An identical `legacy_adopted` replaces the synthetic `legacy_snapshot`; one with other content is refused `history_rewritten` and changes nothing |
| `local/migrate.test.mjs`, refresh plan | A refresh needs a complete base upload. 200 appends become consecutive anchored refreshes, each within budget and ending at the export's revision. Rewritten, vanished and rerouted sources are held with no commands |

**Review corrections, 2026-10-29.** The independent review of v5 and R6 found three defects. Each is fixed with a regression that fails on the reviewed artifact (`598ae3de…`).
- **Emptied body:** an update that empties a journal's content sent no body row, so `body_revision` was missing and the old content stayed live. The planner now marks the replacement from the source revision that sets the body, empty or not. The reviewer's real-planner-to-Workers test fails with the old planner's commands and passes with the new.
- **Adoption before a split:** a legacy adoption followed by 200 appends was held as `history_rewritten`, because the adoption was left out of the split. It now goes in the first step, and later steps keep it.
- **Sequence row:** the write's sequence row was not charged, so a write of 1,001 real rows committed. It is now charged: that write rolls back, and the 997-row control commits.

An independent review closed all three on the frozen source `bd3a4ce2…`. Combined and runtime verification remain open.

**Real-data proof, private, read-only on the retained export.** On a private copy of the export, the first-copy plans are byte-identical to the recorded ones: rehearsal `b6213e44…`/`0feca7c9…` (1,330 records) and routed `e7eff1cf…`/`5144610b…` (969). A refresh of that identical copy from the uploaded rehearsal base plans 0 commands, with the same 130 review entries. No file in the retained export changed.

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

## Reviewed routes, 2026-10-29

`plan --routes FILE` routes sources that no rule routes, from a private file of owner-reviewed bindings kept outside the repository. It is implemented with scoped local checks only and has not been applied to the retained plan.

- The file names one export by the SHA-256 of its `manifest.json`. Each route gives:
  - one full source key (`bothq:<element id>` or `<system>:<real path>`);
  - its id and its scope;
  - `work` or `personal`;
  - the SHA-256 of its exported row's canonical JSON.

  A numeric element-id tail is not an identity.
- Before any output, the plan refuses the whole file for any of these:
  - another export;
  - an unknown, repeated or changed source, or a changed id or scope;
  - a route into `me`, or any other profile or key;
  - a source that a remote, path or scope rule already routes;
  - a rehearsal.
- A route sets only the profile and lifts no other hold. Redaction, missing scope, ambiguous path, reference candidate, personal fields, identity conflict and oversize still hold. Scope, paths, history, requests, anchors and relationships stay the exported record's own.
- A reviewed plan is never served from the plan cache. Every `plan --routes` run rebuilds the items and checks the current checkout remotes again, with the per-process remote lookup cleared. It also checks the decoded paths, existing-rule refusals and every hold. A source whose checkout gained a work remote since the last plan is refused, not planned from the earlier result. The file's SHA-256 still enters the plan's input hash and its manifest (`reviewed_routes`). Without `--routes`, plan outputs and caching are byte-identical to before.
- A refresh compares routes as before. A record routed by review keeps its route only with a route bound to the fresh export; otherwise it holds as `route_changed`.

Fixed after review (2026-10-29): the independent review found one P2, the cached return for a reviewed plan. The parent's fix skips the cache for reviewed plans and clears the remote lookup. Its regression plans a reviewed `personal` source, then gives its checkout a work remote. Both the forced and the normal rerun must refuse, with outputs unchanged. The regression fails on the reviewed source and passes on the fix. Restoring only the disk-cache shortcut makes it fail again. The fix had no further independent review.

Historical source check, on the first reviewed-routes source before the fix: on a private copy of the retained export, the plan without routes matched the recorded routed plan and the base code byte for byte. With the 147 accepted bindings (125 `work`, 22 `personal`), 145 records were added to the plan, 123 `work` and 22 `personal`. Two `work` Claude index files from two Claude configuration roots share one name and scope, and the existing identity rule holds both. All 969 earlier records kept their exact record hashes. The review list fell from 491 to 346:

| Reason | Count |
|---|---|
| `unrouted_scope` | 199 |
| `unrouted_path` | 46 |
| `missing_scope` | 92 |
| `needs_redaction` | 28 |
| `reference_candidate` | 11 |
| `identity_conflict` | 2 |

The plan had 1,114 records (878 `work`, 236 `personal`) and 47 batches, with nothing over budget. It was not promoted, and it is not proof for the final source or for the newer binding set.

Owner decisions, 2026-10-29:
- The one held `personal` candidate's work login and email mentions are personal metadata. This applies to that exact record only. It is no general rule for company data, `me`, the company-free attestation or redaction.
- The prepared 148 bindings were later supplemented by 12 independently cleared bindings for the private 160-binding proof below. Binding files remain outside the repository; the historical 147-binding file is unchanged.
- The two identity conflicts stay held.
- The existing set of 30 golden queries is selected. The earlier prepared 29/30 result is historical and is not runtime proof for that selection.

## Private 160-binding proof, 2026-10-29

Terra's retained private proof at `/tmp/am-terra-routing-160-proof` has verified routes SHA-256 `a62f1f4bd757fbeda0c37a0eb95aa46266da2631ecb8457ba603ed9eee733ad9` and [proof receipt](/tmp/am-terra-routing-160-proof/proof.log) SHA-256 `d85d67b03d9ac467f977e8b2cd87ce06a6e3e40eeb855e217afa0379d588aa30`. It plans 158 of 160 bindings, with the same two identity conflicts held. The result is 1,127 planned records (881 work, 246 personal), 333 review entries, 28 holds and 51 batches, with no budget violations. The proof records all 969 prior record hashes unchanged and identical retained export/state hashes before and after. These are verified receipt facts from a private planner run; no planner or source-data operation was repeated during adoption. No private identities, bindings or query bodies enter the repository. No upload, production import or hosted golden-query proof follows. The owner-selected 30-query runtime gate remains open.

## Checks

| Command | Result |
|---|---|
| `npx tsc --noEmit`, `npm run lint` | No errors (after the closure fixes) |
| `npx vitest run test/import.test.ts` | 11 tests passed (after the closure fixes) |
| `npx vitest run test/capture.test.ts test/write-details.test.ts test/g3-contracts.test.ts test/isolation-recall.test.ts` | 42 tests passed: the redactor, guard and request-binding paths the fixes touch |
| `node --test local/migrate.test.mjs local/upload.test.mjs local/agent-memory.test.mjs` | 19 + 6 + 21 tests passed |
| After the audit review corrections: `npx vitest run test/import.test.ts`, `node --test local/upload.test.mjs`, `npx tsc --noEmit`, ESLint on the changed files | 14 and 10 tests passed; no type or lint errors. On the reviewed patch's code, the three changed Worker audit tests and the four new client tests fail |
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
