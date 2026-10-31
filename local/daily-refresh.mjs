// PRIVATE daily adapter. No ordinary caller, discovery, model or activation. See the detached caller contract.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { assertMachineLock, home, httpServer, loadConfig, LIMITS } from "./agent-memory.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const id = () => randomBytes(16).toString("hex");
const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const terminal = (s) => ["done", "failed", "abandoned"].includes(s);
const fail = (code) => { throw new Error(code); };
const need = (ok, code = "refresh_corrupt") => { if (!ok) fail(code); };
const keys = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === fields.split(" ").sort().join();
const parse = (text) => { try { return JSON.parse(text); } catch { return fail("refresh_corrupt"); } };
const paths = { claim: "/v1/refresh/claim", plan: "/v1/refresh/plan", part: "/v1/ingest", finish: "/v1/refresh/finish" };
const B = (v) => ({ profile: v.profile, generation: v.generation, device_id: v.device_id, day: v.day, claim_id: v.claim_id });

/** Daily files only. Same-user cooperative namespace; no repair, deletion or scavenging. */
function storage(io, origin, profile) {
	const uid = process.getuid(), root = path.join(home(), "pending", "work-refresh"), dir = path.join(root, sha(JSON.stringify([origin, profile])));
	const check = (p, directory) => {
		const s = io.lstatSync(p);
		need((directory ? s.isDirectory() : s.isFile()) && s.uid === uid && (s.mode & 0o777) === (directory ? 0o700 : 0o600), "refresh_foreign_path");
		return s;
	};
	const syncDir = (p) => { check(p, true); const fd = io.openSync(p, io.constants.O_RDONLY | io.constants.O_NOFOLLOW); try { io.fsyncSync(fd); } finally { io.closeSync(fd); } };
	const exists = (p) => { try { io.lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
	const mkdir = (p) => { if (!exists(p)) { io.mkdirSync(p, { mode: 0o700 }); syncDir(path.dirname(p)); } check(p, true); };
	check(home(), true);
	mkdir(path.dirname(root)); mkdir(root);
	const fresh = !exists(dir);
	if (fresh) { io.mkdirSync(dir, { mode: 0o700 }); syncDir(root); }
	check(dir, true);
	const safe = (name) => { need(typeof name === "string" && /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9a-f]{32}\/)?[A-Za-z0-9.-]+$/.test(name)); const p = path.join(dir, name); check(path.dirname(p), true); return p; };
	const read = (name) => {
		const p = safe(name); check(p, false);
		const fd = io.openSync(p, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
		try { const s = io.fstatSync(fd); need(s.isFile() && s.uid === uid && (s.mode & 0o777) === 0o600); const text = io.readFileSync(fd, "utf8");
			// Re-establish disk authority in a fresh reader, including a prior rename whose directory sync failed.
			io.fsyncSync(fd); syncDir(path.dirname(p)); return text;
		} finally { io.closeSync(fd); }
	};
	const json = (name) => parse(read(name));
	const capacity = (extraFiles = 0, extraBytes = 0) => {
		let files = 0, bytes = 0;
		const scan = (p) => { check(p, true); for (const name of io.readdirSync(p)) {
			const f = path.join(p, name), s = io.lstatSync(f);
			if (s.isDirectory()) scan(f); else { check(f, false); files++; bytes += s.size; }
		} };
		// Count every retained attempt/temp in this daily namespace, across origins and profiles.
		scan(root);
		need(files + extraFiles <= LIMITS.spoolFiles && bytes + extraBytes <= LIMITS.spoolBytes, "refresh_storage_full");
	};
	const poison = () => {
		// A reported publication error is sticky even if rename exposed the candidate pointer. Never auto-clear it.
		try { const p = path.join(dir, `FAILED.${id()}`), fd = io.openSync(p, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
			try { io.writeSync(fd, "publication_failed\n"); io.fsyncSync(fd); } finally { io.closeSync(fd); } syncDir(dir);
		} catch { /* Disk failure may also prevent the fence: fresh readers must resync every authority before effects. */ }
	};
	const put = (name, text, mutable = false) => {
		need(typeof text === "string"); const p = safe(name);
		if (exists(p)) { const old = read(name); if (!mutable) { need(old === text, "refresh_immutable_mismatch"); return; } }
		capacity(2, Buffer.byteLength(text) * 2 + 1024);
		const tmp = `${p}.${id()}.tmp`; let fd;
		try {
			fd = io.openSync(tmp, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
			const buf = Buffer.from(text); let at = 0;
			while (at < buf.length) { const n = io.writeSync(fd, buf, at, buf.length - at); need(n > 0, "refresh_short_write"); at += n; }
			io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
			if (mutable) { if (exists(p)) check(p, false); io.renameSync(tmp, p); }
			else { try { io.linkSync(tmp, p); } catch (e) { if (e.code !== "EEXIST") throw e; need(read(name) === text, "refresh_immutable_mismatch"); }
				// Keep the exclusive full-write scratch as history; rename it without deleting either link.
				io.renameSync(tmp, `${p}.${id()}.scratch`); }
			syncDir(path.dirname(p));
		} catch (e) { if (fd !== undefined) io.closeSync(fd); poison(); throw e; }
	};
	capacity();
	need(!io.readdirSync(dir).some((n) => n.startsWith("FAILED.")), "refresh_publication_failed");
	if (fresh) { put("namespace.json", JSON.stringify({ version: 1, origin, profile, nonce: id() }));
		put("state.json", JSON.stringify({ version: 1, owner: json("namespace.json").nonce, attempt: null, last: null }), true); }
	const owner = json("namespace.json"); need(keys(owner, "version origin profile nonce") && owner.version === 1 && owner.origin === origin && owner.profile === profile && ID.test(owner.nonce), "refresh_namespace");
	return { read, json, put, capacity, attempt: (name) => { need(/^\d{4}-\d{2}-\d{2}\.[0-9a-f]{32}$/.test(name)); mkdir(path.join(dir, name)); },
		load: () => { const s = json("state.json"); need(keys(s, "version owner attempt last") && s.version === 1 && s.owner === owner.nonce); return s; },
		save: (s) => put("state.json", JSON.stringify(s), true) };
}

/**
 * Explicit future caller only, while this CLI instance holds takeLock(). Acquisition supplies the accepted canonicalJson,
 * prepareRefresh (exact claim/cutoff replay), checkReceipt (pure), acknowledge (idempotent) and complete (pure) operations.
 * No actual provider is available or wired. An unavailable provider must throw, never return an empty successful plan.
 */
export async function refreshDaily({ profile, requiredSources, as_of, acquisition, server, config = loadConfig(), io = fs, outcome, reason } = {}) {
	assertMachineLock();
	need(typeof profile === "string" && /^[a-z][a-z0-9-]{0,11}$/.test(profile) && profile !== "me", "refresh_profile");
	const url = new URL(config.server);
	need(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "refresh_origin");
	const origin = url.origin;
	need(acquisition && ["canonicalJson", "prepareRefresh", "checkReceipt", "acknowledge", "complete"].every((k) => typeof acquisition[k] === "function"), "refresh_acquisition_unavailable");
	const C = acquisition.canonicalJson, H = (v) => sha(C(v)), equal = (a, b) => C(a) === C(b);
	need(Array.isArray(requiredSources) && requiredSources.length <= 64 && typeof as_of === "string" && Number.isFinite(Date.parse(as_of)), "refresh_selection");
	if (outcome !== undefined) need(["failed", "abandoned"].includes(outcome) && typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason), "refresh_outcome");
	server ??= httpServer(config);
	const disk = storage(io, origin, profile); let state = disk.load();
	if (state.last) {
		need(keys(state.last, "binding outcome terminal_sha256") && terminal(state.last.outcome) && HEX.test(state.last.terminal_sha256)
			&& state.last.binding.profile === profile && DAY.test(state.last.binding.day) && ID.test(state.last.binding.claim_id), "refresh_corrupt");
		need(sha(disk.read(`${state.last.binding.day}.${state.last.binding.claim_id}/terminal.json`)) === state.last.terminal_sha256, "refresh_corrupt");
	}
	const save = () => { assertMachineLock(); disk.save(state); };
	const readServer = async (op, input) => { assertMachineLock(); return server.refresh(op, input); };
	let a = state.attempt;
	const responseBinding = (claim) => need(claim && equal(B(claim), a.binding), "refresh_binding_drift");
	const result = (status, why) => ({ status, day: a?.binding.day ?? null, claim_id: a?.binding.claim_id ?? null, ...(why ? { reason: why } : {}) });
	const close = (evidence, disposition) => {
		disk.put(`${a.name}/terminal.json`, C(evidence)); state.last = { binding: a.binding, outcome: disposition, terminal_sha256: sha(C(evidence)) };
		state.attempt = null; save(); return result(disposition);
	};
	if (a) {
		need(keys(a, "name binding origin as_of requiredSources phase plan pending receipts delivered") && a.origin === origin && a.binding.profile === profile
			&& DAY.test(a.binding.day) && ID.test(a.binding.claim_id) && a.name === `${a.binding.day}.${a.binding.claim_id}` && equal(a.requiredSources, requiredSources), "refresh_binding_drift");
		need(Array.isArray(a.receipts) && Number.isInteger(a.delivered) && a.delivered >= 0 && a.delivered <= a.receipts.length && a.receipts.length <= 64 && a.receipts.every((h) => HEX.test(h))
			&& ["claim", "acquire", "plan", "parts", "finish", "terminal"].includes(a.phase) && (!a.plan || HEX.test(a.plan)));
		// Exact status precedes every replay. An unknown old claim is never absence or closure.
		let s;
		try { s = await readServer("status", { profile, day: a.binding.day, claim_id: a.binding.claim_id }); }
		catch (e) { if (e.status !== 404 || a.phase !== "claim") return result("pending", "refresh_terminal_unconfirmed"); }
		if (s) {
			need(s.operation === "status" && DAY.test(s.utc_day), "refresh_status"); responseBinding(s.claim);
			if (terminal(s.claim.state)) return close({ operation: "status", utc_day: s.utc_day, claim: { ...B(s.claim), state: s.claim.state } }, s.claim.state);
			need(["pending", "claiming"].includes(s.claim.state), "refresh_status");
		}
	}
	// Exact old terminal is checked before current-generation context, permitting old-generation external closure.
	const m = await readServer("markers", { profile }), ctx = m.refresh_context;
	need(m.profile === profile && ctx && ctx.profile === profile && typeof ctx.generation === "string" && ctx.generation.length > 0
		&& typeof ctx.device_id === "string" && ctx.device_id.length > 0 && DAY.test(ctx.utc_day), "refresh_context_unavailable");
	if (a) need(ctx.generation === a.binding.generation && ctx.device_id === a.binding.device_id, "refresh_binding_drift");
	else {
		if (state.last?.binding.day === ctx.utc_day) return result("skipped", "refresh_day_consumed");
		const binding = { profile, generation: ctx.generation, device_id: ctx.device_id, day: ctx.utc_day, claim_id: id() };
		a = { name: `${binding.day}.${binding.claim_id}`, binding, origin, as_of, requiredSources, phase: "claim", plan: null, pending: null, receipts: [], delivered: 0 };
		disk.attempt(a.name); disk.put(`${a.name}/context.json`, C({ binding, origin, as_of, requiredSources })); state.attempt = a; save();
	}
	const file = (name) => `${a.name}/${name}`;
	need(equal(disk.json(file("context.json")), { binding: a.binding, origin, as_of: a.as_of, requiredSources: a.requiredSources }), "refresh_binding_drift");
	if (a.phase === "finish" && a.pending?.operation === "finish") {
		const retained = parse(disk.read(file("finish.body")));
		if (retained.outcome !== "done") {
			need(outcome === undefined || outcome === retained.outcome, "refresh_outcome_frozen"); outcome = retained.outcome; reason = retained.reason;
		}
	}
	let prepared;
	const verifyPlan = (p) => {
		need(keys(p, "parts manifest_hash frames") && keys(p.parts, "version selection_hash as_of sources frames") && p.parts.version === 1 && p.parts.as_of === a.as_of && p.parts.selection_hash === H(a.requiredSources)
			&& Array.isArray(p.parts.sources) && p.parts.sources.length === a.requiredSources.length && p.parts.sources.length <= 64
			&& Array.isArray(p.parts.frames) && p.parts.frames.length <= 64 && Array.isArray(p.frames) && p.frames.length === p.parts.frames.length
			&& Buffer.byteLength(C(p.parts)) <= 65536 && p.manifest_hash === H({ version: 1, operation: "plan", binding: a.binding, parts: p.parts }), "refresh_plan");
		for (const [i, s] of p.parts.sources.entries()) {
			need(keys(s, "source_id kind namespace selector_hash enumeration_hash observed_items") && /^[A-Za-z0-9._:-]{1,64}$/.test(s.source_id)
				&& (!i || p.parts.sources[i - 1].source_id < s.source_id) && HEX.test(s.enumeration_hash) && HEX.test(s.selector_hash) && typeof s.namespace === "string" && s.namespace.length <= 128
				&& (s.kind === "pr" ? /^[a-z0-9][\w.-]*\/[\w.-]+$/.test(s.namespace) : s.kind === "ticket" && profile === "work")
				&& equal({ source_id: s.source_id, kind: s.kind, namespace: s.namespace, selector_hash: s.selector_hash }, a.requiredSources[i])
				&& Number.isInteger(s.observed_items) && s.observed_items >= 0, "refresh_source");
		}
		let last = -1; const seen = new Set();
		for (const [i, f] of p.frames.entries()) {
			const d = p.parts.frames[i], sourceAt = p.parts.sources.findIndex((s) => s.source_id === d.source_id), s = p.parts.sources[sourceAt];
			need(keys(d, "part source_id kind item_count part_hash") && d.part === i && s && sourceAt >= last && d.kind === s.kind
				&& ["pr", "ticket"].includes(d.kind) && (d.kind !== "ticket" || profile === "work"), "refresh_frame"); last = sourceAt;
			need(keys(f, "wire_bytes wire_sha256 items") && typeof f.wire_bytes === "string" && Buffer.byteLength(f.wire_bytes) <= 900000 && f.wire_sha256 === sha(f.wire_bytes), "refresh_wire");
			const wire = parse(f.wire_bytes), { refresh, ...payload } = wire, items = payload[d.kind === "pr" ? "prs" : "tickets"];
			need(C(wire) === f.wire_bytes && equal(refresh, { day: a.binding.day, claim_id: a.binding.claim_id, part: i, part_hash: d.part_hash })
				&& payload.profile === profile && payload.as_of === a.as_of && keys(payload, d.kind === "pr" ? "profile as_of repo prs" : "profile as_of tickets")
				&& (d.kind !== "pr" || (keys(payload.repo, "remote") && payload.repo.remote === `https://github.com/${s.namespace}`))
				&& Array.isArray(items) && items.length >= 1 && items.length <= (d.kind === "pr" ? 25 : 20) && items.length === d.item_count
				&& d.part_hash === H({ version: 1, operation: "part", binding: a.binding, part: i, source_id: d.source_id, payload })
				&& Array.isArray(f.items) && f.items.length === items.length, "refresh_frame");
			for (const [j, ref] of f.items.entries()) {
				need(keys(ref, "kind key source_revision base_request_id item_hash") && ref.kind === d.kind && ref.item_hash === H(items[j])
					&& typeof ref.key === "string" && ref.key.length <= 512 && typeof ref.source_revision === "string" && Number.isFinite(Date.parse(ref.source_revision))
					&& ref.base_request_id === `upload:${profile}:${ref.key}:${ref.source_revision}` && !seen.has(ref.base_request_id), "refresh_item"); seen.add(ref.base_request_id);
			}
		}
		for (const s of p.parts.sources) need(p.parts.frames.filter((f) => f.source_id === s.source_id).reduce((n, f) => n + f.item_count, 0) === s.observed_items, "refresh_source_count");
		return p;
	};
	if (a.plan) {
		const text = disk.read(file("plan.json")); need(sha(text) === a.plan); prepared = verifyPlan(parse(text));
		for (const [i, f] of prepared.frames.entries()) need(disk.read(file(`part-${i}.body`)) === f.wire_bytes, "refresh_wire");
	}
	if (prepared) need(a.receipts.length <= prepared.frames.length, "refresh_corrupt");
	const controlProof = (op, body, r) => {
		responseBinding(r.claim); const input = parse(body), manifest = op === "claim" ? null : prepared?.manifest_hash ?? null;
		need(r.operation === op && r.profile === profile && r.refresh_receipt && equal(r.refresh_receipt.proof,
			{ version: 1, operation: op, binding: a.binding, request_id: input.request_id, body_sha256: sha(body), manifest_hash: manifest, outcome: op === "finish" ? input.outcome : null })
			&& r.refresh_receipt.receipt_hash === H(r.refresh_receipt.proof), "refresh_control_receipt");
		need(op === "finish" ? r.claim.state === input.outcome : r.claim.state === "pending", "refresh_control_pending");
		return r.refresh_receipt;
	};
	const partProof = (i, r) => {
		const f = prepared.frames[i], d = prepared.parts.frames[i], side = r.refresh, p = side?.proof;
		need(side?.status === "acknowledged" && keys(p, "version operation binding manifest_hash part part_hash body_sha256 items") && p.version === 1 && p.operation === "part"
			&& equal(p.binding, a.binding) && p.manifest_hash === prepared.manifest_hash && p.part === i && p.part_hash === d.part_hash
			&& p.body_sha256 === f.wire_sha256 && side.receipt_hash === H(p) && Array.isArray(p.items) && p.items.length === f.items.length, "refresh_part_receipt");
		for (const [j, item] of p.items.entries()) {
			const ref = f.items[j];
			need(keys(item, "index kind key source_revision item_hash request_id payload_hash original_result_hash original_action disposition unknown") && item.index === j
				&& ["kind", "key", "source_revision", "item_hash"].every((k) => item[k] === ref[k]) && HEX.test(item.payload_hash) && HEX.test(item.original_result_hash)
				&& (item.request_id === ref.base_request_id || item.request_id === `${ref.base_request_id}:${item.payload_hash}`)
				&& ((item.original_action === "stored" && item.disposition === "stored") || (item.original_action === "stale" && item.disposition === "superseded"))
				&& Array.isArray(item.unknown) && item.unknown.every((s) => typeof s === "string" && s.length <= 128)
				&& equal(item.unknown, [...new Set(item.unknown)].sort()), "refresh_item_receipt");
		}
		need(acquisition.checkReceipt({ binding: a.binding, frame: f, receipt: side }) === true, "refresh_acquisition_receipt");
		return { proof: p, receipt_hash: side.receipt_hash };
	};
	if (a.phase !== "claim") controlProof("claim", disk.read(file("claim.body")), { operation: "claim", profile, claim: { ...a.binding, state: "pending" }, refresh_receipt: disk.json(file("claim.receipt.json")) });
	if ((a.phase === "parts" || (["finish", "terminal"].includes(a.phase) && !outcome)) && a.plan) controlProof("plan", disk.read(file("plan.body")), { operation: "plan", profile, claim: { ...a.binding, state: "pending" }, refresh_receipt: disk.json(file("plan.receipt.json")) });
	need(a.phase === "claim" || a.phase === "acquire" || prepared || outcome, "refresh_plan_missing");
	const mutation = async (op, body, index = null) => {
		if (op !== "part") {
			const v = parse(body);
			need(v.profile === profile && v.day === a.binding.day && v.claim_id === a.binding.claim_id && ID.test(v.request_id), "refresh_control_body");
			if (op === "plan") need(equal(v.parts, prepared.parts) && v.manifest_hash === prepared.manifest_hash, "refresh_control_body");
		}
		const intent = { version: 1, binding: a.binding, operation: op, method: "POST", path: paths[op], body_sha256: sha(body), body_file: op === "part" ? `part-${index}.body` : `${op}.body`, part: index };
		const name = op === "part" ? `part-${index}` : op;
		disk.put(file(intent.body_file), body); disk.put(file(`${name}.intent.json`), C(intent));
		if (a.pending) need(equal(a.pending, intent), "refresh_intent_mismatch"); else { a.pending = intent; save(); }
		need(disk.read(file(intent.body_file)) === body && equal(disk.json(file(`${name}.intent.json`)), a.pending));
		// Reserve two complete receipt copies plus state/scratch/failure-fence space before every send.
		disk.capacity(12, 2 * 262144 + 2 * Buffer.byteLength(JSON.stringify(state)) + 8192);
		assertMachineLock(); const r = await server.refresh(op, disk.read(file(intent.body_file)));
		const receipt = op === "part" ? partProof(index, r) : controlProof(op, body, r);
		need(Buffer.byteLength(C(receipt)) <= 262144, "refresh_receipt_size");
		disk.put(file(`${name}.receipt.json`), C(receipt)); a.pending = null;
		if (op === "part") a.receipts.push(sha(C(receipt)));
		a.phase = op === "claim" ? "acquire" : op === "finish" ? "terminal" : "parts"; save();
		return receipt;
	};
	const bodyFor = (op, more = {}) => {
		try { return disk.read(file(`${op}.body`)); } catch (e) { if (e.code !== "ENOENT") throw e; }
		return C({ profile, day: a.binding.day, claim_id: a.binding.claim_id, request_id: id(), ...more });
	};
	if (outcome && a.phase !== "claim") {
		// Explicit terminal choice supersedes an unacknowledged operation, retaining its original immutable intent.
		if (a.pending?.operation !== "finish") { a.pending = null; a.phase = "finish"; save(); }
		const body = bodyFor("finish", { outcome, reason }); need(parse(body).outcome === outcome, "refresh_outcome_frozen");
		await mutation("finish", body); return close(disk.json(file("finish.receipt.json")), outcome);
	}
	if (a.phase === "claim") {
		try { await mutation("claim", bodyFor("claim")); }
		catch (e) {
			// These two authenticated server refusals occur only before reservation. Generic errors never retire an intent.
			if (!["day_mismatch", "prior_refresh_pending"].includes(e.noReservation)) throw e;
			disk.put(file("unreserved.json"), C({ binding: a.binding, body_sha256: a.pending.body_sha256, reason: e.noReservation }));
			state.attempt = null; save(); return result("pending", e.noReservation);
		}
	}
	if (a.phase === "acquire") {
		prepared = verifyPlan(await acquisition.prepareRefresh({ binding: a.binding, requiredSources: a.requiredSources, as_of: a.as_of }));
		const text = C(prepared); disk.put(file("plan.json"), text);
		for (const [i, f] of prepared.frames.entries()) disk.put(file(`part-${i}.body`), f.wire_bytes);
		a.plan = sha(text); a.phase = "plan"; save();
	}
	if (a.phase === "plan") await mutation("plan", bodyFor("plan", { parts: prepared.parts, manifest_hash: prepared.manifest_hash }));
	need(["parts", "finish", "terminal"].includes(a.phase), "refresh_phase");
	// A durable receipt precedes local acknowledgement; a crash redelivers the same receipt without another acquisition.
	for (let i = 0; i < prepared.frames.length; i++) {
		if (i >= a.receipts.length) { need(a.phase === "parts", "refresh_phase"); await mutation("part", prepared.frames[i].wire_bytes, i); }
		const receipt = disk.json(file(`part-${i}.receipt.json`)); need(sha(C(receipt)) === a.receipts[i]);
		partProof(i, { refresh: { status: "acknowledged", ...receipt } });
		if (i >= a.delivered) {
			assertMachineLock(); need(await acquisition.acknowledge({ binding: a.binding, part: i, receipt }) === true, "refresh_acquisition_ack");
			disk.put(file(`part-${i}.delivered.json`), C({ binding: a.binding, part: i, receipt_hash: receipt.receipt_hash })); a.delivered = i + 1; save();
		} else need(equal(disk.json(file(`part-${i}.delivered.json`)), { binding: a.binding, part: i, receipt_hash: receipt.receipt_hash }));
	}
	need(acquisition.complete({ binding: a.binding, parts: prepared.parts, receipts: a.receipts }) === true, "refresh_acquisition_incomplete");
	if (a.phase !== "terminal") await mutation("finish", bodyFor("finish", { outcome: "done" }));
	const finalReceipt = disk.json(file("finish.receipt.json"));
	controlProof("finish", disk.read(file("finish.body")), { operation: "finish", profile, claim: { ...a.binding, state: "done" }, refresh_receipt: finalReceipt });
	return close(finalReceipt, "done");
}
