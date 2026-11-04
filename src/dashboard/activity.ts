// Activity tab (TG6): when and how agents worked over the last year, from GET /api/profiles/:p/activity-summary.
// The shared profile choice (profiles: "any"): ?profile=P reads that profile; no ?profile reads every active profile through
// am.eachProfile, one summary each, and labels every row with its profile. Each reply's own from..to is what it covers: a read
// that runs out of budget starts later than asked (even after `to` when no day finished). A day only some profiles covered is
// marked partial, a day none covered shows as not read, and a profile that failed is named with its error. Nothing unread is
// counted as zero. Filters (day, kind, file) live in the address and repaint in place: a day reads that one day, a kind or file
// narrows the latest observations. Every value from the API reaches the page as text.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { ActivitySummary } from "../viewer/types";
import type { Am, J, LiveEvent, Node, ProfileResult } from "./am";

export function activityTab(am: Am): void {
	type Kind = keyof ActivitySummary["kinds"];
	type Filters = { day?: string; kind?: Kind; file?: string };
	type Part = { profile: string; s: ActivitySummary };
	/** Every profile's answer for one asked range, combined. Sums and lists come only from `parts` (the replies that covered a day). */
	type View = {
		asked: string; to: string; total: number; names: string[]; parts: Part[]; failed: { profile: string; why: string }[];
		days: Map<string, number>; sessions: number; observations: number; kinds: ActivitySummary["kinds"];
		top_files: ActivitySummary["top_files"];
		busiest: (ActivitySummary["busiest_sessions"][number] & { profile: string })[];
		latest: (ActivitySummary["latest"][number] & { profile: string })[];
	};

	const KINDS: [Kind, string][] = [["asks", "Asks"], ["decisions", "Decisions"], ["corrections", "Corrections"], ["commits", "Commits"], ["tests", "Tests"], ["prs", "PRs"]];
	// Latest observations carry only ask, decision, correction or outcome; commits, tests and PRs are outcomes there.
	const LATEST_KIND: Record<Kind, string> = { asks: "ask", decisions: "decision", corrections: "correction", commits: "outcome", tests: "outcome", prs: "outcome" };
	const CHIP: Record<string, string> = { ask: "c-blue", decision: "c-amber", correction: "c-red", outcome: "c-ok" };
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const DAY_MS = 86_400_000;
	const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
	const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
	const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ms(s)) && iso(ms(s)) === s;
	const when = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? "time unknown" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`; };
	const cls = (e: Node, c: string) => e.setAttribute("class", c);
	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
	/** A reply covers no day when its budget ran out inside the last day it was asked for. */
	const covers = (s: ActivitySummary) => s.from <= s.to;

	const combine = (asked: string, to: string, results: ProfileResult<ActivitySummary>[]): View => {
		const v: View = { asked, to, total: results.length, names: results.map((r) => r.profile), parts: [], failed: [], days: new Map(), sessions: 0, observations: 0,
			kinds: { asks: 0, decisions: 0, corrections: 0, commits: 0, tests: 0, prs: 0 }, top_files: [], busiest: [], latest: [] };
		const files = new Map<string, number>();
		for (const r of results) {
			if (!r.ok) { v.failed.push({ profile: r.profile, why: am.why(r.error) }); continue; }
			const s = r.value;
			if (!covers(s)) continue; // read, but no day finished: nothing of it is counted
			v.parts.push({ profile: r.profile, s });
			v.sessions += s.sessions;
			v.observations += s.observations;
			for (const d of s.days) if (d.count > 0) v.days.set(d.day, (v.days.get(d.day) ?? 0) + d.count);
			for (const [k] of KINDS) v.kinds[k] += s.kinds[k];
			for (const f of s.top_files) files.set(f.path, (files.get(f.path) ?? 0) + f.count);
			for (const b of s.busiest_sessions) v.busiest.push({ ...b, profile: r.profile });
			for (const l of s.latest) v.latest.push({ ...l, profile: r.profile });
		}
		v.top_files = [...files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([path, count]) => ({ path, count }));
		v.busiest = v.busiest.sort((a, b) => b.observations - a.observations).slice(0, 10);
		v.latest = v.latest.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 20);
		return v;
	};
	/** How many of the asked profiles counted `day` in full. */
	const coveredBy = (v: View, day: string) => v.parts.filter((p) => day >= p.s.from && day <= p.s.to).length;
	/** Every asked profile answered and counted the whole asked range. */
	const complete = (v: View) => !v.failed.length && v.parts.length === v.total && v.parts.every((p) => p.s.from === v.asked);

	am.tab({ id: "activity", group: "insight", label: "Activity", key: "v", profiles: "any", render: (root, route) => {
		const version = am.pageVersion;
		const h = am.el("h2", root, "Activity");
		am.intro(root, "Activity", "activity_tab", "When your agents worked over the last 12 months, the kinds of work, and the latest observations. Pick a day, a kind or a file to filter.");

		// The shell has already refused an unknown or inactive ?profile; no ?profile is All profiles.
		const only = route.query.profile ?? null, all = only === null;
		const scope = am.el("p", root, all ? `All profiles: ${am.active().map((p) => p.name).join(", ") || "none active"}.` : `Profile: ${only}.`);
		cls(scope, "muted");
		am.help(scope, "profile_choice");
		if (all && !am.active().length) { am.empty(root, "No active profiles yet."); return h; }

		const to = iso(Date.now()), asked = iso(ms(to) - 364 * DAY_MS);
		const path = (p: string, a: string, b: string) => `/api/profiles/${am.enc(p)}/activity-summary?from=${a}&to=${b}`;
		const filters: Filters = {};
		if (isDay(route.query.day) && route.query.day >= asked && route.query.day <= to) filters.day = route.query.day;
		if (KINDS.some(([k]) => k === route.query.kind)) filters.kind = route.query.kind as Kind;
		if (route.query.file && route.query.file.length <= 1024) filters.file = route.query.file;

		const tools = am.el("div", root);
		cls(tools, "toolbar");
		const msg = am.live(root);
		const body = am.el("div", root);
		am.loading(body, 6);

		let year: View | null = null, painting = 0;
		const dayCache = new Map<string, View>();
		const load = async (a: string, b: string) => combine(a, b, await am.eachProfile(only, async (p) => (await am.call(path(p.name, a, b))) as ActivitySummary));

		const address = () => {
			const q = [only !== null ? `profile=${am.enc(only)}` : "", filters.day ? `day=${filters.day}` : "", filters.kind ? `kind=${filters.kind}` : "", filters.file ? `file=${am.enc(filters.file)}` : ""].filter(Boolean);
			try { am.win.history?.replaceState?.(null, "", `#activity${q.length ? `?${q.join("&")}` : ""}`); } catch { /* the filter still applies; only the address is stale */ }
		};
		/** Repaints the body, keeping focus on the control with the same data-f key when it is still there. */
		const repaint = async () => {
			const focused = am.doc.activeElement?.getAttribute?.("data-f");
			const req = ++painting, day = filters.day; // filters only replace the address, so a later pick does not change pageVersion
			let shown: View = year!;
			if (day) {
				let d = dayCache.get(day);
				if (!d) {
					msg.textContent = `Loading ${day}…`;
					d = await load(day, day);
					if (version !== am.pageVersion) return;
					dayCache.set(day, d);
					if (req !== painting) return;
					msg.textContent = "";
				}
				shown = d;
			}
			paint(shown);
			if (focused) for (const e of [...(body as J).querySelectorAll("[data-f]")]) if (e.getAttribute("data-f") === focused) { e.focus(); break; }
		};
		const set = (patch: Filters) => {
			for (const k of Object.keys(patch) as (keyof Filters)[]) {
				const v = patch[k];
				if (v === undefined || filters[k] === v) delete filters[k]; else (filters as Record<string, string>)[k] = v;
			}
			address();
			msg.textContent = "";
			void repaint();
		};

		const paint = (shown: View) => {
			body.replaceChildren();
			const y = year!;
			if (!y.parts.length && y.failed.length === y.total) {
				const box = am.el("div", body);
				for (const f of y.failed) am.note(box, `Could not load activity for ${f.profile}: ${f.why}. Nothing is shown rather than a guess; use Refresh to try again.`, "danger");
				return;
			}
			if (complete(y) && y.observations === 0) {
				am.empty(body, `No observations ${all ? "in any profile" : `in ${only}`} in the last 12 months. They appear when a device's capture hooks upload session digests, or when you import past transcripts.`, "agent-memory backfill");
				// Most touched files come from corpus commits, which are read apart from observations, so they still show.
				if (y.top_files.length) { const files = am.el("section", body); cls(files, "panel"); fileList(files, y); }
				return;
			}
			whenPanel(y);
			filterLine();
			const did = am.el("section", body);
			cls(did, "panel");
			am.el("h3", did, filters.day ? `What agents did on ${filters.day}` : "What agents did");
			if (filters.day) readTable(did, shown);
			if (!shown.parts.length) {
				// No asked profile counted this range in full: say so, never show zeros.
				am.note(did, filters.day ? `No profile's counts for ${filters.day} can be shown: it has more digest parts than one read covers, or the read failed.`
					: "No profile counted a full day before its read limit ran out, so there are no counts to show. Pick a day to read it alone.", "warn");
				return;
			}
			const grid = am.el("div", did);
			cls(grid, "cards");
			kindBars(am.el("div", grid), shown);
			fileList(am.el("div", grid), shown);
			sessionList(am.el("div", grid), shown);
			latestList(shown);
		};

		/** One row per asked profile: what its read covered, or why it is missing. Shown with All profiles and whenever a read is partial. */
		const readTable = (parent: Node, v: View) => {
			if (v.total === 1 && complete(v)) return;
			const table = am.el("table", parent);
			const cap = am.el("caption", table, complete(v) ? "Every profile was read in full." : "Partial: some profiles were not read in full, so the counts below cover only what was read.");
			cap.setAttribute("style", "text-align:left");
			am.help(cap, "coverage");
			const hr = am.el("tr", am.el("thead", table));
			for (const t of ["Profile", "Covered", "Observations"]) am.el("th", hr, t).setAttribute("scope", "col");
			const tb = am.el("tbody", table);
			const fail = new Map(v.failed.map((f) => [f.profile, f.why])), part = new Map(v.parts.map((p) => [p.profile, p.s]));
			for (const name of v.names) {
				const tr = am.el("tr", tb), s = part.get(name), why = fail.get(name);
				am.el("th", tr, name).setAttribute("scope", "row");
				if (why !== undefined) { const td = am.el("td", tr, `Failed: ${why}`); td.setAttribute("colspan", "2"); cls(td, "c-fail"); continue; }
				if (!s) { const td = am.el("td", tr, `Not counted: the read limit ran out inside ${v.to}.`); td.setAttribute("colspan", "2"); cls(td, "c-warn"); continue; }
				am.el("td", tr, s.from === v.asked ? `${s.from} to ${s.to}` : `Partial: ${s.from} to ${s.to} (asked from ${v.asked})`);
				am.el("td", tr, String(s.observations));
			}
		};

		const whenPanel = (y: View) => {
			const sec = am.el("section", body);
			cls(sec, "panel");
			const t = am.el("h3", sec, "When agents worked");
			am.help(t, "observations");
			const full = complete(y);
			if (y.total === 1 && y.parts.length) cls(am.el("p", sec, `Covers ${y.parts[0]!.s.from} to ${y.to} (UTC).`), "muted");
			if (y.total === 1 && !full && y.parts.length)
				am.note(sec, `Partial: the read limit stopped at ${y.parts[0]!.s.from}, so earlier days are not counted and show as not read. Pick one of those days to read it alone.`, "warn");
			if (y.total === 1 && !y.parts.length) am.note(sec, `Not counted: the read limit ran out inside ${y.to}, the last day asked for. No day from ${asked} to ${y.to} is covered.`, "warn");
			if (y.total > 1) readTable(sec, y);
			if (y.parts.length) {
				const stats = am.el("div", sec);
				cls(stats, "stats");
				let busiest: [string, number] | null = null;
				for (const d of y.days) if (!busiest || d[1] > busiest[1]) busiest = d;
				const of = full ? "" : " (what was read)";
				for (const [n, label] of [[String([...y.days.values()].filter((c) => c > 0).length), `Active days${of}`], [String(y.sessions), `Sessions${of}`],
					[String(y.observations), `Observations${of}`], [busiest?.[0] ?? "None", busiest ? `Busiest day · ${plural(busiest[1], "observation")}${of}` : `Busiest day${of}`]] as [string, string][]) {
					const s = am.el("div", stats);
					cls(s, "stat");
					cls(am.el("span", s, n), "num");
					cls(am.el("span", s, label), "lbl");
				}
			}
			heatmap(sec, y);
		};

		/**
		 * The year as a grid: a column per week (Sunday first), a row per weekday, a button per day named with its count. A day every
		 * asked profile covered shows its count (0 is a real zero); a day only some covered is dashed and says how many; a day none
		 * covered was not read and says so.
		 */
		const heatmap = (parent: Node, y: View) => {
			const max = Math.max(0, ...y.days.values());
			const b1 = Math.ceil(max / 4), b2 = Math.ceil(max / 2), b3 = Math.ceil((3 * max) / 4);
			const level = (c: number) => (c <= 0 ? 0 : c <= b1 ? 1 : c <= b2 ? 2 : c <= b3 ? 3 : 4);
			const SHADE = ["", "22%", "45%", "70%", "100%"];
			const fill = (l: number) => (l === 0 ? "background:transparent" : `background:color-mix(in srgb,var(--ok) ${SHADE[l]},var(--panel))`);
			const UNREAD = "background:repeating-linear-gradient(45deg,var(--rule) 0 1px,transparent 1px 3px)";
			const start = ms(asked) - new Date(ms(asked)).getUTCDay() * DAY_MS, end = ms(to);
			const weeks = Math.floor((end - start) / DAY_MS / 7) + 1;
			const focusDay = filters.day ?? to;
			let partialSeen = false, unreadSeen = false;

			const wrap = am.el("div", parent);
			wrap.setAttribute("style", "overflow-x:auto;max-width:100%;padding:.2rem 0");
			const table = am.el("table", wrap);
			table.setAttribute("role", "grid");
			table.setAttribute("aria-label", `Observations per day in ${all ? "all profiles" : only}, ${asked} to ${to} (UTC). Arrow keys move between days; Enter reads and filters by the day.`);
			table.setAttribute("style", "width:auto;border-collapse:separate;border-spacing:2px;font:10px var(--mono)");
			const cellStyle = "padding:0;border:0;line-height:1";
			const labelStyle = `${cellStyle};color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0`;
			const head = am.el("tr", am.el("thead", table));
			am.el("th", head).setAttribute("style", cellStyle);
			for (let w = 0; w < weeks; w++) {
				const first = new Date(start + w * 7 * DAY_MS);
				const th = am.el("th", head, first.getUTCDate() <= 7 && start + w * 7 * DAY_MS >= ms(asked) - 6 * DAY_MS ? MONTHS[first.getUTCMonth()]! : "");
				th.setAttribute("scope", "col");
				th.setAttribute("style", `${labelStyle};text-align:left`);
			}
			const tbody = am.el("tbody", table);
			const buttons: J[] = [];
			for (let r = 0; r < 7; r++) {
				const tr = am.el("tr", tbody);
				const th = am.el("th", tr);
				th.setAttribute("scope", "row");
				th.setAttribute("style", `${labelStyle};padding-right:.4rem`);
				// Mon, Wed and Fri show; the other rows keep their name for screen readers only.
				if (r % 2 === 1 && r < 6) am.el("span", th, WEEKDAYS[r]!.slice(0, 3)); else cls(am.el("span", th, WEEKDAYS[r]!), "vh");
				for (let w = 0; w < weeks; w++) {
					const t = start + (w * 7 + r) * DAY_MS, td = am.el("td", tr);
					td.setAttribute("style", cellStyle);
					if (t < ms(asked) || t > end) continue;
					const day = iso(t), on = filters.day === day, n = coveredBy(y, day), c = y.days.get(day) ?? 0;
					const state = n === 0 ? "unread" : n < y.total ? "partial" : "read";
					if (state === "partial") partialSeen = true;
					if (state === "unread") unreadSeen = true;
					const count = c === 0 ? "no observations" : plural(c, "observation");
					const b: J = am.el("button", td);
					b.setAttribute("type", "button");
					b.setAttribute("data-f", `day:${day}`);
					b.setAttribute("data-day", day);
					b.setAttribute("aria-label", `${day}, ${WEEKDAYS[r]}: ${state === "unread" ? "not read yet" : state === "partial" ? `${count} in ${n} of ${plural(y.total, "profile")}; the others were not read` : count}`);
					b.setAttribute("title", `${day}: ${state === "unread" ? "not read" : state === "partial" ? `${c} (${n} of ${y.total} profiles read)` : c}`);
					b.setAttribute("aria-pressed", on ? "true" : "false");
					b.setAttribute("tabindex", day === focusDay ? "0" : "-1");
					b.setAttribute("style", `display:block;width:11px;height:11px;padding:0;margin:0;border:1px ${state === "read" ? "solid" : "dashed"} ${state !== "unread" && c ? "var(--ok)" : "var(--line)"};${state === "unread" ? UNREAD : fill(level(c))}${on ? ";outline:2px solid var(--accent);outline-offset:1px" : ""}`);
					b.addEventListener("click", () => set({ day }));
					buttons.push(b);
				}
			}
			// The grid is built a weekday row at a time; the keys move by date, so the list is put in date order (every day has a button).
			buttons.sort((a, b) => (a.getAttribute("data-day") < b.getAttribute("data-day") ? -1 : 1));
			if (!buttons.some((b) => b.getAttribute("tabindex") === "0")) buttons[buttons.length - 1]?.setAttribute("tabindex", "0");
			// Left and right move a week, up and down a day; Home and End jump to the first and last day.
			table.addEventListener("keydown", (e: J) => {
				const step: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
				const at = buttons.indexOf(e.target);
				if (at < 0 || !(e.key in step || e.key === "Home" || e.key === "End")) return;
				e.preventDefault();
				const b = buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : at + step[e.key]!];
				if (!b) return;
				buttons[at].setAttribute("tabindex", "-1");
				b.setAttribute("tabindex", "0");
				b.focus();
			});

			const legend = am.el("p", parent);
			legend.setAttribute("style", "display:flex;flex-wrap:wrap;align-items:center;gap:3px;font:11px var(--mono);color:var(--muted);margin:.4rem 0 0");
			const swatch = (style: string) => {
				const s = am.el("span", legend);
				s.setAttribute("aria-hidden", "true");
				s.setAttribute("style", `display:inline-block;width:11px;height:11px;${style}`);
			};
			const word = (t: string) => am.el("span", legend, t).setAttribute("aria-hidden", "true");
			word("Less");
			for (let l = 0; l <= 4; l++) swatch(`border:1px solid ${l ? "var(--ok)" : "var(--line)"};${fill(l)}`);
			word("More");
			if (partialSeen) { word(" "); swatch(`border:1px dashed var(--ok);${fill(2)}`); word("Some profiles read"); }
			if (unreadSeen) { word(" "); swatch(`border:1px dashed var(--line);${UNREAD}`); word("Not read"); }
			cls(am.el("span", legend, `${max === 0 ? "Less to more: no day that was read has observations."
				: `Less to more: no observations, then up to ${b1}, ${b2}, ${b3} and ${max} observations a day.`}${partialSeen ? " Dashed filled days were read in only some profiles." : ""}${unreadSeen ? " Hatched days were not read." : ""}`), "vh");
		};

		const filterLine = () => {
			const on = [filters.day ? ["day", `Day ${filters.day}`] : null, filters.kind ? ["kind", `Kind ${KINDS.find(([k]) => k === filters.kind)![1]}`] : null,
				filters.file ? ["file", `File ${filters.file}`] : null].filter(Boolean) as [keyof Filters, string][];
			const p = am.el("div", body);
			cls(p, "toolbar");
			if (!on.length) { cls(am.el("span", p, "No filters. Pick a day, a kind or a file."), "muted"); return; }
			am.el("span", p, "Filtered by:");
			for (const [k, text] of on) {
				const b = am.el("button", p, `${text} ×`);
				b.setAttribute("type", "button");
				b.setAttribute("data-f", `clear:${k}`);
				b.setAttribute("aria-label", `Remove the ${k} filter: ${text}`);
				b.addEventListener("click", () => set({ [k]: filters[k] } as Filters));
			}
			const clear = am.el("button", p, "Clear all");
			clear.setAttribute("type", "button");
			clear.addEventListener("click", () => { delete filters.day; delete filters.kind; delete filters.file; address(); void repaint(); });
		};

		const toggleList = (box: Node) => {
			const list = am.el("ul", box);
			list.setAttribute("data-list", "");
			list.setAttribute("style", "list-style:none;padding:0;margin:0");
			return list;
		};
		const toggle = (list: Node, f: string, pressed: boolean, label: string, onClick: () => void) => {
			const b = am.el("button", am.el("li", list));
			b.setAttribute("type", "button");
			b.setAttribute("data-item", "");
			b.setAttribute("data-f", f);
			b.setAttribute("aria-pressed", pressed ? "true" : "false");
			b.setAttribute("aria-label", label);
			b.setAttribute("style", "display:flex;align-items:center;gap:.5rem;width:100%;text-align:left;margin:0 0 .25rem;text-transform:none");
			b.addEventListener("click", onClick);
			return b;
		};
		const bar = (parent: Node, n: number, top: number) => {
			const s = am.el("span", parent);
			cls(s, "bar");
			s.setAttribute("aria-hidden", "true");
			am.el("i", s).setAttribute("style", `width:${Math.round((n / Math.max(1, top)) * 100)}%`);
		};
		const tag = (parent: Node, profile: string) => { if (all) cls(am.el("span", parent, profile), "chip chip-profile"); };

		const kindBars = (box: Node, v: View) => {
			am.el("h4", box, "Kind of work");
			const list = toggleList(box), top = Math.max(...KINDS.map(([k]) => v.kinds[k]));
			for (const [k, label] of KINDS) {
				const n = v.kinds[k], on = filters.kind === k;
				const b = toggle(list, `kind:${k}`, on, `${label}: ${n}. ${on ? "Remove this filter" : "Filter the latest observations by this kind"}`, () => set({ kind: k }));
				am.el("span", b, label).setAttribute("style", "min-width:6.5rem");
				bar(b, n, top);
				am.el("span", b, String(n));
			}
			if (filters.kind && LATEST_KIND[filters.kind] === "outcome") am.note(box, "Commits, tests and PRs all show as outcomes in the latest observations.", "muted");
		};

		const fileList = (box: Node, v: View) => {
			const t = am.el("h4", box, "Most touched files");
			am.help(t, "corpus");
			if (!v.top_files.length) {
				const corpus = am.snapshot?.flags.find((f) => f.id === "corpus")?.state;
				const meOnly = v.parts.every((p) => p.profile === "me");
				am.note(box, meOnly ? "The me profile has no corpus, so it lists no files."
					: corpus === "on" ? "No corpus commits name a file in this range."
						: corpus ? "The corpus is off, so no file paths are read and none are listed."
							: "File paths come from corpus commits, which are read only while the corpus is on. None are listed for this range.");
				return;
			}
			const list = toggleList(box), top = Math.max(...v.top_files.map((f) => f.count));
			for (const f of v.top_files) {
				const on = filters.file === f.path;
				const b = toggle(list, `file:${f.path}`, on, `${f.path}: ${f.count}. ${on ? "Remove this filter" : "Show the latest observations that name this file"}`, () => set({ file: f.path }));
				const p = am.el("span", b, f.path);
				p.setAttribute("style", "flex:1;overflow-wrap:anywhere");
				cls(p, "mono");
				bar(b, f.count, top);
				am.el("span", b, String(f.count));
			}
			if (v.parts.length > 1) am.note(box, "Each profile's own top files, added up.", "muted");
		};

		const sessionHref = (profile: string, id: string) => `#sessions/${am.enc(id)}?profile=${am.enc(profile)}`;
		const sessionList = (box: Node, v: View) => {
			am.el("h4", box, "Busiest sessions");
			if (!v.busiest.length) { am.note(box, "No sessions in this range."); return; }
			const list = am.el("ul", box);
			list.setAttribute("data-list", "");
			list.setAttribute("style", "list-style:none;padding:0;margin:0");
			for (const x of v.busiest) {
				const li = am.el("li", list);
				li.setAttribute("style", "margin:0 0 .35rem");
				tag(li, x.profile);
				const a = am.el("a", li, x.title ?? `Session ${x.id.slice(0, 8)} (no ask recorded)`);
				a.setAttribute("href", sessionHref(x.profile, x.id));
				a.setAttribute("data-item", "");
				cls(am.el("span", li, ` · ${plural(x.observations, "observation")}`), "muted");
			}
		};

		const latestList = (v: View) => {
			const sec = am.el("section", body);
			cls(sec, "panel");
			am.el("h3", sec, "Latest observations");
			let rows = v.latest;
			if (filters.kind) rows = rows.filter((l) => l.kind === LATEST_KIND[filters.kind!]);
			if (filters.file) {
				const f = filters.file, base = f.split("/").pop() ?? f;
				rows = rows.filter((l) => l.text.includes(f) || (base.length > 2 && l.text.includes(base)));
			}
			const what = [filters.kind ? KINDS.find(([k]) => k === filters.kind)![1].toLowerCase() : "", filters.file ? `naming ${filters.file}` : ""].filter(Boolean).join(", ");
			cls(am.el("p", sec, `${rows.length} of the ${v.latest.length} latest${what ? ` (${what})` : ""}, newest first. Each links to its session. New uploads refresh this list.`), "muted");
			if (!rows.length) { am.note(sec, filters.kind || filters.file ? "None of the latest observations match these filters." : "No observations in this range."); return; }
			const list = am.el("ul", sec);
			list.setAttribute("data-list", "");
			cls(list, "prefs");
			for (const l of rows) {
				const li = am.el("li", list);
				tag(li, l.profile);
				cls(am.el("span", li, l.kind), `chip ${CHIP[l.kind] ?? ""}`);
				const a = am.el("a", li, l.text);
				a.setAttribute("href", sessionHref(l.profile, l.session));
				a.setAttribute("data-item", "");
				cls(am.el("div", li, when(l.at)), "muted");
			}
		};

		const refresh = async (quiet: boolean) => {
			if (!quiet) msg.textContent = "Refreshing…";
			const y = await load(asked, to);
			if (version !== am.pageVersion) return;
			year = y;
			dayCache.clear();
			msg.textContent = quiet ? "" : `Updated ${when(new Date().toISOString())}.`;
			await repaint();
		};
		const again = am.el("button", tools, "Refresh");
		again.setAttribute("type", "button");
		again.addEventListener("click", () => void refresh(false));
		if (only !== null) { am.copy(tools, "Copy curl", () => am.curl("GET", path(only, asked, to))); am.help(tools, "curl"); }

		// Live: a new upload (IMPORT) in a shown profile, or a reconnect after a pause, reloads the summaries a moment later.
		let timer: J, paused = false;
		const unsubscribe = am.api.subscribe((e: LiveEvent) => {
			if (version !== am.pageVersion) { unsubscribe(); clearTimeout(timer); return; }
			const due = (e.type === "change" && e.item.kind === "IMPORT" && (all || e.item.profile === only)) || (e.type === "snapshot" && paused);
			if (e.type === "paused") paused = true;
			if (e.type === "snapshot") paused = false;
			if (!due || !year) return;
			clearTimeout(timer);
			timer = setTimeout(() => { if (version === am.pageVersion) void refresh(true); }, 1500);
		});
		// A capture upload stores digest parts without an activity row, so no live event marks it. While this tab is open and the
		// stream is up, the summaries are read again every POLL_MS; leaving the tab ends the chain.
		const POLL_MS = 60_000;
		const poll = () => am.win.setTimeout(async () => {
			if (version !== am.pageVersion) return;
			if (!paused && year) await refresh(true);
			if (version === am.pageVersion) poll();
		}, POLL_MS);

		// eachProfile turns every failed read into its own result, so these loads never throw for a profile's error.
		void (async () => {
			const y = await load(asked, to);
			if (version !== am.pageVersion) return;
			year = y;
			await repaint();
			poll();
		})();
		return h;
	} });
}
