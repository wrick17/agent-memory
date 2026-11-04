// The data client (DC1): am.api. It loads GET /api/viewer/snapshot, then reads GET /api/viewer/events with fetch and a stream
// reader, so the Clerk token travels in the Authorization header (EventSource can't send it, and no credential goes in the URL).
// Every connection, the first and each reconnect, loads a fresh snapshot first and opens the stream at that snapshot's cursor.
// The stream's frame ids are the position within one connection only: a server that ended the stream (token exp, the 5-minute
// cap, or replaced history after a restore or wipe) is caught up by the next snapshot, never by reopening at an old id.
// A failed load or a dropped stream emits { type: "paused" } and retries after 1, 2, 4, 8, 16, then every 30 seconds.
// The shell owns the Live chip, the paused banner and the footer; this part only emits events and draws nothing.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, LiveEvent } from "./am";
import type { FeedItem, HealthCheck, Snapshot } from "../viewer/types";

export function dataClient(am: Am): void {
	const win = am.win;
	const after = (ms: number, f: () => void) => (win.setTimeout ?? setTimeout)(f, ms);
	const cancel = (t: unknown) => (win.clearTimeout ?? clearTimeout)(t);
	const BACKOFF_S = [1, 2, 4, 8, 16, 30];
	const QUICK_END_MS = 5_000; // a stream that ends sooner than this counts as a drop, so a bad server can't spin the client
	const FRAME_MAX = 1 << 20; // a frame longer than 1 MiB is a broken stream, not data to buffer
	const FEED_KINDS = ["MEMORY", "IMPORT", "FORGET", "PREFERENCE", "BATCH"];
	const VERDICTS = ["ok", "warn", "fail"];

	const subs = new Set<(e: LiveEvent) => void>();
	const emit = (e: LiveEvent) => {
		for (const fn of [...subs]) {
			try { fn(e); } catch (err) { console.error("A live-update listener failed:", err); }
		}
	};

	const isStr = (v: unknown): v is string => typeof v === "string";
	const isObj = (v: unknown): v is Record<string, J> => typeof v === "object" && v !== null && !Array.isArray(v);
	const isFeedItem = (v: unknown): v is FeedItem =>
		isObj(v) && FEED_KINDS.includes(v.kind) && isStr(v.profile) && isStr(v.id) && isStr(v.summary) && isStr(v.at) &&
		(v.target === undefined || isStr(v.target));
	const isCheck = (v: unknown): v is HealthCheck =>
		isObj(v) && isStr(v.check_id) && isStr(v.subject) && VERDICTS.includes(v.state) && isStr(v.detail) && isStr(v.at);
	const isSnapshot = (v: unknown): v is Snapshot =>
		isObj(v) && isStr(v.at) && isStr(v.cursor) && isStr(v.version) && Array.isArray(v.profiles) && isObj(v.counts) && isObj(v.usage) &&
		isObj(v.health) && Array.isArray(v.health.checks) && Array.isArray(v.recent_sessions) && Array.isArray(v.feed) &&
		Array.isArray(v.layers) && Array.isArray(v.flags);
	const fail = (message: string, status?: number): Failure => Object.assign(new Error(message), status ? { status } : {});

	let said = false; // the status line carries a load failure that the next good snapshot clears
	// One snapshot request at a time: a second caller shares the request in flight.
	let loading: Promise<Snapshot> | null = null;
	const snapshot = (): Promise<Snapshot> => {
		loading ??= (async () => {
			try {
				const s: unknown = await am.call("/api/viewer/snapshot");
				if (!isSnapshot(s)) throw fail("The snapshot reply was not in the expected shape.");
				am.snapshot = s; // before the event, so listeners read the new one
				if (said) { said = false; am.status("Signed in."); }
				emit({ type: "snapshot", snapshot: s });
				return s;
			} finally {
				loading = null;
			}
		})();
		return loading;
	};

	// Connection state. `gen` changes when a connection is replaced or stopped; async work from an older one stops at its next step.
	let started = false, stopped = false, gen = 0, attempt = 0;
	let timer: unknown = null, ctrl: AbortController | null = null;
	let live = false;
	let position: string | null = null; // the last frame id of the open connection; cleared when it ends

	const retry = (my: number, why: unknown) => {
		if (my !== gen || stopped) return;
		const delay = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)]!;
		attempt++;
		live = false;
		console.warn(`Live updates paused${position ? " after the last received frame" : ""}; retrying in ${delay} s:`, (why as Error)?.message ?? why);
		if (!am.snapshot) { said = true; am.status(`Could not load the dashboard numbers (retrying in ${delay} s): ${am.why(why)}`); }
		// Sent on every retry, so the as-of time follows the newest snapshot even when only the stream failed.
		emit({ type: "paused", as_of: am.snapshot?.at ?? "" });
		timer = after(delay * 1000, () => { timer = null; void connect(); });
	};
	/** The server refused this session: no retry until the page is reloaded and the owner signs in again. */
	const refuse = (status: number) => {
		gen++; stopped = true; live = false;
		ctrl?.abort(); ctrl = null;
		emit({ type: "paused", as_of: am.snapshot?.at ?? "" });
		am.status(`Live updates stopped: the server refused this session (HTTP ${status}). Reload and sign in as the owner.`);
	};

	/** Parses one SSE block (lines without the blank line). Returns false on a frame this client can't trust. */
	const handle = (block: string): boolean => {
		let event = "message", id: string | null = null;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line === "" || line.startsWith(":")) continue;
			const at = line.indexOf(":");
			const field = at < 0 ? line : line.slice(0, at);
			let value = at < 0 ? "" : line.slice(at + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "event") event = value;
			else if (field === "data") data.push(value);
			else if (field === "id" && !value.includes("\0")) id = value;
		}
		if (event !== "change" && event !== "health") return true; // unknown events are skipped, as SSE allows
		let parsed: unknown;
		try { parsed = JSON.parse(data.join("\n")); } catch { return false; }
		if (event === "change") {
			if (!isFeedItem(parsed)) return false;
			if (id !== null) position = id;
			emit({ type: "change", item: parsed });
		} else {
			if (!Array.isArray(parsed) || !parsed.every(isCheck)) return false;
			if (id !== null) position = id;
			emit({ type: "health", checks: parsed });
		}
		return true;
	};

	const read = async (my: number, body: J): Promise<number> => {
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = "", cr = false, frames = 0;
		const feed = (text: string) => {
			// Line ends may be \r\n, \n or \r; a \r at a chunk's end waits for the next chunk in case \n follows.
			if (cr) text = `\r${text}`;
			cr = text.endsWith("\r");
			if (cr) text = text.slice(0, -1);
			buf += text.replace(/\r\n?/g, "\n");
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				const block = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (my !== gen) return;
				if (!handle(block)) throw fail("The live stream sent a frame this page could not read.");
				frames++;
			}
			if (buf.length > FRAME_MAX) throw fail("The live stream sent a frame larger than 1 MiB.");
		};
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (my !== gen) break;
				if (done) { feed(dec.decode()); break; }
				feed(dec.decode(value, { stream: true }));
			}
		} finally {
			reader.cancel().catch(() => {}); // releases the connection; already closed when the stream ended
		}
		return frames;
	};

	/** One connection: a fresh snapshot, then the stream at its cursor until it ends. */
	const connect = async () => {
		if (stopped) return;
		cancel(timer); timer = null;
		ctrl?.abort();
		const my = ++gen;
		const ac = new AbortController();
		ctrl = ac;
		position = null;
		let opened = 0;
		try {
			const s = await snapshot();
			if (my !== gen) return;
			const token = await am.token();
			if (my !== gen) return;
			if (!isStr(token) || !token) throw fail("No session token is available.");
			const path = s.cursor ? `/api/viewer/events?cursor=${encodeURIComponent(s.cursor)}` : "/api/viewer/events";
			const res = await win.fetch(path, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, cache: "no-store", signal: ac.signal });
			if (my !== gen) { res.body?.cancel?.().catch(() => {}); return; }
			if (res.status === 403) { res.body?.cancel?.().catch(() => {}); return refuse(403); }
			if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw fail(`The live stream answered HTTP ${res.status}.`, res.status); }
			if (!String(res.headers.get("content-type") ?? "").startsWith("text/event-stream") || !res.body) {
				res.body?.cancel?.().catch(() => {});
				throw fail("The live stream reply was not an event stream.");
			}
			opened = Date.now();
			if (!live) { live = true; emit({ type: "live", since: new Date(opened).toISOString() }); }
			const frames = await read(my, res.body);
			if (my !== gen) return;
			// A normal end (token exp, the 5-minute cap, replaced history): reconnect at once with a fresh snapshot.
			if (frames > 0 && Date.now() - opened >= QUICK_END_MS) { attempt = 0; position = null; return void connect(); }
			throw fail("The live stream ended right after it opened.");
		} catch (err) {
			if (my !== gen) return;
			if ((err as Failure)?.status === 403) return refuse(403);
			if (opened && Date.now() - opened >= QUICK_END_MS) attempt = 0; // it was live for a while: start the backoff over
			ctrl = null;
			retry(my, err);
			position = null;
		}
	};

	// A page leaving for the back/forward cache releases its connection; coming back reconnects. Hash navigation keeps it.
	win.addEventListener?.("pagehide", () => {
		if (!started || stopped) return;
		gen++; cancel(timer); timer = null; ctrl?.abort(); ctrl = null; position = null; live = false;
	});
	win.addEventListener?.("pageshow", (e: { persisted?: boolean }) => {
		if (started && !stopped && e.persisted) { attempt = 0; void connect(); }
	});

	am.api = {
		start() {
			if (started) return;
			started = true;
			void connect();
		},
		snapshot,
		subscribe(fn) {
			subs.add(fn);
			return () => { subs.delete(fn); };
		},
	};
}
