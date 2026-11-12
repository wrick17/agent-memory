// Admin: Backups and recovery (#/backups), with the restore drill and recovery copy choices.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, Failure, J, Node } from "../am";

export function backupsPages(am: Am): void {
	const { act, active, btn, call, choose, el, enc, facts, input, intro, note, pageStatus, recorded, render, why } = am;

	// The restore drill (section 18): a profile's newest export restored into a scratch generation that never becomes live, and the
	// account's newest export checked without being applied. The account stays open. Begin keeps its exact body, request id included,
	// so an unconfirmed begin is sent again unchanged; step and cleanup name the drill shown. Nothing runs by itself.
	let drillSent: { profile: string; generation?: string; request_id: string } | null = null;
	const drillView = (parent: Node, recovering: boolean) => {
		const version = am.pageVersion, sec = el("section", parent);
		sec.setAttribute("aria-label", "Restore drill");
		sec.setAttribute("class", "panel");
		el("h3", sec, "Restore drill");
		note(sec, "A drill restores a profile's newest export into a scratch copy that never becomes live, and checks the account's newest export without applying it. The account stays open and nothing live changes. Cleanup deletes only the scratch copy and its own vectors.");
		const body = el("div", sec);
		body.textContent = "Reading the drill status…";
		const report = (d: J) => {
			const rp = d.report ?? {}, cleaned = rp.cleaned?.scratch === true;
			// Passed only as the server says, and only once its scratch copy is gone.
			const verdict = d.passed === true && cleaned ? "Passed: every check passed and the scratch copy was cleaned up."
				: d.passed === true ? "Checks passed, but the cleanup of the scratch copy is not confirmed." : d.state === "done" ? "Did not pass." : "Not finished.";
			el("p", body, verdict).setAttribute("class", d.passed === true && cleaned ? "na" : "warn");
			if (d.error) el("p", body, `Failure: ${recorded(d.error.message ?? d.error.code)}`);
			facts(body, [["Profile", recorded(d.profile)], ["Live generation", recorded(d.live_generation)], ["Scratch generation", recorded(d.scratch)], ["From export", `${recorded(d.export)} (${recorded(d.export_at)})`],
				["State", `${recorded(d.state)}${d.progress ? ` (${String(d.progress)})` : ""}`], ["Started", recorded(d.at)], ["Finished", recorded(d.finished_at)],
				...(d.report ? [["Chunks verified", recorded(rp.chunks)], ["Rows restored", Object.entries(rp.rows ?? {}).map(([t, n]) => `${t} ${String(n)}`).join(", ") || "None"],
					["Records and requests", `${recorded(rp.nodes)} records, ${recorded(rp.requests)} requests`], ["Vectors embedded", recorded(rp.vectors)],
					["Held elsewhere now", `${recorded(rp.owned_elsewhere)} records, ${recorded(rp.requests_elsewhere)} requests`], ["Named by a wipe", recorded(rp.wiped)],
					["Account export", rp.account ? `${recorded(rp.account.export)}: ${recorded(rp.account.chunks)} chunks checked, ${recorded(rp.account.rows)} rows` : "Not checked"],
					["Live generation unchanged", rp.live_generation_unchanged === true ? "Yes" : "No"],
					["Cleaned up", `${cleaned ? "scratch copy deleted" : "scratch copy not confirmed deleted"}, ${recorded(rp.cleaned?.vectors)} vectors`]] as [string, string][] : [])]);
		};
		(async () => {
			let s: J;
			try { s = await call("/api/backups/drill"); } catch (err) { if (version === am.pageVersion) body.textContent = `Could not read the drill status: ${why(err)}`; return; }
			if (version !== am.pageVersion) return;
			body.textContent = "";
			const d = s?.drill, last = s?.last;
			if (drillSent && [d, last].some((x) => x?.request_id === drillSent!.request_id)) drillSent = null; // the begin was received
			if (d) {
				el("h4", body, "Drill in progress");
				report(d);
				const row = el("p", body), id = { id: String(d.id) }, done = (x: J) => ({ text: `Drill is now ${recorded(x?.state)}${x?.progress ? ` (${String(x.progress)})` : ""}.` });
				if (d.state !== "cleaning" && d.state !== "done") btn(row, "Run the next drill step", () => act("/api/backups/drill/step", "run the next drill step", id, done));
				btn(row, d.state === "cleaning" ? "Continue the cleanup" : "Stop and clean up", () => act("/api/backups/drill/cleanup", "clean up the drill", id, done));
				note(body, "Recoveries and wipes cannot begin until this drill and its cleanup have finished.");
				return;
			}
			if (last) { el("h4", body, "Last drill"); report(last); }
			if (recovering) { note(body, "A drill cannot begin while a recovery is open."); return; }
			if (drillSent) {
				const sent = drillSent;
				el("p", body, `A drill of ${sent.profile} may or may not have begun. Send the same request again to find out; it cannot begin twice.`).setAttribute("class", "warn");
				btn(el("p", body), "Send the same drill request again", () => beginDrill(sent));
				return;
			}
			const f = el("form", body), pick = choose(f, "drill-profile", "Profile to drill", active().map((q) => [q.name, q.name]));
			el("button", el("p", f), "Begin a restore drill").setAttribute("type", "submit");
			f.addEventListener("submit", (event) => {
				event.preventDefault();
				const q = active().find((x) => x.name === pick.value);
				if (!q) return;
				beginDrill({ profile: q.name, ...(q.generation ? { generation: q.generation } : {}), request_id: `dashboard:${crypto.randomUUID()}` });
			});
		})();
	};
	const beginDrill = (sent: NonNullable<typeof drillSent>) => {
		drillSent = sent;
		act(() => call("/api/backups/drill", "POST", sent).catch((e: Failure) => {
			// Only a definite refusal drops the exact request; an unconfirmed one is kept to send again unchanged.
			if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) drillSent = null;
			throw e;
		}), `begin a restore drill of ${sent.profile}`, undefined, (x) => { drillSent = null; return { text: `Drill begun: ${recorded(x?.state)}. Run its steps below.` }; });
	};
	// The owner's copy choices of an open recovery (section 18, step 4). Each sent choice keeps its exact body, request id included,
	// so an unconfirmed answer is sent again unchanged; the server binds the id to that body. A refusal drops it, and a copy that
	// changed needs an explicit reread before a new preview, which gets a new request id. Nothing is sent by itself.
	type Choice = { body: { id: string; node: string; keep: string; expect: { profile: string; generation: string | null; status: string | null; revision: number | null }[]; request_id: string };
		state: "unknown" | "progress" | "changed" | "refused"; text: string };
	const choices = new Map<string, Choice>(); // `${recovery}:${node}` -> the last choice sent
	const sendChoice = (c: Choice) => {
		act(() => call("/api/recovery/conflicts/resolve", "POST", c.body).catch((e: Failure) => {
			const uncertain = !e.status || e.status >= 500 || e.status === 408 || e.status === 429;
			Object.assign(c, uncertain ? { state: "unknown", text: "Result unconfirmed: the choice may or may not have been made. Send the same choice again to find out; it cannot be made twice." }
				: e.reason === "copy_changed" ? { state: "changed", text: "A copy changed since it was shown, so nothing was chosen. Read the copies again before choosing." }
				: { state: "refused", text: `Refused: ${why(e)}` });
			throw e;
		}), `keep the copy in ${c.body.keep}`, undefined, (x) => {
			if (x?.progress) { Object.assign(c, { state: "progress", text: `Started, not finished: ${String(x.progress)}. Continue it with the same choice.` }); return { text: c.text }; }
			choices.delete(`${c.body.id}:${c.body.node}`);
			return { text: `Kept the copy in ${recorded(x?.kept)}; the copy in ${recorded(x?.tombstoned)} is now a flagged tombstone with its content in that profile's archive. The account stays closed: read the status below.` };
		});
	};
	const conflictsView = (parent: Node, r: J) => {
		const version = am.pageVersion, sec = el("section", parent);
		sec.setAttribute("aria-label", "Copies to choose");
		sec.setAttribute("class", "panel");
		el("h3", sec, "Choose which copy to keep");
		note(sec, "The fixed recovery rules could not decide these records: two profiles hold a copy. Keep one copy of each; the other becomes a flagged tombstone, its content and history kept in that profile's archive. Nothing is merged. The account stays closed until the recovery is opened.");
		if (r.resolving) note(sec, `A choice for record ${String(r.resolving)} is unfinished; finish it before another.`, "warn");
		const list = el("ul", sec), more = el("p", sec), status = el("p", sec);
		list.setAttribute("class", "prefs");
		const busy = () => [...choices.entries()].some(([k, c]) => k.startsWith(`${r.id}:`) && (c.state === "unknown" || c.state === "progress"));
		const copyFacts = (li: Node, x: J) => {
			const c = x.copy;
			el("h4", li, `In ${String(x.profile)}`);
			if (!c) { el("p", li, "No copy of this record here."); return; }
			facts(li, [["Name", recorded(c.name)], ["Description", recorded(c.description)], ["Status", recorded(c.status)], ["Revision", recorded(c.revision)], ["Updated", recorded(c.updated_at)],
				["Characters", recorded(c.chars)], ["Content hash", recorded(c.content_hash)], ["Flag", c.flagged ? String(c.flagged) : "None"],
				["Transfer", c.transfer ? `${String(c.transfer)}${c.status === "moved" ? " (moved away)" : " (fenced)"}` : "None"],
				["Unpublished landing", c.incoming ? `from ${String(c.incoming.from)}` : "None"], ["Unfinished transfers here", String(Array.isArray(c.rows) ? c.rows.length : 0)],
				...(c.status === "moved" ? [["Restorable from its archive", c.restorable?.ok ? "Yes" : `No: ${recorded(c.restorable?.reason)}`]] as [string, string][] : []),
				["Can be kept", x.keepable ? "Yes" : "No"]]);
		};
		const item = (c: J) => {
			const li = el("li", list), key = `${r.id}:${c.node}`, copies: J[] = Array.isArray(c.copies) ? c.copies : [];
			let sent = choices.get(key);
			// An unfinished choice the server already holds (another tab, a reload): its exact original body, sent again only on a click.
			// A local unconfirmed body under the same request id is that body already; anything else yields to the server's own.
			const resume = c.state === "resolving" && c.resume && typeof c.resume.request_id === "string" ? c.resume as Choice["body"] : null;
			if (resume && !((sent?.state === "unknown" || sent?.state === "progress") && sent.body.request_id === resume.request_id)) {
				const lose = copies.find((x) => x.profile !== resume.keep)?.profile ?? "the other profile";
				sent = { body: resume, state: "progress", text: `This choice is already recorded and unfinished: keep the copy in ${String(resume.keep)}; the copy in ${String(lose)} becomes a flagged tombstone with its content and history in that profile's archive, and nothing is merged. It was chosen against ${resume.expect.map((e) => `${e.profile} ${e.status ?? "no copy"}${e.revision === null ? "" : ` revision ${e.revision}`}`).join(" and ")}; the copies above are as they are now. Send the same choice again to continue it.` };
				choices.set(key, sent);
			}
			el("h4", li, `Record ${String(c.node)}`);
			facts(li, [["Why", recorded(c.kind)], ["From transfer", recorded(c.transfer)], ["Choice", c.state === "resolved" ? `Kept in ${recorded(c.result?.kept ?? c.keep)}` : c.state === "resolving" ? `Unfinished: keeping ${recorded(c.keep)}` : "Not made"]]);
			for (const x of copies) copyFacts(li, x);
			if (sent) {
				el("p", li, sent.text).setAttribute("class", "warn");
				if (sent.state === "unknown" || sent.state === "progress") btn(el("p", li), "Send the same choice again", () => sendChoice(sent), `Send the same choice for ${c.node} again`);
				if (sent.state === "changed") { btn(el("p", li), "Read the copies again", () => { choices.delete(key); render(false); }, `Read the copies of ${c.node} again`); return; }
			}
			if (c.state !== "open" || sent?.state === "unknown" || sent?.state === "progress") return;
			const keepable = copies.filter((x) => x.keepable);
			if (!keepable.length) { note(li, "Neither copy can be kept as it is; only abort is possible for this record."); return; }
			const form = el("form", li), pick = choose(form, `keep-${c.node}`, "Keep the copy in", keepable.map((x) => [String(x.profile), String(x.profile)]));
			const row = el("p", form), preview = el("p", form);
			el("button", row, "Preview").setAttribute("type", "submit");
			let body: Choice["body"] | undefined;
			const go = btn(row, "Keep this copy", () => {
				if (!body || busy() || r.resolving) return;
				const ch: Choice = { body: { ...body, request_id: `dashboard:${crypto.randomUUID()}` }, state: "unknown", text: "Sending…" };
				choices.set(key, ch);
				sendChoice(ch);
			}, `Keep the chosen copy of ${c.node}`);
			go.disabled = true;
			pick.addEventListener("change", () => { body = undefined; go.disabled = true; preview.textContent = ""; });
			form.addEventListener("submit", (event) => {
				event.preventDefault();
				const keep = copies.find((x) => x.profile === pick.value), lose = copies.find((x) => x.profile !== pick.value);
				if (!keep) return;
				// The copies exactly as shown; the server refuses the choice if either has changed since.
				body = { id: String(r.id), node: String(c.node), keep: String(keep.profile), request_id: "",
					expect: copies.map((x) => ({ profile: String(x.profile), generation: x.generation ?? null, status: x.copy?.status ?? null, revision: x.copy?.revision ?? null })) };
				const l = lose?.copy;
				preview.textContent = `Preview: keep “${recorded(keep.copy?.name)}” in ${String(keep.profile)} at revision ${recorded(keep.copy?.revision)}${keep.copy?.status === "moved" ? ", brought back from its archive" : ""}. `
					+ (l && l.status !== "incoming" && l.status !== "moved" ? `The copy in ${String(lose!.profile)} becomes a flagged tombstone; its content and history go to that profile's archive. ` : `Nothing in ${String(lose?.profile ?? "the other profile")} is tombstoned; an unfinished landing there ends. `)
					+ "Unfinished transfers of this record end. Nothing is merged, and the account stays closed until the recovery is opened.";
				go.disabled = busy() || !!r.resolving;
				if (!go.disabled) go.focus();
			});
		};
		const load = async (after?: string) => {
			more.replaceChildren();
			status.textContent = "Reading the copies…";
			let x: J;
			try { x = await call(`/api/recovery/conflicts?id=${enc(String(r.id))}${after ? `&after=${enc(after)}` : ""}`); if (!Array.isArray(x?.conflicts)) throw new Error("the server sent no list"); }
			catch (err) { if (version === am.pageVersion) status.textContent = `Could not read the copies: ${why(err)}`; return; }
			if (version !== am.pageVersion) return;
			status.textContent = `${recorded(x.open)} choice${x.open === 1 ? "" : "s"} still open.`;
			for (const c of x.conflicts) item(c);
			if (x.next) btn(more, "Show more records", () => { void load(String(x.next)); });
		};
		void load();
	};

	// Backups and recovery (section 18): exports, restore of one profile or of the account from an export, and the open
	// recovery's step, open and abort. The backup key stays on the server; this page only asks it to act.
	let lastPit: { id: string; profile: string } | null = null; // the point-in-time restore last opened in this tab, to reverse by its id
	const backupsPage = (view: Node) => {
		const version = am.pageVersion, h = el("h2", view, "Backups and recovery");
		intro(view, "Backups and recovery", "backups", "Restore uses the server's encrypted exports, or a profile's own point-in-time history of the last 30 days.");
		const { say } = pageStatus(view);
		const rec = el("section", view);
		rec.setAttribute("aria-label", "Recovery status");
		rec.setAttribute("class", "panel");
		const forms = el("div", view);
		const confirmBox = (parent: Node, prompt: string, expected: string, go: string, onGo: () => void) => {
			const typed = input(parent, `confirm-${go.replace(/\W+/g, "-").toLowerCase()}`, `${prompt} Type “${expected}” to confirm.`);
			typed.setAttribute("autocomplete", "off");
			const b = btn(el("p", parent), go, onGo);
			b.disabled = true;
			typed.addEventListener("input", () => { b.disabled = typed.value !== expected; });
			return typed;
		};
		const summary = (v: J) => typeof v === "string" ? v : v?.error ? `failed: ${recorded(v.error.message)}`
			: v?.state === "running" ? `running in the background (${String(v.id)}); it lists as an export once complete${v.last?.state === "failed" ? `; the previous one failed: ${recorded(v.last.error)}` : ""}`
			: v && typeof v === "object" ? `saved${v.id ? ` (${String(v.id)})` : ""}${typeof v.rows === "number" ? `, ${v.rows} rows` : ""}` : recorded(v);
		const results = (parent: Node, r: J) => { const ul = el("ul", parent); for (const [k, v] of Object.entries(r ?? {})) el("li", ul, `${k}: ${summary(v)}`); };
		say("Loading recovery status…");
		// A restore gives its profile a new generation, so the drill and new restores take the profile list read now, not at startup.
		const fresh = call("/api/profiles").catch((err: Error) => err);
		(async () => {
			let s: J;
			try { s = await call("/api/recovery"); } catch (err) { if (version === am.pageVersion) say(`Could not read recovery status: ${why(err)}`); return; }
			if (version !== am.pageVersion) return;
			say("");
			// The answer first: when the last backup ran and whether every store saved; its internals sit behind Details.
			const le = s?.last_export, res = Object.values(le?.results ?? {}) as J[], bad = res.filter((v) => v && typeof v === "object" && (v.error || v.state === "failed")).length,
				running = res.filter((v) => v && typeof v === "object" && !v.error && v.state === "running").length;
			const lead = el("p", rec);
			lead.setAttribute("class", "backup-lead");
			if (le) { el("strong", lead, `Last backup ${am.when(le.at).text || recorded(le.at)}`); el("span", lead, ` · ${bad || running ? [`${res.length - bad - running} of ${res.length} saved`, ...(running ? [`${running} still running`] : []), ...(bad ? [`${bad} failed`] : [])].join(", ") : "everything saved"}`); }
			else el("strong", lead, "No backup yet");
			const r = s?.recovery;
			if (r) {
				const account = r.kind === "account";
				el("h3", rec, `A recovery is open: the account is closed`);
				note(rec, account ? "Every profile and every device token is refused until this account restore is opened or aborted. Device tokens must be reissued in Settings afterwards."
					: `Every profile and device is refused until this restore of “${String(r.profile)}” is opened or aborted.`, "danger");
				facts(rec, [["Restoring", account ? "The account's own records" : `Profile ${String(r.profile)}`], ["Restore id", recorded(r.id)], ["From export", recorded(r.export)], ["Export taken", recorded(r.export_at)],
					["Started", recorded(r.at)], ["State", `${recorded(r.state)}${r.phase ? ` (${String(r.phase)})` : ""}`], ["Unresolved findings", recorded(r.unresolved_count)],
					...(r.restored ? [["Checked so far", `${recorded(r.restored.nodes)} records, ${recorded(r.restored.requests)} requests`]] as [string, string][] : [])]);
				if (Array.isArray(r.unresolved) && r.unresolved.length) {
					el("p", rec, "Unresolved findings (those that are not copy choices below can only be aborted):");
					const ul = el("ul", rec);
					for (const u of r.unresolved) el("li", ul, `${recorded(u.kind)}: ${recorded(u.id)}`);
					if (r.unresolved_count > r.unresolved.length) note(rec, `${r.unresolved_count - r.unresolved.length} more are not listed.`);
				}
				// Copy choices exist only while unresolved; after them the server reconciles again and the controls below continue it.
				if (r.state === "unresolved" && (r.conflicts?.total || r.resolving)) conflictsView(rec, r);
				// Every action names the recovery shown here; the server refuses it if another recovery has replaced this one.
				const row = el("p", rec), shownId = { id: String(r.id) }, stepDone = (x: J) => ({ text: `Recovery is now ${recorded(x.state)}${x.phase ? ` (${String(x.phase)})` : ""}.` });
				if (r.state === "ready") note(rec, "Ready to open. Opening makes the restored copy current; for a profile, its previous copy is retired and changes made after the export are no longer current.", "warn");
				else if (r.state === "opening") note(rec, "Opening has started and cannot be aborted. Choose Open again to finish it.", "warn");
				else if (r.state !== "unresolved") btn(row, "Run the next step", () => act("/api/recovery/step", "run the next recovery step", shownId, stepDone));
				if (r.state === "ready" || r.state === "opening") btn(row, "Open", () => act("/api/recovery/open", "open the restored data", shownId, (x) => {
					if (r.kind === "pitr" && x.state === "opened") lastPit = { id: shownId.id, profile: String(r.profile) };
					return { text: `Recovery ${shownId.id} is now ${recorded(x.state)}${x.phase ? ` (${String(x.phase)})` : ""}.${lastPit?.id === shownId.id ? " Its id reverses it under “Restore a profile to a point in time”." : ""}` };
				}));
				if (r.state !== "opening") {
					const ab = el("div", rec);
					confirmBox(ab, account ? "Abort rolls the account back to its state before this restore, step by step; choose Abort again while it is rolling back." : "Abort discards the restored copy and reopens the account unchanged.", "abort", "Abort", () => act("/api/recovery/abort", "abort the recovery", shownId, stepDone));
				}
			} else el("p", rec, "No recovery is open; the account is open.");
			if (le) { const d = el("details", rec); el("summary", d, "Details of the last backup"); el("p", d, `Taken ${am.when(le.at).full || recorded(le.at)}`); results(d, le.results); }
			const list = await fresh;
			if (version !== am.pageVersion) return;
			if (Array.isArray(list)) am.profiles = list;
			else note(rec, `Could not read the profiles again: ${why(list)}. A drill or restore begun below may be refused as stale; reload the page first.`, "warn");
			drillView(rec, !!r);
			if (r) return; // exports and new restores are refused while a recovery is open
			const exp = el("section", forms);
			exp.setAttribute("class", "panel");
			exp.setAttribute("aria-label", "Export now");
			el("h3", exp, "Export now");
			note(exp, "Exports are encrypted on the server. Two complete exports are kept per store, so a new one replaces the oldest. Each profile pauses its writes for up to 30 seconds while it is exported. A corpus exports in the background while uploads continue; only if it cannot catch up do its uploads wait, for at most 30 seconds.");
			const exRow = el("p", exp);
			btn(exRow, "Export everything", () => act("/api/backups/export", "export everything", {}, (x) => ({ text: `Export finished: ${Object.entries(x ?? {}).map(([k, v]) => `${k} ${summary(v)}`).join("; ")}.` })));
			const exProfile = choose(exp, "export-profile", "Or export one profile", active().map((q) => [q.name, q.name]));
			btn(el("p", exp), "Export this profile", () => act("/api/backups/export", `export ${exProfile.value}`, { profile: exProfile.value }, (x) => ({ text: `Export finished: ${Object.entries(x ?? {}).map(([k, v]) => `${k} ${summary(v)}`).join("; ")}.` })));

			const restoreForm = (title: string, listPath: () => string, what: () => string, warning: string, expected: () => string, begin: (exp: string) => [string, unknown]) => {
				const sec = el("section", forms);
				sec.setAttribute("class", "panel");
				sec.setAttribute("aria-label", title);
				el("h3", sec, title);
				note(sec, warning, "danger");
				const pick = el("div", sec);
				return { sec, pick, load: async () => {
					pick.replaceChildren();
					let list: J;
					try { list = await call(listPath()); if (!Array.isArray(list)) throw new Error("the server sent no export list"); } catch (err) { if (version === am.pageVersion) note(pick, `Could not list exports: ${why(err)}`); return; }
					if (version !== am.pageVersion) return;
					if (!list.length) { note(pick, `No exports of ${what()} yet.`); return; }
					const exp = choose(pick, `exp-${title.replace(/\W+/g, "-").toLowerCase()}`, "Export (newest first)", [...list].reverse().map((x: string) => [String(x), String(x)]));
					confirmBox(pick, `Restore ${what()} from the chosen export.`, expected(), `Begin restore of ${what()}`, () => {
						const [path, data] = begin(exp.value);
						act(path, `begin restoring ${what()}`, data, (x) => ({ text: `Recovery ${recorded(x.id)} begun: ${recorded(x.state)}. The account is closed until you open or abort it below.` }));
					});
				} };
			};
			const rp = choose(forms, "restore-profile", "Profile to restore", active().map((q) => [q.name, q.name]));
			const prof = restoreForm("Restore a profile", () => `/api/profiles/${enc(rp.value)}/exports`, () => `profile ${rp.value}`,
				"Beginning closes the whole account: every profile and device is refused until you open or abort. The profile is rebuilt from the export into a new copy; opening it retires the current copy, so changes made after the export are no longer current. Aborting discards the rebuilt copy.",
				() => rp.value, (exp) => [`/api/profiles/${enc(rp.value)}/restore`, { export: exp }]);
			btn(el("p", prof.sec), "List this profile's exports", () => { prof.load(); });
			rp.addEventListener("change", () => prof.pick.replaceChildren());
			const acct = restoreForm("Restore the account", () => "/api/account/exports", () => "the account",
				"Beginning closes the account and disables every device token; reissue them in Settings afterwards. It replaces the account's own records (devices, routing and the profile list) with the export's; the memories inside profiles are restored separately, per profile.",
				() => "restore account", (exp) => ["/api/account/restore", { export: exp }]);
			btn(el("p", acct.sec), "List account exports", () => { acct.load(); });

			// Point-in-time restore of one profile in place, or the reversal of one by the undo bookmark its record keeps.
			const pitSec = el("section", forms);
			pitSec.setAttribute("class", "panel");
			pitSec.setAttribute("aria-label", "Restore a profile to a point in time");
			el("h3", pitSec, "Restore a profile to a point in time");
			note(pitSec, "Beginning closes the whole account. The profile goes back to the chosen time, within the last 30 days; changes after it are no longer current. Its record keeps an undo, so a restore id below reverses it the same way.", "danger");
			const pp = choose(pitSec, "pitr-profile", "Profile", active().map((q) => [q.name, q.name]));
			const when = input(pitSec, "pitr-at", "Time, as ISO (for example 2026-10-27T09:00:00Z)");
			if (lastPit) el("p", pitSec, `Opened in this tab: point-in-time restore ${lastPit.id} of ${lastPit.profile}. Enter that id below to reverse it.`);
			const undo = input(pitSec, "pitr-undo", "Or the id of a point-in-time restore to reverse");
			confirmBox(pitSec, "Restore the chosen profile.", "restore in time", "Begin point-in-time restore", () =>
				act(`/api/profiles/${enc(pp.value)}/pitr`, `restore ${pp.value} in time`, undo.value.trim() ? { undo: undo.value.trim() } : { at: when.value.trim() },
					(x) => ({ text: `Recovery ${recorded(x.id)} begun: ${recorded(x.state)}. The account is closed until you open or abort it below.` })));

			// A profile's corpus: exported weekly and kept two; a restore fills the profile's current, empty corpus.
			btn(el("p", exp), "Export every corpus now", () => act("/api/backups/export", "export every corpus", { corpus: true }, (x) => ({ text: `Export finished: ${Object.entries(x ?? {}).map(([k, v]) => `${k} ${summary(v)}`).join("; ")}.` })));
			const cp = choose(forms, "corpus-profile", "Corpus to restore", active().filter((q) => q.name !== "me").map((q) => [q.name, q.name]));
			const corp = restoreForm("Restore a corpus", () => `/api/profiles/${enc(cp.value)}/corpus/exports`, () => `the corpus of ${cp.value}`,
				"Beginning closes the whole account. The corpus is rebuilt from the export into the profile's current corpus, which must be empty, as after a profile restore. Aborting clears what it wrote.",
				() => cp.value, (exp) => [`/api/profiles/${enc(cp.value)}/corpus/restore`, { export: exp }]);
			btn(el("p", corp.sec), "List this corpus's exports", () => { corp.load(); });
			cp.addEventListener("change", () => corp.pick.replaceChildren());
		})();
		return h;
	};
	am.pages.backups = backupsPage;
}
