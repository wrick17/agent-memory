// Local stand-ins for Workers AI and Vectorize, bound as RPC services in the test environment only.
import { WorkerEntrypoint } from "cloudflare:workers";
// Deterministic bag-of-words vectors; sentinel words exercise the failure paths.
const DIM = 64;
const vectors = new Map();

// Sentinels in the text: [[vector-slow]] delays the Vectorize query 2 s and [[vector-hang]] 4 s (past the 3 s deadline);
// [[vector-fail]] makes it throw. The delay rides in v[0], which stored cards leave at 0.
function embed(text) {
	const v = new Array(DIM).fill(0);
	v[0] = text.includes("[[vector-hang]]") ? 4000 : text.includes("[[vector-slow]]") ? 2000 : text.includes("[[vector-fail]]") ? -1 : 0;
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		let h = 2166136261;
		for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
		v[1 + (Math.abs(h) % (DIM - 1))] += 1;
	}
	return v;
}

// v[0] carries the sentinel delay, not meaning: it stays out of the similarity (#125's vector floor would otherwise drop it).
const cosine = (a, b) => {
	let dot = 0, na = 0, nb = 0;
	for (let i = 1; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

// [[embed-slow]] answers after 1.5 s (past the old 1 s bound), [[embed-hang]] after 4 s (past the 3 s deadline).
let aiPending = 0, aiCalls = 0;
export class FakeAI extends WorkerEntrypoint {
	async run(_model, input) {
		const texts = Array.isArray(input.text) ? input.text : [input.text];
		if (texts.some((t) => t.includes("[[embed-fail]]"))) throw new Error("fake embedding failure");
		const delay = texts.some((t) => t.includes("[[embed-hang]]")) ? 4000 : texts.some((t) => t.includes("[[embed-slow]]")) ? 1500 : 0;
		aiPending++;
		aiCalls++;
		try {
			if (delay) await new Promise((r) => setTimeout(r, delay));
			return { shape: [texts.length, DIM], data: texts.map(embed) };
		} finally {
			aiPending--;
		}
	}
	// Test-only inspection, not part of the Workers AI API.
	async _pending() { return aiPending; }
	async _calls() { return aiCalls; }
}


export class FakeVectors extends WorkerEntrypoint {
	async upsert(items) {
		for (const it of items) vectors.set(it.id, { values: it.values, namespace: it.namespace, metadata: it.metadata });
		return { mutationId: "fake" };
	}
	async getByIds(ids) {
		return ids.filter((id) => vectors.has(id)).map((id) => ({ id, values: vectors.get(id).values, namespace: vectors.get(id).namespace, metadata: vectors.get(id).metadata }));
	}
	async deleteByIds(ids) {
		for (const id of ids) vectors.delete(id);
		return { mutationId: "fake" };
	}
	async query(vector, opts = {}) {
		if (vector[0] > 0) await new Promise((r) => setTimeout(r, vector[0]));
		if (vector[0] === -1) throw new Error("fake vectorize failure");
		const kinds = opts.filter?.kind?.$in;
		const matches = [...vectors.entries()]
			.filter(([, v]) => v.namespace === opts.namespace && (!kinds || kinds.includes(v.metadata?.kind)))
			.map(([id, v]) => ({ id, score: cosine(vector, v.values) }))
			.filter((m) => m.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, opts.topK ?? 10);
		return { count: matches.length, matches };
	}
	// Test-only inspection, not part of the Vectorize API.
	async _ids() { return [...vectors.keys()]; }
}

export default { fetch: () => new Response("fakes") };
