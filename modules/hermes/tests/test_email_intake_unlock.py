"""Email-intake password-protected statements (issue #783, cutover PR 3).

Synthetic mail and passwords only. The PDFs are made and encrypted by qpdf,
which the Hermes image installs.
"""

import base64
import os
import subprocess
import sys
import tempfile
import unittest
from email import policy
from email.parser import BytesParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from test_email_intake import good_answer, make_mail  # noqa: E402
from test_email_intake_dispatch import FakeTracker, Harness, StoringImap  # noqa: E402

from intake import notify, unlock  # noqa: E402

PASSWORD = "synthetic-pass-1"
STATEMENT = "http://expense.test/process/statement"


def _qpdf(*args):
    subprocess.run(["qpdf", *args], check=True, capture_output=True)


def make_pdfs():
    with tempfile.TemporaryDirectory() as tmp:
        plain, locked = os.path.join(tmp, "plain.pdf"), os.path.join(tmp, "locked.pdf")
        _qpdf("--empty", plain)
        _qpdf("--encrypt", PASSWORD, "owner-" + PASSWORD, "256", "--", plain, locked)
        return Path(plain).read_bytes(), Path(locked).read_bytes()


PLAIN, LOCKED = make_pdfs()


def pdfs_of(raw):
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    return [p.get_payload(decode=True) for p in msg.walk() if p.get_content_type() == "application/pdf"]


class PasswordsTest(unittest.TestCase):
    def test_only_named_statement_secrets_count_once_each_in_name_order(self):
        found = unlock.statement_passwords(
            {"STMT_PW_BETA": "two", "STMT_PW_ALPHA": "one", "IMAP_PASSWORD": "not-this", "STMT_PW_EMPTY": " "},
            {"STMT_PW_ALPHA": "ignored-later-source", "STMT_PW_GAMMA": "one"},
        )
        self.assertEqual(found, ["one", "two"])

    def test_no_sources_means_no_passwords(self):
        self.assertEqual(unlock.statement_passwords({}, None), [])


class DecryptTest(unittest.TestCase):
    def test_the_right_password_opens_it_after_wrong_ones(self):
        opened = unlock.decrypt_pdf(LOCKED, ["wrong-1", "wrong-2", PASSWORD])
        self.assertTrue(opened.startswith(b"%PDF"))
        self.assertFalse(unlock.is_encrypted(opened))

    def test_no_matching_password_leaves_it_locked(self):
        self.assertIsNone(unlock.decrypt_pdf(LOCKED, ["wrong-1"]))

    def test_the_password_never_reaches_the_command_line(self):
        commands = []

        def run(cmd, **kw):
            commands.append(cmd)
            return subprocess.run(cmd, **kw)

        unlock.decrypt_pdf(LOCKED, ["wrong-1", PASSWORD], run=run)
        self.assertEqual(len(commands), 2)
        for cmd in commands:
            self.assertFalse(any(PASSWORD in arg or "wrong-1" in arg for arg in cmd))

    def test_a_missing_qpdf_leaves_it_locked(self):
        def run(cmd, **kw):
            raise FileNotFoundError("qpdf")

        self.assertIsNone(unlock.decrypt_pdf(LOCKED, [PASSWORD], run=run))


class UnlockEmailTest(unittest.TestCase):
    def test_an_email_without_an_encrypted_pdf_is_unchanged_and_reads_no_secrets(self):
        raw = make_mail(pdf=PLAIN)

        def passwords():
            raise AssertionError("Bitwarden must not be read for this email")

        self.assertIs(unlock.unlock(raw, passwords), raw)

    def test_an_encrypted_statement_is_rebuilt_with_the_opened_pdf(self):
        raw = make_mail(subject="Your statement", body="Statement attached.", pdf=LOCKED)
        opened = unlock.unlock(raw, lambda: ["wrong-1", PASSWORD])
        (pdf,) = pdfs_of(opened)
        self.assertFalse(unlock.is_encrypted(pdf))
        msg = BytesParser(policy=policy.default).parsebytes(opened)
        self.assertEqual(msg["Subject"], "Your statement")
        self.assertIn("Statement attached.", msg.get_body(("plain",)).get_content())
        (attachment,) = list(msg.iter_attachments())
        self.assertEqual(attachment.get_filename(), "statement.pdf")

    def test_no_password_or_a_wrong_one_keeps_it_locked(self):
        raw = make_mail(pdf=LOCKED)
        self.assertIsNone(unlock.unlock(raw, list))
        self.assertIsNone(unlock.unlock(raw, lambda: ["wrong-1"]))


class LiveStatementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.passwords = [PASSWORD]

    def harness(self, raw, tracker=None, mode="live"):
        h = Harness(self.tmp.name, StoringImap({"INBOX": [(5, raw)]}), good_answer("actual_budget", "statement"),
                    mode, booked=lambda validity: set(), tracker=tracker,
                    unlock=lambda r: unlock.unlock(r, lambda: list(self.passwords)))
        self.addCleanup(h.journal.close)
        h.journal.checkpoint("INBOX", 1, 0, account="acct")
        self.sent = []
        h.outbox = notify.Outbox(h.journal, lambda text: self.sent.append(text) or notify.SENT)
        return h

    def run_all(self, h):
        h.run()
        h.outbox.flush()

    def test_an_opened_statement_is_classified_and_booked_from_the_decrypted_copy(self):
        tracker = FakeTracker({STATEMENT: {"status": "processed", "action": "statement",
                                           "messages": ["Statement booked"]}})
        h = self.harness(make_mail(subject="Your statement", pdf=LOCKED), tracker)
        self.run_all(h)
        (url, body, _), = tracker.calls
        self.assertEqual(url, STATEMENT)
        (pdf,) = pdfs_of(base64.b64decode(body["evidence"]["raw_email_b64"]))
        self.assertFalse(unlock.is_encrypted(pdf))
        self.assertEqual(h.imap.seen, [("INBOX", 5)])
        self.assertEqual(self.sent, ["Statement booked"])

    def test_without_a_password_it_stays_blocked_unread_and_the_owner_is_told(self):
        self.passwords = []
        tracker = FakeTracker()
        h = self.harness(make_mail(subject="Your statement", pdf=LOCKED), tracker)
        self.run_all(h)
        self.assertEqual(tracker.calls, [])
        self.assertEqual(h.imap.seen, [])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("password-protected", self.sent[0])

    def test_a_password_removed_after_classifying_is_retried_then_reported(self):
        tracker = FakeTracker()
        h = self.harness(make_mail(subject="Your statement", pdf=LOCKED), tracker)
        # Classified while the password was there; gone by the time it is sent.
        h.dispatcher._unlock = lambda raw: unlock.unlock(raw, list)
        for _ in range(3):
            self.run_all(h)
        self.assertEqual(tracker.calls, [])
        self.assertEqual(h.imap.seen, [])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("encrypted", self.sent[0])
        self.assertIn("unread", self.sent[0])

    def test_shadow_mode_classifies_it_but_sends_nothing(self):
        tracker = FakeTracker()
        h = self.harness(make_mail(subject="Your statement", pdf=LOCKED), tracker, mode="rehearsal")
        summary = h.run()
        self.assertEqual(summary["blocked"], 0)
        self.assertEqual(tracker.calls, [])
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
