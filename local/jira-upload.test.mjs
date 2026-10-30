import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIELDS, JIRA_ACCOUNT, uploadTickets } from "./jira-upload.mjs";

const OWNER = "712020:owner-0001", OTHER = "5b10ac8d82e05b22cc7d4ef5";
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-synthetic-jira-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "private-state", "tickets.json");
}
const person = (accountId) => ({ accountId, displayName: "Private Person", emailAddress: "private@example.com", timeZone: "Asia/Kolkata" });
const BLOCKS = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const issue = (key, fields = {}) => ({ key, id: "10001", self: "https://jira.invalid/rest/api/3/issue/10001", fields: { summary: `Summary ${key}`, issuetype: { name: "Task" },
	status: { name: "To Do", statusCategory: { key: "new" } }, priority: null, duedate: null, assignee: null, reporter: person(OTHER), updated: "2026-10-30T04:00:00.000+0000", issuelinks: [], ...fields } });
const connectorFor = (answer, calls = []) => ({ account: JIRA_ACCOUNT, readOnly: true, read: async (q) => { calls.push(q); return typeof answer === "function" ? answer(q) : JSON.stringify(answer); } });
const receipt = (body) => ({ profile: "work", tickets: body.tickets.map((t) => ({ key: `jira:${t.key}`, status: "stored", updated_at: t.updated_at })) });

test("maps Jira's REST fields to bounded snapshots: kinds, states, owner, link direction from each side, honest unknowns, nothing personal", async (t) => {
	const stateFile = fixture(t), calls = [];
	const issues = [
		issue("SEQ-1", { summary: "Fix login for bob@example.com token=hunter2secret", issuetype: { name: "Story" }, assignee: person(OWNER), reporter: { displayName: "No Id" },
			updated: "2026-10-30T10:00:00.000+0530", issuelinks: [{ type: BLOCKS, inwardIssue: { key: "SEQ-2" } }, { type: BLOCKS, outwardIssue: { key: "SEQ-3" } },
				{ type: { name: "Cloners", inward: "is cloned by", outward: "clones" }, inwardIssue: { key: "SEQ-4" } }, { inwardIssue: { key: "SEQ-7" } }] }),
		issue("SEQ-2", { issuetype: { name: "Epic" }, status: { name: "Done", statusCategory: { key: "done" } }, priority: { name: "Low" }, duedate: "2026-11-03", issuelinks: undefined }),
		issue("SEQ-3", { issuetype: undefined }),
		issue("SEQ-5", { issuetype: { name: "Bug" }, status: { name: "Odd" }, priority: undefined, duedate: "2026-02-30", assignee: { accountId: "bad@example.com" } }),
	];
	let body;
	const out = await uploadTickets({ keys: ["SEQ-1", "SEQ-2", "SEQ-3", "SEQ-5", "SEQ-6"], stateFile, connector: connectorFor({ issues }, calls), ownerAccountId: OWNER,
		now: () => "2026-10-30T05:00:00.000Z", send: async (b) => { body = b; return receipt(b); } });
	assert.deepEqual(out, { status: "acknowledged", tickets: 3, incomplete: ["jira:SEQ-1", "jira:SEQ-2", "jira:SEQ-5"], missing: ["SEQ-6"], invalid: ["SEQ-3"] });
	assert.deepEqual(calls, [{ keys: ["SEQ-1", "SEQ-2", "SEQ-3", "SEQ-5", "SEQ-6"], fields: FIELDS }]);
	assert.deepEqual(body, { profile: "work", as_of: "2026-10-30T05:00:00.000Z", tickets: [
		{ key: "SEQ-1", kind: "feature", type: "Story", title: "Fix login for [REDACTED] token=[REDACTED]", updated_at: "2026-10-30T04:30:00.000Z", state: "open", status: "To Do",
			assignee: OWNER, assignee_is_owner: true, blocked_by: ["SEQ-2"], blocks: ["SEQ-3"], related: ["SEQ-4"], unknown: ["issuelinks", "reporter"] },
		{ key: "SEQ-2", kind: "feature", type: "Epic", title: "Summary SEQ-2", updated_at: "2026-10-30T04:00:00.000Z", state: "closed", status: "Done", priority: "Low", due: "2026-11-03",
			assignee_is_owner: false, reporter: OTHER, blocked_by: [], blocks: [], related: [], unknown: ["issuelinks"] },
		{ key: "SEQ-5", kind: "bug", type: "Bug", title: "Summary SEQ-5", updated_at: "2026-10-30T04:00:00.000Z", reporter: OTHER, blocked_by: [], blocks: [], related: [],
			unknown: ["assignee", "due", "priority", "status"] },
	] });
	assert.doesNotMatch(JSON.stringify(body) + fs.readFileSync(stateFile, "utf8"), /example\.com|hunter2|Private Person|Asia|jira\.invalid|No Id/);
});

test("keeps the exact pending body across a lost response and a refusal, sends nothing new until it is held, and skips unchanged snapshots", async (t) => {
	const stateFile = fixture(t), calls = [], sent = [];
	const connector = connectorFor({ issues: [issue("SEQ-1"), issue("SEQ-2", { updated: "2026-10-30T04:05:00.000Z" })] }, calls);
	const options = { keys: ["SEQ-1", "SEQ-2"], stateFile, connector, ownerAccountId: OWNER, now: () => "2026-10-30T05:00:00.000Z" };
	assert.deepEqual(await uploadTickets({ ...options, send: async (b) => { sent.push(JSON.stringify(b)); throw new Error("response lost"); } }),
		{ status: "pending", reason: "upload_failed", incomplete: [], missing: [], invalid: [] });
	const kept = fs.readFileSync(stateFile, "utf8");
	assert.equal(JSON.parse(kept).pending.body, sent[0]);
	assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
	assert.deepEqual(await uploadTickets({ ...options, send: async (b) => { sent.push(JSON.stringify(b)); return { ...receipt(b), tickets: [] }; } }), { status: "pending", reason: "not_acknowledged" });
	assert.equal(sent[1], sent[0]);
	assert.equal(fs.readFileSync(stateFile, "utf8"), kept);
	assert.equal(calls.length, 1, "no new read while a request is pending");
	assert.deepEqual(await uploadTickets({ ...options, send: async (b) => { sent.push(JSON.stringify(b)); return receipt(b); } }),
		{ status: "acknowledged", tickets: 0, incomplete: [], missing: [], invalid: [] });
	assert.deepEqual([sent[2], sent.length], [sent[0], 3]);
	assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { profile: "work", incomplete: [], recent: ["SEQ-1@2026-10-30T04:00:00.000Z", "SEQ-2@2026-10-30T04:05:00.000Z"] });
	// Only a changed snapshot goes out again.
	const changed = connectorFor({ issues: [issue("SEQ-1"), issue("SEQ-2", { updated: "2026-10-30T04:20:00.000Z", status: { name: "Done", statusCategory: { key: "done" } } })] });
	assert.equal((await uploadTickets({ ...options, connector: changed, send: async (b) => { sent.push(JSON.stringify(b)); return receipt(b); } })).tickets, 1);
	assert.deepEqual(JSON.parse(sent.at(-1)).tickets.map((x) => [x.key, x.state]), [["SEQ-2", "closed"]]);
});

test("refuses an unbound connector, an unnamed owner, bad keys or state, and answers it cannot trust, before any upload", async (t) => {
	const stateFile = fixture(t);
	let sends = 0;
	const send = async (b) => { sends++; return receipt(b); };
	const base = { keys: ["SEQ-1"], stateFile, ownerAccountId: OWNER, send, connector: connectorFor({ issues: [issue("SEQ-1")] }) };
	for (const [options, reason] of [
		[{ connector: { ...base.connector, account: "~/.plaude" } }, /jira_connector_unbound/], [{ connector: { ...base.connector, readOnly: false } }, /jira_connector_unbound/],
		[{ ownerAccountId: undefined }, /owner_account_required/], [{ ownerAccountId: "owner@example.com" }, /owner_account_required/],
		[{ keys: ["seq-1"] }, /invalid_ticket_keys/], [{ keys: ["SEQ-1", "SEQ-1"] }, /invalid_ticket_keys/], [{ keys: Array.from({ length: 21 }, (_, i) => `SEQ-${i + 1}`) }, /invalid_ticket_keys/],
		[{ connector: connectorFor(() => { throw new Error("connector offline"); }) }, /jira_connector_unavailable/], [{ connector: connectorFor(() => "not json") }, /invalid_jira_metadata/],
		[{ connector: connectorFor({ issues: [issue("SEQ-9")] }) }, /invalid_jira_metadata/], [{ connector: connectorFor({ issues: [issue("SEQ-1"), issue("SEQ-1")] }) }, /invalid_jira_metadata/],
		[{ connector: connectorFor({ tickets: [] }) }, /invalid_jira_metadata/],
	]) await assert.rejects(uploadTickets({ ...base, ...options }), reason);
	assert.equal(fs.existsSync(stateFile), false);
	fs.mkdirSync(path.dirname(stateFile));
	for (const bytes of ["{", JSON.stringify({ profile: "personal" }), JSON.stringify({ profile: "work", pending: { body: 1 } })]) {
		fs.writeFileSync(stateFile, bytes);
		await assert.rejects(uploadTickets(base), /invalid_ticket_state/);
		assert.equal(fs.readFileSync(stateFile, "utf8"), bytes);
	}
	assert.equal(sends, 0);
});


test("retries an incomplete Jira revision even when its key is absent from later input", async(t)=>{
 const stateFile=fixture(t), sent=[], issues=[issue("SEQ-1",{assignee:undefined})];
 const connector=connectorFor(q=>JSON.stringify({issues:issues.filter(i=>q.keys.includes(i.key))}));
 const options={stateFile,connector,ownerAccountId:OWNER,send:async b=>{sent.push(b);return receipt(b)}};
 assert.deepEqual((await uploadTickets({...options,keys:["SEQ-1"]})).incomplete,["jira:SEQ-1"]);
 issues[0]=issue("SEQ-1",{assignee:person(OWNER)});
 await uploadTickets({...options,keys:["SEQ-2"]});
 assert.ok(sent.some(b=>b.tickets.some(t=>t.assignee===OWNER)),"incomplete keys must remain eligible without a new mention");
});
