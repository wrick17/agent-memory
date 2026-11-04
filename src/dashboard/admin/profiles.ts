// Admin: the profile cards (#/profiles) and one profile's page (#/profiles/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function profilesPages(am: Am): void {
	const { call, day, el, enc, facts, link, recorded, state, users, why } = am;
	const batchRow = (p: string): [string, string, boolean?] => {
		const b = am.batches.get(p);
		if (!b || b instanceof Error) return ["Daily batch", `Unavailable${b ? `: ${b.message}` : ""}`, true];
		const s = b.last_status;
		const last = s ? `last ${s.status === "stuck" ? "parked" : "skipped"} ${day(s.at)} (${s.reason ?? "no reason"})` : "no skip or park recorded";
		return ["Daily batch", `Last lease ${day(b.last_lease_at)}; ${last}`];
	};

	const home = (view: Node) => {
		const h = el("h2", view, "Profiles"), version = am.pageVersion;
		// Account-wide facts from bounded reads: the recovery status (with the last export) and the first page of the review list.
		const acct = el("dl", view);
		acct.setAttribute("aria-label", "Account summary");
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
			link(el("h3", card), `#/profiles/${encodeURIComponent(p.name)}`, p.name);
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
				} else say(sum, "Projects, people, decisions", "Counted once its graph is open in this tab", true);
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
		facts(view, [["Status", p.status], ["Created", day(p.created_at)]]);
		el("h3", view, "Devices that may use it");
		const can = users(p.name);
		if (can.length) {
			const table = el("table", view), head = el("tr", el("thead", table)), body = el("tbody", table);
			for (const c of ["Name", "Kind", "Scopes", "Default here", "Last used", "State"]) el("th", head, c).setAttribute("scope", "col");
			for (const d of can) {
				const tr = el("tr", body);
				[d.name, d.kind, d.scopes.join(", "), d.default_profile === p.name ? "yes" : "no", day(d.last_used_at), state(d)].forEach((t) => el("td", tr, t));
			}
		} else el("p", view, "No device may use this profile.");
		const more = el("p", view);
		link(more, "/settings", "Add or revoke devices in Settings");
		if (p.status === "active") link(el("p", view), `#/about/${encodeURIComponent(p.name)}`, "About you in this profile");
		if (p.status === "active") link(el("p", view), `#/work/${encodeURIComponent(p.name)}`, "Work in this profile");
		if (p.status === "active") for (const [r, t] of [["memories", "Memories"], ["map", "Map"], ["activity", "Activity and archive"], ["timeline", "Timeline"], ["journals", "Journals"], ["path", "Path finder"], ["review", "Review captured suggestions"], ["draft", "Write a memory"]]) link(el("p", view), `#/${r}/${encodeURIComponent(p.name)}`, `${t} in this profile`);
		return h;
	};
	am.pages.home = home;
	am.pages.profile = profilePage;
}
