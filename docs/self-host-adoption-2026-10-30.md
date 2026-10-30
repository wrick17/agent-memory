# Self-host source adoption, 2026-10-30

Reviewed self-host source is integrated over R0 root `e09e5d72df0313bc249c3f49bd439ee3015ac5c5`. AM-18 remains incomplete. Setup is not proven for everyday use. This receipt records source assembly and the combined package, normal-install and offline configuration checks below. No account, resource, deployment, client or imported data changed.

## Reviewed inputs

- Accepted [author capsule](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-selfhost-workersdev-opus-8haX8Or5/capsule/handoff.md). Its seal SHA-256 is `7dadfad1b097aff019c5612a356b469adb38be25680c0f982d93a34712339173`; its 136-file source aggregate is `5885e2c6508f1c270e616c6628a1d7b7b52a1967bdfc413038f5405f781b5d90`. The seven-path patch SHA-256 is `7eeb68ae880521d03a9e74696f00359efeb2141bf9fbc2d2c8eb000b9fbf78b7`.
- Prior [package/setup review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-selfhost-review-0d2h1brn/review.txt), SHA-256 `230f336c8eddc320eae757d5a622f5aab0d796524a9ecd67a6cba4862fcc4527`, and [receipt](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-selfhost-review-0d2h1brn/final-receipt.json), SHA-256 `36bfe616efd924b1a3b114688159e41af37a8db73d221d242dcbb62327ca11c2`, are bounded SOURCE CLEAR for their frozen source. Ownership receipts, hidden owner input, apply exclusion, retry and package closures retain that scope.
- Independent [workers.dev and archive-mode review](/tmp/am-workersdev-review-DbCnmM/review.txt), SHA-256 `7978658ccb6676656524147d8a0de1e8c82938de8826604066eac5e1aa435bde`, and [receipt](/tmp/am-workersdev-review-DbCnmM/receipt.json), SHA-256 `6180151e75f752289aa49c470b18480ca6060ae952464f53164d6c8d5622020b`, are bounded SOURCE CLEAR for the four-path delta.

The author recorded 16 passing setup tests, three meaningful old-source failures, offline Wrangler parsing, custom-domain byte equality, touched lint and type checks. The reviewer independently passed 18 synthetic refusal cases, two offline Wrangler token-output shape checks and staging under umask 077. Those checks used fixtures or installed code, not an owner's account. The old archive's normal-install evidence and the new archive's install with lifecycles disabled do not prove normal installation of this combined result. None of these checks was repeated for this adoption.

## Integration boundary

The accepted seven paths are `package.json`, `wrangler.example.jsonc`, `docs/self-host.md`, `local/setup.mjs`, `local/setup.test.mjs`, `local/package.mjs` and `src/account/store.ts`.

The setup, setup tests, package helper and example config retain the exact accepted bytes. The package manifest preserves every current R0 script and dependency while adding the reviewed version, files, engine, setup and packaging fields. Its local test list is the union, including both `local/corpus-upload.test.mjs` and `local/setup.test.mjs`. The source lockfile is unchanged.

The accepted AccountStore hunk changes only an employer-specific example to `your-org` in a comment. Existing setup identity, routing and RPC behavior already match the accepted source. All current executable bytes remain, including R0's optional profile/generation arguments and synchronous recovery/active-generation check in `addSensitiveTerms`.

Only the new guide's status and corpus facts change from its frozen text. R0 now exports `CorpusStore`, so the existing reviewed setup can render its optional `CORPUS_STORE` binding and migration `v2`. This is source composition, not live corpus or self-host acceptance. The [R0 receipt](corpus-implementation.md#r0-source-adoption-2026-10-30), accepted revision 2 refresh contract and U8/U9 limits are unchanged. No F1 implementation is included.

The manifest changes only AM-18 evidence. Current README, import-verification, owner decisions, all other AM rows, R0 evidence and contracts retain their baseline bytes. Original exclusions and seven physical 0444 files are preserved. At the source handoff, HEAD, index, refs and stash had not been changed by the adoption.

## Remaining gates

Terra verified the frozen 146-file combined source and built its 59-file self-host archive under a private umask. The archive contents, modes, self-contained guide, pinned dependency graph and exclusion of the existing owner values passed inspection. Raw source packing refused as intended. Both the source and the unpacked archive installed with normal npm lifecycle scripts. Typecheck and lint passed; the combined local suite passed 95 tests with one deliberate native skip. Four offline corpus/embedding configurations and the proposed fixture configuration bundled successfully. The unchanged executable Worker source reuses the earlier 291-test Worker result. [Private combined receipt](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-selfhost-final-terra-fqo4ir2v/combined-receipt.json), SHA-256 `be3583be8e14f7fcbd7b90df1e2dc000de9a9bcce4a1c677614d6a4b9e66dbe8`; archive SHA-256 `63392566e40f6c0e003c64f6b164767a44cfe21097500e8ec27a17c9962b92ae`. This is package and offline proof, not everyday-use acceptance.

The packaged setup also produced a read-only plan against the existing personal account and found the proposed fixture names available. It created no resources. Setup defaults import profiles to empty; the proposed fixture-only `test` selection requires an explicit config change after setup, and the generated config must be restored before a setup retry. The exact private plan requires review before any creation or deployment.

A separate authorized Cloudflare and Clerk account still needs actual OAuth/API envelopes and account selection, collisions and creation-receipt refusal, plan/apply/retry and secret preservation, workers.dev deployment with previews disabled and no DNS or route change, public metadata, Clerk auth positives and negatives, and real Claude, Codex and headless save/read/recall/replay. Offline token shapes are not live OAuth proof.

Capture and native-runtime acceptance remain separate. Dashboard work stays last among features. Backup, restore and recovery follow the other features; physical cross-machine acceptance and caller cutover remain in the final rehearsal. Preserve the trial baseline. BothQ remains the sole ordinary writer, running and readable; shutdown is excluded.
