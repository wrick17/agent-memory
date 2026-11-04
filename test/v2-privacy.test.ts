// v2 side tables against a profile wipe and a restore (G0 B1): recall_daily counts and eval_candidates, whose query is
// content, must not outlive a wiped node in any profile, even one that never held the node (the me overlay). Real wipe and
// restore flows on workerd SQLite and local R2; synthetic data only.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountStub } from "../src/mcp";
import { call, contextFor, OWNER } from "./helpers";

const admin = (cmd: Parameters<ReturnType<typeof accountStub>["admin"]>[0]) => accountStub(env, OWNER).admin(cmd);
const value = async <T,>(p: Promise<{ ok: boolean; value?: unknown; error?: unknown }>) => {
	const r = await p;
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.value as T;
};
const genOf = async (name: string) => (await value<{ name: string; generation: string }[]>(admin({ op: "listProfiles" }))).find((p) => p.name === name)!.generation;
const onProfile = async <T,>(name: string, f: (sql: SqlStorage) => T) => {
	const g = await genOf(name);
	return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${name}:${g}`)), (_i, st) => f(st.storage.sql));
};
/** Candidates and counts in `profile`: two name `target` (by expected id and by node evidence), one names `keep`. */
const seed = (sql: SqlStorage, target: string, keep: string, tag: string) => {
	sql.exec(`INSERT INTO eval_candidates (id, query, expected_json, evidence_json, status, created_at, seq) VALUES
		(?, 'which heron?', ?, '[]', 'accepted', '2026-11-04', 1), (?, 'heron again', '["other"]', ?, 'pending', '2026-11-04', 1), (?, 'unrelated', ?, '[]', 'dismissed', '2026-11-04', 1)`,
	`${tag}-exp`, JSON.stringify([target]), `${tag}-ev`, JSON.stringify([{ kind: "node", ref: target }]), `${tag}-keep`, JSON.stringify([keep]));
	sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES (?, '2026-11-01', 3, 1), (?, '2026-11-01', 1, 1)", target, keep);
};
const sideRows = (sql: SqlStorage, tag: string, ids: string[]) => ({
	candidates: sql.exec<{ id: string }>("SELECT id FROM eval_candidates WHERE id LIKE ? ORDER BY id", `${tag}-%`).toArray().map((r) => r.id),
	recall: sql.exec<{ node_id: string }>("SELECT node_id FROM recall_daily WHERE node_id IN (SELECT value FROM json_each(?)) ORDER BY node_id", JSON.stringify(ids)).toArray().map((r) => r.node_id),
});

describe("v2 side tables and the wipe lifecycle", () => {
	it("restores an export with no candidate or count naming a permanently wiped id, and fences the id in the new generation", async () => {
		const c = await contextFor();
		const keep = await call<{ memory_id: string }>(c, "save_memory", { name: "Privacy keep", type: "reference", description: "k", content: "kept body", profile: "personal" });
		const gone = "11111111-2222-5333-8444-555555555555";
		await onProfile("personal", (sql) => seed(sql, gone, keep.memory_id, "r"));
		const id = (await value<Record<string, { id: string }>>(admin({ op: "export", profile: "personal" }))).personal!.id;
		// The permanent identity a wipe leaves in the account (account_meta `wiped:<id>`), for a node personal never held.
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER)), (_i, st) => {
			st.storage.sql.exec("INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, 'me')", `wiped:${gone}`);
		});
		await value(admin({ op: "beginRestore", profile: "personal", export: id }));
		let r: { state: string; unresolved_count?: number } | undefined;
		for (let i = 0; i < 20 && r?.state !== "ready"; i++) r = await value<{ state: string }>(admin({ op: "restoreStep" }));
		expect(r).toMatchObject({ state: "ready", unresolved_count: 0 });
		// The restored generation holds the export's rows until open; the fence phase removes them before it opens.
		for (let i = 0; i < 20 && r?.state !== "opened"; i++) r = await value<{ state: string }>(admin({ op: "openRestore" }));
		expect(r).toMatchObject({ state: "opened" });
		expect(await onProfile("personal", (sql) => ({ ...sideRows(sql, "r", [gone, keep.memory_id]),
			fence: sql.exec("SELECT count(*) AS n FROM profile_meta WHERE key = ?", `wiped:${gone}`).one().n }))).toEqual({ candidates: ["r-keep"], recall: [keep.memory_id], fence: 1 });
	});

	it("purges the candidates and counts that name a wiped profile's node from another profile that never held it", async () => {
		const c = await contextFor();
		const w = await call<{ memory_id: string }>(c, "save_memory", { name: "Privacy wiped", type: "reference", description: "w", content: "heron in test", profile: "test" });
		const keep = await call<{ memory_id: string }>(c, "save_memory", { name: "Privacy survivor", type: "reference", description: "s", content: "survives", profile: "personal" });
		await onProfile("personal", (sql) => seed(sql, w.memory_id, keep.memory_id, "w"));
		const wiped = await value<{ report: string }>(admin({ op: "wipeProfile", profile: "test", typed: "test" }));
		expect(JSON.parse(wiped.report)).toMatchObject({ state: "done" });
		expect(await onProfile("personal", (sql) => sideRows(sql, "w", [w.memory_id, keep.memory_id]))).toEqual({ candidates: ["w-keep"], recall: [keep.memory_id] });
	});
});
