// The model of the owner (section 12) for the dashboard's About you page (section 15): one profile's active preferences,
// stated first, then pinned, then newest, each with its open links and a bounded slice of its evidence. Read-only: it never
// writes, binds, stamps a sequence number or resolves another profile; pin, unpin, forget and unflag stay the owner actions.
import { Fail } from "../domain/types";
import { guidanceStats, type GuidanceStats } from "./guidance";

/**
 * The read-query shape; the integrator adds the same member to ReadQuery in domain/types.ts. `kinds` (v2 Lessons): which
 * memory kinds to list, preference (type user) and rule (type feedback); omitted, preferences only, as About you reads them.
 */
export interface OwnerModelQuery { kind: "owner_model"; after: string | null; limit: number; kinds?: ("preference" | "rule")[] }
export const OWNER_MODEL_KINDS = ["preference", "rule"] as const;
/** At most this many linked project names per item. */
export const OWNER_PROJECTS_MAX = 3;

/** At most this many preferences per page; a larger limit is capped. */
export const OWNER_MODEL_MAX = 200;
/** At most this many evidence pointers per preference; `evidence_truncated` says when more exist. */
export const OWNER_EVIDENCE_MAX = 10;

export interface OwnerModelItem {
	id: string; name: string; description: string; origin: string; pinned: boolean; flagged: string | null; revision: number;
	updated_at: string; source_profile: string | null;
	/** v2: the stored kind, and the record's scope ("default" when none was given). */
	kind: "preference" | "rule"; scope: string;
	/** v2: names of projects it currently links to in this profile, at most OWNER_PROJECTS_MAX, by name. */
	projects: string[];
	/** Current edges from this preference, as the section 5 view counts them. */
	links: number;
	evidence: { kind: string; ref: string; note: string | null }[];
	evidence_truncated: boolean;
	/** An inferred preference with no evidence pointer at all. */
	evidence_missing: boolean;
	/** #127 guidance receipts: sessions it was injected in, processed and failed, and its followed rate; null when never injected. */
	guidance: GuidanceStats | null;
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
	const kinds = q.kinds ?? ["preference"];
	if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !(OWNER_MODEL_KINDS as readonly string[]).includes(k))) throw Fail.of("validation", "kinds lists preference and/or rule");
	// id descending only breaks ties; it keeps the whole key in one direction, so one row-value comparison resumes the page.
	const rows = sql.exec<{ id: string; name: string; description: string; origin: string; flagged: string | null; revision: number;
		updated_at: string; source_profile: string | null; links: number; s: number; p: number; kind: "preference" | "rule"; scope: string; projects: string }>(
		`SELECT n.id, n.name, n.description, n.origin, n.flagged, n.revision, n.updated_at, n.source_profile, n.kind, n.scope,
			(SELECT count(*) FROM edges e WHERE e.src = n.id AND e.ended_at IS NULL) AS links, (n.origin = 'stated') AS s, (n.pinned <> 0) AS p,
			(SELECT json_group_array(name) FROM (SELECT p.name FROM edges e JOIN nodes p ON p.id = e.dst WHERE e.src = n.id AND e.ended_at IS NULL
				AND e.dst_profile = '' AND p.kind = 'project' AND p.status = 'active' GROUP BY p.name ORDER BY p.name LIMIT ${OWNER_PROJECTS_MAX})) AS projects
		FROM nodes n WHERE n.kind IN (SELECT value FROM json_each(?)) AND n.status = 'active' AND n.scope <> 'repo-fact' ${key ? "AND ((n.origin = 'stated'), (n.pinned <> 0), n.updated_at, n.id) < (?, ?, ?, ?)" : ""}
		ORDER BY s DESC, p DESC, n.updated_at DESC, n.id DESC LIMIT ?`, JSON.stringify(kinds), ...(key ?? []), limit + 1).toArray();
	const page = rows.slice(0, limit);
	// One statement for the page's evidence: the ids travel as one JSON parameter, and each owner reads at most cap + 1 rows.
	const evidence = new Map(sql.exec<{ owner: string; items: string }>(
		`SELECT j.value AS owner, (SELECT json_group_array(json_array(kind, ref, note) ORDER BY kind, ref) FROM
			(SELECT kind, ref, note FROM evidence WHERE owner = j.value ORDER BY kind, ref LIMIT ?)) AS items
		FROM json_each(?) j`, OWNER_EVIDENCE_MAX + 1, JSON.stringify(page.map((r) => `n:${r.id}`))).toArray()
		.map((r) => [r.owner, JSON.parse(r.items) as [string, string, string | null][]]));
	const guidance = guidanceStats(sql, page.map((r) => r.id));
	const items = page.map((r): OwnerModelItem => {
		const ev = evidence.get(`n:${r.id}`) ?? [];
		return { id: r.id, name: r.name, description: r.description, origin: r.origin, pinned: r.p === 1, flagged: r.flagged, revision: r.revision,
			updated_at: r.updated_at, source_profile: r.source_profile, kind: r.kind, scope: r.scope, projects: JSON.parse(r.projects) as string[], links: r.links,
			evidence: ev.slice(0, OWNER_EVIDENCE_MAX).map(([kind, ref, note]) => ({ kind, ref, note })),
			evidence_truncated: ev.length > OWNER_EVIDENCE_MAX, evidence_missing: r.origin === "inferred" && ev.length === 0, guidance: guidance.get(r.id) ?? null };
	});
	const last = page.at(-1);
	return { items, next_after: rows.length > limit && last ? JSON.stringify([last.s, last.p, last.updated_at, last.id]) : null };
}
