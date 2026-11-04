#!/usr/bin/env python3
"""Email scan findings to the owner, and print none of them.

This repository's Actions logs are public, so output must not reveal a value or
even whether anything was found: the same line prints either way, and an error
prints only its exception type, because its message could quote a value.

Run: python3 scripts/pii-scan-alert.py findings.jsonl [more.jsonl ...]
Env: SMTP_USERNAME, SMTP_PASSWORD, PII_SCAN_EMAIL_TO, FULL_HISTORY ("true" to
report every commit; otherwise only commits from the last 2 days).
Exit: 0 scan handled, 1 failed.
"""
from __future__ import annotations

import fileinput
import json
import os
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage

SMTP_HOST = "smtp.zoho.com"
SMTP_PORT = 465


def recent_commits() -> set[str]:
    # 2 days so a delayed daily run leaves no gap; a hit can be reported twice.
    log = subprocess.run(["git", "log", "--all", "--since=2.days", "--format=%H"], capture_output=True, text=True, check=True)
    return set(log.stdout.split())


def collect(lines, recent: set[str] | None) -> dict[tuple[str, str], list[str]]:
    """Map (detector, value) to its locations; recent=None keeps every commit."""
    found: dict[tuple[str, str], list[str]] = {}
    for line in lines:
        hit = json.loads(line)
        git = hit["SourceMetadata"]["Data"]["Git"]
        raw = hit["Raw"]
        # A hit with no file comes from commit metadata. The committer's own
        # address is the author-email job's concern; a commit message hit is not.
        if not git.get("file") and raw in git.get("email", ""):
            continue
        if recent is not None and git["commit"] not in recent:
            continue
        name = (hit.get("ExtraData") or {}).get("name") or hit["DetectorName"]
        where = git.get("file") or "(commit message)"
        found.setdefault((name, raw), []).append(f"{git['commit'][:12]} {where}:{git.get('line', 0)}")
    return found


def render(found: dict[tuple[str, str], list[str]]) -> str:
    entries = []
    for (name, raw), locations in sorted(found.items()):
        entries.append("\n".join([f"[{name}] {raw}", *(f"  {location}" for location in locations)]))
    return "\n\n".join(entries) + "\n"


def main(argv: list[str]) -> int:
    try:
        # Checked before the scan result is read, so a missing secret turns the
        # run red now rather than on the day there is something to send.
        user, password, to = (os.environ[key] for key in ("SMTP_USERNAME", "SMTP_PASSWORD", "PII_SCAN_EMAIL_TO"))
        if not (user and password and to):
            raise ValueError
        recent = None if os.environ.get("FULL_HISTORY") == "true" else recent_commits()
        with fileinput.input(files=argv[1:], encoding="utf-8") as lines:
            found = collect(lines, recent)
        if found:
            message = EmailMessage()
            message["Subject"] = "friday: scheduled scan found PII or secrets"
            message["From"] = user
            message["To"] = to
            message.set_content(render(found))
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=30) as smtp:
                smtp.login(user, password)
                smtp.send_message(message)
    except Exception as error:
        print(f"pii-scan-alert failed: {type(error).__name__}", file=sys.stderr)
        return 1
    print("pii-scan-alert: scan complete")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
