// Charts that each answer one question at a glance: what was added day by day (am.daily), what is biggest (am.bars), a breakdown
// that is also a filter (am.facets), and one record's connections as a small labelled graph (am.ego). Colours come from CSS theme
// tokens through classes, so a theme switch restyles them with no redraw. Browser code, serialized into /app.js: it may use only
// `am` and browser globals (type imports are erased).
import type { Am, J, Node } from "./am";

export function chartsTab(am: Am): void {
	const { el, doc } = am;
	const NS = "http://www.w3.org/2000/svg";
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const svgEl = (tag: string, parent?: Node, attrs: Record<string, string | number> = {}): J => {
		const e = doc.createElementNS ? doc.createElementNS(NS, tag) : doc.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
		parent?.appendChild(e);
		return e;
	};
	const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one.endsWith("y") ? `${one.slice(0, -1)}ies` : `${one}s`}`;
	/** A series total: "12 memories" for a kind, "Rule 12" for a named sub-type (names do not pluralize: Codex, How-to). */
	const tally = (n: number, label: string) => /^[A-Z]/.test(label) ? `${label} ${n}` : plural(n, label);

	/**
	 * Stacked day bars over the last `weeks` weeks, ending today (local time), with a legend that says its period. No numbers
	 * on the bars: hovering, tapping or the arrow keys put one day's date and counts in the readout line above them, which
	 * otherwise shows today. Today's bar is marked; the axis names each month (each week over four weeks). A container too
	 * narrow for bars of at least 2 px shows the last 4 weeks instead (see fitWeeks).
	 */
	type Series = { label: string; kind: string; dates: (string | null)[] };
	const DAY = 86_400_000, WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const fitWeeks = (box: Node, weeks: number) => ((Number((box as J).clientWidth) || Number(am.win.innerWidth) || 1440) - 32) / (weeks * 7) >= 3 ? weeks : Math.min(weeks, 4);
	const daily = (parent: Node, series: Series[], weeks = 12, caption = "") => {
		const fig = cls(el("figure", parent), "chart daily");
		// Calendar days, not elapsed milliseconds: a day across a daylight-saving change is 23 or 25 hours long. Day k is the
		// local date k days after the first, and a record's day is its local Y/M/D compared as UTC dates (which have no DST).
		const days = weeks * 7, now = new Date(), y0 = now.getFullYear(), m0 = now.getMonth(), d0 = now.getDate() - (days - 1);
		const dateAt = (k: number) => new Date(y0, m0, d0 + k), start = Date.UTC(y0, m0, d0);
		const dayOf = (t: number) => { const d = new Date(t); return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - start) / DAY); };
		const bins = series.map(() => new Array(days).fill(0) as number[]);
		series.forEach((s, i) => { for (const d of s.dates) { const t = Date.parse(d ?? ""); if (!Number.isFinite(t)) continue; const k = dayOf(t); if (k >= 0 && k < days) bins[i]![k]!++; } });
		const totals = new Array(days).fill(0).map((_, k) => bins.reduce((t, b) => t + b[k]!, 0)), max = Math.max(1, ...totals), all = totals.reduce((a, b) => a + b, 0);
		const label = (k: number) => { const d = dateAt(k); return `${k === days - 1 ? "Today" : `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`}`; };
		const counts = (k: number) => totals[k] ? series.map((s, i) => [s, bins[i]![k]!] as const).filter(([, n]) => n).map(([s, n]) => tally(n, s.label)).join(", ") : "nothing added";
		const readout = cls(el("p", fig), "readout");
		readout.setAttribute("aria-live", "polite");
		const cols = cls(el("div", fig), days > 40 ? "cols dense" : "cols");
		cols.setAttribute("role", "img");
		cols.setAttribute("tabindex", "0");
		cols.setAttribute("aria-label", `${caption ? `${caption}: ` : ""}${series.map((s, i) => tally(bins[i]!.reduce((a, b) => a + b, 0), s.label)).join(", ")} in the last ${weeks} weeks, by day. Use the arrow keys to read each day.`);
		const colEls: Node[] = [];
		let on = days - 1;
		// Axis labels stay clear of "Today": about 70 px of bars at the end carry no month label (at least 4 days).
		const perDay = (Number((cols as J).clientWidth) || Number((parent as J).clientWidth) || 700) / days, clear = Math.max(4, Math.ceil(70 / Math.max(perDay, 1)));
		// A chosen day is highlighted; at rest the readout names today and no bar is highlighted.
		const show = (k: number, chosen = true) => {
			colEls[on]?.setAttribute("class", on === days - 1 ? "col today" : "col");
			on = Math.max(0, Math.min(days - 1, k));
			if (chosen) colEls[on]?.setAttribute("class", on === days - 1 ? "col today on" : "col on");
			readout.textContent = `${label(on)}: ${counts(on)}`;
		};
		for (let k = 0; k < days; k++) {
			const d = dateAt(k), col = cls(el("div", cols), k === days - 1 ? "col today" : "col");
			col.setAttribute("title", `${label(k)}: ${counts(k)}`);
			col.setAttribute("data-day", String(k));
			const stack = cls(el("div", col), "stack");
			stack.setAttribute("style", `height:${totals[k] ? Math.max(3, Math.round((totals[k]! / max) * 100)) : 0}%`);
			series.forEach((s, i) => { const n = bins[i]![k]!; if (n) cls(el("i", stack), `seg t-${s.kind}`).setAttribute("style", `flex:${n}`); });
			// A quiet axis: the 1st of each month (each Monday over four weeks), kept clear of today's mark at the end.
			const tick = k === days - 1 ? "Today" : k < days - clear && (days > 40 ? d.getDate() === 1 : d.getDay() === 1) ? `${d.getDate()} ${MON[d.getMonth()]}` : "";
			if (tick) cls(el("span", col, tick), "tick");
			col.addEventListener("pointerenter", () => show(k));
			col.addEventListener("click", () => show(k));
			colEls.push(col);
		}
		cols.addEventListener("keydown", (e: J) => {
			const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -days, End: days };
			if (step[e.key] === undefined) return;
			e.preventDefault?.();
			show(on + step[e.key]!);
		});
		cols.addEventListener("pointerleave", () => show(days - 1, false));
		show(days - 1, false);
		const leg = cls(el("figcaption", fig), "legend");
		// The legend says its period, so its totals never read as the all-time counts.
		series.forEach((s, i) => { const li = el("span", leg); cls(el("i", li), `sw t-${s.kind}`); el("span", li, tally(bins[i]!.reduce((a, b) => a + b, 0), s.label)); });
		cls(el("span", leg, all ? `added in the last ${weeks} weeks` : `Nothing added in the last ${weeks} weeks.`), "muted");
		return fig;
	};

	/** Ranked horizontal bars: a label (a link when `href` is given), a bar scaled to the largest, and the number. */
	const bars = (parent: Node, rows: { label: string; value: number; href?: string; sub?: string }[], unit: string) => {
		const box = cls(el("ol", parent), "chart bars");
		const max = Math.max(1, ...rows.map((r) => r.value));
		for (const r of rows) {
			const li = el("li", box), name = el(r.href ? "a" : "span", li, r.label);
			cls(name, "bar-label");
			name.setAttribute("title", r.sub ? `${r.label} · ${r.sub}` : r.label);
			if (r.href) name.setAttribute("href", r.href);
			const track = cls(el("span", li), "bar-track");
			cls(el("i", track), "bar-fill").setAttribute("style", `width:${Math.max(2, Math.round((r.value / max) * 100))}%`);
			cls(el("span", li, String(r.value)), "bar-num").setAttribute("title", plural(r.value, unit));
		}
		return box;
	};

	/** A breakdown that is also a filter: one proportional bar of segments, then the same groups as toggle buttons with counts. */
	const facets = (parent: Node, rows: { id: string; label: string; value: number; kind?: string }[], current: string, pick: (id: string) => void, all?: number) => {
		const box = cls(el("div", parent), "facets");
		const total = rows.reduce((t, r) => t + r.value, 0) || 1;
		const strip = cls(el("div", box), "facet-strip");
		strip.setAttribute("aria-hidden", "true");
		// Each group its own categorical colour (the caller's sub-type class), never shades of one hue.
		rows.forEach((r, i) => cls(el("i", strip), `t-${r.kind ?? `n${i % 6}`}`).setAttribute("style", `flex:${r.value / total}`));
		const btns = cls(el("div", box), "facet-btns");
		btns.setAttribute("role", "group");
		// "All" is the caller's own total when groups overlap (one project in several workspaces), else the sum.
		for (const r of [{ id: "", label: "All", value: all ?? rows.reduce((t, x) => t + x.value, 0) }, ...rows]) {
			const b = el("button", btns);
			b.setAttribute("type", "button");
			b.setAttribute("aria-pressed", String(r.id === current));
			const kind = (r as { kind?: string }).kind;
			if (r.id) cls(el("i", b), `sw t-${kind ?? `n${rows.indexOf(r as never) % 6}`}`);
			el("span", b, r.label);
			cls(el("span", b, String(r.value)), "muted");
			b.addEventListener("click", () => pick(r.id === current ? "" : r.id));
		}
		return box;
	};

	/**
	 * Connected to: the other projects and people an item is linked with, as labelled blocks joined to it by lines that say how
	 * ("works on", "4 shared memories") and grow thicker with strength. Drawn only when there is at least one; the caller decides.
	 */
	type Rel = { title: string; kind: string; href: string; label: string; weight: number };
	const related = (parent: Node, center: { title: string; kind: string }, rows: Rel[], cap = 8) => {
		const fig = cls(el("figure", parent), "chart rel");
		const shown = rows.slice(0, cap), H = Math.max(120, shown.length * 46 + 20), W = 760, cx = 150, rx = 470, max = Math.max(1, ...shown.map((r) => r.weight));
		const svg = svgEl("svg", fig, { viewBox: `0 0 ${W} ${H}`, class: "rel-svg", role: "group" });
		svg.setAttribute("aria-label", `${center.title} is connected to ${shown.map((r) => `${r.title} (${r.label})`).join(", ")}`);
		const cy = H / 2;
		shown.forEach((r, i) => {
			const y = shown.length === 1 ? cy : 30 + (i * (H - 60)) / (shown.length - 1);
			const a = r.href ? svgEl("a", svg, { href: r.href, class: "rel-node" }) : svgEl("g", svg, { class: "rel-node" });
			svgEl("path", a, { d: `M${cx + 120},${cy} C${cx + 230},${cy} ${rx - 110},${y} ${rx},${y}`, class: "rel-edge", "stroke-width": 1 + (3 * r.weight) / max });
			const lt = svgEl("text", a, { x: rx - 12, y: y - 7, "text-anchor": "end", class: "rel-label" });
			lt.textContent = r.label;
			svgEl("rect", a, { x: rx, y: y - 17, width: 270, height: 34, rx: 8, class: `rel-box t-${r.kind}-b` });
			svgEl("circle", a, { cx: rx + 16, cy: y, r: 5, class: `t-${r.kind}` });
			const t = svgEl("text", a, { x: rx + 30, y: y + 4.5, class: "rel-title" });
			t.textContent = r.title.length > 32 ? `${r.title.slice(0, 31)}…` : r.title;
			const tip = svgEl("title", a);
			tip.textContent = `${r.title}: ${r.label}`;
		});
		svgEl("rect", svg, { x: cx - 120, y: cy - 22, width: 240, height: 44, rx: 10, class: `rel-box center t-${center.kind}-b` });
		const ct = svgEl("text", svg, { x: cx, y: cy + 5, "text-anchor": "middle", class: "rel-title strong" });
		ct.textContent = center.title.length > 28 ? `${center.title.slice(0, 27)}…` : center.title;
		// The same connections as a list, for narrow panes where the drawing's text would be too small (CSS picks one).
		const ul = cls(el("ul", fig), "rel-list");
		for (const r of shown) {
			const li = el("li", ul), a = el(r.href ? "a" : "span", li);
			if (r.href) a.setAttribute("href", r.href);
			cls(el("i", a), `sw t-${r.kind}`);
			el("strong", a, ` ${r.title}`);
			cls(el("span", li, r.label), "muted");
		}
		if (rows.length > cap) cls(el("figcaption", fig, `And ${rows.length - cap} more.`), "legend");
		return fig;
	};

	Object.assign(am, { daily, fitWeeks, bars, facets, related });
}
