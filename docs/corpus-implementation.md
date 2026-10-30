# Corpus vertical: storage, uploader and queries (AM-14, source only)

**Status, 2026-10-30.** The first corpus vertical is integrated locally, first written on the cleared root (126 files, aggregate `91e01937…`) and ported by R0 onto CODE719 (root `c4d42da`) with one resolved hunk in `src/profile/store.ts`. It has passed scoped and combined local checks. The original vertical received a bounded source review with three P2 findings. R1 is retained in the guard-term layer; R2 and R3 are fixed in the continuation below. A fresh independent source review cleared all three fixes. The reviewed R0 port is now adopted on root `6ddd8df`; Terra's combined local verification passed. This adoption establishes no hosted or runtime verification, deployment or real upload. F1 refresh is now independently source-cleared and adopted locally over root b238096 ([F1 evidence](#f1-refresh-source-adoption-2026-10-30)); the prior combined result covers R0 only. It covers five Git-history families. AM-14 is not complete. The full corpus load and corpus backups stay in the final stages ([architecture](architecture.md#14-corpus-module-paid-only)).

Evidence: the retained-schema inventory `corpus-schema.json` (SHA-256 `4575c22a…`) and its privacy-lineage follow-up `privacy-lineage.json` (`12121454…`). No row of the owner's corpus file was read for this work. Every check used synthetic rows.

## R0 source adoption, 2026-10-30

The owner-authorized sole integrator applied the exact reviewed R0 code, configuration and four-doc proposal to root `6ddd8df6ba2f8db53a5c89d44854c789ae01082c` with zero fuzz and no offset. Current README and import-verification bytes remain unchanged. The only additions to the reviewed proposal record actual adoption status and its remaining gates. This dated receipt supersedes earlier private, review-pending and adoption-pending labels for this same R0 source, including the historical checks below.

The frozen [R0 source map](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-corpus-r0-port-opus-QD3NxFz0/capsule/r0-source-map.json) pins 140 files: source aggregate `40be4bf4d5bcbad07257f4cbf96df68b19a832107bbcf398e1aec45baae02be1`, source and physical-mode aggregate `9adf28fa1f08945979b37e95f3df760af112d2287471cfb0653112056aec8ed4`. The [independent R0 integration review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-r0-integration-review-sol-22s5cp76/review.txt) is SOURCE CLEAR. It verified full reproduction and reused the R1/R2/R3 source clearance and the author's [scoped receipt](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-corpus-r0-port-opus-QD3NxFz0/capsule/r0-seam-receipt.json). Two distinct independent local controls passed across separate runs; the initial success fixture's I/O-context failure was corrected without a product change. No single green two-control run is claimed.

All code, config and test bytes and modes match that reviewed map. Current README/import facts and the four docs' adoption-status changes are separate metadata additions to that historical 140-file identity. The integrator ran only local diff, link and doc-consistency checks. No index, commit, push, hosted, model, real-corpus or production-migration action was included in that adoption.

Terra's [combined local receipt](/tmp/am-r0-terra-BuExVZ/receipt.txt) passed typecheck, lint, 291 Worker tests and 79 local tests (one native sandbox test skipped), generated types, and production, rehearsal and test dry runs. All 95 runtime, configuration and test paths match the tested source in bytes and physical modes. This does not prove hosted or real-corpus behavior.

The [revision 2 refresh contract](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-corpus-refresh-design-r2-opus-o3k9ArV6/MANIFEST.sha256), SHA-256 `c80a5a819755f9687f01562a73273a3b26a808f83c5afa8aa2597bbb661a7494`, is independently [CLEAR](/private/tmp/am-corpus-refresh-r2-review-sol-20261030-k7p4/review.txt) and accepted by the parent, with U8 and U9: reads pause during a plan and recovery, and can remain closed indefinitely if no source can observe an outstanding table. At R0 adoption, implementation and its checks remained pending; the later [F1 source adoption](#f1-refresh-source-adoption-2026-10-30) supersedes that status.

Production and rehearsal remain `CORPUS: "off"`, unbound and on unchanged migrations; only `env.test` binds `CORPUS_STORE` with migration `v2`. All 94 held names, including raw session text, stay held. F1 implementation was still pending at this R0 checkpoint; its later local adoption is recorded below. AM-14, runtime acceptance, real sample/load, `explore` and final backup gates remain open. BothQ stays running and readable; this adoption activates no caller or capture and changes no cutover decision.

## What exists

| Part | File | What it does |
|---|---|---|
| Families and hold list | `src/corpus/families.ts` | The approved families with their original DDL, projection, key and search mapping. Every other source table appears with its hold reason. The row check is here too. |
| Store | `src/corpus/store.ts` | `CorpusStore`: one SQLite Durable Object per (user, profile, generation), named `userId:profile:generation` on `CORPUS_STORE`. Methods: `importChunk`, `status`, `query`, `refresh`, `wipe`. |
| Reads | `src/corpus/query.ts` | Search, exact get, and read-only SQL, each with `as_of` per table read. |
| Worker | `src/corpus-tools.ts`, `src/api.ts`, `src/mcp.ts` | The `corpus` MCP tool (scope `read`). `POST /v1/corpus/import`, `POST /v1/corpus/refresh` and `GET /v1/corpus/status` take the owner or an `import` device. |
| Wipe | `src/profile/store.ts` | `ProfileStore.purgeOrigin` closes and clears the generation's corpus before its own `close` and `clear` steps. |
| Uploader | `local/corpus-upload.mjs`, `local/corpus-cli.mjs` | The shared core and the foreground CLI: `node local/corpus-cli.mjs --db FILE --profile test --tables repos,commits --as-of ISO`. |
| Tests | `test/corpus.test.ts`, `local/corpus-upload.test.mjs` | Real local Worker, Durable Objects and SQLite. Node for the CLI's SQLite source and HTTP client. |

**Flag and bindings.** The module runs only when `CORPUS` is `"on"` and `CORPUS_STORE` (class `CorpusStore`) is bound. Production and the rehearsal set `CORPUS` to `"off"` and have no binding or migration. `env.test` binds `CORPUS_STORE` with migration `v2` and keeps the flag `"off"`, so every other suite sees the tool list and routes of a deployment without the corpus. `test/corpus.test.ts` turns the flag on per request through the Worker's own `fetch`. Corpus imports also need the profile in `IMPORT_PROFILES`.

## Approved projections

Each table loads only under its exact original DDL: the uploader compares SHA-256 of `sqlite_master.sql` with the server's `schema_sha256`. The server refuses any other hash, column list or order.

| Table | Key and paging | Uploaded columns | Never uploaded | Search document |
|---|---|---|---|---|
| `repos` | source `rowid` (rowid table; `full_name` is a nullable key) | `rowid` and all 16 columns | none | `repo:repos:<full_name>`, title `full_name`, detail `description` |
| `commits` | `(repo, sha)`, WITHOUT ROWID | all but two | `author_email`, `committer_email` | `commit:commits:<repo>@<sha>`, title `subject`, detail `message` |
| `refs` | `(repo, refname)`, WITHOUT ROWID | all but one | `author_email` | `ref:refs:<repo>:<refname>`, title `short_name`, detail `subject` |
| `commit_paths` | `(repo, sha, path)`, WITHOUT ROWID | all 5 | none | one per `(repo, path)`: `path:commit_paths:<repo>:<path>` |
| `contributors` | source `rowid` (no declared key) | `rowid`, `repo`, `rank`, `commits`, `name` | `email` | none |

Omitted columns stay in the original schema as NULL. Index `commits_author` is left out because its column is always NULL. The other five original indexes are kept.

**Privacy rule.** The uploader redacts every non-key text value with the server's own redactor and the personal-field patterns (`src/domain/redact.ts`, `src/domain/personal.ts`) before hashing. The server checks every text value and refuses, never rewrites. Key values are never rewritten: a key that would need redaction holds its row (`row_key_private`). A value carrying a forbidden table's legacy evidence id (`session:session_messages:…`) is refused as `forbidden_lineage`.

**Search.** `corpus_search_documents` and `corpus_search_fts` keep their original schemas, with the same tokenizer and contentless table. Their rows are rebuilt inside the chunk's transaction from that chunk's approved rows only. No source search document, FTS shadow or docsize payload is accepted. The evidence id and key formats follow the lineage research (commit and repo are proved; ref and path are inferred from component positions). Title and detail match the legacy builder only for the sampled commit mapping; the rest is this design's own choice.

## Load protocol

- **Chunk:** at most 5,000 rows and 1,000,000 bytes per request, rows in strictly increasing key order (integers numerically, text by UTF-8 bytes), `after` equal to the stored last key, and a `final` flag on the last chunk. The request id is `corpus:<table>:<rowid>` for rowid tables, `corpus:<table>:k<32 hex of the first key>` for composite keys, and `corpus:<table>:end` for an empty final chunk.
- **Replay and conflict:** the same request id with the same `sha256` replays. A different hash is `idempotency_mismatch`. A gap or reorder is `out_of_order`, with the expected key. A second source file, `as_of` or schema for a table is `source_changed`. A chunk after the final one is `table_complete`.
- **Generation:** every chunk names the generation from `/v1/corpus/status`. Another generation is refused with `generation_changed`, and the uploader's state pins it, so a resumed upload never lands in a recreated profile.
- **Resume:** the uploader resumes after the server's stored last key. A response lost after commit costs nothing. Before skipping a completed table, it compares the stored source hash and `as_of` to the requested snapshot, even with fresh local state. A different snapshot is refused as `source_changed`; only an identical finished load sends nothing.
- **`as_of`:** per table, the value the uploader passes and the server keeps, with `refresh: "snapshot"` and `complete`. The research shows assembly on 2026-08-12 (`corpus_metadata.assembled_at`), but per-table refresh times are unproved. `as_of` is the owner's declared snapshot time, not a refresh claim.
- **Transaction size:** one chunk is one transaction of up to 5,000 rows plus their index, document and FTS rows. The 1,000-row, 1 MB bound of section 5 is the profile export cut's own bound for `seq`-stamped tables. Corpus tables keep their original schemas without `seq`, and Cloudflare documents no transaction row limit. The corpus export cut is open (see holds).
- **Size:** chunks are refused with `size_budget` above 9 GB, 90% of the Paid object limit.

## Reads

- `search`: FTS5 over the rebuilt documents (the phrase, then each word, combined with OR), ranked, at most 50 results. `as_of` covers the source tables of the kinds returned.
- `get`: `commit` (`repo@sha` with up to 500 paths, or a full SHA across repos, up to 20), `repo` (with up to 500 contributors), `ref` (`repo:refname`), `person` (contributor name, up to 500). `pr`, `ticket` and `session` are refused as held.
- **Answer bytes:** search, get and SQL share a 1,000,000-byte limit on the complete JSON text returned by the tool. The count uses UTF-8 and includes routing fields (`profile`, `routed_by`, `action`), columns, provenance, keys, array separators and truncation flags. Lists retain leading whole rows; an oversized first row yields an empty list with `truncated: true`. Byte truncation of paths also sets `paths_truncated`. Metadata that exceeds the budget alone is refused as `size_budget`. `found` reflects the lookup before byte truncation. MCP transport framing is outside this JSON-text budget.
- `sql`: one read-only SELECT, at most 500 rows and the shared answer-byte limit. A lexer that follows SQLite's quoting rejects any `;` outside a literal and any parenthesis that would close the wrapper. The text then runs as `SELECT * FROM (…) LIMIT 501` inside a transaction that always rolls back. `EXPLAIN` names the b-trees the statement opens, so `tables_read` and `as_of` are exact. Observed in local workerd: `sql.exec` runs every statement of a string; `BEGIN`, `SAVEPOINT`, `RELEASE` and `PRAGMA query_only` are refused; a thrown `transactionSync` rolls back both DML and DDL. The store holds one profile's corpus and nothing else.

## Work guard terms

A chunk loaded into `work` introduces work names, and the `me` guard must know them, as it knows the names a `record_knowledge` or work upload brings:
- **Terms.** Each repo (`repo`, or `full_name` for `repos`) becomes a project term. Each person name (`author_name` and `committer_name` in `commits`, `author_name` in `refs`, `name` in `contributors`) becomes a person term. Both follow the same `knowledgeTerms` rule as the other writers. A term comes only from rows that passed the row check, never from a contact column, and never from a value the uploader redacted.
- **Path.** The Worker runs every stateless chunk check first (`checkChunk`, the same function the store runs in its transaction). It then registers the terms through the existing `addSensitiveTerms` helper, in pages of at most 200. Each page is one account transaction and one `me` transaction, through `guardMe` and `addGuardTerms`: the account-to-`me`-to-account seam the other writers use, with no owner fallback. No second term store exists.
- **Generation.** Each page names the chunk's profile and generation. The account checks inside the write, with no await before it, that the generation is active and the account is not recovering. A wipe or recovery that began after the request read its context stops the registration with `busy`. After the last await, the store's own access check and closed marker refuse a chunk the wipe overtook.
- **Order and replay.** All pages are confirmed before the chunk is stored. A guard outage, recovery or closed generation therefore stores nothing and acknowledges nothing. The uploader stops with `stopped` (`busy` or `unavailable`, now HTTP 503) and keeps no person data in its state. The resend of the same deterministic chunk replays every page and then stores or replays the chunk. The chunk itself is the bounded intent, so no pending log is kept. If `me` misses a term the account already holds, every later `me` write still reads that term from the account context. The next resend also copies it into `me`.
- **Existing `me` records.** Registration writes no `me` node. A pinned preference that already names a new term keeps its revision, pin and empty flag. New `me` writes and updates naming the term are refused with `me_sensitive_term` under the existing rule.
- **Scope.** Only the `work` profile registers terms, as with work uploads. The same pre-existing pattern in `workUpload` and `record_knowledge` registers without a generation binding; this change leaves those callers as they are.

## Wipe

The wipe's `close` step marks the generation's corpus closed: every later chunk and read is refused, including one that passed the account check before the close. The `clear` step runs `deleteAll()` and keeps only the closed marker. A cleared object is never migrated again. A new generation of the same name is a new, empty object. Backup exports of the corpus wait for the final stage.

## Holds

Every hold is listed by name in `HELD`, and nothing below loads:

| Group | Tables | Why |
|---|---|---|
| Never | `session_messages`, `session_decisions`, `user_directives`, and any name containing session, directive or decision | Raw session text |
| Session-derived | `corpus_search_documents`, `corpus_search_fts` and its four shadows, `directive_relations` | 23,048 forbidden-derived documents, docsize ids including them, and 20 copied directive texts |
| Session lineage | `codex_sessions`, `session_reference_index`, `session_commit_links`, `session_ticket_links`, `pattern_session_*` | Only some columns are proved metadata-only |
| Builder metadata | `corpus_metadata`, `corpus_search_manifest`, `frontend_metadata`, `pattern_metadata`, `evidence_provenance`, `github_api_calls`, `delivery_exceptions` | Temporary source paths; `as_of` and source identity travel with each chunk instead |
| Delivery | 10 tables, including `pull_requests`, `releases` and `github_tags` | Next family: text and actor fields not yet checked |
| Tickets | `tickets`, `ticket_episodes`, `ticket_episode_commits`, `ticket_repo_edges` | Ticket text projection unproved; refresh undecided |
| History | 8 derived tables, including `branch_families` and `subject_episode_commits` | Not yet classified |
| Checkout scans | 23 architecture and frontend tables | `(repo, path)` replacement refresh and `analysis_head` markers undecided |
| Judgment, patterns | 10 curated and 15 statistics tables | Snapshot versus view semantics and privacy unproved |
| System | `sqlite_stat1` | Planner statistics |

The five approved families and the 94 held names together are exactly the 99 tables of the retained schema.

**Still open in this vertical:**
- F1 per-repo refresh from a committed SQLite snapshot is source-cleared and locally adopted below. Its combined, hosted and actual CLI-process checks remain open. Git/scanner acquisition, scheduling and analysis-head automation are not built.
- The corpus export cut for the final backup stage.
- `explore` integration.
- The `agent-memory corpus-upload` subcommand wiring.
- The remaining 88 source families.

## Review fixes R2 and R3 (2026-10-30, source only)

The continuation retains the prior R1 guard-term patch without changing its registration behavior. R2 checks the completed table's source identity before skipping. R3 continues the interrupted author's shared UTF-8 answer budget through SQL, search and get, including the Worker's routing fields. Import receipts and status carry only bounded keys and the five-family status/manifest; neither returns corpus text rows through this read helper.

Scoped evidence in the private continuation capsule:
- Both final regression cases fail on the reconstructed original 137-file source and on the R1 guard-term snapshot: stale completion returns `done`, and four Unicode SQL rows return 1,200,156 bytes of tool JSON text.
- `vitest run test/corpus.test.ts`: 13/13 passed. R2 covers both changed source hash and changed `as_of` with fresh state, plus identical-snapshot no-send. R3 covers Unicode rows, an individually oversized row, a row whose metadata pushes it over budget, metadata that cannot fit alone, oversized search/get results, and an ordinary complete get.
- `tsc --noEmit` and eslint on the five touched code/test files: exit 0. `node --test local/corpus-upload.test.mjs`: 3/3 passed.
- The interrupted author's search/get fixture appended to an already completed table. The continuation uses a fresh synthetic profile and valid key order so those assertions execute. Its authored partial and failed fixture run are retained separately.

These are author-scoped checks. R1, R2 and R3 still need an independent review of the final source. Terra owns combined and runtime verification and delivery; nothing here authorizes root adoption or real corpus reads.

## Checks (scoped, 2026-10-30)

Guard-term chunk on the corpus snapshot with 137 files:
- `npx tsc --noEmit` and touched-file eslint: exit 0.
- `npx vitest run test/corpus.test.ts test/wipe.test.ts test/mcp-auth.test.ts test/work-upload.test.ts`: 47/47, including 3 new corpus cases:
  - terms reach the account and the `me` guard, `me` writes are refused, and the pinned `me` record is untouched;
  - a guard outage, recovery, transport loss, replay and a late wipe each store nothing extra;
  - 451 terms land in 3 pages.
- Red runs: the snapshot with 137 files fails all 3 new cases. Removing the generation binding, using one unbounded page, or registering after storage each fails its case.

First vertical:

All local; logs in the private capsule.

- `npx tsc --noEmit`: exit 0. `npx eslint` on every touched file: exit 0.
- `npx vitest run test/corpus.test.ts test/wipe.test.ts test/mcp-auth.test.ts`: 33/33. The corpus file has 8 cases:
  - main flow;
  - replay, resume and conflict;
  - budgets and privacy;
  - lineage refusals (26 names, uploader refusal before any read, a view under an approved name, a copied evidence id);
  - 29 SQL write and escape attempts with the data unchanged, the 500-row cap and profile isolation;
  - generation pin, scopes and the real owner wipe with late chunks and no resurrection;
  - the close race;
  - corpus off.
- `node --test local/corpus-upload.test.mjs`: 3/3.
- Red runs, each with source bytes restored: without the wipe hook the generation keeps all 21 of its schema objects; without the lexer the parenthesis escape is not refused; without the personal-field check an email in a commit message is accepted.

## Gates before AM-14 can close

1. Independent source review and sole-integrator adoption are complete for R0 and F1 ([R0 evidence](#r0-source-adoption-2026-10-30), [F1 evidence](#f1-refresh-source-adoption-2026-10-30)).
2. F1 combined affected-flow and runtime checks; only the earlier R0 combined local check passed.
3. An owner-approved bounded sample from the real file into `test`, with row counts compared.
4. Projection checks for each remaining family.
5. F1 combined, hosted and actual CLI-process acceptance; Git/scanner sources and scheduling.
6. `explore` integration.
7. The full load and wipe in the final rehearsal.
8. Corpus backups in the final stage.


## F1 refresh source adoption, 2026-10-30

The owner-authorized sole integrator adopted the eleven reviewed F1 runtime/local/test paths over root `b238096a8a0a25da90d029bb852f54a056cb44c8`. Each path matches the cleared candidate in bytes and physical mode. The additive patch applies and reverses with zero fuzz or offsets. Current R0/self-host source, package scripts and dependency graph are preserved; no private historical docs, AGENTS or research replaced current files. The separate core API/read and Jira candidates remain private and are not included.

The accepted [source map](/private/tmp/am-f1-fix-sol-1nwh2br9/capsule/source-map.json) pins the historical 142-file candidate: bytes `dd638d768d07ef6bf72784321e482a2ebb3ab60621f616f1bcf3d7f691f6fcde` and bytes plus physical modes `8d067f37b44c8c6e8d3cea9d8cad27c0c63fa904a0f9a742f6fc60c775c4c7d7`. Its [capsule manifest](/private/tmp/am-f1-fix-sol-1nwh2br9/capsule/MANIFEST.sha256) is `5e5c053684b3ee94160a3b1b989b75006d8139c869b19fec4baace49a73b4489`. The [additive patch](/private/tmp/am-f1-fix-sol-1nwh2br9/capsule/f1-additive.patch) is `41dc2171dbcb527cc181baca91f6cc643cdf9c8bf30d346541be7205b6cdfaa5`. These pins identify the reviewed input, not the current root's whole-file identity.

The fresh [independent I1-I4 recheck](/private/tmp/am-f1-recheck-sol-ounk5f7q/review.txt), SHA-256 `10157c0b4bdc1b29fbe2fd83386d451e72f0e8c6b600ac279e49f13237c972d2`, is SOURCE CLEAR, accepted by the parent. Seven scoped real Worker checks, one actual two-handle SQLite check and all three patch reconstructions passed. The [author receipt](/private/tmp/am-f1-fix-sol-1nwh2br9/capsule/receipt.json) reports ten scoped Worker refresh cases, five local cases, types and touched lint. These existing greens are reused; this integration runs mechanical checks only. Historical 179-pass/exit-zero Worker evidence still contains an uncaught Vitest-global-state diagnostic and is not clean combined proof. The author's known shared-dependency results-cache write remains documented in its handoff; this adoption neither repeats nor restores it.

One repo refreshes all five approved projections through `POST /v1/corpus/refresh` with inspect, begin, hash-chained parts and finish. Plans are saved before begin, bind the source and observed time, maintain partition digests transactionally and publish only after their targets verify. Stored receipt text replays byte for byte behind current access, generation and wipe fences. Removal keeps zero-row partitions to refuse older source cuts. Per-table as-of values report oldest/newest observations and declared, observed or mixed basis; exact repo gets add repo_as_of. Put rows in work register the existing guarded term pages before storage.

I1-I4 fixes enforce the shared table-only/exact-DDL/required-column rule before any new target read or saved plan; derive validation, rows and source hash from one committed SQLite snapshot including WAL; report cursor and receipt writes in rows_written; and reconcile an uncertain failure's authoritative cursor/chain before halving an unapplied HTTP 5xx/network slice. A failing single operation stops. The internal adapter is async: await sqliteSource, pass source.fileSha256, and close it in finally. A saved exact plan keeps its original identity without rereading a replacement source. Declared --as-of remains normalized ISO UTC, not an invented builder time.

U8 closes all corpus reads from begin until verified publication, including recovery. U9 permits a same-repo takeover only when it observes every outstanding changed table. Reads can stay closed indefinitely if the required source is unavailable; no timer or held-family fallback opens them. All 94 held tables, including raw session text, remain held. Snapshot acquisition needs temporary disk space for a full copy in a 0700 directory and 0600 file. Normal close and setup failure remove it; process death can leave it. Legacy bulk checkpoints tied to a separately hashed main file may refuse source_changed and are never silently rebound. This temporary acquisition is not the AM-15 backup feature.

Mechanical packaging reconciliation adds local/corpus-refresh.mjs and its local/corpus-upload.mjs dependency to both existing self-host lists and updates the exact package-content expectation. The existing recursive src/ inclusion already covers src/corpus/refresh.ts. Package scripts still expose only setup in the staged archive. The foreground CLI and its migration/config adapters remain source-tree tools, as before; no installer or caller is activated. The earlier AM-18 archive/install/fixture facts remain historical evidence for their earlier package. No new package/install run is claimed here.

The [integration handoff](/private/tmp/am-f1-adopt-sol-flhnhk49/capsule/HANDOFF.md) and source/mode maps record the exact adopted root, packaging-only delta and future src/api.ts, src/corpus-tools.ts and src/corpus/query.ts three-way merge bases. README and import-verification remain untouched and Terra-owned. No index/ref, commit/push, deployment, real corpus, account, model, native, capture, caller or lifecycle change is included. BothQ remains the ordinary live writer, running and readable; shutdown is excluded.

AM-14 remains incomplete. Terra's one final combined affected flow waits for compatible core/Jira interfaces. The actual CLI subprocess against a server, hosted CPU/storage/FTS/account behavior, real sample/full load, explore, Git/scanner adapters, scheduling, cross-machine acceptance and final backups remain open. Dashboard remains last and backups follow the feature work.
