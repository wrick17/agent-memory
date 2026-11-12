// Map: the connections canvas. An infinite canvas of readable blocks, projects and people only, joined where they really share
// something: a link ("works on") or records in common ("4 memories in common"). Selecting a block zooms to it, lights up what it is
// connected to and opens its page (when work happened, latest journals, learnings, memories) beside the canvas. The layout is a
// fixed grid, so nothing jitters or overlaps. The selection trail and the camera live in the address, so a view can be shared or
// returned to. Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Route } from "./am";

export function mapTab(am: Am): void {
	const { el, enc, doc, win } = am;
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const NS = "http://www.w3.org/2000/svg";
	const svgEl = (tag: string, parent: J, attrs: Record<string, string | number>): J => {
		const e = doc.createElementNS ? doc.createElementNS(NS, tag) : doc.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
		parent.appendChild(e);
		return e;
	};
	const BW = 240, BH = 92, GX = 34, GY = 30, CW = 210, CH = 50;
	const MIN_ZOOM = 0.88; // block meta is 12.5px: at 0.88 it stays at least 11px on screen
	const ONE: Record<string, string> = { memory: "memory", learning: "learning", journal: "journal", person: "person", project: "project" };
	const plural = (n: number, k: string) => `${n} ${n === 1 ? ONE[k] : k === "person" ? "people" : k === "memory" ? "memories" : `${ONE[k]}s`}`;

	const render = (root: Node, route: Route): Node => {
		const version = am.pageVersion, only = route.query.profile ?? null;
		const h = el("h2", root, "Map");
		h.setAttribute("class", "vh");
		const bar = cls(el("div", root), "map-bar");
		const crumbs = cls(el("nav", bar), "crumbs");
		crumbs.setAttribute("aria-label", "Open blocks");
		const tools = cls(el("div", bar), "map-tools");
		const stage = cls(el("div", root), "map-stage");
		const view: J = cls(el("div", stage), "mapview");
		view.setAttribute("tabindex", "0");
		view.setAttribute("aria-label", "Map of projects. Drag to move, scroll to zoom, select a block to open it.");
		const world = cls(el("div", view), "world");
		const svg = svgEl("svg", world, { class: "edges", width: 1, height: 1 });
		const blocks = cls(el("div", world), "blocks");
		const side: J = cls(el("aside", stage), "map-side");
		side.hidden = true;
		const legend = cls(el("p", root), "legend map-legend");
		for (const [k, label] of [["project", "Project"]]) { const s = el("span", legend); cls(el("i", s), `sw t-${k}`); el("span", s, label!); }

		// ---- State from the address ----
		const open: string[] = String(route.query.open ?? "").split(",").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
		let cam = { x: 0, y: 0, k: 1 }, placed = false;
		const z = Number(route.query.z), cx = Number(route.query.cx), cy = Number(route.query.cy);
		const restore = Number.isFinite(z) && Number.isFinite(cx) && Number.isFinite(cy) && z > 0;
		let saveT: unknown = null;
		const address = () => {
			win.clearTimeout?.(saveT);
			saveT = win.setTimeout?.(() => {
				if (version !== am.pageVersion) return;
				const w = view.clientWidth || 1000, hh = view.clientHeight || 600, c = { x: (w / 2 - cam.x) / cam.k, y: (hh / 2 - cam.y) / cam.k };
				const q = [only ? `profile=${enc(only)}` : "", open.length ? `open=${open.map(enc).join(",")}` : "", `z=${cam.k.toFixed(2)}`, `cx=${Math.round(c.x)}`, `cy=${Math.round(c.y)}`].filter(Boolean).join("&");
				try { win.history?.replaceState?.(null, "", `#map?${q}`); } catch { /* the view stays; only the address is stale */ }
			}, 250);
		};
		const apply = () => { world.setAttribute("style", `transform:translate(${cam.x}px,${cam.y}px) scale(${cam.k})`); };
		let anim = 0;
		const moveTo = (to: { x: number; y: number; k: number }) => {
			const from = { ...cam }, my = ++anim, reduce = win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches, t0 = Date.now();
			if (reduce || !win.requestAnimationFrame) { cam = to; apply(); address(); return; }
			const step = () => {
				if (my !== anim) return;
				const t = Math.min(1, (Date.now() - t0) / 320), e = 1 - (1 - t) ** 3;
				cam = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
				apply();
				if (t < 1) win.requestAnimationFrame(step); else address();
			};
			win.requestAnimationFrame(step);
		};
		/**
		 * The camera that shows world box b with a margin, between `min` and 1.15. When b does not fit at `min` (readable text
		 * first), it is aligned to the top left so the reader starts at the beginning and pans for the rest.
		 */
		const fitTo = (b: { x: number; y: number; w: number; h: number }, min = 0.3) => {
			let w = view.clientWidth || 1000, hh = view.clientHeight || 600;
			// A panel laid over the canvas (a bottom sheet on a phone, a drawer on a tablet) hides part of it: fit into the rest.
			const v = view.getBoundingClientRect?.(), s = side.hidden ? null : side.getBoundingClientRect?.();
			if (v && s?.height) {
				if (s.top > v.top + 40 && s.top < v.bottom && s.left <= v.left + 1) hh = Math.max(160, s.top - v.top);
				else if (s.left > v.left + 40 && s.left < v.right) w = Math.max(200, s.left - v.left);
			}
			const fit = Math.min((w - 60) / b.w, (hh - 60) / b.h);
			const k = Math.max(min, Math.min(1.15, fit));
			return { k, x: fit < min ? 30 - b.x * k : w / 2 - (b.x + b.w / 2) * k, y: fit < min ? 30 - b.y * k : hh / 2 - (b.y + b.h / 2) * k };
		};

		// ---- Layout and drawing ----
		let lib: J = null, boxes = new Map<string, { x: number; y: number; w: number; h: number }>(), bounds = { x: 0, y: 0, w: 1, h: 1 }, top: J[] = [];
		const nb = (key: string, kind?: string) => [...(lib.links.get(key)?.keys() ?? [])].map((k) => lib.items.get(k)).filter((o: J) => o && o.kind !== "session" && (!kind || o.kind === kind));
		const deg = (it: J) => nb(it.key).length;
		const summary = (it: J) => {
			if (it.other) return `${plural(it.other.length, it.otherKind)}`;
			const parts = ["memory", "learning", "journal"].map((k) => [k, nb(it.key, k).length] as const).filter(([, n]) => n);
			return parts.slice(0, 3).map(([k, n]) => plural(n, k)).join(" · ") || "No connections yet";
		};
		const block = (it: J, x: number, y: number, w: number, hgt: number, child: boolean) => {
			const b = cls(el("button", blocks), `block t-${it.kind}-b${child ? " child" : ""}${open.at(-1) === it.key ? " open" : ""}`);
			b.setAttribute("type", "button");
			b.setAttribute("style", `left:${x}px;top:${y}px;width:${w}px;height:${hgt}px`);
			b.setAttribute("data-key", it.key);
			if (it.href) b.setAttribute("data-href", it.href);
			const t = cls(el("span", b), "b-title");
			cls(el("i", t), `sw t-${it.kind}`).setAttribute("aria-hidden", "true");
			if (it.wide) el("span", t, `${am.workspaceName(it.workspace)} · workspace-wide`);
			else am.title(lib?.items.get(it.key) ?? it, el("span", t));
			cls(el("span", b, child ? (it.more ? "Show all" : it.kind === "learning" || it.kind === "memory" || it.kind === "journal" ? it.when ?? "" : summary(it)) : summary(it)), "b-meta");
			b.setAttribute("title", `${it.title}${child ? "" : ` · ${summary(it)}`}`);
			boxes.set(it.key, { x, y, w, h: hgt });
			return b;
		};
		/**
		 * Workspace groups side by side (each up to two columns of project blocks), wrapping to the canvas width, so a wide screen
		 * is used and nothing overlaps. The selected project's records open as small named blocks in a band under its row, grouped
		 * by type; later rows move down to make room. Edges join projects that share records, labelled with what they share.
		 */
		const layout = () => {
			blocks.replaceChildren();
			svg.replaceChildren();
			boxes = new Map();
			bandBox = null;
			const L = lib.list, rank = (a: J, b: J) => deg(b) - deg(a) || String(b.updated ?? "").localeCompare(String(a.updated ?? ""));
			const projects = L.project.filter((x: J) => !x.wide ? deg(x) > 1 : deg(x) > 0).sort(rank), tail = L.project.filter((x: J) => !x.wide && deg(x) === 1);
			const byWs = new Map<string, J[]>();
			for (const it of projects) { const w = it.workspace ?? it.p; (byWs.get(w) ?? byWs.set(w, []).get(w)!).push(it); }
			for (const l of byWs.values()) l.sort((a, b) => Number(!!a.wide) - Number(!!b.wide));
			const groups = am.workspaceOrder.filter((w) => byWs.has(w)).map((w) => ({ title: am.workspaceName(w), list: byWs.get(w)! }));
			if (tail.length) groups.push({ title: "Other", list: [{ key: "other:project", kind: "project", title: `${tail.length} more ${tail.length === 1 ? "project" : "projects"}`, other: tail, otherKind: "project", p: "" }] });
			top = groups.flatMap((g) => g.list);
			if (!top.length) { cls(el("p", blocks, lib.loading ? "Loading the map…" : "No projects yet. They appear as your agents record what they work on."), "map-empty"); bounds = { x: 0, y: 0, w: 600, h: 200 }; drawn.clear(); return; }
			const viewW = (Number(view.clientWidth) || 1200) - 24, unit = BW + GX;
			const maxW = Math.max(unit, Math.floor((viewW + GX) / unit) * unit);
			// Pack groups into bands left to right; a group is one column, or two when it has more than two projects.
			type Placed = { g: typeof groups[number]; cols: number; x: number };
			const bands: Placed[][] = [[]];
			let x = 0;
			for (const g of groups) {
				const cols = Math.min(g.list.length > 2 ? 2 : 1, Math.max(1, Math.floor(maxW / unit)));
				if (x && x + cols * unit > maxW) { bands.push([]); x = 0; }
				bands.at(-1)!.push({ g, cols, x });
				x += cols * unit + 24;
			}
			let y = 0, right = 0;
			drawn = new Set(["project"]);
			for (const band of bands) {
				let bottom = y;
				for (const { g, cols, x: gx } of band) {
					const hd = cls(el("span", blocks, g.title), "col-head");
					hd.setAttribute("style", `left:${gx}px;top:${y}px`);
					g.list.forEach((it, i) => { const bx = gx + (i % cols) * unit, by = y + 30 + Math.floor(i / cols) * (BH + GY); block(it, bx, by, BW, BH, false); bottom = Math.max(bottom, by + BH); right = Math.max(right, bx + BW); });
				}
				y = bottom + GY;
				// The selected project's records: a band under this row, a titled row of small blocks per type.
				const sel = open.at(-1), owner = band.find((p) => p.g.list.some((it) => it.key === sel));
				if (sel && owner) {
					const it = owner.g.list.find((x2) => x2.key === sel)!, kids: [string, string, J[]][] = it.other ? [["project", "Projects", it.other]]
						: [["learning", "Learnings"], ["memory", "Memories"], ["journal", "Journals"]].map(([k, label]) => [k!, label!, nb(it.key, k).sort((a: J, b: J) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")))] as [string, string, J[]]);
					const bandW = Math.max(right, maxW - GX), y0 = y, perRow = Math.max(1, Math.floor((bandW - 32 + 12) / (CW + 12)));
					const bg = cls(el("span", blocks), "band"), rows: { y: number; last: number }[] = [];
					y += 14;
					const t = cls(el("span", blocks, it.title), "band-title");
					t.setAttribute("style", `left:16px;top:${y}px`);
					y += 28;
					for (const [k, label, list] of kids) {
						if (!list.length) continue;
						drawn.add(k);
						const gh = cls(el("span", blocks, `${label} ${list.length}`), "group-head");
						gh.setAttribute("style", `left:16px;top:${y}px`);
						y += 22;
						const max = Math.max(perRow, Math.min(list.length, perRow * 2) - (list.length > perRow * 2 ? 1 : 0));
						const show: J[] = list.slice(0, Math.min(list.length, max)).map((o: J) => ({ ...o, when: o.updated ? am.when(o.updated).text : "" }));
						if (list.length > show.length) show.push({ key: `more:${it.key}:${k}`, kind: k, title: `+${list.length - show.length} more`, more: true, href: it.other ? `#projects${only ? `?profile=${enc(only)}` : ""}` : am.itemHref(it, only) });
						show.forEach((o, i) => {
							if (i && i % perRow === 0) y += CH + 10;
							if (i % perRow === 0) rows.push({ y, last: 0 });
							block(o, 16 + (i % perRow) * (CW + 12), y, CW, CH, true);
							rows.at(-1)!.last = 16 + (i % perRow) * (CW + 12) + CW / 2;
						});
						y += CH + 16;
					}
					bg.setAttribute("style", `left:0px;top:${y0}px;width:${bandW}px;height:${y - y0}px`);
					bandBox = { x: 0, y: y0, w: bandW, h: y - y0 };
					// Lines from the project to its records: out of the block's left side into the empty gutter beside its column (never
					// through another card), down to the band, along a spine at its left edge, and across each row with a tick to each.
					const pb = boxes.get(it.key);
					if (pb && rows.length) {
						const gx = pb.x - GX / 2, sx = 7, ticks: string[] = [];
						let d = `M${pb.x},${pb.y + pb.h / 2} H${gx} V${y0 + 7} H${sx} V${rows.at(-1)!.y - 5}`;
						for (const r of rows) { d += ` M${sx},${r.y - 5} H${r.last}`; for (let cx2 = 16 + CW / 2; cx2 <= r.last; cx2 += CW + 12) ticks.push(`M${cx2},${r.y - 5} V${r.y}`); }
						svgEl("path", svgEl("g", svg, { class: "edge tree" }), { d: `${d} ${ticks.join(" ")}` });
						drawn.add("tree");
					}
					(blocks as J).insertBefore?.(bg, (blocks as J).firstChild);
					y += 18;
				}
			}
			bounds = { x: -30, y: -30, w: Math.max(right, maxW - GX) + 60, h: y + 40 };
			svg.setAttribute("width", String(bounds.w));
			svg.setAttribute("height", String(y + 40));
			// Edges: projects that share records (or a real link), labelled with what they share; each keeps its strongest three.
			const real = top.filter((t2) => !t2.other), pairs = new Map<string, { a: J; b: J; label: string }>();
			const shared = (a: J, b: J) => { const ka = new Set(lib.links.get(a.key)?.keys() ?? []), kinds = new Map<string, number>(); for (const k of lib.links.get(b.key)?.keys() ?? []) { const o = lib.items.get(k); if (ka.has(k) && o && !["session", "person", "project"].includes(o.kind)) kinds.set(o.kind, (kinds.get(o.kind) ?? 0) + 1); } return kinds; };
			for (const a2 of real) {
				const best = real.filter((b2) => b2 !== a2).map((b2) => { const k = shared(a2, b2), n = [...k.values()].reduce((t2, v) => t2 + v, 0); return { b2, n, label: [...k].map(([kk, c]) => plural(c, kk)).join(", ") + " shared" }; }).filter((e) => e.n).sort((p, q) => q.n - p.n).slice(0, 3);
				for (const e of best) { const id = [a2.key, e.b2.key].sort().join("|"); if (!pairs.has(id)) pairs.set(id, { a: a2, b: e.b2, label: e.label }); }
			}
			const port = (B: { x: number; y: number; w: number; h: number }, tx: number, ty: number) => { const cx = B.x + B.w / 2, cy = B.y + B.h / 2, dx = tx - cx, dy = ty - cy, s2 = Math.min(Math.abs((B.w / 2) / (dx || 1e-9)), Math.abs((B.h / 2) / (dy || 1e-9))); return [cx + dx * s2, cy + dy * s2]; };
			for (const { a: a2, b: b2, label } of pairs.values()) {
				const A = boxes.get(a2.key)!, B = boxes.get(b2.key)!, [x1, y1] = port(A, B.x + B.w / 2, B.y + B.h / 2), [x2, y2] = port(B, A.x + A.w / 2, A.y + A.h / 2);
				const mx = (x1! + x2!) / 2, my = (y1! + y2!) / 2, bend = Math.abs(y1! - y2!) < 4 ? 26 : 0;
				const g = svgEl("g", svg, { class: "edge real", "data-a": a2.key, "data-b": b2.key });
				svgEl("path", g, { d: `M${x1},${y1} Q${mx},${my - bend} ${x2},${y2}` });
				const tx = svgEl("text", g, { x: mx, y: my - bend / 2 - 6, "text-anchor": "middle" });
				tx.textContent = label;
			}
			if (pairs.size) drawn.add("edge");
		};
		let drawn = new Set<string>(), bandBox: { x: number; y: number; w: number; h: number } | null = null;
		/** The legend names only what is on the canvas now. */
		const paintLegend = () => {
			legend.replaceChildren();
			for (const [k, label] of [["project", "Project"], ["learning", "Learning"], ["memory", "Memory"], ["journal", "Journal"]] as [string, string][]) if (drawn.has(k)) { const sp = el("span", legend); cls(el("i", sp), `sw t-${k}`); el("span", sp, label); }
			if (drawn.has("tree")) cls(el("span", legend, "Lines down: what the open project holds"), "muted");
			if (drawn.has("edge")) cls(el("span", legend, "Lines across: records two projects share"), "muted");
		};

		const crumb = () => {
			crumbs.replaceChildren();
			const home = el("button", crumbs, "Map");
			home.setAttribute("type", "button");
			home.addEventListener("click", () => { open.length = 0; side.hidden = true; draw(); moveTo(fitTo(bounds, MIN_ZOOM)); });
			home.setAttribute("aria-label", "Show the whole map");
			for (const k of open) {
				const it = lib?.items.get(k) ?? top.find((t) => t.key === k);
				if (!it) continue;
				el("span", crumbs, "›").setAttribute("aria-hidden", "true");
				const b = cls(el("button", crumbs), "crumb");
				b.setAttribute("type", "button");
				el("span", b, it.title);
				if (k === open.at(-1)) b.setAttribute("aria-current", "true");
				b.addEventListener("click", () => select(k));
			}
		};
		const draw = () => { if (lib) { layout(); paintLegend(); crumb(); address(); } };
		/** Selects a block: it becomes the end of the trail, the view zooms to it and its connected blocks, and its page opens beside. */
		const select = (key: string, fromTrail = false) => {
			if (!fromTrail) { const i = open.indexOf(key); if (i >= 0) open.splice(i, 1); open.push(key); if (open.length > 6) open.shift(); }
			// The panel first, so the layout and the fit below measure the canvas beside it (nothing then runs past its right edge).
			if (lib.items.has(key) || top.some((t) => t.key === key)) showDetail(key);
			draw();
			placed = true; // the reader chose a place; a late load must not refit over it
			const b = boxes.get(key);
			if (!b) return;
			// Fit the block and every block it has an edge to.
			let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
			for (const g of svg.querySelectorAll?.(".edge") ?? []) {
				const o = g.getAttribute("data-a") === key ? g.getAttribute("data-b") : g.getAttribute("data-b") === key ? g.getAttribute("data-a") : null, ob = o ? boxes.get(o) : null;
				if (ob) { x0 = Math.min(x0, ob.x); y0 = Math.min(y0, ob.y); x1 = Math.max(x1, ob.x + ob.w); y1 = Math.max(y1, ob.y + ob.h); }
			}
			if (bandBox) { y1 = Math.max(y1, bandBox.y + bandBox.h); x0 = Math.min(x0, bandBox.x); x1 = Math.max(x1, bandBox.x + bandBox.w); }
			moveTo(fitTo({ x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: Math.min(y1 - y0, 1100) + 80 }, MIN_ZOOM));
		};
		const unselect = () => { open.pop(); side.hidden = true; if (open.length) select(open.at(-1)!, true); else { draw(); moveTo(fitTo(bounds, MIN_ZOOM)); } };
		/** What the open panel shows: the record's update time and each linked record's, or the listed small ones. */
		const detailSigOf = (key: string) => {
			const it = lib.items.get(key), other = top.find((t) => t.key === key && t.other);
			const linked = [...((lib.links.get(key) ?? new Map()) as Map<string, unknown>).keys()].map((k) => `${k}@${lib.items.get(k)?.updated ?? ""}`).sort().join("|");
			return `${key}:${it?.updated ?? ""}:${linked}:${other ? other.other.map((o: J) => `${o.key}@${o.updated ?? ""}`).join("|") : ""}`;
		};
		let detailSig = "";
		const showDetail = (key: string) => {
			detailSig = detailSigOf(key);
			const it = lib.items.get(key), other = top.find((t) => t.key === key && t.other);
			side.hidden = false;
			if (other) {
				// "Other projects" or "Other people": the small ones, as a plain list.
				side.replaceChildren();
				const hd = cls(el("header", side), "detail-head");
				el("h2", hd, other.title);
				const x = cls(el("a", hd, "Close"), "close");
				x.setAttribute("href", "#map");
				x.setAttribute("data-close", "");
				const ul = cls(el("ul", side), "rows compact");
				for (const o of other.other) { const li = el("li", ul), a = cls(el("a", li), "row"); a.setAttribute("href", am.itemHref(o, only)); cls(el("span", a, o.title), "row-title"); }
			} else if (it) am.detail(side, lib, it, { ...route, tab: "map" });
			else { side.hidden = true; return; }
			sheetHandle();
			const c = side.querySelector?.("[data-close]");
			c?.addEventListener?.("click", (e: J) => { e.preventDefault(); unselect(); view.focus?.({ preventScroll: true }); });
		};

		/** On a phone the panel is a bottom sheet: it opens at a peek height with the map above; the handle drags it taller,
		 * shorter or shut, and a tap on it toggles between peek and tall. CSS hides the handle on wider screens. */
		const sheetHandle = () => {
			const handle: J = cls(el("button", side), "sheet-handle");
			side.insertBefore?.(handle, side.firstChild);
			handle.setAttribute("type", "button");
			handle.setAttribute("aria-label", "Make the panel taller or shorter");
			const tall = (on: boolean) => { side.setAttribute("class", on ? "map-side tall" : "map-side"); side.removeAttribute?.("style"); handle.setAttribute("aria-expanded", String(on)); };
			tall(false);
			let start: { y: number; h: number } | null = null, moved = false;
			handle.addEventListener("pointerdown", (e: J) => { start = { y: e.clientY, h: side.getBoundingClientRect?.().height ?? 0 }; moved = false; handle.setPointerCapture?.(e.pointerId); });
			handle.addEventListener("pointermove", (e: J) => {
				if (!start) return;
				const d = start.y - e.clientY;
				if (Math.abs(d) > 6) moved = true;
				if (moved) side.setAttribute("style", `height:${Math.round(Math.max(80, Math.min((win.innerHeight || 800) * 0.92, start.h + d)))}px`);
			});
			const end = (e: J) => {
				if (!start) return;
				const h = start.h + start.y - e.clientY, vh = win.innerHeight || 800;
				start = null;
				if (!moved) return;
				if (h < vh * 0.22) unselect();
				else tall(h > vh * 0.62);
			};
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
			handle.addEventListener("click", () => { if (moved) { moved = false; return; } tall(!String(side.getAttribute("class")).includes("tall")); });
		};

		// The camera is the only way the canvas moves: focusing a block (a click, Tab) must not scroll the clipped view under it.
		view.addEventListener("scroll", () => { if (view.scrollTop || view.scrollLeft) { view.scrollTop = 0; view.scrollLeft = 0; } });

		// ---- Interaction: click, hover, pan, zoom ----
		blocks.addEventListener("click", (e: J) => {
			const b = e.target?.closest?.(".block");
			if (!b || dragged) return;
			const key = String(b.getAttribute("data-key"));
			if (!String(b.getAttribute("class")).includes("child")) select(key);
			else if (key.startsWith("more:")) win.location.hash = String(b.getAttribute("data-href") ?? "");
			else showDetail(key);
		});
		blocks.addEventListener("mouseover", (e: J) => {
			const b = e.target?.closest?.(".block"), key = b?.getAttribute?.("data-key") ?? null;
			view.setAttribute("class", key ? "mapview hovering" : "mapview");
			for (const g of svg.querySelectorAll?.(".edge") ?? []) g.setAttribute("class", key && (g.getAttribute("data-a") === key || g.getAttribute("data-b") === key) ? "edge hot" : "edge");
		});
		// One pointer pans (from anywhere, blocks too: a click only counts when nothing moved); two pointers pinch-zoom around
		// their midpoint. A tap on empty canvas steps back.
		let drag: { x: number; y: number; cx: number; cy: number; block: boolean } | null = null, dragged = false, captured = false;
		const pts = new Map<number, { x: number; y: number }>();
		let pinch: { d: number; k: number; mx: number; my: number; cx: number; cy: number } | null = null;
		const local = (e: J) => { const r = view.getBoundingClientRect?.() ?? { left: 0, top: 0 }; return { x: e.clientX - r.left, y: e.clientY - r.top }; };
		view.addEventListener("pointerdown", (e: J) => {
			anim++; placed = true;
			pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pts.size === 2) {
				const [a, b] = [...pts.values()], m = local({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 });
				pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, k: cam.k, mx: m.x, my: m.y, cx: cam.x, cy: cam.y };
				drag = null; dragged = true;
				return;
			}
			drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, block: !!e.target?.closest?.(".block") }; dragged = false; captured = false;
		});
		view.addEventListener("pointermove", (e: J) => {
			if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pinch && pts.size === 2) {
				const [a, b] = [...pts.values()], k = Math.min(2.5, Math.max(0.2, (pinch.k * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.d));
				cam = { k, x: pinch.mx - ((pinch.mx - pinch.cx) * k) / pinch.k, y: pinch.my - ((pinch.my - pinch.cy) * k) / pinch.k };
				apply();
				return;
			}
			if (!drag) return;
			if (!dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) { dragged = true; if (!captured) { view.setPointerCapture?.(e.pointerId); captured = true; } }
			if (dragged) { cam = { ...cam, x: drag.cx + e.clientX - drag.x, y: drag.cy + e.clientY - drag.y }; apply(); }
		});
		const up = (e: J) => {
			pts.delete(e.pointerId);
			if (pinch) { if (pts.size < 2) { pinch = null; address(); } return; }
			if (drag && !dragged && !drag.block && open.length) unselect(); // a tap on empty canvas steps back
			if (dragged) address();
			drag = null;
			win.setTimeout?.(() => { dragged = false; }, 0);
		};
		view.addEventListener("pointerup", up);
		view.addEventListener("pointercancel", up);
		// A resize or a turn of the phone fits the view again: the selection and its neighbours, or everything.
		let fitT: unknown = null;
		const refit = () => {
			win.clearTimeout?.(fitT);
			fitT = win.setTimeout?.(() => { if (version !== am.pageVersion || !lib) return; if (open.length) select(open.at(-1)!, true); else { draw(); moveTo(fitTo(bounds, MIN_ZOOM)); } }, 200);
		};
		win.addEventListener?.("resize", refit);
		am.onLeave(() => { win.removeEventListener?.("resize", refit); win.clearTimeout?.(fitT); });
		view.addEventListener("wheel", (e: J) => {
			e.preventDefault();
			anim++;
			placed = true;
			const r = view.getBoundingClientRect?.() ?? { left: 0, top: 0 }, px = e.clientX - r.left, py = e.clientY - r.top;
			const k = Math.min(2.5, Math.max(0.2, cam.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
			cam = { k, x: px - ((px - cam.x) * k) / cam.k, y: py - ((py - cam.y) * k) / cam.k };
			apply();
			address();
		});
		view.addEventListener("keydown", (e: J) => {
			const step = 80, keys: Record<string, () => void> = { ArrowLeft: () => { cam.x += step; }, ArrowRight: () => { cam.x -= step; }, ArrowUp: () => { cam.y += step; }, ArrowDown: () => { cam.y -= step; } };
			if (e.key === "Escape" && open.length) { e.preventDefault(); unselect(); return; }
			const f = keys[e.key];
			if (f) { e.preventDefault(); f(); apply(); address(); }
		});
		const zoomBy = (f: number) => { placed = true; const w = view.clientWidth || 1000, hh = view.clientHeight || 600, k = Math.min(2.5, Math.max(0.2, cam.k * f)); moveTo({ k, x: w / 2 - ((w / 2 - cam.x) * k) / cam.k, y: hh / 2 - ((hh / 2 - cam.y) * k) / cam.k }); };
		for (const [t, label, f] of [["−", "Zoom out", () => zoomBy(1 / 1.25)], ["+", "Zoom in", () => zoomBy(1.25)], ["Fit", "Fit everything in view", () => { placed = true; moveTo(fitTo(bounds, 0.25)); }]] as [string, string, () => void][]) {
			const b = el("button", tools, t);
			b.setAttribute("type", "button");
			b.setAttribute("aria-label", label);
			b.addEventListener("click", f);
		}

		const paint = () => {
			if (version !== am.pageVersion) return;
			lib = am.library(only, paint);
			draw();
			if (!placed && top.length && !lib.loading) {
				placed = true;
				// A saved link reopens its trail: the last block's page beside the canvas, then the saved camera (or a fit to it).
				const last = open.at(-1), known = last && (lib.items.has(last) || top.some((t) => t.key === last));
				if (known) { showDetail(last); draw(); }
				if (restore) { const w = view.clientWidth || 1000, hh = view.clientHeight || 600; cam = { k: z, x: w / 2 - cx * z, y: hh / 2 - cy * z }; apply(); }
				else if (known) select(last, true);
				else { cam = fitTo(bounds, MIN_ZOOM); apply(); }
			} else if (!placed) { cam = fitTo(bounds, MIN_ZOOM); apply(); }
			// A refresh that changed the open record or its links redraws the panel beside the canvas.
			const last = open.at(-1);
			if (last && !side.hidden && !lib.loading && detailSigOf(last) !== detailSig) showDetail(last);
		};
		paint();
		return h;
	};
	am.tab({ id: "map", group: null, label: "Map", key: "g", profiles: "any", render });
}
