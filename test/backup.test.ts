// Encrypted export and restore from an export (section 18): one real workerd, SQLite and local R2 roundtrip, plus the
// refusals that guard against data loss and stray writes. Synthetic key and data only.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountRecovery, Recovery } from "../src/account/store";
import { readChunk, readManifest, type Manifest } from "../src/backup";
import { fail, type Outcome } from "../src/domain/types";
import { accountStub, profileStub } from "../src/mcp";
import type { ProfileStore } from "../src/profile/store";
import { wipePorts, wipeProfile } from "../src/wipe";
import { call, contextFor, devicePrincipal, deviceToken, journal, OWNER, outcome } from "./helpers";

const admin = (cmd: Parameters<ReturnType<typeof accountStub>["admin"]>[0]) => accountStub(env, OWNER).admin(cmd);
const value = async <T,>(p: Promise<{ ok: boolean; value?: unknown; error?: unknown }>) => {
	const r = await p;
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value as T;
};
async function stepUntilChecked(): Promise<Recovery> {
	for (let i = 0; i < 20; i++) {
		const r = await value<Recovery>(admin({ op: "restoreStep" }));
		if (r.state !== "restoring" && r.state !== "checking") return r;
	}
	throw new Error("restore did not finish");
}
const personal = async () => (await value<{ name: string; generation: string }[]>(admin({ op: "listProfiles" }))).find((p) => p.name === "personal")!.generation;

describe("export and restore", () => {
	it("restores memory, history and request state into a new generation, and refuses while recovering", async () => {
		const c = await contextFor();
		const rule = await call(c, "save_memory", { name: "Backup rule", type: "feedback", description: "a rule", content: "zebra-marker restore body", profile: "personal", request_id: "bk-rule" });
		const j = await journal(c, "codex: backup journal");
		for (let i = 1; i <= 3; i++) await call(c, "append_memory", { memory_id: j.memory_id, content: `entry ${i}`, request_id: `bk-app-${i}` });
		const retired = await call(c, "save_memory", { name: "Retired note", type: "reference", description: "old", content: "old body", profile: "personal" });
		await call(c, "save_memory", { memory_id: retired.memory_id, retire: true });

		const exported = await value<Record<string, { id: string; rows: number }>>(admin({ op: "export", profile: "personal" }));
		const id = exported.personal!.id;
		expect(await value<string[]>(admin({ op: "listExports", profile: "personal" }))).toContain(id);
		// Encrypted at rest: no export object holds the plaintext body.
		const objects = await env.BACKUPS.list({ prefix: `exports/profile-personal/${id}/` });
		expect(objects.objects.some((o) => o.key.endsWith("manifest.enc"))).toBe(true);
		for (const o of objects.objects) expect(new TextDecoder().decode(await (await env.BACKUPS.get(o.key))!.arrayBuffer())).not.toContain("zebra-marker");

		const lost = await call(c, "save_memory", { name: "After export", type: "reference", description: "later", content: "written after the export", profile: "personal", request_id: "bk-later" });
		const from = await personal();

		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: id }));
		expect(begun).toMatchObject({ state: "restoring", from, export: id });
		expect(await outcome(c, "get_memory", { memory_id: rule.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await outcome(c, "save_memory", { name: "During recovery", type: "reference", description: "x", content: "x", profile: "personal" })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await admin({ op: "export" })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await admin({ op: "beginRestore", profile: "personal", export: id })).toMatchObject({ ok: false, error: { code: "busy" } });
		// Only the open restore may write into its reserved generation.
		const h = { userId: OWNER, profile: "personal", generation: begun.to! };
		const stray = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${h.generation}`)) as unknown as Pick<ProfileStore, "restoreStep">;
		expect(await stray.restoreStep(h, { id: "not-this-restore", exportId: id })).toMatchObject({ ok: false, error: { code: "forbidden" } });

		const checked = await stepUntilChecked();
		expect(checked).toMatchObject({ state: "ready", unresolved_count: 0 });
		expect(await outcome(c, "get_memory", { memory_id: rule.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await personal()).toBe(begun.to);

		const after = await contextFor();
		expect(await call(after, "get_memory", { memory_id: rule.memory_id })).toMatchObject({ content: "zebra-marker restore body", revision: 1 });
		expect((await call(after, "get_memory", { memory_id: j.memory_id })).content).toBe("entry 1\nentry 2\nentry 3");
		const history = await call<{ revisions: { operation: string }[] }>(after, "get_memory", { memory_id: j.memory_id, history: { limit: 10 } });
		expect(history.revisions.map((r) => r.operation)).toEqual(["saved", "appended", "appended", "appended"]);
		expect(await call(after, "get_memory", { memory_id: retired.memory_id, include_retired: true })).toMatchObject({ status: "retired" });
		const found = await call<{ results: { memory_id: string }[] }>(after, "recall_memories", { keyword: "zebra-marker", profile: "personal" });
		expect(found.results.map((r) => r.memory_id)).toContain(rule.memory_id);
		// Request state: an exported request replays its stored result; one written after the export is gone with its record.
		expect(await call(after, "append_memory", { memory_id: j.memory_id, content: "entry 2", request_id: "bk-app-2" })).toMatchObject({ revision: 3 });
		expect(await outcome(after, "get_memory", { memory_id: lost.memory_id })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const again = await call(after, "save_memory", { name: "After export", type: "reference", description: "later", content: "written after the export", profile: "personal", request_id: "bk-later" });
		expect(again).toMatchObject({ memory_id: lost.memory_id, revision: 1 }); // applied afresh, not refused as a stale binding
		// The replaced generation is closed to every call.
		const old = { userId: OWNER, profile: "personal", generation: from };
		expect(await profileStub(env, old).read(old, { kind: "get", id: rule.memory_id } as never)).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	});

	it("leaves Miniflare's object-name table out of the export and the fresh-generation check, and still refuses populated application tables", async () => {
		const c = await contextFor();
		const rule = await call(c, "save_memory", { name: "Platform rule", type: "feedback", description: "a rule", content: "platform-marker body", profile: "personal", request_id: "bk-platform" });
		const stubOf = (g: string) => env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${g}`));
		// What Miniflare's Durable Object wrapper writes into every named object's SQLite on a local run.
		const seedName = (g: string) => runInDurableObject(stubOf(g), (_o, state) => {
			state.storage.sql.exec("CREATE TABLE IF NOT EXISTS __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)");
			state.storage.sql.exec("INSERT OR REPLACE INTO __miniflare_do_name (id, name) VALUES (1, ?)", `${OWNER}:personal:${g}`);
		});
		await seedName(await personal());
		const id = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		const m = await value<{ counts: Record<string, number>; chunks: { table: string }[] }>(readManifest(env, "profile-personal", id, OWNER));
		expect(m.counts).not.toHaveProperty("__miniflare_do_name");
		expect(m.chunks.map((ch) => ch.table)).not.toContain("__miniflare_do_name");

		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: id }));
		await seedName(begun.to!);
		await runInDurableObject(stubOf(begun.to!), (_o, state) => { state.storage.sql.exec("INSERT INTO upload_receipts (request_id, at, key, revision, seq) VALUES ('stray', '2026-01-01', 'k', 'r', 0)"); });
		expect(await admin({ op: "restoreStep" })).toMatchObject({ ok: false, error: { code: "validation", message: "a restore needs a fresh generation" } });
		await runInDurableObject(stubOf(begun.to!), (_o, state) => { state.storage.sql.exec("DELETE FROM upload_receipts"); });
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved_count: 0 });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await call(await contextFor(), "get_memory", { memory_id: rule.memory_id })).toMatchObject({ content: "platform-marker body" });
		// The restored generation keeps its own platform identity.
		expect(await runInDurableObject(stubOf(begun.to!), (_o, state) => state.storage.sql.exec<{ name: string }>("SELECT name FROM __miniflare_do_name").one().name))
			.toBe(`${OWNER}:personal:${begun.to}`);
	});

	it("keeps the account closed on a corrupt chunk or a wiped record until the owner aborts", async () => {
		const c = await contextFor();
		const keep = await call(c, "save_memory", { name: "Kept rule", type: "feedback", description: "kept", content: "kept body", profile: "personal" });
		const id = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		const from = await personal();

		// A corrupt chunk fails its check, and nothing opens.
		const chunk = `exports/profile-personal/${id}/00000.enc`, original = new Uint8Array(await (await env.BACKUPS.get(chunk))!.arrayBuffer());
		const bad = original.slice(); bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
		await env.BACKUPS.put(chunk, bad);
		await value(admin({ op: "beginRestore", profile: "personal", export: id }));
		expect(await admin({ op: "restoreStep" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await admin({ op: "openRestore" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await outcome(c, "get_memory", { memory_id: keep.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect(await personal()).toBe(from);
		expect(await call(c, "get_memory", { memory_id: keep.memory_id })).toMatchObject({ content: "kept body" });

		// An export holding a record a wipe purged stays unresolved: it cannot bring the record back.
		await env.BACKUPS.put(chunk, original);
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => {
			s.storage.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, 'work')", `wiped:${keep.memory_id}`);
		});
		await value(admin({ op: "beginRestore", profile: "personal", export: id }));
		const checked = await stepUntilChecked();
		expect(checked.state).toBe("unresolved");
		expect(checked.unresolved).toContainEqual({ kind: "wiped_node", id: keep.memory_id });
		expect(await admin({ op: "openRestore" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect(await personal()).toBe(from);
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => { s.storage.sql.exec("DELETE FROM account_meta WHERE key = ?", `wiped:${keep.memory_id}`); });
	});

	it("bounds every restore and index rebuild transaction to 1,000 physical rows and 1 MB", async () => {
		const c = await contextFor();
		const seed = await call(c, "save_memory", { name: "budget seed", type: "reference", description: "fixture", content: "fixture body", profile: "personal" });
		const ref = c.account.profiles.find((p) => p.profile === "personal")!;
		// 500 more nodes and 150 texts of 10,000 characters: one nodes chunk of 500 rows and about 1.5 MB of text.
		await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${ref.generation}`)), (_i, s) => {
			const sql = s.storage.sql;
			const n = sql.exec("SELECT * FROM nodes WHERE id = ?", seed.memory_id as string), nc = n.columnNames, nr = [...n.raw()][0]!;
			const t = sql.exec("SELECT * FROM texts WHERE node_id = ? LIMIT 1", seed.memory_id as string), tc = t.columnNames, tr = [...t.raw()][0]!;
			for (let i = 0; i < 500; i++) {
				const r = [...nr]; for (const k of ["id", "name", "norm_name"]) r[nc.indexOf(k)] = `budget-${i}`;
				sql.exec(`INSERT INTO nodes (${nc.map((k) => `"${k}"`).join(",")}) VALUES (${nc.map(() => "?").join(",")})`, ...r);
				if (i < 150) {
					const x = [...tr]; x[tc.indexOf("rowid")] = 100_000 + i; x[tc.indexOf("node_id")] = `budget-${i}`; x[tc.indexOf("body")] = `w${i} `.padEnd(10_000, "é");
					sql.exec(`INSERT INTO texts (${tc.map((k) => `"${k}"`).join(",")}) VALUES (${tc.map(() => "?").join(",")})`, ...x);
				}
			}
		});
		const id = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		const stubOf = (generation: string) => env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${generation}`));
		const m = await value<{ chunks: { table: string; rows: number }[]; counts: Record<string, number> }>(readManifest(env, "profile-personal", id, OWNER));
		expect(m.chunks.filter((x) => x.table === "nodes").map((x) => x.rows)).toContain(500);
		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: id }));
		// Physical rows and bound UTF-8 bytes of every transaction, in the restored generation and in the account.
		const peaks = { profile: { rows: 0, bytes: 0, txs: 0 }, account: { rows: 0, bytes: 0, txs: 0 } };
		const watch = (s: DurableObjectState, peak: { rows: number; bytes: number; txs: number }) => {
			const exec = s.storage.sql.exec.bind(s.storage.sql), tx = s.storage.transactionSync.bind(s.storage);
			let rows = 0, bytes = 0;
			s.storage.sql.exec = ((q: string, ...p: SqlStorageValue[]) => {
				const cur = exec(q, ...p);
				rows += cur.rowsWritten;
				for (const v of p) if (typeof v === "string") bytes += new TextEncoder().encode(v).length;
				return cur;
			}) as typeof s.storage.sql.exec;
			s.storage.transactionSync = (<T,>(fn: () => T): T => {
				rows = 0; bytes = 0;
				const out = tx(fn);
				peak.rows = Math.max(peak.rows, rows); peak.bytes = Math.max(peak.bytes, bytes); peak.txs++;
				return out;
			}) as typeof s.storage.transactionSync;
		};
		await runInDurableObject(stubOf(begun.to!), (_i, s) => watch(s, peaks.profile));
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => watch(s, peaks.account));
		const checked = await stepUntilChecked();
		if (checked.state !== "ready") console.log(JSON.stringify(checked).slice(0, 1500));
		expect(checked).toMatchObject({ state: "ready" });
		for (let i = 0; i < 20 && (await value<{ state: string }>(admin({ op: "openRestore" }))).state !== "opened"; i++);
		expect(await personal()).toBe(begun.to);
		console.log(JSON.stringify({ control: "restore-budget", peaks }));
		expect(peaks.profile.txs).toBeGreaterThan(4);
		for (const p of [peaks.profile, peaks.account]) { expect(p.rows).toBeLessThanOrEqual(1000); expect(p.bytes).toBeLessThanOrEqual(1_000_000); }
		const after = await contextFor();
		expect(await call(after, "get_memory", { memory_id: seed.memory_id })).toMatchObject({ content: "fixture body" });
		await runInDurableObject(stubOf(begun.to!), (_i, s) => {
			expect(s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM nodes").one().n).toBe(m.counts.nodes);
			expect(s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM texts WHERE length(body) = 10000").one().n).toBe(150);
		});
	});

	it("a work wipe deletes the work exports and replaces the others with clean ones before done", async () => {
		const c = await contextFor(), marker = "PURGED_WORK_MARKER_77";
		await call(c, "save_memory", { name: "work secret", type: "reference", description: "w", content: marker, profile: "work" });
		await call(c, "save_memory", { name: "personal keep", type: "reference", description: "p", content: "PERSONAL_KEEP_77", profile: "personal" });
		const first = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		const ledger = async () => (await env.BACKUPS.list({ prefix: "generations/" })).objects.length;
		const before = await ledger();

		// Fail closed: without the replacement port, or when replacement fails, the wipe stops short of done and keeps its state.
		const wipeWith = (backups?: () => Promise<Outcome<unknown>>) =>
			runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) =>
				wipeProfile(env, { ...wipePorts(env, s.storage), ...(backups ? { backups } : {}) }, { userId: OWNER, kind: "owner", scopes: ["read", "write"], profiles: "*" }, "work", "work"));
		expect(await wipeWith()).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await wipeWith(async () => fail("unavailable", "injected R2 failure"))).toMatchObject({ ok: false, error: { message: "injected R2 failure" } });
		const status = await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) =>
			s.storage.sql.exec<{ report: string }>("SELECT report FROM wipes WHERE profile = 'work' ORDER BY wiped_at DESC LIMIT 1").one().report);
		expect(JSON.parse(status).state).toBe("backups");
		expect(await admin({ op: "export" })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await admin({ op: "beginRestore", profile: "personal", export: "latest" })).toMatchObject({ ok: false, error: { code: "busy" } });

		// The owner's retry resumes at the backup step and finishes.
		const wiped = await value<{ report: string }>(admin({ op: "wipeProfile", profile: "work", typed: "work" }));
		const report = JSON.parse(wiped.report) as { state: string; backups: { deleted: Record<string, string[]>; replaced: string[] } };
		expect(report.state).toBe("done");
		expect(report.backups.deleted["profile-work"]).toContain(first.work!.id);
		expect(report.backups.replaced).toEqual(expect.arrayContaining(["profile-personal", "account"]));
		expect(report.backups.deleted["profile-personal"]).toContain(first.personal!.id);
		expect((await env.BACKUPS.list({ prefix: "exports/profile-work/" })).objects).toHaveLength(0);
		expect(await readManifest(env, "profile-personal", first.personal!.id, OWNER)).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(await ledger()).toBeGreaterThanOrEqual(before);
		expect((await env.BACKUPS.list({ prefix: "tombstones/" })).objects.length).toBeGreaterThan(0);
		// Every export left decrypts, holds no purged body, and the personal one still holds the unrelated personal memory.
		let personalKept = false;
		for (const store of ["profile-personal", "account", "profile-me", "profile-test"]) {
			for (const exportId of (await value<string[]>(admin({ op: "listExports", profile: store.replace("profile-", "") }))).filter(() => store !== "account")) {
				const m = await value<Parameters<typeof readChunk>[1]>(readManifest(env, store, exportId, OWNER));
				for (let i = 0; i < m.chunks.length; i++) {
					const text = JSON.stringify(await readChunk(env, m, i));
					expect(text).not.toContain(marker);
					if (store === "profile-personal" && text.includes("PERSONAL_KEEP_77")) personalKept = true;
				}
			}
		}
		const acct = await value<Parameters<typeof readChunk>[1]>(readManifest(env, "account", "latest", OWNER));
		for (let i = 0; i < acct.chunks.length; i++) expect(JSON.stringify(await readChunk(env, acct, i))).not.toContain(marker);
		expect(personalKept).toBe(true);
		expect(await call(await contextFor(), "get_memory", { name: "personal keep", type: "reference", profile: "personal" } as never)).toMatchObject({ content: "PERSONAL_KEEP_77" });
	});

	it("restores the account in place: closed first, every device token disabled, newer generations and records kept, and a failure rolls back durably", async () => {
		const c = await contextFor();
		const before = await call(c, "save_memory", { name: "Account before", type: "reference", description: "a", content: "before body", profile: "personal", request_id: "acct-before" });
		const old = await deviceToken("acct-old", ["read"], ["personal"]);
		const exported = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		// After the export: a profile restore activates a newer generation, a record and its request land there, one token is revoked and one made.
		await value(admin({ op: "beginRestore", profile: "personal", export: exported.personal!.id }));
		await stepUntilChecked();
		await value(admin({ op: "openRestore" }));
		const newer = await personal();
		const afterArgs = { name: "Account after", type: "reference", description: "b", content: "after body", profile: "personal", request_id: "acct-after" };
		const after = await call(await contextFor(), "save_memory", afterArgs);
		await value(admin({ op: "revokeDevice", id: old.id }));
		const fresh = await deviceToken("acct-fresh", ["read"], ["personal"]);
		const deviceOk = async (token: string) => (await accountStub(env, OWNER).context(devicePrincipal(token))).ok;
		const accountSql = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => f(st.storage.sql));
		const step = async () => {
			for (let i = 0; i < 40; i++) {
				const r = await admin({ op: "restoreStep" });
				if (!r.ok) return r;
				if (!["checkpoint", "applying", "reconciling", "rolling_back"].includes((r.value as AccountRecovery).state)) return r;
			}
			throw new Error("account restore did not finish");
		};
		expect(await deviceOk(fresh.token)).toBe(true);

		// The last chunk is corrupt: every earlier chunk applies, the progress stops at it, and the account stays closed.
		const m = await value<Manifest>(readManifest(env, "account", exported.account!.id, OWNER));
		const last = m.chunks.at(-1)!.key, original = new Uint8Array(await (await env.BACKUPS.get(last))!.arrayBuffer());
		const bad = original.slice(); bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
		await env.BACKUPS.put(last, bad);
		expect(await value(admin({ op: "beginAccountRestore", export: exported.account!.id }))).toMatchObject({ kind: "account", state: "checkpoint" });
		expect(await outcome(c, "get_memory", { memory_id: before.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await admin({ op: "createDevice", name: "while-closed", scopes: ["read"], profiles: ["personal"] })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect((await accountStub(env, OWNER).context({ kind: "owner", userId: OWNER })).ok).toBe(true); // the owner's login needs no device row
		expect(await step()).toMatchObject({ ok: false, error: { code: "validation" } });
		const mid = (await value<{ recovery: AccountRecovery }>(admin({ op: "restoreStatus" }))).recovery;
		expect(mid).toMatchObject({ state: "applying", phase: "apply", next: m.chunks.length - 1, row: 0 });
		expect(await accountSql((sql) => sql.exec("SELECT name, enabled, revoked_at FROM devices WHERE name LIKE 'acct-%' ORDER BY name").toArray())).toEqual([{ name: "acct-old", enabled: 0, revoked_at: null }]);
		expect(await deviceOk(old.token)).toBe(false);
		expect(await deviceOk(fresh.token)).toBe(false);
		expect(await admin({ op: "openRestore" })).toMatchObject({ ok: false, error: { code: "validation" } });

		// Abort applies the checkpoint back: the account is as it was before the restore began, and the revoked token stays revoked.
		let undone = await value<{ state: string }>(admin({ op: "abortRestore" }));
		while (undone.state === "rolling_back") undone = await value(admin({ op: "restoreStep" }));
		expect(undone.state).toBe("aborted");
		expect(await deviceOk(old.token)).toBe(false);
		expect(await deviceOk(fresh.token)).toBe(true);
		expect(await personal()).toBe(newer);
		expect(await call(await contextFor(), "get_memory", { memory_id: after.memory_id })).toMatchObject({ content: "after body" });
		expect((await env.BACKUPS.list({ prefix: "exports/account-checkpoint/" })).objects).toHaveLength(0);

		// The real restore: the ledger keeps the newer generation, the active profile's own rows rebuild both indexes, and no old token works.
		await env.BACKUPS.put(last, original);
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		expect(await step()).toMatchObject({ ok: true, value: { state: "ready", unresolved_count: 0 } });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await personal()).toBe(newer);
		expect(await accountSql((sql) => [sql.exec("SELECT profile FROM node_index WHERE node_id = ?", after.memory_id).toArray(),
			sql.exec("SELECT profile FROM request_index WHERE request_id = 'acct-after'").toArray(),
			sql.exec("SELECT state FROM generations WHERE id = ?", newer).toArray()])).toEqual([[{ profile: "personal" }], [{ profile: "personal" }], [{ state: "active" }]]);
		const owner = await contextFor();
		expect(await call(owner, "get_memory", { memory_id: after.memory_id })).toMatchObject({ content: "after body" });
		expect(await call(owner, "get_memory", { memory_id: before.memory_id })).toMatchObject({ content: "before body" });
		expect(await call(owner, "save_memory", afterArgs)).toMatchObject({ memory_id: after.memory_id, revision: 1 });
		expect(await deviceOk(old.token)).toBe(false);
		expect(await deviceOk(fresh.token)).toBe(false);
		expect(await deviceOk((await deviceToken("acct-new", ["read"], ["personal"])).token)).toBe(true);
		expect((await env.BACKUPS.list({ prefix: "exports/account-checkpoint/" })).objects).toHaveLength(0);
	});
});
