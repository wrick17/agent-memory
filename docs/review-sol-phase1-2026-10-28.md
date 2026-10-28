# Phase 1 implementation review

2026-10-28. Independent Sol review of the untracked implementation before deployment.

What this change does: Adds the authenticated MCP Worker, profile SQLite stores, revisioned memory writes and reads, lexical/vector recall, device settings, and CI. BothQ remains the sole live memory system.

**Verdict: fix F1-F5 before deployment clearance.** Two P1 and three P2 defects reproduced locally. No P0 found. Pending live gates are listed separately below.

## Must fix

### F1. P1: An uncommitted request binding bypasses the `me` guard

**Location:** `src/mcp.ts:126-131`; binding happens at lines 111-119, before guard execution. `src/account/store.ts:155-157` releases bindings after refusal.

**Trigger and impact:** Send two overlapping identical `save_memory` calls with a request ID, `profile: "me"`, work repo context, no `company_free`, and a work-sensitive term. The second call sees the first call's binding and skips every `me` check, although no guarded write has committed. Work detail enters `me`, which joins other profiles' default recall. A crash after binding and before guarding leaves the same unsafe state.

**Evidence:** `/tmp/am-phase1-review-gb0ebmnc/focused-results.log`, test `F1b`, records one `me_requires_company_free` refusal and one successful `created` result in `me` for content containing `Sequoia-Engineering private roadmap`. Test `F1` in `results-3.log` independently seeds only the pre-guard binding to model a crash; retry also creates the forbidden record. Existing G4 tests cover sequential refusals, not these cases.

**Minimal fix:** Distinguish a committed profile request result from a pending account binding. Only the former may bypass the guard for replay; any retry that can still mutate storage must pass the guard. Preserve the committed replay behavior after routing changes.

### F2. P1: Replacing journal content permanently removes append history

**Location:** `src/profile/write.ts:129-130`, reached by `update()` at line 304; `src/profile/read.ts:64-72` reads append history directly from those entry rows.

**Trigger and impact:** Create a journal, append an entry, then replace its content with `save_memory` by ID. `writeBody()` deletes every prior append row. Those rows are the only stored append deltas; the replacement snapshot contains only the new content. The earlier journal revision and its text become unrecoverable through history, contrary to the phase-1 preservation contract.

**Evidence:** Test `F2` in `results-3.log` observes history `[1, 2]` before replacement and `[1, 3]` afterwards. Revision 2's `irreplaceable historical delta` disappears. BothQ's `memory_store.py:1089` writes a separate append revision, and its history reader at lines 1193-1229 retains that revision after an update. The current local history test never replaces content after appending.

**Minimal fix:** Retain earlier append chunks as non-live history instead of deleting them. Keep them out of current content and FTS, preserve sequence stamping, and retain bounded writes.

### F3. P2: Appended journal content never updates its embedding card

**Location:** `src/profile/write.ts:362-367`; connected indexing bug at `src/profile/index.ts:28-30`.

**Trigger and impact:** Create and embed an empty journal, then append its first substantive content. Append changes neither `card_hash` nor the embedding due state, and the alarm reads only `part = 'body'`, excluding entries. The journal still reports `embedded`, but semantic search never sees the appended content in the promised first 1,200 characters. This also affects saves with a short initial body.

**Evidence:** Test `F3` in `results-3.log` observes `embedded` before and after the first append, with `card_hash == embed_hash` still describing the empty journal. Computing the existing `cardText()` over current content yields a different hash. Existing vector coverage indexes content supplied at creation only. BothQ marks an append for embedding at `memory_store.py:1088`.

**Minimal fix:** Update the card hash and arm embedding when an append changes the bounded first 1,200 characters. Have the alarm embed that same prefix across body and entry chunks. No full-journal scan is needed.

### F4. P2: The 1 MB transaction guard counts characters instead of bytes

**Location:** `src/profile/write.ts:31-35`.

**Trigger and impact:** Supersede 90 valid records, each with a description of 4,000 CJK characters, in one accepted save. The counter adds JavaScript string lengths, so multibyte text commits beyond the agreed 1 MB transaction envelope. The claimed phase-1 size refusal does not hold for ordinary Unicode data.

**Evidence:** Test `F4` in `results-3.log` returns success. SQLite reports the 91 newly written revision snapshots alone total **1,149,497 UTF-8 bytes**, versus 429,497 SQLite characters. That exceeds both 1,000,000 bytes and 1 MiB before counting the other touched rows. This is a local contract violation, not a claim that a future export was run or failed.

**Minimal fix:** Count encoded bytes, for example `Buffer.byteLength(p, "utf8")`, in the transaction budget and retain rollback on overflow. Add this case to the existing write tests.

### F5. P2: Device expiry accepts already expired tokens with ISO offsets

**Location:** `src/account/store.ts:128`; creation accepts and stores the original timestamp at lines 197-204, reached from `src/api.ts:75`.

**Trigger and impact:** Create a token with a valid ISO expiry using a positive timezone offset. Validation parses it, but authentication compares the original string lexically with UTC `now()`. An already expired token can remain authorized for hours past its deadline, retaining its granted read/write access.

**Evidence:** Test `F5` in `focused-results.log` creates expiry `2026-10-29T05:32:02.034+14:00`, which parses to `2026-10-28T15:32:02.034Z`. At `2026-10-28T15:33:02.038Z`, account authentication still returns `ok: true` for the device. No existing test exercises expiry.

**Minimal fix:** Normalize validated expiry to UTC ISO before storage, or compare parsed epoch times during authentication. Invalid stored dates must fail closed.

## Review evidence and limits

- Read the recursive global instructions, repository `AGENTS.md`, feature manifest, implementation report, authoritative architecture sections 5, 7, 8, 9, 11, 19 and 22, every `src/` and `test/` file, package/lock/tooling configuration, generated binding declarations and CI. Compared relevant contracts in BothQ's `memory_mcp.py`, `memory_store.py`, `memory_search.py`, `memory_privacy.py` and `memory_config.py` without changing them.
- Checked connected paths for scoped-device isolation, owner API/session authorization, JWT/JWKS failure handling, routing/replay, concurrent appends, content/inventory cursors, supersession, provenance, redaction and generation-qualified vectors. No additional consequential defect established within this bound. The author's 30-test claim and Terra's combined verification are separate evidence, not a review clearance.
- Ran the existing focused history test: **1 passed, 3 skipped**. The isolated fault suite produced **4 expected contract failures and 1 pass**; the later focused run produced **2 expected contract failures, 1 pass and 4 skipped**, covering F5 and the second F1 trigger. The passing repeated check resolved missing captured timeout output, rather than repeating the bulk suite.
- The concrete query-embedding fault check supplied an indefinitely pending AI promise. Recall returned one lexical result in **1,020 ms**, with `lexical_only: true` and `diagnostics.embedding: "unavailable:timeout"`. The agreed separate 1 s embedding bound works on this path; this is fault-path evidence, not a live latency benchmark or a 300 ms end-to-end claim.
- Retained harness, configuration, source hashes and logs in `/tmp/am-phase1-review-gb0ebmnc/`. Run with `node /Users/pratyush.poddar/Projects/personal/memory/node_modules/vitest/vitest.mjs run --config /private/tmp/am-phase1-review-gb0ebmnc/vitest.config.ts` from `/private/tmp/am-phase1-review-gb0ebmnc`. The config uses real SQLite DOs and local R2 with the existing AI/Vectorize fakes. Initial harness attempts failed before tests because of temporary-path resolution; using the canonical `/private/tmp` root and relative fake script resolved that. Those failures are retained, not attributed to the product.
- Reviewed snapshot: per-file SHA-256 manifests are `snapshot-before.json`, `snapshot-after.json` and `snapshot-final.json`. The sorted semantic file manifest hash is `97af0d48097f735e2d8299f3fd1dad85393cedfa0f2151c28bf15800c2139aa1`. No recorded application, test, package, tooling, CI, architecture or implementation-report hash changed during review. The final check observed a concurrent feature-manifest evidence update, recorded separately below. `wrangler.jsonc` remained `655b6a1d5b36bd6ff7e5fddecdb150976f71c8e87de37d1a9a64c5c391cf9b49`.
- Concurrent evidence changed: Terra added `docs/phase-1-verification.md` and updated infrastructure evidence. Its report records the combined 30-test pass, current generated types, dry-run bundle, and a synthetic live embedding with 1,024 dimensions. The final feature manifest updates AM-01/AM-02 with the infrastructure results and a parent follow-up confirming the `kind` String metadata index. Its final observed hash is `10b2e3bc72ba3c3aeaf63d7c9bdd475872e36e2904c58fbb06698c2fa4831274`. These are concurrent reported observations; this review made no provider calls and independently proves none of the live gates.
- The declared `created` result, append hash chain, case-insensitive name lookup and inferred journal kind are not findings. Reviewed BothQ dispatch/callers do not establish a production consumer broken by those declared differences. Cross-profile moves, capture, graph expansion, compaction/undo, restore/wipe and imported legacy requests remain in their assigned later phases.

## Live gates remain separate

G1 T1-T6, including real Claude Code/Codex OAuth, resource audience, `memory` scope, negative real-token cases, refresh and headless client access, remain unrun by this review. Live G5, physical-machine G3, browser Settings sign-in and the live use of the metadata index are also unverified here. The final manifest reports that the parent confirmed metadata-index readiness. Terra's measured embedding size does not close the remaining G5 checks.

Keep resource-bound audience **and** the `memory` scope. The older suggestion at `docs/phase-1-implementation.md:77` to empty `REQUIRED_SCOPE` is superseded by the owner's explicit instruction and must not be followed. Use only the specified auth fallback if the real G1 test requires it.

Only this report was written in the workspace. No source fix, commit, push, deployment, resource creation, client/hook change, user-file deletion or live hosted-memory write was performed. BothQ received no review writes; the parent remains its sole journal writer.

Not checked: Full-suite rerun, live Clerk/AI/Vectorize, browser Settings, second-machine/headless access or later phases. The reproduced guard bypass and history loss block deployment clearance.
