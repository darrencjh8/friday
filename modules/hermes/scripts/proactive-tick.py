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

Reads only: the Mnemosyne DB is opened read-only.
"""

import datetime
import glob
import json
import os
import sqlite3
import sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
DB = os.path.join(os.environ.get("MNEMOSYNE_DATA_DIR") or os.path.join(HOME, "mnemosyne", "data"), "mnemosyne.db")
STATE = os.path.join(HOME, "proactive-tick", "state.json")
PATCH_GLOB = os.path.join(HOME, "installs/*/environments/*/venv/lib/python3*/site-packages/mnemosyne_hermes/__init__.py")
PATCH_MARKER = "# friday-patch: mnemosyne read-only in cron"
SGT = datetime.timezone(datetime.timedelta(hours=8))


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


def goals_source(today, seen):
    items = []
    for name, body in read_slots("goal"):
        key = f"goal:{name}"
        if seen.get(key) != today.isoformat() and is_due(parse_body(body), today):
            items.append((key, f"goal `{name}`\n{body.strip()}"))
    return items


def patch_source(today, seen):
    key = "patch:mnemosyne-cron-readonly"
    if seen.get(key) == today.isoformat():
        return []
    for path in glob.glob(PATCH_GLOB):
        with open(path, encoding="utf-8") as handle:
            if PATCH_MARKER not in handle.read():
                return [(key, f"ALERT: the Mnemosyne cron read-only patch is not applied ({path}). An upgrade or reinstall replaced the module; cron has no Mnemosyne recall until patches/patch-mnemosyne-cron-readonly.py is re-checked for the new version and its pinned hash updated.")]
    return []


SOURCES = {"goals": goals_source, "patch": patch_source}


def main():
    today = datetime.datetime.now(SGT).date()
    try:
        with open(STATE, encoding="utf-8") as handle:
            seen = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        seen = {}
    sections = []
    for source, collect in SOURCES.items():
        try:
            items = collect(today, seen)
        except Exception as error:  # a broken source is reported, never hidden
            key = f"error:{source}"
            items = [] if seen.get(key) == today.isoformat() else [(key, f"ALERT: source {source} failed: {error}")]
        if items:
            sections.append(f"## {source}\n" + "\n\n".join(text for _, text in items))
            seen.update({key: today.isoformat() for key, _ in items})
    if not sections:
        return 0
    try:
        preferences = dict(read_slots("notify")).get("preferences")
    except sqlite3.Error:
        preferences = None
    if preferences:
        sections.append("## notify preferences\n" + preferences.strip())
    # Only today's entries matter for de-duplication, so older ones are dropped.
    seen = {key: day for key, day in seen.items() if day == today.isoformat()}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(seen, handle, indent=2, sort_keys=True)
    os.replace(STATE + ".tmp", STATE)
    print(f"Today: {today.isoformat()}\n\n" + "\n\n".join(sections))
    return 0


if __name__ == "__main__":
    sys.exit(main())
