// Replay tab: an empty part, listed in PARTS so its ticket fills only this file. It registers nothing, so the dashboard shows
// no Replay link or route until that ticket lands. Browser code, serialized into /app.js.
import type { Part } from "./am";

export const replayTab: Part = () => {};
