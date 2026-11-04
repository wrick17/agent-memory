// Replay tab: a session picker and the shared replay player (local/replay-player.js, which defines window.amReplayPlayer when
// /app.js embeds it) over a hosted session's digest events, plus how to see the full transcript locally. Hosted events keep
// order, not time (offset_ms is null). The player draws its own controls, list and detail and binds its own keys.
// Replay shows one profile at a time (profiles: "one"): the shell asks for ?profile= before render, so every read names it.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node } from "./am";

export function replayTab(am: Am): void {
	const { call, copy, el, empty, enc, intro, link, loading, note, pageStatus, why, win } = am;
	let controls: { destroy(): void } | null = null;
	const stop = () => { try { controls?.destroy(); } catch { /* the player is gone with its page */ } controls = null; };
	// The shell re-renders on every hash change; stop the old player's timer and keys first. Replay remounts it if still here.
	win.addEventListener("hashchange", stop);

	const command = (parent: Node, text: string) => { const p = el("p", parent); el("code", p, text); el("span", p, " "); copy(p, "Copy", () => text); };

	const render = (root: Node, route: { id?: string; query: Record<string, string> }) => {
		stop();
		// The shell gates a missing or inactive ?profile with its chooser, so `profile` is always one active profile here.
		const version = am.pageVersion, profile = route.query.profile!, h = el("h2", root, `Replay: ${profile}`);
		intro(root, "Replay", "replay", "plays one session's events in order. Hosted sessions hold digest excerpts; the full transcript plays on the device that recorded it.");
		const { say } = pageStatus(root);

		const form = el("form", root);
		form.setAttribute("class", "toolbar");
		const pick = am.choose(form, "replay-session", "Session", [["", "Loading sessions…"]]);
		pick.disabled = true;
		el("button", form, "Open session").setAttribute("type", "submit");
		const stage = el("section", root);
		stage.setAttribute("aria-label", "Player");

		let rows: J[] = [], opened = 0;
		const open = async (id: string) => {
			const req = ++opened; // the form replaces the address without a render, so pageVersion alone cannot tell opens apart
			stop();
			stage.replaceChildren();
			loading(stage, 4);
			say("Loading the session…");
			let d: J;
			try { d = await call(`/api/profiles/${enc(profile)}/sessions/${enc(id)}`); }
			catch (err) {
				if (version !== am.pageVersion || req !== opened) return;
				stage.replaceChildren();
				say((err as J).status === 404 ? `No session with id ${id} in ${profile}.` : `Could not load this session: ${why(err)}`);
				return;
			}
			if (version !== am.pageVersion || req !== opened) return;
			stage.replaceChildren();
			if (typeof d?.id !== "string" || !Array.isArray(d.events)) { say(`${profile} sent a session without its events.`); return; }
			say("");
			const events: J[] = Array.isArray(d.events) ? d.events : [], session = String(d.session ?? "");
			const device = typeof d.device === "string" && d.device ? d.device : "the device that recorded it";
			el("h3", stage, typeof d.first_ask === "string" && d.first_ask ? d.first_ask : "Untitled session");
			el("p", stage, `${profile} · ${String(d.client ?? "")} · ${events.length} event${events.length === 1 ? "" : "s"}`).setAttribute("class", "na");
			link(el("p", stage), `#sessions/${enc(String(d.id))}?profile=${enc(profile)}`, "Open in Sessions");
			const hosted = el("p", stage, `Digest events, in order only. Run agent-memory replay --session ${session} on ${device} for the full transcript.`);
			hosted.setAttribute("class", "intro");
			command(stage, `agent-memory replay --session ${session}`);
			if (!events.length) { note(stage, "This session has no digest events yet."); return; }
			const player = win.amReplayPlayer;
			if (!player || typeof player.mount !== "function") { note(stage, "The replay player is not on this page, so it cannot play here. Sessions lists the same events in order."); return; }
			const box = el("div", stage);
			box.setAttribute("class", "player");
			try { controls = player.mount(box, events, { speeds: [0.5, 1, 2, 4] }); }
			catch (err) { box.replaceChildren(); note(box, `The replay player could not start: ${(err as Error).message}`); }
		};

		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const x = pick.value === "" ? undefined : rows[Number(pick.value)];
			if (!x) { say("Choose a session first."); return; }
			const id = String(x.id);
			win.history?.replaceState?.(null, "", `#replay/${enc(id)}?profile=${enc(profile)}`);
			void open(id);
		});

		const imports = el("section", root);
		imports.setAttribute("class", "panel");
		imports.setAttribute("aria-label", "Import past transcripts");
		el("h3", imports, "Import past transcripts");
		el("p", imports, "Backfill queues every local transcript whose capture is behind. The next capture run uploads its digests within the usual limits, and the sessions appear here.");
		command(imports, "agent-memory backfill --since 30d");
		command(imports, "agent-memory backfill --client codex");
		note(imports, "Claude Code deletes transcripts older than cleanupPeriodDays (30 days by default), so backfill soon after you install.");
		el("p", imports, "To see a session with its prompts, responses and tool calls, list the sessions on that device and replay one. The viewer runs on 127.0.0.1 only, and nothing it reads is uploaded.");
		command(imports, "agent-memory replay --list");

		// The picker: this profile's newest sessions, from its own list route.
		(async () => {
			let r: J;
			try { r = await call(`/api/profiles/${enc(profile)}/sessions?limit=100`); if (!Array.isArray(r?.rows)) throw new Error("the server sent no session list"); }
			catch (err) { if (version === am.pageVersion) { pick.replaceChildren(); el("option", pick, "Sessions could not load").setAttribute("value", ""); say(`Could not load sessions: ${why(err)}`); } return; }
			if (version !== am.pageVersion) return;
			pick.replaceChildren();
			rows = r.rows.filter((x: J) => x && typeof x.id === "string");
			if (!rows.length) {
				el("option", pick, "No sessions yet").setAttribute("value", "");
				if (!route.id) empty(stage, `No sessions in ${profile} to replay yet. Capture uploads digests after each agent turn; backfill adds older transcripts.`, "agent-memory backfill --since 30d");
				return;
			}
			el("option", pick, "Choose a session").setAttribute("value", "");
			rows.forEach((x, n) => el("option", pick, `${typeof x.first_ask === "string" && x.first_ask ? x.first_ask.slice(0, 80) : "Untitled session"} · ${String(x.client)} · ${String(x.last_upload_at ?? "").slice(0, 10)}`)
				.setAttribute("value", String(n)));
			const current = rows.findIndex((x) => x.id === route.id);
			pick.value = current < 0 ? "" : String(current);
			pick.disabled = false;
			if (r.next_cursor) note(form, "The picker lists the newest 100 sessions. Open older ones from Sessions.");
		})();

		if (route.id) void open(route.id);
		else note(stage, "Choose a session and open it to play its events.");
		return h;
	};

	am.tab({ id: "replay", group: "work", label: "Replay", key: "r", profiles: "one", render });
}
