// Encrypted exports to R2 and restore from an export (section 18), first vertical. The export is the approved bounded
// write pause: the store blocks every other event while it snapshots, so the export is the store's exact state at `seq`.
// shortcut: whole-store pause, bounded by blockConcurrencyWhile's 30 s; upgrade to the total-key cursor export before a store outgrows it.
import { sha256 } from "./domain/ids";
import { Fail, fail, ok, type Outcome } from "./domain/types";

declare global { interface Env { BACKUP_KEY?: string } }

export const CHUNK_ROWS = 500;
export const CHUNK_BYTES = 512 * 1024;
export const KEEP = 2;

/** `rowid`: also export each rowid table's own rowid, for stores whose rows are keyed by it (the corpus families). */
export interface StoreSpec { store: string; userId: string; metaTable: string; control: readonly string[]; first?: readonly string[]; profile?: string; generation?: string; rowid?: boolean }
export interface ChunkRef { key: string; table: string; rows: number; sha256: string }
export interface Manifest {
	version: 1; id: string; store: string; userId: string; profile?: string; generation?: string;
	schema_version: number; seq: number; at: string; counts: Record<string, number>; chunks: ChunkRef[];
}
interface Chunk { table: string; columns: string[]; rows: unknown[][] }

const enc = new TextEncoder();
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
	const names = all.map((t) => t.name).filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && n !== "__miniflare_do_name" && n !== "deleted_rows"
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
					const size = JSON.stringify(row).length;
					if (rows.length && (rows.length >= CHUNK_ROWS || bytes + size > CHUNK_BYTES)) { await put({ table, columns, rows }); rows = []; bytes = 0; }
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
		await retain(env, spec.store);
		return ok({ id, seq, chunks: chunks.length, rows: Object.values(counts).reduce((a, b) => a + b, 0) });
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		return fail("unavailable", `export failed: ${(e as Error).message}`);
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
		if (m.version !== 1 || m.id !== chosen || m.store !== store || m.userId !== userId) return fail("validation", "export manifest does not match this store");
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
