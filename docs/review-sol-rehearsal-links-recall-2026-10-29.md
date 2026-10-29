# Bounded review of the rehearsal link and recall fixes

What this change does: the import accepts genuine BothQ supersessions across memory kinds, and the planner emits links only between records it will publish in the same profile. Recall binds each candidate ID list as one JSON value so larger result sets and filtered vector hits fit SQLite's parameter limit.

**Verdict: both fixes closed at the reviewed source. No reproducible material P0/P1/P2 finding.** This clears the frozen source for the parent's isolated rehearsal deployment and resume gate. It does not establish a deployed fix, a completed upload, or passing hosted retrieval.

## Frozen scope and preservation

Reviewed the link-contract section in `import-implementation.md`, the recall-bound-parameter section in `phase-1-implementation.md`, architecture sections 4/16 and 6/11, the current verification chronology, changed implementations, their callers and directly affected controls. Compared the three Worker implementations against the baseline-matching files in `/tmp/am-diag-embed`; its old import, read and store files match the supplied 55-file cleared baseline. Its `types.ts` also matches that baseline; the current change there is a contract comment only. The older `/tmp/am-orig-import-review` importer, planner and store do not match that baseline and were not treated as authoritative old source.

All **56 individual pins matched before and after** against `/tmp/agent-memory-rehearsal-fixes-review-20261029T054220Z.json`, aggregate `e9bdbb3f717556716023d451874d589b906cce2aea2fe1750983c650b30bf35a`. Pin-file SHA-256 is `1ee1ea28bb4092feaf6686559f287bed7fe26932ec547a7ec5bb9c0a6824b385`. The previous 55-file baseline aggregate is `d862af68b4826d606d5dfc397f4cfee5d6e3d03b42a3e0853970b25b6e9b9ca7`.

Selected current SHA-256 pins:

| File | SHA-256 |
|---|---|
| `src/profile/import.ts` | `83f1e70289190fa7109bec445a6770eb2a078296d2105f129ee5bc6650e8a106` |
| `local/migrate.mjs` | `46b39401470322f78d5bae73ee1aadf4c905da299952ba507b28126671969623` |
| `src/profile/store.ts` | `5b1569bace0d2dfc1c6cfdd3a099ef2a93029d7f900016387bc878cd77ddfbc4` |
| `src/profile/read.ts` | `d23de21743657991995aae67ca8604dd79b14787413dde659bdf8f8726a26fa5` |
| `test/import.test.ts` | `71c104ec0c12b825c7b078738ea5f230b57421928e23226174987030e805e8f7` |
| `local/migrate.test.mjs` | `1fc610619a8427d61d96d1081652bec385b1cd30e3540c53a2273ee9900653ed` |
| `test/isolation-recall.test.ts` | `bb9c307ba6776cd104faaa1befcda707fef16a3ddfb58923201ffa7c5e6bbcce` |

HEAD remains `dc749dc9aad26751d56b02829c39b2cc1ae262f8` on `phase2-capture`. Index SHA-256 remains `b6db0f7efc405b2e7575c0729e8061ee9ef58649b0cc42fa168591525b6e38f5`. Earlier review reports remain pinned and unchanged. README and AGENTS are outside this freeze and were unchanged during this review. This reviewer wrote only this new report in the workspace. The separately owned `docs/capture-lock-recovery-design.md` appeared during review and was left alone. All tests and mutations ran in private copies with synthetic records, remote bindings disabled and the existing local fakes. No subagents or BothQ writes were used; the parent owns the journal.

## Fix 1: import links and planner

**Closed.** `src/profile/import.ts:170` reads both endpoints from the selected profile's nodes table. It requires two distinct memories, rejects either non-memory endpoint, and replays an existing live edge before allocating a sequence or inserting anything. `runImport` retains its transaction boundary. The API still enforces import scope, allowed deployment profiles, caller profile access, hashes and the `me` refusal before dispatch.

The contract matches BothQ's `_supersede` at `graph-db/memory_store.py:698` and hosted memory supersession at `src/profile/write.ts:219`: memory kinds need not match. The judgment-edge validation at `write.ts:457` remains same-kind for `supersedes`.

| Independent evidence | Result |
|---|---|
| Current import-link regression through `/v1/import` | Passes cross-kind links, same-kind replay, unpublished endpoint, self-link, non-memory at either end, cross-profile refusal and exactly three resulting edges. |
| Private corrected fixture with an actual rule-to-decision pair and document-to-journal pair | Both link and replay. Imported node content/identity/status fields, revisions and request rows remain unchanged through links and refusals. Embedding bookkeeping is excluded from the node comparison. |
| Same pair test with baseline-matching old `import.ts` | Fails with two `refused` results where two `linked` results are required. |
| Ordinary `save_memory` cross-kind supersession and identical request replay | Passes; the prior decision becomes superseded at revision 2. A different-kind judgment `supersedes` is still refused with `validation/invalid_endpoints`, leaving the record unchanged. |
| Import authorization/profile controls and judgment-edge rollback regression | Pass. No relaxation of these controls in the patch. |
| Planner regression and raw relationship provenance regression | Both pass. Only the published same-profile target is linked; the oversize and cross-profile targets are listed for review. Raw relationship properties remain in provenance. |
| Private planner negative control restoring the old `readyIds` guard | Fails by emitting both additional bad links. This restores only the old precondition, not a claimed whole-file baseline. |

At `local/migrate.mjs:540`, the target map is built after packing, finalize-size and publication-budget checks, using only `planned` records. Both the source loop and target lookup use this final set, with a profile equality check. Earlier routing, identity, privacy and redaction holds exclude records before this set is built. Unresolved edges go to review while the raw source relationship stays in provenance.

Read-only inspection of the retained real plans confirms eight rehearsal links and six routed links, each with both endpoints in the same planned profile. Every target is superseded and each outgoing source relationship exists in provenance. The rehearsal geometry is exactly two rule-to-decision, three document-to-journal, one decision-to-decision and two document-to-document links. No real export or plan was regenerated.

The retained batch 60 contains **three stage, three finalize and eight link commands**. On a successful resume with the fixed runtime, the expected result is replay of those six stage/finalize commands and three existing links, with five new links. This is a source-based expectation; this reviewer sent none of them.

## Fix 2: recall SQL bindings

**Closed.** The presence lookup and `lexicalFilterIds` in `src/profile/store.ts:159` and `:198`, and candidate hydration in `src/profile/read.ts:150`, all use bound `JSON.stringify(ids)` with `id IN (SELECT value FROM json_each(?))`. No candidate ID is interpolated into SQL. The change leaves channel construction, filtering predicates, ranking, origin weights, tie order and result packing intact.

Cloudflare documents [100 bound parameters per query](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits) and the [SQLite JSON extension](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sql-api). An independent real local workerd probe accepts 100 bindings and rejects 101. The unchanged MCP schema caps kinds at five, so even the combined type/kind/scope filter uses at most eight bindings with the JSON ID list.

| Independent evidence | Result |
|---|---|
| Current 131-record regression, with 100 vector hits | Passes: the exact target created last ranks first through all four channels; 100 distinct results in score order; 21 feedback results; 100 document results. |
| Same regression with baseline-matching old store and read | Fails at offset **240**, reproducing the fusion overflow. |
| Same regression with only the old store and current read | Unfiltered recall passes, then the type-filter call fails at offset **303**, reproducing the hosted G01 failure. |
| Private direct fusion probe with 520 distinct candidates across all four channels | All 520 IDs survive hydration. Each score matches an independent calculation of channel rank, weight and literal boost. Scores are ordered; the first 100 match a separate limited call. A candidate ID containing quotes, a backslash and SQL text remains a literal ID; the nodes table remains intact. |
| Private profile recall with 100 vector candidates, including stale IDs and wrong type/scope/status candidates | Combined scope/type/kind filter returns only the correct active document. `includeHistory` additionally returns the retired document. Exact casefold and literal trigram substring checks pass. |
| Existing read-set/device isolation, four-channel retrieval and token-budget regressions | Pass. |

The source retains exact/literal/full-text/vector caps of 20/200/200/100. Presence filtering still uses the generation-qualified IDs, profile-local SQL and generation namespace; stale-ID cleanup remains confined to that generation. The fix does not truncate ID lists to avoid the limit.

## Checks and evidence

Private evidence root: `/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-rehearsal-review-9jhjmm_l/`, directory mode 0700. Logs and probe artifacts are private. The `current/` copy contains the independent probes; `old-all/`, `old-filter/` and `old-link/` contain the negative controls. Existing private source originals were not changed.

- `targeted-current.log`: eight selected Worker regressions pass across import, recall/isolation and write-details. Other tests were deliberately filtered out.
- `planner-current.log`: two selected planner/provenance tests pass.
- `independent-current.log`: the 520-candidate score/binding probe passes. Its other two initial failures were reviewer fixture errors, not product findings: the link snapshot also included a later-created component, and the probe used an unavailable retirement tool name.
- `independent-corrected.log`: the corrected import-link and vector-filter probes both pass. `normal-judgment-controls.log`: the independent normal-save/judgment contract test passes.
- `negative-old-all.log`, `negative-old-filter.log`, `independent-old-link.log` and `negative-planner.log`: expected failures above. The earlier `negative-old-link.log` used a decision fixture without its required `why`; the corrected run is authoritative.
- `before.json`, `post-probes.json`, `after.json`, `real-plan-pins.json` and `real-plan-summary.json`: source/state preservation and sanitized real-plan checks. An `evidence-sha256.json` file pins the private logs and probes.

Real plan command/batch SHA-256 values were preserved:

| Plan | Commands SHA-256 | Batches SHA-256 |
|---|---|---|
| Routed | `e7eff1cfab6b3b94c74faed89fdef6bcf3cbda3897274ebdf47515067bfe5ae3` | `5144610b366565685b7148601970596b6bf3fc7a22164f7db5d511d385eb244b` |
| Rehearsal | `b6213e44ede36374d46a12952fce4d4e1dce8df4283cd175c982e3784f16687d` | `0feca7c9ca5b10a7fe3fd9d58b6c308edf1ed4f8242d40043cf6323282aae915` |

Retained upload-state SHA-256 is unchanged at `2539918786438c686d5e0f227c97efbfd50c1398eefdcc2979cd7857b898f4d2`, with the documented 59 acknowledged batches. The existing corrected hosted body summary reports 1,330/1,330 body hashes, content hashes and metadata matches, without errors; its SHA-256 is `768e750984afaf94d7f5fade3889201da4bc84507fc5bab560a62358b3ad2ada`. The diagnostic artifact still contains 20 SQL-variable errors, including G01 at offset 303, SHA-256 `d78fa2512fb8a1bda21c8a5309c2e5309ab0e261642754597ff0dc356d560403`. These are inspected historical artifacts for published version `8e197b3c-ec10-4436-bed4-0fec8d848334`, not new hosted calls or proof of the current fixes.

Not checked: full suite, fresh type/lint runs, live authentication, deployment, upload/resend, hosted G01/C09 or the complete candidate set, production, backup/restore, cross-machine behavior, capture/L4, or unrelated compatibility work. The author's broader focused checks are recorded in the implementation documents, not claimed as this reviewer's runs. Seeded-routine protection, name-only legacy updates and list eligibility remain unproved here. BothQ stays live; production import and cutover remain gated.
