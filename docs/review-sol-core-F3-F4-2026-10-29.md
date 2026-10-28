# Core F3/F4 closure review, 2026-10-29

F3 is closed. F4 is closed. No remaining P0, P1 or P2 was reproduced in the requested scope. This independently reviews the latest frozen fixes on `phase2-capture`, HEAD/base `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9`, plus uncommitted source. It covers the two remaining findings and their directly related regressions. It does not reopen the hosted audit.

Read the original hosted review, its closure, and the implementation's "After the closure reviews" section. Author-reported green runs were context, not independent evidence.

## F3 closed

The original minimal retry now succeeds. Create a work person with a request ID and an email; retry with a different discarded email. The result is `replayed` with the same node ID. Changing either accepted GitHub or Jira handle still returns `idempotency_mismatch`.

New probes also change discarded field names, remove discarded attributes entirely, and compare contact-only, empty and omitted `attrs` on a non-person node. All equivalent sanitized retries replay. SQL confirms unchanged attributes, content hash, revision and stored request result. Each response reports only that call's discarded field names. Those names and contact values do not enter the stored result. A direct ProfileStore call confirms that its own contact filter remains effective.

The fix acts before hashing at `src/mcp.ts:135` and `src/mcp.ts:153`, before binding at `src/mcp.ts:170`. Reporting happens after persistence at `src/mcp.ts:209`; the profile boundary still filters at `src/profile/write.ts:490`. This closes the equivalent-retry failure without accepting changed handles. No further fix is required for F3.

## F4 closed

The reviewer's original schedule now rejects the write. Pause a `me` call before `bindRequest`, register and commit the work person meanwhile, then resume the old context. It returns `me_sensitive_term` and stores no preference. Additional real-RPC probes reproduce that paused-binding schedule for owner-added terms and routing-rule organization terms, with the same result.

Separate dependency-injection barriers pause each registration path immediately before the real `addGuardTerms` RPC. They use actual AccountStore code and Workers SQLite. The account registry already contains every expected term, but registration has not returned and work dispatch has not occurred. Releasing the barrier commits the complete guard batch before success. Work dispatch observes the committed guard rows. Subsequent writes using the unchanged old context reject every registered name, key suffix, GitHub handle and Jira handle. Owner and rule registrations likewise protect stale contexts.

The ordering is implemented at `src/account/store.ts:185`, with callers at lines 251, 258 and 266, and the Worker waits at `src/mcp.ts:192`. `src/profile/store.ts:63` inserts each batch in one transaction. Instrumenting real storage confirms that `src/profile/write.ts:589` reads authoritative guard terms inside the write transaction; rejection leaves neither a node nor a profile request result.

For each registration path, a SQLite trigger deliberately aborts guard insertion. Registration returns `unavailable`. The entire guard batch rolls back, including earlier inserts in the work batch. Account registration remains durable, work dispatch stays at zero, and the new work request binding is released. Removing the fault and retrying repairs the guard despite existing account terms. Finally, committed `me` retries replay after newer terms appear, preserving the node byte-for-byte. Pending bindings and new requests still face the guard. Replay precedes guarding at `src/profile/write.ts:577`. No further fix is required for F4.

## Evidence and limits

The [new probes](/tmp/sol-core-f3-f4-91nr5ekv/test/core-f3-f4.test.ts) pass **13/13**, with [output](/tmp/sol-core-f3-f4-91nr5ekv/independent.log). The unchanged [original probes](/tmp/sol-core-f3-f4-91nr5ekv/test/hosted-review.test.ts) independently pass **13/13**, preserving F1, F2 and F5-F9 and both access/rollback controls. Their [output](/tmp/sol-core-f3-f4-91nr5ekv/original13.log) covers ingest bytes, manifests, history, search, evidence and typed edges. Runs use real workerd/SQLite and local R2, with AI/Vectorize fakes. Trigger-refusal stderr is intentional.

All 20 pinned core source files and eight support files match before/after SHA-256s. The core sorted compact JSON path/hash digest is `372bbc08a1e153689e879083a6321ca1cedf3e1a62187623cf18208798c141ee`. Exact mappings are [before](/tmp/sol-core-f3-f4-91nr5ekv/hashes-before.json) and [after](/tmp/sol-core-f3-f4-91nr5ekv/hashes-after.json). Concurrent new local/import files are outside this pin.

L4 remains open P2, uninstalled and deferred behind owner-priority import. It does not gate core API closure. Legacy BothQ request-hash compatibility remains a separate import concern; preserve historical hashes rather than normalizing them. Full backup/restore and cross-machine checks belong to FINAL.

Not checked: full suite, Terra's combined 59+21 run, parity, benchmarks, deployment or installation. Only this report and private repros were written; no app, test, config, manifest, original review, credentials or external data were changed. BothQ remains the sole live system; its journal belongs to the parent.
