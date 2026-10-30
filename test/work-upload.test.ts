// AM-12 commit uploads through the real /v1/ingest with a job-scoped token, into the actual profile object, its graph and the board.
// Each case uses its own profile and routing rule on the owner's account, so no other test file shares or closes it.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256, uuid5 } from "../src/domain/ids";
import { housekeep, OBJECT_LIMIT } from "../src/profile/housekeeping";
import { undo } from "../src/profile/undo";
import { foldStep } from "../src/profile/compact";
import { readContent, runWrite } from "../src/profile/write";
import { commitArgs, ticketArgs, uploadTerms } from "../src/profile/work-upload";
import { call, contextFor, deviceToken, outcome, OWNER } from "./helpers";
// @ts-expect-error -- the untyped Node client, run here as the real local caller of the job ingest route.
import { uploadPRs } from "../local/pr-upload.mjs";
// @ts-expect-error -- the untyped Node client, run here as the real local caller of the job ingest route.
import { FIELDS, uploadTickets } from "../local/jira-upload.mjs";

const origin = new URL(env.RESOURCE_URL).origin;
const account = () => env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER));
const hex = (s: string) => sha256(s + crypto.randomUUID()).slice(0, 40);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function post(token: string, payload: unknown) {
	const res = await exports.default.fetch(new Request(`${origin}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }));
	type Item = { key: string; status: string; reason?: string; updated_at?: string };
	return { status: res.status, data: await res.json() as { profile?: string; routed_by?: string; results?: unknown[]; commits?: Item[]; prs?: Item[]; tickets?: Item[]; marker?: { status: string; reason?: string }; error?: { code: string; message: string; details?: { reason?: string } } } };
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

/** GitHub's updatedAt form: whole seconds, UTC. */
const gh = (min: number) => ago(min).replace(/\.\d{3}Z$/, "Z");

describe("PR uploads", () => {
	it("carries a stub gh page through the local client and the job ingest route into the PR graph and the board", async () => {
		const p = await isolated(), held = hex("held"), missing = hex("missing"), updatedAt = gh(30);
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [{ sha: held, at: ago(90), title: "held commit", author: "a-lee" }] })).data.commits![0]!.status).toBe("stored");
		await call(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "bug", key: `github:${p.ns}#7`, name: "Crash on login", attrs: { state: "open" } }] });
		const journal = await call<{ memory_id: string }>(p.c, "save_memory", { profile: p.name, name: "pr journal", type: "project", kind: "journal", description: "notes", content: `Reviewing ${p.ns}#12 today.` });
		const rows = [{ number: 12, title: "WU-3 fix login crash token=hunter2secret bob@example.com", state: "OPEN", author: { login: "A-Lee", is_bot: false, name: "A Lee" }, updatedAt,
			headRefName: "fix/WU-3-login", commits: [{ oid: held, messageHeadline: "held commit" }, { oid: missing.toUpperCase() }],
			reviews: [{ author: { login: "Bob" }, state: "APPROVED", body: "secret review text" }, { author: { login: "carol" }, state: "PENDING" }, { author: { login: "bob" }, state: "COMMENTED" }],
			closingIssuesReferences: [{ number: 7, url: `https://github.com/${p.org}/Web/issues/7` }, { number: 9, url: `https://github.com/${p.org}/Web/issues/9` }],
			reviewRequests: [{ __typename: "User", login: "Owner-Login" }, { __typename: "Team", name: "Core", slug: "core" }] }];
		const calls: string[][] = [], sent: unknown[] = [];
		const run = async (args: string[]) => { calls.push(args); return JSON.stringify({data:{search:{nodes:rows.map(r=>({...r,repository:{nameWithOwner:p.ns},author:{...r.author,__typename:"User"},
    reviews:{nodes:r.reviews,pageInfo:{hasNextPage:false}},commits:{nodes:r.commits.map(commit=>({commit})),pageInfo:{hasNextPage:false}},closingIssuesReferences:{nodes:r.closingIssuesReferences,pageInfo:{hasNextPage:false}},reviewRequests:{nodes:r.reviewRequests.map(requestedReviewer=>({requestedReviewer})),pageInfo:{hasNextPage:false}}
   }))}}}); };
		const send = async (body: unknown) => {
			sent.push(body);
			const r = await post(p.token, body);
			if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
			return r.data;
		};
		const stateFile = `/tmp/am-pr-${p.name}/prs.json`;
		const out = await uploadPRs({ repo: p.ns, profile: p.name, since: ago(24 * 60), stateFile, gh: { account: "wrick17", run }, ownerLogin: "owner-login", send });
		expect(out).toEqual({ status: "acknowledged", prs: 1, incomplete: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0,4)).toEqual(["api","graphql","--hostname","github.com"]);
  expect(calls[0]!.find(a=>a.startsWith("query="))).not.toMatch(/\b(body|messageBody|email)\b/);
		expect(JSON.stringify(sent)).not.toMatch(/hunter2|example\.com|secret review|A Lee|Core/);
		const key = `github:${p.ns}#12`, updated = new Date(updatedAt).toISOString();
		await p.inProfile((st) => {
			const sql = st.sql, pr = sql.exec<{ id: string; kind: string; name: string; origin: string; attrs: string }>("SELECT id, kind, name, origin, attrs FROM nodes WHERE key = ?", key).one();
			expect(pr).toMatchObject({ kind: "pr", name: "WU-3 fix login crash token=[REDACTED] [REDACTED]", origin: "upload" });
			expect(JSON.parse(pr.attrs)).toEqual({ repo: p.ns, number: 12, state: "open", updated_at: updated, as_of: (sent[0] as { as_of: string }).as_of, head: "fix/WU-3-login", review_requested_from_owner: true });
			// Structured fields only: authored, reviewed (a pending review is no review), part_of from the held full SHA, fixes from the
			// closing reference to a held bug. The journal's earlier mention of the PR becomes its link.
			expect(sorted(graph(sql).filter((e) => e.src === key || e.dst === key))).toEqual(sorted([
				{ src: "person:github:a-lee", rel: "authored", dst: key, basis: "identifier" },
				{ src: "person:github:bob", rel: "reviewed", dst: key, basis: "identifier" },
				{ src: `git:${p.ns}@${held}`, rel: "part_of", dst: key, basis: "identifier" },
				{ src: key, rel: "fixes", dst: `github:${p.ns}#7`, basis: "identifier" },
				{ src: key, rel: "part_of", dst: `github:${p.ns}`, basis: "identifier" },
				{ src: "pr journal", rel: "relates_to", dst: key, basis: "identifier" },
			]));
			// What is not held yet waits as a mention, never a stronger edge, and nothing is created for it.
			expect(sql.exec("SELECT ref FROM evidence WHERE owner = ? AND kind = 'mention' ORDER BY ref", `n:${pr.id}`).toArray().map((r) => r.ref)).toEqual([`git:${p.ns}@${missing}`, `github:${p.ns}#9`, "jira:WU-3"]);
			expect(sql.exec("SELECT count(*) AS n FROM evidence WHERE owner = ? AND kind = 'mention'", `n:${journal.memory_id}`).one().n).toBe(0);
			expect(sql.exec("SELECT key FROM nodes WHERE kind = 'person' ORDER BY key").toArray().map((r) => r.key)).toEqual(["person:github:a-lee", "person:github:bob"]);
			expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE key IN (?, ?)", `github:${p.ns}#9`, `git:${p.ns}@${missing}`).one().n).toBe(0);
			const all = JSON.stringify([sql.exec("SELECT * FROM nodes").toArray(), sql.exec("SELECT * FROM texts").toArray(), sql.exec("SELECT * FROM revisions").toArray(), sql.exec("SELECT * FROM activity").toArray(), sql.exec("SELECT * FROM requests").toArray()]);
			expect(all).not.toMatch(/hunter2|example\.com|secret review/);
		});
		const prId = uuid5(`${OWNER}:${p.name}:pr:${key}`);
		expect(await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", prId).toArray())).toEqual([{ profile: p.name }]);
		const board = await call<{ items: { key: string; reasons: { term: string; text: string }[] }[] }>(p.c, "work_board", { profile: p.name });
		const item = board.items.find((i) => i.key === key)!;
		expect(item.reasons.map((r) => r.term)).toEqual(expect.arrayContaining(["owner_action", "recent_activity"]));
		expect(item.reasons.find((r) => r.term === "owner_action")!.text).toBe("Review requested from the owner (+15).");
		// The acknowledged revision moves the PR cursor, kept apart from the commit marker; the next run skips it.
		const again = await uploadPRs({ repo: p.ns, profile: p.name, since: ago(24 * 60), stateFile, gh: { account: "wrick17", run }, ownerLogin: "owner-login", send });
		expect(again).toEqual({ status: "acknowledged", prs: 0, incomplete: [] });
		expect(sent).toHaveLength(1);
		await p.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM markers").one().n).toBe(0));
	});

	it("keeps the newer snapshot, ends what it no longer lists, keeps agent fields, replays, refuses a changed revision and undoes", async () => {
		const p = await isolated(), held = hex("agent"), key = `github:${p.ns}#21`, t1 = gh(50), t2 = gh(20);
		await post(p.token, { repo: { remote: p.remote }, commits: [{ sha: held, at: ago(90), title: "held" }] });
		await call(p.c, "record_knowledge", { profile: p.name, nodes: [{ kind: "ticket", key: `github:${p.ns}#5`, name: "Ticket five", attrs: { state: "open" } },
			{ kind: "pr", key: `github:${p.org}/Web#21`, name: "Agent's PR name", description: "agent notes", attrs: { priority: "High" } }] });
		const snap = (t: string, extra: Record<string, unknown> = {}) => ({ repo: { remote: p.remote }, as_of: ago(1), prs: [{ number: 21, title: "First title", state: "open", updated_at: t, head: "feat/x",
			author: "a-lee", reviewers: ["bob"], commits: [held], closes: [`github:${p.ns}#5`], unknown: [], review_requested_from_owner: true, ...extra }] });
		const item = async (body: unknown) => (await post(p.token, body)).data.prs![0]!;
		expect(await item(snap(t1))).toEqual({ key, status: "stored", updated_at: new Date(t1).toISOString() });
		const node = () => p.inProfile((st) => st.sql.exec<{ id: string; key: string; name: string; description: string; origin: string; attrs: string }>("SELECT id, key, name, description, origin, attrs FROM nodes WHERE key = ? COLLATE NOCASE", key).one());
		const first = await node();
		// The agent's node keeps its stored key bytes, name, description and priority; the upload owns only its PR fields.
		expect(first).toMatchObject({ key: `github:${p.org}/Web#21`, name: "Agent's PR name", description: "agent notes", origin: "agent" });
		expect(JSON.parse(first.attrs)).toMatchObject({ priority: "High", state: "open", review_requested_from_owner: true, updated_at: new Date(t1).toISOString() });
		const current = () => p.inProfile((st) => graph(st.sql).filter((e) => e.dst === first.key || e.src === first.key).map((e) => `${e.src} ${e.rel} ${e.dst}`).sort());
		const before = await current();
		expect(before).toEqual(expect.arrayContaining([`${first.key} fixes github:${p.ns}#5`, `person:github:bob reviewed ${first.key}`, `git:${p.ns}@${held} part_of ${first.key}`]));
		// A newer snapshot wins: closed, the review and closing reference gone, so those edges end. Its commit list and review
		// requests are unknown, so the held commit's part_of stays and no review request is asserted.
		const newer = snap(t2, { title: "Second title", state: "closed", reviewers: [], commits: [], closes: [], unknown: ["commits", "reviewRequests"], review_requested_from_owner: undefined });
		expect((await item(newer)).status).toBe("stored");
		const second = await node();
		expect(JSON.parse(second.attrs)).toEqual({ priority: "High", repo: p.ns, number: 21, state: "closed", updated_at: new Date(t2).toISOString(), as_of: new Date(newer.as_of).toISOString(), head: "feat/x", unknown: ["commits", "reviewRequests"] });
		const after = await current();
		expect(after).toContain(`git:${p.ns}@${held} part_of ${first.key}`);
		expect(after).not.toContain(`${first.key} fixes github:${p.ns}#5`);
		expect(after).not.toContain(`person:github:bob reviewed ${first.key}`);
		await p.inProfile((st) => expect(st.sql.exec("SELECT rel, valid_to FROM edges WHERE ended_at IS NOT NULL ORDER BY rel").toArray()).toEqual([{ rel: "fixes", valid_to: new Date(t2).toISOString() }, { rel: "reviewed", valid_to: new Date(t2).toISOString() }]));
		// The first revision replays; an older revision never seen is stale and changes nothing; the same revision changed is refused.
		expect((await item(snap(t1))).status).toBe("replayed");
		const staleTime = gh(60);
		expect(await item(snap(staleTime))).toEqual({ key, status: "stale", updated_at: new Date(staleTime).toISOString() });
		expect(await item({ ...newer, prs: [{ ...newer.prs[0], title: "Third title" }] })).toMatchObject({ status: "refused", reason: "idempotency_mismatch" });
		expect((await node()).attrs).toBe(second.attrs);
		// Undo of the newer snapshot puts the first one's fields and edges back.
		await p.inProfile((st) => {
			const id = st.sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'upload' ORDER BY id DESC LIMIT 1").one().id;
			expect(undo(st, p.who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone");
		});
		expect((await node()).attrs).toBe(first.attrs);
		expect(await current()).toEqual(before);
	});

	it("flags a protected PR, refuses a moving one and a closed generation, and acknowledges nothing before registration", async () => {
		const p = await isolated(), key = `github:${p.ns}#31`;
		const body = (t: string) => ({ repo: { remote: p.remote }, as_of: ago(1), prs: [{ number: 31, title: "Protected", state: "open", updated_at: t, head: "x", reviewers: ["d-ray"], commits: [], closes: [], unknown: ["author"] }] });
		const item = async (b: unknown) => (await post(p.token, b)).data.prs![0]!;
		const interrupt = (on: boolean) => runInDurableObject(account(), (_i, st) => st.storage.sql.exec(on
			? `CREATE TRIGGER interrupt_${p.name} BEFORE INSERT ON node_index WHEN NEW.profile = '${p.name}' BEGIN SELECT RAISE(ABORT, 'synthetic registration interruption'); END`
			: `DROP TRIGGER interrupt_${p.name}`));
		const t1 = gh(40);
		await interrupt(true);
		try { await expect(post(p.token, body(t1))).rejects.toThrow("synthetic registration interruption"); }
		finally { await interrupt(false); }
		const prId = uuid5(`${OWNER}:${p.name}:pr:${key}`);
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT 1 FROM node_index WHERE node_id = ?", prId).toArray())).toEqual([]);
		// The committed snapshot replays and registers before it is acknowledged.
		expect((await item(body(t1))).status).toBe("replayed");
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", prId).one().profile)).toBe(p.name);
		const attrs = await p.inProfile((st) => { st.sql.exec("UPDATE nodes SET pinned = 1 WHERE key = ?", key); return st.sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE key = ?", key).one().attrs; });
		expect((await item(body(gh(30)))).status).toBe("flagged");
		await p.inProfile((st) => expect(st.sql.exec("SELECT attrs, flagged FROM nodes WHERE key = ?", key).one()).toEqual({ attrs, flagged: "upload: pinned" }));
		await p.inProfile((st) => st.sql.exec("UPDATE nodes SET pinned = 0, status = 'moving' WHERE key = ?", key));
		expect(await item(body(gh(20)))).toMatchObject({ status: "refused", reason: "moving" });
		await p.inProfile((st) => { st.sql.exec("UPDATE nodes SET status = 'active' WHERE key = ?", key); st.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'test')"); });
		expect(await item(body(gh(10)))).toMatchObject({ status: "refused", reason: "profile_wiped" });
		await p.inProfile((st) => expect(st.sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE key = ?", key).one().attrs).toBe(attrs));
	});

	it("refuses PR bodies outside the strict schema", async () => {
		const p = await isolated();
		const pr = { number: 1, title: "t", state: "open", updated_at: gh(5), head: "h", reviewers: [], commits: [], closes: [], unknown: [] };
		for (const bad of [{ prs: [pr] }, { as_of: ago(1), prs: [{ ...pr, body: "free text" }] }, { as_of: ago(1), prs: [{ ...pr, author: "bob@example.com" }] },
			{ as_of: ago(1), prs: [{ ...pr, state: "merged" }] }, { as_of: ago(1), prs: [{ ...pr, closes: ["jira:WU-1"] }] }, { as_of: ago(1), prs: [{ ...pr, commits: ["abc1234"] }] },
			{ as_of: ago(1), prs: Array.from({ length: 26 }, (_, i) => ({ ...pr, number: i + 1 })) }, { as_of: ago(1), prs: [{ ...pr, unknown: ["owner"] }] }]) {
			expect((await post(p.token, { repo: { remote: p.remote }, ...bad })).status).toBe(400);
		}
		await p.inProfile((st) => expect(st.sql.exec("SELECT count(*) AS n FROM nodes").one().n).toBe(0));
	});
});

/** A Jira project key of its own per case, so cases sharing the work profile never touch each other's tickets. */
const jiraProject = () => `J${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(65 + (b % 26))).join("")}`;
/** The owner's work profile, which alone takes Jira tickets, with a job token for it. Cases here never close or wipe it. */
async function workProfile() {
	const c = await contextFor(), { token } = await deviceToken(`jira-${crypto.randomUUID().slice(0, 8)}`, ["ingest"], ["work"]);
	const ref = c.account.profiles.find((r) => r.profile === "work")!;
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
	return { c, token, inWork: <T,>(f: (s: DurableObjectStorage) => T) => runInDurableObject(stub, (_i, st) => f(st.storage)) };
}
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("Jira ticket uploads", () => {
	it("carries an injected read-only connector answer through the local client and the job ingest route into the work ticket graph and board", async () => {
		const w = await workProfile(), P = jiraProject(), owner = "712020:0b5e-owner", other = "5b10ac8d82e05b22cc7d4ef5";
		const journal = await call<{ memory_id: string }>(w.c, "save_memory", { profile: "work", name: `${P} journal`, type: "project", kind: "journal", description: "notes", content: `Picked up ${P}-1 today.` });
		const person = (accountId: string) => ({ accountId, displayName: "Private Person", emailAddress: "private@example.com", avatarUrls: { "48x48": "https://avatar.invalid/x" }, active: true });
		const blocks = { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" };
		const issues = [
			{ key: `${P}-1`, fields: { summary: "Login loops for bob@example.com token=hunter2secret", issuetype: { name: "Story" }, status: { name: "To Do", statusCategory: { key: "new" } },
				priority: { name: "High" }, duedate: day(3), assignee: person(owner), reporter: person(other), updated: "2026-10-30T09:15:00.000+0530",
				issuelinks: [{ id: "1", type: blocks, inwardIssue: { key: `${P}-2` } }], description: "secret description", comment: { comments: [{ body: "secret comment" }] } } },
			{ key: `${P}-2`, fields: { summary: "Session store crash", issuetype: { name: "Bug" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
				priority: { name: "Highest" }, duedate: null, assignee: null, reporter: person(other), updated: "2026-10-30T03:50:00.000Z",
				issuelinks: [{ id: "1", type: blocks, outwardIssue: { key: `${P}-1` } }, { id: "2", type: { name: "Relates", inward: "relates to", outward: "relates to" }, outwardIssue: { key: `${P}-9` } }] } },
		];
		const calls: unknown[] = [], sent: unknown[] = [];
		const connector = { account: "~/.claude", readOnly: true, read: async (q: unknown) => { calls.push(q); return JSON.stringify({ issues }); } };
		const send = async (body: unknown) => {
			sent.push(body);
			const r = await post(w.token, body);
			if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
			return r.data;
		};
		const run = () => uploadTickets({ keys: [`${P}-1`, `${P}-2`, `${P}-3`], stateFile: `/tmp/am-jira-${P}/tickets.json`, connector, ownerAccountId: owner, send });
		expect(await run()).toEqual({ status: "acknowledged", tickets: 2, incomplete: [], missing: [`${P}-3`], invalid: [] });
		expect(calls).toEqual([{ keys: [`${P}-1`, `${P}-2`, `${P}-3`], fields: FIELDS }]);
		expect(JSON.stringify(sent)).not.toMatch(/example\.com|hunter2|Private Person|secret description|secret comment|avatar/);
		const k1 = `jira:${P}-1`, k2 = `jira:${P}-2`, as_of = (sent[0] as { as_of: string }).as_of;
		await w.inWork((st) => {
			const sql = st.sql, node = (k: string) => sql.exec<{ id: string; kind: string; name: string; origin: string; attrs: string }>("SELECT id, kind, name, origin, attrs FROM nodes WHERE key = ?", k).one();
			const n1 = node(k1), n2 = node(k2);
			expect([n1.kind, n1.name, n1.origin, JSON.parse(n1.attrs)]).toEqual(["feature", "Login loops for [REDACTED] token=[REDACTED]", "upload",
				{ type: "Story", state: "open", status: "To Do", priority: "High", due: day(3), assignee_is_owner: true, updated_at: "2026-10-30T03:45:00.000Z", as_of }]);
			expect([n2.kind, JSON.parse(n2.attrs)]).toEqual(["bug", { type: "Bug", state: "open", status: "In Progress", priority: "Highest", assignee_is_owner: false, updated_at: "2026-10-30T03:50:00.000Z", as_of }]);
			// Structured fields only: assigned and reported from account ids, one blocked_by in the direction Jira states, from either
			// side's link. The earlier mention of the blocker became a relates_to link when it arrived; the journal's mention resolved.
			expect(sorted(graph(sql).filter((e) => [e.src, e.dst].some((x) => x.startsWith(`jira:${P}`))))).toEqual(sorted([
				{ src: `person:jira:${owner}`, rel: "assigned", dst: k1, basis: "identifier" },
				{ src: `person:jira:${other}`, rel: "reported", dst: k1, basis: "identifier" },
				{ src: `person:jira:${other}`, rel: "reported", dst: k2, basis: "identifier" },
				{ src: k1, rel: "blocked_by", dst: k2, basis: "identifier" },
				{ src: k1, rel: "relates_to", dst: k2, basis: "identifier" },
				{ src: `${P} journal`, rel: "relates_to", dst: k1, basis: "identifier" },
			]));
			expect(sql.exec("SELECT ref FROM evidence WHERE owner = ? AND kind = 'mention'", `n:${n2.id}`).toArray().map((r) => r.ref)).toEqual([`jira:${P}-9`]);
			expect(sql.exec("SELECT count(*) AS n FROM evidence WHERE owner = ? AND kind = 'mention'", `n:${journal.memory_id}`).one().n).toBe(0);
			expect(sql.exec("SELECT count(*) AS n FROM nodes WHERE key IN (?, ?)", `jira:${P}-9`, `jira:${P}-3`).one().n).toBe(0);
			expect(sql.exec("SELECT name, attrs FROM nodes WHERE key = ?", `person:jira:${owner}`).one()).toEqual({ name: owner, attrs: JSON.stringify({ jira: owner }) });
			const all = JSON.stringify([sql.exec("SELECT * FROM nodes WHERE key LIKE ? OR key LIKE 'person:jira:%'", `jira:${P}%`).toArray(), sql.exec("SELECT * FROM requests WHERE request_id LIKE ?", `%jira:${P}%`).toArray()]);
			expect(all).not.toMatch(/example\.com|hunter2|Private Person|secret/);
		});
		const board = await call<{ items: { key: string; reasons: { term: string; text: string }[] }[] }>(w.c, "work_board", { profile: "work", limit: 200 });
		const reasons = (k: string) => board.items.find((i) => i.key === k)!.reasons.map((r) => r.text);
		expect(reasons(k1)).toEqual(expect.arrayContaining(["Priority High (+30).", "Assigned to the owner (+15).", "Has 1 open blocked_by link (-20)."]));
		expect(reasons(k2)).toEqual(expect.arrayContaining(["Blocks 1 open item (+3.33)."]));
		// Ticket keys, summaries and Jira handles guard me, as record_knowledge's would.
		const me = w.c.account.profiles.find((r) => r.profile === "me")!;
		const terms = await runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${me.userId}:${me.profile}:${me.generation}`)), (_i, st) =>
			st.storage.sql.exec("SELECT term FROM guard_terms WHERE term IN (?, ?, ?)", `${P}-1`, "Session store crash", owner).toArray().map((r) => r.term));
		expect(terms.sort()).toEqual([`${P}-1`, owner, "Session store crash"].sort());
		// The acknowledged snapshots are not sent again while unchanged.
		expect(await run()).toEqual({ status: "acknowledged", tickets: 0, incomplete: [], missing: [`${P}-3`], invalid: [] });
		expect(sent).toHaveLength(1);
	});

	it("keeps the newer ticket snapshot, ends only links and assignments it knows are gone, keeps agent fields, replays, refuses a changed revision and undoes", async () => {
		const w = await workProfile(), P = jiraProject(), a1 = "5b10a0000000000000000001", key = `jira:${P}-5`;
		await call(w.c, "record_knowledge", { profile: "work", nodes: [{ kind: "ticket", key, name: "Agent's ticket name", description: "agent notes", attrs: { area: "auth", priority: "Low" } },
			{ kind: "ticket", key: `jira:${P}-6`, name: "Blocker", attrs: { state: "open" } }, { kind: "feature", key: `jira:${P}-7`, name: "Blocked feature", attrs: { state: "open" } }] });
		const snap = (t: string, extra: Record<string, unknown> = {}) => ({ profile: "work", as_of: ago(1), tickets: [{ key: `${P}-5`, kind: "bug", type: "Bug", title: "Jira title", updated_at: t,
			state: "open", status: "To Do", priority: "High", assignee: a1, assignee_is_owner: false, blocked_by: [`${P}-6`], blocks: [`${P}-7`], related: [], unknown: [], ...extra }] });
		const item = async (b: unknown) => (await post(w.token, b)).data.tickets![0]!;
		const node = () => w.inWork((st) => st.sql.exec<{ id: string; kind: string; name: string; description: string; attrs: string }>("SELECT id, kind, name, description, attrs FROM nodes WHERE key = ?", key).one());
		const current = () => w.inWork((st) => graph(st.sql).filter((e) => e.src === key || e.dst === key).map((e) => `${e.src} ${e.rel} ${e.dst}`).sort());
		const t1 = gh(50), t2 = gh(30), t3 = gh(10), iso = (t: string) => new Date(t).toISOString();
		expect(await item(snap(t1))).toEqual({ key, status: "stored", updated_at: iso(t1) });
		const first = await node();
		// The agent's ticket keeps its kind, name, description and own attributes; Jira's type is recorded and its fields win.
		expect([first.kind, first.name, first.description]).toEqual(["ticket", "Agent's ticket name", "agent notes"]);
		expect(JSON.parse(first.attrs)).toEqual({ area: "auth", type: "Bug", state: "open", status: "To Do", priority: "High", assignee_is_owner: false, updated_at: iso(t1), as_of: expect.any(String) });
		const linked = [`${key} blocked_by jira:${P}-6`, `jira:${P}-7 blocked_by ${key}`, `person:jira:${a1} assigned ${key}`].sort();
		expect(await current()).toEqual(linked);
		// Unknown assignee and links say nothing about removal: every edge stays.
		const unknownSnap = snap(t2, { assignee: undefined, assignee_is_owner: undefined, blocked_by: [], blocks: [], unknown: ["assignee", "issuelinks"] });
		expect((await item(unknownSnap)).status).toBe("stored");
		expect(await current()).toEqual(linked);
		const second = await node();
		expect(JSON.parse(second.attrs)).toMatchObject({ area: "auth", unknown: ["assignee", "issuelinks"], updated_at: iso(t2) });
		expect(JSON.parse(second.attrs).assignee_is_owner).toBeUndefined();
		// Known unassigned and known without links: those edges end as history at the snapshot's own time.
		expect((await item(snap(t3, { assignee: undefined, blocked_by: [], blocks: [] }))).status).toBe("stored");
		expect(await current()).toEqual([]);
		await w.inWork((st) => expect(st.sql.exec("SELECT rel, valid_to FROM edges WHERE (src = ?1 OR dst = ?1) AND ended_at IS NOT NULL ORDER BY rel", first.id).toArray())
			.toEqual([{ rel: "assigned", valid_to: iso(t3) }, { rel: "blocked_by", valid_to: iso(t3) }, { rel: "blocked_by", valid_to: iso(t3) }]));
		const third = await node();
		expect((await item(snap(t1))).status).toBe("replayed");
		expect(await item(snap(gh(60)))).toEqual({ key, status: "stale", updated_at: iso(gh(60)) });
		expect(await item(snap(t3, { assignee: undefined, blocked_by: [], blocks: [], title: "Changed title" }))).toMatchObject({ status: "refused", reason: "idempotency_mismatch" });
		expect((await node()).attrs).toBe(third.attrs);
		await w.inWork((st) => {
			const id = st.sql.exec<{ id: number }>("SELECT id FROM activity WHERE op = 'upload' AND targets LIKE ? ORDER BY id DESC LIMIT 1", `%${first.id}%`).one().id;
			expect(undo(st, { userId: OWNER, profile: "work", generation: w.c.account.profiles.find((r) => r.profile === "work")!.generation }, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone");
		});
		expect((await node()).attrs).toBe(second.attrs);
		expect(await current()).toEqual(linked);
	});

	it("flags a protected ticket, refuses moving, wiped and closed ones, and acknowledges nothing before registration", async () => {
		const p = await isolated(), P = jiraProject(), key = `jira:${P}-1`;
		const stub = env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${p.name}:${p.who.generation}`));
		const args = (k: string, t: string) => ticketArgs({ key: k, kind: "ticket", type: "Task", title: "Guarded", updated_at: t, state: "open", status: "To Do", reporter: "5b10a0000000000000000002",
			blocked_by: [], blocks: [], related: [], unknown: [] }, ago(1));
		// Direct to the store: the route sends tickets only to work, and these cases close their own profile.
		const upload = (k: string, t: string) => runInDurableObject(stub, async (instance) => (await (instance as unknown as { upload: (...a: unknown[]) => Promise<{ value: { tickets: { status: string; reason?: string }[] } }> })
			.upload(p.who, { repo: null, commits: [], tickets: [args(k, t)] }, { platform: "test", routedBy: "test", userId: OWNER })).value.tickets[0]!);
		const interrupt = (on: boolean) => runInDurableObject(account(), (_i, st) => st.storage.sql.exec(on
			? `CREATE TRIGGER interrupt_${p.name} BEFORE INSERT ON node_index WHEN NEW.profile = '${p.name}' BEGIN SELECT RAISE(ABORT, 'synthetic registration interruption'); END`
			: `DROP TRIGGER interrupt_${p.name}`));
		const t1 = gh(40), id = uuid5(`${OWNER}:${p.name}:ticket:${key}`);
		await interrupt(true);
		try { await expect(upload(`${P}-1`, t1)).rejects.toThrow("synthetic registration interruption"); }
		finally { await interrupt(false); }
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT 1 FROM node_index WHERE node_id = ?", id).toArray())).toEqual([]);
		expect((await upload(`${P}-1`, t1)).status).toBe("replayed");
		expect(await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("SELECT profile FROM node_index WHERE node_id = ?", id).one().profile)).toBe(p.name);
		const attrs = await p.inProfile((st) => { st.sql.exec("UPDATE nodes SET pinned = 1 WHERE key = ?", key); return st.sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE key = ?", key).one().attrs; });
		expect((await upload(`${P}-1`, gh(30))).status).toBe("flagged");
		await p.inProfile((st) => expect(st.sql.exec("SELECT attrs, flagged FROM nodes WHERE key = ?", key).one()).toEqual({ attrs, flagged: "upload: pinned" }));
		await p.inProfile((st) => st.sql.exec("UPDATE nodes SET pinned = 0, status = 'moving' WHERE key = ?", key));
		expect(await upload(`${P}-1`, gh(20))).toMatchObject({ status: "refused", reason: "moving" });
		await p.inProfile((st) => st.sql.exec("UPDATE nodes SET status = 'active' WHERE key = ?", key));
		await runInDurableObject(account(), (_i, st) => st.storage.sql.exec("INSERT INTO account_meta (key, value) VALUES (?, 'test')", `wiped:${uuid5(`${OWNER}:${p.name}:ticket:jira:${P}-2`)}`));
		expect(await upload(`${P}-2`, gh(20))).toMatchObject({ status: "refused", reason: "profile_wiped" });
		await p.inProfile((st) => st.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', 'test')"));
		expect(await upload(`${P}-1`, gh(10))).toMatchObject({ status: "refused", reason: "profile_wiped" });
		await p.inProfile((st) => {
			expect(st.sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE key = ?", key).one().attrs).toBe(attrs);
			expect(st.sql.exec("SELECT count(*) AS n FROM nodes WHERE key = ?", `jira:${P}-2`).one().n).toBe(0);
		});
	});

	it("takes tickets only for the explicitly named work profile and only inside the strict schema", async () => {
		const w = await workProfile(), p = await isolated(), P = jiraProject();
		const t = { key: `${P}-1`, kind: "ticket", type: "Task", title: "t", updated_at: gh(5), state: "open", status: "To Do", blocked_by: [], blocks: [], related: [], unknown: [] };
		const body = (extra: Record<string, unknown> = {}, ticket: Record<string, unknown> = {}) => ({ profile: "work", as_of: ago(1), tickets: [{ ...t, ...ticket }], ...extra });
		for (const bad of [body({ profile: undefined }), body({ profile: p.name }), body({ profile: "me" }), body({ as_of: undefined }), body({}, { description: "free text" }),
			body({}, { assignee: "bob@example.com" }), body({}, { blocked_by: [`${P}-1`] }), body({}, { unknown: ["priority"], priority: "High" }), body({}, { unknown: ["assignee"], assignee_is_owner: false }),
			body({}, { assignee_is_owner: true }), body({}, { key: `${P.toLowerCase()}-1` }), body({}, { kind: "epic" }), body({ tickets: Array.from({ length: 21 }, (_, i) => ({ ...t, key: `${P}-${i + 1}` })) })]) {
			expect((await post(w.token, bad)).status).toBe(400);
		}
		// A token without work cannot reach it, and a capture body is unchanged.
		expect((await post(p.token, body())).status).toBe(403);
		await w.inWork((st) => expect(st.sql.exec("SELECT count(*) AS n FROM nodes WHERE key LIKE ?", `jira:${P}%`).one().n).toBe(0));
		expect((await post(w.token, body())).data.tickets![0]!.status).toBe("stored");
	});
});


describe("owner undo fences queued enrichment", () => {
	async function fixture(item: "pr" | "ticket") {
		const at = ago(5);
		const p = item === "pr" ? await isolated() : undefined;
		const w = item === "ticket" ? await workProfile() : undefined;
		const key = p ? `github:${p.ns}#731` : `jira:${jiraProject()}-731`;
		const who = p?.who ?? w!.c.account.profiles.find((r) => r.profile === "work")!;
		const inside = p?.inProfile ?? w!.inWork;
		const base = p
			? { number: 731, title: "Queued metadata", state: "open", updated_at: at, head: "branch", reviewers: [], commits: [], closes: [], unknown: ["reviews", "commits"] }
			: { key: key.slice(5), kind: "ticket", type: "Task", title: "Queued metadata", updated_at: at, state: "open", status: "To Do", blocked_by: [], blocks: [], related: [], unknown: ["assignee", "reporter"] };
		const complete = p ? { ...base, unknown: [], reviewers: ["recovered-reviewer"] }
			: { ...base, unknown: [], assignee: "owner-id", assignee_is_owner: true, reporter: "reporter-id" };
		const partial = p ? { ...complete, unknown: ["commits"] } : { ...complete, reporter: undefined, unknown: ["reporter"] };
		const different = p ? { ...base, unknown: ["reviews"], commits: [hex("queued")] }
			: { ...base, unknown: ["assignee"], reporter: "other-reporter" };
		const send = async (snapshot: unknown) => {
			const response = await post(p?.token ?? w!.token, p ? { repo: { remote: p.remote }, as_of: ago(1), prs: [snapshot] }
				: { profile: "work", as_of: ago(1), tickets: [snapshot] });
			expect(response.status).toBe(200);
			return (p ? response.data.prs! : response.data.tickets!)[0]!;
		};
		const state = () => inside((st) => Object.fromEntries(["nodes", "edges", "evidence", "texts", "revisions", "activity", "requests"].map((table) => [table, sorted(st.sql.exec(`SELECT * FROM ${table}`).toArray())])));
		const receipts = () => inside((st) => st.sql.exec<{ result: string }>("SELECT result FROM requests WHERE request_id = ?1 OR (request_id >= ?2 AND request_id < ?3) ORDER BY seq", `upload:${who.profile}:${key}:${at}`, `upload:${who.profile}:${key}:${at}:`, `upload:${who.profile}:${key}:${at};`).toArray());
		const undoLast = async () => {
			const rows = await receipts(), result = JSON.parse(rows.at(-1)!.result) as { activity_id: number };
			await inside((st) => expect(undo(st, who, result.activity_id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone"));
			// Settle scheduled and in-flight fixture work before the global replay snapshot.
			const stub = env.PROFILE.get(env.PROFILE.idFromName(`${who.userId}:${who.profile}:${who.generation}`));
			await runDurableObjectAlarm(stub);
			await inside((st) => st.deleteAlarm());
			await evictDurableObject(stub);
			await inside((st) => st.deleteAlarm());
		};
		return { base, complete, partial, different, send, state, receipts, undoLast, at };
	}

	it.each(["pr", "ticket"] as const)("keeps an undone initial %s upload absent on queued same-revision completion", async (item) => {
		const f = await fixture(item);
		expect((await f.send(f.base)).status).toBe("stored");
		const original = await f.receipts();
		await f.undoLast();
		const undone = await f.state();
		expect((await f.send(f.base)).status).toBe("replayed");
		expect(await f.state()).toEqual(undone);
		expect(await f.send(f.complete)).toMatchObject({ status: "refused", reason: "idempotency_mismatch" });
		expect(await f.state()).toEqual(undone);
		expect(await f.receipts()).toEqual(original);
		expect((await f.send({ ...f.complete, updated_at: ago(2) })).status).toBe("stored");
	});

	it.each(["pr", "ticket"] as const)("keeps an undone %s enrichment reversed on a later differing partial completion", async (item) => {
		const f = await fixture(item);
		expect((await f.send(f.base)).status).toBe("stored");
		expect((await f.send(f.partial)).status).toBe("stored");
		const original = await f.receipts();
		await f.undoLast();
		const undone = await f.state();
		expect((await f.send(f.base)).status).toBe("replayed");
		expect((await f.send(f.partial)).status).toBe("replayed");
		expect(await f.state()).toEqual(undone);
		expect(await f.send(f.different)).toMatchObject({ status: "refused", reason: "idempotency_mismatch" });
		expect(await f.state()).toEqual(undone);
		expect(await f.receipts()).toEqual(original);
		expect((await f.send({ ...f.complete, updated_at: ago(2) })).status).toBe("stored");
	});
});

describe("same-revision completeness recovery",()=>{
 it("enriches unknown PR fields without changing old results or accepting known conflicts, and undoes",async()=>{
  const p=await isolated(), time=ago(5), key=`github:${p.ns}#91`;
  const base={number:91,title:"Recovery",state:"open",updated_at:time,head:"branch",reviewers:[],commits:[],closes:[],unknown:["reviews"]};
  const send=async(pr:unknown)=>(await post(p.token,{repo:{remote:p.remote},as_of:ago(1),prs:[pr]})).data.prs![0]!;
  expect((await send(base)).status).toBe("stored");
  const saved=await p.inProfile(s=>s.sql.exec("SELECT request_id,payload_hash,result FROM requests ORDER BY seq").toArray());
  const complete={...base,reviewers:["recovered-reviewer"],unknown:[]};
  expect((await send(complete)).status).toBe("stored");
  const enrichmentActivity=await p.inProfile(s=>s.sql.exec<{id:number}>("SELECT id FROM activity WHERE op = 'upload' ORDER BY id DESC LIMIT 1").one().id);
  const attrs=()=>p.inProfile(s=>s.sql.exec<{attrs:string}>("SELECT attrs FROM nodes WHERE key = ?",key).one().attrs);
  expect(JSON.parse(await attrs()).unknown).toBeUndefined();
  expect((await send({...complete,title:"conflicting"}))).toMatchObject({status:"refused",reason:"idempotency_mismatch"});
  expect((await send(base)).status).toBe("replayed");
  expect((await send(complete)).status).toBe("replayed");
  expect((await send({...complete,number:92,reviewers:["other-reviewer"]})).status).toBe("stored");
  expect((await send({...base,number:92,reviewers:["contradictory-partial"],unknown:["reviews","author"]})).status).toBe("stored");
  await p.inProfile(s=>{
   expect(graph(s.sql).some(e=>e.src==="person:github:contradictory-partial"&&e.dst===`github:${p.ns}#92`)).toBe(false);
   expect(JSON.parse(s.sql.exec<{attrs:string}>("SELECT attrs FROM nodes WHERE key = ?",`github:${p.ns}#92`).one().attrs).unknown).toBeUndefined();
  });
  await p.inProfile(s=>{
   expect(s.sql.exec("SELECT request_id,payload_hash,result FROM requests WHERE request_id = ?",saved[0]!.request_id!).toArray()).toEqual(saved);
   expect(graph(s.sql).some(e=>e.src==="person:github:recovered-reviewer"&&e.dst===key)).toBe(true);
   const id=enrichmentActivity;
   expect(undo(s,p.who,id,{actor:"owner",platform:"test",routedBy:"test",userId:OWNER}).result.action).toBe("undone");
   expect(graph(s.sql).some(e=>e.src==="person:github:recovered-reviewer"&&e.dst===key)).toBe(false);
  });
  expect(JSON.parse(await attrs()).unknown).toEqual(["reviews"]);
 });
 it("uses the same monotonic policy for Jira assignments and preserves known owner flags on unknown rereads",async()=>{
  const w=await workProfile(), key=`${jiraProject()}-91`, time=ago(5);
  const base={key,kind:"ticket",type:"Task",title:"Recovery",updated_at:time,state:"open",status:"To Do",blocked_by:[],blocks:[],related:[],unknown:["assignee"]};
  const send=async(t:unknown)=>(await post(w.token,{profile:"work",as_of:ago(1),tickets:[t]})).data.tickets![0]!;
  expect((await send(base)).status).toBe("stored");
  const complete={...base,assignee:"owner-id",assignee_is_owner:true,unknown:[]};
  expect((await send(complete)).status).toBe("stored");
  expect((await send({...complete,title:"conflict"}))).toMatchObject({status:"refused",reason:"idempotency_mismatch"});
  expect((await send({...base,unknown:["assignee","priority"]})).status).toBe("stored");
  await w.inWork(s=>{
   const attrs=JSON.parse(s.sql.exec<{attrs:string}>("SELECT attrs FROM nodes WHERE key = ?",`jira:${key}`).one().attrs);
   expect(attrs.assignee_is_owner).toBe(true);expect(attrs.unknown).toBeUndefined();
   expect(graph(s.sql).some(e=>e.src==="person:jira:owner-id"&&e.dst===`jira:${key}`)).toBe(true);
  });
 });
});

describe("Jira reciprocal link source order", () => {
	const T0 = "2026-10-20T10:00:00.000Z", T1 = "2026-10-20T11:00:00.000Z", T2 = "2026-10-20T12:00:00.000Z", TM = "2026-10-20T12:30:00.000Z", T3 = "2026-10-20T13:00:00.000Z",
		T4 = "2026-10-20T14:00:00.000Z", T5 = "2026-10-20T15:00:00.000Z";
	/** Tickets A and B, not yet uploaded; B already held under an agent's lowercase key when `lower`. */
	async function tickets(lower = false) {
		const w = await workProfile(), P = jiraProject(), A = `${P}-1`, B = `${P}-2`;
		if (lower) await call(w.c, "record_knowledge", { profile: "work", nodes: [{ kind: "ticket", key: `jira:${B}`.toLowerCase(), name: "Agent's ticket" }] });
		const send = async (key: string, at: string, fields: Record<string, unknown> = {}) => {
			const r = await post(w.token, { profile: "work", as_of: T5, tickets: [{ key, kind: "ticket", type: "Task", title: "Linked ticket", updated_at: at, state: "open", status: "To Do", blocked_by: [], blocks: [], related: [], unknown: [], ...fields }] });
			expect(r.data.tickets![0]!.status).toBe("stored");
		};
		const edge = () => w.inWork((st) => st.sql.exec(`SELECT e.valid_from, e.valid_to, e.ended_at IS NOT NULL AS ended FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
			WHERE s.key = ? COLLATE NOCASE AND e.rel = 'blocked_by' AND d.key = ? COLLATE NOCASE ORDER BY e.id DESC LIMIT 1`, `jira:${B}`, `jira:${A}`).toArray());
		return { w, A, B, send, edge };
	}
	/** A and B held at T0 without links, then B's T2 snapshot says A blocks it: one current B blocked_by A from T2. */
	async function linked(lower = false) {
		const f = await tickets(lower);
		await f.send(f.A, T0); await f.send(f.B, T0); await f.send(f.B, T2, { blocked_by: [f.A] });
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		return f;
	}

	it("keeps the other ticket's newer link when an older snapshot without it arrives late, and still takes that ticket's own fields", async () => {
		const f = await linked();
		await f.send(f.A, T1, { status: "In Progress" });
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		await f.w.inWork((st) => expect(JSON.parse(st.sql.exec<{ attrs: string }>("SELECT attrs FROM nodes WHERE key = ?", `jira:${f.A}`).one().attrs)).toMatchObject({ status: "In Progress", updated_at: T1 }));
	});

	it("does not bring back a link the other ticket's newer snapshot removed, and takes a genuinely newer assertion", async () => {
		const f = await linked();
		await f.send(f.B, T3);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T3, ended: 1 }]);
		await f.send(f.A, T1, { blocks: [f.B] });
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T3, ended: 1 }]);
		await f.send(f.A, T4, { blocks: [f.B] });
		expect(await f.edge()).toEqual([{ valid_from: T4, valid_to: null, ended: 0 }]);
	});

	it("ends the link when the arriving removal is newer than the other ticket's", async () => {
		const f = await linked();
		await f.send(f.A, T3);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T3, ended: 1 }]);
	});

	it("ranks the other ticket by its newest snapshot that knew its links, not by a newer one that did not", async () => {
		const f = await linked();
		await f.send(f.B, T4, { unknown: ["issuelinks"] });
		await f.send(f.A, T1);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		await f.send(f.A, T3);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T3, ended: 1 }]);
	});

	it("no longer ranks the other ticket by a snapshot the owner undid", async () => {
		const f = await linked(), who = f.w.c.account.profiles.find((r) => r.profile === "work")!;
		await f.w.inWork((st) => {
			const id = (JSON.parse(st.sql.exec<{ result: string }>("SELECT result FROM requests WHERE request_id = ?", `upload:work:jira:${f.B}:${T2}`).one().result) as { activity_id: number }).activity_id;
			expect(undo(st, who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone");
		});
		expect(await f.edge()).toEqual([]);
		await f.send(f.A, T1, { blocks: [f.B] });
		expect(await f.edge()).toEqual([{ valid_from: T1, valid_to: null, ended: 0 }]);
	});

	it("keeps the other ticket's word when its node kept an agent's lowercase key", async () => {
		const f = await linked(true);
		await f.send(f.A, T1);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
	});

	it("makes a listing kept while the other ticket was absent its link when that ticket arrives older, listing it or not", async () => {
		for (const blocks of [true, false]) {
			const f = await tickets();
			await f.send(f.B, T2, { blocked_by: [f.A] });
			expect(await f.edge()).toEqual([]);
			await f.send(f.A, T1, blocks ? { blocks: [f.B] } : {});
			expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
			await f.send(f.A, T3);
			expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T3, ended: 1 }]);
		}
	});

	it("keeps a partial list's listing as the other ticket's word, and lets nothing older end or unknown revive the link", async () => {
		const f = await tickets();
		await f.send(f.A, T0); await f.send(f.B, T0);
		await f.send(f.B, T2, { blocked_by: [f.A], unknown: ["issuelinks"] });
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		await f.send(f.A, T1);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		// B relists it in a newer partial list, so A's removal at 12:30 is older; A's at T4 is newer and ends it.
		await f.send(f.B, T3, { blocked_by: [f.A], unknown: ["issuelinks"] });
		await f.send(f.A, TM);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		await f.send(f.A, T4);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T4, ended: 1 }]);
		await f.send(f.A, T5, { unknown: ["issuelinks"] });
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T4, ended: 1 }]);
	});


	it("supersedes a same-revision partial positive on complete removal and restores it exactly on Undo", async () => {
		const f = await tickets(), who = f.w.c.account.profiles.find((r) => r.profile === "work")!;
		await f.send(f.A, T0); await f.send(f.B, T0);
		await f.send(f.B, T2, { blocked_by: [f.A], unknown: ["issuelinks"] });
		const listing = () => f.w.inWork((s) => s.sql.exec("SELECT owner, kind, ref, note FROM evidence WHERE owner IN (SELECT 'n:' || id FROM nodes WHERE key = ?) AND kind = 'jira_link' ORDER BY ref", "jira:" + f.B).toArray());
		const partial = await listing();
		await f.send(f.B, T2);
		const receipt = () => f.w.inWork((s) => s.sql.exec<{ result: string }>("SELECT result FROM requests WHERE node_id IN (SELECT id FROM nodes WHERE key = ?) AND op = 'upload' ORDER BY seq DESC LIMIT 1", "jira:" + f.B).one().result);
		const raw = await receipt(), id = (JSON.parse(raw) as { activity_id: number }).activity_id;
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T2, ended: 1 }]);
		await f.send(f.A, T1);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: T2, ended: 1 }]);
		await f.w.inWork((s) => expect(undo(s, who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone"));
		expect(await listing()).toEqual(partial);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		const replay = await post(f.w.token, { profile: "work", as_of: T5, tickets: [{ key: f.B, kind: "ticket", type: "Task", title: "Linked ticket", updated_at: T2, state: "open", status: "To Do", blocked_by: [], blocks: [], related: [], unknown: [] }] });
		expect(replay.data.tickets![0]!.status).toBe("replayed");
		expect(await receipt()).toBe(raw);
		expect(await listing()).toEqual(partial);
		await f.send(f.A, "2026-10-20T11:30:00.000Z");
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
	});

	it("retains a still-listed absent endpoint when a partial list completes at the same time", async () => {
		for (const field of ["blocked_by", "blocks"]) {
			const f = await tickets();
			await f.send(f.B, T2, { [field]: [f.A], unknown: ["issuelinks"] });
			await f.send(f.B, T2, { [field]: [f.A] });
			await f.send(f.A, T1);
			const edges = await f.w.inWork((s) => s.sql.exec("SELECT valid_from, valid_to FROM edges WHERE rel = 'blocked_by' AND src IN (SELECT id FROM nodes WHERE key IN (?, ?))", "jira:" + f.A, "jira:" + f.B).toArray());
			expect(edges).toEqual([{ valid_from: T2, valid_to: null }]);
			await f.send(f.B, T3);
			await f.send(f.B, T4, { [field]: [f.A], unknown: ["issuelinks"] });
			await f.send(f.A, TM);
			const current = await f.w.inWork((s) => s.sql.exec("SELECT valid_from, valid_to FROM edges WHERE rel = 'blocked_by' AND ended_at IS NULL AND src IN (SELECT id FROM nodes WHERE key IN (?, ?))", "jira:" + f.A, "jira:" + f.B).toArray());
			expect(current).toEqual([{ valid_from: T4, valid_to: null }]);
		}
	});

	it("reaches an older valid listing after 100 newer listings were removed", async () => {
		const f = await tickets(), stem = f.A.split("-")[0];
		await f.send(f.B, T1, { blocked_by: [f.A] });
		for (let i = 3; i <= 102; i++) {
			await f.send(stem + "-" + i, T2, { blocks: [f.A] });
			await f.send(stem + "-" + i, T3);
		}
		await f.send(f.A, T0);
		expect(await f.edge()).toEqual([{ valid_from: T1, valid_to: null, ended: 0 }]);
	});

	it("refuses 101 live incoming listings atomically and keeps the local exact request pending", async () => {
		const f = await tickets(), stem = f.A.split("-")[0];
		for (let i = 2; i <= 102; i++) await f.send(stem + "-" + i, T2, { [i % 2 ? "blocks" : "blocked_by"]: [f.A] });
		const snapshot = () => f.w.inWork((s) => ["profile_meta", "nodes", "texts", "revisions", "edges", "evidence", "requests", "activity", "deleted_rows", "maintenance", "markers", "archive", "cursors"].map((table) => s.sql.exec("SELECT * FROM " + table).toArray()));
		const before = await snapshot(), sent: string[] = [];
		const refused = await post(f.w.token, { profile: "work", as_of: T5, tickets: [{ key: f.A, kind: "ticket", type: "Task", title: "Endpoint", updated_at: T0,
			state: "open", status: "To Do", assignee_is_owner: false, blocked_by: [], blocks: [], related: [], unknown: [] }] });
		expect(refused.data.tickets![0]).toMatchObject({ status: "refused", reason: "size_budget" });
		expect(await snapshot()).toEqual(before);
		let reads = 0;
		const connector = { account: "~/.claude", readOnly: true, read: async () => {
			reads++;
			return JSON.stringify({ issues: [{ key: f.A, fields: { summary: "Endpoint", issuetype: { name: "Task" }, updated: T0,
				status: { name: "To Do", statusCategory: { key: "new" } }, priority: null, duedate: null, assignee: null, reporter: null, issuelinks: [] } }] });
		} };
		const run = () => uploadTickets({ keys: [f.A], stateFile: "/tmp/am-jira-" + stem + "/pending.json", connector, ownerAccountId: "owner-id", now: () => T5,
			send: async (body: unknown) => {
				sent.push(JSON.stringify(body));
				const r = await post(f.w.token, body);
				expect(r.status).toBe(200);
				expect(r.data.tickets![0]).toMatchObject({ status: "refused", reason: "size_budget" });
				return r.data;
			} });
		expect(await run()).toMatchObject({ status: "pending", reason: "not_acknowledged" });
		expect(await snapshot()).toEqual(before);
		expect(await run()).toEqual({ status: "pending", reason: "not_acknowledged" });
		expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]); expect(reads).toBe(1);
		expect(await snapshot()).toEqual(before);
		await runInDurableObject(account(), (_i, s) => expect(s.storage.sql.exec("SELECT 1 FROM request_index WHERE request_id = ?", "upload:work:jira:" + f.A + ":" + T0).toArray()).toEqual([]));
		// One source removes its listing. The unchanged pending body can now finish within the same bound.
		await f.send(f.B, T3);
		const body = JSON.parse(sent[0]!) as { tickets: { key: string; updated_at: string }[] };
		const stored = await post(f.w.token, body);
		expect(stored.data.tickets![0]!.status).toBe("stored");
		expect((await post(f.w.token, body)).data.tickets![0]!.status).toBe("replayed");
		const edges = await f.w.inWork((s) => s.sql.exec<{ n: number }>("SELECT count(*) n FROM edges WHERE rel = 'blocked_by' AND ended_at IS NULL AND (src IN (SELECT id FROM nodes WHERE key = ?1) OR dst IN (SELECT id FROM nodes WHERE key = ?1))", "jira:" + f.A).one().n);
		expect(edges).toBe(100);
	});

	// Last in the file: it ages out every activity row of the shared work profile.
	it("keeps the other ticket's undone snapshot undone after its activity ages out", async () => {
		const f = await linked(), who = f.w.c.account.profiles.find((r) => r.profile === "work")!;
		await f.send(f.B, T3);
		const id = await f.w.inWork((st) => (JSON.parse(st.sql.exec<{ result: string }>("SELECT result FROM requests WHERE request_id = ?", `upload:work:jira:${f.B}:${T3}`).one().result) as { activity_id: number }).activity_id);
		await f.w.inWork((st) => expect(undo(st, who, id, { actor: "owner", platform: "test", routedBy: "test", userId: OWNER }).result.action).toBe("undone"));
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: null, ended: 0 }]);
		await f.w.inWork((st) => {
			const now = Date.now() + 401 * 86_400_000;
			for (const stage of ["dedupe", "ttl", "queue"]) st.sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES (?, NULL, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", stage, now + 86_400_000);
			st.sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('purge', NULL, 0) ON CONFLICT (stage) DO UPDATE SET due_at = 0");
			let more: boolean;
			do {
				const page = housekeep(st, who, now);
				expect(page.stage).toBe("purge");
				more = page.more;
			} while (more);
			expect(st.sql.exec("SELECT 1 FROM activity WHERE id = ?", id).toArray()).toEqual([]);
		});
		await f.send(f.A, TM);
		expect(await f.edge()).toEqual([{ valid_from: T2, valid_to: TM, ended: 1 }]);
	});
});

describe("GET /v1/markers", () => {
	const digest = JSON.stringify({ asks: [{ text: "Fix the refresh loop", pos: 10 }], decisions: [], corrections: [], outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
	const part = (range_id: string, capture_status: "heuristic" | "consolidated", part_id: string) => ({ range_id, capture_status, part_id, sha256: sha256(digest), body: digest });
	const read = async (token: string, query: string) => {
		const res = await exports.default.fetch(new Request(`${origin}/v1/markers?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
		return { status: res.status, data: await res.json() as any }; // checked field by field
	};
	/** Every application table's rows, the profile's meta and its alarm: a markers read must change none. */
	const state = (p: Awaited<ReturnType<typeof isolated>>) => p.inProfile(async (s) => ({
		counts: s.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").toArray()
			.map((t) => [t.name, s.sql.exec(`SELECT count(*) AS n FROM "${t.name}"`).one().n]),
		meta: s.sql.exec("SELECT key, value FROM profile_meta ORDER BY key").toArray(), alarm: await s.getAlarm(),
	}));

	it("returns the marker, a session's acknowledged cursors without gaps and the daily slot, and changes nothing", async () => {
		const p = await isolated(), epoch = "0a1b2c3d", sid = `thr_${p.name}`, range = (a: number, b: number) => `codex:${sid}:${epoch}:${a}-${b}`;
		const q = `repo=${encodeURIComponent(p.remote)}&session=codex:${sid}`;
		expect((await read(p.token, q)).data).toMatchObject({ profile: p.name, repo: p.ns, marker: null, captures: { ranges: [], acknowledged: {} }, daily: { batch: { last_lease_at: null, next_allowed_at: null }, refresh: null } });
		const session = { client: "codex", id: sid };
		expect((await post(p.token, { session, repo: { remote: p.remote }, digests: [part(range(0, 100), "heuristic", "-"), part(range(0, 100), "consolidated", "0-100"),
			part(range(100, 250), "heuristic", "-"), part(range(300, 400), "heuristic", "-")], manifests: [{ range_id: range(0, 100), parts: [{ part_id: "0-100", sha256: sha256(digest) }] }] })).status).toBe(200);
		const head = hex("markers-head");
		expect((await post(p.token, { repo: { remote: p.remote }, commits: [{ sha: head, at: ago(5), title: "markers head" }], marker: { head, as_of: ago(1) } })).data.marker).toMatchObject({ status: "stored" });
		const before = await state(p);
		const got = await read(p.token, q);
		expect(got.status).toBe(200);
		expect(got.data).toMatchObject({ marker: { head }, captures: { truncated: false, acknowledged: { [epoch]: { digested_to: 250, consolidated_to: 100 } } } });
		expect(got.data.captures.ranges.map((r: { range_id: string; heuristic: boolean; consolidated: boolean }) => [r.range_id, r.heuristic, r.consolidated]).sort())
			.toEqual([[range(0, 100), true, true], [range(100, 250), true, false], [range(300, 400), true, false]]);
		// Without a session the cursors are not read; another session reads empty.
		expect((await read(p.token, `repo=${encodeURIComponent(p.remote)}`)).data.captures).toBeNull();
		expect((await read(p.token, `repo=${encodeURIComponent(p.remote)}&session=codex:thr_other`)).data.captures).toMatchObject({ ranges: [], acknowledged: {} });
		expect(await state(p)).toEqual(before);
	});

	it("refuses missing or wrong tokens, other profiles, me, bad input, a revoked token, a closed generation and a recovering account", async () => {
		const p = await isolated(), q = `repo=${encodeURIComponent(p.remote)}`;
		expect((await read("", q)).status).toBe(401);
		const reader = (await deviceToken(`markers-read-${p.name}`, ["read"], [p.name])).token;
		expect((await read(reader, q)).status).toBe(403);
		const other = await isolated();
		expect((await read(other.token, q)).status).toBe(403);
		expect((await read(p.token, `${q}&profile=${other.name}`)).status).toBe(403);
		expect((await read(p.token, "profile=me")).status).toBe(403);
		for (const bad of ["profile=nosuch", "profile=Bad", "session=slack:x", "session=codex:", "extra=1", `repo=${"r".repeat(513)}`]) expect([bad, (await read(p.token, bad)).status]).toEqual([bad, 400]);
		const revoked = await deviceToken(`markers-revoked-${p.name}`, ["ingest"], [p.name]);
		await account().admin({ op: "revokeDevice", id: revoked.id });
		expect((await read(revoked.token, q)).status).toBe(401);
		await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("INSERT INTO account_meta (key, value) VALUES ('recovery_state', 'restoring')"));
		try { expect((await read(p.token, q)).status).toBe(503); } finally { await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("DELETE FROM account_meta WHERE key = 'recovery_state'")); }
		// A generation closed in its own object, then a profile the account no longer holds active: both refused.
		await p.inProfile((s) => s.sql.exec("INSERT INTO profile_meta (key, value) VALUES ('closed', '1')"));
		expect(await read(p.token, q)).toMatchObject({ status: 400, data: { error: { code: "profile_wiped" } } });
		await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = ?", p.name));
		expect(await read(p.token, q)).toMatchObject({ status: 400, data: { error: { code: "profile_wiped" } } });
	});
});

describe("routing to a profile that is no longer active", () => {
	it("refuses it with profile_wiped on ingest, capture state, markers and MCP reads instead of failing", async () => {
		const p = await isolated();
		await runInDurableObject(account(), (_i, s) => s.storage.sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = ?", p.name));
		const session = { client: "codex", id: `thr_${p.name}` };
		const send = (path: string, body: unknown) => exports.default.fetch(new Request(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${p.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
			.then(async (r) => ({ status: r.status, data: await r.json() as { error?: { code: string } } }));
		for (const [path, body] of [["/v1/ingest", { session, repo: { remote: p.remote }, digests: [], manifests: [] }], ["/v1/capture", { range_ids: [`codex:${session.id}:0a1b2c3d:0-1`], repo: { remote: p.remote } }],
			["/v1/ingest", { repo: { remote: p.remote }, commits: [{ sha: hex("inactive"), at: ago(1), title: "inactive" }] }]] as const) {
			expect([path, await send(path, body)]).toMatchObject([path, { status: 400, data: { error: { code: "profile_wiped" } } }]);
		}
		const markers = await exports.default.fetch(new Request(`${origin}/v1/markers?repo=${encodeURIComponent(p.remote)}`, { headers: { authorization: `Bearer ${p.token}` } }));
		expect(markers.status).toBe(400);
		const c = await contextFor();
		for (const [tool, args] of [["recall_memories", { keyword: "anything" }], ["recall_memories", { keyword: "" }], ["get_memory", { name: "anything" }], ["timeline", { from: ago(60), to: ago(0) }],
			["review_candidates", { action: "list" }], ["save_memory", { name: "x", type: "reference", description: "d" }]] as const) {
			expect([tool, await outcome(c, tool, { ...args, repo: { remote: p.remote } })]).toMatchObject([tool, { ok: false, error: { code: "profile_wiped" } }]);
		}
	});
});
