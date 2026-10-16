"""Parity replay for the #796 cutover gate.

Synthetic data only: no real sender, merchant, account or amount.
"""

import hashlib
import hmac
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "email-intake"))

from intake import parity  # noqa: E402

PLAN = {
    "account_id": "acc-a",
    "date": "2026-10-02",
    "amount_cents": -500,
    "imported_description": "Alpha Cafe",
    "category_id": "cat-food",
    "budget_id": "budget-1",
}
ROW = {"id": "t1", "account": "acc-a", "date": "2026-10-02", "amount": -500, "payee": "p-alpha", "category": "cat-food"}
PAYEES = {"p-alpha": "Alpha Cafe", "p-beta": "Beta Store"}


def writes(plan=PLAN, duplicate=True):
    calls = [{"tool": "check_duplicate", "args": {}, "would_be_duplicate": duplicate}]
    if plan is not None:
        calls.append({"tool": "insert_transaction", "args": plan})
    return calls


class CompareTest(unittest.TestCase):
    def test_all_fields_match(self):
        r = parity.compare(writes(), [ROW], PAYEES)
        self.assertEqual(r["status"], "matched")
        self.assertEqual(r["fields"], {f: True for f in parity.FIELDS})
        self.assertTrue(r["would_be_duplicate"])

    def test_payee_matches_by_id_too(self):
        plan = {**PLAN, "imported_description": "something else", "payee_id": "p-alpha"}
        self.assertTrue(parity.compare(writes(plan), [ROW], PAYEES)["fields"]["payee"])

    def test_payee_name_is_case_insensitive(self):
        plan = {**PLAN, "imported_description": "ALPHA CAFE"}
        self.assertTrue(parity.compare(writes(plan), [ROW], PAYEES)["fields"]["payee"])

    def test_payee_and_category_mismatch_are_reported(self):
        row = {**ROW, "payee": "p-beta", "category": "cat-other"}
        r = parity.compare(writes(), [row], PAYEES)
        self.assertEqual(r["status"], "mismatch")
        self.assertFalse(r["fields"]["payee"])
        self.assertFalse(r["fields"]["category"])
        self.assertTrue(r["fields"]["amount"])

    def test_date_within_one_day_matches_the_row_but_flags_the_date(self):
        row = {**ROW, "date": "2026-10-03"}
        r = parity.compare(writes(), [row], PAYEES)
        self.assertEqual(r["status"], "mismatch")
        self.assertFalse(r["fields"]["date"])
        self.assertTrue(r["fields"]["account"])

    def test_wrong_account_same_amount_is_an_account_mismatch(self):
        row = {**ROW, "account": "acc-b"}
        r = parity.compare(writes(), [row], PAYEES)
        self.assertEqual(r["status"], "mismatch")
        self.assertFalse(r["fields"]["account"])

    def test_no_row_found(self):
        row = {**ROW, "amount": -999}
        self.assertEqual(parity.compare(writes(), [row], PAYEES)["status"], "no_actual_row")

    def test_two_days_off_is_not_a_match(self):
        row = {**ROW, "date": "2026-10-05"}
        self.assertEqual(parity.compare(writes(), [row], PAYEES)["status"], "no_actual_row")

    def test_several_candidates_is_ambiguous(self):
        r = parity.compare(writes(), [ROW, {**ROW, "id": "t2"}], PAYEES)
        self.assertEqual(r["status"], "ambiguous")

    def test_exact_date_preferred_over_neighbour(self):
        r = parity.compare(writes(), [{**ROW, "id": "t0", "date": "2026-10-01"}, ROW], PAYEES)
        self.assertEqual(r["status"], "matched")

    def test_payee_edited_after_booking_is_told_apart(self):
        plan = {**PLAN, "imported_description": "Misc"}
        row = {**ROW, "imported_payee": "misc"}
        r = parity.compare(writes(plan), [row], PAYEES)
        self.assertFalse(r["fields"]["payee"])
        self.assertTrue(r["payee_original_match"])

    def test_payee_original_mismatch_is_reported(self):
        plan = {**PLAN, "imported_description": "Misc"}
        r = parity.compare(writes(plan), [{**ROW, "imported_payee": "Alpha Cafe"}], PAYEES)
        self.assertFalse(r["payee_original_match"])

    def test_no_booking_planned(self):
        self.assertEqual(parity.compare(writes(plan=None), [ROW], PAYEES)["status"], "no_booking_planned")


class SignTest(unittest.TestCase):
    def test_matches_the_expense_tracker_dry_run_signature(self):
        body = {"request_id": "parity:1:10", "evidence": {"raw_email_b64": "QUJD"}, "dry_run": True}
        digest = hashlib.sha256(b"QUJD").hexdigest()
        want = hmac.new(b"s3", f"transaction:dry_run:parity:1:10:{digest}".encode(), hashlib.sha256).hexdigest()
        self.assertEqual(parity.sign(body, "s3"), want)


class BookedTest(unittest.TestCase):
    def test_reads_booked_uids_in_window_and_uidvalidity(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dedup.db"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE booked_messages (uid INTEGER PRIMARY KEY, booked_at TEXT)")
            db.execute("CREATE TABLE mailbox_state (key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO mailbox_state VALUES ('uidvalidity', '77')")
            db.executemany(
                "INSERT INTO booked_messages VALUES (?, ?)",
                [(10, "2026-10-01T00:00:00Z"), (11, "2026-08-01T00:00:00Z"), (12, "2026-10-05T00:00:00Z")],
            )
            db.commit()
            db.close()
            uidvalidity, uids = parity.booked(str(path), since="2026-09-12")
        self.assertEqual(uidvalidity, "77")
        self.assertEqual(uids, [10, 12])


class RunTest(unittest.TestCase):
    def make(self, uidvalidity="77", rows=None):
        posted = []

        def post(body):
            posted.append(body)
            return {"status": "dry_run", "action": "insert", "writes": writes()}

        return dict(
            uidvalidity=uidvalidity,
            fetch_raw=lambda uid: (b"From: alerts@bank.example\r\n\r\nbody", "bank.example"),
            post=post,
            fetch_rows=lambda budget_id: rows if rows is not None else [ROW],
            fetch_payees=lambda budget_id: PAYEES,
        ), posted

    def test_replays_each_uid_as_a_dry_run(self):
        deps, posted = self.make()
        results = parity.run([10, 12], **deps)
        self.assertEqual([r["uid"] for r in results], [10, 12])
        self.assertTrue(all(b["dry_run"] is True for b in posted))
        self.assertEqual(posted[0]["request_id"], "parity:77:10")
        self.assertEqual(results[0]["sender_domain"], "bank.example")

    def test_rows_come_from_every_account_so_a_wrong_account_shows(self):
        deps, _ = self.make(rows=[{**ROW, "account": "acc-other"}])
        r = parity.run([10], **deps)[0]
        self.assertEqual(r["status"], "mismatch")
        self.assertFalse(r["fields"]["account"])

    def test_an_email_jev_routes_elsewhere_is_not_replayed(self):
        deps, posted = self.make()
        deps["route"] = lambda uid: {"destination": "neither", "kind": "not_completed"}
        r = parity.run([10], **deps)[0]
        self.assertEqual(r["status"], "jev_routes_elsewhere")
        self.assertEqual(r["jev"], {"destination": "neither", "kind": "not_completed"})
        self.assertEqual(posted, [])

    def test_an_uncertain_jev_decision_goes_to_review_not_replay(self):
        deps, posted = self.make()
        deps["route"] = lambda uid: {"destination": "uncertain", "kind": "unclear"}
        self.assertEqual(parity.run([10], **deps)[0]["status"], "jev_routes_elsewhere")
        self.assertEqual(posted, [])

    def test_an_email_jev_routes_to_the_expense_tracker_is_replayed(self):
        for destination in ("actual_budget", "both"):
            deps, posted = self.make()
            deps["route"] = lambda uid, d=destination: {"destination": d, "kind": "bank_transaction"}
            r = parity.run([10], **deps)[0]
            self.assertEqual(r["status"], "matched")
            self.assertEqual(r["jev"]["destination"], destination)
            self.assertEqual(len(posted), 1)

    def test_an_email_without_a_jev_decision_is_replayed_and_flagged(self):
        deps, posted = self.make()
        deps["route"] = lambda uid: None
        r = parity.run([10], **deps)[0]
        self.assertEqual(r["status"], "matched")
        self.assertEqual(r["jev"], None)
        self.assertEqual(len(posted), 1)

    def test_a_failed_dry_run_is_recorded_not_raised(self):
        deps, _ = self.make()
        deps["post"] = lambda body: {"status": "failed", "reason": "error"}
        self.assertEqual(parity.run([10], **deps)[0]["status"], "dry_run_failed")

    def test_a_missing_email_is_recorded(self):
        deps, _ = self.make()
        deps["fetch_raw"] = lambda uid: (None, "")
        self.assertEqual(parity.run([10], **deps)[0]["status"], "email_missing")


class RouteTest(unittest.TestCase):
    def test_reads_the_latest_journal_decision_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "journal.db"
            db = sqlite3.connect(path)
            db.execute("CREATE TABLE messages (account TEXT, folder TEXT, uidvalidity INTEGER, uid INTEGER, "
                       "evidence_hash TEXT, message_id_hash TEXT, status TEXT, decision TEXT, updated_at REAL)")
            db.execute("INSERT INTO messages VALUES ('a','INBOX',77,10,'h','m','ignored',?,1)",
                       (json.dumps({"destination": "neither", "kind": "not_completed", "confidence": 1.0}),))
            db.execute("INSERT INTO messages VALUES ('a','Spam',77,10,'h2','m2','shadow_actual_budget',?,2)",
                       (json.dumps({"destination": "actual_budget", "kind": "bank_transaction"}),))
            db.commit()
            db.close()
            route = parity.journal_router(str(path), "77")
            self.assertEqual(route(10), {"destination": "neither", "kind": "not_completed"})
            self.assertIsNone(route(11))
            self.assertIsNone(parity.journal_router(str(path), "78")(10))

    def test_summary_counts_jev_routing(self):
        results = [
            {"uid": 1, "status": "jev_routes_elsewhere", "jev": {"destination": "neither", "kind": "not_completed"}},
            {"uid": 2, "status": "matched", "jev": None, "fields": {f: True for f in parity.FIELDS}},
        ]
        s = parity.summarize(results)
        self.assertEqual(s["jev"], {"routes_elsewhere": 1, "no_decision": 1, "to_expense_tracker": 0})
        self.assertEqual(s["problems"], [])


class SummaryTest(unittest.TestCase):
    def test_counts_and_mismatches_carry_no_values(self):
        results = [
            {"uid": 1, "sender_domain": "a.example", "status": "matched", "fields": {f: True for f in parity.FIELDS}},
            {"uid": 2, "sender_domain": "b.example", "status": "mismatch",
             "fields": {**{f: True for f in parity.FIELDS}, "category": False}},
            {"uid": 3, "sender_domain": "b.example", "status": "no_actual_row"},
        ]
        s = parity.summarize(results)
        self.assertEqual(s["total"], 3)
        self.assertEqual(s["status"], {"matched": 1, "mismatch": 1, "no_actual_row": 1})
        self.assertEqual(s["field_match"]["category"], "1/2")
        self.assertEqual(s["field_match"]["amount"], "2/2")
        self.assertEqual(s["problems"], [
            {"uid": 2, "sender_domain": "b.example", "status": "mismatch", "fields": ["category"]},
            {"uid": 3, "sender_domain": "b.example", "status": "no_actual_row", "fields": []},
        ])
        self.assertNotIn("-500", json.dumps(s))

    def test_a_payee_edited_after_booking_is_flagged(self):
        results = [{"uid": 4, "sender_domain": "a.example", "status": "mismatch", "payee_original_match": True,
                    "fields": {**{f: True for f in parity.FIELDS}, "payee": False}}]
        self.assertEqual(parity.summarize(results)["problems"][0]["notes"], ["payee_original_matches"])


if __name__ == "__main__":
    unittest.main()
