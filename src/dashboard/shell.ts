// The shell (section 15): builds `am`, the grouped nav, sign-in, and the router. Browser code, serialized into /app.js as
// the first part: it may use only its parameter and browser globals (type imports are erased). Sign-in follows settingsMain
// (ClerkJS 6 needs ClerkUI passed to load()). Every value from the API or the URL reaches the page through textContent.
import type { Am, Batch, Device, Failure, J, LegacyPage, Node, Profile, Route, TabDef } from "./am";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export function shell(win: any): void {
	const doc = win.document;
	const $ = (id: string) => doc.getElementById(id);
	const status = (t: string) => { $("status").textContent = t; };
	const clerk = () => win.Clerk;
	const token = async (): Promise<string> => await clerk().session.getToken();
	const call = async (path: string, method = "GET", data?: unknown) => {
		const headers: Record<string, string> = { authorization: `Bearer ${await token()}` };
		if (data !== undefined) headers["content-type"] = "application/json";
		const res = await win.fetch(path, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			const err: Failure = new Error(body.error?.message ?? (typeof body.error === "string" ? body.error : `HTTP ${res.status}`));
			Object.assign(err, { code: typeof body.error?.code === "string" ? body.error.code : undefined, status: res.status,
				reason: typeof body.error?.details?.reason === "string" ? body.error.details.reason : undefined });
			throw err;
		}
		return body;
	};

	const el = (tag: string, parent?: Node, text?: string): Node => {
		const e = doc.createElement(tag);
		if (text !== undefined) e.textContent = text;
		parent?.appendChild(e);
		return e;
	};
	const link = (parent: Node, href: string, text: string) => el("a", parent, text).setAttribute("href", href);
	const facts = (parent: Node, rows: [string, string, boolean?][]) => {
		const dl = el("dl", parent);
		for (const [k, v, na] of rows) { el("dt", dl, k); const dd = el("dd", dl, v); if (na) dd.setAttribute("class", "na"); }
	};
	const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");
	const state = (d: Device) => d.revoked_at ? "revoked" : !d.enabled ? "disabled" : d.expires_at && Date.parse(d.expires_at) <= Date.now() ? "expired" : "active";
	const users = (p: string) => am.devices.filter((d) => d.profiles.includes(p));
	const active = () => am.profiles.filter((p) => p.status === "active");
	const recorded = (v: unknown) => v === null || v === undefined || v === "" ? "Not recorded" : String(v);

	// The pages share one shape: a status line, every read guarded against navigation, and every write only on a click,
	// shown as the server answered. A write's outcome (and its Undo) stays with its page across navigation.
	const enc = encodeURIComponent;
	const why = (err: unknown) => {
		const e = err as Failure;
		return e.status === 401 || e.status === 403 ? "Access was refused. Sign in as the owner." : `${e.message}${e.code ? ` (${e.code})` : ""}`;
	};
	const live = (parent: Node) => {
		const p = el("p", parent);
		p.setAttribute("role", "status");
		p.setAttribute("aria-live", "polite");
		p.setAttribute("tabindex", "-1");
		return p;
	};
	const btn = (parent: Node, text: string, onClick: () => void, label?: string) => {
		const b = el("button", parent, text);
		b.setAttribute("type", "button");
		if (label) b.setAttribute("aria-label", label);
		b.addEventListener("click", onClick);
		am.pageButtons.push(b);
		return b;
	};
	const input = (parent: Node, id: string, label: string, tag = "input") => {
		const l = el("label", parent, label);
		l.setAttribute("for", id);
		l.setAttribute("class", "field");
		const i = el(tag, parent);
		i.setAttribute("id", id);
		return i;
	};
	const choose = (parent: Node, id: string, label: string, options: [string, string][]) => {
		const s = input(parent, id, label, "select");
		for (const [v, t] of options) el("option", s, t).setAttribute("value", v);
		s.value = options[0]?.[0] ?? "";
		return s;
	};
	const switcher = (view: Node, route: string, current: string) => {
		const nav = el("nav", view);
		nav.setAttribute("aria-label", "Profile");
		for (const q of active()) {
			const a = el("a", nav, q.name);
			a.setAttribute("href", `#/${route}/${enc(q.name)}`);
			if (q.name === current) a.setAttribute("aria-current", "page");
		}
	};
	const outcomes = new Map<string, { text: string; undo?: string }>(); // route -> last write outcome there
	let acting = false;
	/** One owner write: buttons stay disabled until it answers; its outcome is kept for its page, which reloads if still on screen. */
	const act = async (path: string | (() => Promise<J>), what: string, data: unknown, done: (r: J) => { text: string; undo?: string }) => {
		if (acting) return;
		acting = true;
		const route = win.location.hash, version = am.pageVersion;
		for (const b of am.pageButtons) b.disabled = true;
		if (am.pageMsg) am.pageMsg.textContent = `Working: ${what}…`;
		let out: { text: string; undo?: string };
		try { out = done(await (typeof path === "string" ? call(path, "POST", data) : path())); } catch (err) { out = { text: `Could not ${what}: ${why(err)}.` }; }
		acting = false;
		outcomes.set(route, out);
		if (version === am.pageVersion) { render(false); am.pageMsg?.focus(); }
	};
	const undoOf = (profile: string, r: J) => Number.isSafeInteger(r?.activity_id) && r.activity_id > 0 ? `/api/profiles/${enc(profile)}/activity/${r.activity_id}/undo` : undefined;
	/** The page's status line, showing the last outcome on this page and its Undo. */
	const pageStatus = (view: Node) => {
		const msg = am.pageMsg = live(view);
		const note = outcomes.get(win.location.hash);
		if (note?.undo) {
			const path = note.undo;
			btn(el("p", view), "Undo last change", () => act(path, "undo the last change", undefined, () => ({ text: "Undone." })));
		}
		const say = (t: string) => { msg.textContent = [note?.text, t].filter(Boolean).join(" "); };
		say("");
		return { msg, say };
	};
	const textBlock = (parent: Node, t: string) => el("div", parent, t).setAttribute("class", "text");
	const note = (parent: Node, t: string, cls = "na") => el("p", parent, t).setAttribute("class", cls);

	const tabs: TabDef[] = [];
	const tab = (def: TabDef) => { tabs.push(def); };
	const pages: Record<string, LegacyPage> = {};
	const GROUPS: [string, string][] = [["memory", "Memory"], ["work", "Work"], ["insight", "Insight"], ["system", "System"]];
	/**
	 * Registered tabs as grouped links after the page's static nav. With no tab registered (today) it adds nothing, so the
	 * static nav in DASHBOARD_HTML stays exactly as it is. `current` is the href to mark.
	 */
	let tabNav: Node | undefined;
	const nav = (current?: string) => {
		if (!tabs.length) return;
		const root = tabNav ??= el("span", $("nav"));
		root.replaceChildren();
		const group = (label: string | null, links: [string, string][]) => {
			const g = el("div", root);
			g.setAttribute("class", "navgroup");
			if (label) { g.setAttribute("role", "group"); g.setAttribute("aria-label", label); el("span", g, label).setAttribute("class", "navlabel"); }
			for (const [text, href] of links) {
				const a = el("a", g, text);
				a.setAttribute("href", href);
				if (href === current) a.setAttribute("aria-current", "page");
			}
		};
		group(null, tabs.filter((t) => t.group === null).map((t) => [t.label, `#${t.id}`]));
		for (const [id, label] of GROUPS) group(label, tabs.filter((t) => t.group === id).map((t) => [t.label, `#${t.id}`]));
	};

	const dec = (s?: string) => { if (s === undefined) return undefined; try { return decodeURIComponent(s); } catch { return s; } };
	const legacy = (view: Node, page: string, named?: string, id?: string): Node => {
		// The newer pages: the named active profile, or active work when none is named (asked for if work is not active); for a record, its id.
		const ok = active(), p = ok.find((x) => x.name === (named ?? "work"));
		if (p) return pages[page]!(view, p, id);
		const h = el("h2", view, named === undefined ? "Choose an active profile" : `No active profile named ${named}`);
		for (const q of ok) link(el("p", view), `#/${page === "memory" ? "memories" : page}/${enc(q.name)}`, q.name);
		if (!ok.length) el("p", view, "No active profiles available.");
		return h;
	};
	const render = (moveFocus: boolean) => {
		am.pageVersion++;
		am.pageButtons = [];
		am.pageMsg = undefined;
		const view = $("view");
		view.replaceChildren();
		am.shown = am.statusEl = undefined;
		const hash = win.location.hash ?? "";
		let h: Node | void;
		// A tab's deep link: #<tab>/<id>/<more>?<query>. Old #/ routes keep their pages below.
		const t = /^#([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash), def = t ? tabs.find((x) => x.id === t[1]) : undefined;
		if (t && def) {
			const rest = t[2] ? t[2].split("/").map((s) => dec(s)!) : [], query: Record<string, string> = {};
			for (const kv of (t[3] ?? "").split("&").filter(Boolean)) { const [k, v = ""] = kv.split("="); query[dec(k)!] = dec(v)!; }
			const route: Route = { tab: def.id, rest, query, hash, ...(rest[0] !== undefined ? { id: rest[0] } : {}) };
			h = def.render(view, route);
			nav(`#${def.id}`);
		} else {
			h = oldRoute(view, hash);
			nav(/^#\/[a-z]+/.exec(hash)?.[0]);
		}
		if (moveFocus && h) { h.setAttribute("tabindex", "-1"); h.focus(); }
	};
	/** The routes before the tabs, unchanged. */
	const oldRoute = (view: Node, hash: string): Node => {
		const m = /^#\/(profiles|about|work)\/([^/]+)$/.exec(hash);
		let name: string | undefined;
		try { name = m ? decodeURIComponent(m[2]!) : undefined; } catch { name = m?.[2]; }
		let h: Node;
		const pg = /^#\/(graph|memories|memory|map|draft|activity|timeline|journals|path|review|move|copy)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(hash);
		if (pg) h = legacy(view, pg[1] === "memory" && pg[3] === undefined ? "memories" : pg[1]!, dec(pg[2]), dec(pg[3]));
		else if (hash === "#/backups") h = pages.backups!(view);
		else if (hash === "#/routing") h = pages.routing!(view);
		else if (hash === "#/wipe" || hash.startsWith("#/wipe/")) h = pages.wipe!(view, hash === "#/wipe" ? undefined : dec(hash.slice(7)));
		else if (hash === "#/work" || m?.[1] === "work") {
			const ok = active(), p = name === undefined ? ok.find((x) => x.name === "work") : ok.find((x) => x.name === name);
			if (p) h = pages.work!(view, p);
			else {
				h = el("h2", view, name === undefined ? "Choose an active profile for Work" : `No active profile named ${name}`);
				for (const q of ok) link(el("p", view), `#/work/${encodeURIComponent(q.name)}`, q.name);
				if (!ok.length) el("p", view, "No active profiles available.");
			}
		} else if (hash === "#/about" || m?.[1] === "about") {
			// The page shows `me` unless a profile is named; only active profiles have an owner model to read.
			const ok = active(), p = name === undefined ? ok.find((x) => x.name === "me") ?? ok[0] : ok.find((x) => x.name === name);
			if (p) h = pages.about!(view, p);
			else { h = el("h2", view, name === undefined ? "No active profile yet" : `No active profile named ${name}`); link(el("p", view), "#/", "Back to the overview"); }
		} else {
			// The site root opens active work's graph (or asks for a profile); the profile cards are their own page.
			const p = name === undefined ? undefined : am.profiles.find((x) => x.name === name), work = active().find((x) => x.name === "work");
			if (name === undefined && hash === "#/profiles") h = pages.home!(view);
			else if (name === undefined && work) h = pages.graph!(view, work);
			else if (name === undefined) { h = el("h2", view, "Choose an active profile"); for (const q of active()) link(el("p", view), `#/graph/${enc(q.name)}`, q.name); link(el("p", view), "#/profiles", "Profiles"); }
			else if (p) h = pages.profile!(view, p);
			else { h = el("h2", view, `No profile named ${name}`); link(el("p", view), "#/profiles", "Back to the profiles"); }
		}
		return h;
	};

	const boot = async () => {
		nav();
		if (doc.readyState !== "complete") await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
		const ClerkUI = win.__internal_ClerkUICtor;
		if (!clerk() || !ClerkUI) {
			status(`Sign-in could not start: ${clerk() ? "the Clerk UI bundle" : "ClerkJS"} did not load. Check the network and the browser console for a blocked script.`);
			return;
		}
		try {
			await clerk().load({ ui: { ClerkUI }, telemetry: false });
		} catch (err) {
			status(`Sign-in could not start: ${(err as Error).message}`);
			return;
		}
		if (!clerk().user) {
			status("Sign in as the owner.");
			try { clerk().mountSignIn($("signin")); } catch (err) { status(`Sign-in could not start: ${(err as Error).message}`); }
			return;
		}
		status("Loading…");
		try {
			[am.profiles, am.devices] = await Promise.all([call("/api/profiles"), call("/api/devices")]);
		} catch (err) {
			status(`Could not load the dashboard: ${(err as Error).message}`);
			return;
		}
		// One profile's batch status failing to load marks only its own card.
		am.batches = new Map<string, Batch | Error>(await Promise.all(am.profiles.map(async (p: Profile) =>
			[p.name, await call(`/api/profiles/${encodeURIComponent(p.name)}/batch`).catch((err: Error) => err)] as [string, Batch | Error])));
		status("Signed in.");
		$("view").hidden = false;
		render(false);
		win.addEventListener("hashchange", () => render(true));
	};

	const am: Am = {
		win, doc, $, status, call,
		profiles: [], devices: [], batches: new Map(),
		el, link, facts, day, state, users, active, recorded, enc, why, live, btn, input, choose, switcher, act, undoOf, pageStatus, textBlock, note, outcomes,
		tabs, tab, pages, legacy, render, boot,
		pageVersion: 0, pageButtons: [], pageMsg: undefined, shown: undefined, statusEl: undefined,
		// Set by the part that owns each.
		drafts: null!, whatIf: null!, whatIfEdits: null!, draftFromWhatIf: null!, graphs: null!, graphOf: null!, pump: null!,
		moves: null!, sendMove: null!, moveView: null!, copyBack: null!, COPY_MAX: 0,
	};
	win.__am = am;
}
