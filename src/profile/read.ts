// Phase-1 reads: get (with revision-bound paging and history), recall channels, and the inventory listing. With as_of (valid
// time, section 4) each reads the record's stored state then: its revisions and appended entries up to that instant.
import { contentRows, fenceOf, VISIBLE } from "./compact";
import { owned, READABLE_NODE, valid } from "./graph";
import { normalizeName, normalizeScope } from "../domain/ids";
import { Fail, type MemoryKind, type MemoryType, type RecallHit, type Step } from "../domain/types";
import { captureText, findNode, readContent, relationships, type NodeRow, type Who } from "./write";
import { captureState, parseRange, sessionKey } from "./capture";
import { BATCH_GAP_MS, batchStatus } from "./maintenance";
import { projectKey } from "./work-upload";

export const PAGE = 100_000;
const RRF_K = 60;
const PASSAGE = 700;
const TOKEN_RE = /[A-Za-z0-9_@./:#-]+/g;
const ORIGIN_WEIGHT: Record<string, number> = { stated: 1, agent: 0.9, import: 0.9, upload: 0.8, index: 0.8, inferred: 0.7 };

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): unknown => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

type GetQuery = { target: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }; includeRetired: boolean;
	history?: { limit: number; beforeRevision?: number }; content?: { complete: boolean; cursor?: string }; asOf?: string };

export function get(sql: SqlStorage, who: Who, q: GetQuery) {
	if (q.asOf) return getAt(sql, who, q, q.asOf);
	const n = findNode(sql, q.target, !q.includeRetired);
	const full = readContent(sql, n.id);
	const page = contentPage(n, full, q.content);
	// Current links whose source is readable here, as graph reads show them, each with its reason and evidence pointers.
	const edges = owned(sql, sql.exec<{ id: number; src: string }>(`SELECT id, src, rel, other_label, dst AS to_id, dst_profile, basis, reason, valid_from, valid_to, recorded_at
		FROM edges WHERE (src = ? OR dst = ?) AND ended_at IS NULL ORDER BY id`, n.id, n.id).toArray());
	const evidence = new Map<string, { kind: string; ref: string; note: string | null }[]>();
	for (const r of sql.exec<{ owner: string; kind: string; ref: string; note: string | null }>("SELECT owner, kind, ref, note FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, kind, ref",
		JSON.stringify([`n:${n.id}`, ...edges.map((e) => `e:${e.id}`)])).toArray()) (evidence.get(r.owner) ?? evidence.set(r.owner, []).get(r.owner)!).push({ kind: r.kind, ref: r.ref, note: r.note });
	return {
		ok: true, memory_id: n.id, profile: who.profile, kind: n.kind, name: n.name, type: n.memory_type, scope: n.scope, revision: n.revision,
		description: n.description, content: page.content, why: n.why ?? "", how_to_apply: n.how_to_apply ?? "", objective: n.objective ?? "",
		status: n.status, origin: n.origin, content_hash: n.content_hash, content_chars: full.length, complete: page.complete, cursor: page.cursor,
		steps: n.steps ? (JSON.parse(n.steps) as Step[]) : [],
		embedding_status: n.embed_hash === n.card_hash ? "embedded" : "pending",
		...(n.kind === "journal" ? { compaction: fence(sql, n.id, fenceOf(n.attrs)) } : {}),
		relationships: relationships(sql, n),
		evidence: evidence.get(`n:${n.id}`) ?? [],
		edges: edges.map(({ id, src, ...e }) => ({ id, from_id: src, ...e, evidence: evidence.get(`e:${id}`) ?? [] })),
		freshness: { created_at: n.created_at, updated_at: n.updated_at, valid_from: n.valid_from, valid_until: n.valid_to },
		...(q.history ? history(sql, n, q.history) : {}),
	};
}

/**
 * Whole content up to 100k characters. Larger content pages in order, each cursor bound to one revision and content hash, and
 * with as_of (`t`) to that instant too.
 */
export function contentPage(n: { id: string; revision: number; content_hash: string }, full: string, c?: { complete: boolean; cursor?: string }, t?: string): { content: string; complete: boolean; cursor: string | null } {
	const cursor = (o: number) => b64({ i: n.id, r: n.revision, h: n.content_hash, o, ...(t ? { t } : {}) });
	if (c?.cursor || c?.complete) {
		let offset = 0;
		if (c.cursor) {
			let cur: { i?: string; r?: number; h?: string; o?: number; t?: string };
			try { cur = unb64(c.cursor) as typeof cur; } catch { throw Fail.of("validation", "content cursor is not valid"); }
			if (cur.i !== n.id) throw Fail.of("validation", "content cursor belongs to another memory");
			if (cur.t !== t) throw Fail.of("validation", "content cursor belongs to another as_of; start again");
			if (cur.r !== n.revision || cur.h !== n.content_hash) {
				throw Fail.of("revision_conflict", `the memory changed since this cursor was issued (revision ${cur.r}, now ${n.revision}); start again`,
					{ expected_revision: cur.r, actual_revision: n.revision });
			}
			offset = Number(cur.o) || 0;
		}
		const end = Math.min(full.length, offset + PAGE);
		return { content: full.slice(offset, end), complete: end >= full.length, cursor: end < full.length ? cursor(end) : null };
	}
	if (full.length <= PAGE) return { content: full, complete: true, cursor: null };
	// Newest text first fits the window; complete paging starts from the beginning.
	return { content: full.slice(full.length - PAGE), complete: false, cursor: cursor(0) };
}

/** A record's stored state at valid time `at` (section 4), from its revisions and appended entries alone. */
export interface Past {
	/** The revision in effect: the newest of the longest prefix of revisions and entries all recorded at or before `at`. */
	revision: number; recorded_at: string;
	/**
	 * The record's fields then: the newest full snapshot (BothQ's and native ones hold every field), with name, scope, status and
	 * relationships from a newer append or transfer snapshot that holds only those. A key no snapshot holds is unknown, never the current value.
	 */
	snap: Record<string, unknown>;
	/** The content hash recorded at the revision in effect, or null when that revision has no row (a native append or a pin). */
	contentHash: string | null;
	status: string | null;
	/** Started by then (an import's valid_from dates only its current version, so it starts nothing), and not yet ended. */
	started: boolean; valid: boolean;
	/** The exact content then, or null when what is stored cannot rebuild it; undefined when not asked for. */
	content?: string | null;
}

/** Over nodes `n`, each with one bound instant: existed (its first revision was recorded), started, not ended (an unreadable end counts as ended, as in graph.ts). */
const EXISTED = "coalesce(julianday((SELECT r.at FROM revisions r WHERE r.node_id = n.id ORDER BY r.revision LIMIT 1)) <= julianday(?), 0)";
const STARTED = "(n.origin = 'import' OR n.valid_from IS NULL OR coalesce(julianday(n.valid_from) <= julianday(?), 0))";
const NOT_ENDED = "NOT coalesce(julianday(coalesce(n.valid_to, n.ended_at)) <= julianday(?), coalesce(n.valid_to, n.ended_at) IS NOT NULL)";
/** A stored time not known to be at or before ?2 counts as after it, so an unreadable date never lets a later state through. */
const after = (col: string) => `NOT coalesce(julianday(${col}) <= julianday(?2), 0)`;
const str = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? o[k] as string : null);

export function pastOf(sql: SqlStorage, n: { id: string; revision: number }, at: string, withContent: boolean): Past | null {
	const cut = sql.exec<{ r: number | null }>(`SELECT min(r) AS r FROM (SELECT min(revision) AS r FROM revisions WHERE node_id = ?1 AND ${after("at")}
		UNION ALL SELECT min(revision) FROM texts WHERE node_id = ?1 AND part = 'entry' AND ${after("created_at")})`, n.id, at).one().r;
	const last = sql.exec<{ revision: number; at: string }>(`SELECT revision, at FROM (SELECT revision, at FROM revisions WHERE node_id = ?1 AND revision < ?2
		UNION ALL SELECT revision, created_at FROM texts WHERE node_id = ?1 AND part = 'entry' AND chunk = 0 AND revision < ?2) ORDER BY revision DESC LIMIT 1`,
		n.id, cut ?? Number.MAX_SAFE_INTEGER).toArray()[0];
	if (!last || !sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND revision <= ? LIMIT 1", n.id, last.revision).toArray().length) return null;
	const E = last.revision;
	const latest = (cond: string) => sql.exec<{ revision: number; snapshot: string }>(`SELECT revision, snapshot FROM revisions WHERE node_id = ? AND revision <= ? AND ${cond}
		ORDER BY revision DESC LIMIT 1`, n.id, E).toArray()[0];
	const full = latest("json_type(snapshot, '$.description') IS NOT NULL"), head = latest("json_type(snapshot, '$.name') = 'text'");
	const later = head && (!full || head.revision > full.revision) ? JSON.parse(head.snapshot) as Record<string, unknown> : {};
	const snap = { ...(full ? JSON.parse(full.snapshot) as Record<string, unknown> : {}),
		...Object.fromEntries(["name", "scope", "status", "relationships"].filter((k) => k in later).map((k) => [k, later[k]])) };
	const hash = sql.exec<{ h: string | null }>("SELECT coalesce(json_extract(snapshot, '$.content_hash'), content_hash) AS h FROM revisions WHERE node_id = ? AND revision = ?", n.id, E).toArray()[0]?.h ?? null;
	const status = sql.exec<{ s: string }>(`SELECT json_extract(snapshot, '$.status') AS s FROM revisions WHERE node_id = ? AND revision <= ? AND json_type(snapshot, '$.status') = 'text'
		ORDER BY revision DESC LIMIT 1`, n.id, E).toArray()[0]?.s ?? null;
	const v = sql.exec<{ started: number; live: number }>(`SELECT ${STARTED} AS started, ${NOT_ENDED} AS live FROM nodes n WHERE n.id = ?`, at, at, n.id).one();
	return { revision: E, recorded_at: last.at, snap, contentHash: typeof hash === "string" ? hash : null, status,
		started: v.started === 1, valid: v.started === 1 && v.live === 1, ...(withContent ? { content: contentAt(sql, n.id, E) } : {}) };
}

/**
 * Content after revision E, rebuilt only where it is exact: the newest content snapshot plus later entries, or across a
 * compaction its body rows, summary and the entries past its fence. An undo since that snapshot may have archived an entry or
 * summary the rebuild needs, and a compaction over a body replaced since has no stored body; both return null.
 */
function contentAt(sql: SqlStorage, id: string, E: number): string | null {
	const base = sql.exec<{ revision: number; content: string }>(`SELECT revision, json_extract(snapshot, '$.content') AS content FROM revisions
		WHERE node_id = ? AND revision <= ? AND op <> 'compacted' AND json_type(snapshot, '$.content') = 'text' ORDER BY revision DESC LIMIT 1`, id, E).toArray()[0];
	const B = base?.revision ?? 0;
	if (sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND revision > ? AND op = 'restored' LIMIT 1", id, B).toArray().length) return null;
	// Fail closed on history this rebuild does not understand: after the base only appends whose entries are still stored, status
	// changes, transfer landings, snapshots that declare their content unchanged, and compactions (handled below) may follow.
	const unknown = sql.exec(`SELECT 1 FROM revisions r WHERE r.node_id = ? AND r.revision > ? AND r.revision <= ? AND NOT (
		(r.op = 'appended' AND EXISTS (SELECT 1 FROM texts t WHERE t.node_id = r.node_id AND t.part = 'entry' AND t.revision = r.revision))
		OR (r.op = 'legacy_snapshot' AND r.revision = (SELECT min(revision) FROM revisions WHERE node_id = r.node_id) AND json_type(r.snapshot, '$.content_chars') = 'integer' AND json_type(r.snapshot, '$.content_hash') = 'text')
		OR r.op IN ('retired', 'superseded', 'transferred_in', 'compacted') OR coalesce(json_extract(r.snapshot, '$.content_unchanged'), 0) = 1) LIMIT 1`, id, B, E).toArray().length;
	if (unknown) return null;
	const entries = (from: number, fence = 0) => sql.exec<{ separator: string | null; body: string; chunk: number }>(`SELECT separator, body, chunk FROM texts
		WHERE node_id = ? AND part = 'entry' AND revision > ? AND revision <= ? AND seq_no > ? ORDER BY seq_no, chunk`, id, from, E, fence).toArray()
		.map((r) => (r.chunk === 0 && r.separator ? r.separator : "") + r.body).join("");
	const bodyRows = sql.exec<{ revision: number; body: string }>("SELECT revision, body FROM texts WHERE node_id = ? AND part = 'body' ORDER BY chunk", id).toArray();
	const body = bodyRows.length ? { revision: bodyRows[0]!.revision, text: bodyRows.map((r) => r.body).join("") } : null;
	const legacy = sql.exec<{ revision: number; chars: number }>("SELECT revision, json_extract(snapshot, '$.content_chars') AS chars FROM revisions WHERE node_id = ? AND op = 'legacy_snapshot' ORDER BY revision LIMIT 1", id).toArray()[0];
	if (!base && legacy && (!body ? legacy.chars !== 0 : body.revision !== legacy.revision || body.text.length !== legacy.chars)) return null;
	const comp = sql.exec<{ revision: number; delta: string | null }>("SELECT revision, delta FROM revisions WHERE node_id = ? AND revision > ? AND revision <= ? AND op = 'compacted' ORDER BY revision DESC LIMIT 1",
		id, B, E).toArray()[0];
	if (!comp) {
		if (base) return base.content + entries(B);
		// No content snapshot (a record begun by appends, or an imported legacy one): its body rows, if no later write replaced them.
		return body && body.revision > E ? null : (body?.text ?? "") + entries(body?.revision ?? 0);
	}
	const d = JSON.parse(comp.delta ?? "{}") as { through_seq?: number; summary_revision?: number };
	const summary = sql.exec<{ body: string }>("SELECT body FROM texts WHERE node_id = ? AND part = 'summary' AND revision = ? ORDER BY chunk", id, d.summary_revision ?? comp.revision).toArray();
	if (!summary.length || typeof d.through_seq !== "number" || (body && body.revision > comp.revision)) return null;
	// Without body rows the body is empty since the newest empty content snapshot; entries before it were taken out of the content then.
	const from = body?.revision ?? sql.exec<{ revision: number }>(`SELECT revision FROM revisions WHERE node_id = ? AND revision <= ? AND json_extract(snapshot, '$.content') = ''
		ORDER BY revision DESC LIMIT 1`, id, comp.revision).toArray()[0]?.revision;
	return from === undefined ? null : (body?.text ?? "") + summary.map((r) => r.body).join("") + entries(from, d.through_seq);
}

/** get_memory with as_of: the record resolves by its id, or its current name, scope and type; as_of selects its stored state. */
function getAt(sql: SqlStorage, who: Who, q: GetQuery, at: string) {
	const t = q.target;
	if (!t.memory_id && !t.name?.trim()) throw Fail.of("validation", "memory_id or name is required", { reason: "missing_identity" });
	let scope: string | undefined;
	try { scope = t.scope !== undefined ? normalizeScope(t.scope) : undefined; } catch (e) { throw Fail.of("validation", (e as Error).message, { reason: "invalid_scope" }); }
	const rows = sql.exec<NodeRow>(`SELECT rowid, * FROM nodes WHERE ${t.memory_id ? "id" : "norm_name"} = ? AND memory_type IS NOT NULL AND ${READABLE_NODE}`,
		t.memory_id ?? normalizeName(t.name!)).toArray().filter((r) => (!t.type || r.memory_type === t.type) && (scope === undefined || r.scope === scope));
	const what = t.memory_id ? `id '${t.memory_id}'` : `name '${t.name}'`;
	if (!rows.length) throw Fail.of("not_found", `no memory found with ${what}`);
	const pasts = rows.map((n) => ({ n, p: pastOf(sql, n, at, false) })).filter((x): x is { n: NodeRow; p: Past } => !!x.p && x.p.started);
	if (!pasts.length) throw Fail.of("not_found", `no memory with ${what} was recorded and valid by ${at}`, { reason: "not_recorded_by_as_of" });
	const shown = pasts.filter((x) => q.includeRetired || (x.p.status === "active" && x.p.valid));
	if (!shown.length) throw Fail.of("not_found", `no memory with ${what} was active at ${at}; pass include_retired`, { reason: "not_active_at_as_of", status: pasts[0]!.p.status });
	if (shown.length > 1) {
		throw Fail.of("ambiguous", `memory name '${t.name}' matches ${shown.length} records at ${at}; pass memory_id or narrow with type and scope`,
			{ reason: "ambiguous_name", matches: shown.map((x) => ({ memory_id: x.n.id, type: x.n.memory_type, scope: x.n.scope })) });
	}
	const n = shown[0]!.n, p = pastOf(sql, n, at, true)!, s = p.snap;
	const page = p.content == null ? { content: null, complete: false, cursor: null }
		: contentPage({ id: n.id, revision: p.revision, content_hash: `${n.content_hash}@${n.revision}` }, p.content, q.content, at);
	// Links valid at as_of by the graph's rule, from sources readable here; their evidence, like the record's own, is current.
	const edges = owned(sql, sql.exec<{ id: number; src: string; valid_from: string | null; valid_to: string | null; ended_at: string | null }>(`SELECT id, src, rel, other_label,
		dst AS to_id, dst_profile, basis, reason, valid_from, valid_to, recorded_at, ended_at FROM edges WHERE src = ? OR dst = ? ORDER BY id`, n.id, n.id).toArray()).filter((e) => valid(e, at));
	const evidence = evidenceOf(sql, [`n:${n.id}`, ...edges.map((e) => `e:${e.id}`)]);
	const steps = Array.isArray(s.steps) ? s.steps as Step[] : null;
	return {
		ok: true, memory_id: n.id, profile: who.profile, kind: n.kind, name: str(s, "name"), type: n.memory_type, scope: str(s, "scope"), revision: p.revision,
		description: str(s, "description"), content: page.content, why: str(s, "why"), how_to_apply: str(s, "how_to_apply"), objective: str(s, "objective"),
		status: p.status, origin: n.origin, content_hash: p.contentHash, content_chars: p.content?.length ?? null,
		complete: page.complete, cursor: page.cursor, steps, relationships: s.relationships ?? null,
		...(n.kind === "journal" ? { compaction: fenceAt(sql, n.id, p.revision) } : {}),
		evidence: evidence.get(`n:${n.id}`) ?? [],
		edges: edges.map(({ id, src, ...e }) => ({ id, from_id: src, ...e, evidence: evidence.get(`e:${id}`) ?? [] })),
		freshness: { created_at: n.created_at, updated_at: p.recorded_at, valid_from: str(s, "_valid_from"), valid_until: str(s, "_valid_until") },
		as_of: { at, revision: p.revision, recorded_at: p.recorded_at, valid: p.valid, content_known: p.content != null, current: ["evidence"],
			note: "Fields and content are the stored state at as_of; null means its history does not hold them. Links are those valid at as_of. Evidence is current." },
		...(q.history ? history(sql, n, { limit: q.history.limit, beforeRevision: Math.min(q.history.beforeRevision ?? Infinity, p.revision + 1) }) : {}),
	};
}

/**
 * A journal's compaction fence (section 12): entries 1 to compacted_through are folded into the summary written at
 * summary_revision; latest_entry_seq is the newest entry number, the bound for save_memory compact's through_seq.
 */
function fence(sql: SqlStorage, id: string, through: number) {
	const summary = sql.exec<{ revision: number }>("SELECT revision FROM texts WHERE node_id = ? AND part = 'summary' AND live <> 0 LIMIT 1", id).toArray()[0];
	const latest = sql.exec<{ n: number | null }>("SELECT max(seq_no) AS n FROM texts WHERE node_id = ? AND part = 'entry'", id).one().n ?? 0;
	return { compacted_through: through, summary_revision: summary?.revision ?? null, latest_entry_seq: latest };
}

/** The fence in effect at revision E, from the newest compaction by then; unknown (null) when an undo since restored an older one. */
function fenceAt(sql: SqlStorage, id: string, E: number) {
	const c = sql.exec<{ revision: number; delta: string | null }>("SELECT revision, delta FROM revisions WHERE node_id = ? AND op = 'compacted' AND revision <= ? ORDER BY revision DESC LIMIT 1", id, E).toArray()[0];
	const undone = c && sql.exec("SELECT 1 FROM revisions WHERE node_id = ? AND op = 'restored' AND revision > ? AND revision <= ? LIMIT 1", id, c.revision, E).toArray().length;
	const d = JSON.parse(c?.delta ?? "{}") as { through_seq?: number; summary_revision?: number };
	const latest = sql.exec<{ n: number | null }>("SELECT max(seq_no) AS n FROM texts WHERE node_id = ? AND part = 'entry' AND revision <= ?", id, E).one().n ?? 0;
	return undone ? { compacted_through: null, summary_revision: null, latest_entry_seq: latest }
		: { compacted_through: Number(d.through_seq ?? 0), summary_revision: c ? d.summary_revision ?? c.revision : null, latest_entry_seq: latest };
}

function evidenceOf(sql: SqlStorage, owners: string[]) {
	const out = new Map<string, { kind: string; ref: string; note: string | null }[]>();
	for (const r of sql.exec<{ owner: string; kind: string; ref: string; note: string | null }>("SELECT owner, kind, ref, note FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, kind, ref",
		JSON.stringify(owners)).toArray()) (out.get(r.owner) ?? out.set(r.owner, []).get(r.owner)!).push({ kind: r.kind, ref: r.ref, note: r.note });
	return out;
}

/** BothQ memory_history: a newest-first window of `limit`, returned oldest first, with next_before_revision. Appends carry their entry as the delta. */
function history(sql: SqlStorage, n: NodeRow, h: { limit: number; beforeRevision?: number }) {
	const before = h.beforeRevision ?? Number.MAX_SAFE_INTEGER;
	const snaps = sql.exec<{ revision: number; op: string; snapshot: string; delta: string | null; request_id: string | null; at: string; actor: string; device_id: string | null }>(
		"SELECT revision, op, snapshot, delta, request_id, at, actor, device_id FROM revisions WHERE node_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
		n.id, before, h.limit + 1).toArray().map((r) => {
		const snapshot = JSON.parse(r.snapshot) as Record<string, unknown>;
		// An imported BothQ append keeps its own revision row, with BothQ's original delta.
		return { revision: r.revision, operation: r.op, content_hash: snapshot.content_hash, snapshot, request_id: r.request_id, created_at: r.at, actor: r.actor, device_id: r.device_id,
			...(r.delta ? { delta: JSON.parse(r.delta) as { content: string; separator: string } } : {}) } as { revision: number; delta?: { content: string; separator: string }; entry_seq?: number } & Record<string, unknown>;
	});
	const entryRows = sql.exec<{ revision: number; seq_no: number; chunk: number; separator: string | null; body: string; request_id: string | null; created_at: string; actor: string }>(
		`SELECT revision, seq_no, chunk, separator, body, request_id, created_at, actor FROM texts
		 WHERE node_id = ? AND part = 'entry' AND revision IN (SELECT DISTINCT revision FROM texts WHERE node_id = ? AND part = 'entry' AND revision < ? ORDER BY revision DESC LIMIT ?)
		 ORDER BY revision, chunk`, n.id, n.id, before, h.limit + 1).toArray();
	const entries = new Map<number, { revision: number; operation: string; delta: { content: string; separator: string }; entry_seq: number; request_id: string | null; created_at: string; actor: string }>();
	for (const r of entryRows) {
		const e = entries.get(r.revision) ?? { revision: r.revision, operation: "appended", delta: { content: "", separator: r.separator ?? "" }, entry_seq: r.seq_no, request_id: r.request_id, created_at: r.created_at, actor: r.actor };
		e.delta.content += r.body;
		entries.set(r.revision, e);
	}
	// One item per revision: an entry joins the revision row of the same number when there is one (an imported append).
	const byRevision = new Map<number, Record<string, unknown> & { revision: number }>(snaps.map((x) => [x.revision, x]));
	for (const e of entries.values()) {
		const s = byRevision.get(e.revision) as (typeof snaps)[number] | undefined;
		if (s) { s.delta ??= e.delta; s.entry_seq = e.entry_seq; } else byRevision.set(e.revision, e);
	}
	const window = [...byRevision.values()].sort((a, b) => b.revision - a.revision);
	const more = window.length > h.limit;
	const kept = window.slice(0, h.limit);
	return { revisions: kept.reverse(), next_before_revision: more ? kept[0]!.revision : null };
}

export interface RecallQuery { keyword: string; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; limit: number; includeHistory: boolean; asOf?: string }
type Filter = { type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; includeHistory: boolean; asOf?: string };

/**
 * The record filters, over nodes `n`. With as_of they are a superset by the current row (type and kind never change; a scope may
 * have, so any record with history passes), and `admit` decides on the stored state then.
 */
export function filters(q: Filter): { where: string; params: SqlStorageValue[] } {
	const parts = ["n.memory_type IS NOT NULL", q.includeHistory || q.asOf ? "n.status IN ('active','retired','superseded')" : "n.status = 'active'"];
	const params: SqlStorageValue[] = [];
	if (q.asOf) {
		parts.push(EXISTED, STARTED, ...(q.includeHistory ? [] : [NOT_ENDED]));
		params.push(q.asOf, q.asOf, ...(q.includeHistory ? [] : [q.asOf]));
	}
	if (q.type !== "all") { parts.push("n.memory_type = ?"); params.push(q.type); }
	if (q.kinds?.length) { parts.push(`n.kind IN (${q.kinds.map(() => "?").join(",")})`); params.push(...q.kinds); }
	if (q.scope !== undefined) { parts.push(q.asOf ? "(n.scope = ? OR n.revision > 1 OR n.origin = 'import')" : "n.scope = ?"); params.push(normalizeScope(q.scope)); }
	return { where: parts.join(" AND "), params };
}

/** The ids among `ids` that pass the filters, so vector hits and graph neighbours meet the lexical channels' rule. */
export function filterIds(sql: SqlStorage, q: Filter, ids: string[]): Set<string> {
	const f = filters(q);
	return new Set(sql.exec<{ id: string }>(`SELECT n.id FROM nodes n WHERE n.id IN (SELECT value FROM json_each(?)) AND ${f.where}`, JSON.stringify(ids), ...f.params).toArray().map((r) => r.id));
}

/**
 * With as_of, a record's stored state then if it shows: started, active and valid then unless history is asked for, and in the
 * asked scope then (its current scope only where no snapshot names one). Without as_of every record the filters pass shows.
 */
function admit(sql: SqlStorage, n: NodeRow, q: Filter): Past | null | undefined {
	if (!q.asOf) return undefined;
	const p = pastOf(sql, n, q.asOf, false);
	if (!p?.started || (!q.includeHistory && (p.status !== "active" || !p.valid))) return null;
	if (q.scope !== undefined) {
		try { if (normalizeScope(str(p.snap, "scope") ?? n.scope) !== normalizeScope(q.scope)) return null; } catch { return null; }
	}
	return p;
}

interface Candidate { id: string; chunk?: number }

/** The lexical channels, each a ranked list of distinct nodes with the chunk that matched. */
export function lexicalChannels(sql: SqlStorage, q: RecallQuery, diagnostics: Record<string, string>): Record<string, Candidate[]> {
	const f = filters(q);
	const keyword = q.keyword.trim();
	const norm = normalizeName(keyword);
	const exact = sql.exec<{ id: string }>(`SELECT n.id FROM nodes n WHERE (n.norm_name = ? OR n.key = ?) AND ${f.where} ORDER BY n.rowid LIMIT 20`, norm, keyword, ...f.params).toArray();
	const viaText = (table: string, match: string): Candidate[] => {
		try {
			return dedupe(sql.exec<{ id: string; chunk: number }>(
				`SELECT n.id, t.rowid AS chunk FROM ${table} JOIN texts t ON t.rowid = ${table}.rowid JOIN nodes n ON n.id = t.node_id
				 WHERE ${table} MATCH ? AND ${VISIBLE} AND ${f.where} ORDER BY ${table}.rank LIMIT 200`, match, ...f.params).toArray());
		} catch (e) {
			diagnostics[table === "texts_tri" ? "literal" : "fulltext"] = `error:${(e as Error).message.slice(0, 80)}`;
			return [];
		}
	};
	const literal = keyword.length >= 3
		? viaText("texts_tri", `"${keyword.replace(/"/g, '""')}"`)
		: sql.exec<{ id: string }>(`SELECT n.id FROM nodes n WHERE n.name LIKE ? ESCAPE '\\' AND ${f.where} ORDER BY n.rowid LIMIT 200`,
			`%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, ...f.params).toArray();
	// shortcut: history has no text index; add one if as_of recall grows beyond a few thousand records.
	const historical = (terms: string[]): Candidate[] => q.asOf && terms.length ? sql.exec<{ id: string }>(`SELECT n.id FROM nodes n WHERE ${f.where} AND (
		EXISTS (SELECT 1 FROM revisions r WHERE r.node_id = n.id AND coalesce(julianday(r.at) <= julianday(?), 0)
			AND EXISTS (SELECT 1 FROM json_each(?) term WHERE instr(lower(r.snapshot), lower(term.value)) > 0))
		OR EXISTS (SELECT 1 FROM texts t WHERE t.node_id = n.id AND t.part = 'entry' AND coalesce(julianday(t.created_at) <= julianday(?), 0)
			AND EXISTS (SELECT 1 FROM json_each(?) term WHERE instr(lower(t.body), lower(term.value)) > 0)))
		ORDER BY n.rowid LIMIT 200`, ...f.params, q.asOf, JSON.stringify(terms), q.asOf, JSON.stringify(terms)).toArray() : [];
	const tokens = [...new Set((keyword.match(TOKEN_RE) ?? []).filter((t) => t.length > 1))];
	const fts = tokens.length ? [`"${keyword.replace(/"/g, '""')}"`, ...tokens.map((t) => `"${t.replace(/"/g, '""')}"`)].join(" OR ") : "";
	const fulltext = dedupe([...(fts ? viaText("texts_fts", fts) : []), ...historical(tokens)]).slice(0, 200);
	const literals = dedupe([...literal, ...historical(keyword.length >= 3 ? [keyword] : [])]).slice(0, 200);
	diagnostics.exact = exact.length ? `hits:${exact.length}` : "no_results";
	diagnostics.literal ??= literals.length ? `hits:${literals.length}` : "no_results";
	diagnostics.fulltext ??= fulltext.length ? `hits:${fulltext.length}` : "no_results";
	return { exact, literal: literals, fulltext };
}

function dedupe(rows: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	return rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
}

/** RRF k=60 per channel; exact counts double; BothQ literal boosts (+2 exact name, +1 literal hit); then origin weight. */
export function fuse(sql: SqlStorage, who: Who, q: RecallQuery, all: Record<string, Candidate[]>): RecallHit[] {
	const norm = normalizeName(q.keyword);
	let channels = all, past: Map<string, Past> | undefined;
	if (q.asOf) {
		// Each candidate's state at as_of; the exact channel is the records whose name or key then is the keyword.
		const rows = sql.exec<NodeRow & { key: string | null }>("SELECT rowid, * FROM nodes WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
			JSON.stringify([...new Set(Object.values(all).flat().map((c) => c.id))])).toArray();
		const then = new Map(rows.flatMap((n) => { const p = admit(sql, n, q); return p ? [[n.id, p] as const] : []; }));
		const exact = rows.filter((n) => then.has(n.id) && (normalizeName(str(then.get(n.id)!.snap, "name") ?? "") === norm || n.key === q.keyword.trim())).slice(0, 20).map((n) => ({ id: n.id }));
		channels = { ...Object.fromEntries(Object.entries(all).map(([channel, list]) => [channel, list.filter((c) => then.has(c.id))])), exact };
		past = then;
	}
	const score = new Map<string, number>(), matched = new Map<string, Set<string>>(), chunk = new Map<string, number>();
	for (const [name, list] of Object.entries(channels)) {
		list.forEach((c, i) => {
			const weight = name === "exact" ? 2 : 1;
			score.set(c.id, (score.get(c.id) ?? 0) + weight / (RRF_K + i + 1));
			(matched.get(c.id) ?? matched.set(c.id, new Set()).get(c.id)!).add(name);
			if (c.chunk !== undefined && !chunk.has(c.id)) chunk.set(c.id, c.chunk);
		});
	}
	if (!score.size) return [];
	const ids = [...score.keys()];
	// All candidates (up to 520) as one JSON parameter: Cloudflare's SQLite allows 100 bound parameters per statement.
	const nodes = new Map(sql.exec<NodeRow>("SELECT rowid, * FROM nodes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).toArray().map((n) => [n.id, n]));
	const ranked = ids.flatMap((id) => {
		const n = nodes.get(id);
		if (!n) return [];
		let s = score.get(id)!;
		if (matched.get(id)!.has("literal")) s += (past ? normalizeName(str(past.get(id)!.snap, "name") ?? "") : n.norm_name) === norm ? 2 : 1;
		s *= ORIGIN_WEIGHT[n.origin] ?? 0.9;
		return [{ n, s }];
	}).sort((a, b) => b.s - a.s || a.n.name.toLowerCase().localeCompare(b.n.name.toLowerCase()) || a.n.id.localeCompare(b.n.id));
	// With as_of a text match counts only if the record's text then holds the keyword or a token: current text may be newer.
	const full = new Map<string, Past>(), then = (n: NodeRow) => full.get(n.id) ?? full.set(n.id, pastOf(sql, n, q.asOf!, true)!).get(n.id)!;
	const lower = q.keyword.trim().toLowerCase(), tokens = [...new Set((lower.match(TOKEN_RE) ?? []).filter((t) => t.length > 1))];
	const shown = (x: { n: NodeRow }) => {
		if (!past || ["exact", "graph"].some((c) => matched.get(x.n.id)!.has(c))) return true;
		const p = then(x.n), s = p.snap;
		const text = [p.content ?? "", ...["name", "description", "why", "how_to_apply", "objective"].map((k) => str(s, k) ?? ""), JSON.stringify(s.steps ?? [])].join("\n").toLowerCase();
		return text.includes(lower) || tokens.some((t) => text.includes(t));
	};
	// Section 12: up to `limit` non-inferred preferences from below the cap travel with their true rank, so the Worker's
	// stated-first order equals the uncapped one at both caps. Only their bodies are read beyond the capped hits.
	const head: typeof ranked = [], below: (typeof ranked[number] & { rank: number })[] = [];
	let pos = 0;
	for (const x of ranked) {
		if (head.length >= q.limit && below.length >= q.limit) break;
		if (head.length >= q.limit && (x.n.kind !== "preference" || x.n.origin === "inferred")) { pos++; continue; }
		if (!shown(x)) continue;
		if (head.length < q.limit) head.push(x); else below.push({ ...x, rank: pos });
		pos++;
	}
	return [...head, ...below].map((x: { n: NodeRow; s: number; rank?: number }) =>
		({ ...(past ? hitAt(who, x.n, then(x.n), x.s, [...matched.get(x.n.id)!].sort(), q.keyword)
			: hit(sql, who, x.n, x.s, [...matched.get(x.n.id)!].sort(), q.keyword, chunk.get(x.n.id))), ...(x.rank !== undefined ? { rank: x.rank } : {}) }));
}

/** A hit from the record's stored state at as_of: fields from its snapshot then, the passage from its content then. */
function hitAt(who: Who, n: NodeRow, p: Past, score: number, matchedBy: string[], keyword: string): RecallHit {
	const s = p.snap, field = (k: string) => str(s, k) ?? "";
	return {
		memory_id: n.id, profile: who.profile, kind: n.kind, type: n.memory_type, name: str(s, "name"), scope: str(s, "scope"), origin: n.origin, status: p.status,
		revision: p.revision, passage: passage([p.content ?? "", field("why"), field("how_to_apply"), field("objective"), field("description"), field("name")], keyword),
		matched_by: matchedBy, score: Math.round(score * 1e8) / 1e8, objective: str(s, "objective"), step_count: Array.isArray(s.steps) ? s.steps.length : 0,
		provenance: { source_platform: str(s, "_source_platform"), updated_source_platform: str(s, "_updated_source_platform"), source_hash: p.contentHash },
		freshness: { created_at: n.created_at, updated_at: p.recorded_at, valid_from: str(s, "_valid_from"), valid_until: str(s, "_valid_until") },
		as_of: { recorded_at: p.recorded_at, valid: p.valid, content_known: p.content != null }, row: n.rowid,
	};
}

export function hit(sql: SqlStorage, who: Who, n: NodeRow, score: number, matchedBy: string[], keyword: string, chunkRow?: number): RecallHit {
	const chunkText = chunkRow !== undefined
		? sql.exec<{ part: string; body: string }>(`SELECT t.part, t.body FROM texts t JOIN nodes n ON n.id = t.node_id WHERE t.rowid = ? AND ${VISIBLE}`, chunkRow).toArray()[0]
		: undefined;
	const body = chunkText && chunkText.part !== "head" ? chunkText.body
		: contentRows(sql, n.id).toArray()[0]?.body ?? "";
	return {
		memory_id: n.id, profile: who.profile, kind: n.kind, type: n.memory_type, name: n.name, scope: n.scope, origin: n.origin, status: n.status,
		revision: n.revision, passage: passage([body, n.why ?? "", n.how_to_apply ?? "", n.objective ?? "", n.description, n.name], keyword),
		matched_by: matchedBy, score: Math.round(score * 1e8) / 1e8, objective: n.objective, step_count: n.steps ? (JSON.parse(n.steps) as unknown[]).length : 0,
		provenance: { source_platform: n.source_platform, updated_source_platform: n.updated_source_platform, source_hash: n.content_hash },
		freshness: { created_at: n.created_at, updated_at: n.updated_at, valid_from: n.valid_from, valid_until: n.valid_to },
		row: n.rowid,
	};
}

/** BothQ _passage: 700 characters around the best match, preferring a whole-query match and earlier fields. */
export function passage(fields: string[], query: string): string {
	const q = query.toLowerCase();
	const tokens = [...new Set((query.match(TOKEN_RE) ?? []).filter((t) => t.length > 1).map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
	let best: { rank: [number, number]; text: string; pos: number } | undefined;
	fields.forEach((text, order) => {
		const folded = text.toLowerCase();
		const whole = q ? folded.indexOf(q) : -1;
		const positions = [whole, ...tokens.map((t) => folded.indexOf(t))].filter((p) => p >= 0);
		if (!positions.length) return;
		const rank: [number, number] = [whole >= 0 ? 0 : 1, order];
		if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { rank, text, pos: whole >= 0 ? whole : Math.min(...positions) };
	});
	const text = best?.text ?? fields.slice(1).find(Boolean) ?? fields[0] ?? "";
	const at = best?.pos ?? 0;
	if (text.length <= PASSAGE) return text.trim();
	let start = Math.max(0, at - Math.floor(PASSAGE / 3));
	let end = Math.min(text.length, start + PASSAGE);
	if (end === text.length) start = Math.max(0, end - PASSAGE);
	if (start) { const b = text.indexOf(" ", start); if (b >= 0 && b < Math.min(start + 80, end)) start = b + 1; }
	if (end < text.length) { const b = text.lastIndexOf(" ", end); if (b > start) end = b; }
	return (start ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
}

/**
 * Empty keyword: every record in row order (stable creation order) after the cursor position. With as_of a page reads on until it
 * holds `limit` records shown then or the rows end, so a short page still means the profile is done.
 */
export function inventory(sql: SqlStorage, who: Who, q: { after: number; limit: number } & Filter): RecallHit[] {
	const f = filters(q), out: RecallHit[] = [];
	// shortcut: an early as_of may read every row of the profile in one call; give the scan its own cursor if profiles grow past a few thousand records.
	for (let after = q.after; ;) {
		const rows = sql.exec<NodeRow>(`SELECT n.rowid, n.* FROM nodes n WHERE n.rowid > ? AND ${f.where} ORDER BY n.rowid LIMIT ?`, after, ...f.params, q.limit).toArray();
		for (const n of rows) {
			const p = admit(sql, n, q);
			if (p === null) continue;
			out.push(p ? hitAt(who, n, pastOf(sql, n, q.asOf!, true)!, 0, [], "") : hit(sql, who, n, 0, [], "", undefined));
			if (out.length === q.limit) return out;
		}
		if (rows.length < q.limit) return out;
		after = rows.at(-1)!.rowid;
	}
}

/**
 * review_candidates list: captured candidates by BothQ status, newest first. Their text is untrusted evidence. With as_of, only
 * captures stored by then, each with its review status then. A capture keeps no history rows, so its status is known when nothing
 * changed it after as_of, or when its one change (revision 2) came after as_of, when it was still pending; otherwise `unknown`,
 * which only status `all` lists. The outcome's promoted_to and reason show only when the status then is the current one.
 */
export function candidates(sql: SqlStorage, q: { status: "pending" | "promoted" | "dismissed" | "all"; limit: number; asOf?: string }) {
	const at = q.asOf ? Date.parse(q.asOf) : Infinity;
	const rows = sql.exec<NodeRow & { attrs: string }>("SELECT rowid, * FROM nodes WHERE kind = 'other' AND other_label = 'capture' ORDER BY rowid DESC").toArray();
	return rows.filter((n) => !q.asOf || Date.parse(n.created_at) <= at)
		.map((n) => {
			const a = JSON.parse(n.attrs) as { review?: string; capture_kind?: string; source?: Record<string, string>; promoted_to?: string; reason?: string };
			const same = n.revision === 1 || Date.parse(n.updated_at) <= at;
			return { n, a, same, status: same ? a.review ?? "pending" : n.revision === 2 ? "pending" : "unknown" };
		})
		.filter(({ status }) => q.status === "all" || status === q.status).slice(0, q.limit)
		.map(({ n, a, same, status }) => ({ capture_id: n.id, name: n.name, kind: a.capture_kind ?? "observation", status, source: a.source ?? {},
			content: captureText(sql, n.id), created_at: n.created_at, ...(same && a.promoted_to ? { promoted_to: a.promoted_to } : {}), ...(same && a.reason ? { reason: a.reason } : {}) }));
}

const RANGES_MAX = 2_000;

/**
 * GET /v1/markers (sections 7 and 10), read-only: the repo's marker, the session's stored capture ranges with the cursors they
 * acknowledge per transcript epoch, and the daily batch slot. A cursor counts only a run of stored ranges from 0 with no gap, so a
 * read never acknowledges a range the server does not hold. The daily refresh slot is not recorded here yet, so it reads null.
 */
export function markers(sql: SqlStorage, q: { repo: string | null; session?: { client: "claude-code" | "codex"; id: string } }, now = Date.now()) {
	const marker = q.repo ? sql.exec<{ head: string | null; uploaded_at: string | null }>("SELECT head, uploaded_at FROM markers WHERE repo = ?", projectKey(q.repo)).toArray()[0] ?? null : null;
	let captures = null;
	if (q.session) {
		const node = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? AND kind = 'session'", sessionKey(q.session)).toArray()[0];
		const rows = node ? sql.exec<{ range_id: string; capture_status: string; capture_part: string }>(`SELECT range_id, capture_status, capture_part FROM texts
			WHERE node_id = ? AND part = 'capture' AND chunk = 0 AND range_id IS NOT NULL ORDER BY rowid LIMIT ?`, node.id, RANGES_MAX + 1).toArray() : [];
		const ranges = new Map<string, { range_id: string; heuristic: boolean; consolidated: boolean }>();
		for (const range_id of new Set(rows.slice(0, RANGES_MAX).map((r) => r.range_id))) {
			const state = captureState(sql, [range_id])[range_id]!;
			ranges.set(range_id, { range_id, heuristic: state.heuristic, consolidated: state.consolidated });
		}
		const epochs = new Map<string, { start: number; end: number; heuristic: boolean; consolidated: boolean }[]>();
		for (const r of ranges.values()) {
			const p = parseRange(r.range_id);
			if (p) (epochs.get(p.epoch) ?? epochs.set(p.epoch, []).get(p.epoch)!).push({ start: p.start, end: p.end, heuristic: r.heuristic, consolidated: r.consolidated });
		}
		const tiled = (list: { start: number; end: number }[]) => { let to = 0; for (const r of [...list].sort((a, b) => a.start - b.start)) if (r.start <= to && r.end > to) to = r.end; return to; };
		captures = {
			session: q.session, ranges: [...ranges.values()], truncated: rows.length > RANGES_MAX,
			acknowledged: Object.fromEntries([...epochs].map(([epoch, list]) => [epoch, { digested_to: tiled(list.filter((r) => r.heuristic || r.consolidated)), consolidated_to: tiled(list.filter((r) => r.consolidated)) }])),
		};
	}
	const last = batchStatus(sql).last_lease_at, until = last ? Date.parse(last) + BATCH_GAP_MS : 0;
	return { repo: q.repo, marker, captures, daily: { batch: { last_lease_at: last, next_allowed_at: until > now ? new Date(until).toISOString() : null }, refresh: null } };
}
