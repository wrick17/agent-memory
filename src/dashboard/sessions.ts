// Sessions tab (#12 read model): the session list from the digests and one session's detail, from the owner session routes.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
// Hosted sessions hold digests only, so this tab shows no tool count, no transcript and no End session control.
// The profile is the link's ?profile= alone (the shell's shared choice): none lists every active profile through the server's
// merged /api/sessions, one lists that profile's own route. A session link without a profile asks rather than guesses.
import type { Am, J, Node } from "./am";

export function sessionsTab(am: Am): void {
	const { act, btn, call, copy, curl, el, empty, enc, facts, help, intro, link, loading, mcpCall, mcpCurl, note, pageStatus, recorded, why, win } = am;
	const KINDS: [string, string][] = [["all", "All"], ["ask", "Ask"], ["decision", "Decision"], ["correction", "Correction"], ["outcome", "Outcome"]];
	// Filters survive a re-render (after Queue consolidation or a deep link), so the list comes back as the owner left it.
	const filters = { q: "", project: "", client: "", status: "" };
	const projects = new Set<string>();

	const when = (iso: unknown) => typeof iso === "string" && iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "Not recorded";
	const ago = (iso: unknown) => {
		const t = typeof iso === "string" ? Date.parse(iso) : NaN;
		if (!Number.isFinite(t)) return "unknown age";
		const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
		return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
	};
	const span = (a: unknown, b: unknown) => {
		const ms = Date.parse(String(b)) - Date.parse(String(a));
		if (!Number.isFinite(ms) || ms < 0) return "Not recorded";
		const m = Math.round(ms / 60_000);
		return m < 1 ? "Under a minute" : m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`;
	};
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
	const observations = (c: J) => num(c?.asks) + num(c?.decisions) + num(c?.corrections) + num(c?.outcomes);
	const chip = (parent: Node, text: string, cls = "chip", title?: string) => {
		const s = el("span", parent, text);
		s.setAttribute("class", cls);
		if (title) s.setAttribute("title", title);
		return s;
	};
	// The server decides the status (an end is sticky); the chip only names it.
	const statusChip = (parent: Node, status: unknown) => status === "active"
		? chip(parent, "Active", "chip c-ok", "An upload in the last 30 minutes and no session end yet.")
		: chip(parent, "Completed", "chip", "A session end arrived, or nothing was uploaded for 30 minutes.");
	const agent = (r: J) => `${recorded(r.client)} · ${typeof r.device === "string" && r.device ? r.device : "device unknown"}`;
	const href = (profile: string, id: string, obs?: number) => `#sessions/${enc(id)}?profile=${enc(profile)}${obs === undefined ? "" : `&obs=${obs}`}`;

	const read = (profile: string, id: string) => call(`/api/profiles/${enc(profile)}/sessions/${enc(id)}`);
	const valid = (d: J) => typeof d?.id === "string" && Array.isArray(d.events);

	const detail = (panel: Node, profile: string, d: J, obs: number | undefined, version: number, close: () => void) => {
		panel.replaceChildren();
		const c = d.counts ?? {}, id = String(d.id), events: J[] = Array.isArray(d.events) ? d.events : [];
		const shut = btn(panel, "Close", close, "Close the session detail");
		shut.setAttribute("data-close", "");
		const head = el("p", panel);
		statusChip(head, d.status);
		el("span", head, ` ${profile} · ${agent(d)} · first upload ${when(d.first_upload_at)}`);
		el("h3", panel, typeof d.first_ask === "string" && d.first_ask ? d.first_ask : "Untitled session (no ask recorded)");

		const stats = el("div", panel);
		stats.setAttribute("class", "stats");
		const stat = (label: string, term: string, value: string, na = false) => {
			const s = el("div", stats);
			s.setAttribute("class", "stat");
			const v = el("strong", s, value);
			if (na) v.setAttribute("class", "na");
			const l = el("span", s, label);
			l.setAttribute("class", "lbl");
			help(l, term);
		};
		stat("Observations", "observation", String(observations(c)));
		// files_changed is the runner's own count; a runner that never sends it leaves it null, which is not zero.
		const files = typeof c.files_changed === "number" ? c.files_changed : null;
		stat("Files changed", "files_changed", files === null ? "Not reported" : String(files), files === null);
		stat("Consolidated parts", "consolidated_part", String(num(c.parts)));
		stat("Span of uploads", "upload_span", span(d.first_upload_at, d.last_upload_at));
		stat("Tools used", "replay", "Local replay only", true);

		const row = el("p", panel);
		row.setAttribute("class", "actions");
		const path = `/api/profiles/${enc(profile)}/sessions/${enc(id)}`;
		copy(row, "Copy ID", () => id);
		copy(row, "Copy curl", () => curl("GET", path));
		copy(row, "Copy MCP call", () => mcpCall("explore", { node: { id }, profile }));
		copy(row, "Copy MCP curl", () => mcpCurl("explore", { node: { id }, profile }));
		link(row, `#replay/${enc(id)}?profile=${enc(profile)}`, "Replay");
		// Queuing is fingerprinted (a repeat queues nothing) but it starts model work in the next batch, so it asks first.
		const queue = btn(row, "Queue consolidation", () => {
			queue.hidden = true;
			const ask = el("span", row);
			const question = el("span", ask, " The next consolidation batch reads this session's digests and may update memories from them. Queue it? ");
			question.setAttribute("tabindex", "-1");
			btn(ask, "Queue it", () => act(`${path}/consolidate`, "queue consolidation for this session", undefined,
				(r) => ({ text: num(r?.queued) > 0 ? "Queued. The next consolidation batch will read this session." : "Already queued. Nothing new was added." })));
			btn(ask, "Cancel", () => { ask.replaceChildren(); queue.hidden = false; queue.focus(); });
			question.focus();
		});

		el("h4", panel, "Details");
		facts(panel, [["Id", id], ["Client session", recorded(d.session)], ["Profile", profile], ["Client", recorded(d.client)],
			["Device", typeof d.device === "string" && d.device ? d.device : "Unknown (stored before devices were recorded)", !d.device],
			["Project", typeof d.project === "string" && d.project ? d.project : "No project linked", !d.project],
			["First upload", when(d.first_upload_at)], ["Last upload", when(d.last_upload_at)], ["Status", d.status === "active" ? "Active" : "Completed"]]);
		if (typeof d.project === "string" && d.project) link(el("p", panel), `#/memory/${enc(profile)}/${enc(d.project)}`, "Open the project record");

		el("h4", panel, "Summary");
		const outcomes: Record<string, number> = { commit: 0, pr: 0, test: 0 };
		for (const e of events) if (e?.kind === "outcome" && typeof e.detail?.outcome === "string" && e.detail.outcome in outcomes) outcomes[e.detail.outcome]!++;
		const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
		el("p", panel, `${plural(num(c.asks), "ask")}, ${plural(num(c.decisions), "decision")}, ${plural(num(c.corrections), "correction")} and ${plural(num(c.outcomes), "outcome")}`
			+ ` (${plural(outcomes.commit!, "commit")}, ${plural(outcomes.pr!, "PR")}, ${plural(outcomes.test!, "test")}${events.length < observations(c) ? " among the events shown" : ""}).`);
		note(panel, "Digests keep short excerpts in order, without times or tool calls. The full transcript stays on the device; Replay shows how to open it there.");

		el("h4", panel, "Produced from this session");
		const produced: J[] = Array.isArray(d.produced) ? d.produced : [];
		if (produced.length) {
			const ul = el("ul", panel);
			ul.setAttribute("class", "prefs");
			for (const p of produced) {
				const li = el("li", ul), kind = String(p.kind ?? "record");
				chip(li, kind, `chip chip-${kind.replace(/[^a-z_]/g, "")}`);
				link(li, `#/memory/${enc(profile)}/${enc(String(p.id))}`, String(p.title || p.id));
				el("span", li, p.via === "inferred_preference" ? " · preference inferred from this session" : " · cites this session as evidence").setAttribute("class", "na");
			}
		} else note(panel, "Nothing cites this session yet. Consolidation links memories and lessons to the sessions they came from.");

		el("h4", panel, `Observations (${events.length < observations(c) ? `first ${events.length} of ${observations(c)}` : events.length})`);
		const bar = el("div", panel);
		bar.setAttribute("class", "toolbar");
		bar.setAttribute("role", "group");
		bar.setAttribute("aria-label", "Show observations of kind");
		const list = el("ol", panel);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Observations");
		let kind = "all";
		const chips: Node[] = [];
		const draw = () => {
			list.replaceChildren();
			const shown = events.filter((e) => kind === "all" || e?.kind === kind);
			for (const e of shown) {
				const li = el("li", list), i = Number(e.i), k = String(e.kind ?? "event");
				chip(li, k, `chip kind-${k.replace(/[^a-z_]/g, "")}`);
				el("p", li, String(e.label ?? ""));
				const tags = el("p", li);
				tags.setAttribute("class", "na");
				const t = e.detail ?? {};
				el("span", tags, [`#${Number.isSafeInteger(i) ? i : "?"}`, t.part ? `part ${String(t.part)}` : "", t.pos ? `at byte ${String(t.pos)}` : "", t.outcome ? String(t.outcome) : ""].filter(Boolean).join(" · "));
				if (Number.isSafeInteger(i)) { el("span", tags, " · "); copy(tags, "Copy link", () => `${win.location.origin}${win.location.pathname}${href(profile, id, i)}`); }
				if (i === obs) { li.setAttribute("aria-current", "true"); li.setAttribute("class", "selected"); (li as J).scrollIntoView?.({ block: "nearest" }); }
			}
			if (!shown.length) el("li", list, kind === "all" ? "This session has no observations yet." : "No observations of this kind.");
		};
		for (const [k, label] of KINDS) {
			const b = el("button", bar, label);
			b.setAttribute("type", "button");
			b.setAttribute("aria-pressed", String(k === kind));
			b.addEventListener("click", () => { if (version !== am.pageVersion) return; kind = k; for (const x of chips) x.setAttribute("aria-pressed", String(x === b)); draw(); });
			chips.push(b);
		}
		draw();
	};

	const render = (root: Node, route: { id?: string; query: Record<string, string> }) => {
		const version = am.pageVersion, h = el("h2", root, "Sessions");
		intro(root, "Sessions", "session", "lists each agent session your devices uploaded digests for, newest first, with what it produced.");
		const { say } = pageStatus(root);
		// The shell has already refused an unknown or inactive ?profile, so `scope` is an active profile or null (All profiles).
		const scope = route.query.profile ?? null, listHash = scope ? `#sessions?profile=${enc(scope)}` : "#sessions";

		const form = el("form", root);
		form.setAttribute("role", "search");
		form.setAttribute("class", "toolbar");
		const q = am.input(form, "sess-q", "Search loaded sessions");
		q.setAttribute("type", "search");
		q.setAttribute("data-search", "");
		q.value = filters.q;
		const project = am.choose(form, "sess-project", "Project", [["", "All projects"], ...[...projects].map((p): [string, string] => [p, p])]);
		const client = am.choose(form, "sess-client", "Agent", [["", "All agents"], ["claude-code", "Claude Code"], ["codex", "Codex"]]);
		const status = am.choose(form, "sess-status", "Status", [["", "Any status"], ["active", "Active"], ["completed", "Completed"]]);
		project.value = filters.project; client.value = filters.client; status.value = filters.status;

		const split = el("div", root);
		split.setAttribute("class", "split");
		const left = el("section", split);
		left.setAttribute("aria-label", "Session list");
		const count = el("p", left);
		count.setAttribute("class", "na");
		const list = el("ul", left);
		list.setAttribute("class", "list");
		list.setAttribute("aria-label", "Sessions");
		list.setAttribute("data-list", "");
		const more = btn(left, "Load more", () => load(true));
		more.hidden = true;
		const panel = el("section", split);
		panel.setAttribute("class", "panel");
		panel.setAttribute("aria-label", "Session detail");

		let rows: J[] = [], cursor: string | null = null, request = 0, selected = route.id;
		const rowButtons = new Map<string, Node>();
		const idle = () => { panel.replaceChildren(); note(panel, "Select a session to see its details."); };
		const close = () => {
			const back = selected ? rowButtons.get(selected) : undefined;
			selected = undefined;
			for (const b of rowButtons.values()) b.setAttribute("aria-current", "false");
			win.history?.replaceState?.(null, "", listHash);
			idle();
			back?.focus();
		};

		const open = async (id: string, named: string | null, obs?: number) => {
			selected = id;
			for (const [rid, b] of rowButtons) b.setAttribute("aria-current", String(rid === id));
			panel.replaceChildren();
			loading(panel, 6);
			// A 404 means "not in this profile"; any other failure is reported, never read as "not there".
			const results = await am.eachProfile(named, (p) => read(p.name, id));
			if (version !== am.pageVersion || selected !== id) return;
			panel.replaceChildren();
			const hits = results.filter((r) => r.ok && valid(r.value)), failed = results.filter((r) => !r.ok && r.error.status !== 404);
			const bad = results.filter((r) => r.ok && !valid(r.value));
			if (hits.length === 1 && !failed.length && !bad.length) { detail(panel, hits[0]!.profile, (hits[0] as J).value, obs, version, close); return; }
			for (const r of failed) note(panel, `Could not read ${r.profile}: ${why((r as J).error)}`);
			for (const r of bad) note(panel, `${r.profile} sent a session without its events.`);
			if (hits.length || failed.length || bad.length) {
				// More than one profile has it, or one could not answer: the owner picks; nothing is guessed.
				el("p", panel, hits.length > 1 ? `Sessions with id ${id} exist in more than one profile. Choose one:` : hits.length ? "Choose the profile to open it in:" : "Choose a profile to try again:");
				const ul = el("ul", panel);
				for (const r of [...hits, ...failed]) link(el("li", ul), href(r.profile, id, obs), r.profile);
				return;
			}
			note(panel, named ? `No session with id ${id} in ${named}.` : `No session with id ${id} in any active profile.`);
		};

		const draw = () => {
			list.replaceChildren();
			rowButtons.clear();
			const needle = filters.q.toLowerCase();
			const shown = rows.filter((r) => !needle || [r.first_ask, r.session, r.id, r.project, r.device, r.profile].some((v) => typeof v === "string" && v.toLowerCase().includes(needle)));
			for (const r of shown) {
				const li = el("li", list), b = el("button", li);
				b.setAttribute("type", "button");
				b.setAttribute("class", "row");
				b.setAttribute("data-item", "");
				rowButtons.set(String(r.id), b);
				b.setAttribute("aria-current", String(r.id === selected));
				const top = el("span", b);
				chip(top, typeof r.project === "string" && r.project ? r.project : "no project");
				statusChip(top, r.status);
				el("strong", b, typeof r.first_ask === "string" && r.first_ask ? r.first_ask : "Untitled session");
				const meta = el("span", b, ` ${String(r.profile)} · ${agent(r)} · ${observations(r.counts)} observations · ${ago(r.last_upload_at)} · ${String(r.id)}`);
				meta.setAttribute("class", "na");
				b.addEventListener("click", () => {
					win.history?.replaceState?.(null, "", href(String(r.profile), String(r.id)));
					void open(String(r.id), String(r.profile));
				});
			}
			// The snapshot total covers every profile, so it is shown only for the unfiltered All-profiles list, and says so.
			const total = !scope && !filters.project && !filters.client && !filters.status && am.snapshot ? am.snapshot.counts.sessions : null;
			count.textContent = !rows.length ? "" : needle
				? `Showing ${shown.length} of ${rows.length} loaded, newest first. Search covers loaded sessions only.`
				: `Showing ${rows.length}${total !== null ? ` of ${total} across all profiles` : cursor ? " loaded; more are available" : ""}, newest first.`;
		};

		const load = async (next = false) => {
			const id = ++request, scoped = scope;
			if (!next) { rows = []; cursor = null; list.replaceChildren(); loading(list, 5); }
			more.hidden = true;
			say(next ? "Loading more sessions…" : "Loading sessions…");
			const qs = [["project", filters.project], ["client", filters.client], ["status", filters.status], ["cursor", next ? cursor ?? "" : ""]]
				.filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v!)}`).concat("limit=50").join("&");
			let r: J;
			try { r = await call(`${scoped ? `/api/profiles/${enc(scoped)}/sessions` : "/api/sessions"}?${qs}`); if (!Array.isArray(r?.rows)) throw new Error("the server sent no session list"); }
			catch (err) {
				if (version !== am.pageVersion || id !== request) return;
				if (!next) list.replaceChildren();
				say(`Could not load sessions: ${why(err)}`);
				more.textContent = "Try again"; more.hidden = !next;
				return;
			}
			if (version !== am.pageVersion || id !== request) return;
			// A one-profile page carries no profile field; the profile is the one asked for.
			const fresh = r.rows.filter((x: J) => x && typeof x.id === "string").map((x: J) => (scoped ? { ...x, profile: scoped } : x)).filter((x: J) => typeof x.profile === "string");
			rows = rows.concat(fresh);
			for (const x of fresh) if (typeof x.project === "string" && x.project && !projects.has(x.project)) { projects.add(x.project); el("option", project, x.project).setAttribute("value", x.project); }
			cursor = typeof r.next_cursor === "string" ? r.next_cursor : null;
			more.textContent = "Load more";
			more.hidden = !cursor;
			say("");
			if (!rows.length) {
				list.replaceChildren();
				if (filters.project || filters.client || filters.status) el("li", list, "No sessions match these filters.");
				else if (scope) empty(list, `No sessions in ${scope} yet. The capture hook uploads digests after each agent turn; backfill queues older transcripts.`, "agent-memory backfill --since 30d");
				else empty(list, "No sessions yet. The capture hook uploads digests after each agent turn; backfill queues transcripts from before you installed it.", "agent-memory backfill --since 30d");
			} else draw();
			if (!selected) idle();
		};

		form.addEventListener("submit", (e) => { e.preventDefault(); filters.q = q.value.trim(); draw(); });
		q.addEventListener("input", () => { filters.q = q.value.trim(); draw(); });
		for (const [s, k] of [[project, "project"], [client, "client"], [status, "status"]] as [Node, "project" | "client" | "status"][])
			s.addEventListener("change", () => { filters[k] = s.value; void load(); });

		void load();
		if (route.id) {
			const obs = route.query.obs !== undefined && /^\d+$/.test(route.query.obs) ? Number(route.query.obs) : undefined;
			void open(route.id, scope, obs);
		}
		return h;
	};

	am.tab({ id: "sessions", group: "work", label: "Sessions", key: "s", profiles: "any", count: (s) => s.counts.sessions, render });
}
