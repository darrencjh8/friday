#!/usr/bin/env python3
"""Create deduplicated Google Tasks for wiki reminder candidates.

Reads candidate JSON on stdin, enforces per-type lead windows, and invokes
`gtasks` with argument arrays (never shell). Never updates, deletes, or
moves tasks. Each candidate is processed independently: valid due tasks are
created first, then problems are reported.
"""

import datetime as datetime_module
import json
import os
import subprocess
import sys

TASK_LIST = "Planned"
MARKER_PREFIX = "wiki-reminder-marker:"

LEAD_DAYS = {
    "claim_collect": 60,
    "cancel_replan": 30,
    "annual_oneoff": 7,
    "monthly": 3,
    "waiver_check": 0,
    "daily": 0,
}


def marker_for(key, action_date):
    return f"{MARKER_PREFIX}{key}:{action_date}"


def existing_markers():
    """Return {marker: due} for every task in Planned, including completed."""
    proc = subprocess.run(
        ["gtasks", "tasks", "-l", TASK_LIST, "view",
         "--format=json", "--include-completed"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"gtasks view failed: {proc.stderr.strip()}")
    try:
        tasks = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as error:
        raise SystemExit(f"gtasks view returned invalid JSON: {error}")
    found = {}
    for task in tasks:
        notes = task.get("description") or task.get("notes") or ""
        for line in str(notes).splitlines():
            line = line.strip()
            if line.startswith(MARKER_PREFIX):
                found[line] = task.get("due") or ""
    return found


def create_task(title, notes, due):
    proc = subprocess.run(
        ["gtasks", "tasks", "add", "-l", TASK_LIST,
         "-t", title, "-n", notes, "-d", due],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "gtasks add failed")
    return True


def today():
    return datetime_module.date.today()


SNAPSHOT_VERSION = 1


def write_snapshot(path, payload):
    """Atomic JSON snapshot for the reminders UI and the agent.

    The wiki stays the human-authored source; this file is the machine
    truth the dashboard renders and the next agent run reads instead of
    re-parsing prose dates. Task titles/notes are user data — the file
    lives on the persisted volume and is served tailnet-only.
    """
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    os.replace(tmp, path)


def main(today_override=None, snapshot_path=None):
    try:
        candidates = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(f"invalid candidate JSON: {error}")
        return 2
    if not isinstance(candidates, list):
        print("candidate JSON must be a list")
        return 2

    current = today_override or today()
    try:
        existing = existing_markers()
    except SystemExit as error:
        print(error)
        return 2

    created, skipped, pending = [], [], []
    problems = []
    items = []

    for item in candidates:
        if not isinstance(item, dict):
            problems.append("unclassified: non-object candidate")
            items.append({"key": "", "type": "", "title": "",
                          "action_date": "", "days_left": None,
                          "lead_days": None, "status": "unclassified",
                          "note": ""})
            continue
        key = item.get("key") or ""
        kind = item.get("type") or ""
        title = item.get("title") or ""
        action_date = item.get("action_date") or ""
        note = item.get("note") or ""
        if (
            not isinstance(kind, str)
            or kind not in LEAD_DAYS
            or not isinstance(key, str)
            or not key
            or not isinstance(title, str)
            or not title
            or not isinstance(action_date, str)
            or not isinstance(note, str)
            or "\n" in key
            or "\r" in key
        ):
            problems.append(f"unclassified: {key or title or item!r}")
            items.append({"key": key if isinstance(key, str) else "",
                          "type": kind if isinstance(kind, str) else "",
                          "title": title if isinstance(title, str) else "",
                          "action_date": action_date
                          if isinstance(action_date, str) else "",
                          "days_left": None, "lead_days": None,
                          "status": "unclassified",
                          "note": note if isinstance(note, str) else ""})
            continue
        try:
            due = datetime_module.date.fromisoformat(action_date)
        except ValueError:
            problems.append(f"unclassified: bad date {key}: {action_date!r}")
            items.append({"key": key, "type": kind, "title": title,
                          "action_date": action_date, "days_left": None,
                          "lead_days": None, "status": "unclassified",
                          "note": note})
            continue
        days_left = (due - current).days
        lead_days = LEAD_DAYS[kind]
        marker = marker_for(key, action_date)
        entry = {"key": key, "type": kind, "title": title,
                 "action_date": action_date, "days_left": days_left,
                 "lead_days": lead_days, "status": "", "note": note}
        if days_left < 0:
            problems.append(f"overdue-manual: {key} was due {action_date}")
            entry["status"] = "overdue-manual"
            items.append(entry)
            continue
        if days_left > lead_days:
            pending.append(f"{key} due {action_date} ({days_left}d)")
            entry["status"] = "pending"
            items.append(entry)
            continue
        if marker in existing:
            if existing[marker] and existing[marker] != action_date:
                problems.append(
                    f"conflict: {key} wiki date {action_date} "
                    f"vs task due {existing[marker]}"
                )
                entry["status"] = "conflict"
            else:
                skipped.append(key)
                entry["status"] = "skipped"
            items.append(entry)
            continue
        notes = note.rstrip() + f"\n{marker}"
        try:
            create_task(title, notes, action_date)
        except RuntimeError as error:
            problems.append(f"create-failed: {key}: {error}")
            entry["status"] = "create-failed"
            items.append(entry)
            continue
        existing[marker] = action_date
        created.append(key)
        entry["status"] = "created"
        items.append(entry)

    if snapshot_path:
        write_snapshot(snapshot_path, {
            "version": SNAPSHOT_VERSION,
            "generated_at": datetime_module.datetime.now(
                datetime_module.timezone.utc).isoformat(),
            "run_date": current.isoformat(),
            "task_list": TASK_LIST,
            "items": items,
            "problems": problems,
            "summary": {"created": len(created), "skipped": len(skipped),
                        "pending": len(pending)},
        })
    print(json.dumps({
        "created": created, "skipped": skipped,
        "pending": pending, "problems": problems,
    }, indent=2))
    return 1 if problems else 0


if __name__ == "__main__":
    snapshot = None
    argv = sys.argv[1:]
    if "--snapshot-out" in argv:
        idx = argv.index("--snapshot-out")
        try:
            snapshot = argv[idx + 1]
        except IndexError:
            raise SystemExit("--snapshot-out needs a path")
    else:
        for arg in argv:
            if arg.startswith("--snapshot-out="):
                snapshot = arg.split("=", 1)[1]
    raise SystemExit(main(snapshot_path=snapshot))
