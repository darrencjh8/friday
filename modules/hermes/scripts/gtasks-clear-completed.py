#!/usr/bin/env python3
"""Monthly no_agent cron: delete completed tasks in every Google Tasks list.

Kept: a completed wiki reminder whose marker date is today or later (or does
not parse), because wiki-reminder-tasks.py dedups on that marker and would
create the reminder again; and a completed task that a kept task names as
its parent, so deleting it cannot take a kept subtask with it. The list is
then cleared, which hides what was kept. Nothing open is touched. Prints
nothing on success (silent run); any API error exits non-zero, which the
scheduler reports as a failure.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtasks  # noqa: E402  (OAuth and API helpers; same directory)

MARKER_PREFIX = "wiki-reminder-marker:"


def _live_reminder(task, today):
    """A marker dated today or later, or one whose date does not parse."""
    for line in str(task.get("notes") or "").splitlines():
        line = line.strip()
        if line.startswith(MARKER_PREFIX):
            # Date is after the last colon: keys may contain colons.
            try:
                if datetime.date.fromisoformat(line.rpartition(":")[2][:10]) < today:
                    continue
            except ValueError:
                pass
            return True
    return False


def _clear_list(list_id, today):
    tasks = gtasks._ordered_tasks(list_id, include_completed=True)
    kept = [t for t in tasks if t.get("status") != "completed" or _live_reminder(t, today)]
    # Google Tasks nests one level, so a kept task's parent is the only ancestor.
    parents = {t.get("parent") for t in kept}
    for task in tasks:
        if task.get("status") == "completed" and task not in kept and task["id"] not in parents:
            gtasks._api("DELETE", gtasks._tasks_path(list_id, task["id"]))
    # An empty JSON body sends Content-Length; Google rejects a bodiless POST.
    gtasks._api("POST", gtasks._tasks_path(list_id, action="clear"), {})


def main(today=None):
    # Same clock as wiki-reminder-tasks.py, which also uses date.today() in this container.
    today = today or datetime.date.today()
    params = "maxResults=100"
    while True:
        out = gtasks._api("GET", "/users/@me/lists?" + params)
        for item in out.get("items", []):
            _clear_list(item["id"], today)
        if not out.get("nextPageToken"):
            return
        params = "maxResults=100&pageToken=" + out["nextPageToken"]


if __name__ == "__main__":
    main()
