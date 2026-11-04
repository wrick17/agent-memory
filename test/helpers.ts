import { runInDurableObject } from "cloudflare:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "cloudflare:workers";
import type { Principal } from "../src/account/store";
import type { Outcome } from "../src/domain/types";
import { accountStub, callTool, type ToolContext } from "../src/mcp";

export const OWNER = env.OWNER_USER_ID;

export async function contextFor(principal: Principal = { kind: "owner", userId: OWNER }, overrides: Partial<Env> = {}): Promise<ToolContext> {
	const account = await accountStub(env, OWNER).context(principal);
	if (!account.ok) throw new Error(`context failed: ${account.error.message}`);
	return { env: { ...env, ...overrides } as Env, caller: account.value.caller, account: account.value, platform: "test" };
}

/** Calls a tool and returns the value, or throws with the error code so tests can assert on it. */
export async function call<T = Record<string, unknown>>(c: ToolContext, name: string, args: Record<string, unknown>): Promise<T> {
	const r = await callTool(c, name, args);
	if (!r.ok) throw Object.assign(new Error(`${r.error.code}: ${r.error.message}`), { code: r.error.code, details: r.error.details });
	return r.value as T;
}

export async function outcome(c: ToolContext, name: string, args: Record<string, unknown>): Promise<Outcome<unknown>> {
	return callTool(c, name, args);
}

export async function deviceToken(name: string, scopes: string[], profiles: string[], defaultProfile?: string): Promise<{ id: string; token: string }> {
	await contextFor(); // seeds the account, as the dashboard API does before any admin call
	const r = await accountStub(env, OWNER).admin({ op: "createDevice", name, scopes: scopes as never, profiles, ...(defaultProfile ? { defaultProfile } : {}) });
	if (!r.ok) throw new Error(r.error.message);
	return r.value as { id: string; token: string };
}

export function devicePrincipal(token: string): Principal {
	const [, , id, secret] = token.split("_");
	return { kind: "device", id: id!, secret: secret! };
}

export const journal = (c: ToolContext, name: string, profile = "personal") =>
	call(c, "save_memory", { name, type: "project", kind: "journal", description: "test journal", profile });

/** A fresh account whose profiles are active at new generations, so account checks pass until a test closes one or starts a recovery. */
export async function registered(...names: string[]) {
	const userId = `seam-${crypto.randomUUID().slice(0, 8)}`;
	const refs = (names.length ? names : ["personal"]).map((profile) => ({ userId, profile, generation: crypto.randomUUID().slice(0, 8) }));
	const account = <T,>(f: (sql: SqlStorage) => T) => runInDurableObject(env.ACCOUNT.get(env.ACCOUNT.idFromName(userId)), (_i, s) => f(s.storage.sql));
	await account((sql) => {
		sql.exec("INSERT INTO account_meta (key, value) VALUES ('user_id', ?)", userId);
		for (const r of refs) sql.exec("INSERT INTO profiles (name, object_name, generation, status, created_at, seq) VALUES (?, ?, ?, 'active', ?, 1)",
			r.profile, `${userId}:${r.profile}:${r.generation}`, r.generation, new Date().toISOString());
	});
	const of = (profile: string) => {
		const who = refs.find((r) => r.profile === profile)!;
		return { who, stub: env.PROFILE.get(env.PROFILE.idFromName(`${userId}:${profile}:${who.generation}`)) };
	};
	return { userId, account, of, ...of(refs[0]!.profile) };
}

/**
 * A new private directory in the runtime's temp dir, for local client state a test writes. Under the Workers runtime
 * os.tmpdir() is workerd's in-memory /tmp, so nothing reaches the host disk; under Node it is the caller's TMPDIR.
 * Never a fixed host path.
 */
export function tempDir(prefix: string): string {
	const root = path.resolve(os.tmpdir()), dir = fs.mkdtempSync(path.join(root, prefix));
	if (path.dirname(path.resolve(dir)) !== root) throw new Error(`temp dir ${dir} is outside ${root}`);
	return dir;
}
