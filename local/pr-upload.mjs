// Bounded local PR metadata (sections 10 and 13). The caller holds the machine lock and supplies the authenticated ingest
// transport and an account-bound gh executor; this module never runs gh, reads a token or switches a shared gh account.
import { readFileSync, statSync } from "node:fs";
import { redact, writePrivate } from "./agent-memory.mjs";

// Explicit metadata only: gh's canned reviews/commits selections also fetch bodies and contact data.
const FIELDS = `number title state updatedAt headRefName repository { nameWithOwner } author { login __typename }
 reviews(first:100) { nodes { state author { login } } pageInfo { hasNextPage } }
 commits(first:100) { nodes { commit { oid } } pageInfo { hasNextPage } }
 closingIssuesReferences(first:100) { nodes { number url } pageInfo { hasNextPage } }
 reviewRequests(first:100) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } } } pageInfo { hasNextPage } }`;
async function graphql(gh, query, variables) {
 let raw;
 try { raw=await gh.run(["api","graphql","--hostname","github.com","-f",`query=${query}`,...Object.entries(variables).flatMap(([k,v])=>[typeof v==="number"?"-F":"-f",`${k}=${v}`])]); }
 catch {throw new Error("pr_collection_unavailable");}
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
 const data=await graphql(gh,`query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest {${FIELDS}}}}}`,{q:`repo:${repo} is:pr updated:${search(from)}..${search(to)} sort:updated-asc`});
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
   const data=await graphql(gh,`query($org:String!,$name:String!,$number:Int!){repository(owner:$org,name:$name){pullRequest(number:$number){${FIELDS}}}}`,{org,name,number});
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
