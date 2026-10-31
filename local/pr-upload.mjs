// Bounded local PR metadata (sections 10 and 13). The caller holds the machine lock and supplies the authenticated ingest
// transport and an account-bound gh executor, normally ghReader(repo); nothing here switches a shared gh account.
import fs from "node:fs";
import { dailyStorage } from "./daily-refresh.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { assertMachineLock, redact, writePrivate } from "./agent-memory.mjs";

import { canonicalJson as C, inventoryScope, inventoryRequest } from "./daily-inventory.mjs";

// Explicit metadata only: gh's canned reviews/commits selections also fetch bodies and contact data.
const FIELDS = `number title state updatedAt headRefName repository { nameWithOwner } author { login __typename }
 reviews(first:100) { nodes { state author { login } } pageInfo { hasNextPage } }
 commits(first:100) { nodes { commit { oid } } pageInfo { hasNextPage } }
 closingIssuesReferences(first:100) { nodes { number url } pageInfo { hasNextPage } }
 reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } pageInfo { hasNextPage } }`;
const SEARCH_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest {${FIELDS}}}}}`;
const PR_QUERY = `query($org:String!,$name:String!,$number:Int!){repository(owner:$org,name:$name){pullRequest(number:$number){${FIELDS}}}}`;
async function graphql(gh, query, variables) {
 let raw;
 try { raw=await gh.run(["api","graphql","--hostname","github.com","-f",`query=${query}`,...Object.entries(variables).flatMap(([k,v])=>[typeof v==="number"?"-F":"-f",`${k}=${v}`])]); }
 catch(e) {throw new Error(e?.message==="gh_account_mismatch"?e.message:"pr_collection_unavailable");}
 if(typeof raw!=="string"||Buffer.byteLength(raw)>8_000_000) throw new Error("pr_collection_too_large");
 let body;try {body=JSON.parse(raw);}catch {throw new Error("invalid_pr_metadata");}
 if(body.errors?.length||!body.data) throw new Error("pr_collection_unavailable");
 return body.data;
}
function fromGraphql(r,repo,owner) {
 if(r?.repository?.nameWithOwner?.toLowerCase()!==repo) throw new Error("invalid_pr_metadata");
 const flat={...r,author:r.author?{...r.author,is_bot:r.author.__typename==="Bot"}:null,_unknown:[]};
 for(const field of ["reviews","commits","closingIssuesReferences","reviewRequests"]) {
  const c=r[field];
  flat[field]=Array.isArray(c?.nodes)?c.nodes.map(n=>field==="commits"?n?.commit:field==="reviewRequests"?n?.requestedReviewer:n):null;
  if(c?.pageInfo?.hasNextPage!==false) flat._unknown.push(field);
 }
 return normalize(flat,owner);
}
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPO = /^[a-z0-9][\w.-]*\/[\w.-]+$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
/** gh page size, PRs per ingest request, the length at which gh may have cut a nested list, the cursor's look-back, kept receipts. */
const PAGE = 50, BATCH = 25, NESTED = 100, OVERLAP_MS = 15 * 60_000, RECENT = 1_000;
// Same personal-value patterns as src/domain/personal.ts, applied before clipping or retaining a payload.
const PERSONAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/g;
const text = (s) => redact(s).replace(PERSONAL, "[REDACTED]").slice(0, 280);
const iso = (s) => {
	if (typeof s !== "string" || !ISO.test(s) || !Number.isFinite(Date.parse(s))) throw new Error("invalid_pr_date");
	return new Date(s).toISOString();
};
// Window bounds are whole seconds, the precision of GitHub's search qualifiers and of updatedAt.
const second = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const search = (s) => `${s.slice(0, 19)}Z`;
const id = (pr) => `${pr.number}@${pr.updated_at}`;

/** The github-accounts mapping: repos owned by Sequoia-Engineering, Sequoia-US or pratyush-poddar_seq use that work account, every other repo wrick17. */
export function accountFor(repo) {
	return ["sequoia-engineering", "sequoia-us", "pratyush-poddar_seq"].includes(repo.split("/")[0]) ? "pratyush-poddar_seq" : "wrick17";
}

// Fixed error only: a child error carries its command line and output.
const execGh = (bin, args, env) => new Promise((resolve, reject) => execFile(bin, args, { env, encoding: "utf8", timeout: 60_000, maxBuffer: 16_000_000 },
	(e, out) => (e ? reject(new Error("gh_failed")) : resolve(out))));

/**
 * The gh executor uploadPRs takes, bound to accountFor(repo) without switching gh's shared active account. Before its first
 * query it reads that account's stored token (`gh auth token --user`) and checks that GitHub names the same login for it; every
 * query then runs with that token in the child's environment alone. Ambient GH_ and GITHUB_ variables other than GH_CONFIG_DIR
 * are dropped, so no other token, host or debug output applies. A failed check fails every query; the token stays in this closure.
 * Its login is the account, so the caller passes `ownerLogin: gh.account`. Only explicit GraphQL reads run.
 */
export function ghReader(repo, { bin = "gh", env = process.env, exec = execGh, inventory, io = fs, server } = {}) {
	if (inventory !== undefined) return inventoryReader(repo, { bin, env, exec, io, server }, inventory);
	const { account, base, token } = ghCredentials(repo, { bin, env, exec });
	return { account, run: async (args) => {
		if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("gh_read_only");
		const argv = [...args];
		const prefix = ["api", "graphql", "--hostname", "github.com", "-f"].every((a, i) => argv[i] === a);
		const search = argv.length === 8 && argv[5] === `query=${SEARCH_QUERY}` && argv[6] === "-f" && argv[7].startsWith("q=");
		const retry = argv.length === 12 && argv[5] === `query=${PR_QUERY}` && argv[6] === "-f" && argv[7].startsWith("org=") &&
			argv[8] === "-f" && argv[9].startsWith("name=") && argv[10] === "-F" && /^number=[1-9]\d*$/.test(argv[11]);
		if (!prefix || (!search && !retry)) throw new Error("gh_read_only");
		return exec(bin, argv, { ...base, GH_TOKEN: await token() });
	} };
}

/**
 * One PR metadata row from the explicit GraphQL selection, untrusted. Handles are validated GitHub logins and SHAs full; a bot author, a pending review and a team
 * review request name no person. A list gh may have cut (NESTED long) or a malformed entry keeps what is valid and names the
 * field in `unknown`, so the server never treats it as complete. review_requested_from_owner is set only from a direct request.
 */
function normalize(r, owner) {
	if (!r || typeof r !== "object" || !Number.isSafeInteger(r.number) || r.number < 1 || typeof r.title !== "string" || typeof r.headRefName !== "string" ||
		!["OPEN", "CLOSED", "MERGED"].includes(r.state)) throw new Error("invalid_pr_metadata");
	const unknown = new Set(r._unknown??[]), handle = (a) => (a && typeof a.login === "string" && LOGIN.test(a.login) ? a.login.toLowerCase() : undefined);
	const list = (field, each) => {
		if (!Array.isArray(r[field])) { unknown.add(field); return []; }
		if (r[field].length >= NESTED) unknown.add(field);
		return r[field].flatMap((v) => { const out = each(v); if (out === undefined) unknown.add(field); return out ?? []; });
	};
	const author = r.author?.is_bot === true ? undefined : handle(r.author);
	if (!author && r.author?.is_bot !== true) unknown.add("author");
	const reviewers = list("reviews", (v) => (v?.state === "PENDING" ? [] : typeof v?.state === "string" && handle(v.author) ? [handle(v.author)] : undefined));
	const commits = list("commits", (v) => (typeof v?.oid === "string" && /^[0-9a-f]{40}$/i.test(v.oid) ? [v.oid.toLowerCase()] : undefined));
	const closes = list("closingIssuesReferences", (v) => {
		const m = typeof v?.url === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9][\w.-]*\/[\w.-]+)\/issues\/([1-9]\d{0,9})$/.exec(v.url) : null;
		return m && v.number === Number(m[2]) ? [`github:${m[1].toLowerCase()}#${m[2]}`] : undefined;
	});
	const requested = list("reviewRequests", (v) => (handle(v) ? [handle(v)] : v?.__typename === "Team" ? [] : undefined));
	return { number: r.number, title: text(r.title), state: r.state === "OPEN" ? "open" : "closed", updated_at: iso(r.updatedAt), head: text(r.headRefName),
		...(author ? { author } : {}), reviewers: [...new Set(reviewers)].sort(), commits: [...new Set(commits)].sort(), closes: [...new Set(closes)].sort(),
		unknown: [...unknown].sort(), ...(unknown.has("reviewRequests") ? {} : { review_requested_from_owner: requested.includes(owner) }) };
}

/**
 * One gh page of PRs updated in [from, to], oldest update first, so the next page starts at the last one's updated_at. A full
 * page out of order, or one whose every row shares the lower bound, cannot be paged without loss: refused, nothing advances.
 */
async function collectPage(gh, repo, from, to, owner) {
 const data=await graphql(gh,SEARCH_QUERY,{q:`repo:${repo} is:pr updated:${search(from)}..${search(to)} sort:updated-asc`});
 const rows=data.search?.nodes;
 if(!Array.isArray(rows)||rows.length>PAGE) throw new Error("invalid_pr_metadata");
 const all=rows.map(r=>fromGraphql(r,repo,owner));
	if (new Set(all.map(id)).size !== all.length) throw new Error("duplicate_pr_metadata");
	// A row outside the window was or will be read by the window that holds it.
	const prs = all.filter((p) => p.updated_at >= from && p.updated_at <= to);
	if (all.length < PAGE) return { prs };
	if (all.some((p, i) => i && p.updated_at < all[i - 1].updated_at)) throw new Error("pr_order_unverified");
	const last = all.at(-1).updated_at;
	if (last <= from || last > to) throw new Error("pr_collection_limit");
	return { prs, next: { at: last, skip: all.filter((p) => p.updated_at === last).map(id) } };
}

const strings = (v, max = RECENT) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
function validState(s, repo, profile) {
	const time = (v) => typeof v === "string" && ISO.test(v), p = s?.pending;
	return !!s && typeof s === "object" && !Array.isArray(s) && s.repo === repo && s.profile === profile && (s.cursor === undefined || time(s.cursor)) &&
		(s.recent === undefined || strings(s.recent)) && (s.incomplete===undefined || (strings(s.incomplete)&&s.incomplete.every(h=>/^[1-9]\d*@/.test(h)))) &&
		(!p || (time(p.from) && time(p.to) && time(p.at) && p.from <= p.at && p.at <= p.to && strings(p.requests, PAGE) && (p.skip === undefined || strings(p.skip, PAGE)) &&
			Number.isSafeInteger(p.sent) && p.sent >= 0 && p.sent <= p.requests.length && Number.isSafeInteger(p.total) && p.total >= 0 && strings(p.held) && strings(p.incomplete) &&
			(p.next === undefined || (time(p.next.at) && p.next.at > p.at && p.next.at <= p.to && strings(p.next.skip, PAGE)))));
}

/** Collects the pending window's next page and persists its exact request bodies before any is sent. */
async function fillPage(state, stateFile, gh, owner) {
	const p = state.pending, seen = new Set([...(state.recent ?? []), ...(p.skip ?? [])]);
	const page = await collectPage(gh, state.repo, p.at, p.to, owner);
	const retry=[];
 if(p.at===p.from) {
  const [org,name]=state.repo.split("/");
  for(const h of (state.incomplete??[]).slice(0,BATCH)) {
   const number=Number(h.slice(0,h.indexOf("@")));
   if(page.prs.some(pr=>pr.number===number)) continue;
   const data=await graphql(gh,PR_QUERY,{org,name,number});
   if(data.repository?.pullRequest) {const pr=fromGraphql(data.repository.pullRequest,state.repo,owner);if(pr.updated_at<=p.to)retry.push(pr);}
  }
 }
 const unresolved=new Set((state.incomplete??[]).map(h=>Number(h.slice(0,h.indexOf("@")))));
 const prs = [...page.prs,...retry].filter((pr) => !seen.has(id(pr))||unresolved.has(pr.number)), requests = [];
	for (let i = 0; i < prs.length; i += BATCH) {
		const body = JSON.stringify({ profile: state.profile, repo: { remote: `https://github.com/${state.repo}.git` }, as_of: p.to, prs: prs.slice(i, i + BATCH) });
		if (Buffer.byteLength(body) > 900_000) throw new Error("pr_payload_too_large");
		requests.push(body);
	}
	// A last page leaves next undefined, which JSON drops.
	state.pending = { ...p, requests, sent: 0, next: page.next, ...(p.at===p.from?{retried:(state.incomplete??[]).slice(0,BATCH)}:{}) };
	writePrivate(stateFile, JSON.stringify(state));
}

/**
 * Uploads every PR updated since the cursor (or `since`) up to now, one gh page per call, through the same job ingest as
 * commits. Exact redacted request bytes are kept before the first send and replayed until each item is acknowledged, so a
 * lost response or refusal resends the same bytes. The cursor is separate from the commit marker and advances only after
 * every page is held, to the window's end less a look-back for gh search lag and clock skew; receipts in the look-back skip
 * replays of complete rows. Incomplete identities persist separately and retry outside the lookback; missing retries stay reported.
 * `gh` is `{ account, run(args) }`, bound by the caller to the account github-accounts names for this repo, and `ownerLogin`
 * is the owner's GitHub login for that account, used only to set review_requested_from_owner.
 */
export async function uploadPRs({ repo, profile, since, stateFile, gh, ownerLogin, send, now = () => new Date().toISOString() }) {
	if (typeof repo !== "string" || !REPO.test(repo)) throw new Error("invalid_pr_repo");
	if (typeof profile !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(profile) || profile === "me") throw new Error("invalid_profile");
	if (typeof ownerLogin !== "string" || !LOGIN.test(ownerLogin)) throw new Error("owner_login_required");
	if (!gh || typeof gh.run !== "function" || gh.account !== accountFor(repo)) throw new Error("gh_account_mismatch");
	let state;
	try {
		if (statSync(stateFile).size > 1_000_000) throw new Error("invalid_pr_state");
		state = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch (e) { if (e.code !== "ENOENT") throw new Error("invalid_pr_state"); state = { repo, profile }; }
	if (!validState(state, repo, profile)) throw new Error(state?.repo === repo && state?.profile === profile ? "invalid_pr_state" : "pr_state_context");
	const owner = ownerLogin.toLowerCase();
	if (!state.pending) {
		const from = state.cursor ?? second(Date.parse(iso(since))), to = second(Date.parse(iso(now())));
		if (from > to) throw new Error("invalid_pr_window");
		state.pending = { from, to, at: from, requests: [], sent: 0, total: 0, held: [], incomplete: [] };
		await fillPage(state, stateFile, gh, owner);
	} else if (state.pending.sent === state.pending.requests.length && state.pending.next) {
		state.pending = { ...state.pending, at: state.pending.next.at, skip: state.pending.next.skip };
		await fillPage(state, stateFile, gh, owner);
	}
	const p = state.pending;
	for (let i = p.sent; i < p.requests.length; i++) {
		const body = JSON.parse(p.requests[i]);
  if(new Set([...(state.incomplete??[]).map(h=>h.split("@")[0]),...body.prs.filter(pr=>pr.unknown.length).map(pr=>String(pr.number))]).size>RECENT) throw new Error("pr_incomplete_limit");
		if (body.profile !== profile || body.repo?.remote !== `https://github.com/${repo}.git` || body.as_of !== p.to || !Array.isArray(body.prs)) throw new Error("invalid_pr_state");
		let receipt;
		try { receipt = await send(body); } catch { return { status: "pending", reason: "upload_failed" }; }
		const acknowledged = receipt?.profile === profile && receipt.prs?.length === body.prs.length && receipt.prs.every((r, n) => r?.key === `github:${repo}#${body.prs[n].number}` &&
			r.updated_at === body.prs[n].updated_at && ["stored", "replayed", "stale", "flagged"].includes(r.status));
		if (!acknowledged) return { status: "pending", reason: "not_acknowledged" };
		p.sent = i + 1; p.total += body.prs.length;
		p.held = [...p.held, ...body.prs.filter(pr=>!pr.unknown.length).map(id)].slice(-RECENT);
  const unresolved=new Map((state.incomplete??[]).map(h=>[Number(h.slice(0,h.indexOf("@"))),h]));
  for(const pr of body.prs) {
   const old=unresolved.get(pr.number);
   if(old && old.slice(old.indexOf("@")+1)>pr.updated_at) continue;
   if(pr.unknown.length) {unresolved.delete(pr.number);unresolved.set(pr.number,id(pr));}else unresolved.delete(pr.number);
  }
  if(unresolved.size>RECENT) throw new Error("pr_incomplete_limit");
  state.incomplete=[...unresolved.values()];
		p.incomplete = [...p.incomplete, ...body.prs.filter((pr) => pr.unknown.length).map((pr) => `github:${repo}#${pr.number}`)].slice(-RECENT);
		writePrivate(stateFile, JSON.stringify(state));
	}
	if (p.next) return { status: "pending", reason: "more_prs" };
	const cursor = second(Math.max(Date.parse(p.from), Date.parse(p.to) - OVERLAP_MS));
	const recent = [...new Set([...(state.recent ?? []), ...p.held])].filter((h) => h.slice(h.indexOf("@") + 1) >= cursor).slice(-RECENT);
	const attempted=new Set((p.retried??[]).map(h=>h.split("@")[0]));
 const unresolved=state.incomplete??[];
 const incomplete=[...unresolved.filter(h=>!attempted.has(h.split("@")[0])),...unresolved.filter(h=>attempted.has(h.split("@")[0]))];
 writePrivate(stateFile, JSON.stringify({ repo, profile, cursor, recent, incomplete }));
	return { status: "acknowledged", prs: p.total, incomplete: (state.incomplete??[]).map(h=>`github:${repo}#${h.slice(0,h.indexOf("@"))}`) };
}

// Pure metadata preparation for selected observations; no read, send or ordinary cursor change.
export { fromGraphql as preparePRObservation };

function ghCredentials(repo, { bin, env, exec }) {
	const account = accountFor(repo), base = Object.fromEntries(Object.entries(env).filter(([k]) => k === "GH_CONFIG_DIR" || !/^(GH|GITHUB)_/.test(k)));
	let verified;
	const token = () => (verified ??= (async () => {
		const t = String(await exec(bin, ["auth", "token", "--hostname", "github.com", "--user", account], base)).trim();
		if (!/^\S{1,4096}$/.test(t)) throw new Error("gh_failed");
		const login = String(await exec(bin, ["api", "user", "--hostname", "github.com", "--jq", ".login"], { ...base, GH_TOKEN: t })).trim();
		if (login.toLowerCase() !== account.toLowerCase()) throw new Error("gh_account_mismatch");
		return t;
	})());
	return { account, base, token };
}

// A separate closed mode: ordinary run/query guards above stay exact.
function inventoryReader(selectorName, options, inventory) {
	const fail = () => { throw new Error("gh_inventory_unavailable"); }, need = (v) => { if (!v) fail(); };
	const closed = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === fields.split(" ").sort().join();
	need(closed(inventory, "scope binding as_of selector claim_body claim_receipt"));
	const hash = Hash;
	const ctx = JSON.parse(C(inventory)), { scope, binding, as_of, selector, claim_body, claim_receipt } = ctx;
	const guard = () => {
		assertMachineLock(); need(closed(binding, "profile generation device_id day claim_id") && /^[0-9a-f]{32}$/.test(binding.claim_id)); need(closed(ctx, "scope binding as_of selector claim_body claim_receipt"));
		inventoryScope({ scope, scope_hash: hash(C(scope)) }, { profile: binding.profile, origin: scope.origin });
		need(C(selector) === C(scope.github.find((x) => x.name === selectorName)) && C(selector) === C(scope.github.find((x) => C(x) === C(selector)))
			&& scope.profile === binding.profile && scope.device_id === binding.device_id && scope.generation === binding.generation && scope.utc_day === binding.day && scope.issued_at === as_of);
		const disk = dailyStorage(options.io, scope.origin, binding.profile), active = disk.load().attempt;
		need(active && active.inventory && active.phase === "acquire" && active.plan === null && C(active.binding) === C(binding) && active.origin === scope.origin && active.as_of === as_of && active.inventory.scope_sha256 === hash(C(scope)));
		const prefix = `${active.name}/`;
		need(disk.read(prefix + "inventory.scope.json") === C(scope) && disk.read(prefix + "claim.body") === claim_body && disk.read(prefix + "claim.receipt.json") === C(claim_receipt));
		const body = JSON.parse(claim_body), p = claim_receipt?.proof;
		need(closed(body, "profile day claim_id request_id") && /^[0-9a-f]{32}$/.test(body.request_id) && closed(claim_receipt, "proof receipt_hash") && C(p) === C({ version: 1, operation: "claim", binding, request_id: body.request_id, body_sha256: hash(claim_body), manifest_hash: null, outcome: null })
			&& claim_receipt.receipt_hash === hash(C(p)) && body.profile === binding.profile && body.day === binding.day && body.claim_id === binding.claim_id);
	};
	const authority = async () => {
		guard(); need(options.server && typeof options.server.refresh === "function");
		const markers = await options.server.refresh("markers", { profile: binding.profile, refresh_scope: "1" });
		guard();
		if (!markers.refresh_context || markers.profile !== binding.profile) throw new Error("daily_inventory_binding");
		const fresh = inventoryScope(markers.refresh_scope, { origin: scope.origin, profile: binding.profile, context: markers.refresh_context });
		if (!["origin", "profile", "generation", "device_id", "policy_version"].every((k) => fresh[k] === scope[k]) || C(fresh.github) !== C(scope.github) || fresh.jira !== scope.jira) throw new Error("daily_inventory_binding");
	};
	guard(); let loginHash;
	// Inventory-only wrapper fences the helper's login read after its token await, and every later API read.
	const credentials = { ...options, exec: async (bin, args, env) => {
		await authority(); guard();
		const raw = await options.exec(bin, args, env); guard();
		if (C(args) === C(inventoryRequest("identity", "").login_argv)) loginHash = hash(raw);
		return raw;
	} };
	const { account, base, token } = ghCredentials(selectorName, credentials);
	let principal = null; const connections = new Map(), repositories = new Map();
	const http = (raw) => {
		need(typeof raw === "string" && Buffer.byteLength(raw) <= 8000000);
		const split = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n", at = raw.indexOf(split); need(at > 0);
		const header = raw.slice(0, at).split(/\r?\n/); need(/^HTTP\/\S+ 2\d\d(?: |$)/.test(header.shift()));
		const headers = {};
		for (const line of header) { const colon = line.indexOf(":"); need(colon > 0); const key = line.slice(0, colon).toLowerCase(); need(!Object.hasOwn(headers, key)); headers[key] = line.slice(colon + 1).trim(); }
		need(!headers["x-github-sso"]); const body = JSON.parse(raw.slice(at + split.length));
		return { body, headers };
	};
	const node = (v) => typeof v === "string" && /^[A-Za-z0-9_:=.-]{1,256}$/.test(v);
	const login = (v) => typeof v === "string" && LOGIN.test(v);
	const permission = (v) => ["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(v);
	return { account, defaultPage: async (input) => {
		// Reject the complete operation shape before token lookup, including unretained cursors.
		guard(); need(closed(input, "operation namespace after"));
		const request = JSON.parse(C(input)), { operation, namespace, after } = request;
		need(operation === "identity" ? namespace === account && after === null && principal === null
			: principal && (operation === "ownerRepos" ? selector.kind === "owner" && namespace === selector.name : operation === "repoOpen" && (selector.kind === "repo" ? namespace === selector.name : repositories.has(namespace))));
		const key = `${operation}:${namespace}`, previous = connections.get(key);
		if (operation !== "identity") need(previous ? previous.next !== null && after === previous.next : after === null);
		const args = inventoryRequest(operation, namespace, after), snap = JSON.parse(C(args));
		try {
			const t = await token(); guard();
			const raw = await credentials.exec(options.bin, operation === "identity" ? snap.identity_argv : snap, { ...base, GH_TOKEN: t }); guard();
			const { body, headers } = http(raw);
			if (operation === "identity") {
				const scopes = headers["x-oauth-scopes"]?.split(",").map((s) => s.trim());
				need(Array.isArray(scopes) && scopes.includes("repo") && scopes.some((s) => ["read:org", "write:org", "admin:org"].includes(s))
					&& Number.isSafeInteger(body.id) && body.id > 0 && node(body.node_id) && login(body.login) && body.login.toLowerCase() === account.toLowerCase());
				principal = { version: 1, reader: "github", account, viewer: { id: body.node_id, login: account }, coverage: { repo: true, read_org: true, sso: "ok" } };
				// The login probe is exactly account + newline; credentials already checked it. No token/header is retained.
				return { principal, connection: { kind: "github-identity", namespace: account, object_id: principal.viewer.id }, page: { identity_sha256: hash(C(principal)) }, observations: [],
					raw_response_sha256: hash(C([loginHash, hash(raw)])) };
			}
			need((body.errors === undefined || Array.isArray(body.errors) && body.errors.length === 0) && body.data && body.data.viewer?.id === principal.viewer.id && body.data.viewer.login?.toLowerCase() === account);
			const ownerPage = operation === "ownerRepos", obj = ownerPage ? body.data.repositoryOwner : body.data.repository;
			need(obj && node(obj.id));
			if (ownerPage) need(obj.login?.toLowerCase() === namespace && (obj.__typename === "User" ? obj.id === principal.viewer.id && obj.login.toLowerCase() === account : obj.__typename === "Organization" && obj.viewerIsAMember === true));
			else need(obj.nameWithOwner?.toLowerCase() === namespace && node(obj.owner?.id) && obj.owner.login?.toLowerCase() === namespace.split("/")[0] && permission(obj.viewerPermission)
				&& (!repositories.has(namespace) || repositories.get(namespace).id === obj.id && repositories.get(namespace).owner_id === obj.owner.id));
			if (!ownerPage && !repositories.has(namespace)) repositories.set(namespace, { id: obj.id, owner_id: obj.owner.id });
			const connection = obj[ownerPage ? "repositories" : "pullRequests"], info = connection?.pageInfo;
			need(connection && Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0 && Array.isArray(connection.nodes) && connection.nodes.length <= 50 && typeof info?.hasNextPage === "boolean" && (info.endCursor == null || typeof info.endCursor === "string" && /^[\x20-\x7e]{1,1024}$/.test(info.endCursor)));
			const state = previous ?? { id: obj.id, count: connection.totalCount, ids: [], keys: [], cursors: [], next: null };
			need(state.id === obj.id && state.count === connection.totalCount);
			const members = [], observations = [];
			for (const r of connection.nodes) {
				need(r && node(r.id) && !state.ids.includes(r.id)); let member;
				if (ownerPage) {
					const n = r.nameWithOwner?.toLowerCase(); need(typeof n === "string" && REPO.test(n) && n.split("/")[0] === namespace && r.owner?.id === obj.id && r.owner.login?.toLowerCase() === namespace && permission(r.viewerPermission) && !state.keys.includes(n));
					member = { id: r.id, name: n, owner_id: obj.id, owner_login: namespace, viewer_permission: r.viewerPermission }; repositories.set(n, member);
				} else {
					need(Number.isSafeInteger(r.number) && r.number > 0 && !state.keys.includes(r.number) && r.state === "OPEN" && r.repository?.nameWithOwner?.toLowerCase() === namespace);
					const updated_at = iso(r.updatedAt), created_at = iso(r.createdAt); need(updated_at <= as_of && created_at <= updated_at);
					const author = r.author; need(author === null || (login(author?.login) && (author.__typename === "Bot" || author.__typename === "User" && node(author.id))));
					if (author?.__typename === "User") need((author.id === principal.viewer.id) === (author.login.toLowerCase() === account));
					const req = r.reviewRequests; need(Array.isArray(req?.nodes) && req.nodes.length <= 100 && Number.isSafeInteger(req.totalCount) && req.totalCount >= req.nodes.length && typeof req.pageInfo?.hasNextPage === "boolean");
					if (!req.pageInfo.hasNextPage) need(req.totalCount === req.nodes.length);
					const users = []; for (const n of req.nodes) { const v = n?.requestedReviewer; need(v && ["User", "Bot", "Team"].includes(v.__typename)); if (v.__typename === "User") { need(node(v.id) && login(v.login) && ((v.id === principal.viewer.id) === (v.login.toLowerCase() === account))); users.push({ id: v.id, login: v.login.toLowerCase() }); } }
					const positive = author?.__typename === "User" && author.id === principal.viewer.id || users.some((u) => u.id === principal.viewer.id);
					const eof = req.pageInfo.hasNextPage === false && req.nodes.length === req.totalCount && req.nodes.length < 100;
					need(positive || author !== null && eof);
					member = { id: r.id, number: r.number, created_at, updated_at, author: author === null ? null : { kind: author.__typename, id: author.id ?? null, login: author.login.toLowerCase() }, requested_users: users,
						request_count: req.totalCount, request_eof: eof, selected: !!positive };
					if (positive) {
						// Project only the fixed metadata selection. Redact before retention, but clip only in the original normalizer.
						const keep = { number: r.number, title: r.title, state: r.state, updatedAt: r.updatedAt, headRefName: r.headRefName, repository: { nameWithOwner: namespace }, author: author && { login: author.login, __typename: author.__typename } };
						for (const f of ["reviews", "commits", "closingIssuesReferences", "reviewRequests"]) {
							const c = r[f]; keep[f] = { nodes: Array.isArray(c?.nodes) ? c.nodes.map((n) => f === "reviews" ? { state: n?.state, author: n?.author && { login: n.author.login } } : f === "commits" ? { commit: { oid: n?.commit?.oid } } : f === "closingIssuesReferences" ? { number: n?.number, url: n?.url } : { requestedReviewer: n?.requestedReviewer && { __typename: n.requestedReviewer.__typename, login: n.requestedReviewer.login } }) : null, pageInfo: { hasNextPage: c?.pageInfo?.hasNextPage } };
						}
						const scrub = (v) => typeof v === "string" ? redact(v).replace(PERSONAL, "[REDACTED]") : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, scrub(val)])) : v;
						const safe = scrub(keep); need(C(fromGraphql(safe, namespace, account)) === C(fromGraphql(r, namespace, account))); observations.push(safe);
					}
				}
				state.ids.push(r.id); state.keys.push(ownerPage ? member.name : member.number); members.push(member);
			}
			need(state.ids.length <= connection.totalCount);
			if (info.hasNextPage) need(members.length > 0 && typeof info.endCursor === "string" && /^[\x20-\x7e]{1,1024}$/.test(info.endCursor) && !state.cursors.includes(info.endCursor));
			else need(state.ids.length === connection.totalCount);
			state.next = info.hasNextPage ? info.endCursor : null; if (state.next) state.cursors.push(state.next); connections.set(key, state);
			return { principal, connection: { kind: ownerPage ? "github-repositories" : "github-open-prs", namespace, object_id: obj.id },
				page: { after, endCursor: info.endCursor ?? null, hasNextPage: info.hasNextPage, totalCount: connection.totalCount, members }, observations, raw_response_sha256: hash(raw) };
		} catch (e) { if (["daily_inventory_binding", "refresh_lock_required"].includes(e?.message)) throw e; return fail(); }
	} };
}

function Hash(s) { return createHash("sha256").update(s).digest("hex"); }
