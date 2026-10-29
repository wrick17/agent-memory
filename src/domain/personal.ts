// The personal-field rule (section 4): pure and import-free, so the Worker and the local import planner apply the same one.

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// International (+...), North American and Indian mobile formats; plain dates and counts do not match.
export const PHONE = /\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/;

/** A person keeps only these attributes: handles and role (section 4). */
const PERSON_ATTRS = new Set(["github", "jira", "role"]);
const CONTACT_KEY = /e-?mail|phone|mobile|\btel|address|birth/i;

/**
 * Drops personal fields before anything is hashed or stored, on every profile: on a person every attribute except handles
 * and role, and on any node an attribute named like a contact field or holding an email address or phone number.
 */
export function stripPersonal(kind: string, attrs: Record<string, unknown> | undefined): { attrs: Record<string, unknown>; stripped: string[] } {
	const kept: Record<string, unknown> = {}, stripped: string[] = [];
	for (const [k, v] of Object.entries(attrs ?? {})) {
		const personal = (kind === "person" && !PERSON_ATTRS.has(k)) || CONTACT_KEY.test(k) || (typeof v === "string" && (EMAIL.test(v) || PHONE.test(v)));
		if (personal) stripped.push(k); else kept[k] = v;
	}
	return { attrs: kept, stripped };
}
