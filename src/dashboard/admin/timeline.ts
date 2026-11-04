// Admin: Timeline (#/timeline/NAME/ID).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node, Profile } from "../am";

export function timelinePages(am: Am): void {
	const { btn, call, el, enc, input, link, note, pageStatus, recorded, switcher, why } = am;

	// Timeline, journals and the path finder (section 15): read-only views over the owner page reads, nothing written.
	const DAY_MS = 86_400_000, TIMELINE_DAYS = 90;
	/** One timeline event as text: its date, what happened, and a link to the record when the server named it. */
	const eventItem = (parent: Node, p: Profile, e: J) => {
		const li = el("li", parent), kind = String(e.event ?? ""), [cls, op] = kind.split(":");
		el("strong", li, recorded(e.at));
		el("span", li, ` · ${cls === "activity" ? `Change: ${op} by ${recorded(e.actor)}` : cls === "revision" ? `Revision ${recorded(e.revision)}: ${op} by ${recorded(e.actor)}`
			: kind === "entry" ? `Journal entry ${recorded(e.entry_seq)} by ${recorded(e.actor)}` : kind === "link_recorded" || kind === "link_ended"
			? `Link ${recorded(e.rel)} ${kind === "link_ended" ? "ended" : "recorded"}` : kind || "Event"}`);
		if (e.redacted) note(li, "Its summary was removed by a wipe.");
		else if (e.summary) el("p", li, String(e.summary));
		if (e.node_id && e.name) link(el("p", li), `#/memory/${enc(p.name)}/${enc(String(e.node_id))}`, `${recorded(e.kind)}: ${String(e.name)}`);
		if (kind.startsWith("link_")) note(li, `From ${recorded(e.src)} to ${recorded(e.dst)}`);
		if (Array.isArray(e.targets) && e.targets.length) note(li, `${e.targets.length} record(s) changed`);
	};

	// Timeline: one explicit window of at most 90 days, the profile's changes or one record's, oldest first. The server has no
	// cursor: a cut window says so, and only a narrower window or the 500-event limit shows more.
	const timelinePage = (view: Node, p: Profile, nodeId?: string) => {
		const version = am.pageVersion, h = el("h2", view, `Timeline: ${p.name}`);
		switcher(view, "timeline", p.name);
		if (nodeId) {
			el("p", view, "Showing one record's revisions, entries and links.");
			link(el("p", view), `#/memory/${enc(p.name)}/${enc(nodeId)}`, "Open the record");
			link(el("p", view), `#/timeline/${enc(p.name)}`, "Show the whole profile instead");
		}
		note(view, `A window of at most ${TIMELINE_DAYS} days, ISO dates with Z or an offset; a date alone means midnight UTC. To is not included.`);
		const form = el("form", view), now = Date.now();
		const from = input(form, "tl-from", "From");
		from.value = new Date(now - 7 * DAY_MS).toISOString();
		const to = input(form, "tl-to", "To");
		to.value = new Date(now).toISOString();
		el("button", el("p", form), "Show timeline").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const out = el("section", view);
		out.setAttribute("aria-label", "Timeline events");
		const more = btn(view, "Show up to 500 events", () => load(500, true));
		more.hidden = true;
		let request = 0;
		const invalidate = () => { request++; out.replaceChildren(); more.hidden = true; };
		for (const f of [from, to]) f.addEventListener("input", () => { invalidate(); say("Window changed. Choose Show timeline to load it."); });
		const load = async (limit = 100, moveFocus = false) => {
			invalidate();
			const id = request, f = from.value.trim(), t = to.value.trim(), a = Date.parse(f), b = Date.parse(t);
			if (Number.isNaN(a) || Number.isNaN(b) || a >= b || b - a > TIMELINE_DAYS * DAY_MS) { say(`Choose From before To, at most ${TIMELINE_DAYS} days apart, as ISO dates.`); msg.focus(); return; }
			say("Loading the timeline…");
			let r: J;
			try {
				r = await call(`/api/profiles/${enc(p.name)}/timeline?from=${enc(f)}&to=${enc(t)}&limit=${limit}${nodeId ? `&node=${enc(nodeId)}` : ""}`);
				if (!Array.isArray(r?.events)) throw new Error("the server sent no events");
			} catch (err) {
				if (version === am.pageVersion && id === request) { say(`Could not load the timeline: ${why(err)}`); if (moveFocus) msg.focus(); }
				return;
			}
			if (version !== am.pageVersion || id !== request) return;
			if (nodeId && r.node?.name) h.textContent = `Timeline: ${String(r.node.name)}`;
			say(`${r.events.length} event${r.events.length === 1 ? "" : "s"} from ${f} to ${t}.`);
			if (r.truncated) note(out, nodeId ? "Some of this record's events in this window are not shown; narrow the window." : "Only the earliest events of this window are shown; narrow the window to see later ones.", "warn");
			if (!r.events.length) note(out, "No events in this window.");
			const list = el("ol", out);
			list.setAttribute("class", "prefs");
			for (const e of r.events) eventItem(list, p, e);
			more.hidden = r.truncated !== true || limit === 500;
			if (moveFocus) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(100, true); });
		load();
		return h;
	};
	am.pages.timeline = timelinePage;
}
