// Encrypted exports to R2 and restore from an export (section 18), first vertical. The export is the approved bounded
// write pause: the store blocks every other event while it snapshots, so the export is the store's exact state at `seq`.
// shortcut: profiles and the account use the whole-store pause, bounded by blockConcurrencyWhile's 30 s; upgrade them to the total-key
// cursor export before one outgrows it. The corpus, which has outgrown it, uses the fenced resumable export (exportStep).
import { sha256 } from "./domain/ids";
import { Fail, fail, ok, type Outcome } from "./domain/types";

declare global { interface Env { BACKUP_KEY?: string } }

export const CHUNK_ROWS = 500;
export const CHUNK_BYTES = 512 * 1024;
export const KEEP = 2;

/**
 * `rowid`: also export each rowid table's own rowid, for stores whose rows are keyed by it (the corpus families). `preserve`: the owner's
 * manual export that keeps every existing export (no retention for this one export only; the next default export prunes as usual).
 */
export interface StoreSpec { store: string; userId: string; metaTable: string; control: readonly string[]; first?: readonly string[]; profile?: string; generation?: string; rowid?: boolean; preserve?: boolean }
export interface ChunkRef { key: string; table: string; rows: number; sha256: string }
export interface Manifest {
	/** 2: a journaled resumable export (exportStep), restored in order with replace and delta deletes. */
	version: 1 | 2; id: string; store: string; userId: string; profile?: string; generation?: string;
	schema_version: number; seq: number; at: string; counts: Record<string, number>; chunks: ChunkRef[];
}
/** A delta chunk (version 2) also names its key columns and the keys deleted at its read; each key appears once per chunk. */
interface Chunk { table: string; columns: string[]; rows: unknown[][]; key?: string[]; deletes?: unknown[][] }

const enc = new TextEncoder();
/** UTF-8 bytes of a value's JSON: every chunk and cut budget counts these, not UTF-16 string length. */
const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v)).length;
/**
 * Packs items into chunks of at most CHUNK_ROWS items whose whole JSON (header, items and separators) stays within CHUNK_BYTES;
 * an item larger than that goes alone. `make` builds a chunk from its items.
 */
function pack<T>(items: T[], make: (part: T[]) => Chunk, measure?: (it: T) => unknown): Chunk[] {
	const out: Chunk[] = [], head = jsonBytes(make([]));
	let part: T[] = [], size = head;
	for (const it of items) {
		const b = jsonBytes(measure ? measure(it) : it) + 1;
		if (part.length && (part.length >= CHUNK_ROWS || size + b > CHUNK_BYTES)) { out.push(make(part)); part = []; size = head; }
		part.push(it); size += b;
	}
	if (part.length) out.push(make(part));
	return out;
}
async function backupKey(env: Env): Promise<CryptoKey> {
	if (!env.BACKUP_KEY || env.BACKUP_KEY.length < 32) throw Fail.of("unavailable", "BACKUP_KEY is not configured (at least 32 characters)");
	const base = await crypto.subtle.importKey("raw", enc.encode(env.BACKUP_KEY), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("agent-memory/export/v1"), info: new Uint8Array() },
		base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** AES-256-GCM with a random 96-bit IV per object and the object key as additional data, so a part cannot be moved. */
async function seal(key: CryptoKey, objectKey: string, plain: string): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(objectKey) }, key, enc.encode(plain)));
	const out = new Uint8Array(12 + ct.length);
	out.set(iv); out.set(ct, 12);
	return out;
}
async function unseal(key: CryptoKey, objectKey: string, bytes: Uint8Array): Promise<string> {
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(objectKey) }, key, bytes.slice(12));
		return new TextDecoder().decode(pt);
	} catch { throw Fail.of("validation", `export object ${objectKey} failed decryption`); }
}

/**
 * Exported tables: every ordinary table except SQLite, Cloudflare and Miniflare internals, full-text indexes (rebuilt by triggers),
 * tombstones and control state. Miniflare writes each named object's own name into __miniflare_do_name on local runs.
 */
export function exportTables(sql: SqlStorage, spec: Pick<StoreSpec, "control" | "first">): string[] {
	const all = sql.exec<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table'").toArray();
	const virtual = all.filter((t) => /^CREATE VIRTUAL/i.test(t.sql ?? "")).map((t) => t.name);
	const names = all.map((t) => t.name).filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && n !== "__miniflare_do_name" && n !== "deleted_rows" && n !== JOURNAL
		&& !spec.control.includes(n) && !virtual.some((v) => n === v || n.startsWith(`${v}_`)));
	const first = spec.first ?? [];
	return [...first.filter((n) => names.includes(n)), ...names.filter((n) => !first.includes(n)).sort()];
}

function orderOf(sql: SqlStorage, table: string): { order: string; hidden: boolean } {
	const pk = sql.exec<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", table).toArray();
	const rowid = !/WITHOUT ROWID\s*$/i.test(sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", table).one().sql);
	// An INTEGER PRIMARY KEY is the rowid itself and is already a column; any other rowid is hidden from SELECT *.
	return { order: rowid ? "rowid" : pk.map((r) => `"${r.name}"`).join(", "), hidden: rowid && !(pk.length === 1 && /^INTEGER$/i.test(pk[0]!.type)) };
}

const writeSeq = (sql: SqlStorage, metaTable: string) => Number(sql.exec<{ value: string }>(`SELECT value FROM ${metaTable} WHERE key = 'write_seq'`).toArray()[0]?.value ?? 0);

/**
 * Run inside blockConcurrencyWhile. Reads every exported table in bounded pages, puts each encrypted chunk, then the manifest,
 * then keeps the two newest complete exports. Never throws: a throw there would reset the object.
 */
export async function exportStore(storage: DurableObjectStorage, env: Env, spec: StoreSpec): Promise<Outcome<{ id: string; seq: number; chunks: number; rows: number }>> {
	try {
		const sql = storage.sql, key = await backupKey(env), at = new Date().toISOString();
		const id = `${at.replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`, prefix = `exports/${spec.store}/${id}/`;
		const seq = writeSeq(sql, spec.metaTable);
		const schema = Number(sql.exec<{ value: string }>(`SELECT value FROM ${spec.metaTable} WHERE key = 'schema_version'`).one().value);
		const chunks: ChunkRef[] = [], counts: Record<string, number> = {};
		const put = async (c: Chunk) => {
			const plain = JSON.stringify(c), k = `${prefix}${String(chunks.length).padStart(5, "0")}.enc`;
			await env.BACKUPS.put(k, await seal(key, k, plain));
			chunks.push({ key: k, table: c.table, rows: c.rows.length, sha256: sha256(plain) });
		};
		for (const table of exportTables(sql, spec)) {
			const { order, hidden } = orderOf(sql, table), cols = spec.rowid && hidden ? "rowid AS rowid, *" : "*";
			counts[table] = 0;
			let columns: string[] = [], rows: unknown[][] = [], bytes = 0;
			// The store is paused, so offset pages over a fixed order read every row exactly once.
			for (let offset = 0; ; offset += CHUNK_ROWS) {
				const cur = sql.exec(`SELECT ${cols} FROM "${table}" ORDER BY ${order} LIMIT ${CHUNK_ROWS} OFFSET ${offset}`);
				columns = cur.columnNames;
				const page = [...cur.raw()];
				for (const row of page) {
					if (row.some((v) => v instanceof ArrayBuffer)) throw Fail.of("unavailable", `table ${table} holds a blob, which this export does not encode`);
					const size = jsonBytes(row) + 1;
					if (rows.length && (rows.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)) { await put({ table, columns, rows }); rows = []; }
					if (!rows.length) bytes = jsonBytes({ table, columns, rows: [] }); // each chunk's header, with the real column names
					rows.push(row); bytes += size; counts[table]++;
				}
				if (page.length < CHUNK_ROWS) break;
			}
			if (rows.length) await put({ table, columns, rows });
		}
		if (writeSeq(sql, spec.metaTable) !== seq) return fail("busy", "a write landed during the export; retry");
		const manifest: Manifest = { version: 1, id, store: spec.store, userId: spec.userId, ...(spec.profile ? { profile: spec.profile, generation: spec.generation! } : {}),
			schema_version: schema, seq, at, counts, chunks };
		const mk = `${prefix}manifest.enc`;
		await env.BACKUPS.put(mk, await seal(key, mk, JSON.stringify(manifest)));
		if (!spec.preserve) await retain(env, spec.store);
		return ok({ id, seq, chunks: chunks.length, rows: Object.values(counts).reduce((a, b) => a + b, 0) });
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		return fail("unavailable", `export failed: ${(e as Error).message}`);
	}
}

/**
 * A resumable export (the corpus, whose size outgrows the 30 s pause; contract CONTRACT-v2): a baseline of keyset pages read while
 * writes flow, then deltas from a change journal that triggers fill only while the job runs, then one synchronous cut. The job's
 * durable progress lives in the store's meta table under `export_*` keys, which are never exported or journaled. A write fence
 * (exportFenced) is only the fallback when catch-up falls behind, and it lapses by the clock after 30 s.
 */
/** `preserve`: set at begin from StoreSpec.preserve and read back from the durable job, so a resumed step never prunes; absent on older jobs. */
export interface ExportJob { id: string; at: string; schema: number; phase: "baseline" | "delta" | "publishing"; table: number; after: unknown[] | null; jc: number; over: number;
	fence_until: number | null; n: number; counts: Record<string, number>; preserve?: true }
const JOURNAL = "export_journal";
const STEP_MS = 10_000, STEP_CHUNKS = 200, DRAIN = 1_000, CUT_ROWS = 8_000, CUT_BYTES = 2 * 1024 * 1024, FENCE_MS = 30_000, FENCE_AFTER = 50;
const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function exportJob(sql: SqlStorage, metaTable: string): ExportJob | undefined {
	const raw = sql.exec<{ value: string }>(`SELECT value FROM ${metaTable} WHERE key = 'export_job'`).toArray()[0]?.value;
	return raw ? JSON.parse(raw) as ExportJob : undefined;
}
/** Whether the fallback fence holds: only within its 30 s, whatever the export's steps do. */
export const exportFenced = (sql: SqlStorage, metaTable: string) => { const f = exportJob(sql, metaTable)?.fence_until; return f != null && Date.now() < f; };
/** The outcome of the store's last finished or stopped resumable export, if any. */
export const lastExport = (sql: SqlStorage, metaTable: string) => {
	const raw = sql.exec<{ value: string }>(`SELECT value FROM ${metaTable} WHERE key = 'export_last'`).toArray()[0]?.value;
	return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
};

/** How a table is read and keyed: rowid tables by their rowid (a hidden one selected as `rowid`), others by their primary key. */
function shapeOf(sql: SqlStorage, table: string): { cols: string; order: string; key: string[]; at: (r: "NEW" | "OLD") => string } {
	const { order, hidden } = orderOf(sql, table);
	if (order === "rowid") {
		const pk = hidden ? "rowid" : sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) WHERE pk > 0", table).one().name;
		return { cols: hidden ? "rowid AS rowid, *" : "*", order, key: [pk], at: (r) => `json_array(${r}.rowid)` };
	}
	const names = order.split(", ").map((c) => c.slice(1, -1));
	return { cols: "*", order, key: names, at: (r) => `json_array(${names.map((n) => `${r}."${n}"`).join(", ")})` };
}
const keyWhere = (key: string[]) => `(${key.map((k) => (k === "rowid" ? "rowid" : `"${k}"`)).join(", ")}) = (${key.map(() => "?").join(", ")})`;
const notOwn = (r: string) => `${r}.key NOT LIKE 'export\\_%' ESCAPE '\\'`;

/** Drops the change journal and its triggers. */
export function endCapture(sql: SqlStorage): void {
	for (const t of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'export\\_cap\\_%' ESCAPE '\\'").toArray()) sql.exec(`DROP TRIGGER "${t.name}"`);
	sql.exec(`DROP TABLE IF EXISTS ${JOURNAL}`);
}

/**
 * Starts the job in one transaction: the change journal and one AFTER INSERT/UPDATE/DELETE trigger set per exported table, so
 * every later write records its keys (an update its old key and any new one) in its own transaction. The caller has checked
 * that the store may export and that no job runs.
 */
export function beginExport(storage: DurableObjectStorage, spec: StoreSpec): ExportJob {
	const sql = storage.sql, at = new Date().toISOString();
	const job: ExportJob = { id: `${at.replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`, at, phase: "baseline", table: 0, after: null, jc: 0, over: 0, fence_until: null, n: 0, counts: {}, ...(spec.preserve ? { preserve: true as const } : {}),
		schema: Number(sql.exec<{ value: string }>(`SELECT value FROM ${spec.metaTable} WHERE key = 'schema_version'`).one().value) };
	storage.transactionSync(() => {
		endCapture(sql);
		sql.exec(`CREATE TABLE ${JOURNAL} (jseq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, key TEXT NOT NULL)`);
		exportTables(sql, spec).forEach((t, i) => {
			const { at: k } = shapeOf(sql, t), meta = t === spec.metaTable, put = (r: "NEW" | "OLD") => `INSERT INTO ${JOURNAL} (tbl, key) VALUES ('${t}', ${k(r)});`;
			sql.exec(`CREATE TRIGGER export_cap_${i}_i AFTER INSERT ON "${t}"${meta ? ` WHEN ${notOwn("NEW")}` : ""} BEGIN ${put("NEW")} END`);
			sql.exec(`CREATE TRIGGER export_cap_${i}_d AFTER DELETE ON "${t}"${meta ? ` WHEN ${notOwn("OLD")}` : ""} BEGIN ${put("OLD")} END`);
			sql.exec(`CREATE TRIGGER export_cap_${i}_u AFTER UPDATE ON "${t}"${meta ? ` WHEN ${notOwn("OLD")} OR ${notOwn("NEW")}` : ""} BEGIN ${put("OLD")}
				INSERT INTO ${JOURNAL} (tbl, key) SELECT '${t}', ${k("NEW")} WHERE ${k("NEW")} IS NOT ${k("OLD")}; END`);
		});
		sql.exec(`DELETE FROM ${spec.metaTable} WHERE key LIKE 'export\\_refs:%' ESCAPE '\\'`);
		sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES ('export_job', ?)`, JSON.stringify(job));
	});
	return job;
}

/**
 * Ends a running job (a restore begins into this store) and records `export_drop:<id>` in the same transaction, so its objects
 * are deleted by dropCancelled whether or not a step is running; a running step also deletes them when it sees the job gone.
 * True when a job was cancelled: the caller arms the alarm that runs dropCancelled.
 */
export function cancelExport(storage: DurableObjectStorage, spec: Pick<StoreSpec, "store" | "metaTable">, why: string): boolean {
	const job = exportJob(storage.sql, spec.metaTable);
	if (!job) return false;
	storage.transactionSync(() => {
		endCapture(storage.sql);
		storage.sql.exec(`DELETE FROM ${spec.metaTable} WHERE key = 'export_job' OR key LIKE 'export\\_refs:%' ESCAPE '\\'`);
		storage.sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES ('export_last', ?), (?, ?)`,
			JSON.stringify({ id: job.id, at: new Date().toISOString(), state: "failed", error: why }), `export_drop:${job.id}`, spec.store);
	});
	return true;
}

/** The export steps in flight on each store object: no cleanup or clear may run under a put that can still land. */
const stepping = new WeakMap<object, Set<Promise<unknown>>>();
/** Waits until no export step of this store object is in flight; a step that finds its job gone has then deleted or marked its objects. */
export async function settleExports(storage: DurableObjectStorage): Promise<void> {
	for (let s = stepping.get(storage); s?.size; s = stepping.get(storage)) await Promise.allSettled([...s]);
}

/**
 * Deletes the objects of every cancelled or abandoned export recorded in the store, after any in-flight step has settled, and
 * consumes each marker only after its objects are gone; a failure keeps the remaining markers for the next run.
 */
export async function dropCancelled(storage: DurableObjectStorage, env: Env, metaTable: string): Promise<void> {
	const sql = storage.sql;
	await settleExports(storage);
	for (const m of sql.exec<{ key: string; value: string }>(`SELECT key, value FROM ${metaTable} WHERE key LIKE 'export\\_drop:%' ESCAPE '\\'`).toArray()) {
		await dropExportId(env, m.value, m.key.slice("export_drop:".length));
		sql.exec(`DELETE FROM ${metaTable} WHERE key = ?`, m.key);
	}
}

/**
 * Synchronously reads up to `limit` journal entries after `after` and each distinct key's current row: present is an upsert,
 * absent a delete. Run in one turn, so no write lands between an entry and its row.
 */
function readDelta(sql: SqlStorage, metaTable: string, after: number, limit: number) {
	const entries = sql.exec<{ jseq: number; tbl: string; key: string }>(`SELECT jseq, tbl, key FROM ${JOURNAL} WHERE jseq > ? ORDER BY jseq LIMIT ?`, after, limit).toArray();
	const by = new Map<string, Set<string>>();
	for (const e of entries) by.set(e.tbl, (by.get(e.tbl) ?? new Set()).add(e.key));
	const chunks: Chunk[] = [];
	for (const [table, keys] of by) {
		const s = shapeOf(sql, table), columns = sql.exec(`SELECT ${s.cols} FROM "${table}" LIMIT 0`).columnNames;
		const own = table === metaTable ? ` AND ${notOwn(table)}` : "";
		const ops: { row?: unknown[]; del?: unknown[] }[] = [];
		for (const k of keys) {
			const kv = JSON.parse(k) as SqlStorageValue[], row = [...sql.exec(`SELECT ${s.cols} FROM "${table}" WHERE ${keyWhere(s.key)}${own}`, ...kv).raw()][0];
			if (row?.some((v) => v instanceof ArrayBuffer)) throw Fail.of("unavailable", `table ${table} holds a blob, which this export does not encode`);
			ops.push(row ? { row } : { del: kv });
		}
		chunks.push(...pack(ops, (part) => ({ table, columns, key: s.key, rows: part.flatMap((o) => (o.row ? [o.row] : [])), deletes: part.flatMap((o) => (o.del ? [o.del] : [])) }), (o) => o.row ?? o.del));
	}
	return { chunks, bytes: chunks.reduce((bytes, chunk) => bytes + jsonBytes(chunk), 0), last: entries.at(-1)?.jseq ?? after };
}

/**
 * One bounded step of the store's export job (about ten seconds or 200 chunks). Each page or delta batch is put before its
 * progress commits, so a step that dies repeats it under the same chunk numbers. `halted` names the store's own reason to stop
 * (its closed marker). A stopped job or a permanent failure deletes the job's objects, ends capture and lifts any fence; a
 * transient error leaves the job for the next step. Rowid tables always carry their rowid, as `rowid: true`.
 */
export function exportStep(storage: DurableObjectStorage, env: Env, spec: StoreSpec, halted: () => string | null): ReturnType<typeof step> {
	const run = step(storage, env, spec, halted), set = stepping.get(storage) ?? new Set();
	stepping.set(storage, set.add(run));
	const done = () => { set.delete(run); };
	run.then(done, done);
	return run;
}
async function step(storage: DurableObjectStorage, env: Env, spec: StoreSpec, halted: () => string | null):
	Promise<Outcome<{ id: string; done: boolean; chunks: number; rows: number }>> {
	const sql = storage.sql, start = exportJob(sql, spec.metaTable);
	if (!start) return fail("not_found", "no export is running");
	let job: ExportJob = start;
	const id = job.id, prefix = `exports/${spec.store}/${id}/`, mine = () => exportJob(sql, spec.metaTable)?.id === id;
	const schema = () => Number(sql.exec<{ value: string }>(`SELECT value FROM ${spec.metaTable} WHERE key = 'schema_version'`).toArray()[0]?.value);
	// Once publishing, the cut is taken and its chunks are final: only a close or a cancel still stops it.
	const stop = () => halted() ?? (!mine() ? "the export was cancelled" : job.phase === "publishing" ? null : schema() !== job.schema ? "the store migrated during the export"
		: job.fence_until !== null && Date.now() >= job.fence_until ? "catch-up did not reach the cut within the 30-second write fence" : null);
	const finish = (last: Record<string, unknown>) => storage.transactionSync(() => {
		if (!mine()) return; // a cleared or cancelled store keeps nothing of the job
		endCapture(sql);
		sql.exec(`DELETE FROM ${spec.metaTable} WHERE key = 'export_job' OR key LIKE 'export\\_refs:%' ESCAPE '\\'`);
		sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES ('export_last', ?)`, JSON.stringify({ id, at: new Date().toISOString(), ...last }));
	});
	/**
	 * Durable ownership first: the exact-ID marker commits (with the job's end) before any delete, and goes only once the objects
	 * are gone; a failed delete keeps it and arms the alarm that retries (dropCancelled). This holds in a store cleared meanwhile.
	 */
	const abandon = async (why: string) => {
		const marker = `export_drop:${id}`;
		storage.transactionSync(() => {
			sql.exec(`CREATE TABLE IF NOT EXISTS ${spec.metaTable} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
			sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES (?, ?)`, marker, spec.store);
		});
		finish({ state: "failed", error: why });
		try {
			await dropExportId(env, spec.store, id);
			sql.exec(`DELETE FROM ${spec.metaTable} WHERE key = ?`, marker);
		} catch { await storage.setAlarm(Date.now() + 30_000); }
		return fail("unavailable", `export ${id} stopped: ${why}`);
	};
	const save = (next: ExportJob) => sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES ('export_job', ?)`, JSON.stringify(next));
	const backlog = () => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${JOURNAL} WHERE jseq > ?`, job.jc).one().n;
	const rowsOf = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
	try {
		const key = await backupKey(env), tables = exportTables(sql, spec), began = Date.now();
		const refsKey = `export_refs:${pad(job.n, 6)}`, refs: Omit<ChunkRef, "key">[] = [];
		const putAll = async (chunks: Chunk[]) => {
			const out: Omit<ChunkRef, "key">[] = [];
			for (const c of chunks) {
				const plain = JSON.stringify(c), k = `${prefix}${pad(job.n + out.length, 5)}.enc`;
				await env.BACKUPS.put(k, await seal(key, k, plain));
				out.push({ table: c.table, rows: c.rows.length, sha256: sha256(plain) });
			}
			return out;
		};
		// Chunk numbers and refs advance with the cursor in one transaction.
		const commit = (next: ExportJob, put: Omit<ChunkRef, "key">[]) => storage.transactionSync(() => {
			if (!mine()) return false;
			refs.push(...put);
			save(next);
			sql.exec(`INSERT OR REPLACE INTO ${spec.metaTable} (key, value) VALUES (?, ?)`, refsKey, JSON.stringify(refs));
			return true;
		});
		/**
		 * Publication from durable state alone (the refs and the publishing job): the same manifest whenever it is repeated, then
		 * retention, then completion. No chunk is read or written again after the publishing commit.
		 */
		const publish = async () => {
			const chunks: ChunkRef[] = sql.exec<{ value: string }>(`SELECT value FROM ${spec.metaTable} WHERE key LIKE 'export\\_refs:%' ESCAPE '\\' ORDER BY key`).toArray()
				.flatMap((r) => JSON.parse(r.value) as Omit<ChunkRef, "key">[]).map((c, i) => ({ key: `${prefix}${pad(i, 5)}.enc`, ...c }));
			if (chunks.length !== job.n) throw Fail.of("unavailable", "the export's chunk list does not match its progress");
			const manifest: Manifest = { version: 2, id, store: spec.store, userId: spec.userId, ...(spec.profile ? { profile: spec.profile, generation: spec.generation! } : {}),
				schema_version: job.schema, seq: 0, at: job.at, counts: job.counts, chunks }; // a journaled export is fixed by its cut, not a write sequence
			const mk = `${prefix}manifest.enc`;
			await env.BACKUPS.put(mk, await seal(key, mk, JSON.stringify(manifest)));
			// A store closed or cleared meanwhile keeps no export.
			if (halted() || !mine()) return await abandon(halted() ?? "the export was cancelled");
			if (!job.preserve) await retain(env, spec.store);
			finish({ state: "done", chunks: chunks.length, rows: rowsOf(job.counts) });
			return ok({ id, done: true, chunks: chunks.length, rows: rowsOf(job.counts) });
		};
		while (Date.now() - began < STEP_MS && refs.length < STEP_CHUNKS) {
			const why = stop();
			if (why) return await abandon(why);
			if (job.phase === "publishing") return await publish();
			let next: ExportJob, put: Omit<ChunkRef, "key">[];
			if (job.phase === "baseline") {
				if (job.table >= tables.length) { next = { ...job, phase: "delta" }; put = []; } else {
					// A page is one synchronous read while writes flow: a key changed after its page is journaled and read again as a delta.
					const table = tables[job.table]!, s = shapeOf(sql, table);
					const filter = job.after === null ? "" : `WHERE (${s.key.map((k) => (k === "rowid" ? k : `"${k}"`)).join(", ")}) > (${s.key.map(() => "?").join(", ")})`;
					const own = table === spec.metaTable ? `${filter ? `${filter} AND` : "WHERE"} ${notOwn(table)}` : filter;
					const cur = sql.exec(`SELECT ${s.cols} FROM "${table}" ${own} ORDER BY ${s.order} LIMIT ${CHUNK_ROWS}`, ...((job.after ?? []) as SqlStorageValue[]));
					const columns = cur.columnNames, page = [...cur.raw()], at = s.key.map((c) => columns.indexOf(c));
					if (page.some((row) => row.some((v) => v instanceof ArrayBuffer))) throw Fail.of("unavailable", `table ${table} holds a blob, which this export does not encode`);
					put = await putAll(pack(page, (rows) => ({ table, columns, rows })));
					const last = page.at(-1);
					next = { ...job, n: job.n + put.length, counts: { ...job.counts, [table]: (job.counts[table] ?? 0) + page.length },
						...(page.length < CHUNK_ROWS ? { table: job.table + 1, after: null } : { after: at.map((i) => last![i]) }) };
				}
			} else if (backlog() <= CUT_ROWS) {
				// The cut: everything after jc and its rows in this one synchronous turn, the instant C of the export.
				const cut = readDelta(sql, spec.metaTable, job.jc, CUT_ROWS);
				if (cut.bytes <= CUT_BYTES) {
					const counts = { ...job.counts };
					for (const t of sql.exec<{ tbl: string }>(`SELECT DISTINCT tbl FROM ${JOURNAL}`).toArray().map((r) => r.tbl)) {
						counts[t] = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t}"${t === spec.metaTable ? ` WHERE ${notOwn(t)}` : ""}`).one().n;
					}
					if (job.fence_until !== null) { job = { ...job, fence_until: null, over: 0 }; save(job); } // writes resume now
					const tail = await putAll(cut.chunks);
					// The publishing commit freezes the cut: its tail refs and counts commit together, before any manifest exists.
					const frozen: ExportJob = { ...job, phase: "publishing", jc: cut.last, n: job.n + tail.length, counts, fence_until: null, over: 0 };
					if (!commit(frozen, tail)) return await abandon("the export was cancelled");
					job = frozen;
					return await publish();
				}
				const d = readDelta(sql, spec.metaTable, job.jc, DRAIN);
				put = await putAll(d.chunks);
				next = { ...job, jc: d.last, n: job.n + put.length };
			} else {
				const d = readDelta(sql, spec.metaTable, job.jc, DRAIN);
				put = await putAll(d.chunks);
				next = { ...job, jc: d.last, n: job.n + put.length };
			}
			if (!commit(next, put)) return await abandon("the export was cancelled");
			job = next;
		}
		// Fallback (section 18 step 3): 50 steps in a row that end over the cut bound fence writes for at most 30 s.
		if (job.phase === "delta" && mine()) {
			const over = backlog() > CUT_ROWS ? job.over + 1 : 0;
			job = { ...job, over, fence_until: job.fence_until ?? (over >= FENCE_AFTER ? Date.now() + FENCE_MS : null) };
			save(job);
		}
		return ok({ id, done: false, chunks: job.n, rows: rowsOf(job.counts) });
	} catch (e) {
		// A published manifest is never deleted for an error: publication retries until it completes (or a close or cancel stops it).
		if (e instanceof Fail && job.phase !== "publishing") return abandon(e.failure.message).catch(() => ({ ok: false as const, error: e.failure }));
		return fail("unavailable", `export step failed: ${(e as Error).message}`);
	}
}

/** Export ids of a store, oldest first, each with whether its manifest landed. */
async function exportsOf(env: Env, store: string): Promise<{ id: string; complete: boolean }[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.BACKUPS.list({ prefix: `exports/${store}/`, delimiter: "/", ...(cursor ? { cursor } : {}) });
		ids.push(...page.delimitedPrefixes.map((p) => p.slice(`exports/${store}/`.length, -1)));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	ids.sort();
	return Promise.all(ids.map(async (id) => ({ id, complete: (await env.BACKUPS.head(`exports/${store}/${id}/manifest.enc`)) !== null })));
}

/** Deletes every export older than the second newest complete one, complete or not. */
async function retain(env: Env, store: string): Promise<void> {
	const all = await exportsOf(env, store);
	const complete = all.filter((e) => e.complete);
	if (complete.length <= KEEP) return;
	const oldestKept = complete[complete.length - KEEP]!.id;
	for (const e of all.filter((x) => x.id < oldestKept)) await dropExportId(env, store, e.id);
}

/** Deletes one export of a store, complete or not. Only under `exports/<store>/<id>/`. */
export async function dropExportId(env: Env, store: string, id: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await env.BACKUPS.list({ prefix: `exports/${store}/${id}/`, ...(cursor ? { cursor } : {}) });
		if (page.objects.length) await env.BACKUPS.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

/** Deletes every export object of a store except export `keep`; returns the deleted export ids. Only under `exports/<store>/`. */
export async function dropExports(env: Env, store: string, keep: string | null): Promise<string[]> {
	const gone = (await exportsOf(env, store)).filter((e) => e.id !== keep).map((e) => e.id);
	for (const id of gone) await dropExportId(env, store, id);
	return gone;
}

/** Whether any export object of a store exists, complete or not. */
export const hasExports = async (env: Env, store: string) => (await env.BACKUPS.list({ prefix: `exports/${store}/`, limit: 1 })).objects.length > 0;

export async function listExports(env: Env, store: string): Promise<string[]> {
	return (await exportsOf(env, store)).filter((e) => e.complete).map((e) => e.id);
}

/** Reads and checks a complete export's manifest: `latest` is the newest complete one. */
export async function readManifest(env: Env, store: string, id: string, userId: string): Promise<Outcome<Manifest>> {
	try {
		if (id !== "latest" && !/^[0-9TZ]+-[0-9a-f]{8}$/.test(id)) return fail("validation", "unknown export id");
		const chosen = id === "latest" ? (await listExports(env, store)).at(-1) : id;
		if (!chosen) return fail("not_found", `no complete export of ${store}`);
		const mk = `exports/${store}/${chosen}/manifest.enc`, obj = await env.BACKUPS.get(mk);
		if (!obj) return fail("not_found", `export ${chosen} of ${store} has no manifest`);
		const m = JSON.parse(await unseal(await backupKey(env), mk, new Uint8Array(await obj.arrayBuffer()))) as Manifest;
		if ((m.version !== 1 && m.version !== 2) || m.id !== chosen || m.store !== store || m.userId !== userId) return fail("validation", "export manifest does not match this store");
		if (!m.chunks.every((c, i) => c.key === `exports/${store}/${chosen}/${String(i).padStart(5, "0")}.enc`)) return fail("validation", "export manifest names foreign chunks");
		return ok(m);
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		return fail("unavailable", `manifest read failed: ${(e as Error).message}`);
	}
}

/** Fetches, decrypts and verifies chunk `i` against the manifest. */
export async function readChunk(env: Env, m: Manifest, i: number): Promise<Chunk> {
	const ref = m.chunks[i]!, obj = await env.BACKUPS.get(ref.key);
	if (!obj) throw Fail.of("validation", `export chunk ${ref.key} is missing`);
	const plain = await unseal(await backupKey(env), ref.key, new Uint8Array(await obj.arrayBuffer()));
	if (sha256(plain) !== ref.sha256) throw Fail.of("validation", `export chunk ${ref.key} does not match its manifest hash`);
	const c = JSON.parse(plain) as Chunk;
	if (c.table !== ref.table || c.rows.length !== ref.rows) throw Fail.of("validation", `export chunk ${ref.key} does not match its manifest entry`);
	return c;
}

/** The budgeted transaction of the caller's store: counts physical rows (index and trigger rows too) and bound UTF-8 bytes, and throws past its caps. */
export interface Budget { run(query: string, ...params: SqlStorageValue[]): unknown; spent(share: number): boolean }

/**
 * Inserts at most `max` of a verified chunk's rows from `from`, inside the caller's budgeted transaction, stopping once half
 * the budget is spent so the next row has headroom. `done` counts rows whose statement succeeded, for the caller's retry after
 * an overflow. `adjust` may drop a row (null) or change values.
 */
export function applyRows(tx: Budget, c: Chunk, from: number, max: number, adjust: (table: string, columns: string[], row: unknown[]) => unknown[] | null,
	done: { n: number }, replace = false): number {
	if (!/^[a-z_][a-z0-9_]*$/.test(c.table) || !c.columns.every((n) => /^[a-z_][a-z0-9_]*$/.test(n))) throw Fail.of("validation", "export chunk names an invalid table or column");
	const stmt = `INSERT ${replace ? "OR REPLACE " : ""}INTO "${c.table}" (${c.columns.map((n) => `"${n}"`).join(", ")}) VALUES (${c.columns.map(() => "?").join(", ")})`;
	let i = from;
	for (; i < c.rows.length && i - from < max; i++) {
		if (i > from && tx.spent(0.5)) break;
		const r = adjust(c.table, c.columns, c.rows[i]!);
		if (r) tx.run(stmt, ...(r as SqlStorageValue[]));
		done.n++;
	}
	return i - from;
}
