// Work uploads (sections 4, 10 and 13): bounded metadata the owner's machines read locally, published through the shared write
// path as actor `index`. The server never calls GitHub or Jira. Commits for now; PRs and tickets follow the same op and path.
import { knowledgeTerms } from "../domain/guard";
import { collapse } from "../domain/ids";
import { EMAIL, PHONE } from "../domain/personal";
import { REDACTED, redactText } from "../domain/redact";
import { Fail, type UploadArgs } from "../domain/types";
import { takeSeq } from "../storage";
import { linkIdentifiers, resolveMentions, structuralEdges } from "./extract";
import { assertWritable } from "./transfer";
import { assertOpen } from "./wipe";
import { activity, createEntity, knowledgeId, Tx, type Who, type WriteOutput } from "./write";

export const TITLE_MAX = 280;
const PERSONAL = new RegExp(`${EMAIL.source}|${PHONE.source}`, "g");

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
const personKey = (login: string) => `person:github:${login}`;

/**
 * The commit as it is hashed and stored: secrets redacted and emails and phone numbers replaced before the hash (section 4),
 * the time in UTC, and its natural id as the request id, so the same commit replays and a changed one is refused.
 */
export function commitArgs(repo: string, c: { sha: string; at: string; title: string; author?: string }): UploadArgs {
	const sha = c.sha.toLowerCase();
	return { item: "commit", repo, sha, at: new Date(c.at).toISOString(), title: redactText(c.title).replace(PERSONAL, REDACTED),
		...(c.author ? { author: c.author.toLowerCase() } : {}), request_id: `upload:${commitKey(repo, sha)}` };
}

/** The me guard terms a work upload introduces: the project and each author handle (the record_knowledge rule). */
export const uploadTerms = (repo: string, items: { author?: string }[]) => knowledgeTerms([
	{ kind: "project", name: repo, key: projectKey(repo) },
	...[...new Set(items.flatMap((c) => (c.author ? [c.author] : [])))].map((login) => ({ kind: "person", name: login, key: personKey(login), attrs: { github: login } })),
]);

/** Candidate node ids for the account's wipe ledger: the project, the commit and its author. */
export function uploadIds(who: Who, a: UploadArgs): string[] {
	return [["project", projectKey(a.repo)], ["commit", commitKey(a.repo, a.sha)], ...(a.author ? [["person", personKey(a.author)]] : [])]
		.map(([kind, key]) => knowledgeId(who, { kind: kind as "project", key: key!, name: key! }));
}

/**
 * The `upload` op, inside runWrite's transaction. The project and the author are created only when absent and never rewritten;
 * a node of another kind under one of the keys refuses the item. A new commit gets its title as name, valid_from at the commit
 * time and a revision. Edges have basis identifier: `authored` only from the structured author, `part_of` to the repo, and
 * title mentions through linkIdentifiers, which never gives more than relates_to.
 */
export function upload(tx: Tx, who: Who, a: UploadArgs): WriteOutput {
	if (who.profile === "me") throw Fail.of("forbidden", "uploads never go to me");
	if (a.item !== "commit") throw Fail.of("validation", `unknown upload item '${String(a.item)}'`);
	const key = commitKey(a.repo, a.sha), project = projectKey(a.repo), created: string[] = [];
	const ensure = (kind: "project" | "person" | "commit", k: string, name: string, attrs: Record<string, unknown>, validFrom?: string): string => {
		const cur = tx.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM nodes WHERE key = ? COLLATE NOCASE AND status <> 'moved'", k).toArray()[0];
		if (cur && cur.kind !== kind) throw Fail.of("validation", `key '${k}' belongs to a ${cur.kind} node, not a ${kind}`, { reason: "key_kind_conflict", memory_id: cur.id, kind: cur.kind });
		if (cur) { assertWritable(tx.sql, cur.id); return cur.id; }
		const id = createEntity(tx, who, { kind, key: k, name, ...(validFrom ? { valid_from: validFrom } : {}) }, "upload", { name, scope: "default", description: "", why: null, attrs });
		created.push(id);
		return id;
	};
	const ids = new Map([[project, ensure("project", project, a.repo, {})], [key, ensure("commit", key, collapse(a.title) || a.sha.slice(0, 7), { repo: a.repo, sha: a.sha }, a.at)]]);
	if (a.author) ids.set(personKey(a.author), ensure("person", personKey(a.author), a.author, { github: a.author }));
	const commit = ids.get(key)!;
	let edges = 0;
	for (const e of structuralEdges({ key, project, ...(a.author ? { author: a.author } : {}) })) {
		const src = ids.get(e.from)!;
		// A link belongs to its source, so a source being transferred refuses the item (section 9).
		assertWritable(tx.sql, src);
		edges += tx.run(`INSERT OR IGNORE INTO edges (src, rel, dst, dst_profile, basis, valid_from, recorded_at, actor, request_id, seq)
			VALUES (?, ?, ?, '', 'identifier', ?, ?, ?, ?, ?)`, src, e.rel, ids.get(e.to)!, a.at, tx.now, tx.ctx.actor, tx.requestId, tx.seq).rowsWritten ? 1 : 0;
	}
	// An existing commit node (written by an agent) keeps its content; only a new one publishes its title's mentions.
	if (created.includes(commit)) linkIdentifiers(tx, commit, a.title);
	// A short SHA may name multiple commits. Keep its mention evidence until a full identity is supplied.
	for (const [k, id] of ids) resolveMentions(tx, id, k);
	const activityId = activity(tx, "upload", `uploaded a commit (new: ${created.length} nodes, ${edges} edges)`, [...new Set(ids.values())]);
	return { result: { ok: true, action: "stored", memory_id: commit, key, new_nodes: created.length, new_edges: edges, activity_id: activityId, node_ids: [...ids.values()] }, created, embedDue: false };
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
