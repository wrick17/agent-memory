import { edgeIdentity, observeCommit, type CountEdge } from "./work-counts";
import { assertArchiveEndpoints } from "./archive-fence";
// Work uploads (sections 4, 10 and 13): bounded metadata the owner's machines read locally, published through the shared write
// path as actor `index`. The server never calls GitHub or Jira. Commits, PR snapshots and Jira ticket snapshots (work only).
import { knowledgeTerms } from "../domain/guard";
import { canonicalJson, sha256, collapse, normalizeName, requestHash } from "../domain/ids";
import { EMAIL, PHONE } from "../domain/personal";
import { REDACTED, redactText } from "../domain/redact";
import { Fail, RELATION_ENDPOINTS, type CommitUploadArgs, type PRUploadArgs, type TicketUploadArgs, type UploadArgs } from "../domain/types";
import { takeSeq } from "../storage";
import { stampReceipt } from "./daily-proof";
import { linkIdentifiers, resolveMentions, structuralEdges } from "./extract";
import { assertWritable } from "./transfer";
import { assertOpen } from "./wipe";
import { activity, createEntity, entityHashes, knowledgeId, readNode, writeHead, writeRevision, Tx, type Who, type WriteOutput } from "./write";

export const TITLE_MAX = 280;
const PERSONAL = new RegExp(`${EMAIL.source}|${PHONE.source}`, "g");
const clean = (s: string) => redactText(s).replace(PERSONAL, REDACTED);

/** `Org/repo` from a github.com remote in any of its forms, in lowercase; null for any other host. */
export function repoNamespace(remote: string): string | null {
	const r = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "").replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	// The owner and repo patterns of extract.ts, so these keys are the ones identifiers() finds in text.
	const m = /^github\.com(?::\d+)?[:/]([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/i.exec(r);
	const repo = m?.[2]!.replace(/\.+$/, "");
	return m && repo ? `${m[1]}/${repo}`.toLowerCase() : null;
}

export const projectKey = (repo: string) => `github:${repo}`;
export const commitKey = (repo: string, sha: string) => `git:${repo}@${sha.toLowerCase()}`;
export const prKey = (repo: string, number: number) => `github:${repo}#${number}`;
export const ticketKey = (key: string) => `jira:${key}`;
export const uploadKey = (a: UploadArgs) => (a.item === "commit" ? commitKey(a.repo, a.sha) : a.item === "pr" ? prKey(a.repo, a.number) : ticketKey(a.key));
const personKey = (login: string) => `person:github:${login}`;
const handles = (a: { author?: string; reviewers?: string[] }) => [...new Set([...(a.author ? [a.author] : []), ...(a.reviewers ?? [])])];
/** The people an item names, as person nodes: GitHub logins on commits and PRs, Jira account ids on tickets. */
type Named = { author?: string; reviewers?: string[] } | UploadArgs;
function people(a: Named): { key: string; name: string; attrs: Record<string, string> }[] {
	if ("item" in a && a.item === "ticket") return [...new Set([a.assignee, a.reporter].filter((h): h is string => !!h))].map((h) => ({ key: `person:jira:${h}`, name: h, attrs: { jira: h } }));
	return handles(a as { author?: string; reviewers?: string[] }).map((h) => ({ key: personKey(h), name: h, attrs: { github: h } }));
}
/** Keys of every node an item may create or change: its project (commits and PRs), itself and its people. */
export const uploadNodeKeys = (a: UploadArgs) => [...(a.item === "ticket" ? [] : [projectKey(a.repo)]), uploadKey(a), ...people(a).map((p) => p.key)];

/**
 * The commit as it is hashed and stored: secrets redacted and emails and phone numbers replaced before the hash (section 4),
 * the time in UTC, and its natural id as the request id, so the same commit replays and a changed one is refused.
 */
export function commitArgs(repo: string, c: { sha: string; at: string; title: string; author?: string }): CommitUploadArgs {
	const sha = c.sha.toLowerCase();
	return { item: "commit", repo, sha, at: new Date(c.at).toISOString(), title: clean(c.title),
		...(c.author ? { author: c.author.toLowerCase() } : {}), request_id: `upload:${commitKey(repo, sha)}` };
}

/**
 * A PR snapshot as it is hashed and stored, cleaned like a commit, with sorted unique lists and UTC times. Its revision is
 * GitHub's updated_at; differing monotonic enrichments receive separate receipts. `as_of` stays out of the request hash.
 */
export function prArgs(repo: string, p: Omit<PRUploadArgs, "item" | "repo" | "as_of" | "request_id">, asOf: string): PRUploadArgs {
	const set = (v: string[]) => [...new Set(v.map((x) => x.toLowerCase()))].sort();
	const updated = new Date(p.updated_at).toISOString();
	return { item: "pr", repo, number: p.number, title: clean(p.title), state: p.state, updated_at: updated, head: clean(p.head),
		...(p.author ? { author: p.author.toLowerCase() } : {}), reviewers: set(p.reviewers), commits: set(p.commits), closes: set(p.closes), unknown: [...new Set(p.unknown)].sort(),
		...(p.review_requested_from_owner !== undefined ? { review_requested_from_owner: p.review_requested_from_owner } : {}), as_of: new Date(asOf).toISOString(),
		request_id: `upload:${prKey(repo, p.number)}:${updated}` };
}

/**
 * A Jira ticket snapshot as it is hashed and stored, cleaned like a commit, with sorted unique link lists and UTC times. Its
 * revision is Jira's updated time; differing monotonic enrichments receive separate receipts. `as_of` stays out of the hash.
 */
export function ticketArgs(t: Omit<TicketUploadArgs, "item" | "as_of" | "request_id">, asOf: string): TicketUploadArgs {
	const set = (v: string[]) => [...new Set(v)].sort();
	const updated = new Date(t.updated_at).toISOString();
	return { item: "ticket", key: t.key, kind: t.kind, type: clean(t.type), title: clean(t.title), updated_at: updated, ...(t.state ? { state: t.state } : {}),
		...(t.status !== undefined ? { status: clean(t.status) } : {}), ...(t.priority !== undefined ? { priority: clean(t.priority) } : {}), ...(t.due ? { due: t.due } : {}),
		...(t.assignee ? { assignee: t.assignee } : {}), ...(t.reporter ? { reporter: t.reporter } : {}), ...(t.assignee_is_owner !== undefined ? { assignee_is_owner: t.assignee_is_owner } : {}),
		blocked_by: set(t.blocked_by), blocks: set(t.blocks), related: set(t.related), unknown: set(t.unknown), as_of: new Date(asOf).toISOString(),
		request_id: `upload:${ticketKey(t.key)}:${updated}` };
}

/** The request an item is held under, and its hash: a snapshot's revision id, or that id with its hash once another payload holds it. */
export function naturalRequest(sql: SqlStorage, who: Who, a: UploadArgs): { requestId: string; payloadHash: string } {
	const id = `upload:${who.profile}:${uploadKey(a)}${a.item === "commit" ? "" : `:${a.updated_at}`}`;
	// A snapshot's revision is its source's updated time; when it was read stays out of the hash.
	const payloadHash = requestHash(`upload_${a.item}`, a.item === "commit" ? { ...a } : { ...a, as_of: undefined });
	const prior = a.item === "commit" ? undefined : sql.exec<{ payload_hash: string }>("SELECT payload_hash FROM requests WHERE request_id = ?", id).toArray()[0];
	return { requestId: prior && prior.payload_hash !== payloadHash ? `${id}:${payloadHash}` : id, payloadHash };
}

/** Same source revision: known fields must agree; unknown fields may gain knowledge. Old receipts remain unchanged. */
function snapshotRevision(tx: Tx, who: Who, a: { updated_at: string; unknown: string[] }, key: string, fields: Record<string, unknown>) {
 const known = Object.fromEntries(Object.entries(fields).filter(([k]) => !a.unknown.includes(k)).map(([k, v]) => [k, sha256(canonicalJson(v))]));
 const base = `upload:${who.profile}:${key}:${a.updated_at}`;
 const prior = tx.sql.exec<{ result: string }>(`SELECT result FROM requests WHERE request_id = ?1 OR (request_id >= ?2 AND request_id < ?3)
  ORDER BY seq DESC LIMIT 1`, base, `${base}:`, `${base};`).toArray()[0];
 // Queued completion of this source revision must not reverse an owner's undo of any of its receipts.
 if (prior && tx.sql.exec(`SELECT 1 FROM requests r JOIN activity a ON a.id = json_extract(r.result, '$.activity_id')
  WHERE r.op = 'upload' AND a.op = 'upload' AND a.undone_by IS NOT NULL
  AND (r.request_id = ?1 OR (r.request_id >= ?2 AND r.request_id < ?3)) LIMIT 1`, base, `${base}:`, `${base};`).toArray().length) {
  throw Fail.of("idempotency_mismatch", "source revision was undone; same-revision enrichment is refused");
 }
 const old = prior ? (JSON.parse(prior.result) as { snapshot?: { known: Record<string, string>; unknown: string[] } }).snapshot : undefined;
 // This feature is private source only. Historical pre-correction test receipts can replay, but cannot safely enrich.
 if (prior && !old) throw Fail.of("idempotency_mismatch", "legacy snapshot has no known-field receipt");
 for (const [k, v] of Object.entries(known)) {
  if (old?.known[k] && old.known[k] !== v) throw Fail.of("idempotency_mismatch", `known snapshot field '${k}' changed at the same revision`);
 }
 return { known: { ...old?.known, ...known }, unknown: a.unknown.filter(k => !old?.known[k]) };
}

/** The me guard terms a work upload introduces, as record_knowledge's would: the project, each ticket and each person handle. */
export const uploadTerms = (repo: string | null, items: Named[]) => knowledgeTerms([
	...(repo ? [{ kind: "project", name: repo, key: projectKey(repo) }] : []),
	...items.flatMap((a) => ("item" in a && a.item === "ticket" ? [{ kind: a.kind, name: a.title, key: ticketKey(a.key) }] : [])),
	...[...new Map(items.flatMap(people).map((p) => [p.key, p])).values()].map((p) => ({ kind: "person", name: p.name, key: p.key, attrs: p.attrs })),
]);

/** Candidate node ids for the account's wipe ledger: the project (commits and PRs), the item and its people. */
export function uploadIds(who: Who, a: UploadArgs): string[] {
	return [...(a.item === "ticket" ? [] : [["project", projectKey(a.repo)]]), [a.item === "ticket" ? a.kind : a.item, uploadKey(a)], ...people(a).map((p) => ["person", p.key])]
		.map(([kind, key]) => knowledgeId(who, { kind: kind as "project", key: key!, name: key! }));
}

/**
 * The structural relations a snapshot asserts, by direction from its node, each with the source field it comes from. A newer
 * snapshot ends the identifier edges of these it no longer lists, except for a field it names unknown, which says nothing
 * about removal; undo images the same edges to reopen them.
 */
const SNAPSHOT_RELS: Record<"pr" | "ticket", { in: Record<string, string>; out: Record<string, string> }> = {
	pr: { in: { authored: "author", reviewed: "reviews", part_of: "commits" }, out: { fixes: "closingIssuesReferences" } },
	ticket: { in: { assigned: "assignee", reported: "reporter", blocked_by: "issuelinks" }, out: { blocked_by: "issuelinks" } },
};
export function snapshotEdges(sql: SqlStorage, item: "pr" | "ticket", id: string) {
	const r = SNAPSHOT_RELS[item];
	return sql.exec<{ id: number; src: string; rel: string; dst: string }>(`SELECT id, src, rel, dst FROM edges WHERE basis = 'identifier' AND ended_at IS NULL AND dst_profile = ''
		AND ((dst = ?1 AND rel IN (SELECT value FROM json_each(?2))) OR (src = ?1 AND rel IN (SELECT value FROM json_each(?3)))) LIMIT 500`,
	id, JSON.stringify(Object.keys(r.in)), JSON.stringify(Object.keys(r.out))).toArray();
}
/** Ends, as history with valid_to at the snapshot's own time, what the newer snapshot no longer lists. */
function endUnlisted(tx: Tx, item: "pr" | "ticket", id: string, want: Set<string>, unknown: string[], validTo: string): number {
	let ended = 0;
	for (const e of snapshotEdges(tx.sql, item, id)) {
		const field = e.dst === id ? SNAPSHOT_RELS[item].in[e.rel] : SNAPSHOT_RELS[item].out[e.rel];
		if (want.has(`${e.src} ${e.rel} ${e.dst}`) || !field || unknown.includes(field)) continue;
		assertWritable(tx.sql, e.src);
		assertArchiveEndpoints(tx.sql,e.src,e.dst,"");
		ended += tx.run("UPDATE edges SET ended_at = ?, valid_to = ?, seq = ? WHERE id = ?", tx.now, validTo, tx.seq, e.id).rowsWritten ? 1 : 0;
	}
	return ended;
}
/**
 * What a ticket's own uploads last said about one of its Jira blocks links, from `jira_link` evidence on its node: the source
 * time of its newest snapshot that knew its links (ref `issuelinks`) or listed this link (ref `<field> jira:<KEY>`, kept only
 * where no edge could hold the listing: the other ticket was absent or the list partial; null when a complete list superseded it). `listed` when the listing is newer.
 */
function said(sql: SqlStorage, id: string, ref: string): { at: string; listed: boolean } | null {
	let known = "", listed = "";
	for (const r of sql.exec<{ ref: string; note: string | null }>("SELECT ref, note FROM evidence WHERE owner = ? AND kind = 'jira_link' AND ref IN ('issuelinks', ?)", `n:${id}`, ref)) {
		if (r.ref === "issuelinks") known = r.note ?? ""; else listed = r.note ?? "";
	}
	return known || listed ? { at: listed > known ? listed : known, listed: !!listed && listed >= known } : null;
}
const heldNode = (tx: Tx, k: string) => tx.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved' LIMIT 1", k).toArray()[0];
/** The extract rules for a key named without its structured relation: relates_to to a node that has it, else a waiting mention. */
function relateOrWait(tx: Tx, src: string, k: string, held: { id: string } | undefined, validFrom: string): number {
	if (held) return identifierEdge(tx, src, "relates_to", held.id, validFrom);
	tx.run("INSERT OR IGNORE INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'mention', ?, NULL, ?)", `n:${src}`, k, tx.seq);
	return 0;
}

/** The node under `key` (GitHub keys match case-insensitively, the stored bytes stay), created only when absent and never rewritten here. */
function ensure(tx: Tx, who: Who, created: string[], kind: "project" | "person" | "commit" | "pr" | "bug" | "feature" | "ticket", k: string, name: string, attrs: Record<string, unknown>, validFrom?: string): string {
	const cur = tx.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved'", k).toArray()[0];
	if (cur && cur.kind !== kind) throw Fail.of("validation", `key '${k}' belongs to a ${cur.kind} node, not a ${kind}`, { reason: "key_kind_conflict", memory_id: cur.id, kind: cur.kind });
	if (cur) { assertWritable(tx.sql, cur.id); return cur.id; }
	const id = createEntity(tx, who, { kind, key: k, name, ...(validFrom ? { valid_from: validFrom } : {}) }, "upload", { name, scope: "default", description: "", why: null, attrs });
	created.push(id);
	return id;
}

/** One current identifier edge; 1 when it is new. A link belongs to its source, so a source being transferred refuses the item (section 9). */
function identifierEdge(tx: Tx, src: string, rel: string, dst: string, validFrom: string): number {
	assertWritable(tx.sql, src);
	assertArchiveEndpoints(tx.sql,src,dst,"");
	return tx.run(`INSERT OR IGNORE INTO edges (src, rel, dst, dst_profile, basis, valid_from, recorded_at, actor, request_id, seq)
		VALUES (?, ?, ?, '', 'identifier', ?, ?, ?, ?, ?)`, src, rel, dst, validFrom, tx.now, tx.ctx.actor, tx.requestId, tx.seq).rowsWritten ? 1 : 0;
}

/**
 * The `upload` op, inside runWrite's transaction. The project and the author are created only when absent and never rewritten;
 * a node of another kind under one of the keys refuses the item. A new commit gets its title as name, valid_from at the commit
 * time and a revision. Edges have basis identifier: `authored` only from the structured author, `part_of` to the repo, and
 * title mentions through linkIdentifiers, which never gives more than relates_to.
 */
export function upload(tx: Tx, who: Who, a: UploadArgs): WriteOutput {
	if (who.profile === "me") throw Fail.of("forbidden", "uploads never go to me");
	if (a.item === "pr" || a.item === "ticket") {
		const out = a.item === "pr" ? uploadPR(tx, who, a) : uploadTicket(tx, who, a);
		stampReceipt(tx, who, a, out.result);
		return out;
	}
	if (a.item !== "commit") throw Fail.of("validation", `unknown upload item '${String((a as { item: unknown }).item)}'`);
	const key = commitKey(a.repo, a.sha), project = projectKey(a.repo), created: string[] = [];
	const ids = new Map([[project, ensure(tx, who, created, "project", project, a.repo, {})], [key, ensure(tx, who, created, "commit", key, collapse(a.title) || a.sha.slice(0, 7), { repo: a.repo, sha: a.sha }, a.at)]]);
	if (a.author) ids.set(personKey(a.author), ensure(tx, who, created, "person", personKey(a.author), a.author, { github: a.author }));
	const commit = ids.get(key)!;
	let edges = 0;
	const structural: CountEdge[]=[];
	for (const e of structuralEdges({ key, project, ...(a.author ? { author: a.author } : {}) })) {
		const src=ids.get(e.from)!,dst=ids.get(e.to)!;
		const added=identifierEdge(tx,src,e.rel,dst,a.at);edges+=added;
		if(added)structural.push(edgeIdentity(tx.sql.exec<Record<string,SqlStorageValue>>("SELECT * FROM edges WHERE src=? AND rel=? AND dst=? AND dst_profile='' AND ended_at IS NULL",src,e.rel,dst).one()));
	}
	// An existing commit node (written by an agent) keeps its content; only a new one publishes its title's mentions.
	if (created.includes(commit)) linkIdentifiers(tx, commit, a.title);
	// A short SHA may name multiple commits. Keep its mention evidence until a full identity is supplied.
	for (const [k, id] of ids) resolveMentions(tx, id, k);
	const activityId = activity(tx, "upload", `uploaded a commit (new: ${created.length} nodes, ${edges} edges)`, [...new Set(ids.values())]);
	assertArchiveEndpoints(tx.sql,ids.get(personKey(a.author??""))??commit,ids.get(project)!,"");
	tx.commitReceipt=observeCommit(tx,who,a.request_id,a.author?ids.get(personKey(a.author))!:null,ids.get(project)!,a.at,{id:activityId,at:tx.now,seq:tx.seq},structural);
	return { result: { ok: true, action: "stored", memory_id: commit, key, new_nodes: created.length, new_edges: edges, activity_id: activityId, node_ids: [...ids.values()] }, created, embedDue: false };
}

/** The PR attributes an upload owns; every other attribute (an agent's or the owner's priority, due and the rest) is kept. */
const PR_ATTRS = ["repo", "number", "state", "updated_at", "as_of", "head", "review_requested_from_owner", "unknown"];

/**
 * A PR snapshot (section 10's PR item): its natural key plus GitHub's updated_at, and the newer updated_at wins, so an older one
 * is `stale` and changes nothing. The PR node's board attributes (state, review_requested_from_owner) and upload-owned fields are
 * replaced and the rest kept; its name follows the title only while the upload owns the node. Identifier edges come only from
 * structured fields: authored (author), reviewed (reviews), part_of from each listed commit already held with that full SHA,
 * and fixes only from GitHub's closing references to a held bug or ticket. A listed commit or issue not held here, or an issue
 * of another kind, stays a mention under the extract rules (relates_to at most, now or when it arrives); nothing is created for
 * it. Title and branch mentions give relates_to. A protected PR node never gets here as index: runWrite flags it instead.
 */
function uploadPR(tx: Tx, who: Who, a: PRUploadArgs): WriteOutput {
 const snapshot = snapshotRevision(tx, who, a, prKey(a.repo, a.number), {
  title: a.title, state: a.state, head: a.head, author: a.author ?? null, reviews: a.reviewers, commits: a.commits,
  closingIssuesReferences: a.closes, reviewRequests: a.review_requested_from_owner ?? null,
 });
 // An unknown reread cannot add contradictory partial values to a field this revision already knows.
 a = { ...a, ...(a.unknown.includes("author") && snapshot.known.author ? {author:undefined}:{}),
  ...Object.fromEntries([["reviews","reviewers"],["commits","commits"],["closingIssuesReferences","closes"]].filter(([field])=>a.unknown.includes(field!) && snapshot.known[field!]).map(([,key])=>[key!,[]])) };
	const key = prKey(a.repo, a.number), project = projectKey(a.repo), created: string[] = [];
	const name = collapse(a.title) || `#${a.number}`;
	const attrs: Record<string, unknown> = { repo: a.repo, number: a.number, state: a.state, updated_at: a.updated_at, as_of: a.as_of, head: a.head,
		...(a.review_requested_from_owner !== undefined ? { review_requested_from_owner: a.review_requested_from_owner } : {}), ...(a.unknown.length ? { unknown: a.unknown } : {}) };
	const found = tx.sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved'", key).toArray()[0];
	const cur = found ? readNode(tx.sql, found.id) : undefined;
	if (cur) {
		if (cur.kind !== "pr") throw Fail.of("validation", `key '${key}' belongs to a ${cur.kind} node, not a pr`, { reason: "key_kind_conflict", memory_id: cur.id, kind: cur.kind });
		assertWritable(tx.sql, cur.id);
		const old = JSON.parse(cur.attrs) as Record<string, unknown>;
		if (typeof old.updated_at === "string" && old.updated_at > a.updated_at) return { result: { ok: true, action: "stale", snapshot, memory_id: cur.id, key, current_updated_at: old.updated_at, node_ids: [] }, created, embedDue: false };
		if(old.updated_at===a.updated_at) {
   if(a.unknown.includes("reviewRequests")&&old.review_requested_from_owner!==undefined) attrs.review_requested_from_owner=old.review_requested_from_owner;
   if(snapshot.unknown.length) attrs.unknown=snapshot.unknown; else delete attrs.unknown;
  }
  const merged = { ...Object.fromEntries(Object.entries(old).filter(([k]) => !PR_ATTRS.includes(k))), ...attrs };
		const next = cur.origin === "upload" ? name : cur.name, { hash, card, embeds } = entityHashes("pr", next, cur.description, cur.why, merged);
		if (hash !== cur.content_hash) {
			tx.run(`UPDATE nodes SET name = ?, norm_name = ?, attrs = ?, revision = revision + 1, content_hash = ?, card_hash = ?, embed_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?`,
				next, normalizeName(next), JSON.stringify(merged), hash, card, embeds ? cur.embed_hash : card, tx.now, tx.ctx.platform, tx.seq, cur.id);
			const updated = readNode(tx.sql, cur.id)!;
			writeHead(tx, updated, [], updated.revision);
			writeRevision(tx, updated, "updated", undefined);
		}
	}
	const ids = new Map([[project, ensure(tx, who, created, "project", project, a.repo, {})], [key, cur?.id ?? ensure(tx, who, created, "pr", key, name, attrs)]]);
	for (const login of handles(a)) ids.set(personKey(login), ensure(tx, who, created, "person", personKey(login), login, { github: login }));
	const pr = ids.get(key)!, want = new Set<string>();
	let edges = 0;
	const add = (src: string, rel: string, dst: string) => { want.add(`${src} ${rel} ${dst}`); edges += identifierEdge(tx, src, rel, dst, a.updated_at); };
	for (const e of structuralEdges({ key, project, ...(a.author ? { author: a.author } : {}), reviewers: a.reviewers })) add(ids.get(e.from)!, e.rel, ids.get(e.to)!);
	for (const sha of a.commits) {
		const c = heldNode(tx, commitKey(a.repo, sha));
		if (c?.kind === "commit") add(c.id, "part_of", pr);
		else edges += relateOrWait(tx, pr, commitKey(a.repo, sha), c, a.updated_at);
	}
	for (const issue of a.closes) {
		const t = heldNode(tx, issue);
		if (t?.kind === "bug" || t?.kind === "ticket") { assertWritable(tx.sql, t.id); add(pr, "fixes", t.id); }
		else edges += relateOrWait(tx, pr, issue, t, a.updated_at);
	}
	const ended = cur ? endUnlisted(tx, "pr", pr, want, a.unknown, a.updated_at) : 0;
	linkIdentifiers(tx, pr, `${a.title}\n${a.head}`);
	for (const [k, id] of ids) resolveMentions(tx, id, k);
	const activityId = activity(tx, "upload", `uploaded a PR (new: ${created.length} nodes, ${edges} edges, ended ${ended})`, [...new Set(ids.values())]);
	return { result: { ok: true, action: "stored", snapshot, memory_id: pr, key, updated_at: a.updated_at, new_nodes: created.length, new_edges: edges, ended_edges: ended, activity_id: activityId, node_ids: [...ids.values()] }, created, embedDue: false };
}

/** The ticket attributes an upload owns; every other attribute (an agent's or the owner's notes and the rest) is kept. */
const TICKET_ATTRS = ["type", "state", "status", "priority", "due", "assignee_is_owner", "updated_at", "as_of", "unknown"];
const TRACKER = ["bug", "feature", "ticket"];

/**
 * A Jira ticket snapshot (section 10's ticket item, work only): `jira:<KEY>` plus Jira's updated time, the newer winning, so an
 * older one is `stale` and changes nothing. A new node takes the kind Jira's type maps to; an existing bug, feature or ticket
 * node keeps the kind it has and records Jira's type, and any other kind under the key refuses the item. The board attributes
 * (state, priority, due, assignee_is_owner) and the upload's own fields are replaced and the rest kept; the name follows the
 * summary only while the upload owns the node. Identifier edges come only from structured fields: assigned and reported from
 * the Jira account ids, blocked_by from Jira's directional blocks links (this ticket blocked_by what blocks it, and what it
 * blocks blocked_by it), within the endpoint table. Both tickets list such a link, so the newer word of either decides it (see
 * `said`): a late older snapshot neither adds nor ends it, a listing kept while the other ticket was absent becomes the edge when
 * it arrives, and an unknown list removes nothing. A linked issue not held here, or held with a kind the relation does not
 * admit, and Jira's other link types follow the extract rules: relates_to at most, now or when it arrives; nothing is created.
 * Summary mentions give relates_to and never anything stronger. A protected ticket never gets here as index: runWrite flags it.
 */
function uploadTicket(tx: Tx, who: Who, a: TicketUploadArgs): WriteOutput {
 const snapshot = snapshotRevision(tx, who, a, ticketKey(a.key), {
  kind: a.kind, type: a.type, title: a.title, status: [a.state ?? null, a.status ?? null], priority: a.priority ?? null, due: a.due ?? null,
  assignee: [a.assignee ?? null, a.assignee_is_owner ?? null], reporter: a.reporter ?? null, issuelinks: [a.blocked_by, a.blocks, a.related],
 });
 a = { ...a, ...(a.unknown.includes("assignee") && snapshot.known.assignee ? {assignee:undefined}:{}),
  ...(a.unknown.includes("reporter") && snapshot.known.reporter ? {reporter:undefined}:{}),
  ...(a.unknown.includes("issuelinks") && snapshot.known.issuelinks ? {blocked_by:[],blocks:[],related:[]}:{} ) };
	const key = ticketKey(a.key), created: string[] = [], name = collapse(a.title) || a.key;
	const attrs: Record<string, unknown> = { type: a.type, ...(a.state ? { state: a.state } : {}), ...(a.status !== undefined ? { status: a.status } : {}),
		...(a.priority !== undefined ? { priority: a.priority } : {}), ...(a.due ? { due: a.due } : {}), ...(a.assignee_is_owner !== undefined ? { assignee_is_owner: a.assignee_is_owner } : {}),
		updated_at: a.updated_at, as_of: a.as_of, ...(a.unknown.length ? { unknown: a.unknown } : {}) };
	const found = heldNode(tx, key), cur = found ? readNode(tx.sql, found.id) : undefined;
	if (cur) {
		if (!TRACKER.includes(cur.kind)) throw Fail.of("validation", `key '${key}' belongs to a ${cur.kind} node, not a ${a.kind}`, { reason: "key_kind_conflict", memory_id: cur.id, kind: cur.kind });
		assertWritable(tx.sql, cur.id);
		const old = JSON.parse(cur.attrs) as Record<string, unknown>;
		if (typeof old.updated_at === "string" && old.updated_at > a.updated_at) return { result: { ok: true, action: "stale", snapshot, memory_id: cur.id, key, current_updated_at: old.updated_at, node_ids: [] }, created, embedDue: false };
		if(old.updated_at===a.updated_at) {
   for(const [field,keys] of Object.entries({status:["state","status"],priority:["priority"],due:["due"],assignee:["assignee_is_owner"]}))
    if(a.unknown.includes(field)) for(const k of keys) if(old[k]!==undefined) attrs[k]=old[k];
   if(snapshot.unknown.length) attrs.unknown=snapshot.unknown; else delete attrs.unknown;
  }
  const merged = { ...Object.fromEntries(Object.entries(old).filter(([k]) => !TICKET_ATTRS.includes(k))), ...attrs };
		const next = cur.origin === "upload" ? name : cur.name, { hash, card, embeds } = entityHashes(cur.kind, next, cur.description, cur.why, merged);
		if (hash !== cur.content_hash) {
			tx.run(`UPDATE nodes SET name = ?, norm_name = ?, attrs = ?, revision = revision + 1, content_hash = ?, card_hash = ?, embed_hash = ?, updated_at = ?, updated_source_platform = ?, seq = ? WHERE id = ?`,
				next, normalizeName(next), JSON.stringify(merged), hash, card, embeds ? cur.embed_hash : card, tx.now, tx.ctx.platform, tx.seq, cur.id);
			const updated = readNode(tx.sql, cur.id)!;
			writeHead(tx, updated, [], updated.revision);
			writeRevision(tx, updated, "updated", undefined);
		}
	}
	const ticket = cur?.id ?? ensure(tx, who, created, a.kind, key, name, attrs), ids = new Map([[key, ticket]]);
	for (const p of people(a)) ids.set(p.key, ensure(tx, who, created, "person", p.key, p.name, p.attrs));
	const want = new Set<string>();
	let edges = 0;
	const add = (src: string, rel: string, dst: string) => { want.add(`${src} ${rel} ${dst}`); edges += identifierEdge(tx, src, rel, dst, a.updated_at); };
	for (const e of structuralEdges({ key, ...(a.assignee ? { assignee: a.assignee } : {}), ...(a.reporter ? { reporter: a.reporter } : {}) })) add(ids.get(e.from)!, e.rel, ids.get(e.to)!);
	const blocked = RELATION_ENDPOINTS.blocked_by!, me = ticketKey(a.key), links = !a.unknown.includes("issuelinks");
	// Each directed blocked_by pair this ticket shares, with the other ticket and the ref it would name this link by.
	const pairs = new Map<string, { src: string; dst: string; other: string; ref: string; listed?: true; edge?: number }>();
	const pair = (src: string, dst: string, set: { listed?: true; edge?: number }) => {
		const out = src === ticket, k = `${src} ${dst}`;
		pairs.set(k, { ...(pairs.get(k) ?? { src, dst, other: out ? dst : src, ref: `${out ? "blocks" : "blocked_by"} ${me}` }), ...set });
	};
	const note = (ref: string) => tx.run(`INSERT INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'jira_link', ?, ?, ?)
		ON CONFLICT (owner, kind, ref) DO UPDATE SET note = excluded.note, seq = excluded.seq WHERE note IS NOT excluded.note`, `n:${ticket}`, ref, a.updated_at, tx.seq);
	for (const [field, list, side] of [["blocked_by", a.blocked_by, blocked.to], ["blocks", a.blocks, blocked.from]] as const) {
		for (const other of list) {
			const t = heldNode(tx, ticketKey(other));
			if (t && (side as readonly string[]).includes(t.kind)) {
				if (field === "blocked_by") { assertWritable(tx.sql, t.id); pair(ticket, t.id, { listed: true }); } else pair(t.id, ticket, { listed: true });
			} else edges += relateOrWait(tx, ticket, ticketKey(other), t, a.updated_at);
			// A listing no edge can carry: the other ticket is absent, or this list is partial.
			if (!t || !links) note(`${field} ${ticketKey(other)}`);
		}
	}
	for (const other of a.related) edges += relateOrWait(tx, ticket, ticketKey(other), heldNode(tx, ticketKey(other)), a.updated_at);
	for (const e of cur ? snapshotEdges(tx.sql, "ticket", ticket) : []) if (e.rel === "blocked_by") pair(e.src, e.dst, { edge: e.id });
	const incoming = tx.sql.exec<{ owner: string; ref: string }>("SELECT owner, ref FROM evidence WHERE kind = 'jira_link' AND ref IN (?, ?) AND note IS NOT NULL ORDER BY note DESC LIMIT 101", `blocked_by ${me}`, `blocks ${me}`).toArray();
	// shortcut: refuse more than 100 incoming listings atomically; add durable paging if larger neighborhoods must upload.
	if (incoming.length > 100) throw Fail.of("size_budget", "a ticket upload may reconcile at most 100 incoming Jira listings");
	for (const r of incoming) {
		const y = tx.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM nodes WHERE id = ? AND status <> 'moved'", r.owner.slice(2)).toArray()[0], blocks = r.ref.startsWith("blocks ");
		if (y && y.id !== ticket && ((blocks ? blocked.to : blocked.from) as readonly string[]).includes(y.kind)) pair(blocks ? ticket : y.id, blocks ? y.id : ticket, {});
	}
	let ended = 0;
	for (const p of pairs.values()) {
		want.add(`${p.src} blocked_by ${p.dst}`);
		// This snapshot's word (with its links unknown, only its own earlier one) against the other ticket's: the newer decides, a tie goes to this one.
		const mine = p.listed || links ? { at: a.updated_at, listed: !!p.listed, now: true } : said(tx.sql, ticket, "issuelinks"), theirs = said(tx.sql, p.other, p.ref);
		const word = theirs && (!mine || theirs.at > mine.at) ? theirs : mine;
		if (word?.listed) edges += identifierEdge(tx, p.src, "blocked_by", p.dst, word.at);
		// Only this snapshot's removal ends the edge, never before it began; an older word leaves it as the newer one set it.
		else if (word && "now" in word && p.edge !== undefined) {
			assertWritable(tx.sql, p.src);
			assertArchiveEndpoints(tx.sql,p.src,p.dst,"");
			ended += tx.run("UPDATE edges SET ended_at = ?, valid_to = ?, seq = ? WHERE id = ? AND (valid_from IS NULL OR valid_from <= ?)", tx.now, a.updated_at, tx.seq, p.edge, a.updated_at).rowsWritten ? 1 : 0;
		}
	}
	if (links) {
		// Null preserves the prior row for exact evidence Undo, while superseding obsolete partial/deferred positives at ties too.
		const listed = [...a.blocked_by.map(k => `blocked_by ${ticketKey(k)}`), ...a.blocks.map(k => `blocks ${ticketKey(k)}`)];
		tx.run(`UPDATE evidence SET note = NULL, seq = ? WHERE owner = ? AND kind = 'jira_link' AND note <= ?
			AND (ref LIKE 'blocked_by %' OR ref LIKE 'blocks %') AND ref NOT IN (SELECT value FROM json_each(?))`,
		tx.seq, `n:${ticket}`, a.updated_at, JSON.stringify(listed));
		note("issuelinks");
	}
	ended += cur ? endUnlisted(tx, "ticket", ticket, want, a.unknown, a.updated_at) : 0;
	linkIdentifiers(tx, ticket, a.title);
	for (const [k, id] of ids) resolveMentions(tx, id, k);
	const activityId = activity(tx, "upload", `uploaded a ticket (new: ${created.length} nodes, ${edges} edges, ended ${ended})`, [...new Set(ids.values())]);
	return { result: { ok: true, action: "stored", snapshot, memory_id: ticket, key, updated_at: a.updated_at, new_nodes: created.length, new_edges: edges, ended_edges: ended, activity_id: activityId, node_ids: [...ids.values()] }, created, embedDue: false };
}

/** A repo's acknowledged marker (section 10): sent after its commits are held; the newer as_of wins, the same one replays. */
export function putMarker(storage: DurableObjectStorage, repo: string, m: { head: string; as_of: string }): { status: "stored" | "replayed" | "stale" | "refused"; reason?: string } {
	const sql = storage.sql, key = projectKey(repo), head = m.head.toLowerCase(), asOf = new Date(m.as_of).toISOString();
	return storage.transactionSync(() => {
		assertOpen(sql);
		if (!sql.exec("SELECT 1 FROM requests WHERE op = 'upload' AND node_id IN (SELECT id FROM nodes WHERE key = ? COLLATE NOCASE AND status = 'active')", commitKey(repo, head)).toArray().length) return { status: "refused" as const, reason: "head_not_held" };
		const cur = sql.exec<{ head: string | null; uploaded_at: string | null }>("SELECT head, uploaded_at FROM markers WHERE repo = ?", key).toArray()[0];
		if (cur?.uploaded_at && cur.uploaded_at > asOf) return { status: "stale" as const };
		if (cur?.uploaded_at === asOf) return cur.head === head ? { status: "replayed" as const } : { status: "refused" as const, reason: "marker_conflict" };
		const seq = takeSeq(sql, "profile_meta");
		const tx = new Tx(sql, seq.seq, new Date().toISOString(), { actor: "index", platform: "upload", routedBy: "marker", userId: "", payloadHash: "" }, null);
		tx.charge(seq.rows);
		tx.run(`INSERT INTO markers (repo, head, uploaded_at, seq) VALUES (?, ?, ?, ?)
			ON CONFLICT (repo) DO UPDATE SET head = excluded.head, uploaded_at = excluded.uploaded_at, seq = excluded.seq`, key, head, asOf, seq.seq);
		return { status: "stored" as const };
	});
}
