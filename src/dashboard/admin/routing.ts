// Admin: Routing (#/routing).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node } from "../am";

export function routingPages(am: Am): void {
	const { act, btn, call, choose, el, facts, input, note, pageStatus, recorded, render, why } = am;

	// Routing (sections 6 and 15): the stored rules, edited as one list and saved whole after a preview, and a read-only test of
	// where a remote or path routes. The server renumbers the rules and the last save wins, so the list is read again after saving.
	// An unconfirmed or refused save keeps this tab's list; nothing is saved or tested by itself.
	type RuleRow = { priority: string; match: string; pattern: string; profile: string; enabled: boolean };
	let rulesDraft: { rows: RuleRow[]; text?: string; unsure?: boolean } | null = null;
	const routingPage = (view: Node) => {
		const version = am.pageVersion, h = el("h2", view, "Routing");
		note(view, "A write from a repository goes to the profile of the first enabled rule that matches it, by priority. Saving replaces the whole list and renumbers it; if another tab or device saves too, the last save wins. Nothing is ever routed into me.");
		const { msg, say } = pageStatus(view);
		const box = el("section", view), tester = el("section", view);
		box.setAttribute("aria-label", "Routing rules");
		tester.setAttribute("aria-label", "Test a route");
		// The test is read only: the server's own resolver over the stored rules, never the unsaved list.
		el("h3", tester, "Test where a repository routes");
		note(tester, "Uses the saved rules, not unsaved edits. Nothing is written.");
		const tf = el("form", tester), remote = input(tf, "route-remote", "Remote (for example github.com/org/repo)"), path = input(tf, "route-path", "Or a path");
		remote.setAttribute("maxlength", "500");
		path.setAttribute("maxlength", "1000");
		el("button", el("p", tf), "Test").setAttribute("type", "submit");
		const out = el("div", tester);
		out.setAttribute("aria-live", "polite");
		let test = 0;
		tf.addEventListener("submit", async (event) => {
			event.preventDefault();
			const body = { ...(remote.value.trim() ? { remote: remote.value.trim() } : {}), ...(path.value.trim() ? { path: path.value.trim() } : {}) }, n = ++test;
			out.replaceChildren();
			if (!Object.keys(body).length) { el("p", out, "Give a remote, a path or both."); return; }
			let r: J;
			try { r = await call("/api/rules/test", "POST", body); } catch (err) { if (n === test && version === am.pageVersion) el("p", out, `Could not test: ${why(err)}`); return; }
			if (n !== test || version !== am.pageVersion) return;
			const rule = r?.rule, w = r?.write, rd = r?.read;
			facts(out, [["Remote as read", recorded(r?.remote)], ["Path as read", recorded(r?.path)],
				["Matching rule", rule ? `priority ${recorded(rule.priority)}, ${recorded(rule.match)} “${recorded(rule.pattern)}” → ${recorded(rule.profile)}` : "No enabled rule matches"],
				["A write goes to", w?.error ? `Refused: ${recorded(w.error.message ?? w.error.code)}` : `${recorded(w?.profile)} (${recorded(w?.routed_by)})`],
				["A recall reads", rd?.error ? `Refused: ${recorded(rd.error.message ?? rd.error.code)}` : `${recorded(rd?.primary)}${rd?.with_me ? " and me" : ""} (${recorded(rd?.routed_by)})`]]);
		});
		say("Loading the rules…");
		(async () => {
			let r: J;
			try { r = await call("/api/rules"); if (!Array.isArray(r?.rules)) throw new Error("the server sent no rules"); }
			catch (err) { if (version === am.pageVersion) say(`Could not read the rules: ${why(err)}`); return; }
			if (version !== am.pageVersion) return;
			say("");
			const profiles: string[] = Array.isArray(r.profiles) ? r.profiles.map(String) : [];
			const rows: RuleRow[] = rulesDraft?.rows ?? r.rules.map((x: J) => ({ priority: String(x.priority), match: String(x.match), pattern: String(x.pattern), profile: String(x.profile), enabled: x.enabled === true }));
			el("h3", box, `Rules (${rows.length} ${rulesDraft ? "in this tab's unsaved list" : "saved"})`);
			if (rulesDraft?.text) note(box, rulesDraft.text, "warn");
			const tools = el("p", box), list = el("ol", box), problems = el("ul", box), row = el("p", box), shown = el("p", box);
			let previewed = !!rulesDraft?.unsure; // an unconfirmed save may be sent again exactly as it was
			const body = () => ({ rules: rows.map((x) => ({ priority: Number(x.priority.trim()), match: x.match, pattern: x.pattern.trim(), profile: x.profile, enabled: x.enabled })) });
			const invalid = () => [...(rows.length > 128 ? ["At most 128 rules."] : []), ...rows.flatMap((x, i) => [
				...(/^-?\d{1,9}$/.test(x.priority.trim()) ? [] : [`Rule ${i + 1}: the priority must be a whole number.`]),
				...(x.match === "remote" || x.match === "path" ? [] : [`Rule ${i + 1}: match a remote or a path.`]),
				...(x.pattern.trim().length >= 1 && x.pattern.trim().length <= 300 ? [] : [`Rule ${i + 1}: the pattern must be 1 to 300 characters.`]),
				...(profiles.includes(x.profile) ? [] : [`Rule ${i + 1}: choose an active profile other than me.`])])];
			const save = btn(row, rulesDraft?.unsure ? "Save the same list again" : "Save rules", () => {
				if (!previewed || invalid().length) return;
				const sent = body();
				act(() => call("/api/rules", "PUT", sent).catch((e: Failure) => {
					const unsure = !e.status || e.status >= 500 || e.status === 408 || e.status === 429;
					rulesDraft = { rows, unsure, text: unsure ? "Saving may or may not have happened. Save the same list again, or discard it and read the saved list." : `Not saved: ${why(e)}. Fix the list and save again.` };
					throw e;
				}), "save the routing rules", undefined, (x) => { rulesDraft = null; return { text: `Saved ${recorded(x?.rules)} rules. The list below is read again from the server.` }; });
			});
			const sync = () => {
				problems.replaceChildren();
				const bad = invalid();
				for (const t of bad) el("li", problems, t);
				save.disabled = !previewed || bad.length > 0;
			};
			const edited = () => { rulesDraft = { rows }; previewed = false; shown.textContent = ""; save.textContent = "Save rules"; sync(); };
			const draw = () => {
				list.replaceChildren();
				rows.forEach((x, i) => {
					const li = el("li", list), n = `rule-${i + 1}`;
					const pr = input(li, `${n}-priority`, `Rule ${i + 1} priority`), mt = choose(li, `${n}-match`, `Rule ${i + 1} matches a`, [["remote", "Remote"], ["path", "Path"]]);
					const pt = input(li, `${n}-pattern`, `Rule ${i + 1} pattern`), pf = choose(li, `${n}-profile`, `Rule ${i + 1} profile`,
						[...profiles.map((q) => [q, q] as [string, string]), ...(profiles.includes(x.profile) ? [] : [[x.profile, `${x.profile} (not allowed)`] as [string, string]])]);
					pt.setAttribute("maxlength", "300");
					pr.value = x.priority; mt.value = x.match; pt.value = x.pattern; pf.value = x.profile;
					const lab = el("label", li), on = el("input", lab);
					on.setAttribute("type", "checkbox");
					on.checked = x.enabled;
					el("span", lab, ` Rule ${i + 1} enabled`);
					for (const [f, k] of [[pr, "priority"], [mt, "match"], [pt, "pattern"], [pf, "profile"]] as const) f.addEventListener(k === "match" || k === "profile" ? "change" : "input", () => { x[k] = f.value; edited(); });
					on.addEventListener("change", () => { x.enabled = on.checked; edited(); });
					btn(el("p", li), "Remove", () => { rows.splice(i, 1); edited(); draw(); }, `Remove rule ${i + 1}`);
				});
				if (!rows.length) el("li", list, "No rules: every write without an explicit profile or a device default is refused.");
			};
			btn(tools, "Add a rule", () => { rows.push({ priority: String(Math.max(0, ...rows.map((x) => Number(x.priority) || 0)) + 10), match: "remote", pattern: "", profile: profiles[0] ?? "", enabled: true }); edited(); draw(); });
			btn(tools, "Preview", () => {
				const bad = invalid();
				if (bad.length) { sync(); say("Fix the list first."); msg.focus(); return; }
				previewed = true;
				shown.textContent = `Preview: the saved list becomes ${rows.length} rule${rows.length === 1 ? "" : "s"}, in this order: ${body().rules.map((x, i) => `${i + 1}. ${x.enabled ? "" : "(disabled) "}${x.match} “${x.pattern}” → ${x.profile} at priority ${x.priority}`).join("; ") || "none"}. It replaces every saved rule.`;
				sync();
				save.focus();
			});
			if (rulesDraft) btn(tools, "Discard changes and read the saved list", () => { rulesDraft = null; render(false); });
			draw();
			sync();
		})();
		return h;
	};

	am.pages.routing = routingPage;
	am.adminLink("Routing", "#/routing");
}
