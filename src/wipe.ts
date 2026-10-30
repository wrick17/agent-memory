// Owner-only wipe of one profile (section 9, steps 1 to 6). The account closes the profile and records the wipe; the plan and
// every id page go to permanent R2 objects before anything is deleted; then copies elsewhere are purged, the profile's own
// generations cleared, and its indexes fenced. A retry replays the same plan. Backup replacement waits for the final stage.
import { Fail, ok, PROFILE_NAME, type Caller, type Outcome, type ProfileRef } from "./domain/types";
import { nextSeq } from "./storage";
import type { Page, PurgeResult, WipeOut, WipeStep } from "./profile/store";

export interface WipeRecord { profile: string; generations: string[]; wiped_at: string; marker_key: string; report: string }
export type WipeAccountCommand =
	| { op: "begin"; caller: Caller; profile: string; typed: string }
	| { op: "grants"; profile: string; after: string }
	| { op: "nodes"; profile: string; after: string }
	| { op: "forget"; profile: string; ids: string[]; requests: string[] }
	| { op: "finish"; profile: string; at: string; report: string };
export interface WipeAccountResult { record?: WipeRecord; refs?: ProfileRef[]; terms?: string[]; ids?: string[]; after?: string | null }
const record = (sql: SqlStorage, profile: string) => {
	const r = sql.exec<Omit<WipeRecord, "generations"> & { generations: string }>("SELECT profile, generations, wiped_at, marker_key, report FROM wipes WHERE profile = ? ORDER BY wiped_at DESC LIMIT 1", profile).toArray()[0];
	return r ? { ...r, generations: JSON.parse(r.generations) as string[] } : undefined;
};

/** Wired as internal AccountStore.wipe; begin is the sole user entry and verifies owner plus exact typed name. */
export function wipeAccount(storage: DurableObjectStorage, cmd: WipeAccountCommand): Outcome<WipeAccountResult> {
	try {
		return ok(storage.transactionSync(() => {
			const sql = storage.sql;
			const userId = sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = 'user_id'").one().value;
			// Every write below is bounded by its LIMIT or its 100-id page; the stamp is taken only by a command that writes.
			let stamp: number | undefined;
			const tx = { now: new Date().toISOString(), rows: 0, get seq() { return (stamp ??= nextSeq(sql, "account_meta")); },
				run(q: string, ...p: SqlStorageValue[]) { this.rows += sql.exec(q, ...p).rowsWritten; } };
			switch (cmd.op) {
				case "begin": {
					if (cmd.caller.kind !== "owner" || cmd.caller.userId !== userId) throw Fail.of("forbidden", "only the owner can wipe a profile");
					if (!PROFILE_NAME.test(cmd.profile) || cmd.typed !== cmd.profile) throw Fail.of("validation", "type the exact profile name to confirm its wipe");
					const p = sql.exec<{ status: string }>("SELECT status FROM profiles WHERE name = ?", cmd.profile).toArray()[0];
					if (!p) throw Fail.of("not_found", "unknown profile");
					let r = record(sql, cmd.profile);
					if (p.status === "active") {
						if (sql.exec("SELECT 1 FROM transfers WHERE (from_profile = ? OR to_profile = ?) AND state IN ('open','committing') LIMIT 1", cmd.profile, cmd.profile).toArray().length) throw Fail.of("moving", "finish or abort this profile's transfers before wiping it");
						const generations = sql.exec<{ id: string }>("SELECT id FROM generations WHERE profile = ?", cmd.profile).toArray().map((g) => g.id);
						r = { profile: cmd.profile, generations, wiped_at: tx.now, marker_key: `tombstones/${cmd.profile}-${tx.now}.json`, report: JSON.stringify({ state: "planning" }) };
						tx.run("UPDATE profiles SET status = 'wiping', seq = ? WHERE name = ?", tx.seq, cmd.profile);
						tx.run("INSERT INTO wipes (profile, generations, wiped_at, node_count, marker_key, report, seq) VALUES (?, ?, ?, 0, ?, ?, ?)", cmd.profile, JSON.stringify(generations), tx.now, r.marker_key, r.report, tx.seq);
					} else if (p.status !== "wiping" && p.status !== "wiped") throw Fail.of("validation", "profile is not available for a wipe");
					if (!r) throw Fail.of("validation", "closed profile has no durable wipe intent");
					// Every generation of the wiped profile is cleared; every other profile is purged in its active generation.
					const refs = sql.exec<{ profile: string; generation: string }>(`SELECT profile, id AS generation FROM generations
						WHERE (profile = ? AND state <> 'wiped') OR (profile <> ? AND state = 'active' AND profile IN (SELECT name FROM profiles WHERE status = 'active'))
						ORDER BY profile, id`, cmd.profile, cmd.profile).toArray().map((g) => ({ ...g, userId }));
					// The wiped profile's terms, taken before its rules go: registered terms plus the org names of its remote rules.
					const org = sql.exec<{ pattern: string }>("SELECT pattern FROM routing_rules WHERE profile = ? AND match = 'remote'", cmd.profile).toArray()
						.map((r) => r.pattern.split("/")[1] ?? "").filter((o) => o && !o.includes("*"));
					const terms = [...new Set([...org, ...sql.exec<{ term: string }>("SELECT term FROM sensitive_terms").toArray().map((t) => t.term)])];
					return { record: r, refs, terms };
				}
				case "grants": {
					const rows = sql.exec<{ id: string; profiles: string; default_profile: string | null }>("SELECT id, profiles, default_profile FROM devices WHERE id > ? ORDER BY id LIMIT 30", cmd.after).toArray();
					for (const d of rows) tx.run("UPDATE devices SET profiles = ?, default_profile = ?, seq = ? WHERE id = ?", JSON.stringify((JSON.parse(d.profiles) as string[]).filter((p) => p !== cmd.profile)), d.default_profile === cmd.profile ? null : d.default_profile, tx.seq, d.id);
					// Disabled rules route nowhere; delete them in bounded pages at the end.
					tx.run("UPDATE routing_rules SET enabled = 0, seq = ? WHERE id IN (SELECT id FROM routing_rules WHERE profile = ? AND enabled = 1 LIMIT 40)", tx.seq, cmd.profile);
					return { after: rows.length === 30 ? rows.at(-1)!.id : null };
				}
				case "nodes": {
					const ids = sql.exec<{ node_id: string }>("SELECT node_id FROM node_index WHERE profile = ? AND node_id > ? ORDER BY node_id LIMIT 100", cmd.profile, cmd.after).toArray().map((r) => r.node_id);
					return { ids, after: ids.length === 100 ? ids.at(-1)! : null };
				}
				case "forget": {
					if (cmd.ids.length > 100 || cmd.requests.length > 100 || Buffer.byteLength(JSON.stringify(cmd)) > 100_000) throw Fail.of("validation", "wipe index pages are limited to 100 ids and requests, 100 KB");
					for (const id of cmd.ids) tx.run("INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?)", `wiped:${id}`, cmd.profile);
					tx.run("DELETE FROM node_index WHERE node_id IN (SELECT value FROM json_each(?))", JSON.stringify(cmd.ids));
					tx.run("UPDATE request_index SET op = 'wiped', profile = ?, payload_hash = '', legacy = 0, pending = 0, seq = ? WHERE request_id IN (SELECT value FROM json_each(?))", cmd.profile, tx.seq, JSON.stringify(cmd.requests));
					return {};
				}
				case "finish": {
					const r = record(sql, cmd.profile);
					if (!r || r.wiped_at !== cmd.at) throw Fail.of("validation", "wipe identity changed");
					// Request ids survive as content-free refusals. Never let an old request create a fresh record.
					const requests = sql.exec<{ request_id: string }>("SELECT request_id FROM request_index WHERE profile = ? AND op <> 'wiped' LIMIT 100", cmd.profile).toArray();
					if (requests.length) {
						tx.run("UPDATE request_index SET op = 'wiped', payload_hash = '', legacy = 0, pending = 0, seq = ? WHERE request_id IN (SELECT value FROM json_each(?))", tx.seq, JSON.stringify(requests.map((q) => q.request_id)));
						return { after: "more" };
					}
					for (const q of ["DELETE FROM routing_rules WHERE id IN (SELECT id FROM routing_rules WHERE profile = ? LIMIT 40)", "DELETE FROM node_index WHERE node_id IN (SELECT node_id FROM node_index WHERE profile = ? LIMIT 100)"]) {
						const before = tx.rows; tx.run(q, cmd.profile); if (tx.rows > before) return { after: "more" };
					}
					const gens = sql.exec<{ id: string }>("SELECT id FROM generations WHERE profile = ? AND state <> 'wiped' LIMIT 40", cmd.profile).toArray();
					if (gens.length) { tx.run("UPDATE generations SET state = 'wiped', seq = ? WHERE id IN (SELECT value FROM json_each(?))", tx.seq, JSON.stringify(gens.map((g) => g.id))); return { after: "more" }; }
					tx.run("UPDATE wipes SET report = ?, seq = ? WHERE profile = ? AND wiped_at = ?", cmd.report, tx.seq, cmd.profile, cmd.at);
					tx.run("UPDATE profiles SET status = 'wiped', seq = ? WHERE name = ?", tx.seq, cmd.profile);
					return { after: null, record: record(sql, cmd.profile) };
				}
			}
		}));
	} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
}

export interface WipePorts {
	account(cmd: WipeAccountCommand): Promise<Outcome<WipeAccountResult>>;
	profile(ref: ProfileRef, step: WipeStep): Promise<Outcome<WipeOut>>;
}

/** Inside AccountStore: its own wipe commands directly, and the integrator's ProfileStore.purgeOrigin(who, step) by stub. */
export const wipePorts = (env: Env, storage: DurableObjectStorage): WipePorts => ({
	account: async (cmd) => wipeAccount(storage, cmd),
	profile: (ref, step) => (env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as
		{ purgeOrigin(who: ProfileRef, step: WipeStep): Promise<Outcome<WipeOut>> }).purgeOrigin(ref, step),
});
interface WipePlan { record: WipeRecord; refs: ProfileRef[] }
const value = <T>(r: Outcome<T>): T => { if (!r.ok) throw new Fail(r.error); return r.value; };

/** Invoked only by the owner route, never by an alarm. All storage loops use bounded, replayable RPC steps. */
export async function wipeProfile(env: Env, ports: WipePorts, caller: Caller, profile: string, typed: string): Promise<Outcome<WipeRecord>> {
	try {
		const page = async (ref: ProfileRef, step: WipeStep) => value(await ports.profile(ref, step)) as Page;
		const begun = value(await ports.account({ op: "begin", caller, profile, typed }));
		const r = begun.record!;
		if (JSON.parse(r.report).state === "done") return ok(r);
		const bucket = env.BACKUPS;
		if (!bucket) throw Fail.of("unavailable", "wipe requires the permanent R2 tombstone bucket");
		// The root object fixes generations and profile refs across a crash, before any profile content is purged.
		const old = await bucket.get(r.marker_key);
		const plan: WipePlan = old ? await old.json<WipePlan>() : { record: r, refs: begun.refs! };
		if (!old) await bucket.put(r.marker_key, JSON.stringify(plan), { onlyIf: { etagDoesNotMatch: "*" } });
		for (const ref of plan.refs.filter((x) => x.profile === profile)) value(await ports.profile(ref, { op: "close" }));
		const prefix = `${r.marker_key}/ids/`;
		const complete = `${r.marker_key}/planned`;
		if (!(await bucket.head(complete))) {
			const save = async (name: string, ids: string[]) => { if (ids.length) await bucket.put(`${prefix}${name}.json`, JSON.stringify(ids)); };
			let after = "", n = 0;
			do { const p = value(await ports.account({ op: "nodes", profile, after })); await save(`account-${n++}`, p.ids!); after = p.after ?? ""; } while (after);
			for (const ref of plan.refs) {
				after = ""; n = 0;
				do { const p = await page(ref, { op: "origin", profile, after }); await save(`${ref.profile}-${ref.generation}-${n++}`, p.ids); after = p.after ?? ""; } while (after);
			}
			await bucket.put(complete, "1");
		}
		let after = "";
		do { after = value(await ports.account({ op: "grants", profile, after })).after ?? ""; } while (after);
		// Counts of this run; a resumed run reports what it did itself.
		const counts = { purged: 0, redacted: 0, preserved: new Set<string>() };
		let cursor: string | undefined;
		do {
			const listed = await bucket.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
			for (const entry of listed.objects) {
				const obj = await bucket.get(entry.key); if (!obj) throw Fail.of("unavailable", "wipe id marker disappeared");
				const ids = await obj.json<string[]>();
				const preserved = new Set<string>();
				// Fence every possible destination before purging any copy, including a delayed landing into an empty target. me goes
				// first: its company-free survivors are then spared everywhere, so they keep their requests and can still move.
				const others = plan.refs.filter((x) => x.profile !== profile).sort((a, b) => Number(b.profile === "me") - Number(a.profile === "me"));
				for (const ref of others) {
					const fenced = value(await ports.profile(ref, { op: "fence", wipe: { profile, at: r.wiped_at, ids, terms: begun.terms!, keep: [...preserved] } })) as PurgeResult;
					fenced.preserved.forEach((id) => preserved.add(id));
				}
				value(await ports.account({ op: "forget", profile, ids: ids.filter((id) => !preserved.has(id)), requests: [] }));
				for (const ref of plan.refs.filter((x) => x.profile !== profile)) {
					// Bind every copied request to a content-free refusal before deleting its result. A crash cannot lose that list.
					after = "";
					do {
						const q = await page(ref, { op: "requests", wipe: { profile, at: r.wiped_at, ids, terms: begun.terms!, keep: [...preserved] }, after });
						if (q.ids.length) await bucket.put(`${r.marker_key}/requests/${ref.generation}-${encodeURIComponent(q.ids[0]!)}.json`, JSON.stringify(q.ids));
						value(await ports.account({ op: "forget", profile, ids: [], requests: q.ids }));
						after = q.after ?? "";
					} while (after);
					let purged: PurgeResult;
					do {
						purged = value(await ports.profile(ref, { op: "purge", wipe: { profile, at: r.wiped_at, ids, terms: begun.terms!, keep: [...preserved] } })) as PurgeResult;
						purged.preserved.forEach((id) => preserved.add(id));
						counts.purged += purged.purged.length; counts.redacted += purged.redacted;
					} while (!purged.done);
				}
				value(await ports.account({ op: "forget", profile, ids: ids.filter((id) => !preserved.has(id)), requests: [] }));
				preserved.forEach((id) => counts.preserved.add(id));
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
		for (const ref of plan.refs) {
			if (ref.profile === profile) {
				// Its vectors and rows go together, by generation; no row-by-row purge of a store that is deleted whole.
				value(await ports.profile(ref, { op: "clear" }));
				await bucket.put(`generations/${ref.generation}.json`, JSON.stringify({ id: ref.generation, profile, state: "wiped", at: r.wiped_at }));
			} else {
				after = "";
				do {
					const p = await page(ref, { op: "handwritten", profile, terms: begun.terms!, after });
					if (p.ids.length) await bucket.put(`${r.marker_key}/handwritten/${ref.generation}-${encodeURIComponent(p.ids[0]!)}.json`, JSON.stringify(p.ids));
					after = p.after ?? "";
				} while (after);
			}
		}
		// Digest migration objects only. Backup/export replacement is deliberately left for the final backup stage.
		let migrationCursor: string | undefined;
		do {
			const page = await bucket.list({ prefix: `migration/${profile}/`, limit: 100, ...(migrationCursor ? { cursor: migrationCursor } : {}) });
			if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
			migrationCursor = page.truncated ? page.cursor : undefined;
		} while (migrationCursor);
		const report = JSON.stringify({ state: "done", marker: r.marker_key, handwritten: `${r.marker_key}/handwritten/`, purged: counts.purged, redacted: counts.redacted,
			preserved: [...counts.preserved], backups: "deferred_final_stage" });
		let done: WipeAccountResult;
		do { done = value(await ports.account({ op: "finish", profile, at: r.wiped_at, report })); } while (done.after);
		return ok(done.record!);
	} catch (e) { if (e instanceof Fail) return { ok: false, error: e.failure }; throw e; }
}
