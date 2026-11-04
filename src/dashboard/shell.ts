// The shell (section 15): builds `am`, the header (date, glossary, theme, narrow menu), the grouped nav, keys, sign-in and the
// router. Browser code, serialized into /app.js as the first part: it may use only its parameter and browser globals (type
// imports are erased). Sign-in follows settingsMain (ClerkJS 6 needs ClerkUI passed to load()). Every value from the API or
// the URL reaches the page through textContent. It shows only real pages and no live data: no counts, versions or feature states.
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

	// Per-viewer conveniences (the theme) in localStorage. A blocked or empty store just means the default.
	const saved = (k: string): string | null => { try { return win.localStorage?.getItem(k) ?? null; } catch { return null; } };
	const save = (k: string, v: string) => { try { win.localStorage?.setItem(k, v); } catch { /* the default applies next time */ } };
	const cls = (e: Node, c: string) => e.setAttribute("class", c);
	/** A header or panel button: never in am.pageButtons, so page writes don't disable it. */
	const control = (parent: Node, text: string, onClick: () => void, label?: string): J => {
		const b = el("button", parent, text);
		b.setAttribute("type", "button");
		if (label) b.setAttribute("aria-label", label);
		b.addEventListener("click", onClick);
		return b;
	};

	// Shared pieces for pages and tabs.
	let tips: [Node, Node][] = [], tipN = 0; // open glossary tips, closed by Esc and on navigation
	const closeTips = () => {
		const had = tips.length > 0;
		for (const [b, t] of tips) { t.hidden = true; b.setAttribute("aria-expanded", "false"); }
		tips = [];
		return had;
	};
	const help = (parent: Node, term: string) => {
		const g = am.glossary[term];
		if (!g) return;
		const wrap = el("span", parent);
		cls(wrap, "tipwrap");
		const b = el("button", wrap, "?"), tip = el("span", wrap, g.text), id = `tip-${++tipN}`;
		b.setAttribute("type", "button");
		cls(b, "help");
		b.setAttribute("aria-label", `What is ${g.term}?`);
		b.setAttribute("title", g.text);
		b.setAttribute("aria-expanded", "false");
		b.setAttribute("aria-controls", id);
		tip.setAttribute("id", id);
		tip.setAttribute("role", "note");
		cls(tip, "tip");
		tip.hidden = true;
		b.addEventListener("click", () => {
			const open = tip.hidden;
			closeTips();
			if (open) { tip.hidden = false; b.setAttribute("aria-expanded", "true"); tips.push([b, tip]); }
		});
	};
	const intro = (root: Node, label: string, term: string, text: string) => {
		const p = el("p", root);
		cls(p, "intro");
		el("strong", p, label);
		help(p, term);
		el("span", p, ` ${text}`);
	};
	const copy = (parent: Node, label: string, text: () => string) => {
		const b = el("button", parent, label);
		b.setAttribute("type", "button");
		b.addEventListener("click", () => {
			const done = (t: string) => { b.textContent = t; setTimeout(() => { b.textContent = label; }, 2000); };
			const clip = win.navigator?.clipboard;
			if (!clip) { done("Copy failed"); return; }
			void clip.writeText(text()).then(() => done("Copied"), () => done("Copy failed"));
		});
		return b;
	};
	// Single quotes keep the shell from expanding anything in the body; the token stays a variable the reader sets. /api/* is
	// owner only and refuses device tokens, so its commands name an owner token variable; /v1 and /mcp take a device token.
	const curl = (method: string, path: string, body?: unknown) => [`curl -sS -X ${method} '${win.location.origin}${path}'`,
		`-H "Authorization: Bearer ${path.startsWith("/api/") ? "$AGENT_MEMORY_OWNER_TOKEN" : "$AGENT_MEMORY_TOKEN"}"`,
		...(body === undefined ? [] : [`-H 'content-type: application/json'`, `--data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`])].join(" \\\n  ");
	const mcpCall = (tool: string, args: Record<string, unknown>) => JSON.stringify({ name: tool, arguments: args }, null, 2);
	// The stateless MCP request form the Worker serves (test/mcp-auth.test.ts "modern"): protocol metadata in _meta and the mcp-* headers.
	const MCP_VERSION = "2026-07-28";
	const mcpCurl = (tool: string, args: Record<string, unknown>) => `${curl("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call",
		params: { name: tool, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_VERSION, "io.modelcontextprotocol/clientInfo": { name: "curl", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } })} \\
  -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: ${MCP_VERSION}' -H 'mcp-method: tools/call' -H 'mcp-name: ${tool.replace(/[^A-Za-z0-9_.-]/g, "")}'`;
	const empty = (root: Node, text: string, command?: string) => {
		const box = el("div", root);
		cls(box, "empty");
		el("p", box, text);
		if (command) { el("code", box, command); copy(box, "Copy", () => command); }
	};
	const loading = (root: Node, rows = 3) => {
		const box = el("div", root);
		cls(box, "loading");
		box.setAttribute("aria-busy", "true");
		cls(el("span", box, "Loading…"), "vh");
		for (let i = 0; i < rows; i++) cls(el("div", box), "skeleton");
		return box;
	};

	const tabs: TabDef[] = [];
	const tab = (def: TabDef) => { tabs.push(def); };
	const pages: Record<string, LegacyPage> = {};

	// ---- Header, glossary panel, footer ----
	const ui: { glossary?: J; theme?: J; menu?: J } = {};
	const theme = (): string => doc.documentElement?.getAttribute?.("data-theme") ?? (win.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
	const paintTheme = () => {
		if (!ui.theme) return;
		const next = theme() === "dark" ? "light" : "dark";
		ui.theme.textContent = next === "dark" ? "Dark" : "Light";
		ui.theme.setAttribute("aria-label", `Use the ${next} theme`);
	};
	const stored = saved("am.theme");
	if (stored === "light" || stored === "dark") doc.documentElement?.setAttribute?.("data-theme", stored);
	let returnTo: J; // the control that opened the glossary
	const shut = (d: J) => {
		if (typeof d.close === "function") d.close(); // fires "close", which returns focus
		else { d.hidden = true; returnTo?.focus?.(); }
	};
	const isOpen = (d: J) => typeof d.showModal === "function" ? d.open === true : d.hidden === false;
	const openGlossary = () => {
		const d = $("gloss");
		d.replaceChildren();
		const head = el("div", d);
		cls(head, "dhead");
		el("h2", head, "Glossary").setAttribute("id", "gloss-title");
		control(head, "Close", () => shut(d));
		const dl = el("dl", d);
		for (const [k, g] of Object.entries(am.glossary).sort((a, b) => a[1].term.localeCompare(b[1].term))) { el("dt", dl, g.term).setAttribute("id", `g-${k}`); el("dd", dl, g.text); }
		el("h3", d, "Keys");
		const keys = el("dl", d);
		for (const [k, t] of [["/", "Focus this page's search box."], ["g, then a letter", `Open a page: ${entries().filter((x) => x.key).map((x) => `${x.key} ${x.label}`).join(", ")}.`],
			["?", "Open this glossary."], ["Esc", "Close a tip, panel or menu."], ["Up, Down, Home, End", "Move through a list."]]) { el("dt", keys, k); el("dd", keys, t); }
		returnTo = ui.glossary;
		if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else { d.hidden = false; d.querySelector?.("button")?.focus(); }
	};
	const menuOpen = () => $("nav").getAttribute?.("class") === "open";
	const setMenu = (open: boolean) => { cls($("nav"), open ? "open" : ""); ui.menu?.setAttribute("aria-expanded", String(open)); };
	const header = () => {
		const tools = $("tools");
		tools.replaceChildren();
		ui.menu = control(tools, "Menu", () => setMenu(!menuOpen()));
		ui.menu.setAttribute("id", "menu");
		ui.menu.setAttribute("aria-controls", "nav");
		ui.menu.setAttribute("aria-expanded", "false");
		cls(el("span", tools, new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })), "date");
		ui.glossary = control(tools, "?", openGlossary, "Glossary");
		ui.glossary.setAttribute("aria-haspopup", "dialog");
		ui.glossary.setAttribute("aria-keyshortcuts", "?");
		ui.theme = control(tools, "", () => {
			const next = theme() === "dark" ? "light" : "dark";
			doc.documentElement?.setAttribute?.("data-theme", next);
			save("am.theme", next);
			paintTheme();
			// The graph canvas reads its colours from the computed background on resize; this makes it read them again.
			try { win.dispatchEvent?.(new win.Event("resize")); } catch { /* no canvas to update */ }
		});
		paintTheme();
		win.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", paintTheme);
		$("gloss").addEventListener("close", () => returnTo?.focus?.());
		el("span", $("foot"), "Keys: / search · g then a letter opens a page · ? glossary · Esc closes");
	};

	// ---- Navigation: today's pages, grouped, then any registered tab in its group; Admin holds the other pages ----
	type Entry = { id: string; group: string | null; label: string; key: string; href: string };
	// The real pages each group has today. A registered tab with the same id takes its entry's place.
	const PAGES: Entry[] = [{ id: "graph", group: "memory", label: "Graph", key: "g", href: "#/" }, { id: "memories", group: "memory", label: "Memories", key: "m", href: "#/memories" },
		{ id: "audit", group: "system", label: "Activity", key: "u", href: "#/activity" }];
	const ADMIN: [string, string][] = [["Write", "#/draft"], ["Timeline", "#/timeline"], ["Journals", "#/journals"], ["Paths", "#/path"], ["Work", "#/work"], ["About you", "#/about"],
		["Review", "#/review"], ["Backups", "#/backups"], ["Profiles", "#/profiles"], ["Routing", "#/routing"], ["Moves", "#/move"], ["Wipe", "#/wipe"], ["Settings", "/settings"]];
	const GROUPS: [string, string][] = [["memory", "Memory"], ["work", "Work"], ["insight", "Insight"], ["system", "System"]];
	const entries = (): Entry[] => [...PAGES.filter((p) => !tabs.some((t) => t.id === p.id)), ...tabs.map((t) => ({ ...t, href: `#${t.id}` }))];
	/** The grouped nav; `current` is the href to mark. Groups with no entry are left out. */
	const nav = (current?: string) => {
		const root = $("nav");
		root.replaceChildren();
		const all = entries();
		const group = (label: string | null, list: Entry[]) => {
			if (!list.length) return;
			const g = el("div", root);
			cls(g, "navgroup");
			if (label) { g.setAttribute("role", "group"); g.setAttribute("aria-label", label); cls(el("span", g, label), "navlabel"); }
			for (const e of list) {
				const a = el("a", g, e.label);
				a.setAttribute("href", e.href);
				a.setAttribute("aria-keyshortcuts", `g ${e.key}`);
				if (e.href === current) a.setAttribute("aria-current", "page");
			}
		};
		group(null, all.filter((e) => e.group === null));
		for (const [id, label] of GROUPS) group(label, all.filter((e) => e.group === id));
		const d = el("details", root);
		cls(d, ADMIN.some(([, href]) => href === current) ? "navgroup current" : "navgroup");
		el("summary", d, "Admin");
		const box = el("div", d);
		cls(box, "adminlinks");
		box.setAttribute("role", "group");
		box.setAttribute("aria-label", "Admin");
		for (const [text, href] of ADMIN) {
			const a = el("a", box, text);
			a.setAttribute("href", href);
			if (href === current) a.setAttribute("aria-current", "page");
		}
	};

	// ---- Keys (see am.ts) ----
	const visible = (e: J) => !!e && !e.disabled && !e.hidden && (typeof e.getClientRects !== "function" || e.getClientRects().length > 0);
	const closeAll = () => {
		let closed = closeTips();
		const d = $("gloss");
		if (isOpen(d)) { shut(d); closed = true; }
		if (menuOpen()) { setMenu(false); ui.menu?.focus(); closed = true; }
		const adm = doc.querySelector?.("#nav details[open]");
		if (adm) { adm.open = false; adm.querySelector("summary")?.focus(); closed = true; }
		if (!closed) { const c = $("view").querySelector?.("[data-close]"); if (visible(c)) { c.click(); closed = true; } }
		return closed;
	};
	let gAt = 0;
	const onKey = (e: J) => {
		if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
		const t = e.target, view = $("view");
		if (e.key === "Escape") { if (closeAll()) e.preventDefault(); return; }
		if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? "") || t.isContentEditable === true)) return;
		if (gAt && Date.now() - gAt < 1500) {
			gAt = 0;
			const to = entries().find((x) => x.key === String(e.key).toLowerCase());
			if (to) { e.preventDefault(); win.location.hash = to.href; }
			return;
		}
		gAt = 0;
		if (e.key === "g") { gAt = Date.now(); return; }
		if (e.key === "/") {
			const s = view.querySelector?.("[data-search]") ?? view.querySelector?.('input[type="search"]');
			if (visible(s)) { e.preventDefault(); s.focus(); }
			return;
		}
		if (e.key === "?") { e.preventDefault(); openGlossary(); return; }
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
			const list = t?.closest?.("[data-list]");
			if (!list) return;
			const items = [...list.querySelectorAll("[data-item]")].filter(visible), at = items.indexOf(t.closest("[data-item]"));
			const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
			if (items[next]) { e.preventDefault(); items[next].focus(); }
			return;
		}
		const name = e.key === " " ? "Space" : e.key;
		if (name !== "Space" && name !== "ArrowLeft" && name !== "ArrowRight") return;
		if (name === "Space" && t?.closest?.("button, a, summary, [role=button]")) return; // Space activates the focused control
		const b = view.querySelector?.(`[data-key="${name}"]`);
		if (visible(b)) { e.preventDefault(); b.click(); }
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
	// Deep links in the newer form open today's pages until their tabs register: #memories(/ID), #graph(/ID) and #audit, each
	// with an optional ?profile=NAME (else work, as on the old routes). A registered tab with the same id takes the link over.
	const ALIASES: Record<string, [string, string, string]> = { memories: ["memories", "memory", "#/memories"], graph: ["graph", "graph", "#/"], audit: ["activity", "activity", "#/activity"] };
	// The nav entry an old route belongs to: #/memory/... is Memories, #/graph/... is Graph, #/copy/... is Moves.
	const OWNER: Record<string, string> = { "": "#/", graph: "#/", memory: "#/memories", copy: "#/move" };
	const render = (moveFocus: boolean) => {
		am.pageVersion++;
		am.pageButtons = [];
		am.pageMsg = undefined;
		const view = $("view");
		view.replaceChildren();
		am.shown = am.statusEl = undefined;
		closeTips();
		setMenu(false);
		const hash = win.location.hash ?? "";
		let h: Node | void;
		// A tab's deep link: #<tab>/<id>/<more>?<query>. Old #/ routes keep their pages below.
		const t = /^#([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash), def = t ? tabs.find((x) => x.id === t[1]) : undefined, alias = t ? ALIASES[t[1]!] : undefined;
		if (t && (def || alias)) {
			const rest = t[2] ? t[2].split("/").map((s) => dec(s)!) : [], query: Record<string, string> = {};
			for (const kv of (t[3] ?? "").split("&").filter(Boolean)) { const [k, v = ""] = kv.split("="); query[dec(k)!] = dec(v)!; }
			if (def) {
				const route: Route = { tab: def.id, rest, query, hash, ...(rest[0] !== undefined ? { id: rest[0] } : {}) };
				h = def.render(view, route);
				nav(`#${def.id}`);
			} else {
				h = legacy(view, rest[0] === undefined ? alias![0] : alias![1], query.profile, rest[0]);
				nav(alias![2]);
			}
		} else {
			h = oldRoute(view, hash);
			const seg = /^#\/([a-z]*)/.exec(hash)?.[1] ?? "";
			nav(OWNER[seg] ?? `#/${seg}`);
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
		header();
		nav();
		doc.addEventListener?.("keydown", onKey);
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
		glossary: {}, help, intro, copy, curl, mcpCall, mcpCurl, empty, loading,
		tabs, tab, pages, legacy, render, boot,
		pageVersion: 0, pageButtons: [], pageMsg: undefined, shown: undefined, statusEl: undefined,
		// Set by the part that owns each.
		drafts: null!, whatIf: null!, whatIfEdits: null!, draftFromWhatIf: null!, graphs: null!, graphOf: null!, pump: null!,
		moves: null!, sendMove: null!, moveView: null!, copyBack: null!, COPY_MAX: 0,
	};
	win.__am = am;
}
