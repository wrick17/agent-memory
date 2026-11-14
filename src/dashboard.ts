// The owner dashboard (section 15): Home, Memories, Learnings, Journals, Projects and the Map, plus the owner tools behind
// Settings (write, review, change history with undo, backups, moves, wipe, devices, profiles and routing). Every page reads and
// writes through the owner API that exists. A server-rendered page and browser code served as /app.js. The
// browser code is a list of parts in src/dashboard/ (see am.ts), each serialized with toString(), so tests run the same code. No
// bundler and no framework. The static nav below is what a reader sees if the script never runs.
import { ADMIN } from "./dashboard/admin";
import type { Part } from "./dashboard/am";
import { auditTab } from "./dashboard/audit";
import { chartsTab } from "./dashboard/charts";
import { glossary } from "./dashboard/glossary";
import { libraryTab } from "./dashboard/library";
import { mapTab } from "./dashboard/map";
import { shell } from "./dashboard/shell";
import { storeTab } from "./dashboard/store";
import { DASHBOARD_CSS } from "./dashboard/style";
import { readable } from "./dashboard/readable";
import { readableOn } from "./readable";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const DASHBOARD_HTML = (env: Env) => `<!doctype html>
<html lang="en"${readableOn(env) ? ' data-readable="on"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory</title>
<style>${DASHBOARD_CSS}</style></head>
<body><header class="top"><a class="mark" href="#home">Agent Memory</a><nav id="nav" aria-label="Dashboard"><a href="#home">Home</a><a href="#memories">Memories</a><a href="#learnings">Learnings</a><a href="#journals">Journals</a><a href="#projects">Projects</a><a href="#map">Map</a></nav><div id="tools" class="tools"></div></header>
<main><p id="status" role="status">Loading sign-in…</p><div id="signin"></div>
<div id="view" hidden></div></main>
<dialog id="gloss" aria-labelledby="gloss-title"></dialog>
<script defer crossorigin="anonymous" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${esc(env.CLERK_PUBLISHABLE_KEY)}" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/app.js"></script></body></html>`;

/** The parts after the shell: the glossary (the owner tools' help), the library and charts every page reads, the pages, then the owner tools. */
export const PARTS: Part[] = [glossary, storeTab, chartsTab, readable, libraryTab, mapTab, auditTab, ...ADMIN];

/** The browser half, as /app.js runs it: the shell, every part, then sign-in and the first render. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export async function dashboardMain(win: any): Promise<void> {
	shell(win);
	for (const part of PARTS) part(win.__am);
	await win.__am.boot();
}

// Wrangler bundles with esbuild keep_names, which wraps inner functions in __name(fn, "name"); the browser has no such helper.
export const DASHBOARD_JS = `"use strict";\nvar __name = (fn) => fn;\n(${shell.toString()})(window);\n${PARTS.map((f) => `(${f.toString()})(window.__am);`).join("\n")}\nwindow.__am.boot();\n`;
