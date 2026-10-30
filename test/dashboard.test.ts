// The dashboard's browser half against a stand-in DOM and ClerkJS: what it fetches, what it shows, and what it refuses to invent.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_JS, dashboardMain } from "../src/dashboard";
import { call, contextFor } from "./helpers";

type El = { tag: string; textContent: string; value: string; hidden: boolean; disabled: boolean; children: El[]; attrs: Record<string, string>; focused?: boolean;
	on: Record<string, (event?: { preventDefault(): void }) => unknown>; appendChild(c: El): void; replaceChildren(): void; setAttribute(k: string, v: string): void; focus(): void;
	addEventListener(type: string, f: () => unknown): void };
let active: El | undefined; // the stand-in document.activeElement
const make = (tag: string, hidden = false): El => {
	const e: El = { tag, textContent: "", value: "", hidden, disabled: false, children: [], attrs: {}, on: {},
		appendChild(c) { e.children.push(c); }, replaceChildren() { e.children = []; }, setAttribute(k, v) { e.attrs[k] = v; },
		focus() { e.focused = true; active = e; }, addEventListener(type, f) { e.on[type] = f; } };
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

type Api = (path: string, method: string) => Response | undefined | Promise<Response | undefined>;
function browser(o: { signedIn?: boolean; hash?: string; fail?: number; profiles?: unknown[]; api?: Api } = {}) {
	const els: Record<string, El> = {};
	const listeners: Record<string, () => void> = {};
	const seen: { fetched: string[]; auth: string[]; posted: string[]; mounted?: unknown } = { fetched: [], auth: [], posted: [] };
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
		fetch: async (path: string, init: { method?: string; headers: Record<string, string> }) => {
			seen.fetched.push(path);
			seen.auth.push(init.headers.authorization!);
			if (init.method === "POST") seen.posted.push(path);
			if (o.fail) return Response.json({ error: "forbidden" }, { status: o.fail });
			const r = await o.api?.(path, init.method ?? "GET");
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
		const b = browser({ signedIn: true });
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
		expect(text(cards[1]!)).toContain("Backups are not built yet");
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
		expect(DASHBOARD_HTML(env)).toContain('<a href="#/about">About you</a><a href="/settings">Settings</a>');
		expect(DASHBOARD_HTML(env)).toMatch(/Not built yet<\/h2>\n<p>The map, entity pages, path finder, timeline, journals, activity with undo, archive and review pages/);
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
