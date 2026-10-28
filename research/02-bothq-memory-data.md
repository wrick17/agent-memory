# BothQ stored memory analysis

Source: Sol (gpt-6.1-sol, high) read-only graph analysis, 2026-10-28. Concurrent writers changed totals slightly during inspection.

BothQ is primarily a text memory store with large rolling journals. The engineering corpus accounts for most graph entities, but memory records have almost no direct links into it.

## 1. Inventory

| Type | Adopted (MemoryRecord) | Legacy | Total |
|---|---:|---:|---:|
| project (Decision) | 349 | 522 | 871 |
| feedback (Rule) | 39 | 93 | 132 |
| reference (Resource) | 12 | 60 | 72 |
| procedural (Routine) | 2 | 19 | 21 |
| user (UserMemory) | 0 | 0 | 0 |
| Total | 402 | 694 | 1,096 |

- Adopted status: 394 active, 8 superseded, 0 retired, 0 candidates. Legacy: no unified status (662 lack status and end date, 13 have `_valid_until`).
- Content chars: total 5,464,046; p50 1,933; p90 8,060; p99 52,179; max 987,013. Adopted 3.83M, legacy 1.63M.
- Revisions per adopted record: p50 3, p90 16, p99 70, max 664. Revision JSON 7.77M chars.
- MemoryRevision 3,578; MemoryRequest 3,006.

## 2. Journals

- 706 journal memories (385 legacy, 321 adopted) hold 5,161,966 chars, 94.5% of all memory content.
- By runtime name: codex 601, claude-code 51, claude 1, missing/malformed 53. Range Aug 14 to Oct 28, 2026.
- Types: 695 project, 5 reference, 6 procedural (project-only queries miss some).
- Adopted journal history: 3,445 revisions (2,757 appends, 367 updates). Appends per journal p50 2, p90 17, p99 75, max 663.
- Adopted journals grew 13.7x from revision 1 (272,653 chars to 3,737,524). Largest is a BetterGit journal, 987,013 chars, 664 revisions. All 48 memories over 16,000 chars and all 12 over 50,000 are journals.
- Only about 10 journals (1.4%) mention promoting reusable knowledge. No structured journal-to-memory promotion lineage.
- Zero `session-checkpoint-*` memories exist.

## 3. Guidance and provenance

| Type | Themes | Agent-written | Other |
|---|---|---:|---|
| feedback | Account routing, approvals, browser boundaries, testing, reporting, preserving live state | 58 | 49 file imports, 25 unattributed |
| reference | Architecture contracts, repo maps, corpus coverage, access diagnostics | 57 | 2 file imports, 11 seed-like, 2 unattributed |
| procedural | Feature delivery, reviews, debugging, releases, corpus queries | 15 | 6 seed-like routines |
| user | None. Neither Person has memory_content. | 0 | |

Source platforms: 907 codex-mcp-client, 1 codex, 62 claude-code, 126 missing. All records have `_created`, `_updated`, `_valid_from`.

## 4. Relationships

| Relationship touching memories | Count | Meaning |
|---|---:|---|
| BELONGS_TO | 1,004 | Scope or legacy workplace/system ownership |
| HAS_REVISION / LATEST_REVISION | 3,578 / 402 | History |
| HAS_STEP | 114 | Routine steps |
| APPLIES_IN | 28 | Module, system, agent links |
| SCOPED_TO | 22 | Product context |
| SUPERSEDES | 8 | Replacement guidance |
| MITIGATED_BY | 5 | Failure modes to rules |
| ACHIEVED_BY / DOCUMENTED_BY | 3 / 1 | Journeys to routines; service docs |

- Zero direct memory links to Ticket, Repository, Person, ChangeSet, ReleaseTrain, Corpus*. 389 of 402 adopted memories have only scope/history connections.
- Recall today is full-text plus substring; vectors disabled; zero embeddings stored.

## 5. Scopes

| Scope | Active F/P/R/Pr | Superseded | Chars | Journals |
|---|---|---:|---:|---:|
| sequoia | 27/243/7/1 | 6 | 2,092,210 | 229 |
| bot_hq | 8/34/3/1 | 2 | 1,182,585 | 32 |
| personal | 2/18/0/0 | 0 | 104,288 | 13 |
| personal/bettergit | 2/31/0/0 | 0 | 356,688 | 31 |
| personal/dotfiles | 0/9/0/0 | 0 | 54,824 | 9 |
| bettergit | 0/3/0/0 | 0 | 21,354 | 3 |
| sequioa (typo) | 0/2/0/0 | 0 | 2,532 | 1 |
| ai-internal | 0/1/0/0 | 0 | 9,333 | 1 |
| apps | 0/1/0/0 | 0 | 1,196 | 1 |
| default | 0/1/0/0 | 0 | 3,851 | 1 |
| missing (legacy) | 694 records | | 1,633,796 | 385 |

Legacy anchors recover 430 sequoia and 172 bot_hq assignments, leaving 92 unassigned. Work totals about 717 records / 3.17M chars. Explicit personal about 65 / 537k, understated because large BetterGit journals sit under `bot_hq`. Scope does not reliably equal profile; migration needs reclassification.

## 6. Activity

| Created | project | feedback | reference | procedural | Platform |
|---|---:|---:|---:|---:|---|
| May | 31 | 73 | 15 | 6 | 125 unknown |
| August | 394 | 21 | 43 | 12 | 469 Codex |
| September | 198 | 10 | 7 | 2 | 213 Codex, 4 Claude |
| October to 28th | 248 | 28 | 7 | 1 | 226 Codex, 58 Claude |

- Last 30 days: 299 creations, 303 updated records, 2,963 revisions, about 99 writes/day.
- Requests: 2,767 append, 211 save, 28 update. Append dominates.

## 7. Non-memory graph and quality

- ChangeSets (6,781), repos (87), release trains (35) and 6,619 of 6,667 tickets share an Aug 12 corpus import; only 32 tickets carry live Jira sync metadata.
- 69 isolated legacy memory nodes; 694 lack literal scope; one exact-content duplicate pair; 16 repeated task-name families across 33 records; 66 empty `content` fields (50 rules keep text in a `rule` field); zero embeddings; malformed journal names and inconsistent types.

## Implications

Must handle: about 1,100 memories and 5.5M chars, append-heavy growth near 100 writes/day, million-char journals, stable ids, legacy shapes, delta revisions, idempotency, concurrent updates, supersession, scoped lexical retrieval with passages, history pagination, structured routines, provenance.

Can drop or leave local: the engineering corpus and its sync graph; embeddings initially; general graph traversal (keep scope, history, supersession, routine steps).
