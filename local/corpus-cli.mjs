#!/usr/bin/env node
// Foreground corpus bulk load (section 14): node local/corpus-cli.mjs --db FILE --profile test --tables repos,commits --as-of ISO
// [--config FILE]. With --refresh REPO [--remove] instead of --tables, it refreshes that one repo from the file, observed at --as-of. The source opens read-only with query_only on; the import token stays in its private file; the state file
// pins the generation, committed snapshot hash and as_of, and the server's last keys decide where a rerun resumes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { refreshCorpus } from "./corpus-refresh.mjs";
import { uploadCorpus } from "./corpus-upload.mjs";
import { migrationDir, withLock, writePrivate } from "./migrate.mjs";
import { loadConfig } from "./upload.mjs";

const RETRIES = 5;
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
			/** One repo's complete rows of a table in the refresh projection (contributors keyed by their repo column too). */
			repoRows: (table, columns, repo) => db.prepare(`SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)} WHERE ${table === "repos" ? '"full_name"' : '"repo"'} = ?`).all(repo).map((r) => columns.map((c) => r[c])),
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

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const args = process.argv.slice(2);
	const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
	const [db, profile, tables, asOf, repo] = [opt("db"), opt("profile"), opt("tables"), opt("as-of"), opt("refresh")];
	if (!db || !profile || !(tables || repo) || (tables && repo) || !asOf || Number.isNaN(Date.parse(asOf))) {
		process.stderr.write("usage: node local/corpus-cli.mjs --db FILE --profile NAME (--tables t1,t2 | --refresh OWNER/REPO [--remove]) --as-of ISO [--config FILE]\n");
		process.exit(2);
	}
	const config = loadConfig(opt("config"));
	const statePath = path.join(migrationDir(), `corpus-${repo ? "refresh-" : ""}${profile}-${new URL(config.server).host}.json`);
	withLock(async () => {
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
	}).then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(r.status === "done" || r.status === "published" ? 0 : 1); }, (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
