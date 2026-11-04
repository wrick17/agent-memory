/* eslint-disable @typescript-eslint/no-unused-vars -- L0 stub: the parameters are the contract; the wave 1 owner removes this line with the stub bodies. */
// `agent-memory replay [--session ID] [--list] [--port 0]` (RP1). Loopback only on a random port, a 32-byte URL token, Host and
// Origin checks, Content-Security-Policy: default-src 'self'. Stub from L0.

/**
 * Whether a request may be served: its token, Host and Origin (when sent) must match this server.
 * @param {{ url: string, headers: Record<string, string | undefined> }} req @param {{ token: string, port: number }} server
 */
export function allowRequest(req, { token, port }) {
	return false; // stub: RP1 (refuse everything until implemented)
}

/**
 * Starts the viewer on 127.0.0.1. @param {{ session?: string, port?: number }} opts
 * @returns {Promise<{ url: string, port: number, close(): Promise<void> }>} url carries the token
 */
export async function startReplay({ session, port = 0 } = {}) {
	throw new Error("not_implemented:RP1");
}

/** Resolves to the exit code; with --list prints local sessions, otherwise prints the URL and serves until interrupted. */
export async function main(argv, prog = "agent-memory replay") {
	process.stderr.write(`${prog}: not implemented yet\n`);
	return 1;
}
