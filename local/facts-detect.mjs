// Repo facts (#91, v2 #116): deterministic detectors over one completed session's command digest (local/facts.mjs). No model, no
// network, no clock: the same digest and the same known facts always give the same observations, in the same order.
// Contract: docs/repo-facts-v2-contract.md section 4.
//
// Shell outcomes are read conservatively. A recorded exit 0 proves a step ran only for a single command or an && chain (after `;` the
// status is the last group's, so earlier groups only set up the environment). `||`, pipes and commands cut at the digest's length
// limit prove nothing. Commands without an ok or failed status (error, unknown, pending) are skipped.
//
// Every repair (command_repair, env_var, form_repair, arg_repair) needs the same-operation proof: the fix is a proven-ok step at most
// DETECT_LIMITS.window commands after the failure, and once the fix's own change (env prefix, launcher, added or removed args) is
// removed its arguments equal the failing step's token for token.

import { createHash } from "node:crypto";
import path from "node:path";
import { redact } from "./agent-memory.mjs";

export const DETECTORS = Object.freeze(["command_repair", "unavailable_tool", "env_var", "network", "empty_vcs", "form_repair", "arg_repair"]);
/** A repair must follow its failure within this many commands. At most this many observations, fired keys and families per report. */
export const DETECT_LIMITS = Object.freeze({ window: 5, max: 32, literal: 120, learned_literal: 400, statement: 200 });

// Mirrors of src/domain/types.ts ("Repo facts v2"); the local client cannot import TypeScript. Keep them identical.
/** form_repair fixes: the failing program run through exactly one of these launchers. */
export const FORM_WRAPPERS = Object.freeze(["python -m", "python3 -m", "npx", "npm exec", "pnpm exec", "pnpm dlx", "yarn", "bunx", "uv run", "poetry run", "bundle exec"]);
const G_PROG = "[a-z0-9_][a-z0-9_.+-]{0,39}", G_WORD = "[a-z][a-z0-9_:.-]{0,39}", G_HEAD = `${G_PROG}(?: ${G_WORD}){0,2}`, G_VAR = "[A-Za-z_][A-Za-z0-9_]{0,63}";
const G_ARG = "(?:--|--?[A-Za-z][A-Za-z0-9-]{0,31}(?:=[A-Za-z0-9_.:,/@+-]{1,40})?)";
const G_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** The literal grammar of each deterministic detector. */
export const FACT_LITERAL = Object.freeze({
	command_repair: new RegExp(`^(?=env -u |${G_VAR}=… )(?:env(?: -u ${G_VAR})+ )?(?:${G_VAR}=… )*${G_HEAD}$`),
	unavailable_tool: new RegExp(`^(?:import ${G_VAR}(?:\\.${G_VAR}){0,7}|${G_PROG}|${G_HEAD} needs [A-Za-z0-9_][A-Za-z0-9_.+-]{0,39})$`),
	env_var: new RegExp(`^${G_HEAD} needs [A-Z][A-Z0-9_]{2,63}$`),
	network: new RegExp(`^(?=.{1,120}$)${G_LABEL}(?:\\.${G_LABEL})+$`),
	empty_vcs: new RegExp(`^git(?: ${G_WORD}){0,2}$`),
	form_repair: new RegExp(`^(${G_PROG}) => (?:${FORM_WRAPPERS.join("|")}) \\1$`),
	arg_repair: new RegExp(`^${G_HEAD} (?:with|without) ${G_ARG}(?: ${G_ARG}){0,2}$`),
});
export const FACT_CLASSES = Object.freeze(["environment", "repo"]);
/** Programs a learned fix may never start with: shells, evaluators, privilege, network and deletion. */
export const FIX_DENY = Object.freeze(["sh", "bash", "zsh", "dash", "fish", "eval", "exec", "source", "sudo", "doas", "su", "env", "xargs", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "rm", "dd", "mkfs", "chmod", "chown"]);
/** A learned signature's head. */
export const FACT_HEAD = new RegExp(`^${G_HEAD}$`);
/**
 * A learned fix: one plain command, program then at most 7 argument tokens, at most 120 chars, no shell metacharacter. Callers also
 * check: no `://`, no `user@host:` token, program not in FIX_DENY, and head's program is one of its tokens.
 */
export const FACT_FIX = new RegExp(`^(?=.{2,120}$)${G_PROG}(?: [A-Za-z0-9_.,:@%+=/-]{1,64}){0,7}$`);
/** One signature string (scope, confirm, contradict): 3 to 80 chars of lowercase printable ASCII without ` " ; | < > or doubled spaces. */
export const FACT_SIGNATURE_STRING = /^(?=.{3,80}$)(?!.* {2})[a-z0-9 !#$%&'()*+,./:=?@[\\\]^_{}~-]+$/;
/** The canonical learned literal (the identity the fact key hashes): sets sorted, joined with `; `. Excludes contradict. */
export const learnedLiteral = (s, cls) =>
	`${s.head} | scope: ${[...s.scope].sort().join("; ")} | confirm: ${[...s.confirm].sort().join("; ")}${s.fix ? ` | fix: ${s.fix}` : ""} | class: ${cls}`;

const sha = (s) => createHash("sha256").update(s).digest("hex");
/** The server's fact key: sha256(detector + "\n" + literal), 16 hex. */
export const factKey = (detector, literal) => sha(`${detector}\n${literal}`).slice(0, 16);
/** The opaque family sent for a trigger label, scoped to the repo. */
export const familyHash = (repoKey, label) => sha(`${repoKey}\n${label}`).slice(0, 16);
/** One head's family label: `prog:<head>` for one word, else `head:<head>`. */
export const headLabel = (head) => (head.includes(" ") ? `head:${head}` : `prog:${head}`);

// ---------- reading commands ----------

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORD = /^[a-z][\w:.-]*$/;
const PROG = /^[\w.+-]{1,40}$/;

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
/** The program and at most two following plain lowercase words ("gh auth switch", "npm test"). */
const headOf = (prog, args) => [prog, ...args.filter((x, k, a) => a.slice(0, k + 1).every((y) => WORD.test(y))).slice(0, 2)].filter(Boolean).join(" ");

/**
 * One shell step: { env: { unset: [...], set: [...] }, prog, head, text, args, line }. Inline `env -u V`, `env V=x`, `V=x` count as the
 * step's own environment change. args are the raw words after the program; line is the program and its args.
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
	const prog = w[i] ? path.basename(w[i]).toLowerCase() : null, args = w.slice(i + 1);
	return { env, prog: prog && PROG.test(prog) ? prog : null, head: headOf(prog, args), text: seg, args, line: w.slice(i).join(" ") };
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

/** The step `WRAPPER PROG args` runs: { wrapper, inner: { prog, head, args } }, or null when the step is not a launcher call. */
const WRAPPERS = FORM_WRAPPERS.map((w) => w.split(" "));
function launched(s) {
	if (!s.prog) return null;
	const w = [s.prog, ...s.args];
	// shortcut: launcher options (npx --yes, npm exec --) are not skipped; add them when a recorded session needs it.
	const t = WRAPPERS.find((x) => x.every((y, k) => w[k] === y) && PROG.test(w[x.length] ?? "") && !w[x.length].startsWith("-"));
	if (!t) return null;
	const prog = w[t.length].toLowerCase(), args = w.slice(t.length + 1);
	return { wrapper: t.join(" "), inner: { prog, head: headOf(prog, args), args } };
}

// zsh: `zsh:1: command not found: x`; bash: `bash: x: command not found`, `bash: line 1: x: command not found`. The bash form is anchored
// at the end so zsh's `zsh:1: command not found` prefix never reads as a tool named `1`.
const STATUS_LINE = /(?:command not found: ([\w.+-]+)|^(?:zsh|bash)(?::\s*\d+|: line \d+)?:\s*([\w.+-]+): command not found\s*$)/;
/**
 * The step of a failed command that failed: its only operational step (a `cd` only moves), the last step when the command's last `;`
 * group is that one plain step (the shell reports its status), or the one step whose program the shell reported as not found. Null
 * when the failure cannot be pinned to one step: in `a && b` either may have failed, so neither is blamed.
 */
function failingStep(c, steps) {
	const ops = steps.filter((s) => s.prog !== "cd");
	if (ops.length === 1) return ops[0];
	const last = split(unwrap(c.cmd), [";"]).at(-1) ?? "";
	if (ops.length && ops.at(-1) === steps.at(-1) && steps.at(-1).text === last && split(last, ["&&", "||", "|"]).length === 1) return ops.at(-1);
	for (const e of c.err ?? []) {
		const m = STATUS_LINE.exec(e), tool = (m?.[1] ?? m?.[2])?.toLowerCase();
		const hit = tool ? ops.filter((s) => s.prog === tool) : [];
		if (hit.length === 1) return hit[0];
	}
	return null;
}

const ran = (c) => (c.status === "ok" || c.status === "failed") && typeof c.cmd === "string";
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const one = (s) => s.trim().replace(/\s+/g, " ");
const PRIVATE = /\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\/;
const sameArgs = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const added = (b, a) => ({ unset: b.unset.filter((v) => !a.unset.includes(v)), set: b.set.filter((v) => !a.set.includes(v)) });
const noDelta = (d) => !d.unset.length && !d.set.length;
const sameEnv = (a, b) => noDelta(added(a.env, b.env)) && noDelta(added(b.env, a.env));

// ---------- detectors ----------

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i;
const NOT_FOUND_SUB = /^(?:\/bin\/)?(?:sh|bash|dash)(?::\s*\d+)?:\s*([\w.+-]+): (?:command )?not found\b/;
const NOT_FOUND_SHELL = STATUS_LINE;
const NO_MODULE = /No module named '?([A-Za-z_][\w.]*)'?/;
const ENV_MISSING = [/\b([A-Z][A-Z0-9_]{2,})\b (?:is not set|must be set|is required|is missing)\b/, /(?:environment variable|env var)s?:? `?([A-Z][A-Z0-9_]{2,})`? (?:is )?(?:not set|required|missing|must be set)/i, /Missing (?:required )?(?:environment variable|env var)s?:? `?([A-Z][A-Z0-9_]{2,})/i];
const HOST_DOWN = [/Could not resolve host:? ([\w.-]+)/i, /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)/, /Failed to connect to ([\w.-]+) port/i];
const EMPTY_REPO = /does not have any commits yet|ambiguous argument 'HEAD'|bad default revision 'HEAD'/;
/** A missing module's full dotted name ("numpy.typing"), without a sentence's trailing dot. */
const moduleOf = (e) => NO_MODULE.exec(e)?.[1].replace(/\.+$/, "") || null;
const envVarsOf = (e) => ENV_MISSING.map((re) => re.exec(e)?.[1]).filter(Boolean);

const ARG = new RegExp(`^${G_ARG}$`);
/**
 * Args an arg_repair may not teach: options that only inform (help, version, listing, dry runs) so the run did not do the operation,
 * options that override safety (force, no-verify, hard, yes), and anything named like a secret.
 */
const ARG_DENY = /^(?:-[hvnfdy]|--(?:help|version|dry-run|force|force-with-lease|no-verify|hard|yes|list[\w-]*|show[\w-]*|print[\w-]*)(?:=.*)?)$|secret|token|passw|key|credential/i;
/** The args `long` adds to `short` (1 to 3 plain options, `short` a subsequence of `long`), or null. */
function argDelta(long, short) {
	const extra = [];
	let j = 0;
	for (const x of long) { if (j < short.length && x === short[j]) j++; else extra.push(x); }
	if (j < short.length || extra.length < 1 || extra.length > 3 || extra.every((x) => x === "--")) return null;
	return extra.every((x) => ARG.test(x) && !ARG_DENY.test(x)) ? extra : null;
}

const envPrefix = (env) => [env.unset.length ? `env ${env.unset.map((v) => `-u ${v}`).join(" ")}` : "", ...env.set.map((v) => `${v}=…`)].filter(Boolean).join(" ");

/** A literal's parts: { form: [prog, wrapper] } for form_repair, { arg: [head, with|without, args] } for arg_repair. */
const formOf = (literal) => /^(\S+) => (.+) \1$/.exec(literal)?.slice(1, 3) ?? null;
const argOf = (literal) => { const m = /^(.+?) (with|without) (-\S*(?: -\S*)*)$/.exec(literal); return m ? [m[1], m[2], m[3].split(" ")] : null; };
/** Whether a step has the shape an arg_repair fact says fails: missing the args (with), or carrying them (without). */
const argShape = (s, [head, how, args]) => {
	const opts = args.filter((x) => x !== "--");
	return s.head === head && (how === "with" ? !opts.some((x) => s.args.includes(x)) : opts.every((x) => s.args.includes(x)));
};

/** A learned fact's statement (contract section 3). */
const learnedStatement = (sig) => `Learned: \`${sig.head}\` has failed here with an error containing "${sig.confirm[0]}".${sig.fix ? ` A command that worked here: \`${sig.fix}\`.` : ""}`;

/**
 * Each fact definition: its family label (what counts as exercising it) and its fixed statement, from detector and literal only (a
 * learned fact from its signature). The server derives the stored statement the same way; the client never sends its own.
 */
export function describe(detector, literal, signature) {
	if (detector === "learned") return { label: headLabel(signature.head), statement: learnedStatement(signature) };
	if (detector === "command_repair") {
		const s = step(literal);
		return { label: `prog:${s.prog}`, statement: `Run \`${literal} …\` here; plain \`${s.head}\` fails in sessions here.` };
	}
	if (detector === "unavailable_tool") {
		const mod = /^import (\S+)$/.exec(literal);
		if (mod) return { label: `pymod:${mod[1].split(".")[0].toLowerCase()}`, statement: `In the recorded Python environments \`import ${mod[1]}\` fails (No module named '${mod[1]}').` };
		const [head, tool] = literal.split(" needs ");
		return tool ? { label: headLabel(head), statement: `\`${head}\` fails in sessions here with \`${tool}: command not found\`.` }
			: { label: `prog:${literal}`, statement: `\`${literal}\` is not available in the recorded environments.` };
	}
	if (detector === "env_var") {
		const [head, v] = literal.split(" needs ");
		return { label: headLabel(head), statement: `\`${head}\` needs \`${v}\` set in sessions here.` };
	}
	if (detector === "network") return { label: `host:${literal}`, statement: `Network access to \`${literal}\` fails in sessions here.` };
	if (detector === "form_repair") {
		const [prog, wrapper] = formOf(literal) ?? [literal, ""];
		return { label: `prog:${prog}`, statement: `Run \`${wrapper} ${prog}\` instead of plain \`${prog}\`; plain \`${prog}\` fails on this machine.` };
	}
	if (detector === "arg_repair") {
		const [head, how, args] = argOf(literal) ?? [literal, "with", []];
		return { label: headLabel(head), statement: how === "with" ? `\`${head}\` fails here without \`${args.join(" ")}\`; run \`${head} ${args.join(" ")}\`.` : `\`${head}\` fails here with \`${args.join(" ")}\`; run it without them.` };
	}
	return { label: headLabel(literal), statement: `This checkout has no commits yet, so \`${literal}\` fails.` };
}

/** Confirmations found in one session: { detector, literal } per fact, first one wins. */
function confirmations(cmds) {
	const found = new Map();
	const add = (detector, literal) => { const l = one(literal); if (l && !found.has(factKey(detector, l))) found.set(factKey(detector, l), { detector, literal: l }); };
	cmds.forEach((a, i) => {
		if (a.status !== "failed" || !a.cmd) return;
		const steps = stepsOf(a.cmd), errs = a.err ?? [], f = failingStep(a, steps);
		const later = cmds.slice(i + 1, i + 1 + DETECT_LIMITS.window).flatMap(provenOk);
		for (const b of later) {
			if (!f?.prog) continue;
			// command_repair: the failing step's operation (program, head, args) run with an environment change it lacked.
			if (b.prog === f.prog && b.head === f.head && sameArgs(b.args, f.args)) {
				const d = added(b.env, f.env);
				if (!noDelta(d)) add("command_repair", `${envPrefix(d)} ${b.head}`);
			}
			if (!sameEnv(b, f)) continue;
			// form_repair: the failing program run through one launcher, with the same args.
			const l = launched(b);
			if (l && l.inner.prog === f.prog && sameArgs(l.inner.args, f.args)) add("form_repair", `${f.prog} => ${l.wrapper} ${f.prog}`);
			// arg_repair: the same head with only plain options added or removed.
			if (b.prog === f.prog && b.head === f.head) {
				const w = argDelta(b.args, f.args), wo = w ? null : argDelta(f.args, b.args);
				if (w) add("arg_repair", `${f.head} with ${w.join(" ")}`);
				else if (wo) add("arg_repair", `${f.head} without ${wo.join(" ")}`);
			}
		}
		for (const e of errs) {
			// unavailable_tool: a missing Python module (full dotted name), a program the shell could not find, or a tool a child shell (an npm script) could not find.
			const mod = moduleOf(e);
			if (mod) add("unavailable_tool", `import ${mod}`);
			const shell = NOT_FOUND_SHELL.exec(e), tool = shell?.[1] ?? shell?.[2];
			if (tool && steps.some((s) => s.prog === tool.toLowerCase())) add("unavailable_tool", tool.toLowerCase());
			const sub = NOT_FOUND_SUB.exec(e);
			// The child shell's command is known only when the failed command was one step.
			if (sub && steps.length === 1 && !a.cmd.includes("<<") && steps[0].prog !== sub[1].toLowerCase() && steps[0].head) add("unavailable_tool", `${steps[0].head} needs ${sub[1]}`);
			// env_var: the error names a missing variable and a later step does the failing step's operation with it set.
			for (const v of envVarsOf(e)) {
				if (f?.prog && !f.env.set.includes(v) && later.some((b) => b.prog === f.prog && b.head === f.head && sameArgs(b.args, f.args) && b.env.set.includes(v))) add("env_var", `${f.head} needs ${v}`);
			}
			// network: a name or connect failure to a host other than loopback.
			for (const re of HOST_DOWN) { const h = re.exec(e)?.[1]?.toLowerCase(); if (h && !LOOPBACK.test(h)) add("network", h); }
			// empty_vcs: a git command in a repository without commits.
			if (EMPTY_REPO.test(e) && steps.length === 1 && steps[0].prog === "git") add("empty_vcs", steps[0].head);
		}
	});
	return found;
}

// Network operations whose target is an argument: a URL (curl, wget, http, git remote commands) or a host or user@host (ssh, ping, nc).
const URL_CLIENTS = new Set(["curl", "wget", "http", "https"]), HOST_CLIENTS = new Set(["ssh", "ping", "nc"]);
const GIT_REMOTE = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
// shortcut: only simple destination forms are attributed; extend explicit option handling when a verified command needs it.
const DEST_FLAGS = {
	curl: /^-[fsSLIkv46]+$/, wget: /^-[qSv46]+$/, ssh: /^-[TtNnqv46]+$/, ping: /^-[nqv]+$/, nc: /^-[vz46]+$/,
	git: /^(?:-q|--(?:quiet|heads|tags|refs|symref|exit-code))$/,
};
/** Whether a proven step is a recognized network operation aimed at host itself. Anything else (search text, headers, echo) is not. */
function reaches(s, host) {
	const args = s.args.map((w) => w.replace(/^['"]|['"]$/g, "").toLowerCase());
	if (s.prog === "git" && !GIT_REMOTE.has(args.shift())) return false;
	while (args[0]?.startsWith("-")) {
		const flag = args.shift();
		if (flag === "--") break;
		if (s.prog === "curl" && flag === "--url" && args.length === 1) break;
		if (!DEST_FLAGS[s.prog]?.test(flag)) return false;
	}
	const target = args[0];
	if (!target || target.startsWith("-")) return false;
	const url = (w) => {
		try {
			const value = /^(?:https?|ssh|git|ftps?):\/\//.test(w) ? w : /^[^/\s]+@[^/\s]+:/.test(w) ? `ssh://${w.replace(/^([^/:@]+@[^/:]+):/, "$1/")}` : "";
			return new URL(value).hostname === host;
		} catch { return false; }
	};
	if (URL_CLIENTS.has(s.prog)) return args.length === 1 && url(target);
	if (s.prog === "git") return !args.slice(1).some((w) => w.startsWith("-")) && url(target);
	if (HOST_CLIENTS.has(s.prog)) return (s.prog === "ssh" || args.slice(1).every((w) => /^\d+(?:-\d+)?$/.test(w))) && (target === host || target.endsWith(`@${host}`));
	return false;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasEnv = (s, f) => f.env.unset.every((v) => s.env.unset.includes(v)) && f.env.set.every((v) => s.env.set.includes(v));

/** Whether a session contradicts a known fact: a proven success of exactly what the fact says fails. Env facts are never contradicted. */
function contradicts(cmds, { detector, literal }) {
	const ok = cmds.flatMap(provenOk);
	if (detector === "command_repair") { const f = step(literal); return ok.some((s) => s.prog === f.prog && s.head === f.head && !f.env.unset.some((v) => s.env.unset.includes(v)) && !f.env.set.some((v) => s.env.set.includes(v))); }
	if (detector === "unavailable_tool") {
		const mod = /^import (\S+)$/.exec(literal);
		// The full dotted name: importing numpy contradicts `import numpy`, never `import numpy.typing`.
		if (mod) return ok.some((s) => new RegExp(`^python3? -c ['"]?\\s*(?:import|from) ${escRe(mod[1])}\\b`).test(s.text));
		const head = literal.split(" needs ")[0];
		return ok.some((s) => (literal.includes(" needs ") ? s.head === head : s.prog === literal));
	}
	if (detector === "network") return ok.some((s) => reaches(s, literal));
	if (detector === "empty_vcs") return ok.some((s) => s.head === literal);
	// form_repair: the plain program worked. arg_repair: the head worked without the args it needs (or with the ones it must drop).
	if (detector === "form_repair") { const f = formOf(literal); return !!f && ok.some((s) => s.prog === f[0]); }
	if (detector === "arg_repair") { const a = argOf(literal); return !!a && ok.some((s) => argShape(s, a)); }
	return false;
}

/** Whether a known fact's failure happened again in this session (an injected fact `fired`). */
function recurred(cmds, { detector, literal }) {
	return cmds.some((c) => {
		if (c.status !== "failed" || !c.cmd) return false;
		const steps = stepsOf(c.cmd), errs = c.err ?? [], f = failingStep(c, steps);
		if (detector === "command_repair") { const x = step(literal); return !!f && f.prog === x.prog && f.head === x.head && !hasEnv(f, x); }
		if (detector === "form_repair") { const x = formOf(literal); return !!x && f?.prog === x[0]; }
		if (detector === "arg_repair") { const x = argOf(literal); return !!x && !!f && argShape(f, x); }
		if (detector === "env_var") { const [head, v] = literal.split(" needs "); return errs.some((e) => envVarsOf(e).includes(v)) && !!f && f.head === head && !f.env.set.includes(v); }
		return confirmations([c]).has(factKey(detector, literal));
	});
}

/** Whether a known fact's fix ran with a proven success: command_repair's env change, form_repair's launcher, arg_repair's args. */
function ranFix(cmds, { detector, literal }) {
	const ok = cmds.flatMap(provenOk);
	if (detector === "command_repair") { const f = step(literal); return ok.some((s) => s.prog === f.prog && s.head === f.head && hasEnv(s, f)); }
	if (detector === "form_repair") { const f = formOf(literal); return !!f && ok.some((s) => { const l = launched(s); return l?.wrapper === f[1] && l.inner.prog === f[0]; }); }
	if (detector === "arg_repair") { const a = argOf(literal); return !!a && ok.some((s) => s.head === a[0] && !argShape(s, a)); }
	return false;
}

const lower = (s) => String(s).toLowerCase();
const validSignature = (s) => s && typeof s.head === "string" && s.head && ["scope", "confirm"].every((k) => Array.isArray(s[k]) && s[k].length >= 1 && s[k].length <= 3)
	&& (s.contradict === undefined || (Array.isArray(s.contradict) && s.contradict.length <= 3))
	&& [...s.scope, ...s.confirm, ...(s.contradict ?? [])].every((x) => typeof x === "string" && FACT_SIGNATURE_STRING.test(x)) && (s.fix === undefined || typeof s.fix === "string");

/**
 * A learned signature against one session, by plain `includes` on the lowercased, scrubbed digest text (never a regex). A step is in
 * scope when its unwrapped text holds every scope string. confirm: a failed command with an in-scope step whose error lines hold a
 * confirm string. contradict: a proven-ok in-scope step holding a contradict string. fixed: a proven-ok in-scope step starting with fix.
 * @param {{ commands: object[] }} digest @param {{ head, scope: string[], confirm: string[], contradict?: string[], fix?: string }} signature
 * @returns {{ in_scope: boolean, confirm: boolean, contradict: boolean, fixed: boolean }} all false for an invalid signature
 */
export function matchSignature(digest, signature) {
	const cmds = Array.isArray(digest?.commands) ? digest.commands : [];
	const none = { in_scope: false, confirm: false, contradict: false, fixed: false };
	if (!validSignature(signature)) return none;
	const scoped = (s) => signature.scope.every((x) => lower(s.text).includes(x));
	const failed = cmds.filter((c) => c.status === "failed" && c.cmd).map((c) => ({ c, steps: stepsOf(c.cmd).filter(scoped) })).filter((x) => x.steps.length);
	const ok = cmds.flatMap(provenOk).filter(scoped), fix = signature.fix ? lower(signature.fix) : null;
	return {
		in_scope: cmds.filter(ran).some((c) => stepsOf(c.cmd).some(scoped)),
		confirm: failed.some(({ c }) => (c.err ?? []).some((e) => signature.confirm.some((x) => lower(e).includes(x)))),
		contradict: ok.some((s) => (signature.contradict ?? []).some((x) => lower(s.text).includes(x))),
		fixed: !!fix && ok.some((s) => lower(s.line) === fix || lower(s.line).startsWith(`${fix} `)),
	};
}

/**
 * The family labels a session ran (ok or failed commands): for every step `prog:`, `head:` for its first 2 and 3 words, `pymod:` for
 * each imported top-level module and `host:` for each reached host; a `WRAPPER PROG …` step also gives the unwrapped command's labels.
 */
function labelsOf(cmds) {
	const out = new Set();
	const heads = (prog, head) => {
		if (prog) out.add(`prog:${prog}`);
		const w = head.split(" ");
		for (let k = 2; k <= w.length; k++) out.add(`head:${w.slice(0, k).join(" ")}`);
	};
	for (const c of cmds.filter(ran)) {
		const steps = stepsOf(c.cmd);
		for (const s of steps) {
			heads(s.prog, s.head);
			const l = launched(s);
			if (l) heads(l.inner.prog, l.inner.head);
		}
		for (const m of c.cmd.matchAll(/\b(?:import|from) ([A-Za-z_]\w*)/g)) out.add(`pymod:${m[1].toLowerCase()}`);
		for (const m of c.cmd.matchAll(/\b(?:https?:\/\/|git@)([a-z0-9][\w.-]*\.[a-z]{2,})/gi)) {
			const host = m[1].toLowerCase();
			if (steps.some((s) => reaches(s, host))) out.add(`host:${host}`);
		}
	}
	return out;
}

/**
 * A literal and statement the server accepts: bounded, single line, unchanged by redaction, no private absolute path, no backtick or
 * quote. With a deterministic detector the literal must also match its FACT_LITERAL grammar (which admits `…` only as command_repair's
 * `V=…`); a learned literal may run to DETECT_LIMITS.learned_literal.
 */
export const acceptable = (literal, statement, detector) => {
	const grammar = FACT_LITERAL[detector];
	const max = detector === "learned" ? DETECT_LIMITS.learned_literal : DETECT_LIMITS.literal;
	return typeof literal === "string" && literal.length <= max && statement.length <= DETECT_LIMITS.statement && !/[\n`"]/.test(literal)
		&& redact(literal) === literal && redact(statement) === statement && !PRIVATE.test(literal) && !PRIVATE.test(statement)
		&& (grammar ? grammar.test(literal) : detector === "learned" || !literal.includes("…"));
};

/**
 * The deterministic part of one completed session's report.
 * @param {{ commands: object[] }} digest a commandDigest (merged over the whole session)
 * @param {{ known?: { detector: string, literal: string, signature?: object }[] }} options facts this device knows for the repo (own
 * reports, the injection read and the held read; a learned fact needs its signature)
 * @returns {{ observations: { fact_key, kind: "confirm" | "contradict", detector, statement, literal, label }[], fired: string[], labels: string[] }}
 * A confirmation is real evidence in this session: the detector saw the failure (and, for a repair, its same-operation fix), a learned
 * signature's confirm string in a failed in-scope step, or a known command_repair fact's fix ran again with a proven success. At most
 * one observation per fact: a contradiction wins over a confirmation in the same session. fired is the confirmed facts. labels are
 * every family label the session ran.
 */
export function detect(digest, { known = [] } = {}) {
	const cmds = Array.isArray(digest?.commands) ? digest.commands : [];
	const facts = new Map();
	for (const [k, f] of confirmations(cmds)) facts.set(k, { ...f, kind: "confirm" });
	for (const f of known) {
		if (typeof f?.literal !== "string") continue;
		const k = factKey(f.detector, f.literal);
		if (f.detector === "learned") {
			const m = matchSignature(digest, f.signature);
			if (m.contradict) facts.set(k, { detector: "learned", literal: f.literal, signature: f.signature, kind: "contradict" });
			else if (m.confirm) facts.set(k, { detector: "learned", literal: f.literal, signature: f.signature, kind: "confirm" });
			continue;
		}
		if (!DETECTORS.includes(f.detector)) continue;
		if (contradicts(cmds, f)) facts.set(k, { detector: f.detector, literal: f.literal, kind: "contradict" });
		// Reuse confirms only command_repair, as in v1; the newer repairs count a reused fix as `prevented` (outcomes).
		else if (!facts.has(k) && f.detector === "command_repair" && ranFix(cmds, f)) facts.set(k, { detector: f.detector, literal: f.literal, kind: "confirm" });
	}
	const observations = [];
	for (const [fact_key, f] of [...facts].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const { label, statement } = describe(f.detector, f.literal, f.signature);
		const s = clip(statement, DETECT_LIMITS.statement);
		if (acceptable(f.literal, s, f.detector)) observations.push({ fact_key, kind: f.kind, detector: f.detector, statement: s, literal: f.literal, label });
	}
	const kept = observations.slice(0, DETECT_LIMITS.max);
	return { observations: kept, fired: kept.filter((o) => o.kind === "confirm").map((o) => o.fact_key), labels: [...labelsOf(cmds)].sort() };
}

/**
 * What happened this session to each fact injected at its start: `fired` when its failure recurred, `prevented` when its trigger was
 * exercised (its family label ran) or its fix ran and the failure did not recur, else `unexercised`. Input order is kept.
 * @param {{ commands: object[] }} digest
 * @param {{ fact_key?: string, detector: string, literal: string, signature?: object }[]} injected
 * @returns {{ kind: "fact", fact_key: string, outcome: "fired" | "prevented" | "unexercised" }[]}
 */
export function outcomes(digest, injected) {
	const cmds = Array.isArray(digest?.commands) ? digest.commands : [], labels = labelsOf(cmds);
	const out = [];
	for (const f of Array.isArray(injected) ? injected : []) {
		if (typeof f?.literal !== "string" || !(DETECTORS.includes(f.detector) || (f.detector === "learned" && validSignature(f.signature)))) continue;
		const fact_key = typeof f.fact_key === "string" ? f.fact_key : factKey(f.detector, f.literal);
		const m = f.detector === "learned" ? matchSignature(digest, f.signature) : null;
		const fired = m ? m.confirm : recurred(cmds, f);
		const exercised = labels.has(describe(f.detector, f.literal, f.signature).label) || (m ? m.fixed : ranFix(cmds, f));
		out.push({ kind: "fact", fact_key, outcome: fired ? "fired" : exercised ? "prevented" : "unexercised" });
	}
	return out;
}

/**
 * The session report's command counts over a partition's digest: every command, the failed ones (a recorded nonzero exit), and the
 * failed ones whose (failing head, first error line) already failed earlier in the session.
 * @returns {{ total: number, failed: number, repeated_failures: number }}
 */
export function commandCounts(digest) {
	const cmds = Array.isArray(digest?.commands) ? digest.commands : [], seen = new Set();
	let failed = 0, repeated = 0;
	for (const c of cmds) {
		if (c?.status !== "failed" || typeof c.cmd !== "string") continue;
		failed++;
		const steps = stepsOf(c.cmd), head = failingStep(c, steps)?.head ?? steps.map((s) => s.head).join(" && ");
		const k = `${head}\n${c.err?.[0] ?? ""}`;
		if (seen.has(k)) repeated++;
		else seen.add(k);
	}
	return { total: cmds.length, failed, repeated_failures: repeated };
}
