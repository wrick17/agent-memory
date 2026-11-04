// The one glossary every ? reads: am.help(parent, key) shows entry `key`, and the header's ? lists them all. It covers the pages
// that exist today; a tab's ticket adds its own terms here when the tab ships. Browser code, serialized into /app.js: it may use
// only `am`.
import type { Am } from "./am";

export function glossary(am: Am): void {
	am.glossary = {
		// Pages.
		graph: { term: "Graph", text: "Records and the links between them, drawn for one profile. Each link keeps the reason and evidence it was made with." },
		memories: { term: "Memories", text: "Records your agents saved: decisions, references, rules and project facts. Each edit keeps the older version." },
		activity: { term: "Activity", text: "Every change in a profile, newest first, with who made it, and the archive of removed records. Most changes can be undone here." },
		profiles: { term: "Profiles", text: "One card per profile with its status, devices and daily batch. Each profile keeps its records apart from the others." },
		paths: { term: "Paths", text: "Pick two records and see how they connect, with the reason on each step. It shows at most 3 paths of up to 4 hops." },
		map: { term: "Map", text: "Records around a center and their links, up to 300 records. What-if items try links on screen without saving them." },
		timeline: { term: "Timeline", text: "What changed in a profile, by day: entries, revisions and uploads." },
		journals: { term: "Journals", text: "Task journals, active and compacted, with their entries." },
		write: { term: "Write", text: "Draft a memory, preview the exact request, then save it. Nothing is saved until you choose Save." },
		review: { term: "Review", text: "Records that need a decision: captured suggestions, migrated records with no profile, transfers waiting on a name collision and flagged records." },
		routing: { term: "Routing", text: "Older rules that pick a profile when an agent names none. When an agent names a profile it may use, that choice wins." },
		moves: { term: "Moves", text: "Moves and copies of records between profiles. Each keeps its history and evidence, and shows its progress until it finishes." },
		wipe: { term: "Wipe", text: "Permanently removes a profile's records, copies and exports after you type its name. It cannot be undone." },
		work: { term: "Work", text: "One profile's work board: ranked items with their score reasons and the date the data is from." },
		about: { term: "About you", text: "Preferences and rules about you, stated or inferred with evidence. Pin, forget or undo them here." },
		backups: { term: "Backups", text: "Exports of each profile, the restore drill, and recovery after a restore." },

		// Terms on those pages.
		revisions: { term: "Older versions", text: "Earlier versions of a memory, kept when it is edited." },
		relations: { term: "Relations", text: "Links between records in the graph." },
		daily_batch: { term: "Daily batch", text: "The scheduled consolidation run for a profile: the date of its last lease, and its last skip or park with the reason." },
		undo: { term: "Undo", text: "Reverses a change. If the record changed again since, undo stops and asks you to review it by hand." },
		actor: { term: "Actor", text: "Who made a change: owner, agent, maintenance, import, keep or index." },
		mcp_call: { term: "MCP call", text: "The tool name and arguments an agent sends to the memory MCP server, as JSON." },
		curl: { term: "curl", text: "A terminal command for the same request, with the token left as a variable; the page never copies a real token. /api routes are owner only: set AGENT_MEMORY_OWNER_TOKEN to the owner's session or OAuth access token, because device tokens get 403 there. /v1 and /mcp commands use AGENT_MEMORY_TOKEN, a device token with the scope the route needs." },
	};
}
