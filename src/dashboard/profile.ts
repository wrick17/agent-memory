// Profile tab (TG6): one project's profile, computed on request by GET /api/profiles/:p/projects/:key/profile, picked from
// GET /api/profiles/:p/projects. A project belongs to one profile, so the tab takes the shared choice as profiles: "one": the
// shell asks for a profile when the link has no ?profile and refuses an unknown or inactive one before render runs. Deep link:
// #profile/KEY?profile=P. When the reply's budget is exhausted the graph-derived lists are partial and the page says so; a
// failed read (a corpus read included) shows the failure, never an empty profile. Every value from the API reaches the page as text.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { ProjectProfile, ProjectSummary } from "../viewer/types";
import type { Am, Node } from "./am";

export function profileTab(am: Am): void {
	const cls = (e: Node, c: string) => e.setAttribute("class", c);
	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
	const last = (at: string | null) => (at ? am.day(at) : "unknown");
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	am.tab({ id: "profile", group: "insight", label: "Profile", key: "p", profiles: "one", render: (root, route) => {
		const version = am.pageVersion;
		const h = am.el("h2", root, "Profile");
		am.intro(root, "Project profile", "project_profile", "Pick a project to see its top concepts and files, its conventions, recurring errors and recent decisions. Click a concept to search memories for it.");

		const P = route.query.profile!; // the shell gate guarantees an active profile here
		const href = (key: string) => `#profile/${am.enc(key)}?profile=${am.enc(P)}`;
		const api = (key: string) => `/api/profiles/${am.enc(P)}/projects/${am.enc(key)}/profile`;

		const pick = am.el("div", root);
		cls(pick, "toolbar");
		const msg = am.live(root);
		const body = am.el("div", root);
		am.loading(body, 6);

		const paint = (p: ProjectProfile) => {
			body.replaceChildren();
			const head = am.el("section", body);
			cls(head, "panel");
			am.el("h3", head, p.name);
			cls(am.el("p", head, p.key), "mono muted");
			am.facts(head, [["Profile", P], ["Sessions", String(p.sessions)], ["Last activity", last(p.last_activity), p.last_activity === null]]);
			if (p.budget?.exhausted) {
				am.note(head, `Partial: the read limit stopped at ${p.budget.stopped ?? "a bound"}${p.budget.skipped ? ` with ${p.budget.skipped} more not read` : ""}. Concepts and recurring errors may be missing entries; sessions and last activity are complete.`, "warn");
				am.help(head, "budget");
			}
			const tools = am.el("div", head);
			cls(tools, "toolbar");
			const again = am.el("button", tools, "Refresh");
			again.setAttribute("type", "button");
			again.addEventListener("click", () => void open(p.key, false));
			const node = UUID.test(p.key) ? { id: p.key } : { key: p.key };
			const args = { node, depth: 1, profile: P };
			am.copy(tools, "Copy MCP call", () => am.mcpCall("explore", args)).setAttribute("aria-label", "Copy the explore MCP call for this project");
			am.help(tools, "mcp_call");
			am.copy(tools, "Copy MCP curl", () => am.mcpCurl("explore", args)).setAttribute("aria-label", "Copy the explore MCP call as a curl command");
			am.copy(tools, "Copy curl", () => am.curl("GET", api(p.key))).setAttribute("aria-label", "Copy a curl command for this project profile");
			am.help(tools, "curl");

			const grid = am.el("div", body);
			cls(grid, "cards");
			const box = (title: string, term?: string) => {
				const b = am.el("section", grid);
				cls(b, "card");
				const t = am.el("h3", b, title);
				if (term) am.help(t, term);
				return b;
			};
			const list = (parent: Node) => {
				const l = am.el("ul", parent);
				l.setAttribute("data-list", "");
				cls(l, "prefs");
				return l;
			};
			const bar = (parent: Node, n: number, top: number) => {
				const b = am.el("span", parent);
				cls(b, "bar");
				b.setAttribute("aria-hidden", "true");
				am.el("i", b).setAttribute("style", `width:${Math.round((n / Math.max(1, top)) * 100)}%`);
			};
			const partial = p.budget?.exhausted ? " in what was read" : "";

			const concepts = box("Top concepts");
			if (!p.concepts.length) am.note(concepts, `No linked concepts${partial}.`);
			else {
				const l = list(concepts), top = Math.max(...p.concepts.map((c) => c.count));
				for (const c of p.concepts) {
					const li = am.el("li", l);
					const a = am.el("a", li, c.name);
					a.setAttribute("href", `#memories?q=${am.enc(c.name)}&profile=${am.enc(P)}`);
					a.setAttribute("data-item", "");
					a.setAttribute("aria-label", `Search memories for ${c.name}`);
					am.el("span", li, " ");
					cls(am.el("span", li, c.kind), "chip");
					const row = am.el("div", li);
					bar(row, c.count, top);
					cls(am.el("span", row, plural(c.count, "linking record")), "muted");
				}
			}

			const files = box("Top files", "corpus");
			if (!p.files.length) {
				const corpus = am.snapshot?.flags.find((f) => f.id === "corpus")?.state;
				am.note(files, P === "me" ? "The me profile has no corpus, so it lists no files."
					: corpus === "on" ? "No corpus commits in the last year name a file for this project. Only a github:org/repo project key matches corpus commits."
						: corpus ? "The corpus is off, so no file paths are read and none are listed."
							: "File paths come from corpus commits, which are read only while the corpus is on. None are listed for this project.");
			} else {
				const l = list(files), top = Math.max(...p.files.map((f) => f.count));
				for (const f of p.files) {
					const li = am.el("li", l);
					li.setAttribute("tabindex", "0");
					li.setAttribute("data-item", "");
					cls(am.el("div", li, f.path), "mono");
					const row = am.el("div", li);
					bar(row, f.count, top);
					cls(am.el("span", row, plural(f.count, "commit")), "muted");
				}
			}

			const conv = box("Conventions", "origin");
			if (!p.conventions.length) am.note(conv, "No rules or preferences scoped or linked to this project.");
			else {
				const l = list(conv);
				for (const c of p.conventions) {
					const li = am.el("li", l);
					cls(am.el("span", li, c.kind), `chip ${c.kind === "rule" ? "c-teal" : "c-blue"}`);
					cls(am.el("span", li, c.origin), "chip");
					const a = am.el("a", li, c.name);
					a.setAttribute("href", `#lessons/${am.enc(c.id)}?profile=${am.enc(P)}`);
					a.setAttribute("data-item", "");
				}
			}

			const errs = box("Recurring errors");
			if (!p.recurring_errors.length) am.note(errs, `No concept has two or more corrections${partial}.`);
			else {
				const l = list(errs);
				for (const e of p.recurring_errors) {
					const li = am.el("li", l);
					li.setAttribute("tabindex", "0");
					li.setAttribute("data-item", "");
					am.el("strong", li, e.entity).setAttribute("style", "font-family:var(--serif)");
					cls(am.el("span", li, ` · ${plural(e.count, "correction")}`), "muted");
					// Each correction's id is the session it came from.
					const ul = am.el("ul", li);
					for (const c of e.corrections) {
						const a = am.el("a", am.el("li", ul), c.text);
						a.setAttribute("href", `#sessions/${am.enc(c.id)}?profile=${am.enc(P)}`);
					}
					if (e.corrections.length < e.count) cls(am.el("p", li, `${plural(e.count, "correction")}, ${plural(e.corrections.length, "distinct text")} shown.`), "muted");
				}
			}

			const hi = box("Recent highlights");
			cls(am.el("p", hi, "Decisions recorded in the last 30 days."), "muted");
			if (!p.highlights.length) am.note(hi, "No decisions in the last 30 days.");
			else {
				const l = list(hi);
				for (const d of p.highlights) {
					const li = am.el("li", l);
					const a = am.el("a", li, d.title);
					a.setAttribute("href", `#memories/${am.enc(d.id)}?profile=${am.enc(P)}`);
					a.setAttribute("data-item", "");
					cls(am.el("div", li, am.day(d.at)), "muted");
				}
			}
		};

		const open = async (key: string, first: boolean) => {
			msg.textContent = first ? "" : "Refreshing…";
			try {
				const p = (await am.call(api(key))) as ProjectProfile;
				if (version !== am.pageVersion) return;
				paint(p);
				msg.textContent = first ? "" : `Updated at ${new Date().toISOString().slice(11, 16)} UTC.`;
			} catch (err) {
				if (version !== am.pageVersion) return;
				const e = err as { status?: number };
				const text = e.status === 404 ? `No active project with the key ${key} in ${P}.` : `Could not load the project profile: ${am.why(err)}.`;
				if (first) { body.replaceChildren(); am.note(body, text, "danger"); } else msg.textContent = `${text} The profile shown is from the last load.`;
			}
		};

		void (async () => {
			let all: ProjectSummary[];
			try { all = ((await am.call(`/api/profiles/${am.enc(P)}/projects`)) as { projects: ProjectSummary[] }).projects; } catch (err) {
				if (version !== am.pageVersion) return;
				body.replaceChildren();
				am.note(body, `Could not load the projects in ${P}: ${am.why(err)}.`, "danger");
				return;
			}
			if (version !== am.pageVersion) return;
			if (!all.length && route.id === undefined) {
				body.replaceChildren();
				am.empty(body, `No projects in ${P} yet. A project appears when an uploaded session digest names its repository.`, "agent-memory backfill");
				return;
			}
			// The server lists the most recent first, with unknown last activity after every known one.
			const key = route.id ?? all[0]!.key;
			if (route.id === undefined) { try { am.win.history?.replaceState?.(null, "", href(key)); } catch { /* the address stays #profile */ } }

			const sel = am.input(pick, "profile-project", "Project", "select");
			for (const [i, x] of all.entries()) am.el("option", sel, `${x.name} · ${plural(x.sessions, "session")} · last activity ${last(x.last_activity)}`).setAttribute("value", String(i));
			const at = all.findIndex((x) => x.key === key);
			if (at < 0) am.el("option", sel, `${key} (not in the project list)`).setAttribute("value", "");
			sel.value = at < 0 ? "" : String(at);
			sel.addEventListener("change", () => { const x = all[Number(sel.value)]; if (sel.value !== "" && x) am.win.location.hash = href(x.key); });
			cls(am.el("span", pick, `${plural(all.length, "project")} in ${P}.`), "muted");
			await open(key, true);
		})();
		return h;
	} });
}
