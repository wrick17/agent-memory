# Phase 2 local capture closure review

What this change does: The fixes validate nested digest fields, retain workers through debounce, claim trigger generations, and use exclusive hard-link locking. They also preserve append epochs, consolidate retained text without its source, save acknowledgements before cleanup, and reject unknown event envelopes.

Verdict: L1, L2, L3, L5, L6, L7 and L8 are closed. L4 prevents the original concurrent ownership failure, but one P2 crash-recovery defect remains below. No P0 or P1 remains in this bounded review. Source corrections stay with the same Opus author, without fallback.

Reviewed frozen uncommitted source on `phase2-capture`, HEAD/base `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9`, against the original local review and implementation fixes. Scope was the local client, its tests, and the direct digest/manifest contract. Assumed load is one machine with overlapping hook workers. BothQ recording belongs to the parent.

SHA-256 values were identical before and after review:

```text
local/agent-memory.mjs
before 7735ee7ea8695f86f6d4650b3ede06035eaa65b58931b3dd9b00e58368b1c2db
after  7735ee7ea8695f86f6d4650b3ede06035eaa65b58931b3dd9b00e58368b1c2db
local/agent-memory.test.mjs
before c7ef02c4278d6d4bd7ee7be79906ecbd70f087fd9aa9a2f2c399ca3d48ce09d2
after  c7ef02c4278d6d4bd7ee7be79906ecbd70f087fd9aa9a2f2c399ca3d48ce09d2
src/profile/capture.ts
before faafaf04ab12c08f5bf5370240bc3699f7fb5f972dbc6c4c1f0bcea70d170c75
after  faafaf04ab12c08f5bf5370240bc3699f7fb5f972dbc6c4c1f0bcea70d170c75
```

Reproduce with Node 24.11.1:

```sh
node /tmp/am-closure-sol-4Ig2Qg/repro.mjs
node /tmp/am-closure-sol-4Ig2Qg/lock-repro.mjs
node /tmp/am-closure-sol-4Ig2Qg/crash-repro.mjs
```

These scripts assert the observations below and write `results.json`, `lock-results.json`, and `crash-results.json` beside themselves. Each invocation creates private fixture homes. They import frozen product source directly. Servers and models are stand-ins. L1 additionally executes the actual hosted `checkBody`, transpiled in memory with its real Zod schema and redaction function.

| Finding | Closure evidence |
|---|---|
| L1 closed | Eight malformed bodies covering long nested outcomes, object-valued outcomes, unknown nested/top-level fields and oversized entities fail both local and hosted checks. A 280-character outcome passes. A runner returning the original whole long message produces no consolidated upload or manifest and retains pending text. |
| L2 closed | A fresh trigger with private `debounce_ms=80` waits 82 ms before its first upload, stores a manifest, drains its queue and exits. This exercises the real timer with the product default unchanged. |
| L3 closed | An explicit promise barrier pauses the first upload. Two same-source final corrections arrive while it waits. Both survive in consolidated parts; acknowledged ranges tile `[0,87)` and `[87,261)`. A replacement immediately before claim also survives. A hook delivered while the old lock still exists, immediately before unlink, captures its correction in a second manifest through the post-unlock recheck. |
| L4 remaining P2 | IPC barriers make two workers pause before exclusive creation, then separately after both read the same stale lock. Each case ends with exactly one live owner. Killing the sole reclaimer exposes the recovery defect below. |
| L5 closed | Appending to an 87-byte transcript preserves every old byte and the epoch, starts the next range at byte 87, and uploads the old correction exactly once. Rewriting the checked prefix starts a new epoch and acknowledges the rewritten range. |
| L6 closed | After an unavailable-runner capture, delete the private source and disable fallback discovery. Retained text still consolidates, stores its manifest and advances acknowledgement to byte 87. |
| L7 closed | Two child processes stop at filesystem barriers and receive SIGKILL. After text deletion, saved acknowledgement already equals 87. Before acknowledgement rename, saved acknowledgement is zero but the remote manifest exists. Delete pending files and source, restart, and acknowledgement reaches 87 without regenerating parts. |
| L8 closed | Three unknown envelope types before and after a valid final message all return `runtime_warning`. Known envelopes pass; a command item fails. An unknown envelope through consolidation retains pending text and produces no manifest or acknowledgement. |

## Remaining finding

**P2: A dead reclaimer permanently blocks capture**, `local/agent-memory.mjs:89-90`.

Minimal repro is `lock-repro.mjs`, case `L4-reclaimer-crash`. Seed a confirmed dead PID's lock. Pause a child immediately before line 90, after it creates the empty exclusive reclaim marker, then SIGKILL it. Three later `takeLock()` calls return `false`; `run()` returns `locked`. The original lock PID is still confirmed dead. One trigger and its pending text remain intact.

Expected: a successor can reclaim when both the worker and its reclaimer are dead. Observed: the permanent marker makes every successor return at line 89. All future capture on that home stops until manual repair. This is a P2 availability failure, with no demonstrated learning loss. Unlike the declared reused-PID limit, no live process needs to exit to unblock it.

Minimal fix: give reclamation recoverable ownership, so a dead reclaimer cannot leave a permanent veto. Preserve exclusive reclamation and verification of the lock being removed. Keep the deterministic contention tests and add this crash case.

Confinement config is byte-identical to the reviewed snapshot. Installed CLI reports `0.165.0`; tools remain off, curl retains `-v`, and only explicit permission denial passes the classifier control.

Not checked: full suites, live ingest, real sandbox/model runs or model parity. No application, test, configuration, manifest, credentials, global state or hosted records were changed; only this report and private repros were written.
