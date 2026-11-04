// Actions tab (TG3). D0 stub: the final registration with a placeholder body that TG3 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function actionsTab(am: Am): void {
	am.tab({ id: "actions", group: "work", label: "Actions", key: "a", count: (s) => s.counts.actions, render: (root) => {
		const h = am.el("h2", root, "Actions");
		am.note(root, "Not built yet. Today's work board is on Work.");
		am.link(am.el("p", root), "#/work", "Open Work");
		return h;
	} });
}
