#!/usr/bin/env python3
"""Monthly no_agent cron: clear completed tasks in every Google Tasks list.

The Tasks API clear call hides completed tasks, the same as "Delete all
completed" in Google Tasks; nothing open is touched. Prints nothing on
success (silent run); any API error exits non-zero, which the scheduler
reports as a failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtasks  # noqa: E402  (OAuth and API helpers; same directory)


def main():
    params = "maxResults=100"
    while True:
        out = gtasks._api("GET", "/users/@me/lists?" + params)
        for item in out.get("items", []):
            # An empty JSON body sends Content-Length; Google rejects a bodiless POST.
            gtasks._api("POST", gtasks._tasks_path(item["id"], action="clear"), {})
        if not out.get("nextPageToken"):
            return
        params = "maxResults=100&pageToken=" + out["nextPageToken"]


if __name__ == "__main__":
    main()
