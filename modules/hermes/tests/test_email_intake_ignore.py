"""Ignore rules from the wiki: mail that needs nothing at all (issue #131).

A rule names subject text and, optionally, a sender domain. With a domain it
matches only that exact, DMARC-authenticated sender; with none (blank or `*`)
it matches the subject from any sender. A match skips Jev and is never
booked, replayed or reported.
"""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from test_email_intake import FakeJev, good_answer, make_mail  # noqa: E402
from test_email_intake_dispatch import FakeTracker, Harness, StoringImap  # noqa: E402

from intake import jev, notify, senders, service  # noqa: E402
from intake.scanner import Scanner  # noqa: E402
from intake.shadow import ShadowRunner  # noqa: E402

TRUST = "trustbank.sg"
SUBJECT = "You earned it! Here’s your cashback summary"
PASS = f"dmarc=pass header.from={TRUST}"

PAGE = """# Email senders

## Notify rules

| Sender domain | Subject contains | Message | Status |
|---|---|---|---|
| `broker.example` | Contract note is ready | Download it | confirmed |

## Ignore rules

| Sender domain | Subject contains | Status |
|---|---|---|
| `trustbank.sg` | Here's your cashback summary | confirmed |
| `*` | Your weekly digest | confirmed |
|  | Monthly newsletter | confirmed |
| `bank.example` | Card alert | proposed |
| `bank.example` |  | confirmed |
"""


class LoadIgnoreRulesTest(unittest.TestCase):
    def test_reads_confirmed_rows_and_treats_blank_or_star_as_any_sender(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "email-senders.md"
            page.write_text(PAGE, encoding="utf-8")
            self.assertEqual(senders.load_ignore_rules(page), [
                senders.IgnoreRule(TRUST, "here's your cashback summary"),
                senders.IgnoreRule("", "your weekly digest"),
                senders.IgnoreRule("", "monthly newsletter"),
            ])
            # The Notify rules table is unchanged.
            self.assertEqual(senders.load_rules(page), [senders.NotifyRule("broker.example", "contract note is ready",
                                                                           "Download it")])
            self.assertEqual(senders.load_ignore_rules(Path(tmp) / "absent.md"), [])


class MatchIgnoreTest(unittest.TestCase):
    RULES = [senders.IgnoreRule(TRUST, "here's your cashback summary"), senders.IgnoreRule("", "your weekly digest")]

    def match(self, domain, dmarc, subject):
        return senders.match_ignore(self.RULES, domain, {"dmarc": dmarc}, subject)

    def test_a_sender_rule_needs_the_exact_authenticated_domain_and_the_subject(self):
        self.assertIsNotNone(self.match(TRUST, "pass", SUBJECT))  # curly apostrophe, any case
        self.assertIsNone(self.match(TRUST, "fail", SUBJECT))
        self.assertIsNone(self.match("other.example", "pass", SUBJECT))
        self.assertIsNone(self.match("mail.trustbank.sg", "pass", SUBJECT))
        self.assertIsNone(self.match(TRUST, "pass", "Your card transaction alert"))
        self.assertIsNone(self.match(TRUST, "pass", "Cashback credited to your account"))

    def test_an_any_sender_rule_matches_the_subject_alone(self):
        self.assertIsNotNone(self.match("news.example", "fail", "Re: YOUR WEEKLY   digest"))
        self.assertIsNone(self.match("news.example", "pass", "Your weekly statement"))


class IgnoreRuleRunTest(unittest.TestCase):
    """A match is recorded as ignored by rule, never reaches Jev, and sends nothing in live mode."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def harness(self, mails, answer, notify_rules=()):
        h = Harness(self.tmp.name, StoringImap({"INBOX": mails}), answer, "live", booked=lambda validity: set(),
                    tracker=FakeTracker())
        self.addCleanup(h.journal.close)
        h.journal.checkpoint("INBOX", 1, 0, account="acct")
        self.jev = FakeJev(answer)
        h.classifier = ShadowRunner(
            scanner=Scanner(lambda: h.imap, h.journal, account="acct"),
            journal=h.journal,
            classify=lambda text, context="": jev.classify(state_text=text, post=self.jev, context=context),
            notify_rules=lambda: list(notify_rules),
            ignore_rules=lambda: [senders.IgnoreRule(TRUST, "here's your cashback summary")],
        )
        h.runner = service.Runner(h.classifier, h.dispatcher)
        self.sent = []
        h.outbox = notify.Outbox(h.journal, lambda text: self.sent.append(text) or notify.SENT)
        return h

    def statuses(self, h):
        con = sqlite3.connect(h.journal.path)
        try:
            return [(uid, status, json.loads(decision)) for uid, status, decision in
                    con.execute("SELECT uid, status, decision FROM messages ORDER BY uid")]
        finally:
            con.close()

    def test_authenticated_cashback_summary_is_ignored_with_no_side_effects(self):
        h = self.harness([(5, make_mail(sender=f"from_us@{TRUST}", subject=SUBJECT, auth=PASS))],
                         good_answer("uncertain"))
        summary = h.run()
        h.outbox.flush()
        [(uid, status, decision)] = self.statuses(h)
        self.assertEqual((status, decision["destination"], decision["reason"]), ("ignored_rule", "neither", "ignore_rule"))
        self.assertEqual(summary["ignored"], 1)
        self.assertEqual(self.jev.calls, [])
        self.assertEqual(h.tracker.calls, [])
        self.assertEqual(self.sent, [])

    def test_unmatched_mail_still_goes_to_jev_and_review(self):
        mails = [
            (5, make_mail(sender=f"from_us@{TRUST}", subject=SUBJECT, auth="dmarc=fail", body="spoof")),
            (6, make_mail(sender="promo@other.example", subject=SUBJECT, msgid="<6@x>", body="other",
                          auth="dmarc=pass header.from=other.example")),
            (7, make_mail(sender=f"alerts@{TRUST}", subject="Card transaction alert", msgid="<7@x>",
                          body="You spent SGD 5", auth=PASS)),
            (8, make_mail(sender=f"from_us@{TRUST}", subject="Your monthly statement", msgid="<8@x>",
                          body="statement", auth=PASS)),
        ]
        h = self.harness(mails, good_answer("uncertain"))
        h.run()
        h.outbox.flush()
        self.assertEqual([s for _, s, _ in self.statuses(h)], ["shadow_uncertain"] * 4)
        self.assertEqual(len(self.jev.calls), 4)
        self.assertEqual(len(self.sent), 4)
        self.assertTrue(all(t.startswith("Needs review") for t in self.sent))

    def test_a_notify_rule_still_wins_over_an_ignore_rule(self):
        rule = senders.NotifyRule(TRUST, "cashback summary", "Check your cashback")
        h = self.harness([(5, make_mail(sender=f"from_us@{TRUST}", subject=SUBJECT, auth=PASS))],
                         good_answer("uncertain"), notify_rules=[rule])
        h.run()
        h.outbox.flush()
        self.assertEqual(self.statuses(h)[0][1], "shadow_notify")
        self.assertEqual(self.sent, ["Check your cashback"])


if __name__ == "__main__":
    unittest.main()
