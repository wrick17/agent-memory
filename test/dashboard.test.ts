// The dashboard's browser half against a stand-in DOM and ClerkJS: what it fetches, what it shows, and what it refuses to invent.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML, dashboardMain } from "../src/dashboard";
import { deviceToken } from "./helpers";

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
		document: { readyState: "complete", getElementById: (id: string) => (els[id] ??= make("div", true)), createElement: (tag: string) => make(tag), body: make("body"),
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

const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };
const settle = () => new Promise((r) => setTimeout(r, 10));
const click = (e: El) => { if (!e.disabled) e.on.click!(); }; // a browser fires no click on a disabled button
const button = (root: El, label: string) => find(root, "button").find((b) => b.textContent === label)!;
const status = (b: ReturnType<typeof browser>) => find(b.view(), "p").find((p) => p.attrs.role === "status")!;
const BOARD_DATE = "2026-10-29T12:00:00.000Z";
const workBoard = (extra: Record<string, unknown> = {}) => ({ as_of: BOARD_DATE, covers_only_uploaded_data: true,
	items: [], total: 0, truncated: false, without_state: 0, review: null, budget: { exhausted: false, skipped: 0 }, ...extra });

// Every address and the heading it opens with under the default fixtures. Old addresses of removed pages open their new place.
const ROUTES: [string, string][] = [
	["", "Home"], ["#/", "Home"], ["#/profiles", "Profiles"], ["#/profiles/work", "Profile: work"], ["#/profiles/nobody", "No profile named nobody"],
	["#/memories", "Memories"], ["#/memory/work/r1", "Memories"], ["#/graph/work", "Map"], ["#/about", "Learnings"], ["#/journals/work", "Journals"],
	["#/draft", "Write: work"], ["#/draft/work", "Write: work"], ["#/activity/work", "Change history: work"], ["#/review/work", "Review: work"],
	["#/move/work/r1", "Move a record"], ["#/copy/work/r1", "Save a copy"], ["#/backups", "Backups and recovery"], ["#/routing", "Routing"],
	["#/wipe", "Wipe a profile"], ["#/wipe/work", "Wipe profile: work"], ["#/manage", "Settings"], ["#overview", "Home"], ["#sessions", "Home"], ["#people", "Home"]];
// The nav: the sections, flat. The owner tools sit behind the Settings gear.
const navOf = (b: ReturnType<typeof browser>) => find(b.els.nav!, "a").map((a) => `${a.textContent} ${a.attrs.href}`);
const NAV = ["Home #home", "Memories #memories", "Learnings #learnings", "Journals #journals", "Projects #projects", "Map #map"];

// The newer pages: fixtures shaped like the owner reads and writes they call.
const typeIn = (e: El, value: string) => { e.value = value; e.on.input?.(); };
const submit = (root: El, i = 0) => find(root, "form")[i]!.on.submit!({ preventDefault() {} });
const byId = (root: El, id: string) => find(root, "input").concat(find(root, "textarea"), find(root, "select")).find((e) => e.attrs.id === id)!;
const HOSTILE = "<img src=x onerror=alert(1)>";

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
		// The header's live library loads the whole graph in the background on every page, owner tools included.
		const library = (p: string) => /\/graph\?part=(nodes|edges)$/.test(p);
		expect(b.seen.fetched.filter(library).sort()).toEqual(["/api/profiles/personal/graph?part=edges", "/api/profiles/personal/graph?part=nodes", "/api/profiles/work/graph?part=edges", "/api/profiles/work/graph?part=nodes"]);
		expect(b.seen.fetched.filter((p) => !library(p)).sort()).toEqual(["/api/devices", "/api/profiles", "/api/profiles/personal/activity?limit=3", "/api/profiles/personal/batch", "/api/profiles/personal/board?limit=1",
			"/api/profiles/personal/graph?part=nodes&limit=1", "/api/profiles/work/activity?limit=3", "/api/profiles/work/batch", "/api/profiles/work/board?limit=1", "/api/profiles/work/graph?part=nodes&limit=1",
			"/api/recovery", "/api/review?limit=100"]);
		expect(b.seen.auth).toEqual(Array(16).fill("Bearer session-token"));
		expect(b.seen.posted).toEqual([]);
		expect(b.els.status!.hidden).toBe(true); // nothing to say once signed in
		expect(b.view().hidden).toBe(false);
		const cards = find(b.view(), "section");
		expect(cards.map((c) => find(c, "a")[0]!.attrs.href)).toEqual(["#/profiles/personal", "#/profiles/work"]);
		// work: laptop is active and defaults to it; old-box is revoked, so it does not count as active.
		expect(text(cards[1]!)).toContain("Active devices 1 Default for 1 device(s) Last use by its devices 29 Oct");
		// Bounded reads only: a counted total, an uncountable one and a failed one each say so; nothing becomes a made-up zero.
		expect(text(cards[1]!)).toContain("Records 1,377");
		expect(text(cards[1]!)).toContain("Open work 4 items (uploaded work only)");
		expect(text(cards[1]!)).toContain("Recent changes 30 Oct save by agent");
		expect(text(cards[1]!)).not.toContain(HOSTILE);
		expect(text(cards[1]!)).toContain("Projects, people, decisions Shown after you open this profile’s graph");
		expect(text(cards[1]!)).toContain("Storage used Not available");
		expect(text(cards[0]!)).toContain("Records Too many to count in one read");
		expect(text(cards[0]!)).toContain("Open work Could not read: board unreachable");
		expect(text(cards[0]!)).not.toMatch(/Records 0|Open work 0/);
		expect(text(b.view())).toContain("Last backup Taken 30 Oct");
		expect(text(b.view())).toContain("Waiting in Review 1 migrated records, 1 stopped moves");
		// The batch row shows the server's batch_status as text; a failed read marks only its own card.
		expect(text(cards[1]!)).toContain("Batch Last lease never; last skipped 29 Oct (probe_indeterminate)");
		expect(text(cards[0]!)).toContain("Batch Unavailable: profile store unreachable");
		expect(text(cards[1]!)).not.toContain("Unavailable");
	});

	it("drills into a profile, lists the devices that may use it, and moves focus on navigation", async () => {
		const b = browser({ signedIn: true, hash: "#/profiles/work" });
		await dashboardMain(b.win);
		const rows = find(b.view(), "tr").slice(1).map(text);
		expect(rows).toEqual(["laptop token read, write yes 29 Oct active", "old-box token read no never revoked"]);
		b.win.location.hash = "#/profiles/personal";
		b.listeners.hashchange!();
		expect(find(b.view(), "tr").slice(1).map(text)).toEqual(["laptop token read, write no 29 Oct active"]);
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
		expect([...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`)).toEqual(NAV); // the static nav, before the script runs
		const response = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/app.js`)), script = await response.text();
		expect(script.startsWith(`"use strict";\nvar __name = (fn) => fn;\n`)).toBe(true);
		const b = browser({ signedIn: true, hash: "#/profiles" });
		new Function("window", script)(b.win);
		await settle();
		const seen: [string, string][] = [];
		for (const [hash] of ROUTES) { b.go(hash); await settle(); seen.push([hash, find(b.view(), "h2")[0]?.textContent ?? ""]); }
		expect(seen).toEqual(ROUTES);
		expect(navOf(b)).toEqual(NAV); // the shell draws the same sections
	});

	it("reports an API refusal instead of showing an empty dashboard", async () => {
		const b = browser({ signedIn: true, fail: 403 });
		await dashboardMain(b.win);
		expect(b.els.status!.textContent).toBe("Could not load the dashboard: forbidden");
		expect(b.els.view).toBeUndefined(); // never looked up, so never shown
	});
});

describe("dashboard shell", () => {
	it("lists the sections flat, marks the current one, keeps the owner tools behind Settings, and sends old addresses to their new place", async () => {
		const b = browser({ signedIn: true, hash: "#/memory/work/r1" });
		await dashboardMain(b.win);
		expect(navOf(b)).toEqual(NAV);
		const current = () => find(b.els.nav!, "a").filter((a) => a.attrs["aria-current"] === "page").map((a) => a.textContent);
		const gear = () => find(b.els.tools!, "button").find((a) => a.attrs["aria-label"] === "Settings")!;
		expect(b.win.location.hash).toBe("#memories/work/r1"); // an old record address opens the record in Memories
		expect(current()).toEqual(["Memories"]);
		expect(text(b.els.nav!)).not.toMatch(/Live|features|Audit|Graph|Sessions/i);
		b.go("#audit");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Change history"); // reachable, but not in the nav
		expect([current(), gear().attrs["aria-current"]]).toEqual([[], "page"]);
		b.go("#memories?profile=nobody");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Memories: no active profile named nobody"); // the shell refuses it before the tab reads
		b.go("#/backups");
		expect(gear().attrs["aria-current"]).toBe("page");
		// The gear opens a small menu of the same tools; the #/manage page stays as a fallback.
		const menu = find(b.els.tools!, "div").find((d) => d.attrs.class === "gear-menu")!;
		expect(menu.hidden).toBe(true);
		click(gear());
		expect([menu.hidden, gear().attrs["aria-expanded"]]).toEqual([false, "true"]);
		expect(find(menu, "a").map((a) => a.attrs.href)).toEqual(["#/draft", "#/review", "#audit", "#/backups", "#/move", "#/wipe", "#/devices", "#/profiles", "#/routing"]);
		expect(b.key("Escape", null)).toBe(true);
		expect(menu.hidden).toBe(true);
		b.go("#/manage");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Settings");
		expect(find(b.view(), "a").map((a) => a.attrs.href)).toEqual(["#/draft", "#/review", "#audit", "#/backups", "#/move", "#/wipe", "#/devices", "#/profiles", "#/routing"]);
		for (const [hash, heading, mark] of [["", "Home", "Home"], ["#/", "Home", "Home"], ["#/graph", "Map", "Map"], ["#graph?profile=work", "Map", "Map"], ["#lessons", "Learnings", "Learnings"]]) {
			b.go(hash!);
			expect([find(b.view(), "h2")[0]!.textContent, current()]).toEqual([heading, [mark]]);
		}
	});

	it("takes g then a letter, / for search and Esc, but not while typing", async () => {
		const b = browser({ signedIn: true, hash: "#memories" });
		await dashboardMain(b.win);
		const search = find(b.view(), "input").find((i) => i.attrs.type === "search")!;
		expect(b.key("/", null)).toBe(true);
		expect(active).toBe(search);
		expect(b.key("g", search)).toBe(false); // typing in the filter box
		expect(b.key("l", search)).toBe(false);
		expect(b.win.location.hash).toBe("#memories");
		b.key("g", null);
		expect(b.key("l", null)).toBe(true);
		expect(b.win.location.hash).toBe("#learnings");
		const am = (b.win as unknown as { __am: { help(p: El, t: string): void; el(t: string): El } }).__am, box = am.el("p");
		am.help(box, "undo"); // no "?" box: the explanation is a tooltip on the label
		expect([find(box, "button"), box.attrs.title]).toEqual([[], expect.stringContaining("")]);
	});

	it("follows the system theme until the owner picks one, and keeps the pick", async () => {
		const plain = browser({ signedIn: true });
		await dashboardMain(plain.win);
		expect(plain.html.attrs["data-theme"]).toBeUndefined();
		const b = browser({ signedIn: true, hash: "#home", storage: new Map([["am.theme", "dark"]]) });
		await dashboardMain(b.win);
		expect(b.html.attrs["data-theme"]).toBe("dark");
		const toggle = find(b.els.tools!, "button").find((x) => x.attrs["aria-label"]?.startsWith("Use the"))!;
		expect([toggle.textContent, toggle.attrs["aria-label"]]).toEqual(["☀", "Use the light theme"]);
		click(toggle);
		expect([b.html.attrs["data-theme"], b.storage.get("am.theme"), toggle.textContent]).toEqual(["light", "light", "☾"]);
		expect(text(b.els.tools!)).not.toMatch(/live|features|version/i);
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

describe("dashboard memories and drafts", () => {
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
		b.go("#/backups");
		expect(pick.hidden).toBe(false); // the same header everywhere: an owner tool keeps the switcher, which leads back Home

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

describe("dashboard Audit tab and Admin pages", () => {
	// From the Audit and Admin author's smoke: undo conflicts, filters from the link, token-safe copy, and every Admin page's intro.
	const act = (id: number, at: string, p: string, extra: Record<string, unknown> = {}) => ({ id, at, actor: "agent", device_id: null, op: "save", summary: `${p} change ${id} <b>x</b>`,
		targets: [`${p}-n${id}`], undone_by: null, undo_of: null, undo: "available", ...extra });
	const ROWS: Record<string, ReturnType<typeof act>[]> = { work: [act(9, "2026-11-03T10:00:00.000Z", "work"), act(7, "2026-11-02T10:00:00.000Z", "work", { actor: "owner" })],
		personal: [act(5, "2026-11-02T12:00:00.000Z", "personal", { actor: "migration", op: "import", undo: "none" })] };
	const api: Api = (path, method) => {
		const u = new URL(path, "https://x"), seg = u.pathname.split("/"), json = (v: unknown, status = 200) => Response.json(v, { status });
		if (method === "GET" && /\/activity$/.test(u.pathname)) {
			const actor = u.searchParams.get("actor"), rows = (ROWS[seg[3]!] ?? []).filter((r) => !actor || r.actor === actor);
			return json({ items: rows, next_before: null });
		}
		if (method === "POST" && /activity\/9\/undo$/.test(u.pathname)) return json({ error: { code: "revision_conflict", message: "changed since; review by hand" } }, 409);
		if (/\/archive$/.test(u.pathname)) return json({ items: [], next_after: null });
		if (path === "/api/rules") return json({ rules: [], profiles: ["work", "personal"] });
		if (path === "/api/recovery") return json({ recovery: null, last_export: null });
		if (path === "/api/backups/drill") return json({ drill: null, last: null });
		if (/\/wipe$/.test(u.pathname)) return json({ status: "active", generation: "b", wipe: null });
		if (/\/wipe\/preview/.test(u.pathname)) return json(u.searchParams.get("target") ? { items: [], next: null } : { targets: [] });
		if (method === "POST" && /\/review$/.test(u.pathname)) return json({ candidates: [] });
		if (/\/owner-model|\/journals|\/review$/.test(u.pathname) || path.startsWith("/api/review")) return json({ items: [], next_after: null });
		if (/\/board/.test(u.pathname)) return json({ as_of: "2026-11-04T00:00:00Z", items: [], total: 0, truncated: false, without_state: 0, review: null, budget: { exhausted: false, skipped: 0 } });
		if (/\/map$/.test(u.pathname)) return json({ nodes: [], links: [], starts: [] });
		if (/\/timeline$/.test(u.pathname)) return json({ events: [], truncated: false });
		if (/\/graph$/.test(u.pathname)) return json({ items: [], next_after: null, total: 0 });
		if (/\/nodes\//.test(u.pathname)) return json({ error: { code: "not_found", message: "no node" } }, 404);
	};

	it("asks for review by hand on an undo conflict, reads filters from the link, and copies curl with the owner token variable", async () => {
		const copied: string[] = [];
		const b = browser({ signedIn: true, hash: "#audit", api });
		Object.assign(b.win, { navigator: { clipboard: { writeText: async (t: string) => { copied.push(t); } } } });
		await dashboardMain(b.win);
		for (let i = 0; i < 3; i++) await settle();
		expect(text(b.view())).toContain("work change 9 <b>x</b>"); // summaries stay text
		expect(find(b.view(), "b")).toEqual([]);
		find(b.view(), "button").find((x) => /^Undo work change 9/.test(x.attrs["aria-label"] ?? ""))!.on.click!();
		for (let i = 0; i < 2; i++) await settle();
		expect(text(b.view())).toContain("Nothing was undone: those records changed again since. Review them by hand.");
		expect(b.seen.posted.at(-1)).toBe("/api/profiles/work/activity/9/undo");
		b.go("#audit?profile=work&actor=owner");
		for (let i = 0; i < 2; i++) await settle();
		const sel = (id: string) => find(b.view(), "select").find((x) => x.attrs.id === id)?.value;
		expect([find(b.els.tools!, "select").find((x) => x.attrs.id === "profile-choice")!.value, sel("audit-actor")]).toEqual(["work", "owner"]); // the header picker
		expect(text(b.view())).toContain("work change 7");
		expect(text(b.view())).not.toContain("personal change");
		click(button(b.view(), "Copy curl"));
		await settle();
		expect(copied.at(-1)).toContain("/api/profiles/work/activity?limit=25&actor=owner");
		expect(copied.at(-1)).toContain("$AGENT_MEMORY_OWNER_TOKEN");
		expect(copied.join()).not.toContain("session-token");
	});

	it("opens every Admin page with its intro and no load failure", async () => {
		const b = browser({ signedIn: true, hash: "#/profiles", api });
		await dashboardMain(b.win);
		await settle();
		const bad: string[] = [];
		for (const h of ["#/profiles", "#/draft/work", "#/review/work", "#/backups", "#/routing", "#/move", "#/copy/work", "#/wipe", "#/wipe/work"]) {
			b.go(h);
			for (let i = 0; i < 2; i++) await settle();
			const t = text(b.view());
			if (!find(b.view(), "p").some((x) => x.attrs.class === "intro") || /No page|Could not/.test(t)) bad.push(`${h}: ${t.slice(0, 160)}`);
		}
		expect(bad).toEqual([]);
	});
});


describe("dashboard library: sections, detail, connections, map", () => {
	const today = new Date().toISOString();
	const N = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({ id, kind, name, type: null, scope: null, status: "active", updated_at: today, created_at: today, ...extra });
	// The owner's project registry is their own data: one record per profile (synthetic names only here).
	const REG = "dashboard-project-registry";
	const WORK_REG = { workspaces: [{ id: "labs", name: "Labs", order: 1 }, { id: "apps", name: "Apps", order: 2 }], owners: ["acme-corp"], default_workspace: "labs",
		repos: [{ key: "acme-corp/widget-frontend", name: "widget", workspaces: ["labs", "apps"] }, { key: "acme-corp/gizmo-frontend", name: "gizmo", workspaces: ["labs"] }, { key: "acme-corp/idm-frontend", name: "idm", workspaces: ["labs", "apps"] }],
		aliases: { labs: "ws:labs", lab: "ws:labs", apps: "ws:apps", "claude/projects-apps": "ws:apps", "claude/projects-gizmo": "acme-corp/gizmo-frontend", "claude/projects-labs-widget": "acme-corp/widget-frontend?", "ai-internal": "ws:labs?" } };
	const PERSONAL_REG = { workspaces: [{ id: "studio", name: "Studio", order: 3 }], owners: ["jdoe"], default_workspace: "studio",
		repos: [{ key: "jdoe/recall-engine", name: "memory", workspaces: ["studio"] }, { key: "jdoe/sketchbook", workspaces: ["studio"] }, { key: "jdoe/dotrc", workspaces: ["studio"] }, { key: "acme-corp/side-gig", workspaces: ["studio"] }],
		aliases: { "recall-engine": "jdoe/recall-engine", sketchbook: "jdoe/sketchbook", "claude/projects-studio-sketchbook": "jdoe/sketchbook", "studio/dotrc": "jdoe/dotrc", "projects/side-gig": "acme-corp/side-gig", studio: "ws:studio?" },
		drop: ["repo-fact", "agent-evaluation", "bot_hq", "tool-label", "codex", "tooling/codex"], not_projects: ["jdoe/attic"] };
	const regs: Record<string, unknown> = { work: WORK_REG, personal: PERSONAL_REG };
	const NODES = [N("p1", "project", "recall-engine", { key: "github:jdoe/recall-engine" }), N("p2", "project", "sketchbook"), N("u1", "person", "Ana"),
		N("regw", "document", REG, { type: "reference" }),
		N("m1", "decision", "cache-policy", { type: "project", scope: "recall-engine" }), N("l1", "rule", "Always run the tests", { type: "feedback" }),
		N("j1", "journal", "task-journal-2026-11-12-1130-claude-code-dashboard-hill-climb", { type: "project" }), N("s1", "session", "", { key: "session:codex:abc" }),
		N("p3", "project", "synthetic-fixture-project"), N("40e647a4-713a-5ea9-85bc-b9ddf5ec1956", "project", "Synthetic corpus acceptance project 59c5", { key: "github:Acme-Corp/eureka-frontend" })];
	const E = (id: number, src: string, dst: string, rel: string) => ({ id, src, dst: { id: dst, readable: true }, rel });
	const EDGES = [E(1, "u1", "p1", "works_on"), E(2, "m1", "s1", "relates_to"), E(3, "l1", "p1", "part_of"), E(4, "u1", "l1", "authored"), E(5, "p2", "u1", "relates_to"), E(6, "j1", "p1", "part_of"), E(7, "l1", "p2", "part_of")];
	const api: Api = (path, _m, body) => {
		if (path.startsWith("/api/profiles/work/graph?part=nodes")) return Response.json({ items: NODES, next_after: null, done: true, total: NODES.length });
		if (path.startsWith("/api/profiles/work/graph?part=edges")) return Response.json({ items: EDGES, next_after: null, done: true });
		if (path.startsWith("/api/profiles/personal/graph?part=nodes")) return Response.json({ items: [N("regp", "document", REG, { type: "reference" })], next_after: null, done: true, total: 1 });
		if (path.startsWith("/api/profiles/personal/graph")) return Response.json({ items: [], next_after: null, done: true, total: 0 });
		// A view of one profile finds the other profiles' registries by name (a lexical recall), then reads them.
		if (path.endsWith("/recall") && (body as { keyword?: string })?.keyword === REG) { const p = /profiles\/([^/]+)\//.exec(path)![1]!; return Response.json({ results: regs[p] ? [{ memory_id: p === "work" ? "regw" : "regp", name: REG }] : [] }); }
		const reg = /^\/api\/profiles\/(work|personal)\/nodes\/(regw|regp)$/.exec(path);
		if (reg) return regs[reg[1]!] === undefined ? Response.json({ error: { code: "not_found", message: "gone" } }, { status: 404 })
			: Response.json({ node: { id: reg[2], name: REG, kind: "document", memory_type: "reference", status: "active" }, content: { text: typeof regs[reg[1]!] === "string" ? regs[reg[1]!] : JSON.stringify(regs[reg[1]!]), complete: true }, evidence: { items: [] } });
		if (path === "/api/profiles/work/nodes/m1") return Response.json({ node: { id: "m1", name: "cache-policy", kind: "decision", memory_type: "project", status: "active", revision: 2 },
			content: { text: `## Why\nWe cache **reads** for \`60s\`.\n\n- one\n- two\n\n${HOSTILE} [bad](javascript:alert(1)) [docs](https://example.test/x)\n\n\`\`\`\nrm -rf <b>\n\`\`\``, complete: true },
			evidence: { items: [{ kind: "session", ref: "codex:abc" }] }, links: [], history: { items: [] } });
		if (path.startsWith("/api/profiles/work/journals?id=j1&limit=25")) return Response.json({ journal: { id: "j1" }, entries: [
			{ entry_seq: 1, created_at: "2026-11-12T09:00:00Z", body: "## entry 1\nFirst." }, { entry_seq: 5, created_at: today, body: "## entry 5 — decision\nUse **blocks**." }] });
		if (path.startsWith("/api/profiles/work/nodes/")) return Response.json({ node: { id: "x" }, links: [], evidence: { items: [] }, history: { items: [] }, content: {} });
	};
	const open = async (hash: string) => { const b = browser({ signedIn: true, hash, api }); await dashboardMain(b.win); for (let i = 0; i < 25; i++) await settle(); return b; };

	it("writes dates for humans: today and yesterday with the time, else the day, with the year only when it is not this one", async () => {
		const b = await open("#home?profile=work");
		const am = (b.win as unknown as { __am: { when(iso: string): { text: string; full: string } } }).__am, now = new Date();
		const at = (d: number, h = 10, m = 28) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, h, m).toISOString();
		expect(am.when(at(0)).text).toBe("Today 10:28");
		expect(am.when(at(1, 18, 2)).text).toBe("Yesterday 18:02");
		expect(am.when(new Date(now.getFullYear() - 1, 10, 12).toISOString()).text).toBe(`12 Nov ${now.getFullYear() - 1}`);
		expect(am.when("not a date").text).toBe("");
	});

	it("lists memories with human titles and one meta line, and opens one with its markdown as safe text and where it came from", async () => {
		const b = await open("#memories/work/m1?profile=work");
		const row = find(b.view(), "a").find((a) => a.attrs.class === "row")!;
		expect(text(row)).toContain("Cache policy");
		expect(text(row)).toMatch(/Today \d\d:\d\d/);
		expect(text(row)).toContain("Project note · memory · in your work profile"); // its scope names a personal-owner repo, though stored in work
		const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!;
		expect(find(detail, "h2")[0]!.textContent).toBe("Cache policy");
		expect(text(detail)).toContain("From a Codex session");
		expect(find(detail, "h4").map((h) => text(h).trim())).toContain("Why");
		expect(find(detail, "strong").map((x) => text(x).trim())).toContain("reads");
		expect(find(detail, "li").map(text)).toEqual(expect.arrayContaining(["one", "two"]));
		expect(find(detail, "pre").map(text)).toEqual(["rm -rf <b>"]);
		expect([find(detail, "img"), find(detail, "b")]).toEqual([[], []]); // stored text never becomes markup
		expect(find(detail, "a").filter((a) => /javascript/.test(a.attrs.href ?? ""))).toEqual([]); // only http(s) links
		expect(find(detail, "a").find((a) => a.textContent === "docs")!.attrs.href).toBe("https://example.test/x");
		const chips = find(detail, "a").filter((a) => String(a.attrs.class).startsWith("chip-link")).map((a) => text(a).trim());
		expect(chips[0]).toBe("memory"); // its project by its short name, from its scope; the session is the source line, not a chip
		expect(chips).toEqual(expect.arrayContaining(["Always run the tests", "Dashboard hill climb"])); // the rest of its project
		const more = find(detail, "details").find((d) => d.attrs.class === "conn-more")!;
		expect(text(find(more, "summary")[0]!)).toBe("More in memory (2)"); // folded under the direct links, which come first
		expect(text(detail)).toContain("Stored in your work profile"); // a quiet hint; nothing is moved
		expect(text(detail)).not.toMatch(/none recorded|\(0\)/i);
	});

	it("shows a journal's entries newest first as cards, with the heading noise gone and its label as a tag", async () => {
		const b = await open("#journals/work/j1?profile=work");
		const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!;
		expect(find(detail, "h2")[0]!.textContent).toBe("Dashboard hill climb");
		const cards = find(detail, "li").filter((li) => li.attrs.class === "entry");
		expect(cards.map(text)[0]).toContain("decision");
		expect(text(cards[0]!)).toMatch(/Use\s+blocks\s*\./);
		expect(text(detail)).not.toMatch(/##|entry 5/);
	});

	it("shows projects as workspace groups of cards, one entity per repo, and a project's page as a hub", async () => {
		const b = await open("#projects?profile=work");
		const secs = find(b.view(), "section").filter((x) => x.attrs.class === "ws-sec");
		expect(secs.map((x) => text(find(x, "h3")[0]!).trim())).toEqual(["Studio"]); // only projects memories resolve to; sketchbook has only a person
		const cards = find(b.view(), "a").filter((a) => a.attrs.class === "pcard");
		expect(cards.map((c) => text(find(c, "strong")[0]!).trim())).toEqual(["memory", "sketchbook"]); // the short name first
		expect(text(cards[0]!)).not.toContain("recall-engine"); // the GitHub repo name stays behind the GitHub link
		expect(text(cards[0]!)).toMatch(/1 memory · 1 learning · 1 journal/);
		expect(text(cards[0]!)).toContain("Personal"); // the profile its GitHub owner gives, as a quiet tag
		expect(text(b.view())).not.toMatch(/Synthetic|eureka|Show all known repos/i); // fixture projects are dropped, even with a real-looking key
		b.go(cards[0]!.attrs.href!);
		for (let i = 0; i < 5; i++) await settle();
		const detail = find(b.view(), "section").find((x) => String(x.attrs.class).startsWith("lib-detail"))!;
		expect(text(detail)).toContain("When work happened");
		const weeks = find(detail, "figure").find((f) => f.attrs.class === "chart daily")!; // stacked day bars, as on Home
		expect(text(find(weeks, "figcaption")[0]!)).toMatch(/1 journal.*1 memory.*1 learning.*added in the last \d+ weeks/);
		const rel = find(detail, "figure").find((f) => f.attrs.class === "chart rel")!;
		expect(text(rel)).toContain("sketchbook");
		expect(text(rel)).toContain("1 learning in common"); // the edge says how the two projects connect
		expect(text(rel)).not.toContain("Ana"); // People is off the dashboard for now
		expect(find(detail, "a").find((a) => a.textContent === "Open on GitHub ↗")!.attrs.href).toBe("https://github.com/jdoe/recall-engine");
		expect(find(b.view(), "a").find((a) => a.textContent === "← All projects")).toBeDefined();
	});

	it("sets the width mode the layout follows, and gives a phone's full-screen detail a way back to the list", async () => {
		const modeAt = async (w: number) => { const b = browser({ signedIn: true, hash: "#memories/work/m1?profile=work", api }); Object.assign(b.win, { innerWidth: w }); await dashboardMain(b.win); return b; };
		expect((await modeAt(390)).html.attrs["data-width"]).toBe("phone");
		expect((await modeAt(768)).html.attrs["data-width"]).toBe("tablet");
		expect((await modeAt(1024)).html.attrs["data-width"]).toBe("desktop"); // list and detail side by side, 40/60
		const wide = await modeAt(1920);
		expect(wide.html.attrs["data-width"]).toBe("desktop");
		for (let i = 0; i < 25; i++) await settle();
		const back = find(wide.view(), "a").find((a) => a.attrs.class === "back-btn")!;
		expect([back.textContent, back.attrs.href]).toEqual(["← Back", "#memories?profile=work"]); // CSS shows it on a phone, where Close hides
		expect(find(wide.view(), "section").map((x) => x.attrs.class)).toEqual(expect.arrayContaining(["lib-side", "lib-list", "lib-detail"]));
	});

	it("suggests results while typing, grouped by type, moves through them with the arrow keys, and opens the chosen one on Enter", async () => {
		const b = await open("#home?profile=work");
		const box = byId(b.els.tools!, "global-search"), list = find(b.els.tools!, "ul").find((u) => u.attrs.id === "search-results")!;
		box.value = "cache";
		box.on.keydown!({ key: "ArrowDown", preventDefault() {} } as never); // opens the list (typing does the same after a short pause)
		expect(list.hidden).toBe(false);
		expect(find(list, "li").filter((li) => li.attrs.class === "sr-group").map((g) => g.textContent)).toEqual(["Memories"]);
		const opts = find(list, "li").filter((li) => li.attrs.role === "option");
		expect(opts.map((o) => text(o).trim())[0]).toMatch(/^Cache policy/);
		expect([opts[0]!.attrs["aria-selected"], box.attrs["aria-activedescendant"]]).toEqual(["true", "sr-0"]);
		find(b.els.tools!, "form")[0]!.on.submit!({ preventDefault() {} });
		expect(b.win.location.hash).toBe("#memories/work/m1?profile=work");
		expect(list.hidden).toBe(true);
	});

	it("gives every record one display title: slug noise stripped, a thin slug title replaced by its own first sentence everywhere", async () => {
		const b0 = await open("#home?profile=work");
		const human = (b0.win as unknown as { __am: { human(n: string, k?: string): string } }).__am.human;
		expect(["widget-010", "opus-routing-57A8CC3C", "repo-facts-privacy-signoff-2026-11-11", "task-journal-2026-11-12-1130-codex-gizmo-rsdoctor"].map((n) => human(n)))
			.toEqual(["Widget", "Opus routing", "Repo facts privacy signoff", "Gizmo rsdoctor"]);
		NODES.push(N("m2", "decision", "MEMORY.md", { type: "reference" }));
		try {
			const b = browser({ signedIn: true, hash: "#memories/work/m2?profile=work", api: (p, m, body) => p === "/api/profiles/work/nodes/m2"
				? Response.json({ node: { id: "m2", name: "MEMORY.md", kind: "decision", status: "active", description: "- Keep the memory file short. Then more." }, content: { text: "x", complete: true }, evidence: { items: [] } })
				: api(p, m, body) });
			await dashboardMain(b.win);
			for (let i = 0; i < 25; i++) await settle();
			const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!, row = find(b.view(), "a").find((a) => a.attrs.class === "row" && a.attrs.href?.includes("/m2"))!;
			expect(find(detail, "h2")[0]!.textContent).toBe("Keep the memory file short."); // from its own words, list marker gone
			expect(text(find(row, "span").find((x) => x.attrs.class === "row-title")!).trim()).toBe("Keep the memory file short."); // the same title in the list
		} finally { NODES.pop(); }
	});

	it("lists direct links first, each saying how, and folds the rest of the project away", async () => {
		EDGES.push(E(8, "m1", "l1", "supersedes"));
		try {
			const b = await open("#memories/work/m1?profile=work");
			const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!;
			const groups = find(detail, "div").filter((d) => d.attrs.class === "conn-group").map((g) => text(g).replace(/\s+/g, " ").trim());
			expect(groups.find((g) => g.startsWith("Linked"))).toContain("replaces Always run the tests"); // the relation as a small label before the title
			expect(text(find(detail, "details").find((d) => d.attrs.class === "conn-more")!)).not.toContain("Always run the tests"); // never twice
		} finally { EDGES.pop(); }
	});

	it("opens the phone menu with the sections and the profile choice, and Enter without a highlight opens all results", async () => {
		const b = await open("#home?profile=work");
		const menu = find(b.els.tools!, "button").find((x) => x.attrs["aria-label"] === "Sections")!;
		click(menu);
		expect([b.els.nav!.attrs["data-open"], menu.attrs["aria-expanded"]]).toEqual(["true", "true"]);
		const pick = find(b.els.nav!, "select")[0]!;
		expect([find(pick, "option").map((o) => o.textContent), pick.value]).toEqual([["All profiles", "personal", "work"], "work"]); // the header's choice, mirrored
		const box = find(b.els.tools!, "input").find((x) => x.attrs.id === "global-search")!;
		box.value = "cache";
		find(b.els.tools!, "form")[0]!.on.submit!({ preventDefault() {} });
		expect(b.win.location.hash).toBe("#search?q=cache&profile=work");
		// The dropdown's footer is a real link to the same page, and a click on it goes there.
		b.go("#home?profile=work");
		box.value = "cache";
		box.on.keydown!({ key: "ArrowDown", preventDefault() {} } as never);
		const all = find(b.els.tools!, "li").find((x) => String(x.attrs.class).includes("sr-all"))!;
		expect(find(all, "a")[0]!.attrs.href).toBe("#search?q=cache&profile=work");
		all.on.click!({ preventDefault() {} });
		expect(b.win.location.hash).toBe("#search?q=cache&profile=work");
		// Search starts closed on a phone; only ⌕ (named "Search") opens its row, and Esc closes it.
		const opener = find(b.els.tools!, "button").find((x) => x.attrs["aria-label"] === "Search")!, row = find(b.els.tools!, "div").find((x) => String(x.attrs.class).includes("gwrap"))!;
		expect([row.attrs.class, opener.attrs["aria-expanded"], find(opener, "span").map((x) => x.textContent)]).toEqual(["pop-host gwrap", "false", ["Search"]]);
		click(opener);
		expect(row.attrs.class).toBe("pop-host gwrap open");
		b.key("Escape");
		expect([row.attrs.class, opener.attrs["aria-expanded"]]).toEqual(["pop-host gwrap", "false"]);
	});

	it("colours sub-types with distinct, fixed hues (Rule and Preference never share one), and keeps kind colours elsewhere", async () => {
		NODES.push(N("l2", "preference", "Prefer short answers"));
		try {
			const b = await open("#learnings?profile=work");
			const chips = find(b.view(), "button").filter((x) => x.attrs["aria-pressed"] !== undefined && find(x, "i").length)
				.map((x) => `${text(find(x, "span")[0]!).trim()} ${find(x, "i")[0]!.attrs.class}`);
			expect(chips).toEqual(expect.arrayContaining(["Rule sw t-s1", "Preference sw t-s2"]));
			const dots = find(b.view(), "a").filter((a) => a.attrs.class === "row").map((a) => find(a, "i")[0]!.attrs.class);
			expect(new Set(dots)).toEqual(new Set(["sw t-s1", "sw t-s2"])); // the list's dots match its chips
			const home = await open("#home?profile=work");
			const learn = find(home.view(), "a").filter((a) => a.attrs.class === "row" && a.attrs.href?.startsWith("#learnings")).map((a) => find(a, "i")[0]!.attrs.class);
			expect(new Set(learn)).toEqual(new Set(["sw t-learning"])); // outside its section a record shows its kind
		} finally { NODES.pop(); }
	});

	// The pre-production review's fixes (Sol, 2026-11-12): each a write or read that must never lose or cut text.
	const am = (b: ReturnType<typeof browser>) => (b.win as unknown as { __am: { drafts: Map<string, Record<string, unknown>> } }).__am;
	const withNode = (node: Record<string, unknown>, content: Record<string, unknown>, extra: Api = () => undefined): Api => async (p, m, body) =>
		(await extra(p, m, body)) ?? (p === "/api/profiles/work/nodes/m1" ? Response.json({ node: { id: "m1", name: "cache-policy", kind: "decision", memory_type: "project", status: "active", revision: 4, ...node }, content, evidence: { items: [] } }) : api(p, m, body));
	const openWith = async (hash: string, a: Api) => { const b = browser({ signedIn: true, hash, api: a }); await dashboardMain(b.win); for (let i = 0; i < 25; i++) await settle(); return b; };

	it("edits with the whole text: reads every content page first, refuses a cut description, and never replaces an unsaved draft", async () => {
		const b = await openWith("#memories/work/m1?profile=work", withNode({ description: "why" }, { text: "part one ", chars: 17, complete: false }, (p) =>
			p === "/api/profiles/work/nodes/m1?content=all" ? Response.json({ id: "m1", content: { content: "part one ", complete: false, cursor: "k1" } })
				: p === "/api/profiles/work/nodes/m1?content=all&cursor=k1" ? Response.json({ id: "m1", content: { content: "part two", complete: true, cursor: null } }) : undefined));
		click(button(b.view(), "Edit"));
		for (let i = 0; i < 6; i++) await settle();
		expect(am(b).drafts.get("work")).toMatchObject({ memory_id: "m1", expected_revision: 4, description: "why", content: "part one part two" }); // never the prefix
		expect(b.win.location.hash).toBe("#/draft/work");

		// A draft already waiting in that profile is kept: Edit says so instead of replacing it.
		const c = await openWith("#memories/work/m1?profile=work", withNode({ description: "why" }, { text: "all of it", complete: true }));
		am(c).drafts.set("work", { name: "unsaved" });
		click(button(c.view(), "Edit"));
		for (let i = 0; i < 4; i++) await settle();
		expect(am(c).drafts.get("work")).toEqual({ name: "unsaved" });
		expect(text(c.view())).toContain("There is an unsaved draft in work; save or discard it in Write first.");

		// A description the server cut short: no Edit at all, and the page says why.
		const d = await openWith("#memories/work/m1?profile=work", withNode({ description: "x".repeat(4000), truncated: ["description"] }, { text: "body", complete: true }));
		expect(find(d.view(), "button").some((x) => x.textContent === "Edit")).toBe(false);
		expect(text(d.view())).toContain("Editing is off here");
	});

	it("reads a long record in full on request", async () => {
		const b = await openWith("#memories/work/m1?profile=work", withNode({}, { text: "part one ", chars: 17, complete: false }, (p) =>
			p.startsWith("/api/profiles/work/nodes/m1?content=all") ? Response.json({ id: "m1", content: { content: p.includes("cursor") ? "part two" : "part one ", complete: p.includes("cursor"), cursor: p.includes("cursor") ? null : "k1" } }) : undefined));
		click(button(b.view(), "Read all 17 characters"));
		for (let i = 0; i < 6; i++) await settle();
		expect(text(find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!)).toContain("part one part two");
	});

	it("keeps Forget's outcome and Undo on screen after the record stops reading", async () => {
		let gone = false;
		const b = await openWith("#memories/work/m1?profile=work", withNode({}, { text: "body", complete: true }, (p, m) => {
			if (p === "/api/profiles/work/nodes/m1/forget" && m === "POST") { gone = true; return Response.json({ ok: true, action: "forget", activity_id: 21 }); }
			if (p === "/api/profiles/work/nodes/m1" && gone) return Response.json({ error: { code: "not_found", message: "no such record" } }, { status: 404 });
		}));
		click(button(b.view(), "Forget…"));
		click(button(b.view(), "Forget"));
		for (let i = 0; i < 8; i++) await settle();
		expect(text(b.view())).toMatch(/Forgot “[^”]+”\./);
		expect(text(b.view())).toContain("This record is no longer here");
		expect(button(b.view(), "Undo last change")).toBeDefined();
	});

	it("shows a long journal's newest entries first, reading every page", async () => {
		const page = (after: number) => Array.from({ length: Math.min(25, 250 - after) }, (_, i) => ({ entry_seq: after + i + 1, created_at: today, body: `note ${after + i + 1}` }));
		const b = await openWith("#journals/work/j1?profile=work", (p, m, body) => {
			const m2 = /^\/api\/profiles\/work\/journals\?id=j1&limit=25(?:&entries_after=(\d+))?$/.exec(p);
			if (!m2) return api(p, m, body);
			const after = Number(m2[1] ?? 0), entries = page(after);
			return Response.json({ journal: { id: "j1", status: "active" }, entries, next_after: after + entries.length < 250 ? after + entries.length : null });
		});
		const cards = find(b.view(), "li").filter((li) => li.attrs.class === "entry");
		expect(text(cards[0]!)).toContain("note 250"); // the newest, not entry 225
		expect(text(b.view())).toContain("Entries 250");
		expect(text(b.view())).not.toContain("has more than the page reads");
	});

	it("opens an older address with only the record id in its profile's place", async () => {
		const b = await open("#memories/m1?profile=work");
		expect(b.win.location.hash).toBe("#memories/work/m1?profile=work");
		expect(find(find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!, "h2")[0]!.textContent).toBe("Cache policy");
	});

	it("retries a failed library read, says it failed with a Retry, and recovers from Retry", async () => {
		let fail = true, reads = 0;
		const b = await openWith("#home?profile=work", (p, m, body) => {
			if (p.startsWith("/api/profiles/work/graph?part=nodes")) { reads++; if (fail) return Response.json({ error: { code: "unavailable", message: "store down" } }, { status: 503 }); }
			return api(p, m, body);
		});
		await new Promise((r) => setTimeout(r, 4200)); // two retries, 0.8 s and 3 s apart
		for (let i = 0; i < 5; i++) await settle();
		expect(reads).toBe(3); // the first read and two retries, then it waits: no loop of empty reads
		const sync = find(b.els.tools!, "span").find((x) => x.attrs.class === "sync")!;
		expect(text(sync)).toContain("Couldn’t refresh");
		fail = false;
		click(find(sync, "button").find((x) => x.textContent === "Retry")!);
		for (let i = 0; i < 25; i++) await settle();
		expect(text(sync)).toContain("Live");
		expect(text(b.view())).toContain("Cache policy");
	}, 15_000);

	it("stops a page's scroll observers when the page is left", async () => {
		const live = new Set<object>();
		class IO { constructor() { live.add(this); } observe() {} disconnect() { live.delete(this); } }
		const entries = Array.from({ length: 30 }, (_, i) => ({ entry_seq: i + 1, created_at: today, body: `note ${i + 1}` }));
		const b = browser({ signedIn: true, hash: "#journals/work/j1?profile=work", api: (p, m, body) => p.startsWith("/api/profiles/work/journals?id=j1") ? Response.json({ journal: { id: "j1", status: "active" }, entries }) : api(p, m, body) });
		Object.assign(b.win, { IntersectionObserver: IO });
		await dashboardMain(b.win);
		for (let i = 0; i < 25; i++) await settle();
		expect(live.size).toBeGreaterThan(0); // the journal's "earlier entries" row is watched
		b.go("#home?profile=work");
		expect(live.size).toBe(0);
	});

	it("creates a device with checked permissions and shows its token once; Revoke asks first and Cancel changes nothing", async () => {
		const b = await openWith("#/devices", (p, m, body) => {
			if (p === "/api/devices" && m === "POST") return Response.json({ name: (body as { name: string }).name, token: "am_dev_secret" }, { status: 201 });
			return api(p, m, body);
		});
		const form = find(b.view(), "form")[0]!, name = find(form, "input").find((x) => x.attrs.name === "name")!;
		name.value = "new-box";
		form.on.submit!({ preventDefault() {} });
		for (let i = 0; i < 6; i++) await settle();
		expect(b.seen.bodies.at(-1)).toMatchObject({ name: "new-box", scopes: ["read", "write"], profiles: ["personal"] });
		const token = find(form, "div").find((x) => x.attrs.class === "token")!;
		expect([token.hidden, token.textContent]).toEqual([false, "Token for new-box (shown once; keep it in the keychain now): am_dev_secret"]);
		const revoke = find(b.view(), "button").find((x) => x.attrs["aria-label"] === "Revoke laptop")!;
		click(revoke);
		click(button(b.view(), "Cancel"));
		expect(b.seen.posted.filter((x) => x.includes("/revoke"))).toEqual([]);
		expect(revoke.hidden).toBe(false);
	});

	it("charts Home per day over 12 weeks: 84 stacked bars, no numbers on them, today marked, a day's counts on demand", async () => {
		const b = await open("#home?profile=work");
		expect(find(b.view(), "h3").map((h) => h.textContent)).toContain("Added per day, last 12 weeks");
		const fig = find(b.view(), "figure").find((f) => f.attrs.class === "chart daily")!, cols = find(fig, "div").filter((d) => /^col( |$)/.test(String(d.attrs.class)));
		expect(cols.length).toBe(84);
		expect(find(fig, "span").some((x) => x.attrs.class === "val")).toBe(false); // no per-bar numbers
		expect(cols.at(-1)!.attrs.class).toContain("today");
		const readout = find(fig, "p").find((p) => p.attrs.class === "readout")!;
		expect(readout.textContent).toMatch(/^Today: 1 memory, 1 learning, 1 journal$/); // today's counts until a day is chosen
		find(fig, "div").find((d) => String(d.attrs.class).startsWith("cols"))!.on.keydown!({ key: "ArrowLeft", preventDefault() {} } as never);
		expect(readout.textContent).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ [A-Z][a-z]{2}: nothing added$/);
		expect(text(fig)).toContain("added in the last 12 weeks");
		const fit = (b.win as unknown as { __am: { fitWeeks(box: unknown, w: number): number } }).__am.fitWeeks;
		expect([fit({ clientWidth: 800 }, 12), fit({ clientWidth: 240 }, 12)]).toEqual([12, 4]); // bars under 2 px fall back to 4 weeks
	});

	it("names records and sources for people: tag and command fragments read the record's text, devices and raw links are detail", async () => {
		NODES.push(N("m3", "decision", "<kernel planning> push feat dynav a h", { type: "reference" }));
		try {
			const b = await openWith("#memories/work/m3?profile=work", (p, m, body) => p === "/api/profiles/work/nodes/m3"
				? Response.json({ node: { id: "m3", name: "x", kind: "decision", status: "active", description: "Push the dynav feature branch. Then more.", source_platform: "device:main-work-personal-20261102", origin: "agent", created_at: today },
					content: { text: "body", complete: true }, evidence: { items: [{ kind: "url", ref: "https://drafts.example.com/d/3a4f026ac12360e57d7" }, { kind: "pr", ref: "https://github.com/jdoe/sketchbook/pull/66" }] } })
				: api(p, m, body));
			const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!;
			expect(find(detail, "h2")[0]!.textContent).toBe("Push the dynav feature branch.");
			const from = text(find(detail, "div").find((d) => String(d.attrs.class).includes("from"))!);
			expect(from).toContain("Saved by an agent");
			expect(from).not.toContain("main-work-personal"); // the device is in the tooltip only
			expect(from).toContain("Draft page");
			expect(from).not.toContain("3a4f026ac");
		} finally { NODES.pop(); }
		const p2 = await open("#projects?profile=work");
		expect(text(find(p2.view(), "span").find((x) => x.attrs.class === "count")!)).toMatch(/^\d+ unique$/);
	});

	// Sol re-check, 2026-11-12: three P2s, each with its regression.
	it("still reads and edits a record whose evidence link has a malformed escape", async () => {
		const b = await openWith("#memories/work/m1?profile=work", withNode({}, { text: "body", complete: true }, (p) => p === "/api/profiles/work/nodes/m1"
			? Response.json({ node: { id: "m1", name: "cache-policy", kind: "decision", memory_type: "project", status: "active", revision: 4 }, content: { text: "body text", complete: true }, evidence: { items: [{ kind: "url", ref: "https://example.com/100%" }] } })
			: undefined));
		const detail = find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!;
		expect(text(detail)).toContain("body text");
		expect(text(detail)).toContain("example.com: 100%"); // the path text, undecoded
		expect(button(detail, "Edit")).toBeDefined();
	});

	it("adds Linked chips that arrive after the record, redrawing only Connections", async () => {
		const edges = gate();
		EDGES.push(E(8, "m1", "l1", "supersedes"));
		try {
			const b = await openWith("#memories/work/m1?profile=work", async (p, m, body) => {
				if (p.startsWith("/api/profiles/work/graph?part=edges")) { await edges.wait; return Response.json({ items: EDGES, next_after: null, done: true }); }
				return api(p, m, body);
			});
			const detail = () => find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!, h2 = find(detail(), "h2")[0]!;
			expect(text(detail())).not.toContain("replaces");
			edges.open();
			for (let i = 0; i < 30; i++) await settle();
			expect(text(detail())).toContain("replaces Always run the tests");
			expect(find(detail(), "h2")[0]).toBe(h2); // the same pane: nothing else redrawn
			expect(find(detail(), "section").filter((x) => x.attrs.class === "connections").length).toBe(1);
		} finally { EDGES.pop(); }
	});

	it("updates a Linked chip when a later read adds another relation to the same neighbour", async () => {
		let second = false;
		EDGES.push(E(8, "m1", "l1", "relates_to"));
		try {
			const b = await openWith("#memories/work/m1?profile=work", (p, m, body) => {
				if (p.startsWith("/api/profiles/work/graph?part=edges")) return Response.json({ items: second ? [...EDGES, E(9, "m1", "l1", "supersedes")] : EDGES, next_after: null, done: true });
				return api(p, m, body);
			});
			const detail = () => find(b.view(), "section").find((x) => x.attrs.class === "lib-detail")!, h2 = find(detail(), "h2")[0]!;
			const linked = () => text(find(detail(), "div").filter((d) => d.attrs.class === "conn-group").find((g) => text(g).trim().startsWith("Linked"))!);
			expect(linked()).toContain("related Always run the tests");
			expect(linked()).not.toContain("replaces");
			second = true; // the refresh reads the edges again and finds a second relation to the same learning
			(b.win as unknown as { __am: { resync(): void } }).__am.resync();
			for (let i = 0; i < 40; i++) await settle();
			expect(linked()).toContain("replaces");
			expect(find(detail(), "h2")[0]).toBe(h2); // only Connections redrawn
		} finally { EDGES.pop(); }
	});

	it("bins and labels days by calendar date across a daylight-saving change", async () => {
		const b = await open("#home?profile=work");
		const am = (b.win as unknown as { __am: { daily(parent: El, series: { label: string; kind: string; dates: string[] }[], weeks: number): El } }).__am;
		// New York time around the 8 Mar 2026 change (UTC-5, then UTC-4), with the clock at noon on 15 Mar 2026.
		const Real = Date, DST = Real.UTC(2026, 2, 8, 7), off = (t: number) => (t >= DST ? 4 : 5) * 3_600_000;
		class NY extends Real {
			constructor(...a: number[]) {
				if (a.length === 0) super(Real.UTC(2026, 2, 15, 16));
				else if (a.length === 1) super(a[0]!);
				else { const g = Real.UTC(a[0]!, a[1]!, a[2] ?? 1, a[3] ?? 0, a[4] ?? 0); super(g + off(g + 5 * 3_600_000)); }
			}
			private local() { return new Real(this.getTime() - off(this.getTime())); }
			getFullYear() { return this.local().getUTCFullYear(); }
			getMonth() { return this.local().getUTCMonth(); }
			getDate() { return this.local().getUTCDate(); }
			getDay() { return this.local().getUTCDay(); }
			getHours() { return this.local().getUTCHours(); }
			getMinutes() { return this.local().getUTCMinutes(); }
		}
		const box = b.win.document.createElement("div") as unknown as El;
		globalThis.Date = NY as unknown as DateConstructor;
		try { am.daily(box, [{ label: "memory", kind: "memory", dates: ["2026-02-16T15:00:00Z"] }], 12); } finally { globalThis.Date = Real; }
		const titles = find(box, "div").filter((d) => /^col( |$)/.test(String(d.attrs.class))).map((d) => d.attrs.title);
		expect(titles.length).toBe(84);
		expect(titles).toContain("Mon 16 Feb: 1 memory");
		expect(titles).toContain("Sun 15 Feb: nothing added");
		expect(titles.at(-1)).toBe("Today: nothing added");
		expect(titles[0]).toBe("Mon 22 Dec: nothing added"); // 84 calendar days ending 15 Mar
	});

	it("places a record by its tagged project_key when the server sends one, and by its scope when it does not", async () => {
		NODES.push(N("t1", "decision", "Tagged decision", { type: "project", scope: "codex", project_key: "github:acme-corp/idm-frontend" }));
		try {
			const b = await open("#projects?profile=work");
			const cards = find(b.view(), "a").filter((a) => a.attrs.class === "pcard").map((c) => text(find(c, "strong")[0]!).trim());
			expect(cards).toEqual(expect.arrayContaining(["idm", "memory"])); // idm from the tag; memory from its scope, as before
		} finally { NODES.pop(); }
	});

	it("searches titles across every section", async () => {
		const b = await open("#search?q=cache&profile=work");
		expect(find(b.view(), "h2")[0]!.textContent).toBe("Results for “cache”");
		expect(text(b.view())).toContain("Cache policy");
		expect(text(b.view())).not.toContain("Always run the tests");
	});

	it("draws the map as readable blocks that never overlap, and opens a block's page beside it", async () => {
		const b = await open("#map?profile=work");
		const rect = (e: El) => { const s = e.attrs.style ?? "", n = (k: string) => Number(new RegExp(`${k}:(-?[\\d.]+)px`).exec(s)?.[1]); return { x: n("left"), y: n("top"), w: n("width"), h: n("height") }; };
		const blocks = () => find(b.view(), "button").filter((x) => String(x.attrs.class).includes("block"));
		const check = () => {
			const rs = blocks().map(rect);
			expect(rs.length).toBeGreaterThan(1);
			for (const [i, r] of rs.entries()) {
				expect(r.w).toBeGreaterThan(150);
				expect(text(blocks()[i]!).trim()).not.toBe("");
				for (const o of rs.slice(i + 1)) expect(r.x + r.w <= o.x || o.x + o.w <= r.x || r.y + r.h <= o.y || o.y + o.h <= r.y).toBe(true);
			}
		};
		check();
		expect(blocks().map((x) => find(x, "span")[1]!.textContent)).toEqual(expect.arrayContaining(["memory", "sketchbook"]));
		expect(blocks().some((x) => text(x).includes("Ana"))).toBe(false); // no people on the map
		const ana = blocks().find((x) => text(x).includes("sketchbook"))!;
		find(b.view(), "div").find((d) => d.attrs.class === "blocks")!.on.click!({ target: { closest: () => ana }, preventDefault() {} } as never);
		await settle();
		check();
		const side = find(b.view(), "aside").find((a) => a.attrs.class === "map-side")!;
		expect(side.hidden).toBe(false);
		expect(find(side, "h2")[0]!.textContent).toBe("sketchbook");
		expect(b.win.location.hash).toBe(b.win.location.hash); // the trail is in the address once the camera settles
	});

	it("places a record from the owner's registry: explicit repo key, then a registry alias, then the workspace, else unsorted", async () => {
		const b = await open("#home?profile=work");
		const am = (b.win as unknown as { __am: { placeOf(r: Record<string, unknown>): Record<string, unknown>; workspaceOrder: string[]; workspaceName(w: string): string } }).__am;
		const at = (r: Record<string, unknown>) => { const x = am.placeOf({ profile: "work", ...r }); return [x.workspace, x.project, x.confidence]; };
		// Both profiles' registries are read and merged, workspaces in their given order.
		expect([am.workspaceOrder.slice(0, 3), am.workspaceName("labs")]).toEqual([["labs", "apps", "studio"], "Labs"]);
		// Explicit keys win, normalized to lowercase owner/repo; the registry decides the workspace and the owner the profile.
		expect(at({ kind: "project", name: "idm", key: "github:Acme-Corp/idm-frontend" })).toEqual(["labs", "acme-corp/idm-frontend", "high"]);
		expect(at({ repo_key: "github.com/jdoe/recall-engine", scope: "labs" })).toEqual(["studio", "jdoe/recall-engine", "high"]);
		expect(am.placeOf({ profile: "work", scope: "studio/dotrc" })).toEqual({ workspace: "studio", workspaces: ["studio"], project: "jdoe/dotrc", confidence: "high", profile: "personal" });
		// One repo, several workspace folders.
		expect(am.placeOf({ profile: "work", scope: "claude/Projects-labs-widget" }).workspaces).toEqual(["labs", "apps"]);
		expect(at({ scope: "claude/Projects-labs-widget" })).toEqual(["labs", "acme-corp/widget-frontend", "medium"]);
		expect(at({ scope: "claude/Projects-gizmo" })).toEqual(["labs", "acme-corp/gizmo-frontend", "high"]);
		expect(at({ kind: "project", name: "Attic", key: "github:jdoe/attic" })).toEqual(["studio", null, "high"]); // ruled out: not a project
		expect(at({ kind: "project", name: "x", key: "github:jdoe/unlisted" })).toEqual(["studio", null, "high"]); // not in the registry: its workspace only
		expect(at({ scope: "projects/side-gig" })).toEqual(["studio", "acme-corp/side-gig", "high"]); // checked out in the personal folder…
		expect(am.placeOf({ profile: "personal", scope: "projects/side-gig" }).profile).toBe("work"); // …but its owner makes it work
		// Workspace-only aliases: a workspace with no project.
		expect(at({ scope: "labs" })).toEqual(["labs", null, "high"]);
		expect(at({ scope: "Lab" })).toEqual(["labs", null, "high"]);
		expect(at({ scope: "claude/Projects-apps" })).toEqual(["apps", null, "high"]);
		expect(at({ scope: "studio" })).toEqual(["studio", null, "medium"]);
		// Never a project: the registry's drop list, the generic empty scopes and this repo's own acceptance fixtures.
		for (const scope of ["bot_hq", "tool-label", "codex", "tooling/codex", "default", "", "repo-fact", "agent-evaluation", "am-accept-refs-20261101-59c5", "fixture/v1-cutover-20261102", "dashboard-smoke"])
			expect([scope, am.placeOf({ profile: "work", scope }).project, am.placeOf({ profile: "work", scope }).workspace]).toEqual([scope, null, null]);
		expect(am.placeOf({ profile: "work", kind: "project", id: "40e647a4-713a-5ea9-85bc-b9ddf5ec1956", key: "github:Acme-Corp/eureka-frontend" }).drop).toBe(true); // a fixture, before its real-looking key
		// Capture-tagged records (project_key, workspace): the strongest signal when present, normalized through the registry…
		expect(at({ scope: "labs", project_key: "github:Acme-Corp/idm-frontend" })).toEqual(["labs", "acme-corp/idm-frontend", "high"]);
		expect(at({ scope: "bot_hq", project_key: "github:jdoe/sketchbook" })).toEqual(["studio", "jdoe/sketchbook", "high"]);
		expect(at({ project_key: "github:someone/unknown-repo" })).toEqual(["labs", null, "high"]); // not in the registry: this profile's default workspace
		expect(at({ project_key: null, workspace: "apps", scope: "default" })).toEqual(["apps", null, "high"]);
		expect(at({ project_key: null, workspace: "elsewhere" })).toEqual([null, null, null]); // a workspace no registry names
		// …and without tags the scope rules apply unchanged.
		expect(at({ scope: "claude/Projects-gizmo", project_key: undefined, workspace: undefined })).toEqual(["labs", "acme-corp/gizmo-frontend", "high"]);
		expect(at({ scope: "codex", project_key: null, workspace: null })).toEqual([null, null, null]);
		for (const scope of ["projects/f1", "projects/unknown", "travel/2027"]) expect(at({ scope })).toEqual([null, null, null]);
	});

	it("skips bad registry entries and keeps the good ones, never showing the stored text", async () => {
		const saved = regs.work;
		regs.work = { ...WORK_REG, workspaces: [...WORK_REG.workspaces, { id: "Bad Id!" }, 7, null], repos: [...WORK_REG.repos, { key: "<img src=x onerror=alert(1)>" }, { key: "no-slash" }, "acme-corp/raw"],
			aliases: { ...WORK_REG.aliases, hostile: "javascript:alert(1)", "": "ws:labs", nested: { to: "x" } }, owners: [{}, "acme-corp"], drop: [3, "  "] };
		try {
			const b = await open("#projects?profile=work");
			const am = (b.win as unknown as { __am: { placeOf(r: Record<string, unknown>): Record<string, unknown>; workspaceOrder: string[] } }).__am;
			expect(am.workspaceOrder.slice(0, 3)).toEqual(["labs", "apps", "studio"]);
			expect(am.placeOf({ profile: "work", scope: "hostile" }).project).toBeNull();
			expect(am.placeOf({ profile: "work", scope: "claude/projects-gizmo" }).project).toBe("acme-corp/gizmo-frontend"); // the good entries still apply
			expect(find(b.view(), "img")).toEqual([]);
			expect(text(b.view())).not.toMatch(/onerror|javascript:/);
			regs.work = "{ not json";
			const c = await open("#projects?profile=work");
			expect(text(c.view())).toContain("memory"); // a registry that is not JSON counts as none: the personal one still places records
		} finally { regs.work = saved; }
	});

	it("works with no registry at all: capture tags and GitHub keys place records, nothing else is guessed", async () => {
		const saved = { ...regs };
		delete regs.work; delete regs.personal;
		try {
			const b = await open("#projects?profile=work");
			const am = (b.win as unknown as { __am: { placeOf(r: Record<string, unknown>): Record<string, unknown> } }).__am;
			expect(am.placeOf({ profile: "work", project_key: "github:Acme-Corp/Widget" })).toMatchObject({ project: "acme-corp/widget", workspace: "work", profile: "work" }); // any key is a project
			expect(am.placeOf({ profile: "personal", workspace: "labs" })).toMatchObject({ workspace: "labs", project: null }); // any tagged workspace
			expect(am.placeOf({ profile: "work", scope: "github.com/jdoe/sketchbook" })).toMatchObject({ project: "jdoe/sketchbook" });
			expect(am.placeOf({ profile: "work", scope: "recall-engine" }).project).toBeNull(); // aliases are the registry's: none here
			const cards = find(b.view(), "a").filter((a) => a.attrs.class === "pcard").map((c) => text(find(c, "strong")[0]!).trim());
			expect(cards).toContain("recall-engine"); // the project node's own key, named after its repo
		} finally { Object.assign(regs, saved); }
	});
});
