// CorpusStore (Paid, section 14): one SQLite Durable Object per (user, profile, generation), named like its ProfileStore.
// Corpus rows live here, never as graph nodes. Approved families load in key order, one chunk per transaction, each replayed
// by its request id or refused; search documents are rebuilt here from the loaded rows. A wipe closes and then clears the
// generation, and nothing reopens a cleared one.
import { DurableObject } from "cloudflare:workers";
import { Fail, fail, ok, type Outcome, type ProfileRef } from "../domain/types";
import { applyRows, exportStore, exportTables, readChunk, readManifest } from "../backup";
import { migrate, type Migration } from "../storage";
import { chunkHash, checkChunk as checkBulkChunk, chunkTerms as bulkTerms, FAMILIES, manifest, named, requestIdOf, SCANS, scanManifest, SEARCH_DDL, VIEWS, type Family, type Key, type Value } from "./families";
import { get, runSql, search, type CorpusQuery, type Head } from "./query";
import { addToPartitions, META, MIGRATION, refresh, refreshActive, refreshStatus, type RefreshCommand } from "./refresh";
import { abandonLoadingCuts, applySnapshotChunk, checkSnapshotChunk, isSnapshot, SNAPSHOT_MIGRATION, SNAPSHOT_MIGRATION_5, SNAPSHOT_MIGRATION_6, SNAPSHOTS, snapshotManifest, snapshotStatus, snapshotTableOf, snapshotTerms, stageName } from "./snapshots";

export { CHUNK_ROWS, FAMILIES, FORBIDDEN, HELD, manifest, refusal, SCAN_ORDER, SCANS, VIEWS } from "./families";
/** The route's stateless chunk check: dated snapshot tables first (before HELD), every other table by its bulk family. */
export const checkChunk = (c: Parameters<typeof checkBulkChunk>[0]) => (isSnapshot(c.table) ? checkSnapshotChunk(c) : checkBulkChunk(c));
/** The work guard terms of a checked chunk, by the rule of the family checkChunk returned. */
export const chunkTerms = (f: Family, rows: Value[][]) => { const t = snapshotTableOf(f); return t ? snapshotTerms(SNAPSHOTS[t]!, rows) : bulkTerms(f, rows); };
export { PART_OPS, refreshTerms } from "./refresh";
export type { CorpusQuery } from "./query";
export type { Op, PlanHeader, RefreshCommand } from "./refresh";

/** 90% of the 10 GB Paid object limit. */
const SIZE_LIMIT = 9_000_000_000;

export const CORPUS_MIGRATIONS: Migration[] = [[
	...Object.values(FAMILIES).flatMap((f) => [f.ddl, ...f.indexes]),
	...SEARCH_DDL,
	// Bookkeeping (section 14): one row per loaded table, and every chunk's request id with its hash.
	`CREATE TABLE corpus_meta (table_name TEXT PRIMARY KEY, source TEXT NOT NULL, as_of TEXT NOT NULL, refresh TEXT NOT NULL, schema_sha256 TEXT NOT NULL,
		rows INTEGER NOT NULL, last_key TEXT, complete INTEGER NOT NULL, updated_at TEXT NOT NULL) WITHOUT ROWID`,
	`CREATE TABLE corpus_requests (request_id TEXT PRIMARY KEY, table_name TEXT NOT NULL, sha256 TEXT NOT NULL, rows INTEGER NOT NULL,
		last_key TEXT, complete INTEGER NOT NULL, received_at TEXT NOT NULL) WITHOUT ROWID`,
], MIGRATION,
// Checkout scans under their original DDL (plus one partition index each) and the read-time views; additive, no data moves.
[...Object.values(SCANS).flatMap((f) => [f.ddl, ...f.indexes]), ...Object.values(VIEWS)],
// Dated per-profile snapshot sets: live tables under their original DDL, one stage each, and the cut ledger (snapshots.ts).
SNAPSHOT_MIGRATION,
// The v5 record-type sets (PRs, releases, tickets, session metadata, curated judgment): live tables with their original indexes, and stages.
SNAPSHOT_MIGRATION_5, SNAPSHOT_MIGRATION_6];

export interface CorpusChunk { table: string; schema_sha256: string; source: { file_sha256: string }; as_of: string; columns: string[]; after: Key | null; rows: Value[][]; final: boolean; sha256: string }
export interface ChunkReceipt { status: "stored" | "replayed"; request_id: string; table: string; rows: number; last_key: Key | null; complete: boolean; sha256: string; rows_written?: number }
export interface CorpusStatus { tables: { table: string; rows: number; last_key: Key | null; complete: boolean; as_of: string; refresh: string; source_sha256: string }[] }
const refreshing = () => Fail.of("busy", "the corpus is refreshing; it reopens when the refresh publishes", { reason: "corpus_refreshing" });

const closedState = (sql: SqlStorage) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
	return sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = 'closed'`).toArray()[0]?.value;
};
/**
 * pull_requests keeps its original DDL, whose builder column "pr_key:1" never uploads, so every export of it carries that column as NULL.
 * The generic restore validator accepts only plain identifiers; this exact pair alone is dropped from the chunk (it stays NULL), and a
 * non-NULL value refuses the restore.
 */
function prKeyFree<C extends { table: string; columns: string[]; rows: unknown[][] }>(c: C): C {
	const i = c.table === "pull_requests" ? c.columns.indexOf("pr_key:1") : -1;
	if (i < 0) return c;
	if (c.rows.some((r) => r[i] !== null)) throw Fail.of("validation", "a pull_requests export holds a value in its never-uploaded builder column");
	return { ...c, columns: c.columns.filter((_, j) => j !== i), rows: c.rows.map((r) => r.filter((_, j) => j !== i)) };
}

/** An unfinished corpus restore: its generation exports nothing until it is done. */
const restoring = (sql: SqlStorage) => sql.exec(`SELECT 1 FROM ${META} WHERE key = 'restore_id'`).toArray().length > 0 && !sql.exec(`SELECT 1 FROM ${META} WHERE key = 'restore_done'`).toArray().length;
const assertOpen = (sql: SqlStorage) => { if (closedState(sql)) throw Fail.of("profile_wiped", "this corpus generation is closed"); };

/** One chunk in one transaction: replay or refuse by request id, then check order, source and every row before writing. */
function applyChunk(sql: SqlStorage, c: CorpusChunk): ChunkReceipt {
	assertOpen(sql);
	if (refreshActive(sql)) throw refreshing();
	// A dated snapshot keeps its own cut ledger, request ids and publication; no partitions, row hashes or search documents.
	if (isSnapshot(c.table)) return applySnapshotChunk(sql, c, () => sql.databaseSize > SIZE_LIMIT);
	const { f, rows, keys } = checkChunk(c);
	const requestId = requestIdOf(c.table, keys[0] ?? null);
	const hash = chunkHash(c);
	if (hash !== c.sha256) throw Fail.of("validation", "the chunk does not match its sha256", { reason: "hash_mismatch" });
	const prior = sql.exec<{ sha256: string; rows: number; last_key: string | null; complete: number }>("SELECT sha256, rows, last_key, complete FROM corpus_requests WHERE request_id = ?", requestId).toArray()[0];
	if (prior) {
		if (prior.sha256 !== hash) throw Fail.of("idempotency_mismatch", "this request id was stored with different rows", { reason: "idempotency_mismatch", request_id: requestId });
		return { status: "replayed", request_id: requestId, table: c.table, rows: prior.rows, last_key: prior.last_key === null ? null : JSON.parse(prior.last_key) as Key, complete: prior.complete === 1, sha256: hash };
	}
	if (sql.databaseSize > SIZE_LIMIT) throw Fail.of("size_budget", "this corpus is over 90% of its object limit", { reason: "size_budget" });
	const source = JSON.stringify({ file_sha256: c.source.file_sha256 });
	const meta = sql.exec<{ source: string; as_of: string; schema_sha256: string; last_key: string | null; complete: number; rows: number }>(
		"SELECT source, as_of, schema_sha256, last_key, complete, rows FROM corpus_meta WHERE table_name = ?", c.table).toArray()[0];
	if (meta?.complete) throw Fail.of("validation", "this table's load is complete; refreshing it is not supported yet", { reason: "table_complete" });
	// No blind append: a table loads from one source file, at one as_of, in one key order. Refresh semantics are a later protocol.
	if (meta && (meta.source !== source || meta.as_of !== c.as_of || meta.schema_sha256 !== c.schema_sha256)) throw Fail.of("validation", "this table is loading from another source or as_of", { reason: "source_changed" });
	if ((meta?.last_key ?? null) !== (c.after === null ? null : JSON.stringify(c.after))) throw Fail.of("validation", "chunks load in order; resume after the stored last key", { reason: "out_of_order", expected_after: meta?.last_key ? JSON.parse(meta.last_key) as Key : null });
	let written = 0;
	const run = (q: string, ...p: Value[]) => { const cur = sql.exec(q, ...p); cur.toArray(); written += cur.rowsWritten; return cur; };
	const cols = Object.keys(f.columns);
	const insert = `INSERT INTO ${c.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
	for (const r of rows) {
		run(insert, ...r);
		const d = f.search?.(named(f, r));
		if (!d) continue;
		const doc = sql.exec<{ id: number }>(`INSERT INTO corpus_search_documents (evidence_id, kind, key, repo, date, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (evidence_id) DO NOTHING RETURNING rowid AS id`, d.evidence_id, d.kind, d.key, d.repo, d.date, d.title, d.detail);
		const id = doc.toArray()[0]?.id;
		written += doc.rowsWritten;
		if (id !== undefined) run("INSERT INTO corpus_search_fts (rowid, key, repo, title, detail) VALUES (?, ?, ?, ?, ?)", id, d.key, d.repo, d.title, d.detail);
	}
	addToPartitions(sql, run, c.table, rows, c.source.file_sha256, c.as_of);
	const last = keys.length ? JSON.stringify(keys.at(-1)) : meta?.last_key ?? null;
	const now = new Date().toISOString();
	run(`INSERT INTO corpus_meta (table_name, source, as_of, refresh, schema_sha256, rows, last_key, complete, updated_at) VALUES (?, ?, ?, 'snapshot', ?, ?, ?, ?, ?)
		ON CONFLICT (table_name) DO UPDATE SET rows = rows + excluded.rows, last_key = excluded.last_key, complete = excluded.complete, updated_at = excluded.updated_at`,
		c.table, source, c.as_of, c.schema_sha256, rows.length, last, c.final ? 1 : 0, now);
	run("INSERT INTO corpus_requests (request_id, table_name, sha256, rows, last_key, complete, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)", requestId, c.table, hash, rows.length, last, c.final ? 1 : 0, now);
	return { status: "stored", request_id: requestId, table: c.table, rows: rows.length, last_key: last === null ? null : JSON.parse(last) as Key, complete: c.final, sha256: hash, rows_written: written };
}

export class CorpusStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// A cleared generation keeps only its closed marker; it is never migrated again.
		void ctx.blockConcurrencyWhile(async () => { if (!closedState(ctx.storage.sql)) migrate(ctx.storage, META, CORPUS_MIGRATIONS); });
	}

	/** Records which (user, profile, generation) this object is on first use, and refuses any other afterwards. */
	private bind(who: ProfileRef, readOnly = false): void {
		const sql = this.ctx.storage.sql;
		const meta = Object.fromEntries(sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${META} WHERE key IN ('user_id','profile','generation')`).toArray().map((r) => [r.key, r.value]));
		if (!meta.user_id) {
			if (readOnly) return;
			this.ctx.storage.transactionSync(() => {
				for (const [k, v] of [["user_id", who.userId], ["profile", who.profile], ["generation", who.generation]]) sql.exec(`INSERT INTO ${META} (key, value) VALUES (?, ?)`, k, v);
			});
		} else if (meta.user_id !== who.userId || meta.profile !== who.profile || meta.generation !== who.generation) {
			throw Fail.of("validation", "corpus object identity mismatch");
		}
	}

	/** The account's generation check, the same one every ProfileStore entry passes, then this object's own closed marker. */
	private async access(who: ProfileRef): Promise<void> {
		assertOpen(this.ctx.storage.sql);
		if (who.profile === "me") throw Fail.of("forbidden", "the corpus never holds me");
		const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "profileAccess">;
		const r = await account.profileAccess(who);
		if (!r.ok) throw new Fail(r.error);
		assertOpen(this.ctx.storage.sql);
	}

	async importChunk(who: ProfileRef, chunk: CorpusChunk): Promise<Outcome<ChunkReceipt>> {
		try {
			await this.access(who);
			this.bind(who);
			// The closed marker is checked again inside the transaction, so a chunk that waited out a wipe writes nothing.
			return ok(this.ctx.storage.transactionSync(() => applyChunk(this.ctx.storage.sql, chunk)));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	async status(who: ProfileRef): Promise<Outcome<CorpusStatus & { families: ReturnType<typeof manifest>; scan_families: ReturnType<typeof scanManifest>;
		snapshot_families: ReturnType<typeof snapshotManifest>; snapshots: ReturnType<typeof snapshotStatus> } & ReturnType<typeof refreshStatus>>> {
		try {
			await this.access(who);
			this.bind(who, true);
			const tables = this.ctx.storage.sql.exec<{ table_name: string; rows: number; last_key: string | null; complete: number; as_of: string; refresh: string; source: string }>(
				"SELECT table_name, rows, last_key, complete, as_of, refresh, source FROM corpus_meta ORDER BY table_name").toArray()
				.map((m) => ({ table: m.table_name, rows: m.rows, last_key: m.last_key === null ? null : JSON.parse(m.last_key) as Key, complete: m.complete === 1, as_of: m.as_of, refresh: m.refresh,
					source_sha256: (JSON.parse(m.source) as { file_sha256: string }).file_sha256 }));
			return ok({ families: manifest(), scan_families: scanManifest(), snapshot_families: snapshotManifest(), snapshots: snapshotStatus(this.ctx.storage.sql), tables, ...refreshStatus(this.ctx.storage.sql) });
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** head: the Worker's answer fields, so the answer budget counts the whole tool answer. */
	async query(who: ProfileRef, q: CorpusQuery, head: Head = {}): Promise<Outcome<unknown>> {
		try {
			await this.access(who);
			this.bind(who, true);
			const sql = this.ctx.storage.sql;
			// The read gate (design 4.3): no await separates this check from the synchronous read below.
			if (refreshActive(sql)) throw refreshing();
			switch (q.action) {
				case "search": return ok(search(sql, q, head));
				case "get": return ok(get(sql, q, head));
				case "sql": return ok(runSql(this.ctx.storage, q.sql, head));
			}
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** One refresh command (design revision 2), after the same access and generation checks as a chunk, in one transaction. */
	async refresh(who: ProfileRef, cmd: RefreshCommand): Promise<Outcome<string | Record<string, unknown>>> {
		try {
			await this.access(who);
			this.bind(who);
			return ok(this.ctx.storage.transactionSync(() => { assertOpen(this.ctx.storage.sql); return refresh(this.ctx.storage.sql, who, cmd); }));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Internal RPC from AccountStore: this generation's weekly encrypted export (section 18), under the bounded write pause. */
	async exportNow(who: ProfileRef): Promise<Outcome<{ id: string; seq: number; chunks: number; rows: number }>> {
		const sql = this.ctx.storage.sql;
		if (closedState(sql)) return fail("profile_wiped", "this corpus generation is closed");
		const bound = sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${META} WHERE key IN ('user_id','profile','generation')`).toArray();
		if (!bound.length) return fail("not_found", "this corpus generation holds nothing to export");
		const want: Record<string, string> = { user_id: who.userId, profile: who.profile, generation: who.generation };
		if (bound.some((r) => r.value !== want[r.key])) return fail("validation", "corpus object identity mismatch");
		if (refreshActive(sql)) return fail("busy", "the corpus is refreshing; export after it publishes", { reason: "corpus_refreshing" });
		if (restoring(sql)) return fail("busy", "this corpus generation is being restored");
		// shortcut: the whole-store pause of backup.ts, bounded by blockConcurrencyWhile's 30 s; a corpus too large for it fails and is retried next week.
		return this.ctx.blockConcurrencyWhile(() => exportStore(this.ctx.storage, this.env,
			{ store: `corpus-${who.profile}`, userId: who.userId, metaTable: META, control: Object.keys(SNAPSHOTS).map(stageName), profile: who.profile, generation: who.generation, rowid: true }));
	}

	/**
	 * Internal RPC from AccountStore's open corpus restore: applies a verified corpus export, one chunk per transaction with its
	 * progress, into this empty generation, then rebuilds the contentless search index from the restored documents and checks
	 * every table's row count. Identity, schema version and the closed marker stay this generation's.
	 */
	async restoreStep(who: ProfileRef, r: { id: string; exportId: string }): Promise<Outcome<{ applied: number; chunks: number; done: boolean }>> {
		try {
			const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "restoreAuthority">;
			const auth = await account.restoreAuthority(who, r.id, "corpus");
			if (!auth.ok) return auth;
			const sql = this.ctx.storage.sql;
			assertOpen(sql);
			this.bind(who);
			const m = await readManifest(this.env, `corpus-${who.profile}`, r.exportId, who.userId);
			if (!m.ok) return m;
			if (m.value.profile !== who.profile || m.value.schema_version !== CORPUS_MIGRATIONS.length) return fail("validation", "this export's profile or schema version does not match");
			const meta = (k: string) => sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = ?`, k).toArray()[0]?.value;
			if (!meta("restore_id")) {
				if (exportTables(sql, { control: [] }).some((t) => t !== META && sql.exec(`SELECT 1 FROM "${t}" LIMIT 1`).toArray().length)) return fail("validation", "a corpus restore needs an empty corpus generation");
				sql.exec(`INSERT INTO ${META} (key, value) VALUES ('restore_id', ?), ('restore_next', '0'), ('restore_fts', '0')`, r.id);
			} else if (meta("restore_id") !== r.id) return fail("validation", "this corpus generation belongs to another restore");
			const adjust = (table: string, cols: string[], row: unknown[]) =>
				table === META && (["user_id", "profile", "generation", "schema_version", "closed"].includes(String(row[cols.indexOf("key")])) || String(row[cols.indexOf("key")]).startsWith("restore_")) ? null : row;
			const all = { run: (q: string, ...p: SqlStorageValue[]) => sql.exec(q, ...p).toArray(), spent: () => false };
			const started = Date.now(), live = () => Date.now() - started < 10_000;
			// Chunks hold at most 500 rows and 512 KB, the scale of one uploaded corpus chunk, so each applies in one transaction.
			while (Number(meta("restore_next")) < m.value.chunks.length && live()) {
				const at = Number(meta("restore_next")), c = prKeyFree(await readChunk(this.env, m.value, at));
				this.ctx.storage.transactionSync(() => {
					if (Number(meta("restore_next")) !== at) return;
					applyRows(all, c, 0, c.rows.length, adjust, { n: 0 }, c.table === META);
					sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('restore_next', ?)`, String(at + 1));
				});
			}
			const applied = Number(meta("restore_next"));
			if (applied < m.value.chunks.length) return ok({ applied, chunks: m.value.chunks.length, done: false });
			// The search index is contentless and never exported: it is rebuilt from the restored documents, as an upload builds it.
			while (meta("restore_fts") !== "done" && live()) this.ctx.storage.transactionSync(() => {
				const after = Number(meta("restore_fts"));
				const docs = sql.exec<{ id: number; key: string; repo: string; title: string; detail: string }>("SELECT rowid AS id, key, repo, title, detail FROM corpus_search_documents WHERE rowid > ? ORDER BY rowid LIMIT 200", after).toArray();
				for (const d of docs) sql.exec("INSERT INTO corpus_search_fts (rowid, key, repo, title, detail) VALUES (?, ?, ?, ?, ?)", d.id, d.key, d.repo, d.title, d.detail);
				sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('restore_fts', ?)`, docs.length < 200 ? "done" : String(docs.at(-1)!.id));
			});
			if (meta("restore_fts") !== "done") return ok({ applied, chunks: m.value.chunks.length, done: false });
			if (!meta("restore_done")) {
				for (const [t, n] of Object.entries(m.value.counts)) {
					if (t !== META && sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t}"`).one().n !== n) return fail("validation", `restored ${t} does not match the manifest row count`);
				}
				// Stage rows are never exported, so a restored loading cut is abandoned, with its request receipts, before the generation reopens.
				this.ctx.storage.transactionSync(() => {
					abandonLoadingCuts(sql);
					sql.exec(`INSERT INTO ${META} (key, value) VALUES ('restore_done', ?)`, m.value.id);
				});
			}
			return ok({ applied, chunks: m.value.chunks.length, done: true });
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Internal RPC from an aborted corpus restore: clears what it wrote and leaves an empty, migrated generation. */
	async discardRestore(who: ProfileRef, id: string): Promise<void> {
		const sql = this.ctx.storage.sql;
		if (closedState(sql) || sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = 'restore_id'`).toArray()[0]?.value !== id) return;
		const bound = sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${META} WHERE key IN ('user_id','profile','generation')`).toArray();
		const want: Record<string, string> = { user_id: who.userId, profile: who.profile, generation: who.generation };
		if (bound.some((r) => r.value !== want[r.key])) return;
		await this.ctx.storage.deleteAll();
		migrate(this.ctx.storage, META, CORPUS_MIGRATIONS);
	}

	/**
	 * The wipe's two steps for this generation (section 9, step 3), driven by its ProfileStore: close refuses every later chunk
	 * and read; clear deletes every row and leaves only the closed marker. Internal RPC; replays are harmless.
	 */
	async wipe(who: ProfileRef, op: "close" | "clear"): Promise<Outcome<{ closed: string }>> {
		const sql = this.ctx.storage.sql;
		const bound = sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${META} WHERE key IN ('user_id','profile','generation')`).toArray();
		const want: Record<string, string> = { user_id: who.userId, profile: who.profile, generation: who.generation };
		if (bound.some((r) => r.value !== want[r.key])) return { ok: false, error: { code: "validation", message: "corpus object identity mismatch" } };
		if (op === "close") {
			if (closedState(sql) !== "wiped") sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('closed', 'wiping')`);
			return ok({ closed: closedState(sql)! });
		}
		await this.ctx.storage.deleteAll();
		sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
		sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('closed', 'wiped')`);
		return ok({ closed: "wiped" });
	}
}
