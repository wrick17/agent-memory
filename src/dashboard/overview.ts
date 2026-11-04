// Overview tab (TG1). D0 stub: the final registration with a placeholder body that TG1 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function overviewTab(am: Am): void {
	am.tab({ id: "overview", group: null, label: "Overview", key: "o", render: (root) => {
		const h = am.el("h2", root, "Overview");
		am.note(root, "Not built yet. Today's account summary is on Profiles.");
		am.link(am.el("p", root), "#/profiles", "Open Profiles");
		return h;
	} });
}
