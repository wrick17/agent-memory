// `agent-memory replay [--list] [--session ID] [--port N]` (#22). Serves full local transcripts to a browser on this machine
// only: bound to 127.0.0.1 (a random port by default), every path behind a 32-byte URL token, exact Host and same-origin
// Origin checked before routing, GET and HEAD only, and a self-only Content-Security-Policy with no inline script or style.
// The page loads the shared replay player (replay-player.js) byte for byte. Nothing is uploaded.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { findSession, listTranscripts, readFull, SESSION_ID } from "./transcript-full.mjs";

export const HEADERS = {
	"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"X-Frame-Options": "DENY",
};

/**
 * Whether a request may be routed: the first path segment must be the token (constant-time), Host must be exactly this
 * server and Origin, when sent, must be this server's origin.
 * @param {{ url: string, headers: Record<string, string | string[] | undefined> }} req @param {{ token: string, port: number }} server
 */
export function allowRequest(req, { token, port }) {
	if (typeof token !== "string" || !token || !Number.isInteger(port) || port <= 0) return false;
	const { url, headers } = req;
	if (typeof url !== "string" || !url.startsWith("/")) return false;
	const end = url.indexOf("/", 1);
	const given = Buffer.from(end < 0 ? url.slice(1) : url.slice(1, end)), want = Buffer.from(token);
	if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
	if (headers.host !== `127.0.0.1:${port}`) return false;
	return headers.origin === undefined || headers.origin === `http://127.0.0.1:${port}`;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Agent Memory replay</title>
<link rel="stylesheet" href="viewer.css">
</head>
<body>
<header><h1>Agent Memory replay</h1><p>Full local transcript, served from this machine only and never uploaded.</p></header>
<main>
<nav aria-labelledby="sessions-h"><h2 id="sessions-h">Local sessions</h2><ul id="sessions"></ul></nav>
<section aria-labelledby="player-h"><h2 id="player-h">Session</h2><p id="status" role="status" aria-live="polite">Loading sessions…</p><div id="player"></div></section>
</main>
<script src="replay-player.js"></script>
<script src="viewer.js"></script>
</body>
</html>
`;

const CSS = `:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #5f6368; --line: #d9d9de; --accent: #2557d6; --soft: #f3f4f6; }
@media (prefers-color-scheme: dark) { :root { --bg: #141416; --fg: #ececf1; --muted: #a0a0aa; --line: #34343a; --accent: #8fb0ff; --soft: #1f1f23; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
header { padding: 16px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 1.2rem; }
header p, #status { margin: 4px 0 0; color: var(--muted); }
main { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 16px; padding: 16px; }
@media (max-width: 720px) { main { grid-template-columns: minmax(0, 1fr); } }
h2 { font-size: 1rem; margin: 0 0 8px; }
#sessions { list-style: none; margin: 0; padding: 0; max-height: 75vh; overflow: auto; }
#sessions button { display: block; width: 100%; text-align: left; padding: 8px; margin: 0 0 4px; background: none; color: inherit; border: 1px solid var(--line); border-radius: 6px; font: inherit; cursor: pointer; overflow-wrap: anywhere; }
#sessions button[aria-current="true"] { border-color: var(--accent); }
small { display: block; color: var(--muted); }
button:focus-visible, .replay-event:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.replay-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 12px 0; }
.replay-controls button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: inherit; cursor: pointer; }
.replay-controls button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.replay-controls button:disabled { opacity: .5; cursor: default; }
.replay-speeds { display: inline-flex; gap: 4px; }
.replay-position { color: var(--muted); }
.replay-body { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 12px; }
@media (max-width: 900px) { .replay-body { grid-template-columns: minmax(0, 1fr); } }
.replay-list { list-style: none; margin: 0; padding: 0; max-height: 70vh; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
.replay-event { padding: 6px 8px; border-bottom: 1px solid var(--line); cursor: pointer; overflow-wrap: anywhere; }
.replay-event[aria-selected="true"] { background: var(--soft); box-shadow: inset 3px 0 var(--accent); }
.replay-time { color: var(--muted); }
.chip { font-size: .8rem; padding: 0 6px; border: 1px solid var(--line); border-radius: 999px; }
.replay-detail { min-width: 0; }
.replay-detail h3 { font-size: 1rem; margin: 0 0 8px; }
.replay-detail .text { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); padding: 8px; border-radius: 6px; max-height: 60vh; overflow: auto; font-family: ui-monospace, monospace; font-size: .85rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.na { color: var(--muted); font-style: italic; }
`;

// Same-origin relative fetches: the page's path already carries the token. Every value is set as text.
const VIEWER = `(function () {
	"use strict";
	var list = document.getElementById("sessions"), status = document.getElementById("status"), root = document.getElementById("player");
	var player = null;
	function get(path) { return fetch(path, { credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }); }
	function open(id) {
		status.textContent = "Loading " + id + "…";
		Array.prototype.forEach.call(list.querySelectorAll("button"), function (b) { b.setAttribute("aria-current", b.dataset.id === id ? "true" : "false"); });
		get("api/session?id=" + encodeURIComponent(id)).then(function (s) {
			if (player) player.destroy();
			root.textContent = "";
			status.textContent = s.client + " session " + s.session + ": " + s.events.length + " events";
			player = globalThis.amReplayPlayer.mount(root, s.events, {});
		}, function (e) { status.textContent = e.message === "404" ? "That session is not in the local stores." : "The session could not be read."; });
	}
	get("api/sessions").then(function (rows) {
		rows.forEach(function (s) {
			var li = document.createElement("li"), b = document.createElement("button"), small = document.createElement("small");
			b.type = "button"; b.dataset.id = s.session; b.textContent = s.session;
			small.textContent = s.client + " · " + s.modified_at.slice(0, 16).replace("T", " ") + " · " + Math.ceil(s.bytes / 1024) + " KB";
			b.appendChild(small);
			b.addEventListener("click", function () { history.replaceState(null, "", "#" + encodeURIComponent(s.session)); open(s.session); });
			li.appendChild(b); list.appendChild(li);
		});
		var want = "";
		try { want = decodeURIComponent(location.hash.slice(1)); } catch (e) { want = ""; }
		if (want) open(want);
		else status.textContent = rows.length ? "Choose a session." : "No local sessions found.";
	}, function () { status.textContent = "The session list could not be read."; });
})();
`;

/**
 * Starts the viewer on 127.0.0.1. @param {{ session?: string, port?: number, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ url: string, port: number, token: string, close(): Promise<void> }>} url carries the token
 */
export async function startReplay({ session, port = 0, env = process.env } = {}) {
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
	if (session !== undefined && !findSession(session, { env })) throw new Error("session_not_found");
	const player = fs.readFileSync(new URL("./replay-player.js", import.meta.url)); // served unchanged
	const token = randomBytes(32).toString("base64url");
	let bound = 0;

	const send = (res, code, type, body) => {
		res.writeHead(code, { ...HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
		res.end(body);
	};
	const json = (res, code, v) => send(res, code, "application/json; charset=utf-8", JSON.stringify(v));
	const server = http.createServer((req, res) => {
		// Token, Host and Origin come before any routing or file access; refusals carry no detail.
		if (!allowRequest({ url: req.url ?? "", headers: req.headers }, { token, port: bound })) return send(res, 403, "text/plain; charset=utf-8", "forbidden\n");
		if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n");
		const { pathname, searchParams: q } = new URL(req.url, "http://127.0.0.1");
		// URL() resolves dot segments; a path that no longer starts with the token gets nothing.
		const rest = pathname.startsWith(`/${token}/`) ? pathname.slice(token.length + 1) : "";
		try {
			if (rest === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
			if (rest === "/viewer.css") return send(res, 200, "text/css; charset=utf-8", CSS);
			if (rest === "/viewer.js") return send(res, 200, "text/javascript; charset=utf-8", VIEWER);
			if (rest === "/replay-player.js") return send(res, 200, "text/javascript; charset=utf-8", player);
			if (rest === "/api/sessions") return json(res, 200, listTranscripts({ env }).map(({ client, session: id, modified_at, bytes }) => ({ client, session: id, modified_at, bytes })));
			if (rest === "/api/session") {
				const id = q.get("id") ?? "";
				const s = SESSION_ID.test(id) ? findSession(id, { env }) : null;
				if (!s) return json(res, 404, { error: "not_found" });
				return json(res, 200, { client: s.client, session: s.session, modified_at: s.modified_at, events: readFull(s.client, s.file) });
			}
			return send(res, 404, "text/plain; charset=utf-8", "not found\n");
		} catch {
			// No message: it could name a local path or quote transcript bytes.
			return json(res, 500, { error: "unreadable" });
		}
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	bound = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	return {
		url: `http://127.0.0.1:${bound}/${token}/${session ? `#${encodeURIComponent(session)}` : ""}`,
		port: bound,
		token,
		close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
	};
}

const usage = (prog) => `usage: ${prog} [--list] [--session ID] [--port N]\n`
	+ "  --list        print the Claude Code and Codex sessions on this machine, newest first\n"
	+ "  --session ID  open that session in the viewer\n"
	+ "  --port N      listen on this port of 127.0.0.1 (default 0: a random free port)\n";

/** Resolves to the exit code: 0 done, 1 failed, 2 bad arguments. --list prints local sessions; otherwise serves until interrupted. */
export async function main(argv, prog = "agent-memory replay", { env = process.env, out = process.stdout, err = process.stderr } = {}) {
	let list = false, session, port = 0;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") { out.write(usage(prog)); return 0; }
		if (a === "--list") list = true;
		else if (a === "--session" && SESSION_ID.test(argv[i + 1] ?? "")) session = argv[++i];
		else if (a === "--port" && /^\d{1,5}$/.test(argv[i + 1] ?? "") && Number(argv[i + 1]) <= 65535) port = Number(argv[++i]);
		else { err.write(`${prog}: bad argument ${JSON.stringify(a).slice(0, 80)}\n${usage(prog)}`); return 2; }
	}
	if (list) {
		const rows = listTranscripts({ env });
		if (!rows.length) out.write("No local sessions found.\n");
		for (const s of rows) out.write(`${s.client.padEnd(12)} ${s.session}  ${s.modified_at.slice(0, 16).replace("T", " ")}  ${Math.ceil(s.bytes / 1024)} KB\n`);
		return 0;
	}
	let viewer;
	try { viewer = await startReplay({ session, port, env }); } catch (e) {
		err.write(`${prog}: ${e.message === "session_not_found" ? "no local session with that id" : e.code === "EADDRINUSE" ? "that port is in use" : "could not start the viewer"}\n`);
		return 1;
	}
	out.write(`Replay viewer: ${viewer.url}\nServing on 127.0.0.1 only. Keep this URL private; press Ctrl-C to stop.\n`);
	await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
	await viewer.close();
	return 0;
}
