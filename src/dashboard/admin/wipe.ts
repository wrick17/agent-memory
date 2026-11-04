// Admin: Wipe (#/wipe/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node } from "../am";

export function wipePages(am: Am): void {
	const { act, btn, call, el, enc, facts, input, link, live, note, pageStatus, recorded, render, why, win } = am;

	// The wipe preview (section 9) for an active profile: every other profile the wipe reads, both parts, page by page from the
	// server's read-only preview, before the confirmation is offered. A failed page stops the walk; reading again is explicit and
	// resumes from the last page read (or starts over if a profile changed). Names are text; it is not a snapshot.
	const PREVIEW_HEAD: Record<string, string> = { purge: "Removed from", survive: "Survives in", decided_at_wipe: "Decided when the wipe runs, in", kept_listed: "Stays, but mentions this profile's work terms, in" };
	const wipePreviewView = (parent: Node, name: string, version: number, done: () => void) => {
		const sec = el("section", parent);
		sec.setAttribute("aria-label", "Preview of the wipe outside this profile");
		el("h3", sec, `Before you confirm: what happens outside ${name}`);
		note(sec, "Read now, page by page; it is not a snapshot. Records written, moved or archived after this preview are decided by the same rules when the wipe runs.");
		note(sec, "A preference that survives in me is one you accepted as free of company details. One marked as decided when the wipe runs has archived history the wipe checks only then. Records that stay but mention this profile's terms are listed for you to review; the wipe does not change them.");
		const line = live(sec), out = el("div", sec);
		const retry = btn(sec, "Read the preview again", () => { retry.hidden = true; walk(); });
		retry.hidden = true;
		const counts: { [verdict: string]: number; purge: number; survive: number; decided_at_wipe: number; kept_listed: number } = { purge: 0, survive: 0, decided_at_wipe: 0, kept_listed: 0 };
		let targets: string[] | null = null, ti = 0, part: "purge" | "handwritten" = "purge", after: string | null = null, restart = false;
		const lists = new Map<string, Node>();
		const listFor = (target: string, verdict: string) => {
			const key = `${target}:${verdict}`;
			let ul = lists.get(key);
			if (!ul) { el("h4", out, `${PREVIEW_HEAD[verdict] ?? verdict} ${target}`); ul = el("ul", out); lists.set(key, ul); }
			return ul;
		};
		const reset = () => { targets = null; ti = 0; part = "purge"; after = null; out.replaceChildren(); lists.clear(); for (const k of Object.keys(counts)) counts[k] = 0; };
		const walk = async () => {
			if (restart) { reset(); restart = false; }
			try {
				if (!targets) { const r: J = await call(`/api/profiles/${enc(name)}/wipe/preview`); if (!Array.isArray(r?.targets)) throw new Error("the server sent no profiles"); targets = r.targets.map(String); }
				while (ti < targets!.length) {
					if (version !== am.pageVersion) return;
					const t = targets![ti]!;
					line.textContent = `Reading ${t}… ${counts.purge} to remove so far.`;
					const r: J = await call(`/api/profiles/${enc(name)}/wipe/preview?target=${enc(t)}&part=${part}${after ? `&after=${enc(after)}` : ""}`);
					if (version !== am.pageVersion) return;
					if (!Array.isArray(r?.items)) throw new Error("the server sent no page");
					for (const it of r.items) {
						const verdict = String(it.verdict);
						counts[verdict] = (counts[verdict] ?? 0) + 1;
						const li = el("li", listFor(t, verdict)), label = `${recorded(it.kind)}${it.other_label ? ` (${String(it.other_label)})` : ""}: ${it.name ? String(it.name) : "name not readable before the wipe"}`;
						if (it.where === "live" && it.status === "active") link(li, `#/memory/${enc(t)}/${enc(String(it.id))}`, label); else el("span", li, label);
						el("span", li, ` · ${it.where === "tombstone" ? "moved-away marker" : it.where === "archive" ? "archived" : it.where === "staged" ? "being archived" : recorded(it.status)}`);
						// A record that will be removed can be re-saved first; one not readable now cannot be copied from here.
						if (verdict === "purge" && it.where === "live" && it.status === "active") btn(li, "Save a copy", () => { am.copyBack.set(`${t}:${String(it.id)}`, name); win.location.hash = `#/copy/${enc(t)}/${enc(String(it.id))}`; }, `Save a copy of ${String(it.name ?? it.id)}`);
						else if (verdict === "purge") el("span", li, " · cannot be copied before the wipe (not readable now; restore it from the archive first if it is archived)");
					}
					after = typeof r.next === "string" ? r.next : null;
					if (!after) { if (part === "purge") part = "handwritten"; else { part = "purge"; ti++; } }
					await new Promise((x) => setTimeout(x, 0)); // let the page breathe between requests
				}
			} catch (err) {
				if (version !== am.pageVersion) return;
				restart = (err as Failure).reason === "stale_cursor";
				line.textContent = `The preview stopped: ${why(err)}. The confirmation stays off until the preview is complete.`;
				retry.hidden = false;
				return;
			}
			if (version !== am.pageVersion) return;
			const total = counts.purge + counts.survive + counts.decided_at_wipe + counts.kept_listed;
			line.textContent = total ? `Preview complete: ${counts.purge} records will be removed from other profiles, ${counts.survive} survive in me, ${counts.decided_at_wipe} are decided when the wipe runs, and ${counts.kept_listed} that mention this profile's terms stay for your review.`
				: `Preview complete: nothing outside ${name} is removed, kept or flagged.`;
			done();
		};
		walk();
	};

	// Wipe (section 9): one profile chosen explicitly, its consequences stated before anything is typed, the exact name typed, then
	// one click. Every request names the profile version this page shows, so a stale page cannot wipe a profile restored since.
	// The engine's own begin resumes an unfinished wipe and never starts a second one, so Continue is the same request.
	const wipePage = (view: Node, name: string | undefined) => {
		const version = am.pageVersion;
		if (name === undefined) {
			const h = el("h2", view, "Wipe a profile");
			el("p", view, "Choose the profile to wipe. Nothing happens until you confirm on its page.");
			const ul = el("ul", view);
			for (const q of am.profiles) link(el("li", ul), `#/wipe/${enc(q.name)}`, `${q.name} (${q.status})`);
			return h;
		}
		const base = `/api/profiles/${enc(name)}/wipe`, h = el("h2", view, `Wipe profile: ${name}`);
		link(el("p", view), "#/wipe", "Choose another profile");
		const { msg, say } = pageStatus(view);
		const body = el("div", view);
		say("Reading the profile's state…");
		(async () => {
			let s: J;
			try { s = await call(base); if (typeof s?.status !== "string") throw new Error("the server sent no state"); } catch (err) {
				if (version === am.pageVersion) { say(`Could not read the profile's state: ${why(err)}`); btn(body, "Read the state again", () => render(false)); }
				return;
			}
			if (version !== am.pageVersion) return;
			say("");
			const known = am.profiles.find((q) => q.name === name);
			if (known) known.status = s.status; // keep the other pages' profile lists honest after a wipe
			const w = s.wipe;
			const unfinished = s.status === "wiping" || Boolean(w && w.state !== "done");
			facts(body, [["State", unfinished ? "Wipe unfinished" : s.status === "active" ? "Active" : s.status === "wiped" ? "Wiped" : String(s.status)],
				["Profile version", String(s.generation)], ...(w ? [["Wipe started", recorded(w.started_at)], ["Wipe step", w.state === "done" ? "Finished" : w.state === "backups" ? "Replacing backups" : "Removing content"],
					...(typeof w.purged === "number" ? [["Records removed", String(w.purged)]] : []), ...(typeof w.redacted === "number" ? [["Activity entries cleared", String(w.redacted)]] : [])] as [string, string][] : [])]);
			btn(el("p", body), "Read the state again", () => render(false));
			if (s.status === "wiped" && w?.state === "done") { el("p", body, "This profile is wiped. Nothing more can be done here."); return; }
			const warn = el("div", body);
			warn.setAttribute("class", "danger");
			el("h3", warn, unfinished ? "This wipe has not finished" : "What wiping does");
			const ul = el("ul", warn);
			for (const t of [
				`Everything ${name} holds is removed from the service: its memories, their history, journals, links and work records, in every stored version of the profile.`,
				"Copies of its records in other profiles are removed, except accepted company-free preferences in me. Links to removed copies stay only as unreadable references.",
				"Other profiles' own hand-written references remain and need manual review.",
				"Devices lose access to it, and its routing rules stop sending anything to it.",
				`Its backups are deleted and every other profile's backup is replaced with a clean one, so no backup can bring ${name} back.`,
				"Request ids it used stay refused, and only a content-free record that the wipe happened is kept.",
				"It cannot be undone.",
			]) el("li", ul, t);
			if (unfinished) el("p", warn, "A wipe of this profile started and did not finish, so the profile is already closed. Continue runs the same wipe from where it stopped; it never starts a second one.");
			else if (s.status !== "active") { el("p", warn, "This profile cannot be wiped in its current state."); return; }
			// An active profile's confirmation waits for the whole preview; an unfinished wipe continues without one.
			let previewed = unfinished;
			if (!unfinished) wipePreviewView(body, name, version, () => { previewed = true; gate(); });
			const form = el("form", body);
			const typed = input(form, "wipe-typed", `Type ${name} to confirm`);
			typed.setAttribute("autocomplete", "off");
			typed.setAttribute("spellcheck", "false");
			const go = el("button", el("p", form), unfinished ? `Continue wiping ${name}` : `Wipe ${name}`);
			go.setAttribute("type", "submit");
			go.disabled = true;
			am.pageButtons.push(go);
			const wait = el("p", form, "The confirmation opens once the preview above is complete.");
			wait.setAttribute("class", "na");
			wait.hidden = previewed;
			const gate = () => { go.disabled = typed.value !== name || !previewed; wait.hidden = previewed; };
			typed.addEventListener("input", gate);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				if (typed.value !== name || !previewed) return;
				say(`Wiping ${name}. This can take a while; keep this page open.`);
				msg.focus();
				act(base, `wipe ${name}`, { typed: name, generation: String(s.generation) }, (r) => ({
					text: JSON.parse(String(r?.report ?? "{}")).state === "done" ? `${name} is wiped.` : `The wipe of ${name} stopped before finishing; read its state and choose Continue.` }));
			});
		})();
		return h;
	};
	am.pages.wipe = wipePage;
	am.adminLink("Wipe", "#/wipe");
}
