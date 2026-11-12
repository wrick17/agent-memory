// Test-only patch for @cloudflare/vitest-plugin 1.4.9 (cloudflare/workers-sdk#15920). importModule re-imports the Worker's main
// module through the host even when it is already evaluated, so a Durable Object woken during file teardown leaves a pending
// resolution that Vitest rejects as it closes the file's RPC channel. An evaluated module's own evaluation promise answers
// without that host round trip, with the runner's result: its exports, or the same rejection when initialization threw. Anything
// not evaluated, or invalidated, takes the normal import. vitest.config.ts applies it, so every Vitest entry point gets it.
// shortcut: patches node_modules in place for one pinned version; remove this script and its vitest.config.ts call once a plugin
// release fixes #15920, or replace it when the plugin is upgraded (a version change fails here on purpose).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "1.4.9";
const ORIGINAL = "\t\treturn __vitest_mocker__.moduleRunner.import(specifier);\n";
const PATCHED = [
	"\t\tconst runner = __vitest_mocker__.moduleRunner; // agent-memory test patch, workers-sdk#15920",
	"\t\tconst cached = runner.evaluatedModules.getModuleById(specifier);",
	"\t\tif (cached?.evaluated && cached.promise) return cached.promise;",
	"\t\treturn runner.import(specifier);",
	"",
].join("\n");

/** The patched body against stand-in module nodes: a loaded module, one whose initialization threw, and an invalidated one. */
async function selfCheck() {
	const run = new Function("__vitest_mocker__", "specifier", PATCHED);
	const fail = (why) => { throw new Error(`patch-vitest-plugin self-check: ${why}`); };
	const importModule = async (node) => {
		let imports = 0;
		const runner = { evaluatedModules: { getModuleById: (id) => (id === "/main" ? node : undefined) }, import: async () => { imports++; return "fresh"; } };
		try { return { value: await run({ moduleRunner: runner }, "/main"), imports }; } catch (error) { return { error, imports }; }
	};
	const exports = { ok: true }, broken = new Error("init threw"), rejected = Promise.reject(broken);
	rejected.catch(() => {});
	const loaded = await importModule({ evaluated: true, promise: Promise.resolve(exports), exports });
	if (loaded.value !== exports || loaded.imports !== 0) fail("a loaded module must answer from its promise without an import");
	const threw = await importModule({ evaluated: true, promise: rejected, exports: { partial: true } });
	if (threw.error !== broken || threw.imports !== 0) fail("a module whose initialization threw must reject again, not return partial exports");
	const invalidated = await importModule({ evaluated: false, promise: undefined, exports: undefined });
	if (invalidated.value !== "fresh" || invalidated.imports !== 1) fail("an invalidated module must take the normal import");
}

/** Applies the patch once, idempotently, and throws with what to do when the installed plugin is not the one it was written for. */
export async function patchVitestPlugin() {
	await selfCheck();
	const root = fileURLToPath(new URL("../node_modules/@cloudflare/vitest-plugin/", import.meta.url));
	const fail = (why) => { throw new Error(`patch-vitest-plugin: ${why}. Check whether cloudflare/workers-sdk#15920 is fixed, then update or remove test/patch-vitest-plugin.mjs.`); };
	const { version } = JSON.parse(readFileSync(root + "package.json", "utf8"));
	if (version !== VERSION) fail(`expected @cloudflare/vitest-plugin ${VERSION}, found ${version}`);
	const file = root + "dist/worker/lib/cloudflare/test-internal.mjs";
	const source = readFileSync(file, "utf8");
	const count = (s) => source.split(s).length - 1;
	if (count(PATCHED) === 1 && count(ORIGINAL) === 0) return;
	if (count(ORIGINAL) !== 1 || count(PATCHED) !== 0) fail(`the expected importModule source was not found exactly once in ${file}`);
	// Same directory, then rename: a concurrent reader sees the old file or the new one, never a partial write.
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, source.replace(ORIGINAL, PATCHED));
	renameSync(temp, file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await patchVitestPlugin();
