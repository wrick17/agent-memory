// node --test local/setup.test.mjs : the self-host setup against an injected, in-memory Wrangler. No network, no real account.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { stageSelfHost } from "./package.mjs";
import { CONFIG_FILE, RECEIPTS_FILE, ROUTABLE, check, render, setup } from "./setup.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const OWNER = "user_2synthetic0wner0000000000";
const EMAIL = "someone@private.invalid";
const TOKEN = "synthetic-wrangler-oauth-token-0000";
const pk = (host) => `pk_live_${Buffer.from(`${host}$`).toString("base64")}`;
const SETTINGS = { account_id: ACCOUNT, worker: "am-selfhost", public_url: "https://memory.selfhost-synthetic.dev",
	clerk_issuer: "https://clerk.selfhost-synthetic.dev", clerk_publishable_key: pk("clerk.selfhost-synthetic.dev"),
	routing: ["github.com/synthetic-org/*=work", "path:/home/synthetic/work=work", "github.com/synthetic-user/*=personal"],
	embeddings: "on", corpus: "off" };
const WORKER_TS = 'export { AccountStore } from "./account/store";\nexport { ProfileStore } from "./profile/store";\n';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "am-setup-test-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const jsonc = (text) => JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n"));

/**
 * One synthetic Cloudflare account behind the Wrangler commands setup uses. `fail` makes the first command starting with
 * `fail.on` exit 1, after doing its work anyway when `fail.created` (a timeout after Cloudflare acted).
 */
function cloudflare({ loggedIn = true, accounts = [ACCOUNT], buckets = [], indexes = [], metadata = {}, workers = {}, fail = null, subdomain = null, auth = { type: "oauth", token: TOKEN } } = {}) {
	const state = { buckets: [...buckets], indexes: [...indexes], metadata: { ...metadata }, workers: { ...workers }, secrets: {}, subdomain };
	const calls = [];
	const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
	const run = (args, input = "") => {
		calls.push({ args, input });
		if (fail && args.join(" ").startsWith(fail.on)) {
			if (fail.created) respond(args, input);
			fail = null;
			return { status: 1, stdout: "", stderr: "✘ [ERROR] synthetic failure" };
		}
		return respond(args, input);
	};
	const respond = (args, input) => {
		const [a, b, c] = args;
		if (a === "whoami") return loggedIn ? ok(JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: EMAIL, accounts: accounts.map((id) => ({ id, name: `${EMAIL}'s Account` })) }))
			: { status: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
		if (a === "auth" && b === "token") return ok(JSON.stringify(auth));
		if (a === "r2" && b === "bucket" && c === "list") return ok(`Listing buckets...\n${state.buckets.map((n) => `name:           ${n}\ncreation_date:  2026-10-30T00:00:00.000Z`).join("\n\n")}\n`);
		if (a === "r2" && b === "bucket" && c === "create") { state.buckets.push(args[3]); return ok("Created bucket\n"); }
		if (a === "vectorize" && b === "list") return ok(JSON.stringify(state.indexes));
		if (a === "vectorize" && b === "list-metadata-index") return ok(JSON.stringify(state.metadata[c] ?? []));
		if (a === "vectorize" && b === "create") { state.indexes.push({ name: c, config: { dimensions: Number(args[4]), metric: args[6] } }); return ok("created\n"); }
		if (a === "vectorize" && b === "create-metadata-index") { (state.metadata[c] ??= []).push({ propertyName: args[4], indexType: "String" }); return ok("enqueued\n"); }
		if (a === "secret" && b === "list") {
			const names = state.workers[args[3]];
			return names ? ok(JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))))
				// Wrangler 4.154's exact output: esbuild-formatted error and notes, then its default log-file footer on exit.
				: { status: 1, stdout: "\n", stderr: `\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mWorker "${args[3]}" not found.\u001b[0m\n\n  \n` +
					"  If this is a new Worker, run `wrangler deploy` first to create it.\n" +
					"  Otherwise, check that the Worker name is correct and you're logged into the right account.\n\n\n" +
					"🪵  Logs were written to \"/synthetic/.wrangler/logs/wrangler-2026-11-01_00-00-00_000.log\"\n" };
		}
		if (a === "secret" && b === "put") { (state.workers[args[4]] ??= []).push(c); state.secrets[c] = input; return ok(`✨ Success! Uploaded secret ${c}\n`); }
		return { status: 1, stdout: "", stderr: `unexpected command ${args.join(" ")}` };
	};
	/** The Cloudflare API behind workers.dev: only the read of the account subdomain exists. */
	const fetch = async (url, init = {}) => {
		calls.push({ args: [init.method ?? "GET", url], input: "", authorization: init.headers?.Authorization });
		if (url !== `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain` || init.headers?.Authorization !== `Bearer ${TOKEN}`) {
			return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }, { status: 403 });
		}
		return state.subdomain ? Response.json({ success: true, errors: [], messages: [], result: { subdomain: state.subdomain } })
			: Response.json({ success: false, errors: [{ code: 10007, message: "workers.dev subdomain not found" }], result: null }, { status: 404 });
	};
	return { run, fetch, calls, state };
}

let n = 0;
function project({ settings = SETTINGS, workerTs = WORKER_TS } = {}) {
	const root = path.join(tmp, `p${++n}`);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "worker.ts"), workerTs);
	fs.writeFileSync(path.join(root, "agent-memory.setup.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
	return root;
}

async function go(root, cf, { apply = true, owner = OWNER } = {}) {
	const lines = [];
	let asked = 0;
	const hadLock = fs.existsSync(path.join(root, "agent-memory.setup.lock"));
	const code = await setup({ root, argv: apply ? ["--apply"] : [], wrangler: cf.run, fetch: cf.fetch, readOwnerId: async () => { asked++; return owner; }, log: (l) => lines.push(l) });
	if (!hadLock) assert.equal(fs.existsSync(path.join(root, "agent-memory.setup.lock")), false, "the invocation releases its apply lock on every return");
	return { code, out: lines.join("\n"), asked };
}
const WRITES = new Set(["create", "create-metadata-index", "put", "delete", "bulk"]);
const PYTHON_PTY = spawnSync("python3", ["-I", "-c", "import pty"]).status === 0;
/** Runs argv on a new pseudo-terminal, types the last argument once the prompt shows, and prints the whole transcript. */
const PTY_DRIVER = `import json, os, pty, select, sys, termios
argv, keys = sys.argv[1:-1], sys.argv[-1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
before = termios.tcgetattr(fd)
out, sent = b"", False
while True:
    ready, _, _ = select.select([fd], [], [], 5)
    if not ready:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    out += data
    if not sent and b"Clerk user id of the owner" in out:
        os.write(fd, keys)
        sent = True
done, status = os.waitpid(pid, os.WNOHANG)
if done == 0:
    os.kill(pid, 9)
    status = os.waitpid(pid, 0)[1]
after = termios.tcgetattr(fd)
os.close(fd)
mask = termios.ECHO | termios.ICANON
print(json.dumps({"transcript": out.decode(), "terminalRestored": (before[3] & mask) == (after[3] & mask), "exit": os.waitstatus_to_exitcode(status)}))
`;
/** setup with its default owner prompt on the terminal and an offline Wrangler; records only whether the id came on stdin. */
const PTY_HARNESS = `import fs from "node:fs";
const [setupUrl, root, out, stateFile] = process.argv.slice(2);
const { setup } = await import(setupUrl);
const calls = [];
const output = { stdout: "", stderr: "" };
for (const name of ["stdout", "stderr"]) {
	const write = process[name].write.bind(process[name]);
	process[name].write = (chunk, ...args) => { output[name] += chunk.toString(); return write(chunk, ...args); };
}
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
const wrangler = (args, input = "") => {
	calls.push({ args, owner: input === ${JSON.stringify(OWNER)} });
	if (args[0] === "whoami") return ok(JSON.stringify({ loggedIn: true, accounts: [{ id: ${JSON.stringify(ACCOUNT)} }] }));
	if (stateFile) {
		const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		if (args.slice(0, 3).join(" ") === "r2 bucket list") return ok(state.buckets.map((n) => "name: " + n).join("\\n"));
		if (args[0] === "secret" && args[1] === "list" && state.workers["am-selfhost"]) return ok(JSON.stringify(state.workers["am-selfhost"].map((name) => ({ name }))));
		if (args[0] === "secret" && args[1] === "put") {
			state.workers["am-selfhost"] = ["OWNER_USER_ID"];
			state.secrets.OWNER_USER_ID = input;
			fs.writeFileSync(stateFile, JSON.stringify(state));
			return ok("");
		}
	}
	if (args[0] === "secret" && args[1] === "list") return { status: 1, stdout: "", stderr: 'Worker "am-selfhost" not found.' };
	return ok("");
};
const code = await setup({ root, argv: ["--apply"], wrangler });
fs.writeFileSync(out, JSON.stringify({ code, leaks: Object.values(output).some((s) => /synthetic0wner|syntheticSecond/.test(s)), paused: process.stdin.isPaused(), raw: !!process.stdin.isRaw, calls: calls.length, argv: JSON.stringify(calls.map((c) => c.args)),
	stdin: calls.filter((c) => c.owner).map((c) => [c.args.slice(0, 3).join(" "), true]),
	writes: calls.filter((c) => ["create", "create-metadata-index", "put"].some((w) => c.args.includes(w))).map((c) => c.args.join(" ")) }));
process.exitCode = 0;
`;
/** Two setup processes share synthetic remote state. B either reaches the prompt (the old bug) or refuses the held lock. */
const OVERLAP_DRIVER = String.raw`import json, os, pty, select, signal, sys, termios, time
node, harness, setup_url, root, state = sys.argv[1:]
children = []
def start(name):
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(node, [node, harness, setup_url, root, root + "/" + name + ".json", state])
    c = {"pid": pid, "fd": fd, "output": b"", "done": False, "before": termios.tcgetattr(fd)}
    children.append(c)
    return c
def read_until(c, prompt=False):
    deadline = time.monotonic() + 10
    while not c["done"]:
        if prompt and b"Clerk user id of the owner" in c["output"]:
            return
        assert time.monotonic() < deadline, "default-prompt child timed out"
        ready, _, _ = select.select([c["fd"]], [], [], 0.1)
        if not ready:
            continue
        try:
            data = os.read(c["fd"], 4096)
        except OSError:
            data = b""
        if data:
            c["output"] += data
        else:
            _, status = os.waitpid(c["pid"], 0)
            c["done"] = True
            assert os.waitstatus_to_exitcode(status) == 0
            mask = termios.ECHO | termios.ICANON
            c["restored"] = (termios.tcgetattr(c["fd"])[3] & mask) == (c["before"][3] & mask)
try:
    a = start("first")
    read_until(a, prompt=True)
    assert not a["done"], "first apply did not reach its default prompt"
    b = start("second")
    read_until(b, prompt=True)
    os.write(a["fd"], b"user_2synthetic0wner0000000000\r")
    read_until(a)
    if not b["done"]:
        os.write(b["fd"], b"user_syntheticSecond0000\r")
        read_until(b)
    first_owner = json.load(open(state))["secrets"]["OWNER_USER_ID"] == "user_2synthetic0wner0000000000"
    late = start("late")
    read_until(late)
    results = [json.load(open(root + "/" + name + ".json")) for name in ["first", "second", "late"]]
    print(json.dumps({"results": results, "ownerKept": first_owner, "restored": [c["restored"] for c in children]}))
finally:
    for c in children:
        if not c["done"]:
            try:
                os.kill(c["pid"], signal.SIGKILL)
                os.waitpid(c["pid"], 0)
            except ProcessLookupError:
                pass
        os.close(c["fd"])
`;
const writes = (cf) => cf.calls.filter((x) => x.args.some((a) => WRITES.has(a)));
const configOf = (root) => fs.readFileSync(path.join(root, CONFIG_FILE), "utf8");

describe("self-host setup", () => {
	it("plans core with embeddings off and changes nothing", async () => {
		const root = project({ settings: { ...SETTINGS, embeddings: "off" } }), cf = cloudflare();
		const r = await go(root, cf, { apply: false });
		assert.equal(r.code, 0, r.out);
		assert.deepEqual(cf.calls.map((x) => x.args.slice(0, 2).join(" ")), ["whoami --json", "r2 bucket", "secret list"]);
		assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
		assert.equal(r.asked, 0);
		assert.match(r.out, /create R2 bucket am-selfhost-ledger/);
		assert.match(r.out, /off {4}embeddings: no Workers AI or Vectorize binding; recall is lexical/);
		assert.match(r.out, /Plan only; nothing was changed/);
	});

	it("applies a fresh plan with exact bindings in the verified account, keeping the owner id out of logs, argv and config", async () => {
		const root = project(), cf = cloudflare();
		const r = await go(root, cf);
		assert.equal(r.code, 0, r.out);
		assert.equal(r.asked, 1);
		assert.deepEqual(writes(cf).map((x) => x.args.join(" ")), [
			"r2 bucket create am-selfhost-ledger",
			"vectorize create am-selfhost-cards --dimensions 1024 --metric cosine",
			"vectorize create-metadata-index am-selfhost-cards --propertyName kind --type string",
			"secret put OWNER_USER_ID --name am-selfhost",
		]);
		assert.equal(cf.state.secrets.OWNER_USER_ID, OWNER);
		const text = configOf(root), c = jsonc(text);
		assert.equal(c.account_id, ACCOUNT);
		assert.deepEqual(c.routes, [{ pattern: "memory.selfhost-synthetic.dev", custom_domain: true }]);
		assert.deepEqual(c.durable_objects.bindings.map((b) => `${b.name}:${b.class_name}`), ["ACCOUNT:AccountStore", "PROFILE:ProfileStore"]);
		assert.deepEqual(c.migrations, [{ tag: "v1", new_sqlite_classes: ["AccountStore", "ProfileStore"] }]);
		assert.deepEqual(c.r2_buckets, [{ binding: "BACKUPS", bucket_name: "am-selfhost-ledger" }]);
		assert.deepEqual(c.ai, { binding: "AI" });
		assert.deepEqual(c.vectorize, [{ binding: "VECTORS", index_name: "am-selfhost-cards" }]);
		assert.deepEqual(c.version_metadata, { binding: "CF_VERSION_METADATA" }, "the viewer snapshot reads the deployed version");
		// src/dashboard.ts imports local/replay-player.js as text; without the maintainer config's exact rule the build fails.
		const source = JSON.parse(/^\t"rules": (\[.*\]),$/m.exec(fs.readFileSync(path.resolve(import.meta.dirname, "..", "wrangler.jsonc"), "utf8"))[1]);
		assert.deepEqual(c.rules, source);
		assert.deepEqual(c.rules, [{ type: "Text", globs: ["../local/*-player.js"], fallthrough: true }]);
		assert.deepEqual(c.vars, { RESOURCE_URL: "https://memory.selfhost-synthetic.dev/mcp", CLERK_ISSUER: "https://clerk.selfhost-synthetic.dev",
			CLERK_FRONTEND_API: "https://clerk.selfhost-synthetic.dev", CLERK_PUBLISHABLE_KEY: SETTINGS.clerk_publishable_key, REQUIRED_SCOPE: "memory",
			DASHBOARD_ORIGIN: "https://memory.selfhost-synthetic.dev", EMBEDDINGS: "on", ROUTING_DEFAULTS: SETTINGS.routing.join(","), IMPORT_PROFILES: "" });
		for (const where of [r.out, text, JSON.stringify(cf.calls.map((x) => x.args))]) {
			assert.equal(where.includes(OWNER), false);
			assert.equal(where.includes(EMAIL), false);
		}
		// The ledger bucket is the only R2 resource; no backup key, export or restore exists before the final stage.
		for (const where of [text, JSON.stringify(cf.calls.map((x) => x.args))]) assert.doesNotMatch(where, /BACKUP_KEY|backup key|export|restore/i);
		assert.equal(cf.calls.filter((x) => x.input).length, 1, "only secret put gets stdin");
	});

	it("serves a workers.dev URL only as this Worker's own URL on the account's own subdomain, without a custom domain", async () => {
		const workersDev = { ...SETTINGS, public_url: "https://am-selfhost.synthetic-sub.workers.dev" };
		const root = project({ settings: workersDev }), cf = cloudflare({ subdomain: "synthetic-sub" });
		const r = await go(root, cf);
		assert.equal(r.code, 0, r.out);
		assert.match(r.out, /on {5}workers\.dev: deploy serves the Worker at this URL with preview URLs off; no custom domain, route or DNS record/);
		assert.deepEqual(writes(cf).map((x) => x.args.slice(0, 2).join(" ")), ["r2 bucket", "vectorize create", "vectorize create-metadata-index", "secret put"]);
		const text = configOf(root), c = jsonc(text);
		assert.equal(c.workers_dev, true);
		assert.equal(c.preview_urls, false);
		assert.equal(c.routes, undefined, "no custom domain or route, so deploy changes no DNS");
		assert.equal(c.vars.RESOURCE_URL, "https://am-selfhost.synthetic-sub.workers.dev/mcp");
		assert.equal(c.vars.DASHBOARD_ORIGIN, "https://am-selfhost.synthetic-sub.workers.dev");
		// One read-only API call with the login's own token, which reaches no output, argv, config or receipt.
		assert.deepEqual(cf.calls.filter((x) => x.authorization).map((x) => x.args), [["GET", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`]]);
		const files = fs.readdirSync(root).filter((f) => fs.statSync(path.join(root, f)).isFile()).map((f) => fs.readFileSync(path.join(root, f), "utf8"));
		for (const where of [r.out, JSON.stringify(cf.calls.map((x) => x.args)), ...files]) assert.equal(where.includes(TOKEN), false);
		// The same shape on another account's subdomain, an account without one, a Worker setup did not create, or a login
		// whose token setup cannot use: refused before any write or config.
		for (const [label, other, why] of [
			["foreign subdomain", cloudflare({ subdomain: "someone-else" }), /is not on this account's workers\.dev subdomain someone-else\.workers\.dev/],
			["no subdomain", cloudflare(), /has no workers\.dev subdomain/],
			["foreign Worker", cloudflare({ subdomain: "synthetic-sub", workers: { "am-selfhost": ["FOREIGN_SECRET"] } }),
				/refuse Worker am-selfhost: already exists in this account, and setup has no receipt/],
			["API key login", cloudflare({ subdomain: "synthetic-sub", auth: { type: "api_key", key: "synthetic", email: EMAIL } }), /cannot read the Wrangler login's token/],
		]) {
			const refusedRoot = project({ settings: workersDev }), refused = await go(refusedRoot, other);
			assert.equal(refused.code, 1, label);
			assert.match(refused.out, why, label);
			assert.deepEqual(writes(other), [], label);
			assert.equal(fs.existsSync(path.join(refusedRoot, CONFIG_FILE)), false, label);
			assert.equal(refused.out.includes(TOKEN), false, label);
		}
	});

	it("reruns without changing anything, and resumes a partial apply", async () => {
		const root = project(), cf = cloudflare();
		assert.equal((await go(root, cf)).code, 0);
		const before = configOf(root), mtime = fs.statSync(path.join(root, CONFIG_FILE)).mtimeMs;
		cf.calls.length = 0;
		const again = await go(root, cf);
		assert.equal(again.code, 0, again.out);
		assert.deepEqual(writes(cf), []);
		assert.equal(again.asked, 0);
		assert.equal(configOf(root), before);
		assert.equal(fs.statSync(path.join(root, CONFIG_FILE)).mtimeMs, mtime);
		assert.match(again.out, /keep {3}Worker secret OWNER_USER_ID \(setup never changes it\)/);

		// A run that created the bucket and then failed on the index: the rerun keeps the bucket by its receipt.
		const root2 = project(), cf2 = cloudflare({ fail: { on: "vectorize create am-selfhost-cards" } });
		assert.equal((await go(root2, cf2)).code, 1);
		cf2.calls.length = 0;
		const resumed = await go(root2, cf2);
		assert.equal(resumed.code, 0, resumed.out);
		assert.match(resumed.out, /keep {3}R2 bucket am-selfhost-ledger/);
		assert.deepEqual(writes(cf2).map((x) => x.args.slice(0, 2).join(" ")), ["vectorize create", "vectorize create-metadata-index", "secret put"]);
	});

	it("refuses names that already exist when this setup did not create them, or that do not match, before any write", async () => {
		for (const existing of [{ buckets: ["am-selfhost-ledger"] }, { workers: { "am-selfhost": [] } },
			{ indexes: [{ name: "am-selfhost-cards", config: { dimensions: 1024, metric: "cosine" } }] }]) {
			const root = project(), cf = cloudflare(existing);
			const r = await go(root, cf);
			assert.equal(r.code, 1, r.out);
			assert.match(r.out, /refuse .*no receipt of creating it[\s\S]*nothing was changed/);
			assert.deepEqual(writes(cf), []);
			assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
		}
		// Even with its own receipt, a mismatched index is never reused or replaced.
		const ours = project(), first = cloudflare();
		await go(ours, first);
		const cf = cloudflare({ buckets: ["am-selfhost-ledger"], workers: { "am-selfhost": ["OWNER_USER_ID"] },
			indexes: [{ name: "am-selfhost-cards", config: { dimensions: 768, metric: "cosine" } }] });
		const r = await go(ours, cf);
		assert.equal(r.code, 1);
		assert.match(r.out, /has 768 dimensions and metric cosine; this source needs 1024, cosine/);
		assert.deepEqual(writes(cf), []);
	});

	it("takes ownership only from receipts of its own successful creates, never from a config", async () => {
		const foreign = { buckets: ["am-selfhost-ledger"], indexes: [{ name: "am-selfhost-cards", config: { dimensions: 1024, metric: "cosine" } }],
			metadata: { "am-selfhost-cards": [{ propertyName: "kind", indexType: "String" }] }, workers: { "am-selfhost": ["FOREIGN_SECRET"] } };
		// A first create that failed and created nothing leaves the config; same-named resources that appear later are not ours.
		const root = project(), cf = cloudflare({ fail: { on: "r2 bucket create" } });
		assert.equal((await go(root, cf)).code, 1);
		assert.ok(fs.existsSync(path.join(root, CONFIG_FILE)));
		Object.assign(cf.state, structuredClone(foreign));
		cf.calls.length = 0;
		const retry = await go(root, cf);
		assert.equal(retry.code, 1, retry.out);
		assert.match(retry.out, /refuse R2 bucket am-selfhost-ledger .*an earlier run started creating it but did not confirm it/);
		assert.match(retry.out, /refuse Worker am-selfhost: already exists in this account, and setup has no receipt of creating it/);
		assert.deepEqual(writes(cf), []);
		assert.deepEqual(cf.state.workers["am-selfhost"], ["FOREIGN_SECRET"]);
		// An exact copy of the generated config proves nothing either.
		const copied = project(), cf2 = cloudflare(structuredClone(foreign));
		fs.writeFileSync(path.join(copied, CONFIG_FILE), configOf(root));
		const r2 = await go(copied, cf2);
		assert.equal(r2.code, 1, r2.out);
		assert.deepEqual(writes(cf2), []);
		// Cloudflare created the bucket but setup never saw success (a timeout, or a crash before the receipt): uncertain, so refused.
		const root3 = project(), cf3 = cloudflare({ fail: { on: "r2 bucket create", created: true } });
		assert.equal((await go(root3, cf3)).code, 1);
		assert.deepEqual(cf3.state.buckets, ["am-selfhost-ledger"]);
		cf3.calls.length = 0;
		const r3 = await go(root3, cf3);
		assert.equal(r3.code, 1, r3.out);
		assert.match(r3.out, /setup cannot prove it created it/);
		assert.deepEqual(writes(cf3), []);
		// A successful remote create followed by a failed receipt write leaves durable pending intent, never ownership.
		const root4 = project(), cf4 = cloudflare(), rename = fs.renameSync;
		try {
			fs.renameSync = (from, to) => {
				if (to === path.join(root4, RECEIPTS_FILE) && Object.values(JSON.parse(fs.readFileSync(from, "utf8")).resources).includes("created")) {
					throw new Error("synthetic receipt write failure");
				}
				return rename(from, to);
			};
			const failed = await go(root4, cf4);
			assert.equal(failed.code, 1);
			assert.match(failed.out, /cannot durably record creation/);
		} finally { fs.renameSync = rename; }
		assert.deepEqual(cf4.state.buckets, ["am-selfhost-ledger"]);
		assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(root4, RECEIPTS_FILE), "utf8")).resources), ["pending"]);
		assert.equal(fs.readdirSync(root4).some((f) => f.endsWith(".tmp")), false);
		cf4.calls.length = 0;
		assert.equal((await go(root4, cf4)).code, 1);
		assert.deepEqual(writes(cf4), []);
		// An unconfirmed Worker draft must also be refused, even if its owner secret is missing.
		const root5 = project(), cf5 = cloudflare({ fail: { on: "secret put", created: true } });
		assert.equal((await go(root5, cf5)).code, 1);
		cf5.state.workers["am-selfhost"] = ["FOREIGN_SECRET"];
		cf5.calls.length = 0;
		assert.equal((await go(root5, cf5)).code, 1);
		assert.deepEqual(writes(cf5), []);
		// Successful receipts are scoped to the verified account, and unreadable receipts never become empty proof.
		const root6 = project(), cf6 = cloudflare();
		assert.equal((await go(root6, cf6)).code, 0);
		const receiptPath = path.join(root6, RECEIPTS_FILE), original = fs.readFileSync(receiptPath, "utf8");
		fs.writeFileSync(receiptPath, original.replaceAll(ACCOUNT, OTHER));
		cf6.calls.length = 0;
		assert.equal((await go(root6, cf6)).code, 1);
		assert.deepEqual(writes(cf6), []);
		fs.writeFileSync(receiptPath, "{invalid");
		cf6.calls.length = 0;
		assert.equal((await go(root6, cf6)).code, 1);
		assert.deepEqual(cf6.calls, []);
	});

	it("reads the owner id in a real terminal without echoing it, and cancels cleanly", { skip: !PYTHON_PTY && "needs python3 with pty" }, () => {
		const harness = path.join(tmp, "pty-harness.mjs");
		fs.writeFileSync(harness, PTY_HARNESS);
		const term = (keys) => {
			const root = project({ settings: { ...SETTINGS, embeddings: "off" } }), result = path.join(tmp, `pty-${n}.json`);
			const r = spawnSync("python3", ["-I", "-c", PTY_DRIVER, process.execPath, harness, pathToFileURL(path.resolve(import.meta.dirname, "setup.mjs")).href, root, result, keys],
				{ encoding: "utf8", timeout: 60_000 });
			const out = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : { code: null };
			assert.equal(r.status, 0, r.stderr);
			const terminal = JSON.parse(r.stdout);
			assert.equal(terminal.exit, 0);
			assert.equal(terminal.terminalRestored, true, "OS echo and canonical input are restored");
			assert.equal(out.leaks, false, "neither Node output stream wrote the owner id");
			assert.equal(out.paused, true, "the reader releases stdin");
			return { ...out, root, transcript: stripVTControlCharacters(terminal.transcript) };
		};
		const typed = term(`${OWNER}\r`);
		assert.equal(typed.code, 0, typed.transcript);
		assert.match(typed.transcript, /Clerk user id of the owner/);
		assert.equal(typed.transcript.includes("synthetic0wner"), false, "the terminal shows no part of the owner id");
		assert.deepEqual(typed.stdin, [["secret put OWNER_USER_ID", true]]);
		assert.equal(typed.argv.includes("synthetic0wner"), false);
		assert.equal(typed.raw, false, "the terminal leaves raw mode");
		for (const f of fs.readdirSync(typed.root)) if (fs.statSync(path.join(typed.root, f)).isFile()) assert.equal(fs.readFileSync(path.join(typed.root, f), "utf8").includes("synthetic0wner"), false, f);
		for (const keys of ["\x03", "\x04", `${OWNER}\x03`]) {
			const cancelled = term(keys);
			assert.equal(cancelled.code, 1, cancelled.transcript);
			assert.match(cancelled.transcript, /no owner id was entered; nothing was changed/);
			assert.deepEqual(cancelled.writes, []);
			assert.equal(fs.existsSync(path.join(cancelled.root, CONFIG_FILE)), false);
			assert.equal(cancelled.raw, false);
			assert.equal(fs.existsSync(path.join(cancelled.root, "agent-memory.setup.lock")), false);
		}
	});

	it("serializes overlapping applies before inspection and the default owner prompt", { skip: !PYTHON_PTY && "needs python3 with pty" }, async () => {
		const root = project({ settings: { ...SETTINGS, embeddings: "off" } });
		const cf = cloudflare({ fail: { on: "secret put" } });
		assert.equal((await go(root, cf)).code, 1, "legitimate partial setup, with a created bucket and absent Worker");
		const harness = path.join(tmp, "overlap-harness.mjs"), stateFile = path.join(root, "synthetic-state.json");
		fs.writeFileSync(harness, PTY_HARNESS);
		fs.writeFileSync(stateFile, JSON.stringify(cf.state));
		const r = spawnSync("python3", ["-I", "-c", OVERLAP_DRIVER, process.execPath, harness,
			pathToFileURL(path.join(import.meta.dirname, "setup.mjs")).href, root, stateFile], { encoding: "utf8", timeout: 45_000 });
		assert.equal(r.status, 0, r.stderr);
		const { results: [first, second, late], ownerKept, restored } = JSON.parse(r.stdout);
		assert.equal(first.code, 0);
		assert.equal(second.code, 1, "a competing apply must refuse, rather than overwrite the first owner's secret");
		assert.equal(second.calls, 0, "the competing apply must not inspect even the account");
		assert.deepEqual(second.writes, []);
		assert.equal(ownerKept, true);
		assert.equal(late.code, 0);
		assert.deepEqual(late.writes, [], "a later retry reads current state and keeps the owner secret");
		assert.equal(fs.existsSync(path.join(root, "agent-memory.setup.lock")), false);
		assert.deepEqual(restored, [true, true, true]);
		for (const result of [first, second, late]) {
			assert.equal(result.leaks, false);
			assert.equal(result.raw, false);
		}
	});

	it("refuses an existing apply lock without inspecting or reclaiming it", async () => {
		const root = project(), cf = cloudflare(), lock = path.join(root, "agent-memory.setup.lock");
		const foreign = '{"pid":2147483647,"note":"not this invocation"}';
		fs.writeFileSync(lock, foreign);
		const r = await go(root, cf);
		assert.equal(r.code, 1);
		assert.match(r.out, /another setup apply holds/);
		assert.deepEqual(cf.calls, []);
		assert.equal(fs.readFileSync(lock, "utf8"), foreign, "neither PID liveness nor file contents permit stealing the lock");
		assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false);
		// Simulate a foreign replacement immediately before completion: cleanup must not unlink that different file.
		const root2 = project(), cf2 = cloudflare(), lock2 = path.join(root2, "agent-memory.setup.lock");
		const code = await setup({ root: root2, argv: ["--apply"], readOwnerId: async () => OWNER, log: () => {}, wrangler(args, input) {
			const result = cf2.run(args, input);
			if (args[0] === "secret" && args[1] === "put") {
				fs.unlinkSync(lock2);
				fs.writeFileSync(lock2, foreign);
			}
			return result;
		} });
		assert.equal(code, 0);
		assert.equal(fs.readFileSync(lock2, "utf8"), foreign);
	});

	it("refuses another Wrangler config before calling Wrangler, and leaves it untouched", async () => {
		for (const name of [CONFIG_FILE, "wrangler.toml", "wrangler.json"]) {
			const root = project(), cf = cloudflare();
			fs.writeFileSync(path.join(root, name), "// someone else's config\n{}\n");
			const r = await go(root, cf);
			assert.equal(r.code, 1);
			assert.match(r.out, /Setup never overwrites or edits a Wrangler config/);
			assert.deepEqual(cf.calls, []);
			assert.equal(fs.readFileSync(path.join(root, name), "utf8"), "// someone else's config\n{}\n");
		}
	});

	it("refuses unsafe or incoherent settings before calling Wrangler", async () => {
		const bad = {
			"http://memory.selfhost-synthetic.dev": { public_url: "http://memory.selfhost-synthetic.dev" },
			"a path": { public_url: "https://memory.selfhost-synthetic.dev/mcp" },
			"a port": { public_url: "https://memory.selfhost-synthetic.dev:8443" },
			"credentials": { public_url: "https://u:p@memory.selfhost-synthetic.dev" },
			"an IP": { public_url: "https://203.0.113.7" },
			"a placeholder": { public_url: "https://memory.example.com" },
			"localhost": { public_url: "https://localhost" },
			"issuer mismatch": { clerk_issuer: "https://other.selfhost-synthetic.dev" },
			"same host as Clerk": { public_url: "https://clerk.selfhost-synthetic.dev" },
			"not a key": { clerk_publishable_key: "sk_live_secret" },
			"routing to me": { routing: ["github.com/x/*=me"] },
			"routing to an unknown profile": { routing: ["github.com/x/*=team"] },
			"a comma in a rule": { routing: ["github.com/x/*,y=work"] },
			"a relative path rule": { routing: ["path:work=work"] },
			"an unknown key": { backup_key: "x" },
			"a bad account": { account_id: "my-account" },
			"a bad worker name": { worker: "Agent_Memory" },
			"embeddings maybe": { embeddings: "maybe" },
			"another Worker's workers.dev URL": { public_url: "https://other-worker.synthetic-sub.workers.dev" },
			"a workers.dev account root": { public_url: "https://synthetic-sub.workers.dev" },
			"the workers.dev apex": { public_url: "https://workers.dev" },
			"a nested workers.dev host": { public_url: "https://x.am-selfhost.synthetic-sub.workers.dev" },
		};
		for (const [label, change] of Object.entries(bad)) {
			const root = project({ settings: { ...SETTINGS, ...change } }), cf = cloudflare();
			const r = await go(root, cf);
			assert.equal(r.code, 1, label);
			assert.match(r.out, /setup refused: the settings in .* are not usable/, label);
			assert.deepEqual(cf.calls, [], label);
			assert.equal(fs.existsSync(path.join(root, CONFIG_FILE)), false, label);
		}
		const missing = { ...SETTINGS };
		delete missing.corpus;
		assert.deepEqual(check(missing, WORKER_TS).errors, ["missing setting corpus"]);
		const notJson = await go(project({ settings: "{ not json" }), cloudflare());
		assert.equal(notJson.code, 1);
	});

	it("refuses a missing login, an account the login cannot use, and an invalid owner id, before any write", async () => {
		const out = await go(project(), cloudflare({ loggedIn: false }));
		assert.equal(out.code, 1);
		assert.match(out.out, /Run `npx wrangler login` yourself.*Setup does not log in or ask for broader access/s);
		const root = project(), cf = cloudflare({ accounts: [OTHER] });
		const other = await go(root, cf);
		assert.equal(other.code, 1);
		assert.match(other.out, new RegExp(`account_id ${ACCOUNT} is not an account this Cloudflare login can use \\(it can use: ${OTHER}\\)`));
		assert.equal(other.out.includes(EMAIL), false);
		assert.deepEqual(cf.calls.map((x) => x.args[0]), ["whoami"]);
		const root2 = project(), cf2 = cloudflare();
		const badOwner = await go(root2, cf2, { owner: "not-an-id" });
		assert.equal(badOwner.code, 1);
		assert.equal(badOwner.out.includes("not-an-id"), false);
		assert.deepEqual(writes(cf2), []);
		assert.equal(fs.existsSync(path.join(root2, CONFIG_FILE)), false);
	});

	it("turns the Paid-only corpus on only when the source exports CorpusStore", async () => {
		const off = await go(project({ settings: { ...SETTINGS, corpus: "on" } }), cloudflare());
		assert.equal(off.code, 1);
		assert.match(off.out, /corpus "on" needs the CorpusStore class exported from src\/worker.ts/);
		const workerTs = `${WORKER_TS}export { CorpusStore } from "./corpus/store";\n`;
		const root = project({ settings: { ...SETTINGS, corpus: "on" }, workerTs }), cf = cloudflare();
		const r = await go(root, cf);
		assert.equal(r.code, 0, r.out);
		const c = jsonc(configOf(root));
		assert.deepEqual(c.durable_objects.bindings.at(-1), { name: "CORPUS_STORE", class_name: "CorpusStore" });
		assert.deepEqual(c.migrations.at(-1), { tag: "v2", new_sqlite_classes: ["CorpusStore"] });
		assert.equal(c.vars.CORPUS, "on");
		// An integrated source with the corpus off names the flag but binds no class.
		const offInt = jsonc(render({ ...SETTINGS, corpus: "off" }, { ...check(SETTINGS, workerTs).values }));
		assert.equal(offInt.vars.CORPUS, "off");
		assert.equal(offInt.durable_objects.bindings.length, 2);
	});

	it("ships a generic example config and source with no owner endpoints, matching the server's profiles", () => {
		const repo = path.resolve(import.meta.dirname, "..");
		const example = { ...SETTINGS, account_id: "0123456789abcdef0123456789abcdef", worker: "agent-memory", public_url: "https://memory.example.com",
			clerk_issuer: "https://clerk.example.com", clerk_publishable_key: pk("clerk.example.com"), routing: ["github.com/your-org/*=work", "github.com/your-user/*=personal"] };
		const text = fs.readFileSync(path.join(repo, "wrangler.example.jsonc"), "utf8");
		assert.equal(text, render(example, { frontend: "https://clerk.example.com", host: "memory.example.com", integrated: false }));
		assert.notDeepEqual(check(example, WORKER_TS).errors, [], "placeholder settings must never pass");
		for (const f of ["wrangler.example.jsonc", "local/setup.mjs", "docs/self-host.md"]) {
			assert.doesNotMatch(fs.readFileSync(path.join(repo, f), "utf8"), /wrick17|sequoia|pratyush|user_3L|Y2xlcmsubWVtb3J5|BACKUP_KEY=/i, f);
		}
		const profiles = /export const PROFILES = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(repo, "src", "domain", "types.ts"), "utf8"))[1];
		assert.deepEqual(ROUTABLE, [...profiles.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "me"));
	});

	it("help returns without settings, account inspection or configuration writes", async () => {
		const root = project(), before = fs.readdirSync(root), lines = [];
		for (const flag of ["--help", "-h"]) {
			assert.equal(await setup({ root, argv: [flag], log: (l) => lines.push(l),
				wrangler: () => assert.fail("help must not inspect an account"),
				fetch: () => assert.fail("help must not call the Cloudflare API"),
				readOwnerId: () => assert.fail("help must not request an owner") }), 0);
		}
		assert.deepEqual(fs.readdirSync(root), before);
		assert.match(lines.join("\n"), /--apply/);
	});

	it("stages a locked self-contained package without owner configuration or the unverified capture installer", () => {
		const repo = path.resolve(import.meta.dirname, ".."), stage = path.join(tmp, "package-stage");
		stageSelfHost(repo, stage);
		assert.equal(fs.statSync(stage).mode & 0o777, 0o700);
		for (const entry of fs.readdirSync(stage, { recursive: true, withFileTypes: true })) {
			if (entry.isFile()) assert.equal(fs.statSync(path.join(entry.parentPath, entry.name)).mode & 0o777, 0o644, "every packaged file is public 0644, whatever the umask");
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
		const lock = JSON.parse(fs.readFileSync(path.join(stage, "npm-shrinkwrap.json"), "utf8"));
		const sourceLock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8"));
		assert.equal(manifest.private, true);
		assert.equal(lock.version, manifest.version);
		assert.equal(lock.packages[""].version, manifest.version);
		assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
		assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
		delete lock.version; delete lock.packages[""].version; delete lock.packages[""].engines;
		assert.deepEqual(lock, sourceLock, "packaging preserves the pinned dependency graph");
		assert.deepEqual(manifest.scripts, { setup: "node local/setup.mjs" });
		assert.deepEqual(fs.readdirSync(path.join(stage, "local")).sort(), ["corpus-cli.mjs", "corpus-git.mjs", "corpus-judgment.mjs", "corpus-refresh.mjs", "corpus-scan.mjs", "corpus-upload.mjs", "replay-player.js", "setup.mjs"]);
		assert.deepEqual(manifest.files, ["src", "local/replay-player.js", "local/setup.mjs", "local/corpus-cli.mjs", "local/corpus-git.mjs", "local/corpus-judgment.mjs", "local/corpus-refresh.mjs", "local/corpus-scan.mjs", "local/corpus-upload.mjs", "docs/self-host.md", "wrangler.example.jsonc", "npm-shrinkwrap.json"]);
		for (const file of ["wrangler.jsonc", "agent-memory.setup.json", RECEIPTS_FILE, "agent-memory.setup.lock", ".dev.vars", "research", "test"])
			assert.equal(fs.existsSync(path.join(stage, file)), false, file);
		const readme = fs.readFileSync(path.join(stage, "README.md"), "utf8");
		assert.equal(readme, fs.readFileSync(path.join(stage, "docs/self-host.md"), "utf8"));
		for (const link of readme.matchAll(/\]\(([^)]+)\)/g)) assert.ok(link[1].startsWith("#"), `guide must be self-contained: ${link[1]}`);
		function scan(dir) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) scan(file);
				else assert.doesNotMatch(fs.readFileSync(file, "utf8"), /wrick17|sequoia|pratyush|user_3L|Y2xlcmsubWVtb3J5/i, file);
			}
		}
		scan(stage);
		assert.throws(() => stageSelfHost(repo, stage), /EEXIST/, "never overwrite an existing stage");
	});

});
