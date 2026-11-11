// Repo facts (#92-#95). Each fact is one memory record (kind rule, type feedback, scope `repo-fact`, name `<repo_key>#<fact_key>`)
// whose lifecycle lives in attrs.fact. Only the `fact` write op changes it, inside the shared write transaction (request replay,
// activity, undo images); ordinary recall, inventory, graph expansion, owner model and housekeeping never see it.
import { contentHash, cardText, activity, readNode, writeRevision, type NodeRow, type Tx, type Who, type WriteOutput } from "./write";
import { newMemoryId, sha256 } from "../domain/ids";
import { redactText } from "../domain/redact";
import { fail, Fail, ok, type FactArgs, type FactObservation, type MemoryType, type Outcome, type WriteCommand } from "../domain/types";
import { normalizeRemote } from "../routing";

export const FACT_SCOPE = "repo-fact";
export const FACT_LIMITS = Object.freeze({ observations: 32, families: 32, fired: 32, live: 32, evidence: 20, seen: 64, chain: 8, devices: 8, inject: 4 });
/** Activation and retirement thresholds (#92) and the injection gate (#94): 4 exercised sessions, firing rate at least 40%. */
export const FACT_RULES = Object.freeze({ activate: 3, retire: 2, exercised: 4 });
export const REPO_KEY = /^github\.com\/[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
export const SESSION_REF = /^(claude-code|codex):[0-9a-f]{12}$/;
/** Machine paths the client scrubs to `~`; a fact that still names one is refused, never stored. */
const HOME_PATH = /(?:^|[\s'"=:(])(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\)/;

type State = "candidate" | "active" | "retired";
/** attrs.fact. `chains` holds, per device, its confirming sessions that are pairwise disjoint as that device's ledger attested. */
export interface FactState {
	repo_key: string; fact_key: string; detector: string; literal: string; family: string; state: State;
	chains: Record<string, string[]>; contradictions: number; exercised: number; fired: number; seen: string[];
}

export const factName = (repoKey: string, factKey: string) => `${repoKey}#${factKey}`;
export const factKeyOf = (detector: string, literal: string) => sha256(`${detector}\n${literal}`).slice(0, 16);
export const factId = (who: Who, repoKey: string, factKey: string) => newMemoryId(who.userId, who.profile, FACT_SCOPE, "feedback", factName(repoKey, factKey));
const forgottenKey = (id: string) => `fact-forgotten:${id}`;
const range = (repoKey: string) => [`${repoKey}#`, `${repoKey}#~`] as const;
const stateOf = (n: { attrs: string }): FactState => (JSON.parse(n.attrs) as { fact: FactState }).fact;
/** A retired node is retired whatever its attrs say: retire by memory id changes only the node. */
const effective = (n: { status: string; attrs: string }): State => (n.status === "retired" ? "retired" : stateOf(n).state);
/** The injection gate on integers: fired / exercised >= 0.40 is fired * 5 >= exercised * 2. */
const eligible = (n: NodeRow) => {
	const f = stateOf(n);
	return n.status === "active" && f.state === "active" && f.exercised >= FACT_RULES.exercised && f.fired * 5 >= f.exercised * 2;
};

/**
 * The repo key for a fact route: the GitHub key of the same remote that routes the request (aliases are resolved on the client).
 * A body repo_key that names another repo is refused, so repo B can never be written or read through repo A's route.
 */
export function factRepoKey(remote: string, claimed?: string): Outcome<string> {
	const key = normalizeRemote(remote);
	if (!REPO_KEY.test(key)) return fail("validation", "repo facts need repo.remote on github.com/<owner>/<repo>", { reason: "unsupported_remote" });
	if (claimed !== undefined && claimed !== key) return fail("validation", "repo_key does not match repo.remote", { reason: "repo_key_mismatch" });
	return ok(key);
}

/** Literal checks the Worker applies before hashing: canonical single line, unchanged by redaction, and its fact_key. */
export function checkObservation(o: FactObservation): string | null {
	if (o.literal !== o.literal.trim().replace(/\s+/g, " ")) return "literal must be one line with collapsed whitespace";
	if (redactText(o.literal) !== o.literal) return "literal holds a secret";
	if ([o.literal, o.statement].some((t) => HOME_PATH.test(t))) return "statement or literal holds a home or user path";
	if (factKeyOf(o.detector, o.literal) !== o.fact_key) return "fact_key does not match detector and literal";
	return null;
}

/** Ids a report may create, for the account's wipe ledger. */
export const factIds = (who: Who, a: FactArgs) => [...new Set(a.observations.map((o) => factId(who, a.repo_key, o.fact_key)))];

/** Live (node status active) facts of one repo: candidates and active facts. Retired and fenced facts never change here. */
export function liveFactIds(sql: SqlStorage, repoKey: string): string[] {
	return sql.exec<{ id: string }>("SELECT id FROM nodes WHERE norm_name > ? AND norm_name < ? AND scope = ? AND status = 'active'", ...range(repoKey), FACT_SCOPE).toArray().map((r) => r.id);
}

const reserved = () => Fail.of("validation", "scope repo-fact is reserved for repo facts; they change only through fact reports, retire, pin, forget and undo", { reason: "repo_fact_reserved" });
const isFact = (sql: SqlStorage, id: string) => sql.exec("SELECT 1 FROM nodes WHERE id = ? AND scope = ?", id, FACT_SCOPE).toArray().length > 0;
const scoped = (s: unknown) => typeof s === "string" && s.trim().toLowerCase() === FACT_SCOPE;

/** Graph edges never touch a fact: no link, supersession or expansion path reaches one. */
export function assertNotFactEdge(sql: SqlStorage, ...ids: string[]): void {
	if (ids.some((id) => isFact(sql, id))) throw reserved();
}

/**
 * The reservation every ordinary write passes inside its transaction: save, append, capture and record_knowledge may not create,
 * change, move into or out of, or supersede a fact. A retire-only save, owner actions, undo and restore stay allowed.
 */
export function assertFactReserved(sql: SqlStorage, cmd: WriteCommand, find: (ident: { memory_id?: string; name?: string; scope?: string; type?: MemoryType }) => string | undefined): void {
	if (cmd.op === "save") {
		const a = cmd.args;
		if (a.retire === true) return;
		if (scoped(a.scope) || scoped(a.from_scope)) throw reserved();
		// save()'s own lookup: by id, else by name narrowed by from_scope and type; a plain create resolves to no existing fact.
		const target = find({ ...(a.memory_id ? { memory_id: a.memory_id } : { name: a.name }), ...(a.from_scope !== undefined ? { scope: a.from_scope } : {}), ...(a.type ? { type: a.type } : {}) });
		if ((target && isFact(sql, target)) || [a.supersedes ?? []].flat().some((id) => isFact(sql, id))) throw reserved();
	} else if (cmd.op === "append") {
		const target = find(cmd.args);
		if (target && isFact(sql, target)) throw reserved();
	} else if (cmd.op === "capture") {
		if (scoped(cmd.args.scope)) throw reserved();
	} else if (cmd.op === "knowledge") {
		if ((cmd.args.nodes ?? []).some((n) => scoped(n.scope) || (n.attrs !== undefined && Object.hasOwn(n.attrs, "fact")))) throw reserved();
	}
}

/** Written in the same transaction that fences or archives a fact for forgetting; a report then refuses it. */
export function markForgotten(tx: { run(q: string, ...p: SqlStorageValue[]): unknown }, node: { id?: unknown; scope?: unknown }, at: string): void {
	if (node.scope !== FACT_SCOPE) return;
	tx.run("INSERT INTO profile_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", forgottenKey(String(node.id)), JSON.stringify({ at }));
}
/** Cleared only when a restore publishes or a forget's abort publishes the node again; a failed or aborted restore keeps it. */
export function clearForgotten(tx: { run(q: string, ...p: SqlStorageValue[]): unknown }, id: string): void {
	tx.run("DELETE FROM profile_meta WHERE key = ?", forgottenKey(id));
}
const forgotten = (sql: SqlStorage, id: string) => sql.exec("SELECT 1 FROM profile_meta WHERE key IN (?, ?) LIMIT 1", forgottenKey(id), `wiped:${id}`).toArray().length > 0;

type Result = { fact_key: string; memory_id: string; status: "stored" | "seen" | "refused"; reason?: string; state?: State; chain?: number };
type Change = { node: NodeRow | null; f: FactState; statement: string; retire: boolean };

/**
 * One fact report (#92). Per fact and session at most one confirmation, contradiction, exercise and firing. A same-session conflict
 * counts only as a contradiction. A first deterministic confirm creates a candidate and starts its device's chain; a P2 proposal
 * creates a candidate and never confirms. A candidate becomes active when one device's chain holds 3 pairwise-disjoint confirming
 * sessions; an active, unpinned fact retires after 2 consecutive contradictions. Forgotten, retired and fenced facts are refused.
 */
export function applyFacts(tx: Tx, who: Who, a: FactArgs): WriteOutput {
	if (who.profile === "me") throw Fail.of("forbidden", "repo facts never go to me");
	if (!tx.ctx.deviceId || tx.ctx.deviceId !== a.device) throw Fail.of("forbidden", "repo facts need the reporting device's token");
	if (!a.session === !a.proposal) throw Fail.of("validation", "a fact report names exactly one session or proposal");
	if (a.observations.length > FACT_LIMITS.observations || a.families.length > FACT_LIMITS.families || a.fired.length > FACT_LIMITS.fired) throw Fail.of("size_budget", "a fact report holds at most 32 observations, families and fired keys each");
	const session = a.session ?? null, device = a.device, sql = tx.sql;
	const results = new Map<string, Result>(), changes = new Map<string, Change>();
	const byKey = new Map<string, FactObservation[]>();
	for (const o of a.observations) (byKey.get(o.fact_key) ?? byKey.set(o.fact_key, []).get(o.fact_key)!).push(o);
	let live = liveFactIds(sql, a.repo_key).length;
	const refuse = (key: string, id: string, reason: string) => results.set(key, { fact_key: key, memory_id: id, status: "refused", reason });
	for (const [key, obs] of byKey) {
		const id = factId(who, a.repo_key, key), node = readNode(sql, id) ?? null;
		if ((session ? obs.some((o) => o.kind === "propose") : obs.some((o) => o.kind !== "propose"))) throw Fail.of("validation", "session reports confirm or contradict; proposals only propose");
		if (!node) {
			if (forgotten(sql, id)) { refuse(key, id, "fact_forgotten"); continue; }
			if (obs.every((o) => o.kind === "contradict")) { refuse(key, id, "unknown_fact"); continue; }
			if (live >= FACT_LIMITS.live) { refuse(key, id, "fact_limit"); continue; }
			live++;
			const o = obs[0]!;
			changes.set(key, { node: null, statement: o.statement, retire: false, f: { repo_key: a.repo_key, fact_key: key, detector: o.detector, literal: o.literal, family: o.family,
				state: "candidate", chains: {}, contradictions: 0, exercised: 0, fired: 0, seen: [] } });
		} else if (node.status === "moving" || node.status === "incoming") { refuse(key, id, "fact_busy"); continue; }
		else if (node.status !== "active" || effective(node) === "retired") { refuse(key, id, "fact_retired"); continue; }
		else changes.set(key, { node, f: stateOf(node), statement: node.description, retire: false });
		const c = changes.get(key)!;
		if (session && c.f.seen.includes(session)) { results.set(key, { fact_key: key, memory_id: id, status: "seen", state: c.f.state }); changes.delete(key); continue; }
		const contradict = obs.find((o) => o.kind === "contradict"), confirm = obs.find((o) => o.kind === "confirm");
		if (contradict) {
			c.f.contradictions++;
			if (c.f.state === "active" && c.f.contradictions >= FACT_RULES.retire && !c.node?.pinned) { c.f.state = "retired"; c.retire = true; }
		} else if (confirm && session) {
			c.f.contradictions = 0;
			if (confirm.disjoint_from) {
				// Only sessions the server holds in this device's chain and the ledger attested disjoint stay, so the chain self-heals.
				const prior = (c.f.chains[device] ?? []).filter((s) => confirm.disjoint_from!.includes(s));
				delete c.f.chains[device];
				c.f.chains[device] = [...prior, session].slice(-FACT_LIMITS.chain);
				const devices = Object.keys(c.f.chains);
				for (const d of devices.slice(0, Math.max(0, devices.length - FACT_LIMITS.devices))) delete c.f.chains[d];
				if (c.f.state === "candidate" && c.f.chains[device]!.length >= FACT_RULES.activate) c.f.state = "active";
			}
		}
	}
	if (session) {
		// The denominator: every live fact whose family the successful session used, or that it explicitly fired.
		const families = new Set(a.families), fired = new Set(a.fired);
		for (const id of liveFactIds(sql, a.repo_key)) {
			const node = readNode(sql, id)!, f = stateOf(node);
			if (results.has(f.fact_key) && !changes.has(f.fact_key) || f.state === "retired" || f.seen.includes(session)) continue;
			const c = changes.get(f.fact_key) ?? (families.has(f.family) || fired.has(f.fact_key) ? changes.set(f.fact_key, { node, f, statement: node.description, retire: false }).get(f.fact_key)! : undefined);
			if (!c || c.retire || !(families.has(f.family) || fired.has(f.fact_key))) continue;
			c.f.exercised++;
			if (fired.has(f.fact_key)) c.f.fired++;
		}
		for (const key of changes.keys()) {
			const c = changes.get(key)!;
			if (c.node === null && (families.has(c.f.family) || fired.has(key))) { c.f.exercised++; if (fired.has(key)) c.f.fired++; }
			c.f.seen = [...c.f.seen, session].slice(-FACT_LIMITS.seen);
		}
	}
	const created: string[] = [], touched: string[] = [];
	for (const [key, c] of changes) {
		const id = factId(who, a.repo_key, key);
		const obs = byKey.get(key) ?? [];
		const attrs = JSON.stringify({ ...(c.node ? JSON.parse(c.node.attrs) as object : {}), fact: c.f });
		if (!c.node) {
			const name = factName(a.repo_key, key);
			const card = sha256(cardText({ kind: "rule", name, description: c.statement, why: null }, ""));
			// embed_hash equals card_hash: a fact is never embedded, so no vector or similarity link is made for it.
			tx.run(`INSERT INTO nodes (id, kind, memory_type, scope, name, norm_name, description, attrs, status, origin, revision, chars, content_hash, card_hash, embed_hash,
				valid_from, recorded_at, created_at, updated_at, source_platform, updated_source_platform, seq)
				VALUES (?, 'rule', 'feedback', ?, ?, ?, ?, ?, 'active', 'agent', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id, FACT_SCOPE, name, name, c.statement, attrs, contentHash({ name, type: "feedback", description: c.statement }), card, card,
				tx.now, tx.now, tx.now, tx.now, tx.ctx.platform, tx.ctx.platform, tx.seq);
			writeRevision(tx, readNode(sql, id)!, "saved", "");
			created.push(id);
		} else {
			tx.run(`UPDATE nodes SET attrs = ?, revision = revision + 1, updated_at = ?, updated_source_platform = ?, seq = ?${c.retire ? ", status = 'retired', valid_to = ?" : ""} WHERE id = ?`,
				attrs, tx.now, tx.ctx.platform, tx.seq, ...(c.retire ? [tx.now] : []), id);
			if (c.retire) writeRevision(tx, readNode(sql, id)!, "retired", undefined);
			touched.push(id);
		}
		// Evidence: the first 20 refs per fact. A proposal's citations stay separate from confirmations by their note.
		const room = FACT_LIMITS.evidence - Number(sql.exec<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE owner = ?", `n:${id}`).one().n);
		const refs = session ? (obs.length ? [[session, obs.some((o) => o.kind === "contradict") ? "contradict" : "confirm"]] : [])
			: [...new Set(obs.flatMap((o) => o.citations ?? []))].map((r) => [r, "cited"]);
		for (const [ref, note] of refs.slice(0, Math.max(0, room))) tx.run("INSERT OR IGNORE INTO evidence (owner, kind, ref, note, seq) VALUES (?, 'session', ?, ?, ?)", `n:${id}`, ref!, note!, tx.seq);
		if (obs.length) results.set(key, { fact_key: key, memory_id: id, status: "stored", state: c.f.state, chain: Math.max(0, ...Object.values(c.f.chains).map((s) => s.length)) });
	}
	for (const key of a.fired) if (!results.has(key) && changes.has(key)) { const c = changes.get(key)!; results.set(key, { fact_key: key, memory_id: factId(who, a.repo_key, key), status: "stored", state: c.f.state }); }
	const ids = [...created, ...touched];
	const activityId = ids.length ? activity(tx, "facts", `fact report for ${a.repo_key}: ${created.length} new, ${touched.length} changed`, ids) : undefined;
	return { result: { ok: true, action: "stored", repo_key: a.repo_key, facts: [...results.values()].sort((x, y) => (x.fact_key < y.fact_key ? -1 : 1)),
		node_ids: created, ...(activityId !== undefined ? { activity_id: activityId } : {}) }, created, embedDue: false };
}

/** #94: at most 4 eligible facts of one repo, by firing rate, then exercised, then fact_key. Never a candidate or retired fact. */
export function injectFacts(sql: SqlStorage, repoKey: string) {
	return sql.exec<NodeRow>("SELECT rowid, * FROM nodes WHERE norm_name > ? AND norm_name < ? AND scope = ? AND status = 'active'", ...range(repoKey), FACT_SCOPE).toArray()
		.filter(eligible).map((n) => ({ n, f: stateOf(n) }))
		.sort((x, y) => y.f.fired * x.f.exercised - x.f.fired * y.f.exercised || y.f.exercised - x.f.exercised || (x.f.fact_key < y.f.fact_key ? -1 : 1))
		.slice(0, FACT_LIMITS.inject)
		.map(({ n, f }) => ({ fact_key: f.fact_key, detector: f.detector, statement: n.description, literal: f.literal, exercised: f.exercised, fired: f.fired }));
}

/** #95: every fact of the profile, or of one repo, in all states, with its evidence refs and firing rate. Paged by name. */
export function listFacts(sql: SqlStorage, q: { repo_key?: string; after: string | null; limit: number }) {
	const [lo, hi] = q.repo_key ? range(q.repo_key) : ["", "~"];
	const from = q.after !== null && q.after > lo ? q.after : lo;
	const rows = sql.exec<NodeRow>(`SELECT rowid, * FROM nodes WHERE norm_name > ? AND norm_name < ? AND scope = ? AND memory_type = 'feedback'
		AND status IN ('active','retired','moving','incoming') ORDER BY norm_name LIMIT ?`, from, hi, FACT_SCOPE, q.limit + 1).toArray();
	const page = rows.slice(0, q.limit);
	const evidence = new Map<string, { kind: string; ref: string; note: string | null }[]>();
	for (const r of sql.exec<{ owner: string; kind: string; ref: string; note: string | null }>("SELECT owner, kind, ref, note FROM evidence WHERE owner IN (SELECT value FROM json_each(?)) ORDER BY owner, seq, ref",
		JSON.stringify(page.map((n) => `n:${n.id}`))).toArray()) (evidence.get(r.owner) ?? evidence.set(r.owner, []).get(r.owner)!).push({ kind: r.kind, ref: r.ref, note: r.note });
	return {
		facts: page.map((n) => {
			const f = stateOf(n);
			return { memory_id: n.id, repo_key: f.repo_key, fact_key: f.fact_key, detector: f.detector, statement: n.description, literal: f.literal,
				state: effective(n), status: n.status, pinned: n.pinned !== 0, revision: n.revision, exercised: f.exercised, fired: f.fired,
				rate: f.exercised ? f.fired / f.exercised : null, contradictions: f.contradictions, chain: Math.max(0, ...Object.values(f.chains).map((s) => s.length)),
				eligible: eligible(n), evidence: evidence.get(`n:${n.id}`) ?? [], created_at: n.created_at, updated_at: n.updated_at };
		}),
		next_after: rows.length > q.limit ? page.at(-1)!.norm_name : null,
	};
}
