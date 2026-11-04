// Owner-only REST: protected-resource metadata, whoami, device tokens and the minimal Settings page (sections 8 and 15).
import type { AccountCommand, AccountContext, AccountStore, Principal } from "./account/store";
import { authenticate, verifyJwt } from "./auth";
import { canonicalJson, requestHash, sha256 } from "./domain/ids";
import { stripPersonal } from "./domain/personal";
import { redactPayload } from "./domain/redact";
import { Fail, MEMORY_KINDS, MEMORY_TYPES, NODE_KINDS, ok, SCOPES, type OwnerArgs, type ProfileRef, type ReadQuery, type WriteCommand } from "./domain/types";
import { z } from "zod";
import { PROFILE_NAME } from "./domain/types";
import { accountStub, callTool, ownerOf, profileStub } from "./mcp";
import { trace } from "./graph-tools";
import { chunkSchema, corpusOn, corpusStub, refreshSchema } from "./corpus-tools";
import { checkChunk, chunkTerms, HELD, refreshTerms, type RefreshCommand } from "./corpus/store";
import { commitArgs, prArgs, repoNamespace, ticketArgs, TITLE_MAX, uploadTerms, type ImportStep } from "./profile/store";
import type { PartMeta, Parts, Payload, ProfileStore } from "./profile/store";
import { matchRule, mayUse, normalizeRemote, readSet, routeWrite } from "./routing";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard";
import { SETTINGS_HTML, SETTINGS_JS } from "./settings";
import { deviceV2, ownerV2 } from "./v2-api";

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
	return parseBody((request.headers.get("content-type") ?? "").includes("application/json") ? await request.text() : "");
}
function parseBody(raw: string): Record<string, unknown> | null {
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
// Work uploads (section 10): a body naming commits, PR or Jira ticket snapshots, or a marker. Strict and bounded: full SHAs,
// GitHub logins and Jira account ids (never a name or an email), titles and branch names of at most 280 characters, and no field
// for diffs, paths, review text, descriptions, comments or other free text. Snapshots carry the time they were read (`as_of`).
// Jira tickets go only to the work profile, named explicitly. Digests in the same body still need their session. Bodies without
// these keys keep the capture schema above unchanged.
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/);
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/), jiraAccount = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
// A field the connector named unknown carries no value, and only a known assignee says whether it is the owner.
const ticket = z.object({ key: jiraKey, kind: z.enum(["bug", "feature", "ticket"]), type: z.string().min(1).max(64), title: z.string().max(TITLE_MAX), updated_at: z.iso.datetime({ offset: true }),
	state: z.enum(["open", "closed"]).optional(), status: z.string().max(64).optional(), priority: z.string().max(64).optional(), due: z.iso.date().optional(),
	assignee: jiraAccount.optional(), reporter: jiraAccount.optional(), assignee_is_owner: z.boolean().optional(),
	blocked_by: z.array(jiraKey).max(100), blocks: z.array(jiraKey).max(100), related: z.array(jiraKey).max(100),
	unknown: z.array(z.enum(["status", "priority", "due", "assignee", "reporter", "issuelinks"])).max(6) }).strict()
	.refine((t) => ![...t.blocked_by, ...t.blocks, ...t.related].includes(t.key), { message: "a ticket does not link to itself" })
	.refine((t) => (t.assignee_is_owner === true ? !!t.assignee : true) && !(t.unknown.includes("assignee") && (t.assignee || t.assignee_is_owner !== undefined))
		&& !(t.unknown.includes("status") && (t.state || t.status !== undefined)) && !(t.unknown.includes("priority") && t.priority !== undefined)
		&& !(t.unknown.includes("due") && t.due) && !(t.unknown.includes("reporter") && t.reporter), { message: "an unknown field carries no value" });
const workObject = ingestSchema.extend({
	session: ingestSchema.shape.session.optional(),
	commits: z.array(z.object({ sha, at: z.iso.datetime({ offset: true }), title: z.string().max(TITLE_MAX), author: login.optional() }).strict()).max(50).default([]),
	prs: z.array(z.object({ number: z.number().int().min(1).max(2_147_483_647), title: z.string().max(TITLE_MAX), state: z.enum(["open", "closed"]),
		updated_at: z.iso.datetime({ offset: true }), head: z.string().max(TITLE_MAX), author: login.optional(), reviewers: z.array(login).max(100),
		commits: z.array(sha).max(100), closes: z.array(z.string().regex(/^github:[A-Za-z0-9][\w.-]*\/[\w.-]+#[1-9]\d{0,9}$/)).max(100),
		unknown: z.array(z.enum(["author", "reviews", "commits", "closingIssuesReferences", "reviewRequests"])).max(5),
		review_requested_from_owner: z.boolean().optional() }).strict()).max(25).default([]),
	tickets: z.array(ticket).max(20).default([]),
	as_of: z.iso.datetime({ offset: true }).optional(),
	marker: z.object({ head: sha, as_of: z.iso.datetime({ offset: true }) }).strict().optional(),
}).strict();
const workSchema = workObject.refine((v) => v.session || (!v.digests.length && !v.manifests.length), { path: ["session"], message: "digests and manifests need a session" })
	.refine((v) => (!v.prs.length && !v.tickets.length) || v.as_of, { path: ["as_of"], message: "PR and ticket snapshots need as_of" })
	.refine((v) => !v.tickets.length || v.profile === "work", { path: ["profile"], message: "Jira tickets go only to profile \"work\", named explicitly" });

/**
 * Capture upload and recovery for the job-scoped device token (scope `ingest`), routed like any write and never to `me`.
 * Only bounded digests and manifests are accepted: the strict body schema has no field for a raw transcript record, and every string is bounded.
 * The same token uploads bounded work items (commits, PR and Jira ticket snapshots and the repo marker) through the work schema.
 */
async function capture(request: Request, env: Env, path: "/v1/ingest" | "/v1/capture"): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	if (!ctx.value.caller.scopes.includes("ingest")) return json({ error: { code: "forbidden", message: "this token cannot upload captures" } }, 403);
	const text = (request.headers.get("content-type") ?? "").includes("application/json") ? await request.text() : "", raw = parseBody(text);
	if (path === "/v1/ingest" && raw && "refresh" in raw) return refreshPart(env, ctx.value, text, raw);
	const work = path === "/v1/ingest" && !!raw && ("commits" in raw || "prs" in raw || "tickets" in raw || "marker" in raw);
	const parsed = (path === "/v1/ingest" ? (work ? workSchema : ingestSchema) : stateSchema).safeParse(raw);
	if (!parsed.success) return json({ error: { code: "validation", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
	const input = parsed.data as z.infer<typeof stateSchema> & Partial<z.infer<typeof workSchema>>;
	const route = routeWrite(ctx.value.caller, ctx.value.rules, ctx.value.known, { ...(input.profile ? { profile: input.profile } : {}), ...(input.repo ? { repo: input.repo } : {}) });
	if (!route.ok) return json({ error: route.error }, route.error.code === "forbidden" ? 403 : 400);
	if (route.value.profile === "me") return json({ error: { code: "forbidden", message: "captures never go to me" } }, 403);
	const ref = ctx.value.profiles.find((p) => p.profile === route.value.profile)!;
	if (work) return workUpload(env, ctx.value, ref, route.value.routedBy, input);
	const res = path === "/v1/ingest"
		? await profileStub(env, ref).ingest(ref, { session: input.session!, digests: input.digests ?? [], manifests: input.manifests ?? [] })
		: await profileStub(env, ref).captureState(ref, input.range_ids);
	return res.ok ? json({ profile: route.value.profile, routed_by: route.value.routedBy, ...(path === "/v1/ingest" ? { results: res.value } : { ranges: res.value }) }) : json({ error: res.error }, 400);
}

/**
 * Work items: the namespace comes from the same remote that routed the body; GitHub only, so keys match extract.ts. New work
 * names and handles guard me before the write, as record_knowledge's do. Capture digests in the body are stored first, unchanged.
 */
async function workUpload(env: Env, account: AccountContext, ref: ProfileRef, routedBy: string, input: Partial<z.infer<typeof workSchema>>): Promise<Response> {
	const repo = repoNamespace(input.repo?.remote ?? ""), tickets = (input.tickets ?? []).map((t) => ticketArgs(t, input.as_of!));
	if (!repo && (input.commits?.length || input.prs?.length || input.marker || !tickets.length)) return json({ error: { code: "validation", message: "commits, PRs and markers need repo.remote on github.com", details: { reason: "unsupported_remote" } } }, 400);
	if (tickets.length && ref.profile !== "work") return json({ error: { code: "forbidden", message: "Jira tickets go only to the work profile" } }, 403);
	const results = input.session ? await profileStub(env, ref).ingest(ref, { session: input.session, digests: input.digests ?? [], manifests: input.manifests ?? [] }) : ok([]);
	if (!results.ok) return json({ error: results.error }, 400);
	if (input.marker && results.value.some((r) => r.status !== "stored" && r.status !== "replayed")) return json({ profile: ref.profile, routed_by: routedBy, results: results.value, commits: [], marker: { status: "refused", reason: "capture_not_held" } });
	const commits = (input.commits ?? []).map((c) => commitArgs(repo!, c)), prs = (input.prs ?? []).map((p) => prArgs(repo!, p, input.as_of!));
	const terms = ref.profile === "work" ? uploadTerms(repo, [...commits, ...prs, ...tickets]) : [];
	if (terms.length) {
		const added = await accountStub(env, account.caller.userId).admin({ op: "addSensitiveTerms", terms });
		if (!added.ok) return json({ error: added.error }, 400);
	}
	const res = await profileStub(env, ref).upload(ref, { repo, commits, ...(prs.length ? { prs } : {}), ...(tickets.length ? { tickets } : {}), ...(input.marker ? { marker: input.marker } : {}) },
		{ platform: "upload", routedBy, userId: account.caller.userId, ...(account.caller.deviceId ? { deviceId: account.caller.deviceId } : {}) });
	if (!res.ok) return json({ error: res.error }, 400);
	
	return json({ profile: ref.profile, routed_by: routedBy, results: results.value, commits: res.value.commits, ...(res.value.prs ? { prs: res.value.prs } : {}),
		...(res.value.tickets ? { tickets: res.value.tickets } : {}), ...(res.value.marker ? { marker: res.value.marker } : {}) });
}

const markersQuery = z.object({ repo: z.string().min(1).max(512).optional(), path: z.string().min(1).max(1024).optional(), profile: z.string().regex(PROFILE_NAME).optional(),
	session: z.string().regex(/^(claude-code|codex):[A-Za-z0-9._:-]{1,128}$/).optional() }).strict();

/**
 * `GET /v1/markers` (section 7) for the job-scoped token (scope `ingest`), routed like an upload and never to `me`: the repo marker,
 * one session's acknowledged capture cursors and the daily slot. Read-only: it moves, acknowledges and binds nothing.
 */
async function markersRead(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	if (new URL(request.url).searchParams.has("refresh_scope")) return refreshScopeRead(request, env, auth.principal);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	if (!ctx.value.caller.scopes.includes("ingest")) return json({ error: { code: "forbidden", message: "this token cannot read upload markers" } }, 403);
	const q = markersQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
	if (!q.success) return json({ error: { code: "validation", message: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
	const repo = q.data.repo || q.data.path ? { ...(q.data.repo ? { remote: q.data.repo } : {}), ...(q.data.path ? { path: q.data.path } : {}) } : undefined;
	const route = routeWrite(ctx.value.caller, ctx.value.rules, ctx.value.known, { ...(q.data.profile ? { profile: q.data.profile } : {}), ...(repo ? { repo } : {}) });
	if (!route.ok) return json({ error: route.error }, route.error.code === "forbidden" ? 403 : 400);
	if (route.value.profile === "me") return json({ error: { code: "forbidden", message: "uploads never go to me" } }, 403);
	const ref = ctx.value.profiles.find((p) => p.profile === route.value.profile);
	if (!ref) return json({ error: { code: "profile_wiped", message: `profile '${route.value.profile}' is not active` } }, 400);
	const [client, ...id] = (q.data.session ?? "").split(":");
	const r = await profileStub(env, ref).read(ref, { kind: "markers", repo: q.data.repo ? repoNamespace(q.data.repo) : null,
		...(q.data.session ? { session: { client: client as "claude-code" | "codex", id: id.join(":") } } : {}) });
	// Daily refresh context for a registered ingest device only: an owner login cannot stand in for a device.
	const caller = ctx.value.caller, refresh_context = caller.kind === "device" && caller.deviceId
		? { profile: ref.profile, generation: ref.generation, device_id: caller.deviceId, utc_day: new Date().toISOString().slice(0, 10) } : null;
	return r.ok ? json({ profile: route.value.profile, routed_by: route.value.routedBy, refresh_context, ...(r.value as Record<string, unknown>) })
		: json({ error: r.error }, r.error.code === "busy" ? 503 : 400);
}

const refreshScopeQuery = z.object({ profile: z.string().regex(PROFILE_NAME), refresh_scope: z.literal("1") }).strict();

async function refreshScopeRead(request: Request, env: Env, principal: Principal): Promise<Response> {
	const url = new URL(request.url), params = url.searchParams;
	const q = refreshScopeQuery.safeParse(Object.fromEntries(params));
	if (!q.success || [...params.keys()].length !== 2) return json({ error: { code: "validation", message: "invalid refresh scope query" } }, 400);
	if (new URL(env.RESOURCE_URL).protocol !== "https:") return json({ error: { code: "unavailable", message: "refresh_scope_unsupported" } }, 503);
	if (url.origin !== new URL(env.RESOURCE_URL).origin) return json({ error: { code: "forbidden", message: "refresh scope origin mismatch" } }, 403);
	const account = accountStub(env, env.OWNER_USER_ID) as unknown as Pick<AccountStore, "refreshScope">;
	const before = await account.refreshScope(principal, q.data.profile);
	const refused = (error: { code: string; message: string }) => json({ error }, error.code === "unauthorized" ? 401 : error.code === "forbidden" ? 403 : error.code === "unavailable" || error.code === "busy" ? 503 : 400);
	if (!before.ok) return refused(before.error);
	const initial = before.value.scope;
	if (initial.origin !== url.origin) return refused({ code: "forbidden", message: "refresh scope origin mismatch" });
	const ref = { userId: env.OWNER_USER_ID, profile: initial.profile, generation: initial.generation };
	const markers = await profileStub(env, ref).read(ref, { kind: "markers", repo: null });
	if (!markers.ok) return refused(markers.error);
	// The profile read awaits another object. Refuse a changed policy rather than mixing snapshots.
	const final = await account.refreshScope(principal, q.data.profile);
	if (!final.ok) return refused(final.error);
	const scope = final.value.scope;
	if (scope.origin !== initial.origin || scope.profile !== initial.profile || scope.generation !== initial.generation || scope.device_id !== initial.device_id || scope.policy_version !== initial.policy_version)
		return refused({ code: "busy", message: "refresh_scope_changed" });
	const refresh_context = { profile: scope.profile, generation: scope.generation, device_id: scope.device_id, utc_day: scope.utc_day };
	return json({ ...(markers.value as Record<string, unknown>), profile: scope.profile, routed_by: "explicit", refresh_context, refresh_scope: final.value });
}

// ---------- staged import (section 16) ----------

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1).max(128);
const iso = z.string().min(1).max(64);
const importText = z.object({ part: z.enum(["body", "entry"]), revision: z.number().int().min(0), seq_no: z.number().int().min(0), chunk: z.number().int().min(0),
	body: z.string().min(1).max(16_000), separator: z.string().max(10_000).nullable().optional(), request_id: z.string().max(256).nullable().optional(), created_at: iso, live: z.boolean() }).strict();
const importRevision = z.object({ revision: z.number().int().min(0),
	op: z.enum(["saved", "updated", "retired", "superseded", "appended", "legacy_adopted", "legacy_snapshot"]), snapshot: z.string().min(2).max(1_000_000),
	delta: z.string().max(1_000_000).nullable(), request_id: z.string().max(256).nullable(), at: iso, content_hash: z.string().max(128).nullable(),
	revision_id: z.string().max(300).nullable(), source_platform: z.string().max(256).nullable(), source_platform_version: z.string().max(256).nullable() }).strict();
const importRequest = z.object({ request_id: z.string().min(1).max(256), legacy_op: z.string().min(1).max(64), legacy_hash: hex64, result: z.string().max(100_000),
	memory_id: z.string().max(128).nullable(), at: iso, completed_at: iso.nullable(), extra: z.record(z.string(), z.unknown()).optional() }).strict();
const importNode = z.object({
	id, kind: z.enum(MEMORY_KINDS), memory_type: z.enum(MEMORY_TYPES), scope: z.string().min(1).max(128), name: z.string().min(1).max(512), description: z.string().max(100_000),
	why: z.string().max(100_000).nullable(), how_to_apply: z.string().max(100_000).nullable(), objective: z.string().max(100_000).nullable(),
	steps: z.array(z.object({ order: z.number().int(), action: z.string().max(10_000), success_criteria: z.string().max(10_000) }).strict()).max(200).nullable(),
	status: z.enum(["active", "retired", "superseded"]), origin: z.literal("import"), revision: z.number().int().min(1), chars: z.number().int().min(0), content_hash: hex64,
	valid_from: iso.nullable(), valid_to: iso.nullable(), created_at: iso.nullable(), updated_at: iso.nullable(), source_platform: z.string().max(256).nullable(),
	updated_source_platform: z.string().max(256).nullable(), attrs: z.record(z.string(), z.unknown()),
}).strict();
const refreshStage = z.object({ no: z.number().int().min(1), base_record_sha256: hex64 }).strict();
const refreshFinalize = refreshStage.extend({ base_revision: z.number().int().min(1), base_content_hash: hex64, body_revision: z.number().int().min(1).optional() }).strict();
const importCommand = z.discriminatedUnion("op", [
	z.object({ op: z.literal("stage"), record_id: id, record_sha256: hex64, profile: z.string().regex(PROFILE_NAME), part: z.number().int().min(1), parts: z.number().int().min(1).max(1000),
		rows: z.object({ texts: z.array(importText).max(1000), revisions: z.array(importRevision).max(1000), requests: z.array(importRequest).max(1000) }).strict(),
		cost: z.object({ rows: z.number().int(), bytes: z.number().int() }).strict(), part_id: z.string().max(300), sha256: hex64, refresh: refreshStage.optional(), policy_version: z.literal(1).optional(), classification_version: z.literal(1).optional() }).strict(),
	z.object({ op: z.literal("finalize"), record_id: id, record_sha256: hex64, profile: z.string().regex(PROFILE_NAME), node: importNode,
		parts: z.array(z.object({ part_id: z.string().max(300), sha256: hex64 }).strict()).min(1).max(1000), request_ids: z.array(z.string().min(1).max(256)).max(5000), sha256: hex64, refresh: refreshFinalize.optional(), policy_version: z.literal(1).optional(), classification_version: z.literal(1).optional() }).strict(),
	z.object({ op: z.literal("link"), src: id, rel: z.literal("supersedes"), dst: id, basis: z.literal("identifier"), profile: z.string().regex(PROFILE_NAME), sha256: hex64 }).strict(),
]);
const importSchema = z.object({ import_id: z.string().max(128).optional(), batch: z.number().int().min(1).optional(), commands: z.array(importCommand).min(1).max(50) }).strict();
type ImportCommand = z.infer<typeof importCommand>;

const parsed = (s: string | null) => { try { return s ? JSON.parse(s) as unknown : s; } catch { return s; } };
/** Whether the server's redactor would change anything a command carries, its stored JSON strings parsed. The server never rewrites; it refuses. */
function needsRedaction(c: ImportCommand): boolean {
	const sent = c.op === "stage"
		? { texts: c.rows.texts, revisions: c.rows.revisions.map((r) => ({ ...r, snapshot: parsed(r.snapshot), delta: parsed(r.delta) })), requests: c.rows.requests.map((q) => ({ ...q, result: parsed(q.result) })) }
		: c.op === "finalize" ? c.node : c;
	return canonicalJson(redactPayload(sent)) !== canonicalJson(sent);
}

type Receipt = { index: number; op: string; record_id?: string; part_id?: string; status: string; reason?: string; message?: string; rows_written?: number; bytes?: number };

/**
 * `POST /v1/import`: at most 50 typed commands and 1,000,000 bytes, from the owner or an `import`-scoped device token.
 * Each command runs on its own and gets a receipt; nothing here trusts the client's hashes, costs or redaction. A
 * finalize prepares the record, binds its node and request ids in AccountStore in bounded batches, then publishes it;
 * every step is idempotent, so a retry after a crash or a lost response resumes where it stopped.
 */
async function importBatch(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const account = accountStub(env, env.OWNER_USER_ID);
	const ctx = await account.context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	const caller = ctx.value.caller;
	if (caller.kind !== "owner" && !caller.scopes.includes("import")) return json({ error: { code: "forbidden", message: "this token cannot import" } }, 403);
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: { code: "validation", message: "send JSON" } }, 400);
	const raw = await request.text();
	if (Buffer.byteLength(raw, "utf8") > 1_000_000) return json({ error: { code: "size_budget", message: "an import request may hold at most 1,000,000 bytes" } }, 413);
	let input: z.infer<typeof importSchema>;
	try {
		const r = importSchema.safeParse(JSON.parse(raw));
		if (!r.success) return json({ error: { code: "validation", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
		input = r.data;
	} catch { return json({ error: { code: "validation", message: "the body is not JSON" } }, 400); }
	const receipts: Receipt[] = [];
	for (const [index, c] of input.commands.entries()) {
		const base = { index, op: c.op, ...(c.op === "link" ? { record_id: c.src } : { record_id: c.record_id }), ...(c.op === "stage" ? { part_id: c.part_id } : {}) };
		const refused = (reason: string, message: string) => receipts.push({ ...base, status: "refused", reason, message: message.slice(0, 300) });
		const { sha256: claimed, ...body } = c as ImportCommand & { part_id?: string };
		const hashed = c.op === "stage" ? (({ part_id: _p, ...rest }) => rest)(body as typeof body & { part_id: string }) : body;
		if (sha256(canonicalJson(hashed)) !== claimed) { refused("hash_mismatch", "the command does not match its sha256"); continue; }
		if (c.op === "stage" && c.part_id !== `${c.record_id}${c.refresh ? `#r${c.refresh.no}` : ""}:${c.record_sha256.slice(0, 16)}:${c.part}`) { refused("part_id", "the part id does not name this record and part"); continue; }
		if (c.op === "finalize" && c.node.id !== c.record_id) { refused("node_id", "the node id must be the record id"); continue; }
		// No automatic me: the import never writes to me.
		if (c.profile === "me") { refused("me", "the import never writes to me"); continue; }
		// Each deployment names the profiles it takes imports into: production none until its copy is enabled, the
		// rehearsal Worker only `test`. A rehearsal plan can never land in production's indexes.
		if (!(env.IMPORT_PROFILES ?? "").split(",").map((x) => x.trim()).includes(c.profile)) { refused("import_disabled", `this deployment does not take imports into '${c.profile}'`); continue; }
		const ref = ctx.value.profiles.find((p) => p.profile === c.profile);
		if (!ref) { refused("profile", `profile '${c.profile}' is not active`); continue; }
		if (!mayUse(caller, c.profile)) { refused("forbidden", `this caller may not use profile '${c.profile}'`); continue; }
		if (needsRedaction(c)) { refused("needs_redaction", "the command holds text the redactor would change; it is refused, never rewritten"); continue; }
		// The personal-field rule for every node (section 4): an import that would lose an attribute to it is refused, never rewritten.
		if (c.op === "finalize" && stripPersonal(c.node.kind, c.node.attrs).stripped.length) { refused("personal_fields", "the node carries attributes the personal-field rule removes; it is refused, never rewritten"); continue; }
		const stub = profileStub(env, ref);
		const step = async (s: ImportStep, check = false) => stub.importStep(ref, s, check);
		const take = (r: Awaited<ReturnType<typeof step>>) => {
			if (!r.ok) { refused(String(r.error.details?.reason ?? r.error.code), r.error.message); return null; }
			return r.value;
		};
		if (c.op === "stage") {
			// Reserve the part's request ids account-wide first, so no ordinary call in any profile can take one before publication.
			const wanted = c.rows.requests.map((q) => ({ request_id: q.request_id, op: q.legacy_op, hash: q.legacy_hash }));
			const staged: ImportStep = { op: "stage", record_id: c.record_id, record_sha256: c.record_sha256, part: c.part, parts: c.parts, part_id: c.part_id, sha256: c.sha256, rows: c.rows, ...(c.policy_version ? {policy_version:c.policy_version} : {}), ...(c.classification_version ? {classification_version:c.classification_version} : {}), ...(c.refresh ? { refresh: c.refresh } : {}) };
			// The profile's own import guards run first, so a stage they refuse leaves no account-wide reservation behind.
			if (wanted.length && !take(await step(staged, true))) continue;
			let reserved = true;
			for (let i = 0; i < wanted.length; i += 400) {
				const r = await account.reserveImport({ profile: c.profile, requests: wanted.slice(i, i + 400) });
				if (!r.ok) { refused(String(r.error.details?.reason ?? r.error.code), r.error.message); reserved = false; break; }
			}
			if (!reserved) continue;
			const r = take(await step(staged));
			if (r) receipts.push({ ...base, status: r.status, rows_written: r.rows_written ?? 0, bytes: r.bytes ?? 0 });
			continue;
		}
		if (c.op === "link") {
			const r = take(await step({ op: "link", src: c.src, dst: c.dst }));
			if (r) receipts.push({ ...base, status: r.status });
			continue;
		}
		const fin = { record_id: c.record_id, record_sha256: c.record_sha256, node: c.node, parts: c.parts, request_ids: c.request_ids, ...(c.policy_version ? {policy_version:c.policy_version} : {}), ...(c.classification_version ? {classification_version:c.classification_version} : {}), ...(c.refresh ? { refresh: c.refresh } : {}) };
		const prep = take(await step({ op: "prepare", ...fin }));
		if (!prep) continue;
		if (prep.status === "published") { receipts.push({ ...base, status: "replayed" }); continue; }
		// Bindings come before publication, so no new call can take one of these request ids once the record is visible.
		const all = prep.requests ?? [];
		let bound = true;
		for (let i = 0; i === 0 || i < all.length; i += 400) {
			const r = await account.bindImport({ profile: c.profile, recordId: c.record_id, requests: all.slice(i, i + 400) });
			if (!r.ok) { refused(String(r.error.details?.reason ?? r.error.code), r.error.message); bound = false; break; }
		}
		if (!bound) continue;
		const pub = take(await step({ op: "publish", ...fin }));
		if (pub) receipts.push({ ...base, status: pub.status, rows_written: pub.rows_written ?? 0, bytes: pub.bytes ?? 0 });
	}
	return json({ ...(input.import_id ? { import_id: input.import_id } : {}), ...(input.batch ? { batch: input.batch } : {}), receipts });
}

const boardQuery = z.object({ as_of: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date").optional(),
	limit: z.coerce.number().int().min(1).max(200).optional() }).strict();
// Owner page reads (section 15). Entity: before pages revision history, content=all with cursor pages the whole content. Journals:
// after pages the list; id with entries_after pages one journal's entries, at most 25 a page. The rest bound their own windows.
const asOfParam = boardQuery.shape.as_of;
const entityQuery = z.object({ as_of: asOfParam, before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
	content: z.literal("all").optional(), cursor: z.string().min(1).max(2048).optional() }).strict().refine((v) => (v.cursor === undefined || v.content === "all") && (v.before === undefined || v.content === undefined));
const journalsQuery = z.object({ after: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), id: id.optional(),
	entries_after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict()
	.refine((v) => (v.id === undefined ? v.entries_after === undefined : v.after === undefined && (v.limit ?? 1) <= 25));
const mapQuery = z.object({ center: id.optional(), center_key: z.string().min(1).max(256).optional(), depth: z.coerce.number().int().min(1).max(2).optional(), as_of: asOfParam }).strict().refine((q) => !(q.center && q.center_key), "pass center or center_key");
const graphQuery = z.object({ part: z.enum(["nodes", "edges"]), after: z.string().min(1).max(1024).optional(), limit: z.coerce.number().int().min(1).max(2000).optional() }).strict();
const pathQuery = z.object({ from: id, to: id, max_depth: z.coerce.number().int().min(2).max(4).optional(), as_of: asOfParam }).strict();
const timelineQuery = z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), node: id.optional(),
	kinds: z.string().max(400).transform((v) => v.split(",")).pipe(z.array(z.enum(NODE_KINDS)).min(1).max(NODE_KINDS.length)).optional(),
	limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const activityQuery = z.object({ before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
	actor: z.enum(["agent", "owner", "keep", "index", "maintenance", "migration", "transfer"]).optional() }).strict();
const archiveQuery = z.object({ before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();
const DASHBOARD_RECALL = ["keyword", "type", "scope", "limit", "cursor", "channels", "count_hits"];
/** #9: the Memories search picks its recall channels; count_hits false leaves recall counts alone. */
const recallOptions = z.object({ channels: z.array(z.enum(["lexical", "vector"])).min(1).max(2).optional(), count_hits: z.boolean().optional() }).strict();
const DASHBOARD_REVIEW = ["action", "status", "limit", "candidate_id", "into", "reason", "request_id"];
const DASHBOARD_SAVE = ["name", "memory_id", "type", "kind", "description", "content", "scope", "origin", "evidence", "links", "expected_revision", "request_id", "company_free", "new_name"];
const restoreBody = z.object({ activity_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };
const isoOf = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
const TIMELINE_DAYS = 90;

const auditQuery = z.object({ profile: z.string().regex(PROFILE_NAME), after: z.string().min(1).max(300).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
	record: id.optional(), rows: z.enum(["revisions", "requests", "texts"]).optional() }).strict();

/**
 * GET /v1/import/audit: read-only digests of what the import stored, for the owner or an import device that may use the
 * profile (docs/import-integrity-design.md). It returns digests, counts and ids, never content, and changes nothing.
 */
async function importAudit(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	const caller = ctx.value.caller;
	if (caller.kind !== "owner" && !caller.scopes.includes("import")) return json({ error: { code: "forbidden", message: "this token cannot audit imports" } }, 403);
	const r = auditQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
	if (!r.success) return json({ error: { code: "validation", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
	const { profile, after, record, rows } = r.data, limit = r.data.limit ?? 20;
	if (!record !== !rows) return json({ error: { code: "validation", message: "record and rows go together" } }, 400);
	if (rows === "revisions" && after !== undefined && !/^\d+$/.test(after)) return json({ error: { code: "validation", message: "after is a revision number for revision rows" } }, 400);
	if (!record && limit > 50) return json({ error: { code: "validation", message: "a summary page holds at most 50 records" } }, 400);
	if (profile === "me") return json({ error: { code: "validation", message: "the import never writes to me" } }, 400);
	const ref = ctx.value.profiles.find((p) => p.profile === profile);
	if (!ref) return json({ error: { code: "not_found", message: `profile '${profile}' is not active` } }, 404);
	if (!mayUse(caller, profile)) return json({ error: { code: "forbidden", message: `this caller may not use profile '${profile}'` } }, 403);
	const out = await profileStub(env, ref).read(ref, { kind: "import_audit", after: after ?? null, limit, ...(record ? { record, rows } : {}) });
	return out.ok ? json({ profile, ...(out.value as Record<string, unknown>) }) : json({ error: out.error }, 400);
}

/**
 * The migration review list (sections 15 and 16), for the owner or an `import` device on the production Worker. POST offers a plan's
 * unrouted records, each with only its name, reasons and the exact binding `plan --routes` checks (source, id, scope, source row
 * SHA-256, export manifest SHA-256); never content. GET returns the owner's assignments for one export as route-file entries, so
 * the next local plan imports them through the reviewed routes it already checks. Nothing here imports or routes anything.
 */
const sha64 = z.string().regex(/^[0-9a-f]{64}$/);
const reviewPush = z.object({ export_manifest_sha256: sha64, origin: z.string().regex(PROFILE_NAME), items: z.array(z.object({ source: z.string().min(1).max(1024), id: z.string().min(1).max(128),
	scope: z.string().min(1).max(512), source_sha256: sha64, name: z.string().max(512).nullable(), reasons: z.array(z.enum(["unrouted_scope", "unrouted_path"])).min(1).max(2) }).strict()).min(1).max(200) }).strict();
async function importReview(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const account = accountStub(env, env.OWNER_USER_ID);
	const ctx = await account.context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	const caller = ctx.value.caller;
	if (caller.kind !== "owner" && !caller.scopes.includes("import")) return json({ error: { code: "forbidden", message: "this token cannot use the migration review list" } }, 403);
	const res = (r: Awaited<ReturnType<typeof account.admin>>, map: (v: { items: { payload: Record<string, unknown>; decision: Record<string, unknown> | null }[]; next_after: string | null }) => unknown) =>
		r.ok ? json(map(r.value as never)) : json({ error: r.error }, r.error.code === "busy" ? 503 : 400);
	if (request.method === "GET") {
		const q = z.object({ export_manifest_sha256: sha64, after: z.string().min(1).max(80).optional() }).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
		if (!q.success) return json({ error: { code: "validation", message: "export_manifest_sha256 and an optional after" } }, 400);
		const r = await account.admin({ op: "reviewList", kind: "migration", state: "assigned", exportSha: q.data.export_manifest_sha256, ...(q.data.after ? { after: q.data.after } : {}), limit: 200 });
		return res(r, (v) => ({ routes: v.items.filter((i) => mayUse(caller, String((i as { profile?: string }).profile))).map(({ payload: p, decision }) => ({ source: p.source, id: p.id, scope: p.scope, profile: decision!.profile, source_sha256: p.source_sha256 })), next_after: v.next_after }));
	}
	const raw = await rawJson(request, 1_000_000);
	if (raw instanceof Response) return raw;
	const b = reviewPush.safeParse(raw.value);
	if (!b.success) return invalid(b.error);
	// The origin is the profile the metadata belongs to (the owner's legacy imports go to work), separate from the destination the
	// owner later assigns: the caller must be granted it, it must be active, and never me. A wipe of it clears the metadata.
	const origin = ctx.value.profiles.find((p) => p.profile === b.data.origin);
	if (b.data.origin === "me" || !origin) return json({ error: { code: "validation", message: "origin must be an active profile other than me", details: { reason: "origin_closed" } } }, 400);
	if (!mayUse(caller, origin.profile)) return json({ error: { code: "forbidden", message: `this caller may not use profile '${origin.profile}'` } }, 403);
	const { origin: _o, ...head } = b.data;
	const items = head.items.map((it) => ({ id: `m:${sha256(canonicalJson([head.export_manifest_sha256, it.source, it.source_sha256])).slice(0, 40)}`, kind: "migration" as const, profile: origin.profile,
		payload: { export_manifest_sha256: head.export_manifest_sha256, ...it } }));
	const r = await account.admin({ op: "reviewOffer", items, origin: { profile: origin.profile, generation: origin.generation } });
	return r.ok ? json({ offered: items.length, ids: items.map((i) => i.id) }) : json({ error: r.error }, r.error.code === "busy" ? 503 : 400);
}

/** The owner or an `import` device token; corpus loads and status are never open to read or ingest tokens. */
async function corpusCaller(request: Request, env: Env): Promise<AccountContext | Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	if (ctx.value.caller.kind !== "owner" && !ctx.value.caller.scopes.includes("import")) return json({ error: { code: "forbidden", message: "this token cannot load the corpus" } }, 403);
	return ctx.value;
}

/** An active profile the caller may use, which this deployment takes imports into; never me. */
function corpusProfile(env: Env, ctx: AccountContext, profile: string): ProfileRef | Response {
	if (!PROFILE_NAME.test(profile) || profile === "me") return json({ error: { code: "forbidden", message: "the corpus never holds me" } }, 403);
	if (!(env.IMPORT_PROFILES ?? "").split(",").map((x) => x.trim()).includes(profile)) return json({ error: { code: "forbidden", message: `this deployment does not take imports into '${profile}'`, details: { reason: "import_disabled" } } }, 403);
	const ref = ctx.profiles.find((p) => p.profile === profile);
	if (!ref) return json({ error: { code: "not_found", message: `profile '${profile}' is not active` } }, 404);
	if (!mayUse(ctx.caller, profile)) return json({ error: { code: "forbidden", message: `this caller may not use profile '${profile}'` } }, 403);
	return ref;
}

const corpusStatusCode = (code: string) => (code === "forbidden" ? 403 : code === "size_budget" ? 413 : code === "idempotency_mismatch" || code === "profile_wiped" ? 409
	: code === "busy" || code === "unavailable" ? 503 : 400);
/** Guard terms per account call: one account and one me transaction each, well inside the 1,000-row write bound. */
const TERM_PAGE = 200;

/**
 * POST /v1/corpus/import (section 14): one ordered chunk of one approved family, at most 5,000 rows and 1,000,000 bytes, for
 * the generation the uploader pinned. Held and unknown tables are refused here by name, before any store sees them.
 */
async function corpusImport(request: Request, env: Env): Promise<Response> {
	const ctx = await corpusCaller(request, env);
	if (ctx instanceof Response) return ctx;
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: { code: "validation", message: "send JSON" } }, 400);
	const raw = await request.text();
	if (Buffer.byteLength(raw, "utf8") > 1_000_000) return json({ error: { code: "size_budget", message: "a corpus chunk may hold at most 1,000,000 bytes", details: { reason: "chunk_bytes" } } }, 413);
	let input: z.infer<typeof chunkSchema>;
	try {
		const r = chunkSchema.safeParse(JSON.parse(raw));
		if (!r.success) return json({ error: { code: "validation", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
		input = r.data;
	} catch { return json({ error: { code: "validation", message: "the body is not JSON" } }, 400); }
	// Every stateless check first, held and unknown tables by name included, so a refused row never reaches the guard terms.
	let checked: ReturnType<typeof checkChunk>;
	try { checked = checkChunk(input); } catch (e) { if (e instanceof Fail) return json({ error: e.failure }, corpusStatusCode(e.failure.code)); throw e; }
	const ref = corpusProfile(env, ctx, input.profile);
	if (ref instanceof Response) return ref;
	if (input.generation !== ref.generation) return json({ error: { code: "profile_wiped", message: "this profile is on another generation; start a fresh upload", details: { reason: "generation_changed" } } }, 409);
	// The chunk's work repos and people guard me before it is stored, as work writes' terms do: bounded pages through the same
	// account helper, each bound to this generation. Nothing is stored unless every page is confirmed; a resend replays them all.
	const terms = ref.profile === "work" ? chunkTerms(checked.f, checked.rows) : [];
	for (let i = 0; i < terms.length; i += TERM_PAGE) {
		const added = await accountStub(env, ctx.caller.userId).admin({ op: "addSensitiveTerms", terms: terms.slice(i, i + TERM_PAGE), profile: ref.profile, generation: ref.generation });
		if (!added.ok) return json({ error: added.error }, corpusStatusCode(added.error.code));
	}
	const { profile: _p, generation: _g, ...chunk } = input;
	const r = await corpusStub(env, ref).importChunk(ref, chunk);
	return r.ok ? json({ profile: ref.profile, generation: ref.generation, receipt: r.value }) : json({ error: r.error }, corpusStatusCode(r.error.code));
}

/**
 * POST /v1/corpus/refresh (refresh design revision 2): inspect a repo, or begin, apply a part of or finish its plan, for the generation
 * the client pinned. A part's put rows pass their row checks and, in work, register their repos and people as me guard terms before
 * the store sees the part. Receipts are the store's stored text and travel byte for byte.
 */
async function corpusRefresh(request: Request, env: Env): Promise<Response> {
	const ctx = await corpusCaller(request, env);
	if (ctx instanceof Response) return ctx;
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: { code: "validation", message: "send JSON" } }, 400);
	const raw = await request.text();
	if (Buffer.byteLength(raw, "utf8") > 1_000_000) return json({ error: { code: "size_budget", message: "a refresh request may hold at most 1,000,000 bytes", details: { reason: "request_bytes" } } }, 413);
	let input: z.infer<typeof refreshSchema>;
	try {
		const r = refreshSchema.safeParse(JSON.parse(raw));
		if (!r.success) return json({ error: { code: "validation", message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);
		input = r.data;
	} catch { return json({ error: { code: "validation", message: "the body is not JSON" } }, 400); }
	const ref = corpusProfile(env, ctx, input.profile);
	if (ref instanceof Response) return ref;
	if (input.generation !== ref.generation) return json({ error: { code: "profile_wiped", message: "this profile is on another generation; start a fresh refresh", details: { reason: "generation_changed" } } }, 409);
	if (input.command === "part") {
		let terms: string[];
		try { terms = refreshTerms(input.ops); } catch (e) { if (e instanceof Fail) return json({ error: e.failure }, corpusStatusCode(e.failure.code)); throw e; }
		for (let i = 0; ref.profile === "work" && i < terms.length; i += TERM_PAGE) {
			const added = await accountStub(env, ctx.caller.userId).admin({ op: "addSensitiveTerms", terms: terms.slice(i, i + TERM_PAGE), profile: ref.profile, generation: ref.generation });
			if (!added.ok) return json({ error: added.error }, corpusStatusCode(added.error.code));
		}
	}
	const { profile: _p, generation: _g, ...cmd } = input;
	const r = await corpusStub(env, ref).refresh(ref, cmd as RefreshCommand);
	if (!r.ok) return json({ error: r.error }, corpusStatusCode(r.error.code));
	const head = `{"profile":${JSON.stringify(ref.profile)},"generation":${JSON.stringify(ref.generation)}`;
	return new Response(typeof r.value === "string" ? `${head},"receipt":${r.value}}` : `${head},"page":${JSON.stringify(r.value)}}`, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** GET /v1/corpus/status?profile=: the generation to pin, the accepted families with their hashes, the hold list and each table's progress. */
async function corpusStatus(request: Request, env: Env): Promise<Response> {
	const ctx = await corpusCaller(request, env);
	if (ctx instanceof Response) return ctx;
	const ref = corpusProfile(env, ctx, new URL(request.url).searchParams.get("profile") ?? "");
	if (ref instanceof Response) return ref;
	const r = await corpusStub(env, ref).status(ref);
	return r.ok ? json({ profile: ref.profile, generation: ref.generation, held: HELD, ...r.value }) : json({ error: r.error }, corpusStatusCode(r.error.code));
}

// ---------- daily refresh (account/refresh.ts, profile/daily-proof.ts) ----------

const dayId = z.string().regex(/^\d{4}-\d{2}-\d{2}$/), refreshId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const claimBody = z.object({ profile: z.string().regex(PROFILE_NAME).optional(), repo: ingestSchema.shape.repo, day: dayId, claim_id: refreshId, request_id: refreshId }).strict();
const planBody = claimBody.extend({ parts: z.record(z.string(), z.unknown()), manifest_hash: hex64 }).strict();
const finishBody = claimBody.extend({ outcome: z.enum(["done", "failed", "abandoned"]), reason: z.string().regex(/^[a-z_]{1,64}$/).optional() }).strict();
const refreshIngest = workObject.extend({ refresh: z.object({ day: dayId, claim_id: refreshId, part: z.number().int().min(0).max(63), part_hash: hex64 }).strict() }).strict()
	.refine((v) => !v.session && !v.digests.length && !v.manifests.length && !v.commits.length && !v.marker && !!v.as_of && (v.prs.length > 0) !== (v.tickets.length > 0),
		{ message: "a daily part holds PR or ticket snapshots only, with as_of" })
	.refine((v) => !v.tickets.length || v.profile === "work", { path: ["profile"], message: "Jira tickets go only to profile \"work\", named explicitly" });
const refreshCode = (code: string) => (code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "unavailable" ? 503
	: code === "already_exists" || code === "busy" || code === "idempotency_mismatch" ? 409 : 400);
const days = (env: Env, userId: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(userId)) as unknown as Pick<AccountStore, "refreshClaim" | "refreshPlan" | "refreshFinish" | "refreshStatus">;
const invalid = (e: z.ZodError) => json({ error: { code: "validation", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) } }, 400);

/** A registered ingest device token: daily refresh is bound to a device, which an owner login cannot supply. */
async function refreshDevice(request: Request, env: Env): Promise<Response | AccountContext & { deviceId: string }> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const ctx = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	const caller = ctx.value.caller;
	if (caller.kind !== "device" || !caller.deviceId || !caller.scopes.includes("ingest")) return json({ error: { code: "forbidden", message: "daily refresh needs an ingest device token" } }, 403);
	return { ...ctx.value, deviceId: caller.deviceId };
}

/** The exact body text, hashed by the caller before anything parses it. */
async function rawJson(request: Request, max: number): Promise<Response | { text: string; value: unknown }> {
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return json({ error: { code: "validation", message: "send JSON" } }, 400);
	const text = await request.text();
	if (Buffer.byteLength(text, "utf8") > max) return json({ error: { code: "size_budget", message: `a daily refresh request may hold at most ${max} bytes`, details: { reason: "request_bytes" } } }, 413);
	try { return { text, value: JSON.parse(text) as unknown }; } catch { return json({ error: { code: "validation", message: "send JSON" } }, 400); }
}

/** The active profile a daily request routes to, like an upload, never me. */
function refreshRoute(ctx: AccountContext, input: { profile?: string | undefined; repo?: { remote?: string | undefined; path?: string | undefined } | undefined }): Response | ProfileRef & { routedBy: string } {
	const route = routeWrite(ctx.caller, ctx.rules, ctx.known, { ...(input.profile ? { profile: input.profile } : {}), ...(input.repo ? { repo: input.repo } : {}) });
	if (!route.ok) return json({ error: route.error }, route.error.code === "forbidden" ? 403 : 400);
	if (route.value.profile === "me") return json({ error: { code: "forbidden", message: "daily refresh never goes to me" } }, 403);
	return { ...ctx.profiles.find((p) => p.profile === route.value.profile)!, routedBy: route.value.routedBy };
}

/** POST /v1/refresh/claim, /plan and /finish: the device's control requests, bound to their exact body bytes. */
async function refreshControl(request: Request, env: Env, op: "claim" | "plan" | "finish"): Promise<Response> {
	const ctx = await refreshDevice(request, env);
	if (ctx instanceof Response) return ctx;
	const raw = await rawJson(request, 1_000_000);
	if (raw instanceof Response) return raw;
	const parsed = (op === "claim" ? claimBody : op === "plan" ? planBody : finishBody).safeParse(raw.value);
	if (!parsed.success) return invalid(parsed.error);
	const ref = refreshRoute(ctx, parsed.data);
	if (ref instanceof Response) return ref;
	const d = parsed.data as z.infer<typeof finishBody> & Partial<z.infer<typeof planBody>>, account = days(env, env.OWNER_USER_ID);
	const c = { day: d.day, claim_id: d.claim_id, request_id: d.request_id, body_sha256: sha256(raw.text) }, who = { userId: ref.userId, profile: ref.profile, generation: ref.generation };
	const r = op === "claim" ? await account.refreshClaim(who, ctx.deviceId, c)
		: op === "plan" ? await account.refreshPlan(who, ctx.deviceId, { ...c, parts: d.parts as unknown as Parts, manifest_hash: d.manifest_hash! })
			: await account.refreshFinish(ref.profile, { deviceId: ctx.deviceId }, { ...c, outcome: d.outcome, reason: d.reason ?? null });
	return r.ok ? json({ operation: op, profile: ref.profile, routed_by: ref.routedBy, ...r.value }) : json({ error: r.error }, refreshCode(r.error.code));
}

/** GET /v1/refresh/status: read-only, exact, for the owner or bound device, including an explicitly named inactive profile. */
async function refreshStatus(request: Request, env: Env): Promise<Response> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	const context = await accountStub(env, env.OWNER_USER_ID).context(auth.principal);
	if (!context.ok) return json({ error: context.error }, context.error.code === "unavailable" ? 503 : 401);
	const ctx = context.value, caller = ctx.caller;
	if (caller.kind !== "owner" && (caller.kind !== "device" || !caller.deviceId || !caller.scopes.includes("ingest"))) return json({ error: { code: "forbidden", message: "daily refresh needs an ingest device token" } }, 403);
	const q = z.object({ profile: z.string().regex(PROFILE_NAME).optional(), repo: z.string().min(1).max(512).optional(), day: dayId, claim_id: refreshId }).strict()
		.safeParse(Object.fromEntries(new URL(request.url).searchParams));
	if (!q.success) return invalid(q.error);
	let profile = q.data.profile;
	if (profile) {
		if (profile === "me" || !mayUse(ctx.caller, profile)) return json({ error: { code: "forbidden", message: `this caller may not use profile '${profile}'` } }, 403);
	} else {
		const ref = refreshRoute(ctx, q.data.repo ? { repo: { remote: q.data.repo } } : {});
		if (ref instanceof Response) return ref;
		profile = ref.profile;
	}
	const r = await days(env, env.OWNER_USER_ID).refreshStatus(caller.kind === "owner" ? { owner: true } : { deviceId: caller.deviceId! }, profile, q.data.day, q.data.claim_id);
	return r.ok ? json({ profile, ...r.value }) : json({ error: r.error }, refreshCode(r.error.code));
}

/** One frame of a claimed daily refresh through /v1/ingest: the work schema plus `refresh`, terms registered before any item write. */
async function refreshPart(env: Env, ctx: AccountContext, text: string, raw: Record<string, unknown>): Promise<Response> {
	const caller = ctx.caller;
	if (caller.kind !== "device" || !caller.deviceId) return json({ error: { code: "forbidden", message: "daily refresh needs an ingest device token" } }, 403);
	if (Buffer.byteLength(text, "utf8") > 900_000) return json({ error: { code: "size_budget", message: "a daily part may hold at most 900,000 bytes", details: { reason: "request_bytes" } } }, 413);
	const parsed = refreshIngest.safeParse(raw);
	if (!parsed.success) return invalid(parsed.error);
	const ref = refreshRoute(ctx, parsed.data);
	if (ref instanceof Response) return ref;
	const input = parsed.data, repo = repoNamespace(input.repo?.remote ?? "");
	if (input.prs.length && !repo) return json({ error: { code: "validation", message: "PRs need repo.remote on github.com", details: { reason: "unsupported_remote" } } }, 400);
	const terms = ref.profile === "work" ? uploadTerms(repo, [...input.prs.map((p) => prArgs(repo!, p, input.as_of!)), ...input.tickets.map((t) => ticketArgs(t, input.as_of!))]) : [];
	if (terms.length) {
		const added = await accountStub(env, caller.userId).admin({ op: "addSensitiveTerms", terms });
		if (!added.ok) return json({ error: added.error }, 400);
	}
	// The part hash covers the payload exactly as sent: the body without its outer refresh field, before any schema default.
	const { refresh: m, ...payload } = raw as Record<string, unknown> & { refresh: PartMeta };
	const stub = env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as Pick<ProfileStore, "uploadPart">;
	const r = await stub.uploadPart({ userId: ref.userId, profile: ref.profile, generation: ref.generation }, m, sha256(text), payload as unknown as Payload,
		{ platform: "upload", routedBy: ref.routedBy, userId: caller.userId, deviceId: caller.deviceId });
	return r.ok ? json({ profile: ref.profile, routed_by: ref.routedBy, ...r.value }) : json({ error: r.error }, refreshCode(r.error.code));
}

export async function api(request: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const waitUntil = exec ? (p: Promise<unknown>) => exec.waitUntil(p) : undefined;
	// v2 device-token routes (src/v2-api.ts), before the owner check below; a device token's own /v1/whoami facts answer there.
	const device = await deviceV2(request, env, url, waitUntil);
	if (device) return device;
	if (url.pathname === "/v1/refresh/status" && request.method === "GET") return refreshStatus(request, env);
	const control = /^\/v1\/refresh\/(claim|plan|finish)$/.exec(url.pathname);
	if (control && request.method === "POST") return refreshControl(request, env, control[1] as "claim" | "plan" | "finish");
	if (corpusOn(env) && url.pathname === "/v1/corpus/import" && request.method === "POST") return corpusImport(request, env);
	if (corpusOn(env) && url.pathname === "/v1/corpus/status" && request.method === "GET") return corpusStatus(request, env);
	if (corpusOn(env) && url.pathname === "/v1/corpus/refresh" && request.method === "POST") return corpusRefresh(request, env);
	if ((url.pathname === "/v1/ingest" || url.pathname === "/v1/capture") && request.method === "POST") return capture(request, env, url.pathname);
	if (url.pathname === "/v1/import" && request.method === "POST") return importBatch(request, env);
	if (url.pathname === "/v1/import/audit" && request.method === "GET") return importAudit(request, env);
	if (url.pathname === "/v1/import/review" && (request.method === "GET" || request.method === "POST")) return importReview(request, env);
	if (url.pathname === "/v1/markers" && request.method === "GET") return markersRead(request, env);
	if (url.pathname === "/settings" && request.method === "GET") {
		return new Response(SETTINGS_HTML(env), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP(env), "cache-control": "no-store" } });
	}
	if (url.pathname === "/settings.js" && request.method === "GET") {
		return new Response(SETTINGS_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
	}
	// The dashboard shell and script are public, as /settings is; every data route below stays behind owner(). The site root
	// serves the same shell, and /app stays as an alias.
	if ((url.pathname === "/" || url.pathname === "/app") && request.method === "GET") {
		return new Response(DASHBOARD_HTML(env), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP(env), "cache-control": "no-store" } });
	}
	if (url.pathname === "/app.js" && request.method === "GET") {
		return new Response(DASHBOARD_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
	}
	const auth = await owner(request, env);
	if (!auth.ok) return challenge(env, auth.status, auth.error, auth.description);
	if (auth.principal.kind !== "owner") return json({ error: "forbidden" }, 403);
	if (url.pathname === "/v1/whoami" && request.method === "GET") return json({ claims: auth.claims });

	const account = accountStub(env, auth.principal.userId);
	const ctx = await account.context(auth.principal);
	if (!ctx.ok) return json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
	// v2 owner routes (src/v2-api.ts): reached only after the owner check above, so /api/* stays owner-only.
	const v2 = await ownerV2(request, env, url, ctx.value, account, auth.claims, waitUntil);
	if (v2) return v2;
	const run = async (cmd: AccountCommand) => {
		const r = await account.admin(cmd);
		return r.ok ? json(r.value, cmd.op === "createDevice" ? 201 : 200) : json({ error: r.error }, r.error.code === "not_found" ? 404 : 400);
	};
	// The owner's abandonment of a stranded daily claim: the same terminal path, with the expected day and generation.
	const abandon = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/refresh\/([A-Za-z0-9._:-]{8,128})\/abandon$/.exec(url.pathname);
	if (abandon && request.method === "POST") {
		const raw = await rawJson(request, 1_000_000);
		if (raw instanceof Response) return raw;
		const b = z.object({ day: dayId, generation: z.string().min(1).max(64), request_id: refreshId }).strict().safeParse(raw.value);
		if (!b.success) return invalid(b.error);
		const r = await days(env, auth.principal.userId).refreshFinish(abandon[1]!, { owner: true, generation: b.data.generation },
			{ day: b.data.day, claim_id: abandon[2]!, request_id: b.data.request_id, body_sha256: sha256(raw.text), outcome: "abandoned", reason: "owner_abandoned" });
		return r.ok ? json({ operation: "finish", profile: abandon[1], ...r.value }) : json({ error: r.error }, refreshCode(r.error.code));
	}
	const m = /^\/api\/devices\/([a-z2-7]{16})\/(revoke|default)$/.exec(url.pathname);
	// The owner's review list (section 15): migrated records waiting for a profile and moves a collision stopped. Assign and
	// resolve record the owner's choice only; renames, merges and moves run through the record, Write and move routes.
	if (url.pathname === "/api/review" && request.method === "GET") {
		const q = z.object({ kind: z.enum(["migration", "collision"]).optional(), state: z.enum(["open", "assigned", "resolved"]).optional(), after: z.string().min(1).max(80).optional(),
			limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return json({ error: { code: "validation", message: "kind migration or collision; state open, assigned or resolved; after an id; limit 1 to 100" } }, 400);
		return run({ op: "reviewList", ...(q.data.kind ? { kind: q.data.kind } : {}), ...(q.data.state ? { state: q.data.state } : {}), ...(q.data.after ? { after: q.data.after } : {}), limit: q.data.limit ?? 50 });
	}
	const rv = /^\/api\/review\/([a-z]:[0-9a-f]{40})\/(assign|resolve)$/.exec(url.pathname);
	if (rv && request.method === "POST") {
		const b = await body(request);
		if (rv[2] === "assign") {
			const a = z.object({ profile: z.enum(["work", "personal"]) }).strict().safeParse(b);
			if (!a.success) return json({ error: { code: "validation", message: "send JSON with profile work or personal; nothing is routed into me" } }, 400);
			return run({ op: "reviewAssign", id: rv[1]!, profile: a.data.profile });
		}
		const c = z.object({ choice: z.enum(["renamed", "merged", "kept", "moved"]) }).strict().safeParse(b);
		if (!c.success) return json({ error: { code: "validation", message: "send JSON with choice renamed, merged, kept or moved" } }, 400);
		return run({ op: "reviewResolve", id: rv[1]!, choice: c.data.choice });
	}
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
	const archiveOp = /^\/api\/profiles\/([^/]+)\/archive\/operations(?:\/([a-f0-9-]{36})(?:\/(resume|abort))?)?$/.exec(url.pathname);
	if(archiveOp && (request.method === "POST" || request.method === "GET")) {
		const ref=ctx.value.profiles.find(p=>p.profile===archiveOp[1]);
		if(!ref)return json({error:{code:"not_found",message:"profile is not active"}},404);
		if(request.method === "GET") {
			if(!archiveOp[2]||archiveOp[3])return json({error:{code:"not_found"}},404);
			const r=await profileStub(env,ref).archiveOperationStatus(ref,archiveOp[2]);
			return r.ok?json(r.value):json({error:r.error},r.error.code === "not_found"?404:400);
		}
		const requestId=z.string().min(1).max(256), shortId=z.string().min(1).max(128);
		const schema=archiveOp[3]?z.object({cursor:z.string().min(1).max(1024),request_id:requestId}).strict():z.discriminatedUnion("action",[
			z.object({action:z.literal("forget"),memory_id:shortId,expected_revision:z.number().int().min(1),request_id:requestId}).strict(),
			z.object({action:z.literal("restore"),activity_id:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),request_id:requestId}).strict()]);
		if(archiveOp[2]&&!archiveOp[3])return json({error:{code:"not_found"}},404);
		const parsed=schema.safeParse(await body(request));
		if(!parsed.success)return json({error:{code:"validation",message:"invalid archive operation"}},400);
		const cmd=(archiveOp[3]?{...parsed.data,action:archiveOp[3],operation_id:archiveOp[2]}:parsed.data) as import("./profile/store").ArchiveCommand;
		const r=await profileStub(env,ref).archiveOperation(ref,cmd,{actor:"owner",platform:"dashboard",routedBy:"explicit",userId:auth.principal.userId,payloadHash:requestHash("archive",cmd),
			...(ref.profile === "me"?{meGuard:{explicit:true}}:{})});
		return r.ok?json(r.value):json({error:r.error},r.error.code === "not_found"?404:r.error.code === "revision_conflict"||r.error.code === "moving"?409:r.error.code === "size_budget"?413:400);
	}

	// The owner's node actions and undo (section 15): ordinary writes as actor owner, each with its activity row and undo.
	const node = /^\/api\/profiles\/([^/]+)\/nodes\/([^/]{1,128})\/(pin|unpin|forget|unflag)$/.exec(url.pathname);
	const undo = /^\/api\/profiles\/([^/]+)\/activity\/(\d{1,15})\/undo$/.exec(url.pathname);
	if ((node || undo) && request.method === "POST") {
		const name = (node ?? undo)![1]!;
		const ref = PROFILE_NAME.test(name) ? ctx.value.profiles.find((p) => p.profile === name) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${name}' is not active` } }, 404);
		const cmd: WriteCommand = node ? { op: "owner", args: { action: node[3] as OwnerArgs["action"], memory_id: decodeURIComponent(node[2]!) } }
			: { op: "undo", args: { activity_id: Number(undo![2]), request_id: `undo:${undo![2]}` } };
		const r = await profileStub(env, ref).write(ref, cmd, { actor: "owner", platform: "dashboard", routedBy: "explicit", userId: auth.principal.userId,
			payloadHash: requestHash(cmd.op, cmd.args as unknown as Record<string, unknown>),
			...(name === "me" ? { meGuard: { explicit: true } } : {}) });
		return r.ok ? json(r.value) : json({ error: r.error }, r.error.code === "not_found" ? 404 : r.error.code === "revision_conflict" ? 409 : 400);
	}
	// Restore one removal from the archive (section 15): an ordinary owner write with its activity row, undo and replay as
	// request "restore:<activity id>". This is the owner archive, not backup or point-in-time restore.
	const rst = /^\/api\/profiles\/([^/]+)\/archive\/restore$/.exec(url.pathname);
	if (rst && request.method === "POST") {
		const ref = PROFILE_NAME.test(rst[1]!) ? ctx.value.profiles.find((p) => p.profile === rst[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${rst[1]}' is not active` } }, 404);
		const b = restoreBody.safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send JSON with activity_id, the removal to restore" } }, 400);
		const args = { activity_id: b.data.activity_id, request_id: `restore:${b.data.activity_id}` };
		const r = await profileStub(env, ref).write(ref, { op: "restore", args }, { actor: "owner", platform: "dashboard", routedBy: "explicit", userId: auth.principal.userId,
			payloadHash: requestHash("restore", args), ...(ref.profile === "me" ? { meGuard: { explicit: true } } : {}) });
		if (!r.ok) {
			const code = r.error.code;
			return json({ error: r.error }, code === "not_found" ? 404 : code === "revision_conflict" || code === "moving" ? 409 : code === "size_budget" ? 413 : 400);
		}
		const { created, ...value } = r.value;
		if (created.length) await account.recordNodes(ref.profile, created);
		return json(value);
	}
	// The daily batch's last lease and last skip or park, for the dashboard's profile card (section 15).
	const batch = /^\/api\/profiles\/([^/]+)\/batch$/.exec(url.pathname);
	if (batch && request.method === "GET") {
		const ref = PROFILE_NAME.test(batch[1]!) ? ctx.value.profiles.find((p) => p.profile === batch[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${batch[1]}' is not active` } }, 404);
		const r = await profileStub(env, ref).read(ref, { kind: "batch_status" });
		return r.ok ? json(r.value) : json({ error: r.error }, 400);
	}
	// The model of the owner for the About you page (section 15), read-only; pin, unpin, forget and unflag are the node actions above.
	const model = /^\/api\/profiles\/([^/]+)\/owner-model$/.exec(url.pathname);
	if (model && request.method === "GET") {
		const ref = PROFILE_NAME.test(model[1]!) ? ctx.value.profiles.find((p) => p.profile === model[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${model[1]}' is not active` } }, 404);
		const limit = url.searchParams.get("limit");
		const r = await profileStub(env, ref).read(ref, { kind: "owner_model", after: url.searchParams.get("after"), limit: limit === null ? 50 : Number(limit) });
		return r.ok ? json(r.value) : json({ error: r.error }, 400);
	}
	// One profile's work board, for the dashboard's work page (sections 13 and 15). It never follows a link into another profile.
	const brd = /^\/api\/profiles\/([^/]+)\/board$/.exec(url.pathname);
	if (brd && request.method === "GET") {
		const ref = PROFILE_NAME.test(brd[1]!) ? ctx.value.profiles.find((p) => p.profile === brd[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${brd[1]}' is not active` } }, 404);
		const q = boardQuery.safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return json({ error: { code: "validation", message: "as_of must be an ISO date; limit 1 to 200" } }, 400);
		const r = await profileStub(env, ref).read(ref, { kind: "board", asOf: new Date(q.data.as_of ?? Date.now()).toISOString(), limit: q.data.limit ?? 50, known: ctx.value.known });
		return r.ok ? json(r.value) : json({ error: r.error }, 400);
	}
	// The dashboard's memory list, search and draft save (section 15): the MCP tools' own dispatch (routing, redaction, request
	// binding, the me guard), pinned to one active profile. Save takes only the fields the draft form sends, so it never moves,
	// retires or compacts a record; an edit names a record this profile shows, so a record held elsewhere is refused, not moved.
	// Review lists, promotes or dismisses this profile's captured candidates; the profile is always named, so the tool refuses a
	// candidate held in another profile before anything is bound or written, and captures never reach me.
	const tool = /^\/api\/profiles\/([^/]+)\/(recall|save|review)$/.exec(url.pathname);
	if (tool && request.method === "POST") {
		const ref = PROFILE_NAME.test(tool[1]!) ? ctx.value.profiles.find((p) => p.profile === tool[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${tool[1]}' is not active` } }, 404);
		const b = await body(request);
		const allowed = tool[2] === "recall" ? DASHBOARD_RECALL : tool[2] === "review" ? DASHBOARD_REVIEW : DASHBOARD_SAVE;
		if (!b || Object.keys(b).some((k) => !allowed.includes(k))) return json({ error: { code: "validation", message: `send JSON with only ${allowed.join(", ")}` } }, 400);
		if (tool[2] === "save" && typeof b.memory_id === "string") {
			const held = await profileStub(env, ref).read(ref, { kind: "shown", ids: [b.memory_id] });
			if (!held.ok) return json({ error: held.error }, held.error.code === "busy" ? 503 : 400);
			if (!(held.value as string[]).length) return json({ error: { code: "not_found", message: "no record with this id in this profile" } }, 404);
		}
		const { channels, count_hits, ...args } = b;
		const opts = recallOptions.safeParse({ ...(channels !== undefined ? { channels } : {}), ...(count_hits !== undefined ? { count_hits } : {}) });
		if (!opts.success) return json({ error: { code: "validation", message: "channels is lexical and/or vector; count_hits is true or false" } }, 400);
		const r = await callTool({ env, caller: ctx.value.caller, account: ctx.value, platform: "dashboard", actor: "owner", ...(waitUntil ? { waitUntil } : {}) }, { recall: "recall_memories", save: "save_memory", review: "review_candidates" }[tool[2] as "recall" | "save" | "review"],
			{ ...args, ...(tool[2] === "save" && typeof b.memory_id === "string" ? {} : { profile: ref.profile }) }, opts.data);
		if (r.ok) return json(r.value);
		const code = r.error.code;
		return json({ error: r.error }, code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "revision_conflict" || code === "moving" || code === "busy" ? 409
			: code === "size_budget" ? 413 : code === "unavailable" ? 503 : 400);
	}
	// The dashboard's move of one record to another active profile (sections 9 and 15): save_memory's own transfer, run as the owner,
	// with its request id required so a retry after a lost answer replays the stored result. The record must be held by the source
	// shown here (a new or unfinished move) or already by the destination (a replay); held anywhere else, it moved since it was shown.
	const mv = /^\/api\/profiles\/([^/]+)\/move$/.exec(url.pathname);
	if (mv && request.method === "POST") {
		const ref = PROFILE_NAME.test(mv[1]!) ? ctx.value.profiles.find((p) => p.profile === mv[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${mv[1]}' is not active` } }, 404);
		const b = await body(request);
		const m = z.object({ memory_id: z.string().min(1).max(128), to: z.string().regex(PROFILE_NAME), company_free: z.boolean().optional(), request_id: z.string().min(1).max(256),
			generation: z.string().min(1).max(64).optional() }).strict().safeParse(b);
		if (!m.success || m.data.to === ref.profile) return json({ error: { code: "validation", message: "send JSON with memory_id, to (another profile), request_id and optional company_free and generation" } }, 400);
		// The source version the page showed, when sent, must still be the source's; the intent then binds it.
		if (m.data.generation !== undefined && m.data.generation !== ref.generation) return json({ error: { code: "busy", message: "the source profile changed since it was shown; read it again", details: { reason: "generation_changed" } } }, 409);
		const c = { env, caller: ctx.value.caller, account: ctx.value, platform: "dashboard", actor: "owner" as const, moveFrom: { profile: ref.profile, generation: ref.generation } };
		const owner = await ownerOf(c, m.data.memory_id);
		if (!owner) return json({ error: { code: "not_found", message: "no record with this id" } }, 404);
		if (owner !== ref.profile && owner !== m.data.to) return json({ error: { code: "validation", message: "this record is now held by another profile; read it again", details: { reason: "record_elsewhere" } } }, 409);
		const r = await callTool(c, "save_memory", { memory_id: m.data.memory_id, profile: m.data.to, request_id: m.data.request_id, ...(m.data.company_free ? { company_free: true } : {}) });
		if (r.ok) return json(r.value);
		const code = r.error.code;
		if (["record_elsewhere", "wrong_profile", "already_there"].includes((r.error.details as { reason?: string } | undefined)?.reason ?? "")) return json({ error: r.error }, 409);
		// Already in the destination under a request id that never moved it: nothing was written.
		if ((r.error.details as { reason?: string } | undefined)?.reason === "no_changes") return json({ error: { code: "validation", message: "this record is already in that profile", details: { reason: "already_there" } } }, 409);
		return json({ error: r.error }, code === "not_found" ? 404 : code === "forbidden" ? 403 : code === "revision_conflict" || code === "moving" || code === "busy" || code === "idempotency_mismatch" ? 409
			: code === "size_budget" ? 413 : code === "unavailable" ? 503 : 400);
	}
	// Owner page reads (section 15), all read-only: a node's entity page by id or key, the map, a path, a timeline, journals and
	// activity. A link into another profile stays {id, readable: false}: a page reads another profile only when the owner opens it there.
	const ent = /^\/api\/profiles\/([^/]+)\/nodes\/(by-key\/)?([^/]+)$/.exec(url.pathname);
	const page = /^\/api\/profiles\/([^/]+)\/(journals|map|graph|path|timeline|activity|archive)$/.exec(url.pathname);
	if ((ent || page) && request.method === "GET") {
		const name = (ent ?? page)![1]!;
		const ref = PROFILE_NAME.test(name) ? ctx.value.profiles.find((p) => p.profile === name) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${name}' is not active` } }, 404);
		const params = Object.fromEntries(url.searchParams), known = ctx.value.known;
		const bad = (message: string) => json({ error: { code: "validation", message } }, 400);
		let q: ReadQuery;
		if (ent) {
			const target = decoded(ent[3]!), p = entityQuery.safeParse(params);
			if (target === null || target.length > (ent[2] ? 256 : 128) || !p.success) return bad("a node id of at most 128 or a key of at most 256 characters; as_of an ISO date; before a revision; cursor with content=all");
			q = { kind: "entity", node: ent[2] ? { key: target } : { id: target }, ...(p.data.as_of ? { asOf: isoOf(p.data.as_of)! } : {}),
				...(p.data.before ? { before: p.data.before } : {}), ...(p.data.content ? { content: p.data.cursor ? { cursor: p.data.cursor } : {} } : {}), known };
		} else if (page![2] === "journals") {
			const p = journalsQuery.safeParse(params);
			if (!p.success) return bad("after pages the list; id with entries_after pages one journal, limit 1 to 25");
			q = p.data.id !== undefined ? { kind: "journal", id: p.data.id, after: p.data.entries_after ?? 0, limit: p.data.limit ?? 20 }
				: { kind: "journals", after: p.data.after ?? null, limit: p.data.limit ?? 50 };
		} else if (page![2] === "map") {
			const p = mapQuery.safeParse(params);
			if (!p.success) return bad("center a node id or center_key a key; depth 1 or 2; as_of an ISO date");
			q = { kind: "map", ...(p.data.center ? { center: { id: p.data.center } } : p.data.center_key ? { center: { key: p.data.center_key } } : {}), depth: p.data.depth ?? 1, ...(p.data.as_of ? { asOf: isoOf(p.data.as_of)! } : {}), known };
		} else if (page![2] === "graph") {
			// The whole graph as metadata, nodes or current links paged by keyset; a selected record's detail stays the entity read.
			const p = graphQuery.safeParse(params);
			if (!p.success) return bad("part nodes or edges; after the previous page's next_after; limit 1 to 2000");
			q = { kind: "graph", part: p.data.part, after: p.data.after ?? null, limit: p.data.limit ?? (p.data.part === "nodes" ? 1000 : 2000) };
		} else if (page![2] === "timeline") {
			const p = timelineQuery.safeParse(params);
			const from = p.success ? Date.parse(p.data.from) : NaN, to = p.success ? Date.parse(p.data.to) : NaN;
			if (!p.success || Number.isNaN(from) || Number.isNaN(to) || from >= to || to - from > TIMELINE_DAYS * 86_400_000) return bad(`from before to, at most ${TIMELINE_DAYS} days apart; kinds a comma list of node kinds; limit 1 to 500`);
			q = { kind: "page_timeline", from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(p.data.node ? { node: { id: p.data.node } } : {}),
				...(p.data.kinds ? { kinds: p.data.kinds } : {}), limit: p.data.limit ?? 100, known };
		} else if (page![2] === "archive") {
			const p = archiveQuery.safeParse(params);
			if (!p.success) return bad("before an activity id; limit 1 to 50");
			q = { kind: "archive", before: p.data.before ?? null, limit: p.data.limit ?? 20 };
		} else if (page![2] === "activity") {
			const p = activityQuery.safeParse(params);
			if (!p.success) return bad("before an activity id; limit 1 to 100; actor one of the write actors");
			q = { kind: "activity", before: p.data.before ?? null, limit: p.data.limit ?? 50, ...(p.data.actor ? { actor: p.data.actor } : {}) };
		} else {
			// A path runs the graph tool's bidirectional search between two nodes this profile shows: up to 3 paths of at most 4 hops.
			const p = pathQuery.safeParse(params);
			if (!p.success) return bad("from and to node ids; max_depth 2 to 4; as_of an ISO date");
			const held = await profileStub(env, ref).read(ref, { kind: "shown", ids: [p.data.from, p.data.to] });
			if (!held.ok) return json({ error: held.error }, held.error.code === "not_found" ? 404 : 400);
			if ((held.value as string[]).length !== new Set([p.data.from, p.data.to]).size) return json({ error: { code: "not_found", message: "from and to must be nodes this profile shows" } }, 404);
			const r = await trace({ env, caller: ctx.value.caller, account: ctx.value, platform: "dashboard" },
				{ from: { id: p.data.from }, to: { id: p.data.to }, mode: "path", ...(p.data.max_depth ? { max_depth: p.data.max_depth } : {}), ...(p.data.as_of ? { as_of: p.data.as_of } : {}), profile: name });
			return r.ok ? json(r.value) : json({ error: r.error }, r.error.code === "not_found" ? 404 : 400);
		}
		const r = await profileStub(env, ref).read(ref, q);
		return r.ok ? json(r.value) : json({ error: r.error }, r.error.code === "not_found" ? 404 : r.error.code === "busy" ? 503 : 400);
	}
	if (m && request.method === "POST" && m[2] === "revoke") return run({ op: "revokeDevice", id: m[1]! });
	// Owner only, like every route here; the typed name must equal the profile (section 9, wipe).
	const w = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/wipe$/.exec(url.pathname);
	if (w && request.method === "POST") {
		const b = await body(request);
		// An optional generation binds the wipe to the profile the caller showed; the dashboard always sends it.
		if (b && b.generation !== undefined && typeof b.generation !== "string") return json({ error: { code: "validation", message: "generation must be the profile generation shown" } }, 400);
		return run({ op: "wipeProfile", profile: w[1]!, typed: typeof b?.typed === "string" ? b.typed : "", ...(typeof b?.generation === "string" ? { generation: b.generation } : {}) });
	}
	if (w && request.method === "GET") return run({ op: "wipeStatus", profile: w[1]! });
	// The owner's wipe preview (section 9), read only: the other profiles the wipe reads, then one page of one part of one of
	// them. The wiped profile's terms stay in the Worker. A cursor binds both profiles' generations and the part, and must match
	// the plan read now, so a restored or replaced profile restarts the preview instead of mixing two states.
	const wp = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/wipe\/preview$/.exec(url.pathname);
	if (wp && request.method === "GET") {
		const q = z.object({ target: z.string().regex(PROFILE_NAME).optional(), part: z.enum(["purge", "handwritten"]).optional(), after: z.string().min(1).max(2048).optional() })
			.strict().safeParse(Object.fromEntries(url.searchParams));
		if (!q.success || !q.data.target !== !q.data.part || (q.data.after && !q.data.target)) return json({ error: { code: "validation", message: "send no parameters, or target with part and the previous page's after" } }, 400);
		const plan = await account.admin({ op: "wipePlan", profile: wp[1]! });
		if (!plan.ok) return json({ error: plan.error }, plan.error.code === "not_found" ? 404 : plan.error.code === "busy" ? 409 : 400);
		const v = plan.value as { generation: string; status: string; targets: ProfileRef[]; terms: string[] };
		if (v.status !== "active") return json({ error: { code: "validation", message: "the preview is for an active profile", details: { reason: "not_active" } } }, 409);
		if (!q.data.target) return json({ profile: wp[1], generation: v.generation, targets: v.targets.map((t) => t.profile) });
		const target = v.targets.find((t) => t.profile === q.data.target);
		if (!target) return json({ error: { code: "validation", message: "this wipe does not read that profile" } }, 400);
		const bind = { s: wp[1]!, sg: v.generation, t: target.profile, tg: target.generation, p: q.data.part! };
		let after = "";
		if (q.data.after) {
			let c: Record<string, unknown> | null = null;
			try { c = JSON.parse(Buffer.from(q.data.after, "base64url").toString("utf8")) as Record<string, unknown>; } catch { c = null; }
			if (!c || c.s !== bind.s || c.sg !== bind.sg || c.t !== bind.t || c.tg !== bind.tg || c.p !== bind.p || typeof c.a !== "string" || !c.a) {
				return json({ error: { code: "validation", message: "this preview page no longer matches; start the preview again", details: { reason: "stale_cursor" } } }, 400);
			}
			after = c.a;
		}
		const r = await profileStub(env, target).read(target, { kind: "wipe_preview", profile: wp[1]!, terms: v.terms, part: bind.p, after });
		if (!r.ok) return json({ error: r.error }, r.error.code === "not_found" ? 404 : r.error.code === "busy" ? 503 : 400);
		const page = r.value as { items: unknown[]; after: string | null };
		return json({ profile: wp[1], generation: v.generation, target: target.profile, target_generation: target.generation, part: bind.p, items: page.items,
			next: page.after === null ? null : Buffer.from(JSON.stringify({ ...bind, a: page.after }), "utf8").toString("base64url") });
	}
	// Routing rules (section 9), owner only: the stored rules, their whole-list replacement through setRules (never a me rule;
	// last writer wins), and a read-only test of a repo against the current resolver. Nothing here routes or writes memory.
	if (url.pathname === "/api/rules" && request.method === "GET") return json({ rules: ctx.value.rules, profiles: ctx.value.known.filter((p) => p !== "me") });
	if (url.pathname === "/api/rules" && request.method === "PUT") {
		const b = z.object({ rules: z.array(z.object({ priority: z.number().int().min(-1_000_000).max(1_000_000), match: z.enum(["remote", "path"]),
			pattern: z.string().min(1).max(300), profile: z.string().regex(PROFILE_NAME), enabled: z.boolean() }).strict()).max(128) }).strict().safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send rules: up to 128 of {priority, match remote or path, pattern, profile, enabled}" } }, 400);
		return run({ op: "setRules", rules: b.data.rules });
	}
	if (url.pathname === "/api/rules/test" && request.method === "POST") {
		const b = z.object({ remote: z.string().min(1).max(500).optional(), path: z.string().min(1).max(1_000).optional() }).strict()
			.refine((v) => v.remote !== undefined || v.path !== undefined).safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send remote, path or both" } }, 400);
		const repo = { ...(b.data.remote ? { remote: b.data.remote } : {}), ...(b.data.path ? { path: b.data.path } : {}) }, { caller, rules, known } = ctx.value;
		const write = routeWrite(caller, rules, known, { repo }), read = readSet(caller, rules, known, { repo });
		return json({ remote: b.data.remote ? normalizeRemote(b.data.remote) : null, path: b.data.path ?? null, rule: matchRule(rules, repo) ?? null,
			write: write.ok ? { profile: write.value.profile, routed_by: write.value.routedBy } : { error: write.error },
			read: read.ok ? { primary: read.value.primary, with_me: read.value.withMe, routed_by: read.value.routedBy } : { error: read.error } });
	}
	// The restore drill (section 18): one profile's newest compatible export into a scratch generation; the account stays open.
	if (url.pathname === "/api/backups/drill" && request.method === "GET") return run({ op: "drillStatus" });
	if (url.pathname === "/api/backups/drill" && request.method === "POST") {
		const b = z.object({ profile: z.string().regex(PROFILE_NAME), generation: z.string().min(1).max(64).optional(), request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) })
			.strict().safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send profile, request_id and optionally generation, the one shown" } }, 400);
		return run({ op: "beginDrill", ...b.data });
	}
	const dr = /^\/api\/backups\/drill\/(step|cleanup)$/.exec(url.pathname);
	if (dr && request.method === "POST") {
		const b = z.object({ id: z.uuid() }).strict().safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send id, the drill shown" } }, 400);
		return run({ op: dr[1] === "step" ? "drillStep" : "drillCleanup", id: b.data.id });
	}
	// Backups and restore from an export (section 18). One recovery at a time; it closes the account until open or abort.
	if (url.pathname === "/api/backups/export" && request.method === "POST") {
		const b = await body(request);
		// preserve_existing: this one manual export keeps every older export (no retention); the next default export prunes to two again.
		if (b && "preserve_existing" in b && typeof b.preserve_existing !== "boolean") return json({ error: { code: "validation", message: "preserve_existing must be true or false" } }, 400);
		return run({ op: "export", ...(typeof b?.profile === "string" ? { profile: b.profile } : {}), ...(b?.corpus === true ? { corpus: true } : {}),
			...(b?.preserve_existing === true ? { preserve_existing: true } : {}) });
	}
	// Point-in-time restore of a profile (section 18): to a time in the last 30 days, or the reversal of an opened one by its
	// recorded undo bookmark. It closes the account, records the bookmarks before the profile restarts, and opens only when reconciled.
	const pit = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/pitr$/.exec(url.pathname);
	if (pit && request.method === "POST") {
		const b = z.union([z.object({ at: z.iso.datetime({ offset: true }) }).strict(), z.object({ undo: z.string().uuid() }).strict()]).safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send JSON with at, an ISO time, or undo, the id of the restore to reverse" } }, 400);
		return run({ op: "beginPitr", profile: pit[1]!, ...b.data });
	}
	// The owner's choice between two copies that the fixed rules leave unresolved (section 18, step 4), bound to the recovery shown.
	if (url.pathname === "/api/recovery/conflicts" && request.method === "GET") {
		const q = z.object({ id: z.uuid(), after: z.string().min(1).max(128).optional() }).strict().safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return json({ error: { code: "validation", message: "send id, the recovery shown, and optionally after, the last node id of the previous page" } }, 400);
		return run({ op: "recoveryConflicts", id: q.data.id, ...(q.data.after ? { after: q.data.after } : {}) });
	}
	// Where one request id sits for the open recovery: content-free placement across the active profiles and the account. Read only.
	if (url.pathname === "/api/recovery/request" && request.method === "GET") {
		const q = z.object({ id: z.uuid(), request_id: z.string().min(1).max(256) }).strict().safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return json({ error: { code: "validation", message: "send id, the recovery shown, and request_id" } }, 400);
		return run({ op: "recoveryRequest", id: q.data.id, request_id: q.data.request_id });
	}
	// Reruns an unresolved account restore's index rebuild only when every finding is a request id the read above shows stale.
	if (url.pathname === "/api/recovery/recheck" && request.method === "POST") {
		const b = z.object({ id: z.uuid(), request_ids: z.array(z.string().min(1).max(256)).min(1).max(50) }).strict().safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send id, the recovery shown, and request_ids, its request_elsewhere findings" } }, 400);
		return run({ op: "recheckRequests", ...b.data });
	}
	if (url.pathname === "/api/recovery/conflicts/resolve" && request.method === "POST") {
		const copy = z.object({ profile: z.string().regex(PROFILE_NAME), generation: z.string().min(1).max(64).nullable(), status: z.string().min(1).max(32).nullable(),
			revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).strict();
		const b = z.object({ id: z.uuid(), node: z.string().min(1).max(128), keep: z.string().regex(PROFILE_NAME), expect: z.array(copy).length(2),
			request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }).strict().safeParse(await body(request));
		if (!b.success) return json({ error: { code: "validation", message: "send id, node, keep, expect (both copies as shown) and request_id" } }, 400);
		return run({ op: "resolveConflict", ...b.data });
	}
	const rs = /^\/api\/restores\/([0-9a-f-]{36})$/.exec(url.pathname);
	if (rs && request.method === "GET") return run({ op: "restoreRecord", id: rs[1]! });
	// A profile's corpus exports, weekly and kept two, and their restore into the current, empty corpus generation.
	const cx = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/corpus\/(exports|restore)$/.exec(url.pathname);
	if (cx && cx[2] === "exports" && request.method === "GET") return run({ op: "listExports", profile: cx[1]!, corpus: true });
	if (cx && cx[2] === "restore" && request.method === "POST") {
		const b = await body(request);
		return run({ op: "beginCorpusRestore", profile: cx[1]!, export: typeof b?.export === "string" ? b.export : "latest" });
	}
	const ex = /^\/api\/profiles\/([a-z][a-z0-9-]{0,11})\/(exports|restore)$/.exec(url.pathname);
	if (ex && ex[2] === "exports" && request.method === "GET") return run({ op: "listExports", profile: ex[1]! });
	if (ex && ex[2] === "restore" && request.method === "POST") {
		const b = await body(request);
		return run({ op: "beginRestore", profile: ex[1]!, export: typeof b?.export === "string" ? b.export : "latest" });
	}
	// The account's own restore (section 18): it closes the account, disables every device token and opens only when reconciled.
	if (url.pathname === "/api/account/exports" && request.method === "GET") return run({ op: "listExports" });
	if (url.pathname === "/api/account/restore" && request.method === "POST") {
		const b = await body(request);
		return run({ op: "beginAccountRestore", export: typeof b?.export === "string" ? b.export : "latest" });
	}
	if (url.pathname === "/api/recovery" && request.method === "GET") return run({ op: "restoreStatus" });
	const rc = /^\/api\/recovery\/(step|open|abort)$/.exec(url.pathname);
	if (rc && request.method === "POST") {
		// An optional id binds the call to the recovery the caller saw; the account refuses it if another is open now.
		const b = await body(request);
		if (b && b.id !== undefined && typeof b.id !== "string") return json({ error: { code: "validation", message: "id must be the recovery id" } }, 400);
		return run({ op: rc[1] === "step" ? "restoreStep" : rc[1] === "open" ? "openRestore" : "abortRestore", ...(typeof b?.id === "string" ? { id: b.id } : {}) });
	}
	if (m && request.method === "POST" && m[2] === "default") {
		const b = await body(request);
		return run({ op: "setDeviceDefault", id: m[1]!, defaultProfile: typeof b?.default_profile === "string" ? b.default_profile : null });
	}
	return json({ error: "not_found" }, 404);
}
