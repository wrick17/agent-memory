// Daily refresh claims on the account (joint daily addendum v1, lifecycle addendum r2): one permanent row per profile and UTC day,
// and at most one open claim per profile. The account reserves; the bound profile mirrors, seals and closes; only then does the
// account confirm or release. A day row is never deleted, and release waits for the profile's cleanup.
import { canonicalJson, sha256 } from "../domain/ids";
import { Fail, fail, ok, type Outcome, type ProfileRef } from "../domain/types";
import type { Binding, Parts, ProfileStore, Terminal, TerminalReply } from "../profile/store";

/** What these functions need from AccountStore. */
export interface Ledger { sql: SqlStorage; env: Env; userId: string; write<T>(fn: (seq: number) => T): T }
/** A control request as the Worker read it: its ids and the SHA-256 of its exact body bytes. */
export interface Control { day: string; claim_id: string; request_id: string; body_sha256: string }
type Row = { profile: string; day: string; claim_id: string; device_id: string; generation: string; state: string; reason: string | null;
	claim_receipt: string; plan_receipt: string | null; finish_receipt: string | null };
type Receipt = { proof: Record<string, unknown>; receipt_hash: string };
export type ClaimReply = { claim: Binding & { state: string; reason: string | null }; refresh_receipt?: Receipt; refresh?: { status: "pending"; reason: string } };

const OPEN = "state IN ('claiming','pending')";
const utcDay = () => new Date().toISOString().slice(0, 10);
const binding = (r: Row): Binding => ({ profile: r.profile, generation: r.generation, device_id: r.device_id, day: r.day, claim_id: r.claim_id });
const dayRow = (sql: SqlStorage, profile: string, day: string) => sql.exec<Row>("SELECT * FROM refresh_days WHERE profile = ? AND day = ?", profile, day).toArray()[0];
/** The closed control proof, as canonical text: its SHA-256 is the receipt hash. */
const proof = (operation: string, b: Binding, c: { request_id: string; body_sha256: string }, manifest: string | null, outcome: string | null) =>
	canonicalJson({ version: 1, operation, binding: b, request_id: c.request_id, body_sha256: c.body_sha256, manifest_hash: manifest, outcome });
const receipt = (text: string | null): Receipt | undefined => (text ? { proof: JSON.parse(text) as Record<string, unknown>, receipt_hash: sha256(text) } : undefined);
const reply = (r: Row, text: string | null, more: Partial<ClaimReply> = {}): ClaimReply => ({ claim: { ...binding(r), state: r.state, reason: r.reason }, ...(text ? { refresh_receipt: receipt(text)! } : {}), ...more });
/** A replay must be the same request with the same bytes. */
function same(text: string, c: { request_id: string; body_sha256: string }): void {
	const p = JSON.parse(text) as { request_id: string; body_sha256: string };
	if (p.request_id !== c.request_id || p.body_sha256 !== c.body_sha256) throw Fail.of("idempotency_mismatch", "this daily request id was used with other bytes", { reason: "body_mismatch" });
}
const current = (sql: SqlStorage, profile: string) => sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", profile).toArray()[0];
const isCurrent = (sql: SqlStorage, b: Binding) => { const p = current(sql, b.profile); return p?.status === "active" && p.generation === b.generation; };
const wiped = (sql: SqlStorage, generation: string) => sql.exec<{ state: string }>("SELECT state FROM generations WHERE id = ?", generation).toArray()[0]?.state === "wiped";
const recovering = (sql: SqlStorage) => sql.exec("SELECT 1 FROM account_meta WHERE key = 'recovery_state'").toArray().length > 0;
const profileOf = (l: Ledger, b: Binding) => l.env.PROFILE.get(l.env.PROFILE.idFromName(`${l.userId}:${b.profile}:${b.generation}`)) as unknown as
	Pick<ProfileStore, "refreshMirror" | "refreshPlan" | "refreshTerminal" | "refreshProgress">;
const who = (l: Ledger, b: Binding) => ({ userId: l.userId, profile: b.profile, generation: b.generation });
const guard = async <T>(f: () => Promise<Outcome<T>>): Promise<Outcome<T>> => { try { return await f(); } catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; } };

/** Claims today's default refresh of an active profile for this device, or replays the same claim, even on a later day. */
export const claim = (l: Ledger, ref: ProfileRef, deviceId: string, c: Control) => guard(async () => {
	const row = l.write((seq) => {
		if (recovering(l.sql)) throw Fail.of("busy", "account is closed for recovery");
		const p = current(l.sql, ref.profile);
		if (p?.status !== "active" || p.generation !== ref.generation) throw Fail.of("profile_wiped", "this profile generation is closed");
		const held = dayRow(l.sql, ref.profile, c.day);
		if (held) {
			if (held.claim_id !== c.claim_id || held.device_id !== deviceId) throw Fail.of("already_exists", "this profile's daily refresh for that day is already claimed", { reason: "already_claimed" });
			same(held.claim_receipt, c);
			return held;
		}
		const today = utcDay();
		if (c.day !== today) throw Fail.of("validation", "a new daily claim names the server's UTC day", { reason: "day_mismatch", utc_day: today });
		if (l.sql.exec(`SELECT 1 FROM refresh_days WHERE profile = ? AND ${OPEN}`, ref.profile).toArray().length) throw Fail.of("busy", "an earlier daily refresh of this profile is still open", { reason: "prior_refresh_pending" });
		const b: Binding = { profile: ref.profile, generation: ref.generation, device_id: deviceId, day: c.day, claim_id: c.claim_id };
		l.sql.exec(`INSERT INTO refresh_days (profile, day, claim_id, device_id, generation, state, claim_receipt, created_at, seq) VALUES (?, ?, ?, ?, ?, 'claiming', ?, ?, ?)`,
			b.profile, b.day, b.claim_id, b.device_id, b.generation, proof("claim", b, c, null, null), new Date().toISOString(), seq);
		return dayRow(l.sql, ref.profile, c.day)!;
	});
	if (row.state !== "claiming") return ok(reply(row, row.claim_receipt));
	const b = binding(row), mirrored = await profileOf(l, b).refreshMirror(who(l, b), b);
	if (!mirrored.ok) {
		// A reservation whose generation was wiped before its mirror existed is a consumed, failed attempt; anything else retries.
		if (!wiped(l.sql, b.generation)) return mirrored;
		return ok(reply(l.write((seq) => { close(l.sql, b, "failed", "mirror_unavailable", null, seq); return dayRow(l.sql, b.profile, b.day)!; }), null));
	}
	const done = l.write((seq) => {
		l.sql.exec("UPDATE refresh_days SET state = 'pending', seq = ? WHERE profile = ? AND day = ? AND claim_id = ? AND state = 'claiming'", seq, b.profile, b.day, b.claim_id);
		return dayRow(l.sql, b.profile, b.day)!;
	});
	return ok(reply(done, done.claim_receipt));
});

/** The device's claim row for this request, or not_found; replies never show another device's claim. */
function owned(l: Ledger, profile: string, c: Control, deviceId: string): Row {
	const row = dayRow(l.sql, profile, c.day);
	if (!row || row.claim_id !== c.claim_id || row.device_id !== deviceId) throw Fail.of("not_found", "no such daily claim for this device");
	return row;
}

/** Seals the confirmed claim's one plan in the profile, then records the plan receipt. */
export const plan = (l: Ledger, ref: ProfileRef, deviceId: string, c: Control & { parts: Parts; manifest_hash: string }) => guard(async () => {
	const row = owned(l, ref.profile, c, deviceId);
	if (row.plan_receipt) {
		same(row.plan_receipt, c);
		if (row.state !== "pending") return ok(reply(row, row.plan_receipt));
	}
	if (row.state !== "pending") throw Fail.of("busy", "this daily claim does not take a plan now", { reason: row.state === "claiming" ? "claim_unconfirmed" : "claim_closed" });
	const b = binding(row);
	if (!isCurrent(l.sql, b)) throw Fail.of("profile_wiped", "this claim's profile generation is closed");
	const sealed = await profileOf(l, b).refreshPlan(who(l, b), b, c.parts, c.manifest_hash);
	if (!sealed.ok) return sealed;
	if (sealed.value.status !== "sealed") return ok(reply(row, null, { refresh: sealed.value }));
	const done = l.write((seq) => {
		if (recovering(l.sql)) throw Fail.of("busy", "account is closed for recovery");
		if (!isCurrent(l.sql, b)) throw Fail.of("profile_wiped", "this claim's profile generation is closed");
		if (owned(l, ref.profile, c, deviceId).state !== "pending") throw Fail.of("busy", "this daily claim is no longer open", { reason: "claim_closed" });
		l.sql.exec(`UPDATE refresh_days SET plan_receipt = ?, seq = ? WHERE profile = ? AND day = ? AND claim_id = ? AND plan_receipt IS NULL AND state = 'pending'`,
			proof("plan", b, c, c.manifest_hash, null), seq, b.profile, b.day, b.claim_id);
		return dayRow(l.sql, b.profile, b.day)!;
	});
	return ok(reply(done, done.plan_receipt));
});

/** Marks the exact open claim terminal and so releases its profile's one open slot; a later day's claim is never touched. */
function close(sql: SqlStorage, b: Binding, outcome: string, reason: string | null, finish: string | null, seq: number): void {
	const r = sql.exec(`UPDATE refresh_days SET state = ?, reason = ?, finish_receipt = ?, closed_at = ?, seq = ? WHERE profile = ? AND day = ? AND claim_id = ? AND generation = ? AND ${OPEN}`,
		outcome, reason, finish, new Date().toISOString(), seq, b.profile, b.day, b.claim_id, b.generation);
	if (!r.rowsWritten) throw Fail.of("busy", "this daily claim is no longer the open one", { reason: "claim_closed" });
}

/**
 * Finishes the device's own claim, or abandons any claim for the owner: the bound profile closes and cleans up first, and the
 * account records that profile terminal (the first one committed). A wiped generation can only be abandoned by the owner, once
 * the wipe has cleared it. Unproven DONE, a closed descriptor or unfinished cleanup stay pending.
 */
export const finish = (l: Ledger, profile: string, actor: { deviceId: string } | { owner: true; generation: string },
	c: Control & { outcome: Terminal["outcome"]; reason: string | null }) => guard(async (): Promise<Outcome<ClaimReply>> => {
	const row = "deviceId" in actor ? owned(l, profile, c, actor.deviceId) : dayRow(l.sql, profile, c.day);
	if (!row || row.claim_id !== c.claim_id || ("owner" in actor && row.generation !== actor.generation)) throw Fail.of("not_found", "no such daily claim");
	if (row.state !== "pending" && row.state !== "claiming") {
		if (row.finish_receipt && (JSON.parse(row.finish_receipt) as { request_id: string }).request_id === c.request_id) same(row.finish_receipt, c);
		return ok(reply(row, row.finish_receipt));
	}
	const b = binding(row);
	if (row.state === "claiming" && isCurrent(l.sql, b)) throw Fail.of("busy", "this daily claim is not confirmed yet", { reason: "claim_unconfirmed" });
	if (!isCurrent(l.sql, b)) {
		if (!("owner" in actor) || !wiped(l.sql, b.generation)) throw Fail.of("busy", "this claim's generation is not fenced yet", { reason: "generation_not_fenced" });
		const manifest = row.plan_receipt ? (JSON.parse(row.plan_receipt) as { manifest_hash: string }).manifest_hash : null;
		const text = proof("finish", b, c, manifest, "abandoned");
		return ok(reply(l.write((seq) => { close(l.sql, b, "abandoned", "generation_wiped", text, seq); return dayRow(l.sql, b.profile, b.day)!; }), text));
	}
	const r = await profileOf(l, b).refreshTerminal(who(l, b), b, { outcome: c.outcome, request_id: c.request_id, body_sha256: c.body_sha256, reason: c.reason });
	if (!r.ok) return r;
	const t: TerminalReply = r.value;
	if (t.status !== "terminal") return ok(reply(row, null, { refresh: t }));
	if (!t.cleaned) return ok(reply(row, null, { refresh: { status: "pending", reason: "cleanup_incomplete" } }));
	const text = proof("finish", b, t.terminal, t.manifest_hash, t.terminal.outcome);
	return ok(reply(l.write((seq) => { close(l.sql, b, t.terminal.outcome, t.terminal.reason, text, seq); return dayRow(l.sql, b.profile, b.day)!; }), text));
});

/** Read-only exact status of one claim for its bound device or the owner; another device or claim gets not_found, never closure. */
export const status = (l: Ledger, viewer: { deviceId: string } | { owner: true }, profile: string, day: string, claimId: string) => guard(async () => {
	const row = dayRow(l.sql, profile, day);
	if (!row || row.claim_id !== claimId || ("deviceId" in viewer && row.device_id !== viewer.deviceId)) return fail("not_found", "no such daily claim");
	const b = binding(row);
	let progress = null;
	if (isCurrent(l.sql, b)) {
		const p = await profileOf(l, b).refreshProgress(who(l, b), claimId);
		if (p.ok) progress = p.value;
	}
	return ok({ operation: "status" as const, utc_day: utcDay(), claim: { ...b, state: row.state, reason: row.reason }, progress });
});
