#!/usr/bin/env python3
"""Reproduction control for friday #202: the scheduled PII scan emails
false positives it cannot allowlist, and a detector shape that is not PII.

The bot's synthetic .local address in merge commit messages is a
commit-message hit, so no allowlist tuple can match it (the allowlist
requires a file); the detector config must exclude the .local shape
instead. The two product names are already allowlisted at older commits;
suppression is per exact tuple, so each needs an entry at its new commit.

The flagged values themselves are never written in this file: they are
read out of the allowlist entries, and each entry is checked against the
file it names. The .local check uses a neutral synthetic address.

Run: python3 modules/tests/test_issue_202.py
"""
import importlib.util
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

spec = importlib.util.spec_from_file_location(
    "pii_scan_alert", os.path.join(ROOT, "scripts", "pii-scan-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)

# The commits whose scan flagged the false positives.
COMMITS = (
    "8a182bcce1e0618e145986edd478ab2087fc5935",
    "2bccac8885aeac21762129286d66c98ed51c839a",
)
EXPECTED_ENTRIES = 2

# Neutral synthetic addresses for the detector-shape check: the flagged
# address itself is never written here.
LOCAL_ADDRESS = "user@example.local"
REAL_ADDRESS = "user@real-domain.com"


def _issue_entries():
    with open(os.path.join(ROOT, "scripts", "pii-scan-allowlist.json"),
              encoding="utf-8") as handle:
        entries = json.load(handle)["entries"]
    return [e for e in entries if e["commit"] in COMMITS]


def _finding(entry):
    git = {"commit": entry["commit"], "email": "dev <dev@example.com>",
           "line": 1, "file": entry["file"]}
    return json.dumps({
        "DetectorName": entry["detector"],
        "ExtraData": {"name": entry["name"]},
        "Raw": entry["value"],
        "SourceMetadata": {"Data": {"Git": git}},
    })


def _email_exclude_patterns():
    """The PII-email detector's exclude regexes, from .trufflehog.yml."""
    text = open(os.path.join(ROOT, ".trufflehog.yml"), encoding="utf-8").read()
    return re.findall(r"^\s+- '([^']+)'", text, re.M)


class TestIssue202(unittest.TestCase):
    def test_pii_scan_false_positives_suppressed(self):
        entries = _issue_entries()
        failures = []
        if len(entries) != EXPECTED_ENTRIES:
            failures.append(
                f"expected {EXPECTED_ENTRIES} allowlist entries for this "
                f"issue, found {len(entries)}")
        allowed = alert.load_allowlist()
        lines = []
        for entry in entries:
            path = os.path.join(ROOT, entry["file"])
            with open(path, encoding="utf-8") as handle:
                if entry["value"] not in handle.read():
                    failures.append(
                        f"allowlisted value no longer occurs in "
                        f"{entry['file']}")
            lines.append(_finding(entry))
        found = alert.collect(lines, recent=None, allowed=allowed)
        for entry in entries:
            if (entry["name"], entry["value"]) in found:
                failures.append("allowlisted value still reported by the "
                                "PII scan")
        patterns = _email_exclude_patterns()
        if not any(re.search(p, LOCAL_ADDRESS) for p in patterns):
            failures.append(
                "detector config does not exclude .local addresses")
        if any(re.search(p, REAL_ADDRESS) for p in patterns):
            failures.append("detector config excludes a real address")
        if failures:
            print("FAIL: test_issue_202.TestIssue202.test_pii_scan_false_positives_suppressed "
                  + "; ".join(failures))
            sys.exit(1)
        print("test_issue_202.TestIssue202.test_pii_scan_false_positives_suppressed: PASS")


if __name__ == "__main__":
    TestIssue202("test_pii_scan_false_positives_suppressed").test_pii_scan_false_positives_suppressed()
