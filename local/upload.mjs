#!/usr/bin/env node
// Foreground uploader for a checked import plan (docs/import-implementation.md). It sends the plan's batches to
// POST /v1/import in order and saves an acknowledgement after each batch, so a rerun resumes at the first batch not
// acknowledged. Every server step is idempotent: a batch the server applied before its response was lost is sent again
// and replays. A refusal stops the run and is reported; nothing is skipped. The token stays in its private file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "../src/domain/ids.ts";
import { identityDigest, textDigest, textRowsDigest, attrsDigest, nodeDigest, requestDigest, requestSource, revisionDigest, rowsDigest } from "../src/domain/import-audit.ts";
import { dryRun, migrationDir, planRecords, readJsonl, withLock, writePrivate } from "./migrate.mjs";

const RETRIES = 5;
const ACCEPTED = new Set(["stored", "replayed", "published", "linked"]);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const expand = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

/** A private file: owned by this user and not readable by group or others. */
function assertPrivate(file, what) {
	const st = fs.statSync(file);
	if (st.mode & 0o077) throw new Error(`${what} ${file} must not be readable by group or others (chmod 600)`);
	if (st.uid !== process.getuid()) throw new Error(`${what} ${file} must belong to this user`);
}

/**
 * The upload config: `{ "server": "https://…", "token_file": "~/.agent-memory/migration/<name>.token", "rehearsal": true }`.
 * `rehearsal: true` marks the separate rehearsal Worker; a rehearsal plan goes only there, a routed plan never does.
 */
export function loadConfig(file = path.join(migrationDir(), "upload.json")) {
	assertPrivate(file, "upload config");
	const c = JSON.parse(fs.readFileSync(file, "utf8"));
	if (typeof c.server !== "string" || typeof c.token_file !== "string") throw new Error("the upload config needs server and token_file");
	const url = new URL(c.server);
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("the server must use https");
	assertPrivate(expand(c.token_file), "token file");
	return { server: url.origin, tokenFile: expand(c.token_file), rehearsal: c.rehearsal === true };
}

/**
 * Uploads one plan. Returns `done`, or `refused` (a receipt was not accepted) or `stopped` (the server or network kept
 * failing), with the batch and metadata only: record ids, operations and reasons, never memory text or the token.
 */
export async function upload({ exportDir, rehearsal = null, config, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	if (Boolean(rehearsal) !== config.rehearsal) throw new Error(rehearsal ? "a rehearsal plan goes only to the rehearsal server" : "a routed plan never goes to the rehearsal server");
	return withLock(async () => {
		const check = dryRun({ exportDir, rehearsal });
		if (check.over_budget_parts || check.over_budget_commands || check.over_budget_batches) throw new Error("the plan has commands over budget; plan again");
		const dir = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan");
		const manifest = readJson(path.join(dir, "manifest.json"));
		if (manifest.refresh_server && manifest.refresh_server !== config.server) throw new Error("a refresh must use the server that completed its base upload");
		const commands = readJsonl(path.join(dir, "commands.jsonl"));
		const batches = readJsonl(path.join(dir, "batches.jsonl"));
		const statePath = path.join(dir, `upload-${new URL(config.server).host}.json`);
		// The state belongs to one checked plan: its commands and its batch schedule. Acknowledged batches are skipped only for that plan.
		const state = readJson(statePath) ?? { commands_sha256: check.commands_sha256, batches_sha256: check.batches_sha256, server: config.server, done: [], receipts: {} };
		if (state.commands_sha256 !== check.commands_sha256 || state.batches_sha256 !== check.batches_sha256) {
			throw new Error(`the plan changed since this upload began (${statePath}); keep that state and upload a fresh export instead`);
		}
		const save = () => writePrivate(statePath, JSON.stringify(state, null, 2));
		const importId = check.commands_sha256.slice(0, 32);
		for (const b of batches) {
			if (state.done.includes(b.batch)) continue;
			const body = JSON.stringify({ import_id: importId, batch: b.batch, commands: b.commands.map((i) => commands[i]) });
			let res = null, failure = null;
			for (let attempt = 0; attempt < RETRIES; attempt++) {
				if (attempt) await sleep(1000 * 2 ** (attempt - 1));
				try {
					// Never follow a redirect: the body may only ever reach the configured origin.
					res = await fetchImpl(new URL("/v1/import", config.server), { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${fs.readFileSync(config.tokenFile, "utf8").trim()}`, "content-type": "application/json" }, body });
				} catch (e) { failure = `network: ${e.code ?? e.name ?? "error"}`; res = null; continue; }
				if (res.status >= 500 || res.status === 429) { failure = `HTTP ${res.status}`; continue; }
				if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) { failure = `HTTP ${res.status || "redirect"}: redirect refused`; res = null; break; }
				break;
			}
			if (!res || !res.ok) {
				state.stopped = { batch: b.batch, failure: res ? `HTTP ${res.status}` : failure, at: new Date().toISOString() };
				save();
				return { status: "stopped", ...state.stopped, done: state.done.length, batches: batches.length };
			}
			const receipts = (await res.json()).receipts.map(({ index, op, record_id, part_id, status, reason }) => ({ index, op, record_id, ...(part_id ? { part_id } : {}), status, ...(reason ? { reason } : {}) }));
			state.receipts[b.batch] = receipts;
			const refused = receipts.filter((r) => !ACCEPTED.has(r.status));
			if (refused.length || receipts.length !== b.commands.length) {
				state.stopped = { batch: b.batch, refused, at: new Date().toISOString() };
				save();
				return { status: "refused", batch: b.batch, refused, done: state.done.length, batches: batches.length };
			}
			state.done.push(b.batch);
			delete state.stopped;
			save();
		}
		return { status: "done", done: state.done.length, batches: batches.length, commands: commands.length };
	});
}

/**
 * Read-only check of what the server stored for an uploaded plan (migration verification 1 and 2,
 * docs/import-integrity-design.md). Pages GET /v1/import/audit and compares every record's stored hashes and row digests
 * with the same digests computed from the plan's commands. Writes a private report beside the upload state; returns
 * counts and record ids by class, never content.
 */
export async function audit({ exportDir, rehearsal = null, config, fetchImpl = fetch }) {
	if (Boolean(rehearsal) !== config.rehearsal) throw new Error(rehearsal ? "a rehearsal plan is audited only on the rehearsal server" : "a routed plan is never audited on the rehearsal server");
	const dir = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan");
	// The same checked plan the upload sent: its manifest, commands and schedule must match, and so must the upload state.
	const check = dryRun({ exportDir, rehearsal });
	const state = readJson(path.join(dir, `upload-${new URL(config.server).host}.json`));
	if (state && state.commands_sha256 !== check.commands_sha256) throw new Error("the plan changed since it was uploaded to this server; audit the plan that was uploaded");
	// Records are keyed by profile and id, so a copy of a record in a second profile shows as extra.
	const key = (profile, id) => `${profile}\u0000${id}`;
	const expected = new Map();
	for (const r of planRecords(dir)) {
		expected.set(key(r.route.profile, r.id), { id: r.id, profile: r.route.profile, record_sha256: r.record_sha256,
			node: r.node, node_sha256: nodeDigest(r.node), ...attrsDigest(r.node.attrs), revisions: r.revisions.map(revisionDigest),
			requests: r.requests.map((q) => requestDigest({ ...q, source: requestSource(q) })), ...(r.node.attrs.import_review ? {texts:r.texts.map(textDigest),identity_sha256:identityDigest(r.node.scope,r.node.memory_type,normalizeName(r.node.name))} : {}) });
	}
	if (!expected.size) throw new Error("the plan has no records to audit");
	const get = async (query) => {
		const url = new URL("/v1/import/audit", config.server);
		for (const [k, v] of Object.entries(query)) if (v !== null) url.searchParams.set(k, String(v));
		// Never follow a redirect: the token may only ever reach the configured origin.
		const res = await fetchImpl(url, { redirect: "manual", headers: { authorization: `Bearer ${fs.readFileSync(config.tokenFile, "utf8").trim()}` } });
		if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Error(`HTTP ${res.status || "redirect"}: redirect refused`);
		if (!res.ok) throw new Error(`audit request failed: HTTP ${res.status}`);
		return res.json();
	};
	const found = new Map(), totals = {};
	for (const profile of new Set([...expected.values()].map((e) => e.profile))) {
		let after = null;
		do {
			const page = await get({ profile, after, limit: 50 });
			if (page.totals) totals[profile] = page.totals;
			for (const r of page.records) found.set(key(profile, r.record_id), { ...r, profile });
			if (page.next_after !== null && page.next_after === after) throw new Error("the audit did not advance");
			after = page.next_after;
		} while (after !== null);
	}
	// A record too large for one summary page comes with counts only: read its rows through the detail pages. The node's
	// revision must hold across all of them; if it moved, a hosted write came in while it was read, and that is drift.
	for (const f of found.values()) {
		if (!f.paged) continue;
		for (const rows of ["revisions", "requests"]) {
			const all = [];
			let after = null;
			do {
				const page = await get({ profile: f.profile, record: f.record_id, rows, after, limit: 200 });
				if (page.node_revision !== (f.node?.revision ?? null)) f.moved_while_read = true;
				all.push(...page.rows);
				if (page.next_after !== null && page.next_after === after) throw new Error("the audit did not advance");
				after = page.next_after;
			} while (after !== null);
			f[rows] = { ...f[rows], count: all.length, sha256: rowsDigest(all) };
		}
	}
	for (const [k,e] of expected) {
		if (!e.texts) continue;
		const f=found.get(k);if(!f)continue;
		const all=[];let after=null;
		do {
			const page=await get({profile:e.profile,record:e.id,rows:"texts",after,limit:200});
			if (page.node_revision !== f.node?.revision || page.record_sha256 !== f.record_sha256 || page.node_sha256 !== f.node?.row_sha256) f.moved_while_read=true;
			all.push(...page.rows);if(page.next_after!==null && page.next_after===after)throw new Error("text audit did not advance");after=page.next_after;
		} while(after!==null);
		f.texts=all;
	}

	const mismatches = { missing: [], extra: [], state: [], record: [], node: [], attrs: [], source: [], revisions: [], requests: [], ...(readJson(path.join(dir,"manifest.json"))?.version===2 ? {identity:[],texts:[]} : {}) }, drift = [];
	for (const [k, e] of expected) {
		const f = found.get(k), id = e.id;
		if (!f) { mismatches.missing.push(id); continue; }
		const check = (cls, ok) => { if (!ok) mismatches[cls].push(id); };
		check("state", f.state === "published" && f.node !== null);
		check("record", f.record_sha256 === e.record_sha256);
		// As published, and as stored now: unless a hosted write moved its revision on, the node row must equal the plan's node.
		// Publish stores the time of publication for a missing created_at or updated_at.
		const now = f.node && { ...e.node, created_at: e.node.created_at ?? f.published_at, updated_at: e.node.updated_at ?? f.published_at };
		const moved = f.node && f.node.revision !== e.node.revision;
		check("node", f.node_sha256 === e.node_sha256 && (!f.node || moved || f.node.row_sha256 === nodeDigest(now)));
		check("attrs", f.node?.attrs_sha256 === e.attrs_sha256);
		check("source", f.node?.source_sha256 === e.source_sha256);
		check("revisions", f.revisions.count === e.revisions.length && f.revisions.sha256 === rowsDigest(e.revisions));
		check("requests", f.requests.count === e.requests.length && f.requests.sha256 === rowsDigest(e.requests));
		if(e.texts){check("identity",f.node?.identity_sha256===e.identity_sha256);check("texts",f.texts && textRowsDigest(f.texts)===textRowsDigest(e.texts));}
		// Hosted changes since the import are drift: listed, and they fail the audit, while the imported rows are still checked exactly.
		if (f.revisions.hosted || f.requests.hosted || moved || f.moved_while_read) drift.push(id);
	}
	for (const [k, f] of found) if (!expected.has(k)) mismatches.extra.push(`${f.profile}/${f.record_id}`);
	const bad = Object.values(mismatches).reduce((n, ids) => n + ids.length, 0);
	// Full match only: a mismatch, or any hosted change since the import, makes the audit unsuccessful.
	const report = { server: config.server, at: new Date().toISOString(), status: bad ? "mismatch" : drift.length ? "drift" : "ok", records: expected.size, found: found.size, totals,
		mismatches: Object.fromEntries(Object.entries(mismatches).map(([k, ids]) => [k, { count: ids.length, ids }])), drift: { count: drift.length, ids: drift } };
	writePrivate(path.join(dir, `audit-${new URL(config.server).host}.json`), JSON.stringify(report, null, 2));
	return { status: report.status, records: report.records, found: report.found, mismatches: Object.fromEntries(Object.entries(mismatches).map(([k, ids]) => [k, ids.length])), drift: drift.length };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const all = process.argv.slice(2), auditing = all[0] === "audit", rest = auditing ? all.slice(1) : all;
	const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
	const state = readJson(path.join(migrationDir(), "state.json"));
	const exportDir = opt("export") ?? state?.exports?.at(-1)?.dir?.replace(/^~/, os.homedir());
	if (!exportDir) { process.stderr.write("usage: node local/upload.mjs [audit] [--export DIR] [--rehearsal test] [--config FILE]\n"); process.exit(2); }
	(auditing ? audit : upload)({ exportDir, rehearsal: opt("rehearsal") ?? null, config: loadConfig(opt("config")) })
		.then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(r.status === "done" || r.status === "ok" ? 0 : 1); }, (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
