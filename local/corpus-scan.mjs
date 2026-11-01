// Checkout scanners for the corpus scan group (section 14 "Incremental updates", phase 6): one checkout's committed HEAD tree
// becomes the rows of the 21 scan families under their exact original DDL (the inventory corpus-schema.json, held byte for byte in
// src/corpus/families.ts SCANS). The working tree is never read; git never fetches. Rows carry names, paths, line numbers and at
// most one 200-character source line as a snippet; the refresh client redacts every text value before hashing and the server refuses
// anything personal. Conventions (the original builders are not retained):
// - A file is scanned when it is a text blob of at most 512 KiB outside vendored or built directories, lockfiles and minified files;
//   otherwise source_files.skip_reason says why. Every other family reads scanned files only.
// - Frontend tables apply when any scanned package.json depends on a frontend framework. The snapshot is the checkout's HEAD:
//   snapshot_id = repo_key = the repo full name, role "workspace"; branch tables compare local branches with it.
// - Builder ids are not produced (stored NULL); confidence is NULL where the original used a builder-specific score; JSON list
//   columns hold sorted unique JSON arrays. Each extractor's patterns are the regular expressions below.
import { execFileSync } from "node:child_process";
import path from "node:path";

export const SCAN_DDL = {
	source_files: "CREATE TABLE source_files(\n  repo TEXT,\n  path TEXT,\n  blob_sha TEXT,\n  size INT,\n  scanned INT,\n  skip_reason TEXT\n)",
	architecture_repos: "CREATE TABLE architecture_repos(\n  repo TEXT,\n  name TEXT,\n  category TEXT,\n  archived INT,\n  language TEXT,\n  default_branch TEXT,\n  head_sha TEXT,\n  latest_date TEXT,\n  history_commits INT,\n  history_refs INT,\n  current_files INT,\n  scanned_files INT,\n  scanned_bytes INT,\n  domains TEXT\n)",
	api_endpoints: "CREATE TABLE api_endpoints(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  line INT,\n  method TEXT,\n  route TEXT,\n  normalized_route TEXT,\n  kind TEXT,\n  security_signals TEXT\n)",
	api_callers: "CREATE TABLE api_callers(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  category TEXT,\n  path TEXT,\n  line INT,\n  target TEXT,\n  normalized_target TEXT,\n  base_env_refs TEXT\n)",
	packages: "CREATE TABLE packages(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  role TEXT,\n  package TEXT,\n  version TEXT,\n  scope TEXT\n)",
	external_system_edges: "CREATE TABLE external_system_edges(\n  repo TEXT,\n  system TEXT,\n  system_type TEXT,\n  evidence_path TEXT,\n  evidence_line INT,\n  confidence TEXT\n)",
	env_refs: "CREATE TABLE env_refs(\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  line INT,\n  name TEXT,\n  secret_reference INT\n)",
	architecture_workflows: "CREATE TABLE architecture_workflows(\n  id INT,\n  repo TEXT,\n  sha TEXT,\n  path TEXT,\n  triggers TEXT,\n  environments TEXT,\n  deploy_targets TEXT,\n  secret_refs TEXT\n)",
	frontend_repositories: "CREATE TABLE frontend_repositories(\n  repo_key TEXT,\n  full_name TEXT,\n  org TEXT,\n  name TEXT,\n  category TEXT\n)",
	frontend_snapshots: "CREATE TABLE frontend_snapshots(\n  snapshot_id TEXT,\n  repo_key TEXT,\n  role TEXT,\n  branch TEXT,\n  sha TEXT,\n  commit_date TEXT,\n  subject TEXT,\n  root_path TEXT,\n  dirty INT\n)",
	frontend_branch_refs: "CREATE TABLE frontend_branch_refs(\n  repo_key TEXT,\n  ref_name TEXT,\n  sha TEXT,\n  commit_date TEXT,\n  subject TEXT,\n  is_workspace_head INT,\n  is_ancestor_of_workspace INT\n)",
	frontend_branch_deltas: "CREATE TABLE frontend_branch_deltas(\n  repo_key TEXT,\n  from_snapshot TEXT,\n  to_snapshot TEXT,\n  merge_base_sha TEXT,\n  ahead INT,\n  behind INT,\n  path TEXT,\n  status TEXT\n)",
	frontend_branch_comparisons: "CREATE TABLE frontend_branch_comparisons(\n  repo_key TEXT,\n  workspace_snapshot TEXT,\n  ref_name TEXT,\n  ref_sha TEXT,\n  merge_base_sha TEXT,\n  ahead INT,\n  behind INT,\n  changed_paths INT\n)",
	frontend_files: "CREATE TABLE frontend_files(\n  snapshot_id TEXT,\n  path TEXT,\n  blob_sha TEXT,\n  size INT,\n  language TEXT,\n  is_test INT,\n  top_domain TEXT\n)",
	frontend_evidence: "CREATE TABLE frontend_evidence(\n  id INT,\n  snapshot_id TEXT,\n  category TEXT,\n  evidence_key TEXT,\n  value TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL,\n  extractor TEXT\n)",
	mf_exposes: "CREATE TABLE mf_exposes(\n  snapshot_id TEXT,\n  expose_key TEXT,\n  target_path TEXT,\n  path TEXT,\n  line INT,\n  confidence REAL\n)",
	cross_mfe_imports: "CREATE TABLE cross_mfe_imports(\n  snapshot_id TEXT,\n  source_alias TEXT,\n  import_path TEXT,\n  path TEXT,\n  line INT,\n  confidence REAL\n)",
	frontend_api_endpoints: "CREATE TABLE frontend_api_endpoints(\n  snapshot_id TEXT,\n  endpoint TEXT,\n  method_hint TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL\n)",
	frontend_routes: "CREATE TABLE frontend_routes(\n  snapshot_id TEXT,\n  route_value TEXT,\n  path TEXT,\n  line INT,\n  snippet TEXT,\n  confidence REAL\n)",
	frontend_domain_modules: "CREATE TABLE frontend_domain_modules(\n  snapshot_id TEXT,\n  kind TEXT,\n  name TEXT,\n  path TEXT,\n  file_count INT,\n  test_count INT\n)",
	frontend_dependencies: "CREATE TABLE frontend_dependencies(\n  snapshot_id TEXT,\n  name TEXT,\n  version TEXT,\n  kind TEXT,\n  path TEXT,\n  line INT\n)",
};

const MAX_BYTES = 512 * 1024, SNIPPET = 200;
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.git)\//;
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|composer\.lock|poetry\.lock|Cargo\.lock)$|\.min\.(js|css)$/;
const JS = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/, PY = /\.py$/;
const FRAMEWORKS = ["react", "react-dom", "vue", "@angular/core", "svelte", "next", "nuxt", "solid-js", "preact"];
const LANG = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", vue: "vue", svelte: "svelte",
	css: "css", scss: "scss", less: "less", html: "html", json: "json" };
const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL/i;
const ENV = [/process\.env\.([A-Za-z_]\w*)/g, /process\.env\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g, /import\.meta\.env\.([A-Za-z_]\w*)/g,
	/os\.environ(?:\.get\(\s*|\[\s*)['"]([A-Za-z_]\w*)['"]/g, /os\.getenv\(\s*['"]([A-Za-z_]\w*)['"]/g];
const ACTIONS_REF = /\$\{\{\s*(secrets|env|vars)\.([A-Za-z_]\w*)\s*\}\}/g;
const SYSTEM = /\b(https?|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?|kafka):\/\/(?:[^\s'"`/@]*@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const NOT_SYSTEM = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$|(^|\.)(example\.(com|org|net)|w3\.org|json-schema\.org|schema\.org|xmlsoap\.org)$/i;
const list = (xs) => JSON.stringify([...new Set(xs)].sort());
const snippet = (line) => line.trim().slice(0, SNIPPET);

/** `/users/:id/`, `/users/{id}`, `/users/<id>` and `/users/${id}` all become `/users/:param`; query and fragment dropped. */
export function normalizeRoute(route) {
	const p = route.replace(/[?#].*$/, "").replace(/\$\{[^}]*\}|:[A-Za-z_]\w*|\{[^}]+\}|<[^>]+>/g, ":param").replace(/\/{2,}/g, "/");
	return p.length > 1 ? p.replace(/\/$/, "") : p;
}
/** A caller target's path: an origin or a leading `${…}` base removed; null unless what remains is a path. */
const targetPath = (t) => { const p = t.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\$\{[^}]*\}/, ""); return p.startsWith("/") ? normalizeRoute(p) : null; };
const envNames = (line) => ENV.flatMap((re) => [...line.matchAll(re)].map((m) => m[1]));

const gitIn = (dir) => (args, input) => execFileSync("git", ["-C", dir, "-c", "core.quotepath=off", ...args],
	{ maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, TZ: "UTC", GIT_TERMINAL_PROMPT: "0" }, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const text = (b) => b.toString("utf8").trim();

/** The committed blobs at HEAD with their contents where scannable. */
function headTree(git) {
	const entries = git(["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]).toString("utf8").split("\0").filter(Boolean).map((e) => {
		const [meta, p] = [e.slice(0, e.indexOf("\t")), e.slice(e.indexOf("\t") + 1)];
		const [mode, type, sha, size] = meta.split(/\s+/);
		return { mode, type, sha, size: Number(size), path: p };
	}).filter((e) => e.type === "blob");
	for (const e of entries) e.skip = e.mode === "120000" ? "symlink" : SKIP_DIR.test(e.path) ? "vendored_or_built" : GENERATED.test(e.path) ? "generated" : e.size > MAX_BYTES ? "too_large" : null;
	const want = entries.filter((e) => !e.skip);
	if (want.length) {
		const out = git(["cat-file", "--batch"], `${want.map((e) => e.sha).join("\n")}\n`);
		let at = 0;
		for (const e of want) {
			const nl = out.indexOf(10, at), size = Number(out.subarray(at, nl).toString().split(" ")[2]);
			const body = out.subarray(nl + 1, nl + 1 + size);
			at = nl + 1 + size + 1;
			if (body.subarray(0, 8000).includes(0)) e.skip = "binary";
			else e.text = body.toString("utf8");
		}
	}
	return entries;
}

/** Lines of a `key: {` … `}` object literal, by brace depth from the line naming the key. */
function block(lines, key) {
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (!new RegExp(`\\b${key}\\s*:\\s*\\{`).test(lines[i])) continue;
		let depth = 0;
		for (let j = i; j < lines.length; j++) {
			for (const ch of j === i ? lines[j].slice(lines[j].search(/\{/)) : lines[j]) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
			out.push([j, j === i ? lines[j].slice(lines[j].search(/\{/) + 1) : lines[j]]);
			if (depth <= 0) break;
		}
	}
	return out;
}

/** GitHub Actions workflow facts from YAML text, line by line (no YAML parser): `on` events, environments, deploy actions, secret names. */
function workflow(lines) {
	const triggers = [], environments = [], deploy = [], secrets = [];
	for (let i = 0; i < lines.length; i++) {
		const on = /^["']?on["']?\s*:\s*(.*)$/.exec(lines[i]);
		if (on) {
			const inline = on[1].replace(/#.*/, "").trim();
			if (inline) triggers.push(...inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean));
			else for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]); j++) { const k = /^ {2}([\w-]+)\s*:/.exec(lines[j]) ?? /^ {2}- ([\w-]+)\s*$/.exec(lines[j]); if (k) triggers.push(k[1]); }
		}
		const env = /^\s*environment\s*:\s*['"]?([^'"#{\s][^'"#]*?)['"]?\s*$/.exec(lines[i]) ?? (/^\s*environment\s*:\s*$/.test(lines[i]) ? /^\s*name\s*:\s*['"]?([^'"#\s]+)/.exec(lines[i + 1] ?? "") : null);
		if (env) environments.push(env[1].trim());
		const uses = /^\s*(?:-\s*)?uses\s*:\s*['"]?([^@'"\s]+)/.exec(lines[i]);
		if (uses && /deploy|wrangler|vercel|netlify|aws-actions|azure\/|google-github-actions|helm|kubectl|pages|firebase/i.test(uses[1])) deploy.push(uses[1]);
		for (const m of lines[i].matchAll(ACTIONS_REF)) if (m[1] === "secrets") secrets.push(m[2]);
	}
	return { triggers: list(triggers), environments: list(environments), deploy_targets: list(deploy), secret_refs: list(secrets) };
}

/** Every scan family's rows for `repo` from the checkout's HEAD. */
export function scanRows(dir, repo) {
	const git = gitIn(dir);
	const head = text(git(["rev-parse", "HEAD"]));
	const files = headTree(git), scanned = files.filter((f) => f.text !== undefined);
	const rows = Object.fromEntries(Object.keys(SCAN_DDL).map((t) => [t, []]));
	const slash = repo.indexOf("/"), name = repo.slice(slash + 1);
	for (const f of files) rows.source_files.push({ repo, path: f.path, blob_sha: f.sha, size: f.size, scanned: f.text === undefined ? 0 : 1, skip_reason: f.skip ?? null });
	const manifests = [];
	for (const f of scanned) {
		const lines = f.text.split("\n"), workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path), code = JS.test(f.path) || PY.test(f.path);
		const systems = new Set();
		lines.forEach((l, i) => {
			const line = i + 1;
			for (const n of new Set(envNames(l))) rows.env_refs.push({ repo, sha: head, path: f.path, line, name: n, secret_reference: SECRETISH.test(n) ? 1 : 0 });
			for (const m of l.matchAll(ACTIONS_REF)) rows.env_refs.push({ repo, sha: head, path: f.path, line, name: m[2], secret_reference: m[1] === "secrets" || SECRETISH.test(m[2]) ? 1 : 0 });
			for (const m of l.matchAll(SYSTEM)) {
				const host = m[2].toLowerCase(), type = /^https?$|^wss?$/.test(m[1]) ? "http" : m[1].replace(/\+srv$/, "").replace(/^postgresql$/, "postgres").replace(/^rediss$/, "redis").replace(/^amqps$/, "amqp");
				if (!NOT_SYSTEM.test(host) && !systems.has(`${host}|${type}`)) { systems.add(`${host}|${type}`); rows.external_system_edges.push({ repo, system: host, system_type: type, evidence_path: f.path, evidence_line: line, confidence: null }); }
			}
			if (!code) return;
			const signals = (route) => { const s = [...l.replace(route, "").matchAll(/\b\w*(?:auth|jwt|guard|permission|role|session|csrf)\w*\b/gi)].map((m) => m[0]); return s.length ? list(s) : null; };
			for (const m of l.matchAll(/\b(?:app|router|server|api|routes?)\.(get|post|put|patch|delete|all|options|head)\(\s*(['"`])(\/[^'"`]*)\2/g))
				rows.api_endpoints.push({ repo, sha: head, path: f.path, line, method: m[1].toUpperCase(), route: m[3], normalized_route: normalizeRoute(m[3]), kind: "express", security_signals: signals(m[3]) });
			for (const m of l.matchAll(/@(?:app|router|bp|blueprint|api)\.(get|post|put|patch|delete)\(\s*['"](\/[^'"]*)['"]/g))
				rows.api_endpoints.push({ repo, sha: head, path: f.path, line, method: m[1].toUpperCase(), route: m[2], normalized_route: normalizeRoute(m[2]), kind: "fastapi", security_signals: signals(m[2]) });
			for (const m of l.matchAll(/@(?:app|bp|blueprint)\.route\(\s*['"](\/[^'"]*)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/g))
				for (const method of m[2] ? [...m[2].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : ["GET"])
					rows.api_endpoints.push({ repo, sha: head, path: f.path, line, method, route: m[1], normalized_route: normalizeRoute(m[1]), kind: "flask", security_signals: signals(m[1]) });
			const caller = (category, target) => { if (!target.includes("/")) return; const envs = envNames(target).concat([...target.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((x) => x[1]));
				rows.api_callers.push({ repo, sha: head, category, path: f.path, line, target, normalized_target: targetPath(target), base_env_refs: envs.length ? list(envs) : null }); };
			for (const m of l.matchAll(/\bfetch\(\s*(['"`])([^'"`]+)\1/g)) caller("fetch", m[2]);
			for (const m of l.matchAll(/\baxios(?:\.(?:get|post|put|patch|delete|request))?\(\s*(['"`])([^'"`]+)\1/g)) caller("axios", m[2]);
			for (const m of l.matchAll(/\brequests\.(?:get|post|put|patch|delete)\(\s*f?(['"])([^'"]+)\1/g)) caller("requests", m[2]);
		});
		if (workflowFile) rows.architecture_workflows.push({ repo, sha: head, path: f.path, ...workflow(lines) });
		if (path.posix.basename(f.path) === "package.json") {
			let pkg;
			try { pkg = JSON.parse(f.text); } catch { pkg = null; }
			if (pkg && typeof pkg === "object") {
				manifests.push({ file: f, pkg, lines });
				if (typeof pkg.name === "string") rows.packages.push({ repo, sha: head, path: f.path, role: "package", package: pkg.name, version: typeof pkg.version === "string" ? pkg.version : null, scope: null });
				for (const s of SECTIONS) for (const [dep, v] of Object.entries(pkg[s] ?? {})) rows.packages.push({ repo, sha: head, path: f.path, role: "dependency", package: dep, version: typeof v === "string" ? v : null, scope: s });
			}
		}
	}
	const commitLine = (rev) => text(git(["log", "-1", "--date=format-local:%Y-%m-%dT%H:%M:%SZ", "--format=%cd%x00%s", rev])).split("\0");
	const [headDate, headSubject] = commitLine("HEAD");
	const branch = (() => { try { return text(git(["symbolic-ref", "-q", "--short", "HEAD"])); } catch { return null; } })();
	rows.architecture_repos.push({ repo, name, category: null, archived: null, language: null, default_branch: branch, head_sha: head, latest_date: headDate.slice(0, 10),
		history_commits: Number(text(git(["rev-list", "--count", "--branches", "--remotes", "--tags", "HEAD"]))),
		history_refs: text(git(["for-each-ref", "--format=x", "refs/heads", "refs/remotes", "refs/tags"])).split("\n").filter(Boolean).length,
		current_files: files.length, scanned_files: scanned.length, scanned_bytes: scanned.reduce((n, f) => n + f.size, 0), domains: null });

	if (!manifests.some((m) => SECTIONS.some((s) => FRAMEWORKS.some((fw) => Object.hasOwn(m.pkg[s] ?? {}, fw))))) return rows;
	// Frontend: one workspace snapshot per repo, keyed by the repo full name.
	const snap = repo, ev = (category, evidence_key, value, f, line, snip, extractor) =>
		rows.frontend_evidence.push({ snapshot_id: snap, category, evidence_key, value, path: f.path, line, snippet: snip, confidence: null, extractor });
	rows.frontend_repositories.push({ repo_key: repo, full_name: repo, org: repo.slice(0, slash), name, category: null });
	rows.frontend_snapshots.push({ snapshot_id: snap, repo_key: repo, role: "workspace", branch, sha: head, commit_date: headDate, subject: headSubject,
		dirty: text(git(["status", "--porcelain", "--untracked-files=no"])) ? 1 : 0 });
	const isTest = (p) => /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
	for (const f of files) {
		const ext = path.posix.extname(f.path).slice(1);
		if (!LANG[ext] || f.skip === "vendored_or_built" || f.skip === "generated") continue;
		const seg = f.path.split("/");
		rows.frontend_files.push({ snapshot_id: snap, path: f.path, blob_sha: f.sha, size: f.size, language: LANG[ext], is_test: isTest(f.path) ? 1 : 0,
			top_domain: seg[0] === "src" && seg.length > 2 ? seg[1] : seg.length > 1 ? seg[0] : null });
	}
	const modules = new Map();
	for (const f of files) {
		const m = /^((?:src\/)?(domains|modules|features|pages|apps)\/([^/]+))\//.exec(f.path);
		if (!m || f.skip === "vendored_or_built") continue;
		const d = modules.get(m[1]) ?? { snapshot_id: snap, kind: m[2], name: m[3], path: m[1], file_count: 0, test_count: 0 };
		d.file_count++; if (isTest(f.path)) d.test_count++;
		modules.set(m[1], d);
	}
	rows.frontend_domain_modules.push(...modules.values());
	for (const { file, pkg, lines } of manifests) for (const s of SECTIONS) for (const [dep, v] of Object.entries(pkg[s] ?? {})) {
		const line = lines.findIndex((l) => l.includes(JSON.stringify(dep) + ":") || l.includes(JSON.stringify(dep) + " :")) + 1 || null;
		rows.frontend_dependencies.push({ snapshot_id: snap, name: dep, version: typeof v === "string" ? v : null, kind: s, path: file.path, line });
		ev("dependency", dep, typeof v === "string" ? v : null, file, line, null, "package-json");
	}
	const aliases = new Set();
	const configs = scanned.filter((f) => /(^|\/)((webpack|rspack|rsbuild|vite)[^/]*\.config|module-federation\.config)\.[cm]?[jt]s$/.test(f.path));
	for (const f of configs) {
		const lines = f.text.split("\n");
		for (const [i, l] of block(lines, "exposes")) for (const m of l.matchAll(/(['"])(\.\/[^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g)) {
			rows.mf_exposes.push({ snapshot_id: snap, expose_key: m[2], target_path: m[4], path: f.path, line: i + 1, confidence: null });
			ev("mf_expose", m[2], m[4], f, i + 1, snippet(l), "mf-exposes");
		}
		for (const [, l] of block(lines, "remotes")) for (const m of l.matchAll(/(?:^\s*|[,{]\s*)(['"]?)([A-Za-z_$][\w$-]*)\1\s*:/g)) aliases.add(m[2]);
	}
	for (const f of scanned.filter((x) => JS.test(x.path))) f.text.split("\n").forEach((l, i) => {
		const line = i + 1;
		for (const m of l.matchAll(/\bpath\s*[:=]\s*\{?\s*(['"`])(\/[^'"`]*)\1/g)) {
			rows.frontend_routes.push({ snapshot_id: snap, route_value: m[2], path: f.path, line, snippet: snippet(l), confidence: null });
			ev("route", m[2], m[2], f, line, snippet(l), "route-path-literal");
		}
		for (const m of l.matchAll(/(['"`])((?:\$\{[^}]*\})?\/api\/[^'"`\s]*)\1/g)) {
			const hint = /\b(get|post|put|patch|delete)\b/i.exec(l)?.[1].toUpperCase() ?? null;
			rows.frontend_api_endpoints.push({ snapshot_id: snap, endpoint: m[2], method_hint: hint, path: f.path, line, snippet: snippet(l), confidence: null });
			ev("api", m[2], hint, f, line, snippet(l), "api-path-literal");
		}
		for (const m of l.matchAll(/(?:\bfrom\s*|\bimport\(\s*)(['"])([^'"/]+)\/([^'"]*)\1/g)) if (aliases.has(m[2])) {
			rows.cross_mfe_imports.push({ snapshot_id: snap, source_alias: m[2], import_path: `${m[2]}/${m[3]}`, path: f.path, line, confidence: null });
			ev("mf_import", m[2], `${m[2]}/${m[3]}`, f, line, snippet(l), "mf-remote-import");
		}
	});
	// Local branches against the workspace snapshot.
	for (const ref of text(git(["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(committerdate:format-local:%Y-%m-%dT%H:%M:%SZ)%00%(subject)", "refs/heads"])).split("\n").filter(Boolean)) {
		const [ref_name, sha, date, subject] = ref.split("\0");
		let ancestor = 1;
		try { git(["merge-base", "--is-ancestor", sha, head]); } catch { ancestor = 0; }
		rows.frontend_branch_refs.push({ repo_key: repo, ref_name, sha, commit_date: date || null, subject: subject || null, is_workspace_head: sha === head ? 1 : 0, is_ancestor_of_workspace: ancestor });
		if (sha === head) continue;
		let base;
		try { base = text(git(["merge-base", head, sha])); } catch { continue; } // unrelated histories have nothing to compare
		const [behind, ahead] = text(git(["rev-list", "--left-right", "--count", `${head}...${sha}`])).split(/\s+/).map(Number);
		const changed = git(["diff", "--name-status", "--no-renames", "-z", base, sha]).toString("utf8").split("\0").filter(Boolean);
		const pairs = [];
		for (let i = 0; i + 1 < changed.length; i += 2) pairs.push([changed[i], changed[i + 1]]);
		rows.frontend_branch_comparisons.push({ repo_key: repo, workspace_snapshot: snap, ref_name, ref_sha: sha, merge_base_sha: base, ahead, behind, changed_paths: pairs.length });
		for (const [status, p] of pairs) rows.frontend_branch_deltas.push({ repo_key: repo, from_snapshot: snap, to_snapshot: `${repo}@${ref_name}`, merge_base_sha: base, ahead, behind, path: p, status });
	}
	return rows;
}
