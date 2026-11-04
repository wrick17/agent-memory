// AccountStore DDL. v1 is the phase-1 subset of section 5; later phases add wipes, transfers, restores and the review list.
import { DELETED_ROWS, tombstoneTriggers, type Migration } from "../storage";

const pk = (col: string) => (r: "OLD" | "NEW") => `${r}.${col}`;
const KEYS = { profiles: "name", generations: "id", devices: "id", routing_rules: "id", node_index: "node_id", request_index: "request_id", sensitive_terms: "term" };

export const ACCOUNT_MIGRATIONS: Migration[] = [[
	`CREATE TABLE profiles (name TEXT PRIMARY KEY, object_name TEXT NOT NULL, generation TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('active','restoring','wiping','wiped','retired')), created_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	`CREATE TABLE generations (id TEXT PRIMARY KEY, profile TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('live','restore','scratch')),
		state TEXT NOT NULL CHECK (state IN ('reserved','active','retired','wiped')), reserved_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, scopes TEXT NOT NULL, profiles TEXT NOT NULL,
		default_profile TEXT, enabled INTEGER NOT NULL DEFAULT 1, expires_at TEXT,
		created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, seq INTEGER NOT NULL) WITHOUT ROWID`,
	`CREATE TABLE routing_rules (id TEXT PRIMARY KEY, priority INTEGER NOT NULL, match TEXT NOT NULL CHECK (match IN ('remote','path')),
		pattern TEXT NOT NULL, profile TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE TABLE node_index (node_id TEXT PRIMARY KEY, profile TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID",
	`CREATE TABLE request_index (request_id TEXT PRIMARY KEY, profile TEXT NOT NULL, op TEXT NOT NULL, payload_hash TEXT NOT NULL,
		at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE TABLE sensitive_terms (term TEXT PRIMARY KEY, source TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID",
	"CREATE TABLE counters (day TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (day, name)) WITHOUT ROWID",
	...DELETED_ROWS,
	...Object.entries(KEYS).flatMap(([t, col]) => [`CREATE INDEX ${t}_seq ON ${t} (seq, ${col})`, ...tombstoneTriggers("account_meta", t, pk(col))]),
], [
	// v2: a binding imported from BothQ keeps BothQ's operation and request hash; a later call is checked with BothQ's rule.
	"ALTER TABLE request_index ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0",
	// Reserved for a record still being imported: every ordinary call with the id gets busy until its record is published.
	"ALTER TABLE request_index ADD COLUMN pending INTEGER NOT NULL DEFAULT 0",
], [
	// v3 (phase 3, docs/module-contracts.md): the account's transfer ledger and its record of wipes (sections 5 and 9).
	`CREATE TABLE transfers (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, from_profile TEXT NOT NULL, to_profile TEXT NOT NULL,
		state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, seq INTEGER NOT NULL) WITHOUT ROWID`,
	`CREATE TABLE wipes (profile TEXT NOT NULL, generations TEXT NOT NULL, wiped_at TEXT NOT NULL, node_count INTEGER NOT NULL,
		marker_key TEXT NOT NULL, report TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (profile, wiped_at)) WITHOUT ROWID`,
	"CREATE INDEX transfers_seq ON transfers (seq, id)",
	"CREATE INDEX wipes_seq ON wipes (seq, profile, wiped_at)",
	...tombstoneTriggers("account_meta", "transfers", pk("id")),
	...tombstoneTriggers("account_meta", "wipes", (r) => `json_array(${r}.profile, ${r}.wiped_at)`),
], [
	// v4: accepted C3 policy and a wakeup survive a crash before the source fence exists.
	"ALTER TABLE transfers ADD COLUMN intent TEXT",
	"ALTER TABLE transfers ADD COLUMN retry_at INTEGER",
	"CREATE INDEX transfers_retry ON transfers (retry_at) WHERE retry_at IS NOT NULL",
], [
	// v5 (account/refresh.ts): the permanent daily refresh day ledger. A row is never deleted; its open states are the profile's one
	// open claim. Receipts are the canonical control proofs; nothing here names an item, a payload or a query.
	`CREATE TABLE refresh_days (profile TEXT NOT NULL, day TEXT NOT NULL, claim_id TEXT NOT NULL, device_id TEXT NOT NULL, generation TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('claiming','pending','done','failed','abandoned')), reason TEXT,
		claim_receipt TEXT NOT NULL, plan_receipt TEXT, finish_receipt TEXT, created_at TEXT NOT NULL, closed_at TEXT, seq INTEGER NOT NULL,
		PRIMARY KEY (profile, day)) WITHOUT ROWID`,
	"CREATE UNIQUE INDEX refresh_days_open ON refresh_days (profile) WHERE state IN ('claiming','pending')",
], [
	// v6 (section 15 Review): the owner's review list. A migrated record waiting for a profile (metadata and its exact plan --routes
	// binding, never content) or a move a collision refused. `profile` is the metadata's origin (a collision's destination); a wipe of
	// that origin clears the payload and leaves the row `wiped` (wipe.ts scrubReview). Rows are never deleted; a decision only records a choice.
	`CREATE TABLE review_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('migration','collision')), profile TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('open','assigned','resolved','wiped')), payload TEXT NOT NULL, decision TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX review_items_seq ON review_items (seq, id)",
	...tombstoneTriggers("account_meta", "review_items", pk("id")),
], [
	// v7 (v2 plan, MG0): content-free scores and status. eval_runs is one eval run's scores; client_status is each device's latest
	// capture report; health is the cron sweep's latest state per check and subject. None holds memory content or a query.
	// Export and checkpoint carry them as ordinary tables. Restore: see account/store.ts MERGED (eval_runs only grows).
	`CREATE TABLE eval_runs (id TEXT PRIMARY KEY, profile TEXT NOT NULL, at TEXT NOT NULL, channels TEXT NOT NULL, k INTEGER NOT NULL,
		cases INTEGER NOT NULL, recall_all_at_k REAL NOT NULL, any_hit_at_k REAL NOT NULL, mrr REAL NOT NULL, device_id TEXT NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX eval_runs_at ON eval_runs (profile, at)",
	"CREATE TABLE client_status (device_id TEXT PRIMARY KEY, reported_at TEXT NOT NULL, body TEXT NOT NULL CHECK (json_valid(body))) WITHOUT ROWID",
	`CREATE TABLE health (check_id TEXT NOT NULL, subject TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('ok','warn','fail')),
		detail TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (check_id, subject)) WITHOUT ROWID`,
]];
