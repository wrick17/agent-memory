// Closed import projections. These witnesses are authenticated import assertions, not signatures or executable instructions.
import { z } from "zod";
import { createHash } from "node:crypto";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const importDecision = z.object({ reference: z.string().min(1).max(512), answer: z.string().min(1).max(1024),
	kind: z.enum(["source_suffix", "archival_reference"]), permitted_ids: z.array(z.string().uuid()).min(1).max(32) }).strict();
export const importPolicy = z.object({ version: z.literal(1), kind: z.enum(["source_suffix", "archival_reference"]),
	owner_decision: importDecision, owner_decision_sha256: hash,
	witness: z.object({ export_manifest_sha256: hash, source_key_sha256: hash, source_row_sha256: hash,
		profile: z.enum(["work", "personal"]), scope: z.string().min(1).max(128) }).strict(),
	source_head: z.object({ name: z.string().min(1).max(512), content_hash: hash, revision: z.number().int().min(1) }).strict(),
	profile_review_sha256: hash.optional(),
}).strict().superRefine((p, ctx) => {
	if (p.owner_decision.kind !== p.kind || new Set(p.owner_decision.permitted_ids).size !== p.owner_decision.permitted_ids.length
		|| (p.kind === "archival_reference") !== (p.profile_review_sha256 !== undefined)) ctx.addIssue({ code: "custom", message: "policy decision or individual profile receipt differs" });
});
export type ImportPolicy = z.infer<typeof importPolicy>;

/** Only parse authoritative, untruncated current attrs. Invalid reserved metadata fails closed before returning text. */
export function policyOf(attrs: string | Record<string, unknown> | null | undefined): ImportPolicy | null {
	const a = typeof attrs === "string" ? JSON.parse(attrs) as Record<string, unknown> : attrs;
	const source = a?.source as {system?:unknown;category?:unknown;realpath?:unknown} | undefined;
	if (!a || !Object.hasOwn(a,"import_review")) {
		if (source?.category === "codex_reference_candidate") throw new Error("archival reference delivery policy is missing");
		return null;
	}
	const p = importPolicy.parse(a.import_review), d = p.owner_decision;
	const digest = (text:string) => createHash("sha256").update(text,"utf8").digest("hex");
	// The strict decision schema is flat; this is its canonical sorted-key representation on Node and workerd.
	if (digest(JSON.stringify({answer:d.answer,kind:d.kind,permitted_ids:d.permitted_ids,reference:d.reference})) !== p.owner_decision_sha256
		|| !source || typeof source.realpath !== "string" || digest(`${source.system}:${source.realpath}`) !== p.witness.source_key_sha256
		|| (p.kind === "archival_reference" ? source.system !== "codex" || source.category !== "codex_reference_candidate" : source.system !== "claude" || source.category !== "claude_index")) throw new Error("invalid source-policy delivery witness");
	return p;
}

/** Owner decision for legacy migration identities: Work only, bound to one export, its roster digest and this record's exact source row. */
export const ownerClassification = z.object({ version: z.literal(1), effect: z.literal("legacy_work_owner"), profile: z.literal("work"),
	owner_decision: z.object({ reference: z.string().min(1).max(512), answer: z.string().min(1).max(1024), roster_sha256: hash }).strict(), owner_decision_sha256: hash,
	witness: z.object({ export_manifest_sha256: hash, source_key_sha256: hash, source_row_sha256: hash, id: z.string().min(1).max(128), scope: z.string().min(1).max(128),
		memory_type: z.string().min(1).max(64) }).strict(),
}).strict();
export type OwnerClassification = z.infer<typeof ownerClassification>;

/** The reserved attrs.source.owner_classification witness, or null. Invalid reserved metadata fails closed. */
export function classificationOf(attrs: string | Record<string, unknown> | null | undefined): OwnerClassification | null {
	const a = typeof attrs === "string" ? JSON.parse(attrs) as Record<string, unknown> : attrs;
	const source = a?.source as {system?:unknown;element_id?:unknown;realpath?:unknown;owner_classification?:unknown} | undefined;
	if (!source || typeof source !== "object" || !Object.hasOwn(source,"owner_classification")) return null;
	const k = ownerClassification.parse(source.owner_classification), d = k.owner_decision;
	const digest = (text:string) => createHash("sha256").update(text,"utf8").digest("hex");
	const key = source.system === "bothq" ? source.element_id : source.realpath;
	if (digest(JSON.stringify({answer:d.answer,reference:d.reference,roster_sha256:d.roster_sha256})) !== k.owner_decision_sha256 || typeof key !== "string"
		|| digest(source.system === "bothq" ? `bothq:${key}` : `${source.system}:${key}`) !== k.witness.source_key_sha256) throw new Error("invalid owner classification witness");
	return k;
}
/** The stable owner choice; export, row and roster evidence may be fresh on refresh without changing it. */
export const ownerSemantic = (k: OwnerClassification | null) => k && JSON.stringify([k.effect, k.profile, k.owner_decision.reference, k.owner_decision.answer,
	k.witness.source_key_sha256, k.witness.id, k.witness.scope, k.witness.memory_type]);

export type ImportDelivery = {import_source?: {name:string;content_hash:string;revision:number};classification?:"archival_reference";trust?:"untrusted";instruction_authority?:false};

export function importDelivery(attrs: string | Record<string, unknown> | null | undefined): ImportDelivery {
	const p = policyOf(attrs);
	return p ? { import_source: { ...p.source_head }, ...(p.kind === "archival_reference"
		? { classification: "archival_reference" as const, trust: "untrusted" as const, instruction_authority: false as const } : {}) } : {};
}

export const ARCHIVE_CURRENT_FIELDS = ["classification", "trust", "instruction_authority", "import_source"];


/** Project only the required current policy and its physical-source qualifier, never a truncated attrs prefix. */
export const POLICY_ATTRS_SQL = `json_patch(json_object('source',json_object('system',json_extract(attrs,'$.source.system'),
	'category',json_extract(attrs,'$.source.category'),'realpath',json_extract(attrs,'$.source.realpath'))),
	CASE WHEN json_type(attrs,'$.import_review') IS NULL THEN '{}' ELSE json_object('import_review',json_extract(attrs,'$.import_review')) END)`;
export function currentImportFields(attrs:string|Record<string,unknown>|null|undefined):string[] {
	const p=policyOf(attrs);return p ? p.kind === "archival_reference" ? ARCHIVE_CURRENT_FIELDS : ["import_source"] : [];
}
