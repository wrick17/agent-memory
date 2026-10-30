// The owner dashboard (section 15): Home, a profile page, Work and About you, from the owner API that exists today. About you is the one
// page that writes, through the owner's node actions and undo. Same shape as settings.ts: a server-rendered shell and one browser
// function served as /app.js. Other pages are listed as not built.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const DASHBOARD_HTML = (env: Env) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
nav a{margin-right:1rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:.4rem;text-align:left}
.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.card{border:1px solid #d0d7de;border-radius:8px;padding:0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem 1rem}dt{color:#57606a}dd{margin:0}.na{color:#57606a;font-style:italic}
a[aria-current]{font-weight:600}.prefs{list-style:none;padding:0}.prefs>li{border-top:1px solid #d0d7de;padding:.5rem 0}button{margin:0 .5rem .5rem 0}
:focus-visible{outline:2px solid #0969da;outline-offset:3px}input{max-width:100%;box-sizing:border-box}li,dd,p{overflow-wrap:anywhere}</style></head>
<body><nav aria-label="Dashboard"><a href="#/">Overview</a><a href="#/work">Work</a><a href="#/about">About you</a><a href="/settings">Settings</a></nav>
<main><h1>Agent Memory</h1>
<p id="status" role="status">Loading sign-in…</p><div id="signin"></div>
<div id="view" hidden></div>
<section id="planned" hidden aria-labelledby="planned-h"><h2 id="planned-h">Not built yet</h2>
<p>The map, entity pages, path finder, timeline, journals, activity with undo, archive and review pages arrive in phase 4. Backups and restore arrive in the final backup stage.</p></section></main>
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
	type Failure = Error & { code?: string; status?: number };
	const call = async (path: string, method = "GET") => {
		const res = await win.fetch(path, { method, headers: { authorization: `Bearer ${await clerk.session.getToken()}` } });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			const err: Failure = new Error(body.error?.message ?? (typeof body.error === "string" ? body.error : `HTTP ${res.status}`));
			Object.assign(err, { code: typeof body.error?.code === "string" ? body.error.code : undefined, status: res.status });
			throw err;
		}
		return body;
	};
	type Profile = { name: string; status: string; created_at: string };
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
		addEventListener(type: string, f: (event: { preventDefault(): void }) => void): void; disabled: boolean; hidden: boolean; value: string };
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
				["Last backup", "Backups are not built yet", true],
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
		el("p", view, "Entity pages, timeline, journals and activity for this profile are not built yet (phase 4).").setAttribute("class", "na");
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

	const render = (moveFocus: boolean) => {
		pageVersion++;
		const view = $("view");
		view.replaceChildren();
		shown = statusEl = undefined;
		const hash = win.location.hash ?? "";
		const m = /^#\/(profiles|about|work)\/([^/]+)$/.exec(hash);
		let name: string | undefined;
		try { name = m ? decodeURIComponent(m[2]!) : undefined; } catch { name = m?.[2]; }
		let h: Node;
		if (hash === "#/work" || m?.[1] === "work") {
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
			const p = name === undefined ? undefined : profiles.find((x) => x.name === name);
			if (name === undefined) h = home(view);
			else if (p) h = profilePage(view, p);
			else { h = el("h2", view, `No profile named ${name}`); link(el("p", view), "#/", "Back to the overview"); }
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
