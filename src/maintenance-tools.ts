// MCP job tools (section 7): maintenance_next and maintenance_complete, for job tokens only. The Worker checks the token kind,
// scope and profile; the profile leases items, keeps each op inside its item's subjects and writes as actor maintenance.
import { z } from "zod";
import { EVIDENCE_KINDS, fail, ok, PROFILE_NAME, RELATIONS, type Outcome, type ProfileRef, type Scope } from "./domain/types";
import type { ToolContext } from "./mcp";
import type { OpOutcome } from "./profile/store";
import { mayUse } from "./routing";
import { driveTransfer, transferPorts } from "./transfer";

const profile = z.string().regex(PROFILE_NAME);
const id = z.string().min(1).max(128);
const reason = z.string().min(8).max(600);
const evidence = z.object({ kind: z.enum(EVIDENCE_KINDS), ref: z.string().min(1).max(512), note: z.string().max(512).optional() }).strict();
const op = z.discriminatedUnion("op", [
	z.object({ op: z.literal("save"), memory_id: id, description: z.string().max(10_000).optional(), content: z.string().max(64_000).optional(),
		why: z.string().max(10_000).optional(), how_to_apply: z.string().max(10_000).optional(), new_name: z.string().min(1).max(512).optional(),
		retire: z.boolean().optional(), expected_revision: z.number().int().min(1).optional() }).strict(),
	z.object({ op: z.literal("compact"), memory_id: id, through_seq: z.number().int().positive(), summary: z.string().min(1).max(64_000), expected_revision: z.number().int().positive() }).strict(),
	z.object({ op: z.literal("link"), from: id, to: id, rel: z.enum(RELATIONS), other_label: z.string().min(1).max(64).optional(), reason, evidence: z.array(evidence).min(1).max(10) }).strict(),
	z.object({ op: z.literal("end_link"), edge: z.number().int().positive(), reason, valid_to: z.iso.datetime().optional() }).strict(),
	z.object({ op: z.literal("supersede"), keep: id, retire: z.array(id).min(1).max(10) }).strict(),
	z.object({ op: z.literal("flag"), node: id, reason }).strict(),
	z.object({ op: z.literal("dismiss") }).strict(),
	z.object({ op: z.literal("infer_preference"), name: z.string().min(1).max(512), description: z.string().max(10_000), why: z.string().max(10_000).optional(),
		how_to_apply: z.string().max(10_000).optional(), scope: z.string().min(1).max(128).optional(),
		evidence: z.array(z.object({ kind: z.literal("node"), ref: id, note: z.string().max(512).optional() }).strict()).min(1).max(10) }).strict(),
	z.object({ op: z.literal("promote_to_me"), memory_id: id.optional(), from_op: z.number().int().min(0).max(9).optional(), company_free: z.literal(true) }).strict(),
	z.object({ op: z.literal("strategic_review"), summary: z.string().min(1).max(600), content: z.string().min(1).max(20_000),
		links: z.array(z.object({ to: id, reason, evidence: z.array(z.object({ kind: z.literal("node"), ref: id, note: z.string().max(512).optional() }).strict()).min(1).max(5) }).strict()).max(20) }).strict(),
]);
const nextSchema = z.object({ profile, kinds: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(8).optional(), limit: z.number().int().min(1).max(40).optional(),
	lease_seconds: z.number().int().min(30).max(900).optional() }).strict();
const code = z.string().regex(/^[a-z_]{1,64}$/);
const completeSchema = z.union([
	z.object({ profile, lease_id: z.uuid(), results: z.array(z.object({ item_id: z.number().int().positive(), ops: z.array(op).max(10) }).strict()).min(1).max(40) }).strict(),
	z.object({ profile, lease_id: z.uuid(), status: z.enum(["batch_skipped", "stuck"]), reason: code }).strict(),
	// An unproven runtime leases nothing: it reports only why it skipped, so the dashboard can show it.
	z.object({ profile, status: z.literal("batch_skipped"), reason: code }).strict(),
]);
type NextInput = z.infer<typeof nextSchema>;
type CompleteInput = z.infer<typeof completeSchema>;

/** wiring: replaced by profileStub once its Pick gains "maintenance". */
type MaintenanceStub = { maintenance(who: ProfileRef, cmd: unknown, job: { deviceId?: string; platform: string; userId: string; me?: string }): Promise<Outcome<unknown>> };

async function job(c: ToolContext, name: string, cmd: { op: "next" | "complete" } & Record<string, unknown>): Promise<Outcome<unknown>> {
	// A job token is a device token holding only ingest and maintenance (AccountStore refuses any other mix).
	const jobToken = c.caller.kind === "device" && c.caller.scopes.includes("maintenance") && c.caller.scopes.every((s) => s === "ingest" || s === "maintenance");
	if (!jobToken) return fail("forbidden", "maintenance tools take a job token");
	if (!mayUse(c.caller, name)) return fail("forbidden", `this caller may not use profile '${name}'`);
	const ref = c.account.profiles.find((p) => p.profile === name);
	if (!ref) return fail("validation", `profile '${name}' is not active`);
	const stub = c.env.PROFILE.get(c.env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as MaintenanceStub;
	// promote_to_me needs a job token for both the leased profile and an active me; a work-only token never writes me, and
	// the profile stores a promotion intent only with this me generation.
	const me = mayUse(c.caller, "me") ? c.account.profiles.find((p) => p.profile === "me") : undefined;
	const r = await stub.maintenance(ref, cmd, { ...(c.caller.deviceId ? { deviceId: c.caller.deviceId } : {}), platform: c.platform, userId: c.caller.userId, ...(me ? { me: me.generation } : {}) });
	// Promotion is offered only to a job that can reach me; without me the profile and promote() still refuse it.
	if (r.ok && cmd.op === "next" && !me) for (const i of (r.value as { items?: { allowed_ops: string[] }[] }).items ?? []) i.allowed_ops = i.allowed_ops.filter((o) => o !== "promote_to_me");
	return r.ok && "results" in cmd ?ok(await promote(c, ref, !!me, r.value as { results: { ops?: OpOutcome[] }[] })) : r;
}

/**
 * Drives each promotion the profile accepted (fresh or replayed) through the C3 transfer into me, under its deterministic id,
 * so a replay re-drives the same transfer and moves nothing twice. A commit is applied; a guard or other refusal aborts and
 * leaves the record writable where it was; a transport failure is `moving`, and the source's alarm settles the stored intent.
 * The account begins it only at the generations it was accepted for (this source, the outcome's me); the source fence refuses
 * a target the owner protected meanwhile.
 */
async function promote(c: ToolContext, from: ProfileRef, toMe: boolean, value: { results: { ops?: OpOutcome[] }[] }) {
	for (const o of value.results.flatMap((r) => r.ops ?? [])) {
		if (o.status !== "transfer_started") continue;
		if (!toMe) { Object.assign(o, { status: "rejected", code: "forbidden" }); continue; }
		try {
			const moved = await driveTransfer(transferPorts(c.env, c.caller.userId), { id: o.transfer_id!, nodeId: o.memory_id!, from: from.profile, to: "me", companyFree: o.company_free === true,
				expect: { from: from.generation, to: o.me! }, protect: true }, c.caller);
			Object.assign(o, !moved.ok ? (moved.error.code === "moving" ? { status: "moving" } : { status: "rejected", code: moved.error.code })
				: moved.value.state === "committed" ? { status: "applied" } : { status: "rejected", code: "transfer_aborted" });
		} catch {
			o.status = "moving";
		}
	}
	return value;
}

export const MAINTENANCE_TOOLS = [
	{ name: "maintenance_next", scope: "maintenance" as Scope, schema: nextSchema,
		run: (c: ToolContext, { profile: p, ...a }: NextInput) => job(c, p, { op: "next", ...a }),
		description: "Lease up to 40 open maintenance items of one profile for at most 900 seconds, at most once per profile in 20 hours. Each item has its kind, subject ids, their cards and passages, current edges and allowed_ops. An empty list carries next_allowed_at. Job tokens only." },
	{ name: "maintenance_complete", scope: "maintenance" as Scope, schema: completeSchema,
		run: (c: ToolContext, { profile: p, ...a }: CompleteInput) => job(c, p, { op: "complete", ...a }),
		description: "Apply a lease's results: per item, ops save, compact, link, end_link, supersede, flag or dismiss, each confined to the item's subjects and written as actor maintenance with undo, plus infer_preference (an inferred preference with 1 to 10 node evidence pointers to the item's subjects), promote_to_me (company_free: true; a preference subject, or from_op naming an earlier infer_preference of the same item) and, on a weekly_review item, strategic_review (summary, content and up to 20 relates_to links to the item's subjects, each with a reason and 1 to 5 node pointers to subjects; one review document per item, dated by the item's board as_of) where the item's allowed_ops list them. A change to a stated, pinned or me node becomes a flag. Returns applied, flagged, rejected or moving per op; a repeated call replays. Instead of results, a content-free status: batch_skipped releases the lease's unfinished items, stuck parks them, and batch_skipped without lease_id only records why the batch was skipped. Job tokens only." },
] as const;
