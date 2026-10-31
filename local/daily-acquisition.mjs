// Selected-observation preparation/ack extraction. Default owner/open/assigned inventory is NOT implemented; see SELECTION-GAP.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { assertMachineLock, redact } from "./agent-memory.mjs";
import { dailyStorage } from "./daily-refresh.mjs";
import { accountFor, preparePRObservation, ghReader } from "./pr-upload.mjs";
import { JIRA_ACCOUNT, prepareTicketObservation } from "./jira-upload.mjs";

// Exact canonicalJson convention from domain/ids.ts, shared by all agreed hash domains.
import { canonicalJson, inventoryScope, inventoryResolution, inventoryRequest } from "./daily-inventory.mjs";
export { canonicalJson };
const C = canonicalJson, sha = (s) => createHash("sha256").update(s).digest("hex"), H = (v) => sha(C(v));
const HEX = /^[0-9a-f]{64}$/, PROFILE = /^[a-z][a-z0-9-]{0,11}$/, REPO = /^[a-z0-9][\w.-]*\/[\w.-]+$/;
const need = (ok, code = "daily_acquisition_invalid") => { if (!ok) throw new Error(code); };
const closed = (v, fields) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === fields.split(" ").sort().join();
const same = (a, b) => C(a) === C(b);
const parse = (s) => { try { return JSON.parse(s); } catch { throw new Error("daily_acquisition_corrupt"); } };
const validBinding = (b, profile) => closed(b, "profile generation device_id day claim_id") && b.profile === profile && typeof b.generation === "string" && b.generation.length > 0
	&& typeof b.device_id === "string" && b.device_id.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && /^[0-9a-f]{32}$/.test(b.claim_id);
const file = (b, name) => `${b.day}.${b.claim_id}/acq.${name}.json`;

// Server hash inputs are cleaned again after wire clipping, without clipping the normalized text.
const PERSONAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{5}\s\d{5}\b/g;
const clean = (s) => redact(s).replace(PERSONAL, "[REDACTED]");

/** The exact server prArgs/ticketArgs request arguments for these already-normalized, redacted wire observations. */
function normalizedArgs(kind, namespace, w) {
	if (kind === "pr") return { item: "pr", repo: namespace, number: w.number, title: clean(w.title), state: w.state, updated_at: w.updated_at, head: clean(w.head),
		...(w.author ? { author: w.author.toLowerCase() } : {}), reviewers: [...new Set(w.reviewers.map((s) => s.toLowerCase()))].sort(),
		commits: [...new Set(w.commits.map((s) => s.toLowerCase()))].sort(), closes: [...new Set(w.closes.map((s) => s.toLowerCase()))].sort(), unknown: [...new Set(w.unknown)].sort(),
		...(w.review_requested_from_owner !== undefined ? { review_requested_from_owner: w.review_requested_from_owner } : {}) };
	return { item: "ticket", key: w.key, kind: w.kind, type: clean(w.type), title: clean(w.title), updated_at: w.updated_at, ...(w.state ? { state: w.state } : {}),
		...(w.status !== undefined ? { status: clean(w.status) } : {}), ...(w.priority !== undefined ? { priority: clean(w.priority) } : {}), ...(w.due ? { due: w.due } : {}),
		...(w.assignee ? { assignee: w.assignee } : {}), ...(w.reporter ? { reporter: w.reporter } : {}), ...(w.assignee_is_owner !== undefined ? { assignee_is_owner: w.assignee_is_owner } : {}),
		blocked_by: [...new Set(w.blocked_by)].sort(), blocks: [...new Set(w.blocks)].sort(), related: [...new Set(w.related)].sort(), unknown: [...new Set(w.unknown)].sort() };
}

/**
 * Five accepted trusted operations for an explicit selected-observation scope, NOT a production default-inventory provider.
 * sources are bounded raw metadata rows from the existing account-bound readers, plus the exact requested identities.
 * No reader callback, executor, model, credential or source-discovery policy is hidden behind this interface.
 * A caller resolving real default inventory must be separately implemented/reviewed before using this extraction for it.
 */
export function observedAcquisition({ profile, origin, sources, io = fs } = {}) {
	assertMachineLock(); need(typeof profile === "string" && PROFILE.test(profile) && profile !== "me");
	const url = new URL(origin); need(url.protocol === "https:" && origin === url.origin, "daily_acquisition_origin");
	// Snapshot caller-owned input now; a restart with a retained seal never consults newer rows.
	let supplied;
	const disk = dailyStorage(io, origin, profile); let cache = null, acks = [], hydrationError;
	const readOptional = (name) => { try { return disk.read(name); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
	const hydrate = (binding) => {
		const context = readOptional(file(binding, "context"));
		if (context === null) { need(readOptional(file(binding, "started")) === null, "daily_preparation_uncertain"); return false; }
		const ctx = parse(context), sealed = readOptional(file(binding, "seal"));
		need(sealed !== null, "daily_preparation_uncertain");
		need(closed(ctx, "binding origin requiredSources as_of seal_sha256") && same(ctx.binding, binding) && ctx.origin === origin && ctx.seal_sha256 === sha(sealed), "daily_acquisition_binding");
		const record = parse(sealed);
		need(closed(record, "version binding origin requiredSources as_of plan expected") && record.version === 1 && same(record.binding, binding)
			&& same(record.requiredSources, ctx.requiredSources) && record.as_of === ctx.as_of && record.origin === origin, "daily_acquisition_binding");
		need(C(record) === sealed && record.plan.manifest_hash === H({ version: 1, operation: "plan", binding, parts: record.plan.parts })
			&& record.plan.parts.selection_hash === H(record.requiredSources) && record.plan.parts.as_of === record.as_of
			&& Array.isArray(record.plan.frames) && record.plan.frames.length <= 64 && record.expected.length === record.plan.frames.length, "daily_acquisition_corrupt");
		cache = record; acks = [];
		for (let part = 0; part < record.plan.frames.length; part++) {
			const text = readOptional(file(binding, `ack-${part}`)); if (text === null) break;
			const held = parse(text);
			need(closed(held, "version binding part native_receipt_sha256 receipt_hash") && held.version === 1 && same(held.binding, binding) && held.part === part, "daily_ack_corrupt");
			const native = disk.read(`${binding.day}.${binding.claim_id}/part-${part}.receipt.json`), receipt = parse(native);
			need(sha(native) === held.native_receipt_sha256 && receipt.receipt_hash === held.receipt_hash
				&& checkReceipt({ binding, frame: record.plan.frames[part], receipt }), "daily_ack_corrupt");
			acks.push(held.native_receipt_sha256);
		}
		return true;
	};
	const current = disk.load().attempt;
	if (current) { try { hydrate(current.binding); } catch (e) { hydrationError = e; } }
	if (!cache && !hydrationError && sources !== undefined) {
		need(Array.isArray(sources) && sources.length <= 64, "daily_selection_invalid");
		const text = C(sources); need(Buffer.byteLength(text) <= 16000000, "daily_metadata_too_large"); supplied = parse(text);
	}

	function checkReceipt({ binding, frame, receipt } = {}) {
		// Pure: authenticated server proof owns original result/Undo/newer-source authority; local normalized payload/unknowns must match exactly.
		try {
			const p = receipt?.proof, i = p?.part, expected = cache?.expected[i];
			if (!cache || !Number.isInteger(i) || i < 0 || !same(binding, cache.binding) || !expected || !same(frame, cache.plan.frames[i]) || !(closed(receipt, "proof receipt_hash") || (closed(receipt, "status proof receipt_hash") && receipt.status === "acknowledged"))
				|| !closed(p, "version operation binding manifest_hash part part_hash body_sha256 items") || p.version !== 1 || p.operation !== "part" || !same(p.binding, binding)
				|| p.manifest_hash !== cache.plan.manifest_hash || p.part_hash !== cache.plan.parts.frames[i].part_hash || p.body_sha256 !== frame.wire_sha256
				|| receipt.receipt_hash !== H(p) || !Array.isArray(p.items) || p.items.length !== expected.length) return false;
			return p.items.every((item, index) => {
				const want = expected[index];
				return closed(item, "index kind key source_revision item_hash request_id payload_hash original_result_hash original_action disposition unknown") && item.index === index
					&& ["kind", "key", "source_revision", "item_hash", "payload_hash"].every((k) => item[k] === want[k]) && same(item.unknown, want.unknown)
					&& (item.request_id === want.base_request_id || item.request_id === `${want.base_request_id}:${want.payload_hash}`)
					&& HEX.test(item.original_result_hash) && ((item.original_action === "stored" && item.disposition === "stored") || (item.original_action === "stale" && item.disposition === "superseded"));
			});
		} catch { return false; }
	}

	function prepareRefresh({ binding, requiredSources, as_of } = {}) {
		assertMachineLock(); need(validBinding(binding, profile), "daily_acquisition_binding");
		const active = disk.load().attempt;
		need(active && active.phase !== "claim" && same(active.binding, binding) && active.origin === origin && active.as_of === as_of
			&& (active.inventory ? same(inventoryResolution(disk, active).requiredSources, requiredSources) : same(active.requiredSources, requiredSources)), "daily_claim_ack_required");
		if (hydrationError) throw hydrationError;
		if (cache || hydrate(binding)) {
			need(same(cache.binding, binding) && cache.as_of === as_of && same(cache.requiredSources, requiredSources), "daily_acquisition_binding");
			return parse(C(cache.plan));
		}
		need(Array.isArray(supplied), "daily_inventory_unavailable");
		need(Array.isArray(requiredSources) && requiredSources.length <= 64 && supplied.length === requiredSources.length
			&& typeof as_of === "string" && new Date(as_of).toISOString() === as_of, "daily_selection_invalid");
		disk.put(file(binding, "started"), C({ binding, origin, requiredSources, as_of, input_sha256: H(supplied) }));
		const parts = { version: 1, selection_hash: H(requiredSources), as_of, sources: [], frames: [] }, frames = [], expected = [], natural = new Set();
		for (const [index, selected] of supplied.entries()) {
			const source = requiredSources[index];
			need(closed(selected, "source account owner requested rows") && closed(source, "source_id kind namespace selector_hash") && same(selected.source, source)
				&& typeof source.source_id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(source.source_id) && (!index || requiredSources[index - 1].source_id < source.source_id)
				&& HEX.test(source.selector_hash) && typeof source.namespace === "string" && source.namespace.length <= 128, "daily_selection_invalid");
			const pr = source.kind === "pr", cap = pr ? 25 : 20;
			need(pr ? REPO.test(source.namespace) && !/\.git$|\.$/.test(source.namespace) && selected.account === accountFor(source.namespace) && selected.owner === selected.account
				: source.kind === "ticket" && profile === "work" && source.namespace === "jira:work" && selected.account === JIRA_ACCOUNT && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(selected.owner), "daily_reader_binding");
			need(Array.isArray(selected.requested) && selected.requested.length <= 64 * cap && new Set(selected.requested).size === selected.requested.length
				&& selected.requested.every((k) => pr ? Number.isSafeInteger(k) && k > 0 : typeof k === "string" && /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/.test(k))
				&& Array.isArray(selected.rows) && selected.rows.length <= 64 * cap && Buffer.byteLength(C(selected.rows)) <= 16000000, "daily_observations_incomplete");
			const observations = new Map();
			for (const row of selected.rows) {
				const wire = pr ? preparePRObservation(row, source.namespace, selected.owner) : prepareTicketObservation(row, selected.owner);
				need(wire, "daily_observation_invalid"); const key = pr ? wire.number : wire.key;
				need(selected.requested.includes(key) && wire.updated_at <= as_of, "daily_observations_incomplete");
				need(!observations.has(key) || same(observations.get(key), wire), "daily_observation_conflict"); observations.set(key, wire);
			}
			need(observations.size === selected.requested.length, "daily_observations_incomplete");
			const rows = [...observations.values()].sort((a, b) => String(pr ? a.number : a.key) < String(pr ? b.number : b.key) ? -1 : String(pr ? a.number : a.key) > String(pr ? b.number : b.key) ? 1 : 0);
			const enumeration = rows.map((w) => ({ key: pr ? `github:${source.namespace}#${w.number}` : `jira:${w.key}`, source_revision: w.updated_at, item_hash: H(w) }));
			// This is a selected-observation witness, never proof of owner/open/assigned default inventory EOF.
			parts.sources.push({ ...source, enumeration_hash: H({ account: selected.account, owner: selected.owner, requested: selected.requested, observations: enumeration }), observed_items: rows.length });
			let offset = 0;
			while (offset < rows.length) {
				need(frames.length < 64, "daily_frame_limit");
				const part = frames.length; let count = Math.min(cap, rows.length - offset), payload, part_hash, wire_bytes;
				do {
					payload = { profile, as_of, ...(pr ? { repo: { remote: `https://github.com/${source.namespace}` }, prs: rows.slice(offset, offset + count) } : { tickets: rows.slice(offset, offset + count) }) };
					part_hash = H({ version: 1, operation: "part", binding, part, source_id: source.source_id, payload });
					wire_bytes = C({ ...payload, refresh: { day: binding.day, claim_id: binding.claim_id, part, part_hash } });
					if (Buffer.byteLength(wire_bytes) <= 900000) break;
					count--;
				} while (count > 0);
				need(count > 0, "daily_item_too_large");
				const wanted = rows.slice(offset, offset + count).map((w) => {
					const key = pr ? `github:${source.namespace}#${w.number}` : `jira:${w.key}`, base_request_id = `upload:${profile}:${key}:${w.updated_at}`;
					need(!natural.has(base_request_id), "daily_duplicate_item"); natural.add(base_request_id);
					return { kind: source.kind, key, source_revision: w.updated_at, base_request_id, item_hash: H(w),
						payload_hash: H({ operation: `upload_${source.kind}`, arguments: normalizedArgs(source.kind, source.namespace, w) }), unknown: w.unknown };
				});
				frames.push({ wire_bytes, wire_sha256: sha(wire_bytes), items: wanted.map(({ kind, key, source_revision, base_request_id, item_hash }) => ({ kind, key, source_revision, base_request_id, item_hash })) });
				expected.push(wanted); parts.frames.push({ part, source_id: source.source_id, kind: source.kind, item_count: count, part_hash }); offset += count;
			}
		}
		need(Buffer.byteLength(C(parts)) <= 65536, "daily_plan_limit");
		const plan = { parts, manifest_hash: H({ version: 1, operation: "plan", binding, parts }), frames };
		const record = { version: 1, binding, origin, requiredSources, as_of, plan, expected }, text = C(record);
		// All pure preparation finishes before publication. An interrupted publication can replay the exact seal or refuse, never recapture.
		disk.put(file(binding, "context"), C({ binding, origin, requiredSources, as_of, seal_sha256: sha(text) }));
		disk.put(file(binding, "seal"), text); cache = record; acks = [];
		return parse(C(plan));
	}

	function acknowledge({ binding, part, receipt } = {}) {
		assertMachineLock();
		need(cache && same(cache.binding, binding) && Number.isInteger(part) && part >= 0 && part <= acks.length
			&& checkReceipt({ binding, frame: cache.plan.frames[part], receipt }), "daily_ack_invalid");
		const active = disk.load().attempt;
		need(active && same(active.binding, binding) && active.receipts[part] === sha(C(receipt)), "daily_native_receipt_required");
		const native = disk.read(`${binding.day}.${binding.claim_id}/part-${part}.receipt.json`);
		need(native === C(receipt), "daily_native_receipt_required");
		// Reference the existing immutable proof rather than consume another full receipt reserve.
		const held = { version: 1, binding, part, native_receipt_sha256: sha(native), receipt_hash: receipt.receipt_hash };
		disk.put(file(binding, `ack-${part}`), C(held));
		acks[part] = sha(C(receipt)); return true;
	}
	function complete({ binding, parts, receipts } = {}) {
		// Pure and specific to retained selected observations, including their honest per-field unknowns.
		return !!cache && same(binding, cache.binding) && same(parts, cache.plan.parts) && Array.isArray(receipts)
			&& receipts.length === cache.plan.frames.length && acks.length === receipts.length && receipts.every((h, i) => h === acks[i]);
	}
	return { canonicalJson, prepareRefresh, checkReceipt, acknowledge, complete };
}

/** Trusted application dependencies only. No installed caller or Office constructor exists yet. */
export function defaultAcquisition({ profile, origin, server, io = fs, github = {} } = {}) {
	assertMachineLock(); need(typeof profile === "string" && PROFILE.test(profile) && profile !== "me" && server && typeof server.refresh === "function");
	const url = new URL(origin); need(url.protocol === "https:" && url.origin === origin, "daily_acquisition_origin");
	need(github && Object.keys(github).every((k) => ["bin", "env", "exec"].includes(k)), "daily_inventory_invalid");
	const disk = dailyStorage(io, origin, profile); let inner = null, resolution = null;
	const current = disk.load().attempt;
	const optional = (name) => { try { return disk.read(name); } catch (e) { if (e.code !== "ENOENT") throw e; return null; } };
	const hydrate = (a) => {
		resolution = inventoryResolution(disk, a);
		inner = observedAcquisition({ profile, origin, io, sources: resolution.sources });
	};
	if (current?.inventory && optional(`${current.name}/inventory.sources.json`) !== null) hydrate(current);
	// Retained explicit Work seals remain replayable. Fresh Work cannot omit its mandatory unavailable Office reader.
	if (current && !current.inventory && current.plan) inner = observedAcquisition({ profile, origin, io });
	if (profile === "work" && !inner) throw new Error("daily_office_unavailable");
	let started = false;
	async function prepareRefresh({ binding, requiredSources, as_of }) {
		assertMachineLock(); const a = disk.load().attempt;
		need(a && a.inventory && a.requiredSources === null && requiredSources === null && a.phase !== "claim" && same(a.binding, binding) && a.as_of === as_of && a.origin === origin, "daily_claim_ack_required");
		if (inner) return inner.prepareRefresh({ binding, requiredSources: resolution.requiredSources, as_of });
		const prefix = `${a.name}/`, f = (name) => prefix + name;
		need(!started && optional(f("inventory.context.json")) === null, "daily_inventory_preparation_uncertain"); started = true;
		const scope = inventoryScope({ scope: disk.json(f("inventory.scope.json")), scope_hash: a.inventory.scope_sha256 }, { origin, profile });
		need(scope.issued_at === as_of && scope.utc_day === binding.day && scope.device_id === binding.device_id && scope.generation === binding.generation);
		const context = { version: 1, binding, origin, scope_sha256: H(scope), as_of, reader_policy: 1 };
		disk.put(f("inventory.context.json"), C(context));
		const claim_body = disk.read(f("claim.body")), claim_receipt = disk.json(f("claim.receipt.json"));
		const repoIds = new Set();
		const pages = [], principals = new Map(), repos = new Map(), observations = new Map(); let calls = 0, candidates = 0;
		const guard = () => {
			assertMachineLock();
			const active = disk.load().attempt;
			need(active && active.phase === "acquire" && active.plan === null && same(active.binding, binding) && active.origin === origin && active.as_of === as_of
				&& active.inventory?.scope_sha256 === H(scope) && disk.read(f("inventory.scope.json")) === C(scope) && disk.read(f("inventory.context.json")) === C(context)
				&& disk.read(f("claim.body")) === claim_body && disk.read(f("claim.receipt.json")) === C(claim_receipt), "daily_claim_ack_required");
		};
		async function authority() {
			guard();
			const markers = await server.refresh("markers", { profile, refresh_scope: "1" });
			guard();
			need(markers.refresh_context && markers.profile === profile, "daily_inventory_binding");
			const fresh = inventoryScope(markers.refresh_scope, { origin, profile, context: markers.refresh_context });
			need(markers.profile === profile && ["origin", "profile", "generation", "device_id", "policy_version"].every((k) => fresh[k] === scope[k]) && same(fresh.github, scope.github) && fresh.jira === scope.jira, "daily_inventory_binding");
			guard();
		}
		async function read(reader, operation, namespace, after = null, principal = null) {
			assertMachineLock(); need(calls + (operation === "identity" ? 2 : 1) <= 256, "daily_inventory_limit");
			// Re-sync the complete retained chain before each effect, including a failed publication with a new storage reader.
			need(disk.read(f("inventory.context.json")) === C(context));
			for (let i = 0; i < pages.length; i++) { const text = disk.read(f(`inventory.page-${i}.json`)); need(sha(text) === pages[i] && sha(disk.read(f(`inventory.intent-${i}.json`))) === parse(text).intent_sha256); }
			await authority(); guard();
			// Keep space for maximal bounded response copies plus all native part receipts and local delivery records.
			disk.capacity(64 * 10 + 12, 2 * 8000000 + 2 * 64 * 262144 + 65536);
			const ordinal = pages.length, args = inventoryRequest(operation, namespace, after);
			const intent = { version: 1, context_sha256: H(context), ordinal, reader: "github", principal_sha256: principal ? H(principal) : null, operation, args, previous_page_sha256: pages.at(-1) ?? null };
			disk.put(f(`inventory.intent-${ordinal}.json`), C(intent));
			need(disk.read(f(`inventory.intent-${ordinal}.json`)) === C(intent)); calls += operation === "identity" ? 2 : 1;
			const result = await reader.defaultPage({ operation, namespace, after });
			await authority(); guard();
			need(disk.read(f(`inventory.intent-${ordinal}.json`)) === C(intent));
			const record = { version: 1, context_sha256: H(context), intent_sha256: H(intent), ...result };
			disk.put(f(`inventory.page-${ordinal}.json`), C(record)); pages.push(H(record));
			principals.set(H(result.principal), result.principal);
			return result;
		}
		for (const selector of scope.github) {
			const reader = ghReader(selector.name, { ...github, io, server, inventory: { scope, binding, as_of, selector, claim_body, claim_receipt } });
			const principal = (await read(reader, "identity", reader.account)).principal;
			const names = [];
			if (selector.kind === "owner") {
				let after = null;
				do { const page = await read(reader, "ownerRepos", selector.name, after, principal);
					for (const r of page.page.members) { need(!repos.has(r.name) && !repoIds.has(r.id), "daily_inventory_duplicate"); repoIds.add(r.id); repos.set(r.name, r); names.push(r.name); }
					need(repos.size <= 64, "daily_inventory_limit"); after = page.page.hasNextPage ? page.page.endCursor : null;
				} while (after !== null);
			} else { need(!repos.has(selector.name)); repos.set(selector.name, null); names.push(selector.name); need(repos.size <= 64, "daily_inventory_limit"); }
			for (const namespace of names) {
				let after = null; const rows = [];
				do { const page = await read(reader, "repoOpen", namespace, after, principal); if (repos.get(namespace) === null) { need(!repoIds.has(page.connection.object_id), "daily_inventory_duplicate"); repoIds.add(page.connection.object_id); repos.set(namespace, { id: page.connection.object_id }); } candidates += page.page.members.length; need(candidates <= 10000, "daily_inventory_limit"); rows.push(...page.observations);
					after = page.page.hasNextPage ? page.page.endCursor : null;
				} while (after !== null);
				rows.sort((a, b) => String(a.number) < String(b.number) ? -1 : String(a.number) > String(b.number) ? 1 : 0);
				observations.set(namespace, { kind: "pr", namespace, principal_sha256: H(principal), requested: rows.map((r) => r.number), observations_sha256: H(rows) });
			}
		}
		const eof = { ...context, principals: [...principals.keys()], page_sha256: pages, selected: [...observations.values()].sort((a, b) => a.namespace < b.namespace ? -1 : 1) };
		disk.put(f("inventory.eof.json"), C(eof));
		const declarations = eof.selected.map((s) => ({ source_id: H({ kind: s.kind, namespace: s.namespace }), kind: s.kind, namespace: s.namespace,
			selector_hash: H({ version: 1, policy: "default-open-v1", scope_sha256: H(scope), eof_sha256: H(eof), kind: s.kind, namespace: s.namespace, principal_sha256: s.principal_sha256 }) })).sort((a, b) => a.source_id < b.source_id ? -1 : 1);
		disk.put(f("inventory.sources.json"), C({ version: 1, binding, origin, scope_sha256: H(scope), as_of, eof_sha256: H(eof), requiredSources: declarations }));
		hydrate(a);
		return inner.prepareRefresh({ binding, requiredSources: resolution.requiredSources, as_of });
	}
	return { canonicalJson, prepareRefresh, checkReceipt: (v) => !!inner && inner.checkReceipt(v), acknowledge: (v) => { need(inner); const a = disk.load().attempt; if (a?.inventory) inventoryResolution(disk, a); return inner.acknowledge(v); },
		complete: (v) => !!inner && inner.complete(v) };
}
