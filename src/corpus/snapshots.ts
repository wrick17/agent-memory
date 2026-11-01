// Per-profile dated snapshots (section 14 "Pattern statistics": heavier or curated tables stay dated snapshots). Migration 4 of the
// CorpusStore; the store routes these tables here before its bulk and HELD checks (store.ts checkChunk, applyChunk). Evidence: the retained schema inventory corpus-schema.json (4575c22a…) for the exact DDL, columns
// and paging key (every table is a rowid table without a declared key), and privacy-lineage.json (12121454…), which proves nothing about
// these tables' JSON content, so it gets no exemption from the existing row checks.
//
// Contract:
// - Unit: one snapshot SET per profile generation (today one set, `patterns`, the seven cross-repo pattern tables built together on
//   2026-08-12). Rows are never split per repo. A set is one immutable CUT: (set, source file SHA-256, as_of, every member's schema SHA-256),
//   identified by `cutIdOf`. A published cut never changes.
// - Load: the existing bulk route and chunk body (POST /v1/corpus/import: table, schema_sha256, source.file_sha256, as_of, columns, after,
//   rows, final, sha256), with the same generation pin, import grant, work guard terms, redaction-before-hash, row/byte budgets, key order
//   and checkRow privacy (contact, personal, forbidden lineage). For a snapshot table the store derives the cut from the chunk, appends
//   rows in key order (rowid, or the declared WITHOUT ROWID key) to that table's STAGE table, and keys replays as `corpus:snapshot:<cut_id>:<table>:<first key>`, so two cuts
//   never collide. A chunk for a cut other than the set's loading cut starts that cut only if its as_of is strictly newer than the
//   published cut's (an older or equal cut is refused stale_snapshot). Abandoning a cut atomically deletes its stage rows AND
//   corpus_requests entries with the `corpus:snapshot:<cut_id>:` prefix. Restarting an eligible abandoned cut resets its existing
//   ledger row to loading with empty tables. Published-cut request entries stay, so a lost response can still replay safely.
// - Publish (replacement): when every member table of the loading cut has received its final chunk, one transaction replaces each live
//   table's rows with its stage rows, empties the stages, marks the old cut superseded and the new one published, and sets each table's
//   corpus_meta row (source = cut source, as_of = cut as_of, refresh "snapshot", complete 1, rows). Readers see the old cut or the new one,
//   never a mix; the existing read gate is unchanged. Retention: one published cut per set; superseded and abandoned cuts keep only
//   their corpus_snapshots provenance row.
//   This atomic publish is a corpus transaction whose writes grow with the set; corpus export cuts must account for it.
// - Status (additive): `snapshot_families` (snapshotManifest) and `snapshots` (each set's published and loading cut with per-table
//   rows); `families` and `scan_families` are unchanged. History and scan refresh headers and plan ids are untouched.
// - Wipe and recovery: the generation's close/clear covers live, stage and corpus_snapshots rows (deleteAll). Export and PIT carry the
//   live tables and corpus_snapshots; stage tables are restart state and are not exported: a restore that holds a `loading` cut marks it
//   abandoned with the same atomic stage/request cleanup before reopening. The uploader resends from the first chunk. SQL read sets
//   containing a corpus_stage_* table are refused before execution, so unpublished rows never become query results.
import { sha256 } from "../domain/ids";
import { knowledgeTerms } from "../domain/guard";
import { REDACTED } from "../domain/redact";
import { Fail } from "../domain/types";
import { CHUNK_ROWS, checkRow, chunkHash, compareKeys, type Family, type Key, type Value } from "./families";

const CONTACT = "contact field: emails never upload (personal-field rule, section 4)";

export interface SnapshotFamily {
	/** The source's CREATE TABLE text, byte for byte; schema_sha256 is its SHA-256. No original index exists for these tables. */
	ddl: string;
	/** Upload projection in order; `rowid` leads, so the source row identity and paging key survive. */
	columns: Record<string, "text" | "integer" | "real">;
	/** Original columns never uploaded (stored NULL), with the rule that drops them. */
	omit: Record<string, string>;
	/** Columns naming one repo (work guard project terms), one person, or a JSON array of person names. */
	repos: string[]; people: string[]; peopleJson: string[];
	/** Paging and replay key: ["rowid"] when absent, else the original WITHOUT ROWID primary key in order. */
	key?: string[];
	/** Original indexes, byte for byte, created on the live table only. */
	indexes?: string[];
}

const PATTERN_FAMILIES: Record<string, SnapshotFamily> = {
	pattern_coordinated_changes: {
		ddl: "CREATE TABLE pattern_coordinated_changes(\n  episode_id TEXT,\n  ticket TEXT,\n  classification TEXT,\n  confidence TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  span_days REAL,\n  repo_count INT,\n  commit_count INT,\n  non_merge_repos INT,\n  layers_json TEXT\n)",
		columns: { rowid: "integer", episode_id: "text", ticket: "text", classification: "text", confidence: "text", first_at: "text", last_at: "text", span_days: "real", repo_count: "integer", commit_count: "integer", non_merge_repos: "integer", layers_json: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: [],
	},
	pattern_coordinated_change_repos: {
		ddl: "CREATE TABLE pattern_coordinated_change_repos(\n  episode_id TEXT,\n  repo TEXT,\n  layer TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  commits INT,\n  non_merge_commits INT,\n  authors_json TEXT,\n  subjects_json TEXT\n)",
		columns: { rowid: "integer", episode_id: "text", repo: "text", layer: "text", first_at: "text", last_at: "text", commits: "integer", non_merge_commits: "integer", authors_json: "text", subjects_json: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: ["authors_json"],
	},
	pattern_synchronized_migrations: {
		ddl: "CREATE TABLE pattern_synchronized_migrations(\n  episode_id TEXT,\n  normalized_subject TEXT,\n  confidence TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  span_hours REAL,\n  repo_count INT,\n  commit_count INT,\n  authors_json TEXT,\n  common_paths_json TEXT\n)",
		columns: { rowid: "integer", episode_id: "text", normalized_subject: "text", confidence: "text", first_at: "text", last_at: "text", span_hours: "real", repo_count: "integer", commit_count: "integer", authors_json: "text", common_paths_json: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: ["authors_json"],
	},
	pattern_migration_commits: {
		ddl: "CREATE TABLE pattern_migration_commits(\n  episode_id TEXT,\n  repo TEXT,\n  sha TEXT,\n  committer_at TEXT,\n  author_name TEXT,\n  author_email TEXT,\n  subject TEXT,\n  paths_json TEXT\n)",
		columns: { rowid: "integer", episode_id: "text", repo: "text", sha: "text", committer_at: "text", author_name: "text", subject: "text", paths_json: "text" },
		omit: { author_email: CONTACT },
		repos: ["repo"], people: ["author_name"], peopleJson: [],
	},
	pattern_lineage_edges: {
		ddl: "CREATE TABLE pattern_lineage_edges(\n  repo_a TEXT,\n  repo_b TEXT,\n  shared_commits INT,\n  pct_of_smaller REAL,\n  first_shared_at TEXT,\n  last_shared_at TEXT,\n  first_unique_a TEXT,\n  first_unique_b TEXT,\n  last_unique_a TEXT,\n  last_unique_b TEXT,\n  explicit_cherry_a_to_b INT,\n  explicit_cherry_b_to_a INT,\n  confidence TEXT,\n  inference TEXT\n)",
		columns: { rowid: "integer", repo_a: "text", repo_b: "text", shared_commits: "integer", pct_of_smaller: "real", first_shared_at: "text", last_shared_at: "text", first_unique_a: "text", first_unique_b: "text", last_unique_a: "text", last_unique_b: "text", explicit_cherry_a_to_b: "integer", explicit_cherry_b_to_a: "integer", confidence: "text", inference: "text" },
		omit: {  },
		repos: ["repo_a","repo_b"], people: [], peopleJson: [],
	},
	pattern_findings: {
		ddl: "CREATE TABLE pattern_findings(\n  finding_id TEXT,\n  category TEXT,\n  title TEXT,\n  confidence TEXT,\n  evidence_type TEXT,\n  temporal_scope TEXT,\n  summary TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  repo_count INT,\n  commit_count INT,\n  evidence_json TEXT,\n  reproducible_sql TEXT\n)",
		columns: { rowid: "integer", finding_id: "text", category: "text", title: "text", confidence: "text", evidence_type: "text", temporal_scope: "text", summary: "text", first_at: "text", last_at: "text", repo_count: "integer", commit_count: "integer", evidence_json: "text", reproducible_sql: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: [],
	},
	pattern_finding_repos: {
		ddl: "CREATE TABLE pattern_finding_repos(\n  finding_id TEXT,\n  repo TEXT,\n  role TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  metric REAL,\n  evidence_json TEXT\n)",
		columns: { rowid: "integer", finding_id: "text", repo: "text", role: "text", first_at: "text", last_at: "text", metric: "real", evidence_json: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
	},
};

// ---------- v5 record-type families (migration 5), active in SNAPSHOTS beside the frozen v4 patterns ----------
//
// Per-profile dated snapshot sets for the record types the corpus tool must answer by exact get (section 14 query tools): PRs, tickets
// and sessions, plus release/tag metadata and the curated judgment tables. Source: the retained local corpus file only, through the
// existing bulk route and every snapshot protection above; no PR, Jira or session feed. Each set publishes on its own, so one publish
// transaction is bounded by its set. Exact DDL and index SQL come from the inventory corpus-schema.json (4575c22a…).
// Consumers (wired): the active SNAPSHOTS/SNAPSHOT_SETS compose these beside the frozen v4 registry; migration 5 creates them; paging, replay
// and stage continuation use `key` (rowid or the WITHOUT ROWID primary key: after = the stage's greatest key, replay id hashes a composite first key like
// requestIdOf); every column identifier is quoted (frontend_workflows has "trigger"); answer
//   get pr      key "owner/repo#number"  -> pull_requests row, its pr_tickets and pr_commit_links;
//   get ticket  key "KEY-1"              -> its ticket_episodes and tickets commit links (500-row cap, truncated flag);
//   get session key session_id           -> codex_sessions metadata, its session_commit_links and session_ticket_links;
// with explore corpus counts for pr (`github:owner/repo#n`), ticket (`jira:KEY`) and session (`session:codex:<id>`) nodes.
// Search documents are not built for these rows. Raw session text, session_reference_index and pattern_session_* stay held.
const BUILDER_KEY = "builder key: untyped duplicate of the row's natural key; never uploaded";
const LOCAL_PATH = "local filesystem path or store location on the owner's machine (personal-field rule)";
const UNPROVED = "relevance content unproved by privacy-lineage; may carry session text";

export const SNAPSHOTS_V5: Record<string, SnapshotFamily> = {
	pull_requests: {
		ddl: "CREATE TABLE pull_requests(\n  pr_key,\n  repo TEXT,\n  number INT,\n  title TEXT,\n  body TEXT,\n  state TEXT,\n  is_draft INT,\n  author TEXT,\n  created_at TEXT,\n  updated_at TEXT,\n  closed_at TEXT,\n  merged_at TEXT,\n  merged_by TEXT,\n  base_ref TEXT,\n  base_sha TEXT,\n  head_ref TEXT,\n  head_sha TEXT,\n  head_repo TEXT,\n  merge_sha TEXT,\n  commit_count INT,\n  labels_json TEXT,\n  milestone_json TEXT,\n  requested_reviewers_json TEXT,\n  requested_teams_json TEXT,\n  tickets_json TEXT,\n  url TEXT,\n  rest_present INT,\n  \"pr_key:1\" TEXT\n)",
		columns: { rowid: "integer", repo: "text", number: "integer", title: "text", body: "text", state: "text", is_draft: "integer", author: "text", created_at: "text", updated_at: "text", closed_at: "text", merged_at: "text", merged_by: "text", base_ref: "text", base_sha: "text", head_ref: "text", head_sha: "text", head_repo: "text", merge_sha: "text", commit_count: "integer", labels_json: "text", milestone_json: "text", requested_reviewers_json: "text", requested_teams_json: "text", tickets_json: "text", url: "text", rest_present: "integer" },
		omit: { "pr_key": BUILDER_KEY, "pr_key:1": BUILDER_KEY },
		repos: ["repo","head_repo"], people: ["author","merged_by"], peopleJson: [],
		indexes: ["CREATE INDEX pull_requests_repo_number ON pull_requests(repo,number)"],
	},
	pr_tickets: {
		ddl: "CREATE TABLE pr_tickets(repo TEXT,number INT,ticket TEXT)",
		columns: { rowid: "integer", repo: "text", number: "integer", ticket: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
	},
	pr_commit_links: {
		ddl: "CREATE TABLE pr_commit_links(\n  repo TEXT,\n  number INT,\n  relation TEXT,\n  sha TEXT\n)",
		columns: { rowid: "integer", repo: "text", number: "integer", relation: "text", sha: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
		indexes: ["CREATE INDEX pr_commit_links_sha ON pr_commit_links(repo,sha)"],
	},
	releases: {
		ddl: "CREATE TABLE releases(\n  release_key,\n  repo TEXT,\n  id INT,\n  tag_name TEXT,\n  target_commitish TEXT,\n  name TEXT,\n  body TEXT,\n  draft INT,\n  prerelease INT,\n  author TEXT,\n  created_at TEXT,\n  published_at TEXT,\n  url TEXT,\n  assets_json TEXT\n)",
		columns: { rowid: "integer", repo: "text", id: "integer", tag_name: "text", target_commitish: "text", name: "text", body: "text", draft: "integer", prerelease: "integer", author: "text", created_at: "text", published_at: "text", url: "text", assets_json: "text" },
		omit: { "release_key": BUILDER_KEY },
		repos: ["repo"], people: ["author"], peopleJson: [],
	},
	github_tags: {
		ddl: "CREATE TABLE github_tags(\n  repo TEXT,\n  refname TEXT,\n  short_name TEXT,\n  target_sha TEXT,\n  object_type TEXT,\n  creator_date TEXT,\n  author_name TEXT,\n  author_email TEXT,\n  subject TEXT\n)",
		columns: { rowid: "integer", repo: "text", refname: "text", short_name: "text", target_sha: "text", object_type: "text", creator_date: "text", author_name: "text", subject: "text" },
		omit: { "author_email": CONTACT },
		repos: ["repo"], people: ["author_name"], peopleJson: [],
	},
	tickets: {
		ddl: "CREATE TABLE tickets (\n    ticket TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL,\n    PRIMARY KEY (ticket, repo, sha)\n  ) WITHOUT ROWID",
		columns: { ticket: "text", repo: "text", sha: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
		key: ["ticket","repo","sha"],
		indexes: ["CREATE INDEX tickets_repo ON tickets(repo, ticket)"],
	},
	ticket_episodes: {
		ddl: "CREATE TABLE ticket_episodes (\n    episode_id TEXT PRIMARY KEY,ticket TEXT,episode_no INTEGER,repo_count INTEGER,\n    commit_count INTEGER,unique_sha_count INTEGER,non_merge_repos INTEGER,\n    first_date TEXT,last_date TEXT,span_days REAL,classification TEXT,confidence TEXT\n  )",
		columns: { rowid: "integer", episode_id: "text", ticket: "text", episode_no: "integer", repo_count: "integer", commit_count: "integer", unique_sha_count: "integer", non_merge_repos: "integer", first_date: "text", last_date: "text", span_days: "real", classification: "text", confidence: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: [],
		indexes: ["CREATE INDEX ticket_episode_ticket ON ticket_episodes(ticket)"],
	},
	codex_sessions: {
		ddl: "CREATE TABLE codex_sessions(session_id TEXT PRIMARY KEY,source_file TEXT,store TEXT,created_at TEXT,cwd TEXT,\n    originator TEXT,cli_version TEXT,git_repo TEXT,git_branch TEXT,git_commit TEXT,events INTEGER,relevant INTEGER,relevance_json TEXT)",
		columns: { rowid: "integer", session_id: "text", created_at: "text", originator: "text", cli_version: "text", git_branch: "text", git_commit: "text", events: "integer", relevant: "integer" },
		omit: { "source_file": LOCAL_PATH, "store": LOCAL_PATH, "cwd": LOCAL_PATH, "git_repo": LOCAL_PATH, "relevance_json": UNPROVED },
		repos: [], people: [], peopleJson: [],
	},
	session_commit_links: {
		ddl: "CREATE TABLE session_commit_links(session_id TEXT,commit_ref TEXT,repo TEXT,sha TEXT,resolution TEXT,\n          PRIMARY KEY(session_id,commit_ref,repo,sha))",
		columns: { rowid: "integer", session_id: "text", commit_ref: "text", repo: "text", sha: "text", resolution: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
		indexes: ["CREATE INDEX session_commit_links_sha ON session_commit_links(repo,sha)"],
	},
	session_ticket_links: {
		ddl: "CREATE TABLE session_ticket_links(session_id TEXT,ticket TEXT,PRIMARY KEY(session_id,ticket))",
		columns: { rowid: "integer", session_id: "text", ticket: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: [],
	},
	validated_contracts: {
		ddl: "CREATE TABLE validated_contracts(\n        key TEXT PRIMARY KEY,name TEXT,journey TEXT,repository TEXT,sha TEXT,confidence TEXT,\n        auth_contract_json TEXT,failure_boundaries_json TEXT,provenance_json TEXT)",
		columns: { rowid: "integer", key: "text", name: "text", journey: "text", repository: "text", sha: "text", confidence: "text", auth_contract_json: "text", failure_boundaries_json: "text", provenance_json: "text" },
		omit: {  },
		repos: ["repository"], people: [], peopleJson: [],
	},
	frontend_business_facts: {
		ddl: "CREATE TABLE frontend_business_facts(\n  fact_id TEXT,\n  repo_key TEXT,\n  domain TEXT,\n  fact_type TEXT,\n  statement TEXT,\n  confidence REAL,\n  snapshot_id TEXT,\n  evidence_json TEXT,\n  notes TEXT\n)",
		columns: { rowid: "integer", fact_id: "text", repo_key: "text", domain: "text", fact_type: "text", statement: "text", confidence: "real", snapshot_id: "text", evidence_json: "text", notes: "text" },
		omit: {  },
		repos: ["repo_key"], people: [], peopleJson: [],
	},
	frontend_workflows: {
		ddl: "CREATE TABLE frontend_workflows(\n  workflow_id TEXT,\n  repo_key TEXT,\n  domain TEXT,\n  name TEXT,\n  actor TEXT,\n  \"trigger\" TEXT,\n  steps_json TEXT,\n  outcomes_json TEXT,\n  confidence REAL,\n  snapshot_id TEXT,\n  evidence_json TEXT,\n  notes TEXT\n)",
		columns: { rowid: "integer", workflow_id: "text", repo_key: "text", domain: "text", name: "text", actor: "text", trigger: "text", steps_json: "text", outcomes_json: "text", confidence: "real", snapshot_id: "text", evidence_json: "text", notes: "text" },
		omit: {  },
		repos: ["repo_key"], people: [], peopleJson: [],
	},
	frontend_relationships: {
		ddl: "CREATE TABLE frontend_relationships(\n  relationship_id TEXT,\n  source_kind TEXT,\n  source_key TEXT,\n  relation TEXT,\n  target_kind TEXT,\n  target_key TEXT,\n  confidence REAL,\n  evidence_json TEXT,\n  notes TEXT\n)",
		columns: { rowid: "integer", relationship_id: "text", source_kind: "text", source_key: "text", relation: "text", target_kind: "text", target_key: "text", confidence: "real", evidence_json: "text", notes: "text" },
		omit: {  },
		repos: [], people: [], peopleJson: [],
	},
	frontend_uncertainties: {
		ddl: "CREATE TABLE frontend_uncertainties(\n  uncertainty_id TEXT,\n  repo_key TEXT,\n  statement TEXT,\n  reason TEXT,\n  resolution TEXT,\n  severity TEXT\n)",
		columns: { rowid: "integer", uncertainty_id: "text", repo_key: "text", statement: "text", reason: "text", resolution: "text", severity: "text" },
		omit: {  },
		repos: ["repo_key"], people: [], peopleJson: [],
	},
	ownership: {
		ddl: "CREATE TABLE ownership(\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  line INT,\n  pattern TEXT,\n  owners TEXT\n)",
		columns: { rowid: "integer", repo: "text", sha: "text", path: "text", line: "integer", pattern: "text", owners: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
	},
	predecessor_links: {
		ddl: "CREATE TABLE predecessor_links(\n  archived_repo TEXT,\n  current_repo TEXT,\n  confidence TEXT,\n  basis TEXT,\n  evidence TEXT\n)",
		columns: { rowid: "integer", archived_repo: "text", current_repo: "text", confidence: "text", basis: "text", evidence: "text" },
		omit: {  },
		repos: ["archived_repo","current_repo"], people: [], peopleJson: [],
	},
	journey_edges: {
		ddl: "CREATE TABLE journey_edges(\n  journey TEXT,\n  repo TEXT,\n  confidence TEXT,\n  basis TEXT\n)",
		columns: { rowid: "integer", journey: "text", repo: "text", confidence: "text", basis: "text" },
		omit: {  },
		repos: ["repo"], people: [], peopleJson: [],
	},
};

export const SNAPSHOT_SETS_V5: Record<string, string[]> = {
	pull_requests: ["pull_requests", "pr_tickets", "pr_commit_links"],
	releases: ["releases", "github_tags"],
	tickets: ["tickets", "ticket_episodes"],
	sessions: ["codex_sessions", "session_commit_links", "session_ticket_links"],
	judgment: ["validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties", "ownership", "predecessor_links", "journey_edges"],
};

// Migration 6: remaining section-14 release, policy, workflow and delivery patterns stay dated snapshots.
// Original builders are unavailable; importing their exact approved projections avoids inventing statistical semantics or feeds.
export const SNAPSHOTS_V6: Record<string, SnapshotFamily> = {
	pattern_release_batches: {
		ddl: "CREATE TABLE pattern_release_batches(\n  tag_name TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  span_hours REAL,\n  repo_count INT,\n  release_count INT,\n  authors_json TEXT,\n  targets_json TEXT,\n  confidence TEXT\n)",
		columns: {"rowid": "integer", "tag_name": "text", "first_at": "text", "last_at": "text", "span_hours": "real", "repo_count": "integer", "release_count": "integer", "authors_json": "text", "targets_json": "text", "confidence": "text"},
		omit: {}, repos: [], people: [], peopleJson: ["authors_json"],
	},
	pattern_release_batch_repos: {
		ddl: "CREATE TABLE pattern_release_batch_repos(\n  tag_name TEXT,\n  repo TEXT,\n  published_at TEXT,\n  target_commitish TEXT,\n  author TEXT,\n  url TEXT\n)",
		columns: {"rowid": "integer", "tag_name": "text", "repo": "text", "published_at": "text", "target_commitish": "text", "author": "text", "url": "text"},
		omit: {}, repos: ["repo"], people: ["author"], peopleJson: [],
	},
	pattern_release_actor_yearly: {
		ddl: "CREATE TABLE pattern_release_actor_yearly(\n  year TEXT,\n  actor TEXT,\n  release_count INT,\n  repo_count INT,\n  tag_count INT,\n  first_at TEXT,\n  last_at TEXT\n)",
		columns: {"rowid": "integer", "year": "text", "actor": "text", "release_count": "integer", "repo_count": "integer", "tag_count": "integer", "first_at": "text", "last_at": "text"},
		omit: {}, repos: [], people: ["actor"], peopleJson: [],
	},
	pattern_branch_strategy_yearly: {
		ddl: "CREATE TABLE pattern_branch_strategy_yearly(\n  year TEXT,\n  lane TEXT,\n  pr_count INT,\n  merged_count INT\n)",
		columns: {"rowid": "integer", "year": "text", "lane": "text", "pr_count": "integer", "merged_count": "integer"},
		omit: {}, repos: [], people: [], peopleJson: [],
	},
	pattern_current_repo_policies: {
		ddl: "CREATE TABLE pattern_current_repo_policies(\n  repo TEXT,\n  default_branch TEXT,\n  merge_commit_allowed INT,\n  rebase_merge_allowed INT,\n  squash_merge_allowed INT,\n  delete_branch_on_merge INT,\n  observed_branch_protections INT,\n  observation_caveat TEXT\n)",
		columns: {"rowid": "integer", "repo": "text", "default_branch": "text", "merge_commit_allowed": "integer", "rebase_merge_allowed": "integer", "squash_merge_allowed": "integer", "delete_branch_on_merge": "integer", "observed_branch_protections": "integer", "observation_caveat": "text"},
		omit: {}, repos: ["repo"], people: [], peopleJson: [],
	},
	pattern_workflow_dependencies: {
		ddl: "CREATE TABLE pattern_workflow_dependencies(\n  uses_ref TEXT,\n  repo_count INT,\n  workflow_count INT,\n  invocation_count INT,\n  source_repo_present INT,\n  confidence TEXT\n)",
		columns: {"rowid": "integer", "uses_ref": "text", "repo_count": "integer", "workflow_count": "integer", "invocation_count": "integer", "source_repo_present": "integer", "confidence": "text"},
		omit: {}, repos: [], people: [], peopleJson: [],
	},
	delivery_clusters: {
		ddl: "CREATE TABLE delivery_clusters(\n  kind TEXT,\n  cluster_key TEXT,\n  confidence TEXT,\n  first_at TEXT,\n  last_at TEXT,\n  repo_count INT,\n  pr_count INT,\n  evidence_json TEXT\n)",
		columns: {"rowid": "integer", "kind": "text", "cluster_key": "text", "confidence": "text", "first_at": "text", "last_at": "text", "repo_count": "integer", "pr_count": "integer", "evidence_json": "text"},
		omit: {}, repos: [], people: [], peopleJson: [],
	},};
export const SNAPSHOT_SETS_V6: Record<string, string[]> = { delivery_patterns: ["pattern_release_batches", "pattern_release_batch_repos", "pattern_release_actor_yearly", "pattern_branch_strategy_yearly", "pattern_current_repo_policies", "pattern_workflow_dependencies", "delivery_clusters"] };

/** Snapshot sets: the tables one cut replaces together. */
/** The frozen v4 `patterns` set in its migration-4 order: its DDL, migration bytes, cut ids and receipt ids never change. */
const PATTERNS = Object.keys(PATTERN_FAMILIES);
/** The active registry: the v4 patterns and the v5 record-type families, in disjoint sets. */
export const SNAPSHOTS: Record<string, SnapshotFamily> = { ...PATTERN_FAMILIES, ...SNAPSHOTS_V5, ...SNAPSHOTS_V6 };
export const SNAPSHOT_SETS: Record<string, string[]> = { patterns: PATTERNS, ...SNAPSHOT_SETS_V5, ...SNAPSHOT_SETS_V6 };
export const setOf = (table: string): string | null => Object.entries(SNAPSHOT_SETS).find(([, ts]) => ts.includes(table))?.[0] ?? null;
export const snapshotSchemaSha = (table: string) => sha256(SNAPSHOTS[table]!.ddl);
/** The cut identity: fixed tuple of set, source, as_of (normalized ISO) and every member's DDL hash in set order. */
export const cutIdOf = (set: string, sourceSha256: string, asOf: string) =>
	sha256(JSON.stringify(["corpus-snapshot/1:cut", set, sourceSha256, new Date(asOf).toISOString(), SNAPSHOT_SETS[set]!.map(snapshotSchemaSha)]));
/** A single-value key (rowid) keeps its plain form, so v4 receipt ids are unchanged; a composite key is hashed as requestIdOf hashes it. */
export const snapshotRequestId = (cutId: string, table: string, first: Key | null) =>
	`corpus:snapshot:${cutId}:${table}:${first === null ? "end" : first.length === 1 ? String(first[0]) : `k${sha256(JSON.stringify(first)).slice(0, 32)}`}`;
/** A family's paging, replay and stage-continuation key. */
export const keyOf = (table: string) => SNAPSHOTS[table]!.key ?? ["rowid"];
const q = (c: string) => (c === "rowid" ? c : `"${c}"`);
/** A table's stage: the original DDL under `corpus_stage_<table>`, so staged rows keep the exact column set and types. */
export const stageName = (table: string) => `corpus_stage_${table}`;
// Only the leading name changes, so the stage keeps the exact columns, types and any WITHOUT ROWID key (migration 4 output unchanged).
const stageOf = (table: string, ddl: string) => ddl.replace(new RegExp(`^CREATE TABLE ${table}\\b`), `CREATE TABLE ${stageName(table)}`);
const stageDdl = (table: string) => stageOf(table, SNAPSHOTS[table]!.ddl);

/** What the uploader needs per snapshot family (status `snapshot_families`): projection, paging key, hash and set. */
export const snapshotManifest = () => Object.entries(SNAPSHOTS).map(([table, f]) => ({ table, schema_sha256: snapshotSchemaSha(table), columns: Object.keys(f.columns), key: keyOf(table), set: setOf(table)! }));

/**
 * Migration 4 (store.ts CORPUS_MIGRATIONS): the live tables under their exact DDL, one stage per table, and the cut ledger.
 * `tables` holds {table: {schema_sha256, rows, sum, final}} per cut; state moves loading → published → superseded, or loading → abandoned.
 */
export const SNAPSHOT_MIGRATION: string[] = [
	...PATTERNS.flatMap((t) => [SNAPSHOTS[t]!.ddl, stageDdl(t)]),
	`CREATE TABLE corpus_snapshots (set_name TEXT NOT NULL, cut_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, as_of TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('loading', 'published', 'superseded', 'abandoned')), tables TEXT NOT NULL, begun_at TEXT NOT NULL,
		published_at TEXT, PRIMARY KEY (set_name, cut_id)) WITHOUT ROWID`,
	"CREATE UNIQUE INDEX corpus_snapshots_one_published ON corpus_snapshots(set_name) WHERE state = 'published'",
	"CREATE UNIQUE INDEX corpus_snapshots_one_loading ON corpus_snapshots(set_name) WHERE state = 'loading'",
];

/** Migration 5 (store.ts CORPUS_MIGRATIONS): each live table with its original indexes, then its stage (no indexes); the cut ledger already exists. */
export const SNAPSHOT_MIGRATION_5: string[] = Object.entries(SNAPSHOTS_V5).flatMap(([t, f]) => [f.ddl, ...(f.indexes ?? []), stageOf(t, f.ddl)]);

export const SNAPSHOT_MIGRATION_6: string[] = Object.entries(SNAPSHOTS_V6).flatMap(([t, f]) => [f.ddl, stageOf(t, f.ddl)]);

/**
 * The work guard terms a checked snapshot chunk introduces (the chunkTerms rule): each repo column value as a project, each person
 * column value and each string element of a person JSON array as a person. Invalid person JSON refuses the row; redacted names add none.
 */
export function snapshotTerms(f: SnapshotFamily, rows: Value[][]): string[] {
	const cols = Object.keys(f.columns);
	const at = (names: string[]) => rows.flatMap((r) => names.map((n) => r[cols.indexOf(n)]));
	const clean = (vs: unknown[]) => [...new Set(vs.filter((v): v is string => typeof v === "string" && v !== "" && !v.includes(REDACTED)))];
	const listed = at(f.peopleJson).flatMap((v) => {
		if (v === null) return [];
		try {
			const names: unknown = typeof v === "string" ? JSON.parse(v) : null;
			if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names;
		} catch { /* malformed JSON is refused below */ }
		throw Fail.of("validation", "snapshot people_json must be a JSON array of strings", { reason: "people_json" });
	});
	return knowledgeTerms([...clean(at(f.repos)).map((name) => ({ kind: "project", name, key: `github:${name}` })), ...clean([...at(f.people), ...listed]).map((name) => ({ kind: "person", name }))]);
}

// ---------- consumers: chunk checks, stage, ledger, publication, status (migration 4) ----------

const bad = (reason: string, message: string, details: Record<string, unknown> = {}) => Fail.of("validation", message, { reason, ...details });
export const isSnapshot = (table: string) => Object.hasOwn(SNAPSHOTS, table);
/** checkRow's view of a snapshot family: its projection, keyed by rowid; one object per table, so chunkTerms can tell it apart. */
const ADAPTED = new Map(Object.entries(SNAPSHOTS).map(([t, f]) => [t, { ddl: f.ddl, indexes: [], columns: f.columns, key: keyOf(t), omit: f.omit, repo: "", people: f.people } as Family]));
export const snapshotFamily = (table: string) => ADAPTED.get(table)!;
export const snapshotTableOf = (f: Family) => [...ADAPTED].find(([, v]) => v === f)?.[0] ?? null;

/**
 * Every stateless check of a snapshot chunk, before HELD and before guard terms: DDL hash, exact projection, row budget, each row's
 * checkRow privacy, person JSON (snapshotTerms, fail closed) and strictly increasing rowids after `after`.
 */
export function checkSnapshotChunk(c: { table: string; schema_sha256: string; columns: string[]; after: Key | null; rows: unknown[]; final: boolean }): { f: Family; rows: Value[][]; keys: Key[] } {
	const f = snapshotFamily(c.table);
	if (c.schema_sha256 !== snapshotSchemaSha(c.table)) throw bad("schema_mismatch", "the source DDL of this table is not the retained original");
	if (JSON.stringify(c.columns) !== JSON.stringify(Object.keys(f.columns))) throw bad("columns", `columns must be exactly ${Object.keys(f.columns).join(", ")}`);
	if (c.rows.length > CHUNK_ROWS) throw Fail.of("size_budget", `a chunk holds at most ${CHUNK_ROWS} rows`, { reason: "chunk_rows" });
	if (!c.rows.length && !c.final) throw bad("empty_chunk", "only the final chunk may be empty");
	const key = keyOf(c.table), cols = Object.keys(f.columns);
	if (c.after !== null && (c.after.length !== key.length || c.after.some((v, i) => (key[i] === "rowid" ? !Number.isSafeInteger(v) : typeof v !== "string"))))
		throw bad("after", `a snapshot cursor is [${key.join(", ")}]`);
	const rows = c.rows.map((r, i) => checkRow(f, r, i));
	const keys = rows.map((r) => key.map((k) => r[cols.indexOf(k)]!) as Key);
	// SQLite BINARY order over the whole key (integers numerically, text by UTF-8 bytes), strictly increasing.
	keys.forEach((k, i) => { const prev = i ? keys[i - 1]! : c.after; if (prev && compareKeys(k, prev) <= 0) throw bad("order", `rows must be in strictly increasing ${key.join(", ")} order after \`after\``); });
	snapshotTerms(SNAPSHOTS[c.table]!, rows);
	return { f, rows, keys };
}

type TableState = { schema_sha256: string; rows: number; last: Key | null; final: boolean };
interface Cut { set_name: string; cut_id: string; source_sha256: string; as_of: string; state: string; tables: Record<string, TableState>; begun_at: string; published_at: string | null }
const cuts = (sql: SqlStorage, where: string, ...args: SqlStorageValue[]): Cut[] =>
	sql.exec<Omit<Cut, "tables"> & { tables: string }>(`SELECT set_name, cut_id, source_sha256, as_of, state, tables, begun_at, published_at FROM corpus_snapshots WHERE ${where}`, ...args).toArray()
		.map((r) => ({ ...r, tables: JSON.parse(r.tables) as Record<string, TableState> }));
const requestPrefix = (cutId: string) => `corpus:snapshot:${cutId}:`;

/** Abandonment, always atomic in the caller's transaction: the set's stage rows and the cut's request receipts go, the ledger row stays. */
function abandon(sql: SqlStorage, set: string, cutId: string) {
	for (const t of SNAPSHOT_SETS[set]!) sql.exec(`DELETE FROM ${stageName(t)}`);
	const prefix = requestPrefix(cutId);
	sql.exec("DELETE FROM corpus_requests WHERE substr(request_id, 1, ?) = ?", prefix.length, prefix);
	sql.exec("UPDATE corpus_snapshots SET state = 'abandoned' WHERE set_name = ? AND cut_id = ?", set, cutId);
}
/** A restore reopens with no stage rows (they are never exported): every loading cut it brought back is abandoned first. */
export function abandonLoadingCuts(sql: SqlStorage) {
	for (const c of cuts(sql, "state = 'loading'")) abandon(sql, c.set_name, c.cut_id);
}

export interface SnapshotReceipt { status: "stored" | "replayed"; request_id: string; table: string; rows: number; last_key: Key | null; complete: boolean; sha256: string; rows_written?: number;
	snapshot: { set: string; cut_id: string; state: string } }

/**
 * One snapshot chunk inside the store's transaction (the contract above): replay first, then budget, stale and cut checks, abandoning
 * another loading cut, appending to the stage at its max rowid, and publishing the whole set when its last member is final.
 */
export function applySnapshotChunk(sql: SqlStorage, c: { table: string; schema_sha256: string; source: { file_sha256: string }; as_of: string; columns: string[]; after: Key | null; rows: Value[][]; final: boolean; sha256: string },
	overBudget: () => boolean): SnapshotReceipt {
	const { rows, keys } = checkSnapshotChunk(c);
	const hash = chunkHash(c);
	if (hash !== c.sha256) throw bad("hash_mismatch", "the chunk does not match its sha256");
	const set = setOf(c.table)!, asOf = new Date(c.as_of).toISOString(), cutId = cutIdOf(set, c.source.file_sha256, asOf);
	const requestId = snapshotRequestId(cutId, c.table, keys[0] ?? null);
	const stateOf = () => cuts(sql, "set_name = ? AND cut_id = ?", set, cutId)[0]?.state ?? "unknown";
	const prior = sql.exec<{ sha256: string; rows: number; last_key: string | null; complete: number }>("SELECT sha256, rows, last_key, complete FROM corpus_requests WHERE request_id = ?", requestId).toArray()[0];
	if (prior) {
		if (prior.sha256 !== hash) throw Fail.of("idempotency_mismatch", "this request id was stored with different rows", { reason: "idempotency_mismatch", request_id: requestId });
		return { status: "replayed", request_id: requestId, table: c.table, rows: prior.rows, last_key: prior.last_key === null ? null : JSON.parse(prior.last_key) as Key, complete: prior.complete === 1, sha256: hash,
			snapshot: { set, cut_id: cutId, state: stateOf() } };
	}
	if (overBudget()) throw Fail.of("size_budget", "this corpus is over 90% of its object limit", { reason: "size_budget" });
	const published = cuts(sql, "set_name = ? AND state = 'published'", set)[0], loading = cuts(sql, "set_name = ? AND state = 'loading'", set)[0];
	if (published?.cut_id === cutId) throw bad("snapshot_published", "this cut is already published; only its stored chunks replay");
	if (published && asOf <= published.as_of) throw bad("stale_snapshot", "a snapshot cut must be newer than the published one", { published_as_of: published.as_of });
	let written = 0;
	const run = (q: string, ...p: SqlStorageValue[]) => { const cur = sql.exec(q, ...p); cur.toArray(); written += cur.rowsWritten; };
	if (loading && loading.cut_id !== cutId) abandon(sql, set, loading.cut_id);
	const now = new Date().toISOString();
	const existing = cuts(sql, "set_name = ? AND cut_id = ?", set, cutId)[0];
	if (!existing) run("INSERT INTO corpus_snapshots (set_name, cut_id, source_sha256, as_of, state, tables, begun_at) VALUES (?, ?, ?, ?, 'loading', '{}', ?)", set, cutId, c.source.file_sha256, asOf, now);
	else if (existing.state === "abandoned") run("UPDATE corpus_snapshots SET state = 'loading', tables = '{}', begun_at = ?, published_at = NULL WHERE set_name = ? AND cut_id = ?", now, set, cutId);
	else if (existing.state !== "loading") throw bad("stale_snapshot", `this cut is ${existing.state}`);
	const tables = existing?.state === "loading" ? existing.tables : {};
	const entry: TableState = tables[c.table] ?? { schema_sha256: snapshotSchemaSha(c.table), rows: 0, last: null, final: false };
	if (entry.final) throw bad("table_complete", "this table's part of the cut is complete");
	const stage = stageName(c.table), cols = Object.keys(SNAPSHOTS[c.table]!.columns), key = keyOf(c.table);
	const top = sql.exec(`SELECT ${key.map(q).join(", ")} FROM ${stage} ORDER BY ${key.map((k) => `${q(k)} DESC`).join(", ")} LIMIT 1`).raw().next();
	const expected = top.done ? null : (top.value as Value[]);
	if (JSON.stringify(c.after) !== JSON.stringify(expected)) throw bad("out_of_order", "chunks load in order; resume after the stage's greatest key", { expected_after: expected });
	// A rowid family's projection leads with rowid, so every row keeps its source rowid explicitly; a keyed family keeps its key columns.
	for (const r of rows) run(`INSERT INTO ${stage} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...r);
	Object.assign(entry, { rows: entry.rows + rows.length, last: keys.at(-1) ?? entry.last, final: c.final });
	tables[c.table] = entry;
	run("UPDATE corpus_snapshots SET tables = ? WHERE set_name = ? AND cut_id = ?", JSON.stringify(tables), set, cutId);
	const last = entry.last === null ? null : JSON.stringify(entry.last);
	run("INSERT INTO corpus_requests (request_id, table_name, sha256, rows, last_key, complete, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)", requestId, c.table, hash, rows.length, last, c.final ? 1 : 0, now);
	let state = "loading";
	if (SNAPSHOT_SETS[set]!.every((t) => tables[t]?.final)) { publish(run, set, cutId, c.source.file_sha256, asOf, tables, now); state = "published"; }
	return { status: "stored", request_id: requestId, table: c.table, rows: rows.length, last_key: entry.last, complete: c.final, sha256: hash, rows_written: written, snapshot: { set, cut_id: cutId, state } };
}

/** One transaction: every member's live rows become its stage rows (rowids kept), the old cut is superseded before the new one publishes. */
function publish(run: (q: string, ...p: SqlStorageValue[]) => void, set: string, cutId: string, source: string, asOf: string, tables: Record<string, TableState>, now: string) {
	for (const t of SNAPSHOT_SETS[set]!) {
		const cols = Object.keys(SNAPSHOTS[t]!.columns).map(q).join(", ");
		run(`DELETE FROM ${t}`);
		run(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM ${stageName(t)} ORDER BY ${keyOf(t).map(q).join(", ")}`);
		run(`DELETE FROM ${stageName(t)}`);
	}
	run("UPDATE corpus_snapshots SET state = 'superseded' WHERE set_name = ? AND state = 'published'", set);
	run("UPDATE corpus_snapshots SET state = 'published', published_at = ? WHERE set_name = ? AND cut_id = ?", now, set, cutId);
	for (const t of SNAPSHOT_SETS[set]!) {
		const e = tables[t]!;
		run(`INSERT INTO corpus_meta (table_name, source, as_of, refresh, schema_sha256, rows, last_key, complete, updated_at) VALUES (?, ?, ?, 'snapshot', ?, ?, ?, 1, ?)
			ON CONFLICT (table_name) DO UPDATE SET source = excluded.source, as_of = excluded.as_of, refresh = excluded.refresh, schema_sha256 = excluded.schema_sha256,
			rows = excluded.rows, last_key = excluded.last_key, complete = 1, updated_at = excluded.updated_at`,
			t, JSON.stringify({ file_sha256: source }), asOf, snapshotSchemaSha(t), e.rows, e.last === null ? null : JSON.stringify(e.last), now);
	}
}

/** Status `snapshots`: each set's published and loading cut, with per-table rows, last rowid and finality. */
export function snapshotStatus(sql: SqlStorage) {
	const view = (c: Cut | undefined) => (c ? { cut_id: c.cut_id, source_sha256: c.source_sha256, as_of: c.as_of, tables: c.tables, begun_at: c.begun_at, published_at: c.published_at } : null);
	return Object.fromEntries(Object.keys(SNAPSHOT_SETS).map((set) => [set, {
		published: view(cuts(sql, "set_name = ? AND state = 'published'", set)[0]), loading: view(cuts(sql, "set_name = ? AND state = 'loading'", set)[0]) }]));
}
