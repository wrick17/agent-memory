// v2 storage compatibility (issue #5): a populated v1 upgrade with no data change, pre-v2 and v2 exports restored under v2 code,
// unsupported versions refused, and the drill's choice of the newest restorable exports. Own file: an account restore here must reach
// ready, so it cannot share backup.test.ts's accumulated recovery state. Real workerd, SQLite and local R2; synthetic data only.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountRecovery, Recovery } from "../src/account/store";
import { ACCOUNT_MIGRATIONS } from "../src/account/schema";
import { readManifest, type Manifest } from "../src/backup";
import { accountStub } from "../src/mcp";
import { PROFILE_MIGRATIONS } from "../src/profile/schema";
import { migrate } from "../src/storage";
import { call, contextFor, deviceToken, journal, OWNER } from "./helpers";

const admin = (cmd: Parameters<ReturnType<typeof accountStub>["admin"]>[0]) => accountStub(env, OWNER).admin(cmd);
const value = async <T,>(p: Promise<{ ok: boolean; value?: unknown; error?: unknown }>) => {
	const r = await p;
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value as T;
};
async function stepUntilChecked(): Promise<Recovery> {
	for (let i = 0; i < 20; i++) {
		const r = await value<Recovery>(admin({ op: "restoreStep" }));
		if (r.state !== "restoring" && r.state !== "settling" && r.state !== "checking") return r;
	}
	throw new Error("restore did not finish");
}
const accountSql = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => f(st.storage.sql));
const genOf = async (name: string) => (await value<{ name: string; generation: string }[]>(admin({ op: "listProfiles" }))).find((p) => p.name === name)!.generation;

describe("v2 storage compatibility (issue #5)", () => {
	const AT = "2026-11-04T00:00:00.000Z";
	const profileAt = async <T,>(f: (st: DurableObjectStorage) => T) => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${await genOf("personal")}`)), (_i, st) => f(st.storage));
	const profileSql = <T,>(f: (sql: SqlStorage) => T) => profileAt((st) => f(st.sql));
	const relabel = (sql: SqlStorage, meta: string, v: number) => sql.exec(`UPDATE ${meta} SET value = ? WHERE key = 'schema_version'`, String(v));
	/** Every row of every table but the named ones, order-free; the schema version is the one meta row a migration may change. */
	const dump = (sql: SqlStorage, meta: string, skip: string[] = []) => Object.fromEntries(sql.exec<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").toArray()
		.filter((r) => !skip.includes(r.name))
		.map(({ name }) => [name, sql.exec(`SELECT * FROM "${name}"`).toArray().filter((r) => !(name === meta && r.key === "schema_version")).map((r) => JSON.stringify(r)).sort()]));
	const ddl = (sql: SqlStorage, name: string) => sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?", name).toArray()[0]?.sql;
	const NEW_PROFILE = ["recall_daily", "recall_totals", "eval_candidates"], NEW_ACCOUNT = ["eval_runs", "client_status", "health"];
	/** Puts a v9 profile back into the deployed v8 shape: no v2 tables, and maintenance under v2's DDL, indexes and triggers. */
	const toV8 = (sql: SqlStorage) => {
		for (const t of NEW_PROFILE) sql.exec(`DROP TABLE ${t}`);
		const v2 = PROFILE_MIGRATIONS[1]!;
		sql.exec("ALTER TABLE maintenance RENAME TO maintenance_old");
		sql.exec(v2.find((s) => s.startsWith("CREATE TABLE maintenance ("))!);
		sql.exec("INSERT INTO maintenance SELECT * FROM maintenance_old");
		sql.exec("DROP TABLE maintenance_old");
		for (const s of v2.filter((x) => /^CREATE (INDEX|TRIGGER) maintenance_/.test(x))) sql.exec(s);
		relabel(sql, "profile_meta", 8);
	};
	const exportOf = async (profile?: string) => value<Record<string, { id: string }>>(admin({ op: "export", ...(profile ? { profile } : {}), preserve_existing: true }));
	const restoreProfile = async (id: string) => {
		await value(admin({ op: "beginRestore", profile: "personal", export: id }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved_count: 0 });
		await value(admin({ op: "openRestore" }));
	};
	const restoreAccount = async (id: string) => {
		await value(admin({ op: "beginAccountRestore", export: id }));
		let r = await value<AccountRecovery>(admin({ op: "restoreStep" }));
		for (let i = 0; i < 40 && ["checkpoint", "applying", "reconciling"].includes(r.state); i++) r = await value<AccountRecovery>(admin({ op: "restoreStep" }));
		expect({ state: r.state, unresolved: r.unresolved }).toEqual({ state: "ready", unresolved: [] });
		await value(admin({ op: "openRestore" }));
	};
	const tick = () => new Promise((r) => setTimeout(r, 3)); // export ids order by their millisecond

	it("upgrades a populated v8 profile with no data change, restores its v8 export and a v9 export, and refuses other versions", async () => {
		const c = await contextFor();
		const rule = await call(c, "save_memory", { name: "V8 rule", type: "feedback", description: "v8", content: "v8 rule body", profile: "personal", request_id: "v8-rule" });
		await call(c, "save_memory", { memory_id: rule.memory_id, content: "v8 rule body, revised", request_id: "v8-rule-2" });
		const j = await journal(c, "codex: v8 journal");
		for (let i = 1; i <= 2; i++) await call(c, "append_memory", { memory_id: j.memory_id, content: `v8 entry ${i}`, request_id: `v8-app-${i}` });
		await profileSql((sql) => {
			toV8(sql);
			sql.exec(`INSERT INTO maintenance (id, kind, subjects, fingerprint, state, lease_id, lease_until, attempts, created_at, done_at, outcome, seq)
				VALUES (9001, 'stale_journal', ?, 'v8-item', 'done', 'v8-lease', ?, 1, ?, ?, 'kept', 1)`, JSON.stringify([j.memory_id]), AT, AT, AT);
		});
		const v8 = (await exportOf("personal")).personal!.id;
		const m8 = await value<Manifest>(readManifest(env, "profile-personal", v8, OWNER));
		expect(m8.schema_version).toBe(8);
		expect(Object.keys(m8.counts)).not.toContain("recall_daily");

		// The upgrade, as a deploy's constructor runs it: every earlier row stays as it was, and maintenance keeps its rows, indexes and triggers.
		await profileAt((st) => {
			const sql = st.sql, before = dump(sql, "profile_meta");
			migrate(st, "profile_meta", PROFILE_MIGRATIONS);
			expect(sql.exec("SELECT value FROM profile_meta WHERE key = 'schema_version'").one().value).toBe("9");
			expect(dump(sql, "profile_meta", NEW_PROFILE)).toEqual(before);
			expect(ddl(sql, "maintenance")).toContain("'stale_memory'");
			expect(sql.exec("SELECT name FROM sqlite_master WHERE tbl_name = 'maintenance' AND type IN ('index', 'trigger') ORDER BY name").toArray().map((r) => r.name))
				.toEqual(expect.arrayContaining(["maintenance_open", "maintenance_seq", "maintenance_tomb_del", "maintenance_tomb_ins"]));
			sql.exec("INSERT INTO maintenance (kind, subjects, fingerprint, created_at, seq) VALUES ('stale_memory', '[]', 'v9-item', ?, 2)", AT);
			expect(() => sql.exec("INSERT INTO maintenance (kind, subjects, fingerprint, created_at, seq) VALUES ('not_a_kind', '[]', 'bad-item', ?, 2)", AT)).toThrow(/CHECK/);
			sql.exec("DELETE FROM maintenance WHERE fingerprint = 'v9-item'");
			expect(sql.exec("SELECT count(*) AS n FROM deleted_rows WHERE tbl = 'maintenance'").one().n).toBe(1);
			sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES (?, '2026-11-04', 3, 2)", rule.memory_id);
			sql.exec("INSERT INTO recall_totals (day, recalls, tokens, seq) VALUES ('2026-11-04', 4, 120, 2)");
			sql.exec("INSERT INTO eval_candidates (id, query, expected_json, evidence_json, created_at, seq) VALUES ('ec-1', 'v8 rule', ?, '{}', ?, 2)", JSON.stringify([rule.memory_id]), AT);
			sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES ('gone', '2026-11-03', 1, 2)");
			sql.exec("DELETE FROM recall_daily WHERE node_id = 'gone'");
			expect(sql.exec("SELECT pk FROM deleted_rows WHERE tbl = 'recall_daily'").toArray()).toEqual([{ pk: JSON.stringify(["gone", "2026-11-03"]) }]);
		});
		// Replay after the upgrade returns the stored results.
		expect(await call(c, "append_memory", { memory_id: j.memory_id, content: "v8 entry 2", request_id: "v8-app-2" })).toMatchObject({ revision: 3 });
		const v9 = (await exportOf("personal")).personal!.id;
		expect(await value<Manifest>(readManifest(env, "profile-personal", v9, OWNER))).toMatchObject({ schema_version: 9, counts: { recall_daily: 1, recall_totals: 1, eval_candidates: 1 } });

		// v2 code restores the pre-v2 export: its rows land in v9 tables, and the v2 tables start empty.
		await restoreProfile(v8);
		const after = await contextFor();
		expect(await call(after, "get_memory", { memory_id: rule.memory_id })).toMatchObject({ content: "v8 rule body, revised", revision: 2 });
		expect((await call<{ revisions: { operation: string }[] }>(after, "get_memory", { memory_id: j.memory_id, history: { limit: 10 } })).revisions.map((r) => r.operation))
			.toEqual(["saved", "appended", "appended"]);
		expect(await call(after, "append_memory", { memory_id: j.memory_id, content: "v8 entry 1", request_id: "v8-app-1" })).toMatchObject({ revision: 2 });
		expect(await profileSql((sql) => [sql.exec("SELECT value FROM profile_meta WHERE key = 'schema_version'").one().value, ...NEW_PROFILE.map((t) => sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n),
			sql.exec("SELECT kind, state, outcome FROM maintenance WHERE fingerprint = 'v8-item'").toArray()])).toEqual(["9", 0, 0, 0, [{ kind: "stale_journal", state: "done", outcome: "kept" }]]);

		// A v9 export restores with its v2 rows.
		await restoreProfile(v9);
		expect(await profileSql((sql) => [sql.exec("SELECT hits FROM recall_daily").toArray(), sql.exec("SELECT recalls, tokens FROM recall_totals").toArray(), sql.exec("SELECT id, status FROM eval_candidates").toArray()]))
			.toEqual([[{ hits: 3 }], [{ recalls: 4, tokens: 120 }], [{ id: "ec-1", status: "pending" }]]);
		expect(await call(await contextFor(), "get_memory", { memory_id: rule.memory_id })).toMatchObject({ content: "v8 rule body, revised", revision: 2 });

		// Below the floor or above this code's schema: refused before any recovery opens.
		const refused: string[] = [];
		for (const v of [7, 10]) {
			await profileSql((sql) => relabel(sql, "profile_meta", v));
			refused.push((await exportOf("personal")).personal!.id);
		}
		await profileSql((sql) => relabel(sql, "profile_meta", 9));
		for (const id of refused) expect(await admin({ op: "beginRestore", profile: "personal", export: id })).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringContaining("not restorable") } });
		expect(await value(admin({ op: "restoreStatus" }))).toMatchObject({ recovery: null });
	});

	it("upgrades a populated v6 account with no data change, restores its v6 export with the v2 tables empty and a v7 export with them, and refuses other versions", async () => {
		const c = await contextFor();
		const kept = await call(c, "save_memory", { name: "V6 account", type: "reference", description: "v6", content: "v6 account body", profile: "personal", request_id: "v6-acct" });
		await deviceToken("v6-device", ["read"], ["personal"]);
		await accountSql((sql) => { for (const t of NEW_ACCOUNT) sql.exec(`DROP TABLE ${t}`); relabel(sql, "account_meta", 6); });
		const a6 = (await exportOf()).account!.id;
		expect(await value<Manifest>(readManifest(env, "account", a6, OWNER))).toMatchObject({ schema_version: 6 });
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => {
			const sql = st.storage.sql, before = dump(sql, "account_meta");
			migrate(st.storage, "account_meta", ACCOUNT_MIGRATIONS);
			expect(sql.exec("SELECT value FROM account_meta WHERE key = 'schema_version'").one().value).toBe("7");
			expect(dump(sql, "account_meta", NEW_ACCOUNT)).toEqual(before);
			sql.exec("INSERT INTO eval_runs (id, profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr, device_id) VALUES ('run-1', 'personal', ?, 'lexical,vector', 10, 20, 0.5, 0.75, 0.6, 'dev')", AT);
			sql.exec("INSERT INTO client_status (device_id, reported_at, body) VALUES ('dev', ?, '{\"ok\":true}')", AT);
			sql.exec("INSERT INTO health (check_id, subject, state, detail, at) VALUES ('export_age', 'personal', 'ok', 'fresh', ?)", AT);
		});
		const a7 = (await exportOf()).account!.id;
		expect(await value<Manifest>(readManifest(env, "account", a7, OWNER))).toMatchObject({ schema_version: 7, counts: { eval_runs: 1, client_status: 1, health: 1 } });
		const counts = () => accountSql((sql) => NEW_ACCOUNT.map((t) => sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n));

		await restoreAccount(a6);
		expect(await counts()).toEqual([0, 0, 0]);
		expect(await accountSql((sql) => sql.exec("SELECT name, enabled FROM devices WHERE name = 'v6-device'").toArray())).toEqual([{ name: "v6-device", enabled: 0 }]);
		expect(await call(await contextFor(), "get_memory", { memory_id: kept.memory_id })).toMatchObject({ content: "v6 account body" });
		await restoreAccount(a7);
		expect(await counts()).toEqual([1, 1, 1]);

		const refused: string[] = [];
		for (const v of [5, 8]) {
			await accountSql((sql) => relabel(sql, "account_meta", v));
			refused.push((await exportOf()).account!.id);
		}
		await accountSql((sql) => relabel(sql, "account_meta", 7));
		for (const id of refused) expect(await admin({ op: "beginAccountRestore", export: id })).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringContaining("not restorable") } });
		expect(await value(admin({ op: "restoreStatus" }))).toMatchObject({ recovery: null });
	});

	it("the drill chooses the newest restorable profile and account exports, passing over newer unsupported ones", async () => {
		await call(await contextFor(), "save_memory", { name: "Drill v8", type: "reference", description: "d", content: "drill v8 body", profile: "personal" });
		const a7 = (await exportOf()).account!.id;
		await tick();
		await accountSql((sql) => relabel(sql, "account_meta", 8));
		await exportOf();
		await accountSql((sql) => relabel(sql, "account_meta", 7));
		await tick();
		await profileSql((sql) => relabel(sql, "profile_meta", 8));
		const p8 = (await exportOf("personal")).personal!.id;
		await tick();
		await profileSql((sql) => relabel(sql, "profile_meta", 10));
		await exportOf("personal");
		await profileSql((sql) => relabel(sql, "profile_meta", 9));
		const begun = await value<{ id: string; export: string; account_export: string | null }>(admin({ op: "beginDrill", profile: "personal", request_id: "drill-v8" }));
		expect(begun).toMatchObject({ export: p8, account_export: a7 });
		let d = await value<{ state: string; passed?: boolean }>(admin({ op: "drillStep", id: begun.id }));
		for (let i = 0; i < 40 && d.state !== "done"; i++) d = await value(admin({ op: "drillStep", id: begun.id }));
		expect(d).toMatchObject({ state: "done", passed: true });
	});
});
