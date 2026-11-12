// Devices and tokens (#/devices), inside the dashboard's own header, so the owner tools share one shell (the old /settings page
// redirects here): list, create (a token is shown once), and revoke after a confirmation.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node } from "../am";

export function devicesPages(am: Am): void {
	const { call, el, intro, note, why } = am;
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const CAN: Record<string, string> = { read: "Read", write: "Write", ingest: "Send session logs", maintenance: "Run upkeep", import: "Import" };
	const ago = (iso: unknown) => {
		const t = Date.parse(String(iso ?? ""));
		if (!Number.isFinite(t)) return "Never used";
		const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
		return `Last used ${m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : am.when(iso).text}`;
	};
	const page = (view: Node): Node => {
		const version = am.pageVersion, h = el("h2", view, "Devices and tokens");
		intro(view, "Devices", "devices", "the machines and tokens that can read and write your memory. Create one per machine; revoke one you no longer use.");
		const status = cls(el("p", view), "muted");
		status.setAttribute("role", "status");
		const tools = cls(el("div", view), "toolbar"), showLabel = el("label", tools), show = el("input", showLabel);
		show.setAttribute("type", "checkbox");
		const showText = el("span", showLabel, " Show revoked");
		const wrap = cls(el("div", view), "tablewrap stack"), table = el("table", wrap), hr = el("tr", el("thead", table)), body = el("tbody", table);
		for (const t of ["Name", "Kind", "It can", "Profiles", "Default", "Used", "State", ""]) el("th", hr, t).setAttribute("scope", "col");
		const load = async () => {
			let list: J[];
			try { list = await call("/api/devices"); } catch (err) { if (version === am.pageVersion) status.textContent = `Could not load devices: ${why(err)}`; return; }
			if (version !== am.pageVersion) return;
			body.replaceChildren();
			const revoked = list.filter((d) => d.revoked_at).length;
			showText.textContent = ` Show revoked (${revoked})`;
			for (const d of list) {
				if (d.revoked_at && !show.checked) continue;
				const tr = el("tr", body);
				for (const t of [String(d.name), d.kind === "oauth" ? "OAuth" : d.kind === "token" ? "Token" : String(d.kind), (d.scopes ?? []).map((x: string) => CAN[x] ?? x).join(", "), (d.profiles ?? []).join(", "), d.default_profile || "—", ago(d.last_used_at),
					d.revoked_at ? "Revoked" : d.enabled === false ? "Disabled" : "Active"]) el("td", tr, t);
				const td = el("td", tr);
				if (d.revoked_at) continue;
				const b = el("button", td, "Revoke");
				b.setAttribute("type", "button");
				b.setAttribute("aria-label", `Revoke ${String(d.name)}`);
				b.addEventListener("click", () => {
					b.hidden = true;
					const ask = el("span", td, `Revoke ${String(d.name)}? It stops working at once. `);
					const yes = el("button", td, "Revoke");
					yes.setAttribute("type", "button");
					const no = el("button", td, "Cancel");
					no.setAttribute("type", "button");
					no.addEventListener("click", () => { (ask as J).remove(); (yes as J).remove(); (no as J).remove(); b.hidden = false; });
					yes.addEventListener("click", async () => {
						yes.disabled = true;
						try { await call(`/api/devices/${encodeURIComponent(String(d.id))}/revoke`, "POST", {}); status.textContent = `Revoked ${String(d.name)}.`; await load(); }
						catch (err) { status.textContent = `Could not revoke: ${why(err)}`; yes.disabled = false; }
					});
				});
			}
			if (!list.length) note(view, "No devices yet.", "muted");
		};
		show.addEventListener("change", () => void load());
		// A new device: a token is shown once; an OAuth machine gets no token, only a default profile.
		const form = cls(el("form", view), "panel");
		el("h3", form, "New device");
		const grid = cls(el("div", form), "devform");
		const field = (label: string, name: string, value = "") => { const l = cls(el("label", grid, label), "field"); const i = el("input", l); i.setAttribute("name", name); i.value = value; return i; };
		const name = field("Name", "name");
		// Plain choices: what the device may do, and which profiles it may use.
		const boxes = (legend: string, opts: [string, string, boolean][]) => {
			const fs = cls(el("fieldset", grid), "field wide checks");
			el("legend", fs, legend);
			return opts.map(([value, label, on]) => { const l = el("label", fs), i = el("input", l); i.setAttribute("type", "checkbox"); i.setAttribute("value", value); i.checked = on; el("span", l, ` ${label}`); return i; });
		};
		const scopes = boxes("It can", [["read", "Read", true], ["write", "Write", true], ["ingest", "Send session logs", false], ["maintenance", "Run upkeep", false], ["import", "Import", false]]);
		const profileNames = am.active().map((p) => p.name);
		const profiles = boxes("Profiles it may use", (profileNames.length ? profileNames : ["personal"]).map((n): [string, string, boolean] => [n, n, n === "personal"]));
		const def = field("Default profile", "default_profile", profileNames.includes("personal") ? "personal" : profileNames[0] ?? "");
		const ol = cls(el("label", grid), "field wide"), oauth = el("input", ol);
		oauth.setAttribute("type", "checkbox");
		el("span", ol, " Signs in with OAuth (no token; it sends its default profile)");
		el("button", el("p", form), "Create").setAttribute("type", "submit");
		const tokenBox = cls(el("div", form), "token");
		tokenBox.hidden = true;
		const picked = (l: J[]) => l.filter((i) => i.checked).map((i) => String(i.getAttribute("value")));
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.value)) { status.textContent = "A name is letters, digits, dot, dash or underscore, up to 64."; return; }
			if (!picked(scopes).length || !picked(profiles).length) { status.textContent = "Choose at least one thing it can do and one profile."; return; }
			try {
				const out: J = await call("/api/devices", "POST", { name: name.value, oauth: oauth.checked, scopes: picked(scopes), profiles: picked(profiles), default_profile: def.value || undefined });
				if (version !== am.pageVersion) return;
				tokenBox.hidden = false;
				tokenBox.textContent = out.token ? `Token for ${String(out.name)} (shown once; keep it in the keychain now): ${String(out.token)}` : `Created OAuth device ${String(out.name)}.`;
				await load();
			} catch (err) { status.textContent = `Could not create it: ${why(err)}`; }
		});
		void load();
		return h;
	};
	am.pages.devices = page;
}
