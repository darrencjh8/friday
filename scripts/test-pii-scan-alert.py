#!/usr/bin/env python3
"""Prove pii-scan-alert.py emails findings and never prints them, and that
pii-scan-names.py reads git history correctly and fails quietly.

The repository's Actions logs are public, so the assertions that matter most are
the ones about stdout and stderr. Values here are synthetic.

Run: python3 scripts/test-pii-scan-alert.py
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
spec = importlib.util.spec_from_file_location("pii_scan_alert", os.path.join(HERE, "pii-scan-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)
spec = importlib.util.spec_from_file_location("pii_scan_names", os.path.join(HERE, "pii-scan-names.py"))
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)

VALUE = "zed.quill@example.com"
ENV = {"SMTP_USERNAME": "sender@example.com", "SMTP_PASSWORD": "hunter2-synthetic", "PII_SCAN_EMAIL_TO": "owner@example.com"}


def finding(raw=VALUE, commit="a" * 40, file="notes.txt", line=3, email="dev <dev@example.com>", name="PII email"):
    git = {"commit": commit, "email": email, "line": line}
    if file:
        git["file"] = file
    return json.dumps({"DetectorName": "CustomRegex", "ExtraData": {"name": name}, "Raw": raw, "SourceMetadata": {"Data": {"Git": git}}})


class FakeSMTP:
    sent: list = []
    error: Exception | None = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        pass

    def send_message(self, message):
        if FakeSMTP.error:
            raise FakeSMTP.error
        FakeSMTP.sent.append(message)


def run(lines, full=True, recent=(), env=ENV, error=None):
    """Run main() and return (exit code, stdout + stderr, sent messages)."""
    FakeSMTP.sent, FakeSMTP.error = [], error
    smtplib.SMTP_SSL = FakeSMTP
    alert.recent_commits = lambda: set(recent)
    out = io.StringIO()
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl") as handle:
        handle.write("\n".join(lines) + ("\n" if lines else ""))
        handle.flush()
        empty = tempfile.NamedTemporaryFile("r", suffix=".jsonl")
        saved = dict(os.environ)
        os.environ.update(env)
        os.environ["FULL_HISTORY"] = "true" if full else "false"
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                code = alert.main(["pii-scan-alert.py", empty.name, handle.name])
        finally:
            os.environ.clear()
            os.environ.update(saved)
            empty.close()
    return code, out.getvalue(), FakeSMTP.sent


def body(message):
    return message.get_content()


def test_finding_is_emailed_and_never_printed():
    code, output, sent = run([finding()])
    assert code == 0
    assert len(sent) == 1
    assert VALUE in body(sent[0])
    assert sent[0]["To"] == ENV["PII_SCAN_EMAIL_TO"]
    assert VALUE not in sent[0]["Subject"]
    assert VALUE not in output


def test_output_does_not_reveal_whether_anything_was_found():
    _, with_finding, _ = run([finding()])
    _, without_finding, sent = run([])
    assert with_finding == without_finding
    assert sent == []


def test_send_failure_exits_nonzero_without_quoting_the_exception():
    code, output, _ = run([finding()], error=smtplib.SMTPRecipientsRefused({VALUE: (550, b"rejected")}))
    assert code == 1
    assert VALUE not in output
    assert "SMTPRecipientsRefused" in output


def test_malformed_line_fails_instead_of_being_skipped():
    secret_line = "not json " + VALUE
    code, output, sent = run([secret_line])
    assert code == 1
    assert sent == []
    assert VALUE not in output


def test_missing_recipient_fails_even_with_no_findings():
    code, _, _ = run([], env={**ENV, "PII_SCAN_EMAIL_TO": ""})
    assert code == 1


def test_daily_mode_keeps_only_recent_commits():
    old, new = finding(commit="a" * 40), finding(raw="new@example.com", commit="b" * 40)
    _, _, sent = run([old, new], full=False, recent=["b" * 40])
    assert "new@example.com" in body(sent[0])
    assert VALUE not in body(sent[0])


def test_full_history_keeps_old_commits():
    _, _, sent = run([finding(commit="a" * 40)], full=True, recent=[])
    assert VALUE in body(sent[0])


def test_author_metadata_dropped_but_commit_message_hit_kept():
    author = finding(file=None, email=f"Dev <{VALUE}>")
    _, _, sent = run([author])
    assert sent == []
    _, _, sent = run([finding(file=None)])
    assert VALUE in body(sent[0])


def test_duplicates_collapse_and_list_every_location():
    _, _, sent = run([finding(file="one.txt"), finding(file="two.txt")])
    text = body(sent[0])
    assert text.count(VALUE) == 1
    assert "one.txt" in text and "two.txt" in text


LOG = """\0aaa111
Payment for Wei Ling Tan

Co-Authored-By: Claude Opus <noreply@example.com>

diff --git a/notes.txt b/notes.txt
--- a/notes.txt
+++ b/notes.txt
@@ -1,0 +7,2 @@
+first line
+Second Line
--- removed Line Here
@@ -9 +20 @@
-Old Name
+Third Line
\0bbb222
Second commit
diff --git a/gone.txt b/gone.txt
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-Old Name
"""


def test_history_parser_reports_added_lines_and_messages():
    parsed = list(names.added_lines(LOG.split("\n")))
    assert ("aaa111", None, 0, "Payment for Wei Ling Tan") in parsed
    assert ("aaa111", "notes.txt", 7, "first line") in parsed
    assert ("aaa111", "notes.txt", 8, "Second Line") in parsed
    assert ("aaa111", "notes.txt", 20, "Third Line") in parsed
    assert ("bbb222", None, 0, "Second commit") in parsed
    assert not any("Old Name" in entry[3] or "removed" in entry[3] for entry in parsed)
    assert not any("Claude" in entry[3] for entry in parsed)


def test_history_parser_skips_github_trailers_in_any_case():
    log = ["\0ccc333", "Subject line", "", "Co-authored-by: Some Person <a@example.com>",
           "co-authored-by: Other Person <b@example.com>", "Signed-off-by: Third Person <c@example.com>"]
    assert [t for *_, t in names.added_lines(log)] == ["Subject line"]


def test_scans_leave_out_the_allowlist_file_itself():
    # The allowlist lists the values it excuses, so scanning it would report each one again.
    seen = []

    def fake_run(command, **kwargs):
        seen.append(command)
        return type("Done", (), {"stdout": b""})()

    real = names.subprocess.run
    names.subprocess.run = fake_run
    try:
        names.git_log(True)
    finally:
        names.subprocess.run = real
    assert ":!scripts/pii-scan-allowlist.json" in seen[0]
    workflow = open(os.path.join(HERE, "..", ".github", "workflows", "pii-scan.yml"), encoding="utf-8").read()
    patterns = open(os.path.join(HERE, "pii-scan-exclude-paths.txt"), encoding="utf-8").read()
    assert "--exclude-paths scripts/pii-scan-exclude-paths.txt" in workflow
    assert r"^scripts/pii-scan-allowlist\.json$" in patterns.split()
    assert r"^scripts/pii-synthetic-numbers\.txt$" in patterns.split()  # lists the numbers it excuses


def test_name_shape_accepts_names_and_rejects_code():
    for good in ("Wei Ling Tan", "TAN WEI LING", "Mary O'Neil"):
        assert names.NAME.fullmatch(good), good
    for bad in ("Payee", "getUserName", "user name", "Tan wei", "A B"):
        assert not names.NAME.fullmatch(bad), bad


def test_candidate_filter_skips_lines_with_no_name_shape():
    assert names.CANDIDATE.search("from Wei Ling to you")
    assert names.CANDIDATE.search("HOLDER TAN WEI")
    assert not names.CANDIDATE.search("const userName = getUserName(accountId)")


def test_names_failure_prints_only_the_exception_type():
    def explode(*args):
        raise RuntimeError(VALUE)

    names.scan = explode
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        code = names.main(["pii-scan-names.py", "/nonexistent/out.jsonl"])
    assert code == 1
    assert VALUE not in out.getvalue()
    assert "RuntimeError" in out.getvalue()


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"pii-scan-alert: {len(tests)} tests passed")
