// Admin: the path finder (#/path/NAME/ID).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function pathPages(am: Am): void {
	const { call, choose, el, enc, input, intro, link, note, pageStatus, recorded, switcher, why } = am;

	// Path finder: up to 3 paths of at most 4 links between two records this profile shows, as the server searched them. Names
	// come only from its answer: a record in another profile shows as such, never looked up here.
	const endpointText = (e: J) => e?.name ? `${recorded(e.kind)}: ${String(e.name)}` : e?.readable === false ? "a record not readable here" : "a record in another profile, not read";
	const endpointView = (parent: Node, p: Profile, e: J) => {
		if (e?.name && (e.profile === undefined || e.profile === p.name)) link(parent, `#/memory/${enc(p.name)}/${enc(String(e.id))}`, endpointText(e));
		else el("span", parent, endpointText(e));
	};
	const pathPage = (view: Node, p: Profile, fromId?: string) => {
		const version = am.pageVersion, h = el("h2", view, `Path finder: ${p.name}`);
		intro(view, "Paths", "paths", "Up to 3 chains of at most 4 links between two records, as the server searched them.");
		switcher(view, "path", p.name);
		note(view, "Both records must be shown in this profile. Copy a record's id from its page, or open a record and choose “Find a path from here”.");
		const form = el("form", view);
		form.setAttribute("class", "panel");
		const from = input(form, "path-from", "From record id");
		from.setAttribute("maxlength", "128");
		from.value = fromId ?? "";
		const to = input(form, "path-to", "To record id");
		to.setAttribute("maxlength", "128");
		const depth = choose(form, "path-depth", "Longest path", [["4", "4 links"], ["3", "3 links"], ["2", "2 links"]]);
		el("button", el("p", form), "Find paths").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const out = el("section", view);
		out.setAttribute("aria-label", "Paths found");
		out.setAttribute("class", "panel");
		out.hidden = true;
		let request = 0;
		const invalidate = () => { request++; out.replaceChildren(); out.hidden = true; };
		for (const f of [from, to, depth]) f.addEventListener("input", invalidate);
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			invalidate();
			const id = request, a = from.value.trim(), b = to.value.trim();
			if (!a || !b) { say("Enter both record ids."); msg.focus(); return; }
			say("Searching…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/path?from=${enc(a)}&to=${enc(b)}&max_depth=${depth.value}`);
				if (!Array.isArray(r?.paths)) throw new Error("the server sent no paths");
			} catch (err) {
				if (version === am.pageVersion && id === request) { say(`Could not find paths: ${why(err)}`); msg.focus(); }
				return;
			}
			if (version !== am.pageVersion || id !== request) return;
			out.hidden = false;
			const ends = el("p", out);
			el("span", ends, "From ");
			endpointView(ends, p, r.from);
			el("span", ends, " to ");
			endpointView(ends, p, r.to);
			if (r.budget?.exhausted) note(out, "The search stopped at its read budget; a longer or unread path may exist.", "warn");
			if (!r.paths.length) say(`No path of at most ${recorded(r.max_depth ?? depth.value)} links was found.`);
			else say(`${r.paths.length} path${r.paths.length === 1 ? "" : "s"} found.`);
			r.paths.forEach((path: J, i: number) => {
				el("h3", out, `Path ${i + 1}: ${recorded(path.length)} link${path.length === 1 ? "" : "s"}`);
				const ol = el("ol", out);
				for (const e of path.edges ?? []) {
					const li = el("li", ol);
					endpointView(li, p, e.from);
					el("span", li, ` — ${recorded(e.rel)}${e.other_label ? ` (${String(e.other_label)})` : ""} → `);
					endpointView(li, p, e.to);
					if (e.reason) el("p", li, String(e.reason));
				}
			});
			msg.focus();
		});
		return h;
	};
	am.pages.path = pathPage;
}
