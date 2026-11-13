#!/usr/bin/env python3
"""Forget stale Mnemosyne memories: candidates, guarded apply, retention prune.

Mnemosyne's sleep consolidation only compresses; nothing is ever dropped, so a
date the owner corrected keeps resurfacing in recall and sleep proposals. This
script is the forget half, run weekly before sleep:

  candidates          List rows that look stale and write them to
                      $HERMES_HOME/tmp/mnemosyne-forget-candidates.json for the
                      forget cron agent to judge. Read-only.
  apply --plan FILE   Forget the rows a plan names, after re-checking every
                      entry in code. --dry-run reports without writing.
  prune               Hard-delete archive entries older than 30 days and audit
                      entries older than a year.

A plan is {"forget": [{"id": ..., "reason": ..., "evidence_id": ...}]}. Each
reason is verified against the database, so the agent cannot drop a durable
fact on its own judgment:

  superseded         evidence_id names a newer owner message ("[USER] ...")
                     that reads as a correction and shares the row's subject.
  expired            the row is a one-off (reminder, deadline) whose event_date
                     has passed, and nothing marks it as recurring.
  noise              the row is test noise such as a memory probe.
  rejected_proposal  a sleep model-refresh proposal the owner rejected.

One bad entry refuses the whole plan. A forgotten row is first appended, in
full, to $HERMES_HOME/mnemosyne/archive/forgotten.jsonl, then deleted from the
live database together with what was derived from it: vectors, embeddings,
annotations, gists, extracted facts, and an episodic summary of that row alone.
A summary that also covers rows being kept is never touched, only reported, so
one stale line cannot take unrelated facts with it. An audit line without the
content goes to $HERMES_HOME/logs/mnemosyne-forget-audit.jsonl.
"""

import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
DATA_DIR = os.environ.get("MNEMOSYNE_DATA_DIR", os.path.join(HOME, "mnemosyne", "data"))
DB = os.path.join(DATA_DIR, "mnemosyne.db")
CANDIDATES = os.path.join(HOME, "tmp", "mnemosyne-forget-candidates.json")
ARCHIVE = os.path.join(HOME, "mnemosyne", "archive", "forgotten.jsonl")
AUDIT = os.path.join(HOME, "logs", "mnemosyne-forget-audit.jsonl")
ARCHIVE_DAYS = int(os.environ.get("MNEMOSYNE_FORGET_ARCHIVE_DAYS", "30"))
AUDIT_DAYS = int(os.environ.get("MNEMOSYNE_FORGET_AUDIT_DAYS", "365"))

REASONS = ("superseded", "expired", "noise", "rejected_proposal")
OWNER = "[USER]"
PROPOSAL_SOURCE = "sleep_model_refresh_proposal"
CORRECTION = re.compile(r"\b(shouldn'?t|should not|not the|actually|correction|wrong|instead|no longer|update all)\b", re.I)
ONE_OFF = re.compile(r"\b(remind(er)?|deadline|one[- ]off|appointment|due|by the)\b", re.I)
RECURRING = re.compile(r"\b(every|each|monthly|weekly|yearly|annual(ly)?|recurring|per (month|week|year))\b|/month", re.I)
NOISE = re.compile(r"\bmemory probe\b", re.I)
STOP = frozenset("""the and for that this with from are was were has have had but not you your
    yes our its it's should shouldn actually wrong correction instead longer update all reflect
    user replying please can will just also about into than then them they what when which""".split())
# Tables that hold rows derived from a memory, keyed by the memory id.
DERIVED = (("annotations", "memory_id"), ("gists", "memory_id"), ("memory_embeddings", "memory_id"),
           ("memory_events", "memory_id"), ("memory_validations", "memory_id"), ("facts", "source_msg_id"))
VECTORS = {"working_memory": "vec_working", "episodic_memory": "vec_episodes"}


def now():
    return datetime.datetime.now().astimezone()


def parse_time(value):
    try:
        parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.astimezone()


def tokens(text):
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) >= 3 and t not in STOP}


def sources(row):
    return [s for s in (row.get("summary_of") or "").split(",") if s]


def metadata(row):
    try:
        value = json.loads(row.get("metadata_json") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def is_owner(row):
    return row["content"].lstrip().startswith(OWNER)


def connect(readonly):
    uri = f"file:{DB}?mode=ro" if readonly else f"file:{DB}"
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def tables(conn):
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")}


def load_rows(conn):
    rows = {}
    for table in ("working_memory", "episodic_memory"):
        for r in conn.execute(f"SELECT rowid AS _rowid, * FROM {table}"):
            row = dict(r)
            row["_table"] = table
            rows[row["id"]] = row
    return rows


def corrections(rows):
    return [r for r in rows.values()
            if r["_table"] == "working_memory" and is_owner(r) and CORRECTION.search(r["content"])]


def supersedes(fix, row):
    """True when fix is a newer owner correction about the same subject as row."""
    if fix["id"] == row["id"] or not is_owner(fix) or not CORRECTION.search(fix["content"]):
        return False
    fixed, written = parse_time(fix["timestamp"]), parse_time(row["timestamp"])
    if not fixed or not written or fixed <= written:
        return False
    return len(tokens(fix["content"]) & tokens(row["content"])) >= 2


def check(row, reason, evidence, today):
    """Return why this row may not be forgotten for this reason, or None."""
    if reason not in REASONS:
        return f"unknown reason {reason!r}"
    if row["_table"] == "episodic_memory" and len(sources(row)) > 1:
        return "multi-fact summary; forget its source rows instead"
    if reason == "superseded":
        if not evidence:
            return "superseded needs evidence_id of a newer owner correction"
        if not supersedes(evidence, row):
            return f"{evidence['id']} is not a newer owner correction about the same subject"
    elif reason == "expired":
        event = (row.get("event_date") or "")[:10]
        if not event or event >= today:
            return "no past event_date"
        if not ONE_OFF.search(row["content"]) or RECURRING.search(row["content"]):
            return "not a one-off"
    elif reason == "noise":
        if not NOISE.search(row["content"]):
            return "does not look like test noise"
    elif row.get("source") != PROPOSAL_SOURCE or metadata(row).get("status") != "rejected":
        return "not a rejected model-refresh proposal"
    return None


def find_candidates(conn):
    rows = load_rows(conn)
    fixes = corrections(rows)
    today = now().date().isoformat()
    found = []
    for row in rows.values():
        evidence = [f for f in fixes if supersedes(f, row)]
        for reason in REASONS[::-1]:  # most specific hint first
            if check(row, reason, evidence[0] if evidence else None, today) is None:
                found.append({
                    "id": row["id"], "table": row["_table"], "hint": reason, "source": row.get("source"),
                    "timestamp": row.get("timestamp"), "event_date": row.get("event_date"),
                    "content": row["content"][:500],
                    "evidence": [{"id": f["id"], "timestamp": f["timestamp"], "content": f["content"][:500]}
                                 for f in evidence],
                })
                break
    found.sort(key=lambda c: c["id"])
    return found


def write_candidates(found):
    os.makedirs(os.path.dirname(CANDIDATES), exist_ok=True)
    tmp = CANDIDATES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump({"generated_at": now().isoformat(), "candidates": found}, handle, indent=2)
    os.replace(tmp, CANDIDATES)


def cmd_candidates(_args):
    if not os.path.exists(DB):
        found = []
    else:
        with connect(readonly=True) as conn:
            found = find_candidates(conn)
    write_candidates(found)
    print(json.dumps({"candidates": len(found), "file": CANDIDATES}))
    return 0


def load_vec(conn):
    """Load sqlite-vec so vector rows can be deleted; False when unavailable."""
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        return True
    except Exception:
        return False


def reexec_in_plugin_env():
    """Run again under the Mnemosyne plugin's Python, which ships sqlite-vec."""
    if os.environ.get("MNEMOSYNE_FORGET_REEXEC"):
        return
    for python in sorted(glob.glob(os.path.join(HOME, "installs", "*", "environments", "*", "venv", "bin", "python"))):
        os.environ["MNEMOSYNE_FORGET_REEXEC"] = "1"
        os.execv(python, [python, os.path.abspath(__file__), *sys.argv[1:]])


def append_jsonl(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def fail(message):
    print(json.dumps({"error": message}))
    return 1


def cmd_apply(args):
    with open(args.plan, encoding="utf-8") as handle:
        plan = json.load(handle).get("forget") or []
    if not os.path.exists(DB):
        return fail(f"no database at {DB}")
    conn = connect(readonly=False)
    try:
        present = tables(conn)
        vec_tables = [t for t in VECTORS.values() if t in present]
        if vec_tables and not load_vec(conn):
            conn.close()
            reexec_in_plugin_env()
            return fail(f"cannot load sqlite_vec to clean {', '.join(vec_tables)}; nothing forgotten")
        conn.execute(f"PRAGMA busy_timeout={int(os.environ.get('MNEMOSYNE_FORGET_BUSY_TIMEOUT', '30000'))}")
        conn.execute("BEGIN IMMEDIATE")
        rows = load_rows(conn)
        today = now().date().isoformat()

        errors, chosen = [], {}
        for entry in plan:
            row = rows.get(entry.get("id"))
            if row is None:
                errors.append(f"{entry.get('id')}: no such memory")
                continue
            why = check(row, entry.get("reason"), rows.get(entry.get("evidence_id") or ""), today)
            if why is None and entry.get("evidence_id") in {e["id"] for e in plan}:
                why = "evidence is itself being forgotten"
            if why:
                errors.append(f"{row['id']}: {why}")
            else:
                chosen[row["id"]] = (row, entry["reason"], entry.get("evidence_id"))
        if errors:
            conn.rollback()
            return fail("plan refused, nothing forgotten: " + "; ".join(errors))

        # An episodic summary goes with its sources only when every source is
        # forgotten; a summary that also covers kept rows is left and reported.
        kept = []
        for row in rows.values():
            covered = [s for s in sources(row) if s in chosen]
            if row["_table"] != "episodic_memory" or not covered or row["id"] in chosen:
                continue
            if len(covered) == len(sources(row)):
                chosen[row["id"]] = (row, "derived", covered[0])
            else:
                kept.append(row["id"])

        stamp = now().isoformat()
        archive, audit = [], []
        for memory_id, (row, reason, evidence_id) in sorted(chosen.items()):
            clean = {k: v for k, v in row.items() if not k.startswith("_") and not isinstance(v, bytes)}
            archive.append({"forgotten_at": stamp, "table": row["_table"], "reason": reason,
                            "evidence_id": evidence_id, "row": clean})
            audit.append({"forgotten_at": stamp, "id": memory_id, "table": row["_table"], "reason": reason,
                          "evidence_id": evidence_id,
                          "content_sha256": hashlib.sha256(row["content"].encode("utf-8")).hexdigest()})
        report = {"dry_run": args.dry_run, "forgotten": [{k: a[k] for k in ("id", "table", "reason", "evidence_id")}
                                                        for a in audit], "kept_summaries": sorted(kept)}
        if args.dry_run or not chosen:
            conn.rollback()
            print(json.dumps(report))
            return 0

        # Archive first, so a crash between the two leaves a copy rather than a loss.
        append_jsonl(ARCHIVE, archive)
        ids = list(chosen)
        marks = ",".join("?" * len(ids))
        for memory_id, (row, _reason, _evidence) in chosen.items():
            vec = VECTORS[row["_table"]]
            if vec in present:
                conn.execute(f"DELETE FROM {vec} WHERE rowid = ?", (row["_rowid"],))
        for table, column in DERIVED:
            if table in present:
                conn.execute(f"DELETE FROM {table} WHERE {column} IN ({marks})", ids)
        if "consolidated_facts" in present:
            for fact_id, sources_json in conn.execute("SELECT id, sources_json FROM consolidated_facts").fetchall():
                try:
                    fact_sources = json.loads(sources_json or "[]")
                except ValueError:
                    continue
                if fact_sources and set(fact_sources) <= chosen.keys():
                    conn.execute("DELETE FROM consolidated_facts WHERE id = ?", (fact_id,))
        for table in VECTORS:
            # FTS rows go with the base row through Mnemosyne's delete triggers.
            conn.execute(f"DELETE FROM {table} WHERE id IN ({marks})", ids)
        conn.commit()
        append_jsonl(AUDIT, audit)
        print(json.dumps(report))
        return 0
    finally:
        conn.close()


def prune_file(path, days):
    if not os.path.exists(path):
        return 0
    cutoff = now() - datetime.timedelta(days=days)
    kept, dropped = [], 0
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            stamp = parse_time(json.loads(line).get("forgotten_at", ""))
            if stamp and stamp < cutoff:
                dropped += 1
            else:
                kept.append(line if line.endswith("\n") else line + "\n")
    if dropped:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.writelines(kept)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    return dropped


def cmd_prune(_args):
    print(json.dumps({"archive_pruned": prune_file(ARCHIVE, ARCHIVE_DAYS),
                      "audit_pruned": prune_file(AUDIT, AUDIT_DAYS)}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("candidates").set_defaults(func=cmd_candidates)
    apply = sub.add_parser("apply")
    apply.add_argument("--plan", required=True)
    apply.add_argument("--dry-run", action="store_true")
    apply.set_defaults(func=cmd_apply)
    sub.add_parser("prune").set_defaults(func=cmd_prune)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
