# Import refresh and conflict path

**Implemented 2026-10-29 as profile schema v5, with Workers and local tests; not deployed** ([import implementation](import-implementation.md#import-refresh-schema-v5-2026-10-29)). Sol began the implementation from this design while Opus was believed to be limited. Opus, the import's author, finished it in the same root. Where it differs from the text below:
- **Anchors:** the base anchor is stored on `import_records` and `import_refreshes` (`published_revision`, `published_content_hash`). v5 fills it for existing published records from their imported revisions, never from the hosted node.
- **Prepare and publish:** both check the finalize command's own hash (`finalize_sha256`), and publish updates the node row in place.
- **Planner:** `records.jsonl` beside each plan is the next refresh's base. A link the base already made is not sent again. A split's last step carries the fresh export's final metadata, so no metadata-only refresh follows it.

The original draft follows.

**Draft, 2026-10-29.** Opus (`claude-opus-5-5`), the import's author, wrote it in the same context, while Terra runs the combined check and rehearsal against the 55-file cleared freeze (`/tmp/agent-memory-import-cleared-freeze-20261029T0445.json`, unchanged). It extends the import of [docs/import-implementation.md](import-implementation.md) and [architecture section 16](architecture.md#the-staged-import-protocol). Coding starts after the rehearsal releases the code.

## The problem

The first copy is made while BothQ keeps changing, and cutover needs a fresh export reconciled into it. Today a record that changed since its copy is refused: `stage` and `prepare` return `record_changed` (`src/profile/import.ts:74, 112`), and `publish` only inserts a node that does not exist yet (`:138, 150`). So the hosted copy can only stay at its first state.

The refresh must:
- keep the imported revisions, requests, results, dates, provenance and ids exactly;
- add what BothQ added after the copy;
- never overwrite an agent's write to the hosted copy;
- stay invisible until complete, resumable, and inside the 1,000-row and 1,000,000-byte budget.

Dual writes stay excluded. At cutover BothQ is frozen before the final refresh, so the refresh never races BothQ itself.

## Decisions

1. **Fast-forward only, automatically.** A record is refreshed without review only when two things hold:
   - its new BothQ history is the old one plus revisions added after it, byte for byte;
   - the hosted copy is exactly as the import published it.

   Everything else is held, never merged and never deleted.
2. **The planner holds the comparison base; the server checks it.** The refresh planner compares the fresh export with the export whose plan was uploaded. Each refresh command carries its base:
   - the record hash it extends;
   - the hosted revision and content hash that base published.

   The server refuses if the profile no longer matches. No new read endpoint is needed.
3. **Staged under a shadow id, published by re-keying.**
   - A refresh's rows are staged under `<record id>#r<n>`, an id with no node, so every read path already ignores them.
   - Publication re-keys them onto the record and updates the node in one transaction, which makes the step visible at once.
   - The existing read paths, which join or filter on the node id, need no change.
4. **Large deltas become consecutive refreshes.** BothQ history only grows, so a delta that one publish cannot hold within the budget is split into consecutive refreshes. Each publishes a prefix of the new revisions, so every intermediate hosted state is a state BothQ really had.
5. **The same request protection as the first copy.**
   - New request ids are reserved account-wide before their part is staged (`reserveImport`).
   - They are bound before publication (`bindImport`).
   - They answer `busy` until publication. They then replay by BothQ's own hash.

## Cases

"Hosted unchanged" means the hosted node still has the revision and content hash the base published. Every hosted write (save, update, append, retire, supersede) raises the revision, so a changed revision always means an agent wrote.

| Case | How the planner sees it | Action |
|---|---|---|
| Unchanged | Same record hash as the base | Nothing |
| BothQ advanced, hosted unchanged | Every base revision byte-identical; new revisions after the base's top; the same profile route | **Automatic fast-forward**: new revisions, entries and requests; node to the new BothQ state |
| BothQ retired or superseded the record | A new `retired` or `superseded` revision, as above | Automatic fast-forward. The node takes BothQ's status and `valid_to`; a new `SUPERSEDES` relation adds an existing `link` command |
| Legacy record adopted in BothQ | Base had our synthetic `legacy_snapshot` at revision `_version`; BothQ now has `legacy_adopted` at the same number (BothQ `graph-db/memory_store.py:532`, `_adopt_legacy`, uses `max(1, _version)`), with unchanged content | Automatic. The genuine `legacy_adopted` row replaces our synthetic one in the same publish, then later revisions fast-forward. The synthetic row was derived by us, so this loses nothing |
| BothQ advanced, hosted changed | As fast-forward, but the server finds another hosted revision | **Hold, `hosted_changed`.** The hosted copy is never touched; the staged delta stays invisible |
| BothQ history rewritten | A base revision's bytes differ or a revision vanished | **Hold, `history_rewritten`** |
| BothQ record vanished | Element id or memory id absent from the fresh export | **Hold, `source_vanished`**; nothing is deleted or retired |
| Route changed | The record now routes to another profile, or into review | **Hold, `route_changed`**: moving across profiles is a transfer, not built |
| New BothQ record or newly resolved hold | Not in the base plan | The normal first copy |
| Markdown changed, hosted unchanged | Same real path, new SHA-256, no new hold | **Automatic fast-forward**: revision 2, a new `legacy_snapshot` with the new path, hash and size; new body rows; old body rows kept as history (`live = 0`), so the old text stays in the store |
| Markdown paths changed only | Same real path and SHA-256; aliases added or removed | Automatic provenance update: `attrs.source.paths` with no new revision |
| Markdown file vanished | Real path absent | Hold, `source_vanished`. A new file with the same SHA-256 is flagged `possible_rename_of`; neither is retired automatically |
| A record staged but never published under the base | In the base plan, not finished | Finish the base upload first, then refresh. Staged parts are immutable; none is discarded |

Every refreshed record goes through the same holds as a first copy: redaction, personal fields, ambiguous or unrouted paths and oversize. A record that newly needs one is held.

## Anchors and identity

- **Import identity.** The record id (BothQ `memory_id`, BothQ's stable id for a legacy record, or `uuid5("markdown:" + real path)`) never changes. A refresh is `(record id, refresh number n)`, with `n` counting from 1 per record.
- **Comparison anchors.** Each comes from the base plan, so they are observable without reading the server:
  - the base record hash: the first copy's `record_sha256`, or the last published refresh's;
  - the base top source revision, BothQ revision ids and revision content hashes;
  - the base request ids;
  - the base published node revision and content hash;
  - the base largest entry `seq_no` and body revision.

  The server checks the record hash against `import_records` or the latest published refresh, and the node revision and content hash against the current node.
- **Refresh record hash** is `sha256(canonicalJson({ profile, node, base_record_sha256, refresh: n, parts }))`. Its part ids are `<record>#r<n>:<hash prefix>:<part>`. Same bytes replay; changed bytes are refused, as for first copies.

## Protocol

Commands extend the existing `stage` and `finalize`, with one new optional field. There is no new command or endpoint.

```text
stage    { …existing…, refresh?: { no, base_record_sha256 } }
finalize { …existing…, refresh?: { no, base_record_sha256, base_revision, base_content_hash, body_revision? } }
link     unchanged
```

1. **Stage** (refresh).
   - `reserveImport` for the part's new request ids, as now.
   - The profile then checks: the record is published; its latest published hash equals `base_record_sha256`; this refresh is not already published.
   - It stages the delta rows under the shadow id: new revisions with their BothQ numbers, new entries with continuing `seq_no` and final `live` values, new body chunks, new requests.
   - It records the part in `import_parts` and the refresh in `import_refreshes` (state `staging`).
   - Live staged text enters the full-text indexes at insert, as today, but lexical recall joins through `nodes` (`src/profile/read.ts:110`), which has no row for the shadow id, so nothing is found.
2. **Prepare** (refresh). In one transaction it checks:
   - every part is staged with its hash;
   - the node is unchanged (`revision = base_revision`, `content_hash = base_content_hash`), else `hosted_changed`;
   - the staged revision numbers are all above the node's;
   - entry `seq_no` values continue the node's;
   - the staged requests equal the listed ones.

   It then marks the refresh `prepared` with its node hash and returns the requests to bind.
3. **Bind.** `bindImport` turns the reservations into bindings, at most 400 per call, as now.
4. **Publish** (refresh). One transaction:
   - Re-check the node is unchanged, else `hosted_changed`.
   - Re-key the shadow rows onto the record id, stamped with the new `seq`.
   - If `body_revision` is set: mark the older body rows and live entries `live = 0`, as `writeBody` does, but keep them.
   - Replace a synthetic `legacy_snapshot` row for the adoption case.
   - Update the node:
     - revision, content hash, characters and status;
     - `valid_to` and `ended_at`;
     - `updated_at` and source platform;
     - `attrs.source`;
     - the head rows and the card.
   - Mark the embedding due if the card changed.
   - Write one activity row; mark the refresh `published`.
5. **Link.** Unchanged: a new supersession between two different published memories of the profile.

**Visibility before publish.** Shadow rows have no node, so `get` (with history and retired), name lookup, inventory, full-text, trigram and vector channels cannot see them. In `runWrite`'s replay lookup (`src/profile/write.ts:578`), a request whose `node_id` is the shadow id of an unpublished refresh answers `busy`. `AccountStore` answers `busy` earlier, from the pending reservation.

**Conflict without blocking agents.** No write fence is added. An agent may write to the hosted copy at any time; that raises the revision, and the refresh's prepare or publish refuses with `hosted_changed`. Its staged rows stay invisible under the shadow id, and its reserved request ids keep answering `busy`. They are BothQ's ids, so nothing else should hold them.

**Budget.** Publish counts what it really writes, as every import step does.
- Re-keying writes about 5 rows per text row (the row, its node and sequence indexes) and about 4 per revision or request.
- Live text needs no new full-text rows, since only `node_id` changes.
- Each flip of an older row to `live = 0` writes about 5.
- The node, head and activity rows add about 40.

So one publish holds roughly 60 to 70 BothQ appends. The planner splits larger deltas into consecutive refreshes with the shared `publishCost`, calibrated by a test as `ROW_COST` was. The server rolls back an over-budget publish whole, and the planner then splits finer. A body reset on a journal with more live entries than one publish can flip is held as `oversize_refresh`; hosted `writeBody` has the same 1,000-row ceiling today.

**Freshness and privacy.**
- The node's card is recomputed after the re-key from `readPrefix`. An active record whose card changed is marked due and embedded by the alarm, as at first publish.
- Redaction and the personal-field rule run on every refresh command at the planner and the server, as now.

## Crash and retry

| Point | State left | Retry with the same commands |
|---|---|---|
| After reservation, before stage | Pending request ids, nothing staged | Reservation kept; stage stores |
| After stage, response lost | Part staged under the shadow id | Stage replays (same part id and hash) |
| After prepare | Refresh `prepared` | Prepare returns `prepared`; bind and publish continue |
| After some bind batches | Some bindings final, others pending | Identical bindings kept; the rest bind |
| After publish, response lost | Refresh `published`, node at the new revision | Prepare and publish answer `replayed` |
| An agent writes between steps | Node revision changed | Prepare or publish refuses `hosted_changed`; the step stays invisible |
| Step k of a split delta refused | Steps 1 to k-1 published | Later steps refuse on their base; the record is held at step k-1, a true BothQ state |

## Files and changes

| File | Change |
|---|---|
| `src/profile/schema.ts` | **v4** (v3 is deployed by the rehearsal and must not change): `import_refreshes (shadow_id PK, record_id, refresh_no, base_record_sha256, record_sha256, parts, state CHECK staging/prepared/published, node_sha256, staged_at, published_at, seq)`, `UNIQUE (record_id, refresh_no)`, a sequence index and tombstone triggers. `import_parts.record_id` holds the shadow id for refresh parts. |
| `src/profile/import.ts` | `stage`, `prepare` and `publish` take the refresh field: the base checks above, staging under the shadow id, re-keying, node update, live flips, adoption replacement. Shared helpers stay; about 120 lines. |
| `src/profile/write.ts` | The replay lookup also joins `import_refreshes` on `shadow_id`: unpublished means `busy`. One query. |
| `src/api.ts` | Optional `refresh` on `stage` and `finalize` in the zod schema; the hash and part-id checks include it; the same reservation and binding calls. |
| `src/domain/import-cost.ts` | `refreshPublishCost(rows, flips)` with measured constants. |
| `local/migrate.mjs` | `plan --refresh-from <base export>`: classifies every record against the base export and its plan, emits refresh commands for fast-forwards, splits by `refreshPublishCost`, and lists holds with the reasons above. It requires the base plan's upload state to be `done`. |
| `local/upload.mjs` | Unchanged: refresh commands are commands, in order. |
| `docs/architecture.md` §16, `docs/import-implementation.md`, `docs/feature-manifest.md` AM-17 | Record the design once implemented. |

## Regressions

Each test below builds its fixture with the existing helpers in `test/import.test.ts` and `local/migrate.test.mjs`.

| Test | Today | After |
|---|---|---|
| Journal fast-forward: base of 3 revisions published; BothQ adds 2 appends with 2 requests | Stage refused `record_changed`; the hosted copy stays at 3 revisions | Content equals BothQ's; all 5 revisions byte-exact; the new requests replay by BothQ hash; full-text finds the new text; the card is due and then embedded |
| Hosted write after publish, then refresh | (no refresh path) | `hosted_changed`; the hosted content, revision and history unchanged; the staged delta invisible; its request ids `busy` |
| Visibility: refresh staged and prepared, not published | n/a | `get` with history, recall and inventory show the base state only; after publish, the new state |
| Crash points (table above) | n/a | Each retry ends published once, with no duplicate row or binding |
| Body reset (BothQ `updated` on a journal) | n/a | Old body and entries `live = 0` and still in the store; content equals the update; an over-budget reset is held `oversize_refresh`, not partly applied |
| Markdown changed | n/a | Revision 2; old body rows kept with `live = 0`; old text no longer found, new text found |
| Legacy adoption | n/a | The synthetic `legacy_snapshot` row is replaced by BothQ's `legacy_adopted` bytes; a later append fast-forwards |
| History rewritten, source vanished, route changed | n/a | Held with their reasons; nothing staged, retired or deleted |
| Split delta: 200 appends | n/a | Consecutive refreshes, each within the budget; each intermediate content equals BothQ's content at that revision |
| Planner without a finished base upload | n/a | Refused with a message to finish the base upload |

## What needs the owner

Under the decisions already made, everything automatic above is in scope:
- the non-deleting ingest;
- no dual writes;
- never overwriting hosted writes;
- BothQ frozen before the final refresh at cutover.

No new decision is needed to build this. Held records go to the existing review list, and a decision is needed only for those that cannot be resolved from evidence:
- `hosted_changed`: keep the hosted copy, or take BothQ's state;
- `source_vanished` and `possible_rename_of`: keep, retire or link;
- `route_changed`: wait for transfers, or keep both copies.

Before cutover, hosted `work` and `personal` copies take no ordinary agent writes, so `hosted_changed` should come only from owner or test writes.

## Known limits

- Markdown's older text stays in the store as `live = 0` body rows. `get_memory` history shows its revision snapshots, not its old text.
- Reserved request ids of a refresh that is refused for good keep answering `busy`. They are BothQ's ids, so this is fail-safe.
- A body reset on a very large journal is held, not applied in steps. Applying it in steps would expose a state BothQ never had.
- The design rests on code reads and on BothQ's append-only revisions (`memory_store._write_revision` and `_adopt_legacy`). Nothing here has been run; the cost constants need the same calibration test as the first copy's.
