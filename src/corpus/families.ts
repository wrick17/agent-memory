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
type Column = "text" | "integer";
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
const SCANS = "hold: checkout scans; (repo, path) replacement refresh and per-repo analysis_head markers are undecided";
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
	...group(SCANS, ["source_files", "architecture_repos", "api_endpoints", "api_callers", "api_endpoint_matches", "packages", "package_edges", "external_system_edges", "env_refs",
		"architecture_workflows", "frontend_repositories", "frontend_snapshots", "frontend_files", "frontend_evidence", "mf_exposes", "cross_mfe_imports", "frontend_api_endpoints",
		"frontend_routes", "frontend_domain_modules", "frontend_dependencies", "frontend_branch_refs", "frontend_branch_deltas", "frontend_branch_comparisons"]),
	...group(JUDGMENT, ["validated_contracts", "frontend_business_facts", "frontend_workflows", "frontend_relationships", "frontend_uncertainties", "pattern_findings", "pattern_finding_repos",
		"ownership", "predecessor_links", "journey_edges"]),
	...group(PATTERNS, ["pattern_coordinated_changes", "pattern_coordinated_change_repos", "pattern_synchronized_migrations", "pattern_migration_commits", "pattern_release_batches",
		"pattern_release_batch_repos", "pattern_bus_factor", "pattern_revert_stats", "pattern_cherry_pick_edges", "pattern_lineage_edges", "pattern_release_actor_yearly",
		"pattern_branch_strategy_yearly", "pattern_current_repo_policies", "pattern_workflow_dependencies", "pattern_delivery_clusters"]),
};

export const CHUNK_ROWS = 5000;
export const schemaSha = (f: Family) => sha256(f.ddl);
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
		if (type === "integer" ? !Number.isSafeInteger(v) || (name === "rowid" && (v as number) < 1) : typeof v !== "string") throw Fail.of("validation", `row ${i}: ${name} must be ${type === "integer" ? "an integer" : "text"}`, { reason: "row_type" });
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
