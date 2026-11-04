// Graph: the knowledge graph canvas at #/, #/graph/P(/ID) and #graph(/ID)?profile=P, restyled after agentmemory v0.9.31 with
// shapes by kind, a toolbar, zoom, a node detail panel and "Queue link maintenance". It stays a page, not a registered tab, so
// the site root and every old route keep opening it. Browser code, serialized into /app.js: it may use only `am` and browser
// globals (type imports are erased).
import type { Am, Failure, GEdge, GNode, Graph, J, Node, Profile } from "./am";

export function graphTab(am: Am): void {
	const { act, btn, call, copy, curl, doc, el, enc, facts, input, link, live, mcpCall, note, recorded, render, switcher, textBlock, why, win } = am;

	// The knowledge graph (section 15), the dashboard's home: every record and link of one profile, drawn on one canvas from the
	// owner whole-graph read (metadata only, paged), so loaded and total counts are the server's. A selected record's detail is read
	// only when it is selected. Cached per profile generation; nothing here writes, and no link is drawn that the server did not send.
	const graphs = new Map<string, Graph>();
	const GROUPS: [string, string][] = [["m:project", "Project memories"], ["m:feedback", "Feedback"], ["m:reference", "References"], ["m:user", "About the owner"],
		["m:procedural", "Procedures"], ["e:project", "Projects"], ["e:component", "Components"], ["e:person", "People"], ["e:ticket", "Tickets"], ["e:bug", "Bugs"],
		["e:feature", "Features"], ["e:pr", "Pull requests"], ["e:commit", "Commits"], ["e:release", "Releases"], ["e:decision", "Decisions"], ["e:other", "Other"]];
	const GROUP_NAME = new Map(GROUPS);
	// Five kinds of node, each with its own shape and hue, so a node reads by shape alone; the legend and detail chip show both.
	// Index order is SHAPES; HUES hold the light and dark steps, each at least 3:1 against the canvas in its theme.
	const SHAPES = ["circle", "star", "diamond", "hexagon", "square"] as const;
	type Shape = (typeof SHAPES)[number];
	const GLYPH = ["●", "★", "◆", "⬢", "■"];
	const HUES = { light: ["#2a78d6", "#c4402c", "#1d8a57", "#7c4dbd", "#9a6200"], dark: ["#5b9ee9", "#f0806f", "#6cc79b", "#b294ee", "#e2ad55"] };
	const shapeAt = (g: string) => g.startsWith("m:") ? 0 : g === "e:project" ? 1 : g === "e:person" ? 2 : ["e:ticket", "e:bug", "e:feature", "e:decision"].includes(g) ? 3 : 4;
	/** One shape as a closed subpath around (x, y); points and corners are scaled so every shape covers about the same area. */
	const shapePath = (c: J, s: Shape, x: number, y: number, r: number) => {
		if (s === "circle") { c.moveTo(x + r, y); c.arc(x, y, r, 0, 2 * Math.PI); return; }
		const n = s === "hexagon" ? 6 : s === "star" ? 10 : 4, turn = s === "square" ? Math.PI / 4 : s === "hexagon" ? Math.PI / 6 : -Math.PI / 2;
		const R = r * (s === "square" ? 1.25 : s === "star" ? 1.45 : s === "diamond" ? 1.35 : 1.1);
		for (let i = 0; i < n; i++) {
			const a = turn + (i * 2 * Math.PI) / n, rr = s === "star" && i % 2 ? R * 0.45 : R, px = x + rr * Math.cos(a), py = y + rr * Math.sin(a);
			if (i) c.lineTo(px, py); else c.moveTo(px, py);
		}
	};
	const groupOf = (type: string | null, kind: string) => type ? (GROUP_NAME.has(`m:${type}`) ? `m:${type}` : "e:other") : GROUP_NAME.has(`e:${kind}`) ? `e:${kind}` : "e:other";
	const SPACING = 14, GOLDEN = Math.PI * (3 - Math.sqrt(5));
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
		const kind = str(it.kind) ?? "other", type = str(it.type), group = groupOf(type, kind), list = g.groups.get(group) ?? [];
		g.nodes.set(id, { id, name: str(it.name) ?? "(no name)", kind, label: str(it.other_label), type, scope: str(it.scope), status: str(it.status) ?? "active",
			updated: str(it.updated_at), group, seq: list.length, x: 0, y: 0, deg: 0, opaque: 0, flagged: it.flagged === true });
		list.push(id);
		g.groups.set(group, list);
		g.dirty = true;
		for (const e of g.pending.get(id) ?? []) link2(g, e);
		g.pending.delete(id);
	};
	/** A link joins the drawing once both ends are loaded records; until then it waits, so no end is invented. */
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
		// A far end that is not a record shown here (another profile, a moved record, a capture) is counted on its record, never drawn.
		if (it.dst.readable !== true) {
			if (!g.edges.has(`x:${id}`)) { g.edges.set(`x:${id}`, { id: `x:${id}`, a, b: "", rel: str(it.rel) ?? "" }); g.opaque++; const n = g.nodes.get(a); if (n) n.opaque++; }
			return;
		}
		link2(g, { id, a, b, rel: str(it.rel) ?? "relates_to" });
	};
	/** Walks the nodes and edges parts in parallel with the server's cursors, at its default page sizes; edges join nodes on id. */
	const pump = async (p: Profile, g: Graph) => {
		if (g.loading) return;
		g.loading = true;
		await Promise.all((["nodes", "edges"] as const).map(async (part) => {
			const ph = g.parts[part];
			while (!ph.done && !ph.error && !g.missing) {
				try {
					const first = !ph.next, r: J = await call(`/api/profiles/${enc(p.name)}/graph?part=${part}${ph.next ? `&after=${enc(ph.next)}` : ""}`);
					if (!Array.isArray(r?.items) || graphs.get(`${p.name}:${p.generation ?? ""}`) !== g) return; // a reload replaced this walk
					for (const it of r.items) (part === "nodes" ? addNode : addEdge)(g, it);
					if (first && part === "nodes") ph.total = typeof r.total === "number" ? r.total : null;
					ph.next = str(r.next_after);
					ph.done = r.done === true || !ph.next;
					if (r.changed === true) g.changed = true;
				} catch (err) {
					const e = err as Failure;
					if (e.status === 404 && !g.nodes.size && part === "nodes") g.missing = true;
					else ph.error = why(err);
				}
				g.listener?.();
				await new Promise((r) => setTimeout(r, 0)); // yield between pages so the canvas stays responsive
			}
		}));
		g.loading = false;
		g.listener?.();
	};
	/** Groups as discs in a fixed order, wrapped in rows; records spiral out from their disc's centre in load order. O(records). */
	const layout = (g: Graph, shown: (n: GNode) => boolean) => {
		const discs: { group: string; ids: string[]; r: number; x: number; y: number }[] = [];
		for (const [group] of GROUPS) {
			const ids = (g.groups.get(group) ?? []).filter((id) => shown(g.nodes.get(id)!));
			if (ids.length) discs.push({ group, ids, r: Math.max(80, SPACING * Math.sqrt(ids.length) + SPACING * 2), x: 0, y: 0 });
		}
		const width = Math.max(600, Math.sqrt(discs.reduce((s, d) => s + (2 * d.r + 60) ** 2, 0)) * 1.6);
		let x = 0, y = 0, row = 0;
		for (const d of discs) {
			if (x > 0 && x + 2 * d.r > width) { x = 0; y += row + 60; row = 0; }
			d.x = x + d.r; d.y = y + d.r; x += 2 * d.r + 60; row = Math.max(row, 2 * d.r);
			d.ids.forEach((id, i) => {
				const n = g.nodes.get(id)!, r = SPACING * Math.sqrt(i + 0.5), a = i * GOLDEN;
				n.x = d.x + r * Math.cos(a); n.y = d.y + r * Math.sin(a);
			});
		}
		return discs;
	};

	const graphPage = (view: Node, p: Profile, selectId?: string) => {
		const version = am.pageVersion, g = graphOf(p);
		am.intro(view, "Knowledge graph", "graph", "Every record of one profile and the links the server holds between them. Shape and colour show the kind. Select a node for its relations, where it came from and its raw record.");
		const wrap = el("div", view);
		wrap.setAttribute("class", "graph");
		const stage = el("section", wrap), side = el("aside", wrap);
		stage.setAttribute("aria-label", "Knowledge graph");
		side.setAttribute("aria-label", "Find and inspect records");
		const head = el("div", stage);
		head.setAttribute("class", "graph-head");
		const h = el("h2", head, `Knowledge graph: ${p.name}`);
		switcher(head, "graph", p.name);
		const statusLine = live(stage);
		am.pageStatus(stage); // the queue's outcome after a write
		// Toolbar: find (press /), the type filter with counts, node and relation counts, zoom, and the owner's one write here.
		const tools = el("div", stage);
		tools.setAttribute("class", "toolbar");
		const qLabel = el("label", tools, "Find a node");
		qLabel.setAttribute("for", "graph-q");
		qLabel.setAttribute("class", "vh");
		const search = el("input", tools);
		search.setAttribute("id", "graph-q");
		search.setAttribute("type", "search");
		search.setAttribute("placeholder", "Find a node (press /)");
		search.setAttribute("aria-keyshortcuts", "/");
		search.setAttribute("data-search", "");
		const tLabel = el("label", tools, "Filter by type");
		tLabel.setAttribute("for", "graph-type");
		tLabel.setAttribute("class", "vh");
		const typeSel = el("select", tools);
		typeSel.setAttribute("id", "graph-type");
		const counts = el("span", tools);
		counts.setAttribute("class", "muted mono");
		am.help(tools, "relations");
		const confirmBox = el("div", stage);
		const canvas: J = el("canvas", stage);
		canvas.setAttribute("tabindex", "0");
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", "Graph of this profile's records. Arrow keys pan, plus and minus zoom, 0 fits, Enter selects the first match. Press / to find a node.");
		const legend = el("ul", stage);
		legend.setAttribute("class", "legend");
		legend.setAttribute("aria-label", "Kinds by shape and colour; uncheck to hide");
		el("p", stage, "Shape and colour show the kind; size grows with links. A ring marks a record with links into another profile. Records with no links are drawn without lines; that is what the server holds.").setAttribute("class", "na");
		// Side panel: matches, the selected record, and what-if changes.
		const linkedOnly = el("label", side);
		linkedOnly.setAttribute("class", "field");
		const linkedBox = el("input", linkedOnly);
		linkedBox.setAttribute("type", "checkbox");
		el("span", linkedOnly, " Only records with links");
		const pastLabel = el("label", side);
		pastLabel.setAttribute("class", "field");
		const pastBox = el("input", pastLabel);
		pastBox.setAttribute("type", "checkbox");
		const pastText = el("span", pastLabel, " Include retired and superseded records");
		const matchNote = el("p", side);
		const matches = el("ul", side);
		matches.setAttribute("class", "matches");
		matches.setAttribute("aria-label", "Matching records");
		matches.setAttribute("data-list", "");
		const detail = el("section", side);
		detail.setAttribute("aria-label", "Selected record");
		detail.setAttribute("class", "panel");
		const scenario = el("section", side);
		scenario.setAttribute("aria-label", "What-if changes, not saved");

		const hidden = new Set<string>();
		let typeFilter = "", typeKey = "";
		let query = "", selected: string | null = selectId ?? null, hover: string | null = null, matched: GNode[] = [], matchSet = new Set<string>();
		let discs: ReturnType<typeof layout> = [], grid = new Map<string, GNode[]>(), cam = { x: 0, y: 0, k: 1 }, fitted = false, moved = false, frame = false, detailRequest = 0;
		// Per-layout state, so a frame reads no DOM and filters nothing: the drawable records, their ids, and each record's linked ids.
		let vis: GNode[] = [], visIds = new Set<string>(), adj = new Map<string, string[]>(), showPast = false, onlyLinked = false;
		const ctx = canvas.getContext?.("2d") ?? null;
		// The canvas size is read only when it may have changed (resize), never per frame or per pointer move.
		let cw = 800, ch = 560, dpr = 1;
		const measure = () => {
			const w = canvas.clientWidth || 800, hh = canvas.clientHeight || 560, d = win.devicePixelRatio || 1;
			if (w === cw && hh === ch && d === dpr) return false;
			cw = w; ch = hh; dpr = d;
			if (!moved) fitted = false; // an untouched view refits; a moved one keeps its centre and scale
			return true;
		};
		measure();
		// Canvas pixels follow neither CSS nor a browser's forced dark mode, so the canvas palette follows the canvas's actual computed
		// background: read once here and again only on a resize or a theme change, never per frame. Text takes the first candidate
		// reaching 4.5:1 against it; shapes and the legend use the dark or light steps of the same five hues.
		type Theme = { id: string; bg: string; ink: string; muted: string; ring: string; edge: string; hues: string[] };
		const rgbOf = (c: unknown): number[] | null => {
			const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(typeof c === "string" ? c : "");
			return m && (m[4] === undefined || parseFloat(m[4]) > 0) ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
		};
		const lum = (c: number[]) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
		const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
		const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
		let theme: Theme | undefined;
		const readTheme = () => {
			const css = (e: unknown) => { try { return win.getComputedStyle?.(e)?.backgroundColor; } catch { return undefined; } };
			const bg = rgbOf(css(canvas)) ?? rgbOf(css(doc.body)) ?? (win.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? [26, 28, 29] : [251, 252, 253]);
			const dark = lum(bg) < 0.18, pick = (c: string[]) => c.find((x) => ratio(hex(x), bg) >= 4.5) ?? (dark ? "#ffffff" : "#000000");
			const next: Theme = { id: bg.join(","), bg: `rgb(${bg.join(",")})`, ink: pick(dark ? ["#e6edf3"] : ["#1b1f24"]), muted: pick(dark ? ["#9da7b3", "#c9d1d9"] : ["#57606a", "#424a53"]),
				ring: dark ? "#e6edf3" : "#1b1f24", edge: dark ? "rgba(157,167,179,0.65)" : "rgba(87,96,106,0.65)", hues: dark ? HUES.dark : HUES.light };
			const changed = next.id !== theme?.id;
			theme = next;
			return changed;
		};
		readTheme();
		const shown = (n: GNode) => !hidden.has(n.group) && (!typeFilter || n.group === typeFilter) && (n.status === "active" || showPast) && (!onlyLinked || n.deg > 0 || n.opaque > 0);
		// The what-if view over loaded metadata only; the saved graph `g` is never changed. A removed record takes its loaded links with it.
		let linkFrom: string | null = null; // a record waiting for the other end of a what-if link
		const editsOf = () => { let e = am.whatIfEdits.get(p.name); if (!e) am.whatIfEdits.set(p.name, e = { add: [], cut: new Set(), drop: new Set() }); return e; };
		const tidy = () => { const e = am.whatIfEdits.get(p.name); if (e && !e.add.length && !e.cut.size && !e.drop.size) am.whatIfEdits.delete(p.name); };
		const scenarioOf = () => {
			const e = am.whatIfEdits.get(p.name), items = am.whatIf.get(p.name) ?? [];
			const drop = new Set([...(e?.drop ?? [])].filter((id) => g.nodes.has(id))), kept = (id: string) => g.nodes.has(id) && !drop.has(id);
			const gone = new Set<string>(), delta = new Map<string, number>(), bump = (id: string, d: number) => delta.set(id, (delta.get(id) ?? 0) + d);
			for (const x of g.edges.values()) if (x.b && (e?.cut.has(x.id) || drop.has(x.a) || drop.has(x.b))) { gone.add(x.id); bump(x.a, -1); bump(x.b, -1); }
			const added = (e?.add ?? []).filter(([a, b]) => kept(a) && kept(b)), hung = items.filter((w) => kept(w.target)); // new memories whose record stays
			for (const [a, b] of added) { bump(a, 1); bump(b, 1); }
			for (const w of hung) bump(w.target, 1);
			return { e, items, drop, gone, added, hung, delta, kept };
		};
		const relayout = () => {
			discs = layout(g, shown);
			vis = []; visIds = new Set(); grid = new Map(); adj = new Map();
			for (const n of g.nodes.values()) {
				if (!shown(n)) continue;
				vis.push(n); visIds.add(n.id);
				const k = `${Math.floor(n.x / 32)},${Math.floor(n.y / 32)}`, cell = grid.get(k);
				if (cell) cell.push(n); else grid.set(k, [n]);
			}
			for (const e of g.edges.values()) if (e.b) for (const [x, y] of [[e.a, e.b], [e.b, e.a]] as const) { const l = adj.get(x); if (l) l.push(y); else adj.set(x, [y]); }
			layoutVersion++;
			g.dirty = false;
		};
		const fit = () => {
			if (!discs.length) return;
			const x0 = Math.min(...discs.map((d) => d.x - d.r)), x1 = Math.max(...discs.map((d) => d.x + d.r)), y0 = Math.min(...discs.map((d) => d.y - d.r)), y1 = Math.max(...discs.map((d) => d.y + d.r));
			cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: Math.min(4, Math.max(0.05, Math.min(cw / (x1 - x0 + 80), (ch - 24) / (y1 - y0 + 80)))) };
			fitted = true;
		};
		const toWorld = (sx: number, sy: number) => ({ x: (sx - cw / 2) / cam.k + cam.x, y: (sy - ch / 2) / cam.k + cam.y });
		const radius = (n: GNode) => 3 + Math.min(5, Math.sqrt(n.deg));
		const pick = (sx: number, sy: number) => {
			const w = toWorld(sx, sy), reach = Math.max(8 / cam.k, 6);
			let best: string | null = null, bestD = Infinity;
			for (let gx = Math.floor((w.x - reach) / 32); gx <= Math.floor((w.x + reach) / 32); gx++) for (let gy = Math.floor((w.y - reach) / 32); gy <= Math.floor((w.y + reach) / 32); gy++) {
				for (const n of grid.get(`${gx},${gy}`) ?? []) { const d = Math.hypot(n.x - w.x, n.y - w.y); if (d < reach + radius(n) && d < bestD) { best = n.id; bestD = d; } }
			}
			return best;
		};
		// Nodes are drawn as one native path per kind (five fills for the whole library), into a cached layer: a frame stamps that one
		// bitmap (a pan moves it, a wheel zoom in progress scales it) and the dots are drawn again only when the zoom settles, the layout
		// changes or the pixel ratio does. Zoomed in past the layer's size cap, the dots in view are drawn directly, the same way.
		const LAYER_PIXELS = 16_000_000, PAD = 12;
		const dots = (c: J, k: number, ox: number, oy: number, keep: (n: GNode) => boolean) => {
			let n = 0;
			const scale = Math.min(1.6, Math.max(0.6, Math.sqrt(k)));
			for (let s = 0; s < SHAPES.length; s++) {
				c.fillStyle = theme!.hues[s];
				c.beginPath();
				for (const d of vis) {
					if (shapeAt(d.group) !== s || !keep(d)) continue;
					shapePath(c, SHAPES[s]!, d.x * k + ox, d.y * k + oy, radius(d) * scale);
					n++;
				}
				c.fill();
			}
			return n;
		};
		let layer: J = null, layerKey = "", layerAt = { x: 0, y: 0, k: 1, n: 0 }, layoutVersion = 0, zooming = 0, settleTimer: ReturnType<typeof setTimeout> | undefined;
		/** Draws every drawable dot at zoom k into the layer; leaves no layer when that would pass the size cap. */
		const buildLayer = (k: number, key: string) => {
			layerKey = key;
			if (!discs.length) { layer = null; return; }
			const x0 = Math.min(...discs.map((d) => d.x - d.r)), x1 = Math.max(...discs.map((d) => d.x + d.r)), y0 = Math.min(...discs.map((d) => d.y - d.r)), y1 = Math.max(...discs.map((d) => d.y + d.r));
			const w = Math.ceil(((x1 - x0) * k + 2 * PAD) * dpr), hh = Math.ceil(((y1 - y0) * k + 2 * PAD) * dpr);
			if (w * hh > LAYER_PIXELS || w > 8192 || hh > 8192) { layer = null; return; }
			const c = layer ?? doc.createElement("canvas");
			if (c.width !== w) c.width = w;
			if (c.height !== hh) c.height = hh;
			const lc = c.getContext?.("2d");
			if (!lc) { layer = null; return; }
			lc.setTransform(dpr, 0, 0, dpr, 0, 0);
			lc.clearRect(0, 0, w, hh);
			layerAt = { x: x0 - PAD / k, y: y0 - PAD / k, k, n: dots(lc, k, PAD - x0 * k, PAD - y0 * k, () => true) };
			layer = c;
		};
		const widths = new Map<string, number>(); // measured text widths, per font and text
		const widthOf = (font: string, t: string): number => {
			const k = `${font}|${t}`, known = widths.get(k);
			if (known !== undefined) return known;
			ctx.font = font;
			const w = Number(ctx.measureText(t).width) || t.length * 7;
			widths.set(k, w);
			return w;
		};
		let drawn = -1; // records drawn in the last frame, kept on the canvas for measurement
		const whatIfAt: [number, number, string][] = []; // this frame's what-if positions, labelled after the real ones are drawn
		const GROUP_FONT = "600 13px system-ui, sans-serif", NAME_FONT = "12px system-ui, sans-serif";
		const draw = () => {
			frame = false;
			if (version !== am.pageVersion) return;
			if (g.dirty) { relayout(); if (!moved) fitted = false; } // the view follows the loading graph until the owner pans or zooms
			if (!fitted) fit();
			if (!ctx) return;
			// Width and height are checked apart, so a height-only change resizes the backing store too.
			const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
			if (canvas.width !== bw) canvas.width = bw;
			if (canvas.height !== bh) canvas.height = bh;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, cw, ch);
			const k = cam.k, ox = cw / 2 - cam.x * k, oy = ch / 2 - cam.y * k, scale = Math.min(1.6, Math.max(0.6, Math.sqrt(k)));
			const x0 = (-20 - ox) / k, x1 = (cw + 20 - ox) / k, y0 = (-20 - oy) / k, y1 = (ch + 20 - oy) / k;
			const inView = (n: GNode) => n.x > x0 && n.x < x1 && n.y > y0 && n.y < y1;
			// Text is placed only where it fits: inside the canvas and clear of text already placed (a screen grid of 8 px cells).
			const taken = new Set<number>();
			const place = (x: number, y: number, w: number, hgt: number) => {
				if (x < 2 || y - hgt < 2 || x + w > cw - 2 || y + 2 > ch) return false;
				const c0 = Math.floor(x / 8), c1 = Math.floor((x + w) / 8), r0 = Math.floor((y - hgt) / 8), r1 = Math.floor((y + 2) / 8);
				for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) if (taken.has(cy * 4096 + cx)) return false;
				for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) taken.add(cy * 4096 + cx);
				return true;
			};
			ctx.lineWidth = 1;
			const t = theme!, sc = am.whatIf.has(p.name) || am.whatIfEdits.has(p.name) ? scenarioOf() : null;
			ctx.strokeStyle = t.edge;
			ctx.beginPath();
			for (const e of g.edges.values()) {
				if (!e.b || !visIds.has(e.a) || !visIds.has(e.b) || sc?.gone.has(e.id)) continue;
				const a = g.nodes.get(e.a)!, b = g.nodes.get(e.b)!;
				if (!inView(a) && !inView(b)) continue;
				ctx.moveTo(a.x * k + ox, a.y * k + oy); ctx.lineTo(b.x * k + ox, b.y * k + oy);
			}
			ctx.stroke();
			const focus = selected ? new Set([selected, ...(adj.get(selected) ?? [])]) : null;
			let count = 0;
			ctx.globalAlpha = focus || matchSet.size ? 0.35 : 1;
			const key = `${layoutVersion}:${k}:${dpr}:${theme!.id}`, settled = Date.now() - zooming > 150;
			if (layerKey !== key && (settled || !layer)) buildLayer(k, key);
			if (layer && (layerAt.k === k || !settled)) {
				const s = k / layerAt.k;
				ctx.drawImage(layer, layerAt.x * k + ox, layerAt.y * k + oy, (layer.width / dpr) * s, (layer.height / dpr) * s);
				count = layerAt.n;
				// A scaled layer is a placeholder: draw it sharp once the wheel has been still for a moment.
				if (layerAt.k !== k) { clearTimeout(settleTimer); settleTimer = setTimeout(schedule, 160); }
			} else count = dots(ctx, k, ox, oy, inView);
			ctx.globalAlpha = 1;
			// The emphasis ring is a circle just outside the shape's points; the selected node's is thicker than a match's.
			const emphasise = (n: GNode, ring: string, width: number) => {
				const x = n.x * k + ox, y = n.y * k + oy, r = radius(n) * scale, s = shapeAt(n.group);
				ctx.fillStyle = t.hues[s]!; ctx.beginPath(); shapePath(ctx, SHAPES[s]!, x, y, r); ctx.fill();
				ctx.strokeStyle = ring; ctx.lineWidth = width; ctx.beginPath(); ctx.arc(x, y, r * 1.45 + 2, 0, 2 * Math.PI); ctx.stroke();
			};
			if (k > 0.6) { ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.beginPath(); for (const n of vis) if (n.opaque && inView(n)) { const x = n.x * k + ox, y = n.y * k + oy, r = radius(n) * scale * 1.45 + 3; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 2 * Math.PI); } ctx.stroke(); }
			for (const id of matchSet) { const n = g.nodes.get(id); if (n && visIds.has(id) && inView(n)) emphasise(n, t.ink, 2); }
			if (focus) for (const id of focus) { const n = g.nodes.get(id); if (n && visIds.has(id) && inView(n)) emphasise(n, id === selected ? t.ring : t.bg, id === selected ? 3 : 2); }
			// What-if changes (this tab only, never saved), dashed and outside the dot layer: a new memory is a ring on a line from its real
			// record, an added link a line in the text colour; a removed link is a muted dashed line and a removed record is crossed out.
			if (sc) {
				ctx.save?.();
				ctx.setLineDash?.([4, 3]);
				ctx.lineWidth = 1.5;
				const xy = (id: string) => { const n = g.nodes.get(id); return n && visIds.has(id) ? [n.x * k + ox, n.y * k + oy, inView(n)] as const : null; };
				const line = (a: string, b: string) => { const p1 = xy(a), p2 = xy(b); if (p1 && p2 && (p1[2] || p2[2])) { ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke(); } };
				ctx.strokeStyle = t.muted;
				for (const id of sc.gone) { const e = g.edges.get(id)!; line(e.a, e.b); }
				for (const id of sc.drop) {
					const q = xy(id);
					if (!q?.[2]) continue;
					const [x, y] = q, r = radius(g.nodes.get(id)!) * scale + 4;
					ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
					whatIfAt.push([x + 6, y + 14, `Removed: ${g.nodes.get(id)!.name}`]);
				}
				ctx.strokeStyle = t.ink;
				for (const [a, b] of sc.added) line(a, b);
				sc.items.forEach((w, i) => {
					const q = xy(w.target);
					if (!q?.[2] || sc.drop.has(w.target)) return;
					const [x, y] = q, a = -Math.PI / 4 + i * 0.9, hx = x + 34 * Math.cos(a), hy = y + 34 * Math.sin(a);
					ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hx, hy); ctx.stroke();
					ctx.beginPath(); ctx.arc(hx, hy, 6, 0, 2 * Math.PI); ctx.stroke();
					whatIfAt.push([hx + 9, hy + 4, `What-if: ${w.name}`]);
				});
				ctx.restore?.();
				ctx.setLineDash?.([]);
			}
			// Record names first, most important first, then group headings where room is left; the legend always names every group.
			// Text gets a halo in the surface colour, so it stays readable where it crosses a link or a dot.
			ctx.font = NAME_FONT;
			ctx.fillStyle = t.ink;
			ctx.strokeStyle = t.bg;
			ctx.lineWidth = 3;
			ctx.lineJoin = "round";
			const text = (s: string, x: number, y: number) => { ctx.strokeText(s, x, y); ctx.fillText(s, x, y); };
			const label = (n: GNode) => {
				const name = n.name.length > 40 ? `${n.name.slice(0, 39)}…` : n.name, w = widthOf(NAME_FONT, name), x = n.x * k + ox, y = n.y * k + oy + 4, r = radius(n) * scale + 4;
				// Right of the dot, or left of it near the right edge.
				for (const lx of [x + r, x - r - w]) if (place(lx, y, w, 12)) { text(name, lx, y); return; }
			};
			const important = [...new Set([...(selected ? [selected] : []), ...(hover ? [hover] : []), ...(focus ?? []), ...[...matchSet].slice(0, 50)])];
			for (const id of important) { const n = g.nodes.get(id); if (n && visIds.has(id) && inView(n)) label(n); }
			// What-if labels next, so a hypothetical item stays named, ahead of the bulk of names shown when zoomed in.
			for (const [lx0, ly, s1] of whatIfAt.splice(0)) { const s2 = s1.length > 41 ? `${s1.slice(0, 40)}…` : s1, w = widthOf(NAME_FONT, s2); for (const lx of [lx0, lx0 - 18 - w]) if (place(lx, ly, w, 12)) { text(s2, lx, ly); break; } }
			if (k >= 1.4) { let shownLabels = 0; for (const n of vis) { if (shownLabels >= 150) break; if (inView(n)) { label(n); shownLabels++; } } }
			ctx.font = GROUP_FONT;
			ctx.fillStyle = t.muted;
			for (const d of [...discs].sort((a, b) => b.ids.length - a.ids.length)) {
				const full = `${GROUP_NAME.get(d.group)} (${d.ids.length})`, w = widthOf(GROUP_FONT, full), cx = d.x * k + ox;
				// Centred over the disc, kept inside the canvas; below it if the top is taken; left out if neither fits.
				const lx = Math.min(Math.max(cx - w / 2, 4), cw - 4 - w);
				for (const y of [(d.y - d.r) * k + oy - 6, (d.y + d.r) * k + oy + 16]) if (place(lx, y, w, 14)) { text(full, lx, y); break; }
			}
			if (count !== drawn) { drawn = count; canvas.setAttribute("data-drawn", String(count)); }
		};
		const schedule = () => {
			if (frame) return;
			frame = true;
			if (win.requestAnimationFrame) win.requestAnimationFrame(draw); else setTimeout(draw, 0);
		};
		const scheme = win.matchMedia?.("(prefers-color-scheme: dark)");
		const resized = () => {
			if (version !== am.pageVersion) { win.removeEventListener?.("resize", resized); scheme?.removeEventListener?.("change", resized); return; }
			const sized = measure(), themed = readTheme();
			if (themed) refresh(); // the legend shares the canvas hues
			else if (sized) schedule();
		};
		scheme?.addEventListener?.("change", resized);
		win.addEventListener("resize", resized);
		if (win.ResizeObserver) { const ro = new win.ResizeObserver(() => { if (version !== am.pageVersion) ro.disconnect(); else resized(); }); ro.observe(canvas); }

		const count = (n: number | null) => (n === null ? "?" : n.toLocaleString("en"));
		// The what-if comparison: only facts the loaded metadata gives, before and after the unsaved changes; nothing else is inferred.
		let detailSync = () => {}; // keeps the selected record's what-if buttons in step with the list below
		const nameOf = (id: string) => g.nodes.get(id)?.name ?? "a record not loaded";
		const changed = () => { tidy(); renderScenario(); schedule(); };
		const renderScenario = () => {
			scenario.replaceChildren();
			detailSync();
			const sc = scenarioOf(), { e, items } = sc;
			if (!items.length && !e) return;
			el("h3", scenario, "What-if (not saved)");
			note(scenario, "These exist only in this tab and are never sent. Make a draft to review and save a new memory through Write; the saved graph above them is unchanged.");
			const links = [...g.edges.values()].filter((x) => x.b).length;
			let linked = 0, after = 0;
			for (const n of g.nodes.values()) { if (n.deg > 0) linked++; if (sc.kept(n.id) && n.deg + (sc.delta.get(n.id) ?? 0) > 0) after++; }
			facts(scenario, [["Records", `${count(g.nodes.size)} saved → ${count(g.nodes.size - sc.drop.size + items.length)} with what-if`],
				["Links", `${count(links)} → ${count(links - sc.gone.size + sc.added.length + sc.hung.length)}`], ["Records with links", `${count(linked)} → ${count(after + sc.hung.length)}`]]);
			if (!g.parts.nodes.done || !g.parts.edges.done) note(scenario, "Counted over what has loaded so far.");
			const links2 = (id: string) => { const n = g.nodes.get(id); return n ? ` (its links ${n.deg} → ${sc.kept(id) ? n.deg + (sc.delta.get(id) ?? 0) : 0})` : ""; };
			const ul = el("ul", scenario);
			items.forEach((w, i) => {
				const li = el("li", ul, `New memory: ${w.name}, linked to “${w.targetName}”${!g.nodes.has(w.target) ? " (its record is not in this graph)" : sc.drop.has(w.target) ? " (its record is removed in this what-if)" : links2(w.target)} `);
				btn(li, "Make a draft", () => am.draftFromWhatIf(p.name, w, li), `Make a draft from ${w.name}`);
				btn(li, "Remove", () => { items.splice(i, 1); if (!items.length) am.whatIf.delete(p.name); changed(); }, `Remove ${w.name}`);
			});
			// Link and record changes show their effect only; they have no draft, and the saved records change only through their own pages.
			e?.add.forEach(([a, b], i) => {
				btn(el("li", ul, `Added link: “${nameOf(a)}” and “${nameOf(b)}” `), "Remove", () => { e.add.splice(i, 1); changed(); }, `Remove the what-if link between ${nameOf(a)} and ${nameOf(b)}`);
			});
			for (const id of e?.cut ?? []) {
				const x = g.edges.get(id), label = x ? `“${nameOf(x.a)}” ${x.rel} “${nameOf(x.b)}”` : "a link not loaded";
				btn(el("li", ul, `Removed link: ${label} `), "Restore", () => { e!.cut.delete(id); changed(); }, `Restore the link ${label}`);
			}
			for (const id of e?.drop ?? []) {
				const n = g.nodes.get(id);
				btn(el("li", ul, `Removed record: “${nameOf(id)}”${n ? ` and its ${n.deg} loaded link${n.deg === 1 ? "" : "s"}` : ""} `), "Restore", () => { e!.drop.delete(id); changed(); }, `Restore ${nameOf(id)}`);
			}
			if (e) note(scenario, "Link and record changes cannot be saved or made into a draft from here; they only show the effect.");
			btn(scenario, "Clear all what-if items", () => { am.whatIf.delete(p.name); am.whatIfEdits.delete(p.name); linkFrom = null; changed(); });
		};
		const refresh = () => {
			if (version !== am.pageVersion) return;
			const nodes = g.parts.nodes, edges = g.parts.edges, links = [...g.edges.values()].filter((e) => e.b).length;
			const past = [...g.nodes.values()].filter((n) => n.status !== "active").length, waiting = [...g.pending.values()].reduce((s, l) => s + l.length, 0);
			const parts = g.missing ? ["This server does not offer the whole-graph read yet, so the graph cannot be drawn. Browse records in Memories meanwhile."]
				: [nodes.total === null ? `${count(g.nodes.size)} records loaded${nodes.done ? " (all)" : nodes.error ? "; loading stopped" : "; loading…"}`
					: `${count(g.nodes.size)} of ${count(nodes.total)} records loaded${nodes.done ? "" : nodes.error ? "; loading stopped" : "; loading…"}`,
					`${count(links)} links${edges.done ? "" : edges.error ? "; loading stopped" : " so far; loading…"}`,
					...(g.opaque ? [`${count(g.opaque)} links lead to records not readable in this profile`] : []),
					...(nodes.done && edges.done && waiting ? [`${count(waiting)} links wait for records that were not listed`] : []),
					...(g.changed ? ["The profile changed while loading; reload for a fresh graph"] : []),
					...(nodes.error || edges.error ? [`Could not load everything: ${nodes.error ?? edges.error}`] : [])];
			statusLine.textContent = `${parts.join(" · ")}.`;
			retry.hidden = !(nodes.error || edges.error);
			reload.hidden = !g.changed;
			pastText.textContent = ` Include retired and superseded records (${past.toLocaleString("en")})`;
			if (!g.missing && nodes.done && !g.nodes.size) statusLine.textContent = "This profile holds no records yet.";
			counts.textContent = `${count(g.nodes.size)} nodes · ${count(links)} relations`;
			// The type filter's options change only when a count does, so an open list is not rebuilt under the pointer.
			const opts: [string, string][] = [["", `All types (${count(g.nodes.size)})`]];
			for (const [group, name] of GROUPS) { const n = g.groups.get(group)?.length ?? 0; if (n) opts.push([group, `${name} (${count(n)})`]); }
			const key = opts.map((o) => o[1]).join("|");
			if (key !== typeKey) { typeKey = key; typeSel.replaceChildren(); for (const [v, t] of opts) el("option", typeSel, t).setAttribute("value", v); typeSel.value = typeFilter; }
			const ready = !g.missing && nodes.done && edges.done && !nodes.error && !edges.error && !g.changed;
			queueBtn.disabled = !ready;
			queueBtn.setAttribute("title", ready ? "Queue every unlinked active memory for the next consolidation batch" : "Available once the whole graph has loaded");
			legend.replaceChildren();
			for (const [group, name] of GROUPS) {
				const n = g.groups.get(group)?.length ?? 0;
				if (!n) continue;
				const s = shapeAt(group), li = el("li", legend), l = el("label", li), box = el("input", l), glyph = el("span", l, ` ${GLYPH[s]}`);
				box.setAttribute("type", "checkbox");
				box.checked = !hidden.has(group);
				box.addEventListener("change", () => { if (box.checked) hidden.delete(group); else hidden.add(group); g.dirty = true; fitted = false; runSearch(false); schedule(); });
				glyph.setAttribute("aria-hidden", "true");
				glyph.setAttribute("style", `color:${theme!.hues[s]}`);
				el("span", l, ` ${name} (${n.toLocaleString("en")})`);
				el("span", l, `, drawn as a ${SHAPES[s]}`).setAttribute("class", "vh");
			}
			runSearch(false);
			renderScenario();
			schedule();
		};
		const zoom = (f: number) => { moved = true; cam.k = Math.min(8, Math.max(0.03, cam.k * f)); schedule(); };
		btn(tools, "+", () => zoom(1.4), "Zoom in");
		btn(tools, "−", () => zoom(1 / 1.4), "Zoom out");
		btn(tools, "Fit", () => { moved = false; fit(); schedule(); }, "Fit the graph to the view");

		// "Queue link maintenance" (REBUILD in agentmemory): every active memory with no link the loaded graph shows, none waiting
		// for an unlisted record, goes to the owner queue in requests of at most QUEUE_MAX. The queue is fingerprinted, so a repeat
		// queues nothing; the next consolidation batch does the linking.
		const QUEUE_MAX = 40;
		const unlinked = () => {
			const waiting = new Set<string>();
			for (const l of g.pending.values()) for (const e of l) { waiting.add(e.a); waiting.add(e.b); }
			return [...g.nodes.values()].filter((n) => n.type !== null && n.status === "active" && !n.deg && !n.opaque && !waiting.has(n.id)).map((n) => n.id);
		};
		const sendQueue = (ids: string[]) => act(async () => {
			let queued = 0, sent = 0;
			try {
				for (; sent < ids.length; sent += QUEUE_MAX) {
					const r: J = await call(`/api/profiles/${enc(p.name)}/maintenance/queue`, "POST", { kind: "unlinked", ids: ids.slice(sent, sent + QUEUE_MAX) });
					queued += Number.isSafeInteger(r?.queued) ? r.queued : 0;
				}
			} catch (err) { return { queued, sent, error: why(err) }; }
			return { queued, sent, error: null };
		}, "queue link maintenance", undefined, (r: J) => ({ text: r.error
			? `Queued ${r.queued} of ${ids.length} unlinked memories, then a request failed after ${r.sent} were sent: ${r.error}.`
			: `Queued ${r.queued} of ${ids.length} unlinked memories for link maintenance${r.queued < ids.length ? `; the queue took no new item for the other ${ids.length - r.queued}` : ""}.` }));
		const queueBtn = btn(tools, "Queue link maintenance", () => {
			const ids = unlinked();
			confirmBox.replaceChildren();
			const ask = el("p", confirmBox, ids.length
				? `Queue ${ids.length} unlinked active memor${ids.length === 1 ? "y" : "ies"} for link maintenance? The next consolidation batch looks for links for each one. Queuing changes no record.`
				: "No active memory in this profile is without links, so there is nothing to queue.");
			ask.setAttribute("tabindex", "-1");
			if (ids.length) btn(confirmBox, `Queue ${ids.length}`, () => { confirmBox.replaceChildren(); void sendQueue(ids); });
			const cancel = btn(confirmBox, ids.length ? "Cancel" : "Close", () => { confirmBox.replaceChildren(); queueBtn.focus(); });
			cancel.setAttribute("data-close", "");
			ask.focus();
		});
		link(tools, `#/memories/${enc(p.name)}`, "List view");
		const retry = btn(tools, "Retry loading", () => { for (const ph of Object.values(g.parts)) ph.error = null; pump(p, g); refresh(); });
		retry.hidden = true;
		// A fresh walk replaces the cached graph; the old walk's late pages are dropped.
		const reload = btn(tools, "Reload graph", () => { graphs.delete(`${p.name}:${p.generation ?? ""}`); render(false); });
		reload.hidden = true;
		typeSel.addEventListener("change", () => { typeFilter = typeSel.value; g.dirty = true; fitted = false; runSearch(false); schedule(); });

		const runSearch = (announce: boolean) => {
			const q = query.trim().toLowerCase();
			matched = q ? [...g.nodes.values()].filter((n) => shown(n) && `${n.name} ${n.type ?? n.kind} ${n.scope ?? ""}`.toLowerCase().includes(q)) : [];
			matchSet = new Set(matched.map((n) => n.id));
			matches.replaceChildren();
			for (const n of matched.slice(0, 50)) btn(el("li", matches), n.name, () => select(n.id, true), `${n.name}, ${GROUP_NAME.get(n.group)}`).setAttribute("data-item", "");
			matchNote.textContent = !q ? "" : matched.length ? `${matched.length.toLocaleString("en")} match${matched.length === 1 ? "" : "es"}${matched.length > 50 ? "; the first 50 are listed" : ""}${g.parts.nodes.done ? "" : " among the records loaded so far"}.` : "No loaded record matches.";
			if (announce) schedule();
		};
		search.addEventListener("input", () => { query = search.value; runSearch(true); });
		search.addEventListener("keydown", (event: J) => { if (event.key === "Enter" && matched[0]) { event.preventDefault(); select(matched[0].id, true); } });
		linkedBox.addEventListener("change", () => { onlyLinked = linkedBox.checked; g.dirty = true; fitted = false; refresh(); });
		pastBox.addEventListener("change", () => { showPast = pastBox.checked; g.dirty = true; fitted = false; refresh(); });

		/** Brings a record into view at a readable zoom. */
		const center = (n: GNode) => { moved = true; if (g.dirty) relayout(); cam.x = n.x; cam.y = n.y; cam.k = Math.max(cam.k, 1.4); schedule(); };
		const kindText = (n: GNode) => (n.type ? `${n.type} memory` : `${n.kind}${n.label ? ` (${n.label})` : ""}`);
		/** The kind as text, after its shape in its hue: the colour is never the only cue. */
		const kindChip = (parent: Node, n: GNode) => {
			const s = shapeAt(n.group), c = el("span", parent), gl = el("span", c, `${GLYPH[s]} `);
			c.setAttribute("class", "chip");
			gl.setAttribute("aria-hidden", "true");
			gl.setAttribute("style", `color:${theme!.hues[s]}`);
			el("span", c, kindText(n));
		};
		const idle = () => note(detail, "Select a node on the canvas or in the matches to see its relations, where it came from and its record.");
		/**
		 * Selects a record without moving the graph, unless asked to bring it into view. The panel shows at once what the loaded graph
		 * holds (kind, relations, linked projects, sessions and memories) and reads the record once per selection for its evidence,
		 * details, history and raw row. The address becomes #graph/ID, so a selection is a deep link.
		 */
		const select = (id: string | null, reveal = false) => {
			selected = id;
			const req = ++detailRequest, syncs: (() => void)[] = [];
			detail.replaceChildren();
			detailSync = () => { for (const f of syncs) f(); };
			schedule();
			// The newer deep link keeps the profile, so it opens this profile's graph again, never work's by default.
			try { win.history?.replaceState?.(null, "", `#graph${id ? `/${enc(id)}` : ""}?profile=${enc(p.name)}`); } catch { /* the address stays; the selection is the same */ }
			if (!id) { idle(); return; }
			const n = g.nodes.get(id);
			if (n && reveal) center(n);
			const top = el("div", detail);
			top.setAttribute("class", "toolbar");
			if (n) {
				kindChip(top, n);
				el("span", top, `${count(n.deg)} relation${n.deg === 1 ? "" : "s"}${n.opaque ? `, ${count(n.opaque)} to other profiles` : ""}`).setAttribute("class", "muted");
			}
			btn(top, "Close", () => { select(null); canvas.focus?.(); }, "Close the node detail").setAttribute("data-close", "");
			const title = el("h3", detail, n?.name ?? "Record");
			const acts = el("div", detail);
			acts.setAttribute("class", "toolbar");
			btn(acts, "Center", () => { const m = g.nodes.get(id); if (m) center(m); }, "Center the graph on this node").disabled = !n;
			copy(acts, "Copy ID", () => id);
			copy(acts, "Copy name", () => String(title.textContent));
			copy(acts, "Copy MCP call", () => mcpCall("explore", { node: { id }, profile: p.name }));
			copy(acts, "Copy curl", () => curl("GET", `/api/profiles/${enc(p.name)}/nodes/${enc(id)}`));
			const section = (label: string) => { const s = el("section", detail); el("h4", s, label); return s; };
			const neighbours = [...g.edges.values()].filter((e) => e.b && (e.a === id || e.b === id));
			const linked = (keep: (o: GNode) => boolean) => [...new Map(neighbours.map((e) => g.nodes.get(e.a === id ? e.b : e.a)!).filter(keep).map((o) => [o.id, o])).values()];
			const pick = (parent: Node, o: GNode) => btn(parent, o.name, () => select(o.id, true), `Select ${o.name}, ${kindText(o)}`);

			const rel = section("Relations");
			if (neighbours.length) {
				const ul = el("ul", rel);
				ul.setAttribute("aria-label", "Linked records");
				for (const e of neighbours.slice(0, 30)) {
					const out = e.a === id, other = g.nodes.get(out ? e.b : e.a)!, li = el("li", ul), s = shapeAt(other.group);
					el("span", li, out ? "→" : "←").setAttribute("aria-hidden", "true");
					el("span", li, out ? "Outgoing" : "Incoming").setAttribute("class", "vh");
					el("span", li, ` ${e.rel} `);
					const gl = el("span", li, `${GLYPH[s]} `);
					gl.setAttribute("aria-hidden", "true");
					gl.setAttribute("style", `color:${theme!.hues[s]}`);
					pick(li, other);
					const cut = btn(li, "", () => { const c = editsOf().cut; if (c.has(e.id)) c.delete(e.id); else c.add(e.id); changed(); });
					syncs.push(() => {
						const on = am.whatIfEdits.get(p.name)?.cut.has(e.id) ?? false;
						cut.textContent = on ? "Restore link (what-if)" : "Remove link (what-if)";
						cut.setAttribute("aria-label", `${on ? "Restore" : "Remove"} the link ${e.rel} with ${other.name}, not saved`);
					});
				}
				if (neighbours.length > 30) note(rel, `${neighbours.length - 30} more links; open the record for all of them.`);
			} else if (n && g.parts.edges.done) note(rel, n.opaque ? "Its only links go to other profiles." : "No links: this record stands alone.");
			else note(rel, "Links are still loading.");

			// Where it came from: linked projects and sessions from the graph, then the record's own session evidence once read.
			const origin = section("Where it came from");
			const projects = linked((o) => o.kind === "project" && !o.type), sessions = linked((o) => o.kind === "session");
			const projRow = el("p", origin), sessRow = el("p", origin);
			el("span", projRow, "Projects: ");
			for (const o of projects) pick(projRow, o);
			if (!projects.length) el("span", projRow, "none linked").setAttribute("class", "na");
			el("span", sessRow, "Sessions: ");
			for (const o of sessions) pick(sessRow, o);
			const sessEvidence = el("span", sessRow, "reading evidence…");
			sessEvidence.setAttribute("class", "na");
			const obs = section("Observations");
			am.loading(obs, 2);
			const mems = section("Memories");
			const memories = linked((o) => o.type !== null);
			if (memories.length) { const ul = el("ul", mems); for (const o of memories) { const li = el("li", ul); pick(li, o); el("span", li, ` ${o.type}`).setAttribute("class", "muted"); } }
			else note(mems, n && !g.parts.edges.done ? "Links are still loading." : "No linked memories.");
			const det = section("Details");
			if (n) facts(det, [["ID", id], ["Kind", kindText(n)], ["Group", GROUP_NAME.get(n.group) ?? n.kind], ["Scope", recorded(n.scope)], ["Status", n.status], ["Updated", recorded(n.updated)]]);
			const more = el("div", det);
			am.loading(more, 3);

			const nav = el("p", detail);
			link(nav, `#/memory/${enc(p.name)}/${enc(id)}`, "Open the record");
			el("span", nav, " · ");
			link(nav, `#/timeline/${enc(p.name)}/${enc(id)}`, "Timeline");
			el("span", nav, " · ");
			link(nav, `#/path/${enc(p.name)}/${enc(id)}`, "Find a path");
			if (n) {
				// A local, unsaved what-if: a new memory linked to this record, drawn on the graph and compared beside it.
				const wf = el("form", detail);
				const wn = input(wf, "graph-whatif", `What-if: a new memory linked to “${n.name}” (not saved)`);
				wn.setAttribute("maxlength", "512");
				el("button", el("p", wf), "Add to the graph (not saved)").setAttribute("type", "submit");
				wf.addEventListener("submit", (event) => {
					event.preventDefault();
					const nm = wn.value.trim();
					if (!nm) { wn.focus(); return; }
					am.whatIf.set(p.name, [...(am.whatIf.get(p.name) ?? []), { name: nm, target: id, targetName: n.name }]);
					wn.value = "";
					renderScenario();
					schedule();
				});
				// Unsaved changes to saved things: remove this record (and its loaded links), or link it to another loaded record.
				const edit = el("p", detail);
				const drop = btn(edit, "", () => { const d = editsOf().drop; if (d.has(id)) d.delete(id); else d.add(id); changed(); });
				el("span", edit, " ");
				const linking = el("span", edit);
				syncs.push(() => {
					const on = am.whatIfEdits.get(p.name)?.drop.has(id) ?? false;
					drop.textContent = on ? "Restore this record (what-if)" : "Remove this record (what-if)";
					drop.setAttribute("aria-label", `${on ? "Restore" : "Remove"} ${n.name} and its loaded links, not saved`);
					linking.replaceChildren();
					const from = linkFrom && g.nodes.has(linkFrom) ? linkFrom : null;
					if (from === id) {
						el("span", linking, "Select another record to link it to. ");
						btn(linking, "Cancel linking", () => { linkFrom = null; detailSync(); });
					} else if (from) {
						const sc = scenarioOf(), have = (x: GEdge) => x.b && !sc.gone.has(x.id) && ((x.a === from && x.b === id) || (x.a === id && x.b === from));
						if (!sc.kept(from) || !sc.kept(id)) el("span", linking, "A removed record cannot be linked in this what-if. ");
						else if ([...g.edges.values()].some(have) || sc.added.some(([a, b]) => (a === from && b === id) || (a === id && b === from))) el("span", linking, `Already linked to “${nameOf(from)}”. `);
						else btn(linking, `Link to “${nameOf(from)}” (what-if)`, () => { editsOf().add.push([from, id]); linkFrom = null; changed(); });
						btn(linking, "Cancel linking", () => { linkFrom = null; detailSync(); });
					} else btn(linking, "Link to another record (what-if)…", () => { linkFrom = id; detailSync(); search.focus?.(); }); // the other end is found through the search
				});
			}
			detailSync();
			(async () => {
				let r: J;
				const failed = (t: string) => { sessEvidence.textContent = ""; obs.replaceChildren(); el("h4", obs, "Observations"); note(obs, t); more.replaceChildren(); note(more, t); };
				try { r = await call(`/api/profiles/${enc(p.name)}/nodes/${enc(id)}`); } catch (err) { if (version === am.pageVersion && req === detailRequest) failed(`Could not load the record: ${why(err)}`); return; }
				if (version !== am.pageVersion || req !== detailRequest) return;
				const node: J = r?.node ?? {}, ev: J[] = Array.isArray(r?.evidence?.items) ? r.evidence.items : [];
				if (!n && typeof node.name === "string") title.textContent = node.name;
				// Session evidence holds the runner's own session reference, not a node or session row id, so it stays text.
				const sess = ev.filter((x) => x?.kind === "session");
				sessEvidence.textContent = sess.length ? `${sessions.length ? " · " : ""}${sess.map((x) => String(x.ref)).join(", ")}` : sessions.length ? "" : "none recorded";
				// Observations: the record's own evidence pointers, each with its kind as text.
				obs.replaceChildren();
				el("h4", obs, "Observations");
				const rest = ev.filter((x) => x?.kind !== "session");
				if (rest.length) {
					const ul = el("ul", obs);
					for (const x of rest) {
						const li = el("li", ul);
						el("span", li, String(x.kind)).setAttribute("class", "chip");
						// A node pointer is a node id; it becomes a button only when that node is drawn here.
						const to = x.kind === "node" ? g.nodes.get(String(x.ref)) : undefined;
						if (to) pick(li, to); else el("span", li, String(x.ref)).setAttribute("class", "mono");
						if (typeof x.note === "string" && x.note) el("span", li, ` · ${x.note}`);
					}
				} else note(obs, sess.length ? "Its only evidence is the sessions above." : "No evidence recorded on this record.");
				if (r?.evidence?.truncated === true) note(obs, "Showing the first 50 evidence pointers.");
				more.replaceChildren();
				facts(more, [["Memory type", recorded(node.memory_type)], ["Origin", recorded(node.origin)], ["Pinned", node.pinned === true ? "yes" : "no"],
					["Flagged", node.flagged ? "yes" : "no"], ["Revision", recorded(node.revision)], ["Created", recorded(node.created_at)], ["Key", recorded(node.key)]]);
				if (typeof node.description === "string" && node.description) { el("h4", more, "Description"); textBlock(more, node.description); }
				const hist = Array.isArray(r?.history?.items) ? r.history.items : [];
				el("h4", more, "Recent history");
				if (hist.length) { const ul = el("ul", more); for (const v of hist.slice(0, 8)) el("li", ul, `Revision ${recorded(v.revision)} · ${recorded(v.op)} · ${recorded(v.at)} · ${recorded(v.actor)}`); }
				else note(more, "No history recorded.");
				// The raw row the server returned, as text; long fields arrive already cut to their limit.
				const raw = el("details", more);
				el("summary", raw, "Raw record");
				textBlock(raw, JSON.stringify(node, null, 2));
			})();
		};

		// Pan with a drag, zoom with the wheel around the pointer, select with a click; nothing animates, so reduced motion holds.
		let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
		const at = (event: J) => { const r = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 }; return { x: event.clientX - r.left, y: event.clientY - r.top }; };
		canvas.addEventListener("pointerdown", (event: J) => { const q = at(event); drag = { x: q.x, y: q.y, cx: cam.x, cy: cam.y, moved: false }; canvas.setPointerCapture?.(event.pointerId); });
		canvas.addEventListener("pointermove", (event: J) => {
			const q = at(event);
			if (drag) {
				if (Math.hypot(q.x - drag.x, q.y - drag.y) > 3) drag.moved = true;
				if (drag.moved) { moved = true; cam.x = drag.cx - (q.x - drag.x) / cam.k; cam.y = drag.cy - (q.y - drag.y) / cam.k; schedule(); }
				return;
			}
			const id = pick(q.x, q.y);
			if (id !== hover) { hover = id; canvas.setAttribute("title", id ? g.nodes.get(id)!.name : ""); schedule(); }
		});
		canvas.addEventListener("pointerup", (event: J) => { const q = at(event), was = drag; drag = null; if (was && !was.moved) select(pick(q.x, q.y)); });
		canvas.addEventListener("wheel", (event: J) => {
			event.preventDefault();
			moved = true;
			zooming = Date.now();
			const q = at(event), before = toWorld(q.x, q.y);
			cam.k = Math.min(8, Math.max(0.03, cam.k * Math.exp(-event.deltaY * 0.0015)));
			const after = toWorld(q.x, q.y);
			cam.x += before.x - after.x; cam.y += before.y - after.y;
			schedule();
		});
		canvas.addEventListener("keydown", (event: J) => {
			const step = 80 / cam.k, keys: Record<string, () => void> = {
				ArrowLeft: () => { cam.x -= step; }, ArrowRight: () => { cam.x += step; }, ArrowUp: () => { cam.y -= step; }, ArrowDown: () => { cam.y += step; },
				"+": () => { cam.k = Math.min(8, cam.k * 1.4); }, "=": () => { cam.k = Math.min(8, cam.k * 1.4); }, "-": () => { cam.k = Math.max(0.03, cam.k / 1.4); },
				"0": fit, Escape: () => select(null), Enter: () => { if (matched[0]) select(matched[0].id, true); } };
			const f = keys[event.key];
			if (f) { event.preventDefault(); moved = event.key !== "0"; f(); schedule(); }
		});
		g.listener = refresh;
		refresh();
		if (selected) select(selected, true); else idle();
		pump(p, g);
		return h;
	};
	Object.assign(am, { graphs, graphOf, pump });
	am.pages.graph = graphPage;
}
