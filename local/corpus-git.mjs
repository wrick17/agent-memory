// Git-history acquisition for the corpus refresh (section 14, phase 6): one local checkout becomes the five approved families of its
// repo, written under their exact original DDL to a private temporary SQLite file. That file is the refresh source (`sqlite-file`), so
// validation, redaction, guard terms, planning and the server protocol are corpus-cli.mjs's and corpus-refresh.mjs's, unchanged.
// Git runs locally only (no fetch), with the user config that would change log output pinned. Emails are never read: no format below
// names an email field. Conventions: the repo is origin's owner/name; history is every commit reachable from local branches,
// remote-tracking branches, tags and HEAD; dates are UTC `YYYY-MM-DDTHH:MM:SSZ`; parents a JSON array; pr_number from a trailing
// "(#N)" or "Merge pull request #N"; is_revert from `Revert "`; cherry_pick_source from `git cherry-pick -x`; paths against the only
// parent (merges none), top_component the first directory ("" at the root), extension per path.extname; contributors ranked by
// author-name commit count, then name.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCAN_DDL, scanRows } from "./corpus-scan.mjs";

/** The retained original DDL, byte for byte as src/corpus/families.ts holds it; the server's schema hash refuses any drift. */
export const DDL = {
	repos: `CREATE TABLE repos (
    full_name TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, archived INTEGER NOT NULL, private INTEGER NOT NULL,
    language TEXT, default_branch TEXT, updated_at TEXT, url TEXT,
    commit_count INTEGER NOT NULL, ref_count INTEGER NOT NULL,
    head_sha TEXT, earliest_date TEXT, latest_date TEXT, empty INTEGER NOT NULL
  )`,
	commits: `CREATE TABLE commits (
    repo TEXT NOT NULL, sha TEXT NOT NULL, parents TEXT NOT NULL,
    author_name TEXT, author_email TEXT, author_date TEXT,
    committer_name TEXT, committer_email TEXT, committer_date TEXT,
    subject TEXT, message TEXT, is_merge INTEGER NOT NULL,
    is_revert INTEGER NOT NULL, pr_number INTEGER, cherry_pick_source TEXT,
    PRIMARY KEY (repo, sha)
  ) WITHOUT ROWID`,
	refs: `CREATE TABLE refs (
    repo TEXT NOT NULL, refname TEXT NOT NULL, namespace TEXT NOT NULL,
    short_name TEXT NOT NULL, target_sha TEXT, object_type TEXT,
    creator_date TEXT, author_name TEXT, author_email TEXT, subject TEXT,
    PRIMARY KEY (repo, refname)
  ) WITHOUT ROWID`,
	commit_paths: `CREATE TABLE commit_paths (
    repo TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
    top_component TEXT NOT NULL, extension TEXT NOT NULL,
    PRIMARY KEY (repo, sha, path)
  ) WITHOUT ROWID`,
	contributors: `CREATE TABLE contributors(
  repo TEXT,
  rank INT,
  commits INT,
  name TEXT,
  email TEXT
)`,
};

const SCOPE = ["--branches", "--remotes", "--tags"];
const DATE = "format-local:%Y-%m-%dT%H:%M:%SZ";
// shortcut: whole git outputs are buffered (512 MiB cap); a repo past that refuses with ENOBUFS, upgrade to streaming then.
const git = (dir, args) => execFileSync("git", ["-C", dir, "-c", "core.quotepath=off", "-c", "log.showSignature=false", "-c", "log.showRoot=true", ...args],
	{ encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, TZ: "UTC", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (dir, args) => { try { return git(dir, args).trim(); } catch { return null; } };
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** owner/name from the origin remote (scp-style, ssh:// or https://, any host or alias), or null. */
export function repoOfCheckout(dir) {
	const url = tryGit(dir, ["remote", "get-url", "origin"]);
	const m = url && /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	return m ? `${m[1]}/${m[2]}` : null;
}

/** The identity of what a refresh would read: every recorded ref tip plus HEAD. Unchanged digest, unchanged rows. */
export function refsDigest(dir) {
	return sha256([git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"]), tryGit(dir, ["rev-parse", "-q", "--verify", "HEAD"]) ?? ""].join("\n"));
}

/**
 * The five families of `repo` from the checkout, as column-name objects (email columns absent). `base` is that repo's existing
 * `repos` row, if any, for the GitHub-only fields git cannot observe.
 */
export function gitRows(dir, repo, base = null) {
	const head = tryGit(dir, ["rev-parse", "-q", "--verify", "HEAD"]);
	const revs = [...SCOPE, ...(head ? ["HEAD"] : [])];
	const refs = git(dir, ["for-each-ref", `--format=%(refname)%00%(objectname)%00%(objecttype)%00%(creatordate:${DATE})%00%(if)%(taggername)%(then)%(taggername)%(else)%(authorname)%(end)%00%(subject)%00%(symref)`,
		"refs/heads", "refs/remotes", "refs/tags"]).split("\n").filter(Boolean).map((l) => l.split("\0")).filter((f) => !f[6])
		.map(([refname, target, type, date, who, subject]) => {
			const [, namespace, ...rest] = refname.split("/");
			return { repo, refname, namespace, short_name: rest.join("/"), target_sha: target, object_type: type, creator_date: date || null, author_name: who || null, subject: subject || null };
		});
	const any = head || refs.length;
	const commits = !any ? [] : git(dir, ["log", ...revs, `--date=${DATE}`, "--format=%H%x00%P%x00%an%x00%ad%x00%cn%x00%cd%x00%s%x00%B%x00%x01"])
		.split("\0\x01").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
			const [sha, parents, an, ad, cn, cd, subject, body] = r.split("\0");
			const message = body.replace(/\n+$/, "");
			const pr = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+) /.exec(subject);
			const parentList = parents ? parents.split(" ") : [];
			return { repo, sha, parents: JSON.stringify(parentList), author_name: an || null, author_date: ad || null, committer_name: cn || null, committer_date: cd || null,
				subject, message, is_merge: parentList.length > 1 ? 1 : 0, is_revert: /^Revert "/.test(subject) ? 1 : 0, pr_number: pr ? Number(pr[1]) : null,
				cherry_pick_source: /\(cherry picked from commit ([0-9a-f]{7,64})\)/.exec(message)?.[1] ?? null };
		});
	// Paths changed against the only parent (a root commit: every file); merges list none, as git log does by default.
	const paths = [];
	if (any) for (const rec of git(dir, ["log", ...revs, "--no-renames", "--name-only", "-z", "--format=%x01%H"]).split("\x01").filter(Boolean)) {
		const [sha, rest = ""] = [rec.slice(0, rec.indexOf("\0")), rec.slice(rec.indexOf("\0") + 1)];
		for (const p of new Set(rest.replace(/^\n/, "").split("\0").filter(Boolean))) {
			const slash = p.indexOf("/");
			paths.push({ repo, sha, path: p, top_component: slash < 0 ? "" : p.slice(0, slash), extension: path.posix.extname(p).slice(1) });
		}
	}
	const counts = new Map();
	for (const c of commits) if (c.author_name !== null) counts.set(c.author_name, (counts.get(c.author_name) ?? 0) + 1);
	const contributors = [...counts].sort((a, b) => b[1] - a[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
		.map(([name, n], i) => ({ repo, rank: i + 1, commits: n, name }));
	const originHead = tryGit(dir, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
	const defaultBranch = originHead ? originHead.replace(/^origin\//, "") : tryGit(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
	const tip = (defaultBranch && (tryGit(dir, ["rev-parse", "-q", "--verify", `refs/heads/${defaultBranch}^{commit}`]) ?? tryGit(dir, ["rev-parse", "-q", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`]))) || head;
	const days = commits.map((c) => c.author_date?.slice(0, 10)).filter(Boolean).sort();
	const slash = repo.indexOf("/");
	const repos = [{ full_name: repo, owner: repo.slice(0, slash), name: repo.slice(slash + 1),
		// GitHub-only fields: carried from the loaded row when given; otherwise unknown text stays NULL and the two flags take the
		// conservative values (not archived, private).
		description: base?.description ?? null, archived: base?.archived ?? 0, private: base?.private ?? 1, language: base?.language ?? null,
		default_branch: defaultBranch || null, updated_at: base?.updated_at ?? null, url: base?.url ?? null, commit_count: commits.length, ref_count: refs.length,
		head_sha: tip || null, earliest_date: days[0] ?? null, latest_date: days.at(-1) ?? null, empty: commits.length ? 0 : 1 }];
	return { repos, commits, refs, commit_paths: paths, contributors };
}

/** Writes the rows to a new private SQLite file under the exact DDL (the history families unless `ddl` names others); returns its path and a cleanup. */
export async function writeSnapshot(rows, ddl = DDL) {
	const { DatabaseSync } = await import("node:sqlite");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-corpus-git-"));
	const file = path.join(dir, "git.sqlite");
	try {
		fs.writeFileSync(file, "", { mode: 0o600 });
		const db = new DatabaseSync(file);
		try {
			db.exec("BEGIN");
			for (const [t, create] of Object.entries(ddl)) {
				db.exec(create);
				if (!rows[t].length) continue;
				const cols = Object.keys(rows[t][0]);
				const insert = db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
				for (const r of rows[t]) insert.run(...cols.map((c) => r[c]));
			}
			db.exec("COMMIT");
		} finally { db.close(); }
	} catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
	return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const REPOS_META = ["description", "archived", "private", "language", "updated_at", "url"];

/**
 * One refresh per checkout. `explicit` names the repo and always refreshes; otherwise the repo comes from origin and a checkout is
 * skipped while its ref tips are unchanged since its last publication, or once it has published today (UTC), so an untouched repo keeps
 * its as-of. A saved plan always resumes first. The marker moves only on `published`. `openSource(file)` is corpus-cli's sqliteSource.
 */
export async function refreshCheckouts({ checkouts, explicit = null, profile, client, state, save, now = new Date(), base = null, openSource, refresh, scans = false }) {
	state.repos ??= {};
	const today = now.toISOString().slice(0, 10), out = [];
	for (const dir of checkouts) {
		const repo = explicit ?? repoOfCheckout(dir);
		if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) { out.push({ checkout: dir, status: "refused", reason: "no_origin_repo" }); continue; }
		const mark = (state.repos[repo] ??= { refresh: {} });
		let digest;
		try { digest = refsDigest(dir); } catch { out.push({ checkout: dir, repo, status: "refused", reason: "not_a_git_checkout" }); continue; }
		if (!mark.refresh.plan && !explicit) {
			if (mark.digest === digest) { out.push({ checkout: dir, repo, status: "unchanged", as_of: mark.observed_at }); continue; }
			if (mark.day === today) { out.push({ checkout: dir, repo, status: "refreshed_today", as_of: mark.observed_at }); continue; }
		}
		const observedAt = now.toISOString();
		let snap = null, source = null, requireNewRepo = false;
		try {
			if (!mark.refresh.plan) {
				const meta = base?.repoRows("repos", REPOS_META, repo)[0];
				// shortcut: cached metadata is the last declared snapshot; pass --base again to refresh GitHub-only fields.
				const metadata = meta ? Object.fromEntries(REPOS_META.map((c, i) => [c, meta[i]])) : mark.metadata;
				requireNewRepo = !metadata;
				const rows = gitRows(dir, repo, metadata);
				snap = await writeSnapshot(rows);
				source = await openSource(snap.file);
				mark.pending = { digest, observed_at: observedAt, metadata: Object.fromEntries(REPOS_META.map((c) => [c, rows.repos[0][c]])) };
			}
			const r = await refresh({ source, client, profile, repo, observedAt: mark.pending?.observed_at ?? observedAt, sourceId: source?.fileSha256, state: mark.refresh, save: () => save(state), requireNewRepo });
			if (r.status === "published") {
				Object.assign(mark, { digest: mark.pending?.digest ?? digest, day: today, observed_at: mark.pending?.observed_at ?? observedAt, metadata: mark.pending?.metadata ?? mark.metadata, pending: null });
				save(state);
			}
			out.push({ checkout: dir, repo, ...r });
		} finally { source?.close(); snap?.cleanup(); }
	}
	if (scans) out.push(...await scanCheckouts({ checkouts, explicit, profile, client, state, save, now, openSource, refresh }));
	return out;
}

/**
 * The scan group per checkout (unit: repo + analysis_head): scanned again only when HEAD moved since the last published scan and
 * not yet scanned today (UTC), so an untouched repo keeps its as-of; `explicit` always scans. Its plan and marker are separate from
 * the history refresh's, and a saved scan plan always resumes first. The marker moves only on `published`.
 */
async function scanCheckouts({ checkouts, explicit, profile, client, state, save, now, openSource, refresh }) {
	state.scans ??= {};
	const today = now.toISOString().slice(0, 10), out = [];
	for (const dir of checkouts) {
		const repo = explicit ?? repoOfCheckout(dir);
		if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) continue; // reported by the history pass
		const mark = (state.scans[repo] ??= { refresh: {} });
		const head = tryGit(dir, ["rev-parse", "-q", "--verify", "HEAD"]);
		if (!head && !mark.refresh.plan) { out.push({ checkout: dir, repo, group: "scans", status: "refused", reason: "no_head" }); continue; }
		if (!mark.refresh.plan && !explicit) {
			if (mark.analysis_head === head) { out.push({ checkout: dir, repo, group: "scans", status: "unchanged", as_of: mark.observed_at }); continue; }
			if (mark.day === today) { out.push({ checkout: dir, repo, group: "scans", status: "refreshed_today", as_of: mark.observed_at }); continue; }
		}
		let snap = null, source = null;
		try {
			if (!mark.refresh.plan) {
				snap = await writeSnapshot(scanRows(dir, repo), SCAN_DDL);
				source = await openSource(snap.file);
				mark.pending = { analysis_head: head, observed_at: now.toISOString() };
			}
			const r = await refresh({ source, client, profile, repo, observedAt: mark.pending?.observed_at ?? now.toISOString(), sourceId: source?.fileSha256, state: mark.refresh, save: () => save(state), group: "scans" });
			if (r.status === "published") {
				Object.assign(mark, { analysis_head: mark.pending?.analysis_head ?? head, day: today, observed_at: mark.pending?.observed_at ?? now.toISOString(), pending: null });
				save(state);
			}
			out.push({ checkout: dir, repo, group: "scans", ...r });
		} finally { source?.close(); snap?.cleanup(); }
	}
	return out;
}
