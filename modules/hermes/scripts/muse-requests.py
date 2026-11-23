#!/usr/bin/env python3
"""Show Muse's purchase requests to the owner as Dots approval cards.

Muse has none of the owner's personal details. When it cannot finish a
purchase, it opens an issue labelled `request:purchase` in the private
darrencjh8/friday-persona repo. This script runs every 10 minutes from the
no_agent cron `muse-requests` (deliver: dots). For each open request it has not
shown before, it prints one line ending "Tap /buy_<n> or /skip_<n>.", which the
Dots adapter turns into a Buy/Refuse card. Nothing is bought until the owner
taps Buy; the agent then reads the issue itself.

Prints nothing when there is no new request. Exits non-zero when gh fails, so
the cron reports it. The issue title is Muse's text: it is cut to one line,
without slashes, so it cannot carry a command of its own.
"""

import json
import os
import re
import subprocess
import sys

REPO = "darrencjh8/friday-persona"
LABEL = "request:purchase"
STATE = os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "muse-requests", "shown.json")


def open_requests(run=subprocess.run):
    result = run(["gh", "issue", "list", "--repo", REPO, "--label", LABEL, "--state", "open",
                  "--json", "number,title", "--limit", "20"], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"gh issue list failed: {result.stderr.strip()[:300]}")
    return json.loads(result.stdout or "[]")


def card_line(number, title):
    title = re.sub(r"[/\s]+", " ", title).strip()[:120] or "(no title)"
    return f"{title} (friday-persona#{number}). Tap /buy_{number} or /skip_{number}."


def main(run=subprocess.run, state=STATE):
    try:
        with open(state) as f:
            shown = set(json.load(f))
    except FileNotFoundError:
        shown = set()
    requests = [r for r in open_requests(run) if isinstance(r.get("number"), int)]
    new = [r for r in requests if r["number"] not in shown]
    for r in new:
        print(card_line(r["number"], str(r.get("title", ""))))
    # Keep only open requests, so the file stays small; a reopened issue is shown again.
    os.makedirs(os.path.dirname(state), exist_ok=True)
    with open(state + ".tmp", "w") as f:
        json.dump(sorted(r["number"] for r in requests), f)
    os.replace(state + ".tmp", state)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # the cron reports a failed run
        print(f"muse-requests: {error}", file=sys.stderr)
        sys.exit(1)
