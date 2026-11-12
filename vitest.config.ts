import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
// @ts-expect-error test/ scripts are plain JavaScript without declarations
import { patchVitestPlugin } from "./test/patch-vitest-plugin.mjs";

// Every Vitest entry point (npm test, eval:baseline, a direct npx vitest) loads this file, so the plugin race fix of #143 is
// applied here, before the pool starts; a plugin it was not written for stops the run with what to do.
await patchVitestPlugin();

// Real workerd, SQLite Durable Objects and local R2. Workers AI and Vectorize have no local runtime,
// so the test environment wraps small fakes from test/fakes.js; live behavior is checked in G5.
export default defineConfig({
	plugins: [
		// #29: the same Text import wrangler.jsonc's rule gives the Worker: local/*-player.js as its exact bytes.
		{ name: "player-text", enforce: "pre", load: (id: string) => (/\/local\/[^/]+-player\.js$/.test(id) ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};` : null) },
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
			remoteBindings: false,
			miniflare: {
				workers: [{ name: "fakes", modules: true, scriptPath: "./test/fakes.js", compatibilityDate: "2026-10-20" }],
				serviceBindings: { AI: { name: "fakes", entrypoint: "FakeAI" }, VECTORS: { name: "fakes", entrypoint: "FakeVectors" } },
				bindings: { BACKUP_KEY: "synthetic-test-backup-key-0000000000000000" },
			},
		}),
	],
	// local/ holds the Node-only capture client; node --test runs it (npm run test:local).
	// eval-baseline-setup.ts hands the synthetic recall baselines to test/eval-synthetic.test.ts (issue #20).
	// Four workers measured fastest on issue #143 (default parallelism was slower and used more memory); isolation stays on.
	test: { testTimeout: 30_000, maxWorkers: 4, include: ["test/**/*.test.ts"], globalSetup: ["./test/eval-baseline-setup.ts"] },
});
