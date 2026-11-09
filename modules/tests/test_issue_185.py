#!/usr/bin/env python3
"""Reproduction control for friday #185: the scheduled PII scan flags
false positives as [PII name], but the flagged strings are not people.
The fix whitelists the exact occurrences in
scripts/pii-scan-allowlist.json; this test proves pii-scan-alert.collect()
suppresses them once whitelisted.

The flagged strings themselves are never written in this file: they are
read out of the allowlist entries, and each entry is checked against the
file it names, so the test stays true without hardcoding the values.

Run: python3 modules/tests/test_issue_185.py
"""
import importlib.util
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

spec = importlib.util.spec_from_file_location(
    "pii_scan_alert", os.path.join(ROOT, "scripts", "pii-scan-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)

# The commit whose scan flagged the false positives, and the plan file
# that quotes them (and is therefore allowlisted at its own commit).
COMMIT = "48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9"
PLAN_FILE = "docs/plans/185-pii-allowlist-false-positives.md"
EXPECTED_ENTRIES = 4


def _issue_entries():
    with open(os.path.join(ROOT, "scripts", "pii-scan-allowlist.json"),
              encoding="utf-8") as handle:
        entries = json.load(handle)["entries"]
    return [e for e in entries
            if e["commit"] == COMMIT or e["file"] == PLAN_FILE]


def _finding(entry):
    git = {"commit": entry["commit"], "email": "dev <dev@example.com>",
           "line": 1, "file": entry["file"]}
    return json.dumps({
        "DetectorName": entry["detector"],
        "ExtraData": {"name": entry["name"]},
        "Raw": entry["value"],
        "SourceMetadata": {"Data": {"Git": git}},
    })


class TestIssue185(unittest.TestCase):
    def test_pii_false_positives_whitelisted(self):
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
        if failures:
            print("FAIL: test_issue_185.TestIssue185.test_pii_false_positives_whitelisted "
                  + "; ".join(failures))
            sys.exit(1)
        print("test_issue_185.TestIssue185.test_pii_false_positives_whitelisted: PASS")


if __name__ == "__main__":
    TestIssue185("test_pii_false_positives_whitelisted").test_pii_false_positives_whitelisted()
