// Repo facts (#92-#95) through the real Worker routes, store and write path: the /v1/ingest facts branch (device ingest token),
// /v1/facts (read token), the owner list and the existing owner actions. Synthetic repos and sessions only; owner tokens are signed
// with a test key, as in mcp-auth.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCache } from "../src/auth";
import { requestHash, sha256 } from "../src/domain/ids";
import type { WriteContext } from "../src/domain/types";
import { accountStub } from "../src/mcp";
import { archiveCursor, archiveOperation, runArchive, type ArchiveCommand } from "../src/profile/archive-operations";
import { housekeep } from "../src/profile/housekeeping";
import { EMBED_MODEL, namespaceOf, vectorId } from "../src/profile/index";
import { similarStep, SETTLE_MS } from "../src/profile/similar";
import type { Who } from "../src/profile/write";
import { call, contextFor, deviceToken, OWNER, outcome } from "./helpers";
import browserMcp from "./fixtures/repo-facts/agent360dk__browser-mcp/expected-facts.json";
import agentMemory from "./fixtures/repo-facts/wrick17__agent-memory/expected-facts.json";
import bettergit from "./fixtures/repo-facts/wrick17__bettergit/expected-facts.json";
import postplan from "./fixtures/repo-facts/wrick17__postplan/expected-facts.json";

const origin = new URL(env.RESOURCE_URL).origin;
const hex = (s: string, n: number) => sha256(s).slice(0, n);
const keyOf = (literal: string, detector = "command_repair") => hex(`${detector}\n${literal}`, 16);
const familyOf = (literal: string) => hex(`family:${literal}`, 16);
const session = () => `codex:${hex(crypto.randomUUID(), 12)}`;
const sessions = (n: number) => Array.from({ length: n }, session);
const newRepo = () => `github.com/acme/r-${crypto.randomUUID().slice(0, 8)}`;
const obs = (literal: string, kind: "confirm" | "contradict" | "propose", extra: Record<string, unknown> = {}) =>
	({ fact_key: keyOf(literal), kind, detector: "command_repair", statement: `Run \`${literal}\` instead of the failing variant`, literal, family: familyOf(literal), ...extra });

type Reply = { status: number; data: Record<string, any> };
async function http(method: string, path: string, token: string, body?: unknown): Promise<Reply> {
	const res = await exports.default.fetch(new Request(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
	return { status: res.status, data: await res.json() as Record<string, any> };
}
const report = (token: string, remote: string, facts: Record<string, unknown>, extra: Record<string, unknown> = {}) => http("POST", "/v1/ingest", token, { repo: { remote }, ...extra, facts });
const result = (r: Reply, literal: string) => (r.data.report.facts as { fact_key: string }[]).find((f) => f.fact_key === keyOf(literal)) as Record<string, any>;
const inject = async (token: string, remote: string) => {
	const r = await http("POST", "/v1/facts", token, { repo: { remote } });
	expect(r.status).toBe(200);
	return (r.data.facts as { fact_key: string }[]).map((f) => f.fact_key);
};
/** Three pairwise-disjoint confirming sessions of one device: the fewest that activate a fact. */
async function activate(token: string, remote: string, literals: string[], families: string[] = []) {
	const s = sessions(3);
	for (let i = 0; i < 3; i++) {
		const r = await report(token, remote, { session: s[i], families, observations: literals.map((l) => obs(l, "confirm", { disjoint_from: s.slice(0, i) })) });
		expect(r.status).toBe(200);
	}
	return s;
}

// Owner tokens signed with a test key, served through a mocked JWKS (mcp-auth.test.ts).
let keys: CryptoKeyPair;
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function ownerToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const signing = `${enc({ alg: "RS256", typ: "JWT", kid: "facts-key" })}.${enc({ iss: env.CLERK_ISSUER, sub: env.OWNER_USER_ID, aud: [env.RESOURCE_URL], scope: "memory", iat: now, nbf: now, exp: now + 3600 })}`;
	return `${signing}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signing)))}`;
}
beforeAll(async () => {
	keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
});
const original = globalThis.fetch;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === `${env.CLERK_FRONTEND_API}/.well-known/jwks.json`) return Response.json({ keys: [{ ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "facts-key", alg: "RS256", use: "sig" }] });
		return original(input);
	});
});
afterEach(() => { vi.restoreAllMocks(); resetKeyCache(); });
const owner = async (method: string, path: string, body?: unknown) => http(method, path, await ownerToken(), body);
const listed = async (remote: string, profile = "test") => {
	const r = await owner("GET", `/api/profiles/${profile}/facts?repo_key=${encodeURIComponent(remote)}`);
	expect(r.status).toBe(200);
	return r.data.facts as Record<string, any>[];
};
const listedOne = async (remote: string, literal: string) => (await listed(remote)).find((f) => f.fact_key === keyOf(literal));

const tokens = async () => ({
	job: (await deviceToken(`facts-job-${crypto.randomUUID().slice(0, 6)}`, ["ingest"], ["test"], "test")).token,
	reader: (await deviceToken(`facts-read-${crypto.randomUUID().slice(0, 6)}`, ["read"], ["test"], "test")).token,
});
const whoOf = async (profile: string): Promise<Who> => {
	const r = await accountStub(env, OWNER).admin({ op: "listProfiles" });
	if (!r.ok) throw new Error(r.error.message);
	return { userId: OWNER, profile, generation: (r.value as { name: string; generation: string }[]).find((p) => p.name === profile)!.generation };
};
const inProfile = async <T,>(profile: string, f: (storage: DurableObjectStorage, who: Who) => T | Promise<T>) => {
	const who = await whoOf(profile);
	return runInDurableObject(env.PROFILE.get(env.PROFILE.idFromName(`${OWNER}:${profile}:${who.generation}`)), (_i, state) => f(state.storage, who));
};

describe("fact lifecycle (#92)", () => {
	it("starts a chain at the first confirm and activates on the third pairwise-disjoint session of one device", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "python -m pytest -q", [s1, s2, s3] = sessions(3);
		let r = await report(job, repo, { session: s1, observations: [obs(L, "confirm")] });
		expect(r).toMatchObject({ status: 200, data: { profile: "test", repo_key: repo, report: { action: "stored" } } });
		expect(result(r, L)).toMatchObject({ status: "stored", state: "candidate", chain: 1 });
		r = await report(job, repo, { session: s2, observations: [obs(L, "confirm", { disjoint_from: [s1] })] });
		expect(result(r, L)).toMatchObject({ state: "candidate", chain: 2 });
		r = await report(job, repo, { session: s3, observations: [obs(L, "confirm", { disjoint_from: [s1, s2] })] });
		expect(result(r, L)).toMatchObject({ state: "active", chain: 3 });
		expect(await listedOne(repo, L)).toMatchObject({ state: "active", status: "active", chain: 3, statement: obs(L, "confirm").statement, literal: L, detector: "command_repair",
			evidence: [s1, s2, s3].map((ref) => ({ kind: "session", ref, note: "confirm" })) });
	});

	it("restarts the chain on overlapping or unknown history and never reuses proof the server does not hold", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "npm run build", s = sessions(6);
		const chainAfter = async (i: number, disjoint?: string[]) =>
			result(await report(job, repo, { session: s[i], observations: [obs(L, "confirm", disjoint ? { disjoint_from: disjoint } : {})] }), L);
		expect(await chainAfter(0, [])).toMatchObject({ chain: 1 });
		expect(await chainAfter(1)).toMatchObject({ chain: 1, state: "candidate" }); // overlap or unknown: only this session counts
		expect(await chainAfter(2, [s[0]!])).toMatchObject({ chain: 1 }); // s0 left the chain; the ledger's claim cannot restore it
		expect(await chainAfter(3, [s[2]!])).toMatchObject({ chain: 2 });
		expect(await chainAfter(4, [s[3]!])).toMatchObject({ chain: 2, state: "candidate" }); // overlaps s2: s2 drops, s3 stays
		expect(await chainAfter(5, [s[3]!, s[4]!])).toMatchObject({ chain: 3, state: "active" });
	});

	it("does not pool confirmations from different devices", async () => {
		const a = (await tokens()).job, b = (await tokens()).job, repo = newRepo(), L = "make lint", s = sessions(5);
		const send = (token: string, i: number, disjoint: string[]) => report(token, repo, { session: s[i], observations: [obs(L, "confirm", { disjoint_from: disjoint })] });
		await send(a, 0, []);
		expect(result(await send(b, 1, [s[0]!]), L)).toMatchObject({ chain: 1, state: "candidate" });
		expect(result(await send(a, 2, [s[0]!, s[1]!]), L)).toMatchObject({ chain: 2, state: "candidate" });
		expect(result(await send(b, 3, [s[0]!, s[1]!, s[2]!]), L)).toMatchObject({ chain: 2, state: "candidate" });
		expect(result(await send(a, 4, [s[0]!, s[2]!]), L)).toMatchObject({ chain: 3, state: "active" });
	});

	it("stores a P2 proposal as a candidate whose citations never count as confirmations", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "cargo test --workspace", cited = sessions(3);
		const r = await report(job, repo, { proposal: hex("call-1", 32), observations: [obs(L, "propose", { citations: cited })] });
		expect(result(r, L)).toMatchObject({ status: "stored", state: "candidate", chain: 0 });
		expect(result(await report(job, repo, { proposal: hex("call-2", 32), observations: [obs(L, "propose", { citations: cited })] }), L)).toMatchObject({ state: "candidate", chain: 0 });
		const s1 = session();
		expect(result(await report(job, repo, { session: s1, observations: [obs(L, "confirm", { disjoint_from: cited })] }), L)).toMatchObject({ chain: 1, state: "candidate" });
		expect((await listedOne(repo, L))!.evidence).toEqual(expect.arrayContaining([...cited.map((ref) => ({ kind: "session", ref, note: "cited" })), { kind: "session", ref: s1, note: "confirm" }]));
		for (const bad of [
			{ proposal: hex("call-3", 32), families: [familyOf(L)], observations: [obs(L, "propose", { citations: cited })] },
			{ session: session(), observations: [obs(L, "propose", { citations: cited })] },
			{ proposal: hex("call-4", 32), observations: [obs(L, "propose")] },
			{ session: session(), observations: [obs(L, "confirm", { citations: cited })] },
			{ session: session(), proposal: hex("call-5", 32), observations: [] },
		]) expect((await report(job, repo, bad)).status).toBe(400);
	});

	it("counts a same-session conflict once as a contradiction and applies each session report exactly once, beyond the rolling window", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "go test ./...", fam = familyOf(L);
		const [s1] = await activate(job, repo, [L], [fam]);
		const s4 = session(), conflict = { session: s4, observations: [obs(L, "confirm", { disjoint_from: [] }), obs(L, "contradict")] };
		expect(result(await report(job, repo, conflict), L)).toMatchObject({ state: "active" });
		expect(await listedOne(repo, L)).toMatchObject({ contradictions: 1, chain: 3, exercised: 3 });
		expect((await report(job, repo, conflict)).data.report).toMatchObject({ action: "replayed" });
		expect(await report(job, repo, { ...conflict, families: [fam] })).toMatchObject({ status: 400, data: { error: { code: "idempotency_mismatch" } } });
		for (const s of sessions(65)) expect((await report(job, repo, { session: s, families: [fam] })).status).toBe(200);
		expect(await listedOne(repo, L)).toMatchObject({ exercised: 68, fired: 0 });
		const first = { session: s1, families: [fam], observations: [obs(L, "confirm", { disjoint_from: [] })] };
		expect((await report(job, repo, first)).data.report).toMatchObject({ action: "replayed" });
		expect((await report(job, repo, { ...first, fired: [keyOf(L)] })).status).toBe(400);
		expect(await listedOne(repo, L)).toMatchObject({ exercised: 68, fired: 0, chain: 3 });
	});

	it("retires a candidate or active fact after two consecutive contradictions, resets on a confirm, and spares a pinned fact", async () => {
		const { job } = await tokens(), repo = newRepo(), C = "yarn test", A = "pytest -x", P = "ruff check .";
		await activate(job, repo, [A, P]);
		const step = (observations: unknown[]) => report(job, repo, { session: session(), observations });
		await step([obs(C, "confirm")]);
		await step([obs(C, "contradict")]);
		expect(result(await step([obs(C, "contradict")]), C)).toMatchObject({ state: "retired" });
		expect(result(await step([obs(C, "confirm")]), C)).toMatchObject({ status: "refused", reason: "fact_retired" });
		expect(await listedOne(repo, C)).toMatchObject({ state: "retired", status: "retired" });

		const pid = (await listedOne(repo, P))!.memory_id as string;
		expect((await owner("POST", `/api/profiles/test/nodes/${pid}/pin`)).data).toMatchObject({ action: "pinned" });
		await step([obs(A, "contradict"), obs(P, "contradict")]);
		await step([obs(A, "confirm"), obs(P, "contradict")]); // A resets; its chain restarts but it stays active
		expect(await listedOne(repo, A)).toMatchObject({ state: "active", contradictions: 0, chain: 1 });
		await step([obs(A, "contradict")]);
		expect(result(await step([obs(A, "contradict")]), A)).toMatchObject({ state: "retired" });
		expect(await listedOne(repo, P)).toMatchObject({ state: "active", pinned: true, contradictions: 2 });
		expect((await owner("POST", `/api/profiles/test/nodes/${pid}/unpin`)).data).toMatchObject({ action: "unpinned" });
		expect(result(await step([obs(P, "contradict")]), P)).toMatchObject({ state: "retired" });
	});
});

describe("injection gate (#94)", () => {
	it("counts family sessions as the denominator, firing only from markers, and injects at most 4 active facts at 4 exercised and 40%", async () => {
		const { job, reader } = await tokens(), repo = newRepo();
		const six = ["t1 run", "t2 run", "t3 run", "t4 run", "t5 run", "t6 run"], G = "candidate only";
		const families = [...six, G].map(familyOf), keys = six.map((l) => keyOf(l));
		const s = sessions(3);
		for (let i = 0; i < 3; i++) await report(job, repo, { session: s[i], families, observations: [...six.map((l) => obs(l, "confirm", { disjoint_from: s.slice(0, i) })), ...(i ? [] : [obs(G, "confirm")])] });
		expect(await inject(reader, repo)).toEqual([]); // active, exercised 3
		await report(job, repo, { session: session(), families, fired: [...keys, keyOf(G), hex("unknown", 16)] });
		expect(await inject(reader, repo)).toEqual([]); // exercised 4, fired 1: 25%
		await report(job, repo, { session: session(), fired: [...keys, keyOf(G)] });
		const all = await listed(repo);
		expect(all.find((f) => f.fact_key === keyOf("t1 run"))).toMatchObject({ state: "active", exercised: 5, fired: 2, rate: 0.4, eligible: true });
		expect(all.find((f) => f.fact_key === keyOf(G))).toMatchObject({ state: "candidate", exercised: 5, fired: 2, eligible: false });
		expect(all.every((f) => f.fired <= f.exercised)).toBe(true);
		const injected = await inject(reader, repo);
		expect(injected).toEqual([...keys].sort().slice(0, 4));
		const body = (await http("POST", "/v1/facts", reader, { repo: { remote: repo } })).data;
		expect(body.facts[0]).toEqual({ fact_key: injected[0], detector: "command_repair", statement: expect.any(String), literal: expect.any(String), exercised: 5, fired: 2 });
	});
});

describe("owner controls (#95)", () => {
	it("retire by memory id stops injection and later reports; undo brings it back", async () => {
		const { job, reader } = await tokens(), repo = newRepo(), L = "bundle exec rspec", fam = familyOf(L);
		await activate(job, repo, [L], [fam]);
		await report(job, repo, { session: session(), fired: [keyOf(L)] });
		await report(job, repo, { session: session(), fired: [keyOf(L)] });
		expect(await inject(reader, repo)).toEqual([keyOf(L)]);
		const id = (await listedOne(repo, L))!.memory_id as string;
		const retired = await call<{ activity_id: number }>(await contextFor(), "save_memory", { memory_id: id, retire: true, profile: "test" });
		expect(await inject(reader, repo)).toEqual([]);
		expect(await listedOne(repo, L)).toMatchObject({ state: "retired", status: "retired", eligible: false });
		expect(result(await report(job, repo, { session: session(), observations: [obs(L, "confirm")] }), L)).toMatchObject({ status: "refused", reason: "fact_retired" });
		expect((await owner("POST", `/api/profiles/test/activity/${retired.activity_id}/undo`)).status).toBe(200);
		expect(await inject(reader, repo)).toEqual([keyOf(L)]);
	});

	it("forget leaves a tombstone: reports are refused until a restore or a forget abort publishes the fact again; a failed restore keeps it", async () => {
		const { job, reader } = await tokens(), repo = newRepo(), L = "deno test -A", fam = familyOf(L);
		const confirm = () => report(job, repo, { session: session(), observations: [obs(L, "confirm")] });
		await activate(job, repo, [L], [fam]);
		await report(job, repo, { session: session(), fired: [keyOf(L)] });
		await report(job, repo, { session: session(), fired: [keyOf(L)] });
		const id = (await listedOne(repo, L))!.memory_id as string;
		const tomb = () => inProfile("test", (st) => st.sql.exec("SELECT count(*) AS n FROM profile_meta WHERE key = ?", `fact-forgotten:${id}`).one().n);

		// The node action forget, then its undo.
		const forgot = await owner("POST", `/api/profiles/test/nodes/${id}/forget`);
		expect(forgot.data).toMatchObject({ action: "forgotten" });
		expect(result(await confirm(), L)).toMatchObject({ status: "refused", reason: "fact_forgotten" });
		expect(await listedOne(repo, L)).toBeUndefined();
		expect(await inject(reader, repo)).toEqual([]);
		expect((await owner("POST", `/api/profiles/test/activity/${forgot.data.activity_id}/undo`)).status).toBe(200);
		expect(result(await confirm(), L)).toMatchObject({ status: "stored" });

		// The staged archive: fenced while running, cleared by a completed abort, kept by an aborted restore, cleared by a published one.
		const archive = <T,>(fn: (run: (c: ArchiveCommand) => Record<string, unknown>, sql: SqlStorage) => T) => inProfile("test", (storage, who) => {
			const ctx: WriteContext = { actor: "owner", platform: "test", routedBy: "explicit", userId: who.userId, payloadHash: "" };
			return fn((c) => runArchive(storage, who, c, { ...ctx, payloadHash: requestHash("archive", c) }), storage.sql);
		});
		const step = (op: string, action: "resume" | "abort" = "resume") => archive((run, sql) => run({ action, operation_id: op, cursor: archiveCursor(archiveOperation(sql, op)!), request_id: `${action}-${crypto.randomUUID()}` }));
		const drain = async (op: string) => { for (let i = 0; i < 100; i++) { const o = await archive((_r, sql) => archiveOperation(sql, op)!); if ((o.state === "complete" || o.state === "aborted") && !o.cleanup) return o; await step(op); } throw new Error("archive did not settle"); };
		const forget = () => archive((run, sql) => String(run({ action: "forget", memory_id: id, expected_revision: Number(sql.exec("SELECT revision FROM nodes WHERE id = ?", id).one().revision),
			request_id: `forget-${crypto.randomUUID()}` }).operation_id));
		let op = await forget();
		expect(await tomb()).toBe(1);
		expect(result(await confirm(), L)).toMatchObject({ status: "refused", reason: "fact_busy" });
		await step(op, "abort");
		await drain(op);
		expect(await tomb()).toBe(0);
		expect(result(await confirm(), L)).toMatchObject({ status: "stored" });

		op = await forget();
		const removal = Number((await drain(op)).activity);
		expect(await tomb()).toBe(1);
		expect(result(await confirm(), L)).toMatchObject({ status: "refused", reason: "fact_forgotten" });
		expect(await listedOne(repo, L)).toBeUndefined();

		const restore = String(await archive((run) => run({ action: "restore", activity_id: removal, request_id: `restore-${crypto.randomUUID()}` }).operation_id));
		expect(result(await confirm(), L)).toMatchObject({ status: "refused", reason: "fact_busy" });
		await step(restore, "abort");
		await drain(restore);
		expect(await tomb()).toBe(1);
		expect(result(await confirm(), L)).toMatchObject({ status: "refused", reason: "fact_forgotten" });

		await drain(String(await archive((run) => run({ action: "restore", activity_id: removal, request_id: `restore-${crypto.randomUUID()}` }).operation_id)));
		expect(await tomb()).toBe(0);
		expect(result(await confirm(), L)).toMatchObject({ status: "stored" });
	});
});

describe("trust boundaries (#93)", () => {
	it("derives one repo key from the routing remote, refuses a conflicting key, path routing and me, and keeps repos and profiles apart", async () => {
		const { job, reader } = await tokens(), repo = newRepo(), [owner_, name] = repo.split("/").slice(1), L = "tox -e py312";
		const https = `https://github.com/${owner_!.toUpperCase()}/${name}.git`, ssh = `git@github.com:${owner_}/${name}.git`;
		const s = sessions(3);
		expect((await report(job, https, { session: s[0], observations: [obs(L, "confirm")] })).data).toMatchObject({ repo_key: repo });
		expect(result(await report(job, ssh, { session: s[1], observations: [obs(L, "confirm", { disjoint_from: [s[0]] })] }, { repo_key: repo }), L)).toMatchObject({ chain: 2 });
		expect(await report(job, repo, { session: session(), observations: [] }, { repo_key: newRepo() })).toMatchObject({ status: 400, data: { error: { details: { reason: "repo_key_mismatch" } } } });
		for (const remote of ["git@personal:acme/x.git", "https://gitlab.com/acme/x", "github.com/acme"]) {
			expect(await report(job, remote, { session: session(), observations: [] })).toMatchObject({ status: 400, data: { error: { details: { reason: "unsupported_remote" } } } });
		}
		expect((await http("POST", "/v1/ingest", job, { repo: { remote: repo, path: "/work/x" }, facts: { session: session() } })).status).toBe(400);
		expect((await report(job, repo, { session: session() }, { profile: "personal" })).status).toBe(403);
		const meJob = (await deviceToken("facts-me", ["ingest"], ["test", "me"], "test")).token;
		expect((await report(meJob, repo, { session: session() }, { profile: "me" })).status).toBe(403);
		expect((await http("POST", "/v1/facts", (await deviceToken("facts-me-read", ["read"], ["me"])).token, { repo: { remote: repo }, profile: "me" })).status).toBe(403);

		// The owner's existing remote rules choose the profile; the device default applies only when no rule matches.
		const both = (await deviceToken("facts-both", ["ingest"], ["test", "personal"], "test")).token, ruled = `github.com/wrick17/r-${crypto.randomUUID().slice(0, 8)}`;
		expect((await report(both, ruled, { session: session(), observations: [obs(L, "confirm")] })).data).toMatchObject({ profile: "personal", routed_by: "rule:github.com/wrick17/*" });
		expect(await listed(ruled, "personal")).toHaveLength(1);
		expect(await listed(ruled, "test")).toHaveLength(0);

		// Another repo, another profile's reader and another token kind never see this repo's facts.
		await report(job, repo, { session: s[2], families: [familyOf(L)], observations: [obs(L, "confirm", { disjoint_from: [s[0], s[1]] })] });
		for (let i = 0; i < 3; i++) await report(job, repo, { session: session(), fired: [keyOf(L)] }); // exercised 4, fired 3
		expect(await inject(reader, repo)).toEqual([keyOf(L)]);
		expect(await inject(reader, newRepo())).toEqual([]);
		expect(await inject((await deviceToken("facts-personal-read", ["read"], ["personal"], "personal")).token, repo)).toEqual([]);
		expect(await listed(newRepo())).toEqual([]);
		expect((await report(reader, repo, { session: session() })).status).toBe(403);
		expect((await http("POST", "/v1/facts", job, { repo: { remote: repo } })).status).toBe(403);
		expect((await http("GET", `/api/profiles/test/facts?repo_key=${encodeURIComponent(repo)}`, reader)).status).toBeGreaterThanOrEqual(401);
		expect((await owner("POST", "/v1/ingest", { repo: { remote: repo }, facts: { session: session() } })).status).toBe(403);
	});

	it("accepts only bounded refs, hashes and a checked statement and literal; secrets, paths and free text never reach storage", async () => {
		const { job } = await tokens(), repo = newRepo(), send = (o: Record<string, unknown>, extra: Record<string, unknown> = {}) => report(job, repo, { session: session(), observations: [o], ...extra });
		const withKey = (literal: string, extra: Record<string, unknown> = {}) => ({ ...obs(literal, "confirm"), ...extra, fact_key: keyOf(literal) });
		for (const bad of [
			withKey("curl -H 'Authorization: Bearer abcdefghijklmnopqrstu' https://api.example.com"),
			withKey("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123"),
			withKey("cat /Users/alice/.netrc"),
			withKey("python  -m pytest"),
			withKey("make\ntest"),
			withKey("make test", { statement: "Run make test in /home/alice/src" }),
			{ ...obs("make test", "confirm"), fact_key: keyOf("make check") },
			{ ...obs("make test", "confirm"), statement: "x".repeat(201) },
			{ ...obs("make test", "confirm"), output: "Error: ENOENT" },
		]) expect(await send(bad)).toMatchObject({ status: 400 });
		expect((await send(obs("make test", "confirm"), { digest: "raw digest" })).status).toBe(400);
		expect((await http("POST", "/v1/ingest", job, { repo: { remote: repo }, digests: [], facts: { session: session() } })).status).toBe(400);

		const L = "make test";
		const ok = await send({ ...obs(L, "confirm"), statement: "Use make test; password=hunter2 is not needed" });
		expect(result(ok, L)).toMatchObject({ status: "stored" });
		const fact = (await listedOne(repo, L))!;
		expect(fact.statement).toBe("Use make test; password=[REDACTED] is not needed");
		const stored = await inProfile("test", (st) => ({
			texts: st.sql.exec("SELECT count(*) AS n FROM texts WHERE node_id = ?", fact.memory_id).one().n,
			evidence: st.sql.exec("SELECT kind, ref FROM evidence WHERE owner = ?", `n:${fact.memory_id}`).toArray(),
			attrs: Object.keys((JSON.parse(String(st.sql.exec("SELECT attrs FROM nodes WHERE id = ?", fact.memory_id).one().attrs)) as { fact: object }).fact).sort(),
		}));
		expect(stored).toEqual({ texts: 0, evidence: [{ kind: "session", ref: expect.stringMatching(/^codex:[0-9a-f]{12}$/) }],
			attrs: ["chains", "contradictions", "detector", "exercised", "fact_key", "family", "fired", "literal", "repo_key", "seen", "state"] });
	});
});

describe("P0 fixture facts", () => {
	type Expected = { repo: string; facts: { fact_key: string; detector: string; literal: string; statement: string; trigger: string }[] };
	const fixtures = [browserMcp, agentMemory, bettergit, postplan] as Expected[];
	it("accepts every owner-approved fixture fact through the real report schema with the server's own fact key", async () => {
		const { job } = await tokens();
				for (const f of fixtures) {
			const r = await report(job, f.repo, { session: session(), observations: f.facts.map((x) => ({ fact_key: x.fact_key, kind: "confirm", detector: x.detector,
				statement: x.statement, literal: x.literal, family: hex(x.trigger, 16) })) }, { profile: "test" });
			expect(r.status, `${f.repo}: ${JSON.stringify(r.data.error)}`).toBe(200);
			expect((r.data.report.facts as { status: string }[]).every((x) => x.status === "stored")).toBe(true);
			expect((await listed(f.repo)).map((x) => x.statement).sort()).toEqual(f.facts.map((x) => x.statement).sort());
		}
	});
});

describe("isolation from ordinary memory", () => {
	it("keeps facts out of recall, vectors, graph expansion, inventory, get, the owner model and housekeeping queues", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "zebracmd --frobnicate";
		await activate(job, repo, [L]);
		const fact = (await listedOne(repo, L))!, id = fact.memory_id as string;
		const c = await contextFor();
		const control = await call<{ memory_id: string }>(c, "save_memory", { name: "zebracmd control rule", type: "feedback", description: "zebracmd --frobnicate is how the control runs", profile: "test" });
		const who = await whoOf("test");
		const [vector] = ((await env.AI!.run(EMBED_MODEL, { text: [`rule: ${repo}#${keyOf(L)} ${fact.statement} zebracmd frobnicate`] })) as { data: number[][] }).data;
		await env.VECTORS!.upsert([{ id: vectorId(who, id), values: vector!, namespace: namespaceOf(who), metadata: { kind: "rule" } }]);
		await inProfile("test", (st) => st.sql.exec(`INSERT INTO edges (src, rel, dst, dst_profile, basis, reason, recorded_at, actor, seq) VALUES (?, 'relates_to', ?, '', 'judgment', 'synthetic legacy edge', ?, 'agent', 1)`,
			control.memory_id, id, new Date().toISOString()));

		const ids = (r: { results: { memory_id: string }[] }) => r.results.map((h) => h.memory_id);
		for (const keyword of ["zebracmd", "zebracmd frobnicate", `${repo}#${keyOf(L)}`]) {
			const r = await call<{ results: { memory_id: string }[] }>(c, "recall_memories", { keyword, profile: "test", expand: true });
			expect(ids(r)).not.toContain(id);
		}
		const semantic = await call<{ results: { memory_id: string }[]; diagnostics: Record<string, Record<string, string>> }>(c, "recall_memories", { keyword: "zebracmd frobnicate", profile: "test", expand: true });
		expect(semantic.diagnostics.test!.vector).toMatch(/^hits:/); // the fact's vector was a candidate and was filtered
		expect(ids(semantic)).toContain(control.memory_id);
		expect(ids(await call(c, "recall_memories", { keyword: "", profile: "test", limit: 50 }))).not.toContain(id);
		expect(await outcome(c, "get_memory", { memory_id: id, profile: "test" })).toMatchObject({ ok: false, error: { code: "not_found" } });
		const model = await owner("GET", "/api/profiles/test/owner-model?kinds=rule&limit=200");
		expect(model.data.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([control.memory_id]));
		expect(model.data.items.map((i: { id: string }) => i.id)).not.toContain(id);

		const queued = await inProfile("test", (storage, w) => {
			const old = "2020-01-01T00:00:00.000Z";
			storage.sql.exec("UPDATE nodes SET updated_at = ?, created_at = ? WHERE id IN (?, ?)", old, old, id, control.memory_id);
			for (const stage of ["ttl", "dedupe", "purge", "queue"]) storage.sql.exec("INSERT INTO cursors (stage, due_at) VALUES (?, ?) ON CONFLICT (stage) DO UPDATE SET due_at = excluded.due_at", stage, stage === "queue" ? 0 : Date.now() + 86_400_000);
			housekeep(storage, w);
			return storage.sql.exec<{ kind: string; subjects: string }>("SELECT kind, subjects FROM maintenance").toArray();
		});
		expect(queued.some((q) => q.subjects.includes(control.memory_id))).toBe(true);
		expect(queued.some((q) => q.subjects.includes(id))).toBe(false);

	});

	it("never links a fact by similarity, as a source or as a neighbour, even when a vector for it exists", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "similar --probe";
		await report(job, repo, { session: session(), observations: [obs(L, "confirm")] });
		const id = (await listedOne(repo, L))!.memory_id as string, c = await contextFor();
		const control = await call<{ memory_id: string }>(c, "save_memory", { name: "similar control rule", type: "feedback", description: "control", profile: "test" });
		const peer = await call<{ memory_id: string }>(c, "save_memory", { name: "zebracmd peer rule", type: "feedback", description: "peer", profile: "test" });
		const links = await inProfile("test", async (storage, w) => {
			storage.sql.exec("UPDATE nodes SET embed_hash = card_hash WHERE id IN (?, ?)", control.memory_id, peer.memory_id);
			storage.sql.exec("INSERT INTO cursors (stage, cursor, due_at) VALUES ('similar', ?, 0) ON CONFLICT (stage) DO UPDATE SET cursor = excluded.cursor",
				JSON.stringify({ seq: 0, id: "", mark: { seq: 1e12, at: 0 }, pending: {} }));
			const matches = [id, control.memory_id, peer.memory_id].map((m) => ({ id: vectorId(w, m), score: 0.99 }));
			const near = { async getByIds(vs: string[]) { return vs.map((v) => ({ id: v, values: [1, 0] })); }, async query() { return { matches }; } };
			await similarStep(storage, { ...env, EMBEDDINGS: "on", VECTORS: near } as unknown as Env, w, Date.now() + SETTLE_MS);
			return { edges: storage.sql.exec<{ src: string; dst: string }>("SELECT src, dst FROM edges WHERE basis = 'similarity' AND ended_at IS NULL").toArray(),
				queued: storage.sql.exec<{ subjects: string }>("SELECT subjects FROM maintenance").toArray().map((q) => q.subjects) };
		});
		expect(links.edges).toContainEqual({ src: control.memory_id, dst: peer.memory_id }); // the step ran
		expect(links.edges.filter((e) => e.src === id || e.dst === id)).toEqual([]);
		// The same neighbour list feeds the near-duplicate and contradiction queue: a fact is never a subject there either.
		expect(links.queued.some((s) => s.includes(peer.memory_id))).toBe(true);
		expect(links.queued.filter((s) => s.includes(id))).toEqual([]);
	});

	it("refuses every ordinary mutation, link and move of a fact while retire stays available", async () => {
		const { job } = await tokens(), repo = newRepo(), L = "just check";
		await report(job, repo, { session: session(), observations: [obs(L, "confirm")] });
		const id = (await listedOne(repo, L))!.memory_id as string, c = await contextFor();
		const other = await call<{ memory_id: string }>(c, "save_memory", { name: "fact neighbour", type: "reference", description: "neighbour", profile: "test" });
		const reserved = { ok: false, error: { code: "validation", details: { reason: "repo_fact_reserved" } } };
		for (const [tool, args] of [
			["save_memory", { name: "forged fact", type: "feedback", description: "x", scope: "repo-fact", profile: "test" }],
			["save_memory", { memory_id: id, description: "rewritten", profile: "test" }],
			["save_memory", { memory_id: id, scope: "default", profile: "test" }],
			["save_memory", { name: "superseder", type: "feedback", description: "x", supersedes: [id], profile: "test" }],
			["save_memory", { memory_id: other.memory_id, links: [{ rel: "relates_to", to: { id }, reason: "link into a repo fact", evidence: [{ kind: "file", ref: "a.md" }] }], profile: "test" }],
			["append_memory", { memory_id: id, content: "more", request_id: crypto.randomUUID(), profile: "test" }],
			["capture_memory", { content: "captured", scope: "repo-fact", profile: "test" }],
			["record_knowledge", { nodes: [{ kind: "component", name: "forged", scope: "repo-fact" }], profile: "test" }],
			["record_knowledge", { nodes: [{ kind: "component", name: "forged attrs", attrs: { fact: "x" } }], profile: "test" }],
			["record_knowledge", { edges: [{ from: { id: other.memory_id }, to: { id }, rel: "relates_to", reason: "edge into a repo fact", evidence: [{ kind: "file", ref: "a.md" }] }], profile: "test" }],
		] as const) expect(await outcome(c, tool, args as Record<string, unknown>), `${tool} ${JSON.stringify(args)}`).toMatchObject(reserved);
		const moved = await outcome(c, "save_memory", { memory_id: id, profile: "personal" });
		expect(moved.ok).toBe(false);
		expect(await listedOne(repo, L)).toMatchObject({ status: "active", statement: obs(L, "confirm").statement });
		expect(await listed(repo, "personal")).toEqual([]);
		expect(await call(c, "save_memory", { memory_id: id, retire: true, profile: "test" })).toMatchObject({ action: "retired" });
	});
});
