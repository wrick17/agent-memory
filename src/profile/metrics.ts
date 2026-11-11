// Goal metrics (#130): whether agents make fewer mistakes over time, per repo and per UTC week (Monday start), from data this
// profile stores. Read-only; one synchronous read so every number comes from one state of the store.
//
// - Repeat-correction rate: corrections in session digests whose session the learning worker matched to a lesson (kind rule,
//   any origin) created before the session started. A match is the evidence row record_lesson writes on the existing rule
//   (kind node, ref the session node). Only sessions whose correction items the learning batch has finished count.
// - Guided-session share: session receipts (fact_reports) whose injected[] is non-empty, beside capture coverage: sessions with a
//   consolidated digest among every session seen (a session node or a session receipt).
// - Guidance-followed rate: (fired + prevented) / exercised over injected facts in session receipts. An injected fact is exercised
//   when its outcome is fired or prevented or its family is in the receipt's families. Memory items (#127) count apart, from the
//   guidance receipts: followed / processed, where processed means the batch handled that session and followed means no
//   correction of it matched the item.
// - Repeats come from correction_matches (#127) when stored: a correction the batch matched to a rule created before the session.
// - Cost per session: fact_days summed per week: tokens per session over usage_sessions, failures per session over sessions.
//
// A rate is null ("not enough data") below GOAL_LIMITS.min_sample in its denominator. Inputs that are not stored at all are named
// in `missing`, never shown as zero.
import { sha256 } from "../domain/ids";
import { FACT_SCOPE, REPO_KEY } from "./facts";
import { CURRENT_PART } from "./sessions";
import { sessionRefOf } from "./guidance";

export const GOAL_TARGETS = Object.freeze({ repeat_correction: 0.1, guided_share: 0.8, capture_coverage: 0.95 });
export const GOAL_LIMITS = Object.freeze({ weeks: 12, weeks_max: 26, min_sample: 3, sessions: 5_000, receipts: 20_000 });

export interface GoalQuery { now: string; weeks?: number; repo_key?: string }
export interface GoalWeek {
	week: string;
	corrections: { total: number; learned: number; repeats: number; pending: number; rate: number | null };
	guided: { sessions: number; guided: number; share: number | null; seen: number; captured: number; coverage: number | null };
	followed: { injected: number; exercised: number; fired: number; prevented: number; rate: number | null; prevented_share: number | null;
		/** #127: injected lessons, rules and decisions, from guidance receipts. */
		memory: { injected: number; processed: number; failed: number; rate: number | null } };
	cost: { sessions: number; usage_sessions: number; input: number; cached_input: number; output: number; failed: number; repeated_failures: number;
		tokens_per_session: number | null; failures_per_session: number | null; cache_ratio: number | null };
}
/** repo_key null: sessions linked to no GitHub project. */
export interface GoalRepo { repo_key: string | null; weeks: GoalWeek[] }
export interface GoalMetrics {
	from: string; to: string; weeks: string[]; targets: typeof GOAL_TARGETS; min_sample: number; repos: GoalRepo[];
	/** Inputs that are not stored, or a bound that cut the read; the dashboard shows each one. */
	missing: { metric: "repeat_correction" | "guided_share" | "capture_coverage" | "guidance_followed" | "cost"; reason: string }[];
	truncated: boolean;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The Monday (UTC) of the week that holds an ISO day or time. */
export const weekOf = (iso: string) => {
	const d = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
	return day(d - ((new Date(d).getUTCDay() + 6) % 7) * DAY_MS);
};
const rate = (num: number, den: number) => (den >= GOAL_LIMITS.min_sample ? num / den : null);
/** A project key `github:<owner>/<repo>` as a fact repo key, or null. */
const repoOfProject = (key: string | null) => {
	if (!key?.startsWith("github:")) return null;
	const k = `github.com/${key.slice(7).toLowerCase()}`;
	return REPO_KEY.test(k) ? k : null;
};
const hasTable = (sql: SqlStorage, name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

type Acc = {
	corr: { total: number; learned: number; repeats: number; pending: number };
	guided: { sessions: number; guided: number; seen: Set<string>; captured: Set<string> };
	followed: { injected: number; exercised: number; fired: number; prevented: number; memory: { injected: number; processed: number; failed: number } };
	cost: { sessions: number; usage_sessions: number; input: number; cached_input: number; output: number; failed: number; repeated_failures: number };
};
const blank = (): Acc => ({ corr: { total: 0, learned: 0, repeats: 0, pending: 0 }, guided: { sessions: 0, guided: 0, seen: new Set(), captured: new Set() },
	followed: { injected: 0, exercised: 0, fired: 0, prevented: 0, memory: { injected: 0, processed: 0, failed: 0 } },
	cost: { sessions: 0, usage_sessions: 0, input: 0, cached_input: 0, output: 0, failed: 0, repeated_failures: 0 } });

type Injected = { kind?: unknown; fact_key?: unknown; outcome?: unknown };
type Receipt = { repo_key: string; report_id: string; day: string; body: string };

export function goalMetrics(sql: SqlStorage, q: GoalQuery): GoalMetrics {
	const n = Math.min(Math.max(Math.trunc(q.weeks ?? GOAL_LIMITS.weeks), 1), GOAL_LIMITS.weeks_max);
	const nowMs = Date.parse(q.now), last = weekOf(q.now);
	const weeks = Array.from({ length: n }, (_, i) => day(Date.parse(`${last}T00:00:00Z`) - (n - 1 - i) * 7 * DAY_MS));
	const from = weeks[0]!, to = day(nowMs);
	const only = q.repo_key ?? null;
	const missing: GoalMetrics["missing"] = [];
	let truncated = false;
	const repos = new Map<string | null, Map<string, Acc>>();
	const acc = (repo: string | null, week: string): Acc | null => {
		if (week < from || week > last || (only !== null && repo !== only)) return null;
		let r = repos.get(repo);
		if (!r) repos.set(repo, (r = new Map()));
		let a = r.get(week);
		if (!a) r.set(week, (a = blank()));
		return a;
	};

	// ---- Session nodes: repo (project link), start week, consolidated digest, corrections ----
	type S = { id: string; ref: string; repo: string | null; week: string; first: string; consolidated: boolean };
	const nodes = sql.exec<{ id: string; key: string; first_at: string; project: string | null; consolidated: number }>(`SELECT n.id, n.key,
		coalesce(json_extract(n.attrs, '$.first_at'), n.created_at) AS first_at,
		(SELECT p.key FROM edges e JOIN nodes p ON p.id = e.dst WHERE e.src = n.id AND e.dst_profile = '' AND e.ended_at IS NULL AND p.kind = 'project'
			AND p.status = 'active' ORDER BY e.rel = 'part_of' DESC, e.weight DESC, e.id LIMIT 1) AS project,
		EXISTS (SELECT 1 FROM texts m WHERE m.node_id = n.id AND m.part = 'capture' AND m.capture_part = 'manifest' AND m.capture_status = 'consolidated') AS consolidated
		FROM nodes n WHERE n.kind = 'session' AND n.status = 'active' AND coalesce(json_extract(n.attrs, '$.first_at'), n.created_at) >= ?
		ORDER BY first_at DESC LIMIT ?`, from, GOAL_LIMITS.sessions + 1).toArray();
	if (nodes.length > GOAL_LIMITS.sessions) { truncated = true; nodes.length = GOAL_LIMITS.sessions; }
	const sessions: S[] = nodes.flatMap((r) => {
		// The facts client's session ref: client and the first 12 hex of sha256(raw session id), as local/facts.mjs sessionRef makes it.
		const ref = sessionRefOf(r.key);
		if (!ref) return [];
		return [{ id: r.id, ref, repo: repoOfProject(r.project), week: weekOf(r.first_at), first: r.first_at, consolidated: r.consolidated === 1 }];
	});
	const byRef = new Map(sessions.map((s) => [s.ref, s])), byId = new Map(sessions.map((s) => [s.id, s]));
	const ids = JSON.stringify(sessions.map((s) => s.id));

	// ---- Receipts (fact_reports): sessions seen per repo, guided share, guidance followed ----
	const receipts = hasTable(sql, "fact_reports");
	const rows: Receipt[] = receipts ? sql.exec<Receipt>(`SELECT repo_key, report_id, day, body FROM fact_reports WHERE substr(report_id, 1, 2) = 's:' AND day >= ? AND day <= ?
		ORDER BY day DESC LIMIT ?`, from, to, GOAL_LIMITS.receipts + 1).toArray() : [];
	if (rows.length > GOAL_LIMITS.receipts) { truncated = true; rows.length = GOAL_LIMITS.receipts; }
	if (!receipts) {
		const why = "No session receipts are stored yet (the fact_reports table arrives with the repo facts v2 server).";
		missing.push({ metric: "guided_share", reason: why }, { metric: "guidance_followed", reason: why });
	}
	// Each fact's family label, so an injected fact counts as exercised when its trigger ran in the receipt's repo (user-tier facts too).
	const labels = new Map<string, string>(), families = new Map<string, string>();
	for (const f of sql.exec<{ fk: string | null; label: string | null; family: string | null; rk: string | null }>(`SELECT json_extract(attrs, '$.fact.fact_key') AS fk,
		json_extract(attrs, '$.fact.label') AS label, json_extract(attrs, '$.fact.family') AS family, json_extract(attrs, '$.fact.repo_key') AS rk
		FROM nodes WHERE scope = ? AND json_valid(attrs)`, FACT_SCOPE).toArray()) {
		if (!f.fk) continue;
		if (f.label) labels.set(f.fk, f.label);
		else if (f.family && f.rk) families.set(`${f.rk}\n${f.fk}`, f.family);
	}
	const familyIn = (repo: string, fk: string) => {
		const l = labels.get(fk);
		return l ? sha256(`${repo}\n${l}`).slice(0, 16) : families.get(`${repo}\n${fk}`) ?? null;
	};
	const receiptRepos = new Map<string, string>(); // session ref -> the first receipt's repo, for a node with no project link
	const receiptWeeks = new Map<string, string>(); // session ref -> the first receipt's week, for its guidance rows
	for (const r of rows) {
		let b: { session?: unknown; attribution?: unknown; injected?: unknown; families?: unknown };
		try { b = JSON.parse(r.body) as typeof b; } catch { continue; }
		const ref = typeof b.session === "string" ? b.session : r.report_id.slice(2);
		const node = byRef.get(ref), week = weekOf(r.day), a = acc(r.repo_key, week);
		if (!receiptRepos.has(ref)) { receiptRepos.set(ref, r.repo_key); receiptWeeks.set(ref, week); }
		if (!a) continue;
		a.guided.seen.add(ref);
		if (node?.consolidated) a.guided.captured.add(ref);
		// A v1 report the server mapped in has injected: [] by construction, so it says nothing about guidance.
		if (b.attribution === "legacy") continue;
		const injected = (Array.isArray(b.injected) ? b.injected : []) as Injected[];
		const fams = new Set(Array.isArray(b.families) ? b.families.filter((x): x is string => typeof x === "string") : []);
		a.guided.sessions++;
		if (injected.length) a.guided.guided++;
		for (const i of injected) {
			if (i.kind === "memory") continue; // counted from the guidance receipts below
			a.followed.injected++;
			const fired = i.outcome === "fired", prevented = i.outcome === "prevented";
			const fam = i.kind === "fact" && typeof i.fact_key === "string" ? familyIn(r.repo_key, i.fact_key) : null;
			if (fired || prevented || (fam !== null && fams.has(fam))) a.followed.exercised++;
			if (fired) a.followed.fired++;
			if (prevented) a.followed.prevented++;
		}
	}

	// ---- Memory guidance (#127): one row per injected memory per session, settled once the batch processed the session ----
	if (hasTable(sql, "guidance_injections") && receiptRepos.size) {
		for (const g of sql.exec<{ session_ref: string; state: string }>(`SELECT session_ref, state FROM guidance_injections WHERE session_ref IN (SELECT value FROM json_each(?))`,
			JSON.stringify([...receiptRepos.keys()])).toArray()) {
			const a = acc(receiptRepos.get(g.session_ref)!, receiptWeeks.get(g.session_ref)!);
			if (!a) continue;
			a.followed.memory.injected++;
			if (g.state !== "pending") a.followed.memory.processed++;
			if (g.state === "failed") a.followed.memory.failed++;
		}
	}

	// ---- Corrections and repeats (session digests and the learning worker's evidence) ----
	const corrections = new Map(sql.exec<{ id: string; c: number }>(`SELECT t.node_id AS id,
		sum(CASE WHEN json_valid(t.body) THEN coalesce(json_array_length(t.body, '$.corrections'), 0) ELSE 0 END) AS c
		FROM texts t WHERE t.node_id IN (SELECT value FROM json_each(?)) AND ${CURRENT_PART} GROUP BY t.node_id`, ids).toArray().map((r) => [r.id, r.c]));
	// A session's correction items: learned once every preference_signal item that names it is done or dismissed.
	const items = new Map(sql.exec<{ id: string; waiting: number }>(`SELECT j.value AS id, max(m.state IN ('open', 'leased', 'stuck')) AS waiting
		FROM maintenance m, json_each(m.subjects) j WHERE m.kind = 'preference_signal' AND j.value IN (SELECT value FROM json_each(?)) GROUP BY j.value`, ids)
		.toArray().map((r) => [r.id, r.waiting === 1]));
	const matched = new Map<string, Set<string>>();
	// #127: the batch's own correction matches when stored, one per correction; else the evidence the matched rule received.
	const exact = hasTable(sql, "correction_matches") ? new Map(sql.exec<{ id: string; n: number }>(`SELECT session_id AS id, count(DISTINCT correction_index) AS n
		FROM correction_matches WHERE repeat = 1 AND session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id`, ids).toArray().map((r) => [r.id, r.n])) : null;
	if (!exact) for (const e of sql.exec<{ session: string; rule: string; created_at: string }>(`SELECT ev.ref AS session, r.id AS rule, r.created_at FROM evidence ev
		JOIN nodes r ON r.id = substr(ev.owner, 3) WHERE ev.kind = 'node' AND ev.ref IN (SELECT value FROM json_each(?)) AND substr(ev.owner, 1, 2) = 'n:'
		AND r.kind = 'rule' AND r.scope <> ? AND r.memory_type IS NOT NULL`, ids, FACT_SCOPE).toArray()) {
		const s = byId.get(e.session);
		if (!s || !(e.created_at < s.first)) continue; // a rule this session created is a new lesson, not a repeat
		let m = matched.get(e.session);
		if (!m) matched.set(e.session, (m = new Set()));
		m.add(e.rule);
	}
	for (const s of sessions) {
		const repo = s.repo ?? receiptRepos.get(s.ref) ?? null, a = acc(repo, s.week);
		if (!a) continue;
		a.guided.seen.add(s.ref);
		if (s.consolidated) a.guided.captured.add(s.ref);
		const c = corrections.get(s.id) ?? 0;
		if (!c) continue;
		a.corr.total += c;
		if (items.get(s.id) !== false) { a.corr.pending += c; continue; } // no item yet, or still waiting
		a.corr.learned += c;
		// One record_lesson per matched rule; a session cannot repeat more lessons than it has corrections.
		a.corr.repeats += Math.min(exact ? exact.get(s.id) ?? 0 : matched.get(s.id)?.size ?? 0, c);
	}

	// ---- Cost per session (fact_days) ----
	if (hasTable(sql, "fact_days")) {
		for (const r of sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM fact_days WHERE day >= ? AND day <= ?`, from, to).toArray()) {
			if (typeof r.repo_key !== "string" || typeof r.day !== "string") continue;
			const a = acc(r.repo_key, weekOf(r.day));
			if (!a) continue;
			for (const k of ["sessions", "usage_sessions", "input", "cached_input", "output", "failed", "repeated_failures"] as const) a.cost[k] += int(r[k]);
		}
	} else missing.push({ metric: "cost", reason: "No daily session cost rows are stored yet (the fact_days table arrives with the repo facts v2 server)." });

	const out: GoalRepo[] = [...repos.entries()].map(([repo_key, w]) => ({ repo_key, weeks: weeks.map((week): GoalWeek => {
		const a = w.get(week) ?? blank(), c = a.cost;
		return {
			week,
			corrections: { ...a.corr, rate: rate(a.corr.repeats, a.corr.learned) },
			guided: { sessions: a.guided.sessions, guided: a.guided.guided, share: rate(a.guided.guided, a.guided.sessions),
				seen: a.guided.seen.size, captured: a.guided.captured.size, coverage: rate(a.guided.captured.size, a.guided.seen.size) },
			followed: { ...a.followed, rate: rate(a.followed.fired + a.followed.prevented, a.followed.exercised),
				prevented_share: rate(a.followed.prevented, a.followed.fired + a.followed.prevented),
				memory: { ...a.followed.memory, rate: rate(a.followed.memory.processed - a.followed.memory.failed, a.followed.memory.processed) } },
			cost: { ...c, tokens_per_session: rate(c.input + c.output, c.usage_sessions), failures_per_session: rate(c.failed, c.sessions),
				cache_ratio: c.usage_sessions >= GOAL_LIMITS.min_sample && c.input > 0 ? c.cached_input / c.input : null },
		};
	}) }));
	// Repos with any data first by most sessions seen, the unlinked bucket last.
	const seen = (r: GoalRepo) => r.weeks.reduce((t, w) => t + w.guided.seen + w.cost.sessions, 0);
	out.sort((x, y) => (x.repo_key === null ? 1 : 0) - (y.repo_key === null ? 1 : 0) || seen(y) - seen(x) || String(x.repo_key).localeCompare(String(y.repo_key)));
	return { from, to, weeks, targets: GOAL_TARGETS, min_sample: GOAL_LIMITS.min_sample, repos: out, missing, truncated };
}
