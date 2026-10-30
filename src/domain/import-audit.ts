// The import audit's row digests (docs/import-integrity-design.md), shared by the server (profile/import.ts) and the
// local auditor (local/upload.mjs), so both sides hash the same fields the same way. Field names follow the
// expected-integrity fixture. Stored strings are hashed as their exact UTF-8 bytes: never parsed or reserialized.
import { createHash } from "node:crypto";

// Dependency-free, like import-cost.ts, so Node loads this file directly; the same canonical JSON and hash as ids.ts.
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
	: v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
const canonicalJson = (v: unknown) => JSON.stringify(sortKeys(v));

export type RevisionRow = { revision: number; op: string; snapshot: string; delta: string | null; request_id: string | null; at: string; content_hash: string | null;
	revision_id: string | null; source_platform: string | null; source_platform_version: string | null };
export type RequestRow = { request_id: string; legacy_op: string; legacy_hash: string; result: string; at: string; completed_at: string | null; source: string | null };

export const revisionDigest = (r: RevisionRow) => ({
	revision: r.revision, op: r.op, snapshot_raw_utf8_sha256: sha256(r.snapshot), delta_raw_utf8_sha256: r.delta === null ? null : sha256(r.delta), request_id: r.request_id,
	at: r.at, content_hash: r.content_hash, revision_id: r.revision_id, source_platform: r.source_platform, source_platform_version: r.source_platform_version,
});

/** What the import stores in requests.source for one BothQ request: canonical `{extra?, memory_id}`. */
export const requestSource = (q: { memory_id: string | null; extra?: Record<string, unknown> }) => canonicalJson({ ...(q.extra ? { extra: q.extra } : {}), memory_id: q.memory_id });

/** `source` as stored (requestSource); its memory_id is read back and its bytes hashed as they are. */
export const requestDigest = (q: RequestRow) => ({
	request_id: q.request_id, legacy_op: q.legacy_op, legacy_hash: q.legacy_hash, result_raw_utf8_sha256: sha256(q.result), result_raw_utf8_bytes: Buffer.byteLength(q.result, "utf8"),
	memory_id: q.source === null ? null : (JSON.parse(q.source) as { memory_id?: string | null }).memory_id ?? null, at: q.at, completed_at: q.completed_at,
	source_canonical_sha256: q.source === null ? null : sha256(q.source),
});

/** One digest over a record's rows: revisions in revision order, requests in request_id order (JavaScript string order). */
export function rowsDigest(rows: (ReturnType<typeof revisionDigest> | ReturnType<typeof requestDigest>)[]): string {
	const key = (x: (typeof rows)[number]) => "revision" in x ? x.revision : x.request_id;
	return sha256(canonicalJson([...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
}

/** The columns of a nodes row that hold an imported node, as publish writes them. */
export const NODE_COLUMNS = "id, kind, memory_type, scope, name, description, why, how_to_apply, objective, steps, status, origin, revision, chars, content_hash, valid_from, valid_to, created_at, updated_at, source_platform, updated_source_platform, attrs";

/** The import node a stored nodes row holds now, with steps and attrs read back from their stored JSON. */
export function storedNode(row: Record<string, unknown>): Record<string, unknown> {
	const { steps, attrs, ...rest } = row;
	return { ...rest, steps: steps === null ? null : JSON.parse(steps as string), attrs: JSON.parse(attrs as string) };
}
export const nodeDigest = (node: unknown) => sha256(canonicalJson(node));

/** The digests of a node's stored attrs and of its source provenance. */
export function attrsDigest(attrs: Record<string, unknown>) {
	const source = attrs.source as { system?: unknown } | undefined;
	return { attrs_sha256: sha256(canonicalJson(attrs)), source_sha256: sha256(canonicalJson(source ?? null)), source_system: typeof source?.system === "string" ? source.system : null };
}


/** Separate additions; legacy revision/request/node digest meanings stay unchanged. */
export const identityDigest = (scope:string, memory_type:string, norm_name:string) => sha256(canonicalJson({scope,memory_type,norm_name}));
export type TextRow = {part:string;revision:number;seq_no:number;chunk:number;body:string;separator?:string|null;request_id?:string|null;created_at:string;live:boolean|number};
export const textKey = (t:Pick<TextRow,"part"|"revision"|"seq_no"|"chunk">) => [t.part,t.revision,t.seq_no,t.chunk] as const;
export const textDigest = (t:TextRow) => ({part:t.part,revision:t.revision,seq_no:t.seq_no,chunk:t.chunk,body_raw_utf8_sha256:sha256(t.body),body_raw_utf8_bytes:Buffer.byteLength(t.body,"utf8"),
	separator_raw_utf8_sha256:t.separator == null ? null : sha256(t.separator),request_id:t.request_id ?? null,created_at:t.created_at,live:Boolean(t.live)});
export function textRowsDigest(rows:ReturnType<typeof textDigest>[]):string {
	return sha256(canonicalJson([...rows].sort((a,b)=>{const x=textKey(a),y=textKey(b);for(let i=0;i<x.length;i++){if(x[i]!<y[i]!)return -1;if(x[i]!>y[i]!)return 1;}return 0;})));
}
