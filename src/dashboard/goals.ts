// Goals tab (#130): whether agents make fewer mistakes over time, per repo and per week, from GET /api/profiles/P/goal-metrics
// (src/profile/metrics.ts). Four metrics: repeat-correction rate, guided-session share with capture coverage, guidance-followed
// rate, and cost per session. A rate below the server's minimum sample shows "Not enough data", and every input the server does
// not store yet is listed, never shown as zero. Read-only. The profile is the link's ?profile=NAME (none is All profiles).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { GoalMetrics, GoalRepo, GoalWeek } from "../profile/metrics";
import type { Am, Node, Route } from "./am";

export function goalsTab(am: Am): void {
	const { active, choose, el, empty, enc, help, intro, loading, note, pageStatus, why } = am;
	const filters = { weeks: "12", repo: "" };
	const RECENT = 4; // the headline numbers sum the last 4 weeks
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const chip = (parent: Node, text: string, c = "") => cls(el("span", parent, text), c ? `chip ${c}` : "chip");
	const pct = (v: number | null) => (v === null ? "Not enough data" : `${Math.round(v * 100)}%`);
	const num = (v: number | null, d = 0) => (v === null ? "Not enough data" : v.toLocaleString(undefined, { maximumFractionDigits: d }));
	const METRIC: Record<string, string> = { repeat_correction: "Repeat-correction rate", guided_share: "Guided-session share", capture_coverage: "Capture coverage",
		guidance_followed: "Guidance followed", cost: "Cost per session" };

	/** The last RECENT weeks summed, so a headline rate uses every session in them; null under the minimum sample. */
	const recent = (r: GoalRepo, min: number) => {
		const w = r.weeks.slice(-RECENT), sum = (f: (x: GoalWeek) => number) => w.reduce((t, x) => t + f(x), 0);
		const of = (a: number, b: number) => (b >= min ? a / b : null);
		const learned = sum((x) => x.corrections.learned), sessions = sum((x) => x.guided.sessions), seen = sum((x) => x.guided.seen), ex = sum((x) => x.followed.exercised);
		const usage = sum((x) => x.cost.usage_sessions), cs = sum((x) => x.cost.sessions);
		return {
			repeat: of(sum((x) => x.corrections.repeats), learned), guided: of(sum((x) => x.guided.guided), sessions), coverage: of(sum((x) => x.guided.captured), seen),
			followed: of(sum((x) => x.followed.fired + x.followed.prevented), ex),
			memory: of(sum((x) => (x.followed.memory?.processed ?? 0) - (x.followed.memory?.failed ?? 0)), sum((x) => x.followed.memory?.processed ?? 0)), tokens: of(sum((x) => x.cost.input + x.cost.output), usage), failures: of(sum((x) => x.cost.failed), cs),
			pending: sum((x) => x.corrections.pending),
		};
	};
	/** Whether the weekly repeat-correction rate fell (or held) for the last 4 weeks that have one: the target's "4 weeks of decline". */
	const declining = (r: GoalRepo) => {
		const rates = r.weeks.map((w) => w.corrections.rate).filter((v): v is number => v !== null).slice(-RECENT);
		if (rates.length < RECENT) return null;
		return rates.every((v, i) => i === 0 || v <= rates[i - 1]!);
	};
	const stat = (grid: Node, value: string, label: string, term: string, verdict?: boolean | null) => {
		const s = cls(el("div", grid), "stat");
		cls(el("span", s, value), "num");
		const l = cls(el("span", s, label), "lbl");
		help(l, term);
		if (verdict !== undefined && verdict !== null) chip(s, verdict ? "On target" : "Below target", verdict ? "c-ok" : "c-warn");
	};

	const repoView = (parent: Node, m: GoalMetrics, r: GoalRepo, profile: string | null) => {
		const sec = cls(el("section", parent), "panel"), t = m.targets;
		el("h3", sec, r.repo_key ?? "Sessions with no linked GitHub repo");
		if (profile) chip(sec, profile, "chip-profile");
		const x = recent(r, m.min_sample), down = declining(r);
		const grid = cls(el("div", sec), "stats");
		stat(grid, pct(x.repeat), `Repeat corrections, last ${RECENT} weeks (target under ${Math.round(t.repeat_correction * 100)}%)`, "repeat_correction",
			x.repeat === null ? null : x.repeat < t.repeat_correction && down === true);
		stat(grid, pct(x.guided), `Guided sessions (target ${Math.round(t.guided_share * 100)}%)`, "guided_share", x.guided === null ? null : x.guided >= t.guided_share);
		stat(grid, pct(x.coverage), `Capture coverage (target ${Math.round(t.capture_coverage * 100)}%)`, "capture_coverage", x.coverage === null ? null : x.coverage >= t.capture_coverage);
		stat(grid, pct(x.followed), "Guidance followed: facts", "guidance_followed");
		stat(grid, pct(x.memory), "Guidance followed: lessons", "guidance_followed");
		stat(grid, num(x.tokens), "Tokens per session", "session_cost");
		stat(grid, num(x.failures, 2), "Failed commands per session", "session_cost");
		note(sec, `Repeat corrections ${down === null ? "have fewer than 4 weeks with enough data to show a trend" : down ? "fell or held each of the last 4 weeks with data" : "rose in at least one of the last 4 weeks with data"}.${x.pending ? ` ${x.pending} correction${x.pending === 1 ? " waits" : "s wait"} for the learning batch and ${x.pending === 1 ? "is" : "are"} not counted yet.` : ""}`, "muted");

		const wrap = cls(el("div", sec), "tablewrap");
		const table = el("table", wrap);
		el("caption", table, `${r.repo_key ?? "Unlinked sessions"} by week`).setAttribute("class", "vh");
		const hr = el("tr", el("thead", table));
		for (const c of ["Week of", "Repeat corrections", "Guided sessions", "Capture coverage", "Guidance followed (facts, lessons)", "Tokens / session", "Failed / session"]) el("th", hr, c).setAttribute("scope", "col");
		const tb = el("tbody", table);
		for (const w of [...r.weeks].reverse()) {
			const tr = el("tr", tb);
			el("td", tr, w.week);
			const cell = (main: string, detail: string) => { const td = el("td", tr); el("div", td, main); cls(el("div", td, detail), "muted"); };
			cell(pct(w.corrections.rate), `${w.corrections.repeats} of ${w.corrections.learned} learned${w.corrections.pending ? `, ${w.corrections.pending} waiting` : ""}`);
			cell(pct(w.guided.share), `${w.guided.guided} of ${w.guided.sessions} reported`);
			cell(pct(w.guided.coverage), `${w.guided.captured} of ${w.guided.seen} seen`);
			const mem = w.followed.memory;
			const fol = el("td", tr);
			el("div", fol, `Facts ${pct(w.followed.rate)}`);
			cls(el("div", fol, `fired ${w.followed.fired}, prevented ${w.followed.prevented}, exercised ${w.followed.exercised} of ${w.followed.injected} injected${w.followed.prevented_share === null ? "" : `; ${Math.round(w.followed.prevented_share * 100)}% prevented`}`), "muted");
			el("div", fol, `Lessons ${mem ? pct(mem.rate) : "Not reported"}`);
			if (mem) cls(el("div", fol, `${mem.processed - mem.failed} of ${mem.processed} processed followed, ${mem.injected} injected`), "muted");
			cell(num(w.cost.tokens_per_session), `${w.cost.usage_sessions} with usage${w.cost.cache_ratio === null ? "" : `, ${Math.round(w.cost.cache_ratio * 100)}% cached`}`);
			cell(num(w.cost.failures_per_session, 2), `${w.cost.failed} failed, ${w.cost.repeated_failures} repeated, ${w.cost.sessions} sessions`);
		}
	};

	am.tab({ id: "goals", group: "insight", label: "Goals", key: "t", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion, h = el("h2", root, "Goals"), named = route.query.profile;
		intro(root, "Goals", "goals", "Whether your agents repeat fewer mistakes over time, per repo and per week (weeks start Monday, UTC). A number needs at least a few sessions behind it; until then it shows Not enough data.");
		const { say } = pageStatus(root);
		if (!active().length) { empty(root, "No active profiles yet."); return h; }
		const tools = cls(el("form", root), "toolbar");
		tools.addEventListener("submit", (event) => event.preventDefault());
		const weeks = choose(tools, "goals-weeks", "Weeks", [["4", "Last 4 weeks"], ["12", "Last 12 weeks"], ["26", "Last 26 weeks"]]);
		weeks.value = filters.weeks;
		const repo = choose(tools, "goals-repo", "Repo", [["", "All repos"]]);
		const notes = el("div", root), out = el("div", root), wait = loading(root);

		const load = async () => {
			const my = am.pageVersion;
			say("Loading goal metrics…");
			out.replaceChildren();
			notes.replaceChildren();
			const results = await am.eachProfile(named ?? null, async (p) => ({ name: p.name, m: await am.call(`/api/profiles/${enc(p.name)}/goal-metrics?weeks=${enc(filters.weeks)}`) as GoalMetrics }));
			if (my !== am.pageVersion || version !== am.pageVersion) return;
			wait.replaceChildren();
			wait.hidden = true;
			const ok = results.flatMap((r) => (r.ok && Array.isArray(r.value.m?.repos) ? [r.value] : []));
			const bad = results.filter((r) => !r.ok || !Array.isArray(r.value.m?.repos)).map((r) => `${r.profile}: ${r.ok ? "the reply had no repos" : why(r.error)}`);
			const names = [...new Set(ok.flatMap((x) => x.m.repos.map((r) => r.repo_key ?? "")))].sort();
			repo.replaceChildren();
			for (const [v, t] of [["", "All repos"], ...names.filter(Boolean).map((n) => [n, n]), ...(names.includes("") ? [["(none)", "No linked repo"]] : [])] as [string, string][])
				el("option", repo, t).setAttribute("value", v);
			repo.value = [...names, "(none)"].includes(filters.repo) ? filters.repo : "";
			// Inputs not stored yet, once per metric and reason across profiles.
			const missing = new Map<string, string>();
			for (const x of ok) for (const g of x.m.missing) missing.set(`${g.metric}\n${g.reason}`, `${METRIC[g.metric] ?? g.metric}: ${g.reason}`);
			for (const t of missing.values()) note(notes, t, "warn");
			if (ok.some((x) => x.m.truncated)) note(notes, "The read hit its bound (5,000 sessions or 20,000 receipts in the window); the oldest weeks may be undercounted. Choose fewer weeks.", "warn");
			let shown = 0;
			for (const x of ok) for (const r of x.m.repos) {
				const key = r.repo_key ?? "(none)";
				if (filters.repo && key !== filters.repo) continue;
				repoView(out, x.m, r, named ? null : x.name);
				shown++;
			}
			const span = ok[0] ? ` from ${ok[0].m.from} to ${ok[0].m.to}` : "";
			say([bad.length ? `Could not load ${bad.join("; ")}; those profiles are not shown.` : "", `${shown} repo${shown === 1 ? "" : "s"}${span}.`].filter(Boolean).join(" "));
			if (!shown && !bad.length) empty(out, "No sessions in this window yet. Metrics appear once capture uploads session digests and repo facts report sessions.", "agent-memory doctor");
		};
		weeks.addEventListener("change", () => { filters.weeks = weeks.value; void load(); });
		repo.addEventListener("change", () => { filters.repo = repo.value; void load(); });
		void load();
		return h;
	} });
}
