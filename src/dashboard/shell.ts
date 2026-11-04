// The shell (section 15): builds `am`, the header (date, glossary, theme, narrow menu), the grouped nav, keys, sign-in and the
// router. Browser code, serialized into /app.js as the first part: it may use only its parameter and browser globals (type
// imports are erased). Sign-in follows settingsMain (ClerkJS 6 needs ClerkUI passed to load()). Every value from the API or
// the URL reaches the page through textContent. It shows only real pages and no live data: no counts, versions or feature states.
import type { Am, Batch, Device, Failure, J, LegacyPage, Node, Profile, ProfileResult, Route, TabDef } from "./am";

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
	const ui: { glossary?: J; theme?: J; menu?: J; features?: J; live?: J; sync?: J; profile?: J } = {};
	// The live state as am.api reports it; "off" until the data client says anything. Nothing here is drawn from guesses.
	let stream: { state: "off" | "live" | "paused"; since: string | null; asOf: string | null } = { state: "off", since: null, asOf: null };
	const pad = (n: number) => String(n).padStart(2, "0");
	const hhmm = (iso: string | null | undefined) => { const d = new Date(iso ?? ""); return Number.isNaN(d.getTime()) ? null : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
	const theme = (): string => doc.documentElement?.getAttribute?.("data-theme") ?? (win.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
	const paintTheme = () => {
		if (!ui.theme) return;
		const next = theme() === "dark" ? "light" : "dark";
		ui.theme.textContent = next === "dark" ? "Dark" : "Light";
		ui.theme.setAttribute("aria-label", `Use the ${next} theme`);
	};
	const stored = saved("am.theme");
	if (stored === "light" || stored === "dark") doc.documentElement?.setAttribute?.("data-theme", stored);
	let returnTo: J; // the control that opened the open panel
	const shut = (d: J) => {
		if (typeof d.close === "function") d.close(); // fires "close", which returns focus
		else { d.hidden = true; returnTo?.focus?.(); }
	};
	const isOpen = (d: J) => typeof d.showModal === "function" ? d.open === true : d.hidden === false;
	/** Empties the dialog `id` and gives it a heading and a Close button. */
	const panel = (id: string, title: string, term?: string) => {
		const d = $(id);
		d.replaceChildren();
		const head = el("div", d);
		cls(head, "dhead");
		const h = el("h2", head, title);
		h.setAttribute("id", `${id}-title`);
		if (term) help(h, term);
		control(head, "Close", () => shut(d));
		return d;
	};
	const show = (d: J, opener: J) => {
		returnTo = opener;
		if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else { d.hidden = false; d.querySelector?.("button")?.focus(); }
	};
	const FEATURES: Record<string, string> = { embeddings: "Embeddings", corpus: "Corpus", capture: "Capture per device", inject: "Prompt injection", scheduled_batch: "Scheduled batch" };
	/** The server's feature states from the latest snapshot. The button that opens it exists only once a snapshot has loaded. */
	const openFeatures = () => {
		const d = panel("features", "Features", "features"), s = am.snapshot;
		if (s && !s.flags.length) note(d, "The server reported no features.");
		for (const f of s?.flags ?? []) {
			const row = el("div", d);
			cls(row, "flag");
			const h = el("h3", row);
			cls(el("span", h, f.state), `chip ${f.state === "on" ? "c-ok" : f.state === "off" ? "c-fail" : "c-warn"}`);
			el("span", h, FEATURES[f.id] ?? f.id);
			help(h, f.id);
			el("p", row, `Affects: ${f.tabs.map((id) => tabs.find((t) => t.id === id)?.label ?? id).join(", ") || "no tab"}.`);
			if (f.state !== "on") el("p", row, `To turn it on: ${f.how}`);
		}
		show(d, ui.features);
	};
	const openGlossary = () => {
		const d = panel("gloss", "Glossary");
		const dl = el("dl", d);
		for (const [k, g] of Object.entries(am.glossary).sort((a, b) => a[1].term.localeCompare(b[1].term))) { el("dt", dl, g.term).setAttribute("id", `g-${k}`); el("dd", dl, g.text); }
		el("h3", d, "Keys");
		const keys = el("dl", d);
		for (const [k, t] of [["/", "Focus this page's search box."], ["g, then a letter", `Open a page: ${entries().filter((x) => x.key).map((x) => `${x.key} ${x.label}`).join(", ")}.`],
			["?", "Open this glossary."], ["Esc", "Close a tip, panel or menu."], ["Up, Down, Home, End", "Move through a list."],
			...(tabs.some((x) => x.id === "replay") ? [["Space, Left, Right", "In Replay: play or pause, and step back or forward."]] : [])]) { el("dt", keys, k); el("dd", keys, t); }
		show(d, ui.glossary);
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
		ui.profile = el("select", tools);
		ui.profile.setAttribute("id", "profile-choice");
		ui.profile.setAttribute("aria-label", "Profile");
		ui.profile.hidden = true;
		ui.profile.addEventListener("change", () => {
			if (!picked) return;
			// Tabs keep their address current with replaceState (an open record, a search, a filter) without a render, so the picker
			// rewrites the current address while it still names the picked tab.
			const now = String(win.location.hash ?? ""), here = /^#([a-z]+)/.exec(now)?.[1] === picked.tab ? now : picked.hash;
			const to = withProfile(here, ui.profile.value || null);
			// replaceState and one render keep focus on the select; without it the hash change renders once instead.
			if (typeof win.history?.replaceState === "function") { win.history.replaceState(null, "", to); render(false); } else win.location.hash = to;
		});
		ui.features = control(tools, "", openFeatures);
		ui.features.setAttribute("aria-haspopup", "dialog");
		ui.features.hidden = true;
		ui.live = el("span", tools);
		ui.live.setAttribute("title", am.glossary.live?.text ?? "");
		ui.live.hidden = true;
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
		for (const id of ["gloss", "features"]) $(id).addEventListener("close", () => returnTo?.focus?.());
		ui.sync = el("span", $("foot"));
		el("span", $("foot"), "Keys: / search · g then a letter opens a page · ? glossary · Esc closes");
	};
	/**
	 * Draws what am.api has reported: the version and feature states from the latest snapshot, the Live or Paused chip and
	 * banner from the stream, sync times in the footer, and counts for registered tabs. Before a report each piece stays hidden.
	 * Never moves focus.
	 */
	const chrome = () => {
		const s = am.snapshot;
		const ver = $("ver");
		ver.textContent = s ? (s.version.length > 12 ? s.version.slice(0, 8) : s.version) : "";
		if (s) ver.setAttribute("title", `Version ${s.version}, deployed ${s.deployed_at}`);
		if (ui.features) {
			const on = s ? s.flags.filter((f) => f.state === "on").length : 0;
			ui.features.hidden = !s;
			ui.features.textContent = !s ? "" : s.flags.length && on === s.flags.length ? "All features on" : `${on} of ${s.flags.length} features on`;
		}
		if (ui.live) {
			ui.live.hidden = stream.state === "off";
			ui.live.textContent = stream.state === "live" ? "Live" : stream.state === "paused" ? "Paused" : "";
			cls(ui.live, `chip ${stream.state === "live" ? "c-ok" : "c-warn"}`);
		}
		const pause = $("pause"), asOf = hhmm(stream.asOf);
		pause.hidden = stream.state !== "paused";
		pause.textContent = stream.state !== "paused" ? "" : asOf ? `Live updates paused. Numbers as of ${asOf}.` : "Live updates paused. No numbers have loaded yet.";
		const since = stream.state === "live" ? hhmm(stream.since) : null;
		if (ui.sync) ui.sync.textContent = s ? `Agent Memory ${s.version} · full sync ${hhmm(s.at) ?? "at an unknown time"}${since ? `, live since ${since}` : ""}` : "";
		for (const [id, span] of counts) {
			const n = s ? tabs.find((t) => t.id === id)?.count?.(s) : null;
			span.replaceChildren();
			if (typeof n === "number" && Number.isFinite(n)) { el("span", span, n.toLocaleString()); cls(el("span", span, " across all profiles"), "vh"); }
		}
	};

	// ---- Navigation: today's pages, grouped, then any registered tab in its group; Admin holds the other pages ----
	type Entry = { id: string; group: string | null; label: string; key: string; href: string; count?: TabDef["count"] };
	// The real pages each group has today. A registered tab with the same id takes its entry's place.
	const PAGES: Entry[] = [{ id: "graph", group: "memory", label: "Graph", key: "g", href: "#/graph" }, { id: "memories", group: "memory", label: "Memories", key: "m", href: "#/memories" },
		{ id: "audit", group: "system", label: "Audit", key: "u", href: "#/activity" }];
	// The other pages, in the plan's order.
	const ADMIN: [string, string][] = [["Write", "#/draft"], ["Paths", "#/path"], ["Map", "#/map"], ["Timeline", "#/timeline"], ["Journals", "#/journals"], ["Review", "#/review"],
		["Backups and recovery", "#/backups"], ["Routing", "#/routing"], ["Profiles", "#/profiles"], ["Moves", "#/move"], ["Wipe", "#/wipe"], ["Work", "#/work"], ["About you", "#/about"],
		["Settings", "/settings"]];
	const GROUPS: [string, string][] = [["memory", "Memory"], ["work", "Work"], ["insight", "Insight"], ["system", "System"]];
	const entries = (): Entry[] => [...PAGES.filter((p) => !tabs.some((t) => t.id === p.id)), ...tabs.map((t) => ({ ...t, href: `#${t.id}` }))];
	/** The grouped nav; `current` is the entry id or the Admin href to mark. Groups with no entry are left out. */
	const counts = new Map<string, Node>(); // tab id -> its count span; only registered tabs with a count have one
	const nav = (current?: string) => {
		const root = $("nav");
		root.replaceChildren();
		counts.clear();
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
				if (e.id === current) a.setAttribute("aria-current", "page");
				if (e.count) { const c = el("span", a); cls(c, "count"); c.setAttribute("title", "Across all profiles"); counts.set(e.id, c); }
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
		chrome();
	};

	// ---- Keys (see am.ts) ----
	const visible = (e: J) => !!e && !e.disabled && !e.hidden && (typeof e.getClientRects !== "function" || e.getClientRects().length > 0);
	const closeAll = () => {
		let closed = closeTips();
		for (const id of ["gloss", "features"]) { const d = $(id); if (isOpen(d)) { shut(d); closed = true; } }
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
	const ALIASES: Record<string, [string, string]> = { memories: ["memories", "memory"], graph: ["graph", "graph"], audit: ["activity", "activity"] };
	// The nav entry an old route belongs to, by entry id (its tab's once registered) or Admin href: #/ and #/graph are Graph,
	// #/memory is Memories, #/activity is Audit, #/copy is Moves; any other #/name is that Admin page.
	const OWNER: Record<string, string> = { "": "graph", graph: "graph", memory: "memories", memories: "memories", activity: "audit", copy: "#/move" };
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
	/** Shows the header picker for an opted-in tab's route, with its current choice; hides it everywhere else. */
	const picker = (def: TabDef | undefined, route?: Route) => {
		const sel = ui.profile;
		if (!sel) return;
		picked = def?.profiles && route ? route : undefined;
		sel.hidden = !picked;
		if (!picked) return;
		sel.replaceChildren();
		const names = active().map((p) => p.name), named = picked.query.profile;
		el("option", sel, "All profiles").setAttribute("value", "");
		for (const n of names) el("option", sel, n).setAttribute("value", n);
		if (named !== undefined && !names.includes(named)) el("option", sel, `${named} (not active)`).setAttribute("value", named);
		sel.value = named ?? "";
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

	const render = (moveFocus: boolean) => {
		am.pageVersion++;
		am.pageButtons = [];
		am.pageMsg = undefined;
		const view = $("view");
		view.replaceChildren();
		am.shown = am.statusEl = undefined;
		closeTips();
		setMenu(false);
		// The site root opens a registered Overview; without one it stays the work graph, as before. Graph's own link is #/graph.
		const raw = win.location.hash ?? "", root = raw === "" || raw === "#" || raw === "#/";
		const hash = root && tabs.some((x) => x.id === "overview") ? "#overview" : raw;
		let h: Node | void;
		// A tab's deep link: #<tab>/<id>/<more>?<query>. Old #/ routes keep their pages below.
		const t = /^#([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash), def = t ? tabs.find((x) => x.id === t[1]) : undefined, alias = t ? ALIASES[t[1]!] : undefined;
		if (t && (def || alias)) {
			const rest = t[2] ? t[2].split("/").map((s) => dec(s)!) : [], query: Record<string, string> = {};
			for (const kv of (t[3] ?? "").split("&").filter(Boolean)) { const [k, v = ""] = kv.split("="); query[dec(k)!] = dec(v)!; }
			if (def) {
				const route: Route = { tab: def.id, rest, query, hash, ...(rest[0] !== undefined ? { id: rest[0] } : {}) };
				h = (def.profiles ? profileGate(view, def, route) : undefined) ?? def.render(view, route);
				nav(def.id);
				picker(def, route);
			} else {
				h = legacy(view, rest[0] === undefined ? alias![0] : alias![1], query.profile, rest[0]);
				nav(t[1]);
				picker(undefined);
			}
		} else {
			h = oldRoute(view, hash);
			const seg = /^#\/([a-z]*)/.exec(hash)?.[1] ?? "";
			nav(OWNER[seg] ?? `#/${seg}`);
			picker(undefined);
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
		am.api.subscribe((e) => {
			if (e.type === "live") stream = { state: "live", since: e.since, asOf: null };
			else if (e.type === "paused") stream = { state: "paused", since: null, asOf: e.as_of || null };
			else if (e.type !== "snapshot") return;
			chrome();
		});
		am.api.start();
	};

	const am: Am = {
		win, doc, $, status, call, token,
		profiles: [], devices: [], batches: new Map(), snapshot: null,
		el, link, facts, day, state, users, active, recorded, enc, why, live, btn, input, choose, switcher, act, undoOf, pageStatus, textBlock, note, outcomes,
		glossary: {}, help, intro, copy, curl, mcpCall, mcpCurl, empty, loading,
		eachProfile, tabs, tab, pages, legacy, render, boot,
		pageVersion: 0, pageButtons: [], pageMsg: undefined, shown: undefined, statusEl: undefined,
		// Set by the part that owns each.
		api: null!, drafts: null!, whatIf: null!, whatIfEdits: null!, draftFromWhatIf: null!, graphs: null!, graphOf: null!, pump: null!,
		moves: null!, sendMove: null!, moveView: null!, copyBack: null!, COPY_MAX: 0,
	};
	win.__am = am;
}
