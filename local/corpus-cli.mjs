#!/usr/bin/env node
// Foreground corpus bulk load (section 14): node local/corpus-cli.mjs --db FILE --profile test --tables repos,commits --as-of ISO
// [--config FILE]. With --refresh REPO [--remove] instead of --tables, it refreshes that one repo from the file, observed at --as-of. The source opens read-only with query_only on; the import token stays in its private file; the state file
// pins the generation, committed snapshot hash and as_of, and the server's last keys decide where a rerun resumes.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { refreshCheckouts } from "./corpus-git.mjs";
import { refreshJudgment } from "./corpus-judgment.mjs";
import { refreshCorpus } from "./corpus-refresh.mjs";
import { uploadCorpus } from "./corpus-upload.mjs";

const RETRIES = 5;

// `agent-memory install` copies only this file, the corpus modules and their two domain imports. migrate.mjs and upload.mjs load
// the zod-based import policy, which an installed home cannot resolve, so their run lock, private write and upload config are
// mirrored here unchanged: the same migration directory, lock file, config file and checks.
const home = () => process.env.AGENT_MEMORY_HOME || path.join(os.homedir(), ".agent-memory");
const migrationDir = () => path.join(home(), "migration");
const expand = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const privateDir = (d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); return d; };
function writePrivate(file, data) {
	privateDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.renameSync(tmp, file);
}
function assertPrivate(file, what) {
	const st = fs.statSync(file);
	if (st.mode & 0o077) throw new Error(`${what} ${file} must not be readable by group or others (chmod 600)`);
	if (st.uid !== process.getuid()) throw new Error(`${what} ${file} must belong to this user`);
}
/** The upload config `{ "server": "https://…", "token_file": "…" }` (local/upload.mjs); the token is an `import` device token. */
function loadConfig(file = path.join(migrationDir(), "upload.json")) {
	assertPrivate(file, "upload config");
	const c = JSON.parse(fs.readFileSync(file, "utf8"));
	if (typeof c.server !== "string" || typeof c.token_file !== "string") throw new Error("the upload config needs server and token_file");
	const url = new URL(c.server);
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("the server must use https");
	assertPrivate(expand(c.token_file), "token file");
	return { server: url.origin, tokenFile: expand(c.token_file) };
}
/** One migrate or corpus run at a time, on migrate.mjs's own lock file; a crashed run's lock is removed by the owner. */
async function withLock(fn) {
	const lock = path.join(privateDir(migrationDir()), "run.lock");
	try {
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		throw new Error(`another migrate run holds ${lock} (${fs.readFileSync(lock, "utf8")}); if no migrate process is running, remove that file`);
	}
	try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw new Error(`unsafe identifier ${s}`); return `"${s}"`; };

/** One private committed snapshot, including WAL, supplies both the identity and every read. The original stays read-only. */
export async function sqliteSource(file) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-corpus-source-"));
	const snapshot = path.join(dir, "source.sqlite");
	let db;
	try {
		const original = new DatabaseSync(file, { readOnly: true });
		try {
			original.exec("PRAGMA query_only = ON");
			fs.writeFileSync(snapshot, "", { mode: 0o600 });
			await backup(original, snapshot);
		} finally { original.close(); }
		db = new DatabaseSync(snapshot, { readOnly: true });
		db.exec("PRAGMA query_only = ON");
		const sourceSha256 = await fileSha256(snapshot);
		return {
			fileSha256: sourceSha256,
			schema: (table) => { const r = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get(table); return r?.type === "table" ? r.sql : null; },
			columns: (table) => db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table).map((r) => r.name),
			rows: (table, columns, key, after, limit) => {
				const k = key.map(ident).join(", ");
				const q = db.prepare(`SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)}${after ? ` WHERE (${k}) > (${after.map(() => "?").join(", ")})` : ""} ORDER BY ${k} LIMIT ?`);
				return q.all(...(after ?? []), limit).map((r) => columns.map((c) => r[c]));
			},
			/** One repo's complete rows of a table in the refresh projection, by its partition column (repos by full_name, others by repo unless named). */
			repoRows: (table, columns, repo, column) => db.prepare(`SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)} WHERE ${column ? ident(column) : table === "repos" ? '"full_name"' : '"repo"'} = ?`).all(repo).map((r) => columns.map((c) => r[c])),
			close: () => { try { db.close(); } finally { fs.rmSync(dir, { recursive: true }); } },
		};
	} catch (e) {
		try { db?.close(); } finally { fs.rmSync(dir, { recursive: true }); }
		throw e;
	}
}

export async function fileSha256(file) {
	const h = createHash("sha256");
	for await (const b of fs.createReadStream(file)) h.update(b);
	return h.digest("hex");
}

/** Never follows a redirect; retries server errors and network failures with backoff, then throws. */
export function httpClient({ config, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	const call = async (url, init) => {
		let failure = "";
		for (let attempt = 0; attempt < RETRIES; attempt++) {
			if (attempt) await sleep(1000 * 2 ** (attempt - 1));
			let res;
			try { res = await fetchImpl(url, { ...init, redirect: "manual", headers: { ...init.headers, authorization: `Bearer ${fs.readFileSync(config.tokenFile, "utf8").trim()}` } }); }
			catch (e) { failure = `network: ${e.code ?? e.name ?? "error"}`; continue; }
			if (res.status >= 500 || res.status === 429) { failure = `HTTP ${res.status}`; continue; }
			if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Error("redirect refused");
			return res.json();
		}
		throw new Error(failure);
	};
	return {
		status: (profile) => call(new URL(`/v1/corpus/status?profile=${encodeURIComponent(profile)}`, config.server), { method: "GET", headers: {} }),
		send: (chunk) => call(new URL("/v1/corpus/import", config.server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) }),
		refresh: (body) => call(new URL("/v1/corpus/refresh", config.server), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	};
}

/** The foreground command, also run as `agent-memory corpus-upload`. Resolves to the process exit code. */
export async function main(args, command = "node local/corpus-cli.mjs", { runner, judgment = false, judgmentModel } = {}) {
	const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
	const [db, profile, tables, asOf, repo, checkouts] = [opt("db"), opt("profile"), opt("tables"), opt("as-of"), opt("refresh"), opt("git")?.split(",").filter(Boolean)];
	const fromGit = checkouts?.length && profile && !db && !tables && !asOf && !args.includes("--remove") && (!repo || checkouts.length === 1);
	const scans = args.includes("--scans");
	if (!fromGit && (checkouts || !db || !profile || !(tables || repo) || (tables && repo) || !asOf || Number.isNaN(Date.parse(asOf)))) {
		process.stderr.write(`usage: ${command} --db FILE --profile NAME (--tables t1,t2 | --refresh OWNER/REPO [--remove]) --as-of ISO [--config FILE]\n`
			+ `       ${command} --git CHECKOUT[,CHECKOUT...] --profile NAME [--scans] [--refresh OWNER/REPO] [--base FILE] [--config FILE]\n`);
		return 2;
	}
	try {
		const config = loadConfig(opt("config"));
		if (fromGit) {
			// Opportunistic Git-history refresh (and with --scans the checkout scans): unchanged or already-refreshed-today checkouts make no request; --refresh names one repo and always runs.
			const statePath = path.join(migrationDir(), `corpus-git-${profile}-${new URL(config.server).host}.json`);
			const results = await withLock(async () => {
				const base = opt("base") ? await sqliteSource(opt("base")) : null;
				try {
					let state = {};
					try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
					const checkoutsResolved = checkouts.map((c) => path.resolve(expand(c)));
					const results = await refreshCheckouts({ checkouts: checkoutsResolved, explicit: repo ?? null, profile, client: httpClient({ config }), state,
						save: (s) => writePrivate(statePath, JSON.stringify(s, null, 2)), base, openSource: sqliteSource, refresh: refreshCorpus, scans });
					if (judgment) results.push(await refreshJudgment({ checkouts: checkoutsResolved, profile, client: httpClient({ config }), base, runner, state,
						save: (s) => writePrivate(statePath, JSON.stringify(s, null, 2)), openSource: sqliteSource, candidateFile: `${statePath}.judgment.sqlite`, writePrivate, model: judgmentModel }));
					return results;
				} finally { base?.close(); }
			});
			process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
			return results.every((r) => ["published", "unchanged", "refreshed_today"].includes(r.status)) ? 0 : 1;
		}
		const statePath = path.join(migrationDir(), `corpus-${repo ? "refresh-" : ""}${profile}-${new URL(config.server).host}.json`);
		const r = await withLock(async () => {
			const source = await sqliteSource(db);
			try {
				let state = {};
				try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
				const save = (s) => writePrivate(statePath, JSON.stringify(s, null, 2));
				if (repo) {
					return await refreshCorpus({ source, client: httpClient({ config }), profile, repo, intent: args.includes("--remove") ? "remove" : "refresh",
						observedAt: new Date(asOf).toISOString(), sourceId: source.fileSha256, state, save });
				}
				return await uploadCorpus({ source, client: httpClient({ config }), profile, tables: tables.split(","), asOf: new Date(asOf).toISOString(), fileSha256: source.fileSha256, state, save });
			} finally { source.close(); }
		});
		process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
		return r.status === "done" || r.status === "published" ? 0 : 1;
	} catch (e) {
		process.stderr.write(`${e.message}\n`);
		return 1;
	}
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
