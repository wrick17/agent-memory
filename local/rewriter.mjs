#!/usr/bin/env node
// `node local/rewriter.mjs`: the readable-rewrite service the Worker calls (src/readable.ts, READABLE_REWRITER_URL). One route,
// POST /v1/rewrite with `Authorization: Bearer <token>` and {texts: [{id, text}]}, answering {results: [{id, rewrite}]}. It owns
// the prompt and output schema (src/domain/rewrite.ts, shared with the Worker's ChatGPT path) and accepts only texts. Each batch
// runs `codex exec -m gpt-6-luna` at low effort in the confined runner (agent-memory.mjs: ephemeral, no tools, --output-schema),
// requests concurrently with at most MAX_RUNS Codex runs at once, at most 200 texts per rolling hour (429 beyond). Binds 127.0.0.1:8790; a tunnel fronts it for the hosted
// Worker. The token is read from REWRITER_TOKEN_FILE (default ~/.agent-memory/rewriter-token), at least 32 characters.
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { confinedRunner, home } from "./agent-memory.mjs";
import { EFFORT, MODEL, PROMPT, SCHEMA, MAX_TEXT, MAX_TEXTS, inChunks, rewriteInput, rewriteItems, rewriteResults } from "../src/domain/rewrite.ts";

export const PATH = "/v1/rewrite", HOURLY = 200, HOUR_MS = 3_600_000;
// The Worker gives up on a batch after 90 s (REWRITER_TIMEOUT_MS in src/readable.ts); a chunk still waiting after that never runs.
// At most MAX_PENDING requests wait or run (more get 503: the hourly cap alone does not bound a backlog), and at most MAX_RUNS
// Codex runs go at once across all of them, since the dashboard sends several small requests together.
export const STALE_MS = 90_000, MAX_PENDING = 16, MAX_RUNS = 6;

/** A counting semaphore: `take` waits for one of `n` slots, `give` frees it. */
export function slots(n) {
	let free = n;
	const waiting = [];
	return { take: () => (free > 0 ? (free--, Promise.resolve()) : new Promise((r) => waiting.push(r))), give: () => { const w = waiting.shift(); if (w) w(); else free++; } };
}
const MAX_BODY = MAX_TEXTS * MAX_TEXT * 4 + 4096; // JSON escaping can grow text; anything larger is refused unread

const digest = (s) => createHash("sha256").update(s).digest();
/** Constant-time bearer check: both sides hashed to equal lengths first. */
export const authorized = (header, token) => typeof header === "string" && header.startsWith("Bearer ")
	&& timingSafeEqual(digest(header.slice(7)), digest(token));

/** Texts admitted in the last hour; `take(n)` admits n more or returns the seconds until room frees up. */
export function hourlyCap(limit = HOURLY, now = Date.now) {
	const used = []; // [time, count]
	return (n) => {
		const t = now();
		while (used.length && used[0][0] <= t - HOUR_MS) used.shift();
		const total = used.reduce((a, [, c]) => a + c, 0);
		if (total + n > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil(((used[0]?.[0] ?? t) + HOUR_MS - t) / 1000)) };
		used.push([t, n]);
		return { ok: true };
	};
}

/** The HTTP handler around `rewrite(items, signal)`, which returns {kind, results}. Requests run concurrently, sharing `runs`. */
export function handler({ token, rewrite, cap = hourlyCap(), runs = slots(MAX_RUNS), log = (o) => console.log(JSON.stringify(o)) }) {
	let pending = 0;
	const send = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
	return (req, res) => {
		if (req.url !== PATH) return send(res, 404, { error: { code: "not_found" } });
		if (req.method !== "POST") return send(res, 405, { error: { code: "method_not_allowed" } }, { allow: "POST" });
		if (!authorized(req.headers.authorization, token)) return send(res, 401, { error: { code: "unauthorized" } });
		if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return send(res, 413, { error: { code: "too_large" } });
		const chunks = [];
		let size = 0;
		req.on("data", (d) => { size += d.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(d); });
		req.on("end", () => {
			let body = null;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* refused below */ }
			const items = rewriteItems(body);
			if (!items) return send(res, 400, { error: { code: "validation", message: `send {"texts": [{"id": integer, "text": string}]}, 1 to ${MAX_TEXTS} texts of at most ${MAX_TEXT} characters, distinct ids` } });
			if (pending >= MAX_PENDING) { log({ event: "rewrite_busy", texts: items.length }); return send(res, 503, { error: { code: "busy", message: `at most ${MAX_PENDING} requests at a time` } }, { "retry-after": "30" }); }
			const room = cap(items.length);
			if (!room.ok) { log({ event: "rewrite_limited", texts: items.length }); return send(res, 429, { error: { code: "rate_limited", message: `at most ${HOURLY} texts per hour` } }, { "retry-after": String(room.retryAfter) }); }
			// A caller that hung up (the Worker's timeout or a closed tab) gets nothing, so its queued batch must not spend plan usage.
			let gone = false;
			const hangUp = new AbortController();
			res.on("close", () => { gone = !res.writableFinished; if (gone) hangUp.abort(); });
			const queued = Date.now();
			pending++;
			// The request's chunks run in parallel, each in a global run slot. A hang-up stops every running chunk's Codex process group
			// and no later chunk starts; a chunk that waited past the Worker's timeout is dropped. Texts still count toward the hourly cap.
			const chunk = async (part) => {
				await runs.take();
				try {
					if (gone || Date.now() - queued > STALE_MS) return { kind: gone ? "aborted" : "stale", results: new Map() };
					return await rewrite(part, hangUp.signal).catch(() => ({ kind: "runtime_error", results: new Map() }));
				} finally { runs.give(); }
			};
			const run = (async () => {
				const t0 = Date.now(), parts = await inChunks(items, chunk);
				const results = new Map(parts.flatMap((p) => [...p.results])), failed = parts.find((p) => p.kind !== "ok");
				log({ event: "rewrite", texts: items.length, chunks: parts.length, answered: results.size, kind: gone ? "aborted" : failed?.kind ?? "ok", ms: Date.now() - t0 });
				if (gone) return;
				if (failed?.kind === "stale" && !results.size) return res.destroy();
				// Some chunks answered: send what there is; the rest keep their original text.
				if (failed && !results.size) return send(res, 502, { error: { code: failed.kind } });
				send(res, 200, { results: [...results].map(([id, rewrite]) => ({ id, rewrite })) });
			})();
			run.catch(() => undefined).finally(() => { pending--; });
		});
	};
}

/** One batch through the confined Codex runner, with the same prompt layout as the Worker's ChatGPT path. */
export const codexRewrite = (runner) => async (items, signal) => {
	const out = await runner.exec({ prompt: `${PROMPT}\n${rewriteInput(items)}\n`, schema: SCHEMA, model: MODEL, effort: EFFORT, signal });
	return { kind: out.kind, results: out.kind === "ok" ? rewriteResults(out.part, items.map((t) => t.id)) : new Map() };
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
	const tokenFile = process.env.REWRITER_TOKEN_FILE || path.join(home(), "rewriter-token");
	let token = "";
	try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* reported below */ }
	if (token.length < 32) { console.error(`rewriter: put a token of at least 32 characters in ${tokenFile} (mode 600)`); process.exit(1); }
	// Lean config: Codex's own ~7k-token base prompt is left out; same confinement and probes (agent-memory.mjs leanConfig).
	const runner = await confinedRunner({}, { lean: true });
	if (!runner.available) { console.error(`rewriter: the confined Codex runner is unavailable (${runner.reason})`); process.exit(1); }
	const port = Number(process.env.REWRITER_PORT || 8790);
	const server = http.createServer(handler({ token, rewrite: codexRewrite(runner) }));
	server.requestTimeout = 0; // a queued batch can wait minutes; the Worker sets its own timeout
	server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "rewriter_listening", url: `http://127.0.0.1:${port}${PATH}` })));
	const stop = () => { runner.cleanup(); server.close(); process.exit(0); };
	process.on("SIGTERM", stop).on("SIGINT", stop);
}
