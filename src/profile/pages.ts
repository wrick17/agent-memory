import { importDelivery, policyOf, currentImportFields, POLICY_ATTRS_SQL } from "../domain/import-policy";
// Owner page reads over one profile (section 15): a node's entity page, the map, a node's timeline, journals and activity.
// Read-only and bounded: nothing is written, bound or stamped. A record that is not shown here (still landing, moving, moved away,
// a candidate, or a capture, which review_candidates reads) answers not_found before anything about it is read. Text comes through
// the shared visibility rule and fence (compact.ts), links through the graph's own owned, budgeted reads (graph.ts); a far end that
// is not a shown node here stays {id, readable: false}. With as_of a node shows its stored state then (read.ts pastOf).
import { Fail, type NodeKind } from "../domain/types";
import { fenceOf, VISIBLE } from "./compact";
import { EDGE_ROWS, explore, newBudget, READABLE_NODE, REL_CLASS, summaries, timeline, walk, type GraphLink, type NodeSummary } from "./graph";
import { contentPage, pastOf } from "./read";
import { readContent, readPrefix } from "./write";

/**
 * `before` asks for one more page of revision history only; `content` pages the whole content, bound to its revision (and as_of).
 * `known` lists the account's profile names, as in graph reads.
 */
export interface EntityQuery { kind: "entity"; node: { id: string } | { key: string }; asOf?: string; before?: number; content?: { cursor?: string }; known: string[] }
/** The map (section 15): links around `center`, or around the profile's newest active projects, at most 300 nodes. */
export interface MapQuery { kind: "map"; center?: { id: string } | { key: string }; depth: number; asOf?: string; known: string[] }
/** A node's own timeline, or the profile's, in [from, to) at most 90 days apart (the Worker checks the window). */
export interface PageTimelineQuery { kind: "page_timeline"; from: string; to: string; node?: { id: string } | { key: string }; kinds?: NodeKind[]; limit: number; known: string[] }
/** The activity log, newest first; `before` is the previous page's `next_before`, `actor` keeps one actor's changes. */
export interface ActivityQuery { kind: "activity"; before: number | null; limit: number; actor?: string }
/** Which of `ids` are nodes shown here, so the Worker refuses a path between records this profile does not show. */
export interface ShownQuery { kind: "shown"; ids: string[] }
/** The profile's active journals, newest change first; `after` is the previous page's `next_after`. */
export interface JournalsQuery { kind: "journals"; after: string | null; limit: number }
/** One journal's entries after entry `after` (an entry_seq, not a revision); the first page also carries its summary and compactions. */
export interface JournalQuery { kind: "journal"; id: string; after: number; limit: number }

const SHOWN_STATUS = ["active", "retired", "superseded"];
const SHOWN = `${READABLE_NODE} AND NOT (kind = 'other' AND other_label IS 'capture')`;
const isShown = (n: { status: string; kind: string; other_label: string | null } | undefined): n is NodeSummary =>
	!!n && SHOWN_STATUS.includes(n.status) && !(n.kind === "other" && n.other_label === "capture");
export const MAP_NODES = 300, ACTIVITY_MAX = 100;
const MAP_STARTS = 20;
/** Long node fields and the content prefix return at most this many characters, with their full length. */
export const TEXT_MAX = 4_000;
const EVIDENCE_MAX = 50, HISTORY = 20, EVENTS = 100, COMPACTIONS = 10;
export const JOURNALS_MAX = 100, ENTRIES_MAX = 25;
/** Columns that never change once a row exists; with as_of the rest of a node comes from its stored snapshot then. */
const FIXED = "id, kind, other_label, key, memory_type, origin, recorded_at, created_at, source_profile, source_id, source_revision";
const PEOPLE = ["works_on", "authored", "reviewed", "reported", "assigned"];
const END = "9999-12-31T23:59:59.999Z";
const LONG = ["description", "why", "how_to_apply", "objective", "steps", "attrs"] as const;
const RAW = `id, kind, other_label, key, memory_type, scope, name, status, origin, pinned, flagged, revision, chars, content_hash, valid_from, valid_to,
	recorded_at, ended_at, created_at, updated_at, last_used_at, source_profile, source_id, source_revision, source_platform, updated_source_platform,
	${LONG.map((c) => `substr(${c}, 1, ${TEXT_MAX}) AS ${c}, length(${c}) AS ${c}_chars`).join(", ")}`;

type Row = Record<string, SqlStorageValue>;
type Other = { id: string; readable: false } | { id: string; readable: true; kind: string; other_label: string | null; key: string | null; name: string; status: string };

function shown(sql: SqlStorage, ref: EntityQuery["node"]): string {
	const row = ("id" in ref ? sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id = ? AND ${SHOWN}`, ref.id)
		: sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE key = ? AND ${SHOWN}`, ref.key)).toArray()[0];
	if (!row) throw Fail.of("not_found", `no node matches '${"id" in ref ? ref.id : ref.key}' in this profile`);
	return row.id;
}

/**
 * Stored revision records, newest first, metadata only: a snapshot can hold a whole body, so it never leaves the store here; a
 * compaction's delta is its small fence record. Appended entries have their own sequence and are paged with the journal.
 */
function history(sql: SqlStorage, id: string, before: number | undefined, asOf: number) {
	const rows = sql.exec<{ revision: number; op: string; at: string; actor: string; device_id: string | null; request_id: string | null; delta: string | null }>(
		`SELECT revision, op, at, actor, device_id, request_id, CASE WHEN op = 'compacted' THEN delta END AS delta FROM revisions
		WHERE node_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?`, id, before ?? Number.MAX_SAFE_INTEGER, HISTORY + 1).toArray();
	const items = rows.slice(0, HISTORY).map(({ delta, ...r }) => ({ ...r, ...(delta ? { compaction: JSON.parse(delta) as Record<string, number> } : {}),
		...(asOf < Infinity ? { after_as_of: !(Date.parse(r.at) <= asOf) } : {}) }));
	return { items, next_before: rows.length > HISTORY ? items.at(-1)!.revision : null };
}

function link(l: GraphLink, id: string, nodes: Record<string, NodeSummary>) {
	const out = l.src === id, far = out ? l.dst : l.src, n = nodes[far];
	const other: Other = isShown(n)
		? { id: far, readable: true, kind: n.kind, other_label: n.other_label, key: n.key, name: n.name, status: n.status } : { id: far, readable: false };
	return { id: l.id, rel: l.rel, other_label: l.other_label, class: l.class, direction: out ? "out" : "in", basis: l.basis, reason: l.reason, score: l.score,
		weight: l.weight, valid_from: l.valid_from, valid_to: l.valid_to, recorded_at: l.recorded_at, ended_at: l.ended_at, evidence: l.evidence, other };
}

/** The node at as_of: fixed columns, then its stored snapshot's fields then, long ones cut to TEXT_MAX; attrs keep no history, so null. */
function nodeAt(sql: SqlStorage, id: string, p: NonNullable<ReturnType<typeof pastOf>>): Row {
	const s = p.snap, field = (k: string) => (typeof s[k] === "string" ? s[k] as string : null);
	const long = Object.fromEntries(LONG.flatMap((c) => {
		const v = c === "steps" ? (Array.isArray(s.steps) ? JSON.stringify(s.steps) : null) : c === "attrs" ? null : field(c);
		return [[c, v?.slice(0, TEXT_MAX) ?? null], [`${c}_chars`, v?.length ?? null]];
	}));
	return { ...sql.exec<Row>(`SELECT ${FIXED} FROM nodes WHERE id = ?`, id).one(), name: field("name"), scope: field("scope"), status: p.status, revision: p.revision,
		valid_from: field("_valid_from"), valid_to: field("_valid_until"), updated_at: p.recorded_at, source_platform: field("_source_platform"),
		updated_source_platform: field("_updated_source_platform"), content_hash: p.contentHash, ...long };
}

/**
 * What a node is (its bounded raw row and content prefix), its own evidence, who worked on it, its links with reason and evidence,
 * its dated timeline and revision history. With `asOf`: the node's fields and content are its stored state then (null where its
 * history does not hold them; content null when it cannot be rebuilt), links recorded by then and valid then, the timeline up to
 * then, and history flagged by date. Evidence and `current` are today's. A node with no stored record by then is refused.
 */
export function entity(sql: SqlStorage, q: EntityQuery) {
	const ms = q.asOf === undefined ? Infinity : Date.parse(q.asOf);
	if (Number.isNaN(ms)) throw Fail.of("validation", "as_of must be an ISO date");
	const asOf = ms < Infinity ? new Date(ms).toISOString() : undefined;
	const id = shown(sql, q.node);
	const currentAttrs = sql.exec<{attrs:string}>(`SELECT ${POLICY_ATTRS_SQL} AS attrs FROM nodes WHERE id = ?`,id).one().attrs;
	const delivery = importDelivery(currentAttrs);
	const delivered = <T extends object>(value:T) => {
		const out = {...value,...delivery,...(asOf && policyOf(currentAttrs) ? {current_delivery:currentImportFields(currentAttrs)} : {})};
		if (Buffer.byteLength(JSON.stringify(out),"utf8") > 1_000_000) throw Fail.of("size_budget","entity response exceeds 1,000,000 bytes");
		return out;
	};
	const raw = sql.exec<Row>(`SELECT ${RAW} FROM nodes WHERE id = ?`, id).one();
	const past = asOf ? pastOf(sql, { id, revision: Number(raw.revision) }, asOf, true) : undefined;
	if (asOf && !past?.started) throw Fail.of("not_found", "this node has no stored record dated at or before as_of", { reason: "after_as_of" });
	if (q.before !== undefined) return delivered({ id, as_of: asOf ?? null, history: history(sql, id, q.before, ms) });
	if (q.content) {
		// The whole content in 100k-character pages, each cursor bound to the revision shown (and to as_of).
		const full = past ? past.content : readContent(sql, id);
		if (full == null) throw Fail.of("not_found", "this node's content at as_of cannot be rebuilt from what is stored", { reason: "content_unknown" });
		const bind = past ? { id, revision: past.revision, content_hash: `${String(raw.content_hash)}@${String(raw.revision)}` } : { id, revision: Number(raw.revision), content_hash: String(raw.content_hash) };
		return delivered({ id, as_of: asOf ?? null, content: contentPage(bind, full, { complete: true, ...(q.content.cursor ? { cursor: q.content.cursor } : {}) }, asOf) });
	}
	const node = past ? nodeAt(sql, id, past) : raw;
	const ex = explore(sql, { kind: "explore", node: { id }, depth: 1, known: q.known, maxEdges: EDGE_ROWS, ...(asOf ? { asOf } : {}) });
	const links = ex.links.filter((l) => !asOf || Date.parse(l.recorded_at) <= ms).map((l) => link(l, id, ex.nodes));
	const people = new Map<string, { id: string; name: string; key: string | null; rels: string[] }>();
	for (const l of links) {
		if (!l.other.readable || l.other.kind !== "person" || !PEOPLE.includes(l.rel)) continue;
		const p = people.get(l.other.id) ?? people.set(l.other.id, { id: l.other.id, name: l.other.name, key: l.other.key, rels: [] }).get(l.other.id)!;
		if (!p.rels.includes(l.rel)) p.rels.push(l.rel);
	}
	const evidence = sql.exec<{ kind: string; ref: string; note: string | null }>("SELECT kind, ref, note FROM evidence WHERE owner = ? ORDER BY kind, ref LIMIT ?", `n:${id}`, EVIDENCE_MAX + 1).toArray();
	const text = past ? past.content?.slice(0, TEXT_MAX) ?? null : readPrefix(sql, id, TEXT_MAX);
	const chars = past ? past.content?.length ?? null : Number(raw.chars);
	const tl = timeline(sql, { kind: "timeline", node: { id }, from: "0000-01-01T00:00:00.000Z", to: asOf ? new Date(ms + 1).toISOString() : END, limit: EVENTS, known: q.known });
	return delivered({
		id, as_of: asOf ?? null,
		...(asOf ? { note: "as_of selects the node's stored state then, links recorded by then and valid then, and the timeline up to then; history marks later revisions. Evidence and current are today's.",
			current: { status: raw.status, revision: raw.revision, pinned: raw.pinned !== 0, flagged: raw.flagged } } : {}),
		node: { ...node, ...(past ? {} : { pinned: raw.pinned !== 0 }), truncated: LONG.filter((c) => Number(node[`${c}_chars`] ?? 0) > TEXT_MAX) },
		content: { text, chars, complete: text !== null && chars !== null && text.length >= chars, ...(past ? { known: past.content != null } : {}) },
		evidence: { items: evidence.slice(0, EVIDENCE_MAX), truncated: evidence.length > EVIDENCE_MAX },
		people: [...people.values()], links, budget: ex.budget,
		timeline: { events: asOf ? tl.events.filter((e) => Date.parse(e.at) <= ms) : tl.events, truncated: tl.truncated },
		history: history(sql, id, undefined, ms),
	});
}

function position(after: string): [string, string] {
	let k: unknown;
	try { k = after.length <= 512 ? JSON.parse(after) : null; } catch { k = null; }
	if (!Array.isArray(k) || k.length !== 2 || typeof k[0] !== "string" || typeof k[1] !== "string" || !k[1]) {
		throw Fail.of("validation", "journals cursor is not valid; start again without after");
	}
	return k as [string, string];
}

/** Active journals, compacted or not, by (updated_at, id) descending through nodes_kind; each with its fence and newest entry. */
export function journals(sql: SqlStorage, q: JournalsQuery) {
	if (!Number.isInteger(q.limit) || q.limit < 1) throw Fail.of("validation", "limit must be a whole number of at least 1");
	const limit = Math.min(q.limit, JOURNALS_MAX), key = q.after === null ? null : position(q.after);
	const rows = sql.exec<{ id: string; updated_at: string; attrs: string; pinned: number; summarized: number } & Row>(
		`SELECT n.id, n.name, n.scope, n.memory_type AS type, n.status, n.origin, n.pinned, n.flagged, n.revision, n.chars, n.created_at, n.updated_at,
			substr(n.description, 1, 280) AS description, n.attrs,
			(SELECT t.seq_no FROM texts t WHERE t.node_id = n.id AND t.part = 'entry' AND t.live <> 0 ORDER BY t.seq_no DESC LIMIT 1) AS latest_entry_seq,
			EXISTS (SELECT 1 FROM texts t WHERE t.node_id = n.id AND t.part = 'summary' AND t.live <> 0) AS summarized
		FROM nodes n WHERE n.kind = 'journal' AND n.status = 'active'${key ? " AND (n.updated_at, n.id) < (?, ?)" : ""}
		ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, ...(key ?? []), limit + 1).toArray();
	const page = rows.slice(0, limit), last = page.at(-1);
	return {
		items: page.map(({ attrs, pinned, summarized, ...r }) => ({ ...r, pinned: pinned !== 0, compacted_through: fenceOf(attrs), summarized: summarized === 1 })),
		next_after: rows.length > limit && last ? JSON.stringify([last.updated_at, last.id]) : null,
	};
}

/**
 * One journal's entries in entry_seq order, each its first stored part (16,000 characters at most) with its part count; `current`
 * is the shared visibility rule, so an entry at or under the fence reads as compacted into the summary. Entries a later content
 * replacement took out of the journal are not listed. The first page adds the current summary and the newest compactions.
 */
export function journal(sql: SqlStorage, q: JournalQuery) {
	if (!Number.isInteger(q.limit) || q.limit < 1 || !Number.isSafeInteger(q.after) || q.after < 0) throw Fail.of("validation", "limit must be at least 1 and after an entry number");
	const n = sql.exec<{ id: string; attrs: string } & Row>(`SELECT id, name, scope, memory_type AS type, status, origin, revision, chars, created_at, updated_at, attrs
		FROM nodes WHERE id = ? AND kind = 'journal' AND ${SHOWN}`, q.id).toArray()[0];
	if (!n) throw Fail.of("not_found", `no journal '${q.id}' in this profile`);
	const limit = Math.min(q.limit, ENTRIES_MAX), { attrs, ...head } = n;
	const rows = sql.exec<{ entry_seq: number; revision: number; body: string; created_at: string; actor: string; request_id: string | null; current: number; parts: number }>(
		`SELECT t.seq_no AS entry_seq, t.revision, t.body, t.created_at, t.actor, t.request_id, (${VISIBLE}) AS current,
			(SELECT count(*) FROM texts c WHERE c.node_id = t.node_id AND c.part = 'entry' AND c.seq_no = t.seq_no) AS parts
		FROM texts t JOIN nodes n ON n.id = t.node_id
		WHERE t.node_id = ? AND t.part = 'entry' AND t.chunk = 0 AND t.live <> 0 AND t.seq_no > ? ORDER BY t.seq_no LIMIT ?`, n.id, q.after, limit + 1).toArray();
	const page = rows.slice(0, limit);
	const out = { journal: { ...head, compacted_through: fenceOf(attrs) },
		entries: page.map((r) => ({ ...r, current: r.current === 1, complete: r.parts === 1 })), next_after: rows.length > limit ? page.at(-1)!.entry_seq : null };
	if (q.after > 0) return out;
	const summaries = (where: string, ...params: SqlStorageValue[]) => sql.exec<{ revision: number; body: string; current: number; created_at: string; actor: string; parts: number }>(
		`SELECT t.revision, t.body, (t.live <> 0) AS current, t.created_at, t.actor,
			(SELECT count(*) FROM texts c WHERE c.node_id = t.node_id AND c.part = 'summary' AND c.revision = t.revision) AS parts
		FROM texts t WHERE t.node_id = ? AND t.part = 'summary' AND t.chunk = 0 AND ${where} ORDER BY t.revision DESC`, n.id, ...params).toArray()
		.map((s) => ({ ...s, current: s.current === 1, complete: s.parts === 1 }));
	const comps = sql.exec<{ revision: number; at: string; actor: string; delta: string | null }>(
		"SELECT revision, at, actor, delta FROM revisions WHERE node_id = ? AND op = 'compacted' ORDER BY revision DESC LIMIT ?", n.id, COMPACTIONS + 1).toArray();
	const listed = comps.slice(0, COMPACTIONS).map(({ delta, ...c }) => ({ ...c, ...(JSON.parse(delta ?? "{}") as { from_seq?: number; through_seq?: number; summary_revision?: number }) }));
	const texts = new Map(summaries("t.revision IN (SELECT value FROM json_each(?))", JSON.stringify(listed.map((c) => c.summary_revision ?? c.revision))).map((s) => [s.revision, s]));
	return { ...out, summary: summaries("t.live <> 0")[0] ?? null,
		compactions: listed.map((c) => ({ ...c, summary: texts.get(c.summary_revision ?? c.revision) ?? null })), compactions_more: comps.length > COMPACTIONS };
}

/**
 * The map (section 15): one walk from the center, or from the profile's newest active projects, depth 1 or 2, under the graph's
 * edge budget, then cut at 300 nodes in walk order. With as_of, links recorded by then and valid then. Far ends not shown here are opaque.
 */
export function map(sql: SqlStorage, q: MapQuery) {
	const starts = q.center ? [shown(sql, q.center)]
		: sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE kind = 'project' AND status = 'active' ORDER BY updated_at DESC, id LIMIT ?`, MAP_STARTS).toArray().map((r) => r.id);
	const b = newBudget(EDGE_ROWS), found = summaries(sql, starts);
	const all = walk(sql, starts, q.depth, { similarity: true, known: q.known, ...(q.asOf ? { asOf: q.asOf, recordedBy: q.asOf } : {}) }, b, found, MAP_NODES);
	const kept = new Set(starts), links: GraphLink[] = [];
	let truncated = false;
	for (const l of all) {
		const add = [l.src, l.dst].filter((x) => !kept.has(x));
		if (kept.size + add.length > MAP_NODES) { truncated = true; continue; }
		for (const x of add) kept.add(x);
		links.push(l);
	}
	const end = (x: string) => (isShown(found.get(x)) ? { id: x, readable: true as const } : { id: x, readable: false as const });
	return {
		center: q.center ? starts[0]! : null, starts, depth: q.depth, as_of: q.asOf ?? null,
		nodes: [...kept].flatMap((x) => { const n = found.get(x); return isShown(n) ? [{ id: n.id, kind: n.kind, other_label: n.other_label, key: n.key, name: n.name, type: n.type, status: n.status }] : []; }),
		links: links.map((l) => ({ id: l.id, rel: l.rel, other_label: l.other_label, class: REL_CLASS[l.rel], basis: l.basis, reason: l.reason, score: l.score, weight: l.weight, depth: l.depth,
			from: end(l.src), to: end(l.dst), valid_from: l.valid_from, valid_to: l.valid_to, recorded_at: l.recorded_at, ended_at: l.ended_at })),
		truncated: truncated || b.exhausted, budget: b, limits: { nodes: MAP_NODES, edge_rows: EDGE_ROWS },
	};
}

/** The whole graph as metadata (section 15): `part` pages every shown node, or every current link, by keyset; `after` is the last page's `next_after`. */
export interface GraphQuery { kind: "graph"; part: "nodes" | "edges"; after: string | null; limit: number }
export const GRAPH_LIMITS = { nodes: 1_000, edges: 2_000 }, GRAPH_BYTES = 512 * 1024;
const COUNT_ROWS = 50_000;
type GraphCursor = { p: string; a: string | number; n: string; g: string; w: string };

/**
 * One page of the whole graph, metadata only: nodes by id (every node shown here, linked or not) or current links by edge id. A page
 * reads at most `limit` raw rows and its whole JSON response stays within GRAPH_BYTES (UTF-8), so it can hold fewer items than asked with
 * more to come; a row that does not fit is left for the next page. `done` says the walk is over. Readability applies again on every page: a link's src is a shown node, a dst that is not one stays
 * {id, readable: false} as on the map, and a link touching a record still landing or moving is left out. No bodies, reasons or
 * evidence. The cursor carries the profile, generation and the write_seq the walk began at; `changed` says the profile was written
 * since. That is a signal, not a point-in-time view.
 */
export function graph(sql: SqlStorage, q: GraphQuery) {
	if (!Number.isInteger(q.limit) || q.limit < 1) throw Fail.of("validation", "limit must be a whole number of at least 1");
	const meta = Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key IN ('profile','generation','write_seq')").toArray().map((r) => [r.key, r.value]));
	const here = { n: meta.profile ?? "", g: meta.generation ?? "", w: meta.write_seq ?? "0" };
	let at: GraphCursor | null = null;
	if (q.after !== null) {
		try { at = q.after.length <= 1024 ? JSON.parse(Buffer.from(q.after, "base64url").toString("utf8")) as GraphCursor : null; } catch { at = null; }
		if (!at || typeof at !== "object" || at.p !== q.part || at.n !== here.n || at.g !== here.g || typeof at.w !== "string"
			|| (q.part === "nodes" ? typeof at.a !== "string" : !Number.isSafeInteger(at.a))) throw Fail.of("validation", "graph cursor is not valid for this part and profile; start again without after");
	}
	const limit = Math.min(q.limit, GRAPH_LIMITS[q.part]), began = at?.w ?? here.w, changed = began !== here.w, items: unknown[] = [];
	let total: number | null | undefined;
	if (q.part === "nodes" && q.after === null) {
		// Exact under COUNT_ROWS raw rows, else null: the count never scans past that cap.
		const c = sql.exec<{ raw: number; shown: number | null }>(`SELECT count(*) AS raw, sum(${SHOWN}) AS shown FROM (SELECT status, kind, other_label FROM nodes LIMIT ?)`, COUNT_ROWS).one();
		total = c.raw < COUNT_ROWS ? c.shown ?? 0 : null;
	}
	const envelope = (next_after: string | null) => ({ part: q.part, next_after, done: next_after === null, changed, ...(total !== undefined ? { total } : {}), limits: { items: limit, bytes: GRAPH_BYTES } });
	const cursor = (a: string | number) => Buffer.from(JSON.stringify({ p: q.part, a, n: here.n, g: here.g, w: began } satisfies GraphCursor), "utf8").toString("base64url");
	// The response with no items and an empty cursor; the cursor is ASCII, and the last page's null cursor and done:true are smaller.
	const fixed = Buffer.byteLength(JSON.stringify({ ...envelope(""), items: [] }), "utf8");
	let bytes = 0, read = 0, rows = 0, last: string | number | null = null;
	/** Consumes one raw row, its item (if shown) included, only if the whole response would still fit with this row's cursor. */
	const fits = (id: string | number, item: unknown) => {
		const size = item === null ? 0 : Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length ? 1 : 0);
		if (fixed + cursor(id).length + bytes + size > GRAPH_BYTES) {
			if (read === 0) throw Fail.of("size_budget", "one graph record does not fit a page");
			return false;
		}
		bytes += size; read++; last = id;
		if (item !== null) items.push(item);
		return true;
	};
	if (q.part === "nodes") {
		// Raw rows in id order, filtered here: tombstones and captures cost their own row, never a longer scan.
		const page = sql.exec<{ id: string; kind: string; other_label: string | null; key: string | null; name: string; type: string | null; scope: string; status: string; origin: string; pinned: number; flagged: string | null; created_at: string; updated_at: string }>(
			`SELECT id, kind, substr(other_label, 1, 80) AS other_label, substr(key, 1, 256) AS key, substr(name, 1, 200) AS name, memory_type AS type, substr(scope, 1, 200) AS scope,
				status, origin, pinned, flagged, created_at, updated_at FROM nodes WHERE id > ? ORDER BY id LIMIT ?`, (at?.a as string | undefined) ?? "", limit).toArray();
		rows = page.length;
		for (const n of page) if (!fits(n.id, isShown(n) ? { ...n, pinned: n.pinned !== 0, flagged: n.flagged !== null } : null)) break;
	} else {
		const page = sql.exec<{ id: number; src: string; dst: string; rel: keyof typeof REL_CLASS; other_label: string | null; basis: string; score: number | null; weight: number; valid_from: string | null; valid_to: string | null; recorded_at: string; ended_at: string | null }>(
			`SELECT id, src, dst, rel, substr(other_label, 1, 80) AS other_label, basis, score, weight, valid_from, valid_to, recorded_at, ended_at FROM edges WHERE id > ? ORDER BY id LIMIT ?`,
			(at?.a as number | undefined) ?? 0, limit).toArray();
		rows = page.length;
		// Ends resolve locally by id whatever profile the link was written toward, as the map's walk does; at most 2 x limit ids.
		const ends = new Map(sql.exec<{ id: string; status: string; kind: string; other_label: string | null }>("SELECT id, status, kind, other_label FROM nodes WHERE id IN (SELECT value FROM json_each(?))",
			JSON.stringify([...new Set(page.filter((e) => e.ended_at === null).flatMap((e) => [e.src, e.dst]))])).toArray().map((n) => [n.id, n]));
		for (const e of page) {
			const far = ends.get(e.dst);
			if (!fits(e.id, e.ended_at !== null || !isShown(ends.get(e.src)) || far?.status === "incoming" || far?.status === "moving" ? null : { id: e.id, rel: e.rel, other_label: e.other_label, class: REL_CLASS[e.rel], basis: e.basis, score: e.score, weight: e.weight,
				src: e.src, dst: { id: e.dst, readable: isShown(far) }, valid_from: e.valid_from, valid_to: e.valid_to, recorded_at: e.recorded_at })) break;
		}
	}
	// Only a short raw page read to its end is the last; a full page or a byte stop may have more after it.
	const next_after = read === rows && rows < limit ? null : cursor(last!);
	return { ...envelope(next_after), items };
}

/** A node's timeline (shown nodes only) or the profile's, through the graph's own read. */
export function pageTimeline(sql: SqlStorage, q: PageTimelineQuery) {
	const { node, kind: _k, ...rest } = q;
	return timeline(sql, { kind: "timeline", ...rest, ...(node ? { node: { id: shown(sql, node) } } : {}) });
}

/** The activity log, newest first, with each change's undo state; `next_before` pages back. Summaries are stored text. */
export function activity(sql: SqlStorage, q: ActivityQuery) {
	if (!Number.isInteger(q.limit) || q.limit < 1) throw Fail.of("validation", "limit must be a whole number of at least 1");
	const limit = Math.min(q.limit, ACTIVITY_MAX);
	const rows = sql.exec<{ id: number; at: string; actor: string; device_id: string | null; op: string; summary: string; targets: string; undone_by: number | null; undo_of: number | null; redacted: string | null; has_undo: number }>(
		`SELECT id, at, actor, device_id, op, summary, targets, undone_by, undo_of, redacted, undo IS NOT NULL AS has_undo FROM activity
		WHERE id < ?${q.actor ? " AND actor = ?" : ""} ORDER BY id DESC LIMIT ?`, q.before ?? Number.MAX_SAFE_INTEGER, ...(q.actor ? [q.actor] : []), limit + 1).toArray();
	const page = rows.slice(0, limit);
	return {
		items: page.map(({ has_undo, targets, redacted, ...r }) => ({ ...r, targets: JSON.parse(targets) as string[], ...(redacted ? { redacted } : {}),
			undo: redacted ? "redacted" : r.undone_by !== null ? "undone" : r.op === "undo" ? "none" : has_undo ? "available" : "none" })),
		next_before: rows.length > limit ? page.at(-1)!.id : null,
	};
}

export function shownIds(sql: SqlStorage, q: ShownQuery): string[] {
	return sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND ${SHOWN}`, JSON.stringify(q.ids)).toArray().map((r) => r.id);
}
