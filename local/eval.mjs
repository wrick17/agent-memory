// `agent-memory eval` (EV1). Reads golden-query cases, calls POST /v1/recall with the read token and count_hits: false, writes the
// report on this machine, and sends only scores and counts to POST /v1/eval/runs with the job token.
// The profile is always the caller's explicit --profile; nothing is routed from cwd, remote or text.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { expandHome, home, httpServer, loadConfig, readServer, writePrivate } from "./agent-memory.mjs";
import { baselineDecision, casesOf, checkRun, isId, isProfile, runCases, runSummary } from "./eval-score.mjs";

/** @typedef {import("./eval-score.mjs").EvalCase} EvalCase */
/** @typedef {import("./eval-score.mjs").Channels} Channels */

export { CHANNELS, recallRequest, runSummary } from "./eval-score.mjs";

const PAGE = 100, MAX_PAGES = 10_000;
const keyOf = (c) => JSON.stringify([c.query, [...c.expected].sort()]);

function readDoc(file) {
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`${file}: cannot read (${e.code ?? e.message})`); }
	try { return JSON.parse(text); } catch { throw new Error(`${file}: not JSON`); }
}

/** Cases in the golden-query schema (schema_version 1), normalized. Throws on an unreadable or invalid file. @returns {EvalCase[]} */
export function readCases(file) {
	return casesOf(readDoc(file), file);
}

/**
 * Runs every case with the read token (count_hits: false) and returns the report; see runCases in eval-score.mjs.
 * @param {{ cases: EvalCase[], profile: string, channels: Channels, k: number, read?: { recall(body: object): Promise<object> }, now?: () => number }} opts
 */
export async function runEval({ read, ...opts }) {
	checkRun(opts);
	return runCases({ ...opts, read: read ?? readServer(loadConfig()) });
}

/**
 * --write-baseline: the baseline only rises (baselineDecision in eval-score.mjs); otherwise the file stays as it is.
 * `summary` may carry extra label fields, such as the synthetic gate's `source`; only the metrics, channels and k are compared.
 * → { written: boolean, reason?: string }
 */
export function writeBaseline(file, summary) {
	let old = null;
	if (fs.existsSync(file)) {
		try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { written: false, reason: "the existing baseline is not JSON; it was left unchanged" }; }
	}
	const d = baselineDecision(old, summary);
	if (!d.write) return { written: false, reason: d.reason };
	// Content-free and meant to be committed with the synthetic set, so it is not private.
	writePrivate(file, `${JSON.stringify(summary, null, 2)}\n`, 0o644);
	return { written: true };
}

function checkCandidate(row) {
	const ok = row && typeof row === "object" && isId(row.id) && (row.status === undefined || row.status === "accepted")
		&& typeof row.query === "string" && row.query.trim() && row.query.length <= 280
		&& Array.isArray(row.expected) && row.expected.length >= 1 && row.expected.length <= 20 && row.expected.every(isId);
	if (!ok) throw new Error(`candidate ${isId(row?.id) ? row.id : "(no id)"}: not a valid accepted candidate`);
	return { id: row.id, query: row.query, expected: [...new Set(row.expected)], ...(typeof row.created_at === "string" ? { created_at: row.created_at } : {}) };
}

/**
 * `eval export-candidates --profile P --out FILE`: appends accepted candidates to a local case file.
 * server is readServer(config) from agent-memory.mjs (read token only, never httpServer's job token); it pages with
 * server.acceptedCandidates({ profile, cursor?, limit? }) → GET /v1/eval/candidates → { rows, next_cursor }, 100 a page,
 * next_cursor 1 to 2048 characters or null. The golden-query file itself is refused as --out.
 * Every page is read and checked before the file changes; one atomic write appends the new cases and keeps the rest of the file.
 * @returns {Promise<{ appended: number }>}
 */
export async function exportCandidates({ profile, out, server }) {
	if (!isProfile(profile)) throw new Error("--profile is required: a profile name such as work or personal");
	if (typeof out !== "string" || !out) throw new Error("--out FILE is required");
	const doc = fs.existsSync(out) ? readDoc(out) : { schema_version: 1, cases: [] };
	const have = casesOf(doc, out);
	// The owner-selected golden file holds exactly 30 cases; candidates go to a separate case file.
	if (doc.classification === "private-memory-fixture" || doc.cases.some((c) => c?.hosted_call !== undefined)) throw new Error(`${out}: this is the golden-query file; export candidates to a separate case file`);
	const ids = new Set(have.map((c) => c.id)), keys = new Set(have.map(keyOf));
	const added = [];
	const cursors = new Set();
	let cursor = null;
	for (let page = 0; ; page++) {
		if (page >= MAX_PAGES) throw new Error("export-candidates: too many pages");
		const r = await server.acceptedCandidates({ profile, ...(cursor ? { cursor } : {}), limit: PAGE });
		if (!Array.isArray(r?.rows) || !(r.next_cursor === null || (typeof r.next_cursor === "string" && r.next_cursor.length >= 1 && r.next_cursor.length <= 2048))) throw new Error("export-candidates: unexpected reply");
		for (const c of r.rows.map(checkCandidate)) {
			if (ids.has(c.id) || keys.has(keyOf(c))) continue;
			ids.add(c.id);
			keys.add(keyOf(c));
			added.push(c);
		}
		if (!r.next_cursor) break;
		if (cursors.has(r.next_cursor)) throw new Error("export-candidates: the server repeated a cursor");
		cursors.add(cursor = r.next_cursor);
	}
	if (added.length) writePrivate(out, `${JSON.stringify({ ...doc, cases: [...doc.cases, ...added] }, null, 2)}\n`);
	return { appended: added.length };
}

const HELP = (prog) => `usage: ${prog} --cases FILE --profile P [--channels lexical|vector|hybrid] [--k 5] [--out FILE] [--write-baseline FILE]
       ${prog} export-candidates --profile P --out FILE
The profile is required and is never inferred. The report stays on this machine; only scores and counts are uploaded.
`;

/**
 * `agent-memory eval --cases FILE --profile P [--channels lexical|vector|hybrid] [--k 5] [--out FILE] [--write-baseline FILE]`
 * and `agent-memory eval export-candidates --profile P --out FILE`. Resolves to the exit code.
 */
export async function main(argv, prog = "agent-memory eval") {
	const exporting = argv[0] === "export-candidates";
	let values;
	try {
		({ values } = parseArgs({ args: exporting ? argv.slice(1) : argv, strict: true, allowPositionals: false, options: exporting
			? { profile: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } }
			: { cases: { type: "string" }, profile: { type: "string" }, channels: { type: "string", default: "hybrid" }, k: { type: "string", default: "5" },
				out: { type: "string" }, "write-baseline": { type: "string" }, help: { type: "boolean" } } }));
	} catch (e) {
		process.stderr.write(`${prog}: ${e.message}\n${HELP(prog)}`);
		return 2;
	}
	if (values.help) { process.stdout.write(HELP(prog)); return 0; }
	const config = loadConfig();
	try {
		if (exporting) {
			if (!values.out) throw Object.assign(new Error("--out FILE is required"), { usage: true });
			if (!values.profile) throw Object.assign(new Error("--profile is required"), { usage: true });
			const out = expandHome(values.out);
			const r = await exportCandidates({ profile: values.profile, out, server: readServer(config) });
			process.stdout.write(`Appended ${r.appended} accepted candidate${r.appended === 1 ? "" : "s"} to ${out}.\n`);
			return 0;
		}
		if (!values.cases) throw Object.assign(new Error("--cases FILE is required"), { usage: true });
		if (!values.profile) throw Object.assign(new Error("--profile is required"), { usage: true });
		if (!/^\d{1,3}$/.test(values.k)) throw Object.assign(new Error("--k must be an integer from 1 to 100"), { usage: true });
		const k = Number(values.k), { profile, channels } = values;
		checkRun({ profile, channels, k });
		const cases = readCases(expandHome(values.cases));
		if (!cases.length) throw new Error(`${values.cases}: no cases`);
		const report = await runEval({ cases, profile, channels, k, read: readServer(config) });
		const out = values.out ? expandHome(values.out) : path.join(home(), "eval", `${report.at.slice(0, 10)}-${channels}.json`);
		writePrivate(out, `${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`${report.cases} cases, ${channels}, k ${k}: recall_all_at_k ${report.recall_all_at_k.toFixed(4)}, any_hit_at_k ${report.any_hit_at_k.toFixed(4)}, `
			+ `mrr ${report.mrr.toFixed(4)}, ${report.misses.length} misses. Report: ${out}\n`);
		const filtered = report.unsupported_filters.length;
		if (filtered) process.stderr.write(`${prog}: ${filtered} case${filtered === 1 ? " sets" : "s set"} a type, kinds or scope filter that /v1/recall does not take; `
			+ `${filtered === 1 ? "it ran" : "they ran"} unfiltered (listed in the report as unsupported_filters)\n`);
		const summary = runSummary(report, profile);
		let code = 0;
		if (values["write-baseline"]) {
			const file = expandHome(values["write-baseline"]);
			const b = writeBaseline(file, summary);
			if (b.written) process.stdout.write(`Baseline written: ${file}\n`);
			else { process.stderr.write(`${prog}: baseline not written: ${b.reason}\n`); code = 1; }
		}
		try {
			await httpServer(config).evalRun(summary);
		} catch (e) {
			process.stderr.write(`${prog}: the scores were not uploaded (${e.status ? `HTTP ${e.status}` : e.code ?? e.message}); the local report is kept\n`);
			code = 1;
		}
		return code;
	} catch (e) {
		const why = e.code === "read_token_missing" ? `no usable read token at ${config.read_token_file}: create a read-only device token in Settings and save it there with mode 600` : e.message;
		process.stderr.write(`${prog}: ${why}\n${e.usage ? HELP(prog) : ""}`);
		return e.usage ? 2 : 1;
	}
}
