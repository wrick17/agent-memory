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

/** A content-bearing plan naming this repository (`github:<ns>` or `github:<ns>#<n>`) loses its descriptor and refuses from then on. */
const ERASE = `UPDATE refresh_claims SET parts = NULL, invalid = 'source_deleted' WHERE parts IS NOT NULL AND EXISTS
		(SELECT 1 FROM json_each(refresh_claims.parts, '$.sources') s WHERE json_extract(s.value, '$.namespace') = `;
const NAMESPACE = (key: string) => `CASE WHEN instr(${key}, '#') THEN substr(${key}, 8, instr(${key}, '#') - 8) ELSE substr(${key}, 8) END`;

// Used only by v8 triggers. A deleted request loses replay authority but its accepted observation stays sealed.
const COUNT_SEAL = `
	UPDATE edges SET commit_seal=json_object('seq',(SELECT CAST(value AS INTEGER) FROM profile_meta WHERE key='write_seq'),'evidence',json_extract(OLD.commit_meta,'$.owner.seq')),
		seq=(SELECT CAST(value AS INTEGER) FROM profile_meta WHERE key='write_seq')
	WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(OLD.commit_meta,'$.structural'))
	AND EXISTS (SELECT 1 FROM json_each(OLD.commit_meta,'$.structural') e WHERE
		edges.id=json_extract(e.value,'$.id') AND edges.src=json_extract(e.value,'$.src') AND edges.dst=json_extract(e.value,'$.dst')
		AND edges.dst_profile=json_extract(e.value,'$.dst_profile') AND edges.rel=json_extract(e.value,'$.rel') AND edges.basis=json_extract(e.value,'$.basis')
		AND edges.recorded_at=json_extract(e.value,'$.recorded_at') AND edges.request_id IS json_extract(e.value,'$.request_id') AND edges.seq=json_extract(e.value,'$.seq'));
	UPDATE profile_meta SET value=json_set(value,
		'$.base',json_extract(value,'$.base')+1,
		'$.baseFirst',CASE WHEN json_extract(value,'$.baseFirst') IS NULL OR json_extract(OLD.commit_meta,'$.at')<json_extract(value,'$.baseFirst') THEN json_extract(OLD.commit_meta,'$.at') ELSE json_extract(value,'$.baseFirst') END,
		'$.baseLast',CASE WHEN json_extract(value,'$.baseLast') IS NULL OR json_extract(OLD.commit_meta,'$.at')>json_extract(value,'$.baseLast') THEN json_extract(OLD.commit_meta,'$.at') ELSE json_extract(value,'$.baseLast') END)
	WHERE key=json_extract(OLD.commit_meta,'$.pair') AND json_extract(value,'$.epoch')=json_extract(OLD.commit_meta,'$.epoch') AND json_extract(OLD.commit_meta,'$.counted')=1;
	INSERT OR IGNORE INTO profile_meta(key,value)
		SELECT 'work-count:'||json_extract(OLD.commit_meta,'$.origin')||':claim:'||json_extract(c.value,'$.id'),
		json_object('kind','claim','origin',json_extract(OLD.commit_meta,'$.origin'),'node',json_extract(c.value,'$.id'),'expect',json_extract(c.value,'$.expect'),'owner',coalesce(json_extract(c.value,'$.countOwner'),json_extract(OLD.commit_meta,'$.owner')))
		FROM activity a,json_each(a.undo,'$.created') c
		WHERE a.id=json_extract(OLD.commit_meta,'$.owner.id') AND a.at=json_extract(OLD.commit_meta,'$.owner.at') AND json_extract(a.undo,'$.seq')=json_extract(OLD.commit_meta,'$.owner.seq')
		AND json_extract(c.value,'$.id') IN (json_extract(OLD.commit_meta,'$.person'),json_extract(OLD.commit_meta,'$.project'));
`;

/** The maintenance queue's DDL. v9 rebuilds it under another name to widen the kind CHECK; every other column stays as v2 made it. */
const MAINTENANCE_KINDS_V2 = ["near_duplicate", "possible_contradiction", "unlinked", "unprocessed_capture", "preference_signal", "stale_journal", "weekly_review", "dangling_link"];
const MAINTENANCE_COLUMNS = "id, kind, subjects, fingerprint, state, lease_id, lease_until, attempts, created_at, done_at, outcome, seq";
const maintenanceTable = (name: string, kinds: readonly string[]) => `CREATE TABLE ${name} (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(",")})),
		subjects TEXT NOT NULL CHECK (json_valid(subjects)),
		fingerprint TEXT NOT NULL UNIQUE,
		state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','leased','done','dismissed','stuck')),
		lease_id TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL, done_at TEXT, outcome TEXT, seq INTEGER NOT NULL
	)`;

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
	maintenanceTable("maintenance", MAINTENANCE_KINDS_V2),
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
], [
	// v6: the owner archive page and restore find one removal's rows by its activity id.
	"CREATE INDEX archive_activity ON archive (activity_id, id)",
], [
	// v7 (daily-proof.ts): each PR or ticket upload's receipt and each source revision's first receipt and undo, written in the
	// upload's and the Undo's own transactions and deleted with their request on any path; a receipt is stamped registered only
	// after its nodes' account registration and access recheck succeed. A claimed plan's mirror and refs.
	`CREATE TABLE upload_receipts (request_id TEXT PRIMARY KEY, activity_id INTEGER, at TEXT NOT NULL, key TEXT NOT NULL, revision TEXT NOT NULL,
		seq INTEGER NOT NULL, registered_at TEXT) WITHOUT ROWID`,
	"CREATE INDEX upload_receipts_activity ON upload_receipts (activity_id) WHERE activity_id IS NOT NULL",
	`CREATE TABLE upload_revisions (key TEXT NOT NULL, revision TEXT NOT NULL, request_id TEXT NOT NULL, legacy INTEGER NOT NULL, undone_by INTEGER,
		seq INTEGER NOT NULL, PRIMARY KEY (key, revision)) WITHOUT ROWID`,
	// A claimed plan's mirror: its exact binding, the sealed plan (content-bearing until cleanup or invalidation), the acknowledged
	// prefix, the terminal and whether its refs, part proofs and plan are gone. Each acknowledged part keeps its exact proof text.
	`CREATE TABLE refresh_claims (claim_id TEXT PRIMARY KEY, binding TEXT NOT NULL, manifest_hash TEXT, parts TEXT,
		state TEXT NOT NULL CHECK (state IN ('pending','done','failed','abandoned')), acked INTEGER NOT NULL, terminal TEXT, invalid TEXT,
		cleaned INTEGER NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX refresh_claims_content ON refresh_claims (claim_id) WHERE parts IS NOT NULL",
	`CREATE TABLE refresh_refs (claim_id TEXT NOT NULL, part INTEGER NOT NULL, idx INTEGER NOT NULL, key TEXT NOT NULL, revision TEXT NOT NULL, item_hash TEXT NOT NULL,
		request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_hash TEXT NOT NULL, action TEXT NOT NULL, request_seq INTEGER NOT NULL, authority TEXT,
		seq INTEGER NOT NULL, PRIMARY KEY (claim_id, part, idx)) WITHOUT ROWID`,
	"CREATE UNIQUE INDEX refresh_refs_request ON refresh_refs (request_id, claim_id)",
	`CREATE TABLE refresh_parts (claim_id TEXT NOT NULL, part INTEGER NOT NULL, body_sha256 TEXT NOT NULL, proof TEXT NOT NULL, receipt_hash TEXT NOT NULL,
		seq INTEGER NOT NULL, PRIMARY KEY (claim_id, part)) WITHOUT ROWID`,
	// Deleting a request on any path (purge, transfer, wipe) takes its receipt, its revision's first-receipt row, every daily ref to
	// it with the part proof that names it, and erases any plan naming its GitHub repository (lifecycle r2, rule 1).
	`CREATE TRIGGER upload_receipts_gone AFTER DELETE ON requests WHEN OLD.op = 'upload' BEGIN
		DELETE FROM upload_revisions WHERE request_id = OLD.request_id AND (key, revision) IN (SELECT key, revision FROM upload_receipts WHERE request_id = OLD.request_id);
		DELETE FROM upload_receipts WHERE request_id = OLD.request_id;
		DELETE FROM refresh_parts WHERE (claim_id, part) IN (SELECT claim_id, part FROM refresh_refs WHERE request_id = OLD.request_id);
		DELETE FROM refresh_refs WHERE request_id = OLD.request_id;
		${ERASE}(SELECT CASE WHEN x LIKE 'github:%' THEN substr(x, 8, instr(x, '#') - 8) END FROM (SELECT substr(OLD.request_id, instr(substr(OLD.request_id, 8), ':') + 8) AS x)));
	END`,
	`CREATE TRIGGER refresh_node_gone AFTER DELETE ON nodes WHEN OLD.key LIKE 'github:%' BEGIN
		${ERASE}${NAMESPACE("OLD.key")});
	END`,
	`CREATE TRIGGER refresh_archive_gone AFTER DELETE ON archive WHEN OLD.source = 'nodes' AND json_extract(OLD.payload, '$.key') LIKE 'github:%' BEGIN
		${ERASE}${NAMESPACE("json_extract(OLD.payload, '$.key')")});
	END`,
], [
	// v8: reversible observed-commit facts and constant-size pair state. Generic replay/retention is unchanged.
	"ALTER TABLE requests ADD COLUMN commit_meta TEXT CHECK(commit_meta IS NULL OR json_valid(commit_meta))",
	"ALTER TABLE edges ADD COLUMN count_key TEXT",
	"ALTER TABLE edges ADD COLUMN count_epoch TEXT",
	"ALTER TABLE edges ADD COLUMN commit_seal TEXT CHECK(commit_seal IS NULL OR json_valid(commit_seal))",
	"CREATE INDEX count_dates ON requests(json_extract(commit_meta,'$.pair'),json_extract(commit_meta,'$.epoch'),json_extract(commit_meta,'$.at'),request_id) WHERE json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1 AND json_extract(commit_meta,'$.counted')=1",
	"CREATE INDEX count_person ON requests(json_extract(commit_meta,'$.person'),request_id) WHERE json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1",
	"CREATE INDEX count_project ON requests(json_extract(commit_meta,'$.project'),request_id) WHERE json_extract(commit_meta,'$.local')=1 AND json_extract(commit_meta,'$.active')=1",
	"CREATE INDEX count_pair_person ON profile_meta(json_extract(value,'$.person'),json_extract(value,'$.n')) WHERE key GLOB 'work-count:*:pair:*'",
	"CREATE INDEX count_pair_project ON profile_meta(json_extract(value,'$.project'),json_extract(value,'$.n')) WHERE key GLOB 'work-count:*:pair:*'",
	`CREATE TRIGGER count_receipt_seal BEFORE UPDATE OF commit_meta ON requests
		WHEN NEW.commit_meta IS NULL AND json_extract(OLD.commit_meta,'$.local')=1 AND json_extract(OLD.commit_meta,'$.active')=1 BEGIN ${COUNT_SEAL} END`,
	`CREATE TRIGGER count_receipt_delete BEFORE DELETE ON requests
		WHEN json_extract(OLD.commit_meta,'$.local')=1 AND json_extract(OLD.commit_meta,'$.active')=1 BEGIN ${COUNT_SEAL} END`,
	`CREATE TRIGGER count_activity_expiry BEFORE DELETE ON activity WHEN json_extract(OLD.undo,'$.commitReceipt.request') IS NOT NULL BEGIN
		UPDATE requests SET commit_meta=NULL,seq=(SELECT CAST(value AS INTEGER) FROM profile_meta WHERE key='write_seq') WHERE request_id=json_extract(OLD.undo,'$.commitReceipt.request')
		AND json_extract(commit_meta,'$.owner.id')=OLD.id AND json_extract(commit_meta,'$.owner.at')=OLD.at AND json_extract(commit_meta,'$.owner.seq')=json_extract(OLD.undo,'$.seq');
	END`,
], [
	// v9 (v2 storage, issue #5): per-node recall hits by UTC day, daily recall totals and owner-correctable eval candidates; nodes rows
	// stay unchanged. Each table is exported, sequence-indexed and tombstoned like every other base table. v8 exports still restore
	// (compat.ts): their rows fit by named columns and the new tables start empty.
	`CREATE TABLE recall_daily (node_id TEXT NOT NULL, day TEXT NOT NULL, hits INTEGER NOT NULL, seq INTEGER NOT NULL,
		PRIMARY KEY (node_id, day)) WITHOUT ROWID`,
	"CREATE TABLE recall_totals (day TEXT PRIMARY KEY, recalls INTEGER NOT NULL, tokens INTEGER NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID",
	`CREATE TABLE eval_candidates (id TEXT PRIMARY KEY, query TEXT NOT NULL, expected_json TEXT NOT NULL CHECK (json_valid(expected_json)),
		evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
		status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')), created_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX recall_daily_seq ON recall_daily (seq, node_id, day)",
	"CREATE INDEX recall_totals_seq ON recall_totals (seq, day)",
	"CREATE INDEX eval_candidates_seq ON eval_candidates (seq, id)",
	...tombstoneTriggers("profile_meta", "recall_daily", (r) => `json_array(${r}.node_id, ${r}.day)`),
	...tombstoneTriggers("profile_meta", "recall_totals", (r) => `${r}.day`),
	...tombstoneTriggers("profile_meta", "eval_candidates", (r) => `${r}.id`),
	// SQLite cannot widen a CHECK in place: maintenance is rebuilt with every v2 column, row and id, then its indexes and triggers.
	maintenanceTable("maintenance_v9", [...MAINTENANCE_KINDS_V2, "stale_memory"]),
	`INSERT INTO maintenance_v9 (${MAINTENANCE_COLUMNS}) SELECT ${MAINTENANCE_COLUMNS} FROM maintenance`,
	"DROP TABLE maintenance",
	"ALTER TABLE maintenance_v9 RENAME TO maintenance",
	"CREATE INDEX maintenance_open ON maintenance (state, kind, created_at)",
	"CREATE INDEX maintenance_seq ON maintenance (seq, id)",
	...tombstoneTriggers("profile_meta", "maintenance", (r) => `CAST(${r}.id AS TEXT)`),
], [
	// v10 (repo facts v2, docs/repo-facts-v2-contract.md section 6): report receipts with the complete validated report (the replay
	// input), their per-fact index (forget rewrites the receipts it names) and per repo per day efficiency rows. Older exports restore
	// with these tables empty.
	`CREATE TABLE fact_reports (repo_key TEXT NOT NULL, report_id TEXT NOT NULL, order_key TEXT NOT NULL, device TEXT NOT NULL, day TEXT NOT NULL,
		received_at TEXT NOT NULL, body TEXT NOT NULL CHECK (json_valid(body)), seq INTEGER NOT NULL, PRIMARY KEY (repo_key, report_id)) WITHOUT ROWID`,
	"CREATE INDEX fact_reports_order ON fact_reports (order_key, repo_key, report_id)",
	`CREATE TABLE fact_report_facts (repo_key TEXT NOT NULL, fact_key TEXT NOT NULL, report_id TEXT NOT NULL, seq INTEGER NOT NULL,
		PRIMARY KEY (repo_key, fact_key, report_id)) WITHOUT ROWID`,
	`CREATE TABLE fact_days (repo_key TEXT NOT NULL, day TEXT NOT NULL, sessions INTEGER NOT NULL, usage_sessions INTEGER NOT NULL, input INTEGER NOT NULL,
		cached_input INTEGER NOT NULL, output INTEGER NOT NULL, cache_write INTEGER NOT NULL, commands INTEGER NOT NULL, failed INTEGER NOT NULL,
		repeated_failures INTEGER NOT NULL, injected INTEGER NOT NULL, prevented INTEGER NOT NULL, fired INTEGER NOT NULL, seq INTEGER NOT NULL,
		PRIMARY KEY (repo_key, day)) WITHOUT ROWID`,
	"CREATE INDEX fact_reports_seq ON fact_reports (seq, repo_key, report_id)",
	"CREATE INDEX fact_report_facts_seq ON fact_report_facts (seq, repo_key, fact_key, report_id)",
	"CREATE INDEX fact_days_seq ON fact_days (seq, repo_key, day)",
	...tombstoneTriggers("profile_meta", "fact_reports", (r) => `json_array(${r}.repo_key, ${r}.report_id)`),
	...tombstoneTriggers("profile_meta", "fact_report_facts", (r) => `json_array(${r}.repo_key, ${r}.fact_key, ${r}.report_id)`),
	...tombstoneTriggers("profile_meta", "fact_days", (r) => `json_array(${r}.repo_key, ${r}.day)`),
	// Guidance receipts (#127, src/profile/guidance.ts): one row per injected memory per session, pending until the batch has
	// processed that session; processed sessions; and the correction matches the batch's record_lesson made.
	`CREATE TABLE guidance_injections (session_ref TEXT NOT NULL, memory_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','followed','failed')),
		at TEXT NOT NULL, seq INTEGER NOT NULL, UNIQUE (session_ref, memory_id))`,
	"CREATE INDEX guidance_injections_memory ON guidance_injections (memory_id, state)",
	"CREATE INDEX guidance_injections_at ON guidance_injections (at)",
	"CREATE TABLE guidance_sessions (session_ref TEXT PRIMARY KEY, session_id TEXT NOT NULL, processed_at TEXT NOT NULL, seq INTEGER NOT NULL) WITHOUT ROWID",
	`CREATE TABLE correction_matches (session_ref TEXT NOT NULL, session_id TEXT NOT NULL, rule_id TEXT NOT NULL, correction_index INTEGER NOT NULL,
		repeat INTEGER NOT NULL, at TEXT NOT NULL, seq INTEGER NOT NULL, UNIQUE (session_ref, rule_id, correction_index))`,
	"CREATE INDEX correction_matches_session ON correction_matches (session_id)",
	"CREATE INDEX correction_matches_at ON correction_matches (at)",
	"CREATE INDEX guidance_injections_seq ON guidance_injections (seq)",
	"CREATE INDEX guidance_sessions_seq ON guidance_sessions (seq, session_ref)",
	"CREATE INDEX correction_matches_seq ON correction_matches (seq)",
	...tombstoneTriggers("profile_meta", "guidance_injections", (r) => `json_array(${r}.session_ref, ${r}.memory_id)`),
	...tombstoneTriggers("profile_meta", "guidance_sessions", (r) => `${r}.session_ref`),
	...tombstoneTriggers("profile_meta", "correction_matches", (r) => `json_array(${r}.session_ref, ${r}.rule_id, ${r}.correction_index)`),
]];
