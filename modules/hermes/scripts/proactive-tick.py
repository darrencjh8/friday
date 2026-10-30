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
  forums skipped), through the read-only Apps Script bridge (google_bridge.py).
  Off until FRIDAY_BRIDGE_URL/KEY are set; the first tick only sets the cursor,
  so old mail is never replayed.
- calendar: events in the next CALENDAR_DAYS that were added, moved, or
  cancelled since the last tick (the first tick only takes the baseline), and
  once a day the agenda for the next 24 hours.
- tasks: open items on Friday's own Google Tasks list that are due today or
  earlier, at most once a day each.
When any source has something, the open Friday tasks and Darren's notify
preferences are added as context so the agent can match mail to what it
already tracks, along with the next 24 hours of calendar.

Reads only: the Mnemosyne DB is opened read-only, and the bridge's scopes are
gmail.readonly and calendar.readonly.
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
CALENDAR_DAYS = 14


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


def bridge():
    sys.path.insert(0, SCRIPTS)
    import google_bridge

    return google_bridge if google_bridge.configured() else None


def now_ms():
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)


def mail_source(today, seen, cursors):
    google = bridge()
    if not google:
        return []
    after = cursors.get("gmail")
    if after is None:
        cursors["gmail"] = now_ms()
        return []
    messages = google.list_messages(after_ms=after, limit=MAIL_PER_TICK)
    if messages:
        cursors["gmail"] = messages[-1]["received_ms"]
    return [(f"mail:{m['id']}", f"mail id={m['id']} | from: {m['from']} | subject: {m['subject']} | {m['date']}\n"
             f"snippet: {m['snippet']}") for m in messages]


def event_start(event):
    """Start as an aware datetime; all-day events start at midnight SGT."""
    value = event.get("start") or ""
    try:
        if len(value) == 10:
            return datetime.datetime.combine(datetime.date.fromisoformat(value), datetime.time(), SGT)
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_line(event):
    start = event_start(event)
    when = start.astimezone(SGT).strftime("%a %d %b %H:%M") if start and len(event.get("start", "")) > 10 \
        else (start.strftime("%a %d %b all day") if start else event.get("start", ""))
    line = f"- {when}: {event.get('summary') or '(no title)'}"
    if event.get("location"):
        line += f" @ {event['location']}"
    description = " ".join((event.get("description") or "").split())[:200]
    return line + (f" — {description}" if description else "")


@functools.lru_cache(maxsize=None)
def upcoming_events():
    google = bridge()
    return tuple(google.list_events(CALENDAR_DAYS)) if google else ()


def next_day(events):
    now = datetime.datetime.now(datetime.timezone.utc)
    return [e for e in events if (s := event_start(e)) and s <= now + datetime.timedelta(hours=24)]


def calendar_source(today, seen, cursors):
    if not bridge():
        return []
    events = [e for e in upcoming_events() if e.get("status") != "cancelled"]
    horizon = now_ms() + CALENDAR_DAYS * 86400000
    current = {e["id"]: {"sig": "|".join(str(e.get(k, "")) for k in ("start", "end", "summary", "location")),
                         "start_ms": int(s.timestamp() * 1000) if (s := event_start(e)) else 0,
                         "line": event_line(e)} for e in events}
    previous = cursors.get("calendar")
    cursors["calendar"] = {"horizon_ms": horizon, "events": current}
    if previous is None:
        return []
    items = []
    before = previous.get("events", {})
    for event_id, now_event in current.items():
        old = before.get(event_id)
        if old is None and now_event["start_ms"] < previous.get("horizon_ms", 0):
            # Events that only scrolled into the window are not news.
            items.append((f"cal:new:{event_id}", "new event " + now_event["line"]))
        elif old is not None and old["sig"] != now_event["sig"]:
            items.append((f"cal:moved:{event_id}:{now_event['sig']}", f"changed event {now_event['line']} (was {old['line'][2:]})"))
    for event_id, old in before.items():
        if event_id not in current and old["start_ms"] > now_ms():
            items.append((f"cal:cancelled:{event_id}", "cancelled event " + old["line"]))
    key = "cal:agenda"
    soon = next_day(events)
    if soon and seen.get(key) != today.isoformat():
        items.append((key, "agenda, next 24 hours:\n" + "\n".join(event_line(e) for e in soon)))
    return items


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


SOURCES = {"goals": goals_source, "patch": patch_source, "mail": mail_source, "calendar": calendar_source,
           "tasks": tasks_source}


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
    if "## calendar\n" not in "\n".join(sections):
        try:
            soon = next_day(upcoming_events())
        except Exception:
            soon = []  # the calendar source already reported the failure
        if soon:
            sections.append("## calendar (next 24 hours)\n" + "\n".join(event_line(e) for e in soon))
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
