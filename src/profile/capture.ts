// Capture digests (section 10): immutable digest parts and the completeness manifest, stored on the session's node in the
// capture lane, outside ordinary recall. A range counts as consolidated only once its manifest tiles it with stored parts.
import { z } from "zod";
import { canonicalJson, sha256 } from "../domain/ids";
import { redactText } from "../domain/redact";
import { nextSeq } from "../storage";
import { resolveMentionsAlone } from "./extract";
import { sizeLevel } from "./housekeeping";
import type { Who } from "./write";

export const PART_MAX_BYTES = 8192;
/** Excerpt limits: every string in a digest is at most this long, so no field holds a long message (a short one can fit whole). */
const ASK_MAX = 160, ITEM_MAX = 280;
/** A stored text row holds at most 16,000 characters (the texts CHECK); a longer manifest is stored in chunks. */
const ROW_MAX = 16_000;
const RANGE_ID = /^(claude-code|codex):([A-Za-z0-9._:-]{1,128}):([0-9a-f]{8,64}):(\d+)-(\d+)$/;
const SPAN = /^(\d+)-(\d+)$/;

export interface DigestPart { range_id: string; capture_status: "heuristic" | "consolidated"; part_id: string; sha256: string; body: string }
export interface Manifest { range_id: string; parts: { part_id: string; sha256: string }[] }
export interface IngestBatch { session: { client: "claude-code" | "codex"; id: string }; digests: DigestPart[]; manifests: Manifest[] }
export type ItemResult = { range_id: string; part_id: string; status: "stored" | "replayed" | "refused"; reason?: string };

export function parseRange(rangeId: string): { client: string; session: string; epoch: string; start: number; end: number } | null {
	const m = RANGE_ID.exec(rangeId);
	if (!m) return null;
	const start = Number(m[4]), end = Number(m[5]);
	return end > start ? { client: m[1]!, session: m[2]!, epoch: m[3]!, start, end } : null;
}

// The digest schema shared by heuristic digests and consolidated parts, strict at every level: no field outside it, and every
// string bounded. local/agent-memory.mjs enforces the same shape (PART_SCHEMA plus bodyProblem) before it uploads.
const excerpt = (max: number) => z.object({ text: z.string().max(max), pos: z.number().int().min(0) }).strict();
const short = z.string().max(ITEM_MAX);
const count = z.number().int().min(0);
const BODY = z.object({
	asks: z.array(excerpt(ASK_MAX)), decisions: z.array(excerpt(ITEM_MAX)), corrections: z.array(excerpt(ITEM_MAX)),
	outcomes: z.object({ commits: z.array(short).optional(), prs: z.array(short).optional(), tests: z.array(short).optional() }).strict(),
	entities: z.array(short), dropped: z.object({ asks: count, decisions: count, corrections: count }).strict(),
}).strict();
type Body = z.infer<typeof BODY>;

/** Every string in a value, at any depth. */
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/**
 * Checks a digest body. The stored bytes are exactly the uploaded bytes, so redaction is checked, never applied: a part
 * with any string that redaction would change is refused (the client redacts every string before hashing).
 */
export function checkBody(text: string): { body?: Body; reason?: string } {
	if (new TextEncoder().encode(text).length > PART_MAX_BYTES) return { reason: "over_8kb" };
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { return { reason: "not_json" }; }
	const parsed = BODY.safeParse(raw);
	if (!parsed.success) return { reason: `bad_body:${parsed.error.issues[0]!.path.join(".") || parsed.error.issues[0]!.code}`.slice(0, 120) };
	if (strings(parsed.data).some((s) => redactText(s) !== s)) return { reason: "needs_redaction" };
	return { body: parsed.data };
}

export const sessionKey = (s: IngestBatch["session"]) => `session:${s.client}:${s.id}`;

/** The session node, created once. Sessions are found by identifier and full text, so they never get an embedding card. */
function sessionNode(sql: SqlStorage, s: IngestBatch["session"], seq: number, now: string): string {
	const key = sessionKey(s);
	const found = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ?", key).toArray()[0];
	if (found) return found.id;
	const id = sha256(key).slice(0, 32);
	const hash = sha256(key);
	sql.exec(`INSERT INTO nodes (id, kind, key, scope, name, norm_name, status, origin, revision, content_hash, card_hash, embed_hash,
		recorded_at, created_at, updated_at, seq) VALUES (?, 'session', ?, '', ?, ?, 'active', 'upload', 1, ?, ?, ?, ?, ?, ?, ?)`,
		id, key, key, key.toLowerCase(), hash, hash, hash, now, now, now, seq);
	return id;
}

// A manifest may span several chunk rows; chunk 0 carries the identity.
const stored = (sql: SqlStorage, rangeId: string, status: string, part: string) =>
	sql.exec<{ rowid: number; sha256: string; body: string; live: number }>(
		"SELECT rowid, sha256, body, live FROM texts WHERE range_id = ? AND capture_status = ? AND capture_part = ? AND chunk = 0", rangeId, status, part).toArray()[0];

/** A stored manifest's full body, rebuilt from its chunks. */
export const manifestBody = (sql: SqlStorage, rangeId: string): string | null => {
	const rows = sql.exec<{ body: string }>("SELECT body FROM texts WHERE range_id = ? AND capture_status = 'consolidated' AND capture_part = 'manifest' ORDER BY chunk", rangeId).toArray();
	return rows.length ? rows.map((r) => r.body).join("") : null;
};

function queue(sql: SqlStorage, kind: "unprocessed_capture" | "preference_signal", subjects: string[], fingerprint: string, seq: number, now: string): void {
	sql.exec("INSERT OR IGNORE INTO maintenance (kind, subjects, fingerprint, created_at, seq) VALUES (?, ?, ?, ?, ?)",
		kind, JSON.stringify(subjects), fingerprint, now, seq);
}

/**
 * Each item in its own transaction. A part's identity is (range_id, capture_status, part_id) plus the SHA-256 of its exact
 * bytes, which are stored unchanged: the same identity with the same hash replays, with another hash it is refused. A manifest
 * is accepted only when its spans tile the range with no gap or overlap and every listed part is stored with that hash and
 * drops no decision or correction. Its body (up to 512 parts) is stored in 16,000-character chunks in that one transaction,
 * which writes at most a few chunk rows, two queue rows and one update, well inside the 1,000-row and 1 MB write budget.
 */
export function ingest(storage: DurableObjectStorage, _who: Who, batch: IngestBatch): ItemResult[] {
	const sql = storage.sql;
	const out: ItemResult[] = [];
	for (const d of batch.digests) {
		const result = (status: ItemResult["status"], reason?: string): ItemResult => ({ range_id: d.range_id, part_id: d.part_id, status, ...(reason ? { reason } : {}) });
		const range = parseRange(d.range_id);
		if (!range || range.client !== batch.session.client || range.session !== batch.session.id) { out.push(result("refused", "bad_range_id")); continue; }
		if (d.capture_status === "heuristic" ? d.part_id !== "-" : !SPAN.test(d.part_id)) { out.push(result("refused", "bad_part_id")); continue; }
		if (d.capture_status === "consolidated") {
			const [, a, b] = SPAN.exec(d.part_id)!.map(Number);
			if (!(a! >= range.start && b! <= range.end && b! > a!)) { out.push(result("refused", "span_outside_range")); continue; }
		}
		if (sha256(d.body) !== d.sha256) { out.push(result("refused", "hash_mismatch")); continue; }
		const check = checkBody(d.body);
		if (!check.body) { out.push(result("refused", check.reason)); continue; }
		out.push(storage.transactionSync(() => {
			const prior = stored(sql, d.range_id, d.capture_status, d.part_id);
			if (prior) return prior.sha256 === d.sha256 ? result("replayed") : result("refused", "hash_conflict");
			if (sizeLevel(sql.databaseSize) === "shrink_only") return result("refused", "size_budget");
			const seq = nextSeq(sql, "profile_meta");
			const now = new Date().toISOString();
			const node = sessionNode(sql, batch.session, seq, now);
			// A heuristic digest that arrives after its range is consolidated stays out of the capture index.
			const live = d.capture_status === "heuristic" && stored(sql, d.range_id, "consolidated", "manifest") ? 0 : 1;
			sql.exec(`INSERT INTO texts (node_id, part, revision, body, range_id, capture_part, sha256, capture_status, actor, created_at, live, lane, seq)
				VALUES (?, 'capture', 0, ?, ?, ?, ?, ?, 'hook', ?, ?, 'capture', ?)`,
				node, d.body, d.range_id, d.part_id, d.sha256, d.capture_status, now, live, seq);
			return result("stored");
		}));
	}
	for (const m of batch.manifests) {
		const result = (status: ItemResult["status"], reason?: string): ItemResult => ({ range_id: m.range_id, part_id: "manifest", status, ...(reason ? { reason } : {}) });
		const range = parseRange(m.range_id);
		if (!range || range.client !== batch.session.client || range.session !== batch.session.id) { out.push(result("refused", "bad_range_id")); continue; }
		const parts = m.parts.map((p) => ({ ...p, span: SPAN.exec(p.part_id) })).sort((x, y) => Number(x.span?.[1] ?? -1) - Number(y.span?.[1] ?? -1));
		let at = range.start, tiled = parts.length > 0 && parts.every((p) => p.span);
		for (const p of parts) {
			if (!tiled) break;
			if (Number(p.span![1]) !== at) tiled = false;
			at = Number(p.span![2]);
		}
		if (!tiled || at !== range.end) { out.push(result("refused", "not_tiled")); continue; }
		const body = canonicalJson({ range_id: m.range_id, parts: parts.map(({ part_id, sha256: h }) => ({ part_id, sha256: h })) });
		const hash = sha256(body);
		out.push(storage.transactionSync(() => {
			const prior = stored(sql, m.range_id, "consolidated", "manifest");
			if (prior) return prior.sha256 === hash ? result("replayed") : result("refused", "hash_conflict");
			if (sizeLevel(sql.databaseSize) === "shrink_only") return result("refused", "size_budget");
			const rows = parts.map((p) => ({ p, row: stored(sql, m.range_id, "consolidated", p.part_id) }));
			const missing = rows.find(({ p, row }) => !row || row.sha256 !== p.sha256);
			if (missing) return result("refused", `part_missing:${missing.p.part_id}`);
			const lossy = rows.find(({ row }) => { const d = (JSON.parse(row!.body) as Body).dropped; return d.decisions > 0 || d.corrections > 0; });
			if (lossy) return result("refused", `part_dropped:${lossy.p.part_id}`);
			const seq = nextSeq(sql, "profile_meta");
			const now = new Date().toISOString();
			const node = sessionNode(sql, batch.session, seq, now);
			for (let chunk = 0; chunk * ROW_MAX < body.length; chunk++) {
				sql.exec(`INSERT INTO texts (node_id, part, revision, chunk, body, range_id, capture_part, sha256, capture_status, actor, created_at, live, lane, seq)
					VALUES (?, 'capture', 0, ?, ?, ?, 'manifest', ?, 'consolidated', 'hook', ?, 0, 'capture', ?)`, node, chunk, body.slice(chunk * ROW_MAX, (chunk + 1) * ROW_MAX), m.range_id, hash, now, seq);
			}
			// The consolidated parts supersede the heuristic digest, which leaves the capture index (the archive arrives in phase 3).
			sql.exec("UPDATE texts SET live = 0, seq = ? WHERE range_id = ? AND capture_status = 'heuristic' AND live = 1", seq, m.range_id);
			// One item per consolidated range, keyed by the manifest hash, so a 512-part manifest stays inside the write budget.
			queue(sql, "unprocessed_capture", [node], `unprocessed_capture:${hash}`, seq, now);
			if (rows.some(({ row }) => (JSON.parse(row!.body) as Body).corrections.length)) queue(sql, "preference_signal", [node], `preference_signal:${hash}`, seq, now);
			return result("stored");
		}));
	}
	// Mentions of this session written before it was uploaded link to it, in a budgeted transaction of their own; any still
	// waiting resolve on the session's next upload.
	resolveMentionsAlone(storage, sessionKey(batch.session), "upload");
	return out;
}

/** A manifest acknowledges only the tiled parts still durably held, including after capture TTL or an interrupted restore. */
function completeRange(sql: SqlStorage, id: string): boolean {
	const range = parseRange(id), text = manifestBody(sql, id), manifest = stored(sql, id, "consolidated", "manifest");
	if (!range || !text || !manifest || sha256(text) !== manifest.sha256) return false;
	try {
		const m = JSON.parse(text) as Manifest;
		if (m.range_id !== id || !Array.isArray(m.parts) || !m.parts.length || m.parts.length > 512) return false;
		let at = range.start;
		for (const p of m.parts) {
			const span = typeof p.part_id === "string" ? SPAN.exec(p.part_id) : null;
			if (!span || Number(span[1]) !== at || Number(span[2]) <= at || Number(span[2]) > range.end) return false;
			const row = stored(sql, id, "consolidated", p.part_id);
			if (!row || row.sha256 !== p.sha256 || sha256(row.body) !== p.sha256) return false;
			const body = checkBody(row.body).body;
			if (!body || body.dropped.decisions || body.dropped.corrections) return false;
			at = Number(span[2]);
		}
		return at === range.end;
	} catch { return false; }
}

/** What the server holds for each range, so a client that lost its part files adopts these and digests only the gaps. */
export function captureState(sql: SqlStorage, rangeIds: string[]): Record<string, { parts: { part_id: string; sha256: string }[]; heuristic: boolean; consolidated: boolean }> {
	const out: ReturnType<typeof captureState> = {};
	for (const id of rangeIds) {
		const rows = sql.exec<{ capture_status: string; capture_part: string; sha256: string }>(
			"SELECT capture_status, capture_part, sha256 FROM texts WHERE range_id = ? ORDER BY rowid", id).toArray();
		out[id] = {
			parts: rows.filter((r) => r.capture_status === "consolidated" && r.capture_part !== "manifest").map((r) => ({ part_id: r.capture_part, sha256: r.sha256 })),
			heuristic: rows.some((r) => r.capture_status === "heuristic" && r.capture_part === "-"),
			consolidated: completeRange(sql, id),
		};
	}
	return out;
}
