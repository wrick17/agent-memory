// Plain English (the local readable-rewrites option, src/readable.ts): a switch above the page, off by default and saved per
// browser. When it is on and ChatGPT is connected, each long text block that library.ts's textOf collapses is rewritten as it
// scrolls into view, top to bottom, a batch at a time, and shows "AI rewrite" with a link back to the original. Inert unless the
// page says the server has the option on (<html data-readable="on">). Rewrites go through am.md, the safe DOM-only markdown.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am, J, Node } from "./am";

export function readable(am: Am): void {
	const { el, win, doc } = am;
	if (doc.documentElement?.getAttribute?.("data-readable") !== "on") return;
	const KEY = "am.readable", BATCH = 8, MAX = 20_000, USAGE = "https://chatgpt.com/settings/usage";
	const cls = (e: Node, c: string) => { e.setAttribute("class", c); return e; };
	const saved = () => { try { return win.localStorage?.getItem(KEY) === "on"; } catch { return false; } };
	const save = (v: boolean) => { try { win.localStorage?.setItem(KEY, v ? "on" : "off"); } catch { /* off next time */ } };
	type Block = { box: J; more: J; text: string; alt: J; body: J; flip: J; rewrite: string | null; original: boolean; asked: boolean };
	let on = saved(), status: { connected: boolean; email: string | null; model: boolean | null; backend: string } | null = null;
	let halt: { text: string; usage?: boolean } | null = null, note = "", busy = false;
	let blocks: Block[] = [];
	const queue: Block[] = [];
	let bar: J = null;
	const active = () => on && !!status?.connected && status.model !== false && !halt;

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

	const watch = (b: Block) => {
		if (b.asked || b.rewrite || !active()) return;
		// Each block has its own observer; the short wait lets blocks that came into view together share one batch.
		const seen = () => { if (!b.asked) { b.asked = true; queue.push(b); win.setTimeout(() => void pump(), 400); } };
		if (!am.observe(b.box, (stop) => { stop(); seen(); }, "200px 0px")) seen();
	};
	const watchAll = () => { blocks = blocks.filter((b) => b.box.isConnected); for (const b of blocks) watch(b); };

	/** One request at a time: the topmost waiting blocks first, at most BATCH per call. Stops on a limit or an error. */
	const pump = async () => {
		if (busy || !active()) return;
		const live = [...new Set(queue.splice(0))].filter((b) => b.box.isConnected && !b.rewrite);
		if (!live.length) return;
		live.sort((a, b) => (a.box.compareDocumentPosition(b.box) & 4 ? -1 : 1)); // 4: b follows a
		const batch = live.slice(0, BATCH);
		queue.push(...live.slice(BATCH));
		busy = true;
		try {
			const r = await am.call("/api/readable/rewrite", "POST", { texts: batch.map((b, id) => ({ id, text: b.text })) });
			for (const x of r.results ?? []) { const b = batch[x.id]; if (b && typeof x.rewrite === "string") showRewrite(b, x.rewrite); }
			if (r.state === "limit") halt = { text: `${String(r.message ?? "Rewrite limit reached.")} Rewrites are paused.`, usage: status?.backend === "chatgpt" };
			else if (r.state === "model_unavailable") { if (status) status.model = false; }
			else if (r.state === "not_connected") { if (status) status.connected = false; }
			else if (r.state !== "ok") halt = { text: String(r.message ?? "Rewrites failed.") };
			// A block left unanswered goes back to the queue only after a stop; otherwise it keeps its original text.
			if (r.state !== "ok") for (const b of batch) if (!b.rewrite) b.asked = false;
		} catch (err) {
			halt = { text: `Rewrites failed: ${am.why(err)}` };
			for (const b of batch) b.asked = false;
		} finally { busy = false; }
		paint();
		if (active()) void pump();
	};

	const button = (parent: J, text: string, onClick: () => void) => {
		const b = el("button", parent, text);
		b.setAttribute("type", "button");
		b.addEventListener("click", onClick);
		return b;
	};
	const paint = () => {
		if (!bar) return;
		bar.replaceChildren();
		const sw = cls(button(bar, "Plain English", () => {
			on = !on; save(on); halt = null; note = "";
			// Blocks queued or sent while it was off start over: they are watched again and the queue is pumped.
			queue.length = 0;
			for (const b of blocks) { if (!b.rewrite) b.asked = false; apply(b); }
			paint();
			watchAll();
			void pump();
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
			cls(button(bar, "Try again", () => { halt = null; paint(); watchAll(); void pump(); }), "linklike");
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

	/** library.ts textOf calls this for each text block it collapses behind "Show more". */
	am.readable = (box: Node, text: string, more: Node | null) => {
		if (text.length > MAX) return;
		const b: Block = { box, more, text, alt: null, body: null, flip: null, rewrite: null, original: false, asked: false };
		blocks.push(b);
		watch(b);
	};

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
		watchAll();
	};
}
