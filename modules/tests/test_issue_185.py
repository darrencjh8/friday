#!/usr/bin/env python3
"""Reproduction control for friday #185: the scheduled PII scan flags
a font name and a service name as [PII name], but neither is a person.
The fix whitelists the exact occurrences in
scripts/pii-scan-allowlist.json; this test proves pii-scan-alert.collect()
suppresses them once whitelisted.

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

COMMIT = "48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9"

# The three occurrences the CI scan flagged at commit 48ca43c3cf90, as
# TruffleHog-shaped Presidio findings (see scripts/pii-scan-names.py:
# DetectorName "Presidio", ExtraData.name "PII name").
FINDINGS = [
    ("Segoe UI", "modules/dots-web/src/styles/theme.css", 26),
    ("Upstash Redis", "modules/dots-web/api/_lib/pairing.ts", 3),
    ("Upstash Redis", "modules/dots-web/api/pair.ts", 5),
]


def _finding(raw, file, line):
    git = {"commit": COMMIT, "email": "dev <dev@example.com>", "line": line, "file": file}
    return json.dumps({
        "DetectorName": "Presidio",
        "ExtraData": {"name": "PII name"},
        "Raw": raw,
        "SourceMetadata": {"Data": {"Git": git}},
    })


class TestIssue185(unittest.TestCase):
    def test_pii_false_positives_whitelisted(self):
        allowed = alert.load_allowlist()
        lines = [_finding(raw, file, line) for raw, file, line in FINDINGS]
        found = alert.collect(lines, recent=None, allowed=allowed)
        failures = []
        for raw, _, _ in FINDINGS:
            if ("PII name", raw) in found:
                failures.append(f"{raw!r} still reported by the PII scan")
        if failures:
            print("FAIL: test_issue_185.TestIssue185.test_pii_false_positives_whitelisted "
                  + "; ".join(failures))
            sys.exit(1)
        print("test_issue_185.TestIssue185.test_pii_false_positives_whitelisted: PASS")


if __name__ == "__main__":
    TestIssue185("test_pii_false_positives_whitelisted").test_pii_false_positives_whitelisted()
