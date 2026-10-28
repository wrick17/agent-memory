import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Real workerd, SQLite Durable Objects and local R2. Workers AI and Vectorize have no local runtime,
// so the test environment wraps small fakes from test/fakes.js; live behavior is checked in G5.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
			remoteBindings: false,
			miniflare: {
				workers: [{ name: "fakes", modules: true, scriptPath: "./test/fakes.js", compatibilityDate: "2026-10-20" }],
				serviceBindings: { AI: { name: "fakes", entrypoint: "FakeAI" }, VECTORS: { name: "fakes", entrypoint: "FakeVectors" } },
			},
		}),
	],
	test: { testTimeout: 30_000 },
});
