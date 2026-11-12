// The viewer event stream (V2) on the real profile schema: cursor parsing, the change feed with its targets and redaction, and
// the SSE stream's resume, end and failure behavior. The /api/viewer/events route and its owner check are the integrator's wiring.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { changesSince, eventStream, formatCursor, parseCursor, type StreamSource } from "../src/viewer/events";
import type { HealthCheck, ViewerCursor } from "../src/viewer/types";

let n = 0;
const profileObject = () => env.PROFILE.get(env.PROFILE.idFromName(`viewer-test:work:g${++n}-${Date.now()}`));
const inProfile = <T>(stub: DurableObjectStub, fn: (sql: SqlStorage) => T) => runInDurableObject(stub, (_i, s) => fn(s.storage.sql));

/** Test-only rows written straight into the profile, in the shapes the write, maintenance, import and wipe paths make. */
function node(sql: SqlStorage, id: string, kind = "rule", status = "active") {
	const at = "2026-11-01T00:00:00.000Z";
	sql.exec(`INSERT INTO nodes (id, kind, memory_type, name, norm_name, description, status, origin, pinned, content_hash, card_hash, recorded_at, created_at, updated_at, seq)
		VALUES (?, ?, 'project', ?, ?, 'd', ?, 'agent', 0, 'h', 'c', ?, ?, ?, 1)`, id, kind, id, id, status, at, at, at);
}
function act(sql: SqlStorage, op: string, summary: string, targets: string[] = [], actor = "agent", redacted: string | null = null): number {
	return Number(sql.exec<{ id: number }>("INSERT INTO activity (at, actor, op, summary, targets, redacted, seq) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id",
		new Date().toISOString(), actor, op, summary, JSON.stringify(targets), redacted).one().id);
}

type Frame = { id: string; event: string; data: string };
async function readAll(res: Response): Promise<{ frames: Frame[]; ms: number; text: string }> {
	const started = Date.now(), reader = res.body!.getReader(), dec = new TextDecoder();
	let text = "";
	for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
	const frames = text.split("\n\n").filter(Boolean).map((f) => Object.fromEntries(f.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)])) as Frame);
	return { frames, ms: Date.now() - started, text };
}
const source = (stub: DurableObjectStub, health: () => Promise<HealthCheck[]> = async () => []): StreamSource => ({
	changes: async (cur) => {
		const v = await inProfile(stub, (sql) => changesSince(sql, "work", cur.work ?? 0, 50));
		return { items: v.items, cursor: { work: v.seq } };
	},
	health,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Reads the whole stream, or fails the test when it is still open after `ms`; the losing timer is cleared either way. */
const within = async (res: Response, ms: number) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([readAll(res), new Promise<never>((_ok, no) => { timer = setTimeout(() => no(new Error(`stream still open after ${ms} ms`)), ms); })]);
	} finally { clearTimeout(timer); }
};
const cursorOf = (f: Frame): ViewerCursor | null => parseCursor(f.id);

describe("viewer cursor", () => {
	it("round-trips in a stable form and refuses anything formatCursor could not produce", () => {
		const c = formatCursor({ work: 3, me: 1 });
		expect(formatCursor({ me: 1, work: 3 })).toBe(c);
		expect(parseCursor(c)).toEqual({ me: 1, work: 3 });
		const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
		const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, 1]));
		for (const bad of ["", "not base64!", enc([2, {}]), enc({ work: 1 }), enc([1, []]), enc([1, { Work: 1 }]), enc([1, { work: -1 }]),
			enc([1, { work: 1.5 }]), enc([1, { work: "1" }]), enc([1, { work: 2 ** 53 }]), enc([1, many]), "A".repeat(4_097)]) expect(parseCursor(bad)).toBeNull();
	});
});

describe("viewer change feed", () => {
	it("reads activity after the cursor oldest first, with kinds, decimal activity ids and readable targets only", async () => {
		const stub = profileObject();
		const r = await inProfile(stub, (sql) => {
			node(sql, "dec-1"); node(sql, "pref-1", "preference"); node(sql, "gone-1", "rule", "moved");
			act(sql, "save", "save 'dec-1'", ["dec-1"]);
			act(sql, "save", "save 'pref-1'", ["pref-1"], "owner");
			act(sql, "stuck", "lease expired", [], "maintenance");
			act(sql, "forget", "forgot 'gone-1'", ["gone-1"], "owner");
			act(sql, "import", "imported rule 'r'", ["not-a-node"], "migration");
			act(sql, "save", "save, 1 records, redacted by wipe of work", ["dec-1"], "agent", "wipe:work:2026-11-01");
			return { all: changesSince(sql, "work", 0, 50), page: changesSince(sql, "work", 2, 2), none: changesSince(sql, "work", 6, 50), ahead: changesSince(sql, "work", 99, 50) };
		});
		expect(r.all.seq).toBe(6);
		expect(r.all.items.map((i) => [i.id, i.kind, i.target ?? null])).toEqual([
			["1", "MEMORY", "dec-1"], ["2", "PREFERENCE", "pref-1"], ["3", "BATCH", null], ["4", "FORGET", null], ["5", "IMPORT", null], ["6", "MEMORY", null]]);
		expect(r.all.items.every((i) => i.profile === "work")).toBe(true);
		expect("target" in r.all.items[2]!).toBe(false);
		expect(r.page).toMatchObject({ seq: 4, items: [{ id: "3" }, { id: "4" }] });
		expect(r.none).toEqual({ items: [], seq: 6 });
		// A cursor past the newest id (a restore or wipe replaced the history) reports the store's real position.
		expect(r.ahead).toEqual({ items: [], seq: 6 });
	});
});

describe("viewer event stream", () => {
	it("opens with health at its cursor, resumes after it, sends a later write, and ends at the token's exp", async () => {
		const stub = profileObject();
		await inProfile(stub, (sql) => { for (let i = 1; i <= 3; i++) act(sql, "save", `save ${i}`); });
		const res = eventStream(source(stub), { work: 2 }, Date.now() + 4_000, new AbortController().signal);
		expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const late = sleep(1_000).then(() => inProfile(stub, (sql) => act(sql, "save", "save late\n\nevent: health\ndata: forged")));
		const { frames, ms } = await readAll(res);
		await late; // its write is asserted below, and a failure surfaces here rather than after the test
		expect(frames[0]).toMatchObject({ event: "health", data: "[]" });
		expect(cursorOf(frames[0]!)).toEqual({ work: 2 });
		const changes = frames.filter((f) => f.event === "change");
		expect(changes.map((f) => JSON.parse(f.data).id)).toEqual(["3", "4"]);
		expect(changes.map(cursorOf)).toEqual([{ work: 3 }, { work: 4 }]);
		// A summary with blank lines stays inside one JSON data line, so it cannot forge a frame.
		expect(frames.map((f) => f.event)).toEqual(["health", "change", "change"]);
		expect(JSON.parse(changes[1]!.data).summary).toContain("event: health");
		expect(ms).toBeGreaterThanOrEqual(3_500);
		expect(ms).toBeLessThan(6_000);
	});

	it("adopts a replaced history's position in one health frame and ends", async () => {
		const stub = profileObject();
		await inProfile(stub, (sql) => { act(sql, "save", "after a restore"); });
		const { frames, ms } = await readAll(eventStream(source(stub), { work: 40 }, Date.now() + 60_000, new AbortController().signal));
		expect(frames.map((f) => f.event)).toEqual(["health", "health"]);
		expect(cursorOf(frames[1]!)).toEqual({ work: 1 });
		expect(ms).toBeLessThan(2_000);
	});

	it("ends on a failed read without error text, and stops polling once the client aborts", async () => {
		const failed = await readAll(eventStream({ changes: async () => { throw new Error("profile generation is closed: secret-detail"); }, health: async () => [] },
			{}, Date.now() + 60_000, new AbortController().signal));
		expect(failed.frames.map((f) => f.event)).toEqual(["health"]);
		expect(failed.text).not.toContain("secret-detail");
		expect(failed.ms).toBeLessThan(2_000);

		let polls = 0;
		const ac = new AbortController();
		const res = eventStream({ changes: async (c) => { polls++; return { items: [], cursor: c }; }, health: async () => [] }, {}, Date.now() + 60_000, ac.signal);
		setTimeout(() => ac.abort(), 500);
		const aborted = await readAll(res);
		expect(aborted.ms).toBeLessThan(2_000);
		const after = polls;
		await new Promise((r) => setTimeout(r, 3_500)); // longer than one poll
		expect(polls).toBe(after);
	});

	it("sends nothing a read returns after the deadline, and closes at the deadline, not at the late read", async () => {
		let calls = 0;
		const late = { kind: "MEMORY", profile: "work", id: "7", summary: "late memory text", at: new Date().toISOString() } as const;
		const started = Date.now();
		// The read answers 3 s after the 1 s deadline, so the close falls between them with wide margins on a loaded runner.
		const res = eventStream({ changes: async () => { calls++; await sleep(4_000); return { items: [late], cursor: { work: 7 } }; }, health: async () => [] },
			{}, started + 1_000, new AbortController().signal);
		const out = await within(res, 6_000);
		expect(out.frames.map((f) => f.event)).toEqual(["health"]);
		expect(out.text).not.toContain("late memory text");
		expect(out.ms).toBeLessThan(2_500);
		// The read resolves after the close: it emits nothing, raises nothing, and no further poll starts.
		await sleep(Math.max(0, started + 4_500 - Date.now()));
		expect(calls).toBe(1);
	});

	it("closes at the deadline while a read never resolves", async () => {
		const stuckChanges = await within(eventStream({ changes: () => new Promise(() => {}), health: async () => [] }, {}, Date.now() + 1_000, new AbortController().signal), 4_000);
		expect(stuckChanges.frames.map((f) => f.event)).toEqual(["health"]);
		expect(stuckChanges.ms).toBeLessThan(2_500);
		const stuckHealth = await within(eventStream({ changes: async (c) => ({ items: [], cursor: c }), health: () => new Promise(() => {}) }, {}, Date.now() + 1_000, new AbortController().signal), 4_000);
		expect(stuckHealth.frames).toEqual([]);
		expect(stuckHealth.ms).toBeLessThan(2_500);
	});
});
