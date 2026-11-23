"""Expense-tracker learning offers reach Dots as approval cards.

A "Tap /remember_<id> or /forget_<id>" offer becomes an approval card; Approve
sends /remember_<id> and Refuse /forget_<id> as the owner, once, for the
learning-commands plugin to answer.

Run from the repo root: python -m unittest modules/tests/test_dots_learning_offer.py -v
"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from test_issue_271_quoted_reply import _load_adapter

OFFER = ('Remember "MUNCHI" as Food? Tap /remember_2ygwaxkd or /forget_2ygwaxkd. '
         "Nothing is saved until you choose.")


class LearningOfferCardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mod = _load_adapter()
        self.mod.SendResult = lambda **kw: kw
        adapter = self.mod.DotsAdapter.__new__(self.mod.DotsAdapter)
        adapter._history = self.mod._History(Path(self.tmp.name) / "history.db")
        adapter._approvals = {}
        adapter._turns = {}
        adapter._timing = {}
        adapter._activities = {}
        adapter._rooms = {}
        adapter._room_current = {}

        async def no_transcript(chat, content):
            return False

        adapter._attach_transcript = no_transcript
        adapter._log_timing = lambda *a, **k: None
        adapter._known = lambda chat: chat or "owner"
        adapter._source = lambda chat, message_id=None: {"chat_id": chat}
        self.pushed, self.notified, self.handled = [], [], []

        async def push(event):
            self.pushed.append(event)

        async def handle(event):
            self.handled.append(event)

        adapter._push = push
        adapter._notify = lambda *args: self.notified.append(args)
        adapter.handle_message = handle
        self.adapter = adapter

    def send(self, text):
        return asyncio.run(self.adapter.send("owner", text))

    def tap(self, choice, card="learn_2ygwaxkd"):
        asyncio.run(self.adapter._on_approval({"approval_id": card, "choice": choice}))

    def test_an_offer_becomes_an_approval_card_with_a_push(self):
        self.send(OFFER)
        card = self.pushed[0]
        self.assertEqual(card["type"], "approval")
        self.assertEqual(card["approval_id"], "learn_2ygwaxkd")
        self.assertEqual(card["command"], 'Remember "MUNCHI" as Food? Nothing is saved until you choose.')
        self.assertEqual(self.notified[0][:2], ("approval", "learn_2ygwaxkd"))

    def test_each_offer_line_gets_its_own_card(self):
        self.send(OFFER + "\n" + OFFER.replace("2ygwaxkd", "abc"))
        self.assertEqual([e["approval_id"] for e in self.pushed], ["learn_2ygwaxkd", "learn_abc"])

    def test_approve_sends_remember_once(self):
        self.send(OFFER)
        self.tap("once")
        self.tap("once")
        self.assertEqual([e.text for e in self.handled], ["/remember_2ygwaxkd"])
        self.assertEqual(self.handled[0].source, {"chat_id": "owner"})
        self.assertEqual(self.adapter._history.get("learn_2ygwaxkd")["resolved"], "once")

    def test_refuse_sends_forget(self):
        self.send(OFFER)
        self.tap("deny")
        self.assertEqual([e.text for e in self.handled], ["/forget_2ygwaxkd"])

    def test_a_card_that_was_never_sent_does_nothing(self):
        self.tap("once", card="learn_zzz")
        self.assertEqual(self.handled, [])

    def test_ordinary_text_stays_a_message(self):
        self.send("S$5.00 at Munchi, logged\n" + OFFER)
        self.assertEqual(self.pushed[0]["type"], "message")
        self.assertEqual(json.dumps(self.pushed[0]).count("/remember_2ygwaxkd"), 1)

    def test_a_muse_request_becomes_a_buy_card(self):
        self.send("USB-C cable (friday-persona#12). Tap /buy_12 or /skip_12.")
        card = self.pushed[0]
        self.assertEqual(card["approval_id"], "muse_12")
        self.assertEqual(card["title"], "Muse asks Friday to buy")
        self.assertEqual(card["command"], "USB-C cable (friday-persona#12).")
        self.assertEqual([a["label"] for a in card["actions"]], ["Buy", "Refuse"])

    def test_buy_tells_the_agent_once_to_buy_that_issue(self):
        self.send("cable (friday-persona#12). Tap /buy_12 or /skip_12.")
        self.tap("once", card="muse_12")
        self.tap("once", card="muse_12")
        self.assertEqual(len(self.handled), 1)
        self.assertIn("darrencjh8/friday-persona#12 is approved", self.handled[0].text)
        self.assertIn("shopping skill", self.handled[0].text)

    def test_refuse_tells_the_agent_to_close_and_buy_nothing(self):
        self.send("cable (friday-persona#12). Tap /buy_12 or /skip_12.")
        self.tap("deny", card="muse_12")
        self.assertIn("#12 is refused", self.handled[0].text)
        self.assertIn("buy nothing", self.handled[0].text)


if __name__ == "__main__":
    unittest.main()
