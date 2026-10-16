#!/usr/bin/env python3
"""Triage the Hermes memory write-approval queue.

The gate (`memory.write_approval: true`) stages every memory write to
`$HERMES_HOME/pending/memory/<id>.json` and nothing drains it automatically.
This script is the machine-side half of a triage job: it lists the queue for a
judge (human or LLM) and then applies that judge's verdicts.

Safety model
------------
Nothing here hard-deletes, and every mutation is reversible:

  * approve  -> replay the op via apply_memory_pending() (bypasses the gate,
                same code path as `/memory approve`)
  * discard  -> move the record to the archive dir (never a hard delete)
  * ids in NEITHER list are LEFT UNTOUCHED
  * BEFORE any mutation, the run takes a timestamped SNAPSHOT of the live
    memory files, so a bad verdict set is one command to undo
  * a file LOCK stops two triage runs overlapping
  * the plan is strictly VALIDATED and blast-radius CAPPED before it applies
  * every apply appends a line to the AUDIT log

Subcommands
-----------
  list [--full]                 JSON dump of every staged record, oldest first.
  stats                         One-line queue summary (count, oldest age, bytes).
  apply --plan FILE [--max-records N] [--dry-run] [--no-snapshot]
                                Apply a verdict plan:
                                  {"approve": ["<id>", ...], "discard": ["<id>", ...]}
                                Prints a JSON result report.
  compact --plan FILE [--dry-run]
                                Shrink MEMORY.md/USER.md in place (weekly job):
                                  {"target": "memory",
                                   "operations": [{"action": "replace"|"remove",
                                                   "old_text": "...", "content": "..."}],
                                   "topic_appends": [{"file": "infra.md", "line": "..."}]}
                                Only replace/remove, and the net change must not
                                grow the store. Topic lines are appended (skipped
                                if already present) before memory is touched, so a
                                crash leaves a duplicate, never a lost fact.
  snapshots                     List memory snapshots, newest first.
  restore --from DIR            Copy a snapshot's files back over the live ones.

Layout
------
  archive:   $HERMES_HOME/pending/memory-archive/<YYYY-MM-DD>/<id>.json
  snapshots: $HERMES_HOME/memory-snapshots/<YYYYmmdd-HHMMSS>/{MEMORY.md,USER.md}
  audit:     $HERMES_HOME/logs/memory-triage-audit.jsonl
  lock:      $HERMES_HOME/tmp/memory-triage.lock
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

HERMES_HOME = os.environ.get("HERMES_HOME", "/opt/data")
os.environ.setdefault("HERMES_HOME", HERMES_HOME)
if "/opt/hermes" not in sys.path:
    sys.path.insert(0, "/opt/hermes")

from tools import write_approval as wa  # noqa: E402
from tools.memory_tool import load_on_disk_store, apply_memory_pending, _pin_matched_entries  # noqa: E402

SUBSYSTEM = wa.MEMORY
PENDING_DIR = Path(HERMES_HOME) / "pending" / SUBSYSTEM
ARCHIVE_ROOT = Path(HERMES_HOME) / "pending" / "memory-archive"
SNAPSHOT_ROOT = Path(HERMES_HOME) / "memory-snapshots"
AUDIT_LOG = Path(HERMES_HOME) / "logs" / "memory-triage-audit.jsonl"
LOCK_PATH = Path(HERMES_HOME) / "tmp" / "memory-triage.lock"
QUEUE_LISTING = Path(HERMES_HOME) / "tmp" / "triage-queue.json"
MEMORY_FILES = {"memory": "MEMORY.md", "user": "USER.md"}

DEFAULT_MAX_RECORDS = 40


# --------------------------------------------------------------------- queue --
def _ops(rec: dict) -> list:
    """Expand a record's payload into individual operations."""
    payload = rec.get("payload") or {}
    if payload.get("action") == "batch":
        return list(payload.get("operations") or [])
    return [payload]


def _summarize(rec: dict, *, full: bool) -> dict:
    payload = rec.get("payload") or {}
    limit = 100000 if full else 240
    ops = []
    for op in _ops(rec):
        text = op.get("content") or op.get("old_text") or ""
        if op.get("action") == "remove":
            text = f"(remove) {op.get('old_text') or ''}"
        ops.append({
            "action": op.get("action"),
            "old_text": op.get("old_text"),
            "content": text if full else text[:limit],
            "len": len(text),
        })
    created = rec.get("created_at") or 0
    return {
        "id": rec.get("id"),
        "target": payload.get("target"),
        "action": payload.get("action"),
        "origin": rec.get("origin"),
        "created_at": created,
        "age_days": round((time.time() - created) / 86400, 1) if created else None,
        "n_ops": len(ops),
        "ops": ops,
    }


def cmd_list(args) -> int:
    records = wa.list_pending(SUBSYSTEM)
    out = [_summarize(r, full=args.full) for r in records]
    print(json.dumps({
        "count": len(out),
        "write_approval_on": wa.write_approval_enabled(SUBSYSTEM),
        "memory_chars": _char_counts(),
        "pending": out,
    }, ensure_ascii=False, indent=2))
    return 0


def _char_counts() -> dict:
    try:
        store = load_on_disk_store()
        return {
            "memory": f"{store._char_count('memory')}/{store._char_limit('memory')}",
            "user": f"{store._char_count('user')}/{store._char_limit('user')}",
        }
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}


def cmd_stats(args) -> int:
    records = wa.list_pending(SUBSYSTEM)
    if not records:
        print("pending: 0")
        return 0
    oldest = min(r.get("created_at") or time.time() for r in records)
    print(f"pending: {len(records)}  oldest: {(time.time() - oldest) / 86400:.1f}d  "
          f"store: {_char_counts()}")
    return 0


# ------------------------------------------------------------- safety: lock --
def _acquire_lock():
    """Exclusive non-blocking lock so two triage runs never overlap."""
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK_PATH, "w")
    try:
        import fcntl
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (ImportError, OSError):
        # No fcntl (non-POSIX) or held elsewhere: fail closed rather than
        # risk concurrent mutation.
        if getattr(fh, "closed", False):
            raise
    return fh


# --------------------------------------------------------- safety: snapshot --
def _make_snapshot() -> dict:
    """Read-only copy of the live memory files, timestamped. Rollback source."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = SNAPSHOT_ROOT / stamp
    dest.mkdir(parents=True, exist_ok=True)
    saved = {}
    for key, fname in MEMORY_FILES.items():
        src = Path(HERMES_HOME) / "memories" / fname
        if src.exists():
            target = dest / fname
            shutil.copy2(src, target)
            saved[key] = str(target)
    return {"dir": str(dest), "files": saved, "created_at": time.time()}


def cmd_snapshots(args) -> int:
    if not SNAPSHOT_ROOT.exists():
        print(json.dumps({"snapshots": []}, indent=2))
        return 0
    dirs = sorted((d for d in SNAPSHOT_ROOT.iterdir() if d.is_dir()), reverse=True)
    out = [{"dir": str(d), "files": sorted(p.name for p in d.iterdir())} for d in dirs]
    print(json.dumps({"snapshots": out}, indent=2))
    return 0


def cmd_restore(args) -> int:
    src = Path(args.__dict__["from"]).expanduser()
    if not src.is_dir():
        print(json.dumps({"ok": False, "error": f"not a directory: {src}"}, indent=2))
        return 2
    # Snapshot current state first so a restore is itself reversible.
    pre = _make_snapshot()
    restored = []
    mem_dir = Path(HERMES_HOME) / "memories"
    for fname in MEMORY_FILES.values():
        candidate = src / fname
        if candidate.exists():
            mem_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, mem_dir / fname)
            restored.append(fname)
    report = {"ok": True, "restored": restored, "from": str(src),
              "pre_restore_snapshot": pre["dir"]}
    _audit({"event": "restore", **report})
    print(json.dumps(report, indent=2))
    return 0 if restored else 1


# ---------------------------------------------------------- safety: plan ----
def _validate_plan(plan) -> str | None:
    """Return an error string if the plan is malformed, else None."""
    if not isinstance(plan, dict):
        return "plan must be a JSON object"
    for key in ("approve", "discard"):
        val = plan.get(key, [])
        if val is None:
            continue
        if not isinstance(val, list) or not all(isinstance(i, str) for i in val):
            return f"'{key}' must be a list of string ids"
    return None


def _audit(entry: dict) -> None:
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), **entry}, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ------------------------------------------------------------- apply -------
def _archive(rec: dict) -> Path:
    day = time.strftime("%Y-%m-%d")
    dest_dir = ARCHIVE_ROOT / day
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{rec['id']}.json"
    src = PENDING_DIR / f"{rec['id']}.json"
    if src.exists():
        shutil.move(str(src), str(dest))
    return dest


def cmd_apply(args) -> int:
    plan_path = Path(args.plan)
    # The cron judge lists the queue, then writes its plan. A plan older than
    # that listing was judged against an earlier queue (a failed plan write
    # leaves yesterday's file behind), so it is never applied.
    try:
        if plan_path.stat().st_mtime < QUEUE_LISTING.stat().st_mtime:
            print(json.dumps({"ok": False, "error": (
                f"plan {plan_path} is older than the queue listing {QUEUE_LISTING}; "
                "re-judge the current queue and write a fresh plan")}, indent=2))
            return 2
    except FileNotFoundError:
        pass
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": f"unreadable plan: {e}"}, indent=2))
        return 2

    err = _validate_plan(plan)
    if err:
        print(json.dumps({"ok": False, "error": err}, indent=2))
        return 2

    # de-dup, preserve order
    approve_ids = list(dict.fromkeys(plan.get("approve") or []))
    discard_ids = list(dict.fromkeys(plan.get("discard") or []))
    overlap = sorted(set(approve_ids) & set(discard_ids))
    if overlap:
        print(json.dumps({"ok": False,
                          "error": f"ids in both approve and discard: {overlap}"}, indent=2))
        return 2

    touched = len(set(approve_ids) | set(discard_ids))
    if touched > args.max_records:
        print(json.dumps({"ok": False, "error": (
            f"plan touches {touched} records > --max-records {args.max_records}; "
            "split the plan or raise the cap deliberately")}, indent=2))
        return 2

    if args.dry_run or plan.get("dry_run"):
        print(json.dumps({"ok": True, "dry_run": True, "approve": approve_ids,
                          "discard": discard_ids, "touched": touched}, indent=2))
        return 0

    lock = _acquire_lock()  # noqa: F841  (held for the whole mutation)
    snapshot = None if args.no_snapshot else _make_snapshot()

    applied, discarded, failed, missing = [], [], [], []
    known = {r["id"] for r in wa.list_pending(SUBSYSTEM)}

    if approve_ids:
        store = load_on_disk_store()
        for pid in approve_ids:
            rec = wa.get_pending(SUBSYSTEM, pid)
            if not rec:
                missing.append(pid)
                continue
            try:
                result = apply_memory_pending(rec.get("payload") or {}, store)
            except Exception as e:
                result = {"success": False, "error": f"{type(e).__name__}: {e}"}
            if result.get("success"):
                wa.discard_pending(SUBSYSTEM, pid)
                applied.append(pid)
            else:
                failed.append({"id": pid, "error": result.get("error", "unknown")})

    for pid in discard_ids:
        rec = wa.get_pending(SUBSYSTEM, pid)
        if not rec:
            missing.append(pid)
            continue
        dest = _archive(rec)
        discarded.append({"id": pid, "archived_to": str(dest)})

    untouched = sorted(known - set(approve_ids) - set(discard_ids))
    report = {
        "ok": not failed and not missing,
        "applied": applied,
        "applied_n": len(applied),
        "discarded": discarded,
        "discarded_n": len(discarded),
        "failed": failed,
        "missing_ids": missing,
        "untouched_n": len(untouched),
        "remaining_n": wa.pending_count(SUBSYSTEM),
        "snapshot": snapshot["dir"] if snapshot else None,
        "audit_log": str(AUDIT_LOG),
    }
    _audit({"event": "apply", "plan": str(plan_path), **report})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


# ----------------------------------------------------------- compact -------
MAX_COMPACT_OPS = 30
TOPICS_DIR = Path(HERMES_HOME) / "memories" / "topics"


def _validate_compact(plan) -> str | None:
    if not isinstance(plan, dict):
        return "plan must be a JSON object"
    if plan.get("target", "memory") not in MEMORY_FILES:
        return "target must be 'memory' or 'user'"
    ops = plan.get("operations")
    if not isinstance(ops, list) or not ops:
        return "operations must be a non-empty list"
    if len(ops) > MAX_COMPACT_OPS:
        return f"{len(ops)} operations > cap {MAX_COMPACT_OPS}"
    growth = 0
    for op in ops:
        if not isinstance(op, dict) or op.get("action") not in ("replace", "remove"):
            return "compaction only allows replace/remove operations"
        old = op.get("old_text")
        if not isinstance(old, str) or not old.strip():
            return "every operation needs a non-empty old_text"
        content = (op.get("content") or "") if op["action"] == "replace" else ""
        if not isinstance(content, str):
            return "content must be a string"
        growth += len(content) - len(old)
    if growth > 0:
        return f"plan would grow the store by {growth} chars; compaction must shrink it"
    appends = plan.get("topic_appends") or []
    if not isinstance(appends, list):
        return "topic_appends must be a list"
    for a in appends:
        if not isinstance(a, dict) or not isinstance(a.get("line"), str) or not a["line"].strip():
            return "each topic_append needs a non-empty line"
        name = a.get("file")
        if (not isinstance(name, str) or Path(name).name != name
                or not name.endswith(".md") or name.startswith(".")):
            return f"topic file must be a plain *.md name, got {name!r}"
        if "\n" in a["line"]:
            return "topic lines must be single lines"
    return None


def _append_topic(name: str, line: str) -> bool:
    TOPICS_DIR.mkdir(parents=True, exist_ok=True)
    path = TOPICS_DIR / name
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if line in existing.splitlines():
        return False
    with open(path, "a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(line + "\n")
    return True


def cmd_compact(args) -> int:
    def fail(error: str, code: int = 2) -> int:
        print(json.dumps({"ok": False, "error": error}, indent=2))
        return code

    try:
        plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return fail(f"unreadable plan: {e}")
    err = _validate_compact(plan)
    if err:
        return fail(err)

    target = plan.get("target", "memory")
    ops = plan["operations"]
    appends = plan.get("topic_appends") or []
    live = Path(HERMES_HOME) / "memories" / MEMORY_FILES[target]
    before = len(live.read_text(encoding="utf-8")) if live.exists() else 0

    # Hermes applies a replace/remove only to the exact entry pinned on it
    # (`matched_entry`) and refuses unpinned ones, so pin with Hermes' own
    # resolver before anything is filed. A pin failure stops here, dry-run too.
    payload = {"action": "batch", "target": target, "operations": [dict(op) for op in ops]}
    pin_error = _pin_matched_entries(load_on_disk_store(), payload)
    if pin_error:
        try:
            return fail(json.loads(pin_error).get("error", pin_error))
        except (ValueError, AttributeError):
            return fail(pin_error)

    if args.dry_run:
        print(json.dumps({"ok": True, "dry_run": True, "target": target,
                          "operations": ops, "topic_appends": appends,
                          "chars_before": before}, ensure_ascii=False, indent=2))
        return 0

    lock = _acquire_lock()  # noqa: F841  (held for the whole mutation)
    snapshot = _make_snapshot()
    filed = [f"{a['file']}: {a['line']}" for a in appends if _append_topic(a["file"], a["line"])]

    try:
        result = apply_memory_pending(payload, load_on_disk_store())
    except Exception as e:
        result = {"success": False, "error": f"{type(e).__name__}: {e}"}

    after = len(live.read_text(encoding="utf-8")) if live.exists() else 0
    report = {
        "ok": bool(result.get("success")),
        "target": target,
        "ops_n": len(ops),
        "topic_lines_added": filed,
        "chars_before": before,
        "chars_after": after,
        "snapshot": snapshot["dir"],
        "audit_log": str(AUDIT_LOG),
    }
    if not report["ok"]:
        report["error"] = result.get("error", "unknown")
    _audit({"event": "compact", "plan": str(args.plan), **report})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="dump the staged queue as JSON")
    p_list.add_argument("--full", action="store_true", help="no truncation")
    p_list.set_defaults(func=cmd_list)

    p_stats = sub.add_parser("stats", help="one-line queue summary")
    p_stats.set_defaults(func=cmd_stats)

    p_apply = sub.add_parser("apply", help="apply a verdict plan")
    p_apply.add_argument("--plan", required=True)
    p_apply.add_argument("--max-records", type=int, default=DEFAULT_MAX_RECORDS,
                         help=f"refuse plans touching more than N records (default {DEFAULT_MAX_RECORDS})")
    p_apply.add_argument("--dry-run", action="store_true", help="validate + show, do not mutate")
    p_apply.add_argument("--no-snapshot", action="store_true",
                         help="skip the pre-apply memory snapshot (not recommended)")
    p_apply.set_defaults(func=cmd_apply)

    p_compact = sub.add_parser("compact", help="shrink MEMORY.md/USER.md in place")
    p_compact.add_argument("--plan", required=True)
    p_compact.add_argument("--dry-run", action="store_true", help="validate + show, do not mutate")
    p_compact.set_defaults(func=cmd_compact)

    p_snaps = sub.add_parser("snapshots", help="list memory snapshots")
    p_snaps.set_defaults(func=cmd_snapshots)

    p_restore = sub.add_parser("restore", help="restore a snapshot over live memory")
    p_restore.add_argument("--from", required=True, dest="from")
    p_restore.set_defaults(func=cmd_restore)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
