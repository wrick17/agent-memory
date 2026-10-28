// The only module allowed to call fetch(). Its allowlist is the Clerk Frontend API host (section 19).
export async function egressFetch(env: Env, url: string): Promise<Response> {
	const target = new URL(url);
	const allowed = env.CLERK_FRONTEND_API ? new URL(env.CLERK_FRONTEND_API).host : "";
	if (!allowed || target.protocol !== "https:" || target.host !== allowed) throw new Error(`egress to ${target.host} is not allowed`);
	// Workers rejects redirect: "error"; "manual" returns any 3xx unfollowed, and it is refused here so no other host is reached.
	const res = await fetch(target.toString(), { redirect: "manual" });
	if (res.status >= 300 && res.status < 400) {
		await res.body?.cancel();
		throw new Error(`egress refused a redirect (${res.status}) from ${target.host}`);
	}
	return res;
}
