// Corpus reads (section 14): search over the rebuilt documents, exact get by key, and read-only SQL. Every answer names the
// as_of of the tables it read. The SQL runs as one wrapped SELECT inside a transaction that always rolls back.
import { Fail } from "../domain/types";
import { FAMILIES, SCANS, type Value } from "./families";
import { SNAPSHOTS } from "./snapshots";

/** A dated snapshot table's projection, quoted (some original column names are SQL keywords). */
const snapshotProjection = (table: string) => Object.keys(SNAPSHOTS[table]!.columns).map((c) => (c === "rowid" ? c : `"${c}"`)).join(", ");

export type CorpusQuery =
	| { action: "search"; query: string; limit: number }
	| { action: "get"; kind: "commit" | "repo" | "ref" | "person" | "pr" | "ticket" | "session"; key: string }
	| { action: "sql"; sql: string };

export const SQL_ROWS = 500;
/** Every corpus answer, as the tool serializes it (head included), is at most this many UTF-8 bytes. */
export const ANSWER_BYTES = 1_000_000;
const SOURCES: Record<string, string> = { commit: "commits", ref: "refs", repo: "repos", path: "commit_paths" };
const SEARCH = ["corpus_search_documents", "corpus_search_fts", "corpus_search_fts_data", "corpus_search_fts_idx", "corpus_search_fts_docsize", "corpus_search_fts_config"];

export type AsOf = Record<string, { as_of: string; as_of_max: string; basis: "declared_snapshot" | "observed" | "mixed"; refresh: string; complete: boolean; rows: number;
	source_sha256: string | null; partitions: number } | null>;
/**
 * Per table: the oldest and newest observation of the repo partitions holding rows, whether they are the declared bulk snapshot,
 * refreshed observations or a mix, and the source hash only while one source covers them all; null when nothing is loaded.
 */
export function asOf(sql: SqlStorage, tables: string[]): AsOf {
	const meta = new Map(sql.exec<{ table_name: string; source: string; as_of: string; refresh: string; complete: number; rows: number; min_at: string | null; max_at: string | null;
		parts: number | null; sources: number | null; observed: number | null; one_source: string | null }>(
		`SELECT m.table_name, m.source, m.as_of, m.refresh, m.complete, m.rows, p.min_at, p.max_at, p.parts, p.sources, p.observed, p.one_source FROM corpus_meta m
		LEFT JOIN (SELECT table_name, min(observed_at) AS min_at, max(observed_at) AS max_at, count(*) AS parts, count(DISTINCT source_id) AS sources,
			sum(basis = 'observed') AS observed, min(source_id) AS one_source FROM corpus_partitions WHERE rows > 0 GROUP BY table_name) p USING (table_name)
		WHERE m.table_name IN (SELECT value FROM json_each(?))`, JSON.stringify(tables)).toArray()
		.map((m) => [m.table_name, { as_of: m.min_at ?? m.as_of, as_of_max: m.max_at ?? m.as_of,
			basis: !m.observed ? "declared_snapshot" as const : m.observed === m.parts && m.sources === 1 ? "observed" as const : "mixed" as const,
			refresh: m.observed ? "refresh" : m.refresh, complete: m.complete === 1, rows: m.rows,
			source_sha256: m.parts ? (m.sources === 1 ? m.one_source : null) : (JSON.parse(m.source) as { file_sha256: string }).file_sha256, partitions: m.parts ?? 0 }]));
	return Object.fromEntries([...new Set(tables)].sort().map((t) => [t, meta.get(t) ?? null]));
}

/** One repo's last observation per table, zero-row partitions included, or null where it was never loaded or observed. */
const repoAsOf = (sql: SqlStorage, tables: string[], repo: string) => Object.fromEntries(tables.map((t) => [t,
	sql.exec<{ observed_at: string }>("SELECT observed_at FROM corpus_partitions WHERE table_name = ? AND part = ?", t, JSON.stringify(repo)).toArray()[0]?.observed_at ?? null]));

const projection = (table: string) => Object.keys(FAMILIES[table]!.columns).join(", ");
/** The Worker's fields of the answer (profile, routed_by, action), counted with it. */
export type Head = Record<string, string>;
const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * A running count of an answer's serialized UTF-8 bytes. It starts from the answer with every list empty and `truncated: false`,
 * so each list item adds exactly its own bytes and a comma; `fits` says whether one more whole item stays within ANSWER_BYTES.
 */
function budget(envelope: Record<string, unknown>) {
	let size = utf8({ ...envelope, truncated: false });
	if (size > ANSWER_BYTES) throw Fail.of("size_budget", "corpus answer metadata exceeds 1,000,000 bytes");
	return (item: unknown, first: boolean) => {
		const n = utf8(item) + (first ? 0 : 1);
		if (size + n > ANSWER_BYTES) return false;
		size += n;
		return true;
	};
}

/** Keeps each list's leading items while the whole answer fits; the first item that does not fit ends every later list. */
function fit<T extends Record<string, unknown>>(answer: T, lists: string[]): T & { truncated: boolean } {
	const fits = budget({ ...answer, ...Object.fromEntries(lists.map((k) => [k, []])) });
	const out: Record<string, unknown> = { ...answer };
	let truncated = false;
	for (const k of lists) {
		const kept: unknown[] = [];
		for (const item of answer[k] as unknown[]) {
			if (truncated || !fits(item, !kept.length)) { truncated = true; break; }
			kept.push(item);
		}
		out[k] = kept;
		if (k === "paths" && kept.length < (answer[k] as unknown[]).length) out.paths_truncated = true;
	}
	return { ...out, truncated } as T & { truncated: boolean };
}

export function search(sql: SqlStorage, q: { query: string; limit: number }, head: Head = {}) {
	const words = [...new Set(q.query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
	if (!words.length) throw Fail.of("validation", "the query has no searchable words");
	const match = [q.query.trim(), ...words].map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
	let results: { kind: string }[];
	try {
		results = sql.exec<{ kind: string }>(`SELECT d.evidence_id, d.kind, d.key, d.repo, d.date, d.title, substr(d.detail, 1, 300) AS passage
			FROM corpus_search_fts JOIN corpus_search_documents d ON d.rowid = corpus_search_fts.rowid
			WHERE corpus_search_fts MATCH ? ORDER BY corpus_search_fts.rank LIMIT ?`, match, q.limit).toArray();
	} catch (e) { throw Fail.of("validation", `search failed: ${(e as Error).message.slice(0, 200)}`); }
	const kinds = [...new Set(results.map((r) => r.kind))];
	return fit({ ...head, results, as_of: asOf(sql, (kinds.length ? kinds : Object.keys(SOURCES)).map((k) => SOURCES[k]!)) }, ["results"]);
}

/** Exact lookups: commit `repo@sha` (or a bare 40-hex sha across repos), repo full name, ref `repo:refname`, person name. */
export function get(sql: SqlStorage, q: { kind: "commit" | "repo" | "ref" | "person" | "pr" | "ticket" | "session"; key: string }, head: Head = {}) {
	const rows = (table: string, where: string, ...args: Value[]) => sql.exec(`SELECT ${projection(table)} FROM ${table} WHERE ${where}`, ...args).toArray();
	// Dated snapshot records: the published cut only (stages are never read), at most SQL_ROWS link rows per list with its own flag.
	const snap = (table: string, where: string, order: string, ...args: Value[]) =>
		sql.exec(`SELECT ${snapshotProjection(table)} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${SQL_ROWS + 1}`, ...args).toArray();
	const capped = (name: string, list: Record<string, unknown>[]) => ({ [name]: list.slice(0, SQL_ROWS), [`${name}_truncated`]: list.length > SQL_ROWS });
	switch (q.kind) {
		case "pr": {
			const at = q.key.lastIndexOf("#"), number = Number(q.key.slice(at + 1));
			if (at < 1 || !/^\d+$/.test(q.key.slice(at + 1)) || !Number.isSafeInteger(number)) throw Fail.of("validation", "a pr key is owner/repo#number");
			const repo = q.key.slice(0, at);
			const prs = snap("pull_requests", "repo = ? AND number = ?", "rowid", repo, number);
			return fit({ ...head, kind: q.kind, key: q.key, found: prs.length > 0, pull_requests: prs.slice(0, 20), ...capped("tickets", snap("pr_tickets", "repo = ? AND number = ?", "rowid", repo, number)),
				...capped("commits", snap("pr_commit_links", "repo = ? AND number = ?", "rowid", repo, number)), as_of: asOf(sql, ["pull_requests", "pr_tickets", "pr_commit_links"]) }, ["pull_requests", "tickets", "commits"]);
		}
		case "ticket": {
			const episodes = snap("ticket_episodes", "ticket = ?", "episode_no, rowid", q.key), links = snap("tickets", "ticket = ?", "repo, sha", q.key);
			return fit({ ...head, kind: q.kind, key: q.key, found: episodes.length > 0 || links.length > 0, ...capped("episodes", episodes), ...capped("commits", links),
				as_of: asOf(sql, ["ticket_episodes", "tickets"]) }, ["episodes", "commits"]);
		}
		case "session": {
			const sessions = snap("codex_sessions", "session_id = ?", "rowid", q.key);
			return fit({ ...head, kind: q.kind, key: q.key, found: sessions.length > 0, sessions: sessions.slice(0, 20), ...capped("commits", snap("session_commit_links", "session_id = ?", "rowid", q.key)),
				...capped("tickets", snap("session_ticket_links", "session_id = ?", "rowid", q.key)), as_of: asOf(sql, ["codex_sessions", "session_commit_links", "session_ticket_links"]) },
				["sessions", "commits", "tickets"]);
		}
		case "commit": {
			if (/^[0-9a-f]{40}$/i.test(q.key)) {
				const commits = rows("commits", "sha = ? ORDER BY repo LIMIT 20", q.key.toLowerCase());
				return fit({ ...head, kind: q.kind, key: q.key, found: commits.length > 0, commits, as_of: asOf(sql, ["commits"]) }, ["commits"]);
			}
			const at = q.key.lastIndexOf("@");
			if (at < 1) throw Fail.of("validation", "a commit key is repo@sha or a full sha");
			const [repo, sha] = [q.key.slice(0, at), q.key.slice(at + 1)];
			const commits = rows("commits", "repo = ? AND sha = ?", repo, sha);
			const paths = commits.length ? rows("commit_paths", `repo = ? AND sha = ? ORDER BY path LIMIT ${SQL_ROWS + 1}`, repo, sha) : [];
			return fit({ ...head, kind: q.kind, key: q.key, found: commits.length > 0, commits, paths: paths.slice(0, SQL_ROWS), paths_truncated: paths.length > SQL_ROWS, as_of: asOf(sql, ["commits", "commit_paths"]),
				repo_as_of: repoAsOf(sql, ["commits", "commit_paths"], repo) }, ["commits", "paths"]);
		}
		case "repo": {
			const repos = rows("repos", "full_name = ?", q.key);
			const contributors = rows("contributors", `repo = ? ORDER BY rank, rowid LIMIT ${SQL_ROWS}`, q.key);
			return fit({ ...head, kind: q.kind, key: q.key, found: repos.length > 0, repos, contributors, as_of: asOf(sql, ["repos", "contributors"]),
				repo_as_of: repoAsOf(sql, ["repos", "contributors"], q.key) }, ["repos", "contributors"]);
		}
		case "ref": {
			// Git refnames never contain ':', so the first one ends the repo.
			const at = q.key.indexOf(":");
			if (at < 1) throw Fail.of("validation", "a ref key is repo:refname");
			const refs = rows("refs", "repo = ? AND refname = ?", q.key.slice(0, at), q.key.slice(at + 1));
			return fit({ ...head, kind: q.kind, key: q.key, found: refs.length > 0, refs, as_of: asOf(sql, ["refs"]), repo_as_of: repoAsOf(sql, ["refs"], q.key.slice(0, at)) }, ["refs"]);
		}
		case "person": {
			const contributors = rows("contributors", `name = ? ORDER BY repo, rank, rowid LIMIT ${SQL_ROWS}`, q.key);
			return fit({ ...head, kind: q.kind, key: q.key, found: contributors.length > 0, contributors, as_of: asOf(sql, ["contributors"]) }, ["contributors"]);
		}
	}
}

const bad = (message: string) => Fail.of("validation", message, { reason: "sql_refused" });

/**
 * The text as one statement, or a refusal. A small lexer mirrors SQLite's quoting ('…', "…", `…`, […], -- and block comments)
 * so that no ';' outside a literal and no ')' that would close the wrapper's parenthesis gets through. Wrapped as
 * `SELECT * FROM (…)`, SQLite's own grammar then admits only a select. The rolled-back transaction is the backstop.
 */
export function singleSelect(text: string): string {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "'" || c === '"' || c === "`") {
			let j = i + 1;
			for (; ; j++) {
				if (j >= text.length) throw bad("unterminated quote");
				if (text[j] === c) { if (text[j + 1] === c) { j++; continue; } break; }
			}
			i = j;
		} else if (c === "[") {
			const j = text.indexOf("]", i + 1);
			if (j < 0) throw bad("unterminated identifier");
			i = j;
		} else if (c === "-" && text[i + 1] === "-") {
			const j = text.indexOf("\n", i);
			i = j < 0 ? text.length : j;
		} else if (c === "/" && text[i + 1] === "*") {
			const j = text.indexOf("*/", i + 2);
			if (j < 0) throw bad("unterminated comment");
			i = j + 1;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth < 0) throw bad("unbalanced parenthesis");
		else if (c === ";") {
			if (depth || text.slice(i + 1).trim()) throw bad(depth ? "unbalanced parenthesis" : "one statement only");
			return text.slice(0, i);
		}
	}
	if (depth) throw bad("unbalanced parenthesis");
	return text;
}

const ROLLBACK = Symbol("rollback");
const blob = (v: unknown) => (v instanceof ArrayBuffer ? { blob_hex: Buffer.from(v).toString("hex").slice(0, 2048) } : v);

/** Read-only SQL over this profile's corpus only: one SELECT, at most 500 rows and ANSWER_BYTES, inside an always-rolled-back transaction. */
export function runSql(storage: DurableObjectStorage, text: string, head: Head = {}) {
	const wrapped = `SELECT * FROM (\n${singleSelect(text)}\n) LIMIT ${SQL_ROWS + 1}`;
	const sql = storage.sql;
	let out: Record<string, unknown> | undefined;
	try {
		storage.transactionSync(() => {
			// The plan names every b-tree the statement opens, so as_of covers exactly the tables read.
			const plan = sql.exec<{ opcode: string; p2: number }>(`EXPLAIN ${wrapped}`).toArray();
			const pages = [...new Set(plan.filter((p) => p.opcode === "OpenRead" || p.opcode === "ReopenIdx").map((p) => Number(p.p2)))];
			const read = new Set(sql.exec<{ tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE rootpage IN (SELECT value FROM json_each(?))", JSON.stringify(pages)).toArray().map((r) => r.tbl_name));
			if (plan.some((p) => p.opcode === "VOpen")) read.add("corpus_search_fts");
			const tables = [...read].sort();
			if (tables.some((t) => t.startsWith("corpus_stage_"))) throw bad("unpublished snapshot tables are not readable");
			// Read before the statement runs, so nothing it does can shape the reported as_of.
			const as_of = asOf(sql, tables.flatMap((t) => (SEARCH.includes(t) ? Object.values(SOURCES) : Object.hasOwn(FAMILIES, t) || Object.hasOwn(SCANS, t) || Object.hasOwn(SNAPSHOTS, t) ? [t] : [])));
			const cursor = sql.exec(wrapped);
			const columns = cursor.columnNames;
			const fits = budget({ ...head, columns, rows: [], tables_read: tables, as_of });
			const rows: unknown[][] = [];
			let truncated = false;
			for (const r of cursor.raw()) {
				const row = r.map(blob);
				if (rows.length === SQL_ROWS || !fits(row, !rows.length)) { truncated = true; break; }
				rows.push(row);
			}
			out = { ...head, columns, rows, truncated, tables_read: tables, as_of };
			throw ROLLBACK;
		});
	} catch (e) {
		if (e !== ROLLBACK) throw e instanceof Fail ? e : bad(`SQL failed: ${(e as Error).message.slice(0, 300)}`);
	}
	return out!;
}
