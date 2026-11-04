// Replay player (P1): browser JavaScript for the dashboard's Replay tab and the local replay viewer, which both load these
// exact bytes (the dashboard runs them after a "use strict" directive). A classic script, not a module: its only global
// effect is defining globalThis.amReplayPlayer. It sets every value as text, never as HTML.
//
// amReplayPlayer.mount(root, events, options) -> { play(), pause(), step(delta), seek(i), setSpeed(x), destroy() }
//   root: an Element; events: ReplayEvent[] ({ i, kind, label, offset_ms, detail }); options: { speeds?: number[], onEvent?(e) }.
//   The player draws its controls, the event list and the event detail into a container it appends to root.
//   When offset_ms is null the player advances one event per second at 1x; real offsets wait for the real gap between
//   events, divided by the speed. onEvent(e) runs when the current event changes. Keys, while mounted and visible: Space plays or pauses; Left and Right step; in the event list, Up and Down
//   step and Home and End jump. destroy() stops the timer, removes the key listener and the container, and may run twice.
(function () {
	"use strict";

	var KINDS = { prompt: "Prompt", response: "Response", tool_call: "Tool call", tool_result: "Tool result",
		ask: "Ask", decision: "Decision", correction: "Correction", outcome: "Outcome" };
	var DETAIL_NAMES = { role: "Role", tool: "Tool", input: "Input", output: "Output", outcome: "Outcome",
		part: "Digest part", pos: "Transcript position" };
	var DETAIL_ORDER = ["role", "tool", "input", "output", "outcome", "part", "pos"];
	var LONG = { input: true, output: true };
	var DEFAULT_SPEEDS = [0.5, 1, 2, 4];
	var ORDER_STEP_MS = 1000; // one event per second at 1x when there is no real offset
	var LIST_LABEL = 160; // characters of the label shown in the list; the detail shows all of it

	function str(v) { return typeof v === "string" ? v : v == null ? "" : String(v); }

	// Boundary check: keep only well-formed events, as plain copies, so later host changes to the array cannot affect playback.
	function clean(events) {
		var out = [];
		if (!Array.isArray(events)) return out;
		for (var k = 0; k < events.length; k++) {
			var e = events[k];
			if (!e || typeof e !== "object") continue;
			var off = typeof e.offset_ms === "number" && isFinite(e.offset_ms) && e.offset_ms >= 0 ? e.offset_ms : null;
			var detail = {};
			if (e.detail && typeof e.detail === "object") {
				for (var key in e.detail) {
					if (Object.prototype.hasOwnProperty.call(e.detail, key) && typeof e.detail[key] === "string") detail[key] = e.detail[key];
				}
			}
			out.push({ i: typeof e.i === "number" ? e.i : k, kind: str(e.kind), label: str(e.label), offset_ms: off, detail: detail, source: e });
		}
		return out;
	}

	function cleanSpeeds(speeds) {
		var out = [];
		var list = Array.isArray(speeds) && speeds.length ? speeds : DEFAULT_SPEEDS;
		for (var k = 0; k < list.length; k++) {
			var s = list[k];
			if (typeof s === "number" && isFinite(s) && s > 0 && s <= 64 && out.indexOf(s) < 0) out.push(s);
		}
		return out.length ? out : DEFAULT_SPEEDS.slice();
	}

	function clock(ms) {
		var t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
		var ss = (s < 10 ? "0" : "") + s;
		return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + ss : m + ":" + ss;
	}

	function speedText(s) { return s + "x"; }

	function short(t) {
		var line = t.replace(/\s+/g, " ").trim();
		return line.length > LIST_LABEL ? line.slice(0, LIST_LABEL - 1) + "…" : line;
	}

	function mount(root, events, options) {
		var doc = root && root.ownerDocument;
		if (!doc || typeof root.appendChild !== "function") throw new TypeError("amReplayPlayer.mount: root must be an element");
		var opts = options && typeof options === "object" ? options : {};
		var list = clean(events);
		var speeds = cleanSpeeds(opts.speeds);
		var onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
		var n = list.length;
		var timed = false, total = 0;
		for (var k = 0; k < n; k++) {
			if (list[k].offset_ms !== null) { timed = true; if (list[k].offset_ms > total) total = list[k].offset_ms; }
		}
		var cur = 0, playing = false, timer = null, destroyed = false;
		var speed = speeds.indexOf(1) >= 0 ? 1 : speeds[0];

		function el(tag, parent, text, cls) {
			var node = doc.createElement(tag);
			if (cls) node.className = cls;
			if (text != null) node.textContent = text;
			if (parent) parent.appendChild(node);
			return node;
		}
		function button(parent, text, label, fn) {
			var b = el("button", parent, text);
			b.type = "button";
			if (label) b.setAttribute("aria-label", label);
			b.addEventListener("click", fn);
			return b;
		}

		// ---- Layout ----
		var box = el("div", null, null, "replay");
		var controls = el("div", box, null, "replay-controls");
		controls.setAttribute("role", "group");
		controls.setAttribute("aria-label", "Replay controls");
		var startBtn = button(controls, "⏮ Start", "Back to start", function () { seek(0); });
		var prevBtn = button(controls, "◀ Previous", "Previous event", function () { step(-1); });
		var playBtn = button(controls, "Play", null, function () { if (playing) pause(); else play(); });
		var nextBtn = button(controls, "Next ▶", "Next event", function () { step(1); });
		var speedBox = el("span", controls, null, "replay-speeds");
		speedBox.setAttribute("role", "group");
		speedBox.setAttribute("aria-label", "Speed");
		var speedBtns = speeds.map(function (s) {
			var b = button(speedBox, speedText(s), "Speed " + speedText(s), function () { setSpeed(s); });
			b.dataset.speed = String(s);
			return b;
		});
		var position = el("span", controls, null, "replay-position");

		var body = el("div", box, null, "replay-body");
		var listEl = el("ol", body, null, "replay-list");
		listEl.setAttribute("role", "listbox");
		listEl.setAttribute("aria-label", "Events");
		var detail = el("section", body, null, "replay-detail");
		detail.setAttribute("aria-label", "Event detail");

		var items = list.map(function (e, pos) {
			var li = el("li", listEl, null, "replay-event");
			li.setAttribute("role", "option");
			li.setAttribute("aria-selected", "false");
			li.tabIndex = -1;
			el("span", li, KINDS[e.kind] || e.kind || "Event", "chip kind-" + (KINDS[e.kind] ? e.kind : "other"));
			el("span", li, " " + short(e.label), "replay-label");
			if (e.offset_ms !== null) el("span", li, " " + clock(e.offset_ms), "replay-time");
			li.addEventListener("click", function () { seek(pos); });
			return li;
		});

		if (!n) {
			el("p", body, "No events in this session.", "na");
			[startBtn, prevBtn, playBtn, nextBtn].concat(speedBtns).forEach(function (b) { b.disabled = true; });
		}
		root.appendChild(box);

		// ---- Rendering ----
		function renderDetail() {
			detail.textContent = "";
			var e = list[cur];
			if (!e) return;
			var head = (KINDS[e.kind] || e.kind || "Event") + " · event " + (cur + 1) + " of " + n;
			if (e.offset_ms !== null) head += " · " + clock(e.offset_ms);
			el("h3", detail, head);
			if (e.label) el("div", detail, e.label, "text");
			var keys = DETAIL_ORDER.filter(function (key) { return key in e.detail; });
			for (var key in e.detail) if (DETAIL_ORDER.indexOf(key) < 0 && key !== "truncated") keys.push(key);
			var dl = null;
			keys.forEach(function (key) {
				var value = e.detail[key];
				if (LONG[key]) {
					el("h4", detail, DETAIL_NAMES[key]);
					el("div", detail, value, "text");
				} else {
					if (!dl) dl = el("dl", detail);
					el("dt", dl, DETAIL_NAMES[key] || key);
					el("dd", dl, value);
				}
			});
			if (e.detail.truncated === "true") el("p", detail, "Tool output cut at 8 KB.", "na");
		}

		function reveal(li) {
			if (!li || !listEl.getBoundingClientRect || listEl.scrollHeight <= listEl.clientHeight) return;
			var lr = listEl.getBoundingClientRect(), ir = li.getBoundingClientRect();
			if (ir.top < lr.top) listEl.scrollTop += ir.top - lr.top;
			else if (ir.bottom > lr.bottom) listEl.scrollTop += ir.bottom - lr.bottom;
		}

		function render(prev) {
			if (!n) { position.textContent = "No events"; return; }
			if (prev !== undefined && items[prev]) { items[prev].setAttribute("aria-selected", "false"); items[prev].tabIndex = -1; }
			var li = items[cur];
			li.setAttribute("aria-selected", "true");
			li.tabIndex = 0;
			reveal(li);
			var text = "event " + (cur + 1) + " of " + n + " · ";
			if (!timed) text += "order only";
			else text += (list[cur].offset_ms === null ? "–" : clock(list[cur].offset_ms)) + " of " + clock(total);
			position.textContent = text;
			playBtn.textContent = playing ? "Pause" : "Play";
			startBtn.setAttribute("aria-disabled", cur === 0 ? "true" : "false");
			prevBtn.setAttribute("aria-disabled", cur === 0 ? "true" : "false");
			nextBtn.setAttribute("aria-disabled", cur === n - 1 ? "true" : "false");
			speedBtns.forEach(function (b) { b.setAttribute("aria-pressed", Number(b.dataset.speed) === speed ? "true" : "false"); });
			renderDetail();
		}

		// ---- Playback ----
		function delay(from) {
			var a = list[from].offset_ms, b = list[from + 1] ? list[from + 1].offset_ms : null;
			var gap = a !== null && b !== null ? Math.max(b - a, 0) : ORDER_STEP_MS;
			return Math.min(gap / speed, 2147483647); // setTimeout fires at once past 2^31-1 ms
		}
		function clear() { if (timer !== null) { clearTimeout(timer); timer = null; } }
		function schedule() {
			clear();
			if (!playing || destroyed) return;
			if (cur >= n - 1) { playing = false; render(); return; }
			timer = setTimeout(tick, delay(cur));
		}
		function tick() {
			timer = null;
			if (destroyed || !playing) return;
			if (!root.isConnected) { playing = false; return; } // the host dropped the view without destroy(): stop quietly
			move(cur + 1);
			schedule();
		}
		function move(to) {
			if (!n) return;
			var next = Math.max(0, Math.min(n - 1, to));
			if (next === cur) { render(); return; }
			var prev = cur;
			cur = next;
			render(prev);
			if (onEvent) {
				try { onEvent(list[cur].source); } catch (err) { if (typeof console !== "undefined") console.error(err); }
			}
		}

		function play() {
			if (destroyed || !n || playing) return;
			if (cur >= n - 1) move(0); // play at the end starts over
			playing = true;
			render();
			schedule();
		}
		function pause() {
			if (destroyed || !playing) return;
			playing = false;
			clear();
			render();
		}
		function step(delta) {
			if (destroyed) return;
			var d = Math.trunc(Number(delta));
			if (!isFinite(d) || !d) return;
			move(cur + d);
			schedule();
		}
		function seek(i) {
			if (destroyed) return;
			var to = Math.trunc(Number(i));
			if (!isFinite(to)) return;
			move(to);
			schedule();
		}
		function setSpeed(x) {
			if (destroyed) return;
			var s = Number(x);
			if (!isFinite(s) || s <= 0 || s > 64) return;
			speed = s;
			render();
			schedule();
		}

		// ---- Keys ----
		function editable(t) {
			if (!t || !t.tagName) return false;
			var tag = t.tagName.toUpperCase();
			return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
		}
		function onKey(ev) {
			if (destroyed || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
			if (!root.isConnected || !root.getClientRects().length) return; // unmounted or hidden (another tab)
			var t = ev.target;
			var inside = t && t.nodeType === 1 && box.contains(t);
			if (!inside && t !== doc.body && t !== doc.documentElement && t !== doc) return; // keys in other parts of the page
			if (editable(t)) return;
			var inList = inside && listEl.contains(t);
			var key = ev.key;
			if (key === " " || key === "Spacebar") {
				if (inside && !inList && t.tagName && t.tagName.toUpperCase() === "BUTTON") return; // the button's own click runs
				ev.preventDefault();
				if (playing) pause(); else play();
				return;
			}
			var to = null;
			if (key === "ArrowLeft" || (inList && key === "ArrowUp")) to = cur - 1;
			else if (key === "ArrowRight" || (inList && key === "ArrowDown")) to = cur + 1;
			else if (inList && key === "Home") to = 0;
			else if (inList && key === "End") to = n - 1;
			if (to === null || !n) return;
			ev.preventDefault();
			seek(to);
			if (inList && items[cur]) items[cur].focus();
		}
		doc.addEventListener("keydown", onKey);

		function destroy() {
			if (destroyed) return;
			destroyed = true;
			playing = false;
			clear();
			doc.removeEventListener("keydown", onKey);
			if (box.parentNode) box.parentNode.removeChild(box);
		}

		render();
		return { play: play, pause: pause, step: step, seek: seek, setSpeed: setSpeed, destroy: destroy };
	}

	globalThis.amReplayPlayer = Object.freeze({ mount: mount });
})();
