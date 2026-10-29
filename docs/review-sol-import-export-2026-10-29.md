# First import slice: independent Sol review

What this change does: It exports BothQ and curated Markdown without changing either source, then builds staged import commands and review holds. This review covers only `local/migrate.mjs`, `local/migrate/export_bothq.py`, `local/migrate.test.mjs` and `docs/import-implementation.md`.

Reviewed from base `6ab2380ee3b3182bad3d6a8a5fe9bc130b5ccaa9` through Terra's checkpoint `dc749dc9aad26751d56b02829c39b2cc1ae262f8`. All three code files and five helpers retained their pinned bytes. No product changes, source exports, live reads, uploads or BothQ writes were made by this review.

## Must fix

1. **P1: Secret-bearing provenance and sensitive JSON keys bypass holds.** `local/migrate.mjs:418-427`.

   Input: a routed legacy record with harmless content and `source_note: "token=FAKE-REVIEW-VALUE"`; another with a request result containing `{"password":"FAKE-REVIEW-VALUE"}`. Expected both records held. Observed two records planned, zero holds, both fake values in commands. The scanner excludes all `node.attrs`, ignores other request fields and checks string patterns without sensitive-key handling. The hold derivative has the same key-handling gap. Impact: private values reach upload-ready metadata or replay results. Fix: check the complete outgoing representation with the existing `redactPayload`, including parsed JSON snapshots/results, and hold any change. Use that redactor for derivatives without rewriting originals.

2. **P1: Ambiguous Claude directory decoding guesses a profile.** `local/migrate.mjs:219-235`, called at line 372.

   Input: existing checkouts `a/b` and `a-b`, with work and personal remotes respectively. Both encode to the same Claude folder name. Expected an ambiguous-path review hold. Observed the first existing candidate wins, selects `work`, and has no review reason for a personal fixture. Swapping the remotes reverses the privacy boundary. Fix: enumerate matching paths and hold conflicting candidates, unless authoritative provenance resolves the ambiguity.

3. **P2: Concurrent Markdown rewrites can produce an accepted mixed body.** `local/migrate.mjs:131-137`.

   Input: a 1,048,576-byte Markdown fixture, initially all `A`, rewritten to all `B` after the first 524,288-byte read. The repro hooks the real `fs.readSync` calls inside `readFileSync`. Expected retry or hold. Observed an exported body containing half of each version, with a SHA-256 matching neither committed file. Only a post-read stat is taken. Impact: the exported memory may never have existed as a complete file. Fix: bracket the read with file witnesses and retry changed files; accept only a stable read. A later manual `verify` can detect the difference but does not make this export consistent.

4. **P2: Supersession relationship properties are discarded.** `local/migrate.mjs:339-348`, `489-493`.

   Input: a `SUPERSEDES` relationship with properties. Expected the raw relationship preserved alongside the hosted link. Observed normalization removes both incoming and outgoing relationships from provenance; the link retains only endpoints and routing. The frozen real export has eight supersession edges, sixteen relationship appearances with properties, and zero such provenance rows in the rehearsal plan. Impact: relationship metadata is absent from the proposed hosted copy. Fix: retain raw `SUPERSEDES` relationships in `attrs.source.relationships` as well as emitting links.

5. **P2: Finalize commands bypass the byte bound.** `local/migrate.mjs:484-506`, `571`.

   Input: an otherwise valid legacy record with a 1,020,000-character unmapped property. Expected an explicit oversize hold or bounded metadata staging. Observed a 1,021,376-byte finalize command and batch, while dry-run reports zero over-budget parts. It checks only stage costs. Impact: the plan violates its own wire-envelope limit. Fix: validate every serialized command and complete batch envelope; hold oversized records or stage their large provenance. The supplied real plans currently have no oversized finalize command. Server row and byte accounting remains unproved.

6. **P2: Planning trusts stale export hashes.** `local/migrate.mjs:438-448`.

   Input: a valid manifest, then a changed `records.jsonl` body with the manifest untouched. Expected an integrity error before reuse or planning. Observed `plan --force` emits different command hashes under the identical `input_sha256`; ordinary resume returns the prior plan without checking the changed source file. Impact: the manifest no longer proves which exported bytes the plan represents. Fix: verify source-file hashes and counts against the manifest before cached reuse or generation, including Markdown content hashes.

## Evidence and limits

All nine scoped tests passed, including the Python reread/vanish self-test. Private assertion repros are in [the temporary fixture directory](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-sol-import-review-1evz07ry): `node repro.mjs` reproduces findings 1, 2, 4, 5 and 6; `node markdown-race.mjs` reproduces finding 3. `node alias.mjs` passes the bounded fake `ssh -G personal` routing check without network or owner configuration changes. Real-export inspection emitted only aggregate counts/hashes and confirmed 1,101 records, 3,755 revisions and 3,182 requests.

Before/after SHA-256 values, all unchanged:

```text
local/migrate.mjs             5b6666ac0c1ffea2e44c75df8db2684835ddb6520a9f0dbf243f249e1eaca40c
local/migrate/export_bothq.py  0d09246d1925b3b60eb99df092f0b66532812a232b38677e62e7b7ef45753557
local/migrate.test.mjs        ee0752e74641ea8f906e3f56b8b266faf04c19966a10303a8599320692e5cdcf
src/domain/ids.ts            722c9ae4afd39a85324d0648832741044f8930679de537465e29d245b7e64928
src/domain/redact.ts         07835bda5a5f47f3b602ebf6c18af3ee229aa01e5baa4418b333d8dc921d4ba6
src/routing.ts               96264fa6d1a8e6c8d33519e721dee0c955e78222c90b851481c48ba73f8bbfdd
BothQ memory_config.py       13b8064b6925f4b0f7e4e4fc6ec88446ad36b795c4a57507cdd466e9b869a2ad
BothQ memory_privacy.py      c6b5e5f9da71105a3be464ac25140f3a8e122bc220401ad3e79a7e0814ded928
```

Verdict: fix 1 through 6 before treating the plan as ready for upload. No P0 found.

Not checked: live races, actual SSH configuration, model calls, bulk suites, server import/replay, deployment, backup/restore or cross-machine behavior. No server implementation exists here; transaction costs are estimates. All original data remains retained, and BothQ remains the only live system.
