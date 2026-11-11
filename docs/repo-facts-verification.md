# Repo facts and loop guard verification

This page records the gates and evidence for repo facts (epic #105, issues #90 to #103) and the loop guard (#102, #103). It lists what the source does, which checks passed, and which gates are still open. Fill in an open line only from a result that actually exists.

**Status, 2026-11-11:** source and local verification passed at commit `ebd91f0`, pushed for review in PR #110, where CI passed. The feature is not merged, not released, not deployed and not installed. All five findings from the independent privacy and data-loss review are closed. The owner signed off the #100 review on 2026-11-11 and approved exactly one isolated real synthesis call; that call passed, and #100 is closed. Normal synthesis stays off; turning it on is a separate owner step. P3 (#101) is not complete: its setup pilot was invalid and the paired run is pending, so there is no benefit claim.

| Check | Result |
|---|---|
| Worker tests, controlled run (`--no-file-parallelism --maxWorkers=1`) | 25 files, 674 passed, no unhandled errors |
| Worker tests, affected files | 85 passed |
| Local tests (`npm run test:local`) | 297 passed |
| Type check and lint (`npm run lint`) | Passed |
| Isolated Linux install | Passed: all six fact and loop guard modules match source by SHA-256, with every default off |
| PR #110 CI at `ebd91f0` | All checks passed |
| Isolated real synthesis call | Passed: one provider call, valid empty result ([details](#isolated-synthesis-call-2026-11-11)) |
| Privacy and data-loss review | 5 of 5 findings closed |

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
| P3 benefit (#101) | Six paired tasks, memory alone against memory plus facts: completion, repeated failures and cache-aware cost. | Twelve trials are planned: six controlled replays, each run with memory alone and with memory plus facts. Only 2 replays have a relevant eligible fact; the other 4 are controls. Setup pilot invalid; the paired run is pending. The first attempt (trial 1, memory-alone arm) had a wrong sandbox setup: an empty `TMPDIR`, a login shell and denied patches. Its task did not complete. It used 48,626 input tokens (28,544 cached) and 752 output tokens, counted separately from any result. The other 11 trials have not run, and the memory-plus-facts context is not yet verified. The isolated test Worker holds the two seeded facts: bettergit `import Quartz` (exercised 9, fired 8) and `import PIL` (exercised 8, fired 6), with a 232-character injected context (SHA-256 prefix `78715f28`); the other three replay repos have none. No benefit or missed-loop conclusion exists. |
| Codex-backed loop check (#103) | Design only. It is built only if P3 shows that the rules miss real loops. | Design only; no code. |
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
- CI at `d1882bd`: all 674 Worker tests passed, but the run reported one `EnvironmentTeardownError` from a graph test file; its root cause is not established. CI now runs the Worker tests with `--no-file-parallelism --maxWorkers=1`, with no assertion, timeout or error-handling change. That run is pending.
- Expected log lines, not failures: 4 fake-vector log lines and the meter's negative-value validation message are intentional.
- The first full run at `f917866` had resource failures: two 30 s timeouts, a 3,830 ms result against a 3,800 ms deadline, and a Cloudflare test pool startup timeout. They did not recur in the controlled run. Their root cause is not established.

### Earlier scoped receipts, 2026-11-11

- Loop guard: `local/loop-guard.test.mjs` passed 14 of 14 with ESLint. It runs the real CLI hooks and covers concurrency, duplicate tool ids, the off switch, no capture trigger, hash-only state with private file modes, and safe note injection. Not covered, non-blocking: the `agent_id` subagent scope, the CLI's 2 s hook deadline, the 64-id duplicate cap and 7-day pruning.
- Facts: `local/facts.test.mjs` passed 13 of 13, and 6 of 6 targeted `local/agent-memory.test.mjs` cases passed.
- Synthesis: `local/facts-synth.test.mjs` passed 8 of 8 with a fake provider. It covers cadence crash recovery (replaying one completed session after 80 other sessions does not count it twice), the daily cap, retries, the off switch, the cost log, the citation check and the accepted-proposal registry.
- Existing owner-model and profile-isolation tests passed 26 of 26.

### Not run

- [ ] A live Claude Code or Codex client with injection or the loop guard turned on.
- [ ] Merge, packaging release and deployment.
- [ ] P3 paired tasks (#101): setup pilot invalid; paired run pending.

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
