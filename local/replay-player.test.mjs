// The shared replay player (local/replay-player.js) in a VM with a minimal DOM and a manual clock: order-only and real-offset
// timing, controls, keys, text-only rendering and cleanup. The player is a classic browser script, so it runs as the
// dashboard runs it: after a "use strict" directive, defining only globalThis.amReplayPlayer.
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("./replay-player.js", import.meta.url), "utf8");

// Just the DOM the player uses. Writing innerHTML throws, so any HTML path fails the test.
function makeDom() {
	const doc = { listeners: {} };
	class Node {
		constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), nodeType: 1, ownerDocument: doc, children: [], attrs: {}, listeners: {}, dataset: {},
			parentNode: null, text: "", tabIndex: 0, disabled: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0 }); }
		appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
		removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
		get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
		set textContent(v) { this.children = []; this.text = String(v); }
		set innerHTML(_v) { throw new Error("innerHTML used"); }
		setAttribute(k, v) { this.attrs[k] = String(v); }
		getAttribute(k) { return this.attrs[k] ?? null; }
		addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
		contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
		get isConnected() { return doc.documentElement.contains(this); }
		getClientRects() { return this.hidden ? [] : [{}]; }
		getBoundingClientRect() { return { top: 0, bottom: 0 }; }
		focus() { doc.activeElement = this; }
		click() { for (const f of this.listeners.click ?? []) f({}); }
	}
	doc.createElement = (tag) => new Node(tag);
	doc.addEventListener = (t, f) => (doc.listeners[t] ||= []).push(f);
	doc.removeEventListener = (t, f) => { doc.listeners[t] = (doc.listeners[t] ?? []).filter((x) => x !== f); };
	doc.documentElement = new Node("html");
	doc.body = doc.documentElement.appendChild(new Node("body"));
	return doc;
}

let doc, clock, player, root;
beforeEach(() => {
	doc = makeDom();
	clock = { now: 0, timers: new Map(), id: 0 };
	const context = {
		setTimeout: (f, ms) => { clock.timers.set(++clock.id, { f, at: clock.now + ms }); return clock.id; },
		clearTimeout: (id) => clock.timers.delete(id),
		console,
	};
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(`"use strict";\n${SOURCE}`, context);
	assert.deepEqual(Object.keys(context).filter((k) => !["setTimeout", "clearTimeout", "console", "globalThis"].includes(k)), ["amReplayPlayer"]);
	player = context.amReplayPlayer;
	root = doc.body.appendChild(doc.createElement("div"));
});

function advance(ms) {
	const end = clock.now + ms;
	for (;;) {
		const due = [...clock.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
		if (!due) break;
		clock.timers.delete(due[0]);
		clock.now = due[1].at;
		due[1].f();
	}
	clock.now = end;
}
const find = (n, test) => (test(n) ? n : n.children.map((c) => find(c, test)).find(Boolean));
const byClass = (cls) => find(root, (n) => n.className === cls);
const button = (text) => find(root, (n) => n.tagName === "BUTTON" && n.textContent.includes(text));
const key = (k, target = doc.body) => {
	const ev = { key: k, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
	for (const f of doc.listeners.keydown ?? []) f(ev);
	return ev;
};
const hosted = (n) => Array.from({ length: n }, (_, i) => ({ i, kind: "decision", label: `decision ${i}`, offset_ms: null, detail: { part: `p${i}` } }));

describe("replay player", () => {
	it("plays order-only events one per second at 1x and scales with speed, without inventing a clock", () => {
		const seen = [];
		const c = player.mount(root, hosted(4), { onEvent: (e) => seen.push(e.i) });
		assert.equal(byClass("replay-position").textContent, "event 1 of 4 · order only");
		c.play();
		advance(999);
		assert.deepEqual(seen, []);
		advance(1);
		assert.deepEqual(seen, [1]);
		c.setSpeed(2);
		advance(500);
		assert.deepEqual(seen, [1, 2]);
		advance(500);
		assert.deepEqual(seen, [1, 2, 3]);
		assert.equal(clock.timers.size, 0, "stops at the last event");
		assert.equal(button("Play").textContent, "Play");
	});

	it("waits the real gap between transcript offsets, uncompressed", () => {
		const seen = [];
		const events = [
			{ i: 0, kind: "prompt", label: "hi", offset_ms: 0, detail: { role: "owner" } },
			{ i: 1, kind: "tool_call", label: "ls", offset_ms: 2500, detail: { tool: "Bash" } },
			{ i: 2, kind: "response", label: "done", offset_ms: 3_602_500, detail: {} },
		];
		const c = player.mount(root, events, { onEvent: (e) => seen.push(e.i) });
		assert.equal(byClass("replay-position").textContent, "event 1 of 3 · 0:00 of 1:00:02");
		c.play();
		advance(2499);
		assert.deepEqual(seen, []);
		advance(1);
		assert.deepEqual(seen, [1]);
		advance(3_599_999);
		assert.deepEqual(seen, [1]);
		advance(1);
		assert.deepEqual(seen, [1, 2]);
		assert.equal(byClass("replay-position").textContent, "event 3 of 3 · 1:00:02 of 1:00:02");
	});

	it("drives playback from the buttons and the keys", () => {
		player.mount(root, hosted(3));
		const at = () => byClass("replay-position").textContent.slice(0, 12);
		button("Next").click();
		assert.equal(at(), "event 2 of 3");
		button("Start").click();
		assert.equal(at(), "event 1 of 3");
		assert.ok(key("ArrowRight").defaultPrevented);
		assert.equal(at(), "event 2 of 3");
		key("ArrowLeft");
		assert.equal(at(), "event 1 of 3");
		key(" ");
		assert.equal(clock.timers.size, 1, "Space plays");
		key(" ");
		assert.equal(clock.timers.size, 0, "Space pauses");
		const speed = button("4x");
		speed.click();
		assert.equal(speed.getAttribute("aria-pressed"), "true");
		assert.equal(button("1x").getAttribute("aria-pressed"), "false");

		const input = doc.body.appendChild(doc.createElement("input"));
		assert.ok(!key("ArrowRight", input).defaultPrevented, "typing in a field is left alone");
		const elsewhere = doc.body.appendChild(doc.createElement("ul"));
		assert.ok(!key("ArrowRight", elsewhere).defaultPrevented, "keys in other parts of the page are left alone");
		root.hidden = true;
		assert.ok(!key("ArrowRight").defaultPrevented, "a hidden player ignores keys");
		assert.equal(at(), "event 1 of 3");
	});

	it("renders labels and details as text", () => {
		const label = "<img src=x onerror=alert(1)>";
		player.mount(root, [{ i: 0, kind: "tool_result", label, offset_ms: 0, detail: { tool: "<b>Bash</b>", output: "x", truncated: "true" } }]);
		const detail = byClass("replay-detail").textContent;
		assert.ok(detail.includes(label) && detail.includes("<b>Bash</b>"));
		assert.ok(detail.includes("Tool output cut at 8 KB."));
		assert.ok(byClass("replay-list").textContent.includes(label));
	});

	it("destroy removes its view, key listener and timer, and is idempotent", () => {
		const c = player.mount(root, hosted(3));
		c.play();
		assert.equal(clock.timers.size, 1);
		c.destroy();
		c.destroy();
		assert.equal(root.children.length, 0);
		assert.equal(clock.timers.size, 0);
		assert.equal((doc.listeners.keydown ?? []).length, 0);
		c.play();
		c.step(1);
		assert.equal(clock.timers.size, 0, "methods do nothing after destroy");
	});

	it("rejects a missing root and shows an empty session", () => {
		assert.throws(() => player.mount(null, []), /root must be an element/);
		const c = player.mount(root, "not a list");
		assert.equal(byClass("replay-position").textContent, "No events");
		c.play();
		assert.equal(clock.timers.size, 0);
	});
});
