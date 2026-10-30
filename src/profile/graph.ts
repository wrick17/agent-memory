// Graph reads over one profile (sections 4, 7 and 11): explore, trace, timeline and recall's link expansion. Each read has a
// work budget and says where it stopped. An endpoint that is not a node of this profile comes back as a foreign id: only the
// Worker may follow it, and only into profiles the caller named and may read.
import { normalizeName, normalizeScope } from "../domain/ids";
import { Fail, type NodeKind, type RELATIONS } from "../domain/types";

type Rel = (typeof RELATIONS)[number];

/** Section 7's work budgets: nodes expanded per level (and per trace side), edge rows per explore or trace, edge rows per recall expansion. */
export const LEVEL_NODES = 200, EDGE_ROWS = 5_000, EXPAND_ROWS = 1_000;
const SEEDS = 10, EXPAND_KEEP = 200, EVENTS = 20;
/** Published local records. Absence and every other status are unreadable. */
export const READABLE_NODE = "status IN ('active','retired','superseded')";
function readableNodeRows(sql: SqlStorage, ids: string[]) {
	return sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND ${READABLE_NODE}`,
		JSON.stringify([...new Set(ids)]));
}
export function readableNodeIds(sql: SqlStorage, ids: string[]): Set<string> {
	return ids.length ? new Set(readableNodeRows(sql, ids).toArray().map(r => r.id)) : new Set();
}

export const REL_CLASS: Record<Rel, "structural" | "work" | "reasoning" | "weak" | "other"> = {
	works_on: "structural", authored: "structural", reviewed: "structural", reported: "structural", assigned: "structural", part_of: "structural", depends_on: "structural",
	implements: "work", fixes: "work", introduced_by: "work", caused_by: "work", blocked_by: "work",
	decided_because: "reasoning", supersedes: "reasoning", contradicts: "reasoning", relates_to: "weak", other: "other",
};
const WHY: Rel[] = ["decided_because", "caused_by", "introduced_by", "blocked_by", "supersedes"];
const EXPAND_WEIGHT: Record<string, number> = { reasoning: 1, work: 0.8, structural: 0.6 };
const EXPAND_RELS = (Object.keys(REL_CLASS) as Rel[]).filter((r) => EXPAND_WEIGHT[REL_CLASS[r]] !== undefined);

export type NodeRef = { id: string } | { key: string } | { name: string; kind?: NodeKind; scope?: string };
/** `known` lists the account's profile names, so incoming links written while their target lived elsewhere are found by index. */
export interface ExploreQuery { kind: "explore"; node: NodeRef; depth: number; rels?: Rel[]; asOf?: string; known: string[]; maxEdges: number }
/**
 * `why` walks this profile. A path search may cross profiles, so the Worker runs it: `step` reads one level of links touching
 * `ids` in this profile, and `detail` returns the summaries and evidence of the nodes and links a found path uses.
 */
export type TraceQuery = { kind: "trace"; known: string[]; maxEdges: number; asOf?: string } & (
	| { mode: "why"; from: NodeRef; maxDepth: number }
	| { mode: "step"; ids: string[]; similarity: boolean }
	| { mode: "detail"; nodes: string[]; edges: number[] });
export interface TimelineQuery { kind: "timeline"; from: string; to: string; node?: NodeRef; kinds?: NodeKind[]; limit: number; known: string[] }

/** Where a read stopped: `stopped` names the first limit reached, `skipped` counts links read but left out at a full level. */
export interface Budget { edges_read: number; limit: number; exhausted: boolean; stopped: string | null; skipped: number }
export const newBudget = (limit: number): Budget => ({ edges_read: 0, limit, exhausted: false, stopped: null, skipped: 0 });
const stop = (b: Budget, where: string) => { b.exhausted = true; b.stopped ??= where; };

type EdgeRow = {
	id: number; src: string; dst: string; dst_profile: string; rel: Rel; other_label: string | null; basis: string; reason: string | null;
	score: number | null; weight: number; valid_from: string | null; valid_to: string | null; recorded_at: string; ended_at: string | null;
};
export type GraphLink = EdgeRow & { class: string; depth: number; evidence: { kind: string; ref: string; note: string | null }[] };
export type NodeSummary = {
	id: string; kind: string; other_label: string | null; key: string | null; name: string; type: string | null; scope: string; status: string;
	description: string; valid_from: string | null; valid_to: string | null; recorded_at: string; ended_at: string | null;
};
const EDGE_COLS = "id, src, dst, dst_profile, rel, other_label, basis, reason, score, weight, valid_from, valid_to, recorded_at, ended_at";

interface EdgeFilter { rels?: readonly string[]; bases?: string[]; asOf?: string; recordedBy?: string; similarity: boolean; out?: boolean; known: string[] }

/** Current, or valid at `asOf`: inside [valid_from, valid_to), and a link ended without a valid_to stops being valid when it ended. */
export function valid(e: { valid_from: string | null; valid_to: string | null; ended_at: string | null }, asOf?: string): boolean {
	if (!asOf) return e.ended_at === null;
	const at = Date.parse(asOf), end = e.valid_to ?? e.ended_at;
	return (!e.valid_from || Date.parse(e.valid_from) <= at) && (!end || Date.parse(end) > at);
}

/**
 * Indexed id/source discovery stays bounded even when every matching source is hidden. Gate those sources before loading
 * payloads; charge all discovery, source-status and payload rows against the same walk budget, including JSON-list work.
 */
function edgesOf(sql: SqlStorage, ids: string[], f: EdgeFilter, b: Budget, where: string): EdgeRow[] {
	if (!ids.length) return [];
	const list = JSON.stringify(ids), rels = f.rels ? JSON.stringify(f.rels) : null, relCond = rels ? " AND rel IN (SELECT value FROM json_each(?))" : "";
	// Time eligibility follows bounded discovery: a predicate before LIMIT can scan unbounded newer edges.
	let query = `SELECT id, src FROM edges WHERE src IN (SELECT value FROM json_each(?))${relCond}`;
	const params: SqlStorageValue[] = [list, ...(rels ? [rels] : [])];
	let listed = ids.length + (f.rels?.length ?? 0);
	if (!f.out) {
		query += ` UNION ALL SELECT id, src FROM edges WHERE dst_profile IN (SELECT value FROM json_each(?)) AND dst IN (SELECT value FROM json_each(?))${relCond}`;
		params.push(JSON.stringify(["", ...f.known]), list, ...(rels ? [rels] : []));
		listed += f.known.length + 1 + ids.length + (f.rels?.length ?? 0);
	}
	// Reserve indexed edge/source/payload lookups and JSON-list overhead for every discovered row, including hidden ones.
	const room = Math.floor((b.limit - b.edges_read - 3 * listed - 8) / 12);
	if (room <= 0) { stop(b, where); return []; }
	const cursor = sql.exec<{ id: number; src: string }>(`${query} LIMIT ?`, ...params, room);
	const rows = cursor.toArray();
	b.edges_read += cursor.rowsRead;
	if (rows.length >= room) stop(b, where);
	if (!rows.length) return [];
	const sourceRows = readableNodeRows(sql, rows.map(r => r.src));
	const readable = new Set(sourceRows.toArray().map(r => r.id));
	b.edges_read += sourceRows.rowsRead;
	const seen = new Set<number>();
	const kept = rows.filter(r => readable.has(r.src) && !seen.has(r.id) && (seen.add(r.id), true)).map(r => r.id);
	if (!kept.length) return [];
	const payload = sql.exec<EdgeRow>(`SELECT ${EDGE_COLS} FROM edges WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(kept));
	const byId = new Map(payload.toArray().map(r => [r.id, r]));
	b.edges_read += payload.rowsRead;
	return kept.map(id => byId.get(id)!).filter(r => (!f.recordedBy || Date.parse(r.recorded_at) <= Date.parse(f.recordedBy)) && valid(r, f.asOf) && (f.bases ? f.bases.includes(r.basis) : f.similarity || r.basis !== "similarity"));
}

/** Gate the source before loading evidence or returning edge payloads. Targets may remain opaque. */
export function owned<T extends { src: string }>(sql: SqlStorage, rows: T[]): T[] {
	const readable = readableNodeIds(sql, rows.map(r => r.src));
	return rows.filter(r => readable.has(r.src));
}

/** Summaries of published local records only; all other endpoints remain opaque. */
export function summaries(sql: SqlStorage, ids: string[]): Map<string, NodeSummary> {
	if (!ids.length) return new Map();
	return new Map(sql.exec<NodeSummary>(`SELECT id, kind, other_label, key, name, memory_type AS type, scope, status, substr(description, 1, 280) AS description,
		valid_from, valid_to, recorded_at, ended_at FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND ${READABLE_NODE}`, JSON.stringify(ids)).toArray().map((n) => [n.id, n]));
}

function withEvidence(sql: SqlStorage, edges: (EdgeRow & { depth: number })[]): GraphLink[] {
	const ev = new Map<string, GraphLink["evidence"]>();
	if (edges.length) {
		for (const r of sql.exec<{ owner: string; kind: string; ref: string; note: string | null }>("SELECT owner, kind, ref, note FROM evidence WHERE owner IN (SELECT value FROM json_each(?))",
			JSON.stringify(edges.map((e) => `e:${e.id}`))).toArray()) (ev.get(r.owner) ?? ev.set(r.owner, []).get(r.owner)!).push({ kind: r.kind, ref: r.ref, note: r.note });
	}
	return edges.map((e) => ({ ...e, class: REL_CLASS[e.rel], evidence: ev.get(`e:${e.id}`) ?? [] }));
}

/** A node id, or the one node of this profile with the key or name (an active match wins over history). */
function resolve(sql: SqlStorage, ref: NodeRef): string {
	if ("id" in ref) {
		// A record still landing or in flight is no start either, so neither its links nor its history show.
		if (sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status IN ('incoming','moving')", ref.id).toArray().length) throw Fail.of("not_found", `no node matches '${ref.id}'`);
		return ref.id;
	}
	const rows = "key" in ref
		? sql.exec<{ id: string; status: string }>("SELECT id, status FROM nodes WHERE key = ? AND key IS NOT NULL AND status NOT IN ('moved','moving','incoming')", ref.key).toArray()
		: sql.exec<{ id: string; status: string }>(`SELECT id, status FROM nodes WHERE norm_name = ? AND status NOT IN ('moved','moving','incoming')${ref.kind ? " AND kind = ?" : ""}${ref.scope !== undefined ? " AND scope = ?" : ""} ORDER BY rowid LIMIT 20`,
			normalizeName(ref.name), ...(ref.kind ? [ref.kind] : []), ...(ref.scope !== undefined ? [normalizeScope(ref.scope)] : [])).toArray();
	const active = rows.filter((r) => r.status === "active");
	const pick = active.length === 1 ? active[0] : rows.length === 1 ? rows[0] : undefined;
	if (pick) return pick.id;
	const label = "key" in ref ? ref.key : ref.name;
	if (!rows.length) throw Fail.of("not_found", `no node matches '${label}'`);
	throw Fail.of("ambiguous", `${rows.length} nodes match '${label}'; pass id, key, kind or scope`, { matches: rows.map((r) => r.id) });
}

/**
 * Breadth-first from `from`, up to `depth` levels. A level takes at most `levelNodes` new nodes (200; the map's 300); links that
 * would add more are counted in `skipped`. Only nodes of this profile are expanded further.
 */
export function walk(sql: SqlStorage, from: string[], depth: number, f: EdgeFilter, b: Budget, nodes: Map<string, NodeSummary>, levelNodes = LEVEL_NODES): GraphLink[] {
	const out: (EdgeRow & { depth: number })[] = [], seen = new Set(from), seenEdge = new Set<number>();
	let frontier = from;
	for (let d = 1; d <= depth && frontier.length; d++) {
		const fresh: string[] = [];
		for (const e of edgesOf(sql, frontier, f, b, `level ${d} edges`)) {
			if (seenEdge.has(e.id)) continue;
			const add = [e.src, e.dst].filter((x) => !seen.has(x));
			if (fresh.length + add.length > levelNodes) { b.skipped++; stop(b, `level ${d} nodes`); continue; }
			seenEdge.add(e.id);
			out.push({ ...e, depth: d });
			for (const x of add) { seen.add(x); fresh.push(x); }
		}
		for (const [id, n] of summaries(sql, fresh)) nodes.set(id, n);
		frontier = fresh.filter((id) => nodes.has(id));
	}
	return withEvidence(sql, out);
}

/** Endpoints and node evidence that are not nodes of this profile, for the Worker to resolve; local evidence nodes join `nodes`. */
function foreignOf(sql: SqlStorage, links: GraphLink[], nodes: Map<string, NodeSummary>, also: string[]): string[] {
	const ids = new Set([...also, ...links.flatMap((l) => [l.src, l.dst])].filter((id) => !nodes.has(id)));
	const evidence = [...new Set(links.flatMap((l) => l.evidence.filter((e) => e.kind === "node" && !nodes.has(e.ref)).map((e) => e.ref)))];
	const local = summaries(sql, evidence);
	for (const id of evidence) if (local.has(id)) nodes.set(id, local.get(id)!); else ids.add(id);
	return [...ids];
}

export function explore(sql: SqlStorage, q: ExploreQuery) {
	const start = resolve(sql, q.node), b = newBudget(q.maxEdges), nodes = summaries(sql, [start]);
	const links = walk(sql, [start], q.depth, { ...(q.rels ? { rels: q.rels } : {}), ...(q.asOf ? { asOf: q.asOf } : {}), similarity: true, known: q.known }, b, nodes);
	const foreign = foreignOf(sql, links, nodes, []);
	return { start, node: nodes.get(start) ?? null, links, nodes: Object.fromEntries(nodes), foreign, events: nodes.has(start) ? nodeEvents(sql, start, EVENTS).events : [], budget: b };
}

/** `why` walks the reasoning and cause relations out of `from`; `step` and `detail` serve the Worker's path search. */
export function trace(sql: SqlStorage, q: TraceQuery) {
	const b = newBudget(q.maxEdges);
	if (q.mode === "step") return { edges: edgesOf(sql, q.ids, { ...(q.asOf ? { asOf: q.asOf } : {}), similarity: q.similarity, known: q.known }, b, "path edges"), budget: b };
	if (q.mode === "detail") {
		const edges = q.edges.length ? sql.exec<EdgeRow>(`SELECT ${EDGE_COLS} FROM edges WHERE id IN (SELECT value FROM json_each(?))
			AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.src AND n.${READABLE_NODE})`, JSON.stringify(q.edges)).toArray() : [];
		return { links: withEvidence(sql, edges.map((e) => ({ ...e, depth: 0 }))), nodes: Object.fromEntries(summaries(sql, q.nodes)), budget: b };
	}
	const from = resolve(sql, q.from), nodes = summaries(sql, [from]);
	const chain = walk(sql, [from], q.maxDepth, { ...(q.asOf ? { asOf: q.asOf } : {}), rels: WHY, out: true, similarity: false, known: q.known }, b, nodes);
	const foreign = foreignOf(sql, chain, nodes, []);
	return { start: from, chain, nodes: Object.fromEntries(nodes), foreign, budget: b };
}

type Event = { at: string; event: string; node_id: string | null } & Record<string, unknown>;
const byInstant = (x: Event, y: Event) => Date.parse(x.at) - Date.parse(y.at);

/**
 * A node's revisions and appended entries, through its own indexes, oldest first: the newest `limit` of each without a window;
 * with one, the first `limit` of each in [from, to) plus its links recorded or ended there. `more` says a source had more.
 */
function nodeEvents(sql: SqlStorage, id: string, limit: number, w?: { from: string; to: string; known: string[] }): { events: Event[]; more: boolean } {
	const dir = w ? "ASC" : "DESC";
	const range = (col: string) => (w ? ` AND julianday(${col}) >= julianday(?) AND julianday(${col}) < julianday(?)` : "");
	const rp = w ? [w.from, w.to] : [];
	const revs = sql.exec<{ revision: number; op: string; at: string; actor: string }>(
		`SELECT revision, op, at, actor FROM revisions WHERE node_id = ?${range("at")} ORDER BY julianday(at) ${dir}, revision ${dir} LIMIT ?`, id, ...rp, limit + 1).toArray();
	const has = new Set(revs.map((r) => r.revision));
	// An imported append has both a revision row and its entry; the revision row stands for it.
	const entries = sql.exec<{ revision: number; seq_no: number; at: string; actor: string }>(
		`SELECT revision, seq_no, created_at AS at, actor FROM texts WHERE node_id = ? AND part = 'entry' AND chunk = 0${range("created_at")} ORDER BY julianday(created_at) ${dir}, seq_no ${dir} LIMIT ?`, id, ...rp, limit + 1).toArray();
	const inWindow = (at: string | null): at is string => !!at && !!w && Date.parse(at) >= Date.parse(w.from) && Date.parse(at) < Date.parse(w.to);
	const recorded = "julianday(recorded_at)", ended = "julianday(ended_at)";
	const time = `((${recorded} >= julianday(?1) AND ${recorded} < julianday(?2)) OR (${ended} >= julianday(?1) AND ${ended} < julianday(?2)))`;
	// Sort each edge by its first event in the window, including an end of an older link, before limiting.
	const first = `CASE WHEN ${recorded} >= julianday(?1) AND ${recorded} < julianday(?2) THEN
		CASE WHEN ${ended} >= julianday(?1) AND ${ended} < julianday(?2) THEN min(${recorded}, ${ended}) ELSE ${recorded} END ELSE ${ended} END`;
	const edges = w ? sql.exec<EdgeRow>(`SELECT ${EDGE_COLS}, ${first} AS event_at FROM edges
		WHERE (src = ?3 OR (dst_profile IN (SELECT value FROM json_each(?4)) AND dst = ?3)) AND ${time}
		AND src IN (SELECT id FROM nodes WHERE ${READABLE_NODE}) ORDER BY event_at, id LIMIT ?5`,
		w.from, w.to, id, JSON.stringify(["", ...w.known]), limit + 1).toArray() : [];
	const events: Event[] = [
		...revs.slice(0, limit).map((r) => ({ at: r.at, event: `revision:${r.op}`, node_id: id, revision: r.revision, actor: r.actor })),
		...entries.slice(0, limit).filter((e) => !has.has(e.revision)).map((e) => ({ at: e.at, event: "entry", node_id: id, revision: e.revision, entry_seq: e.seq_no, actor: e.actor })),
		...edges.slice(0, limit).flatMap((e) => [
			...(inWindow(e.recorded_at) ? [{ at: e.recorded_at, event: "link_recorded", node_id: id, edge_id: e.id, rel: e.rel, src: e.src, dst: e.dst, basis: e.basis }] : []),
			...(inWindow(e.ended_at) ? [{ at: e.ended_at, event: "link_ended", node_id: id, edge_id: e.id, rel: e.rel, src: e.src, dst: e.dst, basis: e.basis }] : []),
		]),
	].sort(byInstant);
	return { events: w ? events : events.slice(-limit), more: [revs, entries, edges].some((r) => r.length > limit) };
}

/**
 * Dated events in [from, to): for one node, its own history; otherwise the activity log (through activity_at) plus the
 * imported revisions, which keep their original times. `truncated` says more events fall in the window.
 */
export function timeline(sql: SqlStorage, q: TimelineQuery) {
	if (q.node) {
		const id = resolve(sql, q.node);
		const { events, more } = nodeEvents(sql, id, q.limit, { from: q.from, to: q.to, known: q.known });
		return { node: summaries(sql, [id]).get(id) ?? { id }, events: events.slice(0, q.limit), truncated: more || events.length > q.limit };
	}
	const kinds = q.kinds?.length ? JSON.stringify(q.kinds) : null;
	const activity = sql.exec<{ id: number; at: string; actor: string; op: string; summary: string; targets: string; redacted: string | null }>(
		`SELECT a.id, a.at, a.actor, a.op, a.summary, a.targets, a.redacted FROM activity a WHERE julianday(a.at) >= julianday(?) AND julianday(a.at) < julianday(?) AND a.op <> 'import'
		 ${kinds ? "AND EXISTS (SELECT 1 FROM json_each(a.targets) t JOIN nodes n ON n.id = t.value WHERE n.kind IN (SELECT value FROM json_each(?)))" : ""}
		 ORDER BY julianday(a.at), a.id LIMIT ?`, q.from, q.to, ...(kinds ? [kinds] : []), q.limit + 1).toArray();
	// shortcut: revisions has no index on `at`, so this scans the profile's revisions; add revisions (at) in profile v4 to bound it.
	const imported = sql.exec<{ node_id: string; revision: number; op: string; at: string; kind: string; name: string }>(
		`SELECT r.node_id, r.revision, r.op, r.at, n.kind, n.name FROM revisions r JOIN nodes n ON n.id = r.node_id
		 WHERE r.actor = 'migration' AND n.${READABLE_NODE} AND julianday(r.at) >= julianday(?) AND julianday(r.at) < julianday(?)${kinds ? " AND n.kind IN (SELECT value FROM json_each(?))" : ""} ORDER BY julianday(r.at), r.node_id, r.revision LIMIT ?`,
		q.from, q.to, ...(kinds ? [kinds] : []), q.limit + 1).toArray();
	const events: Event[] = [
		...activity.map((a) => ({ at: a.at, event: `activity:${a.op}`, node_id: null, activity_id: a.id, actor: a.actor, summary: a.summary, targets: JSON.parse(a.targets) as string[], ...(a.redacted ? { redacted: a.redacted } : {}) })),
		...imported.map((r) => ({ at: r.at, event: `revision:${r.op}`, node_id: r.node_id, revision: r.revision, kind: r.kind, name: r.name, actor: "migration" })),
	].sort(byInstant);
	return { node: null, events: events.slice(0, q.limit), truncated: events.length > q.limit };
}

/**
 * Recall's graph channel (section 11): a one-hop walk from the top 10 seeds over current identifier and judgment edges in the
 * structural, work and reasoning classes, inside this profile, reading at most 1,000 edge rows including the degree count.
 * A neighbour scores the sum of its seeds' scores times the relation weight, divided by 1 + ln(degree).
 */
export function expandLinks(sql: SqlStorage, seeds: { id: string; score: number }[], asOf?: string) {
	const b = newBudget(EXPAND_ROWS), top = seeds.slice(0, SEEDS), score = new Map(top.map((s) => [s.id, s.score]));
	const acc = new Map<string, { sum: number; best: number; via: { from: string; rel: Rel; basis: string; reason: string | null } }>();
	for (const e of edgesOf(sql, top.map((s) => s.id), { rels: EXPAND_RELS, bases: ["identifier", "judgment"], similarity: false, known: [], ...(asOf ? { asOf } : {}) }, b, "seed links")) {
		for (const [seed, n, out] of [[e.src, e.dst, true], [e.dst, e.src, false]] as const) {
			// Recall never follows a link into another profile.
			if (!score.has(seed) || (out && e.dst_profile !== "")) continue;
			const c = score.get(seed)! * EXPAND_WEIGHT[REL_CLASS[e.rel]]!;
			const cur = acc.get(n);
			if (!cur) acc.set(n, { sum: c, best: c, via: { from: seed, rel: e.rel, basis: e.basis, reason: e.reason } });
			else { cur.sum += c; if (c > cur.best) { cur.best = c; cur.via = { from: seed, rel: e.rel, basis: e.basis, reason: e.reason }; } }
		}
	}
	// Degree counts current links; ended ones are read and dropped here, so they count against the budget as well.
	const ids = [...acc.keys()], degree = new Map<string, number>(), room = b.limit - b.edges_read - 6 * ids.length - 2;
	if (ids.length && room <= 0) stop(b, "degree");
	else if (ids.length) {
		const list = JSON.stringify(ids);
		const cursor = sql.exec<{ id: string; ended_at: string | null }>(`SELECT src AS id, ended_at FROM edges WHERE src IN (SELECT value FROM json_each(?))
			UNION ALL SELECT dst, ended_at FROM edges WHERE dst_profile = '' AND dst IN (SELECT value FROM json_each(?)) LIMIT ?`, list, list, room);
		const rows = cursor.toArray();
		b.edges_read += cursor.rowsRead;
		if (rows.length >= room) stop(b, "degree");
		for (const r of rows) if (r.ended_at === null) degree.set(r.id, (degree.get(r.id) ?? 0) + 1);
	}
	const neighbors = ids.map((id) => ({ id, score: acc.get(id)!.sum / (1 + Math.log(Math.max(1, degree.get(id) ?? 1))), via: acc.get(id)!.via }))
		.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
	if (neighbors.length > EXPAND_KEEP) { b.skipped += neighbors.length - EXPAND_KEEP; b.stopped ??= "graph channel cap"; }
	return { neighbors: neighbors.slice(0, EXPAND_KEEP), budget: b };
}
