// Admin: the profile cards (#/profiles) and one profile's page (#/profiles/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function profilesPages(am: Am): void {
	const { call, day, el, enc, facts, intro, link, recorded, state, users, why } = am;
	const chip = (parent: Node, text: string, cls = "") => el("span", parent, text).setAttribute("class", `chip${cls ? ` ${cls}` : ""}`);
	const batchRow = (p: string): [string, string, boolean?] => {
		const b = am.batches.get(p);
		if (!b || b instanceof Error) return ["Batch", `Unavailable${b ? `: ${b.message}` : ""}`, true];
		const s = b.last_status;
		const last = s ? `last ${s.status === "stuck" ? "parked" : "skipped"} ${day(s.at)} (${s.reason ?? "no reason"})` : "no skip or park recorded";
		return ["Batch", `Last lease ${day(b.last_lease_at)}; ${last}`];
	};

	const home = (view: Node) => {
		const h = el("h2", view, "Profiles"), version = am.pageVersion;
		intro(view, "Profiles", "profiles", "Each profile's status, devices, batch and recent changes. Open one for its devices and its pages.");
		// Account-wide facts from bounded reads: the recovery status (with the last export) and the first page of the review list.
		const acct = el("dl", view);
		acct.setAttribute("aria-label", "Account summary");
		acct.setAttribute("class", "panel");
		const say = (dl: Node, k: string, v: string, na = false) => { if (version !== am.pageVersion) return; el("dt", dl, k); const dd = el("dd", dl, v); if (na) dd.setAttribute("class", "na"); };
		void (async () => {
			const [rec, rev] = await Promise.allSettled([call("/api/recovery"), call("/api/review?limit=100")]);
			if (rec.status === "fulfilled") {
				say(acct, "Last backup", rec.value?.last_export?.at ? `Taken ${day(String(rec.value.last_export.at))}` : "No export recorded yet", !rec.value?.last_export);
				if (rec.value?.recovery) say(acct, "Recovery", `Open (${recorded(rec.value.recovery.state)}): the account is closed until it is opened or aborted in Backups`);
			} else say(acct, "Last backup", `Could not read: ${why(rec.reason)}`, true);
			if (rev.status === "fulfilled" && Array.isArray(rev.value?.items)) {
				const n = (k: string) => rev.value.items.filter((i: J) => i.kind === k).length, more = rev.value.next_after ? " or more" : "";
				say(acct, "Waiting in Review", `${n("migration")}${more} migrated records, ${n("collision")}${more} stopped moves`);
			} else say(acct, "Waiting in Review", `Could not read: ${rev.status === "rejected" ? why(rev.reason) : "no list"}`, true);
		})();
		const cards = el("div", view);
		cards.setAttribute("class", "cards");
		for (const p of am.profiles) {
			const card = el("section", cards);
			card.setAttribute("class", "card");
			const title = el("h3", card);
			link(title, `#/profiles/${encodeURIComponent(p.name)}`, p.name);
			el("span", title, " ");
			chip(title, p.status, p.status === "active" ? "c-ok" : "c-warn");
			const can = users(p.name), active = can.filter((d) => state(d) === "active");
			facts(card, [
				["Status", p.status],
				["Created", day(p.created_at)],
				["Active devices", String(active.length)],
				["Default for", `${can.filter((d) => d.default_profile === p.name).length} device(s)`],
				["Last use by its devices", day(can.map((d) => d.last_used_at ?? "").sort().pop() || null)],
				batchRow(p.name),
				["Storage used", "Not available: the server has no storage read", true],
			]);
			if (p.status !== "active") continue;
			// One count row for records, the board's open total and the newest changes; kinds only from a graph this tab already loaded.
			const sum = el("dl", card), base = `/api/profiles/${enc(p.name)}`;
			sum.setAttribute("aria-label", `${p.name} summary`);
			void (async () => {
				const [nodes, board, act] = await Promise.allSettled([call(`${base}/graph?part=nodes&limit=1`), call(`${base}/board?limit=1`), call(`${base}/activity?limit=3`)]);
				const failed = (r: PromiseSettledResult<J>) => r.status === "rejected" ? `Could not read: ${why(r.reason)}` : null;
				const total = nodes.status === "fulfilled" ? nodes.value?.total : undefined;
				say(sum, "Records", failed(nodes) ?? (typeof total === "number" ? total.toLocaleString("en") : "Too many to count in one read"), nodes.status === "rejected");
				const g = am.graphs.get(`${p.name}:${p.generation ?? ""}`), month = Date.now() - 30 * 86_400_000;
				if (g?.parts.nodes.done) {
					const all = [...g.nodes.values()], kind = (k: string) => all.filter((n) => n.kind === k);
					say(sum, "Projects, people, decisions", `${kind("project").length} projects, ${kind("person").length} people, ${kind("decision").filter((n) => n.updated && Date.parse(n.updated) >= month).length} decisions changed in the last 30 days`);
				} else say(sum, "Projects, people, decisions", "Shown after you open this profile’s graph", true);
				say(sum, "Open work", failed(board) ?? `${recorded(board.status === "fulfilled" ? board.value?.total : null)} items (uploaded work only)`, board.status === "rejected");
				const items: J[] = act.status === "fulfilled" && Array.isArray(act.value?.items) ? act.value.items : [];
				say(sum, "Recent changes", failed(act) ?? (items.map((a) => `${day(String(a.at))} ${recorded(a.op)} by ${recorded(a.actor)}`).join("; ") || "None"), act.status === "rejected");
			})();
		}
		if (!am.profiles.length) el("p", view, "No profiles yet.");
		return h;
	};

	const profilePage = (view: Node, p: Profile) => {
		const h = el("h2", view, `Profile: ${p.name}`);
		intro(view, p.name, "profiles", "This profile's devices and every page that reads or changes it.");
		facts(view, [["Status", p.status], ["Created", day(p.created_at)]]);
		const devs = el("section", view);
		devs.setAttribute("class", "panel");
		devs.setAttribute("aria-label", "Devices");
		el("h3", devs, "Devices that may use it");
		const can = users(p.name);
		if (can.length) {
			const table = el("table", devs), head = el("tr", el("thead", table)), body = el("tbody", table);
			for (const c of ["Name", "Kind", "Scopes", "Default here", "Last used", "State"]) el("th", head, c).setAttribute("scope", "col");
			for (const d of can) {
				const tr = el("tr", body);
				[d.name, d.kind, d.scopes.join(", "), d.default_profile === p.name ? "yes" : "no", day(d.last_used_at), state(d)].forEach((t) => el("td", tr, t));
			}
		} else el("p", devs, "No device may use this profile.");
		const more = el("p", devs);
		link(more, "#/devices", "Add or revoke devices");
		if (p.status !== "active") return h;
		// #/activity/NAME opens Audit with this profile chosen; the other old routes open their pages.
		const go = el("section", view);
		go.setAttribute("class", "panel");
		go.setAttribute("aria-label", "Pages for this profile");
		el("h3", go, "Pages for this profile");
		const ul = el("ul", go);
		for (const [r, t] of [["about", "About you"], ["work", "Work"], ["memories", "Memories"], ["map", "Map"], ["activity", "Audit and archive"], ["timeline", "Timeline"], ["journals", "Journals"], ["path", "Path finder"], ["review", "Review captured suggestions"], ["draft", "Write a memory"]]) link(el("li", ul), `#/${r}/${encodeURIComponent(p.name)}`, `${t} in this profile`);
		return h;
	};
	am.pages.home = home;
	am.pages.profile = profilePage;
}
