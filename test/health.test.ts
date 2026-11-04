// v2 H1 (#11): the deterministic health rules on a fixed clock, and the strict, device-bound status body.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { parseClientStatus, STATUS_MAX_BYTES } from "../src/client-status";
import { sweepRows } from "../src/health";
import { accountStub } from "../src/mcp";
import type { ClientStatusBody, HealthCheck, LeaseFacts, SweepInput } from "../src/viewer/types";
import { contextFor, OWNER } from "./helpers";

const NOW = Date.parse("2026-11-04T12:00:00.000Z"), H = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const facts = (f: Partial<LeaseFacts> = {}): LeaseFacts => ({ last_completed_at: null, last_outcome: null, expired_leases: 0, open_lease_until: null, next_due_at: null, ...f });
const report = (b: Partial<ClientStatusBody> = {}): ClientStatusBody => ({ clients: {}, hooks: ["Stop"], inject: false, spool_files: 0, spool_bytes: 0,
	oldest_spool_at: null, last_digest_at: null, refused_since_last: 0, launchd_loaded: false, ...b });
const state = (rows: ReturnType<typeof sweepRows>) => Object.fromEntries(rows.map((r) => [`${r.check_id}:${r.subject}`, r.state]));

describe("v2 H1: health rules on a fixed clock", () => {
	it("flags each rule only past its boundary, leaves v1 and revoked devices unflagged, and repeats exactly", () => {
		const input: SweepInput = {
			now: new Date(NOW).toISOString(),
			profiles: [
				{ profile: "at", facts: facts({ last_completed_at: ago(26 * H) }) },
				{ profile: "past", facts: facts({ last_completed_at: ago(26 * H + 1), expired_leases: 1 }) },
				{ profile: "never", facts: facts() },
			],
			devices: [{ id: "dev_fresh", revoked: false }, { id: "dev_stale", revoked: false }, { id: "dev_v1", revoked: false }, { id: "dev_gone", revoked: true }],
			last_export_at: ago(30 * H),
		};
		const status = new Map([["dev_fresh", report({ last_digest_at: ago(48 * H) })], ["dev_stale", report({ last_digest_at: ago(48 * H + 1) })],
			["dev_gone", report({ last_digest_at: ago(500 * H) })]]);
		const rows = sweepRows(input, status);
		expect(state(rows)).toEqual({
			"batch_overdue:at": "ok", "lease_expired:at": "ok",
			"batch_overdue:never": "warn", "lease_expired:never": "ok",
			"batch_overdue:past": "warn", "lease_expired:past": "warn",
			"capture_stale:dev_fresh": "ok", "capture_stale:dev_stale": "warn",
			"backup_overdue:account": "ok",
		});
		// A v1 device has no status row, and a revoked device's old report is ignored: neither gets a row, passing or not.
		expect(rows.some((r) => r.subject === "dev_v1" || r.subject === "dev_gone")).toBe(false);
		expect(sweepRows(input, status)).toEqual(rows);
		expect(state(sweepRows({ ...input, last_export_at: ago(30 * H + 1) }, status))["backup_overdue:account"]).toBe("warn");
		expect(state(sweepRows({ ...input, last_export_at: null }, status))["backup_overdue:account"]).toBe("warn");
	});
});

describe("v2 H1: backup freshness in the account store", () => {
	it("counts only a successful export of every store, so a later profile-only export leaves an old account backup flagged", async () => {
		await contextFor();
		const admin = (cmd: Parameters<ReturnType<typeof accountStub>["admin"]>[0]) => accountStub(env, OWNER).admin(cmd);
		const backup = async () => {
			const r = await admin({ op: "health_sweep" });
			if (!r.ok) throw new Error(JSON.stringify(r.error));
			return (r.value as HealthCheck[]).find((c) => c.check_id === "backup_overdue");
		};
		const lastAt = async () => {
			const r = await admin({ op: "accountHealth" });
			if (!r.ok) throw new Error(JSON.stringify(r.error));
			return (r.value as { last_export_at: string | null }).last_export_at;
		};
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(NOW - 31 * H);
			expect((await admin({ op: "export" })).ok).toBe(true);
			vi.setSystemTime(NOW);
			expect((await admin({ op: "export", profile: "personal" })).ok).toBe(true);
			expect(await backup()).toMatchObject({ state: "warn", detail: `The last encrypted export was at ${ago(31 * H)}, more than 30 hours ago.` });
			expect(await lastAt()).toBe(ago(31 * H));
			// A keep-all manual export of every store is a full backup like the nightly one.
			expect((await admin({ op: "export", preserve_existing: true })).ok).toBe(true);
			expect(await backup()).toMatchObject({ state: "ok", detail: `The last encrypted export was at ${ago(0)}.` });
			expect(await lastAt()).toBe(ago(0));
		} finally { vi.useRealTimers(); }
	});
});

describe("v2 H1: client status body", () => {
	it("keeps only allowlisted fields, binds the token's device and never echoes a refused value", () => {
		expect(parseClientStatus(report(), "dev_a")).toEqual({ ok: true, value: report() });
		// A matching device field is accepted and dropped; the row is keyed by the token's device.
		expect(parseClientStatus({ ...report(), device: "dev_a" }, "dev_a")).toEqual({ ok: true, value: report() });
		expect(parseClientStatus({ ...report(), device: "dev_b" }, "dev_a")).toMatchObject({ ok: false, error: { code: "validation" } });
		const unknown = parseClientStatus({ ...report(), cwd: "/Users/secret-path" }, "dev_a");
		expect(unknown).toMatchObject({ ok: false, error: { code: "validation" } });
		expect(JSON.stringify(unknown)).not.toContain("secret-path");
		expect(parseClientStatus({ ...report(), hooks: ["Stop", "Stop"] }, "dev_a").ok).toBe(false);
		expect(parseClientStatus({ ...report(), spool_files: -1 }, "dev_a").ok).toBe(false);
		const big = { ...report(), clients: { codex: "1" }, padding: "x".repeat(STATUS_MAX_BYTES) };
		expect(parseClientStatus(big, "dev_a")).toMatchObject({ ok: false, error: { code: "validation", message: expect.stringContaining(`${STATUS_MAX_BYTES} bytes`) } });
	});
});
