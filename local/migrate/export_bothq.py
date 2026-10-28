"""Read-only export of every BothQ memory record for the Agent Memory import (docs/import-implementation.md).

Run with BothQ's own interpreter so its configured driver is used as is:
    ~/Projects/bot_hq/graph-db/.venv/bin/python local/migrate/export_bothq.py --graph-db ~/Projects/bot_hq/graph-db --out DIR

Only read transactions run. Each record is read with its revisions, requests, steps and relationships, then its
fingerprint is read again; a record that changed in between is read again (BothQ writers keep running). Membership is
re-listed at the end and new records are exported in further rounds. Output is private (0700 directory, 0600 files);
stdout carries counts and hashes only, never memory text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

MEMORY_LABELS = ("MemoryRecord", "Rule", "Decision", "Resource", "Routine", "UserMemory")
LABEL_TO_TYPE = {"Rule": "feedback", "Decision": "project", "Resource": "reference", "Routine": "procedural", "UserMemory": "user"}
INTERNAL_RELS = ("HAS_STEP", "HAS_REVISION", "LATEST_REVISION")
RETRIES = 5
WHERE_MEMORY = " OR ".join(f"n:{label}" for label in MEMORY_LABELS)


def plain(value):
    """Driver values to JSON, keeping the type of every temporal or other non-JSON value."""
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return {"$float": repr(value)}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    iso = getattr(value, "iso_format", None)
    return {"$neo4j": type(value).__name__, "iso": iso()} if iso else {"$neo4j": type(value).__name__, "str": str(value)}


def dumps(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def list_members(tx) -> list[dict]:
    return [r.data() for r in tx.run(
        f"MATCH (n) WHERE {WHERE_MEMORY} RETURN elementId(n) AS eid, n.memory_id AS memory_id ORDER BY eid")]


def fingerprint(tx, eid: str):
    row = tx.run(
        f"""MATCH (n) WHERE elementId(n) = $eid AND ({WHERE_MEMORY})
        OPTIONAL MATCH (r:MemoryRevision) WHERE n.memory_id IS NOT NULL AND r.memory_id = n.memory_id
        WITH n, count(r) AS revs, max(r.revision) AS top
        OPTIONAL MATCH (q:MemoryRequest) WHERE n.memory_id IS NOT NULL AND q.memory_id = n.memory_id
        RETURN n._version AS version, n.content_hash AS content_hash, n._updated AS updated, revs, top,
               count(q) AS reqs, collect(q.request_id) AS req_ids""", eid=eid).single()
    if row is None:
        return None
    d = plain(row.data())
    d["req_ids"] = sorted(x for x in d["req_ids"] if x is not None)
    return d


def read_record(tx, eid: str):
    node = tx.run("MATCH (n) WHERE elementId(n) = $eid RETURN labels(n) AS labels, properties(n) AS props", eid=eid).single()
    if node is None:
        return None
    props = plain(node["props"])
    mid = props.get("memory_id")
    anchors = [plain(r.data()) for r in tx.run(
        """MATCH (n)-[b:BELONGS_TO]->(a) WHERE elementId(n) = $eid
        RETURN labels(a) AS labels, a.slug AS slug, a.name AS name, a.scope AS scope, properties(b) AS rel ORDER BY elementId(a)""", eid=eid)]
    steps = [plain(r.data()) for r in tx.run(
        """MATCH (n)-[h:HAS_STEP]->(s) WHERE elementId(n) = $eid
        OPTIONAL MATCH (s)-[:NEXT]->(nx)<-[:HAS_STEP]-(n)
        RETURN elementId(s) AS eid, labels(s) AS labels, properties(h) AS rel, properties(s) AS props, elementId(nx) AS next
        ORDER BY s.order, elementId(s)""", eid=eid)]
    rels = [plain(r.data()) for r in tx.run(
        f"""MATCH (n)-[r]-(m) WHERE elementId(n) = $eid AND NOT type(r) IN {list(INTERNAL_RELS)}
        RETURN type(r) AS type, startNode(r) = n AS outgoing, properties(r) AS props, elementId(m) AS other_eid,
               labels(m) AS other_labels, m.memory_id AS other_memory_id, m.name AS other_name, m.slug AS other_slug, m.scope AS other_scope
        ORDER BY type, outgoing, other_eid""", eid=eid)]
    revisions, requests, linked = [], [], 0
    if mid:
        revisions = [plain(r["props"]) for r in tx.run(
            "MATCH (r:MemoryRevision {memory_id: $mid}) RETURN properties(r) AS props ORDER BY r.revision, r.revision_id", mid=mid)]
        linked = tx.run("MATCH (n)-[:HAS_REVISION]->(r:MemoryRevision) WHERE elementId(n) = $eid RETURN count(r) AS c", eid=eid).single()["c"]
        requests = [plain(r["props"]) for r in tx.run(
            "MATCH (q:MemoryRequest {memory_id: $mid}) RETURN properties(q) AS props ORDER BY q.request_id", mid=mid)]
    return {"eid": eid, "labels": sorted(node["labels"]), "props": props, "anchors": anchors, "steps": steps, "relationships": rels,
            "revisions": revisions, "has_revision_links": linked, "requests": requests}


def resolve(record: dict, memory_config) -> dict:
    """BothQ's own identity rules (memory_store._candidate_type and _candidate_scope, memory_config.stable_memory_id)."""
    props, labels = record["props"], record["labels"]
    mtype = props.get("memory_type") if props.get("memory_type") in LABEL_TO_TYPE.values() else next(
        (LABEL_TO_TYPE[label] for label in LABEL_TO_TYPE if label in labels), None)
    scope = None
    if props.get("scope"):
        try:
            scope = memory_config.normalize_scope(props["scope"])
        except ValueError:
            scope = None
    else:
        tags = {"sequoia" if "Workplace" in a["labels"] and a.get("slug") == "sequoia" else "bot_hq" if "System" in a["labels"] and a.get("name") == "Bot HQ"
                else a.get("scope") if "MemoryScope" in a["labels"] else None for a in record["anchors"]}
        scope = "sequoia" if "sequoia" in tags else "bot_hq" if "bot_hq" in tags else None
    legacy_id = None
    if not props.get("memory_id") and mtype and scope and isinstance(props.get("name"), str) and props["name"].strip():
        legacy_id = memory_config.stable_memory_id(scope, mtype, props["name"])
    return {"bothq_type": mtype, "resolved_scope": scope, "legacy_id": legacy_id}


class Neo4jReader:
    """Every read goes through a read transaction of BothQ's own driver session."""

    def __init__(self, session):
        self.s = session

    def members(self):
        return self.s.execute_read(list_members)

    def fingerprint(self, eid):
        return self.s.execute_read(fingerprint, eid)

    def record(self, eid):
        return self.s.execute_read(read_record, eid)

    def totals(self, mids):
        def run(tx):
            t = tx.run("MATCH (r:MemoryRevision) WITH count(r) AS revs MATCH (q:MemoryRequest) RETURN revs, count(q) AS reqs").single().data()
            t["orphan_requests"] = [plain(r["props"]) for r in tx.run(
                "MATCH (q:MemoryRequest) WHERE q.memory_id IS NULL OR NOT q.memory_id IN $mids RETURN properties(q) AS props ORDER BY q.request_id", mids=mids)]
            t["orphan_revisions"] = tx.run("MATCH (r:MemoryRevision) WHERE r.memory_id IS NULL OR NOT r.memory_id IN $mids RETURN count(r) AS c", mids=mids).single()["c"]
            t["candidates"] = tx.run("MATCH (c:MemoryCandidate) RETURN count(c) AS c").single()["c"]
            return t
        return self.s.execute_read(run)


def read_consistent(reader, eid: str, retries: int = RETRIES):
    """The record, read between two equal fingerprints; ("vanished", None) or ("unstable", None) otherwise."""
    before = None
    for attempt in range(1, retries + 1):
        before = reader.fingerprint(eid)
        if before is None:
            return "vanished", None
        record = reader.record(eid)
        after = reader.fingerprint(eid)
        if record is not None and after == before:
            record["fingerprint"], record["attempts"] = after, attempt
            return "ok", record
    return "unstable", None


def export(reader, memory_config, out_dir: str, retries: int = RETRIES, max_rounds: int = 5) -> dict:
    """Exports every member, then lists members again and exports any that appeared, for up to `max_rounds` rounds."""
    done, vanished, unstable, rounds = {}, [], [], 0
    with open(os.path.join(out_dir, "records.jsonl"), "w", encoding="utf-8") as out:
        while rounds < max_rounds:
            rounds += 1
            todo = [m for m in reader.members() if m["eid"] not in done]
            if not todo:
                break
            for m in todo:
                status, record = read_consistent(reader, m["eid"], retries)
                if record is None:
                    (vanished if status == "vanished" else unstable).append(m["eid"])
                    done[m["eid"]] = None
                    continue
                record.update(resolve(record, memory_config))
                line = dumps(record)
                done[m["eid"]] = {"sha256": sha(line), "memory_id": record["props"].get("memory_id")}
                out.write(line + "\n")
    exported = {k: v for k, v in done.items() if v}
    t = reader.totals(sorted(v["memory_id"] for v in exported.values() if v["memory_id"]))
    with open(os.path.join(out_dir, "requests-unlinked.jsonl"), "w", encoding="utf-8") as f:
        for q in t["orphan_requests"]:
            f.write(dumps(q) + "\n")
    return {
        "records": len(exported), "vanished": sorted(vanished), "unstable": sorted(unstable), "rounds": rounds,
        "records_sha256": sha("\n".join(f"{k}:{v['sha256']}" for k, v in sorted(exported.items()))),
        "db_revisions": t["revs"], "db_requests": t["reqs"], "unlinked_requests": len(t["orphan_requests"]),
        "unlinked_revisions": t["orphan_revisions"], "candidates": t["candidates"],
    }


def self_test() -> int:
    """No database: a fake reader whose record changes between the first two fingerprints, and one that vanishes."""
    import tempfile
    class Cfg:
        @staticmethod
        def normalize_scope(v):
            return v.strip().casefold()
        @staticmethod
        def stable_memory_id(scope, mtype, name):
            return f"id:{scope}:{mtype}:{' '.join(name.split()).casefold()}"
    class Fake:
        def __init__(self):
            self.calls = {"a": 0}
            self.version = {"a": 1}
        def members(self):
            return [{"eid": "a", "memory_id": "m-a"}, {"eid": "b", "memory_id": None}, {"eid": "gone", "memory_id": None}]
        def fingerprint(self, eid):
            if eid == "gone":
                return None
            if eid == "a":
                self.calls["a"] += 1
                if self.calls["a"] == 2:
                    self.version["a"] = 2  # a writer committed between the record read and the second fingerprint
            return {"version": self.version.get(eid, 1)}
        def record(self, eid):
            labels = ["Decision", "MemoryRecord"] if eid == "a" else ["Rule"]
            props = {"memory_id": "m-a", "name": "A", "scope": "personal"} if eid == "a" else {"name": "  Legacy  Rule "}
            anchors = [] if eid == "a" else [{"labels": ["Workplace"], "slug": "sequoia", "name": "Sequoia", "scope": None, "rel": {}}]
            return {"eid": eid, "labels": labels, "props": props, "anchors": anchors, "steps": [], "relationships": [], "revisions": [],
                    "has_revision_links": 0, "requests": []}
        def totals(self, mids):
            return {"revs": 0, "reqs": 0, "orphan_requests": [], "orphan_revisions": 0, "candidates": 0}
    with tempfile.TemporaryDirectory() as d:
        summary = export(Fake(), Cfg, d)
        rows = [json.loads(x) for x in open(os.path.join(d, "records.jsonl"), encoding="utf-8")]
    by = {r["eid"]: r for r in rows}
    assert summary["records"] == 2 and summary["vanished"] == ["gone"] and summary["unstable"] == [], summary
    assert by["a"]["attempts"] == 2 and by["a"]["fingerprint"] == {"version": 2}, by["a"]
    assert by["b"]["resolved_scope"] == "sequoia" and by["b"]["bothq_type"] == "feedback" and by["b"]["legacy_id"] == "id:sequoia:feedback:legacy rule"
    print(dumps({"self_test": "ok", "summary": summary}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph-db")
    ap.add_argument("--out")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.graph_db or not a.out:
        ap.error("--graph-db and --out are required")
    os.umask(0o077)
    os.makedirs(a.out, mode=0o700, exist_ok=True)
    sys.path.insert(0, os.path.expanduser(a.graph_db))
    import client  # BothQ's configured driver; credentials stay inside it
    import memory_config
    config = memory_config.MemoryConfig.from_env()
    with client.get_driver().session(database=config.database, default_access_mode="READ") as session:
        summary = export(Neo4jReader(session), memory_config, a.out)
    client.close()
    print(dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
