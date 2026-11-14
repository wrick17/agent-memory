#!/usr/bin/env node
// `node local/rewriter.mjs`: the readable-rewrite service the Worker calls (src/readable.ts, READABLE_REWRITER_URL). One route,
// POST /v1/rewrite with `Authorization: Bearer <token>` and {texts: [{id, text}]}, answering {results: [{id, rewrite}]}. It owns
// the prompt and output schema (src/domain/rewrite.ts, shared with the Worker's ChatGPT path) and accepts only texts. Each batch
// runs `codex exec -m gpt-6-luna` at low effort in the confined runner (agent-memory.mjs: ephemeral, no tools, --output-schema),
// one batch at a time, at most 200 texts per rolling hour (429 beyond). Binds 127.0.0.1:8790; a tunnel fronts it for the hosted
// Worker. The token is read from REWRITER_TOKEN_FILE (default ~/.agent-memory/rewriter-token), at least 32 characters.
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { confinedRunner, home } from "./agent-memory.mjs";
import { MODEL, PROMPT, SCHEMA, MAX_TEXT, MAX_TEXTS, rewriteInput, rewriteItems, rewriteResults } from "../src/domain/rewrite.ts";

export const PATH = "/v1/rewrite", HOURLY = 200, HOUR_MS = 3_600_000;
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

/** The HTTP handler around `rewrite(items)`, which returns {kind, results}. Requests queue: one batch runs at a time. */
export function handler({ token, rewrite, cap = hourlyCap(), log = (o) => console.log(JSON.stringify(o)) }) {
	let tail = Promise.resolve();
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
			const room = cap(items.length);
			if (!room.ok) { log({ event: "rewrite_limited", texts: items.length }); return send(res, 429, { error: { code: "rate_limited", message: `at most ${HOURLY} texts per hour` } }, { "retry-after": String(room.retryAfter) }); }
			const run = tail.then(async () => {
				const t0 = Date.now(), out = await rewrite(items).catch(() => ({ kind: "runtime_error", results: new Map() }));
				log({ event: "rewrite", texts: items.length, answered: out.results.size, kind: out.kind, ms: Date.now() - t0 });
				if (out.kind !== "ok") return send(res, 502, { error: { code: out.kind } });
				send(res, 200, { results: [...out.results].map(([id, rewrite]) => ({ id, rewrite })) });
			});
			tail = run.catch(() => undefined);
		});
	};
}

/** One batch through the confined Codex runner, with the same prompt layout as the Worker's ChatGPT path. */
export const codexRewrite = (runner) => async (items) => {
	const out = await runner.exec({ prompt: `${PROMPT}\n${rewriteInput(items)}\n`, schema: SCHEMA, model: MODEL, effort: "low" });
	return { kind: out.kind, results: out.kind === "ok" ? rewriteResults(out.part, items.map((t) => t.id)) : new Map() };
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
	const tokenFile = process.env.REWRITER_TOKEN_FILE || path.join(home(), "rewriter-token");
	let token = "";
	try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* reported below */ }
	if (token.length < 32) { console.error(`rewriter: put a token of at least 32 characters in ${tokenFile} (mode 600)`); process.exit(1); }
	const runner = await confinedRunner();
	if (!runner.available) { console.error(`rewriter: the confined Codex runner is unavailable (${runner.reason})`); process.exit(1); }
	const port = Number(process.env.REWRITER_PORT || 8790);
	const server = http.createServer(handler({ token, rewrite: codexRewrite(runner) }));
	server.requestTimeout = 0; // a queued batch can wait minutes; the Worker sets its own timeout
	server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "rewriter_listening", url: `http://127.0.0.1:${port}${PATH}` })));
	const stop = () => { runner.cleanup(); server.close(); process.exit(0); };
	process.on("SIGTERM", stop).on("SIGINT", stop);
}
