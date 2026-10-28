// The only module allowed to call fetch(). Its allowlist is the Clerk Frontend API host (section 19).
export async function egressFetch(env: Env, url: string): Promise<Response> {
	const target = new URL(url);
	const allowed = env.CLERK_FRONTEND_API ? new URL(env.CLERK_FRONTEND_API).host : "";
	if (!allowed || target.protocol !== "https:" || target.host !== allowed) throw new Error(`egress to ${target.host} is not allowed`);
	return fetch(target.toString(), { redirect: "error" });
}
