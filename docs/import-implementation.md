# Import implementation: first slice

Author: Opus (`claude-opus-5-5`), 2026-10-29, on `phase2-capture`, uncommitted. This is the [import vertical](architecture.md#import-vertical-bothq-and-curated-markdown-memory) of the owner priority of 2026-10-29: a read-only export of BothQ and the curated Markdown memory, and a deterministic, staged import plan. Nothing was uploaded, and no server code exists for it yet. BothQ stays the only live system. The export reads the sources and changes none of them.

## What exists

| File | Role |
|---|---|
| `local/migrate/export_bothq.py` | Runs under BothQ's own interpreter and configured driver (`client.get_driver()`, `MemoryConfig.from_env().database`), with a session in `READ` access mode and `execute_read` only. Reads every memory record (labels `MemoryRecord`, `Rule`, `Decision`, `Resource`, `Routine`, `UserMemory`) with all its properties, `BELONGS_TO` anchors, steps and `NEXT`, every other relationship as provenance, its revisions and its requests. Each record is read between two fingerprints (version, content hash, `_updated`, revision count and top, request ids); a record that changed in between is read again, up to 5 times. Membership is listed again afterwards and new records are exported in further rounds. Requests and revisions that point at no record are exported separately. Neo4j temporal values keep their type (`{"$neo4j": "DateTime", "iso": …}`). Legacy identity uses BothQ's own `stable_memory_id` with the scope from `_candidate_scope`'s rules. `--self-test` checks the reread and vanish logic with no database. |
| `local/migrate.mjs` | Node entry point, separate from the capture CLI. It reuses `src/domain/ids.ts` (`canonicalJson`, `requestHash`, `uuid5`, name and scope rules) and `src/domain/redact.ts` directly. Commands: `export`, `plan [--rehearsal test] [--force]`, `verify`, `dry-run`. |
| `local/migrate.test.mjs` | 9 scoped tests: `node --test local/migrate.test.mjs`. |

Outputs go under `~/.agent-memory/migration/`: folders 0700, files 0600, written atomically. Standard output carries counts and hashes only. `review.jsonl` holds record names for the owner; no output file is ever printed.

**Lock.** One migrate run at a time, through `run.lock` created with `wx`. The lock is never reclaimed automatically: a lock left by a crash names its pid, and the owner removes it. This avoids the capture client's open L4 reclaim defect by design.

## Commands

```sh
node local/migrate.mjs export                  # BothQ (read transactions) + Markdown (read) into export-<UTC>-<rand>/
node local/migrate.mjs plan                    # routed plan in <export>/plan/
node local/migrate.mjs plan --rehearsal test   # every record with an identity and no hold, to the test profile
node local/migrate.mjs verify                  # a fresh read of the sources compared with the export
node local/migrate.mjs dry-run [--rehearsal test]   # what an upload would send; no network
```

The default sources are `~/Projects/bot_hq/graph-db` with its `.venv` interpreter, `~/.plaude/projects` and `~/.claude/projects` (each `<project>/memory/**.md`), and `~/.codex/memories` without `.git`. Raw transcripts, rollout JSONL, tool output and the corpus are never read.

## Real read-only run, 2026-10-29

Export `~/.agent-memory/migration/export-20261028T192847Z-c696`, started 2026-10-28T19:28:47Z (00:58 IST).

| Source | Count | Hash |
|---|---|---|
| BothQ records | 1,101 (407 adopted, 694 legacy), none vanished or unstable, 2 membership rounds | `records_sha256` `e8aeee8a…0101`; `records.jsonl` `8e9747c5…97eb` |
| BothQ revisions and requests in the database | 3,755 and 3,182, all linked to records; 0 unlinked; 0 candidates | (research 05 read 3,745 and 3,172 earlier; BothQ writers continue) |
| BothQ steps, supersession links | 114 steps; 8 supersessions | |
| Claude Markdown | 54 paths, 50 distinct files (4 alias paths: `Projects-personal-memory` is a symlink to `Projects-memory`); 13 index and 37 topic files | |
| Codex Markdown | 309 files: `MEMORY.md`, `raw_memories.md`, `memory_summary.md`, 256 rollout summaries, 39 notes, 11 reference candidates (skills and `instructions.md`); 347 `.git` files and 2 non-Markdown files excluded | |
| Named memory files | 348 distinct, 2,872,921 bytes, all UTF-8 (the 11 reference candidates add 44,061 bytes) | `files_sha256` `b1328f1b…12bc` |

These match research 05's inventory exactly for the Markdown and the BothQ record count.

**Reconstruction.** No record had a history or content-hash mismatch. Every adopted record's current content equals the replay of its revisions, its BothQ `content_hash` recomputes to the stored value, and its last revision carries that hash. The largest journal, `72ea0e74-aca8-5e4f-b1d3-3878342b6973`, in the rehearsal plan:
- 7 parts, each within 1,000 rows and 1,000,000 bytes.
- Live text reassembled in the server's read order: 987,013 characters, 987,569 bytes, SHA-256 `e46ec710cfe0c275c295d3445fcd3eb783d3a4169bcf011cebfee5e64f911663`, the same as research 05.
- 664 revisions with snapshots byte-exact, 664 requests with hashes and results byte-exact, 663 entries.
- Kind `journal`, revision 664.

**Routed plan** (`plan/`, commands SHA-256 `e437a51a…a72c`):
- 969 records planned: 755 `work`, 214 `personal`, none to `me`.
- 1,944 commands: 969 stage, 969 finalize and 6 links, in 41 batches.
- Largest part 611 rows and 930,669 cost bytes.

**Rehearsal plan** (`plan-rehearsal-test/`, commands SHA-256 `20b563a8…f607`):
- 1,330 records to `test`.
- 2,679 commands: 1,341 stage, 1,330 finalize and 8 links, in 61 batches.
- Largest part 1,000 rows and 999,929 cost bytes. 0 over-budget parts.

**Review list** of the routed plan, 491 entries, none planned. An entry can carry more than one reason, so the counts below add up to more than 491.

| Reason | Count | Meaning |
|---|---:|---|
| `unrouted_scope` | 224 | A BothQ scope with no profile rule (`bot_hq` is mixed; `default`, `apps`, `ai-internal`), or a legacy record anchored only to Bot HQ |
| `unrouted_path` | 168 | Codex global files, and Claude or Codex sources whose folder is not a git checkout with a routed remote (`~/Projects/apps`, `packages` and `sequioa` are workspace folders) |
| `missing_scope` | 92 | Legacy records with no scope and no anchor: no id is assigned until the owner decides |
| `needs_redaction` | 27 | 26 legacy BothQ records (written before BothQ redacted at write time; BothQ's own redactor changes them too) and 1 Claude file. The text is held: a redacted copy is in `plan/holds/` (0600), and nothing of it is planned |
| `reference_candidate` | 11 | Codex skills and instructions; reference documents, never preferences |

`verify` right after the export: Markdown 0 changed, 0 added, 0 vanished; BothQ 1 record changed (a live BothQ write), 0 added, 0 vanished.

## Normalization rules

- **Ids.** Adopted records keep `memory_id`. Legacy records take BothQ's `stable_memory_id(scope, type, name)`, or none (review). Markdown files take `uuid5("markdown:" + real path)` with the BothQ namespace.
- **Text.** Body chunks of at most 16,000 characters, never splitting a surrogate pair. Every BothQ append is an entry row with its revision, ordinal, original date and request id. The separator is the one BothQ actually used (empty on an empty journal) and sits on chunk 0. Entries before the latest save or update are kept, not live. A legacy record whose `content` is empty uses its `rule` and records `content_from: "rule"`. A `rule` that differs from `content` is kept in provenance.
- **History.** Every BothQ revision is one row with its original operation, `snapshot_json` and `delta_json` strings byte for byte, its date, request id, platform and content hash. A record without history (legacy, Markdown) gets one `legacy_snapshot` revision.
- **Requests.** Original `request_id`, `operation` (as `legacy_op`), `request_hash` (as `legacy_hash`), `result` string, dates, and any other property. BothQ never stored request arguments, so no payload is reconstructed or invented. The replay hash rule is pinned by BothQ-computed fixtures in the tests.
- **Dates.** `valid_from` is the date of the latest save, update or append whose content hash is the current one. Legacy records and Markdown files have `valid_from` null, `attrs.validity = "unknown"`, and their creation or file date only as `attrs.first_recorded_at`. A legacy `_valid_from` stays a source property.
- **Kinds.** `feedback` → rule, `user` → preference, `reference` and `procedural` → document. `project` → journal when it has appends or no `why`, else decision. Claude topic files take their front-matter `type`; everything else is a reference document.
- **Routing.**
  - BothQ: scopes `sequoia` and `sequioa` → `work`; `personal`, `personal/*` and `bettergit` → `personal`; everything else goes to review.
  - Markdown: the project folder (Claude) or the `cwd:` header (Codex rollout summaries) leads to the checkout's origin remote. An SSH host alias is resolved through `ssh -G`, read only. The remote is then matched against the Worker's `ROUTING_DEFAULTS`.
  - `me` is never chosen automatically.
- **Identity checks.** A duplicate id, or two active records with one profile, scope, type and name, go to review (`identity_conflict`). Equal bytes under different real paths are kept as separate records and flagged `duplicate_content`.
- **Provenance** on every node (`attrs.source`): system, element id, labels, every unmapped property, anchors, relationships, raw steps and fingerprint, or, for Markdown, every path, real path, SHA-256, size and dates.

## Server contract needed: staged `/v1/import`

The server does not exist yet. The plan's commands are its input. Each command runs in its own transaction, within at most 1,000 rows and 1,000,000 UTF-8 bytes, counting index rows and bytes.

The plan's cost model:
- A text row costs 3 rows and 3 times its JSON bytes (the row plus its full-text and trigram index rows).
- A request costs 2 rows and twice its bytes (the row plus its `AccountStore` binding).
- A revision costs 1 row and its bytes.
- Each part adds 10 rows and 8 KB of overhead.

Batches are at most 50 commands and 1,000,000 bytes of JSON.

| Command | Fields | Server behavior |
|---|---|---|
| `stage` | `record_id`, `record_sha256`, `profile`, `part`, `parts`, `rows {texts, revisions, requests}`, `cost`, `part_id` (`<record>:<record sha prefix>:<n>`), `sha256` | Store the rows under the record with node status `incoming`, invisible to every read and to replay. The same `part_id` and hash replays; the same id with another hash is refused. |
| `finalize` | `record_id`, `record_sha256`, `profile`, `node`, `parts [{part_id, sha256}]`, `request_ids`, `sha256` | In one transaction: check that every listed part is stored with its hash, write the node row (origin `import`), its head and card, make it visible, and mark the embedding due. Bind `request_ids` in `AccountStore.request_index` to the profile. Nothing of a record is visible before this. |
| `link` | `src`, `rel: "supersedes"`, `dst`, `basis: "identifier"`, `profile`, `sha256` | Write the edge once both nodes are finalized. |

Schema and code the server needs, not built yet:
- `revisions.op` allows `appended`, `legacy_adopted` and `legacy_snapshot`, and stores `delta`, `revision_id`, `source_platform` and `source_platform_version`.
- `requests` stores `legacy_op`, `legacy_hash`, `result` and `completed_at`.
- A staging ledger of parts per record.
- `nodes.status = 'incoming'` for staged records (the value exists).
- An `import` scope check and actor `migration`.
- Legacy replay in both `AccountStore` and the profile: a call whose `request_id` has an imported request is checked with BothQ's hash before the modern hash can refuse it (architecture section 16).
- Timestamps arrive as Neo4j ISO strings with nanoseconds (for example `2026-10-18T03:07:44.658902000+00:00`).

## Not proved, and gates still open

- No server import, upload, staged finalization, legacy replay on the server, or hosted verification 1, 2 and 5 to 8 exists yet. These are the next vertical, after the owner's checkpoint.
- The owner reviews the review list and holds before any copy into `work` or `personal`. A copy into `test` comes first.
- The 30 golden queries (verification 4) wait for the owner's choice.
- The export is consistent per record, not a global snapshot: BothQ keeps writing. A refresh and reconcile from a fresh export comes before cutover.
- The `ssh -G` alias lookup has no automated test. It reads the local SSH configuration only.
- Distillation, session digests and the corpus are not part of this slice. Backup and restore stay in the final stage, and cross-machine parity in the final rehearsal.
- An earlier private probe export from this session is still at `~/.agent-memory/migration/probe-20261028T192230Z/` (0700). It is kept, not deleted.

## Checks

| Command | Result |
|---|---|
| `node --test local/migrate.test.mjs` | 9 tests pass |
| `python3 local/migrate/export_bothq.py --self-test` | ok (also run by the tests) |
| `node local/migrate.mjs dry-run` and `dry-run --rehearsal test` | 0 over-budget parts; network none |

The tests cover:
- Request hash, content hash, canonical JSON and `stable_memory_id` against BothQ-computed fixtures.
- Exporter reread and vanish handling.
- A huge journal: parts within budget, byte-exact live text, separators, history entries, chunked entries, a surrogate pair at a cut, byte-exact revisions and requests, and `valid_from`.
- Legacy rules, missing and unrouted scopes, the redaction hold kept private and never printed, identity conflicts, determinism and resume, and the lock that is never reclaimed.
- Markdown aliases, categories, routing by remote and byte-exact bodies; `verify` detecting a rewritten file.
