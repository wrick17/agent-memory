// Identifier extraction (sections 4 and 12). Ids mentioned in text become relates_to edges with basis identifier to the nodes of
// this profile that carry the key, never a stronger relation; a key no node carries yet is kept as a `mention` evidence row and
// becomes the edge when a node with that key is written, of whatever kind it really is. File references become evidence rows.
// Structured upload fields give the structural and work relations, and GitHub's closing references are the only source of `fixes`.
import type { RELATIONS } from "../domain/types";
import { assertWritable } from "./transfer";
import { nextSeq } from "../storage";

type Rel = (typeof RELATIONS)[number];

/** Mentions linked per write; the rest are counted in `skipped`, never dropped silently. */
const MAX_MENTIONS = 100;
/** The write bound (section 5); resolving earlier mentions keeps RESERVE_ROWS of it for the rest of the enclosing write. */
const MAX_ROWS = 1_000, RESERVE_ROWS = 200;
/** Rows Workers SQLite writes to resolve one mention, measured: the edge with its index rows, the mention's delete with its tombstone. */
const ROWS_PER_MENTION = 8;

const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(pull|issues|commit|blob|tree)\/([^\s)<>\]"'`]+))?/g;
const SHORT_REF = /(?<![\w./:@-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d+)\b/g;
const SHORT_SHA = /(?<![\w./:@-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)@([0-9a-f]{7,40})\b/g;
const SHORT_FILE = /(?<![\w./:@-])([A-Za-z0-9][\w.-]*\/[\w.-]+):((?:[\w.-]+\/)*[\w-]+\.[A-Za-z][\w]*)(#L\d+(?:-L\d+)?)?/g;
// Ticket keys: two or more capitals and a number, not a standard's name (UTF-8, SHA-256, UTC-5), and no further `-digit` or
// `.digit` (so CVE-2024-1234 and ISO-8859-1 are not one).
const JIRA = /(?<![\w-])(?!(?:UTF|ISO|SHA|CVE|RFC|UTC|GMT|AES|TLS|SSL|HTTP|PEP|IEC|ECMA|GPT|MD)-)([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![\w]|-\d|\.\d)/g;
const LITERAL = /(?<![\w:])((?:session|person):[\w.-]+(?::[\w.-]+)*)/g;
const HANDLE = /(?<![\w.@/])@([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![\w/@-]|\.\w)/g;

const canonicalKey = (key: string) => /^(github:|git:|person:github:)/.test(key) ? key.toLowerCase() : key;

const repoName = (r: string) => r.replace(/\.git$/, "").replace(/\.+$/, "");
const commitKeys = (org: string, repo: string, sha: string) => {
	const s = sha.toLowerCase();
	return [`git:${org}/${repoName(repo)}@${s}`, ...(s.length > 7 ? [`git:${org}/${repoName(repo)}@${s.slice(0, 7)}`] : [])];
};

/** Candidate node keys and file evidence refs mentioned in text, each once, in order of first appearance. Pure. */
export function identifiers(text: string): { keys: string[]; files: string[] } {
	const keys = new Set<string>(), files = new Set<string>();
	for (const m of text.matchAll(GITHUB)) {
		const [, org, raw, what, tail] = m as unknown as [string, string, string, string | undefined, string | undefined];
		const repo = repoName(raw);
		if (!what || what === "tree") keys.add(`github:${org}/${repo}`);
		else if (what === "pull" || what === "issues") { const n = /^\d+/.exec(tail!)?.[0]; if (n) keys.add(`github:${org}/${repo}#${n}`); }
		else if (what === "commit") { const sha = /^[0-9a-f]{7,40}/i.exec(tail!)?.[0]; if (sha) commitKeys(org, repo, sha).forEach((k) => keys.add(k)); }
		else {
			// blob/<ref>/<path>[#Lx[-Ly]]: the path after the ref, without a query.
			const [path, line] = tail!.split("?")[0]!.split("#") as [string, string | undefined];
			const rest = path.split("/").slice(1).join("/");
			if (rest) files.add(`${org}/${repo}:${rest}${line && /^L\d+(-L\d+)?$/.test(line) ? `#${line}` : ""}`);
		}
	}
	for (const m of text.matchAll(SHORT_REF)) keys.add(`github:${m[1]}/${repoName(m[2]!)}#${m[3]}`);
	for (const m of text.matchAll(SHORT_SHA)) commitKeys(m[1]!, m[2]!, m[3]!).forEach((k) => keys.add(k));
	for (const m of text.matchAll(SHORT_FILE)) files.add(`${m[1]}:${m[2]}${m[3] ?? ""}`);
	for (const m of text.matchAll(JIRA)) keys.add(`jira:${m[1]}`);
	for (const m of text.matchAll(LITERAL)) keys.add(m[1]!.replace(/\.+$/, ""));
	for (const m of text.matchAll(HANDLE)) keys.add(`person:github:${m[1]}`);
	return { keys: [...keys], files: [...files] };
}

/**
 * The write transaction's surface this module uses; `Tx` in write.ts has it. `rows` is what the transaction has written so far,
 * as Workers SQLite reports it per statement (rowsWritten), and `run` adds to it and refuses past the 1,000-row bound.
 */
export interface TxLike {
	sql: SqlStorage; seq: number; now: string; requestId: string | null; ctx: { actor: string }; rows: number; run(query: string, ...params: SqlStorageValue[]): { rowsWritten: number };
	/** A write with undo collects here the exact mention rows it resolves, each with its owner's revision then (section 12). */
	consumed?: Consumed[];
}
export type Consumed = { row: Record<string, SqlStorageValue>; expect: number | null };

const link = (tx: TxLike, src: string, dst: string) => tx.run(`INSERT OR IGNORE INTO edges (src, rel, dst, dst_profile, basis, recorded_at, actor, request_id, seq)
	VALUES (?, 'relates_to', ?, '', 'identifier', ?, ?, ?, ?)`, src, dst, tx.now, tx.ctx.actor, tx.requestId, tx.seq);

/**
 * Inside the write transaction: a relates_to edge with basis identifier from `src` to every node of this profile whose key the
 * text mentions, a `mention` evidence row for each key no node carries yet, and an evidence row per file reference. A current
 * edge of the same relation wins. Nothing is created for an unknown key, so its node later takes whatever kind it really has.
 */
export function linkIdentifiers(tx: TxLike, src: string, text: string): { linked: number; pending: number; files: number; skipped: number } {
	const { keys, files } = identifiers(text);
	const k = keys.slice(0, MAX_MENTIONS), f = files.slice(0, MAX_MENTIONS - k.length);
	const found = k.length ? tx.sql.exec<{ id: string; key: string }>("SELECT id, key FROM nodes WHERE key IN (SELECT value FROM json_each(?)) AND key IS NOT NULL AND status <> 'moved'",
		JSON.stringify([...new Set([...k, ...k.map(canonicalKey)])])).toArray() : [];
	const missing = k.filter((key) => /^(github:|git:|person:github:)/.test(key) && !found.some((t) => canonicalKey(t.key) === canonicalKey(key)));
	// shortcut: unmatched GitHub identities need a NOCASE scan; add a canonical-key index if lookup read costs become material.
	if (missing.length) found.push(...tx.sql.exec<{ id: string; key: string }>("SELECT id, key FROM nodes WHERE key COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND key IS NOT NULL AND status <> 'moved'",
		JSON.stringify(missing)).toArray());
	const targets = found.filter((t) => t.id !== src), known = new Set(found.map((t) => canonicalKey(t.key))), pending = k.filter((key) => !known.has(canonicalKey(key)));
	for (const t of targets) link(tx, src, t.id);
	for (const key of pending) tx.run("INSERT OR IGNORE INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'mention', ?, NULL, ?)", `n:${src}`, key, tx.seq);
	for (const ref of f) tx.run("INSERT OR IGNORE INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'file', ?, 'mentioned', ?)", `n:${src}`, ref, tx.seq);
	return { linked: targets.length, pending: pending.length, files: f.length, skipped: keys.length + files.length - k.length - f.length };
}

/**
 * Inside a write that wrote a node with `key`, after the rest of its work: the mentions recorded before such a node existed become
 * its relates_to links, through evidence_ref. Each one goes only while the transaction's real work so far (tx.rows) leaves room for
 * one more and RESERVE_ROWS; a mention dearer than measured raises the look-ahead. The rest stay recorded, and `left` says so.
 */
export function resolveMentions(tx: TxLike, id: string, key: string): { linked: number; left: boolean } {
	const limit = MAX_ROWS - RESERVE_ROWS, start = tx.rows;
	const collate = /^(github:|git:|person:github:)/.test(key) ? " COLLATE NOCASE" : "";
	// This resolution's own writes, from each statement's rowsWritten, so a counter that lags cannot let it pass the bound.
	let own = 0, cost = ROWS_PER_MENTION, linked = 0;
	const used = () => Math.max(tx.rows - start, own);
	const owners = tx.sql.exec<{ owner: string }>(`SELECT owner FROM evidence WHERE kind = 'mention' AND ref = ?${collate} LIMIT ?`, key,
		Math.max(0, Math.floor((limit - start) / cost)) + 1).toArray().map((r) => r.owner);
	for (const owner of owners) {
		if (start + used() + cost > limit) break;
		assertWritable(tx.sql, owner.slice(2));
		const before = used();
		if (owner !== `n:${id}`) own += link(tx, owner.slice(2), id).rowsWritten;
		if (tx.consumed) {
			const expect = tx.sql.exec<{ revision: number }>("SELECT revision FROM nodes WHERE id = ?", owner.slice(2)).toArray()[0]?.revision ?? null;
			for (const row of tx.sql.exec(`SELECT * FROM evidence WHERE owner = ? AND kind = 'mention' AND ref = ?${collate}`, owner, key)) tx.consumed.push({ row, expect });
		}
		own += tx.run(`DELETE FROM evidence WHERE owner = ? AND kind = 'mention' AND ref = ?${collate}`, owner, key).rowsWritten;
		cost = Math.max(cost, used() - before);
		linked++;
	}
	// The table says whether any wait, so a batch cheaper than measured never reports the rest as done.
	return { linked, left: tx.sql.exec(`SELECT 1 FROM evidence WHERE kind = 'mention' AND ref = ?${collate} LIMIT 1`, key).toArray().length > 0 };
}

/**
 * For a writer without a write transaction of its own kind (capture's session upload): resolves the key's waiting mentions in a
 * transaction of their own, counted by rowsWritten against the same bound. Null when no node has the key or no mention waits.
 */
export function resolveMentionsAlone(storage: DurableObjectStorage, key: string, actor: string): { linked: number; left: boolean; rows: number } | null {
	const sql = storage.sql;
	return storage.transactionSync(() => {
		const id = sql.exec<{ id: string }>("SELECT id FROM nodes WHERE key = ? AND key IS NOT NULL AND status <> 'moved'", key).toArray()[0]?.id;
		if (!id || !sql.exec("SELECT 1 FROM evidence WHERE kind = 'mention' AND ref = ? LIMIT 1", key).toArray().length) return null;
		const tx: TxLike = {
			sql, seq: nextSeq(sql, "profile_meta"), now: new Date().toISOString(), requestId: null, ctx: { actor }, rows: 0,
			run(query, ...params) {
				const cursor = sql.exec(query, ...params);
				this.rows += cursor.rowsWritten;
				// Thrown inside transactionSync, so it rolls this resolution back and leaves every mention recorded.
				if (this.rows > MAX_ROWS) throw new Error("size_budget: mention resolution passed 1,000 rows");
				return cursor;
			},
		};
		return { ...resolveMentions(tx, id, key), rows: tx.rows };
	});
}

/** A structured upload record (section 10's commit, PR and ticket items), by node key. */
export interface UploadFields {
	key: string; author?: string; reviewers?: string[]; commits?: string[]; closes?: string[]; assignee?: string; reporter?: string; blocked_by?: string[];
	/** The repo the item belongs to, as a project key. */
	project?: string;
}

/**
 * Section 4's structural and work relations from structured fields, as node keys. People are keyed by handle: GitHub for
 * authors and reviewers, Jira for assignees and reporters. A ticket key in a title is a mention, so it never gets here.
 */
export function structuralEdges(u: UploadFields): { from: string; rel: Rel; to: string }[] {
	return [
		...(u.author ? [{ from: `person:github:${u.author}`, rel: "authored" as const, to: u.key }] : []),
		...(u.reviewers ?? []).map((r) => ({ from: `person:github:${r}`, rel: "reviewed" as const, to: u.key })),
		...(u.commits ?? []).map((c) => ({ from: c, rel: "part_of" as const, to: u.key })),
		...(u.closes ?? []).map((i) => ({ from: u.key, rel: "fixes" as const, to: i })),
		...(u.assignee ? [{ from: `person:jira:${u.assignee}`, rel: "assigned" as const, to: u.key }] : []),
		...(u.reporter ? [{ from: `person:jira:${u.reporter}`, rel: "reported" as const, to: u.key }] : []),
		...(u.blocked_by ?? []).map((b) => ({ from: u.key, rel: "blocked_by" as const, to: b })),
		...(u.project ? [{ from: u.key, rel: "part_of" as const, to: u.project }] : []),
	];
}
