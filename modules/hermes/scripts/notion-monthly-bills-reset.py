#!/usr/bin/env python3
"""Monthly no_agent cron: set every row of the Notion "Monthly Bill" database to
Status "Not started", so the month's bills start unticked.

Only that one data source and that one property are written; rows already
"Not started" are skipped. Prints nothing on success (silent run); any API
error exits non-zero, which the scheduler reports as a failure.
"""
import json
import os
import urllib.request

HOME = os.environ.get("HERMES_HOME", "/opt/data")
API = os.environ.get("NOTION_API_BASE", "https://api.notion.com/v1")
DATA_SOURCE = "c19a7504-49d9-4b95-94e6-8447aaa522d3"  # Monthly Bill
STATUS, RESET = "Status", "Not started"


def notion_key():
    key = os.environ.get("NOTION_API_KEY", "")
    if not key:  # cron scrubs secrets from the script env; the profile .env still holds it
        try:
            for line in open(os.path.join(HOME, ".env"), encoding="utf-8"):
                if line.startswith("NOTION_API_KEY="):
                    key = line.split("=", 1)[1].strip()
        except OSError:
            pass
    if not key:
        raise SystemExit("NOTION_API_KEY not available")
    return key


def call(method, path, body):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(), method=method, headers={
        "Authorization": "Bearer " + notion_key(), "Notion-Version": "2025-09-03",
        "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main():
    query = {"page_size": 100, "filter": {"property": STATUS, "status": {"does_not_equal": RESET}}}
    rows = []
    while True:
        page = call("POST", f"/data_sources/{DATA_SOURCE}/query", query)
        rows += [r["id"] for r in page.get("results", [])]
        if not page.get("has_more"):
            break
        query["start_cursor"] = page["next_cursor"]
    for row in rows:
        call("PATCH", f"/pages/{row}", {"properties": {STATUS: {"status": {"name": RESET}}}})


if __name__ == "__main__":
    main()
