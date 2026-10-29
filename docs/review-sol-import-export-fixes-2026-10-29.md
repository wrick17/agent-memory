# Export and planner fix closure review

What this change does: It checks complete outgoing records for redaction, holds ambiguous Claude paths, retries changing Markdown files, preserves supersession metadata, bounds import commands and checks export integrity before planning. This independent review closes the original E1 and E3-E6 cases, but E2 remains open and the shared URL redactor has a new privacy regression.

Verdict: fix findings 1 and 2 before treating this slice as ready for upload. No P0 found. Original E1's traversal fix is verified, but finding 2 prevents an unconditional privacy closure.

## Scope and fixed inputs

Reviewed the uncommitted implementation on `phase2-capture`, HEAD `dc749dc9aad26751d56b02829c39b2cc1ae262f8`. Read the recursive `~/dotfiles/ai/work/agents.md` chain, repository instructions, feature manifest, migration design, original report and `docs/import-implementation.md#export-review-fixes-2026-10-29`. Applied Ponytail review, RTK, journal single-writer and writing instructions. The parent remains the sole BothQ journal writer. No memory writes or delegation occurred.

All 51 files in `/tmp/agent-memory-import-review-freeze-20261029.json` matched before and after the review. Aggregate computed as SHA-256 of the sorted, compact JSON path-to-file-hash map:

```text
651198a4460d77f5979c7981ceee3d99b5e294e22420f37241ffcd0aa13fbbc5
```

Freeze-file SHA-256: `54387639ea1d2c7bf8f6725a33a58ce2cce5d41a16f86d4c1a442bcde008c6d9`. Relevant exact file pins are listed below. There was no drift in application, local, test, config or frozen design inputs.

Only this report was added by this reviewer. The original report is unchanged. No source fixes, commits, deploys, uploads, real exports, retained-plan regeneration, backup/restore work or physical cross-machine checks occurred. The sibling-added `docs/import-verification.md` was observed and left untouched. Server/import/uploader protocol review and combined verification belong to the other reviewers.

## Must fix

1. **P1: E2 still chooses a profile when consecutive encoded separators hide alternatives.** `local/migrate.mjs:245`, called by `markdownItem` at lines 387-389.

   **What this is:** Claude project folder names replace `/`, `.`, and `_` with `-`; literal `-` also remains `-`. The decoder must enumerate matching existing paths before routing a memory.

   **Problem:** Create existing directories `a/.b`, `a--b`, `a._b` and `a_-b` under one temporary parent. All four encode to the same project name. `decodeProjectDirs` returns only `a/.b`: its empty-segment branch tries the hidden-directory interpretation and returns before exploring the literal punctuation alternatives. In the independent planner probe, path rules route `a/.b` to `work` and the other three to `personal`. A Markdown record originating from `a--b` is planned to `work`, with zero review entries. The ordinary `a/b`, `a-b`, `a_b`, `a.b` ambiguity is correctly held; that passing control does not cover consecutive separators.

   **Fix:** Enumerate the separator alternatives for empty segments too, retaining the hidden-directory interpretation alongside them. Route only when the complete set is unambiguous. Add the repeated-separator case beside the existing E2 regression.

   **If we skip it:** Personal memory can enter the work profile through a deterministic decoding error. This is the original E2 privacy boundary failure on a remaining supported path shape.

2. **P2: The new scheme cap lets previously redacted URL passwords pass both redactors.** `src/domain/redact.ts:12`, mirrored at `local/agent-memory.mjs:38`.

   **What this is:** The shared redactor masks URL user-info passwords before ordinary writes and local digest construction, and supplies the planner's redaction hold decision.

   **Problem:** Build a scheme from `"a" + "1".repeat(64)`, followed by a URL user-info password, host and path. Both checkpoint redactors mask the synthetic password. Both current redactors return the input unchanged. There is no alphabetic start within the final 64 scheme characters, so matching a shorter suffix cannot rescue it. The current planner accepts this record, emits its password in commands and reports zero holds. The local digest `bodyProblem` accepts the same string in a decision; the checkpoint version rejects it. A 64-character scheme remains redacted, and a long all-letter scheme remains redacted through a suffix match. Thus the regression affects specific long schemes, rather than every scheme over 64 characters.

   **Fix:** Keep the long-run performance fix while recognizing the complete scheme, for example by scanning URL delimiters without retrying an unbounded scheme expression at every character. Apply the same change to both copies. Retain the long-run check and add accepted ordinary/64-character controls and the 65-character case.

   **If we skip it:** Plaintext credentials can pass the import privacy hold and local digest validation. The same shared helper is used at the MCP write boundary (`src/mcp.ts:154`) and digest acceptance boundary (`src/profile/capture.ts:54`). Those additional consequences are traced from source, not claimed as live or end-to-end server tests. Severity is P2 because the demonstrated bypass requires an unusual long scheme; ordinary URL schemes remain covered.

## E1-E6 disposition and verified cases

| Case | Disposition | Independent evidence |
|---|---|---|
| E1 | Original traversal defect closed; shared-cap exception remains in finding 2 | Nine records independently held for provenance string patterns, nested property keys, anchors, relationships, raw steps, parsed nested snapshot/delta/result keys and request extras. All nine private derivatives redact the synthetic values. Commands, review, manifest and batch artifacts contain none of them. An ordinary nested-provenance/result record imports unchanged. Original export bytes remain unchanged. |
| E2 | Open, finding 1 | Four ordinary separator interpretations enumerate and hold; one unique path routes successfully. Four consecutive-separator interpretations enumerate as one and produce an accepted wrong-profile plan. |
| E3 | Closed for the reported mixed-read case | A deterministic `fs.readSync` hook rewrites a 1,048,576-byte file after the first 524,288 bytes. The retry returns the complete new body and its hash, not the mixed body. Rewriting on every read produces `unstable: true`, no content, no body hash and an `unstable_read` review reason, with zero planned records. An unchanged file still reads successfully. |
| E4 | Closed | Complete incoming and outgoing raw `SUPERSEDES` relationships, including temporal, numeric and nested properties, survive into finalized provenance. The same two-record plan also emits the typed supersession link with the original endpoints. The retained rehearsal has all 16 raw appearances. |
| E5 | Closed for planner budgets | Oversized metadata, publication cost and individual request-row cases are held explicitly, with no partial record commands. A large Unicode/quote/backslash body and 350 requests import across two parts without truncation. Thirty additional ordinary records ensure batching is exercised. All 63 commands, two complete wire envelopes, stage estimates and publication estimates fit their limits. |
| E6 | Closed for artifact integrity before reuse/planning | Accepted cache reuse and forced deterministic planning pass. Eight corruption cases are rejected in both modes: changed records, record count, missing records file, unlinked-request hash, Markdown outer hash, Markdown body with the outer hash resealed, Markdown list hash and Markdown count. The resealed case independently exercises the per-body hash check. |

The planner limits checked are 1,000 rows and 1,000,000 UTF-8 bytes per estimated transaction, 50 commands and 1,000,000 bytes per request, and 16,000 characters per body chunk. Budget probes use `src/domain/import-cost.ts` as the agreed planner definition. They do not independently remeasure Workers SQLite accounting; Terra owns that verification.

The pathological-run check called each current redactor once with one million plain `x` characters. Output remained byte-identical. Observed times were 124 ms for the shared redactor and 144 ms for the local mirror, both below the probe's 2 s guard. This is a bounded regression check, not a performance audit or a scaling claim. The old redactor was tested only with short semantic controls, never a million-character input.

## Commands and reproducible evidence

Private probe directory, mode 0700:

```text
/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-export-fixes-x22u29it/
```

Probe scripts and saved results are mode 0600. `closure.mjs` creates private synthetic fixtures and emits only case results, counts, hashes and bounded timing observations. Its cases marked `disposition: "open"` assert the observed defect so the script can finish the remaining checks.

```sh
rtk proxy node /var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-export-fixes-x22u29it/closure.mjs
rtk proxy node /var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-export-fixes-x22u29it/checkpoint-repro.mjs
rtk proxy node /var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-export-fixes-x22u29it/checkpoint-markdown-race.mjs
rtk proxy node --test local/migrate.test.mjs
```

- The nine independent probe groups complete successfully; two reproduce the open findings. Results are retained in `results.json`.
- The original `repro.mjs` and `markdown-race.mjs`, copied to this private directory and redirected to `git show dc749dc:<file>` source copies, reproduce all six original defects. They exit 0 against that checkpoint. Against current source they fail their old defect assertions, as expected. This is a negative control, not the closure proof. Original scripts and private fixtures were not edited.
- The original fake-SSH `alias.mjs` control exits 0 against current code. It changes no owner SSH settings and makes no network request.
- The author's focused migration suite passes 16/16, including its Python synthetic reread/vanish self-test. This corroborates the independent probes and does not replace them. No combined suite was run here.

## Retained export inspection

Read-only checks used the existing `~/.agent-memory/migration/export-20261028T192847Z-c696` snapshot. No re-export or planning call was made on it. `checkExport` accepts its existing manifest. It contains 1,101 records, 3,755 revisions, 3,182 requests and 16 raw supersession appearances. Inspection printed no private memory bodies, secrets, tokens or auth URLs.

Routed plan: 1,945 commands and 41 batches. Largest command is 605,283 bytes; largest fully serialized request envelope in the probe is 998,558 bytes; maximum publication estimate is 27,003 bytes. It preserves 12 raw supersession appearances among the records selected for that plan.

Rehearsal plan: 2,681 commands and 60 batches. Largest command is 990,895 bytes; largest fully serialized request envelope is 997,528 bytes; maximum publication estimate is 49,603 bytes. It preserves all 16 raw supersession appearances. Neither plan exceeds the checked command, batch, stage or publication estimates.

Exact existing commands hashes:

```text
plan                 e7eff1cfab6b3b94c74faed89fdef6bcf3cbda3897274ebdf47515067bfe5ae3
plan-rehearsal-test   b6213e44ede36374d46a12952fce4d4e1dce8df4283cd175c982e3784f16687d
```

All 68 retained files have identical before/after hashes. Aggregate SHA-256 of the sorted JSON relative-path-to-hash map: `0fd849f99f5068ab52bce948755e5849a8abed069d816bdb9842cfa8c68b4d69`.

## Exact reviewed pins

These hashes are unchanged before/after, alongside the other 42 frozen files:

```text
local/migrate.mjs                              c31c1fb483c4177ce59c8c1d55dccc799d67ef9c7ce2c027987008beb7e4273f
local/migrate/export_bothq.py                   0d09246d1925b3b60eb99df092f0b66532812a232b38677e62e7b7ef45753557
local/migrate.test.mjs                         155c707933e9d4bebe702e192d62bde86c17193ecf26915293d8118b36f42fdc
src/domain/import-cost.ts                      aa29a462ee2940c98ff3521bc93042ce77ad7a40961dd34f2cda893acd6e2ff0
src/domain/redact.ts                           6251925c3988837be457d844920e38adeb66011d4911e1bc4a223b9ad42855be
local/agent-memory.mjs                         eec8a8d97bb02bbfaa1978acdc0eb47c30c8eacaa177a4690176dc956a35bdf5
docs/feature-manifest.md                       a0b6c6141f7b0c372796aad86d542520772bb75dd667074d5776a9fb6a0353dd
docs/import-implementation.md                  aa162b650dbcb9fa5e6193d937fbca248c4fda964cd1e029b9f80d1eeff61857
docs/review-sol-import-export-2026-10-29.md      54f7cb09def04b1ea4bba6f9f2794e7a2345e2d129526ca0632d098d704a9b2a
```

Not checked: full suites, server/import/uploader protocol, actual network uploads, hosted acceptance, live source races or deployment. Backup/restore and physical cross-machine parity remain final-stage work. Core F3/F4 were not reopened.

Risk: E2 can select the wrong privacy profile, and the new shared-redactor case can expose credentials. BothQ remains the only live memory system; no runtime-state change was made or verified here.
