// Facts tab (#118): repo facts by repo, next to Lessons. Each fact shows its state (candidate, active, dormant, retired), its tier
// (repo, or user when active in 2 or more repos), its lanes (one shared lane for repo-class facts, one per device for environment
// facts) with firing counts, and its evidence. Writes only on a click: pin and unpin, forget and retire are the node actions; flag
// (reason required) is POST .../facts/flag. Below the list, cache-aware session cost per repo and day from .../facts/efficiency.
// Reads GET /api/profiles/P/facts (paged by next_after). The profile is the link's ?profile=NAME (none is All profiles).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { FactEfficiencyRow, FactListItem } from "../domain/types";
import type { Am, J, Node, Profile, Route } from "./am";

export function factsTab(am: Am): void {
	const { act, active, btn, call, choose, copy, day, el, empty, enc, input, intro, loading, mcpCall, mcpCurl, note, pageStatus, recorded, undoOf, why } = am;
	type Fact = FactListItem & { profile: string };
	type Day = FactEfficiencyRow & { profile: string };
	const PAGE = 200;
	const STATES = ["candidate", "active", "dormant", "retired"];
	const filters = { q: "", repo: "", state: "", tier: "", range: "30" }; // kept across the re-render that follows each action
	const base = (p: string) => `/api/profiles/${enc(p)}`;
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const chip = (parent: Node, text: string, c = "") => cls(el("span", parent, text), c ? `chip ${c}` : "chip");
	const shown = (f: FactListItem) => (f.dormant ? "dormant" : f.state);
	const STATE_CLS: Record<string, string> = { active: "c-ok", candidate: "c-blue", dormant: "c-warn", retired: "c-fail" };
	const num = (n: number | null, digits = 0) => (n === null || !Number.isFinite(n) ? "Not enough data" : n.toLocaleString(undefined, { maximumFractionDigits: digits }));
	const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? "Not enough data" : `${Math.round(n * 100)}%`);
	const laneName = (l: string) => (l === "*" ? "shared" : `device ${l.slice(0, 8)}`);
	const totals = (f: FactListItem) => f.lanes.reduce((t, l) => ({ exercised: t.exercised + l.exercised, fired: t.fired + l.fired, prevented: t.prevented + l.prevented }),
		{ exercised: 0, fired: 0, prevented: 0 });
	const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

	am.tab({ id: "facts", group: "memory", label: "Facts", key: "f", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion, h = el("h2", root, "Facts"), named = route.query.profile, all = named === undefined;
		intro(root, "Facts", "facts", "What past sessions showed about each repo, such as a command that needs a wrapper or a tool that is missing. A fact injects at session start once it is active; a wrong one can be flagged with a reason, which retires it with an Undo.");
		const { msg, say } = pageStatus(root);

		const tools = cls(el("form", root), "toolbar");
		tools.setAttribute("role", "search");
		tools.addEventListener("submit", (event) => event.preventDefault());
		const q = input(tools, "facts-q", "Filter facts (press /)");
		q.setAttribute("type", "search");
		q.value = filters.q;
		const repo = choose(tools, "facts-repo", "Repo", [["", "All repos"]]);
		const state = choose(tools, "facts-state", "State", [["", "All states"], ...STATES.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)] as [string, string])]);
		state.value = filters.state;
		const tier = choose(tools, "facts-tier", "Tier", [["", "All tiers"], ["repo", "Repo"], ["user", "User"]]);
		tier.value = filters.tier;

		const box = cls(el("section", root), "agentbox");
		box.setAttribute("aria-label", "Use facts from an agent or a terminal");
		el("h3", box, "Use facts from an agent or a terminal");
		el("p", box, "Agents list facts and flag a wrong one with repo_facts. The terminal command sends the same call to /mcp with a device token; flagging needs the write scope. Set AGENT_MEMORY_TOKEN first.");
		const listArgs = () => ({ action: "list", ...(filters.repo ? { repo_key: filters.repo } : {}), ...(named ? { profile: named } : {}),
			...(filters.state ? { state: filters.state } : {}), ...(filters.tier ? { tier: filters.tier } : {}) });
		copy(box, "Copy MCP call", () => mcpCall("repo_facts", listArgs()));
		copy(box, "Copy curl", () => mcpCurl("repo_facts", listArgs()));

		if (!active().length) { empty(root, "No active profiles yet."); return h; }
		const wrap = cls(el("div", root), "tablewrap");
		const table = el("table", wrap);
		table.hidden = true;
		el("caption", table, "Repo facts");
		const head = el("tr", el("thead", table));
		for (const c of ["Fact", "Repo", "State", "Lanes", "Firing", "Updated", "Actions"]) el("th", head, c).setAttribute("scope", "col");
		const body = el("tbody", table);
		const wait = loading(root);
		const more = btn(root, "Load more", () => load());
		more.hidden = true;

		const rows: Fact[] = [];
		const after = new Map<string, string | null>(); // per profile still to read: its next cursor; absent once its list is done
		let started = false;
		const failed: string[] = [];

		const row = (it: Fact) => {
			const tr = el("tr", body), name = it.statement || it.literal, s = shown(it), t = totals(it);
			const first = el("td", tr);
			chip(first, it.detector.replace(/_/g, " "));
			chip(first, it.class === "repo" ? "repo class" : "environment");
			el("strong", first, ` ${it.statement}`);
			const lit = el("p", first);
			cls(el("code", lit, it.literal), "mono");
			const ev = el("details", first);
			el("summary", ev, `Evidence (${it.evidence.length})`);
			if (it.evidence.length) {
				const ul = el("ul", ev);
				for (const e of it.evidence) el("li", ul, `${e.kind}: ${e.ref}${e.note ? ` (${e.note})` : ""}`);
			} else note(ev, "No evidence pointers.");
			const r = el("td", tr);
			el("span", r, it.repo_key);
			if (all) chip(el("div", r), it.profile, "chip-profile");
			const st = el("td", tr);
			chip(st, s.toUpperCase(), STATE_CLS[s] ?? "");
			chip(st, it.user_tier ? "USER TIER" : "REPO TIER", it.user_tier ? "c-teal" : "");
			if (it.pinned) chip(st, "PINNED", "chip-pinned");
			if (it.high_stakes) chip(st, "HIGH STAKES", "c-warn");
			const lanes = el("td", tr);
			el("span", lanes, it.class === "repo" ? "Shared" : `${it.lanes.length} device${it.lanes.length === 1 ? "" : "s"}`);
			const ld = el("details", lanes);
			el("summary", ld, "Lanes");
			const ul = el("ul", ld);
			for (const l of it.lanes) {
				el("li", ul, `${laneName(l.lane)}: ${l.state}${l.eligible ? ", injects" : ""}; ${l.confirmations} confirmations; exercised ${l.exercised}, fired ${l.fired}, prevented ${l.prevented}`
					+ `${l.rate === null ? "" : ` (${Math.round(l.rate * 100)}%)`}${l.last_event ? `; last ${l.last_event.kind} ${day(l.last_event.order.slice(0, 24))}` : ""}`);
			}
			const fire = el("td", tr);
			el("div", fire, `Exercised ${t.exercised}`);
			el("div", fire, `Fired ${t.fired}, prevented ${t.prevented}`);
			if (t.exercised) {
				const bar = el("meter", fire);
				bar.setAttribute("min", "0");
				bar.setAttribute("max", "1");
				bar.setAttribute("value", String(Math.min((t.fired + t.prevented) / t.exercised, 1)));
				bar.setAttribute("aria-label", `Firing rate ${Math.round(((t.fired + t.prevented) / t.exercised) * 100)}%`);
				el("span", fire, `${Math.round(((t.fired + t.prevented) / t.exercised) * 100)}%`);
			} else note(fire, "Not exercised yet");
			el("td", tr, day(it.updated_at || null));

			const cell = el("td", tr), node = `${base(it.profile)}/nodes/${enc(it.memory_id)}`;
			const done = (verb: string, extra = "") => (res: J) => ({ text: `Done: ${recorded(res?.action ?? verb)} “${name}”.${extra}`, undo: undoOf(it.profile, res) });
			const confirm = (ask: string, label: string, run: () => void) => {
				cell.replaceChildren();
				const p = el("span", cell, ask);
				p.setAttribute("tabindex", "-1");
				btn(cell, label, run, `${label} ${name}`);
				btn(cell, "Cancel", () => actions().focus());
				p.focus();
			};
			const actions = (): Node => {
				cell.replaceChildren();
				const verb = it.pinned ? "unpin" : "pin";
				const first = btn(cell, it.pinned ? "Unpin" : "Pin", () => act(`${node}/${verb}`, `${verb} “${name}”`, undefined, done(verb)), `${it.pinned ? "Unpin" : "Pin"} ${name}`);
				if (s !== "retired") {
					btn(cell, "Flag…", () => {
						cell.replaceChildren();
						const f = el("form", cell);
						f.addEventListener("submit", (event) => event.preventDefault());
						const reason = input(f, `flag-${it.memory_id}`, "Why is it wrong? (required)", "textarea");
						reason.setAttribute("maxlength", "200");
						reason.setAttribute("required", "");
						const scope = choose(f, `flag-scope-${it.memory_id}`, "Flag in", [["repo", "This repo"], ["user", "Every repo of this profile"]]);
						const warn = el("p", f);
						warn.setAttribute("role", "alert");
						btn(f, "Flag it", () => {
							const why = reason.value.trim();
							if (!why) { warn.textContent = "Give a reason first."; reason.focus(); return; }
							act(`${base(it.profile)}/facts/flag`, `flag “${name}”`, { memory_id: it.memory_id, scope: scope.value, reason: why, request_id: `dashboard:${crypto.randomUUID()}` },
								done("flag", " It is retired and no longer injected; Undo brings it back."));
						}, `Flag ${name} now`);
						btn(f, "Cancel", () => actions().focus());
						reason.focus();
					}, `Flag ${name}`);
					btn(cell, "Retire…", () => confirm(`Retire “${name}”? It stops injecting and stays retired; Undo brings it back. `, "Retire it",
						() => act(`${node}/retire`, `retire “${name}”`, undefined, done("retire"))), `Retire ${name}`);
				}
				btn(cell, "Forget…", () => confirm(`Forget “${name}”? It moves to the archive; Undo brings it back. `, "Forget it",
					() => act(`${node}/forget`, `forget “${name}”`, undefined, done("forget", " It is in the archive; Undo brings it back."))), `Forget ${name}`);
				return first;
			};
			actions();
			copy(el("p", cell), "Copy ID", () => it.memory_id);
		};
		const matches = (it: Fact) => {
			const t = filters.q.toLowerCase();
			return (!t || `${it.statement}\n${it.literal}\n${it.repo_key}`.toLowerCase().includes(t)) && (!filters.repo || it.repo_key === filters.repo)
				&& (!filters.state || shown(it) === filters.state) && (!filters.tier || (filters.tier === "user") === it.user_tier);
		};
		const draw = () => {
			body.replaceChildren();
			const list = rows.filter(matches);
			for (const it of list) row(it);
			table.hidden = !rows.length;
			more.hidden = !after.size;
			say([failed.length ? `Could not load ${failed.join("; ")}.` : "",
				rows.length ? `Showing ${list.length} of ${rows.length} fact${rows.length === 1 ? "" : "s"} loaded${after.size ? "; more are available" : ""}.` : ""].filter(Boolean).join(" "));
		};
		const repoOptions = (sel: Node, chosen: string) => {
			const names = [...new Set(rows.map((r) => r.repo_key))].sort();
			sel.replaceChildren();
			for (const [v, t] of [["", "All repos"], ...names.map((n) => [n, n])] as [string, string][]) el("option", sel, t).setAttribute("value", v);
			sel.value = names.includes(chosen) ? chosen : "";
			return sel.value;
		};
		const load = async () => {
			more.disabled = true;
			say(rows.length ? "Loading more facts…" : "Loading facts…");
			failed.length = 0;
			const added: Fact[] = [];
			const page = async (p: Profile): Promise<Fact[]> => {
				if (!after.has(p.name)) after.set(p.name, null);
				const cursor = after.get(p.name);
				const r = await call(`${base(p.name)}/facts?limit=${PAGE}${cursor ? `&after=${enc(cursor)}` : ""}`);
				if (!Array.isArray(r?.facts)) throw new Error("the server sent no fact list");
				if (typeof r.next_after === "string" && r.next_after) after.set(p.name, r.next_after);
				else after.delete(p.name);
				return r.facts.filter((f: J) => f && typeof f.memory_id === "string" && Array.isArray(f.lanes)).map((f: FactListItem) => ({ ...f, evidence: Array.isArray(f.evidence) ? f.evidence : [], profile: p.name }));
			};
			const results = started ? (await Promise.all([...after.keys()].map((n) => am.eachProfile(n, page)))).flat() : await am.eachProfile(named ?? null, page);
			started = true;
			for (const r of results) {
				if (r.ok) added.push(...r.value);
				else { failed.push(`${r.profile}: ${why(r.error)}`); if (!after.has(r.profile)) after.set(r.profile, null); }
			}
			if (version !== am.pageVersion) return;
			wait.replaceChildren();
			wait.hidden = true;
			rows.push(...added);
			more.disabled = false;
			more.textContent = failed.length ? "Try again" : "Load more";
			filters.repo = repoOptions(repo, filters.repo);
			repoOptions(costRepo, filters.repo);
			draw();
			if (!rows.length && !after.size) empty(listEmpty, "No repo facts yet. They appear after sessions in a GitHub repo show the same failure and fix more than once, with repo facts reporting on.", "agent-memory doctor");
			if (more.hidden && rows.length > added.length) msg.focus();
		};
		const listEmpty = el("div", root);

		// ---- Session cost per repo and day (fact_days) ----
		const cost = cls(el("section", root), "panel");
		cost.setAttribute("aria-labelledby", "facts-cost");
		const ch = el("h3", cost, "Session cost by repo and day");
		ch.setAttribute("id", "facts-cost");
		am.help(ch, "session_cost");
		note(cost, "Tokens per session divide by the sessions that reported usage; failures per session divide by every session. Uncached input is input minus cache reads, so it includes cache writes.", "muted");
		const ctools = cls(el("form", cost), "toolbar");
		ctools.addEventListener("submit", (event) => event.preventDefault());
		const costRepo = choose(ctools, "facts-cost-repo", "Repo", [["", "All repos"]]);
		const range = choose(ctools, "facts-cost-range", "Days", [["7", "Last 7 days"], ["30", "Last 30 days"], ["92", "Last 92 days"]]);
		range.value = filters.range;
		const costMsg = el("p", cost);
		costMsg.setAttribute("role", "status");
		const cwrap = cls(el("div", cost), "tablewrap");
		const loadCost = async () => {
			const my = am.pageVersion, days = Number(filters.range) || 30, to = isoDay(Date.now()), from = isoDay(Date.now() - (days - 1) * 86_400_000);
			costMsg.textContent = "Loading session cost…";
			cwrap.replaceChildren();
			const results = await am.eachProfile(named ?? null, async (p): Promise<Day[]> => {
				const r = await call(`${base(p.name)}/facts/efficiency?from=${from}&to=${to}${costRepo.value ? `&repo_key=${enc(costRepo.value)}` : ""}`);
				if (!Array.isArray(r?.rows)) throw new Error("the server sent no rows");
				return r.rows.map((x: FactEfficiencyRow) => ({ ...x, profile: p.name }));
			});
			if (my !== am.pageVersion) return;
			const bad = results.filter((r) => !r.ok).map((r) => `${r.profile}: ${r.ok ? "" : why(r.error)}`);
			const list = results.flatMap((r) => (r.ok ? r.value : [])).sort((a, b) => b.day.localeCompare(a.day) || a.repo_key.localeCompare(b.repo_key));
			costMsg.textContent = [bad.length ? `Could not load ${bad.join("; ")}; those profiles are not counted.` : "",
				list.length ? `${list.length} repo-day${list.length === 1 ? "" : "s"} from ${from} to ${to}.` : `No session cost recorded from ${from} to ${to}.`].filter(Boolean).join(" ");
			if (!list.length) return;
			const t = el("table", cwrap);
			el("caption", t, "Session cost per repo and day");
			const hr = el("tr", el("thead", t));
			for (const c of ["Day", "Repo", "Sessions", "Uncached input / session", "Cached input / session", "Output / session", "Cache ratio", "Failed / session", "Repeated failures / session"])
				el("th", hr, c).setAttribute("scope", "col");
			const tb = el("tbody", t);
			for (const d of list) {
				const tr = el("tr", tb), u = d.usage_sessions, per = (n: number) => (u > 0 ? n / u : null), perS = (n: number) => (d.sessions > 0 ? n / d.sessions : null);
				el("td", tr, d.day);
				const rc = el("td", tr, d.repo_key);
				if (all) chip(rc, d.profile, "chip-profile");
				el("td", tr, `${d.sessions.toLocaleString()}${u !== d.sessions ? ` (${u.toLocaleString()} with usage)` : ""}`);
				el("td", tr, num(per(d.input - d.cached_input)));
				el("td", tr, num(per(d.cached_input)));
				el("td", tr, num(per(d.output)));
				el("td", tr, pct(d.input > 0 ? d.cached_input / d.input : null));
				el("td", tr, num(perS(d.failed), 2));
				el("td", tr, num(perS(d.repeated_failures), 2));
			}
		};
		costRepo.addEventListener("change", () => { void loadCost(); });
		range.addEventListener("change", () => { filters.range = range.value; void loadCost(); });

		q.addEventListener("input", () => { filters.q = q.value.trim(); draw(); });
		repo.addEventListener("change", () => { filters.repo = repo.value; costRepo.value = repo.value; draw(); void loadCost(); });
		state.addEventListener("change", () => { filters.state = state.value; draw(); });
		tier.addEventListener("change", () => { filters.tier = tier.value; draw(); });
		void load().then(() => { if (version === am.pageVersion) void loadCost(); });
		return h;
	} });
}
