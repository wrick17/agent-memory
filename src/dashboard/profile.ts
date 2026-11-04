// Profile tab (TG6). D0 stub: the final registration with a placeholder body that TG6 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function profileTab(am: Am): void {
	am.tab({ id: "profile", group: "insight", label: "Profile", key: "p", render: (root) => {
		const h = am.el("h2", root, "Profile");
		am.note(root, "Not built yet.");
		return h;
	} });
}
