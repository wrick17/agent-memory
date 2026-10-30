// The model of the owner (section 12) for the dashboard's About you page (section 15): one profile's active preferences,
// stated first, then pinned, then newest, each with its open links and a bounded slice of its evidence. Read-only: it never
// writes, binds, stamps a sequence number or resolves another profile; pin, unpin, forget and unflag stay the owner actions.
import { Fail } from "../domain/types";

/** The read-query shape; the integrator adds the same member to ReadQuery in domain/types.ts. */
export interface OwnerModelQuery { kind: "owner_model"; after: string | null; limit: number }

/** At most this many preferences per page; a larger limit is capped. */
export const OWNER_MODEL_MAX = 200;
/** At most this many evidence pointers per preference; `evidence_truncated` says when more exist. */
export const OWNER_EVIDENCE_MAX = 10;

export interface OwnerModelItem {
	id: string; name: string; description: string; origin: string; pinned: boolean; flagged: string | null; revision: number;
	updated_at: string; source_profile: string | null;
	/** Current edges from this preference, as the section 5 view counts them. */
	links: number;
	evidence: { kind: string; ref: string; note: string | null }[];
	evidence_truncated: boolean;
	/** An inferred preference with no evidence pointer at all. */
	evidence_missing: boolean;
}
export interface OwnerModelPage { items: OwnerModelItem[]; next_after: string | null }

/** The full sort key of the last item: [stated, pinned, updated_at, id]. Sent back as `after`, it resumes after that item. */
type Key = [number, number, string, string];

function position(after: string): Key {
	let k: unknown;
	try { k = after.length <= 512 ? JSON.parse(after) : null; } catch { k = null; }
	if (!Array.isArray(k) || k.length !== 4 || (k[0] !== 0 && k[0] !== 1) || (k[1] !== 0 && k[1] !== 1) || typeof k[2] !== "string" || typeof k[3] !== "string" || !k[3]) {
		throw Fail.of("validation", "owner-model cursor is not valid; start again without after");
	}
	return k as Key;
}

// shortcut: each page sorts every active preference of the profile (nodes_kind narrows to them); add an index on the sort key
// if a profile ever holds tens of thousands of preferences.
export function ownerModel(sql: SqlStorage, q: OwnerModelQuery): OwnerModelPage {
	if (!Number.isInteger(q.limit) || q.limit < 1) throw Fail.of("validation", "limit must be a whole number of at least 1");
	if (q.after !== null && typeof q.after !== "string") throw Fail.of("validation", "after must be a cursor string or null");
	const limit = Math.min(q.limit, OWNER_MODEL_MAX);
	const key = q.after === null ? null : position(q.after);
	// id descending only breaks ties; it keeps the whole key in one direction, so one row-value comparison resumes the page.
	const rows = sql.exec<{ id: string; name: string; description: string; origin: string; flagged: string | null; revision: number;
		updated_at: string; source_profile: string | null; links: number; s: number; p: number }>(
		`SELECT n.id, n.name, n.description, n.origin, n.flagged, n.revision, n.updated_at, n.source_profile,
			(SELECT count(*) FROM edges e WHERE e.src = n.id AND e.ended_at IS NULL) AS links, (n.origin = 'stated') AS s, (n.pinned <> 0) AS p
		FROM nodes n WHERE n.kind = 'preference' AND n.status = 'active' ${key ? "AND ((n.origin = 'stated'), (n.pinned <> 0), n.updated_at, n.id) < (?, ?, ?, ?)" : ""}
		ORDER BY s DESC, p DESC, n.updated_at DESC, n.id DESC LIMIT ?`, ...(key ?? []), limit + 1).toArray();
	const page = rows.slice(0, limit);
	// One statement for the page's evidence: the ids travel as one JSON parameter, and each owner reads at most cap + 1 rows.
	const evidence = new Map(sql.exec<{ owner: string; items: string }>(
		`SELECT j.value AS owner, (SELECT json_group_array(json_array(kind, ref, note) ORDER BY kind, ref) FROM
			(SELECT kind, ref, note FROM evidence WHERE owner = j.value ORDER BY kind, ref LIMIT ?)) AS items
		FROM json_each(?) j`, OWNER_EVIDENCE_MAX + 1, JSON.stringify(page.map((r) => `n:${r.id}`))).toArray()
		.map((r) => [r.owner, JSON.parse(r.items) as [string, string, string | null][]]));
	const items = page.map((r): OwnerModelItem => {
		const ev = evidence.get(`n:${r.id}`) ?? [];
		return { id: r.id, name: r.name, description: r.description, origin: r.origin, pinned: r.p === 1, flagged: r.flagged, revision: r.revision,
			updated_at: r.updated_at, source_profile: r.source_profile, links: r.links,
			evidence: ev.slice(0, OWNER_EVIDENCE_MAX).map(([kind, ref, note]) => ({ kind, ref, note })),
			evidence_truncated: ev.length > OWNER_EVIDENCE_MAX, evidence_missing: r.origin === "inferred" && ev.length === 0 };
	});
	const last = page.at(-1);
	return { items, next_after: rows.length > limit && last ? JSON.stringify([last.s, last.p, last.updated_at, last.id]) : null };
}
