// The owner dashboard (section 15): the knowledge graph at the root, profile pages, Work, About you, memories with detail and history, the map with unsaved
// what-if items, drafts saved only on an explicit click, activity with undo and the archive, and backups with recovery. Every page
// reads and writes through the owner API that exists. Same shape as settings.ts: a server-rendered shell and one browser function
// served as /app.js. Pages not built are listed as such.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const DASHBOARD_HTML = (env: Env) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1280px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
nav a{margin-right:1rem;display:inline-block}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:.4rem;text-align:left}
.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.card{border:1px solid #d0d7de;border-radius:8px;padding:0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem}dt{color:#57606a}dd{margin:0}.na{color:#57606a;font-style:italic}
a[aria-current]{font-weight:600}.prefs{list-style:none;padding:0}.prefs>li{border-top:1px solid #d0d7de;padding:.5rem 0}button{margin:0 .5rem .5rem 0}
:focus-visible{outline:2px solid #0969da;outline-offset:3px}input,select,textarea{max-width:100%;box-sizing:border-box;font:inherit}li,dd,p{overflow-wrap:anywhere}
.field{display:block;margin-top:.6rem}textarea{width:100%;min-height:8rem}.text{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:.6rem}
.warn{border-left:4px solid #9a6700;padding:.2rem .8rem;background:#fff8c5}.danger{border-left:4px solid #cf222e;padding:.2rem .8rem;background:#ffebe9}
.mapwrap{overflow:auto;border:1px solid #d0d7de;border-radius:8px;max-width:100%}.map{position:relative;width:640px;height:640px}
.map .node{position:absolute;transform:translate(-50%,-50%);margin:0;padding:.1rem .35rem;font-size:12px;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #57606a;border-radius:10px;background:#fff;color:#1b1f24}
.map .node[aria-pressed=true]{background:#0969da;color:#fff}.map .node.whatif{border-style:dashed;background:#fff8c5}
.map .edge{position:absolute;height:1px;background:#8c959f;transform-origin:0 0}.map .edge.whatif{background:none;border-top:1px dashed #9a6700}
.graph{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1.25rem;align-items:start}@media (max-width:900px){.graph{grid-template-columns:1fr}}
.graph-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1.5rem}.graph-head h2{margin:.25rem 0}.graph-tools{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem}
.graph canvas{display:block;width:100%;height:min(70vh,680px);border:1px solid #d0d7de;border-radius:10px;background:#fbfcfd;touch-action:none;cursor:grab}
.legend{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:13px}.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;vertical-align:-.05rem}
.graph aside{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto}.matches{list-style:none;padding:0;margin:0}.matches button{width:100%;text-align:left;margin:0 0 .25rem}
#signin:empty{display:none}</style></head>
<body><nav aria-label="Dashboard"><a href="#/">Graph</a><a href="#/memories">Memories</a><a href="#/draft">Write</a><a href="#/activity">Activity</a><a href="#/timeline">Timeline</a><a href="#/journals">Journals</a><a href="#/path">Paths</a><a href="#/work">Work</a><a href="#/about">About you</a><a href="#/review">Review</a><a href="#/backups">Backups</a><a href="#/profiles">Profiles</a><a href="/settings">Settings</a></nav>
<main><h1>Agent Memory</h1>
<p id="status" role="status">Loading sign-in…</p><div id="signin"></div>
<div id="view" hidden></div>
<section id="planned" hidden aria-labelledby="planned-h"><h2 id="planned-h">Not built yet</h2>
<p>The transfers and wipe pages are not built here. Recovery covers restore from an export only: point-in-time and corpus recovery are not built.</p></section></main>
<script defer crossorigin="anonymous" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${esc(env.CLERK_PUBLISHABLE_KEY)}" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/app.js"></script></body></html>`;

/**
 * The browser half, served as /app.js by serializing this function, so tests run the same code. It may use only its
 * parameter and browser globals. Sign-in follows settingsMain (ClerkJS 6 needs ClerkUI passed to load()). Every value
 * from the API or the URL reaches the page through textContent, never as markup.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export async function dashboardMain(win: any): Promise<void> {
	const doc = win.document;
	const $ = (id: string) => doc.getElementById(id);
	const status = (t: string) => { $("status").textContent = t; };
	if (doc.readyState !== "complete") await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
	const clerk = win.Clerk, ClerkUI = win.__internal_ClerkUICtor;
	if (!clerk || !ClerkUI) {
		status(`Sign-in could not start: ${clerk ? "the Clerk UI bundle" : "ClerkJS"} did not load. Check the network and the browser console for a blocked script.`);
		return;
	}
	try {
		await clerk.load({ ui: { ClerkUI }, telemetry: false });
	} catch (err) {
		status(`Sign-in could not start: ${(err as Error).message}`);
		return;
	}
	if (!clerk.user) {
		status("Sign in as the owner.");
		try { clerk.mountSignIn($("signin")); } catch (err) { status(`Sign-in could not start: ${(err as Error).message}`); }
		return;
	}
	type Failure = Error & { code?: string; status?: number; reason?: string };
	const call = async (path: string, method = "GET", data?: unknown) => {
		const headers: Record<string, string> = { authorization: `Bearer ${await clerk.session.getToken()}` };
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
	type Profile = { name: string; status: string; created_at: string; generation?: string };
	type Device = { name: string; kind: string; scopes: string[]; profiles: string[]; default_profile: string | null; enabled: boolean;
		expires_at: string | null; last_used_at: string | null; revoked_at: string | null };
	type Batch = { last_lease_at: string | null; last_status: { status: string; reason: string | null; at: string | null } | null };
	let profiles: Profile[], devices: Device[];
	status("Loading…");
	try {
		[profiles, devices] = await Promise.all([call("/api/profiles"), call("/api/devices")]);
	} catch (err) {
		status(`Could not load the dashboard: ${(err as Error).message}`);
		return;
	}
	// One profile's batch status failing to load marks only its own card.
	const batches = new Map<string, Batch | Error>(await Promise.all(profiles.map(async (p) =>
		[p.name, await call(`/api/profiles/${encodeURIComponent(p.name)}/batch`).catch((err: Error) => err)] as [string, Batch | Error])));

	type Node = { appendChild(n: unknown): void; replaceChildren(): void; textContent: string; setAttribute(k: string, v: string): void; focus(): void;
		addEventListener(type: string, f: (event: { preventDefault(): void }) => void): void; disabled: boolean; hidden: boolean; value: string; checked: boolean };
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
	const users = (p: string) => devices.filter((d) => d.profiles.includes(p));
	const batchRow = (p: string): [string, string, boolean?] => {
		const b = batches.get(p);
		if (!b || b instanceof Error) return ["Daily batch", `Unavailable${b ? `: ${b.message}` : ""}`, true];
		const s = b.last_status;
		const last = s ? `last ${s.status === "stuck" ? "parked" : "skipped"} ${day(s.at)} (${s.reason ?? "no reason"})` : "no skip or park recorded";
		return ["Daily batch", `Last lease ${day(b.last_lease_at)}; ${last}`];
	};

	const home = (view: Node) => {
		const h = el("h2", view, "Profiles");
		const cards = el("div", view);
		cards.setAttribute("class", "cards");
		for (const p of profiles) {
			const card = el("section", cards);
			card.setAttribute("class", "card");
			link(el("h3", card), `#/profiles/${encodeURIComponent(p.name)}`, p.name);
			const can = users(p.name), active = can.filter((d) => state(d) === "active");
			facts(card, [
				["Status", p.status],
				["Created", day(p.created_at)],
				["Active devices", String(active.length)],
				["Default for", `${can.filter((d) => d.default_profile === p.name).length} device(s)`],
				["Last use by its devices", day(can.map((d) => d.last_used_at ?? "").sort().pop() || null)],
				batchRow(p.name),
				["Projects, people, open work, decisions", "Not available yet: the server has no overview read", true],
				["Last backup", "See Backups", true],
			]);
		}
		if (!profiles.length) el("p", view, "No profiles yet.");
		return h;
	};

	const profilePage = (view: Node, p: Profile) => {
		const h = el("h2", view, `Profile: ${p.name}`);
		facts(view, [["Status", p.status], ["Created", day(p.created_at)]]);
		el("h3", view, "Devices that may use it");
		const can = users(p.name);
		if (can.length) {
			const table = el("table", view), head = el("tr", el("thead", table)), body = el("tbody", table);
			for (const c of ["Name", "Kind", "Scopes", "Default here", "Last used", "State"]) el("th", head, c).setAttribute("scope", "col");
			for (const d of can) {
				const tr = el("tr", body);
				[d.name, d.kind, d.scopes.join(", "), d.default_profile === p.name ? "yes" : "no", day(d.last_used_at), state(d)].forEach((t) => el("td", tr, t));
			}
		} else el("p", view, "No device may use this profile.");
		const more = el("p", view);
		link(more, "/settings", "Add or revoke devices in Settings");
		if (p.status === "active") link(el("p", view), `#/about/${encodeURIComponent(p.name)}`, "About you in this profile");
		if (p.status === "active") link(el("p", view), `#/work/${encodeURIComponent(p.name)}`, "Work in this profile");
		if (p.status === "active") for (const [r, t] of [["memories", "Memories"], ["map", "Map"], ["activity", "Activity and archive"], ["timeline", "Timeline"], ["journals", "Journals"], ["path", "Path finder"], ["review", "Review captured suggestions"], ["draft", "Write a memory"]]) link(el("p", view), `#/${r}/${encodeURIComponent(p.name)}`, `${t} in this profile`);
		return h;
	};

	// About you (sections 12 and 15): one active profile's preferences from the owner-model read, in the server's order, one
	// bounded page per click. Every action waits for the server, shows its answer, then reloads; nothing is retried by itself.
	type Pref = { id: string; name: string; description: string; origin: string; pinned: boolean; flagged: string | null; updated_at: string;
		source_profile: string | null; evidence: { kind: string; ref: string; note: string | null }[]; evidence_truncated: boolean; evidence_missing: boolean };
	const active = () => profiles.filter((p) => p.status === "active");
	let pageVersion = 0;
	type BoardRef = { id: string; readable?: false; kind?: string; name?: string };
	type Board = { as_of: string; items: { kind: string; name: string; key: string | null; priority: string | null; due: string | null;
		score: number; reasons: { term: string; points: number; text: string }[]; stale: boolean; last_activity_at: string;
		blocked_by: BoardRef[]; blocks: BoardRef[]; unrecognized: string[] }[]; total?: number; truncated?: boolean; without_state?: number;
		review?: { name: string; description: string; recorded_at: string; age_days: number } | null;
		budget?: { exhausted: boolean; skipped: number } };
	const recorded = (v: unknown) => v === null || v === undefined || v === "" ? "Not recorded" : String(v);
	const workPage = (view: Node, p: Profile) => {
		const version = pageVersion, h = el("h2", view, `Work: ${p.name}`), nav = el("nav", view);
		nav.setAttribute("aria-label", "Work profile");
		for (const q of active()) {
			const a = el("a", nav, q.name);
			a.setAttribute("href", `#/work/${encodeURIComponent(q.name)}`);
			if (q.name === p.name) a.setAttribute("aria-current", "page");
		}
		el("p", view, "Covers only what the owner's machines have uploaded. Item fields are their latest upload; as_of dates links, due dates and activity. This is not a historical snapshot of item fields.");
		const form = el("form", view), label = el("label", form, "As of (ISO date and time with Z for UTC or an explicit offset; blank uses server time)");
		label.setAttribute("for", "work-as-of");
		const date = el("input", form);
		date.setAttribute("id", "work-as-of");
		date.setAttribute("type", "text");
		date.setAttribute("placeholder", "2026-10-29T12:00:00Z");
		const submit = el("button", form, "Show board");
		submit.setAttribute("type", "submit");
		const msg = el("p", view);
		msg.setAttribute("role", "status");
		msg.setAttribute("aria-live", "polite");
		msg.setAttribute("tabindex", "-1");
		const result = el("section", view);
		result.setAttribute("aria-label", "Work board result");
		const more = el("button", view, "Show up to 200 items");
		more.setAttribute("type", "button");
		more.hidden = true;
		let request = 0, returnedDate = "";
		const invalidate = () => { request++; result.replaceChildren(); more.hidden = true; };
		date.addEventListener("input", () => { invalidate(); msg.textContent = "Date changed. Choose Show board to load it."; });
		const load = async (asOf: string, limit = 50, moveFocus = false) => {
			invalidate();
			const id = request;
			const current = () => version === pageVersion && id === request;
			msg.textContent = "Loading work board…";
			let board: Board;
			try {
				board = await call(`/api/profiles/${encodeURIComponent(p.name)}/board?limit=${limit}${asOf ? `&as_of=${encodeURIComponent(asOf)}` : ""}`);
				if (!Array.isArray(board?.items) || typeof board.as_of !== "string" || !board.as_of) throw new Error("missing board result");
			} catch (err) {
				if (!current()) return;
				const e = err as Failure;
				const reason = e.status === 401 || e.status === 403 || e.code === "forbidden" ? "Access was refused. Sign in as the owner."
					: e.status === 404 || e.code === "profile_wiped" ? "This profile is no longer available."
					: e.status === 409 || e.code === "busy" ? "The profile changed or is temporarily busy. Try again when it is ready."
					: e.status === 503 || e.code === "unavailable" ? "The service is temporarily unavailable. Try again later."
					: e.status === 400 ? "The request was refused. Check the ISO date and time, including its UTC offset."
					: "The board could not be read. Try again when the service is ready.";
				msg.textContent = `Could not load work board. ${reason}`;
				if (moveFocus) msg.focus();
				return;
			}
			if (!current()) return;
			returnedDate = board.as_of;
			el("h3", result, `As of ${returnedDate}`);
			const limited = board.truncated === true, partial = board.budget?.exhausted === true;
			msg.textContent = `Showing ${board.items.length} ranked open items${typeof board.total === "number" ? ` of ${board.total} evaluated` : "; evaluated count unavailable"}.`;
			if (!board.items.length) el("p", result, partial ? "No open items in the part read." : "No open items in the uploaded data read for this date.");
			if (limited) el("p", result, "The display limit hides some evaluated items.");
			if (partial) el("p", result, `This board is incomplete: some items or connections could not be evaluated within this read.${typeof board.budget?.skipped === "number" && board.budget.skipped > 0 ? ` ${board.budget.skipped} items were skipped.` : ""} Scores and order may change with more data.`);
			if (typeof board.budget?.exhausted !== "boolean") el("p", result, "Read completeness was not reported.");
			el("p", result, typeof board.without_state === "number" ? `${board.without_state} uploaded items have no recognized open or closed state and are excluded.` : "The count of items without a recognized state is unavailable.");
			const list = el("ol", result);
			list.setAttribute("aria-label", "Ranked open work");
			for (const it of board.items) {
				const li = el("li", list);
				el("h4", li, recorded(it.name));
				facts(li, [["Kind", recorded(it.kind)], ["Key", recorded(it.key)], ["Priority", recorded(it.priority)], ["Due", recorded(it.due)],
					["Score", recorded(it.score)], ["Stale", it.stale === true ? "Yes" : it.stale === false ? "No" : "Not recorded"], ["Last activity", recorded(it.last_activity_at)]]);
				const details = el("details", li);
				el("summary", details, "Score reasons");
				const reasons = el("ul", details);
				for (const r of it.reasons ?? []) if (r.points !== 0) el("li", reasons, `${recorded(r.term)}: ${recorded(r.points)} points. ${recorded(r.text)}`);
				if (!it.reasons?.length) el("p", details, "No score reasons reported.");
				for (const [title, refs] of [["Blocked by", it.blocked_by], ["Blocks", it.blocks]] as const) {
					el("p", li, title);
					if (!refs) el("p", li, "Not reported");
					else if (!refs.length) el("p", li, "None reported");
					else for (const ref of refs) el("p", li, ref.readable === false ? `Unreadable item: ${recorded(ref.id)}` : `${recorded(ref.kind)}: ${recorded(ref.name)} (${recorded(ref.id)})`);
				}
				if (it.unrecognized?.length) el("p", li, `Unrecognized fields: ${it.unrecognized.join(", ")}. The server used its fallback for scoring.`);
			}
			el("h3", result, "Latest strategic review");
			if (board.review) {
				el("h4", result, recorded(board.review.name));
				el("p", result, recorded(board.review.description));
				facts(result, [["Recorded", recorded(board.review.recorded_at)], ["Age at as of", typeof board.review.age_days === "number" ? `${board.review.age_days} days` : "Not recorded"]]);
			} else el("p", result, board.review === null ? "No strategic review recorded for this date." : "Strategic review information was not reported.");
			more.hidden = !limited || limit === 200;
			if (moveFocus) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(date.value.trim(), 50, true); });
		more.addEventListener("click", () => load(returnedDate, 200, true));
		load("");
		return h;
	};
	const busy = new Set<string>(); // profiles with an action in flight; their buttons stay disabled until it answers
	const notes = new Map<string, { text: string; undo: number | null }>(); // each profile's last outcome and its undo, kept across navigation
	let shown: string | undefined; // the profile whose About you page is on screen
	let statusEl: Node | undefined;

	const aboutPage = (view: Node, p: Profile) => {
		shown = p.name;
		const base = `/api/profiles/${encodeURIComponent(p.name)}`;
		const h = el("h2", view, `About you: ${p.name}`);
		const nav = el("nav", view);
		nav.setAttribute("aria-label", "Profile");
		for (const q of active()) {
			const a = el("a", nav, q.name);
			a.setAttribute("href", `#/about/${encodeURIComponent(q.name)}`);
			if (q.name === p.name) a.setAttribute("aria-current", "page");
		}
		el("p", view, "Preferences you stated come first, then ones agents inferred, with their evidence. Pin protects one from background cleanup; Forget moves it to the archive, and Undo brings it back.");
		const msg = statusEl = el("p", view);
		msg.setAttribute("role", "status");
		msg.setAttribute("tabindex", "-1");
		const note = notes.get(p.name);
		const buttons: Node[] = [];
		const button = (parent: Node, text: string, label: string | null, onClick: () => void) => {
			const b = el("button", parent, text);
			b.setAttribute("type", "button");
			if (label) b.setAttribute("aria-label", label);
			b.disabled = busy.has(p.name);
			b.addEventListener("click", onClick);
			buttons.push(b);
			return b;
		};
		const act = async (path: string, what: string, done: (r: Record<string, unknown>) => { text: string; undo: number | null }) => {
			if (busy.has(p.name)) return;
			busy.add(p.name);
			for (const b of buttons) b.disabled = true;
			msg.textContent = `Working: ${what}…`;
			let out: { text: string; undo: number | null };
			try {
				out = done(await call(path, "POST"));
			} catch (err) {
				const e = err as Failure;
				out = { text: `Could not ${what}: ${e.status === 409 ? "it changed since; review it by hand" : e.message}${e.code ? ` (${e.code})` : ""}.`, undo: notes.get(p.name)?.undo ?? null };
			}
			busy.delete(p.name);
			notes.set(p.name, out);
			if (shown === p.name) { render(false); statusEl?.focus(); }
		};
		const undoBox = el("p", view);
		if (note?.undo) {
			const id = note.undo;
			button(undoBox, "Undo last change", null, () => act(`${base}/activity/${encodeURIComponent(String(id))}/undo`, "undo the last change",
				() => ({ text: "Undone.", undo: null })));
		}
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Preferences");
		const item = (it: Pref) => {
			const li = el("li", list), name = String(it.name || "(no name)");
			el("h3", li, name);
			if (it.description) el("p", li, String(it.description));
			facts(li, [
				["Origin", it.origin === "stated" ? "Stated" : it.origin === "inferred" ? "Inferred" : `Recorded as ${String(it.origin)}, not stated`],
				["Pinned", it.pinned ? "yes" : "no"],
				["Flagged", it.flagged ? String(it.flagged) : "no"],
				["Source profile", it.source_profile ? String(it.source_profile) : "this profile"],
				["Updated", day(it.updated_at)],
			]);
			const ev = Array.isArray(it.evidence) ? it.evidence : [];
			if (ev.length) {
				el("p", li, "Evidence:");
				const ul = el("ul", li);
				for (const e of ev) el("li", ul, `${String(e.kind)}: ${String(e.ref)}${e.note ? ` (${String(e.note)})` : ""}`);
			}
			if (it.evidence_missing) el("p", li, "No evidence is recorded for this inferred preference.").setAttribute("class", "na");
			else if (!ev.length) el("p", li, "No evidence pointers.").setAttribute("class", "na");
			if (it.evidence_truncated) el("p", li, `Showing the first ${ev.length} evidence pointers; more exist.`).setAttribute("class", "na");
			const row = el("p", li), node = `${base}/nodes/${encodeURIComponent(it.id)}`;
			const done = (r: Record<string, unknown>, extra = "") => ({ text: `Done: ${String(r.action)} “${name}”.${extra}`,
				undo: Number.isSafeInteger(r.activity_id) && (r.activity_id as number) > 0 ? r.activity_id as number : null });
			const actions = (): Node => {
				row.replaceChildren();
				const verb = it.pinned ? "unpin" : "pin";
				button(row, it.pinned ? "Unpin" : "Pin", `${it.pinned ? "Unpin" : "Pin"} ${name}`, () => act(`${node}/${verb}`, `${verb} “${name}”`, (r) => done(r)));
				if (it.flagged) button(row, "Unflag", `Unflag ${name}`, () => act(`${node}/unflag`, `unflag “${name}”`, (r) => done(r)));
				const forget = button(row, "Forget", `Forget ${name}`, () => {
					row.replaceChildren();
					const ask = el("span", row, `Forget “${name}”? It moves to the archive and leaves this list; Undo brings it back. `);
					ask.setAttribute("tabindex", "-1");
					button(row, "Forget it", `Forget ${name} now`, () => act(`${node}/forget`, `forget “${name}”`, (r) => done(r, " It is in the archive; Undo brings it back.")));
					button(row, "Cancel", null, () => actions().focus());
					ask.focus();
				});
				return forget;
			};
			actions();
		};
		const more = el("button", view, "Load more");
		more.setAttribute("type", "button");
		more.hidden = true;
		let after: string | null = null, count = 0;
		// Every render builds new elements, so a late page only fills nodes that have left the screen.
		const load = async () => {
			more.disabled = true;
			msg.textContent = [note?.text, after ? "Loading more preferences…" : "Loading preferences…"].filter(Boolean).join(" ");
			let page: { items: Pref[]; next_after: string | null };
			try {
				page = await call(`${base}/owner-model?limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`);
				if (!Array.isArray(page?.items)) throw new Error("the server sent no preference list");
			} catch (err) {
				msg.textContent = [note?.text, `Could not load preferences: ${(err as Error).message}`].filter(Boolean).join(" ");
				more.textContent = "Try again";
				more.hidden = more.disabled = false;
				return;
			}
			for (const it of page.items) item(it);
			count += page.items.length;
			after = typeof page.next_after === "string" ? page.next_after : null;
			more.textContent = "Load more";
			more.hidden = !after;
			more.disabled = false;
			msg.textContent = [note?.text, count ? `Showing ${count} preference${count === 1 ? "" : "s"}${after ? "; more are available" : ""}.`
				: "No active preferences in this profile yet."].filter(Boolean).join(" ");
			if (more.hidden && count > page.items.length) msg.focus(); // the pressed Load more just hid; keep focus on the page
		};
		more.addEventListener("click", load);
		load();
		return h;
	};

	// The pages below share one shape: a status line, every read guarded against navigation, and every write only on a click,
	// shown as the server answered. A write's outcome (and its Undo) stays with its page across navigation.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the owner API, checked where it is used
	type J = any;
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
	let pageButtons: Node[] = [], pageMsg: Node | undefined;
	const btn = (parent: Node, text: string, onClick: () => void, label?: string) => {
		const b = el("button", parent, text);
		b.setAttribute("type", "button");
		if (label) b.setAttribute("aria-label", label);
		b.addEventListener("click", onClick);
		pageButtons.push(b);
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
		const route = win.location.hash, version = pageVersion;
		for (const b of pageButtons) b.disabled = true;
		if (pageMsg) pageMsg.textContent = `Working: ${what}…`;
		let out: { text: string; undo?: string };
		try { out = done(await (typeof path === "string" ? call(path, "POST", data) : path())); } catch (err) { out = { text: `Could not ${what}: ${why(err)}.` }; }
		acting = false;
		outcomes.set(route, out);
		if (version === pageVersion) { render(false); pageMsg?.focus(); }
	};
	const undoOf = (profile: string, r: J) => Number.isSafeInteger(r?.activity_id) && r.activity_id > 0 ? `/api/profiles/${enc(profile)}/activity/${r.activity_id}/undo` : undefined;
	/** The page's status line, showing the last outcome on this page and its Undo. */
	const pageStatus = (view: Node) => {
		const msg = pageMsg = live(view);
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

	// Memories: the profile's records in stored order (empty search) or ranked by a search, through the recall tool's own read.
	const memoriesPage = (view: Node, p: Profile) => {
		const version = pageVersion, h = el("h2", view, `Memories: ${p.name}`);
		switcher(view, "memories", p.name);
		const form = el("form", view);
		const q = input(form, "mem-q", "Search (blank lists every record in stored order)");
		q.setAttribute("type", "search");
		const type = choose(form, "mem-type", "Type", [["all", "All types"], ["feedback", "Feedback"], ["project", "Project"], ["reference", "Reference"], ["user", "User"], ["procedural", "Procedural"]]);
		el("button", el("p", form), "Search").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Memories");
		const more = btn(view, "Load more", () => load(true));
		more.hidden = true;
		let cursor: string | null = null, shown = 0, request = 0;
		const load = async (next = false) => {
			const id = ++request, keyword = q.value.trim();
			if (!next) { list.replaceChildren(); shown = 0; cursor = null; }
			more.hidden = true;
			say(keyword ? "Searching…" : "Loading memories…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/recall`, "POST", { limit: 25, ...(keyword ? { keyword } : {}), ...(type.value !== "all" ? { type: type.value } : {}), ...(next && cursor ? { cursor } : {}) });
				if (!Array.isArray(r?.results)) throw new Error("the server sent no result list");
			} catch (err) {
				if (version === pageVersion && id === request) { say(`Could not load memories: ${why(err)}`); more.textContent = "Try again"; more.hidden = !next; }
				return;
			}
			if (version !== pageVersion || id !== request) return;
			for (const it of r.results) {
				const li = el("li", list);
				link(el("h3", li), `#/memory/${enc(String(it.profile))}/${enc(String(it.memory_id))}`, String(it.name ?? "(no name)"));
				facts(li, [["Type", recorded(it.type ?? it.kind)], ["Scope", recorded(it.scope)], ["Profile", recorded(it.profile)], ["Status", recorded(it.status)], ["Updated", day(it.freshness?.updated_at ?? null)]]);
				if (it.passage) el("p", li, String(it.passage));
			}
			shown += r.results.length;
			cursor = typeof r.next_cursor === "string" ? r.next_cursor : null;
			more.textContent = "Load more";
			more.hidden = !cursor;
			const limits = [keyword && r.truncated ? "More matches exist than shown; narrow the search." : "", keyword && r.lexical_only ? "Matched by words only; related wording may be missed." : ""].filter(Boolean).join(" ");
			say(`${shown ? `Showing ${shown} record${shown === 1 ? "" : "s"}${cursor ? "; more are available" : ""}.` : keyword ? "No records match." : "No records in this profile yet."} ${limits}`.trim());
			if (next && more.hidden) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();
		return h;
	};

	// One record: fields, text, evidence, links and revision history from the entity read; pin, forget and edit as a draft.
	const memoryPage = (view: Node, p: Profile, id: string) => {
		const version = pageVersion, base = `/api/profiles/${enc(p.name)}/nodes/${enc(id)}`;
		const h = el("h2", view, "Memory");
		link(el("p", view), `#/memories/${enc(p.name)}`, `Back to memories in ${p.name}`);
		const { say } = pageStatus(view);
		const body = el("div", view);
		say("Loading…");
		(async () => {
			let r: J;
			try {
				r = await call(base);
				if (!r?.node) throw new Error("the server sent no record");
			} catch (err) {
				if (version === pageVersion) say(`Could not load this record: ${why(err)}`);
				return;
			}
			if (version !== pageVersion) return;
			const n = r.node, name = String(n.name ?? "(no name)"), cut: string[] = Array.isArray(n.truncated) ? n.truncated : [];
			h.textContent = `Memory: ${name}`;
			say("");
			facts(body, [["Id", id], ["Kind", recorded(n.kind)], ["Type", recorded(n.memory_type)], ["Scope", recorded(n.scope)], ["Status", recorded(n.status)], ["Origin", recorded(n.origin)],
				["Revision", recorded(n.revision)], ["Created", recorded(n.created_at)], ["Updated", recorded(n.updated_at)], ["Pinned", n.pinned ? "yes" : "no"],
				["Flagged", n.flagged ? String(n.flagged) : "no"], ["Source profile", n.source_profile ? String(n.source_profile) : "this profile"]]);
			if (n.description) { el("h3", body, "Description"); textBlock(body, String(n.description)); if (cut.includes("description")) note(body, "The description is longer than shown."); }
			el("h3", body, "Content");
			const content = el("div", body);
			const c = r.content ?? {};
			if (c.text === null || c.text === undefined || c.text === "") note(content, "No content.");
			else textBlock(content, String(c.text));
			if (!c.complete && c.text) {
				note(body, `Showing the first ${String(c.text).length} of ${recorded(c.chars)} characters.`);
				let next: string | null = null;
				const full = btn(body, "Load the full content", async () => {
					full.disabled = true;
					try {
						const page: J = await call(`${base}?content=all${next ? `&cursor=${enc(next)}` : ""}`);
						if (version !== pageVersion) return;
						if (!next) content.replaceChildren();
						textBlock(content, String(page.content?.content ?? ""));
						next = typeof page.content?.cursor === "string" ? page.content.cursor : null;
						full.textContent = "Load the next part";
						full.hidden = !next;
					} catch (err) { if (version === pageVersion) say(`Could not load the content: ${why(err)}`); }
					full.disabled = false;
				});
			}
			const row = el("p", body), nodePath = (verb: string) => `${base}/${verb}`;
			const ownerDone = (r: J, extra = "") => ({ text: `Done: ${String(r.action)} “${name}”.${extra}`, undo: undoOf(p.name, r) });
			btn(row, n.pinned ? "Unpin" : "Pin", () => act(nodePath(n.pinned ? "unpin" : "pin"), `${n.pinned ? "unpin" : "pin"} “${name}”`, undefined, (r) => ownerDone(r)));
			const forget = btn(row, "Forget", () => {
				forget.hidden = true;
				const ask = el("span", row, `Forget “${name}”? It moves to the archive; Undo or the archive brings it back. `);
				ask.setAttribute("tabindex", "-1");
				btn(row, "Forget it", () => act(nodePath("forget"), `forget “${name}”`, undefined, (r) => ownerDone(r, " It is in the archive.")));
				ask.focus();
			});
			const editable = n.memory_type && n.memory_type !== "procedural" && n.kind !== "journal" && n.status === "active" && c.complete !== false && !cut.includes("description");
			if (editable) btn(row, "Edit as a draft", () => {
				drafts.set(p.name, { memory_id: id, expected_revision: Number(n.revision), name, type: String(n.memory_type), scope: n.scope ? String(n.scope) : "",
					description: String(n.description ?? ""), content: String(c.text ?? ""), target: "", targetName: "", reason: "" });
				win.location.hash = `#/draft/${enc(p.name)}`;
			});
			else note(body, "Editing here needs an active, non-procedural, non-journal memory with its whole text shown.");
			link(el("p", body), `#/map/${enc(p.name)}/${enc(id)}`, "Center the map here");
			link(el("p", body), `#/path/${enc(p.name)}/${enc(id)}`, "Find a path from here");
			link(el("p", body), `#/timeline/${enc(p.name)}/${enc(id)}`, "Timeline of this record");
			if (n.kind === "journal") link(el("p", body), `#/journals/${enc(p.name)}/${enc(id)}`, "Read as a journal");
			el("h3", body, "Evidence");
			const ev: J[] = r.evidence?.items ?? [];
			if (ev.length) { const ul = el("ul", body); for (const e of ev) el("li", ul, `${String(e.kind)}: ${String(e.ref)}${e.note ? ` (${String(e.note)})` : ""}`); } else note(body, "No evidence pointers.");
			if (r.evidence?.truncated) note(body, "More evidence exists than shown.");
			el("h3", body, "Links");
			const links: J[] = Array.isArray(r.links) ? r.links : [];
			if (links.length) {
				const ul = el("ul", body);
				for (const l of links) {
					const li = el("li", ul), o = l.other ?? {}, rel = `${String(l.rel)}${l.other_label ? ` (${String(l.other_label)})` : ""}`;
					el("span", li, `${l.direction === "in" ? "From" : "To"} `);
					if (o.readable) link(li, `#/memory/${enc(p.name)}/${enc(String(o.id))}`, `${String(o.kind)}: ${String(o.name)}`);
					else el("span", li, "a record not readable in this profile");
					el("span", li, ` — ${rel}${l.reason ? `: ${String(l.reason)}` : ""}`);
				}
			} else note(body, "No links.");
			if (r.budget?.exhausted) note(body, "Some links could not be read within this read's budget.");
			el("h3", body, "Revision history");
			const table = el("table", body), head = el("tr", el("thead", table)), rows = el("tbody", table);
			for (const t of ["Revision", "Change", "When", "By"]) el("th", head, t).setAttribute("scope", "col");
			const addRows = (items: J[]) => { for (const v of items) { const tr = el("tr", rows); [v.revision, v.op, v.at, v.actor].forEach((x) => el("td", tr, recorded(x))); } };
			addRows(r.history?.items ?? []);
			let before: number | null = r.history?.next_before ?? null;
			const older = btn(body, "Older revisions", async () => {
				older.disabled = true;
				try {
					const page: J = await call(`${base}?before=${before}`);
					if (version !== pageVersion) return;
					addRows(page.history?.items ?? []);
					before = page.history?.next_before ?? null;
				} catch (err) { if (version === pageVersion) say(`Could not load older revisions: ${why(err)}`); }
				older.disabled = false;
				older.hidden = before === null;
			});
			older.hidden = before === null;
			note(body, "History lists each stored change; earlier full texts are kept by the server but not shown here.");
		})();
		return h;
	};

	// The map: the server's bounded walk, laid out in rings by distance from where it starts. What-if items are drawn on it
	// and kept in this page only; nothing about them reaches the server until a draft is saved.
	// `preview` is the exact payload (with its request id) a Save sends; `sent` is the last one Save sent, kept until the server confirms it.
	type Draft = { memory_id?: string; expected_revision?: number; name: string; type: string; scope: string; description: string; content: string; target: string; targetName: string; reason: string;
		companyFree?: boolean; preview?: Record<string, unknown>; sent?: Record<string, unknown> };
	const drafts = new Map<string, Draft>();
	const whatIf = new Map<string, { name: string; target: string; targetName: string }[]>();
	const pendingOps = new Map<string, { id: string; cursor: string; label: string }>(); // staged archive restores not finished
	const SIZE = 640;
	const mapPage = (view: Node, p: Profile, center?: string) => {
		const version = pageVersion, h = el("h2", view, `Map: ${p.name}`);
		switcher(view, "map", p.name);
		const form = el("form", view);
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
			} catch (err) { if (version === pageVersion) say(`Could not load the map: ${why(err)}`); return; }
			if (version !== pageVersion) return;
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
			const edge = (a: [number, number], b: [number, number], cls: string) => {
				const e = el("div", canvas), len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
				e.setAttribute("class", cls);
				e.setAttribute("aria-hidden", "true");
				e.setAttribute("style", `left:${a[0].toFixed(1)}px;top:${a[1].toFixed(1)}px;width:${len.toFixed(1)}px;transform:rotate(${ang.toFixed(4)}rad)`);
			};
			for (const l of m.links) { const a = pos.get(l.from?.id), b = pos.get(l.to?.id); if (a && b && l.from.readable && l.to.readable) edge(a, b, "edge"); }
			const items = whatIf.get(p.name) ?? [];
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
					whatIf.set(p.name, [...(whatIf.get(p.name) ?? []), { name: wn.value.trim(), target: id, targetName: name }]);
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
				el("h3", out, "What-if items (not saved)");
				note(out, "These exist only on this page. Make a draft to review and save one; nothing changes on the server until you choose Save.");
				const wl = el("ul", out);
				items.forEach((w, i) => {
					const li = el("li", wl, `${w.name}, linked to “${w.targetName}”${pos.has(w.target) ? "" : " (its record is not on this map)"} `);
					btn(li, "Make a draft", () => {
						drafts.set(p.name, { name: w.name, type: "project", scope: "", description: "", content: "", target: w.target, targetName: w.targetName, reason: "" });
						win.location.hash = `#/draft/${enc(p.name)}`;
					}, `Make a draft from ${w.name}`);
					btn(li, "Remove", () => { items.splice(i, 1); load(); }, `Remove ${w.name}`);
				});
				btn(out, "Clear all what-if items", () => { whatIf.delete(p.name); load(); });
			}
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();
		return h;
	};

	// Write: a draft is previewed first and saved only by an explicit Save, through the save tool. The previewed payload and its
	// request id survive a failed or unanswered Save, so the owner's retry of the same body replays instead of writing twice; any
	// change to the draft needs a new preview, and a preview of a body already sent reuses that request id. Nothing retries by itself.
	const draftPage = (view: Node, p: Profile) => {
		const h = el("h2", view, `Write: ${p.name}`);
		switcher(view, "draft", p.name);
		const d = drafts.get(p.name) ?? { name: "", type: "project", scope: "", description: "", content: "", target: "", targetName: "", reason: "" };
		const editing = !!d.memory_id;
		if (editing) {
			el("p", view, `Editing “${d.name}” at revision ${d.expected_revision}. Saving makes a new revision; the earlier one stays in its history. A change by someone else since then is refused, not overwritten.`);
			link(el("p", view), `#/memory/${enc(p.name)}/${enc(d.memory_id!)}`, "Back to the record");
		} else el("p", view, "A new memory you state yourself. Nothing is saved until you preview it and choose Save.");
		const form = el("form", view);
		const name = input(form, "draft-name", "Name");
		name.setAttribute("maxlength", "512");
		name.value = d.name;
		if (editing) name.disabled = true;
		const type = choose(form, "draft-type", "Type", [["project", "Project"], ["feedback", "Feedback"], ["reference", "Reference"], ["user", "User"]]);
		type.value = d.type;
		if (editing) type.disabled = true;
		const scope = input(form, "draft-scope", "Scope (optional)");
		scope.setAttribute("maxlength", "128");
		scope.value = d.scope;
		if (editing) scope.disabled = true;
		const desc = input(form, "draft-desc", "Description (a short summary)", "textarea");
		desc.value = d.description;
		const content = input(form, "draft-content", "Content", "textarea");
		content.value = d.content;
		let reason: Node | undefined;
		if (d.target) {
			el("p", form, `Adds a “relates to” link to “${d.targetName || d.target}”, with that record as its evidence.`);
			reason = input(form, "draft-reason", "Why they relate (8 to 600 characters)", "textarea");
			reason.setAttribute("maxlength", "600");
			reason.value = d.reason;
		}
		let free: Node | undefined;
		if (p.name === "me") {
			const l = el("label", form);
			l.setAttribute("class", "field");
			free = el("input", l);
			free.setAttribute("type", "checkbox");
			free.checked = d.companyFree === true;
			el("span", l, " This holds no company or work details (required for me)");
		}
		const row = el("p", form);
		el("button", row, "Preview").setAttribute("type", "submit");
		const save = btn(row, "Save", () => commit());
		save.disabled = true;
		btn(row, "Discard draft", () => { drafts.delete(p.name); outcomes.delete(win.location.hash); render(false); });
		const { msg, say } = pageStatus(view);
		const preview = el("section", view);
		preview.setAttribute("aria-label", "Preview");
		let payload = d.preview;
		const keep = (extra: Partial<Draft>) => drafts.set(p.name, { ...(drafts.get(p.name) ?? d), name: name.value, type: type.value, scope: scope.value, description: desc.value,
			content: content.value, reason: reason?.value ?? "", companyFree: free?.checked === true, ...extra });
		const stale = () => { payload = undefined; save.disabled = true; preview.replaceChildren(); keep({ preview: undefined }); };
		for (const f of [name, type, scope, desc, content, reason, free]) f?.addEventListener("input", stale);
		free?.addEventListener("change", stale);
		const show = (x: Record<string, unknown>) => {
			el("h3", preview, "Preview (not saved)");
			const link0 = (x.links as { reason: string }[] | undefined)?.[0];
			facts(preview, [["Profile", p.name], ["Change", editing ? `New revision of “${d.name}” (now ${d.expected_revision})` : "A new memory"],
				...(editing ? [] : [["Name", String(x.name)], ["Type", String(x.type)], ["Scope", x.scope ? String(x.scope) : "none"], ["Origin", "Stated by you"]] as [string, string][]),
				["Link", link0 ? `relates to “${d.targetName || d.target}”` : "none"]]);
			el("h4", preview, "Description");
			textBlock(preview, String(x.description ?? "") || "(none)");
			el("h4", preview, "Content");
			textBlock(preview, String(x.content ?? "") || "(none)");
			save.disabled = false;
		};
		if (payload) show(payload);
		const body = (x?: Record<string, unknown>) => { if (!x) return undefined; const { request_id: _id, ...rest } = x; return JSON.stringify(rest); };
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			stale();
			const n = name.value.trim(), r = reason?.value.trim() ?? "";
			const problem = !editing && !n ? "Give the memory a name." : !desc.value.trim() ? "Write a short description."
				: d.target && (r.length < 8 || r.length > 600) ? "Say why they relate in 8 to 600 characters." : free && !free.checked ? "Saving to me needs the no-company-details confirmation." : "";
			if (problem) { say(problem); msg.focus(); return; }
			const next: Record<string, unknown> = {
				...(editing ? { memory_id: d.memory_id, expected_revision: d.expected_revision, description: desc.value, content: content.value }
					: { name: n, type: type.value, origin: "stated", description: desc.value, ...(scope.value.trim() ? { scope: scope.value.trim() } : {}), ...(content.value.trim() ? { content: content.value } : {}) }),
				...(d.target ? { links: [{ rel: "relates_to", to: { id: d.target }, reason: r, evidence: [{ kind: "node", ref: d.target }] }] } : {}),
				...(free ? { company_free: true } : {}),
			};
			const sent = drafts.get(p.name)?.sent;
			payload = { ...next, request_id: body(sent) === body({ ...next, request_id: "" }) ? sent!.request_id : `dashboard:${crypto.randomUUID()}` };
			keep({ preview: payload });
			show(payload);
			say("Preview ready. Nothing is saved yet; choose Save to write it.");
			save.focus();
		});
		const commit = () => {
			if (!payload) return;
			const sent = payload;
			keep({ sent });
			act(`/api/profiles/${enc(p.name)}/save`, editing ? `save “${d.name}”` : `save “${String(sent.name)}”`, sent, (r) => {
				drafts.delete(p.name);
				return { text: `Saved: ${String(r.action ?? "saved")} “${String(r.name ?? d.name)}”, revision ${recorded(r.revision)}. Open it from Memories.` };
			});
		};
		return h;
	};

	// Activity: the log with each change's undo state, and the archive with restore (staged removals restore in steps).
	const activityPage = (view: Node, p: Profile) => {
		const version = pageVersion, base = `/api/profiles/${enc(p.name)}`, h = el("h2", view, `Activity: ${p.name}`);
		switcher(view, "activity", p.name);
		const { say } = pageStatus(view);
		const log = el("ul", view);
		log.setAttribute("class", "prefs");
		log.setAttribute("aria-label", "Activity");
		const moreLog = btn(view, "Older activity", () => loadLog());
		moreLog.hidden = true;
		el("h3", view, "Archive");
		note(view, "Forgotten and cleaned-up records wait here until they purge. Restore brings one back as a new change you can undo.");
		const arch = el("ul", view);
		arch.setAttribute("class", "prefs");
		arch.setAttribute("aria-label", "Archive");
		const moreArch = btn(view, "Older removals", () => loadArch());
		moreArch.hidden = true;
		let before: number | null = null, archBefore: number | null = null;
		const loadLog = async () => {
			moreLog.disabled = true;
			let r: J;
			try { r = await call(`${base}/activity?limit=50${before ? `&before=${before}` : ""}`); if (!Array.isArray(r?.items)) throw new Error("the server sent no activity"); }
			catch (err) { if (version === pageVersion) { say(`Could not load activity: ${why(err)}`); moreLog.disabled = false; } return; }
			if (version !== pageVersion) return;
			for (const it of r.items) {
				const li = el("li", log);
				el("strong", li, `${recorded(it.op)} by ${recorded(it.actor)}`);
				el("span", li, ` · ${recorded(it.at)}`);
				el("p", li, recorded(it.summary));
				const undo = it.undo === "available" ? "can be undone" : it.undo === "undone" ? "undone" : it.undo === "redacted" ? "undo removed by a wipe" : "no undo";
				el("p", li, `${Array.isArray(it.targets) ? it.targets.length : 0} record(s); ${undo}.`).setAttribute("class", "na");
				if (it.undo === "available") btn(li, "Undo", () => act(`${base}/activity/${it.id}/undo`, `undo “${String(it.summary).slice(0, 80)}”`, undefined, () => ({ text: "Undone." })), `Undo ${String(it.summary).slice(0, 80)}`);
			}
			if (!r.items.length && !before) el("li", log, "No activity yet.");
			before = r.next_before ?? null;
			moreLog.hidden = before === null;
			moreLog.disabled = false;
		};
		const stepped = (label: string) => (r: J): { text: string; undo?: string } => {
			if (r.state === "running" || r.state === "rolling_back") {
				pendingOps.set(p.name, { id: String(r.operation_id), cursor: String(r.cursor), label });
				return { text: `Restoring “${label}” in steps: ${recorded(r.state)}, ${recorded(r.rows_done)} rows so far. Choose Continue to run the next step.` };
			}
			pendingOps.delete(p.name);
			return { text: `Restore of “${label}” ${recorded(r.state)}.`, ...(r.state === "complete" ? { undo: undoOf(p.name, r) } : {}) };
		};
		const op = pendingOps.get(p.name);
		if (op) {
			const row = el("p", view);
			el("span", row, `A staged restore of “${op.label}” is not finished. `);
			btn(row, "Continue", () => act(`${base}/archive/operations/${enc(op.id)}/resume`, `continue restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(op.label)));
			btn(row, "Abort it", () => act(`${base}/archive/operations/${enc(op.id)}/abort`, `abort restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(op.label)));
		}
		const loadArch = async () => {
			moreArch.disabled = true;
			let r: J;
			try { r = await call(`${base}/archive?limit=20${archBefore ? `&before=${archBefore}` : ""}`); if (!Array.isArray(r?.items)) throw new Error("the server sent no archive"); }
			catch (err) { if (version === pageVersion) { say(`Could not load the archive: ${why(err)}`); moreArch.disabled = false; } return; }
			if (version !== pageVersion) return;
			for (const it of r.items) {
				const li = el("li", arch), names = (it.nodes ?? []).map((n: J) => String(n.name || n.id)), label = names[0] ?? String(it.summary ?? "removal");
				el("strong", li, recorded(it.summary));
				facts(li, [["Removed", recorded(it.at)], ["By", recorded(it.actor)], ["Purges after", recorded(it.purge_after)], ["Records", names.join(", ") || "none listed"]]);
				// A removal made by a staged forget restores only through the staged route, in steps.
				if (it.restorable) btn(li, "Restore", () => act(() => call(`${base}/archive/restore`, "POST", { activity_id: it.activity_id }).catch((e: Failure) => e.reason !== "staged_required" ? Promise.reject(e)
					: call(`${base}/archive/operations`, "POST", { action: "restore", activity_id: it.activity_id, request_id: `dashboard:${crypto.randomUUID()}` })), `restore “${label}”`, undefined,
				(res) => res.operation_id ? stepped(label)(res) : { text: `Restored “${label}”.`, undo: undoOf(p.name, res) }), `Restore ${label}`);
				else note(li, it.reason === "undo_redacted" ? "Cannot be restored: a wipe removed what it needs." : "Cannot be restored: part of it has purged.");
			}
			if (!r.items.length && !archBefore) el("li", arch, "The archive is empty.");
			archBefore = r.next_before ?? null;
			moreArch.hidden = archBefore === null;
			moreArch.disabled = false;
		};
		say("");
		loadLog();
		loadArch();
		return h;
	};

	// Backups and recovery (section 18): exports, restore of one profile or of the account from an export, and the open
	// recovery's step, open and abort. The backup key stays on the server; this page only asks it to act.
	const backupsPage = (view: Node) => {
		const version = pageVersion, h = el("h2", view, "Backups and recovery");
		note(view, "Restore here uses the server's encrypted exports only. Point-in-time and corpus recovery are not built. Devices and routes stay in Settings.");
		link(el("p", view), "/settings", "Open Settings");
		const { say } = pageStatus(view);
		const rec = el("section", view);
		rec.setAttribute("aria-label", "Recovery status");
		const forms = el("div", view);
		const confirmBox = (parent: Node, prompt: string, expected: string, go: string, onGo: () => void) => {
			const typed = input(parent, `confirm-${go.replace(/\W+/g, "-").toLowerCase()}`, `${prompt} Type “${expected}” to confirm.`);
			typed.setAttribute("autocomplete", "off");
			const b = btn(el("p", parent), go, onGo);
			b.disabled = true;
			typed.addEventListener("input", () => { b.disabled = typed.value !== expected; });
			return typed;
		};
		const summary = (v: J) => typeof v === "string" ? v : v?.error ? `failed: ${recorded(v.error.message)}` : v && typeof v === "object" ? `saved${v.id ? ` (${String(v.id)})` : ""}${typeof v.rows === "number" ? `, ${v.rows} rows` : ""}` : recorded(v);
		const results = (parent: Node, r: J) => { const ul = el("ul", parent); for (const [k, v] of Object.entries(r ?? {})) el("li", ul, `${k}: ${summary(v)}`); };
		say("Loading recovery status…");
		(async () => {
			let s: J;
			try { s = await call("/api/recovery"); } catch (err) { if (version === pageVersion) say(`Could not read recovery status: ${why(err)}`); return; }
			if (version !== pageVersion) return;
			say("");
			const r = s?.recovery;
			if (r) {
				const account = r.kind === "account";
				el("h3", rec, `A recovery is open: the account is closed`);
				note(rec, account ? "Every profile and every device token is refused until this account restore is opened or aborted. Device tokens must be reissued in Settings afterwards."
					: `Every profile and device is refused until this restore of “${String(r.profile)}” is opened or aborted.`, "danger");
				facts(rec, [["Restoring", account ? "The account's own records" : `Profile ${String(r.profile)}`], ["From export", recorded(r.export)], ["Export taken", recorded(r.export_at)],
					["Started", recorded(r.at)], ["State", `${recorded(r.state)}${r.phase ? ` (${String(r.phase)})` : ""}`], ["Unresolved findings", recorded(r.unresolved_count)],
					...(r.restored ? [["Checked so far", `${recorded(r.restored.nodes)} records, ${recorded(r.restored.requests)} requests`]] as [string, string][] : [])]);
				if (Array.isArray(r.unresolved) && r.unresolved.length) {
					el("p", rec, "Unresolved findings (an unresolved restore can only be aborted):");
					const ul = el("ul", rec);
					for (const u of r.unresolved) el("li", ul, `${recorded(u.kind)}: ${recorded(u.id)}`);
					if (r.unresolved_count > r.unresolved.length) note(rec, `${r.unresolved_count - r.unresolved.length} more are not listed.`);
				}
				// Every action names the recovery shown here; the server refuses it if another recovery has replaced this one.
				const row = el("p", rec), shownId = { id: String(r.id) }, stepDone = (x: J) => ({ text: `Recovery is now ${recorded(x.state)}${x.phase ? ` (${String(x.phase)})` : ""}.` });
				if (r.state === "ready") note(rec, "Ready to open. Opening makes the restored copy current; for a profile, its previous copy is retired and changes made after the export are no longer current.", "warn");
				else if (r.state === "opening") note(rec, "Opening has started and cannot be aborted. Choose Open again to finish it.", "warn");
				else if (r.state !== "unresolved") btn(row, "Run the next step", () => act("/api/recovery/step", "run the next recovery step", shownId, stepDone));
				if (r.state === "ready" || r.state === "opening") btn(row, "Open", () => act("/api/recovery/open", "open the restored data", shownId, stepDone));
				if (r.state !== "opening") {
					const ab = el("div", rec);
					confirmBox(ab, account ? "Abort rolls the account back to its state before this restore, step by step; choose Abort again while it is rolling back." : "Abort discards the restored copy and reopens the account unchanged.", "abort", "Abort", () => act("/api/recovery/abort", "abort the recovery", shownId, stepDone));
				}
			} else {
				el("h3", rec, "No recovery is open");
				el("p", rec, "The account is open.");
			}
			el("h3", rec, "Last export");
			if (s?.last_export) { el("p", rec, `Taken ${recorded(s.last_export.at)}`); results(rec, s.last_export.results); } else el("p", rec, "No export recorded yet.");
			if (r) return; // exports and new restores are refused while a recovery is open
			el("h3", forms, "Export now");
			note(forms, "Exports are encrypted on the server. Two complete exports are kept per store, so a new one replaces the oldest. Each profile pauses its writes for up to 30 seconds while it is exported.");
			const exRow = el("p", forms);
			btn(exRow, "Export everything", () => act("/api/backups/export", "export everything", {}, (x) => ({ text: `Export finished: ${Object.entries(x ?? {}).map(([k, v]) => `${k} ${summary(v)}`).join("; ")}.` })));
			const exProfile = choose(forms, "export-profile", "Or export one profile", active().map((q) => [q.name, q.name]));
			btn(el("p", forms), "Export this profile", () => act("/api/backups/export", `export ${exProfile.value}`, { profile: exProfile.value }, (x) => ({ text: `Export finished: ${Object.entries(x ?? {}).map(([k, v]) => `${k} ${summary(v)}`).join("; ")}.` })));

			const restoreForm = (title: string, listPath: () => string, what: () => string, warning: string, expected: () => string, begin: (exp: string) => [string, unknown]) => {
				const sec = el("section", forms);
				el("h3", sec, title);
				note(sec, warning, "danger");
				const pick = el("div", sec);
				return { sec, pick, load: async () => {
					pick.replaceChildren();
					let list: J;
					try { list = await call(listPath()); if (!Array.isArray(list)) throw new Error("the server sent no export list"); } catch (err) { if (version === pageVersion) note(pick, `Could not list exports: ${why(err)}`); return; }
					if (version !== pageVersion) return;
					if (!list.length) { note(pick, `No exports of ${what()} yet.`); return; }
					const exp = choose(pick, `exp-${title.replace(/\W+/g, "-").toLowerCase()}`, "Export (newest first)", [...list].reverse().map((x: string) => [String(x), String(x)]));
					confirmBox(pick, `Restore ${what()} from the chosen export.`, expected(), `Begin restore of ${what()}`, () => {
						const [path, data] = begin(exp.value);
						act(path, `begin restoring ${what()}`, data, (x) => ({ text: `Recovery begun: ${recorded(x.state)}. The account is closed until you open or abort it below.` }));
					});
				} };
			};
			const rp = choose(forms, "restore-profile", "Profile to restore", active().map((q) => [q.name, q.name]));
			const prof = restoreForm("Restore a profile", () => `/api/profiles/${enc(rp.value)}/exports`, () => `profile ${rp.value}`,
				"Beginning closes the whole account: every profile and device is refused until you open or abort. The profile is rebuilt from the export into a new copy; opening it retires the current copy, so changes made after the export are no longer current. Aborting discards the rebuilt copy.",
				() => rp.value, (exp) => [`/api/profiles/${enc(rp.value)}/restore`, { export: exp }]);
			btn(el("p", prof.sec), "List this profile's exports", () => { prof.load(); });
			rp.addEventListener("change", () => prof.pick.replaceChildren());
			const acct = restoreForm("Restore the account", () => "/api/account/exports", () => "the account",
				"Beginning closes the account and disables every device token; reissue them in Settings afterwards. It replaces the account's own records (devices, routing and the profile list) with the export's; the memories inside profiles are restored separately, per profile.",
				() => "restore account", (exp) => ["/api/account/restore", { export: exp }]);
			btn(el("p", acct.sec), "List account exports", () => { acct.load(); });
		})();
		return h;
	};

	// Timeline, journals and the path finder (section 15): read-only views over the owner page reads, nothing written.
	const DAY_MS = 86_400_000, TIMELINE_DAYS = 90;
	/** One timeline event as text: its date, what happened, and a link to the record when the server named it. */
	const eventItem = (parent: Node, p: Profile, e: J) => {
		const li = el("li", parent), kind = String(e.event ?? ""), [cls, op] = kind.split(":");
		el("strong", li, recorded(e.at));
		el("span", li, ` · ${cls === "activity" ? `Change: ${op} by ${recorded(e.actor)}` : cls === "revision" ? `Revision ${recorded(e.revision)}: ${op} by ${recorded(e.actor)}`
			: kind === "entry" ? `Journal entry ${recorded(e.entry_seq)} by ${recorded(e.actor)}` : kind === "link_recorded" || kind === "link_ended"
			? `Link ${recorded(e.rel)} ${kind === "link_ended" ? "ended" : "recorded"}` : kind || "Event"}`);
		if (e.redacted) note(li, "Its summary was removed by a wipe.");
		else if (e.summary) el("p", li, String(e.summary));
		if (e.node_id && e.name) link(el("p", li), `#/memory/${enc(p.name)}/${enc(String(e.node_id))}`, `${recorded(e.kind)}: ${String(e.name)}`);
		if (kind.startsWith("link_")) note(li, `From ${recorded(e.src)} to ${recorded(e.dst)}`);
		if (Array.isArray(e.targets) && e.targets.length) note(li, `${e.targets.length} record(s) changed`);
	};

	// Timeline: one explicit window of at most 90 days, the profile's changes or one record's, oldest first. The server has no
	// cursor: a cut window says so, and only a narrower window or the 500-event limit shows more.
	const timelinePage = (view: Node, p: Profile, nodeId?: string) => {
		const version = pageVersion, h = el("h2", view, `Timeline: ${p.name}`);
		switcher(view, "timeline", p.name);
		if (nodeId) {
			el("p", view, "Showing one record's revisions, entries and links.");
			link(el("p", view), `#/memory/${enc(p.name)}/${enc(nodeId)}`, "Open the record");
			link(el("p", view), `#/timeline/${enc(p.name)}`, "Show the whole profile instead");
		}
		note(view, `A window of at most ${TIMELINE_DAYS} days, ISO dates with Z or an offset; a date alone means midnight UTC. To is not included.`);
		const form = el("form", view), now = Date.now();
		const from = input(form, "tl-from", "From");
		from.value = new Date(now - 7 * DAY_MS).toISOString();
		const to = input(form, "tl-to", "To");
		to.value = new Date(now).toISOString();
		el("button", el("p", form), "Show timeline").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const out = el("section", view);
		out.setAttribute("aria-label", "Timeline events");
		const more = btn(view, "Show up to 500 events", () => load(500, true));
		more.hidden = true;
		let request = 0;
		const invalidate = () => { request++; out.replaceChildren(); more.hidden = true; };
		for (const f of [from, to]) f.addEventListener("input", () => { invalidate(); say("Window changed. Choose Show timeline to load it."); });
		const load = async (limit = 100, moveFocus = false) => {
			invalidate();
			const id = request, f = from.value.trim(), t = to.value.trim(), a = Date.parse(f), b = Date.parse(t);
			if (Number.isNaN(a) || Number.isNaN(b) || a >= b || b - a > TIMELINE_DAYS * DAY_MS) { say(`Choose From before To, at most ${TIMELINE_DAYS} days apart, as ISO dates.`); msg.focus(); return; }
			say("Loading the timeline…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/timeline?from=${enc(f)}&to=${enc(t)}&limit=${limit}${nodeId ? `&node=${enc(nodeId)}` : ""}`);
				if (!Array.isArray(r?.events)) throw new Error("the server sent no events");
			} catch (err) {
				if (version === pageVersion && id === request) { say(`Could not load the timeline: ${why(err)}`); if (moveFocus) msg.focus(); }
				return;
			}
			if (version !== pageVersion || id !== request) return;
			if (nodeId && r.node?.name) h.textContent = `Timeline: ${String(r.node.name)}`;
			say(`${r.events.length} event${r.events.length === 1 ? "" : "s"} from ${f} to ${t}.`);
			if (r.truncated) note(out, nodeId ? "Some of this record's events in this window are not shown; narrow the window." : "Only the earliest events of this window are shown; narrow the window to see later ones.", "warn");
			if (!r.events.length) note(out, "No events in this window.");
			const list = el("ol", out);
			list.setAttribute("class", "prefs");
			for (const e of r.events) eventItem(list, p, e);
			more.hidden = r.truncated !== true || limit === 500;
			if (moveFocus) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(100, true); });
		load();
		return h;
	};

	// Journals: the profile's active journals, newest change first, and one journal's entries in order. Entries are agents' stored
	// text, shown only as text; the record page holds its revision history and the whole content.
	const journalsPage = (view: Node, p: Profile, jid?: string) => {
		const version = pageVersion, base = `/api/profiles/${enc(p.name)}/journals`;
		const h = el("h2", view, jid ? "Journal" : `Journals: ${p.name}`);
		if (jid) link(el("p", view), `#/journals/${enc(p.name)}`, `Back to journals in ${p.name}`);
		else switcher(view, "journals", p.name);
		note(view, "Journal text is stored as agents wrote it and is shown as plain text, never as instructions.");
		const { msg, say } = pageStatus(view);
		const out = el("div", view), list = el(jid ? "ol" : "ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", jid ? "Entries" : "Journals");
		const more = btn(view, jid ? "Later entries" : "Load more", () => load());
		more.hidden = true;
		let after: string | number | null = null, count = 0;
		const load = async () => {
			more.disabled = true;
			say(count ? "Loading more…" : "Loading…");
			let r: J;
			try {
				r = await call(jid ? `${base}?id=${enc(jid)}&limit=25${after !== null ? `&entries_after=${after}` : ""}` : `${base}?limit=50${after !== null ? `&after=${enc(String(after))}` : ""}`);
				if (!Array.isArray(jid ? r?.entries : r?.items)) throw new Error("the server sent no list");
			} catch (err) {
				if (version === pageVersion) { say(`Could not load: ${why(err)}`); more.textContent = "Try again"; more.hidden = more.disabled = false; }
				return;
			}
			if (version !== pageVersion) return;
			if (jid && after === null) {
				const j = r.journal ?? {};
				h.textContent = `Journal: ${String(j.name ?? "(no name)")}`;
				facts(out, [["Scope", recorded(j.scope)], ["Status", recorded(j.status)], ["Revision", recorded(j.revision)], ["Updated", recorded(j.updated_at)],
					["Compacted through entry", j.compacted_through ? String(j.compacted_through) : "none"]]);
				link(el("p", out), `#/memory/${enc(p.name)}/${enc(jid)}`, "Record page: revision history and whole content");
				link(el("p", out), `#/timeline/${enc(p.name)}/${enc(jid)}`, "Timeline of this journal");
				if (r.summary) {
					el("h3", out, "Summary of compacted entries");
					textBlock(out, String(r.summary.body ?? ""));
					if (r.summary.complete === false) note(out, "Only the summary's first part is shown; the record page has the whole text.");
				}
				if (Array.isArray(r.compactions) && r.compactions.length) {
					el("h3", out, "Compactions");
					const ul = el("ul", out);
					for (const c of r.compactions) el("li", ul, `Revision ${recorded(c.revision)} at ${recorded(c.at)} by ${recorded(c.actor)}: entries ${recorded(c.from_seq)} to ${recorded(c.through_seq)}`);
					if (r.compactions_more) note(out, "Older compactions are not listed.");
				}
				el("h3", out, "Entries");
			}
			for (const it of jid ? r.entries : r.items) {
				const li = el("li", list);
				if (jid) {
					el("strong", li, `Entry ${recorded(it.entry_seq)}`);
					el("span", li, ` · ${recorded(it.created_at)} · ${recorded(it.actor)}`);
					textBlock(li, String(it.body ?? ""));
					if (it.current === false) note(li, "Compacted into the summary.");
					if (it.complete === false) note(li, "Only this entry's first part is shown; the record page has the whole text.");
				} else {
					link(el("h3", li), `#/journals/${enc(p.name)}/${enc(String(it.id))}`, String(it.name ?? "(no name)"));
					facts(li, [["Scope", recorded(it.scope)], ["Updated", recorded(it.updated_at)], ["Latest entry", recorded(it.latest_entry_seq)],
						["Compacted through entry", it.compacted_through ? String(it.compacted_through) : "none"], ["Pinned", it.pinned ? "yes" : "no"]]);
					if (it.description) el("p", li, String(it.description));
				}
			}
			count += (jid ? r.entries : r.items).length;
			after = jid ? (typeof r.next_after === "number" ? r.next_after : null) : (typeof r.next_after === "string" ? r.next_after : null);
			more.textContent = jid ? "Later entries" : "Load more";
			more.hidden = after === null;
			more.disabled = false;
			const noun = jid ? (count === 1 ? "entry" : "entries") : count === 1 ? "journal" : "journals";
			say(count ? `Showing ${count} ${noun}${after !== null ? "; more are available" : ""}.` : jid ? "This journal has no entries." : "No active journals in this profile.");
			if (more.hidden && count > (jid ? r.entries : r.items).length) msg.focus();
		};
		load();
		return h;
	};

	// Path finder: up to 3 paths of at most 4 links between two records this profile shows, as the server searched them. Names
	// come only from its answer: a record in another profile shows as such, never looked up here.
	const endpointText = (e: J) => e?.name ? `${recorded(e.kind)}: ${String(e.name)}` : e?.readable === false ? "a record not readable here" : "a record in another profile, not read";
	const endpointView = (parent: Node, p: Profile, e: J) => {
		if (e?.name && (e.profile === undefined || e.profile === p.name)) link(parent, `#/memory/${enc(p.name)}/${enc(String(e.id))}`, endpointText(e));
		else el("span", parent, endpointText(e));
	};
	const pathPage = (view: Node, p: Profile, fromId?: string) => {
		const version = pageVersion, h = el("h2", view, `Path finder: ${p.name}`);
		switcher(view, "path", p.name);
		note(view, "Both records must be shown in this profile. Copy a record's id from its page, or open a record and choose “Find a path from here”.");
		const form = el("form", view);
		const from = input(form, "path-from", "From record id");
		from.setAttribute("maxlength", "128");
		from.value = fromId ?? "";
		const to = input(form, "path-to", "To record id");
		to.setAttribute("maxlength", "128");
		const depth = choose(form, "path-depth", "Longest path", [["4", "4 links"], ["3", "3 links"], ["2", "2 links"]]);
		el("button", el("p", form), "Find paths").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const out = el("section", view);
		out.setAttribute("aria-label", "Paths found");
		let request = 0;
		const invalidate = () => { request++; out.replaceChildren(); };
		for (const f of [from, to, depth]) f.addEventListener("input", invalidate);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			invalidate();
			const id = request, a = from.value.trim(), b = to.value.trim();
			if (!a || !b) { say("Enter both record ids."); msg.focus(); return; }
			say("Searching…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/path?from=${enc(a)}&to=${enc(b)}&max_depth=${depth.value}`);
				if (!Array.isArray(r?.paths)) throw new Error("the server sent no paths");
			} catch (err) {
				if (version === pageVersion && id === request) { say(`Could not find paths: ${why(err)}`); msg.focus(); }
				return;
			}
			if (version !== pageVersion || id !== request) return;
			const ends = el("p", out);
			el("span", ends, "From ");
			endpointView(ends, p, r.from);
			el("span", ends, " to ");
			endpointView(ends, p, r.to);
			if (r.budget?.exhausted) note(out, "The search stopped at its read budget; a longer or unread path may exist.", "warn");
			if (!r.paths.length) say(`No path of at most ${recorded(r.max_depth ?? depth.value)} links was found.`);
			else say(`${r.paths.length} path${r.paths.length === 1 ? "" : "s"} found.`);
			r.paths.forEach((path: J, i: number) => {
				el("h3", out, `Path ${i + 1}: ${recorded(path.length)} link${path.length === 1 ? "" : "s"}`);
				const ol = el("ol", out);
				for (const e of path.edges ?? []) {
					const li = el("li", ol);
					endpointView(li, p, e.from);
					el("span", li, ` — ${recorded(e.rel)}${e.other_label ? ` (${String(e.other_label)})` : ""} → `);
					endpointView(li, p, e.to);
					if (e.reason) el("p", li, String(e.reason));
				}
			});
			msg.focus();
		});
		return h;
	};

	// The knowledge graph (section 15), the dashboard's home: every record and link of one profile, drawn on one canvas from the
	// owner whole-graph read (metadata only, paged), so loaded and total counts are the server's. A selected record's detail is read
	// only when it is selected. Cached per profile generation; nothing here writes, and no link is drawn that the server did not send.
	type GNode = { id: string; name: string; kind: string; label: string | null; type: string | null; scope: string | null; status: string; updated: string | null;
		group: string; seq: number; x: number; y: number; deg: number; opaque: number };
	type GEdge = { id: string; a: string; b: string; rel: string };
	type Phase = { next: string | null; total: number | null; done: boolean; error: string | null };
	type Graph = { nodes: Map<string, GNode>; edges: Map<string, GEdge>; groups: Map<string, string[]>; pending: Map<string, GEdge[]>; opaque: number;
		parts: { nodes: Phase; edges: Phase }; loading: boolean; missing: boolean; changed: boolean; dirty: boolean; listener?: () => void };
	const graphs = new Map<string, Graph>();
	const GROUPS: [string, string][] = [["m:project", "Project memories"], ["m:feedback", "Feedback"], ["m:reference", "References"], ["m:user", "About the owner"],
		["m:procedural", "Procedures"], ["e:project", "Projects"], ["e:component", "Components"], ["e:person", "People"], ["e:ticket", "Tickets"], ["e:bug", "Bugs"],
		["e:feature", "Features"], ["e:pr", "Pull requests"], ["e:commit", "Commits"], ["e:release", "Releases"], ["e:decision", "Decisions"], ["e:other", "Other"]];
	const GROUP_NAME = new Map(GROUPS);
	// Three categorical hues (they stay apart for every pair, including colour-blind readers); each group's place and label name it too.
	const hueOf = (g: string) => g.startsWith("m:") ? "#2a78d6" : g === "e:person" ? "#1baf7a" : "#eb6834";
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
			updated: str(it.updated_at), group, seq: list.length, x: 0, y: 0, deg: 0, opaque: 0 });
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
		const version = pageVersion, g = graphOf(p);
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
		const tools = el("div", stage);
		tools.setAttribute("class", "graph-tools");
		const canvas: J = el("canvas", stage);
		canvas.setAttribute("tabindex", "0");
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", "Graph of this profile's records. Arrow keys pan, plus and minus zoom, 0 fits, Enter selects the first match. Use the search beside it to find records.");
		const legend = el("ul", stage);
		legend.setAttribute("class", "legend");
		legend.setAttribute("aria-label", "Groups; uncheck to hide");
		el("p", stage, "Dot size grows with links. A ring marks a record with links into another profile. Records with no links are drawn without lines; that is what the server holds.").setAttribute("class", "na");
		// Side panel: search and the selected record.
		const search = input(side, "graph-q", "Find records by name, type or scope");
		search.setAttribute("type", "search");
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
		const detail = el("section", side);
		detail.setAttribute("aria-label", "Selected record");

		const hidden = new Set<string>();
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
		// background: read once here and again only on a resize or a colour-scheme change, never per frame. Text takes the first
		// candidate reaching 4.5:1 against it; dots use the dark or light steps of the same three hues.
		type Theme = { id: string; bg: string; ink: string; muted: string; match: string; ring: string; edge: string; hues: string[] };
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
				match: pick(dark ? ["#d29922", "#e3b341"] : ["#9a6700", "#7d4e00"]), ring: dark ? "#e6edf3" : "#1b1f24", edge: dark ? "rgba(157,167,179,0.65)" : "rgba(87,96,106,0.65)",
				hues: dark ? ["#3987e5", "#d95926", "#199e70"] : ["#2a78d6", "#eb6834", "#1baf7a"] };
			const changed = next.id !== theme?.id;
			theme = next;
			return changed;
		};
		readTheme();
		const hueAt = (group: string) => (group.startsWith("m:") ? 0 : group === "e:person" ? 2 : 1);
		const shown = (n: GNode) => !hidden.has(n.group) && (n.status === "active" || showPast) && (!onlyLinked || n.deg > 0 || n.opaque > 0);
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
		// Dots are drawn as one native path per colour (three fills for the whole library), into a cached layer: a frame stamps that one
		// bitmap (a pan moves it, a wheel zoom in progress scales it) and the dots are drawn again only when the zoom settles, the layout
		// changes or the pixel ratio does. Zoomed in past the layer's size cap, the dots in view are drawn directly, the same way.
		const LAYER_PIXELS = 16_000_000, PAD = 12;
		const dots = (c: J, k: number, ox: number, oy: number, keep: (n: GNode) => boolean) => {
			let n = 0;
			const scale = Math.min(1.6, Math.max(0.6, Math.sqrt(k)));
			for (let hue = 0; hue < 3; hue++) {
				c.fillStyle = theme!.hues[hue];
				c.beginPath();
				for (const d of vis) {
					if (hueAt(d.group) !== hue || !keep(d)) continue;
					const x = d.x * k + ox, y = d.y * k + oy, r = radius(d) * scale;
					c.moveTo(x + r, y); c.arc(x, y, r, 0, 2 * Math.PI);
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
		const GROUP_FONT = "600 13px system-ui, sans-serif", NAME_FONT = "12px system-ui, sans-serif";
		const draw = () => {
			frame = false;
			if (version !== pageVersion) return;
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
			const t = theme!;
			ctx.strokeStyle = t.edge;
			ctx.beginPath();
			for (const e of g.edges.values()) {
				if (!e.b || !visIds.has(e.a) || !visIds.has(e.b)) continue;
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
			const emphasise = (n: GNode, ring: string) => {
				const x = n.x * k + ox, y = n.y * k + oy, r = radius(n) * scale;
				ctx.fillStyle = t.hues[hueAt(n.group)]!; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
				ctx.strokeStyle = ring; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 2, 0, 2 * Math.PI); ctx.stroke();
			};
			if (k > 0.6) { ctx.strokeStyle = t.muted; ctx.lineWidth = 1; ctx.beginPath(); for (const n of vis) if (n.opaque && inView(n)) { const x = n.x * k + ox, y = n.y * k + oy, r = radius(n) * scale + 3; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 2 * Math.PI); } ctx.stroke(); }
			for (const id of matchSet) { const n = g.nodes.get(id); if (n && visIds.has(id) && inView(n)) emphasise(n, t.match); }
			if (focus) for (const id of focus) { const n = g.nodes.get(id); if (n && visIds.has(id) && inView(n)) emphasise(n, id === selected ? t.ring : t.bg); }
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
			if (version !== pageVersion) { win.removeEventListener?.("resize", resized); scheme?.removeEventListener?.("change", resized); return; }
			const sized = measure(), themed = readTheme();
			if (sized || themed) schedule();
		};
		scheme?.addEventListener?.("change", resized);
		win.addEventListener("resize", resized);
		if (win.ResizeObserver) { const ro = new win.ResizeObserver(() => { if (version !== pageVersion) ro.disconnect(); else resized(); }); ro.observe(canvas); }

		const count = (n: number | null) => (n === null ? "?" : n.toLocaleString("en"));
		const refresh = () => {
			if (version !== pageVersion) return;
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
			legend.replaceChildren();
			for (const [group, name] of GROUPS) {
				const n = g.groups.get(group)?.length ?? 0;
				if (!n) continue;
				const li = el("li", legend), l = el("label", li), box = el("input", l), dot = el("span", l);
				box.setAttribute("type", "checkbox");
				box.checked = !hidden.has(group);
				box.addEventListener("change", () => { if (box.checked) hidden.delete(group); else hidden.add(group); g.dirty = true; fitted = false; runSearch(false); schedule(); });
				dot.setAttribute("class", "dot");
				dot.setAttribute("style", `background:${hueOf(group)}`);
				el("span", l, ` ${name} (${n.toLocaleString("en")})`);
			}
			runSearch(false);
			schedule();
		};
		const retry = btn(tools, "Retry loading", () => { for (const ph of Object.values(g.parts)) ph.error = null; pump(p, g); refresh(); });
		retry.hidden = true;
		// A fresh walk replaces the cached graph; the old walk's late pages are dropped.
		const reload = btn(tools, "Reload graph", () => { graphs.delete(`${p.name}:${p.generation ?? ""}`); render(false); });
		reload.hidden = true;
		btn(tools, "Zoom in", () => { moved = true; cam.k = Math.min(8, cam.k * 1.4); schedule(); });
		btn(tools, "Zoom out", () => { moved = true; cam.k = Math.max(0.03, cam.k / 1.4); schedule(); });
		btn(tools, "Fit", () => { moved = false; fit(); schedule(); });
		link(tools, `#/memories/${enc(p.name)}`, "List view");

		const runSearch = (announce: boolean) => {
			const q = query.trim().toLowerCase();
			matched = q ? [...g.nodes.values()].filter((n) => shown(n) && `${n.name} ${n.type ?? n.kind} ${n.scope ?? ""}`.toLowerCase().includes(q)) : [];
			matchSet = new Set(matched.map((n) => n.id));
			matches.replaceChildren();
			for (const n of matched.slice(0, 50)) btn(el("li", matches), n.name, () => select(n.id, true), `${n.name}, ${GROUP_NAME.get(n.group)}`);
			matchNote.textContent = !q ? "" : matched.length ? `${matched.length.toLocaleString("en")} match${matched.length === 1 ? "" : "es"}${matched.length > 50 ? "; the first 50 are listed" : ""}${g.parts.nodes.done ? "" : " among the records loaded so far"}.` : "No loaded record matches.";
			if (announce) schedule();
		};
		search.addEventListener("input", () => { query = search.value; runSearch(true); });
		search.addEventListener("keydown", (event: J) => { if (event.key === "Enter" && matched[0]) { event.preventDefault(); select(matched[0].id, true); } });
		linkedBox.addEventListener("change", () => { onlyLinked = linkedBox.checked; g.dirty = true; fitted = false; refresh(); });
		pastBox.addEventListener("change", () => { showPast = pastBox.checked; g.dirty = true; fitted = false; refresh(); });

		/** Selects a record without moving the graph, unless asked to bring it into view; its detail is read now, once per selection. */
		const select = (id: string | null, reveal = false) => {
			selected = id;
			const req = ++detailRequest;
			detail.replaceChildren();
			schedule();
			if (!id) return;
			const n = g.nodes.get(id);
			if (n && reveal) { moved = true; if (g.dirty) relayout(); cam.x = n.x; cam.y = n.y; cam.k = Math.max(cam.k, 1.4); }
			const title = el("h3", detail, n?.name ?? "Record");
			if (n) facts(detail, [["Group", GROUP_NAME.get(n.group) ?? n.kind], ["Kind", `${n.kind}${n.label ? ` (${n.label})` : ""}`], ["Scope", recorded(n.scope)], ["Status", n.status], ["Updated", recorded(n.updated)],
				["Links", `${n.deg}${n.opaque ? ` here, ${n.opaque} to other profiles` : ""}`]]);
			const neighbours = [...g.edges.values()].filter((e) => e.b && (e.a === id || e.b === id));
			if (neighbours.length) {
				const ul = el("ul", detail);
				ul.setAttribute("aria-label", "Linked records");
				for (const e of neighbours.slice(0, 30)) {
					const other = g.nodes.get(e.a === id ? e.b : e.a)!, li = el("li", ul);
					el("span", li, `${e.a === id ? "to" : "from"} · ${e.rel} · `);
					btn(li, other.name, () => select(other.id, true), `Select ${other.name}`);
				}
				if (neighbours.length > 30) note(detail, `${neighbours.length - 30} more links; open the record for all of them.`);
			} else if (n && g.parts.edges.done) note(detail, n.opaque ? "Its only links go to other profiles." : "No links: this record stands alone.");
			else if (n) note(detail, "Links are still loading.");
			const actions = el("p", detail);
			link(actions, `#/memory/${enc(p.name)}/${enc(id)}`, "Open the record");
			el("span", actions, " · ");
			link(actions, `#/timeline/${enc(p.name)}/${enc(id)}`, "Timeline");
			el("span", actions, " · ");
			link(actions, `#/path/${enc(p.name)}/${enc(id)}`, "Find a path");
			const more = el("div", detail);
			note(more, "Loading details…");
			(async () => {
				let r: J;
				try { r = await call(`/api/profiles/${enc(p.name)}/nodes/${enc(id)}`); } catch (err) { if (version === pageVersion && req === detailRequest) { more.replaceChildren(); note(more, `Could not load details: ${why(err)}`); } return; }
				if (version !== pageVersion || req !== detailRequest) return;
				more.replaceChildren();
				if (!n && r?.node?.name) title.textContent = String(r.node.name);
				if (r?.node?.description) { el("h4", more, "Description"); textBlock(more, String(r.node.description)); }
				const hist = Array.isArray(r?.history?.items) ? r.history.items : [];
				el("h4", more, "Recent history");
				if (hist.length) { const ul = el("ul", more); for (const v of hist.slice(0, 8)) el("li", ul, `Revision ${recorded(v.revision)} · ${recorded(v.op)} · ${recorded(v.at)} · ${recorded(v.actor)}`); }
				else note(more, "No history recorded.");
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
		if (selected) select(selected, true);
		pump(p, g);
		return h;
	};

	// Review (section 15): this profile's captured suggestions through review_candidates, list then an explicit promote or dismiss.
	// Captures are untrusted evidence, shown only as text. Each action's exact request (with its request id) is kept until the server
	// confirms it, so retrying an unchanged action after a lost answer replays instead of acting twice; a changed one gets a new id.
	const reviewSent = new Map<string, Record<string, unknown>>(); // `${profile}:${capture}:${action}` -> last request sent
	const reviewPage = (view: Node, p: Profile) => {
		const version = pageVersion, base = `/api/profiles/${enc(p.name)}/review`, h = el("h2", view, `Review: ${p.name}`);
		switcher(view, "review", p.name);
		note(view, "Captured suggestions are untrusted evidence from agents and capture hooks. Nothing is promoted unless you choose Promote; captures never go to me.");
		const unresolved = [...reviewSent].filter(([key]) => key.startsWith(`${p.name}:`));
		if (unresolved.length) {
			const receipts = el("section", view);
			el("h3", receipts, "Unconfirmed reviews");
			note(receipts, "Retry sends the original request and request ID, even if the suggestion has left this list.");
			for (const [key, sent] of unresolved) {
				const receipt = el("p", receipts, `Suggestion ${String(sent.candidate_id)}: `);
				btn(receipt, `Retry ${String(sent.action)}`, () => act(base, `retry ${String(sent.action)}`, sent, (r) => {
					reviewSent.delete(key);
					return { text: sent.action === "promote" ? `Promoted into memory “${String(r.name ?? r.memory_id)}”.` : "Dismissed captured suggestion.", undo: undoOf(p.name, r) };
				}), `Retry ${String(sent.action)} for captured suggestion ${String(sent.candidate_id)}`);
			}
		}
		const form = el("form", view);
		const status = choose(form, "review-status", "Status", [["pending", "Pending"], ["promoted", "Promoted"], ["dismissed", "Dismissed"], ["all", "All"]]);
		const limit = choose(form, "review-limit", "Show at most", [["20", "20"], ["50", "50"], ["100", "100"]]);
		el("button", el("p", form), "Show").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Captured suggestions");
		let request = 0;
		const send = (key: string, body: Record<string, unknown>) => {
			const prior = reviewSent.get(key), strip = (x?: Record<string, unknown>) => { if (!x) return ""; const { request_id: _id, ...rest } = x; return JSON.stringify(rest); };
			const sent = { ...body, request_id: strip(prior) === JSON.stringify(body) ? prior!.request_id : `dashboard:${crypto.randomUUID()}` };
			reviewSent.set(key, sent);
			return sent;
		};
		const item = (c: J) => {
			const li = el("li", list), id = String(c.capture_id), name = String(c.name ?? "(no name)");
			el("h3", li, name);
			facts(li, [["Kind", recorded(c.kind)], ["Status", recorded(c.status)], ["Captured", recorded(c.created_at)],
				...Object.entries(c.source && typeof c.source === "object" ? c.source : {}).map(([k, v]) => [`Source ${k}`, String(v)] as [string, string])]);
			textBlock(li, String(c.content ?? "") || "(no text)");
			if (c.promoted_to) { const row = el("p", li, "Promoted to "); link(row, `#/memory/${enc(p.name)}/${enc(String(c.promoted_to))}`, String(c.promoted_to)); }
			if (c.reason) el("p", li, `Reason: ${String(c.reason)}`);
			if (c.status !== "pending") return;
			const key = (action: string) => `${p.name}:${id}:${action}`;
			const promote = el("form", li);
			el("h4", promote, "Promote into a memory");
			const pname = input(promote, `promote-name-${id}`, "Name");
			pname.setAttribute("maxlength", "512");
			pname.value = name.slice(0, 512);
			const ptype = choose(promote, `promote-type-${id}`, "Type", [["project", "Project"], ["feedback", "Feedback"], ["reference", "Reference"], ["user", "User"]]);
			const pdesc = input(promote, `promote-desc-${id}`, "Description (optional)", "textarea");
			const prow = el("p", promote);
			el("button", prow, "Preview").setAttribute("type", "submit");
			const go = btn(prow, "Promote", () => {
				if (!pending) return;
				const body = send(key("promote"), pending);
				act(base, `promote “${name}”`, body, (r) => { reviewSent.delete(key("promote")); return { text: `Promoted “${name}” into memory “${String(r.name ?? pname.value)}”.`, undo: undoOf(p.name, r) }; });
			}, `Promote ${name}`);
			go.disabled = true;
			const shown = el("p", promote);
			let pending: Record<string, unknown> | undefined;
			const stale = () => { pending = undefined; go.disabled = true; shown.textContent = ""; };
			for (const f of [pname, ptype, pdesc]) f.addEventListener("input", stale);
			promote.addEventListener("submit", (event) => {
				event.preventDefault();
				stale();
				if (!pname.value.trim()) { say("Give the memory a name."); msg.focus(); return; }
				pending = { action: "promote", candidate_id: id, into: { name: pname.value.trim(), type: ptype.value, ...(pdesc.value.trim() ? { description: pdesc.value } : {}) } };
				shown.textContent = `Preview: a new ${ptype.value} memory “${pname.value.trim()}” in ${p.name} holding this capture's text, linked back to it. Nothing is saved until you choose Promote.`;
				go.disabled = false;
				go.focus();
			});
			const dismiss = el("form", li);
			el("h4", dismiss, "Dismiss");
			const reason = input(dismiss, `dismiss-reason-${id}`, "Reason (required)");
			reason.setAttribute("maxlength", "10000");
			el("button", el("p", dismiss), "Dismiss").setAttribute("type", "submit");
			dismiss.addEventListener("submit", (event) => {
				event.preventDefault();
				if (!reason.value.trim()) { say("Say why it is dismissed."); msg.focus(); return; }
				const body = send(key("dismiss"), { action: "dismiss", candidate_id: id, reason: reason.value.trim() });
				act(base, `dismiss “${name}”`, body, (r) => { reviewSent.delete(key("dismiss")); return { text: `Dismissed “${name}”.`, undo: undoOf(p.name, r) }; });
			});
		};
		const load = async () => {
			const id = ++request;
			list.replaceChildren();
			say("Loading…");
			let r: J;
			try {
				r = await call(base, "POST", { action: "list", status: status.value, limit: Number(limit.value) });
				if (!Array.isArray(r?.candidates)) throw new Error("the server sent no list");
			} catch (err) { if (version === pageVersion && id === request) say(`Could not load suggestions: ${why(err)}`); return; }
			if (version !== pageVersion || id !== request) return;
			for (const c of r.candidates) item(c);
			const n = r.candidates.length;
			say(n ? `Showing ${n} suggestion${n === 1 ? "" : "s"}${n === Number(limit.value) ? `; there may be more, show up to ${limit.value === "100" ? "100 (the most one read returns)" : "more"}` : ""}.`
				: `No ${status.value === "all" ? "" : `${status.value} `}suggestions. Suggestions appear only where capture is installed and running.`);
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();
		return h;
	};

	const render = (moveFocus: boolean) => {
		pageVersion++;
		pageButtons = [];
		pageMsg = undefined;
		const view = $("view");
		view.replaceChildren();
		shown = statusEl = undefined;
		const hash = win.location.hash ?? "";
		const m = /^#\/(profiles|about|work)\/([^/]+)$/.exec(hash);
		let name: string | undefined;
		try { name = m ? decodeURIComponent(m[2]!) : undefined; } catch { name = m?.[2]; }
		let h: Node;
		// The newer pages: the named active profile, or active work when none is named (asked for if work is not active); for a record, its id.
		const pg = /^#\/(graph|memories|memory|map|draft|activity|timeline|journals|path|review)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(hash);
		const dec = (s?: string) => { if (s === undefined) return undefined; try { return decodeURIComponent(s); } catch { return s; } };
		if (pg) {
			const named = dec(pg[2]), id = dec(pg[3]), ok = active();
			const p = ok.find((x) => x.name === (named ?? "work"));
			if (!p) {
				h = el("h2", view, named === undefined ? "Choose an active profile" : `No active profile named ${named}`);
				for (const q of ok) link(el("p", view), `#/${pg[1] === "memory" ? "memories" : pg[1]}/${enc(q.name)}`, q.name);
				if (!ok.length) el("p", view, "No active profiles available.");
			}
			else if (pg[1] === "memory") h = id === undefined ? memoriesPage(view, p) : memoryPage(view, p, id);
			else if (pg[1] === "memories") h = memoriesPage(view, p);
			else if (pg[1] === "graph") h = graphPage(view, p, id);
			else if (pg[1] === "map") h = mapPage(view, p, id);
			else if (pg[1] === "draft") h = draftPage(view, p);
			else if (pg[1] === "timeline") h = timelinePage(view, p, id);
			else if (pg[1] === "journals") h = journalsPage(view, p, id);
			else if (pg[1] === "path") h = pathPage(view, p, id);
			else if (pg[1] === "review") h = reviewPage(view, p);
			else h = activityPage(view, p);
		} else if (hash === "#/backups") h = backupsPage(view);
		else if (hash === "#/work" || m?.[1] === "work") {
			const ok = active(), p = name === undefined ? ok.find((x) => x.name === "work") : ok.find((x) => x.name === name);
			if (p) h = workPage(view, p);
			else {
				h = el("h2", view, name === undefined ? "Choose an active profile for Work" : `No active profile named ${name}`);
				for (const q of ok) link(el("p", view), `#/work/${encodeURIComponent(q.name)}`, q.name);
				if (!ok.length) el("p", view, "No active profiles available.");
			}
		} else if (hash === "#/about" || m?.[1] === "about") {
			// The page shows `me` unless a profile is named; only active profiles have an owner model to read.
			const ok = active(), p = name === undefined ? ok.find((x) => x.name === "me") ?? ok[0] : ok.find((x) => x.name === name);
			if (p) h = aboutPage(view, p);
			else { h = el("h2", view, name === undefined ? "No active profile yet" : `No active profile named ${name}`); link(el("p", view), "#/", "Back to the overview"); }
		} else {
			// The site root opens active work's graph (or asks for a profile); the profile cards are their own page.
			const p = name === undefined ? undefined : profiles.find((x) => x.name === name), work = active().find((x) => x.name === "work");
			if (name === undefined && hash === "#/profiles") h = home(view);
			else if (name === undefined && work) h = graphPage(view, work);
			else if (name === undefined) { h = el("h2", view, "Choose an active profile"); for (const q of active()) link(el("p", view), `#/graph/${enc(q.name)}`, q.name); link(el("p", view), "#/profiles", "Profiles"); }
			else if (p) h = profilePage(view, p);
			else { h = el("h2", view, `No profile named ${name}`); link(el("p", view), "#/profiles", "Back to the profiles"); }
		}
		if (moveFocus) { h.setAttribute("tabindex", "-1"); h.focus(); }
	};
	status("Signed in.");
	$("view").hidden = false;
	$("planned").hidden = false;
	render(false);
	win.addEventListener("hashchange", () => render(true));
}

// Wrangler bundles with esbuild keep_names, which wraps inner functions in __name(fn, "name"); the browser has no such helper.
export const DASHBOARD_JS = `"use strict";\nvar __name = (fn) => fn;\n(${dashboardMain.toString()})(window);\n`;
