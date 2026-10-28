// The `me` write guard (section 5). Pure: the Worker passes the sensitive terms in.
import { fail, ok, type Outcome } from "./types";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// International (+...), North American and Indian mobile formats; plain dates and counts do not match.
const PHONE = /\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/;

export interface GuardInput {
	/** The profile the call's repo context or device default resolves to, ignoring the explicit `me`. */
	context: string | null;
	companyFree: boolean;
	texts: string[];
	sensitiveTerms: string[];
}

/** Every text field a save or append carries, including step text. */
export function guardTexts(a: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const k of ["name", "new_name", "description", "content", "why", "how_to_apply", "objective"]) if (typeof a[k] === "string") out.push(a[k] as string);
	if (Array.isArray(a.steps)) for (const s of a.steps) if (s && typeof s === "object") out.push(...Object.values(s as Record<string, unknown>).filter((v): v is string => typeof v === "string"));
	return out;
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
