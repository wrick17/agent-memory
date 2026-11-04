// The dashboard's browser half against a stand-in DOM and ClerkJS: what it fetches, what it shows, and what it refuses to invent.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, DASHBOARD_JS, dashboardMain } from "../src/dashboard";
import REPLAY_PLAYER from "../local/replay-player.js";
import { call, contextFor, deviceToken } from "./helpers";

type El = { tag: string; tagName: string; textContent: string; value: string; hidden: boolean; disabled: boolean; checked: boolean; children: El[]; attrs: Record<string, string>; focused?: boolean;
	on: Record<string, (event?: { preventDefault(): void }) => unknown>; appendChild(c: El): void; replaceChildren(): void; setAttribute(k: string, v: string): void; focus(): void;
	addEventListener(type: string, f: () => unknown): void; getAttribute(k: string): string | null; querySelector(sel: string): El | null; parent?: El; remove(): void; removeAttribute(k: string): void };
let active: El | undefined; // the stand-in document.activeElement
// A 2D context that draws nothing and records text: its font, place and width (7 px a character, as measureText reports here).
type Ctx = Record<string, unknown> & { arcs: number; fills: number; images: number; font: string; fillStyle: string; fillStyles: string[];
	texts: { font: string; t: string; x: number; y: number; w: number; color: string }[] };
const context = (): Ctx => {
	const c: Ctx = { arcs: 0, fills: 0, images: 0, font: "", fillStyle: "", fillStyles: [], texts: [] };
	for (const f of ["setTransform", "clearRect", "beginPath", "moveTo", "lineTo", "stroke", "scale", "strokeText"]) c[f] = () => {};
	c.arc = () => { c.arcs++; };
	c.fill = () => { c.fills++; c.fillStyles.push(c.fillStyle); };
	c.drawImage = () => { c.images++; };
	c.measureText = (t: string) => ({ width: t.length * 7 });
	c.fillText = (t: string, x: number, y: number) => { c.texts.push({ font: c.font, t, x, y, w: t.length * 7, color: c.fillStyle }); };
	return c;
};
const make = (tag: string, hidden = false): El => {
	const e: El = { tag, tagName: tag.toUpperCase(), textContent: "", value: "", hidden, disabled: false, checked: false, children: [], attrs: {}, on: {},
		appendChild(c) { c.parent = e; e.children.push(c); }, remove() { if (e.parent) e.parent.children = e.parent.children.filter((x) => x !== e); },
		removeAttribute(k) { delete e.attrs[k]; }, replaceChildren() { e.children = []; }, setAttribute(k, v) { e.attrs[k] = v; },
		focus() { e.focused = true; active = e; }, addEventListener(type, f) { e.on[type] = f; }, getAttribute(k) { return e.attrs[k] ?? null; },
		// Only the selector shapes the shell uses: tag, [attr] and [attr="value"], or a tag with one of those.
		querySelector(sel) {
			const [, tag, attr, value] = /^([a-z]*)(?:\[([a-z-]+)(?:="([^"]*)")?\])?$/.exec(sel) ?? [];
			const hit = (x: El) => (!tag || x.tag === tag) && (!attr || (attr in x.attrs && (value === undefined || x.attrs[attr] === value)));
			const walk = (x: El): El | null => { for (const c of x.children) { if (hit(c)) return c; const d = walk(c); if (d) return d; } return null; };
			return walk(e);
		} };
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

// What GET /api/viewer/snapshot answers by default: a valid snapshot, so the data client starts quietly. Tests of the live
// chrome pass their own (or a refusal) through `api`.
const SNAPSHOT = { at: "2026-11-04T10:00:00.000Z", version: "9f2c4e1a-0000-4000-8000-000000000000", deployed_at: "2026-11-04T09:00:00.000Z", profiles: ["personal", "work"], cursor: "c1",
	counts: { memories: 12, revisions: 3, observations: 4, sessions: 2, sessions_active: 1, lessons: 7, crystals: 1, actions: 5, graph_nodes: 30, graph_edges: 40 },
	usage: { recalls_today: 1, recall_tokens_today: 10, writes_today: 2, storage_bytes: 1024, storage_limit: 10 * 1024 ** 3, vectors: 9 },
	health: { verdict: "ok", checks: [] }, recent_sessions: [], feed: [], layers: [],
	flags: [{ id: "embeddings", state: "on", tabs: ["memories"], how: "" }, { id: "inject", state: "off", tabs: ["sessions"], how: "Run agent-memory install --inject." }] };
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

type Api = (path: string, method: string, body?: unknown) => Response | undefined | Promise<Response | undefined>;
function browser(o: { signedIn?: boolean; hash?: string; fail?: number; profiles?: unknown[]; api?: Api; storage?: Map<string, string> } = {}) {
	const els: Record<string, El> = {};
	const listeners: Record<string, (event?: unknown) => void> = {};
	const html = make("html"), storage = o.storage ?? new Map<string, string>();
	// The data client's /api/viewer/ reads go to `viewer`, so the page reads in `fetched` stay as they were before it.
	const seen: { fetched: string[]; auth: string[]; posted: string[]; bodies: unknown[]; viewer: string[]; mounted?: unknown } = { fetched: [], auth: [], posted: [], bodies: [], viewer: [] };
	const timers: number[] = []; // the data client's retry delays, recorded and never run, so no reconnect outlives its test
	const clerk = {
		user: o.signedIn ? { id: env.OWNER_USER_ID } : null,
		session: { getToken: async () => "session-token" },
		async load() {},
		mountSignIn(target: unknown) { seen.mounted = target; },
	};
	const win = {
		document: { readyState: "complete", getElementById: (id: string) => (els[id] ??= make("div", true)), createElement: (tag: string) => make(tag),
			documentElement: html, addEventListener(type: string, f: (event?: unknown) => void) { listeners[`doc:${type}`] = f; } },
		location: { hash: o.hash ?? "", origin: "https://memory.example" },
		// As in a browser, replaceState changes the address without a hashchange event.
		history: { replaceState: (_s: unknown, _t: string, url: string) => { win.location.hash = url.startsWith("#") ? url : ""; } },
		localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } },
		setTimeout: (_f: () => void, ms: number) => timers.push(ms), clearTimeout() {},
		addEventListener(type: string, f: () => void) { listeners[type] = f; },
		fetch: async (path: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
			if (path.startsWith("/api/viewer/")) seen.viewer.push(path);
			else { seen.fetched.push(path); seen.auth.push(init.headers.authorization!); }
			const body = init.body === undefined ? undefined : JSON.parse(init.body) as unknown;
			if (init.method === "POST") { seen.posted.push(path); seen.bodies.push(body); }
			if (o.fail) return Response.json({ error: "forbidden" }, { status: o.fail });
			const r = await o.api?.(path, init.method ?? "GET", body);
			if (r) return r;
			if (path === "/api/profiles" && o.profiles) return Response.json(o.profiles);
			if (path === "/api/profiles/personal/batch") return Response.json({ error: { code: "unavailable", message: "profile store unreachable" } }, { status: 503 });
			if (path === "/api/profiles/work/batch") return Response.json(BATCH);
			if (path === "/api/viewer/snapshot") return Response.json(SNAPSHOT);
			return Response.json(path === "/api/profiles" ? PROFILES : DEVICES);
		},
		Clerk: clerk,
		__internal_ClerkUICtor: function ClerkUI() {},
	};
	const go = (hash: string) => { win.location.hash = hash; listeners.hashchange!(); };
	// A key pressed with focus on `target` (default: the focused stand-in element); returns whether the shell took it.
	const key = (k: string, target: El | null = active ?? null) => { let taken = false; listeners["doc:keydown"]!({ key: k, target, preventDefault() { taken = true; } }); return taken; };
	return { win, els, seen, listeners, go, key, html, storage, timers, view: () => els.view! };
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

// Every route the dashboard served before the split, and the heading it opened with under the default fixtures (unchanged by the split).
const ROUTES: [string, string][] = [
	["", "Knowledge graph: work"], ["#/", "Knowledge graph: work"], ["#/profiles", "Profiles"], ["#/profiles/work", "Profile: work"],
	["#/profiles/nobody", "No profile named nobody"], ["#/work", "Work: work"], ["#/work/personal", "Work: personal"],
	["#/about", "About you: personal"], ["#/about/work", "About you: work"], ["#/memories", "Memories: work"],
	["#/memories/personal", "Memories: personal"], ["#/memory/work/r1", "Memory"], ["#/graph/work", "Knowledge graph: work"],
	["#/graph/work/r1", "Knowledge graph: work"], ["#/map/work", "Map: work"], ["#/draft", "Write: work"], ["#/draft/work", "Write: work"],
	["#/activity/work", "Activity: work"], ["#/timeline/work", "Timeline: work"], ["#/journals/work", "Journals: work"],
	["#/path/work", "Path finder: work"], ["#/review/work", "Review: work"], ["#/move/work/r1", "Move a record"], ["#/copy/work/r1", "Save a copy"],
	["#/backups", "Backups and recovery"], ["#/routing", "Routing"], ["#/wipe", "Wipe a profile"], ["#/wipe/work", "Wipe profile: work"],
	["#/graph/nobody", "No active profile named nobody"]];
// The shell's nav: each group's label and its links. Only pages that exist today; Admin holds the rest, as the static nav did.
const navOf = (b: ReturnType<typeof browser>) => b.els.nav!.children.map((g) => [g.tag === "details" ? find(g, "summary")[0]!.textContent : find(g, "span")[0]!.textContent,
	find(g, "a").map((a) => `${a.textContent} ${a.attrs.href}`)]);
const NAV = ["Graph #/", "Memories #/memories", "Write #/draft", "Activity #/activity", "Timeline #/timeline", "Journals #/journals", "Paths #/path", "Work #/work",
	"About you #/about", "Review #/review", "Backups #/backups", "Profiles #/profiles", "Routing #/routing", "Moves #/move", "Wipe #/wipe", "Settings /settings"];

// The shell's nav: Graph and Memories, the activity log as Audit, and every other page under Admin in the plan's order (with Map).
// The registered Memories tab takes the built-in Memories entry's place.
const GROUPED_NAV = [["Memory", ["Graph #/graph", "Memories #memories"]], ["System", ["Audit #/activity"]],
	["Admin", ["Write #/draft", "Paths #/path", "Map #/map", "Timeline #/timeline", "Journals #/journals", "Review #/review", "Backups and recovery #/backups",
		"Routing #/routing", "Profiles #/profiles", "Moves #/move", "Wipe #/wipe", "Work #/work", "About you #/about", "Settings /settings"]]];

describe("dashboard", () => {
	it("mounts sign-in and fetches nothing until the owner signs in", async () => {
		const b = browser();
		await dashboardMain(b.win);
		expect(b.els.status!.textContent).toBe("Sign in as the owner.");
		expect(b.seen.mounted).toBe(b.els.signin);
		expect(b.seen.fetched).toEqual([]);
		await settle();
		expect([b.seen.viewer, b.timers]).toEqual([[], []]); // no snapshot or stream before sign-in
		expect(DASHBOARD_HTML(env)).toContain(`data-clerk-publishable-key="${env.CLERK_PUBLISHABLE_KEY}"`);
	});

	it("shows one card per profile from the real endpoints, fills bounded server figures, and never makes up a count it could not read", async () => {
		const b = browser({ signedIn: true, hash: "#/profiles", api: (path) => {
			if (path === "/api/profiles/work/graph?part=nodes&limit=1") return Response.json({ part: "nodes", items: [], next_after: "x", done: false, total: 1377 });
			if (path === "/api/profiles/personal/graph?part=nodes&limit=1") return Response.json({ part: "nodes", items: [], next_after: "x", done: false, total: null });
			if (path === "/api/profiles/work/board?limit=1") return Response.json({ ...workBoard(), total: 4 });
			if (path === "/api/profiles/personal/board?limit=1") return Response.json({ error: { code: "unavailable", message: "board unreachable" } }, { status: 503 });
			if (path.endsWith("/activity?limit=3")) return Response.json({ items: path.includes("/work/") ? [{ id: 9, at: "2026-10-30T10:00:00Z", actor: "agent", op: "save", summary: HOSTILE }] : [] });
			if (path === "/api/recovery") return Response.json({ recovery: null, last_export: { at: "2026-10-30T02:00:00Z", results: {} } });
			if (path === "/api/review?limit=100") return Response.json({ items: [{ id: "m:1", kind: "migration" }, { id: "c:1", kind: "collision" }], next_after: null });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.fetched.sort()).toEqual(["/api/devices", "/api/profiles", "/api/profiles/personal/activity?limit=3", "/api/profiles/personal/batch", "/api/profiles/personal/board?limit=1",
			"/api/profiles/personal/graph?part=nodes&limit=1", "/api/profiles/work/activity?limit=3", "/api/profiles/work/batch", "/api/profiles/work/board?limit=1", "/api/profiles/work/graph?part=nodes&limit=1",
			"/api/recovery", "/api/review?limit=100"]);
		expect(b.seen.auth).toEqual(Array(12).fill("Bearer session-token"));
		expect(b.seen.posted).toEqual([]);
		expect(b.els.status!.textContent).toBe("Signed in.");
		expect(b.view().hidden).toBe(false);
		const cards = find(b.view(), "section");
		expect(cards.map((c) => find(c, "a")[0]!.attrs.href)).toEqual(["#/profiles/personal", "#/profiles/work"]);
		// work: laptop is active and defaults to it; old-box is revoked, so it does not count as active.
		expect(text(cards[1]!)).toContain("Active devices 1 Default for 1 device(s) Last use by its devices 2026-10-29");
		// Bounded reads only: a counted total, an uncountable one and a failed one each say so; nothing becomes a made-up zero.
		expect(text(cards[1]!)).toContain("Records 1,377");
		expect(text(cards[1]!)).toContain("Open work 4 items (uploaded work only)");
		expect(text(cards[1]!)).toContain("Recent changes 2026-10-30 save by agent");
		expect(text(cards[1]!)).not.toContain(HOSTILE);
		expect(text(cards[1]!)).toContain("Projects, people, decisions Counted once its graph is open in this tab");
		expect(text(cards[1]!)).toContain("Storage used Not available");
		expect(text(cards[0]!)).toContain("Records Too many to count in one read");
		expect(text(cards[0]!)).toContain("Open work Could not read: board unreachable");
		expect(text(cards[0]!)).not.toMatch(/Records 0|Open work 0/);
		expect(text(b.view())).toContain("Last backup Taken 2026-10-30");
		expect(text(b.view())).toContain("Waiting in Review 1 migrated records, 1 stopped moves");
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

	it("serves every existing page from the split parts through the served /app.js, at its old route, under the unchanged nav", async () => {
		// The pages now live in separate serialized parts; one that used anything but `am` and browser globals fails here.
		const nav = /<nav[^>]*aria-label="Dashboard">(.*?)<\/nav>/.exec(DASHBOARD_HTML(env))![1]!;
		expect([...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`)).toEqual(NAV);
		const response = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/app.js`)), script = await response.text();
		// The shared replay player's exact bytes come right after the directive, before any part runs.
		expect(script.startsWith(`"use strict";\n${REPLAY_PLAYER}\nvar __name = (fn) => fn;\n`)).toBe(true);
		const b = browser({ signedIn: true, hash: "#/profiles" });
		new Function("window", script)(b.win);
		// In a browser globalThis is window; here the player's global lands on the test's globalThis.
		const g = globalThis as unknown as { amReplayPlayer?: { mount: unknown } };
		expect(typeof g.amReplayPlayer?.mount).toBe("function");
		delete g.amReplayPlayer;
		await settle();
		const seen: [string, string][] = [];
		for (const [hash] of ROUTES) { b.go(hash); await settle(); seen.push([hash, find(b.view(), "h2")[0]?.textContent ?? ""]); }
		expect(seen).toEqual(ROUTES);
		expect(navOf(b)).toEqual(GROUPED_NAV); // the shell replaces the static nav with the same pages, grouped
	});

	it("reports an API refusal instead of showing an empty dashboard", async () => {
		const b = browser({ signedIn: true, fail: 403 });
		await dashboardMain(b.win);
		expect(b.els.status!.textContent).toBe("Could not load the dashboard: forbidden");
		expect(b.els.view).toBeUndefined(); // never looked up, so never shown
	});
});

describe("dashboard shell", () => {
	it("groups only today's pages, marks the current one, and opens the newer deep links on today's pages", async () => {
		const b = browser({ signedIn: true, hash: "#/memory/work/r1" });
		await dashboardMain(b.win);
		expect(navOf(b)).toEqual(GROUPED_NAV);
		const current = () => find(b.els.nav!, "a").filter((a) => a.attrs["aria-current"] === "page").map((a) => a.textContent);
		expect(current()).toEqual(["Memories"]);
		expect(text(b.els.nav!)).not.toMatch(/Overview|Lessons|Crystals|Sessions|Actions|Replay|Health|Live|features/i);
		b.go("#memories/r1?profile=personal");
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Memories: personal"); // the Memories tab: the list with r1's detail panel
		expect(b.seen.fetched).toContain("/api/profiles/personal/nodes/r1");
		expect(current()).toEqual(["Memories"]);
		b.go("#audit");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Activity: work");
		expect(current()).toEqual(["Audit"]);
		b.go("#memories?profile=nobody");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Memories: no active profile named nobody"); // the shell refuses it before the tab reads
		expect(text(b.view())).toContain("Nothing was read.");
		b.go("#/backups");
		expect(current()).toEqual(["Backups and recovery"]);
		expect(b.els.nav!.children.at(-1)!.attrs.class).toBe("navgroup current");
		b.go("");
		expect(current()).toEqual(["Graph"]);
		// Once an Overview tab registers, the site root opens it; Graph's link and #/graph/NAME still open the graph.
		const am = (b.win as unknown as { __am: { tab(d: unknown): void; render(f: boolean): void; el(t: string, p?: El, x?: string): El } }).__am;
		am.tab({ id: "overview", group: null, label: "Overview", key: "o", render: (root: El) => am.el("h2", root, "Overview") });
		for (const [hash, heading, mark] of [["", "Overview", "Overview"], ["#/", "Overview", "Overview"], ["#/graph", "Knowledge graph: work", "Graph"],
			["#/graph/personal", "Knowledge graph: personal", "Graph"]]) {
			b.go(hash!);
			expect([find(b.view(), "h2")[0]!.textContent, current()]).toEqual([heading, [mark]]);
		}
		expect(find(b.els.nav!, "a").find((a) => a.textContent === "Graph")!.attrs.href).toBe("#/graph");
	});

	it("takes g then a letter, / for search, ? for the glossary and Esc, but not while typing", async () => {
		const b = browser({ signedIn: true, hash: "#/memories" });
		await dashboardMain(b.win);
		const search = find(b.view(), "input").find((i) => i.attrs.type === "search")!;
		expect(b.key("/", null)).toBe(true);
		expect(active).toBe(search);
		expect(b.key("g", search)).toBe(false); // typing in the search box
		expect(b.key("u", search)).toBe(false);
		expect(b.win.location.hash).toBe("#/memories");
		b.key("g", null);
		expect(b.key("u", null)).toBe(true);
		expect(b.win.location.hash).toBe("#/activity");
		expect(b.key("?", null)).toBe(true);
		expect(b.els.gloss!.hidden).toBe(false);
		expect(find(b.els.gloss!, "dt").map((d) => d.textContent)).toEqual(expect.arrayContaining(["Graph", "Memories", "Audit", "Undo", "g, then a letter"]));
		expect(text(b.els.gloss!)).toContain("g Graph, u Audit, m Memories");
		expect(b.key("Escape", null)).toBe(true);
		expect(b.els.gloss!.hidden).toBe(true);
		const am = (b.win as unknown as { __am: { help(p: El, t: string): void; el(t: string): El } }).__am, box = am.el("p");
		am.help(box, "undo");
		const tip = find(box, "span")[1]!, q = find(box, "button")[0]!;
		click(q);
		expect([tip.hidden, q.attrs["aria-expanded"]]).toEqual([false, "true"]);
		expect(b.key("Escape", search)).toBe(true); // Esc works even while typing
		expect([tip.hidden, q.attrs["aria-expanded"]]).toEqual([true, "false"]);
		am.help(box, "no-such-term");
		expect(find(box, "button")).toHaveLength(1);
	});

	it("follows the system theme until the owner picks one, and keeps the pick", async () => {
		const plain = browser({ signedIn: true });
		await dashboardMain(plain.win);
		expect(plain.html.attrs["data-theme"]).toBeUndefined();
		const b = browser({ signedIn: true, storage: new Map([["am.theme", "dark"]]) });
		await dashboardMain(b.win);
		expect(b.html.attrs["data-theme"]).toBe("dark");
		const toggle = find(b.els.tools!, "button").find((x) => x.attrs["aria-label"]?.startsWith("Use the"))!;
		expect([toggle.textContent, toggle.attrs["aria-label"]]).toEqual(["Light", "Use the light theme"]);
		click(toggle);
		expect([b.html.attrs["data-theme"], b.storage.get("am.theme"), toggle.textContent]).toEqual(["light", "light", "Dark"]);
		expect(text(b.els.tools!)).not.toMatch(/live|features|version|all profiles/i);
	});

	it("copies commands with the token as a variable: the owner's for /api, a device token for /mcp, and the MCP form the Worker serves", async () => {
		const b = browser({ signedIn: true });
		await dashboardMain(b.win);
		const am = (b.win as unknown as { __am: { curl(m: string, p: string, body?: unknown): string; mcpCurl(t: string, a: Record<string, unknown>): string } }).__am;
		const owner = am.curl("GET", "/api/profiles/work/nodes/r1"), device = am.curl("POST", "/v1/recall", { keyword: "it's" });
		expect(owner).toContain(`-H "Authorization: Bearer $AGENT_MEMORY_OWNER_TOKEN"`);
		expect(device).toContain(`-H "Authorization: Bearer $AGENT_MEMORY_TOKEN"`);
		expect(device).toContain(`--data '{"keyword":"it'\\''s"}'`);
		const mcp = am.mcpCurl("recall_memories", { keyword: "split", profile: "work" });
		for (const cmd of [owner, device, mcp]) expect(cmd).not.toContain("session-token");
		// Run the copied MCP command against the Worker with a real read token in place of the variable.
		const { token } = await deviceToken(`copy-${Date.now()}`, ["read"], ["work"], "work");
		const quoted = [...mcp.matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2]!).replaceAll("'\\''", "'"));
		const url = quoted[0]!, headers = new Headers(quoted.filter((q) => /^[a-z-]+: /i.test(q)).map((h) => h.split(/: (.*)/s).slice(0, 2) as [string, string]));
		headers.set("authorization", headers.get("authorization")!.replace("$AGENT_MEMORY_TOKEN", token));
		const res = await exports.default.fetch(new Request(url.replace("https://memory.example", new URL(env.RESOURCE_URL).origin), { method: "POST", headers, body: quoted.find((q) => q.startsWith("{"))! }));
		const body = await res.text(), data = JSON.parse(body.startsWith("{") ? body : body.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
		expect(res.status).toBe(200);
		expect(data.result.isError).toBeFalsy();
	});
});

describe("dashboard live chrome", () => {
	it("shows no numbers, version or live state until the data client reports them, then only what it reported", async () => {
		const refused = browser({ signedIn: true, api: (path) => path === "/api/viewer/snapshot" ? Response.json({ error: { code: "not_found", message: "no snapshot" } }, { status: 404 }) : undefined });
		await dashboardMain(refused.win);
		for (let i = 0; i < 3; i++) await settle();
		const tools = (b: ReturnType<typeof browser>) => text(b.els.tools!);
		expect([refused.els.pause!.hidden, refused.els.pause!.textContent]).toEqual([false, "Live updates paused. No numbers have loaded yet."]);
		expect(tools(refused)).toContain("Paused");
		expect(tools(refused)).not.toMatch(/features|live\b/i);
		expect([refused.els.ver!.textContent, find(refused.els.foot!, "span")[0]!.textContent]).toEqual(["", ""]);
		expect(refused.seen.viewer).toEqual(["/api/viewer/snapshot"]); // read only after sign-in
		expect(refused.timers).toEqual([1000]); // one retry, scheduled, not run

		let stream!: ReadableStreamDefaultController<Uint8Array>;
		const frame = `event: change\ndata: ${JSON.stringify({ kind: "MEMORY", profile: "work", id: "r1", summary: "Saved a memory", at: SNAPSHOT.at })}\nid: 1\n\n`;
		const b = browser({ signedIn: true, api: (path) => path.startsWith("/api/viewer/events?cursor=c1") ? new Response(new ReadableStream<Uint8Array>({
			start(c) { stream = c; c.enqueue(new TextEncoder().encode(frame)); } }), { headers: { "content-type": "text/event-stream" } }) : undefined });
		await dashboardMain(b.win);
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.viewer).toEqual(["/api/viewer/snapshot", "/api/viewer/events?cursor=c1"]);
		expect(b.els.ver!.textContent).toBe("9f2c4e1a");
		expect(b.els.pause!.hidden).toBe(true);
		const chips = find(b.els.tools!, "span").filter((x) => x.attrs.class?.startsWith("chip"));
		expect(chips.map((x) => [x.textContent, x.attrs.class, x.hidden])).toEqual([["Live", "chip c-ok", false]]);
		expect(find(b.els.foot!, "span")[0]!.textContent).toMatch(new RegExp(`^Agent Memory ${SNAPSHOT.version} · full sync ${hhmm(SNAPSHOT.at)}, live since \\d\\d:\\d\\d$`));
		const features = find(b.els.tools!, "button").find((x) => x.textContent === "1 of 2 features on")!;
		click(features);
		expect(text(b.els.features!)).toContain("Prompt injection");
		expect(text(b.els.features!)).toContain("To turn it on: Run agent-memory install --inject.");
		expect(text(b.els.features!)).toContain("Affects: Memories.");
		// A tab registered with a count shows the snapshot's number, labelled as covering every profile; built-in pages show none.
		const am = (b.win as unknown as { __am: { tab(d: unknown): void; render(f: boolean): void; el(t: string, p?: El, x?: string): El } }).__am;
		am.tab({ id: "lessons", group: "memory", label: "Lessons", key: "l", count: (s: typeof SNAPSHOT) => s.counts.lessons, render: (root: El) => am.el("h2", root, "Lessons") });
		am.render(false);
		expect(find(b.els.nav!, "a").map((a) => text(a).replace(/\s+/g, " "))).toEqual(expect.arrayContaining(["Graph", "Memories 12 across all profiles", "Lessons 7 across all profiles", "Audit"]));
		b.listeners.pagehide!(); // the client lets go of its connection before the test closes the stream
		stream.close();
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
		// Every write control waits; a glossary ? beside the intro is not a write, so it stays usable.
		expect(find(b.view(), "button").filter((x) => x.textContent !== "Load more" && x.attrs.class !== "help").every((x) => x.disabled)).toBe(true);
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
		const ask = find(b.view(), "span").find((x) => x.textContent.startsWith("Forget “"))!; // not the intro's spans
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
			if (path.startsWith("/api/profiles/work/map?")) return Response.json({ center: null, starts: ["p1"], depth: 1, nodes: [{ id: "p1", kind: "project", name: "Existing project", status: "active" }], links: [], truncated: false, limits: { nodes: 300 } });
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
		b.go("#/map/work");
		await settle();
		click(find(b.view(), "button").find((e) => e.attrs.class === "node")!);
		typeIn(byId(b.view(), "whatif-name"), "A different draft");
		submit(b.view(), 1);
		await settle();
		click(button(b.view(), "Make a draft"));
		expect(text(b.view())).toContain("There is an unsaved draft in this profile");
		expect(b.seen.posted).toHaveLength(1);
		b.go("#/draft/work");
		expect(byId(b.view(), "draft-name").value).toBe("Retry control");
		expect(byId(b.view(), "draft-desc").value).toBe("Description");
		submit(b.view()); // previewing the unchanged body again keeps its request id
		click(button(b.view(), "Save"));
		await settle();
		const [first, second] = b.seen.bodies as Record<string, unknown>[];
		expect(second).toEqual(first);
		expect(status(b).textContent).toContain("Saved: created “Retry control”, revision 1.");
		expect(byId(b.view(), "draft-name").value).toBe("");
	});

	it("renames a record from Edit as a draft: new_name only when changed, with its revision, and a fresh request id only for a changed body", async () => {
		let saves = 0;
		const b = browser({ signedIn: true, hash: "#/memory/work/m1", api: (path, method, body) => {
			if (path === "/api/profiles/work/nodes/m1") return Response.json(entity());
			if (path === "/api/profiles/work/save" && method === "POST") {
				if (++saves === 1) throw new Error("response lost after commit");
				return Response.json({ ok: true, action: "updated", memory_id: "m1", name: (body as { new_name?: string }).new_name, revision: 4 });
			}
		} });
		await dashboardMain(b.win);
		await settle();
		click(button(b.view(), "Edit as a draft"));
		b.go("#/draft/work");
		const name = byId(b.view(), "draft-name");
		expect([name.value, name.disabled, byId(b.view(), "draft-type").disabled, byId(b.view(), "draft-scope").disabled]).toEqual([HOSTILE, false, true, true]);
		submit(b.view());
		expect(text(b.view())).toContain("Name unchanged");
		typeIn(byId(b.view(), "draft-name"), "");
		expect(button(b.view(), "Save").disabled).toBe(true); // a changed name needs a new preview
		submit(b.view());
		expect(status(b).textContent).toBe("Give the memory a name.");
		typeIn(byId(b.view(), "draft-name"), "  Use SQLite ");
		submit(b.view());
		expect(text(b.view())).toContain(`Renamed from “${HOSTILE}” to “Use SQLite”`);
		click(button(b.view(), "Save"));
		await settle();
		expect(status(b).textContent).toContain("response lost after commit");
		b.go("#/draft/work"); // the draft survives a re-render and still knows the record's own name
		expect(text(b.view())).toContain(`Editing “${HOSTILE}” at revision 3`);
		submit(b.view());
		click(button(b.view(), "Save"));
		await settle();
		const [first, second] = b.seen.bodies as Record<string, unknown>[];
		expect(first).toMatchObject({ memory_id: "m1", expected_revision: 3, new_name: "Use SQLite", description: "Why we chose it", content: "Line one\nLine two" });
		expect(first).not.toHaveProperty("name");
		expect(second).toEqual(first); // the unchanged retry replays under the same request id
		expect(status(b).textContent).toContain("Saved: updated “Use SQLite”, revision 4.");
		b.go("#/memory/work/m1");
		await settle();
		click(button(b.view(), "Edit as a draft"));
		b.go("#/draft/work");
		typeIn(byId(b.view(), "draft-desc"), "A changed summary");
		submit(b.view());
		click(button(b.view(), "Save"));
		await settle();
		const third = b.seen.bodies[2] as Record<string, unknown>;
		expect(third).not.toHaveProperty("new_name"); // an unchanged name is not sent
		expect(third).toMatchObject({ memory_id: "m1", expected_revision: 3, description: "A changed summary" });
		expect(third.request_id).not.toBe(first!.request_id);
		expect(b.seen.posted).toEqual(Array(3).fill("/api/profiles/work/save"));
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

	it("edits routing rules as one list after a validated preview, saves without ids, resends an unconfirmed save unchanged, rereads, and tests the saved rules read only", async () => {
		let saved = [{ id: "r1", priority: 10, match: "remote", pattern: "github.com/acme/*", profile: "work", enabled: true }], lose = true;
		const puts: unknown[] = [], late = gate();
		let tests = 0;
		const b = browser({ signedIn: true, hash: "#/routing", api: async (path, method, body) => {
			if (path === "/api/rules" && method === "GET") return Response.json({ rules: saved, profiles: ["personal", "work"] });
			if (path === "/api/rules" && method === "PUT") {
				puts.push(body);
				if (lose) { lose = false; return Response.json({ error: { code: "unavailable", message: "lost" } }, { status: 503 }); }
				saved = (body as { rules: typeof saved }).rules.map((r, i) => ({ ...r, id: `r${i + 1}` }));
				return Response.json({ rules: saved.length });
			}
			if (path === "/api/rules/test" && method === "POST") {
				if (++tests === 1) { await late.wait; return Response.json({ remote: "github.com/acme/x", path: null, rule: saved[0], write: { profile: "work", routed_by: "rule" }, read: { primary: "work", with_me: true, routed_by: "rule" } }); }
				return Response.json({ remote: "github.com/other/y", path: null, rule: null, write: { error: { code: "validation", message: "route_required" } }, read: { primary: "me", with_me: false, routed_by: "fallback" } });
			}
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 4; i++) await settle();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		expect(byId(b.view(), "rule-1-pattern").value).toBe("github.com/acme/*");
		click(button(b.view(), "Add a rule"));
		expect(button(b.view(), "Save rules").disabled).toBe(true);
		click(button(b.view(), "Preview"));
		expect(flat()).toContain("Rule 2: the pattern must be 1 to 300 characters.");
		expect(button(b.view(), "Save rules").disabled).toBe(true);
		typeIn(byId(b.view(), "rule-2-pattern"), "/Users/owner/personal");
		const m = byId(b.view(), "rule-2-match"); m.value = "path"; m.on.change!();
		const pf = byId(b.view(), "rule-2-profile"); pf.value = "personal"; pf.on.change!();
		click(button(b.view(), "Preview"));
		expect(flat()).toContain("1. remote “github.com/acme/*” → work at priority 10; 2. path “/Users/owner/personal” → personal at priority 20");
		click(button(b.view(), "Save rules"));
		for (let i = 0; i < 4; i++) await settle();
		const sent = { rules: [{ priority: 10, match: "remote", pattern: "github.com/acme/*", profile: "work", enabled: true }, { priority: 20, match: "path", pattern: "/Users/owner/personal", profile: "personal", enabled: true }] };
		expect(puts).toEqual([sent]); // the whole list, in order, with no ids or version
		expect(flat()).toContain("Saving may or may not have happened");
		click(button(b.view(), "Save the same list again"));
		for (let i = 0; i < 4; i++) await settle();
		expect(puts).toEqual([sent, sent]);
		expect(status(b).textContent).toContain("Saved 2 rules.");
		expect(flat()).toContain("Rules (2 saved)"); // read again from the server; this tab's list is gone
		expect(b.seen.fetched.filter((x) => x === "/api/rules").length).toBeGreaterThanOrEqual(3);
		// The test reads the saved rules only; a slower earlier answer never replaces the latest one.
		const tf = find(b.view(), "form").find((f) => find(f, "input").some((i) => i.attrs.id === "route-remote"))!;
		typeIn(byId(b.view(), "route-remote"), "github.com/acme/x");
		void tf.on.submit!({ preventDefault() {} });
		typeIn(byId(b.view(), "route-remote"), "github.com/other/y");
		void tf.on.submit!({ preventDefault() {} });
		for (let i = 0; i < 3; i++) await settle();
		late.open();
		for (let i = 0; i < 3; i++) await settle();
		expect(flat()).toContain("Matching rule No enabled rule matches");
		expect(flat()).toContain("A write goes to Refused: route_required");
		expect(flat()).toContain("A recall reads me (fallback)");
		expect(flat()).not.toContain("github.com/acme/x");
		expect(b.seen.posted.filter((x) => x === "/api/rules/test")).toHaveLength(2);
		expect(puts).toHaveLength(2);
	});

	it("shows the open recovery's id, keeps an opened point-in-time restore's id to reverse it, and drills the generation read after the restore", async () => {
		const RID = "0b6c3a1e-4d2f-4a8b-9c1d-2e3f4a5b6c7d", NEXT = "1c7d4b2f-5e3a-4b9c-8d2e-3f4a5b6c7d8e";
		let opened = false;
		const b = browser({ signedIn: true, hash: "#/backups", api: (path, method) => {
			// The restore gave work a new generation; the startup list still says bbbb.
			if (path === "/api/profiles" && opened) return Response.json(PROFILES.map((p) => p.name === "work" ? { ...p, generation: "cccc" } : p));
			if (path === "/api/recovery") return Response.json({ recovery: opened ? null : { id: RID, kind: "pitr", profile: "work", export: "", export_at: "2026-10-31T00:00:00Z", at: "2026-11-01T00:00:00Z",
				state: "ready", unresolved: [], unresolved_count: 0 }, last_export: null });
			if (path === "/api/recovery/open" && method === "POST") { opened = true; return Response.json({ id: RID, kind: "pitr", state: "opened" }); }
			if (path === "/api/backups/drill" && method === "GET") return Response.json({ drill: null, last: null });
			if (path === "/api/backups/drill" && method === "POST") return Response.json({ id: "d1", state: "restoring" });
			if (path === "/api/profiles/work/pitr" && method === "POST") return Response.json({ id: NEXT, kind: "pitr", profile: "work", state: "reconciling" });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 4; i++) await settle();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		expect(flat()).toContain(`Restore id ${RID}`);
		click(button(b.view(), "Open"));
		for (let i = 0; i < 4; i++) await settle();
		expect(status(b).textContent).toContain(`Recovery ${RID} is now opened.`);
		expect(flat()).toContain("No recovery is open");
		byId(b.view(), "drill-profile").value = "work";
		find(b.view(), "form").find((f) => find(f, "select").some((x) => x.attrs.id === "drill-profile"))!.on.submit!({ preventDefault() {} });
		for (let i = 0; i < 4; i++) await settle();
		expect(flat()).toContain(`Opened in this tab: point-in-time restore ${RID} of work.`); // still shown after another action replaced the status
		byId(b.view(), "pitr-profile").value = "work";
		typeIn(byId(b.view(), "pitr-undo"), RID);
		typeIn(byId(b.view(), "confirm-begin-point-in-time-restore"), "restore in time");
		click(button(b.view(), "Begin point-in-time restore"));
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.posted).toEqual(["/api/recovery/open", "/api/backups/drill", "/api/profiles/work/pitr"]);
		expect(b.seen.bodies).toEqual([{ id: RID }, { profile: "work", generation: "cccc", request_id: expect.stringMatching(/^dashboard:/) }, { undo: RID }]);
		expect(status(b).textContent).toContain(`Recovery ${NEXT} begun: reconciling.`);
	});

	it("begins a restore drill only by an explicit request for the shown generation, resends an unconfirmed begin unchanged, steps and cleans up by hand, and passes only a server-passed, cleaned drill", async () => {
		const done = { id: "d1", request_id: "", profile: "work", live_generation: "bbbb", scratch: "s9", export: "e2", export_at: "2026-10-30T00:00:00Z", account_export: "a1", state: "done", at: "2026-11-01T00:00:00Z",
			finished_at: "2026-11-01T00:10:00Z", passed: true, report: { chunks: 3, rows: { nodes: 10, texts: 4 }, nodes: 10, requests: 6, vectors: 5, owned_elsewhere: 0, requests_elsewhere: 0, wiped: 0,
				account: { export: "a1", chunks: 2, rows: 42 }, live_generation_unchanged: true, cleaned: { vectors: 5, scratch: true } } };
		let open: Record<string, unknown> | null = null, last: Record<string, unknown> | null = { ...done, id: "d0", report: { ...done.report, cleaned: { vectors: 0, scratch: false } } }, lose = true;
		const begins: Record<string, unknown>[] = [];
		const b = browser({ signedIn: true, hash: "#/backups", api: (path, method, body) => {
			if (path === "/api/recovery") return Response.json({ recovery: null, last_export: null });
			if (path === "/api/backups/drill" && method === "GET") return Response.json({ drill: open, last });
			if (path === "/api/backups/drill" && method === "POST") {
				begins.push(body as Record<string, unknown>);
				if (lose) { lose = false; return Response.json({ error: { code: "unavailable", message: "lost" } }, { status: 503 }); }
				open = { ...done, request_id: (body as { request_id: string }).request_id, state: "restoring", passed: undefined, report: undefined, finished_at: undefined };
				return Response.json(open);
			}
			if (path === "/api/backups/drill/step" && method === "POST") { open = { ...open!, state: "checking" }; return Response.json(open); }
			if (path === "/api/backups/drill/cleanup" && method === "POST") { last = { ...done, request_id: String(open!.request_id) }; open = null; return Response.json(last); }
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 4; i++) await settle();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		// A drill whose checks passed but whose cleanup is not confirmed is not a pass.
		expect(flat()).toContain("Checks passed, but the cleanup of the scratch copy is not confirmed.");
		expect(flat()).not.toContain("Passed: every check passed");
		expect(b.seen.posted).toEqual([]);
		const pick = byId(b.view(), "drill-profile");
		pick.value = "work";
		find(b.view(), "form").find((f) => find(f, "select").some((x) => x.attrs.id === "drill-profile"))!.on.submit!({ preventDefault() {} });
		for (let i = 0; i < 4; i++) await settle();
		expect(begins[0]).toEqual({ profile: "work", generation: "bbbb", request_id: expect.stringMatching(/^dashboard:/) });
		expect(flat()).toContain("may or may not have begun");
		click(button(b.view(), "Send the same drill request again"));
		for (let i = 0; i < 4; i++) await settle();
		expect(begins[1]).toEqual(begins[0]);
		expect(flat()).toContain("Drill in progress");
		const posted = b.seen.posted.length;
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.posted.length).toBe(posted); // no step runs by itself
		click(button(b.view(), "Run the next drill step"));
		for (let i = 0; i < 4; i++) await settle();
		expect(flat()).toContain("State checking");
		click(button(b.view(), "Stop and clean up"));
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.posted).toEqual(["/api/backups/drill", "/api/backups/drill", "/api/backups/drill/step", "/api/backups/drill/cleanup"]);
		expect(b.seen.bodies.slice(2)).toEqual([{ id: "d1" }, { id: "d1" }]);
		expect(flat()).toContain("Passed: every check passed and the scratch copy was cleaned up.");
		expect(flat()).toContain("Rows restored nodes 10, texts 4");
		// The backend's account check counts rows as one number (account/store.ts Drill report); it must show, not vanish.
		expect.soft(flat()).toContain("Account export a1: 2 chunks checked, 42 rows");
	});

	// Recovery copy choices (section 18, step 4): both copies as the server reads them now, and the owner's explicit choice.
	const copyOf = (status: string, revision: number, extra: Record<string, unknown> = {}) => ({ status, revision, kind: "document", name: `Copy ${revision}`, description: "", updated_at: "2026-10-31T00:00:00Z",
		flagged: null, chars: 10, content_hash: "h".repeat(8), transfer: null, incoming: null, rows: [], ...extra });
	const side = (profile: string, generation: string | null, copy: unknown, keepable: boolean) => ({ profile, generation, copy, keepable });
	const keepForm = (b: ReturnType<typeof browser>, node: string) => find(b.view(), "form").find((f) => find(f, "select").some((x) => x.attrs.id === `keep-${node}`))!;
	const preview = (b: ReturnType<typeof browser>, node: string, keep: string) => { const f = keepForm(b, node); find(f, "select")[0]!.value = keep; f.on.submit!({ preventDefault() {} }); };
	const keepBtn = (b: ReturnType<typeof browser>, node: string) => find(b.view(), "button").find((x) => x.attrs["aria-label"] === `Keep the chosen copy of ${node}`)!;
	const many = async () => { for (let i = 0; i < 6; i++) await settle(); };

	it("shows both copies as text, keeps only a keepable copy after a preview with the shown expectations, retries a lost answer exactly and rereads a changed copy before a new id", async () => {
		let n2 = 2, lost = true, changed = true;
		const resolves: Record<string, unknown>[] = [];
		const b = browser({ signedIn: true, hash: "#/backups", api: (path, method, body) => {
			if (path === "/api/recovery") return Response.json({ recovery: { id: "rB", profile: "work", export: "e2", at: "2026-10-31T00:00:00Z", state: "unresolved", conflicts: { total: 3, open: 3 },
				unresolved: [{ kind: "wipe_not_in_export", id: "t1" }, { kind: "owned_elsewhere", id: "n1" }], unresolved_count: 4 }, last_export: null });
			if (path.startsWith("/api/recovery/conflicts?")) return Response.json({ recovery: "rB", state: "unresolved", open: 3, next: null, conflicts: [
				{ node: "n1", kind: "owned_elsewhere", transfer: "t-1", state: "open", copies: [side("work", "g1", copyOf("active", 3, { name: HOSTILE, description: HOSTILE }), true),
					side("personal", "g2", copyOf("incoming", 1, { incoming: { id: "t-1", from: "work" } }), false)] },
				{ node: "n2", kind: "transfer_settle_failed", transfer: "t-2", state: "open", copies: [side("work", "g1", copyOf("moved", 4, { transfer: "t-2", restorable: { ok: true } }), true),
					side("personal", "g2", copyOf("active", n2), true)] },
				{ node: "n3", kind: "transfer_unmatched", transfer: "t-3", state: "open", copies: [side("work", "g1", copyOf("moved", 6, { transfer: "t-3", restorable: { ok: false, reason: "redacted" } }), false),
					side("personal", null, null, false)] }] });
			if (path === "/api/recovery/conflicts/resolve" && method === "POST") {
				const q = body as Record<string, unknown>;
				resolves.push(q);
				if (q.node === "n1" && lost) { lost = false; return Response.json({ error: { code: "unavailable", message: "lost" } }, { status: 503 }); }
				if (q.node === "n2" && changed) { changed = false; n2 = 5; return Response.json({ error: { code: "busy", message: "a copy changed", details: { reason: "copy_changed", profile: "personal" } } }, { status: 400 }); }
				return Response.json({ node: q.node, kept: q.keep, tombstoned: q.keep === "work" ? "personal" : "work", recovery: "rB" });
			}
		} });
		await dashboardMain(b.win);
		await many();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		// Copies are text: a hostile name and description render as text, and nothing is sent by reading them.
		expect(find(b.view(), "img")).toEqual([]);
		expect(flat()).toContain(`Name ${HOSTILE}`);
		expect(flat()).toContain("Unpublished landing from work");
		expect(flat()).toContain("Restorable from its archive No: redacted");
		expect(flat()).toContain("Neither copy can be kept as it is; only abort is possible for this record.");
		expect(flat()).toContain("those that are not copy choices below can only be aborted");
		expect(b.seen.posted).toEqual([]);
		// Only keepable copies are offered; an incoming copy is not.
		expect(find(find(keepForm(b, "n1"), "select")[0]!, "option").map((o) => o.attrs.value)).toEqual(["work"]);
		expect(keepForm(b, "n3")).toBeUndefined();
		expect(keepBtn(b, "n1").disabled).toBe(true);
		preview(b, "n1", "work");
		expect(flat()).toContain("Preview: keep");
		expect(flat()).toContain("Nothing in personal is tombstoned");
		click(keepBtn(b, "n1"));
		await many();
		expect(resolves[0]).toEqual({ id: "rB", node: "n1", keep: "work", request_id: expect.stringMatching(/^dashboard:/),
			expect: [{ profile: "work", generation: "g1", status: "active", revision: 3 }, { profile: "personal", generation: "g2", status: "incoming", revision: 1 }] });
		expect(flat()).toContain("Result unconfirmed");
		// One choice at a time: another record cannot be chosen while this one is unconfirmed.
		preview(b, "n2", "personal");
		expect(keepBtn(b, "n2").disabled).toBe(true);
		click(button(b.view(), "Send the same choice again"));
		await many();
		expect(resolves[1]).toEqual(resolves[0]);
		expect(status(b).textContent).toContain("Kept the copy in work; the copy in personal is now a flagged tombstone");
		// A changed copy: nothing chosen, an explicit reread, then a new preview against the new copy under a new id.
		preview(b, "n2", "personal");
		click(keepBtn(b, "n2"));
		await many();
		expect(resolves[2]).toMatchObject({ node: "n2", keep: "personal", expect: [{ profile: "work", status: "moved", revision: 4 }, { profile: "personal", status: "active", revision: 2 }] });
		expect(flat()).toContain("A copy changed since it was shown");
		expect(keepForm(b, "n2")).toBeUndefined();
		click(button(b.view(), "Read the copies again"));
		await many();
		preview(b, "n2", "personal");
		click(keepBtn(b, "n2"));
		await many();
		expect(resolves[3]).toMatchObject({ node: "n2", expect: [{ profile: "work", revision: 4 }, { profile: "personal", revision: 5 }] });
		expect(resolves[3]!.request_id).not.toBe(resolves[2]!.request_id);
		expect(b.seen.posted.every((x) => x === "/api/recovery/conflicts/resolve")).toBe(true);
	});

	it("continues a lost tab's unfinished choice only from the server's resume body on a click, one at a time, then follows server state through step, open, precheck failure and abort", async () => {
		let phase = "unresolved";
		const resume = { id: "rC", node: "n1", keep: "work", request_id: "dashboard:original-choice",
			expect: [{ profile: "work", generation: "g1", status: "active", revision: 3 }, { profile: "personal", generation: "g2", status: "active", revision: 2 }] };
		const resolves: unknown[] = [];
		let progress = true;
		const b = browser({ signedIn: true, hash: "#/backups", api: (path, method, body) => {
			if (path === "/api/recovery") return Response.json({ recovery: { id: "rC", kind: "account", export: "a1", at: "2026-10-31T00:00:00Z", state: phase,
				...(phase === "unresolved" && resolves.length < 2 ? { conflicts: { total: 2, open: 2 }, resolving: "n1" } : {}),
				unresolved: phase === "unresolved" && resolves.length >= 2 ? [{ kind: "open_precheck_failed", id: "n9" }] : [], unresolved_count: phase === "unresolved" && resolves.length >= 2 ? 1 : 0 }, last_export: null });
			if (path.startsWith("/api/recovery/conflicts?")) return Response.json({ recovery: "rC", state: "unresolved", open: 2, next: null, conflicts: [
				// The copies have changed since the choice was made; the resume body stays the original.
				{ node: "n1", kind: "owned_elsewhere", transfer: "t-1", state: "resolving", keep: "work", resume, copies: [side("work", "g1", copyOf("active", 7), true), side("personal", "g2", copyOf("active", 2), true)] },
				{ node: "n2", kind: "owned_elsewhere", transfer: "t-2", state: "open", copies: [side("work", "g1", copyOf("active", 1), true), side("personal", "g2", copyOf("active", 1), true)] }] });
			if (path === "/api/recovery/conflicts/resolve" && method === "POST") {
				resolves.push(body);
				if (progress) { progress = false; return Response.json({ progress: "2 of 5 steps; repeat with the same request id" }); }
				phase = "settling";
				return Response.json({ node: "n1", kept: "work", tombstoned: "personal", recovery: "rC" });
			}
			if (path === "/api/recovery/step" && method === "POST") { phase = "ready"; return Response.json({ state: "ready" }); }
			if (path === "/api/recovery/open" && method === "POST") { phase = phase === "ready" ? "opening" : "unresolved"; return Response.json({ state: phase, phase: phase === "opening" ? "precheck" : undefined }); }
			if (path === "/api/recovery/abort" && method === "POST") return Response.json({ state: "rolling_back" });
		} });
		await dashboardMain(b.win);
		await many();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		expect(flat()).toContain("This choice is already recorded and unfinished: keep the copy in work");
		expect(flat()).toContain("chosen against work active revision 3 and personal active revision 2");
		expect(flat()).toContain("Revision 7"); // the current copy is shown as current metadata
		expect(b.seen.posted).toEqual([]);
		expect(keepForm(b, "n1")).toBeUndefined(); // a recorded choice is continued, never previewed again
		preview(b, "n2", "personal");
		expect(keepBtn(b, "n2").disabled).toBe(true);
		click(button(b.view(), "Send the same choice again"));
		await many();
		expect(flat()).toContain("Started, not finished");
		click(button(b.view(), "Send the same choice again"));
		await many();
		expect(resolves).toEqual([resume, resume]);
		// The server's state decides the controls: settling steps, ready opens, opening cannot abort, a failed precheck can.
		const has = (label: string) => !!button(b.view(), label);
		expect([has("Run the next step"), has("Open"), has("Abort")]).toEqual([true, false, true]);
		click(button(b.view(), "Run the next step"));
		await many();
		expect([has("Run the next step"), has("Open"), has("Abort")]).toEqual([false, true, true]);
		click(button(b.view(), "Open"));
		await many();
		expect([has("Run the next step"), has("Open"), has("Abort")]).toEqual([false, true, false]);
		click(button(b.view(), "Open"));
		await many();
		expect(flat()).toContain("open_precheck_failed: n9");
		expect(find(b.view(), "section").some((x) => x.attrs["aria-label"] === "Copies to choose")).toBe(false);
		expect([has("Run the next step"), has("Open"), has("Abort")]).toEqual([false, false, true]);
		typeIn(byId(b.view(), "confirm-abort"), "abort");
		click(button(b.view(), "Abort"));
		await many();
		expect(b.seen.posted).toEqual(["/api/recovery/conflicts/resolve", "/api/recovery/conflicts/resolve", "/api/recovery/step", "/api/recovery/open", "/api/recovery/open", "/api/recovery/abort"]);
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

	it("colours canvas text to 4.5:1 against the canvas's actual background in dark and light, read once, not per frame", async () => {
		const lum = (c: number[]) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
		const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
		for (const [surface, dark] of [[[26, 28, 29], true], [[251, 252, 253], false]] as const) {
			let reads = 0;
			const b = browser({ signedIn: true, api: graphApi() });
			// A forced dark page: the canvas's computed background, whatever the colour-scheme media query says.
			Object.assign(b.win, { getComputedStyle: (e: El) => { reads++; return { backgroundColor: e.tag === "canvas" ? `rgb(${surface.join(", ")})` : "rgba(0, 0, 0, 0)" }; } });
			await dashboardMain(b.win);
			await loaded(b);
			typeIn(byId(b.view(), "graph-q"), "Record 1");
			click(button(b.view(), "Record 1"));
			const canvas = find(b.view(), "canvas")[0]! as El & { ctx: Ctx };
			canvas.ctx.texts = [];
			click(button(b.view(), "Fit"));
			await settle();
			const texts = canvas.ctx.texts;
			expect(texts.some((t) => t.t === "Record 1") && texts.some((t) => t.font.startsWith("600"))).toBe(true);
			for (const t of texts) {
				const [x, y] = [lum(rgb(t.color)), lum([...surface])].sort((p, q) => q - p);
				expect((x! + 0.05) / (y! + 0.05)).toBeGreaterThanOrEqual(4.5);
			}
			expect(canvas.ctx.fillStyles).toContain(dark ? "#3987e5" : "#2a78d6");
			const before = reads;
			for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight"]) { canvas.on.keydown!({ key, preventDefault() {} } as never); await settle(); }
			expect(reads).toBe(before); // frames read no computed style
		}
	});

	it("draws an unsaved what-if apart from the saved graph, compares only loaded facts, resets, keeps it to its profile and sends nothing", async () => {
		const b = browser({ signedIn: true, api: graphApi((path) => path === "/api/profiles/work/nodes/r13" ? Response.json({ node: { name: "Record 13" }, history: { items: [] } }) : undefined) });
		await dashboardMain(b.win);
		await loaded(b);
		const saved = status(b).textContent;
		typeIn(byId(b.view(), "graph-q"), "Record 13");
		click(button(b.view(), "Record 13"));
		const whatIfForm = () => find(b.view(), "form").find((f) => find(f, "input").some((i) => i.attrs.id === "graph-whatif"))!;
		typeIn(byId(b.view(), "graph-whatif"), "Try caching");
		whatIfForm().on.submit!({ preventDefault() {} });
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		expect(flat()).toContain("What-if (not saved)");
		expect(flat()).toContain("Records 1,377 saved → 1,378 with what-if Links 2 → 3 Records with links 3 → 5");
		expect(flat()).toContain("Try caching, linked to “Record 13” (its links 0 → 1)");
		expect(status(b).textContent).toBe(saved); // the saved graph's own counts do not move
		const canvas = find(b.view(), "canvas")[0]! as El & { ctx: Ctx };
		canvas.ctx.texts = [];
		click(button(b.view(), "Zoom in"));
		await settle();
		expect(canvas.ctx.texts.some((x) => x.t === "What-if: Try caching")).toBe(true);
		// Another profile's graph shows none of it; back in work it is still there, in this tab only.
		b.go("#/graph/personal");
		await settle();
		expect(flat()).not.toContain("Try caching");
		b.go("#/graph/work");
		await settle();
		expect(flat()).toContain("Try caching, linked to “Record 13”");
		click(button(b.view(), "Clear all what-if items"));
		expect(flat()).not.toContain("What-if (not saved)");
		canvas.ctx.texts = [];
		const now = find(b.view(), "canvas")[0]! as El & { ctx: Ctx };
		now.ctx.texts = [];
		click(button(b.view(), "Zoom in"));
		await settle();
		expect(now.ctx.texts.some((x) => x.t.startsWith("What-if"))).toBe(false);
		expect(b.seen.posted).toEqual([]);
		expect(b.seen.fetched.some((x) => x.includes("/save") || x.includes("/move") || x.includes("/review"))).toBe(false);
	});

	it("tries unsaved link and record changes between loaded records, counts their impact, restores and resets, keeps them to the profile, never drafts or sends them", async () => {
		const b = browser({ signedIn: true, api: graphApi() });
		await dashboardMain(b.win);
		await loaded(b);
		const saved = status(b).textContent, flat = () => text(b.view()).replace(/\s+/g, " ");
		const labelled = (l: string) => find(b.view(), "button").find((x) => x.attrs["aria-label"] === l)!;
		const pick = (name: string) => { typeIn(byId(b.view(), "graph-q"), name); click(button(b.view(), name)); };
		// Add a link between two loaded records: pick one end, then the other.
		pick("Record 13");
		click(button(b.view(), "Link to another record (what-if)…"));
		pick("Record 14");
		click(button(b.view(), "Link to “Record 13” (what-if)"));
		expect(flat()).toContain("Records 1,377 saved → 1,377 with what-if Links 2 → 3 Records with links 3 → 5");
		expect(flat()).toContain("Added link: “Record 13” and “Record 14”");
		// Remove a loaded record with its loaded link, and one saved link of another record.
		pick("Owner");
		click(button(b.view(), "Remove this record (what-if)"));
		expect(button(b.view(), "Restore this record (what-if)")).toBeDefined();
		const canvas = find(b.view(), "canvas")[0]! as El & { ctx: Ctx };
		canvas.ctx.texts = [];
		await settle();
		expect(canvas.ctx.texts.some((x) => x.t === "Removed: Owner")).toBe(true);
		pick("Record 1");
		click(labelled("Remove the link part_of with Agent Memory, not saved"));
		expect(flat()).toContain("Records 1,377 saved → 1,376 with what-if Links 2 → 1 Records with links 3 → 2");
		expect(flat()).toContain("Removed link: “Record 1” part_of “Agent Memory”");
		expect(flat()).toContain("Removed record: “Owner” and its 1 loaded link");
		expect(button(b.view(), "Make a draft")).toBeUndefined(); // link and record changes never become a draft
		expect(status(b).textContent).toBe(saved); // the saved graph's own counts do not move
		click(labelled("Restore Owner"));
		expect(flat()).toContain("Records 1,377 saved → 1,377 with what-if Links 2 → 2 Records with links 3 → 4");
		// Another profile shows none of it; back in work it is still there, then a reset clears it and the record's own buttons follow.
		b.go("#/graph/personal");
		await settle();
		expect(flat()).not.toContain("What-if (not saved)");
		b.go("#/graph/work");
		await settle();
		expect(flat()).toContain("Added link: “Record 13” and “Record 14”");
		pick("Record 1");
		expect(labelled("Restore the link part_of with Agent Memory, not saved")).toBeDefined();
		click(button(b.view(), "Clear all what-if items"));
		expect(flat()).not.toContain("What-if (not saved)");
		expect(labelled("Remove the link part_of with Agent Memory, not saved")).toBeDefined();
		expect(b.seen.posted).toEqual([]);
		expect(b.seen.fetched.some((x) => /\/(save|move|review|delete|wipe|forget)/.test(x))).toBe(false);
	});
});

describe("dashboard review", () => {
	it("lists work's captured suggestions as text, promotes only after a preview, and retries an unanswered promote with the same request", async () => {
		const sent: Record<string, unknown>[] = [];
		let lose = true;
		const b = browser({ signedIn: true, hash: "#/review", api: (path, method, body) => {
			if (path !== "/api/profiles/work/review" || method !== "POST") return;
			const q = body as Record<string, unknown>;
			if (q.action === "list") return Response.json({ profile: "work", candidates: lose ? [{ capture_id: "c1", name: HOSTILE, kind: "observation", status: "pending", source: { client: "codex" },
				content: `Use ${HOSTILE} carefully`, created_at: "2026-10-30T00:00:00Z" }] : [] });
			sent.push(q);
			if (lose) { lose = false; throw new Error("answer lost after commit"); }
			return Response.json({ ok: true, action: "promoted", capture_id: "c1", memory_id: "m9", name: "Careful", activity_id: 7 });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Review: work");
		expect(b.seen.bodies[0]).toEqual({ action: "list", status: "pending", limit: 20 });
		expect(text(b.view())).toContain(`Use ${HOSTILE} carefully`);
		expect(text(b.view())).toContain("Source client codex");
		expect(find(b.view(), "img")).toEqual([]);
		expect(button(b.view(), "Promote").disabled).toBe(true);
		typeIn(byId(b.view(), "promote-name-c1"), "Careful");
		find(b.view(), "form")[1]!.on.submit!({ preventDefault() {} });
		expect(text(b.view())).toContain("Preview: a new project memory “Careful” in work");
		click(button(b.view(), "Promote"));
		await settle();
		expect(status(b).textContent).toContain("Could not promote");
		expect(sent).toHaveLength(1);
		// The committed candidate has left the pending list, but the original request remains reachable.
		expect(text(b.view())).toContain("No pending suggestions");
		expect(find(b.view(), "form")).toHaveLength(1);
		click(button(b.view(), "Retry promote"));
		await settle();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(sent[0]);
		expect(String(sent[0]!.request_id)).toMatch(/^dashboard:/);
		expect(sent[0]).toMatchObject({ action: "promote", candidate_id: "c1", into: { name: "Careful", type: "project" } });
		expect(status(b).textContent).toContain("Promoted into memory “Careful”.");
		expect(button(b.view(), "Undo last change")).toBeDefined();
	});

	it("lists flagged records from the graph read with their reason, unflags only on an explicit click with Undo, and shows an open restore's findings without acting on them", async () => {
		const posted: string[] = [];
		const b = browser({ signedIn: true, hash: "#/review", api: (path, method) => {
			if (path === "/api/profiles/work/review") return Response.json({ profile: "work", candidates: [] });
			if (path.startsWith("/api/profiles/work/graph?part=nodes")) return Response.json({ part: "nodes", done: true, next_after: null, total: 3, items: [
				{ id: "f1", kind: "document", type: "project", name: HOSTILE, status: "active", flagged: true }, { id: "ok1", kind: "document", type: "project", name: "Fine", status: "active", flagged: false },
				{ id: "f2", kind: "decision", type: "reference", name: "Kept twice", status: "active", flagged: true }] });
			if (path.startsWith("/api/profiles/work/graph?part=edges")) return Response.json({ part: "edges", done: true, next_after: null, items: [] });
			if (path === "/api/profiles/work/nodes/f2" && method === "GET") return Response.json({ node: { id: "f2", flagged: "dedupe: protected survivor" } });
			if (path === "/api/profiles/work/nodes/f2/unflag" && method === "POST") { posted.push(path); return Response.json({ ok: true, action: "unflag", activity_id: 41 }); }
			if (path === "/api/recovery") return Response.json({ recovery: { id: "r1", kind: "profile", profile: "work", state: "unresolved", unresolved_count: 2, unresolved: [{ kind: "two_active", id: "n7" }] }, last_export: null });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 10; i++) await settle();
		const flat = () => text(b.view()).replace(/\s+/g, " ");
		expect(flat()).toContain("2 flagged among 3 records read.");
		expect(button(b.view(), "Read why")).toBeDefined();
		expect(flat()).not.toContain("Fine");
		expect(find(b.view(), "img")).toEqual([]); // a hostile name stays text
		expect(find(b.view(), "a").some((a) => a.attrs.href === "#/memory/work/f2")).toBe(true);
		// The reason is read only when asked; nothing is written by reading it.
		click(find(b.view(), "button").find((x) => x.attrs["aria-label"] === "Read why Kept twice is flagged")!);
		await settle();
		expect(flat()).toContain("Flagged: dedupe: protected survivor");
		expect(posted).toEqual([]);
		// Restore reconciliation shows the open restore's findings and sends the owner to Backups for every action.
		expect(flat()).toContain("A restore is open (unresolved) with 2 unresolved findings.");
		expect(flat()).toContain("two_active: n7");
		expect(flat()).toContain("1 more are not listed.");
		expect(find(b.view(), "a").some((a) => a.attrs.href === "#/backups")).toBe(true);
		expect(flat()).toContain("Could not read the review list"); // an unreadable list is said, never shown as empty
		click(find(b.view(), "button").find((x) => x.attrs["aria-label"] === "Unflag Kept twice")!);
		for (let i = 0; i < 4; i++) await settle();
		expect(posted).toEqual(["/api/profiles/work/nodes/f2/unflag"]);
		expect(status(b).textContent).toContain("Unflagged “Kept twice”.");
		expect(flat()).toContain("1 flagged among 3 records read.");
		expect(button(b.view(), "Undo last change")).toBeDefined();
		// Only the unflag wrote; no recovery step, open or abort, and no move, save or promote.
		expect(b.seen.posted.filter((x) => !x.endsWith("/review"))).toEqual(["/api/profiles/work/nodes/f2/unflag"]);
	});

	it("assigns a migrated record only after a preview, and settles a collided move by moving again, merging with Undo or keeping both", async () => {
		const items = { migration: [{ id: "m:1", kind: "migration", state: "open", payload: { source: "bothq:x", id: "x1", scope: "bot_hq", name: HOSTILE, reasons: ["unrouted_scope"] } }],
			collision: [{ id: "c:1", kind: "collision", state: "open", updated_at: "2026-11-01T00:00:00Z", payload: { memory_id: "n1", from: "work", to: "personal", reason: "key_taken", existing_id: "n9" } }] };
		const bodies: Record<string, unknown> = {};
		const b = browser({ signedIn: true, hash: "#/review", api: (path, method, body) => {
			if (path === "/api/profiles/work/review") return Response.json({ profile: "work", candidates: [] });
			if (path.startsWith("/api/review?kind=")) return Response.json({ items: items[path.includes("collision") ? "collision" : "migration"], next_after: null });
			if (method !== "POST") return;
			bodies[path] = body;
			if (path === "/api/profiles/work/move") return Response.json({ error: { code: "transfer_collision", message: "still taken" } }, { status: 400 });
			if (path.endsWith("/forget")) return Response.json({ ok: true, action: "forget", activity_id: 12 });
			return Response.json({ ok: true });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 6; i++) await settle();
		const flat = () => text(b.view()).replace(/\s+/g, " "), labelled = (l: string) => find(b.view(), "button").find((x) => x.attrs["aria-label"] === l)!;
		expect(find(b.view(), "img")).toEqual([]);
		expect(flat()).toContain("Why it waits unrouted_scope");
		expect(flat()).toContain("The destination already has an active record with the same name, scope and type");
		expect(find(b.view(), "a").some((x) => x.attrs.href === "#/memory/personal/n9")).toBe(true);
		// Assign: nothing is sent before the preview, and only the chosen profile is sent.
		expect(button(b.view(), "Assign").disabled).toBe(true);
		const assignForm = find(b.view(), "form").find((f) => find(f, "select").some((x) => x.attrs.id === "assign-m:1"))!;
		const pick = find(assignForm, "select")[0]!;
		pick.value = "personal";
		pick.on.change?.();
		assignForm.on.submit!({ preventDefault() {} });
		expect(flat()).toContain("Nothing is imported now");
		click(button(b.view(), "Assign"));
		for (let i = 0; i < 4; i++) await settle();
		expect(bodies["/api/review/m%3A1/assign"]).toEqual({ profile: "personal" });
		// Move again after a rename: the existing move route; a refusal is shown and the next try gets a fresh request id.
		click(labelled("Move n1 to personal again"));
		for (let i = 0; i < 4; i++) await settle();
		const first = bodies["/api/profiles/work/move"] as Record<string, unknown>;
		expect(first).toMatchObject({ memory_id: "n1", to: "personal" });
		expect(flat()).toContain("Refused:");
		click(labelled("Move n1 to personal again"));
		for (let i = 0; i < 4; i++) await settle();
		expect((bodies["/api/profiles/work/move"] as Record<string, unknown>).request_id).not.toBe(first.request_id);
		// Merge: forget the moving record (Undo offered), and the item is recorded as merged.
		click(labelled("Forget n1 in work"));
		for (let i = 0; i < 4; i++) await settle();
		expect(b.seen.posted).toContain("/api/profiles/work/nodes/n1/forget");
		expect(bodies["/api/review/c%3A1/resolve"]).toEqual({ choice: "merged" });
		expect(button(b.view(), "Undo last change")).toBeDefined();
		click(labelled("Keep both records for the move of n1"));
		for (let i = 0; i < 4; i++) await settle();
		expect(bodies["/api/review/c%3A1/resolve"]).toEqual({ choice: "kept" });
		expect(b.seen.posted.filter((x) => x.includes("/save") || x.includes("/wipe") || x.includes("/recovery"))).toEqual([]);
	});
});

describe("dashboard wipe", () => {
	it("asks for the profile, states the consequences first, sends only the typed name and shown version, and offers only a manual Continue after a lost answer", async () => {
		const states = [{ status: "active", generation: "bbbb", wipe: null },
			{ status: "wiped", generation: "bbbb", wipe: { started_at: "2026-10-31T10:00:00Z", generations: 1, state: "backups", purged: 12, redacted: 3 } },
			{ status: "wiped", generation: "bbbb", wipe: { started_at: "2026-10-31T10:00:00Z", generations: 1, state: "done", purged: 12, redacted: 3 } }];
		let reads = 0, posts = 0;
		const b = browser({ signedIn: true, hash: "#/wipe", api: (path, method) => {
			if (path === "/api/profiles/work/wipe/preview") return Response.json({ profile: "work", generation: "bbbb", targets: [] });
			if (path !== "/api/profiles/work/wipe") return;
			if (method === "GET") return Response.json(states[Math.min(reads++, 2)]);
			if (++posts === 1) throw new Error("connection lost");
			return Response.json({ profile: "work", generations: ["bbbb"], wiped_at: "2026-10-31T10:00:00Z", marker_key: "m", report: JSON.stringify({ state: "done" }) });
		} });
		await dashboardMain(b.win);
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Wipe a profile");
		expect(b.seen.fetched.some((x) => x.includes("/wipe"))).toBe(false); // nothing is read or chosen until the owner picks a profile
		expect(find(b.view(), "a").map((a) => a.attrs.href)).toEqual(expect.arrayContaining(["#/wipe/personal", "#/wipe/work"]));
		b.go("#/wipe/work");
		await settle();
		expect(text(b.view())).toContain("no backup can bring work back");
		expect(text(b.view())).toContain("It cannot be undone.");
		expect(text(b.view())).toContain("except accepted company-free preferences in me");
		expect(text(b.view())).toContain("hand-written references remain and need manual review");
		const go = () => button(b.view(), "Wipe work") ?? button(b.view(), "Continue wiping work");
		expect(go().disabled).toBe(true);
		typeIn(byId(b.view(), "wipe-typed"), "Work");
		expect(go().disabled).toBe(true);
		typeIn(byId(b.view(), "wipe-typed"), "work");
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		await settle();
		expect(b.seen.bodies).toEqual([{ typed: "work", generation: "bbbb" }]);
		expect(status(b).textContent).toContain("Could not wipe work: connection lost.");
		// The state is read again; the unfinished wipe offers Continue, and nothing was sent again by itself.
		expect(text(b.view())).toContain("Continue runs the same wipe from where it stopped; it never starts a second one.");
		expect(button(b.view(), "Continue wiping work").disabled).toBe(true);
		expect(posts).toBe(1);
		typeIn(byId(b.view(), "wipe-typed"), "work");
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		await settle();
		expect(b.seen.bodies).toEqual([{ typed: "work", generation: "bbbb" }, { typed: "work", generation: "bbbb" }]);
		expect(status(b).textContent).toContain("work is wiped.");
		expect(text(b.view())).toContain("This profile is wiped. Nothing more can be done here.");
		expect(text(b.view())).toContain("Records removed 12");
		expect(find(b.view(), "button").some((x) => x.textContent === "Undo last change")).toBe(false);
		// Only the active profile was previewed; the unfinished wipe continued without a new preview.
		expect(b.seen.fetched.filter((x) => x.includes("/wipe/preview"))).toEqual(["/api/profiles/work/wipe/preview"]);
	});

	it("keeps the confirmation off until every preview page is read, resumes a failed page only when asked, and shows undecided survivors as such", async () => {
		let failed = false;
		const item = (id: string, verdict: string, extra: Record<string, unknown> = {}) => ({ id, kind: "preference", other_label: null, name: `Pref ${id}`, status: "active", where: "live", verdict, ...extra });
		const b = browser({ signedIn: true, hash: "#/wipe/work", api: (path) => {
			if (path === "/api/profiles/work/wipe") return Response.json({ status: "active", generation: "bbbb", wipe: null });
			if (path === "/api/profiles/work/wipe/preview") return Response.json({ profile: "work", generation: "bbbb", targets: ["me", "personal"] });
			const q = new URL(path, "https://x").searchParams;
			if (!path.startsWith("/api/profiles/work/wipe/preview?")) return;
			const key = `${q.get("target")}:${q.get("part")}:${q.get("after") ?? ""}`;
			if (key === "me:purge:") return Response.json({ items: [item("s1", "survive"), item("d1", "decided_at_wipe")], next: "c1" });
			if (key === "me:purge:c1") return Response.json({ items: [item("p1", "purge", { name: HOSTILE })], next: null });
			if (key === "me:handwritten:") return Response.json({ items: [], next: null });
			if (key === "personal:purge:") { if (!failed) { failed = true; return Response.json({ error: { code: "busy", message: "profile busy" } }, { status: 503 }); } return Response.json({ items: [item("a1", "purge", { kind: "document", where: "archive", status: "active" })], next: null }); }
			if (key === "personal:handwritten:") return Response.json({ items: [item("h1", "kept_listed", { kind: "document", name: "Trip notes" })], next: null });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(text(b.view())).toContain("The preview stopped: profile busy (busy).");
		typeIn(byId(b.view(), "wipe-typed"), "work");
		expect(button(b.view(), "Wipe work").disabled).toBe(true);
		expect(text(b.view())).toContain("The confirmation opens once the preview above is complete.");
		const before = b.seen.fetched.filter((x) => x.includes("personal")).length;
		await settle();
		expect(b.seen.fetched.filter((x) => x.includes("personal")).length).toBe(before); // nothing is read again by itself
		click(button(b.view(), "Read the preview again"));
		for (let i = 0; i < 20 && !text(b.view()).includes("Preview complete"); i++) await settle();
		expect(text(b.view())).toContain("Preview complete: 2 records will be removed from other profiles, 1 survive in me, 1 are decided when the wipe runs, and 1 that mention this profile's terms stay for your review.");
		expect(text(b.view())).toContain("Decided when the wipe runs, in me");
		expect(text(b.view())).toContain(`preference: ${HOSTILE}`);
		expect(find(b.view(), "img")).toEqual([]);
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("document: Pref a1 · archived");
		expect(b.seen.fetched).toContain("/api/profiles/work/wipe/preview?target=me&part=purge&after=c1");
		typeIn(byId(b.view(), "wipe-typed"), "work");
		expect(button(b.view(), "Wipe work").disabled).toBe(false);
		expect(b.seen.posted).toEqual([]);
	});
});

describe("dashboard save a copy", () => {
	it("re-saves a record due for removal as a new record in an explicitly chosen profile, from its complete text, then returns to a fresh preview", async () => {
		const PROFILES4 = [...PROFILES, { name: "keep", generation: "kkkk", status: "active", created_at: "2026-10-28T12:00:00Z" }];
		let previews = 0, saves = 0;
		const b = browser({ signedIn: true, hash: "#/wipe/work", profiles: PROFILES4, api: (path, method) => {
			if (path === "/api/profiles/work/wipe") return Response.json({ status: "active", generation: "bbbb", wipe: null });
			if (path === "/api/profiles/work/wipe/preview") { previews++; return Response.json({ profile: "work", generation: "bbbb", targets: ["personal"] }); }
			if (path === "/api/profiles/work/wipe/preview?target=personal&part=purge") return Response.json({ items: [{ id: "m7", kind: "document", other_label: null, name: "Keep me", status: "active", where: "live", verdict: "purge" }], next: null });
			if (path === "/api/profiles/work/wipe/preview?target=personal&part=handwritten") return Response.json({ items: [], next: null });
			if (path === "/api/profiles/personal/nodes/m7") return Response.json({ node: { id: "m7", name: "Keep me", kind: "document", memory_type: "reference", status: "active", scope: "trips", description: "why it matters", truncated: [] }, content: { text: "part one ", chars: 17, complete: false } });
			if (path === "/api/profiles/personal/nodes/m7?content=all") return Response.json({ id: "m7", content: { content: "part one ", complete: false, cursor: "k1" } });
			if (path === "/api/profiles/personal/nodes/m7?content=all&cursor=k1") return Response.json({ id: "m7", content: { content: "part two", complete: true, cursor: null } });
			if (path === "/api/profiles/keep/save" && method === "POST") { if (++saves === 1) throw new Error("connection lost"); return Response.json({ ok: true, action: "created", memory_id: "n1", name: "Keep me", revision: 1 }); }
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 20 && !text(b.view()).includes("Preview complete"); i++) await settle();
		click(button(b.view(), "Save a copy"));
		expect(b.win.location.hash).toBe("#/copy/personal/m7");
		b.go("#/copy/personal/m7");
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Save a copy of “Keep me”");
		expect(byId(b.view(), "copy-to").value).toBe("");
		expect(find(byId(b.view(), "copy-to"), "option").map((o) => o.attrs.value)).toEqual(["", "work", "keep"]); // never the record's own profile
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		expect(status(b).textContent).toContain("Choose the profile to copy it into.");
		byId(b.view(), "copy-to").value = "keep";
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		await settle();
		expect(b.win.location.hash).toBe("#/draft/keep");
		b.go("#/draft/keep");
		expect(text(b.view())).toContain("the original keeps its history, requests and links");
		expect(byId(b.view(), "draft-content").value).toBe("part one part two"); // both pages of the text, nothing cut
		expect(byId(b.view(), "draft-type").disabled).toBe(true);
		expect(b.seen.posted).toEqual([]); // nothing is saved by opening a copy
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		expect(text(b.view()).replace(/\s+/g, " ")).toContain("Change A new record, copied from “Keep me” in personal");
		click(button(b.view(), "Save"));
		await settle();
		expect(status(b).textContent).toContain("Could not save “Keep me”: connection lost.");
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		click(button(b.view(), "Save"));
		await settle();
		const [first, second] = b.seen.bodies as Record<string, unknown>[];
		expect(second).toEqual(first);
		const { request_id: rid, ...fields } = first!;
		expect(fields).toEqual({ name: "Keep me", type: "reference", kind: "document", description: "why it matters", scope: "trips", content: "part one part two" });
		expect(String(rid)).toMatch(/^dashboard:/);
		expect(b.win.location.hash).toBe("#/wipe/work");
		b.go("#/wipe/work");
		for (let i = 0; i < 20 && !text(b.view()).includes("Preview complete"); i++) await settle();
		expect(previews).toBe(2); // the preview is read afresh
		expect(status(b).textContent).toContain("Saved: created “Keep me”");
		expect(button(b.view(), "Wipe work").disabled).toBe(true); // nothing typed or confirmed by itself
		expect(b.seen.posted).toEqual(["/api/profiles/keep/save", "/api/profiles/keep/save"]);
	});
});

describe("dashboard moves", () => {
	it("moves only to a chosen profile after a preview, and keeps the same request reachable after a lost answer once the record has left", async () => {
		let reads = 0, posts = 0;
		const b = browser({ signedIn: true, hash: "#/move/work/m1", api: (path, method) => {
			if (path === "/api/profiles/work/nodes/m1") return reads++ === 0 ? Response.json({ node: { id: "m1", name: HOSTILE, kind: "document", status: "active" } })
				: Response.json({ error: { code: "not_found", message: "no node matches 'm1' in this profile" } }, { status: 404 });
			if (path !== "/api/profiles/work/move" || method !== "POST") return;
			if (++posts === 1) return Response.json({ error: { code: "unavailable", message: "temporarily unavailable after binding" } }, { status: 503 });
			return Response.json({ ok: true, action: "transfer_started", memory_id: "m1", transfer_id: "t1", state: "committed", profile: "personal", routed_by: "explicit" });
		} });
		await dashboardMain(b.win);
		await settle();
		expect(find(b.view(), "h2")[0]!.textContent).toBe(`Move “${HOSTILE}”`);
		expect(text(b.view())).toContain("Now in work");
		expect(text(b.view())).toContain("work keeps a tombstone in its place");
		expect(find(b.view(), "img")).toEqual([]);
		expect(byId(b.view(), "move-to").value).toBe(""); // no destination until the owner chooses one
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		expect(status(b).textContent).toContain("Choose the profile to move it to.");
		expect(button(b.view(), "Move").disabled).toBe(true);
		const to = byId(b.view(), "move-to");
		to.value = "personal";
		to.on.change!();
		find(b.view(), "form")[0]!.on.submit!({ preventDefault() {} });
		expect(text(b.view())).toContain("Preview: move");
		click(button(b.view(), "Move"));
		await settle();
		expect(posts).toBe(1);
		expect(text(b.view())).toContain("Result unconfirmed: the move may or may not have happened.");
		// The record is no longer readable here, yet the same move stays one click away, and nothing was resent by itself.
		const again = button(b.view(), "Send the same move again");
		expect(again).toBeDefined();
		click(again);
		await settle();
		expect(posts).toBe(2);
		const [first, second] = b.seen.bodies as Record<string, unknown>[];
		expect(second).toEqual(first);
		expect(first).toMatchObject({ memory_id: "m1", to: "personal" });
		expect(String(first!.request_id)).toMatch(/^dashboard:/);
		expect(text(b.view())).toContain("Moved to personal.");
		expect(find(b.view(), "a").find((x) => x.textContent === "Open it in personal")!.attrs.href).toBe("#/memory/personal/m1");
		b.go("#/move");
		expect(text(b.view())).toContain("Moved to personal.");
	});
});

describe("dashboard profile choice", () => {
	it("takes the profile only from ?profile, refuses an unknown one with a chooser, asks a one-profile tab, and keeps the rest of the link", async () => {
		const b = browser({ signedIn: true, hash: "#/memories" });
		await dashboardMain(b.win);
		type Route = { query: Record<string, string>; hash: string };
		const am = (b.win as unknown as { __am: { tab(d: unknown): void; render(f: boolean): void; el(t: string, p?: El, x?: string): El;
			eachProfile<T>(only: string | null, fn: (p: { name: string }) => Promise<T>): Promise<({ profile: string; ok: true; value: T } | { profile: string; ok: false; error: Error & { code?: string } })[]> } }).__am;
		const seen: Route[] = [];
		am.tab({ id: "probe", group: "memory", label: "Probe", key: "q", profiles: "any", render: (root: El, r: Route) => { seen.push(r); return am.el("h2", root, "Probe"); } });
		am.tab({ id: "solo", group: "work", label: "Solo", key: "z", profiles: "one", render: (root: El, r: Route) => { seen.push(r); return am.el("h2", root, "Solo"); } });
		const pick = find(b.els.tools!, "select").find((x) => x.attrs.id === "profile-choice")!, h2 = () => find(b.view(), "h2")[0]!.textContent;
		const hrefs = () => find(b.view(), "a").map((a) => `${a.textContent} ${a.attrs.href}`);
		b.go("#/memories");
		expect(pick.hidden).toBe(true); // old routes keep their own path profile

		b.go("#probe");
		expect([h2(), seen.at(-1)!.query.profile, pick.hidden, pick.value]).toEqual(["Probe", undefined, false, ""]); // no query is All
		expect(find(pick, "option").map((o) => o.textContent)).toEqual(["All profiles", "personal", "work"]);
		b.go("#probe/r1?q=x&profile=nobody");
		expect([h2(), seen.length]).toEqual(["Probe: no active profile named nobody", 1]); // nothing read for it
		expect(hrefs()).toEqual(["personal #probe/r1?q=x&profile=personal", "work #probe/r1?q=x&profile=work", "All profiles #probe/r1?q=x"]);
		expect(pick.value).toBe("nobody");

		b.go("#solo/r1?q=x");
		expect([h2(), seen.length]).toEqual(["Solo: choose a profile", 1]); // never a silent work
		expect(hrefs()).toEqual(["personal #solo/r1?q=x&profile=personal", "work #solo/r1?q=x&profile=work"]);
		b.go("#solo/r1?q=x&profile=work");
		expect([h2(), seen.at(-1)!.query.profile]).toEqual(["Solo", "work"]);

		// The picker rewrites only the profile query. Without history.replaceState it sets the hash, whose change renders once.
		Reflect.deleteProperty(b.win, "history");
		pick.value = "personal";
		pick.on.change!();
		expect(b.win.location.hash).toBe("#solo/r1?q=x&profile=personal");
		const replaced: string[] = [];
		Object.assign(b.win, { history: { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); b.win.location.hash = url; } } });
		b.go("#probe/r1?q=x&profile=work");
		const before = seen.length;
		pick.value = "";
		pick.on.change!();
		expect([replaced, b.win.location.hash, seen.length - before, seen.at(-1)!.query.profile]).toEqual([["#probe/r1?q=x"], "#probe/r1?q=x", 1, undefined]);
	});

	it("reports every profile's own outcome from eachProfile and never reads for an unknown one", async () => {
		const b = browser({ signedIn: true });
		await dashboardMain(b.win);
		const am = (b.win as unknown as { __am: { eachProfile<T>(only: string | null, fn: (p: { name: string }) => Promise<T>): Promise<unknown[]> } }).__am;
		const calls: string[] = [];
		const read = async (p: { name: string }) => { calls.push(p.name); if (p.name === "personal") throw Object.assign(new Error("store unreachable"), { status: 503 }); return 3; };
		const all = await am.eachProfile(null, read) as { profile: string; ok: boolean; value?: number; error?: Error }[];
		expect(all.map((r) => [r.profile, r.ok, r.ok ? r.value : r.error!.message])).toEqual([["personal", false, "store unreachable"], ["work", true, 3]]);
		expect(await am.eachProfile("work", read)).toEqual([{ profile: "work", ok: true, value: 3 }]);
		const unknown = await am.eachProfile("nope", read) as { profile: string; ok: false; error: Error & { code?: string } }[];
		expect([unknown.length, unknown[0]!.profile, unknown[0]!.ok, unknown[0]!.error.code]).toEqual([1, "nope", false, "unknown_profile"]);
		expect(calls).toEqual(["personal", "work", "work"]);
	});
});

describe("dashboard Memories tab", () => {
	// From the Memories tab author's smoke: the list, server strength, the record link, and Forget with Undo.
	const row = (id: string, name: string) => ({ memory_id: id, profile: "work", name, type: "feedback", scope: "repo:x", status: "active", revision: 3, passage: `${name} passage`,
		provenance: { source_platform: "claude-code" }, freshness: { updated_at: "2026-11-03T10:00:00Z" }, score: 1 });
	const record = { id: "m1", node: { id: "m1", kind: "rule", memory_type: "feedback", scope: "repo:x", name: HOSTILE, status: "active", origin: "agent", pinned: false, flagged: null,
		revision: 3, created_at: "2026-11-01T10:00:00.000Z", updated_at: "2026-11-03T10:00:00.000Z", source_platform: "claude-code", updated_source_platform: null,
		description: "Prefer small diffs", truncated: [] }, content: { text: "Keep the diff small.", chars: 20, complete: true }, evidence: { items: [], truncated: false }, links: [],
		history: { items: [{ revision: 3, op: "created", at: "2026-11-01T10:00:00.000Z", actor: "agent", device_id: null }], next_before: null } };

	it("lists records as text with the server's strength, opens one keeping ?profile, and forgets only after a second click, with Undo", async () => {
		const b = browser({ signedIn: true, hash: "#memories?profile=work", api: (path) => {
			if (path === "/api/profiles/work/recall") return Response.json({ results: [row("m1", HOSTILE), row("m2", "Second")], next_cursor: null, truncated: false, lexical_only: false });
			if (path.startsWith("/api/profiles/work/recall-strength?")) {
				const ids = new URL(`http://x${path}`).searchParams.get("ids")!.split(",");
				return Response.json({ strength: Object.fromEntries(ids.map((id) => [id, { hits_90d: 14, strength: 10, last_recalled: "2026-11-02" }])) });
			}
			if (path === "/api/profiles/work/nodes/m1") return Response.json(record);
			if (path === "/api/profiles/work/nodes/m1/forget") return Response.json({ ok: true, action: "forgotten", activity_id: 41 });
			if (path === "/api/profiles/work/activity/41/undo") return Response.json({ ok: true });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 3; i++) await settle();
		expect(text(b.view())).toContain(HOSTILE);
		expect(find(b.view(), "script")).toEqual([]);
		expect(text(b.view())).toContain("10/10");
		expect(find(b.view(), "tbody")[0]!.attrs["data-list"]).toBe("");
		find(b.view(), "a").find((a) => a.attrs.href === "#memories/m1?profile=work")!.on.click!({ preventDefault() {} });
		await settle();
		expect(b.win.location.hash).toBe("#memories/m1?profile=work");
		const panel = find(b.view(), "aside")[0]!;
		expect(find(panel, "button").some((x) => "data-close" in x.attrs)).toBe(true);
		click(button(panel, "Forget…"));
		expect(b.seen.posted.filter((x) => x.endsWith("/forget"))).toEqual([]); // asks first
		click(button(panel, "Forget it"));
		await settle();
		expect(b.seen.posted).toContain("/api/profiles/work/nodes/m1/forget");
		click(button(b.view(), "Undo"));
		await settle();
		expect(b.seen.posted).toContain("/api/profiles/work/activity/41/undo"); // then the list reads again
	});

	it("shows each profile's own records only: a me overlay hit in a profile's recall is neither relabelled nor listed twice", async () => {
		const mine = (id: string, profile: string) => ({ ...row(id, `${profile} ${id}`), profile });
		const b = browser({ signedIn: true, hash: "#memories", api: (path) => {
			// Owner recall for a named profile also returns the authorized me overlay; each hit names its own profile.
			if (path === "/api/profiles/work/recall") return Response.json({ results: [mine("w1", "work"), mine("me1", "me")], next_cursor: "more-is-me", truncated: false, lexical_only: true });
			if (path === "/api/profiles/personal/recall") return Response.json({ results: [mine("p1", "personal"), mine("me1", "me")], next_cursor: null, truncated: false, lexical_only: true });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 3; i++) await settle();
		const hrefs = find(b.view(), "a").map((a) => a.attrs.href).filter((h) => h?.startsWith("#memories/"));
		expect(hrefs.sort()).toEqual(["#memories/p1?profile=personal", "#memories/w1?profile=work"]);
		expect(text(b.view())).not.toContain("me me1");
		expect(b.seen.fetched.filter((x) => x.includes("recall-strength")).sort()).toEqual(["/api/profiles/personal/recall-strength?ids=p1", "/api/profiles/work/recall-strength?ids=w1"]);
		expect(text(b.view())).not.toContain("more are available"); // past its own records the cursor only walks me
	});

	it("searches a profile with the plain payload and lists all 25 of its matches, as the owner recall route returns them", async () => {
		// The owner route reads only the named profile before its cap (mcp-auth: "keeps 25 inferred Work matches under the cap"),
		// so 25 inferred Work matches come back even when 25 stated me preferences match too. The tab adds no field for that.
		const bodies: unknown[] = [];
		const pref = (i: number) => ({ ...row(`w${i}`, `crowded ${i}`), kind: "preference", type: "user", origin: "inferred" });
		const b = browser({ signedIn: true, hash: "#memories?profile=work&q=crowded", api: (path, _m, body) => {
			if (path !== "/api/profiles/work/recall") return undefined;
			bodies.push(body);
			return Response.json({ read_set: ["work"], results: Array.from({ length: 25 }, (_, i) => pref(i)), next_cursor: null, truncated: true, lexical_only: true });
		} });
		await dashboardMain(b.win);
		for (let i = 0; i < 3; i++) await settle();
		expect(bodies).toEqual([{ limit: 25, count_hits: false, keyword: "crowded" }]); // only the fields the route admits
		const hrefs = find(b.view(), "a").map((a) => a.attrs.href).filter((h) => h?.startsWith("#memories/"));
		expect(hrefs).toEqual(Array.from({ length: 25 }, (_, i) => `#memories/w${i}?profile=work`));
		expect(text(b.view())).toContain("Showing 25 records");
	});
});
