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
]];
