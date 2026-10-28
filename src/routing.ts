// The routing decision as pure functions (section 9). AccountStore owns the rules; this owns the order.
import { fail, ok, type Caller, type Outcome, type ReadSet, type RepoRef, type RoutingRule } from "./domain/types";

export function mayUse(caller: Caller, profile: string): boolean {
	return caller.profiles === "*" || caller.profiles.includes(profile);
}

/** `git@github.com:Org/repo.git`, `ssh://git@github.com/Org/repo` and the https form all become `github.com/Org/repo`. */
export function normalizeRemote(remote: string): string {
	let r = remote.trim().replace(/\.git$/, "").replace(/\/+$/, "");
	r = r.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	const scp = /^([^/:]+):(?!\d+\/)(.+)$/.exec(r);
	if (scp) r = `${scp[1]}/${scp[2]}`;
	return r.replace(/^([^/:]+):\d+\//, "$1/").toLowerCase();
}

function globMatch(pattern: string, value: string): boolean {
	const re = pattern.toLowerCase().split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
	return new RegExp(`^${re}$`).test(value);
}

function pathMatch(prefix: string, path: string): boolean {
	const p = prefix.replace(/\/+$/, "");
	return path === p || path.startsWith(`${p}/`);
}

/** The first enabled rule, by priority, that matches the repo: remote globs first, then path prefixes. Never `me`. */
export function matchRule(rules: RoutingRule[], repo?: RepoRef): RoutingRule | undefined {
	if (!repo) return undefined;
	const live = rules.filter((r) => r.enabled && r.profile !== "me").sort((a, b) => a.priority - b.priority);
	const remote = repo.remote ? normalizeRemote(repo.remote) : undefined;
	return (remote ? live.find((r) => r.match === "remote" && globMatch(r.pattern, remote)) : undefined)
		?? (repo.path ? live.find((r) => r.match === "path" && pathMatch(r.pattern, repo.path!)) : undefined);
}

/** The profile the repo or device default points at, ignoring any explicit profile. Used by the `me` guard. */
export function contextProfile(caller: Caller, rules: RoutingRule[], repo?: RepoRef): string | null {
	return matchRule(rules, repo)?.profile ?? caller.defaultProfile ?? null;
}

export interface Route { profile: string; routedBy: string; context: string | null }

/** Steps 2 to 5 of section 9; step 1 (a bound request_id) is applied by the Worker through AccountStore. */
export function routeWrite(caller: Caller, rules: RoutingRule[], known: string[], input: { profile?: string; repo?: RepoRef }): Outcome<Route> {
	const context = contextProfile(caller, rules, input.repo);
	if (input.profile !== undefined) {
		if (!known.includes(input.profile)) return fail("validation", `unknown profile '${input.profile}'`, { known });
		if (!mayUse(caller, input.profile)) return fail("forbidden", `this caller may not use profile '${input.profile}'`);
		return ok({ profile: input.profile, routedBy: "explicit", context });
	}
	const rule = matchRule(rules, input.repo);
	const chosen = rule ? { profile: rule.profile, routedBy: `rule:${rule.pattern}` }
		: caller.defaultProfile && caller.defaultProfile !== "me" ? { profile: caller.defaultProfile, routedBy: `device:${caller.deviceName ?? caller.deviceId ?? "default"}` }
			: undefined;
	if (!chosen) return fail("route_required", "no routing rule or device default matched; pass profile explicitly, or repo {remote, path}");
	if (!mayUse(caller, chosen.profile)) return fail("forbidden", `this caller may not use profile '${chosen.profile}' (${chosen.routedBy})`);
	return ok({ ...chosen, context });
}

/** Reads use the same order to pick the primary profile; with no match they read `me` only. */
export function readSet(caller: Caller, rules: RoutingRule[], known: string[], input: { profile?: string; repo?: RepoRef }): Outcome<ReadSet & { routedBy: string }> {
	const withMe = (primary: string) => primary !== "me" && mayUse(caller, "me");
	if (input.profile !== undefined) {
		if (!known.includes(input.profile)) return fail("validation", `unknown profile '${input.profile}'`, { known });
		if (!mayUse(caller, input.profile)) return fail("forbidden", `this caller may not read profile '${input.profile}'`);
		return ok({ primary: input.profile, withMe: withMe(input.profile), routedBy: "explicit" });
	}
	const rule = matchRule(rules, input.repo);
	const primary = rule?.profile ?? (caller.defaultProfile && caller.defaultProfile !== "me" ? caller.defaultProfile : undefined);
	if (primary) {
		if (!mayUse(caller, primary)) return fail("forbidden", `this caller may not read profile '${primary}'`);
		return ok({ primary, withMe: withMe(primary), routedBy: rule ? `rule:${rule.pattern}` : "device" });
	}
	if (!mayUse(caller, "me")) return fail("route_required", "no routing rule or device default matched; pass profile explicitly");
	return ok({ primary: "me", withMe: false, routedBy: "default:me" });
}
