// Audit tab (TG7): the activity log across profiles, newest first, with an actor filter and undo, and the archive of removals
// with restore (staged removals restore in steps). The tab opts in to the shared profile choice: #audit reads every active
// profile, #audit?profile=P only P (the shell refuses an unknown P before render), and &actor=A filters. The old #/activity/P
// route shows the same view for P.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node, Route } from "./am";

export function auditTab(am: Am): void {
	const { act, active, btn, call, choose, copy, curl, el, enc, facts, intro, link, note, pageStatus, recorded, undoOf, why } = am;
	// The server's write actors (src/api.ts activityQuery). Imports write as "migration"; the label says what the owner knows them as.
	const ACTORS: [string, string][] = [["", "All actors"], ["owner", "Owner"], ["agent", "Agent"], ["maintenance", "Maintenance"], ["migration", "Import"],
		["keep", "Keep"], ["index", "Index"], ["transfer", "Transfer"]];
	const ACTOR_CHIP: Record<string, string> = { owner: "c-blue", agent: "c-teal", maintenance: "c-amber", migration: "c-blue", transfer: "c-amber" };
	const actorName = (a: unknown) => a === "migration" ? "import" : recorded(a);
	const TARGETS_SHOWN = 5;
	const pendingOps = new Map<string, { id: string; cursor: string; label: string }>(); // per profile: a staged archive restore not finished

	const chip = (parent: Node, text: string, cls = "") => el("span", parent, text).setAttribute("class", `chip${cls ? ` ${cls}` : ""}`);
	const stamp = (iso: unknown) => typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? iso.replace("T", " ").slice(0, 19) : recorded(iso);
	const listOf = (parent: Node, label: string) => {
		const ul = el("ul", parent);
		ul.setAttribute("class", "prefs");
		ul.setAttribute("aria-label", label);
		ul.setAttribute("data-list", "");
		return ul;
	};
	/** The tab's own link, keeping the profile and actor choices in the query. */
	const hashOf = (profile: string | undefined, actor: string) => {
		const q = [profile ? `profile=${enc(profile)}` : "", actor ? `actor=${enc(actor)}` : ""].filter(Boolean).join("&");
		return `#audit${q ? `?${q}` : ""}`;
	};
	const row = (list: Node) => {
		const li = el("li", list);
		li.setAttribute("data-item", "");
		li.setAttribute("tabindex", "-1");
		return li;
	};

	/**
	 * Newest-first pages from several profiles, merged by time. Each profile keeps its own `before` cursor and a buffer of rows
	 * read but not shown. A round reads the next page of every profile whose buffer is empty, then shows only the rows no unread
	 * page can come before: rows at or after the newest of the oldest rows read from the profiles that have more. Reads go through
	 * am.eachProfile for `only` (null: every active profile); a profile whose read fails leaves the merge and the page names it.
	 */
	const merged = (only: string | null, profiles: string[], path: (p: string, before: number | null) => string) => {
		const st = profiles.map((p) => ({ p, buf: [] as J[], before: null as number | null, done: false, failed: null as unknown }));
		return {
			failed: () => st.filter((s) => s.failed !== null).map((s) => [s.p, s.failed] as [string, unknown]),
			more: () => st.some((s) => s.failed === null && (!s.done || s.buf.length > 0)),
			next: async (): Promise<[string, J][]> => {
				const due = (name: string) => st.find((s) => s.p === name && s.failed === null && !s.done && !s.buf.length);
				for (const res of await am.eachProfile(only, async (q) => {
					const s = due(q.name);
					if (!s) return null; // nothing to read for this profile this round
					const r = await call(path(s.p, s.before));
					if (!Array.isArray(r?.items)) throw new Error("the server sent no list");
					return r;
				})) {
					const s = st.find((x) => x.p === res.profile);
					if (!s) continue; // a profile that became active after this page was drawn
					if (!res.ok) { s.failed = res.error; s.buf = []; continue; }
					if (res.value === null) continue;
					s.buf.push(...res.value.items);
					s.before = Number.isSafeInteger(res.value.next_before) ? res.value.next_before : null;
					s.done = s.before === null;
				}
				const open = st.filter((s) => s.failed === null && !s.done && s.buf.length);
				const cutoff = open.length ? open.map((s) => String(s.buf.at(-1)?.at ?? "")).sort().at(-1)! : "";
				const out: [string, J][] = [];
				for (const s of st) {
					if (s.failed !== null) continue;
					let n = 0;
					while (n < s.buf.length && String(s.buf[n]?.at ?? "") >= cutoff) n++;
					for (const it of s.buf.splice(0, n)) out.push([s.p, it]);
				}
				// Stable: rows of one profile keep the server's order when their times tie.
				return out.map((x, i) => [x, i] as const).sort((a, b) => String(b[0][1]?.at ?? "").localeCompare(String(a[0][1]?.at ?? "")) || a[1] - b[1]).map(([x]) => x);
			},
		};
	};

	const audit = (view: Node, names: string[], actor: string, query: Record<string, string>, one?: string) => {
		const version = am.pageVersion, all = one === undefined;
		const h = el("h2", view, all ? "Audit" : `Audit: ${one}`);
		intro(view, "Audit", "activity", "Every change your agents, imports, the batch and you made, newest first. Undo reverses one; if its records changed again since, review them by hand.");
		const { say } = pageStatus(view);
		if (!names.length) { am.empty(view, "No active profile to read. Activity appears here once a profile is active and something writes to it."); return h; }
		note(view, all ? `Showing every active profile: ${names.join(", ")}.` : `Showing ${one}.`);
		if (query.actor !== undefined && !ACTORS.some(([v]) => v && v === query.actor)) note(view, `No actor named “${query.actor}”; showing every actor.`, "warn");

		// ---- Activity ----
		const logBox = el("section", view);
		logBox.setAttribute("class", "panel");
		logBox.setAttribute("aria-label", "Activity");
		const head = el("h3", logBox, "Activity");
		am.help(head, "undo");
		const tools = el("div", logBox);
		tools.setAttribute("class", "toolbar");
		const pick = choose(tools, "audit-actor", "Actor", ACTORS);
		pick.value = actor;
		am.help(tools, "actor");
		pick.addEventListener("change", () => { am.win.location.hash = hashOf(one, pick.value); });
		const listPath = (p: string, before: number | null) => `/api/profiles/${enc(p)}/activity?limit=50${before ? `&before=${before}` : ""}${actor ? `&actor=${enc(actor)}` : ""}`;
		if (one !== undefined) { copy(tools, "Copy curl", () => curl("GET", listPath(one, null))); am.help(tools, "curl"); }
		const logFailed = el("div", logBox), log = listOf(logBox, "Activity"), wait = am.loading(logBox, 4);
		const moreLog = btn(logBox, "Older activity", () => loadLog());
		moreLog.hidden = true;
		const logFeed = merged(one ?? null, names, listPath);
		let shownLog = 0;
		const activityRow = (p: string, it: J) => {
			const li = row(log), base = `/api/profiles/${enc(p)}`, summary = String(it.summary ?? "");
			const top = el("p", li);
			chip(top, recorded(it.op));
			chip(top, actorName(it.actor), ACTOR_CHIP[String(it.actor)] ?? "");
			if (all) chip(top, p);
			el("span", top, ` ${stamp(it.at)}`).setAttribute("class", "mono muted");
			el("span", top, ` · change ${recorded(it.id)}`).setAttribute("class", "mono muted");
			if (it.redacted) note(li, "Its summary was removed by a wipe.");
			else el("p", li, recorded(summary));
			const ids: string[] = Array.isArray(it.targets) ? it.targets.map(String) : [];
			if (ids.length && !it.redacted) {
				const t = el("p", li, ids.length === 1 ? "Record: " : "Records: ");
				ids.slice(0, TARGETS_SHOWN).forEach((id, i) => {
					if (i) el("span", t, ", ");
					// Targets are record ids, except "e:<id>" links (knowledge writes) and records a purge already deleted: those stay text.
					if (id.startsWith("e:") || it.op === "purge") el("span", t, id).setAttribute("class", "mono");
					else link(t, `#memories/${enc(id)}?profile=${enc(p)}`, id);
				});
				if (ids.length > TARGETS_SHOWN) el("span", t, ` and ${ids.length - TARGETS_SHOWN} more`);
			} else if (ids.length) note(li, `${ids.length} record(s).`);
			const meta = [it.device_id ? `On device ${String(it.device_id)}.` : "", Number.isSafeInteger(it.undo_of) ? `Undoes change ${it.undo_of}.` : "",
				it.undo === "undone" ? `Undone${Number.isSafeInteger(it.undone_by) ? ` by change ${it.undone_by}` : ""}.` : it.undo === "redacted" ? "Undo removed by a wipe." : it.undo === "available" ? "" : "No undo."].filter(Boolean).join(" ");
			if (meta) note(li, meta);
			if (it.undo !== "available") return;
			const cut = summary.slice(0, 80);
			// A conflict (the records changed again since) is an answer, not a failure: the owner reviews those records by hand.
			btn(li, "Undo", () => act(() => call(`${base}/activity/${enc(String(it.id))}/undo`, "POST").catch((e: Failure) =>
				e.status === 409 || e.code === "revision_conflict" ? { conflict: true } : Promise.reject(e)), `undo “${cut}”`, undefined,
			(r) => r?.conflict ? { text: `Changed since. Review by hand: the records of “${cut}” in ${p} changed after it, so nothing was undone.` } : { text: `Undone: “${cut}” in ${p}.` }),
			`Undo ${cut}`);
		};
		const loadLog = async () => {
			moreLog.disabled = true;
			const items = await logFeed.next();
			if (version !== am.pageVersion) return;
			wait.hidden = true;
			for (const [p, it] of items) activityRow(p, it);
			shownLog += items.length;
			logFailed.replaceChildren();
			for (const [p, err] of logFeed.failed()) note(logFailed, `Could not read the activity of ${p}: ${why(err)}. It is left out of this list; reload the tab to try again.`, "warn");
			if (!shownLog && !logFeed.more()) {
				if (!logFeed.failed().length) el("li", log, actor ? `No changes by ${actorName(actor)} yet.` : "No activity yet. Every write by an agent, an import, the batch or you is listed here.");
			}
			moreLog.hidden = !logFeed.more();
			moreLog.disabled = false;
		};

		// ---- Archive ----
		const archBox = el("section", view);
		archBox.setAttribute("class", "panel");
		archBox.setAttribute("aria-label", "Archive");
		el("h3", archBox, "Archive");
		note(archBox, "Forgotten and cleaned-up records wait here until they purge. Restore brings one back as a new change you can undo.");
		const stepped = (p: string, label: string) => (r: J): { text: string; undo?: string } => {
			if (r.state === "running" || r.state === "rolling_back") {
				pendingOps.set(p, { id: String(r.operation_id), cursor: String(r.cursor), label });
				return { text: `Restoring “${label}” in ${p} in steps: ${recorded(r.state)}, ${recorded(r.rows_done)} rows so far. Choose Continue to run the next step.` };
			}
			pendingOps.delete(p);
			return { text: `Restore of “${label}” in ${p} ${recorded(r.state)}.`, ...(r.state === "complete" ? { undo: undoOf(p, r) } : {}) };
		};
		for (const p of names) {
			const op = pendingOps.get(p);
			if (!op) continue;
			const base = `/api/profiles/${enc(p)}`, line = el("div", archBox);
			line.setAttribute("class", "warn");
			el("p", line, `A staged restore of “${op.label}” in ${p} is not finished.`);
			const r = el("p", line);
			btn(r, "Continue", () => act(`${base}/archive/operations/${enc(op.id)}/resume`, `continue restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(p, op.label)),
				`Continue restoring ${op.label} in ${p}`);
			btn(r, "Abort it", () => act(`${base}/archive/operations/${enc(op.id)}/abort`, `abort restoring “${op.label}”`, { cursor: op.cursor, request_id: `dashboard:${crypto.randomUUID()}` }, stepped(p, op.label)),
				`Abort restoring ${op.label} in ${p}`);
		}
		const archFailed = el("div", archBox), arch = listOf(archBox, "Archive"), archWait = am.loading(archBox, 2);
		const moreArch = btn(archBox, "Older removals", () => loadArch());
		moreArch.hidden = true;
		const archFeed = merged(one ?? null, names, (p, before) => `/api/profiles/${enc(p)}/archive?limit=20${before ? `&before=${before}` : ""}`);
		let shownArch = 0;
		const archiveRow = (p: string, it: J) => {
			const li = row(arch), base = `/api/profiles/${enc(p)}`, names0 = (Array.isArray(it.nodes) ? it.nodes : []).map((n: J) => String(n.name || n.id));
			const label = names0[0] ?? String(it.summary ?? "removal");
			const top = el("p", li);
			if (all) chip(top, p);
			el("strong", top, recorded(it.summary));
			facts(li, [["Removed", recorded(it.at)], ["By", actorName(it.actor)], ["Purges after", recorded(it.purge_after)], ["Records", names0.join(", ") || "none listed"]]);
			// A removal made by a staged forget restores only through the staged route, in steps.
			if (it.restorable) btn(li, "Restore", () => act(() => call(`${base}/archive/restore`, "POST", { activity_id: it.activity_id }).catch((e: Failure) => e.reason !== "staged_required" ? Promise.reject(e)
				: call(`${base}/archive/operations`, "POST", { action: "restore", activity_id: it.activity_id, request_id: `dashboard:${crypto.randomUUID()}` })), `restore “${label}”`, undefined,
			(res) => res.operation_id ? stepped(p, label)(res) : { text: `Restored “${label}” in ${p}.`, undo: undoOf(p, res) }), `Restore ${label}`);
			else note(li, it.reason === "undo_redacted" ? "Cannot be restored: a wipe removed what it needs." : "Cannot be restored: part of it has purged.");
		};
		const loadArch = async () => {
			moreArch.disabled = true;
			const items = await archFeed.next();
			if (version !== am.pageVersion) return;
			archWait.hidden = true;
			for (const [p, it] of items) archiveRow(p, it);
			shownArch += items.length;
			archFailed.replaceChildren();
			for (const [p, err] of archFeed.failed()) note(archFailed, `Could not read the archive of ${p}: ${why(err)}. It is left out of this list; reload the tab to try again.`, "warn");
			if (!shownArch && !archFeed.more() && !archFeed.failed().length) el("li", arch, "The archive is empty.");
			moreArch.hidden = !archFeed.more();
			moreArch.disabled = false;
		};
		if (one !== undefined) link(el("p", view), `#/profiles/${enc(one)}`, `Profile ${one} in Admin`);
		say("");
		void loadLog();
		void loadArch();
		return h;
	};

	// The old #/activity and #/activity/P routes (through am.legacy): the same view for one profile.
	am.pages.activity = (view, p) => audit(view, [String(p.name)], "", {}, String(p.name));
	// The shell's profile gate has already refused an unknown or inactive ?profile, so `named` is absent or active.
	am.tab({ id: "audit", group: "system", label: "Audit", key: "u", profiles: "any", render: (root, route: Route) => {
		const named = route.query.profile, actor = ACTORS.some(([v]) => v && v === route.query.actor) ? route.query.actor! : "";
		return named === undefined ? audit(root, active().map((p) => p.name), actor, route.query) : audit(root, [named], actor, route.query, named);
	} });
}
