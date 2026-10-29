// The `me` write guard (section 5). Pure: the Worker passes the sensitive terms in.
import { EMAIL, PHONE } from "./personal";
import { fail, ok, type Outcome } from "./types";

export { stripPersonal } from "./personal";

const TERM_KINDS = new Set(["project", "component", "person", "ticket", "feature", "bug"]);

/** The `me` guard terms a work record_knowledge call introduces: names, keys (with and without their prefixes) and handles. */
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

export interface GuardInput {
	/** The profile the call's repo context or device default resolves to, ignoring the explicit `me`. */
	context: string | null;
	companyFree: boolean;
	texts: string[];
	sensitiveTerms: string[];
}

/** Every text field a save or append carries, including step text. */
export function guardTexts(a: unknown): string[] {
	// Every string a write carries, at any depth: steps, record_knowledge nodes, edges and evidence included.
	if (typeof a === "string") return [a];
	if (Array.isArray(a)) return a.flatMap(guardTexts);
	if (a && typeof a === "object") return Object.entries(a).filter(([k]) => k !== "request_id").flatMap(([, v]) => guardTexts(v));
	return [];
}

export function meGuard(input: GuardInput): Outcome<null> {
	if (input.context === "work" && !input.companyFree) {
		return fail("me_requires_company_free", "a write to me from a work context must carry company_free: true after checking it holds no company detail");
	}
	const text = input.texts.join("\n");
	const lower = text.toLowerCase();
	for (const term of input.sensitiveTerms) {
		const t = term.toLowerCase();
		let at = lower.indexOf(t);
		while (at >= 0) {
			const before = lower[at - 1] ?? " ", after = lower[at + t.length] ?? " ";
			if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
				return fail("me_sensitive_term", `me cannot hold the work term '${term}'`, { term });
			}
			at = lower.indexOf(t, at + 1);
		}
	}
	if (EMAIL.test(text) || PHONE.test(text)) {
		return fail("me_sensitive_term", "me cannot hold personal contact fields such as emails or phone numbers", { term: "personal_field" });
	}
	return ok(null);
}
