/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// Replay player (P1): browser JavaScript shared by the dashboard (Worker Text module) and the local replay viewer. A classic
// script, not a module: it defines globalThis.amReplayPlayer. It sets every value as text, never as HTML. Stub from L0.
//
// amReplayPlayer.mount(root, events, options) -> { play(), pause(), step(delta), seek(i), setSpeed(x), destroy() }
//   root: an Element; events: ReplayEvent[] ({ i, kind, label, offset_ms, detail }); options: { speeds?: number[], onEvent?(e) }.
//   When offset_ms is null the player advances one event per second at 1x. Keys: Space play/pause, Left/Right step.
(function () {
	"use strict";
	function mount(root, events, options) {
		var noop = function () {};
		return { play: noop, pause: noop, step: noop, seek: noop, setSpeed: noop, destroy: noop }; // stub: P1
	}
	globalThis.amReplayPlayer = { mount: mount };
})();
