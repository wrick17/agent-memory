// Private default inventory validation shared by the native client and acquisition. No reader or credential dispatch.
import { createHash } from "node:crypto";
export function canonicalJson(value) { return JSON.stringify(sortKeys(value)); }
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, sortKeys(value[k])]));
	return value;
}
const C = canonicalJson, sha = (s) => createHash("sha256").update(s).digest("hex"), H = (v) => sha(C(v));
const need = (ok) => { if (!ok) throw new Error("daily_inventory_invalid"); };
const closed = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === fields.split(" ").sort().join();
const hex = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const name = /^[a-z0-9][a-z0-9_.-]{0,38}$/, repo = /^[a-z0-9][\w.-]*\/[\w.-]+$/;
export function inventoryScope(value, { origin, profile, context } = {}) {
	const url = new URL(origin); need(url.protocol === "https:" && url.origin === origin);
	need(closed(value, "scope scope_hash") && hex(value.scope_hash) && H(value.scope) === value.scope_hash);
	const s = value.scope;
	need(closed(s, "version origin profile generation device_id utc_day issued_at policy_version github jira") && s.version === 1 && s.origin === origin && s.profile === profile && profile !== "me"
		&& typeof s.generation === "string" && s.generation.length > 0 && typeof s.device_id === "string" && s.device_id.length > 0 && hex(s.policy_version)
		&& typeof s.issued_at === "string" && new Date(s.issued_at).toISOString() === s.issued_at && s.utc_day === s.issued_at.slice(0, 10)
		&& s.jira === (profile === "work" ? "assigned-open" : null) && Array.isArray(s.github) && s.github.length > 0 && s.github.length <= 64);
	if (context) need(["profile", "generation", "device_id", "utc_day"].every((k) => s[k] === context[k]));
	let last = "";
	for (const x of s.github) {
		need(closed(x, "kind name") && typeof x.name === "string" && (x.kind === "owner" ? name.test(x.name) : x.kind === "repo" && repo.test(x.name) && !/\.git$|\.$/.test(x.name)));
		const key = `${x.kind}:${x.name}`; need(key > last); last = key;
		if (x.kind === "repo") need(!s.github.some((o) => o.kind === "owner" && o.name === x.name.split("/")[0]));
	}
	return JSON.parse(C(s));
}

export function inventoryRequest(operation, namespace, after = null) {
	need(after === null || (typeof after === "string" && /^[\x20-\x7e]{1,1024}$/.test(after)));
	if (operation === "identity") { need(after === null); return { login_argv: ["api", "user", "--hostname", "github.com", "--jq", ".login"], identity_argv: ["api", "user", "--hostname", "github.com", "--include", "--jq", "{id,node_id,login}"] }; }
	need(operation === "ownerRepos" ? name.test(namespace) : operation === "repoOpen" && repo.test(namespace));
	const query = inventoryQueries[operation === "ownerRepos" ? "OWNER_REPOS" : "REPO_OPEN"];
	const args = ["api", "graphql", "--hostname", "github.com", "--include", "-f", `query=${query}`];
	if (operation === "ownerRepos") args.push("-f", `owner=${namespace}`);
	else { const [org, repoName] = namespace.split("/"); args.push("-f", `org=${org}`, "-f", `name=${repoName}`); }
	if (after !== null) args.push("-f", `after=${after}`);
	return args;
}

/** Re-sync and validate the frozen chain before native plan authority or provider replay. */
export function inventoryResolution(disk, active) {
	const b = active.binding, prefix = `${b.day}.${b.claim_id}/`, read = (n) => disk.read(prefix + n);
	const scopeText = read("inventory.scope.json"), scope = inventoryScope({ scope: JSON.parse(scopeText), scope_hash: active.inventory.scope_sha256 }, { origin: active.origin, profile: b.profile });
	need(C(scope) === scopeText && scope.generation === b.generation && scope.device_id === b.device_id && scope.utc_day === b.day && scope.issued_at === active.as_of);
	const context = { version: 1, binding: b, origin: active.origin, scope_sha256: H(scope), as_of: active.as_of, reader_policy: 1 };
	need(read("inventory.context.json") === C(context));
	const eofText = read("inventory.eof.json"), eof = JSON.parse(eofText), sourcesText = read("inventory.sources.json"), sources = JSON.parse(sourcesText);
	need(C(eof) === eofText && closed(eof, "version binding origin scope_sha256 as_of reader_policy principals page_sha256 selected")
		&& eof.version === 1 && C(eof.binding) === C(b) && eof.origin === active.origin && eof.scope_sha256 === H(scope) && eof.as_of === active.as_of && eof.reader_policy === 1
		&& Array.isArray(eof.page_sha256) && eof.page_sha256.length <= 256 && Array.isArray(eof.principals) && Array.isArray(eof.selected));
	let previous = null, calls = 0, candidates = 0;
	const rows = new Map(), principals = new Map(), connections = new Map(), identities = new Set(), expectedRepos = new Map(), repoIds = new Set();
	for (const s of scope.github) if (s.kind === "repo") expectedRepos.set(s.name, null);
	for (const [ordinal, digest] of eof.page_sha256.entries()) {
		const intentText = read(`inventory.intent-${ordinal}.json`), intent = JSON.parse(intentText), pageText = read(`inventory.page-${ordinal}.json`), page = JSON.parse(pageText);
		need(hex(digest) && sha(pageText) === digest && C(page) === pageText && C(intent) === intentText
			&& closed(intent, "version context_sha256 ordinal reader principal_sha256 operation args previous_page_sha256") && intent.version === 1 && intent.context_sha256 === H(context)
			&& intent.ordinal === ordinal && intent.reader === "github" && intent.previous_page_sha256 === previous
			&& closed(page, "version context_sha256 intent_sha256 principal connection page observations raw_response_sha256") && page.version === 1 && page.context_sha256 === H(context)
			&& page.intent_sha256 === sha(intentText) && hex(page.raw_response_sha256) && Array.isArray(page.observations));
		const p = page.principal;
		need(closed(p, "version reader account viewer coverage") && p.version === 1 && p.reader === "github" && closed(p.viewer, "id login")
			&& typeof p.account === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(p.account) && p.viewer.login === p.account && typeof p.viewer.id === "string" && p.viewer.id.length > 0 && C(p.coverage) === C({ repo: true, read_org: true, sso: "ok" }));
		const ph = H(p); if (!principals.has(ph)) principals.set(ph, p);
		const conn = page.connection; need(closed(conn, "kind namespace object_id") && typeof conn.object_id === "string");
		const op = intent.operation, pg = page.page;
		need(C(intent.args) === C(inventoryRequest(op, conn.namespace, op === "identity" ? null : pg.after)));
		if (op === "identity") {
			need(conn.kind === "github-identity" && conn.namespace === p.account && conn.object_id === p.viewer.id && intent.principal_sha256 === null && page.observations.length === 0 && C(pg) === C({ identity_sha256: ph })); calls += 2; identities.add(ph);
		} else {
			need(identities.has(ph) && intent.principal_sha256 === ph && closed(pg, "after endCursor hasNextPage totalCount members") && typeof pg.hasNextPage === "boolean" && Number.isSafeInteger(pg.totalCount) && pg.totalCount >= 0 && Array.isArray(pg.members) && pg.members.length <= 50); calls++;
			need(op === "ownerRepos" ? scope.github.some((s) => s.kind === "owner" && s.name === conn.namespace) : expectedRepos.has(conn.namespace));
			if (op === "repoOpen") { const id = expectedRepos.get(conn.namespace); if (id) need(id === conn.object_id); else { need(!repoIds.has(conn.object_id)); repoIds.add(conn.object_id); expectedRepos.set(conn.namespace, conn.object_id); } }
			const key = `${ph}:${conn.kind}:${conn.namespace}`, prior = connections.get(key);
			need(conn.kind === (op === "ownerRepos" ? "github-repositories" : "github-open-prs") && (prior ? prior.next !== null && pg.after === prior.next && prior.count === pg.totalCount && prior.id === conn.object_id : pg.after === null));
			const ids = prior?.ids ?? new Set(), keys = prior?.keys ?? new Set();
			for (const m of pg.members) {
				need(typeof m.id === "string" && m.id.length > 0 && !ids.has(m.id)); ids.add(m.id); const k = op === "ownerRepos" ? m.name : m.number; need(!keys.has(k)); keys.add(k);
				if (op === "ownerRepos") {
					need(closed(m, "id name owner_id owner_login viewer_permission") && repo.test(m.name) && m.name.split("/")[0] === conn.namespace && m.owner_id === conn.object_id && m.owner_login === conn.namespace && ["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(m.viewer_permission) && !expectedRepos.has(m.name) && !repoIds.has(m.id));
					expectedRepos.set(m.name, m.id); repoIds.add(m.id);
				} else {
					need(closed(m, "id number created_at updated_at author requested_users request_count request_eof selected") && Number.isSafeInteger(m.number) && m.number > 0 && typeof m.selected === "boolean" && typeof m.request_eof === "boolean"
						&& new Date(m.updated_at).toISOString() === m.updated_at && m.updated_at <= active.as_of && new Date(m.created_at).toISOString() === m.created_at && m.created_at <= m.updated_at && Array.isArray(m.requested_users));
					const positive = m.author?.kind === "User" && m.author.id === p.viewer.id || m.requested_users.some((u) => u.id === p.viewer.id);
					need(!!positive === m.selected && (positive || m.author !== null && m.request_eof));
				}
			}
			if (pg.hasNextPage) need(typeof pg.endCursor === "string" && pg.endCursor !== pg.after && pg.members.length > 0);
			else need(ids.size === pg.totalCount);
			connections.set(key, { id: conn.object_id, count: pg.totalCount, ids, keys, next: pg.hasNextPage ? pg.endCursor : null, namespace: conn.namespace, kind: conn.kind });
			if (op === "repoOpen") {
				candidates += pg.members.length;
				need(page.observations.length === pg.members.filter((m) => m.selected === true).length);
				const held = rows.get(conn.namespace) ?? { principal_sha256: ph, requested: [], rows: [] }; need(held.principal_sha256 === ph);
				for (const r of page.observations) { need(pg.members.some((m) => m.selected === true && m.number === r.number)); held.requested.push(r.number); held.rows.push(r); }
				rows.set(conn.namespace, held);
			}
		}
		previous = digest;
	}
	need(calls <= 256 && candidates <= 10000 && expectedRepos.size <= 64 && C([...principals.keys()]) === C(eof.principals) && [...connections.values()].every((c) => c.next === null));
	for (const s of scope.github) need(s.kind === "repo" || [...connections.values()].some((c) => c.kind === "github-repositories" && c.namespace === s.name));
	need(rows.size === expectedRepos.size && [...expectedRepos.keys()].every((n) => rows.has(n)));
	const selected = [...rows].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([namespace, v]) => {
		v.rows.sort((a, b) => String(a.number) < String(b.number) ? -1 : String(a.number) > String(b.number) ? 1 : 0); v.requested = v.rows.map((r) => r.number);
		return { kind: "pr", namespace, principal_sha256: v.principal_sha256, requested: v.requested, observations_sha256: H(v.rows) };
	});
	need(C(selected) === C(eof.selected) && selected.length <= 64 && b.profile !== "work");
	const declarations = selected.map((s) => ({ source_id: H({ kind: s.kind, namespace: s.namespace }), kind: s.kind, namespace: s.namespace,
		selector_hash: H({ version: 1, policy: "default-open-v1", scope_sha256: H(scope), eof_sha256: sha(eofText), kind: s.kind, namespace: s.namespace, principal_sha256: s.principal_sha256 }) })).sort((a, b) => a.source_id < b.source_id ? -1 : 1);
	need(C(sources) === sourcesText && C(sources) === C({ version: 1, binding: b, origin: active.origin, scope_sha256: H(scope), as_of: active.as_of, eof_sha256: sha(eofText), requiredSources: declarations })
		&& (!active.inventory.sources_sha256 || active.inventory.sources_sha256 === sha(sourcesText)));
	return { requiredSources: declarations, sources_sha256: sha(sourcesText), sources: declarations.map((source) => { const v = rows.get(source.namespace), p = principals.get(v.principal_sha256);
		return { source, account: p.account, owner: p.account, requested: v.requested, rows: v.rows }; }) };
}
export const inventoryQueries = {"OWNER_REPOS": "query DefaultOwnerRepos($owner:String!,$after:String){viewer{id login}repositoryOwner(login:$owner){__typename id login ... on Organization{viewerIsAMember}repositories(first:50,after:$after,ownerAffiliations:[OWNER],orderBy:{field:NAME,direction:ASC}){totalCount nodes{id nameWithOwner owner{id login}viewerPermission}pageInfo{hasNextPage endCursor}}}rateLimit{cost remaining resetAt}}", "REPO_OPEN": "query DefaultRepoOpen($org:String!,$name:String!,$after:String){viewer{id login}repository(owner:$org,name:$name){id nameWithOwner owner{id login}viewerPermission pullRequests(first:50,after:$after,states:[OPEN],orderBy:{field:CREATED_AT,direction:ASC}){totalCount nodes{id createdAt number title state updatedAt headRefName repository { nameWithOwner } author { login __typename }\n reviews(first:100) { nodes { state author { login } } pageInfo { hasNextPage } }\n commits(first:100) { nodes { commit { oid } } pageInfo { hasNextPage } }\n closingIssuesReferences(first:100) { nodes { number url } pageInfo { hasNextPage } }\n reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } pageInfo { hasNextPage } } author{... on User{id}} reviewRequests(first:100){totalCount nodes{requestedReviewer{... on User{id}}}}}pageInfo{hasNextPage endCursor}}}rateLimit{cost remaining resetAt}}"};
