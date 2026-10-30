// AccountStore: one per user. Devices, routing rules, the profile registry, node_index, request_index (section 5).
import { DurableObject } from "cloudflare:workers";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { randomBase32, sha256 } from "../domain/ids";
import { Fail, fail, ok, PROFILE_NAME, PROFILES, SCOPES, type Caller, type Outcome, type ProfileRef, type RoutingRule, type Scope } from "../domain/types";
import { migrate, nextSeq } from "../storage";
import { ACCOUNT_MIGRATIONS } from "./schema";
import * as refresh from "./refresh";
import { accountTransfer, type AccountTransfer, type TransferCommand } from "./transfers";
import { resumeTransfer, transferPorts, type TransferInput } from "../transfer";
import { ROW_PAUSE } from "../profile/store";
import { wipePorts, wipeProfile } from "../wipe";

export { REBIND_MAX, type AccountTransfer, type TransferCommand } from "./transfers";

export type Principal = { kind: "owner"; userId: string; device?: string } | { kind: "device"; id: string; secret: string };

export interface TransferRequest { input: TransferInput; result?: Record<string, unknown> }

export interface AccountContext { caller: Caller; rules: RoutingRule[]; profiles: ProfileRef[]; known: string[]; sensitiveTerms: string[] }

export type AccountCommand =
	| { op: "listDevices" }
	| { op: "createDevice"; name: string; scopes: Scope[]; profiles: string[]; defaultProfile?: string; expiresAt?: string; oauth?: boolean }
	| { op: "revokeDevice"; id: string }
	| { op: "setDeviceDefault"; id: string; defaultProfile: string | null }
	| { op: "setRules"; rules: Omit<RoutingRule, "id">[] }
	| { op: "addSensitiveTerm"; term: string }
	/** With profile and generation (corpus chunks), terms land only while that generation is active and the account is not recovering. */
	| { op: "addSensitiveTerms"; terms: string[]; profile?: string; generation?: string }
	| { op: "listProfiles" }
	| { op: "wipeProfile"; profile: string; typed: string };

type DeviceRow = { id: string; name: string; token_hash: string | null; scopes: string; profiles: string; default_profile: string | null;
	enabled: number; expires_at: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null };

const DAILY_NEURONS = 8000;
const now = () => new Date().toISOString();

export class AccountStore extends DurableObject<Env> {
	private readonly sql: SqlStorage;
	private seeded?: Promise<void>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage, "account_meta", ACCOUNT_MIGRATIONS));
	}

	private meta(key: string): string | undefined {
		return this.sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = ?", key).toArray()[0]?.value;
	}

	private write<T>(fn: (seq: number) => T): T {
		return this.ctx.storage.transactionSync(() => fn(nextSeq(this.sql, "account_meta")));
	}

	private ensureSeeded(userId: string): Promise<void> {
		this.seeded ??= this.seed(userId).catch((e: unknown) => { this.seeded = undefined; throw e; });
		return this.seeded;
	}

	private async seed(userId: string): Promise<void> {
		const owner = this.meta("user_id");
		if (owner && owner !== userId) throw new Error("this account belongs to another user");
		if (!owner) this.write(() => this.sql.exec("INSERT INTO account_meta (key, value) VALUES ('user_id', ?)", userId));
		for (const profile of PROFILES) {
			if (this.sql.exec("SELECT 1 FROM profiles WHERE name = ?", profile).toArray().length) continue;
			const generation = await this.reserveGeneration(userId, profile, "live");
			await this.ledger(generation, profile, "live", "active");
			this.write((seq) => {
				this.sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, ?)",
					profile, `${userId}:${profile}:${generation}`, generation, now(), seq);
				this.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, ?)",
					generation, profile, now(), seq);
			});
		}
		if (this.meta("rules_seeded") !== "1") {
			const rules = parseRoutingDefaults(this.env.ROUTING_DEFAULTS ?? "");
			this.write((seq) => {
				rules.forEach((r, i) => this.sql.exec("INSERT INTO routing_rules (id, priority, match, pattern, profile, enabled, seq) VALUES (?, ?, ?, ?, ?, 1, ?)",
					`r${i + 1}`, r.priority, r.match, r.pattern, r.profile, seq));
				this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('rules_seeded', '1')");
			});
		}
	}

	/**
	 * Draws a random generation id and reserves it in the R2 ledger before anything uses it (section 11).
	 * The ledger is outside every export and restore, so an id once reserved is never handed out again.
	 */
	async reserveGeneration(userId: string, profile: string, purpose: "live" | "restore" | "scratch", draw: () => string = randomBase32): Promise<string> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const id = draw();
			if (Buffer.byteLength(`${userId}:${profile}:g${id}`) > 64) throw new Error("the Vectorize namespace would exceed 64 bytes; refusing to truncate it");
			const key = `generations/${id}.json`;
			if (await this.env.BACKUPS.head(key)) continue;
			await this.env.BACKUPS.put(key, JSON.stringify({ id, profile, purpose, state: "reserved", at: now() }), { httpMetadata: { contentType: "application/json" } });
			return id;
		}
		throw new Error("could not reserve a fresh generation id");
	}

	private async ledger(id: string, profile: string, purpose: string, state: string): Promise<void> {
		await this.env.BACKUPS.put(`generations/${id}.json`, JSON.stringify({ id, profile, purpose, state, at: now() }), { httpMetadata: { contentType: "application/json" } });
	}

	/** Principal to Caller, plus everything the Worker needs to route and guard. Checks every device token on every call. */
	async context(p: Principal): Promise<Outcome<AccountContext>> {
		const userId = p.kind === "owner" ? p.userId : this.meta("user_id");
		if (!userId) return fail("unauthorized", "unknown device token");
		try {
			await this.ensureSeeded(userId);
		} catch (e) {
			return fail("unavailable", `account setup failed: ${(e as Error).message}`);
		}
		const caller = p.kind === "owner" ? this.ownerCaller(userId, p.device) : this.deviceCaller(userId, p);
		if (!caller.ok) return caller;
		const rules = this.sql.exec<{ id: string; priority: number; match: "remote" | "path"; pattern: string; profile: string; enabled: number }>(
			"SELECT id, priority, match, pattern, profile, enabled FROM routing_rules ORDER BY priority").toArray()
			.map((r) => ({ ...r, enabled: r.enabled === 1 }));
		const profiles = this.sql.exec<{ name: string; generation: string }>("SELECT name, generation FROM profiles WHERE status = 'active' ORDER BY name").toArray()
			.map((r) => ({ userId, profile: r.name, generation: r.generation }));
		const terms = this.sql.exec<{ term: string }>("SELECT term FROM sensitive_terms").toArray().map((r) => r.term);
		return ok({ caller: caller.value, rules, profiles, known: profiles.map((x) => x.profile), sensitiveTerms: [...new Set([...orgTerms(rules), ...terms])] });
	}

	private ownerCaller(userId: string, device?: string): Outcome<Caller> {
		const row = device ? this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE name = ? AND token_hash IS NULL AND revoked_at IS NULL", device).toArray()[0] : undefined;
		return ok({ userId, kind: "owner", scopes: ["read", "write"], profiles: "*", ...(device ? { deviceName: device } : {}),
			...(row ? { deviceId: row.id } : {}), ...(row?.default_profile ? { defaultProfile: row.default_profile } : {}) });
	}

	private deviceCaller(userId: string, p: { id: string; secret: string }): Outcome<Caller> {
		const row = this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", p.id).toArray()[0];
		const given = Buffer.from(sha256(p.secret), "hex");
		const stored = Buffer.from(row?.token_hash ?? "0".repeat(64), "hex");
		if (!row || !row.token_hash || !timingSafeEqual(given, stored)) return fail("unauthorized", "unknown device token");
		if (row.revoked_at || row.enabled !== 1) return fail("unauthorized", "this device token is revoked or disabled");
		if (row.expires_at !== null) {
			const expires = Date.parse(row.expires_at);
			if (Number.isNaN(expires) || expires <= Date.now()) return fail("unauthorized", "this device token has expired or has an unreadable expiry");
		}
		if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 3_600_000) {
			this.write((seq) => this.sql.exec("UPDATE devices SET last_used_at = ?, seq = ? WHERE id = ?", now(), seq, row.id));
		}
		return ok({ userId, kind: "device", deviceId: row.id, deviceName: row.name, scopes: JSON.parse(row.scopes) as Scope[],
			profiles: JSON.parse(row.profiles) as string[], ...(row.default_profile ? { defaultProfile: row.default_profile } : {}) });
	}

	private get days(): refresh.Ledger {
		return { sql: this.sql, env: this.env, userId: this.meta("user_id")!, write: (fn) => this.write(fn) };
	}
	/** Daily refresh claims (account/refresh.ts), for the Worker's authenticated device or owner routes. */
	async refreshClaim(ref: ProfileRef, deviceId: string, c: refresh.Control) { return refresh.claim(this.days, ref, deviceId, c); }
	async refreshPlan(ref: ProfileRef, deviceId: string, c: Parameters<typeof refresh.plan>[3]) { return refresh.plan(this.days, ref, deviceId, c); }
	async refreshFinish(profile: string, actor: Parameters<typeof refresh.finish>[2], c: Parameters<typeof refresh.finish>[3]) { return refresh.finish(this.days, profile, actor, c); }
	async refreshStatus(viewer: Parameters<typeof refresh.status>[1], profile: string, day: string, claimId: string) { return refresh.status(this.days, viewer, profile, day, claimId); }

	/** Internal RPC: stale contexts and retired generations cannot enter a profile, even for replay. */
	async profileAccess(ref: ProfileRef, ids: string[] = []): Promise<Outcome<null>> {
		if (this.meta("user_id") !== ref.userId) return fail("forbidden", "account identity mismatch");
		if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
		if (this.sql.exec("SELECT 1 FROM account_meta WHERE key IN (SELECT 'wiped:' || value FROM json_each(?)) LIMIT 1", JSON.stringify(ids)).toArray().length) return fail("profile_wiped", "this record was purged by a profile wipe");
		const p = this.sql.exec<{ status: string; generation: string }>("SELECT status, generation FROM profiles WHERE name = ?", ref.profile).toArray()[0];
		return p?.status === "active" && p.generation === ref.generation ? ok(null) : fail("profile_wiped", "this profile generation is closed");
	}

	private activeProfile(profile: string): boolean {
		return this.sql.exec("SELECT 1 FROM profiles WHERE name = ? AND status = 'active'", profile).toArray().length > 0;
	}

	/**
	 * Binds a request_id to the profile and payload hash of its first use, or returns the existing binding.
	 * With `profile: null` it only looks up. A changed payload is refused before any write.
	 */
	async bindRequest(r: { requestId: string; profile: string | null; op: string; payloadHash: string; legacyHash?: string; generation?: string; transfer?: Omit<TransferInput, "id"> }): Promise<Outcome<{ profile: string | null; existing: boolean; transfer?: TransferRequest }>> {
		if (r.generation && (this.meta("recovery_state") || !this.sql.exec("SELECT 1 FROM profiles WHERE name = ? AND generation = ? AND status = 'active'", r.profile, r.generation).toArray().length)) return fail("busy", "upload generation is closed or recovering");
		const row = this.sql.exec<{ profile: string; op: string; payload_hash: string; legacy: number; pending: number }>("SELECT profile, op, payload_hash, legacy, pending FROM request_index WHERE request_id = ?", r.requestId).toArray()[0];
		if (row) {
			if (!this.activeProfile(row.profile)) return fail("profile_wiped", "the bound profile is closed");
			if (row.op === "wiped") return fail("profile_wiped", `request_id '${r.requestId}' belonged to a record a profile wipe purged`, { request_id: r.requestId });
			if (row.pending) return fail("busy", `request_id '${r.requestId}' belongs to a record that is still being imported; retry later`);
			// A binding imported from BothQ is checked with BothQ's hash of the call, before the modern hash could refuse it.
			const same = row.legacy ? row.payload_hash === r.legacyHash : row.payload_hash === r.payloadHash && row.op === r.op;
			if (!same) {
				return fail("idempotency_mismatch", `request_id '${r.requestId}' was already used with different arguments`, { request_id: r.requestId });
			}
			const raw = this.meta(`transfer_request:${r.requestId}`);
			const transfer = raw ? JSON.parse(raw) as TransferRequest : undefined;
			if (transfer && this.meta(`wiped:${transfer.input.nodeId}`)) return fail("profile_wiped", "this transfer record was purged by a profile wipe");
			return ok({ profile: row.profile, existing: true, ...(transfer ? { transfer } : {}) });
		}
		if (!r.profile) return ok({ profile: null, existing: false });
		if (!this.activeProfile(r.profile)) return fail("profile_wiped", "the target profile is closed");
		const transfer: TransferRequest | undefined = r.transfer ? { input: { ...r.transfer, id: crypto.randomUUID() } } : undefined;
		this.write((seq) => {
			this.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES (?, ?, ?, ?, ?, ?)", r.requestId, r.profile, r.op, r.payloadHash, now(), seq);
			if (transfer) this.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, ?)", `transfer_request:${r.requestId}`, JSON.stringify(transfer));
		});
		return ok({ profile: r.profile, existing: false, ...(transfer ? { transfer } : {}) });
	}

	/** Persist the public transfer result once; retries keep the original result bytes and transfer identity. */
	async finishTransferRequest(requestId: string, payloadHash: string, result: Record<string, unknown>): Promise<Outcome<Record<string, unknown>>> {
		const bound = await this.bindRequest({ requestId, profile: null, op: "save_memory", payloadHash });
		if (!bound.ok) return bound;
		if (!bound.value.transfer) return fail("idempotency_mismatch", "request does not own a transfer");
		const transfer = bound.value.transfer;
		if (!transfer.result) this.write(() => this.sql.exec("UPDATE account_meta SET value = ? WHERE key = ?", JSON.stringify({ ...transfer, result }), `transfer_request:${requestId}`));
		return ok(transfer.result ?? result);
	}

	/** Drops a binding this request created when the profile refused the write, so a corrected retry is not refused (BothQ rolls its request node back). */
	async releaseRequest(requestId: string, payloadHash: string): Promise<void> {
		this.write(() => this.sql.exec("DELETE FROM request_index WHERE request_id = ? AND payload_hash = ? AND op <> 'wiped'", requestId, payloadHash));
	}

	/** Imported request ids already held: missing ones, and a refusal if any is bound to another call or profile. */
	private importBindings(profile: string, requests: { request_id: string; op: string; hash: string }[]): Outcome<{ missing: typeof requests; pending: string[] }> {
		const missing: typeof requests = [], pending: string[] = [];
		for (const q of requests) {
			const row = this.sql.exec<{ profile: string; op: string; payload_hash: string; legacy: number; pending: number }>("SELECT profile, op, payload_hash, legacy, pending FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
			if (!row) missing.push(q);
			else if (!(row.legacy === 1 && row.profile === profile && row.op === q.op && row.payload_hash === q.hash)) {
				return fail("idempotency_mismatch", `request_id '${q.request_id}' is already bound to another call or profile`, { reason: "request_conflict", request_id: q.request_id });
			} else if (row.pending) pending.push(q.request_id);
		}
		return ok({ missing, pending });
	}

	/**
	 * Reserves a staged part's imported request ids account-wide before the part is staged (at most 400 per call, one
	 * transaction). From then on an ordinary call with one of them gets busy in every profile. An identical reservation or
	 * binding is kept, so a retry after a crash repairs; any other existing binding refuses the call, which writes nothing.
	 */
	async reserveImport(b: { profile: string; requests: { request_id: string; op: string; hash: string }[] }): Promise<Outcome<{ reserved: number }>> {
		if (!this.activeProfile(b.profile)) return fail("profile_wiped", "the import profile is closed");
		if (b.requests.length > 400) return fail("validation", "reserve at most 400 imported requests per call");
		const held = this.importBindings(b.profile, b.requests);
		if (!held.ok) return held;
		if (held.value.missing.length) {
			this.write((seq) => { for (const q of held.value.missing) this.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy, pending) VALUES (?, ?, ?, ?, ?, ?, 1, 1)", q.request_id, b.profile, q.op, q.hash, now(), seq); });
		}
		return ok({ reserved: held.value.missing.length });
	}

	/**
	 * Binds an imported record's node id and request ids to its profile before the record is published (at most 400
	 * requests per call, one transaction each), turning their reservations into bindings. An identical binding is kept;
	 * any other existing binding refuses the whole call, which then writes nothing.
	 */
	async bindImport(b: { profile: string; recordId: string; requests: { request_id: string; op: string; hash: string }[] }): Promise<Outcome<{ bound: number }>> {
		if (!this.activeProfile(b.profile)) return fail("profile_wiped", "the import profile is closed");
		if (b.requests.length > 400) return fail("validation", "bind at most 400 imported requests per call");
		if (this.meta(`wiped:${b.recordId}`)) return fail("profile_wiped", "this record was purged by a profile wipe");
		const node = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", b.recordId).toArray()[0];
		if (node && node.profile !== b.profile) return fail("validation", `node '${b.recordId}' already belongs to profile '${node.profile}'`, { reason: "node_conflict" });
		const held = this.importBindings(b.profile, b.requests);
		if (!held.ok) return held;
		this.write((seq) => {
			if (!node) this.sql.exec("INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", b.recordId, b.profile, seq);
			for (const q of held.value.missing) this.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy) VALUES (?, ?, ?, ?, ?, ?, 1)", q.request_id, b.profile, q.op, q.hash, now(), seq);
			for (const id of held.value.pending) this.sql.exec("UPDATE request_index SET pending = 0, seq = ? WHERE request_id = ?", seq, id);
		});
		return ok({ bound: held.value.missing.length + held.value.pending.length });
	}

	async recordNodes(profile: string, ids: string[], generation?: string): Promise<void> {
		if (generation && (this.meta("recovery_state") || !this.sql.exec("SELECT 1 FROM profiles WHERE name = ? AND generation = ? AND status = 'active'", profile, generation).toArray().length)) throw Fail.of("busy", "upload generation is closed or recovering");
		if (!ids.length) return;
		if (!this.activeProfile(profile) || ids.some((id) => this.meta(`wiped:${id}`))) throw Fail.of("profile_wiped", "profile or record was wiped");
		// A generation-scoped registration (an upload or its repair) never takes a node back from the profile a move gave it to.
		this.write((seq) => { for (const id of ids) this.sql.exec(`INSERT OR ${generation ? "IGNORE" : "REPLACE"} INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)`, id, profile, seq); });
	}

	/** Forgets the index rows of nodes a profile purged for good (the 300-day archive purge). */
	async dropNodes(profile: string, ids: string[]): Promise<void> {
		if (ids.length) this.write(() => this.sql.exec("DELETE FROM node_index WHERE profile = ? AND node_id IN (SELECT value FROM json_each(?))", profile, JSON.stringify(ids)));
	}

	/**
	 * Idempotent acknowledgement of a profile's durable purge outbox. Only the active, current generation of an account not in
	 * recovery prunes, and never a wipe fence: `wiped` request bindings and the `wiped:` and `transfer_request:` keys stay permanent.
	 * A refusal writes nothing, so the profile keeps its outbox and retries.
	 */
	async prunePurged(who: ProfileRef, ids: { nodes: string[]; requests: string[] }): Promise<Outcome<null>> {
		if (ids.nodes.length + ids.requests.length > 200) throw new Error("purge cleanup exceeds one batch");
		const access = await this.profileAccess(who);
		if (!access.ok) return access;
		this.write(() => {
			if (ids.nodes.length) this.sql.exec("DELETE FROM node_index WHERE profile = ? AND node_id IN (SELECT value FROM json_each(?))", who.profile, JSON.stringify(ids.nodes));
			if (ids.requests.length) this.sql.exec("DELETE FROM request_index WHERE profile = ? AND op <> 'wiped' AND request_id IN (SELECT value FROM json_each(?))", who.profile, JSON.stringify(ids.requests));
		});
		return ok(null);
	}

	async resolveNode(id: string): Promise<string | null> {
		return this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", id).toArray()[0]?.profile ?? null;
	}

	/**
	 * Daily UTC counters (section 6): embedding pauses past 8,000 neurons, the free daily allotment, and the profiles'
	 * background stages once the day's rows written reach ROW_PAUSE. A missing or zero amount only reads its counter.
	 */
	async meter(m: { day: string; neurons?: number; rowsWritten?: number }): Promise<{ embed: boolean; background: boolean }> {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(m.day) || !Number.isFinite(Date.parse(`${m.day}T00:00:00Z`)) || new Date(`${m.day}T00:00:00Z`).toISOString().slice(0, 10) !== m.day
			|| [m.neurons, m.rowsWritten].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER))) throw Fail.of("validation", "meter needs a UTC day and nonnegative finite counters");
		const count = (name: string, add?: number) => add ? this.write(() => this.sql.exec<{ value: number }>(
			`INSERT INTO counters (day, name, value) VALUES (?, ?, ?)
			 ON CONFLICT (day, name) DO UPDATE SET value = value + excluded.value RETURNING value`, m.day, name, Math.ceil(add)).one().value)
			: this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE day = ? AND name = ?", m.day, name).toArray()[0]?.value ?? 0;
		return { embed: count("neurons", m.neurons) < DAILY_NEURONS, background: count("rows", m.rowsWritten) < ROW_PAUSE };
	}

	/**
	 * For a profile's dangling-link check (section 12): per id, whether it is in no profile's node_index and has no permanent
	 * `wiped:` tombstone. Booleans only, in the order asked, after the caller's generation check, so a recovering account is
	 * `busy` and never reports a record it is still restoring as absent.
	 */
	async nodeStates(who: ProfileRef, ids: string[]): Promise<Outcome<boolean[]>> {
		if (ids.length > 200) return fail("validation", "ask about at most 200 ids at once");
		const access = await this.profileAccess(who);
		if (!access.ok) return access;
		const absent = new Set(this.sql.exec<{ id: string }>(`SELECT j.value AS id FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM node_index WHERE node_id = j.value)
			AND NOT EXISTS (SELECT 1 FROM account_meta WHERE key = 'wiped:' || j.value)
			AND NOT EXISTS (SELECT 1 FROM transfers WHERE node_id = j.value AND state IN ('open', 'committing'))`, JSON.stringify(ids)).toArray().map((r) => r.id));
		return ok(ids.map((id) => absent.has(id)));
	}

	/** Owner-only administration, reached only through the dashboard API. */
	/**
	 * Copies terms into the me profile's guard table, which the me write transaction reads. A registration is confirmed only
	 * after this commits, so a work write dispatched after it can never be followed by a me write that misses its terms.
	 */
	private async guardMe(terms: string[], source: string): Promise<Outcome<unknown>> {
		const userId = this.meta("user_id");
		const me = this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = 'me' AND status = 'active'").toArray()[0];
		if (!userId || !me) return fail("unavailable", "the me profile is not active");
		const ref = { userId, profile: "me", generation: me.generation };
		const stub = this.env.PROFILE.get(this.env.PROFILE.idFromName(`${userId}:me:${me.generation}`)) as unknown as { addGuardTerms(who: typeof ref, terms: string[], source: string): Promise<Outcome<number>> };
		try {
			return await stub.addGuardTerms(ref, terms, source);
		} catch (e) {
			return fail("unavailable", `the me guard could not be updated: ${(e as Error).message}`);
		}
	}

	/** The account's part of a transfer between profiles (section 9). */
	async transfer(cmd: TransferCommand): Promise<Outcome<AccountTransfer>> {
		if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
		// Arm before begin can commit: a process loss at its return still has a durable wakeup.
		if (cmd.op === "begin" && cmd.policy) {
			const at = await this.ctx.storage.getAlarm();
			if (at === null || at > Date.now() + 300_000) await this.ctx.storage.setAlarm(Date.now() + 300_000);
		}
		if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
		return accountTransfer(this.ctx.storage, cmd);
	}

	/** Re-drive at most ten accepted intents, including ones with no source transfer row yet. */
	async alarm(): Promise<void> {
		const ports = { ...transferPorts(this.env, this.meta("user_id")!), account: (cmd: TransferCommand) => this.transfer(cmd) };
		try {
			if (this.meta("recovery_state")) return;
			const ctx = await this.context({ kind: "owner", userId: this.meta("user_id")! });
			if (!ctx.ok) return;
			const due = this.sql.exec<{ id: string }>("SELECT id FROM transfers WHERE retry_at <= ? ORDER BY retry_at, id LIMIT 10", Date.now()).toArray();
			for (const { id } of due) {
				// Persist the retry before transport; an interrupted cleanup retains the same accepted intent.
				this.write((seq) => this.sql.exec("UPDATE transfers SET retry_at = ?, seq = ? WHERE id = ? AND retry_at IS NOT NULL", Date.now() + 60_000, seq, id));
				await resumeTransfer(ports, id, ctx.value.sensitiveTerms).catch(() => null);
			}
		} finally {
			const at = this.sql.exec<{ at: number | null }>("SELECT min(retry_at) at FROM transfers").one().at;
			if (at !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, at));
		}
	}

	async admin(cmd: AccountCommand): Promise<Outcome<unknown>> {
		const known = this.sql.exec<{ name: string }>("SELECT name FROM profiles").toArray().map((r) => r.name);
		switch (cmd.op) {
			case "wipeProfile": {
				const userId = this.meta("user_id");
				if (!userId) return fail("unavailable", "the account is not set up");
				return wipeProfile(this.env, wipePorts(this.env, this.ctx.storage), { userId, kind: "owner", scopes: ["read", "write"], profiles: "*" }, cmd.profile, cmd.typed);
			}
			case "listProfiles":
				return ok(this.sql.exec("SELECT name, generation, status, created_at FROM profiles ORDER BY name").toArray());
			case "listDevices":
				return ok(this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY created_at").toArray().map(({ token_hash, ...d }) => ({
					...d, kind: token_hash ? "token" : "oauth", scopes: JSON.parse(d.scopes), profiles: JSON.parse(d.profiles), enabled: d.enabled === 1,
				})));
			case "createDevice": {
				const name = cmd.name.trim();
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return fail("validation", "device name must be 1 to 64 letters, digits, dots, underscores or hyphens");
				if (this.sql.exec("SELECT 1 FROM devices WHERE name = ?", name).toArray().length) return fail("already_exists", `a device named '${name}' exists`);
				const scopes = [...new Set(cmd.scopes)];
				if (!cmd.oauth && (!scopes.length || scopes.some((s) => !SCOPES.includes(s)))) return fail("validation", `scopes must be a non-empty subset of ${SCOPES.join(", ")}`);
				const job = scopes.some((s) => s === "ingest" || s === "maintenance");
				if (job && scopes.some((s) => s !== "ingest" && s !== "maintenance")) return fail("validation", "a job token holds only ingest and maintenance");
				const profiles = cmd.oauth ? known : [...new Set(cmd.profiles)];
				if (!profiles.length || profiles.some((p) => !known.includes(p))) return fail("validation", `profiles must be a non-empty subset of ${known.join(", ")}`);
				if (cmd.defaultProfile && (!profiles.includes(cmd.defaultProfile) || cmd.defaultProfile === "me")) return fail("validation", "the default profile must be one of the device's profiles, and never me");
				if (cmd.expiresAt && Number.isNaN(Date.parse(cmd.expiresAt))) return fail("validation", "expiresAt must be an ISO date");
				const id = randomBase32(80);
				const secret = randomBytes(32).toString("hex");
				const tag = job ? "job" : scopes.includes("import") ? "imp" : "dev";
				this.write((seq) => this.sql.exec(
					"INSERT INTO devices (id, name, token_hash, scopes, profiles, default_profile, enabled, expires_at, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
					id, name, cmd.oauth ? null : sha256(secret), JSON.stringify(cmd.oauth ? [] : scopes), JSON.stringify(profiles), cmd.defaultProfile ?? null,
					cmd.expiresAt ? new Date(Date.parse(cmd.expiresAt)).toISOString() : null, now(), seq));
				return ok(cmd.oauth ? { id, name } : { id, name, token: `am_${tag}_${id}_${secret}` });
			}
			case "revokeDevice": {
				const changed = this.write((seq) => this.sql.exec("UPDATE devices SET revoked_at = ?, enabled = 0, seq = ? WHERE id = ? AND revoked_at IS NULL", now(), seq, cmd.id).rowsWritten);
				return changed ? ok({ id: cmd.id, revoked: true }) : fail("not_found", "no active device with that id");
			}
			case "setDeviceDefault": {
				const row = this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", cmd.id).toArray()[0];
				if (!row) return fail("not_found", "no device with that id");
				const allowed = JSON.parse(row.profiles) as string[];
				if (cmd.defaultProfile && (!allowed.includes(cmd.defaultProfile) || cmd.defaultProfile === "me")) return fail("validation", "the default profile must be one of the device's profiles, and never me");
				this.write((seq) => this.sql.exec("UPDATE devices SET default_profile = ?, seq = ? WHERE id = ?", cmd.defaultProfile, seq, cmd.id));
				return ok({ id: cmd.id, default_profile: cmd.defaultProfile });
			}
			case "setRules": {
				for (const r of cmd.rules) {
					if (!known.includes(r.profile) || r.profile === "me") return fail("validation", `rule profile must be a known profile other than me: ${r.profile}`);
					if (r.match !== "remote" && r.match !== "path") return fail("validation", "rule match must be remote or path");
				}
				this.write((seq) => {
					this.sql.exec("DELETE FROM routing_rules");
					cmd.rules.forEach((r, i) => this.sql.exec("INSERT INTO routing_rules (id, priority, match, pattern, profile, enabled, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
						`r${i + 1}`, r.priority, r.match, r.pattern, r.profile, r.enabled ? 1 : 0, seq));
				});
				const org = orgTerms(cmd.rules.map((r, i) => ({ ...r, id: `r${i + 1}` })));
				const guarded = org.length ? await this.guardMe(org, "rules") : ok(null);
				return guarded.ok ? ok({ rules: cmd.rules.length }) : guarded;
			}
			case "addSensitiveTerm": {
				const term = cmd.term.trim();
				if (term.length < 2 || term.length > 200) return fail("validation", "a sensitive term is 2 to 200 characters");
				this.write((seq) => this.sql.exec("INSERT OR REPLACE INTO sensitive_terms (term, source, updated_at, seq) VALUES (?, 'owner', ?, ?)", term, now(), seq));
				const guarded = await this.guardMe([term], "owner");
				return guarded.ok ? ok({ term }) : guarded;
			}
			case "addSensitiveTerms": {
				// Terms from work record_knowledge writes, in one transaction; existing terms are left as they are.
				const terms = [...new Set(cmd.terms.map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 200))];
				if (!terms.length) return ok({ terms: 0 });
				// The upload generation check of bindRequest and recordNodes, with no await before the write, so a wipe or recovery that
				// began after the caller's context was read stops the registration.
				if (cmd.generation && (this.meta("recovery_state") || !this.sql.exec("SELECT 1 FROM profiles WHERE name = ? AND generation = ? AND status = 'active'", cmd.profile ?? null, cmd.generation).toArray().length)) return fail("busy", "upload generation is closed or recovering");
				this.write((seq) => { for (const t of terms) this.sql.exec("INSERT OR IGNORE INTO sensitive_terms (term, source, updated_at, seq) VALUES (?, 'work', ?, ?)", t, now(), seq); });
				const guarded = await this.guardMe(terms, "work");
				return guarded.ok ? ok({ terms: terms.length }) : guarded;
			}
		}
	}
}

/** `pattern=profile` pairs, comma separated; `path:` marks a path-prefix rule. Priority follows the order. */
export function parseRoutingDefaults(spec: string): Omit<RoutingRule, "id">[] {
	return spec.split(",").map((s) => s.trim()).filter(Boolean).map((pair, i) => {
		const at = pair.lastIndexOf("=");
		const pattern = pair.slice(0, at).trim(), profile = pair.slice(at + 1).trim();
		if (at < 1 || !PROFILE_NAME.test(profile) || profile === "me") throw new Error(`bad routing default '${pair}'`);
		return pattern.startsWith("path:")
			? { priority: (i + 1) * 10, match: "path" as const, pattern: pattern.slice(5), profile, enabled: true }
			: { priority: (i + 1) * 10, match: "remote" as const, pattern, profile, enabled: true };
	});
}

/** Org names from the remote rules that point at `work` (for example `your-org`), as `me` guard terms. */
function orgTerms(rules: RoutingRule[]): string[] {
	return rules.filter((r) => r.profile === "work" && r.match === "remote")
		.map((r) => r.pattern.split("/")[1] ?? "").filter((org) => org && !org.includes("*"));
}
