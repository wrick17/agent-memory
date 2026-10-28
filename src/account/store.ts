// AccountStore: one per user. Devices, routing rules, the profile registry, node_index, request_index (section 5).
import { DurableObject } from "cloudflare:workers";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { randomBase32, sha256 } from "../domain/ids";
import { fail, ok, PROFILE_NAME, PROFILES, SCOPES, type Caller, type Outcome, type ProfileRef, type RoutingRule, type Scope } from "../domain/types";
import { migrate, nextSeq } from "../storage";
import { ACCOUNT_MIGRATIONS } from "./schema";

export type Principal = { kind: "owner"; userId: string; device?: string } | { kind: "device"; id: string; secret: string };

export interface AccountContext { caller: Caller; rules: RoutingRule[]; profiles: ProfileRef[]; known: string[]; sensitiveTerms: string[] }

export type AccountCommand =
	| { op: "listDevices" }
	| { op: "createDevice"; name: string; scopes: Scope[]; profiles: string[]; defaultProfile?: string; expiresAt?: string; oauth?: boolean }
	| { op: "revokeDevice"; id: string }
	| { op: "setDeviceDefault"; id: string; defaultProfile: string | null }
	| { op: "setRules"; rules: Omit<RoutingRule, "id">[] }
	| { op: "addSensitiveTerm"; term: string }
	| { op: "listProfiles" };

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

	/**
	 * Binds a request_id to the profile and payload hash of its first use, or returns the existing binding.
	 * With `profile: null` it only looks up. A changed payload is refused before any write.
	 */
	async bindRequest(r: { requestId: string; profile: string | null; op: string; payloadHash: string }): Promise<Outcome<{ profile: string | null; existing: boolean }>> {
		const row = this.sql.exec<{ profile: string; op: string; payload_hash: string }>("SELECT profile, op, payload_hash FROM request_index WHERE request_id = ?", r.requestId).toArray()[0];
		if (row) {
			if (row.payload_hash !== r.payloadHash || row.op !== r.op) {
				return fail("idempotency_mismatch", `request_id '${r.requestId}' was already used with different arguments`, { request_id: r.requestId });
			}
			return ok({ profile: row.profile, existing: true });
		}
		if (!r.profile) return ok({ profile: null, existing: false });
		this.write((seq) => this.sql.exec("INSERT INTO request_index (request_id, profile, op, payload_hash, at, seq) VALUES (?, ?, ?, ?, ?, ?)",
			r.requestId, r.profile, r.op, r.payloadHash, now(), seq));
		return ok({ profile: r.profile, existing: false });
	}

	/** Drops a binding this request created when the profile refused the write, so a corrected retry is not refused (BothQ rolls its request node back). */
	async releaseRequest(requestId: string, payloadHash: string): Promise<void> {
		this.write(() => this.sql.exec("DELETE FROM request_index WHERE request_id = ? AND payload_hash = ?", requestId, payloadHash));
	}

	async recordNodes(profile: string, ids: string[]): Promise<void> {
		if (!ids.length) return;
		this.write((seq) => { for (const id of ids) this.sql.exec("INSERT OR REPLACE INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", id, profile, seq); });
	}

	async resolveNode(id: string): Promise<string | null> {
		return this.sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", id).toArray()[0]?.profile ?? null;
	}

	/** Daily embedding budget: pauses embedding past 8,000 neurons, the free daily allotment. */
	async meter(m: { day: string; neurons: number }): Promise<{ embed: boolean }> {
		const row = this.write(() => this.sql.exec<{ value: number }>(
			`INSERT INTO counters (day, name, value) VALUES (?, 'neurons', ?)
			 ON CONFLICT (day, name) DO UPDATE SET value = value + excluded.value RETURNING value`, m.day, Math.ceil(m.neurons)).one());
		return { embed: row.value < DAILY_NEURONS };
	}

	/** Owner-only administration, reached only through the dashboard API. */
	async admin(cmd: AccountCommand): Promise<Outcome<unknown>> {
		const known = this.sql.exec<{ name: string }>("SELECT name FROM profiles").toArray().map((r) => r.name);
		switch (cmd.op) {
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
				return ok({ rules: cmd.rules.length });
			}
			case "addSensitiveTerm": {
				const term = cmd.term.trim();
				if (term.length < 2 || term.length > 200) return fail("validation", "a sensitive term is 2 to 200 characters");
				this.write((seq) => this.sql.exec("INSERT OR REPLACE INTO sensitive_terms (term, source, updated_at, seq) VALUES (?, 'owner', ?, ?)", term, now(), seq));
				return ok({ term });
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

/** Org names from the remote rules that point at `work` (for example `Sequoia-Engineering`), as `me` guard terms. */
function orgTerms(rules: RoutingRule[]): string[] {
	return rules.filter((r) => r.profile === "work" && r.match === "remote")
		.map((r) => r.pattern.split("/")[1] ?? "").filter((org) => org && !org.includes("*"));
}
