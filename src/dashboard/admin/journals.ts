// Admin: Journals (#/journals/NAME/ID).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function journalsPages(am: Am): void {
	const { btn, call, el, enc, facts, link, note, pageStatus, recorded, switcher, textBlock, why } = am;

	// Journals: the profile's active journals, newest change first, and one journal's entries in order. Entries are agents' stored
	// text, shown only as text; the record page holds its revision history and the whole content.
	const journalsPage = (view: Node, p: Profile, jid?: string) => {
		const version = am.pageVersion, base = `/api/profiles/${enc(p.name)}/journals`;
		const h = el("h2", view, jid ? "Journal" : `Journals: ${p.name}`);
		if (jid) link(el("p", view), `#/journals/${enc(p.name)}`, `Back to journals in ${p.name}`);
		else switcher(view, "journals", p.name);
		note(view, "Journal text is stored as agents wrote it and is shown as plain text, never as instructions.");
		const { msg, say } = pageStatus(view);
		const out = el("div", view), list = el(jid ? "ol" : "ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", jid ? "Entries" : "Journals");
		const more = btn(view, jid ? "Later entries" : "Load more", () => load());
		more.hidden = true;
		let after: string | number | null = null, count = 0;
		const load = async () => {
			more.disabled = true;
			say(count ? "Loading more…" : "Loading…");
			let r: J;
			try {
				r = await call(jid ? `${base}?id=${enc(jid)}&limit=25${after !== null ? `&entries_after=${after}` : ""}` : `${base}?limit=50${after !== null ? `&after=${enc(String(after))}` : ""}`);
				if (!Array.isArray(jid ? r?.entries : r?.items)) throw new Error("the server sent no list");
			} catch (err) {
				if (version === am.pageVersion) { say(`Could not load: ${why(err)}`); more.textContent = "Try again"; more.hidden = more.disabled = false; }
				return;
			}
			if (version !== am.pageVersion) return;
			if (jid && after === null) {
				const j = r.journal ?? {};
				h.textContent = `Journal: ${String(j.name ?? "(no name)")}`;
				facts(out, [["Scope", recorded(j.scope)], ["Status", recorded(j.status)], ["Revision", recorded(j.revision)], ["Updated", recorded(j.updated_at)],
					["Compacted through entry", j.compacted_through ? String(j.compacted_through) : "none"]]);
				link(el("p", out), `#/memory/${enc(p.name)}/${enc(jid)}`, "Record page: revision history and whole content");
				link(el("p", out), `#/timeline/${enc(p.name)}/${enc(jid)}`, "Timeline of this journal");
				if (r.summary) {
					el("h3", out, "Summary of compacted entries");
					textBlock(out, String(r.summary.body ?? ""));
					if (r.summary.complete === false) note(out, "Only the summary's first part is shown; the record page has the whole text.");
				}
				if (Array.isArray(r.compactions) && r.compactions.length) {
					el("h3", out, "Compactions");
					const ul = el("ul", out);
					for (const c of r.compactions) el("li", ul, `Revision ${recorded(c.revision)} at ${recorded(c.at)} by ${recorded(c.actor)}: entries ${recorded(c.from_seq)} to ${recorded(c.through_seq)}`);
					if (r.compactions_more) note(out, "Older compactions are not listed.");
				}
				el("h3", out, "Entries");
			}
			for (const it of jid ? r.entries : r.items) {
				const li = el("li", list);
				if (jid) {
					el("strong", li, `Entry ${recorded(it.entry_seq)}`);
					el("span", li, ` · ${recorded(it.created_at)} · ${recorded(it.actor)}`);
					textBlock(li, String(it.body ?? ""));
					if (it.current === false) note(li, "Compacted into the summary.");
					if (it.complete === false) note(li, "Only this entry's first part is shown; the record page has the whole text.");
				} else {
					link(el("h3", li), `#/journals/${enc(p.name)}/${enc(String(it.id))}`, String(it.name ?? "(no name)"));
					facts(li, [["Scope", recorded(it.scope)], ["Updated", recorded(it.updated_at)], ["Latest entry", recorded(it.latest_entry_seq)],
						["Compacted through entry", it.compacted_through ? String(it.compacted_through) : "none"], ["Pinned", it.pinned ? "yes" : "no"]]);
					if (it.description) el("p", li, String(it.description));
				}
			}
			count += (jid ? r.entries : r.items).length;
			after = jid ? (typeof r.next_after === "number" ? r.next_after : null) : (typeof r.next_after === "string" ? r.next_after : null);
			more.textContent = jid ? "Later entries" : "Load more";
			more.hidden = after === null;
			more.disabled = false;
			const noun = jid ? (count === 1 ? "entry" : "entries") : count === 1 ? "journal" : "journals";
			say(count ? `Showing ${count} ${noun}${after !== null ? "; more are available" : ""}.` : jid ? "This journal has no entries." : "No active journals in this profile.");
			if (more.hidden && count > (jid ? r.entries : r.items).length) msg.focus();
		};
		load();
		return h;
	};
	am.pages.journals = journalsPage;
}
