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
], [
	// v2 (phase 2): capture digests on texts, their own full-text index, repo markers, the maintenance queue (section 5).
	"ALTER TABLE texts ADD COLUMN range_id TEXT",
	"ALTER TABLE texts ADD COLUMN capture_part TEXT",
	"ALTER TABLE texts ADD COLUMN sha256 TEXT",
	"ALTER TABLE texts ADD COLUMN capture_status TEXT CHECK (capture_status IS NULL OR capture_status IN ('heuristic','consolidated'))",
	// chunk is part of the identity only for a manifest, whose body can exceed one 16,000-character row.
	"CREATE UNIQUE INDEX texts_capture ON texts (range_id, capture_status, capture_part, chunk) WHERE range_id IS NOT NULL",
	"CREATE VIRTUAL TABLE captures_fts USING fts5 (body, content='texts', content_rowid='rowid', tokenize='porter unicode61')",
	// captures_fts holds exactly the live capture-lane rows; ordinary recall never reads it.
	`CREATE TRIGGER texts_cap_ai AFTER INSERT ON texts WHEN NEW.live = 1 AND NEW.lane = 'capture' BEGIN
		INSERT INTO captures_fts (rowid, body) VALUES (NEW.rowid, NEW.body); END`,
	`CREATE TRIGGER texts_cap_ad AFTER DELETE ON texts WHEN OLD.live = 1 AND OLD.lane = 'capture' BEGIN
		INSERT INTO captures_fts (captures_fts, rowid, body) VALUES ('delete', OLD.rowid, OLD.body); END`,
	`CREATE TRIGGER texts_cap_au_out AFTER UPDATE OF live, lane ON texts WHEN OLD.live = 1 AND OLD.lane = 'capture' AND NOT (NEW.live = 1 AND NEW.lane = 'capture') BEGIN
		INSERT INTO captures_fts (captures_fts, rowid, body) VALUES ('delete', OLD.rowid, OLD.body); END`,
	`CREATE TRIGGER texts_cap_au_in AFTER UPDATE OF live, lane ON texts WHEN NEW.live = 1 AND NEW.lane = 'capture' AND NOT (OLD.live = 1 AND OLD.lane = 'capture') BEGIN
		INSERT INTO captures_fts (rowid, body) VALUES (NEW.rowid, NEW.body); END`,
	"CREATE TABLE markers (repo TEXT PRIMARY KEY, head TEXT, uploaded_at TEXT, analyzed_at TEXT, analysis_head TEXT, seq INTEGER NOT NULL) WITHOUT ROWID",
	`CREATE TABLE maintenance (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('near_duplicate','possible_contradiction','unlinked','unprocessed_capture','preference_signal','stale_journal','weekly_review','dangling_link')),
		subjects TEXT NOT NULL CHECK (json_valid(subjects)),
		fingerprint TEXT NOT NULL UNIQUE,
		state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','leased','done','dismissed','stuck')),
		lease_id TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL, done_at TEXT, outcome TEXT, seq INTEGER NOT NULL
	)`,
	// The me guard's work terms, kept in the me profile itself so its write transaction reads them atomically (section 5).
	"CREATE TABLE guard_terms (term TEXT PRIMARY KEY, source TEXT NOT NULL, added_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID",
	"CREATE INDEX guard_terms_seq ON guard_terms (seq, term)",
	"CREATE INDEX maintenance_open ON maintenance (state, kind, created_at)",
	"CREATE INDEX markers_seq ON markers (seq, repo)",
	"CREATE INDEX maintenance_seq ON maintenance (seq, id)",
	...tombstoneTriggers("profile_meta", "markers", (r) => `${r}.repo`),
	...tombstoneTriggers("profile_meta", "maintenance", (r) => `CAST(${r}.id AS TEXT)`),
	...tombstoneTriggers("profile_meta", "guard_terms", (r) => `${r}.term`),
], [
	// v3: the staged import (section 16). Revisions are rebuilt to take BothQ's own operations and keep each revision's
	// original delta and source fields; SQLite cannot widen a CHECK in place. Every existing revision is copied unchanged.
	`CREATE TABLE revisions_v3 (
		node_id TEXT NOT NULL, revision INTEGER NOT NULL,
		op TEXT NOT NULL CHECK (op IN ('saved','updated','retired','superseded','restored','moved','compacted','transferred_in','appended','legacy_adopted','legacy_snapshot')),
		snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
		request_id TEXT, actor TEXT NOT NULL, device_id TEXT, at TEXT NOT NULL, seq INTEGER NOT NULL,
		delta TEXT CHECK (delta IS NULL OR json_valid(delta)), revision_id TEXT, content_hash TEXT, source_platform TEXT, source_platform_version TEXT,
		PRIMARY KEY (node_id, revision)
	) WITHOUT ROWID`,
	"INSERT INTO revisions_v3 (node_id, revision, op, snapshot, request_id, actor, device_id, at, seq) SELECT node_id, revision, op, snapshot, request_id, actor, device_id, at, seq FROM revisions",
	"DROP TABLE revisions",
	"ALTER TABLE revisions_v3 RENAME TO revisions",
	"CREATE INDEX revisions_seq ON revisions (seq, node_id, revision)",
	...tombstoneTriggers("profile_meta", "revisions", KEYS.revisions!),
	// Imported BothQ requests keep their original operation, hash and result; completed_at and any other source field too.
	"ALTER TABLE requests ADD COLUMN completed_at TEXT",
	"ALTER TABLE requests ADD COLUMN source TEXT CHECK (source IS NULL OR json_valid(source))",
	// One row per imported record and per staged part. A record's rows stay invisible until its state is published:
	// its node row does not exist before then, and replay refuses its requests.
	`CREATE TABLE import_records (
		record_id TEXT PRIMARY KEY, record_sha256 TEXT NOT NULL, parts INTEGER NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('staging','prepared','published')), node_sha256 TEXT,
		staged_at TEXT NOT NULL, published_at TEXT, seq INTEGER NOT NULL
	) WITHOUT ROWID`,
	`CREATE TABLE import_parts (
		part_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, part INTEGER NOT NULL, sha256 TEXT NOT NULL,
		rows_written INTEGER NOT NULL, bytes INTEGER NOT NULL, staged_at TEXT NOT NULL, seq INTEGER NOT NULL
	) WITHOUT ROWID`,
	"CREATE UNIQUE INDEX import_parts_record ON import_parts (record_id, part)",
	// Only publication may create the node of a record still being imported; every other creation path is refused.
	`CREATE TRIGGER nodes_import_fence BEFORE INSERT ON nodes
		WHEN NEW.origin <> 'import' AND EXISTS (SELECT 1 FROM import_records WHERE record_id = NEW.id AND state <> 'published')
		BEGIN SELECT RAISE(ABORT, 'import_pending'); END`,
	"CREATE INDEX requests_node ON requests (node_id)",
	"CREATE INDEX import_records_seq ON import_records (seq, record_id)",
	"CREATE INDEX import_parts_seq ON import_parts (seq, part_id)",
	...tombstoneTriggers("profile_meta", "import_records", (r) => `${r}.record_id`),
	...tombstoneTriggers("profile_meta", "import_parts", (r) => `${r}.part_id`),
], [
	// v4 (phase 3, docs/module-contracts.md): removed rows kept restorable until they purge, and the transfer protocol's
	// state in each profile it touches (sections 5 and 9).
	`CREATE TABLE archive (
		id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL, at TEXT NOT NULL, purge_after TEXT NOT NULL,
		source TEXT NOT NULL CHECK (source IN ('nodes','texts','edges','evidence','revisions','requests')),
		payload TEXT NOT NULL, seq INTEGER NOT NULL
	)`,
	"CREATE INDEX archive_purge ON archive (purge_after)",
	"CREATE INDEX archive_seq ON archive (seq, id)",
	...tombstoneTriggers("profile_meta", "archive", (r) => `CAST(${r}.id AS TEXT)`),
	`CREATE TABLE transfers (
		id TEXT PRIMARY KEY, node_id TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('out','in')),
		peer TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('fenced','sent','landed','published','committed','aborted')),
		parts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL
	) WITHOUT ROWID`,
	"CREATE INDEX transfers_seq ON transfers (seq, id)",
	...tombstoneTriggers("profile_meta", "transfers", (r) => `${r}.id`),
	// Control state, deleted at commit or abort and never exported.
	"CREATE TABLE transfer_parts (transfer_id TEXT NOT NULL, n INTEGER NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (transfer_id, n)) WITHOUT ROWID",
	// 'wipe:<profile>:<wiped_at>' once a wipe removed the row's content; its undo is then refused.
	"ALTER TABLE activity ADD COLUMN redacted TEXT",
], [
	// v5: refresh rows stay under a shadow identity until their bounded atomic publish.
	"ALTER TABLE import_records ADD COLUMN published_revision INTEGER",
	"ALTER TABLE import_records ADD COLUMN published_content_hash TEXT",
	// Old stores derive the anchor from preserved source history, never from a possibly edited hosted node.
	`UPDATE import_records SET published_revision = (SELECT max(revision) FROM revisions WHERE node_id = record_id AND actor = 'migration'),
		published_content_hash = (SELECT content_hash FROM revisions WHERE node_id = record_id AND actor = 'migration' ORDER BY revision DESC LIMIT 1)
		WHERE state = 'published'`,
	`CREATE TABLE import_refreshes (
		shadow_id TEXT PRIMARY KEY, record_id TEXT NOT NULL, refresh_no INTEGER NOT NULL,
		base_record_sha256 TEXT NOT NULL, record_sha256 TEXT NOT NULL, parts INTEGER NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('staging','prepared','published')), node_sha256 TEXT, finalize_sha256 TEXT,
		published_revision INTEGER, published_content_hash TEXT,
		staged_at TEXT NOT NULL, published_at TEXT, seq INTEGER NOT NULL,
		UNIQUE (record_id, refresh_no)
	) WITHOUT ROWID`,
	"CREATE INDEX import_refreshes_seq ON import_refreshes (seq, shadow_id)",
	...tombstoneTriggers("profile_meta", "import_refreshes", (r) => `${r}.shadow_id`),
	`CREATE TRIGGER nodes_refresh_fence BEFORE INSERT ON nodes
		WHEN EXISTS (SELECT 1 FROM import_refreshes WHERE shadow_id = NEW.id)
		BEGIN SELECT RAISE(ABORT, 'import_pending'); END`,
]];
