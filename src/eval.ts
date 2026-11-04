// eval_runs (R1): POST /v1/eval/runs validation and the account table. Scores and counts only; reports stay local.
import { z } from "zod";
import type { Outcome } from "./domain/types";
import { fail, ok, PROFILE_NAME } from "./domain/types";
import type { EvalRun, EvalRunInput } from "./viewer/types";

const score = z.number().finite().min(0).max(1);
const runSchema = z.object({
	profile: z.string().regex(PROFILE_NAME),
	at: z.string().max(40).refine((s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)), "must be an ISO date-time"),
	channels: z.enum(["lexical", "vector", "hybrid"]),
	k: z.number().int().min(1).max(100),
	cases: z.number().int().min(0).max(10_000),
	recall_all_at_k: score, any_hit_at_k: score, mrr: score,
}).strict() satisfies z.ZodType<EvalRunInput>;
const LIST_MAX = 500;

/** Validates the job-token body; unknown fields and out-of-range scores are refused. */
export function parseEvalRun(raw: unknown): Outcome<EvalRunInput> {
	const p = runSchema.safeParse(raw);
	return p.success ? ok(p.data) : fail("validation", p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ").slice(0, 500));
}

export function insertEvalRun(sql: SqlStorage, run: EvalRun): void {
	sql.exec(`INSERT INTO eval_runs (id, profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.id, run.profile, run.at, run.channels, run.k, run.cases, run.recall_all_at_k, run.any_hit_at_k, run.mrr, run.device_id);
}

/** Newest first; limit 1 to 500. */
export function listEvalRuns(sql: SqlStorage, q: { profile?: string; limit: number }): EvalRun[] {
	const limit = Math.min(Math.max(Math.trunc(q.limit), 1), LIST_MAX);
	return sql.exec<EvalRun & Record<string, SqlStorageValue>>(`SELECT id, profile, at, channels, k, cases, recall_all_at_k, any_hit_at_k, mrr, device_id FROM eval_runs
		WHERE ?1 IS NULL OR profile = ?1 ORDER BY at DESC, id DESC LIMIT ?2`, q.profile ?? null, limit).toArray();
}
