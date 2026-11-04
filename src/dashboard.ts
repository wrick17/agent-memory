// The owner dashboard (section 15): a server-rendered page and /app.js, built from the browser parts in src/dashboard/ (see am.ts).
// Each part is serialized with toString(), so tests run the same code. No bundler and no framework. Every page reads and writes
// through the owner API that exists, and every value reaches the page as text.
import { actionsTab } from "./dashboard/actions";
import { activityTab } from "./dashboard/activity";
import { ADMIN } from "./dashboard/admin";
import type { Part } from "./dashboard/am";
import { auditTab } from "./dashboard/audit";
import { crystalsTab } from "./dashboard/crystals";
import { dataClient } from "./dashboard/data";
import { glossary } from "./dashboard/glossary";
import { graphTab } from "./dashboard/graph";
import { healthTab } from "./dashboard/health";
import { lessonsTab } from "./dashboard/lessons";
import { memoriesTab } from "./dashboard/memories";
import { overviewTab } from "./dashboard/overview";
import { profileTab } from "./dashboard/profile";
import { replayTab } from "./dashboard/replay";
import { sessionsTab } from "./dashboard/sessions";
import { shell } from "./dashboard/shell";
import { DASHBOARD_CSS } from "./dashboard/style";
// The replay player (P1) as text: wrangler.jsonc's Text rule for local/*-player.js. The local viewer serves the same file.
import REPLAY_PLAYER from "../local/replay-player.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const DASHBOARD_HTML = (env: Env) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory</title>
<style>${DASHBOARD_CSS}</style></head>
<body><nav id="nav" aria-label="Dashboard"></nav>
<main><h1>Agent Memory</h1>
<p id="status" role="status">Loading sign-in…</p><div id="signin"></div>
<div id="view" hidden></div></main>
<script defer crossorigin="anonymous" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${esc(env.CLERK_PUBLISHABLE_KEY)}" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/app.js"></script></body></html>`;

/** The parts after the shell, in nav order. A tab task fills its own file; nobody else edits this list. */
export const PARTS: Part[] = [dataClient, glossary, overviewTab, memoriesTab, lessonsTab, crystalsTab, graphTab, sessionsTab, actionsTab, replayTab,
	activityTab, profileTab, healthTab, auditTab, ...ADMIN];

/** The browser half, as /app.js runs it: the shell, every part, then sign-in and the first render. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export async function dashboardMain(win: any): Promise<void> {
	shell(win);
	for (const part of PARTS) part(win.__am);
	await win.__am.boot();
}

// Wrangler bundles with esbuild keep_names, which wraps inner functions in __name(fn, "name"); the browser has no such helper.
// The player's classic script runs right after the directive (which must stay first), so globalThis.amReplayPlayer exists before the shell reads it into am.player.
export const DASHBOARD_JS = `"use strict";\n${REPLAY_PLAYER}\nvar __name = (fn) => fn;\n(${shell.toString()})(window);\n${PARTS.map((f) => `(${f.toString()})(window.__am);`).join("\n")}\nwindow.__am.boot();\n`;
