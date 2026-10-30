#!/usr/bin/env python3
"""Pre-run gate for the memory-compact cron job.

Wakes the agent only when a store is at or above 80% of its cap and the store
sizes changed since the last wake, so an unchanged near-full store is not
re-read every morning. Prints nothing (the scheduler skips the model) otherwise.
"""

import json
import os
import subprocess
import sys

HOME = os.environ.get("HERMES_HOME", "/opt/data")
TRIAGE = os.environ.get("MEMORY_TRIAGE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "memory-triage.sh"))
STATE = os.path.join(HOME, "cron", "memory-compact-gate.json")
THRESHOLD = 0.8


def main():
    listing = json.loads(subprocess.run(["bash", TRIAGE, "list"], check=True, capture_output=True, text=True).stdout)
    chars = listing.get("memory_chars") or {}
    if "error" in chars:
        sys.exit(f"memory-triage list: {chars['error']}")
    full = {}
    for store, value in chars.items():
        used, cap = (int(n) for n in value.split("/"))
        if cap and used >= THRESHOLD * cap:
            full[store] = value
    try:
        with open(STATE, encoding="utf-8") as handle:
            last = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        last = None
    if not full or last == chars:
        return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump(chars, handle)
    print("Stores at or above 80% of cap: " + ", ".join(f"{s} {v}" for s, v in full.items()))


if __name__ == "__main__":
    main()
