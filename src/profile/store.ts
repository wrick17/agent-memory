// ProfileStore: one SQLite Durable Object per (user, profile, generation). The only path to a profile's storage.
import { DurableObject } from "cloudflare:workers";
import { Fail, ok, type Outcome, type ReadQuery, type RecallPage, type WriteCommand, type WriteContext } from "../domain/types";
import { migrate } from "../storage";
import { embedStep, embeddingsOn, namespaceOf, vectorId } from "./index";
import { fuse, get, inventory, lexicalChannels } from "./read";
import { PROFILE_MIGRATIONS } from "./schema";
import { runWrite, type Who } from "./write";

// The profile module's public surface: callers outside src/profile import only from here.
export { EMBED_MODEL, embeddingsOn } from "./index";
export { APPEND_MAX, NOTE_MAX } from "./write";

const RETRY_MS = 60_000;

export class ProfileStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage, "profile_meta", PROFILE_MIGRATIONS));
	}

	/** Records which (user, profile, generation) this object is on first use, and refuses any other afterwards. */
	private bind(who: Who): void {
		const sql = this.ctx.storage.sql;
		const meta = Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key IN ('user_id','profile','generation')").toArray().map((r) => [r.key, r.value]));
		if (!meta.user_id) {
			this.ctx.storage.transactionSync(() => {
				for (const [k, v] of [["user_id", who.userId], ["profile", who.profile], ["generation", who.generation]]) sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, ?)", k, v);
			});
		} else if (meta.user_id !== who.userId || meta.profile !== who.profile || meta.generation !== who.generation) {
			throw Fail.of("validation", "profile object identity mismatch");
		}
	}

	private who(): Who | undefined {
		const meta = Object.fromEntries(this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key IN ('user_id','profile','generation')").toArray().map((r) => [r.key, r.value]));
		return meta.user_id ? { userId: meta.user_id, profile: meta.profile!, generation: meta.generation! } : undefined;
	}

	/**
	 * One transactionSync per call: replay or refuse by request_id, resolve identity, check expected_revision, apply,
	 * write revision or entry, stamp the sequence number, write activity, store the request result, mark the embedding due.
	 */
	async write(who: Who, cmd: WriteCommand, ctx: WriteContext): Promise<Outcome<Record<string, unknown> & { created: string[] }>> {
		try {
			this.bind(who);
			const out = runWrite(this.ctx.storage, who, cmd, ctx);
			if (out.embedDue && embeddingsOn(this.env) && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now());
			return ok({ ...out.result, created: out.created });
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			throw e;
		}
	}

	async read(who: Who, q: ReadQuery): Promise<Outcome<unknown>> {
		try {
			this.bind(who);
			const sql = this.ctx.storage.sql;
			switch (q.kind) {
				case "get":
					return ok(get(sql, who, q));
				case "inventory":
					return ok(inventory(sql, who, q));
				case "has":
					return ok(sql.exec("SELECT 1 FROM nodes WHERE id = ?", q.id).toArray().length > 0);
				case "recall":
					return ok(await this.recall(who, q));
			}
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			throw e;
		}
	}

	/** Starts the Vectorize query first, runs the lexical channels while it is in flight, then waits at most vectorWaitMs more. */
	private async recall(who: Who, q: Extract<ReadQuery, { kind: "recall" }>): Promise<RecallPage> {
		const diagnostics: Record<string, string> = {};
		const pending = q.vector && this.env.VECTORS
			? this.env.VECTORS.query(q.vector, { topK: 100, namespace: namespaceOf(who), returnValues: false, returnMetadata: "none",
				...(q.kinds?.length ? { filter: { kind: { $in: q.kinds } } } : {}) })
			: undefined;
		const channels = lexicalChannels(this.ctx.storage.sql, q, diagnostics);
		let vectorUsed = false;
		if (!pending) diagnostics.vector = q.vector ? "unavailable" : "off";
		else {
			const timeout = Symbol("timeout");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const res = await Promise.race([pending, new Promise<typeof timeout>((r) => { timer = setTimeout(() => r(timeout), q.vectorWaitMs); })])
				.catch((e: unknown) => e as Error)
				.finally(() => { if (timer !== undefined) clearTimeout(timer); });
			if (res === timeout) { diagnostics.vector = "timeout"; pending.catch(() => undefined); }
			else if (res instanceof Error) diagnostics.vector = `error:${res.name}`;
			else {
				vectorUsed = true;
				const prefix = `g${who.generation}:`;
				const ids = res.matches.map((m) => m.id).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
				const sql = this.ctx.storage.sql;
				const present = new Set(ids.length ? sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray().map((r) => r.id) : []);
				const gone = ids.filter((id) => !present.has(id));
				// Lazy cleanup, only of this generation's own ids.
				if (gone.length) this.ctx.waitUntil(this.env.VECTORS!.deleteByIds(gone.map((id) => vectorId(who, id))).then(() => undefined, () => undefined));
				channels.vector = ids.filter((id) => present.has(id)).map((id) => ({ id }));
				diagnostics.vector = ids.length ? `hits:${ids.length}` : "no_results";
			}
		}
		return { hits: fuse(this.ctx.storage.sql, who, q, filterVector(this.ctx.storage.sql, q, channels)), diagnostics, vectorUsed };
	}

	async alarm(): Promise<void> {
		const who = this.who();
		if (!who) return;
		try {
			const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "meter">;
			const more = await embedStep(this.ctx.storage, this.env, who, async (neurons) => (await account.meter({ day: new Date().toISOString().slice(0, 10), neurons })).embed);
			if (more) await this.ctx.storage.setAlarm(Date.now() + 1_000);
			this.stage("embed", null);
		} catch (e) {
			this.stage("embed", (e as Error).message.slice(0, 500));
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
	}

	private stage(name: string, error: string | null): void {
		this.ctx.storage.sql.exec(`INSERT INTO cursors (stage, due_at, last_run_at, last_error) VALUES (?, 0, ?, ?)
			ON CONFLICT (stage) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`, name, new Date().toISOString(), error);
	}
}

/** Vector hits pass the same status, type, kind and scope filters as the lexical channels. */
function filterVector(sql: SqlStorage, q: Extract<ReadQuery, { kind: "recall" }>, channels: Record<string, { id: string; chunk?: number }[]>) {
	const v = channels.vector;
	if (!v?.length) return channels;
	const lexical = lexicalFilterIds(sql, q, v.map((c) => c.id));
	return { ...channels, vector: v.filter((c) => lexical.has(c.id)) };
}

function lexicalFilterIds(sql: SqlStorage, q: Extract<ReadQuery, { kind: "recall" }>, ids: string[]): Set<string> {
	const status = q.includeHistory ? "status IN ('active','retired','superseded')" : "status = 'active'";
	const extra: string[] = [], params: SqlStorageValue[] = [...ids];
	if (q.type !== "all") { extra.push("memory_type = ?"); params.push(q.type); }
	if (q.kinds?.length) { extra.push(`kind IN (${q.kinds.map(() => "?").join(",")})`); params.push(...q.kinds); }
	if (q.scope !== undefined) { extra.push("scope = ?"); params.push(q.scope.trim().toLowerCase()); }
	return new Set(sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (${ids.map(() => "?").join(",")}) AND memory_type IS NOT NULL AND ${[status, ...extra].join(" AND ")}`, ...params).toArray().map((r) => r.id));
}

