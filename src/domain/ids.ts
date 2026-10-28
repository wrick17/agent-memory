// Ids, names and hashes. Ports of BothQ memory_config.py rules, so identities stay compatible.
import { createHash, randomBytes } from "node:crypto";

/** BothQ's UUID5 namespace (memory_config.py), so legacy stable ids can be recomputed during migration. */
export const ID_NAMESPACE = "71dc20da-6406-5a6d-a888-8c0ae4cda566";

const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// shortcut: toLowerCase() stands in for Python's casefold(); they differ only for a few letters such as ß. Revisit in the migration import.
const fold = (s: string) => s.toLowerCase();

export function collapse(value: string): string {
	return value.split(/\s+/).filter(Boolean).join(" ");
}

export function normalizeName(value: string): string {
	const name = fold(collapse(value));
	if (!name) throw new Error("name must be a non-empty string");
	return name;
}

export function isScope(value: string): boolean {
	return SCOPE_RE.test(value.trim());
}

export function normalizeScope(value: string): string {
	if (!isScope(value)) throw new Error("scope must start with a letter or digit and contain at most 128 letters, digits, dots, underscores, colons, slashes, or hyphens");
	return fold(value.trim());
}

export function uuid5(name: string, namespace = ID_NAMESPACE): string {
	const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
	const bytes = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const h = bytes.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** New memory ids include the user and the creation profile, so they never collide across profiles or with BothQ ids. */
export function newMemoryId(userId: string, profile: string, scope: string, memoryType: string, name: string): string {
	return uuid5(`${userId}:${profile}:${scope}:${memoryType}:${normalizeName(name)}`);
}

/** Canonical JSON as BothQ hashes it: sorted keys, no spaces, non-ASCII kept. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
	}
	return value;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** BothQ request hash: the operation and every argument except request_id, after redaction. */
export function requestHash(operation: string, args: Record<string, unknown>): string {
	const { request_id: _ignored, ...rest } = args;
	return sha256(canonicalJson({ operation, arguments: rest }));
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 64 random bits as 13 lowercase base32 characters (generation ids, section 11). */
export function randomBase32(bits = 64): string {
	const bytes = randomBytes(Math.ceil(bits / 8));
	let acc = 0n;
	for (const b of bytes) acc = (acc << 8n) | BigInt(b);
	let out = "";
	for (let i = 0; i < Math.ceil(bits / 5); i++) { out = BASE32[Number(acc & 31n)] + out; acc >>= 5n; }
	return out;
}
