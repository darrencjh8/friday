"""Email-intake cutover switch (issue #783, cutover PR 4).

Live intake books nothing while expense-tracker's IDLE watcher still runs,
and a rollback to shadow makes the next cutover take a fresh handoff.
Synthetic mail only.
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from test_email_intake import good_answer, make_mail  # noqa: E402
from test_email_intake_dispatch import FakeTracker, Harness, StoringImap  # noqa: E402

from intake import dispatch  # noqa: E402


class WatcherOffTest(unittest.TestCase):
    def test_only_an_explicit_off_counts(self):
        self.assertTrue(dispatch.watcher_off("http://e", get=lambda url: {"status": "ok", "email_watcher": "off"}))
        self.assertFalse(dispatch.watcher_off("http://e", get=lambda url: {"status": "ok", "email_watcher": "on"}))
        self.assertFalse(dispatch.watcher_off("http://e", get=lambda url: {"status": "ok"}))  # an old tracker

        def down(url):
            raise OSError("refused")

        self.assertFalse(dispatch.watcher_off("http://e", get=down))

    def test_it_asks_the_expense_tracker_health_endpoint(self):
        asked = []
        dispatch.watcher_off("http://expense.test", get=lambda url: asked.append(url) or {})
        self.assertEqual(asked, ["http://expense.test/health"])


class CutoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.off = False
        self.imap = StoringImap({"INBOX": [(5, make_mail())]})
        self.tracker = FakeTracker()

    def harness(self, mode):
        h = Harness(self.tmp.name, self.imap, good_answer(), mode, booked=lambda validity: set(),
                    tracker=self.tracker, watcher_off=lambda: self.off)
        self.addCleanup(h.journal.close)
        h.journal.checkpoint("INBOX", 1, 0, account="acct")
        return h

    def test_live_books_nothing_until_the_old_watcher_is_off(self):
        h = self.harness("live")
        summary = h.run()
        self.assertEqual(summary["dispatch"]["blocked"], "no_handoff_boundary")
        self.assertEqual(self.tracker.calls, [])
        self.assertEqual(self.imap.seen, [])
        self.assertIsNone(h.journal.get_state("live_since"))  # no boundary fixed while both could book

        self.off = True
        h.run()
        self.assertEqual(len(self.tracker.calls), 1)
        self.assertEqual(self.imap.seen, [("INBOX", 5)])

    def test_a_watcher_that_comes_back_pauses_live_again(self):
        self.off = True
        h = self.harness("live")
        h.run()
        self.imap.folders["INBOX"].append((6, make_mail(msgid="<m2@bank.example>", body="You spent SGD 7.00.")))
        self.off = False
        h.run()
        self.assertEqual(len(self.tracker.calls), 1)

    def test_a_rollback_makes_the_next_cutover_take_a_fresh_handoff(self):
        self.off = True
        live = self.harness("live")
        live.run()
        self.assertIsNotNone(live.journal.get_state("live_inbox_handoff"))
        live.journal.close()

        rehearsal = self.harness("rehearsal")
        rehearsal.run()
        self.assertIsNone(rehearsal.journal.get_state("live_since"))
        self.assertIsNone(rehearsal.journal.get_state("live_inbox_handoff"))


if __name__ == "__main__":
    unittest.main()
