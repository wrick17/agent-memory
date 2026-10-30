// Archive fences are checked in the synchronous mutation that owns the row, never before an await.
import { Fail } from "../domain/types";

export function archiveFenced(sql: SqlStorage, id: string, allow?:string): boolean {
	return sql.exec("SELECT 1 FROM nodes n JOIN profile_meta o ON o.key='archive-op:'||json_extract(n.attrs,'$.archive_operation') WHERE n.id=? AND n.status IN ('moving','incoming') AND json_extract(o.value,'$.node')=n.id AND json_extract(n.attrs,'$.archive_operation') IS NOT ?",id,allow??null).toArray().length>0;
}
export function assertArchiveEndpoints(sql: SqlStorage, src: string, dst: string, profile: string, transfer = false, allow?:string): void {
	for (const id of profile === "" ? [src, dst] : [src]) if (archiveFenced(sql, id, allow) || (transfer && sql.exec(`SELECT 1 FROM profile_meta i JOIN profile_meta o ON o.key='archive-op:'||json_extract(i.value,'$.operation')
		WHERE i.key>=? AND i.key<? AND (json_extract(o.value,'$.state') IN ('running','rolling_back') OR json_extract(o.value,'$.cleanup')=1) LIMIT 1`, `archive-node:${id}:`, `archive-node:${id}:~`).toArray().length)) {
		throw Fail.of("moving", "an endpoint has an unfinished archive operation", { memory_id: id, reason: "archive_operation" });
	}
}

/** Include live rows, archived lanes and retained immutable source parts throughout transfer cleanup. */
export function assertNoTouchingTransfer(sql: SqlStorage, node: string): void {
	const conflict = sql.exec(`SELECT t.id FROM transfers t WHERE
		(t.state NOT IN ('committed','aborted') OR EXISTS (SELECT 1 FROM transfer_parts p WHERE p.transfer_id = t.id)) AND
		(t.node_id = ?1 OR EXISTS (SELECT 1 FROM edges e WHERE
			(e.src = t.node_id AND e.dst_profile = '' AND e.dst = ?1) OR (e.src = ?1 AND e.dst_profile = '' AND e.dst = t.node_id)) OR
		EXISTS (SELECT 1 FROM archive a WHERE a.source = 'edges' AND
			((json_extract(a.payload,'$.src') = t.node_id AND json_extract(a.payload,'$.dst_profile') = '' AND json_extract(a.payload,'$.dst') = ?1) OR
			(json_extract(a.payload,'$.src') = ?1 AND json_extract(a.payload,'$.dst_profile') = '' AND json_extract(a.payload,'$.dst') = t.node_id))) OR
		EXISTS (SELECT 1 FROM transfer_parts p, json_each(CASE WHEN json_type(p.payload) = 'array' THEN p.payload ELSE '[]' END) j
			WHERE p.transfer_id = t.id AND
			((json_extract(j.value,'$[0]') = 'edges' AND json_extract(j.value,'$[1].dst_profile') = '' AND json_extract(j.value,'$[1].dst') = ?1) OR
			(json_extract(j.value,'$[0]') = 'archive' AND json_extract(j.value,'$[1].source') = 'edges' AND
			json_extract(json_extract(j.value,'$[1].payload'),'$.dst_profile') = '' AND json_extract(json_extract(j.value,'$[1].payload'),'$.dst') = ?1)))) LIMIT 1`, node).toArray();
	if (conflict.length) throw Fail.of("moving", "a touching transfer still owns copying or cleanup", { reason: "touching_transfer" });
}
