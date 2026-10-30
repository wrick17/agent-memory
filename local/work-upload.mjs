// Bounded local git metadata only. The caller supplies the authenticated ingest transport and holds the machine lock.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { redact, writePrivate } from "./agent-memory.mjs";

const SHA = /^[0-9a-f]{40}$/;
// Same personal-value patterns as src/domain/personal.ts, applied before clipping or retaining a payload.
const PERSONAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/g;
const git = (cwd, args) => {
	try { return execFileSync("git", ["--no-pager", ...args], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 2_000_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } }); }
	catch { throw new Error("git_metadata_unavailable"); }
};

/** No remotes are contacted; origin identifies the namespace and is replaced by its credential-free canonical URL. */
export function collectCommits(cwd, previousHead) {
	const remote = git(cwd, ["config", "--get", "remote.origin.url"]).trim();
	const cleaned = remote.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	const match = /^github\.com(?::\d+)?[:/]([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/i.exec(cleaned);
	if (!match || !match[2].replace(/\.+$/, "")) throw new Error("unsupported_remote");
	const repo = `${match[1]}/${match[2].replace(/\.+$/, "")}`.toLowerCase();
	const head = git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	if (!SHA.test(head)) throw new Error("unsupported_sha");
	if (previousHead === head) return { repo, head, commits: [] };
	let ancestor = false;
	if (SHA.test(previousHead ?? "")) {
		try { git(cwd, ["merge-base", "--is-ancestor", previousHead, head]); ancestor = true; } catch { /* A rewritten history uses the approved last-200 fallback. */ }
	}
	// shortcut: a normal delta over 200 commits is held, add paged collection before supporting larger deltas.
	let raw = git(cwd, ["log", "--no-merges", `--max-count=${ancestor ? 201 : 200}`, "--format=%H%x00%aI%x00%ae%x00%s%x00", ancestor ? `${previousHead}..${head}` : head]);
	// Include a merge HEAD's metadata too, so the final marker always names an acknowledged commit.
	if (!raw.startsWith(`${head}\0`)) raw = git(cwd, ["log", "--max-count=1", "--format=%H%x00%aI%x00%ae%x00%s%x00", head]) + raw;
	const fields = raw.split("\0"), commits = [];
	for (let i = 0; i + 3 < fields.length; i += 4) {
		const sha = fields[i].trim(), at = new Date(fields[i + 1]).toISOString(), email = fields[i + 2];
		if (!SHA.test(sha)) throw new Error("invalid_git_metadata");
		const author = /^(?:\d+\+)?([A-Za-z0-9][A-Za-z0-9_-]{0,38})@users\.noreply\.github\.com$/i.exec(email)?.[1]?.toLowerCase();
		commits.push({ sha, at, title: redact(fields[i + 3]).replace(PERSONAL, "[REDACTED]").slice(0, 280), ...(author ? { author } : {}) });
	}
	if (ancestor && commits.length > 200) throw new Error("delta_too_large");
	return { repo, head, commits: commits.slice(0, 200).reverse() };
}

/** Retry the kept redacted bytes until every item and the final marker receive exact acknowledgements. No token is retained. */
export async function uploadWork({ cwd, profile, stateFile, send, now = () => new Date().toISOString() }) {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(profile) || profile === "me") throw new Error("invalid_profile");
	let state;
	try { state = JSON.parse(readFileSync(stateFile, "utf8")); }
	catch (e) { if (e.code !== "ENOENT") throw new Error("invalid_work_state"); state = {}; }
	if (state.profile && state.profile !== profile) throw new Error("work_state_profile");
	if (!state.pending) {
		const batch = collectCommits(cwd, state.head);
		if (state.repo && state.repo !== batch.repo) throw new Error("work_state_repo");
		if (batch.head === state.head) return { status: "unchanged" };
		state = { ...state, repo: batch.repo, profile, pending: { commits: batch.commits, marker: { head: batch.head, as_of: now() } } };
		writePrivate(stateFile, JSON.stringify(state));
	}
	const { commits, marker } = state.pending;
	// Send the marker only with the final acknowledged batch.
	const batches = Math.max(1, Math.ceil(commits.length / 50));
	for (let i = 0; i < batches; i++) {
		const items = commits.slice(i * 50, (i + 1) * 50), final = i === batches - 1;
		let receipt;
		try { receipt = await send({ profile, repo: { remote: `https://github.com/${state.repo}.git` }, commits: items, ...(final ? { marker } : {}) }); }
		catch { return { status: "pending", reason: "upload_failed" }; }
		const held = receipt?.profile === profile && receipt.commits?.length === items.length && receipt.commits.every((r, n) => r.key === `git:${state.repo}@${items[n].sha}` && ["stored", "replayed"].includes(r.status));
		if (!held || (final && !["stored", "replayed"].includes(receipt.marker?.status))) return { status: "pending", reason: "not_acknowledged" };
	}
	writePrivate(stateFile, JSON.stringify({ repo: state.repo, profile, head: marker.head }));
	return { status: "acknowledged", commits: commits.length };
}
