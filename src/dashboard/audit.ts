// Audit: today's #/activity log with undo and the archive, moved here unchanged. The Audit tab ticket registers its tab here.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node, Profile } from "./am";

export function auditTab(am: Am): void {
	const { act, btn, call, el, enc, facts, note, pageStatus, recorded, switcher, undoOf, why } = am;
	// Activity: the log with each change's undo state, and the archive with restore (staged removals restore in steps).
	const activityPage = (view: Node, p: Profile) => {
		const version = am.pageVersion, base = `/api/profiles/${enc(p.name)}`, h = el("h2", view, `Activity: ${p.name}`);
		switcher(view, "activity", p.name);
		const { say } = pageStatus(view);
		const log = el("ul", view);
		log.setAttribute("class", "prefs");
		log.setAttribute("aria-label", "Activity");
		const moreLog = btn(view, "Older activity", () => loadLog());
		moreLog.hidden = true;
		el("h3", view, "Archive");
		note(view, "Forgotten and cleaned-up records wait here until they purge. Restore brings one back as a new change you can undo.");
		const arch = el("ul", view);
		arch.setAttribute("class", "prefs");
		arch.setAttribute("aria-label", "Archive");
		const moreArch = btn(view, "Older removals", () => loadArch());
		moreArch.hidden = true;
		let before: number | null = null, archBefore: number | null = null;
		const loadLog = async () => {
			moreLog.disabled = true;
			let r: J;
			try { r = await call(`${base}/activity?limit=50${before ? `&before=${before}` : ""}`); if (!Array.isArray(r?.items)) throw new Error("the server sent no activity"); }
			catch (err) { if (version === am.pageVersion) { say(`Could not load activity: ${why(err)}`); moreLog.disabled = false; } return; }
			if (version !== am.pageVersion) return;
			for (const it of r.items) {
				const li = el("li", log);
				el("strong", li, `${recorded(it.op)} by ${recorded(it.actor)}`);
				el("span", li, ` · ${recorded(it.at)}`);
				el("p", li, recorded(it.summary));
				const undo = it.undo === "available" ? "can be undone" : it.undo === "undone" ? "undone" : it.undo === "redacted" ? "undo removed by a wipe" : "no undo";
				el("p", li, `${Array.isArray(it.targets) ? it.targets.length : 0} record(s); ${undo}.`).setAttribute("class", "na");
				if (it.undo === "available") btn(li, "Undo", () => act(`${base}/activity/${it.id}/undo`, `undo “${String(it.summary).slice(0, 80)}”`, undefined, () => ({ text: "Undone." })), `Undo ${String(it.summary).slice(0, 80)}`);
			}
			if (!r.items.length && !before) el("li", log, "No activity yet.");
			before = r.next_before ?? null;
			moreLog.hidden = before === null;
			moreLog.disabled = false;
		};
		const stepped = (label: string) => (r: J): { text: string; undo?: string } => {
			if (r.state === "running" || r.state === "rolling_back") {
				pendingOps.set(p.name, { id: String(r.operation_id), cursor: String(r.cursor), label });
				return { text: `Restoring “${label}” in steps: ${recorded(r.state)}, ${recorded(r.rows_done)} rows so far. Choose Continue to run the next step.` };
			}
			pendingOps.delete(p.name);
			return { text: `Restore of “${label}” ${recorded(r.state)}.`, ...(r.state === "complete" ? { undo: undoOf(p.name, r) } : {}) };
		};
		const op = pendingOps.get(p.name);
		if (op) {
			const row = el("p", view);
			el("span", row, `A staged restore of “${op.label}” is not finished. `);
			btn(row, "Continue", () => act(`${base}/archive/operations/${enc(op.id)}/resume`, `continue restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(op.label)));
			btn(row, "Abort it", () => act(`${base}/archive/operations/${enc(op.id)}/abort`, `abort restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(op.label)));
		}
		const loadArch = async () => {
			moreArch.disabled = true;
			let r: J;
			try { r = await call(`${base}/archive?limit=20${archBefore ? `&before=${archBefore}` : ""}`); if (!Array.isArray(r?.items)) throw new Error("the server sent no archive"); }
			catch (err) { if (version === am.pageVersion) { say(`Could not load the archive: ${why(err)}`); moreArch.disabled = false; } return; }
			if (version !== am.pageVersion) return;
			for (const it of r.items) {
				const li = el("li", arch), names = (it.nodes ?? []).map((n: J) => String(n.name || n.id)), label = names[0] ?? String(it.summary ?? "removal");
				el("strong", li, recorded(it.summary));
				facts(li, [["Removed", recorded(it.at)], ["By", recorded(it.actor)], ["Purges after", recorded(it.purge_after)], ["Records", names.join(", ") || "none listed"]]);
				// A removal made by a staged forget restores only through the staged route, in steps.
				if (it.restorable) btn(li, "Restore", () => act(() => call(`${base}/archive/restore`, "POST", { activity_id: it.activity_id }).catch((e: Failure) => e.reason !== "staged_required" ? Promise.reject(e)
					: call(`${base}/archive/operations`, "POST", { action: "restore", activity_id: it.activity_id, request_id: `dashboard:${crypto.randomUUID()}` })), `restore “${label}”`, undefined,
				(res) => res.operation_id ? stepped(label)(res) : { text: `Restored “${label}”.`, undo: undoOf(p.name, res) }), `Restore ${label}`);
				else note(li, it.reason === "undo_redacted" ? "Cannot be restored: a wipe removed what it needs." : "Cannot be restored: part of it has purged.");
			}
			if (!r.items.length && !archBefore) el("li", arch, "The archive is empty.");
			archBefore = r.next_before ?? null;
			moreArch.hidden = archBefore === null;
			moreArch.disabled = false;
		};
		say("");
		loadLog();
		loadArch();
		return h;
	};
	const pendingOps = new Map<string, { id: string; cursor: string; label: string }>(); // staged archive restores not finished
	am.pages.activity = activityPage;
}
