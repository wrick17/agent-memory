import { archiveNodeIds } from "./write";
// The maintenance queue (sections 7 and 12): deterministic items leased to the confined daily batch, and their results applied
// through the normal write path with actor maintenance. Each op stays inside its item's subjects, and any op that touches a
// protected node (stated, pinned, or anything in me) becomes a flag on it instead.
import { requestHash, sha256, uuid5 } from "../domain/ids";
import { redactPayload } from "../domain/redact";
import { Fail, type ErrorCode, type RELATIONS, type WriteCommand, type WriteContext } from "../domain/types";
import { nextSeq } from "../storage";
import { BudgetTx } from "./archive";
import { flagProtected, mayChange } from "./protect";
import { assertWritable, RESUME_MS } from "./transfer";
import { assertNotWiped, assertOpen } from "./wipe";
import { fenceOf } from "./compact";
import { captureText, readPrefix, runWrite, type Who } from "./write";
import { manifestListed } from "./capture";
import { reviewBoard } from "./board";
import { insertCandidate } from "./eval-candidates";
import { readableNodeIds } from "./graph";

export const MAX_ITEMS = 40;
export const MAX_LEASE_S = 900;
export const MAX_OPS = 10;
export const BATCH_GAP_MS = 20 * 3_600_000;
const MAX_ATTEMPTS = 3;
export const ALLOWED_OPS = ["save", "compact", "link", "end_link", "supersede", "flag", "dismiss"] as const;
/** Each item kind's ops: inference reads correction or capture digests; promotion also takes a preference a similarity pair names. */
export function opsFor(kind: string): string[] {
	// A dangling link's target is opaque here: the batch may only end the link, flag its source or dismiss the item.
	if (kind === "dangling_link") return ["end_link", "flag", "dismiss"];
	// The weekly item only writes the review document; its subjects are board items it may link to, never change.
	if (kind === "weekly_review") return ["strategic_review", "dismiss"];
	// A stale record may only be retired (a save with retire: true and nothing else), flagged for the owner, or kept. Never deleted.
	if (kind === "stale_memory") return ["save", "flag", "dismiss"];
	const infer = kind === "preference_signal" || kind === "unprocessed_capture";
	return [...ALLOWED_OPS, ...(infer ? ["infer_preference", "suggest_eval_case"] : []), ...(infer || kind === "near_duplicate" || kind === "possible_contradiction" ? ["promote_to_me"] : [])];
}

type Evidence = { kind: "entry" | "commit" | "pr" | "ticket" | "session" | "file" | "node" | "url" | "corpus"; ref: string; note?: string };
export type MaintenanceOp =
	| { op: "save"; memory_id: string; description?: string; content?: string; why?: string; how_to_apply?: string; new_name?: string; retire?: boolean; expected_revision?: number }
	| { op: "compact"; memory_id: string; through_seq: number; summary: string; expected_revision: number }
	| { op: "link"; from: string; to: string; rel: (typeof RELATIONS)[number]; other_label?: string; reason: string; evidence: Evidence[] }
	| { op: "end_link"; edge: number; reason: string; valid_to?: string }
	| { op: "supersede"; keep: string; retire: string[] }
	| { op: "flag"; node: string; reason: string }
	| { op: "dismiss" }
	| { op: "infer_preference"; name: string; description: string; why?: string; how_to_apply?: string; scope?: string; evidence: Evidence[] }
	| { op: "promote_to_me"; memory_id?: string; from_op?: number; company_free: true }
	| { op: "strategic_review"; summary: string; content: string; links: ReviewLink[] }
	| { op: "suggest_eval_case"; query: string; expected: string[]; evidence: Evidence[] };
/** A review's link to one board item it discusses (relates_to), cited by node pointers to the item's subjects. */
export type ReviewLink = { to: string; reason: string; evidence: { kind: "node"; ref: string; note?: string }[] };
export const REVIEW_LINKS = 20;
export type MaintenanceCmd =
	| { op: "next"; kinds?: string[]; limit?: number; lease_seconds?: number; request_id?: string }
	| { op: "complete"; lease_id: string; results: { item_id: number; ops: MaintenanceOp[] }[] }
	| { op: "complete"; lease_id: string; status: "batch_skipped" | "stuck"; reason: string }
	| { op: "complete"; status: "batch_skipped"; reason: string };
/**
 * The job token's device and the Worker's platform label; the actor is always maintenance. `me`: the active me generation,
 * set only when the Worker found the job token may use both the leased profile and me, which promote_to_me needs.
 */
export type JobContext = Pick<WriteContext, "deviceId" | "platform" | "userId"> & { me?: string };
/**
 * One finished item's durable intent, content-free (section 12): ids to register for this generation, and the promotions the
 * profile accepted, each with its transfer id, the me generation and the job device it was authorized for. The alarm settles it.
 */
export interface Outbox { created: string[]; promote: { id: string; node: string; me: string; device: string; company_free: true }[] }
export const OUTBOX = "outbox:";
/**
 * Ids and codes only. `created`: the preference an infer op made, registered by the store and named by a later from_op.
 * `transfer_started`: the profile checked a promotion; the Worker drives its transfer and reports applied, rejected or
 * `moving` (fenced and resumable).
 */
export type OpOutcome = { op: string; status: "applied" | "flagged" | "rejected" | "transfer_started" | "moving"; code?: string; reason?: string; activity_id?: number;
	created?: string[]; memory_id?: string; transfer_id?: string; company_free?: boolean; me?: string };

/** Queues each item once per fingerprint (kind, subject ids, their card hashes): unchanged items never repeat, changed ones queue again. */
export function enqueue(storage: DurableObjectStorage, items: { kind: string; subjects: string[]; slot?: string }[]): void {
	storage.transactionSync(() => {
		const sql = storage.sql;
		let tx: BudgetTx | undefined;
		enqueueIn(sql, () => (tx ??= new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString())), items);
	});
}

/** The same inside the caller's transaction; `tx()` is taken only for a new item. Returns how many items were new. */
export function enqueueIn(sql: SqlStorage, tx: () => BudgetTx, items: { kind: string; subjects: string[]; slot?: string }[]): number {
	let added = 0;
	for (const it of items) {
		const subjects = [...new Set(it.subjects)].sort();
		const cards = sql.exec<{ card_hash: string }>("SELECT card_hash FROM nodes WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(subjects)).toArray();
		const fingerprint = sha256(JSON.stringify([it.kind, subjects, cards.map((c) => c.card_hash), ...(it.slot ? [it.slot] : [])]));
		if (sql.exec("SELECT 1 FROM maintenance WHERE fingerprint = ?", fingerprint).toArray().length) continue;
		const t = tx();
		t.run("INSERT OR IGNORE INTO maintenance (kind, subjects, fingerprint, created_at, seq) VALUES (?, ?, ?, ?, ?)",
			it.kind, JSON.stringify(subjects), fingerprint, t.now, t.seq);
		added++;
	}
	return added;
}

/** profile_meta key binding the latest maintenance_next request_id to the lease it made: ids, a request hash and a date only. */
const LEASE_REQUEST = "lease_request";
type LeaseRequest = { request_id: string; hash: string; lease_id: string; lease_until: string };

/**
 * Leases up to 40 open items for at most 900 s, at most once per profile in 20 hours. Expired leases go back to the queue
 * first (stuck after 3 attempts). Each item carries its subjects' cards, a passage of up to 1,200 characters and current edges.
 * With a request_id, the lease and its binding commit together: a repeat of the same request returns that lease and its items
 * still leased, takes no attempt and moves no clock; once the lease expired it returns lease_id null, reason lease_expired.
 * The same id with other arguments is refused. Without a request_id (v1 runners) nothing is bound.
 */
export function next(storage: DurableObjectStorage, q: { kinds?: string[]; limit?: number; lease_seconds?: number; request_id?: string }) {
	const limit = Math.min(q.limit ?? MAX_ITEMS, MAX_ITEMS), lease = Math.min(q.lease_seconds ?? MAX_LEASE_S, MAX_LEASE_S);
	if (limit < 1 || lease < 1) throw Fail.of("validation", "limit and lease_seconds must be positive");
	if (q.request_id !== undefined && (typeof q.request_id !== "string" || q.request_id.length < 1 || q.request_id.length > 256)) throw Fail.of("validation", "request_id is 1 to 256 characters");
	const hash = sha256(JSON.stringify([q.kinds?.length ? [...q.kinds].sort() : null, limit, lease]));
	return storage.transactionSync(() => {
		const sql = storage.sql, now = Date.now(), iso = new Date(now).toISOString();
		const bound = q.request_id === undefined ? undefined : leaseRequest(sql);
		if (bound && bound.request_id === q.request_id) {
			if (bound.hash !== hash) throw Fail.of("idempotency_mismatch", "this request_id already leased with other arguments", { reason: "request_mismatch" });
			if (Date.parse(bound.lease_until) < now) return { lease_id: null, items: [], next_allowed_at: cooldownUntil(sql, now), reason: "lease_expired" as const };
			const still = sql.exec<LeaseRow>("SELECT id, kind, subjects, created_at FROM maintenance WHERE lease_id = ? AND state = 'leased' ORDER BY created_at, id", bound.lease_id).toArray();
			return { lease_id: bound.lease_id, lease_until: bound.lease_until, items: still.map((i) => leasedItem(sql, i)), replayed: true };
		}
		const gated = cooldownUntil(sql, now);
		if (gated) return { lease_id: null, items: [], next_allowed_at: gated };
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), iso);
		release(tx);
		const items = selectNext(sql, iso, q.kinds, limit);
		if (!items.length) return { lease_id: null, items: [], next_allowed_at: null };
		const leaseId = crypto.randomUUID(), until = new Date(now + lease * 1000).toISOString();
		tx.run("UPDATE maintenance SET state = 'leased', lease_id = ?, lease_until = ?, attempts = attempts + 1, seq = ? WHERE id IN (SELECT value FROM json_each(?))",
			leaseId, until, tx.seq, JSON.stringify(items.map((i) => i.id)));
		tx.run(`INSERT INTO cursors (stage, due_at, last_run_at) VALUES ('maintenance_batch', 0, ?)
			ON CONFLICT (stage) DO UPDATE SET last_run_at = excluded.last_run_at`, iso);
		if (q.request_id !== undefined) tx.run("INSERT INTO profile_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			LEASE_REQUEST, JSON.stringify({ request_id: q.request_id, hash, lease_id: leaseId, lease_until: until } satisfies LeaseRequest));
		return { lease_id: leaseId, lease_until: until, items: items.map((i) => leasedItem(sql, i)) };
	});
}

type LeaseRow = { id: number; kind: string; subjects: string; created_at: string };
/** One leased item as the batch sees it, for a fresh lease and its replay alike. */
function leasedItem(sql: SqlStorage, i: LeaseRow) {
	const subjects = JSON.parse(i.subjects) as string[];
	return { item_id: i.id, kind: i.kind, subjects, context: context(sql, subjects, i.kind), allowed_ops: opsFor(i.kind),
		...(i.kind === "weekly_review" ? { board: reviewBoard(sql, i.created_at, subjects) } : {}) };
}

/** The stored binding, or undefined when none or unreadable (a damaged value never replays). */
function leaseRequest(sql: SqlStorage): LeaseRequest | undefined {
	const raw = sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = ?", LEASE_REQUEST).toArray()[0]?.value;
	try {
		const v = raw ? JSON.parse(raw) as Partial<LeaseRequest> : undefined;
		return v && typeof v.request_id === "string" && typeof v.hash === "string" && typeof v.lease_id === "string" && typeof v.lease_until === "string" ? v as LeaseRequest : undefined;
	} catch { return undefined; }
}

/** The 20-hour gate: when the next lease is allowed, or null when a lease may run now. */
function cooldownUntil(sql: SqlStorage, now: number): string | null {
	const last = sql.exec<{ last_run_at: string | null }>("SELECT last_run_at FROM cursors WHERE stage = 'maintenance_batch'").toArray()[0]?.last_run_at;
	return last && now - Date.parse(last) < BATCH_GAP_MS ? new Date(Date.parse(last) + BATCH_GAP_MS).toISOString() : null;
}

/**
 * The items a lease at `iso` takes, in lease order: open items and the expired leases release() reopens. After release() the
 * second clause matches nothing, so next() and the owner's preview share this one selection.
 */
function selectNext(sql: SqlStorage, iso: string, kinds: string[] | undefined, limit: number) {
	const k = kinds?.length ? JSON.stringify(kinds) : null;
	return sql.exec<{ id: number; kind: string; subjects: string; created_at: string; attempts: number; state: string }>(`SELECT id, kind, subjects, created_at, attempts, state
		FROM maintenance WHERE (state = 'open' OR (state = 'leased' AND lease_until < ? AND attempts < ?))
		AND (? IS NULL OR kind IN (SELECT value FROM json_each(?))) ORDER BY created_at, id LIMIT ?`, iso, MAX_ATTEMPTS, k, k, limit).toArray();
}

/**
 * The owner's read-only observation of the next normal lease (maintenance_next with no kind filter and the full limit), as
 * of observed_at. It takes no lease and changes no item, attempt, cursor or clock. While the cooldown holds, the candidates
 * are what a lease would select at observed_at, not what may be leased now. Ids, kinds, dates and counts only.
 */
export function nextPreview(sql: SqlStorage) {
	const now = Date.now(), iso = new Date(now).toISOString(), until = cooldownUntil(sql, now);
	const candidates = selectNext(sql, iso, undefined, MAX_ITEMS);
	// release()'s other effect: an expired lease at the attempt cap parks as stuck instead of reopening.
	const park = sql.exec<{ id: number }>("SELECT id FROM maintenance WHERE state = 'leased' AND lease_until < ? AND attempts >= ? ORDER BY id", iso, MAX_ATTEMPTS).toArray();
	return {
		observation: "not_a_lease" as const, lease_id: null, observed_at: iso,
		cooldown: until ? { status: "gated" as const, next_allowed_at: until } : { status: "open" as const, next_allowed_at: null },
		leasable_now: !until && candidates.length > 0,
		candidates: candidates.map((r) => ({ item_id: r.id, kind: r.kind, created_at: r.created_at, attempts: r.attempts,
			expired_lease: r.state === "leased", subjects: JSON.parse(r.subjects) as string[] })),
		parks_as_stuck: park.map((r) => r.id),
	};
}

/** Expired leases return to the queue; an item that keeps expiring is parked as stuck. */
function release(tx: BudgetTx): void {
	tx.run(`UPDATE maintenance SET state = CASE WHEN attempts >= ? THEN 'stuck' ELSE 'open' END, lease_id = NULL, lease_until = NULL, seq = ?
		WHERE state = 'leased' AND lease_until < ?`, MAX_ATTEMPTS, tx.seq, tx.now);
}

function context(sql: SqlStorage, subjects: string[], kind: string) {
	// Inspect identity/status first. Capture subjects are explicit job input; they never widen weekly or graph visibility.
	const readable = readableNodeIds(sql, subjects);
	if (kind === "unprocessed_capture" || kind === "preference_signal") {
		for (const n of sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status = 'candidate'", JSON.stringify(subjects)).toArray()) readable.add(n.id);
	}
	for (const id of archiveNodeIds(sql,[...readable])) readable.delete(id);
	const ids = JSON.stringify([...readable]);
	const nodes = sql.exec<{ id: string; kind: string; other_label: string | null; memory_type: string | null; scope: string; name: string; description: string; status: string; origin: string; pinned: number; revision: number }>(
		"SELECT id, kind, other_label, memory_type, scope, name, description, status, origin, pinned, revision FROM nodes WHERE id IN (SELECT value FROM json_each(?))", ids).toArray()
		.map((n) => ({ ...n, ...(n.kind === "journal" ? journalPrefix(sql, n.id) : {}), passage: n.other_label === "capture" ? captureText(sql, n.id).slice(0, 1200)
			// A capture item's session text is its current digest parts (read.ts captureVisible): never a manifest, a superseded heuristic
			// or a consolidated part the accepted manifest leaves out.
			: n.kind === "session" && (kind === "unprocessed_capture" || kind === "preference_signal") ? sql.exec<{ body: string }>(`SELECT t.body FROM texts t WHERE t.node_id = ? AND t.part = 'capture'
				AND t.lane = 'capture' AND t.live = 1 AND t.capture_part IS NOT 'manifest' AND (t.capture_status IS NOT 'consolidated' OR coalesce(${manifestListed}, 1) > 0) ORDER BY t.rowid`, n.id)
				.toArray().map((r) => r.body).join("\n").slice(0, 1200)
			: readPrefix(sql, n.id) }));
	const refs = sql.exec<{ id: number; src: string }>("SELECT id, src FROM edges WHERE ended_at IS NULL AND (src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))) LIMIT 50", ids, ids).toArray();
	const sources = readableNodeIds(sql, [...new Set(refs.map((e) => e.src))]);
	for (const id of archiveNodeIds(sql,[...sources])) sources.delete(id);
	// A capture item may read its own candidate subjects, never an unrelated incoming candidate's reason.
	if (kind === "unprocessed_capture" || kind === "preference_signal") for (const id of readable) sources.add(id);
	const edges = sql.exec("SELECT id, src, rel, dst, dst_profile, basis, reason FROM edges WHERE id IN (SELECT value FROM json_each(?))",
		JSON.stringify(refs.filter((e) => sources.has(e.src)).map((e) => e.id))).toArray();
	return { nodes, edges };
}

/** Whole entries only; separators count toward the 24k input bound. */
function journalPrefix(sql: SqlStorage, id: string) {
	const attrs = sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE id = ?", id).one().attrs, F = fenceOf(attrs);
	let text = "", through = F;
	const rows = sql.exec<{ seq_no: number; chunk: number; body: string; separator: string | null }>("SELECT seq_no, chunk, body, separator FROM texts WHERE node_id = ? AND part = 'entry' AND live <> 0 AND seq_no > ? ORDER BY seq_no, chunk", id, F).toArray();
	const entries = new Map<number, string>();
	for (const r of rows) entries.set(r.seq_no, (entries.get(r.seq_no) ?? "") + (r.chunk === 0 ? r.separator ?? "" : "") + r.body);
	for (const [seq, entry] of entries) { if (text.length + entry.length > 24_000) break; text += entry; through = seq; }
	return { compacted_through: F, through_seq: through, uncompacted_prefix: text, current_summary: sql.exec<{ body: string }>("SELECT body FROM texts WHERE node_id = ? AND part = 'summary' AND live = 1 ORDER BY chunk", id).toArray().map((r) => r.body).join("") };
}

/**
 * Applies one lease's results. Ops run one by one through runWrite as actor maintenance with request id
 * "maint:<lease>:<item>:<n>", so a retried call replays; a finished item returns its stored outcome. Outcomes hold op names
 * and codes only, never content.
 */
export function complete(storage: DurableObjectStorage, who: Who, raw: { lease_id: string; results: { item_id: number; ops: MaintenanceOp[] }[] }, job: JobContext) {
	// Model text is redacted before anything is applied, hashed or flagged, as on every other write path.
	const c = redactPayload(raw);
	const sql = storage.sql, now = Date.now();
	const items = new Map(sql.exec<{ id: number; kind: string; subjects: string; state: string; lease_until: string | null; outcome: string | null; created_at: string }>(
		"SELECT id, kind, subjects, state, lease_until, outcome, created_at FROM maintenance WHERE lease_id = ?", c.lease_id).toArray().map((r) => [r.id, r]));
	// wiring: ErrorCode gains "lease_expired".
	const expired = () => Fail.of("lease_expired" as ErrorCode, "this lease expired; its items went back to the queue", { reason: "lease_expired" });
	if (!items.size) throw expired();
	if ([...items.values()].some((i) => i.state === "leased" && Date.parse(i.lease_until!) < now)) {
		storage.transactionSync(() => release(new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date(now).toISOString())));
		throw expired();
	}
	let embedDue = false;
	const results = c.results.map((r) => {
		const item = items.get(r.item_id);
		if (!item) return { item_id: r.item_id, status: "rejected", reason: "not_in_lease" };
		if (item.state !== "leased") return { item_id: r.item_id, ...(JSON.parse(item.outcome ?? "{}") as object), replayed: true };
		if (r.ops.length > MAX_OPS) return { item_id: r.item_id, status: "rejected", reason: "too_many_ops" };
		const subjects = new Set(JSON.parse(item.subjects) as string[]), allowed = opsFor(item.kind);
		const ops: OpOutcome[] = [];
		for (const [n, op] of r.ops.entries()) {
			if (!allowed.includes(op.op)) { ops.push({ op: op.op, status: "rejected", code: "validation", reason: "op_not_allowed" }); continue; }
			const o = apply(storage, who, op, subjects, job, `maint:${c.lease_id}:${item.id}:${n}`, ops, item);
			embedDue ||= o.embedDue;
			ops.push(o.outcome);
		}
		// What this item committed is settled by the alarm even if the caller never sees this result (no client replay needed).
		const box: Outbox = { created: ops.flatMap((o) => o.created ?? []), promote: ops.flatMap((o) => (o.status === "transfer_started"
			? [{ id: o.transfer_id!, node: o.memory_id!, me: o.me!, device: job.deviceId!, company_free: true as const }] : [])) };
		// A same-lease retry adds to an unsettled row: earlier ids and intents stay exactly as accepted, new ones join them.
		const intend = (tx: BudgetTx) => {
			const stage = `${OUTBOX}${c.lease_id}:${item.id}`;
			const prior = sql.exec<{ cursor: string }>("SELECT cursor FROM cursors WHERE stage = ?", stage).toArray()[0];
			const was: Outbox = prior ? JSON.parse(prior.cursor) as Outbox : { created: [], promote: [] };
			const all: Outbox = { created: [...new Set([...was.created, ...box.created])], promote: [...was.promote, ...box.promote.filter((p) => !was.promote.some((q) => q.id === p.id))] };
			if (all.created.length || all.promote.length) tx.run("INSERT INTO cursors (stage, cursor, due_at) VALUES (?, ?, ?) ON CONFLICT (stage) DO UPDATE SET cursor = excluded.cursor, due_at = excluded.due_at",
				stage, JSON.stringify(all), Date.now() + RESUME_MS);
		};
		// A subject in transfer refused an op: the item is not marked done, so it stays queued and returns when its lease expires.
		if (ops.some((o) => o.code === "moving")) {
			storage.transactionSync(() => intend(new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString())));
			return { item_id: r.item_id, status: "rejected", reason: "moving", ops };
		}
		const outcome = { status: r.ops.some((o) => o.op === "dismiss") ? "dismissed" : "done", ops };
		storage.transactionSync(() => {
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			tx.run("UPDATE maintenance SET state = ?, done_at = ?, outcome = ?, seq = ? WHERE id = ?", outcome.status, tx.now, JSON.stringify(outcome), tx.seq, item.id);
			intend(tx);
		});
		return { item_id: r.item_id, ...outcome };
	});
	return { results, embedDue };
}

/** Due outbox rows, oldest first, at most `limit` per alarm. */
export function dueOutbox(sql: SqlStorage, now: number, limit = 10): { stage: string; box: Outbox }[] {
	return sql.exec<{ stage: string; cursor: string }>("SELECT stage, cursor FROM cursors WHERE stage LIKE ? AND due_at <= ? ORDER BY due_at LIMIT ?", `${OUTBOX}%`, now, limit)
		.toArray().map((r) => ({ stage: r.stage, box: JSON.parse(r.cursor) as Outbox }));
}

/** When the alarm should next settle an outbox row, or null if none. */
export function nextOutbox(sql: SqlStorage): number | null {
	return sql.exec<{ at: number | null }>("SELECT min(due_at) AS at FROM cursors WHERE stage LIKE ?", `${OUTBOX}%`).one().at;
}

/**
 * Whether a stored promotion may still go ahead: its target is fenced by this very transfer or already moved (the driver then
 * finishes or refuses it), or it is still an active preference. Otherwise it is aborted. Protection is checked, and flagged,
 * by the source fence itself.
 */
export function promotable(sql: SqlStorage, p: Outbox["promote"][number]): boolean {
	const n = sql.exec<{ kind: string; status: string; fence: string | null }>("SELECT kind, status, json_extract(attrs, '$.transfer.id') AS fence FROM nodes WHERE id = ?", p.node).toArray()[0];
	return !!n && (n.fence === p.id || n.status === "moved" || (n.kind === "preference" && n.status === "active"));
}

/**
 * A proven job runtime can release its own unfinished lease, or park it after a detected tool event. An unproven one, with no
 * lease, records only its skip in the batch_status cursor: no item is read or changed and no activity is written. No node is changed.
 */
export function finishBatch(storage: DurableObjectStorage, c: { lease_id?: string; status: "batch_skipped" | "stuck"; reason: string }, job: JobContext) {
	if (!/^[a-z_]{1,64}$/.test(c.reason)) throw Fail.of("validation", "batch reason must be a content-free code");
	return storage.transactionSync(() => {
		const sql = storage.sql;
		if (c.lease_id === undefined) {
			if (c.status !== "batch_skipped") throw Fail.of("validation", "only batch_skipped may omit lease_id");
			sql.exec(`INSERT INTO cursors (stage, due_at, last_run_at, last_error, stats) VALUES ('batch_status', 0, ?, ?, ?)
				ON CONFLICT (stage) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error, stats = excluded.stats`,
				new Date().toISOString(), c.reason, JSON.stringify({ status: c.status, items: 0 }));
			return { status: c.status, released: 0 };
		}
		const ids = sql.exec<{ id: number }>("SELECT id FROM maintenance WHERE lease_id = ? AND state = 'leased' ORDER BY id LIMIT 40", c.lease_id).toArray().map((r) => r.id);
		if (!ids.length) return { status: c.status, released: 0 };
		const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
		tx.run("UPDATE maintenance SET state = ?, lease_id = NULL, lease_until = NULL, outcome = ?, seq = ? WHERE id IN (SELECT value FROM json_each(?))",
			c.status === "stuck" ? "stuck" : "open", JSON.stringify({ status: c.status, reason: c.reason }), tx.seq, JSON.stringify(ids));
		tx.run("INSERT INTO activity (at, actor, device_id, op, summary, targets, seq) VALUES (?, 'maintenance', ?, ?, ?, '[]', ?)",
			tx.now, job.deviceId ?? null, c.status, c.reason, tx.seq);
		tx.run(`INSERT INTO cursors (stage, due_at, last_run_at, last_error, stats) VALUES ('batch_status', 0, ?, ?, ?)
			ON CONFLICT (stage) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error, stats = excluded.stats`, tx.now, c.reason, JSON.stringify({ status: c.status, items: ids.length }));
		return { status: c.status, released: ids.length };
	});
}

/** The owner's view of the daily batch (section 15): when it last leased, and its last skip or park. Codes and dates only. */
export function batchStatus(sql: SqlStorage) {
	const rows = new Map(sql.exec<{ stage: string; last_run_at: string | null; last_error: string | null; stats: string | null }>(
		"SELECT stage, last_run_at, last_error, stats FROM cursors WHERE stage IN ('maintenance_batch', 'batch_status')").toArray().map((r) => [r.stage, r]));
	const s = rows.get("batch_status"), stats = s?.stats ? (JSON.parse(s.stats) as { status: string; items: number }) : null;
	return { last_lease_at: rows.get("maintenance_batch")?.last_run_at ?? null,
		last_status: s && stats ? { status: stats.status, reason: s.last_error, items: stats.items, at: s.last_run_at } : null,
		last_completed_lease: lastCompletedLease(sql) };
}

// Stored op names and reasons predate this read; anything that is not a plain code reads as "unrecognized", never as text.
const CODE = /^[a-z0-9_]{1,64}$/, ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const asCode = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : "unrecognized");
const asId = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);

/** One stored op outcome as an allowlist of codes and ids: no prompt, summary, flag reason or other text. */
function opReceipt(o: Partial<Record<keyof OpOutcome, unknown>>) {
	const ids = (Array.isArray(o.created) ? o.created : []).map(asId).filter((x): x is string => !!x);
	return { op: asCode(o.op), status: asCode(o.status), ...(o.code !== undefined ? { code: asCode(o.code) } : {}), ...(o.reason !== undefined ? { reason: asCode(o.reason) } : {}),
		...(Number.isSafeInteger(o.activity_id) ? { activity_id: o.activity_id as number } : {}), ...(ids.length ? { created: ids } : {}),
		...(asId(o.memory_id) ? { memory_id: asId(o.memory_id) } : {}), ...(asId(o.transfer_id) ? { transfer_id: asId(o.transfer_id) } : {}) };
}

/** Every item of the lease that most recently completed an item, with its stored per-op outcomes. Read-only; ids and codes only. */
function lastCompletedLease(sql: SqlStorage) {
	const lease = sql.exec<{ lease_id: string }>("SELECT lease_id FROM maintenance WHERE lease_id IS NOT NULL AND state IN ('done', 'dismissed') ORDER BY done_at DESC, id DESC LIMIT 1").toArray()[0]?.lease_id;
	if (!lease) return null;
	const items = sql.exec<{ id: number; kind: string; state: string; done_at: string | null; outcome: string | null }>(
		"SELECT id, kind, state, done_at, outcome FROM maintenance WHERE lease_id = ? ORDER BY id LIMIT ?", lease, MAX_ITEMS).toArray();
	return { lease_id: lease, items: items.map((r) => {
		const o = r.outcome ? JSON.parse(r.outcome) as { status?: unknown; reason?: unknown; ops?: unknown } : {};
		return { item_id: r.id, kind: r.kind, state: r.state, done_at: r.done_at, ...(o.status !== undefined ? { status: asCode(o.status) } : {}),
			...(o.reason !== undefined ? { reason: asCode(o.reason) } : {}), ops: Array.isArray(o.ops) ? o.ops.map((x) => opReceipt(x ?? {})) : [] };
	}) };
}

/**
 * `earlier`: this item's outcomes so far, so a from_op can name only an op before it. `item`: the leased item, which dates a
 * review and limits a stale record's save to retiring it.
 */
function apply(storage: DurableObjectStorage, who: Who, op: MaintenanceOp, subjects: Set<string>, job: JobContext, requestId: string, earlier: OpOutcome[],
	item: { id: number; kind: string; created_at: string }): { outcome: OpOutcome; embedDue: boolean } {
	const sql = storage.sql;
	const done = (outcome: Omit<OpOutcome, "op">, embedDue = false) => ({ outcome: { op: op.op, ...outcome }, embedDue });
	const refuse = (reason: string) => done({ status: "rejected", code: "validation", reason });
	// A shared-writer refusal keeps its content-free reason code (details.reason), never its message.
	const failed = (e: Fail) => { const r = e.failure.details?.reason; return done({ status: "rejected", code: e.failure.code, ...(typeof r === "string" && CODE.test(r) ? { reason: r } : {}) }); };
	if (op.op === "dismiss") return done({ status: "applied" });
	if (op.op === "suggest_eval_case") return suggestEvalCase(storage, who, op, subjects, requestId, done, refuse, failed);
	// A stale record's save only retires it: no rename or content change rides along. mayChange still decides below.
	if (item.kind === "stale_memory" && op.op === "save" && (op.retire !== true || Object.keys(op).some((k) => !["op", "memory_id", "retire", "expected_revision"].includes(k)))) return refuse("retire_only");
	let touched: string[], local = true;
	if (op.op === "end_link") {
		const e = sql.exec<{ src: string; dst: string; dst_profile: string }>("SELECT src, dst, dst_profile FROM edges WHERE id = ? AND ended_at IS NULL", op.edge).toArray()[0];
		if (!e) return done({ status: "rejected", code: "not_found" });
		// A foreign or absent target is opaque: the item must name it, and only the real local source is checked and changed.
		const opaque = e.dst_profile !== "" || !sql.exec("SELECT 1 FROM nodes WHERE id = ?", e.dst).toArray().length;
		if (opaque && !subjects.has(e.dst)) return done({ status: "rejected", code: "outside_subjects" });
		touched = opaque ? [e.src] : [e.src, e.dst];
	} else if (op.op === "infer_preference") {
		// The evidence is the item's own subjects, as local node pointers; the new preference touches nothing else.
		if (!Array.isArray(op.evidence) || op.evidence.length < 1 || op.evidence.length > 10) return refuse("bad_evidence");
		if (op.evidence.some((e) => e.kind !== "node" || !subjects.has(e.ref))) return done({ status: "rejected", code: "outside_subjects" });
		touched = [];
	} else if (op.op === "promote_to_me") {
		if (op.company_free !== true) return refuse("company_free_required");
		if (!job.me || !job.deviceId) return done({ status: "rejected", code: "forbidden" });
		if (who.profile === "me") return refuse("already_in_me");
		// One target: a subject, or the preference an earlier infer op of this same item created.
		const made = op.from_op === undefined ? undefined : earlier[op.from_op];
		if ((op.from_op === undefined) === (op.memory_id === undefined) || (op.from_op !== undefined && (made?.op !== "infer_preference" || !made.created?.length))) return refuse("bad_target");
		touched = [made ? made.created![0]! : op.memory_id!];
		local = !made;
	} else if (op.op === "strategic_review") {
		// A new document that only points at the item's subjects: it changes none of them, and nothing in me.
		if (who.profile === "me") return done({ status: "rejected", code: "forbidden" });
		if (!Array.isArray(op.links) || op.links.length > REVIEW_LINKS) return refuse("bad_links");
		if (op.links.some((l) => !subjects.has(l.to) || !Array.isArray(l.evidence) || !l.evidence.length || l.evidence.some((e) => e.kind !== "node" || !subjects.has(e.ref)))) {
			return done({ status: "rejected", code: "outside_subjects" });
		}
		touched = [];
	} else {
		touched = (op.op === "save" || op.op === "compact") ? [op.memory_id] : op.op === "link" ? [op.from, op.to] : op.op === "supersede" ? [op.keep, ...op.retire] : [op.node];
	}
	const evidenceIds = "evidence" in op ? (op.evidence ?? []).filter(e=>e.kind === "node").map(e=>e.ref) : [];
	if (op.op !== "flag" && archiveNodeIds(sql,[...subjects,...touched,...evidenceIds]).length) return refuse("archival_reference");
	if (local && !touched.every((id) => subjects.has(id))) return done({ status: "rejected", code: "outside_subjects" });
	const nodes = sql.exec<{ id: string; origin: string; pinned: number; kind: string; status: string }>("SELECT id, origin, pinned, kind, status FROM nodes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(touched)).toArray();
	if (nodes.length !== new Set(touched).size) return done({ status: "rejected", code: "not_found" });
	if (op.op === "promote_to_me") {
		if (nodes[0]!.status === "moving" || nodes[0]!.status === "incoming") return done({ status: "rejected", code: "moving" });
		if (nodes[0]!.kind !== "preference" || nodes[0]!.status !== "active") return refuse("not_promotable");
	}
	const refused = nodes.map((n) => ({ id: n.id, why: mayChange(n, "maintenance", who.profile) })).filter((n) => n.why);
	if (op.op === "flag" || refused.length) {
		const flags = op.op === "flag" ? [{ id: op.node, why: op.reason }] : refused;
		try {
			const ids = storage.transactionSync(() => {
				// The shared writer's gates hold for flags too: a flag set on a packed record would be lost when the move publishes.
				assertOpen(sql);
				for (const f of flags) assertWritable(sql, f.id);
				const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
				return flags.map((f) => flagProtected(tx, f.id, f.why!, op.op, "maintenance"));
			});
			return done({ status: op.op === "flag" ? "applied" : "flagged", activity_id: ids[ids.length - 1]! });
		} catch (e) {
			if (e instanceof Fail) return failed(e);
			throw e;
		}
	}
	// Nothing crosses profiles here: the Worker moves the record through the C3 transfer under this deterministic id.
	if (op.op === "promote_to_me") return done({ status: "transfer_started", memory_id: touched[0]!, transfer_id: uuid5(requestId.replace(/^maint:/, `${who.userId}:promote:`)), company_free: true, me: job.me! });
	// The request row commits with the save and survives archival/undo. A later lease replays that outcome, never a new draft.
	const review = op.op === "strategic_review" ? { name: `Strategic review ${item.created_at.slice(0, 10)}`, as_of: item.created_at } : undefined;
	if (review) {
		requestId = `maint:review:${who.generation}:${item.id}`;
		const prior = sql.exec<{ node_id: string; result: string }>("SELECT node_id, result FROM requests WHERE request_id = ? AND op = 'save'", requestId).toArray()[0];
		if (prior) {
			try { assertOpen(sql); assertNotWiped(sql, prior.node_id); } catch (e) {
				if (e instanceof Fail) return failed(e);
				throw e;
			}
			const result = JSON.parse(prior.result) as { action: string; activity_id?: number };
			return done({ status: result.action === "flagged" ? "flagged" : "applied", reason: "already_written",
				...(typeof result.activity_id === "number" ? { activity_id: result.activity_id } : {}),
				...(result.action === "created" ? { created: [prior.node_id] } : {}) });
		}
	}
	const cmd: WriteCommand = op.op === "strategic_review" ? { op: "save", args: { name: review!.name, type: "reference", kind: "document", description: op.summary, content: op.content,
			scope: "default", origin: "agent", review: { as_of: review!.as_of, item: item.id, coverage: reviewBoard(sql, review!.as_of, [...subjects]).coverage },
			// An empty board's review has nothing to link: the shared writer takes links only as a non-empty list.
			...(op.links.length ? { links: op.links.map((l) => ({ rel: "relates_to" as const, to: { id: l.to }, reason: l.reason, evidence: l.evidence })) } : {}), request_id: requestId } }
		: op.op === "infer_preference" ? { op: "save", args: { name: op.name, type: "user", kind: "preference", description: op.description,
			...(op.why !== undefined ? { why: op.why } : {}), ...(op.how_to_apply !== undefined ? { how_to_apply: op.how_to_apply } : {}), scope: op.scope ?? "default",
			origin: "inferred", evidence: op.evidence, request_id: requestId } }
		: op.op === "save" ? { op: "save", args: { ...withoutOp(op), request_id: requestId } }
		: op.op === "compact" ? { op: "save", args: { memory_id: op.memory_id, compact: { through_seq: op.through_seq, summary: op.summary }, expected_revision: op.expected_revision, request_id: requestId } }
		: op.op === "supersede" ? { op: "save", args: { memory_id: op.keep, supersedes: op.retire, request_id: requestId } }
			: op.op === "link" ? { op: "knowledge", args: { edges: [{ from: { id: op.from }, to: { id: op.to }, rel: op.rel, ...(op.other_label ? { other_label: op.other_label } : {}), reason: op.reason, evidence: op.evidence }], request_id: requestId } }
				: { op: "knowledge", args: { end: [{ edge: op.edge, valid_to: op.valid_to ?? new Date().toISOString(), reason: op.reason }], request_id: requestId } };
	try {
		const out = runWrite(storage, who, cmd, {
			// wiring: WriteContext.actor gains "keep" | "index" | "maintenance".
			actor: "maintenance" as WriteContext["actor"], ...(job.deviceId ? { deviceId: job.deviceId } : {}), platform: job.platform,
			routedBy: "maintenance", payloadHash: requestHash(`maintenance_${op.op}`, cmd.args as unknown as Record<string, unknown>), userId: job.userId,
		});
		// A replay reports what the first run did; only a created preference is registered and may be promoted.
		const action = out.result.action === "replayed" ? (JSON.parse(sql.exec<{ result: string }>("SELECT result FROM requests WHERE request_id = ?", requestId).one().result) as { action: string }).action : out.result.action;
		return done({ status: action === "flagged" ? "flagged" : "applied", ...(typeof out.result.activity_id === "number" ? { activity_id: out.result.activity_id } : {}),
			...((op.op === "infer_preference" || op.op === "strategic_review") && action === "created" ? { created: [String(out.result.memory_id)] } : {}) }, out.embedDue);
	} catch (e) {
		if (e instanceof Fail) return failed(e);
		throw e;
	}
}

const withoutOp = ({ op: _op, ...rest }: Extract<MaintenanceOp, { op: "save" }>) => rest;

type Done = (outcome: Omit<OpOutcome, "op">, embedDue?: boolean) => { outcome: OpOutcome; embedDue: boolean };
/**
 * Stores an eval candidate from a corrected recall. Its evidence is the item's own subjects as node pointers; expected ids
 * may name records in other profiles. The candidate id derives from the op's request id (lease, item, op index), so a retried
 * completion returns the stored candidate. insertCandidate runs inside this transaction and refuses any id a wipe fenced.
 * No node changes, so there is nothing for mayChange to protect.
 */
function suggestEvalCase(storage: DurableObjectStorage, who: Who, op: Extract<MaintenanceOp, { op: "suggest_eval_case" }>, subjects: Set<string>, requestId: string,
	done: Done, refuse: (reason: string) => ReturnType<Done>, failed: (e: Fail) => ReturnType<Done>): ReturnType<Done> {
	const sql = storage.sql;
	if (typeof op.query !== "string" || !op.query.trim() || op.query.length > 280) return refuse("bad_query");
	if (!Array.isArray(op.expected) || op.expected.length < 1 || op.expected.length > 20 || op.expected.some((id) => typeof id !== "string" || !id || id.length > 128)) return refuse("bad_expected");
	if (!Array.isArray(op.evidence) || op.evidence.length < 1 || op.evidence.length > 20) return refuse("bad_evidence");
	if (op.evidence.some((e) => e?.kind !== "node" || !subjects.has(e.ref))) return done({ status: "rejected", code: "outside_subjects" });
	// A local record in the archive is not a recall answer; a foreign id is not checked here.
	if (archiveNodeIds(sql, [...subjects, ...op.expected]).length) return refuse("archival_reference");
	const id = uuid5(requestId.replace(/^maint:/, `${who.userId}:eval:`));
	try {
		storage.transactionSync(() => {
			const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
			insertCandidate(sql, tx.seq, tx.now, id, { query: op.query, expected: op.expected, evidence: op.evidence });
		});
		return done({ status: "applied" });
	} catch (e) {
		if (e instanceof Fail) return failed(e);
		throw e;
	}
}
