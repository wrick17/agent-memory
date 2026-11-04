// The dashboard data client (src/dashboard/data.ts) against a stand-in fetch and SSE stream: snapshot-first connections, frame
// decoding, pause and backoff, refusal, and the page lifecycle. The part is called directly, as dashboardMain calls it; workerd
// forbids code generation from strings, so the serialized /app.js form is not evaluated here.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Am, LiveEvent } from "../src/dashboard/am";
import { dataClient } from "../src/dashboard/data";
import type { Snapshot } from "../src/viewer/types";

const enc = new TextEncoder();
const snap = (cursor: string, at: string): Snapshot => ({ at, version: "v-test", deployed_at: "2026-11-04T00:00:00Z", profiles: ["work"], cursor,
	counts: { memories: 1, revisions: 1, observations: 0, sessions: 0, sessions_active: 0, lessons: 0, crystals: 0, actions: 0, graph_nodes: 1, graph_edges: 0 },
	usage: { recalls_today: 0, recall_tokens_today: 0, writes_today: 0, storage_bytes: 0, storage_limit: 1, vectors: 0 },
	health: { verdict: "ok", checks: [] }, recent_sessions: [], feed: [], layers: [], flags: [] });
const CHECK = { check_id: "capture_stale", subject: "device-1", state: "warn", detail: "No status for 2 days.", at: "2026-11-04T01:00:00Z" };
const CHANGE = { kind: "MEMORY", profile: "work", id: "7", summary: "naïve ✓ 😀 note", at: "2026-11-04T01:01:00Z", target: "n-1" };

/** A stream the test feeds by hand. */
function sse(type = "text/event-stream; charset=utf-8") {
	let c!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(x) { c = x; } });
	return { res: new Response(body, { headers: { "content-type": type } }), push: (b: string | Uint8Array) => c.enqueue(typeof b === "string" ? enc.encode(b) : b), close: () => c.close() };
}

/** A fake `am` and window: fetch answers come from `answers` in order; timers wait in `timers` until the test runs them. */
function setup(o: { snapshots?: unknown[]; answers?: (() => Response)[] } = {}) {
	const snapshots = [...(o.snapshots ?? [snap("C0", "2026-11-04T01:00:00Z"), snap("C1", "2026-11-04T01:05:00Z"), snap("C2", "2026-11-04T01:10:00Z")])];
	const fetched: { url: string; auth: string; cursorAtFetch: string | undefined; signal: AbortSignal }[] = [];
	const timers: { ms: number; f: () => void }[] = [];
	const listeners: Record<string, (e: unknown) => void> = {};
	const answers = [...(o.answers ?? [])];
	const status: string[] = [];
	let calls = 0;
	const am = {
		snapshot: null as Snapshot | null,
		status: (t: string) => { status.push(t); },
		why: (e: Error) => e.message,
		token: async () => "session-token",
		call: async (path: string) => {
			calls++;
			expect(path).toBe("/api/viewer/snapshot");
			const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
			if (next instanceof Error) throw next;
			return next;
		},
		win: {
			setTimeout: (f: () => void, ms: number) => { timers.push({ ms, f }); return timers.length; },
			clearTimeout: () => {},
			addEventListener: (type: string, f: (e: unknown) => void) => { listeners[type] = f; },
			fetch: async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
				fetched.push({ url, auth: init.headers.authorization!, cursorAtFetch: am.snapshot?.cursor, signal: init.signal });
				const a = answers.shift();
				if (!a) throw new Error("no fetch answer left");
				return a();
			},
		},
	} as unknown as Am & { snapshot: Snapshot | null };
	dataClient(am);
	const events: LiveEvent[] = [];
	const seenAtEvent: (Snapshot | null)[] = [];
	am.api.subscribe((e) => { events.push(e); if (e.type === "snapshot") seenAtEvent.push(am.snapshot); });
	const types = () => events.map((e) => e.type);
	const runTimer = async () => { const t = timers.shift(); expect(t).toBeDefined(); t!.f(); await settle(); return t!.ms; };
	return { am, fetched, timers, listeners, events, seenAtEvent, types, status, runTimer, calls: () => calls };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
let now = Date.parse("2026-11-04T01:00:00Z");
const clock = () => vi.spyOn(Date, "now").mockImplementation(() => now);
afterEach(() => { vi.restoreAllMocks(); });

describe("dashboard data client", () => {
	it("loads the snapshot first, then reads the stream with the token only in the header, across awkward chunk splits", async () => {
		clock();
		const s = sse();
		const t = setup({ answers: [() => s.res] });
		t.am.api.start();
		t.am.api.start(); // a second start is ignored
		await settle();
		expect(t.calls()).toBe(1);
		expect(t.fetched).toHaveLength(1);
		expect(t.fetched[0]!.url).toBe("/api/viewer/events?cursor=C0");
		expect(t.fetched[0]!.cursorAtFetch).toBe("C0");
		expect(t.fetched[0]!.auth).toBe("Bearer session-token");
		expect(t.fetched[0]!.url).not.toContain("session-token");
		expect(t.seenAtEvent[0]?.cursor).toBe("C0"); // am.snapshot was already the new one when the event went out
		expect(t.types()).toEqual(["snapshot", "live"]);

		const text = `: keepalive\r\nid: A1\r\nevent: health\r\ndata: ${JSON.stringify([CHECK])}\r\n\r\nevent: other\ndata: skipped\n\nid: A2\nevent: change\ndata: ${JSON.stringify(CHANGE)}\n\n`;
		const bytes = enc.encode(text);
		const crlf = text.indexOf("\r\n\r\n") + 1, emoji = bytes.indexOf(0xf0);
		let from = 0;
		for (const cut of [7, crlf, crlf + 2, emoji + 1, emoji + 3, bytes.length]) { s.push(bytes.slice(from, cut)); from = cut; await settle(); }
		expect(t.events.slice(2)).toEqual([{ type: "health", checks: [CHECK] }, { type: "change", item: CHANGE }]);
	});

	it("reconnects from a fresh snapshot's cursor with 1 s then 2 s backoff, at once after a long stream, and stops on 403", async () => {
		clock();
		const first = sse(), long = sse();
		const t = setup({ answers: [() => first.res, () => new Response("busy", { status: 503 }), () => long.res, () => new Response("{}", { status: 403 })] });
		t.am.api.start();
		await settle();
		first.push(`id: STALE-FRAME-ID\nevent: health\ndata: []\n\n`);
		first.close(); // ended within 5 s: a drop
		await settle();
		expect(t.events.at(-1)).toEqual({ type: "paused", as_of: "2026-11-04T01:00:00Z" });
		expect(await t.runTimer()).toBe(1000);
		expect(t.events.at(-1)).toEqual({ type: "paused", as_of: "2026-11-04T01:05:00Z" }); // 503, numbers as of the newer snapshot
		expect(await t.runTimer()).toBe(2000);
		expect(t.fetched.map((f) => f.url)).toEqual(["C0", "C1", "C2"].map((c) => `/api/viewer/events?cursor=${c}`));
		expect(t.fetched.every((f, i) => f.cursorAtFetch === ["C0", "C1", "C2"][i])).toBe(true);
		expect(t.fetched.some((f) => f.url.includes("STALE"))).toBe(false);
		long.push(`id: B1\nevent: health\ndata: []\n\n`);
		await settle();
		now += 60_000;
		long.close(); // a normal end after a minute: straight to the next snapshot and stream, no pause
		await settle();
		expect(t.timers).toHaveLength(0);
		expect(t.calls()).toBe(4);
		expect(t.events.at(-1)).toEqual({ type: "paused", as_of: "2026-11-04T01:10:00Z" });
		expect(t.status.at(-1)).toMatch(/refused this session \(HTTP 403\)/);
		expect(t.fetched).toHaveLength(4);
		expect(t.timers).toHaveLength(0); // no retry after a refusal
		expect(t.types().filter((x) => x === "live")).toHaveLength(2); // live once per not-live to live change
	});

	it("drops the connection on a malformed or oversized frame, or a reply that is not an event stream", async () => {
		clock();
		const bad = sse(), big = sse();
		const t = setup({ answers: [() => bad.res, () => big.res, () => sse("application/json").res] });
		t.am.api.start();
		await settle();
		bad.push(`event: change\ndata: {"kind":"MEMORY"}\n\n`); // missing fields
		await settle();
		expect(t.types().at(-1)).toBe("paused");
		expect(t.types()).not.toContain("change");
		await t.runTimer();
		big.push(`event: health\ndata: "${"x".repeat((1 << 20) + 1)}`);
		await settle();
		expect(t.types().at(-1)).toBe("paused");
		expect(await t.runTimer()).toBe(2000);
		expect(t.types().at(-1)).toBe("paused"); // application/json is refused
		expect(t.timers[0]!.ms).toBe(4000);
	});

	it("reports a snapshot it cannot read, shares a snapshot in flight, and isolates listeners", async () => {
		clock();
		const s = sse();
		const t = setup({ snapshots: [{ at: "x" }, snap("C1", "2026-11-04T01:05:00Z")], answers: [() => s.res] });
		const unsub = vi.fn();
		const off = t.am.api.subscribe(unsub);
		t.am.api.subscribe(() => { throw new Error("listener bug"); });
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		off();
		t.am.api.start();
		await settle();
		expect(t.am.snapshot).toBeNull(); // never a placeholder
		expect(t.events).toEqual([{ type: "paused", as_of: "" }]);
		expect(t.status.at(-1)).toMatch(/Could not load the dashboard numbers \(retrying in 1 s\): The snapshot reply was not in the expected shape/);
		await t.runTimer();
		expect(t.status.at(-1)).toBe("Signed in.");
		expect(t.types()).toEqual(["paused", "snapshot", "live"]);
		const [a, b] = [t.am.api.snapshot(), t.am.api.snapshot()];
		expect(await a).toBe(await b);
		expect(t.calls()).toBe(3); // two loads before, one shared load now
		expect(unsub).not.toHaveBeenCalled();
	});

	it("releases the connection on pagehide and reconnects from a fresh snapshot on a back/forward restore", async () => {
		clock();
		const s1 = sse(), s2 = sse();
		const t = setup({ answers: [() => s1.res, () => s2.res] });
		t.am.api.start();
		await settle();
		t.listeners.pagehide!({});
		await settle();
		expect(t.fetched[0]!.signal.aborted).toBe(true);
		t.listeners.pageshow!({ persisted: false });
		await settle();
		expect(t.fetched).toHaveLength(1);
		t.listeners.pageshow!({ persisted: true });
		await settle();
		expect(t.fetched.map((f) => f.cursorAtFetch)).toEqual(["C0", "C1"]);
		expect(t.types()).toEqual(["snapshot", "live", "snapshot", "live"]);
		expect(t.timers).toHaveLength(0);
	});
});
