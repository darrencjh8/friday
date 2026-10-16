"""Email-intake Telegram messages and /replay (issue #783, cutover PR 2).

Synthetic mail only: no real sender, merchant, person or account data.
"""

import asyncio
import importlib.util
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from test_email_intake import good_answer, make_mail  # noqa: E402
from test_email_intake_dispatch import FakeTracker, Harness, StoringImap  # noqa: E402

from intake import notify  # noqa: E402

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/intake-commands/__init__.py"
spec = importlib.util.spec_from_file_location("intake_commands_plugin", PLUGIN_PATH)
commands = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commands)

CHAT = "4242"


class FakeTelegram:
    def __init__(self, fail=0, reject=()):
        self.sent = []
        self.fail = fail
        self.reject = set(reject)

    def __call__(self, text):
        if text in self.reject:
            return notify.REJECTED
        if self.fail:
            self.fail -= 1
            return notify.RETRY
        self.sent.append(text)
        return notify.SENT


class ComposeTest(unittest.TestCase):
    def test_offer_uses_the_tracker_wording_and_lowercase_commands(self):
        text = notify.offer_text({"id": "ABCD1234", "descriptor": "ALPHA CAFE", "payee": "Alpha Cafe"})
        self.assertEqual(text, 'Remember "ALPHA CAFE" as Alpha Cafe? Tap /remember_abcd1234 or /forget_abcd1234. '
                               "Nothing is saved until you choose.")

    def test_review_notice_offers_the_three_replays_and_masks_long_numbers(self):
        text = notify.review_text("bank.example", "Alert for card 4111111111111111", "0123456789abcdef")
        self.assertIn("bank.example", text)
        self.assertNotIn("4111111111111111", text)
        for suffix in ("tx", "stmt", "pf"):
            self.assertIn(f"/replay_0123456789_{suffix}", text)


class LiveMessagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def harness(self, imap, answer, tracker=None):
        h = Harness(self.tmp.name, imap, answer, "live", booked=lambda validity: set(), tracker=tracker)
        self.addCleanup(h.journal.close)
        h.journal.checkpoint("INBOX", 1, 0, account="acct")
        self.telegram = FakeTelegram()
        h.outbox = notify.Outbox(h.journal, self.telegram)
        return h

    def run_all(self, h):
        h.run()
        h.outbox.flush()

    def test_a_booking_sends_the_tracker_message_and_offer_once(self):
        tracker = FakeTracker({"http://expense.test/process/transaction": {
            "status": "processed", "action": "insert", "messages": ["S$5.00 at Alpha Cafe, logged"],
            "mapping_candidate": {"id": "ABCD1234", "descriptor": "ALPHA CAFE", "payee": "Alpha Cafe"}}})
        h = self.harness(StoringImap({"INBOX": [(5, make_mail())]}), good_answer(), tracker)
        self.run_all(h)
        self.run_all(h)
        self.assertEqual(len(self.telegram.sent), 1)
        self.assertIn("S$5.00 at Alpha Cafe, logged", self.telegram.sent[0])
        self.assertIn("/remember_abcd1234", self.telegram.sent[0])

    def test_a_silent_duplicate_sends_nothing(self):
        tracker = FakeTracker({"http://expense.test/process/transaction": {"status": "duplicate", "messages": []}})
        h = self.harness(StoringImap({"INBOX": [(5, make_mail())]}), good_answer(), tracker)
        self.run_all(h)
        self.assertEqual(self.telegram.sent, [])

    def test_a_final_failure_is_reported_and_retries_are_not(self):
        tracker = FakeTracker({"http://expense.test/process/transaction": {
            "status": "failed", "reason": "error", "messages": ["LLM unavailable; it will be retried."]}})
        h = self.harness(StoringImap({"INBOX": [(5, make_mail())]}), good_answer(), tracker)
        self.run_all(h)
        self.assertEqual(self.telegram.sent, [])  # first attempt failed: retried, not reported
        self.run_all(h)
        self.run_all(h)
        self.assertEqual(len(self.telegram.sent), 1)
        self.assertIn("unread", self.telegram.sent[0])

    def test_uncertain_mail_asks_for_review_with_replay_commands(self):
        h = self.harness(StoringImap({"INBOX": [(5, make_mail())]}), good_answer("uncertain"))
        self.run_all(h)
        self.assertEqual(h.tracker.calls, [])
        self.assertEqual(len(self.telegram.sent), 1)
        self.assertIn("/replay_", self.telegram.sent[0])

    def test_an_encrypted_statement_is_reported_as_blocked(self):
        from test_email_intake import ENCRYPTED_PDF
        h = self.harness(StoringImap({"INBOX": [(5, make_mail(pdf=ENCRYPTED_PDF))]}), good_answer())
        self.run_all(h)
        self.assertEqual(len(self.telegram.sent), 1)
        self.assertIn("password-protected", self.telegram.sent[0])

    def test_a_telegram_failure_is_retried_until_delivered_once(self):
        h = self.harness(StoringImap({"INBOX": [(5, make_mail())]}), good_answer("uncertain"))
        self.telegram.fail = 1
        self.run_all(h)
        self.assertEqual(self.telegram.sent, [])
        h.outbox.flush()
        h.outbox.flush()
        self.assertEqual(len(self.telegram.sent), 1)

    def test_a_crash_after_booking_still_marks_read_and_reports_next_run(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer())
        real = h.journal.queue_notification
        calls = []

        def crash_once(key, text):
            calls.append(key)
            if len(calls) == 1:
                raise sqlite3.OperationalError("database is locked")
            return real(key, text)

        h.journal.queue_notification = crash_once
        self.run_all(h)
        self.assertEqual(imap.seen, [("INBOX", 5)])
        self.run_all(h)
        self.assertEqual(len(h.tracker.calls), 1)
        self.assertEqual(len(self.telegram.sent), 1)

    def test_a_silent_result_is_not_looked_up_again(self):
        tracker = FakeTracker({"http://expense.test/process/transaction": {"status": "duplicate", "messages": []}})
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer(), tracker)
        self.run_all(h)
        fetches = sum(1 for c in imap.commands if c[:2] == ("UID", "FETCH"))
        self.run_all(h)
        self.assertEqual(sum(1 for c in imap.commands if c[:2] == ("UID", "FETCH")), fetches)

    def test_replay_books_an_uncertain_email_as_the_owner_chose(self):
        imap = StoringImap({"INBOX": [(5, make_mail())]})
        h = self.harness(imap, good_answer("uncertain"))
        self.run_all(h)
        evidence = h.journal._db.execute("SELECT evidence_hash FROM messages").fetchone()[0]
        h.journal.request_replay(evidence, "portfolio", "transaction")
        self.run_all(h)
        self.assertEqual([c[0] for c in h.tracker.calls], ["http://portfolio.test/process/portfolio"])
        self.assertEqual(imap.seen, [("INBOX", 5)])
        self.run_all(h)
        self.assertEqual(len(h.tracker.calls), 1)


class OutboxWiringTest(unittest.TestCase):
    def test_shadow_never_builds_an_outbox(self):
        from intake import service
        env = {"EMAIL_INTAKE_MODE": "shadow", "IMAP_HOST": "h", "IMAP_USERNAME": "u", "IMAP_PASSWORD": "p",
               "JEV_API_KEY": "k", "HERMES_WEBHOOK_SECRET": "s", "TELEGRAM_BOT_TOKEN": "t",
               "TELEGRAM_HOME_CHANNEL": CHAT}
        with tempfile.TemporaryDirectory() as d:
            env["EMAIL_INTAKE_DATA_DIR"] = d
            runner = service.build_runner(service.load_settings(lambda k, default="": env.get(k, default)))
            self.assertIsNone(runner._outbox)


class OutboxTest(unittest.TestCase):
    def setUp(self):
        from intake.journal import Journal
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = Journal(Path(self.tmp.name) / "j.db")
        self.addCleanup(self.journal.close)

    def test_a_key_is_delivered_once_even_if_queued_again(self):
        telegram = FakeTelegram()
        outbox = notify.Outbox(self.journal, telegram)
        self.journal.queue_notification("k", "one")
        outbox.flush()
        self.journal.queue_notification("k", "one again")
        outbox.flush()
        self.assertEqual(telegram.sent, ["one"])

    def test_messages_keep_their_order_when_telegram_fails(self):
        telegram = FakeTelegram(fail=1)
        outbox = notify.Outbox(self.journal, telegram)
        self.journal.queue_notification("a", "first")
        self.journal.queue_notification("b", "second")
        outbox.flush()
        self.assertEqual(telegram.sent, [])
        outbox.flush()
        self.assertEqual(telegram.sent, ["first", "second"])


class OutboxFailureTest(OutboxTest):
    def test_a_message_telegram_rejects_is_dropped_and_the_rest_still_go(self):
        telegram = FakeTelegram(reject={"bad"})
        outbox = notify.Outbox(self.journal, telegram)
        self.journal.queue_notification("a", "bad")
        self.journal.queue_notification("b", "good")
        outbox.flush()
        outbox.flush()
        self.assertEqual(telegram.sent, ["good"])

    def test_a_long_outage_never_throws_a_message_away(self):
        telegram = FakeTelegram(fail=50)
        outbox = notify.Outbox(self.journal, telegram)
        self.journal.queue_notification("a", "first")
        for _ in range(51):
            outbox.flush()
        self.assertEqual(telegram.sent, ["first"])


class TelegramSenderTest(unittest.TestCase):
    def test_posts_plain_text_to_the_home_chat(self):
        calls = []

        def post(url, body, headers):
            calls.append((url, body))
            return {"ok": True}

        sender = notify.TelegramSender("123:tok", CHAT, post=post)
        self.assertEqual(sender("hello"), notify.SENT)
        self.assertEqual(calls, [("https://api.telegram.org/bot123:tok/sendMessage", {"chat_id": CHAT, "text": "hello"})])

    def test_an_error_is_a_false_return_not_an_exception(self):
        def post(url, body, headers):
            raise OSError("down")

        self.assertEqual(notify.TelegramSender("t", CHAT, post=post)("x"), notify.RETRY)

    def test_a_bad_request_is_a_rejection_not_a_retry(self):
        import urllib.error

        def post(url, body, headers):
            raise urllib.error.HTTPError(url, 400, "Bad Request", {}, None)

        self.assertEqual(notify.TelegramSender("t", CHAT, post=post)("x"), notify.REJECTED)


def make_event(text, chat_id=CHAT, user_id="4242", platform="telegram"):
    source = SimpleNamespace(platform=SimpleNamespace(value=platform), chat_id=chat_id, user_id=user_id)
    return SimpleNamespace(text=text, source=source)


class ReplayCommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        from intake.journal import Journal
        self.journal = Journal(Path(self.tmp.name) / "journal.db")
        self.addCleanup(self.journal.close)
        self.evidence = "0123456789" + "a" * 54
        self.journal.record("acct", "INBOX", 1, 5, self.evidence, "", "shadow_uncertain", {"destination": "uncertain"})
        self.env = {"TELEGRAM_HOME_CHANNEL": CHAT, "TELEGRAM_ALLOWED_USERS": "4242",
                    "EMAIL_INTAKE_MODE": "live", "EMAIL_INTAKE_DATA_DIR": self.tmp.name}

    def dispatch(self, text, **event):
        adapter = MagicMock()
        adapter.send = AsyncMock()
        gateway = MagicMock()
        gateway._delivery_adapter_for.return_value = adapter
        with patch.dict(os.environ, self.env, clear=False):
            result = asyncio.run(commands._on_pre_gateway_dispatch(event=make_event(text, **event), gateway=gateway))
        reply = adapter.send.call_args[0][1] if adapter.send.call_args else None
        return result, reply

    def replays(self):
        con = sqlite3.connect(self.journal.path)
        try:
            return con.execute("SELECT evidence_hash, destination, subtype FROM replays").fetchall()
        finally:
            con.close()

    def test_queues_the_chosen_destination_and_skips_the_model(self):
        result, reply = self.dispatch("/replay_0123456789_stmt")
        self.assertEqual(result["action"], "skip")
        self.assertEqual(self.replays(), [(self.evidence, "actual_budget", "statement")])
        self.assertIn("statement", reply)

    def test_other_chats_users_and_text_pass_through(self):
        self.assertIsNone(self.dispatch("/replay_0123456789_tx", chat_id="999")[0])
        self.assertIsNone(self.dispatch("/replay_0123456789_tx", user_id="999")[0])
        self.assertIsNone(self.dispatch("hello")[0])
        self.assertEqual(self.replays(), [])

    def test_unknown_or_already_handled_mail_is_refused(self):
        _, reply = self.dispatch("/replay_ffffffffff_tx")
        self.assertIn("not waiting for review", reply)
        self.assertEqual(self.replays(), [])

    def test_mail_that_was_not_uncertain_cannot_be_replayed(self):
        self.journal.record("acct", "INBOX", 1, 6, "abcdef0123" + "b" * 54, "", "shadow_actual_budget",
                            {"destination": "actual_budget"})
        _, reply = self.dispatch("/replay_abcdef0123_tx")
        self.assertIn("not waiting for review", reply)
        self.assertEqual(self.replays(), [])

    def test_shadow_mode_books_nothing(self):
        self.env["EMAIL_INTAKE_MODE"] = "shadow"
        _, reply = self.dispatch("/replay_0123456789_tx")
        self.assertIn("shadow", reply)
        self.assertEqual(self.replays(), [])


if __name__ == "__main__":
    unittest.main()
