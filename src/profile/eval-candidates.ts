// eval_candidates (R1): suggest_eval_case results the owner accepts or dismisses on the Health tab.
import { redactText } from "../domain/redact";
import { EVIDENCE_KINDS, Fail } from "../domain/types";
import type { EvalCandidate, EvalCandidateQuery, EvalCandidateStatus, Evidence, Page, SuggestEvalCaseOp } from "../viewer/types";
import { assertOpen } from "./wipe";

export const QUERY_MAX = 280;
const REFS_MAX = 20, PAGE_DEFAULT = 50, PAGE_MAX = 100;
const STATUSES: readonly EvalCandidateStatus[] = ["pending", "accepted", "dismissed"];

type Row = { id: string; query: string; expected_json: string; evidence_json: string; status: EvalCandidateStatus; created_at: string };

/**
 * A row naming any id with a local `wiped:` fence is never shown, decided or exported. A wipe fences ids before its purge
 * pages remove the rows, so this keeps a purged node's query text out of every read in between.
 */
const UNFENCED = `NOT EXISTS (SELECT 1 FROM json_each(c.expected_json) x JOIN profile_meta m ON m.key = 'wiped:' || x.value)
	AND NOT EXISTS (SELECT 1 FROM json_each(c.evidence_json) e JOIN profile_meta m ON m.key = 'wiped:' || json_extract(e.value, '$.ref')
		WHERE json_extract(e.value, '$.kind') = 'node')`;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const candidate = (r: Row): EvalCandidate => ({
	id: r.id, query: r.query, expected: JSON.parse(r.expected_json) as string[], evidence: JSON.parse(r.evidence_json) as Evidence[], status: r.status, created_at: r.created_at,
});

/** Validates and redacts the op's fields; M1's schema already bounds them, and storage checks them again. */
function clean(op: Omit<SuggestEvalCaseOp, "op">): { query: string; expected: string[]; evidence: Evidence[] } {
	const bad = (why: string) => Fail.of("validation", `suggest_eval_case: ${why}`);
	if (!text(op?.query, QUERY_MAX)) throw bad(`query is 1 to ${QUERY_MAX} characters`);
	if (!Array.isArray(op.expected) || op.expected.length < 1 || op.expected.length > REFS_MAX || !op.expected.every((id) => text(id, 128))) throw bad(`expected is 1 to ${REFS_MAX} node ids`);
	if (!Array.isArray(op.evidence) || op.evidence.length < 1 || op.evidence.length > REFS_MAX) throw bad(`evidence is 1 to ${REFS_MAX} pointers`);
	const evidence = op.evidence.map((e) => {
		if (!e || typeof e !== "object" || !(EVIDENCE_KINDS as readonly string[]).includes(e.kind) || !text(e.ref, 512) || (e.note !== undefined && (typeof e.note !== "string" || e.note.length > 512))
			|| Object.keys(e).some((k) => !["kind", "ref", "note"].includes(k))) throw bad("each evidence pointer is { kind, ref, note? }");
		return { kind: e.kind, ref: e.kind === "node" ? e.ref : redactText(e.ref), ...(e.note !== undefined ? { note: redactText(e.note) } : {}) };
	});
	return { query: redactText(op.query.trim()), expected: [...new Set(op.expected)], evidence };
}

/**
 * Runs inside the caller's transaction (M1's suggest_eval_case path). Throws Fail "profile_wiped" when an expected id or a
 * node evidence ref has a local `wiped:` fence, so no candidate can name a purged node. Ids from another profile are allowed,
 * and their fences are checked the same way. A repeated id returns the stored candidate unchanged.
 */
export function insertCandidate(sql: SqlStorage, seq: number, now: string, id: string, op: Omit<SuggestEvalCaseOp, "op">): EvalCandidate {
	if (!text(id, 128) || typeof now !== "string" || Number.isNaN(Date.parse(now))) throw Fail.of("validation", "insertCandidate takes an id and an ISO time");
	assertOpen(sql);
	const c = clean(op);
	const refs = [...c.expected, ...c.evidence.filter((e) => e.kind === "node").map((e) => e.ref)];
	if (sql.exec("SELECT 1 FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM profile_meta WHERE key = 'wiped:' || j.value) LIMIT 1", JSON.stringify(refs)).toArray().length)
		throw Fail.of("profile_wiped", "an eval candidate cannot name a record a profile wipe purged");
	const prior = sql.exec<Row>("SELECT * FROM eval_candidates WHERE id = ?", id).toArray()[0];
	if (prior) return candidate(prior);
	sql.exec("INSERT INTO eval_candidates (id, query, expected_json, evidence_json, status, created_at, seq) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
		id, c.query, JSON.stringify(c.expected), JSON.stringify(c.evidence), now, seq);
	return { id, ...c, status: "pending", created_at: now };
}

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function after(cursor: string | null | undefined): [string, string] {
	if (!cursor) return ["", ""];
	try {
		const v = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
		if (Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === "string" && s.length <= 128)) return v as [string, string];
	} catch { /* falls through to the refusal */ }
	throw Fail.of("validation", "cursor is not valid");
}

/** Oldest first, by creation time then id. status defaults to pending; limit 1 to 100, default 50. */
export function listCandidates(sql: SqlStorage, q: EvalCandidateQuery): Page<EvalCandidate> {
	const status = q.status ?? "pending";
	if (status !== "all" && !STATUSES.includes(status)) throw Fail.of("validation", "status is pending, accepted, dismissed or all");
	const limit = Math.min(Math.max(Math.trunc(q.limit ?? PAGE_DEFAULT), 1), PAGE_MAX);
	const [at, id] = after(q.cursor);
	const rows = sql.exec<Row>(`SELECT c.id, c.query, c.expected_json, c.evidence_json, c.status, c.created_at FROM eval_candidates c
		WHERE (?1 = 'all' OR c.status = ?1) AND (c.created_at, c.id) > (?2, ?3) AND ${UNFENCED} ORDER BY c.created_at, c.id LIMIT ?4`, status, at, id, limit + 1).toArray();
	const page = rows.slice(0, limit), last = page[page.length - 1];
	return { rows: page.map(candidate), next_cursor: rows.length > limit && last ? b64([last.created_at, last.id]) : null };
}

/** null when the id is unknown. Deciding an already decided candidate returns it unchanged. */
export function decideCandidate(sql: SqlStorage, seq: number, id: string, status: Exclude<EvalCandidateStatus, "pending">): EvalCandidate | null {
	if (status !== "accepted" && status !== "dismissed") throw Fail.of("validation", "a decision is accepted or dismissed");
	assertOpen(sql);
	const row = sql.exec<Row & { open: number }>(`SELECT c.*, (${UNFENCED}) AS open FROM eval_candidates c WHERE c.id = ?`, id).toArray()[0];
	if (!row) return null;
	if (!row.open) throw Fail.of("profile_wiped", "this eval candidate names a record a profile wipe purged");
	if (row.status !== "pending") return candidate(row);
	sql.exec("UPDATE eval_candidates SET status = ?, seq = ? WHERE id = ?", status, seq, id);
	return candidate({ ...row, status });
}

/** Accepted candidates for `agent-memory eval export-candidates`, oldest first. */
export function acceptedCandidates(sql: SqlStorage, cursor: string | null, limit: number): Page<EvalCandidate> {
	return listCandidates(sql, { status: "accepted", ...(cursor ? { cursor } : {}), limit });
}
