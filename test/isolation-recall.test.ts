// G4 isolation and the local half of G5 (vector channel, 300 ms fallback, EMBEDDINGS=off), plus generation identities.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccountStore, Principal } from "../src/account/store";
import { requestHash, sha256 } from "../src/domain/ids";
import { redactPayload } from "../src/domain/redact";
import type { Caller, RoutingRule } from "../src/domain/types";
import { accountStub, callTool, type ToolContext } from "../src/mcp";
import { parseEvalRun } from "../src/eval";
import { acceptedCandidates, decideCandidate, insertCandidate, listCandidates } from "../src/profile/eval-candidates";
import { recallStrength } from "../src/profile/recall-stats";
import { nextSeq } from "../src/storage";
import type { RecallOptions } from "../src/viewer/types";
import { readSet, routeWrite } from "../src/routing";
import { call, contextFor, deviceToken, devicePrincipal, OWNER, outcome, registered } from "./helpers";

const workRepo = { remote: "git@github.com:Sequoia-Engineering/web.git" };
const profileStub = (c: Awaited<ReturnType<typeof contextFor>>, name: string) => {
	const ref = c.account.profiles.find((p) => p.profile === name)!;
	return env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`));
};
/**
 * A write arms the embed alarm for now, and it may already be running, so run it only if still pending. Then wait until each
 * card is embedded and fail here if it never is: recall counts a vector only once its embedding is recorded.
 */
const embedded = async (c: Awaited<ReturnType<typeof contextFor>>, ...ids: unknown[]) => {
	await runDurableObjectAlarm(profileStub(c, "test"));
	for (const id of ids) {
		let status: unknown;
		for (let i = 0; i < 200 && (status = (await call(c, "get_memory", { memory_id: id })).embedding_status) !== "embedded"; i++) await new Promise((r) => setTimeout(r, 50));
		expect(status, `embedding_status of ${String(id)}`).toBe("embedded");
	}
};

describe("G4 isolation", () => {
	it("keeps a personal device token out of work", async () => {
		const owner = await contextFor();
		const w = await call(owner, "save_memory", { name: "Work secret plan", type: "reference", description: "work only", content: "quarterly roadmap", repo: workRepo });
		expect(w.profile).toBe("work");
		const { token } = await deviceToken("personal-box", ["read", "write"], ["personal", "me"], "personal");
		const device = await contextFor(devicePrincipal(token));
		expect(await outcome(device, "get_memory", { memory_id: w.memory_id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(device, "recall_memories", { keyword: "roadmap", profile: "work" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(device, "recall_memories", { keyword: "roadmap", repo: workRepo })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const own = await call<{ read_set: string[]; results: unknown[] }>(device, "recall_memories", { keyword: "roadmap" });
		expect(own.read_set).toEqual(["personal", "me"]);
		expect(own.results).toHaveLength(0);
	});

	it("reads only work and me when routed to work, and keeps same-named records apart", async () => {
		const c = await contextFor();
		await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "personal copy", content: "personal lockfile note", profile: "personal" });
		const work = await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "work copy", content: "work lockfile note", repo: workRepo });
		const me = await call(c, "save_memory", { name: "Lockfile habit", type: "user", description: "me copy", content: "me lockfile note", profile: "me", company_free: true, repo: workRepo });
		expect(work.memory_id).not.toBe(me.memory_id);
		const r = await call<{ read_set: string[]; results: { profile: string; memory_id: string }[] }>(c, "recall_memories", { keyword: "lockfile habit", repo: workRepo });
		expect(r.read_set).toEqual(["work", "me"]);
		expect(new Set(r.results.map((x) => x.profile))).toEqual(new Set(["work", "me"]));
		expect(r.results.map((x) => x.memory_id)).toEqual(expect.arrayContaining([work.memory_id, me.memory_id]));
		expect(await outcome(c, "get_memory", { name: "Lockfile habit", repo: workRepo })).toMatchObject({ ok: false, error: { code: "ambiguous" } });
	});

	it("opts into only routed Work captures, retaining ordinary me memories and refusing foreign or unreadable routes", async () => {
		const c = await contextFor(undefined, { EMBEDDINGS: "off" });
		const { token } = await deviceToken("capture-routing-job", ["ingest"], ["work", "personal", "me"], "work");
		const origin = new URL(env.RESOURCE_URL).origin;
		for (const profile of ["work", "personal"]) {
			const session = { client: "codex", id: `capture-routing-${profile}` };
			const range_id = `codex:${session.id}:abcdef01:0-100`;
			const body = JSON.stringify({ asks: [], decisions: [], corrections: [{ text: `recallboundary ${profile} context stays in its profile.`, pos: 1 }],
				outcomes: { commits: [], prs: [], tests: [] }, entities: [], dropped: { asks: 0, decisions: 0, corrections: 0 } });
			const hash = sha256(body);
			const response = await exports.default.fetch(new Request(`${origin}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ profile, session, digests: [{ range_id, capture_status: "consolidated", part_id: "0-100", sha256: hash, body }], manifests: [{ range_id, parts: [{ part_id: "0-100", sha256: hash }] }] }) }));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ profile, results: [{ status: "stored" }, { status: "stored" }] });
		}
		const me = await call(c, "save_memory", { name: "recallboundary preference", type: "user", description: "a general preference", content: "recallboundary shared preference", profile: "me", company_free: true });
		type R = { read_set: string[]; results: { memory_id: string; profile: string; kind: string; passage: string; name: string }[] };
		const args = { keyword: "recallboundary", repo: workRepo, include_captures: true };
		const work = await call<R>(c, "recall_memories", args);
		expect(work.read_set).toEqual(["work", "me"]);
		expect(work.results).toHaveLength(2);
		expect(work.results).toEqual(expect.arrayContaining([
			expect.objectContaining({ profile: "work", kind: "session", passage: expect.stringContaining("recallboundary work context") }),
			expect.objectContaining({ profile: "me", memory_id: me.memory_id }),
		]));
		expect(JSON.stringify(work.results)).not.toContain("recallboundary personal context");
		const plain = await call<R>(c, "recall_memories", { ...args, include_captures: false });
		expect(plain.results.map((r) => r.memory_id)).toEqual([me.memory_id]);
		const personal = await call<R>(c, "recall_memories", { keyword: "recallboundary", profile: "personal", include_captures: true });
		expect(personal.results.filter((r) => r.kind === "session")).toEqual([expect.objectContaining({ profile: "personal", passage: expect.stringContaining("recallboundary personal context") })]);
		const meOnly = await call<R>(c, "recall_memories", { keyword: "recallboundary", profile: "me", include_captures: true });
		expect(meOnly.results.map((r) => r.memory_id)).toEqual([me.memory_id]);
		const { token: readerToken } = await deviceToken("capture-work-reader", ["read"], ["work", "me"], "work");
		const reader = await contextFor(devicePrincipal(readerToken), { EMBEDDINGS: "off" });
		expect((await call<R>(reader, "recall_memories", args)).results).toEqual(work.results);
		expect(await outcome(reader, "recall_memories", { keyword: "recallboundary", profile: "personal", include_captures: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const ingestOnly = await contextFor(devicePrincipal(token), { EMBEDDINGS: "off" });
		expect(await outcome(ingestOnly, "recall_memories", args)).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});

	it("guards every write into me: explicit choice, personal fields and route compatibility", async () => {
		const c = await contextFor();
		const base = { name: "Prefers small diffs", type: "user", description: "a preference", content: "Keep changes small." };
		// Issue #3: a work repo context neither refuses nor reroutes an explicit me, with or without company_free.
		expect(await outcome(c, "save_memory", { ...base, content: "Mail me at a@b.co", profile: "me", repo: workRepo, request_id: "g4-me-1" }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "personal_field" } } });
		// The refused request id was released, so the corrected write may reuse it.
		const ok = await call(c, "save_memory", { ...base, profile: "me", repo: workRepo, request_id: "g4-me-1" });
		expect(ok).toMatchObject({ profile: "me", routed_by: "explicit" });
		const org = await call(c, "save_memory", { ...base, name: "Standup habit", content: "Learned at Sequoia-Engineering standups.", profile: "me", company_free: true, repo: workRepo });
		expect(org.profile).toBe("me");
		// The record's own id selects me; repo context does not change it.
		expect(await call(c, "append_memory", { memory_id: ok.memory_id, content: "more", request_id: "g4-me-2", repo: workRepo })).toMatchObject({ profile: "me", routed_by: "memory_id" });
		expect(await outcome(c, "append_memory", { memory_id: ok.memory_id, content: "call +1 415 555 0100", request_id: "g4-me-3" }))
			.toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "personal_field" } } });
		expect(await outcome(c, "save_memory", { ...base, name: "Unrouted" })).toMatchObject({ ok: false, error: { code: "route_required" } });
		const path = await call(c, "save_memory", { ...base, name: "Path routed", repo: { path: "/Users/test/work/api" } });
		expect(path.profile).toBe("work");
	});
	it("never lets a pending request binding skip the me guard (crash after binding, or overlapping identical calls)", async () => {
		const c = await contextFor();
		const unsafe = { name: "Guard bypass probe", type: "user", description: "a preference", content: "private roadmap: mail owner@example.com", profile: "me", repo: workRepo };
		// Durable state when the Worker binds the request and dies before the guard runs.
		const crashed = { ...unsafe, request_id: "f1-crash-after-bind" };
		await accountStub(env, OWNER).bindRequest({ requestId: crashed.request_id, profile: "me", op: "save_memory", payloadHash: requestHash("save_memory", redactPayload(crashed)) });
		expect(await outcome(c, "save_memory", crashed)).toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "personal_field" } } });
		const overlapping = { ...unsafe, name: "Guard bypass probe 2", request_id: "f1-overlap" };
		const both = await Promise.all([outcome(c, "save_memory", overlapping), outcome(c, "save_memory", overlapping)]);
		expect(both.every((r) => !r.ok)).toBe(true);
		const leaked = await call<{ results: unknown[] }>(c, "recall_memories", { keyword: "private roadmap", profile: "me" });
		expect(leaked.results).toHaveLength(0);
	});

	it("replays a committed me write, and a later sensitive term never refuses a fresh one", async () => {
		const c = await contextFor();
		const args = { name: "Committed me replay", type: "user", description: "a preference", content: "Prefers rebase over merge.", profile: "me", company_free: true, request_id: "f1-committed" };
		const first = await call(c, "save_memory", args);
		await accountStub(env, OWNER).admin({ op: "addSensitiveTerm", term: "rebase" });
		const later = await contextFor();
		expect(await call(later, "save_memory", args)).toMatchObject({ action: "replayed", memory_id: first.memory_id, profile: "me" });
		expect(await call(later, "save_memory", { ...args, name: "Fresh me write", request_id: "f1-fresh" })).toMatchObject({ action: "created", profile: "me" });
		expect(await outcome(later, "save_memory", { ...args, content: "Changed payload.", request_id: "f1-committed" })).toMatchObject({ ok: false, error: { code: "idempotency_mismatch" } });
	});
});

describe("issue #3: the calling agent selects the profile", () => {
	/** A distinct owner account, so these me records never join another test's read set (the transfer and wipe suites' fresh-context pattern). */
	async function isolated() {
		const userId = `issue3-${crypto.randomUUID().slice(0, 8)}`, account = accountStub(env, userId);
		const ctx = async (principal: Principal = { kind: "owner", userId }): Promise<ToolContext> => {
			const a = await account.context(principal);
			if (!a.ok) throw new Error(`context failed: ${a.error.message}`);
			return { env: { ...env, OWNER_USER_ID: userId } as Env, caller: a.value.caller, account: a.value, platform: "test" };
		};
		const owner = await ctx();
		const device = async (name: string, scopes: string[], profiles: string[], defaultProfile?: string) => {
			const r = await account.admin({ op: "createDevice", name, scopes: scopes as never, profiles, ...(defaultProfile ? { defaultProfile } : {}) });
			if (!r.ok) throw new Error(r.error.message);
			return ctx(devicePrincipal((r.value as { token: string }).token));
		};
		return { account, owner, device };
	}
	const known = ["me", "work", "personal", "test"];
	const owner: Caller = { kind: "owner", userId: "u", scopes: ["read", "write"], profiles: "*" };
	const rules: RoutingRule[] = [
		{ id: "r1", priority: 10, match: "remote", pattern: "github.com/sequoia-engineering/*", profile: "work", enabled: true },
		{ id: "r2", priority: 20, match: "path", pattern: "/Users/test/work", profile: "work", enabled: true },
	];

	it("saves both original examples under the explicit me target with the matching sensitive terms registered", async () => {
		const { account, owner: c, device: deviceFor } = await isolated();
		for (const term of ["Pratyush Poddar", "GitHub"]) expect((await account.admin({ op: "addSensitiveTerm", term })).ok).toBe(true);
		const device = await deviceFor("issue3-work-default", ["read", "write"], ["work", "me"], "work");
		const identity = await call(device, "save_memory", { name: "Owner identity and household", type: "user", description: "identity summary",
			content: "The owner is Pratyush Poddar; household summary for personal planning.", profile: "me", company_free: true, repo: workRepo, request_id: "issue3-identity" });
		const release = await call(c, "save_memory", { name: "T3 Code release history", type: "reference", description: "personal release history",
			content: "Personal T3 Code release history: https://github.com/pingdotgg/t3code/releases/tag/v0.0.20 on GitHub.", profile: "me", company_free: true, repo: workRepo, request_id: "issue3-release" });
		expect(identity).toMatchObject({ action: "created", profile: "me", routed_by: "explicit" });
		expect(release).toMatchObject({ action: "created", profile: "me", routed_by: "explicit" });
		const back = await call<{ content: string }>(c, "get_memory", { memory_id: release.memory_id });
		expect(back.content).toContain("https://github.com/pingdotgg/t3code/releases/tag/v0.0.20");
		// A retry of the same call replays the stored result.
		expect(await call(device, "save_memory", { name: "Owner identity and household", type: "user", description: "identity summary",
			content: "The owner is Pratyush Poddar; household summary for personal planning.", profile: "me", company_free: true, repo: workRepo, request_id: "issue3-identity" }))
			.toMatchObject({ action: "replayed", memory_id: identity.memory_id });
	});

	it("keeps an explicit profile over repo, path and device context, and refuses only real authorization, activity and data failures", async () => {
		const { owner: c, device: deviceFor } = await isolated();
		const device = await deviceFor("issue3-precedence", ["read", "write"], ["work", "personal"], "work");
		const base = { type: "reference", description: "precedence", content: "issue3 precedence note" };
		expect(await call(device, "save_memory", { ...base, name: "issue3 personal over work repo", profile: "personal", repo: workRepo })).toMatchObject({ profile: "personal", routed_by: "explicit" });
		expect(await call(device, "save_memory", { ...base, name: "issue3 personal over work path", profile: "personal", repo: { path: "/Users/test/work/api" } })).toMatchObject({ profile: "personal", routed_by: "explicit" });
		expect(await call(device, "save_memory", { ...base, name: "issue3 device default" })).toMatchObject({ profile: "work", routed_by: expect.stringMatching(/^device:/) });
		// Real refusals stay: a profile the token may not use, an unknown profile, a read-only token, and captures into me.
		expect(await outcome(device, "save_memory", { ...base, name: "issue3 me forbidden", profile: "me" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(device, "save_memory", { ...base, name: "issue3 unknown", profile: "nosuch" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(await outcome(await deviceFor("issue3-reader", ["read"], ["personal"], "personal"), "save_memory", { ...base, name: "issue3 read only", profile: "personal" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await outcome(c, "capture_memory", { content: "issue3 capture", profile: "me" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const saved = await call(c, "save_memory", { ...base, name: "issue3 revision", profile: "me" });
		expect(await call(c, "save_memory", { memory_id: saved.memory_id, content: "issue3 revision 2", expected_revision: saved.revision })).toMatchObject({ profile: "me", action: "updated" });
		expect(await outcome(c, "save_memory", { memory_id: saved.memory_id, content: "issue3 stale", expected_revision: saved.revision })).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
		expect(await outcome(c, "record_knowledge", { nodes: [{ kind: "person", name: "Issue3 Colleague" }], profile: "me" })).toMatchObject({ ok: false, error: { code: "me_sensitive_term", details: { term: "person" } } });
		expect(await call(c, "record_knowledge", { nodes: [{ kind: "project", name: "Issue3 GitHub hobby" }], profile: "me", repo: workRepo })).toMatchObject({ profile: "me" });
	});

	it("moves a record into me without company_free from a work context", async () => {
		const { account, owner: c } = await isolated();
		await account.admin({ op: "addSensitiveTerm", term: "Issue3Movable" });
		const src = await call(c, "save_memory", { name: "issue3 movable", type: "user", description: "to move", content: "Issue3Movable preference.", profile: "personal" });
		expect(await call(c, "save_memory", { memory_id: src.memory_id, profile: "me", repo: workRepo, request_id: "issue3-move" }))
			.toMatchObject({ action: "transfer_started", profile: "me", state: "committed" });
		expect(await call(c, "get_memory", { memory_id: src.memory_id })).toMatchObject({ memory_id: src.memory_id, profile: "me" });
		expect(await call(c, "save_memory", { memory_id: src.memory_id, profile: "me", repo: workRepo, request_id: "issue3-move" })).toMatchObject({ action: "transfer_started", state: "committed" });
	});

	it("registers rule, owner and work terms in the account while me is inactive, writing nothing into me", async () => {
		const r = await registered("work", "me");
		const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(r.userId));
		await r.account((sql) => sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'me'"));
		expect(await account.admin({ op: "setRules", rules: [{ priority: 10, match: "remote", pattern: "github.com/issue3org/*", profile: "work", enabled: true }] })).toMatchObject({ ok: true, value: { rules: 1 } });
		expect(await account.admin({ op: "addSensitiveTerm", term: "Issue3 Owner Term" })).toMatchObject({ ok: true });
		expect(await account.admin({ op: "addSensitiveTerms", terms: ["Issue3 Work Person"] })).toMatchObject({ ok: true, value: { terms: 1 } });
		expect(await r.account((sql) => sql.exec<{ term: string }>("SELECT term FROM sensitive_terms ORDER BY term").toArray().map((x) => x.term))).toEqual(["Issue3 Owner Term", "Issue3 Work Person"]);
		expect(await runInDurableObject(r.of("me").stub, (_i, st) => st.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'guard_terms'").toArray().length
			? st.storage.sql.exec("SELECT count(*) AS n FROM guard_terms").one().n : 0)).toBe(0);
	});

	it("keeps v1 routing for omitted profiles and an explicit primary for reads", () => {
		const device: Caller = { ...owner, kind: "device", deviceId: "d1", defaultProfile: "personal" };
		expect(routeWrite(owner, rules, known, { profile: "personal", repo: { remote: "git@github.com:Sequoia-Engineering/web.git" } })).toEqual({ ok: true, value: { profile: "personal", routedBy: "explicit" } });
		expect(routeWrite(owner, rules, known, { repo: { remote: "git@github.com:Sequoia-Engineering/web.git" } })).toMatchObject({ ok: true, value: { profile: "work", routedBy: "rule:github.com/sequoia-engineering/*" } });
		expect(routeWrite(owner, rules, known, { repo: { path: "/Users/test/work/api" } })).toMatchObject({ ok: true, value: { profile: "work" } });
		expect(routeWrite(device, rules, known, {})).toMatchObject({ ok: true, value: { profile: "personal", routedBy: "device:d1" } });
		expect(routeWrite({ ...device, defaultProfile: "me" }, rules, known, {})).toMatchObject({ ok: false, error: { code: "route_required" } });
		expect(routeWrite(owner, rules, known, {})).toMatchObject({ ok: false, error: { code: "route_required" } });
		// Inactive or unknown explicit targets and forbidden ones are refused; an inactive routed target is profile_wiped.
		expect(routeWrite(owner, rules, ["me", "personal"], { profile: "work" })).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(routeWrite(owner, rules, ["me", "personal"], { repo: { path: "/Users/test/work" } })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(routeWrite({ ...owner, profiles: ["personal"] }, rules, known, { profile: "me" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(readSet(owner, rules, known, { profile: "personal", repo: { path: "/Users/test/work" } })).toEqual({ ok: true, value: { primary: "personal", withMe: true, routedBy: "explicit" } });
		expect(readSet(owner, rules, known, { profile: "me", repo: { path: "/Users/test/work" } })).toEqual({ ok: true, value: { primary: "me", withMe: false, routedBy: "explicit" } });
		expect(readSet({ ...owner, profiles: ["personal"] }, rules, known, { profile: "personal" })).toMatchObject({ ok: true, value: { primary: "personal", withMe: false } });
		expect(readSet(owner, rules, known, {})).toMatchObject({ ok: true, value: { primary: "me", withMe: false, routedBy: "default:me" } });
	});
});

describe("recall channels and the vector fallback", () => {
	it("finds a record by exact name, literal substring and full text, and by vector once embedded", async () => {
		const c = await contextFor();
		const saved = await call(c, "save_memory", { name: "Token refresh client", type: "project", description: "Moved refresh into one shared client",
			why: "Three call sites each retried", content: "The SEQ-1234 refresh loop came from per-call retries in web.", evidence: [{ kind: "ticket", ref: "jira:SEQ-1234" }], profile: "test" });
		const lexical = await call<{ results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean }>(c, "recall_memories", { keyword: "SEQ-1234", profile: "test" });
		expect(lexical.results[0]).toMatchObject({ memory_id: saved.memory_id });
		expect(lexical.results[0]!.matched_by).toEqual(expect.arrayContaining(["fulltext", "literal"]));
		const exact = await call<{ results: { memory_id: string; matched_by: string[] }[] }>(c, "recall_memories", { keyword: "token refresh client", profile: "test" });
		expect(exact.results[0]!.matched_by).toContain("exact");
		// The write armed the alarm for now; it may already have run. Run it if it is still pending, then wait for the card.
		await embedded(c, saved.memory_id);
		const semantic = await call<{ results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean }>(c, "recall_memories", { keyword: "shared client retried", profile: "test" });
		expect(semantic.lexical_only).toBe(false);
		expect(semantic.results.find((r) => r.memory_id === saved.memory_id)?.matched_by).toContain("vector");
		const ref = c.account.profiles.find((p) => p.profile === "test")!;
		const ids = await (env as unknown as { VECTORS: { _ids(): Promise<string[]> } }).VECTORS._ids();
		expect(ids).toContain(`g${ref.generation}:${saved.memory_id}`);
		const got = await call(c, "get_memory", { memory_id: saved.memory_id });
		expect(got.embedding_status).toBe("embedded");
	});

	it("re-embeds a journal when an append changes its first 1,200 characters, and only then", async () => {
		const c = await contextFor();
		const j = await call(c, "save_memory", { name: "codex: semantic journal", type: "project", kind: "journal", description: "journal", profile: "test" });
		const settle = async () => {
			await embedded(c, j.memory_id);
		};
		const hash = async () => runInDurableObject(profileStub(c, "test"), (_i, s) => s.storage.sql.exec<{ card_hash: string; embed_hash: string | null }>(
			"SELECT card_hash, embed_hash FROM nodes WHERE id = ?", j.memory_id).one());
		await settle();
		const first = await hash();
		await call(c, "append_memory", { memory_id: j.memory_id, content: "distinctive zeppelin harbour notes", request_id: "f3-first" });
		// The alarm may finish before the next read, so check the card itself: the prefix append changed it.
		expect((await hash()).card_hash).not.toBe(first.card_hash);
		await settle();
		const fresh = await hash();
		expect(fresh.embed_hash).toBe(fresh.card_hash);
		const found = await call<{ results: { memory_id: string; matched_by: string[] }[] }>(c, "recall_memories", { keyword: "zeppelin harbour", profile: "test" });
		expect(found.results.find((r) => r.memory_id === j.memory_id)?.matched_by).toContain("vector");
		await call(c, "append_memory", { memory_id: j.memory_id, content: "x".repeat(1300), request_id: "f3-fill" });
		await settle();
		const full = await hash();
		await call(c, "append_memory", { memory_id: j.memory_id, content: "past the card prefix", request_id: "f3-tail" });
		expect(await hash()).toEqual({ card_hash: full.card_hash, embed_hash: full.card_hash }); // card unchanged, nothing became due
		expect((await call(c, "get_memory", { memory_id: j.memory_id })).embedding_status).toBe("embedded");
	});

	// One 3 s deadline covers the query embedding and the Vectorize query (decision of 2026-10-28; it replaced a 300 ms wait).
	type Recall = { results: { memory_id: string; matched_by: string[] }[]; lexical_only: boolean; diagnostics: Record<string, Record<string, string> | string> };
	const fake = () => (env as unknown as { AI: { _pending(): Promise<number>; _calls(): Promise<number> } }).AI;
	const probe = async (c: Awaited<ReturnType<typeof contextFor>>, name: string) => {
		const saved = await call(c, "save_memory", { name, type: "reference", description: "deadline", content: "deadline probe body", profile: "test" });
		await embedded(c, saved.memory_id);
		return saved.memory_id as string;
	};
	const timed = async (c: Awaited<ReturnType<typeof contextFor>>, keyword: string) => {
		const at = Date.now();
		const r = await call<Recall>(c, "recall_memories", { keyword, profile: "test" });
		return { r, ms: Date.now() - at, d: r.diagnostics.test as Record<string, string> };
	};

	it("lets semantic results that arrive after the old limits contribute within the shared 3 s deadline", async () => {
		const c = await contextFor();
		const id = await probe(c, "Deadline probe late");
		const slowEmbedding = await timed(c, "deadline probe [[embed-slow]]");
		expect(slowEmbedding.ms).toBeGreaterThanOrEqual(1500);
		expect(slowEmbedding.d).toMatchObject({ embedding: "ok", vector: expect.stringMatching(/^hits:/) });
		expect(slowEmbedding.r.results.find((x) => x.memory_id === id)?.matched_by).toContain("vector");
		const slowVector = await timed(c, "deadline probe [[vector-slow]]");
		expect(slowVector.ms).toBeGreaterThanOrEqual(2000);
		expect(slowVector.ms).toBeLessThan(3000);
		expect(slowVector.r.results.find((x) => x.memory_id === id)?.matched_by).toContain("vector");
	});

	it("returns the ready lexical results at the deadline or on a provider failure, and says which stage missed", async () => {
		const c = await contextFor();
		const id = await probe(c, "Deadline probe missed");
		const found = (r: Recall) => r.results.find((x) => x.memory_id === id)?.matched_by;
		// The embedding is still pending when the lexical results come back: lexical work never waits for it.
		const hungEmbedding = await timed(c, "deadline probe [[embed-hang]]");
		expect(await fake()._pending()).toBeGreaterThan(0);
		expect(hungEmbedding.ms).toBeGreaterThanOrEqual(2900);
		expect(hungEmbedding.ms).toBeLessThan(3800);
		expect(hungEmbedding.d).toMatchObject({ embedding: "timeout", vector: "skipped" });
		expect(hungEmbedding.r.lexical_only).toBe(true);
		expect(found(hungEmbedding.r)).toEqual(expect.arrayContaining(["fulltext"]));
		expect(found(hungEmbedding.r)).not.toContain("vector");
		const hungVector = await timed(c, "deadline probe [[vector-hang]]");
		expect(hungVector.ms).toBeLessThan(3800);
		expect(hungVector.d).toMatchObject({ embedding: "ok", vector: "timeout" });
		expect(found(hungVector.r)).not.toContain("vector");
		const vectorFails = await timed(c, "deadline probe [[vector-fail]]");
		expect(vectorFails.ms).toBeLessThan(1500);
		expect(vectorFails.d.vector).toMatch(/^error:/);
		expect(found(vectorFails.r)).toBeDefined();
		const embeddingFails = await timed(c, "deadline probe [[embed-fail]]");
		expect(embeddingFails.d).toMatchObject({ embedding: expect.stringMatching(/^error:/), vector: "skipped" });
		expect(found(embeddingFails.r)).toBeDefined();
		const off = await contextFor(undefined, { EMBEDDINGS: "off" });
		const calls = await fake()._calls();
		const lexical = await call<Recall>(off, "recall_memories", { keyword: "deadline probe", profile: "test" });
		expect(lexical).toMatchObject({ lexical_only: true, diagnostics: { embedding: "off", test: { embedding: "off", vector: "off" } } });
		expect(found(lexical)).toBeDefined();
		expect(await fake()._calls()).toBe(calls);
	});

	it("fuses more candidates than one statement's 100 bound parameters, with and without filters, and keeps every one", async () => {
		const c = await contextFor();
		// 130 records share the query's words, so the lexical channels and the 100 vector hits pass 100 distinct candidates.
		// They stay in work, which no later vector probe reads. In test they would fill a probe's Vectorize top 100 whenever its random keyword shares a fake bucket.
		for (let i = 0; i < 130; i++) {
			await call(c, "save_memory", { name: `wombat ledger ${i}`, type: i < 110 ? "reference" : "feedback", description: "wombat ledger", content: "wombat ledger", profile: "work" });
		}
		const target = await call(c, "save_memory", { name: "Wombat ledger", type: "feedback", description: "wombat ledger", content: "wombat ledger", profile: "work" });
		const stub = profileStub(c, "work");
		for (let i = 0; i < 40; i++) {
			await runDurableObjectAlarm(stub);
			if (!await runInDurableObject(stub, (_i, s) => s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE embed_hash IS NOT card_hash AND status = 'active'").one().n)) break;
		}
		type R = { results: { memory_id: string; type: string; kind: string; score: number; matched_by: string[] }[]; diagnostics: Record<string, Record<string, string>> };
		const recall = (extra: Record<string, unknown>) => call<R>(c, "recall_memories", { keyword: "wombat ledger", profile: "work", limit: 100, ...extra });
		const all = await recall({});
		expect(all.diagnostics.work!.vector).toBe("hits:100");
		// The exact-name record was created after the other 130 candidates and still ranks first, over the full candidate set.
		expect(all.results[0]).toMatchObject({ memory_id: target.memory_id, matched_by: ["exact", "fulltext", "literal", "vector"] });
		expect(new Set(all.results.map((r) => r.memory_id)).size).toBe(100);
		expect(all.results.every((r, i) => i === 0 || r.score <= all.results[i - 1]!.score)).toBe(true);
		// Filters on 100 vector hits: the hosted G01 shape (type) and the kind filter.
		const feedback = await recall({ type: "feedback" });
		expect(feedback.results).toHaveLength(21);
		expect(feedback.results[0]!.memory_id).toBe(target.memory_id);
		expect(feedback.results.every((r) => r.type === "feedback")).toBe(true);
		const documents = await recall({ kinds: ["document"] });
		expect(documents.diagnostics.work!.vector).toBe("hits:100");
		expect(documents.results).toHaveLength(100);
		expect(documents.results.every((r) => r.kind === "document" && r.matched_by.includes("literal"))).toBe(true);
	});

	it("packs results to the token budget", async () => {
		const c = await contextFor();
		for (let i = 0; i < 5; i++) await call(c, "save_memory", { name: `budget note ${i}`, type: "reference", description: "budget", content: "budget ".repeat(150), profile: "test" });
		const r = await call<{ results: unknown[]; estimated_tokens: number; truncated: boolean }>(c, "recall_memories", { keyword: "budget", profile: "test", token_budget: 400 });
		expect(r.estimated_tokens).toBeLessThanOrEqual(400);
		expect(r.truncated).toBe(true);
	});
});

describe("generation identities", () => {
	it("reserves every live generation in the R2 ledger and qualifies vector ids with it", async () => {
		const c = await contextFor();
		for (const p of c.account.profiles) {
			expect(p.generation).toMatch(/^[a-z2-7]{13}$/);
			const ledger = await env.BACKUPS.get(`generations/${p.generation}.json`);
			expect(await ledger!.json()).toMatchObject({ id: p.generation, profile: p.profile, purpose: "live", state: "active" });
		}
	});

	it("draws again instead of reusing an id already in the ledger", async () => {
		const c = await contextFor();
		const taken = c.account.profiles[0]!.generation;
		const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(OWNER));
		const fresh = await runInDurableObject(stub, async (instance: AccountStore) => {
			const draws = [taken, "freshgenera7a"];
			return instance.reserveGeneration(OWNER, "test", "scratch", () => draws.shift()!);
		});
		expect(fresh).toBe("freshgenera7a");
		expect(await (await env.BACKUPS.get(`generations/${taken}.json`))!.json()).toMatchObject({ state: "active" });
		await expect(runInDurableObject(stub, (instance: AccountStore) => instance.reserveGeneration("u".repeat(60), "test", "scratch"))).rejects.toThrow("64 bytes");
		void accountStub;
	});
});

// v2 R1 (#9): channel selection on the shared recall path, hit counts after packing, and bounded eval records.
describe("v2 R1: recall channels, hit counts and eval records", () => {
	type Hits = { results: { profile: string; memory_id: string; matched_by: string[] }[]; lexical_only: boolean; diagnostics: Record<string, unknown> };
	const today = () => new Date().toISOString().slice(0, 10);
	const recallOf = async (c: ToolContext, args: Record<string, unknown>, opts?: RecallOptions) => {
		const r = await callTool(c, "recall_memories", args, opts);
		if (!r.ok) throw new Error(r.error.code);
		return r.value as Hits;
	};
	const state = (c: ToolContext, ids: string[]) => runInDurableObject(profileStub(c, "test"), (_i, s) => {
		const sql = s.storage.sql;
		return {
			totals: sql.exec<{ recalls: number; tokens: number }>("SELECT recalls, tokens FROM recall_totals WHERE day = ?", today()).toArray()[0] ?? { recalls: 0, tokens: 0 },
			hits: Object.fromEntries(sql.exec<{ node_id: string; hits: number }>("SELECT node_id, hits FROM recall_daily WHERE day = ? AND node_id IN (SELECT value FROM json_each(?))",
				today(), JSON.stringify(ids)).toArray().map((r) => [r.node_id, r.hits])),
			nodes: sql.exec("SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", JSON.stringify(ids)).toArray(),
		};
	});

	it("counts only the ids each recall returned, once per recall, and nothing for count_hits false or an inventory", async () => {
		const owner = await contextFor({ kind: "owner", userId: OWNER }, { EMBEDDINGS: "off" } as Partial<Env>);
		const pending: Promise<unknown>[] = [];
		const c: ToolContext = { ...owner, waitUntil: (p) => void pending.push(p) };
		const settle = () => Promise.all(pending.splice(0));
		const word = `kestrel${crypto.randomUUID().slice(0, 8)}`;
		const ids: string[] = [];
		for (const n of [1, 2, 3]) ids.push((await call(c, "save_memory", { name: `R1 count ${word} ${n}`, type: "project", description: word, content: `${word} body ${n}`, profile: "test" })).memory_id as string);
		// The store's own embedding alarm updates these rows after a save; let it finish so only recall could change them.
		await embedded(c, ...ids);
		const before = await state(c, ids);
		const first = await recallOf(c, { keyword: word, profile: "test", limit: 2 });
		const shown = first.results.filter((h) => h.profile === "test").map((h) => h.memory_id);
		expect(shown).toHaveLength(2);
		await settle();
		const once = await state(c, ids);
		expect(once.hits).toEqual(Object.fromEntries(shown.map((id) => [id, 1])));
		expect(once.totals.recalls).toBe(before.totals.recalls + 1);
		expect(once.totals.tokens).toBeGreaterThan(before.totals.tokens);
		await recallOf(c, { keyword: word, profile: "test", limit: 2 });
		await settle();
		const twice = await state(c, ids);
		expect(twice.hits).toEqual(Object.fromEntries(shown.map((id) => [id, 2])));
		expect(twice.totals.recalls).toBe(before.totals.recalls + 2);
		// count_hits false and an empty-keyword inventory return results and change no count.
		expect((await recallOf(c, { keyword: word, profile: "test", limit: 2 }, { count_hits: false })).results.length).toBeGreaterThan(0);
		expect((await recallOf(c, { profile: "test", limit: 5 })).results.length).toBeGreaterThan(0);
		expect(pending).toHaveLength(0);
		expect(await state(c, ids)).toEqual(twice);
		// Recall is a read for records: every node row is unchanged.
		expect(twice.nodes).toEqual(before.nodes);
	});

	it("runs only the selected channels, and lexical-only ranks match the default when vectors are off", async () => {
		const c = await contextFor();
		const word = `osprey${crypto.randomUUID().slice(0, 8)}`;
		const saved = await call(c, "save_memory", { name: `R1 channel ${word}`, type: "reference", description: "channel probe", content: `${word} nesting platform`, profile: "test" });
		await embedded(c, saved.memory_id);
		const LEXICAL = ["exact", "literal", "fulltext"];
		const both = await recallOf(c, { keyword: word, profile: "test" });
		expect(both.results.find((h) => h.memory_id === saved.memory_id)?.matched_by).toEqual(expect.arrayContaining(["fulltext", "vector"]));
		const lexical = await recallOf(c, { keyword: word, profile: "test" }, { channels: ["lexical"] });
		expect(lexical.lexical_only).toBe(true);
		expect(lexical.results.every((h) => !h.matched_by.includes("vector"))).toBe(true);
		expect((lexical.diagnostics.test as Record<string, string>).embedding).toBe("off:channels");
		const vector = await recallOf(c, { keyword: word, profile: "test" }, { channels: ["vector"] });
		expect(vector.results.find((h) => h.memory_id === saved.memory_id)?.matched_by).toContain("vector");
		expect(vector.results.every((h) => !h.matched_by.some((m) => LEXICAL.includes(m)))).toBe(true);
		const off = await contextFor({ kind: "owner", userId: OWNER }, { EMBEDDINGS: "off" } as Partial<Env>);
		const ranks = async (opts?: RecallOptions) => (await recallOf(off, { keyword: word, profile: "test" }, opts)).results.map((h) => `${h.profile}:${h.memory_id}`);
		expect(await ranks({ channels: ["lexical"] })).toEqual(await ranks());
	});

	it("keeps eval scores, candidates and strength inside their bounds", async () => {
		const ok = { profile: "test", at: "2026-11-04T10:00:00Z", channels: "hybrid", k: 5, cases: 3, recall_all_at_k: 0.5, any_hit_at_k: 1, mrr: 0.25 };
		expect(parseEvalRun(ok)).toEqual({ ok: true, value: ok });
		for (const bad of [{ ...ok, mrr: 1.5 }, { ...ok, k: 0 }, { ...ok, at: "yesterday" }, { ...ok, channels: "sql" }, { ...ok, query: "private case text" }]) {
			expect(parseEvalRun(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "validation" } });
		}
		const c = await contextFor();
		const tag = crypto.randomUUID().slice(0, 8);
		await runInDurableObject(profileStub(c, "test"), (_i, s) => {
			const sql = s.storage.sql, now = new Date().toISOString(), seq = () => nextSeq(sql, "profile_meta");
			const op = (o: Partial<{ query: string; expected: string[]; evidence: { kind: string; ref: string; note?: string }[] }> = {}) =>
				({ query: "where is the retry rule", expected: [`n-${tag}`], evidence: [{ kind: "node", ref: `n-${tag}` }], ...o }) as never;
			const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as { failure?: { code: string } }).failure?.code; } };
			expect(code(() => insertCandidate(sql, seq(), now, `c1-${tag}`, op({ query: "q".repeat(281) })))).toBe("validation");
			expect(code(() => insertCandidate(sql, seq(), now, `c1-${tag}`, op({ expected: Array.from({ length: 21 }, (_, i) => `n${i}`) })))).toBe("validation");
			expect(code(() => insertCandidate(sql, seq(), now, `c1-${tag}`, op({ evidence: [{ kind: "node", ref: "x", extra: 1 } as never] })))).toBe("validation");
			sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, 'test-fence')", `wiped:w-${tag}`);
			expect(code(() => insertCandidate(sql, seq(), now, `c1-${tag}`, op({ evidence: [{ kind: "node", ref: `w-${tag}` }] })))).toBe("profile_wiped");
			const first = insertCandidate(sql, seq(), now, `c1-${tag}`, op());
			expect(insertCandidate(sql, seq(), now, `c1-${tag}`, op({ query: "a different query" }))).toEqual(first);
			insertCandidate(sql, seq(), now, `c2-${tag}`, op());
			const mine = (rows: { id: string }[]) => rows.map((r) => r.id).filter((id) => id.endsWith(tag));
			expect(decideCandidate(sql, seq(), `c1-${tag}`, "accepted")).toMatchObject({ status: "accepted" });
			expect(decideCandidate(sql, seq(), `c2-${tag}`, "dismissed")).toMatchObject({ status: "dismissed" });
			expect(mine(acceptedCandidates(sql, null, 100).rows)).toEqual([`c1-${tag}`]);
			expect(mine(listCandidates(sql, {}).rows)).toEqual([]);
			// A later wipe fence on an expected id hides the candidate from every read and refuses a decision.
			sql.exec("INSERT INTO profile_meta (key, value) VALUES (?, 'test-fence')", `wiped:n-${tag}`);
			expect(mine(listCandidates(sql, { status: "all" }).rows)).toEqual([]);
			expect(code(() => decideCandidate(sql, seq(), `c2-${tag}`, "accepted"))).toBe("profile_wiped");
			// Strength: hits within the 90 UTC days ending today, capped at 10.
			const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
			sql.exec("INSERT INTO recall_daily (node_id, day, hits, seq) VALUES (?, ?, 7, 1), (?, ?, 5, 1), (?, ?, 100, 1)", `s-${tag}`, day(0), `s-${tag}`, day(89), `s-${tag}`, day(90));
			expect(recallStrength(sql, [`s-${tag}`, `none-${tag}`], day(0))).toEqual({
				[`s-${tag}`]: { hits_90d: 12, strength: 10, last_recalled: day(0) }, [`none-${tag}`]: { hits_90d: 0, strength: 0, last_recalled: null } });
		});
	});
});
