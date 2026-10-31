import { assertCountImageOpen, unownedCountHistory, sealMovingPerson, countOrigin, countOriginClosed, closedTransferCounts, cleanupTransferredCounts, countSnapshot, foreignCommit, landCount, purgePersonCounts } from "./work-counts";
// A profile's part of a transfer (section 9). The source fences the node, packs its bundle into hashed parts, and after the
// target published, archives what moved and leaves a content-free tombstone. The target lands each part once, guards the
// materialized rows, and publishes. Every step is one transaction, idempotent, and bounded by the 1,000-row, 1 MB budget.
import { assertArchiveEndpoints } from "./archive-fence";
import { guardTexts, meGuard } from "../domain/guard";
import { sha256 } from "../domain/ids";
import { Fail, ok, type Failure, type Outcome } from "../domain/types";
import { nextSeq } from "../storage";
import { archiveRows, BudgetTx, purgeAfter, putRow, type ArchiveSource, type Row } from "./archive";
import { embeddingsOn, vectorId } from "./index";
import { flagProtected, mayChange } from "./protect";
import { assertNotWiped, assertOpen } from "./wipe";
import type { Who } from "./write";

/** An unfinished transfer is resumed by the source's alarm after this long (section 9, step 7). */
export const RESUME_MS = 5 * 60_000;
/** One part's estimated cost in the target; well inside the budget, leaving room for the step's own rows. */
const PART = { rows: 600, bytes: 600_000 };
/** Bounded commit and abort steps stop at this estimate. */
const STEP = { rows: 600, bytes: 600_000 };

export type Table = "nodes" | "texts" | "revisions" | "requests" | "edges" | "evidence" | "archive";
export type Entry = [Table, Row];

export type TransferStep =
	| { op: "fence"; id: string; nodeId: string; peer: string; companyFree?: boolean; protect?: boolean }
	| { op: "pack"; id: string }
	| { op: "part"; id: string; n: number }
	| { op: "sent"; id: string }
	| { op: "land"; id: string; from: string; nodeId: string; n: number; of: number; payload: string; sha256: string; bundle: string; revision: number; terms: string[]; companyFree?: boolean }
	| { op: "publish"; id: string; terms: string[] }
	| { op: "settle"; id: string }
	| { op: "commit"; id: string }
	| { op: "abort"; id: string; side: "out"; nodeId?: string; peer?: string }
	| { op: "abort"; id: string; side: "in"; nodeId: string; from: string }
	| { op: "status"; id: string };

export interface TransferOut {
	state: string; done?: boolean; parts?: number; sha256?: string; revision?: number; payload?: string; direction?: string;
	/** Internal: a vector to delete and an embedding to schedule after the transaction. Not returned over RPC. */
	vector?: string; embed?: boolean; companyFree?: boolean;
	/** publish into me only: the guard refused, durably, so the account may still abort (state "refused"). A protected fence refuses the same way. */
	error?: Failure;
}

/** Every string a bundle row carries, JSON columns decoded too: escaped unicode in an old snapshot is still copied content. */
export function bundleTexts(input: unknown): string[] {
	if (typeof input === "string") {
		try { return [input, ...guardTexts(JSON.parse(input))]; } catch { return [input]; }
	}
	if (Array.isArray(input)) return input.flatMap(bundleTexts);
	if (input && typeof input === "object") return Object.values(input).flatMap(bundleTexts);
	return [];
}

/** The fence, kept on the source node while it moves: who it goes to, its status before, the bound revision, then the bundle hash. */
interface Fence { id: string; to: string; status: string; revision: number; sha256?: string; activity?: number; companyFree?: boolean }
type TransferRow = { id: string; node_id: string; direction: "out" | "in"; peer: string; state: string; parts: number };

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
const transferRow = (sql: SqlStorage, id: string) => sql.exec<TransferRow>("SELECT id, node_id, direction, peer, state, parts FROM transfers WHERE id = ?", id).toArray()[0];
const nodeRow = (sql: SqlStorage, id: string) => sql.exec<Row>("SELECT * FROM nodes WHERE id = ?", id).toArray()[0];
const fenceOf = (n: Row | undefined) => n ? (JSON.parse(String(n.attrs)) as { transfer?: Fence }).transfer : undefined;
const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) => Fail.of("validation", message, { reason, ...details });
const MOVABLE = ["active", "retired", "superseded"];

function side(sql: SqlStorage, id: string, direction: "out" | "in"): TransferRow {
	const t = transferRow(sql, id);
	if (!t) throw Fail.of("not_found", `no transfer '${id}' in this profile`);
	if (t.direction !== direction) throw refuse("wrong_side", `transfer '${id}' is ${t.direction === "out" ? "leaving" : "arriving at"} this profile`);
	return t;
}

/**
 * Refuses a write to a node that is moving or still landing (section 9, step 2): the bundle must not change, and an incoming
 * record is invisible. For write.ts, before any change to the node, appends and links from it included.
 */
export function assertWritable(sql: SqlStorage, nodeId: string): void {
	const status = sql.exec<{ status: string }>("SELECT status FROM nodes WHERE id = ?", nodeId).toArray()[0]?.status;
	if (status === "moving" || status === "incoming") throw Fail.of("moving", "this record is being transferred between profiles; retry shortly", { retry_after: 30, memory_id: nodeId });
}

/** Source transfers left unfinished for five minutes, which the alarm resumes from the step they reached. */
export function dueTransfers(sql: SqlStorage, now = Date.now()): string[] {
	return sql.exec<{ id: string }>("SELECT id FROM transfers WHERE direction = 'out' AND state IN ('fenced','sent') AND updated_at <= ? ORDER BY updated_at",
		new Date(now - RESUME_MS).toISOString()).toArray().map((r) => r.id);
}

/** When the alarm should next look at unfinished transfers, or null if none. */
export function nextTransferAlarm(sql: SqlStorage): number | null {
	const at = sql.exec<{ at: string | null }>("SELECT min(updated_at) AS at FROM transfers WHERE direction = 'out' AND state IN ('fenced','sent')").one().at;
	return at ? Date.parse(at) + RESUME_MS : null;
}

/**
 * The bundle in a fixed order: the node as it was before the fence, every text chunk, revision and request record of it, its
 * outgoing edges with their evidence and the node's own evidence, and its archived texts, revisions, requests and edges.
 * Sequence stamps and local integer keys stay behind; the target stamps and keys its own rows. An edge keeps its id only to
 * carry its evidence. Archived edge ids are remapped separately from live edge ids.
 */
function bundle(sql: SqlStorage, nodeId: string): Entry[] {
	const strip = (r: Row, ...cols: string[]): Row => { const o = { ...r }; for (const c of ["seq", ...cols]) delete o[c]; return o; };
	const node = nodeRow(sql, nodeId)!;
	const { transfer, ...attrs } = JSON.parse(String(node.attrs)) as { transfer: Fence };
	const out: Entry[] = [["nodes", { ...strip(node, "embed_hash", "last_used_at"), status: transfer.status, attrs: JSON.stringify(attrs) }]];
	for (const t of sql.exec<Row>("SELECT * FROM texts WHERE node_id = ? ORDER BY rowid", nodeId)) out.push(["texts", strip(t, "rowid")]);
	for (const r of sql.exec<Row>("SELECT * FROM revisions WHERE node_id = ? ORDER BY revision", nodeId)) out.push(["revisions", strip(r)]);
	for (const q of sql.exec<Row>("SELECT * FROM requests WHERE node_id = ? ORDER BY request_id", nodeId)) out.push(["requests", strip(q)]);
	const edges = sql.exec<Row>("SELECT * FROM edges WHERE src = ? ORDER BY id", nodeId).toArray();
	for (const e of edges) { const count_state=countSnapshot(sql,e); out.push(["edges", {...strip(e),commit_seal:null,...(count_state?{count_state}:{})}]); }
	const owners = JSON.stringify([`n:${nodeId}`, ...edges.map((e) => `e:${String(e.id)}`)]);
	for (const v of sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, kind, ref", owners)) out.push(["evidence", strip(v)]);
	for (const a of sql.exec<Row>(`SELECT activity_id, source, payload, purge_after FROM archive a WHERE
		(source IN ('texts','revisions','requests') AND json_extract(payload, '$.node_id') = ?1)
		OR (source = 'edges' AND json_extract(payload, '$.src') = ?1)
		OR (source = 'evidence' AND (json_extract(payload, '$.owner') = 'n:' || ?1 OR EXISTS
			(SELECT 1 FROM archive e WHERE e.source = 'edges' AND e.activity_id = a.activity_id
			AND json_extract(e.payload, '$.src') = ?1 AND 'e:' || json_extract(e.payload, '$.id') = json_extract(a.payload, '$.owner'))))
		ORDER BY CASE source WHEN 'edges' THEN 0 WHEN 'evidence' THEN 1 ELSE 2 END, id`, nodeId)) {
		const image=a.source==='edges'?JSON.parse(String(a.payload)) as Row:undefined;
		const count_state=image?countSnapshot(sql,image):null;
		if(image){image.commit_seal=null;a.payload=JSON.stringify(image);}
		out.push(["archive",{...a,...(count_state?{count_state}:{})}]);
	}
	return out;
}

/** What landing one entry writes in the target (rowsWritten as measured for the import: a live text is 5, see domain/import-cost.ts). */
function cost([table, r]: Entry): { rows: number; bytes: number } {
	const live = table === "texts" && r.live === 1;
	const rows = { nodes: 12, texts: live ? 5 : 3, revisions: 2, requests: r.commit_meta ? 8 : 3, edges: 6, evidence: 3, archive: 3 }[table] + (r.count_state ? 16 : 0);
	return { rows, bytes: utf8(JSON.stringify(r)) + (live ? 2 * utf8(String(r.body)) : 0) };
}

/** Entries into parts in order, each within PART. A text chunk is at most 16,000 characters, so every entry fits a part. */
function split(entries: Entry[]): string[] {
	const parts: string[] = [];
	let cur: Entry[] = [], rows = 0, bytes = 0;
	for (const e of entries) {
		const c = cost(e);
		if (cur.length && (rows + c.rows > PART.rows || bytes + c.bytes > PART.bytes)) { parts.push(JSON.stringify(cur)); cur = []; rows = 0; bytes = 0; }
		cur.push(e); rows += c.rows; bytes += c.bytes;
	}
	parts.push(JSON.stringify(cur));
	return parts;
}

/** The longest prefix of rows whose estimated cost stays within one bounded step (at least one row). */
function fit(rows: Row[], each: (r: Row) => { rows: number; bytes: number }): Row[] {
	let n = 0, r = 0, b = 0;
	for (const row of rows) {
		const c = each(row);
		if (n && (r + c.rows > STEP.rows || b + c.bytes > STEP.bytes)) break;
		n++; r += c.rows; b += c.bytes;
	}
	return rows.slice(0, n);
}
// Archiving a text writes its archive row (row, two indexes) and deletes it (row, three indexes, two full-text deletes, tombstone).
const textCost = (r: Row) => ({ rows: 12, bytes: 3 * utf8(String(r.body)) + 400 });
const rowCost = (r: Row) => ({ rows: 10, bytes: 2 * utf8(JSON.stringify(r)) });

/** Converts a key or identity taken in this profile into the transfer's own collision error (section 9, step 4). */
function put(tx: BudgetTx, source: ArchiveSource, r: Row): number | undefined {
	try {
		return putRow(tx, source, r);
	} catch (e) {
		const taken = e instanceof Fail && e.failure.details?.reason === "key_taken";
		if (taken || (e instanceof Error && e.message.includes("import_pending"))) {
			throw Fail.of("transfer_collision", "this profile already holds a record with this id or identity; the owner chooses merge or rename", { reason: taken ? "key_taken" : "import_pending", source });
		}
		throw e;
	}
}

/** The target's ledger of applied parts: one row per part, holding the part hash and what later parts need from it. */
interface Ledger {
	countOrigins?:string[]; activity?: number; status?: string; edges?: Record<string, string>; bundle?: string; revision?: number }
function ledger(sql: SqlStorage, id: string): (Ledger & { n: number; sha256: string })[] {
	return sql.exec<{ n: number; payload: string; sha256: string }>("SELECT n, payload, sha256 FROM transfer_parts WHERE transfer_id = ? ORDER BY n", id).toArray()
		.map((r) => ({ ...(JSON.parse(r.payload) as Ledger), n: r.n, sha256: r.sha256 }));
}

/** The me guard over every copied field of the landed rows, with this profile's own guard terms read in this transaction. */
function guardLanded(sql: SqlStorage, nodeId: string, activity: number | undefined, terms: string[]): void {
	const node = nodeRow(sql, nodeId)!;
	if (node.kind === "person") throw Fail.of("me_sensitive_term", "me holds no person nodes", { term: "person" });
	const edges = sql.exec<Row>("SELECT * FROM edges WHERE src = ?", nodeId).toArray();
	const rows = [node, ...edges,
		...sql.exec<Row>("SELECT * FROM texts WHERE node_id = ?", nodeId).toArray(),
		...sql.exec<Row>("SELECT * FROM revisions WHERE node_id = ?", nodeId).toArray(),
		...sql.exec<Row>("SELECT * FROM requests WHERE node_id = ?", nodeId).toArray(),
		...sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?))", JSON.stringify([`n:${nodeId}`, ...edges.map((e) => `e:${String(e.id)}`)])).toArray(),
		...(activity !== undefined ? sql.exec<Row>("SELECT payload FROM archive WHERE activity_id = ?", activity).toArray() : [])];
	const stored = sql.exec<{ term: string }>("SELECT term FROM guard_terms").toArray().map((r) => r.term);
	const g = meGuard({ context: null, companyFree: true, texts: bundleTexts(rows), sensitiveTerms: [...terms, ...stored] });
	if (!g.ok) throw new Fail(g.error);
}

/** Lands one entry of a part. Every row must hang off the moving node. */
function landEntry(tx: BudgetTx, who: Who, s: Extract<TransferStep, { op: "land" }>, [table, r]: Entry, edges: Record<string, string>, activity: number): void {
	const mine = (ok: boolean) => { if (!ok) throw refuse("foreign_row", `a ${table} row of this bundle does not belong to record '${s.nodeId}'`); };
	switch (table) {
		case "nodes": {
			mine(r.id === s.nodeId);
			const there = tx.sql.exec<{ status: string }>("SELECT status FROM nodes WHERE id = ?", s.nodeId).toArray()[0];
			if (there && there.status !== "moved") throw Fail.of("transfer_collision", `profile '${who.profile}' already holds record '${s.nodeId}'`, { reason: "id_taken" });
			if (there) tx.run("DELETE FROM nodes WHERE id = ?", s.nodeId);
			// The first origin stays: provenance is set only where it is still empty.
			put(tx, "nodes", { ...r, attrs: who.profile === "me" && r.kind === "preference" && s.companyFree ? JSON.stringify({ ...JSON.parse(String(r.attrs)), company_free: true }) : r.attrs!, status: "incoming", embed_hash: null, source_profile: r.source_profile ?? s.from, source_id: r.source_id ?? s.nodeId, source_revision: r.source_revision ?? s.revision });
			return;
		}
		case "texts": case "revisions": case "requests":
			mine(r.node_id === s.nodeId);
			put(tx, table, table === "requests" && r.commit_meta ? {...r,commit_meta:foreignCommit(r.commit_meta)} : r);
			return;
		case "edges": {
			mine(r.src === s.nodeId);
			assertCountImageOpen(tx,r);
			const old = String(r.id);
			// '' means the edge's own profile: the source. A target in this profile becomes ''.
			const dst = r.dst_profile === "" ? s.from : r.dst_profile === who.profile ? "" : r.dst_profile;
			assertArchiveEndpoints(tx.sql,String(r.src),String(r.dst),String(dst),true);
			const {count_state,count_key,...plain}=r;plain.commit_seal=null;
			const id = put(tx, "edges", { ...plain, dst_profile: dst! });
			if(typeof count_state === "string"){
				tx.run("UPDATE edges SET count_key=? WHERE id=?",count_key!,id!);
				landCount(tx,r,tx.sql.exec<Row>("SELECT * FROM edges WHERE id=?",id!).one(),count_state,s.id,s.nodeId);
			}else if(count_key){
				if(!unownedCountHistory(r) && (r.weight!==0 || r.ended_at===null || typeof r.count_epoch!=="string"))throw refuse("foreign_row","a managed edge requires its accounting snapshot");
				tx.run("UPDATE edges SET count_key=? WHERE id=?",count_key,id!);
			}
			edges[`e:${old}`] = `e:${String(id)}`;
			return;
		}
		case "evidence": {
			const owner = edges[String(r.owner)] ?? String(r.owner);
			mine(owner === `n:${s.nodeId}` || Object.values(edges).includes(owner));
			put(tx, "evidence", { ...r, owner });
			return;
		}
		case "archive": {
			if (!["texts", "revisions", "requests", "edges", "evidence"].includes(String(r.source))) throw refuse("foreign_row", "an archived row of this bundle has an unknown source");
			const row = JSON.parse(String(r.payload)) as Row;
			const original={...row};
			if(r.source === "requests" && row.commit_meta)row.commit_meta=foreignCommit(row.commit_meta);
			if (r.source === "edges") {
				row.commit_seal=null;
				assertCountImageOpen(tx,row);
				mine(row.src === s.nodeId);
				const old = `a:${String(r.activity_id)}:e:${String(row.id)}`;
				// Negative ids reserve a distinct archived identity, including across later moves and restores.
				const next = Number(tx.sql.exec<{ n: number }>("SELECT min(id) AS n FROM (SELECT id FROM edges UNION ALL SELECT CAST(json_extract(payload, '$.id') AS INTEGER) FROM archive WHERE source = 'edges')").one().n ?? 0);
				row.id = Math.min(0, next) - 1;
				edges[old] = `e:${row.id}`;
				row.dst_profile = row.dst_profile === "" ? s.from : row.dst_profile === who.profile ? "" : row.dst_profile!;
				assertArchiveEndpoints(tx.sql,String(row.src),String(row.dst),String(row.dst_profile),true);
			} else if (r.source === "evidence") {
				const owner = edges[`a:${String(r.activity_id)}:${String(row.owner)}`] ?? String(row.owner);
				mine(owner === `n:${s.nodeId}` || Object.entries(edges).some(([k, v]) => k.startsWith("a:") && v === owner));
				row.owner = owner;
			} else mine(row.node_id === s.nodeId);
			const archive=Number(tx.run("INSERT INTO archive (activity_id, at, purge_after, source, payload, seq) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", activity, tx.now, r.purge_after!, r.source!, JSON.stringify(row), tx.seq).one().id);
			if(r.source === "edges" && typeof r.count_state === "string")landCount(tx,original,row,r.count_state,s.id,s.nodeId,archive);
			else if(r.source === "edges" && row.count_key && !unownedCountHistory(row) && (row.weight!==0 || row.ended_at===null || typeof row.count_epoch!=="string"))throw refuse("foreign_row","an archived managed edge requires its accounting snapshot");
			return;
		}
	}
	throw refuse("foreign_row", `unknown bundle table '${String(table)}'`);
}

function land(sql: SqlStorage, who: Who, s: Extract<TransferStep, { op: "land" }>): TransferOut {
	assertNotWiped(sql, s.nodeId);
	const t = transferRow(sql, s.id);
	if (t && t.direction !== "in") throw refuse("wrong_side", "a transfer cannot land in its own source");
	if (t?.state === "aborted") throw refuse("aborted", `transfer '${s.id}' was aborted here`);
	if (t && (t.node_id !== s.nodeId || t.peer !== s.from)) throw Fail.of("idempotency_mismatch", "transfer endpoint changed");
	if (t && t.state !== "sent") {
		const first = ledger(sql, s.id)[0];
		if (first && (first.bundle !== s.bundle || first.revision !== s.revision)) throw Fail.of("idempotency_mismatch", "transfer identity changed");
		return { state: t.state };
	}
	const parts = ledger(sql, s.id);
	const replay = parts.find((p) => p.n === s.n);
	if (replay) {
		if (replay.sha256 !== s.sha256) throw refuse("part_conflict", `part ${s.n} of transfer '${s.id}' was landed with other content`);
		return { state: "sent", parts: parts.length };
	}
	if (sha256(s.payload) !== s.sha256) throw refuse("part_hash", `part ${s.n} does not match its SHA-256`);
	if (!Number.isSafeInteger(s.of) || s.of < 1 || !Number.isSafeInteger(s.revision) || s.revision < 1 || !Number.isInteger(s.n) || s.n !== parts.length + 1 || s.n > s.of || (t && t.parts !== s.of)) throw refuse("part_order", `part ${s.n} of ${s.of} is out of order; ${parts.length} landed`);
	if (parts[0] && (parts[0].bundle !== s.bundle || parts[0].revision !== s.revision)) throw Fail.of("idempotency_mismatch", "transfer identity changed");
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	// A previous source retains its request history. Drain it in replayable steps before accepting part one.
	if (!parts.length && nodeRow(sql, s.nodeId)?.status === "moved") {
		if(!purgePersonCounts(tx,s.nodeId,who.profile))return {state:"cleaning",done:false};
		for (const q of ["DELETE FROM revisions WHERE (node_id, revision) IN (SELECT node_id, revision FROM revisions WHERE node_id = ? LIMIT 100)",
			"DELETE FROM requests WHERE request_id IN (SELECT request_id FROM requests WHERE node_id = ? LIMIT 100)"]) {
			const before = tx.rows;
			tx.run(q, s.nodeId);
			if (tx.rows > before) return { state: "cleaning", done: false };
		}
	}
	const meta: Ledger = {};
	if (!t) tx.run("INSERT INTO transfers (id, node_id, direction, peer, state, parts, created_at, updated_at, seq) VALUES (?, ?, 'in', ?, 'sent', ?, ?, ?, ?)", s.id, s.nodeId, s.from, s.of, tx.now, tx.now, tx.seq);
	const entries = JSON.parse(s.payload) as Entry[];
	// The part ledger keeps origin labels for wipe discovery even if the incoming node disappears.
	meta.countOrigins=[...new Set(entries.flatMap(([table,row])=>{
		const e=table==='edges'?row:table==='archive'&&row.source==='edges'?JSON.parse(String(row.payload)) as Row:undefined;
		const origin=e?countOrigin(e.count_key):null;return origin?[origin]:[];
	}))];
	if (s.n === 1) {
		if (entries[0]?.[0] !== "nodes") throw refuse("foreign_row", "the first part must start with the node");
		meta.status = String(entries[0][1].status);
		meta.activity = Number(tx.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'transfer', 'transfer_in', ?, ?, ?) RETURNING id",
			tx.now, `received 1 record from ${s.from}`, JSON.stringify([s.nodeId]), tx.seq).one().id);
	}
	const activity = meta.activity ?? parts[0]!.activity!;
	// Edge ids this profile had to renumber, from earlier parts, so evidence in this part follows its edge.
	const prior: Record<string, string> = Object.assign({}, ...parts.map((p) => p.edges ?? {}));
	const edges = { ...prior };
	for (const e of entries) landEntry(tx, who, s, e, edges, activity);
	const made = Object.entries(edges).filter(([k]) => !(k in prior));
	if (made.length) meta.edges = Object.fromEntries(made);
	meta.bundle = s.bundle; meta.revision = s.revision;
	tx.run("INSERT INTO transfer_parts (transfer_id, n, payload, sha256) VALUES (?, ?, ?, ?)", s.id, s.n, JSON.stringify(meta), s.sha256);
	if (s.n < s.of) {
		tx.run("UPDATE transfers SET updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
		return { state: "sent", parts: s.n };
	}
	// The last part: the whole record is materialized, so the target's own guard runs on exactly what would publish.
	const node = nodeRow(sql, s.nodeId);
	if (node?.status !== "incoming" || Number(node.revision) !== s.revision) throw refuse("bundle_incomplete", "the landed record is missing or not at the bound revision");
	if (sha256([...parts.map((p) => p.sha256), s.sha256].join("\n")) !== s.bundle) throw refuse("bundle_hash", "the bundle hash does not match its parts");
	if (who.profile === "me") guardLanded(sql, s.nodeId, activity, s.terms);
	const revision = s.revision + 1;
	// The transfer's immutable identity, which recovery matches against the source's fence (section 18).
	tx.run("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, ?, 'transferred_in', ?, 'transfer', ?, ?)", s.nodeId, revision,
		JSON.stringify({ memory_id: s.nodeId, status: parts[0]?.status ?? meta.status, _version: revision, content_hash: node.content_hash,
			transfer: { id: s.id, sha256: s.bundle, from: s.from, source_revision: s.revision } }), tx.now, tx.seq);
	tx.run("UPDATE nodes SET revision = ?, seq = ? WHERE id = ?", revision, tx.seq, s.nodeId);
	tx.run("UPDATE transfers SET state = 'landed', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
	return { state: "landed", parts: s.n };
}

/** Archives what moved, in bounded steps; the last step leaves the content-free tombstone (section 9, step 6). */
function commit(sql: SqlStorage, s: { id: string }): TransferOut {
	const t = side(sql, s.id, "out");
	if (t.state === "committed") return { state: t.state, done: true };
	if (t.state !== "sent") throw refuse("not_sent", `transfer '${s.id}' is ${t.state}; it commits only after the bundle was validated and sent`);
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	const node = nodeRow(sql, t.node_id)!;
	const f = fenceOf(node)!;
	if (f.activity === undefined) {
		f.activity = Number(tx.run("INSERT INTO activity (at, actor, op, summary, targets, seq) VALUES (?, 'transfer', 'transfer_out', ?, ?, ?) RETURNING id",
			tx.now, `moved 1 record to ${t.peer}`, JSON.stringify([t.node_id]), tx.seq).one().id);
		tx.run("UPDATE nodes SET attrs = json_set(attrs, '$.transfer.activity', ?), seq = ? WHERE id = ?", f.activity, tx.seq, t.node_id);
	}
	tx.run("UPDATE transfers SET updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
	if(node.kind === "person" && !sealMovingPerson(tx,t.node_id))return {state:t.state,done:false};
	const until = purgeAfter(tx.now);
	const texts = sql.exec<Row>("SELECT * FROM texts WHERE node_id = ? ORDER BY rowid LIMIT 200", t.node_id).toArray();
	if (texts.length) {
		archiveRows(tx, f.activity, "texts", fit(texts, textCost), until);
		return { state: t.state, done: false };
	}
	const edges = sql.exec<Row>("SELECT * FROM edges WHERE src = ? ORDER BY id LIMIT 100", t.node_id).toArray();
	const evidence = sql.exec<Row>("SELECT * FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) LIMIT 200",
		JSON.stringify([`n:${t.node_id}`, ...edges.map((e) => `e:${String(e.id)}`)])).toArray();
	if (evidence.length) {
		archiveRows(tx, f.activity, "evidence", fit(evidence, rowCost), until);
		return { state: t.state, done: false };
	}
	if (edges.length) {
		archiveRows(tx, f.activity, "edges", fit(edges, rowCost), until);
		return { state: t.state, done: false };
	}
	if (sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id = ? LIMIT 1", s.id).toArray().length) {
		tx.run("DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT transfer_id, n FROM transfer_parts WHERE transfer_id = ? LIMIT 100)", s.id);
		return { state: t.state, done: false };
	}
	if(!cleanupTransferredCounts(tx,s.id,false))return {state:t.state,done:false};
	const { transfer: _fence, ...attrs } = JSON.parse(String(node.attrs)) as { transfer: Fence };
	archiveRows(tx, f.activity, "nodes", [{ ...node, status: f.status, attrs: JSON.stringify(attrs) }], until);
	const identity = { id: s.id, sha256: f.sha256, revision: f.revision };
	const procedural = node.memory_type === "procedural";
	putRow(tx, "nodes", {
		id: t.node_id, kind: node.kind!, other_label: node.other_label!, key: null, memory_type: node.memory_type!, scope: node.scope!,
		name: "", norm_name: "", description: "", why: node.kind === "decision" ? "" : null, how_to_apply: null,
		objective: procedural ? "" : null, steps: procedural ? "[]" : null, attrs: JSON.stringify({ moved_to: t.peer, transfer: identity }),
		status: "moved", origin: node.origin!, pinned: 0, flagged: null, revision: f.revision + 1, chars: 0, content_hash: "", card_hash: "", embed_hash: "",
		recorded_at: node.recorded_at!, ended_at: tx.now, created_at: node.created_at!, updated_at: tx.now,
		source_profile: node.source_profile!, source_id: node.source_id!, source_revision: node.source_revision!,
		source_platform: node.source_platform!, updated_source_platform: node.updated_source_platform!,
	});
	tx.run("INSERT INTO revisions (node_id, revision, op, snapshot, actor, at, seq) VALUES (?, ?, 'moved', ?, 'transfer', ?, ?)", t.node_id, f.revision + 1,
		JSON.stringify({ memory_id: t.node_id, status: "moved", moved_to: t.peer, _version: f.revision + 1, transfer: identity }), tx.now, tx.seq);

	tx.run("UPDATE transfers SET state = 'committed', seq = ? WHERE id = ?", tx.seq, s.id);
	return { state: "committed", done: true, vector: t.node_id };
}

/** Undoes an unpublished landing in bounded steps; its durable part ledger owns archives even after the node is gone. */
function abortIn(sql: SqlStorage, s: Extract<TransferStep, { op: "abort"; side: "in" }>): TransferOut {
	const t = transferRow(sql, s.id);
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	if (!t) {
		// Recorded, so a late part is refused instead of landing after the abort.
		tx.run("INSERT INTO transfers (id, node_id, direction, peer, state, parts, created_at, updated_at, seq) VALUES (?, ?, 'in', ?, 'aborted', 0, ?, ?, ?)", s.id, s.nodeId, s.from, tx.now, tx.now, tx.seq);
		return { state: "aborted", done: cleanupTransferredCounts(tx,s.id,true) };
	}
	if (t.direction !== "in") throw refuse("wrong_side", `transfer '${s.id}' leaves this profile`);
	if (t.state === "aborted") return { state: t.state, done: cleanupTransferredCounts(tx,s.id,true) };
	if (t.state === "published" || t.state === "committed") throw refuse("published", `transfer '${s.id}' is already published here`);
	if(!cleanupTransferredCounts(tx,s.id,true))return {state:t.state,done:false};
	const node = nodeRow(sql, t.node_id);
	const activity = ledger(sql, s.id)[0]?.activity ?? -1;
	if (!node || node.status === "incoming") {
		const edges = sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ?", t.node_id).toArray().map((e) => `e:${e.id}`);
		const batches: [string, SqlStorageValue][] = [
			["DELETE FROM texts WHERE rowid IN (SELECT rowid FROM texts WHERE node_id = ? LIMIT 60)", t.node_id],
			["DELETE FROM revisions WHERE (node_id, revision) IN (SELECT node_id, revision FROM revisions WHERE node_id = ? LIMIT 200)", t.node_id],
			["DELETE FROM requests WHERE request_id IN (SELECT request_id FROM requests WHERE node_id = ? LIMIT 150)", t.node_id],
			["DELETE FROM evidence WHERE (owner, kind, ref) IN (SELECT owner, kind, ref FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) LIMIT 150)", JSON.stringify([`n:${t.node_id}`, ...edges])],
			["DELETE FROM edges WHERE id IN (SELECT id FROM edges WHERE src = ? LIMIT 100)", t.node_id],
		];
		for (const [q, p] of batches) {
			const before = tx.rows;
			tx.run(q, p);
			if (tx.rows > before) return { state: t.state, done: false };
		}
		tx.run("DELETE FROM nodes WHERE id = ? AND status = 'incoming'", t.node_id);
	}
	const beforeArchives=tx.rows;
	tx.run("DELETE FROM archive WHERE id IN (SELECT id FROM archive WHERE activity_id = ? LIMIT 200)",activity);
	if(tx.rows>beforeArchives)return {state:t.state,done:false};
	if (sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id = ? LIMIT 1", s.id).toArray().length) {
		tx.run("DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT transfer_id, n FROM transfer_parts WHERE transfer_id = ? LIMIT 100)", s.id);
		return { state: t.state, done: false };
	}
	tx.run("UPDATE transfers SET state = 'aborted', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
	return { state: "aborted", done: true };
}

/** Unfences the source: the node's status before the fence comes back and the parts go. Nothing was published. */
function abortOut(sql: SqlStorage, s: Extract<TransferStep, { op: "abort"; side: "out" }>): TransferOut {
	const t = transferRow(sql, s.id);
	if (!t) {
		// A paused driver must not establish its first fence after account abort cleanup has already finished.
		if (s.nodeId && s.peer) {
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			tx.run("INSERT INTO transfers (id, node_id, direction, peer, state, parts, created_at, updated_at, seq) VALUES (?, ?, 'out', ?, 'aborted', 0, ?, ?, ?)", s.id, s.nodeId, s.peer, tx.now, tx.now, tx.seq);
		}
		return { state: "aborted", done: true };
	}
	if (t.direction !== "out") throw refuse("wrong_side", `transfer '${s.id}' arrives at this profile`);
	if (t.state === "aborted") return { state: t.state, done: true };
	if (t.state === "committed") throw refuse("committed", `transfer '${s.id}' is already committed here`);
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	const f = fenceOf(nodeRow(sql, t.node_id));
	if (sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id = ? LIMIT 1", s.id).toArray().length) {
		tx.run("DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT transfer_id, n FROM transfer_parts WHERE transfer_id = ? LIMIT 100)", s.id);
		return { state: t.state, done: false };
	}
	if(!cleanupTransferredCounts(tx,s.id,false))return {state:t.state,done:false};
	if (f) tx.run("UPDATE nodes SET status = ?, attrs = json_remove(attrs, '$.transfer'), seq = ? WHERE id = ? AND status = 'moving'", f.status, tx.seq, t.node_id);
	tx.run("UPDATE transfers SET state = 'aborted', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
	return { state: "aborted", done: true };
}

/** Runs inside apply's transaction, including cleanup and retained archive/part lanes. */
function archiveExclusion(sql:SqlStorage,who:Who,s:TransferStep):void {
	if(s.op === "status" || s.op === "part")return;
	const terminal=transferRow(sql,s.id);
	if(terminal&&["committed","aborted"].includes(terminal.state)&&!sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id=? LIMIT 1",s.id).toArray().length)return;
	const nodeId=("nodeId" in s?s.nodeId:undefined)??transferRow(sql,s.id)?.node_id;
	if(nodeId) {
		assertArchiveEndpoints(sql,nodeId,nodeId,"",true);
		for(const e of sql.exec<Row>("SELECT src,dst,dst_profile,count_key FROM edges WHERE src=?1 OR (dst_profile='' AND dst=?1)",nodeId)){
			assertArchiveEndpoints(sql,String(e.src),String(e.dst),String(e.dst_profile),true);
			const origin=countOrigin(e.count_key);
			if(s.op === "fence" && !terminal && origin && countOriginClosed(sql,origin))throw Fail.of("moving","this node's observed-count origin is being wiped");
		}
		for(const a of sql.exec<{payload:string}>("SELECT payload FROM archive WHERE source='edges' AND (json_extract(payload,'$.src')=?1 OR (json_extract(payload,'$.dst_profile')='' AND json_extract(payload,'$.dst')=?1))",nodeId)){
			const e=JSON.parse(a.payload) as Row;assertArchiveEndpoints(sql,String(e.src),String(e.dst),String(e.dst_profile),true);
			const origin=countOrigin(e.count_key);
			if(s.op === "fence" && !terminal && origin && countOriginClosed(sql,origin))throw Fail.of("moving","this node's observed-count origin is being wiped");
		}
	}
	const payloads=s.op === "land"?[s.payload]:sql.exec<{payload:string}>("SELECT payload FROM transfer_parts WHERE transfer_id=?",s.id).toArray().map(p=>p.payload);
	for(const payload of payloads){const entries=JSON.parse(payload) as unknown;if(!Array.isArray(entries))continue;
		for(const [table,row] of entries as Entry[]){const e=table === "edges"?row:table === "archive"&&row.source === "edges"?JSON.parse(String(row.payload)) as Row:null;
			if(e){const dst=s.op === "land"?(e.dst_profile === ""?s.from:e.dst_profile === who.profile?"":String(e.dst_profile)):String(e.dst_profile);assertArchiveEndpoints(sql,String(e.src),String(e.dst),dst,true);}
		}
	}
}

function apply(sql: SqlStorage, who: Who, s: TransferStep): TransferOut {
	assertOpen(sql);
	archiveExclusion(sql,who,s);
	const id = "nodeId" in s ? s.nodeId : transferRow(sql, s.id)?.node_id;
	if (id) assertNotWiped(sql, id);
	switch (s.op) {
		case "fence": {
			const t = transferRow(sql, s.id);
			if (t) {
				if (t.direction !== "out" || t.node_id !== s.nodeId || t.peer !== s.peer) throw Fail.of("idempotency_mismatch", `transfer '${s.id}' was fenced with other arguments`);
				return { state: t.state, revision: fenceOf(nodeRow(sql, t.node_id))?.revision ?? 0 };
			}
			if (s.peer === who.profile) throw refuse("same_profile", "a transfer needs two different profiles");
			const n = nodeRow(sql, s.nodeId);
			if (!n) throw Fail.of("not_found", `no record '${s.nodeId}' in profile '${who.profile}'`);
			if (n.status === "moving" || n.status === "incoming") assertWritable(sql, s.nodeId);
			if (!MOVABLE.includes(String(n.status)) || n.other_label === "capture") throw refuse("not_movable", `a ${String(n.status)} ${n.other_label === "capture" ? "capture" : "record"} cannot be transferred`);
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			// A maintenance promotion is refused here, in the fencing transaction, if the owner stated or pinned the record since it
			// was accepted. The node stays put and is flagged once, which must commit, so this returns instead of throwing.
			const why = s.protect ? mayChange({ origin: String(n.origin), pinned: Number(n.pinned) }, "maintenance", who.profile) : null;
			if (why) {
				if (n.flagged !== `promote_to_me: ${why}`) flagProtected(tx, s.nodeId, why, "promote_to_me", "maintenance");
				return { state: "refused", error: { code: "protected", message: "the owner protected this record; it was flagged instead of moved", details: { reason: why, memory_id: s.nodeId } } };
			}
			const fence: Fence = { id: s.id, to: s.peer, status: String(n.status), revision: Number(n.revision), companyFree: s.companyFree };
			tx.run("UPDATE nodes SET status = 'moving', attrs = json_set(attrs, '$.transfer', json(?)), seq = ? WHERE id = ?", JSON.stringify(fence), tx.seq, s.nodeId);
			tx.run("INSERT INTO transfers (id, node_id, direction, peer, state, parts, created_at, updated_at, seq) VALUES (?, ?, 'out', ?, 'fenced', 0, ?, ?, ?)", s.id, s.nodeId, s.peer, tx.now, tx.now, tx.seq);
			return { state: "fenced", revision: fence.revision };
		}
		case "pack": {
			const t = side(sql, s.id, "out");
			if (t.state === "aborted") throw refuse("aborted", `transfer '${s.id}' was aborted`);
			const f = fenceOf(nodeRow(sql, t.node_id))!;
			if (t.parts) return { state: t.state, done: true, parts: t.parts, sha256: f.sha256!, revision: f.revision };
			if (t.state !== "fenced") throw refuse("not_fenced", `transfer '${s.id}' is ${t.state}`);
			const parts = split(bundle(sql, t.node_id));
			const have = sql.exec<{ n: number; sha256: string }>("SELECT n, sha256 FROM transfer_parts WHERE transfer_id = ? ORDER BY n", s.id).toArray();
			// The node is fenced, so a re-pack yields the same parts; anything else means the bundle changed under the fence.
			if (have.some((h) => parts[h.n - 1] === undefined || sha256(parts[h.n - 1]!) !== h.sha256)) throw refuse("bundle_changed", "the fenced record changed while it was packed");
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			for (let n = have.length + 1; n <= parts.length; n++) {
				const p = parts[n - 1]!;
				if (tx.spent(0.6) || (tx.bytes && tx.bytes + utf8(p) > 900_000)) break;
				tx.run("INSERT INTO transfer_parts (transfer_id, n, payload, sha256) VALUES (?, ?, ?, ?)", s.id, n, p, sha256(p));
				have.push({ n, sha256: sha256(p) });
			}
			tx.run("UPDATE transfers SET updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
			if (have.length < parts.length) return { state: t.state, done: false, parts: parts.length };
			const bundleSha = sha256(have.map((h) => h.sha256).join("\n"));
			tx.run("UPDATE nodes SET attrs = json_set(attrs, '$.transfer.sha256', ?), seq = ? WHERE id = ?", bundleSha, tx.seq, t.node_id);
			tx.run("UPDATE transfers SET parts = ?, seq = ? WHERE id = ?", parts.length, tx.seq, s.id);
			return { state: t.state, done: true, parts: parts.length, sha256: bundleSha, revision: f.revision };
		}
		case "part": {
			const t = side(sql, s.id, "out");
			const p = sql.exec<{ payload: string; sha256: string }>("SELECT payload, sha256 FROM transfer_parts WHERE transfer_id = ? AND n = ?", s.id, s.n).toArray()[0];
			if (!p) throw Fail.of("not_found", `transfer '${s.id}' has no part ${s.n}`);
			return { state: t.state, payload: p.payload, sha256: p.sha256 };
		}
		case "sent": {
			const t = side(sql, s.id, "out");
			if (t.state !== "fenced") return { state: t.state };
			if (!t.parts) throw refuse("not_packed", `transfer '${s.id}' is not packed yet`);
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			tx.run("UPDATE transfers SET state = 'sent', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
			return { state: "sent" };
		}
		case "land":
			return land(sql, who, s);
		case "publish": {
			const t = side(sql, s.id, "in");
			if (t.state === "published" || t.state === "committed") return { state: t.state };
			if (t.state !== "landed") throw refuse("not_landed", `transfer '${s.id}' is ${t.state}`);
			if(closedTransferCounts(sql,s.id) || !nodeRow(sql,t.node_id)){
				const tx=new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString());
				tx.run("UPDATE transfers SET state='sent',updated_at=?,seq=? WHERE id=?",tx.now,tx.seq,s.id);
				return {state:"refused",error:closedTransferCounts(sql,s.id)?{code:"profile_wiped",message:"an aggregate's source origin is being wiped"}:{code:"revision_conflict",message:"the incoming transfer node is missing"}};
			}
			if (who.profile === "me") {
				// The guard runs inside the publishing transaction, so a term registered since landing is seen (section 5). A refusal
				// un-lands the record, which no later publish or land can undo, and lets the account abort after its commit decision.
				try {
					guardLanded(sql, t.node_id, ledger(sql, s.id)[0]?.activity, s.terms);
				} catch (e) {
					if (!(e instanceof Fail)) throw e;
					const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
					tx.run("UPDATE transfers SET state = 'sent', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
					return { state: "refused", error: e.failure };
				}
			}
			const status = (JSON.parse(sql.exec<{ snapshot: string }>("SELECT snapshot FROM revisions WHERE node_id = ? AND op = 'transferred_in' ORDER BY revision DESC LIMIT 1", t.node_id).one().snapshot) as { status: string }).status;
			const n = nodeRow(sql, t.node_id)!;
			// Memories embed in this generation's namespace; an entity without a description never had a card to embed.
			const embeds = n.memory_type !== null || n.description !== "";
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			tx.run("UPDATE nodes SET status = ?, embed_hash = ?, seq = ? WHERE id = ? AND status = 'incoming'", status, embeds ? null : n.card_hash!, tx.seq, t.node_id);
			tx.run("UPDATE transfers SET state = 'published', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
			return { state: "published", embed: embeds && status === "active" };
		}
		case "settle": {
			const t = side(sql, s.id, "in");
			if (t.state === "committed") return { state: t.state, done: true };
			if (t.state !== "published") throw refuse("not_published", `transfer '${s.id}' is ${t.state}`);
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			if(!cleanupTransferredCounts(tx,s.id,false))return {state:t.state,done:false};
			if (sql.exec("SELECT 1 FROM transfer_parts WHERE transfer_id = ? LIMIT 1", s.id).toArray().length) {
		tx.run("DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT transfer_id, n FROM transfer_parts WHERE transfer_id = ? LIMIT 100)", s.id);
		return { state: t.state, done: false };
	}
			tx.run("UPDATE transfers SET state = 'committed', updated_at = ?, seq = ? WHERE id = ?", tx.now, tx.seq, s.id);
			return { state: "committed", done: true };
		}
		case "commit":
			return commit(sql, s);
		case "abort":
			return s.side === "in" ? abortIn(sql, s) : abortOut(sql, s);
		case "status": {
			const t = transferRow(sql, s.id);
			if (!t) return { state: "none" };
			if (t.direction === "out") {
				const f = fenceOf(nodeRow(sql, t.node_id));
				return { state: t.state, direction: "out", parts: t.parts, companyFree: f?.companyFree, ...(f?.id === s.id && f.sha256 ? { sha256: f.sha256, revision: f.revision } : {}) };
			}
			const snap = sql.exec<{ snapshot: string }>("SELECT snapshot FROM revisions WHERE node_id = ? AND op = 'transferred_in' ORDER BY revision DESC LIMIT 1", t.node_id).toArray()[0];
			const x = snap ? (JSON.parse(snap.snapshot) as { transfer?: { id: string; sha256: string; source_revision: number } }).transfer : undefined;
			return { state: t.state, direction: "in", parts: t.parts, ...(x?.id === s.id ? { sha256: x.sha256, revision: x.source_revision } : {}) };
		}
	}
}

/**
 * One transfer step in one transaction, then its I/O: the source's own vector goes at commit, a published memory is due for
 * embedding under this generation's ids, and a fence arms the resume alarm. ProfileStore.transfer calls this after bind(who).
 */
export async function transferStep(storage: DurableObjectStorage, env: Env, who: Who, step: TransferStep): Promise<Outcome<TransferOut>> {
	try {
		const { vector, embed, ...out } = storage.transactionSync(() => apply(storage.sql, who, step));
		// A vector left behind is filtered out of recall by status, so a failed delete costs nothing but space.
		if (vector && env.VECTORS) await env.VECTORS.deleteByIds([vectorId(who, vector)]).catch(() => undefined);
		const due = embed && embeddingsOn(env) ? Date.now() : out.state === "fenced" && step.op === "fence" ? Date.now() + RESUME_MS : undefined;
		if (due !== undefined) {
			const at = await storage.getAlarm();
			if (at === null || at > due) await storage.setAlarm(due);
		}
		return ok(out);
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		throw e;
	}
}
