// The one write path for phase 1: save (create, update, rename, scope move, retire, supersede) and append.
// Ports BothQ memory_store.py semantics. Runs inside one transactionSync per call; never awaits.
import { guardTexts, meGuard, stripPersonal } from "../domain/guard";
import { canonicalJson, collapse, isScope, newMemoryId, normalizeName, normalizeScope, sha256, uuid5 } from "../domain/ids";
import { Fail, KINDS_FOR_TYPE, RELATION_ENDPOINTS, type AppendArgs, type CandidateArgs, type CaptureArgs, type KnowledgeArgs, type OwnerArgs, type KnowledgeRef, type MemoryKind, type MemoryType, type SaveArgs, type Step, type WriteCommand, type WriteContext } from "../domain/types";
import { takeSeq } from "../storage";
import { compact, contentRows, Unfold, unfoldStep } from "./compact";
import { archiveNode, purgeAfter } from "./archive";
import { linkIdentifiers, resolveMentions, type Consumed } from "./extract";
import { sizeLevel } from "./housekeeping";
import { flagProtected, mayChange } from "./protect";
import { assertWritable } from "./transfer";
import { beforeImages, recordUndo, restore, revert } from "./undo";
import { assertNotWiped, assertOpen } from "./wipe";
import { upload, uploadIds, uploadKey } from "./work-upload";

export interface Who { userId: string; profile: string; generation: string }

export type NodeRow = {
	rowid: number; id: string; kind: string; memory_type: MemoryType | null; scope: string; name: string; norm_name: string;
	description: string; why: string | null; how_to_apply: string | null; objective: string | null; steps: string | null;
	status: string; origin: string; pinned: number; revision: number; chars: number; content_hash: string; card_hash: string;
	embed_hash: string | null; valid_from: string | null; valid_to: string | null; created_at: string; updated_at: string;
	source_platform: string | null; updated_source_platform: string | null; attrs: string;
};

export interface WriteOutput { result: Record<string, unknown>; created: string[]; embedDue: boolean }

export const CHUNK = 16_000;
export const NOTE_MAX = 64_000;
export const APPEND_MAX = 100_000;
const MAX_ROWS = 1_000;
const MAX_BYTES = 1_000_000;
const TEXT_FIELDS = ["description", "content", "why", "how_to_apply", "objective"] as const;
/** The actors protection applies to (section 12). */
const BACKGROUND: string[] = ["keep", "index", "maintenance"];

/**
 * Counts what one transaction writes, as Workers SQLite reports it per statement (rowsWritten: the row, its index entries
 * and its full-text rows, final once exec returns), plus the UTF-8 bytes of its parameters; refuses past 1,000 rows or
 * 1 MB, which rolls the whole write back (sections 5 and 6). `guard` checks material a write takes from elsewhere (an
 * undo's restored rows) against the me guard inside this transaction; outside me it does nothing.
 */
export class Tx {
	rows = 0;
	bytes = 0;
	/** Mention rows this write resolved, for its undo (extract.ts). */
	consumed: Consumed[] = [];
	constructor(readonly sql: SqlStorage, readonly seq: number, readonly now: string, readonly ctx: WriteContext, readonly requestId: string | null,
		readonly guard: (material: unknown) => void = () => {}) {}
	run(query: string, ...params: SqlStorageValue[]): SqlStorageCursor<Record<string, SqlStorageValue>> {
		if (params.length > 100) throw Fail.of("size_budget", "one statement may bind at most 100 parameters");
		const cursor = this.sql.exec(query, ...params);
		this.rows += cursor.rowsWritten;
		for (const p of params) if (typeof p === "string") this.bytes += Buffer.byteLength(p, "utf8");
		// A statement still open (an unread RETURNING cursor) cannot be rolled back: finish it before refusing.
		try { this.check(); } catch (e) { cursor.toArray(); throw e; }
		return cursor;
	}
	/** Rows this write took outside run(), such as its sequence number. */
	charge(rows: number): void {
		this.rows += rows;
		this.check();
	}
	/** Before one statement that changes many rows: refuse at once if even one row each would pass the bound. Its real rows count when it runs. */
	touch(rows: number): void {
		if (this.rows + rows > MAX_ROWS) throw Fail.of("size_budget", "one write may touch at most 1,000 rows and 1 MB (UTF-8)");
	}
	private check(): void {
		// A thrown Fail rolls the whole transaction back.
		if (this.rows > MAX_ROWS || this.bytes > MAX_BYTES) throw Fail.of("size_budget", "one write may touch at most 1,000 rows and 1 MB (UTF-8)");
	}
}

export function readNode(sql: SqlStorage, id: string): NodeRow | undefined {
	return sql.exec<NodeRow>("SELECT rowid, * FROM nodes WHERE id = ?", id).toArray()[0];
}

export const knowledgeId = (who: Who, n: Pick<NonNullable<KnowledgeArgs["nodes"]>[number], "kind" | "key" | "name" | "scope">) => uuid5(n.key ? `${who.userId}:${who.profile}:${n.kind}:${n.key}` : `${who.userId}:${who.profile}:${n.kind}:${n.scope !== undefined ? scopeOf(n.scope) : "default"}:${normalizeName(n.name)}`);

/** Candidate identities for the account's permanent wipe ledger, before dispatch into a generation. */
export function writeIds(who: Who, cmd: WriteCommand): string[] {
	if (cmd.op === "knowledge") return (cmd.args.nodes ?? []).map((n) => knowledgeId(who, n));
	if (cmd.op === "upload") return uploadIds(who, cmd.args);
	const a = cmd.args as SaveArgs;
	return [...(a.memory_id ? [a.memory_id] : []), ...(a.name && a.type ? [newMemoryId(who.userId, who.profile, a.scope !== undefined ? scopeOf(a.scope) : "default", a.type, a.name)] : [])];
}

/** BothQ _find: by memory_id, or by name narrowed by type and scope. Names match case-insensitively on the normalized name. */
export function findNode(sql: SqlStorage, ident: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }, activeOnly: boolean): NodeRow {
	const status = activeOnly ? " AND status = 'active'" : " AND status IN ('active','retired','superseded','moved')";
	let rows: NodeRow[];
	if (ident.memory_id) {
		rows = sql.exec<NodeRow>(`SELECT rowid, * FROM nodes WHERE id = ? AND memory_type IS NOT NULL${status}`, ident.memory_id).toArray();
		if (ident.type) rows = rows.filter((r) => r.memory_type === ident.type);
	} else {
		if (!ident.name?.trim()) throw Fail.of("validation", "memory_id or name is required", { reason: "missing_identity" });
		const scope = ident.scope !== undefined ? scopeOf(ident.scope) : undefined;
		rows = sql.exec<NodeRow>(`SELECT rowid, * FROM nodes WHERE norm_name = ? AND memory_type IS NOT NULL${status}`, normalizeName(ident.name)).toArray()
			.filter((r) => (!ident.type || r.memory_type === ident.type) && (scope === undefined || r.scope === scope));
	}
	if (!rows.length) {
		// A record that is moving or still landing answers moving, not not_found (section 9, step 2).
		if (activeOnly) {
			const held = ident.memory_id ? [ident.memory_id] : sql.exec<{ id: string }>("SELECT id FROM nodes WHERE norm_name = ? AND memory_type IS NOT NULL AND status IN ('moving','incoming')", normalizeName(ident.name!)).toArray().map((r) => r.id);
			for (const id of held) assertWritable(sql, id);
		}
		const what = ident.memory_id ? `id '${ident.memory_id}'` : `name '${ident.name}'`;
		throw Fail.of("not_found", `no ${activeOnly ? "active " : ""}memory found with ${what}`);
	}
	if (rows.length > 1) {
		throw Fail.of("ambiguous", `memory name '${ident.name}' matches ${rows.length} nodes; pass memory_id or narrow with type and scope`,
			{ reason: "ambiguous_name", matches: rows.map((r) => ({ memory_id: r.id, type: r.memory_type, scope: r.scope })) });
	}
	return rows[0]!;
}

function scopeOf(value: string): string {
	try {
		return normalizeScope(value);
	} catch (e) {
		throw Fail.of("validation", (e as Error).message, { reason: "invalid_scope" });
	}
}

/** BothQ _steps: non-empty, positive unique integer orders, non-empty action and success_criteria, sorted. */
export function validateSteps(value: unknown): Step[] {
	if (!Array.isArray(value) || !value.length) throw Fail.of("validation", "steps must be a non-empty list", { reason: "invalid_steps" });
	const orders = new Set<number>();
	const steps = value.map((step: unknown, i) => {
		if (!step || typeof step !== "object" || Array.isArray(step)) throw Fail.of("validation", `step ${i} must be an object`, { reason: "invalid_steps" });
		const { order, action, success_criteria: criteria } = step as Record<string, unknown>;
		if (typeof order !== "number" || !Number.isInteger(order) || order < 1) throw Fail.of("validation", `step ${i} order must be a positive integer`, { reason: "invalid_steps" });
		if (orders.has(order)) throw Fail.of("validation", `duplicate step order ${order}`, { reason: "invalid_steps" });
		if (typeof action !== "string" || !action.trim() || typeof criteria !== "string" || !criteria.trim()) {
			throw Fail.of("validation", `step ${i} needs action and success_criteria`, { reason: "invalid_steps" });
		}
		orders.add(order);
		return { order, action: action.trim(), success_criteria: criteria.trim() };
	});
	return steps.sort((a, b) => a.order - b.order);
}

const synthesise = (objective: string, steps: Step[]) => `${objective}\n${steps.map((s) => `${s.order}. ${s.action}`).join("\n")}`;

/** BothQ content_hash over content_source(), so a saved record hashes exactly as BothQ would hash it. */
export function contentHash(f: { name: string; type: string; description?: string | null; content?: string | null; why?: string | null; how_to_apply?: string | null; objective?: string | null; steps?: Step[] }): string {
	return sha256(canonicalJson({
		name: f.name, type: f.type, description: f.description ?? "", content: f.content ?? "", why: f.why ?? "",
		how_to_apply: f.how_to_apply ?? "", objective: f.objective ?? "", steps: f.steps ?? [],
	}));
}

/** Appends chain the hash, so an append costs the same on a large journal as on an empty one. */
const chainHash = (previous: string, separator: string, entry: string) => sha256(`${previous}\n${sha256(separator + entry)}`);

/** A card is the kind, name, description, why, and the first 1,200 characters of the body (section 11). */
export function cardText(n: { kind: string; name: string; description: string; why: string | null }, body: string): string {
	return [`${n.kind}: ${n.name}`, n.description, n.why ?? "", body.slice(0, CARD_PREFIX)].filter(Boolean).join("\n");
}

export const headText = (n: { name: string; description: string; why: string | null; how_to_apply: string | null; objective: string | null }, steps: Step[]) =>
	[n.name, n.description, n.why, n.how_to_apply, n.objective, ...steps.map((s) => `${s.order}. ${s.action} (${s.success_criteria})`)].filter(Boolean).join("\n");

export const chunks = (text: string) => {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
	return out.length ? out : [""];
};

export function writeHead(tx: Tx, n: NodeRow, steps: Step[], revision: number): void {
	tx.run("DELETE FROM texts WHERE node_id = ? AND part = 'head'", n.id);
	chunks(headText(n, steps)).forEach((body, chunk) => tx.run(
		"INSERT INTO texts (node_id, part, revision, chunk, body, actor, created_at, seq) VALUES (?, 'head', ?, ?, ?, ?, ?, ?)",
		n.id, revision, chunk, body, tx.ctx.actor, tx.now, tx.seq));
}

/**
 * Replaces the whole content. The earlier body leaves (tombstoned); its text is in the previous revision snapshot.
 * Earlier appends are the only copy of their deltas, so they stay as history: no longer live, which takes them out of
 * current content and both search indexes, and stamped with this write's seq.
 */
function writeBody(tx: Tx, id: string, content: string, revision: number, requestId: string | null): void {
	tx.run("DELETE FROM texts WHERE node_id = ? AND part = 'body'", id);
	tx.run("UPDATE texts SET live = 0, seq = ? WHERE node_id = ? AND part = 'summary' AND live = 1", tx.seq, id);
	tx.touch(Number(tx.sql.exec<{ n: number }>("SELECT count(*) AS n FROM texts WHERE node_id = ? AND part = 'entry' AND live <> 0 AND seq_no > COALESCE((SELECT json_extract(attrs, '$.compacted_through') FROM nodes WHERE id = ?), 0)", id, id).one().n));
	tx.run("UPDATE texts SET live = 0, seq = ? WHERE node_id = ? AND part = 'entry' AND live <> 0 AND seq_no > COALESCE((SELECT json_extract(attrs, '$.compacted_through') FROM nodes WHERE id = ?), 0)", tx.seq, id, id);
	if (!content) return;
	chunks(content).forEach((body, chunk) => tx.run(
		"INSERT INTO texts (node_id, part, revision, chunk, body, request_id, actor, created_at, seq) VALUES (?, 'body', ?, ?, ?, ?, ?, ?, ?)",
		id, revision, chunk, body, requestId, tx.ctx.actor, tx.now, tx.seq));
}

export const CARD_PREFIX = 1200;

/** The first `max` characters of the current content (body, then live entries), reading only the rows it needs. */
export function readPrefix(sql: SqlStorage, id: string, max = CARD_PREFIX): string {
	let out = "";
	for (const r of contentRows(sql, id)) {
		out += (r.chunk === 0 && r.separator ? r.separator : "") + r.body;
		if (out.length >= max) break;
	}
	return out.slice(0, max);
}

/** The full content in order: body chunks, then each entry with the separator it was appended with. */
export function readContent(sql: SqlStorage, id: string): string {
	return contentRows(sql, id).toArray().map((r) => (r.chunk === 0 && r.separator ? r.separator : "") + r.body).join("");
}

function stepsOf(n: NodeRow): Step[] {
	return n.steps ? (JSON.parse(n.steps) as Step[]) : [];
}

export function snapshot(n: NodeRow, content: string | undefined, sql: SqlStorage): string {
	return JSON.stringify({
		memory_id: n.id, name: n.name, memory_type: n.memory_type, kind: n.kind, scope: n.scope, description: n.description,
		...(content !== undefined ? { content } : { content_unchanged: true }),
		why: n.why ?? "", how_to_apply: n.how_to_apply ?? "", objective: n.objective ?? "", status: n.status, origin: n.origin,
		_version: n.revision, _valid_from: n.valid_from, _valid_until: n.valid_to, _created: n.created_at, _updated: n.updated_at,
		_source_platform: n.source_platform, _updated_source_platform: n.updated_source_platform,
		steps: stepsOf(n), relationships: relationships(sql, n), content_hash: n.content_hash,
	});
}

export function relationships(sql: SqlStorage, n: { id: string; scope: string }) {
	const ids = (q: string) => sql.exec<{ id: string }>(q, n.id).toArray().map((r) => r.id);
	return {
		belongs_to: n.scope,
		supersedes: ids("SELECT dst AS id FROM edges WHERE src = ? AND rel = 'supersedes' AND ended_at IS NULL ORDER BY id"),
		superseded_by: ids("SELECT src AS id FROM edges WHERE dst = ? AND rel = 'supersedes' AND ended_at IS NULL ORDER BY id"),
		migrated_from: [] as string[],
	};
}

export function writeRevision(tx: Tx, n: NodeRow, op: string, content: string | undefined): void {
	tx.run("INSERT INTO revisions (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		n.id, n.revision, op, snapshot(n, content, tx.sql), tx.requestId, tx.ctx.actor, tx.ctx.deviceId ?? null, tx.now, tx.seq);
}

export function activity(tx: Tx, op: string, summary: string, targets: string[]): number {
	return Number(tx.run("INSERT INTO activity (at, actor, device_id, op, summary, targets, seq) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
		tx.now, tx.ctx.actor, tx.ctx.deviceId ?? null, op, summary, JSON.stringify(targets), tx.seq).one().id);
}

export function result(n: NodeRow, action: string, extra: Record<string, unknown>): Record<string, unknown> {
	return { ok: true, action, memory_id: n.id, name: n.name, type: n.memory_type, kind: n.kind, scope: n.scope, revision: n.revision, content_hash: n.content_hash, ...extra };
}

function expectRevision(expected: number | undefined, actual: number): void {
	if (expected !== undefined && expected !== actual) {
		throw Fail.of("revision_conflict", `expected revision ${expected}, found ${actual}`, { expected_revision: expected, actual_revision: actual });
	}
}

/** BothQ _supersede: each id must be an active memory of this profile; it becomes superseded with a snapshot and an edge. */
function supersede(tx: Tx, newId: string, refs: string | string[] | undefined): string[] {
	if (refs === undefined) return [];
	const list = typeof refs === "string" ? [refs] : refs;
	if (!list.length || list.some((r) => typeof r !== "string" || !r)) {
		throw Fail.of("validation", "supersedes must be a memory_id or non-empty list of memory_ids", { reason: "invalid_supersedes" });
	}
	const done: string[] = [];
	for (const id of [...new Set(list)]) {
		if (id === newId) throw Fail.of("validation", "a memory cannot supersede itself", { reason: "self_supersedes" });
		const prior = findNode(tx.sql, { memory_id: id }, true);
		tx.run("UPDATE nodes SET status = 'superseded', revision = revision + 1, valid_to = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?",
			tx.now, tx.now, tx.ctx.platform, tx.seq, id);
		tx.run(`INSERT OR IGNORE INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, request_id, seq)
			VALUES (?, 'supersedes', ?, '', 'identifier', ?, ?, ?, ?)`, newId, prior.id, tx.now, tx.ctx.actor, tx.requestId, tx.seq);
		writeRevision(tx, readNode(tx.sql, id)!, "superseded", undefined);
		done.push(id);
	}
	return done;
}

function create(tx: Tx, who: Who, a: SaveArgs, scope: string): WriteOutput {
	const name = collapse(a.name ?? "");
	if (!name) throw Fail.of("validation", "name must be a non-empty string", { reason: "invalid_name" });
	if (!a.type) throw Fail.of("validation", "type must be one of feedback, project, reference, user, procedural", { reason: "invalid_type" });
	if (typeof a.description !== "string") throw Fail.of("validation", "description must be a string", { reason: "invalid_description" });
	if (a.expected_revision !== undefined && a.expected_revision !== 0) {
		throw Fail.of("revision_conflict", `expected revision ${a.expected_revision}, found 0`, { expected_revision: a.expected_revision, actual_revision: 0 });
	}
	const kind = kindFor(a.type, a.kind, a.why);
	let steps: Step[] = [];
	let content = a.content ?? "";
	let objective = a.objective ?? null;
	if (a.type === "procedural") {
		if (!objective?.trim()) throw Fail.of("validation", "objective is required for procedural memories", { reason: "missing_objective" });
		steps = validateSteps(a.steps);
		objective = objective.trim();
		content = synthesise(objective, steps);
	} else if (a.steps !== undefined) {
		throw Fail.of("validation", "steps are only valid for procedural memories", { reason: "steps_not_supported" });
	}
	// Section 12: background actors never state for the owner, and an inference always carries its evidence.
	if (a.origin === "stated" && BACKGROUND.includes(tx.ctx.actor)) throw Fail.of("forbidden", "a background actor cannot record a stated memory", { reason: "background_stated" });
	if (a.origin === "inferred" && !a.evidence?.length) throw Fail.of("validation", "an inferred memory needs at least one evidence pointer", { reason: "missing_evidence" });
	if (kind === "decision" && !a.evidence?.length) throw Fail.of("validation", "a decision needs at least one evidence pointer", { reason: "missing_evidence" });
	const id = newMemoryId(who.userId, who.profile, scope, a.type, name);
	assertNotWiped(tx.sql, id);
	if (readNode(tx.sql, id)) throw Fail.of("already_exists", `memory identity '${id}' already exists`, { memory_id: id });
	const fields = { name, type: a.type, description: a.description, content, why: a.why, how_to_apply: a.how_to_apply, objective, steps };
	const hash = contentHash(fields);
	const card = sha256(cardText({ kind, name, description: a.description, why: a.why ?? null }, content));
	tx.run(`INSERT INTO nodes (id, kind, memory_type, scope, name, norm_name, description, why, how_to_apply, objective, steps, status, origin,
		revision, chars, content_hash, card_hash, valid_from, recorded_at, created_at, updated_at, source_platform, updated_source_platform, seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, kind, a.type, scope, name, normalizeName(name), a.description, a.why ?? null, a.how_to_apply ?? null, objective,
		a.type === "procedural" ? JSON.stringify(steps) : null, a.origin ?? "agent", content.length, hash, card,
		tx.now, tx.now, tx.now, tx.now, tx.ctx.platform, tx.ctx.platform, tx.seq);
	const node = readNode(tx.sql, id)!;
	writeHead(tx, node, steps, 1);
	writeBody(tx, id, content, 1, tx.requestId);
	if (a.evidence?.length) addEvidence(tx, `n:${id}`, a.evidence);
	// Before identifier links, so a mention of the same target never takes the agent's reason (a current edge is matched).
	const links = saveLinks(tx, id, a.links);
	linkIdentifiers(tx, id, [name, a.description, content, a.why ?? "", a.how_to_apply ?? ""].join("\n"));
	const superseded = supersede(tx, id, a.supersedes);
	writeRevision(tx, node, "saved", content);
	const activityId = activity(tx, "save", `created ${kind} '${name}'`, [id, ...superseded]);
	return { result: result(node, "created", { superseded, activity_id: activityId, ...links }), created: [id], embedDue: true };
}

/** `type` picks the kind: feedback to rule, user to preference, procedural and reference to document, project to decision when it has a why, else journal. */
function kindFor(type: MemoryType, kind: MemoryKind | undefined, why: string | undefined): MemoryKind {
	const allowed = KINDS_FOR_TYPE[type];
	if (kind && !allowed.includes(kind)) throw Fail.of("validation", `kind '${kind}' does not fit type '${type}'; use ${allowed.join(" or ")}`, { reason: "invalid_kind" });
	const chosen = kind ?? (type === "project" ? (why?.trim() ? "decision" : "journal") : allowed[0]!);
	if (chosen === "decision" && !why?.trim()) throw Fail.of("validation", "a decision needs why", { reason: "missing_why" });
	return chosen;
}

function update(tx: Tx, a: SaveArgs, lookup: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }): WriteOutput {
	const node = findNode(tx.sql, lookup, true);
	const changed = [...TEXT_FIELDS, "steps", "scope", "new_name"].filter((f) => (a as Record<string, unknown>)[f] !== undefined);
	if (!changed.length && a.supersedes === undefined && !a.evidence && !a.links) throw Fail.of("validation", "update needs at least one changed field", { reason: "no_changes" });
	if (a.kind && a.kind !== node.kind) throw Fail.of("validation", "kind cannot change on an existing memory", { reason: "invalid_kind" });
	expectRevision(a.expected_revision, node.revision);
	const type = node.memory_type!;
	let steps = stepsOf(node);
	if (a.steps !== undefined) {
		if (type !== "procedural") throw Fail.of("validation", "steps are only valid for procedural memories", { reason: "steps_not_supported" });
		steps = validateSteps(a.steps);
	}
	const next = {
		name: a.new_name !== undefined ? collapse(a.new_name) : node.name,
		scope: a.scope !== undefined ? scopeOf(a.scope) : node.scope,
		description: a.description ?? node.description,
		why: a.why ?? node.why, how_to_apply: a.how_to_apply ?? node.how_to_apply, objective: a.objective ?? node.objective,
	};
	if (!next.name) throw Fail.of("validation", "name must be a non-empty string", { reason: "invalid_name" });
	if (node.kind === "decision" && !next.why?.trim()) throw Fail.of("validation", "a decision needs why", { reason: "missing_why" });
	// Supplied evidence adds to the node's own; a decision that would still have none (an imported one, say) is refused, never filled in.
	if (node.kind === "decision" && !a.evidence?.length && !tx.sql.exec("SELECT 1 FROM evidence WHERE owner = ? LIMIT 1", `n:${node.id}`).toArray().length) {
		throw Fail.of("validation", "a decision needs at least one evidence pointer; pass evidence", { reason: "missing_evidence" });
	}
	let content: string | undefined = a.content;
	if (type === "procedural") {
		if (!next.objective?.trim()) throw Fail.of("validation", "objective is required for procedural memories", { reason: "missing_objective" });
		if (a.steps !== undefined || a.objective !== undefined) content = synthesise(next.objective, steps);
	}
	const identityMoved = next.scope !== node.scope || normalizeName(next.name) !== node.norm_name;
	if (identityMoved && tx.sql.exec("SELECT 1 FROM nodes WHERE scope = ? AND memory_type = ? AND norm_name = ? AND status = 'active' AND id <> ?",
		next.scope, type, normalizeName(next.name), node.id).toArray().length) {
		throw Fail.of("already_exists", `an active ${type} memory named '${next.name}' already exists`);
	}
	if (!changed.length) {
		// Evidence and links add rows around the node, as record_knowledge does; the node keeps its revision.
		if (a.evidence?.length) addEvidence(tx, `n:${node.id}`, a.evidence);
		const links = saveLinks(tx, node.id, a.links);
		const superseded = supersede(tx, node.id, a.supersedes);
		const activityId = a.evidence || a.links ? activity(tx, "update", `added evidence or links to ${node.kind} '${node.name}'`, [node.id, ...superseded])
			: activity(tx, "supersede", `superseded ${superseded.length} records with '${node.name}'`, [node.id, ...superseded]);
		return { result: result(node, "updated", { superseded, activity_id: activityId, ...links }), created: [], embedDue: false };
	}
	const body = content ?? readContent(tx.sql, node.id);
	const revision = node.revision + 1;
	const hash = contentHash({ ...next, type, content: body, steps });
	const card = sha256(cardText({ kind: node.kind, name: next.name, description: next.description, why: next.why }, body.slice(0, CARD_PREFIX)));
	tx.run(`UPDATE nodes SET name = ?, norm_name = ?, scope = ?, description = ?, why = ?, how_to_apply = ?, objective = ?, steps = ?,
		revision = ?, chars = ?, content_hash = ?, card_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?`,
		next.name, normalizeName(next.name), next.scope, next.description, next.why, next.how_to_apply, next.objective,
		type === "procedural" ? JSON.stringify(steps) : null, revision, body.length, hash, card, tx.now, tx.ctx.platform, tx.seq, node.id);
	const updated = readNode(tx.sql, node.id)!;
	writeHead(tx, updated, steps, revision);
	if (content !== undefined) writeBody(tx, node.id, content, revision, tx.requestId);
	if (a.evidence?.length) addEvidence(tx, `n:${node.id}`, a.evidence);
	const links = saveLinks(tx, node.id, a.links);
	linkIdentifiers(tx, node.id, [next.name, next.description, content ?? "", next.why ?? "", next.how_to_apply ?? ""].join("\n"));
	const superseded = supersede(tx, node.id, a.supersedes);
	writeRevision(tx, updated, "updated", body);
	const activityId = activity(tx, "update", `updated ${node.kind} '${updated.name}'`, [node.id, ...superseded]);
	return { result: result(updated, "updated", { superseded, activity_id: activityId, ...links }), created: [], embedDue: card !== node.card_hash };
}

function retire(tx: Tx, a: SaveArgs, lookup: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }): WriteOutput {
	const extra = [...TEXT_FIELDS, "steps", "new_name", "supersedes", "evidence", "links"].filter((f) => (a as Record<string, unknown>)[f] !== undefined);
	if (extra.length) throw Fail.of("validation", `retire takes no other changes (${extra.join(", ")})`, { reason: "invalid_arguments" });
	const node = findNode(tx.sql, lookup, true);
	expectRevision(a.expected_revision, node.revision);
	tx.run("UPDATE nodes SET status = 'retired', revision = revision + 1, valid_to = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?",
		tx.now, tx.now, tx.ctx.platform, tx.seq, node.id);
	const retired = readNode(tx.sql, node.id)!;
	writeRevision(tx, retired, "retired", undefined);
	const activityId = activity(tx, "retire", `retired ${node.kind} '${node.name}'`, [node.id]);
	return { result: result(retired, "retired", { activity_id: activityId }), created: [], embedDue: false };
}

export function save(tx: Tx, who: Who, a: SaveArgs): WriteOutput {
	for (const f of TEXT_FIELDS) {
		if (a[f] !== undefined && typeof a[f] !== "string") throw Fail.of("validation", `${f} must be a string`, { reason: "invalid_field", field: f });
	}
	if (a.content !== undefined && a.content.length > NOTE_MAX) throw Fail.of("size_budget", `content may hold at most ${NOTE_MAX} characters; use append_memory for journals`);
	if (a.scope !== undefined && !isScope(a.scope)) scopeOf(a.scope);
	const lookupScope = a.from_scope ?? (a.retire ? a.scope : undefined);
	const lookup = { ...(a.memory_id ? { memory_id: a.memory_id } : { name: a.name }), ...(lookupScope !== undefined ? { scope: lookupScope } : {}), ...(a.type ? { type: a.type } : {}) };
	if (a.compact !== undefined) return compact(tx, a, findNode(tx.sql, lookup, true));
	if (a.retire) return retire(tx, a, lookup);
	if (a.memory_id || a.from_scope !== undefined || a.new_name !== undefined) return update(tx, a, lookup);
	const scope = scopeOf(a.scope ?? "default");
	if (a.name && a.type) {
		const existing = tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE scope = ? AND memory_type = ? AND norm_name = ? AND status = 'active'",
			scope, a.type, normalizeName(a.name)).toArray()[0];
		if (existing) {
			// BothQ routes a save with expected_revision on an existing identity to update.
			if (a.expected_revision !== undefined) return update(tx, { ...a, scope: undefined }, { memory_id: existing.id });
			throw Fail.of("already_exists", `an active ${a.type} memory named '${collapse(a.name)}' already exists`, { memory_id: existing.id });
		}
	}
	return create(tx, who, a, scope);
}

export function append(tx: Tx, a: AppendArgs): WriteOutput {
	if (typeof a.content !== "string" || !a.content) throw Fail.of("validation", "append requires a non-empty entry", { reason: "invalid_entry" });
	if (a.content.length > APPEND_MAX) throw Fail.of("size_budget", `an append may hold at most ${APPEND_MAX} characters`);
	const separator = a.separator ?? "\n";
	if (typeof separator !== "string") throw Fail.of("validation", "separator must be a string", { reason: "invalid_separator" });
	const node = findNode(tx.sql, { ...(a.memory_id ? { memory_id: a.memory_id } : { name: a.name }), ...(a.scope !== undefined ? { scope: a.scope } : {}), ...(a.type ? { type: a.type } : {}) }, true);
	if (node.memory_type === "procedural") throw Fail.of("validation", "append is not supported for procedural memories", { reason: "append_not_supported" });
	expectRevision(a.expected_revision, node.revision);
	const used = node.chars > 0 ? separator : "";
	const revision = node.revision + 1;
	const entrySeq = Number(tx.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq_no), 0) + 1 AS n FROM texts WHERE node_id = ? AND part = 'entry'", node.id).one().n);
	chunks(a.content).forEach((body, chunk) => tx.run(
		"INSERT INTO texts (node_id, part, revision, seq_no, chunk, body, separator, request_id, actor, created_at, seq) VALUES (?, 'entry', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		node.id, revision, entrySeq, chunk, body, chunk === 0 ? used : null, a.request_id, tx.ctx.actor, tx.now, tx.seq));
	const hash = chainHash(node.content_hash, used, a.content);
	// The card covers the first 1,200 characters of the content, so only an append that lands inside them changes it.
	const card = node.chars < CARD_PREFIX ? sha256(cardText(node, readPrefix(tx.sql, node.id))) : node.card_hash;
	tx.run("UPDATE nodes SET revision = ?, chars = chars + ?, content_hash = ?, card_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?",
		revision, used.length + a.content.length, hash, card, tx.now, tx.ctx.platform, tx.seq, node.id);
	linkIdentifiers(tx, node.id, a.content);
	const appended = readNode(tx.sql, node.id)!;
	const activityId = activity(tx, "append", `appended entry ${entrySeq} to '${node.name}'`, [node.id]);
	return { result: result(appended, "appended", { entry_seq: entrySeq, activity_id: activityId }), created: [], embedDue: card !== node.card_hash };
}

const CONTENT_ARGS = ["content", "description", "why", "how_to_apply", "objective", "steps", "new_name", "from_scope", "evidence", "links"];
/** A save that only retires an existing record: what a full profile still accepts. */
const shrinks = (cmd: WriteCommand) => cmd.op === "save" && (typeof cmd.args.memory_id === "string" || typeof cmd.args.name === "string")
	&& (cmd.args.retire === true || cmd.args.compact !== undefined) && !cmd.args.supersedes && !CONTENT_ARGS.some((k) => k in cmd.args);

/**
 * The shared gates every write passes inside its transaction. At 90% of the object limit (section 6) only retire,
 * forget and undo are accepted. A background actor never retires or
 * supersedes a stated, pinned or me node (section 12); its callers flag those first, so reaching here is refused.
 */
function gate(sql: SqlStorage, _who: Who, cmd: WriteCommand, ctx: WriteContext): void {
	if (sizeLevel(sql.databaseSize) !== "ok" && ctx.actor === "index" && (cmd.op === "upload" || (cmd.op === "knowledge" && cmd.args.nodes?.some((n) => n.kind === "commit")))) {
		throw Fail.of("size_budget", "aggregated commit uploads pause at 70% of the profile size limit", { reason: "uploads_refused" });
	}
	if (sizeLevel(sql.databaseSize) === "shrink_only" && cmd.op !== "undo" && !(cmd.op === "owner" && cmd.args.action === "forget") && !shrinks(cmd)) {
		throw Fail.of("size_budget", "this profile is over 90% of its size limit and accepts only retire, forget and undo", { reason: "shrink_only" });
	}
}

/** Background callers may not bypass protection by going directly to the shared write path. */
function protectedTargets(sql: SqlStorage, who: Who, cmd: WriteCommand, ctx: WriteContext) {
	let primary: string[] = [];
	if (cmd.op === "save" || cmd.op === "append") {
		try { primary = [findNode(sql, cmd.args, false).id]; } catch (e) { if (!(e instanceof Fail) || e.failure.code !== "not_found") throw e; }
	}
	const ids = cmd.op === "save" ? [...primary, ...[cmd.args.supersedes ?? []].flat()]
		: cmd.op === "append" ? primary : cmd.op === "owner" ? [cmd.args.memory_id] : cmd.op === "candidate" ? [cmd.args.candidate_id] : [];
	// A snapshot upload changes an existing PR or ticket node; a commit upload never rewrites one.
	if (cmd.op === "upload" && cmd.args.item !== "commit") {
		const row = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved'", uploadKey(cmd.args)).toArray()[0];
		if (row) ids.push(row.id);
	}
	if (cmd.op === "knowledge") {
		for (const n of cmd.args.nodes ?? []) {
			const row = n.key ? sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? AND status <> 'moved'", n.key).toArray()[0]
				: sql.exec<{ id: string }>("SELECT id FROM nodes WHERE kind = ? AND scope = ? AND norm_name = ? AND key IS NULL AND memory_type IS NOT 'project' AND status = 'active' LIMIT 1", n.kind, n.scope !== undefined ? scopeOf(n.scope) : "default", normalizeName(n.name)).toArray()[0];
			if (row) ids.push(row.id);
		}
		for (const end of cmd.args.end ?? []) for (const row of sql.exec<{ src: string; dst: string; dst_profile: string }>("SELECT src, dst, dst_profile FROM edges WHERE id = ?", end.edge).toArray()) {
			ids.push(row.src); if (!row.dst_profile) ids.push(row.dst);
		}
	}
	return [...new Set(ids)].flatMap((id) => {
		const node = readNode(sql, id), why = node && mayChange(node, ctx.actor, who.profile);
		return why ? [{ id, why }] : [];
	});
}

/**
 * The owner's actions on one node (section 15), each a write with activity and undo: pin protects it from the background
 * actors (mayChange), unpin lifts that, unflag clears a protection flag, and forget archives it, restorable for 300 days.
 */
function owner(tx: Tx, a: OwnerArgs): WriteOutput {
	if (tx.ctx.actor !== "owner") throw Fail.of("forbidden", "only the owner pins, unpins, forgets or unflags");
	const node = readNode(tx.sql, a.memory_id);
	if (!node || ["moving", "incoming", "moved"].includes(node.status)) throw Fail.of("not_found", `no node '${a.memory_id}' in this profile`);
	if (a.action === "forget") {
		const activityId = activity(tx, "forget", `forgot '${node.name}'`, [node.id]);
		archiveNode(tx, activityId, node.id, purgeAfter(tx.now));
		return { result: { ok: true, action: "forgotten", memory_id: node.id, name: node.name, activity_id: activityId }, created: [], embedDue: false };
	}
	const change = { pin: "pinned = 1", unpin: "pinned = 0", unflag: "flagged = NULL" }[a.action];
	if (!change) throw Fail.of("validation", `unknown owner action '${String(a.action)}'`);
	tx.run(`UPDATE nodes SET ${change}, revision = revision + 1, updated_at = ?, seq = ? WHERE id = ?`, tx.now, tx.seq, node.id);
	const activityId = activity(tx, a.action, `${a.action} '${node.name}'`, [node.id]);
	return { result: result(readNode(tx.sql, node.id)!, { pin: "pinned", unpin: "unpinned", unflag: "unflagged" }[a.action], { activity_id: activityId }), created: [], embedDue: false };
}

export const captureText = (sql: SqlStorage, id: string) =>
	sql.exec<{ body: string }>("SELECT body FROM texts WHERE node_id = ? AND part = 'capture' ORDER BY chunk", id).toArray().map((r) => r.body).join("");

/** capture_memory: a candidate node (kind other, label capture) whose text sits in the capture lane, so recall never sees it. */
function capture(tx: Tx, a: CaptureArgs): WriteOutput {
	if (typeof a.content !== "string" || !a.content) throw Fail.of("validation", "capture requires non-empty content", { reason: "invalid_content" });
	if (a.content.length > APPEND_MAX) throw Fail.of("size_budget", `a capture may hold at most ${APPEND_MAX} characters`);
	const id = crypto.randomUUID();
	const name = collapse(a.name ?? "") || `capture ${tx.now}`;
	const hash = sha256(a.content);
	tx.run(`INSERT INTO nodes (id, kind, other_label, scope, name, norm_name, description, attrs, status, origin, revision, chars, content_hash, card_hash, embed_hash,
		recorded_at, created_at, updated_at, source_platform, updated_source_platform, seq)
		VALUES (?, 'other', 'capture', ?, ?, ?, ?, ?, 'candidate', 'agent', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, a.scope !== undefined ? scopeOf(a.scope) : "default", name, normalizeName(name), a.kind ?? "observation",
		JSON.stringify({ capture_kind: a.kind ?? "observation", source: a.source ?? {}, review: "pending" }), a.content.length, hash, hash, hash,
		tx.now, tx.now, tx.now, tx.ctx.platform, tx.ctx.platform, tx.seq);
	chunks(a.content).forEach((body, chunk) => tx.run(
		"INSERT INTO texts (node_id, part, revision, chunk, body, request_id, actor, created_at, lane, seq) VALUES (?, 'capture', 1, ?, ?, ?, ?, ?, 'capture', ?)",
		id, chunk, body, tx.requestId, tx.ctx.actor, tx.now, tx.seq));
	const activityId = activity(tx, "capture", `captured ${a.kind ?? "observation"} '${name}'`, [id]);
	return { result: { ok: true, capture_id: id, status: "candidate", activity_id: activityId }, created: [id], embedDue: false };
}

/** review_candidates promote or dismiss, as BothQ's promote_memory and dismiss_memory did. */
function candidate(tx: Tx, who: Who, a: CandidateArgs): WriteOutput {
	const c = tx.sql.exec<NodeRow & { other_label: string | null; attrs: string }>("SELECT rowid, * FROM nodes WHERE id = ? AND kind = 'other' AND other_label = 'capture'", a.candidate_id).toArray()[0];
	if (!c) throw Fail.of("not_found", `no candidate found with id '${a.candidate_id}'`);
	if (c.status !== "candidate") throw Fail.of("validation", "this candidate was already reviewed", { reason: "already_reviewed", status: (JSON.parse(c.attrs) as { review?: string }).review });
	const attrs = JSON.parse(c.attrs) as Record<string, unknown>;
	if (a.action === "dismiss") {
		if (!a.reason?.trim()) throw Fail.of("validation", "dismiss needs a reason", { reason: "missing_reason" });
		tx.run("UPDATE nodes SET status = 'dismissed', attrs = ?, revision = revision + 1, updated_at = ?, seq = ? WHERE id = ?",
			JSON.stringify({ ...attrs, review: "dismissed", reason: a.reason }), tx.now, tx.seq, c.id);
		const activityId = activity(tx, "dismiss", `dismissed capture '${c.name}'`, [c.id]);
		return { result: { ok: true, action: "dismissed", capture_id: c.id, activity_id: activityId }, created: [], embedDue: false };
	}
	if (!a.into) throw Fail.of("validation", "promote needs into {name, type}", { reason: "missing_into" });
	const made = create(tx, who, { name: a.into.name, type: a.into.type, description: a.into.description ?? "", content: captureText(tx.sql, c.id), origin: "agent" }, c.scope || "default");
	const memoryId = made.created[0]!;
	tx.run(`INSERT OR IGNORE INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, request_id, seq) VALUES (?, 'relates_to', ?, '', 'identifier', ?, ?, ?, ?)`,
		memoryId, c.id, tx.now, tx.ctx.actor, tx.requestId, tx.seq);
	tx.run("INSERT OR IGNORE INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'node', ?, 'promoted capture', ?)", `n:${memoryId}`, c.id, tx.seq);
	tx.run("UPDATE nodes SET status = 'retired', attrs = ?, revision = revision + 1, updated_at = ?, seq = ? WHERE id = ?",
		JSON.stringify({ ...attrs, review: "promoted", promoted_to: memoryId }), tx.now, tx.seq, c.id);
	return { result: { ...made.result, action: "promoted", capture_id: c.id }, created: made.created, embedDue: true };
}

type Evidence = { kind: string; ref: string; note?: string };

/** A node of this profile a write may point at; landing, moving and moved nodes answer as absent. */
const visible = (sql: SqlStorage, id: string) => sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status NOT IN ('incoming','moving','moved')", id).toArray().length > 0;

/** Evidence rows for a node or edge. A node pointer must name a node of this profile. */
function addEvidence(tx: Tx, owner: string, evidence: Evidence[]): void {
	for (const ev of evidence) {
		if (ev.kind === "node" && !visible(tx.sql, ev.ref)) throw Fail.of("not_found", `evidence names no node '${ev.ref}' in this profile`, { reason: "bad_evidence" });
		tx.run("INSERT OR REPLACE INTO evidence (owner, kind, ref, note, seq) VALUES (?, ?, ?, ?, ?)", owner, ev.kind, ev.ref, ev.note ?? null, tx.seq);
	}
}

/** Fails unless the relation's endpoint table admits these node kinds (section 4). */
function checkEndpoints(rel: string, from: string, to: string): void {
	const allowed = RELATION_ENDPOINTS[rel as keyof typeof RELATION_ENDPOINTS];
	const ok = rel === "supersedes" ? from === to : !allowed || (allowed.from.includes(from as never) && allowed.to.includes(to as never));
	if (ok) return;
	const want = rel === "supersedes" ? "two nodes of the same kind" : `${allowed!.from.join("|")} to ${allowed!.to.join("|")}`;
	throw Fail.of("validation", `${rel} connects ${want}, not ${from} to ${to}; use rel other with other_label for anything else`,
		{ reason: "invalid_endpoints", rel, from, to, ...(allowed ? { allowed } : {}) });
}

type EdgeInput = Omit<NonNullable<KnowledgeArgs["edges"]>[number], "from" | "to">;

/**
 * One judgment edge (section 4), the graph writer record_knowledge and save_memory links share: a reason of 8 to 600
 * characters, at least one evidence pointer, endpoints inside the table. A current edge with the same relation and target is
 * matched: its evidence merges, its own reason and basis stay. `ends` resolves after the checks.
 */
function judgmentEdge(tx: Tx, e: EdgeInput, ends: () => [string, string]): { id: number; action: string } {
	if (e.rel === "other" && !e.other_label) throw Fail.of("validation", "rel other needs other_label", { reason: "invalid_rel" });
	if (typeof e.reason !== "string" || e.reason.trim().length < 8 || e.reason.length > 600) throw Fail.of("validation", "a judgment edge needs a reason of 8 to 600 characters", { reason: "missing_reason" });
	if (!e.evidence?.length) throw Fail.of("validation", "a judgment edge needs at least one evidence pointer", { reason: "missing_evidence" });
	const [src, dst] = ends();
	assertWritable(tx.sql, src);
	if (src === dst) throw Fail.of("validation", "an edge needs two different nodes", { reason: "self_edge" });
	checkEndpoints(e.rel, readNode(tx.sql, src)!.kind, readNode(tx.sql, dst)!.kind);
	const prior = tx.sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ? AND rel = ? AND dst_profile = '' AND dst = ? AND ended_at IS NULL", src, e.rel, dst).toArray()[0];
	const id = prior ? prior.id : Number(tx.run(`INSERT INTO edges (src, rel, other_label, dst, dst_profile, basis, reason, valid_from, valid_to, recorded_at, actor, request_id, seq)
		VALUES (?, ?, ?, ?, '', 'judgment', ?, ?, ?, ?, ?, ?, ?) RETURNING id`, src, e.rel, e.other_label ?? null, dst, e.reason.trim(), e.valid_from ?? null, e.valid_to ?? null, tx.now, tx.ctx.actor, tx.requestId, tx.seq).one().id);
	addEvidence(tx, `e:${id}`, e.evidence);
	return { id, action: prior ? "matched" : "created" };
}

/** A knowledge ref to a node of this profile: by this call's index, id, kind and key, or kind, scope and name. An unreadable node answers as absent. */
function resolveRef(tx: Tx, r: KnowledgeRef, made: { id: string }[]): string {
	if ("ref" in r) { const hit = made[r.ref]; if (!hit) throw Fail.of("validation", `ref ${r.ref} names no node in this call`, { reason: "bad_ref" }); return hit.id; }
	if ("id" in r) { if (!visible(tx.sql, r.id)) throw Fail.of("not_found", `no node with id '${r.id}' in this profile; links across profiles are not written here`); return r.id; }
	const row = "key" in r
		? tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? AND kind = ? AND status NOT IN ('moved','moving','incoming')", r.key, r.kind).toArray()[0]
		: tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE kind = ? AND norm_name = ? AND scope = ? AND status = 'active' ORDER BY rowid LIMIT 1", r.kind, normalizeName(r.name), r.scope !== undefined ? scopeOf(r.scope) : "default").toArray()[0];
	if (!row) throw Fail.of("not_found", `no ${r.kind} node matches ${"key" in r ? r.key : r.name}`);
	return row.id;
}

/** save_memory links: judgment edges from the saved node, in the same transaction; `links` joins the result only when asked for. */
function saveLinks(tx: Tx, from: string, links: SaveArgs["links"]): { links?: { id: number; action: string }[] } {
	if (links === undefined) return {};
	if (!Array.isArray(links) || !links.length) throw Fail.of("validation", "links must be a non-empty list", { reason: "invalid_links" });
	return { links: links.map((l) => judgmentEdge(tx, l, () => [from, resolveRef(tx, l.to, [])])) };
}

type EntityInput = Pick<NonNullable<KnowledgeArgs["nodes"]>[number], "kind" | "key" | "name" | "scope" | "other_label" | "valid_from" | "valid_to">;

/** An entity's content and card hashes. Decisions are memories (BothQ type project) and get an embedding card; other entities only with a description. */
export const entityHashes = (kind: string, name: string, description: string, why: string | null, attrs: Record<string, unknown>) => ({
	hash: sha256(canonicalJson({ name, kind, description, why: why ?? "", attrs })),
	card: sha256(cardText({ kind, name, description, why }, "")),
	embeds: kind === "decision" || !!description,
});

/** A new active entity at its record_knowledge id, with its searchable head and first revision. A wiped or taken id is refused. */
export function createEntity(tx: Tx, who: Who, n: EntityInput, origin: "agent" | "upload", f: { name: string; scope: string; description: string; why: string | null; attrs: Record<string, unknown> }): string {
	const id = knowledgeId(who, n);
	assertNotWiped(tx.sql, id);
	if (readNode(tx.sql, id)) throw Fail.of("already_exists", `node identity '${id}' already exists`, { memory_id: id });
	const { hash, card, embeds } = entityHashes(n.kind, f.name, f.description, f.why, f.attrs);
	tx.run(`INSERT INTO nodes (id, kind, other_label, key, memory_type, scope, name, norm_name, description, why, attrs, status, origin, revision,
		content_hash, card_hash, embed_hash, valid_from, valid_to, recorded_at, created_at, updated_at, source_platform, updated_source_platform, seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, n.kind, n.other_label ?? null, n.key ?? null, n.kind === "decision" ? "project" : null, f.scope, f.name, normalizeName(f.name), f.description, f.why,
		JSON.stringify(f.attrs), origin, hash, card, embeds ? null : card, n.valid_from ?? null, n.valid_to ?? null, tx.now, tx.now, tx.now, tx.ctx.platform, tx.ctx.platform, tx.seq);
	const node = readNode(tx.sql, id)!;
	writeHead(tx, node, [], 1);
	writeRevision(tx, node, "saved", undefined);
	return id;
}

/**
 * record_knowledge: entity nodes upsert by key, else by kind, scope and name; personal fields are dropped first; a decision
 * needs why and evidence. Every edge an agent writes is a judgment edge inside the endpoint table, with a reason (8 to 600
 * characters) and at least one evidence pointer; ending an edge keeps it as history. Each create and change keeps a revision
 * and rewrites the searchable head. Links into other profiles arrive in phase 3.
 */
function knowledge(tx: Tx, who: Who, a: KnowledgeArgs): WriteOutput {
	const nodes = a.nodes ?? [], edges = a.edges ?? [], ends = a.end ?? [];
	if (!nodes.length && !edges.length && !ends.length) throw Fail.of("validation", "record_knowledge needs nodes, edges or end", { reason: "no_changes" });
	if (who.profile === "me" && nodes.some((n) => n.kind === "person")) throw Fail.of("me_sensitive_term", "me holds no person nodes", { term: "person" });
	const made: { id: string; action: string; stripped?: string[] }[] = [], created: string[] = [];
	let embedDue = false;
	for (const n of nodes) {
		const name = collapse(n.name);
		if (!name) throw Fail.of("validation", "every node needs a name", { reason: "invalid_name" });
		if (n.kind === "other" && !n.other_label) throw Fail.of("validation", "kind other needs other_label", { reason: "invalid_kind" });
		if (n.kind === "decision" && !n.why?.trim()) throw Fail.of("validation", "a decision needs why", { reason: "missing_why" });
		if (n.kind === "decision" && !n.evidence?.length) throw Fail.of("validation", "a decision needs at least one evidence pointer", { reason: "missing_evidence" });
		const scope = n.scope !== undefined ? scopeOf(n.scope) : "default";
		const { attrs, stripped } = stripPersonal(n.kind, n.attrs);
		const existing = n.key
			? tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? AND status <> 'moved'", n.key).toArray()[0]
			: tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE kind = ? AND scope = ? AND norm_name = ? AND key IS NULL AND memory_type IS NOT 'project' AND status = 'active' ORDER BY rowid LIMIT 1",
				n.kind, scope, normalizeName(name)).toArray()[0];
		const description = n.description ?? "";
		const cur = existing ? readNode(tx.sql, existing.id)! : undefined;
		if (cur && cur.kind !== n.kind) throw Fail.of("validation", `key '${n.key}' belongs to a ${cur.kind} node, not a ${n.kind}`, { reason: "key_kind_conflict", memory_id: cur.id, kind: cur.kind });
		const why = n.why ?? cur?.why ?? null;
		const { hash, card, embeds } = entityHashes(n.kind, name, description, why, attrs);
		let id: string;
		if (cur) {
			assertWritable(tx.sql, cur.id);
			id = cur.id;
			if (cur.content_hash !== hash) {
				tx.run(`UPDATE nodes SET name = ?, norm_name = ?, description = ?, why = ?, attrs = ?, valid_from = COALESCE(?, valid_from), valid_to = COALESCE(?, valid_to),
					revision = revision + 1, content_hash = ?, card_hash = ?, embed_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?`,
					name, normalizeName(name), description, why, JSON.stringify(attrs), n.valid_from ?? null, n.valid_to ?? null, hash, card,
					embeds ? cur.embed_hash : card, tx.now, tx.ctx.platform, tx.seq, id);
				const updated = readNode(tx.sql, id)!;
				writeHead(tx, updated, [], updated.revision);
				writeRevision(tx, updated, "updated", undefined);
				embedDue ||= embeds && card !== cur.card_hash;
				made.push({ id, action: "updated", ...(stripped.length ? { stripped } : {}) });
			} else made.push({ id, action: "matched", ...(stripped.length ? { stripped } : {}) });
		} else {
			id = createEntity(tx, who, n, "agent", { name, scope, description, why, attrs });
			embedDue ||= embeds;
			made.push({ id, action: "created", ...(stripped.length ? { stripped } : {}) });
			created.push(id);
		}
		if (n.evidence?.length) addEvidence(tx, `n:${id}`, n.evidence);
		if (made[made.length - 1]!.action !== "matched") linkIdentifiers(tx, id, [name, description, why ?? ""].join("\n"));
	}
	const edgeIds = edges.map((e) => judgmentEdge(tx, e, () => [resolveRef(tx, e.from, made), resolveRef(tx, e.to, made)]));
	const ended: number[] = [];
	for (const x of ends) {
		if (!x.reason?.trim()) throw Fail.of("validation", "ending an edge needs a reason", { reason: "missing_reason" });
		const edge = tx.sql.exec<{ src: string }>("SELECT src FROM edges WHERE id = ?", x.edge).toArray()[0];
		if (edge) assertWritable(tx.sql, edge.src);
		const changed = tx.run("UPDATE edges SET ended_at = ?, valid_to = ?, seq = ? WHERE id = ? AND ended_at IS NULL", tx.now, x.valid_to, tx.seq, x.edge).rowsWritten;
		if (!changed) throw Fail.of("not_found", `no current edge ${x.edge}`);
		ended.push(x.edge);
	}
	// Mentions written before a node with this key existed link to it now, whatever its kind, in the rows this write has left;
	// the keys with mentions still waiting are named, and the next write of each key resolves more.
	const left = nodes.flatMap((n, i) => (n.key && resolveMentions(tx, made[i]!.id, n.key).left ? [n.key] : []));
	const activityId = activity(tx, "knowledge", `recorded ${made.length} nodes, ${edgeIds.length} edges, ended ${ended.length}`, [...made.map((m) => m.id), ...edgeIds.map((e) => `e:${e.id}`)]);
	return { result: { ok: true, action: "recorded", nodes: made, edges: edgeIds, ended, activity_id: activityId, ...(left.length ? { mentions_waiting: left } : {}) }, created, embedDue };
}

/** Undo restores rows in place, so it refuses a record that is moving, landing or already moved to another profile (section 9). */
function unmoved(sql: SqlStorage, activityId: number): void {
	const row = sql.exec<{ targets: string }>("SELECT targets FROM activity WHERE id = ?", activityId).toArray()[0];
	for (const id of row ? (JSON.parse(row.targets) as string[]) : []) {
		assertWritable(sql, id);
		if (sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status = 'moved'", id).toArray().length) throw Fail.of("revision_conflict", "changed since; review by hand", { node: id, reason: "moved" });
	}
}

/**
 * One transaction: replay or refuse by request_id, then apply, stamp every row with the next sequence number,
 * write activity and store the request's result. A thrown Fail rolls everything back.
 */
function writeOnce(storage: DurableObjectStorage, who: Who, cmd: WriteCommand, ctx: WriteContext): WriteOutput {
	return storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const requestId = cmd.args.request_id ?? null;
		if (requestId) {
			const row = sql.exec<{ payload_hash: string; result: string; node_id: string; legacy_hash: string | null; state: string | null }>(
				`SELECT r.payload_hash, r.result, r.node_id, r.legacy_hash, coalesce(f.state, i.state) AS state FROM requests r
				LEFT JOIN import_records i ON i.record_id = r.node_id LEFT JOIN import_refreshes f ON f.shadow_id = r.node_id WHERE r.request_id = ?`, requestId).toArray()[0];
			if (row) {
				assertNotWiped(sql, row.node_id);
				// An imported request replays only once its record is published, and only for the same call by BothQ's own hash.
				if (row.state && row.state !== "published") throw Fail.of("busy", `request_id '${requestId}' belongs to a record that is still being imported; retry later`);
				if (row.payload_hash !== (row.legacy_hash ? ctx.legacyHash : ctx.payloadHash)) {
					throw Fail.of("idempotency_mismatch", `request_id '${requestId}' was already used with different arguments`, { request_id: requestId });
				}
				return { result: { ...(JSON.parse(row.result) as Record<string, unknown>), action: "replayed" }, created: [], embedDue: false };
			}
		}
		// Only a committed result above may skip the guard; a pending binding or a retry that can still write may not.
		let guard: (material: unknown) => void = () => {};
		if (who.profile === "me") {
			if (!ctx.meGuard?.explicit) throw Fail.of("validation", "writes to me must name profile: \"me\" explicitly");
			// Work terms registered before a work write committed here first, so this read inside the transaction cannot miss them.
			const stored = sql.exec<{ term: string }>("SELECT term FROM guard_terms").toArray().map((r) => r.term);
			const me = ctx.meGuard;
			guard = (material) => {
				const r = meGuard({ ...me, sensitiveTerms: [...me.sensitiveTerms, ...stored], texts: guardTexts(material) });
				if (!r.ok) throw new Fail(r.error);
			};
			guard(cmd.args);
		}
		gate(sql, who, cmd, ctx);
		if (cmd.op === "undo" || cmd.op === "restore") unmoved(sql, cmd.args.activity_id);
		const seq = takeSeq(sql, "profile_meta");
		const tx = new Tx(sql, seq.seq, new Date().toISOString(), ctx, requestId, guard);
		tx.charge(seq.rows);
		const refused = BACKGROUND.includes(ctx.actor) ? protectedTargets(sql, who, cmd, ctx) : [];
		// Every write keeps what it changes, so the activity row holds its inverse; an undo is itself a write.
		const before = cmd.op === "undo" || refused.length ? undefined : beforeImages(sql, cmd);
		const flags = refused.map((n) => flagProtected(tx, n.id, n.why, cmd.op, ctx.actor));
		const out: WriteOutput = flags.length ? { result: { action: "flagged", memory_id: refused[0]!.id, activity_id: flags.at(-1) }, created: [], embedDue: false }
			: cmd.op === "undo" ? revert(tx, cmd.args) : cmd.op === "restore" ? restore(tx, cmd.args) : cmd.op === "owner" ? owner(tx, cmd.args) : cmd.op === "save" ? save(tx, who, cmd.args) : cmd.op === "append" ? append(tx, cmd.args) : cmd.op === "capture" ? capture(tx, cmd.args) : cmd.op === "knowledge" ? knowledge(tx, who, cmd.args) : cmd.op === "upload" ? upload(tx, who, cmd.args) : candidate(tx, who, cmd.args);
		out.result = { ...out.result, profile: who.profile, routed_by: ctx.routedBy };
		if (before) recordUndo(tx, before, { ...out, consumed: tx.consumed });
		if (requestId) {
			tx.run("INSERT INTO requests (request_id, op, payload_hash, result, node_id, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
				requestId, cmd.op, ctx.payloadHash, JSON.stringify(out.result), String(out.result.memory_id ?? out.result.capture_id ?? ""), tx.now, tx.seq);
		}
		return out;
	});
}

/** Undo reindexes behind the still-current fence, in bounded transactions, before publishing the restored fence. */
export function runWrite(storage: DurableObjectStorage, who: Who, cmd: WriteCommand, ctx: WriteContext): WriteOutput {
	for (;;) {
		try { return writeOnce(storage, who, cmd, ctx); } catch (e) {
			if (!(e instanceof Unfold)) throw e;
			unfoldStep(storage, e);
		}
	}
}
