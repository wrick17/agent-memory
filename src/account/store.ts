// AccountStore: one per user. Devices, routing rules, the profile registry, node_index, request_index (section 5).
import { DurableObject } from "cloudflare:workers";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, randomBase32, sha256 } from "../domain/ids";
import { Fail, fail, ok, PROFILE_NAME, PROFILES, SCOPES, type Caller, type Outcome, type ProfileRef, type RoutingRule, type Scope } from "../domain/types";
import { migrate, nextSeq } from "../storage";
import { ACCOUNT_MIGRATIONS } from "./schema";
import * as refresh from "./refresh";
import { accountTransfer, type AccountTransfer, type TransferCommand } from "./transfers";
import { resumeTransfer, transferPorts, type TransferInput } from "../transfer";
import { mayUse, refreshSelectors, type RefreshSelector } from "../routing";
import { BudgetTx, ROW_PAUSE, type ProfileStore, type RestoredPage } from "../profile/store";
import { PROFILE_MIGRATIONS } from "../profile/schema";
import { applyRows, dropExportId, dropExports, exportStore, exportTables, hasExports, listExports, readChunk, readManifest, type Manifest } from "../backup";
import { wipePorts, wipeProfile } from "../wipe";

export { REBIND_MAX, type AccountTransfer, type TransferCommand } from "./transfers";

export type Principal = { kind: "owner"; userId: string; device?: string } | { kind: "device"; id: string; secret: string };

export interface TransferRequest { input: TransferInput; result?: Record<string, unknown> }

export interface AccountContext { caller: Caller; rules: RoutingRule[]; profiles: ProfileRef[]; known: string[]; sensitiveTerms: string[] }

export interface RefreshScope {
	version: 1; origin: string; profile: string; generation: string; device_id: string;
	utc_day: string; issued_at: string; policy_version: string; github: RefreshSelector[]; jira: "assigned-open" | null;
}

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
	| { op: "wipeProfile"; profile: string; typed: string }
	// Backups and restore from an export (section 18): owner only, one recovery at a time.
	| { op: "export"; profile?: string }
	| { op: "listExports"; profile?: string }
	| { op: "beginRestore"; profile: string; export: string }
	| { op: "beginAccountRestore"; export: string }
	| { op: "restoreStatus" }
	| { op: "restoreStep"; id?: string }
	| { op: "openRestore"; id?: string }
	| { op: "abortRestore"; id?: string };

/**
 * The open recovery, kept in `recovery_state` while the account is closed. `unresolved` keeps the account closed until the
 * owner aborts; open rebuilds node_index and request_index from the restored generation, then switches the profile to it.
 */
export interface Recovery {
	id: string; profile: string; export: string; from: string; to?: string; at: string; export_at: string; export_seq: number;
	state: "restoring" | "checking" | "ready" | "unresolved" | "opening";
	after?: { node: string; request: string }; mark?: number; phase?: "index" | "sweep" | "switch";
	restored?: { nodes: number; requests: number }; unresolved: { kind: string; id: string }[]; unresolved_count: number;
}

/**
 * An account restore in place (section 18), kept in `recovery_state`, which the restore never overwrites. `checkpoint` is the
 * encrypted export of the account taken before its first change: an abort applies it back the same bounded way (`rolling_back`).
 * After the snapshot, the R2 generation ledger, the R2 wipe tombstones and the active profiles' own rows rebuild what it is not
 * trusted with; any finding keeps the account closed until the owner aborts.
 */
export interface AccountRecovery {
	kind: "account"; id: string; export: string; export_at: string; export_seq: number; at: string;
	state: "checkpoint" | "applying" | "reconciling" | "ready" | "unresolved" | "rolling_back";
	checkpoint?: string; phase?: "clear" | "apply" | "ledger" | "tombstones" | "profiles" | "index";
	next: number; row: number; last?: string; after?: { profile: string; node: string; request: string; done: boolean };
	unresolved: { kind: string; id: string }[]; unresolved_count: number;
}
const CHECKPOINT = "account-checkpoint";
/** A profile's `requests.op` is its write command; the account binds the tool's name (mcp.ts write). Others bind as stored. */
const TOOL_OP: Record<string, string> = { save: "save_memory", append: "append_memory", capture: "capture_memory", candidate: "review_candidates", knowledge: "record_knowledge" };
const boundOp = (q: RestoredPage["requests"][number]) => q.legacy_hash ? (q.legacy_op ?? q.op) : TOOL_OP[q.op] ?? q.op;
/** account_meta keys a restore neither clears nor overwrites: identity, the sequence, the schema, the open recovery, restore history and wipe fences. */
const keptMeta = (key: string) => ["user_id", "write_seq", "schema_version", "recovery_state"].includes(key) || key.startsWith("restore:") || key.startsWith("wiped:");
const KEPT_META_SQL = "key NOT IN ('user_id', 'write_seq', 'schema_version', 'recovery_state') AND key NOT LIKE 'restore:%' AND key NOT LIKE 'wiped:%'";
/** Merged, never cleared: today's counters stay, and the permanent refresh ledger and the sensitive terms only grow. */
const MERGED = ["counters", "refresh_days", "sensitive_terms"];
const ADMIN_WHILE_RESTORING = ["listExports", "restoreStatus", "restoreStep", "openRestore", "abortRestore", "listProfiles", "listDevices"];
const flag = (r: { unresolved: { kind: string; id: string }[]; unresolved_count: number }, found: { kind: string; id: string }[]) => {
	r.unresolved.push(...found.slice(0, Math.max(0, 50 - r.unresolved.length)));
	r.unresolved_count += found.length;
};

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
		// A restore may have cleared the registry it is rebuilding: seeding waits for it, uncached, so the owner can still log in.
		if (this.meta("recovery_state")) return Promise.resolve();
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

	/** Seeding may await. Each caller validates its principal immediately before its synchronous reads. */
	private async contextUser(p: Principal): Promise<Outcome<string>> {
		const userId = p.kind === "owner" ? p.userId : this.meta("user_id");
		if (!userId) return fail("unauthorized", "unknown device token");
		try {
			await this.ensureSeeded(userId);
		} catch (e) {
			return fail("unavailable", `account setup failed: ${(e as Error).message}`);
		}
		return ok(userId);
	}

	private routingRules(): RoutingRule[] {
		return this.sql.exec<{ id: string; priority: number; match: "remote" | "path"; pattern: string; profile: string; enabled: number }>(
			"SELECT id, priority, match, pattern, profile, enabled FROM routing_rules ORDER BY priority").toArray()
			.map((r) => ({ ...r, enabled: r.enabled === 1 }));
	}

	/** Principal to Caller and routing context. Device validation is shared with refreshScope. */
	async context(p: Principal): Promise<Outcome<AccountContext>> {
		const prepared = await this.contextUser(p);
		if (!prepared.ok) return prepared;
		const userId = prepared.value;
		const caller = p.kind === "owner" ? this.ownerCaller(userId, p.device) : this.deviceCaller(userId, p);
		if (!caller.ok) return caller;
		const rules = this.routingRules();
		const profiles = this.sql.exec<{ name: string; generation: string }>("SELECT name, generation FROM profiles WHERE status = 'active' ORDER BY name").toArray()
			.map((r) => ({ userId, profile: r.name, generation: r.generation }));
		const terms = this.sql.exec<{ term: string }>("SELECT term FROM sensitive_terms").toArray().map((r) => r.term);
		return ok({ caller: caller.value, rules, profiles, known: profiles.map((x) => x.profile), sensitiveTerms: [...new Set([...orgTerms(rules), ...terms])] });
	}

	/** Authenticated selected projection, with no await between device validation and the policy snapshot. */
	async refreshScope(p: Principal, profile: string): Promise<Outcome<{ scope: RefreshScope; scope_hash: string }>> {
		// Seeding may await; validate the device in the synchronous snapshot below.
		const prepared = await this.contextUser(p);
		if (!prepared.ok) return prepared;
		if (p.kind !== "device") return fail("forbidden", "a registered ingest device is required");
		const current = this.deviceCaller(prepared.value, p);
		if (!current.ok) return current;
		const caller = current.value;
		if (!caller.scopes.includes("ingest") || !mayUse(caller, profile) || profile === "me") return fail("forbidden", "this device may not read refresh scope");
		if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
		const ref = this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = ? AND status = 'active'", profile).toArray()[0];
		if (!ref) return fail("profile_wiped", "this profile generation is closed");
		const rules = this.routingRules(), github = refreshSelectors(rules, profile);
		if (!github.ok) return github;
		const routing_seq = this.sql.exec<{ seq: string }>("SELECT CAST(MAX(seq) AS TEXT) AS seq FROM routing_rules").one().seq;
		const resource = new URL(this.env.RESOURCE_URL);
		if (resource.protocol !== "https:") return fail("unavailable", "refresh_scope_unsupported");
		const issued_at = now(), generation = ref.generation, device_id = caller.deviceId!;
		const policy_version = sha256(canonicalJson({ version: 1, compiler: "literal-routing-v1", routing_seq, profile, generation, device_id }));
		const scope: RefreshScope = { version: 1, origin: resource.origin, profile, generation, device_id, utc_day: issued_at.slice(0, 10), issued_at,
			policy_version, github: github.value, jira: profile === "work" ? "assigned-open" : null };
		return ok({ scope, scope_hash: sha256(canonicalJson(scope)) });
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

	private recovery(): Recovery | undefined {
		const raw = this.meta("recovery_state");
		return raw ? JSON.parse(raw) as Recovery : undefined;
	}
	private accountRecovery(): AccountRecovery | undefined {
		try {
			const r = this.recovery() as unknown as AccountRecovery | undefined;
			return r?.kind === "account" ? r : undefined;
		} catch { return undefined; } // any other recovery value is a profile recovery or an older marker
	}
	private saveRecovery(r: Recovery | AccountRecovery): void {
		this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('recovery_state', ?)", JSON.stringify(r));
	}
	private profileAt(ref: ProfileRef) {
		return this.env.PROFILE.get(this.env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as
			Pick<ProfileStore, "exportNow" | "restoreStep" | "restoredPage" | "discardRestore">;
	}

	private wiping(): boolean {
		return this.sql.exec("SELECT 1 FROM wipes WHERE json_extract(report, '$.state') <> 'done' LIMIT 1").toArray().length > 0;
	}
	private exportAccount(userId: string) {
		return this.ctx.blockConcurrencyWhile(() => exportStore(this.ctx.storage, this.env, { store: "account", userId, metaTable: "account_meta", control: [] }));
	}

	/**
	 * The wipe's backup step (sections 9 and 18), after every purge and the account's final indexes: the wiped profile's exports
	 * are deleted, and each other store that has any export gets a fresh one, then loses every older one. Stores with no export
	 * need no key. Any failure returns before done, so the wipe stays unfinished and its retry repeats this step.
	 */
	private async replaceExports(wiped: string): Promise<Outcome<{ deleted: Record<string, string[]>; replaced: string[] }>> {
		const userId = this.meta("user_id")!;
		try {
			const deleted: Record<string, string[]> = { [`profile-${wiped}`]: await dropExports(this.env, `profile-${wiped}`, null), [CHECKPOINT]: await dropExports(this.env, CHECKPOINT, null) };
			const replaced: string[] = [];
			const stores: { store: string; ref: ProfileRef | null }[] = [
				...this.sql.exec<{ name: string; generation: string }>("SELECT name, generation FROM profiles WHERE status = 'active' AND name <> ? ORDER BY name", wiped).toArray()
					.map((p) => ({ store: `profile-${p.name}`, ref: { userId, profile: p.name, generation: p.generation } })),
				{ store: "account", ref: null }];
			for (const s of stores) {
				if (!(await hasExports(this.env, s.store))) continue;
				const r = s.ref ? await this.profileAt(s.ref).exportNow(s.ref) : await this.exportAccount(userId);
				// An unbound profile holds nothing: its old exports simply go.
				if (!r.ok && !(s.ref && r.error.code === "not_found")) return fail("unavailable", `could not replace the exports of ${s.store}: ${r.error.message}`);
				deleted[s.store] = await dropExports(this.env, s.store, r.ok ? r.value.id : null);
				replaced.push(s.store);
			}
			return ok({ deleted, replaced });
		} catch (e) { return fail("unavailable", `export replacement failed: ${(e as Error).message}`); }
	}

	/** Internal RPC: only the open restore may write into its reserved generation. */
	async restoreAuthority(who: ProfileRef, id: string): Promise<Outcome<null>> {
		const r = this.recovery();
		return this.meta("user_id") === who.userId && r?.id === id && r.state === "restoring" && r.to === who.generation && r.profile === who.profile
			? ok(null) : fail("forbidden", "no open restore names this generation");
	}

	/** Reconciliation checks for one restored page (section 18, steps 2 to 5); read only. Any finding keeps the account closed. */
	private findings(profile: string, page: RestoredPage): { kind: string; id: string }[] {
		const out: { kind: string; id: string }[] = [];
		for (const n of page.nodes) {
			if (this.meta(`wiped:${n.id}`)) out.push({ kind: "wiped_node", id: n.id });
			else if (n.status === "incoming" || n.status === "moving") out.push({ kind: "transfer_state", id: n.id });
			else if (n.status !== "moved") {
				const owner = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", n.id).toArray()[0]?.profile;
				if (owner && owner !== profile) out.push({ kind: "owned_elsewhere", id: n.id });
			}
		}
		for (const q of page.requests) {
			const row = this.sql.exec<{ profile: string; op: string }>("SELECT profile, op FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
			if (row?.op === "wiped") out.push({ kind: "wiped_request", id: q.request_id });
			else if (row && row.profile !== profile) out.push({ kind: "request_elsewhere", id: q.request_id });
		}
		return out;
	}

	private async backup(cmd: Extract<AccountCommand, { op: "export" | "listExports" | "beginRestore" | "beginAccountRestore" | "restoreStatus" | "restoreStep" | "openRestore" | "abortRestore" }>): Promise<Outcome<unknown>> {
		const userId = this.meta("user_id");
		if (!userId) return fail("unavailable", "the account is not set up");
		// Checked before any await, so nothing below runs for a recovery other than the one the caller named.
		if ((cmd.op === "restoreStep" || cmd.op === "openRestore" || cmd.op === "abortRestore") && cmd.id !== undefined && this.recovery()?.id !== cmd.id) {
			return fail("busy", "the recovery changed since it was shown; read its status", { reason: "recovery_changed" });
		}
		const account = this.accountRecovery();
		if (account && (cmd.op === "restoreStep" || cmd.op === "openRestore" || cmd.op === "abortRestore")) {
			try { return await this.accountRestore(cmd.op, userId, account); } catch (e) {
				if (e instanceof Fail) return { ok: false, error: e.failure };
				return fail("unavailable", `account restore step failed: ${(e as Error).message}`);
			}
		}
		switch (cmd.op) {
			case "beginAccountRestore": {
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				if (this.wiping()) return fail("busy", "finish the unfinished profile wipe before a restore");
				const m = await readManifest(this.env, "account", cmd.export, userId);
				if (!m.ok) return m;
				if (m.value.schema_version !== ACCOUNT_MIGRATIONS.length) return fail("validation", "this export's schema version does not match");
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				const r: AccountRecovery = { kind: "account", id: crypto.randomUUID(), export: m.value.id, export_at: m.value.at, export_seq: m.value.seq, at: now(),
					state: "checkpoint", next: 0, row: 0, unresolved: [], unresolved_count: 0 };
				// A transfer unfinished now, or begun or finished after the export, may have moved a record the snapshot does not know: the owner settles it.
				flag(r, this.sql.exec<{ id: string }>("SELECT id FROM transfers WHERE completed_at IS NULL OR completed_at > ? OR created_at > ? ORDER BY id", m.value.at, m.value.at).toArray()
					.map((t) => ({ kind: "transfer_after_export", id: t.id })));
				// Close first (step 1): nothing below changes the account before this lands.
				this.write(() => this.saveRecovery(r));
				return ok(r);
			}
			case "export": {
				if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
				if (this.wiping()) return fail("busy", "a profile wipe is unfinished; it replaces the exports itself");
				const rows = this.sql.exec<{ name: string; generation: string }>("SELECT name, generation FROM profiles WHERE status = 'active' AND (? IS NULL OR name = ?) ORDER BY name",
					cmd.profile ?? null, cmd.profile ?? null).toArray();
				if (cmd.profile && !rows.length) return fail("not_found", `profile '${cmd.profile}' is not active`);
				const results: Record<string, unknown> = {};
				for (const p of rows) {
					const ref = { userId, profile: p.name, generation: p.generation };
					// Rechecked before each store: an export started before a wipe finishes earlier than the wipe's own replacement.
					if (this.wiping()) return fail("busy", "a profile wipe started; it replaces the exports itself");
					const r = await this.profileAt(ref).exportNow(ref);
					results[p.name] = r.ok ? r.value : r.error.code === "not_found" ? "empty" : { error: r.error };
				}
				if (!cmd.profile) {
					if (this.wiping()) return fail("busy", "a profile wipe started; it replaces the exports itself");
					const a = await this.exportAccount(userId);
					results.account = a.ok ? a.value : { error: a.error };
				}
				const failed = Object.values(results).some((v) => typeof v === "object" && v !== null && "error" in v);
				this.write(() => this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", failed ? "last_export_failed" : "last_export", JSON.stringify({ at: now(), results })));
				return failed ? fail("unavailable", "an export failed", { results }) : ok(results);
			}
			case "listExports":
				return ok(await listExports(this.env, cmd.profile ? `profile-${cmd.profile}` : "account"));
			case "restoreStatus":
				return ok({ recovery: this.recovery() ?? null, last_export: JSON.parse(this.meta("last_export") ?? "null") as unknown });
			case "beginRestore": {
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				if (this.wiping()) return fail("busy", "finish the unfinished profile wipe before a restore");
				const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
				if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
				if (p.status !== "active") return fail("profile_wiped", "only an active profile can be restored");
				const m = await readManifest(this.env, `profile-${cmd.profile}`, cmd.export, userId);
				if (!m.ok) return m;
				if (m.value.profile !== cmd.profile || m.value.schema_version !== PROFILE_MIGRATIONS.length) return fail("validation", "this export's profile or schema version does not match");
				const gen = this.sql.exec<{ state: string }>("SELECT state FROM generations WHERE id = ? AND profile = ?", m.value.generation ?? "", cmd.profile).toArray()[0];
				if (gen?.state === "wiped") return fail("profile_wiped", "this export belongs to a wiped generation");
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				// Close first (step 1): every profile call is refused from here until open or abort.
				const r: Recovery = { id: crypto.randomUUID(), profile: cmd.profile, export: m.value.id, from: p.generation, at: now(), export_at: m.value.at, export_seq: m.value.seq,
					state: "restoring", unresolved: [], unresolved_count: 0 };
				this.write(() => this.saveRecovery(r));
				let to: string;
				try { to = await this.reserveGeneration(userId, cmd.profile, "restore"); } catch (e) {
					this.write(() => this.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'"));
					return fail("unavailable", `could not reserve a restore generation: ${(e as Error).message}`);
				}
				r.to = to;
				this.write((seq) => {
					this.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'reserved', ?, ?)", to, cmd.profile, now(), seq);
					this.saveRecovery(r);
				});
				return ok(r);
			}
			case "restoreStep": {
				const r = this.recovery();
				if (!r) return fail("not_found", "no recovery is open");
				if (!r.to) return fail("validation", "this recovery has no reserved generation; abort it");
				const who = { userId, profile: r.profile, generation: r.to }, stub = this.profileAt(who), started = Date.now();
				if (r.state === "restoring") {
					const s = await stub.restoreStep(who, { id: r.id, exportId: r.export });
					if (!s.ok) return s;
					if (!s.value.done) return ok({ ...r, progress: s.value });
					Object.assign(r, { state: "checking", after: { node: "", request: "" }, restored: { nodes: 0, requests: 0 } });
					this.write(() => this.saveRecovery(r));
				}
				while (r.state === "checking" && Date.now() - started < 20_000) {
					const page = await stub.restoredPage(who, r.after!);
					if (!page.ok) return page;
					if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status");
					const found = this.findings(r.profile, page.value);
					if (r.after!.node === "" && r.after!.request === "" && page.value.open_transfers) found.push({ kind: "open_transfer", id: r.to });
					const done = page.value.nodes.length < 200 && page.value.requests.length < 200;
					// A transfer still open, or finished after the export, may have moved a record in or out: the owner settles it (step 4).
					if (done) for (const t of this.sql.exec<{ id: string }>("SELECT id FROM transfers WHERE (from_profile = ? OR to_profile = ?) AND (completed_at IS NULL OR completed_at > ?)",
						r.profile, r.profile, r.export_at).toArray()) found.push({ kind: "transfer_after_export", id: t.id });
					r.unresolved.push(...found.slice(0, Math.max(0, 50 - r.unresolved.length)));
					r.unresolved_count += found.length;
					r.restored!.nodes += page.value.nodes.length; r.restored!.requests += page.value.requests.length;
					r.after = { node: page.value.nodes.at(-1)?.id ?? r.after!.node, request: page.value.requests.at(-1)?.request_id ?? r.after!.request };
					if (done) r.state = r.unresolved_count ? "unresolved" : "ready";
					this.write(() => this.saveRecovery(r));
				}
				return ok(r);
			}
			case "openRestore": {
				const r = this.recovery();
				if (!r) return fail("not_found", "no recovery is open");
				if (r.state !== "ready" && r.state !== "opening") return fail("validation", `the recovery is ${r.state}; it opens only when ready`);
				const to = r.to!, who = { userId, profile: r.profile, generation: to }, stub = this.profileAt(who), started = Date.now();
				if (r.state === "ready") this.write((seq) => { Object.assign(r, { state: "opening", phase: "index", mark: seq, after: { node: "", request: "" } }); this.saveRecovery(r); });
				// Ownership from the restored generation (steps 3 and 5): every row it holds is restamped after the mark ...
				while (r.phase === "index" && Date.now() - started < 20_000) {
					const page = await stub.restoredPage(who, r.after!);
					if (!page.ok) return page;
					if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status");
					// One bounded transaction (BudgetTx: 1,000 physical rows, 1 MB) per pass; `after` moves with the rows it covers.
					this.write((seq) => {
						const tx = new BudgetTx(this.sql, seq, "");
						let nodes = 0, requests = 0;
						for (const n of page.value.nodes) {
							if (tx.spent(0.5)) break;
							if (n.status !== "moved") tx.run(`INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)
								ON CONFLICT (node_id) DO UPDATE SET seq = excluded.seq WHERE profile = excluded.profile`, n.id, r.profile, seq);
							nodes++;
						}
						if (nodes === page.value.nodes.length) for (const q of page.value.requests) {
							if (tx.spent(0.5)) break;
							tx.run(`INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy) VALUES (?, ?, ?, ?, ?, ?, ?)
								ON CONFLICT (request_id) DO UPDATE SET seq = excluded.seq WHERE profile = excluded.profile AND op <> 'wiped'`,
								q.request_id, r.profile, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, seq, q.legacy_hash ? 1 : 0);
							requests++;
						}
						r.after = { node: page.value.nodes[nodes - 1]?.id ?? r.after!.node, request: page.value.requests[requests - 1]?.request_id ?? r.after!.request };
						if (nodes === page.value.nodes.length && requests === page.value.requests.length && page.value.nodes.length < 200 && page.value.requests.length < 200) r.phase = "sweep";
						tx.run("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('recovery_state', ?)", JSON.stringify(r));
					});
				}
				// ... and what is left at or before it points at records the restored generation does not hold. Wipe refusals stay.
				while (r.phase === "sweep" && Date.now() - started < 20_000) {
					this.write((seq) => {
						const tx = new BudgetTx(this.sql, seq, "");
						let left = true;
						// Pages of 25 keep each statement's index and tombstone rows well inside the remaining budget.
						while (left && !tx.spent(0.5)) {
							const before = tx.rows;
							tx.run("DELETE FROM node_index WHERE node_id IN (SELECT node_id FROM node_index WHERE profile = ? AND seq <= ? LIMIT 25)", r.profile, r.mark!);
							if (!tx.spent(0.5)) tx.run("DELETE FROM request_index WHERE request_id IN (SELECT request_id FROM request_index WHERE profile = ? AND op <> 'wiped' AND seq <= ? LIMIT 25)", r.profile, r.mark!);
							left = tx.rows > before;
						}
						if (!left) { r.phase = "switch"; tx.run("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('recovery_state', ?)", JSON.stringify(r)); }
					});
				}
				if (r.phase !== "switch") return ok(r);
				// The ledger first (section 18, restore step 4): a crash here retries the same idempotent puts while the account stays closed.
				const old = this.sql.exec<{ purpose: string }>("SELECT purpose FROM generations WHERE id = ?", r.from).toArray()[0]?.purpose ?? "live";
				await this.ledger(to, r.profile, "restore", "active");
				await this.ledger(r.from, r.profile, old, "retired");
				const opened = { ...r, state: "opened", opened_at: now() };
				this.write((seq) => {
					this.sql.exec("UPDATE profiles SET generation = ?, object_name = ?, seq = ? WHERE name = ?", to, `${userId}:${r.profile}:${to}`, seq, r.profile);
					this.sql.exec("UPDATE generations SET state = 'active', seq = ? WHERE id = ?", seq, to);
					this.sql.exec("UPDATE generations SET state = 'retired', seq = ? WHERE id = ?", seq, r.from);
					this.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'");
					this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}`, JSON.stringify(opened));
				});
				return ok(opened);
			}
			case "abortRestore": {
				const r = this.recovery();
				if (!r) return fail("not_found", "no recovery is open");
				if (r.state === "opening") return fail("validation", "an opening restore cannot be aborted; finish it with open");
				if (r.to) {
					const who = { userId, profile: r.profile, generation: r.to };
					await this.ledger(r.to, r.profile, "restore", "retired");
					this.write((seq) => this.sql.exec("UPDATE generations SET state = 'retired', seq = ? WHERE id = ?", seq, r.to!));
					await this.profileAt(who).discardRestore(who, r.id).catch(() => undefined);
				}
				const aborted = { ...r, state: "aborted", aborted_at: now() };
				this.write(() => {
					this.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'");
					this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}`, JSON.stringify(aborted));
				});
				return ok(aborted);
			}
		}
	}

	/**
	 * Runs one recovery transaction: refuses if another call moved the recovery, then saves `r` with the rows `fn` wrote, inside
	 * BudgetTx (1,000 physical rows, 1 MB, 100 bound values). On any throw nothing lands and `r` is put back.
	 */
	private advance<T>(r: AccountRecovery, fn: (tx: BudgetTx) => T): T {
		const before = JSON.stringify(r);
		try {
			return this.write((seq) => {
				if (this.meta("recovery_state") !== before) throw Fail.of("busy", "the recovery moved; read its status");
				const tx = new BudgetTx(this.sql, seq, "");
				const out = fn(tx);
				tx.run("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('recovery_state', ?)", JSON.stringify(r));
				return out;
			});
		} catch (e) { Object.assign(r, JSON.parse(before)); throw e; }
	}

	private async accountRestore(op: "restoreStep" | "openRestore" | "abortRestore", userId: string, r: AccountRecovery): Promise<Outcome<unknown>> {
		const close = async (state: "opened" | "aborted") => {
			const end = { ...r, state, [`${state}_at`]: now() }, before = JSON.stringify(r);
			// One transaction: the account reopens exactly when the restore's end is recorded.
			this.write(() => {
				if (this.meta("recovery_state") !== before) throw Fail.of("busy", "the recovery moved; read its status");
				this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}`, JSON.stringify(end));
				this.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'");
			});
			// Only this restore's own checkpoint: a later restore's may already exist. A wipe drops any left over, or one whose id never landed.
			if (r.checkpoint) await dropExportId(this.env, CHECKPOINT, r.checkpoint).catch(() => undefined);
			return ok(end);
		};
		if (op === "openRestore") {
			if (r.state !== "ready") return fail("validation", `the account restore is ${r.state}; it opens only when ready`);
			return close("opened");
		}
		if (op === "abortRestore") {
			if (r.state === "checkpoint") return close("aborted");
			if (r.state !== "rolling_back") this.advance(r, () => Object.assign(r, { state: "rolling_back", phase: "clear", next: 0, row: 0, last: undefined, after: undefined }));
		}
		const started = Date.now(), live = () => Date.now() - started < 20_000;
		if (r.state === "checkpoint") {
			const cp = await this.ctx.blockConcurrencyWhile(() => exportStore(this.ctx.storage, this.env, { store: CHECKPOINT, userId, metaTable: "account_meta", control: [] }));
			if (!cp.ok) return cp;
			this.advance(r, () => Object.assign(r, { state: "applying", checkpoint: cp.value.id, phase: "clear", next: 0, row: 0 }));
		}
		const rollback = r.state === "rolling_back";
		if (r.phase === "clear" || r.phase === "apply") {
			const m = await readManifest(this.env, rollback ? CHECKPOINT : "account", rollback ? r.checkpoint! : r.export, userId);
			if (!m.ok) return m;
			if (!(await this.applySnapshot(r, m.value, rollback, live))) return ok(r);
			if (rollback) return close("aborted");
			this.advance(r, () => Object.assign(r, { state: "reconciling", phase: "ledger", last: undefined }));
		}
		// Generations from the R2 ledger (step 2): a generation activated, retired or wiped after the export keeps that state.
		while (r.phase === "ledger" && live()) {
			const page = await this.env.BACKUPS.list({ prefix: "generations/", limit: 50, ...(r.last ? { startAfter: r.last } : {}) });
			const entries = await Promise.all(page.objects.map(async (o) => ({ key: o.key,
				g: await (await this.env.BACKUPS.get(o.key))?.json<{ id?: unknown; profile?: unknown; purpose?: unknown; state?: unknown; at?: unknown }>().catch(() => null) ?? null })));
			this.advance(r, (tx) => {
				for (const { key, g } of entries) {
					if (!g || typeof g.id !== "string" || key !== `generations/${g.id}.json` || typeof g.profile !== "string" || !PROFILE_NAME.test(g.profile)
						|| typeof g.state !== "string" || !["reserved", "active", "retired", "wiped"].includes(g.state)) { flag(r, [{ kind: "ledger_unreadable", id: key }]); continue; }
					const purpose = typeof g.purpose === "string" && ["live", "restore", "scratch"].includes(g.purpose) ? g.purpose : "live";
					tx.run(`INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, ?, ?, ?, ?)
						ON CONFLICT (id) DO UPDATE SET profile = excluded.profile, state = excluded.state, seq = excluded.seq`, g.id, g.profile, purpose, g.state, typeof g.at === "string" ? g.at : now(), tx.seq);
				}
				r.last = page.objects.at(-1)?.key ?? r.last;
				if (!page.truncated) Object.assign(r, { phase: "tombstones", last: undefined });
			});
		}
		// Every R2 wipe tombstone again (step 2): its ids and requests stay refused, and a wipe the snapshot does not hold as finished keeps the account closed.
		const roots = new Map<string, { profile?: unknown; wiped_at?: unknown } | null>();
		while (r.phase === "tombstones" && live()) {
			const page = await this.env.BACKUPS.list({ prefix: "tombstones/", limit: 20, ...(r.last ? { startAfter: r.last } : {}) });
			for (const o of page.objects) {
				if (!live()) break;
				const cut = o.key.indexOf(".json/"), root = cut < 0 ? o.key : o.key.slice(0, cut + 5);
				if (!roots.has(root)) roots.set(root, await (await this.env.BACKUPS.get(root))?.json<{ record?: { profile?: unknown; wiped_at?: unknown } }>().then((p) => p.record ?? null).catch(() => null) ?? null);
				const plan = roots.get(root), list = /\/(ids|requests)\/[^/]+\.json$/.test(o.key) ? await (await this.env.BACKUPS.get(o.key))?.json<unknown>().catch(() => null) : undefined;
				this.advance(r, (tx) => {
					r.last = o.key;
					if (typeof plan?.profile !== "string" || typeof plan.wiped_at !== "string") return flag(r, [{ kind: "tombstone_unreadable", id: root }]);
					if (o.key === root) {
						const w = this.sql.exec<{ report: string }>("SELECT report FROM wipes WHERE profile = ? AND wiped_at = ?", plan.profile, plan.wiped_at).toArray()[0];
						const state = w ? (JSON.parse(w.report) as { state?: string }).state : undefined;
						// "backups" is a wipe whose account rows are final; only its export replacement is left, which the owner's retry finishes.
						if (state !== "done" && state !== "backups") flag(r, [{ kind: "wipe_not_in_export", id: root }]);
						return;
					}
					if (list === undefined) return;
					if (!Array.isArray(list) || list.length > 100 || list.some((x) => typeof x !== "string")) return flag(r, [{ kind: "tombstone_unreadable", id: o.key }]);
					if (o.key.includes("/ids/")) {
						tx.run("INSERT OR IGNORE INTO account_meta (key, value) SELECT 'wiped:' || value, ? FROM json_each(?)", plan.profile, JSON.stringify(list));
						tx.run("DELETE FROM node_index WHERE node_id IN (SELECT value FROM json_each(?))", JSON.stringify(list));
					} else tx.run(`INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) SELECT value, ?, 'wiped', '', ?, ? FROM json_each(?) WHERE true
						ON CONFLICT (request_id) DO UPDATE SET op = 'wiped', profile = excluded.profile, payload_hash = '', legacy = 0, pending = 0, seq = excluded.seq`,
						plan.profile, plan.wiped_at, tx.seq, JSON.stringify(list));
				});
			}
			if (!page.truncated && r.last === (page.objects.at(-1)?.key ?? r.last)) this.advance(r, () => Object.assign(r, { phase: "profiles", last: undefined }));
		}
		// Each profile at the generation the ledger marks active; a wiped or retired one is never reactivated, and anything else is a finding.
		if (r.phase === "profiles") this.advance(r, (tx) => {
			const rows = this.sql.exec<{ name: string; status: string | null; generation: string | null }>(`SELECT n.name, p.status, p.generation FROM
				(SELECT name FROM profiles UNION SELECT profile FROM generations) n LEFT JOIN profiles p ON p.name = n.name ORDER BY n.name`).toArray();
			for (const p of rows) {
				const active = this.sql.exec<{ id: string }>("SELECT id FROM generations WHERE profile = ? AND state = 'active'", p.name).toArray().map((g) => g.id);
				if (active.length > 1) flag(r, [{ kind: "two_active_generations", id: p.name }]);
				else if (active.length === 1 && p.status === null) flag(r, [{ kind: "profile_not_in_export", id: p.name }]);
				else if (active.length === 1 && p.status !== "active") flag(r, [{ kind: "closed_profile_with_active_generation", id: p.name }]);
				else if (active.length === 1 && p.generation !== active[0]) tx.run("UPDATE profiles SET generation = ?, object_name = ?, seq = ? WHERE name = ?", active[0]!, `${userId}:${p.name}:${active[0]}`, tx.seq, p.name);
				else if (!active.length && p.status === "active") flag(r, [{ kind: "no_active_generation", id: p.name }]);
			}
			Object.assign(r, { phase: "index", after: { profile: "", node: "", request: "", done: true } });
		});
		// Ownership from the active profiles' own rows (steps 3 and 5): the snapshot's node_index and request_index were not applied.
		while (r.phase === "index" && live()) {
			const a = r.after!;
			const p = this.sql.exec<{ name: string; generation: string }>(`SELECT name, generation FROM profiles WHERE status = 'active' AND name ${a.done ? ">" : "="} ? ORDER BY name LIMIT 1`, a.profile).toArray()[0];
			if (!p) {
				this.advance(r, () => {
					flag(r, this.sql.exec<{ id: string }>("SELECT id FROM transfers WHERE completed_at IS NULL OR retry_at IS NOT NULL ORDER BY id").toArray().map((t) => ({ kind: "transfer_unfinished", id: t.id })));
					Object.assign(r, { phase: undefined, after: undefined, state: r.unresolved_count ? "unresolved" : "ready" });
				});
				break;
			}
			const from = a.done ? { node: "", request: "" } : a, who = { userId, profile: p.name, generation: p.generation };
			const page = await this.profileAt(who).restoredPage(who, { node: from.node, request: from.request });
			if (!page.ok) return page;
			this.advance(r, (tx) => {
				const found: { kind: string; id: string }[] = [];
				if (!from.node && !from.request && page.value.open_transfers) found.push({ kind: "open_transfer", id: p.name });
				let nodes = 0, requests = 0;
				for (const n of page.value.nodes) {
					if (tx.spent(0.5)) break;
					nodes++;
					const owner = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", n.id).toArray()[0]?.profile;
					if (this.meta(`wiped:${n.id}`)) found.push({ kind: "wiped_node", id: n.id });
					else if (n.status === "incoming" || n.status === "moving") found.push({ kind: "transfer_state", id: n.id });
					else if (n.status === "moved") continue;
					else if (owner && owner !== p.name) found.push({ kind: "owned_elsewhere", id: n.id });
					else if (!owner) tx.run("INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", n.id, p.name, tx.seq);
				}
				if (nodes === page.value.nodes.length) for (const q of page.value.requests) {
					if (tx.spent(0.5)) break;
					requests++;
					const row = this.sql.exec<{ profile: string; op: string }>("SELECT profile, op FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
					if (row?.op === "wiped") continue; // a wipe's refusal stays
					if (row && row.profile !== p.name) found.push({ kind: "request_elsewhere", id: q.request_id });
					else if (!row) tx.run("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy) VALUES (?, ?, ?, ?, ?, ?, ?)",
						q.request_id, p.name, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, tx.seq, q.legacy_hash ? 1 : 0);
				}
				flag(r, found);
				const finished = nodes === page.value.nodes.length && requests === page.value.requests.length && page.value.nodes.length < 200 && page.value.requests.length < 200;
				r.after = { profile: p.name, node: page.value.nodes[nodes - 1]?.id ?? from.node, request: page.value.requests[requests - 1]?.request_id ?? from.request, done: finished };
			});
		}
		return ok(r);
	}

	/**
	 * Clears what the snapshot replaces, then applies its verified chunks in order, each transaction within BudgetTx with the
	 * (chunk, row) progress in it. The forward restore disables every device and leaves the indexes to the rebuild; the rollback
	 * applies the checkpoint as it was. Wipe refusals are kept either way. True once every chunk is in and the counts match.
	 */
	private async applySnapshot(r: AccountRecovery, m: Manifest, rollback: boolean, live: () => boolean): Promise<boolean> {
		const sql = this.sql, tables = exportTables(sql, { control: [] }).filter((t) => !MERGED.includes(t));
		const keyOf = (t: string) => sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", t).toArray().map((c) => `"${c.name}"`).join(", ");
		while (r.phase === "clear" && live()) this.advance(r, (tx) => {
			for (const t of tables) {
				const where = t === "account_meta" ? `WHERE ${KEPT_META_SQL}` : t === "request_index" ? "WHERE op <> 'wiped'" : "", key = keyOf(t);
				// Pages of 25 keep each statement's index and tombstone rows well inside the budget.
				for (let before = -1; before !== tx.rows && !tx.spent(0.5);) { before = tx.rows; tx.run(`DELETE FROM "${t}" WHERE (${key}) IN (SELECT ${key} FROM "${t}" ${where} LIMIT 25)`); }
				if (tx.spent(0.5)) return;
			}
			r.phase = "apply";
		});
		const exists = (t: string, cols: string[], row: unknown[]) => {
			const key = keyOf(t).split(", ");
			return sql.exec(`SELECT 1 FROM "${t}" WHERE ${key.map((k) => `${k} = ?`).join(" AND ")}`, ...key.map((k) => row[cols.indexOf(k.slice(1, -1))] as SqlStorageValue)).toArray().length > 0;
		};
		const adjust = (t: string, cols: string[], row: unknown[]) => {
			if (t === "account_meta") return keptMeta(String(row[cols.indexOf("key")])) && !String(row[cols.indexOf("key")]).startsWith("wiped:") ? null : row;
			if (t === "counters") return null;
			if (MERGED.includes(t)) return exists(t, cols, row) ? null : row;
			if (t === "node_index") return rollback ? row : null;
			if (t === "request_index") return exists(t, cols, row) || (!rollback && row[cols.indexOf("op")] !== "wiped") ? null : row;
			if (t === "devices" && !rollback) { const out = [...row]; out[cols.indexOf("enabled")] = 0; return out; }
			return row;
		};
		while (r.phase === "apply" && r.next < m.chunks.length && live()) {
			const c = await readChunk(this.env, m, r.next), at = r.next;
			let max = c.rows.length;
			while (r.next === at && live()) {
				const done = { n: 0 };
				try {
					this.advance(r, (tx) => {
						const end = r.row + applyRows(tx, c, r.row, max, adjust, done, c.table === "account_meta");
						Object.assign(r, end === c.rows.length ? { next: at + 1, row: 0 } : { row: end });
					});
					max = c.rows.length;
				} catch (e) {
					if (!(e instanceof Fail) || e.failure.code !== "size_budget") throw e;
					// Rolled back. Retry with strictly fewer rows; a row that overflows on its own can never apply.
					max = Math.min(max - 1, done.n);
					if (max < 1) throw Fail.of("validation", `export row ${r.row} of ${c.table} does not fit one bounded transaction: ${e.failure.message}`);
				}
			}
		}
		if (r.phase !== "apply" || r.next < m.chunks.length) return false;
		for (const t of tables) {
			if (t === "account_meta" || t === "node_index" || t === "request_index") continue;
			if (sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t}"`).one().n !== (m.counts[t] ?? 0)) throw Fail.of("validation", `restored ${t} does not match the export's row count`);
		}
		return true;
	}

	async admin(cmd: AccountCommand): Promise<Outcome<unknown>> {
		const known = this.sql.exec<{ name: string }>("SELECT name FROM profiles").toArray().map((r) => r.name);
		// The account's own rows are being replaced: only reads and the restore itself run until it opens or rolls back.
		if (this.accountRecovery() && !ADMIN_WHILE_RESTORING.includes(cmd.op)) return fail("busy", "account is closed for an account restore");
		switch (cmd.op) {
			case "export": case "listExports": case "beginRestore": case "beginAccountRestore": case "restoreStatus": case "restoreStep": case "openRestore": case "abortRestore":
				return this.backup(cmd);
			case "wipeProfile": {
				const userId = this.meta("user_id");
				if (!userId) return fail("unavailable", "the account is not set up");
				if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
				return wipeProfile(this.env, { ...wipePorts(this.env, this.ctx.storage), backups: (p) => this.replaceExports(p) }, { userId, kind: "owner", scopes: ["read", "write"], profiles: "*" }, cmd.profile, cmd.typed);
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
