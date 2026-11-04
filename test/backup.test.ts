// Encrypted export and restore from an export (section 18): one real workerd, SQLite and local R2 roundtrip, plus the
// refusals that guard against data loss and stray writes. Synthetic key and data only.
import { createExecutionContext, createScheduledController, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountRecovery, Recovery } from "../src/account/store";
import { listExports, readChunk, readManifest, type Manifest } from "../src/backup";
import { driveTransfer, transferPorts } from "../src/transfer";
import { settleRule, type SettleFacts } from "../src/profile/settle";
import { canonicalJson, requestHash, sha256 } from "../src/domain/ids";
import { fail, type Outcome } from "../src/domain/types";
import { accountStub, profileStub } from "../src/mcp";
import type { ProfileStore } from "../src/profile/store";
import { wipePorts, wipeProfile } from "../src/wipe";
import worker from "../src/worker";
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
/** A corpus export runs in alarm steps: runs them until export `id` of that corpus lists as complete. */
async function settled(profile: string, generation: string, id: string): Promise<string> {
	const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${profile}:${generation}`));
	for (let i = 0; i < 20 && !(await listExports(env, `corpus-${profile}`)).includes(id); i++) await runDurableObjectAlarm(store);
	return id;
}
/** A corpus restore runs its chunks, its search index and its final checks in separate steps: steps until it is ready or fails. */
async function corpusRestored(): Promise<Outcome<unknown>> {
	for (let i = 0; i < 6; i++) { const r = await admin({ op: "restoreStep" }); if (!r.ok || (r.value as Recovery).state === "ready") return r; }
	throw new Error("the corpus restore did not become ready");
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
			const r = await driveTransfer(transferPorts(env, OWNER), { id: tid, nodeId, from: "test", to: "personal", companyFree: true }, caller);
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

describe("corpus resumable export", () => {
	it("captures changes during a paged export into a bounded cut, resumes after a failed put, fences only as the 30 s fallback, and stops on a close", async () => {
		await contextFor();
		const { beginExport, cancelExport, exportJob, exportStep, lastExport } = await import("../src/backup");
		const { SNAPSHOTS, stageName } = await import("../src/corpus/snapshots");
		const name = `rx${crypto.randomUUID().slice(0, 6)}`, g = crypto.randomUUID().slice(0, 8), who = { userId: OWNER, profile: name, generation: g }, META = "corpus_store_meta";
		await accountSql((sql) => {
			const now = new Date().toISOString();
			sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g}`, g, now);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g, name, now);
		});
		const store = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`));
		const on = <T,>(f: (s: DurableObjectState) => T) => runInDurableObject(store, (_i, s) => f(s));
		await on((s) => {
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g]]) s.storage.sql.exec(`INSERT INTO ${META} (key, value) VALUES (?, ?)`, k, v);
			for (let i = 1; i <= 1203; i++) s.storage.sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name) VALUES (?, 'org/alpha', ?, ?, ?)", i * 2, i, i, `dev-${i}`);
		});
		const spec = { store: `corpus-${name}`, userId: OWNER, metaTable: META, control: Object.keys(SNAPSHOTS).map(stageName), profile: name, generation: g, rowid: true };
		const failingPut = (n: number) => { let puts = 0; return { ...env, BACKUPS: { put: (k: string, v: Uint8Array) => (++puts === n ? Promise.reject(new Error("r2 down")) : env.BACKUPS.put(k, v)),
			list: (o: R2ListOptions) => env.BACKUPS.list(o), head: (k: string) => env.BACKUPS.head(k), delete: (k: string[]) => env.BACKUPS.delete(k) } } as unknown as Env; };
		const objects = async (id: string) => (await env.BACKUPS.list({ prefix: `exports/corpus-${name}/${id}/` })).objects.length;
		const chunk = { table: "contributors", schema_sha256: "0".repeat(64), source: { file_sha256: "ab".repeat(32) }, as_of: "2026-08-12T13:30:59.154Z", columns: [], after: null, rows: [], final: false, sha256: "0".repeat(64) };

		const contributors = (st: DurableObjectStub<import("../src/corpus/store").CorpusStore>) => runInDurableObject(st, (_i, s) => s.storage.sql.exec("SELECT rowid AS id, repo, rank, commits, name FROM contributors ORDER BY rowid").toArray());
		const capture = () => on((s) => s.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'export_journal' OR name LIKE 'export_cap_%'").toArray().length);

		const id = await on((s) => beginExport(s.storage, spec).id);
		// Writes and reads flow while it runs, and a second export request joins it.
		expect(await store.importChunk(who, chunk)).not.toMatchObject({ error: { code: "busy" } });
		expect(await store.query(who, { action: "sql", sql: "SELECT count(*) FROM contributors" })).toMatchObject({ ok: true, value: { rows: [[1203]] } });
		expect(await value<Record<string, unknown>>(admin({ op: "export", profile: name, corpus: true }))).toMatchObject({ [`corpus-${name}`]: { id, state: "running" } });
		// The second put fails: the first page's chunk and cursor are kept, and the next step resumes after them.
		expect(await on((s) => exportStep(s.storage, failingPut(2), spec, () => null))).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await on((s) => exportJob(s.storage.sql, META))).toMatchObject({ id, phase: "baseline", n: 1, after: [1000] });
		// Changes behind and ahead of the baseline cursor: update, delete, delete-and-reinsert, rowid change, a new low key, a later
		// update, and meta rows (its own export_* keys are never journaled or exported).
		await on((s) => {
			const sql = s.storage.sql;
			sql.exec("UPDATE contributors SET name = 'changed' WHERE rowid = 2");
			sql.exec("DELETE FROM contributors WHERE rowid = 4");
			sql.exec("DELETE FROM contributors WHERE rowid = 6");
			sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name) VALUES (6, 'org/alpha', 6, 6, 'reborn')");
			sql.exec("UPDATE contributors SET rowid = 99999 WHERE rowid = 8");
			sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name) VALUES (1, 'org/alpha', 0, 0, 'new-low')");
			sql.exec("UPDATE contributors SET name = 'late' WHERE rowid = 2400");
			sql.exec(`INSERT INTO ${META} (key, value) VALUES ('probe', 'x'), ('export_probe', 'y')`);
			// 24 rows of 90,000 UTF-8 bytes ahead of the cursor: their baseline page and their delta both outgrow the UTF-16 length budget.
			sql.exec("UPDATE contributors SET name = ? WHERE rowid BETWEEN 1100 AND 1146", "文".repeat(30_000));
		});
		expect(await on((s) => s.storage.sql.exec("SELECT count(*) AS n FROM export_journal WHERE key LIKE '%export_probe%'").one().n)).toBe(0);
		// Retention fails after the manifest landed: the job stays publishing, and its retry publishes the same cut, not a later one.
		let lists = 0;
		const listFailsOnce = { ...env, BACKUPS: { put: (k: string, v: Uint8Array) => env.BACKUPS.put(k, v), head: (k: string) => env.BACKUPS.head(k), delete: (k: string[]) => env.BACKUPS.delete(k),
			list: (o: R2ListOptions) => (++lists === 1 ? Promise.reject(new Error("r2 list down")) : env.BACKUPS.list(o)) } } as unknown as Env;
		expect(await on((s) => exportStep(s.storage, listFailsOnce, spec, () => null))).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await on((s) => exportJob(s.storage.sql, META))).toMatchObject({ id, phase: "publishing" });
		const expected = await contributors(store);
		await on((s) => s.storage.sql.exec("UPDATE contributors SET name = 'after-cut' WHERE rowid = 10"));
		expect(await on((s) => exportStep(s.storage, env, spec, () => null))).toMatchObject({ ok: true, value: { id, done: true } });
		const m = await readManifest(env, `corpus-${name}`, id, OWNER);
		if (!m.ok) throw new Error(m.error.message);
		expect(m.value).toMatchObject({ version: 2, counts: { contributors: expected.length } });
		const read = await Promise.all(m.value.chunks.map((_c, i) => readChunk(env, m.value, i)));
		expect(read.filter((c) => c.table === META).flatMap((c) => c.rows.map((r) => String(r[c.columns.indexOf("key")]))).some((k) => k.startsWith("export_"))).toBe(false);
		const utf8 = new TextEncoder();
		for (const c of read) if (c.rows.length + (c.deletes?.length ?? 0) > 1) expect(utf8.encode(JSON.stringify(c)).length).toBeLessThanOrEqual(512 * 1024);
		expect(await capture()).toBe(0);
		expect(await on((s) => [exportJob(s.storage.sql, META), lastExport(s.storage.sql, META)])).toMatchObject([undefined, { id, state: "done" }]);

		// The fallback fence: writes wait inside its 30 s and flow once it lapses; a job past it fails, deleting only its own objects.
		const late = await on((s) => beginExport(s.storage, spec).id);
		await on((s) => exportStep(s.storage, failingPut(2), spec, () => null));
		expect(await objects(late)).toBe(1);
		const fence = (until: number) => on((s) => s.storage.sql.exec(`UPDATE ${META} SET value = json_set(value, '$.fence_until', ?) WHERE key = 'export_job'`, until));
		await fence(Date.now() + 30_000);
		expect(await store.importChunk(who, chunk)).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "corpus_exporting", retry_after: 5 } } });
		expect(await store.refresh(who, { command: "finish", plan_id: "x" })).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "corpus_exporting" } } });
		expect(await store.query(who, { action: "sql", sql: "SELECT count(*) FROM contributors" })).toMatchObject({ ok: true });
		await fence(Date.now() - 1);
		expect(await store.importChunk(who, chunk)).not.toMatchObject({ error: { code: "busy" } });
		expect(await on((s) => exportStep(s.storage, env, spec, () => null))).toMatchObject({ ok: false, error: { message: expect.stringContaining("30-second write fence") } });
		expect(await objects(late)).toBe(0);
		expect(await capture()).toBe(0);
		expect(await value<string[]>(admin({ op: "listExports", profile: name, corpus: true }))).toEqual([id]);

		// A cancel (a restore beginning) with no step running: the store's alarm deletes exactly that export's objects from its marker.
		const cancelled = await on((s) => beginExport(s.storage, spec).id);
		await on((s) => exportStep(s.storage, failingPut(2), spec, () => null));
		expect(await objects(cancelled)).toBe(1);
		expect(await on((s) => cancelExport(s.storage, spec, "a restore began"))).toBe(true);
		await on((s) => s.storage.setAlarm(Date.now() + 60_000)); // not due, so only the run below fires it
		expect(await runDurableObjectAlarm(store)).toBe(true);
		expect(await objects(cancelled)).toBe(0);
		expect(await on((s) => s.storage.sql.exec(`SELECT count(*) AS n FROM ${META} WHERE key LIKE 'export_drop:%'`).one().n)).toBe(0);
		expect(await value<string[]>(admin({ op: "listExports", profile: name, corpus: true }))).toEqual([id]);

		// A close (a wipe's first step) stops the running export through the store's alarm, which deletes what it wrote.
		const closed = await on((s) => beginExport(s.storage, spec).id);
		await on((s) => exportStep(s.storage, failingPut(2), spec, () => null));
		expect(await objects(closed)).toBe(1);
		await store.wipe(who, "close");
		await on((s) => s.storage.setAlarm(Date.now() + 60_000)); // not due, so only the run below fires it
		expect(await runDurableObjectAlarm(store)).toBe(true);
		expect(await objects(closed)).toBe(0);
		expect(await on((s) => [exportJob(s.storage.sql, META), lastExport(s.storage.sql, META)])).toMatchObject([undefined, { id: closed, state: "failed" }]);
		expect(await value<string[]>(admin({ op: "listExports", profile: name, corpus: true }))).toEqual([id]);

		// The journaled export restores into a fresh generation as exactly the state at its cut.
		const g2 = crypto.randomUUID().slice(0, 8);
		await accountSql((sql) => {
			sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g2, `${OWNER}:${name}:${g2}`, name);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g2, name, new Date().toISOString());
			sql.exec("UPDATE generations SET state = 'retired' WHERE id = ?", g);
		});
		await value(admin({ op: "beginCorpusRestore", profile: name, export: id }));
		expect(await value(corpusRestored())).toMatchObject({ state: "ready" });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		const restored = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g2}`));
		expect(await contributors(restored)).toEqual(expected);
		expect(expected.find((r) => r.id === 2)).toMatchObject({ name: "changed" });
		expect(expected.map((r) => r.id)).toEqual(expect.arrayContaining([1, 6, 99999]));
		expect(expected.some((r) => r.id === 4 || r.id === 8)).toBe(false);
		expect(expected.filter((r) => r.name === "文".repeat(30_000))).toHaveLength(24);
		expect(expected.find((r) => r.id === 10)).not.toMatchObject({ name: "after-cut" });
		expect(await runInDurableObject(restored, (_i, s) => s.storage.sql.exec(`SELECT value FROM ${META} WHERE key = 'probe'`).toArray())).toEqual([{ value: "x" }]);
		expect(await admin({ op: "wipeProfile", profile: name, typed: name })).toMatchObject({ ok: true });
		expect(await value<string[]>(admin({ op: "listExports", profile: name, corpus: true }))).toEqual([]);
	});

	it("a manual preserve_existing export keeps every existing profile and account export unchanged; the next default or any scheduled export prunes to two", async () => {
		await call(await contextFor(), "save_memory", { name: "Preserve probe", type: "reference", description: "p", content: "preserve body", profile: "personal" });
		const stores = ["profile-personal", "account"] as const;
		const lists = async () => Promise.all(stores.map((s) => listExports(env, s)));
		const objects = async (store: string, ids: string[]) => Promise.all(ids.map(async (id) => (await env.BACKUPS.list({ prefix: `exports/${store}/${id}/` })).objects.map((o) => `${o.key}:${o.etag}`)));
		await value(admin({ op: "export" }));
		await value(admin({ op: "export" }));
		const two = await lists();
		for (const ids of two) expect(ids).toHaveLength(2);
		const before = await Promise.all(stores.map((s, i) => objects(s, two[i]!)));

		await value(admin({ op: "export", preserve_existing: true }));
		const three = await lists();
		for (const [i, ids] of three.entries()) {
			expect(ids).toHaveLength(3);
			expect(ids.slice(0, 2)).toEqual(two[i]);
			expect(await objects(stores[i]!, two[i]!)).toEqual(before[i]);
		}
		// Not pinned: the next default export applies retention again, keeping the two newest.
		await value(admin({ op: "export" }));
		for (const [i, ids] of (await lists()).entries()) { expect(ids).toHaveLength(2); expect(ids[0]).toBe(three[i]!.at(-1)); }
		// A scheduled run never takes the manual flag.
		await value(admin({ op: "export", preserve_existing: true }));
		for (const ids of await lists()) expect(ids).toHaveLength(3);
		await value(admin({ op: "export", preserve_existing: true, trigger: { scheduled_time: Date.now(), cron: "17 3 * * *" } }));
		for (const ids of await lists()) expect(ids).toHaveLength(2);
	});
});

describe("corpus export and restore", () => {
	it("a preserve_existing corpus export keeps every export from its saved job across steps and a failed publish; a running default job refuses it; a job without the flag prunes", async () => {
		await contextFor();
		const { beginExport, exportJob, exportStep } = await import("../src/backup");
		const { SNAPSHOTS, stageName } = await import("../src/corpus/snapshots");
		const name = `pv${crypto.randomUUID().slice(0, 6)}`, g = crypto.randomUUID().slice(0, 8), META = "corpus_store_meta", store = `corpus-${name}`;
		await accountSql((sql) => {
			const now = new Date().toISOString();
			sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g}`, g, now);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g, name, now);
		});
		const corpus = env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`));
		const on = <T,>(f: (s: DurableObjectState) => T) => runInDurableObject(corpus, (_i, s) => f(s));
		await on((s) => {
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g]]) s.storage.sql.exec(`INSERT INTO ${META} (key, value) VALUES (?, ?)`, k, v);
			for (let i = 1; i <= 1200; i++) s.storage.sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name) VALUES (?, 'org/alpha', ?, ?, ?)", i, i, i, `dev-${i}`);
		});
		// The store's own spec, as its alarm passes it: never a preserve flag, so every step below reads the flag from the saved job.
		const spec = { store, userId: OWNER, metaTable: META, control: Object.keys(SNAPSHOTS).map(stageName), profile: name, generation: g, rowid: true };
		const drive = async (e: Env = env) => {
			for (let i = 0; i < 20; i++) { const r = await on((s) => exportStep(s.storage, e, spec, () => null)); if (!r.ok || r.value.done) return r; }
			throw new Error("the export did not finish");
		};
		const objects = async (ids: string[]) => Promise.all(ids.map(async (id) => (await env.BACKUPS.list({ prefix: `exports/${store}/${id}/` })).objects.map((o) => `${o.key}:${o.etag}`)));
		const ask = (extra: { preserve_existing?: boolean } = {}) => admin({ op: "export", profile: name, corpus: true, ...extra });

		// A preserve request while a default job runs is refused as busy, and that job keeps running unchanged.
		const plain = await on((s) => beginExport(s.storage, spec).id);
		expect(await ask({ preserve_existing: true })).toMatchObject({ ok: false, error: { details: { results: { [store]: { error: { code: "busy", details: { reason: "export_running" } } } } } } });
		expect(await on((s) => exportJob(s.storage.sql, META))).toEqual(expect.objectContaining({ id: plain }));
		expect(await on((s) => exportJob(s.storage.sql, META)?.preserve)).toBeUndefined();
		expect(await drive()).toMatchObject({ ok: true, value: { id: plain, done: true } });
		const second = await settled(name, g, (await value<Record<string, { id: string }>>(ask()))[store]!.id);
		expect(await listExports(env, store)).toEqual([plain, second]);
		const before = await objects([plain, second]);

		// Through the owner's request: its publication leaves both earlier exports. exportNow arms an immediate alarm that Miniflare may
		// run before any read here, so this checks the finished outcome, not the in-flight job; the store's alarm steps with its own spec,
		// which never carries the flag, so keeping all three shows it came from the saved job. The saved field is checked directly below.
		const asked = (await value<Record<string, { id: string }>>(ask({ preserve_existing: true })))[store]!.id;
		await settled(name, g, asked);
		expect(await listExports(env, store)).toEqual([plain, second, asked]);
		expect(await objects([plain, second])).toEqual(before);

		// Across several steps and a failed manifest put: the publishing job keeps its flag, and its retry still deletes nothing.
		let puts = 0, manifestFailed = false;
		const flaky = { ...env, BACKUPS: { head: (k: string) => env.BACKUPS.head(k), list: (o: R2ListOptions) => env.BACKUPS.list(o), delete: (k: string[]) => env.BACKUPS.delete(k),
			put: (k: string, v: Uint8Array) => (k.endsWith("manifest.enc") ? !manifestFailed && (manifestFailed = true) : ++puts === 2) ? Promise.reject(new Error("r2 down")) : env.BACKUPS.put(k, v) } } as unknown as Env;
		const kept = await on((s) => beginExport(s.storage, { ...spec, preserve: true }).id);
		expect(await drive(flaky)).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await on((s) => exportJob(s.storage.sql, META))).toMatchObject({ id: kept, phase: "baseline", n: 1, preserve: true });
		expect(await drive(flaky)).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(await on((s) => exportJob(s.storage.sql, META))).toMatchObject({ id: kept, phase: "publishing", preserve: true });
		expect(await drive()).toMatchObject({ ok: true, value: { id: kept, done: true } });
		expect(await listExports(env, store)).toEqual([plain, second, asked, kept]);
		expect(await objects([plain, second])).toEqual(before);

		// A job saved before this flag existed (no preserve key) still applies retention: the two newest remain.
		const old = await on((s) => beginExport(s.storage, spec).id);
		expect(await on((s) => s.storage.sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = 'export_job'`).one().value)).not.toContain("preserve");
		expect(await drive()).toMatchObject({ ok: true, value: { id: old, done: true } });
		expect(await listExports(env, store)).toEqual([kept, old]);
	});

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
		const exportCorpus = async () => settled(name, g1, (await value<Record<string, { id: string }>>(admin({ op: "export", profile: name, corpus: true })))[`corpus-${name}`]!.id);
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
		expect(await value(corpusRestored())).toMatchObject({ state: "ready" });
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
		const r = await driveTransfer(ports, { id, nodeId, from, to, companyFree: true }, (await contextFor()).caller);
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

	it("a moved me copy is refused when its retained image holds a contact field, before any change; an unfinished choice resumes from its durable body", async () => {
		const c0 = await contextFor();
		const n = await call<{ memory_id: string }>(c0, "save_memory", { name: "Kestrel rule", type: "feedback", description: "a me rule", content: "kestrelmarker body", profile: "me", company_free: true });
		const t = await move(n.memory_id, "me", "personal");
		await tamper("personal", n.memory_id);
		const captured = await exportOf("personal");
		await tamper("personal", n.memory_id, null);
		// Issue #3: a registered term alone never refuses the restore; a contact field in the retained image does.
		await value(admin({ op: "addSensitiveTerm", term: "kestrelmarker" }));
		await onProfile("me", (sql) => sql.exec("UPDATE archive SET payload = replace(payload, 'kestrelmarker', 'kestrel@example.com') WHERE payload LIKE '%kestrelmarker%'"));
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

	it("a planned undo into me is refused when a retained revision holds a contact field, before either copy changes", async () => {
		const c = await contextFor();
		const u = await undoCase("me", async (id) => { await call(c, "save_memory", { memory_id: id, content: "clean body", profile: "me", company_free: true }); },
			{ type: "feedback", content: "corvidmark old body", company_free: true });
		await value(admin({ op: "addSensitiveTerm", term: "corvidmark" }));
		await onProfile("me", (sql) => sql.exec("UPDATE revisions SET snapshot = replace(snapshot, 'corvidmark', 'corvid@example.com') WHERE node_id = ?", u.id));
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

	/** The recovery as an earlier version left it: unresolved on `found`, whatever this version's rebuild concluded. */
	const leftUnresolved = (found: { kind: string; id: string }[]) => accountSql((sql) => {
		const r = JSON.parse(sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = 'recovery_state'").one().value) as AccountRecovery;
		sql.exec("UPDATE account_meta SET value = ? WHERE key = 'recovery_state'", JSON.stringify({ ...r, state: "unresolved", phase: undefined, unresolved: found, unresolved_count: found.length }));
	});
	type Placement = { finding: boolean; binding: { profile: string } | null; rebuild: { binds: string | null; flags: boolean } };

	it("account restore: a request id on moved copies binds to its later owner unflagged, and an owner recheck continues a stale finding left unresolved", async () => {
		const c = await contextFor();
		const saved = await call<{ memory_id: string }>(c, "save_memory", { name: "Moved twice", type: "reference", description: "m", content: "moved body", profile: "me", request_id: "r-1" });
		await move(saved.memory_id, "me", "personal");
		await move(saved.memory_id, "personal", "test");
		const exported = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		// Moved copies in me and personal sort before the active one in test (work was wiped above): nodes first, so the request binds to test.
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		const r = await accountSteps();
		expect(r).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		expect([await bound(saved.memory_id), await binding("r-1")]).toEqual(["test", "test"]);

		// A short id the MCP tools accept is inspected and rechecked like any other.
		const stale = [{ kind: "request_elsewhere", id: "r-1" }];
		await leftUnresolved(stale);
		expect(await value<Placement>(admin({ op: "recoveryRequest", id: r.id, request_id: "r-1" }))).toMatchObject({ finding: true, binding: { profile: "test" }, rebuild: { binds: "test", flags: false } });
		const recheck = (request_ids: string[]) => admin({ op: "recheckRequests", id: r.id, request_ids });
		expect(await recheck(["other-req-1"])).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "findings_changed" } } });
		// A binding whose hash differs from the owner's row is a divergence, not ordering: refused, nothing changes.
		const hash = await accountSql((sql) => sql.exec<{ payload_hash: string }>("SELECT payload_hash FROM request_index WHERE request_id = 'r-1'").one().payload_hash);
		await accountSql((sql) => sql.exec("UPDATE request_index SET payload_hash = 'diverged' WHERE request_id = 'r-1'"));
		expect(await recheck(["r-1"])).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "binding_differs" } } });
		expect(await status()).toMatchObject({ state: "unresolved", unresolved: stale });
		await accountSql((sql) => sql.exec("UPDATE request_index SET payload_hash = ? WHERE request_id = 'r-1'", hash));

		expect(await value(recheck(["r-1"]))).toMatchObject({ state: "reconciling", phase: "index", unresolved: [], rechecks: [{ findings: stale }] });
		expect(await recheck(["r-1"])).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "not_unresolved" } } });
		expect(await accountSteps()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0, rechecks: [{ findings: stale }] });
		expect([await bound(saved.memory_id), await binding("r-1")]).toEqual(["test", "test"]);
		await abortAccount();
	});

	it("account restore: a request whose node was moved and then forgotten stays with the profile that archived it, and a recheck continues the earlier finding", async () => {
		const c = await contextFor();
		const saved = await call<{ memory_id: string }>(c, "save_memory", { name: "Moved then forgotten", type: "reference", description: "f", content: "forgotten body", profile: "personal", request_id: "forgot-req-1" });
		await move(saved.memory_id, "personal", "test");
		// An owner forget archives the node and keeps its receipts and the account's index rows.
		const ref = c.account.profiles.find((p) => p.profile === "test")!, cmd = { op: "owner" as const, args: { action: "forget" as const, memory_id: saved.memory_id } };
		await value(profileStub(env, ref).write(ref, cmd, { actor: "owner", platform: "dashboard", routedBy: "explicit", userId: OWNER, payloadHash: requestHash(cmd.op, cmd.args) }));
		expect([await bound(saved.memory_id), await binding("forgot-req-1")]).toEqual(["test", "test"]);
		const exported = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		const r = await accountSteps();
		expect(r).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		expect([await bound(saved.memory_id), await binding("forgot-req-1")]).toEqual(["test", "test"]);

		// The earlier rebuild's result: no index for the archived node, the request bound to the moved copy, and the finding.
		const stale = [{ kind: "request_elsewhere", id: "forgot-req-1" }];
		await accountSql((sql) => { sql.exec("DELETE FROM node_index WHERE node_id = ?", saved.memory_id); sql.exec("UPDATE request_index SET profile = 'personal' WHERE request_id = 'forgot-req-1'"); });
		await leftUnresolved(stale);
		expect(await value(admin({ op: "recoveryRequest", id: r.id, request_id: "forgot-req-1" }))).toMatchObject({ finding: true, binding: { profile: "personal" },
			nodes: [{ owner: null, held: "test", wiped: false }], rebuild: { binds: "test", flags: false } });
		expect(await value(admin({ op: "recheckRequests", id: r.id, request_ids: ["forgot-req-1"] }))).toMatchObject({ state: "reconciling", rechecks: [{ findings: stale }] });
		expect(await accountSteps()).toMatchObject({ state: "ready", unresolved: [], unresolved_count: 0 });
		expect([await bound(saved.memory_id), await binding("forgot-req-1")]).toEqual(["test", "test"]);
		await abortAccount();
	});

	it("account restore: a request id two profiles hold with no common owner stays a finding, and a recheck refuses it unchanged", async () => {
		const c = await contextFor(), CLASH = "clash/€ 1"; // spaces, slashes and non-ASCII are request ids too
		await call(c, "save_memory", { name: "Clash", type: "reference", description: "c", content: "clash body", profile: "personal", request_id: CLASH });
		// The same request id in test, on no node and with another payload: a true collision.
		const row = await onProfile("personal", (sql) => sql.exec("SELECT * FROM requests WHERE request_id = ?", CLASH).one());
		await onProfile("test", (sql) => {
			const r: Record<string, unknown> = { ...row, node_id: null, payload_hash: "another-payload" }, cols = Object.keys(r);
			sql.exec(`INSERT INTO requests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((k) => r[k] as SqlStorageValue));
		});
		const exported = await value<Record<string, { id: string }>>(admin({ op: "export" }));
		await value(admin({ op: "beginAccountRestore", export: exported.account!.id }));
		const found = [{ kind: "request_elsewhere", id: CLASH }];
		const r = await accountSteps();
		expect(r).toMatchObject({ state: "unresolved", unresolved: found, unresolved_count: 1 });
		expect(await value<Placement>(admin({ op: "recoveryRequest", id: r.id, request_id: CLASH }))).toMatchObject({ finding: true, binding: { profile: "personal" }, rebuild: { flags: true } });
		expect(await admin({ op: "recheckRequests", id: r.id, request_ids: [CLASH] })).toMatchObject({ ok: false, error: { code: "validation", details: { reason: "not_one_node" } } });
		expect(await status()).toMatchObject({ state: "unresolved", unresolved: found });
		expect(await admin({ op: "openRestore" })).toMatchObject({ ok: false, error: { code: "validation" } });
		await abortAccount();
		await onProfile("test", (sql) => sql.exec("DELETE FROM requests WHERE request_id = ?", CLASH));
	});
});

// The restore drill (section 18): a scratch generation restored from the newest compatible export, checked and cleaned up
// while the account stays open; its exclusion holds every recovery begin and the wipe until nothing of the copy remains.
describe("restore drill", () => {
	type Drill = { id: string; state: string; scratch: string | null; live_generation: string; export: string; passed?: boolean; error?: { code: string };
		report: { chunks: number; rows: Record<string, number>; nodes: number; requests: number; vectors: number; owned_elsewhere: number; requests_elsewhere: number; wiped: number;
			account: { export: string; chunks: number; rows: number } | null; live_generation_unchanged: boolean; cleaned: { vectors: number; scratch: boolean } } };
	const vectorIds = () => (env.VECTORS as unknown as { _ids(): Promise<string[]> })._ids();
	const live = async (generation: string) => ({
		account: await accountSql((sql) => [sql.exec("SELECT node_id, profile FROM node_index ORDER BY node_id").toArray(), sql.exec("SELECT request_id, profile, op, payload_hash FROM request_index ORDER BY request_id").toArray(),
			sql.exec("SELECT name, generation, status FROM profiles ORDER BY name").toArray()]),
		vectors: (await vectorIds()).filter((v) => v.startsWith(`g${generation}:`)).sort(),
	});
	/** Every recovery begin and the wipe, each answering before any change; the wipe's typed name is wrong, so a missing guard cannot wipe. */
	const begins = async (profile: string) => Promise.all([
		admin({ op: "beginRestore", profile, export: "latest" }), admin({ op: "beginAccountRestore", export: "latest" }),
		admin({ op: "beginPitr", profile, at: new Date(Date.now() - 60_000).toISOString() }), admin({ op: "beginCorpusRestore", profile, export: "latest" }),
		admin({ op: "wipeProfile", profile, typed: "not-this-profile" })]);
	const stepUntilDone = async (id: string, op: "drillStep" | "drillCleanup" = "drillStep") => {
		for (let i = 0; i < 40; i++) {
			const d = await value<Drill>(admin({ op, id }));
			if (d.state === "done") return d;
		}
		throw new Error("the drill did not finish");
	};

	it("restores, embeds under its own ids, checks and cleans up a scratch copy, with the live profile, indexes and vectors unchanged; replays by request id", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Drill card", type: "reference", description: "drilled", content: "drill canary body", profile: "personal", request_id: "drill-card-1" });
		await value(admin({ op: "export" }));
		const generation = await genOf("personal"), before = await live(generation);
		const begun = await value<Drill>(admin({ op: "beginDrill", profile: "personal", generation, request_id: "drill-req-1" }));
		expect(begun).toMatchObject({ state: "restoring", live_generation: generation, scratch: expect.any(String) });
		expect(begun.scratch).not.toBe(generation);
		expect(await value(admin({ op: "beginDrill", profile: "personal", generation, request_id: "drill-req-1" }))).toEqual(begun);
		expect(await admin({ op: "beginDrill", profile: "work", request_id: "drill-req-1" })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
		expect(await admin({ op: "beginDrill", profile: "personal", request_id: "drill-req-2" })).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "drill_open" } } });
		// The account stays open, and every recovery begin and the wipe wait for the drill.
		expect(await call(c, "get_memory", { memory_id: (await call<{ memory_id: string }>(c, "save_memory", { name: "During drill", type: "reference", description: "d", profile: "personal" })).memory_id })).toMatchObject({ name: "During drill" });
		for (const r of await begins("personal")) expect(r).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "drill_open" } } });

		const d = await stepUntilDone(begun.id);
		expect(d).toMatchObject({ state: "done", passed: true, report: { live_generation_unchanged: true, cleaned: { scratch: true } } });
		for (const n of ["chunks", "nodes", "requests", "vectors", "owned_elsewhere", "requests_elsewhere", "wiped"] as const) expect(typeof d.report[n]).toBe("number");
		expect(d.report.nodes).toBeGreaterThan(0);
		expect(d.report.vectors).toBeGreaterThan(0);
		expect(d.report.cleaned.vectors).toBe(d.report.nodes); // every scratch node's own id, embedded or not
		// One bounded step can run the whole drill, so its g<scratch>: vectors come and go inside it: the counts say they were
		// embedded and deleted, none is left, and the live generation's own vectors are all still there (below).
		expect((await vectorIds()).filter((v) => v.startsWith(`g${begun.scratch}:`))).toEqual([]);
		expect(d.report.account).toMatchObject({ export: expect.any(String), chunks: expect.any(Number), rows: expect.any(Number) });
		expect(Object.values(d.report.rows).every((n) => typeof n === "number")).toBe(true);
		const after = await live(generation);
		// The drill wrote none of the live state: the profiles rows are as they were, and every node_index and request_index row
		// from before is unchanged (the record saved during the drill only adds its own).
		expect(after.account[2]).toEqual(before.account[2]);
		for (const i of [0, 1] as const) expect(after.account[i]).toEqual(expect.arrayContaining(before.account[i]!));
		expect(before.vectors.filter((v) => !after.vectors.includes(v))).toEqual([]);
		expect(await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${begun.scratch}`)), (_i, st) => st.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").one().n)).toBe(0); // nothing of the copy is left
		expect(await (await env.BACKUPS.get(`generations/${begun.scratch}.json`))!.json()).toMatchObject({ purpose: "scratch", state: "retired" });
		expect(await value(admin({ op: "drillStatus" }))).toMatchObject({ drill: null, last: { id: begun.id, state: "done" } });
		expect(await value(admin({ op: "beginDrill", profile: "personal", generation, request_id: "drill-req-1" }))).toMatchObject({ id: begun.id, state: "done" });
		expect(await admin({ op: "beginDrill", profile: "personal", generation: "stale-generation", request_id: "drill-req-3" })).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "generation_changed" } } });
	});

	it("cleanup deletes every scratch node's vector, including one whose accepted upsert was never recorded, and leaves live vectors", async () => {
		const c = await contextFor();
		const r = await call<{ memory_id: string }>(c, "save_memory", { name: "Drill retired", type: "reference", description: "r", content: "retired body", profile: "personal" });
		await call(c, "save_memory", { memory_id: r.memory_id, retire: true });
		await value(admin({ op: "export", profile: "personal" }));
		const generation = await genOf("personal"), liveBefore = (await vectorIds()).filter((v) => v.startsWith(`g${generation}:`));
		const begun = await value<Drill>(admin({ op: "beginDrill", profile: "personal", request_id: "drill-orphan-1" }));
		// Vectorize accepted this upsert, but its reply never reached the scratch store: no embed_hash records it.
		await (env.VECTORS as unknown as { upsert(v: unknown[]): Promise<unknown> }).upsert([{ id: `g${begun.scratch}:${r.memory_id}`, values: Array.from({ length: 64 }, () => 1), namespace: `${OWNER}:personal:g${begun.scratch}` }]);
		expect(await stepUntilDone(begun.id)).toMatchObject({ state: "done", passed: true, report: { cleaned: { scratch: true } } });
		expect((await vectorIds()).filter((v) => v.startsWith(`g${begun.scratch}:`))).toEqual([]);
		const liveAfter = await vectorIds();
		expect(liveBefore.filter((v) => !liveAfter.includes(v))).toEqual([]);
	});

	it("a restore whose manifest read was pending when a drill began is refused, opens no recovery and keeps the drill", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Drill race", type: "reference", description: "r", content: "race body", profile: "personal" });
		const generation = await genOf("personal");
		// A corpus export of personal, so its corpus restore reaches its manifest read too.
		await runInDurableObject(env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:personal:${generation}`)), (_i, st) => {
			const sql = st.storage.sql;
			if (!sql.exec("SELECT 1 FROM corpus_store_meta WHERE key = 'user_id'").toArray().length) for (const [k, v] of [["user_id", OWNER], ["profile", "personal"], ["generation", generation]]) sql.exec("INSERT INTO corpus_store_meta (key, value) VALUES (?, ?)", k, v);
			sql.exec("INSERT OR IGNORE INTO repos (rowid, full_name, owner, name, archived, private, commit_count, ref_count, empty) VALUES (3, 'org/race', 'org', 'race', 0, 1, 1, 1, 0)");
		});
		await settled("personal", generation, (await value<Record<string, { id: string }>>(admin({ op: "export", corpus: true })))["corpus-personal"]!.id);
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER));
		/** Holds the account's first read of a manifest under `prefix` until released: the begin's await, made wide. */
		const hold = async (prefix: string) => {
			let release!: () => void, held = false;
			const gate = new Promise<void>((r) => { release = r; });
			let base: Env | undefined;
			await runInDurableObject(account, (instance) => {
				const inst = instance as unknown as { env: Env };
				base = inst.env;
				const r2 = base.BACKUPS as unknown as Record<string, unknown>;
				const backups = new Proxy(r2, { get: (t, k) => {
					const v = t[k as string];
					if (k !== "get") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
					return async (key: string, ...rest: unknown[]) => {
						if (!held && key.startsWith(prefix) && key.endsWith("/manifest.enc")) { held = true; await gate; }
						return (v as (...a: unknown[]) => unknown).call(t, key, ...rest);
					};
				} });
				inst.env = new Proxy(base, { get: (t, k) => (k === "BACKUPS" ? backups : (t as unknown as Record<string, unknown>)[k as string]) }) as Env;
			});
			return { held: () => held, release: () => release(), restore: () => runInDurableObject(account, (instance) => { (instance as unknown as { env: Env }).env = base!; }) };
		};
		const flows: [string, () => Promise<Outcome<unknown>>][] = [
			["exports/profile-personal/", () => admin({ op: "beginRestore", profile: "personal", export: "latest" })],
			["exports/account/", () => admin({ op: "beginAccountRestore", export: "latest" })],
			["exports/corpus-personal/", () => admin({ op: "beginCorpusRestore", profile: "personal", export: "latest" })]];
		for (const [i, [prefix, begin]] of flows.entries()) {
			const h = await hold(prefix);
			try {
				const pending = begin();
				for (let n = 0; n < 200 && !h.held(); n++) await new Promise((r) => setTimeout(r, 5));
				expect([prefix, h.held()]).toEqual([prefix, true]);
				const drill = await value<Drill>(admin({ op: "beginDrill", profile: "personal", request_id: `drill-race-${i}` }));
				h.release();
				expect([prefix, await pending]).toEqual([prefix, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "busy", details: expect.objectContaining({ reason: "drill_open" }) }) })]);
				expect(await value<{ recovery: unknown }>(admin({ op: "restoreStatus" }))).toMatchObject({ recovery: null });
				expect((await value<{ drill: Drill | null }>(admin({ op: "drillStatus" }))).drill?.id).toBe(drill.id);
				await h.restore();
				expect(await stepUntilDone(drill.id, "drillCleanup")).toMatchObject({ state: "done" });
			} finally {
				h.release();
				await h.restore();
				// Whatever the outcome, nothing stays open for the next flow.
				const open = await value<{ recovery: { id: string } | null }>(admin({ op: "restoreStatus" }));
				if (open.recovery) for (let n = 0; n < 60 && (await value<{ recovery: unknown }>(admin({ op: "restoreStatus" }))).recovery; n++) await admin({ op: "abortRestore" });
				const d = (await value<{ drill: Drill | null }>(admin({ op: "drillStatus" }))).drill;
				if (d) await stepUntilDone(d.id, "drillCleanup").catch(() => undefined);
			}
		}
	});

	it("a step whose restore reply was pending when cleanup began cannot reopen embedding or the drill, on success or failure", async () => {
		const c = await contextFor();
		// A card the fake model answers after 1.5 s: an embed admitted late would upsert well after cleanup finished.
		await call(c, "save_memory", { name: "Stale reply", type: "reference", description: "late [[embed-slow]]", content: "stale body", profile: "personal" });
		await value(admin({ op: "export", profile: "personal" }));
		for (const outcome of ["success", "failure"] as const) {
			const begun = await value<Drill>(admin({ op: "beginDrill", profile: "personal", request_id: `drill-stale-${outcome}` }));
			const scratch = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${begun.scratch}`));
			let release!: () => void, held = false;
			const gate = new Promise<void>((r) => { release = r; });
			// The scratch restore's first chunk read waits until released, then answers it, or answers nothing.
			await runInDurableObject(scratch, (instance) => {
				const inst = instance as unknown as { env: Env }, base = inst.env, r2 = base.BACKUPS as unknown as Record<string, unknown>;
				const backups = new Proxy(r2, { get: (t, k) => {
					const v = t[k as string];
					if (k !== "get") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
					return async (key: string, ...rest: unknown[]) => {
						if (!held && key.endsWith(".enc") && !key.endsWith("manifest.enc")) { held = true; await gate; if (outcome === "failure") return null; }
						return (v as (...a: unknown[]) => unknown).call(t, key, ...rest);
					};
				} });
				inst.env = new Proxy(base, { get: (t, k) => (k === "BACKUPS" ? backups : (t as unknown as Record<string, unknown>)[k as string]) }) as Env;
			});
			const step = admin({ op: "drillStep", id: begun.id });
			for (let n = 0; n < 200 && !held; n++) await new Promise((r) => setTimeout(r, 5));
			expect([outcome, held]).toEqual([outcome, true]);
			const cleanup = admin({ op: "drillCleanup", id: begun.id });
			await new Promise((r) => setTimeout(r, 50)); // cleanup is now waiting on the held restore
			release();
			const [stale, cleaned] = await Promise.all([step, cleanup]);
			// The stale reply moves nothing: the drill was cleaning, and it ends done, cleaned, with no scratch vector, then or later.
			expect([outcome, stale]).toEqual([outcome, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "busy", details: expect.objectContaining({ reason: "drill_changed" }) }) })]);
			let last = cleaned.ok ? cleaned.value as Drill : undefined;
			for (let n = 0; n < 20 && last?.state !== "done"; n++) last = await value<Drill>(admin({ op: "drillCleanup", id: begun.id }));
			expect([outcome, last?.state, last?.report.cleaned.scratch]).toEqual([outcome, "done", true]);
			await new Promise((r) => setTimeout(r, 2_000)); // past any late embed's answer
			expect([outcome, (await vectorIds()).filter((v) => v.startsWith(`g${begun.scratch}:`))]).toEqual([outcome, []]);
			expect([outcome, (await value<{ drill: Drill | null }>(admin({ op: "drillStatus" }))).drill]).toEqual([outcome, null]);
			expect(await (await env.BACKUPS.get(`generations/${begun.scratch}.json`))!.json()).toMatchObject({ state: "retired" });
		}
	});

	it("a failed cleanup keeps every recovery begin and the wipe refused; the gate goes only once the scratch copy and its ledger id are gone", async () => {
		await value(admin({ op: "export", profile: "personal" }));
		const begun = await value<Drill>(admin({ op: "beginDrill", profile: "personal", request_id: "drill-fail-1" }));
		const scratch = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:personal:${begun.scratch}`));
		// A stray copy under another identity in the scratch object: the restore refuses it, and so does the cleanup.
		await runInDurableObject(scratch, (_i, st) => { for (const [k, v] of [["user_id", OWNER], ["profile", "personal"], ["generation", "someone-else"]]) st.storage.sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, ?)", k, v); });
		// The refused restore ends the checks, recorded, and the cleanup that follows refuses too: the drill stays cleaning.
		expect(await value(admin({ op: "drillStep", id: begun.id }))).toMatchObject({ state: "cleaning", error: expect.any(Object) });
		expect((await admin({ op: "drillStep", id: begun.id })).ok).toBe(false);
		expect((await value<{ drill: Drill | null }>(admin({ op: "drillStatus" }))).drill).toMatchObject({ state: "cleaning", error: expect.any(Object) });
		for (const r of await begins("personal")) expect(r).toMatchObject({ ok: false, error: { code: "busy", details: { reason: "drill_open" } } });
		expect(await (await env.BACKUPS.get(`generations/${begun.scratch}.json`))!.json()).toMatchObject({ state: "reserved" });
		// With the stray identity gone, cleanup finishes, retires the scratch id, and only then lets recoveries begin again.
		await runInDurableObject(scratch, (_i, st) => st.storage.sql.exec("DELETE FROM profile_meta WHERE key IN ('user_id', 'profile', 'generation')"));
		const done = await stepUntilDone(begun.id, "drillCleanup");
		expect(done).toMatchObject({ state: "done", passed: false, error: expect.any(Object), report: { cleaned: { scratch: true } } });
		expect(await (await env.BACKUPS.get(`generations/${begun.scratch}.json`))!.json()).toMatchObject({ state: "retired" });
		const restore = await value<Recovery>(admin({ op: "beginRestore", profile: "personal", export: "latest" }));
		expect(await value(admin({ op: "abortRestore", id: restore.id }))).toMatchObject({ state: "aborted" });
	});
});

// Last in this file: a full scheduled export touches every active store of the shared account.
describe("scheduled export attribution", () => {
	it("binds the platform's scheduled event to the stored result with each store's generation and export id; a manual run is manual; a corpus is due and running, then skipped as recent", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Scheduled probe", type: "reference", description: "s", content: "scheduled body", profile: "personal" }); // a bound profile exports
		const name = `sx${crypto.randomUUID().slice(0, 6)}`, g = crypto.randomUUID().slice(0, 8);
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => {
			const now = new Date().toISOString();
			st.storage.sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g}`, g, now);
			st.storage.sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g, name, now);
		});
		await runInDurableObject(env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`)), (_i, st) => {
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g]]) st.storage.sql.exec("INSERT INTO corpus_store_meta (key, value) VALUES (?, ?)", k, v);
			st.storage.sql.exec("INSERT INTO contributors (rowid, repo, rank, commits, name) VALUES (2, 'org/alpha', 1, 1, 'dev')");
		});
		type Store = { generation: string | null; state: string; export_id: string | null; due?: boolean; export_generation?: string | null };
		const status = () => value<{ last_export: { trigger: Record<string, unknown>; stores: Record<string, Store> } | null; last_export_failed: unknown }>(admin({ op: "restoreStatus" }));

		const ctx = createExecutionContext();
		await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse("2026-11-03T03:17:00Z"), cron: "17 3 * * *" }), env, ctx);
		await waitOnExecutionContext(ctx);
		const nightly = (await status()).last_export!;
		expect(nightly.trigger).toEqual({ kind: "scheduled", scheduled_time: "2026-11-03T03:17:00.000Z", cron: "17 3 * * *" });
		expect(nightly.stores.personal).toMatchObject({ generation: await personal(), state: "completed" });
		expect(await listExports(env, "profile-personal")).toContain(nightly.stores.personal!.export_id);
		expect(nightly.stores.account).toMatchObject({ generation: null, state: "completed" });
		expect(await listExports(env, "account")).toContain(nightly.stores.account!.export_id);
		// The corpus was due (no complete export yet) and its export is running, named by its id, not claimed as saved.
		const corpus = nightly.stores[`corpus-${name}`]!;
		expect(corpus).toMatchObject({ generation: g, state: "running", due: true });
		expect(await settled(name, g, corpus.export_id!)).toBe(corpus.export_id);

		// A manual run says so, and the corpus is skipped as covered by that recent export of generation g.
		await value(admin({ op: "export" }));
		const manual = (await status()).last_export!;
		expect(manual.trigger).toEqual({ kind: "manual" });
		expect(manual.stores[`corpus-${name}`]).toEqual({ generation: g, state: "skipped_recent", export_id: corpus.export_id, due: false, export_generation: g });
	});
});

describe("corpus restore search index at scale", () => {
	it("with a deployed (frozen) clock, rebuilds the search index in fixed batches: chunks, then 50,000 documents, then the rest, then the final checks", async () => {
		await contextFor();
		const name = `fz${crypto.randomUUID().slice(0, 6)}`, g1 = crypto.randomUUID().slice(0, 8), g2 = crypto.randomUUID().slice(0, 8), N = 50_201;
		const acct = (f: (sql: SqlStorage) => void) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => f(s.storage.sql));
		const corpus = (g: string) => env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`));
		await acct((sql) => {
			const now = new Date().toISOString();
			sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g1}`, g1, now);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g1, name, now);
		});
		await runInDurableObject(corpus(g1), (_i, s) => {
			const sql = s.storage.sql;
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g1]]) sql.exec("INSERT INTO corpus_store_meta (key, value) VALUES (?, ?)", k, v);
			for (let i = 1; i <= N; i++) sql.exec("INSERT INTO corpus_search_documents (rowid, evidence_id, kind, key, repo, date, title, detail) VALUES (?, ?, 'commit', ?, 'org/alpha', '2026-01-01', ?, ?)",
				i, `e:${i}`, `k${i}`, `title ${i}`, `detail words ${i % 997}`);
		});
		const id = await settled(name, g1, (await value<Record<string, { id: string }>>(admin({ op: "export", profile: name, corpus: true })))[`corpus-${name}`]!.id);
		await acct((sql) => {
			sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g2, `${OWNER}:${name}:${g2}`, name);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g2, name, new Date().toISOString());
			sql.exec("UPDATE generations SET state = 'retired' WHERE id = ?", g1);
		});
		await value(admin({ op: "beginCorpusRestore", profile: name, export: id }));
		const restored = (k: string) => runInDurableObject(corpus(g2), (_i, s) => s.storage.sql.exec("SELECT value FROM corpus_store_meta WHERE key = ?", k).toArray()[0]?.value);
		type Step = Recovery & { progress?: { applied: number; chunks: number; done: boolean } };
		const step = () => value<Step>(admin({ op: "restoreStep" }));
		// A deployed Worker's clock advances only on I/O; frozen here, so only a fixed count can end a synchronous rebuild.
		const T = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(T);
		try {
			expect(await runInDurableObject(corpus(g2), () => Date.now())).toBe(T);
			// 1: the step that applies the last chunk does no index work.
			const s1 = await step();
			expect(s1.progress).toMatchObject({ done: false });
			expect(s1.progress!.applied).toBe(s1.progress!.chunks);
			expect(await restored("restore_fts")).toBe("0");
			// 2: exactly 250 batches of 200 documents.
			expect((await step()).progress).toMatchObject({ done: false });
			expect(await restored("restore_fts")).toBe("50000");
			// 3: the remaining 201 documents finish the index, without the final checks.
			expect((await step()).progress).toMatchObject({ done: false });
			expect([await restored("restore_fts"), await restored("restore_done")]).toEqual(["done", undefined]);
			// 4: the final counts, then ready.
			expect((await step()).state).toBe("ready");
			expect(await restored("restore_done")).toBe(id);
		} finally { vi.restoreAllMocks(); }
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect(await runInDurableObject(corpus(g2), (_i, s) => s.storage.sql.exec("SELECT count(*) AS n FROM corpus_search_documents").one().n)).toBe(N);
	}, 300_000);
});

describe("corpus restore abort during a step", () => {
	it("a step paused in its authority or manifest read never writes after an abort, fresh or resumed; a later restore still fills the generation", async () => {
		await contextFor();
		const name = `ca${crypto.randomUUID().slice(0, 6)}`, g1 = crypto.randomUUID().slice(0, 8), g2 = crypto.randomUUID().slice(0, 8);
		const acct = (f: (sql: SqlStorage) => void) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, s) => f(s.storage.sql));
		const corpus = (g: string) => env.CORPUS_STORE!.get(env.CORPUS_STORE!.idFromName(`${OWNER}:${name}:${g}`));
		await acct((sql) => {
			const now = new Date().toISOString();
			sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${g1}`, g1, now);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", g1, name, now);
		});
		await runInDurableObject(corpus(g1), (_i, s) => {
			const sql = s.storage.sql;
			for (const [k, v] of [["user_id", OWNER], ["profile", name], ["generation", g1]]) sql.exec("INSERT INTO corpus_store_meta (key, value) VALUES (?, ?)", k, v);
			sql.exec("INSERT INTO repos (rowid, full_name, owner, name, archived, private, commit_count, ref_count, empty) VALUES (7, 'org/alpha', 'org', 'alpha', 0, 1, 1, 1, 0)");
		});
		const id = await settled(name, g1, (await value<Record<string, { id: string }>>(admin({ op: "export", profile: name, corpus: true })))[`corpus-${name}`]!.id);
		await acct((sql) => {
			sql.exec("UPDATE profiles SET generation = ?, object_name = ? WHERE name = ?", g2, `${OWNER}:${name}:${g2}`, name);
			sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'restore', 'active', ?, 1)", g2, name, new Date().toISOString());
			sql.exec("UPDATE generations SET state = 'retired' WHERE id = ?", g1);
		});
		const state = () => runInDurableObject(corpus(g2), (_i, s) => ({
			markers: s.storage.sql.exec("SELECT key FROM corpus_store_meta WHERE key LIKE 'restore_%' ORDER BY key").toArray().map((r) => r.key),
			repos: s.storage.sql.exec("SELECT count(*) AS n FROM repos").one().n,
		}));
		let paused: "authority" | "manifest" | false = false, reached = () => {}, release = () => {};
		const pause = async (at: "authority" | "manifest") => {
			if (paused === at) { paused = false; await new Promise<void>((r) => { release = r; reached(); }); }
		};
		await runInDurableObject(corpus(g2), (inst) => {
			const own = inst as unknown as { env: Env }, bucket = own.env.BACKUPS;
			const accounts = new Proxy(own.env.ACCOUNT, { get: (t, p) => p !== "get" ? (Reflect.get(t, p) as (...a: unknown[]) => unknown).bind?.(t) ?? Reflect.get(t, p)
				: (...args: unknown[]) => new Proxy((t.get as (...a: unknown[]) => object).apply(t, args), {
					get: (stub, key) => key !== "restoreAuthority" ? Reflect.get(stub, key) : async (...a: unknown[]) => {
						const result = await Reflect.apply(Reflect.get(stub, key) as (...a: unknown[]) => Promise<Outcome<unknown>>, stub, a);
						if (result.ok) await pause("authority");
						return result;
					},
				}) });
			const backups = new Proxy(bucket, { get: (t, p) => p !== "get" ? (Reflect.get(t, p) as (...a: unknown[]) => unknown).bind?.(t) ?? Reflect.get(t, p)
				: async (k: string, ...a: unknown[]) => {
					if (k.endsWith("/manifest.enc")) await pause("manifest");
					return (bucket.get as (...x: unknown[]) => unknown).call(bucket, k, ...a);
				} });
			own.env = Object.create(own.env, { ACCOUNT: { value: accounts }, BACKUPS: { value: backups } }) as Env;
		});
		const abortedDuringStep = async (at: "authority" | "manifest") => {
			paused = at;
			const waiting = new Promise<void>((r) => { reached = r; });
			const step = admin({ op: "restoreStep" });
			await waiting;
			expect(await value(admin({ op: "abortRestore" }))).toMatchObject({ state: "aborted" });
			expect(await state()).toEqual({ markers: [], repos: 0 });
			release();
			expect(await step).toMatchObject({ ok: false });
			expect(await state()).toEqual({ markers: [], repos: 0 });
		};

		for (const at of ["authority", "manifest"] as const) {
			await value(admin({ op: "beginCorpusRestore", profile: name, export: id }));
			await abortedDuringStep(at);
			await value(admin({ op: "beginCorpusRestore", profile: name, export: id }));
			expect(await value<Recovery & { progress?: { done: boolean } }>(admin({ op: "restoreStep" }))).toMatchObject({ progress: { done: false } });
			expect((await state()).repos).toBe(1);
			await abortedDuringStep(at);
		}

		// The cleared generation still takes a restore to the end.
		await value(admin({ op: "beginCorpusRestore", profile: name, export: id }));
		expect(await value(corpusRestored())).toMatchObject({ state: "ready" });
		expect(await value(admin({ op: "openRestore" }))).toMatchObject({ state: "opened" });
		expect((await state()).repos).toBe(1);
	});
});
