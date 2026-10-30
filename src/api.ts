// Owner-only REST: protected-resource metadata, whoami, device tokens and the minimal Settings page (sections 8 and 15).
import type { AccountCommand, AccountContext } from "./account/store";
import { authenticate, verifyJwt } from "./auth";
import { canonicalJson, requestHash, sha256 } from "./domain/ids";
import { stripPersonal } from "./domain/personal";
import { redactPayload } from "./domain/redact";
import { Fail, MEMORY_KINDS, MEMORY_TYPES, NODE_KINDS, ok, SCOPES, type OwnerArgs, type ProfileRef, type ReadQuery, type WriteCommand } from "./domain/types";
import { z } from "zod";
import { PROFILE_NAME } from "./domain/types";
import { accountStub, profileStub } from "./mcp";
import { trace } from "./graph-tools";
import { chunkSchema, corpusOn, corpusStub, refreshSchema } from "./corpus-tools";
import { checkChunk, chunkTerms, HELD, refreshTerms, type RefreshCommand } from "./corpus/store";
import { commitArgs, prArgs, repoNamespace, ticketArgs, TITLE_MAX, uploadTerms, type ImportStep } from "./profile/store";
import { mayUse, routeWrite } from "./routing";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard";
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
const workSchema = ingestSchema.extend({
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
}).strict().refine((v) => v.session || (!v.digests.length && !v.manifests.length), { path: ["session"], message: "digests and manifests need a session" })
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
	const raw = await body(request);
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
	return r.ok ? json({ profile: route.value.profile, routed_by: route.value.routedBy, ...(r.value as Record<string, unknown>) })
		: json({ error: r.error }, r.error.code === "busy" ? 503 : 400);
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
		cost: z.object({ rows: z.number().int(), bytes: z.number().int() }).strict(), part_id: z.string().max(300), sha256: hex64, refresh: refreshStage.optional() }).strict(),
	z.object({ op: z.literal("finalize"), record_id: id, record_sha256: hex64, profile: z.string().regex(PROFILE_NAME), node: importNode,
		parts: z.array(z.object({ part_id: z.string().max(300), sha256: hex64 }).strict()).min(1).max(1000), request_ids: z.array(z.string().min(1).max(256)).max(5000), sha256: hex64, refresh: refreshFinalize.optional() }).strict(),
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
		const step = async (s: ImportStep) => stub.importStep(ref, s);
		const take = (r: Awaited<ReturnType<typeof step>>) => {
			if (!r.ok) { refused(String(r.error.details?.reason ?? r.error.code), r.error.message); return null; }
			return r.value;
		};
		if (c.op === "stage") {
			// Reserve the part's request ids account-wide first, so no ordinary call in any profile can take one before publication.
			const wanted = c.rows.requests.map((q) => ({ request_id: q.request_id, op: q.legacy_op, hash: q.legacy_hash }));
			let reserved = true;
			for (let i = 0; i < wanted.length; i += 400) {
				const r = await account.reserveImport({ profile: c.profile, requests: wanted.slice(i, i + 400) });
				if (!r.ok) { refused(String(r.error.details?.reason ?? r.error.code), r.error.message); reserved = false; break; }
			}
			if (!reserved) continue;
			const r = take(await step({ op: "stage", record_id: c.record_id, record_sha256: c.record_sha256, part: c.part, parts: c.parts, part_id: c.part_id, sha256: c.sha256, rows: c.rows, ...(c.refresh ? { refresh: c.refresh } : {}) }));
			if (r) receipts.push({ ...base, status: r.status, rows_written: r.rows_written ?? 0, bytes: r.bytes ?? 0 });
			continue;
		}
		if (c.op === "link") {
			const r = take(await step({ op: "link", src: c.src, dst: c.dst }));
			if (r) receipts.push({ ...base, status: r.status });
			continue;
		}
		const fin = { record_id: c.record_id, record_sha256: c.record_sha256, node: c.node, parts: c.parts, request_ids: c.request_ids, ...(c.refresh ? { refresh: c.refresh } : {}) };
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
const pathQuery = z.object({ from: id, to: id, max_depth: z.coerce.number().int().min(2).max(4).optional(), as_of: asOfParam }).strict();
const timelineQuery = z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), node: id.optional(),
	kinds: z.string().max(400).transform((v) => v.split(",")).pipe(z.array(z.enum(NODE_KINDS)).min(1).max(NODE_KINDS.length)).optional(),
	limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const activityQuery = z.object({ before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
	actor: z.enum(["agent", "owner", "keep", "index", "maintenance", "migration", "transfer"]).optional() }).strict();
const archiveQuery = z.object({ before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();
const restoreBody = z.object({ activity_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };
const isoOf = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
const TIMELINE_DAYS = 90;

const auditQuery = z.object({ profile: z.string().regex(PROFILE_NAME), after: z.string().min(1).max(300).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
	record: id.optional(), rows: z.enum(["revisions", "requests"]).optional() }).strict();

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

export async function api(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (corpusOn(env) && url.pathname === "/v1/corpus/import" && request.method === "POST") return corpusImport(request, env);
	if (corpusOn(env) && url.pathname === "/v1/corpus/status" && request.method === "GET") return corpusStatus(request, env);
	if (corpusOn(env) && url.pathname === "/v1/corpus/refresh" && request.method === "POST") return corpusRefresh(request, env);
	if ((url.pathname === "/v1/ingest" || url.pathname === "/v1/capture") && request.method === "POST") return capture(request, env, url.pathname);
	if (url.pathname === "/v1/import" && request.method === "POST") return importBatch(request, env);
	if (url.pathname === "/v1/import/audit" && request.method === "GET") return importAudit(request, env);
	if (url.pathname === "/v1/markers" && request.method === "GET") return markersRead(request, env);
	if (url.pathname === "/settings" && request.method === "GET") {
		return new Response(SETTINGS_HTML(env), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP(env), "cache-control": "no-store" } });
	}
	if (url.pathname === "/settings.js" && request.method === "GET") {
		return new Response(SETTINGS_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
	}
	// The dashboard shell and script are public, as /settings is; every data route below stays behind owner().
	if (url.pathname === "/app" && request.method === "GET") {
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
			...(name === "me" ? { meGuard: { explicit: true, context: null, companyFree: false, sensitiveTerms: ctx.value.sensitiveTerms } } : {}) });
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
			payloadHash: requestHash("restore", args), ...(ref.profile === "me" ? { meGuard: { explicit: true, context: null, companyFree: false, sensitiveTerms: ctx.value.sensitiveTerms } } : {}) });
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
	// Owner page reads (section 15), all read-only: a node's entity page by id or key, the map, a path, a timeline, journals and
	// activity. A link into another profile stays {id, readable: false}: a page reads another profile only when the owner opens it there.
	const ent = /^\/api\/profiles\/([^/]+)\/nodes\/(by-key\/)?([^/]+)$/.exec(url.pathname);
	const page = /^\/api\/profiles\/([^/]+)\/(journals|map|path|timeline|activity|archive)$/.exec(url.pathname);
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
		return run({ op: "wipeProfile", profile: w[1]!, typed: typeof b?.typed === "string" ? b.typed : "" });
	}
	if (m && request.method === "POST" && m[2] === "default") {
		const b = await body(request);
		return run({ op: "setDeviceDefault", id: m[1]!, defaultProfile: typeof b?.default_profile === "string" ? b.default_profile : null });
	}
	return json({ error: "not_found" }, 404);
}
