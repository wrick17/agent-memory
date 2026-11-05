// Memories: the Memories tab (#memories and #memories/ID; ?profile=P reads only P, no ?profile reads every active profile, and
// an optional ?q= searches) with its table, filters,
// strength, and a detail panel with versions, a word diff, provenance, edit, copy, forget with Undo, bulk forget and JSON export.
// Today's #/memories list and #/memory record pages stay below, unchanged, under their old routes.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node, Profile, Route } from "./am";

export function memoriesTab(am: Am): void {
	const { act, btn, call, choose, day, el, enc, facts, input, link, note, pageStatus, recorded, switcher, textBlock, undoOf, why, win } = am;
	// Memories: the profile's records in stored order (empty search) or ranked by a search, through the recall tool's own read.
	const memoriesPage = (view: Node, p: Profile) => {
		const version = am.pageVersion, h = el("h2", view, `Memories: ${p.name}`);
		switcher(view, "memories", p.name);
		const form = el("form", view);
		const q = input(form, "mem-q", "Search (blank lists every record in stored order)");
		q.setAttribute("type", "search");
		const type = choose(form, "mem-type", "Type", [["all", "All types"], ["feedback", "Feedback"], ["project", "Project"], ["reference", "Reference"], ["user", "User"], ["procedural", "Procedural"]]);
		el("button", el("p", form), "Search").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Memories");
		const more = btn(view, "Load more", () => load(true));
		more.hidden = true;
		let cursor: string | null = null, shown = 0, request = 0;
		const load = async (next = false) => {
			const id = ++request, keyword = q.value.trim();
			if (!next) { list.replaceChildren(); shown = 0; cursor = null; }
			more.hidden = true;
			say(keyword ? "Searching…" : "Loading memories…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/recall`, "POST", { limit: 25, ...(keyword ? { keyword } : {}), ...(type.value !== "all" ? { type: type.value } : {}), ...(next && cursor ? { cursor } : {}) });
				if (!Array.isArray(r?.results)) throw new Error("the server sent no result list");
			} catch (err) {
				if (version === am.pageVersion && id === request) { say(`Could not load memories: ${why(err)}`); more.textContent = "Try again"; more.hidden = !next; }
				return;
			}
			if (version !== am.pageVersion || id !== request) return;
			for (const it of r.results) {
				const li = el("li", list);
				link(el("h3", li), `#/memory/${enc(String(it.profile))}/${enc(String(it.memory_id))}`, String(it.name ?? "(no name)"));
				facts(li, [["Type", recorded(it.type ?? it.kind)], ["Scope", recorded(it.scope)], ["Profile", recorded(it.profile)], ["Status", recorded(it.status)], ["Updated", day(it.freshness?.updated_at ?? null)]]);
				if (it.passage) el("p", li, String(it.passage));
			}
			shown += r.results.length;
			cursor = typeof r.next_cursor === "string" ? r.next_cursor : null;
			more.textContent = "Load more";
			more.hidden = !cursor;
			const limits = [keyword && r.truncated ? "More matches exist than shown; narrow the search." : "", keyword && r.lexical_only ? "Matched by words only; related wording may be missed." : ""].filter(Boolean).join(" ");
			say(`${shown ? `Showing ${shown} record${shown === 1 ? "" : "s"}${cursor ? "; more are available" : ""}.` : keyword ? "No records match." : "No records in this profile yet."} ${limits}`.trim());
			if (next && more.hidden) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();
		return h;
	};

	// One record: fields, text, evidence, links and revision history from the entity read; pin, forget and edit as a draft.
	const memoryPage = (view: Node, p: Profile, id: string) => {
		const version = am.pageVersion, base = `/api/profiles/${enc(p.name)}/nodes/${enc(id)}`;
		const h = el("h2", view, "Memory");
		link(el("p", view), `#/memories/${enc(p.name)}`, `Back to memories in ${p.name}`);
		const { say } = pageStatus(view);
		const body = el("div", view);
		say("Loading…");
		(async () => {
			let r: J;
			try {
				r = await call(base);
				if (!r?.node) throw new Error("the server sent no record");
			} catch (err) {
				if (version === am.pageVersion) say(`Could not load this record: ${why(err)}`);
				return;
			}
			if (version !== am.pageVersion) return;
			const n = r.node, name = String(n.name ?? "(no name)"), cut: string[] = Array.isArray(n.truncated) ? n.truncated : [];
			h.textContent = `Memory: ${name}`;
			say("");
			facts(body, [["Id", id], ["Kind", recorded(n.kind)], ["Type", recorded(n.memory_type)], ["Scope", recorded(n.scope)], ["Status", recorded(n.status)], ["Origin", recorded(n.origin)],
				["Revision", recorded(n.revision)], ["Created", recorded(n.created_at)], ["Updated", recorded(n.updated_at)], ["Pinned", n.pinned ? "yes" : "no"],
				["Flagged", n.flagged ? String(n.flagged) : "no"], ["Source profile", n.source_profile ? String(n.source_profile) : "this profile"]]);
			if (n.description) { el("h3", body, "Description"); textBlock(body, String(n.description)); if (cut.includes("description")) note(body, "The description is longer than shown."); }
			el("h3", body, "Content");
			const content = el("div", body);
			const c = r.content ?? {};
			if (c.text === null || c.text === undefined || c.text === "") note(content, "No content.");
			else textBlock(content, String(c.text));
			if (!c.complete && c.text) {
				note(body, `Showing the first ${String(c.text).length} of ${recorded(c.chars)} characters.`);
				let next: string | null = null;
				const full = btn(body, "Load the full content", async () => {
					full.disabled = true;
					try {
						const page: J = await call(`${base}?content=all${next ? `&cursor=${enc(next)}` : ""}`);
						if (version !== am.pageVersion) return;
						if (!next) content.replaceChildren();
						textBlock(content, String(page.content?.content ?? ""));
						next = typeof page.content?.cursor === "string" ? page.content.cursor : null;
						full.textContent = "Load the next part";
						full.hidden = !next;
					} catch (err) { if (version === am.pageVersion) say(`Could not load the content: ${why(err)}`); }
					full.disabled = false;
				});
			}
			const row = el("p", body), nodePath = (verb: string) => `${base}/${verb}`;
			const ownerDone = (r: J, extra = "") => ({ text: `Done: ${String(r.action)} “${name}”.${extra}`, undo: undoOf(p.name, r) });
			btn(row, n.pinned ? "Unpin" : "Pin", () => act(nodePath(n.pinned ? "unpin" : "pin"), `${n.pinned ? "unpin" : "pin"} “${name}”`, undefined, (r) => ownerDone(r)));
			const forget = btn(row, "Forget", () => {
				forget.hidden = true;
				const ask = el("span", row, `Forget “${name}”? It moves to the archive; Undo or the archive brings it back. `);
				ask.setAttribute("tabindex", "-1");
				btn(row, "Forget it", () => act(nodePath("forget"), `forget “${name}”`, undefined, (r) => ownerDone(r, " It is in the archive.")));
				ask.focus();
			});
			const editable = n.memory_type && n.memory_type !== "procedural" && n.kind !== "journal" && n.status === "active" && c.complete !== false && !cut.includes("description");
			if (editable) btn(row, "Edit as a draft", () => {
				am.drafts.set(p.name, { memory_id: id, expected_revision: Number(n.revision), name, recordName: name, type: String(n.memory_type), scope: n.scope ? String(n.scope) : "",
					description: String(n.description ?? ""), content: String(c.text ?? ""), target: "", targetName: "", reason: "" });
				win.location.hash = `#/draft/${enc(p.name)}`;
			});
			else note(body, "Editing here needs an active, non-procedural, non-journal memory with its whole text shown.");
			link(el("p", body), `#/map/${enc(p.name)}/${enc(id)}`, "Center the map here");
			link(el("p", body), `#/path/${enc(p.name)}/${enc(id)}`, "Find a path from here");
			link(el("p", body), `#/move/${enc(p.name)}/${enc(id)}`, "Move to another profile");
			link(el("p", body), `#/copy/${enc(p.name)}/${enc(id)}`, "Save a copy in another profile");
			link(el("p", body), `#/timeline/${enc(p.name)}/${enc(id)}`, "Timeline of this record");
			if (n.kind === "journal") link(el("p", body), `#/journals/${enc(p.name)}/${enc(id)}`, "Read as a journal");
			el("h3", body, "Evidence");
			const ev: J[] = r.evidence?.items ?? [];
			if (ev.length) { const ul = el("ul", body); for (const e of ev) el("li", ul, `${String(e.kind)}: ${String(e.ref)}${e.note ? ` (${String(e.note)})` : ""}`); } else note(body, "No evidence pointers.");
			if (r.evidence?.truncated) note(body, "More evidence exists than shown.");
			el("h3", body, "Links");
			const links: J[] = Array.isArray(r.links) ? r.links : [];
			if (links.length) {
				const ul = el("ul", body);
				for (const l of links) {
					const li = el("li", ul), o = l.other ?? {}, rel = `${String(l.rel)}${l.other_label ? ` (${String(l.other_label)})` : ""}`;
					el("span", li, `${l.direction === "in" ? "From" : "To"} `);
					if (o.readable) link(li, `#/memory/${enc(p.name)}/${enc(String(o.id))}`, `${String(o.kind)}: ${String(o.name)}`);
					else el("span", li, "a record not readable in this profile");
					el("span", li, ` — ${rel}${l.reason ? `: ${String(l.reason)}` : ""}`);
				}
			} else note(body, "No links.");
			if (r.budget?.exhausted) note(body, "Some links could not be read within this read's budget.");
			el("h3", body, "Revision history");
			const table = el("table", body), head = el("tr", el("thead", table)), rows = el("tbody", table);
			for (const t of ["Revision", "Change", "When", "By"]) el("th", head, t).setAttribute("scope", "col");
			const addRows = (items: J[]) => { for (const v of items) { const tr = el("tr", rows); [v.revision, v.op, v.at, v.actor].forEach((x) => el("td", tr, recorded(x))); } };
			addRows(r.history?.items ?? []);
			let before: number | null = r.history?.next_before ?? null;
			const older = btn(body, "Older revisions", async () => {
				older.disabled = true;
				try {
					const page: J = await call(`${base}?before=${before}`);
					if (version !== am.pageVersion) return;
					addRows(page.history?.items ?? []);
					before = page.history?.next_before ?? null;
				} catch (err) { if (version === am.pageVersion) say(`Could not load older revisions: ${why(err)}`); }
				older.disabled = false;
				older.hidden = before === null;
			});
			older.hidden = before === null;
			note(body, "History lists each stored change; earlier full texts are kept by the server but not shown here.");
		})();
		return h;
	};
	// ---- The v2 tab ----------------------------------------------------------------------------------------------------
	const PAGE = 25, BULK_MAX = 50, TEXT_CAP = 200_000, DIFF_CELLS = 2_000_000, STEPS = 100;
	const UNSET = "\u0000"; // the agent filter's value for rows that record no client
	const chip = (parent: Node, text: string, kind: string) => el("span", parent, text).setAttribute("class", `chip chip-${kind}`);
	const excerpt = (t: string) => (t.length > 160 ? `${t.slice(0, 160).trimEnd()}…` : t);
	const memoryHash = (p: string, id: string) => `#memories/${enc(id)}?profile=${enc(p)}`;
	const deviceName = (id: unknown) => (id ? String(am.devices.find((d) => (d as J).id === id)?.name ?? id) : null);

	// Word diff: tokens are words, runs of white space and single other characters. Common ends are trimmed, then an LCS table
	// over the middle gives the edit. shortcut: a middle larger than DIFF_CELLS cells shows as one removal and one addition;
	// switch to Myers' O(ND) diff if long, heavily edited records make that common.
	type Op = ["=" | "-" | "+", string];
	const tokens = (s: string): string[] => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	const wordDiff = (a: string, b: string): { ops: Op[]; coarse: boolean } => {
		const x = tokens(a), y = tokens(b), ops: Op[] = [];
		const push = (op: Op[0], t: string) => { const last = ops[ops.length - 1]; if (!t) return; if (last && last[0] === op) last[1] += t; else ops.push([op, t]); };
		let s = 0, ex = x.length, ey = y.length;
		while (s < ex && s < ey && x[s] === y[s]) s++;
		while (ex > s && ey > s && x[ex - 1] === y[ey - 1]) { ex--; ey--; }
		push("=", x.slice(0, s).join(""));
		const n = ex - s, m = ey - s, coarse = n * m > DIFF_CELLS;
		if (coarse) { push("-", x.slice(s, ex).join("")); push("+", y.slice(s, ey).join("")); }
		else {
			// L[i * w + j]: the longest common run of x[s + i..ex) and y[s + j..ey).
			const w = m + 1, L = new Uint32Array((n + 1) * w);
			for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = x[s + i] === y[s + j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
			let i = 0, j = 0;
			while (i < n || j < m) {
				if (i < n && j < m && x[s + i] === y[s + j]) { push("=", x[s + i]!); i++; j++; }
				else if (i < n && (j === m || L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) { push("-", x[s + i]!); i++; }
				else { push("+", y[s + j]!); j++; }
			}
		}
		push("=", x.slice(ex).join(""));
		return { ops, coarse };
	};
	const words = (t: string) => (t.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
	const showDiff = (parent: Node, label: string, a: string, b: string) => {
		const { ops, coarse } = wordDiff(a, b);
		const removed = ops.reduce((k, [op, t]) => k + (op === "-" ? words(t) : 0), 0), added = ops.reduce((k, [op, t]) => k + (op === "+" ? words(t) : 0), 0);
		el("h5", parent, `${label}: ${removed} word${removed === 1 ? "" : "s"} removed, ${added} added`);
		const box = el("div", parent);
		box.setAttribute("class", "text diff");
		for (const [op, t] of ops) {
			if (op === "=") { el("span", box, t); continue; }
			const mark = el(op === "-" ? "del" : "ins", box);
			el("span", mark, op === "-" ? " [removed: " : " [added: ").setAttribute("class", "vh");
			el("span", mark, t);
			el("span", mark, "] ").setAttribute("class", "vh");
		}
		if (coarse) note(parent, "Too much changed for a word-by-word comparison; the changed span is shown as one removal and one addition.");
	};

	type Row = { key: string; p: string; it: J; tr: Node; box: Node; title: Node; ver: Node; agent: string; strength: Node };
	type Target = { p: string; id: string; name: string; revision: number };

	const memoriesView = (root: Node, route: Route): Node => {
		// The link's ?profile=P is the only choice (the shell refuses an unknown or inactive one before this runs); no ?profile
		// means All profiles. A record and every write always name the profile of the row or link they came from.
		const version = am.pageVersion, only = route.query.profile ?? null, search = route.query.q ?? "";
		let openRec: { p: string | null; id: string } | null = route.id === undefined ? null : { p: only, id: route.id };
		/** The address for what is on screen: the list keeps the link's own choice; an open record names its profile. */
		const addr = (query: string) => {
			const name = openRec ? openRec.p : only, qs = [name !== null ? `profile=${enc(name)}` : "", query ? `q=${enc(query)}` : ""].filter(Boolean).join("&");
			return `#memories${openRec ? `/${enc(openRec.id)}` : ""}${qs ? `?${qs}` : ""}`;
		};
		const h = el("h2", root, only === null ? "Memories: all profiles" : `Memories: ${only}`);
		am.help(h, "profile_choice");
		am.intro(root, "Memories", "memories", "what your agents saved. Search by meaning or keyword, open a record to see its versions and where it came from, then edit or forget it.");
		const onPage = () => version === am.pageVersion;

		// Search and filters. Type and project filter on the server; agent filters the rows already loaded.
		const form = el("form", root);
		form.setAttribute("role", "search");
		const q = input(form, "mem-q", "Search memories (blank lists every record in stored order)");
		q.setAttribute("type", "search");
		q.value = search;
		const mode = choose(form, "mem-mode", "Match by", [["both", "Meaning and keywords"], ["lexical", "Keywords only"], ["vector", "Meaning only"]]);
		const project = choose(form, "mem-project", "Project", [["", "All projects"]]);
		const agent = choose(form, "mem-agent", "Agent", [["", "All agents"]]);
		const type = choose(form, "mem-type", "Type", [["all", "All types"], ["feedback", "Feedback"], ["project", "Project"], ["reference", "Reference"], ["user", "User"], ["procedural", "Procedural"]]);
		el("button", el("p", form), "Search").setAttribute("type", "submit");
		const msg = am.live(root);
		const errorsBox = el("div", root); // one line per profile whose read failed; such a profile is never shown as empty
		const outcome = el("div", root);
		outcome.setAttribute("aria-live", "polite");

		// Bulk actions on the checked rows.
		const bulk = el("div", root);
		bulk.setAttribute("class", "bulk");
		const count = el("span", bulk, "0 selected. ");
		const bulkForget = btn(bulk, "Forget selected…", () => askBulk());
		const exportRows = btn(bulk, "Export JSON", () => exportList());
		const confirmBox = el("div", bulk);

		const split = el("div", root);
		split.setAttribute("class", "mem-split");
		const listBox = el("div", split);
		const panel = el("aside", split);
		panel.setAttribute("class", "mem-detail");
		panel.setAttribute("aria-label", "Memory detail");
		panel.hidden = true;

		const tableBox = el("div", listBox); // nine columns: below that width the table scrolls in its box, not the page
		tableBox.setAttribute("class", "tablewrap");
		const table = el("table", tableBox);
		el("caption", table, "Memories").setAttribute("class", "vh");
		const head = el("tr", el("thead", table));
		const all = el("input", el("th", head));
		all.setAttribute("type", "checkbox");
		all.setAttribute("aria-label", "Select every shown row");
		for (const t of ["Title", "Project", "Agent", "Version", "Concepts", "Type", "Strength", "Updated"]) {
			const th = el("th", head, t);
			th.setAttribute("scope", "col");
			if (t === "Strength") am.help(th, "strength");
		}
		const tbody = el("tbody", table), emptyBox = el("div", listBox);
		tbody.setAttribute("data-list", ""); // the shell's arrow keys move between the rows' titles
		const more = btn(listBox, "Load more", () => load(true));
		more.hidden = true;

		const rows = new Map<string, Row>(), selected = new Set<string>(), cursors = new Map<string, string | null>(), failures = new Map<string, string>(), scopes = new Set<string>(), agents = new Set<string>();
		let request = 0, busy = false;
		const writes: Node[] = [bulkForget];
		const shown = () => [...rows.values()].filter((r) => !r.tr.hidden);
		const setBusy = (b: boolean) => { busy = b; for (const w of writes) w.disabled = b; if (!b) refreshBulk(); };
		const say = (t: string) => { msg.textContent = t; };
		/** The owner changed the selection: an open bulk confirmation lists the old one, so it closes. */
		const reselect = () => { confirmBox.replaceChildren(); refreshBulk(); };
		const refreshBulk = () => {
			for (const k of selected) if (!rows.has(k)) selected.delete(k);
			count.textContent = `${selected.size} selected. `;
			bulkForget.disabled = busy || !selected.size;
			exportRows.textContent = selected.size ? `Export ${selected.size} as JSON` : "Export shown rows as JSON";
			const vis = shown();
			all.checked = vis.length > 0 && vis.every((r) => selected.has(r.key));
		};
		const fill = (sel: Node, values: Set<string>, first: string) => {
			const keep = sel.value;
			sel.replaceChildren();
			el("option", sel, first).setAttribute("value", "");
			for (const v of [...values].sort()) el("option", sel, v === UNSET ? "Not recorded" : v).setAttribute("value", v);
			sel.value = values.has(keep) ? keep : "";
		};
		const applyAgent = () => {
			for (const r of rows.values()) r.tr.hidden = agent.value !== "" && r.agent !== agent.value;
			refreshBulk();
		};

		const paintStrength = (cell: Node, s: J, failed: boolean) => {
			cell.replaceChildren();
			if (!s) { el("span", cell, failed ? "Not loaded" : "Not recorded").setAttribute("class", "na"); return; }
			const meter = el("meter", cell);
			meter.setAttribute("min", "0");
			meter.setAttribute("max", "10");
			meter.setAttribute("value", String(s.strength));
			meter.setAttribute("aria-label", `Strength ${s.strength} of 10: ${s.hits_90d} recall${s.hits_90d === 1 ? "" : "s"} in the last 90 days`);
			el("span", cell, ` ${s.strength}/10`);
		};
		/** Strength is the server's own count: recall hits in the last 90 days, capped at 10. One request per profile, at most 100 ids. */
		const strengths = (batch: { p: string; id: string; cell: Node }[]) => {
			const by = new Map<string, { id: string; cell: Node }[]>();
			for (const b of batch) (by.get(b.p) ?? by.set(b.p, []).get(b.p)!).push(b);
			for (const [p, list] of by) for (let i = 0; i < list.length; i += 100) {
				const part = list.slice(i, i + 100);
				call(`/api/profiles/${enc(p)}/recall-strength?ids=${part.map((b) => enc(b.id)).join(",")}`).then((r: J) => {
					if (version === am.pageVersion) for (const b of part) paintStrength(b.cell, r?.strength?.[b.id], !r?.strength);
				}, () => { if (version === am.pageVersion) for (const b of part) paintStrength(b.cell, null, true); });
			}
		};

		const makeRow = (p: string, it: J): Row => {
			const id = String(it.memory_id), key = `${p}/${id}`, name = String(it.name ?? "(no name)"), tr = el("tr");
			const box = el("input", el("td", tr));
			box.setAttribute("type", "checkbox");
			box.setAttribute("aria-label", `Select ${name}`);
			box.addEventListener("change", () => { if (box.checked) selected.add(key); else selected.delete(key); reselect(); });
			const t = el("td", tr), title = el("a", t, name);
			t.setAttribute("class", "mem-title");
			title.setAttribute("href", memoryHash(p, id));
			title.setAttribute("data-item", "");
			title.addEventListener("click", (e: J) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); open(p, id); });
			if (it.passage) el("div", t, excerpt(String(it.passage))).setAttribute("class", "excerpt");
			const proj = el("td", tr);
			if (it.scope) chip(proj, String(it.scope), "project"); else el("span", proj, "None").setAttribute("class", "na");
			// The list reply names the client that wrote the record; the device is in the record's history, shown in the detail panel.
			const client = it.provenance?.source_platform ?? it.provenance?.updated_source_platform, agentCell = el("td", tr);
			if (client) chip(agentCell, String(client), "agent"); else el("span", agentCell, "Not recorded").setAttribute("class", "na");
			const verCell = el("td", tr), ver = el("span", verCell, `v${recorded(it.revision)}`);
			ver.setAttribute("class", "chip chip-version");
			chip(verCell, p, "profile"); // the row's own profile: every write and link from this row uses it
			el("span", el("td", tr), "In detail").setAttribute("class", "na");
			chip(el("td", tr), String(it.type ?? it.kind ?? "record"), String(it.type ?? it.kind ?? "record"));
			const strengthCell = el("td", tr);
			el("span", strengthCell, "…").setAttribute("aria-label", "Strength loading");
			el("td", tr, day(it.freshness?.updated_at ?? null));
			if (it.scope) scopes.add(String(it.scope));
			const agentKey = client ? String(client) : UNSET;
			agents.add(agentKey);
			return { key, p, it, tr, box, title, ver, agent: agentKey, strength: strengthCell };
		};

		const load = async (next = false) => {
			const id = ++request, keyword = q.value.trim();
			// New rows are built unchecked, so a replacement drops the old selection and any open confirmation of it.
			if (!next) { tbody.replaceChildren(); rows.clear(); selected.clear(); confirmBox.replaceChildren(); cursors.clear(); failures.clear(); refreshBulk(); am.win.history.replaceState(null, "", addr(keyword)); }
			more.hidden = true;
			say(keyword ? "Searching…" : "Loading memories…");
			const skeleton = next ? null : am.loading(listBox, 5);
			const body = (p: Profile) => ({ limit: PAGE, count_hits: false, ...(keyword ? { keyword, ...(mode.value !== "both" ? { channels: [mode.value] } : {}) } : {}),
				...(type.value !== "all" ? { type: type.value } : {}), ...(project.value ? { scope: project.value } : {}), ...(next ? { cursor: cursors.get(p.name) } : {}) });
			// One read per profile (or only the chosen one), each with its own cursor; a profile with no next page is not read again.
			const got = await am.eachProfile(only, async (p): Promise<J> => {
				if (next && !cursors.get(p.name)) return null;
				const r: J = await call(`/api/profiles/${enc(p.name)}/recall`, "POST", body(p));
				if (!Array.isArray(r?.results)) throw new Error("the server sent no result list");
				return r;
			});
			if (!onPage() || id !== request) return;
			(skeleton as J)?.remove();
			emptyBox.replaceChildren();
			const limits = new Set<string>(), batch: Row[] = [];
			for (const g of got) {
				// A failed page keeps the profile's cursor, so Load more retries it.
				if (!g.ok) { failures.set(g.profile, why(g.error)); continue; }
				if (g.value === null) continue;
				failures.delete(g.profile);
				const r: J = g.value;
				// Owner recall adds the authorized me overlay to a named profile; keep only this profile's own hits, so none is
				// relabelled or listed twice. The inventory pages profile by profile, so another profile's hit means this one is done.
				const own = r.results.filter((it: J) => (it?.profile ?? g.profile) === g.profile);
				cursors.set(g.profile, own.length === r.results.length && typeof r.next_cursor === "string" ? r.next_cursor : null);
				if (keyword && r.truncated) limits.add("More matches exist than shown; narrow the search.");
				if (keyword && r.lexical_only && mode.value !== "lexical") limits.add("Matched by words only; related wording may be missed.");
				for (const it of own) { const row = makeRow(g.profile, it); if (!rows.has(row.key)) batch.push(row); }
			}
			errorsBox.replaceChildren();
			for (const [name, reason] of failures) note(errorsBox, `Could not read ${name}: ${reason}. Its records are not shown, and this is not a count of zero. Search again to retry.`, "warn");
			if (keyword) batch.sort((a, b) => Number(b.it.score ?? 0) - Number(a.it.score ?? 0));
			for (const r of batch) { rows.set(r.key, r); tbody.appendChild(r.tr); }
			strengths(batch.map((r) => ({ p: r.p, id: String(r.it.memory_id), cell: r.strength })));
			fill(project, scopes, "All projects");
			fill(agent, agents, "All agents");
			applyAgent();
			more.hidden = ![...cursors.values()].some(Boolean);
			const n = rows.size, vis = shown().length, per = new Map<string, number>();
			for (const r of rows.values()) per.set(r.p, (per.get(r.p) ?? 0) + 1);
			const from = [...per].map(([name, k]) => `${name} ${k}`).join(", ");
			say([n ? `Showing ${vis === n ? n : `${vis} of ${n}`} record${n === 1 ? "" : "s"}${only === null ? ` (${from})` : ""}${more.hidden ? "" : "; more are available"}.` : "",
				failures.size ? `Could not read ${[...failures.keys()].join(", ")}.` : "", !got.length ? "No active profiles." : "", ...limits].filter(Boolean).join(" "));
			if (!n && !failures.size && got.length) {
				if (keyword || type.value !== "all" || project.value) say("No records match.");
				else am.empty(emptyBox, "No memories yet. Agents save them with save_memory, and the batch saves them from session digests.", "agent-memory run");
			}
			if (next && more.hidden) msg.focus();
		};
		form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
		for (const s of [type, project]) s.addEventListener("change", () => load());
		mode.addEventListener("change", () => { if (q.value.trim()) load(); });
		// The filter can hide selected rows, so it starts over like a new search: nothing selected or checked, no open confirmation.
		agent.addEventListener("change", () => { for (const r of rows.values()) r.box.checked = false; selected.clear(); confirmBox.replaceChildren(); applyAgent(); });
		all.addEventListener("change", () => { for (const r of shown()) { r.box.checked = all.checked; if (all.checked) selected.add(r.key); else selected.delete(r.key); } reselect(); });

		// ---- Writes: forget (single and bulk), with Undo through each removal's activity row ----
		const forgetOne = async (x: Target): Promise<{ undo?: string; staged?: boolean }> => {
			const base = `/api/profiles/${enc(x.p)}`;
			try { return { undo: undoOf(x.p, await call(`${base}/nodes/${enc(x.id)}/forget`, "POST")) }; }
			catch (err) {
				if ((err as Failure).code !== "size_budget" || !Number.isSafeInteger(x.revision)) throw err;
				// Too large for one write: the staged archive route forgets it in steps, bound to the revision shown.
				let r: J = await call(`${base}/archive/operations`, "POST", { action: "forget", memory_id: x.id, expected_revision: x.revision, request_id: `dashboard:${crypto.randomUUID()}` });
				for (let i = 0; (r.state === "running" || r.state === "rolling_back") && i < STEPS; i++)
					r = await call(`${base}/archive/operations/${enc(String(r.operation_id))}/resume`, "POST", { cursor: String(r.cursor), request_id: `dashboard:${crypto.randomUUID()}` });
				if (r.state !== "complete") throw new Error(`the staged forget stopped while ${recorded(r.state)} after ${recorded(r.rows_done)} rows; try again to continue`);
				return { staged: true };
			}
		};
		const report = (text: string, undos: { p: string; path: string }[]) => {
			outcome.replaceChildren();
			const line = el("p", outcome, text);
			line.setAttribute("tabindex", "-1");
			if (undos.length) {
				const undo = btn(outcome, undos.length === 1 ? "Undo" : `Undo all ${undos.length}`, async () => {
					if (busy) return;
					setBusy(true);
					const failed: string[] = [];
					// Newest first, so each removal comes back in the reverse of the order it went.
					for (const u of [...undos].reverse()) { try { await call(u.path, "POST"); } catch (err) { failed.push(why(err)); } }
					setBusy(false);
					if (!onPage()) return;
					report(failed.length ? `Undid ${undos.length - failed.length} of ${undos.length}. Could not undo: ${failed.join("; ")}. The archive in the Audit tab can restore the rest.` : "Undone. The records are back.", []);
					load();
				});
				writes.push(undo);
			}
			line.focus();
		};
		const forgetMany = async (list: Target[]) => {
			if (busy || !list.length) return;
			setBusy(true);
			const undos: { p: string; path: string }[] = [], failed: string[] = [], staged: string[] = [];
			let done = 0;
			for (const x of list) {
				say(`Forgetting ${done + failed.length + 1} of ${list.length}…`);
				try {
					const r = await forgetOne(x);
					done++;
					if (r.undo) undos.push({ p: x.p, path: r.undo });
					if (r.staged) staged.push(x.name);
					const row = rows.get(`${x.p}/${x.id}`);
					if (row) { (row.tr as J).remove(); rows.delete(row.key); selected.delete(row.key); }
					if (openKey === `${x.p}/${x.id}`) close(false);
				} catch (err) { failed.push(`"${x.name}": ${why(err)}`); }
			}
			setBusy(false);
			if (!onPage()) return;
			confirmBox.replaceChildren();
			refreshBulk();
			say("");
			report([done ? `Forgot ${done === 1 && list.length === 1 ? `"${list[0]!.name}"` : `${done} record${done === 1 ? "" : "s"}`}. ${done === 1 ? "It is" : "They are"} in the archive.` : "",
				staged.length ? `Large records forgotten in steps (${staged.map((s) => `"${s}"`).join(", ")}) come back only through Restore in the Audit tab's archive.` : "",
				failed.length ? `Could not forget ${failed.join("; ")}.` : ""].filter(Boolean).join(" "), undos);
		};
		const askBulk = () => {
			const list = [...selected].map((k) => rows.get(k)).filter((r): r is Row => !!r);
			confirmBox.replaceChildren();
			if (!list.length) return;
			if (list.length > BULK_MAX) { el("p", confirmBox, `Forget at most ${BULK_MAX} records at a time; ${list.length} are selected.`).setAttribute("tabindex", "-1"); return; }
			const ask = el("p", confirmBox, `Forget ${list.length} record${list.length === 1 ? "" : "s"}? Each moves to the archive; Undo, or Restore in the Audit tab's archive, brings it back.`);
			ask.setAttribute("tabindex", "-1");
			writes.push(btn(confirmBox, `Forget ${list.length}`, () => forgetMany(list.map((r) => ({ p: r.p, id: String(r.it.memory_id), name: String(r.it.name ?? r.it.memory_id), revision: Number(r.it.revision) })))));
			btn(confirmBox, "Cancel", () => { confirmBox.replaceChildren(); bulkForget.focus(); });
			ask.focus();
		};
		const download = (file: string, data: unknown) => {
			const url = am.win.URL.createObjectURL(new am.win.Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
			const a = el("a", root) as J;
			a.href = url;
			a.download = file;
			a.hidden = true;
			a.click();
			a.remove();
			am.win.setTimeout(() => am.win.URL.revokeObjectURL(url), 10_000);
		};
		const exportList = () => {
			const list = selected.size ? [...selected].map((k) => rows.get(k)).filter((r): r is Row => !!r) : shown();
			download(`memories-${only ?? "all-profiles"}-${new Date().toISOString().slice(0, 10)}.json`, {
				exported_at: new Date().toISOString(), note: "Rows as listed: each passage is an excerpt. Open a record and export it for its full read.",
				search: { profile: only ?? "all profiles", keyword: q.value.trim(), type: type.value, project: project.value || null, agent: agent.value || null },
				rows: list.map((r) => ({ profile: r.p, ...r.it })),
			});
			say(`Exported ${list.length} row${list.length === 1 ? "" : "s"}.`);
		};

		// ---- The detail panel ----
		let panelRequest = 0, openKey: string | null = null;
		const close = (focus = true) => {
			panelRequest++;
			panel.replaceChildren();
			panel.hidden = true;
			const back = openKey ? rows.get(openKey) : undefined;
			if (back) (back.tr as J).removeAttribute("aria-current");
			openKey = null;
			openRec = null;
			am.win.history.replaceState(null, "", addr(q.value.trim()));
			if (focus) (back?.title ?? q).focus();
		};
		const open = (p: string, id: string) => { void detail(p, id); };

		const detail = async (p: string, id: string) => {
			const v = ++panelRequest, current = () => onPage() && v === panelRequest;
			openRec = { p, id };
			for (const r of rows.values()) (r.tr as J).removeAttribute("aria-current");
			panel.hidden = false;
			panel.replaceChildren();
			const top = el("div", panel);
			const h3 = el("h3", top, "Memory");
			h3.setAttribute("tabindex", "-1");
			btn(top, "Close", () => close(), "Close the memory panel").setAttribute("data-close", ""); // Esc clicks it (shell)
			const st = am.live(panel);
			st.textContent = "Loading…";
			h3.focus();
			// Only the named profile is read. A record it does not hold is not looked up elsewhere; the owner may open another profile.
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p)}/nodes/${enc(id)}`);
				if (!r?.node) throw new Error("the server sent no record");
			} catch (err) {
				if (!current()) return;
				st.textContent = `Could not load this record from ${p}: ${why(err)}`;
				const others = am.active().filter((x) => x.name !== p);
				if ((err as Failure).status === 404 && others.length) {
					const tryIn = el("p", panel, "Open the same id in another profile: ");
					for (const x of others) { link(tryIn, `#memories/${enc(id)}?profile=${enc(x.name)}`, x.name); el("span", tryIn, " "); }
				}
				return;
			}
			if (!current()) return;
			const pn = p, base = `/api/profiles/${enc(pn)}/nodes/${enc(id)}`, n = r.node, c = r.content ?? {}, key = `${pn}/${id}`;
			const name = String(n.name ?? "(no name)"), latest = Number(n.revision), cut: string[] = Array.isArray(n.truncated) ? n.truncated : [];
			openKey = key;
			const row = rows.get(key);
			if (row) row.tr.setAttribute("aria-current", "true");
			am.win.history.replaceState(null, "", addr(q.value.trim()));
			h3.textContent = name;
			st.textContent = "";
			const chips = el("p", panel);
			chip(chips, String(n.memory_type ?? n.kind ?? "record"), String(n.memory_type ?? n.kind ?? "record"));
			chip(chips, `v${latest} latest`, "version");
			chip(chips, String(n.status), n.status === "active" ? "ok" : "warn");
			if (n.pinned) chip(chips, "pinned", "info");

			// Actions. Copy text copies what is loaded; the full content loads on request.
			let text = c.text === null || c.text === undefined ? "" : String(c.text), complete = c.complete !== false;
			const actions = el("div", panel);
			actions.setAttribute("class", "actions");
			// Editing needs the whole text, so eligibility is checked again when "Load the full content" finishes.
			const kindOk = n.memory_type && n.memory_type !== "procedural" && n.kind !== "journal" && n.status === "active" && !cut.includes("description");
			const editable = () => kindOk && complete;
			const editBtn = btn(actions, "Edit", () => edit());
			const allowEdit = () => {
				if (!editable()) { editBtn.disabled = true; editBtn.setAttribute("title", "Editing needs an active, non-procedural, non-journal memory with its whole text shown."); return; }
				(editBtn as J).removeAttribute("title");
				writes.push(editBtn);
				editBtn.disabled = busy;
			};
			allowEdit();
			am.copy(actions, "Copy ID", () => id);
			am.copy(actions, "Copy MCP call", () => am.mcpCall("get_memory", { memory_id: id }));
			am.copy(actions, "Copy MCP curl", () => am.mcpCurl("get_memory", { memory_id: id }));
			am.copy(actions, "Copy curl", () => am.curl("GET", `/api/profiles/${enc(pn)}/nodes/${enc(id)}`));
			am.help(actions, "curl");
			const copyText = am.copy(actions, complete ? "Copy text" : "Copy shown text", () => text);
			const pin = btn(actions, n.pinned ? "Unpin" : "Pin", async () => {
				if (busy) return;
				setBusy(true);
				try { const res: J = await call(`${base}/${n.pinned ? "unpin" : "pin"}`, "POST"); if (current()) { report(`${n.pinned ? "Unpinned" : "Pinned"} "${name}".`, res?.activity_id ? [{ p: pn, path: undoOf(pn, res)! }] : []); } }
				catch (err) { if (current()) st.textContent = `Could not ${n.pinned ? "unpin" : "pin"}: ${why(err)}`; }
				setBusy(false);
				if (current()) void detail(pn, id);
			});
			const forget = btn(actions, "Forget…", () => {
				forget.hidden = true;
				const box = el("p", actions), ask = el("span", box, `Forget "${name}"? It moves to the archive; Undo, or Restore in the Audit tab's archive, brings it back. `);
				ask.setAttribute("tabindex", "-1");
				writes.push(btn(box, "Forget it", () => forgetMany([{ p: pn, id, name, revision: latest }])));
				btn(box, "Cancel", () => { (box as J).remove(); forget.hidden = false; forget.focus(); });
				ask.focus();
			});
			// The export carries the text loaded so far and whether that is all of it, in the record's own content shape.
			btn(actions, "Export JSON", () => download(`memory-${id}.json`, { exported_at: new Date().toISOString(), profile: pn, strength, record: text === String(c.text ?? "") ? r : { ...r, content: { ...c, text, complete } } }));
			writes.push(pin, forget);
			if (busy) setBusy(true);

			// Details. Absent metadata says so; nothing is inferred.
			const links: J[] = Array.isArray(r.links) ? r.links : [];
			const linked = (pred: (o: J) => boolean) => links.filter((l) => l.other?.readable && pred(l.other)).map((l) => String(l.other.name));
			const projects = linked((o) => o.kind === "project"), concepts = linked((o) => !["project", "person", "session", "journal"].includes(String(o.kind)));
			const ev: J[] = r.evidence?.items ?? [], refs = (k: string) => ev.filter((e) => e.kind === k);
			const history: J[] = [...(r.history?.items ?? [])];
			const lastDevice = deviceName(history[0]?.device_id);
			const made = n.source_platform ? String(n.source_platform) : "", changed = n.updated_source_platform ? String(n.updated_source_platform) : "";
			el("h4", panel, "Details");
			const strengthRow: [string, string] = ["Strength", "Loading…"];
			const factsBox = el("div", panel);
			let strength: J = null;
			const paintFacts = () => {
				factsBox.replaceChildren();
				facts(factsBox, [["Id", id], ["Profile", pn],
					["Project", [n.scope ? `scope ${String(n.scope)}` : "", ...projects].filter(Boolean).join(", ") || "None recorded", !n.scope && !projects.length],
					["Agent", [made && `created with ${made}`, changed && changed !== made ? `last changed with ${changed}` : "", lastDevice ? `last change from device ${lastDevice}` : ""].filter(Boolean).join("; ") || "Not recorded", !made && !changed && !lastDevice],
					strengthRow, ["Created", recorded(n.created_at)], ["Updated", recorded(n.updated_at)], ["Origin", recorded(n.origin)],
					["Files", refs("file").map((e) => String(e.ref)).join(", ") || "None recorded", !refs("file").length],
					["Concepts", concepts.join(", ") || "None linked", !concepts.length],
					["Kind", recorded(n.kind)], ["Type", recorded(n.memory_type)], ["Status", recorded(n.status)], ["Flagged", n.flagged ? String(n.flagged) : "no"],
					...(n.source_profile ? [["Copied or moved from", String(n.source_profile)] as [string, string]] : [])]);
			};
			paintFacts();
			call(`/api/profiles/${enc(pn)}/recall-strength?ids=${enc(id)}`).then((s: J) => {
				strength = s?.strength?.[id] ?? null;
				strengthRow[1] = strength ? `${strength.strength}/10 (${strength.hits_90d} recall${strength.hits_90d === 1 ? "" : "s"} in 90 days; last ${strength.last_recalled ? day(strength.last_recalled) : "never"})` : "Not recorded";
				if (current()) paintFacts();
			}, (err: unknown) => { strengthRow[1] = `Not loaded: ${why(err)}`; if (current()) paintFacts(); });

			if (n.description) { el("h4", panel, "Description"); textBlock(panel, String(n.description)); if (cut.includes("description")) note(panel, "The description is longer than shown."); }
			el("h4", panel, "Content");
			const editBox = el("div", panel), contentBox = el("div", panel);
			if (!text) note(contentBox, "No content."); else textBlock(contentBox, text);
			if (!complete && text) {
				const part = el("p", panel, `Showing the first ${text.length} of ${recorded(c.chars)} characters.`);
				let cursor: string | null = null;
				const full = btn(panel, "Load the full content", async () => {
					full.disabled = true;
					try {
						const page: J = await call(`${base}?content=all${cursor ? `&cursor=${enc(cursor)}` : ""}`);
						if (!current()) return;
						if (!cursor) { contentBox.replaceChildren(); text = ""; }
						const chunk = String(page.content?.content ?? "");
						text += chunk;
						textBlock(contentBox, chunk);
						cursor = typeof page.content?.cursor === "string" ? page.content.cursor : null;
						full.textContent = "Load the next part";
						full.hidden = !cursor;
						if (!cursor) { complete = true; copyText.textContent = "Copy text"; part.textContent = `Showing all ${text.length} characters.`; allowEdit(); }
					} catch (err) { if (current()) st.textContent = `Could not load the content: ${why(err)}`; }
					full.disabled = false;
				});
			}

			// Edit in place: one new revision through the save tool, bound to the revision shown, so a newer change is refused, not overwritten.
			let sent: { body: string; request_id: string } | null = null;
			const edit = () => {
				if (!editable()) return;
				editBox.replaceChildren();
				const f = el("form", editBox);
				f.setAttribute("aria-label", `Edit ${name}`);
				const nm = input(f, "mem-edit-name", "Name");
				nm.value = name;
				const desc = input(f, "mem-edit-desc", "Description", "textarea");
				desc.value = String(n.description ?? "");
				const body = input(f, "mem-edit-content", "Content", "textarea");
				body.value = text;
				el("p", f, `Saving makes revision ${latest + 1}; revision ${latest} stays in the history. A change made by anyone else since you opened this record is refused, not overwritten.`);
				const row2 = el("p", f), save = el("button", row2, "Save");
				save.setAttribute("type", "submit");
				writes.push(save);
				btn(row2, "Cancel", () => { editBox.replaceChildren(); editBtn.focus(); });
				f.addEventListener("submit", async (e) => {
					e.preventDefault();
					const nn = nm.value.trim();
					const problem = !nn ? "Give the memory a name." : !desc.value.trim() ? "Write a short description." : "";
					if (problem) { st.textContent = problem; st.focus(); return; }
					if (busy) return;
					const payload: Record<string, unknown> = { memory_id: id, expected_revision: latest, ...(nn !== name ? { new_name: nn } : {}), description: desc.value, content: body.value };
					// A retry of the same body reuses its request id, so a lost answer replays instead of writing twice.
					const same = JSON.stringify(payload);
					if (!sent || sent.body !== same) sent = { body: same, request_id: `dashboard:${crypto.randomUUID()}` };
					setBusy(true);
					st.textContent = `Saving "${name}"…`;
					try {
						const res: J = await call(`/api/profiles/${enc(pn)}/save`, "POST", { ...payload, request_id: sent.request_id });
						setBusy(false);
						if (!onPage()) return;
						sent = null;
						const rw = rows.get(key);
						if (rw) { rw.title.textContent = String(res?.name ?? nn); rw.ver.textContent = `v${recorded(res?.revision)}`; rw.it.revision = res?.revision; rw.it.name = res?.name ?? nn; }
						report(`Saved "${String(res?.name ?? nn)}" as revision ${recorded(res?.revision)}.`, []);
						if (current()) void detail(pn, id);
					} catch (err) {
						setBusy(false);
						if (!current()) return;
						st.textContent = (err as Failure).code === "revision_conflict"
							? "This record changed since you opened it. Your text is still in the form; copy it, then reopen the record to edit the newer revision."
							: `Could not save: ${why(err)}. Saving again sends the same request.`;
						st.focus();
					}
				});
				nm.focus();
			};

			// Versions: the stored revisions, newest first, with a word diff between any two.
			am.help(el("h4", panel, "Versions"), "revisions");
			const vt = el("table", panel), vh = el("tr", el("thead", vt)), vb = el("tbody", vt);
			for (const t of ["Version", "Change", "When", "By", ""]) el("th", vh, t).setAttribute("scope", "col");
			const pick = el("form", panel);
			pick.setAttribute("aria-label", "Compare two versions");
			const from = choose(pick, "mem-from", "From", []), to = choose(pick, "mem-to", "To", []);
			el("button", el("p", pick), "Compare").setAttribute("type", "submit");
			const diffOut = el("div", panel);
			diffOut.setAttribute("aria-live", "polite");
			let before: number | null = r.history?.next_before ?? null;
			const older = btn(panel, "Older versions", async () => {
				older.disabled = true;
				try {
					const page: J = await call(`${base}?before=${before}`);
					if (!current()) return;
					history.push(...(page.history?.items ?? []));
					before = page.history?.next_before ?? null;
					paintVersions();
				} catch (err) { if (current()) st.textContent = `Could not load older versions: ${why(err)}`; }
				older.disabled = false;
				older.hidden = before === null;
			});
			older.hidden = before === null;
			const paintVersions = () => {
				vb.replaceChildren();
				const keepFrom = from.value, keepTo = to.value;
				from.replaceChildren();
				to.replaceChildren();
				history.forEach((hv, i) => {
					const tr = el("tr", vb), vc = el("td", tr, `v${recorded(hv.revision)} `);
					if (Number(hv.revision) === latest) chip(vc, "latest", "version");
					el("td", tr, recorded(hv.op));
					el("td", tr, recorded(hv.at));
					el("td", tr, [hv.actor ? String(hv.actor) : "", deviceName(hv.device_id) ?? ""].filter(Boolean).join(", ") || "Not recorded");
					const prev = history[i + 1], cell = el("td", tr);
					if (prev) btn(cell, "Changes", () => compare(prev, hv), `Changes in version ${recorded(hv.revision)}`);
					else el("span", cell, before === null ? "First version" : "Load older versions to compare").setAttribute("class", "na");
					for (const s of [from, to]) el("option", s, `v${recorded(hv.revision)} (${recorded(hv.op)}, ${day(hv.at ?? null)})`).setAttribute("value", String(hv.revision));
				});
				from.value = keepFrom || String(history[1]?.revision ?? history[0]?.revision ?? "");
				to.value = keepTo || String(history[0]?.revision ?? "");
			};
			paintVersions();
			if (!history.length) note(panel, "No stored versions are listed for this record.");

			// One version's state: the latest is today's read; an earlier one is the entity read at that version's recorded time.
			type Version = { rev: number; name: string; description: string; scope: string; status: string; text: string | null; partial: boolean };
			const cache = new Map<number, Promise<Version>>();
			const readVersion = (h: J): Promise<Version> => {
				const rev = Number(h.revision);
				if (!cache.has(rev)) cache.set(rev, (async () => {
					const at = rev === latest ? "" : `as_of=${enc(String(h.at))}`;
					const got: J = await call(`${base}${at ? `?${at}` : ""}`), gn = got.node ?? {}, gc = got.content ?? {};
					let body: string | null = gc.known === false || gc.text === null || gc.text === undefined ? null : String(gc.text), partial = false;
					if (body !== null && gc.complete === false) {
						body = "";
						let cursor: string | null = null;
						do {
							const page: J = await call(`${base}?${at ? `${at}&` : ""}content=all${cursor ? `&cursor=${enc(cursor)}` : ""}`);
							body += String(page.content?.content ?? "");
							cursor = typeof page.content?.cursor === "string" ? page.content.cursor : null;
						} while (cursor && body.length < TEXT_CAP);
						partial = cursor !== null;
					}
					return { rev: Number(gn.revision), name: String(gn.name ?? ""), description: String(gn.description ?? ""), scope: String(gn.scope ?? ""), status: String(gn.status ?? ""), text: body, partial };
				})());
				const pending = cache.get(rev)!;
				pending.catch(() => cache.delete(rev));
				return pending;
			};
			const compare = async (a: J, b: J) => {
				diffOut.replaceChildren();
				const said = el("p", diffOut, `Reading v${recorded(a.revision)} and v${recorded(b.revision)}…`);
				said.setAttribute("tabindex", "-1");
				let x: Version, y: Version;
				try { [x, y] = await Promise.all([readVersion(a), readVersion(b)]); }
				catch (err) { if (current()) said.textContent = `Could not read both versions: ${why(err)}`; return; }
				if (!current()) return;
				said.textContent = `Changes from v${recorded(a.revision)} (${recorded(a.at)}) to v${recorded(b.revision)} (${recorded(b.at)})`;
				for (const [want, got] of [[a, x], [b, y]] as [J, Version][])
					if (Number(want.revision) !== got.rev) note(diffOut, `v${recorded(want.revision)} was recorded at the same moment as v${got.rev}, so it reads as v${got.rev}.`);
				const fieldsChanged: [string, string][] = [];
				if (x.name !== y.name) fieldsChanged.push(["Name", `"${x.name}" to "${y.name}"`]);
				if (x.scope !== y.scope) fieldsChanged.push(["Scope", `${x.scope || "none"} to ${y.scope || "none"}`]);
				if (x.status !== y.status) fieldsChanged.push(["Status", `${x.status || "not recorded"} to ${y.status || "not recorded"}`]);
				if (fieldsChanged.length) facts(diffOut, fieldsChanged);
				if (x.description !== y.description) showDiff(diffOut, "Description", x.description, y.description);
				if (x.text === null || y.text === null) note(diffOut, `The text of v${x.text === null ? x.rev : y.rev} cannot be rebuilt from what is stored, so the text is not compared.`);
				else if (x.text === y.text) note(diffOut, fieldsChanged.length || x.description !== y.description ? "The text is unchanged." : "Nothing in the name, scope, status, description or text changed (a pin or link change, for example).");
				else showDiff(diffOut, "Text", x.text, y.text);
				if (x.partial || y.partial) note(diffOut, `Only the first ${TEXT_CAP.toLocaleString("en")} characters of each text were compared.`);
				said.focus();
			};
			pick.addEventListener("submit", (e) => {
				e.preventDefault();
				const a = history.find((h) => String(h.revision) === from.value), b = history.find((h) => String(h.revision) === to.value);
				if (!a || !b || a === b) { diffOut.replaceChildren(); note(diffOut, "Choose two different versions."); return; }
				void (Number(a.revision) < Number(b.revision) ? compare(a, b) : compare(b, a));
			});

			// Provenance: the record's evidence pointers and links, as stored.
			el("h4", panel, "Provenance");
			const group = (label: string, list: J[], linkOf?: (e: J) => string) => {
				el("h5", panel, label);
				if (!list.length) { note(panel, "None recorded."); return; }
				const ul = el("ul", panel);
				for (const e of list) {
					const li = el("li", ul), t = `${String(e.ref)}${e.note ? ` (${String(e.note)})` : ""}`;
					if (linkOf) link(li, linkOf(e), t); else el("span", li, t);
				}
			};
			// Only a linked session record has an id the Sessions tab opens. Session evidence holds the client's own session
			// reference, which is not that id, so it is listed as text and never used as a link.
			const sessionLinks = links.filter((l) => l.other?.readable && l.other.kind === "session"), sessionRefs = refs("session");
			el("h5", panel, "Sessions");
			if (sessionLinks.length) { const ul = el("ul", panel); for (const l of sessionLinks) link(el("li", ul), `#sessions/${enc(String(l.other.id))}?profile=${enc(pn)}`, String(l.other.name)); }
			if (sessionRefs.length) note(panel, `Not linked: session reference${sessionRefs.length === 1 ? "" : "s"} ${sessionRefs.map((e) => String(e.ref)).join(", ")}. This evidence holds the client's session reference, not a session record id, so the Sessions tab cannot open it from here.`);
			if (!sessionLinks.length && !sessionRefs.length) note(panel, "None recorded.");
			group("Observations", refs("entry"));
			group("Other evidence", ev.filter((e) => !["session", "entry"].includes(String(e.kind))).map((e) => ({ ...e, ref: `${String(e.kind)}: ${String(e.ref)}` })));
			if (r.evidence?.truncated) note(panel, "More evidence exists than shown.");
			el("h5", panel, "Links");
			if (links.length) {
				const ul = el("ul", panel);
				for (const l of links) {
					const li = el("li", ul), o = l.other ?? {};
					el("span", li, `${l.direction === "in" ? "From" : "To"} `);
					if (o.readable) link(li, memoryHash(pn, String(o.id)), `${String(o.kind)}: ${String(o.name)}`);
					else el("span", li, "a record not readable in this profile");
					el("span", li, `, ${String(l.rel)}${l.other_label ? ` (${String(l.other_label)})` : ""}${l.reason ? `: ${String(l.reason)}` : ""}`);
				}
			} else note(panel, "No links.");
			if (r.budget?.exhausted) note(panel, "Some links could not be read within this read's budget.");

			el("h4", panel, "More");
			const moreLinks = el("ul", panel);
			for (const [href, label] of [[`#/memory/${enc(pn)}/${enc(id)}`, "Open the full record page"], [`#/map/${enc(pn)}/${enc(id)}`, "Center the map here"],
				[`#/path/${enc(pn)}/${enc(id)}`, "Find a path from here"], [`#/move/${enc(pn)}/${enc(id)}`, "Move to another profile"],
				[`#/copy/${enc(pn)}/${enc(id)}`, "Save a copy in another profile"], [`#/timeline/${enc(pn)}/${enc(id)}`, "Timeline of this record"],
				...(n.kind === "journal" ? [[`#/journals/${enc(pn)}/${enc(id)}`, "Read as a journal"]] : [])]) link(el("li", moreLinks), href!, label!);

			const raw = el("details", panel);
			el("summary", raw, "Raw record");
			el("pre", raw, JSON.stringify(r.node, null, 2));
		};

		// A record link with no profile is not read anywhere: the owner picks the profile that holds it.
		const askProfile = (id: string) => {
			panel.hidden = false;
			panel.replaceChildren();
			const top = el("div", panel), ask = el("h3", top, "Which profile holds this record?");
			ask.setAttribute("tabindex", "-1");
			btn(top, "Close", () => close(), "Close the memory panel").setAttribute("data-close", "");
			el("p", panel, `This link names no profile, so nothing was read for record ${id}. Choose the profile that holds it:`);
			const ul = el("ul", panel);
			for (const x of am.active()) link(el("li", ul), `#memories/${enc(id)}?profile=${enc(x.name)}${q.value.trim() ? `&q=${enc(q.value.trim())}` : ""}`, x.name);
			if (!am.active().length) note(panel, "No active profiles available.");
		};
		load();
		if (route.id !== undefined) { if (only !== null) void detail(only, route.id); else askProfile(route.id); }
		return h;
	};
	am.pages.memories = memoriesPage;
	am.pages.memory = memoryPage;
	am.tab({ id: "memories", group: "memory", label: "Memories", key: "m", profiles: "any", count: (s) => s.counts.memories, render: (root, route) => memoriesView(root, route) });
}
