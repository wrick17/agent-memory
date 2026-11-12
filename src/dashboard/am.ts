// The dashboard's shared contract (section 15). /app.js is a list of parts, each a function serialized with toString():
// shell(window) builds `am` and puts it on window.__am, every other part receives it, registers its tab or pages, and
// shell's boot() signs in and renders. Parts may use only `am`, their own locals and browser globals; anything they
// import must be a type. Every value from the API or the URL reaches the page as text (textContent), never as markup.
// Types only: this file emits no code.
//
// Keys the shell handles for every page, through markup alone:
// - "/" focuses the first [data-search] element in the view, else its first input[type=search].
// - g then a letter opens a nav entry: g Graph, m Memories, u Audit, or a registered tab's key.
// - Up, Down, Home and End move focus between the visible [data-item] entries of the [data-list] that holds the focus.
//   Each [data-item] must be focusable (a button, a link, or tabindex).
// - Space, Left and Right click the visible button marked data-key="Space", "ArrowLeft" or "ArrowRight". Space on a
//   focused button or link activates that control instead.
// - Esc closes a glossary tip, the glossary panel, the narrow menu or the Admin list; with none open, it clicks the visible
//   [data-close] button in the view (a detail panel).
// The shell ignores keys typed into inputs, selects and text areas, except Esc.

import type { FeedItem, HealthCheck, Snapshot } from "../viewer/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the owner API and browser globals; this Worker project has no DOM types
export type J = any;

/** The slice of a DOM element the dashboard uses. */
export type Node = { appendChild(n: unknown): void; replaceChildren(): void; textContent: string; setAttribute(k: string, v: string): void; focus(options?: { preventScroll?: boolean }): void;
	addEventListener(type: string, f: (event: { preventDefault(): void }) => void): void; disabled: boolean; hidden: boolean; value: string; checked: boolean };

export type Failure = Error & { code?: string; status?: number; reason?: string };
export type Profile = { name: string; status: string; created_at: string; generation?: string };
export type Device = { name: string; kind: string; scopes: string[]; profiles: string[]; default_profile: string | null; enabled: boolean;
	expires_at: string | null; last_used_at: string | null; revoked_at: string | null };
export type Batch = { last_lease_at: string | null; last_status: { status: string; reason: string | null; at: string | null } | null };

// ---- Tabs ----

/** Nav groups for registered tabs, after the ungrouped Overview. Nothing registers a tab yet; each tab arrives with its own ticket. */
export type TabGroup = "memory" | "work" | "insight" | "system";

/** A parsed deep link: `#memories/ID`, `#sessions/ID?obs=3`, `#health/consolidation`. Parts are already URI-decoded. */
export type Route = { tab: string; id?: string; rest: string[]; query: Record<string, string>; hash: string };

export type TabDef = {
	id: string; // the deep-link name: #<id>/<rest>
	group: TabGroup | null; // null: before the groups (Overview)
	label: string;
	key: string; // g then this letter jumps here
	count?: (s: Pick<Snapshot, "counts">) => number | null; // the nav count, read only from a loaded snapshot; null shows none
	hidden?: boolean; // routable, but not listed in the nav (Replay opens from a session)
	/** Builds the tab inside `root` (already empty). Return the heading to focus after navigation. */
	render: (root: Node, route: Route) => Node | void;
	/**
	 * Opt in to the shared profile choice: the link's ?profile=NAME, and no query means All profiles. "any": All or one profile.
	 * "one": needs one profile; with no ?profile the shell shows a chooser instead of render(). For both, an unknown or inactive
	 * ?profile gets the shell's error and chooser, so render() never sees it. The header's profile picker shows only on these tabs.
	 */
	profiles?: "any" | "one";
};

/** One profile's outcome from am.eachProfile: every profile is reported, and a failure is never dropped or counted as zero. */
export type ProfileResult<T> = { profile: string; ok: true; value: T } | { profile: string; ok: false; error: Failure };

// ---- Live data (data.ts) ----

/** What am.api.subscribe delivers: the stream's events (ViewerEvent, parsed) and the client's own connection state. */
export type LiveEvent =
	| { type: "change"; item: FeedItem } // event: change
	| { type: "health"; checks: HealthCheck[] } // event: health
	| { type: "snapshot"; snapshot: Snapshot } // a fresh snapshot: the first load, each reconnect and each snapshot() call
	| { type: "paused"; as_of: string } // "Live updates paused. Numbers as of HH:MM."; as_of is "" before any snapshot loaded
	| { type: "live"; since: string };

/** The data client (src/dashboard/data.ts). */
export type DataClient = {
	start(): void; // called once by boot() after sign-in: the snapshot load, then the stream
	snapshot(): Promise<Snapshot>; // GET /api/viewer/snapshot; also sets am.snapshot and emits { type: "snapshot" }
	subscribe(fn: (e: LiveEvent) => void): () => void; // returns unsubscribe
};

// ---- Today's pages, under their old #/ routes ----

/** A page under an old #/ route. Profile pages get (view, profile, id?); backups, routing and home get (view); wipe gets (view, name?). */
export type LegacyPage = (view: Node, arg?: J, id?: J) => Node;

// `preview` is the exact payload (with its request id) a Save sends; `sent` is the last one Save sent, kept until the server confirms it.
export type Draft = { memory_id?: string; expected_revision?: number; recordName?: string; name: string; type: string; scope: string; description: string; content: string; target: string; targetName: string; reason: string;
	companyFree?: boolean; preview?: Record<string, unknown>; sent?: Record<string, unknown>; copyOf?: { profile: string; id: string; name: string; kind: string; back?: string } };
export type WhatIf = { name: string; target: string; targetName: string };
export type Move = { source: string; id: string; name: string; to: string; body: Record<string, unknown>; state: "sent" | "unknown" | "done" | "aborted" | "refused" | "progress"; text: string };
export type GNode = { id: string; name: string; kind: string; label: string | null; type: string | null; scope: string | null; status: string; updated: string | null;
	group: string; seq: number; x: number; y: number; deg: number; opaque: number; flagged: boolean; created?: string | null; key?: string | null; origin?: string | null;
	projectKey?: string | null; workspace?: string | null };
export type GEdge = { id: string; a: string; b: string; rel: string };
export type Phase = { next: string | null; total: number | null; done: boolean; error: string | null };
export type Graph = { nodes: Map<string, GNode>; edges: Map<string, GEdge>; groups: Map<string, string[]>; pending: Map<string, GEdge[]>; opaque: number;
	parts: { nodes: Phase; edges: Phase }; loading: boolean; missing: boolean; changed: boolean; dirty: boolean; listener?: () => void };

export type Am = {
	win: J;
	doc: J;
	$: (id: string) => J;
	status: (t: string) => void; // the top status line
	/** Owner API call with the Clerk session token; throws a Failure on a non-2xx answer. */
	call: (path: string, method?: string, data?: unknown) => Promise<J>;
	/** A fresh Clerk session token, for the event stream's Authorization header. Never shown or copied. */
	token: (fresh?: boolean) => Promise<string>; // fresh: skip Clerk's cache (the live stream lasts until the token's exp)

	// Loaded by boot() before the first render.
	profiles: Profile[];
	devices: Device[];
	batches: Map<string, Batch | Error>;
	snapshot: Snapshot | null; // null until data.ts loads the first one; never a placeholder
	api: DataClient; // data.ts sets it

	// Text-only building blocks.
	el: (tag: string, parent?: Node, text?: string) => Node;
	link: (parent: Node, href: string, text: string) => void;
	facts: (parent: Node, rows: [string, string, boolean?][]) => void;
	day: (iso: string | null) => string;
	state: (d: Device) => string;
	users: (p: string) => Device[];
	active: () => Profile[];
	recorded: (v: unknown) => string;
	enc: (s: string) => string;
	why: (err: unknown) => string;
	live: (parent: Node) => Node;
	btn: (parent: Node, text: string, onClick: () => void, label?: string) => Node;
	input: (parent: Node, id: string, label: string, tag?: string) => Node;
	choose: (parent: Node, id: string, label: string, options: [string, string][]) => Node;
	switcher: (view: Node, route: string, current: string) => void;
	act: (path: string | (() => Promise<J>), what: string, data: unknown, done: (r: J) => { text: string; undo?: string }) => Promise<void>;
	undoOf: (profile: string, r: J) => string | undefined;
	pageStatus: (view: Node) => { msg: Node; say: (t: string) => void };
	textBlock: (parent: Node, t: string) => void;
	note: (parent: Node, t: string, cls?: string) => void;
	outcomes: Map<string, { text: string; undo?: string }>; // route -> last write outcome there

	// Shared pieces for pages and tabs (style classes are listed in style.ts).
	glossary: Record<string, { term: string; text: string }>; // glossary.ts fills it
	help: (parent: Node, term: string) => void; // a ? that explains a glossary term; an unknown term adds nothing
	intro: (root: Node, label: string, term: string, text: string) => void; // "**Label** ? text", the one-sentence page intro
	copy: (parent: Node, label: string, text: () => string) => Node; // a copy button; the text is built on click
	/** A curl command with the token left as a variable, never a real one: $AGENT_MEMORY_OWNER_TOKEN for owner-only /api/* paths
	 * (device tokens get 403 there), $AGENT_MEMORY_TOKEN (a device token with the route's scope) for /v1 and /mcp. */
	curl: (method: string, path: string, body?: unknown) => string;
	mcpCall: (tool: string, args: Record<string, unknown>) => string; // { "name": tool, "arguments": args } as JSON
	mcpCurl: (tool: string, args: Record<string, unknown>) => string; // the same tools/call over HTTP to /mcp, with $AGENT_MEMORY_TOKEN
	empty: (root: Node, text: string, command?: string) => void; // what fills this page and the command that does it
	loading: (root: Node, rows?: number) => Node; // skeleton rows; replaceChildren() on it when data arrives
	// store.ts: the library of memories, learnings, journals, people and projects with their links; dates and human titles.
	library: (only: string | null, onChange?: () => void) => J;
	when: (iso: unknown) => { text: string; full: string };
	time: (parent: Node, iso: unknown) => Node;
	human: (name: string, kind?: string) => string;
	/** The one display title of a library item; given a node, writes it there and keeps it current. */
	title: (it: J, into?: Node) => string;
	settleTitle: (it: J, text: string) => void;
	itemHref: (it: J, profile?: string | null) => string;
	placeOf: (r: { profile: string; scope?: string | null; name?: string | null; key?: string | null; kind?: string; id?: string; repo_key?: string | null; project_key?: string | null; workspace?: string | null }) => { workspace: string | null; project: string | null; confidence: "high" | "medium" | null; profile: string | null; drop?: boolean; workspaces?: string[] }; // the one project rule (store.ts)
	workspaceName: (w: string) => string;
	workspaceProfile: (w: string) => string; // the profile a workspace belongs to (its registry's)
	setSync: (st: { state: string; at: string | null }) => void; // shell.ts: the header's live dot
	workspaceOrder: string[];
	// charts.ts: charts with one question each, and one item's connection graph.
	daily: (parent: Node, series: { label: string; kind: string; dates: (string | null)[] }[], weeks?: number, caption?: string) => Node;
	fitWeeks: (box: Node, weeks: number) => number; // the weeks a container can show as day bars at least 2 px wide (else 4)
	bars: (parent: Node, rows: { label: string; value: number; href?: string; sub?: string }[], unit: string) => Node;
	facets: (parent: Node, rows: { id: string; label: string; value: number; kind?: string }[], current: string, pick: (id: string) => void, all?: number) => Node;
	related: (parent: Node, center: { title: string; kind: string }, rows: { title: string; kind: string; href: string; label: string; weight: number }[], cap?: number) => Node;
	detail: (box: Node, lib: J, it: J, route: Route) => Node; // library.ts: one item's content and connections
	md: (parent: Node, text: string) => Node; // library.ts: safe minimal markdown, DOM nodes only
	pager: <T>(holder: Node, items: T[], draw: (it: T) => void, step?: number, key?: string) => void; // infinite scroll in pages; key keeps how far it got
	autoMore: (button: Node) => void; // a next-page button that presses itself when scrolled into view
	onLeave: (f: () => void) => () => void; // runs f before the next page replaces this one; the returned function runs it now
	observe: (target: Node, onSeen: (stop: () => void) => void, margin: string) => (() => void) | null; // an IntersectionObserver stopped on leaving
	resync?: () => void; // reads the library again now (the header's Retry)

	/**
	 * Runs fn for the chosen profile (`only`, from route.query.profile) or, when only is null, for every active profile in
	 * am.profiles order, in parallel. Each profile gets its own result; a throw becomes { ok: false, error }. An `only` that is
	 * not active returns one { ok: false } result with code "unknown_profile" and calls nothing.
	 */
	eachProfile: <T>(only: string | null, fn: (p: Profile) => Promise<T>) => Promise<ProfileResult<T>[]>;

	// Registry and routing.
	tabs: TabDef[];
	tab: (def: TabDef) => void;
	pages: Record<string, LegacyPage>;
	/** An older profile page in `view`: the named active profile, else active work, else a profile chooser. */
	legacy: (view: Node, page: string, profile?: string, id?: string) => Node;
	render: (moveFocus: boolean) => void;
	boot: () => Promise<void>;

	// Per-render state: a page compares its saved pageVersion before writing after an await.
	pageVersion: number;
	pageButtons: Node[];
	pageMsg: Node | undefined;
	shown: string | undefined; // the profile whose About you page is on screen
	statusEl: Node | undefined;

	// Cross-page state of the older pages, set by the part that owns it (read as am.x at call time).
	drafts: Map<string, Draft>; // admin/draft.ts
	whatIf: Map<string, WhatIf[]>;
	whatIfEdits: Map<string, { add: [string, string][]; cut: Set<string>; drop: Set<string> }>;
	draftFromWhatIf: (profile: string, w: WhatIf, out: Node) => void;
	graphs: Map<string, Graph>; // graph.ts
	graphOf: (p: Profile) => Graph;
	pump: (p: Profile, g: Graph) => Promise<void>;
	moves: Map<string, Move>; // admin/moves.ts
	sendMove: (m: Move) => void;
	moveView: (parent: Node, m: Move) => void;
	copyBack: Map<string, string>;
	COPY_MAX: number;
};

/** Every part after the shell. */
export type Part = (am: Am) => void;
