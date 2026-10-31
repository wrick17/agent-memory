// ProfileStore: one SQLite Durable Object per (user, profile, generation). The only path to a profile's storage.
import { DurableObject } from "cloudflare:workers";
import { Fail, fail, ok, type Outcome, type ReadQuery, type RecallPage, type UploadArgs, type WriteCommand, type WriteContext } from "../domain/types";
import { requestHash } from "../domain/ids";
import { migrate, nextSeq } from "../storage";
import { EMBED_MODEL, embedStep, embeddingsOn, namespaceOf, SEMANTIC_MS, vectorId } from "./index";
import { candidates, filterIds, fuse, get, inventory, lexicalChannels, markers } from "./read";
import { captureState, ingest, type IngestBatch, type ItemResult } from "./capture";
import { expandLinks, explore, timeline, trace } from "./graph";
import { board } from "./board";
import { similarStep } from "./similar";
import { audit, runImport, type ImportResult, type ImportStep } from "./import";
import { cleanupPurge, housekeep, sizeLevel } from "./housekeeping";
import { batchStatus, complete, dueOutbox, finishBatch, next, nextOutbox, promotable, type JobContext, type MaintenanceCmd, type OpOutcome, type Outbox } from "./maintenance";
import { ownerModel } from "./owner-model";
import { activity, entity, graph, journal, journals, map, pageTimeline, shownIds, wipePreview } from "./pages";
import { BudgetTx } from "./archive";
import { archivedNodeIds, archivePage } from "./archive";
import { archiveCursor, archiveOperation, archiveStatus, deferArchive, nextArchiveAlarm, nextArchiveOperation, runArchive, stagedArchiveActivity, stagedUndo, type ArchiveCommand } from "./archive-operations";
export type { ArchiveCommand } from "./archive-operations";
import { PROFILE_MIGRATIONS } from "./schema";
import { runWrite, writeIds, type Who } from "./write";
import { dueTransfers, nextTransferAlarm, RESUME_MS, transferStep, type TransferOut, type TransferStep } from "./transfer";
import { assertOpen, purgeOrigin, type WipeOut, type WipeStep } from "./wipe";
import { commitKey, naturalRequest, putMarker, uploadKey } from "./work-upload";
import { ackPart, assertRefreshOpen, installMirror, markRegistered, partCheck, progress, receiptSeq, sealPlan, terminal, type Binding, type PartMeta, type PartReply, type Parts, type Payload, type Terminal, type TerminalReply } from "./daily-proof";
import { driveTransfer, resumeTransfer, transferPorts } from "../transfer";
import { applyRows, exportStore, exportTables, readChunk, readManifest } from "../backup";

// The profile module's public surface: callers outside src/profile import only from here.
export { embeddingsOn, SEMANTIC_MS } from "./index";
export { APPEND_MAX, NOTE_MAX } from "./write";
export type { ImportStep } from "./import";
export type { OpOutcome } from "./maintenance";
export { EDGE_ROWS, LEVEL_NODES, newBudget, REL_CLASS, type Budget, type GraphLink, type NodeRef, type NodeSummary } from "./graph";
export { bundleTexts, type Entry, type TransferOut, type TransferStep } from "./transfer";
export type { Page, PurgeResult, WipeOut, WipeStep } from "./wipe";
export { commitArgs, prArgs, repoNamespace, ticketArgs, TITLE_MAX, uploadTerms } from "./work-upload";
export type { Binding, PartMeta, Parts, Payload, Terminal, TerminalReply } from "./daily-proof";

/** One work upload request: items already validated and normalized by the Worker, and the repo marker to move after them. */
export interface WorkBatch { repo: string | null; commits: UploadArgs[]; prs?: UploadArgs[]; tickets?: UploadArgs[]; marker?: { head: string; as_of: string } }
/** A PR or ticket item also names its updated_at. `flagged`: held, but its protected node was flagged for the owner instead of changed. */
export type WorkItemResult = { key: string; status: "stored" | "replayed" | "stale" | "flagged" | "refused"; updated_at?: string; reason?: string };
export type MarkerResult = ReturnType<typeof putMarker>;

import { foldDue, foldStep } from "./compact";
import { danglingPage, enqueueDangling } from "./dangling";
import { ackRows, countRows, flushRows, nextUtcDay, pendingRows } from "./meter";
export { ROW_PAUSE } from "./meter";
export { BudgetTx } from "./archive";

const RETRY_MS = 60_000;
/** Control state, never exported: every stage arms again after a restore, and unfinished transfers settle by reconciliation. */
const PROFILE_CONTROL = ["cursors", "transfer_parts"];
/** A restored generation keeps its own identity and schema version. */
const RESTORE_SKIP = new Set(["user_id", "profile", "generation", "schema_version", "closed"]);
export interface RestoredPage {
	nodes: { id: string; status: string }[];
	requests: { request_id: string; op: string; payload_hash: string; at: string; legacy_op: string | null; legacy_hash: string | null }[];
	open_transfers: number;
}
/** The account or the local closed marker refused this generation during an alarm; `retry` when it was an account recovery. */
class Stopped { constructor(readonly retry: boolean) {} }

export class ProfileStore extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => { migrate(ctx.storage, "profile_meta", PROFILE_MIGRATIONS); countRows(ctx.storage); });
	}

	/** After a mutating entry point: the rows it wrote join the durable meter count (section 6). */
	private metered<T>(value: T): T {
		flushRows(this.ctx.storage);
		return value;
	}

	/** Records which (user, profile, generation) this object is on first use, and refuses any other afterwards. */
	/** readOnly: an object never bound yet stays untouched (it holds nothing to read). */
	private bind(who: Who, readOnly = false, internal = false): void {
		if (!internal) assertOpen(this.ctx.storage.sql);
		const sql = this.ctx.storage.sql;
		const meta = Object.fromEntries(sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key IN ('user_id','profile','generation')").toArray().map((r) => [r.key, r.value]));
		if (!meta.user_id) {
			if (readOnly) return;
			this.ctx.storage.transactionSync(() => {
				for (const [k, v] of [["user_id", who.userId], ["profile", who.profile], ["generation", who.generation]]) sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, ?)", k, v);
			});
		} else if (meta.user_id !== who.userId || meta.profile !== who.profile || meta.generation !== who.generation) {
			throw Fail.of("validation", "profile object identity mismatch");
		}
	}

	private async access(who: Who, ids: string[] = []): Promise<void> {
		assertOpen(this.ctx.storage.sql);
		const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "profileAccess">;
		const r = await account.profileAccess(who, ids);
		if (!r.ok) throw new Fail(r.error);
		assertOpen(this.ctx.storage.sql);
	}

	/** A durable result names its nodes; those still active here are registered for this generation, then rechecked (B1). */
	private async register(who: Who, ids: string[]): Promise<void> {
		const held = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND status = 'active'", JSON.stringify(ids)).toArray().map((n) => n.id);
		const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "recordNodes">;
		await account.recordNodes(who.profile, held, who.generation);
		await this.access(who, held);
	}

	private who(): Who | undefined {
		const meta = Object.fromEntries(this.ctx.storage.sql.exec<{ key: string; value: string }>("SELECT key, value FROM profile_meta WHERE key IN ('user_id','profile','generation')").toArray().map((r) => [r.key, r.value]));
		return meta.user_id ? { userId: meta.user_id, profile: meta.profile!, generation: meta.generation! } : undefined;
	}

	private same(who: Who): boolean {
		const me = this.who();
		return !!me && me.userId === who.userId && me.profile === who.profile && me.generation === who.generation;
	}

	/** Internal RPC from AccountStore: this generation's encrypted export (section 18), under the bounded write pause. */
	async exportNow(who: Who): Promise<Outcome<{ id: string; seq: number; chunks: number; rows: number }>> {
		if (!this.same(who)) return fail("not_found", "this generation holds nothing to export");
		const sql = this.ctx.storage.sql;
		if (sql.exec("SELECT 1 FROM profile_meta WHERE key = 'closed'").toArray().length) return fail("profile_wiped", "this profile generation is closed");
		if (sql.exec("SELECT 1 FROM profile_meta WHERE key = 'restore_id'").toArray().length && !sql.exec("SELECT 1 FROM profile_meta WHERE key = 'restore_done'").toArray().length) return fail("busy", "this generation is being restored");
		return this.ctx.blockConcurrencyWhile(() => exportStore(this.ctx.storage, this.env,
			{ store: `profile-${who.profile}`, userId: who.userId, metaTable: "profile_meta", control: PROFILE_CONTROL, first: ["nodes"], profile: who.profile, generation: who.generation }));
	}

	/**
	 * Internal RPC from AccountStore's open restore: applies the export's verified chunks, in order, to this fresh generation,
	 * for at most about ten seconds per call. Each transaction stays within 1,000 physical rows and 1 MB (BudgetTx) and moves the
	 * durable (chunk, row) progress with its rows. A row that cannot fit alone fails the restore for good. The last call checks
	 * every table's row count.
	 */
	async restoreStep(who: Who, r: { id: string; exportId: string }): Promise<Outcome<{ applied: number; chunks: number; done: boolean }>> {
		try {
			const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "restoreAuthority">;
			const auth = await account.restoreAuthority(who, r.id);
			if (!auth.ok) return auth;
			this.bind(who);
			const sql = this.ctx.storage.sql;
			const meta = (k: string) => sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = ?", k).toArray()[0]?.value;
			const m = await readManifest(this.env, `profile-${who.profile}`, r.exportId, who.userId);
			if (!m.ok) return m;
			const manifest = m.value;
			if (manifest.profile !== who.profile || manifest.schema_version !== PROFILE_MIGRATIONS.length) return fail("validation", "this export's profile or schema version does not match");
			if (!meta("restore_id")) {
				if (exportTables(sql, { control: PROFILE_CONTROL }).some((t) => t !== "profile_meta" && sql.exec(`SELECT 1 FROM "${t}" LIMIT 1`).toArray().length)) return fail("validation", "a restore needs a fresh generation");
				sql.exec("INSERT INTO profile_meta (key, value) VALUES ('restore_id', ?), ('restore_next', '0')", r.id);
			} else if (meta("restore_id") !== r.id) return fail("validation", "this generation belongs to another restore");
			const failed = meta("restore_failed");
			if (failed) return fail("validation", failed);
			// The identity and the restore's own keys stay this generation's; every card embeds again under this generation's ids.
			const adjust = (table: string, cols: string[], row: unknown[]) => {
				if (table === "profile_meta") return RESTORE_SKIP.has(row[cols.indexOf("key")] as string) || String(row[cols.indexOf("key")]).startsWith("restore_") ? null : row;
				if (table === "nodes") { const out = [...row]; out[cols.indexOf("embed_hash")] = null; return out; }
				return row;
			};
			const started = Date.now();
			let next = Number(meta("restore_next"));
			const position = () => [Number(meta("restore_next")), Number(meta("restore_row") ?? 0)] as const;
			while (next < manifest.chunks.length && Date.now() - started < 10_000) {
				const c = await readChunk(this.env, manifest, next), at = next;
				let [chunk, from] = position(), max = c.rows.length;
				while (chunk === at && Date.now() - started < 10_000) {
					const done = { n: 0 };
					try {
						this.ctx.storage.transactionSync(() => {
							const [k, f] = position();
							if (k !== at || f !== from) return; // a concurrent step moved it
							const tx = new BudgetTx(sql, 0, "");
							const end = from + applyRows(tx, c, from, max, adjust, done, c.table === "profile_meta");
							tx.run("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('restore_next', ?), ('restore_row', ?)",
								String(end === c.rows.length ? at + 1 : at), String(end === c.rows.length ? 0 : end));
						});
						max = c.rows.length;
					} catch (e) {
						if (!(e instanceof Fail) || e.failure.code !== "size_budget") throw e;
						// Rolled back. Retry with strictly fewer rows; a row that overflows on its own can never apply.
						max = Math.min(max - 1, done.n);
						if (max < 1) {
							const why = `export row ${from} of ${c.table} does not fit one bounded transaction: ${e.failure.message}`;
							sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('restore_failed', ?)", why);
							return fail("validation", why);
						}
					}
					[chunk, from] = position();
				}
				next = position()[0];
			}
			const done = next === manifest.chunks.length;
			if (done && !meta("restore_done")) {
				for (const [t, n] of Object.entries(manifest.counts)) {
					if (t !== "profile_meta" && sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t}"`).one().n !== n) return fail("validation", `restored ${t} does not match the manifest row count`);
				}
				sql.exec("INSERT INTO profile_meta (key, value) VALUES ('restore_done', ?)", manifest.id);
				await this.ctx.storage.setAlarm(Date.now() + 1_000); // every stage arms again from scratch; the gate waits for the reopen
			}
			return ok({ applied: next, chunks: manifest.chunks.length, done });
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Internal RPC: one page of the restored generation's ownership, for the account's reconciliation. */
	async restoredPage(who: Who, after: { node: string; request: string }): Promise<Outcome<RestoredPage>> {
		const sql = this.ctx.storage.sql;
		// A live generation pages too, for an account restore; an unbound one holds nothing. Only another identity or an unfinished restore is refused.
		if (!this.who()) return ok({ nodes: [], requests: [], open_transfers: 0 });
		const has = (k: string) => sql.exec("SELECT 1 FROM profile_meta WHERE key = ?", k).toArray().length > 0;
		if (!this.same(who) || (has("restore_id") && !has("restore_done"))) return fail("validation", "this generation holds no finished restore");
		return ok({
			nodes: sql.exec<{ id: string; status: string }>("SELECT id, status FROM nodes WHERE id > ? ORDER BY id LIMIT 200", after.node).toArray(),
			requests: sql.exec<RestoredPage["requests"][number]>("SELECT request_id, op, payload_hash, at, legacy_op, legacy_hash FROM requests WHERE request_id > ? ORDER BY request_id LIMIT 200", after.request).toArray(),
			open_transfers: sql.exec<{ n: number }>("SELECT count(*) AS n FROM transfers WHERE state NOT IN ('committed','aborted')").one().n,
		});
	}

	/** Internal RPC from an aborted restore, after the account retired this generation: clears what the restore wrote. */
	async discardRestore(who: Who, id: string): Promise<void> {
		if (!this.same(who) || this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM profile_meta WHERE key = 'restore_id'").toArray()[0]?.value !== id) return;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	/**
	 * One transactionSync per call: replay or refuse by request_id, resolve identity, check expected_revision, apply,
	 * write revision or entry, stamp the sequence number, write activity, store the request result, mark the embedding due.
	 */
	async write(who: Who, cmd: WriteCommand, ctx: WriteContext): Promise<Outcome<Record<string, unknown> & { created: string[] }>> {
		try {
			// A restore's ids are the archived records, checked against the account's wipe ledger like any other write's.
			await this.access(who, cmd.op === "restore" ? archivedNodeIds(this.ctx.storage.sql, cmd.args.activity_id) : writeIds(who, cmd));
			this.bind(who);
			if (cmd.op === "undo" && stagedArchiveActivity(this.ctx.storage.sql,cmd.args.activity_id)) {
				const a=this.ctx.storage.sql.exec<{result:string}>("SELECT result FROM requests WHERE request_id=?",cmd.args.request_id).toArray()[0];
				const next=a ? {action:"restore" as const,activity_id:cmd.args.activity_id,request_id:cmd.args.request_id} : stagedUndo(this.ctx.storage.sql,cmd.args.activity_id)!.command;
				const result=await this.archiveOperation(who,next,ctx,cmd.args.activity_id);
				return result.ok ? ok({...result.value,created:[]}) : result;
			}
			const out = this.metered(runWrite(this.ctx.storage, who, cmd, ctx));
			if (((out.embedDue && embeddingsOn(this.env)) || foldDue(this.ctx.storage.sql)) && ((await this.ctx.storage.getAlarm()) ?? Infinity) > Date.now() + 1_000) await this.ctx.storage.setAlarm(Date.now());
			else if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60_000); // starts housekeeping
			return ok({ ...out.result, created: out.created });
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			if (e instanceof Error && e.message.includes("import_pending")) return { ok: false, error: { code: "busy", message: "a record with this id is still being imported; retry later" } };
			throw e;
		}
	}

	/** Owner-only archive RPC; the account binding is established before any page can commit. */
	async archiveOperation(who:Who,cmd:ArchiveCommand,ctx:WriteContext,undoOf?:number):Promise<Outcome<Record<string,unknown>>> {
		if(ctx.actor!=="owner")return {ok:false,error:{code:"forbidden",message:"only the owner may run archive operations"}};
		const account=this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore,"bindRequest"|"releaseRequest"|"resolveNode">;
		const hash=undoOf?ctx.payloadHash:requestHash("archive",cmd), op=undoOf?"undo":"archive";
		let newBinding=false,committed=false;
		try {
			const sql=this.ctx.storage.sql;
			const ids=cmd.action === "forget"?[cmd.memory_id]:cmd.action === "restore"?archivedNodeIds(sql,cmd.activity_id):[archiveOperation(sql,cmd.operation_id)?.node??""];
			await this.access(who,ids);
			const bound=await account.bindRequest({requestId:cmd.request_id,profile:who.profile,op,payloadHash:hash,generation:who.generation});
			if(!bound.ok)throw new Fail(bound.error);
			newBinding=!bound.value.existing;
			if(bound.value.profile!==who.profile)throw Fail.of("idempotency_mismatch","request belongs to another profile");
			const alarm=await this.ctx.storage.getAlarm();
			if(alarm===null||alarm>Date.now()+1000)await this.ctx.storage.setAlarm(Date.now()+1000);
			for(const id of ids.filter(Boolean)){
				const owner=await account.resolveNode(id);
				await this.access(who,[id]);
				if(owner!==null&&owner!==who.profile)throw Fail.of("not_found","the record is owned by another profile");
			}
			await this.access(who,ids);this.bind(who);
			const value=this.metered(runArchive(this.ctx.storage,who,cmd,ctx,undoOf));committed=true;
			const o=archiveOperation(sql,String(value.operation_id));
			if(o?.action === "restore"&&o.state === "complete")await this.register(who,[o.node]);
			return ok(value);
		}catch(e){if(e instanceof Fail)return {ok:false,error:e.failure};throw e;}
		finally {if(newBinding&&!committed)await account.releaseRequest(cmd.request_id,hash);}
	}
	async archiveOperationStatus(who:Who,id:string):Promise<Outcome<Record<string,unknown>>> {
		try{await this.access(who,[archiveOperation(this.ctx.storage.sql,id)?.node??""]);this.bind(who,true);return ok(archiveStatus(this.ctx.storage.sql,who,id));}
		catch(e){if(e instanceof Fail)return {ok:false,error:e.failure};throw e;}
	}

	/** The me guard's term table, written only by AccountStore before it confirms a term registration (section 5). */
	async addGuardTerms(who: Who, terms: string[], source: string): Promise<Outcome<number>> {
		try {
			await this.access(who);
			this.bind(who);
			if (who.profile !== "me") return { ok: false, error: { code: "validation", message: "guard terms live in the me profile" } };
			const sql = this.ctx.storage.sql;
			const at = new Date().toISOString();
			this.ctx.storage.transactionSync(() => {
				const seq = nextSeq(sql, "profile_meta");
				for (const t of terms) sql.exec("INSERT OR IGNORE INTO guard_terms (term, source, added_at, seq) VALUES (?, ?, ?, ?)", t, source, at, seq);
			});
			return ok(this.metered(terms.length));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Capture digests and manifests (section 10). Never through the memory write path: digests are not memories. */
	/** One step of the staged import (stage, prepare, publish, link), in one transaction. Publishing an active record schedules its embedding. */
	async importStep(who: Who, step: ImportStep, check = false): Promise<Outcome<ImportResult>> {
		try {
			await this.access(who, step.op === "link" ? [step.src, step.dst] : [step.record_id]);
			this.bind(who);
			if (sizeLevel(this.ctx.storage.sql.databaseSize) === "shrink_only") throw Fail.of("size_budget", "this profile is over 90% of its size limit; imports are paused");
			const out = this.metered(runImport(this.ctx.storage, step, who.profile, check));
			if (out.embed && embeddingsOn(this.env) && ((await this.ctx.storage.getAlarm()) ?? Infinity) > Date.now() + 1_000) await this.ctx.storage.setAlarm(Date.now());
			return ok(out);
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			throw e;
		}
	}

	/** The maintenance job's lease and results (section 12): every op runs through runWrite as actor maintenance, with undo. */
	async maintenance(who: Who, cmd: MaintenanceCmd, job: JobContext): Promise<Outcome<unknown>> {
		try {
			await this.access(who);
			this.bind(who);
			if (cmd.op === "next") return ok(this.metered(next(this.ctx.storage, cmd)));
			if ("status" in cmd) return ok(this.metered(finishBatch(this.ctx.storage, cmd, job)));
			// The wakeup is armed before an item can commit its outbox row, so a crash right after the commit is still settled.
			if (cmd.results.some((r) => r.ops.some((o) => o.op === "infer_preference" || o.op === "promote_to_me" || o.op === "strategic_review"))) {
				const due = Date.now() + RESUME_MS, at = await this.ctx.storage.getAlarm();
				if (at === null || at > due) await this.ctx.storage.setAlarm(due);
				await this.access(who);
			}
			const out = this.metered(complete(this.ctx.storage, who, cmd, job));
			if (((out.embedDue && embeddingsOn(this.env)) || foldDue(this.ctx.storage.sql)) && ((await this.ctx.storage.getAlarm()) ?? Infinity) > Date.now() + 1_000) await this.ctx.storage.setAlarm(Date.now());
			// Created records (inferred preferences, reviews), fresh or replayed, are registered for this generation before any result is acknowledged.
			const created = out.results.flatMap((r) => ("ops" in r && Array.isArray(r.ops) ? (r.ops as OpOutcome[]) : []).flatMap((o) => o.created ?? []));
			if (created.length) try { await this.register(who, created); } catch (e) {
				if (e instanceof Fail) throw e;
				return { ok: false, error: { code: "unavailable", message: "created records are not registered yet; retry this completion" } };
			}
			return ok({ results: out.results });
		} catch (e) {
			if (e instanceof Fail) return { ok: false, error: e.failure };
			throw e;
		}
	}

	/** One step of a transfer between profiles (section 9), in one transaction. */
	async transfer(who: Who, step: TransferStep): Promise<Outcome<TransferOut>> {
		try {
			const ids = "nodeId" in step && step.nodeId ? [step.nodeId] : this.ctx.storage.sql.exec<{ node_id: string }>("SELECT node_id FROM transfers WHERE id = ?", step.id).toArray().map((t) => t.node_id);
			await this.access(who, ids);
			this.bind(who);
			const out = await transferStep(this.ctx.storage, this.env, who, step);
			await this.access(who, ids);
			return this.metered(out);
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** One step of a profile wipe (section 9). clear deletes this object's storage, so it skips bind on a repeat. */
	async purgeOrigin(who: Who, step: WipeStep): Promise<Outcome<WipeOut>> {
		if (step.op !== "clear") this.bind(who, false, true);
		// The generation's corpus closes and clears with it, first, whatever the CORPUS flag says now; a replay repeats it harmlessly.
		if ((step.op === "close" || step.op === "clear") && this.env.CORPUS_STORE) {
			const corpus = this.env.CORPUS_STORE.get(this.env.CORPUS_STORE.idFromName(`${who.userId}:${who.profile}:${who.generation}`)) as unknown as Pick<import("../corpus/store").CorpusStore, "wipe">;
			const r = await corpus.wipe(who, step.op);
			if (!r.ok) return this.metered(r);
		}
		return this.metered(await purgeOrigin(this.ctx.storage, this.env, who, step));
	}

	async ingest(who: Who, batch: IngestBatch): Promise<Outcome<ItemResult[]>> {
		try {
			await this.access(who);
			this.bind(who);
			const out = this.metered(ingest(this.ctx.storage, who, batch));
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
			return ok(out);
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/**
	 * Work uploads (section 10): each item in its own runWrite transaction as actor index, after the account's generation and
	 * wipe-ledger check for its ids, so a refusal or failure leaves nothing behind and a retry starts clean. The repo marker moves
	 * only when every item of the request is held.
	 */
	async upload(who: Who, batch: WorkBatch, ctx: Omit<WriteContext, "actor" | "payloadHash">): Promise<Outcome<{ commits: WorkItemResult[]; prs?: WorkItemResult[]; tickets?: WorkItemResult[]; marker?: MarkerResult; created: string[] }>> {
		if (who.profile === "me") return { ok: false, error: { code: "forbidden", message: "uploads never go to me" } };
		const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "bindRequest" | "releaseRequest">;
		const commits: WorkItemResult[] = [], prs: WorkItemResult[] = [], tickets: WorkItemResult[] = [], created: string[] = [];
		const refused = (key: string, e: unknown): WorkItemResult => {
			// A daily refresh item names why it was refused (refresh_closed, registration_unavailable); ordinary results keep the code.
			if (e instanceof Fail) return { key, status: "refused", reason: ctx.refresh && typeof e.failure.details?.reason === "string" ? e.failure.details.reason : e.failure.code };
			if (e instanceof Error && e.message.includes("import_pending")) return { key, status: "refused", reason: "busy" };
			throw e;
		};
		const register = (ids: string[]) => this.register(who, ids);
		let embedDue = false;
		for (const args of [...batch.commits, ...(batch.prs ?? []), ...(batch.tickets ?? [])]) {
			const key = uploadKey(args), items = args.item === "commit" ? commits : args.item === "pr" ? prs : tickets, op = `upload_${args.item}`;
			const revision = args.item === "commit" ? {} : { updated_at: args.updated_at };
			const { requestId, payloadHash } = naturalRequest(this.ctx.storage.sql, who, args);
			const cmd = { op: "upload" as const, args: { ...args, request_id: requestId } };
			let newBinding = false, committed = false;
			try {
				await this.access(who, writeIds(who, cmd));
				const bound = await account.bindRequest({ requestId: cmd.args.request_id, profile: who.profile, op, payloadHash, generation: who.generation });
				if (!bound.ok) throw new Fail(bound.error);
				newBinding = !bound.value.existing;
				if (bound.value.profile !== who.profile) throw Fail.of("idempotency_mismatch", "upload belongs to another profile");
				await this.access(who, writeIds(who, cmd));
				this.bind(who);
				const out = this.metered(runWrite(this.ctx.storage, who, cmd, { ...ctx, actor: "index", payloadHash }));
				committed = true;
				// Read in the write's own turn: the exact receipt (none for commits) that a successful registration below proves.
				const receipt = receiptSeq(this.ctx.storage.sql, cmd.args.request_id);
				try { await register((out.result.node_ids ?? []) as string[]); } catch (e) {
					// A daily item keeps its commit and stays pending; its retried frame replays it and registers again.
					if (ctx.refresh && !(e instanceof Fail)) throw Fail.of("unavailable", "the item's registration did not complete", { reason: "registration_unavailable" });
					throw e;
				}
				// After the awaits and before the stamp: a daily claim closed meanwhile gets no registration proof from this call.
				if (ctx.refresh) assertRefreshOpen(this.ctx.storage.sql, ctx.refresh);
				if (receipt !== undefined) this.metered(markRegistered(this.ctx.storage.sql, cmd.args.request_id, receipt));
				created.push(...out.created);
				embedDue ||= out.embedDue;
				const action = String(out.result.action);
				items.push({ key, ...revision, status: action === "replayed" || action === "stale" || action === "flagged" ? action : "stored" });
			} catch (e) {
				if (newBinding && !committed) await account.releaseRequest(cmd.args.request_id, payloadHash);
				items.push({ ...refused(key, e), ...revision });
			}
		}
		let marker: MarkerResult | undefined;
		if (batch.marker) {
			if ([...commits, ...prs, ...tickets].some((c) => c.status === "refused")) marker = { status: "refused", reason: "commits_not_held" };
			else {
				try {
					await this.access(who);
					this.bind(who);
					// Marker-only included: a registration that failed after its upload committed completes before anything is acknowledged.
					const head = this.ctx.storage.sql.exec<{ result: string }>("SELECT result FROM requests WHERE request_id = ? AND op = 'upload'", `upload:${who.profile}:${commitKey(batch.repo!, batch.marker.head)}`).toArray()[0];
					if (head) await register((JSON.parse(head.result) as { node_ids?: string[] }).node_ids ?? []);
					marker = this.metered(putMarker(this.ctx.storage, batch.repo!, batch.marker));
				} catch (e) { const r = refused(batch.repo!, e); marker = { status: "refused", ...(r.reason ? { reason: r.reason } : {}) }; }
			}
		}
		if ([...commits, ...prs, ...tickets].some((c) => c.status === "stored")) {
			const alarm = await this.ctx.storage.getAlarm();
			await this.access(who);
			if (embedDue && embeddingsOn(this.env) && (alarm ?? Infinity) > Date.now() + 1_000) await this.ctx.storage.setAlarm(Date.now());
			else if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
		}
		return ok({ commits, ...(batch.prs ? { prs } : {}), ...(batch.tickets ? { tickets } : {}), ...(marker ? { marker } : {}), created });
	}

	/** The daily claim's mirror, installed by AccountStore after it reserved the day (daily-proof.ts). */
	async refreshMirror(who: Who, b: Binding): Promise<Outcome<null>> {
		try {
			await this.access(who);
			this.bind(who);
			installMirror(this.ctx.storage, who, b);
			return ok(this.metered(null));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Seals the confirmed claim's one plan, for AccountStore. */
	async refreshPlan(who: Who, b: Binding, parts: Parts, manifestHash: string): Promise<Outcome<{ status: "sealed" } | { status: "pending"; reason: string }>> {
		try {
			await this.access(who);
			this.bind(who);
			return ok(this.metered(sealPlan(this.ctx.storage, who, b, parts, manifestHash)));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/**
	 * One part of a claimed daily refresh: a wrong binding, day, sequence or part hash refuses before any item write, and an
	 * acknowledged part returns its stored proof without touching items. The items go through upload above, fenced in their own
	 * transactions; only after every await is the part acknowledged with its exact item proof.
	 */
	async uploadPart(who: Who, m: PartMeta, body: string, payload: Payload, ctx: Omit<WriteContext, "actor" | "payloadHash" | "refresh">): Promise<Outcome<{ prs?: WorkItemResult[]; tickets?: WorkItemResult[]; refresh: PartReply }>> {
		try {
			await this.access(who);
			this.bind(who);
			const check = partCheck(this.ctx.storage.sql, who, ctx.deviceId, m, body, payload);
			if ("status" in check) return ok({ refresh: check });
			if (check.replay) return ok({ refresh: check.replay });
			const first = check.items![0]!, pr = first.item === "pr";
			const up = await this.upload(who, { repo: first.item === "pr" ? first.repo : null, commits: [], ...(pr ? { prs: check.items! } : { tickets: check.items! }) },
				{ ...ctx, refresh: { claim_id: m.claim_id, part: m.part, device_id: ctx.deviceId ?? "" } });
			if (!up.ok) return up;
			const results = (pr ? up.value.prs : up.value.tickets)!, held = results.every((r) => r.status === "stored" || r.status === "replayed" || r.status === "stale");
			await this.access(who);
			const refresh: PartReply = held ? this.metered(ackPart(this.ctx.storage, who, ctx.deviceId, m, body, payload)) : { status: "pending", reason: "items_not_held", part: m.part };
			return ok({ ...(pr ? { prs: results } : { tickets: results }), refresh });
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** The profile terminal for AccountStore: a replay returns the first terminal and resumes cleanup; release waits for `cleaned`. */
	async refreshTerminal(who: Who, b: Binding, t: Terminal): Promise<Outcome<TerminalReply>> {
		try {
			const alarm = await this.ctx.storage.getAlarm();
			await this.access(who);
			// Arm recovery before the terminal commit, including claims with no uploaded frame to start housekeeping.
			if ((alarm ?? Infinity) > Date.now() + 60_000) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				await this.access(who);
			}
			this.bind(who);
			return ok(this.metered(terminal(this.ctx.storage, who, b, t)));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	/** Read-only claim progress for the status route. */
	async refreshProgress(who: Who, claimId: string): Promise<Outcome<ReturnType<typeof progress>>> {
		try {
			await this.access(who);
			this.bind(who, true);
			return ok(progress(this.ctx.storage.sql, claimId));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	async captureState(who: Who, rangeIds: string[]): Promise<Outcome<ReturnType<typeof captureState>>> {
		try {
			await this.access(who);
			this.bind(who);
			return ok(captureState(this.ctx.storage.sql, rangeIds));
		} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
	}

	async read(who: Who, q: ReadQuery): Promise<Outcome<unknown>> {
		try {
			await this.access(who);
			this.bind(who, ["import_audit", "batch_status", "owner_model", "board", "entity", "journals", "journal", "map", "graph", "page_timeline", "activity", "shown", "archive", "markers", "wipe_preview"].includes(q.kind));
			const sql = this.ctx.storage.sql;
			switch (q.kind) {
				case "get":
					return ok(get(sql, who, q));
				case "inventory":
					return ok(inventory(sql, who, q));
				case "candidates":
					return ok(candidates(sql, q));
				case "has":
					// Ownership probe: a record still landing or a tombstone left behind never claims the id.
					return ok(sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status IN ('active','retired','superseded','moving','candidate','dismissed')", q.id).toArray().length > 0);
				case "recall":
					return ok(await this.recall(who, q));
				case "import_audit":
					return ok(audit(sql, q));
				case "explore":
					return ok(explore(sql, q));
				case "trace":
					return ok(trace(sql, q));
				case "timeline":
					return ok(timeline(sql, q));
				case "board":
					return ok(board(sql, q));
				case "batch_status":
					return ok(batchStatus(sql));
				case "owner_model":
					return ok(ownerModel(sql, q));
				case "wipe_preview":
					return ok(wipePreview(sql, who, q));
				case "entity":
					return ok(entity(sql, q));
				case "journals":
					return ok(journals(sql, q));
				case "journal":
					return ok(journal(sql, q));
				case "map":
					return ok(map(sql, q));
				case "graph":
					return ok(graph(sql, q));
				case "page_timeline":
					return ok(pageTimeline(sql, q));
				case "activity":
					return ok(activity(sql, q));
				case "shown":
					return ok(shownIds(sql, q));
				case "archive":
					return ok(archivePage(sql, q));
				case "markers":
					return ok(markers(sql, q));
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
		// Vectors hold only current cards, so a read at as_of is lexical over the text stored by then.
		const semantic = q.semantic && !q.asOf && this.env.AI && this.env.VECTORS ? (async () => {
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
			diagnostics.embedding = q.asOf ? "off:as_of" : q.semantic ? "unavailable" : "off";
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
		await this.access(who);
		const sql = this.ctx.storage.sql;
		const filtered = filterVector(sql, q, channels);
		let hits = fuse(sql, who, q, filtered);
		if (q.expand && hits.length) {
			// The graph channel (section 11): one hop from the top 10, inside this profile, under the same filters.
			// Seeds are the capped hits only; preferences from below the cap never widen the graph walk.
			// With as_of the walk follows links valid then, and fuse checks each neighbour's stored state then.
			const g = expandLinks(sql, hits.filter((h) => h.rank === undefined).map((h) => ({ id: h.memory_id, score: h.score })), q.asOf);
			const allowed = !g.neighbors.length ? new Set<string>() : q.asOf ? filterIds(sql, q, g.neighbors.map((n) => n.id)) : lexicalFilterIds(sql, q, g.neighbors.map((n) => n.id));
			const graph = g.neighbors.filter((n) => allowed.has(n.id));
			diagnostics.graph = graph.length ? `hits:${graph.length}` : "no_results";
			if (g.budget.exhausted) diagnostics.graph_budget = `stopped:${g.budget.stopped}:${g.budget.edges_read}`;
			if (graph.length) {
				const via = new Map(graph.map((n) => [n.id, n.via]));
				hits = fuse(sql, who, q, { ...filtered, graph: graph.map((n) => ({ id: n.id })) }).map((h) => (via.has(h.memory_id) ? { ...h, via: via.get(h.memory_id)! } : h));
			}
		}
		return { hits, diagnostics, vectorUsed };
	}

	async alarm(): Promise<void> {
		const who = this.who();
		if (!who) return;
		if (this.ctx.storage.sql.exec("SELECT 1 FROM profile_meta WHERE key = 'closed'").toArray().length) return;
		// Any await may outlive this generation or meet an account recovery, so every local write after one passes this gate first.
		// A refusal ends the alarm with nothing more written; only a recovery, which ends, brings it back.
		const gate = async () => {
			try { await this.access(who); } catch (e) { throw e instanceof Fail ? new Stopped(e.failure.code === "busy") : e; }
		};
		const failed = async (stage: string, e: unknown) => {
			if (e instanceof Stopped) throw e;
			await gate();
			this.stage(stage, (e as Error).message.slice(0, 500));
		};
		try {
			await gate();
			const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "meter">;
			const sql = this.ctx.storage.sql, day = new Date().toISOString().slice(0, 10), midnight = nextUtcDay(Date.now());
			// The row meter (section 6), once per step: the flushed count goes to the account, which says whether background stages
			// may run today. A failed report fails open and keeps its count; only an acknowledged count is taken off, after the gate.
			let reported = 0;
			let background = true, meterError: string | null = null;
			try { reported = pendingRows(sql); background = (await account.meter({ day, rowsWritten: reported })).background; } catch (e) { meterError = (e as Error).message.slice(0, 500); }
			await gate();
			let archiveMore=false;
			const archive=nextArchiveOperation(sql);
			if(archive){
				await this.access(who,[archive.node]);
				const c={action:"resume" as const,operation_id:archive.id,cursor:archiveCursor(archive),request_id:`archive-auto:${archive.id}:${archive.version}`};
				const r=await this.archiveOperation(who,c,{actor:"owner",platform:"archive-alarm",routedBy:"explicit",userId:who.userId,payloadHash:requestHash("archive",c),meGuard:archive.me});
				if(!r.ok){
					await this.access(who,[archive.node]);
					this.ctx.storage.transactionSync(()=>deferArchive(new BudgetTx(sql,nextSeq(sql,"profile_meta"),new Date().toISOString()),archive.id,r.error.code));
					await failed("archive",new Error(r.error.code));
				}
				archiveMore=Boolean(nextArchiveOperation(sql));
			}
			await gate();
			let more = false, embedError: string | null = null;
			// An embedding outage must not stop retention, cleanup or queue work; the gate below still stops a closed generation.
			try {
				more = await embedStep(this.ctx.storage, this.env, who, async (neurons) => (await account.meter({ day: new Date().toISOString().slice(0, 10), neurons })).embed, gate);
			} catch (e) {
				if (e instanceof Stopped) throw e;
				embedError = (e as Error).message.slice(0, 500);
			}
			await gate();
			if (meterError === null) try { ackRows(sql, reported); } catch (e) { meterError = (e as Error).message.slice(0, 500); }
			if (meterError !== null) this.stage("meter", meterError);
			this.stage("embed", embedError);
			// Past the day's rows only similarity, the dangling check and housekeeping wait, until 00:00 UTC.
			const paused = meterError === null && !background;
			let folding = false;
			try { folding = foldStep(this.ctx.storage).more; } catch (e) { await failed("fold", e); folding = true; }
			let next: number | null = null;
			if (paused) next = embeddingsOn(this.env) ? midnight : null;
			else try {
				next = await similarStep(this.ctx.storage, this.env, who, Date.now(), gate);
				this.stage("similar", null);
			} catch (e) {
				await failed("similar", e);
				next = Date.now() + RETRY_MS;
			}
			// Unfinished transfers this profile is the source of, after five minutes, from the step they reached (section 9).
			const stale = dueTransfers(this.ctx.storage.sql);
			if (stale.length) {
				const ctx = await (account as unknown as Pick<import("../account/store").AccountStore, "context">).context({ kind: "owner", userId: who.userId });
				for (const id of stale) await resumeTransfer(transferPorts(this.env, who.userId), id, ctx.ok ? ctx.value.sensitiveTerms : []);
			}
			// Finished maintenance items whose caller never saw or acted on the result: register, then promote or abort (section 12).
			try {
				const boxes = dueOutbox(this.ctx.storage.sql, Date.now());
				const ctx = boxes.some((b) => b.box.promote.length) ? await (account as unknown as Pick<import("../account/store").AccountStore, "context">).context({ kind: "owner", userId: who.userId }) : null;
				if (ctx && !ctx.ok) throw new Error(`account context: ${ctx.error.code}`);
				for (const b of boxes) await this.settle(who, b.stage, b.box, ctx?.value.sensitiveTerms ?? [], gate);
				await gate();
				this.stage("outbox", null);
			} catch (e) { await failed("outbox", e); }
			const moves = nextTransferAlarm(this.ctx.storage.sql);
			await gate();
			// Housekeeping (section 12): one bounded step per alarm, of the most overdue of dedupe, TTL and purge.
			let due = Date.now() + 86_400_000;
			try {
				const clean = () => cleanupPurge(this.ctx.storage, async (ids) => {
					if (ids.nodes.length && this.env.VECTORS) await this.env.VECTORS.deleteByIds(ids.nodes.map((id) => vectorId(who, id)));
					const pruned = await (this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "prunePurged">).prunePurged(who, ids);
					if (!pruned.ok) throw new Fail(pruned.error);
					// The outbox is acknowledged only while this generation is still open.
					await gate();
				});
				await clean();
				await gate();
				// The purge outbox never waits; housekeeping itself does while paused, unless the object's size is under pressure.
				if (paused && sizeLevel(sql.databaseSize) === "ok") due = midnight;
				else {
					const h = housekeep(this.ctx.storage, who);
					await clean();
					due = h.more ? Date.now() : h.nextDue;
					this.stage("housekeeping", null);
				}
			} catch (e) {
				await failed("housekeeping", e);
				due = Date.now() + RETRY_MS;
			}
			let dangling = midnight;
			if (!paused) try { dangling = await this.dangling(who, gate); } catch (e) { await failed("dangling", e); dangling = Date.now() + RETRY_MS; }
			await gate();
			flushRows(this.ctx.storage);
			// The alarm always comes back for the earliest stage due, so housekeeping runs with or without embeddings.
			await this.ctx.storage.setAlarm(Math.max(Math.min(more ? Date.now() : embedError === null && meterError === null ? Infinity : Date.now() + RETRY_MS, next ?? Infinity, moves ?? Infinity, nextArchiveAlarm(sql) ?? Infinity, nextOutbox(this.ctx.storage.sql) ?? Infinity, (archiveMore || folding || foldDue(this.ctx.storage.sql)) ? Date.now() : Infinity, due, dangling), Date.now() + 1_000));
		} catch (e) {
			const stop = e instanceof Stopped ? e : await gate().then(() => null, (s: unknown) => (s instanceof Stopped ? s : null));
			if (stop && !stop.retry) return;
			if (!stop) { this.stage("embed", (e as Error).message.slice(0, 500)); flushRows(this.ctx.storage); }
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
	}

	/**
	 * One page of the nightly dangling-link check (section 12): the account's answer for the page's foreign and locally absent
	 * targets, then the gate, then one bounded transaction that rechecks, queues and moves the cursor. Returns when it is next due.
	 */
	private async dangling(who: Who, gate: () => Promise<void>): Promise<number> {
		const page = danglingPage(this.ctx.storage.sql, Date.now());
		if (page.due > Date.now()) return page.due;
		const ids = [...new Set(page.edges.map((e) => e.dst))];
		const account = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(who.userId)) as unknown as Pick<import("../account/store").AccountStore, "nodeStates">;
		const states = ids.length ? await account.nodeStates(who, ids) : ok([] as boolean[]);
		if (!states.ok) throw new Fail(states.error);
		await gate();
		return enqueueDangling(this.ctx.storage, page, new Set(ids.filter((_, i) => states.value[i])));
	}

	/**
	 * Settles one outbox row: registers the item's created ids for this generation, then drives each promotion under its
	 * deterministic id as the job device it was authorized for. The account rereads that device's grant and checks, atomically
	 * at begin, that this source and the stored me generation are still current; the source fence refuses a target the owner
	 * protected since. A target that is no longer promotable goes down C3's abort path, so a begun transfer never stays open.
	 * A transport failure, or a transfer C3 still reports moving, keeps the row for a retry.
	 */
	private async settle(who: Who, stage: string, box: Outbox, terms: string[], gate: () => Promise<void>): Promise<void> {
		let kept = false;
		if (box.created.length) await this.register(who, box.created).catch(() => { kept = true; });
		for (const p of box.promote) {
			const go = promotable(this.ctx.storage.sql, p);
			const caller = { userId: who.userId, kind: "device" as const, deviceId: p.device, scopes: ["maintenance" as const], profiles: [who.profile, "me"] };
			const r = await driveTransfer(transferPorts(this.env, who.userId), { id: p.id, nodeId: p.node, from: who.profile, to: "me", companyFree: p.company_free === true, context: who.profile,
				expect: { from: who.generation, to: p.me }, protect: true }, go ? caller : undefined, terms, !go).catch(() => null);
			if (!r || (!r.ok && r.error.code === "moving")) kept = true;
		}
		await gate();
		if (kept) this.ctx.storage.sql.exec("UPDATE cursors SET due_at = ?, last_run_at = ? WHERE stage = ?", Date.now() + RETRY_MS, new Date().toISOString(), stage);
		else this.ctx.storage.sql.exec("DELETE FROM cursors WHERE stage = ?", stage);
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

