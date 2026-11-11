// node --test local/facts-detect.test.mjs : repo facts v2 detectors (#116). Synthetic digests built here, plus the recorded fixtures
// for determinism. No network, no model, no home directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const D = await import("./facts-detect.mjs");
const { detect, outcomes, commandCounts, matchSignature, headLabel, factKey, FACT_LITERAL } = D;

let n = 0;
const cmd = (c, status = "ok", err = []) => ({ id: String(++n), at: null, cmd: c, family: null, status, exit: status === "ok" ? 0 : status === "failed" ? 1 : null, err });
const digest = (commands) => ({ v: 1, client: "codex", session: "codex:000000000001", repo: "github.com/o/r", files: [], commands, dropped: 0 });
const obs = (cmds, known = []) => detect(digest(cmds), { known }).observations.map((o) => `${o.kind}:${o.detector}:${o.literal}`);
const NF = (p) => [`zsh:1: command not found: ${p}`];
const GH = "env -u GITHUB_TOKEN -u GH_TOKEN gh auth switch";

describe("form_repair", () => {
	it("learns pytest -> python -m pytest and tsc -> npx tsc with the contract literal and statement", () => {
		assert.deepEqual(obs([cmd("pytest -q tests", "failed", NF("pytest")), cmd("python -m pytest -q tests")]),
			["confirm:unavailable_tool:pytest", "confirm:form_repair:pytest => python -m pytest"]);
		assert.deepEqual(obs([cmd("pytest", "failed", ["ImportError while loading conftest"]), cmd("python3 -m pytest")]), ["confirm:form_repair:pytest => python3 -m pytest"], "a nonzero exit counts too");
		const r = detect(digest([cmd("tsc --noEmit", "failed", NF("tsc")), cmd("npx tsc --noEmit")]));
		const f = r.observations.find((o) => o.detector === "form_repair");
		assert.equal(f.literal, "tsc => npx tsc");
		assert.ok(FACT_LITERAL.form_repair.test(f.literal));
		assert.equal(f.fact_key, factKey("form_repair", "tsc => npx tsc"));
		assert.equal(f.statement, "Run `npx tsc` instead of plain `tsc`; plain `tsc` fails on this machine.");
		assert.equal(f.label, "prog:tsc");
	});

	it("reads every shell's not-found line, and pins a chained failure only when the shell names the program", () => {
		for (const e of ["zsh:1: command not found: pytest", "zsh: command not found: pytest", "bash: pytest: command not found", "bash: line 1: pytest: command not found"])
			assert.ok(obs([cmd("pytest", "failed", [e]), cmd("python -m pytest")]).includes("confirm:form_repair:pytest => python -m pytest"), e);
		assert.deepEqual(obs([cmd("npm ci && pytest", "failed", ["npm ERR! code 1"]), cmd("python -m pytest")]), [], "the failing step is unknown");
		assert.ok(obs([cmd("npm ci && pytest", "failed", NF("pytest")), cmd("python -m pytest")]).includes("confirm:form_repair:pytest => python -m pytest"));
	});
});

describe("arg_repair", () => {
	it("learns added and removed options with the contract literal and statement", () => {
		const r = detect(digest([cmd("npm test", "failed", ["FAIL"]), cmd("npm test -- --runInBand")])).observations;
		assert.deepEqual(r.map((o) => [o.detector, o.literal, o.label]), [["arg_repair", "npm test with -- --runInBand", "head:npm test"]]);
		assert.ok(FACT_LITERAL.arg_repair.test(r[0].literal));
		assert.equal(r[0].statement, "`npm test` fails here without `-- --runInBand`; run `npm test -- --runInBand`.");
		const w = detect(digest([cmd("npx vitest --watch", "failed", ["x"]), cmd("npx vitest")])).observations;
		assert.deepEqual(w.map((o) => o.literal), ["npx vitest without --watch"]);
		assert.equal(w[0].statement, "`npx vitest` fails here with `--watch`; run it without them.");
	});

	it("never teaches informational, safety-overriding, secret or positional args", () => {
		for (const fix of ["npm test -- --listTests", "npm test -- --help", "npm test --version", "npm test --api-key=abc", "npm test tests/a.test.js"])
			assert.deepEqual(obs([cmd("npm test", "failed", ["FAIL"]), cmd(fix)]), [], fix);
		assert.deepEqual(obs([cmd("git push", "failed", ["rejected"]), cmd("git push --force")]), []);
		assert.deepEqual(obs([cmd("git commit -m x", "failed", ["hook failed"]), cmd("git commit -m x --no-verify")]), []);
	});
});

describe("same-operation proof", () => {
	it("rejects a later success that is a different operation", () => {
		assert.deepEqual(obs([cmd("npm test -- --runInBand", "failed", ["FAIL"]), cmd("npm test -- --listTests")]), [], "--listTests does not repair --runInBand");
		assert.deepEqual(obs([cmd("npm test -- --runInBand", "failed", ["FAIL"]), cmd("ls"), cmd("npm run lint")]), [], "an unrelated success");
		assert.deepEqual(obs([cmd("pytest -q", "failed", NF("pytest")), cmd("python -m pytest -x")]), ["confirm:unavailable_tool:pytest"], "the wrapped run has other args");
		assert.deepEqual(obs([cmd("gh auth switch --user x", "failed", ["token"]), cmd(`${GH} --user y`)]), [], "env repair with other args");
		assert.deepEqual(obs([cmd("npm run build", "failed", ["API_URL is not set"]), cmd("API_URL=http://a npm run build -- --x")]), [], "env_var with other args");
		assert.deepEqual(obs([cmd("pytest", "failed", NF("pytest")), cmd("FOO=1 python -m pytest")]), ["confirm:unavailable_tool:pytest"], "a fix that also changes the env");
	});

	it("keeps the same operation with only the fix's own change", () => {
		assert.deepEqual(obs([cmd("gh auth switch --user x", "failed", ["token"]), cmd(`${GH} --user x`)]), [`confirm:command_repair:${GH}`]);
		assert.deepEqual(obs([cmd("npm run build", "failed", ["API_URL is not set"]), cmd("API_URL=http://a npm run build")]).sort(),
			["confirm:command_repair:API_URL=… npm run build", "confirm:env_var:npm run build needs API_URL"]);
		assert.deepEqual(obs([cmd("pytest", "failed", NF("pytest")), ...Array.from({ length: 5 }, (_, i) => cmd(`ls ${i}`)), cmd("python -m pytest")]), ["confirm:unavailable_tool:pytest"], "outside the window");
	});

	it("blames an env repair only on the step that failed (review: a chain failing in its second step)", () => {
		const chain = (err) => cmd("npm test && npm run build", "failed", err);
		assert.deepEqual(obs([chain(["build failed"]), cmd("env -u NODE_OPTIONS npm test")]), [], "npm test may have passed");
		assert.deepEqual(obs([chain(["build failed"]), cmd("env -u NODE_OPTIONS npm run build")]), [], "npm test may have failed first");
		assert.deepEqual(obs([chain(["API_URL is not set"]), cmd("API_URL=x npm test")]), [], "env_var: same rule");
		// The last `;` group's single step carries the command's status, so it is attributable.
		assert.deepEqual(obs([cmd("npm ci; npm run build", "failed", ["API_URL is not set"]), cmd("API_URL=x npm run build")]).sort(),
			["confirm:command_repair:API_URL=… npm run build", "confirm:env_var:npm run build needs API_URL"]);
		assert.deepEqual(outcomes(digest([chain(["build failed"])]), [{ detector: "command_repair", literal: "env -u NODE_OPTIONS npm test" }]).map((o) => o.outcome), ["prevented"], "not fired");
	});

	it("contradicts form and arg facts only with the plain shape", () => {
		const form = [{ detector: "form_repair", literal: "pytest => python -m pytest" }], arg = [{ detector: "arg_repair", literal: "npm test with -- --runInBand" }];
		assert.deepEqual(obs([cmd("pytest -q")], form), ["contradict:form_repair:pytest => python -m pytest"]);
		assert.deepEqual(obs([cmd("python -m pytest -q")], form), [], "the fix is no contradiction and no reuse confirmation");
		assert.deepEqual(obs([cmd("npm test")], arg), ["contradict:arg_repair:npm test with -- --runInBand"]);
		assert.deepEqual(obs([cmd("npm test -- --runInBand")], arg), []);
	});
});

describe("unavailable_tool modules", () => {
	it("keeps the full dotted name and matches contradictions on it", () => {
		const r = detect(digest([cmd("python -c 'import numpy.typing'", "failed", ["ModuleNotFoundError: No module named 'numpy.typing'"])])).observations;
		assert.deepEqual(r.map((o) => [o.literal, o.label]), [["import numpy.typing", "pymod:numpy"]]);
		assert.equal(r[0].statement, "In the recorded Python environments `import numpy.typing` fails (No module named 'numpy.typing').");
		const known = [{ detector: "unavailable_tool", literal: "import numpy.typing" }];
		assert.deepEqual(obs([cmd("python -c 'import numpy'")], known), [], "the parent importing proves nothing about the submodule");
		assert.deepEqual(obs([cmd("python -c 'import numpy.typing'")], known), ["contradict:unavailable_tool:import numpy.typing"]);
		assert.deepEqual(obs([cmd("python -c 'import numpy.typing'")], [{ detector: "unavailable_tool", literal: "import numpy" }]), ["contradict:unavailable_tool:import numpy"], "a legacy truncated fact");
	});
});

describe("family labels", () => {
	it("uses headLabel for every head and adds the wrapped program's labels", () => {
		assert.equal(headLabel("make"), "prog:make");
		assert.equal(headLabel("npm run build"), "head:npm run build");
		assert.equal(D.describe("env_var", "make needs API_URL").label, "prog:make", "a one-word head is a prog label (v1 sent head:make)");
		assert.equal(D.describe("unavailable_tool", "npm test needs vitest").label, "head:npm test");
		assert.equal(D.describe("empty_vcs", "git").label, "prog:git");
		const { labels } = detect(digest([cmd("python -m pytest -q"), cmd("npm exec tsc -- -p ."), cmd("gh auth switch --user x", "failed", ["x"]), cmd("uv run ruff check")]));
		for (const l of ["prog:python", "prog:pytest", "head:npm exec", "head:npm exec tsc", "prog:tsc", "prog:gh", "head:gh auth", "head:gh auth switch", "prog:uv", "prog:ruff", "head:ruff check"])
			assert.ok(labels.includes(l), l);
		assert.deepEqual(labels, [...labels].sort());
	});
});

describe("learned signatures", () => {
	const sig = { head: "make check", scope: ["make check"], confirm: ["missing header"], contradict: ["fast=1"], fix: "make deps" };
	const literal = D.learnedLiteral(sig, "environment");

	it("matches scope, confirm, contradict and fix by lowercase substring", () => {
		assert.deepEqual(matchSignature(digest([cmd("make check", "failed", ["fatal: Missing Header foo.h"])]), sig), { in_scope: true, confirm: true, contradict: false, fixed: false });
		assert.deepEqual(matchSignature(digest([cmd("make deps"), cmd("make check FAST=1")]), { ...sig, scope: ["make"], contradict: ["fast=1"] }), { in_scope: true, confirm: false, contradict: true, fixed: true });
		assert.equal(matchSignature(digest([cmd("make check && echo fast=1")]), { ...sig, contradict: ["fast=1"] }).contradict, false, "only an in-scope step contradicts");
		assert.deepEqual(matchSignature(digest([cmd("make lint", "failed", ["missing header"])]), sig), { in_scope: false, confirm: false, contradict: false, fixed: false }, "out of scope");
		assert.deepEqual(matchSignature(digest([cmd("make check")]), { ...sig, scope: [] }), { in_scope: false, confirm: false, contradict: false, fixed: false }, "an invalid signature");
		assert.deepEqual(matchSignature(digest([cmd("make check")]), { ...sig, scope: ["MAKE"] }), { in_scope: false, confirm: false, contradict: false, fixed: false }, "strings must be lowercase");
	});

	it("never compiles a regex from signature strings", () => {
		const meta = { head: "abc", scope: ["a.c"], confirm: ["(x+"], contradict: ["[z]"] };
		const real = globalThis.RegExp;
		const made = [];
		globalThis.RegExp = new Proxy(real, { construct: (t, a) => { made.push(String(a[0])); return Reflect.construct(t, a); }, apply: (t, _, a) => { made.push(String(a[0])); return Reflect.apply(t, undefined, a); } });
		let r;
		try { r = matchSignature(digest([cmd("abc", "failed", ["xx"]), cmd("a.c run", "failed", ["(x+ broke"])]), meta); } finally { globalThis.RegExp = real; }
		assert.deepEqual(made.filter((s) => ["a.c", "(x+", "[z]", "abc"].some((x) => s.includes(x))), []);
		assert.deepEqual(r, { in_scope: true, confirm: true, contradict: false, fixed: false }, "`a.c` matches only the literal text");
	});

	it("confirms a known learned fact, and a contradiction wins in the same session", () => {
		const known = [{ detector: "learned", literal, signature: sig }];
		const c = detect(digest([cmd("make check", "failed", ["missing header"])]), { known }).observations;
		assert.deepEqual(c.map((o) => [o.kind, o.fact_key, o.label]), [["confirm", factKey("learned", literal), "head:make check"]]);
		assert.equal(c[0].statement, "Learned: `make check` has failed here with an error containing \"missing header\". A command that worked here: `make deps`.");
		assert.deepEqual(obs([cmd("make check", "failed", ["missing header"]), cmd("make check FAST=1")], known), [`contradict:learned:${literal}`]);
		assert.deepEqual(obs([cmd("make deps")], known), [], "a reused fix is no confirmation");
	});
});

describe("outcomes and counts", () => {
	it("reports fired, prevented and unexercised per injected fact, in input order", () => {
		const sig = { head: "make check", scope: ["make"], confirm: ["missing header"], contradict: [], fix: "make deps" };
		const injected = [
			{ detector: "form_repair", literal: "pytest => python -m pytest" },
			{ detector: "arg_repair", literal: "npm test with -- --runInBand" },
			{ detector: "network", literal: "github.com" },
			{ fact_key: "0123456789abcdef", detector: "learned", literal: "x", signature: sig },
			{ detector: "command_repair", literal: GH },
			{ detector: "bogus", literal: "x" },
		];
		const run = (cmds) => outcomes(digest(cmds), injected).map((o) => o.outcome);
		assert.deepEqual(run([cmd("python -m pytest"), cmd("npm test", "failed", ["x"]), cmd("make check", "failed", ["Missing header"]), cmd(`${GH} --user x`)]),
			["prevented", "fired", "unexercised", "fired", "prevented"]);
		assert.deepEqual(run([cmd("pytest", "failed", NF("pytest")), cmd("npm test -- --runInBand"), cmd("git fetch", "failed", ["fatal: Could not resolve host: github.com"]), cmd("make deps"), cmd("gh auth switch --user x", "failed", ["token"])]),
			["fired", "prevented", "fired", "prevented", "fired"]);
		assert.deepEqual(run([cmd("ls")]), ["unexercised", "unexercised", "unexercised", "unexercised", "unexercised"]);
		const out = outcomes(digest([]), injected);
		assert.equal(out.length, 5, "an unknown detector is skipped");
		assert.deepEqual(out[3], { kind: "fact", fact_key: "0123456789abcdef", outcome: "unexercised" });
		assert.equal(out[0].fact_key, factKey("form_repair", "pytest => python -m pytest"));
	});

	it("counts commands, failures and repeated (head, first error line) failures", () => {
		assert.deepEqual(commandCounts(digest([cmd("npm test", "failed", ["E1"]), cmd("ls"), cmd("cd web && npm test", "failed", ["E1"]), cmd("npm test", "failed", ["E2"]), cmd("x", "unknown")])),
			{ total: 5, failed: 3, repeated_failures: 1 });
		assert.deepEqual(commandCounts({}), { total: 0, failed: 0, repeated_failures: 0 });
	});
});

describe("determinism and isolation", () => {
	it("gives identical output for the same input, over every recorded fixture", () => {
		const root = new URL("../test/fixtures/repo-facts/", import.meta.url);
		for (const dir of fs.readdirSync(root)) {
			const digests = fs.readFileSync(new URL(`${dir}/digests.jsonl`, root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			const run = (ds) => JSON.stringify(ds.map((d) => [detect(d), outcomes(d, [{ detector: "form_repair", literal: "pytest => python -m pytest" }]), commandCounts(d)]));
			assert.equal(run(digests), run(structuredClone(digests)), dir);
		}
	});

	it("imports nothing that can reach the network or a model", () => {
		const src = fs.readFileSync(new URL("./facts-detect.mjs", import.meta.url), "utf8");
		assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["node:crypto", "node:path", "./agent-memory.mjs"]);
		assert.ok(!/(?<![.\w])(?:fetch|spawn|exec(?:File|Sync)?|import)\(/.test(src.replace(/^\/\/.*$/gm, "")), "no fetch, subprocess or dynamic import");
	});

	it("mirrors the v2 grammars in src/domain/types.ts exactly", () => {
		const ts = fs.readFileSync(new URL("../src/domain/types.ts", import.meta.url), "utf8");
		const line = (name) => ts.split("\n").find((l) => l.startsWith(`export const ${name} =`));
		const block = ts.slice(ts.indexOf('const PROG = "'), ts.indexOf("/** Session order"));
		const js = [line("FACT_CLASSES"), line("FORM_WRAPPERS"), line("FIX_DENY"), block].join("\n")
			.replace(/^export /gm, "").replace(/ as const/g, "").replace(/: Readonly<Record<[^=]*>> =/g, " =");
		const T = new Function(`${js}\nreturn { FACT_CLASSES, FORM_WRAPPERS, FIX_DENY, FACT_LITERAL, FACT_HEAD, FACT_FIX, FACT_SIGNATURE_STRING };`)();
		for (const k of ["FACT_CLASSES", "FORM_WRAPPERS", "FIX_DENY"]) assert.deepEqual([...D[k]], T[k], k);
		for (const k of ["FACT_HEAD", "FACT_FIX", "FACT_SIGNATURE_STRING"]) assert.equal(D[k].source, T[k].source, k);
		assert.deepEqual(Object.keys(D.FACT_LITERAL), Object.keys(T.FACT_LITERAL));
		for (const k of Object.keys(T.FACT_LITERAL)) assert.equal(D.FACT_LITERAL[k].source, T.FACT_LITERAL[k].source, k);
	});
});
