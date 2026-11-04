// The `me` write guard (section 5). Pure. Profile choice belongs to the calling agent (issue #3).
import { EMAIL, PHONE } from "./personal";
import { fail, ok, type Outcome } from "./types";

export { stripPersonal } from "./personal";

const TERM_KINDS = new Set(["project", "component", "person", "ticket", "feature", "bug"]);

/** The terms a work record_knowledge call introduces: names, keys (with and without their prefixes) and handles. They feed the wipe's owner report, never a write guard. */
export function knowledgeTerms(nodes: { kind: string; name: string; key?: string; attrs?: Record<string, unknown> }[] | undefined): string[] {
	const out = new Set<string>();
	for (const n of nodes ?? []) {
		if (!TERM_KINDS.has(n.kind)) continue;
		const add = (s: unknown) => { const v = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""; if (v.length >= 2 && v.length <= 200) out.add(v); };
		add(n.name);
		if (n.key) { add(n.key.replace(/^[a-z]+:/, "")); add(n.key.split(":").pop()); }
		if (n.kind === "person") { add(n.attrs?.github); add(n.attrs?.jira); }
	}
	return [...out];
}

/** Every text field a save or append carries, including step text. */
export function guardTexts(a: unknown): string[] {
	// Every string a write carries, at any depth: steps, record_knowledge nodes, edges and evidence included.
	if (typeof a === "string") return [a];
	if (Array.isArray(a)) return a.flatMap(guardTexts);
	if (a && typeof a === "object") return Object.entries(a).filter(([k]) => k !== "request_id").flatMap(([, v]) => guardTexts(v));
	return [];
}

/**
 * The me write guard (section 5, issue #3). The calling agent chooses the profile; this never decides whether content is work
 * or personal. It keeps only the personal-field protection: me holds no contact fields such as emails or phone numbers.
 */
export function meGuard(texts: string[]): Outcome<null> {
	const text = texts.join("\n");
	if (EMAIL.test(text) || PHONE.test(text)) {
		return fail("me_sensitive_term", "me cannot hold personal contact fields such as emails or phone numbers", { term: "personal_field" });
	}
	return ok(null);
}

/** The first term the texts name, word-bounded and case-blind. Only the wipe's read-only owner report uses it; it never gates a write. */
export function namedTerm(texts: string[], terms: string[]): string | null {
	const lower = texts.join("\n").toLowerCase();
	for (const term of terms) {
		const t = term.toLowerCase();
		for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + 1)) {
			if (!/[a-z0-9]/.test(lower[at - 1] ?? " ") && !/[a-z0-9]/.test(lower[at + t.length] ?? " ")) return term;
		}
	}
	return null;
}
