# Repo facts and loop guard verification

This page records the gates and evidence for repo facts (epic #105, issues #90 to #103) and the loop guard (#102, #103). It lists what the source does, which checks passed, and which gates are still open. Fill in an open line only from a result that actually exists.

**v2 status, 11 Nov 2026:** Merged in PR #132 (`b909583`), deployed 11 Nov 2026 as Worker version `62bb7947-6a9b-417c-9548-534eb29cf0fb`, client installed through dotfiles `77008fc`. Evidence is in [delivery](#delivery-11-nov-2026). The v1 status below is the record for PR #110.

**Status, 2026-11-11:** merged to `master` in PR #110 as `a0478c5`, after source and local verification and passing CI. The feature is not released, not deployed and not installed on any owner client. All five findings from the independent privacy and data-loss review are closed. The owner signed off the #100 review on 2026-11-11 and approved exactly one isolated real synthesis call; that call passed, and #100 is closed. Normal synthesis stays off; turning it on is a separate owner step. The P3 paired evaluation (#101) ran in full and did not demonstrate efficiency savings ([results](#p3-paired-evaluation-2026-11-11)). The Codex-backed loop check (#103) stays design only.

| Check | Result |
|---|---|
| Worker tests, controlled run (`--no-file-parallelism --maxWorkers=1`) | 25 files, 674 passed, no unhandled errors |
| Worker tests, affected files | 85 passed |
| Local tests (`npm run test:local`) | 297 passed |
| Type check and lint (`npm run lint`) | Passed |
| Isolated Linux install | Passed: all six fact and loop guard modules match source by SHA-256, with every default off |
| PR #110 CI at `ebd91f0` | All checks passed |
| PR #110 CI at `1547235` | All checks passed |
| PR #110 CI at `14c8024`, the merged head | All checks passed |
| Merge | `master` at `a0478c5`, tree `ac1ef23` |
| P3 primary run (v4) | 12 of 12 runs, all receipts matched; no efficiency savings demonstrated |
| Isolated real synthesis call | Passed: one provider call, valid empty result ([details](#isolated-synthesis-call-2026-11-11)) |
| Privacy and data-loss review | 5 of 5 findings closed |

## v2 fix round, 2026-11-11

A review on 2026-11-11 of epic #105 (PRs #106 to #111) found 4 must-fix and 8 should-fix defects, plus design gaps that kept facts from making agents more efficient. Epic [#123](https://github.com/wrick17/agent-memory/issues/123) tracks the fix round. The code was built on branch `fix/repo-facts-review`. Merged in PR #132 (`b909583`), deployed 11 Nov 2026 as Worker version `62bb7947-6a9b-417c-9548-534eb29cf0fb`, client installed through dotfiles `77008fc`. The test phase, reviews and deployment were [#122](https://github.com/wrick17/agent-memory/issues/122). The binding rules are the [repo facts v2 contract](repo-facts-v2-contract.md) ([#112](https://github.com/wrick17/agent-memory/issues/112), approved after two review rounds).

| Area | What the review found | What changed | Issue |
|---|---|---|---|
| Client privacy and routing | Inline secrets such as `AWS_SECRET_ACCESS_KEY=…`, `--password` values and some token prefixes could reach synthesis input or uploads. Fact routes used the remote only, so path rules never applied, and an SSH host alias was refused. Commands run in another repo could become facts for the session's repo. Session-start git lookups could block for seconds. | Wider secret rules, shared by client and Worker. Routes carry `repo: { remote, path }` and a client-resolved `repo_key`. Each command is attributed to its own repo, and unattributed commands are dropped. Git runs asynchronously within the deadline. | [#113](https://github.com/wrick17/agent-memory/issues/113) |
| Server lifecycle | Contradiction streaks followed upload order. Activation kept too little history to find any disjoint triple. Environment facts were not tracked per device. The Worker stored client-sent statements. A failure prevented after injection did not count. | Lanes recomputed from session-ordered history, any disjoint triple, per-device environment lanes, server-written statements, `prevented` outcomes, a user tier, report receipts with a watermark, and v1 bodies accepted as legacy | [#114](https://github.com/wrick17/agent-memory/issues/114) |
| Loop guard | Codex shell loops were invisible, and the same command in two directories counted as one | Codex shell exit codes from the rollout, the directory in the invocation key, the `variant` rule, `loop_guard.shadow` and the hash-only fire log | [#115](https://github.com/wrick17/agent-memory/issues/115) |
| Detectors | Fixes such as `pytest` to `python -m pytest` were invisible; a related but different command could count as a repair; `numpy.typing` became `import numpy` | `form_repair`, `arg_repair`, same-operation proof for every repair, full dotted module names | [#116](https://github.com/wrick17/agent-memory/issues/116) |
| Synthesis | A crash after a paid reply could lose it or pay again; proposals could only repeat detector formats | Per-attempt reply files and recovery, learned facts as plain-substring signatures, held facts in the prompt | [#117](https://github.com/wrick17/agent-memory/issues/117) |
| Visibility | No dashboard view, no flag, no measure of session cost | The Facts tab, MCP `repo_facts`, the efficiency route, and `status` and `doctor` fields | [#118](https://github.com/wrick17/agent-memory/issues/118) |
| Injection gate | Deterministic facts also had to pass the firing-rate gate, and repo facts had served 0 items | Deterministic facts inject once active; only learned facts keep the gate | [#124](https://github.com/wrick17/agent-memory/issues/124) |

Two items are decided or still open:

- Tool pruning ([#119](https://github.com/wrick17/agent-memory/issues/119)) was measured and not built: removing every MCP server saves under 1% of a median session's price-weighted input.
- Threshold calibration ([#120](https://github.com/wrick17/agent-memory/issues/120)) replayed local history and changed one threshold: a fact now retires on its newest contradiction ([history replay](#history-replay-120)).

The fix round also changes these known limits: repo-class facts now activate from confirmations on any devices, Codex shell results now count for the loop guard, and the dashboard has a Facts tab. The daily synthesis cap stays per device. The two new switches are `loop_guard.shadow` (off) and the v2 brief behind the existing `facts.inject`. The evidence for this round is in [delivery](#delivery-11-nov-2026).

### History replay (#120)

`node local/facts-replay.mjs --cache <dir> --out <report.md>` replays the owner's local Claude Code and Codex transcripts through the v2 detectors and a parameterised copy of the section 6 lifecycle. It is offline and read-only, makes no model or network call, and prints only counts. Rerun it to recheck the thresholds.

The run read 4,000 transcripts: 1,897 sessions with commands, which gave 2,374 repo-sessions in 30 GitHub repos. Those held 76,126 commands, 4,684 of them failed. Detection found 32 distinct facts (58 per-repo candidates), and 19 activate under the rules before this change.

- **Benefit.** Injected facts would have prevented 46 failed commands, about 1% of all failures. The `env -u GITHUB_TOKEN -u GH_TOKEN gh auth switch` repair accounts for 31 of them, across 6 repos, and `import Quartz` and `import PIL` in bettergit for 7.
- **Cost.** Injection roughly breaks even on tokens. The injected lines cost about 4.4M tokens over all model calls with `retire` = 1 (4.8M with `retire` = 2), almost all cached. The failures they prevent save at least 3.7M tokens, a lower bound, since a failure usually costs more than one turn.
- **Wrong advice.** 7 activations were later contradicted: `env -u GITHUB_TOKEN -u GH_TOKEN gh api user` in 6 repos, and `import PIL` in bettergit. Activating at 2, 3 or 4 sessions does not change that. The `gh api user` fact had 176 confirmations and 125 contradictions in Codex sessions alone, so the token state changes from session to session, not between clients. Its advice still works when plain `gh` works, so the harm is low.

| Run | Activated | Injections | Carry tokens | Failures prevented | Turn tokens saved | Wrong-advice injections |
|---|---|---|---|---|---|---|
| Before (activate 3, disjoint on, retire 2, no gate on deterministic facts) | 19 | 3,146 | 4.8M | 46 | 3.7M | 35 |
| Activate 2 | 24 | 3,957 | 5.9M | 53 | 4.3M | 36 |
| Activate 4 | 16 | 3,040 | 4.6M | 41 | 3.3M | 32 |
| Disjoint rule off | 19 | 3,146 | 4.8M | 46 | 3.7M | 35 |
| **Retire 1** | 19 | 2,857 | 4.4M | 46 | 3.7M | 23 |
| Retire 3 | 19 | 3,455 | 5.5M | 46 | 3.7M | 45 |
| Firing gate on deterministic facts | 19 | 3,108 | 4.7M | 45 | 3.7M | 34 |

Recommendation, now in the code: `REPO_FACT_RULES.retire` goes from 2 to 1. It prevents the same 46 failures with the same activations, cuts wrong-advice injections by 34% (35 to 23) and saves 0.4M carry tokens. Activation stays sticky, so one fresh confirmation brings a fact back. The other thresholds stay. Activating at 2 adds 5 facts, and none of them prevents a failure; its 7 extra hits come from activating existing facts earlier, for 1.1M more carry tokens. Retire 3 is worse in every column.

Limits:

- The replay simulates one device and one profile. It has no flags, dormant cap, proposals or receipts.
- Learned facts need a model, so the replay cannot measure them or their firing gate. The deterministic-fact gate row is only a proxy.
- The disjoint rule could not be measured: none of the 8 `arg_repair` candidates reached 3 sessions, even with the rule off.
- 42,618 commands ran outside a GitHub checkout and are not attributed. A directory that no longer exists also counts as unattributed.
- Only top-level transcripts are read; Claude Code sub-agent transcripts are excluded.
- Prevented failures come from the detectors' `outcomes`, not the client's `injectedOutcomes`, and the two disagree.

## Delivery, 11 Nov 2026

The v2 fix round (#123) and the forever-context work (#131) shipped together. Merged in PR #132 (`b909583`), deployed 11 Nov 2026 as Worker version `62bb7947-6a9b-417c-9548-534eb29cf0fb`, client installed through dotfiles `77008fc`.

| Check | Result |
|---|---|
| Type check and lint | Passed |
| Worker tests, CI mode | 702 passed |
| Local tests (`npm run test:local`) | 364 passed |
| PR #132 CI | All checks passed |
| Independent reviews | Two reviews found 22 defects, and a re-check found 3 more. All 25 are fixed, each with a regression test, and re-checked. |

**Rollback point.** Before the deploy, nondeleting exports of the four profiles went to the R2 bucket `am-core-ledger-a8ad574089`:

| Profile | Export id |
|---|---|
| me | `20261111T182454862Z-72153a0d` |
| personal | `20261111T182455674Z-9b8a8402` |
| test | `20261111T182458522Z-aa80ef88` |
| work | `20261111T182459727Z-a8ea5490` |

**Live checks.**

- `/v1/whoami` and `/v1/brief` returned 200.
- A new Claude Code session received the brief at `SessionStart`.
- The `repo_facts` MCP tool answers.
- `doctor` passed every check except `codex_hook_trust`, which waits for the owner to trust the hooks once in Codex.

**Backfill.** `agent-memory backfill` queued 43 transcripts from the work Claude account and 22 Codex transcripts. 127 Codex transcripts were already current.

**Known limits.**

- Until the owner trusts the Codex hooks once in Codex, interactive Codex sessions are not captured and the loop guard does not run there.
- Repo facts start empty on the deployed Worker and build from new session reports.
- `VECTOR_MIN_SCORE` (0.3) and `MIN_FUSED_SCORE` (0.01) are uncalibrated judgements, not tuned against the eval set.

## Switches

| Part | Switch | Default |
|---|---|---|
| Session-start injection | `facts.inject` | Off |
| Synthesis | `facts.synthesis` | Off. #100 is signed off; turning it on is a separate owner step |
| Loop guard | `loop_guard.enabled` | Off |
| Deterministic detection and session reports | None of its own | Runs with capture, as approved |

Turning synthesis off (#99) keeps deterministic reporting working, as designed. On a machine with the capture run installed, every finished session in a GitHub checkout sends a fact report with hashes, fact keys and fixed statements only. The privacy review assessed that flow and did not count the missing switch as a finding. This page makes no claim that every `facts.*` path is off.

Design: [architecture, repo facts](architecture.md#repo-facts) and [loop guard](architecture.md#loop-guard). Contracts: [module contracts](module-contracts.md#repo-facts-and-loop-guard-modules-2026-11-11). Manifest rows: AM-24 and AM-25 in the [feature manifest](feature-manifest.md#commitments).

## Source

| Commit | Change | Issues |
|---|---|---|
| `b1fbb4b` | Rule-based loop guard module | #102 |
| `25db305` | Loop guard wired into the client hooks, `doctor` and status | #102 |
| `13d6302` | Command digest, GitHub repo key and recorded fixtures | #90, #93 |
| `1676a29` | Server lifecycle, storage and routes | #92, #93, #94, #95 |
| `f66db09` | Corrected confirmation chains and retirement | #92 |
| `3dce428` | Corrected recorded fixture expectations | #90 |
| `9398f7b` | Detectors, client reports and session-start injection | #91, #92, #94 |
| `f917866` | Opt-in synthesis: cadence, cap, citation check, cost log | #96, #97, #98, #99 |
| `ebd91f0` | Fixes for the 5 review findings, with combined test coverage | #100 |

The verified source is commit `ebd91f001f7b1d52c08004c07b5af003a49a2799`, tree `1d3c4b56bb64b7f99716b6e71e355d62fd3d923e`, pushed as PR #110 with all CI checks passing. It holds `local/facts-detect.mjs` at SHA-256 `e049c8dad22178f379ca6c49c7ab3c4f8445367c5d185e19287195019a6954d3`.

## Gates

| Gate | Rule | State on 2026-11-11 |
|---|---|---|
| Synthesis enable (#100) | `facts.synthesis` stays `false` until the owner signs off a written privacy and data-loss review. Turning it on is a separate owner step after the sign-off. | Review clear: all 5 findings closed ([review](#privacy-and-data-loss-review-2026-11-11)). **Signed off by the owner on 2026-11-11** ("Approve review and isolated call"), for source `ebd91f0` and exactly one isolated real call. That call passed ([details](#isolated-synthesis-call-2026-11-11)), and #100 is closed. Normal synthesis is not enabled. |
| P3 benefit (#101) | Six paired tasks, memory alone against memory plus facts: completion, repeated failures and cache-aware cost. | Done on 2026-11-11 with the primary run (v4): all 12 runs, with every delivery receipt matched. It did not demonstrate efficiency savings ([results](#p3-paired-evaluation-2026-11-11)). |
| Codex-backed loop check (#103) | Design only. It is built only if P3 shows that the rules miss real loops. | Decision on 2026-11-11: stays design only ([decision](#decision-on-the-codex-backed-loop-check-103)). |
| Injection on | `facts.inject` is an owner choice, like prompt recall. | Off. Not turned on anywhere. |
| Loop guard on | `loop_guard.enabled` is an owner choice. | Off. Not turned on anywhere. |

## P0 fixtures (#90)

The fixtures are recorded command digests in `test/fixtures/repo-facts/<owner>__<repo>/`, one `digests.jsonl` and one `expected-facts.json` per repo. The owner approved the repos and facts on 2026-11-11, including the rule that an empty edited-file set counts as disjoint. The expectations follow the strict P1 rules as corrected on 2026-11-11. They replace the earlier P0 expectations, which came from a broader replay with no 5-command repair window.

| Repo | Sessions in fixture | Expected facts |
|---|---|---|
| `wrick17/agent-memory` | 11 | `env -u GITHUB_TOKEN -u GH_TOKEN gh auth switch`: candidate, chain 1, exercised 5, fired 1, not injectable. `import PIL`: candidate. `npm test needs vitest`: candidate. |
| `wrick17/bettergit` | 13 | `import Quartz` (PyObjC missing): active, chain 3, exercised 4, fired 3, rate 0.75, injectable. `gh auth switch` repair: candidate, chain 2, exercised 6, fired 2, not injectable. |
| `wrick17/postplan` | 8 | `gh auth switch` repair: candidate, chain 1, exercised 3, fired 1, not injectable. |
| `agent360dk/browser-mcp` | 7 | None. A quiet repo: 0 observations. |

Each file also has a `must_not_produce` list (loopback refusals, probes outside the checkout, a `wrangler` login state) and `quiet_sessions` with 0 observations. The local tests reproduce every recorded fixture timeline exactly.

The `whole_local_history` counts in each file come from every local session, built before the final scrub fix. They are context only. They are not reproducible from the fixtures, and they prove neither benefit nor that a fact qualifies.

## Checklist

### Final source and local verification

- [x] Worker tests in a controlled run (`--no-file-parallelism --maxWorkers=1`): 25 files, 674 passed, no unhandled errors. The affected files passed 85 of 85. This includes `test/facts.test.ts`.
- [x] Type check passed.
- [x] `npm run test:local` on the final source: 297 passed. This includes `local/facts.test.mjs`, `local/facts-synth.test.mjs` and `local/loop-guard.test.mjs`, now registered in `test:local`.
- [x] `npm run lint` passed.
- [x] The self-host guide package check (the staged guide must be self-contained) passed in the full local run and in a scoped run.
- [x] Isolated Linux install in a scratch home against the placeholder server `example.invalid`: all six fact and loop guard modules match source by SHA-256, and every default is off.
- [x] Committed and pushed as `ebd91f0` in PR #110; all CI checks passed.
- [x] One isolated real synthesis call, approved by the owner on 2026-11-11: passed ([details](#isolated-synthesis-call-2026-11-11)).
- CI at `d1882bd`: all 674 Worker tests passed, but the run reported one `EnvironmentTeardownError` from a graph test file; CI then ran the Worker tests with `--no-file-parallelism --maxWorkers=1`, with no assertion, timeout or error-handling change. At `1547235`, all CI checks passed. Issue #143 later traced that teardown error to a Cloudflare Vitest plugin race (cloudflare/workers-sdk#15920); CI now runs plain `npm test`; the Vitest config applies a pinned test-only plugin patch and caps Vitest at four workers.
- Expected log lines, not failures: 4 fake-vector log lines and the meter's negative-value validation message are intentional.
- The first full run at `f917866` had resource failures: two 30 s timeouts, a 3,830 ms result against a 3,800 ms deadline, and a Cloudflare test pool startup timeout. They did not recur in the controlled run. Their root cause is not established.

### Earlier scoped receipts, 2026-11-11

- Loop guard: `local/loop-guard.test.mjs` passed 14 of 14 with ESLint. It runs the real CLI hooks and covers concurrency, duplicate tool ids, the off switch, no capture trigger, hash-only state with private file modes, and safe note injection. Not covered, non-blocking: the `agent_id` subagent scope, the CLI's 2 s hook deadline, the 64-id duplicate cap and 7-day pruning.
- Facts: `local/facts.test.mjs` passed 13 of 13, and 6 of 6 targeted `local/agent-memory.test.mjs` cases passed.
- Synthesis: `local/facts-synth.test.mjs` passed 8 of 8 with a fake provider. It covers cadence crash recovery (replaying one completed session after 80 other sessions does not count it twice), the daily cap, retries, the off switch, the cost log, the citation check and the accepted-proposal registry.
- Existing owner-model and profile-isolation tests passed 26 of 26.

### Not run

- [ ] A live Claude Code or Codex client with injection or the loop guard turned on.
- [ ] Packaging release, deployment and install on an owner client.

Done since: merged in PR #110 as `a0478c5`, and the P3 primary run completed ([results](#p3-paired-evaluation-2026-11-11)).

## P3 paired evaluation, 2026-11-11

**Result: this limited replay did not demonstrate efficiency savings.** Both arms completed both tasks where a fact was relevant. On those tasks, the facts arm used 18.10% more input, 2.83% more uncached input and 21.61% more output. The sample is 6 pairs on a frozen project snapshot, with 2 relevant tasks and 4 controls, so it supports no causal or production claim.

### Method (primary run, v4)

- **Same tasks.** Six tasks with the same pinned commits, run order, model (`gpt-6-luna`) and effort (low) as the earlier runs, and a 180 s timeout. Each run started from a clean copy and passed a preflight check.
- **Ordinary memory in both arms.** Both arms received the same frozen ordinary-memory snapshot through the real `UserPromptSubmit` hook, which replayed a cached reply. The snapshot is one Agent Memory recall per repo:
  - a lexical query on the repo name
  - personal profile only, with `me` excluded
  - as of 2026-11-11 05:00 UTC
  - the production scrub and the 600-token formatter

  | Repo | Tasks | Records | Context characters | Context SHA-256 |
  |---|---|---|---|---|
  | `bettergit` | T1 to T3 | 2 | 1,525 | `57e5bbca004b28c8f24b0e80db8a7b5fd4be8672ac62863ffe3e51dc56177dc4` |
  | `agent-memory` | T4 | 1 | 489 | `3b6cb96c9fc3d00acb5152fbcf279b2871c6b3171cca244513c434b9478d8a85` |
  | `postplan` | T5 | 0 | 0 | empty |
  | `browser-mcp` | T6 | 0 | 0 | empty |

- **Facts in arm B only.** For T1 to T3, arm B also received the unchanged 232-byte facts context (SHA-256 `78715f28…`). Arm A never received it. T4 to T6 had no facts in either arm.
- **Delivery marker.** This is experimental evaluation instrumentation, not shipped behaviour.
  - The hook appended an unpredictable `EVAL_FACT_DELIVERY` value after the unchanged core. That value was never in the prompt or in any file the model could read.
  - The prompt asked only that the first answer copy the ordinary-snapshot and fact-delivery markers actually present, or say `NONE`.
  - The core and the full payload were checked locally by SHA-256, separately.
- **Receipts.** The first pair passed its gate before the other five pairs ran. All 12 runs matched on all four checks: the ordinary marker, the fact-delivery marker, the core hash and the full payload hash.
- **Isolation.** Codex's own memories were off, and no MCP servers were configured in either arm.
- **Loop guard on in both arms.** It recorded metadata counters only.
- **Shell-only file writes in both arms.** This was declared before the run, to avoid the native file-change failure seen earlier. It is not a product fix and was not tuned on outcomes. No run made a native file change or used a forbidden command.
- **Scope.** A frozen, historical, per-project snapshot of ordinary memory, not live adaptive retrieval.

### Results by task

| Task | Repo | Ordinary records | Fact relevant? | A | B | Notes |
|---|---|---|---|---|---|---|
| T1: print windows with Quartz, or `quartz-unavailable` | `bettergit` | 2 | Yes (`import Quartz`) | Pass | Pass | |
| T2: make a 64×64 PNG with tools already on the Mac | `bettergit` | 2 | Yes (`import PIL`) | Pass | Pass | B's one failed command has the same command hash as the harmless tool-presence check in the supplementary run. |
| T3: switch `gh` to an offline test account | `bettergit` | 2 | No; B got unrelated repo facts | Fail | Pass | Control. A did not complete the account switch. |
| T4: run the repo-facts tests and report counts | `agent-memory` | 1 | No facts | Pass | Pass | Control. |
| T5: find the API-key delete handlers | `postplan` | 0 | No facts | Pass | Pass | Control. |
| T6: count the registered MCP tools | `browser-mcp` | 0 | No facts | Pass | Fail | Control. B reported 38 tools; the answer is 42. |

Completion: A 5 of 6, B 5 of 6. Relevant tasks: 2 of 2 in each arm. Controls: 3 of 4 in each arm.

### Input tokens

| Scope | Arm | Input | Cached | Uncached | Output |
|---|---|---|---|---|---|
| Relevant tasks (T1, T2) | A | 111,354 | 72,960 | 38,394 | 833 |
| Relevant tasks (T1, T2) | B | 131,511 | 92,032 | 39,479 | 1,013 |
| Controls (T3 to T6) | A | 310,302 | 228,992 | 81,310 | 1,816 |
| Controls (T3 to T6) | B | 349,285 | 224,512 | 124,773 | 2,119 |
| All 12 runs | A | 421,656 | 301,952 | 119,704 | 2,649 |
| All 12 runs | B | 480,796 | 316,544 | 164,252 | 3,132 |
| All 12 runs | Both | 902,452 | 618,496 | 283,956 | 5,781 |

On the relevant tasks, B used 20,157 more input tokens (+18.10%), 1,085 more uncached (+2.83%) and 180 more output (+21.61%). No cost rates are set, so there is no dollar figure.

### Failures and loops

- Failed shell commands: 2 in each arm. Both of A's were in T3. B had one in T2 and one in T3.
- Repeated identical failed shell commands: 0 in every run, under the definition in the manifest. No repeated loops were found in these traces.
- The loop guard saw 32 hook events across both arms. All 32 had an unknown outcome, and it sent 0 nudges. It reads only Codex MCP results that carry an explicit `isError`, and these tasks used the shell. Its coverage and value remain unestablished.
- This does not show that the rules are sufficient, or that no loop was missed.

### What this does not cover

- Only 6 pairs, of which 2 had a relevant fact.
- A frozen historical snapshot of ordinary memory, not live adaptive retrieval or everyday use.
- The shell-only write rule and the delivery marker differ from normal use.
- No total cost of the whole evaluation effort: the excluded attempts below lack complete data.

### Supplementary: empty-context run (v2)

All 12 runs completed, with both arms on empty ordinary memory context. That makes it a transport check, not the primary result. It did not demonstrate a benefit:

- Completion: A 4 of 6, B 6 of 6. Both gains were on controls.
- Relevant-task uncached input: 34,492 for A and 55,408 for B (+60.64%).
- In T1, the native file-change operation failed once in each arm, cause unknown.

### Excluded attempts

None of these count toward any result.

| Attempt | What happened | Tokens |
|---|---|---|
| First pilot | Wrong sandbox setup: an empty `TMPDIR`, a login shell and denied patches. The task did not complete. | 48,626 input, 28,544 cached, 752 output |
| Earlier 12-call run | Invalid: reused pilot files, a sandbox `EPERM` in both arms of two tasks, no proof that the model received the facts, and repeat counts not recorded. | Raw data no longer available |
| v3 first pair (2 calls) | Stopped at the first-pair gate. Its receipt wording, which asked for "session-start statements", was ambiguous: B answered `NONE` for facts while the hook had sent the exact facts core. Not counted as a pass. | 92,968 input, 54,912 cached, 38,056 uncached, 700 output |

### Data

The public data is committed byte for byte in [`evaluations/repo-facts-2026-11-11/`](evaluations/repo-facts-2026-11-11/). It holds no raw traces and no ordinary-memory text.

| File | SHA-256 |
|---|---|
| `primary-v4/public-results.json` | `1c9fe308b9b262dec572fa67247b0fb70d3c6dc1bb5b5a6741474eeff39f6304` |
| `primary-v4/manifest-v4.json` | `882a8566170c362d57410d96c023a182b7e4fcaf5166defc2889f11b558b0db4` |
| `primary-v4/metadata.json` (ordinary-memory snapshot metadata) | `36ca42427ed9d701880327664c521a069c08a1fe0bf68229f9243b635f0cfc93` |
| `primary-v4/references.json` (also used by the v2 run) | `a79b45f876c76789fa62693f3fb4e58d17218b1fc6b5b6966077849a323acd04` |
| `supplementary-v2/candidate-results.json` | `77e13e9013c14ac2f7e5947263dc3eb552c282401ff0a6227de332313cff3042` |
| `supplementary-v2/manifest-v2.json` | `dafd85f4025a9c97c67def0630fa4a9591e21970eeb2472a68cfaa030c647478` |
| Facts core / full v4 payload | `78715f2839098c1d26080f25c1fc7e7075246342e1c9e87f67bbeda974cb4e8a` / `f508128f89e8a16acf6d7385ef5d95692505720fd4c6b96edeb24258da760d39` |

### Decision on the Codex-backed loop check (#103)

#103 stays design only: no implementation and no provider judge call. The primary run found no repeated failed commands, so it shows no concrete missed loop that would justify a paid checker. The guard's coverage of Codex shell runs is not established, so this is not evidence that the rules are sufficient. Revisit only when a concrete missed loop appears.

## Isolated synthesis call, 2026-11-11

The owner approved exactly one isolated real synthesis call on 2026-11-11. It ran once and passed.

- One queued job made exactly one provider call through the product path: `synthesize()` and the confined Codex runner, on `gpt-6-luna` at low effort.
- The daily slot was charged before the call.
- The input was one recorded, redacted command digest, scanned before the call.
- The model returned a valid, empty fact list: 0 proposed and 0 accepted, so nothing needed an upload. An empty list is a valid result for this pipeline.
- Usage: 13,541 input tokens, 0 cached and 14 output. `cost_usd` is null because no rates are set.
- The event stream held only the agent message, with no tool events.
- The confinement controls passed outside the sandbox, and the canary, home and network probes were denied inside it.
- After the call, normal synthesis and injection stayed off and the Codex login link was removed.

What this call does not show:

- It does not revalidate every fixture.
- It did not exercise acceptance of a real proposal. The fake-provider tests in `local/facts-synth.test.mjs` cover acceptance.

<details><summary>Proof</summary>

| Item | Value |
|---|---|
| Source | `ebd91f001f7b1d52c08004c07b5af003a49a2799`; runtime JavaScript and fixture matched it |
| Confined runner config SHA-256 | `548736e6f247ee9296a9088afd887ba77e5adde56e7c7614b570b007b0e7af27` |
| Model and effort | `gpt-6-luna`, `low` |
| Provider calls | 1 |
| Tokens | input 13,541; cached 0; output 14 |
| `cost_usd` | null |

</details>

## Privacy and data-loss review, 2026-11-11

The independent review first read source `f917866` and found 1 P1 and 4 P2 issues. A follow-up review closed each finding against the fixes now in `ebd91f0`.

| Severity | Finding | Fix | State |
|---|---|---|---|
| P1 | The command digest split command output into lines before the scrub, so fragments of a secret spanning several lines could survive into the digest and reach a future proposer call. | `local/facts.mjs` now scrubs the whole output before splitting it into lines. | Closed |
| P2 | The similarity pass did not skip the `repo-fact` scope, so after a point-in-time restore an ordinary memory could get a similarity link to a fact that held a vector. | `src/profile/similar.ts` skips `repo-fact` nodes in both the neighbour check and the maintenance-item target check. | Closed |
| P2 | Legacy Codex `exec_command_end` events with a shell `apply_patch` added no edited-file hashes, so the disjointness check could miss edits. | `local/facts.mjs` reads the patch headers from those events too. | Closed |
| P2 | A scheduled run with nothing else to do returned idle without sending fact reports that were still pending. | `local/agent-memory.mjs` checks `hasPending()` from `local/facts-client.mjs` before it goes idle, whatever the synthesis switch says. | Closed |
| P2 | A successful command whose text named a host, such as an `rg` search of a README, counted as a false `network` contradiction. | `local/facts-detect.mjs` counts a host only for a recognized network command aimed at it. The same rule now decides when a session exercises a `network` fact, so the firing-rate denominator no longer counts mentions. | Closed |

Not findings:

- Deterministic reports that follow the approved capture setting without a new switch.
- Exact-id graph access and the profile boundary, judged non-blocking.

Confirmed by the review: Codex CLI 0.167.1 reports `input_tokens`, `cached_input_tokens` and `output_tokens`, the fields the cost log reads. The review checked the compiled binary and the [non-interactive mode docs](https://learn.chatgpt.com/docs/non-interactive-mode). The one approved isolated call has run and passed, and normal synthesis stays off.

## Known limits

- The daily synthesis cap of 3 is per device. No counter is shared across machines.
- Activation needs 3 confirming sessions in one device's chain. Confirmations from different devices do not add up.
- A model's citations show that text appears in the digests. They do not make a fact true. A proposed fact stays a candidate until later sessions confirm it with their own evidence.
- An attempt whose run died has an unknown outcome and token use. The cost log says `unknown` and null counts, not zero.
- `cost_usd` is null unless the owner sets `facts.synthesis_rates`.
- A `network` fact counts only these commands, in simple forms: `curl`, `wget`, `http` and `https` with one URL; `ssh`, `ping` and `nc` with a host; and `git clone`, `fetch`, `pull`, `push` and `ls-remote` with a URL. Any other form of a network command is not attributed to the fact: it neither contradicts nor exercises it.
- Codex reports a tool failure to the loop guard only for MCP results with an explicit `isError`. Codex shell results are skipped.
- There is no dashboard view for facts. The owner uses `GET /api/profiles/:p/facts` and the existing node actions.
