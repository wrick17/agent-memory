// Port of BothQ memory_privacy.py. Applied before storage and before hashing, so a replayed payload still matches.
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|private[_-]?key)(?:$|[_-])/i;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const AUTH_HEADER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const VENDOR_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|xox[a-z]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{30,})\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// A secret's value: quoted, a $(..), ${..} or `..` reference, or one bare word.
const VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\([^)\n]*\)|\$\{[^}\n]*\}|\x60[^\x60\n]*\x60|[^\s,;]+)`;
// A value that only names where the secret comes from holds none, and is kept whole: a plain variable ($VAR, ${VAR}), a file read
// ($(cat <path>), $(<path), `cat <path>`) and an already-elided `…` (repo-fact literals such as `GH_TOKEN=… gh pr list`, contract
// section 4). Any other expansion or substitution may carry the literal itself (${VAR:-secret}, $(printf secret)) and is redacted.
const REFERENCE = /^["']?(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|\$\((?:cat[ \t]+|<[ \t]*)[^\s;&|\x60$()<>'"]+\)|\x60cat[ \t]+[^\s;&|\x60$()<>'"]+\x60|…)["']?$/;
// A quoted key (JSON, dict) and a bounded name prefix (github_token, AWS_SECRET_ACCESS_KEY) count too, as SENSITIVE_KEY's segment
// rule does for object keys; the bound keeps a long hyphenated run linear. ENV_KEY: an upper-case NAME_KEY= style assignment.
// Kept identical to local/agent-memory.mjs.
const KEY_VALUE = new RegExp(String.raw`\b((?:[\w-]{0,64}[_-])?(?:[a-z]{0,32}pass(?:word|wd)|pwd|secret|token|(?:api|secret|access|private|signing|encryption|master)[_-]?key))(["']?)\s*([:=])\s*(${VALUE})`, "gi");
const ENV_KEY = new RegExp(String.raw`\b([A-Z][A-Z0-9_]{0,63}_(?:KEY|AUTH|CREDENTIALS?|PASS))=(${VALUE})`, "g");
// A URL's user-info password, matched from its "://". The scheme is the run of scheme characters just before it and must
// hold a letter, exactly as BothQ's `[a-z][a-z0-9+.-]*://` requires; scanning back once per "://" keeps a long run linear,
// where retrying that pattern at every character was quadratic (a 1 MB run took minutes).
const URL_PASSWORD = /(:\/\/[^\s:/@]+:)[^\s/@]+(@)/g;
const SCHEME_CHAR = /[a-z0-9+.-]/i, LETTER = /[a-z]/i;
export function schemeBefore(text: string, end: number): boolean {
	for (let i = end - 1; i >= 0 && SCHEME_CHAR.test(text[i]!); i--) if (LETTER.test(text[i]!)) return true;
	return false;
}
// Any Authorization scheme (token, digest, a bare value), beyond AUTH_HEADER's Bearer and Basic.
const AUTHORIZATION = /(\b(?:proxy-)?authorization["']?\s*[:=]\s*)(?:(?:bearer|basic|token|digest|bot|negotiate)\s+)?("(?:\\.|[^"\\])*"|[^\s'",;]+)/gi;
// Secret flags with a space-separated value (--password x), the password flags of mysql, mongo, sshpass and redis-cli, curl's
// user:password and `aws configure set` of a secret. Each prefix is bounded, so a long run stays linear.
const SECRET_FLAGS = [
	new RegExp(String.raw`(?<!\S)(--(?:[A-Za-z0-9]{1,32}-){0,4}(?:password|passwd|pass|token|secret|api-?key|access-key|secret-key)[ \t]+)(?!-)(${VALUE})`, "gi"),
	new RegExp(String.raw`(\b(?:mysql\w*|mariadb\w*|mongo\w*|sshpass)\b[^;&|\n]{0,200}?[ \t]-p[ \t]*)(?!-)(${VALUE})`, "g"),
	new RegExp(String.raw`(\bredis-cli\b[^;&|\n]{0,200}?[ \t]-a[ \t]*)(?!-)(${VALUE})`, "g"),
	// curl's user:password, bare or quoted: only the user name stays.
	new RegExp(String.raw`(\bcurl\b[^;&|\n]{0,200}?[ \t](?:-u|--user)[ \t=]*["']?[^\s:;&|'"]+:)([^\s;&|'"]+)`, "g"),
	/(\baws[ \t]+configure[ \t]+set[ \t]+\S*(?:secret|key|token)\S*[ \t]+)(\S+)/gi,
];
const keepRef = (m: string, head: string, value: string) => (REFERENCE.test(value) ? m : `${head}${REDACTED}`);

// Named in order, so a review can say which rule fired without showing what it matched.
const RULES: [string, (s: string) => string][] = [
	["private_key", (s) => s.replace(PRIVATE_KEY, REDACTED)],
	["auth_header", (s) => s.replace(AUTH_HEADER, REDACTED)],
	["vendor_token", (s) => s.replace(VENDOR_TOKEN, REDACTED)],
	["aws_key", (s) => s.replace(AWS_KEY, REDACTED)],
	["jwt", (s) => s.replace(JWT, REDACTED)],
	["key_value", (s) => s.replace(KEY_VALUE, (m: string, key: string, quote: string, sep: string, value: string) => (REFERENCE.test(value) ? m : `${key}${quote}${sep}${REDACTED}`))
		.replace(ENV_KEY, (m: string, key: string, value: string) => keepRef(m, `${key}=`, value))],
	["url_password", (s) => s.replace(URL_PASSWORD, (m: string, head: string, at: string, offset: number, whole: string) => (schemeBefore(whole, offset) ? `${head}${REDACTED}${at}` : m))],
	["authorization", (s) => s.replace(AUTHORIZATION, keepRef)],
	["secret_flag", (s) => SECRET_FLAGS.reduce((t, re) => t.replace(re, keepRef), s)],
];

export function redactText(value: string): string {
	return RULES.reduce((s, [, rule]) => rule(s), value);
}

/** The names of the rules that change a value, in the order redactText applies them. */
export function redactionRules(value: string): string[] {
	const fired: string[] = [];
	RULES.reduce((s, [name, rule]) => { const next = rule(s); if (next !== s) fired.push(name); return next; }, value);
	return fired;
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
