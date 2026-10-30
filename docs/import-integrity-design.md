# Import integrity audit

**Implemented 2026-10-29.** On the rehearsal Worker, stage version `d1500da6-380c-43e0-86e1-0897e3ea21e6` (archive `f10ca8a…584b`), Terra's audit found all 1,330 `test` records, 4,678 revisions and 3,182 requests with every node, source and raw request-ledger hash matching: 0 mismatch, 0 extra, 0 drift. This proves migration verification 1 and 2 for the rehearsal's `test` profile only. The other profiles, the owner-selected golden queries and cutover are not proved. Its automated tests run in Workers and locally ([import implementation](import-implementation.md#import-integrity-audit-2026-10-29)). Opus (`claude-opus-5-5`), the import's author, designed it during the two-fix review freeze. It closes the gap left by the hosted parity check: the approved read API returns content and history, but not each record's stored request ledger or provenance, so [migration verification](architecture.md#verification) 1 and 2 are unproved.

## Decision

Add one read-only endpoint beside the import: **`GET /v1/import/audit`**. It returns, per imported record:
- digests and counts computed in the profile from the rows the import stored;
- the hashes the import already recorded in `import_records`.

A local `audit` command compares them with the same digests computed from the plan that was uploaded.

- **No new MCP tool, no SQL access, no schema change**, and nothing in recall or `get_memory` output.
- **Same callers as `POST /v1/import`:** the owner, or a device with the `import` scope that may use the profile. `read` and `write` tokens get 403, and `me` is refused.
- **Read only.** It does not depend on `IMPORT_PROFILES`, so an import can still be audited after imports are switched off.
- **It never writes, binds, publishes or replays.** It runs only `SELECT`s in the profile and never calls `AccountStore`. The profile's identity check skips its first-use insert for this query: an unbound object simply has no import records.
- **Consistent per record.** Each record's digests come from one synchronous pass in the Durable Object, so no write can interleave. Every record and detail page carries the node's current `revision`. A client that sees it change between pages fetches that record again.

## Interface

| Request | Response |
|---|---|
| `GET /v1/import/audit?profile=P&after=ID&limit=N` (N ≤ 50, default 20; records in `record_id` order) | `{ profile, totals, records[], next_after }` |
| `GET /v1/import/audit?profile=P&record=ID&rows=revisions\|requests&after=K&limit=N` (N ≤ 200) | `{ record_id, node_revision, rows[], next_after }` |

`totals` counts `import_records` by state, imported revisions (`actor = 'migration'`) and imported requests (`legacy_op` set).

Each `records[]` entry carries:
- **`record_id`, `state`, `published_at`.**
- **`record_sha256`, `node_sha256`:** stored at stage and prepare. `node_sha256` is the SHA-256 of the canonical finalize node.
- **`node`** (`null` until published):
  - its current `revision`, `content_hash`, `status`, `kind`, `memory_type` and `attrs.source.system`;
  - `attrs_sha256`, the SHA-256 of the canonical stored `attrs`;
  - `source_sha256`, the SHA-256 of the canonical `attrs.source`.
- **`revisions` and `requests`:** each `{ count, sha256, hosted }`. `sha256` covers the imported rows below. `hosted` counts later rows written by ordinary tools (non-`migration` revisions, requests without `legacy_op`), so drift shows up instead of breaking the digest. An append keeps its delta as an entry, not a revision row, so its drift shows as the node's `revision` and its request.

Each record's rows are counted before any is read, and a summary page hashes at most 5,000 revision and request rows. A record that alone has more is listed with its counts, `paged: true` and no row digests, and the client reads it through the detail pages. Rows are read one at a time and hashed, so a large snapshot never sits in memory with others.

Each summary also carries the node as stored now: `row_sha256`, the stored row rebuilt as an import node, plus its `created_at` and `updated_at`. While the node keeps its imported revision, that digest must equal the plan's node, so a changed status, kind, type or content hash shows up even without a new revision. *Corrected 2026-10-29 after the audit review:* the first version compared only the published `node_sha256` and the revision, and could put two large records in one page.

**Row digests,** in one new shared module used by both the server and the local client. Field names follow Terra's fixture:
- **Revision**, sorted by `revision`: `{ revision, op, snapshot_raw_utf8_sha256, delta_raw_utf8_sha256 (null stays null), request_id, at, content_hash, revision_id, source_platform, source_platform_version }`.
- **Request**, sorted by `request_id` in JavaScript order: `{ request_id, legacy_op, legacy_hash, result_raw_utf8_sha256, result_raw_utf8_bytes, memory_id, at, completed_at, source_canonical_sha256 }`.
  - `result` is hashed as its exact stored bytes: never parsed or reserialized.
  - `memory_id` is read from the stored `source`; `source_canonical_sha256` hashes the stored `source` string.
- **Aggregate** `sha256` = SHA-256 of `canonicalJson(rows)`, the existing sorted-key JSON.

## Files

| File | Change |
|---|---|
| `src/domain/import-audit.ts` (new, about 40 lines) | `revisionDigest`, `requestDigest`, `requestSource` (also used by `stage`), `rowsDigest`, `attrsDigest`. Dependency-free, like `import-cost.ts`, so Node loads it directly; its canonical JSON is the same as `ids.ts` |
| `src/profile/import.ts` | `audit(sql, q)`: the `SELECT`s and digests above, about 50 lines |
| `src/domain/types.ts`, `src/profile/store.ts` | `ReadQuery` kind `import_audit`; one `read` case; `bind` skips its first-use insert for it |
| `src/api.ts` | The `GET` route: the same `authenticate` and caller check as `importBatch`, zod-parsed query, `mayUse`, `me` refused; about 30 lines |
| `local/upload.mjs` | `audit --export DIR [--rehearsal test]`, about 50 lines. It uses the existing private config and redirect-refusing fetch. It computes the expected record set and digests from the plan's `stage` and `finalize` commands, pages the server, and writes a mode-0600 report beside the upload state with counts and mismatched record ids by class (missing, extra, state, node, attrs, source, revisions, requests, hosted drift). It first runs the plan's `dryRun` check and refuses a plan that differs from the upload state, so a missing or changed plan fails before any request. Records are identified by profile and id. Paged records are read through the detail pages, and the node's revision must hold across them. Exit 0 only on a full match: no mismatch and no drift |
| `docs/architecture.md` (verification 1, 2), `docs/import-implementation.md`, `docs/feature-manifest.md` AM-17 | Record the check and its evidence |

## Tests

| Test | Shows |
|---|---|
| `test/import.test.ts`: import a two-part journal and a legacy record whose results have non-canonical bytes (spacing, key order, non-ASCII); audit them | Summary and detail digests equal those computed from the sent commands with the shared module; detail pages reassemble every row; totals are exact |
| Same file: snapshot `write_seq`, every table's row count and AccountStore's `request_index` around an audit | Nothing changes. A legacy request still replays its stored result afterwards |
| Same file: change one stored result byte, then one `attrs` value, with `profileSql` | Only that record's `requests.sha256`, then its `attrs_sha256`, differs |
| Same file: append to the imported journal through `append_memory` | `node.revision` rises, `requests.hosted` is 1 (an append writes no revision row), the imported digests are unchanged |
| Same file: auth and scope | `read`/`write` device 403; other-profile device `forbidden`; `me` refused; no token 401; a staged, unpublished record listed with `node: null`; `limit: 1` pages in order |
| `local/upload.test.mjs`: the fake server answers audit from its applied commands with the shared module | A clean run reports zero mismatches and exits 0; a fake with one changed result byte names that record under `requests` and exits 1 |

## Evidence so far

The offline probe `/tmp/am-l4-design-3uiSra/integrity-defs-probe.mjs` builds these row objects from the rehearsal plan's commands, as `stage` and `publish` store them. It reproduces Terra's fixture (`expected-integrity-v1.json`, SHA-256 `89101631…a253f`) for all 1,330 records, 4,678 revisions and 3,182 requests, with 0 mismatches in node, record, attrs, source, profile, revision or request digests. So the definitions are right. The hosted run will show whether the stored bytes are.

## Limits

- **What a match proves:** that the stored rows equal what the plan sent. Agreement between the plan and BothQ remains the export's own checks.
- **Drift fails the audit:** a record changed by hosted writes after the import keeps its imported digests, which are still checked, with a `hosted` count. It is listed as drift, and any drift makes the audit unsuccessful (status `drift`, nonzero exit). *Corrected 2026-10-29:* the first version reported drift and still passed.
- **Edges are out of scope:** supersessions stay with the existing link receipts and the C04 check.
