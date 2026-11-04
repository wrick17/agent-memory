// Compile-only: tsc types each v2 sample against the X0 contracts. Nothing imports or runs this file.
import type {
	ActivitySummary, ClientStatusRow, EvalCandidate, EvalRun, HealthReport, Page, ProfileSessionRow, ProjectProfile,
	ProjectSummary, RecallStrength, ReplayEvent, SessionDetail, SessionRow, Snapshot, V2Routes, ViewerEvent,
} from "../../../src/viewer/types";
import acceptedCandidates from "./accepted-candidates.json";
import activitySummaryEmpty from "./activity-summary-empty.json";
import activitySummary from "./activity-summary.json";
import clientStatus from "./client-status.json";
import evalCandidates from "./eval-candidates.json";
import evalRuns from "./eval-runs.json";
import health from "./health.json";
import projectProfile from "./project-profile.json";
import projects from "./projects.json";
import queue from "./queue.json";
import replayEvents from "./replay-events.json";
import sessionDetail from "./session-detail.json";
import sessions from "./sessions.json";
import snapshot from "./snapshot.json";
import strength from "./strength.json";
import viewerEvents from "./viewer-events.json";
import whoamiDevice from "./whoami-device.json";

// shortcut: JSON imports widen string literals to string, so string-literal unions are checked as string and extra keys
// pass. Keys, nesting, numbers and null-versus-value are exact. Upgrade to a runtime schema check if a sample drifts.
// Index-signature values also allow undefined: tsc unions array elements and marks keys missing from one as `?: undefined`.
type Wire<T> = T extends string ? string
	: T extends number | boolean | null | undefined ? T
	: T extends readonly (infer U)[] ? Wire<U>[]
	: T extends object ? (string extends keyof T ? Record<string, Wire<T[keyof T]> | undefined> : { [K in keyof T]: Wire<T[K]> })
	: T;

void (snapshot satisfies Wire<Snapshot>);
void (sessions satisfies Wire<Page<ProfileSessionRow>>);
void (sessions satisfies Wire<Page<SessionRow>>);
void (sessionDetail satisfies Wire<SessionDetail>);
void (replayEvents satisfies Wire<ReplayEvent[]>);
void (activitySummary satisfies Wire<ActivitySummary>);
void (activitySummaryEmpty satisfies Wire<ActivitySummary>);
void (projects satisfies Wire<{ projects: ProjectSummary[] }>);
void (projectProfile satisfies Wire<ProjectProfile>);
void (health satisfies Wire<HealthReport>);
void (evalRuns satisfies Wire<{ runs: EvalRun[] }>);
void (evalCandidates satisfies Wire<Page<EvalCandidate>>);
void (clientStatus satisfies Wire<ClientStatusRow>);
void (viewerEvents satisfies Wire<ViewerEvent[]>);
void (whoamiDevice satisfies Wire<V2Routes["GET /v1/whoami"]["reply"]>);
void (strength satisfies Wire<{ strength: Record<string, RecallStrength> }>);
void (acceptedCandidates satisfies Wire<V2Routes["GET /v1/eval/candidates"]["reply"]>);
void (queue satisfies Wire<V2Routes["POST /api/profiles/:p/maintenance/queue"]["reply"]>);
void (queue satisfies Wire<V2Routes["POST /api/profiles/:p/sessions/:id/consolidate"]["reply"]>);
