// The library: every profile's records and links from the owner whole-graph read (metadata only, paged), indexed into what a
// person cares about: memories, learnings, journals, people and projects, and the connections between them. Also the one date
// helper and the human titles every page uses. Nothing here writes. Browser code, serialized into /app.js: it may use only `am`
// and browser globals (type imports are erased).
import type { Am, Failure, GEdge, Graph, J, Profile } from "./am";

export function storeTab(am: Am): void {
	const { call, enc, why, win } = am;

	// ---- The whole-graph read, cached per profile generation (also used by Review's flagged list) ----
	const graphs = new Map<string, Graph>();
	const str = (v: unknown) => (typeof v === "string" && v ? v : null);
	const blankGraph = (): Graph => ({ nodes: new Map(), edges: new Map(), groups: new Map(), pending: new Map(), opaque: 0, loading: false, missing: false, changed: false, dirty: true,
		parts: { nodes: { next: null, total: null, done: false, error: null }, edges: { next: null, total: null, done: false, error: null } } });
	const graphOf = (p: Profile) => {
		const key = `${p.name}:${p.generation ?? ""}`;
		let g = graphs.get(key);
		if (!g) graphs.set(key, g = blankGraph());
		return g;
	};
	const addNode = (g: Graph, it: J) => {
		const id = str(it?.id);
		if (!id || g.nodes.has(id)) return;
		g.nodes.set(id, { id, name: str(it.name) ?? "", kind: str(it.kind) ?? "other", label: str(it.other_label), type: str(it.type), scope: str(it.scope), status: str(it.status) ?? "active",
			updated: str(it.updated_at), created: str(it.created_at), key: str(it.key), origin: str(it.origin), projectKey: str(it.project_key), workspace: str(it.workspace), group: "", seq: 0, x: 0, y: 0, deg: 0, opaque: 0, flagged: !!it.flagged });
		g.dirty = true;
		for (const e of g.pending.get(id) ?? []) link2(g, e);
		g.pending.delete(id);
	};
	/** A link joins once both ends are loaded records; until then it waits, so no end is invented. */
	const link2 = (g: Graph, e: GEdge) => {
		if (g.edges.has(e.id)) return;
		const missing = [e.a, e.b].find((x) => !g.nodes.has(x));
		if (missing) { g.pending.set(missing, [...(g.pending.get(missing) ?? []), e]); return; }
		g.edges.set(e.id, e);
		g.nodes.get(e.a)!.deg++;
		g.nodes.get(e.b)!.deg++;
		g.dirty = true;
	};
	const addEdge = (g: Graph, it: J) => {
		const id = str(String(it?.id ?? "")), a = str(it?.src), b = str(it?.dst?.id);
		if (!id || !a || !b) return;
		if (it.dst.readable !== true) { g.opaque++; return; } // a far end in another profile is never drawn
		link2(g, { id, a, b, rel: str(it.rel) ?? "relates_to" });
	};
	const detached = new WeakSet<Graph>(); // a background resync's graph, filled before it replaces the shown one
	/** Walks the nodes and edges parts in parallel with the server's cursors. A failed page is retried twice, after 0.8 s and
	 * 3 s; after that the part keeps its error (shown in the header, with Retry) and the two-minute refresh tries again. */
	const RETRY_MS = [800, 3000];
	const pump = async (p: Profile, g: Graph) => {
		if (g.loading) return;
		g.loading = true;
		startSync(); // the refresh runs whether or not this first read succeeds
		await Promise.all((["nodes", "edges"] as const).map(async (part) => {
			const ph = g.parts[part];
			let tries = 0;
			ph.error = null;
			while (!ph.done && !g.missing) {
				try {
					const first = !ph.next, r: J = await call(`/api/profiles/${enc(p.name)}/graph?part=${part}${ph.next ? `&after=${enc(ph.next)}` : ""}`);
					if (!Array.isArray(r?.items) || (graphs.get(`${p.name}:${p.generation ?? ""}`) !== g && !detached.has(g))) return;
					for (const it of r.items) (part === "nodes" ? addNode : addEdge)(g, it);
					if (first && part === "nodes") ph.total = typeof r.total === "number" ? r.total : null;
					ph.next = str(r.next_after);
					ph.done = r.done === true || !ph.next;
					if (r.changed === true) g.changed = true;
					ph.error = null;
					tries = 0;
				} catch (err) {
					if ((err as Failure).status === 404 && !g.nodes.size && part === "nodes") g.missing = true;
					else {
						ph.error = why(err);
						if (tries >= RETRY_MS.length) break;
						await new Promise((r) => setTimeout(r, RETRY_MS[tries++]));
						continue;
					}
				}
				g.listener?.();
				fire();
				await new Promise((r) => setTimeout(r, 0));
			}
		}));
		g.loading = false;
		g.listener?.();
		fire();
		// Live once every graph the library asked for has loaded (the test profile, left out of All, is never asked for).
		const asked2 = [...graphs.values()].filter((y) => !detached.has(y));
		if (detached.has(g)) return;
		if (g.parts.nodes.error || g.parts.edges.error) am.setSync?.({ state: "error", at: lastSync });
		else if (!lastSync && asked2.length && asked2.every((y) => (y.parts.nodes.done && y.parts.edges.done) || y.missing)) { lastSync = new Date().toISOString(); am.setSync?.({ state: "live", at: lastSync }); }
	};

	// ---- Live: the library reads itself again every two minutes while the tab is visible and online. A fresh read fills
	// beside the shown one and replaces it whole, so nothing flickers; the header dot says live, paused or failed. ----
	let lastSync: string | null = null, syncing = false, syncStarted = false, again = false;
	const visible = () => am.doc.visibilityState !== "hidden" && win.navigator?.onLine !== false;
	const resync = async () => {
		if (syncing) { again = true; return; } // a write landed mid-read: read once more after this one
		if (!visible()) { am.setSync?.({ state: "paused", at: lastSync }); return; }
		syncing = true;
		try {
			const fresh = await Promise.all(am.active().filter((p) => graphs.has(`${p.name}:${p.generation ?? ""}`)).map(async (p) => {
				const g = blankGraph();
				detached.add(g);
				await pump(p, g);
				if (g.parts.nodes.error || g.parts.edges.error) throw new Error(g.parts.nodes.error ?? g.parts.edges.error ?? "read failed");
				return [`${p.name}:${p.generation ?? ""}`, g] as const;
			}));
			for (const [k, g] of fresh) { detached.delete(g); graphs.set(k, g); }
			regRead.clear(); // the registry is read again with the fresh graphs
			lastSync = new Date().toISOString();
			cache = null;
			fire();
			am.setSync?.({ state: "live", at: lastSync });
		} catch { am.setSync?.({ state: "error", at: lastSync }); }
		syncing = false;
		if (again) { again = false; void resync(); }
	};
	const startSync = () => {
		if (syncStarted) return;
		syncStarted = true;
		win.setInterval?.(resync, 120_000);
		am.doc.addEventListener?.("visibilitychange", () => { if (visible()) void resync(); else am.setSync?.({ state: "paused", at: lastSync }); });
		win.addEventListener?.("online", () => void resync());
		win.addEventListener?.("offline", () => am.setSync?.({ state: "paused", at: lastSync }));
	};

	// ---- Dates: one format everywhere, local time ----
	const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const pad = (n: number) => String(n).padStart(2, "0");
	/** "Today 10:28", "Yesterday 18:02", "12 Nov", "12 Nov 2025"; the full local time for a tooltip. */
	const when = (iso: unknown): { text: string; full: string } => {
		const d = new Date(typeof iso === "string" ? iso : "");
		if (Number.isNaN(d.getTime())) return { text: "", full: "" };
		const now = new Date(), day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
		const days = Math.round((day0(now) - day0(d)) / 86_400_000), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
		const text = days === 0 ? `Today ${hm}` : days === 1 ? `Yesterday ${hm}` : `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
		return { text, full: d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) };
	};
	const time = (parent: J, iso: unknown) => {
		const w = when(iso), t = am.el("time", parent, w.text);
		t.setAttribute("class", "when");
		if (w.full) { t.setAttribute("title", w.full); t.setAttribute("datetime", String(iso)); }
		return t;
	};

	// ---- Human titles ----
	const AGENTS: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
	const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
	const UUIDISH = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
	/** A slug's words, without the dates, hex ids and version numbers in it ("widget-010" → "widget"; "opus-routing-57A8CC3C" → "opus routing"). */
	const words = (slug: string) => {
		const all = slug.split(/[-_\s]+/).filter(Boolean), kept = all.filter((w) => !/^\d+$/.test(w) && !/^v?\d+(\.\d+)+$/i.test(w) && !(/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w)));
		return (kept.length ? kept : all).join(" ").trim();
	};
	/** A readable title: journal slugs lose their date and agent prefix, slugs become words, prompts become their first sentence. */
	const human = (name: string, kind = "record"): string => {
		const n = name.trim().replace(/\.(md|mdx|txt|json|ya?ml|toml|ts|tsx|js|mjs|py|sh|html?)$/i, ""); // a file name reads as its title
		if (!n || UUIDISH.test(n)) return `Untitled ${kind}`;
		const j = /^task-journal-\d{4}-\d{2}-\d{2}(?:-\d{4})?-(.*)$/.exec(n);
		if (j) return cap(words(j[1]!.replace(/^(claude-code|codex)-/, "")) || "Journal");
		if (!/\s/.test(n) && /[-_/]/.test(n)) {
			// A path or slug: its last part, without a leading timestamp and short hash ("…/2026-10-30T13-17-53-dMUw-agent-memory" → "Agent memory").
			const last = (n.split("/").filter(Boolean).at(-1) ?? n).replace(/#[0-9a-f]{6,}$/i, ""), t = words(last.replace(/^\d{4}-\d{2}-\d{2}(?:T[\d-]+)?-(?:[A-Za-z0-9]{4}-)?/, ""));
			return cap(t || last);
		}
		const first = n.replace(/<[^<>]{1,40}>\s*/g, "").split(/(?<=[.!?])\s|\n/)[0]!.trim() || n; // "<kernel planning> push…" loses its tag
		return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
	};

	// ---- One display title per record ----
	// A title made from a slug that leaves under three words, or shouts in capitals, says little ("Widget", "MEMORY"): it is
	// replaced by the first sentence of the record's own text, read once and kept in this browser, so every page and every load
	// shows the same title. am.title fills a DOM node and updates it when the better title arrives.
	const TITLES = "am.titles.v4", kept = new Map<string, [string, string]>(); // record key -> [updated, title]
	try { for (const [k, v] of Object.entries(JSON.parse(win.localStorage?.getItem(TITLES) ?? "{}") as Record<string, unknown>)) if (Array.isArray(v)) kept.set(k, [String(v[0]), String(v[1])]); } catch { /* none kept */ }
	let saving = false;
	const keep = () => { if (saving) return; saving = true; win.setTimeout(() => { saving = false; try { win.localStorage?.setItem(TITLES, JSON.stringify(Object.fromEntries([...kept].slice(-4000)))); } catch { /* not kept */ } }, 1500); };
	// Also slug-like whatever its source: an angle-bracket tag, a command fragment ("S=…", "..."), or stray single letters ("dynav a h").
	const fragment = (name: string, title: string) => /<[^<>]{1,40}>/.test(name) || /=|\.\.\.|…/.test(title) || title.split(/\s+/).some((w) => /^[b-hj-z]$/i.test(w));
	const weakTitle = (name: string, title: string) => /^Untitled /.test(title) || fragment(name, title) || (!/\s/.test(name.trim()) && (title.split(/\s+/).filter(Boolean).length < 3 || (/[A-Z]/.test(title) && title === title.toUpperCase())));
	const firstSentence = (t: string) => { const x = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^<>]{1,40}>\s*/g, "").replace(/^\s*#+\s*/gm, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/[*`>]|(?<!\w)_|_(?!\w)/g, "").replace(/^\s*\[[^\]]*\]\s*/, "").trim().split(/(?<=[.!?])\s|\n/)[0]!.trim(); return x.length > 90 ? `${x.slice(0, 87).trimEnd()}…` : x; };
	const showing = new Map<string, Set<J>>(), asked = new Set<string>(), waiting: (() => Promise<void>)[] = [];
	let reading = 0;
	const next = () => { while (reading < 4 && waiting.length) { reading++; void waiting.shift()!().finally(() => { reading--; next(); }); } };
	/** Settles an item's title from its text (a node read's description or body), everywhere it shows. */
	const settle = (it: J, text: string) => {
		if (!it?.weak) return;
		const t = firstSentence(text);
		it.weak = false;
		if (!t || t.length < 4) return;
		it.title = t;
		kept.set(it.key, [String(it.updated ?? ""), t]);
		keep();
		for (const n of showing.get(it.key) ?? []) n.textContent = t;
		showing.delete(it.key);
	};
	/** The one display title of an item; with a node, also writes it there and keeps it current. */
	const title = (it: J, into?: J): string => {
		if (into) into.textContent = it.title;
		if (into && it.weak) {
			(showing.get(it.key) ?? showing.set(it.key, new Set()).get(it.key)!).add(into);
			if (!asked.has(it.key)) {
				asked.add(it.key);
				waiting.push(async () => {
					try { const r: J = await call(`/api/profiles/${enc(it.p)}/nodes/${enc(it.id)}`); settle(it, String(r?.node?.description || r?.content?.text || "")); } catch { /* the slug title stays */ }
				});
				next();
			}
		}
		return it.title;
	};

	// ---- Projects: the owner's registry, read from their own memory ----
	// A project is a normalized GitHub owner/repo. Which repos are projects, their short names, the workspaces (folders) holding
	// them, scope aliases and what is never a project are the owner's data, not code: each profile may hold one memory named
	// REGISTRY (a reference document whose text is JSON, shape below). The dashboard reads it with the record read it already
	// uses, validates every entry (stored data: bad entries are skipped, never rendered as HTML) and merges the profiles'
	// registries. With none at all, capture tags (project_key, workspace) and GitHub keys in scopes still place records.
	//   { "workspaces": [{ "id": "labs", "name": "Labs", "order": 1 }],  // they belong to this record's profile; "order" sorts them
	//     "owners": ["acme-corp"],                               // GitHub owners whose repos belong to this record's profile
	//     "default_workspace": "labs",                           // where this profile's unlisted repos go
	//     "repos": [{ "key": "acme-corp/widget", "name": "widget", "workspaces": ["labs"] }],
	//     "aliases": { "widget": "acme-corp/widget", "labs": "ws:labs", "old-scope": "acme-corp/widget?" },  // "?" = medium confidence
	//     "drop": ["tool-label"], "not_projects": ["acme-corp/notes"] }
	const REGISTRY = "dashboard-project-registry";
	type Reg = { ws: Map<string, { name: string; profile: string }>; order: string[]; owners: Map<string, string>; repos: Map<string, { alias: string; homes: string[]; profile: string }>;
		scopes: Map<string, string>; drop: Set<string>; notProjects: Set<string>; defaults: Map<string, string> };
	const blankReg = (): Reg => ({ ws: new Map(), order: [], owners: new Map(), repos: new Map(), scopes: new Map(), drop: new Set(["", "default"]), notProjects: new Set(), defaults: new Map() });
	let reg = blankReg();
	const parsed = new Map<string, J>(); // profile -> its registry JSON, as read
	const WS_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/, REPO_KEY = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
	const short = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
	/** Builds the merged registry from every profile's JSON, skipping anything malformed. Profiles merge in name order. */
	const rebuildReg = () => {
		const next = blankReg(), rank = new Map<string, number>();
		for (const [profile, raw] of [...parsed].sort((x, y) => x[0].localeCompare(y[0]))) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			for (const w of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
				const id = short(w?.id, 40)?.toLowerCase();
				if (!id || !WS_ID.test(id) || next.ws.has(id)) continue;
				next.ws.set(id, { name: short(w?.name, 40) ?? id, profile });
				next.order.push(id);
				rank.set(id, typeof w?.order === "number" && Number.isFinite(w.order) ? w.order : 1e6 + next.order.length);
			}
			for (const o of Array.isArray(raw.owners) ? raw.owners : []) { const k = short(o, 100)?.toLowerCase(); if (k && /^[a-z0-9_.-]+$/.test(k) && !next.owners.has(k)) next.owners.set(k, profile); }
			const dw = short(raw.default_workspace, 40)?.toLowerCase();
			if (dw && WS_ID.test(dw)) next.defaults.set(profile, dw);
			for (const r of Array.isArray(raw.repos) ? raw.repos : []) {
				const key = short(r?.key, 201)?.toLowerCase();
				if (!key || !REPO_KEY.test(key) || next.repos.has(key)) continue;
				const homes = (Array.isArray(r?.workspaces) ? r.workspaces : []).map((x: unknown) => short(x, 40)?.toLowerCase()).filter((x: string | undefined): x is string => !!x && WS_ID.test(x));
				next.repos.set(key, { alias: short(r?.name, 40) ?? "", homes, profile });
			}
			if (raw.aliases && typeof raw.aliases === "object" && !Array.isArray(raw.aliases))
				for (const [k, v] of Object.entries(raw.aliases as Record<string, unknown>)) {
					const scope = short(k, 160)?.toLowerCase(), to = short(v, 210)?.toLowerCase();
					if (scope && to && /^(ws:[a-z0-9][a-z0-9_-]{0,39}|[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100})\??$/.test(to) && !next.scopes.has(scope)) next.scopes.set(scope, to);
				}
			for (const d of Array.isArray(raw.drop) ? raw.drop : []) { const k = short(d, 160)?.toLowerCase(); if (k) next.drop.add(k); }
			for (const d of Array.isArray(raw.not_projects) ? raw.not_projects : []) { const k = short(d, 201)?.toLowerCase(); if (k && REPO_KEY.test(k)) next.notProjects.add(k); }
		}
		next.order.sort((x, y) => rank.get(x)! - rank.get(y)!);
		reg = next;
		WS_ORDER.splice(0, WS_ORDER.length, ...reg.order);
	};
	/**
	 * Each active profile's registry record, read once per library generation: found by name in that profile's graph when the
	 * page loads it (no extra request), else by a lexical recall for the name (a read; profiles this view does not load still
	 * own repos and workspaces it shows). Its text is read through the node read, every page of it.
	 */
	const regRead = new Set<string>();
	const readRegistry = (p: Profile, g: Graph | null) => {
		if (regRead.has(p.name)) return;
		let id: string | null = null;
		if (g) {
			const node = [...g.nodes.values()].find((n) => n.name === REGISTRY && n.status === "active");
			if (!node && !g.parts.nodes.done) return; // look again once the graph has every record
			id = node?.id ?? "";
		}
		regRead.add(p.name);
		void (async () => {
			try {
				if (id === null) {
					const r: J = await call(`/api/profiles/${enc(p.name)}/recall`, "POST", { keyword: REGISTRY, type: "reference", limit: 5, channels: ["lexical"], count_hits: false });
					id = (Array.isArray(r?.results) ? r.results : []).find((x: J) => x?.name === REGISTRY)?.memory_id ?? "";
				}
				if (!id) { parsed.delete(p.name); return; }
				const base = `/api/profiles/${enc(p.name)}/nodes/${enc(String(id))}`, r: J = await call(base);
				let text = typeof r?.content?.text === "string" ? r.content.text : "";
				if (r?.content?.complete === false) {
					text = "";
					let cursor: string | null = null;
					for (let i = 0; i < 20; i++) { const page: J = await call(`${base}?content=all${cursor ? `&cursor=${enc(cursor)}` : ""}`); text += String(page?.content?.content ?? ""); cursor = typeof page?.content?.cursor === "string" ? page.content.cursor : null; if (!cursor) break; }
				}
				let raw: J = null;
				try { raw = JSON.parse(text); } catch { raw = null; } // not JSON: as if this profile had no registry
				if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed.set(p.name, raw); else parsed.delete(p.name);
			} catch { parsed.delete(p.name); } // unreadable: places fall back to the generic rules
			finally { rebuildReg(); cache = null; fire(); }
		})();
	};
	/** The profile a repo belongs to: its owner's registry, else the registry listing it, else the caller's fallback. */
	const profileOf = (key: string, fallback: string) => reg.owners.get(key.split("/")[0]!) ?? reg.repos.get(key)?.profile ?? fallback;
	/** A workspace seen only in a capture tag or a profile (no registry names it) still shows, named after itself. */
	const ensureWs = (id: string, profile: string) => {
		if (reg.ws.has(id)) return id;
		reg.ws.set(id, { name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`, profile });
		if (!WS_ORDER.includes(id)) WS_ORDER.push(id);
		return id;
	};
	const wsProfile = (w: string) => reg.ws.get(w)?.profile ?? w;
	const WS_ORDER: string[] = [];
	/** A GitHub key from a project key ("github:Owner/Repo"), a repo key ("github.com/owner/repo") or a GitHub URL; null otherwise. */
	const githubKey = (value: string): string | null => {
		let s = value.trim();
		if (s.startsWith("github:")) s = s.slice(7);
		else if (/^https?:\/\//i.test(s)) { try { const u = new URL(s); if (u.hostname.toLowerCase() !== "github.com") return null; s = u.pathname.slice(1); } catch { return null; } }
		else if (/^git@github\.com:/i.test(s)) s = s.replace(/^git@[^:]+:/, "");
		else if (/^github\.com\//i.test(s)) s = s.slice(11);
		else return null;
		s = s.replace(/\/$/, "").replace(/\.git$/i, "");
		const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
		return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
	};
	type Place = { workspace: string | null; project: string | null; confidence: "high" | "medium" | null; profile: string | null; drop?: boolean; workspaces?: string[] };
	/** The workspaces holding a repo: the registry's, else the profile's default, else a workspace named after the profile. */
	const homeOf = (key: string, profile: string) => { const h = reg.repos.get(key)?.homes ?? []; return h.length ? h : [ensureWs(reg.defaults.get(profile) ?? profile, profile)]; };
	const FIXTURE_NODES = new Set(["40e647a4-713a-5ea9-85bc-b9ddf5ec1956", "aae69dd8-26c3-5f3a-97f4-fd419ac2141c"]); // this repo's own acceptance fixtures
	const fixture = (s: string) => /^am-accept-|^fixture\//.test(s) || s === "dashboard-smoke";
	/**
	 * Where a record belongs: a capture-tagged project_key, a repo key or a project node's own key; then a tagged workspace;
	 * then a registry alias of its scope (or a GitHub key written as the scope); else nothing (never a made-up project).
	 * With a registry, only its repos are projects (any other key names only its workspace); with none, any GitHub key is.
	 */
	const placeOf = (r: { profile: string; scope?: string | null; name?: string | null; key?: string | null; kind?: string; id?: string; repo_key?: string | null;
		project_key?: string | null; workspace?: string | null }): Place => {
		const none: Place = { workspace: null, project: null, confidence: null, profile: null };
		const scope = String(r.kind === "project" ? r.name ?? "" : r.scope ?? "").trim().toLowerCase();
		if ((r.id && FIXTURE_NODES.has(r.id)) || fixture(scope) || /synthetic|am-accept/i.test(String(r.name ?? "")) && r.kind === "project") return { ...none, drop: true };
		const project = (key: string, confidence: "high" | "medium"): Place => {
			const profile = profileOf(key, r.profile), homes = homeOf(key, profile);
			if ((reg.repos.size && !reg.repos.has(key)) || reg.notProjects.has(key)) return { workspace: homes[0]!, project: null, confidence, profile };
			return { workspace: homes[0]!, workspaces: homes, project: key, confidence, profile };
		};
		const explicit = githubKey(String(r.project_key ?? "")) ?? githubKey(String(r.repo_key ?? "")) ?? githubKey(String(r.key ?? ""));
		if (explicit) return /synthetic|am-accept|fixture/.test(explicit) ? { ...none, drop: true } : project(explicit, "high");
		// A tagged record with no repo still names its workspace folder (a known one, or any name when there is no registry).
		const wsId = String(r.workspace ?? "").trim().toLowerCase();
		if (wsId && WS_ID.test(wsId) && (reg.order.includes(wsId) || !reg.order.length)) { ensureWs(wsId, r.profile); return { workspace: wsId, project: null, confidence: "high", profile: wsProfile(wsId) }; }
		if (reg.drop.has(scope)) return { ...none, drop: true };
		const hit = reg.scopes.get(scope) ?? (r.kind === "project" ? reg.scopes.get(scope.replace(/\s+/g, "-")) : undefined);
		if (!hit) { const k = githubKey(scope); return k ? project(k, "high") : none; }
		const medium = hit.endsWith("?"), v = medium ? hit.slice(0, -1) : hit;
		if (v.startsWith("ws:")) { const w = v.slice(3); if (!reg.ws.has(w)) return none; return { workspace: w, project: null, confidence: medium ? "medium" : "high", profile: wsProfile(w) }; }
		return project(v, medium ? "medium" : "high");
	};

	// ---- The library: what the pages list and connect ----
	type Kind = "memory" | "learning" | "journal" | "person" | "project" | "session";
	type Item = { key: string; p: string; id: string; kind: Kind; raw: string; type: string | null; name: string; title: string; weak?: boolean; scope: string | null;
		created: string | null; updated: string | null; origin: string | null; agent: string | null; pinned: boolean; virtual?: boolean; workspace?: string; wide?: boolean;
		alias?: string; url?: string; known?: boolean; filedUnder?: string; filedCount?: number; medium?: boolean; workspaces?: string[]; projectKey?: string | null; tagWorkspace?: string | null };
	type Lib = { items: Map<string, Item>; links: Map<string, Map<string, Set<string>>>; list: Record<Kind, Item[]>; loading: boolean; errors: string[]; missing: boolean; unsorted: number };
	const kindOf = (n: J): Kind | null => n.kind === "journal" ? "journal" : n.kind === "rule" || n.kind === "preference" || n.type === "feedback" || n.type === "user" ? "learning"
		: n.kind === "person" ? "person" : n.kind === "project" ? "project" : n.kind === "session" ? "session" : n.type || n.kind === "decision" || n.kind === "document" ? "memory" : null;
	const REL: Record<string, string> = { works_on: "works on", authored: "wrote", reviewed: "reviewed", reported: "reported", assigned: "assigned", part_of: "part of",
		depends_on: "depends on", implements: "implements", fixes: "fixes", introduced_by: "introduced by", caused_by: "caused by", blocked_by: "blocked by",
		decided_because: "decided because of", supersedes: "replaces", contradicts: "contradicts", relates_to: "related", other: "related" };
	let cache: { stamp: string; lib: Lib } | null = null;
	const subs = new Set<() => void>();
	let pending: unknown = null;
	const fire = () => { if (pending) return; pending = setTimeout(() => { pending = null; for (const f of [...subs]) f(); }, 120); };

	/** The library over `only` (null: every active profile). Starts any missing read; onChange runs (debounced) as pages arrive. */
	const library = (only: string | null, onChange?: () => void): Lib => {
		// All profiles means the owner's real ones: the "test" profile shows only when chosen by name.
		const ps = am.active().filter((p) => (only === null ? p.name !== "test" : p.name === only));
		if (onChange) { subs.clear(); subs.add(onChange); }
		// A part that failed after its retries waits for the refresh (or Retry), so a paint never restarts it in a loop.
		const gs = ps.map((p) => { const g = graphOf(p); if (!g.loading && !(g.parts.nodes.done && g.parts.edges.done) && !g.parts.nodes.error && !g.parts.edges.error && !g.missing) void pump(p, g); return [p, g] as const; });
		// The owner's project registry: from each loaded graph, and by name for the other real profiles.
		for (const q of am.active()) if (q.name !== "test" || only === "test") readRegistry(q, gs.find(([x]) => x.name === q.name)?.[1] ?? null);
		const stamp = `${only}|${gs.map(([p, g]) => `${p.name}:${g.nodes.size}:${g.edges.size}`).join(",")}`;
		if (cache?.stamp === stamp) return { ...cache.lib, loading: gs.some(([, g]) => g.loading), errors: gs.flatMap(([p, g]) => (["nodes", "edges"] as const).flatMap((k) => g.parts[k].error ? [`${p.name}: ${g.parts[k].error}`] : [])) };
		const items = new Map<string, Item>(), links = new Map<string, Map<string, Set<string>>>();
		const connect = (a: string, b: string, rel: string) => {
			if (a === b) return;
			for (const [x, y] of [[a, b], [b, a]] as [string, string][]) { let m = links.get(x); if (!m) links.set(x, m = new Map()); let s = m.get(y); if (!s) m.set(y, s = new Set()); s.add(rel); }
		};
		// One project item per GitHub key, across stored profiles; one Workspace-wide item per workspace. Every known repo exists,
		// so "Show all known repos" can list the ones with nothing in memory yet.
		const projectItem = (key: string, fallback: string): string => {
			const p = profileOf(key, fallback), homes = homeOf(key, p), alias = reg.repos.get(key)?.alias;
			const k = `${p}/gh:${key}`; // the same profile/id shape as every item, so its address resolves
			// Humans know a repo by its short local name; the GitHub repo name is behind the GitHub link.
			if (!items.has(k)) items.set(k, { key: k, p, id: `gh:${key}`, kind: "project", raw: "project", type: null, name: key, title: alias || key.split("/")[1]!, scope: null,
				created: null, updated: null, origin: null, agent: null, pinned: false, virtual: true, workspace: homes[0], workspaces: homes,
				alias: alias || undefined, url: `https://github.com/${key}`, known: reg.repos.has(key) });
			return k;
		};
		const wideItem = (w: string): string => {
			const k = `${wsProfile(w)}/ws:${w}`;
			if (!items.has(k)) items.set(k, { key: k, p: wsProfile(w), id: `ws:${w}`, kind: "project", raw: "project", type: null, name: reg.ws.get(w)?.name ?? w, title: "Workspace-wide",
				scope: null, created: null, updated: null, origin: null, agent: null, pinned: false, virtual: true, workspace: w, wide: true });
			return k;
		};
		let unsorted = 0;
		for (const [p, g] of gs) {
			const projOfNode = new Map<string, () => string>(); // project node id -> makes (once) the project item it stands for
			for (const n of g.nodes.values()) {
				if (n.status !== "active" || n.name === REGISTRY) continue; // the registry is settings, not a memory to list
				const kind = kindOf(n);
				if (!kind) continue;
				if (kind === "project") {
					const at = placeOf({ profile: p.name, kind: "project", name: n.name, key: n.key, id: n.id });
					const proj = at.project, ws = at.workspace;
					if (proj) projOfNode.set(n.id, () => projectItem(proj, p.name));
					else if (ws) projOfNode.set(n.id, () => wideItem(ws));
					continue; // project nodes become registry projects, never projects of their own
				}
				const key = `${p.name}/${n.id}`, agent = kind === "session" ? n.key?.split(":")[1] ?? null : /^task-journal-.*?-(claude-code|codex)-/.exec(n.name)?.[1] ?? null;
				const src = n.label && kind !== "journal" ? n.label : n.name, made = kind === "session" ? `${AGENTS[agent ?? ""] ?? "Agent"} session` : human(src, kind);
				const k0 = kept.get(key), had = k0 && k0[0] === String(n.updated ?? "") ? k0[1] : null;
				const weak = !had && (kind === "memory" || kind === "learning" || kind === "journal") && weakTitle(src, made);
				items.set(key, { key, p: p.name, id: n.id, kind, raw: n.kind, type: n.type, name: n.name, title: had ?? made, weak, scope: n.scope, created: n.created ?? null, updated: n.updated, origin: n.origin ?? null,
					agent: agent ? AGENTS[agent] ?? agent : null, pinned: false, projectKey: n.projectKey ?? null, tagWorkspace: n.workspace ?? null });
			}
			const member = new Map<string, Map<() => string, string>>(); // record key -> project items it links to, with how
			for (const e of g.edges.values()) {
				const a = `${p.name}/${e.a}`, b = `${p.name}/${e.b}`, pa = projOfNode.get(e.a), pb = projOfNode.get(e.b);
				if (items.has(a) && items.has(b)) connect(a, b, REL[e.rel] ?? e.rel.replace(/_/g, " "));
				else if (items.has(a) && pb) (member.get(a) ?? member.set(a, new Map()).get(a)!).set(pb, REL[e.rel] ?? "in project");
				else if (items.has(b) && pa) (member.get(b) ?? member.set(b, new Map()).get(b)!).set(pa, REL[e.rel] ?? "in project");
			}
			// Assign each record: explicit project links first (one, never a guess between several), then its scope, else Unsorted.
			for (const it of [...items.values()]) {
				if (it.p !== p.name || it.virtual || it.kind === "session") continue;
				// A project exists only when a memory, learning or journal resolves to it; people join existing projects afterwards.
				if (it.kind === "person") continue;
				const made = [...(member.get(it.key) ?? [])].map(([mk, rel]) => [mk(), rel] as const), linked = made.map(([k]) => k);
				// Every explicit link to a project stays, with its relation; only a single one decides the record's own place.
				for (const [t, rel] of made) connect(it.key, t, rel);
				let target: string | null = null, medium = false, derived: string | null = null;
				if (linked.length === 1) derived = items.get(linked[0]!)!.p;
				else if (linked.length === 0) {
					const at = placeOf({ profile: p.name, scope: it.scope, kind: it.kind, project_key: it.projectKey, workspace: it.tagWorkspace });
					if (at.project) target = projectItem(at.project, p.name); else if (at.workspace) target = wideItem(at.workspace);
					medium = at.confidence === "medium";
					derived = at.profile;
				}
				if (derived && derived !== it.p && linked.length === 1) it.filedUnder = it.p;
				if (target) {
					connect(it.key, target, medium ? "probably in project" : "in project");
					if (medium) it.medium = true;
					if (derived && derived !== it.p) it.filedUnder = it.p; // derived from GitHub; the record is not moved
				} else if (!linked.length) unsorted++;
			}
			// People linked to a project node join that project only when memories made it a project.
			for (const it of items.values()) {
				if (it.p !== p.name || it.kind !== "person") continue;
				for (const [mk, rel] of member.get(it.key) ?? []) { const before = items.size, k = mk(); if (items.size > before) items.delete(k); else connect(it.key, k, rel); }
			}
		}
		// A project's dates come from what is in it; a mismatch on any of its records shows on the project too.
		for (const it of items.values()) if (it.virtual) for (const k of links.get(it.key)?.keys() ?? []) {
			const o = items.get(k)!;
			if ((o.updated ?? "") > (it.updated ?? "")) it.updated = o.updated;
			if (!it.created || (o.created ?? "~") < it.created) it.created = o.created;
			if (o.filedUnder) { it.filedUnder ??= o.filedUnder; it.filedCount = (it.filedCount ?? 0) + 1; }
		}
		const list = { memory: [], learning: [], journal: [], person: [], project: [], session: [] } as Record<Kind, Item[]>;
		for (const it of items.values()) list[it.kind].push(it);
		const recent = (a: Item, b: Item) => (b.updated ?? "").localeCompare(a.updated ?? "");
		for (const k of Object.keys(list) as Kind[]) list[k].sort(k === "person" || k === "project" ? (a, b) => (links.get(b.key)?.size ?? 0) - (links.get(a.key)?.size ?? 0) || recent(a, b) : recent);
		const lib: Lib = { items, links, list, unsorted, loading: gs.some(([, g]) => g.loading), missing: gs.some(([, g]) => g.missing),
			errors: gs.flatMap(([p, g]) => (["nodes", "edges"] as const).flatMap((k) => g.parts[k].error ? [`${p.name}: ${g.parts[k].error}`] : [])) };
		cache = { stamp, lib };
		return lib;
	};

	/** The page of an item: memories, learnings, journals, people or projects; sessions have no page. */
	// People have no page for now (the owner removed the tab); a person shows only as a plain, unlinked chip.
	const TABS: Record<string, string> = { memory: "memories", learning: "learnings", journal: "journals", project: "projects" };
	const href = (it: Item, profile?: string | null) => TABS[it.kind] ? `#${TABS[it.kind]}/${enc(it.p)}/${enc(it.id)}${profile ? `?profile=${enc(profile)}` : ""}` : "";
	Object.assign(am, { graphs, graphOf, pump, library, resync: () => { am.setSync?.({ state: "loading", at: lastSync }); void resync(); }, when, time, human, title, settleTitle: settle, itemHref: href, placeOf, workspaceName: (w: string) => reg.ws.get(w)?.name ?? w, workspaceProfile: wsProfile, workspaceOrder: WS_ORDER });
}
