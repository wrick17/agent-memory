// The data client (DC1). D0 stub with the final signature: am.api never loads or streams until DC1 replaces this body with
// the snapshot load, the fetch-based stream reader (the Clerk token goes in the Authorization header; EventSource can't send it),
// reconnect after 1 to 30 seconds, the paused notice, and a snapshot reload after each reconnect.
// Browser code, serialized into /app.js: it may use only `am` and browser globals (type imports are erased).
import type { Am } from "./am";

export function dataClient(am: Am): void {
	am.api = { start() {}, snapshot: () => Promise.reject(new Error("The data client is not built yet.")), subscribe: () => () => {} };
}
