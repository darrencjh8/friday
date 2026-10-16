"""Email-intake dispatch: shadow rehearsal and live dispatch (issues #783, #796).

Synthetic mail only: no real sender, merchant, person or account data.
"""

import base64
import hashlib
import hmac
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from test_email_intake import FakeImap, FakeJev, good_answer, make_mail  # noqa: E402

from intake import dispatch, jev, service  # noqa: E402
from intake.journal import Journal  # noqa: E402
from intake.scanner import Scanner  # noqa: E402
from intake.shadow import ShadowRunner  # noqa: E402

SECRET = "test-secret"
URLS = {dispatch.EXPENSE: "http://expense.test", dispatch.PORTFOLIO: "http://portfolio.test"}


class StoringImap(FakeImap):
    """FakeImap that also accepts UID STORE, so live mark-read can be observed."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.seen = []

    def uid(self, command, *args):
        if command == "STORE":
            self.commands.append(("UID", command) + args)
            self.seen.append((self.selected, int(args[0])))
            return "OK", [b""]
        return super().uid(command, *args)


class FakeTracker:
    def __init__(self, replies=None):
        self.calls = []
        self.replies = replies or {}

    def __call__(self, url, body, headers):
        self.calls.append((url, body, headers))
        reply = self.replies.get(url, {"status": "processed", "action": "insert", "messages": ["booked"]})
        if isinstance(reply, list):
            reply = reply.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return dict(reply, request_id=body["request_id"])


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Harness:
    def __init__(self, tmp, imap, answers, mode, boundary=None, tracker=None):
        self.journal = Journal(Path(tmp) / "j.db")
        self.imap = imap
        self.tracker = tracker or FakeTracker()
        self.clock = Clock()
        self.classifier = ShadowRunner(
            scanner=Scanner(lambda: imap, self.journal, account="acct"),
            journal=self.journal,
            classify=lambda text, context="": jev.classify(state_text=text, post=FakeJev(answers), context=context),
        )
        self.dispatcher = dispatch.Dispatcher(
            journal=self.journal, mailbox=dispatch.ImapMailbox(lambda: imap), post=self.tracker, secret=SECRET,
            urls=URLS, account="acct", mode=mode, boundary=boundary, clock=self.clock,
        )
        self.runner = service.Runner(self.classifier, self.dispatcher)

    def run(self):
        return self.runner.run_once()

    def rows(self, mode):
        con = sqlite3.connect(self.journal.path)
        try:
            return con.execute("SELECT kind, status, attempts, request_id FROM dispatches WHERE mode = ?",
                               (mode,)).fetchall()
        finally:
            con.close()


class LegsTest(unittest.TestCase):
    def test_destination_and_subtype_decide_the_requests(self):
        self.assertEqual(dispatch.legs({"destination": "actual_budget", "subtype": "transaction"}),
                         [("transaction", "expense")])
        self.assertEqual(dispatch.legs({"destination": "actual_budget", "subtype": "statement"}),
                         [("statement", "expense")])
        self.assertEqual(dispatch.legs({"destination": "portfolio", "subtype": "statement"}),
                         [("portfolio", "portfolio")])
        self.assertEqual(dispatch.legs({"destination": "both", "subtype": "transaction"}),
                         [("transaction", "expense"), ("portfolio", "portfolio")])
        for destination in ("neither", "uncertain", "notify", None):
            self.assertEqual(dispatch.legs({"destination": destination}), [])

    def test_request_id_is_stable_per_email_and_leg_and_fits_the_tracker_contract(self):
        evidence = hashlib.sha256(b"x").hexdigest()
        rid = dispatch.request_id("live", "transaction", evidence)
        self.assertEqual(rid, dispatch.request_id("live", "transaction", evidence))
        self.assertNotEqual(rid, dispatch.request_id("live", "portfolio", evidence))
        self.assertNotEqual(rid, dispatch.request_id("rehearsal", "transaction", evidence))
        self.assertRegex(rid, r"^[A-Za-z0-9._:-]{8,128}$")

    def test_signature_matches_the_tracker_scheme(self):
        body = {"request_id": "intake:transaction:abc", "evidence": {"raw_email_b64": "QUJD"}}
        digest = hashlib.sha256(b"QUJD").hexdigest()
        want = hmac.new(SECRET.encode(), f"transaction:intake:transaction:abc:{digest}".encode(),
                        hashlib.sha256).hexdigest()
        self.assertEqual(dispatch.sign("transaction", body, SECRET), want)
        dry = dict(body, dry_run=True)
        want_dry = hmac.new(SECRET.encode(), f"transaction:dry_run:intake:transaction:abc:{digest}".encode(),
                            hashlib.sha256).hexdigest()
        self.assertEqual(dispatch.sign("transaction", dry, SECRET), want_dry)


class RehearsalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def harness(self, imap, answers, tracker=None):
        h = Harness(self.tmp.name, imap, answers, "rehearsal", tracker=tracker)
        self.addCleanup(h.journal.close)
        return h

    def test_new_transaction_mail_is_sent_as_a_signed_dry_run_and_recorded(self):
        raw = make_mail()
        tracker = FakeTracker({"http://expense.test/process/transaction": {
            "status": "dry_run", "action": "inserted",
            "writes": [{"tool": "check_duplicate", "would_be_duplicate": False},
                       {"tool": "insert_transaction", "args": {"account_id": "acc-1", "amount_cents": -500,
                                                               "date": "2026-10-11"}}]}})
        imap = FakeImap({"INBOX": [(1, raw)]})
        h = self.harness(imap, good_answer(), tracker)
        h.run()
        self.assertEqual(len(tracker.calls), 1)
        url, body, headers = tracker.calls[0]
        self.assertEqual(url, "http://expense.test/process/transaction")
        self.assertTrue(body["dry_run"])
        self.assertEqual(base64.b64decode(body["evidence"]["raw_email_b64"]), raw)
        self.assertEqual(headers["X-Process-Signature"], dispatch.sign("transaction", body, SECRET))
        state = h.journal.dispatch_state(hashlib.sha256(raw).hexdigest(), "transaction", "rehearsal")
        self.assertEqual(state["status"], "dry_run")
        self.assertEqual(state["result"]["plan"]["amount_cents"], -500)
        self.assertFalse(state["result"]["would_be_duplicate"])

    def test_rehearsal_never_writes_to_the_mailbox(self):
        imap = FakeImap({"INBOX": [(1, make_mail())]})  # FakeImap.store raises
        h = self.harness(imap, good_answer())
        h.run()
        self.assertTrue(all(not (c[0] == "SELECT" and c[2] is False) for c in imap.commands))
        self.assertFalse(any(c[:2] == ("UID", "STORE") for c in imap.commands))

    def test_only_expense_transactions_are_rehearsed_and_only_once(self):
        imap = FakeImap({"INBOX": [(1, make_mail(msgid="<a@x>")), (2, make_mail(msgid="<b@x>", body="other"))],
                         "Archive": [(1, make_mail(msgid="<a@x>"))]})
        h = self.harness(imap, good_answer())
        h.run()
        h.run()
        self.assertEqual(len(h.tracker.calls), 2)  # two unique emails; the Archive copy shares a request

    def test_statements_and_portfolio_mail_are_not_rehearsed(self):
        for answer in (good_answer("actual_budget", "statement"), good_answer("portfolio", "transaction")):
            with self.subTest(answer=answer):
                tmp = tempfile.TemporaryDirectory()
                self.addCleanup(tmp.cleanup)
                h = Harness(tmp.name, FakeImap({"INBOX": [(1, make_mail())]}), answer, "rehearsal")
                self.addCleanup(h.journal.close)
                h.run()
                self.assertEqual(h.tracker.calls, [])

    def test_mail_classified_before_rehearsal_began_is_not_rehearsed(self):
        imap = FakeImap({"INBOX": [(1, make_mail())]})
        h = self.harness(imap, good_answer())
        h.classifier.run_once()  # history, recorded before rehearsal existed
        h.clock.now = 10 ** 12
        h.run()
        self.assertEqual(h.tracker.calls, [])

    def test_a_failing_dry_run_is_recorded_and_classification_still_succeeds(self):
        tracker = FakeTracker({"http://expense.test/process/transaction": TimeoutError("slow")})
        h = self.harness(FakeImap({"INBOX": [(1, make_mail())]}), good_answer(), tracker)
        summary = h.run()
        self.assertEqual(summary["classified"], 1)
        self.assertEqual(h.rows("rehearsal")[0][1], "retry")


class LiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def harness(self, imap, answers, boundary=lambda validity: 0, tracker=None):
        h = Harness(self.tmp.name, imap, answers, "live", boundary=boundary, tracker=tracker)
        self.addCleanup(h.journal.close)
        return h

    def seed(self, h, inbox_validity=1, last_uid=0):
        h.journal.checkpoint("INBOX", inbox_validity, last_uid, account="acct")

    def test_books_new_mail_and_marks_the_inbox_copy_read(self):
        raw = make_mail()
        imap = StoringImap({"INBOX": [(5, raw)], "Archive": [(9, raw)]})
        h = self.harness(imap, good_answer())
        self.seed(h)
        summary = h.run()
        self.assertEqual(len(h.tracker.calls), 1)
        url, body, headers = h.tracker.calls[0]
        self.assertEqual(url, "http://expense.test/process/transaction")
        self.assertNotIn("dry_run", body)
        self.assertEqual(headers["X-Process-Signature"], dispatch.sign("transaction", body, SECRET))
        self.assertEqual(imap.seen, [("INBOX", 5)])
        self.assertEqual(summary["dispatch"]["ok"], 1)
        state = h.journal.dispatch_state(hashlib.sha256(raw).hexdigest(), "transaction", "live")
        self.assertEqual(state["result"]["messages"], ["booked"])

    def test_a_second_run_books_nothing_again(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer())
        self.seed(h)
        h.run()
        h.run()
        self.assertEqual(len(h.tracker.calls), 1)

    def test_both_sends_the_transaction_and_the_portfolio_leg(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer("both", "transaction"))
        self.seed(h)
        h.run()
        self.assertEqual([c[0] for c in h.tracker.calls],
                         ["http://expense.test/process/transaction", "http://portfolio.test/process/portfolio"])
        self.assertEqual(imap.seen, [("INBOX", 5)])

    def test_statements_go_to_the_statement_endpoint(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer("actual_budget", "statement"))
        self.seed(h)
        h.run()
        self.assertEqual(h.tracker.calls[0][0], "http://expense.test/process/statement")

    def test_mail_the_old_watcher_booked_is_never_sent_or_touched(self):
        imap = StoringImap({"INBOX": [(5, make_mail(msgid="<old@x>")), (6, make_mail(msgid="<new@x>", body="new"))]})
        h = self.harness(imap, good_answer(), boundary=lambda validity: 5)
        self.seed(h, last_uid=4)
        h.run()
        self.assertEqual(len(h.tracker.calls), 1)
        self.assertEqual(imap.seen, [("INBOX", 6)])
        self.assertIn(("transaction", "handed_off"), [(k, s) for k, s, _, _ in h.rows("live")])

    def test_inbox_mail_recorded_in_shadow_after_the_boundary_is_caught_up(self):
        raw = make_mail()
        imap = StoringImap({"INBOX": [(7, raw)], "Archive": [(3, make_mail(msgid="<z@x>", body="z"))]})
        shadow = Harness(self.tmp.name, imap, good_answer(), "rehearsal")
        shadow.journal.checkpoint("INBOX", 1, 0, account="acct")
        shadow.journal.checkpoint("Archive", 1, 0, account="acct")
        shadow.classifier.run_once()  # shadow era: both recorded, nothing booked
        shadow.journal.close()
        h = self.harness(imap, good_answer(), boundary=lambda validity: 6)
        h.clock.now = 10 ** 12
        h.run()
        # INBOX 7 is past the old watcher's last booking: booked now. The Archive email
        # predates live mode and the old watcher never read it: left to the owner.
        self.assertEqual(len(h.tracker.calls), 1)
        self.assertEqual(base64.b64decode(h.tracker.calls[0][1]["evidence"]["raw_email_b64"]), raw)

    def test_no_trusted_boundary_means_nothing_is_dispatched(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer(), boundary=lambda validity: None)
        self.seed(h)
        summary = h.run()
        self.assertEqual(h.tracker.calls, [])
        self.assertEqual(imap.seen, [])
        self.assertEqual(summary["dispatch"]["blocked"], "no_handoff_boundary")

    def test_a_released_failure_is_retried_with_the_same_request_then_gives_up_unread(self):
        tracker = FakeTracker({"http://expense.test/process/transaction":
                               {"status": "failed", "reason": "error"}})
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer(), tracker=tracker)
        self.seed(h)
        for _ in range(4):
            h.run()
        self.assertEqual(len(tracker.calls), dispatch.MAX_ATTEMPTS)
        self.assertEqual(len({c[1]["request_id"] for c in tracker.calls}), 1)
        self.assertEqual(h.rows("live")[0][1], "failed")
        self.assertEqual(imap.seen, [])

    def test_a_stored_failure_is_not_retried_and_stays_unread(self):
        tracker = FakeTracker({"http://expense.test/process/transaction":
                               {"status": "failed", "action": "llm_unavailable"}})
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer(), tracker=tracker)
        self.seed(h)
        h.run()
        h.run()
        self.assertEqual(len(tracker.calls), 1)
        self.assertEqual(imap.seen, [])

    def test_held_mail_is_marked_read_like_the_old_watcher(self):
        tracker = FakeTracker({"http://expense.test/process/transaction":
                               {"status": "needs_confirmation", "action": "notified"}})
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer(), tracker=tracker)
        self.seed(h)
        h.run()
        self.assertEqual(imap.seen, [("INBOX", 5)])


class BoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "dedup.db"
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE mailbox_state (key TEXT PRIMARY KEY, value TEXT)")
        db.execute("CREATE TABLE booked_messages (uid TEXT PRIMARY KEY, booked_at TEXT)")
        db.execute("INSERT INTO mailbox_state VALUES ('uidvalidity', '42')")
        db.executemany("INSERT INTO booked_messages VALUES (?, '2026-10-01')", [("9",), ("10",), ("100",)])
        db.commit()
        db.close()

    def test_highest_booked_uid_when_uidvalidity_matches(self):
        self.assertEqual(dispatch.read_handoff_boundary(self.path, 42), 100)

    def test_untrusted_when_uidvalidity_differs_or_db_is_missing(self):
        self.assertIsNone(dispatch.read_handoff_boundary(self.path, 43))
        self.assertIsNone(dispatch.read_handoff_boundary(Path(self.tmp.name) / "missing.db", 42))


class MailboxTest(unittest.TestCase):
    def test_only_inbox_mail_is_ever_marked_read(self):
        imap = StoringImap({"INBOX": [(5, b"x")], "Archive": [(5, b"x")]})
        box = dispatch.ImapMailbox(lambda: imap)
        self.assertFalse(box.mark_seen("Archive", 1, 5))
        self.assertTrue(box.mark_seen("INBOX", 1, 5))
        self.assertEqual(imap.seen, [("INBOX", 5)])

    def test_a_changed_uidvalidity_is_never_written(self):
        imap = StoringImap({"INBOX": [(5, b"x")]}, uidvalidity={"INBOX": 2})
        box = dispatch.ImapMailbox(lambda: imap)
        self.assertFalse(box.mark_seen("INBOX", 1, 5))
        self.assertIsNone(box.fetch("INBOX", 1, 5))
        self.assertEqual(imap.seen, [])


class WiringTest(unittest.TestCase):
    BASE = {"EMAIL_INTAKE_MODE": "shadow", "IMAP_HOST": "imap.example", "IMAP_USERNAME": "u",
            "IMAP_PASSWORD": "p", "JEV_API_KEY": "k", "HERMES_WEBHOOK_SECRET": "s"}

    def load(self, **over):
        env = {**self.BASE, **over}
        return service.load_settings(lambda key, default="": env.get(key, default))

    def test_live_cannot_be_selected_until_the_cutover_switch(self):
        self.assertIsNone(self.load(EMAIL_INTAKE_MODE="live"))

    def test_shadow_rehearses_when_the_signing_secret_is_present(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        runner = service.build_runner(self.load(EMAIL_INTAKE_DATA_DIR=tmp.name))
        self.assertEqual(runner._dispatcher._mode, "rehearsal")
        self.assertIsNone(service.build_runner(self.load(EMAIL_INTAKE_DATA_DIR=tmp.name,
                                                         HERMES_WEBHOOK_SECRET=""))._dispatcher)

    def test_settings_repr_never_shows_the_signing_secret(self):
        self.assertNotIn("'s'", repr(self.load()))


if __name__ == "__main__":
    unittest.main()
