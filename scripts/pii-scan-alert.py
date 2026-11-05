#!/usr/bin/env python3
"""Email scan findings to the owner, and print none of them.

This repository's Actions logs are public, so output must not reveal a value or
even whether anything was found: the same line prints either way, and an error
prints only its exception type, because its message could quote a value.

Run: python3 scripts/pii-scan-alert.py findings.jsonl [more.jsonl ...]
Env: SMTP_USERNAME, SMTP_PASSWORD, PII_SCAN_EMAIL_TO, FULL_HISTORY ("true" to
report every commit; otherwise only commits from the last 2 days), and
PII_SCAN_ALLOWLIST (default: scripts/pii-scan-allowlist.json).
Exit: 0 scan handled, 1 failed.
"""
from __future__ import annotations

import fileinput
import json
import os
import re
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage

SMTP_HOST = "smtp.zoho.com"
SMTP_PORT = 465

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWLIST_PATH = os.path.join(HERE, "pii-scan-allowlist.json")
ALLOWLIST_KEYS = {"detector", "name", "value", "commit", "file"}
HEX40 = re.compile(r"[0-9a-f]{40}")


class AllowlistError(ValueError):
    """The allowlist is missing or malformed, so no finding may be suppressed."""


def load_allowlist(path: str | None = None) -> set[tuple]:
    """Load exact (detector, name, value, commit, file) tuples to leave out.

    A missing or malformed file raises, so a broken allowlist makes the run red
    instead of quietly suppressing findings. Messages never quote a value.
    """
    path = path or os.environ.get("PII_SCAN_ALLOWLIST") or ALLOWLIST_PATH
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise AllowlistError(f"cannot read allowlist: {type(error).__name__}") from None
    entries = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        raise AllowlistError("allowlist has no 'entries' list")
    allowed = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != ALLOWLIST_KEYS:
            raise AllowlistError("an allowlist entry does not have exactly the five keys")
        if entry["name"] is not None and not isinstance(entry["name"], str):
            raise AllowlistError("an allowlist entry has a non-string name")
        # A null file would match commit-message hits, which must stay reportable.
        for key in ("detector", "value", "commit", "file"):
            if not isinstance(entry[key], str) or not entry[key]:
                raise AllowlistError("an allowlist entry has an empty or non-string field")
        if not HEX40.fullmatch(entry["commit"]):
            raise AllowlistError("an allowlist entry has a commit that is not a full SHA")
        allowed.add(tuple(entry[key] for key in ("detector", "name", "value", "commit", "file")))
    return allowed


def recent_commits() -> set[str]:
    # 2 days so a delayed daily run leaves no gap; a hit can be reported twice.
    log = subprocess.run(["git", "log", "--all", "--since=2.days", "--format=%H"], capture_output=True, text=True, check=True)
    return set(log.stdout.split())


def collect(lines, recent: set[str] | None, allowed: set[tuple]) -> dict[tuple[str, str], list[str]]:
    """Map (detector, value) to its locations; recent=None keeps every commit."""
    found: dict[tuple[str, str], list[str]] = {}
    for line in lines:
        hit = json.loads(line)
        git = hit["SourceMetadata"]["Data"]["Git"]
        raw = hit["Raw"]
        extra_name = (hit.get("ExtraData") or {}).get("name")
        exact = (hit["DetectorName"], extra_name, raw, git["commit"], git.get("file"))
        if exact in allowed:
            continue
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
        allowed = load_allowlist()
        with fileinput.input(files=argv[1:], encoding="utf-8") as lines:
            found = collect(lines, recent, allowed)
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
