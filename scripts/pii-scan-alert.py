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
import urllib.parse
import urllib.request
from email.message import EmailMessage

SMTP_HOST = "smtp.zoho.com"
SMTP_PORT = 465

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWLIST_PATH = os.path.join(HERE, "pii-scan-allowlist.json")
ALLOWLIST_KEYS = {"detector", "name", "value", "commit", "file"}
HEX40 = re.compile(r"[0-9a-f]{40}")

# JEV adjudication (issue #205): same SystemOne contract as
# scripts/jev_drift_audit.py, with its calibrated gates. Only the names in
# ADJUDICABLE_NAMES are ever sent, plus URI findings with the secret redacted
# (see redact_uri); everything else is always emailed.
JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_TIMEOUT = 30
JEV_MIN_CONFIDENCE = 0.65
JEV_MIN_MARGIN = 0.3
ADJUDICABLE_NAMES = {"PII email", "PII SG phone", "PII NRIC", "PII card", "PII SG address", "PII name"}
# DetectorName follows from the ExtraData name: the five CustomRegex detectors
# in .trufflehog.yml, and the Presidio name detector in pii-scan-names.py.
DETECTOR_FOR_NAME = {
    "PII email": "CustomRegex",
    "PII SG phone": "CustomRegex",
    "PII NRIC": "CustomRegex",
    "PII card": "CustomRegex",
    "PII SG address": "CustomRegex",
    "PII name": "Presidio",
}
VERDICT_QUESTION = {
    "verdict": {
        "type": "choice",
        "instructions": (
            "You judge one PII-scan finding: a detector matched a value in a git "
            "repository. Answer false_positive when the value is synthetic test "
            "fixture data, an example, a placeholder, or a product name — not a "
            "real person's data. Answer real when it is or could be a real "
            "person's data. If the evidence does not decide it, answer uncertain."
        ),
        "criteria": {
            "false_positive": "synthetic fixture, example, placeholder, or product name — not a real person's data",
            "real": "is or could be a real person's data or a real secret",
            "uncertain": "not enough evidence",
        },
    }
}
# Credential URLs get their own question so the calibrated PII one is unchanged.
CREDENTIAL_QUESTION = {
    "verdict": {
        "type": "choice",
        "instructions": (
            "You judge one secret-scan finding: a URL with embedded credentials "
            "in a git repository. The secret itself is withheld; you see its "
            "shape. Answer false_positive when it is clearly a stub in test or "
            "example code, such as a short readable placeholder on a reserved "
            "example host like example.com or localhost. Answer real when it is "
            "or could be a working credential. If the evidence does not decide "
            "it, answer uncertain."
        ),
        "criteria": {
            "false_positive": "stub or placeholder credential in test or example code",
            "real": "is or could be a working credential",
            "uncertain": "not enough evidence",
        },
    }
}


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


def redact_uri(value: str) -> str | None:
    """Describe a credential URL with its password replaced by its shape.

    JEV never sees the secret: only its length, a short token-type prefix such
    as ghs_, and which character classes it uses. None when there is no
    password to withhold, so the finding is reported instead.
    """
    try:
        url = urllib.parse.urlsplit(value)
        secret, host, port = url.password, url.hostname, url.port
    except ValueError:
        return None
    if not secret or not host:
        return None
    prefix = re.match(r"[A-Za-z]{2,4}_", secret)
    classes = [label for label, pattern in (("lowercase", "[a-z]"), ("uppercase", "[A-Z]"),
               ("digits", "[0-9]"), ("symbols", "[^A-Za-z0-9]")) if re.search(pattern, secret)]
    shape = f"{len(secret)} chars, {'+'.join(classes)}"
    if prefix:
        shape += f", prefix {prefix.group(0)}"
    port = f":{port}" if port else ""
    return f"{url.scheme}://{url.username or ''}:<secret: {shape}>@{host}{port}{url.path}"


def _jev_is_false_positive(name: str, value: str, locations: list[str], key: str) -> bool:
    """Ask JEV whether one surviving finding is a false positive.

    True only on a confident false_positive; every other outcome — real,
    uncertain, low confidence, low margin, malformed answer, error — is
    False, so the finding is reported. Never raises. The state carries only
    this finding's own fields: detector, name, value, and all its locations.
    """
    if name == "URI":
        detector, question, value = "URI", CREDENTIAL_QUESTION, redact_uri(value)
        if value is None:
            return False
    else:
        detector, question = DETECTOR_FOR_NAME[name], VERDICT_QUESTION
    state = "\n".join([
        f"Detector: {detector}",
        f"Finding: {name}",
        f"Value: {value}",
        "Locations:",
        *(f"  {location}" for location in locations),
    ])
    body = json.dumps({"model": JEV_MODEL, "state": state, "questions": question}).encode()
    request = urllib.request.Request(
        JEV_ENDPOINT, data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=JEV_TIMEOUT) as response:
            verdict = json.load(response)["answers"]["verdict"]
        if verdict.get("choice") != "false_positive":
            return False
        confidence = verdict.get("confidence") or 0
        probs = sorted((verdict.get("probabilities") or {}).values(), reverse=True)
        margin = (probs[0] - probs[1]) if len(probs) > 1 else 0.0
        return confidence >= JEV_MIN_CONFIDENCE and margin >= JEV_MIN_MARGIN
    except Exception:
        return False


def adjudicate(found: dict[tuple[str, str], list[str]], key: str) -> tuple[dict[tuple[str, str], list[str]], int]:
    """Drop findings JEV confidently calls false positives.

    Returns (reported, suppressed_count). Without a key, adjudication is
    skipped and every finding is reported. A per-finding failure never
    raises: the finding is reported.
    """
    if not key:
        return found, 0
    reported: dict[tuple[str, str], list[str]] = {}
    suppressed = 0
    for (name, value), locations in found.items():
        if (name in ADJUDICABLE_NAMES or name == "URI") and _jev_is_false_positive(name, value, locations, key):
            suppressed += 1
        else:
            reported[(name, value)] = locations
    return reported, suppressed


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
        found, suppressed = adjudicate(found, os.environ.get("JEV_API_KEY", ""))
        if found:
            message = EmailMessage()
            message["Subject"] = "friday: scheduled scan found PII or secrets"
            message["From"] = user
            message["To"] = to
            content = render(found)
            if suppressed:
                content += f"\nJEV adjudication suppressed {suppressed} finding(s) as false positives.\n"
            message.set_content(content)
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
