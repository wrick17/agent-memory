// Crystals tab (#27): summaries of finished work. A compacted journal's stored summary (the existing journals route) and a
// completed session with consolidated digest parts (the sessions routes), each showing only the fields its source records.
// The profile is the link's ?profile=NAME (the shell's header picker; none is All profiles).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile, Route } from "./am";

export function crystalsTab(am: Am): void {
	const { active, btn, call, choose, copy, curl, day, el, empty, enc, facts, input, intro, link, loading, mcpCall, mcpCurl, note, pageStatus, textBlock, why } = am;
	type Crystal = {
		source: "journal" | "session"; profile: string; id: string; title: string; at: string;
		scope: string; project_id: string | null; // a journal's scope; a session's linked project record (a node id)
		narrative: string | null; partial: boolean; // a journal summary's first stored part only
		built: string[]; decisions: string[]; outcomes: string[]; files_changed: number | null; lessons: { id: string; kind: string; title: string }[];
	};
	const filters = { q: "", scope: "", lesson: "" };
	const str = (v: unknown) => (typeof v === "string" ? v : "");

	am.tab({ id: "crystals", group: "memory", label: "Crystals", key: "c", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion, h = el("h2", root, "Crystals"), named = route.query.profile;
		intro(root, "Crystals", "crystals", "Summaries of finished work: journals an agent compacted into a summary, and completed sessions whose digests were consolidated.");
		const { msg, say } = pageStatus(root);
		const one = named ?? null; // the shell has already refused an unknown or inactive ?profile
		const sessionsTab = am.tabs.some((t) => t.id === "sessions");

		const tools = el("form", root);
		tools.setAttribute("class", "toolbar");
		tools.setAttribute("role", "search");
		tools.addEventListener("submit", (event) => event.preventDefault());
		const q = input(tools, "crystals-q", "Filter crystals (press /)");
		q.setAttribute("type", "search");
		q.value = filters.q;
		const scope = choose(tools, "crystals-scope", "Journal scope", [["", "All scopes"]]);
		const lesson = choose(tools, "crystals-lesson", "Lesson", [["", "Any lesson"]]);
		note(root, "Hosted digests keep a count of files changed, not their paths, so there is no file filter.");

		if (!active().length) { empty(root, "No active profiles yet."); return h; }
		const list = el("ul", root);
		list.setAttribute("class", "cards");
		list.setAttribute("aria-label", "Crystals");
		const wait = loading(root);
		const more = btn(root, "Load more", () => load());
		more.hidden = true;

		const crystals: Crystal[] = [], failed: string[] = [];
		const journalAfter = new Map<string, string | null>(); // per profile still to read: its next cursor; absent once its list is done
		let started = false;
		let sessionCursor: string | null = null, sessionsDone = false;

		const asText = (c: Crystal) => [c.title, c.narrative ?? "", ...c.decisions.map((d) => `Decision: ${d}`), ...c.outcomes.map((o) => `Outcome: ${o}`),
			...c.lessons.map((l) => `Lesson: ${l.title}`)].filter(Boolean).join("\n");
		const card = (c: Crystal) => {
			const li = el("li", list);
			li.setAttribute("class", "card");
			el("span", li, c.source === "journal" ? "JOURNAL" : "SESSION").setAttribute("class", `chip chip-${c.source}`);
			if (c.scope && c.scope !== "default") el("span", li, c.scope).setAttribute("class", "chip");
			if (!one) el("span", li, c.profile).setAttribute("class", "chip chip-profile");
			el("h3", li, c.title || "(no title)");
			if (c.narrative !== null) {
				textBlock(li, c.narrative);
				if (c.partial) note(li, "Only the summary's first part is shown; the journal page has the whole text.");
			}
			const rows: [string, string, boolean?][] = [[c.source === "journal" ? "Last compacted" : "Last upload", day(c.at || null)]];
			if (c.files_changed !== null) rows.push(["Files changed", `${c.files_changed} (paths stay on the device)`]);
			facts(li, rows);
			if (c.project_id) link(el("p", li), `#/memory/${enc(c.profile)}/${enc(c.project_id)}`, "Linked project record");
			const section = (title: string, items: string[]) => {
				if (!items.length) return;
				el("h4", li, title);
				const ul = el("ul", li);
				for (const t of items) el("li", ul, t);
			};
			section("Decisions", c.decisions);
			section("Key outcomes", c.outcomes);
			if (c.lessons.length) {
				el("h4", li, "Lessons surfaced");
				const ul = el("ul", li);
				for (const l of c.lessons) link(el("li", ul), `#lessons/${enc(l.id)}?profile=${enc(c.profile)}`, `${l.kind === "rule" ? "Rule" : "Preference"}: ${l.title || l.id}`);
			}
			section("Built from", c.built);
			const row = el("p", li);
			if (c.source === "journal") link(row, `#/journals/${enc(c.profile)}/${enc(c.id)}`, "Open journal");
			else if (sessionsTab) link(row, `#sessions/${enc(c.id)}?profile=${enc(c.profile)}`, "Open session");
			el("span", row, " ");
			copy(row, "Copy text", () => asText(c));
			copy(row, "Copy ID", () => c.id);
			if (c.source === "journal") {
				copy(row, "Copy MCP call", () => mcpCall("get_memory", { memory_id: c.id, profile: c.profile }));
				copy(row, "Copy MCP curl", () => mcpCurl("get_memory", { memory_id: c.id, profile: c.profile }));
				copy(row, "Copy owner curl", () => curl("GET", `/api/profiles/${enc(c.profile)}/journals?id=${enc(c.id)}&limit=1`));
			} else copy(row, "Copy owner curl", () => curl("GET", `/api/profiles/${enc(c.profile)}/sessions/${enc(c.id)}`));
		};
		const matches = (c: Crystal) => {
			const t = filters.q.toLowerCase();
			return (!t || asText(c).toLowerCase().includes(t)) && (!filters.scope || (c.source === "journal" && c.scope === filters.scope))
				&& (!filters.lesson || c.lessons.some((l) => l.title === filters.lesson));
		};
		const options = (s: Node, all: string, values: string[], current: string) => {
			s.replaceChildren();
			const names = [...new Set(values.filter((v) => v && v !== "default"))].sort();
			for (const [v, t] of [["", all], ...names.map((n) => [n, n])] as [string, string][]) el("option", s, t).setAttribute("value", v);
			s.value = names.includes(current) ? current : "";
			return s.value;
		};
		const draw = () => {
			list.replaceChildren();
			const shown = crystals.filter(matches).sort((x, y) => y.at.localeCompare(x.at));
			for (const c of shown) card(c);
			const left = journalAfter.size > 0 || !sessionsDone;
			more.hidden = !left;
			say([failed.length ? `Could not load ${failed.join("; ")}.` : "",
				crystals.length ? `Showing ${shown.length} of ${crystals.length} crystal${crystals.length === 1 ? "" : "s"} loaded, newest first${left ? "; more are available" : ""}.`
					: left ? "More sources remain; choose Load more." : ""].filter(Boolean).join(" "));
		};

		// One profile's next journal page; each compacted journal's first page carries its current summary and newest compactions.
		// shortcut: one journal read per compacted journal on the page (at most 50); a summary excerpt in the list would remove it.
		const journals = async ({ name: profile }: Profile) => {
			if (!journalAfter.has(profile)) journalAfter.set(profile, null); // a failed read keeps its place for Try again
			const after = journalAfter.get(profile), base = `/api/profiles/${enc(profile)}/journals`;
			const page = await call(`${base}?limit=50${after ? `&after=${enc(after)}` : ""}`);
			if (!Array.isArray(page?.items)) throw new Error("the server sent no journal list");
			const out = await Promise.all((page.items as J[]).filter((j) => j?.summarized === true).map(async (j): Promise<Crystal | null> => {
				const r = await call(`${base}?id=${enc(String(j.id))}&limit=1`);
				if (!r?.summary) return null;
				const comps: J[] = Array.isArray(r.compactions) ? r.compactions : [];
				const built = comps.filter((c) => Number.isSafeInteger(c?.from_seq) && Number.isSafeInteger(c?.through_seq))
					.map((c) => `Entries ${c.from_seq} to ${c.through_seq}, compacted ${day(str(c.at) || null)}`);
				if (r.compactions_more) built.push("Older compactions are not listed.");
				return { source: "journal", profile, id: String(j.id), title: str(r.journal?.name ?? j.name), scope: str(r.journal?.scope ?? j.scope), project_id: null,
					at: str(comps[0]?.at) || str(j.updated_at), narrative: str(r.summary.body), partial: r.summary.complete === false, built, decisions: [], outcomes: [],
					files_changed: null, lessons: [] };
			}));
			crystals.push(...out.filter((c): c is Crystal => c !== null));
			if (typeof page.next_after === "string" && page.next_after) journalAfter.set(profile, page.next_after);
			else journalAfter.delete(profile);
		};
		// Completed sessions, newest first; one with consolidated parts becomes a crystal from its digest events and the records citing it.
		const sessions = async () => {
			const page = await call(`${one ? `/api/profiles/${enc(one)}/sessions` : "/api/sessions"}?status=completed&limit=25${sessionCursor ? `&cursor=${enc(sessionCursor)}` : ""}`);
			if (!Array.isArray(page?.rows)) throw new Error("the server sent no session list");
			// All profiles reads the server's merged list (/api/sessions), which fails as a whole rather than leaving a profile out.
			const rows = (page.rows as J[]).filter((s) => Number(s?.counts?.parts) > 0);
			const out = await Promise.all(rows.map(async (s): Promise<Crystal> => {
				const profile = one ?? String(s.profile);
				const d = await call(`/api/profiles/${enc(profile)}/sessions/${enc(String(s.id))}`);
				const events: J[] = Array.isArray(d?.events) ? d.events : [];
				const produced: J[] = Array.isArray(d?.produced) ? d.produced : [];
				const parts = [...new Set(events.map((e) => str(e?.detail?.part)).filter(Boolean))];
				const files = d?.counts?.files_changed ?? s.counts?.files_changed;
				return { source: "session", profile, id: String(s.id), title: str(d?.first_ask ?? s.first_ask) || `${str(s.client)} session ${str(s.session)}`.trim(),
					scope: "", project_id: str(d?.project ?? s.project) || null, at: str(d?.last_upload_at ?? s.last_upload_at), narrative: null, partial: false,
					built: [`${Number(s.counts.parts)} consolidated digest part${Number(s.counts.parts) === 1 ? "" : "s"}`, ...parts.map((p) => `Part ${p}`)],
					decisions: events.filter((e) => e?.kind === "decision").map((e) => str(e.label)).filter(Boolean),
					outcomes: events.filter((e) => e?.kind === "outcome" && str(e.label)).map((e) => `${str(e.detail?.outcome) ? `${str(e.detail.outcome)}: ` : ""}${str(e.label)}`),
					files_changed: typeof files === "number" && Number.isSafeInteger(files) && files >= 0 ? files : null,
					lessons: produced.filter((p) => p?.kind === "preference" || p?.kind === "rule").map((p) => ({ id: String(p.id), kind: str(p.kind), title: str(p.title) })) };
			}));
			crystals.push(...out);
			sessionCursor = str(page.next_cursor) || null;
			sessionsDone = sessionCursor === null;
		};

		const load = async () => {
			more.disabled = true;
			say(crystals.length ? "Loading more crystals…" : "Loading crystals…");
			failed.length = 0;
			const before = crystals.length;
			const [results] = await Promise.all([
				started ? Promise.all([...journalAfter.keys()].map((n) => am.eachProfile(n, journals))).then((r) => r.flat()) : am.eachProfile(one, journals),
				sessionsDone ? Promise.resolve() : sessions().catch((err) => { failed.push(`sessions${one ? ` in ${one}` : " (all profiles)"}: ${why(err)}`); })]);
			started = true;
			for (const r of results) if (!r.ok) { failed.push(`${r.profile} journals: ${why(r.error)}`); if (!journalAfter.has(r.profile)) journalAfter.set(r.profile, null); }
			if (version !== am.pageVersion) return;
			wait.replaceChildren();
			wait.hidden = true;
			more.disabled = false;
			more.textContent = failed.length ? "Try again" : "Load more";
			filters.scope = options(scope, "All scopes", crystals.filter((c) => c.source === "journal").map((c) => c.scope), filters.scope);
			filters.lesson = options(lesson, "Any lesson", crystals.flatMap((c) => c.lessons.map((l) => l.title)), filters.lesson);
			draw();
			if (!crystals.length && !journalAfter.size && sessionsDone && !failed.length) {
				empty(root, "No crystals yet. They appear when an agent compacts a journal, or when the daily batch consolidates a finished session's digests.");
			}
			if (more.hidden && before > 0) msg.focus();
		};
		q.addEventListener("input", () => { filters.q = q.value.trim(); draw(); });
		scope.addEventListener("change", () => { filters.scope = scope.value; draw(); });
		lesson.addEventListener("change", () => { filters.lesson = lesson.value; draw(); });
		load();
		return h;
	} });
}
