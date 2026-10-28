# Phase 2 capture, independent local review

What this change does: The CLI queues transcript capture, keeps local pending text, and uploads consolidated digest parts before requesting a completeness manifest. A confined Codex runner supplies the model output.

Verdict: Fix the eight findings below before installing capture. Source fixes remain with the same Opus author, without fallback.

Reviewed the uncommitted local vertical on `phase2-capture`, HEAD/base `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9`, against AM-09/10, architecture sections 10/12 and phase-2 checks. Hosted reading was limited to the digest/manifest contract.

SHA-256 before and after review, identical:

```text
local/agent-memory.mjs
before 9196e2c3711e5edb59db2bf9ada01bc45fa073b68b029d61e5bd912813f571aa
after  9196e2c3711e5edb59db2bf9ada01bc45fa073b68b029d61e5bd912813f571aa
local/agent-memory.test.mjs
before f7522f80ca725cf61a400340bab92e85c6cd3305689b025fcb5b6dac9e675ade
after  f7522f80ca725cf61a400340bab92e85c6cd3305689b025fcb5b6dac9e675ade
```

Reproduce with Node 24.11.1:

```sh
node /tmp/am-review-sol-local-U6ZDZF/repro.mjs
node /tmp/am-review-sol-local-U6ZDZF/lock-repro.mjs
```

The scripts create private fixture homes on each invocation. Results are in that directory's `results.json` and `lock-results.json`. Servers and models are stubs; the raw-output case also invokes the real hosted `checkBody`, transpiled in memory. No real model runs, credentials, hooks or hosted records are involved.

## Findings

1. **P1: A whole long message passes the local output boundary.** `local/agent-memory.mjs:198-209,310-312,515`. Repro `raw-outcome` returns a 576-character owner message verbatim in `outcomes.tests[0]`, with zero dropped items. Both `rejectPart` and hosted `checkBody` accept it; the upload contains the entire message and receives a manifest acknowledgement. Expected: reject text exceeding the 280-character excerpt limit before persistence/upload. A model following injected transcript instructions can export raw conversation through this field. Minimal fix: enforce bounded outcome strings and strict field shapes in the local schema and validator, with the same check on ingest. This is a validation failure, independent of model parity.

2. **P1: Debounce exits without arranging capture.** `local/agent-memory.mjs:56-58,451-473`. Repro `debounce` queues a fresh Stop and runs immediately. It returns `debouncing` in 1 ms, uploads nothing, leaves the queue, and drops its lock. There is no timer or successor process. Expected: wake after the 45-second idle deadline. A final turn can remain uncaptured indefinitely; subsequent fresh Stop/SessionEnd triggers reset the idle clock. Minimal fix: keep or schedule the detached worker until queued deadlines are due.

3. **P1: Settling an old trigger deletes a newer one.** `local/agent-memory.mjs:461-467`. Repro `trigger-race` appends a final correction and delivers SessionEnd while the first heuristic upload is pending. The new hook observes the lock and starts no worker. The old run acknowledges byte 5100 and deletes the updated queue file, although the transcript ends at 5187. The final correction is absent from uploads. Expected: retain and process the replacement trigger. Minimal fix: consume a claimed trigger generation atomically and continue when another generation arrives.

4. **P2: Lock acquisition can delete another live worker's lock.** `local/agent-memory.mjs:70-75`. `lock-repro.mjs` pauses two workers after each sees no lock, then releases them in order. Both enter ingest concurrently; the second replaces the first worker's lock while both remain alive. Expected: exactly one owner. Concurrent workers can race on shared state, part files and cleanup. Minimal fix: acquire atomically without unconditional unlink; stale reclamation must verify the ownership being reclaimed.

5. **P2: Normal short-file appends create new epochs and duplicate learning.** `local/agent-memory.mjs:102-105,389-400`. Repro `short-append` grows a transcript from 87 to 164 bytes, asserting every original byte is unchanged. The epoch changes, both manifests start at zero, and the original correction is stored twice. Expected: an append captures only the tail under the existing epoch. This repeats earlier decisions/corrections until the prefix reaches 4 KB. Minimal fix: persist and compare a fixed prefix length, extending its baseline after verifying the old prefix is unchanged.

6. **P2: Losing the original transcript prevents consolidation of retained pending text.** `local/agent-memory.mjs:382-387`. Repro `source-gone` first captures without a runner, removes only the private source transcript, then supplies a runner. Result: `source_missing`, zero model calls, one intact pending file, no manifest. Expected: consolidate the saved range independently of source discovery. Capture cannot recover when a client cleans up its transcript, the reason the pending copy exists. Minimal fix: process existing pending ranges even when discovering new input fails.

7. **P2: Cleanup before saving acknowledgement makes a durable capture permanently stuck.** `local/agent-memory.mjs:418,429-442`. Repro `cleanup-crash` interrupts immediately after text deletion, before state save. Restart reports `pending_text_missing`, keeps `consolidated_to=0`, and marks the range stuck despite its durable tiling manifest. Expected: recover the acknowledged range. This obstructs contiguous cursor progress and produces false pending state; the hosted learning itself survives. Minimal fix: persist acknowledgement before deletion and reconcile durable manifests before requiring pending text.

8. **P2: Unknown event envelopes are accepted.** `local/agent-memory.mjs:596-609`. Repro `unknown-event` supplies an unknown `runtime.notice` warning followed by a valid final message. `parseEvents` returns `ok` because an envelope without `item` is ignored. Expected: unknown output fails closed, including future runtime/configuration notices. Minimal fix: explicitly allow known envelope types and reject every other type. Existing tests cover unknown item types only.

Not checked: Terra's bulk checks, real-model parity, live ingest or installation. The single author canary does not prove parity; that remains an open gate, not an additional finding. No source or configuration was changed.
