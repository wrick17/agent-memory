// Readable rewrites (docs/self-host.md): the dashboard shows a plain-English rewrite of long entry text, written by gpt-6-luna on
// the owner's ChatGPT plan. Two backends generate rewrites the cache lacks. The rewriter service (local/rewriter.mjs, set by
// READABLE_REWRITER_URL and the secret READABLE_REWRITER_TOKEN) wins when set. Otherwise, with READABLE_REWRITES=chatgpt-local,
// the Worker calls OpenAI itself through the open "Sign in with ChatGPT" plan-usage flow (developers.openai.com/siwc), which
// is for locally hosted apps only: its callback must be http://127.0.0.1:<port>/auth/callback. The browser never calls OpenAI or
// the rewriter and never sees a token: the AccountStore holds the ChatGPT credentials and the cache (ReadableVault, in tables
// kept out of exports) and the Worker makes every outside call through egress.ts.
import { b64urlBytes, b64urlJson } from "./auth";
import { sha256 } from "./domain/ids";
import { MAX_TEXT, MAX_TEXTS, MODEL, PROMPT, PROMPT_VERSION, rewriteInput, rewriteItems, rewriteResults, SCHEMA, type RewriteItem } from "./domain/rewrite";
import { egressFetch } from "./egress";

declare global { interface Env { READABLE_REWRITES?: string; READABLE_REWRITER_URL?: string; READABLE_REWRITER_TOKEN?: string } }

/** The Sign in with ChatGPT backend (local only). */
export const siwcOn = (env: Env): boolean => env.READABLE_REWRITES === "chatgpt-local";
/** The rewriter-service backend (local/rewriter.mjs): it generates rewrites whenever its URL and token are set. */
export const rewriterOn = (env: Env): boolean => !!env.READABLE_REWRITER_URL && !!env.READABLE_REWRITER_TOKEN;
export const readableOn = (env: Env): boolean => siwcOn(env) || rewriterOn(env);

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`, TOKEN = `${ISSUER}/api/accounts/oauth/token`, JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const DYNAMIC = "dynamic_agent_client";
const APP_NAME = "Agent Memory";
export const CALLBACK_PATH = "/auth/callback";
const PENDING_MS = 10 * 60_000, REFRESH_EARLY_MS = 120_000, SKEW_S = 5;
const LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

type Credentials = { subject: string; email: string | null; client_id: string; id_token: string; access_token: string; refresh_token: string | null;
	expires_at: number; scopes: string[]; saved_at: string };
type Account = { client_id: string; subject: string; email: string | null };
type Pending = { nonce: string; verifier: string; client_id: string; redirect_uri: string; at: number; session: number };
export type ReadableOp =
	| { op: "status" }
	| { op: "begin"; redirect_uri: string }
	| { op: "finish"; state: string; code: string | null; client_id: string | null; error: string | null }
	| { op: "token" }
	| { op: "model"; available: boolean }
	| { op: "disconnect" }
	| { op: "get"; keys: string[] }
	| { op: "put"; epoch: number; rows: { key: string; rewrite: string }[] };
export type Status = { connected: boolean; email: string | null; model: boolean | null; backend: "chatgpt" | "rewriter" };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields).toString() });
const jsonOf = async (res: Response): Promise<Record<string, unknown>> => { try { const v = await res.json(); return v && typeof v === "object" ? v as Record<string, unknown> : {}; } catch { return {}; } };
/** A failure's diagnostic facts, never a token: status, error code and request id. */
const logIssue = (event: string, res: Response | null, detail: Record<string, unknown> = {}) =>
	console.error(JSON.stringify({ event: `readable_${event}`, status: res?.status ?? null, request_id: res?.headers.get("x-request-id") ?? res?.headers.get("openai-request-id") ?? null, ...detail }));

/** Verifies an OpenAI ID token: RS256 signature against OpenAI's JWKS, issuer, audience, expiry and the attempt's nonce. */
async function verifyIdToken(env: Env, token: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("the ID token is malformed");
	const header = b64urlJson(parts[0]!), claims = b64urlJson(parts[1]!);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("the ID token uses an unsupported signature");
	const res = await egressFetch(env, JWKS);
	if (!res.ok) throw new Error(`OpenAI's signing keys returned ${res.status}`);
	const jwk = ((await jsonOf(res)).keys as (JsonWebKey & { kid?: string })[] | undefined ?? []).find((k) => k.kid === header.kid && k.kty === "RSA");
	if (!jwk) throw new Error("the ID token's signing key is unknown");
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) throw new Error("the ID token's signature is wrong");
	const now = Math.floor(Date.now() / 1000), aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== ISSUER) throw new Error("the ID token has the wrong issuer");
	if (!aud.includes(clientId)) throw new Error("the ID token has the wrong audience");
	if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw new Error("the ID token has expired");
	if (claims.nonce !== nonce) throw new Error("the ID token's nonce does not match this sign-in");
	if (typeof claims.sub !== "string" || !claims.sub) throw new Error("the ID token has no subject");
	return claims;
}

const DDL = [
	`CREATE TABLE IF NOT EXISTS readable_rewrites (text_sha256 TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, rewrite TEXT NOT NULL,
		created_at TEXT NOT NULL, PRIMARY KEY (text_sha256, model, prompt_version)) WITHOUT ROWID`,
	"CREATE TABLE IF NOT EXISTS readable_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
];
/** Kept out of account exports, checkpoints and restores: a derived cache and local OpenAI credentials, never backed up. */
export const READABLE_TABLES = ["readable_rewrites", "readable_auth"];

const hasCache = (sql: SqlStorage) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'readable_rewrites'").toArray().length > 0;
const bump = (sql: SqlStorage, key: string) => sql.exec(`INSERT INTO readable_auth (key, value) VALUES (?, '1')
	ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`, key);
/**
 * A profile wipe (src/wipe.ts) clears the cache: rewrites are keyed by text alone, so any row may hold the wiped profile's text.
 * The wipe bumps the cache epoch when it begins and again when it ends; a rewrite generated under an older epoch is not stored.
 * Each call deletes at most 100 rows, the wipe's page size; it returns how many it deleted. Without the tables it does nothing.
 */
export function purgeReadable(sql: SqlStorage, final: boolean): number {
	if (!hasCache(sql)) return 0;
	const n = sql.exec("DELETE FROM readable_rewrites WHERE (text_sha256, model, prompt_version) IN (SELECT text_sha256, model, prompt_version FROM readable_rewrites LIMIT 100)").rowsWritten;
	if (!n || final) bump(sql, "cache_epoch");
	return n;
}

/**
 * The AccountStore side: OAuth attempts, the owner's ChatGPT credentials and the rewrite cache. The tables are created on first
 * use, so a Worker without the option never has them. One vault per object instance, so refreshes are serialized.
 */
export class ReadableVault {
	private refreshing?: Promise<string | null>;
	constructor(private readonly sql: SqlStorage, private readonly env: Env) { for (const s of DDL) sql.exec(s); }

	private read<T>(key: string): T | null {
		const v = this.sql.exec<{ value: string }>("SELECT value FROM readable_auth WHERE key = ?", key).toArray()[0]?.value;
		return v === undefined ? null : JSON.parse(v) as T;
	}
	/** Bumped by Disconnect: a sign-in or refresh that began under an older value never saves tokens. */
	private session(): number { return this.read<number>("session") ?? 0; }
	private write(key: string, value: unknown): void {
		if (value === null) this.sql.exec("DELETE FROM readable_auth WHERE key = ?", key);
		else this.sql.exec("INSERT OR REPLACE INTO readable_auth (key, value) VALUES (?, ?)", key, JSON.stringify(value));
	}

	async run(op: ReadableOp): Promise<unknown> {
		switch (op.op) {
			case "status": { const c = this.read<Credentials>("credentials"); return { connected: !!c, email: c?.email ?? null, model: c ? this.read<boolean>("model") : null, backend: "chatgpt" } satisfies Status; }
			case "begin": return this.begin(op.redirect_uri);
			case "finish": return this.finish(op);
			case "token": return this.token();
			case "model": this.write("model", op.available); return null;
			case "disconnect": return this.disconnect();
			case "get": {
				const out: Record<string, string> = {};
				const epoch = this.read<number>("cache_epoch") ?? 0;
				for (const k of op.keys) {
					const r = this.sql.exec<{ rewrite: string }>("SELECT rewrite FROM readable_rewrites WHERE text_sha256 = ? AND model = ? AND prompt_version = ?", k, MODEL, PROMPT_VERSION).toArray()[0];
					if (r) out[k] = r.rewrite;
				}
				return { rewrites: out, epoch };
			}
			case "put": {
				// A wipe since this request read the cache: its rewrites may hold wiped text, so they are dropped.
				if ((this.read<number>("cache_epoch") ?? 0) !== op.epoch) return null;
				const at = new Date().toISOString();
				for (const r of op.rows) this.sql.exec("INSERT OR REPLACE INTO readable_rewrites (text_sha256, model, prompt_version, rewrite, created_at) VALUES (?, ?, ?, ?, ?)", r.key, MODEL, PROMPT_VERSION, r.rewrite, at);
				return null;
			}
		}
	}

	/** A fresh state, nonce and PKCE S256 verifier for this attempt; the host id is made once, before the first sign-in. */
	private async begin(redirectUri: string): Promise<{ url: string }> {
		let host = this.read<string>("host_id");
		if (!host) { host = `urn:uuid:${crypto.randomUUID()}`; this.write("host_id", host); }
		const account = this.read<Account>("account"), clientId = account?.client_id ?? DYNAMIC;
		const state = random(), nonce = random(), verifier = random();
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
		this.sql.exec("DELETE FROM readable_auth WHERE key LIKE 'pending:%' AND CAST(json_extract(value, '$.at') AS INTEGER) < ?", Date.now() - PENDING_MS);
		this.write(`pending:${state}`, { nonce, verifier, client_id: clientId, redirect_uri: redirectUri, at: Date.now(), session: this.session() } satisfies Pending);
		const q = new URLSearchParams({ client_id: clientId, ...(clientId === DYNAMIC ? { agent_name_hint: APP_NAME } : {}), ext_agent_host_id: host,
			...(account?.email && clientId !== DYNAMIC ? { login_hint: account.email } : {}), response_type: "code", redirect_uri: redirectUri, scope: SCOPES,
			resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge });
		return { url: `${AUTHORIZE}?${q}` };
	}

	/** The callback: the state is taken once (a reused or unknown state fails), then the code exchange and ID-token checks. */
	private async finish(op: Extract<ReadableOp, { op: "finish" }>): Promise<{ ok: boolean; message: string }> {
		const pending = this.read<Pending>(`pending:${op.state}`);
		this.write(`pending:${op.state}`, null);
		if (!pending || pending.at < Date.now() - PENDING_MS) return { ok: false, message: "This sign-in link is old or was already used. Start again from the dashboard." };
		if (op.error) return { ok: false, message: op.error === "access_denied" ? "ChatGPT access was declined, so rewrites stay off." : `ChatGPT sign-in failed (${op.error.slice(0, 80)}).` };
		if (!op.code) return { ok: false, message: "ChatGPT sign-in returned no code. Start again from the dashboard." };
		let clientId = pending.client_id;
		if (clientId === DYNAMIC) {
			if (!op.client_id || !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(op.client_id)) return { ok: false, message: "ChatGPT did not finish registering this app. Start again from the dashboard." };
			clientId = op.client_id;
		} else if (op.client_id && op.client_id !== clientId) return { ok: false, message: "ChatGPT returned a different app registration. Nothing was changed." };
		const res = await egressFetch(this.env, TOKEN, form({ grant_type: "authorization_code", client_id: clientId, code: op.code, code_verifier: pending.verifier, redirect_uri: pending.redirect_uri, resource: RESOURCE }));
		const t = await jsonOf(res);
		if (!res.ok || typeof t.access_token !== "string" || typeof t.id_token !== "string") {
			logIssue("token_exchange", res, { error: typeof t.error === "string" ? t.error : null });
			return { ok: false, message: `ChatGPT sign-in failed at the code exchange (${res.status}). Start again from the dashboard.` };
		}
		let claims: Record<string, unknown>;
		try { claims = await verifyIdToken(this.env, t.id_token, clientId, pending.nonce); } catch (e) { return { ok: false, message: `ChatGPT sign-in was refused: ${(e as Error).message}.` }; }
		if (pending.session !== this.session()) return { ok: false, message: "ChatGPT was disconnected during this sign-in. Nothing was saved; connect again." };
		const prior = this.read<Account>("account");
		if (prior && prior.client_id === clientId && prior.subject !== claims.sub) return { ok: false, message: "That is a different ChatGPT account from the one this app was registered with. Nothing was changed." };
		const email = typeof claims.email === "string" ? claims.email : null, scopes = typeof t.scope === "string" ? t.scope.split(" ").filter(Boolean) : [];
		this.write("account", { client_id: clientId, subject: claims.sub as string, email } satisfies Account);
		if (!scopes.includes(PLAN_SCOPE)) return { ok: false, message: "ChatGPT plan use was not allowed, so rewrites stay off. Connect again and allow it." };
		this.write("credentials", { subject: claims.sub as string, email, client_id: clientId, id_token: t.id_token, access_token: t.access_token,
			refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : null, expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000, scopes,
			saved_at: new Date().toISOString() } satisfies Credentials);
		const model = await modelAvailable(this.env, t.access_token), session = this.session();
		if (pending.session === session) this.write("model", model);
		return { ok: true, message: "Connected." };
	}

	/** A usable access token, refreshed near expiry; null when not connected or the refresh token is no longer usable. */
	private async token(): Promise<string | null> {
		const c = this.read<Credentials>("credentials");
		if (!c) return null;
		if (c.expires_at - REFRESH_EARLY_MS > Date.now()) return c.access_token;
		if (!c.refresh_token) { this.write("credentials", null); return null; }
		this.refreshing ??= this.refresh(c).finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}
	private async refresh(c: Credentials): Promise<string | null> {
		const session = this.session();
		const res = await egressFetch(this.env, TOKEN, form({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: c.refresh_token!, resource: RESOURCE }));
		const t = await jsonOf(res);
		if (session !== this.session()) {
			// Disconnected while the refresh was out: keep nothing, and revoke the replacement it may have issued.
			if (typeof t.refresh_token === "string") await this.revoke(t.refresh_token, c.client_id);
			return null;
		}
		if (res.ok && typeof t.access_token === "string") {
			this.write("credentials", { ...c, access_token: t.access_token, refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : c.refresh_token,
				expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000, scopes: typeof t.scope === "string" ? t.scope.split(" ").filter(Boolean) : c.scopes, saved_at: new Date().toISOString() });
			return t.access_token;
		}
		logIssue("refresh", res, { error: typeof t.error === "string" ? t.error : null });
		// An unusable refresh token (invalid_grant and its kin) ends the session; a network or server failure keeps the credentials.
		if (res.status === 400 || res.status === 401) { this.write("credentials", null); return null; }
		throw new Error(`ChatGPT token refresh failed (${res.status})`);
	}

	/** Revokes the refresh token at OpenAI when it can, then deletes the tokens either way. The app registration and host id stay. */
	private async disconnect(): Promise<{ revoked: boolean }> {
		// The session ends before any await, so a refresh or sign-in already in flight cannot save tokens after it.
		const c = this.read<Credentials>("credentials");
		bump(this.sql, "session");
		this.write("credentials", null);
		this.write("model", null);
		return { revoked: c?.refresh_token ? await this.revoke(c.refresh_token, c.client_id) : false };
	}
	private async revoke(token: string, clientId: string): Promise<boolean> {
		try {
			const endpoint = (await jsonOf(await egressFetch(this.env, `${ISSUER}/.well-known/openid-configuration`))).revocation_endpoint;
			return typeof endpoint === "string" && (await egressFetch(this.env, endpoint, form({ token, token_type_hint: "refresh_token", client_id: clientId }))).ok;
		} catch (e) { logIssue("revoke", null, { error: String((e as Error).message).slice(0, 200) }); return false; }
	}
}

/** Whether this account's model catalog lists MODEL; null when the catalog could not be read. */
async function modelAvailable(env: Env, token: string): Promise<boolean | null> {
	try {
		const res = await egressFetch(env, `${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` } });
		if (!res.ok) { logIssue("models", res); return null; }
		const models = (await jsonOf(res)).models;
		return Array.isArray(models) ? models.some((m) => (m as { slug?: unknown })?.slug === MODEL) : null;
	} catch { return null; }
}

// ---- The Worker side ----

const vault = (env: Env) => env.ACCOUNT.get(env.ACCOUNT.idFromName(env.OWNER_USER_ID)) as unknown as { readable(op: ReadableOp): Promise<unknown> };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

type Outcome = { state: "ok" } | { state: "limit" | "model_unavailable" | "not_connected" | "error"; message: string };
let formatAccepted = true; // shortcut: per isolate; a rejected text.format falls back to defensive parsing until the isolate restarts

/** One Responses call for a batch of texts, read as a stream to response.completed. Malformed results are dropped. */
async function viaChatgpt(env: Env, token: string, items: RewriteItem[]): Promise<{ results: Map<number, string> } & Outcome> {
	const body = { model: MODEL, instructions: PROMPT, input: [{ role: "user", content: rewriteInput(items) }],
		reasoning: { effort: "low" }, store: false, stream: true,
		...(formatAccepted ? { text: { format: { type: "json_schema", name: "rewrites", strict: true, schema: SCHEMA } } } : {}) };
	const res = await egressFetch(env, `${RESOURCE}/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
	const none = new Map<number, string>();
	if (!res.ok) {
		const j = await jsonOf(res), err = (j.error ?? {}) as { code?: unknown; param?: unknown }, code = typeof err.code === "string" ? err.code : null, param = typeof err.param === "string" ? err.param : "";
		logIssue("responses", res, { code, param: param || null });
		if (res.status === 429 || code === LIMIT_CODE) return { results: none, state: "limit", message: "ChatGPT plan limit reached." };
		if (res.status === 400 && formatAccepted && param.startsWith("text")) { formatAccepted = false; return viaChatgpt(env, token, items); }
		if (param === "model" || code === "model_not_found") { await vault(env).readable({ op: "model", available: false }); return { results: none, state: "model_unavailable", message: `${MODEL} is not available to this ChatGPT account.` }; }
		return { results: none, state: "error", message: `ChatGPT returned ${res.status}${code ? ` (${code})` : ""}.` };
	}
	let text = "", done: Record<string, unknown> | null = null, failed: string | null = null, buf = "";
	const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
	const handle = (block: string) => {
		const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
		if (!data || data === "[DONE]") return;
		let e: Record<string, unknown>;
		try { e = JSON.parse(data) as Record<string, unknown>; } catch { return; }
		if (e.type === "response.output_text.delta" && typeof e.delta === "string") text += e.delta;
		else if (e.type === "response.completed") done = (e.response ?? {}) as Record<string, unknown>;
		else if (e.type === "response.failed" || e.type === "response.incomplete" || e.type === "error") {
			const r = (e.response ?? e) as { error?: { code?: unknown } | null; code?: unknown };
			failed = String(r.error?.code ?? r.code ?? e.type);
		}
	};
	for (;;) {
		const { value, done: end } = await reader.read();
		if (value) buf += value;
		for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) { handle(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
		if (end) { if (buf.trim()) handle(buf); break; }
		if (failed) { await reader.cancel(); break; }
	}
	if (failed === LIMIT_CODE) return { results: none, state: "limit", message: "ChatGPT plan limit reached." };
	if (failed || !done) { logIssue("stream", res, { code: failed ?? "no_completed_event" }); return { results: none, state: "error", message: `The rewrite did not finish (${failed ?? "stream ended early"}).` }; }
	if (!text) text = outputText(done);
	let parsed: unknown = null;
	try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* no results */ }
	return { results: rewriteResults(parsed, items.map((t) => t.id)), state: "ok" };
}
const outputText = (r: Record<string, unknown>) => (Array.isArray(r.output) ? r.output : []).flatMap((o: { content?: { type?: string; text?: string }[] }) => o?.content ?? [])
	.filter((c) => c?.type === "output_text" && typeof c.text === "string").map((c) => c.text).join("");

/** A batch takes 15 to 25 seconds on the rewriter, longer when another batch is ahead of it in its queue. */
const REWRITER_TIMEOUT_MS = 90_000;
/** One POST of the batch to the rewriter service (local/rewriter.mjs), which answers {results: [{id, rewrite}]}. */
async function viaRewriter(env: Env, items: RewriteItem[]): Promise<{ results: Map<number, string> } & Outcome> {
	const none = new Map<number, string>();
	let res: Response;
	try {
		res = await egressFetch(env, env.READABLE_REWRITER_URL!, { method: "POST", headers: { authorization: `Bearer ${env.READABLE_REWRITER_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ texts: items }), signal: AbortSignal.timeout(REWRITER_TIMEOUT_MS) });
	} catch (e) {
		const timedOut = (e as Error).name === "TimeoutError";
		logIssue("rewriter", null, { error: timedOut ? "timeout" : String((e as Error).message).slice(0, 200) });
		return { results: none, state: "error", message: timedOut ? "The rewriter did not answer in time." : "Could not reach the rewriter." };
	}
	if (res.status === 429) { await res.body?.cancel(); return { results: none, state: "limit", message: "Rewrite limit reached. Try again later." }; }
	if (!res.ok) { logIssue("rewriter", res); await res.body?.cancel(); return { results: none, state: "error", message: `The rewriter returned ${res.status}.` }; }
	return { results: rewriteResults(await jsonOf(res), items.map((t) => t.id)), state: "ok" };
}

/** Owner-only routes, reached after the owner check. Undefined when the option is off or the path is not one of these. */
export async function readableApi(request: Request, env: Env, url: URL): Promise<Response | undefined> {
	if (!readableOn(env) || !url.pathname.startsWith("/api/readable")) return undefined;
	const v = vault(env);
	if (url.pathname === "/api/readable" && request.method === "GET") {
		return reply(rewriterOn(env) ? { connected: true, email: null, model: null, backend: "rewriter" } satisfies Status : await v.readable({ op: "status" }));
	}
	if (siwcOn(env) && url.pathname === "/api/readable/connect" && request.method === "POST") {
		// The open flow accepts only this exact loopback callback; localhost or any other host cannot complete it.
		if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return reply({ error: { code: "validation", message: `Open the dashboard at http://127.0.0.1:${url.port || "8787"} to connect ChatGPT.` } }, 400);
		return reply(await v.readable({ op: "begin", redirect_uri: `http://127.0.0.1${url.port ? `:${url.port}` : ""}${CALLBACK_PATH}` }));
	}
	if (siwcOn(env) && url.pathname === "/api/readable/disconnect" && request.method === "POST") return reply(await v.readable({ op: "disconnect" }));
	if (url.pathname === "/api/readable/rewrite" && request.method === "POST") {
		const sent = await request.text();
		let raw: unknown = null;
		try { raw = JSON.parse(sent); } catch { /* refused below */ }
		const items = rewriteItems(raw);
		if (!items) return reply({ error: { code: "validation", message: `send JSON {"texts": [{"id": integer, "text": string}]} with 1 to ${MAX_TEXTS} texts of at most ${MAX_TEXT} characters and distinct ids` } }, 400);
		const keyOf = new Map(items.map((t) => [t.id, sha256(t.text)]));
		const { rewrites: cached, epoch } = await v.readable({ op: "get", keys: [...new Set(keyOf.values())] }) as { rewrites: Record<string, string>; epoch: number };
		const results = items.filter((t) => cached[keyOf.get(t.id)!] !== undefined).map((t) => ({ id: t.id, rewrite: cached[keyOf.get(t.id)!]! }));
		const missing = items.filter((t) => cached[keyOf.get(t.id)!] === undefined);
		if (!missing.length) return reply({ results, state: "ok" });
		let out: Awaited<ReturnType<typeof viaRewriter>>;
		if (rewriterOn(env)) out = await viaRewriter(env, missing);
		else {
			const status = await v.readable({ op: "status" }) as Status;
			if (status.model === false) return reply({ results, state: "model_unavailable", message: `${MODEL} is not available to this ChatGPT account.` });
			let token: string | null;
			try { token = await v.readable({ op: "token" }) as string | null; } catch { return reply({ results, state: "error", message: "Could not renew the ChatGPT sign-in. Try again later." }); }
			if (!token) return reply({ results, state: "not_connected", message: "Connect ChatGPT to see rewrites." });
			try { out = await viaChatgpt(env, token, missing); } catch (e) { logIssue("responses", null, { error: String((e as Error).message).slice(0, 200) }); return reply({ results, state: "error", message: "Could not reach ChatGPT." }); }
		}
		const fresh = missing.filter((t) => out.results.has(t.id)).map((t) => ({ id: t.id, rewrite: out.results.get(t.id)! }));
		if (fresh.length) await v.readable({ op: "put", epoch, rows: fresh.map((r) => ({ key: keyOf.get(r.id)!, rewrite: r.rewrite })) });
		return reply({ results: [...results, ...fresh], ...(out.state === "ok" ? { state: "ok" } : { state: out.state, message: out.message }) });
	}
	return undefined;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GET /auth/callback: public, because the browser arrives here from OpenAI; the single-use state is what binds it to an attempt. */
export async function readableCallback(request: Request, env: Env): Promise<Response> {
	const q = new URL(request.url).searchParams, state = q.get("state");
	const r: { ok: boolean; message: string } = request.method !== "GET" || !state || state.length > 200
		? { ok: false, message: "This page only finishes a ChatGPT sign-in started from the dashboard." }
		: await vault(env).readable({ op: "finish", state, code: q.get("code"), client_id: q.get("client_id"), error: q.get("error") }) as { ok: boolean; message: string };
	if (r.ok) return new Response(null, { status: 303, headers: { location: "/#home", "cache-control": "no-store" } });
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ChatGPT sign-in</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; margin: 2rem 1rem; max-width: 40rem"><h1 style="font-size: 1.25rem">ChatGPT was not connected</h1><p>${esc(r.message)}</p><p><a href="/#home">Back to the dashboard</a></p></body></html>`,
	{ status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" } });
}
