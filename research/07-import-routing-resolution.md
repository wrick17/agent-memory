# Import routing research

Read-only Sol research on `phase2-capture`, 2026-10-29. This supplements [research 05](05-current-memory-import.md) and the [import implementation](../docs/import-implementation.md). It proposes mappings for parent and original-author review. It changes no routing policy, export, plan, source behavior or live system. BothQ remains the sole live writer.

The current routed plan contains 969 records and 491 review items. Its five reason counts remain 224 `unrouted_scope`, 168 `unrouted_path`, 92 `missing_scope`, 28 `needs_redaction`, and 11 `reference_candidate`. Reasons overlap. The export contains 1,101 BothQ records and 359 distinct Markdown files, including 11 reference candidates.

## Candidates supported by provenance

**148 review items have a supported routing candidate: 125 to `work`, 23 to `personal`, none to `me`.** These are routing candidates, not verified import commands. If the parent and original author accept them and the planner's existing checks pass, the review list could fall from 491 to 343. No item has actually advanced.

| Evidence category | Work | Personal |
|---|---:|---:|
| Exact workspace context, corroborated by local child repository origins | 83 | 0 |
| Exact package workspace, corroborated by its manifest and README | 6 | 0 |
| Exported old/new project-path aliases for the same files | 0 | 4 |
| Removed worktree, corroborated by two exact commit objects in its surviving repository | 0 | 1 |
| Curated notes with explicit project or work provenance | 25 | 3 |
| BothQ records with exact repository/path evidence and local corroboration | 11 | 15 |
| Total | 125 | 23 |

The minimal additions are two exact workspace path rules and one exact package-workspace rule, plus source-ID mappings for the other 59 items. The path rules must retain the current remote-first precedence and exhaustive Claude path ambiguity check. The source-ID mappings are a review artifact, not executable configuration.

An SSH alias is resolved through its configured hostname before applying the existing repository-owner rules. Only the hostname was retained from SSH configuration. No remote Git operation or authentication probe was needed. A checkout beneath a personal directory can still have a work-owned remote; a directory prefix cannot override that evidence. A repository containing the memory system cannot determine the profile of every memory it stores.

Old/new aliases identify one source file, not two imports. A removed worktree can be corroborated by exact source commit objects; a matching project name alone is insufficient. Claude's lossy folder encoding is never reversed by guessing between paths.

## Remaining review groups

The following groups are disjoint. Redaction takes precedence when reasons overlap.

| Remaining root reason | Items |
|---|---:|
| Redaction holds, including three missing-scope cases | 28 |
| Missing original scope and identity, excluding those three | 89 |
| Mixed BothQ scope without accepted per-record context | 180 |
| Other unmapped scope | 1 |
| Generic or mixed curated notes | 11 |
| Home-directory or scratch context without unique project provenance | 11 |
| Removed project paths or context needing more provenance or work-origin review | 9 |
| Mixed aggregate documents and derived index | 3 |
| Reference candidates: ten skills and one import-instruction file | 11 |
| Total | 343 |

The owner-semantic questions can be grouped into three decisions, after the parent and author exhaust existing evidence:

1. Choose a default project context for generic and mixed operational memories. Do not infer `personal` from the memory-system repository, and do not infer `me` from reusable wording.
2. Decide whether mixed aggregate documents should remain whole in `work` or receive a separately reviewed partition with source provenance. A folder-wide personal rule cannot settle this.
3. Decide whether the eleven reference sources belong in the import as reference documents. Classification does not make old skills or import instructions authoritative guidance.

Missing-scope cases need recoverable source evidence, not an invented historical scope. Removed-path cases need a unique source binding, not individual speculative owner questions. All 92 missing-scope identities remain unchanged, including null IDs. All 28 redaction holds stay held; marker inspection gives no exemption.

## Preservation and handoff

The private mapping covers every one of the 491 review items with its existing source ID, ID, scope, candidate profile or null, proof references, reason, confidence and status. It preserves unresolved items explicitly. The private evidence is under the export's `verification/routing/` directory; it is not committable material.

Profiles separate default context and support eventual deletion. Cross-profile links remain allowed. Every accepted mapping must retain source paths, scope, history, anchors and relationships, and preserve work-origin provenance for the eventual work wipe, including copies in another profile. Nothing here supplies a company-free attestation or a route into `me`.

The parent and original author must review mappings before any future plan change. No replan, promotion, import, upload, live hosted call, native-memory update, authentication, deployment, client configuration, backup/restore or cross-machine operation was performed. No scripts were added. Local metadata and read-only data transformations supplied the evidence; import packing, hosted behavior and unresolved historical origins were not re-verified here.

All 55 pinned files matched the cleared freeze, and the freeze file itself retained its original SHA-256. The export and routed-plan input hashes also matched the recorded baseline. The private verification receipts record those comparisons.
