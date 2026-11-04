// Admin: Write (#/draft/NAME) and the drafts and what-if items other pages share.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Draft, Node, Profile } from "../am";

export function draftPages(am: Am): void {
	const { act, btn, choose, el, enc, facts, input, link, note, outcomes, pageStatus, recorded, render, switcher, textBlock, win } = am;
	const drafts = new Map<string, Draft>();
	const whatIf = new Map<string, { name: string; target: string; targetName: string }[]>(); // per profile, this tab only; never sent
	// What-if changes to saved records and links (graph page): added links, removed saved links, removed records. Per profile, this
	// tab only; never sent and never made into a draft, so nothing about them can be saved by accident.
	const whatIfEdits = new Map<string, { add: [string, string][]; cut: Set<string>; drop: Set<string> }>();
	/** A what-if item becomes an ordinary Write draft (a new memory linked to its record), reviewed and saved only there. */
	const draftFromWhatIf = (profile: string, w: { name: string; target: string; targetName: string }, out: Node) => {
		if (drafts.has(profile)) {
			note(out, "There is an unsaved draft in this profile; save or discard it first.");
			link(out, `#/draft/${enc(profile)}`, "Open existing draft");
			return;
		}
		drafts.set(profile, { name: w.name, type: "project", scope: "", description: "", content: "", target: w.target, targetName: w.targetName, reason: "" });
		win.location.hash = `#/draft/${enc(profile)}`;
	};

	// Write: a draft is previewed first and saved only by an explicit Save, through the save tool. The previewed payload and its
	// request id survive a failed or unanswered Save, so the owner's retry of the same body replays instead of writing twice; any
	// change to the draft needs a new preview, and a preview of a body already sent reuses that request id. Nothing retries by itself.
	const draftPage = (view: Node, p: Profile) => {
		const h = el("h2", view, `Write: ${p.name}`);
		switcher(view, "draft", p.name);
		const d = drafts.get(p.name) ?? { name: "", type: "project", scope: "", description: "", content: "", target: "", targetName: "", reason: "" };
		const editing = !!d.memory_id, was = d.recordName ?? d.name; // `name` follows the field; `recordName` is the record's name when the edit began
		if (editing) {
			el("p", view, `Editing “${was}” at revision ${d.expected_revision}. Saving makes a new revision; the earlier one stays in its history. A change by someone else since then is refused, not overwritten.`);
			link(el("p", view), `#/memory/${enc(p.name)}/${enc(d.memory_id!)}`, "Back to the record");
		} else if (d.copyOf) {
			el("p", view, `A copy of “${d.copyOf.name}” from ${d.copyOf.profile}, saved as a new record in ${p.name}. Only what is shown below is saved; the original keeps its history, requests and links, and the copy has no tie to ${d.copyOf.profile}, so a wipe of ${d.copyOf.profile} leaves it.`);
			link(el("p", view), `#/memory/${enc(d.copyOf.profile)}/${enc(d.copyOf.id)}`, "Back to the original");
		} else el("p", view, "A new memory you state yourself. Nothing is saved until you preview it and choose Save.");
		const form = el("form", view);
		const name = input(form, "draft-name", "Name");
		name.setAttribute("maxlength", "512");
		name.value = d.name;
		const type = choose(form, "draft-type", "Type", [["project", "Project"], ["feedback", "Feedback"], ["reference", "Reference"], ["user", "User"]]);
		type.value = d.type;
		if (editing || d.copyOf) type.disabled = true; // a copy keeps its record's type (and kind) as they are
		const scope = input(form, "draft-scope", "Scope (optional)");
		scope.setAttribute("maxlength", "128");
		scope.value = d.scope;
		if (editing) scope.disabled = true;
		const desc = input(form, "draft-desc", "Description (a short summary)", "textarea");
		desc.value = d.description;
		const content = input(form, "draft-content", "Content", "textarea");
		content.value = d.content;
		let reason: Node | undefined;
		if (d.target) {
			el("p", form, `Adds a “relates to” link to “${d.targetName || d.target}”, with that record as its evidence.`);
			reason = input(form, "draft-reason", "Why they relate (8 to 600 characters)", "textarea");
			reason.setAttribute("maxlength", "600");
			reason.value = d.reason;
		}
		let free: Node | undefined;
		if (p.name === "me") {
			const l = el("label", form);
			l.setAttribute("class", "field");
			free = el("input", l);
			free.setAttribute("type", "checkbox");
			free.checked = d.companyFree === true;
			el("span", l, " This holds no company or work details (required for me)");
		}
		const row = el("p", form);
		el("button", row, "Preview").setAttribute("type", "submit");
		const save = btn(row, "Save", () => commit());
		save.disabled = true;
		btn(row, "Discard draft", () => { drafts.delete(p.name); outcomes.delete(win.location.hash); render(false); });
		const { msg, say } = pageStatus(view);
		const preview = el("section", view);
		preview.setAttribute("aria-label", "Preview");
		let payload = d.preview;
		const keep = (extra: Partial<Draft>) => drafts.set(p.name, { ...(drafts.get(p.name) ?? d), name: name.value, type: type.value, scope: scope.value, description: desc.value,
			content: content.value, reason: reason?.value ?? "", companyFree: free?.checked === true, ...extra });
		const stale = () => { payload = undefined; save.disabled = true; preview.replaceChildren(); keep({ preview: undefined }); };
		for (const f of [name, type, scope, desc, content, reason, free]) f?.addEventListener("input", stale);
		free?.addEventListener("change", stale);
		const show = (x: Record<string, unknown>) => {
			el("h3", preview, "Preview (not saved)");
			const link0 = (x.links as { reason: string }[] | undefined)?.[0];
			facts(preview, [["Profile", p.name], ["Change", editing ? `New revision of “${was}” (now ${d.expected_revision})` : d.copyOf ? `A new record, copied from “${d.copyOf.name}” in ${d.copyOf.profile}` : "A new memory"],
				...(editing ? [["Name", x.new_name ? `Renamed from “${was}” to “${String(x.new_name)}”` : "unchanged"]] as [string, string][] : [["Name", String(x.name)], ["Type", String(x.type)], ...(d.copyOf ? [["Kind", String(x.kind)], ["Text", `${String(x.content ?? "").length.toLocaleString("en")} characters`]] : []),
					["Scope", x.scope ? String(x.scope) : "none"], ["Origin", d.copyOf ? `New in ${p.name}; no history, requests or links come along` : "Stated by you"]] as [string, string][]),
				["Link", link0 ? `relates to “${d.targetName || d.target}”` : "none"]]);
			el("h4", preview, "Description");
			textBlock(preview, String(x.description ?? "") || "(none)");
			el("h4", preview, "Content");
			textBlock(preview, String(x.content ?? "") || "(none)");
			save.disabled = false;
		};
		if (payload) show(payload);
		const body = (x?: Record<string, unknown>) => { if (!x) return undefined; const { request_id: _id, ...rest } = x; return JSON.stringify(rest); };
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			stale();
			const n = name.value.trim(), r = reason?.value.trim() ?? "";
			const problem = !n ? "Give the memory a name." : !desc.value.trim() ? "Write a short description."
				: d.copyOf && !content.value.trim() ? "A copy needs the record's text." : d.copyOf && content.value.length > am.COPY_MAX ? "A copy's text must fit one record."
				: d.target && (r.length < 8 || r.length > 600) ? "Say why they relate in 8 to 600 characters." : free && !free.checked ? "Saving to me needs the no-company-details confirmation." : "";
			if (problem) { say(problem); msg.focus(); return; }
			const next: Record<string, unknown> = {
				// A copy is a plain creation: no record id, revision, origin or source of any kind; creation derives them afresh.
				...(editing ? { memory_id: d.memory_id, expected_revision: d.expected_revision, ...(n !== was ? { new_name: n } : {}), description: desc.value, content: content.value }
					: d.copyOf ? { name: n, type: d.type, kind: d.copyOf.kind, description: desc.value, ...(scope.value.trim() ? { scope: scope.value.trim() } : {}), content: content.value }
					: { name: n, type: type.value, origin: "stated", description: desc.value, ...(scope.value.trim() ? { scope: scope.value.trim() } : {}), ...(content.value.trim() ? { content: content.value } : {}) }),
				...(d.target ? { links: [{ rel: "relates_to", to: { id: d.target }, reason: r, evidence: [{ kind: "node", ref: d.target }] }] } : {}),
				...(free ? { company_free: true } : {}),
			};
			const sent = drafts.get(p.name)?.sent;
			payload = { ...next, request_id: body(sent) === body({ ...next, request_id: "" }) ? sent!.request_id : `dashboard:${crypto.randomUUID()}` };
			keep({ preview: payload });
			show(payload);
			say("Preview ready. Nothing is saved yet; choose Save to write it.");
			save.focus();
		});
		const commit = () => {
			if (!payload) return;
			const sent = payload;
			keep({ sent });
			act(`/api/profiles/${enc(p.name)}/save`, editing ? `save “${was}”` : `save “${String(sent.name)}”`, sent, (r) => {
				drafts.delete(p.name);
				const text = `Saved: ${String(r.action ?? "saved")} “${String(r.name ?? sent.new_name ?? d.name)}”, revision ${recorded(r.revision)}. Open it from Memories.`;
				// A copy asked for from a wipe page goes back there; that page reads its preview afresh. Nothing is typed or confirmed.
				const back = d.copyOf?.back;
				// The hash change renders that page once; retiring this page's version keeps this action from rendering it a second time.
				if (back) { outcomes.set(`#/wipe/${enc(back)}`, { text: `${text} The preview below is read again.` }); am.pageVersion++; win.location.hash = `#/wipe/${enc(back)}`; }
				return { text };
			});
		};
		return h;
	};

	Object.assign(am, { drafts, whatIf, whatIfEdits, draftFromWhatIf });
	am.pages.draft = draftPage;
	am.adminLink("Write", "#/draft");
}
