// Actions tab (#27): each active profile's uploaded work items from the owner board read (state=all), ranked by board score.
// Items mirror the PR and Jira state the owner's machines last uploaded, so this tab only reads; nothing here marks an item
// done or blocked. The profile is the link's ?profile=NAME (the shell's header picker; none is All profiles); an item id is
// per profile, so #actions/ID opens its detail only with ?profile and otherwise asks which profile.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Route } from "./am";

export function actionsTab(am: Am): void {
	const { active, btn, call, choose, copy, curl, day, el, empty, enc, facts, input, intro, link, loading, mcpCall, mcpCurl, note, pageStatus, recorded, why, win } = am;
	type Ref = { id: string; readable?: false; kind?: string; name?: string };
	type Item = { profile: string; as_of: string; id: string; kind: string; key: string | null; name: string; scope: string; priority: string | null; due: string | null;
		score: number; reasons: { term: string; points: number; text: string }[]; stale: boolean; last_activity_at: string; blocked_by: Ref[]; blocks: Ref[];
		unrecognized: string[]; state: string | null; status: string | null };
	type Board = { profile: string; as_of: string; total: number | null; truncated: boolean; without_state: number | null; partial: boolean; skipped: number };
	const filters = { q: "", status: "" };
	// The keys work-upload.ts writes: github:org/repo#N for a PR (github.com only), jira:KEY-N for a ticket. Jira's site address is not stored.
	const PR = /^github:([a-z0-9][\w.-]*)\/([\w.-]+)#(\d{1,9})$/i, JIRA = /^jira:(([A-Z][A-Z0-9_]*)-\d+)$/;
	const project = (it: Item) => { const k = it.key ?? "", pr = PR.exec(k), jira = JIRA.exec(k); return pr ? `${pr[1]}/${pr[2]}` : jira ? jira[2]! : it.scope; };
	const sourceUrl = (it: Item) => { const pr = PR.exec(it.key ?? ""); return pr ? `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}` : null; };
	// The uploaded state as stored: "open", "closed" or none. GitHub merged PRs arrive as closed; uploads carry no merged flag.
	const stateLabel = (it: Item) => (it.state === "open" || it.state === "closed" ? it.state.toUpperCase() : it.state ? `UNRECOGNIZED: ${it.state}` : "NO STATE");
	const str = (v: unknown) => (typeof v === "string" ? v : "");

	am.tab({ id: "actions", group: "work", label: "Actions", key: "a", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion, h = el("h2", root, "Actions"), named = route.query.profile;
		const here = (id?: string, profile = named) => `#actions${id ? `/${enc(id)}` : ""}${profile ? `?profile=${enc(profile)}` : ""}`;
		intro(root, "Actions", "actions", "PRs and Jira tickets your machines uploaded, ranked by the work board's score. Status mirrors GitHub and Jira as last uploaded, so there is no Mark done or Mark blocked here: change the item at its source and the next upload updates it.");
		const { say } = pageStatus(root);
		const one = named ?? null; // the shell has already refused an unknown or inactive ?profile

		const tools = el("form", root);
		tools.setAttribute("class", "toolbar");
		tools.setAttribute("role", "search");
		tools.addEventListener("submit", (event) => event.preventDefault());
		const q = input(tools, "actions-q", "Filter actions (press /)");
		q.setAttribute("type", "search");
		q.value = filters.q;
		const status = choose(tools, "actions-status", "Status", [["", "Any status"], ["open", "Open"], ["closed", "Closed"], ["none", "No recorded state"],
			["stale", "Open, no activity for 14 days"], ["blocked", "Open and blocked"]]);
		status.value = filters.status;

		const box = el("section", root);
		box.setAttribute("class", "agentbox");
		box.setAttribute("aria-label", "Work with actions from an agent or a terminal");
		el("h3", box, "Work with actions from an agent or a terminal");
		el("p", box, "Agents read the open board with work_board; the MCP curl sends that call with a device token (set AGENT_MEMORY_TOKEN). The owner curl reads what this tab shows, closed items included, and needs the owner's token in AGENT_MEMORY_OWNER_TOKEN.");
		const differs = el("p", box);
		differs.setAttribute("class", "na");
		differs.hidden = true;
		copy(box, "Copy MCP call", () => mcpCall("work_board", one ? { profile: one } : {}));
		copy(box, "Copy MCP curl", () => mcpCurl("work_board", one ? { profile: one } : {}));
		if (one) copy(box, "Copy owner curl", () => curl("GET", `/api/profiles/${enc(one)}/board?state=all&limit=200`));

		if (!active().length) { empty(root, "No active profiles yet."); return h; }
		if (route.id && !one) {
			// With All profiles an id is ambiguous; nothing is opened until the profile is named.
			note(root, `Choose the profile that holds work item ${route.id}:`, "");
			const ul = el("ul", root);
			for (const p of active()) link(el("li", ul), here(route.id, p.name), p.name);
		}
		const layout = el("div", root);
		layout.setAttribute("class", "split");
		const table = el("table", layout);
		table.hidden = true;
		el("caption", table, "Work items, highest score first");
		const head = el("tr", el("thead", table));
		for (const c of ["Title", "Project", "Tags", "Status", "Priority", "Updated"]) el("th", head, c).setAttribute("scope", "col");
		const body = el("tbody", table);
		body.setAttribute("data-list", "");
		const detail = el("aside", layout);
		detail.setAttribute("aria-label", "Action detail");
		detail.setAttribute("tabindex", "-1");
		detail.hidden = true;
		const wait = loading(root);
		const notes = el("div", root);

		const items: Item[] = [], boards: Board[] = [], failed: string[] = [];
		let selected = one && route.id ? `${one}/${route.id}` : undefined; // profile/id
		const matches = (it: Item) => {
			const t = filters.q.toLowerCase(), f = filters.status;
			return (!t || [it.name, it.key ?? "", project(it), it.kind, it.status ?? ""].join("\n").toLowerCase().includes(t))
				&& (!f || (f === "none" ? it.state !== "open" && it.state !== "closed" : f === "stale" ? it.state === "open" && it.stale
					: f === "blocked" ? it.state === "open" && it.blocked_by.length > 0 : it.state === f));
		};
		const refs = (parent: Node, title: string, list: Ref[]) => {
			el("h4", parent, title);
			if (!list.length) { note(parent, "None"); return; }
			const ul = el("ul", parent);
			for (const r of list) el("li", ul, r.readable === false ? `Not readable here: ${r.id}` : `${recorded(r.kind)}: ${recorded(r.name)} (${r.id})`);
		};
		const show = (it: Item, moveFocus: boolean) => {
			selected = `${it.profile}/${it.id}`;
			if (one) win.history?.replaceState?.(null, "", here(it.id));
			detail.replaceChildren();
			detail.hidden = false;
			const close = btn(detail, "Close", () => { selected = undefined; detail.hidden = true; if (one) win.history?.replaceState?.(null, "", here()); draw(); }, "Close the action detail");
			close.setAttribute("data-close", "");
			el("h3", detail, it.name || "(no title)");
			el("span", detail, it.kind.toUpperCase()).setAttribute("class", "chip");
			el("span", detail, stateLabel(it)).setAttribute("class", `chip chip-${it.state === "open" || it.state === "closed" ? it.state : "none"}`);
			facts(detail, [["Key", recorded(it.key)], ["Project", recorded(project(it))], ["Profile", it.profile], ["Source status", recorded(it.status)],
				["Score", String(it.score)], ["Source priority", recorded(it.priority)], ["Due", recorded(it.due)], ["Last activity", recorded(it.last_activity_at)], ["As of", it.as_of]]);
			el("h4", detail, "Source");
			const url = sourceUrl(it), src = el("p", detail), jira = JIRA.exec(it.key ?? "");
			if (url) { const a = el("a", src, url); a.setAttribute("href", url); a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("target", "_blank"); }
			else note(src, jira ? `Jira ${jira[1]}. The Jira site address is not stored, so there is no link.` : "No source address is recorded for this item.");
			if (it.kind === "pr" && it.state === "closed") note(detail, "Closed includes merged: uploads do not record whether a PR was merged.");
			el("h4", detail, "Why this score");
			const reasons = it.reasons.filter((r) => r.points !== 0);
			if (reasons.length) { const ul = el("ul", detail); for (const r of reasons) el("li", ul, `${r.term}: ${r.points > 0 ? "+" : ""}${r.points}. ${r.text}`); }
			else note(detail, "No score reasons reported.");
			refs(detail, "Blocked by", it.blocked_by);
			refs(detail, "Blocks", it.blocks);
			if (it.unrecognized.length) note(detail, `Unrecognized fields: ${it.unrecognized.join(", ")}. The board scored them with its fallback.`);
			const row = el("p", detail);
			if (!one) { link(row, here(it.id, it.profile), `Open in ${it.profile}`); el("span", row, " "); }
			copy(row, "Copy ID", () => it.id);
			copy(row, "Copy MCP call", () => mcpCall("work_board", { profile: it.profile, as_of: it.as_of }));
			copy(row, "Copy owner curl", () => curl("GET", `/api/profiles/${enc(it.profile)}/board?state=all&limit=200&as_of=${enc(it.as_of)}`));
			if (moveFocus) detail.focus();
		};
		const draw = () => {
			body.replaceChildren();
			const shown = items.filter(matches);
			for (const it of shown) {
				const tr = el("tr", body);
				if (`${it.profile}/${it.id}` === selected) tr.setAttribute("aria-selected", "true");
				const t = el("td", tr), open = el("button", t, it.name || "(no title)");
				open.setAttribute("type", "button");
				open.setAttribute("class", "linklike");
				open.setAttribute("data-item", "");
				open.addEventListener("click", () => { show(it, true); draw(); });
				if (it.key) el("div", t, it.key).setAttribute("class", "na");
				const p = el("td", tr);
				el("span", p, recorded(project(it)));
				if (!one) el("span", p, it.profile).setAttribute("class", "chip chip-profile");
				const tags = el("td", tr);
				el("span", tags, it.kind.toUpperCase()).setAttribute("class", "chip");
				if (it.priority) el("span", tags, it.priority).setAttribute("class", "chip");
				if (it.due) el("span", tags, `due ${it.due}`).setAttribute("class", "chip");
				if (it.state === "open" && it.blocked_by.length) el("span", tags, "BLOCKED").setAttribute("class", "chip chip-blocked");
				if (it.state === "open" && it.stale) el("span", tags, "STALE").setAttribute("class", "chip chip-stale");
				const s = el("td", tr);
				el("span", s, stateLabel(it)).setAttribute("class", `chip chip-${it.state === "open" || it.state === "closed" ? it.state : "none"}`);
				if (it.status) el("div", s, it.status);
				el("td", tr, String(it.score));
				el("td", tr, day(it.last_activity_at || null));
			}
			table.hidden = !items.length;
			say([failed.length ? `Could not load ${failed.join("; ")}.` : "",
				items.length ? `Showing ${shown.length} of ${items.length} item${items.length === 1 ? "" : "s"}.` : ""].filter(Boolean).join(" "));
		};
		const load = async () => {
			const results = await am.eachProfile(one, async (p) => {
				const b = await call(`/api/profiles/${enc(p.name)}/board?state=all&limit=200`);
				if (!Array.isArray(b?.items) || typeof b.as_of !== "string" || !b.as_of) throw new Error("the server sent no board");
				return b as J;
			});
			for (const r of results) {
				if (!r.ok) { failed.push(`${r.profile}: ${why(r.error)}`); continue; }
				const b = r.value, p = { name: r.profile };
				boards.push({ profile: p.name, as_of: b.as_of, total: typeof b.total === "number" ? b.total : null, truncated: b.truncated === true,
					without_state: typeof b.without_state === "number" ? b.without_state : null, partial: b.budget?.exhausted === true,
					skipped: typeof b.budget?.skipped === "number" ? b.budget.skipped : 0 });
				for (const it of b.items as J[]) items.push({ profile: p.name, as_of: b.as_of, id: String(it.id), kind: str(it.kind), key: str(it.key) || null,
					name: str(it.name), scope: str(it.scope), priority: str(it.priority) || null, due: str(it.due) || null, score: typeof it.score === "number" ? it.score : 0,
					reasons: (Array.isArray(it.reasons) ? it.reasons : []).map((r: J) => ({ term: str(r?.term), points: typeof r?.points === "number" ? r.points : 0, text: str(r?.text) })),
					stale: it.stale === true, last_activity_at: str(it.last_activity_at), blocked_by: Array.isArray(it.blocked_by) ? it.blocked_by : [],
					blocks: Array.isArray(it.blocks) ? it.blocks : [], unrecognized: Array.isArray(it.unrecognized) ? it.unrecognized.map(String) : [],
					state: str(it.state) || null, status: str(it.status) || null });
			}
			if (version !== am.pageVersion) return;
			wait.replaceChildren();
			wait.hidden = true;
			items.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
			for (const b of boards.sort((x, y) => x.profile.localeCompare(y.profile))) {
				note(notes, [`${b.profile}: as of ${b.as_of}, ${b.total ?? "an unknown number of"} items evaluated.`,
					b.truncated ? "The 200-item limit hides some." : "",
					b.partial ? `The read stopped early${b.skipped ? ` and skipped ${b.skipped} items` : ""}, so scores and order may change.` : "",
					b.without_state ? `${b.without_state} uploaded items have no recognized open or closed state.` : ""].filter(Boolean).join(" "));
			}
			const notOpen = items.filter((it) => it.state !== "open").length;
			if (notOpen) { differs.hidden = false; differs.textContent = `work_board lists open items only, so its answer leaves out ${notOpen} of the items shown here.`; }
			draw();
			const pick = items.find((x) => `${x.profile}/${x.id}` === selected);
			if (pick) show(pick, false);
			if (!items.length && !failed.length) empty(root, "No work items yet. They appear after your machines upload their PRs and Jira tickets.");
			if (selected && !pick && !failed.length) note(root, `No work item with ID ${route.id} in ${one} in this read.`);
		};
		q.addEventListener("input", () => { filters.q = q.value.trim(); draw(); });
		status.addEventListener("change", () => { filters.status = status.value; draw(); });
		load();
		return h;
	} });
}
