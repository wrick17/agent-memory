// AccountStore's part of a transfer between profiles (section 9): the intent, the one commit-or-abort decision, re-binding
// the node's request ids and node_index to the target, and done. Each command is one transaction and idempotent.
import { Fail, ok, type Caller, type Outcome } from "../domain/types";
import { mayUse } from "../routing";
import { nextSeq } from "../storage";

/**
 * open: begun, nothing decided. committing: the target may publish; only completion follows. committed: node_index points
 * at the target. aborted: nothing was or will be published.
 */
export type AccountTransferState = "open" | "committing" | "committed" | "aborted";

export type TransferCommand =
	/** expect: the source and target generations a maintenance promotion was accepted for; a replacement never receives it. */
	| { op: "begin"; id: string; nodeId: string; from: string; to: string; caller: Caller; expect?: { from: string; to: string }; policy?: { companyFree: boolean; context: string | null; protect?: boolean } }
	/** refused: the target durably refused to publish (its guard), so an abort after the commit decision is still safe. */
	| { op: "decide"; id: string; outcome: "commit" | "abort"; refused?: boolean }
	| { op: "rebind"; id: string; requestIds: string[] }
	| { op: "done"; id: string }
	| { op: "get"; id: string }
	| { op: "settled"; id: string };

export interface TransferIntent {
	from: string; to: string; companyFree: boolean; context: string | null; protect: boolean;
	caller: Caller;
}

interface Side { profile: string; generation: string; status: string }
export interface AccountTransfer {
	id: string; node_id: string; from_profile: string; to_profile: string; state: AccountTransferState; created_at: string; completed_at: string | null;
	userId: string; from: Side; to: Side; intent?: TransferIntent | null;
}

/** At most this many request ids re-bind in one transaction (row, sequence index: about 2 rows each). */
export const REBIND_MAX = 300;
const LIVE = ["open", "committing"];

const row = (sql: SqlStorage, id: string) => sql.exec<Omit<AccountTransfer, "userId" | "from" | "to" | "intent"> & { intent: string | null }>(
	"SELECT id, node_id, from_profile, to_profile, state, created_at, completed_at, intent FROM transfers WHERE id = ?", id).toArray().map((r) => ({ ...r, intent: r.intent ? JSON.parse(String(r.intent)) as TransferIntent : null }))[0];
const side = (sql: SqlStorage, name: string) => sql.exec<{ profile: string; generation: string; status: string }>(
	"SELECT name AS profile, generation, status FROM profiles WHERE name = ?", name).toArray()[0];

/** Fails with profile_wiped for a profile being wiped or wiped, so no transfer touches it (section 9, wipe step 1). */
function usable(s: Side | undefined, name: string): Side {
	if (!s) throw Fail.of("validation", `no profile named '${name}'`);
	if (s.status === "wiping" || s.status === "wiped") throw Fail.of("profile_wiped", `profile '${name}' is wiped`, { profile: name });
	if (s.status !== "active") throw Fail.of("validation", `profile '${name}' is ${s.status}`);
	return s;
}

function view(sql: SqlStorage, r: NonNullable<ReturnType<typeof row>>): AccountTransfer {
	const userId = sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = 'user_id'").one().value;
	const from = side(sql, r.from_profile)!, to = side(sql, r.to_profile)!;
	return { ...r, userId, from: r.intent ? { ...from, profile: r.from_profile, generation: r.intent.from } : from,
		to: r.intent ? { ...to, profile: r.to_profile, generation: r.intent.to } : to };
}

export function accountTransfer(storage: DurableObjectStorage, cmd: TransferCommand): Outcome<AccountTransfer> {
	const sql = storage.sql;
	try {
		return ok(storage.transactionSync(() => {
			const now = new Date().toISOString();
			// Every row this transaction writes shares one sequence number.
			let stamp: number | undefined;
			const seq = () => (stamp ??= nextSeq(sql, "account_meta"));
			let cur = row(sql, cmd.id);
			// An undecided accepted job uses the same begin authorization on every drive, including alarm/get and commit.
			if (cur?.intent && cur.state === "open" && cmd.op !== "begin") {
				const checked = accountTransfer(storage, { op: "begin", id: cur.id, nodeId: cur.node_id, from: cur.from_profile, to: cur.to_profile,
					caller: cur.intent.caller, expect: { from: cur.intent.from, to: cur.intent.to } });
				if (!checked.ok) throw new Fail(checked.error);
				cur = row(sql, cmd.id)!;
			}
			const nodeId = cmd.op === "begin" ? cmd.nodeId : cur?.node_id;
			if (!cur?.intent && nodeId && sql.exec("SELECT 1 FROM account_meta WHERE key = ?", `wiped:${nodeId}`).toArray().length) throw Fail.of("profile_wiped", "this record was purged by a profile wipe");
			if (cur && !cur.intent && !(cmd.op === "decide" && cmd.outcome === "abort")) {
				usable(side(sql, cur.from_profile), cur.from_profile);
				usable(side(sql, cur.to_profile), cur.to_profile);
			}
			if (cmd.op === "begin") {
				const expected = cur?.intent ? { from: cur.intent.from, to: cur.intent.to } : cmd.expect;
				const stale = expected && (side(sql, cmd.from)?.generation !== expected.from || side(sql, cmd.to)?.generation !== expected.to);
				const closed = [cmd.from, cmd.to].some((p) => side(sql, p)?.status !== "active");
				const wiped = sql.exec("SELECT 1 FROM account_meta WHERE key = ?", `wiped:${cmd.nodeId}`).toArray().length > 0;
				const owner = sql.exec<{ profile: string }>("SELECT profile FROM node_index WHERE node_id = ?", cmd.nodeId).toArray()[0]?.profile;
				// The one maintenance exception (section 7, promote_to_me): a job token may begin a move into me only; every other
				// begin needs write scope. Both profiles must be the caller's either way. A job begin can come from a stored promotion
				// intent, so its device's current grant is read here instead of trusting the caller it carries.
				const caller = cur?.intent?.caller ?? cmd.caller;
				const job = !caller.scopes.includes("write") && caller.scopes.includes("maintenance") && cmd.to === "me";
				const device = job ? sql.exec<{ scopes: string; profiles: string; enabled: number; revoked_at: string | null; expires_at: string | null }>(
					"SELECT scopes, profiles, enabled, revoked_at, expires_at FROM devices WHERE id = ?", caller.deviceId ?? "").toArray()[0] : undefined;
				const granted = !!device && device.enabled === 1 && !device.revoked_at && (device.expires_at === null || Date.parse(device.expires_at) > Date.now())
					&& (JSON.parse(device.scopes) as string[]).includes("maintenance") && [cmd.from, cmd.to].every((p) => (JSON.parse(device.profiles) as string[]).includes(p));
				const allowed = (caller.scopes.includes("write") || (job && granted)) && mayUse(caller, cmd.from) && mayUse(caller, cmd.to);
				if (cur) {
					if (cur.node_id !== cmd.nodeId || cur.from_profile !== cmd.from || cur.to_profile !== cmd.to) throw Fail.of("idempotency_mismatch", `transfer '${cmd.id}' was begun with other arguments`);
					// Undecided job retries require the accepted generations and the current grant; an abort still runs C3 cleanup.
					if (cur.state === "open" && (stale || closed || wiped || (owner && owner !== cmd.from) || (job && !allowed))) sql.exec("UPDATE transfers SET state = 'aborted', completed_at = ?, seq = ? WHERE id = ?", now, seq(), cmd.id);
					else if ((stale || closed || wiped) && cur.state !== "aborted") throw Fail.of("validation", "a profile generation changed after this transfer was decided", { reason: "generation_changed", state: cur.state });
					return view(sql, row(sql, cmd.id)!);
				}
				if (stale) throw Fail.of("validation", "a profile generation this promotion was accepted for was replaced", { reason: "generation_changed" });
				if (cmd.caller.userId !== sql.exec<{ value: string }>("SELECT value FROM account_meta WHERE key = 'user_id'").one().value) throw Fail.of("forbidden", "account identity mismatch");
				if (cmd.from === cmd.to) throw Fail.of("validation", "a transfer needs two different profiles");
				usable(side(sql, cmd.from), cmd.from);
				usable(side(sql, cmd.to), cmd.to);
				if (!allowed) {
					throw Fail.of("forbidden", `this caller may not write both '${cmd.from}' and '${cmd.to}'`);
				}
				if (owner && owner !== cmd.from) throw Fail.of("validation", `record '${cmd.nodeId}' belongs to profile '${owner}'`, { reason: "wrong_profile", profile: owner });
				const busy = sql.exec("SELECT 1 FROM transfers WHERE node_id = ? AND state IN (SELECT value FROM json_each(?))", cmd.nodeId, JSON.stringify(LIVE)).toArray().length;
				if (busy) throw Fail.of("moving", "this record is already being transferred; retry later", { retry_after: 30 });
				const intent: TransferIntent | null = cmd.policy ? {
					from: side(sql, cmd.from)!.generation, to: side(sql, cmd.to)!.generation,
					companyFree: cmd.policy.companyFree === true, context: cmd.policy.context, protect: cmd.policy.protect === true,
					caller: { userId: cmd.caller.userId, kind: cmd.caller.kind, ...(cmd.caller.deviceId ? { deviceId: cmd.caller.deviceId } : {}),
						scopes: cmd.caller.scopes.filter((s) => s === "write" || s === "maintenance"), profiles: [cmd.from, cmd.to] },
				} : null;
				sql.exec("INSERT INTO transfers (id, node_id, from_profile, to_profile, state, created_at, seq, intent, retry_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
					cmd.id, cmd.nodeId, cmd.from, cmd.to, now, seq(), intent ? JSON.stringify(intent) : null, intent ? Date.now() + 300_000 : null);
				return view(sql, row(sql, cmd.id)!);
			}
			if (!cur) throw Fail.of("not_found", `no transfer '${cmd.id}'`);
			const set = (state: AccountTransferState, done: boolean) => {
				sql.exec("UPDATE transfers SET state = ?, completed_at = ?, seq = ? WHERE id = ?", state, done ? now : null, seq(), cmd.id);
				return view(sql, row(sql, cmd.id)!);
			};
			switch (cmd.op) {
				case "settled":
					if (cur.state !== "committed" && cur.state !== "aborted") throw Fail.of("moving", "transfer cleanup is unfinished");
					sql.exec("UPDATE transfers SET retry_at = NULL, seq = ? WHERE id = ? AND retry_at IS NOT NULL", seq(), cmd.id);
					return view(sql, cur);
				case "get":
					return view(sql, cur);
				case "decide":
					// The one arbiter: an abort after the commit decision, or a commit after an abort, is refused, so no two drivers disagree.
					if (cmd.outcome === "abort") {
						if (cur.state === "aborted") return view(sql, cur);
						if (cur.state !== "open" && !(cur.state === "committing" && cmd.refused)) throw Fail.of("validation", "this transfer is already committing", { reason: "committing", state: cur.state });
						return set("aborted", true);
					}
					if (cur.state === "committing" || cur.state === "committed") return view(sql, cur);
					if (cur.state === "aborted") throw Fail.of("validation", "this transfer was aborted", { reason: "aborted", state: cur.state });
					usable(side(sql, cur.from_profile), cur.from_profile);
					usable(side(sql, cur.to_profile), cur.to_profile);
					return set("committing", false);
				case "rebind": {
					if (cur.state !== "committing" && cur.state !== "committed") throw Fail.of("validation", "request ids re-bind only after the commit decision", { reason: "not_committing" });
					if (cmd.requestIds.length > REBIND_MAX) throw Fail.of("validation", `re-bind at most ${REBIND_MAX} request ids per call`);
					// Only bindings still on the source move: a retry routes to the profile that now holds the record and its request rows.
					if (cmd.requestIds.length) sql.exec("UPDATE request_index SET profile = ?, seq = ? WHERE request_id IN (SELECT value FROM json_each(?)) AND profile = ?",
						cur.to_profile, seq(), JSON.stringify(cmd.requestIds), cur.from_profile);
					return view(sql, cur);
				}
				case "done":
					if (cur.state === "committed") return view(sql, cur);
					if (cur.state !== "committing") throw Fail.of("validation", "done needs the commit decision first", { reason: "not_committing", state: cur.state });
					sql.exec("INSERT OR REPLACE INTO node_index (node_id, profile, seq) VALUES (?, ?, ?)", cur.node_id, cur.to_profile, seq());
					// A scheduled completion preserves the same public raw result before any later move can change routing.
					sql.exec("UPDATE account_meta SET value = json_set(value, '$.result', json(?)) WHERE key LIKE 'transfer_request:%' AND json_extract(value, '$.input.id') = ? AND json_extract(value, '$.result') IS NULL",
						JSON.stringify({ ok: true, action: "transfer_started", memory_id: cur.node_id, transfer_id: cur.id, state: "committed", profile: cur.to_profile, routed_by: "explicit" }), cur.id);
					return set("committed", true);
			}
		}));
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		throw e;
	}
}
