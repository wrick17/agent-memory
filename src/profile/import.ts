// The staged import of BothQ and Markdown records (architecture section 16, docs/import-implementation.md). Four steps,
// each one transaction in this profile: stage parts, prepare, publish, link. AccountStore binds the record's request ids
// between prepare and publish (api.ts). Until publish a record has no node row, so no read path can see its rows, and
// replay refuses its requests (write.ts).
import { canonicalJson, normalizeName, sha256 } from "../domain/ids";
import { IMPORT_BUDGET } from "../domain/import-cost";
import { Fail, MEMORY_KINDS, MEMORY_TYPES } from "../domain/types";
import { cardText, chunks, headText, readPrefix, type NodeRow } from "./write";


export interface ImportText { part: "body" | "entry"; revision: number; seq_no: number; chunk: number; body: string; separator?: string | null; request_id?: string | null; created_at: string; live: boolean }
export interface ImportRevision { revision: number; op: string; snapshot: string; delta: string | null; request_id: string | null; at: string; content_hash: string | null; revision_id: string | null; source_platform: string | null; source_platform_version: string | null }
export interface ImportRequest { request_id: string; legacy_op: string; legacy_hash: string; result: string; memory_id: string | null; at: string; completed_at: string | null; extra?: Record<string, unknown> }
export interface ImportNode {
	id: string; kind: (typeof MEMORY_KINDS)[number]; memory_type: (typeof MEMORY_TYPES)[number]; scope: string; name: string; description: string; why: string | null;
	how_to_apply: string | null; objective: string | null; steps: { order: number; action: string; success_criteria: string }[] | null; status: "active" | "retired" | "superseded";
	origin: "import"; revision: number; chars: number; content_hash: string; valid_from: string | null; valid_to: string | null; created_at: string | null; updated_at: string | null;
	source_platform: string | null; updated_source_platform: string | null; attrs: Record<string, unknown>;
}
export type ImportStep =
	| { op: "stage"; record_id: string; record_sha256: string; part: number; parts: number; part_id: string; sha256: string; rows: { texts: ImportText[]; revisions: ImportRevision[]; requests: ImportRequest[] } }
	| FinalizeStep
	| { op: "link"; src: string; dst: string };
type FinalizeStep = { op: "prepare" | "publish"; record_id: string; record_sha256: string; node: ImportNode; parts: { part_id: string; sha256: string }[]; request_ids: string[] };
export type ImportResult = { status: "stored" | "replayed" | "prepared" | "published" | "linked"; rows_written?: number; bytes?: number; requests?: { request_id: string; op: string; hash: string }[]; embed?: boolean };

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) => Fail.of("validation", message, { reason, ...details });

/** What one transaction actually writes: SQLite's rowsWritten (index and full-text rows included) and UTF-8 bytes. */
class Budget {
	rows = 0;
	bytes = 0;
	constructor(readonly sql: SqlStorage) {}
	run<T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]): T[] {
		const cursor = this.sql.exec<T>(query, ...params);
		const out = cursor.toArray();
		this.rows += cursor.rowsWritten;
		for (const p of params) if (typeof p === "string") this.bytes += utf8(p);
		this.check();
		return out;
	}
	/** A live text body is copied into the full-text and trigram indexes: twice its bytes again. */
	indexed(body: string): void {
		this.bytes += 2 * utf8(body);
		this.check();
	}
	seq(): number {
		return Number(this.run<{ value: string }>(`INSERT INTO profile_meta (key, value) VALUES ('write_seq', '1')
			ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value`)[0]!.value);
	}
	private check(): void {
		// A thrown Fail rolls the whole command back.
		if (this.rows > IMPORT_BUDGET.rows || this.bytes > IMPORT_BUDGET.bytes) {
			throw Fail.of("size_budget", `an import command may write at most 1,000 rows and 1,000,000 bytes; this one reached ${this.rows} rows and ${this.bytes} bytes`,
				{ reason: "size_budget", rows: this.rows, bytes: this.bytes });
		}
	}
}

type RecordRow = { record_sha256: string; parts: number; state: "staging" | "prepared" | "published"; node_sha256: string | null };
const recordOf = (sql: SqlStorage, id: string) => sql.exec<RecordRow>("SELECT record_sha256, parts, state, node_sha256 FROM import_records WHERE record_id = ?", id).toArray()[0];
const hasNode = (sql: SqlStorage, id: string) => sql.exec("SELECT 1 FROM nodes WHERE id = ?", id).toArray().length > 0;

function stage(storage: DurableObjectStorage, c: Extract<ImportStep, { op: "stage" }>): ImportResult {
	const sql = storage.sql;
	const prior = sql.exec<{ sha256: string; rows_written: number; bytes: number }>("SELECT sha256, rows_written, bytes FROM import_parts WHERE part_id = ?", c.part_id).toArray()[0];
	if (prior) {
		if (prior.sha256 !== c.sha256) throw refuse("part_conflict", `part '${c.part_id}' was already staged with different content`);
		return { status: "replayed", rows_written: prior.rows_written, bytes: prior.bytes };
	}
	const rec = recordOf(sql, c.record_id);
	if (rec && (rec.record_sha256 !== c.record_sha256 || rec.parts !== c.parts)) {
		throw refuse("record_changed", `record '${c.record_id}' is already staged or imported with different content; a changed source needs the refresh path`);
	}
	if (rec && rec.state !== "staging") throw refuse("record_not_staging", `record '${c.record_id}' is ${rec.state}; it takes no more parts`);
	// Checked for every new part, not only the first: staged rows never attach to a node that exists before publication.
	if (hasNode(sql, c.record_id)) throw refuse("record_exists", `a node '${c.record_id}' already exists in this profile; the import never overwrites it`);
	for (const q of c.rows.requests) {
		if (sql.exec("SELECT 1 FROM requests WHERE request_id = ?", q.request_id).toArray().length) throw refuse("request_conflict", `request '${q.request_id}' already exists in this profile`);
	}
	const b = new Budget(sql);
	const seq = b.seq();
	const now = new Date().toISOString();
	for (const t of c.rows.texts) {
		b.run(`INSERT INTO texts (node_id, part, revision, seq_no, chunk, body, separator, request_id, actor, created_at, live, seq)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'migration', ?, ?, ?)`, c.record_id, t.part, t.revision, t.seq_no, t.chunk, t.body, t.separator ?? null, t.request_id ?? null, t.created_at, t.live ? 1 : 0, seq);
		if (t.live) b.indexed(t.body);
	}
	for (const r of c.rows.revisions) {
		b.run(`INSERT INTO revisions (node_id, revision, op, snapshot, delta, request_id, actor, at, revision_id, content_hash, source_platform, source_platform_version, seq)
			VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, ?, ?, ?, ?, ?)`, c.record_id, r.revision, r.op, r.snapshot, r.delta, r.request_id, r.at, r.revision_id, r.content_hash, r.source_platform, r.source_platform_version, seq);
	}
	for (const q of c.rows.requests) {
		// The original operation, BothQ hash and result, byte for byte; payload_hash holds the BothQ hash that replay compares.
		b.run(`INSERT INTO requests (request_id, op, payload_hash, result, node_id, at, seq, legacy_op, legacy_hash, completed_at, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, q.request_id, q.legacy_op, q.legacy_hash, q.result, c.record_id, q.at, seq, q.legacy_op, q.legacy_hash, q.completed_at,
			canonicalJson({ ...(q.extra ? { extra: q.extra } : {}), memory_id: q.memory_id }));
	}
	b.run(`INSERT INTO import_records (record_id, record_sha256, parts, state, staged_at, seq) VALUES (?, ?, ?, 'staging', ?, ?)
		ON CONFLICT (record_id) DO UPDATE SET seq = excluded.seq`, c.record_id, c.record_sha256, c.parts, now, seq);
	b.run("INSERT INTO import_parts (part_id, record_id, part, sha256, rows_written, bytes, staged_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		c.part_id, c.record_id, c.part, c.sha256, b.rows, b.bytes, now, seq);
	return { status: "stored", rows_written: b.rows, bytes: b.bytes };
}

/** Checks the staged parts and the node, then marks the record prepared. Returns the requests AccountStore must bind before publish. */
function prepare(storage: DurableObjectStorage, c: FinalizeStep): ImportResult {
	const sql = storage.sql;
	const rec = recordOf(sql, c.record_id);
	if (!rec) throw Fail.of("not_found", `no staged parts for record '${c.record_id}'`, { reason: "not_staged" });
	if (rec.record_sha256 !== c.record_sha256) throw refuse("record_changed", `record '${c.record_id}' was staged with different content`);
	const nodeSha = sha256(canonicalJson(c.node));
	const requests = sql.exec<{ request_id: string; op: string; hash: string }>("SELECT request_id, legacy_op AS op, legacy_hash AS hash FROM requests WHERE node_id = ? ORDER BY request_id", c.record_id).toArray();
	if (rec.state === "published") return { status: "published", requests };
	if (rec.state === "prepared") {
		if (rec.node_sha256 !== nodeSha) throw refuse("node_changed", "the finalize command changed since this record was prepared");
		return { status: "prepared", requests };
	}
	const parts = sql.exec<{ part: number; part_id: string; sha256: string }>("SELECT part, part_id, sha256 FROM import_parts WHERE record_id = ? ORDER BY part", c.record_id).toArray();
	if (parts.length !== rec.parts || parts.some((p, i) => p.part !== i + 1)) throw refuse("parts_missing", `record '${c.record_id}' has ${parts.length} of ${rec.parts} parts staged`);
	if (c.parts.length !== parts.length || c.parts.some((p, i) => p.part_id !== parts[i]!.part_id || p.sha256 !== parts[i]!.sha256)) throw refuse("parts_mismatch", "the finalize command lists other parts than were staged");
	if (c.node.id !== c.record_id) throw refuse("node_id", "the node id must be the record id");
	if (canonicalJson([...c.request_ids].sort()) !== canonicalJson(requests.map((r) => r.request_id))) throw refuse("requests_mismatch", "the finalize command lists other requests than were staged");
	const b = new Budget(sql);
	b.run("UPDATE import_records SET state = 'prepared', node_sha256 = ?, seq = ? WHERE record_id = ?", nodeSha, b.seq(), c.record_id);
	return { status: "prepared", requests, rows_written: b.rows, bytes: b.bytes };
}

/** Writes the node row and its head, which makes the record and its requests visible in one transaction. */
function publish(storage: DurableObjectStorage, c: FinalizeStep): ImportResult {
	const sql = storage.sql;
	const rec = recordOf(sql, c.record_id);
	if (rec?.state === "published") return { status: "replayed" };
	if (rec?.state !== "prepared") throw refuse("not_prepared", `record '${c.record_id}' is not prepared`);
	const n = c.node;
	if (rec.node_sha256 !== sha256(canonicalJson(n))) throw refuse("node_changed", "the finalize command changed since this record was prepared");
	if (hasNode(sql, n.id)) throw refuse("record_exists", `a node '${n.id}' already exists in this profile`);
	const norm = normalizeName(n.name);
	// A hosted write may have taken this identity while the record was staged: the import refuses rather than replace it.
	if (n.status === "active" && sql.exec("SELECT 1 FROM nodes WHERE scope = ? AND memory_type = ? AND norm_name = ? AND status IN ('active','candidate','incoming','moving')",
		n.scope, n.memory_type, norm).toArray().length) {
		throw refuse("identity_conflict", `an active ${n.memory_type} memory named '${n.name}' already exists in scope '${n.scope}'`);
	}
	const b = new Budget(sql);
	const seq = b.seq();
	const now = new Date().toISOString();
	const card = sha256(cardText({ kind: n.kind, name: n.name, description: n.description, why: n.why }, readPrefix(sql, n.id)));
	const embed = n.status === "active";
	b.run(`INSERT INTO nodes (id, kind, memory_type, scope, name, norm_name, description, why, how_to_apply, objective, steps, attrs, status, origin, revision, chars,
		content_hash, card_hash, embed_hash, valid_from, valid_to, recorded_at, ended_at, created_at, updated_at, source_platform, updated_source_platform, seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		n.id, n.kind, n.memory_type, n.scope, n.name, norm, n.description, n.why, n.how_to_apply, n.objective, n.steps ? JSON.stringify(n.steps) : null,
		JSON.stringify(n.attrs), n.status, n.revision, n.chars, n.content_hash, card, embed ? null : card, n.valid_from, n.valid_to, now,
		n.status === "active" ? null : (n.valid_to ?? now), n.created_at ?? now, n.updated_at ?? now, n.source_platform, n.updated_source_platform, seq);
	const node = sql.exec<NodeRow>("SELECT rowid, * FROM nodes WHERE id = ?", n.id).one();
	for (const [chunk, body] of chunks(headText(node, n.steps ?? [])).entries()) {
		b.run("INSERT INTO texts (node_id, part, revision, chunk, body, actor, created_at, seq) VALUES (?, 'head', ?, ?, ?, 'migration', ?, ?)", n.id, n.revision, chunk, body, now, seq);
		b.indexed(body);
	}
	b.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'migration', 'import', ?, ?, ?)", now, `imported ${n.kind} '${n.name}'`, JSON.stringify([n.id]), seq);
	b.run("UPDATE import_records SET state = 'published', published_at = ?, seq = ? WHERE record_id = ?", now, seq, c.record_id);
	return { status: "published", rows_written: b.rows, bytes: b.bytes, embed };
}

/**
 * BothQ's supersession, as save_memory's `supersedes` writes it: between two different published memories of this profile,
 * of any kinds (BothQ lets a feedback rule replace a project decision). The same-kind rule is for judgment edges only.
 */
function link(storage: DurableObjectStorage, c: Extract<ImportStep, { op: "link" }>): ImportResult {
	const sql = storage.sql;
	const memory = (id: string) => sql.exec<{ kind: string; memory_type: string | null }>("SELECT kind, memory_type FROM nodes WHERE id = ?", id).toArray()[0];
	const src = memory(c.src), dst = memory(c.dst);
	if (!src || !dst) throw refuse("endpoint_unpublished", "both records of a supersession must be published in this profile first", { missing: !src ? c.src : c.dst });
	if (c.src === c.dst || src.memory_type === null || dst.memory_type === null) {
		throw refuse("invalid_endpoints", `supersedes joins two different memories, not ${src.kind} and ${dst.kind}`);
	}
	if (sql.exec("SELECT 1 FROM edges WHERE src = ? AND rel = 'supersedes' AND dst_profile = '' AND dst = ? AND ended_at IS NULL", c.src, c.dst).toArray().length) return { status: "replayed" };
	const b = new Budget(sql);
	b.run("INSERT INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, seq) VALUES (?, 'supersedes', ?, '', 'identifier', ?, 'migration', ?)", c.src, c.dst, new Date().toISOString(), b.seq());
	return { status: "linked", rows_written: b.rows, bytes: b.bytes };
}

/** One import step in one transaction; a thrown Fail rolls all of it back. */
export function runImport(storage: DurableObjectStorage, c: ImportStep): ImportResult {
	return storage.transactionSync(() => {
		if (c.op === "stage") return stage(storage, c);
		if (c.op === "link") return link(storage, c);
		return c.op === "prepare" ? prepare(storage, c) : publish(storage, c);
	});
}
