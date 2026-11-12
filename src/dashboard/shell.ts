// The shell (section 15): builds `am`, the header (date, glossary, theme, narrow menu), the grouped nav, keys, sign-in and the
// router. Browser code, serialized into /app.js as the first part: it may use only its parameter and browser globals (type
// imports are erased). Sign-in passes ClerkUI to load() (ClerkJS 6 needs it). Every value from the API or
// the URL reaches the page through textContent. It shows only real pages and no live data: no counts, versions or feature states.
import type { Am, Batch, Device, Failure, J, LegacyPage, Node, Profile, ProfileResult, Route, TabDef } from "./am";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export function shell(win: any): void {
	const doc = win.document;
	const $ = (id: string) => doc.getElementById(id);
	const status = (t: string) => { $("status").textContent = t; };
	const clerk = () => win.Clerk;
	// fresh: a newly minted token. The live stream ends at its token's exp, and Clerk's cached token can be seconds from it (or,
	// at page load, already past it but inside the server's skew), which ended every stream right after it opened.
	const token = async (fresh = false): Promise<string> => await clerk().session.getToken(fresh ? { skipCache: true } : undefined);
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
	// Ids, generations and other machine values wait behind "Details", so a tool reads in plain words first.
	const tech = (k: string, v: string) => /\bid\b|generation/i.test(k) || /^[0-9a-f][0-9a-f-]{11,}$/i.test(v.trim()) || /^[A-Za-z0-9_-]{20,}$/.test(v.trim());
	const facts = (parent: Node, rows: [string, string, boolean?][]) => {
		const dl = el("dl", parent), more = rows.filter(([k, v]) => tech(k, v));
		for (const [k, v, na] of rows) { if (tech(k, v)) continue; el("dt", dl, k); const dd = el("dd", dl, v); if (na) dd.setAttribute("class", "na"); }
		if (!more.length) return;
		const d = el("details", parent);
		el("summary", d, "Details");
		const dl2 = el("dl", d);
		for (const [k, v] of more) { el("dt", dl2, k); el("dd", dl2, v).setAttribute("class", "mono"); }
	};
	const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
	const day = (iso: string | null) => (iso ? (ISO.test(iso) && am.when ? am.when(iso).text : iso.slice(0, 10)) : "never");
	const state = (d: Device) => d.revoked_at ? "revoked" : !d.enabled ? "disabled" : d.expires_at && Date.parse(d.expires_at) <= Date.now() ? "expired" : "active";
	const users = (p: string) => am.devices.filter((d) => d.profiles.includes(p));
	const active = () => am.profiles.filter((p) => p.status === "active");
	// A stored timestamp reads as "Today 03:17" in the owner tools too; anything else as it is.
	const recorded = (v: unknown) => v === null || v === undefined || v === "" ? "Not recorded" : typeof v === "string" && ISO.test(v) && am.when ? am.when(v).text : String(v);

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
	let tips: [Node, Node][] = []; // open glossary tips, closed by Esc and on navigation
	const closeTips = () => {
		const had = tips.length > 0;
		for (const [b, t] of tips) { t.hidden = true; b.setAttribute("aria-expanded", "false"); }
		tips = [];
		return had;
	};
	// The owner asked for no "?" boxes: a term's explanation is a native tooltip on its label, nothing more.
	const help = (parent: Node, term: string) => { const g = am.glossary[term]; if (g) parent.setAttribute("title", g.text); };
	/** A tool page's one-line purpose, short and quiet. */
	const intro = (root: Node, _label: string, _term: string, text: string) => {
		const p = el("p", root, text.replace(/^[a-z]/, (c) => c.toUpperCase()));
		cls(p, "intro");
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

	/**
	 * Infinite scroll: draws `items` `step` at a time as a sentinel row near the list's end comes into view (600px ahead, so
	 * keyboard and wheel scrolling never wait). `key` remembers how far a list got, so a re-render (opening or closing an item)
	 * draws as many rows again and the page keeps its scroll position. Without IntersectionObserver it falls back to a button.
	 */
	const reached = new Map<string, number>();
	/** Page cleanup: observers and window listeners a page starts, stopped before the next page replaces it. */
	const leaving = new Set<() => void>();
	const onLeave = (f: () => void) => { leaving.add(f); return () => { leaving.delete(f); f(); }; };
	/** An IntersectionObserver that stops when the page is left (or when `stop` is called first). */
	const observe = (target: Node, onSeen: (stop: () => void) => void, margin: string) => {
		const IO = win.IntersectionObserver;
		if (typeof IO !== "function") return null;
		const io = new IO((entries: J[]) => { if (entries.some((e) => e.isIntersecting)) onSeen(stop); }, { rootMargin: margin });
		const stop = onLeave(() => io.disconnect());
		io.observe(target);
		return stop;
	};
	const pager = <T,>(holder: Node, items: T[], draw: (it: T) => void, step = 25, key?: string) => {
		(holder as J).__stop?.();
		holder.replaceChildren();
		let n = 0;
		const upto = (m: number) => { for (const end = Math.min(items.length, m); n < end; n++) draw(items[n]!); if (key) reached.set(key, Math.max(reached.get(key) ?? 0, n)); };
		upto(Math.max(step, key ? reached.get(key) ?? 0 : 0));
		if (n >= items.length) return;
		if (typeof win.IntersectionObserver === "function") {
			const row = el("div", holder);
			cls(row, "sentinel");
			row.setAttribute("role", "status");
			el("span", row, "Loading more…");
			(holder as J).__stop = observe(row, (stop) => { upto(n + step); if (n >= items.length) { stop(); (row as J).remove?.(); } }, "600px 0px");
			return;
		}
		const b = el("button", holder);
		b.setAttribute("type", "button");
		const label = () => { b.hidden = n >= items.length; b.textContent = `Show ${Math.min(step, items.length - n)} more`; };
		b.addEventListener("click", () => { upto(n + step); label(); });
		label();
	};
	/** A "load the next page" button that presses itself when it scrolls into view (an API cursor list); stays a button without IntersectionObserver. */
	const autoMore = (b: Node) => {
		if (observe(b, (stop) => { const x = b as J; if (x.isConnected === false) { stop(); return; } if (!x.hidden && !x.disabled) x.click(); }, "400px 0px")) cls(b, "auto-more");
	};

	const tabs: TabDef[] = [];
	const tab = (def: TabDef) => { tabs.push(def); };
	const pages: Record<string, LegacyPage> = {};

	// ---- Header: the nav, one search box, the profile choice, Settings and the theme ----
	const ui: { theme?: J; profile?: J; navProfile?: J; search?: J; settings?: J; sync?: J } = {};
	const theme = (): string => doc.documentElement?.getAttribute?.("data-theme") ?? (win.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
	const paintTheme = () => {
		if (!ui.theme) return;
		const next = theme() === "dark" ? "light" : "dark";
		ui.theme.textContent = next === "dark" ? "☾" : "☀";
		ui.theme.setAttribute("aria-label", `Use the ${next} theme`);
		ui.theme.setAttribute("title", `Use the ${next} theme`);
	};
	const stored = saved("am.theme");
	if (stored === "light" || stored === "dark") doc.documentElement?.setAttribute?.("data-theme", stored);
	// Popovers (the gear menu, search results, the phone menu) each register how to close; Esc and navigation close them all.
	const closers: (() => boolean)[] = [];
	const closePopovers = () => closers.reduce((any, f) => f() || any, false);
	doc.addEventListener?.("click", (e: J) => { if (!e.target?.closest?.(".pop-host")) closePopovers(); });
	const header = () => {
		const tools = $("tools");
		tools.replaceChildren();
		// Phone widths: the sections sit behind a menu button instead of a strip that runs off the screen.
		const menu = control($("tools"), "☰", () => { const open = $("nav").getAttribute?.("data-open") !== "true"; $("nav").setAttribute("data-open", String(open)); menu.setAttribute("aria-expanded", String(open)); }, "Sections");
		cls(menu, "icon menu-open pop-host");
		menu.setAttribute("aria-controls", "nav");
		menu.setAttribute("aria-expanded", "false");
		closers.push(() => { if ($("nav").getAttribute?.("data-open") !== "true") return false; $("nav").setAttribute("data-open", "false"); menu.setAttribute("aria-expanded", "false"); return true; });
		// Live status: when the library last synced, as a quiet dot and label of fixed width, so it never moves the layout.
		ui.sync = el("span", tools);
		cls(ui.sync, "sync");
		ui.sync.setAttribute("role", "status");
		paintSync({ state: "loading", at: null });
		// One search for everything: a results list while typing (titles, grouped by type), Enter for the top hit, and the full
		// results page (which also searches memory text) from "See all results".
		const wrap = el("div", tools);
		cls(wrap, "pop-host gwrap");
		const form = el("form", wrap);
		cls(form, "gsearch");
		form.setAttribute("role", "search");
		ui.search = el("input", form);
		ui.search.setAttribute("type", "search");
		ui.search.setAttribute("placeholder", "Search memories, projects, journals…");
		ui.search.setAttribute("aria-label", "Search everything");
		ui.search.setAttribute("id", "global-search");
		ui.search.setAttribute("role", "combobox");
		ui.search.setAttribute("aria-autocomplete", "list");
		ui.search.setAttribute("aria-controls", "search-results");
		ui.search.setAttribute("aria-expanded", "false");
		ui.search.setAttribute("autocomplete", "off");
		const list = el("ul", wrap);
		list.setAttribute("id", "search-results");
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "Search results");
		cls(list, "sresults");
		list.hidden = true;
		let options: [Node, string][] = [], active = -1, searchT: unknown = null;
		const named = () => /[?&]profile=([^&]*)/.exec(String(win.location.hash ?? ""))?.[1];
		const allHref = (q: string) => `#search?q=${enc(q)}${named() ? `&profile=${named()}` : ""}`;
		const closeList = () => { if (list.hidden) return false; list.hidden = true; ui.search.setAttribute("aria-expanded", "false"); ui.search.removeAttribute?.("aria-activedescendant"); active = -1; return true; };
		closers.push(closeList);
		const mark = (i: number) => {
			active = i;
			options.forEach(([o], k) => o.setAttribute("aria-selected", String(k === i)));
			if (i >= 0) { ui.search.setAttribute("aria-activedescendant", `sr-${i}`); (options[i]![0] as J).scrollIntoView?.({ block: "nearest" }); }
		};
		const go = (href: string) => { closeList(); ui.search.blur?.(); if (href.startsWith("#")) win.location.hash = href; };
		const suggest = () => {
			const q = String(ui.search.value ?? "").trim().toLowerCase();
			list.replaceChildren();
			options = [];
			if (q.length < 2 || !am.library) { closeList(); return; }
			const lib: J = am.library(named() ? dec(named()) ?? null : null), deg = (it: J) => lib.links.get(it.key)?.size ?? 0;
			const add = (label: string, items: J[]) => {
				if (!items.length) return;
				const g = el("li", list);
				g.setAttribute("role", "presentation");
				cls(g, "sr-group");
				g.textContent = label;
				for (const it of items) {
					const li = el("li", list), i = options.length, href = am.itemHref(it, named() ? dec(named()) ?? null : null);
					li.setAttribute("role", "option");
					li.setAttribute("id", `sr-${i}`);
					li.setAttribute("aria-selected", "false");
					cls(li, "sr-item");
					const dot = el("i", li);
					cls(dot, `sw t-${it.kind}`);
					am.title(it, el("span", li));
					if (it.updated) am.time(li, it.updated);
					li.addEventListener("click", () => go(href));
					options.push([li, href]);
				}
			};
			const hit = (it: J) => `${it.title} ${it.name} ${it.alias ?? ""}`.toLowerCase().includes(q);
			add("Projects", (lib.list.project as J[]).filter((x) => !x.wide && deg(x) > 0 && hit(x)).slice(0, 4));
			for (const [k, label] of [["memory", "Memories"], ["learning", "Learnings"], ["journal", "Journals"]]) add(label!, (lib.list[k!] as J[]).filter(hit).slice(0, 4));
			const more = el("li", list), i = options.length;
			more.setAttribute("role", "option");
			more.setAttribute("id", `sr-${i}`);
			cls(more, "sr-item sr-all");
			// A real link, so any click (mouse, script, assistive tech) opens the results page the way Enter does.
			const all = el("a", more, options.length ? `See all results for “${q}”` : `No titles match. Search the text of every memory for “${q}”`);
			all.setAttribute("href", allHref(q));
			all.setAttribute("tabindex", "-1"); // the list is reached with the arrow keys, not Tab
			more.addEventListener("click", (e: J) => { e.preventDefault?.(); go(allHref(q)); });
			options.push([more, allHref(q)]);
			list.hidden = false;
			ui.search.setAttribute("aria-expanded", "true");
			mark(-1);
		};
		ui.search.addEventListener("input", () => { win.clearTimeout?.(searchT); searchT = win.setTimeout?.(suggest, 180); });
		ui.search.addEventListener("keydown", (e: J) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				if (list.hidden) suggest();
				if (!options.length) return;
				e.preventDefault();
				mark(e.key === "ArrowDown" ? (active + 1) % options.length : active <= 0 ? options.length - 1 : active - 1);
			} else if (e.key === "Escape" && closeList()) e.preventDefault();
		});
		form.addEventListener("submit", (e: J) => {
			e.preventDefault();
			const q = String(ui.search.value ?? "").trim();
			if (!q) return;
			win.clearTimeout?.(searchT);
			// Enter opens the highlighted result; with nothing highlighted, the full results page.
			go(active >= 0 ? options[active]![1] : allHref(q));
		});
		// Narrow screens: the search box hides behind a button that opens it on its own row.
		let searchOpen = false;
		const setSearch = (open: boolean) => {
			searchOpen = open;
			doc.documentElement?.setAttribute?.("data-search", open ? "open" : "closed"); // the page makes room for the row
			cls(wrap, open ? "pop-host gwrap open" : "pop-host gwrap");
			opener.setAttribute("aria-expanded", String(open));
			if (open) ui.search.focus(); else { closeList(); opener.focus?.(); }
		};
		const opener = control(tools, "", () => setSearch(!searchOpen), "Search");
		const cancel = control(wrap, "Cancel", () => setSearch(false));
		cls(cancel, "gcancel");
		// Closed by default; Esc, a click elsewhere and navigation close it again (only ⌕ opens it).
		closers.push(() => { if (!searchOpen) return false; searchOpen = false; doc.documentElement?.setAttribute?.("data-search", "closed"); cls(wrap, "pop-host gwrap"); opener.setAttribute("aria-expanded", "false"); return true; });
		cls(opener, "icon search-open pop-host");
		opener.setAttribute("aria-expanded", "false");
		opener.setAttribute("aria-controls", "global-search");
		// A drawn magnifier: the ⌕ glyph renders tiny in most fonts.
		if (doc.createElementNS) {
			const NS = "http://www.w3.org/2000/svg", svg = doc.createElementNS(NS, "svg");
			for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "20"], ["height", "20"], ["aria-hidden", "true"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2.2"], ["stroke-linecap", "round"]]) svg.setAttribute(k, v);
			const c = doc.createElementNS(NS, "circle"), l = doc.createElementNS(NS, "path");
			for (const [k, v] of [["cx", "10.5"], ["cy", "10.5"], ["r", "6.5"]]) c.setAttribute(k, v);
			l.setAttribute("d", "M15.5 15.5 20 20");
			svg.appendChild(c); svg.appendChild(l); opener.appendChild(svg);
		} else opener.textContent = "⌕";
		cls(el("span", opener, "Search"), "vh"); // its name as text too, for tools that read text rather than labels
		tools.appendChild(wrap); // after the button, so a narrow row reads button, then box
		ui.profile = el("select", tools);
		ui.profile.setAttribute("id", "profile-choice");
		ui.profile.setAttribute("aria-label", "Profile");
		ui.profile.hidden = true;
		ui.profile.addEventListener("change", () => chooseProfile(String(ui.profile.value ?? "")));
		// Settings: a small menu of the owner's tools, grouped by task. The #/manage page stays as the same list.
		const gearHost = el("div", tools);
		cls(gearHost, "pop-host");
		ui.settings = control(gearHost, "⚙", () => { const open = gearMenu.hidden; closePopovers(); gearMenu.hidden = !open; ui.settings.setAttribute("aria-expanded", String(open)); }, "Settings");
		cls(ui.settings, "gear");
		ui.settings.setAttribute("aria-haspopup", "menu");
		ui.settings.setAttribute("aria-expanded", "false");
		ui.settings.setAttribute("title", "Settings");
		const gearMenu = el("div", gearHost);
		cls(gearMenu, "gear-menu");
		gearMenu.setAttribute("role", "menu");
		gearMenu.hidden = true;
		for (const [title, items] of ADMIN_GROUPS) {
			cls(el("span", gearMenu, title), "gm-head");
			for (const [label, href] of items) { const a = el("a", gearMenu, label); a.setAttribute("href", href); a.setAttribute("role", "menuitem"); a.addEventListener("click", () => { gearMenu.hidden = true; }); }
		}
		// On a phone the header has no room for the theme button; the menu carries it.
		const themeItem = el("button", gearMenu, "Switch theme");
		themeItem.setAttribute("type", "button");
		themeItem.setAttribute("role", "menuitem");
		cls(themeItem, "gm-theme");
		themeItem.addEventListener("click", () => { ui.theme?.click(); gearMenu.hidden = true; });
		closers.push(() => { if (gearMenu.hidden) return false; gearMenu.hidden = true; ui.settings.setAttribute("aria-expanded", "false"); return true; });
		ui.theme = control(tools, "", () => {
			const next = theme() === "dark" ? "light" : "dark";
			doc.documentElement?.setAttribute?.("data-theme", next);
			save("am.theme", next);
			paintTheme();
		});
		cls(ui.theme, "icon");
		paintTheme();
		win.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", paintTheme);
	};
	/** The sync dot: green when the library synced in the last few minutes, amber when paused (tab hidden or offline), red on a failed read. */
	const paintSync = (st: { state: string; at: string | null }) => {
		if (!ui.sync) return;
		ui.sync.replaceChildren();
		const dot = el("i", ui.sync);
		cls(dot, `sync-dot ${st.state}`);
		const word = st.state === "live" ? "Live" : st.state === "paused" ? "Paused" : st.state === "error" ? "Couldn’t refresh" : "Syncing…";
		el("span", ui.sync, word);
		if (st.state === "error") { const r = control(ui.sync, "Retry", () => am.resync?.()); cls(r, "linklike sync-retry"); }
		if (st.state === "live") cls(el("span", ui.sync, ` · ${am.when(st.at).text.replace(/^Today /, "")}`), "sync-time");
		ui.sync.setAttribute("title", st.state === "live" ? `Synced ${am.when(st.at).full}; refreshes every 2 minutes while this tab is open.` : st.state === "paused" ? "Paused: tab was hidden; refreshes when you return" : st.state === "error" ? "The last refresh failed; it retries." : "Loading your library…");
	};

	// ---- Navigation: the sections, flat; the owner tools sit behind Settings ----
	type Entry = { id: string; label: string; key: string; href: string; hidden?: boolean };
	// Each tool: label, href, glossary key for its one-line purpose.
	const ADMIN_GROUPS: [string, [string, string, string][]][] = [
		["Write and review", [["Write a memory", "#/draft", "write"], ["Review", "#/review", "review"], ["Change history", "#audit", "activity"]]],
		["Keep data safe", [["Backups and recovery", "#/backups", "backups"], ["Move records", "#/move", "moves"], ["Wipe a profile", "#/wipe", "wipe"]]],
		["Set up", [["Devices and tokens", "#/devices", "devices"], ["Profiles", "#/profiles", "profiles"], ["Routing", "#/routing", "routing"]]]];
	const ADMIN: [string, string][] = ADMIN_GROUPS.flatMap(([, l]) => l.map(([t, h]): [string, string] => [t, h]));
	const entries = (): Entry[] => tabs.map((t) => ({ ...t, href: `#${t.id}` }));
	const nav = (current?: string) => {
		const root = $("nav");
		root.replaceChildren();
		for (const e of entries().filter((x) => !x.hidden)) {
			const a = el("a", root, e.label);
			a.setAttribute("href", e.href);
			a.setAttribute("aria-keyshortcuts", `g ${e.key}`);
			if (e.id === current) a.setAttribute("aria-current", "page");
		}
		const pl = el("label", root, "Profile");
		cls(pl, "nav-profile");
		ui.navProfile = el("select", pl);
		ui.navProfile.addEventListener("change", () => chooseProfile(String(ui.navProfile.value ?? "")));
		const tool = current === "#/manage" || current === "audit" || ADMIN.some(([, href]) => href === current);
		if (ui.settings) { if (tool) ui.settings.setAttribute("aria-current", "page"); else (ui.settings as J).removeAttribute?.("aria-current"); }
	};

	// ---- Keys (see am.ts) ----
	const visible = (e: J) => !!e && !e.disabled && !e.hidden && (typeof e.getClientRects !== "function" || e.getClientRects().length > 0);
	const closeAll = () => {
		let closed = closeTips() || closePopovers();
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
			const s = view.querySelector?.("[data-search]") ?? $("global-search");
			if (visible(s)) { e.preventDefault(); s.focus(); }
			return;
		}
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
	// The nav entry an old route belongs to, by entry id (its tab's once registered) or Admin href: #/ and #/graph are Graph,
	// #/memory is Memories, #/activity is Audit, #/copy is Moves; any other #/name is that Admin page.
	// ---- The shared profile choice (TabDef.profiles): the link's ?profile=NAME; no query is All profiles ----
	/** `hash` with only its profile query replaced (null removes it); the tab, id and every other query key stay as they are. */
	const withProfile = (hash: string, name: string | null) => {
		const i = hash.indexOf("?"), path = i < 0 ? hash : hash.slice(0, i);
		const kept = (i < 0 ? "" : hash.slice(i + 1)).split("&").filter((kv) => kv && dec(kv.split("=")[0]) !== "profile");
		if (name !== null) kept.push(`profile=${enc(name)}`);
		return kept.length ? `${path}?${kept.join("&")}` : path;
	};
	/** For a tab that opted in: an error and chooser for an unknown ?profile, or a chooser for a "one" tab with none; else nothing. */
	const profileGate = (view: Node, def: TabDef, route: Route): Node | undefined => {
		const named = route.query.profile, ok = active();
		if (named === undefined ? def.profiles === "any" : ok.some((p) => p.name === named)) return undefined;
		const h = el("h2", view, named === undefined ? `${def.label}: choose a profile` : `${def.label}: no active profile named ${named}`);
		el("p", view, named === undefined ? `${def.label} shows one profile at a time.` : "Nothing was read. Choose an active profile:");
		const ul = el("ul", view);
		for (const q of ok) link(el("li", ul), withProfile(route.hash, q.name), q.name);
		if (def.profiles === "any") link(el("li", ul), withProfile(route.hash, null), "All profiles");
		if (!ok.length) el("p", view, "No active profiles available.");
		return h;
	};
	let picked: Route | undefined; // the route the header picker belongs to
	/** The profile choice (the header's, or the phone menu's): the same page in that profile; an owner tool opens Home in it. */
	const chooseProfile = (value: string) => {
		closePopovers();
		if (!picked) { win.location.hash = withProfile("#home", value || null); return; }
		const now = String(win.location.hash ?? ""), here = /^#([a-z]+)/.exec(now)?.[1] === picked.tab ? now : picked.hash;
		const to = withProfile(here, value || null);
		if (typeof win.history?.replaceState === "function") { win.history.replaceState(null, "", to); render(false); } else win.location.hash = to;
	};
	/** Shows the header picker for an opted-in tab's route, with its current choice; hides it everywhere else. */
	const picker = (def: TabDef | undefined, route?: Route) => {
		const sel = ui.profile;
		if (!sel) return;
		// The switcher shows on every page; on a page with no profile choice (an owner tool) it opens Home in the chosen profile.
		picked = def?.profiles && route ? route : undefined;
		sel.hidden = false;
		sel.replaceChildren();
		const names = active().map((p) => p.name), named = picked?.query.profile;
		el("option", sel, "All profiles").setAttribute("value", "");
		for (const n of names) el("option", sel, n).setAttribute("value", n);
		if (named !== undefined && !names.includes(named)) el("option", sel, `${named} (not active)`).setAttribute("value", named);
		sel.value = named ?? "";
		// The phone menu carries the same choice (the header has no room for it there).
		// On a phone the choice lives in the menu; the closed header still says which profile is showing, under the name.
		doc.querySelector?.(".top .mark")?.setAttribute?.("data-profile", sel.value || "All profiles");
		const m = ui.navProfile;
		if (m) { m.replaceChildren(); for (const o of sel.children ?? []) el("option", m, o.textContent).setAttribute("value", o.getAttribute?.("value") ?? o.value ?? ""); m.value = sel.value; }
	};
	const eachProfile = async <T,>(only: string | null, fn: (p: Profile) => Promise<T>): Promise<ProfileResult<T>[]> => {
		const ok = active(), list = only === null ? ok : ok.filter((p) => p.name === only);
		if (only !== null && !list.length) {
			const error: Failure = Object.assign(new Error(`No active profile named ${only}`), { code: "unknown_profile" });
			return [{ profile: only, ok: false, error }];
		}
		return Promise.all(list.map(async (p): Promise<ProfileResult<T>> => {
			try { return { profile: p.name, ok: true, value: await fn(p) }; } catch (err) { return { profile: p.name, ok: false, error: err as Failure }; }
		}));
	};

	// The width mode the layout follows: phone and tablet (a detail is a full-screen view with Back), or desktop (list and
	// detail side by side, 40/60 from 901px). Kept on <html data-width> and updated on resize, debounced.
	const widthMode = () => { const w = Number(win.innerWidth) || 1440; return w < 641 ? "phone" : w < 901 ? "tablet" : "desktop"; };
	let resizeT: unknown = null;
	const applyWidth = () => doc.documentElement?.setAttribute?.("data-width", widthMode());
	applyWidth();
	win.addEventListener?.("resize", () => { win.clearTimeout?.(resizeT); resizeT = win.setTimeout?.(applyWidth, 120) ?? applyWidth(); });
	let lastTab = "";
	const render = (moveFocus: boolean) => {
		// Opening or closing an item in the same section keeps the page where it was, so the list stays scroll-positioned.
		const y = Number(win.scrollY) || 0, here = /^#([a-z]+)/.exec(String(win.location.hash ?? ""))?.[1] ?? "";
		for (const f of [...leaving]) { leaving.delete(f); try { f(); } catch { /* a cleanup never blocks the next page */ } }
		am.pageVersion++;
		am.pageButtons = [];
		am.pageMsg = undefined;
		const view = $("view");
		view.replaceChildren();
		am.shown = am.statusEl = undefined;
		closeTips();
		closePopovers();
		const raw = String(win.location.hash ?? "");
		// Old addresses open their place in the new sections; anything unknown opens Home.
		const moved = redirect(raw);
		if (moved !== null) { try { win.history?.replaceState?.(null, "", moved); } catch { /* the page still opens */ } }
		const hash = moved ?? raw;
		let h: Node | void;
		const t = /^#([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash), def = t ? tabs.find((x) => x.id === t[1]) : undefined;
		if (t && def) {
			const rest = t[2] ? t[2].split("/").map((s) => dec(s)!) : [], query: Record<string, string> = {};
			for (const kv of (t[3] ?? "").split("&").filter(Boolean)) { const [k, v = ""] = kv.split("="); query[dec(k)!] = dec(v)!; }
			const route: Route = { tab: def.id, rest, query, hash, ...(rest[0] !== undefined ? { id: rest[0] } : {}) };
			h = (def.profiles ? profileGate(view, def, route) : undefined) ?? def.render(view, route);
			nav(def.id);
			picker(def, route);
			if (ui.search && def.id === "search") ui.search.value = query.q ?? "";
		} else {
			h = oldRoute(view, hash);
			nav(/^#\/([a-z]*)/.exec(hash)?.[0] === "#/manage" ? "#/manage" : `#/${/^#\/([a-z]*)/.exec(hash)?.[1] ?? ""}`);
			picker(undefined);
		}
		const same = here === lastTab && here !== "";
		lastTab = here;
		if (moveFocus && h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: same }); }
		if (same && y) win.scrollTo?.(0, y);
	};
	/** Where an old address now lives, or null when it is current. */
	const redirect = (hash: string): string | null => {
		if (hash === "" || hash === "#" || hash === "#/") return "#home";
		const q = /\?.*$/.exec(hash)?.[0] ?? "";
		const named = /[?&]profile=([^&]*)/.exec(q)?.[1];
		const m = /^#\/(memory|memories|graph|journals|about|timeline|map|path|work|activity|profile)(?:\/([^/?]+)(?:\/([^/?]+))?)?/.exec(hash);
		if (m) {
			const [, page, p, id] = m;
			if (page === "activity") return null; // the change history of one profile
			if (page === "memory" && p && id) return `#memories/${p}/${id}`;
			if (page === "memories" || page === "memory") return `#memories${p ? `?profile=${p}` : ""}`;
			if (page === "journals" && p && id) return `#journals/${p}/${id}`;
			if (page === "journals") return `#journals${p ? `?profile=${p}` : ""}`;
			if (page === "about") return `#learnings${p ? `?profile=${p}` : ""}`;
			if (page === "profile") return null; // the Profiles tool's page for one profile
			return `#map${p ? `?profile=${p}` : ""}`;
		}
		// An older record address named only the record and its profile in the query (#memories/ID?profile=work).
		const lone = /^#(memories|learnings|journals)\/([^/?]+)\?(.*)$/.exec(hash);
		if (lone && named) return `#${lone[1]}/${named}/${lone[2]}?${lone[3]}`;
		const t = /^#([a-z]+)(?:\/([^?]*))?/.exec(hash);
		if (!t || tabs.some((x) => x.id === t[1])) return null;
		if (t[1] === "graph" || t[1] === "overview") return `#${t[1] === "graph" ? "map" : "home"}${named ? `?profile=${named}` : ""}`;
		if (["sessions", "replay", "activity", "goals", "health", "facts", "crystals", "actions", "profile", "lessons", "people"].includes(t[1]!)) return `#${t[1] === "lessons" ? "learnings" : "home"}${named ? `?profile=${named}` : ""}`;
		return null;
	};
	/** Settings: the owner's tools as cards, grouped by task, each with its one-line purpose. */
	const manage = (view: Node): Node => {
		const h = el("h2", view, "Settings");
		for (const [title, list] of ADMIN_GROUPS) {
			const sec = el("section", view);
			el("h3", sec, title);
			const cards = el("div", sec);
			cls(cards, "hub");
			for (const [label, href, term] of list) {
				const card = el("a", cards);
				cls(card, "hubcard");
				card.setAttribute("href", href);
				el("strong", card, label);
				el("span", card, am.glossary[term]?.text ?? "");
			}
		}
		return h;
	};
	/** The owner tools under their #/ routes. */
	const oldRoute = (view: Node, hash: string): Node => {
		const m = /^#\/(profiles)\/([^/]+)$/.exec(hash);
		const name = m ? dec(m[2]) : undefined;
		const pg = /^#\/(draft|activity|review|move|copy)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(hash);
		if (pg) return legacy(view, pg[1]!, dec(pg[2]), dec(pg[3]));
		if (hash === "#/backups") return pages.backups!(view);
		if (hash === "#/devices") return pages.devices!(view);
		if (hash === "#/manage") return manage(view);
		if (hash === "#/routing") return pages.routing!(view);
		if (hash === "#/wipe" || hash.startsWith("#/wipe/")) return pages.wipe!(view, hash === "#/wipe" ? undefined : dec(hash.slice(7)));
		if (hash === "#/profiles") return pages.home!(view);
		const p = name === undefined ? undefined : am.profiles.find((x) => x.name === name);
		if (p) return pages.profile!(view, p);
		const h = el("h2", view, name === undefined ? "Page not found" : `No profile named ${name}`);
		link(el("p", view), "#home", "Go to Home");
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
		// One profile's batch status failing to load marks only its own card on the Profiles tool.
		am.batches = new Map<string, Batch | Error>(await Promise.all(am.profiles.map(async (p: Profile) =>
			[p.name, await call(`/api/profiles/${encodeURIComponent(p.name)}/batch`).catch((err: Error) => err)] as [string, Batch | Error])));
		status("");
		$("status").hidden = true;
		$("view").hidden = false;
		render(false);
		am.library?.(null); // every page, owner tools too, loads the library, so the header's sync state settles
		win.addEventListener("hashchange", () => render(true));
	};

	const am: Am = {
		win, doc, $, status, call, token,
		profiles: [], devices: [], batches: new Map(), snapshot: null,
		el, link, facts, day, state, users, active, recorded, enc, why, live, btn, input, choose, switcher, act, undoOf, pageStatus, textBlock, note, outcomes,
		glossary: {}, help, intro, copy, curl, mcpCall, mcpCurl, empty, loading, pager, autoMore,
		eachProfile, tabs, tab, pages, legacy, render, boot, onLeave, observe,
		pageVersion: 0, pageButtons: [], pageMsg: undefined, shown: undefined, statusEl: undefined,
		// Set by the part that owns each.
		api: null!, drafts: null!, whatIf: null!, whatIfEdits: null!, draftFromWhatIf: null!, graphs: null!, graphOf: null!, pump: null!,
		moves: null!, sendMove: null!, moveView: null!, copyBack: null!, COPY_MAX: 0, library: null!, when: null!, time: null!, human: (s: string) => s, title: (it: J) => String(it?.title ?? ""), settleTitle: () => undefined, itemHref: null!, placeOf: null!, workspaceName: (w: string) => w, workspaceOrder: [], setSync: (st: { state: string; at: string | null }) => paintSync(st), daily: null!, fitWeeks: (_b: Node, w: number) => w, bars: null!, facets: null!, related: null!, detail: null!, md: null!,
	};
	win.__am = am;
}
