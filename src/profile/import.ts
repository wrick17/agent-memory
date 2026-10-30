// The staged import of BothQ and Markdown records (architecture section 16, docs/import-implementation.md). Four steps,
// each one transaction in this profile: stage parts, prepare, publish, link. AccountStore binds the record's request ids
// between prepare and publish (api.ts). Until publish a record has no node row, so no read path can see its rows, and
// replay refuses its requests (write.ts).
import { canonicalJson, normalizeName, sha256 } from "../domain/ids";
import { attrsDigest, NODE_COLUMNS, nodeDigest, requestDigest, requestSource, revisionDigest, rowsDigest, storedNode, type RequestRow, type RevisionRow } from "../domain/import-audit";
import { IMPORT_BUDGET } from "../domain/import-cost";
import { Fail, MEMORY_KINDS, MEMORY_TYPES, type ReadQuery } from "../domain/types";
import { assertNotWiped, assertOpen } from "./wipe";
import { assertWritable } from "./transfer";
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
export interface Refresh { no: number; base_record_sha256: string }
export interface RefreshBase extends Refresh { base_revision: number; base_content_hash: string; body_revision?: number }
export type ImportStep =
	| { op: "stage"; record_id: string; record_sha256: string; part: number; parts: number; part_id: string; sha256: string; rows: { texts: ImportText[]; revisions: ImportRevision[]; requests: ImportRequest[] }; refresh?: Refresh }
	| FinalizeStep
	| { op: "link"; src: string; dst: string };
type FinalizeStep = { op: "prepare" | "publish"; record_id: string; record_sha256: string; node: ImportNode; parts: { part_id: string; sha256: string }[]; request_ids: string[]; refresh?: RefreshBase };
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

type RecordRow = { record_sha256: string; parts: number; state: "staging" | "prepared" | "published"; node_sha256: string | null; published_revision: number | null; published_content_hash: string | null; finalize_sha256?: string | null };
const recordOf = (sql: SqlStorage, id: string) => sql.exec<RecordRow>("SELECT * FROM import_records WHERE record_id = ?", id).toArray()[0];
const hasNode = (sql: SqlStorage, id: string) => sql.exec("SELECT 1 FROM nodes WHERE id = ?", id).toArray().length > 0;
type RecordStep = Exclude<ImportStep, { op: "link" }>;
const stagedId = (c: RecordStep) => c.refresh ? `${c.record_id}#r${c.refresh.no}` : c.record_id;
const ledger = (c: RecordStep) => c.refresh ? "import_refreshes" : "import_records";
const ledgerKey = (c: RecordStep) => c.refresh ? "shadow_id" : "record_id";
const stagedRecord = (sql: SqlStorage, c: RecordStep) => sql.exec<RecordRow>(`SELECT * FROM ${ledger(c)} WHERE ${ledgerKey(c)} = ?`, stagedId(c)).toArray()[0];
const finalizeHash = (c: FinalizeStep) => sha256(canonicalJson(c.refresh ? { node: c.node, refresh: c.refresh, parts: c.parts, request_ids: c.request_ids } : c.node));

function refreshAnchor(sql: SqlStorage, c: RecordStep): void {
	if (!c.refresh) return;
	const prev = c.refresh.no === 1 ? recordOf(sql, c.record_id) : sql.exec<RecordRow>("SELECT * FROM import_refreshes WHERE record_id = ? AND refresh_no = ?", c.record_id, c.refresh.no - 1).toArray()[0];
	if (prev?.state !== "published" || prev.record_sha256 !== c.refresh.base_record_sha256) throw refuse("base_changed", "finish the published base upload before refreshing this record");
	if (hasNode(sql, stagedId(c)) || recordOf(sql, stagedId(c))) throw refuse("identity_conflict", "the refresh shadow id is already in use");
}

function hostedBase(sql: SqlStorage, c: FinalizeStep): void {
	if (!c.refresh) return;
	const n = sql.exec<{ revision: number; content_hash: string; status: string }>("SELECT revision, content_hash, status FROM nodes WHERE id = ?", c.record_id).toArray()[0];
	const prev = c.refresh.no === 1 ? recordOf(sql, c.record_id) : sql.exec<RecordRow>("SELECT * FROM import_refreshes WHERE record_id = ? AND refresh_no = ?", c.record_id, c.refresh.no - 1).toArray()[0];
	if (!n || prev?.published_revision !== c.refresh.base_revision || prev.published_content_hash !== c.refresh.base_content_hash || n.revision !== c.refresh.base_revision || n.content_hash !== c.refresh.base_content_hash || !["active", "retired", "superseded"].includes(n.status)) throw refuse("hosted_changed", "the hosted copy changed since this import base; hold the refresh for review");
}

function stage(storage: DurableObjectStorage, c: Extract<ImportStep, { op: "stage" }>): ImportResult {
	const sql = storage.sql;
	const prior = sql.exec<{ sha256: string; rows_written: number; bytes: number }>("SELECT sha256, rows_written, bytes FROM import_parts WHERE part_id = ?", c.part_id).toArray()[0];
	if (prior) {
		if (prior.sha256 !== c.sha256) throw refuse("part_conflict", `part '${c.part_id}' was already staged with different content`);
		return { status: "replayed", rows_written: prior.rows_written, bytes: prior.bytes };
	}
	refreshAnchor(sql, c);
	const sid = stagedId(c);
	const rec = stagedRecord(sql, c);
	if (rec && (rec.record_sha256 !== c.record_sha256 || rec.parts !== c.parts)) {
		throw refuse("record_changed", `record '${c.record_id}' is already staged or imported with different content; a changed source needs the refresh path`);
	}
	if (rec && rec.state !== "staging") throw refuse("record_not_staging", `record '${c.record_id}' is ${rec.state}; it takes no more parts`);
	// Checked for every new part, not only the first: staged rows never attach to a node that exists before publication.
	if (hasNode(sql, sid)) throw refuse("record_exists", `a node '${sid}' already exists in this profile; the import never overwrites it`);
	for (const q of c.rows.requests) {
		if (sql.exec("SELECT 1 FROM requests WHERE request_id = ?", q.request_id).toArray().length) throw refuse("request_conflict", `request '${q.request_id}' already exists in this profile`);
	}
	const b = new Budget(sql);
	const seq = b.seq();
	const now = new Date().toISOString();
	for (const t of c.rows.texts) {
		b.run(`INSERT INTO texts (node_id, part, revision, seq_no, chunk, body, separator, request_id, actor, created_at, live, seq)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'migration', ?, ?, ?)`, sid, t.part, t.revision, t.seq_no, t.chunk, t.body, t.separator ?? null, t.request_id ?? null, t.created_at, t.live ? 1 : 0, seq);
		if (t.live) b.indexed(t.body);
	}
	for (const r of c.rows.revisions) {
		b.run(`INSERT INTO revisions (node_id, revision, op, snapshot, delta, request_id, actor, at, revision_id, content_hash, source_platform, source_platform_version, seq)
			VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, ?, ?, ?, ?, ?)`, sid, r.revision, r.op, r.snapshot, r.delta, r.request_id, r.at, r.revision_id, r.content_hash, r.source_platform, r.source_platform_version, seq);
	}
	for (const q of c.rows.requests) {
		// The original operation, BothQ hash and result, byte for byte; payload_hash holds the BothQ hash that replay compares.
		b.run(`INSERT INTO requests (request_id, op, payload_hash, result, node_id, at, seq, legacy_op, legacy_hash, completed_at, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, q.request_id, q.legacy_op, q.legacy_hash, q.result, sid, q.at, seq, q.legacy_op, q.legacy_hash, q.completed_at,
			requestSource(q));
	}
	if (c.refresh) b.run(`INSERT INTO import_refreshes (shadow_id, record_id, refresh_no, base_record_sha256, record_sha256, parts, state, staged_at, seq)
		VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, ?) ON CONFLICT (shadow_id) DO UPDATE SET seq = excluded.seq`, sid, c.record_id, c.refresh.no, c.refresh.base_record_sha256, c.record_sha256, c.parts, now, seq);
	else b.run(`INSERT INTO import_records (record_id, record_sha256, parts, state, staged_at, seq) VALUES (?, ?, ?, 'staging', ?, ?)
		ON CONFLICT (record_id) DO UPDATE SET seq = excluded.seq`, sid, c.record_sha256, c.parts, now, seq);
	b.run("INSERT INTO import_parts (part_id, record_id, part, sha256, rows_written, bytes, staged_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		c.part_id, sid, c.part, c.sha256, b.rows, b.bytes, now, seq);
	return { status: "stored", rows_written: b.rows, bytes: b.bytes };
}

/** Checks the staged parts and the node, then marks the record prepared. Returns the requests AccountStore must bind before publish. */
function prepare(storage: DurableObjectStorage, c: FinalizeStep): ImportResult {
	const sql = storage.sql;
	const sid = stagedId(c), rec = stagedRecord(sql, c);
	if (!rec) throw Fail.of("not_found", `no staged parts for record '${c.record_id}'`, { reason: "not_staged" });
	if (rec.record_sha256 !== c.record_sha256) throw refuse("record_changed", `record '${c.record_id}' was staged with different content`);
	const nodeSha = finalizeHash(c);
	const requests = sql.exec<{ request_id: string; op: string; hash: string }>("SELECT request_id, legacy_op AS op, legacy_hash AS hash FROM requests WHERE node_id = ? ORDER BY request_id", sid).toArray();
	if (rec.state === "published") return { status: "published", requests };
	refreshAnchor(sql, c);
	hostedBase(sql, c);
	if (rec.state === "prepared") {
		if ((c.refresh ? rec.finalize_sha256 : rec.node_sha256) !== nodeSha) throw refuse("node_changed", "the finalize command changed since this record was prepared");
		return { status: "prepared", requests };
	}
	const parts = sql.exec<{ part: number; part_id: string; sha256: string }>("SELECT part, part_id, sha256 FROM import_parts WHERE record_id = ? ORDER BY part", sid).toArray();
	if (parts.length !== rec.parts || parts.some((p, i) => p.part !== i + 1)) throw refuse("parts_missing", `record '${c.record_id}' has ${parts.length} of ${rec.parts} parts staged`);
	if (c.parts.length !== parts.length || c.parts.some((p, i) => p.part_id !== parts[i]!.part_id || p.sha256 !== parts[i]!.sha256)) throw refuse("parts_mismatch", "the finalize command lists other parts than were staged");
	if (c.node.id !== c.record_id) throw refuse("node_id", "the node id must be the record id");
	if (canonicalJson([...c.request_ids].sort()) !== canonicalJson(requests.map((r) => r.request_id))) throw refuse("requests_mismatch", "the finalize command lists other requests than were staged");
	if (c.refresh) validateDelta(sql, c);
	const b = new Budget(sql);
	if (c.refresh) b.run("UPDATE import_refreshes SET state = 'prepared', node_sha256 = ?, finalize_sha256 = ?, seq = ? WHERE shadow_id = ?", sha256(canonicalJson(c.node)), nodeSha, b.seq(), sid);
	else b.run("UPDATE import_records SET state = 'prepared', node_sha256 = ?, seq = ? WHERE record_id = ?", nodeSha, b.seq(), sid);
	return { status: "prepared", requests, rows_written: b.rows, bytes: b.bytes };
}

/** Validate before binding: only later history, contiguous entries, or the one synthetic adoption row may attach. */
function validateDelta(sql: SqlStorage, c: FinalizeStep): void {
	const r = c.refresh!, sid = stagedId(c);
	const revs = sql.exec<{ revision: number; op: string; content_hash: string | null }>("SELECT revision, op, content_hash FROM revisions WHERE node_id = ? ORDER BY revision", sid).toArray();
	const adopted = revs.find((x) => x.revision === r.base_revision);
	if (adopted) {
		const old = sql.exec<{ op: string; content_hash: string }>("SELECT op, content_hash FROM revisions WHERE node_id = ? AND revision = ?", c.record_id, r.base_revision).toArray()[0];
		if (old?.op !== "legacy_snapshot" || adopted.op !== "legacy_adopted" || adopted.content_hash !== old.content_hash) throw refuse("history_rewritten", "only the synthetic legacy snapshot may be replaced by its identical adoption");
	}
	if (revs.some((x) => x.revision < r.base_revision || (x.revision === r.base_revision && x !== adopted)) || (revs.at(-1)?.revision ?? r.base_revision) !== c.node.revision) throw refuse("history_rewritten", "refresh revisions must extend the base and end at the published revision");
	const seqs = sql.exec<{ seq_no: number }>("SELECT DISTINCT seq_no FROM texts WHERE node_id = ? AND part = 'entry' ORDER BY seq_no", sid).toArray();
	const top = sql.exec<{ n: number }>("SELECT coalesce(max(seq_no), 0) AS n FROM texts WHERE node_id = ? AND part = 'entry'", c.record_id).one().n;
	if (seqs.some((x, i) => x.seq_no !== top + i + 1)) throw refuse("entry_sequence", "refresh entry numbers must continue the base sequence");
	const texts = sql.exec<{ revision: number; part: string }>("SELECT revision, part FROM texts WHERE node_id = ?", sid).toArray();
	if (texts.some((x) => x.revision <= r.base_revision || (x.part === "body" && r.body_revision !== x.revision))) throw refuse("history_rewritten", "refresh text must belong to new revisions and body replacements must be explicit");
	if (r.body_revision !== undefined && (r.body_revision <= r.base_revision || r.body_revision > c.node.revision)) throw refuse("history_rewritten", "the replacement body must belong to this delta");
}

/** Writes the node row and its head, which makes the record and its requests visible in one transaction. */
function publish(storage: DurableObjectStorage, c: FinalizeStep): ImportResult {
	const sql = storage.sql;
	const rec = stagedRecord(sql, c);
	if (rec && rec.record_sha256 !== c.record_sha256) throw refuse("record_changed", "the refresh was staged with different content");
	if (rec?.state === "published") return { status: "replayed" };
	if (rec?.state !== "prepared") throw refuse("not_prepared", `record '${c.record_id}' is not prepared`);
	const n = c.node;
	if ((c.refresh ? rec.finalize_sha256 : rec.node_sha256) !== finalizeHash(c)) throw refuse("node_changed", "the finalize command changed since this record was prepared");
	refreshAnchor(sql, c);
	hostedBase(sql, c);
	if (!c.refresh && hasNode(sql, n.id)) throw refuse("record_exists", `a node '${n.id}' already exists in this profile`);
	const norm = normalizeName(n.name);
	// A hosted write may have taken this identity while the record was staged: the import refuses rather than replace it.
	if (n.status === "active" && sql.exec("SELECT 1 FROM nodes WHERE scope = ? AND memory_type = ? AND norm_name = ? AND status IN ('active','candidate','incoming','moving') AND id <> ?",
		n.scope, n.memory_type, norm, n.id).toArray().length) {
		throw refuse("identity_conflict", `an active ${n.memory_type} memory named '${n.name}' already exists in scope '${n.scope}'`);
	}
	const b = new Budget(sql);
	const seq = b.seq();
	const now = new Date().toISOString();
	if (c.refresh) {
		// Earlier content remains as history. No text or source revision is discarded by a body replacement.
		b.run("UPDATE texts SET live = 0, seq = ? WHERE node_id = ? AND live = 1 AND (part = 'head' OR (? IS NOT NULL AND part IN ('body','entry')))", seq, n.id, c.refresh.body_revision ?? null);
		const adoption = sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND revision = ? AND op = 'legacy_adopted'", stagedId(c), c.refresh.base_revision).toArray().length;
		if (adoption) b.run("DELETE FROM revisions WHERE node_id = ? AND revision = ? AND op = 'legacy_snapshot'", n.id, c.refresh.base_revision);
		for (const table of ["texts", "revisions", "requests"]) b.run(`UPDATE ${table} SET node_id = ?, seq = ? WHERE node_id = ?`, n.id, seq, stagedId(c));
	}
	const card = sha256(cardText({ kind: n.kind, name: n.name, description: n.description, why: n.why }, readPrefix(sql, n.id)));
	const embed = n.status === "active";
	b.run(`INSERT INTO nodes (id, kind, memory_type, scope, name, norm_name, description, why, how_to_apply, objective, steps, attrs, status, origin, revision, chars,
		content_hash, card_hash, embed_hash, valid_from, valid_to, recorded_at, ended_at, created_at, updated_at, source_platform, updated_source_platform, seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, memory_type = excluded.memory_type, scope = excluded.scope, name = excluded.name,
		norm_name = excluded.norm_name, description = excluded.description, why = excluded.why, how_to_apply = excluded.how_to_apply,
		objective = excluded.objective, steps = excluded.steps, attrs = excluded.attrs, status = excluded.status, revision = excluded.revision,
		chars = excluded.chars, content_hash = excluded.content_hash, card_hash = excluded.card_hash,
		embed_hash = CASE WHEN nodes.card_hash = excluded.card_hash THEN nodes.embed_hash ELSE excluded.embed_hash END,
		valid_from = excluded.valid_from, valid_to = excluded.valid_to, ended_at = excluded.ended_at, updated_at = excluded.updated_at,
		source_platform = excluded.source_platform, updated_source_platform = excluded.updated_source_platform, seq = excluded.seq`,
		n.id, n.kind, n.memory_type, n.scope, n.name, norm, n.description, n.why, n.how_to_apply, n.objective, n.steps ? JSON.stringify(n.steps) : null,
		JSON.stringify(n.attrs), n.status, n.revision, n.chars, n.content_hash, card, embed ? null : card, n.valid_from, n.valid_to, now,
		n.status === "active" ? null : (n.valid_to ?? now), n.created_at ?? now, n.updated_at ?? now, n.source_platform, n.updated_source_platform, seq);
	const node = sql.exec<NodeRow>("SELECT rowid, * FROM nodes WHERE id = ?", n.id).one();
	for (const [chunk, body] of chunks(headText(node, n.steps ?? [])).entries()) {
		b.run("INSERT INTO texts (node_id, part, revision, chunk, body, actor, created_at, seq) VALUES (?, 'head', ?, ?, ?, 'migration', ?, ?)", n.id, n.revision, chunk, body, now, seq);
		b.indexed(body);
	}
	b.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'migration', 'import', ?, ?, ?)", now, `imported ${n.kind} '${n.name}'`, JSON.stringify([n.id]), seq);
	b.run(`UPDATE ${ledger(c)} SET state = 'published', published_at = ?, published_revision = ?, published_content_hash = ?, seq = ? WHERE ${ledgerKey(c)} = ?`, now, n.revision, n.content_hash, seq, stagedId(c));
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

const REVISION_COLS = "revision, op, snapshot, delta, request_id, at, content_hash, revision_id, source_platform, source_platform_version";
const REQUEST_COLS = "request_id, legacy_op, legacy_hash, result, at, completed_at, source";
/** A summary page hashes at most this many revision and request rows; a larger record is listed paged, with counts only. */
const AUDIT_ROWS = 5000;
// Rows are hashed as the cursor yields them, so a page never holds more than one stored snapshot or result at a time.
const digests = <R, D>(rows: Iterable<R>, f: (r: R) => D) => { const out: D[] = []; for (const r of rows) out.push(f(r)); return out; };

/**
 * The read-only import audit (docs/import-integrity-design.md): digests and counts of the rows the import stored, each
 * record read in one synchronous pass, so no write interleaves with it. It never writes, binds, publishes or replays.
 */
export function audit(sql: SqlStorage, q: Extract<ReadQuery, { kind: "import_audit" }>) {
	const count = (query: string, ...params: SqlStorageValue[]) => sql.exec<{ n: number }>(query, ...params).one().n;
	if (q.record) {
		const rows = q.rows === "requests"
			? digests(sql.exec<RequestRow>(`SELECT ${REQUEST_COLS} FROM requests WHERE node_id = ? AND legacy_op IS NOT NULL AND request_id > ? ORDER BY request_id LIMIT ?`,
				q.record, q.after ?? "", q.limit), requestDigest)
			: digests(sql.exec<RevisionRow>(`SELECT ${REVISION_COLS} FROM revisions WHERE node_id = ? AND actor = 'migration' AND revision > ? ORDER BY revision LIMIT ?`,
				q.record, q.after === null ? -1 : Number(q.after), q.limit), revisionDigest);
		const last = rows.at(-1);
		return { record_id: q.record, node_revision: sql.exec<{ revision: number }>("SELECT revision FROM nodes WHERE id = ?", q.record).toArray()[0]?.revision ?? null,
			rows, next_after: rows.length === q.limit && last ? String("revision" in last ? last.revision : last.request_id) : null };
	}
	const records = sql.exec<{ record_id: string; state: string; record_sha256: string; node_sha256: string | null; published_at: string | null }>(
		`SELECT i.record_id, i.state, coalesce(f.record_sha256, i.record_sha256) AS record_sha256,
		coalesce(f.node_sha256, i.node_sha256) AS node_sha256, coalesce(f.published_at, i.published_at) AS published_at
		FROM import_records i LEFT JOIN import_refreshes f ON f.record_id = i.record_id AND f.refresh_no =
		(SELECT max(refresh_no) FROM import_refreshes WHERE record_id = i.record_id AND state = 'published')
		WHERE i.record_id > ? ORDER BY i.record_id LIMIT ?`, q.after ?? "", q.limit).toArray();
	const out = [];
	let read = 0;
	for (const r of records) {
		// Counted before any row is read: a page hashes at most AUDIT_ROWS rows. A record larger than that alone is listed with its
		// counts only, marked paged; the client reads its rows through the bounded detail pages.
		const size = count("SELECT (SELECT count(*) FROM revisions WHERE node_id = ?) + (SELECT count(*) FROM requests WHERE node_id = ?) AS n", r.record_id, r.record_id);
		const paged = size > AUDIT_ROWS;
		if (!paged && read + size > AUDIT_ROWS) break;
		if (!paged) read += size;
		const row = sql.exec(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, r.record_id).toArray()[0];
		const n = row && storedNode(row);
		// row_sha256 is the node as stored now; node_sha256 is the node as it was published.
		const node = n ? { revision: n.revision, content_hash: n.content_hash, status: n.status, kind: n.kind, memory_type: n.memory_type, created_at: n.created_at, updated_at: n.updated_at,
			row_sha256: nodeDigest(n), ...attrsDigest(n.attrs as Record<string, unknown>) } : null;
		if (paged) {
			const counted = (table: string, imported: string) => ({ count: count(`SELECT count(*) AS n FROM ${table} WHERE node_id = ? AND ${imported}`, r.record_id), sha256: null,
				hosted: count(`SELECT count(*) AS n FROM ${table} WHERE node_id = ? AND NOT (${imported})`, r.record_id) });
			out.push({ ...r, node, paged: true, revisions: counted("revisions", "actor = 'migration'"), requests: counted("requests", "legacy_op IS NOT NULL") });
			continue;
		}
		// Rows a later ordinary write added are counted as hosted, outside the digests of what the import stored.
		const revisions: ReturnType<typeof revisionDigest>[] = [], requests: ReturnType<typeof requestDigest>[] = [];
		let hostedRevisions = 0, hostedRequests = 0;
		for (const x of sql.exec<RevisionRow & { actor: string }>(`SELECT ${REVISION_COLS}, actor FROM revisions WHERE node_id = ?`, r.record_id)) {
			if (x.actor === "migration") revisions.push(revisionDigest(x)); else hostedRevisions++;
		}
		for (const x of sql.exec<RequestRow>(`SELECT ${REQUEST_COLS} FROM requests WHERE node_id = ?`, r.record_id)) {
			if (x.legacy_op !== null) requests.push(requestDigest(x)); else hostedRequests++;
		}
		out.push({ ...r, node, revisions: { count: revisions.length, sha256: rowsDigest(revisions), hosted: hostedRevisions },
			requests: { count: requests.length, sha256: rowsDigest(requests), hosted: hostedRequests } });
	}
	const more = out.length < records.length || records.length === q.limit;
	// Totals scan the whole profile, so only the first page carries them.
	const totals = q.after === null ? {
		records: Object.fromEntries(["staging", "prepared", "published"].map((s) => [s, count("SELECT count(*) AS n FROM import_records WHERE state = ?", s)])),
		revisions: count("SELECT count(*) AS n FROM revisions WHERE actor = 'migration'"), requests: count("SELECT count(*) AS n FROM requests WHERE legacy_op IS NOT NULL"),
	} : undefined;
	return { ...(totals ? { totals } : {}), records: out, next_after: more && out.length ? out.at(-1)!.record_id : null };
}

/** One import step in one transaction; a thrown Fail rolls all of it back. */
export function runImport(storage: DurableObjectStorage, c: ImportStep): ImportResult {
	return storage.transactionSync(() => {
		assertOpen(storage.sql);
		for (const id of c.op === "link" ? [c.src, c.dst] : [c.record_id]) {
			assertNotWiped(storage.sql, id);
			assertWritable(storage.sql, id);
		}
		if (c.op === "stage") return stage(storage, c);
		if (c.op === "link") return link(storage, c);
		return c.op === "prepare" ? prepare(storage, c) : publish(storage, c);
	});
}
