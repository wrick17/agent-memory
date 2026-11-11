// Repo facts P1 (#91): five deterministic detectors over one completed session's command digest (local/facts.mjs). No model, no
// network, no clock: the same digest and the same known facts always give the same observations, in the same order.
//
// Shell outcomes are read conservatively. A recorded exit 0 proves a step ran only for a single command or an && chain (after `;` the
// status is the last group's, so earlier groups only set up the environment). `||`, pipes and commands cut at the digest's length
// limit prove nothing. Commands without an ok or failed status (error, unknown, pending) are skipped.

import { createHash } from "node:crypto";
import path from "node:path";
import { redact } from "./agent-memory.mjs";

export const DETECTORS = Object.freeze(["command_repair", "unavailable_tool", "env_var", "network", "empty_vcs"]);
/** A repair must follow its failure within this many commands. At most this many observations, fired keys and families per report. */
export const DETECT_LIMITS = Object.freeze({ window: 5, max: 32, literal: 120, statement: 200 });

const sha = (s) => createHash("sha256").update(s).digest("hex");
/** The server's fact key: sha256(detector + "\n" + literal), 16 hex. */
export const factKey = (detector, literal) => sha(`${detector}\n${literal}`).slice(0, 16);
/** The opaque family sent for a trigger label, scoped to the repo. */
export const familyHash = (repoKey, label) => sha(`${repoKey}\n${label}`).slice(0, 16);

// ---------- reading commands ----------

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORD = /^[a-z][\w:.-]*$/;

/** Strips `rtk [proxy]`, a whole-command `sh|bash|zsh -c '…'` wrapper and leading `cd …&&` steps. */
function unwrap(cmd) {
	let c = cmd.trim();
	for (let prev = null; prev !== c;) {
		prev = c;
		c = c.replace(/^rtk (?:proxy )?/, "").replace(/^cd [^;&|]+&&\s*/, "");
		const m = /^(?:\/bin\/)?(?:ba|z)?sh -l?c '(.*)'$/s.exec(c);
		if (m && !m[1].includes("'")) c = m[1];
	}
	return c;
}

/** Splits text at top-level separators outside quotes; a heredoc body (from `<<`) stays with its command. */
function split(text, sep) {
	const out = [];
	let cur = "", q = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) { cur += ch; if (ch === q) q = null; continue; }
		if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
		if (text.startsWith("<<", i)) { cur += text.slice(i); break; }
		const s = sep.find((x) => text.startsWith(x, i));
		if (s) { out.push(cur.trim()); cur = ""; i += s.length - 1; continue; }
		cur += ch;
	}
	out.push(cur.trim());
	return out.filter(Boolean);
}

const words = (seg) => seg.split(/\s+/).filter(Boolean);

/**
 * One shell step: { env: { unset: [...], set: [...] }, prog, head, text }. Inline `env -u V`, `env V=x`, `V=x` count as the step's
 * own environment change. head is the program and at most two following plain lowercase words ("gh auth switch", "npm test").
 */
function step(seg, inherited = { unset: [], set: [] }) {
	const w = words(seg), env = { unset: [...inherited.unset], set: [...inherited.set] };
	let i = 0;
	for (;;) {
		if (w[i] === "env") { i++; while (w[i] && (w[i].startsWith("-") || /^[A-Za-z_]\w*=/.test(w[i]))) { if (w[i] === "-u" && VAR.test(w[i + 1] ?? "")) { env.unset.push(w[i + 1]); i += 2; } else { if (!w[i].startsWith("-")) env.set.push(w[i].split("=")[0]); i++; } } continue; }
		if (/^[A-Za-z_]\w*=/.test(w[i] ?? "")) { env.set.push(w[i].split("=")[0]); i++; continue; }
		if (["sudo", "command", "exec", "time", "nohup"].includes(w[i])) { i++; continue; }
		break;
	}
	const prog = w[i] ? path.basename(w[i]).toLowerCase() : null;
	const head = [prog, ...w.slice(i + 1).filter((x, k, a) => a.slice(0, k + 1).every((y) => WORD.test(y))).slice(0, 2)].filter(Boolean).join(" ");
	return { env, prog: prog && /^[\w.+-]{1,40}$/.test(prog) ? prog : null, head, text: seg };
}

/** Environment changes a whole step makes for later steps: `unset A B`, `export A=…`. */
function setupOf(seg, env) {
	const u = /^unset ((?:[A-Za-z_]\w* ?)+)$/.exec(seg), e = /^export ([A-Za-z_]\w*)=/.exec(seg);
	if (u) return { unset: [...env.unset, ...u[1].trim().split(" ")], set: env.set };
	if (e) return { unset: env.unset, set: [...env.set, e[1]] };
	return null;
}

/** Every step of a command, in order, with its environment (failed commands: any step may be the failing one). */
function stepsOf(cmd) {
	const out = [];
	let env = { unset: [], set: [] };
	for (const seg of split(unwrap(cmd), ["&&", "||", ";", "|"])) {
		const s = setupOf(seg, env);
		if (s) { env = s; continue; }
		out.push(step(seg, env));
	}
	return out;
}

/** The steps an ok command proves ran with exit 0, or [] when its status cannot be attributed. */
function provenOk(c) {
	if (c.status !== "ok" || !c.cmd || c.cmd.endsWith("…")) return [];
	const body = unwrap(c.cmd), plain = body.split("<<")[0];
	if (/\|\|/.test(plain) || /(^|[^|])\|([^|]|$)/.test(plain)) return [];
	const groups = split(body, [";"]);
	let env = { unset: [], set: [] };
	for (const g of groups.slice(0, -1)) env = setupOf(g, env) ?? env;
	const out = [];
	for (const seg of split(groups.at(-1), ["&&"])) {
		const s = setupOf(seg, env);
		if (s) { env = s; continue; }
		out.push(step(seg, env));
	}
	return out;
}

const ran = (c) => (c.status === "ok" || c.status === "failed") && typeof c.cmd === "string";
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const one = (s) => s.trim().replace(/\s+/g, " ");
const PRIVATE = /\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\/;

// ---------- the five detectors ----------

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i;
const NOT_FOUND_SUB = /^(?:\/bin\/)?(?:sh|bash|dash)(?::\s*\d+)?:\s*([\w.+-]+): (?:command )?not found\b/;
const NOT_FOUND_SHELL = /(?:command not found: ([\w.+-]+)|^(?:zsh|bash)(?::\s*\d+)?:\s*([\w.+-]+): command not found)/;
const NO_MODULE = /No module named '?([A-Za-z_][\w.]*)'?/;
const ENV_MISSING = [/\b([A-Z][A-Z0-9_]{2,})\b (?:is not set|must be set|is required|is missing)\b/, /(?:environment variable|env var)s?:? `?([A-Z][A-Z0-9_]{2,})`? (?:is )?(?:not set|required|missing|must be set)/i, /Missing (?:required )?(?:environment variable|env var)s?:? `?([A-Z][A-Z0-9_]{2,})/i];
const HOST_DOWN = [/Could not resolve host:? ([\w.-]+)/i, /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)/, /Failed to connect to ([\w.-]+) port/i];
const EMPTY_REPO = /does not have any commits yet|ambiguous argument 'HEAD'|bad default revision 'HEAD'/;

const envPrefix = (env) => [env.unset.length ? `env ${env.unset.map((v) => `-u ${v}`).join(" ")}` : "", ...env.set.map((v) => `${v}=…`)].filter(Boolean).join(" ");
const added = (b, a) => ({ unset: b.unset.filter((v) => !a.unset.includes(v)), set: b.set.filter((v) => !a.set.includes(v)) });

/** Each fact definition: its trigger label (what counts as exercising it) and its fixed statement, from detector and literal only. */
export function describe(detector, literal) {
	if (detector === "command_repair") {
		const s = step(literal);
		return { label: `prog:${s.prog}`, statement: `Run \`${literal} …\` here; plain \`${s.head}\` fails in sessions here.` };
	}
	if (detector === "unavailable_tool") {
		const mod = /^import (\S+)$/.exec(literal);
		if (mod) return { label: `pymod:${mod[1].toLowerCase()}`, statement: `In the recorded Python environments \`import ${mod[1]}\` fails (No module named '${mod[1]}').` };
		const [head, tool] = literal.split(" needs ");
		return tool ? { label: `head:${head}`, statement: `\`${head}\` fails in sessions here with \`${tool}: command not found\`.` }
			: { label: `prog:${literal}`, statement: `\`${literal}\` is not available in the recorded environments.` };
	}
	if (detector === "env_var") {
		const [head, v] = literal.split(" needs ");
		return { label: `head:${head}`, statement: `\`${head}\` needs \`${v}\` set in sessions here.` };
	}
	if (detector === "network") return { label: `host:${literal}`, statement: `Network access to \`${literal}\` fails in sessions here.` };
	return { label: `head:${literal}`, statement: `This checkout has no commits yet, so \`${literal}\` fails.` };
}

/** Confirmations found in one session: { detector, literal } per fact, first one wins. */
function confirmations(cmds) {
	const found = new Map();
	const add = (detector, literal) => { const l = one(literal); if (l && !found.has(factKey(detector, l))) found.set(factKey(detector, l), { detector, literal: l }); };
	cmds.forEach((a, i) => {
		if (a.status !== "failed" || !a.cmd) return;
		const steps = stepsOf(a.cmd), errs = a.err ?? [];
		const later = cmds.slice(i + 1, i + 1 + DETECT_LIMITS.window).flatMap(provenOk);
		// command_repair: a later proven step of the same program and head, run with an environment change the failing one lacked.
		for (const b of later) for (const s of steps) {
			if (!s.prog || b.prog !== s.prog || b.head !== s.head) continue;
			const d = added(b.env, s.env);
			if (d.unset.length || d.set.length) add("command_repair", `${envPrefix(d)} ${b.head}`);
		}
		for (const e of errs) {
			// unavailable_tool: a missing Python module, a program the shell could not find, or a tool a child shell (an npm script) could not find.
			const mod = NO_MODULE.exec(e);
			if (mod) add("unavailable_tool", `import ${mod[1].split(".")[0]}`);
			const shell = NOT_FOUND_SHELL.exec(e), tool = shell?.[1] ?? shell?.[2];
			if (tool && steps.some((s) => s.prog === tool.toLowerCase())) add("unavailable_tool", tool.toLowerCase());
			const sub = NOT_FOUND_SUB.exec(e);
			// The child shell's command is known only when the failed command was one step.
			if (sub && steps.length === 1 && !a.cmd.includes("<<") && steps[0].prog !== sub[1].toLowerCase() && steps[0].head) add("unavailable_tool", `${steps[0].head} needs ${sub[1]}`);
			// env_var: the error names a missing variable and a later step of the same program sets it.
			for (const re of ENV_MISSING) {
				const v = re.exec(e)?.[1];
				if (!v) continue;
				const s = steps.find((x) => x.prog && later.some((b) => b.prog === x.prog && b.env.set.includes(v) && !x.env.set.includes(v)));
				if (s) add("env_var", `${s.head} needs ${v}`);
			}
			// network: a name or connect failure to a host other than loopback.
			for (const re of HOST_DOWN) { const h = re.exec(e)?.[1]?.toLowerCase(); if (h && !LOOPBACK.test(h)) add("network", h); }
			// empty_vcs: a git command in a repository without commits.
			if (EMPTY_REPO.test(e) && steps.length === 1 && steps[0].prog === "git") add("empty_vcs", steps[0].head);
		}
	});
	return found;
}

/** Whether a session contradicts a known fact: a proven success of exactly what the fact says fails. Env facts are never contradicted. */
function contradicts(cmds, { detector, literal }) {
	const ok = cmds.flatMap(provenOk);
	if (detector === "command_repair") { const f = step(literal); return ok.some((s) => s.prog === f.prog && s.head === f.head && !f.env.unset.some((v) => s.env.unset.includes(v)) && !f.env.set.some((v) => s.env.set.includes(v))); }
	if (detector === "unavailable_tool") {
		const mod = /^import (\S+)$/.exec(literal);
		if (mod) return ok.some((s) => new RegExp(`^python3? -c ['"]?\\s*(?:import|from) ${mod[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(s.text));
		const head = literal.split(" needs ")[0];
		return ok.some((s) => (literal.includes(" needs ") ? s.head === head : s.prog === literal));
	}
	if (detector === "network") return ok.some((s) => s.text.toLowerCase().includes(literal));
	if (detector === "empty_vcs") return ok.some((s) => s.head === literal);
	return false;
}

/** The trigger labels a session ran (ok or failed commands): programs, heads, imported Python modules and named hosts. */
function labelsOf(cmds) {
	const out = new Set();
	for (const c of cmds.filter(ran)) {
		for (const s of stepsOf(c.cmd)) {
			if (s.prog) out.add(`prog:${s.prog}`);
			const w = s.head.split(" ");
			for (let k = 2; k <= w.length; k++) out.add(`head:${w.slice(0, k).join(" ")}`);
		}
		for (const m of c.cmd.matchAll(/\b(?:import|from) ([A-Za-z_]\w*)/g)) out.add(`pymod:${m[1].toLowerCase()}`);
		for (const m of c.cmd.matchAll(/\b(?:https?:\/\/|git@)([a-z0-9][\w.-]*\.[a-z]{2,})/gi)) out.add(`host:${m[1].toLowerCase()}`);
	}
	return out;
}

/** Whether a session ran a known command_repair fact's fix with a proven success: the same program and head, with every environment change of the fix. */
const ranFix = (cmds, { detector, literal }) => detector === "command_repair"
	&& (() => { const f = step(literal); return cmds.flatMap(provenOk).some((s) => s.prog === f.prog && s.head === f.head && f.env.unset.every((v) => s.env.unset.includes(v)) && f.env.set.every((v) => s.env.set.includes(v))); })();

/** A literal and statement the server accepts: bounded, single line, unchanged by redaction, no private absolute path. */
export const acceptable = (literal, statement) => literal.length <= DETECT_LIMITS.literal && statement.length <= DETECT_LIMITS.statement
	&& redact(literal) === literal && redact(statement) === statement && !PRIVATE.test(literal) && !PRIVATE.test(statement) && !literal.includes("…") && !literal.includes("`");

/**
 * The deterministic part of one completed session's report.
 * @param {{ commands: object[] }} digest a commandDigest (merged over the whole session)
 * @param {{ known?: { detector: string, literal: string }[] }} options facts this device knows for the repo (own reports and the injection read)
 * @returns {{ observations: { fact_key, kind: "confirm" | "contradict", detector, statement, literal, label }[], fired: string[], labels: string[] }}
 * A confirmation is real evidence in this session: the detector saw the failure (and, for a repair, its fix), or a known command_repair
 * fact's fix ran again with a proven success (so a proposed fact can be confirmed by later sessions; a proposal itself never confirms).
 * At most one observation per fact: a contradiction wins over a confirmation in the same session, as the server counts them. fired is
 * the confirmed facts, so fired never exceeds exercised. labels are every trigger the session ran.
 */
export function detect(digest, { known = [] } = {}) {
	const cmds = Array.isArray(digest?.commands) ? digest.commands : [];
	const facts = new Map();
	for (const [k, f] of confirmations(cmds)) facts.set(k, { ...f, kind: "confirm" });
	for (const f of known) {
		if (!DETECTORS.includes(f?.detector) || typeof f.literal !== "string") continue;
		const k = factKey(f.detector, f.literal);
		if (contradicts(cmds, f)) facts.set(k, { detector: f.detector, literal: f.literal, kind: "contradict" });
		else if (!facts.has(k) && ranFix(cmds, f)) facts.set(k, { detector: f.detector, literal: f.literal, kind: "confirm" });
	}
	const observations = [];
	for (const [fact_key, f] of [...facts].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const { label, statement } = describe(f.detector, f.literal);
		const s = clip(statement, DETECT_LIMITS.statement);
		if (acceptable(f.literal, s)) observations.push({ fact_key, kind: f.kind, detector: f.detector, statement: s, literal: f.literal, label });
	}
	const kept = observations.slice(0, DETECT_LIMITS.max);
	return { observations: kept, fired: kept.filter((o) => o.kind === "confirm").map((o) => o.fact_key), labels: [...labelsOf(cmds)].sort() };
}
