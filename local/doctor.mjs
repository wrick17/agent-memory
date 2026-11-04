/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// `agent-memory doctor` (LO1): the job token file, the read token file when injection is on, the registered hooks, the launchd job,
// the spool and the server's whoami. One line per check, with a fix for each failure. Stub from L0.

/** @typedef {{ id: string, ok: boolean, detail: string, fix: string | null }} Check */

/** @param {{ config: object, server?: object, now?: number }} opts @returns {Promise<Check[]>} */
export async function doctorChecks({ config, server, now = Date.now() } = {}) {
	throw new Error("not_implemented:LO1");
}

/** One line per check: "ok   <id>  <detail>" or "FAIL <id>  <detail> — fix: <fix>". */
export function formatChecks(checks) {
	throw new Error("not_implemented:LO1");
}

/** Resolves to 0 when every check passes, else 1. */
export async function main(argv, prog = "agent-memory doctor") {
	process.stderr.write(`${prog}: not implemented yet\n`);
	return 1;
}
