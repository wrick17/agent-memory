// GET /api/viewer/snapshot (V1): one response for Overview, the tab counts and Health, from the R1, H1 and S1 functions.
// Every number is read from stored rows. Nothing here stores uptime, MCP call or failure counts, semantic latency, confidence
// percentages or tool counts, so the snapshot has none of them.
import { verdictOf } from "../health";
import { BOARD_KINDS } from "../profile/board";
import { OBJECT_LIMIT } from "../profile/housekeeping";
import { recallTotals } from "../profile/recall-stats";
import { listSessions } from "../profile/sessions";
import { FEED_SELECT, formatCursor, toFeedItem, type ActivityFeedRow } from "./events";
import type { AccountSnapshotPart, FeatureFlag, FeedItem, LayerState, ProfileSessionRow, ProfileSnapshotPart, Snapshot, SnapshotCounts, VersionInfo } from "./types";

const RECENT_SESSIONS = 10, FEED_MAX = 30;
/** S1's rule (src/profile/sessions.ts ACTIVE_MS): a session runs until it ended or its last upload is 30 minutes old. */
const ACTIVE_MS = 30 * 60_000;
const LAYERS = ["digests", "parts", "memories", "preferences", "me"] as const;
const COUNT_KEYS = ["memories", "revisions", "observations", "sessions", "sessions_active", "lessons", "crystals", "actions", "graph_nodes", "graph_edges"] as const;
const USAGE_KEYS = ["recalls_today", "recall_tokens_today", "writes_today", "storage_bytes", "vectors"] as const;

// A session's current digest parts, as S1's currentParts selects them: a range's heuristic digest until its manifest
// supersedes it, else its consolidated parts. Reached through nodes_kind and texts_node, never a scan of every text.
const CURRENT_PART = `t.part = 'capture' AND t.lane = 'capture' AND t.live = 1 AND t.chunk = 0 AND t.range_id IS NOT NULL
	AND t.capture_part IS NOT 'manifest' AND (t.capture_status = 'heuristic' OR NOT EXISTS (SELECT 1 FROM texts h
		WHERE h.node_id = t.node_id AND h.part = 'capture' AND h.range_id = t.range_id AND h.capture_status = 'heuristic' AND h.capture_part = '-' AND h.live = 1))`;
const LIVE_SESSION = "n.kind = 'session' AND n.status = 'active'";
const ENDED = "coalesce(json_extract(n.attrs, '$.ended'), 0) = 1";
// Observations are S1's counts: asks, decisions, corrections and outcomes. Stored bodies passed checkBody; json_valid guards the rest.
const ITEMS = `CASE WHEN json_valid(t.body) THEN coalesce(json_array_length(t.body, '$.asks'), 0) + coalesce(json_array_length(t.body, '$.decisions'), 0)
	+ coalesce(json_array_length(t.body, '$.corrections'), 0) + coalesce(json_array_length(t.body, '$.outcomes.commits'), 0)
	+ coalesce(json_array_length(t.body, '$.outcomes.prs'), 0) + coalesce(json_array_length(t.body, '$.outcomes.tests'), 0) ELSE 0 END`;

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Runs inside a profile store. `day` is today's UTC day; storageBytes is sql.databaseSize. Every read is synchronous with no
 * await between them, so seq, the feed and the counts come from one state of the store.
 */
export function profilePart(sql: SqlStorage, profile: string, day: string, storageBytes: number): ProfileSnapshotPart {
	const one = <T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]) => sql.exec<T>(q, ...args).one();
	const now = Date.now(), cutoff = new Date(now - ACTIVE_MS).toISOString();
	const seq = Number(one<{ m: number | null }>("SELECT max(id) AS m FROM activity").m ?? 0);

	const nodes = one<{ memories: number; lessons: number; journals: number; graph_nodes: number; vectors: number }>(
		`SELECT count(*) FILTER (WHERE memory_type IS NOT NULL) AS memories, count(*) FILTER (WHERE kind = 'preference') AS lessons,
			count(*) FILTER (WHERE kind = 'journal' AND coalesce(json_extract(attrs, '$.compacted_through'), 0) > 0) AS journals,
			count(*) AS graph_nodes, count(*) FILTER (WHERE embed_hash = card_hash) AS vectors
		FROM nodes WHERE status = 'active'`);
	// Older versions of the active memories: revision rows below each memory's current revision.
	const revisions = one<{ n: number }>(`SELECT count(*) AS n FROM nodes n JOIN revisions r ON r.node_id = n.id AND r.revision < n.revision
		WHERE n.memory_type IS NOT NULL AND n.status = 'active'`).n;
	const sessions = one<{ total: number; running: number; crystals: number }>(`SELECT count(*) AS total,
			count(*) FILTER (WHERE n.updated_at > ? AND NOT ${ENDED}) AS running,
			count(*) FILTER (WHERE (n.updated_at <= ? OR ${ENDED}) AND EXISTS (SELECT 1 FROM texts t WHERE t.node_id = n.id AND ${CURRENT_PART}
				AND t.capture_status = 'consolidated')) AS crystals
		FROM nodes n WHERE ${LIVE_SESSION}`, cutoff, cutoff);
	const digests = one<{ digests: number; parts: number; observations: number }>(`SELECT
			count(*) FILTER (WHERE t.capture_status = 'heuristic') AS digests, count(*) FILTER (WHERE t.capture_status = 'consolidated') AS parts,
			coalesce(sum(${ITEMS}), 0) AS observations
		FROM nodes n JOIN texts t ON t.node_id = n.id WHERE ${LIVE_SESSION} AND ${CURRENT_PART}`);
	// The work board's open items (board.ts counts.open), which the Actions tab lists.
	const actions = one<{ n: number }>(`SELECT count(*) AS n FROM nodes WHERE kind IN (SELECT value FROM json_each(?)) AND status = 'active'
		AND json_extract(attrs, '$.state') = 'open'`, JSON.stringify(BOARD_KINDS)).n;
	const edges = one<{ n: number }>("SELECT count(*) AS n FROM edges WHERE ended_at IS NULL").n;
	const pending = one<{ capture: number; prefs: number }>(`SELECT count(*) FILTER (WHERE kind = 'unprocessed_capture') AS capture,
		count(*) FILTER (WHERE kind = 'preference_signal') AS prefs FROM maintenance WHERE state IN ('open', 'leased')`);
	const lexical = one<{ n: number }>("SELECT count(*) AS n FROM texts WHERE live = 1 AND lane = 'recall'").n;
	const writes = one<{ n: number }>("SELECT count(*) AS n FROM activity WHERE at >= ? AND at < ?", day, nextDay(day)).n;
	const totals = recallTotals(sql, day);
	// V2's feed read, so the snapshot and the stream link the same targets: readable nodes of unredacted rows only.
	const feed = sql.exec<ActivityFeedRow>(`${FEED_SELECT} ORDER BY a.id DESC LIMIT ?`, FEED_MAX).toArray().map((r) => toFeedItem(profile, r));
	const recent = listSessions(sql, { limit: RECENT_SESSIONS }).rows;

	const counts: SnapshotCounts = {
		memories: nodes.memories, revisions, observations: digests.observations, sessions: sessions.total, sessions_active: sessions.running,
		lessons: nodes.lessons, crystals: nodes.journals + sessions.crystals, actions, graph_nodes: nodes.graph_nodes, graph_edges: edges,
	};
	// Profile-local states; assembleSnapshot sums the counts and sets each state and waits_for from every profile and the flags.
	const layer = (l: LayerState["layer"], count: number, waiting: boolean): LayerState => ({ layer: l, count, state: waiting ? "waiting" : "ok", waits_for: null });
	const layers = [layer("digests", digests.digests, false), layer("parts", digests.parts, pending.capture > 0), layer("memories", nodes.memories, false),
		layer("preferences", nodes.lessons, pending.prefs > 0), ...(profile === "me" ? [layer("me", nodes.memories, false)] : [])];
	return {
		profile, seq, counts,
		// recalls: one per recall that returned hits from this profile (R1), so a sum across profiles counts participations.
		usage: { recalls_today: totals.recalls, recall_tokens_today: totals.tokens, writes_today: writes, storage_bytes: storageBytes, vectors: nodes.vectors, lexical_documents: lexical },
		recent_sessions: recent, feed, layers,
	};
}

type Meta = VersionInfo & { at: string; embeddings: boolean; corpus: boolean };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The feature rows. "inactive" means the server has no report that confirms the state: no device sent a status yet. */
function featureFlags(account: AccountSnapshotPart, meta: Meta, sessions: number, vectors: number): FeatureFlag[] {
	const reporting = account.devices_reporting, none = "No device has reported its status yet. The next agent-memory run on a device sends it.";
	const byDevice = (n: number, on: string, off: string): Pick<FeatureFlag, "state" | "how"> => reporting === 0 ? { state: "inactive", how: none }
		: n > 0 ? { state: "on", how: `${on} on ${n} of ${plural(reporting, "reporting device")}.` } : { state: "off", how: off };
	return [
		{ id: "embeddings", tabs: ["overview", "memories", "graph", "health"], ...(meta.embeddings
			? { state: "on", how: `On. ${plural(vectors, "record")} have current vectors.` }
			: { state: "off", how: "Set EMBEDDINGS to \"on\" with the AI and Vectorize bindings, then redeploy." }) },
		{ id: "corpus", tabs: ["activity", "profile"], ...(meta.corpus
			? { state: "on", how: "On. Uploaded commit paths feed the most touched files." }
			: { state: "off", how: "Set CORPUS to \"on\" and redeploy; most touched files stay empty until then." }) },
		{ id: "capture", tabs: ["overview", "sessions", "replay", "activity", "crystals"], ...(reporting > 0
			? { state: "on", how: `${plural(reporting, "device")} report capture status.` }
			: sessions > 0 ? { state: "inactive", how: "Sessions are stored, but no device reports its capture status. Run agent-memory install to update the runner." }
				: { state: "off", how: "Run agent-memory install on each device." }) },
		{ id: "inject", tabs: [], ...byDevice(account.inject_devices, "Prompt injection is on", "Set inject.enabled to true in the local config on each device, then run agent-memory install.") },
		{ id: "scheduled_batch", tabs: ["overview", "lessons", "crystals", "health"],
			...byDevice(account.scheduled_devices, "The launchd job runs the batch", "Run agent-memory install to load the launchd job, or run agent-memory run --scheduled by hand.") },
	];
}

/** Sums each layer across profiles, then sets its state from the pending work and the capture and batch flags. */
function mergeLayers(parts: ProfileSnapshotPart[], flags: FeatureFlag[]): LayerState[] {
	const flag = (id: FeatureFlag["id"]) => flags.find((f) => f.id === id)!.state;
	const batch = flag("scheduled_batch") === "on" ? "the next scheduled batch" : "a batch run (agent-memory run)";
	const out: LayerState[] = [];
	for (const id of LAYERS) {
		const rows = parts.flatMap((p) => p.layers.filter((l) => l.layer === id));
		if (!rows.length) continue; // me appears only when the me profile is in the snapshot
		const count = rows.reduce((n, l) => n + l.count, 0), waiting = rows.some((l) => l.state === "waiting");
		let state: LayerState["state"] = waiting ? "waiting" : "ok", waits_for = waiting ? batch : null;
		if (id === "digests" && count === 0) {
			if (flag("capture") === "off") state = "off";
			else { state = "waiting"; waits_for = "the first capture upload from an installed device"; }
		}
		if (id === "parts" && !waiting && count === 0 && flag("capture") === "off") state = "off";
		out.push({ layer: id, count, state, waits_for });
	}
	return out;
}

/**
 * Runs in the Worker: sums the profile parts, merges sessions and feed, adds health, flags and version. `parts` must hold one
 * part for every profile the owner reads; a caller whose profile read failed fails the request instead of passing fewer.
 */
export function assembleSnapshot(parts: ProfileSnapshotPart[], account: AccountSnapshotPart, meta: Meta): Snapshot {
	const total = (pick: (p: ProfileSnapshotPart) => number) => parts.reduce((n, p) => n + pick(p), 0);
	const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, total((p) => p.counts[k])])) as Record<keyof SnapshotCounts, number>;
	const used = Object.fromEntries(USAGE_KEYS.map((k) => [k, total((p) => p.usage[k])])) as Record<(typeof USAGE_KEYS)[number], number>;
	const recent: ProfileSessionRow[] = parts.flatMap((p) => p.recent_sessions.map((r) => ({ ...r, profile: p.profile })))
		.sort((a, b) => cmp(b.last_upload_at, a.last_upload_at) || cmp(b.id, a.id)).slice(0, RECENT_SESSIONS);
	// Newest first by time; ties keep profile order, then the higher activity id.
	const feed: FeedItem[] = parts.flatMap((p) => p.feed).sort((a, b) => cmp(b.at, a.at) || Number(b.id) - Number(a.id)).slice(0, FEED_MAX);
	const flags = featureFlags(account, meta, counts.sessions, used.vectors);
	return {
		at: meta.at, version: meta.version, deployed_at: meta.deployed_at, profiles: parts.map((p) => p.profile),
		cursor: formatCursor(Object.fromEntries(parts.map((p) => [p.profile, p.seq]))),
		counts,
		// Each profile is its own store with its own object limit, so the limit is their sum; recalls_today counts participations.
		usage: { ...used, storage_limit: parts.length * OBJECT_LIMIT },
		health: { verdict: verdictOf(account.checks), checks: account.checks },
		recent_sessions: recent, feed, layers: mergeLayers(parts, flags), flags,
	};
}
