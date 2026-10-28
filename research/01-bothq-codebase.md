# BothQ codebase map

Source: Sol (gpt-6.1-sol, high) read-only research, 2026-10-28. File links point into /Users/pratyush.poddar/Projects/bot_hq.

BothQ is a local engineering command centre with three distinct systems: a revisioned memory engine, a Sequoia provenance corpus, and a graph-mediated bot fleet. The memory engine is the clearest starting point for the hosted redesign.

## 1. Layout and status

| Directory | Purpose and status |
|---|---|
| `architect-agent/` | Runnable discovery/design pipeline. `phases/` produces design documents and QA handoffs. Design generation calls Anthropic (phases/design.py:23). |
| `qa-agent/` | Runnable QA pipeline: lint, tests, security, contracts, business rules, diffs; audience-specific reports (qa_bot.py:430). |
| `observer-agent/` | HTTP runtime verification and recording proxy. Several protocol capabilities still planned (observer_bot.py:150, REGISTRY.md:45). |
| `dispatch/` | Briefs consumed by the architect. No longer an executable dispatch queue (CLAUDE.md:201). |
| `shared/` | Bot context, knowledge, routing patterns, decisions, observations, reports, fixtures (CLAUDE.md:452). |
| `memory/` | Legacy flat feedback material. Authoritative memory is graph-first (CLAUDE.md:395). |
| `graph-db/` | Active MCP, persistence, retrieval, corpus, dashboard, engines; `connectors/`, `migrations/`, `tests/`, `dashboard/`, `automation/` (README.md:257). |
| `graph-db/data`, `logs`, `plugins` | Neo4j files, logs, APOC/GDS jars (docker-compose.yml:17). |
| `bootstrap/`, `scripts/` | Installer plus bundled Cypher snapshot; snapshot exporter. |
| `ollama-service/` | Optional local embeddings (nomic-embed-text, 768d) and phi4-mini classification/summarization, started on demand. |
| `_retired/` | Old command bus, pending queue, direct Figma sync. |
| `.claude/` | Three bot subagent wrappers, project-local bot memories, SessionStart orientation hook. |

## 2. MCP server

52 tools over stdio (45 base + 7 memory additions); JSON schema validation; client-handshake attribution; memory I/O concurrency limited to 4 (mcp_server.py:43, memory_mcp.py:80).

| Area | Tools |
|---|---|
| Memory | save_memory, get_memory, update_memory, append_memory, retire_memory, recall_memories, list_memories, memory_history, capture_memory, memory_candidates, promote_memory, dismiss_memory |
| Rules/routines | find_rule, find_routine |
| Graph | graph_query, graph_summary, graph_health |
| Alerts | active_alerts, acknowledge_alert |
| Tickets/priorities | ticket_context, register_ticket, update_ticket_status, list_tickets, priority_board |
| Heal/review | heal_sweep, heal_verdict, heal_pressure, review_signal_pack, hypothesis_deadline_alerts, mark_hypothesis_shipped |
| Cross-bot | cross_bot_consensus, design_gaps, open_findings, observation_requests, unmet_observations, bot_kpis, journey_blast_radius, record_code_fix_dispatch |
| Corpus | corpus_summary, corpus_schema, corpus_search, corpus_repo, corpus_commit, corpus_ticket, corpus_release, corpus_person, corpus_sql, corpus_pr, corpus_session, corpus_architecture |
| Ingest | ingest_figma_payload, ingest_confluence_payload |

### Memory tool contracts

| Tool | Semantics |
|---|---|
| save_memory | name, type, description required; content, why, how_to_apply, scope, request_id, expected_revision, supersedes. Procedural needs objective + ordered steps. Duplicate active identity conflicts unless revision directs update. |
| get_memory | memory_id or unambiguous name (+scope). Full active content, revision, steps, relationships. |
| update_memory | Identity + changed fields; new_name, destination scope, from_scope. Keeps identity, snapshots revision. |
| append_memory | Identity, content, required request_id, optional expected_revision. Atomic newline append. Rejected for procedural. |
| retire_memory | Sets retired status and validity end; keeps history. |
| memory_history | Bounded revision window, chronological, older-page cursor. |
| recall_memories | keyword, type, scope, limit, token_budget. Ranked passages with ids, revisions, freshness, provenance. |
| list_memories | Optional type. Legacy inventory, no scope or pagination. |
| capture_memory | Content, name, scope, kind, request_id, string source metadata. Redacted, untrusted evidence. |
| memory_candidates / promote_memory / dismiss_memory | Candidate review queue; promotion atomically saves and links. |

Cross-cutting: optional expected_revision (optimistic concurrency) + record locks; request_id stores op/payload hash and result (changed input under same id conflicts); supersedes retires prior guidance atomically; scopes are organizational filters, not auth boundaries; `#N` ticket guard against HQTicket; system-seeded routines protected (memory_store.py:149, :273).

## 3. Memory internals

- memory_store.py: transactions, normalized identities, UUID5 ids (memory_config.py:20), legacy adoption, revisions (save/update/retire = snapshots, append = deltas), scope moves, embedding invalidation.
- Labels: MemoryRecord + Rule/Decision/Resource/Routine/UserMemory; MemoryRevision, MemoryRequest, MemoryScope, MemoryStep:Step:Entity, MemoryCandidate. Relationships BELONGS_TO, WAS_ATTRIBUTED_TO, HAS_REVISION, LATEST_REVISION, SUPERSEDES, HAS_STEP, NEXT, MIGRATED_FROM, PROMOTED_TO.
- memory_search.py: exact-name and literal substring boosts + Lucene full-text + optional cosine vectors, fused with reciprocal-rank fusion k=60, dedup by parent. Candidate cap 200, passages 700 chars, tokens estimated chars/4 (memory_search.py:163, :287, :430).
- Embeddings off by default; worker embeds outside transactions, publishes only if revision/hash still match; retries, cache, timeouts, circuit breaker; input truncated at 16,000 chars.
- Capture: JSON on stdin, capture/replay; spool under ~/.bothq/capture-spool (1,000 files / 64 MiB); heuristic redaction (memory_privacy.py:12). No capture hooks are wired in any agent config.

## 4. Other engines (bot-fleet / work specific)

heal_engine.py (7 detectors), review_engine.py (7 signal streams), priority_engine.py (ticket/PR scoring), cross_bot.py, bot_relay.py, observability.py, connectors/ (Jira, GitHub via gh, drift; Figma/Confluence via MCP payloads), workplace.py, hq_tickets.py, seeds.

## 5. Corpus (~/.bothq/corpus/sequoia.sqlite, 3.2 GB, read-only)

| Group | Rows |
|---|---|
| Git | repos 87; commits 525,133; commit_paths 1,741,957; refs 310,332; contributors 998 |
| Tickets/delivery | tickets 291,786; ticket_episodes 7,225; pull_requests 134,966; releases 41,826 |
| Sessions | codex_sessions 455; session_messages 8,867; session_decisions 11,804; user_directives 7,723 |
| Architecture/frontend | api_endpoints 564; packages 50; frontend_files 44,421 |
| Search | corpus_search_documents 1,704,174 (FTS5) |

## 6. Dashboard

Python static HTML/JS with fixed read APIs; projects, modules, people, commits, tickets, sessions, journals (as dated timelines), knowledge maps. GET/HEAD only, localhost-only checks.

## 7. Runtime

Neo4j 5.26 Community + dashboard containers on loopback (7474, 7687, 8766). MCP is spawned per agent over stdio (.mcp.json, ~/.codex/config.toml:102). Tests use a disposable Neo4j.

## 8. Neo4j-specific dependencies a port must replace

Cypher traversal, multi-label nodes, relationship properties, temporal functions, uniqueness constraints, transactional locks/retries, elementId addressing, full-text and vector index procedures, apoc.merge.relationship (Jira). GDS enabled but unused.

## 9. Preserve or consciously drop

1. Stable identities survive renames and scope moves.
2. Atomic revisions preserve prior guidance.
3. Retry ids detect changed payloads.
4. Replacement writes need revision checks.
5. Capture and authoritative guidance stay separate.
6. Retirement and supersession keep evidence.
7. Literal identifiers stay searchable without embeddings.
8. Embedding failures never undo committed memory.
9. Detailed corpus evidence stays separately addressable.
10. Hosted authentication must replace shared local trust.

Open items: README vs code drift (command bus, nightly tests); review ritual updates hypothesis status through update_memory, whose schema rejects it; legacy Routine.name uniqueness conflicts with per-scope names; get_memory hides retired records; capture and embedding scheduling never wired.
