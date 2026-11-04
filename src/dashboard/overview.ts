// Overview tab: what the agents remember, whether the system is healthy, recent sessions, the live feed and the memory layers,
// all from the snapshot (am.snapshot) and the stream (am.api.subscribe). Counts are sums over the profiles the snapshot read;
// the header's profile choice (#overview?profile=NAME) filters only the per-profile lists (sessions, feed, batch state). A value the server did not send
// reads "Not reported", never 0. Change events make the counts stale; the tab says so and asks for one fresh snapshot.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { FeedItem, HealthCheck, LayerState, ProfileSessionRow, Snapshot } from "../viewer/types";
import type { Am, Batch, Node, Route } from "./am";

export function overviewTab(am: Am): void {
	const { el, enc, empty, help, intro, loading, note, win } = am;
	const FEED_MAX = 50;
	const REFRESH_MS = 5_000; // change events within this window share one snapshot reload
	const LAYERS: Record<string, string> = { digests: "Digests", parts: "Consolidated parts", memories: "Memories", preferences: "Preferences", me: "Me (shared)" };
	const FEED_CLS: Record<string, string> = { MEMORY: "c-teal", IMPORT: "c-blue", FORGET: "c-red", PREFERENCE: "c-amber", BATCH: "c-ok" };

	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "Not reported");
	const valid = (iso: unknown) => typeof iso === "string" && iso !== "" && !Number.isNaN(Date.parse(iso));
	const utc = (iso: unknown, none = "Not reported") => (valid(iso) ? `${new Date(iso as string).toISOString().slice(0, 16).replace("T", " ")} UTC` : none);
	const ago = (iso: string) => {
		if (!valid(iso)) return "unknown time";
		const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
		if (s < 0) return utc(iso);
		if (s < 60) return "just now";
		if (s < 3600) return `${Math.floor(s / 60)} min ago`;
		if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
		return `${Math.floor(s / 86_400)} d ago`;
	};
	const when = (parent: Node, iso: string, text: string) => {
		const t = el("time", parent, text);
		if (valid(iso)) { t.setAttribute("datetime", iso); t.setAttribute("title", utc(iso)); }
		return t;
	};
	const bytes = (n: unknown) => {
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "Not reported";
		const units = ["B", "KiB", "MiB", "GiB", "TiB"];
		let v = n, i = 0;
		while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
		return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
	};
	const verdictOf = (checks: HealthCheck[]) => checks.some((c) => c.state === "fail") ? "fail" : checks.some((c) => c.state === "warn") ? "warn" : "ok";
	const chip = (parent: Node, text: string, c = "") => cls(el("span", parent, text), c ? `chip ${c}` : "chip");
	const stateCls = (s: string) => (s === "ok" ? "c-ok" : s === "warn" ? "c-warn" : s === "fail" ? "c-fail" : "");
	const has = (tab: string) => am.tabs.some((t) => t.id === tab);
	/** A link when its tab is registered; otherwise the same text, so a link never lands on an unrelated page. */
	const go = (parent: Node, tab: string, href: string, text: string) => {
		const a = el(has(tab) ? "a" : "span", parent, text);
		if (has(tab)) a.setAttribute("href", href);
		return a;
	};

	// One subscription for the life of the page (dataClient runs first in PARTS, so am.api is set). It keeps the changes and health
	// rows that arrived since the last snapshot, and repaints the Overview only while it is on screen.
	let mounted: { version: number; paint: () => void } | null = null;
	let extra: FeedItem[] = [], checks: HealthCheck[] | null = null, since = 0, timer: unknown = null, failed = "";
	const onScreen = () => { if (mounted && mounted.version !== am.pageVersion) mounted = null; return mounted; };
	let batchRead = 0;
	/** Sign-in reads each profile's batch status once; Overview reads it again on each visit and with each fresh snapshot. */
	const reloadBatches = () => {
		const req = ++batchRead;
		void Promise.all(am.active().map(async (p) => [p.name, await am.call(`/api/profiles/${enc(p.name)}/batch`).catch((err: Error) => err)] as [string, Batch | Error]))
			.then((got) => { if (req !== batchRead) return; for (const [n, b] of got) am.batches.set(n, b); onScreen()?.paint(); });
	};
	/** One snapshot reload for a burst of changes, and only while the Overview is on screen; the data client shares a request in flight. */
	const refresh = () => {
		if (timer !== null || !onScreen()) return;
		timer = win.setTimeout(() => {
			timer = null;
			if (!onScreen() || !since) return;
			am.api.snapshot().catch((err: unknown) => { failed = am.why(err); onScreen()?.paint(); });
		}, REFRESH_MS);
	};
	am.api.subscribe((e) => {
		if (e.type === "snapshot") { extra = []; checks = null; since = 0; failed = ""; if (onScreen()) reloadBatches(); }
		else if (e.type === "change") { extra = [e.item, ...extra].slice(0, FEED_MAX); since++; refresh(); }
		else if (e.type === "health") checks = e.checks;
		else return;
		onScreen()?.paint();
	});

	const stat = (grid: Node, value: string, label: string, term: string, sub?: string, numCls = "") => {
		const s = cls(el("div", grid), "stat");
		cls(el("span", s, value), numCls ? `num ${numCls}` : "num");
		help(cls(el("span", s, label), "lbl"), term);
		if (sub) cls(el("span", s, sub), "muted");
		return s;
	};
	const section = (body: Node, title: string, term: string) => {
		const sec = cls(el("section", body), "panel");
		help(el("h3", sec, title), term);
		return sec;
	};

	/** The last consolidation batch of one profile, from its batch status and the batch health rows. Codes and dates only. */
	const batchOf = (p: string, rows: HealthCheck[]): { text: string; ok: boolean } => {
		const b = am.batches.get(p);
		const flagged = rows.filter((c) => c.subject === p && (c.check_id === "batch_overdue" || c.check_id === "lease_expired") && c.state !== "ok")
			.map((c) => (c.check_id === "batch_overdue" ? "overdue" : "lease expired"));
		if (!b) return { text: `${p}: batch status not loaded`, ok: false };
		if (b instanceof Error) return { text: `${p}: batch status unavailable`, ok: false };
		const s = b.last_status, last = b.last_lease_at;
		let text: string, ok: boolean;
		if (s && valid(s.at) && (!valid(last) || Date.parse(s.at!) >= Date.parse(last!))) {
			text = `${s.status === "stuck" ? "parked" : "skipped"} ${utc(s.at)}${s.reason ? ` (${s.reason})` : ""}`;
			ok = false;
		} else if (valid(last)) { text = `leased ${utc(last)}`; ok = true; }
		else { text = "no batch yet"; ok = true; }
		if (flagged.length) { text += `, ${flagged.join(", ")}`; ok = false; }
		return { text: `${p}: ${text}`, ok };
	};

	const remember = (body: Node, s: Snapshot) => {
		const sec = section(body, "What your agents remember", "overview");
		const asOf = `Sums over ${s.profiles.length === 1 ? "the profile" : `the ${s.profiles.length} profiles`} this sign-in can read (${s.profiles.join(", ") || "none"}), as of ${utc(s.at, "an unknown time")}.`;
		note(sec, since ? `${asOf} ${since} ${since === 1 ? "change has" : "changes have"} arrived since; ${failed ? `the refresh failed: ${failed}` : "refreshing the counts."}` : asOf, "muted");
		const c = s.counts, u = s.usage, grid = cls(el("div", sec), "stats");
		stat(grid, num(c.memories), "Memories", "memories", `${num(c.revisions)} older versions`);
		stat(grid, num(c.observations), "Observations", "observations", `across ${num(c.sessions)} sessions`);
		stat(grid, num(c.sessions), "Sessions", "sessions", `${num(c.sessions_active)} running`);
		stat(grid, num(c.lessons), "Lessons", "lessons");
		stat(grid, num(c.crystals), "Crystals", "crystals");
		stat(grid, num(c.actions), "Actions", "actions");
		stat(grid, num(c.graph_edges), "Graph relations", "relations", `between ${num(c.graph_nodes)} records`);
		stat(grid, num(u.recall_tokens_today), "Recall tokens today (UTC)", "recall_tokens", s.profiles.length > 1 ? "summed over each profile a recall read" : undefined);
	};

	const healthy = (body: Node, s: Snapshot, filter: string | null) => {
		const sec = section(body, "Is it healthy", "verdict");
		const rows = checks ?? s.health.checks, u = s.usage, grid = cls(el("div", sec), "stats");
		const v = rows.length ? verdictOf(rows) : null;
		const st = stat(grid, v ? v.toUpperCase() : "No checks", "Status", "verdict", v
			? `${rows.filter((r) => r.state !== "ok").length} of ${rows.length} checks need attention`
			: "No health check has run yet", v ? stateCls(v) : "");
		go(st, "health", "#health", "Open Health");
		const emb = s.flags.find((f) => f.id === "embeddings");
		stat(grid, num(u.vectors), "Search index", "search_index", `records with vectors${emb && emb.state !== "on" ? `; embeddings ${emb.state}` : ""}`);
		stat(grid, bytes(u.storage_bytes), "Storage", "storage", u.storage_limit > 0
			? `of ${bytes(u.storage_limit)}${s.profiles.length > 1 ? ` (${s.profiles.length} profile stores)` : ""}` : "limit not reported");
		const ver = s.version && s.version !== "unknown" ? (s.version.length > 12 ? s.version.slice(0, 8) : s.version) : "Not reported";
		const vs = stat(grid, ver, "Version", "version", `deployed ${utc(s.deployed_at, "at an unreported time")}`);
		if (ver !== "Not reported") vs.setAttribute("title", s.version);
		// recall_totals counts a recall once in each profile that returned hits, so the sum is participations, not unique recalls.
		const rw = stat(grid, num(u.recalls_today), s.profiles.length > 1 ? "Profile recalls today (UTC)" : "Recalls today (UTC)", "recalls_today", `${num(u.writes_today)} writes today`);
		help(rw, "writes_today");
		const batches = (filter === null ? s.profiles : [filter]).map((p) => batchOf(p, rows));
		const bs = stat(grid, !batches.length ? "Not reported" : batches.every((b) => b.ok) ? "OK" : "Check", "Batch confinement", "daily_batch");
		const list = el("ul", bs);
		list.setAttribute("aria-label", "Batch state by profile");
		for (const b of batches) cls(el("li", list, b.text), b.ok ? "muted" : "");
	};

	const sessions = (body: Node, s: Snapshot, filter: string | null) => {
		const sec = section(body, "Recent sessions", "sessions");
		const rows = s.recent_sessions.filter((r: ProfileSessionRow) => filter === null || r.profile === filter);
		if (!rows.length) {
			empty(sec, filter === null ? "No sessions yet. Capture hooks upload each session's digests once a device is installed." : `No recent sessions in ${filter}.`, "agent-memory install");
			return;
		}
		const table = el("table", sec);
		table.setAttribute("data-list", "");
		el("caption", table, "Newest first").setAttribute("class", "vh");
		const head = el("tr", el("thead", table));
		for (const t of ["Project", "First ask", "Status", "Observations", "First upload"]) el("th", head, t).setAttribute("scope", "col");
		const tb = el("tbody", table);
		for (const r of rows) {
			const tr = el("tr", tb), q = `?profile=${enc(r.profile)}`;
			const pc = el("td", tr);
			chip(pc, r.profile);
			if (r.project) { // #graph/ID always opens: the shell routes it to the graph page until the Graph tab registers
				const a = el("a", pc, r.project.slice(0, 8));
				a.setAttribute("href", `#graph/${enc(r.project)}${q}`);
				a.setAttribute("title", `Project record ${r.project}`);
			}
			else cls(el("span", pc, "No project"), "na");
			const ask = go(el("td", tr), "sessions", `#sessions/${enc(r.id)}${q}`, r.first_ask ?? "No ask recorded");
			if (has("sessions")) ask.setAttribute("data-item", "");
			if (!r.first_ask) ask.setAttribute("class", "na");
			chip(el("td", tr), r.status === "active" ? "Running" : "Completed", r.status === "active" ? "c-ok" : "");
			el("td", tr, num(r.counts.asks + r.counts.decisions + r.counts.corrections + r.counts.outcomes));
			when(el("td", tr), r.first_upload_at, utc(r.first_upload_at));
		}
		const p = el("p", sec);
		go(p, "sessions", "#sessions", has("sessions") ? "All sessions" : "The Sessions tab lists every session once it ships.");
		help(p, "first_upload");
	};

	const feed = (body: Node, s: Snapshot, filter: string | null) => {
		const sec = section(body, "Live feed", "feed");
		const seen = new Set<string>(), items: FeedItem[] = [];
		for (const f of [...extra, ...s.feed]) {
			const k = `${f.profile}|${f.id}`; // id is the profile's activity id
			if (seen.has(k) || (filter !== null && f.profile !== filter)) continue;
			seen.add(k);
			items.push(f);
		}
		if (!items.length) {
			note(sec, filter === null ? "No changes yet. Saves, imports, forgets, lesson changes and batch runs appear here as they happen." : `No recent changes in ${filter}.`);
			return;
		}
		const ul = cls(el("ul", sec), "prefs");
		ul.setAttribute("data-list", "");
		ul.setAttribute("aria-label", "Changes, newest first");
		for (const f of items.slice(0, FEED_MAX)) {
			const li = el("li", ul), q = `?profile=${enc(f.profile)}`;
			chip(li, f.kind, FEED_CLS[f.kind] ?? "");
			chip(li, f.profile);
			// A MEMORY or PREFERENCE item opens the record it names; anything else, or one naming none, opens its Audit row's list.
			const href = (f.kind === "MEMORY" || f.kind === "PREFERENCE") && f.target ? `#memories/${enc(f.target)}${q}` : `#audit${q}`;
			const a = el("a", li, f.summary || "No summary");
			a.setAttribute("href", href);
			a.setAttribute("data-item", "");
			el("span", li, " · ");
			cls(when(li, f.at, ago(f.at)), "muted");
		}
	};

	const layers = (body: Node, s: Snapshot) => {
		const sec = section(body, "Memory layers", "layers");
		if (!s.layers.length) { note(sec, "The server reported no layers."); return; }
		const ol = cls(el("ol", sec), "prefs");
		ol.setAttribute("data-list", "");
		for (const l of s.layers as LayerState[]) {
			const li = el("li", ol);
			const a = go(li, "health", "#health/consolidation", LAYERS[l.layer] ?? l.layer);
			if (has("health")) a.setAttribute("data-item", "");
			el("span", li, ` ${num(l.count)} `);
			chip(li, l.state, l.state === "ok" ? "c-ok" : l.state === "waiting" ? "c-warn" : "");
			if (l.waits_for) el("span", li, `Waits for ${l.waits_for}.`);
		}
	};

	// profiles "any": the shell's header picker sets ?profile, and refuses an unknown or inactive one before render.
	am.tab({ id: "overview", group: null, label: "Overview", key: "o", profiles: "any", render: (root: Node, route: Route) => {
		const h = el("h2", root, "Overview");
		intro(root, "Overview", "overview", "What your agents remember, whether the system is healthy, and what changed most recently.");
		const body = el("div", root);
		const paint = () => {
			body.replaceChildren();
			const s = am.snapshot;
			if (!s) {
				loading(body, 6);
				note(body, "Waiting for the first full sync. The numbers appear when it arrives.");
				return;
			}
			// The shell admits only active profiles; one the snapshot did not read keeps the choice and shows no lists, never others'.
			const filter = route.query.profile ?? null, read = filter === null || s.profiles.includes(filter);
			if (!read) note(body, `The snapshot did not read ${filter}, so its sessions and feed are not shown. The counts cover the profiles it read.`, "warn");
			else if (filter !== null) note(body, `Sessions, the feed and batch state show ${filter}. The counts cover every profile.`, "muted");
			remember(body, s);
			healthy(body, s, filter);
			if (read) { sessions(body, s, filter); feed(body, s, filter); }
			layers(body, s);
		};
		mounted = { version: am.pageVersion, paint };
		paint();
		if (am.snapshot) reloadBatches(); // a first visit gets its read with the first snapshot
		if (since) refresh();
		return h;
	} });
}
