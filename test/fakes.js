// Local stand-ins for Workers AI and Vectorize, bound as RPC services in the test environment only.
import { WorkerEntrypoint } from "cloudflare:workers";
// Deterministic bag-of-words vectors; sentinel words exercise the failure paths.
const DIM = 64;
const vectors = new Map();

function embed(text) {
	const v = new Array(DIM).fill(0);
	if (text.includes("[[vector-slow]]")) { v[0] = 999; return v; }
	if (text.includes("[[vector-fail]]")) { v[0] = -999; return v; }
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		let h = 2166136261;
		for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
		v[1 + (Math.abs(h) % (DIM - 1))] += 1;
	}
	return v;
}

const cosine = (a, b) => {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export class FakeAI extends WorkerEntrypoint {
	async run(_model, input) {
		const texts = Array.isArray(input.text) ? input.text : [input.text];
		if (texts.some((t) => t.includes("[[embed-fail]]"))) throw new Error("fake embedding failure");
		return { shape: [texts.length, DIM], data: texts.map(embed) };
	}
}


export class FakeVectors extends WorkerEntrypoint {
	async upsert(items) {
		for (const it of items) vectors.set(it.id, { values: it.values, namespace: it.namespace, metadata: it.metadata });
		return { mutationId: "fake" };
	}
	async deleteByIds(ids) {
		for (const id of ids) vectors.delete(id);
		return { mutationId: "fake" };
	}
	async query(vector, opts = {}) {
		if (vector[0] === 999) await new Promise((r) => setTimeout(r, 2000));
		if (vector[0] === -999) throw new Error("fake vectorize failure");
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
