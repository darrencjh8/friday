#!/usr/bin/env python3
"""Reproduction control for friday #205: the scheduled PII scan emails the
synthetic fixture in test_issue_202.py as a finding, and there is no
adjudication step — the only suppression path is another allowlist entry.

The fix feeds the scan's final results to JEV: a finding is emailed only
when JEV does not confidently call it a false positive. Credential-shape
findings never go to JEV and are always emailed, except URI findings,
which go with the password redacted to its shape; when JEV is unavailable
or the key is absent, findings are emailed as today (fail open).

No flagged value is written in this file: the fixture value is read out
of test_issue_202.py and the other values out of the allowlist entries,
and each finding is built at a commit/file whose exact tuple is not
allowlisted, so the test stays true without hardcoding the values.

Run: python3 modules/tests/test_issue_205.py
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import smtplib
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

spec = importlib.util.spec_from_file_location(
    "pii_scan_alert", os.path.join(ROOT, "scripts", "pii-scan-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)

# The #203 merge, which introduced the flagged fixture.
FIXTURE_COMMIT = "b88d3c264ed46622fc5573802d479140f55188fe"
FIXTURE_FILE = "modules/tests/test_issue_202.py"
FIXTURE_LINE = 42
SELF_FILE = "modules/tests/test_issue_205.py"

ENV = {"SMTP_USERNAME": "sender@example.com",
       "SMTP_PASSWORD": "hunter2-synthetic",
       "PII_SCAN_EMAIL_TO": "owner@example.com",
       "JEV_API_KEY": "test-key"}


def _fixture_value():
    text = open(os.path.join(ROOT, FIXTURE_FILE), encoding="utf-8").read()
    return re.search(r'^REAL_ADDRESS\s*=\s*"([^"]+)"', text, re.M).group(1)


def _allowlist_entry(detector):
    with open(os.path.join(ROOT, "scripts", "pii-scan-allowlist.json"),
              encoding="utf-8") as handle:
        entries = json.load(handle)["entries"]
    return next(e for e in entries if e["detector"] == detector)


def _allowlist_value(detector):
    return _allowlist_entry(detector)["value"]


def _finding(raw, detector, name, commit, file, line):
    git = {"commit": commit, "email": "dev <dev@example.com>",
           "line": line, "file": file}
    return json.dumps({
        "DetectorName": detector,
        "ExtraData": {"name": name},
        "Raw": raw,
        "SourceMetadata": {"Data": {"Git": git}},
    })


class FakeSMTP:
    sent: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        pass

    def send_message(self, message):
        FakeSMTP.sent.append(message)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeJev:
    calls: list = []
    verdict = "false_positive"
    confidence = 0.97
    probabilities = {"false_positive": 0.97, "real": 0.02, "uncertain": 0.01}
    error = None

    def __call__(self, request, timeout=None):
        FakeJev.calls.append(request)
        if FakeJev.error is not None:
            raise FakeJev.error
        payload = {"answers": {"verdict": {
            "choice": FakeJev.verdict, "confidence": FakeJev.confidence,
            "probabilities": FakeJev.probabilities}}}
        return FakeResponse(json.dumps(payload).encode())


def _run(lines, verdict="false_positive", error=None, env=None, jev=True,
         full=True, recent=(), confidence=0.97, probabilities=None):
    FakeSMTP.sent = []
    FakeJev.calls, FakeJev.verdict, FakeJev.error = [], verdict, error
    FakeJev.confidence = confidence
    FakeJev.probabilities = probabilities or {
        "false_positive": 0.97, "real": 0.02, "uncertain": 0.01}
    real_smtp, real_urlopen = smtplib.SMTP_SSL, urllib.request.urlopen
    real_recent = alert.recent_commits
    if jev:
        smtplib.SMTP_SSL, urllib.request.urlopen = FakeSMTP, FakeJev()
    else:
        def _exploding_jev(*args, **kwargs):
            raise AssertionError("JEV must not be called without a key")
        smtplib.SMTP_SSL, urllib.request.urlopen = FakeSMTP, _exploding_jev
    if not full:
        alert.recent_commits = lambda: set(recent)
    out = io.StringIO()
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl") as handle:
        handle.write("\n".join(lines) + ("\n" if lines else ""))
        handle.flush()
        saved = dict(os.environ)
        os.environ.update(env if env is not None else ENV)
        os.environ["FULL_HISTORY"] = "true" if full else "false"
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                code = alert.main(["pii-scan-alert.py", handle.name])
        finally:
            os.environ.clear()
            os.environ.update(saved)
            smtplib.SMTP_SSL, urllib.request.urlopen = real_smtp, real_urlopen
            alert.recent_commits = real_recent
    return code, out.getvalue(), FakeSMTP.sent


def _body(message):
    return message.get_content()


class TestIssue205(unittest.TestCase):
    def test_fixture_finding_adjudicated_false_positive(self):
        line = _finding(_fixture_value(), "CustomRegex", "PII email",
                        FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        code, _, sent = _run([line])
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if sent:
            failures.append("fixture finding was emailed instead of "
                            "being adjudicated a false positive")
        if not FakeJev.calls:
            failures.append("JEV was never asked about the finding")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_fixture_finding_adjudicated_false_positive "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_fixture_finding_adjudicated_false_positive: PASS")

    def test_real_finding_still_emailed(self):
        line = _finding(_allowlist_value("CustomRegex"), "CustomRegex",
                        "PII email", FIXTURE_COMMIT, SELF_FILE, 1)
        code, _, sent = _run([line], verdict="real")
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not sent:
            failures.append("finding JEV called real was not emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_real_finding_still_emailed " + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_real_finding_still_emailed: PASS")

    def test_jev_unavailable_still_emails(self):
        line = _finding(_fixture_value(), "CustomRegex", "PII email",
                        FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        code, _, sent = _run(
            [line], error=urllib.error.URLError("boom"))
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not sent:
            failures.append("finding was dropped when JEV was unavailable "
                            "instead of being emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_jev_unavailable_still_emails " + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_jev_unavailable_still_emails: PASS")

    def test_credential_finding_never_sent_to_jev(self):
        line = _finding(_allowlist_value("Postgres"), "Postgres", None,
                        FIXTURE_COMMIT, SELF_FILE, 1)
        code, _, sent = _run([line])
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if FakeJev.calls:
            failures.append("a credential-shape finding was sent to JEV")
        if not sent:
            failures.append("credential-shape finding was not emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_credential_finding_never_sent_to_jev "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_credential_finding_never_sent_to_jev: PASS")

    def test_jev_key_absent_still_emails(self):
        line = _finding(_fixture_value(), "CustomRegex", "PII email",
                        FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        env = {k: v for k, v in ENV.items() if k != "JEV_API_KEY"}
        code, _, sent = _run([line], env=env, jev=False)
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not sent:
            failures.append("finding was dropped when no JEV key was set "
                            "instead of being emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_jev_key_absent_still_emails " + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_jev_key_absent_still_emails: PASS")

    def test_false_positive_low_confidence_still_emailed(self):
        line = _finding(_fixture_value(), "CustomRegex", "PII email",
                        FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        code, _, sent = _run(
            [line], confidence=0.60,
            probabilities={"false_positive": 0.60, "real": 0.25,
                           "uncertain": 0.15})
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not sent:
            failures.append("false_positive at confidence 0.60 was "
                            "suppressed instead of emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_false_positive_low_confidence_still_emailed "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_false_positive_low_confidence_still_emailed: PASS")

    def test_false_positive_low_margin_still_emailed(self):
        line = _finding(_fixture_value(), "CustomRegex", "PII email",
                        FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        code, _, sent = _run(
            [line], confidence=0.97,
            probabilities={"false_positive": 0.50, "real": 0.40,
                           "uncertain": 0.10})
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not sent:
            failures.append("false_positive at margin 0.10 was suppressed "
                            "instead of emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_false_positive_low_margin_still_emailed "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_false_positive_low_margin_still_emailed: PASS")

    def test_stale_and_allowlisted_findings_never_sent_to_jev(self):
        stale = _finding(_allowlist_value("CustomRegex"), "CustomRegex",
                         "PII email", "c" * 40, SELF_FILE, 1)
        entry = _allowlist_entry("CustomRegex")
        allowed = _finding(entry["value"], entry["detector"], entry["name"],
                           entry["commit"], entry["file"], 1)
        code, _, sent = _run([stale, allowed], full=False, recent=[])
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if FakeJev.calls:
            failures.append("a stale or allowlisted finding was sent to JEV")
        if sent:
            failures.append("a stale or allowlisted finding was emailed")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_stale_and_allowlisted_findings_never_sent_to_jev "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_stale_and_allowlisted_findings_never_sent_to_jev: PASS")

    def test_same_value_in_fixture_and_real_file_judged_on_all_locations(self):
        fixture_line = _finding(_fixture_value(), "CustomRegex", "PII email",
                                FIXTURE_COMMIT, FIXTURE_FILE, FIXTURE_LINE)
        real_line = _finding(_fixture_value(), "CustomRegex", "PII email",
                             FIXTURE_COMMIT, SELF_FILE, 7)
        code, _, _ = _run([fixture_line, real_line])
        failures = []
        if code != 0:
            failures.append("scan run failed instead of completing")
        if not FakeJev.calls:
            failures.append("JEV was never asked about the finding")
        else:
            state = json.loads(FakeJev.calls[0].data.decode())["state"]
            if FIXTURE_FILE not in state or SELF_FILE not in state:
                failures.append("JEV state lists only one location instead "
                                "of all of them")
        if failures:
            print("FAIL: tests.test_issue_205.TestIssue205."
                  "test_same_value_in_fixture_and_real_file_judged_on_all_locations "
                  + "; ".join(failures))
            sys.exit(1)
        print("tests.test_issue_205.TestIssue205."
              "test_same_value_in_fixture_and_real_file_judged_on_all_locations: PASS")


    def _uri_finding(self):
        # A synthetic stub URL from a shell test, read out of the allowlist.
        value = _allowlist_value("URI")
        line = _finding(value, "URI", None, FIXTURE_COMMIT,
                        "modules/hermes/tests/test-memory-restore.sh", 164)
        return value, line

    def test_uri_finding_sent_to_jev_with_secret_redacted(self):
        value, line = self._uri_finding()
        secret = alert.urllib.parse.urlsplit(value).password
        code, _, sent = _run([line])
        self.assertEqual(code, 0)
        self.assertEqual(sent, [], "stub URL JEV calls false_positive was emailed")
        self.assertEqual(len(FakeJev.calls), 1, "URI finding was not sent to JEV")
        state = json.loads(FakeJev.calls[0].data)["state"]
        self.assertNotIn(secret, state, "the URL secret reached JEV")
        self.assertIn("example.com", state)
        self.assertIn("test-memory-restore.sh", state)

    def test_uri_finding_judged_real_still_emailed(self):
        value, line = self._uri_finding()
        code, _, sent = _run([line], verdict="real")
        self.assertEqual(code, 0)
        self.assertEqual(len(sent), 1)
        self.assertIn(value, _body(sent[0]))

    def test_uri_without_password_never_sent_to_jev(self):
        line = _finding("https://example.com/path", "URI", None,
                        FIXTURE_COMMIT, SELF_FILE, 1)
        code, _, sent = _run([line])
        self.assertEqual(code, 0)
        self.assertEqual(FakeJev.calls, [])
        self.assertEqual(len(sent), 1)


if __name__ == "__main__":
    TestIssue205("test_fixture_finding_adjudicated_false_positive").test_fixture_finding_adjudicated_false_positive()
