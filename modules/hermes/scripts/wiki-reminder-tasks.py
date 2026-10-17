#!/usr/bin/env python3
"""Create deduplicated Google Tasks for wiki reminder candidates.

Reads candidate JSON on stdin, enforces per-type lead windows, and invokes
`gtasks` with argument arrays (never shell). It never edits task text or
due dates, and never deletes; its only sanctioned mutation auto-closes
stale open daily-habit tasks dated before today (marks completed, keeps
them retrievable). Each candidate is processed independently: valid due
tasks are created first, then the stale-close sweep runs, then problems
are reported.
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
    "weekly": 0,
}


def marker_for(key, action_date):
    return f"{MARKER_PREFIX}{key}:{action_date}"


def view_tasks():
    """Full Planned-list records, completed included.

    The view is capped at 100 records (no pagination in the gtasks CLI) —
    a pre-existing, silently accepted limit for both same-day marker skip
    and sweep coverage beyond page 1.
    """
    proc = subprocess.run(
        ["gtasks", "tasks", "-l", TASK_LIST, "view",
         "--format=json", "--include-completed"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"gtasks view failed: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as error:
        raise SystemExit(f"gtasks view returned invalid JSON: {error}")


def markers_from_tasks(tasks):
    """Derive {marker: due} from view_tasks() records."""
    found = {}
    for task in tasks:
        notes = task.get("description") or task.get("notes") or ""
        for line in str(notes).splitlines():
            line = line.strip()
            if line.startswith(MARKER_PREFIX):
                # Google returns due as RFC3339 (2026-10-17T00:00:00.000Z);
                # compare date-only so re-runs skip instead of conflicting.
                found[line] = str(task.get("due") or "").split("T")[0]
    return found


def existing_markers():
    """Return {marker: due} for every task in Planned, including completed."""
    return markers_from_tasks(view_tasks())


def close_stale_daily(tasks, daily_keys, current):
    """Close stale open daily-habit tasks from earlier days.

    Only tasks carrying our marker line, whose key is in today's daily
    candidates, whose stored date parses, is strictly before today, and
    whose status is the open `needsAction`, are closed — mark completed
    via `gtasks tasks done --id <taskId>`, never deleted. Anything
    ambiguous or unknown (missing/other status, missing id, unparseable
    date, unknown key) is skipped: the failure mode is a lingering task
    the user can still see, never a wrong close.
    """
    closed, problems = [], []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        status = task.get("status")
        task_id = task.get("id")
        # Only a known open status is closed: anything unknown (missing
        # status, unknown token) is skipped — a lingering task the user
        # can still see, never a wrong close.
        if status != "needsAction" or not task_id:
            continue
        due_date = None
        target = None
        for line in str(task.get("description")
                        or task.get("notes") or "").splitlines():
            line = line.strip()
            if not line.startswith(MARKER_PREFIX):
                continue
            # Date is after the LAST colon: keys may contain colons.
            key, _, date_text = line[len(MARKER_PREFIX):].rpartition(":")
            if key not in daily_keys:
                continue
            try:
                candidate_day = datetime_module.date.fromisoformat(
                    date_text.split("T")[0])
            except ValueError:
                continue
            if candidate_day < current:
                due_date = candidate_day
                target = task_id
                break
        if target is None:
            continue
        proc = subprocess.run(
            ["gtasks", "tasks", "done", "-l", TASK_LIST, "--id", target],
            capture_output=True, text=True, check=False,
        )
        if proc.returncode != 0:
            problems.append(f"close-failed: {key}: "
                            f"{(proc.stderr or proc.stdout).strip()}")
            continue
        closed.append(key)
    return closed, problems


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
        tasks = view_tasks()
        existing = markers_from_tasks(tasks)
    except SystemExit as error:
        print(error)
        return 2
    daily_keys = {item.get("key") for item in candidates
                  if isinstance(item, dict)
                  and item.get("type") == "daily"
                  and isinstance(item.get("key"), str) and item.get("key")}

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

    closed, close_failures = close_stale_daily(tasks, daily_keys, current)
    problems.extend(close_failures)

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
                        "pending": len(pending), "closed": len(closed)},
        })
    print(json.dumps({
        "created": created, "skipped": skipped,
        "pending": pending, "problems": problems,
        "closed": closed,
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
