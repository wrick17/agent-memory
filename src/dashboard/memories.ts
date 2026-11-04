// Memories tab. D0: today's memories list and record pages, unchanged; TG2 rebuilds the tab.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "./am";

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
	am.pages.memories = memoriesPage;
	am.pages.memory = memoryPage;
	am.tab({ id: "memories", group: "memory", label: "Memories", key: "m", count: (s) => s.counts.memories,
		render: (root, route) => am.legacy(root, route.id === undefined ? "memories" : "memory", am.profile ?? undefined, route.id) });
}
