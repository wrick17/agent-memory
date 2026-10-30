// CorpusStore (Paid, section 14): one SQLite Durable Object per (user, profile, generation), named like its ProfileStore.
// Corpus rows live here, never as graph nodes. Approved families load in key order, one chunk per transaction, each replayed
// by its request id or refused; search documents are rebuilt here from the loaded rows. A wipe closes and then clears the
// generation, and nothing reopens a cleared one.
import { DurableObject } from "cloudflare:workers";
import { Fail, ok, type Outcome, type ProfileRef } from "../domain/types";
import { migrate, type Migration } from "../storage";
import { chunkHash, checkChunk, FAMILIES, manifest, named, requestIdOf, SEARCH_DDL, type Key, type Value } from "./families";
import { get, runSql, search, type CorpusQuery, type Head } from "./query";

export { CHUNK_ROWS, checkChunk, chunkTerms, FAMILIES, FORBIDDEN, HELD, manifest, refusal } from "./families";
export type { CorpusQuery } from "./query";

const META = "corpus_store_meta";
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
]];

export interface CorpusChunk { table: string; schema_sha256: string; source: { file_sha256: string }; as_of: string; columns: string[]; after: Key | null; rows: Value[][]; final: boolean; sha256: string }
export interface ChunkReceipt { status: "stored" | "replayed"; request_id: string; table: string; rows: number; last_key: Key | null; complete: boolean; sha256: string; rows_written?: number }
export interface CorpusStatus { tables: { table: string; rows: number; last_key: Key | null; complete: boolean; as_of: string; refresh: string; source_sha256: string }[] }

const closedState = (sql: SqlStorage) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
	return sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = 'closed'`).toArray()[0]?.value;
};
const assertOpen = (sql: SqlStorage) => { if (closedState(sql)) throw Fail.of("profile_wiped", "this corpus generation is closed"); };

/** One chunk in one transaction: replay or refuse by request id, then check order, source and every row before writing. */
function applyChunk(sql: SqlStorage, c: CorpusChunk): ChunkReceipt {
	assertOpen(sql);
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

	async status(who: ProfileRef): Promise<Outcome<CorpusStatus & { families: ReturnType<typeof manifest> }>> {
		try {
			await this.access(who);
			this.bind(who, true);
			const tables = this.ctx.storage.sql.exec<{ table_name: string; rows: number; last_key: string | null; complete: number; as_of: string; refresh: string; source: string }>(
				"SELECT table_name, rows, last_key, complete, as_of, refresh, source FROM corpus_meta ORDER BY table_name").toArray()
				.map((m) => ({ table: m.table_name, rows: m.rows, last_key: m.last_key === null ? null : JSON.parse(m.last_key) as Key, complete: m.complete === 1, as_of: m.as_of, refresh: m.refresh,
					source_sha256: (JSON.parse(m.source) as { file_sha256: string }).file_sha256 }));
			return ok({ families: manifest(), tables });
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** head: the Worker's answer fields, so the answer budget counts the whole tool answer. */
	async query(who: ProfileRef, q: CorpusQuery, head: Head = {}): Promise<Outcome<unknown>> {
		try {
			await this.access(who);
			this.bind(who, true);
			const sql = this.ctx.storage.sql;
			switch (q.action) {
				case "search": return ok(search(sql, q, head));
				case "get": return ok(get(sql, q, head));
				case "sql": return ok(runSql(this.ctx.storage, q.sql, head));
			}
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
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
