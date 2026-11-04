// Admin: Review (#/review/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Move, Node, Profile } from "../am";

export function reviewPages(am: Am): void {
	const { act, active, btn, call, choose, el, enc, facts, input, link, note, pageStatus, recorded, render, switcher, textBlock, undoOf, why } = am;

	// Review (section 15): this profile's captured suggestions through review_candidates, list then an explicit promote or dismiss.
	// Captures are untrusted evidence, shown only as text. Each action's exact request (with its request id) is kept until the server
	// confirms it, so retrying an unchanged action after a lost answer replays instead of acting twice; a changed one gets a new id.
	const reviewSent = new Map<string, Record<string, unknown>>(); // `${profile}:${capture}:${action}` -> last request sent
	const reviewPage = (view: Node, p: Profile) => {
		const version = am.pageVersion, base = `/api/profiles/${enc(p.name)}/review`, h = el("h2", view, `Review: ${p.name}`);
		switcher(view, "review", p.name);
		note(view, "Captured suggestions are untrusted evidence from agents and capture hooks. Nothing is promoted unless you choose Promote; captures never go to me.");
		const unresolved = [...reviewSent].filter(([key]) => key.startsWith(`${p.name}:`));
		if (unresolved.length) {
			const receipts = el("section", view);
			el("h3", receipts, "Unconfirmed reviews");
			note(receipts, "Retry sends the original request and request ID, even if the suggestion has left this list.");
			for (const [key, sent] of unresolved) {
				const receipt = el("p", receipts, `Suggestion ${String(sent.candidate_id)}: `);
				btn(receipt, `Retry ${String(sent.action)}`, () => act(base, `retry ${String(sent.action)}`, sent, (r) => {
					reviewSent.delete(key);
					return { text: sent.action === "promote" ? `Promoted into memory “${String(r.name ?? r.memory_id)}”.` : "Dismissed captured suggestion.", undo: undoOf(p.name, r) };
				}), `Retry ${String(sent.action)} for captured suggestion ${String(sent.candidate_id)}`);
			}
		}
		const form = el("form", view);
		const status = choose(form, "review-status", "Status", [["pending", "Pending"], ["promoted", "Promoted"], ["dismissed", "Dismissed"], ["all", "All"]]);
		const limit = choose(form, "review-limit", "Show at most", [["20", "20"], ["50", "50"], ["100", "100"]]);
		el("button", el("p", form), "Show").setAttribute("type", "submit");
		const { msg, say } = pageStatus(view);
		const list = el("ul", view);
		list.setAttribute("class", "prefs");
		list.setAttribute("aria-label", "Captured suggestions");
		let request = 0;
		const send = (key: string, body: Record<string, unknown>) => {
			const prior = reviewSent.get(key), strip = (x?: Record<string, unknown>) => { if (!x) return ""; const { request_id: _id, ...rest } = x; return JSON.stringify(rest); };
			const sent = { ...body, request_id: strip(prior) === JSON.stringify(body) ? prior!.request_id : `dashboard:${crypto.randomUUID()}` };
			reviewSent.set(key, sent);
			return sent;
		};
		const item = (c: J) => {
			const li = el("li", list), id = String(c.capture_id), name = String(c.name ?? "(no name)");
			el("h3", li, name);
			facts(li, [["Kind", recorded(c.kind)], ["Status", recorded(c.status)], ["Captured", recorded(c.created_at)],
				...Object.entries(c.source && typeof c.source === "object" ? c.source : {}).map(([k, v]) => [`Source ${k}`, String(v)] as [string, string])]);
			textBlock(li, String(c.content ?? "") || "(no text)");
			if (c.promoted_to) { const row = el("p", li, "Promoted to "); link(row, `#/memory/${enc(p.name)}/${enc(String(c.promoted_to))}`, String(c.promoted_to)); }
			if (c.reason) el("p", li, `Reason: ${String(c.reason)}`);
			if (c.status !== "pending") return;
			const key = (action: string) => `${p.name}:${id}:${action}`;
			const promote = el("form", li);
			el("h4", promote, "Promote into a memory");
			const pname = input(promote, `promote-name-${id}`, "Name");
			pname.setAttribute("maxlength", "512");
			pname.value = name.slice(0, 512);
			const ptype = choose(promote, `promote-type-${id}`, "Type", [["project", "Project"], ["feedback", "Feedback"], ["reference", "Reference"], ["user", "User"]]);
			const pdesc = input(promote, `promote-desc-${id}`, "Description (optional)", "textarea");
			const prow = el("p", promote);
			el("button", prow, "Preview").setAttribute("type", "submit");
			const go = btn(prow, "Promote", () => {
				if (!pending) return;
				const body = send(key("promote"), pending);
				act(base, `promote “${name}”`, body, (r) => { reviewSent.delete(key("promote")); return { text: `Promoted “${name}” into memory “${String(r.name ?? pname.value)}”.`, undo: undoOf(p.name, r) }; });
			}, `Promote ${name}`);
			go.disabled = true;
			const shown = el("p", promote);
			let pending: Record<string, unknown> | undefined;
			const stale = () => { pending = undefined; go.disabled = true; shown.textContent = ""; };
			for (const f of [pname, ptype, pdesc]) f.addEventListener("input", stale);
			promote.addEventListener("submit", (event) => {
				event.preventDefault();
				stale();
				if (!pname.value.trim()) { say("Give the memory a name."); msg.focus(); return; }
				pending = { action: "promote", candidate_id: id, into: { name: pname.value.trim(), type: ptype.value, ...(pdesc.value.trim() ? { description: pdesc.value } : {}) } };
				shown.textContent = `Preview: a new ${ptype.value} memory “${pname.value.trim()}” in ${p.name} holding this capture's text, linked back to it. Nothing is saved until you choose Promote.`;
				go.disabled = false;
				go.focus();
			});
			const dismiss = el("form", li);
			el("h4", dismiss, "Dismiss");
			const reason = input(dismiss, `dismiss-reason-${id}`, "Reason (required)");
			reason.setAttribute("maxlength", "10000");
			el("button", el("p", dismiss), "Dismiss").setAttribute("type", "submit");
			dismiss.addEventListener("submit", (event) => {
				event.preventDefault();
				if (!reason.value.trim()) { say("Say why it is dismissed."); msg.focus(); return; }
				const body = send(key("dismiss"), { action: "dismiss", candidate_id: id, reason: reason.value.trim() });
				act(base, `dismiss “${name}”`, body, (r) => { reviewSent.delete(key("dismiss")); return { text: `Dismissed “${name}”.`, undo: undoOf(p.name, r) }; });
			});
		};
		const load = async () => {
			const id = ++request;
			list.replaceChildren();
			say("Loading…");
			let r: J;
			try {
				r = await call(base, "POST", { action: "list", status: status.value, limit: Number(limit.value) });
				if (!Array.isArray(r?.candidates)) throw new Error("the server sent no list");
			} catch (err) { if (version === am.pageVersion && id === request) say(`Could not load suggestions: ${why(err)}`); return; }
			if (version !== am.pageVersion || id !== request) return;
			for (const c of r.candidates) item(c);
			const n = r.candidates.length;
			say(n ? `Showing ${n} suggestion${n === 1 ? "" : "s"}${n === Number(limit.value) ? `; there may be more, show up to ${limit.value === "100" ? "100 (the most one read returns)" : "more"}` : ""}.`
				: `No ${status.value === "all" ? "" : `${status.value} `}suggestions. Suggestions appear only where capture is installed and running.`);
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
		load();

		// Flagged records: housekeeping, a protected record's refused move or promotion flagged them instead of acting. They are found in
		// the profile's whole-graph read (shared with the graph page); the reason is the record's own read. Unflag is the owner node
		// action with its Undo; forget, edit and move stay on the record's page.
		const flags = el("section", view), g = am.graphOf(p);
		flags.setAttribute("aria-label", "Flagged records");
		el("h3", flags, "Flagged records");
		const fStatus = el("p", flags), fList = el("ul", flags);
		fList.setAttribute("class", "prefs");
		btn(flags, "Read the flags again", () => { am.graphs.delete(`${p.name}:${p.generation ?? ""}`); render(false); });
		const showFlags = () => {
			if (version !== am.pageVersion) return;
			fList.replaceChildren();
			const ph = g.parts.nodes;
			if (g.missing) { fStatus.textContent = "This server does not offer the whole-graph read, so flagged records cannot be listed here."; return; }
			const flagged = [...g.nodes.values()].filter((n) => n.flagged);
			fStatus.textContent = `${flagged.length.toLocaleString("en")} flagged among ${g.nodes.size.toLocaleString("en")} records read${ph.done ? "" : ph.error ? `; reading stopped: ${ph.error}` : "; still reading…"}${flagged.length > 50 ? "; the first 50 are listed" : ""}.`;
			for (const n of flagged.slice(0, 50)) {
				const li = el("li", fList), node = `/api/profiles/${enc(p.name)}/nodes/${enc(n.id)}`;
				el("h4", li, n.name);
				facts(li, [["Kind", `${n.kind}${n.type ? ` (${n.type})` : ""}`], ["Status", n.status], ["Updated", recorded(n.updated)]]);
				const flagNote = el("p", li), row = el("p", li);
				btn(row, "Read why", async () => {
					flagNote.textContent = "Reading…";
					try {
						const r: J = await call(node);
						if (version === am.pageVersion) flagNote.textContent = r?.node?.flagged ? `Flagged: ${String(r.node.flagged)}` : "It is no longer flagged.";
					} catch (err) { if (version === am.pageVersion) flagNote.textContent = `Could not read it: ${why(err)}`; }
				}, `Read why ${n.name} is flagged`);
				btn(row, "Unflag", () => act(`${node}/unflag`, `unflag “${n.name}”`, undefined, (r) => { n.flagged = false; return { text: `Unflagged “${n.name}”.`, undo: undoOf(p.name, r) }; }), `Unflag ${n.name}`);
				el("span", row, " ");
				link(row, `#/memory/${enc(p.name)}/${enc(n.id)}`, "Open the record");
			}
		};
		g.listener = showFlags;
		showFlags();
		am.pump(p, g);

		// Restore reconciliation: an open restore's unresolved findings, read from the recovery status; running, opening or aborting it
		// stays on the Backups page. Choosing one copy of an unresolved pair is not offered by the server yet.
		const recon = el("section", view);
		recon.setAttribute("aria-label", "Restore reconciliation");
		el("h3", recon, "Restore reconciliation");
		const rStatus = el("p", recon, "Reading the recovery status…");
		(async () => {
			let s: J;
			try { s = await call("/api/recovery"); } catch (err) { if (version === am.pageVersion) rStatus.textContent = `Could not read the recovery status: ${why(err)}`; return; }
			if (version !== am.pageVersion) return;
			const r = s?.recovery;
			if (!r) { rStatus.textContent = "No restore is open, so nothing waits for reconciliation."; return; }
			rStatus.textContent = `A restore is open (${recorded(r.state)}) with ${recorded(r.unresolved_count)} unresolved finding${r.unresolved_count === 1 ? "" : "s"}.`;
			if (Array.isArray(r.unresolved) && r.unresolved.length) {
				const ul = el("ul", recon);
				for (const u of r.unresolved) el("li", ul, `${recorded(u.kind)}: ${recorded(u.id)}`);
				if (r.unresolved_count > r.unresolved.length) note(recon, `${r.unresolved_count - r.unresolved.length} more are not listed.`);
			}
			link(el("p", recon), "#/backups", "Run, open or abort it in Backups and recovery");
		})();

		// The account's review list (section 15): read once per page; every action is an explicit button and its outcome stays on the page.
		const mig = el("section", view), col = el("section", view);
		mig.setAttribute("aria-label", "Migrated records waiting for a profile");
		el("h3", mig, "Migrated records waiting for a profile");
		note(mig, "The local import plan lists records no rule routes (node local/upload.mjs review-push). Assigning only records your choice: review-pull writes it as a routes file, and the next plan with --routes checks the record again and imports it. Nothing goes to me.");
		const mStatus = el("p", mig, "Reading the review list…"), mList = el("ul", mig);
		mList.setAttribute("class", "prefs");
		col.setAttribute("aria-label", "Moves stopped by a collision");
		el("h3", col, "Moves stopped by a collision");
		note(col, "The destination already held this record or one with the same name, scope and type, so nothing moved. Rename it and move it again, merge it into the record it met, or keep both where they are.");
		const cStatus = el("p", col, "Reading the review list…"), cList = el("ul", col);
		cList.setAttribute("class", "prefs");
		const migration = (it: J) => {
			const x = it.payload ?? {}, id = String(it.id), name = String(x.name ?? x.source), li = el("li", mList);
			el("h4", li, name);
			facts(li, [["Source", recorded(x.source)], ["Id", recorded(x.id)], ["Scope", recorded(x.scope)], ["Why it waits", Array.isArray(x.reasons) ? x.reasons.join(", ") : "Not recorded"],
				["Decision", it.state === "assigned" ? `Goes to ${String(it.decision?.profile)} at the next plan` : "Not assigned"]]);
			const form = el("form", li), to = choose(form, `assign-${id}`, "Profile", [["work", "Work"], ["personal", "Personal"]]), row = el("p", form), shown = el("p", form);
			el("button", row, "Preview").setAttribute("type", "submit");
			const go = btn(row, "Assign", () => act(`/api/review/${enc(id)}/assign`, `assign “${name}” to ${to.value}`, { profile: to.value },
				() => ({ text: `Recorded: “${name}” goes to ${to.value} at the next plan with the pulled routes.` })), `Assign ${name}`);
			go.disabled = true;
			to.addEventListener("change", () => { go.disabled = true; shown.textContent = ""; });
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				shown.textContent = `Preview: “${name}” is to go to ${to.value}. Nothing is imported now; the next plan checks that its exported record is unchanged.`;
				go.disabled = false;
				go.focus();
			});
		};
		const REASON: Record<string, string> = { id_taken: "The destination already holds a record with this id.", key_taken: "The destination already has an active record with the same name, scope and type, or the same key.",
			import_pending: "A record with this identity is still being imported into the destination." };
		const collision = (it: J) => {
			const x = it.payload ?? {}, id = String(it.id), from = String(x.from), to = String(x.to), mid = String(x.memory_id), li = el("li", cList);
			const resolve = (choice: string) => call(`/api/review/${enc(id)}/resolve`, "POST", { choice });
			el("h4", li, `A move from ${from} to ${to}`);
			facts(li, [["Why it stopped", REASON[String(x.reason)] ?? recorded(x.reason)], ["Since", recorded(it.updated_at)]]);
			const links = el("p", li);
			link(links, `#/memory/${enc(from)}/${enc(mid)}`, "Open the moving record");
			el("span", links, " · ");
			if (x.existing_id) link(links, `#/memory/${enc(to)}/${enc(String(x.existing_id))}`, "Open the record it met");
			else el("span", links, "The record it met was not identified.");
			// Rename: the record's page edits it as a draft; then the same move flow as Moves, with a fresh request after a refusal.
			el("p", li, "Rename: open the moving record, choose Edit as a draft and change its name, then move it again.");
			const key = `${from}:${mid}`, prior = am.moves.get(key);
			if (prior) am.moveView(li, prior);
			const row = el("p", li);
			btn(row, "Move it again", () => {
				const again = prior && (prior.state === "unknown" || prior.state === "progress");
				const m: Move = again ? prior! : { source: from, id: mid, name: mid, to, state: "sent", text: "",
					body: { memory_id: mid, to, ...(active().find((q) => q.name === from)?.generation ? { generation: active().find((q) => q.name === from)!.generation } : {}), request_id: `dashboard:${crypto.randomUUID()}` } };
				am.moves.set(key, m);
				am.sendMove(m);
			}, `Move ${mid} to ${to} again`);
			if (prior?.state === "done") btn(row, "Mark it moved", () => act(() => resolve("moved"), "record that it moved", undefined, () => ({ text: "Recorded: it moved." })));
			// Merge: the record it met is edited to hold both; the moving record then goes to the archive, where Undo brings it back.
			el("p", li, "Merge: edit the record it met so it holds what you need from both, then forget the moving record.");
			const mrow = el("p", li);
			if (x.existing_id) btn(mrow, "Forget the moving record", () => act(async () => { const r = await call(`/api/profiles/${enc(from)}/nodes/${enc(mid)}/forget`, "POST"); await resolve("merged").catch(() => undefined); return r; },
				`forget the moving record in ${from}`, undefined, (r) => ({ text: "The moving record is in the archive; Undo brings it back.", undo: undoOf(from, r) })), `Forget ${mid} in ${from}`);
			btn(mrow, "Keep both", () => act(() => resolve("kept"), "keep both records", undefined, () => ({ text: "Recorded: both records stay where they are." })), `Keep both records for the move of ${mid}`);
		};
		(async () => {
			const read = async (kind: string, state: string, status: Node, list: (it: J) => void, none: string) => {
				let r: J;
				try { r = await call(`/api/review?kind=${kind}${state}&limit=100`); if (!Array.isArray(r?.items)) throw new Error("the server sent no list"); }
				catch (err) { if (version === am.pageVersion) status.textContent = `Could not read the review list: ${why(err)}`; return; }
				if (version !== am.pageVersion) return;
				status.textContent = r.items.length ? `${r.items.length} listed${r.next_after ? "; more exist" : ""}.` : none;
				for (const it of r.items) list(it);
			};
			await Promise.all([read("migration", "", mStatus, migration, "No migrated record waits for a profile."), read("collision", "&state=open", cStatus, collision, "No move is waiting on a collision.")]);
		})();
		return h;
	};
	am.pages.review = reviewPage;
	am.adminLink("Review", "#/review");
}
