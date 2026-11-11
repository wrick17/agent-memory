// The per-device capture report sent to POST /v1/status at the end of each run (LO1 builds it, C1 sends it).
// Ids, versions and counts only: no transcript text, path contents, session ids or token.
import fs from "node:fs";
import path from "node:path";
import { captureSummary, hookEvents, home } from "./agent-memory.mjs";
import { launchdLabel, launchdLoaded as loadedCheck } from "./launchd.mjs";

// The server's allowlist (src/client-status.ts). The loop guard's PostToolUse and PostToolUseFailure are not on it, so the
// report leaves them out; doctor checks them locally.
const HOOKS = new Set(["Stop", "SessionEnd", "SessionStart", "PreCompact", "UserPromptSubmit"]);

/** The spool's file count, bytes and oldest file time. The spool holds digests and manifests only; none of it is read here. */
export function spoolStats() {
	const dir = path.join(home(), "spool");
	let files = 0, bytes = 0, oldest = Infinity;
	for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
		try {
			const st = fs.statSync(path.join(dir, f));
			files++; bytes += st.size;
			if (st.mtimeMs < oldest) oldest = st.mtimeMs;
		} catch { /* removed meanwhile */ }
	}
	return { files, bytes, oldest_at: oldest < Infinity ? new Date(oldest).toISOString() : null };
}

/**
 * The report body for the H1 schema. `device` is left out: the server takes it from the job token. launchd_loaded is false off
 * macOS or when launchd cannot tell, because the schema takes a boolean only.
 * @returns {{ clients: Record<string, string>, hooks: string[], inject: boolean, spool_files: number, spool_bytes: number,
 *   oldest_spool_at: string | null, last_digest_at: string | null, refused_since_last: number, launchd_loaded: boolean,
 *   pending_ranges: number, stuck_ranges: number, oldest_pending_at: string | null, missing_sources: number }}
 * @param {{ config: object, hooks?: string[], launchdLoaded?: boolean | null }} opts
 */
export function statusReport({ config, hooks, launchdLoaded } = {}) {
	const s = captureSummary(), spool = spoolStats();
	const loaded = launchdLoaded === undefined ? loadedCheck(launchdLabel(home())) : launchdLoaded;
	return {
		clients: s.clients,
		hooks: [...new Set((hooks ?? hookEvents(config)).filter((h) => HOOKS.has(h)))],
		inject: config?.inject?.enabled === true,
		spool_files: spool.files, spool_bytes: spool.bytes, oldest_spool_at: spool.oldest_at,
		last_digest_at: s.last_digest_at, refused_since_last: s.refused_since_last, launchd_loaded: loaded === true,
		pending_ranges: s.pending_ranges, stuck_ranges: s.stuck_ranges, oldest_pending_at: s.oldest_pending_at, missing_sources: s.missing_sources,
	};
}

/** Sends the report with the job token; a v1 server's 404 or any failure is returned, never thrown. @returns {Promise<{ status: "sent" | "failed", reason?: string }>} */
export async function reportStatus({ config, server } = {}) {
	if (typeof server?.status !== "function") return { status: "failed", reason: "no_status_route" };
	let body;
	try { body = statusReport({ config }); } catch { return { status: "failed", reason: "report_unreadable" }; }
	try {
		await server.status(body);
		return { status: "sent" };
	} catch (e) {
		return { status: "failed", reason: Number.isInteger(e?.status) ? `http_${e.status}` : "unreachable" };
	}
}
