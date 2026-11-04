// GET /api/viewer/snapshot (V1): one response for Overview, the tab counts and Health, from the R1, H1 and S1 functions.
import type { AccountSnapshotPart, ProfileSnapshotPart, Snapshot, VersionInfo } from "./types";

/** Runs inside a profile store. `day` is today's UTC day; storageBytes is sql.databaseSize. */
export function profilePart(_sql: SqlStorage, profile: string, _day: string, storageBytes: number): ProfileSnapshotPart {
	const zero = { memories: 0, revisions: 0, observations: 0, sessions: 0, sessions_active: 0, lessons: 0, crystals: 0, actions: 0, graph_nodes: 0, graph_edges: 0 };
	return { profile, seq: 0, counts: zero, usage: { recalls_today: 0, recall_tokens_today: 0, writes_today: 0, storage_bytes: storageBytes, vectors: 0 }, recent_sessions: [], feed: [], layers: [] }; // stub: V1
}
/** Runs in the Worker: sums the profile parts, merges sessions and feed, adds health, flags and version. */
export function assembleSnapshot(parts: ProfileSnapshotPart[], account: AccountSnapshotPart, meta: VersionInfo & { at: string; embeddings: boolean; corpus: boolean }): Snapshot {
	// stub: V1 replaces this sum with the full assembly (sessions, feed, layers, flags, storage limit).
	const counts = Object.fromEntries(Object.keys(parts[0]?.counts ?? {}).map((k) => [k, parts.reduce((n, p) => n + p.counts[k as keyof typeof p.counts], 0)])) as unknown as Snapshot["counts"];
	return { at: meta.at, version: meta.version, deployed_at: meta.deployed_at, profiles: parts.map((p) => p.profile), cursor: "", counts,
		usage: { recalls_today: 0, recall_tokens_today: 0, writes_today: 0, storage_bytes: 0, storage_limit: 0, vectors: 0 },
		health: { verdict: "ok", checks: account.checks }, recent_sessions: [], feed: [], layers: [], flags: [] };
}
