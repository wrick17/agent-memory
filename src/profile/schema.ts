// ProfileStore DDL, schema v1 (phase 1): profile_meta, nodes, texts, texts_fts, texts_tri, edges, evidence, revisions,
// requests, activity, cursors, deleted_rows. Capture columns, archive and transfers arrive in later versions (section 5).
import { MEMORY_TYPES, NODE_KINDS, ORIGINS, RELATIONS, STATUSES } from "../domain/types";
import { DELETED_ROWS, tombstoneTriggers, type Migration } from "../storage";

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const KEYS: Record<string, (r: "OLD" | "NEW") => string> = {
	nodes: (r) => `${r}.id`,
	texts: (r) => `CAST(${r}.rowid AS TEXT)`,
	edges: (r) => `CAST(${r}.id AS TEXT)`,
	evidence: (r) => `json_array(${r}.owner, ${r}.kind, ${r}.ref)`,
	revisions: (r) => `json_array(${r}.node_id, ${r}.revision)`,
	requests: (r) => `${r}.request_id`,
	activity: (r) => `CAST(${r}.id AS TEXT)`,
};
const SEQ_KEY: Record<string, string> = { nodes: "id", texts: "rowid", edges: "id", evidence: "owner, kind, ref", revisions: "node_id, revision", requests: "request_id", activity: "id" };

export const PROFILE_MIGRATIONS: Migration[] = [[
	`CREATE TABLE nodes (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN (${list(NODE_KINDS)})),
		other_label TEXT,
		key TEXT,
		memory_type TEXT CHECK (memory_type IS NULL OR memory_type IN (${list(MEMORY_TYPES)})),
		scope TEXT NOT NULL DEFAULT '',
		name TEXT NOT NULL, norm_name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		why TEXT, how_to_apply TEXT, objective TEXT,
		steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
		attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
		status TEXT NOT NULL CHECK (status IN (${list(STATUSES)})),
		origin TEXT NOT NULL CHECK (origin IN (${list(ORIGINS)})),
		pinned INTEGER NOT NULL DEFAULT 0,
		flagged TEXT,
		revision INTEGER NOT NULL DEFAULT 1,
		chars INTEGER NOT NULL DEFAULT 0,
		content_hash TEXT NOT NULL,
		card_hash TEXT NOT NULL, embed_hash TEXT,
		valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, ended_at TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
		source_profile TEXT, source_id TEXT, source_revision INTEGER,
		source_platform TEXT, updated_source_platform TEXT,
		seq INTEGER NOT NULL,
		CHECK (kind <> 'other' OR other_label IS NOT NULL),
		CHECK (memory_type IS NOT 'procedural' OR (objective IS NOT NULL AND steps IS NOT NULL)),
		CHECK (kind <> 'decision' OR why IS NOT NULL)
	)`,
	"CREATE UNIQUE INDEX nodes_key ON nodes (key) WHERE key IS NOT NULL AND status <> 'moved'",
	"CREATE UNIQUE INDEX nodes_memory_identity ON nodes (scope, memory_type, norm_name) WHERE memory_type IS NOT NULL AND status IN ('active','candidate','incoming','moving')",
	"CREATE INDEX nodes_name ON nodes (norm_name)",
	"CREATE INDEX nodes_kind ON nodes (kind, status, updated_at)",
	"CREATE INDEX nodes_embed_due ON nodes (id) WHERE embed_hash IS NOT card_hash AND status = 'active'",
	"CREATE INDEX nodes_source ON nodes (source_profile) WHERE source_profile IS NOT NULL",

	// head: name, description, why, how_to_apply, objective and steps. body: saved content. entry: one append. Chunks of at most 16k characters.
	`CREATE TABLE texts (
		rowid INTEGER PRIMARY KEY,
		node_id TEXT NOT NULL,
		part TEXT NOT NULL CHECK (part IN ('head','body','entry','summary','capture')),
		revision INTEGER NOT NULL, seq_no INTEGER NOT NULL DEFAULT 0, chunk INTEGER NOT NULL DEFAULT 0,
		body TEXT NOT NULL CHECK (length(body) <= 16000),
		separator TEXT, request_id TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL,
		live INTEGER NOT NULL DEFAULT 1,
		lane TEXT NOT NULL DEFAULT 'recall' CHECK (lane IN ('recall','capture')),
		seq INTEGER NOT NULL
	)`,
	"CREATE INDEX texts_node ON texts (node_id, part, seq_no, chunk)",
	`CREATE VIRTUAL TABLE texts_fts USING fts5 (body, content='texts', content_rowid='rowid', tokenize="porter unicode61 remove_diacritics 2 tokenchars '-_./#@:'")`,
	"CREATE VIRTUAL TABLE texts_tri USING fts5 (body, content='texts', content_rowid='rowid', tokenize='trigram')",
	// The two indexes hold exactly the live recall-lane rows. Body text never changes in place.
	`CREATE TRIGGER texts_ai AFTER INSERT ON texts WHEN NEW.live = 1 AND NEW.lane = 'recall' BEGIN
		INSERT INTO texts_fts (rowid, body) VALUES (NEW.rowid, NEW.body);
		INSERT INTO texts_tri (rowid, body) VALUES (NEW.rowid, NEW.body); END`,
	`CREATE TRIGGER texts_ad AFTER DELETE ON texts WHEN OLD.live = 1 AND OLD.lane = 'recall' BEGIN
		INSERT INTO texts_fts (texts_fts, rowid, body) VALUES ('delete', OLD.rowid, OLD.body);
		INSERT INTO texts_tri (texts_tri, rowid, body) VALUES ('delete', OLD.rowid, OLD.body); END`,
	`CREATE TRIGGER texts_au_out AFTER UPDATE OF live, lane ON texts WHEN OLD.live = 1 AND OLD.lane = 'recall' AND NOT (NEW.live = 1 AND NEW.lane = 'recall') BEGIN
		INSERT INTO texts_fts (texts_fts, rowid, body) VALUES ('delete', OLD.rowid, OLD.body);
		INSERT INTO texts_tri (texts_tri, rowid, body) VALUES ('delete', OLD.rowid, OLD.body); END`,
	`CREATE TRIGGER texts_au_in AFTER UPDATE OF live, lane ON texts WHEN NEW.live = 1 AND NEW.lane = 'recall' AND NOT (OLD.live = 1 AND OLD.lane = 'recall') BEGIN
		INSERT INTO texts_fts (rowid, body) VALUES (NEW.rowid, NEW.body);
		INSERT INTO texts_tri (rowid, body) VALUES (NEW.rowid, NEW.body); END`,

	`CREATE TABLE edges (
		id INTEGER PRIMARY KEY,
		src TEXT NOT NULL, rel TEXT NOT NULL CHECK (rel IN (${list(RELATIONS)})), other_label TEXT,
		dst TEXT NOT NULL, dst_profile TEXT NOT NULL DEFAULT '',
		basis TEXT NOT NULL CHECK (basis IN ('identifier','similarity','judgment')),
		reason TEXT, score REAL, weight INTEGER NOT NULL DEFAULT 1,
		valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, ended_at TEXT,
		actor TEXT NOT NULL, request_id TEXT, seq INTEGER NOT NULL,
		CHECK (basis <> 'judgment' OR length(reason) BETWEEN 8 AND 600),
		CHECK (rel <> 'other' OR other_label IS NOT NULL)
	)`,
	"CREATE UNIQUE INDEX edges_current ON edges (src, rel, dst_profile, dst) WHERE ended_at IS NULL",
	"CREATE INDEX edges_dst ON edges (dst_profile, dst, rel)",
	"CREATE INDEX edges_src_all ON edges (src, rel, recorded_at)",

	`CREATE TABLE evidence (owner TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, note TEXT, seq INTEGER NOT NULL,
		PRIMARY KEY (owner, kind, ref)) WITHOUT ROWID`,
	"CREATE INDEX evidence_ref ON evidence (kind, ref)",

	`CREATE TABLE revisions (
		node_id TEXT NOT NULL, revision INTEGER NOT NULL,
		op TEXT NOT NULL CHECK (op IN ('saved','updated','retired','superseded','restored','moved','compacted','transferred_in')),
		snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
		request_id TEXT, actor TEXT NOT NULL, device_id TEXT, at TEXT NOT NULL, seq INTEGER NOT NULL,
		PRIMARY KEY (node_id, revision)
	) WITHOUT ROWID`,

	`CREATE TABLE requests (
		request_id TEXT PRIMARY KEY, op TEXT NOT NULL, payload_hash TEXT NOT NULL,
		result TEXT NOT NULL, node_id TEXT, at TEXT NOT NULL, seq INTEGER NOT NULL,
		legacy_op TEXT, legacy_hash TEXT
	) WITHOUT ROWID`,

	`CREATE TABLE activity (
		id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, device_id TEXT, stage TEXT,
		op TEXT NOT NULL, summary TEXT NOT NULL, targets TEXT NOT NULL,
		undo TEXT CHECK (undo IS NULL OR json_valid(undo)),
		undone_by INTEGER, undo_of INTEGER,
		seq INTEGER NOT NULL
	)`,
	"CREATE INDEX activity_at ON activity (at)",

	"CREATE TABLE cursors (stage TEXT PRIMARY KEY, cursor TEXT, due_at INTEGER NOT NULL, last_run_at TEXT, last_error TEXT, stats TEXT) WITHOUT ROWID",

	...DELETED_ROWS,
	...Object.keys(KEYS).flatMap((t) => [`CREATE INDEX ${t}_seq ON ${t} (seq, ${SEQ_KEY[t]})`, ...tombstoneTriggers("profile_meta", t, KEYS[t]!)]),
]];
