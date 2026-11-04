// Sessions tab (TG5). D0 stub: the final registration with a placeholder body that TG5 replaces.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function sessionsTab(am: Am): void {
	am.tab({ id: "sessions", group: "work", label: "Sessions", key: "s", count: (s) => s.counts.sessions, render: (root) => {
		const h = am.el("h2", root, "Sessions");
		am.note(root, "Not built yet.");
		return h;
	} });
}
