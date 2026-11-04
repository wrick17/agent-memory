// Worker-side transfer driver. The account decides once; the source reaches its terminal state last.
import { meGuard } from "./domain/guard";
import { sha256 } from "./domain/ids";
import { Fail, ok, type Caller, type Outcome, type ProfileRef } from "./domain/types";
import { REBIND_MAX, type AccountTransfer, type TransferCommand } from "./account/store";
import { bundleTexts, type Entry, type TransferOut, type TransferStep } from "./profile/store";

export interface TransferPorts {
	account(cmd: TransferCommand): Promise<Outcome<AccountTransfer>>;
	profile(ref: ProfileRef, step: TransferStep): Promise<Outcome<TransferOut>>;
}
/**
 * `expect` and `protect` are set only by maintenance's promote_to_me (section 7): the account begins it only at the source and
 * target generations it was accepted for, and the source fence refuses, and flags, a target the owner has since protected.
 */
/** companyFree is the caller's optional legacy attestation, kept on a landed me preference; it is never required (issue #3). */
export interface TransferInput { id: string; nodeId: string; from: string; to: string; companyFree: boolean; expect?: { from: string; to: string }; protect?: boolean }

/** The stores' own RPC methods; the integrator adds ProfileStore.transfer(who, step) and AccountStore.transfer(cmd). */
export const transferPorts = (env: Env, userId: string): TransferPorts => {
	const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(userId)) as unknown as { transfer(cmd: TransferCommand): Promise<Outcome<AccountTransfer>> };
	return {
		account: (cmd) => account.transfer(cmd),
		profile: (ref, step) => (env.PROFILE.get(env.PROFILE.idFromName(`${ref.userId}:${ref.profile}:${ref.generation}`)) as unknown as
			{ transfer(who: ProfileRef, step: TransferStep): Promise<Outcome<TransferOut>> }).transfer(ref, step),
	};
};
const value = <T>(r: Outcome<T>): T => { if (!r.ok) throw new Fail(r.error); return r.value; };

/** Resume is also used by the source's five-minute alarm, with the persisted company-free attestation. */
export async function driveTransfer(ports: TransferPorts, input: TransferInput, caller?: Caller, abort = false): Promise<Outcome<AccountTransfer>> {
	try {
		let a = value(await ports.account(caller ? { op: "begin", id: input.id, nodeId: input.nodeId, from: input.from, to: input.to, caller, policy: { companyFree: input.companyFree, context: null, protect: input.protect }, ...(input.expect ? { expect: input.expect } : {}) } : { op: "get", id: input.id }));
		if (a.node_id !== input.nodeId || a.from_profile !== input.from || a.to_profile !== input.to) throw Fail.of("idempotency_mismatch", "transfer endpoints changed");
		// The first accepted policy is immutable; retries and alarms never borrow a new attestation or generation.
		if (a.intent) input = { ...input, companyFree: a.intent.companyFree, protect: a.intent.protect };
		const from = { userId: a.userId, profile: a.from_profile, generation: a.from.generation };
		const to = { userId: a.userId, profile: a.to_profile, generation: a.to.generation };
		const step = async (ref: ProfileRef, s: TransferStep) => {
			const out = await ports.profile(ref, s);
			// A closed accepted generation is never redirected to its replacement, including abort cleanup.
			if (!out.ok && out.error.code === "profile_wiped" && s.op === "abort") return { state: "aborted", done: true };
			return value(out);
		};
		const account = async (s: TransferCommand) => (a = value(await ports.account(s)));
		const finishAbort = async () => {
			// Target cleanup completes before the source is writable again. Late land calls see the abort ledger.
			while (!(await step(to, { op: "abort", id: a.id, side: "in", nodeId: a.node_id, from: a.from_profile })).done) { /* bounded RPC steps */ }
			while (!(await step(from, { op: "abort", id: a.id, side: "out", nodeId: a.node_id, peer: a.to_profile })).done) { /* bounded RPC steps */ }
			await account({ op: "settled", id: a.id });
		};
		if (abort) await account({ op: "decide", id: a.id, outcome: "abort" });
		if (a.state === "aborted") { await finishAbort(); return ok(a); }
		const source = await step(from, { op: "status", id: a.id });
		if (source.state === "committed") {
			if (a.state !== "committed") throw Fail.of("moving", "source finished without the account decision; reconcile before reopening");
			await account({ op: "settled", id: a.id });
			return ok(a);
		}
		let packed: TransferOut = source;
		if (a.state === "open") {
			try {
				const fenced = await step(from, { op: "fence", id: a.id, nodeId: a.node_id, peer: a.to_profile, companyFree: input.companyFree, ...(input.protect ? { protect: true } : {}) });
				if (fenced.state === "refused") throw new Fail(fenced.error!);
				do { packed = await step(from, { op: "pack", id: a.id }); } while (!packed.done);
				const hashes: string[] = [];
				// Validate every byte before landing any part. Read again when landing rather than retaining the bundle in RAM.
				for (let n = 1; n <= packed.parts!; n++) {
					const p = await step(from, { op: "part", id: a.id, n });
					if (!p.payload || sha256(p.payload) !== p.sha256) throw Fail.of("validation", "transfer part hash mismatch");
					hashes.push(p.sha256!);
					const entries = JSON.parse(p.payload) as Entry[];
					if (n === 1 && (entries[0]?.[0] !== "nodes" || entries[0][1].id !== a.node_id || entries[0][1].revision !== packed.revision)) throw Fail.of("revision_conflict", "the bundle differs from the fenced revision");
					if (a.to_profile === "me") {
						if (entries.some(([t, r]) => t === "nodes" && r.kind === "person")) throw Fail.of("me_sensitive_term", "me holds no person nodes");
						value(meGuard(bundleTexts(entries)));
					}
				}
				if (sha256(hashes.join("\n")) !== packed.sha256) throw Fail.of("validation", "transfer bundle hash mismatch");
				await step(from, { op: "sent", id: a.id });
				for (let n = 1; n <= packed.parts!; n++) {
					const p = await step(from, { op: "part", id: a.id, n });
					let landing: TransferOut;
					do { landing = await step(to, { op: "land", id: a.id, from: a.from_profile, nodeId: a.node_id, n, of: packed.parts!, payload: p.payload!, sha256: p.sha256!, bundle: packed.sha256!, revision: packed.revision!, companyFree: input.companyFree }); } while (landing.state === "cleaning");
				}
			} catch (e) {
				// An RPC transport failure is retried by the alarm. Only a deterministic refusal requests an abort.
				if (e instanceof Fail && !["busy", "unavailable", "moving"].includes(e.failure.code)) {
					const decided = await ports.account({ op: "decide", id: a.id, outcome: "abort" });
					if (decided.ok) { a = decided.value; await finishAbort(); }
				}
				throw e;
			}
			await account({ op: "decide", id: a.id, outcome: "commit" });
		}
		// Rebinding and target settlement can have finished in a prior attempt. Never replay landing over published writes.
		const landed = await step(to, { op: "status", id: a.id });
		const fixed = await step(from, { op: "status", id: a.id });
		if (!fixed.sha256 || fixed.sha256 !== landed.sha256 || fixed.revision !== landed.revision) throw Fail.of("moving", "transfer identities disagree; keep the source fenced for reconciliation");
		const published = await step(to, { op: "publish", id: a.id });
		if (published.state === "refused") {
			// The target un-landed the record durably, so the commit decision can still turn into an abort.
			a = value(await ports.account({ op: "decide", id: a.id, outcome: "abort", refused: true }));
			await finishAbort();
			throw new Fail(published.error!);
		}
		// The target may already be settled; source parts remain until all request ids have been rebound.
		for (let n = 1; a.state !== "committed" && n <= fixed.parts!; n++) {
			const p = await step(from, { op: "part", id: a.id, n });
			const ids = (JSON.parse(p.payload!) as Entry[]).filter(([t]) => t === "requests").map(([, r]) => String(r.request_id));
			for (let i = 0; i < ids.length; i += REBIND_MAX) await account({ op: "rebind", id: a.id, requestIds: ids.slice(i, i + REBIND_MAX) });
		}
		await account({ op: "done", id: a.id });
		while (!(await step(to, { op: "settle", id: a.id })).done) { /* bounded RPC steps */ }
		while (!(await step(from, { op: "commit", id: a.id })).done) { /* source terminal LAST */ }
		await account({ op: "settled", id: a.id });
		return ok(a);
	} catch (e) {
		if (e instanceof Fail) return { ok: false, error: e.failure };
		throw e;
	}
}

/**
 * The source's alarm resumes an unfinished transfer from the step it reached (section 9, step 7), with the attestation the
 * fence recorded.
 */
export async function resumeTransfer(ports: TransferPorts, id: string): Promise<Outcome<AccountTransfer>> {
	const a = await ports.account({ op: "get", id });
	if (!a.ok) return a;
	if (a.value.intent) {
		const t = a.value;
		return driveTransfer(ports, { id, nodeId: t.node_id, from: t.from_profile, to: t.to_profile,
			companyFree: t.intent!.companyFree, protect: t.intent!.protect });
	}
	const source = await ports.profile({ userId: a.value.userId, profile: a.value.from_profile, generation: a.value.from.generation }, { op: "status", id });
	if (!source.ok) return source;
	return driveTransfer(ports, { id, nodeId: a.value.node_id, from: a.value.from_profile, to: a.value.to_profile, companyFree: source.value.companyFree === true });
}
