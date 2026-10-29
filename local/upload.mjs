#!/usr/bin/env node
// Foreground uploader for a checked import plan (docs/import-implementation.md). It sends the plan's batches to
// POST /v1/import in order and saves an acknowledgement after each batch, so a rerun resumes at the first batch not
// acknowledged. Every server step is idempotent: a batch the server applied before its response was lost is sent again
// and replays. A refusal stops the run and is reported; nothing is skipped. The token stays in its private file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dryRun, migrationDir, readJsonl, withLock, writePrivate } from "./migrate.mjs";

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

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const rest = process.argv.slice(2);
	const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
	const state = readJson(path.join(migrationDir(), "state.json"));
	const exportDir = opt("export") ?? state?.exports?.at(-1)?.dir?.replace(/^~/, os.homedir());
	if (!exportDir) { process.stderr.write("usage: node local/upload.mjs [--export DIR] [--rehearsal test] [--config FILE]\n"); process.exit(2); }
	upload({ exportDir, rehearsal: opt("rehearsal") ?? null, config: loadConfig(opt("config")) })
		.then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exit(r.status === "done" ? 0 : 1); }, (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
