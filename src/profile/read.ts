// Phase-1 reads: get (with revision-bound paging and history), recall channels, and the inventory listing.
import { normalizeName, normalizeScope } from "../domain/ids";
import { Fail, type MemoryKind, type MemoryType, type RecallHit, type Step } from "../domain/types";
import { captureText, findNode, readContent, relationships, type NodeRow, type Who } from "./write";

export const PAGE = 100_000;
const RRF_K = 60;
const PASSAGE = 700;
const TOKEN_RE = /[A-Za-z0-9_@./:#-]+/g;
const ORIGIN_WEIGHT: Record<string, number> = { stated: 1, agent: 0.9, import: 0.9, upload: 0.8, index: 0.8, inferred: 0.7 };

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): unknown => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

export function get(sql: SqlStorage, who: Who, q: { target: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }; includeRetired: boolean;
	history?: { limit: number; beforeRevision?: number }; content?: { complete: boolean; cursor?: string } }) {
	const n = findNode(sql, q.target, !q.includeRetired);
	const full = readContent(sql, n.id);
	const page = contentPage(n, full, q.content);
	return {
		ok: true, memory_id: n.id, profile: who.profile, kind: n.kind, name: n.name, type: n.memory_type, scope: n.scope, revision: n.revision,
		description: n.description, content: page.content, why: n.why ?? "", how_to_apply: n.how_to_apply ?? "", objective: n.objective ?? "",
		status: n.status, origin: n.origin, content_hash: n.content_hash, content_chars: full.length, complete: page.complete, cursor: page.cursor,
		steps: n.steps ? (JSON.parse(n.steps) as Step[]) : [],
		embedding_status: n.embed_hash === n.card_hash ? "embedded" : "pending",
		relationships: relationships(sql, n),
		edges: sql.exec("SELECT id, src AS from_id, rel, dst AS to_id, dst_profile, basis, reason, recorded_at FROM edges WHERE (src = ? OR dst = ?) AND ended_at IS NULL ORDER BY id", n.id, n.id).toArray(),
		freshness: { created_at: n.created_at, updated_at: n.updated_at, valid_from: n.valid_from, valid_until: n.valid_to },
		...(q.history ? history(sql, n, q.history) : {}),
	};
}

/** Whole content up to 100k characters. Larger content pages in order, each cursor bound to one revision and content hash. */
function contentPage(n: NodeRow, full: string, c?: { complete: boolean; cursor?: string }): { content: string; complete: boolean; cursor: string | null } {
	if (c?.cursor || c?.complete) {
		let offset = 0;
		if (c.cursor) {
			let cur: { i?: string; r?: number; h?: string; o?: number };
			try { cur = unb64(c.cursor) as typeof cur; } catch { throw Fail.of("validation", "content cursor is not valid"); }
			if (cur.i !== n.id) throw Fail.of("validation", "content cursor belongs to another memory");
			if (cur.r !== n.revision || cur.h !== n.content_hash) {
				throw Fail.of("revision_conflict", `the memory changed since this cursor was issued (revision ${cur.r}, now ${n.revision}); start again`,
					{ expected_revision: cur.r, actual_revision: n.revision });
			}
			offset = Number(cur.o) || 0;
		}
		const end = Math.min(full.length, offset + PAGE);
		return { content: full.slice(offset, end), complete: end >= full.length, cursor: end < full.length ? b64({ i: n.id, r: n.revision, h: n.content_hash, o: end }) : null };
	}
	if (full.length <= PAGE) return { content: full, complete: true, cursor: null };
	// Newest text first fits the window; complete paging starts from the beginning.
	return { content: full.slice(full.length - PAGE), complete: false, cursor: b64({ i: n.id, r: n.revision, h: n.content_hash, o: 0 }) };
}

/** BothQ memory_history: a newest-first window of `limit`, returned oldest first, with next_before_revision. Appends carry their entry as the delta. */
function history(sql: SqlStorage, n: NodeRow, h: { limit: number; beforeRevision?: number }) {
	const before = h.beforeRevision ?? Number.MAX_SAFE_INTEGER;
	const snaps = sql.exec<{ revision: number; op: string; snapshot: string; request_id: string | null; at: string; actor: string; device_id: string | null }>(
		"SELECT revision, op, snapshot, request_id, at, actor, device_id FROM revisions WHERE node_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
		n.id, before, h.limit + 1).toArray().map((r) => {
		const snapshot = JSON.parse(r.snapshot) as Record<string, unknown>;
		return { revision: r.revision, operation: r.op, content_hash: snapshot.content_hash, snapshot, request_id: r.request_id, created_at: r.at, actor: r.actor, device_id: r.device_id };
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
	const window = [...snaps, ...entries.values()].sort((a, b) => b.revision - a.revision);
	const more = window.length > h.limit;
	const kept = window.slice(0, h.limit);
	return { revisions: kept.reverse(), next_before_revision: more ? kept[0]!.revision : null };
}

export interface RecallQuery { keyword: string; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; limit: number; includeHistory: boolean }

function filters(q: { type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; includeHistory: boolean }): { where: string; params: SqlStorageValue[] } {
	const parts = ["n.memory_type IS NOT NULL", q.includeHistory ? "n.status IN ('active','retired','superseded')" : "n.status = 'active'"];
	const params: SqlStorageValue[] = [];
	if (q.type !== "all") { parts.push("n.memory_type = ?"); params.push(q.type); }
	if (q.kinds?.length) { parts.push(`n.kind IN (${q.kinds.map(() => "?").join(",")})`); params.push(...q.kinds); }
	if (q.scope !== undefined) { parts.push("n.scope = ?"); params.push(normalizeScope(q.scope)); }
	return { where: parts.join(" AND "), params };
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
				 WHERE ${table} MATCH ? AND ${f.where} ORDER BY ${table}.rank LIMIT 200`, match, ...f.params).toArray());
		} catch (e) {
			diagnostics[table === "texts_tri" ? "literal" : "fulltext"] = `error:${(e as Error).message.slice(0, 80)}`;
			return [];
		}
	};
	const literal = keyword.length >= 3
		? viaText("texts_tri", `"${keyword.replace(/"/g, '""')}"`)
		: sql.exec<{ id: string }>(`SELECT n.id FROM nodes n WHERE n.name LIKE ? ESCAPE '\\' AND ${f.where} ORDER BY n.rowid LIMIT 200`,
			`%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, ...f.params).toArray();
	const tokens = [...new Set((keyword.match(TOKEN_RE) ?? []).filter((t) => t.length > 1))];
	const fts = tokens.length ? [`"${keyword.replace(/"/g, '""')}"`, ...tokens.map((t) => `"${t.replace(/"/g, '""')}"`)].join(" OR ") : "";
	const fulltext = fts ? viaText("texts_fts", fts) : [];
	diagnostics.exact = exact.length ? `hits:${exact.length}` : "no_results";
	diagnostics.literal ??= literal.length ? `hits:${literal.length}` : "no_results";
	diagnostics.fulltext ??= fulltext.length ? `hits:${fulltext.length}` : "no_results";
	return { exact, literal, fulltext };
}

function dedupe(rows: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	return rows.filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
}

/** RRF k=60 per channel; exact counts double; BothQ literal boosts (+2 exact name, +1 literal hit); then origin weight. */
export function fuse(sql: SqlStorage, who: Who, q: RecallQuery, channels: Record<string, Candidate[]>): RecallHit[] {
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
	const norm = normalizeName(q.keyword);
	const ids = [...score.keys()];
	const nodes = new Map(sql.exec<NodeRow>(`SELECT rowid, * FROM nodes WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map((n) => [n.id, n]));
	const ranked = ids.flatMap((id) => {
		const n = nodes.get(id);
		if (!n) return [];
		let s = score.get(id)!;
		if (matched.get(id)!.has("literal")) s += n.norm_name === norm ? 2 : 1;
		s *= ORIGIN_WEIGHT[n.origin] ?? 0.9;
		return [{ n, s }];
	}).sort((a, b) => b.s - a.s || a.n.name.toLowerCase().localeCompare(b.n.name.toLowerCase()) || a.n.id.localeCompare(b.n.id)).slice(0, q.limit);
	return ranked.map(({ n, s }) => hit(sql, who, n, s, [...matched.get(n.id)!].sort(), q.keyword, chunk.get(n.id)));
}

export function hit(sql: SqlStorage, who: Who, n: NodeRow, score: number, matchedBy: string[], keyword: string, chunkRow?: number): RecallHit {
	const chunkText = chunkRow !== undefined
		? sql.exec<{ part: string; body: string }>("SELECT part, body FROM texts WHERE rowid = ?", chunkRow).toArray()[0]
		: undefined;
	const body = chunkText && chunkText.part !== "head" ? chunkText.body
		: sql.exec<{ body: string }>("SELECT body FROM texts WHERE node_id = ? AND part IN ('body','entry') AND live = 1 ORDER BY part = 'entry', seq_no, chunk LIMIT 1", n.id).toArray()[0]?.body ?? "";
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

/** Empty keyword: every record in row order (stable creation order) after the cursor position. */
export function inventory(sql: SqlStorage, who: Who, q: { after: number; limit: number; type: MemoryType | "all"; kinds?: MemoryKind[]; scope?: string; includeHistory: boolean }): RecallHit[] {
	const f = filters(q);
	return sql.exec<NodeRow>(`SELECT n.rowid, n.* FROM nodes n WHERE n.rowid > ? AND ${f.where} ORDER BY n.rowid LIMIT ?`, q.after, ...f.params, q.limit).toArray()
		.map((n) => hit(sql, who, n, 0, [], "", undefined));
}

/** review_candidates list: captured candidates by BothQ status, newest first. Their text is untrusted evidence. */
export function candidates(sql: SqlStorage, q: { status: "pending" | "promoted" | "dismissed" | "all"; limit: number }) {
	const rows = sql.exec<NodeRow & { attrs: string }>("SELECT rowid, * FROM nodes WHERE kind = 'other' AND other_label = 'capture' ORDER BY rowid DESC").toArray();
	return rows.map((n) => ({ n, a: JSON.parse(n.attrs) as { review?: string; capture_kind?: string; source?: Record<string, string>; promoted_to?: string; reason?: string } }))
		.filter(({ a }) => q.status === "all" || (a.review ?? "pending") === q.status).slice(0, q.limit)
		.map(({ n, a }) => ({ capture_id: n.id, name: n.name, kind: a.capture_kind ?? "observation", status: a.review ?? "pending", source: a.source ?? {},
			content: captureText(sql, n.id), created_at: n.created_at, ...(a.promoted_to ? { promoted_to: a.promoted_to } : {}), ...(a.reason ? { reason: a.reason } : {}) }));
}
