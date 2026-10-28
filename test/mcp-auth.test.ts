// The Worker's /mcp path end to end: auth, both protocol eras, tools/list by scope, save then recall.
// Tokens are signed with a test key; this proves the verifier's rules, not Clerk's real tokens (G1 stays open).
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetKeyCache } from "../src/auth";
import { egressFetch } from "../src/egress";
import { deviceToken } from "./helpers";

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
		expect((list.data.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(["append_memory", "get_memory", "recall_memories", "save_memory"]);
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
		expect(list.data.result.tools).toHaveLength(4);
	});

	it("filters tools by device-token scope and revokes on the next request", async () => {
		const { id, token } = await deviceToken("reader-box", ["read"], ["personal", "me"], "personal");
		const list = await rpc(token, "tools/list");
		expect((list.data.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual(["get_memory", "recall_memories"]);
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
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(await page.text()).toContain(`data-clerk-publishable-key="${env.CLERK_PUBLISHABLE_KEY}"`);
	});
});
