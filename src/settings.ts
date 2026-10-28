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
<script src="${esc(env.CLERK_FRONTEND_API)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js" data-clerk-publishable-key="${esc(env.CLERK_PUBLISHABLE_KEY)}" crossorigin="anonymous" async></script>
<script src="/settings.js" defer></script></body></html>`;

export const SETTINGS_JS = `"use strict";
const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };
async function call(path, init = {}) {
	const token = await window.Clerk.session.getToken();
	const res = await fetch(path, { ...init, headers: { authorization: "Bearer " + token, "content-type": "application/json" } });
	const body = await res.json();
	if (!res.ok) throw new Error(body.error && body.error.message ? body.error.message : res.status + "");
	return body;
}
function cell(row, text) { const td = document.createElement("td"); td.textContent = text; row.appendChild(td); return td; }
async function load() {
	const devices = await call("/api/devices");
	const tbody = $("devices"); tbody.replaceChildren();
	for (const d of devices) {
		const tr = document.createElement("tr");
		[d.name, d.kind, d.scopes.join(", "), d.profiles.join(", "), d.default_profile || "", d.last_used_at || "never", d.revoked_at ? "revoked" : "active"].forEach((t) => cell(tr, t));
		const td = cell(tr, "");
		if (!d.revoked_at) { const b = document.createElement("button"); b.textContent = "Revoke " + d.name; b.onclick = async () => { await call("/api/devices/" + d.id + "/revoke", { method: "POST", body: "{}" }); load(); }; td.appendChild(b); }
		tbody.appendChild(tr);
	}
}
$("create").addEventListener("submit", async (e) => {
	e.preventDefault();
	const f = new FormData(e.target);
	const list = (k) => String(f.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
	try {
		const out = await call("/api/devices", { method: "POST", body: JSON.stringify({ name: f.get("name"), oauth: f.get("oauth") === "on", scopes: list("scopes"), profiles: list("profiles"), default_profile: f.get("default_profile") || undefined }) });
		const box = $("token"); box.hidden = false;
		box.textContent = out.token ? "Token for " + out.name + " (shown once; store it in the keychain now): " + out.token : "Created OAuth device " + out.name;
		load();
	} catch (err) { status("Create failed: " + err.message); }
});
window.addEventListener("load", async () => {
	if (!window.Clerk) { status("Clerk did not load."); return; }
	await window.Clerk.load();
	if (!window.Clerk.user) { status("Sign in as the owner."); window.Clerk.mountSignIn($("signin")); return; }
	status("Signed in."); $("app").hidden = false;
	try { await load(); } catch (err) { status("Could not load devices: " + err.message); }
});
`;
