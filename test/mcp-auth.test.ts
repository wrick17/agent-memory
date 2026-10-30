// The Worker's /mcp path end to end: auth, both protocol eras, tools/list by scope, save then recall.
// Tokens are signed with a test key; this proves the verifier's rules, not Clerk's real tokens (G1 stays open).
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetKeyCache } from "../src/auth";
import { egressFetch } from "../src/egress";
import { settingsMain } from "../src/settings";
import wranglerConfig from "../wrangler.jsonc?raw";
import { call, contextFor, deviceToken, outcome, registered } from "./helpers";

let keys: CryptoKeyPair;
const KID = "test-key-1";
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function jwt(claims: Record<string, unknown>, kid = KID): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const body = { iss: env.CLERK_ISSUER, sub: env.OWNER_USER_ID, aud: [env.RESOURCE_URL], scope: "memory offline_access", iat: now, nbf: now, exp: now + 3600, ...claims };
	const signing = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(body)}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signing));
	return `${signing}.${b64url(sig)}`;
}

let jwksCalls: string[] = [];
beforeAll(async () => {
	keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
});
const original = globalThis.fetch;
function serveJwks() {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		jwksCalls.push(url);
		if (url === `${env.CLERK_FRONTEND_API}/.well-known/jwks.json`) {
			const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
			return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
		}
		return original(input);
	});
}
afterEach(() => { vi.restoreAllMocks(); resetKeyCache(); jwksCalls = []; });

const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
let rpcId = 1;
async function rpc(token: string | null, method: string, params: Record<string, unknown> = {}, era: "modern" | "legacy" = "modern", headers: Record<string, string> = {}) {
	const res = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/mcp`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}),
			// 2026-07-28 clients send the method (and the tool name) as headers too.
			...(era === "modern" ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) } : {}), ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: era === "modern" ? { ...params, _meta: MODERN_META } : params }),
	}));
	const text = await res.text();
	const sse = text.split("\n").find((l) => l.startsWith("data: "));
	const data = text.startsWith("{") ? JSON.parse(text) : sse ? JSON.parse(sse.slice(6)) : { text };
	return { status: res.status, headers: res.headers, data };
}
const toolResult = (data: { result?: { content?: { text: string }[]; isError?: boolean } }) => JSON.parse(data.result!.content![0]!.text) as Record<string, unknown>;

describe("auth", () => {
	it("challenges an unauthenticated call with protected-resource metadata", async () => {
		const res = await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/mcp`, { method: "POST", body: "{}" }));
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${new URL(env.RESOURCE_URL).origin}/.well-known/oauth-protected-resource/mcp", scope="memory"`);
		const prm = await (await exports.default.fetch(new Request(`${new URL(env.RESOURCE_URL).origin}/.well-known/oauth-protected-resource/mcp`))).json();
		expect(prm).toEqual({ resource: env.RESOURCE_URL, authorization_servers: [env.CLERK_ISSUER], scopes_supported: ["memory"], bearer_methods_supported: ["header"], resource_name: "Agent Memory" });
	});

	it("rejects wrong issuer, audience, owner, expiry, signature and missing scope", async () => {
		serveJwks();
		const cases: [Record<string, unknown>, number][] = [
			[{ iss: "https://other.clerk.test" }, 401], [{ aud: ["https://memory.test/other"] }, 401], [{ sub: "user_someoneelse" }, 401],
			[{ exp: Math.floor(Date.now() / 1000) - 120 }, 401], [{ scope: "offline_access" }, 403],
		];
		for (const [claims, status] of cases) expect((await rpc(await jwt(claims), "tools/list")).status).toBe(status);
		const tampered = (await jwt({})).replace(/\.[^.]+$/, ".AAAA");
		expect((await rpc(tampered, "tools/list")).status).toBe(401);
		expect((await rpc(await jwt({}, "unknown-kid"), "tools/list")).status).toBe(401);
		expect(jwksCalls.every((u) => u.startsWith(env.CLERK_FRONTEND_API))).toBe(true);
	});

	it("fails closed with 503 when the signing keys are unreachable on a cold cache", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("offline"); });
		await caches.default.delete(new Request(`${env.CLERK_FRONTEND_API}/.well-known/jwks.json`));
		expect((await rpc(await jwt({}), "tools/list")).status).toBe(503);
	});

	it("names the failing stage when the signing-key fetch is refused, and stays closed", async () => {
		// What a same-zone fetch to a Worker-backed hostname gets without global_fetch_strictly_public: a Cloudflare error page.
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("error code: 1042", { status: 403, headers: { "content-type": "text/plain" } }));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await caches.default.delete(new Request(`${env.CLERK_FRONTEND_API}/.well-known/jwks.json`));
		const r = await rpc(await jwt({}), "tools/list");
		expect(r.status).toBe(503);
		expect(r.data).toMatchObject({ error: "temporarily_unavailable", error_description: "signing keys are unavailable" });
		const line = logged.mock.calls.map((c) => String(c[0])).find((m) => m.includes("clerk_jwks_issue"));
		expect(JSON.parse(line!)).toMatchObject({ stage: "status", status: 403, cf_error: "1042" });
		expect(line).not.toMatch(/eyJ|Bearer/);
	});

	it("still verifies when the Cache API fails, since the cache only saves refetches", async () => {
		serveJwks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(caches.default, "match").mockRejectedValue(new Error("cache unavailable"));
		vi.spyOn(caches.default, "put").mockRejectedValue(new Error("cache unavailable"));
		expect((await rpc(await jwt({}), "tools/list")).status).toBe(200);
		expect((await rpc(await jwt({ aud: ["https://memory.test/other"] }), "tools/list")).status).toBe(401);
	});

	it("deploys with global_fetch_strictly_public, so the same-zone Clerk Frontend API is reached through public routing", () => {
		const config = JSON.parse(wranglerConfig.replace(/^\s*\/\/.*$/gm, "")) as { compatibility_flags: string[] };
		expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
	});

	it("fetches signing keys with the Workers-supported manual redirect mode and refuses a redirect without following it", async () => {
		const calls: { url: string; redirect: unknown }[] = [];
		let redirectOnce = true;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			calls.push({ url: String(input), redirect: init?.redirect });
			if (redirectOnce) return new Response(null, { status: 302, headers: { location: "https://evil.example/jwks.json" } });
			const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
			return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await caches.default.delete(new Request(`${env.CLERK_FRONTEND_API}/.well-known/jwks.json`));
		expect((await rpc(await jwt({}), "tools/list")).status).toBe(503);
		expect(calls).toEqual([{ url: `${env.CLERK_FRONTEND_API}/.well-known/jwks.json`, redirect: "manual" }]);
		const line = logged.mock.calls.map((c) => String(c[0])).find((m) => m.includes("clerk_jwks_issue"));
		expect(JSON.parse(line!)).toMatchObject({ stage: "fetch", error: expect.stringContaining("redirect (302)") });
		// A plain 200 key set from the same host still verifies.
		resetKeyCache();
		redirectOnce = false;
		expect((await rpc(await jwt({}), "tools/list")).status).toBe(200);
		expect(calls.slice(1).every((c) => c.redirect === "manual" && c.url.startsWith(env.CLERK_FRONTEND_API))).toBe(true);
	});

	it("allows egress only to the Clerk Frontend API host", async () => {
		await expect(egressFetch(env, "https://api.github.com/repos")).rejects.toThrow("not allowed");
		await expect(egressFetch(env, "http://clerk.memory.test/x")).rejects.toThrow("not allowed");
	});
});

describe("MCP over /mcp", () => {
	it("saves then recalls end to end on the 2026-07-28 protocol", async () => {
		serveJwks();
		const token = await jwt({});
		const list = await rpc(token, "tools/list");
		expect(list.status).toBe(200);
		expect((list.data.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(["append_memory", "capture_memory", "explore", "get_memory", "recall_memories", "record_knowledge", "review_candidates", "save_memory", "timeline", "trace", "work_board"]);
		const saved = await rpc(token, "tools/call", { name: "save_memory", arguments: { name: "Use pnpm in Sequoia repos", type: "feedback", description: "Package manager rule",
			content: "Run pnpm install and pnpm -w build. npm rewrites pnpm-lock.yaml.", origin: "stated", repo: { remote: "git@github.com:Sequoia-Engineering/web.git" }, request_id: "mcp-e2e-1" } });
		const s = toolResult(saved.data);
		expect(s).toMatchObject({ action: "created", profile: "work", routed_by: "rule:github.com/Sequoia-Engineering/*", revision: 1 });
		const recalled = await rpc(token, "tools/call", { name: "recall_memories", arguments: { keyword: "pnpm-lock", repo: { remote: "https://github.com/Sequoia-Engineering/web" }, token_budget: 2000 } });
		const r = toolResult(recalled.data);
		expect(r.read_set).toEqual(["work", "me"]);
		expect((r.results as { memory_id: string; matched_by: string[] }[])[0]).toMatchObject({ memory_id: s.memory_id, profile: "work" });
	});

	it("serves 2025-era stateless clients too", async () => {
		serveJwks();
		const token = await jwt({});
		const init = await rpc(token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }, "legacy");
		expect(init.status).toBe(200);
		expect(init.data.result.protocolVersion).toBe("2025-11-25");
		const list = await rpc(token, "tools/list", {}, "legacy", { "mcp-protocol-version": "2025-11-25" });
		expect(list.status).toBe(200);
		expect(list.data.result.tools).toHaveLength(11);
	});

	it("filters tools by device-token scope and revokes on the next request", async () => {
		const { id, token } = await deviceToken("reader-box", ["read"], ["personal", "me"], "personal");
		const list = await rpc(token, "tools/list");
		expect((list.data.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(["explore", "get_memory", "recall_memories", "review_candidates", "timeline", "trace", "work_board"]);
		const { accountStub } = await import("../src/mcp");
		await accountStub(env, env.OWNER_USER_ID).admin({ op: "revokeDevice", id });
		expect((await rpc(token, "tools/list")).status).toBe(401);
		expect((await rpc(token.replace(/.$/, (c) => (c === "0" ? "1" : "0")), "tools/list")).status).toBe(401);
	});

	it("refuses an expired device token whatever the timezone offset, and fails closed on a bad stored date", async () => {
		const { accountStub } = await import("../src/mcp");
		const { devicePrincipal } = await import("./helpers");
		const account = accountStub(env, env.OWNER_USER_ID);
		await deviceToken("seed-for-expiry", ["read"], ["test"]);
		const offset = (ms: number) => new Date(ms + 14 * 3_600_000).toISOString().slice(0, -1) + "+14:00";
		const expired = await account.admin({ op: "createDevice", name: "expired-offset", scopes: ["read"], profiles: ["test"], expiresAt: offset(Date.now() - 60_000) });
		const live = await account.admin({ op: "createDevice", name: "live-offset", scopes: ["read"], profiles: ["test"], expiresAt: offset(Date.now() + 3_600_000) });
		if (!expired.ok || !live.ok) throw new Error("device creation failed");
		expect(await account.context(devicePrincipal((expired.value as { token: string }).token))).toMatchObject({ ok: false, error: { code: "unauthorized" } });
		expect(await account.context(devicePrincipal((live.value as { token: string }).token))).toMatchObject({ ok: true });
		const id = (live.value as { id: string }).id;
		await runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)), (_i, state) => { state.storage.sql.exec("UPDATE devices SET expires_at = 'not a date' WHERE id = ?", id); });
		expect(await account.context(devicePrincipal((live.value as { token: string }).token))).toMatchObject({ ok: false, error: { code: "unauthorized" } });
	});

	it("refuses a foreign browser origin", async () => {
		serveJwks();
		expect((await rpc(await jwt({}), "tools/list", {}, "modern", { origin: "https://evil.example" })).status).toBe(403);
	});
});

describe("owner API", () => {
	it("pins, unpins, unflags and forgets a node as the owner, each undoable, and refuses device tokens", async () => {
		serveJwks();
		const session = await jwt({ aud: undefined, scope: undefined, azp: env.DASHBOARD_ORIGIN });
		const origin = new URL(env.RESOURCE_URL).origin;
		const post = (path: string, token = session) => exports.default.fetch(new Request(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }))
			.then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
		const c = await contextFor();
		const a = await call(c, "save_memory", { name: "Owner pinned preference", type: "user", description: "dark mode", content: "Prefers dark mode.", profile: "personal" });
		const pinned = await post(`/api/profiles/personal/nodes/${a.memory_id}/pin`);
		expect(pinned).toMatchObject({ status: 200, body: { action: "pinned", memory_id: a.memory_id } });
		expect(await call(c, "get_memory", { memory_id: a.memory_id })).toMatchObject({ revision: 2 });
		expect((await post(`/api/profiles/personal/activity/${String(pinned.body.activity_id)}/undo`)).status).toBe(200);
		expect((await post(`/api/profiles/personal/nodes/${a.memory_id}/pin`)).body).toMatchObject({ action: "pinned" });
		expect((await post(`/api/profiles/personal/nodes/${a.memory_id}/unpin`)).body).toMatchObject({ action: "unpinned" });
		expect((await post(`/api/profiles/personal/nodes/${a.memory_id}/unflag`)).body).toMatchObject({ action: "unflagged" });
		const forgotten = await post(`/api/profiles/personal/nodes/${a.memory_id}/forget`);
		expect(forgotten.body).toMatchObject({ action: "forgotten" });
		expect(await outcome(c, "get_memory", { memory_id: a.memory_id, include_retired: true })).toMatchObject({ ok: false, error: { code: "not_found" } });
		// Forget archives; its undo brings the memory back whole.
		expect((await post(`/api/profiles/personal/activity/${String(forgotten.body.activity_id)}/undo`)).status).toBe(200);
		expect(await call(c, "get_memory", { memory_id: a.memory_id })).toMatchObject({ content: "Prefers dark mode." });
		const { token } = await deviceToken("owner-actions-device", ["read", "write"], ["personal"], "personal");
		expect((await post(`/api/profiles/personal/nodes/${a.memory_id}/pin`, token)).status).toBe(403);
		expect((await post(`/api/profiles/nosuch/nodes/${a.memory_id}/pin`)).status).toBe(404);
		expect((await post(`/api/profiles/personal/nodes/not-a-node/pin`)).status).toBe(404);
	});

	it("records an unproven batch's skip from a job token, with no lease, and shows it only to the owner", async () => {
		serveJwks();
		const session = await jwt({ aud: undefined, scope: undefined, azp: env.DASHBOARD_ORIGIN });
		const origin = new URL(env.RESOURCE_URL).origin;
		const get = (path: string, token = session) => exports.default.fetch(new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } }))
			.then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
		const job = (await deviceToken(`batch-skip-job-${Date.now()}`, ["ingest", "maintenance"], ["work"])).token;
		const skip = (args: Record<string, unknown>) => rpc(job, "tools/call", { name: "maintenance_complete", arguments: { profile: "work", status: "batch_skipped", ...args } });
		expect(toolResult((await skip({ reason: "probe_indeterminate" })).data)).toEqual({ status: "batch_skipped", released: 0 });
		const shown = await get("/api/profiles/work/batch");
		expect(shown.status).toBe(200);
		expect(shown.body).toMatchObject({ last_status: { status: "batch_skipped", reason: "probe_indeterminate", items: 0 } });
		// A reason that is not a content-free code, or a park without a lease, is refused before the store.
		expect((await skip({ reason: "probe failed: /Users/x" })).data.result.isError).toBe(true);
		expect((await rpc(job, "tools/call", { name: "maintenance_complete", arguments: { profile: "work", status: "stuck", reason: "tool_event" } })).data.result.isError).toBe(true);
		expect((await get("/api/profiles/work/batch")).body).toMatchObject({ last_status: { reason: "probe_indeterminate" } });
		// The profile it may not use, a device token on the owner's route, and an unknown profile.
		expect((await rpc(job, "tools/call", { name: "maintenance_complete", arguments: { profile: "personal", status: "batch_skipped", reason: "probe_allowed" } })).data.result.isError).toBe(true);
		expect((await get("/api/profiles/work/batch", job)).status).toBe(403);
		expect((await get("/api/profiles/nosuch/batch")).status).toBe(404);
	});

	it("pages the owner model through the owner-only route, and its read writes nothing and stops at a closed generation", async () => {
		serveJwks();
		const session = await jwt({ aud: undefined, scope: undefined, azp: env.DASHBOARD_ORIGIN });
		const origin = new URL(env.RESOURCE_URL).origin;
		const get = (path: string, token = session) => exports.default.fetch(new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } }))
			.then(async (r) => ({ status: r.status, body: await r.json() as { items: { id: string; origin: string }[]; next_after: string | null; error?: { code: string } } }));
		const c = await contextFor();
		const stated = await call<{ memory_id: string }>(c, "save_memory", { name: `Prefers tabs ${Date.now()}`, type: "user", description: "indentation", origin: "stated", profile: "personal" });
		const agent = await call<{ memory_id: string }>(c, "save_memory", { name: `Prefers short replies ${Date.now()}`, type: "user", description: "length", profile: "personal" });
		// Other tests share this profile, so the check walks every page: each id once, stated before agent.
		const seen: string[] = [];
		for (let after: string | null = null, pages = 0; pages === 0 || after; pages++) {
			const page = await get(`/api/profiles/personal/owner-model?limit=1${after ? `&after=${encodeURIComponent(after)}` : ""}`);
			expect(page.status).toBe(200);
			seen.push(...page.body.items.map((i) => i.id));
			after = page.body.next_after;
		}
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.indexOf(stated.memory_id)).toBeGreaterThanOrEqual(0);
		expect(seen.indexOf(stated.memory_id)).toBeLessThan(seen.indexOf(agent.memory_id));
		for (const q of ["after=x", "limit=0", "limit=abc", "limit="]) expect(await get(`/api/profiles/personal/owner-model?${q}`).then((r) => [q, r.status, r.body.error?.code])).toEqual([q, 400, "validation"]);
		expect((await get("/api/profiles/nosuch/owner-model")).status).toBe(404);
		expect((await get("/api/profiles/personal/owner-model", (await deviceToken(`owner-model-${Date.now()}`, ["read"], ["personal"], "personal")).token)).status).toBe(403);
		// A never-written profile reads empty and stays unbound; once its generation closes, the read is refused and writes nothing.
		const r = await registered("me");
		const meta = () => runInDurableObject(r.stub, (_i, s) => s.storage.sql.exec("SELECT key, value FROM profile_meta ORDER BY key").toArray());
		const before = await meta();
		expect(await r.stub.read(r.who, { kind: "owner_model", after: null, limit: 50 })).toEqual({ ok: true, value: { items: [], next_after: null } });
		expect(await meta()).toEqual(before);
		await r.account((sql) => sql.exec("UPDATE profiles SET status = 'wiping'"));
		expect(await r.stub.read(r.who, { kind: "owner_model", after: null, limit: 50 })).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(await meta()).toEqual(before);
	});

	it("ranks recorded tickets through work_board and the owner's board route at a fixed as_of, and refuses bad callers and inputs", async () => {
		serveJwks();
		const AS_OF = "2030-01-01T00:00:00.000Z", key = `jira:BRD-${Date.now()}`, closedKey = `${key}0`;
		const owner = await jwt({});
		expect(toolResult((await rpc(owner, "tools/call", { name: "record_knowledge", arguments: { profile: "work", nodes: [
			{ kind: "ticket", key, name: `${key} board flow`, attrs: { state: "open", priority: "High", assignee_is_owner: true } },
			{ kind: "ticket", key: closedKey, name: `${closedKey} board flow`, attrs: { state: "closed", priority: "Highest" } },
		] } })).data)).toMatchObject({ nodes: expect.any(Array) });
		type Board = { as_of: string; read_set?: string[]; items: { key: string; score: number; reasons: { text: string }[] }[] };
		const board = toolResult((await rpc(owner, "tools/call", { name: "work_board", arguments: { profile: "work", as_of: AS_OF, limit: 200 } })).data) as unknown as Board;
		expect(board).toMatchObject({ as_of: AS_OF, read_set: ["work", "me"], covers_only_uploaded_data: true });
		expect(board.items.find((i) => i.key === key)).toMatchObject({ score: 45, reasons: [{ text: "Priority High (+30)." }, { text: "Assigned to the owner (+15)." }] });
		expect(board.items.some((i) => i.key === closedKey)).toBe(false);
		const session = await jwt({ aud: undefined, scope: undefined, azp: env.DASHBOARD_ORIGIN });
		const origin = new URL(env.RESOURCE_URL).origin;
		const get = (path: string, token = session) => exports.default.fetch(new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } }))
			.then(async (r) => ({ status: r.status, body: await r.json() as Board }));
		const shown = await get(`/api/profiles/work/board?as_of=${AS_OF}&limit=200`);
		expect(shown.status).toBe(200);
		expect(shown.body.items.find((i) => i.key === key)).toMatchObject({ score: 45 });
		// Inputs, scopes, a foreign dashboard origin and a foreign MCP Origin are refused before any board is read.
		for (const q of ["as_of=soon", "limit=0", "extra=1"]) expect([q, (await get(`/api/profiles/work/board?${q}`)).status]).toEqual([q, 400]);
		expect((await get("/api/profiles/nosuch/board")).status).toBe(404);
		const reader = (await deviceToken(`board-reader-${Date.now()}`, ["read"], ["work"], "work")).token;
		expect((await get("/api/profiles/work/board", reader)).status).toBe(403);
		expect((await get("/api/profiles/work/board", await jwt({ aud: undefined, azp: "https://evil.example" }))).status).toBe(401);
		for (const args of [{ profile: "work", as_of: "soon" }, { profile: "work", extra: 1 }]) {
			expect((await rpc(owner, "tools/call", { name: "work_board", arguments: args })).data.result.isError).toBe(true);
		}
		const writer = (await deviceToken(`board-writer-${Date.now()}`, ["write"], ["work"], "work")).token;
		const denied = (await rpc(writer, "tools/call", { name: "work_board", arguments: { profile: "work" } })).data;
		expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true);
		expect(JSON.stringify(denied)).not.toContain(key);
		expect((await rpc(owner, "tools/call", { name: "work_board", arguments: { profile: "work" } }, "modern", { origin: "https://evil.example" })).status).toBe(403);
		// A never-written me reads an empty board and stays unbound; a closed generation is refused and writes nothing.
		const r = await registered("work", "me"), me = r.of("me");
		const meta = (stub: typeof me.stub) => runInDurableObject(stub, (_i, s) => s.storage.sql.exec("SELECT key, value FROM profile_meta ORDER BY key").toArray());
		const q = { kind: "board" as const, asOf: AS_OF, limit: 50, known: ["work", "me"] };
		const before = await meta(me.stub);
		expect(await me.stub.read(me.who, q)).toMatchObject({ ok: true, value: { items: [], total: 0 } });
		expect(await meta(me.stub)).toEqual(before);
		const closedBefore = await meta(r.stub);
		await r.account((sql) => sql.exec("UPDATE profiles SET status = 'wiping' WHERE name = 'work'"));
		expect(await r.stub.read(r.who, q)).toMatchObject({ ok: false, error: { code: "profile_wiped" } });
		expect(await meta(r.stub)).toEqual(closedBefore);
	});

	it("creates and lists device tokens with a dashboard session token, and refuses device tokens", async () => {
		serveJwks();
		const session = await jwt({ aud: undefined, scope: undefined, azp: env.DASHBOARD_ORIGIN });
		const origin = new URL(env.RESOURCE_URL).origin;
		const created = await exports.default.fetch(new Request(`${origin}/api/devices`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
			body: JSON.stringify({ name: "api-box", scopes: ["read", "write"], profiles: ["personal"], default_profile: "personal" }) }));
		expect(created.status).toBe(201);
		const body = await created.json() as { token: string };
		expect(body.token).toMatch(/^am_dev_[a-z2-7]{16}_[0-9a-f]{64}$/);
		const listed = await (await exports.default.fetch(new Request(`${origin}/api/devices`, { headers: { authorization: `Bearer ${session}` } }))).json() as { name: string; token_hash?: string }[];
		expect(listed.some((d) => d.name === "api-box" && !("token_hash" in d))).toBe(true);
		const asDevice = await exports.default.fetch(new Request(`${origin}/api/devices`, { headers: { authorization: `Bearer ${body.token}` } }));
		expect(asDevice.status).toBe(403);
		const foreign = await jwt({ aud: undefined, azp: "https://evil.example" });
		expect((await exports.default.fetch(new Request(`${origin}/api/devices`, { headers: { authorization: `Bearer ${foreign}` } }))).status).toBe(401);
		const whoami = await (await exports.default.fetch(new Request(`${origin}/v1/whoami`, { headers: { authorization: `Bearer ${await jwt({})}` } }))).json() as { claims: { aud: string[] } };
		expect(whoami.claims.aud).toContain(env.RESOURCE_URL);
		const page = await exports.default.fetch(new Request(`${origin}/settings`));
		const policy = Object.fromEntries(page.headers.get("content-security-policy")!.split("; ").map((d) => { const [name, ...src] = d.split(" "); return [name!, src]; }));
		// The dashboard shell and script are public like /settings, under the same policy and no-store; its data stays owner-only.
		const [app, appJs] = await Promise.all(["/app", "/app.js"].map((p) => exports.default.fetch(new Request(`${origin}${p}`))));
		expect([app!.status, app!.headers.get("content-security-policy"), app!.headers.get("cache-control"), appJs!.headers.get("content-type"), appJs!.headers.get("cache-control")])
			.toEqual([200, page.headers.get("content-security-policy"), "no-store", "text/javascript; charset=utf-8", "no-store"]);
		expect((await exports.default.fetch(new Request(`${origin}/api/profiles`))).status).toBe(401);
		const fapi = env.CLERK_FRONTEND_API, protect = "https://*.protect.clerk.com";
		// Clerk's documented sources (script, connect with any port, frame), blob: images from the live page, nothing broader.
		expect(policy).toEqual({
			"default-src": ["'none'"], "script-src": ["'self'", fapi, "https://challenges.cloudflare.com", protect], "connect-src": ["'self'", fapi, `${protect}:*`],
			"img-src": ["'self'", "https://img.clerk.com", "blob:"], "style-src": ["'self'", "'unsafe-inline'"], "frame-src": ["https://challenges.cloudflare.com", protect],
			"worker-src": ["'self'", "blob:"], "form-action": ["'self'"], "base-uri": ["'none'"], "frame-ancestors": ["'none'"],
		});
		// The only wildcard is Clerk's protect subdomain pattern; no universal or scheme-wide source, no unsafe script.
		for (const sources of Object.values(policy) as string[][]) {
			for (const src of sources) {
				expect(src.includes("*") ? src.replace(/:\*$/, "") === protect : true).toBe(true);
				expect(["*", "https:", "http:", "data:", "'unsafe-eval'"]).not.toContain(src);
			}
		}
		expect(policy["script-src"]).not.toContain("'unsafe-inline'");
		expect(await page.text()).toContain(`data-clerk-publishable-key="${env.CLERK_PUBLISHABLE_KEY}"`);
	});
});

/** A stand-in browser and ClerkJS 6 that enforce the SDK rule behind the live failure: no components unless load() got ui.ClerkUI. */
function fakeBrowser(o: { clerk?: boolean; ui?: boolean; loadError?: string; signedIn?: boolean } = {}) {
	type El = { textContent: string; hidden: boolean; children: unknown[]; appendChild(c: unknown): void; replaceChildren(): void; addEventListener(t: string, f: unknown): void };
	const els: Record<string, El> = {};
	const make = (): El => ({ textContent: "", hidden: true, children: [], appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; }, addEventListener() {} });
	const seen: { load?: { ui?: { ClerkUI?: unknown }; telemetry?: unknown }; mounted?: unknown; fetched: string[] } = { fetched: [] };
	const ClerkUI = function ClerkUI() {};
	const clerk = {
		user: o.signedIn ? { id: env.OWNER_USER_ID } : null,
		session: { getToken: async () => "session" },
		async load(opts: typeof seen.load) { seen.load = opts; if (o.loadError) throw new Error(o.loadError); },
		mountSignIn(target: unknown) {
			if (!seen.load?.ui?.ClerkUI) throw new Error("Clerk was not loaded with Ui components");
			seen.mounted = target;
		},
	};
	const win = {
		document: { readyState: "complete", getElementById: (id: string) => (els[id] ??= make()), createElement: () => make() },
		addEventListener() {},
		fetch: async (path: string) => { seen.fetched.push(path); return Response.json([]); },
		FormData: class {},
		...(o.clerk === false ? {} : { Clerk: clerk }),
		...(o.ui === false ? {} : { __internal_ClerkUICtor: ClerkUI }),
	};
	return { win, els, seen, ClerkUI };
}

describe("Settings page start-up", () => {
	it("loads ClerkJS with the UI constructor, then mounts sign-in", async () => {
		const b = fakeBrowser();
		await settingsMain(b.win);
		expect(b.els.status!.textContent).toBe("Sign in as the owner.");
		expect(b.seen.load).toEqual({ ui: { ClerkUI: b.ClerkUI }, telemetry: false });
		expect(b.seen.mounted).toBe(b.els.signin);
	});

	it("lists devices once signed in", async () => {
		const b = fakeBrowser({ signedIn: true });
		await settingsMain(b.win);
		expect(b.els.status!.textContent).toBe("Signed in.");
		expect(b.els.app!.hidden).toBe(false);
		expect(b.seen.fetched).toEqual(["/api/devices"]);
	});

	it("says which script failed to load, and surfaces a load() error", async () => {
		const noUi = fakeBrowser({ ui: false });
		await settingsMain(noUi.win);
		expect(noUi.els.status!.textContent).toMatch(/^Sign-in could not start: the Clerk UI bundle did not load/);
		expect(noUi.seen.load).toBeUndefined();
		const noClerk = fakeBrowser({ clerk: false });
		await settingsMain(noClerk.win);
		expect(noClerk.els.status!.textContent).toMatch(/^Sign-in could not start: ClerkJS did not load/);
		const failing = fakeBrowser({ loadError: "network down" });
		await settingsMain(failing.win);
		expect(failing.els.status!.textContent).toBe("Sign-in could not start: network down");
	});
});
