// Lint: no internal imports across store folders, and fetch() only in egress.ts (sections 3 and 19).
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/", ".wrangler/", "worker-configuration.d.ts"] },
	...tseslint.configs.recommended,
	{
		files: ["src/**/*.ts"],
		rules: {
			"no-restricted-globals": ["error", { name: "fetch", message: "Only src/egress.ts may call fetch()." }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
	{
		files: ["src/*.ts", "src/domain/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", { patterns: [
				{ regex: "^\\./(profile|account)/(?!store$).+", message: "Import a store folder only through its store.ts." },
				{ regex: "^\\.\\./(profile|account)/.+", message: "domain/ stays pure." },
			] }],
		},
	},
	{ files: ["src/egress.ts"], rules: { "no-restricted-globals": "off" } },
	{ files: ["test/**/*.{ts,js}"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
