// Admin: Moves (#/move/NAME/ID) and Save a copy (#/copy/NAME/ID).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Move, Node, Profile } from "../am";

export function movesPages(am: Am): void {
	const { act, active, btn, call, choose, el, enc, facts, link, note, pageStatus, recorded, why, win } = am;

	// Moves (sections 9 and 15): one record to another active profile through save_memory's transfer. Each move's exact request,
	// request id included, is kept for this session, so it can be sent again after a lost answer even once the record has left
	// its source; the server replays a finished move instead of moving it twice. Nothing is sent by itself.
	const moves = new Map<string, Move>(); // `${source}:${id}` -> the last move asked for
	const moveState = (m: Move) => ({ sent: "Sending…", unknown: "Result unconfirmed: the move may or may not have happened. Send the same move again to find out; it cannot move twice.",
		done: `Moved to ${m.to}.`, aborted: "The move was stopped and nothing was published; the record stays where it was.", refused: m.text,
		progress: "The move has started but not finished; the record is fenced until it does. Send the same move again to continue it; the server also retries a stalled move by itself after about five minutes." })[m.state];
	const sendMove = (m: Move) => {
		m.state = "sent";
		// A temporary failure can follow a committed intent, so only a terminal refusal drops the exact retry.
		act(() => call(`/api/profiles/${enc(m.source)}/move`, "POST", m.body).catch((e: Failure) => {
			const retryable = !e.status || e.status >= 500 || e.status === 408 || e.status === 429 || ["unavailable", "moving", "busy"].includes(e.code ?? "");
			Object.assign(m, retryable ? { state: "unknown" } : { state: "refused", text: `Refused: ${why(e)}` });
			throw e;
		}), `move “${m.name}” to ${m.to}`, undefined, (r) => {
			m.state = r?.state === "committed" ? "done" : r?.state === "aborted" ? "aborted" : "progress";
			return { text: moveState(m) };
		});
	};
	const moveView = (parent: Node, m: Move) => {
		const box = el("div", parent);
		box.setAttribute("class", m.state === "done" ? "na" : "warn");
		el("p", box, `Move of “${m.name}” from ${m.source} to ${m.to}: ${moveState(m)}`);
		if (m.state === "done") link(el("p", box), `#/memory/${enc(m.to)}/${enc(m.id)}`, `Open it in ${m.to}`);
		if (m.state === "unknown" || m.state === "progress") btn(el("p", box), "Send the same move again", () => sendMove(m), `Send the same move of ${m.name} again`);
	};
	const movePage = (view: Node, p: Profile, id: string | undefined) => {
		const version = am.pageVersion;
		if (id === undefined) {
			const h = el("h2", view, "Moves");
			pageStatus(view);
			el("p", view, "Moves asked for in this browser tab. Open a record and choose “Move to another profile” to start one.");
			const list = [...moves.values()];
			for (const m of list) moveView(view, m);
			if (!list.length) note(view, "No moves yet in this tab.");
			return h;
		}
		const key = `${p.name}:${id}`, prior = moves.get(key);
		const h = el("h2", view, "Move a record");
		link(el("p", view), "#/move", "All moves in this tab");
		const { msg, say } = pageStatus(view);
		if (prior) moveView(view, prior);
		const body = el("div", view);
		say("Reading the record…");
		(async () => {
			let r: J;
			try { r = await call(`/api/profiles/${enc(p.name)}/nodes/${enc(id)}`); if (!r?.node) throw new Error("the server sent no record"); } catch (err) {
				if (version === am.pageVersion) say(prior ? "" : `Could not read the record in ${p.name}: ${why(err)}`);
				return;
			}
			if (version !== am.pageVersion) return;
			say("");
			const name = String(r.node.name ?? "(no name)");
			h.textContent = `Move “${name}”`;
			facts(body, [["Record", name], ["Kind", recorded(r.node.kind)], ["Now in", p.name], ["Status", recorded(r.node.status)]]);
			if (r.node.status !== "active") { note(body, "Only an active record can be moved."); return; }
			const warn = el("div", body);
			warn.setAttribute("class", "warn");
			el("h3", warn, "What a move does");
			const ul = el("ul", warn);
			for (const t of [`The record leaves ${p.name} and is held by the profile you choose, with the same id, its whole revision history and its request records.`,
				`${p.name} keeps a tombstone in its place; links to it keep pointing at it. Devices that can read only ${p.name} stop seeing it.`,
				"Only the move happens: no other change rides along. Search by meaning may take a while to catch up.",
				"Moving into me needs your statement that it holds no company or work details; the server also checks its text and refuses a move it cannot accept."]) el("li", ul, t);
			const form = el("form", body);
			const to = choose(form, "move-to", "Move to", [["", "Choose a profile"], ...active().filter((q) => q.name !== p.name).map((q) => [q.name, q.name] as [string, string])]);
			const freeLabel = el("label", form);
			freeLabel.setAttribute("class", "field");
			const free = el("input", freeLabel);
			free.setAttribute("type", "checkbox");
			el("span", freeLabel, " This record holds no company or work details (required for me)");
			freeLabel.hidden = true;
			const row = el("p", form);
			el("button", row, "Preview").setAttribute("type", "submit");
			const go = btn(row, "Move", () => {
				if (!pending) return;
				const same = prior && prior.state !== "done" && prior.to === pending.to && JSON.stringify(prior.body.company_free ?? false) === JSON.stringify(pending.company_free ?? false);
				const m: Move = same ? prior! : { source: p.name, id, name, to: String(pending.to), state: "sent", text: "",
					body: { memory_id: id, to: pending.to, ...(pending.company_free ? { company_free: true } : {}), ...(p.generation ? { generation: p.generation } : {}), request_id: `dashboard:${crypto.randomUUID()}` } };
				moves.set(key, m);
				sendMove(m);
			}, `Move ${name}`);
			go.disabled = true;
			const preview = el("p", body);
			let pending: Record<string, unknown> | undefined;
			const stale = () => { pending = undefined; go.disabled = true; preview.textContent = ""; freeLabel.hidden = to.value !== "me"; };
			to.addEventListener("input", stale);
			to.addEventListener("change", stale);
			free.addEventListener("change", stale);
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				stale();
				if (!to.value) { say("Choose the profile to move it to."); msg.focus(); return; }
				if (to.value === "me" && !free.checked) { say("Moving into me needs the no-company-details statement."); msg.focus(); return; }
				pending = { to: to.value, ...(to.value === "me" ? { company_free: true } : {}) };
				preview.textContent = `Preview: move “${name}” from ${p.name} to ${to.value}. Nothing moves until you choose Move.`;
				go.disabled = false;
				go.focus();
			});
		})();
		return h;
	};

	// Save a copy (section 9): before a wipe, the owner may re-save a record as a new record of another profile. The copy holds
	// only the name, description and full current text the owner reviews; the original keeps its history, requests and links, and
	// creation gives the copy its own identity and origin. Only records Write can recreate exactly are offered; nothing is converted.
	const copyBack = new Map<string, string>(); // `${profile}:${id}` -> the profile whose wipe page asked for the copy
	const COPY_KIND: Record<string, string> = { feedback: "rule", user: "preference", reference: "document", project: "journal" };
	const COPY_MAX = 64_000; // the save tool's content limit
	const copyPage = (view: Node, p: Profile, id: string | undefined) => {
		const version = am.pageVersion, h = el("h2", view, "Save a copy");
		if (id === undefined) { el("p", view, "Open a record and choose “Save a copy in another profile”."); return h; }
		const base = `/api/profiles/${enc(p.name)}/nodes/${enc(id)}`, back = copyBack.get(`${p.name}:${id}`);
		if (back) link(el("p", view), `#/wipe/${enc(back)}`, `Back to the wipe of ${back}`);
		const { msg, say } = pageStatus(view);
		const body = el("div", view);
		say("Reading the record…");
		(async () => {
			let r: J;
			try { r = await call(base); if (!r?.node) throw new Error("the server sent no record"); } catch (err) { if (version === am.pageVersion) say(`This record cannot be read here: ${why(err)}`); return; }
			if (version !== am.pageVersion) return;
			say("");
			const n = r.node, name = String(n.name ?? ""), type = n.memory_type ? String(n.memory_type) : null, kind = String(n.kind ?? "");
			h.textContent = `Save a copy of “${name}”`;
			facts(body, [["Record", name], ["Now in", p.name], ["Type", recorded(type)], ["Kind", kind], ["Status", recorded(n.status)]]);
			const cut: string[] = Array.isArray(n.truncated) ? n.truncated : [];
			const unavailable = !type ? "it is a work item, not a memory; Write saves memories only."
				: type === "procedural" ? "a procedure keeps ordered steps, which Write does not carry."
				: kind === "decision" ? "a decision needs its reasoning and evidence, which Write does not carry."
				: COPY_KIND[type] !== kind ? "its type and kind do not match a record Write can create."
				: n.status !== "active" ? "only an active record can be copied."
				: cut.includes("description") ? "its description is longer than this page can read in full."
				: name.length < 1 || name.length > 512 ? "its name cannot be saved as given." : "";
			if (unavailable) { note(body, `This record cannot be copied: ${unavailable}`, "warn"); return; }
			el("p", body, `The copy is a new record in the profile you choose, holding this record's name, description and full current text, which you review before saving. Its history, requests and links stay with the original in ${p.name}.`);
			const form = el("form", body);
			const to = choose(form, "copy-to", "Copy into", [["", "Choose a profile"], ...active().filter((q) => q.name !== p.name).map((q) => [q.name, q.name] as [string, string])]);
			const go = el("button", el("p", form), "Read the full text and prepare the copy");
			go.setAttribute("type", "submit");
			form.addEventListener("submit", async (event) => {
				event.preventDefault();
				if (!to.value) { say("Choose the profile to copy it into."); msg.focus(); return; }
				if (am.drafts.has(to.value)) { say(`There is an unsaved draft in ${to.value}; save or discard it first.`); msg.focus(); return; }
				go.disabled = true;
				say("Reading the full text…");
				// The whole content in the entity read's own pages, bound to the revision shown; only this record is read.
				let text = "", cursor: string | null = null, pages = 0;
				try {
					do {
						const page: J = await call(`${base}?content=all${cursor ? `&cursor=${enc(cursor)}` : ""}`);
						if (typeof page?.content?.content !== "string") throw new Error("the server sent no text");
						text += page.content.content;
						cursor = typeof page.content.cursor === "string" ? page.content.cursor : null;
					} while (cursor && ++pages < 3 && text.length <= COPY_MAX);
				} catch (err) { if (version === am.pageVersion) { say(`Could not read the text: ${why(err)}`); go.disabled = false; } return; }
				if (version !== am.pageVersion) return;
				if (cursor || text.length > COPY_MAX) { say(`This record cannot be copied: its text is longer than one record can hold (${COPY_MAX.toLocaleString("en")} characters).`); return; }
				if (!text.trim()) { say("This record cannot be copied: it has no text."); return; }
				am.drafts.set(to.value, { name, type: type!, scope: n.scope ? String(n.scope) : "", description: String(n.description ?? ""), content: text, target: "", targetName: "", reason: "",
					copyOf: { profile: p.name, id, name, kind, ...(back ? { back } : {}) } });
				win.location.hash = `#/draft/${enc(to.value)}`;
			});
		})();
		return h;
	};
	Object.assign(am, { moves, sendMove, moveView, copyBack, COPY_MAX });
	am.pages.move = movePage;
	am.pages.copy = copyPage;
}
