// Plain English (the local readable-rewrites option, src/readable.ts): a switch above the page, off by default and saved per
// browser. When it is on and ChatGPT is connected, each long text block that library.ts's textOf collapses is rewritten as it
// scrolls into view, top to bottom, a batch at a time, and shows "AI rewrite" with a link back to the original. Inert unless the
// page says the server has the option on (<html data-readable="on">). Rewrites go through am.md, the safe DOM-only markdown.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node } from "./am";

export function readable(am: Am): void {
	const { el, win, doc } = am;
	if (doc.documentElement?.getAttribute?.("data-readable") !== "on") return;
	// Small requests fired together fill the view in progressively: BATCH texts each (at most MAX_TEXTS in src/domain/rewrite.ts,
	// which this serialized browser code cannot import), FLY of them in flight at once.
	const KEY = "am.readable", BATCH = 3, FLY = 8, MAX = 20_000, USAGE = "https://chatgpt.com/settings/usage";
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const saved = () => { try { return win.localStorage?.getItem(KEY) === "on"; } catch { return false; } };
	const save = (v: boolean) => { try { win.localStorage?.setItem(KEY, v ? "on" : "off"); } catch { /* off next time */ } };
	// A request in flight: its texts, its abort handle and when it was sent (its cards' live counter).
	type Run = { texts: Set<string>; ctl: J; since: number };
	// state: "" not asked, "wait" in view and queued, "fly" in request `run`, "fail" left without a rewrite.
	type Block = { box: J; more: J; text: string; alt: J; body: J; flip: J; rewrite: string | null; original: boolean; vis: boolean;
		state: "" | "wait" | "fly" | "fail"; run: Run | null; kind: string; line: J; say: J; secs: J; spin: J; again: J };
	let on = saved(), status: { connected: boolean; email: string | null; model: boolean | null; backend: string } | null = null;
	let halt: { text: string; usage?: boolean; limit?: boolean } | null = null, note = "";
	let blocks: Block[] = [];
	const done = new Map<string, string>(); // rewrites by source text, so a re-rendered or revisited card shows its rewrite at once
	let bar: J = null, wake = 0, tick = 0;
	const runs = new Set<Run>();
	const runOf = (text: string) => [...runs].find((r) => r.texts.has(text)) ?? null;
	const ready = () => on && !!status?.connected && status.model !== false;
	const active = () => ready() && !halt;

	/** Shows the rewrite or the original for one block, as the switch and its own link say. */
	const apply = (b: Block) => {
		const rw = on && !!b.rewrite && !b.original;
		b.box.hidden = rw;
		if (b.more) b.more.hidden = rw;
		if (!b.alt) return;
		b.alt.hidden = !on || !b.rewrite;
		b.body.hidden = !rw;
		b.alt.querySelector(".tag").hidden = !rw;
		b.flip.textContent = rw ? "Show original" : "Show AI rewrite";
	};
	const showRewrite = (b: Block, text: string) => {
		b.rewrite = text;
		b.state = "";
		if (!b.alt) {
			b.alt = cls(el("div"), "rw");
			b.box.parentNode.insertBefore(b.alt, b.box);
			const head = cls(el("p", b.alt), "rw-head");
			cls(el("span", head, "AI rewrite"), "tag rw-tag");
			b.flip = cls(el("button", head), "linklike");
			b.flip.setAttribute("type", "button");
			b.flip.addEventListener("click", () => { b.original = !b.original; apply(b); });
			b.body = am.md(b.alt, text);
		}
		apply(b);
	};

	/** The card's status line where "AI rewrite" will appear: Waiting…, Rewriting… with a live counter, or a failure with Try again.
	 * Only the words sit in the live region, so a screen reader hears each change of state, not every second. */
	const line = (b: Block) => {
		const kind = !ready() || b.rewrite || !b.box.isConnected ? "" : b.state === "fly" ? "run"
			: b.state === "fail" || (halt && b.state === "wait") ? (halt?.limit ? "limit" : "fail") : b.state === "wait" ? "wait" : "";
		if (kind === b.kind) return;
		b.kind = kind;
		if (!kind) { b.line?.remove(); b.line = null; return; }
		if (!b.line) {
			b.line = cls(el("p"), "rw-head rw-status");
			b.spin = cls(el("span", b.line), "rw-spin");
			b.spin.setAttribute("aria-hidden", "true");
			b.say = el("span", b.line);
			b.say.setAttribute("role", "status");
			b.say.setAttribute("aria-live", "polite");
			b.secs = cls(el("span", b.line), "rw-secs");
			b.secs.setAttribute("aria-hidden", "true");
			b.again = cls(button(b.line, "Try again", retry), "linklike");
			b.box.parentNode.insertBefore(b.line, b.box);
		}
		b.say.textContent = kind === "run" ? "Rewriting…" : kind === "wait" ? "Waiting…" : kind === "limit" ? "Rewrite limit reached." : "Couldn't rewrite.";
		b.spin.hidden = b.secs.hidden = kind !== "run";
		b.again.hidden = kind !== "fail" && kind !== "limit";
		b.line.classList.toggle("bad", !b.again.hidden);
		if (kind === "run") b.secs.textContent = secs(b);
	};
	const secs = (b: Block) => `${b.run ? Math.floor((Date.now() - b.run.since) / 1000) : 0}s`;
	/** Syncs every card's status line, and runs one shared one-second ticker only while a card shows Rewriting…. */
	const mark = () => {
		for (const b of blocks) line(b);
		const need = blocks.some((b) => b.kind === "run");
		if (need && !tick) tick = win.setInterval(() => { for (const b of blocks) if (b.kind === "run") b.secs.textContent = secs(b); }, 1000);
		else if (!need && tick) { win.clearInterval(tick); tick = 0; }
	};

	// One observer for all cards: whether each is in the viewport now, so only cards in view are asked for, and leaving cancels.
	const IO = win.IntersectionObserver;
	const io = typeof IO === "function" ? new IO((entries: J[]) => {
		for (const e of entries) { const b = blocks.find((x) => x.box === e.target); if (b) b.vis = e.isIntersecting; }
		review();
	}) : null;
	/** Applies the latest view: forgets cards that left the page, queues cards in view, drops queued cards out of view, and aborts
	 * each request once none of its cards is in view (the cards go back to unasked, so they are asked again on return). */
	const review = () => {
		blocks = blocks.filter((b) => { if (b.box.isConnected) return true; io?.unobserve(b.box); b.line?.remove(); return false; });
		for (const b of blocks) {
			if (b.rewrite || b.state === "fail") continue;
			const want = active() && b.vis;
			const run = want ? runOf(b.text) : null;
			if (run) { b.state = "fly"; b.run = run; }
			else if (want && b.state !== "fly") { b.state = "wait"; soon(); }
			else if (!want && b.state === "wait") b.state = "";
		}
		for (const r of runs) if (!blocks.some((b) => b.vis && b.state === "fly" && b.run === r)) r.ctl.abort();
		mark();
	};
	/** Sends once navigation or scrolling has settled for 150 ms, so the requests cover the whole view at once. */
	const soon = () => { win.clearTimeout(wake); wake = win.setTimeout(() => { wake = 0; pump(); }, 150); };
	const retry = () => { halt = null; for (const b of blocks) if (b.state === "fail") b.state = ""; paint(); review(); };

	const post = async (texts: { id: number; text: string }[], signal: J) => {
		const res = await win.fetch("/api/readable/rewrite", { method: "POST", signal,
			headers: { authorization: `Bearer ${await am.token()}`, "content-type": "application/json" }, body: JSON.stringify({ texts }) });
		const body = await res.json().catch(() => ({}));
		// The rewriter is busy (503, or the Worker's relayed "returned 503"): the caller waits its retry-after and tries once more.
		if (res.status === 503 || body.state === "busy" || (body.state === "error" && /\b503\b/.test(String(body.message ?? ""))))
			return { busy: Math.min(60, Number(res.headers.get("retry-after")) || 5) };
		if (!res.ok) throw new Error(body.error?.message ?? (typeof body.error === "string" ? body.error : `HTTP ${res.status}`));
		return body;
	};
	/** Splits the cards in view, top to bottom (the summary first), into requests of BATCH texts and fires them together, at most
	 * FLY in flight; the rest wait for a free slot. Known rewrites never reach here (am.readable shows them at once). */
	const pump = () => {
		if (!active()) return;
		const live = blocks.filter((b) => b.state === "wait" && b.vis && b.box.isConnected);
		live.sort((a, b) => (a.box.compareDocumentPosition(b.box) & 4 ? -1 : 1)); // 4: b follows a
		const texts = [...new Set(live.map((b) => b.text))];
		while (texts.length && runs.size < FLY) void send(texts.splice(0, BATCH));
		mark();
	};
	/** One request: its cards resolve as soon as it answers, whatever the others do. */
	const send = async (texts: string[]) => {
		const run: Run = { texts: new Set(texts), ctl: new win.AbortController(), since: Date.now() };
		runs.add(run);
		for (const b of blocks) if (b.state === "wait" && run.texts.has(b.text)) { b.state = "fly"; b.run = run; }
		const left = (to: Block["state"]) => { for (const b of blocks) if (b.state === "fly" && b.run === run) { b.state = to; b.run = null; } };
		try {
			const items = texts.map((text, id) => ({ id, text }));
			let r = await post(items, run.ctl.signal);
			if (r.busy) {
				// The cards keep counting while it waits; leaving the view still aborts the wait.
				await new Promise((ok, no) => { const t = win.setTimeout(ok, r.busy * 1000); run.ctl.signal.addEventListener("abort", () => { win.clearTimeout(t); no(new Error("aborted")); }); });
				r = await post(items, run.ctl.signal);
				if (r.busy) r = { state: "error", message: "The rewriter is busy. Try again in a moment." };
			}
			for (const x of r.results ?? []) {
				const t = texts[x.id];
				if (t === undefined || typeof x.rewrite !== "string") continue;
				done.set(t, x.rewrite);
				for (const b of blocks) if (b.text === t) showRewrite(b, x.rewrite);
			}
			if (r.state === "limit") halt = { text: `${String(r.message ?? "Rewrite limit reached.")} Rewrites are paused.`, usage: status?.backend === "chatgpt", limit: true };
			else if (r.state === "model_unavailable") { if (status) status.model = false; }
			else if (r.state === "not_connected") { if (status) status.connected = false; }
			else if (r.state !== "ok") halt = { text: String(r.message ?? "Rewrites failed.") };
			// A card the answer left out says so, with Try again, rather than waiting forever.
			left(r.state === "model_unavailable" || r.state === "not_connected" ? "" : "fail");
		} catch (err) {
			// An abort (the cards left the view or the switch went off) is silent: the cards are asked again if they come back.
			if (run.ctl.signal.aborted) left("");
			else { halt = { text: `Rewrites failed: ${am.why(err)}` }; left("fail"); }
		} finally { runs.delete(run); }
		paint();
		review();
		pump();
	};

	const button = (parent: J, text: string, onClick: () => void) => {
		const b = el("button", parent, text);
		b.setAttribute("type", "button");
		b.addEventListener("click", onClick);
		return b;
	};
	const paint = () => {
		mark();
		if (!bar) return;
		bar.replaceChildren();
		const sw = cls(button(bar, "Plain English", () => {
			on = !on; save(on); halt = null; note = "";
			// Off cancels the running requests; either way every card starts over from the current view.
			for (const r of runs) r.ctl.abort();
			for (const b of blocks) { if (!b.rewrite) b.state = ""; apply(b); }
			paint();
			review();
		}), "rswitch");
		sw.setAttribute("role", "switch");
		sw.setAttribute("aria-checked", String(on));
		sw.setAttribute("title", "Show an AI rewrite of long text in plain English");
		if (!on) return;
		const msg = cls(el("span", bar), "rmsg");
		msg.setAttribute("role", "status");
		if (!status) { msg.textContent = "Checking ChatGPT…"; return; }
		if (!status.connected) {
			cls(button(bar, "Connect ChatGPT", async () => {
				try { const r = await am.call("/api/readable/connect", "POST", {}); win.location.assign(r.url); } catch (err) { note = am.why(err); paint(); }
			}), "rconnect");
			msg.textContent = note || "Rewrites use your ChatGPT plan.";
			return;
		}
		if (status.model === false) msg.textContent = "gpt-6-luna is not available on this ChatGPT account, so rewrites are off.";
		else if (halt) {
			msg.textContent = halt.text;
			if (halt.usage) { const a = el("a", bar, "ChatGPT usage"); a.setAttribute("href", USAGE); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer"); }
			cls(button(bar, "Try again", retry), "linklike");
		} else msg.textContent = note || (status.backend === "rewriter" ? "Rewrites come from your rewriter service." : `Connected${status.email ? ` as ${status.email}` : ""}.`);
		if (status.backend === "chatgpt") cls(button(bar, "Disconnect ChatGPT", async () => {
			try {
				const r = await am.call("/api/readable/disconnect", "POST", {});
				status = { connected: false, email: null, model: null, backend: "chatgpt" };
				note = r.revoked ? "Disconnected." : "Disconnected here. OpenAI did not confirm it, so you can also remove the app in ChatGPT settings.";
			} catch (err) { note = am.why(err); }
			paint();
		}), "linklike");
	};

	/** library.ts calls this for each text block it collapses behind "Show more", and for journal entries, summaries and descriptions of 160+ characters. */
	am.readable = (box: Node, text: string, more: Node | null) => {
		if (text.length > MAX) return;
		const b: Block = { box, more, text, alt: null, body: null, flip: null, rewrite: null, original: false, vis: !io,
			state: "", run: null, kind: "", line: null, say: null, secs: null, spin: null, again: null };
		blocks.push(b);
		const known = done.get(text);
		if (known !== undefined) showRewrite(b, known);
		if (io) io.observe(box); else review(); // the observer's first report says whether it is in view
	};
	// Moving to another page: review once it has drawn, so a request for cards that are gone is cancelled even when the new
	// page has no long text (the observer may not report removed cards).
	win.addEventListener("hashchange", () => win.setTimeout(review, 0));

	// After sign-in: the bar above the view, then the connection state.
	const boot = am.boot;
	am.boot = async () => {
		await boot();
		const view = am.$("view");
		if (!view || view.hidden) return; // not signed in
		bar = cls(el("div"), "rbar");
		bar.setAttribute("role", "group");
		bar.setAttribute("aria-label", "Plain English rewrites");
		view.parentNode.insertBefore(bar, view);
		paint();
		try { status = await am.call("/api/readable"); } catch (err) { status = { connected: false, email: null, model: null, backend: "chatgpt" }; note = am.why(err); }
		paint();
		review();
	};
}
