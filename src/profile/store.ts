// ProfileStore: one SQLite Durable Object per (user, profile, generation). The only path to a profile's storage.
import { DurableObject } from "cloudflare:workers";
import { Fail, ok, type Outcome, type ReadQuery, type RecallPage, type WriteCommand, type WriteContext } from "../domain/types";
import { migrate, nextSeq } from "../storage";
import { EMBED_MODEL, embedStep, embeddingsOn, namespaceOf, SEMANTIC_MS, vectorId } from "./index";
import { candidates, fuse, get, inventory, lexicalChannels } from "./read";
import { captureState, ingest, type IngestBatch, type ItemResult } from "./capture";
import { runImport, type ImportResult, type ImportStep } from "./import";
import { PROFILE_MIGRATIONS } from "./schema";
import { runWrite, type Who } from "./write";

// The profile module's public surface: callers outside src/profile import only from here.
export { embeddingsOn, SEMANTIC_MS } from "./index";
export { APPEND_MAX, NOTE_MAX } from "./write";
export type { ImportStep } from "./import";

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
			if (e instanceof Error && e.message.includes("import_pending")) return { ok: false, error: { code: "busy", message: "a record with this id is still being imported; retry later" } };
			throw e;
		}
	}

	/** The me guard's term table, written only by AccountStore before it confirms a term registration (section 5). */
	async addGuardTerms(who: Who, terms: string[], source: string): Promise<Outcome<number>> {
		this.bind(who);
		if (who.profile !== "me") return { ok: false, error: { code: "validation", message: "guard terms live in the me profile" } };
		const sql = this.ctx.storage.sql;
		const at = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			const seq = nextSeq(sql, "profile_meta");
			for (const t of terms) sql.exec("INSERT OR IGNORE INTO guard_terms (term, source, added_at, seq) VALUES (?, ?, ?, ?)", t, source, at, seq);
		});
		return ok(terms.length);
	}

	/** Capture digests and manifests (section 10). Never through the memory write path: digests are not memories. */
	/** One step of the staged import (stage, prepare, publish, link), in one transaction. Publishing an active record schedules its embedding. */
	async importStep(who: Who, step: ImportStep): Promise<Outcome<ImportResult>> {
		try {
			this.bind(who);
			const out = runImport(this.ctx.storage, step);
			if (out.embed && embeddingsOn(this.env) && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now());
			return ok(out);
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			throw e;
		}
	}

	async ingest(who: Who, batch: IngestBatch): Promise<Outcome<ItemResult[]>> {
		this.bind(who);
		return ok(ingest(this.ctx.storage, who, batch));
	}

	async captureState(who: Who, rangeIds: string[]): Promise<Outcome<ReturnType<typeof captureState>>> {
		this.bind(who);
		return ok(captureState(this.ctx.storage.sql, rangeIds));
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
				case "candidates":
					return ok(candidates(sql, q));
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

	/**
	 * Semantic enrichment shares one deadline set by the Worker (section 11). The keyword's embedding is requested first,
	 * the lexical channels run while it is in flight, and the Vectorize query follows the embedding. Whatever has not
	 * answered by the deadline is left out; the lexical results return, and diagnostics name the stage that missed.
	 */
	private async recall(who: Who, q: Extract<ReadQuery, { kind: "recall" }>): Promise<RecallPage> {
		const diagnostics: Record<string, string> = {};
		let stage: "embedding" | "vector" = "embedding";
		const semantic = q.semantic && this.env.AI && this.env.VECTORS ? (async () => {
			const out = (await this.env.AI!.run(EMBED_MODEL, { text: [q.keyword] })) as { data?: number[][] };
			const vector = out.data?.[0];
			if (!vector?.length) throw new Error("empty embedding");
			diagnostics.embedding = "ok";
			stage = "vector";
			return this.env.VECTORS!.query(vector, { topK: 100, namespace: namespaceOf(who), returnValues: false, returnMetadata: "none",
				...(q.kinds?.length ? { filter: { kind: { $in: q.kinds } } } : {}) });
		})() : undefined;
		// An answer or failure that arrives after the deadline is dropped, never left unhandled.
		semantic?.catch(() => undefined);
		const channels = lexicalChannels(this.ctx.storage.sql, q, diagnostics);
		let vectorUsed = false;
		if (!semantic) {
			diagnostics.embedding = q.semantic ? "unavailable" : "off";
			diagnostics.vector = "off";
		} else {
			const timeout = Symbol("timeout");
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Clamped, so a clock difference between the Worker and this object can never stretch the wait.
			const wait = Math.max(0, Math.min(q.deadline - Date.now(), SEMANTIC_MS));
			const res = await Promise.race([semantic, new Promise<typeof timeout>((r) => { timer = setTimeout(() => r(timeout), wait); })])
				.catch((e: unknown) => e as Error)
				.finally(() => { if (timer !== undefined) clearTimeout(timer); });
			if (res === timeout || res instanceof Error) {
				diagnostics[stage] = res === timeout ? "timeout" : `error:${res.name}`;
				if (stage === "embedding") diagnostics.vector = "skipped";
			} else {
				vectorUsed = true;
				const prefix = `g${who.generation}:`;
				const ids = res.matches.map((m) => m.id).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
				const sql = this.ctx.storage.sql;
				const present = new Set(ids.length ? sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).toArray().map((r) => r.id) : []);
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
	// The ids as one JSON parameter, so up to 100 vector hits plus the filters stay within the 100 bound parameters per statement.
	const extra: string[] = [], params: SqlStorageValue[] = [JSON.stringify(ids)];
	if (q.type !== "all") { extra.push("memory_type = ?"); params.push(q.type); }
	if (q.kinds?.length) { extra.push(`kind IN (${q.kinds.map(() => "?").join(",")})`); params.push(...q.kinds); }
	if (q.scope !== undefined) { extra.push("scope = ?"); params.push(q.scope.trim().toLowerCase()); }
	return new Set(sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND memory_type IS NOT NULL AND ${[status, ...extra].join(" AND ")}`, ...params).toArray().map((r) => r.id));
}

