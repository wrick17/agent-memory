// Encrypted export and restore from an export (section 18): one real workerd, SQLite and local R2 roundtrip, plus the
// refusals that guard against data loss and stray writes. Synthetic key and data only.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountRecovery, Recovery } from "../src/account/store";
import { readChunk, readManifest, type Manifest } from "../src/backup";
import { driveTransfer, transferPorts } from "../src/transfer";
import { settleRule, type SettleFacts } from "../src/profile/settle";
import { canonicalJson, sha256 } from "../src/domain/ids";
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
		if (r.state !== "restoring" && r.state !== "settling" && r.state !== "checking") return r;
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

	it("refuses a step, open or abort that names a recovery other than the open one, leaving the open one unchanged", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Bound work", type: "reference", description: "w", content: "work body", profile: "work" });
		await call(c, "save_memory", { name: "Bound personal", type: "reference", description: "p", content: "personal body", profile: "personal" });
		const work = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "work" }))).work!.id;
		const mine = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		const a = await value<Recovery>(admin({ op: "beginRestore", profile: "work", export: work }));
		expect(await value(admin({ op: "abortRestore", id: a.id }))).toMatchObject({ state: "aborted" });
		const b = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: mine }));
		let shown = b;
		for (let i = 0; i < 20 && shown.state !== "ready"; i++) shown = await value<Recovery>(admin({ op: "restoreStep", id: b.id }));
		expect(shown.state).toBe("ready");
		const before = await value(admin({ op: "restoreStatus" }));
		for (const op of ["restoreStep", "openRestore", "abortRestore"] as const) {
			expect(await admin({ op, id: a.id })).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "recovery_changed" } } });
		}
		expect(await value(admin({ op: "restoreStatus" }))).toEqual(before);
		expect(await value(admin({ op: "openRestore", id: b.id }))).toMatchObject({ id: b.id, profile: "personal", state: "opened" });
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

const accountSql = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => f(st.storage.sql));
const genOf = async (name: string) => (await value<{ name: string; generation: string }[]>(admin({ op: "listProfiles" }))).find((p) => p.name === name)!.generation;
const onProfile = async <T,>(name: string, f: (sql: SqlStorage) => T) => {
	const g = await genOf(name);
	return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${name}:${g}`)), (_i, st) => f(st.storage.sql));
};

describe("recovery settlement by the fixed transfer rules", () => {
	const f = (status: string | null, row: SettleFacts["row"] = null, identity: SettleFacts["identity"] = null, revision = 1): SettleFacts => ({ row, node: status ? { status, revision, transfer: identity?.id ?? null } : null, identity });
	const id = "T1", ident = { id, sha256: "h", revision: 2 };
	it("maps each named pair to its one action and leaves every other pair unresolved", () => {
		expect(settleRule(id, f("moving", { direction: "out", state: "sent", peer: "b" }, ident), f("incoming", { direction: "in", state: "landed", peer: "a" }, ident))).toMatchObject({ source: ["abort_out"], target: ["abort_in"], owner: "source" });
		expect(settleRule(id, f("moved", { direction: "out", state: "committed", peer: "b" }, ident), f("incoming", { direction: "in", state: "sent", peer: "a" }))).toMatchObject({ source: ["undo_move"], target: ["abort_in"] });
		expect(settleRule(id, f("moving", { direction: "out", state: "sent", peer: "b" }, ident), f("active", { direction: "in", state: "published", peer: "a" }, ident))).toMatchObject({ source: ["commit_out"], target: ["settle_in"], owner: "target" });
		expect(settleRule(id, f("active", null, null, 2), f("active", { direction: "in", state: "committed", peer: "a" }, ident))).toMatchObject({ source: ["tombstone_out"], target: [], owner: "target" });
		expect(settleRule(id, f("moved", { direction: "out", state: "committed", peer: "b" }, ident), f("active", { direction: "in", state: "committed", peer: "a" }, ident))).toMatchObject({ source: [], target: [], owner: "target" });
		expect(settleRule(id, f("moved", { direction: "out", state: "committed", peer: "b" }, ident), f(null))).toMatchObject({ source: ["undo_move"], owner: "source" });
		expect(settleRule(id, f("moving", { direction: "out", state: "fenced", peer: "b" }, ident), f(null))).toMatchObject({ source: ["abort_out"], owner: "source" });
		// Unresolved: a source revision past the bound, identities that differ, and a second copy with no identity.
		expect(settleRule(id, f("active", null, null, 3), f("active", { direction: "in", state: "committed", peer: "a" }, ident)).unresolved).toBe("source_revision_past_bound");
		expect(settleRule(id, f("moving", { direction: "out", state: "sent", peer: "b" }, { ...ident, sha256: "other" }), f("active", { direction: "in", state: "committed", peer: "a" }, ident)).unresolved).toBe("identities_differ");
		expect(settleRule(id, f("moved", { direction: "out", state: "committed", peer: "b" }, ident), f("active")).unresolved).toBe("target_holds_another_copy");
	});

	it("settles a target restored to before a move and a source restored to before its fence, each with exactly one owner", async () => {
		const c = await contextFor();
		const caller = c.caller;
		const move = async (nodeId: string) => {
			const tid = crypto.randomUUID();
			const r = await driveTransfer(transferPorts(env, OWNER), { id: tid, nodeId, from: "test", to: "personal", companyFree: true, context: "test" }, caller);
			if (!r.ok) throw new Error(JSON.stringify(r.error));
			return tid;
		};
		// The target restored to before a completed move: the source restores the record from its archive and flags it.
		const a = await call<{ memory_id: string }>(c, "save_memory", { name: "Settle A", type: "reference", description: "a", content: "settle-a body", profile: "test" });
		const pExport = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		const ta = await move(a.memory_id);
		await value(admin({ op: "beginRestore", profile: "personal", export: pExport }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved_count: 0 });
		await value(admin({ op: "openRestore" }));
		expect(await onProfile("test", (sql) => sql.exec("SELECT status, flagged FROM nodes WHERE id = ?", a.memory_id).one())).toMatchObject({ status: "active", flagged: expect.stringContaining("move undone") });
		expect(await onProfile("personal", (sql) => sql.exec("SELECT count(*) AS n FROM nodes WHERE id = ?", a.memory_id).one().n)).toBe(0);
		expect(await accountSql((sql) => [sql.exec("SELECT profile FROM node_index WHERE node_id = ?", a.memory_id).one().profile, sql.exec("SELECT state FROM transfers WHERE id = ?", ta).one().state])).toEqual(["test", "aborted"]);
		expect(await call(await contextFor(), "get_memory", { memory_id: a.memory_id })).toMatchObject({ content: "settle-a body" });

		// The source restored to before its fence: the target owns, and the source tombstones its copy under that transfer id.
		const b = await call<{ memory_id: string }>(await contextFor(), "save_memory", { name: "Settle B", type: "reference", description: "b", content: "settle-b body", profile: "test" });
		const tExport = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "test" }))).test!.id;
		const tb = await move(b.memory_id);
		await value(admin({ op: "beginRestore", profile: "test", export: tExport }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved_count: 0 });
		await value(admin({ op: "openRestore" }));
		expect(await onProfile("test", (sql) => sql.exec("SELECT status, json_extract(attrs, '$.transfer.id') AS t FROM nodes WHERE id = ?", b.memory_id).one())).toEqual({ status: "moved", t: tb });
		expect(await onProfile("personal", (sql) => sql.exec("SELECT status FROM nodes WHERE id = ?", b.memory_id).one().status)).toBe("active");
		expect(await accountSql((sql) => sql.exec("SELECT profile FROM node_index WHERE node_id = ?", b.memory_id).one().profile)).toBe("personal");
	});
});

describe("corpus export and restore", () => {
	it("exports a corpus encrypted with its own rowids, keeps two, restores into an empty generation with search, and refuses wiped or non-empty targets", async () => {
		await contextFor();
		const name = `cr${crypto.randomUUID().slice(0, 6)}`, g1 = crypto.randomUUID().slice(0, 8), g2 = crypto.randomUUID().slice(0, 8);
		await accountSql((sql) => {
			const now = new Date().toISOString();
			sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g1}`, g1, now);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g1, name, now);
		});
		const corpus = (g: string) => env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`));
		await runInDurableObject(corpus(g1), (_i, st) => {
			const sql = st.storage.sql;
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g1]]) sql.exec("INSERT INTO corpus_store_meta (key, value) VALUES (?, ?)", k, v);
			for (const [rowid, repo] of [[7, "org/alpha"], [42, "org/quokka-marker"]] as const) {
				sql.exec("INSERT INTO repos (rowid, full_name, owner, name, archived, private, commit_count, ref_count, empty) VALUES (?, ?, 'org', ?, 0, 1, 1, 1, 0)", rowid, repo, repo.slice(4));
				const doc = sql.exec<{ id: number }>("INSERT INTO corpus_search_documents (evidence_id, kind, key, repo, date, title, detail) VALUES (?, 'repo', ?, ?, '', ?, '') RETURNING rowid AS id", `repo:repos:${repo}`, repo, repo, repo).one().id;
				sql.exec("INSERT INTO corpus_search_fts (rowid, key, repo, title, detail) VALUES (?, ?, ?, ?, '')", doc, repo, repo, repo);
			}
			// A checkout scan row (schema 3) and a dated snapshot row (schema 4), each at a rowid that is not its insert order.
			sql.exec("INSERT INTO source_files (rowid, repo, path, blob_sha, size, scanned, skip_reason) VALUES (13, 'org/alpha', 'a.ts', 'b1', 10, 1, NULL)");
			sql.exec("INSERT INTO pattern_findings (rowid, finding_id, category, title) VALUES (29, 'f-1', 'lineage', 'quokka finding')");
		});
		const exportCorpus = async () => (await value<Record<string, { id: string }>>(admin({ op: "export", profile: name, corpus: true })))[`corpus-${name}`]!.id;
		const first = await exportCorpus();
		for (const o of (await env.BACKUPS.list({ prefix: `exports/corpus-${name}/${first}/` })).objects) {
			expect(new TextDecoder().decode(await (await env.BACKUPS.get(o.key))!.arrayBuffer())).not.toContain("quokka-marker");
		}
		await exportCorpus();
		const third = await exportCorpus();
		const kept = await value<string[]>(admin({ op: "listExports", profile: name, corpus: true }));
		expect(kept).toHaveLength(2);
		expect(kept).not.toContain(first);

		// A non-empty target is refused before anything is written, and the abort leaves its rows.
		await value(admin({ op: "beginCorpusRestore", profile: name, export: third }));
		expect(await admin({ op: "restoreStep" })).toMatchObject({ ok: false, error: { code: "validation" } });
		await value(admin({ op: "abortRestore" }));
		expect(await runInDurableObject(corpus(g1), (_i, st) => st.storage.sql.exec("SELECT count(*) AS n FROM repos").one().n)).toBe(2);

		// The profile now runs on a fresh generation, whose corpus is empty: the restore fills it, closed until open.
		await accountSql((sql) => {
			sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g2, `${OWNER}:${name}:${g2}`, name);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g2, name, new Date().toISOString());
			sql.exec("UPDATE generations SET state = 'retired' WHERE id = ?", g1); // one active generation, as a real switch leaves it
		});
		const begun = await value<Recovery>(admin({ op: "beginCorpusRestore", profile: name, export: "latest" }));
		expect(begun).toMatchObject({ kind: "corpus", state: "restoring", to: g2, export: third });
		expect(await admin({ op: "export" })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await value(admin({ op: "restoreStep" }))).toMatchObject({ state: "ready" });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await value(admin({ op: "restoreRecord", id: begun.id }))).toMatchObject({ kind: "corpus", state: "opened" });
		await runInDurableObject(corpus(g2), (_i, st) => {
			const sql = st.storage.sql;
			expect(sql.exec("SELECT rowid AS id, full_name FROM repos ORDER BY rowid").toArray()).toEqual([{ id: 7, full_name: "org/alpha" }, { id: 42, full_name: "org/quokka-marker" }]);
			expect(sql.exec("SELECT rowid AS id, path FROM source_files").toArray()).toEqual([{ id: 13, path: "a.ts" }]);
			expect(sql.exec("SELECT rowid AS id, finding_id FROM pattern_findings").toArray()).toEqual([{ id: 29, finding_id: "f-1" }]);
			expect(sql.exec("SELECT key FROM corpus_search_fts WHERE corpus_search_fts MATCH 'quokka'").toArray()).toHaveLength(1);
			expect(sql.exec("SELECT value FROM corpus_store_meta WHERE key = 'generation'").one().value).toBe(g2);
		});

		// A wiped profile's corpus is refused, whichever export is named.
		await accountSql((sql) => { sql.exec("UPDATE profiles SET status = 'wiped' WHERE name = ?", name); sql.exec("UPDATE generations SET state = 'wiped' WHERE profile = ?", name); });
		expect(await admin({ op: "beginCorpusRestore", profile: name, export: "latest" })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
	});
});

describe("point-in-time restore", () => {
	// PITR has no local runtime. The storage API is stubbed on the shared prototype, and `platform` plays the restore: when it
	// applies, the armed object's storage is set to the bookmark's state (here: the marker gone and the later record retired).
	const platform = { calls: [] as { bookmark: string; recovery: Recovery | null }[], apply: true, fail: false, drop: "" };
	const stubStorage = async (g: string) => runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:test:${g}`)), (_i, st) => {
		const proto = Object.getPrototypeOf(st.storage) as Record<string, unknown>;
		proto.getCurrentBookmark = async () => `now-${platform.calls.length}`;
		proto.getBookmarkForTime = async (t: Date) => `bm-${t.toISOString()}`;
		proto.onNextSessionRestoreBookmark = async function (this: DurableObjectStorage, b: string) {
			platform.calls.push({ bookmark: b, recovery: JSON.parse((await accountSql((sql) => sql.exec("SELECT value FROM account_meta WHERE key = 'recovery_state'").toArray()[0]?.value as string)) ?? "null") });
			if (platform.apply) {
				this.sql.exec("DELETE FROM profile_meta WHERE key = 'pitr_armed'");
				if (platform.drop) this.sql.exec("UPDATE nodes SET status = 'retired' WHERE id = ?", platform.drop);
			}
			if (platform.fail) { await this.sync(); throw new Error("interrupted while arming"); }
			return `undo-of-${b}`;
		};
	});
	const status = async () => (await value<{ recovery: Recovery | null }>(admin({ op: "restoreStatus" }))).recovery;
	/** Steps while the profile restarts, as the dashboard's "Run the next step" does; then through settlement and the checks. */
	const settled = async () => {
		for (let i = 0; i < 5; i++) {
			const r = await status();
			if (r?.state !== "arming" && r?.state !== "armed") break;
			await value(admin({ op: "restoreStep" }));
		}
		return (await status())?.state === "requested" ? (await status())! : stepUntilChecked();
	};
	const atNow = async () => {
		// After the current generation began, and at least a second before the request, as the window requires.
		await new Promise((done) => setTimeout(done, 1_100));
		return new Date(Date.now() - 1_050).toISOString();
	};

	it("records a fallback before arming and the undo after, stays closed until reconciled, and reverses by the undo bookmark", async () => {
		const c = await contextFor();
		const kept = await call<{ memory_id: string }>(c, "save_memory", { name: "PIT kept", type: "reference", description: "k", content: "kept body", profile: "test" });
		const at = await atNow();
		const later = await call<{ memory_id: string }>(c, "save_memory", { name: "PIT later", type: "reference", description: "l", content: "later body", profile: "test" });
		const g = await genOf("test");
		await stubStorage(g);
		Object.assign(platform, { calls: [], apply: true, fail: false, drop: later.memory_id });

		await admin({ op: "beginPitr", profile: "test", at });
		const begun = await settled();
		// The fallback and the arming session were durable before the target was armed; the platform's undo came after.
		expect(platform.calls[0]).toMatchObject({ bookmark: `bm-${at}`, recovery: { state: "arming", armed: begun.id, fallback: "now-0", session: expect.any(String) } });
		expect(begun).toMatchObject({ kind: "pitr", state: "ready", bookmark: `bm-${at}`, undo: `undo-of-bm-${at}`, undo_from: "platform", fallback: "now-0" });
		expect(await value(admin({ op: "restoreRecord", id: begun.id }))).toMatchObject({ state: "ready" });
		expect(await outcome(await contextFor(), "get_memory", { memory_id: kept.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened", undo: `undo-of-bm-${at}` });
		expect(await genOf("test")).toBe(g);
		expect(await call(await contextFor(), "get_memory", { memory_id: kept.memory_id })).toMatchObject({ content: "kept body" });

		// The reversal arms the recorded undo bookmark the same way.
		platform.drop = "";
		await admin({ op: "beginPitr", profile: "test", undo: begun.id });
		expect(await settled()).toMatchObject({ state: "ready", reverses: begun.id });
		expect(platform.calls[1]).toMatchObject({ bookmark: `undo-of-bm-${at}` });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		// Out of the 30-day window is refused before anything closes.
		expect(await admin({ op: "beginPitr", profile: "test", at: new Date(Date.now() - 31 * 86_400_000).toISOString() })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await status()).toBeNull();
	});

	it("an arm interrupted after the fallback stays closed and recoverable: a restart that applied it uses the fallback as undo, one that did not withdraws it", async () => {
		// A bound generation: an object that never held anything has no identity to restore.
		const held = await call<{ memory_id: string }>(await contextFor(), "save_memory", { name: "PIT interrupted", type: "reference", description: "i", content: "interrupted body", profile: "test" });
		const g = await genOf("test");
		await stubStorage(g);
		// The platform applied the restore, but the arm call failed before its undo was recorded.
		Object.assign(platform, { calls: [], apply: true, fail: true, drop: "" });
		let at = await atNow();
		await admin({ op: "beginPitr", profile: "test", at });
		const a = await settled();
		expect(a).toMatchObject({ kind: "pitr", state: "ready", fallback: "now-0", undo: "now-0", undo_from: "fallback" });
		expect(a.bookmark).toBeUndefined();
		await value(admin({ op: "openRestore" }));

		// The arm call failed and the restart applied nothing: the account stays closed, the arm is withdrawn, and abort reopens.
		Object.assign(platform, { apply: false, fail: true });
		at = await atNow();
		await admin({ op: "beginPitr", profile: "test", at });
		expect(await settled()).toMatchObject({ state: "requested", rearmed: 1 });
		expect((await status())!.fallback).toBeUndefined();
		// A record that exists: an unknown id answers not_found before the recovery gate.
		expect(await outcome(await contextFor(), "get_memory", { memory_id: held.memory_id })).toMatchObject({ ok: false, error: { code: "busy" } });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect(await status()).toBeNull();
	});
});

// The owner's choice between copies and the planned state (section 18, step 4): the six P1 and the P2 of the shared-interface
// review, with their minimal counterexamples. Copies and identity mismatches are made directly in the stores' SQLite.
describe("recovery choices and deferred steps", () => {
	type Copy = { profile: string; generation: string | null; copy: { status: string; revision: number; flagged: string | null; restorable?: { ok: boolean; reason?: string } } | null; keepable: boolean };
	type Conflict = { node: string; state: string; copies: Copy[]; resume?: Record<string, unknown> };
	const status = async () => (await value<{ recovery: (Recovery & AccountRecovery) | null }>(admin({ op: "restoreStatus" }))).recovery;
	const conflicts = async (id: string) => (await value<{ conflicts: Conflict[] }>(admin({ op: "recoveryConflicts", id }))).conflicts;
	const expectOf = (c: Conflict) => c.copies.map((x) => ({ profile: x.profile, generation: x.generation, status: x.copy?.status ?? null, revision: x.copy?.revision ?? null }));
	const resolve = (id: string, c: Conflict, keep: string, request_id: string) => admin({ op: "resolveConflict", id, node: c.node, keep, expect: expectOf(c), request_id });
	const nodeIn = (profile: string, id: string) => onProfile(profile, (sql) => sql.exec<{ status: string; flagged: string | null }>("SELECT status, flagged FROM nodes WHERE id = ?", id).toArray()[0] ?? null);
	const bound = (id: string) => accountSql((sql) => sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", id).toArray()[0]?.profile ?? null);
	const binding = (request: string) => accountSql((sql) => sql.exec<{ profile: string }>("SELECT profile FROM request_index WHERE request_id = ?", request).toArray()[0]?.profile ?? null);
	const accountSteps = async () => {
		for (let i = 0; i < 60; i++) {
			const r = await value<AccountRecovery>(admin({ op: "restoreStep" }));
			if (!["checkpoint", "applying", "reconciling", "rolling_back"].includes(r.state)) return r;
		}
		throw new Error("account recovery did not settle");
	};
	const abortAccount = async () => {
		for (let i = 0; i < 60; i++) {
			const r = await value<{ state: string }>(admin({ op: "abortRestore" }));
			if (r.state === "aborted") return r;
		}
		throw new Error("account abort did not finish");
	};
	/** A second active copy of a test record, with its request row, written straight into personal: two copies, no transfer identity. */
	const duplicate = async (id: string) => {
		const rows = await onProfile("test", (sql) => ({ node: sql.exec("SELECT * FROM nodes WHERE id = ?", id).one(), requests: sql.exec("SELECT * FROM requests WHERE node_id = ?", id).toArray() }));
		await onProfile("personal", (sql) => {
			for (const [t, list] of [["nodes", [rows.node]], ["requests", rows.requests]] as const) for (const r of list) {
				const cols = Object.keys(r);
				sql.exec(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((k) => r[k] as SqlStorageValue));
			}
		});
	};
	const move = async (nodeId: string, from: string, to: string, crashAt?: string) => {
		const base = transferPorts(env, OWNER), id = crypto.randomUUID();
		const ports = { ...base, account: (cmd: Parameters<typeof base.account>[0]) => cmd.op === crashAt ? Promise.resolve(fail("unavailable", "crash")) : base.account(cmd) };
		const r = await driveTransfer(ports, { id, nodeId, from, to, companyFree: true, context: from }, (await contextFor()).caller);
		expect(r.ok).toBe(!crashAt);
		return id;
	};
	const tamper = (profile: string, id: string, sha: string | null = "tampered") => onProfile(profile, (sql) => sql.exec(sha === null
		? "UPDATE revisions SET snapshot = json_remove(json_set(snapshot, '$.transfer.sha256', json_extract(snapshot, '$.transfer.original')), '$.transfer.original') WHERE node_id = ? AND op = 'transferred_in'"
		: "UPDATE revisions SET snapshot = json_set(snapshot, '$.transfer.original', json_extract(snapshot, '$.transfer.sha256'), '$.transfer.sha256', ?) WHERE node_id = ? AND op = 'transferred_in'",
		...(sha === null ? [id] : [sha, id])));
	const exportOf = async (profile: string) => (await value<Record<string, { id: string }>>(admin({ op: "export", profile })))[profile]!.id;
	// A failed case must not leave the account closed for the next one: each case's result stands on its own.
	afterEach(async () => {
		for (let i = 0; i < 60 && (await status()); i++) await admin({ op: "abortRestore" });
	});

	it("a planned terminal transfer reaches ready, and open ends the target's row and the account's", async () => {
		const n = await call<{ memory_id: string }>(await contextFor(), "save_memory", { name: "Planned end", type: "reference", description: "p", content: "planned body", profile: "test" });
		const t = await move(n.memory_id, "test", "personal", "done");
		const captured = await exportOf("test"); // the source captured moving, its target already published
		await value(admin({ op: "beginRestore", profile: "test", export: captured }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		expect(await onProfile("personal", (sql) => sql.exec("SELECT state FROM transfers WHERE id = ?", t).one().state)).toBe("published"); // kept for open
		await value(admin({ op: "openRestore" }));
		expect(await onProfile("personal", (sql) => sql.exec("SELECT state FROM transfers WHERE id = ?", t).one().state)).toBe("committed");
		expect(await accountSql((sql) => sql.exec("SELECT state, completed_at IS NOT NULL AS done FROM transfers WHERE id = ?", t).one())).toEqual({ state: "committed", done: 1 });
		expect([await nodeIn("test", n.memory_id), await bound(n.memory_id)]).toEqual([expect.objectContaining({ status: "moved" }), "personal"]);
	});

	it("a moved copy whose archive is redacted or gone is refused before any change, and a failed precheck at open stays abortable", async () => {
		const n = await call<{ memory_id: string }>(await contextFor(), "save_memory", { name: "Archive keep", type: "reference", description: "k", content: "archive body", profile: "test" });
		await move(n.memory_id, "test", "personal");
		await tamper("personal", n.memory_id);
		const captured = await exportOf("personal");
		await tamper("personal", n.memory_id, null); // only the export holds the mismatch
		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: captured }));
		expect(await stepUntilChecked()).toMatchObject({ state: "unresolved" });
		const moveActivity = (sql: SqlStorage) => sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'transfer_out' AND targets LIKE ? ORDER BY id DESC LIMIT 1", `%${n.memory_id}%`).one().id;
		await onProfile("test", (sql) => sql.exec("UPDATE activity SET redacted = 'wipe' WHERE id = ?", moveActivity(sql)));
		let c = (await conflicts(begun.id))[0]!;
		expect(c.copies.find((x) => x.profile === "test")).toMatchObject({ keepable: false, copy: { status: "moved", restorable: { ok: false, reason: "undo_redacted" } } });
		expect(await resolve(begun.id, c, "test", "archive-req-1")).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "not_keepable" } } });
		expect(c.copies.find((x) => x.profile === "personal")!.copy).toMatchObject({ status: "active" });
		expect((await conflicts(begun.id))[0]).toMatchObject({ state: "open", copies: expect.arrayContaining([expect.objectContaining({ profile: "personal", copy: expect.objectContaining({ status: "active" }) })]) });
		await onProfile("test", (sql) => sql.exec("UPDATE activity SET redacted = NULL WHERE id = ?", moveActivity(sql)));

		// Kept while restorable; the archive then goes before open: the precheck refuses, nothing runs, and abort still works.
		c = (await conflicts(begun.id))[0]!;
		await value(resolve(begun.id, c, "test", "archive-req-2"));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [] });
		await onProfile("test", (sql) => sql.exec("DELETE FROM archive WHERE activity_id = ?", moveActivity(sql)));
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "unresolved", unresolved: [expect.objectContaining({ kind: "open_precheck_failed" })] });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect([await nodeIn("test", n.memory_id), await nodeIn("personal", n.memory_id)]).toEqual([expect.objectContaining({ status: "moved" }), expect.objectContaining({ status: "active" })]);
		expect(await status()).toBeNull();
	});

	it("a moved me copy is refused under a term added since, before any change; an unfinished choice resumes from its durable body", async () => {
		const c0 = await contextFor();
		const n = await call<{ memory_id: string }>(c0, "save_memory", { name: "Kestrel rule", type: "feedback", description: "a me rule", content: "kestrelmarker body", profile: "me", company_free: true });
		const t = await move(n.memory_id, "me", "personal");
		await tamper("personal", n.memory_id);
		const captured = await exportOf("personal");
		await tamper("personal", n.memory_id, null);
		await value(admin({ op: "addSensitiveTerm", term: "kestrelmarker" }));
		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: captured }));
		expect(await stepUntilChecked()).toMatchObject({ state: "unresolved" });
		const c = (await conflicts(begun.id)).find((x) => x.node === n.memory_id)!;
		expect(c.copies.find((x) => x.profile === "me")).toMatchObject({ keepable: false, copy: { status: "moved", restorable: { ok: false, reason: "me_sensitive_term" } } });
		expect(await resolve(begun.id, c, "me", "kestrel-req-1")).toMatchObject({ ok: false, error: { details: { reason: "not_keepable" } } });
		expect(await nodeIn("me", n.memory_id)).toMatchObject({ status: "moved" });

		// A choice left resolving, as after a lost answer: the read returns its exact body, which alone continues it.
		const body = { id: begun.id, node: n.memory_id, keep: "personal", expect: expectOf(c), request_id: "kestrel-req-2" };
		await accountSql((sql) => {
			const key = `restore:${begun.id}:conflict:${n.memory_id}`, rec = JSON.parse(sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = ?", key).one().value);
			sql.exec("UPDATE account_meta SET value = ? WHERE key = ?", JSON.stringify({ ...rec, state: "resolving", request_id: body.request_id, keep: "personal", expect: body.expect, next: 0,
				payload: sha256(canonicalJson({ node: body.node, keep: body.keep, expect: body.expect })), plan: [{ profile: null, node: n.memory_id, owner: "personal", transfers: [{ id: t, state: "committed" }] }] }), key);
			const r = JSON.parse(sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = 'recovery_state'").one().value);
			sql.exec("UPDATE account_meta SET value = ? WHERE key = 'recovery_state'", JSON.stringify({ ...r, resolving: n.memory_id }));
		});
		expect((await conflicts(begun.id)).find((x) => x.node === n.memory_id)!.resume).toEqual(body);
		expect(await resolve(begun.id, c, "personal", "kestrel-req-3")).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "resolving" } } });
		expect(await value(admin({ op: "resolveConflict", ...body }))).toMatchObject({ node: n.memory_id, kept: "personal" });
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [] });
		await value(admin({ op: "abortRestore" }));
		expect(await status()).toBeNull();
	});

	// Restores of personal to an export from before it received a record: the fixed rules undo the move in the source.
	const undoCase = async (profile: string, prepare: (id: string) => Promise<void>, args: Record<string, unknown> = {}) => {
		const c = await contextFor();
		const n = await call<{ memory_id: string }>(c, "save_memory", { name: `Undo ${crypto.randomUUID().slice(0, 6)}`, type: "reference", description: "u", content: "undo body", profile, ...args });
		await prepare(n.memory_id);
		const before = await exportOf("personal");
		const t = await move(n.memory_id, profile, "personal");
		return { id: n.memory_id, t, before };
	};

	it("a planned undo whose archived identity is taken now is refused before either copy changes, and stays abortable", async () => {
		const c = await contextFor(), name = `Ident ${crypto.randomUUID().slice(0, 6)}`;
		const u = await undoCase("test", async (id) => { await call(c, "save_memory", { memory_id: id, new_name: `${name} renamed` }); });
		// A different record takes the moved record's current name in the source, which the creation-name id allows.
		const m = await call<{ memory_id: string }>(c, "save_memory", { name: `${name} renamed`, type: "reference", description: "m", content: "other body", profile: "test" });
		expect(m.memory_id).not.toBe(u.id);
		await value(admin({ op: "beginRestore", profile: "personal", export: u.before }));
		const r = await stepUntilChecked();
		expect(r).toMatchObject({ state: "unresolved", unresolved: expect.arrayContaining([expect.objectContaining({ kind: "transfer_settle_failed", id: u.id })]) });
		expect((await conflicts(r.id)).find((x) => x.node === u.id)!.copies.find((x) => x.profile === "test")).toMatchObject({ keepable: false, copy: { status: "moved", restorable: { ok: false, reason: "key_taken" } } });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect([await nodeIn("test", u.id), await nodeIn("test", m.memory_id), await nodeIn("personal", u.id)]).toEqual([
			expect.objectContaining({ status: "moved" }), expect.objectContaining({ status: "active" }), expect.objectContaining({ status: "active" })]);
	});

	it("a planned undo into me is refused when a retained revision holds a term added since, before either copy changes", async () => {
		const c = await contextFor();
		const u = await undoCase("me", async (id) => { await call(c, "save_memory", { memory_id: id, content: "clean body", profile: "me", company_free: true }); },
			{ type: "feedback", content: "corvidmark old body", company_free: true });
		await value(admin({ op: "addSensitiveTerm", term: "corvidmark" }));
		await value(admin({ op: "beginRestore", profile: "personal", export: u.before }));
		expect(await stepUntilChecked()).toMatchObject({ state: "unresolved", unresolved: expect.arrayContaining([expect.objectContaining({ kind: "transfer_settle_failed", id: u.id })]) });
		expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
		expect([await nodeIn("me", u.id), await nodeIn("personal", u.id)]).toEqual([expect.objectContaining({ status: "moved" }), expect.objectContaining({ status: "active" })]);
	});

	it("a planned undo restores the source as owner of the record and its request bindings, and edge evidence keeps its own link across batches", async () => {
		const c = await contextFor(), tag = crypto.randomUUID().slice(0, 6), ref = `https://example.test/f4-${tag}`;
		const targets: string[] = [];
		for (let i = 0; i < 25; i++) targets.push((await call<{ memory_id: string }>(c, "save_memory", { name: `F4 target ${tag} ${i}`, type: "reference", description: "t", profile: "test" })).memory_id);
		const other = await call<{ memory_id: string }>(c, "save_memory", { name: `F4 other ${tag}`, type: "reference", description: "o", profile: "test" });
		const u = await undoCase("test", async (id) => {
			// 25 links, the first with evidence, so the undo restores them in one batch and their evidence in the next.
			await call(c, "record_knowledge", { profile: "test", edges: targets.map((dst, i) => ({ from: { id }, rel: "relates_to", to: { id: dst }, reason: `link number ${i}`, evidence: [{ kind: "url", ref: i === 0 ? ref : `${ref}-${i}` }] })) });
		}, { request_id: `f4-save-${tag}` });
		// SQLite reuses the first of the archived link ids for the next link in the source: an unrelated one.
		await call(c, "record_knowledge", { profile: "test", edges: [{ from: { id: other.memory_id }, rel: "relates_to", to: { id: targets[1] }, reason: "unrelated", evidence: [{ kind: "url", ref: `${ref}-unrelated` }] }] });
		const reused = await onProfile("test", (sql) => sql.exec<{ id: number }>("SELECT id FROM edges WHERE src = ?", other.memory_id).one().id);
		const archived = await onProfile("test", (sql) => sql.exec<{ owner: string }>("SELECT json_extract(payload, '$.owner') AS owner FROM archive WHERE source = 'evidence' AND json_extract(payload, '$.ref') = ?", ref).one().owner);
		expect(archived).toBe(`e:${reused}`); // the collision this case is about
		await value(admin({ op: "beginRestore", profile: "personal", export: u.before }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [] });
		await value(admin({ op: "openRestore" }));
		expect(await nodeIn("test", u.id)).toMatchObject({ status: "active" });
		expect([await bound(u.id), await binding(`f4-save-${tag}`)]).toEqual(["test", "test"]);
		const owner = await onProfile("test", (sql) => sql.exec<{ src: string; reason: string }>("SELECT e.src, e.reason FROM evidence v JOIN edges e ON v.owner = 'e:' || e.id WHERE v.ref = ?", ref).one());
		expect(owner).toEqual({ src: u.id, reason: "link number 0" });
		expect(await onProfile("test", (sql) => sql.exec("SELECT count(*) AS n FROM edges WHERE src = ?", u.id).one().n)).toBe(25);
		expect(await onProfile("test", (sql) => sql.exec("SELECT ref FROM evidence WHERE owner = ?", `e:${reused}`).toArray())).toEqual([{ ref: `${ref}-unrelated` }]);
	});

	it("a choice recomputes its stale findings and ends both profiles' rows and the account's", async () => {
		const n = await call<{ memory_id: string }>(await contextFor(), "save_memory", { name: "Mismatch", type: "reference", description: "m", content: "mismatch body", profile: "test" });
		const t = await move(n.memory_id, "test", "personal", "done");
		await tamper("personal", n.memory_id);
		const captured = await exportOf("test");
		const begun = await value<Recovery>(admin({ op: "beginRestore", profile: "test", export: captured }));
		const stuck = await stepUntilChecked();
		expect(stuck.state).toBe("unresolved");
		expect(stuck.unresolved.map((u) => u.kind)).toEqual(expect.arrayContaining(["transfer_identities_differ", "transfer_state", "open_transfer", "transfer_unfinished"]));
		const c = (await conflicts(begun.id))[0]!;
		await value(resolve(begun.id, c, "personal", "mismatch-req"));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		await value(admin({ op: "openRestore" }));
		expect(await onProfile("personal", (sql) => sql.exec("SELECT state FROM transfers WHERE id = ?", t).one().state)).toBe("committed");
		expect(await onProfile("test", (sql) => sql.exec("SELECT state FROM transfers WHERE id = ?", t).one().state)).toBe("aborted");
		expect(await accountSql((sql) => sql.exec("SELECT state FROM transfers WHERE id = ?", t).one().state)).toBe("committed");
		expect(await nodeIn("test", n.memory_id)).toMatchObject({ status: "moved", flagged: expect.stringContaining("kept the copy in personal") });
		await tamper("personal", n.memory_id, null); // the live identity is genuine again; the choice alone settled the pair
	});

	it("account restore: a choice and its kept profile steps undo on abort; open applies them; bindings follow the chosen owner; request ids bind one payload", async () => {
		const c = await contextFor();
		const a = await call<{ memory_id: string }>(c, "save_memory", { name: "Choice A", type: "reference", description: "a", content: "a body", profile: "test", request_id: "choice-a-1" });
		const b = await call<{ memory_id: string }>(c, "save_memory", { name: "Choice B", type: "reference", description: "b", content: "b body", profile: "test", request_id: "choice-b-1" });
		await duplicate(a.memory_id);
		await duplicate(b.memory_id);
		const exported = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		const before = { index: await bound(a.memory_id), request: await binding("choice-a-1") };

		// Abort: the choice moved the account's index and bindings at once and kept the tombstone for open; abort undoes both.
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		const r1 = await accountSteps();
		expect(r1).toMatchObject({ state: "unresolved" });
		const c1 = (await conflicts(r1.id)).find((x) => x.node === a.memory_id)!;
		expect(c1.copies.map((x) => [x.profile, x.copy?.status, x.keepable]).sort()).toEqual([["personal", "active", true], ["test", "active", true]]);
		await value(resolve(r1.id, c1, "personal", "choice-req-1"));
		expect([await bound(a.memory_id), await binding("choice-a-1")]).toEqual(["personal", "personal"]);
		expect(await nodeIn("test", a.memory_id)).toMatchObject({ status: "active" }); // its tombstone waits for open
		await abortAccount();
		expect([await bound(a.memory_id), await binding("choice-a-1")]).toEqual([before.index, before.request]);
		expect(await nodeIn("test", a.memory_id)).toMatchObject({ status: "active", flagged: null });
		expect(await nodeIn("personal", a.memory_id)).toMatchObject({ status: "active", flagged: null });

		// Open: both choices; one request id cannot bind a second node's payload, and the same body replays.
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		const r2 = await accountSteps();
		const both = await conflicts(r2.id), ca = both.find((x) => x.node === a.memory_id)!, cb = both.find((x) => x.node === b.memory_id)!;
		const chosen = await value(resolve(r2.id, ca, "test", "choice-req-2"));
		expect(await binding("choice-a-1")).toBe("test"); // rebuilt from the kept profile's own request rows
		expect(await resolve(r2.id, cb, "personal", "choice-req-2")).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		expect(await (await conflicts(r2.id)).find((x) => x.node === b.memory_id)!.state).toBe("open");
		expect(await value(resolve(r2.id, ca, "test", "choice-req-2"))).toEqual(chosen);
		await value(resolve(r2.id, cb, "personal", "choice-req-3"));
		expect(await accountSteps()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await nodeIn("personal", a.memory_id)).toMatchObject({ status: "moved", flagged: expect.stringContaining("kept the copy in test") });
		expect(await nodeIn("test", a.memory_id)).toMatchObject({ status: "active" });
		expect(await nodeIn("test", b.memory_id)).toMatchObject({ status: "moved" });
		expect([await bound(a.memory_id), await binding("choice-a-1"), await bound(b.memory_id), await binding("choice-b-1")]).toEqual(["test", "test", "personal", "personal"]);
	});

	it("a later restore after an owner's choice sees the chosen state as settled (GAP: the losing tombstone's identity has no counterpart)", async () => {
		// After the account case above, personal holds a tombstone under recovery-<id>-<node> whose kept copy is in test.
		const again = await exportOf("personal");
		await value(admin({ op: "beginRestore", profile: "personal", export: again }));
		expect(await stepUntilChecked()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
	});
});
