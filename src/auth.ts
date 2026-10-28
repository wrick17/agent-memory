// Principal from a Clerk JWT, verified locally against Clerk's published signing keys, or from a device token (section 8).
import type { Principal } from "./account/store";
import { egressFetch } from "./egress";

export type AuthResult =
	| { ok: true; principal: Principal; claims?: Record<string, unknown> }
	| { ok: false; status: 401 | 403 | 503; error: "invalid_token" | "insufficient_scope" | "temporarily_unavailable"; description: string };

/** `resource`: an OAuth access token for /mcp (audience and scope). `session`: a Clerk session token from the dashboard origin. */
export type TokenUse = "resource" | "session";

const DEVICE = /^am_(dev|job|imp)_([a-z2-7]{16})_([0-9a-f]{64})$/;
const SKEW = 60;
const KEY_TTL_MS = 3_600_000;
const REFETCH_MS = 60_000;

let keyCache: { keys: Map<string, CryptoKey>; at: number } | undefined;
let lastFetch = 0;

/** For tests: forget cached keys between cases. */
export function resetKeyCache(): void {
	keyCache = undefined;
	lastFetch = 0;
}

const jwksUrl = (env: Env) => `${env.CLERK_FRONTEND_API.replace(/\/+$/, "")}/.well-known/jwks.json`;

/** A key-fetch failure with the stage it failed at, logged without any token or credential. */
class KeyFetchError extends Error {
	constructor(readonly stage: "fetch" | "status" | "parse", message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}

function logKeyIssue(stage: string, error: unknown, detail: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ event: "clerk_jwks_issue", stage, ...detail, error: String((error as Error)?.message ?? error).slice(0, 200) }));
}

async function fetchKeys(env: Env): Promise<Map<string, CryptoKey>> {
	const cacheKey = new Request(jwksUrl(env));
	// The Cache API only saves refetches; if it fails, fetch the keys directly instead of failing sign-in.
	let res = await caches.default.match(cacheKey).catch((e: unknown) => { logKeyIssue("cache_read", e); return undefined; });
	if (!res) {
		lastFetch = Date.now();
		try {
			res = await egressFetch(env, jwksUrl(env));
		} catch (e) {
			throw new KeyFetchError("fetch", (e as Error).message);
		}
		if (!res.ok) {
			// Cloudflare's own error pages carry an "error code: NNNN" (for example 1042 for a same-zone Worker); the page is public.
			const text = await res.text().catch(() => "");
			throw new KeyFetchError("status", `signing keys returned ${res.status}`, { status: res.status, cf_error: /error code:?\s*(\d{3,5})/i.exec(text)?.[1] ?? null });
		}
		await caches.default.put(cacheKey, new Response(res.clone().body, { headers: { "content-type": "application/json", "cache-control": "max-age=3600" } }))
			.catch((e: unknown) => logKeyIssue("cache_write", e));
	}
	let body: { keys?: (JsonWebKey & { kid?: string; alg?: string })[] };
	try {
		body = (await res.json()) as typeof body;
	} catch (e) {
		throw new KeyFetchError("parse", (e as Error).message);
	}
	const keys = new Map<string, CryptoKey>();
	for (const jwk of body.keys ?? []) {
		if (!jwk.kid || jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) continue;
		try {
			keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
		} catch (e) {
			// One unusable key must not hide the others; a token naming it gets 401 unknown signing key.
			logKeyIssue("import", e, { kid: jwk.kid });
		}
	}
	return keys;
}

/** Keys live in isolate memory and the Cache API for an hour; an unknown kid refetches at most once a minute. */
async function keyFor(env: Env, kid: string): Promise<CryptoKey | undefined> {
	if (!keyCache || Date.now() - keyCache.at > KEY_TTL_MS) keyCache = { keys: await fetchKeys(env), at: Date.now() };
	if (!keyCache.keys.has(kid) && Date.now() - lastFetch > REFETCH_MS) {
		await caches.default.delete(new Request(jwksUrl(env)));
		keyCache = { keys: await fetchKeys(env), at: Date.now() };
	}
	return keyCache.keys.get(kid);
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

const invalid = (description: string): AuthResult => ({ ok: false, status: 401, error: "invalid_token", description });

export async function verifyJwt(env: Env, token: string, use: TokenUse): Promise<AuthResult> {
	const parts = token.split(".");
	if (parts.length !== 3) return invalid("malformed token");
	let header: Record<string, unknown>, claims: Record<string, unknown>;
	try { header = b64urlJson(parts[0]!); claims = b64urlJson(parts[1]!); } catch { return invalid("malformed token"); }
	if (header.alg !== "RS256" || typeof header.kid !== "string") return invalid("unsupported signing algorithm");
	let key: CryptoKey | undefined;
	try { key = await keyFor(env, header.kid); } catch (e) {
		// Fail closed: no key, no verification. The log names the failing stage so an outage is diagnosable.
		logKeyIssue(e instanceof KeyFetchError ? e.stage : "unknown", e, e instanceof KeyFetchError ? e.detail : {});
		return { ok: false, status: 503, error: "temporarily_unavailable", description: "signing keys are unavailable" };
	}
	if (!key) return invalid("unknown signing key");
	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]!), signed))) return invalid("bad signature");
	const now = Math.floor(Date.now() / 1000);
	if (!env.CLERK_ISSUER || claims.iss !== env.CLERK_ISSUER) return invalid("wrong issuer");
	if (typeof claims.exp !== "number" || claims.exp + SKEW < now) return invalid("token expired");
	if (typeof claims.nbf === "number" && claims.nbf - SKEW > now) return invalid("token not yet valid");
	if (!env.OWNER_USER_ID || claims.sub !== env.OWNER_USER_ID) return invalid("not the owner");
	if (use === "resource") {
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(env.RESOURCE_URL)) return invalid("wrong audience");
		const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : Array.isArray(claims.scp) ? (claims.scp as string[]) : [];
		// The audience and the scope are both required; an unset REQUIRED_SCOPE refuses rather than skips the check.
		if (!env.REQUIRED_SCOPE || !scopes.includes(env.REQUIRED_SCOPE)) {
			return { ok: false, status: 403, error: "insufficient_scope", description: `the token lacks scope ${env.REQUIRED_SCOPE || "(unset)"}` };
		}
	} else if (claims.azp !== env.DASHBOARD_ORIGIN) {
		return invalid("session token from another origin");
	}
	return { ok: true, principal: { kind: "owner", userId: claims.sub as string }, claims };
}

/** Bearer device token or Clerk JWT. Device tokens are not accepted where `allowDevice` is false (owner-only API). */
export async function authenticate(request: Request, env: Env, use: TokenUse, allowDevice: boolean): Promise<AuthResult> {
	const header = request.headers.get("authorization") ?? "";
	const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
	if (!token) return invalid("missing bearer token");
	const device = DEVICE.exec(token);
	if (device) {
		if (!allowDevice) return { ok: false, status: 403, error: "insufficient_scope", description: "device tokens cannot use the owner API" };
		return { ok: true, principal: { kind: "device", id: device[2]!, secret: device[3]! } };
	}
	if (token.startsWith("am_")) return invalid("malformed device token");
	const result = await verifyJwt(env, token, use);
	if (result.ok && result.principal.kind === "owner") {
		const name = request.headers.get("x-agent-memory-device");
		if (name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) result.principal.device = name;
	}
	return result;
}
