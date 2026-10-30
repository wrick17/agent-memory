// Alarm stage `embed` (section 12): cards whose card_hash differs from embed_hash, 16 per Workers AI call,
// upserted under generation-qualified ids into the generation's own namespace.
import { nextSeq } from "../storage";
import { cardText, readPrefix, type Who } from "./write";

export const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
/** One shared deadline for recall's semantic enrichment: query embedding plus Vectorize query (section 11, decision of 2026-10-28). */
export const SEMANTIC_MS = 3_000;
const BATCH = 16;

export const namespaceOf = (w: Who) => `${w.userId}:${w.profile}:g${w.generation}`;
export const vectorId = (w: Who, nodeId: string) => `g${w.generation}:${nodeId}`;

/** Refuses ids and namespaces over Vectorize's 64-byte limit instead of truncating them. */
export function checkVectorLimits(w: Who, nodeId: string): void {
	if (Buffer.byteLength(namespaceOf(w)) > 64 || Buffer.byteLength(vectorId(w, nodeId)) > 64) {
		throw new Error(`vector namespace or id for ${nodeId} would exceed 64 bytes`);
	}
}

export const embeddingsOn = (env: Env) => env.EMBEDDINGS !== "off" && !!env.AI && !!env.VECTORS;

/** One bounded step. Returns whether more cards are due. Embedding failures never touch committed memory. */
export async function embedStep(storage: DurableObjectStorage, env: Env, who: Who, meter: (neurons: number) => Promise<boolean>, gate: () => Promise<void>): Promise<boolean> {
	if (!embeddingsOn(env)) return false;
	const sql = storage.sql;
	const due = sql.exec<{ id: string; kind: string; name: string; description: string; why: string | null; card_hash: string }>(
		"SELECT id, kind, name, description, why, card_hash FROM nodes WHERE embed_hash IS NOT card_hash AND status = 'active' ORDER BY rowid LIMIT ?", BATCH).toArray();
	if (!due.length) return false;
	// The same bounded prefix the write path hashed: body, then live entries.
	const cards = due.map((n) => cardText(n, readPrefix(sql, n.id)));
	// Section 17's estimate: about 4 characters per token, 1,075 neurons per million input tokens.
	const neurons = cards.reduce((s, c) => s + c.length, 0) / 4 / 1e6 * 1075;
	const allowed = await meter(neurons);
	await gate();
	if (!allowed) return false;
	const out = await env.AI!.run(EMBED_MODEL, { text: cards }) as { data?: number[][] };
	await gate();
	if (!Array.isArray(out.data) || out.data.length !== cards.length) throw new Error("embedding response did not match the batch");
	const eligible = () => {
		if (sql.exec("SELECT 1 FROM profile_meta WHERE key = 'closed'").toArray().length) return [];
		return due.filter((n) => sql.exec("SELECT 1 FROM nodes WHERE id = ? AND status = 'active' AND card_hash = ?", n.id, n.card_hash).toArray().length > 0);
	};
	const ready = eligible();
	ready.forEach((n) => checkVectorLimits(who, n.id));
	if (!ready.length) return false;
	await env.VECTORS!.upsert(ready.map((n) => ({ id: vectorId(who, n.id), values: out.data![due.indexOf(n)]!, namespace: namespaceOf(who), metadata: { kind: n.kind, gen: who.generation } })));
	await gate();
	const keep = eligible();
	const gone = ready.filter((n) => !keep.includes(n));
	if (gone.length) await env.VECTORS!.deleteByIds(gone.map((n) => vectorId(who, n.id)));
	await gate();
	if (!keep.length) return false;
	storage.transactionSync(() => {
		const seq = nextSeq(sql, "profile_meta");
		// The BothQ rule: record embed_hash only if the card did not change while it was embedding.
		keep.forEach((n) => sql.exec("UPDATE nodes SET embed_hash = card_hash, seq = ? WHERE id = ? AND card_hash = ? AND status = 'active'", seq, n.id, n.card_hash));
	});
	return due.length === BATCH;
}

