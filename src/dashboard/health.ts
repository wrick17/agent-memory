// Health tab (TG1). D0 stub: the final registration with a placeholder body that TG1 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function healthTab(am: Am): void {
	am.tab({ id: "health", group: "system", label: "Health", key: "h", render: (root) => {
		const h = am.el("h2", root, "Health");
		am.note(root, "Not built yet. Today's backup and recovery status is on Backups.");
		am.link(am.el("p", root), "#/backups", "Open Backups");
		return h;
	} });
}
