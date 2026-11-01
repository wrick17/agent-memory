// The corpus families a CorpusStore accepts (section 14) and the hold list for every other table of the retained source.
// Evidence: the retained-schema inventory corpus-schema.json (4575c22a…) and its privacy-lineage follow-up (12121454…),
// summarized in docs/corpus-implementation.md. A table loads only under its exact original DDL, through the projection below.
import { knowledgeTerms } from "../domain/guard";
import { sha256 } from "../domain/ids";
import { EMAIL, PHONE } from "../domain/personal";
import { REDACTED, redactText } from "../domain/redact";
import { Fail } from "../domain/types";

export type Value = string | number | null;
export type Key = Value[];
type Column = "text" | "integer" | "real";
export interface SearchDoc { evidence_id: string; kind: string; key: string; repo: string; date: string; title: string; detail: string }
export interface Family {
	/** The source's CREATE TABLE text, byte for byte; schema_sha256 is its SHA-256. */
	ddl: string;
	/** Original indexes kept; commits_author is left out because its column is never uploaded. */
	indexes: string[];
	/** Upload projection in order. Rowid tables lead with `rowid`, so the source row identity survives. */
	columns: Record<string, Column>;
	/** The stable paging key: the WITHOUT ROWID primary key in order, or ["rowid"]. */
	key: string[];
	/** Original columns never uploaded (stored NULL), with the rule that drops them. */
	omit: Record<string, string>;
	/** The columns naming the work repo and the people a row introduces; their values become me guard terms in `work`. */
	repo: string;
	people: string[];
	/** The rebuilt search document of a row, from its own approved columns only. */
	search?: (r: Record<string, Value>) => SearchDoc | null;
}

const CONTACT = "contact field: emails never upload (personal-field rule, section 4)";
const s = (v: Value | undefined) => (v === null || v === undefined ? "" : String(v));

export const FAMILIES: Record<string, Family> = {
	repos: {
		ddl: `CREATE TABLE repos (
    full_name TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, archived INTEGER NOT NULL, private INTEGER NOT NULL,
    language TEXT, default_branch TEXT, updated_at TEXT, url TEXT,
    commit_count INTEGER NOT NULL, ref_count INTEGER NOT NULL,
    head_sha TEXT, earliest_date TEXT, latest_date TEXT, empty INTEGER NOT NULL
  )`,
		indexes: [],
		columns: { rowid: "integer", full_name: "text", owner: "text", name: "text", description: "text", archived: "integer", private: "integer", language: "text",
			default_branch: "text", updated_at: "text", url: "text", commit_count: "integer", ref_count: "integer", head_sha: "text", earliest_date: "text", latest_date: "text", empty: "integer" },
		key: ["rowid"],
		omit: {},
		repo: "full_name",
		people: [],
		search: (r) => (r.full_name == null ? null : { evidence_id: `repo:repos:${s(r.full_name)}`, kind: "repo", key: s(r.full_name), repo: s(r.full_name), date: s(r.updated_at), title: s(r.full_name), detail: s(r.description) }),
	},
	commits: {
		ddl: `CREATE TABLE commits (
    repo TEXT NOT NULL, sha TEXT NOT NULL, parents TEXT NOT NULL,
    author_name TEXT, author_email TEXT, author_date TEXT,
    committer_name TEXT, committer_email TEXT, committer_date TEXT,
    subject TEXT, message TEXT, is_merge INTEGER NOT NULL,
    is_revert INTEGER NOT NULL, pr_number INTEGER, cherry_pick_source TEXT,
    PRIMARY KEY (repo, sha)
  ) WITHOUT ROWID`,
		indexes: ["CREATE INDEX commits_dates ON commits(committer_date)", "CREATE INDEX commits_sha_global ON commits(sha)"],
		columns: { repo: "text", sha: "text", parents: "text", author_name: "text", author_date: "text", committer_name: "text", committer_date: "text", subject: "text",
			message: "text", is_merge: "integer", is_revert: "integer", pr_number: "integer", cherry_pick_source: "text" },
		key: ["repo", "sha"],
		omit: { author_email: CONTACT, committer_email: CONTACT },
		repo: "repo",
		people: ["author_name", "committer_name"],
		// The legacy evidence id and key encoding (privacy-lineage); title subject and detail message matched its 64 samples.
		search: (r) => ({ evidence_id: `commit:commits:${s(r.repo)}@${s(r.sha)}`, kind: "commit", key: `${s(r.repo)}@${s(r.sha)}`, repo: s(r.repo), date: s(r.author_date), title: s(r.subject), detail: s(r.message) }),
	},
	refs: {
		ddl: `CREATE TABLE refs (
    repo TEXT NOT NULL, refname TEXT NOT NULL, namespace TEXT NOT NULL,
    short_name TEXT NOT NULL, target_sha TEXT, object_type TEXT,
    creator_date TEXT, author_name TEXT, author_email TEXT, subject TEXT,
    PRIMARY KEY (repo, refname)
  ) WITHOUT ROWID`,
		indexes: ["CREATE INDEX refs_target ON refs(repo, target_sha)"],
		columns: { repo: "text", refname: "text", namespace: "text", short_name: "text", target_sha: "text", object_type: "text", creator_date: "text", author_name: "text", subject: "text" },
		key: ["repo", "refname"],
		omit: { author_email: CONTACT },
		repo: "repo",
		people: ["author_name"],
		search: (r) => ({ evidence_id: `ref:refs:${s(r.repo)}:${s(r.refname)}`, kind: "ref", key: `${s(r.repo)}:${s(r.refname)}`, repo: s(r.repo), date: s(r.creator_date), title: s(r.short_name), detail: s(r.subject) }),
	},
	commit_paths: {
		ddl: `CREATE TABLE commit_paths (
    repo TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
    top_component TEXT NOT NULL, extension TEXT NOT NULL,
    PRIMARY KEY (repo, sha, path)
  ) WITHOUT ROWID`,
		indexes: ["CREATE INDEX paths_path ON commit_paths(path)", "CREATE INDEX paths_top ON commit_paths(repo, top_component)"],
		columns: { repo: "text", sha: "text", path: "text", top_component: "text", extension: "text" },
		key: ["repo", "sha", "path"],
		omit: {},
		repo: "repo",
		people: [],
		// One document per (repo, path), as the legacy index had; later commits of the same path keep the first document.
		search: (r) => ({ evidence_id: `path:commit_paths:${s(r.repo)}:${s(r.path)}`, kind: "path", key: `${s(r.repo)}:${s(r.path)}`, repo: s(r.repo), date: "", title: s(r.path), detail: s(r.top_component) }),
	},
	contributors: {
		ddl: `CREATE TABLE contributors(
  repo TEXT,
  rank INT,
  commits INT,
  name TEXT,
  email TEXT
)`,
		indexes: [],
		columns: { rowid: "integer", repo: "text", rank: "integer", commits: "integer", name: "text" },
		key: ["rowid"],
		omit: { email: CONTACT },
		repo: "repo",
		people: ["name"],
	},
};

const ID = "builder row id: no loaded table refers to it; derived views use rowid";
const PATH = "local filesystem path of the scanned checkout (personal-field rule)";
/** A checkout-scan family: exact original DDL, no bulk load, rows partitioned by `repo` (repo full name; for snapshot tables the snapshot id equals it). */
const scan = (ddl: string, repo: string, columns: Record<string, Column>, omit: Record<string, string> = {}, indexes: string[] = []): Family =>
	({ ddl, indexes: [...indexes, `CREATE INDEX corpus_part_${/TABLE (\w+)/.exec(ddl)![1]} ON ${/TABLE (\w+)/.exec(ddl)![1]}(${repo})`], columns, key: [], omit, repo, people: [] });

/**
 * The checkout-scan group (section 14 "Incremental updates", phase 6 scanners): refreshed per repo from a local checkout's HEAD by
 * the `scans` refresh group, never bulk loaded, so a Git-history client never touches them. Every row is an unkeyed occurrence:
 * a refresh deletes the rows whose hash left and inserts the new ones, so changed or deleted paths replace their prior rows.
 */
export const SCANS: Record<string, Family> = {
	source_files: scan("CREATE TABLE source_files(\n  repo TEXT,\n  path TEXT,\n  blob_sha TEXT,\n  size INT,\n  scanned INT,\n  skip_reason TEXT\n)", "repo", { repo: "text", path: "text", blob_sha: "text", size: "integer", scanned: "integer", skip_reason: "text" }),
	architecture_repos: scan("CREATE TABLE architecture_repos(\n  repo TEXT,\n  name TEXT,\n  category TEXT,\n  archived INT,\n  language TEXT,\n  default_branch TEXT,\n  head_sha TEXT,\n  latest_date TEXT,\n  history_commits INT,\n  history_refs INT,\n  current_files INT,\n  scanned_files INT,\n  scanned_bytes INT,\n  domains TEXT\n)", "repo", { repo: "text", name: "text", category: "text", archived: "integer", language: "text", default_branch: "text", head_sha: "text", latest_date: "text", history_commits: "integer", history_refs: "integer", current_files: "integer", scanned_files: "integer", scanned_bytes: "integer", domains: "text" }),
	api_endpoints: scan("CREATE TABLE api_endpoints(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  line INT,\n  method TEXT,\n  route TEXT,\n  normalized_route TEXT,\n  kind TEXT,\n  security_signals TEXT\n)", "repo", { repo: "text", sha: "text", path: "text", line: "integer", method: "text", route: "text", normalized_route: "text", kind: "text", security_signals: "text" }, { id: ID }, ["CREATE INDEX api_endpoints_repo ON api_endpoints(repo)"]),
	api_callers: scan("CREATE TABLE api_callers(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  category TEXT,\n  path TEXT,\n  line INT,\n  target TEXT,\n  normalized_target TEXT,\n  base_env_refs TEXT\n)", "repo", { repo: "text", sha: "text", category: "text", path: "text", line: "integer", target: "text", normalized_target: "text", base_env_refs: "text" }, { id: ID }, ["CREATE INDEX api_callers_repo ON api_callers(repo)"]),
	packages: scan("CREATE TABLE packages(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  role TEXT,\n  package TEXT,\n  version TEXT,\n  scope TEXT\n)", "repo", { repo: "text", sha: "text", path: "text", role: "text", package: "text", version: "text", scope: "text" }, { id: ID }),
	external_system_edges: scan("CREATE TABLE external_system_edges(\n  repo TEXT,\n  system TEXT,\n  system_type TEXT,\n  evidence_path TEXT,\n  evidence_line INT,\n  confidence TEXT\n)", "repo", { repo: "text", system: "text", system_type: "text", evidence_path: "text", evidence_line: "integer", confidence: "text" }),
	env_refs: scan("CREATE TABLE env_refs(\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  line INT,\n  name TEXT,\n  secret_reference INT\n)", "repo", { repo: "text", sha: "text", path: "text", line: "integer", name: "text", secret_reference: "integer" }),
	architecture_workflows: scan("CREATE TABLE architecture_workflows(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  triggers TEXT,\n  environments TEXT,\n  deploy_targets TEXT,\n  secret_refs TEXT\n)", "repo", { repo: "text", sha: "text", path: "text", triggers: "text", environments: "text", deploy_targets: "text", secret_refs: "text" }, { id: ID }),
	frontend_repositories: scan("CREATE TABLE frontend_repositories(\n  repo_key TEXT,\n  full_name TEXT,\n  org TEXT,\n  name TEXT,\n  category TEXT\n)", "repo_key", { repo_key: "text", full_name: "text", org: "text", name: "text", category: "text" }),
	frontend_snapshots: scan("CREATE TABLE frontend_snapshots(\n  snapshot_id TEXT,\n  repo_key TEXT,\n  role TEXT,\n  branch TEXT,\n  sha TEXT,\n  commit_date TEXT,\n  subject TEXT,\n  root_path TEXT,\n  dirty INT\n)", "repo_key", { snapshot_id: "text", repo_key: "text", role: "text", branch: "text", sha: "text", commit_date: "text", subject: "text", dirty: "integer" }, { root_path: PATH }),
	frontend_branch_refs: scan("CREATE TABLE frontend_branch_refs(\n  repo_key TEXT,\n  ref_name TEXT,\n  sha TEXT,\n  commit_date TEXT,\n  subject TEXT,\n  is_workspace_head INT,\n  is_ancestor_of_workspace INT\n)", "repo_key", { repo_key: "text", ref_name: "text", sha: "text", commit_date: "text", subject: "text", is_workspace_head: "integer", is_ancestor_of_workspace: "integer" }),
	frontend_branch_deltas: scan("CREATE TABLE frontend_branch_deltas(\n  repo_key TEXT,\n  from_snapshot TEXT,\n  to_snapshot TEXT,\n  merge_base_sha TEXT,\n  ahead INT,\n  behind INT,\n  path TEXT,\n  status TEXT\n)", "repo_key", { repo_key: "text", from_snapshot: "text", to_snapshot: "text", merge_base_sha: "text", ahead: "integer", behind: "integer", path: "text", status: "text" }),
	frontend_branch_comparisons: scan("CREATE TABLE frontend_branch_comparisons(\n  repo_key TEXT,\n  workspace_snapshot TEXT,\n  ref_name TEXT,\n  ref_sha TEXT,\n  merge_base_sha TEXT,\n  ahead INT,\n  behind INT,\n  changed_paths INT\n)", "repo_key", { repo_key: "text", workspace_snapshot: "text", ref_name: "text", ref_sha: "text", merge_base_sha: "text", ahead: "integer", behind: "integer", changed_paths: "integer" }),
	frontend_files: scan("CREATE TABLE frontend_files(\n  snapshot_id TEXT,\n  path TEXT,\n  blob_sha TEXT,\n  size INT,\n  language TEXT,\n  is_test INT,\n  top_domain TEXT\n)", "snapshot_id", { snapshot_id: "text", path: "text", blob_sha: "text", size: "integer", language: "text", is_test: "integer", top_domain: "text" }),
	frontend_evidence: scan("CREATE TABLE frontend_evidence(\n  id INT,\n  snapshot_id TEXT,\n  category TEXT,\n  evidence_key TEXT,\n  value TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL,\n  extractor TEXT\n)", "snapshot_id", { snapshot_id: "text", category: "text", evidence_key: "text", value: "text", path: "text", line: "integer", snippet: "text", confidence: "real", extractor: "text" }, { id: ID }),
	mf_exposes: scan("CREATE TABLE mf_exposes(\n  snapshot_id TEXT,\n  expose_key TEXT,\n  target_path TEXT,\n  path TEXT,\n  line INT,\n  confidence REAL\n)", "snapshot_id", { snapshot_id: "text", expose_key: "text", target_path: "text", path: "text", line: "integer", confidence: "real" }),
	cross_mfe_imports: scan("CREATE TABLE cross_mfe_imports(\n  snapshot_id TEXT,\n  source_alias TEXT,\n  import_path TEXT,\n  path TEXT,\n  line INT,\n  confidence REAL\n)", "snapshot_id", { snapshot_id: "text", source_alias: "text", import_path: "text", path: "text", line: "integer", confidence: "real" }),
	frontend_api_endpoints: scan("CREATE TABLE frontend_api_endpoints(\n  snapshot_id TEXT,\n  endpoint TEXT,\n  method_hint TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL\n)", "snapshot_id", { snapshot_id: "text", endpoint: "text", method_hint: "text", path: "text", line: "integer", snippet: "text", confidence: "real" }),
	frontend_routes: scan("CREATE TABLE frontend_routes(\n  snapshot_id TEXT,\n  route_value TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL\n)", "snapshot_id", { snapshot_id: "text", route_value: "text", path: "text", line: "integer", snippet: "text", confidence: "real" }),
	frontend_domain_modules: scan("CREATE TABLE frontend_domain_modules(\n  snapshot_id TEXT,\n  kind TEXT,\n  name TEXT,\n  path TEXT,\n  file_count INT,\n  test_count INT\n)", "snapshot_id", { snapshot_id: "text", kind: "text", name: "text", path: "text", file_count: "integer", test_count: "integer" }),
	frontend_dependencies: scan("CREATE TABLE frontend_dependencies(\n  snapshot_id TEXT,\n  name TEXT,\n  version TEXT,\n  kind TEXT,\n  path TEXT,\n  line INT\n)", "snapshot_id", { snapshot_id: "text", name: "text", version: "text", kind: "text", path: "text", line: "integer" }),
};
export const SCAN_ORDER = Object.keys(SCANS);
/** What the scan client needs per family; the bulk manifest never lists these. */
export const scanManifest = () => Object.entries(SCANS).map(([table, f]) => ({ table, schema_sha256: schemaSha(f), columns: Object.keys(f.columns), key: ["rowid"], repo: f.repo }));

/** Read-time views (migration 3) under original table names: derived from loaded rows only, so they carry those rows' as_of. */
export const VIEWS: Record<string, string> = {
	package_edges: `CREATE VIEW package_edges AS SELECT DISTINCT c.repo AS consumer_repo, p.repo AS provider_repo, c.package AS package, 'declared_name' AS confidence, c.path AS evidence_path
		FROM packages c JOIN packages p ON p.package = c.package AND p.role = 'package' AND p.repo <> c.repo WHERE c.role = 'dependency'`,
	api_endpoint_matches: `CREATE VIEW api_endpoint_matches AS SELECT c.rowid AS caller_id, e.rowid AS endpoint_id, c.repo AS consumer_repo, e.repo AS provider_repo,
		'exact_normalized_route' AS confidence, 'api_callers.normalized_target = api_endpoints.normalized_route' AS basis
		FROM api_callers c JOIN api_endpoints e ON e.normalized_route = c.normalized_target AND e.repo <> c.repo WHERE c.normalized_target IS NOT NULL`,
	pattern_revert_stats: `CREATE VIEW pattern_revert_stats AS SELECT repo, sum(is_revert) AS reverts, count(*) AS total_commits, round(100.0 * sum(is_revert) / count(*), 2) AS revert_pct,
		min(CASE WHEN is_revert = 1 THEN committer_date END) AS first_at, max(CASE WHEN is_revert = 1 THEN committer_date END) AS last_at FROM commits GROUP BY repo`,
	pattern_bus_factor: `CREATE VIEW pattern_bus_factor AS WITH a AS (SELECT repo, author_name, count(*) AS n FROM commits WHERE is_merge = 0 AND author_name IS NOT NULL GROUP BY repo, author_name),
		r AS (SELECT repo, author_name, n, row_number() OVER (PARTITION BY repo ORDER BY n DESC, author_name) AS k, sum(n) OVER (PARTITION BY repo) AS total FROM a),
		w AS (SELECT repo, min(committer_date) AS s, max(committer_date) AS e, count(*) AS nm FROM commits WHERE is_merge = 0 GROUP BY repo)
		SELECT w.repo AS repo, w.s AS window_start, w.e AS window_end, w.nm AS non_merge_commits, NULL AS exact_email_authors, t.author_name AS top_author_name,
		NULL AS top_author_email, t.n AS top_author_commits, round(100.0 * t.n / t.total, 2) AS top1_pct,
		round(100.0 * (SELECT sum(n) FROM r r3 WHERE r3.repo = w.repo AND r3.k <= 3) / t.total, 2) AS top3_pct, 'author names; emails are never stored' AS identity_caveat
		FROM w LEFT JOIN r t ON t.repo = w.repo AND t.k = 1`,
	pattern_cherry_pick_edges: `CREATE VIEW pattern_cherry_pick_edges AS SELECT s.repo AS source_repo, t.repo AS target_repo, count(*) AS transfers, min(s.committer_date) AS first_source_at,
		max(t.committer_date) AS last_target_at FROM commits t JOIN commits s ON s.sha = t.cherry_pick_source WHERE t.cherry_pick_source IS NOT NULL GROUP BY s.repo, t.repo`,
};

/** The search index keeps the source's original schema; its rows are rebuilt here from approved families, never uploaded. */
export const SEARCH_DDL = [
	`CREATE TABLE corpus_search_documents(
            evidence_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,key TEXT NOT NULL,repo TEXT NOT NULL,
            date TEXT NOT NULL,title TEXT NOT NULL,detail TEXT NOT NULL)`,
	`CREATE VIRTUAL TABLE corpus_search_fts USING fts5(
            key,repo,title,detail,content='',tokenize='unicode61 remove_diacritics 2')`,
];

export const FORBIDDEN = ["session_messages", "session_decisions", "user_directives"] as const;
const NEVER = "never_import: raw session text; the uploader refuses it under any name (section 14)";
const DERIVED = "session_derived: proved copies of forbidden text or index ids (privacy-lineage); search is rebuilt server-side from approved families";
const SESSION = "hold: session lineage; only some columns are proved metadata-only, no row projection is cleared";
const BUILDER = "hold: builder metadata with temporary source paths; per-table as_of and source travel with each chunk instead";
const DELIVERY = "hold: next family; PR, release and tag text and actor fields are not yet checked against the research";
const TICKETS = "hold: Jira snapshot; ticket text projection unproved and the refresh of touched tickets is undecided";
const HISTORY = "hold: derived history tables not yet classified; keys and privacy unchecked";
const SCAN_ONLY = "scan: loads only through a checkout refresh (group scans), never from a bulk file";
const DERIVED_VIEW = "view: derived at read time from loaded rows; nothing loads under this name";
const JUDGMENT = "hold: curated judgment text; dated-snapshot semantics and privacy unproved";
const PATTERNS = "hold: pattern statistics; read-time views versus dated snapshots undecided";
const group = (reason: string, names: string[]) => Object.fromEntries(names.map((n) => [n, reason]));

/** Every other table of the retained source (93 ordinary tables, the FTS table and shadows, sqlite_stat1), with why it waits. */
export const HELD: Record<string, string> = {
	...group(NEVER, [...FORBIDDEN]),
	...group(DERIVED, ["corpus_search_documents", "corpus_search_fts", "corpus_search_fts_config", "corpus_search_fts_data", "corpus_search_fts_docsize", "corpus_search_fts_idx", "directive_relations"]),
	sqlite_stat1: "system: SQLite planner statistics",
	...group(SESSION, ["codex_sessions", "session_reference_index", "session_commit_links", "session_ticket_links", "pattern_session_commit_links", "pattern_session_ticket_links"]),
	...group(BUILDER, ["corpus_metadata", "corpus_search_manifest", "frontend_metadata", "pattern_metadata", "evidence_provenance", "github_api_calls", "delivery_exceptions"]),
	...group(DELIVERY, ["pull_requests", "pr_tickets", "pr_commit_links", "releases", "release_tag_groups", "github_tags", "delivery_workflows", "delivery_repo_snapshots", "delivery_repos", "delivery_clusters"]),
	...group(TICKETS, ["tickets", "ticket_episodes", "ticket_episode_commits", "ticket_repo_edges"]),
	...group(HISTORY, ["subject_episodes", "subject_episode_commits", "subject_repo_edges", "branch_families", "shared_history_edges", "author_repo_edges", "author_repos", "repo_scope"]),
	...group(SCAN_ONLY, ["source_files", "architecture_repos", "api_endpoints", "api_callers", "api_endpoint_matches", "packages", "package_edges", "external_system_edges", "env_refs",
		"architecture_workflows", "frontend_repositories", "frontend_snapshots", "frontend_files", "frontend_evidence", "mf_exposes", "cross_mfe_imports", "frontend_api_endpoints",
		"frontend_routes", "frontend_domain_modules", "frontend_dependencies", "frontend_branch_refs", "frontend_branch_deltas", "frontend_branch_comparisons"]),
	...group(JUDGMENT, ["validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties", "pattern_findings", "pattern_finding_repos",
		"ownership", "predecessor_links", "journey_edges"]),
	...group(PATTERNS, ["pattern_coordinated_changes", "pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits", "pattern_release_batches",
		"pattern_release_batch_repos", "pattern_bus_factor", "pattern_revert_stats", "pattern_cherry_pick_edges", "pattern_lineage_edges", "pattern_release_actor_yearly",
		"pattern_branch_strategy_yearly", "pattern_current_repo_policies", "pattern_workflow_dependencies", "pattern_delivery_clusters"]),
	...group(DERIVED_VIEW, Object.keys(VIEWS)),
	...group("snapshot: loads only as the complete dated delivery_patterns set", ["pattern_release_batches", "pattern_release_batch_repos", "pattern_release_actor_yearly", "pattern_branch_strategy_yearly", "pattern_current_repo_policies", "pattern_workflow_dependencies", "delivery_clusters"]),
	// Loaded only as the dated per-profile snapshot set `patterns` (snapshots.ts), which the route checks before this list.
	...group("snapshot: loads only as the dated per-profile snapshot set patterns, whole and replaced by a newer cut", ["pattern_coordinated_changes",
		"pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits", "pattern_lineage_edges", "pattern_findings", "pattern_finding_repos"]),
	...group("snapshot: loads only as a dated per-profile record snapshot set (pull_requests, releases, tickets, sessions or judgment), whole and replaced by a newer cut",
		["pull_requests", "pr_tickets", "pr_commit_links", "releases", "github_tags", "tickets", "ticket_episodes", "codex_sessions", "session_commit_links", "session_ticket_links",
			"validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties", "ownership", "predecessor_links", "journey_edges"]),
};

export const CHUNK_ROWS = 5000;
export const schemaSha = (f: Family) => sha256(f.ddl);
/** The order every refresh tuple lists the families in. */
export const FAMILY_ORDER = Object.keys(FAMILIES);
export const PROJECTION = "corpus-projection/1";
/** A family as refresh sees it: its projection without rowid, keyed by its natural key (repos by full name, contributors by none). */
export const REFRESH: Record<string, Family> = { ...SCANS, ...Object.fromEntries(Object.entries(FAMILIES).map(([t, f]) => [t, {
	...f, columns: Object.fromEntries(Object.entries(f.columns).filter(([c]) => c !== "rowid")), key: t === "repos" ? ["full_name"] : t === "contributors" ? [] : f.key,
}])) };
/** The row hash both ends compute (design section 3): table, DDL hash, projection version and the approved values without rowid. */
export const rowHash = (table: string, values: Value[]) => sha256(JSON.stringify([table, schemaSha((FAMILIES[table] ?? SCANS[table])!), PROJECTION, values]));
// A forbidden table's legacy evidence id (`session:session_messages:…`) inside an uploaded value means copied search payload.
// Only that exact form: commit text may name the tables themselves.
const LINEAGE = new RegExp(`\\b(?:session|decision|directive):(?:${FORBIDDEN.join("|")}):`, "i");
const PERSONAL = new RegExp(`${EMAIL.source}|${PHONE.source}`);

/** What the uploader manifest needs to read a family: projection, key and hash, never the DDL itself. */
export const manifest = () => Object.entries(FAMILIES).map(([table, f]) => ({ table, schema_sha256: schemaSha(f), columns: Object.keys(f.columns), key: f.key }));

/** Why a table cannot load: held with its reason, or unknown under any other spelling. */
export function refusal(table: string): string | null {
	if (Object.hasOwn(FAMILIES, table)) return null;
	if (Object.hasOwn(HELD, table)) return HELD[table]!;
	return /session|directive|decision/i.test(table) ? NEVER : "unknown_table: not a table of the retained source schema";
}

/** Positional comparison in SQLite's order: integers numerically, text by UTF-8 bytes (BINARY collation). */
export function compareKeys(a: Key, b: Key): number {
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!, y = b[i]!;
		const c = typeof x === "number" && typeof y === "number" ? x - y : Buffer.compare(Buffer.from(String(x)), Buffer.from(String(y)));
		if (c) return Math.sign(c);
	}
	return 0;
}

export const keyOf = (f: Family, row: Value[]): Key => f.key.map((k) => row[Object.keys(f.columns).indexOf(k)]!);
export const requestIdOf = (table: string, first: Key | null) => `corpus:${table}:${first === null ? "end" : first.length === 1 ? String(first[0]) : `k${sha256(JSON.stringify(first)).slice(0, 32)}`}`;

/** The chunk hash both ends compute: a fixed tuple, so field order and absent fields cannot change it. */
export const chunkHash = (c: { table: string; schema_sha256: string; source: { file_sha256: string }; as_of: string; columns: string[]; after: Key | null; rows: Value[][]; final: boolean }) =>
	sha256(JSON.stringify([c.table, c.schema_sha256, c.source.file_sha256, c.as_of, c.columns, c.after, c.rows, c.final]));

/**
 * Validates one row against the family: arity, column types, key values, and privacy. Text is checked, never rewritten: the
 * uploader redacts non-key text before hashing, and a key that would need redaction holds its row.
 */
export function checkRow(f: Family, row: unknown, i: number): Value[] {
	const cols = Object.entries(f.columns);
	if (!Array.isArray(row) || row.length !== cols.length) throw Fail.of("validation", `row ${i} must hold exactly ${cols.length} values`, { reason: "row_shape" });
	cols.forEach(([name, type], c) => {
		const v = row[c] as unknown;
		const isKey = f.key.includes(name);
		if (v === null) { if (isKey) throw Fail.of("validation", `row ${i}: key column ${name} is null`, { reason: "row_key" }); return; }
		if (type === "integer" ? !Number.isSafeInteger(v) || (name === "rowid" && (v as number) < 1) : type === "real" ? !Number.isFinite(v) : typeof v !== "string") throw Fail.of("validation", `row ${i}: ${name} must be ${type === "text" ? "text" : type === "integer" ? "an integer" : "a number"}`, { reason: "row_type" });
		if (typeof v === "string") {
			if (isKey && (v === "" || v.length > 4096)) throw Fail.of("validation", `row ${i}: key column ${name} must hold 1 to 4096 characters`, { reason: "row_key" });
			if (LINEAGE.test(v)) throw Fail.of("validation", `row ${i}: ${name} carries a forbidden source tag`, { reason: "forbidden_lineage" });
			if (redactText(v) !== v || PERSONAL.test(v)) throw Fail.of("validation", `row ${i}: ${name} holds text the redactor or the personal-field rule would change; it is refused, never rewritten`, { reason: isKey ? "row_key_private" : "needs_redaction" });
		}
	});
	return row as Value[];
}

export const named = (f: Family, row: Value[]): Record<string, Value> => Object.fromEntries(Object.keys(f.columns).map((c, i) => [c, row[i]!]));

/**
 * Every check of a chunk that needs no stored state: the family, its DDL hash and projection, the row budget, each row, and
 * strict key order after `after`. The Worker runs it before registering guard terms, and the store again in its transaction.
 */
export function checkChunk(c: { table: string; schema_sha256: string; columns: string[]; after: Key | null; rows: unknown[]; final: boolean }): { f: Family; rows: Value[][]; keys: Key[] } {
	const why = refusal(c.table);
	if (why) throw Fail.of("forbidden", `table '${c.table}' does not load: ${why}`, { reason: why.split(":")[0] });
	const f = FAMILIES[c.table]!;
	if (c.schema_sha256 !== schemaSha(f)) throw Fail.of("validation", "the source DDL of this table is not the retained original", { reason: "schema_mismatch" });
	if (JSON.stringify(c.columns) !== JSON.stringify(Object.keys(f.columns))) throw Fail.of("validation", `columns must be exactly ${Object.keys(f.columns).join(", ")}`, { reason: "columns" });
	if (c.rows.length > CHUNK_ROWS) throw Fail.of("size_budget", `a chunk holds at most ${CHUNK_ROWS} rows`, { reason: "chunk_rows" });
	if (!c.rows.length && !c.final) throw Fail.of("validation", "only the final chunk may be empty", { reason: "empty_chunk" });
	const rows = c.rows.map((r, i) => checkRow(f, r, i));
	const keys = rows.map((r) => keyOf(f, r));
	keys.forEach((k, i) => {
		const prev = i ? keys[i - 1]! : c.after;
		if (prev && compareKeys(k, prev) <= 0) throw Fail.of("validation", "rows must be in strictly increasing key order after `after`", { reason: "order" });
	});
	return { f, rows, keys };
}

/**
 * The work terms a checked chunk introduces, by the record_knowledge and upload rule (domain/guard.ts knowledgeTerms): each
 * repo as a project and each person name as a person. Only values that passed checkRow, never a contact field, and never a
 * value the uploader had to redact.
 */
export function chunkTerms(f: Family, rows: Value[][]): string[] {
	const cols = Object.keys(f.columns);
	const pick = (names: string[]) => [...new Set(rows.flatMap((r) => names.map((n) => r[cols.indexOf(n)])).filter((v): v is string => typeof v === "string" && !v.includes(REDACTED)))];
	return knowledgeTerms([...pick([f.repo]).map((name) => ({ kind: "project", name, key: `github:${name}` })), ...pick(f.people).map((name) => ({ kind: "person", name }))]);
}
