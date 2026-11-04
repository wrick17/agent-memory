// The dashboard's shared contract (section 15). /app.js is a list of parts, each a function serialized with toString():
// shell(window) builds `am` and puts it on window.__am, every other part receives it, registers its tab or pages, and
// shell's boot() signs in and renders. Parts may use only `am`, their own locals and browser globals; anything they
// import must be a type. Every value from the API or the URL reaches the page as text (textContent), never as markup.
// Types only: this file emits no code.
import type { FeedItem, HealthCheck, ReplayEvent, Snapshot } from "../viewer/types";

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

/** Nav groups after the ungrouped Overview, in agentmemory v0.9.31's order. Admin follows System and holds the older pages. */
export type TabGroup = "memory" | "work" | "insight" | "system";

/** A parsed deep link: `#memories/ID`, `#sessions/ID?obs=3`, `#health/consolidation`. Parts are already URI-decoded. */
export type Route = { tab: string; id?: string; rest: string[]; query: Record<string, string>; hash: string };

export type TabDef = {
	id: string; // the deep-link name: #<id>/<rest>
	group: TabGroup | null; // null: before the groups (Overview)
	label: string;
	key: string; // g then this letter jumps here
	count?: (s: Pick<Snapshot, "counts">) => number | null; // read only once a snapshot has loaded
	/** Builds the tab inside `root` (already empty). Return the heading to focus after navigation. */
	render: (root: Node, route: Route) => Node | void;
};

/** What am.api.subscribe delivers: the stream's events (src/viewer/types.ts ViewerEvent, parsed) and the client's own connection state. */
export type LiveEvent =
	| { type: "change"; item: FeedItem } // event: change
	| { type: "health"; checks: HealthCheck[] } // event: health
	| { type: "snapshot"; snapshot: Snapshot } // a fresh snapshot, after the first load and after each reconnect
	| { type: "paused"; as_of: string } // "Live updates paused. Numbers as of HH:MM."
	| { type: "live"; since: string };

/** DC1's data client (src/dashboard/data.ts). D0 leaves a stub that never loads or streams. */
export type DataClient = {
	start(): void; // called once by boot() after sign-in: the snapshot load, then the stream
	snapshot(): Promise<Snapshot>; // GET /api/viewer/snapshot; also sets am.snapshot and emits { type: "snapshot" }
	subscribe(fn: (e: LiveEvent) => void): () => void; // returns unsubscribe
};

/**
 * The replay player (P1), local/replay-player.js: a classic script that defines globalThis.amReplayPlayer. /app.js starts with
 * that file's exact bytes (a Text module), so it is defined before the shell runs; am.player is it, or null where no player
 * script ran (dashboardMain in tests, unless the test sets win.amReplayPlayer). The local viewer loads the same file itself.
 */
export type ReplayControls = { play(): void; pause(): void; step(delta: number): void; seek(i: number): void; setSpeed(x: number): void; destroy(): void };
export type ReplayPlayer = { mount(root: Node, events: ReplayEvent[], options?: { speeds?: number[]; onEvent?: (e: ReplayEvent) => void }): ReplayControls };

// ---- Older pages (Admin, and the bodies the Memories, Graph and Audit tabs show until TG2, TG4 and TG7 rebuild them) ----

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
	/** A fresh Clerk session token, for the event stream's Authorization header. Never shown or copied. */
	token: () => Promise<string>;

	// Loaded by boot() before the first render.
	profiles: Profile[];
	devices: Device[];
	batches: Map<string, Batch | Error>;
	/** The header's profile choice; null is All profiles. D0 leaves it null (the older pages then default to work). DS1 sets it. */
	profile: string | null;
	snapshot: Snapshot | null; // null until DC1 loads the first one; never a placeholder
	api: DataClient;
	player: ReplayPlayer | null;
	glossary: Record<string, { term: string; text: string }>;

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

	// Shared shell pieces for the tabs. D0 gives working minimal versions; DS1 restyles them without changing the signatures.
	help: (parent: Node, term: string) => void; // a ? that explains a GLOSSARY term
	intro: (root: Node, label: string, term: string, text: string) => void; // "**Label** ? text"
	copy: (parent: Node, label: string, text: () => string) => Node; // a copy button; text is built on click
	curl: (method: string, path: string, body?: unknown) => string; // uses $AGENT_MEMORY_TOKEN, never a real token
	mcpCall: (tool: string, args: Record<string, unknown>) => string; // { "name": tool, "arguments": args } as JSON
	empty: (root: Node, text: string, command?: string) => void; // what fills this tab and the command that does it
	loading: (root: Node, rows?: number) => Node; // skeleton rows; replaceChildren() on it when data arrives

	// Registry and routing.
	tabs: TabDef[];
	tab: (def: TabDef) => void;
	pages: Record<string, LegacyPage>;
	adminLink: (label: string, href: string) => void;
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
