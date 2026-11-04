// Admin: About you, the owner model (#/about/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, Node, Profile } from "../am";

export function aboutPages(am: Am): void {
	const { active, call, day, el, facts, render } = am;
	// About you (sections 12 and 15): one active profile's preferences from the owner-model read, in the server's order, one
	// bounded page per click. Every action waits for the server, shows its answer, then reloads; nothing is retried by itself.
	type Pref = { id: string; name: string; description: string; origin: string; pinned: boolean; flagged: string | null; updated_at: string;
		source_profile: string | null; evidence: { kind: string; ref: string; note: string | null }[]; evidence_truncated: boolean; evidence_missing: boolean };
	const busy = new Set<string>(); // profiles with an action in flight; their buttons stay disabled until it answers
	const notes = new Map<string, { text: string; undo: number | null }>(); // each profile's last outcome and its undo, kept across navigation

	const aboutPage = (view: Node, p: Profile) => {
		am.shown = p.name;
		const base = `/api/profiles/${encodeURIComponent(p.name)}`;
		const h = el("h2", view, `About you: ${p.name}`);
		const nav = el("nav", view);
		nav.setAttribute("aria-label", "Profile");
		for (const q of active()) {
			const a = el("a", nav, q.name);
			a.setAttribute("href", `#/about/${encodeURIComponent(q.name)}`);
			if (q.name === p.name) a.setAttribute("aria-current", "page");
		}
		el("p", view, "Preferences you stated come first, then ones agents inferred, with their evidence. Pin protects one from background cleanup; Forget moves it to the archive, and Undo brings it back.");
		const msg = am.statusEl = el("p", view);
		msg.setAttribute("role", "status");
		msg.setAttribute("tabindex", "-1");
		const note = notes.get(p.name);
		const buttons: Node[] = [];
		const button = (parent: Node, text: string, label: string | null, onClick: () => void) => {
			const b = el("button", parent, text);
			b.setAttribute("type", "button");
			if (label) b.setAttribute("aria-label", label);
			b.disabled = busy.has(p.name);
			b.addEventListener("click", onClick);
			buttons.push(b);
			return b;
		};
		const act = async (path: string, what: string, done: (r: Record<string, unknown>) => { text: string; undo: number | null }) => {
			if (busy.has(p.name)) return;
			busy.add(p.name);
			for (const b of buttons) b.disabled = true;
			msg.textContent = `Working: ${what}…`;
			let out: { text: string; undo: number | null };
			try {
				out = done(await call(path, "POST"));
			} catch (err) {
				const e = err as Failure;
				out = { text: `Could not ${what}: ${e.status === 409 ? "it changed since; review it by hand" : e.message}${e.code ? ` (${e.code})` : ""}.`, undo: notes.get(p.name)?.undo ?? null };
			}
			busy.delete(p.name);
			notes.set(p.name, out);
			if (am.shown === p.name) { render(false); am.statusEl?.focus(); }
		};
		const undoBox = el("p", view);
		if (note?.undo) {
			const id = note.undo;
			button(undoBox, "Undo last change", null, () => act(`${base}/activity/${encodeURIComponent(String(id))}/undo`, "undo the last change",
				() => ({ text: "Undone.", undo: null })));
		}
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Preferences");
		const item = (it: Pref) => {
			const li = el("li", list), name = String(it.name || "(no name)");
			el("h3", li, name);
			if (it.description) el("p", li, String(it.description));
			facts(li, [
				["Origin", it.origin === "stated" ? "Stated" : it.origin === "inferred" ? "Inferred" : `Recorded as ${String(it.origin)}, not stated`],
				["Pinned", it.pinned ? "yes" : "no"],
				["Flagged", it.flagged ? String(it.flagged) : "no"],
				["Source profile", it.source_profile ? String(it.source_profile) : "this profile"],
				["Updated", day(it.updated_at)],
			]);
			const ev = Array.isArray(it.evidence) ? it.evidence : [];
			if (ev.length) {
				el("p", li, "Evidence:");
				const ul = el("ul", li);
				for (const e of ev) el("li", ul, `${String(e.kind)}: ${String(e.ref)}${e.note ? ` (${String(e.note)})` : ""}`);
			}
			if (it.evidence_missing) el("p", li, "No evidence is recorded for this inferred preference.").setAttribute("class", "na");
			else if (!ev.length) el("p", li, "No evidence pointers.").setAttribute("class", "na");
			if (it.evidence_truncated) el("p", li, `Showing the first ${ev.length} evidence pointers; more exist.`).setAttribute("class", "na");
			const row = el("p", li), node = `${base}/nodes/${encodeURIComponent(it.id)}`;
			const done = (r: Record<string, unknown>, extra = "") => ({ text: `Done: ${String(r.action)} “${name}”.${extra}`,
				undo: Number.isSafeInteger(r.activity_id) && (r.activity_id as number) > 0 ? r.activity_id as number : null });
			const actions = (): Node => {
				row.replaceChildren();
				const verb = it.pinned ? "unpin" : "pin";
				button(row, it.pinned ? "Unpin" : "Pin", `${it.pinned ? "Unpin" : "Pin"} ${name}`, () => act(`${node}/${verb}`, `${verb} “${name}”`, (r) => done(r)));
				if (it.flagged) button(row, "Unflag", `Unflag ${name}`, () => act(`${node}/unflag`, `unflag “${name}”`, (r) => done(r)));
				const forget = button(row, "Forget", `Forget ${name}`, () => {
					row.replaceChildren();
					const ask = el("span", row, `Forget “${name}”? It moves to the archive and leaves this list; Undo brings it back. `);
					ask.setAttribute("tabindex", "-1");
					button(row, "Forget it", `Forget ${name} now`, () => act(`${node}/forget`, `forget “${name}”`, (r) => done(r, " It is in the archive; Undo brings it back.")));
					button(row, "Cancel", null, () => actions().focus());
					ask.focus();
				});
				return forget;
			};
			actions();
		};
		const more = el("button", view, "Load more");
		more.setAttribute("type", "button");
		more.hidden = true;
		let after: string | null = null, count = 0;
		// Every render builds new elements, so a late page only fills nodes that have left the screen.
		const load = async () => {
			more.disabled = true;
			msg.textContent = [note?.text, after ? "Loading more preferences…" : "Loading preferences…"].filter(Boolean).join(" ");
			let page: { items: Pref[]; next_after: string | null };
			try {
				page = await call(`${base}/owner-model?limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`);
				if (!Array.isArray(page?.items)) throw new Error("the server sent no preference list");
			} catch (err) {
				msg.textContent = [note?.text, `Could not load preferences: ${(err as Error).message}`].filter(Boolean).join(" ");
				more.textContent = "Try again";
				more.hidden = more.disabled = false;
				return;
			}
			for (const it of page.items) item(it);
			count += page.items.length;
			after = typeof page.next_after === "string" ? page.next_after : null;
			more.textContent = "Load more";
			more.hidden = !after;
			more.disabled = false;
			msg.textContent = [note?.text, count ? `Showing ${count} preference${count === 1 ? "" : "s"}${after ? "; more are available" : ""}.`
				: "No active preferences in this profile yet."].filter(Boolean).join(" ");
			if (more.hidden && count > page.items.length) msg.focus(); // the pressed Load more just hid; keep focus on the page
		};
		more.addEventListener("click", load);
		load();
		return h;
	};
	am.pages.about = aboutPage;
}
