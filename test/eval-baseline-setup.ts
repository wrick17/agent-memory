// Vitest global setup (Node) for the issue #20 synthetic recall gate. It hands the recorded synthetic baselines to
// test/eval-synthetic.test.ts. Under `npm run eval:baseline` (EVAL_WRITE_BASELINE=1) it also serves a loopback-only writer:
// the Workers test cannot write files, so it posts each channel's summary here and local/eval.mjs writeBaseline applies the
// only-rises rule.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext { evalBaselines: Record<string, Record<string, unknown> | null>; evalBaselineUrl: string | null }
}

const CHANNEL_NAMES = ["lexical", "vector", "hybrid"] as const;
const baselineFile = (channels: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "eval", `synthetic-baseline-${channels}.json`);
const read = (channels: string) => (fs.existsSync(baselineFile(channels)) ? JSON.parse(fs.readFileSync(baselineFile(channels), "utf8")) as Record<string, unknown> : null);

export default async function setup(project: TestProject) {
	project.provide("evalBaselines", Object.fromEntries(CHANNEL_NAMES.map((c) => [c, read(c)])));
	if (process.env.EVAL_WRITE_BASELINE !== "1") {
		project.provide("evalBaselineUrl", null);
		return;
	}
	// @ts-expect-error local/ is plain JavaScript without declarations
	const { writeBaseline } = await import("../local/eval.mjs") as { writeBaseline: (file: string, summary: object) => { written: boolean; reason?: string } };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; if (body.length > 8192) req.destroy(); });
		req.on("end", () => {
			try {
				const summary = JSON.parse(body) as { channels?: unknown };
				if (req.method !== "POST" || !CHANNEL_NAMES.includes(summary.channels as never)) throw new Error("expected one channel summary");
				res.end(JSON.stringify(writeBaseline(baselineFile(String(summary.channels)), summary)));
			} catch (e) {
				res.statusCode = 400;
				res.end(JSON.stringify({ error: (e as Error).message }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	project.provide("evalBaselineUrl", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
	return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
