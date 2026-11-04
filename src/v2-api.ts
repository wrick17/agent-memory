// v2 routes (X0 spine wiring): /v1/recall, /v1/status, /v1/eval/runs, the device /v1/whoami reply, and the owner sessions,
// viewer, insights, eval and health routes. Each calls the wave-1 module that owns its logic; this file only authenticates,
// validates input and routes. /api/* stays owner-only: api.ts calls ownerV2 after its owner check.
import { z } from "zod";
import type { AccountContext, AccountHealth, AccountStore, Principal } from "./account/store";
import { authenticate } from "./auth";
import { PROFILE_NAME, type Outcome, type ProfileRef } from "./domain/types";
import { accountStub, profileStub, recall, recallRequestSchema } from "./mcp";
import type { V2Read } from "./profile/store";
import { mayUse } from "./routing";
import { parseEvalRun } from "./eval";
import { parseClientStatus, STATUS_MAX_BYTES } from "./client-status";
import { healthReport } from "./health";
import { mergeSessions, parseSessionsCursor } from "./sessions";
import { assembleSnapshot } from "./viewer/snapshot";
import { eventStream, parseCursor, STREAM_MAX_MS } from "./viewer/events";
import type { FeedItem, LeaseFacts, Page, ProfileSnapshotPart, SessionRow, ViewerCursor } from "./viewer/types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, unavailable: 503, busy: 409, revision_conflict: 409 };
const reply = (r: Outcome<unknown>) => (r.ok ? json(r.value) : json({ error: r.error }, STATUS[r.error.code] ?? 400));
const invalid = (message: string) => json({ error: { code: "validation", message } }, 400);
type Waiter = (p: Promise<unknown>) => void;

/** A device-token caller (or an OAuth owner on the resource audience), with its account context. */
async function deviceCaller(request: Request, env: Env): Promise<Response | AccountContext> {
	const auth = await authenticate(request, env, "resource", true);
	if (!auth.ok) return json({ error: { code: "unauthorized", message: auth.description ?? auth.error } }, auth.status);
	const ctx = await accountStub(env, env.OWNER_USER_ID!).context(auth.principal as Principal);
	return ctx.ok ? ctx.value : json({ error: ctx.error }, ctx.error.code === "unavailable" ? 503 : 401);
}
/** The job token: a device holding ingest and maintenance; the device id comes from the token, never the body. */
const isJob = (c: AccountContext) => c.caller.kind === "device" && !!c.caller.deviceId && c.caller.scopes.includes("ingest") && c.caller.scopes.includes("maintenance");

async function boundedJson(request: Request, max: number): Promise<Response | unknown> {
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return invalid("send application/json");
	const text = await request.text();
	if (new TextEncoder().encode(text).length > max) return json({ error: { code: "validation", message: `body over ${max} bytes` } }, 413);
	try { return JSON.parse(text) as unknown; } catch { return invalid("body is not JSON"); }
}

/**
 * The device routes. Returns null for any other path. /v1/whoami answers here only for an am_ device token, so the owner's
 * existing reply stays in api.ts unchanged; revoked or disabled devices fail in context().
 */
export async function deviceV2(request: Request, env: Env, url: URL, waitUntil: Waiter | undefined): Promise<Response | null> {
	const path = url.pathname, method = request.method;
	if (path === "/v1/whoami" && method === "GET") {
		if (!/^Bearer\s+am_/i.test(request.headers.get("authorization") ?? "")) return null;
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		return json({ kind: "device", device_id: c.caller.deviceId, scopes: c.caller.scopes, profiles: c.caller.profiles === "*" ? c.known : c.caller.profiles });
	}
	if (path === "/v1/recall" && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		// A job token holds no read scope: recall() refuses it with forbidden (403).
		if (!c.caller.scopes.includes("read")) return json({ error: { code: "forbidden", message: "this token cannot read" } }, 403);
		const body = await boundedJson(request, 64_000);
		if (body instanceof Response) return body;
		const p = recallRequestSchema.safeParse(body);
		if (!p.success) return invalid(p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
		const { channels, count_hits, ...a } = p.data;
		return reply(await recall({ env, caller: c.caller, account: c, platform: `${c.caller.kind}:${c.caller.deviceName ?? "unknown"}`, ...(waitUntil ? { waitUntil } : {}) },
			a, { ...(channels ? { channels } : {}), ...(count_hits !== undefined ? { count_hits } : {}) }));
	}
	if (path === "/v1/eval/candidates" && method === "GET") {
		// eval export-candidates: the read token, for an explicit profile it may use. A job token holds no read scope.
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!c.caller.scopes.includes("read")) return json({ error: { code: "forbidden", message: "this token cannot read" } }, 403);
		const q = z.object({ profile: profileName, cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict()
			.safeParse(Object.fromEntries(url.searchParams));
		if (!q.success) return invalid("profile is required; cursor; limit 1 to 100");
		const ref = c.profiles.find((x) => x.profile === q.data.profile);
		if (!ref || !mayUse(c.caller, ref.profile)) return json({ error: { code: "forbidden", message: `this token cannot use profile '${q.data.profile}'` } }, 403);
		return reply(await profileStub(env, ref).readV2(ref, { kind: "accepted_candidates", cursor: q.data.cursor ?? null, limit: q.data.limit ?? 100 }));
	}
	if ((path === "/v1/status" || path === "/v1/eval/runs") && method === "POST") {
		const c = await deviceCaller(request, env);
		if (c instanceof Response) return c;
		if (!isJob(c)) return json({ error: { code: "forbidden", message: "send this with the job token" } }, 403);
		const body = await boundedJson(request, path === "/v1/status" ? STATUS_MAX_BYTES : 8_000);
		if (body instanceof Response) return body;
		const account = accountStub(env, env.OWNER_USER_ID!);
		const deviceId = c.caller.deviceId!;
		if (path === "/v1/status") {
			const s = parseClientStatus(body, deviceId);
			if (!s.ok) return reply(s);
			const r = await account.admin({ op: "reportStatus", deviceId, body: s.value });
			return r.ok ? json({ reported_at: new Date().toISOString() }) : reply(r);
		}
		const run = parseEvalRun(body);
		if (!run.ok) return reply(run);
		// The profile is the caller's explicit choice; the device must be allowed it. Nothing is inferred.
		if (!c.known.includes(run.value.profile) || !mayUse(c.caller, run.value.profile)) return json({ error: { code: "forbidden", message: `this token cannot use profile '${run.value.profile}'` } }, 403);
		return reply(await account.admin({ op: "recordEvalRun", deviceId, run: run.value }));
	}
	return null;
}

const profileName = z.string().regex(PROFILE_NAME);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sessionQuery = z.object({ cursor: z.string().min(1).max(2048).optional(), project: z.string().min(1).max(256).optional(), client: z.enum(["claude-code", "codex"]).optional(),
	status: z.enum(["active", "completed"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();

/** The owner v2 routes; api.ts calls this only after its owner check. Returns null for any other path. */
export async function ownerV2(request: Request, env: Env, url: URL, ctx: AccountContext, account: Pick<AccountStore, "admin">,
	claims: Record<string, unknown> | undefined): Promise<Response | null> {
	const path = url.pathname, method = request.method, params = Object.fromEntries(url.searchParams);
	const read = (ref: ProfileRef, q: V2Read) => profileStub(env, ref).readV2(ref, q);
	const all = <T>(q: V2Read) => Promise.all(ctx.profiles.map(async (ref) => ({ profile: ref.profile, r: await read(ref, q) as Outcome<T> })));
	const today = () => new Date().toISOString().slice(0, 10);
	const accountHealth = async () => { const r = await account.admin({ op: "accountHealth" }); if (!r.ok) throw new Error(r.error.message); return r.value as AccountHealth; };

	const o = /^\/api\/profiles\/([^/]+)\/(recall-strength|maintenance\/queue|sessions\/([^/]+)\/consolidate)$/.exec(path);
	if (o) {
		const ref = profileName.safeParse(o[1]).success ? ctx.profiles.find((x) => x.profile === o[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${o[1]}' is not active` } }, 404);
		if (o[2] === "recall-strength") {
			if (method !== "GET") return null;
			const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
			if (!ids.length || ids.length > 100 || ids.some((i) => i.length > 128)) return invalid("ids: 1 to 100 comma-separated ids");
			const r = await read(ref, { kind: "recall_strength", ids, day: today() });
			return r.ok ? json({ strength: r.value }) : reply(r);
		}
		if (method !== "POST") return null;
		if (o[3]) return reply(await profileStub(env, ref).queueOwner(ref, { kind: "unprocessed_capture", session: decodeURIComponent(o[3]) }));
		const b = z.object({ kind: z.literal("unlinked"), ids: z.array(z.string().min(1).max(128)).min(1).max(40) }).strict().safeParse(await request.json().catch(() => null));
		return b.success ? reply(await profileStub(env, ref).queueOwner(ref, b.data)) : invalid("send JSON with kind unlinked and 1 to 40 ids");
	}
	const p = /^\/api\/profiles\/([^/]+)\/(sessions(?:\/([^/]+))?|eval-candidates(?:\/([^/]+))?|activity-summary|projects(?:\/([^/]+)\/profile)?)$/.exec(path);
	if (p) {
		const ref = profileName.safeParse(p[1]).success ? ctx.profiles.find((x) => x.profile === p[1]) : undefined;
		if (!ref) return json({ error: { code: "not_found", message: `profile '${p[1]}' is not active` } }, 404);
		const [, , what, sessionId, candidateId, projectKey] = p;
		if (what!.startsWith("sessions") && method === "GET") {
			if (sessionId) return reply(await read(ref, { kind: "session", id: decodeURIComponent(sessionId) }));
			const q = sessionQuery.safeParse(params);
			return q.success ? reply(await read(ref, { kind: "sessions", q: q.data })) : invalid("cursor, project, client, status (active or completed), limit 1 to 100");
		}
		if (what!.startsWith("eval-candidates")) {
			if (candidateId && method === "POST") {
				const b = z.object({ action: z.enum(["accept", "dismiss"]) }).strict().safeParse(await request.json().catch(() => null));
				if (!b.success) return invalid("send JSON with action accept or dismiss");
				return reply(await profileStub(env, ref).decideEvalCandidate(ref, decodeURIComponent(candidateId), b.data.action === "accept" ? "accepted" : "dismissed"));
			}
			if (!candidateId && method === "GET") {
				const q = z.object({ status: z.enum(["pending", "accepted", "dismissed", "all"]).optional(), cursor: z.string().min(1).max(2048).optional(),
					limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(params);
				return q.success ? reply(await read(ref, { kind: "eval_candidates", q: q.data })) : invalid("status, cursor, limit 1 to 100");
			}
			return null;
		}
		if (method !== "GET") return null;
		if (what === "activity-summary") {
			const q = z.object({ from: day, to: day }).strict().refine((v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 366 * 86_400_000).safeParse(params);
			return q.success ? reply(await read(ref, { kind: "activity_summary", q: q.data })) : invalid("from and to as YYYY-MM-DD, at most one year apart");
		}
		if (projectKey) return reply(await read(ref, { kind: "project_profile", key: decodeURIComponent(projectKey) }));
		const r = await read(ref, { kind: "projects" });
		return r.ok ? json({ projects: r.value }) : reply(r);
	}
	if (path === "/api/sessions" && method === "GET") {
		const q = sessionQuery.safeParse(params);
		if (!q.success) return invalid("cursor, project, client, status (active or completed), limit 1 to 100");
		const cursors = q.data.cursor ? parseSessionsCursor(q.data.cursor) : {};
		if (!cursors) return invalid("cursor is not valid");
		const { cursor: _c, ...rest } = q.data;
		const pages = await Promise.all(ctx.profiles.map(async (ref) => {
			const own = cursors[ref.profile];
			const r = await read(ref, { kind: "sessions", q: { ...rest, ...(own ? { cursor: own } : {}) } });
			if (!r.ok) throw new Error(r.error.message);
			return { profile: ref.profile, page: r.value as Page<SessionRow> };
		}));
		return json(mergeSessions(pages, q.data.limit ?? 50));
	}
	if (path === "/api/eval/runs" && method === "GET") {
		const q = z.object({ profile: profileName.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict().safeParse(params);
		if (!q.success) return invalid("profile, limit 1 to 500");
		const r = await account.admin({ op: "listEvalRuns", ...(q.data.profile ? { profile: q.data.profile } : {}), limit: q.data.limit ?? 100 });
		return r.ok ? json({ runs: r.value }) : reply(r);
	}
	if (path === "/api/health/sweep" && method === "POST") {
		const r = await account.admin({ op: "health_sweep" });
		return r.ok ? json({ checks: r.value }) : reply(r);
	}
	if (path === "/api/health" && method === "GET") {
		const [a, leases, parts] = await Promise.all([accountHealth(), all<LeaseFacts>({ kind: "lease_facts" }), all<ProfileSnapshotPart>({ kind: "viewer_part", day: today() })]);
		return json(healthReport(a, leases.flatMap((l) => (l.r.ok ? [{ profile: l.profile, facts: l.r.value }] : [])), parts.flatMap((x) => (x.r.ok ? [x.r.value] : [])), env.EMBEDDINGS === "on"));
	}
	if (path === "/api/viewer/snapshot" && method === "GET") {
		const [a, parts] = await Promise.all([accountHealth(), all<ProfileSnapshotPart>({ kind: "viewer_part", day: today() })]);
		const failed = parts.find((x) => !x.r.ok);
		if (failed && !failed.r.ok) return reply(failed.r);
		const bodies = a.devices.map((d) => d.body);
		const meta = env.CF_VERSION_METADATA;
		return json(assembleSnapshot(parts.map((x) => (x.r as { ok: true; value: ProfileSnapshotPart }).value),
			{ checks: a.checks, devices_reporting: bodies.length, inject_devices: bodies.filter((b) => b.inject).length, scheduled_devices: bodies.filter((b) => b.launchd_loaded).length },
			{ version: meta?.id ?? "unknown", deployed_at: meta?.timestamp ?? "", at: new Date().toISOString(), embeddings: env.EMBEDDINGS === "on", corpus: env.CORPUS === "on" }));
	}
	if (path === "/api/viewer/events" && method === "GET") {
		const cursor: ViewerCursor | null = url.searchParams.get("cursor") ? parseCursor(url.searchParams.get("cursor")!) : {};
		if (!cursor) return invalid("cursor is not valid");
		const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : Date.now() + STREAM_MAX_MS;
		return eventStream({
			changes: async (cur) => {
				const items: FeedItem[] = [], next: ViewerCursor = { ...cur };
				for (const ref of ctx.profiles) {
					const r = await read(ref, { kind: "changes", after: cur[ref.profile] ?? 0, limit: 50 });
					if (!r.ok) continue;
					const v = r.value as { items: FeedItem[]; seq: number };
					items.push(...v.items);
					next[ref.profile] = v.seq;
				}
				return { items, cursor: next };
			},
			health: async () => (await accountHealth()).checks,
		}, cursor, Math.min(exp, Date.now() + STREAM_MAX_MS), request.signal);
	}
	return null;
}
