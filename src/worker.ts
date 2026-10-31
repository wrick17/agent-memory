// fetch(): /mcp, /v1/whoami, /api/*, /settings, the dashboard at / (and /app) and protected-resource metadata. Stateless between requests.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { api, challenge, protectedResource } from "./api";
import { authenticate } from "./auth";
import { accountStub, buildServer, type ToolContext } from "./mcp";

export { AccountStore } from "./account/store";
export { ProfileStore } from "./profile/store";
export { CorpusStore } from "./corpus/store";

// One handler for the isolate; each request gets a fresh server built from its own authenticated context.
const handler = createMcpHandler((rc) => buildServer(rc.authInfo!.extra!.tools as ToolContext), { legacy: "stateless", responseMode: "json" });

/** Browser requests must come from our own origins; clients without an Origin header are fine (MCP transport rule). */
function originAllowed(request: Request, env: Env): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	return [new URL(env.RESOURCE_URL).origin, env.DASHBOARD_ORIGIN].includes(origin);
}

async function mcp(request: Request, env: Env): Promise<Response> {
	if (!originAllowed(request, env)) return new Response("forbidden origin", { status: 403 });
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.status === 401 && !request.headers.get("authorization") ? undefined : auth.error, auth.description);
	const account = await accountStub(env, env.OWNER_USER_ID ?? "").context(auth.principal);
	if (!account.ok) return account.error.code === "unavailable" ? new Response("account unavailable", { status: 503 }) : challenge(env, 401, "invalid_token", account.error.message);
	const caller = account.value.caller;
	const tools: ToolContext = { env, caller, account: account.value, platform: `${caller.kind}:${caller.deviceName ?? "unknown"}` };
	return handler.fetch(request, { authInfo: { token: "", clientId: caller.deviceName ?? caller.kind, scopes: caller.scopes, extra: { tools } } });
}

export default {
	async fetch(request, env): Promise<Response> {
		if (!env.OWNER_USER_ID) return new Response("OWNER_USER_ID is not configured", { status: 503 });
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") return protectedResource(env);
		if (pathname === "/mcp") return mcp(request, env);
		if (pathname.startsWith("/api/") || pathname.startsWith("/v1/") || pathname === "/settings" || pathname === "/settings.js" || pathname === "/" || pathname === "/app" || pathname === "/app.js") return api(request, env);
		return new Response("not found", { status: 404 });
	},
	// The nightly export of every active profile and the account (section 18); a failure is kept as last_export_failed.
	async scheduled(_event, env, ctx): Promise<void> {
		if (env.OWNER_USER_ID) ctx.waitUntil(accountStub(env, env.OWNER_USER_ID).admin({ op: "export" }));
	},
} satisfies ExportedHandler<Env>;
