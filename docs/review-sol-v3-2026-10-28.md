# Agent Memory v3 closure review

Sol, 2026-10-28. One bounded independent re-check, without subagents.

Reviewed `docs/architecture.md`, 2,015 lines / 200,420 bytes.
SHA256 `72880a8c5a239eca636a082e0d88ae12f3e99f8f68f1801b3234c7e780cafedd`.
Evidence includes the v2 review, updated requirements, recursive instructions and targeted official documentation. All architecture references below use this pinned artifact.

## Verdict

Withhold presentation as the finished approvable plan. No P0. Six concrete correction gaps remain. These need protocol or gate changes, not additional owner decisions.

## F1-F10 closure

"Closed" means specified in the design, subject to later implementation tests.

| Finding | Disposition and exact v3 evidence |
|---|---|
| F1 confinement | Partial. §12, lines 1221-1274; §22, 1831-1833. Safe skip exists, but probe errors can falsely authorize execution. |
| F2 transfer into `me` | Closed. §9, 1008-1014 fences first, binds revision/hash, validates twice and aborts/unfences. Gate 1838-1839. |
| F3 exports | Partial. §5, 618 and 754-757 fixes reinsertion. §18, 1557-1564 still skips sequence ties. |
| F4 joint recovery | Partial. §18, 1570-1585 closes traffic, rebuilds indices and disables restored grants; one ordinary transfer state is uncovered. |
| F5 migration replay/history | Closed. §16, 1402-1416 imports operations/hashes/results and revisions separately; comparisons/replays at 1429, 1435. |
| F6 pagination | Closed. §7, 863-864 and §11, 1164 specify inventory continuation and revision/hash-bound content. Gate 1778. |
| F7 phase dependencies | Mostly closed. §5, 622-624; §16, 1422-1424; §22, 1788-1811, 1846, 1885-1904 split rehearsals and preserve final migration. Corpus-wipe coverage remains premature. |
| F8 vectors | Open. §11, 1173-1175 still uses node id as vector id; §18, 1593-1598 requires scratch embedding and cleanup. |
| F9 missing transcript | Closed. §10, 1065-1077 discovers by session id, leaves missing sources pending/unacknowledged; recovery gate 1800. |
| F10 rollback | Closed. §16, 1443-1455 snapshots callers, freezes ordinary sessions, restores exact state; rehearsal 1891 and boundary 1904. |

## Remaining failures and minimal fixes

1. **P1, F3. Chunk boundaries lose rows sharing a sequence.** Every transaction stamps all touched rows with one `seq` at line 618. Line 1557 keeps only 2,000 rows/512 KB, advances to the last sequence, then reads strictly greater sequences. A single 600 KB multi-chunk write therefore loses its remaining same-sequence rows. Use a total continuation key such as `(seq, table, primary-key)`, finish ties before declaring a cut, and cover both caps in the existing restore-equality gate.

2. **P1, F4. Recovery omits publish-before-commit.** Section 9, lines 1002-1004 and 1013 leaves the source `moving` while the target becomes active. None of lines 1576-1580 covers that pair. Recovery can reopen at 1585 without settling ownership/fencing. Define target-active/source-moving reconciliation using the bound transfer identity, rebuild request ownership afterwards, and keep traffic closed for any unresolved pair. Include this crash point in gate 1841.

3. **P2, F8. Namespaces do not qualify mutation IDs.** Line 1173 retains `vector id = node id`. Cloudflare defines IDs as unique within the index, upserts replace an existing ID, and `deleteByIds(ids)` accepts no namespace. Scratch cleanup can delete the live vector. Use generation-qualified vector IDs everywhere, including hydration and deletion, or separate indices. Keep the existing live-vector preservation check. [Official Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/).

4. **P1, F1. Nonzero exit is accepted as confinement proof.** Lines 1261-1263 discard diagnostics and proceed after any failure, including missing commands/files or DNS failures. Those do not establish sandbox denial, even with identical configuration files. Require known probe inputs and verified permission denials under the effective profile used by `exec`; any indeterminate result must skip. Exercise broken-probe errors as well as weakened permissions. Sandbox precedence can remain an implementation gate with that safe failure.

5. **P2, digest parity. Interrupted sessions lack a complete fallback.** Lines 1067-1077 acknowledge a range after keyword-selected excerpts are durable. An owner message "Thanks. Use the other timeout." retains only "Thanks."; without inline task-end consolidation, the omitted instruction is absent from the daily batch's input. Gate 1795 permits successful inline consolidation to mask this loss; 1948 only adds markers. Add interrupted, marker-free correction/decision cases with no inline pass. Keep their ranges pending until full local-source consolidation preserves the marked learning. Do not label heuristic extraction complete.

6. **P1, work wipe. Exceptions exceed the approved contract.** Lines 1035-1039 preserve every previously transferred record, not only accepted company-free `me` preferences. A work record moved to personal survives with its work content. The final mixed BothQ archive under `migration/` at 1455 also has no work-payload deletion rule. Track and purge work-derived payloads/copies/exports outside the wiped store, preserving the agreed exceptions. Recheck complete corpus deletion after phase 6; phase-3 gate 1843 precedes `CorpusStore` at 1874.

## Owner decisions and proof limits

Digest-only hosting, authorized dummy sessions plus fixtures, retained authorized links, Paid/Vectorize with 300 ms lexical fallback, BothQ-only live writes, final migration and plan approval are incorporated. Meaningful capture parity and complete work deletion remain incomplete above. Opus authorship remains held during its usage limit; this Sol review supplies no replacement authorship.

No application/config/auth/session mutations, drills, deployments, Postplan changes or benchmarks were performed. Only this report was written; the parent owns the journal. Runtime confinement, authentication, hooks, recovery and migration remain unproved.

