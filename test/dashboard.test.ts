// The dashboard's browser half against a stand-in DOM and ClerkJS: what it fetches, what it shows, and what it refuses to invent.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_JS, dashboardMain } from "../src/dashboard";
import { call, contextFor } from "./helpers";

type El = { tag: string; textContent: string; value: string; hidden: boolean; disabled: boolean; checked: boolean; children: El[]; attrs: Record<string, string>; focused?: boolean;
	on: Record<string, (event?: { preventDefault(): void }) => unknown>; appendChild(c: El): void; replaceChildren(): void; setAttribute(k: string, v: string): void; focus(): void;
	addEventListener(type: string, f: () => unknown): void };
let active: El | undefined; // the stand-in document.activeElement
// A 2D context that draws nothing and records text: its font, place and width (7 px a character, as measureText reports here).
type Ctx = Record<string, unknown> & { arcs: number; fills: number; images: number; font: string; texts: { font: string; t: string; x: number; y: number; w: number }[] };
const context = (): Ctx => {
	const c: Ctx = { arcs: 0, fills: 0, images: 0, font: "", texts: [] };
	for (const f of ["setTransform", "clearRect", "beginPath", "moveTo", "lineTo", "stroke", "scale"]) c[f] = () => {};
	c.arc = () => { c.arcs++; };
	c.fill = () => { c.fills++; };
	c.drawImage = () => { c.images++; };
	c.measureText = (t: string) => ({ width: t.length * 7 });
	c.fillText = (t: string, x: number, y: number) => { c.texts.push({ font: c.font, t, x, y, w: t.length * 7 }); };
	return c;
};
const make = (tag: string, hidden = false): El => {
	const e: El = { tag, textContent: "", value: "", hidden, disabled: false, checked: false, children: [], attrs: {}, on: {},
		appendChild(c) { e.children.push(c); }, replaceChildren() { e.children = []; }, setAttribute(k, v) { e.attrs[k] = v; },
		focus() { e.focused = true; active = e; }, addEventListener(type, f) { e.on[type] = f; } };
	if (tag === "canvas") Object.assign(e, { clientWidth: 800, clientHeight: 560, ctx: context(), getContext(this: { ctx: Ctx }) { return this.ctx; } });
	return e;
};
const text = (e: El): string => [e.textContent, ...e.children.map(text)].filter(Boolean).join(" ");
const find = (e: El, tag: string): El[] => [...(e.tag === tag ? [e] : []), ...e.children.flatMap((c) => find(c, tag))];

const PROFILES = [{ name: "personal", generation: "aaaa", status: "active", created_at: "2026-10-28T10:00:00Z" },
	{ name: "work", generation: "bbbb", status: "active", created_at: "2026-10-28T11:00:00Z" }];
const DEVICES = [
	{ name: "laptop", kind: "token", scopes: ["read", "write"], profiles: ["personal", "work"], default_profile: "work", enabled: true, expires_at: null, last_used_at: "2026-10-29T08:00:00Z", revoked_at: null },
	{ name: "old-box", kind: "token", scopes: ["read"], profiles: ["work"], default_profile: null, enabled: true, expires_at: null, last_used_at: null, revoked_at: "2026-10-29T09:00:00Z" },
];
const BATCH = { last_lease_at: null, last_status: { status: "batch_skipped", reason: "probe_indeterminate", items: 0, at: "2026-10-29T07:00:00Z" } };

type Api = (path: string, method: string, body?: unknown) => Response | undefined | Promise<Response | undefined>;
function browser(o: { signedIn?: boolean; hash?: string; fail?: number; profiles?: unknown[]; api?: Api } = {}) {
	const els: Record<string, El> = {};
	const listeners: Record<string, () => void> = {};
	const seen: { fetched: string[]; auth: string[]; posted: string[]; bodies: unknown[]; mounted?: unknown } = { fetched: [], auth: [], posted: [], bodies: [] };
	const clerk = {
		user: o.signedIn ? { id: env.OWNER_USER_ID } : null,
		session: { getToken: async () => "session-token" },
		async load() {},
		mountSignIn(target: unknown) { seen.mounted = target; },
	};
	const win = {
		document: { readyState: "complete", getElementById: (id: string) => (els[id] ??= make("div", true)), createElement: (tag: string) => make(tag) },
		location: { hash: o.hash ?? "" },
		addEventListener(type: string, f: () => void) { listeners[type] = f; },
		fetch: async (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
			seen.fetched.push(path);
			seen.auth.push(init.headers.authorization!);
			const body = init.body === undefined ? undefined : JSON.parse(init.body) as unknown;
			if (init.method === "POST") { seen.posted.push(path); seen.bodies.push(body); }
			if (o.fail) return Response.json({ error: "forbidden" }, { status: o.fail });
			const r = await o.api?.(path, init.method ?? "GET", body);
			if (r) return r;
			if (path === "/api/profiles" && o.profiles) return Response.json(o.profiles);
			if (path === "/api/profiles/personal/batch") return Response.json({ error: { code: "unavailable", message: "profile store unreachable" } }, { status: 503 });
			if (path === "/api/profiles/work/batch") return Response.json(BATCH);
			return Response.json(path === "/api/profiles" ? PROFILES : DEVICES);
		},
		Clerk: clerk,
		__internal_ClerkUICtor: function ClerkUI() {},
	};
	const go = (hash: string) => { win.location.hash = hash; listeners.hashchange!(); };
	return { win, els, seen, listeners, go, view: () => els.view! };
}

// About you fixtures: owner-model items as the server sends them, and a gate to answer a request later.
const ABOUT_PROFILES = [{ name: "me", generation: "cccc", status: "active", created_at: "2026-10-28T09:00:00Z" }, ...PROFILES,
	{ name: "old", generation: "dddd", status: "wiped", created_at: "2026-10-28T12:00:00Z" }];
const pref = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Pref ${id}`, description: "", origin: "stated", pinned: false, flagged: null,
	revision: 1, updated_at: "2026-10-29T08:00:00Z", source_profile: null, links: 0, evidence: [], evidence_truncated: false, evidence_missing: false, ...extra });
const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };
const settle = () => new Promise((r) => setTimeout(r, 10));
const click = (e: El) => { if (!e.disabled) e.on.click!(); }; // a browser fires no click on a disabled button
const button = (root: El, label: string) => find(root, "button").find((b) => b.textContent === label)!;
const status = (b: ReturnType<typeof browser>) => find(b.view(), "p").find((p) => p.attrs.role === "status")!;
const BOARD_DATE = "2026-10-29T12:00:00.000Z";
const workItem = (name: string, extra: Record<string, unknown> = {}) => ({ kind: "ticket", name, key: null, priority: null, due: null,
	score: 16, reasons: [{ term: "priority", points: 16, text: "No recognized priority (+16)." }], stale: false, last_activity_at: BOARD_DATE,
	blocked_by: [], blocks: [], unrecognized: [], ...extra });
const workBoard = (extra: Record<string, unknown> = {}) => ({ as_of: BOARD_DATE, covers_only_uploaded_data: true,
	items: [], total: 0, truncated: false, without_state: 0, review: null, budget: { exhausted: false, skipped: 0 }, ...extra });
const submitDate = (b: ReturnType<typeof browser>, value: string) => {
	const input = find(b.view(), "input")[0]!;
	input.value = value;
	input.on.input!();
	find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
};

describe("dashboard", () => {
	it("mounts sign-in and fetches nothing until the owner signs in", async () => {
		const b = browser();
		await dashboardMain(b.win);
		expect(b.els.status!.textContent).toBe("Sign in as the owner.");
		expect(b.seen.mounted).toBe(b.els.signin);
		expect(b.seen.fetched).toEqual([]);
		expect(DASHBOARD_HTML(env)).toContain(`data-clerk-publishable-key="${env.CLERK_PUBLISHABLE_KEY}"`);
	});

	it("shows one card per profile from the real endpoints, and says which figures do not exist yet", async () => {
		const b = browser({ signedIn: true, hash: "#/profiles" });
		await dashboardMain(b.win);
		expect(b.seen.fetched.sort()).toEqual(["/api/devices", "/api/profiles", "/api/profiles/personal/batch", "/api/profiles/work/batch"]);
		expect(b.seen.auth).toEqual(Array(4).fill("Bearer session-token"));
		expect(b.els.status!.textContent).toBe("Signed in.");
		expect(b.view().hidden).toBe(false);
		const cards = find(b.view(), "section");
		expect(cards.map((c) => find(c, "a")[0]!.attrs.href)).toEqual(["#/profiles/personal", "#/profiles/work"]);
		// work: laptop is active and defaults to it; old-box is revoked, so it does not count as active.
		expect(text(cards[1]!)).toContain("Active devices 1 Default for 1 device(s) Last use by its devices 2026-10-29");
		expect(text(cards[1]!)).toContain("Not available yet");
		expect(text(cards[1]!)).toContain("See Backups");
		// The daily batch row shows the server's batch_status as text; a failed read marks only its own card.
		expect(text(cards[1]!)).toContain("Daily batch Last lease never; last skipped 2026-10-29 (probe_indeterminate)");
		expect(text(cards[0]!)).toContain("Daily batch Unavailable: profile store unreachable");
		expect(text(cards[1]!)).not.toContain("Unavailable");
	});

	it("drills into a profile, lists the devices that may use it, and moves focus on navigation", async () => {
		const b = browser({ signedIn: true, hash: "#/profiles/work" });
		await dashboardMain(b.win);
		const rows = find(b.view(), "tr").slice(1).map(text);
		expect(rows).toEqual(["laptop token read, write yes 2026-10-29 active", "old-box token read no never revoked"]);
		b.win.location.hash = "#/profiles/personal";
		b.listeners.hashchange!();
		expect(find(b.view(), "tr").slice(1).map(text)).toEqual(["laptop token read, write no 2026-10-29 active"]);
		expect(find(b.view(), "h2")[0]!.focused).toBe(true);
	});

	it("treats unknown, hostile or malformed profile names as text", async () => {
		const hostile = browser({ signedIn: true, hash: "#/profiles/%3Cimg%20src%3Dx%3E" });
		await dashboardMain(hostile.win);
		expect(find(hostile.view(), "h2")[0]!.textContent).toBe("No profile named <img src=x>");
		expect(find(hostile.view(), "img")).toEqual([]);
		const malformed = browser({ signedIn: true, hash: "#/profiles/%E0%A4%A" });
		await dashboardMain(malformed.win);
		expect(find(malformed.view(), "h2")[0]!.textContent).toBe("No profile named %E0%A4%A");
	});

	it("reports an API refusal instead of showing an empty dashboard", async () => {
		const b = browser({ signedIn: true, fail: 403 });
		await dashboardMain(b.win);
		expect(b.els.status!.textContent).toBe("Could not load the dashboard: forbidden");
		expect(b.els.view).toBeUndefined(); // never looked up, so never shown
	});
});

describe("dashboard Work", () => {
	it("renders the existing board result through the serialized served app", async () => {
		const ctx = await contextFor(), key = `jira:WORK-${Date.now()}`;
		await call(ctx, "record_knowledge", { profile: "work", nodes: [
			{ kind: "ticket", key, name: "Repair search", attrs: { state: "open", priority: "High", assignee_is_owner: true } },
		] });
		const board = await call(ctx, "work_board", { profile: "work", as_of: "2040-01-01T00:00:00.000Z" });
		const b = browser({ signedIn: true, hash: "#/work", api: (path) => path.includes("/board?") ? Response.json(board) : undefined });
		const response = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/app.js`));
		expect(response.status).toBe(200);
		const script = await response.text();
		new Function("window", script)(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Work: work");
		expect(text(b.view())).toContain("2040-01-01T00:00:00.000Z");
		expect(text(b.view())).toContain("Repair search");
		expect(text(b.view())).toContain("Priority High (+30).");
		expect(text(b.view())).toContain("Assigned to the owner (+15).");
		expect(b.seen.fetched.filter((p) => p.includes("/board"))).toEqual(["/api/profiles/work/board?limit=50"]);
	});

	it("keeps server order, reasons, exact dates, review and opaque refs as text, and expands only on a click", async () => {
		const hostile = "<img src=x onerror=alert(1)>", requests: string[] = [];
		const b = browser({ signedIn: true, hash: "#/work", profiles: ABOUT_PROFILES, api: (path) => {
			if (!path.includes("/board?")) return;
			requests.push(path);
			return Response.json(workBoard({ items: [workItem(hostile, { kind: "bug", key: "jira:KP-42", priority: "P1", due: "tomorrow", score: -4, stale: true,
				last_activity_at: "2026-09-01T08:09:10.111Z", unrecognized: ["priority", "due"],
				reasons: [{ term: "blocked", points: -20, text: hostile }, { term: "priority", points: 16, text: "Fallback" }],
				blocked_by: [{ id: "opaque/42", readable: false, name: "SECRET foreign name" }], blocks: [{ id: "n1", name: "Sibling", kind: "feature" }] }),
				workItem("Second despite larger score", { score: 999 })], total: 90, truncated: true, without_state: 3,
				budget: { exhausted: true, stopped: "candidates", skipped: 12 },
				review: { name: hostile, description: "javascript:alert(1)", recorded_at: "2026-10-01T00:12:34.000Z", age_days: 28 } }));
		} });
		await dashboardMain(b.win);
		await settle();
		const content = text(b.view());
		expect(find(b.view(), "h4").map((h) => h.textContent)).toEqual([hostile, "Second despite larger score", hostile]);
		expect(content).toContain("Score -4 Stale Yes Last activity 2026-09-01T08:09:10.111Z");
		expect(content).toContain(`blocked: -20 points. ${hostile}`);
		expect(content).toContain("Unreadable item: opaque/42");
		expect(content).not.toContain("SECRET foreign name");
		expect(content).toContain("feature: Sibling (n1)");
		expect(content).toContain("Unrecognized fields: priority, due");
		expect(content).toContain("Recorded 2026-10-01T00:12:34.000Z Age at as of 28 days");
		expect(content).toContain("12 items were skipped");
		expect(content).toContain("3 uploaded items have no recognized");
		expect(content).toContain("latest upload");
		expect(find(b.view(), "img")).toEqual([]);
		expect(find(find(b.view(), "section")[0]!, "a")).toEqual([]);
		expect(find(b.view(), "details")).toHaveLength(2);
		const nav = find(b.view(), "nav")[0]!;
		expect(find(nav, "a").map((a) => a.attrs.href)).toEqual(["#/work/me", "#/work/personal", "#/work/work"]);
		expect(status(b).attrs["aria-live"]).toBe("polite");
		expect(requests).toHaveLength(1);
		click(button(b.view(), "Show up to 200 items"));
		await settle();
		expect(requests.at(-1)).toBe(`/api/profiles/work/board?limit=200&as_of=${encodeURIComponent(BOARD_DATE)}`);
		expect(button(b.view(), "Show up to 200 items").hidden).toBe(true);
		expect(text(b.view())).toContain("display limit"); // a larger read still does not promise completeness
		expect(active).toBe(status(b));
		expect(b.seen.posted).toEqual([]);
		expect(b.seen.fetched.some((p) => p.includes("session-token") || p.includes("opaque"))).toBe(false);
	});

	it("requires a known active profile, choosing explicitly if work is unavailable, and encodes names and dates", async () => {
		const profiles = [{ ...PROFILES[0]!, name: "odd/&?" }, { ...PROFILES[1]!, status: "wiped" }];
		const b = browser({ signedIn: true, hash: "#/work", profiles, api: (path) => path.includes("/board?") ? Response.json(workBoard()) : undefined });
		await dashboardMain(b.win);
		expect(text(b.view())).toContain("Choose an active profile for Work");
		expect(b.seen.fetched.some((p) => p.includes("/board"))).toBe(false);
		b.go("#/work/work");
		expect(text(b.view())).toContain("No active profile named work");
		b.go("#/work/%3Cscript%3E");
		expect(text(b.view())).toContain("No active profile named <script>");
		b.go("#/work/%E0%A4%A");
		expect(text(b.view())).toContain("No active profile named %E0%A4%A");
		expect(b.seen.fetched.some((p) => p.includes("/board"))).toBe(false);
		b.go("#/work/odd%2F%26%3F");
		await settle();
		expect(b.seen.fetched.at(-1)).toBe("/api/profiles/odd%2F%26%3F/board?limit=50");
		expect(text(b.view())).toContain("No open items in the uploaded data read");
		expect(text(b.view())).toContain("No strategic review recorded");
		const date = "2026-10-29T13:30:00+01:30";
		submitDate(b, date);
		await settle();
		expect(b.seen.fetched.at(-1)).toBe(`/api/profiles/odd%2F%26%3F/board?limit=50&as_of=${encodeURIComponent(date)}`);
		expect(find(b.view(), "label")[0]!.attrs.for).toBe(find(b.view(), "input")[0]!.attrs.id);
		expect(text(b.view())).toContain("Z for UTC or an explicit offset");
		expect(text(b.view())).toContain(`As of ${BOARD_DATE}`); // actual returned instant, not the requested label
	});

	it("isolates pending dates, profile changes, navigation and late failures without stealing focus", async () => {
		const oldDate = gate(), failure = gate(), edited = gate(), profileReply = gate();
		const b = browser({ signedIn: true, hash: "#/work/work", profiles: ABOUT_PROFILES, api: async (path) => {
			if (!path.includes("/board?")) return;
			if (path.includes("as_of=first")) { await oldDate.wait; return Response.json(workBoard({ as_of: "OLD-DATE", items: [workItem("Old item")] })); }
			if (path.includes("as_of=fail")) { await failure.wait; return Response.json({ error: { message: "SQL private detail" } }, { status: 503 }); }
			if (path.includes("as_of=edited")) { await edited.wait; return Response.json(workBoard({ as_of: "EDITED-DATE" })); }
			if (path.includes("as_of=profile")) { await profileReply.wait; return Response.json(workBoard({ items: [workItem("Late personal item")] })); }
			return Response.json(workBoard({ items: [workItem(path.includes("/personal/") ? "Personal item" : "Current item")] }));
		} });
		await dashboardMain(b.win);
		await settle();
		submitDate(b, "first");
		expect(status(b).textContent).toBe("Loading work board…");
		expect(text(b.view())).not.toContain(BOARD_DATE);
		submitDate(b, "second");
		await settle();
		const focus = active;
		oldDate.open();
		await settle();
		expect(text(b.view())).not.toContain("OLD-DATE");
		expect(active).toBe(focus);
		submitDate(b, "edited");
		const input = find(b.view(), "input")[0]!;
		input.value = "not submitted";
		input.on.input!(); input.focus();
		edited.open();
		await settle();
		expect(status(b).textContent).toContain("Date changed");
		expect(text(b.view())).not.toContain("EDITED-DATE");
		expect(active).toBe(input);
		submitDate(b, "fail");
		b.go("#/work/personal");
		await settle();
		const heading = active;
		failure.open();
		await settle();
		expect(text(b.view())).toContain("Personal item");
		expect(text(b.view())).not.toContain("Could not load");
		expect(active).toBe(heading);
		submitDate(b, "profile");
		b.go("#/profiles/work");
		const profileHeading = active;
		profileReply.open();
		await settle();
		expect(text(b.view())).not.toContain("Late personal item");
		expect(active).toBe(profileHeading);
		expect(find(b.view(), "a").map((a) => a.attrs.href)).toContain("#/work/work");
		expect(DASHBOARD_HTML(env)).toContain('<a href="#/work">Work</a>');
	});

	it("shows safe refusals and missing coverage honestly, removing earlier data on every request", async () => {
		let response = Response.json(workBoard({ items: [workItem("Previous item")] }));
		const b = browser({ signedIn: true, hash: "#/work", api: (path) => path.includes("/board?") ? response.clone() : undefined });
		await dashboardMain(b.win);
		await settle();
		for (const [code, message] of [[400, "Check the ISO date"], [403, "Access was refused"], [404, "no longer available"], [409, "temporarily busy"], [503, "temporarily unavailable"]] as const) {
			response = Response.json({ error: { message: "SELECT private FROM secret" } }, { status: code });
			submitDate(b, "bad");
			await settle();
			expect(status(b).textContent).toContain(message);
			expect(text(b.view())).not.toContain("Previous item");
			expect(text(b.view())).not.toContain(BOARD_DATE);
			expect(text(b.view())).not.toContain("SELECT");
		}
		// Store refusals use HTTP 400 in the existing route; their codes still explain the actual refusal.
		for (const [code, message] of [["busy", "temporarily busy"], ["profile_wiped", "no longer available"]]) {
			response = Response.json({ error: { code, message: "private detail" } }, { status: 400 });
			submitDate(b, "");
			await settle();
			expect(status(b).textContent).toContain(message!);
		}
		response = Response.json({ as_of: BOARD_DATE, items: [workItem("Unknowns", { score: null, stale: null, last_activity_at: null })] });
		submitDate(b, "");
		await settle();
		expect(text(b.view())).toContain("Score Not recorded Stale Not recorded Last activity Not recorded");
		expect(text(b.view())).toContain("Read completeness was not reported");
		expect(text(b.view())).toContain("evaluated count unavailable");
		expect(text(b.view())).toContain("Strategic review information was not reported");
		expect(text(b.view())).not.toContain("0 uploaded items");
	});
});

describe("dashboard About you", () => {
	it("opens me by default, keeps the server's order and labels, and pages with the server's cursor", async () => {
		const cursor = '[0,0,"2026-10-29T08:00:00Z","id/&?=x"]';
		const b = browser({ signedIn: true, hash: "#/about", profiles: ABOUT_PROFILES, api: (path) => {
			if (path === "/api/profiles/me/owner-model?limit=50") return Response.json({ next_after: cursor, items: [
				pref("s1", { name: "Short answers", description: "Prefers terse replies.", pinned: true, evidence: [{ kind: "memory", ref: "n:abc", note: "said in chat" }] }),
				pref("i1", { name: "<img src=x onerror=alert(1)>", origin: "inferred", flagged: "protected: stated", evidence_missing: true }),
				pref("a1", { name: "Tabs", origin: "agent", source_profile: "work", evidence_truncated: true,
					evidence: Array.from({ length: 10 }, (_, i) => ({ kind: "file", ref: `javascript:alert(${i})`, note: null })) }),
			] });
			if (path === `/api/profiles/me/owner-model?limit=50&after=${encodeURIComponent(cursor)}`) return Response.json({ next_after: null, items: [pref("i2", { origin: "inferred" })] });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("About you: me");
		// The switch lists active profiles only and marks the one on screen.
		const links = find(find(b.view(), "nav")[0]!, "a");
		expect(links.map((a) => [a.attrs.href, a.attrs["aria-current"]])).toEqual([["#/about/me", "page"], ["#/about/personal", undefined], ["#/about/work", undefined]]);
		const items = () => find(find(b.view(), "ul")[0]!, "li").filter((li) => find(li, "h3").length);
		expect(items().map((li) => find(li, "h3")[0]!.textContent)).toEqual(["Short answers", "<img src=x onerror=alert(1)>", "Tabs"]);
		const [s1, i1, a1] = items().map(text);
		expect(s1).toContain("Prefers terse replies. Origin Stated Pinned yes Flagged no Source profile this profile Updated 2026-10-29 Evidence: memory: n:abc (said in chat)");
		expect(i1).toContain("Origin Inferred Pinned no Flagged protected: stated");
		expect(i1).toContain("No evidence is recorded for this inferred preference.");
		expect(a1).toContain("Origin Recorded as agent, not stated");
		expect(a1).toContain("Source profile work");
		expect(a1).toContain("Showing the first 10 evidence pointers; more exist.");
		// Untrusted names and refs stay text: no element or link is made from them.
		expect(find(b.view(), "img")).toEqual([]);
		expect(find(find(b.view(), "ul")[0]!, "a")).toEqual([]);
		expect(status(b).textContent).toBe("Showing 3 preferences; more are available.");
		const more = button(b.view(), "Load more");
		expect(more.hidden).toBe(false);
		click(more);
		await settle();
		expect(b.seen.fetched.at(-1)).toBe(`/api/profiles/me/owner-model?limit=50&after=${encodeURIComponent(cursor)}`);
		expect(items().map((li) => find(li, "h3")[0]!.textContent)).toEqual(["Short answers", "<img src=x onerror=alert(1)>", "Tabs", "Pref i2"]);
		expect(more.hidden).toBe(true);
		expect(status(b).textContent).toBe("Showing 4 preferences.");
		expect(active).toBe(status(b));
		expect(b.seen.auth.every((a) => a === "Bearer session-token")).toBe(true);
		expect(b.seen.fetched.some((p) => p.includes("session-token"))).toBe(false);
		// Reachable from the shell and the profile page, focus moves on navigation, and the served script carries the page.
		b.go("#/profiles/work");
		expect(find(b.view(), "a").map((a) => a.attrs.href)).toContain("#/about/work");
		expect(DASHBOARD_HTML(env)).toContain('<a href="#/about">About you</a>');
		expect(DASHBOARD_HTML(env)).toMatch(/Not built yet<\/h2>\n<p>The transfers, wipe and review pages/);
		expect(DASHBOARD_JS).toContain("/owner-model?limit=50");
	});

	it("pins once per click, shows the server's answer with Undo, shows a conflict, and confirms Forget", async () => {
		const pin = gate();
		const b = browser({ signedIn: true, hash: "#/about/me", profiles: ABOUT_PROFILES, api: async (path, method) => {
			if (path.startsWith("/api/profiles/me/owner-model")) return Response.json({ next_after: null, items: [pref("n/1", { name: "Dark mode" })] });
			if (method !== "POST") return undefined;
			if (path === "/api/profiles/me/nodes/n%2F1/pin") { await pin.wait; return Response.json({ ok: true, action: "pinned", memory_id: "n/1", activity_id: 41 }); }
			if (path === "/api/profiles/me/activity/41/undo") return Response.json({ error: { code: "revision_conflict", message: "expected revision 2, found 3" } }, { status: 409 });
			if (path === "/api/profiles/me/nodes/n%2F1/forget") return Response.json({ error: { code: "not_found", message: "no node 'n/1' in this profile" } }, { status: 404 });
		} });
		await dashboardMain(b.win);
		await settle();
		const pinButton = button(b.view(), "Pin");
		expect([pinButton.attrs.type, pinButton.attrs["aria-label"]]).toEqual(["button", "Pin Dark mode"]);
		click(pinButton);
		expect(status(b).textContent).toBe("Working: pin “Dark mode”…");
		expect(find(b.view(), "button").filter((x) => x.textContent !== "Load more").every((x) => x.disabled)).toBe(true);
		click(pinButton); // a second press while the first is in flight sends nothing
		pin.open();
		await settle();
		expect(b.seen.posted).toEqual(["/api/profiles/me/nodes/n%2F1/pin"]);
		// Success is the server's own answer, then the list is read again.
		expect(b.seen.fetched.filter((p) => p.includes("owner-model"))).toHaveLength(2);
		expect(status(b).textContent).toBe("Done: pinned “Dark mode”. Showing 1 preference.");
		expect(active).toBe(status(b));
		click(button(b.view(), "Undo last change"));
		await settle();
		expect(b.seen.posted.at(-1)).toBe("/api/profiles/me/activity/41/undo");
		expect(status(b).textContent).toContain("Could not undo the last change: it changed since; review it by hand (revision_conflict).");
		expect(button(b.view(), "Undo last change")).toBeDefined(); // still there for the owner to try by hand
		const forget = button(b.view(), "Forget");
		click(forget);
		const ask = find(b.view(), "span")[0]!;
		expect(ask.textContent).toBe("Forget “Dark mode”? It moves to the archive and leaves this list; Undo brings it back. ");
		expect(active).toBe(ask);
		click(button(b.view(), "Cancel"));
		expect(active).toBe(button(b.view(), "Forget"));
		click(button(b.view(), "Forget"));
		click(button(b.view(), "Forget it"));
		await settle();
		expect(b.seen.posted.at(-1)).toBe("/api/profiles/me/nodes/n%2F1/forget");
		expect(status(b).textContent).toContain("Could not forget “Dark mode”: no node 'n/1' in this profile (not_found).");
		expect(b.seen.posted).toHaveLength(3);
	});

	it("drops an answer for a profile that is no longer on screen, and keeps its outcome and Undo for when the owner returns", async () => {
		const late = gate(), pin = gate();
		const b = browser({ signedIn: true, hash: "#/about/work", profiles: ABOUT_PROFILES, api: async (path, method) => {
			if (path.includes("/board?")) return Response.json(workBoard());
			if (path.startsWith("/api/profiles/work/owner-model")) { await late.wait; return Response.json({ next_after: null, items: [pref("w1", { name: "Work pref" })] }); }
			if (path.startsWith("/api/profiles/me/owner-model")) return Response.json({ next_after: null, items: [pref("m1", { name: "Me pref" })] });
			if (path.startsWith("/api/profiles/personal/owner-model")) return Response.json({ next_after: null, items: [] });
			if (method === "POST" && path === "/api/profiles/me/nodes/m1/pin") { await pin.wait; return Response.json({ ok: true, action: "pinned", activity_id: 7 }); }
		} });
		await dashboardMain(b.win);
		b.go("#/about/me");
		await settle();
		late.open();
		await settle();
		expect(text(b.view())).toContain("Me pref");
		expect(text(b.view())).not.toContain("Work pref");
		expect(find(b.view(), "h2")[0]!.focused).toBe(true);
		click(button(b.view(), "Pin"));
		b.go("#/work/work");
		await settle();
		const reads = b.seen.fetched.length;
		pin.open();
		await settle();
		expect(status(b).textContent).toBe("Showing 0 ranked open items of 0 evaluated.");
		expect(b.seen.fetched).toHaveLength(reads); // no reload of me behind the Work page
		b.go("#/about/me");
		await settle();
		expect(status(b).textContent).toBe("Done: pinned “Me pref”. Showing 1 preference.");
		expect(button(b.view(), "Undo last change").disabled).toBe(false);
	});

	it("keeps a committed action outcome visible while its refresh loads or fails", async () => {
		const refresh = gate();
		let reads = 0;
		const b = browser({ signedIn: true, hash: "#/about/me", profiles: ABOUT_PROFILES, api: async (path, method) => {
			if (path === "/api/profiles/me/nodes/p1/pin" && method === "POST") return Response.json({ action: "pinned", activity_id: 333 });
			if (path.startsWith("/api/profiles/me/owner-model")) {
				if (++reads === 1) return Response.json({ next_after: null, items: [pref("p1", { name: "Short answers" })] });
				await refresh.wait;
				return Response.json({ error: { message: "synthetic store unavailable" } }, { status: 503 });
			}
			if (path.includes("/owner-model")) return Response.json({ next_after: null, items: [] });
		} });
		await dashboardMain(b.win);
		await settle();
		click(button(b.view(), "Pin"));
		await settle();
		expect(status(b).textContent).toContain("Done: pinned “Short answers”.");
		expect(status(b).textContent).toContain("Loading preferences…");
		expect(button(b.view(), "Undo last change")).toBeDefined();
		refresh.open();
		await settle();
		expect(status(b).textContent).toContain("Done: pinned “Short answers”.");
		expect(status(b).textContent).toContain("Could not load preferences: synthetic store unavailable");
		expect(active).toBe(status(b));
		b.go("#/about/personal");
		b.go("#/about/me");
		await settle();
		expect(status(b).textContent).toContain("Done: pinned “Short answers”.");
		expect(status(b).textContent).toContain("Could not load preferences: synthetic store unavailable");
		expect(button(b.view(), "Undo last change").disabled).toBe(false);
		expect(b.seen.posted).toEqual(["/api/profiles/me/nodes/p1/pin"]);
	});

	it("reads only active profiles, falls back from me, and shows a refused read without inventing records", async () => {
		const b = browser({ signedIn: true, hash: "#/about/old", profiles: ABOUT_PROFILES });
		await dashboardMain(b.win);
		expect(find(b.view(), "h2")[0]!.textContent).toBe("No active profile named old");
		const noMe = browser({ signedIn: true, hash: "#/about", api: (path) => path.includes("owner-model")
			? Response.json({ error: { code: "not_found", message: "profile 'personal' is not active" } }, { status: 404 }) : undefined });
		await dashboardMain(noMe.win);
		await settle();
		expect(find(noMe.view(), "h2")[0]!.textContent).toBe("About you: personal");
		expect(status(noMe).textContent).toBe("Could not load preferences: profile 'personal' is not active");
		expect(find(noMe.view(), "h3")).toEqual([]);
		const retry = button(noMe.view(), "Try again");
		expect(retry.hidden).toBe(false);
		click(retry);
		await settle();
		expect(noMe.seen.fetched.filter((p) => p.includes("owner-model"))).toEqual(Array(2).fill("/api/profiles/personal/owner-model?limit=50"));
		expect(b.seen.fetched.some((p) => p.includes("owner-model"))).toBe(false);
	});
});

// The newer pages: fixtures shaped like the owner reads and writes they call.
const typeIn = (e: El, value: string) => { e.value = value; e.on.input?.(); };
const submit = (root: El, i = 0) => find(root, "form")[i]!.on.submit!({ preventDefault() {} });
const byId = (root: El, id: string) => find(root, "input").concat(find(root, "textarea"), find(root, "select")).find((e) => e.attrs.id === id)!;
const HOSTILE = "<img src=x onerror=alert(1)>";
const entity = (extra: Record<string, unknown> = {}) => ({ id: "m1", as_of: null,
	node: { id: "m1", kind: "decision", memory_type: "project", scope: null, name: HOSTILE, status: "active", origin: "stated", revision: 3, created_at: "2026-10-01T00:00:00Z",
		updated_at: "2026-10-30T00:00:00Z", pinned: false, flagged: null, source_profile: null, description: "Why we chose it", truncated: [] },
	content: { text: "Line one\nLine two", chars: 18, complete: true }, evidence: { items: [{ kind: "url", ref: "https://example.test", note: null }], truncated: false },
	links: [{ id: 1, rel: "relates_to", direction: "out", reason: "same area", other: { id: "x9", readable: false } }], budget: { exhausted: false },
	history: { items: [{ revision: 3, op: "updated", at: "2026-10-30T00:00:00Z", actor: "agent" }], next_before: 3 }, ...extra });

describe("dashboard memories and drafts", () => {
	it("lists with the server's cursor, opens a record as text with history, and pins it with Undo", async () => {
		const b = browser({ signedIn: true, hash: "#/memories", api: (path, method, body) => {
			if (path === "/api/profiles/work/recall") return Response.json((body as { cursor?: string }).cursor
				? { results: [], next_cursor: null, truncated: false } : { results: [{ memory_id: "m1", profile: "work", name: HOSTILE, type: "project", passage: "p" }], next_cursor: "c1", truncated: true });
			if (path === "/api/profiles/work/nodes/m1") return Response.json(entity());
			if (path === "/api/profiles/work/nodes/m1?before=3") return Response.json({ history: { items: [{ revision: 2, op: "created", at: "2026-10-01T00:00:00Z", actor: "owner" }], next_before: null } });
			if (path === "/api/profiles/work/nodes/m1/pin" && method === "POST") return Response.json({ action: "pinned", activity_id: 41 });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Memories: work"); // work is the default over the first active profile
		expect(b.seen.bodies[0]).toEqual({ limit: 25 });
		expect(find(b.view(), "a").find((a) => a.textContent === HOSTILE)!.attrs.href).toBe("#/memory/work/m1");
		expect(find(b.view(), "img")).toEqual([]);
		click(button(b.view(), "Load more"));
		await settle();
		expect(b.seen.bodies[1]).toEqual({ limit: 25, cursor: "c1" });
		b.go("#/memory/work/m1");
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe(`Memory: ${HOSTILE}`);
		expect(text(b.view())).toContain("Line one\nLine two");
		expect(text(b.view())).toContain("a record not readable in this profile");
		click(button(b.view(), "Older revisions"));
		await settle();
		expect(find(b.view(), "tr").slice(1).map(text)).toEqual(["3 updated 2026-10-30T00:00:00Z agent", "2 created 2026-10-01T00:00:00Z owner"]);
		click(button(b.view(), "Pin"));
		await settle();
		expect(status(b).textContent).toContain(`Done: pinned “${HOSTILE}”.`);
		expect(button(b.view(), "Undo last change")).toBeDefined();
		expect(b.seen.posted).toEqual(["/api/profiles/work/recall", "/api/profiles/work/recall", "/api/profiles/work/nodes/m1/pin"]);
	});

	it("saves a draft only after a preview and an explicit Save, invalidates the preview on change, and keeps a refusal visible", async () => {
		let answer: Response = Response.json({ error: { code: "validation", message: "synthetic refusal" } }, { status: 400 });
		const b = browser({ signedIn: true, hash: "#/draft/work", api: (path) => path === "/api/profiles/work/save" ? answer : undefined });
		await dashboardMain(b.win);
		expect(button(b.view(), "Save").disabled).toBe(true);
		typeIn(byId(b.view(), "draft-name"), "Use SQLite");
		submit(b.view());
		expect(status(b).textContent).toBe("Write a short description.");
		typeIn(byId(b.view(), "draft-desc"), "Storage choice");
		typeIn(byId(b.view(), "draft-content"), "Because it is local.");
		submit(b.view());
		expect(text(b.view())).toContain("Preview (not saved)");
		expect(b.seen.posted).toEqual([]);
		typeIn(byId(b.view(), "draft-content"), "Because it is local and fast.");
		expect(button(b.view(), "Save").disabled).toBe(true);
		submit(b.view());
		click(button(b.view(), "Save"));
		await settle();
		expect(status(b).textContent).toContain("Could not save “Use SQLite”: synthetic refusal (validation).");
		const sent = b.seen.bodies[0] as Record<string, unknown>;
		expect(sent).toMatchObject({ name: "Use SQLite", type: "project", origin: "stated", description: "Storage choice", content: "Because it is local and fast." });
		expect(String(sent.request_id)).toMatch(/^dashboard:/);
		answer = Response.json({ ok: true, action: "created", memory_id: "m2", name: "Use SQLite", revision: 1 });
		submit(b.view());
		click(button(b.view(), "Save"));
		await settle();
		expect(status(b).textContent).toContain("Saved: created “Use SQLite”, revision 1.");
		expect(byId(b.view(), "draft-name").value).toBe("");
		expect(b.seen.posted).toEqual(["/api/profiles/work/save", "/api/profiles/work/save"]);
	});

	it("keeps the previewed payload and request id through a lost response, so an unchanged retry replays instead of writing twice", async () => {
		const saved = new Map<string, unknown>();
		const b = browser({ signedIn: true, hash: "#/draft/work", api: (path, _method, body) => {
			if (path !== "/api/profiles/work/save") return;
			const { request_id: id, name } = body as { request_id: string; name: string };
			if (saved.has(id)) return Response.json(saved.get(id));
			if (saved.size) return Response.json({ error: { code: "already_exists", message: "memory already exists" } }, { status: 400 });
			saved.set(id, { action: "created", name, memory_id: "m1", revision: 1 });
			throw new Error("response lost after commit");
		} });
		await dashboardMain(b.win);
		typeIn(byId(b.view(), "draft-name"), "Retry control");
		typeIn(byId(b.view(), "draft-desc"), "Description");
		submit(b.view());
		click(button(b.view(), "Save"));
		await settle();
		expect(status(b).textContent).toContain("response lost after commit");
		expect(byId(b.view(), "draft-name").value).toBe("Retry control");
		expect(button(b.view(), "Save").disabled).toBe(false); // the same preview stays ready; nothing was retried by itself
		expect(b.seen.posted).toHaveLength(1);
		submit(b.view()); // previewing the unchanged body again keeps its request id
		click(button(b.view(), "Save"));
		await settle();
		const [first, second] = b.seen.bodies as Record<string, unknown>[];
		expect(second).toEqual(first);
		expect(status(b).textContent).toContain("Saved: created “Retry control”, revision 1.");
		expect(byId(b.view(), "draft-name").value).toBe("");
	});

	it("draws the map's readable records as buttons, states partial and opaque coverage, and keeps what-if items local until a draft is saved", async () => {
		const map = { center: null, starts: ["p1"], depth: 1, nodes: [{ id: "p1", kind: "project", name: "Agent Memory", status: "active" }, { id: "c1", kind: "component", name: HOSTILE, status: "active" }],
			links: [{ id: 1, rel: "part_of", reason: "lives in it", from: { id: "c1", readable: true }, to: { id: "p1", readable: true } }, { id: 2, rel: "relates_to", from: { id: "p1", readable: true }, to: { id: "zz", readable: false } }],
			truncated: true, limits: { nodes: 300 } };
		const b = browser({ signedIn: true, hash: "#/map/work", api: (path) => path.startsWith("/api/profiles/work/map?") ? Response.json(map) : undefined });
		await dashboardMain(b.win);
		await settle();
		expect(b.seen.fetched).toContain("/api/profiles/work/map?depth=1");
		expect(text(b.view())).toContain("Partial map");
		expect(text(b.view())).toContain("1 link leads to records not readable in this profile");
		const nodes = find(b.view(), "button").filter((e) => e.attrs.class === "node");
		expect(nodes.map((n) => n.attrs["aria-label"])).toEqual(["project: Agent Memory", `component: ${HOSTILE}`]);
		click(nodes[0]!);
		expect(nodes[0]!.attrs["aria-pressed"]).toBe("true");
		expect(text(b.view())).toContain(`From ${HOSTILE} — part_of: lives in it`);
		typeIn(byId(b.view(), "whatif-name"), "Try Postgres");
		submit(b.view(), 1);
		await settle();
		expect(text(b.view())).toContain("What-if: Try Postgres");
		expect(b.seen.posted).toEqual([]);
		click(button(b.view(), "Make a draft"));
		b.go("#/draft/work");
		expect(byId(b.view(), "draft-name").value).toBe("Try Postgres");
		expect(text(b.view())).toContain("Adds a “relates to” link to “Agent Memory”");
		expect(b.seen.posted).toEqual([]);
	});

	it("shows an open recovery with its consequences, and steps, aborts or begins a restore only after typed confirmation", async () => {
		let open = true;
		const b = browser({ signedIn: true, hash: "#/backups", api: (path, method) => {
			if (path === "/api/recovery") return Response.json(open ? { recovery: { id: "rA", profile: "work", export: "e2", at: "2026-10-31T00:00:00Z", state: "restoring", unresolved: [], unresolved_count: 0 }, last_export: null }
				: { recovery: null, last_export: { at: "2026-10-30T00:00:00Z", results: { work: { id: "e2", rows: 9 }, personal: "empty" } } });
			if (path === "/api/recovery/step" && method === "POST") return Response.json({ state: "checking" });
			if (path === "/api/recovery/abort" && method === "POST") { open = false; return Response.json({ state: "aborted" }); }
			if (path === "/api/profiles/work/exports") return Response.json(["e1", "e2"]);
			if (path === "/api/profiles/work/restore" && method === "POST") return Response.json({ state: "restoring" });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(text(b.view())).toContain("Every profile and device is refused until this restore of “work” is opened or aborted.");
		expect(text(b.view())).not.toContain("Export everything");
		click(button(b.view(), "Run the next step"));
		await settle();
		expect(status(b).textContent).toContain("Recovery is now checking.");
		const abort = button(b.view(), "Abort");
		expect(abort.disabled).toBe(true);
		typeIn(byId(b.view(), "confirm-abort"), "abort");
		click(button(b.view(), "Abort"));
		await settle();
		expect(text(b.view())).toContain("No recovery is open");
		expect(text(b.view())).toContain("work: saved (e2), 9 rows");
		byId(b.view(), "restore-profile").value = "work";
		click(button(b.view(), "List this profile's exports"));
		await settle();
		expect(byId(b.view(), "exp-restore-a-profile").value).toBe("e2");
		const begin = button(b.view(), "Begin restore of profile work");
		expect(begin.disabled).toBe(true);
		typeIn(find(b.view(), "input").find((e) => e.attrs.id?.startsWith("confirm-begin-restore-of-profile"))!, "work");
		click(begin);
		await settle();
		expect(b.seen.posted).toEqual(["/api/recovery/step", "/api/recovery/abort", "/api/profiles/work/restore"]);
		expect(b.seen.bodies).toEqual([{ id: "rA" }, { id: "rA" }, { export: "e2" }]); // each recovery action names the recovery shown
		expect(JSON.stringify(b.seen)).not.toMatch(/BACKUP_KEY/);
	});
});

describe("dashboard timeline, journals and paths", () => {
	it("reads an explicit timeline window for active work, links named records, states a cut window, and drops a stale answer", async () => {
		const late = gate();
		let calls = 0;
		const b = browser({ signedIn: true, hash: "#/timeline", api: async (path) => {
			if (!path.startsWith("/api/profiles/work/timeline?")) return;
			if (++calls === 3) { await late.wait; return Response.json({ node: null, events: [{ at: "2026-10-30T00:00:00Z", event: "activity:save", summary: "stale answer" }], truncated: false }); }
			return Response.json({ node: null, truncated: true, events: [
				{ at: "2026-10-29T00:00:00Z", event: "activity:save", node_id: null, actor: "agent", summary: HOSTILE, targets: ["m1"] },
				{ at: "2026-10-30T00:00:00Z", event: "revision:legacy_snapshot", node_id: "n1", revision: 1, kind: "document", name: "Imported note", actor: "migration" }] });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Timeline: work");
		const first = b.seen.fetched.find((x) => x.includes("/timeline?"))!;
		const q = new URL(first, "https://x").searchParams;
		expect([q.get("limit"), Date.parse(q.get("to")!) - Date.parse(q.get("from")!)]).toEqual(["100", 7 * 86_400_000]);
		expect(text(b.view())).toContain(`Change: save by agent ${HOSTILE}`);
		expect(find(b.view(), "img")).toEqual([]);
		expect(find(b.view(), "a").find((a) => a.textContent === "document: Imported note")!.attrs.href).toBe("#/memory/work/n1");
		expect(text(b.view())).toContain("Only the earliest events of this window are shown");
		click(button(b.view(), "Show up to 500 events"));
		await settle();
		expect(b.seen.fetched.filter((x) => x.includes("/timeline?")).at(-1)).toContain("limit=100".replace("100", "500"));
		submit(b.view());
		typeIn(byId(b.view(), "tl-from"), "2026-10-01T00:00:00Z");
		late.open();
		await settle();
		expect(text(b.view())).not.toContain("stale answer");
		expect(status(b).textContent).toBe("Window changed. Choose Show timeline to load it.");
	});

	it("pages journals, reads one journal's entries as text with compaction and part markers, and pages its entries", async () => {
		const b = browser({ signedIn: true, hash: "#/journals", api: (path) => {
			if (path === "/api/profiles/work/journals?limit=50") return Response.json({ items: [{ id: "j1", name: HOSTILE, scope: "repo", updated_at: "2026-10-30T00:00:00Z", latest_entry_seq: 3, compacted_through: 1, pinned: false }], next_after: null });
			if (path === "/api/profiles/work/journals?id=j1&limit=25") return Response.json({ journal: { id: "j1", name: "Build log", scope: "repo", status: "active", revision: 4, compacted_through: 1 },
				summary: { body: "Summary <b>text</b>", complete: true }, compactions: [{ revision: 3, at: "2026-10-29T00:00:00Z", actor: "agent", from_seq: 1, through_seq: 1 }], compactions_more: false,
				entries: [{ entry_seq: 1, body: HOSTILE, created_at: "2026-10-28T00:00:00Z", actor: "agent", current: false, complete: true }, { entry_seq: 2, body: "two", created_at: "2026-10-29T00:00:00Z", actor: "agent", current: true, complete: false }], next_after: 2 });
			if (path === "/api/profiles/work/journals?id=j1&limit=25&entries_after=2") return Response.json({ journal: {}, entries: [{ entry_seq: 3, body: "three", created_at: "2026-10-30T00:00:00Z", actor: "agent", current: true, complete: true }], next_after: null });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "a").find((a) => a.textContent === HOSTILE)!.attrs.href).toBe("#/journals/work/j1");
		expect(status(b).textContent).toBe("Showing 1 journal.");
		b.go("#/journals/work/j1");
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Journal: Build log");
		expect(text(b.view())).toContain("Summary <b>text</b>");
		expect(text(b.view())).toContain(`· 2026-10-28T00:00:00Z · agent ${HOSTILE} Compacted into the summary.`);
		expect(text(b.view())).toContain("Only this entry's first part is shown");
		expect(find(b.view(), "img").concat(find(b.view(), "b"))).toEqual([]);
		click(button(b.view(), "Later entries"));
		await settle();
		expect(text(b.view())).toContain("Entry 3");
		expect(status(b).textContent).toBe("Showing 3 entries.");
		expect(button(b.view(), "Later entries").hidden).toBe(true);
		expect(b.seen.posted).toEqual([]);
	});

	it("finds paths from the server's answer only, shows unreadable ends truthfully, and ignores an answer after the profile changed", async () => {
		const late = gate();
		const answer = { mode: "path", max_depth: 4, from: { id: "a1", kind: "project", name: "Start", profile: "work" }, to: { id: "b2", kind: "decision", name: "Goal", profile: "work" },
			paths: [{ length: 2, edges: [{ rel: "depends_on", reason: "needs it", from: { id: "a1", kind: "project", name: "Start", profile: "work" }, to: { id: "x9", readable: false } },
				{ rel: "relates_to", from: { id: "x9", readable: false }, to: { id: "b2", profile: "me", readable: true } }] }], budget: { exhausted: true } };
		let calls = 0;
		const b = browser({ signedIn: true, hash: "#/path/work/a1", api: async (path) => {
			if (!path.startsWith("/api/profiles/work/path?")) return;
			if (++calls === 2) await late.wait;
			return Response.json(answer);
		} });
		await dashboardMain(b.win);
		expect(byId(b.view(), "path-from").value).toBe("a1");
		typeIn(byId(b.view(), "path-to"), "b2");
		submit(b.view());
		await settle();
		// Only the path read: no extra lookups of names or ends.
		expect(b.seen.fetched.filter((x) => x.startsWith("/api/profiles/") && !x.endsWith("/batch"))).toEqual(["/api/profiles/work/path?from=a1&to=b2&max_depth=4"]);
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("From project: Start to decision: Goal");
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("project: Start — depends_on → a record not readable here needs it");
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("a record not readable here — relates_to → a record in another profile, not read");
		expect(text(b.view())).toContain("The search stopped at its read budget");
		expect(find(b.view(), "a").find((a) => a.textContent === "decision: Goal")!.attrs.href).toBe("#/memory/work/b2");
		submit(b.view());
		b.go("#/path/personal");
		const focused = active;
		late.open();
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Path finder: personal");
		expect(text(b.view())).not.toContain("Start");
		expect(active).toBe(focused);
	});
});

describe("dashboard knowledge graph", () => {
	// A realistic metadata-only library: 1,374 memories of every type, two entities, and links of every kind the read can send.
	const TYPES = ["project", "feedback", "reference", "user", "procedural"];
	const nodes = [...Array.from({ length: 1374 }, (_, i) => ({ id: `r${i}`, kind: i % 7 ? "document" : "decision", type: TYPES[i % 5], scope: i % 3 ? "repo-a" : null,
		name: i === 1000 ? HOSTILE : `Record ${i}`, status: "active", updated_at: "2026-10-30T00:00:00Z" })),
		{ id: "p1", kind: "project", type: null, name: "Agent Memory", status: "active" }, { id: "u1", kind: "person", type: null, name: "Owner", status: "active" },
		{ id: "old", kind: "document", type: "reference", name: "Retired note", status: "retired" }];
	const at = (src: string, dst: string, readable = true) => ({ src, dst: { id: dst, readable } });
	const edges = [{ id: 1, rel: "part_of", ...at("r1", "p1") }, { id: 2, rel: "authored", ...at("u1", "r1") }, { id: 3, rel: "relates_to", ...at("r2", "far", false) },
		{ id: 4, rel: "relates_to", ...at("r3", "never-sent") }];
	// The whole-graph read: server page sizes (1,000 nodes, 2,000 edges), an opaque next_after, total only on a first nodes page.
	const pageOf = (part: "nodes" | "edges", items: unknown[], path: string, changed = false) => {
		const start = Number(new URL(path, "https://x").searchParams.get("after") ?? 0), size = part === "nodes" ? 1000 : 2000, next = start + size < items.length ? String(start + size) : null;
		return Response.json({ part, items: items.slice(start, start + size), next_after: next, done: !next, changed, ...(part === "nodes" && !start ? { total: items.length } : {}), limits: { items: size, bytes: 524288 } });
	};
	const graphApi = (extra?: Api): Api => async (path, method, body) => {
		const r = await extra?.(path, method, body);
		if (r) return r;
		if (path.startsWith("/api/profiles/work/graph?part=nodes")) return pageOf("nodes", nodes, path);
		if (path.startsWith("/api/profiles/work/graph?part=edges")) return pageOf("edges", edges, path);
	};
	const loaded = async (b: ReturnType<typeof browser>) => {
		for (let i = 0; i < 40; i++) { await settle(); const t = status(b)?.textContent ?? ""; if (t.includes("records") && !t.includes("loading…")) return; }
		throw new Error("the graph did not finish loading");
	};

	it("opens active work's whole graph at the root, pages metadata to the server's totals, draws every record and only real links", async () => {
		const b = browser({ signedIn: true, api: graphApi() });
		const started = performance.now();
		await dashboardMain(b.win);
		await loaded(b);
		const elapsed = performance.now() - started;
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Knowledge graph: work");
		expect(b.seen.fetched.filter((x) => x.includes("/graph?")).sort()).toEqual(["/api/profiles/work/graph?part=edges", "/api/profiles/work/graph?part=nodes",
			"/api/profiles/work/graph?part=nodes&after=1000"]);
		// A link to a record the server never listed waits instead of inventing an end; the opaque one is counted, not drawn.
		expect(status(b).textContent).toBe("1,377 of 1,377 records loaded · 2 links · 1 links lead to records not readable in this profile · 1 links wait for records that were not listed.");
		expect(b.seen.fetched.some((x) => x.includes("/recall") || x.includes("/map?"))).toBe(false);
		await settle();
		const canvas = find(b.view(), "canvas")[0]!;
		expect(Number(canvas.attrs["data-drawn"])).toBe(1376); // fitted: every active record is in view; the retired one waits for its toggle
		expect(text(b.view())).toContain("Include retired and superseded records (1)");
		expect(text(find(b.view(), "ul").find((u) => u.attrs.class === "legend")!)).toContain("Project memories (275)");
		expect(elapsed).toBeLessThan(3000);
		// Search finds records among all loaded ones, lists at most 50 as buttons, and a hostile name stays text.
		typeIn(byId(b.view(), "graph-q"), "record 1");
		expect(text(b.view())).toContain("matches; the first 50 are listed.");
		expect(find(find(b.view(), "ul").find((u) => u.attrs.class === "matches")!, "button")).toHaveLength(50);
		typeIn(byId(b.view(), "graph-q"), "onerror");
		expect(button(b.view(), HOSTILE)).toBeDefined();
		expect(find(b.view(), "img")).toEqual([]);
		// Hiding a group removes it from the drawing.
		const box = find(b.view(), "input").find((e) => e.attrs.type === "checkbox" && text(find(b.view(), "label").find((l) => l.children.includes(e))!).includes("Feedback"))!;
		box.checked = false;
		box.on.change!();
		await settle();
		expect(Number(canvas.attrs["data-drawn"])).toBe(1376 - 275);
	});

	it("reads a selected record's detail only on selection, shows its real links, and drops a slower earlier selection", async () => {
		const slow = gate();
		const b = browser({ signedIn: true, api: graphApi(async (path) => {
			if (path === "/api/profiles/work/nodes/r1") { await slow.wait; return Response.json({ node: { name: "Record 1", description: "late detail" }, history: { items: [] } }); }
			if (path === "/api/profiles/work/nodes/u1") return Response.json({ node: { name: "Owner", description: "The owner" }, history: { items: [{ revision: 1, op: "saved", at: "2026-10-01T00:00:00Z", actor: "agent" }] } });
		}) });
		await dashboardMain(b.win);
		await loaded(b);
		expect(b.seen.fetched.some((x) => x.includes("/nodes/"))).toBe(false);
		typeIn(byId(b.view(), "graph-q"), "Record 1");
		click(button(b.view(), "Record 1"));
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("to · part_of · Agent Memory");
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("from · authored · Owner");
		click(button(b.view(), "Owner"));
		await settle();
		slow.open();
		await settle();
		expect(find(b.view(), "h3").map((x) => x.textContent)).toContain("Owner");
		expect(text(b.view())).toContain("The owner");
		expect(text(b.view())).not.toContain("late detail");
		typeIn(byId(b.view(), "graph-q"), "Record 13");
		click(button(b.view(), "Record 13"));
		await settle();
		expect(text(b.view())).toContain("No links: this record stands alone.");
		expect(b.seen.posted).toEqual([]);
	});

	it("says plainly when the server has no whole-graph read, without a fallback read", async () => {
		const b = browser({ signedIn: true, api: (path) => path.includes("/graph?") ? Response.json({ error: "not_found" }, { status: 404 }) : undefined });
		await dashboardMain(b.win);
		await settle();
		expect(status(b).textContent).toContain("This server does not offer the whole-graph read yet");
		expect(b.seen.fetched.filter((x) => x.startsWith("/api/profiles/work/")).sort()).toEqual(["/api/profiles/work/batch", "/api/profiles/work/graph?part=edges", "/api/profiles/work/graph?part=nodes"]);
		expect(b.seen.fetched.some((x) => x.includes("/recall") || x.includes("/map?"))).toBe(false);
	});

	it("offers a fresh walk when the profile changed during loading, and replaces the cached graph", async () => {
		let changed = true;
		const b = browser({ signedIn: true, api: graphApi((path) => path.startsWith("/api/profiles/work/graph?part=edges") ? pageOf("edges", edges, path, changed) : undefined) });
		await dashboardMain(b.win);
		await loaded(b);
		expect(status(b).textContent).toContain("The profile changed while loading; reload for a fresh graph.");
		changed = false;
		click(button(b.view(), "Reload graph"));
		await loaded(b);
		expect(status(b).textContent).not.toContain("changed while loading");
		expect(b.seen.fetched.filter((x) => x === "/api/profiles/work/graph?part=nodes")).toHaveLength(2);
	});

	it("resizes the backing canvas on a height-only change and keeps headings and the selected label inside a narrow canvas without overlap", async () => {
		const b = browser({ signedIn: true, api: graphApi() });
		await dashboardMain(b.win);
		await loaded(b);
		await settle();
		const canvas = find(b.view(), "canvas")[0]! as El & { width: number; height: number; clientWidth: number; clientHeight: number; ctx: Ctx };
		expect([canvas.width, canvas.height]).toEqual([800, 560]);
		canvas.clientHeight = 420;
		b.listeners.resize!();
		await settle();
		expect([canvas.width, canvas.height]).toEqual([800, 420]);
		canvas.clientWidth = 390;
		b.listeners.resize!();
		typeIn(byId(b.view(), "graph-q"), "Record 1");
		click(button(b.view(), "Record 1"));
		canvas.ctx.texts = [];
		click(button(b.view(), "Zoom out"));
		await settle();
		const texts = canvas.ctx.texts, inside = (t: Ctx["texts"][number]) => t.x >= 0 && t.x + t.w <= 390 && t.y >= 0 && t.y <= 420;
		const headings = texts.filter((t) => t.font.startsWith("600"));
		expect(headings.length).toBeGreaterThan(0);
		expect(texts.every(inside)).toBe(true);
		for (const [i, a] of texts.entries()) for (const c of texts.slice(i + 1)) expect(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y <= c.y - 14 || c.y <= a.y - 14).toBe(true);
		expect(texts.some((t) => t.t === "Record 1")).toBe(true);
	});

	it("draws every record into one cached dot layer as a path per colour, so a pan stamps one bitmap and a zoom redraws the layer once", async () => {
		const b = browser({ signedIn: true, api: graphApi() });
		const made: (El & { ctx: Ctx })[] = [], create = b.win.document.createElement;
		b.win.document.createElement = (tag: string) => { const e = create(tag) as El & { ctx: Ctx }; if (tag === "canvas") made.push(e); return e; };
		await dashboardMain(b.win);
		await loaded(b);
		await settle();
		const [screen, dotLayer] = made;
		expect(made).toHaveLength(2); // the visible canvas and its one dot layer, reused
		const stamped = screen!.ctx.images;
		// The last layer drawing held every active record (1,376 arcs) in three fills, one per colour.
		dotLayer!.ctx.arcs = 0; dotLayer!.ctx.fills = 0;
		click(button(b.view(), "Fit"));
		click(button(b.view(), "Zoom in"));
		await settle();
		expect([dotLayer!.ctx.arcs, dotLayer!.ctx.fills]).toEqual([1376, 3]);
		expect(screen!.attrs["data-drawn"]).toBe("1376");
		// A pan stamps the layer once and draws no record on the visible canvas, nor redraws the layer.
		const before = { layer: dotLayer!.ctx.arcs, screen: screen!.ctx.arcs, images: screen!.ctx.images };
		screen!.on.keydown!({ key: "ArrowLeft", preventDefault() {} } as never);
		await settle();
		expect([dotLayer!.ctx.arcs - before.layer, screen!.ctx.arcs - before.screen, screen!.ctx.images - before.images]).toEqual([0, 0, 1]);
		expect(stamped).toBeGreaterThan(0);
	});
});
