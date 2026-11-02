// Port of BothQ memory_privacy.py. Applied before storage and before hashing, so a replayed payload still matches.
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key)(?:$|[_-])/i;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const AUTH_HEADER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const VENDOR_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// A quoted key (JSON, dict) and a bounded name prefix (github_token) count too, as SENSITIVE_KEY's segment rule does for object
// keys; the bound keeps a long hyphenated run linear. Kept identical to local/agent-memory.mjs.
const KEY_VALUE = /\b((?:[\w-]{0,64}[_-])?(?:password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret))(["']?)\s*([:=])\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
// A URL's user-info password, matched from its "://". The scheme is the run of scheme characters just before it and must
// hold a letter, exactly as BothQ's `[a-z][a-z0-9+.-]*://` requires; scanning back once per "://" keeps a long run linear,
// where retrying that pattern at every character was quadratic (a 1 MB run took minutes).
const URL_PASSWORD = /(:\/\/[^\s:/@]+:)[^\s/@]+(@)/g;
const SCHEME_CHAR = /[a-z0-9+.-]/i, LETTER = /[a-z]/i;
export function schemeBefore(text: string, end: number): boolean {
	for (let i = end - 1; i >= 0 && SCHEME_CHAR.test(text[i]!); i--) if (LETTER.test(text[i]!)) return true;
	return false;
}

export function redactText(value: string): string {
	return value
		.replace(PRIVATE_KEY, REDACTED)
		.replace(AUTH_HEADER, REDACTED)
		.replace(VENDOR_TOKEN, REDACTED)
		.replace(AWS_KEY, REDACTED)
		.replace(JWT, REDACTED)
		.replace(KEY_VALUE, (_m, key: string, quote: string, sep: string) => `${key}${quote}${sep}${REDACTED}`)
		.replace(URL_PASSWORD, (m: string, head: string, at: string, offset: number, whole: string) => (schemeBefore(whole, offset) ? `${head}${REDACTED}${at}` : m));
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
