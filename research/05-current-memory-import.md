# Current memory import handoff

Read-only Sol research, 2026-10-29 IST, against requirements, research 01/02, architecture 5/16/22, BothQ contracts and committed `6ab2380`. Concurrent capture fixes are not treated as settled interfaces. BothQ remains the sole live system.

## Current inventory

The private read ran **2026-10-28 18:57:13–15 UTC**, or October 29 00:27 IST.

| BothQ | Adopted | Legacy | Total |
|---|---:|---:|---:|
| Project | 354 | 522 | 876 |
| Feedback | 39 | 93 | 132 |
| Reference | 12 | 60 | 72 |
| Procedural | 2 | 19 | 21 |
| All | 407 | 694 | 1,101 |

There are 3,745 revisions, 3,172 completed requests, 114 routine steps, eight supersession links, and no user memories or candidates. Adopted statuses are 399 active and eight superseded; 13 legacy records have an end date. Fallback content totals 5,655,609 characters. Forty-nine legacy records need nonempty `rule` when `content` is absent or empty.

Actual Claude directories follow. Each suffix is under `<root>/projects/-Users-pratyush-poddar-<suffix>/memory/`; counts include index and topic Markdown.

| Root | Suffix | Files | Bytes |
|---|---|---:|---:|
| `~/.plaude` | `Projects-apps` | 2 | 1,007 |
| `~/.plaude` | `Projects-memory` | 4 | 4,111 |
| `~/.plaude` | `Projects-personal-memory` | 4 | 4,111 |
| `~/.plaude` | `Projects-personal-bettergit` | 11 | 40,000 |
| `~/.plaude` | `dotfiles` | 4 | 10,418 |
| `~/.claude` | `Projects-aggregator` | 1 | 413 |
| `~/.claude` | `Projects-apps` | 6 | 7,925 |
| `~/.claude` | `Projects-bot-hq` | 2 | 1,346 |
| `~/.claude` | `Projects-mfe` | 2 | 4,056 |
| `~/.claude` | `Projects-packages` | 6 | 6,709 |
| `~/.claude` | `Projects-peopleloop-pl` | 3 | 3,090 |
| `~/.claude` | `Projects-platform-packages-packages` | 2 | 944 |
| `~/.claude` | `Projects-sequioa` | 3 | 2,781 |
| `~/.claude` | `Projects-sequoia-adminshell` | 4 | 3,773 |

Total: 54 paths, 90,684 bytes. Four `Projects-personal-memory` paths alias `Projects-memory`; retain both paths, import once.

Under `~/.codex/memories/`:

| Source | Files | Bytes |
|---|---:|---:|
| `MEMORY.md` | 1 | 440,486 |
| `raw_memories.md`, curated summaries despite its name | 1 | 1,087,424 |
| `memory_summary.md`, derived index | 1 | 5,215 |
| `rollout_summaries/*.md` | 256 | 1,196,965 |
| `extensions/ad_hoc/notes/*.md` | 39 | 56,258 |
| `skills/*/SKILL.md` and `extensions/ad_hoc/instructions.md` | 11 | 44,061 |

Of 658 files, 347 are `.git` files; **309 are Markdown**. Classify the last eleven separately. Named memory categories plus Claude comprise 348 distinct files, 2,872,921 bytes, all UTF-8 without BOM/CRLF. BothQ's redactor changes one Claude file: retain locally for review, never silently rewrite. Preserve index/summary provenance without promoting repeated mentions. Raw JSONL, conversation/tool logs and corpus were excluded.

Private mode-0600 metadata manifests contain paths, sizes, hashes, and per-record revision/request digests, no memory text:

- `/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/memory-import-metadata-8tjreowi.json`
- `/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/bothq-memory-metadata-e03gf7k2.json`

## Export and mapping

Connected get/history/recall/list/rule/routine/graph tools cannot export losslessly: list filters inactive/seeded records, recall returns passages, public get cannot request retired records, history omits request results. `bot_hq/scripts/export_snapshot.py` excludes records, scans the engineering graph and writes bootstrap Cypher; unsuitable for migration.

Use configured `client.get_driver()`/`MemoryConfig` privately with read transactions. Select memory roots, revisions, requests, steps/NEXT, anchors and relationship properties. Keep non-memory endpoints as provenance references. Preserve original JSON strings/hashes before normalization.

| Source fields | Hosted representation |
|---|---|
| `memory_id`, type, name, scope, text fields, status, `_version`, platform/date fields | `nodes`, chunked `texts`, and source provenance; preserve ID and revision |
| `revision`, `operation`, `snapshot_json`, `_created`, request/platform/hash fields | Historical `revisions`; retain original operation and snapshot |
| `delta_json.content/separator` | Ordered `texts.part='entry'`, original revision/date/request; separator only on first chunk |
| `request_id/operation/request_hash/result/memory_id/_created/_completed` | `requests`, original result, `legacy_op/legacy_hash`, account request binding |
| HAS_STEP/order/action/success_criteria, NEXT, supersession, extra properties | Ordered steps, relationships and source provenance; do not discard legacy fields |
| Markdown bytes/path/hash/header positions | Import-origin document/body chunks and evidence; stable source identity, version hash |

Updates replace current bodies and deactivate earlier entries; history survives. Legacy records get one `legacy_snapshot`. Missing validity stays null with `attrs.validity='unknown'`; creation/file dates are provenance only. Preserve original full-content hashes separately from hosted append chain hashes.

Use Python `stable_memory_id(scope,type,name)`: 602 legacy IDs are computable without collisions; 92 lack scope and need review before ID assignment. Routing proposal: 721 work candidates, 65 explicitly personal, 315 requiring review. Scope is a hint; `bot_hq` includes personal projects. Preserve `sequioa` provenance while routing confirmed work. `me` accepts only explicit company-free preferences.

## Smallest implementation and checks

Reuse `domain/ids.ts`, chunk readers, transaction budgets, migrations/sequence stamps, account indexes, guards, FTS and embedding alarms. `6ab2380` lacks `/v1/import`, CLI/state, review storage and legacy replay. Ordinary save rewrites IDs/dates and rejects large bodies; revision CHECK lacks `legacy_snapshot`/`legacy_adopted`. Add import through `ProfileStore`. Both account/profile replay must recognize legacy hashes before modern hashes reject them. BothQ hashes sorted compact UTF-8 JSON after redaction, excluding only `request_id`.

Implement export/manifest, bounded import parts/finalization, then replay checks. Use deterministic part IDs/hashes and durable cursors. Fifty commands remains bounded by **1,000 rows/1,000,000 UTF-8 bytes**, including metadata/index work. Split source envelopes, which reach 1,980,750 bytes because `rule` duplicates `content`. `raw_memories.md` also exceeds one request.

The largest journal, `72ea0e74-aca8-5e4f-b1d3-3878342b6973`, has 987,013 characters, 987,569 bytes, 664 revisions, 663 appends and 664 requests. Its history is 1,595,845 bytes, requiring multiple transactions. All adopted histories reconstructed without text/hash mismatch. Normal read helpers returned all 664 revisions across seven pages. Complete-text SHA-256 is `e46ec710cfe0c275c295d3445fcd3eb783d3a4169bcf011cebfee5e64f911663`. Hosted complete reads require following every content cursor.

Verify per-record revision/request counts/hashes, Markdown bytes, inactive history, separators, interrupted resume and unchanged reruns. Requests contain **no original arguments**; hashes/results cannot reconstruct exact payloads. Test known original payload fixtures; report unavailable historical payloads honestly.

Root fingerprints matched before/after this read, without a global snapshot guarantee. Writers continue. Recheck versions/hashes, revision/request membership and file stat/hashes; retry changed records, reconcile additions. Live-database hashes may legitimately change. Final refresh, backup/restore/recovery tests and cross-machine parity remain pre-cutover gates. No import, backup, deployment, source/native-memory mutation or writer lock occurred.
