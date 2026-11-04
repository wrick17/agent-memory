/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// The per-device capture report sent to POST /v1/status at the end of each run (LO1 builds it, C1 sends it). Stub from L0.
// Ids, versions and counts only: no transcript text, path contents or token.

/**
 * @returns {{ device: string | null, clients: Record<string, string>, hooks: string[], inject: boolean, spool_files: number, spool_bytes: number,
 *   oldest_spool_at: string | null, last_digest_at: string | null, refused_since_last: number, launchd_loaded: boolean | null }}
 * @param {{ config: object, now?: number, hooks?: string[], launchdLoaded?: boolean | null }} opts
 */
export function statusReport({ config, now = Date.now(), hooks, launchdLoaded } = {}) {
	throw new Error("not_implemented:LO1");
}

/** Sends the report with the job token; a v1 server's 404 or any failure is returned, never thrown. @returns {Promise<{ status: "sent" | "failed", reason?: string }>} */
export async function reportStatus({ config, server, now = Date.now() } = {}) {
	return { status: "failed", reason: "not_implemented" }; // stub: LO1
}
