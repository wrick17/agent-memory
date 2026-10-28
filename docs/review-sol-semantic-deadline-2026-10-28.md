# Semantic deadline independent review

No material P0, P1 or P2 findings in the bounded change. Source clearance is independent of deployment and live gate completion.

Reviewed the uncommitted diff on `phase1-reviewed`, base HEAD `07986995bbff010d66c79b95179489767bae7166`, against architecture section 11, manifest AM-01 and AM-06, and the implementation's "Semantic deadline change" section. The accepted shared 3 s budget and per-profile query embedding are unchanged decisions.

## Evidence

- `src/mcp.ts:172-212` checks the read set before fan-out, passes one absolute deadline to every profile, and preserves the cross-profile RRF, ordering and token-budget packing.
- `src/profile/store.ts:81-124` starts AI and synchronous lexical retrieval before awaiting the semantic chain. Embedding and Vectorize share the remaining time. Empty embeddings and provider errors return lexical results. The attached rejection handler covers completion after timeout, including when lexical retrieval throws before the race.
- Namespace selection, generation-prefix rejection, own-generation cleanup, and SQLite status, type, kind and scope filtering remain in place. `src/profile/read.ts` and `src/routing.ts` have no diff. Moving embedding into the profile does not change those checks or fusion.
- Inspected the changed fakes and regression cases for late embedding, late Vectorize, provider failure and embeddings-off behavior. The author's 43-test result is reported evidence, not a run repeated by this reviewer.

Ran `rtk proxy node /tmp/sol-semantic-deadline-review-20261028/repro.cjs`, exit 0. The private check transpiles the exact current `ProfileStore.recall` method and supplies a controlled clock, provider promises and SQL/fusion stubs. Seven grouped checks cover immediate lexical work, successful semantic completion, combined-stage timeout, late completions, empty/error fallback, late rejection handling, embeddings-off and expired arrival. Generation-prefix rejection and namespace/kind query options also passed. No full suite or benchmark ran.

## Nonblocking limitation

There is no deadline guard before AI or after it resolves at `src/profile/store.ts:84-90`. A timed-out embedding can subsequently start Vectorize and overwrite the local `diagnostics.embedding` from `timeout` to `ok`. The check reproduced an embedding completing at 4 s after fallback at 3 s. It left hits, `vectorUsed`, serialized output and cleanup unchanged. Profile RPC returns copied data, so later local mutation does not update the Worker's received page. This is extra provider work and a mutable local diagnostic, without a demonstrated material result regression. It does not justify a P2 blocker under this review's scope. A guard before starting each stage would avoid that work if desired.

## Frozen source SHA-256

```text
src/mcp.ts                 985f74a7d86fc200979cd77fe9c1ee02cbde5f75783671224d997624169811cf
src/profile/store.ts       82d2fe1f9af917cafc458c10374034d74d34852bbbdb0385b9579838e9b19e3e
src/profile/index.ts       26c6cc4ad5bbc6539de9a030e6894f4a4301ec8326ca895f29815d35fe8efd35
src/domain/types.ts        3d9f2ca0502e9089a9f1cee9b85f551bc4bf3e53657357a268ff1cac715ef883
test/fakes.js              e4a299da22fe094ff82f2be1954ee65ba73899550ae8b0836b4a37e6de8c9ecb
test/isolation-recall.test.ts faf4a87d949646d3d888ba6751b1611dc1e814b1e6f3f3a45a7c05788fcd190a
```

Hashes matched before and after review. Only this note and the private check were written. No BothQ or native memory writes occurred.

Skipped combined tests, live services and deployment verification, which remain with Terra. The method check stubs SQL/fusion and does not prove Workers scheduling or provider latency. Late semantic work is not cancelled.
