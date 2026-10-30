// Corpus refresh (section 14, refresh design revision 2): one plan per repo applies bounded, hash-chained parts to the original
// tables while every corpus read is closed, then publishes five verified partition digests in one constant-size transaction.
// Every function here runs inside the CorpusStore transaction that called it, so a refusal rolls back all of its writes.
import { sha256 } from "../domain/ids";
import { Fail } from "../domain/types";
import { checkRow, chunkTerms, FAMILIES, FAMILY_ORDER, named, PROJECTION, REFRESH, rowHash, schemaSha, type Family, type SearchDoc, type Value } from "./families";

export const META = "corpus_store_meta";
export const PART_OPS = 5000;
/** Old and new row and document bytes one part may rewrite; any one admitted row and its replacement fit (design 4.6). */
export const EXPANDED_BYTES = 5_000_000;
/** A put row's serialized bytes, the bulk uploader's chunk byte target, so one operation always fits a 1,000,000-byte request. */
export const ROW_BYTES = 900_000;
export const PAGE_BYTES = 1_000_000;

export interface Digest { rows: number; sum: string }
export type Base = { kind: "published"; epoch: number } | { kind: "active"; plan_id: string; next_op: number; chain: string };
export interface PlanHeader {
	version: "corpus-refresh/1"; repo: string; intent: "refresh" | "remove"; base: Base;
	source: { kind: "sqlite-file"; id: string; scope: "complete-repo-projection" }; projection: string; schemas: Record<string, string>;
	observed: string[]; observed_at: string; targets: Record<string, Digest>; op_count: number; chain: string;
}
export type Op = ["d", string, Value[], string] | ["p", string, Value[], string | null];
export type RefreshCommand =
	| { command: "inspect"; table: string; repo: string; after: Value[] | null; limit?: number }
	| { command: "begin"; header: PlanHeader }
	| { command: "part"; plan_id: string; start: number; ops: Op[] }
	| { command: "finish"; plan_id: string };
interface Who { profile: string; generation: string }

export const MIGRATION = [
	`CREATE TABLE corpus_partitions (table_name TEXT NOT NULL, part TEXT NOT NULL, rows INTEGER NOT NULL, sum TEXT NOT NULL, basis TEXT NOT NULL,
		source_kind TEXT NOT NULL, source_id TEXT NOT NULL, projection TEXT NOT NULL, observed_at TEXT NOT NULL, revision INTEGER NOT NULL, plan_id TEXT,
		PRIMARY KEY (table_name, part)) WITHOUT ROWID`,
	`CREATE TABLE corpus_refresh (plan_id TEXT PRIMARY KEY, header TEXT NOT NULL, seed TEXT NOT NULL, state TEXT NOT NULL, next_op INTEGER NOT NULL,
		chain TEXT NOT NULL, last TEXT, running TEXT NOT NULL, base_epoch INTEGER NOT NULL, begun_at TEXT NOT NULL, begin_receipt TEXT NOT NULL,
		published_at TEXT, published_receipt TEXT) WITHOUT ROWID`,
	`CREATE TABLE corpus_refresh_parts (plan_id TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, sha256 TEXT NOT NULL, receipt TEXT NOT NULL,
		received_at TEXT NOT NULL, PRIMARY KEY (plan_id, start)) WITHOUT ROWID`,
];

const ZERO: Digest = { rows: 0, sum: "0".repeat(64) };
const MOD = 1n << 256n;
const hex = (n: bigint) => (((n % MOD) + MOD) % MOD).toString(16).padStart(64, "0");
const plus = (a: Digest, b: Digest): Digest => ({ rows: a.rows + b.rows, sum: hex(BigInt(`0x${a.sum}`) + BigInt(`0x${b.sum}`)) });
const add = (d: Digest, h: string, sign: 1 | -1): Digest => ({ rows: d.rows + sign, sum: hex(BigInt(`0x${d.sum}`) + BigInt(sign) * BigInt(`0x${h}`)) });
const same = (a: Digest, b: Digest) => a.rows === b.rows && a.sum === b.sum;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
/** A partition is one repo value of one table; NULL (unattributed rows) is its own partition and never refreshes. */
const part = (repo: Value) => JSON.stringify(repo);
const bad = (reason: string, message: string, details: Record<string, unknown> = {}) => Fail.of("validation", message, { reason, ...details });

/** The key an operation names inside its repo: repos by the plan's repo itself, contributors by rowid (design 3). */
const LOCAL: Record<string, string[]> = { repos: [], commits: ["sha"], refs: ["refname"], commit_paths: ["sha", "path"], contributors: ["rowid"] };
const where = (t: string) => (t === "repos" ? "full_name = ?" : `repo = ? AND ${LOCAL[t]!.map((c) => `${c} = ?`).join(" AND ")}`);
const DELETE_ORDER = ["commit_paths", "commits", "refs", "contributors", "repos"], PUT_ORDER = ["repos", "commits", "commit_paths", "refs", "contributors"];
const REPO_KEY: Family = { ...FAMILIES.repos!, columns: { full_name: "text" }, key: ["full_name"] };

// Identity (C15): the seed never contains the terminal chain; the plan id binds the whole final header, chain included.
const seedTuple = (who: Who, h: PlanHeader) => [who.profile, who.generation, h.version, h.repo, h.intent,
	h.base.kind === "published" ? ["published", h.base.epoch] : ["active", h.base.plan_id, h.base.next_op, h.base.chain],
	[h.source.kind, h.source.id, h.source.scope], h.projection, FAMILY_ORDER.map((t) => h.schemas[t]), h.observed, h.observed_at,
	FAMILY_ORDER.map((t) => [h.targets[t]!.rows, h.targets[t]!.sum]), h.op_count];
export const seedOf = (who: Who, h: PlanHeader) => sha256(JSON.stringify(["corpus-refresh/1:seed", ...seedTuple(who, h)]));
export const planIdOf = (who: Who, h: PlanHeader) => sha256(JSON.stringify(["corpus-refresh/1:plan", ...seedTuple(who, h), h.chain]));
const step = (chain: string, op: Op) => sha256(JSON.stringify([chain, op]));

interface Plan { header: PlanHeader; state: string; next_op: number; chain: string; last: string | null; running: Record<string, Digest>; base_epoch: number;
	begun_at: string; begin_receipt: string; published_receipt: string | null }
function plan(sql: SqlStorage, id: string): Plan | undefined {
	const r = sql.exec<{ header: string; state: string; next_op: number; chain: string; last: string | null; running: string; base_epoch: number; begun_at: string; begin_receipt: string; published_receipt: string | null }>(
		"SELECT header, state, next_op, chain, last, running, base_epoch, begun_at, begin_receipt, published_receipt FROM corpus_refresh WHERE plan_id = ?", id).toArray()[0];
	return r && { ...r, header: JSON.parse(r.header) as PlanHeader, running: JSON.parse(r.running) as Record<string, Digest> };
}
const metaValue = (sql: SqlStorage, key: string) => sql.exec<{ value: string }>(`SELECT value FROM ${META} WHERE key = ?`, key).toArray()[0]?.value;
export const refreshActive = (sql: SqlStorage) => metaValue(sql, "refresh_active");
const epochOf = (sql: SqlStorage) => Number(metaValue(sql, "epoch") ?? 0);
const partition = (sql: SqlStorage, t: string, repo: Value) => sql.exec<{ rows: number; sum: string; basis: string; source_id: string; observed_at: string }>(
	"SELECT rows, sum, basis, source_id, observed_at FROM corpus_partitions WHERE table_name = ? AND part = ?", t, part(repo)).toArray()[0];
const published = (sql: SqlStorage, t: string, repo: Value): Digest => { const r = partition(sql, t, repo); return r ? { rows: r.rows, sum: r.sum } : ZERO; };
const loadsComplete = (sql: SqlStorage) =>
	sql.exec<{ n: number }>("SELECT count(*) AS n FROM corpus_meta WHERE complete = 1 AND table_name IN (SELECT value FROM json_each(?))", JSON.stringify(FAMILY_ORDER)).one().n === FAMILY_ORDER.length;

/** The bulk load's partitions: each chunk adds its rows to its repos' declared-snapshot digests, so refresh starts from exact sums. */
export function addToPartitions(sql: SqlStorage, run: (q: string, ...p: Value[]) => unknown, table: string, rows: Value[][], sourceId: string, asOf: string) {
	const f = FAMILIES[table]!, cols = Object.keys(f.columns), at = cols.indexOf(f.repo), rowid = cols.indexOf("rowid");
	const by = new Map<string, Digest>();
	for (const r of rows) by.set(part(r[at]!), add(by.get(part(r[at]!)) ?? ZERO, rowHash(table, rowid < 0 ? r : r.filter((_, i) => i !== rowid)), 1));
	for (const [k, d] of by) {
		const prev = sql.exec<{ rows: number; sum: string }>("SELECT rows, sum FROM corpus_partitions WHERE table_name = ? AND part = ?", table, k).toArray()[0];
		const next = prev ? plus(prev, d) : d;
		run(`INSERT INTO corpus_partitions (table_name, part, rows, sum, basis, source_kind, source_id, projection, observed_at, revision) VALUES (?, ?, ?, ?, 'declared_snapshot', 'sqlite-file', ?, ?, ?, 0)
			ON CONFLICT (table_name, part) DO UPDATE SET rows = excluded.rows, sum = excluded.sum`, table, k, next.rows, next.sum, sourceId, PROJECTION, new Date(asOf).toISOString());
	}
}

/** The work terms a part's put rows introduce, after each passes its family's row check; deletes introduce none (design 4.4). */
export function refreshTerms(ops: Op[]): string[] {
	const by = new Map<string, Value[][]>();
	ops.forEach((op, i) => { if (op[0] === "p" && REFRESH[op[1]]) by.set(op[1], [...(by.get(op[1]) ?? []), checkRow(REFRESH[op[1]]!, op[2], i)]); });
	return [...new Set([...by].flatMap(([t, rows]) => chunkTerms(REFRESH[t]!, rows)))];
}

/** One command, inside the store's transaction. begin, part and finish return their stored receipt text; inspect returns a page. */
export function refresh(sql: SqlStorage, who: Who, cmd: RefreshCommand): string | Record<string, unknown> {
	switch (cmd.command) {
		case "inspect": return inspect(sql, cmd);
		case "begin": return begin(sql, who, cmd.header);
		case "part": return applyPart(sql, cmd);
		case "finish": {
			const p = plan(sql, cmd.plan_id);
			if (!p) throw Fail.of("not_found", "no such refresh plan");
			if (p.state === "published") return p.published_receipt!;
			if (p.state !== "applying") throw bad("plan_not_applying", `this plan is ${p.state}`, { state: p.state });
			return publish(sql, cmd.plan_id);
		}
	}
}

/** The import client's recovery view (C20): the active chain, its cursor and every table that differs from its published partition. */
export function refreshStatus(sql: SqlStorage) {
	const id = refreshActive(sql), epoch = epochOf(sql);
	const p = id ? plan(sql, id) : undefined;
	if (!id || !p) return { epoch, refresh: null };
	return { epoch, refresh: { plan_id: id, repo: p.header.repo, state: p.state, next_op: p.next_op, op_count: p.header.op_count, chain: p.chain, base_epoch: p.base_epoch,
		unpublished: FAMILY_ORDER.filter((t) => !same(p.running[t]!, published(sql, t, p.header.repo))), begun_at: p.begun_at } };
}

function inspect(sql: SqlStorage, cmd: { table: string; repo: string; after: Value[] | null; limit?: number }) {
	if (!loadsComplete(sql)) throw bad("incomplete_load", "refresh waits until all five tables are loaded");
	const t = cmd.table, f = REFRESH[t]!, cols = Object.keys(f.columns), local = LOCAL[t]!;
	if (cmd.after && (t === "repos" || cmd.after.length !== local.length)) throw bad("after", `an inspect cursor for ${t} has ${local.length} values`);
	const id = refreshActive(sql), p = id ? plan(sql, id) : undefined;
	const binding = p ? { plan_id: id, next_op: p.next_op, chain: p.chain } : { epoch: epochOf(sql) };
	const prow = partition(sql, t, cmd.repo);
	const limit = Math.min(cmd.limit ?? PART_OPS, PART_OPS);
	const after = cmd.after ? ` AND (${local.join(", ")}) > (${local.map(() => "?").join(", ")})` : "";
	const found = sql.exec(`SELECT ${t === "contributors" ? "rowid, " : ""}${cols.join(", ")} FROM ${t} WHERE ${t === "repos" ? "full_name = ?" : `repo = ?${after}`}
		ORDER BY ${t === "repos" ? "rowid" : local.join(", ")} LIMIT ?`, cmd.repo, ...(cmd.after ?? []), limit + 1).toArray();
	const page: unknown[] = [];
	let scanned = ZERO, size = bytes({ binding, partition: prow ?? null, rows: [], next: null, scanned }) + 2_048;
	for (const r of found.slice(0, limit)) {
		const values = cols.map((c) => r[c] as Value), h = rowHash(t, values), item = [local.map((c) => r[c] as Value), h, bytes(values)];
		if (size + bytes(item) + 1 > PAGE_BYTES) break;
		size += bytes(item) + 1;
		page.push(item);
		scanned = add(scanned, h, 1);
	}
	return { binding, partition: prow ?? null, rows: page, next: page.length < found.length ? (page.at(-1) as [Value[]])[0] : null, scanned };
}

function begin(sql: SqlStorage, who: Who, h: PlanHeader): string {
	checkRow(REPO_KEY, [h.repo], 0);
	if (h.version !== "corpus-refresh/1" || h.projection !== PROJECTION) throw bad("projection", `this store applies ${PROJECTION}`);
	if (FAMILY_ORDER.some((t) => h.schemas[t] !== schemaSha(FAMILIES[t]!))) throw bad("schema_mismatch", "the plan's table DDL is not the retained original");
	if (!h.observed.length || JSON.stringify(h.observed) !== JSON.stringify(FAMILY_ORDER.filter((t) => h.observed.includes(t)))) throw bad("observed", "observed lists families once each, in family order");
	if (Number.isNaN(Date.parse(h.observed_at)) || new Date(h.observed_at).toISOString() !== h.observed_at || Date.parse(h.observed_at) > Date.now() + 300_000) throw bad("observed_at", "observed_at is a normalized UTC time, not in the future");
	const seed = seedOf(who, h), id = planIdOf(who, h);
	const prior = plan(sql, id);
	if (prior) return prior.begin_receipt; // C18: the stored bytes, in any state
	if (h.op_count === 0 && h.chain !== seed) throw bad("chain", "a plan without operations has its seed as its chain");
	if (!loadsComplete(sql)) throw bad("incomplete_load", "refresh waits until all five tables are loaded");
	const pub = Object.fromEntries(FAMILY_ORDER.map((t) => [t, published(sql, t, h.repo)])) as Record<string, Digest>;
	const active = refreshActive(sql);
	let running: Record<string, Digest>, baseEpoch: number;
	if (h.base.kind === "published") {
		if (active) throw Fail.of("busy", "another refresh is active", { reason: "busy", plan_id: active });
		if (h.base.epoch !== epochOf(sql)) throw bad("base_changed", "the published corpus changed since this plan was made");
		[running, baseEpoch] = [pub, h.base.epoch];
	} else {
		const old = plan(sql, h.base.plan_id);
		if (active !== h.base.plan_id || !old || old.state !== "applying" || old.next_op !== h.base.next_op || old.chain !== h.base.chain) throw bad("base_changed", "the active plan moved; read status again");
		if (old.header.repo !== h.repo) throw bad("repo_mismatch", "a takeover refreshes the exact repo of the plan it replaces"); // C16
		[running, baseEpoch] = [old.running, old.base_epoch];
	}
	// C17: an unobserved table must already equal its published partition, physically and as the plan's target.
	const pending = FAMILY_ORDER.filter((t) => !h.observed.includes(t) && (!same(running[t]!, pub[t]!) || !same(h.targets[t]!, pub[t]!)));
	if (pending.length) throw bad("unobserved_changed", "these tables differ from their published partitions; observe them", { tables: pending });
	const empty = FAMILY_ORDER.every((t) => same(h.targets[t]!, ZERO));
	if (h.intent === "refresh" && empty && FAMILY_ORDER.some((t) => pub[t]!.rows > 0)) throw bad("removal_needs_intent", "an empty target for a loaded repo needs the remove intent");
	if (h.intent === "remove" && (h.observed.length !== FAMILY_ORDER.length || !empty)) throw bad("remove_shape", "a removal observes all five tables with empty targets");
	for (const t of h.observed) { // C19: zero-row partitions keep the high-water mark
		const r = partition(sql, t, h.repo);
		if (r && h.observed_at < r.observed_at) throw bad("stale_observation", `this source cut is older than ${t}'s last observation`, { table: t });
	}
	if (h.base.kind === "active") sql.exec("UPDATE corpus_refresh SET state = 'superseded' WHERE plan_id = ?", h.base.plan_id);
	const receipt = JSON.stringify({ status: "active", plan_id: id, next_op: 0, chain: seed });
	sql.exec(`INSERT INTO corpus_refresh (plan_id, header, seed, state, next_op, chain, last, running, base_epoch, begun_at, begin_receipt)
		VALUES (?, ?, ?, 'applying', 0, ?, NULL, ?, ?, ?, ?)`, id, JSON.stringify(h), seed, seed, JSON.stringify(running), baseEpoch, new Date().toISOString(), receipt);
	sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('refresh_active', ?)`, id);
	if (h.op_count) return receipt;
	const done = publish(sql, id);
	sql.exec("UPDATE corpus_refresh SET begin_receipt = ? WHERE plan_id = ?", done, id);
	return done;
}

function applyPart(sql: SqlStorage, cmd: { plan_id: string; start: number; ops: Op[] }): string {
	const hash = sha256(JSON.stringify(cmd.ops));
	const stored = sql.exec<{ sha256: string; receipt: string }>("SELECT sha256, receipt FROM corpus_refresh_parts WHERE plan_id = ? AND start = ?", cmd.plan_id, cmd.start).toArray()[0];
	if (stored) { // C18: exact replay before any state check; nothing moves and no rowid is allocated
		if (stored.sha256 !== hash) throw Fail.of("idempotency_mismatch", "this part was stored with different operations", { reason: "part_changed", plan_id: cmd.plan_id, start: cmd.start });
		return stored.receipt;
	}
	const p = plan(sql, cmd.plan_id);
	if (!p) throw Fail.of("not_found", "no such refresh plan");
	if (p.state !== "applying") throw bad("plan_not_applying", `this plan is ${p.state}`, { state: p.state });
	if (cmd.start !== p.next_op) throw bad(cmd.start < p.next_op ? "stale_part" : "out_of_order", "parts apply at the plan's cursor", { next_op: p.next_op, chain: p.chain });
	if (!cmd.ops.length || cmd.ops.length > PART_OPS || cmd.start + cmd.ops.length > p.header.op_count) throw bad("part_size", `a part holds 1 to ${PART_OPS} operations within the plan`);
	const h = p.header, running = p.running, affected = new Set<string>();
	let written = 0, spent = 0, chain = p.chain, last = p.last ? (JSON.parse(p.last) as [number, string]) : null;
	const run = (q: string, ...a: Value[]) => { const c = sql.exec(q, ...a); const rows = c.toArray(); written += c.rowsWritten; return rows; };
	const spend = (n: number) => { if ((spent += n) > EXPANDED_BYTES) throw Fail.of("size_budget", "this part rewrites more than 5,000,000 bytes of rows and documents; send fewer operations", { reason: "expanded_bytes" }); };
	const replaceDoc = (id: string, next: SearchDoc | null) => {
		const old = run("SELECT rowid AS id, kind, key, repo, date, title, detail FROM corpus_search_documents WHERE evidence_id = ?", id)[0] as Record<string, Value> | undefined;
		if (!old && !next) return;
		if (old && next && (["kind", "key", "repo", "date", "title", "detail"] as const).every((k) => old[k] === next[k])) return;
		if (old) {
			spend(bytes([old.key, old.repo, old.title, old.detail]));
			// Contentless FTS5 forgets a row's terms only through its delete control with the exact indexed values.
			run("INSERT INTO corpus_search_fts (corpus_search_fts, rowid, key, repo, title, detail) VALUES ('delete', ?, ?, ?, ?, ?)", old.id!, old.key!, old.repo!, old.title!, old.detail!);
			if (!next) { run("DELETE FROM corpus_search_documents WHERE rowid = ?", old.id!); return; }
		}
		spend(bytes([next!.key, next!.repo, next!.title, next!.detail]));
		const rowid = old ? old.id! : (run(`INSERT INTO corpus_search_documents (evidence_id, kind, key, repo, date, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS id`,
			next!.evidence_id, next!.kind, next!.key, next!.repo, next!.date, next!.title, next!.detail)[0] as { id: number }).id;
		if (old) run("UPDATE corpus_search_documents SET kind = ?, key = ?, repo = ?, date = ?, title = ?, detail = ? WHERE rowid = ?", next!.kind, next!.key, next!.repo, next!.date, next!.title, next!.detail, rowid);
		run("INSERT INTO corpus_search_fts (rowid, key, repo, title, detail) VALUES (?, ?, ?, ?, ?)", rowid, next!.key, next!.repo, next!.title, next!.detail);
	};
	const doc = (t: string, values: Value[] | null, key: Value[]) => {
		if (t === "commit_paths") return affected.add(String(key[1]));
		if (t === "contributors") return;
		const fam = REFRESH[t]!, row = values ?? null;
		const id = t === "repos" ? `repo:repos:${h.repo}` : t === "commits" ? `commit:commits:${h.repo}@${String(key[0])}` : `ref:refs:${h.repo}:${String(key[0])}`;
		replaceDoc(id, row ? FAMILIES[t]!.search!(named(fam, row)) : null);
	};
	cmd.ops.forEach((op, i) => {
		chain = step(chain, op);
		const [kind, t] = op;
		const f = REFRESH[t];
		if (!f || !h.observed.includes(t)) throw bad("unobserved_op", `operation ${cmd.start + i} names a table this plan does not observe`, { table: t });
		const cols = Object.keys(f.columns);
		const values = kind === "p" ? checkRow(f, op[2], i) : null;
		if (values && values[cols.indexOf(f.repo)] !== h.repo) throw bad("repo", `operation ${cmd.start + i} belongs to another repo`);
		if (values && bytes(values) > ROW_BYTES) throw Fail.of("size_budget", `operation ${cmd.start + i} holds a row over ${ROW_BYTES} bytes`, { reason: "row_bytes" });
		const key = values ? LOCAL[t]!.filter((c) => c !== "rowid").map((c) => values[cols.indexOf(c)]!) : op[2];
		if (kind === "d" && (key.length !== LOCAL[t]!.length || key.some((v) => v === null || (t === "contributors" ? !Number.isSafeInteger(v) : typeof v !== "string")))) throw bad("key", `operation ${cmd.start + i} has a malformed ${t} key`);
		// Fixed group order, then strictly increasing keys by UTF-8 bytes; equal contributor occurrences may repeat (design 3).
		const at = kind === "d" ? DELETE_ORDER.indexOf(t) : 5 + PUT_ORDER.indexOf(t), order = JSON.stringify(t === "contributors" && values ? values : key);
		const cmp = last && last[0] === at ? Buffer.compare(Buffer.from(order), Buffer.from(last[1])) : 1;
		if (last && (at < last[0] || cmp < 0 || (cmp === 0 && !(t === "contributors" && kind === "p")))) throw bad("order", `operation ${cmd.start + i} is out of order`);
		last = [at, order];
		const args = t === "repos" ? [h.repo] : [h.repo, ...key];
		const cur = kind === "p" && t === "contributors" ? undefined : run(`SELECT ${cols.join(", ")} FROM ${t} WHERE ${where(t)}`, ...args)[0] as Record<string, Value> | undefined;
		const old = cur ? cols.map((c) => cur[c]!) : null;
		if (kind === "d") {
			if (!old || rowHash(t, old) !== op[3]) throw bad("precondition", `operation ${cmd.start + i}: the row is not the one this plan inspected`);
			spend(bytes(old));
			run(`DELETE FROM ${t} WHERE ${where(t)}`, ...args);
			running[t] = add(running[t]!, op[3], -1);
			doc(t, null, key);
			return;
		}
		if ((op[3] === null) !== (old === null) || (old && rowHash(t, old) !== op[3])) throw bad("precondition", `operation ${cmd.start + i}: the row is not the one this plan inspected`);
		spend(bytes(values) + (old ? bytes(old) : 0));
		if (old) {
			const set = cols.filter((c) => !LOCAL[t]!.includes(c) && c !== "repo" && c !== "full_name");
			run(`UPDATE ${t} SET ${set.map((c) => `${c} = ?`).join(", ")} WHERE ${where(t)}`, ...set.map((c) => values![cols.indexOf(c)]!), ...args);
			running[t] = add(running[t]!, op[3]!, -1);
		} else {
			run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values!); // rowid tables: the server allocates the rowid
		}
		running[t] = add(running[t]!, rowHash(t, values!), 1);
		doc(t, values, key);
	});
	for (const path of affected) { // design 5: the surviving row with the smallest sha represents a shared (repo, path)
		const r = run("SELECT sha, top_component, extension FROM commit_paths WHERE repo = ? AND path = ? ORDER BY sha LIMIT 1", h.repo, path)[0] as Record<string, Value> | undefined;
		replaceDoc(`path:commit_paths:${h.repo}:${path}`, r ? FAMILIES.commit_paths!.search!({ repo: h.repo, path, ...r }) : null);
	}
	const next = cmd.start + cmd.ops.length;
	run("UPDATE corpus_refresh SET next_op = ?, chain = ?, last = ?, running = ? WHERE plan_id = ?", next, chain, JSON.stringify(last), JSON.stringify(running), cmd.plan_id);
	// The receipt's own INSERT writes one row; include it before serializing the exact replay bytes.
	const receipt = JSON.stringify({ status: "stored", plan_id: cmd.plan_id, start: cmd.start, count: cmd.ops.length, next_op: next, chain, rows_written: written + 1, expanded_bytes: spent });
	sql.exec("INSERT INTO corpus_refresh_parts (plan_id, start, count, sha256, receipt, received_at) VALUES (?, ?, ?, ?, ?, ?)", cmd.plan_id, cmd.start, cmd.ops.length, hash, receipt, new Date().toISOString());
	return receipt;
}

function publish(sql: SqlStorage, id: string): string {
	const p = plan(sql, id)!, h = p.header;
	if (p.next_op !== h.op_count || p.chain !== h.chain) throw bad("incomplete", "this plan has operations left or does not end on its chain", { next_op: p.next_op });
	for (const t of FAMILY_ORDER) {
		if (!same(p.running[t]!, h.targets[t]!)) throw bad("target_mismatch", `${t} does not match the plan's target`, { table: t, expected: h.targets[t], actual: p.running[t] });
		if (!h.observed.includes(t) && !same(p.running[t]!, published(sql, t, h.repo))) throw bad("unobserved_changed", "an unobserved table changed", { tables: [t] });
	}
	const epoch = epochOf(sql);
	if (epoch !== p.base_epoch) throw bad("base_changed", "the published corpus changed under this plan");
	const now = new Date().toISOString();
	for (const t of h.observed) { // C19: a removal writes zero-row partitions; publication never deletes one
		const d = p.running[t]!, before = published(sql, t, h.repo);
		sql.exec(`INSERT INTO corpus_partitions (table_name, part, rows, sum, basis, source_kind, source_id, projection, observed_at, revision, plan_id)
			VALUES (?, ?, ?, ?, 'observed', ?, ?, ?, ?, 1, ?) ON CONFLICT (table_name, part) DO UPDATE SET rows = excluded.rows, sum = excluded.sum, basis = 'observed',
			source_kind = excluded.source_kind, source_id = excluded.source_id, projection = excluded.projection, observed_at = excluded.observed_at,
			revision = corpus_partitions.revision + 1, plan_id = excluded.plan_id`, t, part(h.repo), d.rows, d.sum, h.source.kind, h.source.id, h.projection, h.observed_at, id);
		sql.exec("UPDATE corpus_meta SET rows = rows + ?, updated_at = ? WHERE table_name = ?", d.rows - before.rows, now, t);
	}
	const receipt = JSON.stringify({ status: "published", plan_id: id, epoch: epoch + 1, observed_at: h.observed_at, targets: h.targets });
	sql.exec(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('epoch', ?)`, String(epoch + 1));
	sql.exec(`DELETE FROM ${META} WHERE key = 'refresh_active'`);
	sql.exec("UPDATE corpus_refresh SET state = 'published', published_at = ?, published_receipt = ? WHERE plan_id = ?", now, receipt, id);
	return receipt;
}
