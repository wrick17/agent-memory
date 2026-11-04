/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// `agent-memory backfill [--client claude-code|codex] [--since 30d]` (LO1). Writes trigger files for every transcript in the client
// stores whose cursor is behind; the normal run drains them within LIMITS. Reads no transcript text. Stub from L0.

/**
 * @param {{ client?: "claude-code" | "codex", sinceMs?: number, now?: number, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ queued: number, current: number, warning: string | null }}
 */
export function backfill({ client, sinceMs, now = Date.now(), env = process.env } = {}) {
	throw new Error("not_implemented:LO1");
}

/** Prints how many transcripts it queued, and Claude Code's cleanupPeriodDays warning. Resolves to the exit code. */
export async function main(argv, prog = "agent-memory backfill") {
	process.stderr.write(`${prog}: not implemented yet\n`);
	return 1;
}
