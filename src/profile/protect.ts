import { assertArchiveEndpoints } from "./archive-fence";
// Protection (section 12): background actors never retire, supersede, archive, merge, transfer or forget what the owner
// stated, pinned, or keeps in me. A refusal flags the node for the owner and changes nothing else.
import type { ArchiveTx } from "./archive";

export type Protection = "me" | "stated" | "pinned";
const BACKGROUND = new Set(["keep", "index", "maintenance"]);

/** null when `actor` may change the node; otherwise why not. An interactive agent or the owner may always change it. */
export function mayChange(node: { origin: string; pinned: number }, actor: string, profile: string): Protection | null {
	if (!BACKGROUND.has(actor)) return null;
	return profile === "me" ? "me" : node.origin === "stated" ? "stated" : node.pinned ? "pinned" : null;
}

/**
 * Sets `flagged` to `<op>: <reason>` for the owner and logs an activity row with ids and the op only, since a maintenance
 * reason is model text. The revision is unchanged; undo puts the previous flag back. Returns the activity id.
 */
export function flagProtected(tx: ArchiveTx, nodeId: string, reason: string, op: string, actor: string): number {
	assertArchiveEndpoints(tx.sql,nodeId,nodeId,"");
	const prev = tx.sql.exec<{ flagged: string | null }>("SELECT flagged FROM nodes WHERE id = ?", nodeId).one().flagged;
	tx.run("UPDATE nodes SET flagged = ?, seq = ? WHERE id = ?", `${op}: ${reason}`, tx.seq, nodeId);
	return Number(tx.run("INSERT INTO activity (at, actor, op, summary, targets, undo, seq) VALUES (?, ?, 'flag', ?, ?, ?, ?) RETURNING id",
		tx.now, actor, `flagged instead of ${op}`, JSON.stringify([nodeId]), JSON.stringify({ seq: tx.seq, flags: [{ id: nodeId, flagged: prev }] }), tx.seq).one().id);
}
