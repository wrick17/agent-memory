#!/usr/bin/env node
// Foreground corpus bulk load (section 14): node local/corpus-cli.mjs --db FILE --profile test --tables repos,commits --as-of ISO
// [--config FILE]. The source opens read-only with query_only on; the import token stays in its private file; the state file
// pins the generation, source hash and as_of, and the server's last keys decide where a rerun resumes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { uploadCorpus } from "./corpus-upload.mjs";
import { migrationDir, withLock, writePrivate } from "./migrate.mjs";
import { loadConfig } from "./upload.mjs";

const RETRIES = 5;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw new Error(`unsafe identifier ${s}`); return `"${s}"`; };

/** A read-only source: exact sqlite_master DDL for tables only, column names, and key-ordered pages after a key. */
export function sqliteSource(file) {
	const db = new DatabaseSync(file, { readOnly: true });
	db.exec("PRAGMA query_only = ON");
	return {
		schema: (table) => { const r = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get(table); return r?.type === "table" ? r.sql : null; },
		columns: (table) => db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table).map((r) => r.name),
		rows: (table, columns, key, after, limit) => {
			const k = key.map(ident).join(", ");
			const q = db.prepare(`SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)}${after ? ` WHERE (${k}) > (${after.map(() => "?").join(", ")})` : ""} ORDER BY ${k} LIMIT ?`);
			return q.all(...(after ?? []), limit).map((r) => columns.map((c) => r[c]));
		},
		close: () => db.close(),
	};
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
	};
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const args = process.argv.slice(2);
	const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
	const [db, profile, tables, asOf] = [opt("db"), opt("profile"), opt("tables"), opt("as-of")];
	if (!db || !profile || !tables || !asOf || Number.isNaN(Date.parse(asOf))) {
		process.stderr.write("usage: node local/corpus-cli.mjs --db FILE --profile NAME --tables t1,t2 --as-of ISO [--config FILE]\n");
		process.exit(2);
	}
	const config = loadConfig(opt("config"));
	const statePath = path.join(migrationDir(), `corpus-${profile}-${new URL(config.server).host}.json`);
	withLock(async () => {
		const source = sqliteSource(db);
		try {
			let state = {};
			try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
			return await uploadCorpus({ source, client: httpClient({ config }), profile, tables: tables.split(","), asOf: new Date(asOf).toISOString(), fileSha256: await fileSha256(db),
				state, save: (s) => writePrivate(statePath, JSON.stringify(s, null, 2)) });
		} finally { source.close(); }
	}).then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(r.status === "done" ? 0 : 1); }, (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
