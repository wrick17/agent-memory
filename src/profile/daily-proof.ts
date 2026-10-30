// Daily refresh proofs and the profile half of a claim (joint daily addendum v1, lifecycle addendum r2 and its archive
// amendment): the claim's pending mirror and sealed plan, each acknowledged part's exact item refs and proof, the per-item
// fence, the final eligibility check inside the terminal transaction, and the cleanup the account waits for before release.
import { canonicalJson, sha256 } from "../domain/ids";
import { Fail, type PRUploadArgs, type TicketUploadArgs } from "../domain/types";
import { takeSeq } from "../storage";
import type { ArchiveTx } from "./archive";
import { assertOpen } from "./wipe";
import { naturalRequest, prArgs, repoNamespace, ticketArgs, uploadKey } from "./work-upload";
import { Tx, type Who } from "./write";

/** Protocol binding B: the authenticated accepted claim. */
export interface Binding { profile: string; generation: string; device_id: string; day: string; claim_id: string }
type Kind = "pr" | "ticket";
export interface Parts {
	version: 1; selection_hash: string; as_of: string;
	sources: { source_id: string; kind: Kind; namespace: string; selector_hash: string; enumeration_hash: string; observed_items: number }[];
	frames: { part: number; source_id: string; kind: Kind; item_count: number; part_hash: string }[];
}
/** The outer `refresh` field of an ingest body. */
export interface PartMeta { day: string; claim_id: string; part: number; part_hash: string }
/** The ingest body without its outer `refresh` field, exactly as sent. */
export type Payload = { profile?: string; as_of: string; repo?: { remote: string }; prs?: Parameters<typeof prArgs>[1][]; tickets?: Parameters<typeof ticketArgs>[0][] };
export type Unproven = { status: "pending"; reason: string; part?: number; index?: number; reads?: number };
export type PartReply = { status: "acknowledged"; proof: Record<string, unknown>; receipt_hash: string } | Unproven;
/** A terminal as committed: its outcome and the exact request that committed it. */
export interface Terminal { outcome: "done" | "failed" | "abandoned"; request_id: string; body_sha256: string; reason: string | null }
export type TerminalReply = { status: "terminal"; terminal: Terminal; manifest_hash: string | null; cleaned: boolean; refs?: number; reads?: number; bytes?: number; rows_written?: number } | Unproven;

export const MAX_FRAMES = 64, PLAN_BYTES = 65_536, FRAME_ITEMS = { pr: 25, ticket: 20 } as const;
/**
 * Physical rows the final check may read: per ref its own row, request and receipt, then for a stored ref its activity and
 * revision (5), or for a stale ref its own revision if held and the newer revision with that revision's request, receipt and
 * activity (8); plus the claim row. Each read is a primary-key seek on narrow metadata (never a result body, activity undo
 * image or graph row), so 1,600 refs fit; a degraded plan refuses instead of reading on.
 */
const REF_READS = 8;
export const FINISH_READS = MAX_FRAMES * FRAME_ITEMS.pr * REF_READS + 1;
/** Cleanup transactions per terminal call: 300 refs each, so 1,600 refs, their part proofs and the plan fit in one call. */
const REFS_PER_STEP = 300, CLEANUP_STEPS = 8;

/** A thrown refusal rolls the transaction back; the caller gets it as a pending reply. */
class Refused { constructor(readonly reply: Unproven) {} }
const refuse = (reason: string, at: Omit<Unproven, "status" | "reason"> = {}): never => { throw new Refused({ status: "pending", reason, ...at }); };
const pending = <T>(f: () => T): T | Unproven => { try { return f(); } catch (e) { if (e instanceof Refused) return e.reply; throw e; } };

const hash = (v: unknown) => sha256(canonicalJson(v));
export const planHash = (b: Binding, parts: Parts) => hash({ version: 1, operation: "plan", binding: b, parts });
export const partHash = (b: Binding, part: number, sourceId: string, payload: Payload) => hash({ version: 1, operation: "part", binding: b, part, source_id: sourceId, payload });
const closed = (b: Binding): Binding => ({ profile: b.profile, generation: b.generation, device_id: b.device_id, day: b.day, claim_id: b.claim_id });
const meta = (sql: SqlStorage) => new Tx(sql, takeSeq(sql, "profile_meta").seq, new Date().toISOString(), { actor: "index", platform: "refresh", routedBy: "refresh", userId: "", payloadHash: "" }, null);

/**
 * Inside the upload's own transaction: its receipt, unregistered until markRegistered, and for a stored snapshot the first
 * receipt on its source revision.
 */
export function stampReceipt(tx: Tx, who: Who, a: PRUploadArgs | TicketUploadArgs, result: Record<string, unknown>): void {
	const key = uploadKey(a), stored = result.action === "stored";
	if (stored && !tx.sql.exec("SELECT 1 FROM upload_revisions WHERE key = ? AND revision = ?", key, a.updated_at).toArray().length) {
		// A receipt older than these rows may hide an undo, so its revision can never prove eligibility.
		const base = `upload:${who.profile}:${key}:${a.updated_at}`;
		const legacy = tx.sql.exec("SELECT 1 FROM requests WHERE request_id = ?1 OR (request_id >= ?2 AND request_id < ?3) LIMIT 1", base, `${base}:`, `${base};`).toArray().length;
		tx.run("INSERT INTO upload_revisions (key, revision, request_id, legacy, undone_by, seq) VALUES (?, ?, ?, ?, NULL, ?)", key, a.updated_at, tx.requestId!, legacy, tx.seq);
	}
	// Deleting the request deletes this row (schema v7 trigger); a request taken again gets a new seq, so old refs stop matching.
	// Activity ids are reused after the 400-day purge, so the activity is named by its id and time.
	tx.run("INSERT INTO upload_receipts (request_id, activity_id, at, key, revision, seq) VALUES (?, ?, ?, ?, ?, ?)",
		tx.requestId!, stored ? Number(result.activity_id) : null, tx.now, key, a.updated_at, tx.seq);
}

/** The receipt an upload wrote or replayed, read in the same synchronous turn as its transaction. */
export const receiptSeq = (sql: SqlStorage, requestId: string) => sql.exec<{ seq: number }>("SELECT seq FROM upload_receipts WHERE request_id = ?", requestId).toArray()[0]?.seq;

/**
 * Only after the item's nodes were registered for this generation and the account access was rechecked, with no await since:
 * proof for exactly that receipt. A receipt replaced meanwhile keeps none, and a failed registration leaves none to find.
 */
export function markRegistered(sql: SqlStorage, requestId: string, seq: number): void {
	sql.exec("UPDATE upload_receipts SET registered_at = ? WHERE request_id = ? AND seq = ? AND registered_at IS NULL", new Date().toISOString(), requestId, seq);
}

/** Inside the owner's Undo: an undone upload receipt makes its whole source revision ineligible, for good. */
export function markUndone(tx: Pick<ArchiveTx, "run" | "seq">, activityId: number, undoneBy: number): void {
	tx.run(`UPDATE upload_revisions SET undone_by = ?, seq = ? WHERE undone_by IS NULL
		AND (key, revision) IN (SELECT key, revision FROM upload_receipts WHERE activity_id = ?)`, undoneBy, tx.seq, activityId);
}

/** The claim's mirror, installed by the account after it reserved the day and before it confirms the claim. Idempotent. */
export function installMirror(storage: DurableObjectStorage, who: Who, b: Binding): void {
	storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		if (b.profile !== who.profile || b.generation !== who.generation) throw Fail.of("validation", "binding is not this profile generation", { reason: "binding_mismatch" });
		const text = canonicalJson(closed(b)), cur = sql.exec<{ binding: string }>("SELECT binding FROM refresh_claims WHERE claim_id = ?", b.claim_id).toArray()[0];
		if (cur) {
			if (cur.binding !== text) throw Fail.of("idempotency_mismatch", "this claim id is bound to another claim", { reason: "binding_mismatch" });
			return;
		}
		// The account admits a claim only after the previous one reported its cleanup; anything still open here breaks that.
		if (sql.exec("SELECT 1 FROM refresh_claims WHERE state = 'pending' OR cleaned = 0 LIMIT 1").toArray().length) throw Fail.of("busy", "an earlier daily claim is still open here", { reason: "prior_claim_open" });
		sql.exec("INSERT INTO refresh_claims (claim_id, binding, state, acked, cleaned, seq) VALUES (?, ?, 'pending', 0, 0, ?)", b.claim_id, text, takeSeq(sql, "profile_meta").seq);
	});
}

const HEX = /^[0-9a-f]{64}$/, SOURCE_ID = /^[A-Za-z0-9._:-]{1,64}$/, REPO = /^[a-z0-9][\w.-]*\/[\w.-]+$/;
const keys = (o: object, want: string[]) => Object.keys(o).sort().join() === [...want].sort().join();
/** The accepted plan shape: closed fields, sources sorted by id, frames 0..n-1 in source order within the caps, counts that add up. */
function validPlan(b: Binding, p: Parts): boolean {
	if (!p || typeof p !== "object" || !keys(p, ["version", "selection_hash", "as_of", "sources", "frames"]) || p.version !== 1 || !HEX.test(p.selection_hash)
		|| typeof p.as_of !== "string" || Number.isNaN(Date.parse(p.as_of)) || !Array.isArray(p.sources) || !Array.isArray(p.frames)
		|| p.sources.length > MAX_FRAMES || p.frames.length > MAX_FRAMES || Buffer.byteLength(canonicalJson(p), "utf8") > PLAN_BYTES) return false;
	const order = new Map<string, number>(), counts = new Map<string, number>();
	for (const [i, s] of p.sources.entries()) {
		if (!s || !keys(s, ["source_id", "kind", "namespace", "selector_hash", "enumeration_hash", "observed_items"]) || !SOURCE_ID.test(s.source_id)
			|| (i && s.source_id <= p.sources[i - 1]!.source_id) || !HEX.test(s.selector_hash) || !HEX.test(s.enumeration_hash)
			|| !Number.isInteger(s.observed_items) || s.observed_items < 0 || typeof s.namespace !== "string" || s.namespace.length > 128
			|| !(s.kind === "pr" ? REPO.test(s.namespace) : s.kind === "ticket" && b.profile === "work")) return false;
		order.set(s.source_id, i);
		counts.set(s.source_id, 0);
	}
	let last = 0;
	for (const [i, f] of p.frames.entries()) {
		const at = f && order.get(f.source_id);
		if (!f || !keys(f, ["part", "source_id", "kind", "item_count", "part_hash"]) || f.part !== i || at === undefined || at < last || p.sources[at]!.kind !== f.kind
			|| !Number.isInteger(f.item_count) || f.item_count < 1 || f.item_count > FRAME_ITEMS[f.kind] || !HEX.test(f.part_hash)) return false;
		last = at;
		counts.set(f.source_id, counts.get(f.source_id)! + f.item_count);
	}
	return p.sources.every((s) => counts.get(s.source_id) === s.observed_items);
}

type Claim = { binding: string; manifest_hash: string | null; parts: string | null; state: string; acked: number; terminal: string | null; invalid: string | null; cleaned: number };
const claimRow = (sql: SqlStorage, id: string) => sql.exec<Claim>("SELECT binding, manifest_hash, parts, state, acked, terminal, invalid, cleaned FROM refresh_claims WHERE claim_id = ?", id).toArray()[0];
/** The pending mirror for exactly this binding and profile generation. */
function bound(sql: SqlStorage, who: Who, b: Binding): Claim {
	const claim = claimRow(sql, b.claim_id);
	if (!claim) return refuse("claim_unknown");
	if (claim.binding !== canonicalJson(b) || b.profile !== who.profile || b.generation !== who.generation) return refuse("binding_mismatch");
	if (claim.state !== "pending") return refuse("claim_closed");
	return claim;
}
/** The plan the claim can still use; an erased descriptor never comes back and is never replaced. */
function plan(claim: Claim): Parts {
	if (claim.invalid) return refuse("descriptor_invalidated");
	if (!claim.parts) return refuse("plan_missing");
	return JSON.parse(claim.parts) as Parts;
}

/** Seals the claim's one plan, after the account confirmed the claim. The same plan replays; anything else refuses. */
export function sealPlan(storage: DurableObjectStorage, who: Who, b: Binding, parts: Parts, manifestHash: string): { status: "sealed" } | Unproven {
	return pending(() => storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const claim = bound(sql, who, b);
		if (claim.invalid) return refuse("descriptor_invalidated");
		if (claim.manifest_hash) return claim.manifest_hash === manifestHash && claim.parts === canonicalJson(parts) ? { status: "sealed" as const } : refuse("plan_mismatch");
		if (!validPlan(b, parts)) return refuse("plan_bounds");
		if (manifestHash !== planHash(b, parts)) return refuse("manifest_mismatch");
		sql.exec("UPDATE refresh_claims SET manifest_hash = ?, parts = ?, seq = ? WHERE claim_id = ?", manifestHash, canonicalJson(parts), takeSeq(sql, "profile_meta").seq, b.claim_id);
		return { status: "sealed" as const };
	}));
}

/**
 * The claim a part names, for this device and generation, with its plan and the part's frame; the frame's items as the upload
 * writer takes them, once day, sequence and the exact part hash match. An acknowledged part returns its stored proof instead.
 */
function framed(sql: SqlStorage, who: Who, deviceId: string | undefined, m: PartMeta, body: string, p: Payload) {
	const claim = claimRow(sql, m.claim_id);
	if (!claim) return refuse("claim_unknown", { part: m.part });
	const b = JSON.parse(claim.binding) as Binding;
	if (b.day !== m.day || b.device_id !== deviceId || b.profile !== who.profile || b.generation !== who.generation) return refuse("binding_mismatch", { part: m.part });
	if (claim.state !== "pending") return refuse("claim_closed", { part: m.part });
	const parts = plan(claim), frame = parts.frames[m.part];
	if (!frame || m.part > claim.acked) return refuse("part_gap", { part: m.part });
	if (m.part < claim.acked) {
		const done = sql.exec<{ body_sha256: string; proof: string; receipt_hash: string }>("SELECT body_sha256, proof, receipt_hash FROM refresh_parts WHERE claim_id = ? AND part = ?", m.claim_id, m.part).toArray()[0];
		if (!done) return refuse("part_proof_unavailable", { part: m.part });
		if (done.body_sha256 !== body || m.part_hash !== frame.part_hash) return refuse("body_mismatch", { part: m.part });
		return { replay: { status: "acknowledged" as const, proof: JSON.parse(done.proof) as Record<string, unknown>, receipt_hash: done.receipt_hash } };
	}
	const source = parts.sources.find((s) => s.source_id === frame.source_id)!;
	const wire = (frame.kind === "pr" ? p.prs : p.tickets) ?? [], repo = frame.kind === "pr" ? repoNamespace(p.repo?.remote ?? "") : null;
	if (p.as_of !== parts.as_of || (p.profile ?? b.profile) !== b.profile || (frame.kind === "pr" ? p.tickets : p.prs) || wire.length !== frame.item_count
		|| (frame.kind === "pr" && repo !== source.namespace) || m.part_hash !== frame.part_hash || partHash(b, m.part, frame.source_id, p) !== frame.part_hash) {
		return refuse("frame_mismatch", { part: m.part });
	}
	const items: (PRUploadArgs | TicketUploadArgs)[] = frame.kind === "pr" ? (wire as NonNullable<Payload["prs"]>).map((w) => prArgs(repo!, w, p.as_of))
		: (wire as NonNullable<Payload["tickets"]>).map((w) => ticketArgs(w, p.as_of));
	const requests = new Set<string>();
	for (const [index, item] of items.entries()) {
		const { requestId } = naturalRequest(sql, who, item);
		if (requests.has(requestId) || sql.exec("SELECT 1 FROM refresh_refs WHERE request_id = ? AND claim_id = ?", requestId, m.claim_id).toArray().length) {
			return refuse("duplicate_request", { part: m.part, index });
		}
		requests.add(requestId);
	}
	return { b, claim, parts, frame, items, wire };
}

/** Before any item write: the frame's items, the stored proof of an acknowledged part, or why the frame is refused. */
export const partCheck = (sql: SqlStorage, who: Who, deviceId: string | undefined, m: PartMeta, body: string, p: Payload) => pending(() => {
	const f = framed(sql, who, deviceId, m, body, p);
	return f.replay ? { replay: f.replay } : { items: f.items! };
});

/** Inside every refresh item's write transaction, and again after its registration awaits: the claim is open at this part. */
export function assertRefreshOpen(sql: SqlStorage, r: { claim_id: string; part: number; device_id: string }): void {
	const claim = claimRow(sql, r.claim_id);
	if (!claim || claim.state !== "pending" || claim.invalid || claim.acked !== r.part || (JSON.parse(claim.binding) as Binding).device_id !== r.device_id) {
		throw Fail.of("validation", "this daily claim no longer takes this part", { reason: "refresh_closed" });
	}
}

/**
 * Every ref's current eligibility, by primary-key seeks only: its request still present with the same payload hash, its receipt
 * not replaced, and for a stored ref its own activity (same id and time) present, its receipt registered and its source revision
 * neither legacy nor undone; for a stale ref a still-present, registered, non-undone, strictly newer revision. Reasons name the
 * first failing condition.
 */
const ELIGIBILITY = `SELECT r.part, r.idx, CASE
		WHEN q.payload_hash IS NOT r.payload_hash THEN 'receipt_missing'
		WHEN u.seq IS NOT r.request_seq THEN 'receipt_replaced'
		WHEN r.action = 'stored' AND a.at IS NOT u.at THEN 'activity_missing'
		WHEN r.action = 'stored' AND u.registered_at IS NULL THEN 'registration_unproven'
		WHEN r.action = 'stored' AND v.legacy IS NOT 0 THEN 'revision_unproven'
		WHEN r.action = 'stored' AND v.undone_by IS NOT NULL THEN 'undone'
		WHEN r.action = 'stale' AND (w.legacy IS NOT 0 OR r.authority <= r.revision) THEN 'authority_unproven'
		WHEN r.action = 'stale' AND w.undone_by IS NOT NULL THEN 'authority_undone'
		WHEN r.action = 'stale' AND (wq.payload_hash IS NULL OR wu.seq IS NOT w.seq OR wa.at IS NOT wu.at) THEN 'authority_missing'
		WHEN r.action = 'stale' AND wu.registered_at IS NULL THEN 'authority_unregistered'
		WHEN r.action NOT IN ('stored', 'stale') THEN 'action_unproven' END AS reason
	FROM refresh_refs r
	LEFT JOIN requests q ON q.request_id = r.request_id
	LEFT JOIN upload_receipts u ON u.request_id = r.request_id
	LEFT JOIN activity a ON a.id = u.activity_id
	LEFT JOIN upload_revisions v ON v.key = r.key AND v.revision = r.revision
	LEFT JOIN upload_revisions w ON w.key = r.key AND w.revision = r.authority
	LEFT JOIN requests wq ON wq.request_id = w.request_id
	LEFT JOIN upload_receipts wu ON wu.request_id = w.request_id
	LEFT JOIN activity wa ON wa.id = wu.activity_id
	WHERE r.claim_id = ?1 AND r.part BETWEEN ?2 AND ?3 ORDER BY r.part, r.idx`;

/** Walks the refs of frames[from..to] in order, refusing at the first gap or ineligible ref, or as soon as reads pass the budget. */
function eligible(sql: SqlStorage, claimId: string, frames: Parts["frames"], from: number, to: number, maxReads: number): { refs: number; reads: number; bytes: number } {
	const cursor = sql.exec<{ part: number; idx: number; reason: string | null }>(ELIGIBILITY, claimId, from, to);
	let part = from, idx = 0, refs = 0, bytes = 0;
	for (const r of cursor) {
		bytes += JSON.stringify(r).length;
		if (cursor.rowsRead > maxReads) refuse("read_budget", { part: r.part, index: r.idx, reads: cursor.rowsRead });
		if (r.part !== part || r.idx !== idx) refuse("refs_incomplete", { part, index: idx });
		if (r.reason) refuse(r.reason, { part: r.part, index: r.idx, reads: cursor.rowsRead });
		refs++;
		if (++idx === frames[part]!.item_count) { part++; idx = 0; }
	}
	if (part !== to + 1) refuse("refs_incomplete", { part, index: idx });
	return { refs, reads: cursor.rowsRead, bytes };
}

/**
 * After every item of the frame committed and registered and the account access rechecked: the synchronous part
 * acknowledgement. Rechecks the mirror and frame, reads each item's actual natural request, records its exact ref and proof and
 * acknowledges only when every ref is eligible now; anything else stays pending and writes nothing.
 */
export function ackPart(storage: DurableObjectStorage, who: Who, deviceId: string | undefined, m: PartMeta, body: string, p: Payload): PartReply {
	return pending(() => storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const f = framed(sql, who, deviceId, m, body, p);
		if (f.replay) return f.replay;
		const tx = meta(sql);
		const proofItems = f.items.map((a, index) => {
			const { requestId, payloadHash } = naturalRequest(sql, who, a);
			const row = sql.exec<{ payload_hash: string; result: string }>("SELECT payload_hash, result FROM requests WHERE request_id = ?", requestId).toArray()[0];
			const receipt = receiptSeq(sql, requestId);
			if (!row || row.payload_hash !== payloadHash || receipt === undefined) return refuse("receipt_missing", { part: m.part, index });
			const result = JSON.parse(row.result) as { action: string; current_updated_at?: string };
			const item = { index, kind: f.frame.kind, key: uploadKey(a), source_revision: a.updated_at, item_hash: hash(f.wire[index]), request_id: requestId, payload_hash: payloadHash,
				original_result_hash: sha256(row.result), original_action: result.action, disposition: result.action === "stale" ? "superseded" : "stored", unknown: a.unknown };
			tx.run(`INSERT INTO refresh_refs (claim_id, part, idx, key, revision, item_hash, request_id, payload_hash, result_hash, action, request_seq, authority, seq)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.claim_id, m.part, index, item.key, item.source_revision, item.item_hash, requestId, payloadHash,
			item.original_result_hash, result.action, receipt, result.current_updated_at ?? null, tx.seq);
			return item;
		});
		eligible(sql, m.claim_id, f.parts.frames, m.part, m.part, FRAME_ITEMS.pr * REF_READS);
		const proof = { version: 1, operation: "part", binding: f.b, manifest_hash: f.claim.manifest_hash, part: m.part, part_hash: m.part_hash, body_sha256: body, items: proofItems };
		const text = canonicalJson(proof), receiptHash = sha256(text);
		tx.run("INSERT INTO refresh_parts (claim_id, part, body_sha256, proof, receipt_hash, seq) VALUES (?, ?, ?, ?, ?, ?)", m.claim_id, m.part, body, text, receiptHash, tx.seq);
		tx.run("UPDATE refresh_claims SET acked = acked + 1, seq = ? WHERE claim_id = ?", tx.seq, m.claim_id);
		return { status: "acknowledged" as const, proof, receipt_hash: receiptHash };
	}));
}

/** One bounded cleanup transaction of a terminal claim: its refs first, then its part proofs and plan; true once nothing is left. */
function cleanupStep(storage: DurableObjectStorage, claimId: string): boolean {
	return storage.transactionSync(() => {
		const sql = storage.sql, claim = claimRow(sql, claimId);
		if (!claim || claim.state === "pending") return false;
		if (claim.cleaned) return true;
		const tx = meta(sql);
		if (tx.run("DELETE FROM refresh_refs WHERE (claim_id, part, idx) IN (SELECT claim_id, part, idx FROM refresh_refs WHERE claim_id = ? LIMIT ?)", claimId, REFS_PER_STEP).rowsWritten) return false;
		tx.run("DELETE FROM refresh_parts WHERE claim_id = ?", claimId);
		tx.run("UPDATE refresh_claims SET parts = NULL, cleaned = 1, seq = ? WHERE claim_id = ?", tx.seq, claimId);
		return true;
	});
}

/** One terminal cleanup page for housekeeping; the account fence and original terminal proof stay untouched. */
export function cleanupTerminal(storage: DurableObjectStorage, who: Who): boolean {
	const sql = storage.sql;
	assertOpen(sql);
	// shortcut: selection scans retained claim history; index it if measured history makes this costly.
	const claim = sql.exec<{ claim_id: string; binding: string }>("SELECT claim_id, binding FROM refresh_claims WHERE cleaned = 0 AND state IN ('done','failed','abandoned') LIMIT 1").toArray()[0];
	if (!claim) return false;
	const b = JSON.parse(claim.binding) as Binding;
	if (b.profile !== who.profile || b.generation !== who.generation) throw Fail.of("validation", "binding is not this profile generation", { reason: "binding_mismatch" });
	cleanupStep(storage, claim.claim_id);
	return true;
}

/**
 * The profile terminal, then its cleanup. `done` runs the final eligibility check in the terminal transaction itself; failed and
 * abandoned close unconditionally. A replay returns the terminal first committed and resumes any unfinished cleanup; the account
 * releases the day only on `cleaned`. `maxReads` exists for the read-budget control.
 */
export function terminal(storage: DurableObjectStorage, who: Who, b: Binding, t: Terminal, maxReads = FINISH_READS): TerminalReply {
	const closing = pending(() => storage.transactionSync(() => {
		const sql = storage.sql;
		assertOpen(sql);
		const claim = claimRow(sql, b.claim_id);
		if (!claim) return refuse("claim_unknown");
		if (claim.binding !== canonicalJson(b) || b.profile !== who.profile || b.generation !== who.generation) return refuse("binding_mismatch");
		if (claim.state !== "pending") {
			const saved = JSON.parse(claim.terminal!) as Terminal;
			if (saved.request_id === t.request_id && saved.body_sha256 !== t.body_sha256) throw Fail.of("idempotency_mismatch", "this daily request id was used with other bytes", { reason: "body_mismatch" });
			return { terminal: saved, manifest_hash: claim.manifest_hash };
		}
		let metrics = {};
		if (t.outcome === "done") {
			const parts = plan(claim);
			if (planHash(b, parts) !== claim.manifest_hash) refuse("manifest_mismatch");
			if (claim.acked !== parts.frames.length) refuse("parts_pending", { part: claim.acked });
			const check = parts.frames.length ? eligible(sql, b.claim_id, parts.frames, 0, parts.frames.length - 1, maxReads - 1) : { refs: 0, reads: 0, bytes: 0 };
			metrics = { refs: check.refs, reads: check.reads + 1, bytes: check.bytes + Buffer.byteLength(claim.parts!, "utf8") + claim.binding.length };
		}
		const seq = takeSeq(sql, "profile_meta"), update = sql.exec("UPDATE refresh_claims SET state = ?, terminal = ?, seq = ? WHERE claim_id = ?", t.outcome, canonicalJson(t), seq.seq, b.claim_id);
		return { terminal: t, manifest_hash: claim.manifest_hash, ...metrics, ...(t.outcome === "done" ? { rows_written: seq.rows + update.rowsWritten } : {}) };
	}));
	if ("status" in closing) return closing;
	let cleaned = false;
	// A cleanup step that fails leaves the terminal in place and the account pending; the next exact replay resumes here.
	try { for (let i = 0; i < CLEANUP_STEPS && !cleaned; i++) cleaned = cleanupStep(storage, b.claim_id); } catch (e) { if (!(e instanceof Error)) throw e; }
	return { status: "terminal", ...closing, cleaned };
}

/** The read-only progress status shows for the current generation's claim. */
export function progress(sql: SqlStorage, claimId: string) {
	const claim = claimRow(sql, claimId);
	if (!claim) return null;
	const parts = claim.parts ? (JSON.parse(claim.parts) as Parts).frames.length : null;
	return { state: claim.state, parts, acknowledged_parts: claim.acked, next_part: claim.state === "pending" ? claim.acked : null, descriptor_invalidated: !!claim.invalid, cleaned: !!claim.cleaned };
}
