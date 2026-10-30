#!/usr/bin/env python3
"""Pre-run gate for the memory-approve-queue cron job.

Wakes the agent only when the write-approval queue holds a record it has not
seen at a previous wake, or a record held 7 days or more that was not raised
in the last 7 days. Prints nothing (the scheduler skips the model) otherwise,
which covers an empty queue and a queue of the same young held records.
"""

import datetime
import json
import os
import subprocess

HOME = os.environ.get("HERMES_HOME", "/opt/data")
TRIAGE = os.environ.get("MEMORY_TRIAGE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory-triage.sh"))
STATE = os.path.join(HOME, "cron", "memory-queue-gate.json")
NAG_DAYS = 7


def main():
    listing = json.loads(subprocess.run(["bash", TRIAGE, "list"], check=True, capture_output=True, text=True).stdout)
    today = datetime.date.today()
    try:
        with open(STATE, encoding="utf-8") as handle:
            state = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    seen, nagged = set(state.get("seen", [])), state.get("nagged", {})
    ids = [r["id"] for r in listing.get("pending", [])]
    new = [i for i in ids if i not in seen]
    # ponytail: a wake whose run then fails marks its records seen, so they are
    # retried only once they reach the 7-day nag; the failure itself is alerted.
    due = [
        r["id"] for r in listing.get("pending", [])
        if (r.get("age_days") or 0) >= NAG_DAYS
        and (today - datetime.date.fromisoformat(nagged.get(r["id"], "1970-01-01"))).days >= NAG_DAYS
    ]
    if not new and not due:
        return
    nagged = {i: d for i, d in nagged.items() if i in ids}
    nagged.update({i: today.isoformat() for i in due})
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump({"seen": ids, "nagged": nagged}, handle)
    print(f"Queue: {len(ids)} pending, {len(new)} new, {len(due)} held 7+ days")


if __name__ == "__main__":
    main()
