// The owner's library: Home, Memories, Learnings, Journals, People, Projects and Search. Every section is a full-width list with
// the selected item's detail beside it; the detail shows its content and its Connections, grouped by type. People and Projects
// are hubs: everything linked to that person or project, a small connection graph and its activity over time. Data comes from
// the library (store.ts) and, for one item's text, the node and journal reads. Browser code, serialized into /app.js: it may use
// only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node, Route } from "./am";

export function libraryTab(am: Am): void {
	const { el, enc, call, note, why, win } = am;
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const JOURNAL_PAGES = 400; // 25 entries a page
	const NAMES: Record<string, [string, string]> = { memory: ["memory", "Memories"], learning: ["learning", "Learnings"], journal: ["journal", "Journals"], person: ["person", "People"],
		project: ["project", "Projects"] };
	const TYPE: Record<string, string> = { project: "Project note", reference: "Reference", procedural: "How-to", feedback: "Rule", user: "About you", decision: "Decision", document: "Note" };
	const typeOf = (it: J) => it.kind === "learning" ? (it.raw === "preference" || it.type === "user" ? "Preference" : "Rule") : it.kind === "memory" ? TYPE[it.type ?? it.raw] ?? "Note"
		: it.kind === "journal" ? "Journal" : it.kind === "person" ? "Person" : "Project";
	/**
	 * Sub-types inside a page (the facet chips, their bar, the daily chart and the list's dots) take a categorical colour of
	 * their own, fixed per name so Rule is the same colour everywhere. Three validated hues (s1 blue, s2 orange, s3 aqua; see
	 * style.ts) cover every page's sub-types today; anything rarer is s0, neutral grey, and always carries its text label.
	 */
	const SUB: Record<string, number> = { Rule: 1, Preference: 2, Reference: 1, "Project note": 2, "How-to": 3, Codex: 1, "Claude Code": 2 };
	// Workspaces come from the owner's registry: the first three in its order take the three hues, any further one the neutral.
	const subOf = (name: string) => { const w = am.workspaceOrder.indexOf(name); return `s${SUB[name] ?? (w >= 0 && w < 3 ? w + 1 : 0)}`; };
	const TABS_OF: Record<string, string> = { memory: "memories", learning: "learnings", journal: "journals" };
	const facetName = (it: J) => it.kind === "journal" ? it.agent ?? "Other agent" : typeOf(it);
	const count = (n: number, kind: string) => `${n.toLocaleString()} ${n === 1 ? NAMES[kind]?.[0] ?? kind : (NAMES[kind]?.[1] ?? `${kind}s`).toLowerCase()}`;
	const profileQ = (route: Route) => route.query.profile ?? null;
	const href = (it: J, route: Route) => am.itemHref(it, profileQ(route));

	/** The items linked to `key`, by kind (sessions are only ever a source line), most recent first. */
	const neighbours = (lib: J, key: string) => {
		const by = new Map<string, { it: J; rels: string[] }[]>();
		for (const [k, rels] of lib.links.get(key) ?? new Map()) {
			const it = lib.items.get(k);
			if (!it) continue;
			(by.get(it.kind) ?? by.set(it.kind, []).get(it.kind)!).push({ it, rels: [...rels] });
		}
		for (const l of by.values()) l.sort((a, b) => String(b.it.updated ?? "").localeCompare(String(a.it.updated ?? "")));
		return by;
	};
	/** One meta line for a list row: what it is, where it belongs and when it last changed. */
	const metaOf = (lib: J, it: J, all: boolean) => {
		const nb = neighbours(lib, it.key), parts: string[] = [];
		if (it.kind === "project" && it.alias) parts.push(it.name.split("/")[1]);
		if (it.kind === "person" || it.kind === "project") {
			for (const k of ["memory", "learning", "journal"]) { const n = nb.get(k)?.length ?? 0; if (n) parts.push(count(n, k)); }
			if (parts.length === (it.alias ? 1 : 0)) parts.push(it.known ? "Nothing in memory yet" : "No connections yet");
		} else {
			parts.push(it.kind === "journal" ? it.agent ?? "Other agent" : typeOf(it));
			const proj = nb.get("project")?.[0]?.it;
			if (proj) parts.push(proj.wide ? `${am.workspaceName(proj.workspace)}, workspace-wide` : proj.title);
		}
		if (it.kind !== "project" && all) parts.push(it.p);
		if (it.filedUnder) parts.push(`in your ${it.filedUnder} profile`);
		return parts;
	};
	const row = (ul: Node, lib: J, it: J, route: Route, selected: string | null, extra: string[] = []) => {
		const li = el("li", ul), a = cls(el("a", li), "row");
		a.setAttribute("href", href(it, route));
		a.setAttribute("data-item", "");
		if (it.key === selected) a.setAttribute("aria-current", "true");
		const top = cls(el("span", a), "row-top");
		// On the record's own section the dot is its sub-type; anywhere else, its kind.
		cls(el("i", top), `sw t-${route.tab === TABS_OF[it.kind] ? subOf(facetName(it)) : it.kind}`).setAttribute("aria-hidden", "true");
		const tt = cls(el("span", top), "row-title");
		am.title(it, tt);
		if (it.updated) am.time(top, it.updated);
		cls(el("span", a, [...metaOf(lib, it, profileQ(route) === null), ...extra].join(" · ")), "row-meta");
		if (it.url) { li.setAttribute("class", "has-gh"); const gh = cls(el("a", li, "GitHub ↗"), "gh"); gh.setAttribute("href", it.url); gh.setAttribute("target", "_blank"); gh.setAttribute("rel", "noopener noreferrer"); gh.setAttribute("title", it.url); }
	};

	// ---- Detail ----
	/** "a Codex session", "an agent session": the client of a session, with the right article. */
	const aSession = (agent: string | null) => (agent ? `a ${agent} session` : "an agent session");
	/** The sessions a record came from: session records it links to (with their date), else session references in its evidence. */
	const fromSessions = (lib: J, it: J, ev: J[] = []) => {
		const viaNode = ev.filter((e) => e?.kind === "node").map((e) => lib.items.get(`${it.p}/${String(e.ref)}`)).filter((o: J) => o?.kind === "session");
		const linked = [...new Set([...(neighbours(lib, it.key).get("session") ?? []).map((x) => x.it), ...viaNode])].sort((a: J, b: J) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
		const refs = ev.filter((e) => e?.kind === "session").map((e) => { const c = String(e.ref ?? "").split(":")[0]; return c === "codex" ? "Codex" : c === "claude-code" ? "Claude Code" : null; });
		return { linked, refs };
	};
	const sources = (lib: J, it: J, ev: J[]) => {
		const { linked, refs } = fromSessions(lib, it, ev), n = Math.max(linked.length, refs.length);
		if (!n) return "";
		const latest = linked[0], agent = latest?.agent ?? refs.find(Boolean) ?? null, when = latest ? am.when(latest.created ?? latest.updated).text : "";
		return `From ${n === 1 ? aSession(agent) : `${n} ${agent ? `${agent} ` : ""}sessions`}${when ? ` · ${when}` : ""}`;
	};
	/**
	 * Connections as named rows: where it came from, its project, then related memories, learnings and journals. Related means a
	 * real link first (a graph edge), then the same project or the same source session, and each row says which. Up to five titles
	 * a row and "+N more"; a row with nothing is left out, so a record with no connections shows nothing extra.
	 */
	/**
	 * Where a record came from, once its own read arrives: who put it there (stated by you, an agent, inferred, repo facts, a
	 * device), the sessions it came from (linked session records, session records named in its evidence, and the client's own
	 * session references), and any commit, PR, link or file it cites. Shown first in Connections; nothing is guessed.
	 */
	/** A link's human name: the evidence's own title when it has one, else what the address says (a GitHub issue or PR,
	 * a draft page, or the site and its last path words), never the raw opaque address. The address stays in the tooltip. */
	const linkName = (url: string, e: J) => {
		const own = [e?.title, e?.label, e?.note].find((x) => typeof x === "string" && x.trim());
		if (own) return String(own).trim().slice(0, 60);
		let u: URL;
		try { u = new URL(url); } catch { return "Link"; }
		const host = u.hostname.replace(/^www\./, ""), parts = u.pathname.split("/").filter(Boolean);
		if (host === "github.com" && parts.length >= 4 && (parts[2] === "issues" || parts[2] === "pull")) return `${parts[1]} ${parts[2] === "pull" ? "PR" : "issue"} #${parts[3]}`;
		if (host === "github.com" && parts.length >= 2) return `${parts[1]} on GitHub`;
		if (/^drafts?\./.test(host)) return "Draft page";
		const word = parts.reverse().find((x) => !/^[0-9a-f]{8,}$/i.test(x) && !/^\d+$/.test(x));
		if (!word) return host;
		let plain = word;
		try { plain = decodeURIComponent(word); } catch { /* a malformed escape ("100%") keeps the path text as it is */ }
		return `${host}: ${plain.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "").slice(0, 40)}`;
	};
	const ORIGIN: Record<string, string> = { stated: "Stated by you", inferred: "Inferred by an agent", agent: "Saved by an agent", migration: "Imported", maintenance: "Kept by tidy-up" };
	const fromRow = (rail: Node, sec: Node | null, lib: J, it: J, r: J) => {
		const n = r?.node ?? {}, ev: J[] = Array.isArray(r?.evidence?.items) ? r.evidence.items : [];
		const chips: [string, string, string, string?][] = []; // [text, href, kind, detail on hover]
		const src = String(n.source_platform ?? "");
		// A device's machine name is detail, not the headline: "Saved by an agent", with the device in the tooltip.
		const by = src === "facts" ? "From repo facts" : src.startsWith("device:") ? "Saved by an agent" : ORIGIN[String(n.origin ?? "")] ?? "";
		if (by) chips.push([`${by}${n.created_at ? ` · ${am.when(n.created_at).text}` : ""}`, "", "origin", src.startsWith("device:") ? `Saved from the device ${src.slice(7)}` : undefined]);
		const seen = new Set<string>();
		const sessionsOf = [...(neighbours(lib, it.key).get("session") ?? []).map((x) => x.it), ...ev.filter((e) => e?.kind === "node").map((e) => lib.items.get(`${it.p}/${String(e.ref)}`)).filter((o: J) => o?.kind === "session")];
		for (const s2 of sessionsOf) if (!seen.has(s2.key)) { seen.add(s2.key); chips.push([`${aSession(s2.agent).replace(/^an? /, "").replace(/^./, (x: string) => x.toUpperCase())} · ${am.when(s2.created ?? s2.updated).text}`, "", "session"]); }
		for (const e of ev) {
			const ref = String(e?.ref ?? ""), k = String(e?.kind ?? "");
			if (k === "session") { const c = ref.split(":")[0]; const agent = c === "codex" ? "Codex" : c === "claude-code" ? "Claude Code" : null; if (!seen.has(ref)) { seen.add(ref); chips.push([`${agent ?? "Agent"} session`, "", "session"]); } }
			else if (k === "commit") { const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40})$/i.exec(ref); chips.push([m ? `Commit ${m[2]!.slice(0, 7)}` : `Commit ${ref.slice(0, 20)}`, m ? `https://github.com/${m[1]}/commit/${m[2]}` : "", "commit"]); }
			else if ((k === "pr" || k === "url") && /^https?:\/\//.test(ref)) chips.push([k === "pr" ? `PR ${ref.replace(/^.*\/pull\//, "#")}` : linkName(ref, e), ref, k]);
			else if (k === "file") chips.push([ref.split("/").filter(Boolean).at(-1) ?? ref, "", "file"]);
		}
		if (!chips.length) return null;
		let box = sec;
		if (!box) { box = cls(el("section"), "connections"); el("h3", box, "Connections"); if ((rail as J).firstChild) (rail as J).insertBefore(box, (rail as J).firstChild); else rail.appendChild(box); }
		const g = cls(el("div"), "conn-group from"), head = (box as J).querySelector?.("h3");
		cls(el("h4", g, "From"), "conn-head");
		const list = cls(el("div", g), "chips");
		for (const [text, to, kind, detail] of chips.slice(0, 6)) {
			const c = cls(el(to ? "a" : "span", list), `chip-link from-${kind}`);
			if (detail) c.setAttribute("title", detail);
			if (to) { c.setAttribute("href", to); c.setAttribute("target", "_blank"); c.setAttribute("rel", "noopener noreferrer"); c.setAttribute("title", to); }
			el("span", c, text);
		}
		if (chips.length > 6) cls(el("span", list, `+${chips.length - 6} more`), "more-link");
		if (head && (head as J).nextSibling) (box as J).insertBefore?.(g, (head as J).nextSibling); else box.appendChild(g);
		return { box, g };
	};
	const connections = (parent: Node, lib: J, it: J, route: Route): Node | null => {
		const nb = neighbours(lib, it.key), mine = lib.links.get(it.key) as Map<string, Set<string>> | undefined;
		const projects = (nb.get("project") ?? []).map((x) => x.it);
		const sessions = (nb.get("session") ?? []).map((x) => x.it);
		const recent = (a: J, b: J) => String(b.updated ?? "").localeCompare(String(a.updated ?? ""));
		const records = (keys: Iterable<string>) => [...keys].map((k) => lib.items.get(k)).filter((o: J) => o && o.key !== it.key && (o.kind === "memory" || o.kind === "learning" || o.kind === "journal"));
		// Linked: a recorded link from this record (labelled with how), or the same agent session. Each record once.
		const why = new Map<string, string>();
		for (const o of records(mine?.keys() ?? [])) why.set(o.key, [...(mine!.get(o.key) ?? [])].filter((r) => r !== "in project").join(", ") || "linked");
		for (const s2 of sessions) for (const o of records(lib.links.get(s2.key)?.keys() ?? [])) if (!why.has(o.key)) why.set(o.key, "same session");
		const linked = [...why.keys()].map((k) => lib.items.get(k)).sort(recent);
		// Same project: everything else in its project, newest first, folded away under the links.
		const peers = new Map<string, J>();
		for (const p of projects) for (const o of records(lib.links.get(p.key)?.keys() ?? [])) if (!why.has(o.key)) peers.set(o.key, o);
		const rows: [string, J[], { rel?: boolean; more?: string }][] = [];
		if (projects.length) rows.push(["Project", projects, {}]);
		if (it.kind === "journal") {
			// What this journal's work wrote down: memories and learnings linked to it or to its session.
			const m = linked.filter((o: J) => o.kind === "memory"), l = linked.filter((o: J) => o.kind === "learning"), j = linked.filter((o: J) => o.kind === "journal");
			if (m.length) rows.push([`Wrote ${count(m.length, "memory")}`, m, {}]);
			if (l.length) rows.push([`Wrote ${count(l.length, "learning")}`, l, {}]);
			if (j.length) rows.push(["Linked journals", j, { rel: true }]);
		} else if (linked.length) rows.push(["Linked", linked, { rel: true }]);
		const people = (nb.get("person") ?? []).map((x) => x.it);
		if (people.length) rows.push(["People", people, {}]);
		const peerList = [...peers.values()].sort(recent);
		if (!rows.length && !peerList.length) return null;
		const sec = cls(el("section", parent), "connections");
		el("h3", sec, "Connections");
		const chipsOf = (g: Node, list: J[], opt: { rel?: boolean; more?: string }, cap = 6) => {
			const chips = cls(el("div", g), "chips");
			for (const o of list.slice(0, cap)) {
				const r = opt.rel ? why.get(o.key) : "";
				const to = href(o, route), c = cls(el(to ? "a" : "span", chips), `chip-link t-${o.kind}-b${r ? " rel-chip" : ""}`);
				if (to) c.setAttribute("href", to);
				cls(el("i", c), `sw t-${o.kind}`);
				// A direct link: how it relates as a small label first, then the title on up to two lines, so neither is cut.
				if (r) { const body = cls(el("span", c), "chip-body"); cls(el("span", body, r), "chip-rel"); am.title(o, cls(el("span", body), "chip-title")); }
				else am.title(o, el("span", c));
			}
			if (list.length > cap) {
				const m = el(opt.more ? "a" : "span", chips, `+${list.length - cap} more`);
				cls(m, "more-link");
				if (opt.more) m.setAttribute("href", opt.more);
			}
		};
		for (const [label, list, opt] of rows) { const g = cls(el("div", sec), "conn-group"); cls(el("h4", g, label), "conn-head"); chipsOf(g, list, opt); }
		if (peerList.length) {
			const d = cls(el("details", sec), "conn-more"), more = projects[0] ? am.itemHref(projects[0], profileQ(route)) : "";
			cls(el("summary", d, `More in ${projects[0]?.wide ? "this workspace" : projects[0]?.title ?? "this project"} (${peerList.length})`), "conn-sum");
			for (const [k, label] of [["memory", "Memories"], ["learning", "Learnings"], ["journal", "Journals"]] as [string, string][]) {
				const list = peerList.filter((o: J) => o.kind === k);
				if (list.length) { const g = cls(el("div", d), "conn-group"); cls(el("h4", g, label), "conn-head"); chipsOf(g, list, { more }, 4); }
			}
		}
		return sec;
	};
	/**
	 * The other projects and people `it` is linked with: a real link (labelled with how) or the records they share. Strongest first.
	 * Only these are drawn as a graph, because only between distinct entities does an edge say something a list would not.
	 */
	const relations = (lib: J, it: J, route: Route | null) => {
		const mine = new Set<string>([...(lib.links.get(it.key)?.keys() ?? [])]), out: J[] = [];
		for (const o of lib.list.project as J[]) { // other projects only, while People is off the dashboard
			if (o.key === it.key || o.wide) continue;
			const rels = lib.links.get(it.key)?.get(o.key), kinds = new Map<string, number>();
			for (const k of lib.links.get(o.key)?.keys() ?? []) { const x = lib.items.get(k); if (mine.has(k) && x && x.kind !== "session" && x.kind !== "person" && k !== it.key && k !== o.key) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1); }
			const n = [...kinds.values()].reduce((a, b) => a + b, 0);
			if (!rels && !n) continue;
			const shared = n ? [...kinds].sort((a, b) => b[1] - a[1]).map(([k, c]) => count(c, k)).join(", ") + " in common" : "";
			out.push({ key: o.key, title: o.title, kind: o.kind, href: route ? href(o, route) : "", label: [rels ? [...rels].join(", ") : "", shared].filter(Boolean).join(" · "), weight: (rels ? 5 : 0) + n });
		}
		return out.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
	};
	/** A person's or project's page: counts, when work happened, latest journals, learnings and memories, then who and what it connects to. */
	const hubOf = (parent: Node, side: Node, lib: J, it: J, route: Route, compact = false) => {
		const nb = neighbours(lib, it.key), get = (k: string) => (nb.get(k) ?? []).map((x) => x.it);
		const stats = cls(el("p", parent), "hub-stats");
		for (const k of ["memory", "learning", "journal"]) { const n = get(k).length; if (n) cls(el("span", stats, count(n, k)), `stat-chip t-${k}-b`); }
		if (!stats.textContent) note(parent, "Nothing is linked to this yet.", "muted");
		const work = [...get("journal"), ...get("memory"), ...get("learning")];
		if (work.length) {
			// Day by day, the same stacked bars as Home, over the project's own span (4 to 12 weeks).
			const first = Math.min(...work.map((x) => Date.parse(x.created ?? x.updated ?? "") || Date.now())), span = Math.max(4, Math.min(12, Math.ceil((Date.now() - first) / (7 * 86_400_000)) + 1));
			el("h3", parent, "When work happened");
			am.daily(parent, [["journal", "journal"], ["memory", "memory"], ["learning", "learning"]].map(([k, label]) => ({ label: label!, kind: k!, dates: get(k!).map((x: J) => x.created ?? x.updated) })).filter((s) => s.dates.length), am.fitWeeks(parent, span), "When work happened");
		}
		const journals = get("journal").sort((a: J, b: J) => String(b.updated ?? b.created ?? "").localeCompare(String(a.updated ?? a.created ?? ""))); // newest first
		if (journals.length) {
			el("h3", parent, "Latest journals");
			const ul = cls(el("ul", parent), "rows compact");
			for (const j of journals.slice(0, 5)) row(ul, lib, j, route, null);
		}
		for (const [k, title] of [["learning", "Learnings"], ["memory", "Memories"]] as [string, string][]) {
			const list = get(k);
			if (!list.length) continue;
			el("h3", side, `${title} ${list.length}`);
			const grid = cls(el("div", side), "minicards");
			const draw = (from: number, to: number) => { for (const x of list.slice(from, to)) { const a = cls(el("a", grid), `minicard t-${x.kind}-b`); a.setAttribute("href", href(x, route)); am.title(x, el("strong", a)); const m = cls(el("span", a, typeOf(x)), "row-meta"); if (x.updated) { el("span", m, " · "); am.time(m, x.updated); } } };
			const first = compact ? 4 : 6;
			draw(0, first);
			if (list.length > first) { const b = cls(el("button", side, `Show all ${list.length}`), "linklike"); b.setAttribute("type", "button"); b.addEventListener("click", () => { (b as J).remove(); draw(first, list.length); }); }
		}
		const rel = relations(lib, it, route);
		if (rel.length) { el("h3", parent, "Connected to"); am.related(parent, { title: it.title, kind: it.kind }, rel, compact ? 6 : 8); }
	};

	// ---- Safe, minimal markdown: DOM nodes and textContent only, http(s) links only ----
	const inline = (parent: Node, text: string) => {
		const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
		let at = 0;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			if (m.index > at) el("span", parent, text.slice(at, m.index));
			const t = m[0];
			if (m[1]) { const c = el("code", parent, t.slice(1, -1)); c.setAttribute("title", t.slice(1, -1)); }
			else if (m[2]) el("strong", parent, t.slice(2, -2));
			else if (m[3]) el("em", parent, t.slice(1, -1));
			else {
				const url = m[5] ?? m[6]!, a = el("a", parent, m[4] ? t.slice(1, t.indexOf("](")) : url);
				a.setAttribute("href", url); a.setAttribute("rel", "noopener noreferrer"); a.setAttribute("target", "_blank"); a.setAttribute("title", url);
			}
			at = m.index + t.length;
		}
		if (at < text.length) el("span", parent, text.slice(at));
	};
	const md = (parent: Node, text: string): Node => {
		const box = cls(el("div", parent), "md"), lines = text.replace(/\r\n?/g, "\n").split("\n");
		let para: string[] = [], list: { tag: string; node: Node } | null = null;
		const flush = () => { if (para.length) { inline(el("p", box), para.join(" ")); para = []; } list = null; };
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i]!;
			if (/^\s*```/.test(l)) {
				flush();
				const code: string[] = [];
				for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
				el("code", el("pre", box), code.join("\n"));
				continue;
			}
			const hd = /^\s*(#{1,6})\s+(.*)$/.exec(l);
			if (hd) { flush(); inline(el(hd[1]!.length <= 2 ? "h4" : "h5", box), hd[2]!); continue; }
			if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
				flush();
				const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
				const tw = cls(el("div", box), "tablewrap"), table = el("table", tw), tr = el("tr", el("thead", table)), tb = el("tbody", table);
				for (const c of cells(l)) inline(el("th", tr), c);
				for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) { const r = el("tr", tb); for (const c of cells(lines[i]!)) inline(el("td", r), c); }
				i--;
				continue;
			}
			const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(l);
			if (li) {
				if (para.length) { inline(el("p", box), para.join(" ")); para = []; }
				const tag = li[1] ? "ul" : "ol";
				if (!list || list.tag !== tag) list = { tag, node: el(tag, box) };
				inline(el("li", list.node), li[3]!);
				continue;
			}
			if (/^\s*>\s?/.test(l)) { flush(); inline(el("blockquote", box), l.replace(/^\s*>\s?/, "")); continue; }
			if (!l.trim()) { flush(); continue; }
			if (list && /^\s{2,}\S/.test(l)) { inline(el("span", (list.node as J).lastChild), ` ${l.trim()}`); continue; }
			list = null;
			para.push(l.trim());
		}
		flush();
		return box;
	};
	/** Long text collapses to a few lines with "Show more". */
	const textOf = (parent: Node, text: string, lines = 14) => {
		const box = md(parent, text);
		if (text.length > lines * 70 || text.split("\n").length > lines) {
			box.setAttribute("class", `md clamped l${lines}`);
			const b = cls(el("button", parent, "Show more"), "linklike more");
			b.setAttribute("type", "button");
			b.addEventListener("click", () => { box.setAttribute("class", "md"); (b as J).remove(); });
		}
	};
	/** A journal entry as a card: its "## …" line becomes the title, "entry 5 —" noise goes, a label like "decision" becomes a tag. */
	/** An entry's own title: its leading "## …" line without the "entry 5 —" noise; "" when it has none or only a tag. */
	const entryTitle = (body: string) => {
		const hd = /^\s*#{1,6}\s+(.*)/.exec(body);
		const rest = hd ? hd[1]!.replace(/^\s*entry\s*#?\d+\s*(?:[—–:-]\s*)?/i, "").replace(/^\[[^\]]*\]\s*/, "").trim() : "";
		return rest.length > 24 || /\s.*\s/.test(rest) ? rest : rest ? cap(rest) : "";
	};
	const cap = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
	const entryCard = (parent: Node, e: J): Node => {
		const li = cls(el("li", parent), "entry");
		let body = String(e.body ?? "").replace(/^\s+/, ""), title = "", tag = "";
		const hd = /^#{1,6}\s+(.*)\n?/.exec(body);
		if (hd) {
			body = body.slice(hd[0].length);
			const rest = hd[1]!.replace(/^\s*entry\s*#?\d+\s*(?:[—–:-]\s*)?/i, "").replace(/^\[[^\]]*\]\s*/, "").trim();
			if (rest && rest.length <= 24 && !/\s.*\s/.test(rest)) tag = rest; else title = rest;
		}
		const head = cls(el("div", li), "entry-head");
		am.time(head, e.created_at);
		if (tag) cls(el("span", head, tag), "tag");
		if (title) cls(el("strong", li, title), "entry-title");
		textOf(li, body.trim() || "(empty entry)", 6);
		return li;
	};

	const detail = (box: Node, lib: J, it: J, route: Route) => {
		const version = am.pageVersion;
		box.replaceChildren();
		const head = cls(el("header", box), "detail-head");
		const closeTo = `#${route.tab}${profileQ(route) ? `?profile=${enc(profileQ(route)!)}` : ""}`;
		// On a phone the detail is a full-screen view: a clear way back to the list, which kept its place underneath.
		const back = cls(el("a", head, "← Back"), "back-btn");
		back.setAttribute("href", closeTo);
		cls(el("span", head, typeOf(it)), `kind t-${it.kind}-b`);
		const h = el("h2", head);
		am.title(it, h);
		h.setAttribute("tabindex", "-1");
		if (it.name && it.name !== it.title && it.kind !== "session") h.setAttribute("title", it.name);
		const meta = cls(el("p", head), "detail-meta");
		const src = cls(el("span", meta), "src");
		if (it.updated) { el("span", meta, "Updated "); am.time(meta, it.updated); }
		if (it.kind !== "project" && profileQ(route) === null) cls(el("span", meta, it.p), "pill");
		if (it.kind === "project") {
			cls(el("span", meta, it.wide ? `${am.workspaceName(it.workspace)} workspace` : (it.workspaces ?? [it.workspace]).map((w: string) => am.workspaceName(w)).join(", ")), "pill");
			if (!it.wide) {
				// The profile its GitHub owner gives, unless the workspace already says it (Personal, personal).
				if (!(it.workspaces ?? [it.workspace]).some((w: string) => w === it.p)) cls(el("span", meta, it.p), "pill");
			}
		}
		// Near the top: the project it belongs to, as a link (a journal's agent shows in the source line beside it).
		if (it.kind !== "project") for (const x of (neighbours(lib, it.key).get("project") ?? []).slice(0, 2)) {
			const to = href(x.it, route), c = cls(el(to ? "a" : "span", meta, x.it.wide ? `${am.workspaceName(x.it.workspace)} · general` : x.it.title), "pill proj");
			if (to) c.setAttribute("href", to);
		}
		if (it.url) { const gh = el("a", meta, "Open on GitHub ↗"); gh.setAttribute("title", it.name); gh.setAttribute("href", it.url); gh.setAttribute("target", "_blank"); gh.setAttribute("rel", "noopener noreferrer"); }
		if (it.filedUnder) {
			const n = it.filedCount ?? 1, h2 = el("a", meta, it.kind === "project" ? `${n} ${n === 1 ? "record is" : "records are"} in your ${it.filedUnder} profile` : `Stored in your ${it.filedUnder} profile`);
			h2.setAttribute("href", `#memories?profile=${enc(it.filedUnder)}`);
			cls(h2, "hint");
			h2.setAttribute("title", "Its GitHub owner says it belongs to the other profile. Nothing was moved.");
		}
		if (it.medium) cls(el("span", meta, "project likely"), "hint").setAttribute("title", "Placed in its project from a medium-confidence alias.");
		const close = cls(el("a", head, "Close"), "close");
		close.setAttribute("href", closeTo);
		close.setAttribute("data-close", "");
		// The last write on this page (Forgot, Pinned…) and its Undo, shown before and whatever the record read returns: a
		// forgotten record no longer reads, and its Undo must still be there.
		const status = it.kind === "memory" || it.kind === "learning" ? am.pageStatus(cls(el("div", box), "detail-status")) : null;
		// The body: a main column (the item's words, or a hub's timeline and journals) and a rail (its connections, actions, an
		// outline). Side by side when the pane is wide enough (a container query), stacked otherwise.
		const hub = it.kind === "person" || it.kind === "project";
		const grid = cls(el("div", box), hub ? "dgrid hub" : it.kind === "journal" && (Number(win.innerWidth) || 1440) >= 1280 ? "dgrid journal" : "dgrid"), body = cls(el("div", grid), "dmain"), after = cls(el("aside", grid), "drail");
		// A journal's connections lead its reading column; a memory's or learning's sit in the rail.
		const connSec = hub ? null : connections(it.kind === "journal" ? body : after, lib, it, route);
		let none: Node | null = !connSec && it.kind === "journal" && !it.virtual ? cls(el("p", body, "Not linked to a project or to any memory yet."), "muted conn-none") : null;
		const text = el("div", body);
		// Links can arrive after the record (edges load after nodes): only the Connections block is redrawn then, in place, so
		// the text, the scroll position and any open edit stay as they are. The From group, once read, moves to the new block.
		let connNode: Node | null = connSec, fromG: Node | null = null;
		if (!hub) (box as J).__refreshConn = (lib2: J) => {
			if (version !== am.pageVersion) return;
			const parent = it.kind === "journal" ? body : after, fresh = connections(parent, lib2, it, route) ?? (fromG ? (() => { const s = cls(el("section", parent), "connections"); el("h3", s, "Connections"); return s; })() : null);
			if (!fresh) return;
			if (fromG) { const hd = (fresh as J).querySelector?.("h3"); if (hd?.nextSibling && (fresh as J).insertBefore) (fresh as J).insertBefore(fromG, hd.nextSibling); else fresh.appendChild(fromG); }
			const anchor = connNode ?? none ?? (it.kind === "journal" ? text : (after as J).firstChild);
			if (anchor) (parent as J).insertBefore?.(fresh, anchor);
			(connNode as J)?.remove?.();
			(none as J)?.remove?.();
			connNode = fresh;
			none = null;
		};
		if (hub) hubOf(body, after, lib, it, route, route.tab === "map");
		if (it.virtual) return h;
		// The item's own words: a node read for memories, learnings, people and projects; a journal read for journals.
		const load = am.loading(text, 3);
		const base = `/api/profiles/${enc(it.p)}`;
		void (async () => {
			try {
				if (it.kind === "journal") {
					// The entries come oldest first, 25 a page: read to the end so the newest are always there, then show newest first.
					// shortcut: reads up to 400 pages (10,000 entries) and says so beyond; upgrade to a newest-first read if journals grow past it.
					let r: J = await call(`${base}/journals?id=${enc(it.id)}&limit=25`);
					const entries: J[] = Array.isArray(r?.entries) ? [...r.entries] : [], summary = r?.summary?.body, journal = r?.journal ?? {}, summaryCut = r?.summary?.complete === false;
					let pages = 1;
					for (; typeof r?.next_after === "number" && pages < JOURNAL_PAGES; pages++) {
						r = await call(`${base}/journals?id=${enc(it.id)}&limit=25&entries_after=${r.next_after}`);
						if (version !== am.pageVersion) return;
						if (Array.isArray(r?.entries)) entries.push(...r.entries);
					}
					if (version !== am.pageVersion) return;
					load.replaceChildren();
					if (typeof r?.next_after === "number") note(text, `Showing the first ${entries.length.toLocaleString()} entries; this journal has more than the page reads.`, "warn");
					if (journal.status === "active") moveLinks(after, it);
					// The journal read gives each long entry or summary only its first part; the record read pages the whole text.
					if (summaryCut || entries.some((e) => e.complete === false)) {
						const wrap = el("div", text);
						note(wrap, "Some long parts of this journal show only their beginning (marked …).", "muted");
						const more = cls(el("button", wrap, "Read the whole journal"), "linklike more");
						more.setAttribute("type", "button");
						more.addEventListener("click", async () => {
							more.disabled = true;
							try { const all = await wholeText(`${base}/nodes/${enc(it.id)}`); if (version !== am.pageVersion) return; wrap.replaceChildren(); el("h3", wrap, "Whole journal"); textOf(wrap, all); }
							catch (err) { more.disabled = false; note(wrap, `Could not read the rest: ${why(err)}`, "warn"); }
						});
					}
					if (summary) { el("h3", text, "Summary"); textOf(text, String(summary) + (summaryCut ? "…" : ""), 8); }
					if (entries.length) {
						el("h3", text, `Entries ${entries.length}`);
						const ol = cls(el("ol", text), "entries"), cards: Node[] = [];
						entries.reverse();
						// The latest ten, then ten more each time the end of the list scrolls into view; the outline renders up to
						// an entry before jumping to it. A long journal never builds one giant page.
						let shown = 0;
						const upto = (m: number) => { for (const end = Math.min(entries.length, m); shown < end; shown++) cards[shown] = entryCard(ol, entries[shown]!.complete === false ? { ...entries[shown], body: `${entries[shown]!.body ?? ""}…` } : entries[shown]!); };
						upto(10);
						if (shown < entries.length) {
							const row = cls(el("div", text), "sentinel");
							el("span", row, `${entries.length - shown} earlier entries`);
							const step = () => { upto(shown + 10); if (shown >= entries.length) (row as J).remove?.(); else ((row as J).firstChild as J).textContent = `${entries.length - shown} earlier entries`; };
							// Stopped when the page is left (am.observe), or once every entry is shown.
							if (!am.observe(row, (stop) => { step(); if (shown >= entries.length) stop(); }, "500px 0px")) { const b = el("button", row, "Show earlier"); b.setAttribute("type", "button"); b.addEventListener("click", step); }
						}
						const ensure = (i: number) => { if (i >= shown) upto(i + 1); };
						// The outline: every entry by time and a few words of its own, grouped by day; a click scrolls to it. A side rail
						// from 1280px; above the entries, folded, on narrower screens.
						const wide = (Number(win.innerWidth) || 1440) >= 1280;
						const out = cls(el("details", wide ? after : body), "outline");
						if (wide) out.setAttribute("open", "");
						else (body as J).insertBefore?.(out, text);
						cls(el("summary", out, `Outline · ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`), "outline-sum");
						const ul = el("ol", out);
						const words = (b: string) => { const w = b.replace(/^\s*#+\s*/, "").replace(/^\s*entry\s*#?\d+\s*(?:[—–:-]\s*)?/i, "").replace(/[*_`>#[\]]/g, "").split(/\s+/).filter(Boolean); return w.slice(0, 6).join(" ") + (w.length > 6 ? "…" : ""); };
						let day = "";
						entries.forEach((e, i) => {
							const d = am.when(e.created_at).text.replace(/ \d{2}:\d{2}$/, "");
							if (d !== day) { day = d; cls(el("li", ul, d || "Undated"), "outline-day"); }
							const b = cls(el("button", el("li", ul)), "linklike");
							b.setAttribute("type", "button");
							const body = String(e.body ?? "");
							el("span", b, entryTitle(body) || words(body) || `Entry ${entries.length - i}`);
							b.addEventListener("click", () => { ensure(i); (cards[i] as J).scrollIntoView?.({ block: "start", behavior: "smooth" }); });
						});
					} else note(text, "No entries yet.", "muted");
					src.textContent = it.agent ? `Written by ${it.agent}` : "";
					return;
				}
				const r: J = await call(`${base}/nodes/${enc(it.id)}`);
				if (version !== am.pageVersion) return;
				load.replaceChildren();
				const n = r?.node ?? {}, c = r?.content ?? {}, ev: J[] = Array.isArray(r?.evidence?.items) ? r.evidence.items : [];
				am.settleTitle(it, String(n.description || c.text || "")); // the same words the title reader would use
				src.textContent = sources(lib, it, ev);
				const got = fromRow(after, connNode, lib, it, r);
				if (got) { connNode = got.box; fromG = got.g; }
				if (src.textContent) el("span", meta, "");
				if (n.description && n.description !== c.text) cls(el("p", text, String(n.description)), "lede");
				const cut: string[] = Array.isArray(n.truncated) ? n.truncated.map(String) : [];
				if (cut.includes("description")) note(text, "The description is longer than this page shows.", "muted");
				// Long text arrives as a prefix; the rest reads on request, in the server's pages, so it can be read in full.
				const words = el("div", text), full = { text: typeof c.text === "string" ? c.text : "", complete: c.complete !== false };
				const show = () => { words.replaceChildren(); if (full.text) textOf(words, full.text + (full.complete ? "" : "…")); else if (!hub && !n.description) note(words, "No text.", "muted"); };
				show();
				const loadAll = async () => { if (!full.complete) { full.text = await wholeText(`${base}/nodes/${enc(it.id)}`); full.complete = true; if (version === am.pageVersion) show(); } return full.text; };
				if (!full.complete) {
					const more = cls(el("button", text, `Read all ${Number(c.chars) ? `${Number(c.chars).toLocaleString()} characters` : "of it"}`), "linklike more");
					more.setAttribute("type", "button");
					more.addEventListener("click", async () => { more.disabled = true; try { await loadAll(); (more as J).remove(); } catch (err) { more.disabled = false; status?.say(`Could not read the rest: ${why(err)}`); } });
				}
				if (it.kind === "memory" || it.kind === "learning") actions(after, it, n, cut, loadAll, status!.say);
				if (n.status === "active") moveLinks(after, it);
			} catch (err) {
				if (version !== am.pageVersion) return;
				load.replaceChildren();
				note(text, (err as Failure).status === 404 ? "This record is no longer here: it was forgotten, moved or wiped." : `Could not load this: ${why(err)}`, (err as Failure).status === 404 ? "muted" : "warn");
			}
		})();
		return h;
	};
	/** Reads a record's whole content through the server's pages (`content=all` with its cursor). */
	const wholeText = async (path: string) => {
		let text = "", cursor: string | null = null;
		for (let i = 0; i < 200; i++) {
			const page: J = await call(`${path}?content=all${cursor ? `&cursor=${enc(cursor)}` : ""}`);
			text += String(page?.content?.content ?? "");
			cursor = typeof page?.content?.cursor === "string" ? page.content.cursor : null;
			if (!cursor) return text;
		}
		throw new Error("the text has more parts than this page reads");
	};
	/** Move or copy the record to another profile (the owner's Moves pages). */
	const moveLinks = (parent: Node, it: J) => {
		const p = cls(el("p", parent), "detail-links");
		for (const [path, label] of [["move", "Move to another profile"], ["copy", "Save a copy in another profile"]]) {
			const a = el("a", p, label);
			a.setAttribute("href", `#/${path}/${enc(it.p)}/${enc(it.id)}`);
		}
	};
	/**
	 * The few things an owner does to one memory or learning: pin it, edit it, or forget it (with Undo). Edit always carries the
	 * whole text (read in full first when only a prefix is shown), is refused while a draft for that profile is unsaved, and is
	 * off when the server cut the name or description short, so a save can never write back a truncated record.
	 */
	const actions = (parent: Node, it: J, n: J, cut: string[], loadAll: () => Promise<string>, say: (t: string) => void) => {
		const row = cls(el("div", parent), "detail-actions");
		const base = `/api/profiles/${enc(it.p)}/nodes/${enc(it.id)}`;
		const done = (verb: string) => (r: J) => ({ text: `${verb} “${it.title}”.`, undo: am.undoOf(it.p, r) });
		am.btn(row, n.pinned ? "Unpin" : "Pin", () => am.act(`${base}/${n.pinned ? "unpin" : "pin"}`, n.pinned ? "unpin it" : "pin it", undefined, done(n.pinned ? "Unpinned" : "Pinned")));
		const editable = n.memory_type && n.memory_type !== "procedural" && n.status === "active";
		let draftLink = false;
		if (editable && (cut.includes("description") || cut.includes("name"))) note(parent, "Editing is off here: the server sent this record's description cut short, and saving would shorten it.", "muted");
		else if (editable) {
			const edit = am.btn(row, "Edit", async () => {
				if (am.drafts.has(it.p)) {
					say(`There is an unsaved draft in ${it.p}; save or discard it in Write first.`);
					if (!draftLink) { draftLink = true; const a = el("a", row, "Open the draft"); a.setAttribute("href", `#/draft/${enc(it.p)}`); }
					return;
				}
				edit.disabled = true;
				let content: string;
				try { content = await loadAll(); } catch (err) { edit.disabled = false; say(`Could not read the whole text to edit it: ${why(err)}`); return; }
				if (am.drafts.has(it.p)) { edit.disabled = false; say(`There is an unsaved draft in ${it.p}; save or discard it in Write first.`); return; }
				am.drafts.set(it.p, { memory_id: it.id, expected_revision: Number(n.revision), name: String(n.name), recordName: String(n.name), type: String(n.memory_type), scope: n.scope ? String(n.scope) : "",
					description: String(n.description ?? ""), content, target: "", targetName: "", reason: "" });
				am.win.location.hash = `#/draft/${enc(it.p)}`;
			});
		}
		const forget = am.btn(row, "Forget…", () => {
			forget.hidden = true;
			const ask = el("span", row, " Move it to the archive? You can undo this. ");
			am.btn(row, "Forget", () => am.act(async () => {
				try { return await call(`${base}/forget`, "POST"); }
				catch (err) {
					if ((err as Failure).code !== "size_budget" || !Number.isSafeInteger(Number(n.revision))) throw err;
					// Too large for one write: the staged archive route forgets it in steps, bound to the revision shown.
					const pb = `/api/profiles/${enc(it.p)}/archive/operations`;
					let r: J = await call(pb, "POST", { action: "forget", memory_id: it.id, expected_revision: Number(n.revision), request_id: `dashboard:${crypto.randomUUID()}` });
					for (let i = 0; (r.state === "running" || r.state === "rolling_back") && i < 200; i++)
						r = await call(`${pb}/${enc(String(r.operation_id))}/resume`, "POST", { cursor: String(r.cursor), request_id: `dashboard:${crypto.randomUUID()}` });
					if (r.state !== "complete") throw new Error(`the staged forget stopped while ${String(r.state)} after ${String(r.rows_done ?? 0)} rows; try again to continue`);
					return { staged: true };
				}
			}, "forget it", undefined, (r) => r?.staged ? { text: `Forgot “${it.title}” in steps; Change history can restore it.` } : done("Forgot")(r)));
			ask.setAttribute("tabindex", "-1");
			ask.focus();
		});
	};

	// ---- A section: facets, a filter, the list, and the selected item's detail ----
	const section = (kind: string, title: string, facetOf?: (it: J) => string) => (root: Node, route: Route): Node => {
		const version = am.pageVersion, only = profileQ(route);
		let selected = route.rest.length >= 2 ? `${route.rest[0]}/${route.rest.slice(1).join("/")}` : null;
		// An older address with the record alone and no profile (#memories/ID): found by its id once the library has it.
		const lone = route.rest.length === 1 ? route.rest[0]! : null;
		// Three regions: the section's title, filter and breakdown (a sidebar on wide screens), the list, and the detail pane.
		const page = cls(el("div", root), selected ? "lib open" : "lib");
		const sideCol = cls(el("section", page), "lib-side"), listCol = cls(el("section", page), "lib-list"), detailCol = cls(el("section", page), "lib-detail");
		listCol.setAttribute("aria-label", title);
		const head = cls(el("div", sideCol), "list-head");
		const h = el("h2", head, title);
		const total = cls(el("span", head), "count");
		const facetBox = el("div", sideCol);
		const q = el("input", sideCol);
		q.setAttribute("type", "search");
		q.setAttribute("placeholder", `Filter ${title.toLowerCase()}`);
		q.setAttribute("aria-label", `Filter ${title.toLowerCase()}`);
		q.setAttribute("class", "filter");
		q.setAttribute("data-search", "");
		const ul = cls(el("ul", listCol), "rows");
		ul.setAttribute("data-list", "");
		const pages = el("div", listCol), status = cls(el("p", listCol), "muted");
		let facet = route.query.type ?? "", shownDetail = "", shownLinks = "", detailH: Node | null = null;
		const paint = () => {
			if (version !== am.pageVersion) return;
			const lib: J = am.library(only, paint);
			// Projects list only those with something in memory unless every known repo is asked for.
			const all: J[] = lib.list[kind] ?? [];
			total.textContent = all.length ? all.length.toLocaleString() : "";
			if (facetOf) {
				const counts = new Map<string, number>();
				for (const it of all) counts.set(facetOf(it), (counts.get(facetOf(it)) ?? 0) + 1);
				facetBox.replaceChildren();
				const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, value]) => ({ id, label: id, value, kind: subOf(id) }));
				if (rows.length > 1) am.facets(facetBox, rows, facet, (id) => { facet = id; paint(); });
			}
			const needle = String(q.value ?? "").trim().toLowerCase();
			const unsorted = route.query.unsorted === "1"; // the Projects page's "N unsorted": records with no project
			const shown = all.filter((it) => (!facet || facetOf?.(it) === facet) && (!unsorted || !neighbours(lib, it.key).get("project")?.length)
				&& (!needle || `${it.title} ${it.name} ${it.scope ?? ""}`.toLowerCase().includes(needle)));
			ul.replaceChildren();
			am.pager(pages, shown, (it) => row(ul, lib, it, route, selected), 40, `${kind}|${only}|${facet}|${needle}`);
			status.textContent = lib.loading && !all.length ? "Loading…" : lib.missing ? "This server cannot list records yet." : lib.errors.length ? `Could not read ${lib.errors.join("; ")}.`
				: !all.length ? `No ${title.toLowerCase()} yet.` : !shown.length ? "Nothing matches." : lib.loading ? "Still loading…" : "";
			if (!all.length && lib.loading) am.loading(ul, 6);
			if (!selected && all.length) {
				// Nothing open: the pane shows what was added here, day by day, instead of standing empty.
				detailCol.replaceChildren();
				cls(el("p", detailCol, `Choose one of your ${title.toLowerCase()} to read it and see what it connects to.`), "placeholder");
				const wk = am.fitWeeks(detailCol, 12);
				el("h3", detailCol, `${title} added per day, last ${wk} weeks`);
				// Stacked by sub-type, in the same colours as the chips above the list.
				const tally = new Map<string, number>();
				for (const x of all) tally.set(facetName(x), (tally.get(facetName(x)) ?? 0) + 1);
				const names = [...tally].sort((a, b) => b[1] - a[1]).map(([n]) => n); // the chips' order
				const series = names.length > 1 && facetOf ? names.map((n) => ({ label: n, kind: subOf(n), dates: all.filter((x) => facetName(x) === n).map((x) => x.created ?? x.updated) }))
					: [{ label: NAMES[kind]![0]!, kind, dates: all.map((x) => x.created ?? x.updated) }];
				am.daily(detailCol, series, wk, `${title} added per day`);
				// And the ones most woven into the rest: a good place to start reading.
				const linksOf = (it: J) => [...(lib.links.get(it.key)?.keys() ?? [])].filter((k) => { const o = lib.items.get(k); return o && o.kind !== "session" && o.kind !== "project"; }).length;
				// One row per title: the same note filed in two workspaces is one row naming both. Each says what it connects to.
				const ranked = all.map((it) => [it, linksOf(it)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
				const byTitle = new Map<string, { it: J; also: string[] }>();
				const placeOf2 = (it: J) => { const p = neighbours(lib, it.key).get("project")?.[0]?.it; return p ? (p.wide ? `${am.workspaceName(p.workspace)}, workspace-wide` : p.title) : ""; };
				for (const [it] of ranked) {
					const k = am.title(it).trim().toLowerCase(), seen = byTitle.get(k);
					if (!seen) { if (byTitle.size < 6) byTitle.set(k, { it, also: [] }); continue; }
					const p = placeOf2(it);
					if (p && p !== placeOf2(seen.it) && !seen.also.includes(p)) seen.also.push(p);
				}
				if (byTitle.size) {
					const sec = cls(el("section", detailCol), "pane-hubs");
					sec.setAttribute("aria-label", "Most connected");
					el("h3", sec, "Most connected");
					const ul2 = cls(el("ul", sec), "rows compact");
					for (const { it, also } of byTitle.values()) {
						const nb = neighbours(lib, it.key), links = ["memory", "learning", "journal"].map((k) => [k, nb.get(k)?.length ?? 0] as const).filter(([, n]) => n).map(([k, n]) => count(n, k));
						row(ul2, lib, it, route, null, [...(also.length ? [`also ${also.join(", ")}`] : []), ...(links.length ? [`linked to ${links.join(", ")}`] : [])]);
					}
				}
			}
			if (lone && !selected) {
				const hit = (all as J[]).find((x) => x.id === lone);
				if (hit) {
					selected = hit.key;
					page.setAttribute("class", "lib open");
					try { win.history?.replaceState?.(null, "", href(hit, route)); } catch { /* the page still shows it */ }
				} else if (!lib.loading) { detailCol.replaceChildren(); note(detailCol, "No record with that address in the chosen profile.", "muted"); }
			}
			if (selected) {
				// A hub (project or person) draws again while its connections are still arriving; any other item draws once.
				const it = lib.items.get(selected), hub = it && (it.kind === "project" || it.kind === "person");
				// Anything else draws again when its record changes (an edit, a new journal entry), so an open pane never goes stale.
				const sig = it ? `${it.key}:${hub ? lib.links.get(it.key)?.size ?? 0 : it.updated ?? ""}` : "";
				// Each neighbour with its relations, so a new relation to a known neighbour (supersedes after relates to) counts too.
				const links = it ? [...(lib.links.get(it.key) ?? new Map()) as Map<string, Set<string>>].map(([k, rels]) => `${k}:${[...rels].sort().join("+")}`).sort().join("|") : "";
				if (it && sig !== shownDetail) { shownDetail = sig; shownLinks = links; detailH = detail(detailCol, lib, it, route); }
				else if (it && !hub && links !== shownLinks) { shownLinks = links; (detailCol as J).__refreshConn?.(lib); } // links arrived after the record
				else if (!it && !lib.loading && shownDetail !== "missing") { shownDetail = "missing"; detailCol.replaceChildren(); note(detailCol, "This item is not in the chosen profile.", "muted"); am.pageStatus(detailCol); }
			}
		};
		q.addEventListener("input", paint);
		if (!selected) cls(el("p", detailCol, `Choose one of your ${title.toLowerCase()} to read it and see what it connects to.`), "placeholder");
		paint();
		return detailH ?? h; // with an item open, focus its title (inside the pane), so the list keeps its place
	};

	// ---- Projects: workspaces as groups, each a grid of project cards ----
	/** Twelve weekly bars of what was added to a project, for a card. */
	const spark = (parent: Node, dates: (string | null)[]) => {
		const s = cls(el("span", parent), "pspark"), W = 7 * 86_400_000, now = Date.now(), bins = new Array(12).fill(0) as number[];
		for (const d of dates) { const w = Math.floor((now - Date.parse(d ?? "")) / W); if (w >= 0 && w < 12) bins[11 - w]!++; }
		// Every card keeps the same row; with nothing in the window it is one quiet line, not a row of dashes.
		const n = bins.reduce((a, b) => a + b, 0);
		s.setAttribute("title", n ? `${n} added in the last 12 weeks` : "Nothing added in the last 12 weeks");
		if (!n) { s.setAttribute("class", "pspark flat"); return; }
		const max = Math.max(1, ...bins);
		for (const b of bins) cls(el("i", s), b ? "" : "zero").setAttribute("style", `height:${Math.max(8, Math.round((b / max) * 100))}%`);
	};
	const projects = (root: Node, route: Route): Node => {
		const version = am.pageVersion, only = profileQ(route), q = only ? `?profile=${enc(only)}` : "";
		const selected = route.rest.length >= 2 ? `${route.rest[0]}/${route.rest.slice(1).join("/")}` : null;
		if (selected) {
			// One project's page, full width, with the way back to the grid.
			const back = el("a", root, "← All projects");
			back.setAttribute("href", `#projects${q}`);
			back.setAttribute("class", "back");
			const box = cls(el("section", root), "lib-detail page");
			let sig = "";
			const paint = () => {
				if (version !== am.pageVersion) return;
				const lib: J = am.library(only, paint), it = lib.items.get(selected);
				const next = it ? `${lib.links.get(it.key)?.size ?? 0}` : lib.loading ? "" : "missing";
				if (next === sig) return;
				sig = next;
				if (it) detail(box, lib, it, route); else if (!lib.loading) { box.replaceChildren(); note(box, "This project has no memories in the chosen profile.", "muted"); } else {
					// Loading: a skeleton, and after a while a way to try again instead of waiting on a stalled read.
					box.replaceChildren(); am.loading(box, 5);
					win.setTimeout?.(() => {
						if (version !== am.pageVersion || sig !== "") return;
						const r = el("p", box, "Still loading. ");
						cls(r, "muted");
						const b = el("button", r, "Retry");
						b.setAttribute("type", "button");
						b.addEventListener("click", () => am.render(false));
					}, 12_000);
				}
			};
			paint();
			const h = (box as J).querySelector?.("h2");
			return h ?? back;
		}
		const head = cls(el("div", root), "list-head");
		const h = el("h2", head, "Projects");
		const total = cls(el("span", head), "count");
		const facetBox = el("div", root), out = el("div", root), foot = cls(el("p", root), "muted");
		let ws = route.query.type ?? "";
		const paint = () => {
			if (version !== am.pageVersion) return;
			const lib: J = am.library(only, paint), deg = (it: J) => lib.links.get(it.key)?.size ?? 0;
			const real = (lib.list.project as J[]).filter((it) => !it.wide && deg(it) > 0);
			const wideOf = (w: string) => lib.items.get(`${am.workspaceProfile(w)}/ws:${w}`);
			const groups = am.workspaceOrder.map((w) => ({ w, list: real.filter((it) => (it.workspaces ?? [it.workspace]).includes(w)).sort((a, b) => deg(b) - deg(a)), wide: wideOf(w) }))
				.filter((g) => g.list.length || (g.wide && deg(g.wide)));
			// The header counts each project once; a repo checked out in two workspaces shows in both groups, marked "also in".
			total.textContent = real.length ? `${real.length} unique` : "";
			total.setAttribute("title", "Each project counted once. A project checked out in two workspaces appears in both groups.");
			facetBox.replaceChildren();
			if (groups.length > 1) am.facets(facetBox, groups.map((g) => ({ id: g.w, label: am.workspaceName(g.w), value: g.list.length, kind: subOf(g.w) })), ws, (id) => { ws = id; paint(); }, real.length);
			out.replaceChildren();
			for (const g of groups) {
				if (ws && g.w !== ws) continue;
				const sec = cls(el("section", out), "ws-sec"), hd = cls(el("div", sec), "ws-title");
				el("h3", hd, am.workspaceName(g.w));
				cls(el("span", hd, count(g.list.length, "project")), "muted");
				const wd = g.wide ? deg(g.wide) : 0;
				if (wd && g.wide) {
					// The same words and numbers as the Map's "<Workspace> · workspace-wide" block.
					const nb = neighbours(lib, g.wide.key), parts = ["memory", "learning", "journal"].map((k) => [k, nb.get(k)?.length ?? 0] as const).filter(([, n]) => n).map(([k, n]) => count(n, k));
					const a = el("a", hd, `Workspace-wide: ${parts.join(" · ")}`);
					a.setAttribute("href", href(g.wide, route));
					a.setAttribute("title", "Records that name this workspace but no project");
				}
				const grid = cls(el("div", sec), "pgrid");
				for (const it of g.list) {
					const nb = neighbours(lib, it.key), get = (k: string) => (nb.get(k) ?? []).map((x) => x.it);
					const card = cls(el("a", grid), "pcard");
					card.setAttribute("href", href(it, route));
					card.setAttribute("title", `${it.name}${it.alias ? ` (${it.alias})` : ""}`);
					const top = cls(el("span", card), "pc-top");
					cls(el("strong", top, it.title), "pc-name");
					cls(el("span", top, it.p === "work" ? "Work" : "Personal"), `pill tag-${it.p}`).setAttribute("title", `Profile: ${it.p}`);
					const others = (it.workspaces ?? []).filter((w: string) => w !== g.w);
					if (others.length) cls(el("span", card, `Also in ${others.map((w: string) => am.workspaceName(w)).join(", ")}`), "pc-also");
					spark(card, [...get("memory"), ...get("learning"), ...get("journal")].map((x) => x.created ?? x.updated));
					cls(el("span", card, ["memory", "learning", "journal"].map((k) => [k, get(k).length] as const).filter(([, n]) => n).map(([k, n]) => count(n, k)).join(" · ")), "pc-counts");
					const last = cls(el("span", card), "pc-last");
					if (it.updated) { el("span", last, "Active "); am.time(last, it.updated); }
					if (it.filedUnder) {
						const n = it.filedCount ?? 1, i = cls(el("span", last, "⇄"), "hint-icon");
						i.setAttribute("title", `${n} of its ${n === 1 ? "records is" : "records are"} stored in your ${it.filedUnder} profile. Nothing was moved.`);
						i.setAttribute("aria-label", `${n} stored in your ${it.filedUnder} profile`);
					}
				}
				if (!g.list.length) note(sec, "No projects yet; only general notes.", "muted");
			}
			foot.replaceChildren();
			if (lib.loading && !real.length) foot.textContent = "Loading…";
			else if (!groups.length) foot.textContent = "No projects yet.";
			else if (lib.unsorted) { const a = el("a", foot, `${lib.unsorted.toLocaleString()} notes not tied to a project`); a.setAttribute("href", `#memories?unsorted=1${only ? `&profile=${enc(only)}` : ""}`); }
		};
		paint();
		return h;
	};

	// ---- Home ----
	const home = (root: Node, route: Route): Node => {
		const version = am.pageVersion, only = profileQ(route);
		const h = el("h2", root, "Home");
		h.setAttribute("class", "vh");
		const top = cls(el("p", root), "home-sum");
		const charts = cls(el("div", root), "home-charts"), lists = cls(el("div", root), "home-lists");
		const card = (parent: Node, title: string, more?: string) => {
			const c = cls(el("section", parent), "card");
			const hd = cls(el("div", c), "card-head");
			el("h3", hd, title);
			if (more) { const a = el("a", hd, "All"); a.setAttribute("href", more); }
			return c;
		};
		const q = only ? `?profile=${enc(only)}` : "";
		const paint = () => {
			if (version !== am.pageVersion) return;
			const lib: J = am.library(only, paint), L = lib.list;
			const nm = L.memory.length, nl = L.learning.length, nj = L.journal.length, np = L.project.filter((x: J) => !x.wide && (lib.links.get(x.key)?.size ?? 0) > 0).length;
			top.textContent = lib.loading && !nm ? "Loading your agents' memory…" : `Your agents remember ${count(nm, "memory")} and ${count(nl, "learning")}, with ${count(nj, "journal")} of work across ${count(np, "project")}.`;
			charts.replaceChildren(); lists.replaceChildren();
			const wk = am.fitWeeks(charts, 12); // 84 day bars, or the last 4 weeks where bars would be under 2 px
			const c1 = card(charts, `Added per day, last ${wk} weeks`);
			am.daily(c1, [{ label: "memory", kind: "memory", dates: L.memory.map((x: J) => x.created) }, { label: "learning", kind: "learning", dates: L.learning.map((x: J) => x.created) },
				{ label: "journal", kind: "journal", dates: L.journal.map((x: J) => x.created) }], wk, "Added per day");
			const deg = (it: J) => lib.links.get(it.key)?.size ?? 0;
			const c2 = card(charts, "Most active projects", `#projects${q}`);
			cls(el("p", c2, "By memories, learnings and journals linked to each"), "chart-note");
			const projects = [...L.project].filter((x: J) => !x.wide && deg(x) > 0).sort((a: J, b: J) => deg(b) - deg(a)).slice(0, 7); // real projects only
			if (projects.length) am.bars(c2, projects.map((x: J) => ({ label: x.title, value: deg(x), href: href(x, route), sub: metaOf(lib, x, false).join(" · ") })), "connection");
			else note(c2, lib.loading ? "Loading…" : "No projects yet.", "muted");
			for (const [kind, title, path, n] of [["memory", "Recent memories", "memories", 8], ["learning", "New learnings", "learnings", 6], ["journal", "Latest journals", "journals", 6]] as [string, string, string, number][]) {
				const c = card(lists, title, `#${path}${q}`), ul = cls(el("ul", c), "rows compact");
				for (const it of L[kind].slice(0, n)) row(ul, lib, it, route, null);
				if (!L[kind].length) note(c, lib.loading ? "Loading…" : `No ${title.toLowerCase().replace(/^(recent|new|latest) /, "")} yet.`, "muted");
			}
		};
		paint();
		return h;
	};

	// ---- Search: titles across every section, then memories whose text mentions it ----
	const search = (root: Node, route: Route): Node => {
		const version = am.pageVersion, only = profileQ(route), needle = String(route.query.q ?? "").trim();
		const h = el("h2", root, needle ? `Results for “${needle}”` : "Search");
		const out = cls(el("div", root), "search-out"), deep = el("div", root);
		const paint = () => {
			if (version !== am.pageVersion) return;
			const lib: J = am.library(only, paint), lower = needle.toLowerCase();
			out.replaceChildren();
			if (!needle) { note(out, "Type in the search box above.", "muted"); return; }
			let any = false;
			for (const kind of ["project", "journal", "learning", "memory"]) {
				const hits = (lib.list[kind] as J[]).filter((it) => (kind !== "project" || (!it.wide && (lib.links.get(it.key)?.size ?? 0) > 0)) && `${it.title} ${it.name} ${it.alias ?? ""} ${it.scope ?? ""}`.toLowerCase().includes(lower));
				if (!hits.length) continue;
				any = true;
				const c = cls(el("section", out), "card"), ul = cls(el("ul", c), "rows compact");
				el("h3", c, `${NAMES[kind]![1]} ${hits.length}`);
				c.appendChild(ul);
				// A short preview per type; "See all" opens the rest in place (then scrolls on demand).
				for (const it of hits.slice(0, 5)) row(ul, lib, it, route, null);
				if (hits.length > 5) {
					const more = cls(el("button", c, `See all ${hits.length}`), "linklike more");
					more.setAttribute("type", "button");
					more.addEventListener("click", () => { (more as J).remove(); am.pager(el("div", c), hits.slice(5), (it) => row(ul, lib, it, route, null), 20, `search|${kind}|${only}|${lower}`); });
				}
			}
			if (!any) note(out, lib.loading ? "Searching…" : "No titles match.", "muted");
			paintDeep();
		};
		// Body matches from recall, kept and resolved against the library each time it changes: a search opened before the
		// library has loaded still shows them once it has.
		const recalled: { profile: string; id: string; passage: string }[] = [];
		const paintDeep = () => {
			if (version !== am.pageVersion || !recalled.length) return;
			const lib: J = am.library(only), hits = recalled.map((r) => ({ it: lib.items.get(`${r.profile}/${r.id}`), passage: r.passage })).filter((x) => x.it);
			deep.replaceChildren();
			if (!hits.length) { if (lib.loading) note(deep, "Matching memory text is ready; titles are still loading…", "muted"); return; }
			const c = cls(el("section", deep), "card");
			el("h3", c, "Mentioned in");
			const ul = cls(el("ul", c), "rows compact");
			// Each with a short excerpt around the first match, the match marked (text nodes only).
			const excerpt = (parent: Node, passage: string) => {
				const flat = passage.replace(/\s+/g, " "), at = flat.toLowerCase().indexOf(needle.toLowerCase()), from = Math.max(0, at - 70), cut = flat.slice(from, from + 170);
				if (at < 0) return; // a passage without the words adds nothing under its title
				const p = cls(el("p", parent), "row-meta excerpt");
				if (from) el("span", p, "…");
				const i = at - from;
				el("span", p, cut.slice(0, i)); el("mark", p, cut.slice(i, i + needle.length)); el("span", p, cut.slice(i + needle.length));
				if (from + 170 < flat.length) el("span", p, "…");
			};
			for (const { it, passage } of hits) { row(ul, lib, it, route, null); if (passage) excerpt((ul as J).lastChild, passage); }
		};
		paint();
		if (needle) void (async () => {
			const got = await am.eachProfile(only, (p) => call(`/api/profiles/${enc(p.name)}/recall`, "POST", { keyword: needle, limit: 10, count_hits: false }));
			if (version !== am.pageVersion) return;
			for (const g of got) if (g.ok) for (const r of (g.value as J)?.results ?? []) recalled.push({ profile: g.profile, id: String(r.memory_id), passage: String(r.passage ?? "") });
			paintDeep();
		})();
		return h;
	};

	am.detail = detail;
	am.md = md;
	am.tab({ id: "home", group: null, label: "Home", key: "h", profiles: "any", render: home });
	am.tab({ id: "memories", group: null, label: "Memories", key: "m", profiles: "any", render: section("memory", "Memories", (it) => typeOf(it)) });
	am.tab({ id: "learnings", group: null, label: "Learnings", key: "l", profiles: "any", render: section("learning", "Learnings", (it) => typeOf(it)) });
	am.tab({ id: "journals", group: null, label: "Journals", key: "j", profiles: "any", render: section("journal", "Journals", (it) => it.agent ?? "Other agent") });
	am.tab({ id: "projects", group: null, label: "Projects", key: "r", profiles: "any", render: projects });
	am.tab({ id: "search", group: null, label: "Search", key: "s", profiles: "any", hidden: true, render: search });
}
