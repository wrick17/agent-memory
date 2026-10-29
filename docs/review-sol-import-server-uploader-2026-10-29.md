# Import server and uploader review, 2026-10-29

What this change does: It copies exported BothQ and curated Markdown memory into profile stores through stage, prepare, account binding, publish and link. It preserves imported requests for legacy replay and supplies a resumable foreground uploader.

Independent reviewer: Sol. Original implementation author: Opus. Scope is the new import server, schema, cost model, uploader, replay and changed core callers. Export E1-E6 and shared-redactor closure belong to the separate review. No implementation fixes were made.

## Verdict

Five reproducible findings: one P1 and four P2. Fix S1-S5 before a real-data rehearsal or production copy. The frozen code is suitable for a separate **synthetic diagnostic rehearsal** with isolated bindings; this review does not establish that a real-data rehearsal passed. Production imports must remain closed in this version.

This is a technical disposition, not a new owner-approval requirement. BothQ remains the only live system. No source switch, capture installation, deployment, upload or live database write occurred.

## Source pins and environment

- Workspace: `/Users/pratyush.poddar/Projects/personal/memory`, branch `phase2-capture`; comparison base `dc749dc`.
- Freeze manifest: `/tmp/agent-memory-import-review-freeze-20261029.json`, 51 files. Its own SHA-256 is `54387639ea1d2c7bf8f6725a33a58ce2cce5d41a16f86d4c1a442bcde008c6d9`.
- Source aggregate, checked before and after review: `651198a4460d77f5979c7981ceee3d99b5e294e22420f37241ffcd0aa13fbbc5`. Computed as SHA-256 of the sorted, compact JSON path-to-SHA-256 map. Every file matches; no drift.
- Probes used a mode-0700 throwaway copy, actual local workerd SQLite Durable Objects and local R2. AI and Vectorize use the repository's test fakes. Network redirect probes used two loopback HTTP listeners and synthetic records only.
- Existing dirty source state was preserved. The only repository addition by this review is this report. Parent is the sole BothQ journal writer; this reviewer made no memory writes.

## Must fix

### S1. P1: redirects forward import bodies outside the configured origin

**Source:** `local/upload.mjs:62`, initial URL validation at `:28-35`.

**Trigger:** A configured endpoint returns HTTP 307 with a different origin in `Location`. The uploader uses Node's default redirect policy. The real-fetch loopback probe sent a valid two-command synthetic batch through that response.

**Observed:** The second origin received 2,381 bytes of the import body and supplied accepted receipts; the uploader reported `done`. Node removed the cross-origin Authorization header, so this is a body disclosure, not a demonstrated bearer-token disclosure. The test used the supported loopback HTTP exception; it did not contact an external host or test a live TLS downgrade.

**Impact:** The configured HTTPS/origin check controls only the first request. A redirect can send private memory and provenance to another destination, including one that did not pass that check. It can also acknowledge a batch that never reached the configured Worker.

**Minimal fix:** Set `redirect: "manual"` and stop on every redirect before sending a body to another location. Add one actual-fetch regression proving the redirect target receives no request. No redirect-following feature is needed.

### S2. P2: resume accepts a changed batch schedule and silently omits commands

**Source:** `local/upload.mjs:49-56,84`; `local/migrate.mjs:613-621` is the checked-plan boundary the uploader relies on.

**Trigger:** Make the normal 30-record, 60-command, two-batch synthetic plan. Acknowledge batch 1 and stop on batch 2. Change only the second entry's `batch` number in `batches.jsonl` to `1`; leave commands, their manifest hash and upload state untouched. Resume.

**Observed:** `dryRun` accepts the schedule. Resume sends zero requests and returns `status: "done", done: 1, batches: 2`. Ten commands from the original second batch were never sent.

**Impact:** The uploader binds acknowledgements to batch numbers while its state identity binds only command bytes. Duplicate, missing or reassigned batch entries can turn an incomplete copy into a successful run. This is independent of E6's export-bundle integrity fix.

**Minimal fix:** Validate contiguous unique batch numbers and exact ordered coverage of all command indices. Include the validated batch schedule in the upload-state identity and refuse a mismatch before skipping acknowledgements. A missing or malformed schedule must fail closed.

### S3. P2: staged request IDs can be taken by a different profile

**Source:** `src/api.ts:183-201`; `src/account/store.ts:144-156,175-179`.

**Trigger:** Stage a record and its genuine legacy save request into `work`, then pause before finalize. Send that save's arguments and request ID through ordinary MCP with `profile: "personal"`. Finalize the work record.

**Observed:** The ordinary call returns `created`, rather than `busy`, and creates a personal record. Finalization then returns `request_conflict`. The legacy request's profile row exists, but its account-wide binding does not exist until finalize.

**Impact:** A retry routed to another profile during staging can create a duplicate and permanently take the request ID from the pending import. The declared request-ID fence before publication holds only inside the staged profile. Source data remains intact, but the promised globally resumable first copy fails for this interleaving.

**Minimal fix:** Reserve imported request IDs account-wide in bounded pending bindings before a stage acknowledgement makes them eligible for retries. Ordinary calls must return `busy` for those pending bindings. Keep the current prepare/bind/publish ordering and ensure retries repair a crash between reservation and stage without permitting another profile to take the ID.

### S4. P2: a hosted creation can expose and then receive unfinalized staged rows

**Source:** `src/profile/import.ts:72-86`; `src/profile/write.ts:143-146,259-260`; history reads in `src/profile/read.ts:67-83`.

**Trigger:** Submit a two-part import whose record ID equals a future hosted memory's `newMemoryId`. Stage an entry at revision 2, create that memory through ordinary MCP, then submit the second staged entry at revision 3.

**Observed:** Hosted creation succeeds. Its history immediately includes the first unpublished entry. The second stage also returns `stored`, and that unpublished entry enters the hosted memory's current content. The import record is still `staging`; it was never prepared or published.

**Impact:** New stages check for an existing node only when no import ledger row exists. Ordinary creation checks nodes, not pending imports. Together, they allow staged data to attach to a hosted record without a committed hosted revision or publish. This requires a deliberately selected ID; normal BothQ and Markdown planner IDs use different seeds from new hosted IDs, so no accidental UUID collision was claimed.

**Minimal fix:** Reject ordinary creation of an ID owned by an unpublished import, and reject each new stage if that ID now has a node. Preserve replay of an already accepted part. The two checks protect both sides of the interleaving without changing normal identity-conflict handling.

### S5. P2: import can persist explicit contact attributes despite the any-node privacy rule

**Source:** `src/api.ts:106-113,127-131,176`; `src/profile/import.ts:149-154`; existing policy and implementation at `docs/architecture.md:456,510` and `src/domain/guard.ts:19-25`.

**Trigger:** Finalize an allowed `journal` memory with explicit top-level `attrs.email` and `attrs.phone` fields holding synthetic contact values. Its body and other attributes are ordinary memory/provenance data.

**Observed:** Stage and finalize return `stored` and `published`. Direct SQL inspection confirms both contact keys and their values remain in `nodes.attrs`. The secret redactor does not classify those fields as secrets.

**Impact:** The approved rule removes contact attributes from **any node on every profile**. It is not limited to `person` entities. This probe demonstrates prohibited structured attributes, not a claim that all imported attributes, historical prose or provenance are contact data. The memory-only kind restriction prevents importing people, but does not enforce this separate attribute rule.

**Minimal fix:** Check import attributes against the existing `stripPersonal` rule and refuse/hold the affected record instead of silently rewriting its lossless import. Keep benign provenance. A memory-kind exception would change the approved privacy contract and is not present in the frozen design.

## Verified okay within the tested limits

- Profile v2-to-v3 upgrade preserves the existing revision and request fields tested, adds the import columns, accepts legacy append revisions and retains revision tombstone behavior. An independent account v1-to-v2 probe preserved an existing modern request binding, including its original operation, hash and sequence, with `legacy = 0`.
- The ordinary import path remains invisible before publication through ID get with history/retired enabled, name lookup, inventory and lexical recall. The same-profile staged request returns `busy`; S3 and S4 state the additional interleavings that fail.
- The published BothQ fixture replays with the genuine legacy hash before modern binding can reject it. Changed arguments fail, the stored SQL result stays byte-exact, and replay does not advance the node revision. Returning `action: "replayed"` is the deliberate response annotation.
- A 664-request record binds in batches of 400 and resumes across the tested before-publication and after-publication interruption points. Ordinary same-name/different-ID hosted creation is preserved and publication refuses the collision.
- Import requires owner authentication or an import-scoped token, checks profile permission and the deployment allowlist, refuses `me`, checks command hashes, and rejects a 51-command or over-1,000,000-byte envelope. Redaction-needed input and changed staged parts/records are refused. Owner acceptance and the empty production allowlist were traced in source, rather than exercised against production.
- The server ignores claimed part costs for enforcement. The supplied lengths-only extreme shapes pass the measured per-statement `rowsWritten` and UTF-8 parameter accounting. A command exceeding that row budget rolls its texts and part ledger back whole.
- Supersession link checks require existing same-kind endpoints, record `basis = identifier` and `actor = migration`, and replay without duplicating the edge. Staged records with no node cannot be linked.
- Import accepts memory kinds, not the project/person/component/ticket/feature/bug kinds used by `knowledgeTerms`. Its lack of entity-term registration is therefore not itself a finding. A work import and legacy replay did not bypass the existing `me` sensitive-term refusal. Replaying a work request with `profile: "me"` returned the work result and created nothing in `me`.
- Config/token ownership and modes, initial non-loopback HTTPS validation, private atomic state writes, bounded network/5xx/429 retry, stop-on-refusal and unchanged-plan response-loss replay behave as implemented. S1 and S2 qualify the destination and resume guarantees.
- Rehearsal config uses a distinct Worker name, locally bound Account/Profile classes, separate Vectorize index and R2 bucket, and `IMPORT_PROFILES = test`. Production's allowlist is empty. This is configuration evidence; no deployed namespace/resource isolation was claimed. Imported source provenance is retained, and there is no new immutable-data rule preventing the future work wipe. Wipe, backup and cross-machine implementation were not requested or added.

## FTS row-accounting result

The documentation's caveat was investigated; it was not accepted as proof of safety. On real workerd SQLite, one accepted 190-live-row stage reported 956 `rows_written`, while the connection's `total_changes()` increased by 3,499. A direct text-insert transaction showed additional changes at commit. A separate accepted 198-row stage reported 996, while `total_changes()` rose further; that import probe did not show an additional post-callback change count.

These are different counters. [Cloudflare documents `rowsWritten` as a consumed-query statistic](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec); [SQLite documents `total_changes()` as connection-wide row mutations including triggers](https://sqlite.org/c3ref/total_changes.html). I did not equate the second counter with Cloudflare's billed `rowsWritten`, invent a Cloudflare 1,000-row transaction limit, or reproduce a rollback failure/resource failure from deferred FTS writes. Thus there is no ranked platform-limit finding from that discrepancy alone. The tests establish the surfaced `rowsWritten` bound, **not a bound on every SQLite internal mutation**. If the requirement is literal internal mutations, the accepted 190-row probe already exceeds 1,000 on that measure, and this implementation cannot be called verified against that stronger invariant.

## Commands and reproducible evidence

The retained synthetic harness is `/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-review-sol-20261029-lvs_0tf1` with the repository's existing `node_modules` linked. Source and fixture copies match the freeze. It contains no real export or memory content.

Run from that directory:

```sh
npx vitest run test/import.test.ts
node --test local/upload.test.mjs
npx vitest run test/review-sol-probes.test.ts --reporter=verbose --silent=false
node --test local/review-sol-upload-probes.test.mjs
```

Results: 7 existing Workers import tests, 4 existing uploader tests, 8 independent Workers probes and 2 independent uploader probes passed. Passing independent assertions reproduce S1-S5 or verify the named controls; they are not assertions that those defects are fixed. The Workers plugin emitted the existing test-environment AI/Vectorize configuration warnings and MCP emitted a JSON response-mode notification warning; AI/Vectorize were local fakes as configured.

An earlier manual UTF-16 split probe changed a body hash, but the planner already avoids splitting surrogate pairs. It was excluded as a normal-plan regression. An earlier hypothesis that the commit-only counter necessarily pushes a near-budget import over 1,000 was not reproduced and is not a finding.

The source freeze is rechecked after this report is written. No combined/full suite, actual export, hosted rehearsal, production call, real AI/Vectorize call, token refresh, backup/restore or physical cross-machine check was run. Terra owns combined verification. Refresh/conflict for changed post-copy records, the full compatibility matrix/golden queries and explicit `me` import remain the stated deferrals; none is newly requested here.

Verdict: fix S1-S5 before copying real data. Current test proof supports isolated synthetic diagnosis only. The stronger SQLite-internal-mutation budget remains unverified as described above.
