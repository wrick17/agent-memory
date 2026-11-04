// Lessons tab (TG3). D0 stub: the final registration with a placeholder body that TG3 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function lessonsTab(am: Am): void {
	am.tab({ id: "lessons", group: "memory", label: "Lessons", key: "l", count: (s) => s.counts.lessons, render: (root) => {
		const h = am.el("h2", root, "Lessons");
		am.note(root, "Not built yet. Today's preferences and rules are on About you.");
		am.link(am.el("p", root), "#/about", "Open About you");
		return h;
	} });
}
