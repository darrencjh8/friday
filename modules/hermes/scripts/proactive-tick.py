#!/usr/bin/env python3
"""Pre-run context script for the proactive-tick cron job.

Gathers what changed since the last run from each source and prints it; the
cron injects stdout into the job prompt, and the agent decides what is worth
telling Darren. Empty stdout skips the agent run entirely, so a tick with
nothing new costs no tokens. The script never decides relevance: it only
collects and de-duplicates, so new kinds of signal need a source here, not
rules.

Each item is reported once: what is printed is recorded in the state file
before the agent runs.
ponytail: an agent run that fails after the state write drops that item until
it changes or comes due again; a delivery-confirmed ledger would close that if
it ever matters.

Sources:
- goals: active Mnemosyne goal slots whose check-in is due, at most once a day.
- patch: the Mnemosyne cron read-only patch is missing (an upgrade or reinstall
  overwrote it), at most once a day.
- mail: Gmail messages that arrived since the last tick (promotions, social and
  forums skipped), through the read-only gmail.py. Off until `gmail login`; the
  first tick after login only sets the cursor, so old mail is never replayed.
- tasks: open items on Friday's own Google Tasks list that are due today or
  earlier, at most once a day each.
When any source has something, the open Friday tasks and Darren's notify
preferences are added as context so the agent can match mail to what it
already tracks.

Reads only: the Mnemosyne DB is opened read-only and Gmail access is the
gmail.readonly scope.
"""

import datetime
import functools
import glob
import json
import os
import sqlite3
import subprocess
import sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
DB = os.path.join(os.environ.get("MNEMOSYNE_DATA_DIR") or os.path.join(HOME, "mnemosyne", "data"), "mnemosyne.db")
STATE = os.path.join(HOME, "proactive-tick", "state.json")
PATCH_GLOB = os.path.join(HOME, "installs/*/environments/*/venv/lib/python3*/site-packages/mnemosyne_hermes/__init__.py")
PATCH_MARKER = "# friday-patch: mnemosyne read-only in cron"
SGT = datetime.timezone(datetime.timedelta(hours=8))
SCRIPTS = os.path.dirname(os.path.abspath(__file__))
TASK_LIST = "Friday"
MAIL_PER_TICK = 20


def parse_body(body):
    fields = {}
    for line in body.splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() and key.strip() not in fields:
            fields[key.strip().lower()] = value.strip()
    return fields


def parse_date(value):
    try:
        return datetime.date.fromisoformat(value[:10])
    except (TypeError, ValueError):
        return None


def is_due(fields, today):
    if fields.get("status", "").lower() != "active":
        return False
    check_in = fields.get("check_in", "").lower()
    if check_in == "daily":
        return True
    if check_in == "weekly":
        updated = parse_date(fields.get("updated", ""))
        return updated is None or (today - updated).days >= 7
    due = parse_date(check_in)
    return due is not None and due <= today


def read_slots(category):
    if not os.path.exists(DB):
        return []
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    try:
        return conn.execute(
            "SELECT name, body FROM canonical_facts WHERE category = ? AND valid_until IS NULL ORDER BY name",
            (category,),
        ).fetchall()
    finally:
        conn.close()


def goals_source(today, seen, cursors):
    items = []
    for name, body in read_slots("goal"):
        key = f"goal:{name}"
        if seen.get(key) != today.isoformat() and is_due(parse_body(body), today):
            items.append((key, f"goal `{name}`\n{body.strip()}"))
    return items


def patch_source(today, seen, cursors):
    key = "patch:mnemosyne-cron-readonly"
    if seen.get(key) == today.isoformat():
        return []
    for path in glob.glob(PATCH_GLOB):
        with open(path, encoding="utf-8") as handle:
            if PATCH_MARKER not in handle.read():
                return [(key, f"ALERT: the Mnemosyne cron read-only patch is not applied ({path}). An upgrade or reinstall replaced the module; cron has no Mnemosyne recall until patches/patch-mnemosyne-cron-readonly.py is re-checked for the new version and its pinned hash updated.")]
    return []


def mail_source(today, seen, cursors):
    sys.path.insert(0, SCRIPTS)
    import gmail

    if not gmail.load_token():
        return []
    after = cursors.get("gmail")
    if after is None:
        cursors["gmail"] = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
        return []
    try:
        messages = gmail.list_messages(after_ms=after, limit=MAIL_PER_TICK)
    except gmail.AuthExpired:
        raise RuntimeError("Gmail login expired or was revoked; run `gmail login` again")
    if messages:
        cursors["gmail"] = messages[-1]["received_ms"]
    return [(f"mail:{m['id']}", f"mail id={m['id']} | from: {m['from']} | subject: {m['subject']} | {m['date']}\n"
             f"snippet: {m['snippet']}") for m in messages]


@functools.lru_cache(maxsize=None)
def friday_tasks():
    """Open tasks on Friday's list; [] when the list does not exist yet."""
    result = subprocess.run([sys.executable, os.path.join(SCRIPTS, "gtasks.py"), "tasks", "view", "-l", TASK_LIST,
                             "--format=json"], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        if "not found" in (result.stdout + result.stderr).lower():
            return []
        raise RuntimeError(f"gtasks failed: {(result.stderr or result.stdout).strip()[:200]}")
    return tuple(t for t in json.loads(result.stdout or "[]") if t.get("status") != "completed")


def task_line(task):
    due = (task.get("due") or "")[:10]
    notes = " ".join((task.get("notes") or "").split())[:200]
    return f"- [id={task.get('id', '')}] {task.get('title', '')}" + (f" (due {due})" if due else "") + (f" — {notes}" if notes else "")


def tasks_source(today, seen, cursors):
    items = []
    for task in friday_tasks():
        due = parse_date(task.get("due") or "")
        key = f"task:{task.get('id')}"
        if due and due <= today and seen.get(key) != today.isoformat():
            items.append((key, "due: " + task_line(task)))
    return items


SOURCES = {"goals": goals_source, "patch": patch_source, "mail": mail_source, "tasks": tasks_source}


def save_state(today, seen, cursors):
    # Only today's entries matter for de-duplication, so older ones are dropped.
    seen = {key: day for key, day in seen.items() if day == today.isoformat()}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w", encoding="utf-8") as handle:
        json.dump({"seen": seen, "cursors": cursors}, handle, indent=2, sort_keys=True)
    os.replace(STATE + ".tmp", STATE)


def main():
    today = datetime.datetime.now(SGT).date()
    try:
        with open(STATE, encoding="utf-8") as handle:
            state = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    if "seen" not in state:  # the first state format was the seen map alone
        state = {"seen": state, "cursors": {}}
    seen, cursors = state["seen"], state.setdefault("cursors", {})
    before = json.dumps(cursors, sort_keys=True)
    sections = []
    for source, collect in SOURCES.items():
        try:
            items = collect(today, seen, cursors)
        except Exception as error:  # a broken source is reported, never hidden
            key = f"error:{source}"
            items = [] if seen.get(key) == today.isoformat() else [(key, f"ALERT: source {source} failed: {error}")]
        if items:
            sections.append(f"## {source}\n" + "\n\n".join(text for _, text in items))
            seen.update({key: today.isoformat() for key, _ in items})
    if not sections:
        if json.dumps(cursors, sort_keys=True) != before:
            save_state(today, seen, cursors)
        return 0
    try:
        open_tasks = friday_tasks()
    except Exception as error:
        open_tasks = []
        sections.append(f"## Friday tasks\nunavailable: {error}")
    if open_tasks:
        sections.append("## Friday tasks (open)\n" + "\n".join(task_line(t) for t in open_tasks))
    try:
        preferences = dict(read_slots("notify")).get("preferences")
    except sqlite3.Error:
        preferences = None
    if preferences:
        sections.append("## notify preferences\n" + preferences.strip())
    save_state(today, seen, cursors)
    print(f"Today: {today.isoformat()}\n\n" + "\n\n".join(sections))
    return 0


if __name__ == "__main__":
    sys.exit(main())
