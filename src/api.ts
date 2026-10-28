// Owner-only REST: protected-resource metadata, whoami, device tokens and the minimal Settings page (sections 8 and 15).
import type { AccountCommand } from "./account/store";
import { authenticate, verifyJwt } from "./auth";
import { SCOPES } from "./domain/types";
import { z } from "zod";
import { PROFILE_NAME } from "./domain/types";
import { accountStub, profileStub } from "./mcp";
import { routeWrite } from "./routing";
import { SETTINGS_HTML, SETTINGS_JS } from "./settings";

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export function protectedResource(env: Env): Response {
	return json({ resource: env.RESOURCE_URL, authorization_servers: [env.CLERK_ISSUER], scopes_supported: [env.REQUIRED_SCOPE || "memory"],
		bearer_methods_supported: ["header"], resource_name: "Agent Memory" }, 200, { "cache-control": "max-age=300" });
}

export function challenge(env: Env, status: number, error?: string, description?: string): Response {
	const origin = new URL(env.RESOURCE_URL).origin;
	const parts = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, `scope="${env.REQUIRED_SCOPE || "memory"}"`];
	if (error) parts.push(`error="${error}"`);
	return json({ error: error ?? "unauthorized", error_description: description ?? "authentication required" }, status, { "www-authenticate": `Bearer ${parts.join(", ")}` });
}

/** The dashboard sends Clerk session tokens; scripts may send OAuth access tokens. Both must name the owner. */
async function owner(request: Request, env: Env) {
	const viaSession = await authenticate(request, env, "session", false);
	if (viaSession.ok || viaSession.status !== 401) return viaSession;
	const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
	return token && !token.startsWith("am_") ? verifyJwt(env, token, "resource") : viaSession;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return null;
	const raw = await request.text();
	if (raw.length > 1_048_576) return null;
	try { const v = JSON.parse(raw) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

// Clerk's required sources (clerk.com/docs/guides/secure/best-practices/csp-headers), and nothing broader. The Frontend API
// serves clerk-js, @clerk/ui and their chunks; Turnstile runs from challenges.cloudflare.com. Clerk's abuse and fraud
// protection runs on per-instance and per-client subdomains of protect.clerk.com (cdn. loads the bootstrap, client. is
// probed), on ports other than 443, so Clerk documents *.protect.clerk.com, with :* for connect-src. Do not narrow these
// to single hosts: that breaks sign-in protection. img-src blob: is from the live sign-in page; worker-src blob: is
// documented. Telemetry is off in the page, so clerk-telemetry.com is not allowed.
const PROTECT = "https://*.protect.clerk.com";
const CSP = (env: Env) => {
	const clerk = env.CLERK_FRONTEND_API;
	return [`default-src 'none'`, `script-src 'self' ${clerk} https://challenges.cloudflare.com ${PROTECT}`, `connect-src 'self' ${clerk} ${PROTECT}:*`,
		`img-src 'self' https://img.clerk.com blob:`, `style-src 'self' 'unsafe-inline'`, `frame-src https://challenges.cloudflare.com ${PROTECT}`,
		`worker-src 'self' blob:`, `form-action 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`].join("; ");
};

const rangeId = z.string().max(256);
const ingestSchema = z.object({
	session: z.object({ client: z.enum(["claude-code", "codex"]), id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
	repo: z.object({ remote: z.string().max(512).optional(), path: z.string().max(1024).optional() }).strict().optional(),
	profile: z.string().regex(PROFILE_NAME).optional(),
	digests: z.array(z.object({ range_id: rangeId, capture_status: z.enum(["heuristic", "consolidated"]), part_id: z.string().max(64),
		sha256: z.string().regex(/^[0-9a-f]{64}$/), body: z.string().max(16_384) }).strict()).max(64).default([]),
	manifests: z.array(z.object({ range_id: rangeId, parts: z.array(z.object({ part_id: z.string().max(64), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(512) }).strict()).max(16).default([]),
}).strict();
const stateSchema = z.object({ range_ids: z.array(rangeId).min(1).max(64), repo: ingestSchema.shape.repo, profile: ingestSchema.shape.profile }).strict();

/**
 * Capture upload and recovery for the job-scoped device token (scope `ingest`), routed like any write and never to `me`.
 * Only bounded digests and manifests are accepted: the strict body schema has no field for a raw transcript record, and every string is bounded.
 */
async function capture(request: Request, env: Env, path: "/v1/ingest" | "/v1/capture"): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	if (!ctx.value.caller.scopes.includes("ingest")) return json({ error: { code: "forbidden", message: "this token cannot upload captures" } }, 403);
	const raw = await body(request);
	const parsed = (path === "/v1/ingest" ? ingestSchema : stateSchema).safeParse(raw);
	if (!parsed.success) return json({ error: { code: "validation", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
	const input = parsed.data as z.infer<typeof stateSchema> & Partial<z.infer<typeof ingestSchema>>;
	const route = routeWrite(ctx.value.caller, ctx.value.rules, ctx.value.known, { ...(input.profile ? { profile: input.profile } : {}), ...(input.repo ? { repo: input.repo } : {}) });
	if (!route.ok) return json({ error: route.error }, route.error.code === "forbidden" ? 403 : 400);
	if (route.value.profile === "me") return json({ error: { code: "forbidden", message: "captures never go to me" } }, 403);
	const ref = ctx.value.profiles.find((p) => p.profile === route.value.profile)!;
	const res = path === "/v1/ingest"
		? await profileStub(env, ref).ingest(ref, { session: input.session!, digests: input.digests ?? [], manifests: input.manifests ?? [] })
		: await profileStub(env, ref).captureState(ref, input.range_ids);
	return res.ok ? json({ profile: route.value.profile, routed_by: route.value.routedBy, ...(path === "/v1/ingest" ? { results: res.value } : { ranges: res.value }) }) : json({ error: res.error }, 400);
}

export async function api(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if ((url.pathname === "/v1/ingest" || url.pathname === "/v1/capture") && request.method === "POST") return capture(request, env, url.pathname);
	if (url.pathname === "/settings" && request.method === "GET") {
		return new Response(SETTINGS_HTML(env), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP(env), "cache-control": "no-store" } });
	}
	if (url.pathname === "/settings.js" && request.method === "GET") {
		return new Response(SETTINGS_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
	}
	const auth = await owner(request, env);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	if (auth.principal.kind !== "owner") return json({ error: "forbidden" }, 403);
	if (url.pathname === "/v1/whoami" && request.method === "GET") return json({ claims: auth.claims });

	const account = accountStub(env, auth.principal.userId);
	const ctx = await account.context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	const run = async (cmd: AccountCommand) => {
		const r = await account.admin(cmd);
		return r.ok ? json(r.value, cmd.op === "createDevice" ? 201 : 200) : json({ error: r.error }, r.error.code === "not_found" ? 404 : 400);
	};
	const m = /^\/api\/devices\/([a-z2-7]{16})\/(revoke|default)$/.exec(url.pathname);
	if (url.pathname === "/api/profiles" && request.method === "GET") return run({ op: "listProfiles" });
	if (url.pathname === "/api/devices" && request.method === "GET") return run({ op: "listDevices" });
	if (url.pathname === "/api/devices" && request.method === "POST") {
		const b = await body(request);
		if (!b || typeof b.name !== "string") return json({ error: { code: "validation", message: "send JSON with name, scopes, profiles" } }, 400);
		const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s): s is (typeof SCOPES)[number] => SCOPES.includes(s as never)) : [];
		const profiles = Array.isArray(b.profiles) ? b.profiles.filter((p): p is string => typeof p === "string") : [];
		return run({ op: "createDevice", name: b.name, scopes, profiles, oauth: b.oauth === true,
			...(typeof b.default_profile === "string" ? { defaultProfile: b.default_profile } : {}),
			...(typeof b.expires_at === "string" ? { expiresAt: b.expires_at } : {}) });
	}
	if (m && request.method === "POST" && m[2] === "revoke") return run({ op: "revokeDevice", id: m[1]! });
	if (m && request.method === "POST" && m[2] === "default") {
		const b = await body(request);
		return run({ op: "setDeviceDefault", id: m[1]!, defaultProfile: typeof b?.default_profile === "string" ? b.default_profile : null });
	}
	return json({ error: "not_found" }, 404);
}
