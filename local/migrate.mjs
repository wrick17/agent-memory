#!/usr/bin/env node
// Agent Memory import, first slice (docs/import-implementation.md): a read-only export of BothQ and the curated Markdown
// memory, and a deterministic, staged import plan. Nothing here writes to BothQ, to a Markdown file or to the server.
// Every output is private (directories 0700, files 0600); stdout carries counts and hashes only, never memory text.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, collapse, normalizeName, normalizeScope, sha256, uuid5 } from "../src/domain/ids.ts";
import { redactPayload, redactText } from "../src/domain/redact.ts";
import { stripPersonal } from "../src/domain/personal.ts";
import { IMPORT_BUDGET as BUDGET, TEXT_CHUNK as CHUNK, pack, publishCost } from "../src/domain/import-cost.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLAN_VERSION = 1;
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

/**
 * `plan`: normalizes every exported record and file, routes it, holds what needs review, and writes the staged import
 * commands. Deterministic: the same export and rules give byte-identical commands. A part's id and hash depend only on its
 * record's content, so an unchanged record keeps its parts across plans and the server can replay them.
 */
export async function plan({ exportDir, rules = defaultRouting(), force = false, rehearsal = null } = {}) {
	// A rehearsal sends every record that has an identity and no hold to the `test` profile, ignoring routing (section 16).
	if (rehearsal !== null && rehearsal !== "test") throw new Error("a rehearsal goes to the test profile only");
	return withLock(async () => {
		const manifest = readJson(path.join(exportDir, "manifest.json"), null);
		if (!manifest) throw new Error(`no export manifest in ${exportDir}`);
		checkExport(exportDir, manifest);
		const inputSha = sha256(canonicalJson({ manifest, rules, rehearsal, version: PLAN_VERSION }));
		const out = path.join(exportDir, rehearsal ? `plan-rehearsal-${rehearsal}` : "plan");
		const statePath = path.join(migrationDir(), "state.json");
		const state = readJson(statePath, { exports: [], plans: {} });
		const prior = state.plans[inputSha];
		if (!force && prior && readJson(path.join(out, "manifest.json"), null)?.commands_sha256 === prior.commands_sha256) return { status: "unchanged", dir: out, manifest: readJson(path.join(out, "manifest.json"), null) };
		const items = [
			...readJsonl(path.join(exportDir, "bothq", "records.jsonl")).map(bothqItem),
			...readJsonl(path.join(exportDir, "markdown", "files.jsonl")).map((f) => markdownItem(f, rules)),
		];
		const review = [], holds = [];
		for (const it of items) {
			if (rehearsal && it.id) it.route = { profile: rehearsal, rule: "rehearsal" };
			if (!it.route && !it.review.includes("missing_scope")) it.review.push(it.source === "bothq" ? "unrouted_scope" : "unrouted_path");
			// The server's personal-field rule: a node it would strip an attribute from is held, never rewritten.
			if (stripPersonal(it.node.kind, it.node.attrs).stripped.length) it.review.push("personal_fields");
			const { changed, derivative } = redactionChanges(it);
			if (changed.length) { it.review.push("needs_redaction"); holds.push({ key: it.key, changed, derivative }); }
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
		for (const it of ready) {
			let parts;
			try { parts = pack([...it.texts.map((t) => ["texts", t]), ...it.revisions.map((x) => ["revisions", x]), ...it.requests.map((x) => ["requests", x])]); }
			catch (e) { if (e.code !== "oversize_row") throw e; it.review.push("oversize_row"); continue; }
			const profile = it.route.profile;
			const recordSha = sha256(canonicalJson({ profile, node: it.node, parts: parts.map((p) => p.rows) }));
			const staged = parts.map((p, i) => {
				const body = { op: "stage", record_id: it.id, record_sha256: recordSha, profile, part: i + 1, parts: parts.length, rows: p.rows, cost: p.cost };
				return { ...body, part_id: `${it.id}:${recordSha.slice(0, 16)}:${i + 1}`, sha256: sha256(canonicalJson(body)) };
			});
			const fin = { op: "finalize", record_id: it.id, record_sha256: recordSha, profile, node: it.node, parts: staged.map((s) => ({ part_id: s.part_id, sha256: s.sha256 })),
				request_ids: it.requests.map((q) => q.request_id) };
			const own = [...staged, { ...fin, sha256: sha256(canonicalJson(fin)) }];
			// Every command must fit one upload request with its envelope, and its publish transaction the budget; a record that
			// cannot is held, never trimmed.
			const pub = publishCost(it.node);
			if (own.some((c) => commandBytes(c) + ENVELOPE > BATCH.bytes) || pub.rows > BUDGET.rows || pub.bytes > BUDGET.bytes) { it.review.push("oversize_command"); continue; }
			commands.push(...own);
			it.planned = true;
		}
		// A supersession is linked only inside one profile, to a record this plan publishes; the rest go to review.
		const planned = new Map(ready.filter((x) => x.planned).map((x) => [x.id, x.route.profile]));
		for (const it of ready.filter((x) => x.planned)) {
			for (const dst of it.supersedes) {
				if (planned.get(dst) !== it.route.profile) { review.push({ key: it.key, id: it.id, reasons: ["link_endpoint_unresolved"], link: { rel: "supersedes", dst } }); continue; }
				const link = { op: "link", src: it.id, rel: "supersedes", dst, basis: "identifier", profile: it.route.profile };
				commands.push({ ...link, sha256: sha256(canonicalJson(link)) });
			}
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
			version: PLAN_VERSION, input_sha256: inputSha, export_dir: tilde(exportDir), rules, rehearsal,
			items: items.length, planned: ready.filter((x) => x.planned).length, review: review.length, holds: holds.length, reasons, records_by_profile: byProfile,
			commands: commands.length, stage: stages.length, finalize: count((c) => c.op === "finalize"), link: count((c) => c.op === "link"), batches: batches.length,
			max_part: { rows: Math.max(0, ...stages.map((s) => s.cost.rows)), bytes: Math.max(0, ...stages.map((s) => s.cost.bytes)), json_bytes: Math.max(0, ...stages.map((s) => utf8(JSON.stringify(s)))) },
			max_batch_bytes: Math.max(0, ...batches.map((b) => b.bytes)), budget: BUDGET, chunk: CHUNK,
			commands_sha256: sha256(commandsText), batches_sha256: sha256(jsonl(batches)),
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
		plan: async () => { const r = await plan({ exportDir, force: rest.includes("--force"), rehearsal: opt("rehearsal") ?? null }); print({ status: r.status, ...r.manifest }); },
		verify: async () => print(await verify({ exportDir })),
		"dry-run": async () => print(dryRun({ exportDir, rehearsal: opt("rehearsal") ?? null })),
	}[cmd];
	if (!run) { process.stderr.write("usage: node local/migrate.mjs export | plan [--export DIR] [--rehearsal test] [--force] | verify [--export DIR] | dry-run [--export DIR] [--rehearsal test]\n"); process.exit(2); }
	run().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}
