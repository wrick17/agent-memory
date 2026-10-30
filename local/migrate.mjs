#!/usr/bin/env node
// Agent Memory import, first slice (docs/import-implementation.md): a read-only export of BothQ and the curated Markdown
// memory, and a deterministic, staged import plan. Nothing here writes to BothQ, to a Markdown file or to the server.
// Every output is private (directories 0700, files 0600); stdout carries counts and hashes only, never memory text.
import { importDecision, importPolicy, ownerClassification, ownerSemantic } from "../src/domain/import-policy.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, collapse, normalizeName, normalizeScope, sha256, uuid5 } from "../src/domain/ids.ts";
import { redactPayload, redactText } from "../src/domain/redact.ts";
import { stripPersonal } from "../src/domain/personal.ts";
import { IMPORT_BUDGET as BUDGET, TEXT_CHUNK as CHUNK, PART_OVERHEAD, pack, publishCost, refreshPublishCost } from "../src/domain/import-cost.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLAN_VERSION = 1;
const POLICY_PLAN_VERSION = 2;
// The transaction budget, the measured row costs and the packer are shared with the server (src/domain/import-cost.ts).
export { IMPORT_BUDGET as BUDGET, TEXT_CHUNK as CHUNK } from "../src/domain/import-cost.ts";
const BATCH = { commands: 50, bytes: 1_000_000 };
/** Bytes an upload request adds around its commands (`{"import_id":…,"batch":…,"commands":[…]}`), kept out of every command's share. */
const ENVELOPE = 1024;
const BODY_OPS = new Set(["saved", "updated", "legacy_adopted"]);
const KNOWN_OPS = new Set([...BODY_OPS, "appended", "superseded", "retired"]);
const TYPES = new Set(["feedback", "project", "reference", "procedural", "user"]);

export const home = () => process.env.AGENT_MEMORY_HOME || path.join(os.homedir(), ".agent-memory");
export const migrationDir = () => path.join(home(), "migration");
const utf8 = (s) => Buffer.byteLength(s, "utf8");
const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);
const iso = (v) => (v && typeof v === "object" && v.iso ? v.iso : typeof v === "string" ? v : null);
const nonEmpty = (s) => typeof s === "string" && s.length > 0;

function privateDir(d) {
	fs.mkdirSync(d, { recursive: true, mode: 0o700 });
	fs.chmodSync(d, 0o700);
	return d;
}
/** Atomic private write: a crash never leaves half a file. */
export function writePrivate(file, data) {
	privateDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.renameSync(tmp, file);
}
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
export const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** One migrate run at a time. A lock left by a crash is never reclaimed automatically: it names its pid, and the owner removes it. */
export async function withLock(fn) {
	const lock = path.join(privateDir(migrationDir()), "run.lock");
	try {
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
	} catch (e) {
		if (e.code !== "EEXIST") throw e;
		throw new Error(`another migrate run holds ${lock} (${fs.readFileSync(lock, "utf8")}); if no migrate process is running, remove that file`);
	}
	try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

// ---------- BothQ hashing (memory_store.py), checked against BothQ-computed fixtures in migrate.test.mjs ----------

/** BothQ content_hash: SHA-256 of its canonical content_source (name, type, the five text fields, steps). */
export function bothqContentHash(f, steps = []) {
	return sha256(canonicalJson({ name: f.name ?? "", type: f.memory_type ?? "", description: f.description || "", content: f.content || "", why: f.why || "",
		how_to_apply: f.how_to_apply || "", objective: f.objective || "", steps }));
}

// ---------- export ----------

const walk = (dir, skip = () => false) => {
	const out = [];
	for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
		const p = path.join(dir, e.name);
		if (skip(e.name)) continue;
		if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory())) out.push(...walk(p, skip));
		else out.push(p);
	}
	return out;
};

/** Codex memory categories (research 05). Skills and instructions are reference candidates, never preferences. */
function codexCategory(rel) {
	if (rel === "MEMORY.md") return "codex_memory";
	if (rel === "raw_memories.md") return "codex_raw_memories";
	if (rel === "memory_summary.md") return "codex_summary_index";
	if (/^rollout_summaries\/[^/]+\.md$/.test(rel)) return "codex_rollout_summary";
	if (/^extensions\/ad_hoc\/notes\/[^/]+\.md$/.test(rel)) return "codex_note";
	if (/^skills\/[^/]+\/SKILL\.md$/.test(rel) || rel === "extensions/ad_hoc/instructions.md") return "codex_reference_candidate";
	return "codex_other";
}

/**
 * The curated Markdown memory, read only. Claude Code memory folders (`<root>/<project>/memory/**.md`) and the Codex
 * memories folder without its `.git`. Paths that resolve to one file (a symlinked project folder) become one entry with
 * every path kept. Raw transcripts, tool output and the corpus are not here.
 */
export function enumerateMarkdown({ claudeRoots, codexRoot }) {
	const found = [];
	let gitFiles = 0, otherFiles = 0;
	for (const root of claudeRoots) {
		for (const project of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
			const mem = path.join(root, project, "memory");
			if (!fs.statSync(mem, { throwIfNoEntry: false })?.isDirectory()) continue;
			for (const f of walk(mem)) {
				if (!f.endsWith(".md")) { otherFiles++; continue; }
				const rel = path.relative(mem, f);
				found.push({ path: f, system: "claude", root: tilde(root), project, rel, category: rel === "MEMORY.md" ? "claude_index" : "claude_topic" });
			}
		}
	}
	if (codexRoot && fs.existsSync(codexRoot)) {
		gitFiles = walk(path.join(codexRoot, ".git")).length;
		for (const f of walk(codexRoot, (n) => n === ".git")) {
			const rel = path.relative(codexRoot, f);
			if (!f.endsWith(".md")) { otherFiles++; continue; }
			found.push({ path: f, system: "codex", root: tilde(codexRoot), rel, category: codexCategory(rel) });
		}
	}
	const byReal = new Map();
	for (const x of found) {
		const real = fs.realpathSync(x.path);
		const prior = byReal.get(real);
		if (prior) { prior.paths.push(tilde(x.path)); continue; }
		byReal.set(real, { ...x, realpath: tilde(real), paths: [tilde(x.path)] });
	}
	const files = [...byReal.values()].sort((a, b) => a.realpath.localeCompare(b.realpath)).map(({ path: p, ...x }) => {
		const read = stableRead(p);
		// A file that kept changing while it was read is exported without content and held: no mixed body is ever accepted.
		if (!read) return { ...x, paths: x.paths.sort(), unstable: true, bytes: null, sha256: null, utf8: null, mtime: null, birthtime: null };
		const { buf, st } = read;
		const text = buf.toString("utf8");
		const ok = Buffer.from(text, "utf8").equals(buf);
		return { ...x, paths: x.paths.sort(), bytes: buf.length, sha256: sha256Bytes(buf), utf8: ok, mtime: st.mtime.toISOString(), birthtime: st.birthtime.toISOString(),
			...(ok ? { content: text } : { content_base64: buf.toString("base64") }) };
	});
	return { files, paths: found.length, gitFiles, otherFiles };
}
const sha256Bytes = (buf) => createHash("sha256").update(buf).digest("hex");

/** A file read between two identical stat witnesses (device, inode, size, mtime, ctime), retried, else null. */
export function stableRead(p, tries = 3) {
	const witness = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
	for (let i = 0; i < tries; i++) {
		const before = fs.statSync(p);
		const buf = fs.readFileSync(p);
		const after = fs.statSync(p);
		if (witness(before) === witness(after) && buf.length === after.size) return { buf, st: after };
	}
	return null;
}

/** Runs BothQ's own interpreter on export_bothq.py: read transactions only, through BothQ's configured driver. */
function exportBothq({ graphDb, python, out }) {
	const r = spawnSync(python, [path.join(HERE, "migrate", "export_bothq.py"), "--graph-db", graphDb, "--out", out],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`BothQ export failed (${r.status ?? r.error?.code}): ${redactText((r.stderr || "").trim().split("\n").pop() ?? "").slice(0, 300)}`);
	return JSON.parse(r.stdout.trim().split("\n").pop());
}

export const DEFAULT_SOURCES = {
	graphDb: path.join(os.homedir(), "Projects/bot_hq/graph-db"),
	python: path.join(os.homedir(), "Projects/bot_hq/graph-db/.venv/bin/python"),
	claudeRoots: [path.join(os.homedir(), ".plaude/projects"), path.join(os.homedir(), ".claude/projects")],
	codexRoot: path.join(os.homedir(), ".codex/memories"),
};

/** `export`: a new private export folder with the BothQ records, the Markdown files and a manifest of counts and hashes. */
export async function exportAll(sources = DEFAULT_SOURCES, { bothq = true } = {}) {
	return withLock(async () => {
		const dir = privateDir(path.join(migrationDir(), `export-${stamp()}-${randomBytes(2).toString("hex")}`));
		const started = new Date().toISOString();
		const bq = bothq ? exportBothq({ graphDb: sources.graphDb, python: sources.python, out: privateDir(path.join(dir, "bothq")) }) : null;
		const md = enumerateMarkdown(sources);
		writePrivate(path.join(dir, "markdown", "files.jsonl"), jsonl(md.files));
		const byCat = {};
		for (const f of md.files) { const c = (byCat[f.category] ??= { files: 0, paths: 0, bytes: 0 }); c.files++; c.paths += f.paths.length; c.bytes += f.bytes ?? 0; }
		const fileSha = (f) => (fs.existsSync(f) ? sha256Bytes(fs.readFileSync(f)) : null);
		const manifest = {
			version: PLAN_VERSION, started_at: started, finished_at: new Date().toISOString(), dir: tilde(dir),
			bothq: bq && { ...bq, records_jsonl_sha256: fileSha(path.join(dir, "bothq", "records.jsonl")), unlinked_jsonl_sha256: fileSha(path.join(dir, "bothq", "requests-unlinked.jsonl")) },
			markdown: { paths: md.paths, distinct: md.files.length, bytes: md.files.reduce((n, f) => n + (f.bytes ?? 0), 0), not_utf8: md.files.filter((f) => !f.utf8).length,
				excluded_git_files: md.gitFiles, excluded_other_files: md.otherFiles, by_category: byCat, unstable: md.files.filter((f) => f.unstable).length,
				files_jsonl_sha256: fileSha(path.join(dir, "markdown", "files.jsonl")),
				files_sha256: sha256(md.files.map((f) => `${f.realpath}\t${f.sha256}`).join("\n")) },
		};
		writePrivate(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
		const state = readJson(path.join(migrationDir(), "state.json"), { exports: [], plans: {} });
		state.exports.push({ dir: tilde(dir), manifest_sha256: sha256(JSON.stringify(manifest)) });
		writePrivate(path.join(migrationDir(), "state.json"), JSON.stringify(state, null, 2));
		return { dir, manifest };
	});
}

// ---------- routing ----------

/** The Worker's default routing rules from wrangler.jsonc, as the hosted routing reads them. */
export function defaultRouting() {
	const raw = fs.readFileSync(path.join(HERE, "..", "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
	const spec = /"ROUTING_DEFAULTS":\s*"([^"]*)"/.exec(raw)?.[1] ?? "";
	return spec.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => { const at = pair.lastIndexOf("="); return { pattern: pair.slice(0, at), profile: pair.slice(at + 1) }; });
}
// Same normalization and glob as src/routing.ts.
function normalizeRemote(remote) {
	let r = remote.trim().replace(/\.git$/, "").replace(/\/+$/, "").replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
	const scp = /^([^/:]+):(?!\d+\/)(.+)$/.exec(r);
	if (scp) r = `${scp[1]}/${scp[2]}`;
	return r.replace(/^([^/:]+):\d+\//, "$1/").toLowerCase();
}
const glob = (pattern, value) => new RegExp(`^${pattern.toLowerCase().split("**").map((p) => p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`).test(value);

const remotes = new Map();
/** The origin remote of a local checkout, read with `git remote get-url` (no fetch, no write). */
function remoteOf(dir) {
	if (!remotes.has(dir)) {
		const r = fs.existsSync(dir) ? spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000 }) : null;
		remotes.set(dir, r?.status === 0 ? viaSshAlias(r.stdout.trim()) : null);
	}
	return remotes.get(dir);
}
/** An scp-style remote through an SSH host alias (`git@personal:owner/repo`) gets the alias's real host from `ssh -G`. */
function viaSshAlias(remote) {
	const m = /^([^@\s/]+@)?([^:/\s.]+):(?!\/)(.+)$/.exec(remote);
	if (!m) return remote;
	const host = /^hostname\s+(\S+)$/m.exec(spawnSync("ssh", ["-G", m[2]], { encoding: "utf8", timeout: 5000 }).stdout ?? "")?.[1];
	return host && host !== m[2] ? `${m[1] ?? ""}${host}:${m[3]}` : remote;
}

/**
 * Every existing path a Claude project folder name can stand for: each `-` was `/`, `.`, `_` or `-`, chosen independently,
 * so `--` covers a hidden folder (`/.`) as well as `--`, `._`, `_-` and the rest. The encoding is lossy, so more than one
 * path can match; the caller holds that case instead of choosing one. Returns null if the search outgrows its bound,
 * which the caller holds too: an incomplete candidate set never routes.
 */
export function decodeProjectDirs(name, limit = 200_000) {
	const enc = name.replace(/^-/, "");
	const listing = new Map();
	const ls = (d) => { if (!listing.has(d)) { try { listing.set(d, fs.readdirSync(d)); } catch { listing.set(d, []); } } return listing.get(d); };
	const isDir = (d) => !!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory();
	const found = new Set();
	let steps = 0;
	// `dir` is an existing folder; `seg` is the part of the next path segment decoded so far.
	const go = (i, dir, seg) => {
		if (++steps > limit) return;
		// Prune: some entry of the folder must start with the segment built so far.
		if (seg && !ls(dir).some((e) => e.startsWith(seg))) return;
		if (i === enc.length) { if (seg && fs.existsSync(path.join(dir, seg))) found.add(path.join(dir, seg)); return; }
		if (enc[i] !== "-") return go(i + 1, dir, seg + enc[i]);
		if (seg && isDir(path.join(dir, seg))) go(i + 1, path.join(dir, seg), "");
		for (const sep of [".", "_", "-"]) go(i + 1, dir, seg + sep);
	};
	go(0, "/", "");
	return steps > limit ? null : [...found].sort();
}

/** A profile from a local path, through its git remote and the routing rules; null when no rule applies. */
function routePath(dir, rules) {
	if (!dir) return null;
	const remote = remoteOf(dir);
	const rule = remote ? rules.find((r) => !r.pattern.startsWith("path:") && glob(r.pattern, normalizeRemote(remote))) : undefined;
	const byPath = rule ? undefined : rules.find((r) => r.pattern.startsWith("path:") && (dir === r.pattern.slice(5) || dir.startsWith(`${r.pattern.slice(5)}/`)));
	const hit = rule ?? byPath;
	return hit && hit.profile !== "me" ? { profile: hit.profile, rule: hit.pattern, evidence: remote ? `remote ${normalizeRemote(remote)}` : `path ${tilde(dir)}` } : null;
}

/**
 * The owner's reviewed routes (`plan --routes FILE`): exact sources of one export, each bound to its id, scope and the SHA-256
 * of its exported row, sent to `work` or `personal`, never `me`. Refused whole, before any output, when anything differs.
 */
export function readReviewedRoutes(file, exportDir) {
	const bytes = fs.readFileSync(file);
	const fail = (why) => { throw new Error(`reviewed routes refused: ${why}`); };
	const exact = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
	let doc;
	try { doc = JSON.parse(bytes.toString("utf8")); } catch { fail("not JSON"); }
	if (doc?.version === 2) return readOwnerWork(doc, bytes, exportDir, fail, exact);
	if (!exact(doc, ["version", "export_manifest_sha256", "routes"]) || doc.version !== 1 || !Array.isArray(doc.routes) || !doc.routes.length) fail("schema");
	if (doc.export_manifest_sha256 !== sha256Bytes(fs.readFileSync(path.join(exportDir, "manifest.json")))) fail("made for another export");
	const routes = new Map();
	doc.routes.forEach((r, i) => {
		const n = i + 1;
		if (!exact(r, ["source", "id", "scope", "profile", "source_sha256"]) || ![r.source, r.id, r.scope].every(nonEmpty) || !/^[0-9a-f]{64}$/.test(r.source_sha256)) fail(`route ${n} schema`);
		if (r.profile === "me") fail(`route ${n} goes to me; nothing is routed into me`);
		if (r.profile !== "work" && r.profile !== "personal") fail(`route ${n} profile`);
		if (routes.has(r.source)) fail(`route ${n} repeats a source`);
		routes.set(r.source, { ...r, n });
	});
	return { sha256: sha256Bytes(bytes), routes };
}

/**
 * Route version 2, effect legacy_work_owner only: the owner's decision that every listed legacy identity of one export goes to
 * Work. An explicit roster sorted by source key, each entry bound to its id, original scope and exported row; null id or scope
 * stays held. No other target, default, pattern, alias, me exception or hold waiver can be expressed.
 */
function readOwnerWork(doc, bytes, exportDir, fail, exact) {
	const d = doc.owner_decision;
	if (!exact(doc, ["version", "effect", "export_manifest_sha256", "owner_decision", "owner_decision_sha256", "roster"]) || doc.effect !== "legacy_work_owner"
		|| !Array.isArray(doc.roster) || !doc.roster.length || !exact(d, ["reference", "answer", "roster_sha256"]) || !nonEmpty(d.reference) || d.reference.length > 512
		|| !nonEmpty(d.answer) || d.answer.length > 1024) fail("schema");
	if (doc.export_manifest_sha256 !== sha256Bytes(fs.readFileSync(path.join(exportDir, "manifest.json")))) fail("made for another export");
	if (d.roster_sha256 !== sha256(canonicalJson(doc.roster)) || doc.owner_decision_sha256 !== sha256(canonicalJson(d))) fail("owner decision or roster digest differs");
	const routes = new Map();
	doc.roster.forEach((r, i) => {
		const n = i + 1, maybe = (v) => v === null || nonEmpty(v);
		if (!exact(r, ["source", "id", "scope", "source_sha256"]) || !nonEmpty(r.source) || !maybe(r.id) || !maybe(r.scope) || !/^[0-9a-f]{64}$/.test(r.source_sha256)) fail(`roster ${n} schema`);
		if (i && !(doc.roster[i - 1].source < r.source)) fail(`roster ${n} is not strictly sorted by source`);
		routes.set(r.source, { ...r, n });
	});
	return { sha256: sha256Bytes(bytes), version: 2, manifest: doc.export_manifest_sha256, owner_decision: d, owner_decision_sha256: doc.owner_decision_sha256, routes };
}

/** One record's compact owner witness (attrs.source.owner_classification); an archival reference's profile receipt is its digest. */
export const ownerWitness = (reviewed, r, it) => ({ version: 1, effect: "legacy_work_owner", profile: "work", owner_decision: reviewed.owner_decision,
	owner_decision_sha256: reviewed.owner_decision_sha256, witness: { export_manifest_sha256: reviewed.manifest, source_key_sha256: sha256(r.source),
		source_row_sha256: r.source_sha256, id: r.id, scope: r.scope, memory_type: it.node.memory_type } });

/** The owner's Work decision for each exact roster member with an id and scope. The ordinary route stays as evidence; v1 conflict refusal is untouched. */
function applyOwnerWork(items, rows, reviewed) {
	const at = new Map(items.map((it, i) => [it.key, i]));
	for (const r of reviewed.routes.values()) {
		const fail = (why) => { throw new Error(`reviewed routes refused: roster ${r.n} ${why}`); };
		const i = at.get(r.source);
		if (i === undefined) fail("names a source this export does not have");
		const it = items[i];
		if ((it.id ?? null) !== r.id || (it.node.scope ?? null) !== r.scope || sha256(canonicalJson(rows[i])) !== r.source_sha256) fail("no longer matches its exported source");
		if (r.id === null || r.scope === null) continue;
		it.route = { profile: "work", rule: "legacy_work_owner", automatic: it.route };
		it.node.attrs.source.owner_classification = ownerWitness(reviewed, r, it);
	}
}

/** Routes each reviewed source that is still the exact row it was reviewed as and that no rule routes. Every other hold still applies. */
function applyReviewed(items, rows, reviewed) {
	const at = new Map(items.map((it, i) => [it.key, i]));
	for (const r of reviewed.routes.values()) {
		const fail = (why) => { throw new Error(`reviewed routes refused: route ${r.n} ${why}`); };
		const i = at.get(r.source);
		if (i === undefined) fail("names a source this export does not have");
		const it = items[i];
		if (it.id !== r.id || it.node.scope !== r.scope || sha256(canonicalJson(rows[i])) !== r.source_sha256) fail("no longer matches its exported source");
		if (it.route) fail("conflicts with an existing routing rule");
		it.route = { profile: r.profile, rule: "reviewed" };
	}
}

/** One private exact-source approval input; it changes no routing rule and grants no other hold waiver. */
export function readSourcePolicy(file, exportDir) {
	const st = fs.statSync(file), bytes = fs.readFileSync(file);
	if (st.uid !== process.getuid() || (st.mode & 0o077) || bytes.length > 65536) throw new Error("source policy needs a private owner file within 65536 bytes");
	const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && canonicalJson(Object.keys(o).sort()) === canonicalJson([...keys].sort());
	const d = JSON.parse(bytes.toString("utf8"));
	if (!exact(d, ["version", "export_manifest_sha256", "entries"]) || d.version !== 1 || d.export_manifest_sha256 !== sha256Bytes(fs.readFileSync(path.join(exportDir, "manifest.json"))) || !Array.isArray(d.entries) || !d.entries.length || d.entries.length > 32) throw new Error("source policy version/export/schema differs");
	const seen = new Set();
	for (const e of d.entries) {
		const fields = ["source", "id", "scope", "profile", "source_sha256", "kind", "owner_decision", "owner_decision_sha256", ...(e.kind === "archival_reference" ? ["profile_review_sha256"] : [])];
		if (!exact(e, fields) || ![e.source,e.id,e.scope].every(nonEmpty) || !["work","personal"].includes(e.profile) || !/^[a-f0-9]{64}$/.test(e.source_sha256) || seen.has(e.source)) throw new Error("source policy entry/schema/profile differs");
		const decision = importDecision.parse(e.owner_decision);
		if (decision.kind !== e.kind || !decision.permitted_ids.includes(e.id) || sha256(canonicalJson(decision)) !== e.owner_decision_sha256) throw new Error("source policy decision digest/membership differs");
		if (e.kind === "archival_reference" && !/^[a-f0-9]{64}$/.test(e.profile_review_sha256)) throw new Error("source policy needs an individual profile review");
		seen.add(e.source);
	}
	return { sha256: sha256Bytes(bytes), manifest: d.export_manifest_sha256, entries: d.entries };
}

function policyProjection(it, p) {
	it.node.attrs.import_review = p;
	if (p.kind === "source_suffix") {
		it.node.name = p.source_head.name + ` [source ${it.id.slice(0,8)}]`;
		if (it.node.name.length > 512) throw new Error("source policy name exceeds 512 characters");
		it.node.content_hash = bothqContentHash({ ...it.node, content: it.content }, it.node.steps ?? []);
	}
	return it;
}

function applySourcePolicy(items, rows, policy) {
	for (const e of policy.entries) {
		const i = items.findIndex((it) => it.key === e.source), it = items[i];
		if (!it || it.id !== e.id || it.node.scope !== e.scope || sha256(canonicalJson(rows[i])) !== e.source_sha256) throw new Error("source policy no longer matches its exact exported source");
		if (it.route?.profile !== e.profile) throw new Error("source policy cannot route or change its expected profile");
		const owner = it.node.attrs.source.owner_classification;
		if (owner && e.kind === "archival_reference" && e.profile_review_sha256 !== sha256(canonicalJson(owner))) throw new Error("source policy profile receipt differs from the owner classification");
		const category = it.node.attrs.source.category;
		if ((e.kind === "source_suffix" && !(it.source === "claude" && category === "claude_index")) || (e.kind === "archival_reference" && !(it.source === "codex" && category === "codex_reference_candidate")) || !["source_suffix","archival_reference"].includes(e.kind)) throw new Error("source policy source kind differs");
		const p = importPolicy.parse({ version: 1, kind: e.kind, owner_decision: e.owner_decision, owner_decision_sha256: e.owner_decision_sha256,
			witness: { export_manifest_sha256: policy.manifest, source_key_sha256: sha256(it.key), source_row_sha256: e.source_sha256, profile: e.profile, scope: e.scope },
			source_head: { name: it.node.name, content_hash: it.node.content_hash, revision: it.node.revision }, ...(e.kind === "archival_reference" ? { profile_review_sha256: e.profile_review_sha256 } : {}) });
		// Do not clear reference review while a different source guard is held.
		if (it.review.some((r) => !["reference_candidate","duplicate_content"].includes(r))) continue;
		policyProjection(it, p);
		const normalized = markdownItem(rows[i], []), restored = structuredClone(it.node);
		delete restored.attrs.import_review; delete restored.attrs.source.owner_classification; restored.name=p.source_head.name;restored.content_hash=p.source_head.content_hash;
		if (canonicalJson(restored)!==canonicalJson(normalized.node) || ["texts","revisions","requests","content","supersedes"].some(k=>canonicalJson(it[k])!==canonicalJson(normalized[k]))) throw new Error("source-policy parity differs outside its closed projection");
		if (redactionChanges(it).changed.length || stripPersonal(it.node.kind,it.node.attrs).stripped.length) throw new Error("source policy projection fails existing privacy guards");
		if (p.kind === "archival_reference") it.review = it.review.filter((r) => r !== "reference_candidate");
	}
}

const policySemantic = (p, id) => p ? canonicalJson({ kind:p.kind, owner:p.owner_decision_sha256, id, key:p.witness.source_key_sha256, profile:p.witness.profile, scope:p.witness.scope, name:p.source_head.name }) : null;

/** BothQ scopes that name a profile (research 05). `bot_hq` mixes work and personal, so it and every other scope go to review. */
function routeScope(scope) {
	if (scope === "sequoia" || scope === "sequioa") return { profile: "work", rule: `scope:${scope}` };
	if (scope === "personal" || scope?.startsWith("personal/") || scope === "bettergit") return { profile: "personal", rule: `scope:${scope}` };
	return null;
}

// ---------- normalization ----------

const KIND = { feedback: "rule", user: "preference", reference: "document", procedural: "document" };
const kindOf = (type, isJournal, why) => KIND[type] ?? (isJournal || !why?.trim() ? "journal" : "decision");
// A 16,000-character slice can split a surrogate pair; move such a cut one code unit back.
function chunkText(text) {
	const out = [];
	for (let i = 0; i < text.length;) {
		let end = Math.min(i + CHUNK, text.length);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return undefined; } };
const MAPPED = new Set(["memory_id", "name", "memory_type", "scope", "description", "content", "rule", "why", "how_to_apply", "objective", "status", "_version",
	"content_hash", "_created", "_updated", "_valid_until", "_source_platform", "_updated_source_platform"]);

/**
 * One BothQ record to an import item: the node, its text rows (body chunks and every append as an entry row, earlier entries
 * kept as history), its original revisions and requests byte for byte, and its provenance. Problems become review reasons.
 */
export function bothqItem(r) {
	const p = r.props, review = [];
	const adopted = nonEmpty(p.memory_id);
	const id = adopted ? p.memory_id : r.legacy_id;
	const type = r.bothq_type;
	if (!id) review.push(r.resolved_scope ? "no_identity" : "missing_scope");
	if (!TYPES.has(type)) review.push("unknown_type");
	const content = nonEmpty(p.content) ? p.content : nonEmpty(p.rule) ? p.rule : "";
	const steps = type === "procedural" ? r.steps.map((s) => ({ order: s.props.order, action: s.props.action, success_criteria: s.props.success_criteria })) : [];
	const fields = { name: p.name, memory_type: type, description: p.description ?? "", content, why: p.why ?? "", how_to_apply: p.how_to_apply ?? "", objective: p.objective ?? "" };
	const contentHash = bothqContentHash(fields, steps);
	if (adopted && p.content_hash !== contentHash) review.push("content_hash_mismatch");
	// Replay the history: a full snapshot sets the body, an append adds an entry; entries before the latest body stay as history.
	const revs = [...r.revisions].sort((a, b) => a.revision - b.revision);
	let current = null, bodyRev = null, bodyAt = null, appends = 0;
	const entries = [];
	for (const rv of revs) {
		if (!KNOWN_OPS.has(rv.operation)) { review.push(`unknown_operation:${rv.operation}`); continue; }
		const snap = parse(rv.snapshot_json), delta = parse(rv.delta_json);
		if (snap === undefined || delta === undefined) { review.push("unparsable_revision"); continue; }
		if (rv.operation === "appended") {
			if (!delta || typeof delta.content !== "string") { review.push("append_without_delta"); continue; }
			const used = current ? (delta.separator ?? "\n") : "";
			current = (current ?? "") + used + delta.content;
			entries.push({ revision: rv.revision, seq_no: ++appends, text: delta.content, separator: used, request_id: rv.request_id ?? null, at: iso(rv._created), live: true });
		} else if (BODY_OPS.has(rv.operation) && snap && "content" in snap) {
			current = snap.content ?? "";
			bodyRev = rv.revision;
			bodyAt = iso(rv._created);
			for (const e of entries) e.live = false;
		}
	}
	const body = revs.length ? (bodyRev === null ? "" : (parse(revs.find((x) => x.revision === bodyRev).snapshot_json).content ?? "")) : content;
	if (revs.length && current !== content) review.push("history_mismatch");
	if (adopted && revs.length && revs[revs.length - 1].content_hash !== p.content_hash) review.push("latest_revision_hash_mismatch");
	// valid_from: the latest revision that set the current content (save, update or append). Adoption and legacy dates are provenance only.
	const establishing = [...revs].reverse().find((x) => ["saved", "updated", "appended"].includes(x.operation) && x.content_hash === p.content_hash);
	const validFrom = adopted && establishing ? iso(establishing._created) : null;
	const isJournal = entries.length > 0;
	const status = adopted ? (p.status ?? "active") : p._valid_until ? "retired" : "active";
	const texts = [];
	chunkText(body).forEach((b, chunk) => { if (b) texts.push({ part: "body", revision: bodyRev ?? (p._version ?? 1), seq_no: 0, chunk, body: b, created_at: bodyAt ?? iso(p._created), live: true }); });
	for (const e of entries) {
		chunkText(e.text).forEach((b, chunk) => texts.push({ part: "entry", revision: e.revision, seq_no: e.seq_no, chunk, body: b, separator: chunk === 0 ? e.separator : null,
			request_id: e.request_id, created_at: e.at, live: e.live }));
	}
	const revisions = revs.map((x) => ({ revision: x.revision, op: x.operation, snapshot: x.snapshot_json ?? null, delta: x.delta_json ?? null, request_id: x.request_id ?? null,
		at: iso(x._created), content_hash: x.content_hash ?? null, revision_id: x.revision_id ?? null, source_platform: x._source_platform ?? null, source_platform_version: x._source_platform_version ?? null }));
	if (!revs.length) {
		// A legacy record without history gets one legacy_snapshot revision; its content stays in the body rows.
		revisions.push({ revision: p._version ?? 1, op: "legacy_snapshot", snapshot: canonicalJson({ ...fields, content: undefined, content_chars: content.length, content_hash: contentHash, status, scope: r.resolved_scope, steps }),
			delta: null, request_id: null, at: iso(p._created), content_hash: contentHash, revision_id: null, source_platform: p._source_platform ?? null, source_platform_version: p._source_platform_version ?? null });
	}
	const requests = r.requests.map(({ request_id, operation, request_hash, result, memory_id, _created, _completed, ...extra }) => ({
		request_id, legacy_op: operation, legacy_hash: request_hash, result: result ?? null, memory_id: memory_id ?? null, at: iso(_created), completed_at: iso(_completed),
		...(Object.keys(extra).length ? { extra } : {}) }));
	if (requests.some((q) => q.result === null)) review.push("request_without_result");
	const properties = Object.fromEntries(Object.entries(p).filter(([k]) => !MAPPED.has(k)));
	if (nonEmpty(p.rule) && p.rule !== content) properties.rule = p.rule;
	const supersedes = r.relationships.filter((x) => x.type === "SUPERSEDES" && x.outgoing).map((x) => x.other_memory_id ?? `eid:${x.other_eid}`);
	const node = {
		id, kind: kindOf(type, isJournal, fields.why), memory_type: type, scope: r.resolved_scope, name: p.name, description: fields.description, why: fields.why || null,
		how_to_apply: fields.how_to_apply || null, objective: fields.objective || null, steps: type === "procedural" ? steps : null, status, origin: "import",
		revision: p._version ?? 1, chars: content.length, content_hash: contentHash, valid_from: validFrom, valid_to: iso(p._valid_until),
		created_at: iso(p._created), updated_at: iso(p._updated), source_platform: p._source_platform ?? null, updated_source_platform: p._updated_source_platform ?? null,
		attrs: { ...(validFrom ? {} : { validity: "unknown", first_recorded_at: iso(p._created) }),
			source: { system: "bothq", adopted, element_id: r.eid, labels: r.labels, content_from: nonEmpty(p.content) ? "content" : nonEmpty(p.rule) ? "rule" : "empty",
				fingerprint: r.fingerprint, properties, anchors: r.anchors,
				relationships: r.relationships, raw_steps: r.steps } },
	};
	return { key: `bothq:${r.eid}`, source: "bothq", id, route: routeScope(r.resolved_scope), node, texts, revisions, requests, supersedes, review, content };
}

const FRONT = /^---\n([\s\S]*?)\n---\n/;
function frontmatter(text) {
	const m = FRONT.exec(text);
	if (!m) return {};
	const get = (k) => new RegExp(`^\\s*${k}:\\s*(.+)$`, "m").exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
	return { name: get("name"), description: get("description"), type: get("type") };
}

/** One Markdown file to an import item: byte-exact content in body chunks, provenance with every path, validity unknown. */
export function markdownItem(f, rules) {
	const review = [];
	const text = f.content ?? null;
	if (text === null) review.push("not_utf8");
	const fm = f.system === "claude" && f.category === "claude_topic" && text ? frontmatter(text) : {};
	const type = TYPES.has(fm.type) && fm.type !== "procedural" ? fm.type : "reference";
	const label = f.system === "claude" ? f.project.replace(/^-Users-[^-]+-[^-]+-/, "") : "codex";
	const scope = (f.system === "claude" ? `claude/${label}` : "codex").slice(0, 128);
	const name = collapse(fm.name || `${f.system}/${f.system === "claude" ? `${label}/` : ""}${f.rel}`);
	let route = null;
	if (f.unstable) review.push("unstable_read");
	if (f.system === "claude") {
		const dirs = decodeProjectDirs(f.project);
		if (dirs === null || dirs.length > 1) review.push("ambiguous_project_path");
		else route = routePath(dirs[0] ?? null, rules);
	}
	else if (f.category === "codex_rollout_summary" && text) route = routePath(/^\s*[-*]?\s*cwd\s*:\s*(\S+)/im.exec(text.slice(0, 4000))?.[1] ?? null, rules);
	if (f.category === "codex_reference_candidate") review.push("reference_candidate");
	if (f.category === "codex_other") review.push("unclassified_file");
	const id = uuid5(`markdown:${f.realpath}`);
	const content = text ?? "";
	const contentHash = bothqContentHash({ name, memory_type: type, description: fm.description ?? "", content }, []);
	const at = f.birthtime;
	const node = {
		id, kind: kindOf(type, false, ""), memory_type: type, scope, name, description: fm.description ?? "", why: null, how_to_apply: null, objective: null, steps: null,
		status: "active", origin: "import", revision: 1, chars: content.length, content_hash: contentHash, valid_from: null, valid_to: null, created_at: at, updated_at: f.mtime,
		source_platform: f.system, updated_source_platform: f.system,
		attrs: { validity: "unknown", first_recorded_at: at, source: { system: f.system, category: f.category, paths: f.paths, realpath: f.realpath, sha256: f.sha256, bytes: f.bytes,
			mtime: f.mtime, birthtime: f.birthtime, ...(/index$/.test(f.category) ? { derived_index: true } : {}) } },
	};
	const texts = chunkText(content).filter(Boolean).map((b, chunk) => ({ part: "body", revision: 1, seq_no: 0, chunk, body: b, created_at: at, live: true }));
	const revisions = [{ revision: 1, op: "legacy_snapshot", snapshot: canonicalJson({ path: f.realpath, paths: f.paths, sha256: f.sha256, bytes: f.bytes, name, type, content_hash: contentHash }),
		delta: null, request_id: null, at, content_hash: contentHash, revision_id: null, source_platform: f.system, source_platform_version: null }];
	return { key: `${f.system}:${f.realpath}`, source: f.system, id, route, node, texts, revisions, requests: [], supersedes: [], review, content };
}

// ---------- plan ----------

/** Everything an item would send, its node and provenance included, with its stored JSON strings parsed. */
const outgoing = (it) => ({
	node: it.node, texts: it.texts,
	revisions: it.revisions.map((x) => ({ ...x, snapshot: parse(x.snapshot) ?? x.snapshot, delta: parse(x.delta) ?? x.delta })),
	requests: it.requests.map((x) => ({ ...x, result: parse(x.result) ?? x.result })),
});

/**
 * Where the server's redactor (`redactPayload`: string patterns and values under sensitive keys) would change what an item
 * sends, and the redacted copy. Any change holds the whole item; the copy is only for the owner's private review.
 */
function redactionChanges(it) {
	const sent = outgoing(it), redacted = redactPayload(sent), changed = [];
	const walk = (a, b, at) => {
		if (a === b) return;
		if (a && b && typeof a === "object" && typeof b === "object") { for (const k of Object.keys(a)) walk(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k); return; }
		changed.push(at);
	};
	walk(sent, redacted, "");
	return { changed, derivative: redacted };
}

/** Serialized bytes of one command; every command and every batch must fit one upload request. */
const commandBytes = (c) => utf8(JSON.stringify(c));

/** The export bundle must match its manifest byte for byte before a plan uses or reuses it; a stale or edited bundle is refused. */
export function checkExport(dir, manifest) {
	const problems = [];
	const bytesOf = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
	const records = bytesOf(path.join(dir, "bothq", "records.jsonl"));
	if (manifest.bothq) {
		if (!records || sha256Bytes(records) !== manifest.bothq.records_jsonl_sha256) problems.push("bothq/records.jsonl hash");
		else if (records.toString("utf8").split("\n").filter(Boolean).length !== manifest.bothq.records) problems.push("bothq record count");
		if ("unlinked_jsonl_sha256" in manifest.bothq) {
			const unlinked = bytesOf(path.join(dir, "bothq", "requests-unlinked.jsonl"));
			if ((unlinked ? sha256Bytes(unlinked) : null) !== manifest.bothq.unlinked_jsonl_sha256) problems.push("bothq/requests-unlinked.jsonl hash");
		}
	} else if (records?.length) problems.push("bothq records the manifest does not list");
	const md = manifest.markdown;
	const filesBytes = bytesOf(path.join(dir, "markdown", "files.jsonl"));
	const files = readJsonl(path.join(dir, "markdown", "files.jsonl"));
	if (!md) { if (files.length) problems.push("markdown files the manifest does not list"); }
	else {
		if (md.files_jsonl_sha256 && (filesBytes ? sha256Bytes(filesBytes) : null) !== md.files_jsonl_sha256) problems.push("markdown/files.jsonl hash");
		if (files.length !== md.distinct) problems.push("markdown file count");
		if (sha256(files.map((f) => `${f.realpath}\t${f.sha256}`).join("\n")) !== md.files_sha256) problems.push("markdown file list hash");
		const bad = files.find((f) => {
			const b = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : typeof f.content_base64 === "string" ? Buffer.from(f.content_base64, "base64") : null;
			return b ? sha256Bytes(b) !== f.sha256 || b.length !== f.bytes : !f.unstable;
		});
		if (bad) problems.push("markdown content hash");
	}
	if (problems.length) throw new Error(`the export bundle in ${dir} does not match its manifest (${problems.join(", ")}); export again`);
}

/** Full imported state, including earlier body rows retained by refresh. Older first-copy plans need no new metadata. */
export function planRecords(dir) {
	const manifest = readJson(path.join(dir, "manifest.json"), null);
	const file = path.join(dir, "records.jsonl");
	if (manifest?.records_sha256) {
		if (sha256(fs.readFileSync(file, "utf8")) !== manifest.records_sha256) throw new Error("records.jsonl does not match its plan manifest");
		return readJsonl(file);
	}
	if (manifest?.version === POLICY_PLAN_VERSION) throw new Error("v2 refresh requires hashed records.jsonl");
	const commands = readJsonl(path.join(dir, "commands.jsonl"));
	return commands.filter((c) => c.op === "finalize").map((c) => {
		const rows = commands.filter((s) => s.op === "stage" && s.record_id === c.record_id && s.profile === c.profile).map((s) => s.rows);
		const source = c.node.attrs.source, system = source.system;
		const texts = rows.flatMap((r) => r.texts);
		const content = texts.filter((t) => t.live).sort((a, b) => (a.part === "entry") - (b.part === "entry") || a.seq_no - b.seq_no || a.chunk - b.chunk)
			.map((t) => (t.chunk === 0 ? t.separator ?? "" : "") + t.body).join("");
		return { key: system === "bothq" ? `bothq:${source.element_id}` : `${system}:${source.realpath}`, source: system, id: c.record_id,
			route: { profile: c.profile }, node: c.node, texts, revisions: rows.flatMap((r) => r.revisions), requests: rows.flatMap((r) => r.requests),
			supersedes: [], content, record_sha256: c.record_sha256, refresh_no: 0,
			linked: commands.filter((l) => l.op === "link" && l.src === c.record_id && l.profile === c.profile).map((l) => l.dst) };
	});
}

function completedBase(exportDir, rehearsal) {
	const manifest = readJson(path.join(exportDir, "manifest.json"), null);
	if (!manifest) throw new Error("no base export manifest");
	checkExport(exportDir, manifest);
	const dir = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan"), check = dryRun({ exportDir, rehearsal });
	const states = fs.readdirSync(dir).filter((f) => /^upload-.+\.json$/.test(f)).map((f) => readJson(path.join(dir, f), null));
	const complete = states.filter((s) => s && !s.stopped && s.commands_sha256 === check.commands_sha256 && s.batches_sha256 === check.batches_sha256
		&& s.done?.length === check.batches && Array.from({ length: check.batches }, (_, i) => i + 1).every((b) => s.done.includes(b)));
	if (complete.length !== 1) throw new Error("finish the base upload to exactly one server before planning a refresh");
	return { records: planRecords(dir), commands_sha256: check.commands_sha256, server: complete[0].server };
}

function itemCommands(it, base = null) {
	const refresh = base ? { no: base.refresh_no + 1, base_record_sha256: base.record_sha256, base_revision: base.node.revision,
		base_content_hash: base.node.content_hash, ...(it.body_revision === undefined ? {} : { body_revision: it.body_revision }) } : null;
	let parts = pack([...it.texts.map((t) => ["texts", t]), ...it.revisions.map((r) => ["revisions", r]), ...it.requests.map((q) => ["requests", q])]);
	if (!parts.length) parts = [{ rows: { texts: [], revisions: [], requests: [] }, cost: { ...PART_OVERHEAD } }];
	const profile = it.route.profile;
	const policy = { ...(it.node.attrs.import_review ? { policy_version: 1 } : {}), ...(it.node.attrs.source?.owner_classification ? { classification_version: 1 } : {}) };
	const recordSha = sha256(canonicalJson({ profile, node: it.node, ...(refresh ? { base_record_sha256: refresh.base_record_sha256, refresh: refresh.no } : {}), parts: parts.map((p) => p.rows) }));
	const stages = parts.map((p, i) => {
		const body = { ...policy, op: "stage", record_id: it.id, record_sha256: recordSha, profile, part: i + 1, parts: parts.length, rows: p.rows, cost: p.cost,
			...(refresh ? { refresh: { no: refresh.no, base_record_sha256: refresh.base_record_sha256 } } : {}) };
		return { ...body, part_id: `${it.id}${refresh ? `#r${refresh.no}` : ""}:${recordSha.slice(0, 16)}:${i + 1}`, sha256: sha256(canonicalJson(body)) };
	});
	const fin = { ...policy, op: "finalize", record_id: it.id, record_sha256: recordSha, profile, node: it.node, parts: stages.map((s) => ({ part_id: s.part_id, sha256: s.sha256 })),
		request_ids: it.requests.map((q) => q.request_id), ...(refresh ? { refresh } : {}) };
	const own = [...stages, { ...fin, sha256: sha256(canonicalJson(fin)) }];
	const flips = base?.texts.filter((t) => t.live && it.body_revision !== undefined) ?? [];
	const pub = base ? refreshPublishCost(it.node, it, flips) : publishCost(it.node);
	if (own.some((c) => commandBytes(c) + ENVELOPE > BATCH.bytes) || pub.rows > BUDGET.rows || pub.bytes > BUDGET.bytes) throw Object.assign(new Error("publication exceeds the transaction budget"), { code: base ? "oversize_refresh" : "oversize_command" });
	return { commands: own, record_sha256: recordSha, refresh_no: refresh?.no ?? 0 };
}

/** Advance only to a source revision's actual state. Text and request histories stay cumulative for the next refresh. */
function advancePrefix(base, fresh, revision) {
	const it = structuredClone(base);
	it.node.attrs = structuredClone(fresh.node.attrs);
	it.revisions.push(revision);
	const snap = parse(revision.snapshot), delta = parse(revision.delta);
	const at = revision.at;
	for (const k of ["name", "description", "why", "how_to_apply", "objective", "steps", "status"]) if (snap && k in snap) it.node[k] = snap[k];
	if (BODY_OPS.has(revision.op)) {
		it.content = snap.content;
		for (const t of it.texts) t.live = false;
		it.texts.push(...chunkText(it.content).filter(Boolean).map((body, chunk) => ({ part: "body", revision: revision.revision, seq_no: 0, chunk, body, created_at: at, live: true })));
	} else if (revision.op === "appended") {
		const seq = Math.max(0, ...it.texts.filter((t) => t.part === "entry").map((t) => t.seq_no)) + 1;
		const separator = it.content ? delta.separator ?? "\n" : "";
		it.content += separator + delta.content;
		it.texts.push(...chunkText(delta.content).map((body, chunk) => ({ part: "entry", revision: revision.revision, seq_no: seq, chunk, body, separator: chunk === 0 ? separator : null,
			request_id: revision.request_id, created_at: at, live: true })));
	}
	if (["retired", "superseded"].includes(revision.op)) it.node.status = revision.op;
	it.node.kind = kindOf(it.node.memory_type, it.texts.some((t) => t.part === "entry"), it.node.why);
	Object.assign(it.node, { revision: revision.revision, chars: it.content.length, content_hash: revision.content_hash, updated_at: at, updated_source_platform: revision.source_platform });
	if (["saved", "updated", "appended"].includes(revision.op)) it.node.valid_from = at;
	if (it.node.status !== "active") it.node.valid_to = snap?._valid_until ?? at;
	return it;
}

function deltaItem(base, full, adoption = false) {
	const texts = full.texts.filter((t) => t.revision > base.node.revision);
	// The body is replaced by the latest new revision that sets it, as bothqItem reads history, even when the new content is
	// empty and leaves no body row; a Markdown change is a new legacy_snapshot.
	const sets = full.revisions.filter((r) => r.revision > base.node.revision && (r.op === "legacy_snapshot" || (BODY_OPS.has(r.op) && "content" in (parse(r.snapshot) ?? {}))));
	return { ...full, texts, revisions: full.revisions.filter((r) => r.revision > base.node.revision || (adoption && r.revision === base.node.revision)),
		requests: full.requests.filter((r) => !base.requests.some((q) => q.request_id === r.request_id)),
		...(sets.length ? { body_revision: Math.max(...sets.map((r) => r.revision)) } : {}) };
}

/** BothQ adopting a legacy record: the synthetic snapshot may be replaced, once, by an adoption with identical content. */
const adoptionOf = (base, it) => base.revisions.length === 1 && base.revisions[0].op === "legacy_snapshot" && it.revisions[0]?.op === "legacy_adopted"
	&& base.revisions[0].revision === it.revisions[0].revision && base.node.content_hash === it.revisions[0].content_hash;

function refreshed(it, base) {
	const hostedBase = base, freshPolicy = it.node.attrs.import_review, oldPolicy = base.node.attrs.import_review;
	if (freshPolicy || oldPolicy) {
		if (!freshPolicy || !oldPolicy || policySemantic(freshPolicy,it.id) !== policySemantic(oldPolicy,base.id)) throw Object.assign(new Error("source policy changed or unsupported adoption"), {code:"policy_changed"});
		base = structuredClone(base); delete base.node.attrs.import_review;
		Object.assign(base.node, {name:oldPolicy.source_head.name,content_hash:oldPolicy.source_head.content_hash});
		it = structuredClone(it); delete it.node.attrs.import_review;
		Object.assign(it.node,{name:freshPolicy.source_head.name,content_hash:freshPolicy.source_head.content_hash});
	}
	const same = (a, b) => canonicalJson(a) === canonicalJson(b);
	const hold = (reason) => { throw Object.assign(new Error(reason), { code: reason }); };
	if (it.id !== base.id) hold("history_rewritten");
	if (it.route?.profile !== base.route.profile) hold("route_changed");
	let adoption = false;
	if (it.source === "bothq") {
		adoption = adoptionOf(base, it);
		if (base.revisions.some((r, i) => !(adoption && i === 0) && !same(r, it.revisions[i])) || base.requests.some((r) => !it.requests.some((q) => same(q, r)))) hold("history_rewritten");
	} else {
		if (base.node.attrs.source.sha256 === it.node.attrs.source.sha256) {
			// Path aliases alone change provenance, retaining every earlier body and revision.
			it = { ...base, node: { ...base.node, attrs: it.node.attrs }, route: it.route };
		} else {
			const revision = base.node.revision + 1;
			it = { ...it, node: { ...it.node, revision, created_at: base.node.created_at },
				texts: [...base.texts.map((t) => ({ ...t, live: false })), ...it.texts.map((t) => ({ ...t, revision }))],
				revisions: [...base.revisions, ...it.revisions.map((r) => ({ ...r, revision, at: it.node.updated_at }))] };
		}
	}
	if (freshPolicy) {
		const p = structuredClone(freshPolicy); p.source_head = {name:it.node.name,content_hash:it.node.content_hash,revision:it.node.revision};
		policyProjection(it,p);
	}
	const own = itemCommands(deltaItem(base, it, adoption), hostedBase);
	return { ...own, record: { ...it, ...own, commands: undefined } };
}

function refreshCommands(it, base) {
	try { return refreshed(it, base); }
	catch (e) {
		if (e.code !== "oversize_refresh" || it.source !== "bothq") throw e;
		// Split on revision boundaries only. One body reset that cannot publish whole remains held.
		const commands = [];
		let current = structuredClone(base), prefix = structuredClone(base), pending = null;
		// An allowed adoption goes in the first step, and every later prefix keeps it as history.
		if (adoptionOf(base, it)) prefix.revisions[0] = structuredClone(it.revisions[0]);
		const emit = () => { commands.push(...pending.commands); current = pending.record; prefix = structuredClone(current); pending = null; };
		for (const rev of it.revisions.filter((r) => r.revision > base.node.revision)) {
			let next = advancePrefix(prefix, it, rev);
			next.requests = [...next.requests, ...it.requests.filter((q) => q.request_id === rev.request_id && !next.requests.some((r) => r.request_id === q.request_id))];
			try { pending = refreshed(next, current); prefix = next; }
			catch (error) {
				if (error.code !== "oversize_refresh" || !pending) throw error;
				emit();
				next = advancePrefix(prefix, it, rev);
				next.requests.push(...it.requests.filter((q) => q.request_id === rev.request_id && !next.requests.some((r) => r.request_id === q.request_id)));
				pending = refreshed(next, current); prefix = next;
			}
		}
		// The last step reaches the fresh export's top revision: it is compiled from the fresh record itself, so it carries the
		// export's exact final provenance, requests and node metadata, and no metadata-only refresh follows it.
		if (pending) {
			let last = null;
			try { last = refreshed(it, current); } catch (error) { if (error.code !== "oversize_refresh") throw error; }
			if (last) { commands.push(...last.commands); return { ...last, commands }; }
			emit();
		}
		const same = (a, b) => canonicalJson(a) === canonicalJson(b);
		if (same(current.node, it.node) && same(current.requests, it.requests)) return { ...pending, record: current, commands };
		const final = refreshed(it, current);
		commands.push(...final.commands);
		return { ...final, commands };
	}
}

/**
 * `plan`: normalizes every exported record and file, routes it, holds what needs review, and writes the staged import
 * commands. Deterministic: the same export and rules give byte-identical commands. A part's id and hash depend only on its
 * record's content, so an unchanged record keeps its parts across plans and the server can replay them.
 */
export async function plan({ exportDir, rules = defaultRouting(), force = false, rehearsal = null, refreshFrom = null, routes = null, sourcePolicy = null } = {}) {
	// A rehearsal sends every record that has an identity and no hold to the `test` profile, ignoring routing (section 16).
	if (rehearsal !== null && rehearsal !== "test") throw new Error("a rehearsal goes to the test profile only");
	if (rehearsal !== null && (routes || sourcePolicy)) throw new Error("a rehearsal ignores routing; reviewed routes apply to a routed plan only");
	return withLock(async () => {
		const manifest = readJson(path.join(exportDir, "manifest.json"), null);
		if (!manifest) throw new Error(`no export manifest in ${exportDir}`);
		checkExport(exportDir, manifest);
		if (refreshFrom && path.resolve(refreshFrom) === path.resolve(exportDir)) throw new Error("a refresh needs a fresh export directory");
		const reviewed = routes ? readReviewedRoutes(routes, exportDir) : null;
		const policy = sourcePolicy ? readSourcePolicy(sourcePolicy, exportDir) : null;
		const base = refreshFrom ? completedBase(refreshFrom, rehearsal) : null;
		const version = policy || reviewed?.version === 2 || base?.records.some(r=>r.node.attrs.import_review || r.node.attrs.source?.owner_classification) ? POLICY_PLAN_VERSION : PLAN_VERSION;
		const inputSha = sha256(canonicalJson({ manifest, rules, rehearsal, version, ...(base ? { refresh_base: base.commands_sha256 } : {}),
			...(reviewed ? { reviewed_routes: reviewed.sha256 } : {}), ...(policy ? {source_policy:policy.sha256} : {}) }));
		const out = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan");
		const statePath = path.join(migrationDir(), "state.json");
		const state = readJson(statePath, { exports: [], plans: {} });
		const prior = state.plans[inputSha];
		const last = readJson(path.join(out, "manifest.json"), null);
		// Reviewed routes must be rechecked against current remotes and decoded paths.
		if (!reviewed && !policy && !force && prior && last?.commands_sha256 === prior.commands_sha256 && last.input_sha256 === inputSha) return { status: "unchanged", dir: out, manifest: last };
		if (reviewed || policy) remotes.clear();
		const bothqRows = readJsonl(path.join(exportDir, "bothq", "records.jsonl")), rows = [...bothqRows, ...readJsonl(path.join(exportDir, "markdown", "files.jsonl"))];
		const items = rows.map((r, i) => (i < bothqRows.length ? bothqItem(r) : markdownItem(r, rules)));
		if (reviewed) (reviewed.version === 2 ? applyOwnerWork : applyReviewed)(items, rows, reviewed);
		const review = [], holds = [];
		const previous = new Map(base?.records.map((r) => [r.key, r]) ?? []), records = new Map(previous);
		for (const it of items) {
			if (rehearsal && it.id) it.route = { profile: rehearsal, rule: "rehearsal" };
			if (!it.route && !it.review.includes("missing_scope")) it.review.push(it.source === "bothq" ? "unrouted_scope" : "unrouted_path");
			// The server's personal-field rule: a node it would strip an attribute from is held, never rewritten.
			if (stripPersonal(it.node.kind, it.node.attrs).stripped.length) it.review.push("personal_fields");
			const { changed, derivative } = redactionChanges(it);
			if (changed.length) { it.review.push("needs_redaction"); holds.push({ key: it.key, changed, derivative }); }
		}
		if (policy) applySourcePolicy(items, rows, policy);
		for (const it of items) {
			const old = previous.get(it.key);
			if (old?.node.attrs.import_review && policySemantic(old.node.attrs.import_review,old.id) !== policySemantic(it.node.attrs.import_review,it.id)) it.review.push("policy_changed");
			// Refresh keeps the same owner choice only; a missing, added or changed classification never adopts a hosted copy in place.
			if (old && ownerSemantic(old.node.attrs.source?.owner_classification ?? null) !== ownerSemantic(it.node.attrs.source?.owner_classification ?? null)) it.review.push("classification_changed");
		}
		// Identity: one id per item, and one active (profile, scope, type, name) per profile, as the hosted unique index requires.
		const seen = new Map();
		for (const it of items.filter((x) => x.id)) { const k = `id:${it.id}`; seen.set(k, [...(seen.get(k) ?? []), it]); }
		for (const it of items.filter((x) => x.route && x.node.status === "active" && x.node.name)) {
			let k;
			try { k = `name:${it.route.profile}:${normalizeScope(it.node.scope)}:${it.node.memory_type}:${normalizeName(it.node.name)}`; } catch { it.review.push("invalid_identity"); continue; }
			seen.set(k, [...(seen.get(k) ?? []), it]);
		}
		for (const group of seen.values()) if (group.length > 1) for (const it of group) it.review.push("identity_conflict");
		// Same bytes under different real paths are kept as separate records and listed for the owner, never merged.
		const bySha = new Map();
		for (const it of items.filter((x) => x.source !== "bothq")) { const s = it.node.attrs.source.sha256; bySha.set(s, [...(bySha.get(s) ?? []), it]); }
		for (const group of bySha.values()) if (group.length > 1) for (const it of group) it.review.push("duplicate_content");
		const commands = [];
		const ready = items.filter((it) => it.route && !it.review.some((r) => r !== "duplicate_content"));
		for (const old of previous.values()) {
			const found = items.find((it) => it.key === old.key);
			if (!found) review.push({ key: old.key, id: old.id, reasons: ["source_vanished"], planned: false });
			else if (found.route?.profile !== old.route.profile || found.review.some((r) => r !== "duplicate_content")) found.review.push("route_changed");
		}
		for (const it of ready) {
			if (it.review.some((r) => r !== "duplicate_content")) continue;
			const old = previous.get(it.key);
			try {
				if (!old && [...previous.values()].some((r) => r.id === it.id)) { it.review.push("history_rewritten"); continue; }
				const compiled = old ? refreshCommands(it, old) : itemCommands(it);
				if (!old || canonicalJson(old.node) !== canonicalJson(compiled.record.node) || canonicalJson(old.revisions) !== canonicalJson(compiled.record.revisions) || canonicalJson(old.requests) !== canonicalJson(compiled.record.requests)) {
					commands.push(...compiled.commands);
					records.set(it.key, compiled.record ?? { ...it, ...compiled, commands: undefined });
				}
				it.planned = true;
			} catch (e) {
				if (!["oversize_row", "oversize_command", "oversize_refresh", "history_rewritten", "route_changed", "policy_changed"].includes(e.code)) throw e;
				it.review.push(e.code);
			}
		}
		// A supersession is linked only inside one profile, to a record this plan publishes; the rest go to review.
		const planned = new Map([...records.values()].map((x) => [x.id, x.route.profile]));
		for (const it of ready.filter((x) => x.planned)) {
			// A link the base already made is not sent again; every record carries the links made so far to the next refresh.
			const linked = new Set(previous.get(it.key)?.linked ?? []);
			for (const dst of it.supersedes) {
				if (linked.has(dst)) continue;
				if (planned.get(dst) !== it.route.profile) { review.push({ key: it.key, id: it.id, reasons: ["link_endpoint_unresolved"], link: { rel: "supersedes", dst } }); continue; }
				const link = { op: "link", src: it.id, rel: "supersedes", dst, basis: "identifier", profile: it.route.profile };
				commands.push({ ...link, sha256: sha256(canonicalJson(link)) });
				linked.add(dst);
			}
			records.get(it.key).linked = [...linked];
		}
		for (const it of items.filter((x) => x.review.length || !x.planned)) {
			review.push({ key: it.key, source: it.source, id: it.id ?? null, name: it.node.name ?? null, reasons: [...new Set(it.review)], ...(it.route ? { proposed: it.route } : {}),
				planned: !!it.planned });
		}
		const batches = [];
		let cur = null;
		commands.forEach((c, i) => {
			const b = commandBytes(c) + 1; // and its comma
			if (!cur || cur.commands.length >= BATCH.commands || cur.bytes + b > BATCH.bytes) { cur = { batch: batches.length + 1, commands: [], bytes: ENVELOPE }; batches.push(cur); }
			cur.commands.push(i);
			cur.bytes += b;
		});
		const commandsText = jsonl(commands);
		privateDir(out);
		writePrivate(path.join(out, "commands.jsonl"), commandsText);
		writePrivate(path.join(out, "batches.jsonl"), jsonl(batches));
		// The next refresh's base: every imported record's full state, without this run's review notes.
		const recordsText = jsonl([...records.values()].map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "review" && k !== "planned"))));
		writePrivate(path.join(out, "records.jsonl"), recordsText);
		writePrivate(path.join(out, "review.jsonl"), jsonl(review.sort((a, b) => a.key.localeCompare(b.key))));
		fs.rmSync(path.join(out, "holds"), { recursive: true, force: true });
		for (const h of holds) writePrivate(path.join(out, "holds", `${sha256(h.key).slice(0, 24)}.json`), JSON.stringify(h));
		const count = (pred) => commands.filter(pred).length;
		const byProfile = {};
		for (const c of commands.filter((x) => x.op === "finalize")) byProfile[c.profile] = (byProfile[c.profile] ?? 0) + 1;
		const reasons = {};
		for (const r of review) for (const x of r.reasons) reasons[x] = (reasons[x] ?? 0) + 1;
		const stages = commands.filter((c) => c.op === "stage");
		const planManifest = {
			version, ...(policy ? {source_policy:{version:1,sha256:policy.sha256,entries:policy.entries.length}} : {}), input_sha256: inputSha, export_dir: tilde(exportDir), rules, rehearsal,
			...(reviewed ? { reviewed_routes: { sha256: reviewed.sha256, routes: reviewed.routes.size, ...(reviewed.version === 2 ? { version: 2, effect: "legacy_work_owner",
				owner_decision_sha256: reviewed.owner_decision_sha256, classified: items.filter((x) => x.route?.rule === "legacy_work_owner").length } : {}) } } : {}),
			items: items.length, planned: ready.filter((x) => x.planned).length, review: review.length, holds: holds.length, reasons, records_by_profile: byProfile,
			commands: commands.length, stage: stages.length, finalize: count((c) => c.op === "finalize"), link: count((c) => c.op === "link"), batches: batches.length,
			max_part: { rows: Math.max(0, ...stages.map((s) => s.cost.rows)), bytes: Math.max(0, ...stages.map((s) => s.cost.bytes)), json_bytes: Math.max(0, ...stages.map((s) => utf8(JSON.stringify(s)))) },
			max_batch_bytes: Math.max(0, ...batches.map((b) => b.bytes)), budget: BUDGET, chunk: CHUNK,
			commands_sha256: sha256(commandsText), batches_sha256: sha256(jsonl(batches)),
			records_sha256: sha256(recordsText), ...(base ? { refresh_from: tilde(refreshFrom), refresh_base_sha256: base.commands_sha256, refresh_server: base.server } : {}),
		};
		writePrivate(path.join(out, "manifest.json"), JSON.stringify(planManifest, null, 2));
		state.plans[inputSha] = { dir: tilde(out), commands_sha256: planManifest.commands_sha256 };
		writePrivate(statePath, JSON.stringify(state, null, 2));
		return { status: "planned", dir: out, manifest: planManifest };
	});
}

// ---------- verify ----------

/**
 * `verify`: a fresh read of the same sources, compared with an export: Markdown files by path, bytes and SHA-256, BothQ
 * records by element id, fingerprint and content. Read-only; it reports what changed since the export.
 */
export async function verify({ exportDir, sources = DEFAULT_SOURCES, bothq = true }) {
	const md = enumerateMarkdown(sources);
	const old = new Map(readJsonl(path.join(exportDir, "markdown", "files.jsonl")).map((f) => [f.realpath, f]));
	const now = new Map(md.files.map((f) => [f.realpath, f]));
	const diff = (a, b, same) => ({ changed: [...a.keys()].filter((k) => b.has(k) && !same(a.get(k), b.get(k))).length,
		added: [...b.keys()].filter((k) => !a.has(k)).length, vanished: [...a.keys()].filter((k) => !b.has(k)).length });
	const result = { markdown: diff(old, now, (x, y) => x.sha256 === y.sha256 && x.bytes === y.bytes && canonicalJson(x.paths) === canonicalJson(y.paths)) };
	if (bothq) {
		const tmp = privateDir(path.join(migrationDir(), `verify-${stamp()}-${randomBytes(2).toString("hex")}`));
		try {
			exportBothq({ graphDb: sources.graphDb, python: sources.python, out: tmp });
			const key = (r) => sha256(canonicalJson({ ...r, attempts: undefined }));
			const a = new Map(readJsonl(path.join(exportDir, "bothq", "records.jsonl")).map((r) => [r.eid, key(r)]));
			const b = new Map(readJsonl(path.join(tmp, "records.jsonl")).map((r) => [r.eid, key(r)]));
			result.bothq = diff(a, b, (x, y) => x === y);
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	}
	return result;
}

// ---------- dry run ----------

/** `dry-run`: what an upload of the plan would send, by profile and batch, without any network call. */
export function dryRun({ exportDir, rehearsal = null }) {
	const dir = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan");
	const m = readJson(path.join(dir, "manifest.json"), null);
	if (!m) throw new Error(`no plan in ${dir}; run plan first`);
	const commands = readJsonl(path.join(dir, "commands.jsonl"));
	if (![1,2].includes(m.version)) throw new Error("unsupported plan version");
	if (m.version === 1 && commands.some(c=>c.policy_version !== undefined || c.node?.attrs?.import_review)) throw new Error("source policy cannot downgrade into a v1 plan");
	if (m.version === 1 && commands.some(c=>c.classification_version !== undefined || c.node?.attrs?.source?.owner_classification)) throw new Error("owner classification cannot downgrade into a v1 plan");
	if (m.version === 2) {
		const records = planRecords(dir); const ids = new Set(records.filter(r=>r.node.attrs.import_review).map(r=>r.id)), owned = new Set(records.filter(r=>r.node.attrs.source?.owner_classification).map(r=>r.id));
		for(const c of commands.filter(c=>c.op==="finalize" && (ids.has(c.record_id) || owned.has(c.record_id)))){const r=records.find(r=>r.id===c.record_id && r.route.profile===c.profile);if(ids.has(c.record_id))importPolicy.parse(c.node.attrs.import_review);if(owned.has(c.record_id))ownerClassification.parse(c.node.attrs.source.owner_classification);if(!r || canonicalJson(c.node)!==canonicalJson(r.node) || c.record_sha256!==r.record_sha256)throw new Error("policy record/finalize digest differs");}
		for (const c of commands) if (c.op !== "link" && (ids.has(c.record_id) ? c.policy_version !== 1 : c.policy_version !== undefined)) throw new Error("policy command version differs");
		for (const c of commands) if (c.op !== "link" && (owned.has(c.record_id) ? c.classification_version !== 1 : c.classification_version !== undefined)) throw new Error("classification command version differs");
	}
	if (sha256(jsonl(commands)) !== m.commands_sha256) throw new Error("commands.jsonl does not match its plan manifest");
	// The batch schedule is part of the plan: its hash must match, and it must send every command once, in order.
	const batchesText = fs.existsSync(path.join(dir, "batches.jsonl")) ? fs.readFileSync(path.join(dir, "batches.jsonl"), "utf8") : null;
	if (!m.batches_sha256 || batchesText === null || sha256(batchesText) !== m.batches_sha256) throw new Error("batches.jsonl is missing or does not match its plan manifest; plan again");
	const scheduled = readJsonl(path.join(dir, "batches.jsonl"));
	const order = scheduled.flatMap((b) => b.commands);
	if (scheduled.some((b, i) => b.batch !== i + 1 || !Array.isArray(b.commands) || !b.commands.length || b.commands.length > BATCH.commands)
		|| order.length !== commands.length || order.some((c, i) => c !== i)) {
		throw new Error("batches.jsonl does not send every command exactly once, in order, in numbered batches of at most 50; plan again");
	}
	const over = commands.filter((c) => c.op === "stage" && (c.cost.rows > BUDGET.rows || c.cost.bytes > BUDGET.bytes)).length;
	const overCommands = commands.filter((c) => commandBytes(c) + ENVELOPE > BATCH.bytes).length;
	const batches = scheduled;
	const overBatches = batches.filter((b) => b.commands.length > BATCH.commands || ENVELOPE + b.commands.reduce((n, i) => n + commandBytes(commands[i]) + 1, 0) > BATCH.bytes).length;
	return { commands: m.commands, stage: m.stage, finalize: m.finalize, link: m.link, batches: m.batches, records_by_profile: m.records_by_profile, review: m.review,
		holds: m.holds, reasons: m.reasons, max_part: m.max_part, over_budget_parts: over, over_budget_commands: overCommands, over_budget_batches: overBatches,
		max_command_bytes: Math.max(0, ...commands.map(commandBytes)), commands_sha256: m.commands_sha256, batches_sha256: m.batches_sha256, network: "none" };
}

// ---------- CLI ----------

const latestExport = () => {
	const s = readJson(path.join(migrationDir(), "state.json"), { exports: [] });
	const last = s.exports.at(-1)?.dir;
	return last ? last.replace(/^~/, os.homedir()) : null;
};

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const [cmd, ...rest] = process.argv.slice(2);
	const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
	const exportDir = opt("export") ?? latestExport();
	const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
	const run = {
		export: async () => { const r = await exportAll({ ...DEFAULT_SOURCES, ...(opt("graph-db") ? { graphDb: opt("graph-db") } : {}), ...(opt("python") ? { python: opt("python") } : {}) }); print(r.manifest); },
		plan: async () => { const r = await plan({ exportDir, force: rest.includes("--force"), rehearsal: opt("rehearsal") ?? null, refreshFrom: opt("refresh-from") ?? null, sourcePolicy: opt("source-policy"), routes: opt("routes") ?? null }); print({ status: r.status, ...r.manifest }); },
		verify: async () => print(await verify({ exportDir })),
		"dry-run": async () => print(dryRun({ exportDir, rehearsal: opt("rehearsal") ?? null })),
	}[cmd];
	if (!run) { process.stderr.write("usage: node local/migrate.mjs export | plan [--export DIR] [--routes FILE] [--source-policy FILE] [--rehearsal test] [--force] | verify [--export DIR] | dry-run [--export DIR] [--rehearsal test]\n"); process.exit(2); }
	run().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
