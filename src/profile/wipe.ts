// A profile's part of a wipe (section 9, steps 3, 4 and 6). It lists the ids a wipe purges here, names their request ids so the
// account can fence them first, purges them in bounded steps with their activity redacted first, reports hand-written matches
// without touching them, and clears a wiped generation. The Worker keeps the content-free plan in R2 before any purge.
import { meGuard } from "../domain/guard";
import { Fail, ok, type Outcome } from "../domain/types";
import { nextSeq } from "../storage";
import { BudgetTx, type Row } from "./archive";
import { vectorId } from "./index";
import { bundleTexts } from "./transfer";
import type { Who } from "./write";

/** One page of a wipe: the wiped profile, its wipe time, at most 100 node ids, and the terms the wiped profile had. */
/** keep: ids the me exception preserved in this wipe; never fenced, redacted or refused anywhere, so the survivor can still move. */
export interface OriginWipe { profile: string; at: string; ids: string[]; terms: string[]; keep?: string[] }
export interface Page { ids: string[]; after: string | null }
export interface PurgeResult { done: boolean; purged: string[]; redacted: number; preserved: string[] }

export type WipeStep =
	| { op: "origin"; profile: string; after: string }
	| { op: "requests"; wipe: OriginWipe; after: string }
	| { op: "purge"; wipe: OriginWipe }
	| { op: "handwritten"; profile: string; terms: string[]; after: string }
	| { op: "close" }
	| { op: "fence"; wipe: OriginWipe }
	| { op: "clear" };
export type WipeOut = Page | PurgeResult | { cleared: number };

const PAGE = 100;
const marker = (w: OriginWipe) => `wipe:${w.profile}:${w.at}`;

/** Ids to purge here: every node, archived node and tombstone whose first origin is the wiped profile (all of them in the profile itself). */
function originPage(sql: SqlStorage, who: Who, profile: string, after: string): Page {
	const all = who.profile === profile ? 1 : 0;
	const ids = sql.exec<{ id: string }>(`SELECT id FROM (
		SELECT id FROM nodes WHERE source_profile = ? OR ?
		UNION SELECT json_extract(payload, '$.id') AS id FROM archive WHERE source = 'nodes' AND (json_extract(payload, '$.source_profile') = ? OR ?)
	) WHERE id > ? ORDER BY id LIMIT ${PAGE}`, profile, all, profile, all, after).toArray().map((r) => r.id);
	return { ids, after: ids.length === PAGE ? ids.at(-1)! : null };
}

/**
 * The one exception (section 9, step 5): a preference in me that landed with a company_free attestation survives, and only
 * while it still passes the me guard against the wiped profile's terms.
 */
function survives(sql: SqlStorage, who: Who, id: string, terms: string[]): boolean {
	if (who.profile !== "me") return false;
	const n = sql.exec<Row>("SELECT * FROM nodes WHERE id = ? AND kind = 'preference' AND status IN ('active','retired','superseded','moving') AND json_extract(attrs, '$.company_free') = 1", id).toArray()[0];
	if (!n) return false;
	const rows = [n, ...sql.exec<Row>("SELECT * FROM texts WHERE node_id = ?", id).toArray(), ...sql.exec<Row>("SELECT * FROM revisions WHERE node_id = ?", id).toArray()];
	return meGuard({ context: null, companyFree: true, sensitiveTerms: terms, texts: bundleTexts(rows) }).ok;
}

/** The page's ids this profile holds, as a node or as archived rows, that do not survive. */
function held(sql: SqlStorage, who: Who, w: OriginWipe): { here: string[]; preserved: string[] } {
	if (w.ids.length > PAGE || Buffer.byteLength(JSON.stringify(w)) > 100_000) throw Fail.of("validation", "a wipe page holds at most 100 ids and 100 KB");
	const json = JSON.stringify(w.ids);
	const present = new Set(sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?1))
		UNION SELECT coalesce(json_extract(payload, '$.node_id'), json_extract(payload, '$.src'), json_extract(payload, '$.id')) AS id FROM archive
		WHERE coalesce(json_extract(payload, '$.node_id'), json_extract(payload, '$.src'), json_extract(payload, '$.id')) IN (SELECT value FROM json_each(?1))`, json).toArray().map((r) => r.id));
	const here: string[] = [], preserved: string[] = [];
	for (const id of w.ids) if (present.has(id)) (who.profile !== w.profile && survives(sql, who, id, w.terms) ? preserved : here).push(id);
	return { here, preserved };
}

/** The page's ids this profile fences and redacts: all of them but the me exception's survivors. */
function fenced(w: OriginWipe, preserved: string[]): string[] {
	const spared = new Set([...preserved, ...(w.keep ?? [])]);
	return w.ids.filter((id) => !spared.has(id));
}

/** One transaction deletes a bounded prefix. Activity is redacted before any payload goes; each node row goes last. */
function purge(sql: SqlStorage, who: Who, w: OriginWipe): PurgeResult {
	const { here, preserved } = held(sql, who, w);
	const out: PurgeResult = { done: false, purged: [], redacted: 0, preserved };
	const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
	// So a later write path can refuse to recreate a purged id here (assertNotWiped).
	for (const id of fenced(w, preserved)) tx.run("INSERT OR IGNORE INTO profile_meta (key, value) VALUES (?, ?)", `wiped:${id}`, marker(w));
	// Any activity row naming a purged id may hold its content (an update's undo, a move's record): only content-free facts stay.
	const activities = sql.exec<Row>(`SELECT id, op, targets FROM activity WHERE redacted IS NOT ? AND EXISTS
		(SELECT 1 FROM json_each(activity.targets) WHERE value IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 20`, marker(w), JSON.stringify(fenced(w, preserved))).toArray();
	for (const a of activities) {
		tx.run("UPDATE activity SET summary = ?, undo = NULL, redacted = ?, seq = ? WHERE id = ?",
			`${String(a.op)}, ${(JSON.parse(String(a.targets)) as unknown[]).length} records, redacted by wipe of ${w.profile}`, marker(w), tx.seq, a.id!);
		out.redacted++;
	}
	if (activities.length) return out;
	for (const id of here) {
		const edgeIds = sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ? ORDER BY id LIMIT 40", id).toArray().map((r) => r.id);
		const owners = JSON.stringify([`n:${id}`, ...edgeIds.map((e) => `e:${e}`)]);
		// Edges elsewhere that point at the id are kept: an opaque backlink (section 9, step 6).
		const batches: [string, SqlStorageValue[]][] = [
			["DELETE FROM requests WHERE request_id IN (SELECT request_id FROM requests WHERE node_id = ? LIMIT 100)", [id]],
			["DELETE FROM texts WHERE rowid IN (SELECT rowid FROM texts WHERE node_id = ? LIMIT 60)", [id]],
			["DELETE FROM revisions WHERE (node_id, revision) IN (SELECT node_id, revision FROM revisions WHERE node_id = ? LIMIT 100)", [id]],
			["DELETE FROM evidence WHERE (owner, kind, ref) IN (SELECT owner, kind, ref FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) LIMIT 100)", [owners]],
			["DELETE FROM edges WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(edgeIds)]],
			[`DELETE FROM archive WHERE id IN (SELECT id FROM archive WHERE
				(source = 'nodes' AND json_extract(payload, '$.id') = ?1) OR
				(source IN ('texts','revisions','requests') AND json_extract(payload, '$.node_id') = ?1) OR
				(source = 'edges' AND json_extract(payload, '$.src') = ?1) OR
				(source = 'evidence' AND (json_extract(payload, '$.owner') = ?2 OR json_extract(payload, '$.owner') IN
					(SELECT 'e:' || json_extract(payload, '$.id') FROM archive WHERE source = 'edges' AND json_extract(payload, '$.src') = ?1)))
				ORDER BY CASE source WHEN 'evidence' THEN 0 WHEN 'edges' THEN 1 ELSE 2 END LIMIT 30)`, [id, `n:${id}`]],
			["DELETE FROM maintenance WHERE id IN (SELECT maintenance.id FROM maintenance, json_each(subjects) WHERE value = ? LIMIT 40)", [id]],
			["DELETE FROM transfer_parts WHERE (transfer_id, n) IN (SELECT p.transfer_id, p.n FROM transfer_parts p JOIN transfers t ON t.id = p.transfer_id WHERE t.node_id = ? LIMIT 60)", [id]],
			["DELETE FROM transfers WHERE id IN (SELECT id FROM transfers WHERE node_id = ? LIMIT 40)", [id]],
		];
		for (const [q, args] of batches) {
			const before = tx.rows;
			tx.run(q, ...args);
			if (tx.rows > before) return out;
		}
		if (sql.exec("SELECT 1 FROM nodes WHERE id = ?", id).toArray().length) {
			tx.run("DELETE FROM nodes WHERE id = ?", id);
			out.purged.push(id);
			return out;
		}
	}
	return { ...out, done: true };
}

/** Request ids of the page's purged records, which the account fences as wiped before their results are deleted. */
function requestPage(sql: SqlStorage, who: Who, w: OriginWipe, after: string): Page {
	const ids = sql.exec<{ request_id: string }>(`SELECT request_id FROM requests WHERE node_id IN (SELECT value FROM json_each(?)) AND request_id > ? ORDER BY request_id LIMIT ${PAGE}`,
		// A survivor's request ids are shared with its old tombstones' copies; they stay bound to the survivor.
		JSON.stringify(held(sql, who, w).here.filter((id) => !(w.keep ?? []).includes(id))), after).toArray().map((r) => r.request_id);
	return { ids, after: ids.length === PAGE ? ids.at(-1)! : null };
}

/** Surviving records whose text names a term of the wiped profile: listed for the owner, never changed (section 9, step 6). */
function handwrittenPage(sql: SqlStorage, origin: string, terms: string[], after: string): Page {
	const rows = sql.exec<Row>(`SELECT * FROM nodes WHERE id > ? AND status <> 'moved' AND (source_profile IS NULL OR source_profile <> ?) ORDER BY id LIMIT 40`, after, origin).toArray();
	// meGuard's word-boundary match; a contact field alone is not a work reference.
	const ids = rows.filter((n) => {
		const g = meGuard({ context: null, companyFree: true, sensitiveTerms: terms, texts: bundleTexts([n, ...sql.exec<Row>("SELECT body FROM texts WHERE node_id = ?", n.id!).toArray()]) });
		return !g.ok && g.error.details?.term !== "personal_field";
	}).map((n) => String(n.id));
	return { ids, after: rows.length === 40 ? String(rows.at(-1)!.id) : null };
}

/** The wiped profile's own generation: its vectors by their generation-qualified ids, in pages, then every row. */
async function clear(storage: DurableObjectStorage, env: Env, who: Who): Promise<{ cleared: number }> {
	let cleared = 0;
	if (storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").toArray().length) {
		for (let after = ""; ;) {
			const ids = storage.sql.exec<{ id: string }>(`SELECT id FROM nodes WHERE id > ? ORDER BY id LIMIT ${PAGE}`, after).toArray().map((r) => r.id);
			if (!ids.length) break;
			if (env.VECTORS) await env.VECTORS.deleteByIds(ids.map((id) => vectorId(who, id)));
			cleared += ids.length;
			after = ids.at(-1)!;
		}
	}
	await storage.deleteAlarm();
	await storage.deleteAll();
	storage.sql.exec("CREATE TABLE IF NOT EXISTS profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
	storage.sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('closed', 'wiped')");
	return { cleared };
}

/** ProfileStore.purgeOrigin(who, step), after bind(who). Internal RPC only: the owner's wipe route is the one caller. */
export async function purgeOrigin(storage: DurableObjectStorage, env: Env, who: Who, step: WipeStep): Promise<Outcome<WipeOut>> {
	try {
		const sql = storage.sql;
		switch (step.op) {
			case "close":
				storage.transactionSync(() => sql.exec("INSERT OR REPLACE INTO profile_meta (key, value) VALUES ('closed', 'wiping')"));
				return ok({ cleared: 0 });
			case "fence": {
				return ok(storage.transactionSync(() => {
					const { preserved } = held(sql, who, step.wipe);
					const tx = new BudgetTx(sql, nextSeq(sql, "profile_meta"), new Date().toISOString());
					for (const id of fenced(step.wipe, preserved)) tx.run("INSERT OR IGNORE INTO profile_meta (key, value) VALUES (?, ?)", `wiped:${id}`, marker(step.wipe));
					return { done: true, purged: [], redacted: 0, preserved };
				}));
			}
			case "origin": return ok(originPage(sql, who, step.profile, step.after));
			case "requests": return ok(requestPage(sql, who, step.wipe, step.after));
			case "handwritten": return ok(handwrittenPage(sql, step.profile, step.terms, step.after));
			case "clear": return ok(await clear(storage, env, who));
			case "purge": {
				// Vectors go before their node row, so a failure leaves the node for the retry; ids are this generation's own.
				const live = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(held(sql, who, step.wipe).here)).toArray().map((r) => r.id);
				if (env.VECTORS && live.length) await env.VECTORS.deleteByIds(live.map((id) => vectorId(who, id)));
				return ok(storage.transactionSync(() => purge(sql, who, step.wipe)));
			}
		}
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		throw e;
	}
}

/** For the shared create, import and transfer paths: refuses to recreate an id a wipe purged from this profile. */
export function assertNotWiped(sql: SqlStorage, id: string): void {
	if (sql.exec("SELECT 1 FROM profile_meta WHERE key = ?", `wiped:${id}`).toArray().length) throw Fail.of("profile_wiped", "this record was purged by a profile wipe", { memory_id: id });
}

/** Checked inside every profile transaction, including replay, after the account's generation check. */
export function assertOpen(sql: SqlStorage): void {
	if (sql.exec("SELECT 1 FROM profile_meta WHERE key = 'closed'").toArray().length) throw Fail.of("profile_wiped", "this profile generation is closed");
}
