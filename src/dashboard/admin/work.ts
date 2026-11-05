// Admin: Work, the uploaded work board (#/work/NAME).
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, Node, Profile } from "../am";

export function workPages(am: Am): void {
	const { active, call, el, facts, intro, recorded } = am;
	type BoardRef = { id: string; readable?: false; kind?: string; name?: string };
	type Board = { as_of: string; items: { kind: string; name: string; key: string | null; priority: string | null; due: string | null;
		score: number; reasons: { term: string; points: number; text: string }[]; stale: boolean; last_activity_at: string;
		blocked_by: BoardRef[]; blocks: BoardRef[]; unrecognized: string[] }[]; total?: number; truncated?: boolean; without_state?: number;
		review?: { name: string; description: string; recorded_at: string; age_days: number } | null;
		budget?: { exhausted: boolean; skipped: number } };
	const workPage = (view: Node, p: Profile) => {
		const version = am.pageVersion, h = el("h2", view, `Work: ${p.name}`), nav = el("nav", view);
		nav.setAttribute("aria-label", "Work profile");
		for (const q of active()) {
			const a = el("a", nav, q.name);
			a.setAttribute("href", `#/work/${encodeURIComponent(q.name)}`);
			if (q.name === p.name) a.setAttribute("aria-current", "page");
		}
		intro(view, "Work", "work", "Covers only what the owner's machines have uploaded. Item fields are their latest upload; as_of dates links, due dates and activity. This is not a historical snapshot of item fields.");
		const form = el("form", view);
		form.setAttribute("class", "toolbar");
		const label = el("label", form, "As of (ISO date and time with Z for UTC or an explicit offset; blank uses server time)");
		label.setAttribute("for", "work-as-of");
		const date = el("input", form);
		date.setAttribute("id", "work-as-of");
		date.setAttribute("type", "text");
		date.setAttribute("placeholder", "2026-10-29T12:00:00Z");
		const submit = el("button", form, "Show board");
		submit.setAttribute("type", "submit");
		const msg = el("p", view);
		msg.setAttribute("role", "status");
		msg.setAttribute("aria-live", "polite");
		msg.setAttribute("tabindex", "-1");
		const result = el("section", view);
		result.setAttribute("aria-label", "Work board result");
		result.setAttribute("class", "panel");
		result.hidden = true;
		const more = el("button", view, "Show up to 200 items");
		more.setAttribute("type", "button");
		more.hidden = true;
		let request = 0, returnedDate = "";
		const invalidate = () => { request++; result.replaceChildren(); result.hidden = true; more.hidden = true; };
		date.addEventListener("input", () => { invalidate(); msg.textContent = "Date changed. Choose Show board to load it."; });
		const load = async (asOf: string, limit = 50, moveFocus = false) => {
			invalidate();
			const id = request;
			const current = () => version === am.pageVersion && id === request;
			msg.textContent = "Loading work board…";
			let board: Board;
			try {
				board = await call(`/api/profiles/${encodeURIComponent(p.name)}/board?limit=${limit}${asOf ? `&as_of=${encodeURIComponent(asOf)}` : ""}`);
				if (!Array.isArray(board?.items) || typeof board.as_of !== "string" || !board.as_of) throw new Error("missing board result");
			} catch (err) {
				if (!current()) return;
				const e = err as Failure;
				const reason = e.status === 401 || e.status === 403 || e.code === "forbidden" ? "Access was refused. Sign in as the owner."
					: e.status === 404 || e.code === "profile_wiped" ? "This profile is no longer available."
					: e.status === 409 || e.code === "busy" ? "The profile changed or is temporarily busy. Try again when it is ready."
					: e.status === 503 || e.code === "unavailable" ? "The service is temporarily unavailable. Try again later."
					: e.status === 400 ? "The request was refused. Check the ISO date and time, including its UTC offset."
					: "The board could not be read. Try again when the service is ready.";
				msg.textContent = `Could not load work board. ${reason}`;
				if (moveFocus) msg.focus();
				return;
			}
			if (!current()) return;
			returnedDate = board.as_of;
			result.hidden = false;
			el("h3", result, `As of ${returnedDate}`);
			const limited = board.truncated === true, partial = board.budget?.exhausted === true;
			msg.textContent = `Showing ${board.items.length} ranked open items${typeof board.total === "number" ? ` of ${board.total} evaluated` : "; evaluated count unavailable"}.`;
			if (!board.items.length) el("p", result, partial ? "No open items in the part read." : "No open items in the uploaded data read for this date.");
			if (limited) el("p", result, "The display limit hides some evaluated items.");
			if (partial) el("p", result, `This board is incomplete: some items or connections could not be evaluated within this read.${typeof board.budget?.skipped === "number" && board.budget.skipped > 0 ? ` ${board.budget.skipped} items were skipped.` : ""} Scores and order may change with more data.`);
			if (typeof board.budget?.exhausted !== "boolean") el("p", result, "Read completeness was not reported.");
			el("p", result, typeof board.without_state === "number" ? `${board.without_state} uploaded items have no recognized open or closed state and are excluded.` : "The count of items without a recognized state is unavailable.");
			const list = el("ol", result);
			list.setAttribute("aria-label", "Ranked open work");
			for (const it of board.items) {
				const li = el("li", list);
				el("h4", li, recorded(it.name));
				facts(li, [["Kind", recorded(it.kind)], ["Key", recorded(it.key)], ["Priority", recorded(it.priority)], ["Due", recorded(it.due)],
					["Score", recorded(it.score)], ["Stale", it.stale === true ? "Yes" : it.stale === false ? "No" : "Not recorded"], ["Last activity", recorded(it.last_activity_at)]]);
				const details = el("details", li);
				el("summary", details, "Score reasons");
				const reasons = el("ul", details);
				for (const r of it.reasons ?? []) if (r.points !== 0) el("li", reasons, `${recorded(r.term)}: ${recorded(r.points)} points. ${recorded(r.text)}`);
				if (!it.reasons?.length) el("p", details, "No score reasons reported.");
				for (const [title, refs] of [["Blocked by", it.blocked_by], ["Blocks", it.blocks]] as const) {
					el("p", li, title);
					if (!refs) el("p", li, "Not reported");
					else if (!refs.length) el("p", li, "None reported");
					else for (const ref of refs) el("p", li, ref.readable === false ? `Unreadable item: ${recorded(ref.id)}` : `${recorded(ref.kind)}: ${recorded(ref.name)} (${recorded(ref.id)})`);
				}
				if (it.unrecognized?.length) el("p", li, `Unrecognized fields: ${it.unrecognized.join(", ")}. The server used its fallback for scoring.`);
			}
			el("h3", result, "Latest strategic review");
			if (board.review) {
				el("h4", result, recorded(board.review.name));
				el("p", result, recorded(board.review.description));
				facts(result, [["Recorded", recorded(board.review.recorded_at)], ["Age at as of", typeof board.review.age_days === "number" ? `${board.review.age_days} days` : "Not recorded"]]);
			} else el("p", result, board.review === null ? "No strategic review recorded for this date." : "Strategic review information was not reported.");
			more.hidden = !limited || limit === 200;
			if (moveFocus) msg.focus();
		};
		form.addEventListener("submit", (event) => { event.preventDefault(); load(date.value.trim(), 50, true); });
		more.addEventListener("click", () => load(returnedDate, 200, true));
		load("");
		return h;
	};
	am.pages.work = workPage;
}
