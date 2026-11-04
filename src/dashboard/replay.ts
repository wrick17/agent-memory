// Replay tab (TG5). D0 stub: the final registration with a placeholder body that TG5 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function replayTab(am: Am): void {
	am.tab({ id: "replay", group: "work", label: "Replay", key: "r", render: (root) => {
		const h = am.el("h2", root, "Replay");
		am.note(root, "Not built yet.");
		return h;
	} });
}
