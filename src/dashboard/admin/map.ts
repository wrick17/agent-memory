// Admin: the map with what-if items (#/map/NAME/ID).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function mapPages(am: Am): void {
	const { btn, call, choose, el, enc, facts, input, intro, link, note, pageStatus, recorded, switcher, why } = am;

	// The map: the server's bounded walk, laid out in rings by distance from where it starts. What-if items are drawn on it
	const SIZE = 640;
	const mapPage = (view: Node, p: Profile, center?: string) => {
		const version = am.pageVersion, h = el("h2", view, `Map: ${p.name}`);
		intro(view, "Map", "map", "A bounded walk of links, in rings by distance from where it starts. What-if items are drawn on it and never saved.");
		switcher(view, "map", p.name);
		const form = el("form", view);
		form.setAttribute("class", "toolbar");
		const depth = choose(form, "map-depth", "Distance", [["1", "Direct links"], ["2", "Links of links"]]);
		el("button", el("p", form), "Show map").setAttribute("type", "submit");
		if (center) link(el("p", view), `#/map/${enc(p.name)}`, "Start from the newest projects instead");
		const { say } = pageStatus(view);
		const out = el("div", view);
		const load = async () => {
			out.replaceChildren();
			say("Loading the map…");
			let m: J;
			try {
				m = await call(`/api/profiles/${enc(p.name)}/map?depth=${depth.value}${center ? `&center=${enc(center)}` : ""}`);
				if (!Array.isArray(m?.nodes) || !Array.isArray(m?.links)) throw new Error("the server sent no map");
			} catch (err) { if (version === am.pageVersion) say(`Could not load the map: ${why(err)}`); return; }
			if (version !== am.pageVersion) return;
			const nodes = new Map<string, J>(m.nodes.map((n: J) => [String(n.id), n]));
			const opaque = m.links.filter((l: J) => !l.from?.readable || !l.to?.readable).length;
			say(`${nodes.size} record${nodes.size === 1 ? "" : "s"} and ${m.links.length} link${m.links.length === 1 ? "" : "s"}.`);
			if (!nodes.size) { note(out, center ? "This record has no links to show." : "Nothing to show yet: the map starts from this profile's newest active projects. Open a memory and choose “Center the map here” to start from it."); }
			if (m.truncated) note(out, `Partial map: it stops at ${m.limits?.nodes ?? 300} records or when its read budget runs out. Center on a record to see its neighborhood.`, "warn");
			if (opaque) note(out, `${opaque} link${opaque === 1 ? " leads" : "s lead"} to records not readable in this profile; they are not drawn.`);
			// Rings by link distance from the starting records.
			const dist = new Map<string, number>((m.starts ?? []).map((s: string) => [s, 0]));
			const adj = new Map<string, string[]>();
			for (const l of m.links) if (l.from?.readable && l.to?.readable) for (const [a, b] of [[l.from.id, l.to.id], [l.to.id, l.from.id]]) adj.set(a, [...(adj.get(a) ?? []), b]);
			const queue = [...dist.keys()];
			while (queue.length) { const x = queue.shift()!; for (const y of adj.get(x) ?? []) if (!dist.has(y)) { dist.set(y, dist.get(x)! + 1); queue.push(y); } }
			const rings = new Map<number, string[]>();
			for (const id of nodes.keys()) { const d = Math.min(dist.get(id) ?? 3, 3); rings.set(d, [...(rings.get(d) ?? []), id]); }
			const pos = new Map<string, [number, number]>();
			for (const [d, ids] of rings) ids.forEach((id, i) => {
				const r = d === 0 && ids.length === 1 ? 0 : [80, 180, 255, 295][d]!, a = (2 * Math.PI * i) / ids.length + d * 0.5;
				pos.set(id, [SIZE / 2 + r * Math.cos(a), SIZE / 2 + r * Math.sin(a)]);
			});
			const wrap = el("div", out), canvas = el("div", wrap), panel = el("section", out);
			wrap.setAttribute("class", "mapwrap");
			canvas.setAttribute("class", "map");
			canvas.setAttribute("role", "group");
			canvas.setAttribute("aria-label", "Relationship map; each record is a button");
			panel.setAttribute("aria-label", "Selected record");
			panel.setAttribute("class", "panel");
			panel.hidden = true;
			const edge = (a: [number, number], b: [number, number], cls: string) => {
				const e = el("div", canvas), len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
				e.setAttribute("class", cls);
				e.setAttribute("aria-hidden", "true");
				e.setAttribute("style", `left:${a[0].toFixed(1)}px;top:${a[1].toFixed(1)}px;width:${len.toFixed(1)}px;transform:rotate(${ang.toFixed(4)}rad)`);
			};
			for (const l of m.links) { const a = pos.get(l.from?.id), b = pos.get(l.to?.id); if (a && b && l.from.readable && l.to.readable) edge(a, b, "edge"); }
			const items = am.whatIf.get(p.name) ?? [];
			items.forEach((w, i) => {
				const t = pos.get(w.target);
				if (!t) return;
				const ang = Math.atan2(t[1] - SIZE / 2, t[0] - SIZE / 2) + 0.3 * (i + 1), at: [number, number] = [Math.min(SIZE - 40, Math.max(40, t[0] + 60 * Math.cos(ang))), Math.min(SIZE - 20, Math.max(20, t[1] + 60 * Math.sin(ang)))];
				edge(t, at, "edge whatif");
				const b = el("span", canvas, `What-if: ${w.name}`);
				b.setAttribute("class", "node whatif");
				b.setAttribute("style", `left:${at[0].toFixed(1)}px;top:${at[1].toFixed(1)}px`);
			});
			const label = nodes.size <= 60;
			const buttons = new Map<string, Node>();
			const select = (id: string) => {
				for (const [k, b] of buttons) b.setAttribute("aria-pressed", String(k === id));
				panel.replaceChildren();
				panel.hidden = false;
				const n = nodes.get(id)!, name = String(n.name ?? "(no name)");
				el("h3", panel, name);
				facts(panel, [["Kind", `${recorded(n.kind)}${n.other_label ? ` (${String(n.other_label)})` : ""}`], ["Type", recorded(n.type)], ["Key", recorded(n.key)], ["Status", recorded(n.status)]]);
				const ul = el("ul", panel), mine = m.links.filter((l: J) => l.from?.id === id || l.to?.id === id);
				for (const l of mine) {
					const o = nodes.get(l.from.id === id ? l.to.id : l.from.id);
					el("li", ul, `${l.from.id === id ? "To" : "From"} ${o ? String(o.name) : "a record not readable here"} — ${String(l.rel)}${l.reason ? `: ${String(l.reason)}` : ""}`);
				}
				if (!mine.length) el("li", ul, "No links in this map.");
				link(el("p", panel), `#/memory/${enc(p.name)}/${enc(id)}`, "Open details");
				link(el("p", panel), `#/map/${enc(p.name)}/${enc(id)}`, "Center the map here");
				const wf = el("form", panel);
				const wn = input(wf, "whatif-name", `What-if: a new memory linked to “${name}”`);
				wn.setAttribute("maxlength", "512");
				el("button", el("p", wf), "Add to the map (not saved)").setAttribute("type", "submit");
				wf.addEventListener("submit", (event) => {
					event.preventDefault();
					if (!wn.value.trim()) { say("Name the what-if memory first."); return; }
					am.whatIf.set(p.name, [...(am.whatIf.get(p.name) ?? []), { name: wn.value.trim(), target: id, targetName: name }]);
					load();
				});
			};
			for (const [id, n] of nodes) {
				const [x, y] = pos.get(id)!, name = String(n.name ?? "(no name)");
				const b = el("button", canvas, label ? name : "");
				b.setAttribute("type", "button");
				b.setAttribute("class", "node");
				b.setAttribute("aria-label", `${String(n.kind)}: ${name}`);
				b.setAttribute("title", name);
				b.setAttribute("aria-pressed", "false");
				b.setAttribute("style", `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px`);
				b.addEventListener("click", () => select(id));
				buttons.set(id, b);
			}
			if (!label && nodes.size) note(out, "Names are hidden on a dense map; hover or focus a record, or use the list below.");
			const listing = el("details", out);
			el("summary", listing, "All links as a list");
			const ul = el("ul", listing);
			for (const l of m.links) {
				const a = nodes.get(l.from?.id), b = nodes.get(l.to?.id);
				el("li", ul, `${a ? String(a.name) : "not readable"} — ${String(l.rel)} → ${b ? String(b.name) : "not readable"}`);
			}
			if (items.length) {
				const wsec = el("section", out);
				wsec.setAttribute("class", "panel");
				wsec.setAttribute("aria-label", "What-if items");
				el("h3", wsec, "What-if items (not saved)");
				note(wsec, "These exist only on this page. Make a draft to review and save one; nothing changes on the server until you choose Save.");
				const wl = el("ul", wsec);
				items.forEach((w, i) => {
					const li = el("li", wl, `${w.name}, linked to “${w.targetName}”${pos.has(w.target) ? "" : " (its record is not on this map)"} `);
					btn(li, "Make a draft", () => am.draftFromWhatIf(p.name, w, li), `Make a draft from ${w.name}`);
					btn(li, "Remove", () => { items.splice(i, 1); load(); }, `Remove ${w.name}`);
				});
				btn(wsec, "Clear all what-if items", () => { am.whatIf.delete(p.name); load(); });
			}
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();
		return h;
	};
	am.pages.map = mapPage;
}
