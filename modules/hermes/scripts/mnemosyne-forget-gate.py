#!/usr/bin/env python3
"""Pre-run gate for the memory-mnemosyne-forget cron job.

Writes the forget candidates for the agent and wakes it only when there are
candidates that differ from those left after the last successful apply, so a
candidate the agent chose to keep is not re-judged every week, while a run that
failed before applying is retried. Prints nothing (the scheduler skips the
model) otherwise.
"""

import contextlib
import io
import json

import mnemosyne_forget as forget


def main():
    with contextlib.redirect_stdout(io.StringIO()):
        forget.cmd_candidates(None)
    with open(forget.CANDIDATES, encoding="utf-8") as handle:
        found = json.load(handle)["candidates"]
    try:
        with open(forget.REVIEWED, encoding="utf-8") as handle:
            reviewed = json.load(handle).get("digest")
    except (FileNotFoundError, json.JSONDecodeError):
        reviewed = None
    if not found or forget.digest(found) == reviewed:
        return
    hints = {}
    for c in found:
        hints[c["hint"]] = hints.get(c["hint"], 0) + 1
    print(f"{len(found)} candidate(s) to forget ({', '.join(f'{k} {v}' for k, v in sorted(hints.items()))}): "
          f"{forget.CANDIDATES}")


if __name__ == "__main__":
    main()
