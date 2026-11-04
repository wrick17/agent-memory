#!/usr/bin/env node
// Stage a self-host archive without touching the maintainer's README, config or client files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The corpus CLI with its only local imports (the corpus modules and src/domain), and the replay player src/dashboard.ts embeds;
// no capture installer, migrate or import files.
const FILES = ["src", "local/replay-player.js", "local/setup.mjs", "local/corpus-cli.mjs", "local/corpus-git.mjs", "local/corpus-judgment.mjs", "local/corpus-refresh.mjs", "local/corpus-scan.mjs", "local/corpus-upload.mjs", "docs/self-host.md", "wrangler.example.jsonc"];

export function stageSelfHost(root, target) {
	fs.mkdirSync(target, { mode: 0o700 });
	for (const file of FILES) {
		fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true, mode: 0o700 });
		fs.cpSync(path.join(root, file), path.join(target, file), { recursive: true });
	}
	fs.copyFileSync(path.join(root, "docs/self-host.md"), path.join(target, "README.md"));
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	manifest.scripts = { setup: "node local/setup.mjs" };
	// npm pack keeps only the manifest's files, so the archive's list is this stage's list.
	manifest.files = [...FILES, "npm-shrinkwrap.json"];
	fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	// npm excludes package-lock.json from tarballs; shrinkwrap preserves the same pinned dependency graph for npm ci.
	const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
	lock.version = manifest.version;
	lock.packages[""].version = manifest.version;
	lock.packages[""].engines = manifest.engines;
	fs.writeFileSync(path.join(target, "npm-shrinkwrap.json"), `${JSON.stringify(lock, null, 2)}\n`);
	// npm pack keeps each file's group and other read bits, so a private umask or source mode would leak into the archive.
	// Every packaged file is public 0644; the stage directories stay private.
	for (const entry of fs.readdirSync(target, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o644);
	}
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [destination, ...extra] = process.argv.slice(2);
	if (!destination || destination.startsWith("-") || extra.length) {
		console.error("Use npm run pack:self-host -- /absolute/output-directory. Raw npm pack includes the maintainer README and is not a self-host archive.");
		process.exitCode = 2;
	} else {
		const output = path.resolve(destination);
		const scratch = fs.mkdtempSync(path.join(output, "agent-memory-"));
		const stage = path.join(scratch, "source");
		stageSelfHost(path.resolve(import.meta.dirname, ".."), stage);
		const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", scratch],
			{ cwd: stage, encoding: "utf8" });
		if (result.status !== 0) {
			console.error(`npm pack failed; staged source retained at ${stage}`);
			process.exitCode = 1;
		} else {
			console.log(path.join(scratch, JSON.parse(result.stdout)[0].filename));
		}
	}
}
