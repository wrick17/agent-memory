// BothQ-era request replay (architecture section 16). Pure: the Worker computes the legacy hash next to the modern one.
import { requestHash } from "./ids";

/** Arguments Agent Memory adds that a BothQ call never carried. */
const MODERN_ONLY = new Set(["request_id", "profile", "repo", "company_free"]);

/** The BothQ operation an Agent Memory call stands for, as BothQ's own tools named them; undefined when there is none. */
export function legacyOp(tool: string, args: Record<string, unknown>): string | undefined {
	if (tool === "append_memory") return "append";
	if (tool !== "save_memory") return undefined;
	if (args.retire === true) return "retire";
	return args.memory_id !== undefined || args.from_scope !== undefined || args.new_name !== undefined ? "update" : "save";
}

/**
 * BothQ's request hash for the same call: SHA-256 of `{operation, arguments}` over the redacted arguments BothQ would have
 * received (memory_store._prepare). BothQ never stored arguments, so this only ever compares, never reconstructs.
 */
export function legacyRequestHash(tool: string, args: Record<string, unknown>): string | undefined {
	const op = legacyOp(tool, args);
	if (!op) return undefined;
	return requestHash(op, Object.fromEntries(Object.entries(args).filter(([k]) => !MODERN_ONLY.has(k) && !(op === "retire" && k === "retire"))));
}
