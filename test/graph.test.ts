// Phase-3 graph checks (section 22): extraction, explore, trace, timeline, work budgets, links across profiles, recall's
// graph channel and the similarity stage. Tool-level cases need the integrator's wiring (docs/module-contracts.md, C3).
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, contextFor, deviceToken, devicePrincipal, outcome } from "./helpers";
import { identifiers, resolveMentions, resolveMentionsAlone, structuralEdges, type TxLike } from "../src/profile/extract";
import { EDGE_ROWS, EXPAND_ROWS, expandLinks, explore, trace, timeline, LEVEL_NODES } from "../src/profile/graph";
import { SETTLE_MS, similarStep } from "../src/profile/similar";
import { sha256 } from "../src/domain/ids";
import { nextSeq } from "../src/storage";

type Ctx = Awaited<ReturnType<typeof contextFor>>;
const stub = (c: Ctx, name: string) => {
	const ref = c.account.profiles.find((p) => p.profile === name)!;
	return env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
};
const inProfile = <T>(c: Ctx, name: string, fn: (sql: SqlStorage, storage: DurableObjectStorage) => T | Promise<T>) =>
	runInDurableObject(stub(c, name), (_i, s) => fn(s.storage.sql, s.storage));

/** Test-only rows written straight into a profile, for shapes the write path cannot make yet (links across profiles, large graphs). */
function seedNode(sql: SqlStorage, seq: number, id: string, kind = "ticket", extra: { key?: string; type?: string } = {}) {
	const now = new Date().toISOString();
	sql.exec(`INSERT INTO nodes (id, kind, key, memory_type, name, norm_name, status, origin, content_hash, card_hash, embed_hash, recorded_at, created_at, updated_at, seq)
		VALUES (?, ?, ?, ?, ?, ?, 'active', 'agent', 'h', 'c', 'c', ?, ?, ?, ?)`, id, kind, extra.key ?? null, extra.type ?? null, id, id.toLowerCase(), now, now, now, seq);
}
function seedEdge(sql: SqlStorage, seq: number, src: string, rel: string, dst: string, o: { basis?: string; dstProfile?: string; score?: number } = {}): number {
	return Number(sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, reason, score, recorded_at, actor, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?) RETURNING id`,
		src, rel, dst, o.dstProfile ?? "", o.basis ?? "judgment", "seeded for the graph test", o.score ?? null, new Date().toISOString(), seq).one().id);
}

type Link = { id: number; rel: string; basis: string; reason: string | null; depth: number; evidence: { kind: string; ref: string; readable?: false }[];
	from: { id: string; name?: string; readable?: boolean }; to: { id: string; name?: string; profile?: string; readable?: boolean } };
type Explore = { node: { id: string; readable?: false }; links: Record<string, Link[]>; links_total: number; people: { id: string; rels: string[] }[]; related: { id: string }[];
	followed: string[]; budget: { edges_read: number; exhausted: boolean; stopped: string | null } };
const flat = (e: Explore) => Object.values(e.links).flat();

describe("identifier extraction", () => {
	const text = `Fixes SEQ-1234 on feature/SEQ-77-login. See https://github.com/Sequoia-Engineering/web/pull/812 and wrick17/bettergit#41.
		Commit https://github.com/Sequoia-Engineering/web/commit/9F2C1AB0e1d2 and Sequoia-Engineering/web@9f2c1ab. Ask @a-lee, not a@b.co or @types/node.
		Session session:codex:thr_123. Code at https://github.com/Sequoia-Engineering/web/blob/main/src/auth/token.ts#L40 and Sequoia-Engineering/web:src/auth/refresh.ts.
		Not tickets: UTF-8, SHA-256, UTC-5, ISO-8859-1, CVE-2024-1234, SEQ-12a.`;

	it("finds the fixture's ids with precision of at least 0.95, and no standard's name as a ticket", () => {
		const expected = ["jira:SEQ-1234", "jira:SEQ-77", "github:Sequoia-Engineering/web#812", "github:wrick17/bettergit#41",
			"git:Sequoia-Engineering/web@9f2c1ab0e1d2", "git:Sequoia-Engineering/web@9f2c1ab", "person:github:a-lee", "session:codex:thr_123"];
		const { keys, files } = identifiers(text);
		const precision = keys.filter((k) => expected.includes(k)).length / keys.length;
		expect(precision).toBeGreaterThanOrEqual(0.95);
		expect(keys).toEqual(expect.arrayContaining(expected));
		expect(keys.filter((k) => /UTF|SHA|UTC|ISO|CVE|SEQ-12$/.test(k))).toEqual([]);
		expect(files).toEqual(["Sequoia-Engineering/web:src/auth/token.ts#L40", "Sequoia-Engineering/web:src/auth/refresh.ts"]);
	});

	it("gives fixes only from closing references, never from a mention", () => {
		const pr = structuralEdges({ key: "github:org/r#9", author: "a-lee", reviewers: ["b-kim"], commits: ["git:org/r@abc1234"], closes: ["github:org/r#5"] });
		expect(pr).toEqual([
			{ from: "person:github:a-lee", rel: "authored", to: "github:org/r#9" }, { from: "person:github:b-kim", rel: "reviewed", to: "github:org/r#9" },
			{ from: "git:org/r@abc1234", rel: "part_of", to: "github:org/r#9" }, { from: "github:org/r#9", rel: "fixes", to: "github:org/r#5" },
		]);
		expect(structuralEdges({ key: "git:org/r@abc1234", author: "a-lee" }).some((e) => e.rel === "fixes")).toBe(false);
	});

	it("links a write to the mentioned nodes that exist, only as relates_to, and records file evidence", async () => {
		const c = await contextFor();
		await call(c, "record_knowledge", { profile: "test", nodes: [
			{ kind: "ticket", key: "jira:SEQ-1234", name: "SEQ-1234 refresh loop" }, { kind: "ticket", key: "jira:SEQ-12", name: "SEQ-12 decoy" },
			{ kind: "pr", key: "github:Sequoia-Engineering/web#812", name: "web#812" }, { kind: "commit", key: "git:Sequoia-Engineering/web@9f2c1ab", name: "9f2c1ab" },
			{ kind: "person", key: "person:github:a-lee", name: "A Lee" },
		] });
		const m = await call(c, "save_memory", { name: "Extraction fixture note", type: "reference", description: "mentions", content: text, profile: "test" });
		const { edges, evidence, utf } = await inProfile(c, "test", (sql) => ({
			edges: sql.exec<{ rel: string; basis: string; key: string }>("SELECT e.rel, e.basis, n.key FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ?", m.memory_id).toArray(),
			evidence: sql.exec<{ ref: string }>("SELECT ref FROM evidence WHERE owner = ? AND kind = 'file' ORDER BY ref", `n:${m.memory_id}`).toArray().map((r) => r.ref),
			utf: sql.exec<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE key LIKE 'jira:UTF%' OR key LIKE 'jira:SHA%'").one().n,
		}));
		expect(edges.map((e) => e.key).sort()).toEqual(["git:Sequoia-Engineering/web@9f2c1ab", "github:Sequoia-Engineering/web#812", "jira:SEQ-1234", "person:github:a-lee"]);
		expect(edges.every((e) => e.rel === "relates_to" && e.basis === "identifier")).toBe(true);
		expect(evidence).toEqual(["Sequoia-Engineering/web:src/auth/refresh.ts", "Sequoia-Engineering/web:src/auth/token.ts#L40"]);
		expect(utf).toBe(0);
	});
});

describe("explore, trace and timeline", () => {
	// decision D decided_because bug B; B introduced_by commit C; C part_of pr P; person A authored C. Written once: a decision
	// is not upserted by name, so a second write of it is already_exists.
	let seeded: ReturnType<typeof write> | undefined;
	const seed = (c: Ctx) => (seeded ??= write(c));
	const write = async (c: Ctx) => {
		const r = await call<{ nodes: { id: string }[]; edges: { id: number }[] }>(c, "record_knowledge", { profile: "test", nodes: [
			{ kind: "bug", key: "jira:GT-1", name: "GT-1 token refresh loop" }, { kind: "commit", key: "git:org/gt@aaaaaaa", name: "aaaaaaa retry per call" },
			{ kind: "pr", key: "github:org/gt#9", name: "gt#9 shared client" },
			{ kind: "decision", name: "Use one refresh client", why: "per-call retries looped", evidence: [{ kind: "pr", ref: "github:org/gt#9" }] },
			{ kind: "person", key: "person:github:gt-dev", name: "GT Dev" },
		], edges: [
			{ from: { ref: 3 }, rel: "decided_because", to: { ref: 0 }, reason: "the loop came from per-call retries", evidence: [{ kind: "ticket", ref: "jira:GT-1" }] },
			{ from: { ref: 0 }, rel: "introduced_by", to: { ref: 1 }, reason: "bisected to the retry commit", evidence: [{ kind: "commit", ref: "git:org/gt@aaaaaaa" }] },
			{ from: { ref: 1 }, rel: "part_of", to: { ref: 2 }, reason: "listed in the PR's commits", evidence: [{ kind: "pr", ref: "github:org/gt#9" }] },
			{ from: { ref: 4 }, rel: "authored", to: { ref: 1 }, reason: "commit author on GitHub", evidence: [{ kind: "commit", ref: "git:org/gt@aaaaaaa" }] },
		] });
		return { ids: r.nodes.map((n) => n.id) as [string, string, string, string, string], edges: r.edges.map((e) => e.id) };
	};

	it("explores a node's links by class with reasons, evidence, people and valid time", async () => {
		const c = await contextFor();
		const { ids: [b, cm, , d, a], edges } = await seed(c);
		const bug = await call<Explore>(c, "explore", { node: { key: "jira:GT-1" }, profile: "test" });
		expect(bug.node).toMatchObject({ id: b, kind: "bug", profile: "test" });
		expect(bug.links.reasoning).toEqual([expect.objectContaining({ rel: "decided_because", reason: "the loop came from per-call retries", from: expect.objectContaining({ id: d }),
			evidence: [expect.objectContaining({ kind: "ticket", ref: "jira:GT-1" })] })]);
		expect(bug.links.work).toEqual([expect.objectContaining({ rel: "introduced_by", to: expect.objectContaining({ id: cm, name: "aaaaaaa retry per call" }) })]);
		expect(bug.related.map((r) => r.id)).toEqual([d]);
		expect(bug.budget.exhausted).toBe(false);
		const commit = await call<Explore>(c, "explore", { node: { id: cm } });
		expect(commit.people).toEqual([expect.objectContaining({ id: a, rels: ["authored"] })]);
		// Ending the authored edge keeps it as history: gone now, there as of a date it was valid.
		await call(c, "record_knowledge", { profile: "test", end: [{ edge: edges[3], valid_to: "2026-01-01", reason: "rewritten by someone else" }] });
		expect((await call<Explore>(c, "explore", { node: { id: cm } })).people).toEqual([]);
		expect((await call<Explore>(c, "explore", { node: { id: cm }, as_of: "2025-12-01" })).people).toEqual([expect.objectContaining({ id: a })]);
		const two = await call<Explore>(c, "explore", { node: { id: d }, depth: 2 });
		expect(flat(two).map((l) => [l.rel, l.depth])).toEqual(expect.arrayContaining([["decided_because", 1], ["introduced_by", 2]]));
	});

	it("traces why with each reason and its evidence, and finds the three-hop path, using similarity only when nothing else connects", async () => {
		const c = await contextFor();
		const { ids: [b, cm, p, d] } = await seed(c);
		const why = await call<{ chain: Link[] }>(c, "trace", { from: { name: "Use one refresh client", kind: "decision" }, mode: "why", profile: "test" });
		expect(why.chain.map((l) => [l.rel, l.from.id, l.to.id, l.depth])).toEqual([["decided_because", d, b, 1], ["introduced_by", b, cm, 2]]);
		expect(why.chain.every((l) => l.reason && l.evidence.length)).toBe(true);
		const path = await call<{ paths: { length: number; edges: Link[] }[] }>(c, "trace", { from: { id: d }, to: { key: "github:org/gt#9" }, mode: "path", profile: "test" });
		expect(path.paths[0]).toMatchObject({ length: 3 });
		expect(path.paths[0]!.edges.map((l) => l.rel)).toEqual(["decided_because", "introduced_by", "part_of"]);
		const q = `gt-similar-${crypto.randomUUID()}`;
		await inProfile(c, "test", (sql) => { const seq = nextSeq(sql, "profile_meta"); seedNode(sql, seq, q, "document"); seedEdge(sql, seq, p, "relates_to", q, { basis: "similarity", score: 0.9 }); });
		const sim = await call<{ paths: { length: number; edges: Link[] }[] }>(c, "trace", { from: { id: d }, to: { id: q }, mode: "path", max_depth: 4 });
		expect(sim.paths[0]!.edges.map((l) => l.basis)).toEqual(["judgment", "judgment", "judgment", "similarity"]);
		expect(await outcome(c, "trace", { from: { id: d }, mode: "path" })).toMatchObject({ ok: false, error: { code: "validation" } });
	});

	it("lists dated events in a window, one node's history, and refuses a window over 90 days", async () => {
		const c = await contextFor();
		const { ids: [, , , d] } = await seed(c);
		const from = new Date(Date.now() - 3_600_000).toISOString(), to = new Date(Date.now() + 3_600_000).toISOString();
		const all = await call<{ read_set: string[]; events: { event: string; profile: string }[] }>(c, "timeline", { from, to, profile: "test" });
		expect(all.read_set).toEqual(["test", "me"]);
		expect(all.events.some((e) => e.event === "activity:knowledge" && e.profile === "test")).toBe(true);
		const decisions = await call<{ events: { targets: string[] }[] }>(c, "timeline", { from, to, profile: "test", kinds: ["decision"] });
		expect(decisions.events.length).toBeGreaterThan(0);
		expect(decisions.events.every((e) => e.targets.includes(d))).toBe(true);
		const one = await call<{ node: { id: string }; events: { event: string }[] }>(c, "timeline", { from, to, node: { id: d } });
		expect(one.node.id).toBe(d);
		expect(one.events.map((e) => e.event)).toEqual(expect.arrayContaining(["revision:saved", "link_recorded"]));
		expect(await outcome(c, "timeline", { from: "2026-01-01", to: "2026-06-01", profile: "test" })).toMatchObject({ ok: false, error: { code: "validation" } });
	});
});

describe("work budgets", () => {
	it("explore stops at 200 nodes per level and 5,000 edge rows, and says so", async () => {
		const c = await contextFor();
		const hub = `hub-${crypto.randomUUID()}`, wide = `wide-${crypto.randomUUID()}`;
		const out = await inProfile(c, "test", (sql) => {
			const seq = nextSeq(sql, "profile_meta");
			seedNode(sql, seq, hub);
			seedNode(sql, seq, wide);
			// hub: 150 local neighbours with 40 links each, 6,150 rows in all. wide: 260 links in one level.
			for (let i = 0; i < 150; i++) {
				const n = `${hub}-n${i}`;
				seedNode(sql, seq, n);
				seedEdge(sql, seq, hub, "relates_to", n);
				for (let j = 0; j < 40; j++) seedEdge(sql, seq, n, "relates_to", `${n}-leaf${j}`);
			}
			for (let i = 0; i < 260; i++) seedEdge(sql, seq, wide, "relates_to", `${wide}-x${i}`);
			const base = { kind: "explore" as const, known: [], maxEdges: EDGE_ROWS };
			return { deep: explore(sql, { ...base, node: { id: hub }, depth: 2 }), level: explore(sql, { ...base, node: { id: wide }, depth: 1 }) };
		});
		expect(out.deep.budget).toMatchObject({ limit: EDGE_ROWS, exhausted: true, stopped: "level 2 edges" });
		expect(out.deep.budget.edges_read).toBeLessThanOrEqual(EDGE_ROWS);
		expect(out.level.links).toHaveLength(LEVEL_NODES);
		expect(out.level.budget).toMatchObject({ exhausted: true, stopped: "level 1 nodes", skipped: 260 - LEVEL_NODES });
		// The path search crosses stores in the Worker and shares the same budget.
		const path = await call<{ paths: unknown[]; budget: { edges_read: number; exhausted: boolean } }>(c, "trace", { from: { id: hub }, to: { id: wide }, mode: "path", max_depth: 4 });
		expect(path.paths).toEqual([]);
		expect(path.budget.exhausted).toBe(true);
		expect(path.budget.edges_read).toBeLessThanOrEqual(EDGE_ROWS);
	});

	it("recall's expansion reads at most 1,000 edge rows and says so", async () => {
		const c = await contextFor();
		const seed = `seed-${crypto.randomUUID()}`;
		const out = await inProfile(c, "test", (sql) => {
			const seq = nextSeq(sql, "profile_meta");
			seedNode(sql, seq, seed);
			for (let i = 0; i < 1_100; i++) seedEdge(sql, seq, seed, "depends_on", `${seed}-d${i}`);
			return expandLinks(sql, [{ id: seed, score: 1 }]);
		});
		expect(out.budget).toMatchObject({ limit: EXPAND_ROWS, exhausted: true, stopped: "seed links" });
		expect(out.budget.edges_read).toBeLessThanOrEqual(EXPAND_ROWS);
	});
});

describe("links across profiles", () => {
	const setup = async () => {
		const c = await contextFor();
		const w = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "work", nodes: [{ kind: "ticket", key: `jira:XP-${Date.now()}`, name: "XP secret roadmap ticket" }] });
		const work = w.nodes[0]!.id;
		const note = await call(c, "save_memory", { name: `Cross link note ${crypto.randomUUID()}`, type: "reference", description: "links to work", content: "see the ticket", profile: "personal" });
		const edge = await inProfile(c, "personal", (sql) => {
			const seq = nextSeq(sql, "profile_meta");
			const id = seedEdge(sql, seq, note.memory_id as string, "relates_to", work, { dstProfile: "work" });
			sql.exec("INSERT INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'node', ?, 'the work ticket', ?)", `e:${id}`, work, seq);
			return id;
		});
		return { c, work, note: note.memory_id as string, edge };
	};

	it("the owner's explicit explore follows a link; without naming the profile it does not", async () => {
		const { c, work, note } = await setup();
		const plain = await call<Explore>(c, "explore", { node: { id: note } });
		expect(flat(plain)[0]!.to).toEqual({ id: work, profile: "work", readable: true });
		expect(JSON.stringify(plain)).not.toContain("XP secret");
		const named = await call<Explore>(c, "explore", { node: { id: note }, profiles: ["work"] });
		expect(flat(named)[0]!.to).toMatchObject({ id: work, profile: "work", name: "XP secret roadmap ticket", kind: "ticket" });
		expect(named.followed).toContain("work");
	});

	it("a scoped device token gets only {id, readable: false} on direct, linked and evidence reads", async () => {
		const { work, note } = await setup();
		const { token } = await deviceToken(`graph-personal-${crypto.randomUUID().slice(0, 8)}`, ["read"], ["personal", "me"], "personal");
		const device = await contextFor(devicePrincipal(token));
		const linked = await call<Explore>(device, "explore", { node: { id: note } });
		const link = flat(linked)[0]!;
		expect(link.to).toEqual({ id: work, readable: false });
		expect(link.evidence).toEqual([{ kind: "node", ref: work, readable: false }]);
		expect(JSON.stringify(linked)).not.toContain("XP secret");
		expect(await call(device, "explore", { node: { id: work } })).toEqual({ node: { id: work, readable: false } });
		expect(await call(device, "trace", { from: { id: work }, mode: "why" })).toMatchObject({ from: { id: work, readable: false }, chain: [] });
		expect(await call(device, "timeline", { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), node: { id: work } }))
			.toMatchObject({ node: { id: work, readable: false }, events: [] });
		expect(await outcome(device, "explore", { node: { id: note }, profiles: ["work"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});

	it("recall expands same-profile links as a graph channel, and never follows a link into another profile", async () => {
		const c = await contextFor();
		const n = await call(c, "save_memory", { name: "Zebra quartz harmonica", type: "feedback", description: "zebra quartz harmonica rule", content: "zebra quartz harmonica", profile: "personal" });
		const near = await call(c, "save_memory", { name: "Walrus counterpoint", type: "feedback", description: "a contrary rule", content: "walrus", profile: "personal" });
		const me = await call(c, "save_memory", { name: "Pelican lantern", type: "feedback", description: "a me rule", content: "pelican", profile: "me", company_free: true });
		await call(c, "record_knowledge", { profile: "personal", edges: [{ from: { id: near.memory_id }, rel: "contradicts", to: { id: n.memory_id }, reason: "says the opposite of it", evidence: [{ kind: "node", ref: n.memory_id }] }] });
		await inProfile(c, "personal", (sql) => { seedEdge(sql, nextSeq(sql, "profile_meta"), n.memory_id as string, "contradicts", me.memory_id as string, { dstProfile: "me" }); });
		type Recall = { results: { memory_id: string; profile: string; matched_by: string[]; via?: { from: string; rel: string } }[] };
		const r = await call<Recall>(c, "recall_memories", { keyword: "zebra quartz harmonica", profile: "personal" });
		expect(r.results.find((h) => h.memory_id === near.memory_id)).toMatchObject({ matched_by: ["graph"], via: { from: n.memory_id, rel: "contradicts" } });
		// The me record may match me's own channels (the test vectors collide), never personal's graph channel.
		expect(r.results.filter((h) => h.memory_id === me.memory_id).every((h) => h.profile === "me" && !h.matched_by.includes("graph"))).toBe(true);
		const expanded = await inProfile(c, "personal", (sql) => expandLinks(sql, [{ id: n.memory_id as string, score: 1 }]).neighbors.map((x) => x.id));
		expect(expanded).toContain(near.memory_id);
		expect(expanded).not.toContain(me.memory_id);
		const off = await call<Recall>(c, "recall_memories", { keyword: "zebra quartz harmonica", profile: "personal", expand: false });
		expect(off.results.map((h) => h.memory_id)).not.toContain(near.memory_id);
	});
});

describe("similarity stage", () => {
	it("after the settle time, links each card to up to 5 neighbours at cosine 0.85 or more, and ends the edges a changed card lost", async () => {
		const c = await contextFor();
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const who = { userId: ref.userId, profile: "test", generation: ref.generation };
		const tag = crypto.randomUUID().slice(0, 8), id = (n: string) => `sim-${tag}-${n}`;
		const unit = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
		// Angles to a: b 10° (0.98), c 20° (0.94), d 60° (0.5); e to h within 30° to fill past five.
		const angles: Record<string, number> = { a: 0, b: 10, c: 20, d: 60, e: 25, f: 27, g: 29, h: 30 };
		const vectors = new Map(Object.entries(angles).map(([k, v]) => [`g${ref.generation}:${id(k)}`, unit(v)]));
		const cos = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]!;
		const fake = {
			EMBEDDINGS: "on", AI: {},
			VECTORS: {
				getByIds: async (ids: string[]) => ids.filter((i) => vectors.has(i)).map((i) => ({ id: i, values: vectors.get(i)! })),
				query: async (v: number[], o: { topK: number }) => ({ matches: [...vectors].map(([i, x]) => ({ id: i, score: cos(v, x) })).sort((p, q) => q.score - p.score).slice(0, o.topK) }),
			},
		} as unknown as Env;
		const run = (storage: DurableObjectStorage, start: number) => (async () => {
			let t = start;
			for (let i = 0; i < 200; i++) { const next = await similarStep(storage, fake, who, t); if (next === null) return; t = Math.max(t, next); }
			throw new Error("similar did not settle");
		})();
		const edges = await inProfile(c, "test", async (sql, storage) => {
			const seq = nextSeq(sql, "profile_meta");
			for (const k of Object.keys(angles)) seedNode(sql, seq, id(k), "document", { type: "reference" });
			expect(await similarStep(storage, fake, who, Date.now())).toBeGreaterThan(Date.now());
			await run(storage, Date.now() + SETTLE_MS);
			return sql.exec<{ dst: string; score: number; basis: string }>("SELECT dst, score, basis FROM edges WHERE src = ? AND basis = 'similarity' AND ended_at IS NULL ORDER BY score DESC", id("a")).toArray();
		});
		expect(edges.length).toBe(5);
		expect(edges.every((e) => e.score >= 0.85 && e.basis === "similarity")).toBe(true);
		expect(edges.map((e) => e.dst)).not.toContain(id("d"));
		// a's card changes (re-embedded far away): its old similarity edges end, and history keeps them.
		vectors.set(`g${ref.generation}:${id("a")}`, unit(180));
		const after = await inProfile(c, "test", async (sql, storage) => {
			sql.exec("UPDATE nodes SET seq = ? WHERE id = ?", nextSeq(sql, "profile_meta"), id("a"));
			await run(storage, Date.now() + 3 * SETTLE_MS);
			return {
				current: sql.exec<{ n: number }>("SELECT count(*) AS n FROM edges WHERE src = ? AND basis = 'similarity' AND ended_at IS NULL", id("a")).one().n,
				ended: sql.exec<{ n: number }>("SELECT count(*) AS n FROM edges WHERE src = ? AND basis = 'similarity' AND ended_at IS NOT NULL AND valid_to = ended_at AND valid_from = recorded_at", id("a")).one().n,
			};
		});
		expect(after).toEqual({ current: 0, ended: 5 });
	});
});

// The six findings of the 2026-10-29 graph review (/tmp/c3-review-repros.test.ts), kept as regressions.
describe("review regressions", () => {
	const node = (sql: SqlStorage, seq: number, id: string) => sql.exec(`INSERT INTO nodes (id, kind, name, norm_name, status, origin, content_hash, card_hash, embed_hash, recorded_at, created_at, updated_at, seq)
		VALUES (?, 'document', ?, ?, 'active', 'agent', 'h', 'c', 'c', '2026-01-01', '2026-01-01', '2026-01-01', ?)`, id, id, id, seq);
	const vecFake = (c: Ctx, vectors: Map<string, number[]>) => ({ EMBEDDINGS: "on", AI: {}, VECTORS: {
		getByIds: async (ids: string[]) => ids.filter((i) => vectors.has(i)).map((i) => ({ id: i, values: vectors.get(i)! })),
		query: async (v: number[], o: { topK: number }) => ({ matches: [...vectors].map(([i, x]) => ({ id: i, score: v[0]! * x[0]! + v[1]! * x[1]! })).sort((a, b) => b.score - a.score).slice(0, o.topK) }),
	} }) as unknown as Env;
	const who = (c: Ctx) => { const r = c.account.profiles.find((p) => p.profile === "test")!; return { userId: r.userId, profile: "test", generation: r.generation }; };
	const settle = async (storage: DurableObjectStorage, e: Env, c: Ctx, start: number) => {
		let t = start;
		for (let i = 0; i < 500; i++) { const next = await similarStep(storage, e, who(c), t); if (next === null) return; t = Math.max(t, next); }
		throw new Error("similar did not settle");
	};
	const current = (sql: SqlStorage, a: string, b: string) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM edges WHERE src = ? AND dst = ? AND basis = 'similarity' AND ended_at IS NULL", a, b).one().n;

	it("G1: the edge budget bounds the rows SQLite reads, ended history included", async () => {
		const c = await contextFor();
		const a = `g1-${crypto.randomUUID()}`;
		const got = await inProfile(c, "test", (sql) => {
			const seq = nextSeq(sql, "profile_meta");
			node(sql, seq, a);
			for (let i = 0; i < 5_100; i++) sql.exec("INSERT INTO edges (src, rel, dst, dst_profile, basis, recorded_at, ended_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'identifier', '2026-01-01', '2026-02-01', 'index', ?)", a, `${a}-${i}`, seq);
			// SQLite's own count of the rows each edge query read, taken once the query has been consumed.
			const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
			const tracked = { exec: (q: string, ...p: SqlStorageValue[]) => { const cur = sql.exec(q, ...p); if (q.startsWith("SELECT id, src") || q.startsWith("SELECT id FROM nodes WHERE id IN")) cursors.push(cur); return cur; } } as SqlStorage;
			const result = explore(tracked, { kind: "explore", node: { id: a }, depth: 1, known: [], maxEdges: EDGE_ROWS });
			return { scanned: cursors.reduce((n, cur) => n + cur.rowsRead, 0), result };
		});
		expect(got.result.links).toEqual([]);
		expect(got.result.budget).toMatchObject({ exhausted: true, stopped: "level 1 edges" });
		expect(got.scanned).toBeLessThanOrEqual(EDGE_ROWS);
		expect(got.result.budget.edges_read).toBe(got.scanned);
	});

	it("G2: trace path joins links stored in two explicitly followed profiles", async () => {
		const c = await contextFor(), tag = crypto.randomUUID();
		const a = (await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "test", nodes: [{ kind: "ticket", key: `jira:GA-${tag}`, name: `start ${tag}` }] })).nodes[0]!.id;
		const [b, d] = (await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "personal", nodes: [{ kind: "ticket", key: `jira:GB-${tag}`, name: `middle ${tag}` }, { kind: "ticket", key: `jira:GC-${tag}`, name: `end ${tag}` }] })).nodes.map((n) => n.id) as [string, string];
		await inProfile(c, "test", (sql) => { seedEdge(sql, nextSeq(sql, "profile_meta"), a, "relates_to", b, { dstProfile: "personal" }); });
		await inProfile(c, "personal", (sql) => { seedEdge(sql, nextSeq(sql, "profile_meta"), b, "relates_to", d); });
		type Path = { paths: { length: number; edges: Link[] }[] };
		const got = await call<Path>(c, "trace", { from: { id: a }, to: { id: d }, mode: "path", profiles: ["personal"], max_depth: 3 });
		expect(got.paths).toHaveLength(1);
		expect(got.paths[0]!.edges.map((l) => [l.from.id, l.to.id])).toEqual([[a, b], [b, d]]);
		expect(got.paths[0]!.edges[1]!.to).toMatchObject({ id: d, name: `end ${tag}` });
		// Without naming personal, its links are not read, so the path is not found.
		const closed = await call<Path & { followed: string[] }>(c, "trace", { from: { id: a }, to: { id: d }, mode: "path", max_depth: 3 });
		expect(closed.paths).toEqual([]);
		expect(closed.followed).not.toContain("personal");
	});

	it("G3: a vector not visible yet is retried later, and other cards are not held back", async () => {
		const base = await contextFor();
		// This stage fixture must not share a generation with transfer tests that close the owner's test profile.
		const c = { ...base, account: { ...base.account, profiles: base.account.profiles.map((p) => p.profile === "test" ? { ...p, generation: crypto.randomUUID().slice(0, 8) } : p) } };
		const prefix = `g${who(c).generation}:`, a = `g3a-${crypto.randomUUID()}`, b = `g3b-${crypto.randomUUID()}`;
		const vectors = new Map<string, number[]>(), e = vecFake(c, vectors);
		const linked = await inProfile(c, "test", async (sql, storage) => {
			const seq = nextSeq(sql, "profile_meta");
			node(sql, seq, a);
			node(sql, seq, b);
			await settle(storage, e, c, Date.now());
			vectors.set(prefix + a, [1, 0]);
			vectors.set(prefix + b, [1, 0]);
			await settle(storage, e, c, Date.now() + 10 * SETTLE_MS);
			return current(sql, a, b);
		});
		expect(linked).toBe(1);
	});

	it("G4: a changed card ends the similarity links into it as well as out of it", async () => {
		const c = await contextFor(), prefix = `g${who(c).generation}:`, a = `g4a-${crypto.randomUUID()}`, b = `g4b-${crypto.randomUUID()}`;
		const vectors = new Map([[prefix + a, [1, 0]], [prefix + b, [1, 0]]]), e = vecFake(c, vectors);
		const left = await inProfile(c, "test", async (sql, storage) => {
			const seq = nextSeq(sql, "profile_meta");
			node(sql, seq, a);
			node(sql, seq, b);
			await settle(storage, e, c, Date.now());
			expect([current(sql, a, b), current(sql, b, a)]).toEqual([1, 1]);
			vectors.set(prefix + a, [-1, 0]);
			sql.exec("UPDATE nodes SET seq = ? WHERE id = ?", nextSeq(sql, "profile_meta"), a);
			await settle(storage, e, c, Date.now() + 4 * SETTLE_MS);
			return sql.exec("SELECT src, dst FROM edges WHERE (src = ? OR dst = ?) AND basis = 'similarity' AND ended_at IS NULL", a, a).toArray();
		});
		expect(left).toEqual([]);
	});

	it("G5: as_of after a link ended does not return it", async () => {
		const c = await contextFor(), a = `g5a-${crypto.randomUUID()}`, b = `g5b-${crypto.randomUUID()}`;
		const got = await inProfile(c, "test", (sql) => {
			const seq = nextSeq(sql, "profile_meta");
			node(sql, seq, a);
			node(sql, seq, b);
			sql.exec("INSERT INTO edges (src, rel, dst, dst_profile, basis, score, recorded_at, ended_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'similarity', 0.99, '2026-01-01', '2026-02-01', 'index', ?)", a, b, seq);
			const at = (asOf: string) => explore(sql, { kind: "explore", node: { id: a }, depth: 1, known: [], maxEdges: EDGE_ROWS, asOf }).links.length;
			return { during: at("2026-01-15T00:00:00.000Z"), after: at("2026-03-01T00:00:00.000Z") };
		});
		expect(got).toEqual({ during: 1, after: 0 });
	});

	it("G6: a mention written before its entity links once the entity arrives, with the entity's own kind", async () => {
		const c = await contextFor(), key = `LATE-${Math.floor(Math.random() * 9_000_000) + 1_000}`;
		const note = await call(c, "save_memory", { profile: "test", type: "reference", name: `late ${key}`, description: key, content: `investigate ${key}` });
		const before = await inProfile(c, "test", (sql) => ({
			nodes: sql.exec<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE key = ?", `jira:${key}`).one().n,
			mentions: sql.exec<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE kind = 'mention' AND ref = ?", `jira:${key}`).one().n,
		}));
		expect(before).toEqual({ nodes: 0, mentions: 1 });
		const bug = await call<{ nodes: { id: string }[] }>(c, "record_knowledge", { profile: "test", nodes: [{ kind: "bug", key: `jira:${key}`, name: `actual bug ${key}` }] });
		const got = await call<Explore>(c, "explore", { node: { id: note.memory_id } });
		expect(flat(got)).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "relates_to", basis: "identifier", to: expect.objectContaining({ id: bug.nodes[0]!.id, kind: "bug" }) })]));
		expect(await inProfile(c, "test", (sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE kind = 'mention' AND ref = ?", `jira:${key}`).one().n)).toBe(0);
	});
});

// G6 closure review (/tmp/c3-closure-review-report.txt): resolving waiting mentions must stay inside the 1,000-row write bound by
// the rows Workers SQLite really writes, keep what does not fit, and run in a budgeted transaction when capture uploads a session.
describe("G6 closure: mention resolution inside the write bound", () => {
	const wait = (sql: SqlStorage, key: string, n: number) => {
		const seq = nextSeq(sql, "profile_meta");
		for (let i = 0; i < n; i++) sql.exec("INSERT INTO evidence (owner, kind, ref, seq) VALUES (?, 'mention', ?, ?)", `n:src-${key}-${i}`, key, seq);
	};
	const state = (sql: SqlStorage, key: string) => ({
		waiting: sql.exec<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE kind = 'mention' AND ref = ?", key).one().n,
		edges: sql.exec<{ n: number }>("SELECT count(*) AS n FROM edges WHERE basis = 'identifier' AND dst = (SELECT id FROM nodes WHERE key = ?)", key).one().n,
	});
	/** The reviewer's probe: a transaction counting rowsWritten (or not at all), refusing past 1,000 rows. */
	const probe = (c: Ctx, n: number, counted: boolean) => inProfile(c, "test", (sql, storage) => {
		const key = `jira:PROBE-${crypto.randomUUID()}`, target = `target-${key}`;
		wait(sql, key, n);
		let writes = 0, error: string | null = null, linked = 0;
		const tx: TxLike = { sql, seq: nextSeq(sql, "profile_meta"), now: new Date().toISOString(), requestId: null, ctx: { actor: "upload" }, rows: 0,
			run(q, ...p) { const r = sql.exec(q, ...p); writes += r.rowsWritten; if (counted) { this.rows += r.rowsWritten; if (this.rows > 1_000) throw new Error("size_budget"); } return r; } };
		try { storage.transactionSync(() => { linked = resolveMentions(tx, target, key).linked; }); } catch (e) { error = (e as Error).message; }
		return { error, writes, linked, waiting: sql.exec<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE kind = 'mention' AND ref = ?", key).one().n,
			edges: sql.exec<{ n: number }>("SELECT count(*) AS n FROM edges WHERE dst = ?", target).one().n };
	});

	it("150 waiting mentions under a counted transaction: what fits resolves, at most 1,000 rows, the rest kept", async () => {
		const got = await probe(await contextFor(), 150, true);
		expect(got.error).toBeNull();
		expect(got.writes).toBeLessThanOrEqual(1_000);
		expect(got.linked).toBeGreaterThan(0);
		expect(got).toMatchObject({ edges: got.linked, waiting: 150 - got.linked });
	});

	it("400 waiting mentions under a counter that never moves: still at most 1,000 rows, the rest kept", async () => {
		const got = await probe(await contextFor(), 400, false);
		expect(got.writes).toBeLessThanOrEqual(1_000);
		expect(got).toMatchObject({ error: null, edges: got.linked, waiting: 400 - got.linked });
	});

	it("record_knowledge writes the entity with 150 mentions waiting, names the key still waiting, and its next write resolves the rest", async () => {
		const c = await contextFor(), key = `jira:BND-${Math.floor(Math.random() * 9_000_000) + 1_000}`;
		await inProfile(c, "test", (sql) => wait(sql, key, 150));
		const first = await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "bug", key, name: `bounded ${key}` }] });
		expect(first.mentions_waiting).toEqual([key]);
		const mid = await inProfile(c, "test", (sql) => state(sql, key));
		expect(mid.edges).toBeGreaterThan(0);
		expect(mid.edges + mid.waiting).toBe(150);
		const second = await call(c, "record_knowledge", { profile: "test", nodes: [{ kind: "bug", key, name: `bounded ${key}` }] });
		expect(second.mentions_waiting).toBeUndefined();
		expect(await inProfile(c, "test", (sql) => state(sql, key))).toEqual({ waiting: 0, edges: 150 });
	});

	it("a session upload links the session's earlier mentions in budgeted steps, each at most 1,000 rows", async () => {
		const c = await contextFor(), id = `thr_g6_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, key = `session:codex:${id}`;
		const note = await call(c, "save_memory", { profile: "test", type: "reference", name: `follow ${id}`, description: "a session to read", content: `see ${key} for the digest` });
		await inProfile(c, "test", (sql) => wait(sql, key, 400));
		const { token } = await deviceToken(`g6-capture-${id.slice(-6)}`, ["ingest"], ["test"], "test");
		const body = JSON.stringify({ asks: [{ text: "Bound the resolver", pos: 1 }], decisions: [], corrections: [], outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
		const upload = async () => {
			const res = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ session: { client: "codex", id }, digests: [{ range_id: `codex:${id}:0a1b2c3d:0-5000`, capture_status: "heuristic", part_id: "-", sha256: sha256(body), body }] }) }));
			expect(res.status).toBe(200);
			return inProfile(c, "test", (sql) => state(sql, key));
		};
		const first = await upload();
		// Each resolution writes eight rows, so more than 125 links would mean one transaction past 1,000 rows.
		expect(first.edges).toBeLessThanOrEqual(125);
		expect(first.edges).toBeGreaterThan(0);
		expect(first.waiting).toBeGreaterThan(0);
		expect(first.edges + first.waiting).toBe(401);
		let now = first;
		for (let i = 0; i < 6 && now.waiting; i++) now = await upload();
		expect(now).toEqual({ waiting: 0, edges: 401 });
		const linked = await call<Explore>(c, "explore", { node: { id: note.memory_id } });
		expect(flat(linked)).toEqual(expect.arrayContaining([expect.objectContaining({ basis: "identifier", to: expect.objectContaining({ kind: "session", key }) })]));
		// The helper capture uses reports each transaction's real rows.
		const again = await inProfile(c, "test", (sql, storage) => { wait(sql, key, 300); return resolveMentionsAlone(storage, key, "upload"); });
		expect(again!.rows).toBeLessThanOrEqual(1_000);
		expect(again!.left).toBe(true);
	});
});


describe("published graph payloads and instant dates", () => {
	it("keeps hidden source reasons and evidence out of every shared graph reader", async () => {
		const c = await contextFor();
		await inProfile(c, "personal", (sql) => {
			const seq = nextSeq(sql, "profile_meta"), root = crypto.randomUUID();
			seedNode(sql, seq, root, "project");
			const hidden: number[] = [], allowed: number[] = [], published: string[] = [];
			for (const status of ["candidate", "dismissed", "incoming", "moving", "moved", "active", "retired", "superseded"]) {
				const id = crypto.randomUUID(); seedNode(sql, seq, id, "component");
				sql.exec("UPDATE nodes SET status = ? WHERE id = ?", status, id);
				const edge = seedEdge(sql, seq, id, "part_of", root);
				sql.exec("INSERT INTO evidence (owner,kind,ref,seq) VALUES (?,'file',?,?)", `e:${edge}`, status, seq);
				(["active", "retired", "superseded"].includes(status) ? allowed : hidden).push(edge);
				if (["active", "retired", "superseded"].includes(status)) published.push(id);
				sql.exec("INSERT INTO revisions(node_id,revision,op,snapshot,actor,at,seq) VALUES (?,1,'saved','{}','migration','2026-10-29T13:00:00+02:00',?)",id,seq);
			}
			const absent = seedEdge(sql, seq, root, "relates_to", "absent-target");
			const moved = crypto.randomUUID(); seedNode(sql,seq,moved); sql.exec("UPDATE nodes SET status='moved' WHERE id=?",moved);
			const opaque = seedEdge(sql,seq,root,"relates_to",moved);
			const ex = explore(sql, {kind:"explore",node:{id:root},depth:1,known:[],maxEdges:5000});
			expect(ex.links.map(e=>e.id).sort()).toEqual([...allowed,absent,opaque].sort());
			expect(ex.foreign).toEqual(expect.arrayContaining(["absent-target",moved]));
			expect(ex.nodes[moved]).toBeUndefined();
			const detail = trace(sql, {kind:"trace",mode:"detail",nodes:[root],edges:[...hidden,...allowed],known:[],maxEdges:5000});
			expect(detail.links!.map(e=>e.id).sort()).toEqual(allowed.sort());
			const step = trace(sql, {kind:"trace",mode:"step",ids:[root],similarity:true,known:[],maxEdges:5000});
			expect(step.edges!.map(e=>e.id).sort()).toEqual([...allowed,absent,opaque].sort());
			const expanded = expandLinks(sql,[{id:root,score:1}]);
			expect(expanded.neighbors).toHaveLength(allowed.length);
			const tl = timeline(sql, {kind:"timeline",node:{id:root},from:"2000-01-01",to:"2099-01-01",known:[],limit:100});
			expect(tl.events.map(e=>e.edge_id).sort()).toEqual([...allowed,absent,opaque].sort());
			const global=timeline(sql,{kind:"timeline",from:"2026-10-29T10:00:00Z",to:"2026-10-29T12:00:00Z",known:[],limit:100});
			expect(global.events.map(e=>e.node_id).sort()).toEqual(published.sort());
		});
	});

	it("compares offset validity as instants with inclusive start and exclusive end", async () => {
		const c = await contextFor();
		await inProfile(c, "personal", (sql) => {
			const seq = nextSeq(sql,"profile_meta"), root=crypto.randomUUID(); seedNode(sql,seq,root);
			const edges = ["future","expired","start","end","ended"].map(()=>{
				const id=crypto.randomUUID();seedNode(sql,seq,id);return seedEdge(sql,seq,root,"relates_to",id);
			});
			sql.exec("UPDATE edges SET valid_from='2026-10-29T11:30:00-02:00' WHERE id=?",edges[0]!);
			sql.exec("UPDATE edges SET valid_to='2026-10-29T13:30:00+02:00' WHERE id=?",edges[1]!);
			sql.exec("UPDATE edges SET valid_from='2026-10-29T14:00:00+02:00' WHERE id=?",edges[2]!);
			sql.exec("UPDATE edges SET valid_to='2026-10-29T14:00:00+02:00' WHERE id=?",edges[3]!);
			sql.exec("UPDATE edges SET ended_at='2026-10-29T13:30:00+02:00' WHERE id=?",edges[4]!);
			const ex=explore(sql,{kind:"explore",node:{id:root},depth:1,known:[],maxEdges:5000,asOf:"2026-10-29T12:00:00.000Z"});
			expect(ex.links.map(e=>e.id)).toEqual([edges[2]]);
		});
	});

	it("orders offset revisions, entries and link events before timeline limits", async () => {
		const c=await contextFor();
		await inProfile(c,"personal",sql=>{
			const seq=nextSeq(sql,"profile_meta"),root=crypto.randomUUID();seedNode(sql,seq,root);
			for(const [revision,at] of [[1,"2026-10-29T11:45:00Z"],[2,"2026-10-29T13:00:00+02:00"]] as const)
				sql.exec("INSERT INTO revisions(node_id,revision,op,snapshot,actor,at,seq) VALUES (?,?,'saved','{}','migration',?,?)",root,revision,at,seq);
			sql.exec("INSERT INTO texts(node_id,part,revision,chunk,body,actor,created_at,seq_no,seq) VALUES (?,'entry',3,0,'entry','test','2026-10-29T09:15:00-02:00',1,?)",root,seq);
			const end = seedEdge(sql,seq,root,"relates_to","missing");
			sql.exec("UPDATE edges SET recorded_at='2026-10-28T00:00:00Z', ended_at='2026-10-29T13:30:00+02:00' WHERE id=?",end);
			const q={kind:"timeline" as const,node:{id:root},from:"2026-10-29T10:00:00Z",to:"2026-10-29T12:00:00Z",known:[],limit:2};
			const tl=timeline(sql,q);
			expect(tl.events.map(e=>[e.event,e.at])).toEqual([["revision:saved","2026-10-29T13:00:00+02:00"],["entry","2026-10-29T09:15:00-02:00"]]);
			expect(tl.truncated).toBe(true);
			const all=timeline(sql,{...q,limit:10});
			expect(all.events.map(e=>e.event)).toEqual(["revision:saved","entry","link_ended","revision:saved"]);
			expect(all.truncated).toBe(false);
			const global=timeline(sql,{...q,node:undefined,limit:1});
			expect(global.events[0]!.at).toBe("2026-10-29T13:00:00+02:00");expect(global.truncated).toBe(true);
		});
	});
});


describe("shared reader preload and merged timeline corrections", () => {
const from="2026-10-29T10:00:00Z", to="2026-10-29T12:00:00Z";
it("public MCP timeline orders a node's raw offset dates by instant",async()=>{
 const c=await contextFor(); const n=(await call<{nodes:{id:string}[]}>(c,"record_knowledge",{profile:"personal",nodes:[{kind:"project",key:`project:${crypto.randomUUID()}`,name:"Synthetic offset timeline node"}]})).nodes[0]!.id;
 await inProfile(c,"personal",sql=>{
  const seq=nextSeq(sql,"profile_meta");
  sql.exec("DELETE FROM revisions WHERE node_id=?",n);
  for(const [rev,at] of [[1,"2026-10-29T13:00:00+02:00"],[2,"2026-10-29T11:45:00Z"]] as const)
   sql.exec("INSERT INTO revisions(node_id,revision,op,snapshot,actor,at,seq) VALUES (?,?,'saved','{}','migration',?,?)",n,rev,at,seq);
 });
 const got=await call<{events:{at:string}[]}>(c,"timeline",{node:{id:n},from,to,limit:2});
 console.log("public-node-instant-observation",JSON.stringify(got));
 expect(got.events.map(e=>e.at)).toEqual(["2026-10-29T13:00:00+02:00","2026-10-29T11:45:00Z"]);
});

it("public MCP timeline applies its final cross-profile limit by instant",async()=>{
 const c=await contextFor(), ids: Record<string,string> = {};
 const dayFrom=from.replace("10-29","10-28"), dayTo=to.replace("10-29","10-28");
 for(const [profile,at] of [["personal","2026-10-28T13:00:00+02:00"],["me","2026-10-28T11:30:00Z"]] as const){
  const n=(await call<{nodes:{id:string}[]}>(c,"record_knowledge",{profile,nodes:[{kind:"project",key:`project:${crypto.randomUUID()}`,name:"Synthetic merged offset timeline"}]})).nodes[0]!.id;
  ids[profile]=n;
  await inProfile(c,profile,sql=>{const seq=nextSeq(sql,"profile_meta");sql.exec("DELETE FROM revisions WHERE node_id=?",n);sql.exec("INSERT INTO revisions(node_id,revision,op,snapshot,actor,at,seq) VALUES (?,1,'saved','{}','migration',?,?)",n,at,seq);});
 }
 const got=await call<{events:{at:string}[]}>(c,"timeline",{profile:"personal",from:dayFrom,to:dayTo,limit:1});
 console.log("public-merged-instant-observation",JSON.stringify(got));
 expect(got.events.map(e=>e.at)).toEqual(["2026-10-28T13:00:00+02:00"]);
 await inProfile(c,"me",sql=>{sql.exec("UPDATE revisions SET at='2026-10-28T11:00:00Z' WHERE node_id=?",ids.me!);});
 const tied=await call<{events:{at:string;profile:string}[];from:string;to:string;truncated:boolean}>(c,"timeline",{profile:"personal",from:dayFrom,to:dayTo,limit:2});
 expect(tied.events.map(e=>[e.profile,e.at])).toEqual([["personal","2026-10-28T13:00:00+02:00"],["me","2026-10-28T11:00:00Z"]]);
 expect(tied).toMatchObject({from:"2026-10-28T10:00:00.000Z",to:"2026-10-28T12:00:00.000Z",truncated:false});
});

it("payload SQL gates hidden sources before selecting reasons",async()=>{
 const c=await contextFor();
 await inProfile(c,"personal",sql=>{
  const root=crypto.randomUUID(),id=crypto.randomUUID(), seq=nextSeq(sql,"profile_meta");
  for(const [n,status] of [[root,"active"],[id,"candidate"]])
   sql.exec("INSERT INTO nodes(id,kind,name,norm_name,status,origin,content_hash,card_hash,embed_hash,recorded_at,created_at,updated_at,seq) VALUES (?,'project',?,?,?,'agent','h','c','c',?,?,?,?)",n,n,n,status,from,from,from,seq);
  const edge=Number(sql.exec("INSERT INTO edges(src,rel,dst,dst_profile,basis,reason,recorded_at,actor,seq) VALUES (?,'relates_to',?,'','judgment','PRIVATE_REASON_REVIEW',?,'test',?) RETURNING id",id,root,from,seq).one().id);
  const observations:{query:string;params:unknown[];hiddenPayloadRead:boolean}[]=[];
  const traced={exec(q:string,...p:SqlStorageValue[]){
   const cur=sql.exec(q,...p);const rows=cur.toArray();observations.push({query:q,params:p,hiddenPayloadRead:rows.some(r=>r.reason==="PRIVATE_REASON_REVIEW")});
   return {toArray:()=>rows,rowsRead:cur.rowsRead,rowsWritten:cur.rowsWritten,one:()=>rows[0]};
  }} as unknown as SqlStorage;
  const ex=explore(traced,{kind:"explore",node:{id:root},depth:1,known:[],maxEdges:5000});
  const detail=trace(traced,{kind:"trace",mode:"detail",nodes:[root],edges:[edge],known:[],maxEdges:5000});
  console.log("payload-sql-observation",JSON.stringify({observations,ex,detail}));
  expect(observations.filter(o=>o.hiddenPayloadRead)).toEqual([]);
 });
});


});
