// The dashboard's shared contract (section 15). /app.js is a list of parts, each a function serialized with toString():
// shell(window) builds `am` and puts it on window.__am, every other part receives it, registers its tab or pages, and
// shell's boot() signs in and renders. Parts may use only `am`, their own locals and browser globals; anything they
// import must be a type. Every value from the API or the URL reaches the page as text (textContent), never as markup.
// Types only: this file emits no code.
//
// Keys the shell handles for every page, through markup alone:
// - "/" focuses the first [data-search] element in the view, else its first input[type=search].
// - g then a letter opens a nav entry: g Graph, m Memories, u Activity, or a registered tab's key.
// - Up, Down, Home and End move focus between the visible [data-item] entries of the [data-list] that holds the focus.
//   Each [data-item] must be focusable (a button, a link, or tabindex).
// - Space, Left and Right click the visible button marked data-key="Space", "ArrowLeft" or "ArrowRight". Space on a
//   focused button or link activates that control instead.
// - Esc closes a glossary tip, the glossary panel, the narrow menu or the Admin list; with none open, it clicks the visible
//   [data-close] button in the view (a detail panel).
// The shell ignores keys typed into inputs, selects and text areas, except Esc.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the owner API and browser globals; this Worker project has no DOM types
export type J = any;

/** The slice of a DOM element the dashboard uses. */
export type Node = { appendChild(n: unknown): void; replaceChildren(): void; textContent: string; setAttribute(k: string, v: string): void; focus(): void;
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
	/** Builds the tab inside `root` (already empty). Return the heading to focus after navigation. */
	render: (root: Node, route: Route) => Node | void;
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
	group: string; seq: number; x: number; y: number; deg: number; opaque: number; flagged: boolean };
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

	// Loaded by boot() before the first render.
	profiles: Profile[];
	devices: Device[];
	batches: Map<string, Batch | Error>;

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
