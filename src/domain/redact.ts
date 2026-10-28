// Port of BothQ memory_privacy.py. Applied before storage and before hashing, so a replayed payload still matches.
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key)(?:$|[_-])/i;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const AUTH_HEADER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const VENDOR_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KEY_VALUE = /\b(password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/gi;

export function redactText(value: string): string {
	return value
		.replace(PRIVATE_KEY, REDACTED)
		.replace(AUTH_HEADER, REDACTED)
		.replace(VENDOR_TOKEN, REDACTED)
		.replace(AWS_KEY, REDACTED)
		.replace(JWT, REDACTED)
		.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
		.replace(URL_PASSWORD, (_m, head: string, at: string) => `${head}${REDACTED}${at}`);
}

/** A redacted copy; object keys that name secrets have their whole value replaced. */
export function redactPayload<T>(value: T): T {
	if (typeof value === "string") return redactText(value) as T;
	if (Array.isArray(value)) return value.map(redactPayload) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? REDACTED : redactPayload(v)])) as T;
	}
	return value;
}
