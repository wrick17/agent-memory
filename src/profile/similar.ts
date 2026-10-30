// Alarm stage `similar` (section 12), after `embed`: each embedded card's nearest neighbours in its own generation's namespace
// become up to 5 relates_to edges with basis similarity (cosine at least 0.85, score kept); its older similarity edges end.
import { nextSeq } from "../storage";
import { embeddingsOn, namespaceOf, vectorId } from "./index";
import { enqueue } from "./maintenance";
import type { Who } from "./write";

const STEP = 20, TOP_K = 6, KEEP = 5, MIN_SCORE = 0.85;
/** Vectorize applies writes asynchronously, so a changed card is first compared this long after its write. */
export const SETTLE_MS = 60_000;
/** A card whose vector is not visible yet is retried; after this many misses it waits for the stage's next run instead of an alarm of its own. */
const SCHEDULED_TRIES = 3, PENDING_MAX = 200;

/** `card`: the node's own card changed, so links into it are recomputed from their sources once it is compared. */
type Pending = { n: number; at: number; card: boolean };
type Cursor = { seq: number; id: string; mark: { seq: number; at: number } | null; pending: Record<string, Pending>; evicted: number };

/**
 * One bounded step: pending cards that are due (at most half a step, so they never starve new cards), then active cards whose
 * node changed after the cursor and before the settled mark. Returns when the alarm should run this stage again, or null.
 * `gate` runs after the vector reads and before any write, so a generation closed meanwhile is left as it is.
 */
export async function similarStep(storage: DurableObjectStorage, env: Env, who: Who, now = Date.now(), gate: () => Promise<void> = async () => {}): Promise<number | null> {
	if (!embeddingsOn(env)) return null;
	const sql = storage.sql;
	const raw = sql.exec<{ cursor: string | null }>("SELECT cursor FROM cursors WHERE stage = 'similar'").toArray()[0]?.cursor;
	const cur: Cursor = { seq: 0, id: "", mark: null, pending: {}, evicted: 0, ...(raw ? JSON.parse(raw) as Partial<Cursor> : {}) };
	const writeSeq = Number(sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = 'write_seq'").toArray()[0]?.value ?? 0);
	if (!cur.mark && writeSeq > cur.seq) cur.mark = { seq: writeSeq, at: now };
	const retry = Object.entries(cur.pending).filter(([, p]) => p.at <= now).sort((x, y) => x[1].at - y[1].at).slice(0, STEP / 2).map(([id]) => id);
	const settled = cur.mark !== null && now >= cur.mark.at + SETTLE_MS, room = STEP - retry.length;
	const fresh = settled ? sql.exec<{ id: string; seq: number }>(`SELECT id, seq FROM nodes WHERE (seq, id) > (?, ?) AND seq <= ? AND status = 'active' AND embed_hash = card_hash
		ORDER BY seq, id LIMIT ?`, cur.seq, cur.id, cur.mark!.seq, room).toArray() : [];
	// A pending card that changed, retired or lost its embedding since is dropped; a change brings it back through the cursor.
	const live = new Set(retry.length ? sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active' AND embed_hash = card_hash",
		JSON.stringify(retry)).toArray().map((r) => r.id) : []);
	for (const id of retry) if (!live.has(id)) delete cur.pending[id];
	// A card both pending and changed again is compared once, as a changed card.
	const changed = new Set(fresh.map((n) => n.id));
	const due = [...retry.filter((id) => live.has(id)).map((id) => ({ id, card: cur.pending[id]!.card || changed.has(id) })), ...fresh.filter((n) => !live.has(n.id)).map((n) => ({ id: n.id, card: true }))];
	const prefix = `g${who.generation}:`;
	const found = due.length ? new Map((await env.VECTORS!.getByIds(due.map((n) => vectorId(who, n.id)))).map((v) => [v.id, [...v.values]])) : new Map<string, number[]>();
	const near = await Promise.all(due.map(async (n) => {
		const values = found.get(vectorId(who, n.id));
		if (!values) return null;
		const res = await env.VECTORS!.query(values, { topK: TOP_K, namespace: namespaceOf(who), returnValues: false, returnMetadata: "none" });
		return res.matches.filter((m) => m.id.startsWith(prefix) && m.id !== vectorId(who, n.id) && m.score >= 0.80)
			.slice(0, KEEP).map((m) => ({ id: m.id.slice(prefix.length), score: m.score }));
	}));
	if (due.length) await gate();
	storage.transactionSync(() => {
		// A sequence number only when links change: a run that writes nothing must not look like a new write to the next run.
		let seq = 0;
		const stamp = () => (seq ||= nextSeq(sql, "profile_meta"));
		const at = new Date(now).toISOString();
		due.forEach((n, i) => {
			const hits = near[i];
			if (!hits) {
				// No vector visible yet (or the node has no card): try again later, without holding the cursor.
				cur.pending[n.id] = { n: (cur.pending[n.id]?.n ?? 0) + 1, at: now + SETTLE_MS, card: n.card || (cur.pending[n.id]?.card ?? false) };
				return;
			}
			delete cur.pending[n.id];
			// Only neighbours that are still active nodes of this profile.
			const live = new Set(hits.length ? sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active'",
				JSON.stringify(hits.map((h) => h.id))).toArray().map((r) => r.id) : []);
			const keep = hits.filter((h) => live.has(h.id) && h.score >= MIN_SCORE);
			sql.exec(`UPDATE edges SET ended_at = ?, valid_to = ?, seq = ? WHERE src = ? AND basis = 'similarity' AND ended_at IS NULL AND dst NOT IN (SELECT value FROM json_each(?))`,
				at, at, stamp(), n.id, JSON.stringify(keep.map((k) => k.id)));
			for (const k of keep) {
				// A current identifier or judgment relates_to between the same nodes stays as it is.
				sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, score, valid_from, recorded_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'similarity', ?, ?, ?, 'index', ?)
					ON CONFLICT (src, rel, dst_profile, dst) WHERE ended_at IS NULL DO UPDATE SET score = excluded.score, seq = excluded.seq WHERE basis = 'similarity'`,
					n.id, k.id, k.score, at, at, stamp());
			}
			// A changed card makes the similarity links into it stale: their sources are compared again.
			if (n.card) {
				for (const r of sql.exec<{ src: string }>("SELECT src FROM edges WHERE dst_profile = '' AND dst = ? AND basis = 'similarity' AND ended_at IS NULL", n.id).toArray()) {
					cur.pending[r.src] ??= { n: 0, at: now, card: false };
				}
			}
		});
		// Past the cap, the cards that failed most often give way; the count stays in the cursor.
		const ids = Object.keys(cur.pending);
		if (ids.length > PENDING_MAX) {
			for (const id of ids.sort((x, y) => cur.pending[y]!.n - cur.pending[x]!.n).slice(0, ids.length - PENDING_MAX)) delete cur.pending[id];
			cur.evicted += ids.length - PENDING_MAX;
		}
		if (settled) {
			const last = fresh[fresh.length - 1];
			if (fresh.length < room) { cur.seq = cur.mark!.seq; cur.id = ""; cur.mark = null; } else { cur.seq = last!.seq; cur.id = last!.id; }
		}
		sql.exec(`INSERT INTO cursors (stage, cursor, due_at) VALUES ('similar', ?, 0) ON CONFLICT (stage) DO UPDATE SET cursor = excluded.cursor`, JSON.stringify(cur));
	});
	// Queue model decisions from the same bounded nearest-neighbour query, including contradictions below the edge cutoff.
	due.forEach((n, i) => {
		const source = sql.exec<{ kind: string; scope: string }>("SELECT kind, scope FROM nodes WHERE id = ? AND status = 'active'", n.id).toArray()[0];
		if (!source) return;
		const items: { kind: string; subjects: string[] }[] = [];
		for (const hit of near[i] ?? []) {
			const target = sql.exec<{ kind: string; scope: string }>("SELECT kind, scope FROM nodes WHERE id = ? AND status = 'active'", hit.id).toArray()[0];
			if (!target) continue;
			if (source.kind === target.kind && hit.score >= 0.92) items.push({ kind: "near_duplicate", subjects: [n.id, hit.id] });
			else if (hit.score < 0.92 && [source.kind, target.kind].every((kind) => ["rule", "preference", "decision"].includes(kind))) {
				const shared = source.scope === target.scope || sql.exec(`SELECT 1 FROM edges a JOIN edges b ON b.dst = a.dst AND b.dst_profile = a.dst_profile JOIN nodes p ON p.id = a.dst
					WHERE a.src = ? AND b.src = ? AND a.dst_profile = '' AND a.ended_at IS NULL AND b.ended_at IS NULL AND p.kind IN ('project','component') LIMIT 1`, n.id, hit.id).toArray().length > 0;
				if (shared) items.push({ kind: "possible_contradiction", subjects: [n.id, hit.id] });
			}
		}
		if (items.length) enqueue(storage, items);
	});
	if (fresh.length === room && settled) return now;
	const times = [
		...(cur.mark ? [cur.mark.at + SETTLE_MS] : writeSeq > cur.seq ? [now] : []),
		...Object.values(cur.pending).filter((p) => p.n <= SCHEDULED_TRIES).map((p) => Math.max(p.at, now)),
	];
	return times.length ? Math.min(...times) : null;
}
