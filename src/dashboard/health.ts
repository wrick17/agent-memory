// Health tab: the verdict and every check (read-only details), engine and connection, the search index, capture per device,
// consolidation (#health/consolidation), backups, and recall quality (eval runs and pending eval candidates). Reads GET /api/health,
// GET /api/eval/runs and each profile's GET .../eval-candidates?status=pending; writes only on a click: RE-CHECK NOW
// (POST /api/health/sweep) and accept or dismiss a candidate. The header's profile choice (#health?profile=NAME; the shell refuses an
// unknown or inactive one) narrows consolidation, eval runs and candidates to that profile. Every server value reaches the page as text.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { ClientStatusRow, EvalCandidate, EvalRun, HealthCheck, HealthReport, Page } from "../viewer/types";
import type { Am, J, Node, Route } from "./am";

export function healthTab(am: Am): void {
	const { act, btn, call, copy, el, empty, enc, facts, help, intro, link, loading, note, pageStatus, why, win } = am;
	const CANDIDATES = 20; // one page per profile; "Load more" follows next_cursor
	const RUNS = 100;
	const PENDING_DAYS = 7;
	const CHECKS: Record<string, string> = { batch_overdue: "Batch overdue", lease_expired: "Lease expired", capture_stale: "Capture reporting",
		capture_pending: "Capture pending", backup_overdue: "Backup" };
	const OUTCOME: Record<string, string> = { completed: "Completed", batch_skipped: "Skipped", stuck: "Stuck" };
	const DOCTOR = "agent-memory doctor";

	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "Not reported");
	const valid = (iso: unknown) => typeof iso === "string" && iso !== "" && !Number.isNaN(Date.parse(iso));
	const utc = (iso: unknown, none = "Not reported") => (valid(iso) ? `${new Date(iso as string).toISOString().slice(0, 16).replace("T", " ")} UTC` : none);
	const bytes = (n: unknown) => {
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "Not reported";
		const units = ["B", "KiB", "MiB", "GiB"];
		let v = n, i = 0;
		while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
		return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
	};
	const score = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "Not reported");
	const chip = (parent: Node, text: string, c = "") => cls(el("span", parent, text), c ? `chip ${c}` : "chip");
	const stateCls = (s: string) => (s === "ok" ? "c-ok" : s === "warn" ? "c-warn" : s === "fail" ? "c-fail" : "");
	const verdictOf = (rows: HealthCheck[]) => rows.some((c) => c.state === "fail") ? "fail" : rows.some((c) => c.state === "warn") ? "warn" : "ok";
	const section = (root: Node, title: string, term?: string, id?: string) => {
		const sec = cls(el("section", root), "panel");
		const h = el("h3", sec, title);
		if (id) h.setAttribute("id", id);
		if (term) help(h, term);
		return { sec, h };
	};
	let filter: string | null = null; // #health?profile=NAME, set by each render
	const mine = (p: string) => filter === null || filter === p;

	// One subscription for the life of the page (dataClient runs before this part): the stream state for "Viewer feed", and the
	// health rows from `event: health`, which repaint the checks only while this tab is on screen.
	let stream: { state: "unknown" | "live" | "paused"; at: string | null } = { state: "unknown", at: null };
	let mounted: { version: number; paint: (rows: HealthCheck[]) => void; feed?: () => void } | null = null;
	am.api.subscribe((e) => {
		if (e.type === "live") stream = { state: "live", at: e.since };
		else if (e.type === "paused") stream = { state: "paused", at: e.as_of };
		else if (e.type !== "health") return;
		if (mounted && mounted.version !== am.pageVersion) mounted = null; // Health left the screen
		if (e.type === "health") mounted?.paint(e.checks);
		else mounted?.feed?.(); // live or paused: the Viewer feed line is drawn from `stream`
	});

	/** The verdict line and the read-only list of checks. `names` maps a device id to its name. */
	const checksView = (box: Node, rows: HealthCheck[], names: Map<string, string>) => {
		box.replaceChildren();
		const line = el("p", box);
		if (!rows.length) {
			chip(line, "No checks");
			el("span", line, "No health check has run yet. RE-CHECK NOW runs them; the nightly sweep runs them too.");
			return;
		}
		const v = verdictOf(rows), bad = rows.filter((r) => r.state === "fail").length, warn = rows.filter((r) => r.state === "warn").length;
		chip(line, v.toUpperCase(), stateCls(v));
		help(line, "verdict");
		const last = rows.map((r) => r.at).filter(valid).sort().pop();
		el("span", line, `${v === "ok" ? `Every check passed (${rows.length} checks).` : `${bad ? `${bad} failed. ` : ""}${warn ? `${warn} need attention. ` : ""}${rows.length - bad - warn} passed.`}${last ? ` Last checked ${utc(last)}.` : ""}`);
		const table = el("table", box);
		el("caption", table, "Checks, failures first").setAttribute("class", "vh");
		const head = el("tr", el("thead", table));
		for (const t of ["Check", "Subject", "State", "Detail", "Checked"]) el("th", head, t).setAttribute("scope", "col");
		const tb = el("tbody", table), rank: Record<string, number> = { fail: 0, warn: 1, ok: 2 };
		for (const r of [...rows].sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3))) {
			const tr = el("tr", tb);
			el("td", tr, CHECKS[r.check_id] ?? r.check_id);
			el("td", tr, r.subject === "account" ? "Account" : names.get(r.subject) ?? r.subject);
			chip(el("td", tr), r.state, stateCls(r.state));
			el("td", tr, r.detail);
			el("td", tr, utc(r.at));
		}
	};

	const engine = (root: Node, report: HealthReport | Error) => {
		const { sec } = section(root, "Engine and connection");
		const s = am.snapshot, names = am.active().map((p) => p.name);
		const answering = report instanceof Error ? [] : report.consolidation.map((c) => c.profile);
		const silent = names.filter((n) => !answering.includes(n));
		const mcp = `${win.location.origin}/mcp`, box = el("div", sec);
		const draw = () => { box.replaceChildren(); facts(box, [
			["Worker version", s ? `${s.version || "Not reported"}, deployed ${utc(s.deployed_at, "at an unreported time")}` : "Waiting for the first full sync", !s],
			["Account store", report instanceof Error ? `Could not read: ${why(report)}` : "Answering", report instanceof Error],
			["Profile stores", report instanceof Error ? "Unknown: the account read failed" : `${answering.length} of ${names.length} active answering${silent.length ? `; no answer from ${silent.join(", ")}` : ""}`, report instanceof Error || silent.length > 0],
			["Viewer feed", stream.state === "live" ? `Live since ${utc(stream.at)}` : stream.state === "paused" ? `Paused; numbers as of ${utc(stream.at)}` : "Not connected yet", stream.state !== "live"],
			["MCP URL", mcp],
		]); };
		draw();
		copy(sec, "Copy MCP URL", () => mcp);
		return draw;
	};

	const search = (root: Node, report: HealthReport) => {
		const { sec } = section(root, "Search index", "search_index");
		const x = report.search, grid = cls(el("div", sec), "stats");
		const stat = (v: string, l: string, term: string) => { const s = cls(el("div", grid), "stat"); cls(el("span", s, v), "num"); help(cls(el("span", s, l), "lbl"), term); };
		stat(num(x.lexical_documents), "Lexical documents", "search_index"); // null when a profile's count could not be read
		stat(num(x.vectors), "Vectors", "vectors");
		stat(x.embeddings ? "On" : "Off", "Embeddings", "embeddings");
		stat(typeof x.semantic_ms === "number" ? `${x.semantic_ms / 1000} s` : "Not reported", "Semantic deadline", "semantic_deadline");
	};

	const capture = (root: Node, report: HealthReport) => {
		const { sec } = section(root, "Capture", "capture");
		if (!report.devices.length) {
			empty(sec, "No device has reported capture status yet. Each local run reports it. Run the doctor on a device to check its tokens, hooks, launchd job and spool.", DOCTOR);
			return;
		}
		const cards = cls(el("div", sec), "cards");
		for (const d of report.devices as ClientStatusRow[]) {
			const b = d.body, card = cls(el("section", cards), "card");
			const h = el("h4", card, d.device_name ?? d.device_id);
			if (d.revoked) chip(h, "Revoked", "c-fail");
			const old = valid(b.oldest_pending_at) && Date.now() - Date.parse(b.oldest_pending_at!) > PENDING_DAYS * 86_400_000;
			if (typeof b.stuck_ranges === "number" && b.stuck_ranges > 0) chip(h, "Stuck ranges", "c-warn");
			if (old) chip(h, `Pending over ${PENDING_DAYS} days`, "c-warn");
			for (const c of report.checks.filter((r) => r.subject === d.device_id && r.state !== "ok")) chip(h, `${CHECKS[c.check_id] ?? c.check_id}: ${c.state}`, stateCls(c.state));
			const older = "Not reported (older runner)";
			const clients = Object.entries(b.clients ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
			facts(card, [
				["Device id", d.device_id],
				["Reported", utc(d.reported_at)],
				["Clients", clients || "None reported", !clients],
				["Hooks", b.hooks.length ? b.hooks.join(", ") : "None registered", !b.hooks.length],
				["Prompt injection", b.inject ? "On" : "Off"],
				["Scheduled batch (launchd)", b.launchd_loaded ? "Loaded" : "Not loaded", !b.launchd_loaded],
				["Spool", `${num(b.spool_files)} files, ${bytes(b.spool_bytes)}${valid(b.oldest_spool_at) ? `, oldest ${utc(b.oldest_spool_at)}` : ""}`],
				["Last digest", utc(b.last_digest_at, "No digest yet"), !valid(b.last_digest_at)],
				["Refused since last report", num(b.refused_since_last)],
				["Pending ranges", b.pending_ranges === undefined ? older : num(b.pending_ranges), b.pending_ranges === undefined],
				["Stuck ranges", b.stuck_ranges === undefined ? older : num(b.stuck_ranges), b.stuck_ranges === undefined],
				["Oldest pending range", b.oldest_pending_at === undefined ? older : utc(b.oldest_pending_at, "None pending"), b.oldest_pending_at === undefined],
				["Sessions with a missing transcript", b.missing_sources === undefined ? older : num(b.missing_sources), b.missing_sources === undefined],
			]);
		}
		const p = el("p", sec, `Run the doctor on a device for its local details. A stuck range, or a pending range older than ${PENDING_DAYS} days, needs a look there. `);
		el("code", p, DOCTOR);
		copy(p, "Copy doctor command", () => DOCTOR);
		help(p, "pending_ranges");
	};

	const consolidation = (root: Node, report: HealthReport) => {
		const { sec, h } = section(root, "Consolidation", "consolidation", "consolidation");
		const rows = report.consolidation.filter((c) => mine(c.profile));
		if (!rows.length) note(sec, filter === null ? "No profile reported its batch state." : `${filter} reported no batch state.`);
		else {
			const table = el("table", sec);
			const head = el("tr", el("thead", table));
			for (const t of ["Profile", "Last batch", "Outcome", "Next due", "Flags"]) el("th", head, t).setAttribute("scope", "col");
			const tb = el("tbody", table);
			for (const c of rows) {
				const tr = el("tr", tb);
				el("td", tr, c.profile);
				el("td", tr, utc(c.last_batch_at, "No batch yet"));
				el("td", tr, c.outcome ? OUTCOME[c.outcome] ?? c.outcome : "No batch yet");
				el("td", tr, utc(c.next_due_at, "Not scheduled"));
				const f = el("td", tr);
				if (!c.flags.length) el("span", f, "None");
				for (const x of c.flags) chip(f, x === "batch_overdue" ? "Overdue" : "Lease expired", "c-warn");
			}
		}
		// The thresholds the code uses: src/profile/maintenance.ts, similar.ts and housekeeping.ts, and the health sweep rules in src/health.ts.
		const ul = el("ul", sec);
		const li = (text: string, term?: string) => { const x = el("li", ul, text); if (term) help(x, term); };
		li("A batch leases at most 40 queued items for at most 900 seconds, at most once per profile in 20 hours. An expired lease returns its items to the queue.", "lease");
		li("Records of the same kind at cosine similarity 0.92 or higher become near-duplicate review items. Neighbours below 0.80 are ignored, and related records at 0.85 or higher get a similarity link. Rules, preferences and decisions below 0.92 that share a project become possible-contradiction items.", "similarity");
		li("A journal with at least 8,000 uncompacted characters and no update for 7 days becomes a stale-journal item. A memory with no recall and no update in 90 days becomes a stale-memory review item; stated, pinned, preference, journal and me records never do.", "stale");
		li("Overdue means no completed batch for more than 26 hours. Lease expired means a lease ran out without the batch completing it.");
		return h;
	};

	const backups = (root: Node, report: HealthReport) => {
		const { sec } = section(root, "Backups", "backups");
		const b = report.backups;
		facts(sec, [["Last export", utc(b.last_export_at, "No export recorded yet"), !valid(b.last_export_at)],
			["Retained", b.retained.length ? b.retained.map((r) => `${r.id} (${utc(r.at)})`).join("; ") : "None", !b.retained.length]]);
		note(sec, "The backup check warns when the last encrypted export is more than 30 hours old.", "muted");
		link(el("p", sec), "#/backups", "Open Backups");
	};

	/** Recall quality over time: recall_all_at_k per run, one line per channel setting. The table below holds every value. */
	const chart = (parent: Node, runs: EvalRun[]) => {
		const NS = "http://www.w3.org/2000/svg", W = 640, H = 180, P = 28, doc = am.doc;
		const sorted = [...runs].filter((r) => valid(r.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
		if (sorted.length < 2) return;
		const t0 = Date.parse(sorted[0]!.at), t1 = Date.parse(sorted[sorted.length - 1]!.at), span = Math.max(t1 - t0, 1);
		const x = (r: EvalRun) => P + ((Date.parse(r.at) - t0) / span) * (W - 2 * P), y = (v: number) => H - P - v * (H - 2 * P);
		const svg: J = doc.createElementNS(NS, "svg");
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", `All expected records in the top k, ${sorted.length} runs from ${utc(sorted[0]!.at)} to ${utc(sorted[sorted.length - 1]!.at)}. The table below lists every run.`);
		svg.setAttribute("style", "width:100%;max-width:640px;height:auto;display:block;color:var(--ink)");
		const add = (tag: string, attrs: Record<string, string>, text?: string) => {
			const e: J = doc.createElementNS(NS, tag);
			for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
			if (text !== undefined) e.textContent = text;
			svg.appendChild(e);
			return e;
		};
		for (const v of [0, 0.5, 1]) {
			add("line", { x1: String(P), x2: String(W - P), y1: String(y(v)), y2: String(y(v)), stroke: "var(--rule)" });
			add("text", { x: "2", y: String(y(v) + 4), "font-size": "10", fill: "var(--muted)" }, v.toFixed(1));
		}
		// Dash pattern and marker shape tell the series apart, so the legend does not rely on color.
		const STYLE: Record<string, { dash: string; mark: string }> = { lexical: { dash: "", mark: "square" }, vector: { dash: "6 4", mark: "circle" }, hybrid: { dash: "2 3", mark: "diamond" } };
		const series = new Map<string, EvalRun[]>();
		for (const r of sorted) series.set(`${r.channels} k=${r.k}`, [...(series.get(`${r.channels} k=${r.k}`) ?? []), r]);
		let ly = 12;
		for (const [name, rs] of series) {
			const st = STYLE[rs[0]!.channels] ?? { dash: "1 2", mark: "circle" };
			const pts = rs.map((r) => `${x(r).toFixed(1)},${y(Math.min(Math.max(r.recall_all_at_k, 0), 1)).toFixed(1)}`);
			add("polyline", { points: pts.join(" "), fill: "none", stroke: "currentColor", "stroke-width": "1.5", ...(st.dash ? { "stroke-dasharray": st.dash } : {}) });
			for (const pt of pts) {
				const [px, py] = pt.split(",").map(Number) as [number, number];
				if (st.mark === "square") add("rect", { x: String(px - 3), y: String(py - 3), width: "6", height: "6", fill: "currentColor" });
				else if (st.mark === "diamond") add("polygon", { points: `${px},${py - 4} ${px + 4},${py} ${px},${py + 4} ${px - 4},${py}`, fill: "currentColor" });
				else add("circle", { cx: String(px), cy: String(py), r: "3", fill: "currentColor" });
			}
			add("text", { x: String(W - P - 120), y: String(ly), "font-size": "10", fill: "currentColor" }, `${name}: ${st.dash ? "dashed" : "solid"} line, ${st.mark}s`);
			ly += 12;
		}
		parent.appendChild(svg);
	};

	const quality = (root: Node, runs: EvalRun[] | Error) => {
		const { sec } = section(root, "Recall quality", "eval");
		if (runs instanceof Error) { note(sec, `Could not read the eval runs: ${why(runs)}`); return; }
		const mineRuns = runs.filter((r) => mine(r.profile));
		if (!mineRuns.length) {
			empty(sec, "No eval runs yet. The eval runs on a device against a case file and sends only its scores and counts here.",
				`agent-memory eval --cases FILE --profile ${filter ?? "work"} --channels hybrid --k 5`);
			return;
		}
		chart(sec, mineRuns);
		const table = el("table", sec);
		el("caption", table, `Eval runs, newest first (at most ${RUNS})`).setAttribute("class", "vh");
		const head = el("tr", el("thead", table));
		for (const t of ["Run at", "Profile", "Channels", "k", "Cases", "All expected in top k", "Any expected in top k", "MRR"]) el("th", head, t).setAttribute("scope", "col");
		const tb = el("tbody", table);
		for (const r of [...mineRuns].sort((a, b) => (a.at < b.at ? 1 : -1))) {
			const tr = el("tr", tb);
			for (const v of [utc(r.at), r.profile, r.channels, num(r.k), num(r.cases), score(r.recall_all_at_k), score(r.any_hit_at_k), score(r.mrr)]) el("td", tr, v);
		}
	};

	/** Pending candidates of one profile, a page at a time. Accept and dismiss are owner writes through am.act. */
	const candidates = (list: Node, profile: string, version: number) => {
		const box = el("div", list);
		const h = el("h4", box, profile);
		const items = el("ul", box);
		cls(items, "prefs");
		items.setAttribute("aria-label", `Pending eval candidates in ${profile}`);
		const status = el("p", box);
		let more: Node | null = null;
		const load = async (cursor?: string) => {
			status.textContent = "Loading…";
			if (more) more.hidden = true;
			let page: Page<EvalCandidate>;
			try {
				page = await call(`/api/profiles/${enc(profile)}/eval-candidates?status=pending&limit=${CANDIDATES}${cursor ? `&cursor=${enc(cursor)}` : ""}`);
			} catch (err) {
				if (version === am.pageVersion) status.textContent = `Could not read: ${why(err)}`;
				return;
			}
			if (version !== am.pageVersion) return;
			status.textContent = !page.rows.length && !cursor ? "No pending candidates." : "";
			for (const c of page.rows) {
				const li = el("li", items);
				am.textBlock(li, c.query);
				const ex = el("p", li, "Expected: ");
				c.expected.forEach((id, i) => { if (i) el("span", ex, ", "); link(ex, `#memories/${enc(id)}?profile=${enc(profile)}`, id); });
				el("p", li, `Evidence: ${c.evidence.map((e) => `${e.kind} ${e.ref}${e.note ? ` (${e.note})` : ""}`).join("; ")}`);
				cls(el("p", li, `Suggested ${utc(c.created_at)}`), "muted");
				const path = `/api/profiles/${enc(profile)}/eval-candidates/${enc(c.id)}`;
				btn(li, "Accept", () => act(path, "accept the eval candidate", { action: "accept" },
					() => ({ text: `Accepted. To add accepted candidates to a case file, run agent-memory eval export-candidates --profile ${profile} --out FILE.` })), `Accept candidate: ${c.query}`);
				btn(li, "Dismiss", () => act(path, "dismiss the eval candidate", { action: "dismiss" }, () => ({ text: "Dismissed." })), `Dismiss candidate: ${c.query}`);
			}
			if (page.next_cursor) {
				const next = page.next_cursor;
				more = btn(box, "Load more", () => void load(next));
			}
		};
		void load();
		return h;
	};

	am.tab({ id: "health", group: "system", label: "Health", key: "h", profiles: "any", render: (root: Node, route: Route) => {
		const version = am.pageVersion;
		filter = route.query.profile ?? null;
		const h = el("h2", root, "Health");
		intro(root, "Health", "health", "Checks on capture, search, consolidation and backups, and how well recall finds what it should.");
		const bar = cls(el("div", root), "toolbar");
		btn(bar, "Re-check now", () => act("/api/health/sweep", "run the health checks", undefined,
			(r: J) => ({ text: `Checks ran: ${Array.isArray(r?.checks) ? r.checks.length : 0} rows written.` })));
		copy(bar, "Copy agent-memory doctor", () => DOCTOR);
		help(bar, "doctor");
		pageStatus(root);

		const checksBox = el("div", root);
		const names = new Map<string, string>();
		const s = am.snapshot;
		if (s) checksView(checksBox, s.health.checks, names); else loading(checksBox, 2);
		const rest = el("div", root);
		const wait = loading(rest, 6);
		let focus: Node | undefined;

		void (async () => {
			const [rep, runs] = await Promise.allSettled([call("/api/health") as Promise<HealthReport>,
				call(`/api/eval/runs?limit=${RUNS}${filter !== null ? `&profile=${enc(filter)}` : ""}`) as Promise<{ runs: EvalRun[] }>]);
			if (version !== am.pageVersion) return;
			wait.replaceChildren();
			const report: HealthReport | Error = rep.status === "fulfilled" ? rep.value : rep.reason instanceof Error ? rep.reason : new Error(String(rep.reason));
			if (!(report instanceof Error)) {
				for (const d of report.devices) if (d.device_name) names.set(d.device_id, d.device_name);
				checksView(checksBox, report.checks, names);
			} else if (!s) { checksBox.replaceChildren(); note(checksBox, `Could not read the health checks: ${why(report)}`); }
			mounted = { version, paint: (rows) => checksView(checksBox, rows, names), feed: engine(rest, report) };
			if (!(report instanceof Error)) {
				search(rest, report);
				capture(rest, report);
				const ch = consolidation(rest, report);
				if (route.id === "consolidation") focus = ch;
				backups(rest, report);
			}
			quality(rest, runs.status === "fulfilled" ? (Array.isArray(runs.value?.runs) ? runs.value.runs : []) : runs.reason instanceof Error ? runs.reason : new Error(String(runs.reason)));
			const { sec } = section(rest, "Eval candidates", "eval_candidates");
			const profiles = am.active().map((p) => p.name).filter(mine);
			if (!profiles.length) note(sec, "No active profiles.");
			for (const p of profiles) candidates(sec, p, version);
			// #health/consolidation: focus the section once it exists (the heading render returned is the tab's).
			if (focus) { focus.setAttribute("tabindex", "-1"); focus.focus(); }
		})();
		// Until the report arrives, health events repaint the snapshot's checks box.
		mounted = { version, paint: (rows) => checksView(checksBox, rows, names) };
		return h;
	} });
}
