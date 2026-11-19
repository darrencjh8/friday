#!/usr/bin/env python3
"""Weekly count of proactive-tick messages vs silence (#247).

Reads the last 7 SGT days of proactive-tick cron output files, extracts the
agent's final reply from each, and prints one line only when more than 21
messages were delivered. Prints nothing on a quiet week; exit non-zero only
when the inputs are unreadable (missing/corrupt jobs.json, unresolvable job
id, missing output dir). Writes nothing anywhere.
ponytail: counts are a heuristic on the reply text, not a delivery receipt — a
run that crashed after replying still counts as a message.
"""

import datetime
import glob
import json
import os
import re
import sqlite3
import sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
JOBS = os.path.join(HOME, "cron", "jobs.json")
NOTEPAD = os.path.join(HOME, "cron", "notepad.db")
OUTPUT_ROOT = os.path.join(HOME, "cron", "output")
SGT = datetime.timezone(datetime.timedelta(hours=8))
THRESHOLD = 21
DAYS = 7

PROMPT_FRAME = re.compile(r"^\*\*Prompt Characters:\*\* (\d+)\n## Prompt\n\n", re.M)
RESPONSE_FRAME = re.compile(r"^\*\*Response Characters:\*\* (\d+)\n## Response\n\n", re.M)
SILENCE_WORDS = {"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY"}
SKIP_TEXT = "Script gate returned `wakeAgent=false` — agent skipped."
DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}):")


def own_job_id():
    try:
        with open(JOBS, encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    return next((j.get("id") for j in jobs if isinstance(j, dict) and j.get("name") == "proactive-tick"), None)


def extract_reply(text):
    """The agent's final reply, per Hermes's own _archive_answer frame rule."""
    prompt_match = PROMPT_FRAME.search(text)
    if prompt_match is None:
        return None
    pos = prompt_match.end() + int(prompt_match.group(1)) + len("\n\n")
    response_match = RESPONSE_FRAME.match(text, pos)
    if response_match is None:
        return None
    size = int(response_match.group(1))
    start = response_match.end()
    reply = text[start:start + size]
    if len(reply) != size or text[start + size:] not in ("", "\n"):
        return None
    return reply


def is_silence(reply):
    """Same rule as delivery (gateway/response_filters is_autonomous_silence_response)."""
    if reply.strip().lower() == "(no response generated)":
        return True
    lines = [line.strip().upper() for line in reply.strip().splitlines() if line.strip()]
    return not lines or lines[0] in SILENCE_WORDS or lines[-1] in SILENCE_WORDS


def classify_file(path):
    """skipped | silent | failure | message | unreadable."""
    if os.path.getsize(path) == 0:
        return "skipped"
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if text.strip() == SKIP_TEXT:
        return "skipped"
    reply = extract_reply(text)
    if reply is None:
        return "unreadable"
    if reply.split("\n", 1)[0] == "[CRON_FAILURE]":
        return "failure"
    return "silent" if is_silence(reply) else "message"


def file_day(path):
    """Run day from the filename timestamp (local time); file mtime (SGT) as fallback."""
    name = os.path.basename(path)
    try:
        return datetime.datetime.strptime(name[:-3], "%Y-%m-%d_%H-%M-%S").date()
    except ValueError:
        return datetime.datetime.fromtimestamp(os.path.getmtime(path), SGT).date()


def count_items(job_id, start, end):
    """`reported` entries dated in the window; a missing table or key means 0."""
    if not os.path.exists(NOTEPAD):
        return 0
    conn = sqlite3.connect(f"file:{NOTEPAD}?mode=ro", uri=True, timeout=10)
    try:
        row = conn.execute("SELECT value FROM cron_notepad WHERE job_id = ? AND key = 'reported'",
                           (job_id,)).fetchone()
    except sqlite3.OperationalError as error:
        if "no such table" in str(error):
            return 0
        raise
    finally:
        conn.close()
    count = 0
    for entry in re.split(r"[;\n]", row[0] if row else ""):
        match = DATE_RE.match(entry.strip())
        if match and start <= datetime.date.fromisoformat(match.group(1)) <= end:
            count += 1
    return count


def summarize(today):
    """Counts for the 7 SGT days ending today; None when the inputs are unreadable."""
    job_id = own_job_id()
    if job_id is None:
        return None
    out_dir = os.path.join(OUTPUT_ROOT, job_id)
    if not os.path.isdir(out_dir):
        return None
    start = today - datetime.timedelta(days=DAYS - 1)
    counts = {"messages": 0, "silent": 0, "failed": 0, "unreadable": 0, "skipped": 0}
    for path in glob.glob(os.path.join(out_dir, "*.md")):
        if not start <= file_day(path) <= today:
            continue
        kind = classify_file(path)
        if kind == "message":
            counts["messages"] += 1
        elif kind == "silent":
            counts["silent"] += 1
        elif kind == "failure":
            counts["failed"] += 1
        elif kind == "unreadable":
            counts["unreadable"] += 1
        else:
            counts["skipped"] += 1
    counts["items"] = count_items(job_id, start, today)
    return counts


def main(today=None):
    counts = summarize(today or datetime.datetime.now(SGT).date())
    if counts is None:
        print("proactive-tick-volume: cannot resolve the proactive-tick job or its output dir", file=sys.stderr)
        return 1
    if counts["messages"] > THRESHOLD:
        print(f"Proactive messages, last 7 days: {counts['messages']} ({counts['messages'] / DAYS:.1f}/day), "
              f"{counts['silent']} silent, {counts['failed']} failed, {counts['items']} items.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
