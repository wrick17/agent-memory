// work_board over one profile (section 13): open tickets, bugs, features and PRs scored at read time with one formula, each
// nonzero term explained in words. It reads only this profile. A link's far end that is not a readable node here comes back
// as {id, readable: false}, and nothing follows dst_profile into another store. It covers only what the owner's machines uploaded.
import { Fail } from "../domain/types";
import { EDGE_ROWS, LEVEL_NODES, newBudget, trace, type Budget, type GraphLink } from "./graph";

/**
 * The node attributes the board reads: the contract for local uploaders (AM-12). Uploaders map their sources to these values;
 * the server never calls GitHub or Jira and never guesses who the owner is.
 * - `state`: exactly "open" or "closed". Jira To Do and In Progress map to "open", Done to "closed"; GitHub OPEN to "open",
 *   CLOSED and MERGED to "closed". Only "open" items are scored; any other or missing value keeps the item off the board and
 *   is counted in `without_state`.
 * - `priority`: exactly "Highest", "High", "Medium" or "Low". Missing or null scores as none (0.4); any other value also
 *   scores as none and is listed in the item's `unrecognized`.
 * - `due`: "YYYY-MM-DD", a UTC calendar date counted in whole days from as_of's UTC date; or an ISO 8601 date-time with a Z or
 *   ±hh:mm offset (seconds and up to 3 decimals optional), counted in fractional days from as_of. Anything else scores 0 and
 *   is listed in `unrecognized`.
 * - `assignee_is_owner`, `review_requested_from_owner`: JSON booleans the uploader sets from the owner's own account (Jira
 *   `assignee = currentUser()`, gh `review-requested:@me`). Only true counts; a non-boolean is listed in `unrecognized`.
 */
export const BOARD_ATTRS = ["state", "priority", "due", "assignee_is_owner", "review_requested_from_owner"] as const;
export const BOARD_STATES = ["open", "closed"] as const;
export const PRIORITY: Record<string, number> = { Highest: 1, High: 0.75, Medium: 0.5, Low: 0.25 };
export const NO_PRIORITY = 0.4;
export const BOARD_KINDS = ["ticket", "bug", "feature", "pr"] as const;
/** Linked nodes whose changes count as activity on an item. */
export const ACTIVITY_KINDS = ["journal", "commit", "pr"] as const;
const DAY = 86_400_000, RECENT_DAYS = 7, STALE_DAYS = 14, DUE_DAYS = 14, BLOCKING_CAP = 3;
const W = { priority: 40, due: 25, owner_action: 15, blocking: 10, recent_activity: 10, blocked: -20 } as const;

/**
 * `asOf` is an instant the Worker supplies (now by default); it dates everything the uploaded data can date:
 * - items: active, recorded at or before as_of, with their latest uploaded fields. No historical snapshot is rebuilt.
 * - links: recorded at or before as_of, valid at as_of (the graph's rule), and not ended at as_of.
 * - due: measured from as_of.
 * - activity: an item's own last upload, and a linked journal, commit or PR's last change or the link's recording time. A
 *   change after as_of is replaced by the node's recorded_at, so nothing as_of could not have seen is credited.
 * `known` lists the account's profile names, as in graph reads, so links written while an item lived elsewhere are found.
 */
export interface BoardQuery { kind: "board"; asOf: string; limit: number; known: string[] }
export type BoardRef = { id: string; kind: string; name: string } | { id: string; readable: false };
export type Term = keyof typeof W;
export interface BoardItem {
	id: string; kind: string; key: string | null; name: string; scope: string; priority: string | null; due: string | null;
	score: number; reasons: { term: Term; points: number; text: string }[]; stale: boolean; last_activity_at: string;
	blocked_by: BoardRef[]; blocks: BoardRef[]; unrecognized: string[];
}

type Attrs = Partial<Record<(typeof BOARD_ATTRS)[number], unknown>>;
type Row = { id: string; kind: string; key: string | null; name: string; scope: string; status: string; attrs: string; updated_at: string; recorded_at: string };
type Edge = Omit<GraphLink, "class" | "depth" | "evidence">;
const NODE_COLS = "id, kind, key, name, scope, status, attrs, updated_at, recorded_at";

const round = (x: number) => Math.round(x * 100) / 100;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const signed = (p: number) => (p < 0 ? `${p}` : `+${p}`);
const iso = (ms: number) => new Date(ms).toISOString();

/** Days from as_of to the due value, or null when it is not one of the accepted formats. */
function daysToDue(due: unknown, asOf: string): number | null {
	if (typeof due !== "string") return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
		const t = Date.parse(due);
		return Number.isNaN(t) || iso(t).slice(0, 10) !== due ? null : (t - Date.parse(asOf.slice(0, 10))) / DAY;
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(due)) return null;
	const t = Date.parse(due);
	return Number.isNaN(t) ? null : (t - Date.parse(asOf)) / DAY;
}

/** The latest upload of a node that as_of could have seen: updated_at if it is not later, else recorded_at. */
const seenBy = (n: Row, asOf: string) => (n.updated_at <= asOf ? n.updated_at : n.recorded_at);

export function board(sql: SqlStorage, q: BoardQuery) {
	const ms = Date.parse(q.asOf);
	if (Number.isNaN(ms)) throw Fail.of("validation", "as_of must be an ISO date");
	const asOf = iso(ms), recentFrom = iso(ms - RECENT_DAYS * DAY), staleBefore = iso(ms - STALE_DAYS * DAY);
	const kinds = JSON.stringify(BOARD_KINDS), b: Budget & { candidates: number } = { ...newBudget(EDGE_ROWS), candidates: 0 };

	// shortcut: state lives in attrs, so both reads scan every active item of the four kinds; add an index on it if that grows.
	const counts = sql.exec<{ open: number; without_state: number }>(`SELECT count(*) FILTER (WHERE state = 'open') AS open,
		count(*) FILTER (WHERE state IS NULL OR state NOT IN (SELECT value FROM json_each(?))) AS without_state
		FROM (SELECT json_extract(attrs, '$.state') AS state FROM nodes WHERE kind IN (SELECT value FROM json_each(?)) AND status = 'active' AND recorded_at <= ?)`,
	JSON.stringify(BOARD_STATES), kinds, asOf).one();
	// At most 200 candidates, the most recently uploaded first; the rest are counted in skipped.
	const cands = sql.exec<Row>(`SELECT ${NODE_COLS} FROM nodes WHERE kind IN (SELECT value FROM json_each(?)) AND status = 'active' AND recorded_at <= ?
		AND json_extract(attrs, '$.state') = 'open' ORDER BY updated_at DESC, id LIMIT ?`, kinds, asOf, LEVEL_NODES).toArray();
	b.candidates = cands.length;
	if (counts.open > cands.length) { b.exhausted = true; b.stopped = "candidates"; b.skipped = counts.open - cands.length; }

	// One level of links through the graph's own read: indexed, valid at as_of, similarity links left out, charged to the budget.
	let edges: Edge[] = [];
	if (cands.length) {
		const step = trace(sql, { kind: "trace", mode: "step", ids: cands.map((c) => c.id), similarity: false, known: q.known, maxEdges: EDGE_ROWS, asOf }) as { edges: Edge[]; budget: Budget };
		b.edges_read = step.budget.edges_read;
		if (step.budget.exhausted) { b.exhausted = true; b.stopped ??= "item links"; }
		edges = step.edges.filter((e) => e.recorded_at <= asOf && (e.ended_at === null || e.ended_at > asOf));
	}
	const nodes = new Map(cands.map((c) => [c.id, c]));
	const far = [...new Set(edges.flatMap((e) => [e.src, e.dst]))].filter((id) => !nodes.has(id));
	if (far.length) {
		for (const n of sql.exec<Row>(`SELECT ${NODE_COLS} FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status NOT IN ('moved','moving','incoming') AND recorded_at <= ?`,
			JSON.stringify(far), asOf).toArray()) nodes.set(n.id, n);
	}
	const attrsOf = (n: Row): Attrs => { const v: unknown = JSON.parse(n.attrs); return v && typeof v === "object" ? v : {}; };
	const ref = (id: string): BoardRef => { const n = nodes.get(id); return n ? { id, kind: n.kind, name: n.name } : { id, readable: false }; };
	const openItem = (n: Row | undefined) => !!n && n.status === "active" && n.recorded_at <= asOf && (BOARD_KINDS as readonly string[]).includes(n.kind) && attrsOf(n).state === "open";

	const links = new Map(cands.map((c) => [c.id, { blockedBy: new Set<string>(), blocks: new Set<string>(), activity: new Map<string, string>() }]));
	for (const e of edges) {
		for (const [at, other, out] of [[e.src, e.dst, true], [e.dst, e.src, false]] as const) {
			const l = links.get(at);
			if (!l || at === other) continue;
			const n = nodes.get(other);
			if (e.rel === "blocked_by" && out) {
				// An open blocked_by link counts unless its target is a node here known to be done; a far end stays opaque.
				if (!n || (n.status === "active" && attrsOf(n).state !== "closed")) l.blockedBy.add(other);
			} else if (e.rel === "blocked_by" && openItem(n)) l.blocks.add(other);
			if (n && n.status === "active" && (ACTIVITY_KINDS as readonly string[]).includes(n.kind) && n.recorded_at <= asOf) {
				const t = [seenBy(n, asOf), e.recorded_at, l.activity.get(other) ?? ""].reduce((x, y) => (y > x ? y : x));
				l.activity.set(other, t);
			}
		}
	}

	const items: BoardItem[] = cands.map((c) => {
		const a = attrsOf(c), l = links.get(c.id)!, unrecognized: string[] = [], reasons: BoardItem["reasons"] = [];
		const add = (term: Term, factor: number, text: (p: number) => string) => {
			const points = round(W[term] * factor);
			if (points) reasons.push({ term, points, text: `${text(points)} (${signed(points)}).` });
		};
		const set = (k: keyof Attrs) => a[k] !== undefined && a[k] !== null;
		const priority = typeof a.priority === "string" && Object.hasOwn(PRIORITY, a.priority) ? a.priority : null;
		if (set("priority") && priority === null) unrecognized.push("priority");
		add("priority", priority ? PRIORITY[priority]! : NO_PRIORITY, () => (priority ? `Priority ${priority}` : "No recognized priority"));
		const days = daysToDue(a.due, asOf);
		if (set("due") && days === null) unrecognized.push("due");
		if (days !== null) add("due", days < 0 ? 1 : Math.max(0, 1 - days / DUE_DAYS), () => (days < 0 ? `Overdue since ${a.due as string}` : `Due ${a.due as string}, in ${plural(round(days), "day", "days")}`));
		for (const k of ["assignee_is_owner", "review_requested_from_owner"] as const) if (set(k) && typeof a[k] !== "boolean") unrecognized.push(k);
		const assigned = a.assignee_is_owner === true, review = a.review_requested_from_owner === true;
		add("owner_action", assigned || review ? 1 : 0, () => (assigned && review ? "Assigned to the owner and review requested from the owner" : assigned ? "Assigned to the owner" : "Review requested from the owner"));
		add("blocking", Math.min(l.blocks.size, BLOCKING_CAP) / BLOCKING_CAP, () => `Blocks ${plural(l.blocks.size, "open item", "open items")}`);
		const recent = [...l.activity.values()].filter((t) => t >= recentFrom).length;
		add("recent_activity", recent ? 1 : 0, () => `${plural(recent, "linked journal, commit or PR", "linked journals, commits or PRs")} active in the last ${RECENT_DAYS} days`);
		add("blocked", l.blockedBy.size ? 1 : 0, () => `Has ${plural(l.blockedBy.size, "open blocked_by link", "open blocked_by links")}`);
		const last = [seenBy(c, asOf), ...l.activity.values()].reduce((x, y) => (y > x ? y : x));
		return {
			id: c.id, kind: c.kind, key: c.key, name: c.name, scope: c.scope, priority: typeof a.priority === "string" ? a.priority : null, due: typeof a.due === "string" ? a.due : null,
			score: round(reasons.reduce((s, r) => s + r.points, 0)), reasons, stale: last < staleBefore, last_activity_at: last,
			blocked_by: [...l.blockedBy].sort().map(ref), blocks: [...l.blocks].sort().map(ref), unrecognized,
		};
	}).sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));

	// shortcut: reads every active document through nodes_kind to find the newest review; index attrs.kind if documents grow large.
	const review = sql.exec<{ id: string; name: string; description: string; recorded_at: string; data_as_of: string | null; coverage: string | null }>(`SELECT id, name,
		substr(description, 1, 280) AS description, recorded_at, json_extract(attrs, '$.as_of') AS data_as_of, json_extract(attrs, '$.coverage') AS coverage
		FROM nodes WHERE kind = 'document' AND status = 'active' AND recorded_at <= ? AND json_extract(attrs, '$.kind') = 'strategic_review'
		ORDER BY recorded_at DESC, id DESC LIMIT 1`, asOf).toArray()[0];

	return {
		as_of: asOf, covers_only_uploaded_data: true as const,
		note: "Covers only what the owner's machines have uploaded. Item fields are their latest upload; as_of dates links, due dates and activity.",
		items: items.slice(0, q.limit), total: items.length, truncated: items.length > q.limit, without_state: counts.without_state,
		review: review ? { id: review.id, name: review.name, description: review.description, recorded_at: review.recorded_at, age_days: Math.floor((ms - Date.parse(review.recorded_at)) / DAY),
			// A batch-written review also says which board it read: its data as_of and that board's coverage.
			...(review.data_as_of ? { data_as_of: review.data_as_of, coverage: JSON.parse(review.coverage ?? "null") as ReviewCoverage | null } : {}) } : null,
		budget: b,
	};
}

/** At most this many board items are a weekly review's subjects: the only nodes it may link to or cite. */
export const REVIEW_ITEMS = 20;
export interface ReviewCoverage { open: number; scored: number; without_state: number; partial: boolean; reviewed: number; profile_local: true }

/**
 * The board a weekly review reads (section 13): this profile only (links into other profiles are not read), as of the item's
 * creation, so every lease and the write see the same as_of. `items` are the subjects' rows; coverage says how much of the
 * uploaded board they are.
 */
export function reviewBoard(sql: SqlStorage, asOf: string, subjects: string[]) {
	const b = board(sql, { kind: "board", asOf, limit: LEVEL_NODES, known: [] }), want = new Set(subjects);
	const coverage: ReviewCoverage = { open: b.total + b.budget.skipped, scored: b.total, without_state: b.without_state, partial: b.budget.exhausted, reviewed: subjects.length, profile_local: true };
	return { as_of: b.as_of, covers_only_uploaded_data: true as const, coverage, items: b.items.filter((i) => want.has(i.id)) };
}
