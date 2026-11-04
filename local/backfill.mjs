// `agent-memory backfill [--client claude-code|codex] [--since 30d]` (LO1). Writes trigger files for every transcript in the client
// stores whose cursor is behind; the normal run drains them within LIMITS. It reads no message text: only file sizes, the
// cursor check's prefix hash, and the session's cwd field for routing when this machine has no state for the session yet.
import fs from "node:fs";
import path from "node:path";
import { clientHome, prefixHash, queueTrigger, readJson, statePath } from "./agent-memory.mjs";

const CLIENTS = ["claude-code", "codex"];
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const CODEX_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const HEAD_BYTES = 65_536;

/** Each retained transcript in the client's store with its session id, as findTranscript would find it again. */
function transcripts(client, root) {
	const out = [];
	const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
	if (client === "claude-code") {
		// projects/<project>/<session>.jsonl; subagent transcripts sit one level deeper and belong to their parent session.
		for (const p of list(path.join(root, "projects"))) {
			if (!p.isDirectory()) continue;
			for (const f of list(path.join(root, "projects", p.name))) {
				const session = f.name.endsWith(".jsonl") ? f.name.slice(0, -6) : "";
				if (f.isFile() && SESSION.test(session)) out.push({ session, file: path.join(root, "projects", p.name, f.name) });
			}
		}
		return out;
	}
	// sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
	const walk = (dir, depth) => {
		for (const e of list(dir)) {
			const p = path.join(dir, e.name);
			if (e.isDirectory() && depth > 0) walk(p, depth - 1);
			else if (e.isFile() && e.name.startsWith("rollout-")) { const id = CODEX_ID.exec(e.name)?.[1]; if (id) out.push({ session: id, file: p }); }
		}
	};
	walk(path.join(root, "sessions"), 4);
	return out;
}

/** The session's working directory from its first lines (Claude Code: a top-level cwd; Codex: session_meta). Nothing else is kept. */
function cwdOf(client, file) {
	let head = "";
	try {
		const fd = fs.openSync(file, "r");
		try { const b = Buffer.alloc(HEAD_BYTES); head = b.subarray(0, fs.readSync(fd, b, 0, HEAD_BYTES, 0)).toString("utf8"); } finally { fs.closeSync(fd); }
	} catch { return null; }
	for (const line of head.split("\n").slice(0, -1)) {
		let o;
		try { o = JSON.parse(line); } catch { continue; }
		const cwd = client === "codex" ? (o?.type === "session_meta" ? o.payload?.cwd : undefined) : o?.cwd;
		if (typeof cwd === "string" && path.isAbsolute(cwd) && cwd.length <= 4096) return cwd;
	}
	return null;
}

/** Current when this machine's cursor covers the file and the checked prefix is unchanged; anything else is behind. */
function current(st, file, size) {
	if (!st || st.digested_to !== size || !Number.isInteger(st.prefix_len) || st.prefix_len > size) return false;
	try { return prefixHash(file, st.prefix_len) === st.prefix_hash; } catch { return false; }
}

/** Claude Code's cleanupPeriodDays from its settings (30 by default). */
function cleanupDays(env) {
	const v = readJson(path.join(clientHome("claude-code", env), "settings.json"), null)?.cleanupPeriodDays;
	return Number.isFinite(v) && v >= 0 ? v : 30;
}

/**
 * @param {{ client?: "claude-code" | "codex", sinceMs?: number, now?: number, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ queued: number, current: number, already_queued: number, warning: string | null }}
 */
export function backfill({ client, sinceMs, now = Date.now(), env = process.env } = {}) {
	if (client !== undefined && !CLIENTS.includes(client)) throw new Error("client must be claude-code or codex");
	if (sinceMs !== undefined && !(Number.isFinite(sinceMs) && sinceMs > 0)) throw new Error("since must be a positive duration");
	const cutoff = sinceMs === undefined ? -Infinity : now - sinceMs;
	const out = { queued: 0, current: 0, already_queued: 0, warning: null };
	for (const c of client ? [client] : CLIENTS) {
		const root = clientHome(c, env);
		for (const t of transcripts(c, root)) {
			let st;
			try { st = fs.statSync(t.file); } catch { continue; }
			if (st.mtimeMs < cutoff) continue;
			const state = readJson(statePath(c, t.session), null);
			if (current(state, t.file, st.size)) { out.current++; continue; }
			const cwd = typeof state?.source?.cwd === "string" ? state.source.cwd : cwdOf(c, t.file);
			if (queueTrigger({ client: c, session: t.session, transcript_path: t.file, cwd, client_home: root, event: "backfill" }, { now })) out.queued++;
			else out.already_queued++;
		}
	}
	if (client !== "codex") {
		const days = cleanupDays(env);
		out.warning = `Claude Code deletes transcripts older than cleanupPeriodDays (${days} days in its settings). Backfill can queue only transcripts still on disk; deleted ones cannot be recovered.`;
	}
	return out;
}

const USAGE = (prog) => `usage: ${prog} [--client claude-code|codex] [--since <N>d|<N>h]\n`;

/** Prints how many transcripts it queued, and Claude Code's cleanupPeriodDays warning. Resolves to the exit code. */
export async function main(argv, prog = "agent-memory backfill") {
	let client, sinceMs;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") { process.stdout.write(USAGE(prog)); return 0; }
		if (a === "--client" && CLIENTS.includes(argv[i + 1]) && client === undefined) { client = argv[++i]; continue; }
		const m = a === "--since" && sinceMs === undefined ? /^([1-9]\d{0,4})([dh])$/.exec(argv[i + 1] ?? "") : null;
		if (m) { sinceMs = Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000); i++; continue; }
		process.stderr.write(`${prog}: unexpected ${JSON.stringify(a)}\n${USAGE(prog)}`);
		return 2;
	}
	const r = backfill({ client, sinceMs });
	process.stdout.write(`Queued ${r.queued} transcript${r.queued === 1 ? "" : "s"} for capture (${r.current} already current, ${r.already_queued} already queued).`
		+ (r.queued ? " The next run captures them: a client hook, the daily job, or agent-memory run." : "") + "\n");
	if (r.warning) process.stderr.write(`warning: ${r.warning}\n`);
	return 0;
}
