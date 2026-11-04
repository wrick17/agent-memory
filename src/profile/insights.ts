// Activity summary and project profile (IN1), computed on request within the existing graph work budgets.
import type { ActivitySummary, ActivitySummaryQuery, ProjectProfile, ProjectSummary } from "../viewer/types";

export function activitySummary(_sql: SqlStorage, q: ActivitySummaryQuery): ActivitySummary {
	return { from: q.from, to: q.to, active_days: 0, sessions: 0, observations: 0, busiest_day: null, days: [],
		kinds: { asks: 0, decisions: 0, corrections: 0, commits: 0, tests: 0, prs: 0 }, top_files: [], busiest_sessions: [], latest: [] }; // stub: IN1
}
export function listProjects(_sql: SqlStorage): ProjectSummary[] {
	return []; // stub: IN1
}
/** null when no project node has this key. */
export function projectProfile(_sql: SqlStorage, _key: string, _now: string): ProjectProfile | null {
	return null; // stub: IN1
}
