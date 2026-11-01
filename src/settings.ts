// The minimal Settings page: sign in with Clerk, then list, create and revoke device tokens. Phase 4 replaces it with the dashboard.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const SETTINGS_HTML = (env: Env) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Memory settings</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1b1f24}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:.4rem;text-align:left}
code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px;word-break:break-all}fieldset{margin:1rem 0}label{display:block;margin:.3rem 0}
.sr{position:absolute;left:-9999px}.token{background:#fff8c5;padding:.6rem;border:1px solid #d4a72c;border-radius:6px}</style></head>
<body><main><h1>Agent Memory settings</h1>
<p id="status" role="status">Loading sign-in…</p><div id="signin"></div>
<section id="app" hidden aria-labelledby="devices-h">
<h2 id="devices-h">Devices</h2><table><thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Scopes</th><th scope="col">Profiles</th><th scope="col">Default</th><th scope="col">Last used</th><th scope="col">State</th><th scope="col"><span class="sr">Action</span></th></tr></thead><tbody id="devices"></tbody></table>
<form id="create"><fieldset><legend>New device</legend>
<label>Name <input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"></label>
<label><input type="checkbox" name="oauth"> OAuth machine (no token; sets a default profile for the X-Agent-Memory-Device header)</label>
<label>Scopes (comma separated: read, write, ingest, maintenance, import) <input name="scopes" value="read,write"></label>
<label>Profiles (comma separated) <input name="profiles" value="personal,me"></label>
<label>Default profile <input name="default_profile" value="personal"></label>
<button>Create</button></fieldset></form>
<div id="token" class="token" hidden aria-live="polite"></div></section></main>
<script defer crossorigin="anonymous" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${esc(env.CLERK_PUBLISHABLE_KEY)}" src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/settings.js"></script></body></html>`;

/**
 * The browser half of the page, served as /settings.js by serializing this function, so tests run the same code.
 * It may use only its parameter. ClerkJS 6 builds its components only when load() receives the ClerkUI constructor
 * from @clerk/ui (the CDN bundle sets window.__internal_ClerkUICtor); without it mountSignIn throws
 * "Clerk was not loaded with Ui components".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- browser globals; this Worker project has no DOM types
export async function settingsMain(win: any): Promise<void> {
	const doc = win.document;
	const $ = (id: string) => doc.getElementById(id);
	const status = (t: string) => { $("status").textContent = t; };
	if (doc.readyState !== "complete") await new Promise((resolve) => win.addEventListener("load", resolve, { once: true }));
	const clerk = win.Clerk, ClerkUI = win.__internal_ClerkUICtor;
	if (!clerk || !ClerkUI) {
		status(`Sign-in could not start: ${clerk ? "the Clerk UI bundle" : "ClerkJS"} did not load. Check the network and the browser console for a blocked script.`);
		return;
	}
	try {
		await clerk.load({ ui: { ClerkUI }, telemetry: false });
	} catch (err) {
		status(`Sign-in could not start: ${(err as Error).message}`);
		return;
	}
	const call = async (path: string, init: { method?: string; body?: string } = {}) => {
		const token = await clerk.session.getToken();
		const res = await win.fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error?.message ?? String(res.status));
		return body;
	};
	const cell = (row: { appendChild(n: unknown): void }, text: string) => { const td = doc.createElement("td"); td.textContent = text; row.appendChild(td); return td; };
	const load = async (): Promise<void> => {
		const tbody = $("devices");
		tbody.replaceChildren();
		for (const d of await call("/api/devices")) {
			const tr = doc.createElement("tr");
			[d.name, d.kind, d.scopes.join(", "), d.profiles.join(", "), d.default_profile || "", d.last_used_at || "never", d.revoked_at ? "revoked" : d.enabled === false ? "disabled" : "active"].forEach((t: string) => cell(tr, t));
			const td = cell(tr, "");
			if (!d.revoked_at) {
				const b = doc.createElement("button");
				b.textContent = `Revoke ${d.name}`;
				b.addEventListener("click", async () => { await call(`/api/devices/${d.id}/revoke`, { method: "POST", body: "{}" }); await load(); });
				td.appendChild(b);
			}
			tbody.appendChild(tr);
		}
	};
	if (!clerk.user) {
		status("Sign in as the owner.");
		try { clerk.mountSignIn($("signin")); } catch (err) { status(`Sign-in could not start: ${(err as Error).message}`); }
		return;
	}
	status("Signed in.");
	$("app").hidden = false;
	$("create").addEventListener("submit", async (e: { preventDefault(): void; target: unknown }) => {
		e.preventDefault();
		const f = new win.FormData(e.target);
		const list = (k: string) => String(f.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
		try {
			const out = await call("/api/devices", { method: "POST", body: JSON.stringify({ name: f.get("name"), oauth: f.get("oauth") === "on", scopes: list("scopes"), profiles: list("profiles"), default_profile: f.get("default_profile") || undefined }) });
			const box = $("token");
			box.hidden = false;
			box.textContent = out.token ? `Token for ${out.name} (shown once; store it in the keychain now): ${out.token}` : `Created OAuth device ${out.name}`;
			await load();
		} catch (err) { status(`Create failed: ${(err as Error).message}`); }
	});
	try { await load(); } catch (err) { status(`Could not load devices: ${(err as Error).message}`); }
}

// Wrangler bundles with esbuild keep_names, which wraps inner functions in __name(fn, "name"); the browser has no such helper.
export const SETTINGS_JS = `"use strict";\nvar __name = (fn) => fn;\n(${settingsMain.toString()})(window);\n`;
