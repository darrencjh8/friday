#!/usr/bin/env python3
"""Prove pii-scan-alert.py leaves out only the exact allowlisted occurrence.

The allowlist may hide a confirmed false positive and nothing else: not the same
value from another detector, name, commit or file, and never a commit-message
hit. A missing or malformed allowlist must fail the run, not silence it.

Values here are synthetic.

Run: python tests/test_pii_allowlist.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import smtplib
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location(
    "pii_scan_alert", os.path.join(ROOT, "scripts", "pii-scan-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)

VALUE = "zed.quill@example.com"
CONFIRMED = "Wei Ling Tan"  # public synthetic fixture in scripts/test-pii-scan-alert.py
SHIPPED = os.path.join(ROOT, "scripts", "pii-scan-allowlist.json")
ENV = {"SMTP_USERNAME": "sender@example.com", "SMTP_PASSWORD": "hunter2-synthetic",
       "PII_SCAN_EMAIL_TO": "owner@example.com"}
ALLOWED = {"detector": "Presidio", "name": "PII name", "value": VALUE,
           "commit": "a" * 40, "file": "notes.txt"}


def finding(detector="Presidio", name="PII name", raw=VALUE, commit="a" * 40,
            file="notes.txt", line=3, email="dev <dev@example.com>"):
    git = {"commit": commit, "email": email, "line": line}
    if file:
        git["file"] = file
    hit = {"DetectorName": detector, "Raw": raw, "SourceMetadata": {"Data": {"Git": git}}}
    if name is not None:
        hit["ExtraData"] = {"name": name}
    return json.dumps(hit)


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


def run(lines, entries=(ALLOWED,), text=None, path=None):
    """Run main() against an allowlist and return (exit code, output, messages)."""
    FakeSMTP.sent = []
    smtplib.SMTP_SSL = FakeSMTP
    alert.recent_commits = lambda: set()
    if path is None:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        handle.write(text if text is not None else json.dumps({"entries": list(entries)}))
        handle.close()
        path = handle.name
    out = io.StringIO()
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl") as findings:
        findings.write("\n".join(lines) + ("\n" if lines else ""))
        findings.flush()
        saved = dict(os.environ)
        os.environ.update(ENV)
        os.environ.update(FULL_HISTORY="true", PII_SCAN_ALLOWLIST=path)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                code = alert.main(["pii-scan-alert.py", findings.name])
        finally:
            os.environ.clear()
            os.environ.update(saved)
    return code, out.getvalue(), FakeSMTP.sent


def body(message):
    return message.get_content()


def test_allowlist_exact_occurrence():
    fixture = next(e for e in alert.load_allowlist(SHIPPED)
                   if e[2] == CONFIRMED and e[4] == "scripts/test-pii-scan-alert.py")
    allowed = finding(detector=fixture[0], name=fixture[1],
                      raw=fixture[2], commit=fixture[3], file=fixture[4])
    neighbour = finding(raw="neighbour@example.com")
    code, _, sent = run([allowed, neighbour], entries=(dict(zip(
        ("detector", "name", "value", "commit", "file"), fixture)),))
    assert code == 0
    assert len(sent) == 1
    assert CONFIRMED not in body(sent[0])
    assert "neighbour@example.com" in body(sent[0])


def test_each_field_must_match():
    for change in ({"detector": "Other"}, {"name": "Other"}, {"raw": "other@example.com"},
                   {"commit": "b" * 40}, {"file": "other.txt"}):
        _, _, sent = run([finding(**change)])
        assert len(sent) == 1, change
        assert "other@example.com" in body(sent[0]) or VALUE in body(sent[0])


def test_commit_message_never_suppressed():
    _, _, sent = run([finding(file=None)])
    assert len(sent) == 1
    assert VALUE in body(sent[0])


def test_mixed_allowed_and_unallowed_locations():
    _, _, sent = run([finding(file="notes.txt"), finding(file="other.txt")])
    text = body(sent[0])
    assert "other.txt" in text
    assert "notes.txt" not in text
    assert text.count(VALUE) == 1


def test_both_scanner_formats():
    presidio = {"detector": "Presidio", "name": "PII name", "value": VALUE,
                "commit": "a" * 40, "file": "notes.txt"}
    trufflehog = {"detector": "PII email", "name": None, "value": VALUE,
                  "commit": "a" * 40, "file": "notes.txt"}
    _, _, sent = run([finding(detector="Presidio"), finding(detector="PII email", name=None)],
                     entries=(presidio, trufflehog))
    assert sent == []
    _, _, sent = run([finding(detector="PII email", name=None)], entries=(presidio,))
    assert len(sent) == 1


def test_missing_allowlist_fails_the_run():
    code, output, sent = run([finding()], path=os.path.join(HERE, "absent-allowlist.json"))
    assert code == 1
    assert sent == []
    assert "AllowlistError" in output
    assert VALUE not in output


def test_malformed_allowlist_fails_the_run():
    for text in ("not json " + VALUE, "[]", '{"entries": 1}', '{"entries": [1]}'):
        code, output, sent = run([finding()], text=text)
        assert code == 1, text
        assert sent == []
        assert VALUE not in output


def test_invalid_entries_fail_the_run():
    invalid = [
        {key: ALLOWED[key] for key in ("detector", "name", "value", "commit")},  # no file
        {**ALLOWED, "extra": "x"},
        {**ALLOWED, "file": None},  # could suppress commit messages
        {**ALLOWED, "value": ""},
        {**ALLOWED, "commit": "abc"},
        {**ALLOWED, "name": 1},
        {**ALLOWED, "detector": []},
    ]
    for entry in invalid:
        code, output, sent = run([finding()], entries=(entry,))
        assert code == 1, entry
        assert sent == []
        assert VALUE not in output


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"pii-scan-allowlist: {len(tests)} tests passed")
