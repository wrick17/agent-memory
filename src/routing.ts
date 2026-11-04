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

export type RefreshSelector = { kind: "owner" | "repo"; name: string };

/** Positive inventory only. An unprovable owner-wide first match refuses the whole projection. */
export function refreshSelectors(rules: RoutingRule[], profile: string): Outcome<RefreshSelector[]> {
	const unsupported = () => fail("unavailable", "refresh_scope_unsupported");
	const live = rules.filter((r) => r.enabled && r.profile !== "me").sort((a, b) => a.priority - b.priority);
	const remote = live.filter((r) => r.match === "remote");
	if (live.length > 128 || new Set(remote.map((r) => r.priority)).size !== remote.length) return unsupported();
	const literal = (r: RoutingRule) => {
		const pattern = r.pattern.toLowerCase();
		const m = /^github\.com\/([a-z0-9][\w.-]*)\/(\*|[\w.-]+)$/.exec(pattern);
		if (r.match !== "remote" || !m || normalizeRemote(pattern) !== pattern || /\.$/.test(pattern)) return null;
		return { owner: m[1]!, kind: m[2] === "*" ? "owner" as const : "repo" as const, name: m[2] === "*" ? m[1]! : `${m[1]}/${m[2]}` };
	};
	if (live.some((r) => r.profile === profile && !literal(r))) return unsupported();
	const selected: RefreshSelector[] = [];
	for (const [i, r] of remote.entries()) {
		if (r.profile !== profile) continue;
		const scope = literal(r)!;
		if (scope.kind === "repo") {
			if (matchRule(live, { remote: `github.com/${scope.name}` })?.profile === profile) selected.push({ kind: scope.kind, name: scope.name });
			continue;
		}
		let shadowed = false;
		for (const before of remote.slice(0, i)) {
			const earlier = literal(before);
			if (!earlier) return unsupported();
			if (earlier.owner !== scope.owner) continue;
			if (earlier.kind === "owner") { shadowed = before.profile !== profile; break; }
			if (before.profile !== profile) return unsupported();
		}
		if (!shadowed) selected.push({ kind: scope.kind, name: scope.name });
	}
	const owners = new Set(selected.filter((s) => s.kind === "owner").map((s) => s.name));
	const unique = [...new Map(selected.filter((s) => s.kind === "owner" || !owners.has(s.name.split("/")[0]!)).map((s) => [`${s.kind}:${s.name}`, s])).values()]
		.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return unique.length && unique.length <= 64 ? ok(unique) : unsupported();
}

export interface Route { profile: string; routedBy: string }

/** `known` holds only active profiles; a rule or device default may still name one that is being wiped. */
const inactive = (profile: string, by: string) => fail("profile_wiped", `profile '${profile}' (${by}) is not active`, { profile });

/**
 * Steps 2 to 5 of section 9; step 1 (a bound request_id) is applied by the Worker through AccountStore. An explicit profile is
 * the calling agent's choice (issue #3): only its existence, activity and the caller's scope are checked, never repo or device
 * context. Rules and the device default apply only when profile is omitted, as v1 compatibility, and never pick me.
 */
export function routeWrite(caller: Caller, rules: RoutingRule[], known: string[], input: { profile?: string; repo?: RepoRef }): Outcome<Route> {
	if (input.profile !== undefined) {
		if (!known.includes(input.profile)) return fail("validation", `unknown profile '${input.profile}'`, { known });
		if (!mayUse(caller, input.profile)) return fail("forbidden", `this caller may not use profile '${input.profile}'`);
		return ok({ profile: input.profile, routedBy: "explicit" });
	}
	const rule = matchRule(rules, input.repo);
	const chosen = rule ? { profile: rule.profile, routedBy: `rule:${rule.pattern}` }
		: caller.defaultProfile && caller.defaultProfile !== "me" ? { profile: caller.defaultProfile, routedBy: `device:${caller.deviceName ?? caller.deviceId ?? "default"}` }
			: undefined;
	if (!chosen) return fail("route_required", "no routing rule or device default matched; pass profile explicitly, or repo {remote, path}");
	if (!mayUse(caller, chosen.profile)) return fail("forbidden", `this caller may not use profile '${chosen.profile}' (${chosen.routedBy})`);
	if (!known.includes(chosen.profile)) return inactive(chosen.profile, chosen.routedBy);
	return ok(chosen);
}

/**
 * Reads use the same order to pick the primary profile; with no match they read `me` only. An explicit profile is always the
 * primary. The `me` overlay is additive read compatibility for callers that may read `me`; it never replaces the primary.
 */
export function readSet(caller: Caller, rules: RoutingRule[], known: string[], input: { profile?: string; repo?: RepoRef }): Outcome<ReadSet & { routedBy: string }> {
	const withMe = (primary: string) => primary !== "me" && mayUse(caller, "me") && known.includes("me");
	if (input.profile !== undefined) {
		if (!known.includes(input.profile)) return fail("validation", `unknown profile '${input.profile}'`, { known });
		if (!mayUse(caller, input.profile)) return fail("forbidden", `this caller may not read profile '${input.profile}'`);
		return ok({ primary: input.profile, withMe: withMe(input.profile), routedBy: "explicit" });
	}
	const rule = matchRule(rules, input.repo);
	const primary = rule?.profile ?? (caller.defaultProfile && caller.defaultProfile !== "me" ? caller.defaultProfile : undefined);
	if (primary) {
		if (!mayUse(caller, primary)) return fail("forbidden", `this caller may not read profile '${primary}'`);
		if (!known.includes(primary)) return inactive(primary, rule ? `rule:${rule.pattern}` : "device");
		return ok({ primary, withMe: withMe(primary), routedBy: rule ? `rule:${rule.pattern}` : "device" });
	}
	if (!mayUse(caller, "me")) return fail("route_required", "no routing rule or device default matched; pass profile explicitly");
	if (!known.includes("me")) return inactive("me", "default:me");
	return ok({ primary: "me", withMe: false, routedBy: "default:me" });
}
