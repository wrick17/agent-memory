import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountFor, uploadPRs } from "./pr-upload.mjs";

const REPO = "syntheticorg/web";
const T0 = Date.parse("2026-10-30T00:00:00.000Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-synthetic-pr-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "private-state", "prs.json");
}
const row = (number, min, extra = {}) => ({ number, title: `PR ${number}`, state: "OPEN", author: { login: "A-Lee", is_bot: false }, updatedAt: at(min), headRefName: `b-${number}`,
	reviews: [], commits: [], closingIssuesReferences: [], reviewRequests: [], ...extra });
/** gh as GitHub search answers it: the updated window, oldest first with ties in no promised order, at most --limit rows. */
function stubGh(rows, account = "wrick17") {
	const calls = [];
	return { calls, account, run: async (args) => {
		calls.push(args);
		if(args[0]==="api") {
   const query=args.find(a=>a.startsWith("query="));
   assert.doesNotMatch(query,/\b(body|messageBody|messageHeadline|email|displayName|name)\b(?=[\s}])/);
   const q=args.find(a=>a.startsWith("q="));
   const selected=q?(()=>{const [,from,to]=/updated:(\S+)\.\.(\S+) sort:updated-asc/.exec(q);return rows.filter(r=>r.updatedAt>=from&&r.updatedAt<=to).sort((x,y)=>x.updatedAt.localeCompare(y.updatedAt)||y.number-x.number).slice(0,50)})():rows.filter(r=>r.number===Number(args.find(a=>a.startsWith("number=")).slice(7)));
   const nodes=selected.map(graphqlRow);
   return JSON.stringify({data:q?{search:{nodes}}:{repository:{pullRequest:nodes[0]??null}}});
  }
  const [, from, to] = /^updated:(\S+)\.\.(\S+) sort:updated-asc$/.exec(args[args.indexOf("--search") + 1]);
		const limit = Number(args[args.indexOf("--limit") + 1]);
		const inside = rows.filter((r) => r.updatedAt >= from && r.updatedAt <= to);
		return JSON.stringify(inside.sort((x, y) => x.updatedAt.localeCompare(y.updatedAt) || y.number - x.number).slice(0, limit));
	} };
}
const graphqlRow=r=>({...r,repository:{nameWithOwner:REPO},author:r.author?{...r.author,__typename:r.author.is_bot?"Bot":"User"}:null,
 ...Object.fromEntries(["reviews","commits","closingIssuesReferences","reviewRequests"].map(f=>[f,{nodes:Array.isArray(r[f])?r[f].map(v=>f==="commits"?{commit:v}:f==="reviewRequests"?{requestedReviewer:v}:v):null,pageInfo:{hasNextPage:false}}]))});
const receipt = (body) => ({ profile: body.profile, prs: body.prs.map((p) => ({ key: `github:${REPO}#${p.number}`, status: "stored", updated_at: p.updated_at })) });

test("pages a window past gh's page size with a tied boundary, replays exact bytes, and moves the cursor only after the last page", async (t) => {
	const stateFile = fixture(t), rows = [];
	for (let i = 1; i <= 120; i++) rows.push(row(i, i < 49 ? i : i < 53 ? 49 : i));
	const gh = stubGh(rows), sent = [], seen = [];
	let clock = at(125), fault, cursor;
	const options = { repo: REPO, profile: "test", since: at(0), stateFile, gh, ownerLogin: "owner", now: () => clock };
	const send = async (body) => {
		const kept = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		assert.ok(kept.pending.requests.includes(JSON.stringify(body)), "bytes are kept before they are sent");
		assert.equal(kept.cursor, cursor, "the cursor moves only after a whole window");
		assert.ok(body.prs.length <= 25);
		sent.push(JSON.stringify(body));
		if (fault === "lost") throw new Error("response lost");
		if (fault === "refused") return { ...receipt(body), prs: [] };
		seen.push(...body.prs.map((p) => p.number));
		return receipt(body);
	};
	assert.deepEqual(await uploadPRs({ ...options, send }), { status: "pending", reason: "more_prs" });
	assert.equal(seen.length, 50);
	fault = "lost";
	assert.equal((await uploadPRs({ ...options, send })).reason, "upload_failed");
	const lost = sent.at(-1), kept = fs.readFileSync(stateFile, "utf8");
	fault = "refused";
	assert.equal((await uploadPRs({ ...options, send })).reason, "not_acknowledged");
	assert.equal(sent.at(-1), lost);
	assert.equal(fs.readFileSync(stateFile, "utf8"), kept);
	fault = undefined;
	clock = at(400);
	let out;
	while ((out = await uploadPRs({ ...options, send })).status === "pending") assert.equal(out.reason, "more_prs");
	assert.deepEqual(out, { status: "acknowledged", prs: 120, incomplete: [] });
	assert.deepEqual([...seen].sort((x, y) => x - y), rows.map((r) => r.number));
	assert.equal(sent.filter((b) => b === lost).length, 3);
	// Every page asked gh for an explicit bounded window inside the frozen [since, first run's now].
	assert.ok(gh.calls.every((c) => c[0]==="api" && c.find(a=>a.startsWith("query=")).includes("first:50") && c.find(a=>a.startsWith("q=")).endsWith(`..${at(125)} sort:updated-asc`)));
	const done = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	assert.equal(done.cursor, new Date(Date.parse(at(125)) - 15 * 60_000).toISOString());
	assert.equal(done.pending, undefined);
	// The next run looks back 15 minutes for search lag and clock skew; receipts it holds are not sent again.
	assert.deepEqual(done.recent, rows.filter((r) => r.number >= 110).map((r) => `${r.number}@${new Date(r.updatedAt).toISOString()}`));
	cursor = done.cursor;
	rows.push(row(7, 300, { title: "PR 7 again" }));
	rows.splice(6, 1);
	sent.length = 0;
	assert.deepEqual(await uploadPRs({ ...options, send }), { status: "acknowledged", prs: 1, incomplete: [] });
	assert.deepEqual(sent.map((b) => JSON.parse(b).prs.map((p) => [p.number, p.updated_at])), [[[7, new Date(at(300)).toISOString()]]]);
});

test("keeps only structured, validated fields, names what gh could not supply, and redacts text", async (t) => {
	const stateFile = fixture(t), sha = (i) => i.toString(16).padStart(40, "a");
	const rows = [row(1, 5, { title: "Fix WU-1 for bob@example.com token=hunter2secret", state: "MERGED", author: { login: "dependabot", is_bot: true },
		reviews: [{ author: { login: "Bob" }, state: "APPROVED", body: "private review text" }, { author: { login: "Carol" }, state: "PENDING" }],
		commits: [{ oid: sha(1).toUpperCase() }], closingIssuesReferences: [{ number: 4, url: "https://github.com/SyntheticOrg/Web/issues/4" }],
		reviewRequests: [{ __typename: "User", login: "Owner" }, { __typename: "Team", name: "core", slug: "core" }] }),
	row(2, 6, { author: null, reviews: [{ state: "APPROVED" }], commits: Array.from({ length: 100 }, (_, i) => ({ oid: sha(i + 2) })),
		closingIssuesReferences: [{ number: 5, url: "https://github.com/SyntheticOrg/Web/issues/6" }], reviewRequests: [{ __typename: "Mystery" }] })];
	let body;
	const out = await uploadPRs({ repo: REPO, profile: "test", since: at(0), stateFile, gh: stubGh(rows), ownerLogin: "OWNER", now: () => at(10),
		send: async (b) => { body = b; return receipt(b); } });
	assert.deepEqual(out, { status: "acknowledged", prs: 2, incomplete: [`github:${REPO}#2`] });
	assert.equal(body.as_of, new Date(at(10)).toISOString());
	assert.deepEqual(body.prs[0], { number: 1, title: "Fix WU-1 for [REDACTED] token=[REDACTED]", state: "closed", updated_at: new Date(at(5)).toISOString(), head: "b-1",
		reviewers: ["bob"], commits: [sha(1)], closes: ["github:syntheticorg/web#4"], unknown: [], review_requested_from_owner: true });
	assert.deepEqual({ ...body.prs[1], commits: body.prs[1].commits.length }, { number: 2, title: "PR 2", state: "open", updated_at: new Date(at(6)).toISOString(), head: "b-2",
		reviewers: [], commits: 100, closes: [], unknown: ["author", "closingIssuesReferences", "commits", "reviewRequests", "reviews"] });
	assert.doesNotMatch(JSON.stringify(body) + fs.readFileSync(stateFile, "utf8"), /example\.com|hunter2|private review|dependabot|core/);
});

test("refuses unbound accounts, unnamed owners, foreign or corrupt state, and pages it cannot follow without loss, before any upload", async (t) => {
	const stateFile = fixture(t), rows = [row(1, 5)];
	let sends = 0;
	const send = async (b) => { sends++; return receipt(b); };
	const base = { repo: REPO, profile: "test", since: at(0), stateFile, ownerLogin: "owner", now: () => at(100), send };
	assert.equal(accountFor("sequoia-engineering/web"), "pratyush-poddar_seq");
	assert.equal(accountFor(REPO), "wrick17");
	const gh = stubGh(rows);
	await assert.rejects(uploadPRs({ ...base, repo: "sequoia-engineering/web", gh }), /gh_account_mismatch/);
	await assert.rejects(uploadPRs({ ...base, gh: { run: gh.run } }), /gh_account_mismatch/);
	await assert.rejects(uploadPRs({ ...base, gh, ownerLogin: undefined }), /owner_login_required/);
	await assert.rejects(uploadPRs({ ...base, gh, profile: "me" }), /invalid_profile/);
	fs.mkdirSync(path.dirname(stateFile));
	for (const [bytes, reason] of [["{", /invalid_pr_state/], [JSON.stringify({ repo: "other/repo", profile: "test" }), /pr_state_context/],
		[JSON.stringify({ repo: REPO, profile: "test", pending: { from: at(0), to: at(1), at: at(0), requests: [1], sent: 0, total: 0, held: [], incomplete: [] } }), /invalid_pr_state/]]) {
		fs.writeFileSync(stateFile, bytes);
		await assert.rejects(uploadPRs({ ...base, gh }), reason);
		assert.equal(fs.readFileSync(stateFile, "utf8"), bytes);
	}
	assert.equal(gh.calls.length, 0);
	fs.rmSync(stateFile);
	const full = (rowsAt) => ({ account: "wrick17", run: async () => JSON.stringify({data:{search:{nodes:rowsAt.map(graphqlRow)}}}) });
	const tied = Array.from({ length: 50 }, (_, i) => row(i + 1, 0));
	await assert.rejects(uploadPRs({ ...base, gh: full(tied) }), /pr_collection_limit/);
	await assert.rejects(uploadPRs({ ...base, gh: full(Array.from({ length: 50 }, (_, i) => row(i + 1, 50 - i))) }), /pr_order_unverified/);
	await assert.rejects(uploadPRs({ ...base, gh: { account: "wrick17", run: async () => { throw new Error("offline"); } } }), /pr_collection_unavailable/);
	await assert.rejects(uploadPRs({ ...base, gh: full([row(1, 5), row(1, 5)]) }), /duplicate_pr_metadata/);
	await assert.rejects(uploadPRs({ ...base, gh: { account: "wrick17", run: async () => "not json" } }), /invalid_pr_metadata/);
	assert.equal(fs.existsSync(stateFile), false);
	assert.equal(sends, 0);
});


test("retries incomplete PRs at the same revision beyond the lookback and keeps missing retries visible", async (t) => {
 const stateFile=fixture(t), rows=[row(1,5,{reviews:null})], gh=stubGh(rows), sent=[];
 let clock=at(10);
 const options={repo:REPO,profile:"test",since:at(0),stateFile,gh,ownerLogin:"owner",now:()=>clock,send:async b=>{sent.push(b);return receipt(b)}};
 assert.deepEqual((await uploadPRs(options)).incomplete,[`github:${REPO}#1`]);
 clock=at(50);await uploadPRs(options);
 clock=at(90);assert.deepEqual((await uploadPRs(options)).incomplete,[`github:${REPO}#1`]);
 rows[0]=row(1,5,{reviews:[{author:{login:"recovered"},state:"APPROVED"}]});
 clock=at(130);const done=await uploadPRs(options);
 assert.deepEqual(done.incomplete,[]);
 assert.ok(sent.some(b=>b.prs.some(p=>p.reviewers.includes("recovered"))),"same-T completion outside the window must be sent");
});
