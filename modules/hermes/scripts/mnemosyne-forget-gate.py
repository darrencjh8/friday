#!/usr/bin/env python3
"""Pre-run gate for the memory-mnemosyne-forget cron job.

Writes the forget candidates for the agent and wakes it only when there are
candidates and they changed since the last wake, so a candidate the agent chose
to keep is not re-judged every week. Prints nothing (the scheduler skips the
model) otherwise.
"""

import contextlib
import hashlib
import io
import json
import os

import mnemosyne_forget as forget

STATE = os.path.join(forget.HOME, "cron", "mnemosyne-forget-gate.json")


def main():
    with contextlib.redirect_stdout(io.StringIO()):
        forget.cmd_candidates(None)
    with open(forget.CANDIDATES, encoding="utf-8") as handle:
        found = json.load(handle)["candidates"]
    digest = hashlib.sha256(json.dumps([[c["id"], c["hint"]] for c in found]).encode()).hexdigest()
    try:
        with open(STATE, encoding="utf-8") as handle:
            last = json.load(handle).get("digest")
    except (FileNotFoundError, json.JSONDecodeError):
        last = None
    if not found or digest == last:
        return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as handle:
        json.dump({"digest": digest}, handle)
    hints = {}
    for c in found:
        hints[c["hint"]] = hints.get(c["hint"], 0) + 1
    print(f"{len(found)} candidate(s) to forget ({', '.join(f'{k} {v}' for k, v in sorted(hints.items()))}): "
          f"{forget.CANDIDATES}")


if __name__ == "__main__":
    main()
