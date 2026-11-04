// v2 routes (X spine wiring). Each block authenticates, validates and calls the module that owns the logic. Device routes run
// before api.ts's owner check; owner routes only after it, so /api/* stays owner-only and device tokens never reach them.
import type { AccountContext, AccountStore, Principal } from "./account/store";
import { authenticate } from "./auth";
import { type Outcome } from "./domain/types";
import { accountStub } from "./mcp";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, unavailable: 503, busy: 409, revision_conflict: 409, profile_wiped: 410 };
export const reply = (r: Outcome<unknown>) => (r.ok ? json(r.value) : json({ error: r.error }, STATUS[r.error.code] ?? 400));
export const invalid = (message: string) => json({ error: { code: "validation", message } }, 400);
type Waiter = (p: Promise<unknown>) => void;

/** A device token (or an OAuth owner token on the resource audience) with its account context; revoked or disabled devices fail in context(). */
async function deviceCaller(request: Request, env: Env): Promise<Response | AccountContext> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return json({ error: { code: "unauthorized", message: auth.description ?? auth.error } }, auth.status);
	const ctx = await accountStub(env, env.OWNER_USER_ID!).context(auth.principal as Principal);
	return ctx.ok ? ctx.value : json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
}

/**
 * Device routes. Null for any other path. /v1/whoami answers here only for an am_ device token: an enabled device gets its own
 * id, scopes and profiles; the owner's reply stays in api.ts unchanged.
 */
export async function deviceV2(request: Request, env: Env, url: URL, _waitUntil: Waiter | undefined): Promise<Response | null> {
	const path = url.pathname, method = request.method;
	if (path === "/v1/whoami" && method === "GET") {
		if (!/^Bearer\s+am_/i.test(request.headers.get("authorization") ?? "")) return null;
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		return json({ kind: "device", device_id: c.caller.deviceId, scopes: c.caller.scopes, profiles: c.caller.profiles === "*" ? c.known : c.caller.profiles });
	}
	return null;
}

/** Owner routes; api.ts calls this only after its owner check. Null for any other path. */
export async function ownerV2(_request: Request, _env: Env, _url: URL, _ctx: AccountContext, _account: Pick<AccountStore, "admin">,
	_claims: Record<string, unknown> | undefined, _waitUntil: Waiter | undefined): Promise<Response | null> {
	return null;
}
