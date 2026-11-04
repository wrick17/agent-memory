// Activity summary and project profile (IN1), computed on request within the existing graph work budgets. Read only: no row,
// seq or activity entry changes. Everything comes from this profile's stored facts: session nodes, their current capture
// digest parts (asks, decisions, corrections, outcomes and the identifiers each part names), graph edges, evidence rows and
// rule, preference and decision nodes. Digests keep order, not time, so a digest item counts on the UTC day its part was
// uploaded. File paths live only in the corpus (commit_paths), which a profile store cannot read: the Worker fills top_files
// and files through corpusFilesSql and corpusFiles when the corpus is on, and they stay empty otherwise.
import { normalizeScope } from "../domain/ids";
import { Fail } from "../domain/types";
import type { ActivitySummary, ActivitySummaryQuery, ProjectProfile, ProjectSummary } from "../viewer/types";
import { parseRange } from "./capture";
import { EDGE_ROWS, EXPAND_ROWS, LEVEL_NODES, newBudget } from "./graph";

/** Top-list sizes the dashboard shows. */
const BUSIEST = 10, LATEST = 20, CONCEPTS = 10, CONVENTIONS = 50, ERRORS = 10, ERROR_TEXTS = 5, HIGHLIGHTS = 20, FILES = 10;
const MAX_SPAN_DAYS = 366, HIGHLIGHT_DAYS = 30, FILE_DAYS = 365, DAY_MS = 86_400_000;
/** Entity kinds the Profile tab calls concepts. People, sessions, commits and PRs are not concepts. */
const CONCEPT_KINDS = ["component", "feature", "bug", "ticket", "other"];


// The session's project, as S1 (src/profile/sessions.ts) defines it: an upload's part_of link first, then the strongest
// identifier link to an active project. Kept identical so the picker's counts match the Sessions tab's project filter.
const PROJECT = `(SELECT e.dst FROM edges e JOIN nodes p ON p.id = e.dst WHERE e.src = n.id AND e.dst_profile = '' AND e.ended_at IS NULL
	AND p.kind = 'project' AND p.status = 'active' ORDER BY e.rel = 'part_of' DESC, e.weight DESC, e.id LIMIT 1)`;
// The digest parts that describe a session now (S1's currentParts): a range's live heuristic digest until its manifest
// supersedes it, else its live consolidated parts. Bodies passed checkBody on ingest; json_valid guards the JSON functions.
const CURRENT = `t.part = 'capture' AND t.lane = 'capture' AND t.live = 1 AND t.chunk = 0 AND t.range_id IS NOT NULL
	AND t.capture_part IS NOT 'manifest' AND (t.capture_status = 'heuristic' OR NOT EXISTS (SELECT 1 FROM texts h
		WHERE h.range_id = t.range_id AND h.capture_status = 'heuristic' AND h.capture_part = '-' AND h.live = 1)) AND json_valid(t.body)`;
const len = (path: string) => `coalesce(json_array_length(t.body, '${path}'), 0)`;
const json = (v: unknown) => JSON.stringify(v);

/** A real UTC calendar day as YYYY-MM-DD. */
function isDay(v: unknown): v is string {
	return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function checkRange(q: ActivitySummaryQuery): void {
	if (!isDay(q?.from) || !isDay(q?.to) || q.from > q.to || Date.parse(q.to) - Date.parse(q.from) > MAX_SPAN_DAYS * DAY_MS)
		throw Fail.of("validation", "from and to as YYYY-MM-DD, at most one year apart");
}

type Body = {
	asks?: { text: string; pos: number }[]; decisions?: { text: string; pos: number }[]; corrections?: { text: string; pos: number }[];
	outcomes?: { commits?: string[]; prs?: string[]; tests?: string[] }; entities?: string[];
};
const parse = (text: string): Body | null => { try { return JSON.parse(text) as Body; } catch { return null; } };
type Item = { kind: "ask" | "decision" | "correction" | "outcome"; text: string; pos: number };
/** One part's items, newest first: outcomes (which carry no position and follow the part's items), then items by position. */
function newestItems(b: Body): Item[] {
	const items = (["asks", "decisions", "corrections"] as const).flatMap((f) =>
		(b[f] ?? []).map((x) => ({ kind: f === "asks" ? "ask" as const : f === "decisions" ? "decision" as const : "correction" as const, text: x.text, pos: x.pos })));
	const outcomes = [...(b.outcomes?.commits ?? []), ...(b.outcomes?.prs ?? []), ...(b.outcomes?.tests ?? [])].map((text) => ({ kind: "outcome" as const, text, pos: Infinity }));
	return [...outcomes.reverse(), ...items.sort((x, y) => y.pos - x.pos)];
}

/** A session's first ask in transcript order (S1's first_ask), or null. Reads only that session's parts that hold an ask. */
function firstAsk(sql: SqlStorage, node: string): string | null {
	const rows = sql.exec<{ rowid: number; range_id: string; capture_part: string; asks: string }>(`SELECT t.rowid, t.range_id, t.capture_part,
		json_extract(t.body, '$.asks') AS asks FROM texts t WHERE t.node_id = ? AND ${CURRENT} AND ${len("$.asks")} > 0`, node).toArray();
	let best: { k: number[]; text: string } | null = null;
	for (const r of rows) {
		const range = parseRange(r.range_id), start = range?.start ?? 0;
		const partStart = r.capture_part === "-" ? start : Number(r.capture_part.split("-")[0]) || 0;
		let asks: { text: string; pos: number }[];
		try { asks = JSON.parse(r.asks) as { text: string; pos: number }[]; } catch { continue; }
		const a = asks.reduce<{ text: string; pos: number } | null>((m, x) => (!m || x.pos < m.pos ? x : m), null);
		const k = [start, partStart, r.rowid];
		const before = !best || (k[0]! - best.k[0]! || k[1]! - best.k[1]! || k[2]! - best.k[2]!) < 0;
		if (a && before) best = { k, text: a.text };
	}
	return best?.text ?? null;
}

/**
 * GET /api/profiles/:p/activity-summary. Counts the current digest items of this profile's sessions whose parts were uploaded
 * on the UTC days from..to. Reads at most EDGE_ROWS parts, newest first; past that, it drops the oldest partly read day so
 * every counted day is complete, and the reply's `from` is the first day it covers in full (later than the asked `from`).
 * ActivitySummary has no budget field, so a `from` later than the request is how the reply says it stopped.
 */
export function activitySummary(sql: SqlStorage, q: ActivitySummaryQuery): ActivitySummary {
	checkRange(q);
	let from = q.from;
	type Row = { rowid: number; node: string; at: string; a: number; d: number; c: number; cm: number; ts: number; pr: number };
	let rows = sql.exec<Row>(`SELECT t.rowid AS rowid, t.node_id AS node, t.created_at AS at, ${len("$.asks")} AS a, ${len("$.decisions")} AS d,
		${len("$.corrections")} AS c, ${len("$.outcomes.commits")} AS cm, ${len("$.outcomes.tests")} AS ts, ${len("$.outcomes.prs")} AS pr
		FROM nodes n JOIN texts t ON t.node_id = n.id WHERE n.kind = 'session' AND n.status = 'active' AND ${CURRENT}
		AND t.created_at >= ? AND t.created_at < ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`, q.from, addDays(q.to, 1), EDGE_ROWS + 1).toArray();
	if (rows.length > EDGE_ROWS) {
		// The first unread part's day is partly read; every later day was read whole.
		const cut = rows[EDGE_ROWS]!.at.slice(0, 10);
		rows = rows.slice(0, EDGE_ROWS).filter((r) => r.at.slice(0, 10) > cut);
		from = addDays(cut, 1);
	}

	const days = new Map<string, number>(), perSession = new Map<string, { n: number; at: string }>();
	const kinds = { asks: 0, decisions: 0, corrections: 0, commits: 0, tests: 0, prs: 0 };
	let observations = 0;
	for (const r of rows) {
		const n = r.a + r.d + r.c + r.cm + r.ts + r.pr;
		kinds.asks += r.a; kinds.decisions += r.d; kinds.corrections += r.c; kinds.commits += r.cm; kinds.tests += r.ts; kinds.prs += r.pr;
		observations += n;
		const s = perSession.get(r.node);
		if (s) s.n += n; else perSession.set(r.node, { n, at: r.at });
		if (n > 0) { const day = r.at.slice(0, 10); days.set(day, (days.get(day) ?? 0) + n); }
	}
	const dayList = [...days].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([day, count]) => ({ day, count }));
	const busiestDay = dayList.reduce<{ day: string; count: number } | null>((m, d) => (!m || d.count > m.count ? d : m), null);

	const busiest = [...perSession].filter(([, s]) => s.n > 0)
		.sort((x, y) => y[1].n - x[1].n || (x[1].at < y[1].at ? 1 : x[1].at > y[1].at ? -1 : 0) || (x[0] < y[0] ? -1 : 1)).slice(0, BUSIEST)
		.map(([id, s]) => ({ id, title: firstAsk(sql, id), observations: s.n }));

	// The newest parts that hold an item, enough to fill the list: each part holds at least one.
	const want = rows.filter((r) => r.a + r.d + r.c + r.cm + r.ts + r.pr > 0).slice(0, LATEST);
	const bodies = new Map(want.length ? sql.exec<{ rowid: number; body: string }>("SELECT rowid, body FROM texts WHERE rowid IN (SELECT value FROM json_each(?))",
		json(want.map((r) => r.rowid))).toArray().map((r) => [r.rowid, r.body]) : []);
	const latest: ActivitySummary["latest"] = [];
	for (const r of want) {
		const b = parse(bodies.get(r.rowid) ?? "");
		for (const it of b ? newestItems(b) : []) {
			if (latest.length === LATEST) break;
			latest.push({ session: r.node, kind: it.kind, text: it.text, at: r.at });
		}
	}

	return {
		from, to: q.to, active_days: dayList.length, sessions: perSession.size, observations, busiest_day: busiestDay?.day ?? null,
		days: dayList, kinds, top_files: [], busiest_sessions: busiest, latest,
	};
}

/** GET /api/profiles/:p/projects: active projects with their session count and last session upload, most recent first. */
export function listProjects(sql: SqlStorage): ProjectSummary[] {
	// shortcut: the picker lists at most LEVEL_NODES projects; page it if a profile ever holds more.
	return sql.exec<{ id: string; key: string | null; name: string; sessions: number | null; last: string | null }>(`SELECT p.id, p.key, p.name,
		s.sessions, s.last FROM nodes p LEFT JOIN (SELECT project, count(*) AS sessions, max(updated_at) AS last FROM (SELECT ${PROJECT} AS project,
		n.updated_at FROM nodes n WHERE n.kind = 'session' AND n.status = 'active') WHERE project IS NOT NULL GROUP BY project) s ON s.project = p.id
		WHERE p.kind = 'project' AND p.status = 'active' ORDER BY s.last IS NULL, s.last DESC, p.name, p.id LIMIT ?`, LEVEL_NODES).toArray()
		.map((r) => ({ key: r.key ?? r.id, name: r.name, sessions: r.sessions ?? 0, last_activity: r.last }));
}

/** The memory scopes that name a project: its name, its key, and for a github:org/repo key, org/repo and repo. */
function scopesOf(p: { key: string | null; name: string }): string[] {
	const repo = p.key?.startsWith("github:") ? p.key.slice(7) : null;
	const raw = [p.name, p.key, repo, repo?.split("/")[1]].filter((s): s is string => !!s);
	return [...new Set(raw.flatMap((s) => { try { return [normalizeScope(s)]; } catch { return []; } }))].filter((s) => s !== "default");
}

/**
 * GET /api/profiles/:p/projects/:key/profile, computed on request. `key` is the project's key or node id. Session count and
 * last activity cover every session of the project; concepts and recurring errors read its newest LEVEL_NODES sessions, at
 * most EDGE_ROWS links and EXPAND_ROWS digest parts, and the budget says when a bound cut them short. null when no active
 * project matches.
 */
export function projectProfile(sql: SqlStorage, key: string, now: string): ProjectProfile | null {
	if (typeof key !== "string" || !key.length || key.length > 512) throw Fail.of("validation", "project key must be 1 to 512 characters");
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) throw Fail.of("validation", "now is not a time");
	const p = sql.exec<{ id: string; key: string | null; name: string }>(`SELECT id, key, name FROM nodes WHERE kind = 'project' AND status = 'active'
		AND (key = ? OR id = ?) ORDER BY key = ? DESC LIMIT 1`, key, key, key).toArray()[0];
	if (!p) return null;
	const budget = newBudget(EDGE_ROWS);
	const stop = (where: string, skipped: number) => { budget.exhausted = true; budget.stopped ??= where; budget.skipped += skipped; };

	const totals = sql.exec<{ sessions: number; last: string | null }>(`SELECT count(*) AS sessions, max(n.updated_at) AS last FROM nodes n
		WHERE n.kind = 'session' AND n.status = 'active' AND ${PROJECT} = ?`, p.id).one();
	const sessions = sql.exec<{ id: string; key: string }>(`SELECT n.id, n.key FROM nodes n WHERE n.kind = 'session' AND n.status = 'active'
		AND ${PROJECT} = ? ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`, p.id, LEVEL_NODES).toArray();
	if (totals.sessions > sessions.length) stop("project sessions", totals.sessions - sessions.length);
	const sessionIds = sessions.map((s) => s.id);
	// Evidence cites a session by its node id (kind node) or by its key or client:id (kind session), as S1 reads it.
	const sessionRefs = sessions.flatMap((s) => [s.key, s.key.replace(/^session:/, "")]);
	const scopes = scopesOf(p);

	// Rules and preferences scoped to the project or linked to its node.
	const LINKED = `(id IN (SELECT src FROM edges WHERE dst_profile = '' AND dst = ?1 AND ended_at IS NULL)
		OR id IN (SELECT dst FROM edges WHERE src = ?1 AND dst_profile = '' AND ended_at IS NULL))`;
	const conventions = sql.exec<{ id: string; name: string; kind: "rule" | "preference"; origin: string }>(`SELECT id, name, kind, origin FROM nodes
		WHERE kind IN ('rule','preference') AND status = 'active' AND (scope IN (SELECT value FROM json_each(?2)) OR ${LINKED})
		ORDER BY updated_at DESC, id LIMIT ?3`, p.id, json(scopes), CONVENTIONS).toArray();

	// Decisions recorded in the last 30 days that are scoped to the project, linked to it or one of its sessions, or cite one of its sessions.
	const highlights = sql.exec<{ id: string; title: string; at: string }>(`SELECT id, name AS title, created_at AS at FROM nodes
		WHERE kind = 'decision' AND status = 'active' AND created_at >= ?2 AND (scope IN (SELECT value FROM json_each(?3)) OR ${LINKED}
			OR id IN (SELECT dst FROM edges WHERE src IN (SELECT value FROM json_each(?4)) AND dst_profile = '' AND ended_at IS NULL)
			OR id IN (SELECT src FROM edges WHERE dst_profile = '' AND dst IN (SELECT value FROM json_each(?4)) AND ended_at IS NULL)
			OR id IN (SELECT substr(owner, 3) FROM evidence WHERE owner LIKE 'n:%' AND ((kind = 'node' AND ref IN (SELECT value FROM json_each(?4)))
				OR (kind = 'session' AND ref IN (SELECT value FROM json_each(?5))))))
		ORDER BY created_at DESC, id LIMIT ?6`, p.id, new Date(nowMs - HIGHLIGHT_DAYS * DAY_MS).toISOString(), json(scopes), json(sessionIds),
		json(sessionRefs), HIGHLIGHTS).toArray();

	// Concepts: entity nodes linked to the project, its newest sessions or its conventions, counted by distinct linking records.
	const around = [...new Set([p.id, ...sessionIds, ...conventions.map((c) => c.id)])];
	const pairs: [string, string][] = [];
	for (const [dir, sqlText] of [["out", `SELECT src AS a, dst AS b FROM edges WHERE src IN (SELECT value FROM json_each(?)) AND dst_profile = '' AND ended_at IS NULL LIMIT ?`],
		["in", `SELECT dst AS a, src AS b FROM edges WHERE dst_profile = '' AND dst IN (SELECT value FROM json_each(?)) AND ended_at IS NULL LIMIT ?`]] as const) {
		const room = budget.limit - budget.edges_read;
		const got = room > 0 ? sql.exec<{ a: string; b: string }>(sqlText, json(around), room + 1).toArray() : [];
		budget.edges_read += Math.min(got.length, room);
		if (got.length > room || room <= 0) stop(`concept links (${dir})`, Math.max(got.length - room, 0));
		for (const e of got.slice(0, Math.max(room, 0))) pairs.push([e.a, e.b]);
	}
	const others = [...new Set(pairs.map(([, b]) => b))].filter((b) => !around.includes(b));
	const concepts = new Map(others.length ? sql.exec<{ id: string; name: string; kind: string }>(`SELECT id, name, kind FROM nodes
		WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active' AND kind IN (SELECT value FROM json_each(?))`, json(others), json(CONCEPT_KINDS))
		.toArray().map((c) => [c.id, { ...c, by: new Set<string>() }]) : []);
	for (const [a, b] of pairs) concepts.get(b)?.by.add(a);
	const topConcepts = [...concepts.values()].map((c) => ({ id: c.id, name: c.name, kind: c.kind, count: c.by.size }))
		.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name) || (x.id < y.id ? -1 : 1)).slice(0, CONCEPTS);

	// Recurring errors: digest corrections grouped by the identifiers their own digest part names (the part's entities) that
	// resolve to a node of this profile. Only an entity with at least two corrections is listed.
	const parts = sessionIds.length ? sql.exec<{ node: string; corrections: string; entities: string }>(`SELECT t.node_id AS node,
		json_extract(t.body, '$.corrections') AS corrections, json_extract(t.body, '$.entities') AS entities FROM texts t
		WHERE t.node_id IN (SELECT value FROM json_each(?)) AND ${CURRENT} AND ${len("$.corrections")} > 0 AND ${len("$.entities")} > 0
		ORDER BY t.rowid DESC LIMIT ?`, json(sessionIds), EXPAND_ROWS + 1).toArray() : [];
	if (parts.length > EXPAND_ROWS) stop("correction digests", parts.length - EXPAND_ROWS);
	const named = parts.slice(0, EXPAND_ROWS).flatMap((r) => {
		try { return [{ node: r.node, corrections: JSON.parse(r.corrections) as { text: string }[], entities: JSON.parse(r.entities) as string[] }]; }
		catch { return []; }
	});
	const keys = [...new Set(named.flatMap((r) => r.entities.flatMap((e) => [e, e.toLowerCase()])))];
	const byKey = new Map(keys.length ? sql.exec<{ id: string; key: string; name: string }>(`SELECT id, key, name FROM nodes WHERE key IN (SELECT value FROM json_each(?))
		AND status = 'active' AND kind NOT IN ('person','session','project')`, json(keys)).toArray().map((n) => [n.key, n]) : []);
	const groups = new Map<string, { entity_id: string; entity: string; count: number; corrections: { id: string; text: string }[]; seen: Set<string> }>();
	for (const r of named) {
		const hit = new Map<string, { id: string; name: string }>();
		for (const e of r.entities) { const n = byKey.get(e) ?? byKey.get(e.toLowerCase()); if (n) hit.set(n.id, n); }
		for (const n of hit.values()) {
			const g = groups.get(n.id) ?? { entity_id: n.id, entity: n.name, count: 0, corrections: [], seen: new Set<string>() };
			groups.set(n.id, g);
			for (const c of r.corrections) {
				g.count++;
				if (g.corrections.length < ERROR_TEXTS && !g.seen.has(c.text)) { g.seen.add(c.text); g.corrections.push({ id: r.node, text: c.text }); }
			}
		}
	}
	const recurring = [...groups.values()].filter((g) => g.count >= 2)
		.sort((x, y) => y.count - x.count || x.entity.localeCompare(y.entity) || (x.entity_id < y.entity_id ? -1 : 1)).slice(0, ERRORS)
		.map(({ seen: _seen, ...g }) => g);

	return {
		key: p.key ?? p.id, name: p.name, sessions: totals.sessions, last_activity: totals.last,
		concepts: topConcepts, files: [], conventions, recurring_errors: recurring, highlights, budget,
	};
}

// ---- Corpus file paths (the Worker runs these against the profile's CorpusStore when the corpus is on) -----------------

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const FILES_SELECT = (where: string) => `SELECT p.path AS path, count(*) AS count FROM commits c JOIN commit_paths p ON p.repo = c.repo AND p.sha = c.sha
WHERE ${where} GROUP BY p.path ORDER BY count DESC, p.path LIMIT ${FILES}`;
// Corpus dates carry their own offsets: the index narrows by text with a day of slack, then date() compares in UTC.
const dated = (from: string, to: string) => `c.committer_date >= ${lit(addDays(from, -1))} AND c.committer_date < ${lit(addDays(to, 2))}
AND date(c.committer_date) BETWEEN ${lit(from)} AND ${lit(to)}`;

/**
 * One read-only SELECT for CorpusStore.query({ action: "sql" }): the most touched paths of the corpus commits in a validated
 * day range, or of a github:org/repo project's commits in the last year. null for a project key the corpus cannot name.
 */
export function corpusFilesSql(scope: ActivitySummaryQuery | { project: string; now: string }): string | null {
	if ("project" in scope) {
		const m = /^github:([a-z0-9][\w.-]*\/[\w.-]+)$/.exec(scope.project), nowMs = Date.parse(scope.now);
		if (!m || !Number.isFinite(nowMs)) return null;
		const to = new Date(nowMs).toISOString().slice(0, 10);
		return FILES_SELECT(`lower(c.repo) = ${lit(m[1]!)} AND ${dated(addDays(to, -FILE_DAYS), to)}`);
	}
	checkRange(scope);
	return FILES_SELECT(dated(scope.from, scope.to));
}

/** The { path, count } rows of a corpus sql answer ({ columns, rows }); anything else gives none. */
export function corpusFiles(answer: unknown): { path: string; count: number }[] {
	const a = answer as { columns?: unknown; rows?: unknown } | null;
	if (!a || !Array.isArray(a.columns) || !Array.isArray(a.rows)) return [];
	const pi = a.columns.indexOf("path"), ci = a.columns.indexOf("count");
	if (pi < 0 || ci < 0) return [];
	return a.rows.flatMap((r) => (Array.isArray(r) && typeof r[pi] === "string" && typeof r[ci] === "number" ? [{ path: r[pi] as string, count: r[ci] as number }] : []))
		.slice(0, FILES);
}
