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
import { scrubReview, wipePorts, wipeProfile, wipeRefs, wipeTerms } from "../wipe";
import { CORPUS_MIGRATIONS, type CorpusStore } from "../corpus/store";
import { settleRule, type Identity, type RecoveryCopy, type SettleAction, type SettleFacts } from "../profile/store";

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
	| { op: "wipeProfile"; profile: string; typed: string; generation?: string }
	| { op: "wipeStatus"; profile: string }
	/** Internal to the owner preview route: the targets and terms come back to the Worker, which never returns the terms. */
	| { op: "wipePlan"; profile: string }
	// Backups and restore from an export (section 18): owner only, one recovery at a time.
	/** `corpus` also exports the profiles' corpora now; the nightly run exports each corpus once a week. */
	/** `trigger`: set only by the Worker's scheduled handler, from the platform event; every other export is manual. */
	| { op: "export"; profile?: string; corpus?: boolean; trigger?: { scheduled_time: number; cron: string } }
	| { op: "listExports"; profile?: string; corpus?: boolean }
	| { op: "beginRestore"; profile: string; export: string }
	/** Point-in-time restore of a profile's current generation to `at`, or the reversal of restore `undo` by its recorded undo bookmark. */
	| { op: "beginPitr"; profile: string; at?: string; undo?: string }
	/** Restores a profile's corpus export into its current, empty corpus generation. */
	| { op: "beginCorpusRestore"; profile: string; export: string }
	/** The open recovery or a finished one's record, by id. */
	| { op: "restoreRecord"; id: string }
	// The restore drill (section 18): one at a time, into a scratch generation; the account stays open.
	| { op: "beginDrill"; profile: string; generation?: string; request_id: string }
	| { op: "drillStatus" }
	| { op: "drillStep"; id: string }
	| { op: "drillCleanup"; id: string }
	/** The open recovery's copy conflicts, after a node id, with both copies as each profile holds them now. */
	| { op: "recoveryConflicts"; id: string; after?: string }
	/** Content-free placement of one request id across the active profiles and the account, for the open recovery's findings. */
	| { op: "recoveryRequest"; id: string; request_id: string }
	/** Runs the account restore's index rebuild again when its only findings are request ids that recoveryRequest shows stale. */
	| { op: "recheckRequests"; id: string; request_ids: string[] }
	/** The owner keeps one copy of a conflict; the other becomes a flagged tombstone, its content in that profile's archive. */
	| { op: "resolveConflict"; id: string; node: string; keep: string; expect: CopyExpectation[]; request_id: string }
	| { op: "beginAccountRestore"; export: string }
	| { op: "restoreStatus" }
	| { op: "restoreStep"; id?: string }
	| { op: "openRestore"; id?: string }
	| { op: "abortRestore"; id?: string }
	// The owner's review list (section 15). Offer adds open items and never overwrites a decision; a collision resolved earlier
	// reopens when the same move collides again. Assign and resolve only record the owner's choice; they write no memory.
	/** origin: the migrated records' profile and the generation the caller was granted; a collision names its own profiles. */
	| { op: "reviewOffer"; items: ReviewOffer[]; origin?: { profile: string; generation: string } }
	| { op: "reviewList"; kind?: ReviewKind; state?: ReviewState; exportSha?: string; after?: string; limit: number }
	| { op: "reviewAssign"; id: string; profile: "work" | "personal" }
	| { op: "reviewResolve"; id: string; choice: "renamed" | "merged" | "kept" | "moved" };

export type ReviewKind = "migration" | "collision";
export type ReviewState = "open" | "assigned" | "resolved" | "wiped";
export interface ReviewOffer { id: string; kind: ReviewKind; profile: string; payload: Record<string, unknown> }
type ReviewRow = { id: string; kind: ReviewKind; profile: string; state: ReviewState; payload: string; decision: string | null; created_at: string; updated_at: string };
const reviewOut = (r: ReviewRow) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown>, decision: r.decision ? JSON.parse(r.decision) as Record<string, unknown> : null });

/**
 * The open recovery, kept in `recovery_state` while the account is closed. `unresolved` keeps the account closed until the
 * owner aborts; open rebuilds node_index and request_index from the restored generation, then switches the profile to it.
 */
export interface Recovery extends Choices {
	id: string; profile: string; export: string; from: string; to?: string; at: string; export_at: string; export_seq: number;
	state: "restoring" | "settling" | "checking" | "ready" | "unresolved" | "opening" | PitrState;
	after?: { node: string; request: string }; mark?: number; phase?: "precheck" | "deferred" | "index" | "sweep" | "switch";
	restored?: { nodes: number; requests: number }; unresolved: { kind: string; id: string }[]; unresolved_count: number;
	/** Absent for a restore from an export into a new generation. A point-in-time restore keeps `to` = `from`; a corpus restore owns no records. */
	kind?: "pitr" | "corpus";
	/**
	 * pitr: the target time, or the restore whose undo bookmark this one applies. Then, per arm (`armed` is its tag): the fallback
	 * bookmark and the arming session, recorded before anything is armed, and the armed bookmark with the platform's undo after.
	 */
	target_at?: string; reverses?: string; armed?: string; session?: string; fallback?: string; bookmark?: string; undo?: string;
	revert_fallback?: string; revert_bookmark?: string; revert_undo?: string; undo_from?: "platform" | "fallback"; rearmed?: number;
	settle?: Settle; settled?: number;
}
/**
 * requested: open, nothing armed. arming: the fallback bookmark is recorded and a restore may be armed; only a confirmed restart
 * says whether it applied. armed: the armed bookmark and the platform's undo are recorded too. reverting: an abort after a
 * restore applied, which applies the undo bookmark (or the fallback) the same way before the recovery closes.
 */
type PitrState = "requested" | "arming" | "armed" | "reverting";
/** Settlement progress (section 18, step 4): which transfer list is being read, and the last id read from it. */
interface Settle { i: number; after: string }
/** A finding. A copy conflict also names the two profiles holding its node, and the transfer it came from: that is an owner choice. */
export type Finding = { kind: string; id: string; transfer?: string; pair?: [string, string] };
/**
 * One step of settlement or of an owner's choice: a profile action, or the account's own ownership write. A profile or
 * point-in-time restore runs the steps on its restored profile at once and keeps every other one, in order, for open: an
 * abort then leaves the live profiles and the indexes as they were.
 */
export type RecoveryStep = { profile: string; action: SettleAction; id: string; nodeId: string; peer: string; identity?: Identity; flag?: string }
	| { profile: null; node: string; owner: string | null; transfers: { id: string; state: "committed" | "aborted" }[] };
/**
 * The owner's choice between two copies of one node (section 18, step 4), kept as `restore:<recovery>:conflict:<node>`. Open
 * until the owner keeps one copy; `resolving` carries the request id and plan of that choice, so a retry continues or replays.
 */
export interface RecoveryConflict {
	node: string; kind: string; transfer: string | null; profiles: [string, string]; state: "open" | "resolving" | "resolved"; at: string;
	request_id?: string; payload?: string; keep?: string; expect?: CopyExpectation[]; plan?: RecoveryStep[]; next?: number; result?: Record<string, unknown>;
}
/** What the owner saw of each copy; any difference now refuses the choice. A profile without the node is null status and revision. */
export interface CopyExpectation { profile: string; generation: string | null; status: string | null; revision: number | null }
/** Owner choices in progress (`resolving` names the node) and the steps kept for open (`deferred`, `deferred_next`). */
interface Choices { conflicts?: { total: number; open: number }; resolving?: string; deferred?: number; deferred_next?: number }

/**
 * An account restore in place (section 18), kept in `recovery_state`, which the restore never overwrites. `checkpoint` is the
 * encrypted export of the account taken before its first change: an abort applies it back the same bounded way (`rolling_back`).
 * After the snapshot, the R2 generation ledger, the R2 wipe tombstones and the active profiles' own rows rebuild what it is not
 * trusted with; any finding keeps the account closed until the owner aborts.
 */
export interface AccountRecovery extends Choices {
	kind: "account"; id: string; export: string; export_at: string; export_seq: number; at: string;
	state: "checkpoint" | "applying" | "reconciling" | "ready" | "unresolved" | "rolling_back" | "opening";
	checkpoint?: string; phase?: "clear" | "apply" | "ledger" | "tombstones" | "profiles" | "settle" | "index" | "precheck" | "deferred";
	next: number; row: number; last?: string; after?: { profile: string; node: string; request: string; done: boolean; pass?: "held" | "requests" };
	unresolved: { kind: string; id: string }[]; unresolved_count: number;
	settle?: Settle; settled?: number;
	/** Each owner recheck of stale request findings: when, and the findings it replaced. */
	rechecks?: { at: string; findings: { kind: string; id: string }[] }[];
}
const CHECKPOINT = "account-checkpoint";
/** The restore drill, kept in `drill_state` from before its scratch copy exists until its cleanup deleted it; see AccountStore.drill. */
export interface Drill {
	id: string; request_id: string; profile: string; live_generation: string; scratch: string | null; export: string; export_at: string; account_export: string | null;
	state: "restoring" | "embedding" | "checking" | "cleaning" | "done"; at: string; finished_at?: string; progress?: string; passed?: boolean;
	error?: { code: string; message: string };
	report: { chunks: number; rows: Record<string, number>; nodes: number; requests: number; vectors: number; owned_elsewhere: number; requests_elsewhere: number; wiped: number;
		account: { export: string; chunks: number; rows: number } | null; live_generation_unchanged: boolean; cleaned: { vectors: number; scratch: boolean } };
	/** Internal cursors: the ownership pages, then the account export's chunks (-1 once checked). */
	after?: { node: string; request: string }; account_next?: number;
}
/** A profile's `requests.op` is its write command; the account binds the tool's name (mcp.ts write). Others bind as stored. */
const TOOL_OP: Record<string, string> = { save: "save_memory", append: "append_memory", capture: "capture_memory", candidate: "review_candidates", knowledge: "record_knowledge" };
const boundOp = (q: RestoredPage["requests"][number]) => q.legacy_hash ? (q.legacy_op ?? q.op) : TOOL_OP[q.op] ?? q.op;
/** account_meta keys a restore neither clears nor overwrites: identity, the sequence, the schema, the open recovery, restore history and wipe fences. */
const keptMeta = (key: string) => ["user_id", "write_seq", "schema_version", "recovery_state"].includes(key) || key.startsWith("restore:") || key.startsWith("wiped:") || key.startsWith("drill");
const KEPT_META_SQL = "key NOT IN ('user_id', 'write_seq', 'schema_version', 'recovery_state') AND key NOT LIKE 'restore:%' AND key NOT LIKE 'wiped:%' AND key NOT LIKE 'drill%'";
/** Merged, never cleared: today's counters stay, and the permanent refresh ledger and the sensitive terms only grow. */
const MERGED = ["counters", "refresh_days", "sensitive_terms"];
const ADMIN_WHILE_RESTORING = ["drillStatus", "listExports", "restoreStatus", "restoreRecord", "recoveryConflicts", "recoveryRequest", "recheckRequests", "resolveConflict", "restoreStep", "openRestore", "abortRestore", "listProfiles", "listDevices"];
/** recoveryRequest's content-free placement of one request id. */
interface Placement {
	recovery: string; state: string; request_id: string; finding: boolean;
	profiles: { profile: string; present: boolean | null; node_id?: string | null; node_status?: string | null; op?: string; legacy?: boolean; payload?: string | null; legacy_payload?: string | null; bound_payload?: string | null }[];
	binding: { profile: string; op: string; legacy: boolean; payload: string | null } | null;
	nodes: { node_id: string; index: string | null; decided: string | null; owner: string | null; held: string | null; wiped: boolean }[];
	rebuild: { binds: string | null; flags: boolean };
}
/**
 * A restoredPage cursor just below request id `id` in SQLite's text order (UTF-8 bytes, so code points): the id with its last
 * code point lowered and then 256 of the highest, or its prefix when that code point is U+0000. Every id between the cursor and
 * `id` would start with those 256 code points and so exceed the 256-character request id domain.
 */
const cursorBelow = (id: string): string => {
	const cps = Array.from(id), last = cps.pop()!.codePointAt(0)!, prefix = cps.join("");
	if (last === 0) return prefix;
	const lower = last - 1 >= 0xd800 && last - 1 <= 0xdfff ? 0xd7ff : last - 1;
	return `${prefix}${String.fromCodePoint(lower)}${"\u{10FFFF}".repeat(256)}`;
};
/** Why a placement does not prove a request_elsewhere finding stale; undefined when it does. */
const staleWhy = (p: Placement): string | undefined => {
	const rows = p.profiles.filter((x) => x.present), node = p.nodes[0], b = p.binding;
	if (!p.finding) return "not_a_finding";
	if (p.profiles.some((x) => x.present === null)) return "unknown_presence";
	if (rows.length < 2 || p.nodes.length !== 1 || rows.some((x) => !x.node_id || x.node_id !== node!.node_id)) return "not_one_node";
	// The holder: the indexed or decided owner, else the profile that archived the node (the rebuild's held pass indexes it).
	const holder = node!.held;
	if (node!.wiped || !holder) return "no_owner";
	if (rows.some((x) => x.op !== rows[0]!.op || x.legacy !== rows[0]!.legacy || !x.bound_payload || x.bound_payload !== rows[0]!.bound_payload)) return "requests_differ";
	const held = rows.find((x) => x.profile === holder);
	if (!held || held.node_status === "moved" || held.node_status === "incoming") return "owner_lacks_request";
	// The binding may sit on a moved copy's profile; the rerun rebinds it to the holder only when op, legacy and hash agree.
	if (!b || b.op === "wiped" || b.op !== held.op || b.legacy !== held.legacy || b.payload !== held.bound_payload) return "binding_differs";
	if (p.rebuild.flags || p.rebuild.binds !== holder) return "rebuild_flags";
	return undefined;
};
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
			Pick<ProfileStore, "exportNow" | "restoreStep" | "restoredPage" | "discardRestore" | "settleScan" | "settleFacts" | "settleTransfer" | "pitrArm" | "pitrCheck" | "recoveryCopy" | "undoPreflight" | "nodeRequests" | "drillEmbed" | "drillDiscard">;
	}
	private corpusAt(ref: ProfileRef) {
		return this.env.CORPUS_STORE!.get(this.env.CORPUS_STORE!.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as
			Pick<CorpusStore, "exportNow" | "restoreStep" | "discardRestore">;
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
			const deleted: Record<string, string[]> = { [`profile-${wiped}`]: await dropExports(this.env, `profile-${wiped}`, null), [`corpus-${wiped}`]: await dropExports(this.env, `corpus-${wiped}`, null),
				[CHECKPOINT]: await dropExports(this.env, CHECKPOINT, null) };
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

	/** Internal RPC: only the open restore may write into its reserved generation; a corpus restore only into its corpus. */
	async restoreAuthority(who: ProfileRef, id: string, kind?: "corpus"): Promise<Outcome<null>> {
		const r = this.recovery(), d = kind ? undefined : this.drillOpen();
		const restore = r?.id === id && r.state === "restoring" && r.to === who.generation && r.profile === who.profile && r.kind === kind;
		const drill = d?.id === id && d.state === "restoring" && d.scratch === who.generation && d.profile === who.profile;
		return this.meta("user_id") === who.userId && (restore || drill) ? ok(null) : fail("forbidden", "no open restore names this generation");
	}

	/** An unfinished restore drill: its scratch generation may hold a copy of a profile, so recoveries and wipes wait for it. */
	private drillOpen(): Drill | undefined {
		const raw = this.meta("drill_state");
		return raw ? JSON.parse(raw) as Drill : undefined;
	}
	private saveDrill(d: Drill): void {
		this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('drill_state', ?)", JSON.stringify(d));
	}

	/** Internal RPC: only the open drill's own step may act on its scratch generation, in that step's state. */
	async drillAuthority(who: ProfileRef, id: string, state: Drill["state"]): Promise<Outcome<null>> {
		const d = this.drillOpen();
		return this.meta("user_id") === who.userId && d?.id === id && d.state === state && d.scratch === who.generation && d.profile === who.profile
			? ok(null) : fail("forbidden", "no open drill names this generation");
	}

	/**
	 * The restore drill (section 18): one profile's newest compatible export is restored into a fresh scratch generation reserved
	 * in the R2 ledger, embedded under its own `g<scratch>:` ids, checked, and cleaned up; the account's newest export is decrypted
	 * and hash- and count-checked without being applied. The scratch generation is never active, and `profiles`, `node_index` and
	 * `request_index` are never written, so the account stays open. `drill_state` is written before any copy exists and removed
	 * only after the cleanup deleted it, so recoveries and wipes stay refused while a copy may exist.
	 */
	private async drill(userId: string, cmd: Extract<AccountCommand, { op: "beginDrill" | "drillStatus" | "drillStep" | "drillCleanup" }>): Promise<Outcome<unknown>> {
		if (cmd.op === "drillStatus") {
			const last = this.meta("drill_last");
			return ok({ drill: this.drillOpen() ?? null, last: last ? JSON.parse(this.meta(`drill:${last}`) ?? "null") as Drill | null : null });
		}
		if (cmd.op === "beginDrill") {
			const payload = sha256(canonicalJson({ profile: cmd.profile, generation: cmd.generation ?? null })), key = `drill_request:${sha256(cmd.request_id)}`;
			const held = JSON.parse(this.meta(key) ?? "null") as { id: string; payload: string } | null;
			if (held) {
				if (held.payload !== payload) return fail("idempotency_mismatch", "this request id began a drill with other arguments");
				const open = this.drillOpen();
				return ok(open?.id === held.id ? open : JSON.parse(this.meta(`drill:${held.id}`) ?? "null") as unknown);
			}
			const refuse = () => this.meta("recovery_state") ? fail("busy", "a recovery is open", { reason: "recovery_open" })
				: this.wiping() ? fail("busy", "a profile wipe is unfinished", { reason: "wipe_unfinished" })
				: this.drillOpen() ? fail("busy", "another drill is not finished", { reason: "drill_open" }) : null;
			const early = refuse();
			if (early) return early;
			const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
			if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
			if (p.status !== "active") return fail("profile_wiped", "only an active profile can be drilled");
			if (cmd.generation !== undefined && p.generation !== cmd.generation) return fail("busy", "the profile changed since it was shown; read its status", { reason: "generation_changed" });
			// The newest complete export this code can restore: same profile and schema, and not of a wiped generation.
			let chosen: Manifest | undefined;
			for (const id of (await listExports(this.env, `profile-${cmd.profile}`)).reverse()) {
				const m = await readManifest(this.env, `profile-${cmd.profile}`, id, userId);
				if (!m.ok || m.value.profile !== cmd.profile || m.value.schema_version !== PROFILE_MIGRATIONS.length) continue;
				if (this.sql.exec<{ state: string }>("SELECT state FROM generations WHERE id = ?", m.value.generation ?? "").toArray()[0]?.state === "wiped") continue;
				chosen = m.value;
				break;
			}
			if (!chosen) return fail("not_found", `no complete compatible export of ${cmd.profile}`);
			let account: string | null = null;
			for (const id of (await listExports(this.env, "account")).reverse()) {
				const m = await readManifest(this.env, "account", id, userId);
				if (m.ok && m.value.schema_version === ACCOUNT_MIGRATIONS.length) { account = m.value.id; break; }
			}
			// Rechecked after the awaits: the gate below is the only one, and it lands before anything else.
			const late = refuse();
			if (late) return late;
			if (this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = ? AND status = 'active'", cmd.profile).toArray()[0]?.generation !== p.generation) {
				return fail("busy", "the profile changed since it was shown; read its status", { reason: "generation_changed" });
			}
			const d: Drill = { id: crypto.randomUUID(), request_id: cmd.request_id, profile: cmd.profile, live_generation: p.generation, scratch: null, export: chosen.id,
				export_at: chosen.at, account_export: account, state: "restoring", at: now(),
				report: { chunks: chosen.chunks.length, rows: chosen.counts, nodes: 0, requests: 0, vectors: 0, owned_elsewhere: 0, requests_elsewhere: 0, wiped: 0,
					account: null, live_generation_unchanged: true, cleaned: { vectors: 0, scratch: false } } };
			this.write(() => { this.saveDrill(d); this.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, ?)", key, JSON.stringify({ id: d.id, payload })); });
			let scratch: string;
			try { scratch = await this.reserveGeneration(userId, cmd.profile, "scratch"); } catch (e) {
				// Nothing was copied: the drill ends here, failed, and the gate goes with it.
				return ok(this.finishDrill(d, { code: "unavailable", message: `could not reserve a scratch generation: ${(e as Error).message}` }));
			}
			this.write((seq) => {
				// A cleanup during the reservation finished this drill: its just-reserved id is left unused, and nothing reopens it.
				this.sameDrill(d);
				d.scratch = scratch;
				this.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'scratch', 'reserved', ?, ?)", scratch, cmd.profile, now(), seq);
				this.saveDrill(d);
			});
			return ok(d);
		}
		const d = this.drillOpen();
		if (!d || d.id !== cmd.id) return fail("busy", "the drill changed since it was shown; read its status", { reason: "drill_changed" });
		// Every write first checks that the drill is still the one, in the state, this request last saw: a reply that waited out a
		// cleanup or a finish is stale, and moves nothing (no later phase, no failure recreating a finished drill).
		const save = (change: Partial<Drill>) => this.write(() => { this.sameDrill(d); Object.assign(d, change); this.saveDrill(d); });
		// A deterministic refusal ends the checks; the copy is still cleaned up before the drill finishes.
		const failed = (e: { code: string; message: string }) => { save({ state: "cleaning", error: { code: e.code, message: e.message }, progress: undefined }); return ok(d); };
		const transient = (e: { code: string }) => e.code === "busy" || e.code === "unavailable";
		if (cmd.op === "drillCleanup" && d.state !== "cleaning") save({ state: "cleaning", progress: undefined, error: d.error ?? { code: "stopped", message: "the owner stopped the drill" } });
		if (!d.scratch) return ok(this.finishDrill(d, d.error ?? null));
		const ref = { userId, profile: d.profile, generation: d.scratch }, stub = this.profileAt(ref), started = Date.now(), live = () => Date.now() - started < 20_000;
		if (d.state === "restoring") {
			const s = await stub.restoreStep(ref, { id: d.id, exportId: d.export });
			if (!s.ok) return transient(s.error) ? s : failed(s.error);
			if (!s.value.done) { save({ progress: `${s.value.applied} of ${s.value.chunks} chunks` }); return ok(d); }
			save({ state: "embedding", progress: undefined });
		}
		if (d.state === "embedding") {
			const x = await stub.drillEmbed(ref, d.id);
			if (!x.ok) return transient(x.error) ? x : failed(x.error);
			if (!x.value.done) { save({ progress: `${x.value.embedded} cards embedded`, report: { ...d.report, vectors: x.value.embedded } }); return ok(d); }
			save({ state: "checking", progress: undefined, report: { ...d.report, vectors: x.value.embedded }, after: { node: "", request: "" } });
		}
		while (d.state === "checking" && live()) {
			if (d.after) {
				// Ownership against the live index, read only: what a restore of this export would find, without one.
				const page = await stub.restoredPage(ref, d.after);
				if (!page.ok) return transient(page.error) ? page : failed(page.error);
				const r = { ...d.report };
				for (const n of page.value.nodes) {
					r.nodes++;
					if (this.meta(`wiped:${n.id}`)) r.wiped++;
					else if (n.status !== "moved" && n.status !== "incoming") {
						const owner = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", n.id).toArray()[0]?.profile;
						if (owner && owner !== d.profile) r.owned_elsewhere++;
					}
				}
				for (const q of page.value.requests) {
					r.requests++;
					const row = this.sql.exec<{ profile: string; op: string }>("SELECT profile, op FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
					if (row && row.op !== "wiped" && row.profile !== d.profile) r.requests_elsewhere++;
				}
				const more = page.value.nodes.length === 200 || page.value.requests.length === 200;
				save({ report: r, after: more ? { node: page.value.nodes.at(-1)?.id ?? d.after.node, request: page.value.requests.at(-1)?.request_id ?? d.after.request } : undefined, account_next: 0 });
				continue;
			}
			if (d.account_export && (d.account_next ?? 0) >= 0) {
				const m = await readManifest(this.env, "account", d.account_export, userId);
				if (!m.ok) return transient(m.error) ? m : failed(m.error);
				let next = d.account_next ?? 0, rows = d.report.account?.rows ?? 0;
				try {
					for (; next < m.value.chunks.length && live(); next++) rows += (await readChunk(this.env, m.value, next)).rows.length;
				} catch (e) { return e instanceof Fail ? failed(e.failure) : fail("unavailable", (e as Error).message); }
				const total = Object.values(m.value.counts).reduce((a, b) => a + b, 0);
				if (next < m.value.chunks.length) { save({ account_next: next, report: { ...d.report, account: { export: m.value.id, chunks: next, rows } } }); continue; }
				if (rows !== total) return failed({ code: "validation", message: `the account export holds ${rows} rows, its manifest ${total}` });
				save({ account_next: -1, report: { ...d.report, account: { export: m.value.id, chunks: next, rows } } });
				continue;
			}
			const unchanged = this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = ?", d.profile).toArray()[0]?.generation === d.live_generation
				&& this.sql.exec<{ state: string }>("SELECT state FROM generations WHERE id = ?", d.scratch).toArray()[0]?.state === "reserved";
			save({ state: "cleaning", report: { ...d.report, live_generation_unchanged: unchanged }, ...(unchanged ? {} : { error: { code: "validation", message: "the live or scratch generation changed during the drill" } }) });
		}
		if (d.state !== "cleaning") return ok(d);
		// Cleanup deletes only the scratch object and its own vectors; until it has, the gate stays.
		while (live()) {
			const x = await stub.drillDiscard(ref, d.id);
			if (!x.ok) return x;
			save({ report: { ...d.report, cleaned: { vectors: d.report.cleaned.vectors + x.value.vectors, scratch: x.value.done } } });
			if (x.value.done) break;
		}
		if (!d.report.cleaned.scratch) return ok(d);
		await this.ledger(d.scratch, d.profile, "scratch", "retired");
		this.write((seq) => this.sql.exec("UPDATE generations SET state = 'retired', seq = ? WHERE id = ? AND purpose = 'scratch'", seq, d.scratch));
		return ok(this.finishDrill(d, d.error ?? null));
	}

	/** Throws busy unless the stored drill is `d`, in `d`'s state: a request acting on what it read before an await is stale otherwise. */
	private sameDrill(d: Drill): void {
		const cur = this.drillOpen();
		if (!cur || cur.id !== d.id || cur.state !== d.state) throw Fail.of("busy", "the drill moved since this step read it; read its status", { reason: "drill_changed" });
	}

	/** Records the finished drill and removes the gate, in one write; only once nothing of its copy remains. */
	private finishDrill(d: Drill, error: { code: string; message: string } | null): Drill {
		const done: Drill = { ...d, state: "done", finished_at: now(), passed: !error && d.report.live_generation_unchanged && (d.report.cleaned.scratch || !d.scratch),
			progress: undefined, after: undefined, account_next: undefined, ...(error ? { error } : {}) };
		this.write(() => {
			this.sameDrill(d);
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `drill:${d.id}`, JSON.stringify(done));
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES ('drill_last', ?)", d.id);
			this.sql.exec("DELETE FROM account_meta WHERE key = 'drill_state'");
		});
		return done;
	}

	/** The generation a settlement reads and writes: the restored one for the restored profile, else the active one. */
	private settleGeneration(r: Recovery | AccountRecovery, profile: string): string | undefined {
		if (!("kind" in r && r.kind === "account") && (r as Recovery).profile === profile) return (r as Recovery).to;
		return this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = ? AND status = 'active'", profile).toArray()[0]?.generation;
	}

	/** Internal RPC: only the open recovery's settlement phase may run a settlement action, and only on the generation it reads. */
	async settleAuthority(who: ProfileRef, id: string): Promise<Outcome<null>> {
		const r = this.recovery() as Recovery | AccountRecovery | undefined;
		// Settlement, an owner's choice being carried out, or the kept steps at open.
		const settling = !!r && (r.state === "settling" || ("kind" in r && r.kind === "account" && r.state === "reconciling" && r.phase === "settle")
			|| (r.state === "unresolved" && !!r.resolving) || (r.state === "opening" && r.phase === "deferred"));
		return this.meta("user_id") === who.userId && r?.id === id && settling && this.settleGeneration(r, who.profile) === who.generation
			? ok(null) : fail("forbidden", "no open recovery settles this generation");
	}

	/**
	 * Internal RPC from the profile's pitrArm, in its stages. Without `marks`, only checks that the open point-in-time restore
	 * expects this arm. `prepared` durably records the fallback bookmark and the arming session before anything is armed;
	 * `armed` records the armed bookmark and the platform's undo bookmark; `released` withdraws an arm the profile knows it never
	 * armed. The profile arms only after `prepared` landed.
	 */
	async pitrRecord(who: ProfileRef, id: string, tag: string,
		marks?: { stage: "prepared"; fallback: string; session: string } | { stage: "armed"; bookmark: string; undo: string } | { stage: "released" }): Promise<Outcome<null>> {
		const r = this.recovery();
		const reverting = r?.state === "reverting", expected = !r ? undefined : reverting ? `${r.id}:revert` : r.state === "requested" || r.state === "arming" ? r.id : undefined;
		if (this.meta("user_id") !== who.userId || r?.kind !== "pitr" || r.id !== id || r.profile !== who.profile || r.from !== who.generation || tag !== expected) {
			return fail("forbidden", "no open point-in-time restore expects this bookmark");
		}
		const fresh = r.armed !== tag;
		if ((!marks || marks.stage === "prepared") !== fresh) return fail("forbidden", fresh ? "this arm was not prepared" : "this arm is already prepared");
		if (!marks) return ok(null);
		const before = JSON.stringify(r);
		this.write(() => {
			if (this.meta("recovery_state") !== before) throw Fail.of("busy", "the recovery moved; read its status");
			if (marks.stage === "prepared") Object.assign(r, { armed: tag, session: marks.session }, reverting ? { revert_fallback: marks.fallback } : { state: "arming", fallback: marks.fallback });
			else if (marks.stage === "armed") Object.assign(r, reverting ? { revert_bookmark: marks.bookmark, revert_undo: marks.undo } : { state: "armed", bookmark: marks.bookmark, undo: marks.undo });
			else Object.assign(r, { armed: undefined, session: undefined }, reverting ? { revert_fallback: undefined } : { state: "requested", fallback: undefined });
			this.saveRecovery(r);
		});
		return ok(null);
	}

	/** Reconciliation checks for one restored page (section 18, steps 2 to 5); read only. Any finding keeps the account closed. */
	private findings(r: Recovery, page: RestoredPage): Finding[] {
		const out: Finding[] = [], profile = r.profile;
		for (const n of page.nodes) {
			if (this.meta(`wiped:${n.id}`)) out.push({ kind: "wiped_node", id: n.id });
			else if (n.status === "incoming" || n.status === "moving") { if (this.decidedOf(r, n.id) === undefined) out.push({ kind: "transfer_state", id: n.id }); }
			else if (n.status !== "moved") {
				// Two copies with no transfer identity: the owner chooses (step 4).
				const owner = this.ownerOf(r, n.id);
				if (owner && owner !== profile) out.push({ kind: "owned_elsewhere", id: n.id, pair: [profile, owner] });
			}
		}
		for (const q of page.requests) {
			const row = this.sql.exec<{ profile: string; op: string }>("SELECT profile, op FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
			if (row?.op === "wiped") out.push({ kind: "wiped_request", id: q.request_id });
			else if (row && row.profile !== profile && ![profile, row.profile].includes(this.requestOwner(r, q, profile) ?? "")) out.push({ kind: "request_elsewhere", id: q.request_id });
		}
		return out;
	}

	/** A profile's unfinished transfer rows that this recovery has not planned to end; more than 50 is one finding of its own. */
	private openTransfers(r: Recovery | AccountRecovery, profile: string, page: RestoredPage): Finding[] {
		const out: Finding[] = page.open_transfer_ids.filter((id) => !this.planned(r, id, profile)).map((id) => ({ kind: "open_transfer", id }));
		if (page.open_transfers > page.open_transfer_ids.length) out.push({ kind: "open_transfer", id: `${profile}:more` });
		return out;
	}

	/** Step 5: a request id found in two profiles goes with the profile that owns its node; one whose node `profile` holds, there. */
	private requestOwner(r: Recovery | AccountRecovery, q: RestoredPage["requests"][number], profile: string): string | undefined {
		return (q.node_id ? this.ownerOf(r, q.node_id) : undefined) ?? (q.node_status && q.node_status !== "moved" && q.node_status !== "incoming" ? profile : undefined);
	}
	/**
	 * A request row whose node is absent from its profile, with no decision or wipe: the profile archived that node (an owner
	 * forget or TTL removal keeps its receipts and its live index row; the 300-day purge removes the receipts with the archive).
	 */
	private archivedHere(r: Recovery | AccountRecovery, q: RestoredPage["requests"][number]): q is RestoredPage["requests"][number] & { node_id: string } {
		return !!q.node_id && q.node_status === null && this.decidedOf(r, q.node_id) === undefined && !this.meta(`wiped:${q.node_id}`);
	}

	private async backup(cmd: Extract<AccountCommand, { op: "export" | "listExports" | "beginRestore" | "beginAccountRestore" | "beginPitr" | "beginCorpusRestore" | "restoreRecord" | "recoveryConflicts" | "recoveryRequest" | "recheckRequests" | "resolveConflict" | "restoreStatus" | "restoreStep" | "openRestore" | "abortRestore" }>): Promise<Outcome<unknown>> {
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
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				if (this.wiping()) return fail("busy", "finish the unfinished profile wipe before a restore");
				const m = await readManifest(this.env, "account", cmd.export, userId);
				if (!m.ok) return m;
				if (m.value.schema_version !== ACCOUNT_MIGRATIONS.length) return fail("validation", "this export's schema version does not match");
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				// Rechecked after the manifest read, in the same turn as the write below: a drill begun meanwhile keeps the account to itself.
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				const r: AccountRecovery = { kind: "account", id: crypto.randomUUID(), export: m.value.id, export_at: m.value.at, export_seq: m.value.seq, at: now(),
					state: "checkpoint", next: 0, row: 0, unresolved: [], unresolved_count: 0 };
				// A transfer unfinished now, or begun or finished after the export, is settled from both profiles by the fixed rules (phase settle).
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
				// What each store did this run, beside the unchanged results: the generation it exported (the account has none), the export
				// id it wrote or is still writing, and for a corpus whether it was due (newest complete export older than about a week).
				const stores: Record<string, { generation: string | null; state: "completed" | "running" | "empty" | "failed" | "skipped_recent"; export_id: string | null;
					due?: boolean; export_generation?: string | null }> = {};
				const mark = (store: string, generation: string | null, r: Outcome<{ id: string; state?: string }>, extra: { due?: boolean } = {}) => {
					stores[store] = { generation, ...extra, ...(r.ok ? { state: r.value.state === "running" ? "running" : "completed", export_id: r.value.id }
						: { state: r.error.code === "not_found" ? "empty" : "failed", export_id: null }) };
				};
				const trigger = cmd.trigger ? { kind: "scheduled", scheduled_time: Number.isFinite(cmd.trigger.scheduled_time) ? new Date(cmd.trigger.scheduled_time).toISOString() : null,
					cron: typeof cmd.trigger.cron === "string" ? cmd.trigger.cron.slice(0, 64) : null } : { kind: "manual" };
				// A store whose export throws (an object reset) is recorded as failed like any other, so last_export_failed keeps it.
				const caught = <T>(p: Promise<Outcome<T>>): Promise<Outcome<T>> => p.catch((e: unknown) => fail("unavailable", `export failed: ${(e as Error)?.message ?? String(e)}`));
				for (const p of rows) {
					const ref = { userId, profile: p.name, generation: p.generation };
					// Rechecked before each store: an export started before a wipe finishes earlier than the wipe's own replacement.
					if (this.wiping()) return fail("busy", "a profile wipe started; it replaces the exports itself");
					const r = await caught(this.profileAt(ref).exportNow(ref));
					results[p.name] = r.ok ? r.value : r.error.code === "not_found" ? "empty" : { error: r.error };
					mark(p.name, p.generation, r);
				}
				if (!cmd.profile) {
					if (this.wiping()) return fail("busy", "a profile wipe started; it replaces the exports itself");
					const a = await caught(this.exportAccount(userId));
					results.account = a.ok ? a.value : { error: a.error };
					mark("account", null, a);
				}
				// The corpus weekly (section 18), also kept two: once its newest complete export is older than about a week, or when asked.
				const week = new Date(Date.now() - 6.5 * 86_400_000).toISOString().replace(/[-:.]/g, "");
				for (const p of this.env.CORPUS_STORE ? rows.filter((x) => x.name !== "me") : []) {
					const newest = (await listExports(this.env, `corpus-${p.name}`)).at(-1), due = (newest ?? "") < week;
					if (!cmd.corpus && !due) {
						// Not due: name the recent complete export that covers it, with the generation its manifest records.
						const m = await readManifest(this.env, `corpus-${p.name}`, newest!, userId);
						stores[`corpus-${p.name}`] = { generation: p.generation, state: "skipped_recent", export_id: newest!, due, export_generation: m.ok ? m.value.generation ?? null : null };
						continue;
					}
					if (this.wiping()) return fail("busy", "a profile wipe started; it replaces the exports itself");
					const ref = { userId, profile: p.name, generation: p.generation };
					// Starts or reports the corpus's background export; it lists as complete once its manifest lands.
					const c = await caught(this.corpusAt(ref).exportNow(ref));
					results[`corpus-${p.name}`] = c.ok ? c.value : c.error.code === "not_found" ? "empty" : { error: c.error };
					mark(`corpus-${p.name}`, p.generation, c, { due });
				}
				const failed = Object.values(results).some((v) => typeof v === "object" && v !== null && "error" in v);
				this.write(() => this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", failed ? "last_export_failed" : "last_export", JSON.stringify({ at: now(), trigger, results, stores })));
				return failed ? fail("unavailable", "an export failed", { results }) : ok(results);
			}
			case "listExports":
				return ok(await listExports(this.env, cmd.profile ? `${cmd.corpus ? "corpus" : "profile"}-${cmd.profile}` : "account"));
			case "restoreStatus":
				// The latest attempt may be the failed one: both records are read, each with its own `at` and trigger.
				return ok({ recovery: this.recovery() ?? null, last_export: JSON.parse(this.meta("last_export") ?? "null") as unknown,
					last_export_failed: JSON.parse(this.meta("last_export_failed") ?? "null") as unknown });
			case "recoveryConflicts":
				return this.recoveryConflicts(userId, cmd);
			case "recoveryRequest": {
				const r = this.recovery() as Recovery | AccountRecovery | undefined;
				if (!r || r.id !== cmd.id) return fail("busy", "the recovery changed since it was shown; read its status", { reason: "recovery_changed" });
				return this.requestPlacement(userId, r, cmd.request_id);
			}
			case "recheckRequests":
				try { return await this.recheckRequests(userId, cmd); } catch (e) {
					if (e instanceof Fail) return { ok: false, error: e.failure };
					throw e;
				}
			case "resolveConflict":
				try { return await this.resolveConflict(userId, cmd); } catch (e) {
					if (e instanceof Fail) return { ok: false, error: e.failure };
					return fail("unavailable", `the choice did not finish: ${(e as Error).message}; repeat it with the same request id`);
				}
			case "restoreRecord": {
				const open = this.recovery();
				if (open?.id === cmd.id) return ok(open);
				const done = this.meta(`restore:${cmd.id}`);
				return done ? ok(JSON.parse(done) as unknown) : fail("not_found", "no restore has that id");
			}
			case "beginPitr": {
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				if (this.wiping()) return fail("busy", "finish the unfinished profile wipe before a restore");
				const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
				if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
				if (p.status !== "active") return fail("profile_wiped", "only an active profile can be restored");
				let target: Pick<Recovery, "target_at" | "bookmark" | "reverses" | "export_at">;
				if (cmd.undo !== undefined) {
					// The reversal applies the undo bookmark the reversed restore recorded, to the same generation only.
					const rec = JSON.parse(this.meta(`restore:${cmd.undo}`) ?? "null") as Recovery | null;
					if (rec?.kind !== "pitr" || (rec.state as string) !== "opened" || rec.profile !== cmd.profile || rec.from !== p.generation || !rec.undo) {
						return fail("validation", "only an opened point-in-time restore of this profile's current generation can be reversed");
					}
					target = { bookmark: rec.undo, reverses: cmd.undo, export_at: rec.at };
				} else {
					const at = Date.parse(cmd.at ?? "");
					if (!Number.isFinite(at) || at > Date.now() - 1_000 || at < Date.now() - 30 * 86_400_000) return fail("validation", "at must be an ISO time in the past, within the last 30 days");
					// A bookmark before this generation began would bring back an empty or half-restored object.
					const g = this.sql.exec<{ reserved_at: string }>("SELECT reserved_at FROM generations WHERE id = ?", p.generation).toArray()[0];
					if (g && Date.parse(g.reserved_at) > at) return fail("validation", "that time is before this profile's current generation began; restore from an export instead", { reason: "before_generation" });
					target = { target_at: new Date(at).toISOString(), export_at: new Date(at).toISOString() };
				}
				const r: Recovery = { kind: "pitr", id: crypto.randomUUID(), profile: cmd.profile, export: "", from: p.generation, to: p.generation, at: now(), export_seq: 0,
					state: "requested", unresolved: [], unresolved_count: 0, ...target };
				// Close first (step 1): every profile call is refused from here until open or abort.
				this.write(() => this.saveRecovery(r));
				const first = await this.backup({ op: "restoreStep", id: r.id });
				// Nothing was armed: the recovery ends here, and the account reopens.
				if (!first.ok && this.recovery()?.id === r.id && this.recovery()!.state === "requested") {
					this.endRecovery(this.recovery()!, "aborted");
					return first;
				}
				return first;
			}
			case "beginCorpusRestore": {
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				if (this.wiping()) return fail("busy", "finish the unfinished profile wipe before a restore");
				if (!this.env.CORPUS_STORE) return fail("unavailable", "the corpus is not bound");
				const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
				if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
				// A wiped profile's corpus is refused (section 18): it owns no records, so this is its only reconciliation.
				if (p.status !== "active" || cmd.profile === "me") return fail("profile_wiped", "only an active profile other than me has a corpus to restore");
				const m = await readManifest(this.env, `corpus-${cmd.profile}`, cmd.export, userId);
				if (!m.ok) return m;
				if (m.value.profile !== cmd.profile || m.value.schema_version !== CORPUS_MIGRATIONS.length) return fail("validation", "this export's profile or schema version does not match");
				const gen = this.sql.exec<{ state: string }>("SELECT state FROM generations WHERE id = ? AND profile = ?", m.value.generation ?? "", cmd.profile).toArray()[0];
				if (gen?.state === "wiped") return fail("profile_wiped", "this export belongs to a wiped generation");
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				// Rechecked after the manifest read, in the same turn as the write below: a drill begun meanwhile keeps the account to itself.
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				const r: Recovery = { kind: "corpus", id: crypto.randomUUID(), profile: cmd.profile, export: m.value.id, from: p.generation, to: p.generation, at: now(),
					export_at: m.value.at, export_seq: m.value.seq, state: "restoring", unresolved: [], unresolved_count: 0 };
				this.write(() => this.saveRecovery(r));
				return ok(r);
			}
			case "beginRestore": {
				if (this.meta("recovery_state")) return fail("busy", "a recovery is already open");
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
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
				// Rechecked after the manifest read, in the same turn as the write below: a drill begun meanwhile keeps the account to itself.
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
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
				if (r.kind === "corpus") return this.corpusStep(r, userId);
				if (r.kind === "pitr") {
					const waiting = await this.pitrStep(r, userId);
					if (waiting) return waiting;
				}
				if (!r.to) return fail("validation", "this recovery has no reserved generation; abort it");
				const who = { userId, profile: r.profile, generation: r.to }, stub = this.profileAt(who), started = Date.now();
				if (r.state === "restoring") {
					const s = await stub.restoreStep(who, { id: r.id, exportId: r.export });
					if (!s.ok) return s;
					if (!s.value.done) return ok({ ...r, progress: s.value });
					this.advance(r, () => Object.assign(r, { state: "settling", settle: { i: 0, after: "" }, settled: 0 }));
				}
				// Transfers by the fixed rules (step 4), before the ownership checks read the settled rows.
				if (r.state === "settling") {
					const s = await this.settleTransfers(r, userId, () => Date.now() - started < 20_000);
					if (!s.ok) return s;
					if (r.state === "settling") return ok(r);
				}
				while (r.state === "checking" && Date.now() - started < 20_000) {
					const page = await stub.restoredPage(who, r.after!);
					if (!page.ok) return page;
					if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status");
					const found = this.findings(r, page.value);
					if (r.after!.node === "" && r.after!.request === "") found.push(...this.openTransfers(r, r.profile, page.value));
					const done = page.value.nodes.length < 200 && page.value.requests.length < 200;
					// A transfer the settlement left open stays a finding (step 4).
					if (done) for (const t of this.sql.exec<{ id: string }>("SELECT id FROM transfers WHERE (from_profile = ? OR to_profile = ?) AND completed_at IS NULL",
						r.profile, r.profile).toArray()) if (!this.planned(r, t.id)) found.push({ kind: "transfer_unfinished", id: t.id });
					this.advance(r, () => {
						r.restored!.nodes += page.value.nodes.length; r.restored!.requests += page.value.requests.length;
						r.after = { node: page.value.nodes.at(-1)?.id ?? r.after!.node, request: page.value.requests.at(-1)?.request_id ?? r.after!.request };
						this.flagFound(r, found);
						if (done) r.state = r.unresolved_count ? "unresolved" : "ready";
					});
				}
				return ok(r);
			}
			case "openRestore": {
				const r = this.recovery();
				if (!r) return fail("not_found", "no recovery is open");
				if (r.kind === "corpus") {
					if (r.state !== "ready") return fail("validation", `the recovery is ${r.state}; it opens only when ready`);
					const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", r.profile).toArray()[0];
					if (p?.status !== "active" || p.generation !== r.to) return fail("validation", "the profile changed during the corpus restore; abort it");
					return ok(this.endRecovery(r, "opened"));
				}
				if (r.state !== "ready" && r.state !== "opening") return fail("validation", `the recovery is ${r.state}; it opens only when ready`);
				const to = r.to!, who = { userId, profile: r.profile, generation: to }, stub = this.profileAt(who), started = Date.now();
				if (r.state === "ready") this.write((seq) => { Object.assign(r, { state: "opening", phase: r.deferred ? "precheck" : "index", deferred_next: 0, mark: seq, after: { node: "", request: "" } }); this.saveRecovery(r); });
				// The steps settlement and the owner's choices kept for the live profiles: checked, then run in order (abort never runs them).
				if (r.phase === "precheck" || r.phase === "deferred") {
					const d = await this.runDeferred(r, userId, () => Date.now() - started < 20_000);
					if (!d.ok || !d.value) return d.ok ? ok(r) : d;
					this.advance(r, () => Object.assign(r, { phase: "index" }));
				}
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
							// Step 5: a request whose node another profile owns keeps that owner's binding, rebuilt from its rows; it is never restamped here.
							const owner = q.node_id ? this.ownerOf(r, q.node_id) : undefined;
							if (owner && owner !== r.profile) { requests++; continue; }
							// A request held elsewhere comes here when this profile owns its node.
							if (q.node_id && this.sql.exec("SELECT 1 FROM node_index WHERE node_id = ? AND profile = ?", q.node_id, r.profile).toArray().length) {
								tx.run("UPDATE request_index SET profile = ?, op = ?, payload_hash = ?, at = ?, legacy = ?, seq = ? WHERE request_id = ? AND profile <> ? AND op <> 'wiped'",
									r.profile, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, q.legacy_hash ? 1 : 0, seq, q.request_id, r.profile);
							}
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
				// A point-in-time restore stays on its own generation; its record keeps the undo bookmark for a reversal.
				if (r.kind === "pitr") return ok(this.endRecovery(r, "opened"));
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
				if (r.kind === "corpus") {
					const who = { userId, profile: r.profile, generation: r.to! };
					await this.corpusAt(who).discardRestore(who, r.id);
					return ok(this.endRecovery(r, "aborted"));
				}
				if (r.kind === "pitr") {
					// A possible arm is settled first by a restart: either nothing applied and the recovery ends, or it did and is reversed.
					if (r.state === "arming" || r.state === "armed") {
						const waiting = await this.pitrStep(r, userId);
						if (r.state === "arming" || r.state === "armed") return waiting && !waiting.ok ? waiting : fail("busy", "the profile is still restarting; abort again shortly", { recovery: waiting?.ok ? waiting.value : r });
					}
					if (r.state === "requested") return ok(this.endRecovery(r, "aborted"));
					if (r.state !== "reverting") this.advance(r, () => Object.assign(r, { state: "reverting", armed: undefined, session: undefined }));
					return (await this.pitrStep(r, userId)) ?? ok(r);
				}
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
	private advance<T>(r: AccountRecovery | Recovery, fn: (tx: BudgetTx) => T): T {
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

	/** Ends a profile, point-in-time or corpus recovery in one transaction: the account reopens exactly when its record lands. */
	private endRecovery(r: Recovery, state: "opened" | "aborted"): Recovery & { state: string } {
		const end = { ...r, state, [`${state}_at`]: now() } as unknown as Recovery & { state: string }, before = JSON.stringify(r);
		this.write(() => {
			if (this.meta("recovery_state") !== before) throw Fail.of("busy", "the recovery moved; read its status");
			this.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'");
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}`, JSON.stringify(end));
		});
		return end;
	}

	/**
	 * The point-in-time restore's own steps (section 18). Arm through the profile, which records the fallback bookmark here before
	 * it arms anything, then confirm through a later session whether the storage went back. Nothing assumes that a pending restore
	 * can be cancelled: a restart that did not apply it withdraws the arm, and the next step arms again the same documented way.
	 * Null once a forward restore is in place and settlement may run; any other value is this step's answer, with the account
	 * still closed. A reversal closes the recovery as aborted once the undo bookmark is in place.
	 */
	private async pitrStep(r: Recovery, userId: string): Promise<Outcome<unknown> | null> {
		const who = { userId, profile: r.profile, generation: r.from }, stub = this.profileAt(who);
		const reverting = r.state === "reverting", tag = reverting ? `${r.id}:revert` : r.id;
		const reload = () => { const cur = this.recovery(); if (cur?.id !== r.id) return false; Object.assign(r, cur); return true; };
		if (r.state === "requested" || (reverting && r.armed !== tag)) {
			const target = reverting ? { bookmark: (r.undo ?? r.fallback)! } : r.reverses ? { bookmark: r.bookmark! } : { at: r.target_at! };
			let armed: Outcome<null> | undefined;
			// A recorded arm ends this RPC with the documented abort, so an error here is expected; the recovery says what landed.
			try { armed = await stub.pitrArm(who, { id: r.id, tag, ...target }); } catch { armed = undefined; }
			if (!reload()) return fail("busy", "the recovery changed; read its status");
			if (r.armed !== tag) return armed && !armed.ok ? armed : fail("unavailable", "the profile did not record its fallback bookmark; nothing was armed; step again");
		}
		if (r.state !== "arming" && r.state !== "armed" && r.state !== "reverting") return null;
		let c: Outcome<{ restarted: boolean; restored: boolean; done: boolean }>;
		// In the arming session the check aborts, which is the documented restart; an error here is that restart.
		try { c = await stub.pitrCheck(who, tag, r.session!, !reverting); } catch { c = ok({ restarted: false, restored: false, done: false }); }
		if (!c.ok) return c;
		if (!c.value.restarted) return ok({ ...r, waiting: "the profile is restarting; step again" });
		if (!c.value.restored) {
			// That restart applied nothing, so nothing is pending: withdraw the arm and let the next step arm again.
			this.advance(r, () => Object.assign(r, { armed: undefined, session: undefined, rearmed: (r.rearmed ?? 0) + 1 },
				reverting ? { revert_fallback: undefined, revert_bookmark: undefined, revert_undo: undefined }
					: { state: "requested", fallback: undefined, undo: undefined, ...(r.reverses ? {} : { bookmark: undefined }) }));
			return ok({ ...r, waiting: "the armed bookmark did not apply at the restart; step again to arm it again" });
		}
		if (!c.value.done) return ok({ ...r, progress: "embeddings due again" });
		if (reverting) return ok(this.endRecovery(r, "aborted"));
		// The platform's undo if it was recorded, else the fallback taken just before arming, with no write between them.
		this.advance(r, () => Object.assign(r, { state: "settling", settle: { i: 0, after: "" }, settled: 0, undo: r.undo ?? r.fallback, undo_from: r.undo ? "platform" : "fallback" }));
		return null;
	}

	/** A corpus restore (section 18): it owns no records, so after its verified apply it is ready; open rechecks the profile. */
	private async corpusStep(r: Recovery, userId: string): Promise<Outcome<unknown>> {
		if (r.state !== "restoring") return ok(r);
		const who = { userId, profile: r.profile, generation: r.to! };
		const s = await this.corpusAt(who).restoreStep(who, { id: r.id, exportId: r.export });
		if (!s.ok) return s;
		if (!s.value.done) return ok({ ...r, progress: s.value });
		this.advance(r, () => Object.assign(r, { state: "ready" }));
		return ok(r);
	}

	/**
	 * Settlement (section 18, step 4) of every transfer a restore may have split. A profile or point-in-time restore of P reads all
	 * of P's transfer rows, the other profiles' rows that name P or are unfinished, and the account's rows for P that are open or
	 * newer than the restored point; an account restore reads every profile's unfinished rows and the account's open or newer ones.
	 * Each id is settled from both profiles' own facts by settleRule, target first and source last, as the transfer driver does.
	 * A wiped id is left to its tombstone, and a pair the rules do not settle is a finding that keeps the account closed.
	 */
	private async settleTransfers(r: Recovery | AccountRecovery, userId: string, live: () => boolean): Promise<Outcome<null>> {
		const account = "kind" in r && r.kind === "account", restored = account ? null : (r as Recovery).profile;
		const names = this.sql.exec<{ name: string }>("SELECT name FROM profiles WHERE status = 'active' ORDER BY name").toArray().map((p) => p.name);
		const lists = restored ? [restored, ...names.filter((n) => n !== restored)] : names;
		const cutoff = account ? (r as AccountRecovery).export_at : (r as Recovery).export_at;
		while (r.settle && live()) {
			const { i, after } = r.settle;
			let items: { id: string; node: string; from: string; to: string }[];
			if (i < lists.length) {
				const name = lists[i]!, generation = this.settleGeneration(r, name);
				const ref = { userId, profile: name, generation: generation ?? "" };
				const page = generation ? await this.profileAt(ref).settleScan(ref, { after, peer: restored && name !== restored ? restored : null, all: name === restored }) : ok([]);
				if (!page.ok) return page;
				items = page.value.map((t) => ({ id: t.id, node: t.node_id, from: t.direction === "out" ? name : t.peer, to: t.direction === "out" ? t.peer : name }));
			} else if (i === lists.length) {
				items = this.sql.exec<{ id: string; node_id: string; from_profile: string; to_profile: string }>(`SELECT id, node_id, from_profile, to_profile FROM transfers WHERE id > ?
					AND (? IS NULL OR from_profile = ? OR to_profile = ?) AND (completed_at IS NULL OR retry_at IS NOT NULL OR completed_at > ? OR created_at > ?) ORDER BY id LIMIT 50`,
					after, restored, restored, restored, cutoff, cutoff).toArray().map((t) => ({ id: t.id, node: t.node_id, from: t.from_profile, to: t.to_profile }));
			} else {
				this.advance(r, () => Object.assign(r, account ? { settle: undefined, phase: "index", after: { profile: "", node: "", request: "", done: true } }
					: { settle: undefined, state: "checking", after: { node: "", request: "" }, restored: { nodes: 0, requests: 0 } }));
				break;
			}
			for (const t of items) {
				if (!live()) return ok(null);
				const done = await this.settleOne(r, userId, t);
				if (!done.ok) return done;
				if (!done.value) return ok(null); // a bounded action is unfinished; the next step repeats it
				if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status");
			}
			if (items.length < 50 && live()) this.advance(r, () => Object.assign(r, { settle: { i: i + 1, after: "" } }));
		}
		return ok(null);
	}

	/** One transfer id by the fixed rules; true once settled or flagged, with the cursor moved past it in the same write. */
	/**
	 * The owner's read of the open recovery's copy conflicts (section 18, step 4): up to 20 after `after`, each with both copies
	 * as each profile holds them now, at the generation this recovery reads. Read only.
	 */
	private async recoveryConflicts(userId: string, cmd: Extract<AccountCommand, { op: "recoveryConflicts" }>): Promise<Outcome<unknown>> {
		const r = this.recovery() as Recovery | AccountRecovery | undefined;
		if (!r || r.id !== cmd.id) return fail("busy", "the recovery changed since it was shown; read its status", { reason: "recovery_changed" });
		const prefix = `restore:${r.id}:conflict:`;
		const rows = this.sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key > ? AND key < ? ORDER BY key LIMIT 21", prefix + (cmd.after ?? ""), `${prefix}￿`).toArray();
		const conflicts = [];
		for (const row of rows.slice(0, 20)) {
			const c = JSON.parse(row.value) as RecoveryConflict;
			const copies = [];
			for (const profile of c.profiles) {
				const generation = this.settleGeneration(r, profile) ?? null, ref = { userId, profile, generation: generation ?? "" };
				const copy = generation ? await this.profileAt(ref).recoveryCopy(ref, c.node, this.termsFor(profile)) : ok(null);
				if (!copy.ok) return copy;
				// Keepable: published, and for a moved copy, restorable whole from its archive under the current guard.
				copies.push({ profile, generation, copy: copy.value, keepable: !!copy.value && copy.value.status !== "incoming" && (copy.value.status !== "moved" || copy.value.restorable?.ok === true) });
			}
			const resume = c.state === "resolving" && c.request_id && c.keep && c.expect
				? { id: r.id, node: c.node, keep: c.keep, expect: c.expect, request_id: c.request_id } : null;
			conflicts.push({ node: c.node, kind: c.kind, transfer: c.transfer, state: c.state, ...(c.keep ? { keep: c.keep } : {}), ...(c.result ? { result: c.result } : {}), ...(resume ? { resume } : {}), copies });
		}
		if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status", { reason: "recovery_changed" });
		return ok({ recovery: r.id, state: r.state, open: r.conflicts?.open ?? 0, conflicts, next: rows.length > 20 ? conflicts.at(-1)!.node : null });
	}

	/**
	 * The owner's read of where one request id sits for the open recovery: each active profile's row (its node and that node's
	 * status there, its op, and labels that say which hashes are equal), the account's binding, each node's owner, decision and
	 * wipe mark, and what the nodes-then-requests rebuild would bind and flag. Read only; no payloads, hashes or contents.
	 */
	private async requestPlacement(userId: string, r: Recovery | AccountRecovery, id: string): Promise<Outcome<Placement>> {
		// The request id domain every writer accepts: 1 to 256 characters, any text SQLite stores as it is.
		if (id.length < 1 || id.length > 256 || !id.isWellFormed()) return fail("validation", "request_id must be 1 to 256 characters of well-formed text");
		const below = cursorBelow(id);
		const labels = new Map<string, string>(), label = (h: string | null | undefined) => {
			if (!h) return null;
			if (!labels.has(h)) labels.set(h, `h${labels.size + 1}`);
			return labels.get(h)!;
		};
		const names = this.sql.exec<{ name: string }>("SELECT name FROM profiles WHERE status = 'active' ORDER BY name").toArray().map((p) => p.name);
		const rows: { profile: string; q?: RestoredPage["requests"][number]; present: boolean | null }[] = [];
		for (const profile of names) {
			const generation = this.settleGeneration(r, profile);
			if (!generation) { rows.push({ profile, present: null }); continue; }
			const who = { userId, profile, generation };
			const page = await this.profileAt(who).restoredPage(who, { node: "\u{10FFFF}", request: below });
			if (!page.ok) return page;
			// Nothing a profile can hold sorts between the cursor and the id, so the first row is the id or it is absent.
			const q = page.value.requests[0]?.request_id === id ? page.value.requests[0] : undefined;
			rows.push({ profile, q, present: !!q });
		}
		if (this.recovery()?.id !== r.id) return fail("busy", "the recovery changed; read its status", { reason: "recovery_changed" });
		const bound = this.sql.exec<{ profile: string; op: string; payload_hash: string; legacy: number }>("SELECT profile, op, payload_hash, legacy FROM request_index WHERE request_id = ?", id).toArray()[0];
		const profiles = rows.map(({ profile, q, present }) => ({ profile, present, ...(q ? { node_id: q.node_id, node_status: q.node_status, op: boundOp(q),
			legacy: !!q.legacy_hash, payload: label(q.payload_hash), legacy_payload: label(q.legacy_hash), bound_payload: label(q.legacy_hash ?? q.payload_hash) } : {}) }));
		const binding = bound ? { profile: bound.profile, op: bound.op, legacy: bound.legacy === 1, payload: bound.op === "wiped" ? null : label(bound.payload_hash) } : null;
		// The rebuild's held pass: the first profile, in name order, that archived the node; a second, or a live owner elsewhere, flags.
		let flags = false;
		const heldBy = (node: string) => {
			let held = this.ownerOf(r, node);
			for (const { profile, q } of rows) {
				if (!q || q.node_id !== node || !this.archivedHere(r, q)) continue;
				if (!held) held = profile; else if (held !== profile) flags = true;
			}
			return held;
		};
		const nodes = [...new Set(rows.map((x) => x.q?.node_id).filter((n): n is string => !!n))].slice(0, 10).map((node) => ({ node_id: node,
			index: this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", node).toArray()[0]?.profile ?? null,
			decided: this.decidedOf(r, node) ?? null, owner: this.ownerOf(r, node) ?? null, held: heldBy(node) ?? null, wiped: !!this.meta(`wiped:${node}`) }));
		// The rebuild's request pass against those owners and today's binding, profile by profile in name order.
		let would = bound && bound.op !== "wiped" ? bound.profile : undefined;
		for (const { profile, q } of rows) {
			if (!q || bound?.op === "wiped") continue;
			const held = q.node_id ? nodes.find((n) => n.node_id === q.node_id)?.held ?? undefined : undefined;
			const owner = held ?? (q.node_status && q.node_status !== "moved" && q.node_status !== "incoming" ? profile : undefined);
			if (would && would !== profile) { if (owner === profile) would = profile; else if (owner !== would) flags = true; }
			else if (!would && [undefined, profile].includes(owner)) would = profile;
		}
		const finding = r.unresolved.some((f) => f.kind === "request_elsewhere" && f.id === id);
		return ok({ recovery: r.id, state: r.state, request_id: id, finding, profiles, binding, nodes,
			rebuild: { binds: bound?.op === "wiped" ? bound.profile : would ?? null, flags } });
	}

	/**
	 * The owner's continuation of an unresolved account restore whose only findings are `request_elsewhere`, each proven stale
	 * by its placement: every profile answered, one identical request on one unwiped node, the account binding already on that
	 * node's live owner with the same op, legacy flag and hash, and the nodes-then-requests rebuild binding it there unflagged.
	 * Then only the index rebuild runs again, against today's indexes; earlier phases, decisions and kept steps stay as they are,
	 * and any finding it makes keeps the account closed. Anything else is refused with its reason and nothing changes.
	 */
	private async recheckRequests(userId: string, cmd: Extract<AccountCommand, { op: "recheckRequests" }>): Promise<Outcome<unknown>> {
		const r = this.accountRecovery();
		if (!r || r.id !== cmd.id) return fail("busy", "the recovery changed since it was shown; read its status", { reason: "recovery_changed" });
		if (r.state !== "unresolved" || r.phase) return fail("validation", `the account restore is ${r.state}; only an unresolved one is rechecked`, { reason: "not_unresolved" });
		if (r.resolving || (r.conflicts?.open ?? 0) > 0) return fail("validation", "finish the open copy choices first", { reason: "conflicts_open" });
		if (r.unresolved_count !== r.unresolved.length || r.unresolved.some((f) => f.kind !== "request_elsewhere")) {
			return fail("validation", "only an account restore whose findings are all request_elsewhere is rechecked", { reason: "other_findings" });
		}
		const ids = [...new Set(r.unresolved.map((f) => f.id))].sort();
		if (canonicalJson([...new Set(cmd.request_ids)].sort()) !== canonicalJson(ids)) return fail("busy", "the findings changed since they were shown; read the status", { reason: "findings_changed" });
		for (const id of ids) {
			const p = await this.requestPlacement(userId, r, id);
			if (!p.ok) return p;
			const why = staleWhy(p.value);
			if (why) return fail("validation", `request ${id} is not shown stale (${why}); keep the restore closed, or abort it`, { reason: why, request_id: id });
		}
		// advance refuses if the recovery moved during the reads above.
		this.advance(r, () => Object.assign(r, { state: "reconciling", phase: "index", after: { profile: "", node: "", request: "", done: true },
			unresolved: [], unresolved_count: 0, rechecks: [...(r.rechecks ?? []), { at: now(), findings: r.unresolved }].slice(-5) }));
		return ok(r);
	}

	/**
	 * The owner keeps one copy of a conflict (section 18, step 4); the other becomes a flagged tombstone, with its content and
	 * history in that profile's archive. Only while the recovery is unresolved, only for copies exactly as the owner saw them
	 * (generation, status and revision), and one choice at a time. `request_id` makes it replayable: the same request continues an
	 * unfinished choice or returns its stored result; other arguments under it are refused. Steps on live profiles of a profile or
	 * point-in-time restore run at open, like settlement's. When every finding was an owner choice and all are made,
	 * reconciliation runs again from settlement.
	 */
	private async resolveConflict(userId: string, cmd: Extract<AccountCommand, { op: "resolveConflict" }>): Promise<Outcome<unknown>> {
		const r = this.recovery() as Recovery | AccountRecovery | undefined;
		if (!r || r.id !== cmd.id) return fail("busy", "the recovery changed since it was shown; read its status", { reason: "recovery_changed" });
		const key = `restore:${r.id}:conflict:${cmd.node}`, payload = sha256(canonicalJson({ node: cmd.node, keep: cmd.keep, expect: cmd.expect }));
		const found = this.conflictOf(r, cmd.node);
		if (!found) return fail("not_found", "this recovery has no conflict for that record");
		const requestKey = `restore:${r.id}:choice_request:${sha256(cmd.request_id)}`, bound = this.meta(requestKey);
		if (bound && bound !== payload) return fail("idempotency_mismatch", "this request id is bound to another recovery choice payload");
		if (!bound) this.write(() => this.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, ?)", requestKey, payload));
		let c: RecoveryConflict = found;
		if (c.state === "resolved") {
			if (c.request_id === cmd.request_id) return c.payload === payload ? ok(c.result) : fail("idempotency_mismatch", "this request id resolved the conflict with other arguments");
			return fail("validation", "the owner already chose a copy", { reason: "already_resolved", result: c.result });
		}
		if (r.state !== "unresolved") return fail("validation", `the recovery is ${r.state}; copies are chosen only while it is unresolved`, { reason: "not_unresolved" });
		if (c.state === "resolving") {
			if (c.request_id !== cmd.request_id) return fail("busy", "another choice for this record is unfinished; repeat it with its request id", { reason: "resolving", request_id: c.request_id });
			if (c.payload !== payload) return fail("idempotency_mismatch", "this request id is choosing with other arguments");
		} else {
			if (r.resolving && r.resolving !== cmd.node) return fail("busy", "another choice is unfinished; finish it first", { reason: "resolving", node: r.resolving });
			if (!c.profiles.includes(cmd.keep)) return fail("validation", "keep one of the two profiles holding a copy");
			// The copies exactly as the owner saw them; anything else is a changed state the owner has not seen.
			const now: Record<string, { generation: string | null; copy: RecoveryCopy | null }> = {};
			for (const profile of c.profiles) {
				const generation = this.settleGeneration(r, profile) ?? null, ref = { userId, profile, generation: generation ?? "" };
				const copy = generation ? await this.profileAt(ref).recoveryCopy(ref, cmd.node, this.termsFor(profile)) : ok(null);
				if (!copy.ok) return copy;
				now[profile] = { generation, copy: copy.value };
				const e = cmd.expect.find((x) => x.profile === profile);
				if (!e || e.generation !== generation || e.status !== (copy.value?.status ?? null) || e.revision !== (copy.value?.revision ?? null)) {
					return fail("busy", "a copy changed since it was shown; read the conflicts again", { reason: "copy_changed", profile });
				}
			}
			const lose = c.profiles.find((p) => p !== cmd.keep)!, w = now[cmd.keep]!.copy, l = now[lose]!.copy;
			if (!w || w.status === "incoming") return fail("validation", "only a published copy can be kept; keep the other copy, or abort the recovery", { reason: "not_keepable" });
			// A moved copy is kept only if its whole archived image comes back and passes the current guard (undoPreflight).
			if (w.status === "moved" && !w.restorable?.ok) return fail("validation", "this copy cannot be restored from its archive; keep the other copy, or abort the recovery",
				{ reason: "not_keepable", detail: w.restorable && !w.restorable.ok ? w.restorable.reason : "no_transfer" });
			const plan: RecoveryStep[] = [], touched = new Set<string>(c.transfer ? [c.transfer] : []);
			// Each unfinished local transfer row of the node ends: an outgoing fence is lifted, a published landing is settled, an
			// unpublished one is aborted. The kept copy's rows and its restore come first; the losing copy is tombstoned last.
			const end = (profile: string, rows: RecoveryCopy["rows"]) => {
				for (const row of rows) {
					touched.add(row.id);
					if (row.direction === "out") plan.push({ profile, action: "abort_out", id: row.id, nodeId: cmd.node, peer: row.peer });
					else plan.push({ profile, action: row.state === "published" ? "settle_in" : "abort_in", id: row.id, nodeId: cmd.node, peer: row.peer });
				}
			};
			end(cmd.keep, w.rows);
			if (w.status === "moved") plan.push({ profile: cmd.keep, action: "undo_move", id: w.transfer!, nodeId: cmd.node, peer: lose });
			if (l) end(lose, l.rows);
			if (l && l.status !== "incoming" && l.status !== "moved") {
				// The losing copy is tombstoned under this choice's own identity, by the transfer commit: content and history go to its archive.
				const id = `recovery-${r.id}-${cmd.node}`;
				plan.push({ profile: lose, action: "tombstone_out", id, nodeId: cmd.node, peer: cmd.keep, identity: { id, sha256: sha256(`${r.id}:${cmd.node}:${cmd.keep}`), revision: l.revision } });
				plan.push({ profile: lose, action: "flag_tombstone", id, nodeId: cmd.node, peer: cmd.keep, flag: `recovery ${r.id}: the owner kept the copy in ${cmd.keep}` });
			}
			// The account's rows for those transfers end with the choice: committed where the kept profile was the target, else aborted.
			const transfers = [...touched].flatMap((id) => this.sql.exec<{ to_profile: string }>("SELECT to_profile FROM transfers WHERE id = ?", id).toArray()
				.map((t) => ({ id, state: t.to_profile === cmd.keep ? "committed" as const : "aborted" as const })));
			plan.push({ profile: null, node: cmd.node, owner: cmd.keep, transfers });
			for (const step of plan) {
				const pre = await this.preflight(r, userId, step);
				if (!pre.ok) return pre.error.code === "busy" || pre.error.code === "unavailable" ? pre : fail("validation", "this copy cannot be restored from its archive; keep the other copy, or abort the recovery", { reason: "not_keepable", detail: pre.error.details?.reason ?? pre.error.code });
			}
			c = { ...c, state: "resolving", request_id: cmd.request_id, payload, keep: cmd.keep, expect: cmd.expect, plan, next: 0 };
			const chosen = c;
			this.advance(r, () => { this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", key, JSON.stringify(chosen)); r.resolving = cmd.node; });
		}
		const started = Date.now();
		while (c.next! < c.plan!.length) {
			if (Date.now() - started > 20_000) return ok({ ...c, progress: `${c.next} of ${c.plan!.length} steps; repeat with the same request id` });
			const x = await this.runStep(r, userId, c.plan![c.next!]!);
			// The choice stays unfinished and the account closed; the same request id continues it.
			if (!x.ok) return x;
			if (!x.value) continue;
			const moved: RecoveryConflict = { ...c, next: c.next! + 1 };
			this.advance(r, () => this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", key, JSON.stringify(moved)));
			c = moved;
		}
		const result = { node: cmd.node, kept: cmd.keep, tombstoned: c.profiles.find((p) => p !== cmd.keep)!, recovery: r.id };
		const done: RecoveryConflict = { ...c, state: "resolved", result };
		this.advance(r, () => {
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", key, JSON.stringify(done));
			r.resolving = undefined;
			r.conflicts = { total: r.conflicts?.total ?? 0, open: Math.max(0, (r.conflicts?.open ?? 1) - 1) };
			// The last open choice is made: reconciliation runs again from the start, against the planned state, and keeps only the
			// findings that are still current. Settlement skips chosen nodes; the checks read the decided owners.
			if (r.conflicts.open === 0) {
				const again = { settle: { i: 0, after: "" }, settled: 0, unresolved: [], unresolved_count: 0, conflicts: undefined };
				if ("kind" in r && r.kind === "account") Object.assign(r, again, { state: "reconciling", phase: "ledger", last: undefined, after: undefined });
				else Object.assign(r, again, { state: "settling", after: undefined, restored: undefined });
			}
		});
		return ok(result);
	}

	/**
	 * The owner's earlier choice that a `recovery-<recovery>-<node>` transfer id stands for, trusted only through the account's own
	 * durable records: that recovery opened, and its conflict for this node is resolved. Any other id is an ordinary transfer.
	 */
	private trustedChoice(transfer: string | null | undefined, node: string): { keep: string; lose: string } | undefined {
		const m = /^recovery-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/.exec(transfer ?? "");
		if (!m || m[2] !== node) return undefined;
		const done = JSON.parse(this.meta(`restore:${m[1]}`) ?? "null") as { state?: string } | null;
		const c = JSON.parse(this.meta(`restore:${m[1]}:conflict:${node}`) ?? "null") as RecoveryConflict | null;
		if (done?.state !== "opened" || c?.state !== "resolved" || !c.keep || !c.profiles.includes(c.keep)) return undefined;
		return { keep: c.keep, lose: c.profiles.find((p) => p !== c.keep)! };
	}

	/** The restored profile of a profile or point-in-time restore; null for an account restore, whose profiles are all live. */
	private restoredOf(r: Recovery | AccountRecovery): string | null {
		return "kind" in r && r.kind === "account" ? null : (r as Recovery).profile;
	}
	private conflictOf(r: Recovery | AccountRecovery, node: string): RecoveryConflict | undefined {
		const raw = this.meta(`restore:${r.id}:conflict:${node}`);
		return raw ? JSON.parse(raw) as RecoveryConflict : undefined;
	}
	/** The owner this recovery decided for a node, kept for open: a profile, "" when it decided that no profile holds it, or undefined. */
	private decidedOf(r: Recovery | AccountRecovery, node: string): string | undefined {
		return this.meta(`restore:${r.id}:owner:${node}`);
	}
	/** The owner a node will have: the one this recovery decided, else the live index. One rule for every check and for open. */
	private ownerOf(r: Recovery | AccountRecovery, node: string): string | undefined {
		const decided = this.decidedOf(r, node);
		if (decided !== undefined) return decided || undefined;
		return this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", node).toArray()[0]?.profile;
	}
	/** Whether this recovery planned a terminal state for a transfer: the account's row, or one profile's own row. */
	private planned(r: Recovery | AccountRecovery, transfer: string, profile?: string): boolean {
		return this.meta(profile === undefined ? `restore:${r.id}:xfer:${transfer}` : `restore:${r.id}:local:${profile}:${transfer}`) !== undefined;
	}
	/** The account's current sensitive terms, for a record restored into me (section 5); none elsewhere. */
	private termsFor(profile: string): string[] {
		return profile === "me" ? this.sql.exec<{ term: string }>("SELECT term FROM sensitive_terms").toArray().map((t) => t.term) : [];
	}

	/** Inside a write: records findings; a copy conflict also gets, or reopens, its durable record for the owner's choice. */
	private flagFound(r: Recovery | AccountRecovery, found: Finding[]): void {
		flag(r, found.map(({ kind, id, transfer }) => ({ kind, id, ...(transfer ? { transfer } : {}) })));
		for (const f of found) {
			if (!f.pair) continue;
			const prev = this.conflictOf(r, f.id);
			r.conflicts = { total: (r.conflicts?.total ?? 0) + 1, open: r.conflicts?.open ?? 0 };
			if (prev?.state === "open" || prev?.state === "resolving") continue;
			const c: RecoveryConflict = { node: f.id, kind: f.kind, transfer: f.transfer ?? null, profiles: f.pair, state: "open", at: now() };
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}:conflict:${f.id}`, JSON.stringify(c));
			r.conflicts.open++;
		}
	}

	/**
	 * The account's ownership write for one settled or chosen node: its transfer rows end as planned, node_index names the owner,
	 * and the node's request bindings are rebuilt from the owner's own request rows (step 5), never over a wipe's refusal.
	 */
	private async applyOwner(r: Recovery | AccountRecovery, userId: string, step: Extract<RecoveryStep, { profile: null }>): Promise<Outcome<true>> {
		this.advance(r, (tx) => {
			for (const t of step.transfers) tx.run("UPDATE transfers SET state = ?, completed_at = coalesce(completed_at, ?), retry_at = NULL, seq = ? WHERE id = ?", t.state, now(), tx.seq, t.id);
			if (step.owner) tx.run("INSERT OR REPLACE INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", step.node, step.owner, tx.seq);
		});
		const generation = step.owner ? this.settleGeneration(r, step.owner) : undefined;
		if (!step.owner || !generation) return ok(true);
		const ref = { userId, profile: step.owner, generation };
		for (let after = ""; ;) {
			const page = await this.profileAt(ref).nodeRequests(ref, step.node, after);
			if (!page.ok) return page;
			if (!page.value.length) return ok(true);
			this.advance(r, (tx) => {
				for (const q of page.value) tx.run(`INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy) VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (request_id) DO UPDATE SET profile = excluded.profile, op = excluded.op, payload_hash = excluded.payload_hash, at = excluded.at,
					legacy = excluded.legacy, seq = excluded.seq WHERE request_index.op <> 'wiped'`, q.request_id, step.owner!, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, tx.seq, q.legacy_hash ? 1 : 0);
			});
			after = page.value.at(-1)!.request_id;
		}
	}

	/**
	 * One step now, or kept for open. Nothing that abort cannot undo runs while the account is closed: a step on a live profile
	 * (every profile of an account restore, every profile but the restored one otherwise) and, for a profile or point-in-time
	 * restore, the account's own ownership write, are kept in order for open. Every step's planned result is recorded first, so the
	 * checks read the state the recovery will open with. True once done or kept; false when a bounded action is unfinished.
	 */
	private async runStep(r: Recovery | AccountRecovery, userId: string, step: RecoveryStep): Promise<Outcome<boolean>> {
		const restored = this.restoredOf(r), later = step.profile === null ? restored !== null : step.profile !== restored;
		this.advance(r, () => {
			if (step.profile === null) {
				this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}:owner:${step.node}`, step.owner ?? "");
				for (const t of step.transfers) this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}:xfer:${t.id}`, t.state);
			} else this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}:local:${step.profile}:${step.id}`, step.action);
			if (!later) return;
			const n = r.deferred ?? 0;
			this.sql.exec("INSERT OR REPLACE INTO account_meta (key, value) VALUES (?, ?)", `restore:${r.id}:defer:${String(n).padStart(6, "0")}`, JSON.stringify(step));
			r.deferred = n + 1;
		});
		if (later) return ok(true);
		return this.execStep(r, userId, step);
	}

	/** Runs one step now: the account's write, or the profile action in bounded steps with the current terms for me. */
	private async execStep(r: Recovery | AccountRecovery, userId: string, step: RecoveryStep): Promise<Outcome<boolean>> {
		if (step.profile === null) return this.applyOwner(r, userId, step);
		const generation = this.settleGeneration(r, step.profile);
		if (!generation) return fail("validation", `profile '${step.profile}' is not active`, { reason: "profile_closed" });
		const ref = { userId, profile: step.profile, generation };
		const x = await this.profileAt(ref).settleTransfer(ref, r.id, { action: step.action, id: step.id, nodeId: step.nodeId, peer: step.peer,
			...(step.identity ? { identity: step.identity } : {}), ...(step.flag ? { flag: step.flag } : {}), ...(step.action === "undo_move" ? { terms: this.termsFor(step.profile) } : {}) });
		return x.ok ? ok(x.value.done) : x;
	}

	/** Read only, before anything changes: whether an undo_move step can bring its whole record back, guard included. */
	private async preflight(r: Recovery | AccountRecovery, userId: string, step: RecoveryStep): Promise<Outcome<null>> {
		if (step.profile === null || step.action !== "undo_move") return ok(null);
		const generation = this.settleGeneration(r, step.profile);
		if (!generation) return fail("validation", `profile '${step.profile}' is not active`, { reason: "profile_closed" });
		const ref = { userId, profile: step.profile, generation };
		return this.profileAt(ref).undoPreflight(ref, { id: step.id, nodeId: step.nodeId, terms: this.termsFor(step.profile) });
	}

	/**
	 * Open's kept steps (both phases resumable): `precheck` checks every kept undo_move again, read only, and a refusal returns the
	 * recovery to unresolved, still abortable, with nothing run; `deferred` then runs them in order. True once all ran.
	 */
	private async runDeferred(r: Recovery | AccountRecovery, userId: string, live: () => boolean): Promise<Outcome<boolean>> {
		const at = (n: number) => JSON.parse(this.meta(`restore:${r.id}:defer:${String(n).padStart(6, "0")}`)!) as RecoveryStep;
		while (r.phase === "precheck" && live()) {
			const n = r.deferred_next ?? 0;
			if (n >= (r.deferred ?? 0)) { this.advance(r, () => Object.assign(r, { phase: "deferred", deferred_next: 0 })); break; }
			const step = at(n), pre = await this.preflight(r, userId, step);
			if (!pre.ok) {
				if (["busy", "unavailable"].includes(pre.error.code)) return pre;
				this.advance(r, () => {
					Object.assign(r, { state: "unresolved", phase: undefined, deferred_next: undefined });
					this.flagFound(r, [{ kind: "open_precheck_failed", id: step.profile === null ? step.node : step.nodeId }]);
				});
				return ok(false);
			}
			this.advance(r, () => { r.deferred_next = n + 1; });
		}
		while (r.phase === "deferred" && live()) {
			const n = r.deferred_next ?? 0;
			if (n >= (r.deferred ?? 0)) return ok(true);
			const x = await this.execStep(r, userId, at(n));
			// Every kept step was checked while closed; one refused now leaves the recovery opening, and open is repeated.
			if (!x.ok) return x;
			if (!x.value) return ok(false);
			this.advance(r, () => { r.deferred_next = n + 1; });
		}
		return ok(r.phase === "deferred" && (r.deferred_next ?? 0) >= (r.deferred ?? 0));
	}

	/** One transfer id by the fixed rules; true once settled or flagged, with the cursor moved past it in the same write. */
	private async settleOne(r: Recovery | AccountRecovery, userId: string, t: { id: string; node: string; from: string; to: string }): Promise<Outcome<boolean>> {
		const gs = this.settleGeneration(r, t.from), gt = this.settleGeneration(r, t.to);
		const passed = (found: Finding[] = []) => {
			this.advance(r, () => {
				this.flagFound(r, found);
				r.settle = { ...r.settle!, after: t.id };
				r.settled = (r.settled ?? 0) + 1;
			});
			return ok(true);
		};
		// A wipe tombstone wins (step 2), and a closed or unknown profile is never written: the rules need both sides' own rows.
		// A node the owner already chose a copy of in this recovery is settled by that choice.
		if (this.meta(`wiped:${t.node}`) || !gs || !gt || t.from === t.to || this.conflictOf(r, t.node)?.state === "resolved") return passed();
		const at = (profile: string, generation: string) => ({ userId, profile, generation });
		const facts = async (ref: ProfileRef, side: "out" | "in") => this.profileAt(ref).settleFacts(ref, { id: t.id, nodeId: t.node, side });
		const s = await facts(at(t.from, gs), "out"), d = await facts(at(t.to, gt), "in");
		if (!s.ok) return s;
		if (!d.ok) return d;
		// An owner's choice in an earlier, opened recovery settled this node; the fixed rules would not recognize its tombstone.
		const held = (n: SettleFacts["node"]) => !!n && n.status !== "incoming", live = (n: SettleFacts["node"]) => held(n) && n!.status !== "moved";
		const own = this.trustedChoice(t.id, t.node);
		if (own && own.lose === t.from && own.keep === t.to && held(d.value.node)) return passed();
		const sc = s.value.node?.status === "moved" ? this.trustedChoice(s.value.node.transfer, t.node) : undefined;
		if (sc && sc.lose === t.from && sc.keep === t.to && held(d.value.node)) return passed();
		const dc = d.value.node?.status === "moved" ? this.trustedChoice(d.value.node.transfer, t.node) : undefined;
		if (dc && dc.lose === t.to && dc.keep === t.from && live(s.value.node)) return passed();
		const plan = settleRule(t.id, s.value, d.value);
		const pair: Finding = { kind: "", id: t.node, transfer: t.id, pair: [t.from, t.to] };
		if (plan.unresolved) return passed([{ ...pair, kind: `transfer_${plan.unresolved}` }]);
		const steps: RecoveryStep[] = [
			...plan.target.map((action) => ({ profile: t.to, action, id: t.id, nodeId: t.node, peer: t.from })),
			...plan.source.map((action) => ({ profile: t.from, action, id: t.id, nodeId: t.node, peer: t.to, ...(action === "tombstone_out" && d.value.identity ? { identity: d.value.identity } : {}) }))];
		// Read only, before either side changes: an undo the rules need must be able to bring the whole record back.
		for (const step of steps) {
			const pre = await this.preflight(r, userId, step);
			if (!pre.ok) return ["busy", "unavailable"].includes(pre.error.code) ? pre : passed([{ ...pair, kind: "transfer_settle_failed" }]);
		}
		for (const step of steps) {
			const x = await this.runStep(r, userId, step);
			// A refusal is not retried: the pair stays an owner choice, and the account stays closed until it is made or the owner aborts.
			if (!x.ok) return ["busy", "unavailable"].includes(x.error.code) ? x : passed([{ ...pair, kind: "transfer_settle_failed" }]);
			if (!x.value) return ok(false);
		}
		if (!plan.owner) return passed();
		// The index names the owner where the record is once the plan has run, not where it was before: an undo or an unfence
		// leaves the source holding it, a commit or a tombstone does not. A transfer neither side ends up holding just ends aborted.
		const holds = plan.owner === "target" ? live(d.value.node) && !plan.target.includes("abort_in")
			: !!s.value.node && (plan.source.includes("undo_move") || plan.source.includes("abort_out")
				|| (live(s.value.node) && !plan.source.some((a) => a === "tombstone_out" || a === "commit_out")));
		const owned = await this.runStep(r, userId, { profile: null, node: t.node, owner: holds ? (plan.owner === "target" ? t.to : t.from) : null,
			transfers: [{ id: t.id, state: plan.owner === "target" ? "committed" : "aborted" }] });
		return owned.ok ? passed() : owned;
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
			if (r.state !== "ready" && r.state !== "opening") return fail("validation", `the account restore is ${r.state}; it opens only when ready`);
			// The profile steps kept while closed run only now: checked, then in order. Until then an abort undoes everything.
			if (r.state === "ready" && r.deferred) this.advance(r, () => Object.assign(r, { state: "opening", phase: "precheck", deferred_next: 0 }));
			if (r.state === "opening") {
				const begun = Date.now(), d = await this.runDeferred(r, userId, () => Date.now() - begun < 20_000);
				if (!d.ok || !d.value) return d.ok ? ok(r) : d;
			}
			return close("opened");
		}
		if (op === "abortRestore") {
			if (r.state === "opening") return fail("validation", "an opening account restore cannot be aborted; finish it with open");
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
				const last = r.last;
				this.advance(r, (tx) => {
					r.last = o.key;
					if (typeof plan?.profile !== "string" || typeof plan.wiped_at !== "string") return flag(r, [{ kind: "tombstone_unreadable", id: root }]);
					if (o.key === root) {
						// Retain content-free refusal identities, and revisit this tombstone until the bounded scrub is complete.
						if (scrubReview(this.sql, plan.profile, () => tx.seq, now())) { r.last = last; return; }
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
				if (r.last !== o.key) break; // a wiped origin's rows remain: list again from the same tombstone
			}
			if (!page.truncated && r.last === (page.objects.at(-1)?.key ?? r.last)) this.advance(r, () => Object.assign(r, { phase: "profiles", last: undefined }));
		}
		// Each profile at the generation the ledger marks active; a wiped or retired one is never reactivated, and anything else is a finding.
		if (r.phase === "profiles") this.advance(r, (tx) => {
			for (const p of this.sql.exec<{ name: string }>("SELECT name FROM profiles WHERE status IN ('wiping', 'wiped')").toArray()) {
				if (scrubReview(this.sql, p.name, () => tx.seq, now())) return;
			}
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
			Object.assign(r, { phase: "settle", settle: { i: 0, after: "" }, settled: 0 });
		});
		// Transfers by the fixed rules (step 4), from the profiles' own rows, before ownership is rebuilt from them.
		if (r.phase === "settle") {
			const s = await this.settleTransfers(r, userId, live);
			if (!s.ok) return s;
		}
		// Ownership from the active profiles' own rows (steps 3 and 5): the snapshot's node_index and request_index were not applied.
		// Three passes over the active profiles: their nodes; the nodes they archived, known only from their kept receipts; then
		// their requests. Step 5 then reads every final node owner whatever the profile order.
		while (r.phase === "index" && live()) {
			const a = r.after!, pass = a.pass, binding = pass === "requests";
			const p = this.sql.exec<{ name: string; generation: string }>(`SELECT name, generation FROM profiles WHERE status = 'active' AND name ${a.done ? ">" : "="} ? ORDER BY name LIMIT 1`, a.profile).toArray()[0];
			if (!p && !binding) {
				this.advance(r, () => { r.after = { profile: "", node: "", request: "", done: true, pass: pass ? "requests" : "held" }; });
				continue;
			}
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
				const found: Finding[] = [];
				if (!pass && !from.node) found.push(...this.openTransfers(r, p.name, page.value));
				// Each pass reads only its own list; the other list's cursor stays where it is.
				const pageNodes = pass ? [] : page.value.nodes, pageRequests = pass ? page.value.requests : [];
				let nodes = 0, requests = 0;
				for (const n of pageNodes) {
					if (tx.spent(0.5)) break;
					nodes++;
					const owner = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", n.id).toArray()[0]?.profile;
					const decided = this.decidedOf(r, n.id);
					if (this.meta(`wiped:${n.id}`)) found.push({ kind: "wiped_node", id: n.id });
					// Settled or chosen here: its kept steps run at open, and the planned owner is already indexed.
					else if (decided !== undefined) continue;
					else if (n.status === "incoming" || n.status === "moving") found.push({ kind: "transfer_state", id: n.id });
					else if (n.status === "moved") continue;
					else if (owner && owner !== p.name) found.push({ kind: "owned_elsewhere", id: n.id, pair: [owner, p.name] });
					else if (!owner) tx.run("INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", n.id, p.name, tx.seq);
				}
				if (pass === "held") for (const q of pageRequests) {
					if (tx.spent(0.5)) break;
					requests++;
					if (!this.archivedHere(r, q)) continue;
					// Indexed as the live account had it; an archived node another profile also holds keeps the account closed.
					const owner = this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", q.node_id).toArray()[0]?.profile;
					if (!owner) tx.run("INSERT INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", q.node_id, p.name, tx.seq);
					else if (owner !== p.name) found.push({ kind: "held_elsewhere", id: q.node_id });
				}
				if (binding && nodes === pageNodes.length) for (const q of pageRequests) {
					if (tx.spent(0.5)) break;
					requests++;
					const row = this.sql.exec<{ profile: string; op: string }>("SELECT profile, op FROM request_index WHERE request_id = ?", q.request_id).toArray()[0];
					if (row?.op === "wiped") continue; // a wipe's refusal stays
					if (row && row.profile !== p.name) {
						// Step 5: it goes with the profile that owns its node.
						const owner = this.requestOwner(r, q, p.name);
						if (owner === p.name) tx.run("UPDATE request_index SET profile = ?, op = ?, payload_hash = ?, at = ?, legacy = ?, seq = ? WHERE request_id = ? AND op <> 'wiped'",
							p.name, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, q.legacy_hash ? 1 : 0, tx.seq, q.request_id);
						else if (owner !== row.profile) found.push({ kind: "request_elsewhere", id: q.request_id });
					} else if (!row && [undefined, p.name].includes(this.requestOwner(r, q, p.name))) tx.run("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq, legacy) VALUES (?, ?, ?, ?, ?, ?, ?)",
						q.request_id, p.name, boundOp(q), q.legacy_hash ?? q.payload_hash, q.at, tx.seq, q.legacy_hash ? 1 : 0);
				}
				this.flagFound(r, found);
				const finished = nodes === pageNodes.length && requests === pageRequests.length && pageNodes.length < 200 && pageRequests.length < 200;
				r.after = { profile: p.name, node: pageNodes[nodes - 1]?.id ?? from.node, request: pageRequests[requests - 1]?.request_id ?? from.request, done: finished,
					...(pass ? { pass } : {}) };
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
			case "export": case "listExports": case "beginRestore": case "beginAccountRestore": case "beginPitr": case "beginCorpusRestore": case "restoreRecord":
			case "recoveryConflicts": case "recoveryRequest": case "recheckRequests": case "resolveConflict":
			case "restoreStatus": case "restoreStep": case "openRestore": case "abortRestore":
				return this.backup(cmd);
			case "beginDrill": case "drillStatus": case "drillStep": case "drillCleanup": {
				const userId = this.meta("user_id");
				if (!userId) return fail("unavailable", "the account is not set up");
				// The frozen public shape: the internal page and chunk cursors stay in drill_state.
				const view = (d: unknown) => { if (!d || typeof d !== "object" || !("request_id" in d)) return d; const { after: _a, account_next: _n, ...out } = d as Drill; return out; };
				try {
					const r = await this.drill(userId, cmd);
					if (!r.ok) return r;
					const v = r.value as Record<string, unknown>;
					return ok(cmd.op === "drillStatus" ? { drill: view(v.drill), last: view(v.last) } : view(v));
				} catch (e) {
					if (e instanceof Fail) return { ok: false, error: e.failure };
					return fail("unavailable", `the drill step did not finish: ${(e as Error).message}; step again`);
				}
			}
			case "wipeProfile": {
				const userId = this.meta("user_id");
				if (!userId) return fail("unavailable", "the account is not set up");
				if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
				// A drill's scratch copy of a profile would outlive the wipe: the wipe waits for its cleanup.
				if (this.drillOpen()) return fail("busy", "finish or clean up the restore drill first", { reason: "drill_open" });
				// The caller's generation, when sent, binds the wipe to the profile it showed; checked before any await or change.
				if (cmd.generation !== undefined && this.sql.exec<{ generation: string }>("SELECT generation FROM profiles WHERE name = ?", cmd.profile).toArray()[0]?.generation !== cmd.generation) {
					return fail("busy", "the profile changed since it was shown; read its status", { reason: "generation_changed" });
				}
				return wipeProfile(this.env, { ...wipePorts(this.env, this.ctx.storage), backups: (p) => this.replaceExports(p) }, { userId, kind: "owner", scopes: ["read", "write"], profiles: "*" }, cmd.profile, cmd.typed);
			}
			case "listProfiles":
				return ok(this.sql.exec("SELECT name, generation, status, created_at FROM profiles ORDER BY name").toArray());
			case "reviewOffer": {
				// Metadata lands only for an active origin at the generation the caller was granted, never me; an item's origin never changes,
				// and a wiped item stays wiped, so a re-offer of an old plan cannot bring wiped names back.
				if (cmd.origin) {
					const p = this.sql.exec<{ status: string; generation: string }>("SELECT status, generation FROM profiles WHERE name = ?", cmd.origin.profile).toArray()[0];
					if (cmd.origin.profile === "me" || !p || p.status !== "active" || p.generation !== cmd.origin.generation) return fail("profile_wiped", `profile '${cmd.origin.profile}' is not open for review items`, { reason: "origin_closed" });
				}
				const held = new Map(this.sql.exec<{ id: string; profile: string; state: string }>("SELECT id, profile, state FROM review_items WHERE id IN (SELECT value FROM json_each(?))",
					JSON.stringify(cmd.items.map((i) => i.id))).toArray().map((r) => [r.id, r]));
				for (const it of cmd.items) {
					const h = held.get(it.id);
					if (cmd.origin && it.profile !== cmd.origin.profile) return fail("validation", "every item must name the offered origin");
					if (h && h.profile !== it.profile) return fail("validation", `review item '${it.id}' belongs to another origin`, { reason: "origin_changed" });
					if (h?.state === "wiped") return fail("profile_wiped", `review item '${it.id}' was wiped`, { reason: "wiped" });
				}
				this.write((seq) => {
					const at = now();
					for (const it of cmd.items) this.sql.exec(`INSERT INTO review_items (id, kind, profile, state, payload, decision, created_at, updated_at, seq) VALUES (?, ?, ?, 'open', ?, NULL, ?, ?, ?)
						ON CONFLICT (id) DO UPDATE SET state = 'open', payload = excluded.payload, decision = NULL, updated_at = excluded.updated_at, seq = excluded.seq
						WHERE review_items.state = 'resolved' AND review_items.kind = 'collision'`, it.id, it.kind, it.profile, JSON.stringify(it.payload), at, at, seq);
				});
				return ok({ offered: cmd.items.length });
			}
			case "reviewList": {
				const rows = this.sql.exec<ReviewRow>(`SELECT id, kind, profile, state, payload, decision, created_at, updated_at FROM review_items
					WHERE id > ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR state = ?) AND state <> 'wiped' AND (? IS NULL OR json_extract(payload, '$.export_manifest_sha256') = ?)
						AND profile IN (SELECT name FROM profiles WHERE status = 'active')
						AND (kind <> 'collision' OR json_extract(payload, '$.from') IN (SELECT name FROM profiles WHERE status = 'active')) ORDER BY id LIMIT ?`,
					cmd.after ?? "", cmd.kind ?? null, cmd.kind ?? null, cmd.state ?? null, cmd.state ?? null, cmd.exportSha ?? null, cmd.exportSha ?? null, cmd.limit + 1).toArray();
				const page = rows.slice(0, cmd.limit);
				return ok({ items: page.map(reviewOut), next_after: rows.length > cmd.limit ? page.at(-1)!.id : null });
			}
			case "reviewAssign": case "reviewResolve": {
				const kind = cmd.op === "reviewAssign" ? "migration" : "collision";
				const r = this.sql.exec<ReviewRow>("SELECT id, kind, profile, state, payload, decision, created_at, updated_at FROM review_items WHERE id = ?", cmd.id).toArray()[0];
				if (!r || r.kind !== kind) return fail("not_found", `no ${kind} review item '${cmd.id}'`);
				// A closing or wiped origin takes no decision; its metadata is being or has been cleared.
				const open = (name: unknown) => this.sql.exec("SELECT 1 FROM profiles WHERE name = ? AND status = 'active'", String(name)).toArray().length > 0;
				if (r.state === "wiped" || !open(r.profile) || (kind === "collision" && !open((JSON.parse(r.payload) as { from?: string }).from))) return fail("profile_wiped", "this review item's profile is closed or wiped", { reason: "origin_closed" });
				// A resolved collision keeps its choice: a retry after a lost answer replays it; a different choice needs a new collision.
				if (r.state === "resolved") return ok(reviewOut(r));
				const decision = JSON.stringify(cmd.op === "reviewAssign" ? { profile: cmd.profile, at: now() } : { choice: cmd.choice, at: now() });
				const state = cmd.op === "reviewAssign" ? "assigned" : "resolved";
				// The same assignment again changes nothing, so a retry replays it; another profile replaces it until the plan uses it.
				if (cmd.op === "reviewAssign" && r.decision && (JSON.parse(r.decision) as { profile: string }).profile === cmd.profile) return ok(reviewOut(r));
				this.write((seq) => this.sql.exec("UPDATE review_items SET state = ?, decision = ?, updated_at = ?, seq = ? WHERE id = ?", state, decision, now(), seq, cmd.id));
				return ok(reviewOut(this.sql.exec<ReviewRow>("SELECT id, kind, profile, state, payload, decision, created_at, updated_at FROM review_items WHERE id = ?", cmd.id).one()));
			}
			case "wipePlan": {
				// Read only, through the wipe engine's own target and term rules; its own profile is left out, as the preview is of the rest.
				const userId = this.meta("user_id");
				if (!userId) return fail("unavailable", "the account is not set up");
				if (this.meta("recovery_state")) return fail("busy", "account is closed for recovery");
				const p = this.sql.exec<{ generation: string; status: string }>("SELECT generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
				if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
				return ok({ profile: cmd.profile, generation: p.generation, status: p.status, targets: wipeRefs(this.sql, cmd.profile, userId).filter((r) => r.profile !== cmd.profile),
					terms: wipeTerms(this.sql, cmd.profile) });
			}
			case "wipeStatus": {
				// Read only: the profile's state and its latest wipe record, if any, as the wipe engine stored them.
				const p = this.sql.exec<{ name: string; generation: string; status: string }>("SELECT name, generation, status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
				if (!p) return fail("not_found", `unknown profile '${cmd.profile}'`);
				const w = this.sql.exec<{ wiped_at: string; generations: string; report: string }>("SELECT wiped_at, generations, report FROM wipes WHERE profile = ? ORDER BY wiped_at DESC LIMIT 1", cmd.profile).toArray()[0];
				const report = w ? JSON.parse(w.report) as Record<string, unknown> : null;
				return ok({ profile: p.name, generation: p.generation, status: p.status, wipe: w ? { started_at: w.wiped_at, generations: (JSON.parse(w.generations) as string[]).length,
					state: report?.state ?? null, purged: report?.purged ?? null, redacted: report?.redacted ?? null } : null });
			}
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
