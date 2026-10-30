# Module contracts for parallel work

2026-10-29, architect: Opus (`claude-opus-5-5`). This page allocates files, interfaces, store methods and schema versions so that the C2 to C5 authors can code in parallel without touching the same file. It implements the approved [architecture v3.2](architecture.md) and changes no decision there; the architecture's sections stay authoritative for behaviour and checks.

## Core MCP source adoption, 2026-10-30

The owner authorized this bounded shared-root source adoption after the preservation inspection amendment was sealed. The adopted input is exact CORE129 `719010bb47184b13cd8c20a124f49b54f1d8fbd3f6405b6d811d2ac270d1a4f4`, with [source pins](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-core-context-sol-1ix2j4w2/capsule/pins.json) SHA-256 `519091e4b5ea70817fa6f1a8fc91e7773889d1619d94fe0fda75f0dcd3f820d2`. Only the current-owner-root alternative patch `44b998179614e328bc149aaad18c4a489a99139aa48055e636cc5aaed0d08d96` was applied to the guarded root126 plus owner manifest requirements. Code, tests and configuration retain the exact reviewed bytes; this separate canonical documentation update records adoption and evidence only. This dated receipt supersedes earlier private-candidate, not-in-root and pending-source/combined labels for these same sources. It changes no design, fields or remaining runtime gate.

The [shared S1/S2 CORE review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-s1s2-review-sol-kpbn3swr/review.txt) and the [common-context port and exact integration review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-core-port-review-sol-w0gjwano/review.txt) are SOURCE CLEAR. Terra's [full local check](/tmp/am-terra-core719/check.log) passed 278 Worker and 76 local tests with one intentional native skip. The separate [work-upload check](/tmp/am-terra-core719/work-upload.log) passed four tests; [types](/tmp/am-terra-core719/types.log) and the offline [production](/tmp/am-terra-core719/production.log) and [rehearsal](/tmp/am-terra-core719/rehearsal.log) dry runs exited zero. All 129 source hashes and modes stayed unchanged during those checks. This adoption reuses that exact-byte evidence without another code check.

This includes reviewed L1/L2 public-save evidence and links, authorization/generation/wipe fences, inferred preferences and promotion/outbox settlement, dangling checks, metering, account C3 recovery, the shared readable-node gates and the bounded common-maintenance context port. Optional L3 weekly producer/review/receipt features, later acquisition, corpus, self-host tooling, new Entity/Journals pages and native127 are excluded. Existing root126 dashboard source, the owner's AM-13 requirements and current AGENTS policy are preserved. The existing L2 subjectless weekly queue behavior remains. Local capture/automation stays uninstalled and inactive until its separate confinement gate; no server feature flag is claimed to disable it.

Use the sealed [CORE719 preservation inspection amendment](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-core719-inspect-sol-dd2i33l6/handoff.md), pins SHA-256 `67d6d9cca5fbfc2427686e8531e862d067e2a5aa2f183ac404b612113de858a6`. The older optional-L3 2036 pack does not apply unchanged. Read-only target evidence, quiescence/pending alarms and cross-object state remain unknown until their checks run; the amendment predicts no hosted counts. Original content, history, request results and relationships retain the strict preservation precondition. Derived queue, meter and similarity-index effects are identified separately and do not waive that condition. Source/local clearance is complete for this bounded core; target eligibility, preservation rehearsal, live auth/recall/client checks, deployment, memory-copy trial and cutover remain separately gated. No feature is fully verified by this receipt. BothQ remains live, the rehearsal copy is unchanged, and dashboard work remains deferred.

## Rules for every module

- **Shared files have one owner, the integrator** (current fallback and handoff in [project instructions](../AGENTS.md)):
  - `src/profile/schema.ts`, `src/account/schema.ts`;
  - `src/domain/types.ts`;
  - `src/profile/store.ts`, `src/account/store.ts`;
  - `src/profile/write.ts`, `src/profile/read.ts`;
  - `src/api.ts`, `src/worker.ts`, `src/mcp.ts`;
  - `wrangler.jsonc`, `package.json`, `test/helpers.ts`;
  - the canonical docs and `docs/feature-manifest.md`.

  Module authors do not edit them.
- **A module delivers** its new files, its own test file, and a wiring note: the exact snippets the integrator adds to shared files (store methods, union members, routes, tool rows, hook calls). The integrator lands the wiring after review. A module may import shared helpers. It may not copy and fork them.
- **Schema versions** are allocated below, and only the integrator lands DDL. Until a version lands, code against the DDL written here.
- **Platform limits hold in every transaction:**
  - at most 1,000 rows and 1,000,000 bytes written (the `Budget` pattern in `src/profile/import.ts`);
  - at most 100 bound parameters per statement: pass id lists as one JSON parameter through `json_each(?)`;
  - every base-table row stamped with `seq`.
- **Security:**
  - tools check scope before work;
  - `/api/*` data is owner-only through `owner()`;
  - a profile is used only when `mayUse` allows it;
  - cross-profile content is returned only through explicit `profiles` that the caller may read, and anything else comes back as `{id, readable: false}`;
  - untrusted text is set as text, never markup.

## Schema allocation

| Version | Owner of the code using it | DDL (from architecture section 5) |
|---|---|---|
| Profile v4 | C3 and C4 | `archive (id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL, at TEXT NOT NULL, purge_after TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('nodes','texts','edges','evidence','revisions','requests')), payload TEXT NOT NULL, seq INTEGER NOT NULL)`, index `archive_purge (purge_after)`, the `seq` index and tombstone triggers. `transfers (id TEXT PRIMARY KEY, node_id, direction CHECK in/out, peer, state CHECK fenced/sent/landed/published/committed/aborted, parts, created_at, updated_at, seq) WITHOUT ROWID`. `transfer_parts (transfer_id, n, payload, sha256, PRIMARY KEY (transfer_id, n)) WITHOUT ROWID`: control state, not exported. `ALTER TABLE activity ADD COLUMN redacted TEXT` |
| Account v3 | C3 | `transfers (id TEXT PRIMARY KEY, node_id, from_profile, to_profile, state, created_at, completed_at, seq) WITHOUT ROWID`; `wipes (profile, generations, wiped_at, node_count, marker_key, report, seq, PRIMARY KEY (profile, wiped_at)) WITHOUT ROWID` |
| Account v4 | C3 public intent recovery, private capsule | `transfers.intent TEXT`, `transfers.retry_at INTEGER`, partial `transfers_retry` index. Null defaults retain legacy rows; new accepted intents store policy and generations. See the C3 recovery contract below. |
| Profile v5 | Integrator: import refresh ([design](import-refresh-design.md)) | Landed 2026-10-29: `import_refreshes`, `import_records.published_revision` and `published_content_hash`, `nodes_refresh_fence` |

Profile v4 and account v3 landed 2026-10-29 in `src/profile/schema.ts` and `src/account/schema.ts`, exactly as above. Their upgrade tests in `test/import.test.ts` cover profile v2 to v4 and account v1 to v3, existing rows and the tombstone triggers. They are not deployed until Terra's next reviewed artifact. `restores` and `review_list` wait for their stages. No other DDL is allocated: maintenance, `markers`, `nodes.pinned`, `nodes.flagged` and `nodes.source_profile` already exist. Another module that needs DDL asks the integrator for the next number.

**Archive row contract (shared by C3 and C4, implemented by C4 in `src/profile/archive.ts`):**
- `archiveRows(tx, activityId, source, rows, purgeAfter)` stores each row as `JSON.stringify` of `SELECT *`, then deletes the row.
- `restoreArchived(tx, archiveIds)` re-inserts the same columns and removes the archive rows.

Purge after 300 days is the only change without undo.

## C3: knowledge graph, transfers, wipe

| Part | New files (module-owned) | Interface the integrator wires |
|---|---|---|
| Graph reads | `src/profile/graph.ts`: `explore`, `trace`, `timeline`, `expandLinks` over one profile's `SqlStorage`, with the section 7 work budgets (200 nodes per level, 5,000 edge rows; recall expansion 1,000 rows) and a `budget` result saying where a read stopped. `src/graph-tools.ts`: zod schemas and Worker handlers for MCP `explore`, `trace` and `timeline` (scope `read`), following other profiles only through the explicit `profiles` argument and `mayUse` | `ReadQuery` kinds `explore`, `trace`, `timeline` (query types exported by `graph.ts`); three rows in `TOOLS`; `expandLinks` called from recall when `expand: true` |
| Extraction | `src/profile/extract.ts`: identifiers (tickets, PRs, commits, files as evidence) and structural edges, pure functions over text. `src/profile/similar.ts`: the `similar` alarm stage (`topK: 6`, cosine at least 0.85, up to 5 `relates_to` edges with basis `similarity`) | Called from `write.ts` inside the write transaction, and from the alarm after `embed` |
| Transfers | `src/profile/transfer.ts`: fence, part writes, land with guard, publish, commit to a tombstone (texts to the archive), abort, resume after 5 minutes. `src/account/transfers.ts`: intent, rebinding of `node_index` and `request_index`, done. `src/transfer.ts`: Worker orchestration, validating the exact bundle against the target's guard | `ProfileStore.transfer(who, step)` and `AccountStore.transfer(cmd)`, both discriminated unions exported by the module; the cross-profile `save_memory` in `mcp.ts` starts a transfer |
| Wipe | `src/profile/wipe.ts`: `purgeOrigin`, which purges nodes whose `source_profile` names the wiped profile, redacts activity (`redacted`, `undo` null, content-free summary), keeps opaque backlinks and reports hand-written matches. `src/wipe.ts`: the section 9 steps 1 to 6; R2 tombstone; vector deletes in bounded steps | `AccountCommand` op `wipeProfile` (owner only, typed name); `ProfileStore.purgeOrigin(who, wipe)` |
| Tests | `test/graph.test.ts`, `test/transfer.test.ts`, `test/wipe.test.ts`: the phase-3 checks of section 22 that apply | |

Export replacement and the backup-side wipe checks stay in the final backup stage.

### Shared graph reader corrections, 2026-10-30

`graph.ts` exports `READABLE_NODE`, the SQL predicate `status IN ('active','retired','superseded')`, and `readableNodeIds(sql, ids): Set<string>`, with one JSON id binding. No absent or other-status source is readable. `owned` uses it before edge evidence reads and returned payloads; summaries use the same rule. Readable outgoing links to absent or moved targets survive with opaque endpoints. Consumers must gate their subject ids and edge-source ids before loading payloads; this patch changes no maintenance consumer.

Validity compares stored dates as instants with inclusive start and exclusive end, retaining the `valid_to ?? ended_at` fallback and the current-link rule. Node revision, entry and edge-event windows and ordering, plus global activity/imported-revision windows and ordering, compare instants before limits. Edge ordering uses its first event in the window. Raw date strings remain provenance. Global imported revision reads also require a readable node. Existing graph budgets and bounded result/truncation metadata remain; this adds no schema/index or performance claim.

Author-scoped regressions cover hidden sources across explore/trace/timeline/recall expansion, allowed retired/superseded sources, opaque absent/moved targets, offset validity boundaries, and offset revisions/entries/link ends across timeline limits. These are synthetic local source checks; independent review, combined/runtime and delivery remain pending.

### Shared preload and merged timeline correction, 2026-10-30

The follow-up review found that `owned` filtered responses after the edge query had already selected a hidden reason, and the MCP timeline merger restored lexical ordering before its final slice. This additive correction addresses both requirements; independent closure and combined/runtime acceptance remain pending.

`edgesOf` first discovers only bounded edge ids/source ids through the existing indexes, checks those sources with the unchanged published-status predicate, and then loads reason-bearing payloads only for allowed ids. Discovery, source-status and payload SQLite `rowsRead` all count against the same walk budget. Discovery reserves room for the later indexed lookups and JSON-list overhead, including hidden sources, so a large hidden neighborhood cannot cause an unbounded pre-filter scan. `trace` detail uses an indexed source-status condition in the payload query itself. It replaces its former separate post-payload status query; detail keeps its existing internal selected-id lookup contract. Evidence/card reads retain their published gates. `READABLE_NODE`, `readableNodeIds(sql, ids)` and exported `owned` keep their interface, and candidate access gains no general exception.

The public MCP timeline merges profile events by parsed instant before its final limit. Equal instants preserve input order, including routed-profile then `me` order. Raw event dates, normalized window labels, truncation and response fields remain. There is no timeline cursor change. Explore's existing timeline is passed through from the store; score and id sorts in other aggregators keep their separate contracts.

Scoped evidence: all three reviewer assertions reproduced red on the prior fixed shared snapshot and pass with the correction. Three permanent cases cover public single-node offset ordering, cross-profile limit/stable ties, and actual SQLite payload results for hidden sources; the existing large-neighborhood budget case counts the new discovery/status/payload reads. Original readable backlinks, opaque absent/moved targets and prior offset controls remain. This is author-scoped synthetic local evidence only. No weekly code, Entity pages/UI, root adoption, native, hosted or delivery action is included.

## C4: maintenance, housekeeping, undo

| Part | New files (module-owned) | Interface the integrator wires |
|---|---|---|
| Protection | `src/profile/protect.ts`: `mayChange(node, actor)`. For `keep`, `index` and `maintenance` it refuses origin `stated`, `pinned = 1` and every node in `me`; a refusal sets `flagged`, logs activity and changes nothing | Called in `write.ts` before every retire, supersede, archive, merge, transfer and forget |
| Undo | `src/profile/undo.ts`: `inverseOf(command, before, after)` gives the inverse `WriteCommand`. `undo(storage, who, activityId, ctx)` runs it through `runWrite` with `request_id = "undo:<id>"` and the produced revision. Conflicts return `revision_conflict`, redacted rows `undo_redacted` | `activity()` in `write.ts` stores `inverseOf(...)` in `activity.undo`; `ProfileStore.undo(who, activityId, ctx)` |
| Queue and job tools | `src/profile/maintenance.ts`: enqueue by fingerprint, `next` (lease up to 40 items, at most 900 s), `complete` (ops through `runWrite` with actor `maintenance`, each inside its item's subjects). `src/maintenance-tools.ts`: MCP `maintenance_next` and `maintenance_complete`, scope `maintenance`, job tokens only | `ProfileStore.maintenance(who, cmd)`, where `cmd` is `{op: "next"} or {op: "complete"}`; two rows in `TOOLS` |
| Housekeeping | `src/profile/housekeeping.ts`: bounded alarm stages with cursors. Capture TTL of 90 days (to the archive), archive purge at 300 days, exact dedupe (same kind, scope and content hash), size caps | Called from `ProfileStore.alarm` after `embed` |
| Daily batch | `local/batch.mjs`: the confined daily batch, once per profile per day, only after every probe is `denied` | Wired into the capture run after C2's lock lands |
| Tests | `test/maintenance.test.ts` (undo round trip for every op type, protected nodes only flagged, leases, TTL and purge); `local/batch.test.mjs` | |

## C5: dashboard read-only slice (approved 2026-10-29)

- **Module-owned files:**
  - `src/dashboard.ts`: `DASHBOARD_HTML(env)`, `dashboardMain(win)` and `DASHBOARD_JS`, in the house `settings.ts` pattern;
  - `test/dashboard.test.ts`.
- **Routes and data:**
  - hash routes `#/overview` and `#/profiles/:name`, with names checked against the exact loaded profile list;
  - every value set through `textContent`;
  - sign-in through Clerk JS 6 with the owner's bearer;
  - data only from the existing `GET /api/profiles` and `GET /api/devices`;
  - unknown counts show "unavailable", and other planned pages show not built.

  There is no `GET /api/overview` yet: any count needs an integrator-backed design first. Backup pages wait for the final stage.
- **Integrator wiring, after delivery and review:**
  - `worker.ts` routes `/app` and `/app.js` to `api()`;
  - `api.ts` imports the module and serves `GET /app` with `CSP(env)` and `no-store`, and `GET /app.js` as JavaScript with `no-store`. Both come before `owner()`, as `/settings` does; every data route stays owner-gated.

### About you (next-wave slice, 2026-10-29)

Same module-owned files; no API, wiring or dependency change, because `/app.js` already serves `dashboardMain`.
- Routes: `#/about` (`me`, else the first active profile) and `#/about/:name`, checked against the loaded profiles with status `active`.
- Data: `GET /api/profiles/:p/owner-model?limit=50&after=` in server order, one page per Load more; `POST /api/profiles/:p/nodes/:id/pin|unpin|unflag|forget` and `POST /api/profiles/:p/activity/:id/undo` with the returned `activity_id`. Profile names, node ids, cursors and activity ids are URL-encoded; the bearer travels only in the header.
- Behaviour: every value through `textContent`; evidence refs are text and are never followed; forget asks first; one action in flight per profile; no automatic retry; a reload after every action; refusals and 409 conflicts shown as the server answers.
- Checks: `test/dashboard.test.ts`, 10 cases (5 earlier); the served script runs from an esbuild `keepNames` bundle in an empty context.
- Review: a bounded independent review found one P2. An action's committed outcome note disappeared while the list reloaded. The parent's fix keeps that note through the reload and through a failed read (503), with a regression that fails on the reviewed slice; the selected independent wave DOM controls passed. No browser, axe or AM-11 inference check has run.

### Work (integrated source, 2026-10-30)

The same two module-owned files now contain the source-reviewed Work page. No owner board API, backend ranking, auth, schema, dependency or wiring changed. `#/work` opens active work or asks for an explicit available profile; `#/work/:name` accepts only an exact loaded active profile.

The page reads the existing owner board for that single profile. It shows the actual returned `as_of`, the latest-fields/uploaded-data caveat, server order, exact scores and reasons, stale state, activity, blockers and review age. Unreadable references retain only opaque ids; missing fields and incomplete reads remain explicit. Date submission is manual and URL-encoded; a larger read is one explicit limit-200 request at the returned date, without cursors, loops or retries. Old successes, failures and focus changes are suppressed after route, profile or date changes. Pending and failed reads clear previous results. About you action outcomes and Undo survive a Work visit, including an action completing off-screen. Values remain text; the page adds semantic lists/details/labels and live status, without a browser or accessibility acceptance claim.

Exact source: [capsule pins](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-workui-sol-r06jy6ug/capsule/pins.json) SHA-256 `991dd2b630c8dec22eccf09a299a55a86ed1163002f086008bb2f1dbd11ae5e6`; two-file patch `acc2424fc12816867f277e32d7fc78a0f27d53c920fd0d8046eade58412fd53a`. The [independent review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-workui-review-sol-ir7nqiye/review.md), SHA-256 `3a251a94841c40941187d8131634174698b5766314e7bcdd6307a74a3f8bb434`, was CLEAR on exact126 `00eacc7c8d50543aebb937e14990a23f14b22c91451c13e074d9f1ac7e190433` with only the two UI paths changed. Those exact UI bytes are adopted over the prior root freeze, retaining the newer role, canonical facts and permanent consumed-owner wipe regressions. Canonical doc hunks were reconciled manually rather than restoring historical files.

Evidence reused on byte equality: all 15 author dashboard/About you/Work DOM cases, author typecheck/touched lint and serialized-script smoke; 6 selected source cases plus 9 independent serialized controls from review. The review covers safe text/opaque references, exact returned ranking/dates, explicit bounded reads, stale-reply/focus isolation, active-profile routing, safe refusals, missing fields and signed-out no-fetch behavior. Its serialized script SHA-256 is `9321e59a01eeed9bee46a1896be395df3a8efb0a61472c3b7b0020303c32a805`. The served-script case renders a real local board result fixture through public `/app.js`; it does not exercise the protected HTTP board read, real Clerk or a browser.

Adoption check: the one root case rendering the existing local board fixture through public serialized app bytes passed, with 14 unrelated dashboard cases filtered out. Lint of the two adopted files passed. The byte-identical author typecheck and 15-case result, and the 15 independent review checks above, were reused rather than rerun. This adds no protected HTTP or real-browser proof.

Current combined checks, protected HTTP board flow, real browser, axe/reader and runtime acceptance remain pending. AM-12 acquisition/full uploads, daily refresh and strategic-review writing, and AM-13's other pages remain open. D2/D3, D4/D5, public save, native containment and caller-skill candidates are outside this wave. Source adoption changes no confinement or deployment gate; README/import-verification follow-up stays with Terra.

## C2: capture lock (L4)

Module-owned: the lock functions in `local/agent-memory.mjs` (`lockHeld`, `takeLock`, `sweep`, `dropLock`) and their tests in `local/agent-memory.test.mjs`, as specified in the [lock design](capture-lock-recovery-design.md). The shared redactor in the same file stays untouched. The integrator updates `docs/phase-2-implementation.md` and AM-09.

## Integration state, 2026-10-29 (local work in progress, not reviewed as integrated)

This is the historical wiring snapshot. The bounded closure and adoption receipts below supersede its pending-review labels; current combined/runtime acceptance remains pending.

- **C2:** the lock is in root, closed on its reviewed source.
- **C5:** the dashboard slice is wired at `/app`.
- **C4:** the seven files at their closure pins (`archive.ts` `c259bacc…`, `maintenance.ts` `33653b6e…`), with the I1 addon (`undo.ts` `13660794…`, test `b420277a…`). The wiring:
  - `types.ts` gains the `undo` and `owner` commands, the background actors, and `undo_redacted` and `lease_expired`;
  - `runWrite` takes before-images and records every write's undo;
  - `ProfileStore.maintenance` and the two job tools are registered.
- **Write path, found while wiring:** `Tx.run` finishes an open statement before it refuses a write over budget. An unread `RETURNING` cursor made the Durable Object fail with an internal error instead of `size_budget`. C4's 60-node undo test showed it.
- **C3 graph:** integrated at its reviewed pins (`graph-tools.ts` `a4293720…`, `graph.ts` `27fad2cc…`, `extract.ts` `57b3542a…`, `similar.ts` `bc6a33ba…`, test `4703bd87…`). The wiring follows the compatible patch `5e009fa2…`, reconciled with the C4, owner and budget changes. The graph read-query shapes moved into `types.ts`, because `domain/` may not import from a store.
- **C4 allocation:** `archive.ts` `b4c9f06a…` and `maintenance.ts` `1c62c48a…`. `BudgetTx` starts at the measured one row of its sequence allocation, and the lease cursor is written through `tx.run`. Root's `Tx` charges its own sequence row, so nothing is counted twice.
- **C4 after Sol's alarm work:** root moved past the reviewed pins. Now `maintenance.ts` `820405dd…`, `housekeeping.ts` `f350c32e…`, `maintenance-tools.ts` `0686a9e8…`, test `1a2cc8f8…`, `similar.ts` `facf5194…`, `local/batch.mjs` `8e5ccb12…` (test `8bbee955…`) and `local/agent-memory.mjs` `50453320…` (test `e6906d1a…`). Unchanged: `archive.ts`, `undo.ts`, `protect.ts`, and the graph files other than `similar.ts`. These moved files have no independent review yet. Since then, the batch status and the C3 glue have changed:
- `maintenance.ts`, `maintenance-tools.ts` and `graph.ts`;
- `local/batch.mjs` and its test.

Their current hashes are in the frozen addon's pins.
- **C3 transfer and wipe:** integrated after the independent seven-fix closure (verdict CLEAR, 32 cases, no P0 to P2). Its seven module files are at their closure pins:
  - `src/profile/transfer.ts`, `src/profile/wipe.ts`, `src/account/transfers.ts`, `src/transfer.ts`, `src/wipe.ts`;
  - the tests `test/transfer.test.ts` and `test/wipe.test.ts`.

  The six shared hooks were merged into the C4, graph and owner code by hand, because the old wiring patch does not apply over them:
  - `ProfileStore.access` calls `AccountStore.profileAccess` before every entry. That covers write (owner actions and undo included), guard terms, import, transfer, ingest, capture state, every read (graph and `batch_status` included) and maintenance `next`, `complete` and the batch status. The alarm checks it before and after its awaits, so a closed generation never reaches housekeeping or account pruning.
  - `prunePurged` checks the current generation and never removes a `wiped` request fence.
  - Generation close, the `wiped:` ledger and request-ledger fences are unchanged. The `me` survivors keep every target.

  The account-to-profile-to-account guard cycle is proved by local tests only.
- **Glue review fixes, 2026-10-29:** the independent glue review returned NOT CLEAR with four P2 findings. All four are fixed in source, each with a regression that fails on the reviewed candidate and passes on the fix:
  - **G1, alarm closure:** a close or recovery during the similarity or purge-cleanup awaits no longer lets the alarm write. One alarm `gate` (`profileAccess` plus the local closed marker) now runs:
    - after every await and before the next local write: the embed stage, inside `similarStep` before its transaction, before housekeeping, and inside cleanup before the outbox is acknowledged;
    - before any stage error is recorded, including in the outer catch.

    A refusal ends the alarm with nothing written. A closed generation does not come back; a recovery comes back within 60 s, with its outbox kept. The parent's embedding-error independence and 60 s retry are unchanged. Regression: `test/maintenance.test.ts`, four seams.
  - **G2, unpublished links:** a link belongs to its source. The shared edge readers (`edgesOf`, which `explore`, `trace` steps and recall expansion use; `trace` detail; node timelines) admit links only from a local `active`, `retired` or `superseded` source before loading evidence or returning the edge payload. An explicit id start that is still incoming or moving is `not_found`. Backlinks from readable nodes stay, and so do links to absent or moved targets. Regression: a real fence, pack, land and publish into `me`, read through the public `explore` (`test/write-details.test.ts`).
  - **G3, maintenance flags:** inside the flag transaction, `assertOpen` and `assertWritable` cover both the explicit flag and the protected-node fallback. A `moving` refusal reports the op as `rejected`, not `applied`, and leaves the item leased and not done, so it returns to the queue when the lease expires. Flags on protected active nodes (`me`, stated, pinned) behave as before. Regression: a flag completed between pack and land (`test/write-details.test.ts`).
  - **G4, recovery prune:** `prunePurged` now runs the shared `profileAccess` check before any write or sequence number and returns its refusal (`busy` during recovery, `profile_wiped` for a closed or stale generation). The profile treats a refusal as a failed cleanup and keeps its outbox. Wipe fences stay permanent. Regression: `test/write-details.test.ts`.

  `test/helpers.ts` gains `registered()`, a fresh account with active profiles, for these regressions. The later G1 to G4 closure was independently CLEAR; its earlier pending status is historical ([receipt](#cleared-source-adoption-2026-10-30)).
- **Alarm isolation (parent fix, merged 2026-10-29):**
  - An embedding or meter failure no longer stops the alarm. It records `cursors.embed.last_error` and keeps the alarm at most 60 s away, and similarity, transfers, housekeeping and the queue still run.
  - The `profileAccess` check after the embedding step stays outside that catch.
  - Recovery clears the error.

  The regression is the first case in `test/maintenance.test.ts`. It fails on the pre-fix root and passes on the fixed one.

## Owner-model read (integrated 2026-10-29)

Module-owned, copied at their reviewed pins:
- `src/profile/owner-model.ts` `d6faef2c…`: `ownerModel(sql, {kind: "owner_model", after, limit})` returns `{items, next_after}`;
- `test/owner-model.test.ts` `9b3b21dd…`.

The independent review was CLEAR, with no P0 to P2. The wiring is the reviewed three-hunk patch `15032b15…`, merged onto the current root after the four glue fixes:
- the `ReadQuery` member in `types.ts`;
- in `ProfileStore.read`, the case after `access()`, with a read-only bind;
- `GET /api/profiles/:p/owner-model?after=&limit=` in `api.ts`, after `/batch` and in the same pattern: an active profile or 404, the owner only, `limit` 50 by default, and 400 with the profile's `validation` error.

The read writes nothing, leaves a never-written profile unbound, and refuses a closed generation through `profileAccess`. Known limits: each page sorts every active preference, and descriptions return whole. It has no MCP tool (section 7 lists none), no UI, no DDL and no inference.

Checks: the module's 4 cases. Also the route case in `test/mcp-auth.test.ts`: owner paging over every page, 400 validation, 404, device 403, a virgin profile left unbound, and a closed generation refused with nothing written. That case fails before the wiring and passes after. Typecheck and lint of the touched files also pass.

## Work board read (integrated 2026-10-29)

Module-owned, copied at the parent's fixed pins:
- `src/profile/board.ts` `555e6a85…`;
- `src/board-tools.ts` `9141186d…`, unchanged from the reviewed slice;
- `test/board.test.ts` `ae991307…`, 13 cases.

The independent review of the slice found two P2 issues, B1 (a retired linked journal credited as activity) and B2 (a blocker recorded after `as_of` shown by name, and its penalty lost). The parent's two-line fix (patch `3d827ef1…`) credits activity only for active linked nodes and loads far-end metadata only when it was recorded by `as_of`. Its two regressions fail on the reviewed source and pass on the fix. That fix has no further independent review.

The wiring is the reviewed four-file patch `a6cbeef0…`, merged by hand onto the current root after the owner-model wiring, because its context predates that wiring:
- `BoardQuery` in `types.ts`, a pure shape;
- in `ProfileStore.read`, the case after `access()`, with `board` added to the read-only bind, so a never-written `me` stays unbound;
- the `work_board` row in `TOOLS`, scope `read`, through `readSet`;
- the owner-only `GET /api/profiles/:p/board?as_of=&limit=` in `api.ts`, which validates strictly (400) and returns 404 for an unknown profile.

The board reads through the graph's shared edge reader, so the G2 ownership filter applies to it as well.

Checks:
- board 13/13;
- the `mcp-auth` file, 21/21. It includes the updated tool lists and one flow case: `record_knowledge`, then `work_board` and the route at a fixed `as_of`, with bad inputs, a read-only device on the route, a write-only device, a foreign dashboard `azp` and a foreign MCP `Origin` all refused. In the same case, a virgin `me` board stays unbound and a closed generation is refused with nothing written;
- typecheck, and lint of the touched files.

No uploads, daily refresh, strategic-review writing, UI or corpus.

## Reviewed import routes (integrated 2026-10-29)

`local/migrate.mjs` `d8e89c7a…` and `local/migrate.test.mjs` `88bd11dd…`: the reviewed source patch `8b11bbec…`, then the parent's cache fix `e36750a1…`, on the unchanged base files `8bd000fa…` and `f78914e9…`. The two final files were copied after that chain reproduced them byte for byte.
- The independent review found one P2 (a reviewed plan served from the cache) and passed 3 author cases and 20 controls.
- The fix skips the cache for reviewed plans and clears the per-process remote lookup. Its regression covers the same-process remote change.
- The parent ran 28/28. This integration ran `node --check`, the one cache case and lint of the two files.
- The binding files, their recipe and the proof script stay outside the repository. No production `IMPORT_PROFILES` change.

## Integrator queue

1. The import integrity audit ([design](import-integrity-design.md)).
2. The profile v4 and account v3 foundation.
3. Wiring each delivered module, in review order.
4. Import refresh (profile v5).


## C4 alarm, protection and batch integration, 2026-10-29

Sol built this section's work in root as the temporary core owner, after the actual Opus quota error at 09:34:48. Opus executed again the same day; subsequent confirmed rate limits and the current sole Sol writer are recorded in [project instructions](../AGENTS.md). Sol's work stays as built. README and import-verification remain Terra-owned.

The root alarm now schedules bounded dedupe, TTL, purge and queue steps even with embeddings off. TTL pages candidates and digest rows separately, checks last use, and leaves oversized items intact while reaching later items. Purge writes a content-free `cursors.purge_cleanup` outbox in its deletion transaction. Vector deletion and `AccountStore.prunePurged(who, {nodes, requests})` must both succeed before acknowledgement. Account pruning checks the current generation and profile. Failed cleanup retries before further purge. Profile requests survive archival and expire only with permanent node purge.

The shared writer flags protected background saves, retirement, supersession, owner-archive attempts and knowledge updates/edge endings, with undo. The 90% gate accepts retirement, forget and undo; capture/import growth stops. Index-actor commit uploads stop at 70%. The 70% dashboard warning and corpus upload gate remain pending. D1 compaction is now adopted in source below.

Queue production uses up to 200 nodes per step, stable node cursors and card fingerprints. It produces unlinked memories, capture signals and stale journals; weekly reviews add a weekly slot to the fingerprint. Similarity queries supply same-kind pairs at >=0.92 and possible contradictions at 0.80 <= cosine <0.92 sharing scope or a project/component. The graph edge cutoff stays 0.85. Existing manifest-keyed capture queue items remain. `dangling_link` production waits for C3's account/wipe-tombstone lookup contract. D1 now exposes compact in allowed_ops. Inferred-preference and promotion operations remain pending outside this adoption.

### Batch status and release contract

`maintenance_complete`, still job-token-only, accepts either its existing `{profile, lease_id, results}` or `{profile, lease_id, status: "batch_skipped" | "stuck", reason}`. Reason is a content-free code matching `[a-z_]{1,64}`. It releases unfinished items to open for `batch_skipped`, or parks them for a detected tool event. Completed items remain complete. Activity and the `batch_status` cursor record the status; repeated release is harmless. After proof, output/config failures release the acquired lease; tool events park it. An unavailable server leaves lease expiry as recovery.

The probes run before any lease, so a failed control or probe leases nothing and makes no model call. That is how this design meets the architecture's "skipping releases the lease": no lease is held, no item attempt is spent, and the 20-hour gate stays open for a proven run the same day. Leasing first and then releasing would raise each item's `attempts` and park items as stuck after three failed days.

Built in source 2026-10-29, Workers and local tests only: the server record of a probe failure. A third `maintenance_complete` variant, `{profile, status: "batch_skipped", reason}`, has no `lease_id`.
- It upserts only `cursors.batch_status` (`last_error = reason`, `stats = {status, items: 0}`) and returns `{status, released: 0}`. It touches no item and writes no activity row.
- On an unproven runtime, `batch()` sends it once per configured profile. The reason is `runner.reason ?? runner.classification`, or `runtime_unavailable` when that value is not a code.
- The batch ignores a failed send. After a fatal post-proof discard, later profiles make no call.

The owner reads the record through `GET /api/profiles/:p/batch`, which returns `{last_lease_at, last_status}` with codes and dates only. The dashboard's profile card shows it as text in a "Daily batch" row; a failed read marks only that card. No new overview API exists, and no count is invented.

`confinedRunner.exec({prompt, schema, model, effort})` reuses the capture runner's exact CODEX_HOME, cwd and config. It checks the config hash before and after every invocation, writes the supplied schema privately and removes it after the call, and applies the same event allowlist as capture. Before it reads the exit status or output, it checks stderr for Codex 0.165's `unsupported call:` router diagnostic and returns `tool_event` (stderr fix, 2026-10-29). Codex can report a rejected unregistered tool call only there and still exit zero with a valid result. Ordinary stderr progress is still accepted. Confinement gate status (owner-delegated decision, 2026-10-29): the acceptance criterion is the conditional P1/P2/P3 of architecture section 22 plus the same-run probes, not a real model volunteering a command. P1, the effective production tool capability and provider/catalog equivalence, is unproved, so the gate is OPEN. No runtime code or permission changed for the criterion, and no new canary ran. The machine-lock drain calls the batch for explicitly configured `batch_profiles`, default `[]`. Install source copies the sibling batch module and CLI module alongside the existing command. No installation has been performed.

The batch was copied from parent-reviewed files `18bdf021…` and `a8377fd7…`, then changed only for the status/release contract above. It keeps redirect refusal and full local OPS_SCHEMA validation before any result completion.

Opus's source checks before C3 and the batch status: Worker suite 134/134, local suites 70/70 (`test:local` now includes `batch.test.mjs`), typecheck and lint.

Scoped checks on the root after C3, the batch status and the alarm fix:
- the dashboard and API status flow, 24/24, run before the alarm fix, which does not touch those files;
- `test/maintenance.test.ts`, 26/26;
- `write-details`, `wipe` and `transfer` together with `graph`: 64 of 65 pass, the four C3-with-C4 glue cases included, and the one failure is G3 below. `graph` alone passes 22/22;
- typecheck, and lint of the touched files.

Graph fixture G3 (a test-only race, not a product defect): run in parallel with `test/transfer.test.ts`, it could fail, because both files used the shared owner account's `test` profile and a transfer test closes it. The parent's test-only fix gives G3 its own generation. The exact parallel repro now passes 41/41.

Scoped checks after the four glue fixes:
- the four regressions: red with every product file at the reviewed candidate's pins, green on the fix;
- `maintenance`, `write-details`, `graph`, `transfer`, `wipe` and `mcp-auth`, run in parallel: 114/114;
- typecheck, and lint of the touched files.

The full Worker and local suites have not been rerun on this root. These are source checks only. Terra owns combined verification, the real nullable/anyOf schema canary, actual job-token/server flow, deployment and delivery. AM-10/11 remain incomplete. No live model, probe, installation, import, capture or backup work was run for this handoff.


## D1 journal compaction: integrated source

2026-10-29. Authored during the Sol takeover of the Opus role after an actual provider limit, against exact121 aggregate `7bff95a04c712bc6ba9d45f63e6a1830d76c3cb6971dafbf2dd4fe024234e335`. The cleared exact126 source is now adopted in root with its shared hooks and canonical notes. No D2 to D5 or account auth change is included.

- `save_memory.compact` requires `expected_revision`, `request_id`, `through_seq` and a summary on a journal. It admits appends newer than the chosen revision, but refuses an intervening snapshot. It preserves the original text bytes, separators, history, request hashes/results and provenance. It cannot mix another mutation with compaction.
- `compact.ts` owns the shared visibility predicate, body/summary/entry ordering, fence commit, content-free `fold:<id>` cursors and bounded folding. `texts.live = 2`, summary rows and compacted revisions already fit the schema. No DDL.
- Undo keeps only the old node and changed summary rows in its inverse. It checks conflicts and restored material against the current guard, then reindexes at most 100 folded text rows per transaction behind the still-current fence. The last transaction restores the old fence and summary. Content, literal recall and full-text recall are exact before undo returns; there is no alarm catch-up gap. An interruption before the last transaction leaves the compacted view exact. It may leave hidden entries indexed until the fold stage resumes.
- `queueStep` uses the visible entry characters and the fence slot for stale journals; its scan queues transferred/restored journals for folding. Transfer bundles and archive images retain both folded entries and summaries. Existing bounded purge removes them and redacts their undo.
- Shared hooks are confined to `types`, `write`, `read`, `undo`, `store`, housekeeping, maintenance, MCP and the local batch schema. The maintenance prefix includes whole entries with separators, at most 24,000 characters, its through sequence, node revision and current summary. Subjects, redaction, strict schema, redirect policy, event gate and fatal discard remain in force.
- Scoped evidence in the private capsule: the 664-entry commit writes 23 actual Workers rows. Fold progresses through 100, 100, 100, 100, 100, 100, 64 entries, with at most 401 rows in a transaction. Undo reindexes in steps of at most 401 rows and publishes its inverse in 26 rows. Its tests assert the 1,000-row, 1,000,000-byte and 100-bind limits on every step. The inverse contains no entry text. Undo also records a content-free restored revision when the previous append-only state had no snapshot, so compaction cannot misclassify undo as a concurrent append.
- Checks are scoped Workers tests and the local batch fixture, plus type and touched-file lint. Covered: interrupted fold/undo, immediate lexical recall, concurrent appends, conflicts/replay, summary replacement/undo, protected journals, current guard, closed/moving refusals, and partially folded transfer/archive/restore/wipe. Existing import publication/refresh checks cover the shared prefix reader. Full integration, real batch/model/confinement canary, deployment and restore drills remain pending. AM-10 and AM-11 are not complete.

The pre-existing archive/undo size refusal remains for a single oversized operation. D1 introduces bounded compaction and reindexing; it does not redesign general archive or backup/restore. Backup and restore stay deferred to the approved final stage.

## Commit upload slice (2026-10-29)

This contribution is adopted in shared-root source from the cleared exact126 candidate below. It is not deployed; the exact source receipts below are the evidence.
- `src/profile/work-upload.ts` handles canonical commit metadata, structural edges and monotonic markers. It calls the shared entity/head/revision/activity writer and the real-row/byte-counted `Tx`.
- `UploadArgs`, `ProfileStore.upload` and `/v1/ingest` accept at most 50 strict commit items per request. Capture-only schemas, bodies, manifests and responses keep their prior behavior. Job tokens gain no generic MCP write capability.
- Request bindings include the profile and repo/full SHA identity. Failed tentative writes release their new binding; committed retries repair node registration before acknowledging a marker. Account binding and registration accept an optional generation fence for this upload path. Existing callers keep their behavior.
- Work terms register in the me guard before graph publication. Uploads never enter me. Wipe, generation, moving-source, recovery and background-index budget refusals remain active.
- Repo namespaces and handles normalize to lowercase. Existing key bytes are preserved, and identifier resolution recognizes case variants. Short SHA references remain mention evidence, never guessed full identities. Missing keys create no stubs.
- `local/work-upload.mjs` exports `collectCommits` and `uploadWork`. It uses read-only local git and the existing CLI's new `httpServer(config).work` method. The capture run does not invoke this module automatically yet. The integrator wires that separately under the existing machine lock.
- No new DDL or dependency. Tests use synthetic git repositories and real local Worker/DO/SQL. PR/Jira, daily refresh, strategic-review writing and commit aggregation remain explicit follow-ups.
- The independent review found two P2 issues, both fixed with regressions that fail on the reviewed source and covered by selected independent wave controls:
  - B1 (Opus): before any marker, marker-only bodies included, `ProfileStore.upload` reads the head's durable upload result, keeps its still-active node ids, registers them for this generation through `recordNodes` and rechecks `access`. A failed registration acknowledges nothing. `recordNodes` with a generation uses `INSERT OR IGNORE`, so a repair cannot take a node back from the profile it moved to.
  - B2 (parent): the marker's `head_not_held` check compares the commit key with `COLLATE NOCASE`, so an existing mixed-case GitHub commit is held. Its stored key and title stay as written, and other repos stay distinct.
- A parent follow-up fixes the related extraction gap: unmatched GitHub identities use a case-insensitive lookup, while session and other literal keys retain exact case. The public upload normalization regression checks the link before the upload, plus literal case separation; it failed before the fix and passes after. The fallback scan has a `shortcut:` comment and no performance claim.

### D1 compact transfer guard

The independent D1 review found one P2: a cross-profile `save_memory` carrying `compact` could start a transfer. The parent's fix adds one MCP guard before any request binding or transfer: a compact request that names another profile is refused with `validation`. The existing public compact regression checks that a malformed and an otherwise valid compact move leave the account's request and transfer rows and the source record unchanged, then compacts locally and replays. The source-level compact validations in the shared writer are unchanged. The selected independent wave compact control passed; combined and runtime gates remain open.

## Combined source candidate, 2026-10-29

Opus, as the sole integration author, combined four source slices on exact121 into one private additive patch. It was subsequently source-cleared with the follow-ups below and adopted in root on 2026-10-30.
- **Slices:**
  - the stderr fail-closed executor fix;
  - About you with its receipt fix;
  - D1 compaction with the compact transfer guard;
  - the commit upload with B1 and B2.
- **Method:** each slice was first rebuilt alone on a fresh exact121 and matched its own result pins. Every overlapping file was then merged three-way against exact121 with `git merge-file`. No older whole file replaced a newer one.
- **Shared seams, each an independent hunk:**
  - `local/agent-memory.mjs`: the stderr diagnostic check sits in `confinedExec` before exit-status and output handling; the upload's `httpServer().work` poster is separate.
  - `src/domain/types.ts`: D1 adds `SaveArgs.compact`; the upload adds `UploadArgs` and the `upload` write command.
  - `src/mcp.ts`: D1 adds the compact schema and the cross-profile compact guard; the upload adds `upload` to the profile stub.
  - `src/profile/write.ts`: D1 adds compact dispatch inside `save`, compaction-aware content readers and body replacement, the 100-parameter statement bound, the 90% gate exception and the `Unfold` retry wrapper around the one transaction; the upload adds the `upload` dispatch, `uploadIds` and the shared entity writer.
  - `src/profile/undo.ts`: D1 adds summary images, the fence check and the restored-revision marker; the upload adds its candidate keys.
  - `src/profile/store.ts`: D1 adds fold scheduling and the alarm's fold stage; the upload adds `ProfileStore.upload`. An upload creates no compacted journal, so it schedules no fold.
- **Preserved:**
  - the four glue gates;
  - the graph ownership filter, flag gate and prune outcome;
  - the owner-model and board reads and the owner actions;
  - the transfer and wipe fences;
  - generation-account access and upload idempotency and provenance;
  - D1's early compact refusal and its sequence accounting.
- **Checks:** scoped only, listed in the candidate's integration note. The bounded wave and wipe reviews below clear the selected source seams. Terra retains combined/runtime verification; earlier C3, v5, graph and glue closures stay closed.

### Consumed-mention undo (fix after the wave review, 2026-10-29)

The fresh wave review found one P2: undoing a commit upload left the full-SHA mention it had resolved deleted, so an earlier journal's pending reference was lost while the journal text survived. The shared cause covered every `runWrite` caller of `resolveMentions`, knowledge writes as well as uploads. Before-images covered only the written keys, and `inverseOf` sees only rows stamped with the write's seq, never deleted ones.
- `resolveMentions` reads each mention row it deletes (`owner`, `kind`, `ref`, `note`, `seq`) with its owner node's revision, onto the write transaction's `consumed` list. `Tx` in `write.ts` carries the list; `runWrite` hands it to `recordUndo`.
- `Inverse.mentions` keeps the consumed rows that existed before the write, on owners the write did not create. A mention inserted and consumed in the same write, or owned by a created node, goes with that node.
- Undo first checks each retained owner's permanent wipe fence with `assertNotWiped`, returning `profile_wiped` before restoration. It also refuses with `revision_conflict` when an owner node is missing, moved or at another revision, or when a row with the same owner, kind and ref exists again. An owner in transfer gets `moving`. The rows pass the current guard with the rest of the restored material, then go back through `putRow`: the same owner, kind, ref and note, stamped with the undo's seq as every restored row is.
- Unchanged:
  - short-SHA references stay pending mentions;
  - texts, history and request bytes;
  - compaction fences and immediate lexical undo;
  - transfer and wipe fences;
  - B1 registration, the B2 head match and the identifier case fix.
- Capture's `resolveMentionsAlone` runs in its own transaction without activity or undo, so nothing new is recorded or undone there.
- Bounds: resolution already stops before the 1,000-row bound, so the inverse holds at most as many rows as one write can resolve. The inverse is counted in the write's 1 MB bytes. An undo that would pass the row bound is refused with `size_budget`, as before; nothing is dropped silently.
- Checks: the partial-fold upload regression in `test/work-upload.test.ts`. A knowledge-write sibling with a later-edit conflict control is in `test/write-details.test.ts`. Both fail on the reviewed source and pass on the fix, and removing the revision check makes the conflict control fail.

## Cleared source adoption, 2026-10-30

The sole Sol integrator adopted only exact126 `b8e4286385e662dcab3f42772529309d2405c9d403a9a5cc8ea215ee2d47b35b`. A private reconstruction verified all 12 exact121 patches, then the wave, identifier-case, consumed-mention, view declaration and wipe-ownership patches, with sequential apply checks and byte equality for all 126 files. The accepted historical whitespace warnings remain. This is source adoption, without current combined or hosted/runtime acceptance.

- [Wave review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-wave-review-sol-qkjihaak/review.md): selected B1/B2 registration/identity, D1 guard/budget and About you receipt controls passed. Its consumed-mention P2 was fixed by patch `5598af2dc57e2689be5128e55c92e6ae2d328258c62d3407c67d6cd1f636964a` in the shared writer/extractor/undo path.
- [Closure review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-closure-sol-qsopwolf/review.md): exact mention restoration, current guard, conflict, rollback and budget controls passed. Its wipe-ownership P2 was fixed by patch `4156a3c73cc98f9b771739e7dae003b97b4cbc86c48be543483fae3a8bdfae2f`.
- [Final wipe review](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-undo-wipe-review-sol-63z4mboy/review.md): CLEAR on exact126, three selected controls passed. Completed work wipe redacts consumed-owner inverse images; the real fence refuses undo atomically before purge; dependency targets preserve existing node/edge targets and deduplicate consumed owners.
- `recordUndo` adds retained consumed-mention owner ids to the activity's existing targets in the same budgeted transaction. The existing targets-based wipe then nulls undo and redacts the activity. `revert` checks the permanent owner fence before restoring any mention, retaining revision, transfer, evidence-conflict and current-guard checks.
- Permanent cases in `test/wipe.test.ts` and `test/write-details.test.ts` port the two concrete counterexamples with fresh synthetic accounts. Both fail against the pre-fix `44c4551587ee3723ac8ee9bdb1780f9f82583ad6d84d0689353921a6b3af8574`: a completed MCP work-to-personal transfer/knowledge/work wipe retains undo, and fence-before-purge undo succeeds. The fixed fence test checks every snapshotted table, including sequence and request receipts, remains unchanged.
- Adoption checks: both permanent regressions reproduced the old defects on pre-fix `44c455…`. Eight distinct scoped Worker cases pass in root: the two new wipe cases, shared knowledge/upload mention undo, the existing revision/wipe-redaction/replay control, D1 664-entry fold/lexical undo, current guard/closed/moving refusal and the 1,000-row atomic undo refusal. The D1 measured commit writes 23 rows and fold transactions peak at 401 rows, within the asserted byte/bind bounds. Typecheck and lint of the 27 touched code/test files pass. These are scoped results, not a full Worker/local combined run.
- The common CONFIG_TOML declares `[features] view_image = false`, patch `bd1f7324a4778f049b1f05f65b8e2cbabf1955ec6e86262eb088d5b4718c253d`. Its selected mock executor check passed in the closure review. This does not prove effective native CLI capabilities or confinement. The approved conditional P1/P2/P3 criterion remains unchanged and OPEN. Ambient HOME skill isolation and custom-only stderr fixes are private pending candidates, excluded here.
- Earlier C3, v5 and graph source closures remain closed. The [G1 to G4 closure](/var/folders/mm/dwsn1_0j0cb2scdpkdw6_4rm0000gp/T/am-glue-closure-review-q1talouo/result.json), SHA-256 `eae6d02ae869fde8d15861866bbf85dd556d7c94f35e765b633a3b81b6066bc9`, was CLEAR with 17 scoped cases. Historical pending-review wording above is superseded by those bounded receipts, not by a whole-feature acceptance claim.
- D2/D3 and their four fixes, D4/D5 and public save stayed outside this adoption; they are combined in the private [integration candidate](#d2-d5-and-public-save-integration-candidate-2026-10-30) below. Native P1/catalog/skill-loading candidates remain outside root. Work UI was adopted separately in the source-only C5 step above. No source activation, client installation, model/probe execution or production IMPORT_PROFILES change follows. README/import-verification updates and the current combined check remain with Terra.

## D2/D3 inferred preferences and promotion: private additive capsule

2026-10-29, Opus. One additive patch on the exact126 candidate with the identifier-case fix (aggregate `44f58eae…`). Root is unchanged. Independent review, root adoption, combined checks and runtime proof belong to the parent and Terra. This is the next approved AM-10/11 slice, not their completion. Status on 2026-10-30: source-cleared by independent review and combined in the private [integration candidate](#d2-d5-and-public-save-integration-candidate-2026-10-30), not in root.

- **Ops per item kind.** `opsFor(kind)` keeps the seven existing ops on every kind. It adds `infer_preference` to `preference_signal` and `unprocessed_capture`, and `promote_to_me` to those two plus `near_duplicate` and `possible_contradiction`. `maintenance_next` returns these lists per item. `maintenance_complete` refuses any other op with `validation` and reason `op_not_allowed`.
- **infer_preference.** It takes 1 to 10 `node` evidence pointers, each one of the item's subjects. It creates through the shared writer as actor `maintenance`, with request id `maint:<lease>:<item>:<n>`: type `user`, kind `preference`, scope `default` unless given, origin `inferred`, and the evidence rows. Model text is redacted before hashing or applying, as before. A taken active identity is `already_exists`. A stated or pinned identity is flagged. Nothing is overwritten.
- **Shared writer.** `SaveArgs` gains internal `origin: "inferred"` and `evidence`. MCP `origin` stays `stated` or `agent`. (The later public save capsule below exposes `evidence`, never `inferred`.) `create()` refuses an inference without evidence (`validation`, `missing_evidence`). It refuses a `stated` origin from `keep`, `index` or `maintenance` (`forbidden`, `background_stated`). Updates never change origin, and pins stay owner-only.
- **Registration.** An infer outcome stores `created: [id]` in the item's durable outcome. A replayed op reads the first run's action from its request row. `ProfileStore.maintenance` registers the created ids for its generation through `recordNodes`, then rechecks access. It does this for fresh and replayed results, before anything is acknowledged. This reuses the upload's B1 helper, now one private store method. A failed registration returns `unavailable`, and a retry replays and registers. A closed generation returns `profile_wiped`.
- **promote_to_me.** The target is one preference subject (`memory_id`), or `from_op`: the index of an earlier infer op of the same item that created a preference. Forward, rejected and unrelated references are `bad_target`. The profile requires `company_free: true` and the Worker's `toMe`. It refuses `me` itself, a moving record, and a target that is not an active preference. It flags a stated or pinned target. Otherwise it stores `transfer_started` with `transfer_id = uuid5(<user>:promote:<lease>:<item>:<n>)` and `company_free: true`, and writes nothing across profiles.
- **Worker.** The Worker passes the active `me` generation only when the job token may use `me`; the leased profile was already checked. It calls `driveTransfer` with the stored id and attestation, the leased profile as context and the account's current sensitive terms. A commit is `applied`. A refusal is `rejected` with its code, and C3's abort leaves the source writable. A transport error is `moving`. A replay re-drives the same id and moves nothing twice. The owner reverses a promotion by moving the record back.
- **Durable intent and alarm settlement (recovery capsule).** The transaction that marks an item done also writes a content-free `cursors` row `outbox:<lease>:<item>` (the `purge_cleanup` outbox pattern, no DDL). A moving-refused item writes one too. The row holds the created ids and each accepted promotion's transfer id, node, `me` generation, job device id and `company_free: true`, with no token or content. `ProfileStore.maintenance` arms the alarm at most five minutes ahead before any such row can commit. The real alarm settles due rows, up to 10 per run, after its gate. It registers the created ids for its generation. It drives each promotion under its id as that job device, with the account's current terms. When `me` is no longer active at the stored generation, or the target is no longer a promotable active preference, it takes C3's abort path instead. An abort of a begun transfer leaves nothing open; a never-begun one is simply dropped. A transport failure, or C3 still reporting `moving`, keeps the row for a retry in 60 s. Any other outcome deletes the row. The alarm's next wakeup includes the earliest row. A closed or wiped source generation stops the alarm before it settles anything. The client never has to replay a completion.
- **Auth delta, accepted by the parent.** `AccountStore` transfer begin admits a caller without write scope only when it holds `maintenance`, `to` is `me`, and `mayUse` allows both profiles. Since the recovery capsule it also rereads that device's row: it must be enabled, unrevoked and unexpired, and still grant `maintenance`, the source and `me`. A stored intent therefore never runs as the owner or with a revoked grant. Every other begin keeps the write-scope rule. Job tokens still have no MCP write tool.
- **Recall.** `statedFirst` in `src/domain/rank.ts` runs on the Worker's merged list before the limit and token packing. It refills only the preference positions, non-inferred first, each group in its order. A list without an inferred preference is unchanged. Inventory order and cursors are untouched.
- **Local batch.** `OPS_SCHEMA` gains both ops in the nullable form, with `company_free` as `enum [true]` and evidence kind as `enum ["node"]`. `named()` checks infer evidence refs and a promote `memory_id` against the subjects; `from_op` goes to the server's check. The prompt describes both ops. Strict validation, whole-lease discard, redaction, redirect refusal and the event gate are unchanged. No format claim is made before Terra's canary.
- No DDL, dependency or error code was added.

Scoped evidence, from the private capsule logs:
- the D2/D3 block of `test/maintenance.test.ts`, 7 cases: inference refusals by kind, subject, evidence and identity; background stated refusal; kept origin and pins; protected promotion target flagged; owner model evidence with pin, forget, undo and undo of the batch's inference; registration retry and closed generation; the real job tools inferring then promoting by `from_op`, with replay and a work wipe survivor; a work-only token refused and the narrow begin; a guarded term rejected with the source writable; a transport failure resumed and replayed once; stated-first recall before the cap with other kinds in place, and inventory paging without loss or duplicates;
- the affected Worker files (`maintenance`, `transfer`, `work-upload`, `isolation-recall`, `owner-model`, `write-details`, `wipe`, `mcp-auth`): 137/137. One existing control fixture returned `null` from a fake `complete`; it now returns the store's `{results: []}` shape;
- `local/batch.test.mjs` 13/13, typecheck and lint of the touched files.

Recovery capsule evidence (scoped), through the real scheduled `ProfileStore.alarm` via `runDurableObjectAlarm`:
- a crash before the first drive, and a transport failure after the account begin and before the fence, each finish once. Two alarm runs leave one transfer, one `me` record and no outbox row. The open transfer refuses a work wipe until the alarm settles it; afterwards the wipe proceeds and preserves the record;
- on resume, a new guard term aborts the begun transfer, and a `me` regenerated after begin aborts it. A `me` regenerated before begin and a revoked job device leave no transfer. In each case the record stays active, unfenced and writable in work, and the row is gone. A closed source runs nothing, keeps its row and is not re-armed;
- a work-only token leaves only a registration row, and the alarm moves nothing;
- a registration that failed after commit is registered by the alarm alone, and a closed generation stays unregistered;
- a fenced move whose landing failed is finished by the alarm, replacing the earlier direct `resumeTransfer` call;
- red check: with the alarm's settle loop disabled, the crash-window and registration-by-alarm cases fail.

Remaining notes:
- After promotion, the evidence pointer in `me` names the source digest's id, an opaque id.
- The transaction boundary is the item, not the op. A process crash inside the synchronous `complete()`, after an infer op committed and before its item's outcome transaction, writes no row. The lease then expires and the item returns to the queue. The created node is unregistered until `ownerOf`'s index repair on its first lookup by id. This is not a transport failure, and no completion was acknowledged.
- Baseline limitation of this D2/D3 slice: the MCP `save_memory` move path was unchanged and an account begin before a failed source fence needed client replay. The later private C3 recovery capsule below closes that source path; it is not root or hosted proof.
- The public `save_memory` evidence and links are in the capsule below. The `as_of` and data-wrapper gaps stay tracked and open. At that D2/D3 freeze, D4 (dangling links) and D5 (row meter) were not built; the later D4/D5 private source contribution is recorded below. The section 22 genuine-model criterion stays open.

### D2/D3 four-finding correction

2026-10-29, source contribution only, awaiting fresh independent review. Sol continued the terminal Opus author's partial under the owner's actual-provider-limit fallback. The original 127-file recovery baseline is `e0f8ee9236682aeeec44dfeb5625b4d56f26a1f112727d53b98cbd6768fcaec8`. The failed tree and earlier capsules stay read-only; nine product files are preserved byte for byte, and the unfinished permanent regressions are completed. README and shared-root role metadata belong to their separate owners. Status on 2026-10-30: source-cleared by independent review and combined in the private [integration candidate](#d2-d5-and-public-save-integration-candidate-2026-10-30), not in root.

- R1: `fuse` retains the original capped hits plus up to `limit` non-inferred preferences from the remaining bounded metadata, with their original `RecallHit.rank`. Only these selected bodies are hydrated. The Worker uses that rank in its second RRF, then applies `statedFirst`, the final limit and global token packing. Nonpreference positions, inventory paging and graph seed/edge budgets stay unchanged. The internal rank is omitted from public results, and supplemental candidates do not inflate `truncated`.
- R2: maintenance passes `TransferInput.protect` through both immediate and alarm drives to the shared source fence. In the first fencing transaction, `mayChange` refuses and flags a now-stated or pinned node without moving it. The driver aborts the begun account intent and completes C3 cleanup. An interactive move carries no protection requirement and retains its behavior.
- R3: both drives pass `TransferInput.expect = {from, to}` with the accepted source and target generations. Account begin checks them in its transaction on fresh and existing intents. A stale new intent is refused before insertion; a stale open intent is marked aborted and cleaned through C3. A decided transfer is never retargeted to a replacement. The immediate outcome carries its accepted `me` generation instead of borrowing the current tool context's generation.
- R4: the item's outcome transaction unions prior unsettled created ids and promotion intents with newly accepted ones. An existing deterministic id keeps its original generation, device and attestation metadata. A retry can add a previously moving subject after the competing C3 transfer aborts; registration-only and earlier promotion rows are retained.

Scoped evidence: the [D2/D3 block](../test/maintenance.test.ts) has 13 passing cases, including immediate/alarm pin races, interactive moves of the pinned record, generation changes during registration and retrieval of an already begun intent, two pending intents on a real same-lease C3 fence/abort retry, every recall limit in a mixed work/me fixture, and the existing automatic alarm recovery/registration/auth/guard/closed-source controls. The supplied reviewer fixture, including the parent's cross-profile cap case, passes all 10 probes on the preserved correction; its retained original-baseline run failed the five expected assertions and passed five controls. Additional scoped checks passed: 20 transfer cases, two recall controls for more than 100 candidates and global token packing, two recall graph expansion/budget controls, typecheck, and lint of the ten touched TypeScript files. This is source evidence, not independent clearance or AM-10/11 completion.

The new permanent fixtures initially failed because a captured Durable Object stub crossed I/O contexts and a one-shot crash injector let the second intent complete immediately. Both fixtures were corrected without changing product code. A pre-existing wakeup assertion also raced an already consumed alarm; it now bounds a pending wakeup while the following real-alarm helper still requires automatic recovery. Every failed log and rejected fixture is retained in the private additive capsule.

No DDL, dependency, public save schema, job privilege, model, hosted operation or new transfer protocol is added. The later private C3 recovery capsule below addresses the public MCP begin-before-fence source gap. All original runtime, confinement, capture, import, backup and cutover gates remain open.


## D4/D5 dangling links and daily row meter: private source contribution

2026-10-30, authorized Sol continuation after the original Opus provider limit. This additive source slice starts from the exact127 D2/D3 recovery baseline. It preserves the original author's two new modules, store/account/maintenance wiring and scoped tests. It has not been adopted into root or independently reviewed. AM-10 and AM-11 remain incomplete; no runtime, model, confinement, deployment, backup or cutover result follows. Status on 2026-10-30: source-cleared by independent review and combined in the private [integration candidate](#d2-d5-and-public-save-integration-candidate-2026-10-30), not in root.

- `AccountStore.nodeStates(who: ProfileRef, ids: string[]) -> Outcome<boolean[]>` accepts at most 200 ids, returns booleans in their input order and exposes no profile or content. `true` means no account node index, permanent wipe tombstone or live open/committing transfer names the id. A stale generation is refused; an account under recovery returns `busy` instead of absence.
- `danglingPage` scans at most 200 current edges per step, skipping missing, incoming, moving or moved sources and locally held targets. Foreign or locally absent targets are checked through the account. After that await the alarm passes its access gate. One `BudgetTx` then asserts the local generation is open, rechecks the edge id and both endpoints, source fence and target absence, enqueues `dangling_link` with subjects `[src,dst]` and slot `e:<edge id>`, and advances the cursor. It stops with row/byte headroom and resumes, then waits one day when the scan ends. No heuristic deletion occurs.
- `enqueueIn` shares the existing fingerprint computation inside the caller's transaction. A dangling item's allowed ops are only `end_link`, `flag` and `dismiss`. `end_link` requires both opaque endpoints among leased subjects and checks protection/fencing on the real local source. A protected source is flagged. Other item kinds keep their existing op lists. Shared redaction, writer, activity and undo stay active.
- `AccountStore.meter({day, neurons?, rowsWritten?}) -> {embed,background}` retains the 8,000-neuron boundary and adds UTC daily rows. At `rows >= 80000`, `background` is false. Missing/zero amounts read without incrementing; invalid dates and negative/non-finite amounts are refused. This is an account user's combined profile counter, not a platform billing meter.
- `countRows` wraps each profile instance's SQL execution once. `flushRows` durably adds pending real cursor rows to `cursors.meter` after mutating entries, including wipe work on surviving profiles, and after alarm work. No per-statement RPC or alternative product write path exists. Reads retain no cursor. A cursor-counter failure is retained for retry; a durable flush failure preserves its in-memory count and does not fail a committed agent write.
- Once per alarm step, the durable row count is reported to the account. After a fresh gate, only an acknowledged count is subtracted; counts flushed by another entry during the await stay pending. A report, counter read or acknowledgement failure fails open, retains pending counts and schedules retry. Closed generations do not flush meter state, write status/error rows or re-arm. Recovery writes no further SQL and keeps the existing 60-second recovery wakeup. Embedding meter, AI and vector awaits also pass the alarm gate before further local writes.
- A pause skips similarity, dangling production and housekeeping until the next UTC midnight. Housekeeping still runs when `sizeLevel != ok`, including the 90% shrink-only level. The existing crash-before-drive/before-fence recovery fixture also starts at the 80k row pause and still completes the real promotion. Agent writes, embedding, fold, transfer resume, D2 registration/promotion recovery and `purge_cleanup` never consult this pause. The alarm keeps the earliest unpaused wakeup; idle paused stages do not spin.

Scoped evidence lives in the immutable contribution capsule and the existing `test/maintenance.test.ts` D4/D5 cases. They cover absent, indexed, wiped, moving and transfer-backed targets; endpoint replacement during the account await; bounded pages, rows, bytes and binds; actual public job lease/completion of `end_link`, allowed-op/subject refusal and protected-source flags; late close/recovery with no further writes; the 80k pause with embedding/fold/outbox/cleanup continuing; 90% housekeeping; midnight reset; failed reports, concurrent flushed rows, failed durable flushes and the unchanged neuron boundary. Producer/pause red controls and regressions against the preserved partial are retained alongside successful checks. Two original D2/D3 timing fixtures wait for an in-flight alarm's re-arm, or permit no second run for a generation already closed; their semantic assertions remain.

### Meter accounting limits

The source tests use the actual local Workers SQL cursors. An unread two-row `RETURNING` reports 2 rows before and after consumption. An insert rolled back by `transactionSync` still reports 1 although no row remains, so the meter conservatively counts it. An indexed live text insert reports 5, including surfaced FTS/trigger/index work. A flush's own upsert is counted by the next flush; the account acknowledgement and stage writes join the next durable report too. Tests assert those counts, not estimated per-operation costs.

These values are the platform's surfaced statement counters. Deferred SQLite FTS internals are not all attributed to them, as already documented for imports. An eviction/crash before a durable flush can lose in-memory counts, especially during repeated flush failures; initialization migrations and closed-generation teardown are not reported. A report applied by the account whose response or local acknowledgement is lost can be reported again, and a report crossing midnight is charged to its report day rather than each statement's execution day. The meter can therefore undercount or overcount platform billing and is a scheduling guard only. No exact Free-plan capacity or Paid billing claim is made.

`shortcut:` AccountStore's own SQL rows remain uncounted, with the approved 20,000-row headroom. Count them if Free capacity becomes a gate. The current 80k rule is daily and independent of Paid's monthly allowance.

## Public save evidence and links: private additive capsule

2026-10-30, Opus implementation preserved and continued by Sol under the actual provider-limit fallback. One additive patch on the frozen D2/D3 recovery candidate (127 files, aggregate `e0f8ee92…`). Root is unchanged. It is implemented in source only and unreviewed. Independent review, root adoption, combined checks and any runtime proof belong to the parent, the sole integrator and Terra. Architecture section 7 governs: `save_memory` takes `links`, and a decision needs `why` and evidence; section 4 requires a reason and evidence on every judgment edge. The section 2 example, which had a link with neither, now has a reason, evidence and a relation the endpoint table admits. Status on 2026-10-30: source-cleared by independent review and combined in the private [integration candidate](#d2-d5-and-public-save-integration-candidate-2026-10-30), not in root.

- **Schema.** `saveSchema` gains strict `evidence` (1 to 20 `{kind, ref, note}`, the `record_knowledge` pointer) and `links` (1 to 20 `{rel, other_label, to, reason, evidence, valid_from, valid_to}`). `to` is the knowledge ref without `{ref}`: `{id}`, `{kind, key}` or `{kind, name, scope}`, with the knowledge kinds. `from` is the saved record. A `profile` on `to`, an unknown key, a blank evidence ref, an empty or oversized list and `origin: "inferred"` fail validation.
- **One graph writer.** `judgmentEdge` and `resolveRef` in `write.ts` are the former `record_knowledge` edge loop and resolver, now shared with `saveLinks`. A link runs the same checks: `other` needs `other_label`, a reason of 8 to 600 characters, at least one pointer, a writable source, two different nodes and the endpoint table. A current edge with the same source, relation and target is `matched`: its pointers merge (`INSERT OR REPLACE` by owner, kind and ref) and its reason and basis stay. On create, links run before identifier extraction, so a mention never takes the agent's reason. `record_knowledge` keeps its order of checks and its results, apart from the landing rule below and the wording of its cross-profile `not_found` message.
- **Targets and pointers.** Targets resolve only inside the saved record's profile. A landing, moving or moved node answers like an id that never existed, both as a link target and as a `node` pointer, in `record_knowledge` too, and a key lookup skips all three states. An id of another profile gets the same `not_found` message as a missing one, so a scoped caller learns nothing about it. Nothing reads another profile or any pointer's content. Cross-profile links keep their C3 shape: they arise only from transfers, which move edges as they are.
- **Decisions.** `create()` refuses a decision without a pointer (`missing_evidence`). `update()` refuses a decision that would still have no pointer of its own after the call, whatever the change, supersession included. A decision imported without evidence is therefore refused until an update supplies one; nothing is synthesised and no stored row is rewritten. An existing pointer is never cleared: omitted evidence keeps them all, and supplied evidence adds or replaces by kind and ref.
- **Updates.** Evidence and links count as changes. Alone, they add rows around the node without a new revision, as `record_knowledge` does, under an `update` activity. With field changes, they commit with the new revision. Retire and compact refuse them (`invalid_arguments`, `invalid_compact`), and at 90% of the size limit a save carrying them is not a shrink.
- **Atomic.** Everything is in the one write transaction. A refused link, pointer, endpoint, decision rule, guard or budget rolls back the node, head, revision, activity and request row. The Worker releases a new account binding on any refusal, so the same `request_id` can be used again. A read-only account lookup admits successful update replays after a later move, and preserves `idempotency_mismatch` for changed payloads before any new transfer; links and evidence are part of the request hash, and calls without them hash as before.
- **Moves.** The cross-profile `save_memory` branch refuses `content`, `description`, `why`, `how_to_apply`, `objective`, `steps`, `new_name`, `scope`, `retire`, `supersedes`, `evidence` and `links` with `validation` and reason `move_with_changes`, before any new binding, begin or drive. Existing requests are checked by the account's read-only lookup first, so an update already committed before the node moved still replays. The D1 compact guard still answers first.
- **Guard and redaction.** New reasons, refs and notes go through `redactPayload` before hashing, and through the `me` guard inside the transaction, like every other string a write carries.
- **Reads.** `get_memory` returns the node's `evidence` and, for each current edge whose source is readable here (the graph's `owned` rule: not landing, moving or moved), `other_label`, valid times and `evidence`. `explore` already shows link reasons and evidence with its opacity rules. The tool's untrusted-data note is unchanged.
- **Undo.** The shared inverse covers it unchanged: added node pointers and pointers merged into an existing edge are archived, overwritten pointers are put back, added edges go to the archive with their evidence, and a created record leaves with its links. All existing conflict, guard, wipe, moving and closed gates apply.
- No DDL, dependency, error code, endpoint or tool was added.

Scoped evidence, from the private capsule logs (`am-save-links-*`):
- the `save_memory evidence and links` block of `test/write-details.test.ts`, 7 cases: the section 2 call verbatim through get, explore, replay, mismatch and undo; decision refusal with the binding released, evidence kept through updates, an overwritten note restored by undo, and an imported-style decision refused without a pointer; strict schema refusals, including retire and compact; reason, endpoint, rel, target and pointer refusals each leaving no node, activity, request or binding, then a duplicate merged and undone, and an update's link undone with its content; move refusals with no binding or transfer, the same `not_found` for a foreign, a landing, moving, moved and missing id (owner and scoped device), redaction, and `me` guard refusals on a pointer note and a link reason; 20 links of 20 pointers refused as one `size_budget` rollback; a successful evidence update replays after moving its node, and changed evidence still returns `idempotency_mismatch`;
- red check: each of 8 mutations, removing one new check, fails at least one case;
- the original author's affected Worker files (`write-details`, `g3-contracts`, `mcp-auth`, `isolation-recall`, `graph`, `transfer`, `maintenance`, `wipe`, `work-upload`, `owner-model`, `capture`, `import`). One recall fixture saved a decision without evidence; it now cites its ticket;
- Sol continuation: the 7 focused public cases and all 202 cases in the 12 selected affected Worker files passed, as did typecheck and touched-file lint. New regressions first failed on the preserved partial for replay after a move, blank evidence refs, and moving/moved target opacity. Full logs and the original author's 8 mutation failures, initial recall-fixture failure and maintenance alarm timing failure are retained in the private continuation capsule. No maintenance code was changed here.

Remaining:
- The installed caller skill still describes the old `save_memory`; it changes with the cutover skill rewrite. The batch's `save` and `supersede` ops carry no evidence, so on a decision without a pointer they are rejected with `missing_evidence`.
- `as_of` on reads, the untrusted-data wrapper and the compaction-fence output stay open; AM-02 and AM-07 are not complete.

## D2-D5 and public save integration candidate, 2026-10-30

Opus, sole integrator of this private candidate. One additive patch on current126 (126 files, aggregate `91e01937c2aca73c1d27ee1152d3b62c79de3312643a1608751af13d57e5219a`, from its 19 pinned patches). Root is unchanged and its adoption is not authorized here. The glue review, Terra's combined check and all runtime gates are pending. Evidence, maps and the patch are in the private capsule `am-dint-opus-O9o758/capsule-l1`.

Combined source slices, each rebuilt on its named base and checked against its full pinned map:

| Slice | Base | Patch | Result | Review |
|---|---|---|---|---|
| D2/D3 and recovery | `44f58eae…` (current126 steps 1-14) | `4758873d…`, `333bcb3e…` | `e0f8ee92…` | four P2s, corrected below |
| D2/D3 four corrections | `e0f8ee92…` | `a74ee7b2…` | `41207bfd…` | five original cases pass; one new P2 |
| Parent current-grant fix | `41207bfd…` | `ffeed077…` | `5f34b529…` | CLEAR |
| D4/D5 | `e0f8ee92…` | `fd4e5a28…` | `8480b071…` | 13 author controls pass; two P2s |
| Parent meter fixes | `8480b071…` | `59b5f8dd…` | `f3d7ae84…` | CLEAR, both findings |
| Public save evidence and links | `e0f8ee92…` | `b038f297…` | `06409cb2…` | CLEAR |

The three parent fixes, unchanged:
- `src/account/transfers.ts`: account begin computes the caller's current grant before it returns an existing intent. An open intent whose accepted generations changed, or whose job device lost its grant (disabled, revoked, expired, or no longer granting `maintenance` and both profiles), is marked aborted, and the C3 driver cleans it up. Owner begins and decided transfers keep their behavior.
- `src/profile/store.ts` `transfer()`: after the awaited step, the access check runs again with the same node ids before `metered()`. A recovery or account-side close during the await returns `busy` or `profile_wiped`, and no meter row is flushed.
- `src/profile/store.ts` `alarm()`: the background pause needs both a successful meter operation, acknowledgement included, and the account's `background: false`. A failed acknowledgement keeps the pending count and the retry schedule, and background work runs.

Overlap decisions. The D slices were merged over `e0f8ee92…`, and the result over the common `44f58eae…` base with current126:
- `src/profile/store.ts`: the outbox loop keeps the corrected five-argument `settle` (the accepted `me` generation comes from each stored intent) and the D4/D5 `await gate()` after the loop.
- `test/maintenance.test.ts`: both slices fixed one consumed-alarm race. The D4/D5 `armed()` wait is kept, because it still requires a wakeup; the corrected slice's null-tolerant read is dropped. All other cases are the union of both slices.
- `src/profile/write.ts`: a clean three-way merge. It keeps current126's consumed-mention capture for undo and wipe targets, D2/D3's background-origin and inference-evidence rules, and the public save's shared edge writer.
- `test/write-details.test.ts`: the imports are the union of current126 (`purgeOrigin`, `runWrite`) and the public save (`OWNER`).
- `src/profile/maintenance.ts`, `src/profile/read.ts`, `src/mcp.ts` and `src/domain/types.ts`: clean three-way merges. Every other changed file came from exactly one side.
- Canonical docs: current126 text is kept. Each slice's sections were added, and stale status lines now point here. `src/profile/undo.ts`, `src/profile/extract.ts`, the dashboard, the C3 wipe tests and the seven C3 file modes are current126's.

Permanent regressions, in the existing `test/maintenance.test.ts`:
- `begun_revoked` in the existing resume-refusal case: a crash after begin and before the first fence leaves the intent open, the job device is revoked, and the real scheduled alarm aborts the transfer, leaving the source active and writable, `me` empty and the outbox empty. On the reverted account file (`e663cead…`) the transfer commits.
- A failed acknowledgement fails open: with the account past 80,000 rows today, an acknowledgement exception keeps the count and the error, and the queue stage still produces its weekly review. With the meter fix reverted it produces none.
- A recovery or account-side close during a transfer commit's vector await refuses that step, and the `cursors` table is unchanged afterwards; a healthy step still flushes. With the meter fix reverted the recovering step returns `ok`.

Scoped checks on the candidate: `test/maintenance.test.ts` 61/61; `write-details`, `isolation-recall`, `wipe` and `transfer` 71/71; `local/batch.test.mjs` 13/13; typecheck; lint of the 22 touched code and test files. The full Worker and local suites, `npm run check`, browser, model, hosted, auth and native checks did not run.

Limits: layer 1 leaves the public MCP begin-before-fence recovery gap as it was; [layer 2](#layer-2-c3-accepted-intent-recovery-2026-10-30) addresses it in source. The meter accounting limits above remain. The closing mode of the transfer regression was not observed red, because the recovering mode fails first on the reverted source. AM-04, AM-05, AM-06, AM-07, AM-10 and AM-11 remain incomplete.


## C3 public transfer intent recovery: private additive capsule

2026-10-30. Additive to the exact 127-file `5f34b52986b06a31df03a4793fcc7a239cd85fc584b7f353ccf61e5b05ee9abb` source, including the parent's SMALL auth fix. Root and earlier frozen inputs are unchanged. This is source and local synthetic Workers evidence only; independent review, sole-integrator adoption and hosted proof are pending. Status on 2026-10-30: an independent source review was clear, and the sole integrator added it as [layer 2](#layer-2-c3-accepted-intent-recovery-2026-10-30) of the private integration candidate; root adoption and hosted proof remain pending.

- `AccountStore.transfer(begin)` arms an alarm no later than five minutes away before its synchronous transaction can commit. Account v4 adds nullable `intent` and `retry_at` columns to the existing transfer ledger. Begin stores only accepted generation ids, company-free/context/protection policy, and a minimal caller identity with write/maintenance and the two profile names. No token, secret, device label or record content is stored. Both public keyed and unkeyed saves pass this policy through the same C3 driver. Public callers also pin their context's generations before begin.
- The account's real alarm selects at most ten due intents. It reuses `resumeTransfer` and `driveTransfer`, the same transfer id, account decision, exact bundle validation and local target guard. Recovery no longer needs a source fence row to recover the attestation. Transport failure, recovery busy and moving keep a durable retry in 60 seconds. The retry remains until terminal profile cleanup is acknowledged by `settled`; it is not cleared by account `done` alone.
- Every undecided accepted intent reuses begin's current job-device grant check at get and commit. Revoked, disabled, expired, narrowed-profile or narrowed-scope job grants abort, with no owner fallback. The owner context in the alarm obtains current guard terms only. Already decided transfers keep C3's completion and guarded-publication refusal rules. Interactive-owner moves still ignore background protection.
- The accepted source and target generations never change, even for abort cleanup. Replacement/closed generations, wiped ids and lost source ownership abort undecided transfers. Cleanup skips a closed generation through the existing `profile_wiped` gate, and never opens its replacement. The target is cleaned before the source is unfenced. A source abort before any fence also records an abort marker, so a delayed same-transfer driver cannot establish its first fence after cleanup.
- At account `done`, the existing public request record receives its original raw result once. A later move cannot change that result, transfer id, payload binding or replay routing. Old node request ids still rebind through C3. An open accepted intent still blocks profile wipe. Legacy rows without an accepted policy retain their existing source-alarm/replay behavior; no attestation or caller identity is invented for them.

Wiring/canonical scope: account schema/store/transfer ledger, shared driver, source abort step/store access narrowing, MCP generation pins, the existing transfer suite, the account migration assertion in the import suite, this contract, architecture sections 9/12 and AM-04. No new tool, dependency, user setting, model call, backup implementation or alternative move protocol.

Scoped evidence: [transfer tests](../test/transfer.test.ts), `C3 accepted intent alarm recovery`, 18 passing cases. Real public saves lose transport immediately after the account begin commits, before the source fence RPC, and without a request id. The real scheduled account DO alarm then finishes once without caller replay. Controls cover recovery busy and transport retry, a newly registered me term with interrupted abort cleanup, both generation replacements, retired profile/wiped id/lost ownership, current job revocation/expiry/profiles/scopes and a new owner pin, decided-job completion after revocation, interactive pinned moves, a late aborted driver and concurrent same-transfer completion. The public cases assert the pre-fence wipe gate, one final transfer, revision 2, durable raw result before replay, and unchanged replay after another move.

Additional selected existing controls pass: 9 transfer cases, 6 D2/D3 maintenance cases, and the account v1-to-v4 migration case. Typecheck and lint of touched TypeScript pass. No old suite was run wholesale. The capsule retains exact commands, red/green exits, full logs and byte reproduction. The corrected three-case public regression fails on the exact baseline because it has no account alarm; it invokes `runDurableObjectAlarm`, not a helper-only resume. Fixture corrections are separate evidence: workerd RPC forwarding cannot use `.bind`, state-changing controls require separate synthetic accounts, and append requires `request_id`. These are not product fixes.

### Layer 2: C3 accepted intent recovery, 2026-10-30

A separate additive patch on the frozen layer-1 candidate (129 files, aggregate `d59c5745070089fb493dce79c485aee03a56d531f649e413554b8c1425ea3ee7`, patch `1733fca2…`, retained unchanged in `capsule-l1`). Its source is the [C3 intent capsule](#c3-public-transfer-intent-recovery-private-additive-capsule) (pins `befbb3d4…`, patch `562106e6…`), rebuilt on its named base `5f34b529…` to exactly `1e396cb1…`. Its independent review was CLEAR, with 23 candidate cases and the three original missing-wakeup failures reproduced on the base. Evidence is in `am-dint-opus-O9o758/capsule-l2`.

Three-way merge over `5f34b529…`:
- Six files are unchanged by layer 1 and take the reviewed bytes: `src/account/schema.ts`, `src/account/transfers.ts`, `src/transfer.ts`, `src/profile/transfer.ts`, `test/transfer.test.ts` and the migration assertion in `test/import.test.ts`. The seven C3 files keep their 0444 mode.
- `src/account/store.ts`: the imports are the union of C3 (`resumeTransfer`, `transferPorts`) and D5 (`ROW_PAUSE`). D5's `meter` and `nodeStates` sit beside C3's alarm-before-begin and `alarm()`.
- `src/profile/store.ts` `transfer()`: one `ids` list, with C3's optional-`nodeId` narrowing for the pre-fence abort marker, and the parent meter fix's second access check after the step's await, before the flush.
- `src/mcp.ts`: the public save move refusal runs first, then the transfer input carries C3's generation pins.
- The parent current-grant formula and its abort of an undecided job intent are unchanged. C3 also aborts an undecided intent on a closed generation, a wiped id or lost ownership, and reads the stored caller of a row with accepted policy.

Interactions:
- D3 promotions begin with accepted policy too, so the account alarm and the source's D2 outbox can drive the same id. A new permanent case in `test/maintenance.test.ts` crashes after begin and before the fence, runs the account's real alarm first (it commits and clears `retry_at`), then the source's real alarm: the outbox settles the committed id, with one transfer, one `me` copy and a moved source. On layer 1 the case cannot run, because `retry_at` does not exist before account v4.
- Profile transfer steps driven by the account alarm go through the same `ProfileStore.transfer()` gate, so the post-await access check and the meter flush apply to them as well. AccountStore's own rows stay uncounted, as the D5 shortcut already states.
- At account `done`, C3 stores the public request's raw result. Public save treats a transfer binding with a result as replayable and refuses changes to a pending one, so their checks agree. Changed payloads still return `idempotency_mismatch`.
- The account migration goes from v1 to v4 with nullable legacy columns. D4's `nodeStates` treats a row as live only while `open` or `committing`, so an aborted intent awaiting cleanup still has its source in `node_index`.

Scoped checks on the final candidate: `test/maintenance.test.ts` and `test/transfer.test.ts` 100/100, including the new seam case; `write-details` and `wipe` 38/38; the account v2-to-v4 migration case; typecheck; lint of the 10 layer-2 touched files. The full suites, `npm run check`, hosted, browser, model and native checks did not run. Legacy rows without accepted policy keep the old recovery behavior.

### Core MCP replacement candidate assembly, 2026-10-30

The owner prioritizes a usable main MCP and memory-copy trial before optional dashboard work. This private candidate assembles the exact root126 nineteen-patch chain, reviewed L1 and L2, the core shared-readable graph variant, and the latest S1/S2 code-only correction. Shared graph permanent regressions and AM-08 evidence are merged as hunks, preserving the newer core files. The exact source/input maps and scoped commands live in the sealed core candidate capsule. Fresh independent shared review and Terra combined/server-only eligibility assessment remain separate gates; nothing here authorizes adoption or deployment.

L1/L2 retain public save evidence/links, generation and authorization checks, wipe fences, row metering/outbox settlement, inferred-preference promotion and accepted C3 intent recovery. The shared graph keeps exported `owned` alongside `READABLE_NODE` and `readableNodeIds`. No new tool fields, schema or design decision is added by this assembly. Current root instructions are retained rather than L1's historical role-handoff text.

Optional L3 board-backed weekly production/review writing, later PR/Jira acquisition, corpus, self-host tooling, new Entity/Journals pages and the native127 branch are excluded. Existing root126 dashboard source is retained unchanged. The baseline L2 producer can still queue subjectless weekly items; this assembly does not delete that existing behavior or claim a server flag disables it. Local capture/automation must remain uninstalled and inactive until its separate confinement gate. Source presence or a passing synthetic check does not activate it. BothQ remains live until the separately gated cutover.

### Core maintenance context privacy correction, 2026-10-30

The core-only scope check found that L2's common `next` lease still called `context` for every item kind without a readable-node gate. An ordinary unlinked item could include a subject after its real source transfer fence, its description/passage and its source-owned edge reason. Incoming candidate-owned reasons could also reach that ordinary context. This is the same shared helper used by the former L3 weekly path, not a reason to include the optional L3 feature.

Only the previously reviewed context gate is ported here. Subject ids and edge-source ids pass `readableNodeIds` before descriptions, passages or reason-bearing payload SQL. Readable-source links retain opaque targets. Explicit `unprocessed_capture` and `preference_signal` items may read their own leased candidate subjects and those subjects' edges; that exception does not widen other contexts. Lease kinds/allowed ops, producer, completion, requests and outbox behavior are unchanged. No weekly review op, board-backed producer or per-item review receipt is included.

One bounded regression uses the real transfer fence and a synthetic job-token MCP dispatch. It requires an ordinary unlinked item to omit the hidden subject and candidate-owned incoming reason, while its own capture item retains the authorized candidate body/reason. It fails on the frozen f5ee intermediate and passes with the bounded gate. Exact logs and source maps are retained in the additive correction capsule. Independent review of this new core port and Terra combined/server-only eligibility remain separate.

Dependency status: the independent S1/S2 CORE source review reported CLEAR on the pinned shared35/code59 inputs, including payload-SQL gating, instant ordering and budget constraints. Its frozen report and hash are retained as input evidence. That closure does not accept this newly assembled candidate or this common-context port. Dashboard stays deferred; the owner's priority section and current root role instructions remain intact.
