// Bounded local Jira ticket metadata (sections 10 and 13, work only). The caller holds the machine lock and supplies the
// authenticated ingest transport and a read-only Jira connector bound to the ~/.claude work account (the jira-connector rule);
// this module never calls Jira, reads a credential, logs in or writes to a ticket.
import { readFileSync, statSync } from "node:fs";
import { redact, writePrivate } from "./agent-memory.mjs";

/** The only account that reaches Jira (jira-connector), and the issue fields the connector is asked for. */
export const JIRA_ACCOUNT = "~/.claude";
export const FIELDS = ["summary", "issuetype", "status", "priority", "duedate", "assignee", "reporter", "updated", "issuelinks"];
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const UPDATED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?)(Z|[+-]\d\d:?\d\d)$/;
/** Tickets per run (section 10), the link count past which a list may be cut, and kept receipts. */
const MAX_KEYS = 20, LINKS = 100, RECENT = 1_000;
// Same personal-value patterns as src/domain/personal.ts, applied before clipping or retaining a payload.
const PERSONAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/g;
const text = (s, max) => redact(s).replace(PERSONAL, "[REDACTED]").slice(0, max);
const id = (t) => `${t.key}@${t.updated_at}`;

/** Jira's updated time, which may carry an offset without a colon (+0530), as UTC; null when it is not one. */
function updatedAt(s) {
	const m = typeof s === "string" ? UPDATED.exec(s) : null;
	const ms = m ? Date.parse(`${m[1]}${m[2] === "Z" ? "Z" : `${m[2].slice(0, 3)}:${m[2].slice(-2)}`}`) : NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One issue from the connector, untrusted, in Jira's REST shape: `{ key, fields: { ... } }`. Key, summary, issue type and updated
 * time are required, or the issue is invalid and not uploaded. Bug maps to bug, Story and Epic to feature, any other type to
 * ticket. A field that is absent or malformed is named in `unknown` and carries no value; null priority, due date or assignee is
 * Jira saying there is none. People are their account ids only: names, emails and avatars never leave this function. Links read
 * from this issue's side: an `outwardIssue` takes the type's outward phrase, an `inwardIssue` its inward phrase, so "is blocked
 * by" gives blocked_by, "blocks" gives blocks, and every other link type is related.
 */
function normalize(issue, owner) {
	const f = issue?.fields;
	if (!issue || typeof issue !== "object" || !KEY.test(issue.key ?? "") || !f || typeof f !== "object" || typeof f.summary !== "string" ||
		typeof f.issuetype?.name !== "string" || !f.issuetype.name.trim() || !updatedAt(f.updated)) return null;
	const unknown = new Set(), type = f.issuetype.name.trim().toLowerCase();
	const out = { key: issue.key, kind: type === "bug" ? "bug" : type === "story" || type === "epic" ? "feature" : "ticket", type: text(f.issuetype.name.trim(), 64),
		title: text(f.summary, 280), updated_at: updatedAt(f.updated), blocked_by: [], blocks: [], related: [] };
	const category = f.status?.statusCategory?.key;
	if (typeof f.status?.name === "string" && ["new", "indeterminate", "done"].includes(category)) Object.assign(out, { state: category === "done" ? "closed" : "open", status: text(f.status.name, 64) });
	else unknown.add("status");
	if (f.priority === null) { /* no priority */ } else if (typeof f.priority?.name === "string" && f.priority.name.trim()) out.priority = text(f.priority.name.trim(), 64);
	else unknown.add("priority");
	if (f.duedate === null) { /* no due date */ } else if (typeof f.duedate === "string" && /^\d{4}-\d\d-\d\d$/.test(f.duedate) && new Date(`${f.duedate}T00:00:00Z`).toISOString().startsWith(f.duedate)) out.due = f.duedate;
	else unknown.add("due");
	for (const field of ["assignee", "reporter"]) {
		const who = f[field];
		if (who === null) { if (field === "assignee") out.assignee_is_owner = false; }
		else if (typeof who?.accountId === "string" && ACCOUNT.test(who.accountId)) {
			out[field] = who.accountId;
			if (field === "assignee") out.assignee_is_owner = who.accountId === owner;
		} else unknown.add(field);
	}
	if (!Array.isArray(f.issuelinks)) unknown.add("issuelinks");
	else {
		if (f.issuelinks.length >= LINKS) unknown.add("issuelinks");
		for (const l of f.issuelinks) {
			const side = l?.outwardIssue ? "outward" : l?.inwardIssue ? "inward" : null, other = side && l[`${side}Issue`]?.key, phrase = side && l.type?.[side];
			if (!side || (l.outwardIssue && l.inwardIssue) || !KEY.test(other ?? "") || other === issue.key || typeof phrase !== "string") { unknown.add("issuelinks"); continue; }
			const rel = phrase.trim().toLowerCase();
			out[rel === "is blocked by" ? "blocked_by" : rel === "blocks" ? "blocks" : "related"].push(other);
		}
	}
	for (const k of ["blocked_by", "blocks", "related"]) out[k] = [...new Set(out[k])].sort();
	out.unknown = [...unknown].sort();
	return out;
}

/** Reads and validates the connector's answer for `keys`: `{ issues: [...] }`. Anything else refuses the whole read. */
async function collect(connector, keys, owner) {
	let raw;
	try { raw = await connector.read({ keys, fields: FIELDS }); }
	catch { throw new Error("jira_connector_unavailable"); }
	if (typeof raw !== "string" || Buffer.byteLength(raw) > 2_000_000) throw new Error("jira_metadata_too_large");
	let body;
	try { body = JSON.parse(raw); } catch { throw new Error("invalid_jira_metadata"); }
	if (!body || typeof body !== "object" || !Array.isArray(body.issues) || body.issues.length > keys.length) throw new Error("invalid_jira_metadata");
	const tickets = [], invalid = [], seen = new Set();
	for (const issue of body.issues) {
		const t = normalize(issue, owner), key = typeof issue?.key === "string" && KEY.test(issue.key) ? issue.key : null;
		if (key && (!keys.includes(key) || seen.has(key))) throw new Error("invalid_jira_metadata");
		if (key) seen.add(key);
		if (t) tickets.push(t); else if (key) invalid.push(key); else throw new Error("invalid_jira_metadata");
	}
	return { tickets, invalid, missing: keys.filter((k) => !seen.has(k)) };
}

/**
 * Uploads the snapshots of the tickets named in `keys` (from digests, branches, commits and PR titles; at most 20) to the work
 * profile through the same job ingest as commits and PRs. A pending request from an earlier run is sent first, byte for byte,
 * until its receipt is exact; then this run's tickets are read, their exact redacted body kept before it is sent, and replayed
 * on a lost response or refusal. A ticket whose acknowledged snapshot is unchanged is not sent again. Tickets the connector
 * could not read in full are uploaded with what is known and reported in `incomplete`; ones it did not return are `missing`,
 * and malformed ones `invalid`, neither uploaded. `connector` is `{ account: "~/.claude", readOnly: true, read({ keys, fields }) }`
 * and `ownerAccountId` is the owner's own Jira account id, used only for assignee_is_owner.
 */
export async function uploadTickets({ keys, stateFile, connector, ownerAccountId, send, now = () => new Date().toISOString() }) {
	if (!Array.isArray(keys) || !keys.length || keys.length > MAX_KEYS || !keys.every((k) => typeof k === "string" && KEY.test(k)) || new Set(keys).size !== keys.length) throw new Error("invalid_ticket_keys");
	if (typeof ownerAccountId !== "string" || !ACCOUNT.test(ownerAccountId)) throw new Error("owner_account_required");
	if (!connector || connector.account !== JIRA_ACCOUNT || connector.readOnly !== true || typeof connector.read !== "function") throw new Error("jira_connector_unbound");
	let state;
	try {
		if (statSync(stateFile).size > 1_000_000) throw new Error("invalid_ticket_state");
		state = JSON.parse(readFileSync(stateFile, "utf8"));
	} catch (e) { if (e.code !== "ENOENT") throw new Error("invalid_ticket_state"); state = { profile: "work" }; }
	if (!state || typeof state !== "object" || state.profile !== "work" || (state.recent !== undefined && !(Array.isArray(state.recent) && state.recent.length <= RECENT && state.recent.every((r) => typeof r === "string"))) ||
		(state.pending !== undefined && (typeof state.pending?.body !== "string" || typeof state.pending.as_of !== "string"))) throw new Error("invalid_ticket_state");
	if(state.incomplete!==undefined&&(!Array.isArray(state.incomplete)||state.incomplete.length>RECENT||!state.incomplete.every(h=>KEY.test(h.split("@")[0])&&updatedAt(h.slice(h.indexOf("@")+1))))) throw new Error("invalid_ticket_state");
 const deliver = async () => {
		const body = JSON.parse(state.pending.body);
		if (body.profile !== "work" || body.as_of !== state.pending.as_of || !Array.isArray(body.tickets)) throw new Error("invalid_ticket_state");
		let receipt;
		try { receipt = await send(body); } catch { return "upload_failed"; }
		const held = receipt?.profile === "work" && receipt.tickets?.length === body.tickets.length && receipt.tickets.every((r, n) => r?.key === `jira:${body.tickets[n].key}` &&
			r.updated_at === body.tickets[n].updated_at && ["stored", "replayed", "stale", "flagged"].includes(r.status));
		if (!held) return "not_acknowledged";
		const incomplete=new Map((state.incomplete??[]).map(h=>[h.split("@")[0],h]));
  for(const t of body.tickets) {
   const old=incomplete.get(t.key);
   if(old&&old.slice(old.indexOf("@")+1)>t.updated_at) continue;
   if(t.unknown.length) {incomplete.delete(t.key);incomplete.set(t.key,id(t));}else incomplete.delete(t.key);
  }
  if(incomplete.size>RECENT) throw new Error("ticket_incomplete_limit");
  state = { profile: "work", incomplete:[...incomplete.values()], recent: [...new Set([...(state.recent ?? []), ...body.tickets.filter(t=>!t.unknown.length).map(id)])].slice(-RECENT) };
		writePrivate(stateFile, JSON.stringify(state));
		return null;
	};
	if (state.pending) {
		const reason = await deliver();
		if (reason) return { status: "pending", reason };
	}
	const asOf = new Date(now()).toISOString();
	const retry=(state.incomplete??[]).slice(0,MAX_KEYS).map(h=>h.split("@")[0]);
 const requested=[...new Set([...retry,...keys])];
 const read={tickets:[],invalid:[],missing:[]};
 for(let i=0;i<requested.length;i+=MAX_KEYS) {const part=await collect(connector,requested.slice(i,i+MAX_KEYS),ownerAccountId);for(const k of Object.keys(read)) read[k].push(...part[k]);}
	const recent = new Set(state.recent ?? []), tickets = read.tickets.filter((t) => !recent.has(id(t)) || (state.incomplete??[]).some(h=>h.split("@")[0]===t.key));
	const unresolved=new Map((state.incomplete??[]).map(h=>[h.split("@")[0],h]));
 for(const t of read.tickets) {
  const old=unresolved.get(t.key);
  if(old&&old.slice(old.indexOf("@")+1)>t.updated_at) continue;
  if(t.unknown.length) unresolved.set(t.key,id(t));else unresolved.delete(t.key);
 }
 if(unresolved.size>RECENT) throw new Error("ticket_incomplete_limit");
 const report = { incomplete: [...unresolved.keys()].map(k=>`jira:${k}`), missing: read.missing, invalid: read.invalid };
	for(let offset=0;offset<tickets.length;offset+=MAX_KEYS) {
		const body = JSON.stringify({ profile: "work", as_of: asOf, tickets:tickets.slice(offset,offset+MAX_KEYS) });
		if (Buffer.byteLength(body) > 900_000) throw new Error("ticket_payload_too_large");
		state = { ...state, pending: { as_of: asOf, body } };
		writePrivate(stateFile, JSON.stringify(state));
		const reason = await deliver();
		if (reason) return { status: "pending", reason, ...report };
	}
	const attempted=new Set(retry);
 state.incomplete=[...(state.incomplete??[]).filter(h=>!attempted.has(h.split("@")[0])),...(state.incomplete??[]).filter(h=>attempted.has(h.split("@")[0]))];
 writePrivate(stateFile,JSON.stringify(state));
 return { status: "acknowledged", tickets: tickets.length, ...report };
}

// Pure metadata preparation for selected observations; missing/invalid keys remain the caller's read disposition.
export { normalize as prepareTicketObservation };
