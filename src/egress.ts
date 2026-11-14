// The only module allowed to call fetch(). Its allowlist is the Clerk Frontend API host (section 19), plus, for readable rewrites
// (src/readable.ts), OpenAI's sign-in and API hosts while READABLE_REWRITES=chatgpt-local and the configured rewriter's origin.
const OPENAI_HOSTS = ["auth.openai.com", "api.openai.com"];

export async function egressFetch(env: Env, url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> {
	const target = new URL(url);
	const allowed = [env.CLERK_FRONTEND_API ? new URL(env.CLERK_FRONTEND_API).host : "", ...(env.READABLE_REWRITES === "chatgpt-local" ? OPENAI_HOSTS : [])].filter(Boolean);
	// The rewriter is https, except a rewriter on this machine's loopback for a local run.
	const rewriter = env.READABLE_REWRITER_URL ? new URL(env.READABLE_REWRITER_URL) : null;
	const toRewriter = !!rewriter && target.origin === rewriter.origin && (rewriter.protocol === "https:" || (rewriter.protocol === "http:" && rewriter.hostname === "127.0.0.1"));
	if (!toRewriter && (target.protocol !== "https:" || !allowed.includes(target.host))) throw new Error(`egress to ${target.host} is not allowed`);
	// Workers rejects redirect: "error"; "manual" returns any 3xx unfollowed, and it is refused here so no other host is reached.
	const res = await fetch(target.toString(), { ...init, redirect: "manual" });
	if (res.status >= 300 && res.status < 400) {
		await res.body?.cancel();
		throw new Error(`egress refused a redirect (${res.status}) from ${target.host}`);
	}
	return res;
}
