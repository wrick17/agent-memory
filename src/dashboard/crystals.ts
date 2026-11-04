// Crystals tab (TG3). D0 stub: the final registration with a placeholder body that TG3 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function crystalsTab(am: Am): void {
	am.tab({ id: "crystals", group: "memory", label: "Crystals", key: "c", count: (s) => s.counts.crystals, render: (root) => {
		const h = am.el("h2", root, "Crystals");
		am.note(root, "Not built yet. Today's journals are on Journals.");
		am.link(am.el("p", root), "#/journals", "Open Journals");
		return h;
	} });
}
