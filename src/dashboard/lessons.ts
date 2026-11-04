// Lessons tab (#27): preferences and rules from each active profile's owner model (kinds=preference,rule, the read About you
// uses), with 90-day uses from recall-strength and the owner's pin, unpin, unflag and forget node actions, each with its Undo.
// The profile is the link's ?profile=NAME (the shell's header picker; none is All profiles). #lessons/ID?profile=P opens one
// lesson even when it is not on a loaded page, through the entity read of that profile; with no profile it asks which one.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile, Route } from "./am";

export function lessonsTab(am: Am): void {
	const { act, active, btn, call, choose, copy, day, el, empty, enc, input, intro, link, loading, mcpCall, mcpCurl, note, pageStatus, recorded, undoOf, why, win } = am;
	type Lesson = { profile: string; id: string; kind: string; name: string; description: string; origin: string; pinned: boolean; flagged: string | null;
		updated_at: string; scope: string; projects: string[]; evidence: { kind: string; ref: string; note: string | null }[]; evidence_truncated: boolean; evidence_missing: boolean };
	const SOURCES = 5; // an inferred lesson's bar: its evidence pointers, capped here
	const KINDS = ["preference", "rule"];
	const filters = { q: "", project: "", origin: "", kind: "" }; // kept across the re-render that follows each action
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const evidenceOf = (v: unknown) => (Array.isArray(v) ? v : []).map((e: J) => ({ kind: str(e?.kind), ref: str(e?.ref), note: e?.note ? String(e.note) : null }));
	const fromModel = (profile: string, it: J): Lesson => ({ profile, id: String(it.id), kind: str(it.kind) || "preference", name: str(it.name), description: str(it.description),
		origin: str(it.origin), pinned: it.pinned === true, flagged: str(it.flagged) || null, updated_at: str(it.updated_at), scope: str(it.scope),
		projects: Array.isArray(it.projects) ? it.projects.filter((p: unknown) => typeof p === "string" && p) : [],
		evidence: evidenceOf(it.evidence), evidence_truncated: it.evidence_truncated === true, evidence_missing: it.evidence_missing === true });
	// The entity read of one node, for a deep link to a lesson not on a loaded page. Projects are its current, readable project links.
	const fromEntity = (profile: string, r: J): Lesson | null => {
		const n = r?.node;
		if (!n || !KINDS.includes(str(n.kind)) || n.status !== "active") return null;
		const ev = evidenceOf(r.evidence?.items);
		const projects: string[] = [...new Set<string>((Array.isArray(r.links) ? r.links : []).filter((l: J) => l?.other?.readable === true && l.other.kind === "project"
			&& !l.ended_at && l.direction === "out").map((l: J) => str(l.other.name)).filter(Boolean))].sort().slice(0, 3);
		return { profile, id: String(n.id), kind: str(n.kind), name: str(n.name), description: str(n.description), origin: str(n.origin), pinned: n.pinned === true || n.pinned === 1,
			flagged: str(n.flagged) || null, updated_at: str(n.updated_at), scope: str(n.scope), projects, evidence: ev, evidence_truncated: r.evidence?.truncated === true,
			evidence_missing: str(n.origin) === "inferred" && ev.length === 0 };
	};

	am.tab({ id: "lessons", group: "memory", label: "Lessons", key: "l", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion, h = el("h2", root, "Lessons"), named = route.query.profile;
		const here = (id?: string, profile = named) => `#lessons${id ? `/${enc(id)}` : ""}${profile ? `?profile=${enc(profile)}` : ""}`;
		intro(root, "Lessons", "lessons", "Preferences and rules your agents follow: ones you stated, and ones an agent inferred with evidence. Pin keeps one through background cleanup; Forget moves it to the archive, and Undo brings it back.");
		const { msg, say } = pageStatus(root);
		const all = named === undefined; // the shell has already refused an unknown or inactive ?profile

		const tools = el("form", root);
		tools.setAttribute("class", "toolbar");
		tools.setAttribute("role", "search");
		tools.addEventListener("submit", (event) => event.preventDefault());
		const q = input(tools, "lessons-q", "Filter lessons (press /)");
		q.setAttribute("type", "search");
		q.value = filters.q;
		const kind = choose(tools, "lessons-kind", "Kind", [["", "Preferences and rules"], ["preference", "Preferences"], ["rule", "Rules"]]);
		kind.value = filters.kind;
		const project = choose(tools, "lessons-project", "Project", [["", "All projects"]]);
		const origin = choose(tools, "lessons-origin", "Origin", [["", "All origins"], ["stated", "Stated"], ["inferred", "Inferred"], ["other", "Other origins"]]);
		origin.value = filters.origin;

		const box = el("section", root);
		box.setAttribute("class", "agentbox");
		box.setAttribute("aria-label", "Use lessons from an agent or a terminal");
		el("h3", box, "Use lessons from an agent or a terminal");
		el("p", box, "Agents read lessons with recall_memories. The terminal command sends the same call to /mcp with a device token that has the read scope; set AGENT_MEMORY_TOKEN to it first.");
		const recallArgs = () => ({ keyword: q.value.trim() || "TOPIC", kinds: filters.kind ? [filters.kind] : KINDS, ...(named ? { profile: named } : {}) });
		copy(box, "Copy MCP call", () => mcpCall("recall_memories", recallArgs()));
		copy(box, "Copy curl", () => mcpCurl("recall_memories", recallArgs()));

		if (!active().length) { empty(root, "No active profiles yet."); return h; }
		const linked = el("section", root);
		linked.setAttribute("aria-label", "Linked lesson");
		linked.hidden = true;
		const table = el("table", root);
		table.hidden = true;
		el("caption", table, "Lessons");
		const columns = (t: Node) => { const tr = el("tr", el("thead", t)); for (const c of ["Lesson", "Project", "Origin", "Confidence", "Uses (90 days)", "Updated", "Actions"]) el("th", tr, c).setAttribute("scope", "col"); };
		columns(table);
		const body = el("tbody", table);
		const wait = loading(root);
		const more = btn(root, "Load more", () => load());
		more.hidden = true;

		const rows: Lesson[] = [];
		const uses = new Map<string, number | null>(); // profile/id -> 90-day hits; null when the read failed
		const after = new Map<string, string | null>(); // per profile still to read: its next cursor; absent once its list is done
		let started = false;
		const failed: string[] = [];

		const confidence = (cell: Node, it: Lesson) => {
			// Stated is the owner's own word; inferred shows only its evidence count. Any other origin has no data to rate it by.
			const n = it.origin === "stated" ? SOURCES : it.origin === "inferred" ? Math.min(it.evidence.length, SOURCES) : null;
			if (n === null) { note(cell, "Not rated: neither stated nor inferred"); return; }
			const bar = el("meter", cell);
			bar.setAttribute("class", "bar");
			bar.setAttribute("min", "0");
			bar.setAttribute("max", String(SOURCES));
			bar.setAttribute("value", String(n));
			bar.setAttribute("aria-label", it.origin === "stated" ? "Stated by you" : `${n} of ${SOURCES} evidence sources`);
			el("span", cell, it.origin === "stated" ? " STATED 100%" : ` ${n}/${SOURCES} sources`);
		};
		const row = (tbody: Node, it: Lesson) => {
			const tr = el("tr", tbody), name = it.name || "(no name)";
			if (it.id === route.id && (!named || it.profile === named)) tr.setAttribute("aria-current", "true");
			const first = el("td", tr);
			el("span", first, it.kind.toUpperCase()).setAttribute("class", `chip chip-${it.kind}`);
			el("strong", first, ` ${name}`);
			if (it.description) el("p", first, it.description);
			const ev = el("details", first);
			el("summary", ev, `Evidence (${it.evidence.length}${it.evidence_truncated ? "+" : ""})`);
			if (it.evidence.length) {
				const ul = el("ul", ev);
				for (const e of it.evidence) el("li", ul, `${e.kind}: ${e.ref}${e.note ? ` (${e.note})` : ""}`);
			} else note(ev, it.evidence_missing ? "No evidence is recorded for this inferred lesson." : "No evidence pointers.");
			if (it.evidence_truncated) note(ev, `Showing the first ${it.evidence.length} evidence pointers; more exist.`);
			if (it.flagged) note(first, `Flagged: ${it.flagged}`, "warn");
			const proj = el("td", tr);
			for (const p of it.projects) el("span", proj, p).setAttribute("class", "chip");
			if (!it.projects.length) note(proj, "No linked project");
			if (it.scope && it.scope !== "default") el("div", proj, `Scope: ${it.scope}`);
			if (all) el("span", proj, it.profile).setAttribute("class", "chip chip-profile");
			const o = el("td", tr), stated = it.origin === "stated" || it.origin === "inferred";
			el("span", o, it.origin ? it.origin.toUpperCase() : "NOT RECORDED").setAttribute("class", `chip chip-${stated ? it.origin : "other"}`);
			if (it.pinned) el("span", o, "PINNED").setAttribute("class", "chip chip-pinned");
			confidence(el("td", tr), it);
			const u = uses.get(`${it.profile}/${it.id}`);
			el("td", tr, u === undefined || u === null ? "Not available" : String(u));
			el("td", tr, day(it.updated_at || null));
			const cell = el("td", tr);
			const node = `/api/profiles/${enc(it.profile)}/nodes/${enc(it.id)}`;
			const done = (verb: string, extra = "") => (r: J) => ({ text: `Done: ${recorded(r?.action ?? verb)} “${name}”.${extra}`, undo: undoOf(it.profile, r) });
			const actions = (): Node => {
				cell.replaceChildren();
				const verb = it.pinned ? "unpin" : "pin";
				btn(cell, it.pinned ? "Unpin" : "Pin", () => act(`${node}/${verb}`, `${verb} “${name}”`, undefined, done(verb)), `${it.pinned ? "Unpin" : "Pin"} ${name}`);
				if (it.flagged) btn(cell, "Unflag", () => act(`${node}/unflag`, `unflag “${name}”`, undefined, done("unflag")), `Unflag ${name}`);
				return btn(cell, "Forget…", () => {
					cell.replaceChildren();
					const ask = el("span", cell, `Forget “${name}”? It moves to the archive; Undo brings it back. `);
					ask.setAttribute("tabindex", "-1");
					btn(cell, "Forget it", () => act(`${node}/forget`, `forget “${name}”`, undefined, done("forget", " It is in the archive; Undo brings it back.")), `Forget ${name} now`);
					btn(cell, "Cancel", () => actions().focus());
					ask.focus();
				}, `Forget ${name}`);
			};
			actions();
			const ids = el("p", cell);
			copy(ids, "Copy ID", () => it.id);
			copy(ids, "Copy link", () => `${win.location.origin}${win.location.pathname ?? ""}${here(it.id, it.profile)}`);
		};
		const matches = (it: Lesson) => {
			const t = filters.q.toLowerCase();
			return (!t || `${it.name}\n${it.description}`.toLowerCase().includes(t)) && (!filters.kind || it.kind === filters.kind)
				&& (!filters.project || it.projects.includes(filters.project))
				&& (!filters.origin || (filters.origin === "other" ? it.origin !== "stated" && it.origin !== "inferred" : it.origin === filters.origin));
		};
		const draw = () => {
			body.replaceChildren();
			const shown = rows.filter(matches);
			for (const it of shown) row(body, it);
			table.hidden = !rows.length;
			more.hidden = !after.size;
			say([failed.length ? `Could not load ${failed.join("; ")}.` : "",
				rows.length ? `Showing ${shown.length} of ${rows.length} lesson${rows.length === 1 ? "" : "s"} loaded${after.size ? "; more are available" : ""}.` : ""].filter(Boolean).join(" "));
		};
		const projects = () => {
			const names = [...new Set(rows.flatMap((r) => r.projects))].sort();
			project.replaceChildren();
			for (const [v, t] of [["", "All projects"], ...names.map((n) => [n, n])] as [string, string][]) el("option", project, t).setAttribute("value", v);
			project.value = names.includes(filters.project) ? filters.project : "";
			filters.project = project.value;
		};
		const strengths = async (profile: string, ids: string[]) => {
			for (let i = 0; i < ids.length; i += 100) {
				const chunk = ids.slice(i, i + 100);
				let got: Record<string, { hits_90d?: unknown }> = {};
				try { got = (await call(`/api/profiles/${enc(profile)}/recall-strength?ids=${chunk.map(enc).join(",")}`))?.strength ?? {}; } catch { got = {}; }
				for (const id of chunk) { const n = got[id]?.hits_90d; uses.set(`${profile}/${id}`, typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null); }
			}
		};
		// The deep-linked lesson, in the named profile only: from a loaded page, else that profile's entity read. With All profiles
		// an id is ambiguous (a copy keeps it in another profile), so it asks for the profile and reads nothing for it.
		const target = async () => {
			if (!route.id) return;
			const id = route.id;
			linked.hidden = false;
			el("h3", linked, "Linked lesson");
			if (!named) {
				note(linked, `Choose the profile that holds lesson ${id}:`, "");
				const ul = el("ul", linked);
				for (const p of active()) link(el("li", ul), here(id, p.name), p.name);
				return;
			}
			let it: Lesson | null = rows.find((r) => r.id === id && r.profile === named) ?? null, problem = "";
			if (!it) {
				// A 404 only means the id is not in this profile; any other failure is said.
				try { it = fromEntity(named, await call(`/api/profiles/${enc(named)}/nodes/${enc(id)}`)); } catch (err) { if ((err as J)?.status !== 404) problem = ` Could not read it: ${why(err)}`; }
				if (it) await strengths(named, [id]);
			}
			if (version !== am.pageVersion) return;
			if (!it) { note(linked, `No active preference or rule with ID ${id} in ${named}.${problem}`); return; }
			const t = el("table", linked);
			el("caption", t, "Linked lesson");
			columns(t);
			row(el("tbody", t), it);
			link(el("p", linked), here(), "Close the linked lesson");
		};
		const load = async () => {
			more.disabled = true;
			say(rows.length ? "Loading more lessons…" : "Loading lessons…");
			failed.length = 0;
			const added: Lesson[] = [];
			// One page from one profile; a profile that fails keeps its place in `after`, so Try again reads it again.
			const page = async (p: Profile): Promise<Lesson[]> => {
				if (!after.has(p.name)) after.set(p.name, null);
				const cursor = after.get(p.name);
				const r = await call(`/api/profiles/${enc(p.name)}/owner-model?kinds=preference,rule&limit=200${cursor ? `&after=${enc(cursor)}` : ""}`);
				if (!Array.isArray(r?.items)) throw new Error("the server sent no lesson list");
				const items: Lesson[] = r.items.map((it: J) => fromModel(p.name, it));
				if (typeof r.next_after === "string" && r.next_after) after.set(p.name, r.next_after);
				else after.delete(p.name);
				await strengths(p.name, items.map((i) => i.id));
				return items;
			};
			const results = started ? (await Promise.all([...after.keys()].map((n) => am.eachProfile(n, page)))).flat() : await am.eachProfile(named ?? null, page);
			started = true;
			for (const r of results) {
				if (r.ok) added.push(...r.value);
				else { failed.push(`${r.profile}: ${why(r.error)}`); if (!after.has(r.profile)) after.set(r.profile, null); }
			}
			if (version !== am.pageVersion) return;
			const first = !wait.hidden;
			wait.replaceChildren();
			wait.hidden = true;
			rows.push(...added);
			more.disabled = false;
			more.textContent = failed.length ? "Try again" : "Load more";
			projects();
			draw();
			if (first) await target();
			if (!rows.length && !after.size) empty(root, "No lessons yet. They appear when you state a preference or rule to an agent, or an agent infers one and records its evidence.");
			if (more.hidden && rows.length > added.length) msg.focus();
		};
		q.addEventListener("input", () => { filters.q = q.value.trim(); draw(); });
		kind.addEventListener("change", () => { filters.kind = kind.value; draw(); });
		project.addEventListener("change", () => { filters.project = project.value; draw(); });
		origin.addEventListener("change", () => { filters.origin = origin.value; draw(); });
		load();
		return h;
	} });
}
