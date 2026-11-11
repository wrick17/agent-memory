// Repo facts P1 (#92, #93, #95): per-session orchestration on this device. It keeps each session's command digest as the transcript
// grows, builds one report when the session has ended, saves its exact bytes before sending, and keeps the local disjointness
// ledger. Only the run-lock holder calls observeSession and flushPending, so every file here has one writer (the SessionStart hook
// writes only facts/seen/, through facts-inject.mjs).
//
// Files under <home>/facts/, all private:
//   sessions/<client>-<session>.json  { repo_key, remote, root, read_to, digest, report: { bytes, status, pending, reply? } }
//   ledger/<repo>.json                { profile, facts: { <fact_key>: [{ session, files }] } }: this device's confirming chain
//   registry/<repo>.json              { profile, facts: { <fact_key>: { detector, literal } } }: facts reported or proposed here
//   seen/<repo>.json                  { facts: [{ fact_key, detector, literal }] }: the last injection read
//   digests/<repo>/<session>.json     the newest 16 completed session digests, for synthesis (P2)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { home, readJson, readLines, safeName, writePrivate } from "./agent-memory.mjs";
import { commandDigest, mergeDigest, repoKey } from "./facts.mjs";
import { detect, factKey, familyHash, DETECT_LIMITS } from "./facts-detect.mjs";

/** Completed digests kept per repo for synthesis. */
export const RETAINED_DIGESTS = 16;
const PROFILE_RE = /^[a-z][a-z0-9-]{0,11}$/;

const dir = (...p) => path.join(home(), "facts", ...p);
const repoId = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const sessionFile = (client, session) => dir("sessions", `${client}-${safeName(session)}.json`);
const ledgerFile = (key) => dir("ledger", `${repoId(key)}.json`);
const registryFile = (key) => dir("registry", `${repoId(key)}.json`);
export const seenFile = (key) => dir("seen", `${repoId(key)}.json`);
const digestDir = (key) => dir("digests", repoId(key));

/** The explicit profile for fact routes: config.facts.profile when valid and not `me`, else none (the server routes by the remote). */
export const factsProfile = (config) => { const p = config?.facts?.profile; return typeof p === "string" && PROFILE_RE.test(p) && p !== "me" ? p : null; };

/** Facts this device knows for a repo: its own reported and accepted proposed facts, and the last injection read. */
export function known(key) {
	const out = new Map();
	for (const [k, f] of Object.entries(readJson(registryFile(key), {})?.facts ?? {})) if (f?.detector && f?.literal) out.set(k, { detector: f.detector, literal: f.literal });
	for (const f of readJson(seenFile(key), {})?.facts ?? []) if (f?.detector && f?.literal) out.set(factKey(f.detector, f.literal), { detector: f.detector, literal: f.literal });
	return [...out.values()];
}

/**
 * The report body for a completed session, pure: the same digest, known facts, ledger and profile always give the same body. A confirm
 * lists, in disjoint_from, the prior confirming sessions of this device's chain whose edited-file sets it does not overlap (an empty set
 * overlaps nothing). Without local history for a fact (a new fact, or a lost or reset ledger) disjoint_from is left out: unknown is never
 * proof. pending holds, per confirm, what settle adds to the ledger once the server accepts it.
 * @returns {{ body: object, pending: Record<string, { disjoint_from: string[] | null, files: string[] }> }}
 */
export function reportBody(digest, key, { known: facts = [], ledger = {}, profile = null } = {}) {
	const { observations, fired, labels } = detect(digest, { known: facts });
	const mine = new Set(digest.files);
	const pending = {};
	const obs = observations.map((o) => {
		const base = { fact_key: o.fact_key, kind: o.kind, detector: o.detector, statement: o.statement, literal: o.literal, family: familyHash(key, o.label) };
		if (o.kind !== "confirm") return base;
		const chain = ledger[o.fact_key];
		const disjoint = Array.isArray(chain) && chain.length ? chain.filter((c) => Array.isArray(c.files) && c.files.every((h) => !mine.has(h))).map((c) => c.session).sort().slice(-8) : null;
		pending[o.fact_key] = { disjoint_from: disjoint, files: [...mine].sort() };
		return disjoint ? { ...base, disjoint_from: disjoint } : base;
	});
	// Families: known facts' triggers first, then the session's other triggers, so the server can count exercise for facts proposed elsewhere.
	const wanted = new Set(obs.map((o) => o.family));
	const fams = [...new Set(labels.map((l) => familyHash(key, l)))].sort((a, b) => (wanted.has(b) - wanted.has(a)) || (a < b ? -1 : 1)).slice(0, DETECT_LIMITS.max).sort();
	return { body: { repo: { remote: key }, repo_key: key, ...(profile ? { profile } : {}), facts: { session: digest.session, families: fams, fired, observations: obs } }, pending };
}

function buildReport(digest, key, config) {
	const { body, pending } = reportBody(digest, key, { known: known(key), ledger: readJson(ledgerFile(key), {})?.facts ?? {}, profile: factsProfile(config) });
	return { bytes: JSON.stringify(body), status: "pending", pending };
}

/** The registry for a repo as the routed profile holds it; a profile change means this device's knowledge there is unknown. */
function registryFor(key, profile) {
	const r = readJson(registryFile(key), null);
	return r && r.profile === profile && r.facts && typeof r.facts === "object" ? r : { profile, facts: {} };
}

/**
 * Records facts the server accepted from a synthesis proposal (P2), so later completed sessions on this device can confirm them with
 * their own evidence (a known repair's fix reused with a proven success, or the detector seeing the failure again). A proposal never
 * confirms anything itself. profile is the profile the server routed the proposal to (its reply's profile).
 * @param {string} key repo key @param {string | null} profile @param {{ detector: string, literal: string }[]} facts accepted proposals
 */
export function rememberProposals(key, profile, facts) {
	const registry = registryFor(key, profile);
	for (const f of Array.isArray(facts) ? facts : []) if (typeof f?.detector === "string" && typeof f?.literal === "string") registry.facts[factKey(f.detector, f.literal)] = { detector: f.detector, literal: f.literal };
	writePrivate(registryFile(key), JSON.stringify(registry));
}

function retain(key, digest) {
	const d = digestDir(key);
	writePrivate(path.join(d, `${safeName(digest.session)}.json`), JSON.stringify(digest));
	const files = fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ f, at: readJson(path.join(d, f), {})?.ended_at ?? "" })).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	for (const { f } of files.slice(RETAINED_DIGESTS)) fs.rmSync(path.join(d, f), { force: true });
}

/** Applies a reply: ledger chains as the server keeps them, local keys dropped for forgotten or retired facts. Idempotent per session. */
function settle(state, reply) {
	const key = state.repo_key, report = state.report, session = state.digest.session;
	const lf = ledgerFile(key), rf = registryFile(key);
	let ledger = readJson(lf, null);
	// Routing moved the repo to another profile: this device's history there is unknown.
	if (!ledger || ledger.profile !== reply.profile) ledger = { profile: reply.profile ?? null, facts: {} };
	const registry = registryFor(key, reply.profile ?? null), seen = readJson(seenFile(key), null);
	const sent = new Map(JSON.parse(report.bytes).facts.observations.map((o) => [o.fact_key, o]));
	for (const r of Array.isArray(reply?.report?.facts) ? reply.report.facts : []) {
		const o = sent.get(r.fact_key);
		if (r.status === "refused" && (r.reason === "fact_forgotten" || r.reason === "fact_retired")) {
			// No permanent suppression: the server refuses the key itself, and an owner restore must work again.
			delete ledger.facts[r.fact_key]; delete registry.facts[r.fact_key];
			if (seen?.facts) seen.facts = seen.facts.filter((f) => factKey(f.detector, f.literal) !== r.fact_key);
			continue;
		}
		if ((r.status === "stored" || r.status === "seen") && o) {
			registry.facts[r.fact_key] = { detector: o.detector, literal: o.literal };
			const p = report.pending?.[r.fact_key];
			if (o.kind === "confirm" && p) {
				const chain = (ledger.facts[r.fact_key] ?? []).filter((c) => c.session !== session && (p.disjoint_from ?? []).includes(c.session));
				ledger.facts[r.fact_key] = [...chain, { session, files: p.files }];
			}
			if (r.state === "retired") { delete ledger.facts[r.fact_key]; delete registry.facts[r.fact_key]; }
		}
	}
	writePrivate(lf, JSON.stringify(ledger));
	writePrivate(rf, JSON.stringify(registry));
	if (seen) writePrivate(seenFile(key), JSON.stringify(seen));
}

/** Sends a saved report once more (same bytes). Network trouble keeps it pending; a refusal by the server settles it. */
async function send(file, state, server) {
	if (state.report?.status !== "pending" || typeof server?.facts !== "function") return state.report?.status ?? null;
	let reply;
	try { reply = await server.facts(state.report.bytes); } catch (e) {
		// 400 (a changed report for this session, or a body the server will never take) and 403 (not allowed) are final; 409, 503 and the network are not.
		if (e?.status === 400 || e?.status === 403) { state.report.status = "refused"; state.report.reason = e.error?.code ?? `http_${e.status}`; writePrivate(file, JSON.stringify(state)); }
		return state.report.status;
	}
	settle(state, reply);
	state.report.status = "sent";
	state.report.reply = { profile: reply?.profile ?? null, action: reply?.report?.action ?? null };
	// The digest is kept in digests/ for synthesis; the session file keeps only what stops a second, different report.
	delete state.digest.commands;
	writePrivate(file, JSON.stringify(state));
	return "sent";
}

const topLevel = (cwd) => {
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return null;
	const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
	return r.status === 0 ? r.stdout.trim() : cwd;
};

/**
 * One step of a session, called by processSession with the trigger, its found transcript and repoOf(cwd). Reads the transcript from
 * this module's own cursor, merges new commands by call id, and once the session has ended builds and saves its one report, then sends
 * it. Never throws to the caller's capture path; a repo without a GitHub origin is skipped.
 * @returns {Promise<{ repo_key: string, session?: string, completed: boolean, status: string } | null>} completed is true only on the call that
 * built the report, which also names the session ref (synthesis cadence counts it)
 */
export async function observeSession(t, src, repo, { server, ended, config } = {}) {
	const key = repoKey(repo?.remote);
	if (!key || typeof t?.session !== "string") return null;
	const file = sessionFile(t.client, t.session);
	const state = readJson(file, null) ?? { v: 1, repo_key: key, remote: repo.remote, root: topLevel(t.cwd), read_to: 0, digest: null, report: null };
	if (state.report) return { repo_key: state.repo_key, completed: false, status: await send(file, state, server) };
	let size = 0;
	try { size = fs.statSync(src).size; } catch { return { repo_key: key, completed: false, status: "source_missing" }; }
	// A transcript that shrank was rewritten: read it again from the start; commands already held merge by call id.
	if (size < state.read_to) state.read_to = 0;
	if (size > state.read_to) {
		const { end, lines } = readLines(src, state.read_to);
		const next = commandDigest(t.client, lines, { repoKey: key, session: t.session, cwd: t.cwd ?? undefined, root: state.root ?? undefined, prior: state.digest });
		state.digest = mergeDigest(state.digest, next);
		state.read_to = end;
	}
	// Only a session the existing pipeline marks ended (SessionEnd, sticky) is complete; a Stop can still be followed by more commands.
	if (!ended || !state.digest) { writePrivate(file, JSON.stringify(state)); return { repo_key: key, completed: false, status: "open" }; }
	retain(key, state.digest);
	// Synthesis cadence (facts-synth.mjs): the durable completion marker comes before the report is saved, so a crash between the two
	// only writes the same marker again when the report is rebuilt. Off: no marker.
	(await import("./facts-synth.mjs")).markCompleted(config, key, state.digest.session);
	state.report = buildReport(state.digest, key, config);
	writePrivate(file, JSON.stringify(state));
	return { repo_key: key, session: state.digest.session, completed: true, status: await send(file, state, server) };
}

/** Whether any saved report is still pending (sent, refused and 400-final reports are not), for the scheduled run's idle check. */
export function hasPending() {
	const d = dir("sessions");
	if (!fs.existsSync(d)) return false;
	return fs.readdirSync(d).some((f) => f.endsWith(".json") && readJson(path.join(d, f), null)?.report?.status === "pending");
}

/** Sends every saved report still pending (after a network failure or a crash between saving and sending). */
export async function flushPending(server) {
	const d = dir("sessions");
	const out = { sent: 0, pending: 0, refused: 0 };
	for (const f of fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith(".json")).sort() : []) {
		const file = path.join(d, f), state = readJson(file, null);
		if (state?.report?.status !== "pending") continue;
		const s = await send(file, state, server);
		out[s === "sent" ? "sent" : s === "refused" ? "refused" : "pending"]++;
	}
	return out;
}

/** The newest completed, redacted digests of a repo, newest first, for synthesis (P2). Never a transcript. */
export function recentDigests(key, limit = 8) {
	const d = digestDir(key);
	if (!fs.existsSync(d)) return [];
	return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(d, f), null)).filter((x) => x?.repo === key)
		.sort((a, b) => (a.ended_at < b.ended_at ? 1 : a.ended_at > b.ended_at ? -1 : 0)).slice(0, limit);
}
