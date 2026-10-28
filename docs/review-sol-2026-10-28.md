# Independent review of docs/architecture.md

Reviewer: Sol (gpt-6.1-sol, high), read-only, 2026-10-28. Verdict: withhold approval until the blockers are resolved. Line numbers refer to architecture.md as reviewed.

## Findings

1. **Blocker. Maintenance is not tool-free.** §12, lines 990-997 claim the proposed `codex exec` command gives the model no tools. `--sandbox read-only` still permits file reads and command execution; clearing MCP servers does not disable shell tools. Injected capture text could access local data outside its queue subjects. Fix: clean configuration, explicitly disable execution and other tools, prevent inherited hooks, verify the actual tool inventory. Source: https://learn.chatgpt.com/docs/agent-approvals-security#common-sandbox-and-approval-combinations

2. **Blocker. Profile moves can lose concurrent writes and break references.** §9, line 823 copies revision N then marks the source moved without fencing appends between those steps; such an append can vanish. The copy omits revisions and request records; same-profile edges may reference nodes left behind. Fix: persist a transfer intent, authorize both profiles, fence source writes, transfer history and retry records, define collision, incoming-edge and tombstone behavior before publishing the destination.

3. **Blocker. Nightly exports lack a consistent snapshot.** §18, lines 1239-1241 page through mutable tables across separate alarms; a concurrent update can export a node at one revision and its texts at another. `AccountStore` (routing, unresolved migration records) is missing from the export. Fix: freeze mutations during export or specify a version-consistent snapshot protocol; back up account state. Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec

4. **Major. PITR cannot return its undo bookmark as specified.** §18, line 1235 calls `ctx.abort()` before returning the bookmark; abort resets the object immediately. Fix: persist the undo bookmark in `AccountStore` before aborting and expose restore status through a separate request. Define reconciliation when restoring `me` removes nodes referenced by another profile, or restoring one profile resurrects a completed move. Source: https://developers.cloudflare.com/durable-objects/api/state/#abort

5. **Major. Capture contradicts its completeness guarantee.** §10, lines 885-896 cap prompts and answers at twenty truncated messages while claiming to retain every prompt and answer. `bundle:<client>:<session>:<head>` collides when PreCompact and SessionEnd produce different digests without a commit. Fix: extract incremental digests locally from all new material, split bounded uploads, identify each immutable capture range separately; test long sessions and repeated events at unchanged HEAD.

6. **Major. Work preferences can leak to `me`.** §9, lines 815-817 route stated preferences before repo routing; the sensitive-term list updates nightly, so a preference naming a new company project can enter `me` and become readable from personal. Fix: route work-derived material to work first; require an explicit agent-produced, company-free promotion to `me`; apply colleague and personal-field restrictions on every write path including moves and imports.

7. **Major. IDs collide across isolated profiles.** §5, line 514 derives ids from scope, type and normalized name without profile identity; the same identity created in work and `me` yields identical ids, and §11 dedupes merged recall by id, silently dropping one. Fix: namespace new ids by creation profile; preserve existing BothQ ids or provide durable aliases during migration.

8. **Major. Migration fabricates historical validity.** §16, line 1117 sets current-state snapshots' `valid_from` to original creation, so a rule changed in October looks true in May. Fix: derive validity from the revision that established the fact; otherwise keep creation as provenance and mark historical validity unknown.

9. **Major. The BothQ contract changes.** §§7 and 12 replace update, retire, history and candidate tools, rename `keyword`/`description`, paginate formerly complete reads. Requests expire after 300 days, and per-profile ledgers miss retries routed elsewhere after rule changes; BothQ keeps operation/hash/result without expiry (memory_store.py:149). Fix: publish a compatibility and caller-migration checklist; keep durable request-to-profile binding and replay protection for retained records.

10. **Major. Identifier matching asserts unsupported outcomes.** §4, line 368 creates `fixes` whenever a referenced ticket is a bug; reverts, investigations or doc commits can mention it without fixing it. Fix: use `relates_to` for identifier mentions; reserve stronger relations for explicit structured evidence or reasoned agent writes.

11. **Minor. Free-plan claims and machinery.** §17, line 1154 presents DO CPU as a verified 10 ms limit, while DO docs list 30 s default. Output caps do not bound graph visits or SQL scans. Remove the unrequired core `query_sql` tool, bound traversal work, defer unused phase-one schema. Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ and https://developers.cloudflare.com/workers/platform/limits/

## Verified OK

- Server-role boundary matches the latest requirements: bindings, embeddings, deterministic housekeeping; GitHub/Jira work stays local.
- Single-profile synchronous transactions support atomic appends, revision checks, supersession, promotion.
- DO daily quotas correctly stated; index writes, virtual-table writes, deletes and alarm scheduling consume writes.
- qwen3-embedding-0.6b id, batch input, 8,192-token context, 1,075-neuron pricing documented; output dimensions remain a verification gate.
- Pinned-key Clerk verification can be networkless; audience and loopback interop correctly gated.
- Detached hook, retention protection gate and two-export rotation match the requested shape.

Unverified: live OAuth, deployed quotas, hook behavior, restore drills.
