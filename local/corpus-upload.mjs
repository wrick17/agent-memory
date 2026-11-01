// Corpus bulk load core (section 14), shared by the foreground CLI (corpus-cli.mjs) and the Workers roundtrip test. It reads
// only the families the server's status names, checks each table's DDL hash and columns, and sends key-ordered chunks of at
// most 5,000 rows and about 900 KB. Non-key text is redacted with the server's own rules before hashing; a key that would
// need redaction holds its row. A rerun resumes after the server's stored last key on the pinned generation, so nothing
// duplicates; a different generation, source file or as_of stops the run instead of appending.
import { createHash } from "node:crypto";
import { EMAIL, PHONE } from "../src/domain/personal.ts";
import { REDACTED, redactText } from "../src/domain/redact.ts";

export const FORBIDDEN = ["session_messages", "session_decisions", "user_directives"];
/** The cleared session metadata snapshot tables, by exact name: the only session-named tables the broad name refusal lets through. */
const SESSION_METADATA = ["codex_sessions", "session_commit_links", "session_ticket_links"];
const PERSONAL = new RegExp(`${EMAIL.source}|${PHONE.source}`, "g");
const TRANSIENT = ["busy", "unavailable"];
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const bytes = (s) => new TextEncoder().encode(s).length;
/** The server's chunk hash (src/corpus/families.ts chunkHash): one fixed tuple. */
export const chunkHash = (c) => sha256(JSON.stringify([c.table, c.schema_sha256, c.source.file_sha256, c.as_of, c.columns, c.after, c.rows, c.final]));

/** The server's snapshot cut identity (src/corpus/snapshots.ts cutIdOf): set, source, normalized as_of and members' DDL hashes in set order. */
export const snapshotCutOf = (set, members, fileSha256, asOf) => sha256(JSON.stringify(["corpus-snapshot/1:cut", set, fileSha256, new Date(asOf).toISOString(), members.map((m) => m.schema_sha256)]));

/** Both acquisition paths require the original table DDL and every projected column before reading rows. */
export async function validateSource(source, fam) {
	const ddl = await source.schema(fam.table);
	if (ddl === null || sha256(ddl) !== fam.schema_sha256) return "schema_mismatch";
	const have = new Set(await source.columns(fam.table));
	if (fam.columns.some((c) => c !== "rowid" && !have.has(c))) return "columns";
	return null;
}

/**
 * source: { schema(table) -> CREATE TABLE text or null, columns(table) -> names, rows(table, columns, key, after, limit) -> arrays }, sync or async
 * client: { status(profile) -> status body, send(chunk) -> { receipt } | { error } }. Returns done, or refused/stopped with a reason.
 */
export async function uploadCorpus({ source, client, profile, tables, asOf, fileSha256, state = {}, save = () => {}, chunkRows = 5000, chunkBytes = 900_000 }) {
	if (!/^[a-z][a-z0-9-]{0,11}$/.test(profile) || profile === "me") return { status: "refused", reason: "invalid_profile" };
	// Refused by name before anything is read, under any listing.
	const forbidden = tables.find((t) => FORBIDDEN.includes(String(t).toLowerCase()) || (/session|directive|decision/i.test(String(t)) && !SESSION_METADATA.includes(String(t))));
	if (forbidden) return { status: "refused", table: forbidden, reason: "never_import" };
	const st = await client.status(profile);
	if (st.error) return { status: TRANSIENT.includes(st.error.code) ? "stopped" : "refused", reason: st.error.details?.reason ?? st.error.code };
	// A refresh holds the corpus: never report a completed load (or send a chunk) while one is applying.
	if (st.refresh) return { status: "stopped", reason: "corpus_refreshing" };
	// Dated snapshot tables (status snapshot_families) load as whole sets: one cut, replaced only by a newer one, published when every
	// member's final chunk lands. Progress is the server's ledger for this cut, so a cut the server abandoned restarts from its first chunk.
	const snaps = st.snapshot_families ?? [];
	// A snapshot-only run takes all progress from the server's ledger and leaves the bulk load's local state file untouched, so a newer
	// cut from a newer file never blocks, or is blocked by, an interrupted bulk resume.
	if (tables.length && tables.every((t) => snaps.some((f) => f.table === t))) { state = {}; save = () => {}; }
	for (const [k, v] of [["generation", st.generation], ["source", fileSha256], ["as_of", asOf]]) {
		if (state[k] !== undefined && state[k] !== v) return { status: "refused", reason: k === "generation" ? "generation_changed" : `${k}_changed` };
	}
	const cutOf = (set) => snapshotCutOf(set, snaps.filter((f) => f.set === set), fileSha256, asOf);
	const sets = [...new Set(tables.map((t) => snaps.find((f) => f.table === t)?.set).filter(Boolean))];
	for (const set of sets) if (snaps.some((f) => f.set === set && !tables.includes(f.table))) return { status: "refused", reason: "snapshot_set_incomplete", set };
	Object.assign(state, { profile, generation: st.generation, source: fileSha256, as_of: asOf, tables: state.tables ?? {} });
	save(state);
	for (const table of tables) {
		const snap = snaps.find((f) => f.table === table);
		const fam = snap ?? st.families.find((f) => f.table === table);
		if (!fam) return { status: "refused", table, reason: st.held?.[table] ?? "unknown_table" };
		const invalid = await validateSource(source, fam);
		if (invalid) return { status: "refused", table, reason: invalid };
		let progress;
		if (snap) {
			const ledger = st.snapshots?.[snap.set], cut = cutOf(snap.set);
			const t = ledger?.published?.cut_id === cut ? ledger.published.tables[table] : ledger?.loading?.cut_id === cut ? ledger.loading.tables[table] : null;
			progress = t ? { last_key: t.last, rows: t.rows, complete: t.final } : null;
		} else {
			progress = st.tables.find((t) => t.table === table);
			// Identity first: a stored load from another file or as_of is never reported as this upload, complete or not.
			if (progress && (progress.source_sha256 !== fileSha256 || progress.as_of !== asOf)) return { status: "refused", table, reason: "source_changed" };
		}
		if (progress?.complete) { state.tables[table] = { last_key: progress.last_key, rows: progress.rows, complete: true }; continue; }
		let after = progress?.last_key ?? null, rows = progress?.rows ?? 0;
		for (;;) {
			const read = (await source.rows(table, fam.columns, fam.key, after, chunkRows + 1)).map((r) => r.map((v, i) => (typeof v === "string" && !fam.key.includes(fam.columns[i]) ? redactText(v).replace(PERSONAL, REDACTED) : v)));
			const chunkRowsOut = [];
			let size = 0;
			for (const r of read.slice(0, chunkRows)) {
				const n = bytes(JSON.stringify(r)) + 1;
				if (size + n > chunkBytes) break;
				chunkRowsOut.push(r); size += n;
			}
			if (read.length && !chunkRowsOut.length) return { status: "refused", table, reason: "row_too_large" };
			const final = chunkRowsOut.length === read.length;
			const chunk = { profile, generation: st.generation, table, schema_sha256: fam.schema_sha256, source: { file_sha256: fileSha256 }, as_of: asOf, columns: fam.columns, after, rows: chunkRowsOut, final };
			chunk.sha256 = chunkHash(chunk);
			let res;
			try { res = await client.send(chunk); } catch (e) { return { status: "stopped", table, reason: String(e?.message ?? e).slice(0, 200) }; }
			// A transient account or guard failure stores nothing, so the run stops for a resend of this same chunk.
			if (res.error) return { status: TRANSIENT.includes(res.error.code) ? "stopped" : "refused", table, reason: res.error.details?.reason ?? res.error.code };
			const r = res.receipt;
			const lastKey = chunkRowsOut.length ? fam.key.map((k) => chunkRowsOut.at(-1)[fam.columns.indexOf(k)]) : after;
			if (!r || r.sha256 !== chunk.sha256 || !["stored", "replayed"].includes(r.status) || JSON.stringify(r.last_key) !== JSON.stringify(lastKey) || r.complete !== final) return { status: "stopped", table, reason: "not_acknowledged" };
			after = lastKey; rows += chunkRowsOut.length;
			state.tables[table] = { last_key: after, rows, complete: final };
			save(state);
			if (final) break;
		}
	}
	// A replayed final chunk is not proof of publication: each snapshot set is done only when the server publishes this exact cut.
	if (sets.length) {
		const now = await client.status(profile);
		if (now.error) return { status: TRANSIENT.includes(now.error.code) ? "stopped" : "refused", reason: now.error.details?.reason ?? now.error.code };
		const unpublished = sets.find((set) => now.snapshots?.[set]?.published?.cut_id !== cutOf(set));
		if (unpublished) return { status: "stopped", reason: "snapshot_unpublished", set: unpublished };
	}
	return { status: "done", generation: st.generation, tables: state.tables };
}
