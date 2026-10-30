// AM-12 commit uploads through the real /v1/ingest with a job-scoped token, into the actual profile object, its graph and the board.
// Each case uses its own profile and routing rule on the owner's account, so no other test file shares or closes it.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256, uuid5 } from "../src/domain/ids";
import { OBJECT_LIMIT } from "../src/profile/housekeeping";
import { undo } from "../src/profile/undo";
import { foldStep } from "../src/profile/compact";
import { readContent, runWrite } from "../src/profile/write";
import { commitArgs, uploadTerms } from "../src/profile/work-upload";
import { call, contextFor, deviceToken, OWNER } from "./helpers";

const origin = new URL(env.RESOURCE_URL).origin;
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER));
const hex = (s: string) => sha256(s + crypto.randomUUID()).slice(0, 40);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function post(token: string, payload: unknown) {
	const res = await exports.default.fetch(new Request(`${origin}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
	type Item = { key: string; status: string; reason?: string };
	return { status: res.status, data: await res.json() as { profile?: string; routed_by?: string; results?: unknown[]; commits?: Item[]; marker?: { status: string; reason?: string }; error?: { code: string; message: string; details?: { reason?: string } } } };
}

/** A fresh active profile on the owner's account, a routing rule for its own GitHub org, and a job token for it alone. */
async function isolated() {
	await contextFor();
	const name = `wu${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`, generation = crypto.randomUUID().slice(0, 8), org = `Wu-${name}`;
	await runInDurableObject(account(), (_i, s) => {
		const now = new Date().toISOString(), sql = s.storage.sql;
		sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)", name, `${OWNER}:${name}:${generation}`, generation, now);
		sql.exec("INSERT INTO generations (id, profile, purpose, state, reserved_at, seq) VALUES (?, ?, 'live', 'active', ?, 1)", generation, name, now);
		sql.exec("INSERT INTO routing_rules (id, priority, match, pattern, profile, enabled, seq) VALUES (?, 5, 'remote', ?, ?, 1, 1)", `r-${name}`, `github.com/${org.toLowerCase()}/*`, name);
	});
	const { token } = await deviceToken(`job-${name}`, ["ingest"], [name]);
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${name}:${generation}`));
	const inProfile = <T,>(f: (s: DurableObjectStorage) => T) => runInDurableObject(stub, (_i, st) => f(st.storage));
	return { name, org, ns: `${org}/Web`.toLowerCase(), remote: `git@github.com:${org}/Web.git`, token, who: { userId: OWNER, profile: name, generation }, inProfile, c: await contextFor() };
}

const sorted = <T,>(rows: T[]) => [...rows].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
const graph = (sql: SqlStorage) => sql.exec<{ src: string; rel: string; dst: string; basis: string }>(`SELECT coalesce(a.key, a.name) AS src, e.rel, coalesce(b.key, b.name) AS dst, e.basis
	FROM edges e JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst WHERE e.ended_at IS NULL ORDER BY src, e.rel, dst`).toArray();

describe("work uploads", () => {
	it("publishes commits with their person and project, identifier edges only, board activity, replay and refusal", async () => {
		const p = await isolated();
		const s1 = hex("a"), s2 = hex("b"), asOf = ago(1);
		await call(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "ticket", key: "jira:WU-12", name: "Fix the refresh loop", attrs: { state: "open", priority: "High" } }] });
		// An exact full SHA waits as a mention until the commit arrives.
		await call(p.c, "save_memory", { profile: p.name, name: "wu journal", type: "project", kind: "journal", description: "notes", content: `Looked at ${p.ns}@${s1} today.` });
		const c1 = { sha: s1, at: ago(90), title: "WU-12 fix the token refresh loop", author: "a-lee" };
		const c2 = { sha: s2, at: ago(60), title: "Fixes WU-12; thanks bob@example.com, token=hunter2secret" };
		const body = { repo: { remote: p.remote, path: "/x/web" }, commits: [c1, c2], marker: { head: s2, as_of: asOf } };
		const first = await post(p.token, body);
		expect(first.status).toBe(200);
		expect(first.data).toMatchObject({ profile: p.name, routed_by: `rule:github.com/${p.org.toLowerCase()}/*`, results: [], marker: { status: "stored" } });
		expect(first.data.commits).toEqual([{ key: `git:${p.ns}@${s1}`, status: "stored" }, { key: `git:${p.ns}@${s2}`, status: "stored" }]);

		const before = await p.inProfile((s) => {
			const sql = s.sql;
			expect(sql.exec("SELECT kind, key, name, attrs, valid_from FROM nodes WHERE origin = 'upload' ORDER BY key").toArray()).toEqual([
				{ kind: "commit", key: `git:${p.ns}@${s1}`, name: c1.title, attrs: JSON.stringify({ repo: p.ns, sha: s1 }), valid_from: c1.at },
				{ kind: "commit", key: `git:${p.ns}@${s2}`, name: "Fixes WU-12; thanks [REDACTED], token=[REDACTED]", attrs: JSON.stringify({ repo: p.ns, sha: s2 }), valid_from: c2.at },
				{ kind: "project", key: `github:${p.ns}`, name: p.ns, attrs: "{}", valid_from: null },
				{ kind: "person", key: "person:github:a-lee", name: "a-lee", attrs: JSON.stringify({ github: "a-lee" }), valid_from: null },
			].sort((x, y) => (x.key < y.key ? -1 : 1)));
			// Structured author gives authored, the repo gives part_of, a ticket key in a title only relates_to, never fixes.
			expect(sorted(graph(sql))).toEqual(sorted([
				{ src: `git:${p.ns}@${s1}`, rel: "part_of", dst: `github:${p.ns}`, basis: "identifier" },
				{ src: `git:${p.ns}@${s1}`, rel: "relates_to", dst: "jira:WU-12", basis: "identifier" },
				{ src: `git:${p.ns}@${s2}`, rel: "part_of", dst: `github:${p.ns}`, basis: "identifier" },
				{ src: `git:${p.ns}@${s2}`, rel: "relates_to", dst: "jira:WU-12", basis: "identifier" },
				{ src: "person:github:a-lee", rel: "authored", dst: `git:${p.ns}@${s1}`, basis: "identifier" },
				{ src: "wu journal", rel: "relates_to", dst: `git:${p.ns}@${s1}`, basis: "identifier" },
			]));
			expect(sql.exec("SELECT 1 FROM evidence WHERE kind = 'mention' AND ref = ?", `git:${p.ns}@${s1}`).toArray()).toEqual([]);
			// No personal field or secret anywhere it could be stored or logged; activity text is content-free.
			const all = JSON.stringify([sql.exec("SELECT * FROM nodes").toArray(), sql.exec("SELECT * FROM texts").toArray(), sql.exec("SELECT * FROM revisions").toArray(), sql.exec("SELECT * FROM activity").toArray(), sql.exec("SELECT * FROM requests").toArray()]);
			expect(all).not.toMatch(/example\.com|hunter2/);
			expect(sql.exec("SELECT summary FROM activity WHERE op = 'upload' ORDER BY id").toArray().map((r) => r.summary)).toEqual(["uploaded a commit (new: 3 nodes, 2 edges)", "uploaded a commit (new: 1 nodes, 1 edges)"]);
			expect(sql.exec("SELECT head, uploaded_at FROM markers").toArray()).toEqual([{ head: s2, uploaded_at: asOf }]);
			return { nodes: sql.exec("SELECT count(*) AS n FROM nodes").one().n, edges: sql.exec("SELECT count(*) AS n FROM edges").one().n };
		});
		const commitId = uuid5(`${OWNER}:${p.name}:commit:git:${p.ns}@${s1}`);
		expect(await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", commitId).toArray())).toEqual([{ profile: p.name }]);

		const board = await call<{ items: { key: string; reasons: { term: string }[] }[] }>(p.c, "work_board", { profile: p.name });
		expect(board.items.find((i) => i.key === "jira:WU-12")!.reasons.map((r) => r.term)).toContain("recent_activity");

		// The same items replay; a changed item under the same identity is refused and holds the marker back; an older marker is stale.
		const again = await post(p.token, body);
		expect(again.data.commits!.map((c) => c.status)).toEqual(["replayed", "replayed"]);
		expect(again.data.marker).toEqual({ status: "replayed" });
		const changed = await post(p.token, { repo: { remote: p.remote }, commits: [{ ...c1, title: "WU-12 something else" }], marker: { head: s1, as_of: new Date().toISOString() } });
		expect(changed.data.commits).toEqual([{ key: `git:${p.ns}@${s1}`, status: "refused", reason: "idempotency_mismatch" }]);
		expect(changed.data.marker).toEqual({ status: "refused", reason: "commits_not_held" });
		expect((await post(p.token, { repo: { remote: p.remote }, marker: { head: s1, as_of: ago(30) } })).data.marker).toEqual({ status: "stale" });
		await p.inProfile((s) => {
			const sql = s.sql;
			expect({ nodes: sql.exec("SELECT count(*) AS n FROM nodes").one().n, edges: sql.exec("SELECT count(*) AS n FROM edges").one().n }).toEqual(before);
			expect(sql.exec("SELECT name FROM nodes WHERE key = ?", `git:${p.ns}@${s1}`).one().name).toBe(c1.title);
			expect(sql.exec("SELECT head, uploaded_at FROM markers").toArray()).toEqual([{ head: s2, uploaded_at: asOf }]);
		});
		expect(uploadTerms(p.ns, [c1])).toEqual(expect.arrayContaining([p.ns, "a-lee", "github:a-lee"]));
	});

	it("refuses read-only and wrong-profile tokens, me, other hosts and anything outside the strict schema", async () => {
		const p = await isolated(), q = await isolated();
		const commit = { sha: hex("c"), at: ago(5), title: "WU-1 change" };
		const { token: reader } = await deviceToken(`ro-${p.name}`, ["read", "write"], [p.name]);
		expect((await post(reader, { repo: { remote: p.remote }, commits: [commit] })).status).toBe(403);
		expect((await post(p.token, { profile: q.name, repo: { remote: q.remote }, commits: [commit] })).status).toBe(403);
		expect((await post(p.token, { repo: { remote: q.remote }, commits: [commit] })).status).toBe(403);
		const { token: withMe } = await deviceToken(`me-${p.name}`, ["ingest"], [p.name, "me"]);
		expect((await post(withMe, { profile: "me", repo: { remote: p.remote }, commits: [commit] })).status).toBe(403);
		const other = await post(p.token, { profile: p.name, repo: { remote: "git@gitlab.com:wu/web.git" }, commits: [commit] });
		expect([other.status, other.data.error?.details?.reason]).toEqual([400, "unsupported_remote"]);
		for (const bad of [
			{ commits: [{ ...commit, diff: "+secret" }] }, { commits: [{ ...commit, author: "bob@example.com" }] }, { commits: [{ ...commit, sha: commit.sha.slice(0, 7) }] },
			{ commits: [{ ...commit, title: "x".repeat(281) }] }, { commits: [{ ...commit, at: "yesterday" }] }, { commits: [], digests: [{ range_id: "x", capture_status: "heuristic", part_id: "-", sha256: "0".repeat(64), body: "{}" }] },
			{ commits: Array.from({ length: 51 }, () => commit) }, { marker: { head: commit.sha, as_of: ago(1), extra: 1 } },
		]) expect((await post(p.token, { repo: { remote: p.remote }, ...bad })).status).toBe(400);
		// A capture body keeps the capture schema: without a session it is refused as before.
		const capture = await post(p.token, { repo: { remote: p.remote }, digests: [] });
		expect([capture.status, capture.data.error?.message.startsWith("session:")]).toEqual([400, true]);
		await p.inProfile((s) => expect(s.sql.exec("SELECT count(*) AS n FROM nodes").one().n).toBe(0));
	});

	it("keeps the marker and leaves nothing behind when an item fails, retries cleanly, and refuses wiped ids, the 70% cap and a closed generation", async () => {
		const p = await isolated();
		const c1 = { sha: hex("d"), at: ago(30), title: "first", author: "a-lee" }, c3 = { sha: hex("e"), at: ago(20), title: "second", author: "a-lee" };
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [c1] })).data.commits![0]!.status).toBe("stored");
		// The author is being transferred out: the item is refused, nothing of it stays, and the marker does not move.
		await p.inProfile((s) => s.sql.exec("UPDATE nodes SET status = 'moving' WHERE key = 'person:github:a-lee'"));
		const body = { repo: { remote: p.remote }, commits: [c3], marker: { head: c3.sha, as_of: ago(1) } };
		const moving = await post(p.token, body);
		expect([moving.data.commits![0], moving.data.marker]).toEqual([{ key: `git:${p.ns}@${c3.sha}`, status: "refused", reason: "moving" }, { status: "refused", reason: "commits_not_held" }]);
		await p.inProfile((s) => {
			const sql = s.sql;
			expect([sql.exec("SELECT count(*) AS n FROM nodes WHERE key = ?", `git:${p.ns}@${c3.sha}`).one().n, sql.exec("SELECT count(*) AS n FROM requests WHERE request_id LIKE ?", `%${c3.sha}`).one().n, sql.exec("SELECT count(*) AS n FROM markers").one().n]).toEqual([0, 0, 0]);
			sql.exec("UPDATE nodes SET status = 'active' WHERE key = 'person:github:a-lee'");
		});
		const retry = await post(p.token, body);
		expect([retry.data.commits![0]!.status, retry.data.marker!.status]).toEqual(["stored", "stored"]);

		// A commit id a profile wipe purged is never created again.
		const c4 = { sha: hex("f"), at: ago(10), title: "wiped" };
		await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, 'test')", `wiped:${uuid5(`${OWNER}:${p.name}:commit:git:${p.ns}@${c4.sha}`)}`));
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [c4] })).data.commits![0]).toMatchObject({ status: "refused", reason: "profile_wiped" });

		// At 70% of the object limit the shared writer refuses index uploads.
		const c5 = { sha: hex("g"), at: ago(5), title: "late" };
		await p.inProfile((s) => {
			const at70 = new Proxy(s.sql, { get(t, k) { const v = k === "databaseSize" ? 0.7 * OBJECT_LIMIT : Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; } });
			const warm = { sql: at70, transactionSync: s.transactionSync.bind(s) } as DurableObjectStorage;
			expect(() => runWrite(warm, p.who, { op: "upload", args: commitArgs(p.ns, c5) }, { actor: "index", platform: "test", routedBy: "test", payloadHash: "h", userId: OWNER }))
				.toThrow(expect.objectContaining({ failure: expect.objectContaining({ code: "size_budget" }) }));
		});
		await p.inProfile((s) => s.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'test')"));
		const closed = await post(p.token, { repo: { remote: p.remote }, commits: [c5], marker: { head: c5.sha, as_of: new Date().toISOString() } });
		expect([closed.data.commits![0]!.reason, closed.data.marker]).toEqual(["profile_wiped", { status: "refused", reason: "commits_not_held" }]);
		await p.inProfile((s) => expect(s.sql.exec("SELECT head FROM markers").one().head).toBe(c3.sha));
	});

	it("undoes an upload like any write, and a repeat of the undone commit replays instead of coming back", async () => {
		const p = await isolated();
		const c = { sha: hex("h"), at: ago(5), title: "only commit", author: "b-kim" };
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [c] })).data.commits![0]!.status).toBe("stored");
		await p.inProfile((s) => {
			const id = s.sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'upload'").one().id;
			expect(undo(s, p.who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone");
			expect(s.sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'upload'").one().n).toBe(0);
			expect(s.sql.exec("SELECT count(*) AS n FROM edges").one().n).toBe(0);
		});
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [c] })).data.commits![0]!.status).toBe("replayed");
		await p.inProfile((s) => expect(s.sql.exec("SELECT count(*) AS n FROM nodes WHERE origin = 'upload'").one().n).toBe(0));
	});

	it("undo of an upload puts back the full-SHA mention it consumed from a partly folded compacted journal, and keeps the short one", async () => {
		const p = await isolated(), sha = hex("folded");
		const j = await call<{ memory_id: string }>(p.c, "save_memory", { profile: p.name, name: "folded journal", type: "project", kind: "journal", description: "notes", content: `${p.ns}@${sha}` });
		const mentions = (sql: SqlStorage) => sql.exec("SELECT owner, kind, ref, note FROM evidence WHERE owner = ? AND kind = 'mention' ORDER BY ref", `n:${j.memory_id}`).toArray();
		const before = await p.inProfile((s) => {
			const ctx = { actor: "owner" as const, platform: "test", routedBy: "explicit", userId: OWNER };
			for (let i = 0; i < 120; i++) runWrite(s, p.who, { op: "append", args: { memory_id: j.memory_id, content: `entry ${i}`, request_id: `fold-append-${i}` } }, { ...ctx, payloadHash: `fold-append-${i}` });
			runWrite(s, p.who, { op: "save", args: { memory_id: j.memory_id, expected_revision: 121, request_id: "fold-compact", compact: { through_seq: 120, summary: "folded summary" } } }, { ...ctx, payloadHash: "fold-compact" });
			// One bounded fold step leaves 20 compacted entries still to fold.
			expect(foldStep(s).more).toBe(true);
			return { content: readContent(s.sql, j.memory_id), mentions: mentions(s.sql) };
		});
		// Extraction keeps the full SHA and its short form apart; only the full one can resolve.
		expect(before.mentions.map((m) => m.ref)).toEqual([`git:${p.ns}@${sha}`, `git:${p.ns}@${sha.slice(0, 7)}`].sort());
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [{ sha, at: ago(5), title: "the mentioned commit" }] })).data.commits![0]!.status).toBe("stored");
		await p.inProfile((s) => {
			expect(mentions(s.sql).map((m) => m.ref)).toEqual([`git:${p.ns}@${sha.slice(0, 7)}`]);
			expect(s.sql.exec("SELECT count(*) AS n FROM edges WHERE src = ? AND rel = 'relates_to'", j.memory_id).one().n).toBe(1);
			const id = s.sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'upload'").one().id;
			expect(undo(s, p.who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone");
			expect(s.sql.exec("SELECT count(*) AS n FROM edges WHERE src = ? AND rel = 'relates_to'", j.memory_id).one().n).toBe(0);
			expect(readContent(s.sql, j.memory_id)).toBe(before.content);
			expect(mentions(s.sql)).toEqual(before.mentions);
		});
	});
	it("normalizes repo and author identity, keeps repos separate, and repairs node registration on replay", async () => {
		const p = await isolated(), sha = hex("normalized"), at = ago(2);
		const key = `git:${p.org}/Web@${sha}`;
		const made = await call<{ nodes: { id: string }[] }>(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "commit", key, name: "Kept title" }] });
		const id = made.nodes[0]!.id;
		await call(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "component", key: "session:CaseSensitive", name: "Opaque identity" }] });
		const mentioned = await call<{ memory_id: string }>(p.c, "save_memory", { profile: p.name, name: "mixed-case references", type: "project", description: "fixture", content: `${p.ns}@${sha} session:casesensitive` });
		await p.inProfile((st) => expect(st.sql.exec("SELECT dst FROM edges WHERE src = ? AND rel = 'relates_to'", mentioned.memory_id).toArray()).toEqual([{ dst: id }]));
		const body = { profile: p.name, repo: { remote: p.remote }, commits: [{ sha, at, title: "a title", author: "A-Lee" }], marker: { head: sha, as_of: ago(1) } };
		const first = await post(p.token, body);
		expect([first.data.commits![0]!.status, first.data.marker]).toEqual(["stored", { status: "stored" }]);
		await p.inProfile((st) => expect(st.sql.exec("SELECT key, name FROM nodes WHERE id = ?", id).one()).toEqual({ key, name: "Kept title" }));
		await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("DELETE FROM node_index WHERE node_id = ?", id));
		const repeat = await post(p.token, { ...body, repo: { remote: `https://github.com/${p.ns}.git` }, commits: [{ ...body.commits[0]!, author: "a-lee", sha: sha.toUpperCase() }] });
		expect(repeat.data.commits![0]!.status).toBe("replayed");
		expect(repeat.data.marker).toEqual({ status: "replayed" });
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).one().profile)).toBe(p.name);
		const other = await post(p.token, { ...body, repo: { remote: `https://github.com/${p.org}/other.git` } });
		expect(other.data.commits![0]).toMatchObject({ status: "stored", key: `git:${p.org.toLowerCase()}/other@${sha}` });
		await p.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'person'").one().n).toBe(1));
	});

	it("rolls back actual amplified SQLite writes and their tentative binding, then retries after the cause is removed", async () => {
		const p = await isolated(), sha = hex("budget"), c = { sha, at: ago(3), title: "bounded" };
		await p.inProfile((st) => {
			st.sql.exec("CREATE TABLE amplified (n INTEGER)");
			st.sql.exec("CREATE TRIGGER amplify_upload AFTER INSERT ON nodes WHEN NEW.origin = 'upload' BEGIN INSERT INTO amplified SELECT value FROM json_each('" + JSON.stringify(Array.from({ length: 1001 }, (_, i) => i)) + "'); END");
		});
		const body = { repo: { remote: p.remote }, commits: [c], marker: { head: sha, as_of: ago(1) } };
		const refused = await post(p.token, body);
		expect(refused.data.commits![0]).toMatchObject({ status: "refused", reason: "size_budget" });
		expect(refused.data.marker!.status).toBe("refused");
		await p.inProfile((st) => {
			for (const table of ["nodes", "requests", "amplified", "markers"]) expect(st.sql.exec(`SELECT count(*) AS n FROM ${table}`).one().n).toBe(0);
			st.sql.exec("DROP TRIGGER amplify_upload");
		});
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT 1 FROM request_index WHERE request_id = ?", `upload:${p.name}:git:${p.ns}@${sha}`).toArray())).toEqual([]);
		expect((await post(p.token, body)).data.marker!.status).toBe("stored");
		// A wipe between refusal and tentative-binding cleanup must keep its permanent request fence.
		await runInDurableObject(account(), async (instance, st) => {
			const id = `upload:${p.name}:git:${p.ns}@${sha}`;
			const hash = st.storage.sql.exec<{ payload_hash: string }>("SELECT payload_hash FROM request_index WHERE request_id = ?", id).one().payload_hash;
			st.storage.sql.exec("UPDATE request_index SET op = 'wiped' WHERE request_id = ?", id);
			await instance.releaseRequest(id, hash);
			expect(st.storage.sql.exec("SELECT op FROM request_index WHERE request_id = ?", id).one().op).toBe("wiped");
		});
	});

	it("refuses a wrong-kind key and keeps unresolved or shortened identifiers as evidence", async () => {
		const p = await isolated(), sha = hex("key");
		await call(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "ticket", key: `github:${p.ns}`, name: "wrong kind" }] });
		const c = { sha, at: ago(4), title: "fixes MISSING-23" };
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [c] })).data.commits![0]).toMatchObject({ status: "refused", reason: "validation" });
		await p.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM nodes WHERE kind = 'commit'").one().n).toBe(0));
		const remote = `https://github.com/${p.org}/valid.git`, ns = `${p.org.toLowerCase()}/valid`;
		await call(p.c, "save_memory", { profile: p.name, name: "short ref", type: "project", description: "shortened reference", content: `${ns}@${sha.slice(0, 7)}` });
		expect((await post(p.token, { profile: p.name, repo: { remote }, commits: [c] })).data.commits![0]!.status).toBe("stored");
		await p.inProfile((st) => {
			expect(st.sql.exec("SELECT ref FROM evidence WHERE kind = 'mention' ORDER BY ref").toArray()).toEqual([{ ref: `git:${ns}@${sha.slice(0, 7)}` }, { ref: "jira:MISSING-23" }]);
			expect(st.sql.exec("SELECT 1 FROM edges WHERE rel = 'fixes'").toArray()).toEqual([]);
		});
	});

	it("registers work terms before publication and gives an ingest token no generic MCP write grant", async () => {
		const c = await contextFor(), label = `wu-${crypto.randomUUID().slice(0, 8)}`;
		const { token } = await deviceToken(label, ["ingest"], ["work"]);
		const result = await post(token, { profile: "work", repo: { remote: `https://github.com/${label}/demo.git` }, commits: [{ sha: hex("work"), at: ago(1), title: "work", author: label }] });
		expect(result.data.commits![0]!.status).toBe("stored");
		const me = c.account.profiles.find((p) => p.profile === "me")!;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${me.userId}:${me.profile}:${me.generation}`));
		expect(await runInDurableObject(stub, (_i, st) => st.storage.sql.exec("SELECT term FROM guard_terms WHERE term = ?", label).toArray())).toEqual([{ term: label }]);
		const rpc = await exports.default.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_memory", arguments: { profile: "work", name: "must not save", type: "project", description: "forbidden" } } }) }));
		expect(await rpc.text()).toContain("Method not found");
	});

	it("rechecks a close after the binding await and refuses a recovering account without writing", async () => {
		const p = await isolated(), sha = hex("lateclose"), args = commitArgs(p.ns, { sha, at: ago(2), title: "closed before write" });
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${p.name}:${p.who.generation}`));
		const result = await runInDurableObject(stub, async (instance, st) => {
			const self = instance as unknown as { access: (...args: any[]) => Promise<void>; upload: (who: any, batch: any, ctx: any) => Promise<any> };
			const original = self.access; let calls = 0;
			self.access = async (...ids) => { await original.apply(instance, ids); if (++calls === 2) st.storage.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'late-close')"); };
			try { return await self.upload(p.who, { repo: p.ns, commits: [args], marker: { head: sha, as_of: ago(1) } }, { platform: "test", routedBy: "test", userId: OWNER }); }
			finally { self.access = original; }
		});
		expect(result.value.commits[0]).toMatchObject({ status: "refused", reason: "profile_wiped" });
		await p.inProfile((st) => {
			expect(st.sql.exec("SELECT count(*) AS n FROM nodes").one().n).toBe(0);
			expect(st.sql.exec("SELECT count(*) AS n FROM markers").one().n).toBe(0);
		});
		const q = await isolated();
		await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'held')"));
		try { expect((await post(q.token, { repo: { remote: q.remote }, commits: [{ sha, at: ago(2), title: "recovery" }] })).data.commits![0]).toMatchObject({ status: "refused", reason: "busy" }); }
		finally { await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'")); }
		await q.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM nodes").one().n).toBe(0));
	});

	it("completes a failed registration from the head's durable upload result before any marker acknowledgement", async () => {
		const p = await isolated(), c = { sha: hex("register"), at: ago(5), title: "registration interrupted", author: "c-ng" };
		const ids = [`project:github:${p.ns}`, `commit:git:${p.ns}@${c.sha}`, "person:person:github:c-ng"].map((k) => uuid5(`${OWNER}:${p.name}:${k}`));
		const registered = () => runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT node_id, profile FROM node_index WHERE node_id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).toArray());
		// Only this profile's registrations fail, so files sharing the owner's account are unaffected.
		const interrupt = (on: boolean) => runInDurableObject(account(), (_i, st) => st.storage.sql.exec(on
			? `CREATE TRIGGER interrupt_${p.name} BEFORE INSERT ON node_index WHEN NEW.profile = '${p.name}' BEGIN SELECT RAISE(ABORT, 'synthetic registration interruption'); END`
			: `DROP TRIGGER interrupt_${p.name}`));
		const marker = { repo: { remote: p.remote }, marker: { head: c.sha, as_of: ago(1) } };
		await interrupt(true);
		try {
			// The commit is durable in the profile but unregistered; a marker-only retry that still cannot register acknowledges nothing.
			await expect(post(p.token, { ...marker, commits: [c] })).rejects.toThrow("synthetic registration interruption");
			await expect(post(p.token, marker)).rejects.toThrow("synthetic registration interruption");
		} finally { await interrupt(false); }
		expect(await registered()).toEqual([]);
		await p.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM markers").one().n).toBe(0));
		// A move that won meanwhile keeps its owner; the head's other nodes register for this generation before the marker is stored.
		await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("INSERT INTO node_index (node_id, profile, seq) VALUES (?, 'personal', 1)", ids[2]!));
		expect((await post(p.token, marker)).data.marker).toEqual({ status: "stored" });
		expect(sorted(await registered())).toEqual(sorted([{ node_id: ids[0], profile: p.name }, { node_id: ids[1], profile: p.name }, { node_id: ids[2], profile: "personal" }]));
		const again = await post(p.token, { ...marker, commits: [c] });
		expect([again.data.commits![0]!.status, again.data.marker]).toEqual(["replayed", { status: "replayed" }]);
		await p.inProfile((st) => st.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'test')"));
		expect((await post(p.token, { ...marker, marker: { head: c.sha, as_of: new Date().toISOString() } })).data.marker).toEqual({ status: "refused", reason: "profile_wiped" });
	});

});
