// v2 routes (X spine wiring). Each block authenticates, validates and calls the module that owns the logic. Device routes run
// before api.ts's owner check; owner routes only after it, so /api/* stays owner-only and device tokens never reach them.
import type { AccountContext, AccountHealth, AccountStore, Principal } from "./account/store";
import { authenticate } from "./auth";
import { z } from "zod";
import { PROFILE_NAME, type FactFlagArgs, type Outcome, type ProfileRef } from "./domain/types";
import { accountStub, profileStub, recall, recallRequestSchema } from "./mcp";
import { corpusFiles, corpusFilesSql, embeddingsOn, type SearchCounts } from "./profile/store";
import { corpusOn, corpusStub } from "./corpus-tools";
import { assembleSnapshot } from "./viewer/snapshot";
import { eventStream, parseCursor, STREAM_MAX_MS } from "./viewer/events";
import { parseClientStatus, STATUS_MAX_BYTES } from "./client-status";
import { healthReport } from "./health";
import { mayUse, routeWrite } from "./routing";
import { factRoute, REPO_KEY } from "./profile/store";
import { requestHash } from "./domain/ids";
import { parseEvalRun } from "./eval";
import { brief } from "./brief";
import { mergeSessions, parseSessionsCursor } from "./sessions";
import type { ActivitySummary, FeedItem, LeaseFacts, Page, ProfileSnapshotPart, ProjectProfile, SessionRow, ViewerCursor } from "./viewer/types";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, unavailable: 503, busy: 409, revision_conflict: 409, profile_wiped: 410 };
export const reply = (r: Outcome<unknown>) => (r.ok ? json(r.value) : json({ error: r.error }, STATUS[r.error.code] ?? 400));
export const invalid = (message: string) => json({ error: { code: "validation", message } }, 400);
const forbidden = (message: string) => json({ error: { code: "forbidden", message } }, 403);
const profileName = z.string().regex(PROFILE_NAME);
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500);
type Waiter = (p: Promise<unknown>) => void;

/** A device token (or an OAuth owner token on the resource audience) with its account context; revoked or disabled devices fail in context(). */
async function deviceCaller(request: Request, env: Env): Promise<Response | AccountContext> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return json({ error: { code: "unauthorized", message: auth.description ?? auth.error } }, auth.status);
	const ctx = await accountStub(env, env.OWNER_USER_ID!).context(auth.principal as Principal);
	return ctx.ok ? ctx.value : json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
}
/**
 * Repo-fact routes (contract section 1): the raw remote and checkout path route through routeWrite; repo_key is the client's
 * canonical key, checked against the remote by factRoute. v1 bodies carry no path and no repo_key.
 */
/** The owner's flag body (contract section 7): a non-empty reason is required. */
export const flagSchema = z.object({ memory_id: z.string().min(1).max(128).optional(), repo_key: z.string().regex(/^github\.com\//).max(160).optional(), fact_key: z.string().regex(/^[0-9a-f]{16}$/).optional(),
	scope: z.enum(["repo", "user"]).default("repo"), reason: z.string().trim().min(1).max(200), request_id: z.string().min(1).max(256).optional() }).strict()
	.refine((f) => !!f.memory_id || (!!f.fact_key && (f.scope === "user" || !!f.repo_key)), { message: "name memory_id, or fact_key with repo_key" });
export const factRepoSchema = z.object({ repo: z.object({ remote: z.string().min(1).max(512), path: z.string().min(1).max(1024).optional() }).strict(),
	repo_key: z.string().max(160).optional(), profile: profileName.optional() });

/** The job token: a device holding ingest and maintenance. Its device id comes from the token, never from a body. */
const isJob = (c: AccountContext) => c.caller.kind === "device" && !!c.caller.deviceId && c.caller.scopes.includes("ingest") && c.caller.scopes.includes("maintenance");
/** An active profile the caller named and may use; never inferred. */
const usable = (c: AccountContext, profile: string): ProfileRef | undefined => (mayUse(c.caller, profile) ? c.profiles.find((x) => x.profile === profile) : undefined);

async function boundedJson(request: Request, max: number): Promise<Response | { value: unknown }> {
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return invalid("send application/json");
	const text = await request.text();
	if (new TextEncoder().encode(text).length > max) return json({ error: { code: "validation", message: `body over ${max} bytes` } }, 413);
	try { return { value: JSON.parse(text) as unknown }; } catch { return invalid("body is not JSON"); }
}

/**
 * Device routes. Null for any other path. /v1/whoami answers here only for an am_ device token: an enabled device gets its own
 * id, scopes and profiles; the owner's reply stays in api.ts unchanged.
 */
export async function deviceV2(request: Request, env: Env, url: URL, waitUntil: Waiter | undefined): Promise<Response | null> {
	const path = url.pathname, method = request.method;
	if (path === "/v1/whoami" && method === "GET") {
		if (!/^Bearer\s+am_/i.test(request.headers.get("authorization") ?? "")) return null;
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		return json({ kind: "device", device_id: c.caller.deviceId, scopes: c.caller.scopes, profiles: c.caller.profiles === "*" ? c.known : c.caller.profiles });
	}
	// #9 recall for injection and eval: the read scope (a job token has none). Same read set and routing as recall_memories.
	if (path === "/v1/recall" && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!c.caller.scopes.includes("read")) return forbidden("this token cannot read");
		const body = await boundedJson(request, 64_000);
		if (body instanceof Response) return body;
		const p = recallRequestSchema.safeParse(body.value);
		if (!p.success) return invalid(issues(p.error));
		const { channels, count_hits, ...a } = p.data;
		return reply(await recall({ env, caller: c.caller, account: c, platform: `${c.caller.kind}:${c.caller.deviceName ?? "unknown"}`, ...(waitUntil ? { waitUntil } : {}) },
			a, { ...(channels ? { channels } : {}), ...(count_hits !== undefined ? { count_hits } : {}) }));
	}
	// B1 session-start brief: the read scope; routed like the fact routes, plus me's preferences and rules (src/brief.ts).
	if (path === "/v1/brief" && method === "POST") {
		const c = await deviceCaller(request, env);
		return c instanceof Response ? c : brief(request, env, c);
	}
	// Repo-fact injection (contract section 6), kept for compatibility beside /v1/brief: the read scope, routed by raw remote and path.
	// mode inject: the injectable facts for this token's device and the rendered block; mode held: every live and dormant fact.
	if (path === "/v1/facts" && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!c.caller.scopes.includes("read")) return forbidden("this token cannot read");
		const body = await boundedJson(request, 4_000);
		if (body instanceof Response) return body;
		const p = factRepoSchema.extend({ mode: z.enum(["inject", "held"]).optional(), machine: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict().safeParse(body.value);
		if (!p.success) return invalid(issues(p.error));
		const key = factRoute(p.data.repo.remote, p.data.repo_key);
		if (!key.ok) return reply(key);
		const route = routeWrite(c.caller, c.rules, c.known, { ...(p.data.profile ? { profile: p.data.profile } : {}), repo: p.data.repo });
		if (!route.ok) return reply(route);
		if (route.value.profile === "me") return forbidden("repo facts never come from me");
		const ref = c.profiles.find((x) => x.profile === route.value.profile);
		if (!ref) return json({ error: { code: "profile_wiped", message: `profile '${route.value.profile}' is not active` } }, 410);
		const r = await profileStub(env, ref).readV2(ref, p.data.mode === "held" ? { kind: "fact_held", repo_key: key.value } : { kind: "fact_inject", repo_key: key.value, device: p.data.machine ?? "" }); // no machine id: no environment lane
		return r.ok ? json({ profile: ref.profile, routed_by: route.value.routedBy, repo_key: key.value, ...(r.value as object) }) : reply(r);
	}
	// #9 accepted candidates for `agent-memory eval export-candidates`: the read scope, an explicit profile the token may use.
	if (path === "/v1/eval/candidates" && method === "GET") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!c.caller.scopes.includes("read")) return forbidden("this token cannot read");
		const q = z.object({ profile: profileName, cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict()
			.safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return invalid("profile is required; cursor; limit 1 to 100");
		const ref = usable(c, q.data.profile);
		if (!ref) return forbidden(`this token cannot use profile '${q.data.profile}'`);
		return reply(await profileStub(env, ref).readV2(ref, { kind: "accepted_candidates", cursor: q.data.cursor ?? null, limit: q.data.limit ?? 100 }));
	}
	// #11 the job device's capture report: allowlisted counts and times only; its device is the token's.
	if (path === "/v1/status" && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!isJob(c)) return forbidden("send this with the job token");
		const body = await boundedJson(request, STATUS_MAX_BYTES);
		if (body instanceof Response) return body;
		const s = parseClientStatus(body.value, c.caller.deviceId!);
		if (!s.ok) return reply(s);
		const r = await accountStub(env, env.OWNER_USER_ID!).admin({ op: "reportStatus", deviceId: c.caller.deviceId!, body: s.value });
		return r.ok ? json({ reported_at: new Date().toISOString() }) : reply(r);
	}
	// #9 eval scores and counts from the job token, for an explicit profile it may use.
	if (path === "/v1/eval/runs" && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!isJob(c)) return forbidden("send this with the job token");
		const body = await boundedJson(request, 8_000);
		if (body instanceof Response) return body;
		const run = parseEvalRun(body.value);
		if (!run.ok) return reply(run);
		if (!usable(c, run.value.profile)) return forbidden(`this token cannot use profile '${run.value.profile}'`);
		return reply(await accountStub(env, env.OWNER_USER_ID!).admin({ op: "recordEvalRun", deviceId: c.caller.deviceId!, run: run.value }));
	}
	return null;
}

/** Owner routes; api.ts calls this only after its owner check. Null for any other path. */
export async function ownerV2(request: Request, env: Env, url: URL, ctx: AccountContext, account: Pick<AccountStore, "admin">,
	claims: Record<string, unknown> | undefined, _waitUntil: Waiter | undefined): Promise<Response | null> {
	const path = url.pathname, method = request.method, params = Object.fromEntries(url.searchParams);
	const p = /^\/api\/profiles\/([^/]+)\/(.+)$/.exec(path);
	const ref = p && profileName.safeParse(p[1]).success ? ctx.profiles.find((x) => x.profile === p[1]) : undefined;
	const sub = p?.[2] ?? "";
	const notActive = () => json({ error: { code: "not_found", message: `profile '${p![1]}' is not active` } }, 404);
	const today = () => new Date().toISOString().slice(0, 10);

	// #11 health: the sweep on demand, and the report. Every active profile gets one slot; a failed read stays a null slot, so the
	// lexical count reads as unknown instead of a subtotal.
	if (path === "/api/health/sweep" && method === "POST") {
		const r = await account.admin({ op: "health_sweep" });
		return r.ok ? json({ checks: r.value }) : reply(r);
	}
	if (path === "/api/health" && method === "GET") {
		const a = await account.admin({ op: "accountHealth" });
		if (!a.ok) return reply(a);
		const per = await Promise.all(ctx.profiles.map(async (r) => {
			const [lease, counts, facts] = await Promise.all([profileStub(env, r).readV2(r, { kind: "lease_facts" }).catch(() => null), profileStub(env, r).readV2(r, { kind: "search_counts" }).catch(() => null),
				profileStub(env, r).readV2(r, { kind: "fact_health" }).catch(() => null)]);
			return { profile: r.profile, lease: lease?.ok ? lease.value as LeaseFacts : null, counts: counts?.ok ? counts.value as SearchCounts : null, facts: facts?.ok ? facts.value : null };
		}));
		return json({ ...healthReport(a.value as AccountHealth, per.flatMap((x) => (x.lease ? [{ profile: x.profile, facts: x.lease }] : [])),
			per.map((x) => (x.counts ? { usage: x.counts } : null)), embeddingsOn(env)) as object, facts: Object.fromEntries(per.map((x) => [x.profile, x.facts])) });
	}
	// #13 viewer snapshot: one part from every active profile; any failed profile read fails the request, never a smaller total.
	if (path === "/api/viewer/snapshot" && method === "GET") {
		const a = await account.admin({ op: "accountHealth" });
		if (!a.ok) return reply(a);
		const parts: ProfileSnapshotPart[] = [];
		for (const r of await Promise.all(ctx.profiles.map((x) => profileStub(env, x).readV2(x, { kind: "viewer_part", day: today() })))) {
			if (!r.ok) return reply(r);
			parts.push(r.value as ProfileSnapshotPart);
		}
		const h = a.value as AccountHealth, live = h.devices.filter((d) => !d.revoked).map((d) => d.body), meta = env.CF_VERSION_METADATA;
		return json(assembleSnapshot(parts,
			{ checks: h.checks, devices_reporting: live.length, inject_devices: live.filter((b) => b.inject).length, scheduled_devices: live.filter((b) => b.launchd_loaded).length },
			{ version: meta.id, deployed_at: meta.timestamp, at: new Date().toISOString(), embeddings: embeddingsOn(env), corpus: corpusOn(env) }));
	}
	// #14 live events: owner only (this function runs after the owner check). The stream ends at the token's exp or after five
	// minutes; a failed profile read ends it, and the next cursor names only the owner's active profiles.
	if (path === "/api/viewer/events" && method === "GET") {
		const raw = url.searchParams.get("cursor");
		const cursor = raw === null ? {} : parseCursor(raw);
		if (!cursor) return invalid("cursor is not valid");
		const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : Date.now() + STREAM_MAX_MS;
		return eventStream({
			changes: async (cur) => {
				const items: FeedItem[] = [], next: ViewerCursor = {};
				for (const r of ctx.profiles) {
					const out = await profileStub(env, r).readV2(r, { kind: "changes", after: cur[r.profile] ?? 0, limit: 50 });
					if (!out.ok) throw new Error(`changes ${r.profile}: ${out.error.code}`);
					const v = out.value as { items: FeedItem[]; seq: number };
					items.push(...v.items);
					next[r.profile] = v.seq;
				}
				return { items, cursor: next };
			},
			health: async () => {
				const h = await account.admin({ op: "accountHealth" });
				if (!h.ok) throw new Error(`health: ${h.error.code}`);
				return (h.value as AccountHealth).checks;
			},
		}, cursor, exp, request.signal);
	}
	// #9 eval runs, candidates and recall strength.
	if (path === "/api/eval/runs" && method === "GET") {
		const q = z.object({ profile: profileName.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict().safeParse(params);
		if (!q.success) return invalid("profile, limit 1 to 500");
		const r = await account.admin({ op: "listEvalRuns", ...(q.data.profile ? { profile: q.data.profile } : {}), limit: q.data.limit ?? 100 });
		return r.ok ? json({ runs: r.value }) : reply(r);
	}
	const cand = /^eval-candidates(?:\/([^/]+))?$/.exec(sub);
	if (p && cand) {
		if (!ref) return notActive();
		if (cand[1] && method === "POST") {
			const b = z.object({ action: z.enum(["accept", "dismiss"]) }).strict().safeParse(await request.json().catch(() => null));
			if (!b.success) return invalid("send JSON with action accept or dismiss");
			return reply(await profileStub(env, ref).decideEvalCandidate(ref, decodeURIComponent(cand[1]), b.data.action === "accept" ? "accepted" : "dismissed"));
		}
		if (cand[1] || method !== "GET") return null;
		const q = z.object({ status: z.enum(["pending", "accepted", "dismissed", "all"]).optional(), cursor: z.string().min(1).max(2048).optional(),
			limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(params);
		return q.success ? reply(await profileStub(env, ref).readV2(ref, { kind: "eval_candidates", q: q.data })) : invalid("status, cursor, limit 1 to 100");
	}
	// #12 sessions: one profile's list and detail, and the list merged across every active profile by last upload.
	const sessionQuery = z.object({ cursor: z.string().min(1).max(4096).optional(), project: z.string().min(1).max(256).optional(), client: z.enum(["claude-code", "codex"]).optional(),
		status: z.enum(["active", "completed"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
	const sess = /^sessions(?:\/([^/]+))?$/.exec(sub);
	if (p && sess && method === "GET") {
		if (!ref) return notActive();
		if (sess[1]) return reply(await profileStub(env, ref).readV2(ref, { kind: "session", id: decodeURIComponent(sess[1]) }));
		const q = sessionQuery.safeParse(params);
		return q.success ? reply(await profileStub(env, ref).readV2(ref, { kind: "sessions", q: q.data })) : invalid("cursor, project, client, status (active or completed), limit 1 to 100");
	}
	if (path === "/api/sessions" && method === "GET") {
		const q = sessionQuery.safeParse(params);
		if (!q.success) return invalid("cursor, project, client, status (active or completed), limit 1 to 100");
		const { cursor, ...rest } = q.data;
		const cursors = cursor ? parseSessionsCursor(cursor) : {};
		if (!cursors) return invalid("cursor is not valid");
		const pages: { profile: string; page: Page<SessionRow> }[] = [];
		for (const r of ctx.profiles) {
			const own = cursors[r.profile];
			const out = await profileStub(env, r).readV2(r, { kind: "sessions", q: { ...rest, ...(own ? { cursor: own } : {}) } });
			// One profile that cannot be read fails the merged list; it is never silently left out.
			if (!out.ok) return reply(out);
			pages.push({ profile: r.profile, page: out.value as Page<SessionRow> });
		}
		return json(mergeSessions(pages, rest.limit ?? 50));
	}
	// #10 owner queue: link maintenance for 1 to 40 memories, and consolidation for one session.
	if (p && method === "POST" && (sub === "maintenance/queue" || /^sessions\/[^/]+\/consolidate$/.test(sub))) {
		if (!ref) return notActive();
		if (sub !== "maintenance/queue") return reply(await profileStub(env, ref).queueOwner(ref, { kind: "unprocessed_capture", session: decodeURIComponent(sub.split("/")[1]!) }));
		const b = z.object({ kind: z.literal("unlinked"), ids: z.array(z.string().min(1).max(128)).min(1).max(40) }).strict().safeParse(await request.json().catch(() => null));
		return b.success ? reply(await profileStub(env, ref).queueOwner(ref, b.data)) : invalid("send JSON with kind unlinked and 1 to 40 ids");
	}
	// #15 insights. File paths live only in the corpus, read here when it is on (me has none). A corpus read that fails fails the
	// request, so an unreadable corpus is never shown as "no files"; with the corpus off the lists stay empty, as the types say.
	const files = async (r: ProfileRef, sql: string | null): Promise<Outcome<{ path: string; count: number }[]>> => {
		if (!sql || !corpusOn(env) || r.profile === "me") return { ok: true, value: [] };
		const q = await corpusStub(env, r).query(r, { action: "sql", sql });
		return q.ok ? { ok: true, value: corpusFiles(q.value) } : q;
	};
	if (p && method === "GET" && sub === "activity-summary") {
		if (!ref) return notActive();
		const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
		const q = z.object({ from: day, to: day }).strict().safeParse(params);
		if (!q.success) return invalid("from and to as YYYY-MM-DD");
		const r = await profileStub(env, ref).readV2(ref, { kind: "activity_summary", q: q.data });
		if (!r.ok) return reply(r);
		// The summary's own from: the first day it counted in full, which is later than asked when its read budget ran out.
		// When the budget dropped every requested day, from is after to: no day was counted in full, so no file list is read.
		const s = r.value as ActivitySummary, f = s.from > s.to ? { ok: true as const, value: [] } : await files(ref, corpusFilesSql({ from: s.from, to: s.to }));
		return f.ok ? json({ ...s, top_files: f.value }) : reply(f);
	}
	if (p && method === "GET" && sub === "projects") {
		if (!ref) return notActive();
		const r = await profileStub(env, ref).readV2(ref, { kind: "projects" });
		return r.ok ? json({ projects: r.value }) : reply(r);
	}
	const proj = /^projects\/([^/]+)\/profile$/.exec(sub);
	if (p && method === "GET" && proj) {
		if (!ref) return notActive();
		const r = await profileStub(env, ref).readV2(ref, { kind: "project_profile", key: decodeURIComponent(proj[1]!) });
		if (!r.ok) return reply(r);
		const pp = r.value as ProjectProfile, f = await files(ref, corpusFilesSql({ project: pp.key, now: new Date().toISOString() }));
		return f.ok ? json({ ...pp, files: f.value }) : reply(f);
	}
	// Repo facts (contract section 7): list with lanes and evidence, the owner's flag (terminal, undoable through its activity) and
	// per repo per day efficiency rows. Retire, pin, unpin and forget stay the existing memory actions.
	if (p && sub === "facts" && method === "GET") {
		if (!ref) return notActive();
		const q = z.object({ repo_key: z.string().regex(REPO_KEY).optional(), tier: z.enum(["repo", "user", "all"]).optional(), state: z.enum(["candidate", "active", "retired", "dormant", "all"]).optional(),
			device: z.string().min(1).max(128).optional(), after: z.string().min(1).max(300).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict().safeParse(params);
		if (!q.success) return invalid("repo_key github.com/<owner>/<repo>, tier, state, device, after, limit 1 to 200");
		const { after, limit, ...rest } = q.data;
		return reply(await profileStub(env, ref).readV2(ref, { kind: "facts", ...rest, after: after ?? null, limit: limit ?? 100 }));
	}
	// #130 goal metrics: per repo and per week, read-only.
	if (p && sub === "goal-metrics" && method === "GET") {
		if (!ref) return notActive();
		const q = z.object({ weeks: z.coerce.number().int().min(1).max(26).optional(), repo_key: z.string().regex(REPO_KEY).optional() }).strict().safeParse(params);
		if (!q.success) return invalid("weeks 1 to 26, repo_key github.com/<owner>/<repo>");
		return reply(await profileStub(env, ref).readV2(ref, { kind: "goal_metrics", now: new Date().toISOString(), ...q.data }));
	}
	if (p && sub === "facts/flag" && method === "POST") {
		if (!ref) return notActive();
		const b = flagSchema.safeParse(await request.json().catch(() => null));
		if (!b.success) return invalid(`send JSON with memory_id (or fact_key and repo_key), scope and a reason: ${issues(b.error)}`);
		const args: FactFlagArgs = { ...b.data, request_id: b.data.request_id ?? `fact-flag:${crypto.randomUUID()}` };
		const r = await profileStub(env, ref).write(ref, { op: "fact_flag", args }, { actor: "owner", platform: "dashboard", routedBy: "explicit", userId: ctx.caller.userId,
			payloadHash: requestHash("fact_flag", args as unknown as Record<string, unknown>) });
		return reply(r);
	}
	if (p && sub === "facts/efficiency" && method === "GET") {
		if (!ref) return notActive();
		const day = z.string().regex(/^\d{4}-\d\d-\d\d$/);
		const q = z.object({ repo_key: z.string().regex(REPO_KEY).optional(), from: day, to: day }).strict().safeParse(params);
		if (!q.success || q.data.from > q.data.to || Date.parse(q.data.to) - Date.parse(q.data.from) > 92 * 86_400_000) return invalid("repo_key, from and to (YYYY-MM-DD, at most 92 days apart)");
		return reply(await profileStub(env, ref).readV2(ref, { kind: "fact_efficiency", ...q.data }));
	}
	if (p && sub === "recall-strength" && method === "GET") {
		if (!ref) return notActive();
		const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
		if (!ids.length || ids.length > 100 || ids.some((i) => i.length > 128)) return invalid("ids: 1 to 100 comma-separated ids");
		const r = await profileStub(env, ref).readV2(ref, { kind: "recall_strength", ids, day: today() });
		return r.ok ? json({ strength: r.value }) : reply(r);
	}
	return null;
}
