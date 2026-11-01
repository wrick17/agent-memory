// Corpus refresh client (section 14, refresh design revision 2), shared by corpus-cli.mjs --refresh and the Workers tests. It reads
// one repo's complete projection from a consistent local source, inspects the server's rows, saves the exact plan before begin, sends
// bounded hash-chained parts and finishes. A rerun resumes the saved plan at the server's cursor; with the plan lost, it takes over
// the active chain of the same repo. Nothing here moves a local day or head marker, and a missing source is never invented.
import { createHash } from "node:crypto";
import { EMAIL, PHONE } from "../src/domain/personal.ts";
import { REDACTED, redactText } from "../src/domain/redact.ts";
import { validateSource } from "./corpus-upload.mjs";

export const PROJECTION = "corpus-projection/1";
export const FAMILIES = ["repos", "commits", "refs", "commit_paths", "contributors"];
const LOCAL = { repos: [], commits: ["sha"], refs: ["refname"], commit_paths: ["sha", "path"], contributors: ["rowid"] };
const DELETE_ORDER = ["commit_paths", "commits", "refs", "contributors", "repos"], PUT_ORDER = ["repos", "commits", "commit_paths", "refs", "contributors"];
// The scan group (src/corpus/families.ts SCANS): every table an unkeyed multiset in one fixed order, read from the server's status.
const local = (t) => LOCAL[t] ?? ["rowid"];
const multiset = (t) => t === "contributors" || !Object.hasOwn(LOCAL, t);
const orders = (tables) => (tables === FAMILIES ? [DELETE_ORDER, PUT_ORDER] : [tables, tables]);
const PERSONAL = new RegExp(`${EMAIL.source}|${PHONE.source}`, "g");
const TRANSIENT = ["busy", "unavailable"];
const ZERO = { rows: 0, sum: "0".repeat(64) }, MOD = 1n << 256n;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const add = (d, h) => ({ rows: d.rows + 1, sum: ((BigInt(`0x${d.sum}`) + BigInt(`0x${h}`)) % MOD).toString(16).padStart(64, "0") });
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The server's formulas (src/corpus/refresh.ts and families.ts rowHash): fixed tuples, so field order cannot change them. */
export const rowHash = (table, schemaSha, values) => sha256(JSON.stringify([table, schemaSha, PROJECTION, values]));
const seedTuple = (profile, generation, h) => [...(h.group ? ["group", h.group] : []), profile, generation, h.version, h.repo, h.intent,
	h.base.kind === "published" ? ["published", h.base.epoch] : ["active", h.base.plan_id, h.base.next_op, h.base.chain],
	[h.source.kind, h.source.id, h.source.scope], h.projection, Object.keys(h.schemas).map((t) => h.schemas[t]), h.observed, h.observed_at,
	Object.keys(h.targets).map((t) => [h.targets[t].rows, h.targets[t].sum]), h.op_count];
export const seedOf = (profile, generation, h) => sha256(JSON.stringify(["corpus-refresh/1:seed", ...seedTuple(profile, generation, h)]));
export const planIdOf = (profile, generation, h) => sha256(JSON.stringify(["corpus-refresh/1:plan", ...seedTuple(profile, generation, h), h.chain]));
/** chains[i] is the chain after i operations; chains[0] is the seed. */
export function chains(seed, ops) {
	const out = [seed];
	for (const op of ops) out.push(sha256(JSON.stringify([out.at(-1), op])));
	return out;
}

/**
 * The delta from the inspected rows ([key, hash, bytes] per table) to the complete target rows, in the server's fixed order: delete
 * groups first, then put groups, keys by UTF-8 bytes. Contributors are a multiset: the smallest rowids of each matched value stay.
 */
export function planOps(fams, base, target, tables = FAMILIES) {
	const dels = [], puts = [];
	for (const t of tables) {
		const cols = fams[t].columns, hash = (v) => rowHash(t, fams[t].schema_sha256, v);
		if (multiset(t)) {
			const have = new Map(), want = new Map();
			for (const [[rowid], h] of base[t]) have.set(h, [...(have.get(h) ?? []), rowid]);
			for (const v of target[t]) want.set(hash(v), [...(want.get(hash(v)) ?? []), v]);
			for (const [h, ids] of have) for (const id of ids.sort((a, b) => a - b).slice((want.get(h) ?? []).length)) dels.push(["d", t, [id], h]);
			for (const [h, vs] of want) for (const v of vs.slice((have.get(h) ?? []).length)) puts.push(["p", t, v, null]);
			continue;
		}
		const keyOf = (v) => JSON.stringify(local(t).map((c) => v[cols.indexOf(c)]));
		const have = new Map(base[t].map(([k, h]) => [JSON.stringify(k), h])), want = new Map(target[t].map((v) => [keyOf(v), v]));
		for (const [k, h] of have) if (!want.has(k)) dels.push(["d", t, JSON.parse(k), h]);
		for (const [k, v] of want) if (have.get(k) !== hash(v)) puts.push(["p", t, v, have.get(k) ?? null]);
	}
	const order = (op) => (multiset(op[1]) && op[0] === "p" ? JSON.stringify(op[2]) : op[0] === "d" ? JSON.stringify(op[2]) : JSON.stringify(local(op[1]).map((c) => op[2][fams[op[1]].columns.indexOf(c)])));
	const sort = (ops, groups) => ops.sort((a, b) => groups.indexOf(a[1]) - groups.indexOf(b[1]) || byBytes(order(a), order(b)));
	const [delOrder, putOrder] = orders(tables);
	return [...sort(dels, delOrder), ...sort(puts, putOrder)];
}

/**
 * Every page of the five tables, one consistent binding throughout. While idle, the page sums must equal each stored partition
 * (drift audit); while a plan applies, physical rows legitimately differ from the published partitions, so there is nothing to compare.
 */
async function inspectRepo(client, pin, repo, tables = FAMILIES) {
	const base = {}, partitions = {};
	let binding = null;
	for (const t of tables) {
		base[t] = [];
		let after = null, sum = ZERO;
		for (;;) {
			const r = await client.refresh({ command: "inspect", ...pin, table: t, repo, after });
			if (r.error) return { error: r.error };
			if (binding && JSON.stringify(r.page.binding) !== JSON.stringify(binding)) return { error: { code: "busy", details: { reason: "inspect_moved" } } };
			binding = r.page.binding;
			partitions[t] = r.page.partition;
			for (const row of r.page.rows) { base[t].push(row); sum = add(sum, row[1]); }
			if (!r.page.next) break;
			after = r.page.next;
		}
		const stored = partitions[t] ?? ZERO;
		if ("epoch" in binding && (stored.rows !== sum.rows || stored.sum !== sum.sum)) return { error: { code: "validation", details: { reason: "partition_drift", table: t } } };
	}
	return { binding, base, partitions };
}

/**
 * source: { schema, columns, repoRows(table, columns, repo) -> arrays in the refresh projection's order } over one consistent cut, or null for remove.
 * client: { status(profile), refresh(body) -> { receipt } | { page } | { error } }. state/save keep the exact plan until published.
 * Returns published with the receipt, or stopped (resumable) / refused with a reason.
 */
export async function refreshCorpus({ source, client, profile, repo, intent = "refresh", observedAt, sourceId, state = {}, save = () => {}, partOps = 5000, partBytes = 900_000, requireNewRepo = false, group = null }) {
	if (!/^[a-z][a-z0-9-]{0,11}$/.test(profile) || profile === "me") return { status: "refused", reason: "invalid_profile" };
	const st = await client.status(profile);
	if (st.error) return { status: TRANSIENT.includes(st.error.code) ? "stopped" : "refused", reason: st.error.details?.reason ?? st.error.code };
	if (state.generation !== undefined && state.generation !== st.generation) return { status: "refused", reason: "generation_changed" };
	const pin = { profile, generation: st.generation };
	// group "scans": the checkout-scan families the server lists in scan_families, in that order; otherwise the five history families.
	const list = group === "scans" ? st.scan_families : st.families;
	if (!list) return { status: "refused", reason: "scans_unsupported" };
	const tables = group === "scans" ? list.map((f) => f.table) : FAMILIES;
	const fams = Object.fromEntries(list.map((f) => [f.table, { ...f, columns: f.columns.filter((c) => c !== "rowid") }]));
	const active = st.refresh;
	if (active && (active.repo !== repo || (active.group ?? null) !== group)) return { status: "stopped", reason: "refresh_active", plan_id: active.plan_id };
	let plan = state.plan;
	if (plan && plan.header.repo !== repo) return { status: "refused", reason: "saved_plan_for_another_repo" };
	if (plan && (plan.header.group ?? null) !== group) return { status: "refused", reason: "saved_plan_for_another_group" };
	if (!plan) {
		if (intent !== "remove") for (const t of tables) {
			const invalid = await validateSource(source, fams[t]);
			if (invalid) return { status: "refused", table: t, reason: invalid };
		}
		// A lost plan for this repo is taken over from the active cursor (C20); otherwise the base is the published epoch.
		const seen = await inspectRepo(client, pin, repo, tables);
		if (seen.error) return { status: TRANSIENT.includes(seen.error.code) ? "stopped" : "refused", reason: seen.error.details?.reason ?? seen.error.code };
		// A checkout cannot supply unknown GitHub metadata for an existing repo.
		if (requireNewRepo && seen.base.repos.length) return { status: "refused", reason: "repo_metadata_required" };
		const target = {};
		for (const t of tables) {
			const fam = list.find((f) => f.table === t);
			const rows = intent === "remove" ? [] : await source.repoRows(t, fams[t].columns, repo, fam.repo);
			// The bulk uploader's rule: non-key text is redacted before hashing, so refreshed rows match the loaded ones byte for byte.
			// A scan row's partition column must stay the plan's repo, so it is never rewritten.
			target[t] = rows.map((r) => r.map((v, i) => (typeof v === "string" && !fam.key.includes(fams[t].columns[i]) && fams[t].columns[i] !== fam.repo ? redactText(v).replace(PERSONAL, REDACTED) : v)));
			if (target[t].some((r) => bytes(r) > partBytes)) return { status: "refused", table: t, reason: "row_too_large" };
		}
		const ops = planOps(fams, seen.base, target, tables);
		const b = seen.binding;
		const header = { ...(group ? { group } : {}), version: "corpus-refresh/1", repo, intent, base: "epoch" in b ? { kind: "published", epoch: b.epoch } : { kind: "active", plan_id: b.plan_id, next_op: b.next_op, chain: b.chain },
			source: { kind: "sqlite-file", id: sourceId, scope: "complete-repo-projection" }, projection: PROJECTION,
			schemas: Object.fromEntries(tables.map((t) => [t, fams[t].schema_sha256])), observed: [...tables], observed_at: observedAt,
			targets: Object.fromEntries(tables.map((t) => [t, target[t].reduce((d, v) => add(d, rowHash(t, fams[t].schema_sha256, v)), ZERO)])), op_count: ops.length, chain: "" };
		header.chain = chains(seedOf(profile, st.generation, header), ops).at(-1);
		plan = { plan_id: planIdOf(profile, st.generation, header), header, ops };
		Object.assign(state, { profile, generation: st.generation, repo, plan, published: null });
		save(state); // the exact plan is durable before begin
	}
	const steps = chains(seedOf(profile, st.generation, plan.header), plan.ops);
	const call = async (body) => { try { return await client.refresh({ ...pin, ...body }); } catch (e) { return { error: { code: "unavailable", details: { reason: String(e?.message ?? e).slice(0, 200) } } }; } };
	const stop = (r) => ({ status: TRANSIENT.includes(r.error.code) ? "stopped" : "refused", reason: r.error.details?.reason ?? r.error.code, details: r.error.details });
	const done = (receipt) => { Object.assign(state, { plan: null, published: receipt }); save(state); return { status: "published", receipt }; };
	const begun = await call({ command: "begin", header: plan.header });
	if (begun.error) return stop(begun);
	if (begun.receipt.plan_id !== plan.plan_id) return { status: "refused", reason: "plan_id_mismatch" };
	if (begun.receipt.status === "published") return done(begun.receipt);
	// The server's cursor is authoritative after any lost acknowledgement; its chain must match this plan's at that point.
	const now = await client.status(profile);
	if (now.error) return stop(now);
	if (!now.refresh) { const fin = await call({ command: "finish", plan_id: plan.plan_id }); return fin.error ? stop(fin) : done(fin.receipt); }
	if (now.refresh.plan_id !== plan.plan_id) return { status: "refused", reason: "superseded", plan_id: now.refresh.plan_id };
	let next = now.refresh.next_op, size = partOps;
	if (now.refresh.chain !== steps[next]) return { status: "refused", reason: "chain_mismatch" };
	while (next < plan.ops.length) {
		const slice = [];
		for (let i = next, n = 0; i < plan.ops.length && slice.length < size; i++) {
			n += bytes(plan.ops[i]) + 1;
			if (slice.length && n > partBytes) break;
			slice.push(plan.ops[i]);
		}
		const r = await call({ command: "part", plan_id: plan.plan_id, start: next, ops: slice });
		if (r.error) {
			const reason = r.error.details?.reason;
			if (r.error.code === "size_budget" && reason === "expanded_bytes" && slice.length > 1) { size = Math.ceil(slice.length / 2); continue; }
			if (r.error.code === "unavailable") {
				// A failed transport may have committed. Never change a stored start's payload before reconciling its cursor.
				let current;
				try { current = await client.status(profile); } catch { return stop(r); }
				if (current.error) return stop(current);
				if (current.generation !== st.generation) return { status: "refused", reason: "generation_changed" };
				if (!current.refresh) { const fin = await call({ command: "finish", plan_id: plan.plan_id }); return fin.error ? stop(fin) : done(fin.receipt); }
				const active = current.refresh;
				if (active.plan_id !== plan.plan_id) return { status: "refused", reason: "superseded", plan_id: active.plan_id };
				if (!Number.isSafeInteger(active.next_op) || active.next_op < next || active.next_op > plan.ops.length || active.chain !== steps[active.next_op]) return { status: "refused", reason: "chain_mismatch" };
				const retryable = /^(HTTP 5\d\d|network: .+)$/.test(reason ?? "");
				if (retryable && active.next_op > next) { next = active.next_op; continue; }
				if (retryable && slice.length > 1) { size = Math.ceil(slice.length / 2); continue; }
			}
			if ((reason === "stale_part" || reason === "out_of_order") && steps[r.error.details.next_op] === r.error.details.chain) { next = r.error.details.next_op; continue; }
			return stop(r);
		}
		if (r.receipt.start !== next || r.receipt.chain !== steps[r.receipt.next_op]) return { status: "refused", reason: "not_acknowledged" };
		next = r.receipt.next_op;
	}
	const fin = await call({ command: "finish", plan_id: plan.plan_id });
	return fin.error ? stop(fin) : done(fin.receipt);
}
