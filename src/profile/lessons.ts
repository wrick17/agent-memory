// Automatic learning (the daily batch's record_lesson and record_decision): where a session's lessons and decisions belong, the
// existing lessons and decisions a new one may strengthen or supersede, and the evidence a merged near-duplicate hands its keeper.
import { isScope, normalizeScope } from "../domain/ids";
import { EVIDENCE_KINDS } from "../domain/types";
import { FACT_SCOPE } from "./facts";
import { readableNodeIds } from "./graph";
import { archiveNodeIds } from "./write";

/** At most this many known lessons and decisions go to the model with a capture item. */
export const KNOWN_MAX = 30;
/** At most this many evidence pointers move from merged duplicates to the record kept. */
const CARRY_MAX = 20;

export type Known = { id: string; kind: "rule" | "decision"; scope: string; origin: string; name: string; description: string; why: string | null; how_to_apply: string | null };
export type Learning = { project: { id: string; name: string } | null; scope: string; known: Known[] };

/**
 * The project the subjects' sessions link to (an upload's part_of first, then the strongest identifier link, as the sessions
 * page reads it), and the scope a lesson or decision from them takes: the project's repo name when it is a valid scope, else the
 * workspace a session ran in (capture project tagging, attrs.workspace), else `default`. shortcut: the repo name stands in for a
 * project scope, since nodes carry no scope mapping; revisit if the owner scopes project records some other way.
 */
export function learningFor(sql: SqlStorage, subjects: string[]): Learning {
	const p = sql.exec<{ id: string; name: string }>(`SELECT p.id, p.name FROM edges e JOIN nodes p ON p.id = e.dst
		WHERE e.src IN (SELECT value FROM json_each(?)) AND e.dst_profile = '' AND e.ended_at IS NULL AND p.kind = 'project' AND p.status = 'active'
		ORDER BY e.rel = 'part_of' DESC, e.weight DESC, e.id LIMIT 1`, JSON.stringify(subjects)).toArray()[0];
	const project = p && readableNodeIds(sql, [p.id]).has(p.id) && !archiveNodeIds(sql, [p.id]).length ? p : null;
	const repo = project?.name.split("/").pop()?.trim() ?? "";
	const workspace = project ? "" : sql.exec<{ ws: string }>(`SELECT json_extract(attrs, '$.workspace') AS ws FROM nodes WHERE id IN (SELECT value FROM json_each(?))
		AND kind = 'session' AND json_type(attrs, '$.workspace') = 'text' ORDER BY id LIMIT 1`, JSON.stringify(subjects)).toArray()[0]?.ws ?? "";
	const name = repo || workspace;
	const scope = name && isScope(name) && normalizeScope(name) !== FACT_SCOPE ? normalizeScope(name) : "default";
	return { project, scope, known: knownIn(sql, scope) };
}

/** Active lessons (rules) and decisions in the scope or `default`, newest first, text cut to 300 characters; never a repo fact or an archived record. */
function knownIn(sql: SqlStorage, scope: string): Known[] {
	const rows = sql.exec<Known>(`SELECT id, kind, scope, origin, substr(name, 1, 200) AS name, substr(description, 1, 300) AS description, substr(why, 1, 300) AS why, substr(how_to_apply, 1, 300) AS how_to_apply FROM nodes
		WHERE kind IN ('rule', 'decision') AND status = 'active' AND memory_type IS NOT NULL AND scope IN (?, 'default') AND scope <> ?
		ORDER BY updated_at DESC, id LIMIT ?`, scope, FACT_SCOPE, KNOWN_MAX).toArray();
	const archived = new Set(archiveNodeIds(sql, rows.map((r) => r.id)));
	return rows.filter((r) => !archived.has(r.id));
}

/**
 * The evidence of records a near-duplicate merge retires, as pointers for the record kept: typed kinds only, no pointer to the
 * keeper itself, node pointers only to visible, unarchived nodes, each once, at most CARRY_MAX.
 */
export function carriedEvidence(sql: SqlStorage, keep: string, retire: string[]): { kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note?: string }[] {
	const rows = sql.exec<{ kind: (typeof EVIDENCE_KINDS)[number]; ref: string; note: string | null }>(`SELECT DISTINCT kind, ref, note FROM evidence
		WHERE owner IN (SELECT 'n:' || value FROM json_each(?)) AND kind IN (SELECT value FROM json_each(?)) ORDER BY seq, kind, ref`,
		JSON.stringify(retire), JSON.stringify(EVIDENCE_KINDS)).toArray();
	const nodes = rows.filter((r) => r.kind === "node").map((r) => r.ref);
	const live = new Set(nodes.length ? sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status NOT IN ('incoming','moving','moved')",
		JSON.stringify(nodes)).toArray().map((r) => r.id) : []);
	for (const id of archiveNodeIds(sql, [...live])) live.delete(id);
	const seen = new Set<string>();
	return rows.filter((r) => !(r.kind === "node" && (r.ref === keep || !live.has(r.ref))) && !seen.has(`${r.kind}:${r.ref}`) && seen.add(`${r.kind}:${r.ref}`))
		.slice(0, CARRY_MAX).map((r) => ({ kind: r.kind, ref: r.ref, ...(r.note !== null ? { note: r.note } : {}) }));
}
