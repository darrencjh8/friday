"""Unit tests for wiki-reminder-tasks.py (no gtasks calls)."""

import datetime
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HELPER = Path(__file__).parents[1] / "hermes" / "scripts" / "wiki-reminder-tasks.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("wiki_reminder_tasks", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HelperTests(unittest.TestCase):
    def run_helper(self, module, candidates, existing):
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if "view" in cmd:
                out = [
                    {"id": "t%d" % n, "title": "t", "description": m,
                     "due": d, "status": "needsAction"}
                    for n, (m, d) in enumerate(existing.items())
                ]
                return mock.Mock(returncode=0, stdout=json.dumps(out), stderr="")
            return mock.Mock(returncode=0, stdout="", stderr="")

        fake_stdin = mock.Mock()
        fake_stdin.read.return_value = json.dumps(candidates)
        with mock.patch.object(module.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(module.sys, "stdin", fake_stdin), \
                mock.patch.object(sys, "stdout"):
            code = module.main(today_override=datetime.date(2026, 10, 15))
        return code, calls

    def test_window_boundaries_and_types(self):
        module = load_helper()
        candidates = [
            {"key": "monthly-due", "type": "monthly", "title": "m",
             "action_date": "2026-10-18"},
            {"key": "monthly-early", "type": "monthly", "title": "m",
             "action_date": "2026-10-19"},
            {"key": "annual-ok", "type": "annual_oneoff", "title": "a",
             "action_date": "2026-10-22"},
            {"key": "claim-ok", "type": "claim_collect", "title": "c",
             "action_date": "2026-12-10"},
            {"key": "waiver-today", "type": "waiver_check", "title": "w",
             "action_date": "2026-10-15"},
            {"key": "waiver-tomorrow", "type": "waiver_check", "title": "w",
             "action_date": "2026-10-16"},
            {"key": "overdue", "type": "monthly", "title": "m",
             "action_date": "2026-10-14"},
        ]
        code, calls = self.run_helper(module, candidates, {})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(code, 1)  # overdue reported manually
        self.assertEqual(len(adds), 4)
        for cmd in adds:
            self.assertEqual(cmd[4], "Planned")
            self.assertNotIn("bash", cmd)

    def test_daily_habits_create_only_when_due_today(self):
        module = load_helper()
        self.assertEqual(module.LEAD_DAYS["daily"], 0)
        candidates = [
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-15"},
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-16"},
        ]
        code, calls = self.run_helper(module, candidates, {})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)
        self.assertIn("2026-10-15", " ".join(adds[0]))

    def test_mixed_batch_isolation_and_duplicates(self):
        module = load_helper()
        marker = "wiki-reminder-marker:done-task:2026-10-17"
        candidates = [
            {"key": "good", "type": "monthly", "title": "g",
             "action_date": "2026-10-17"},
            {"key": "good", "type": "monthly", "title": "g",
             "action_date": "2026-10-17"},
            {"key": "done-task", "type": "monthly", "title": "d",
             "action_date": "2026-10-17"},
            {"key": "mystery", "type": "nope", "title": "x",
             "action_date": "2026-10-17"},
        ]
        code, calls = self.run_helper(module, candidates, {marker: "2026-10-17"})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)
        self.assertEqual(code, 1)

    def test_rfc3339_due_matches_action_date(self):
        # Google returns due as RFC3339; a same-day re-run must skip,
        # not report a bogus conflict (daily Telegram noise).
        module = load_helper()
        marker = "wiki-reminder-marker:habit-water:2026-10-15"
        candidates = [
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-15"},
        ]
        code, calls = self.run_helper(
            module, candidates, {marker: "2026-10-15T00:00:00.000Z"})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(adds, [])
        self.assertEqual(code, 0)

    def test_weekly_type_accepted(self):
        module = load_helper()
        candidates = [
            {"key": "weekly-laundry", "type": "weekly", "title": "w",
             "action_date": "2026-10-15"},
        ]
        code, calls = self.run_helper(module, candidates, {})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)
        self.assertEqual(code, 0)

    def test_malformed_types_are_isolated(self):
        module = load_helper()
        candidates = [
            {"key": "int-date", "type": "monthly", "title": "b",
             "action_date": 20261017},
            {"key": "int-note", "type": "monthly", "title": "b",
             "action_date": "2026-10-17", "note": 123},
            {"key": "list-type", "type": ["monthly"], "title": "b",
             "action_date": "2026-10-17"},
            {"key": "new\nline", "type": "monthly", "title": "b",
             "action_date": "2026-10-17"},
            {"key": "good", "type": "monthly", "title": "g",
             "action_date": "2026-10-17"},
        ]
        code, calls = self.run_helper(module, candidates, {})
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)
        self.assertEqual(code, 1)

    def test_close_stale_daily_tasks(self):
        # Unfinished daily habit tasks from earlier days are closed (marked
        # completed, never deleted); weekly/monthly/unknown keys are not.
        module = load_helper()
        candidates = [
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-15"},
        ]
        stale = "wiki-reminder-marker:habit-water:2026-10-10"
        done = "wiki-reminder-marker:habit-water:2026-10-12"
        nontask = "wiki-reminder-marker:claim-big:2026-10-10"
        fake_view = [
            {"id": "t1", "title": "x", "description": stale,
             "due": "2026-10-10T00:00:00.000Z", "status": "needsAction"},
            {"id": "t2", "title": "x", "description": done,
             "due": "2026-10-12T00:00:00.000Z", "status": "completed"},
            {"id": "t3", "title": "x", "description": nontask,
             "due": "2026-10-10T00:00:00.000Z", "status": "needsAction"},
            # Missing status: unknown state is never closed.
            {"id": "t4", "title": "x", "description": stale,
             "due": "2026-10-09T00:00:00.000Z"},
        ]

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if "view" in cmd:
                return mock.Mock(returncode=0, stdout=json.dumps(fake_view),
                                 stderr="")
            return mock.Mock(returncode=0, stdout="", stderr="")

        fake_stdin = mock.Mock()
        fake_stdin.read.return_value = json.dumps(candidates)
        calls = []
        with mock.patch.object(module.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(module.sys, "stdin", fake_stdin), \
                mock.patch.object(sys, "stdout"):
            code = module.main(today_override=datetime.date(2026, 10, 15))
        dones = [c for c in calls if "done" in c]
        self.assertEqual(dones, [["gtasks", "tasks", "done", "-l", "Planned",
                                  "--id", "t1"]])
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)  # today's task is still created
        self.assertEqual(code, 0)

    def test_close_failure_is_a_problem(self):
        module = load_helper()
        candidates = [
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-15", "note": "2L"},
        ]
        stale = "wiki-reminder-marker:habit-water:2026-10-10"
        fake_view = [
            {"id": "t9", "title": "x", "description": stale,
             "due": "2026-10-10T00:00:00.000Z", "status": "needsAction"},
        ]

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if "view" in cmd:
                return mock.Mock(returncode=0, stdout=json.dumps(fake_view),
                                 stderr="")
            if "done" in cmd:
                return mock.Mock(returncode=1, stdout="", stderr="quota")
            return mock.Mock(returncode=0, stdout="", stderr="")

        fake_stdin = mock.Mock()
        fake_stdin.read.return_value = json.dumps(candidates)
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            snap_path = tmp + "/reminders.json"
            with mock.patch.object(module.subprocess, "run",
                                   side_effect=fake_run), \
                    mock.patch.object(module.sys, "stdin", fake_stdin), \
                    mock.patch.object(sys, "stdout"):
                code = module.main(today_override=datetime.date(2026, 10, 15),
                                   snapshot_path=snap_path)
            snap = json.load(open(snap_path))
        self.assertEqual(code, 1)
        self.assertTrue(any(p.startswith("close-failed: habit-water")
                            for p in snap["problems"]))
        self.assertEqual(snap["summary"]["created"], 1)
        self.assertEqual(snap["summary"]["closed"], 0)
        adds = [c for c in calls if "add" in c]
        self.assertEqual(len(adds), 1)

    def test_snapshot_out_writes_structured_items(self):
        import tempfile
        module = load_helper()
        candidates = [
            {"key": "due", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-15", "note": "2L"},
            {"key": "future", "type": "monthly", "title": "m",
             "action_date": "2026-11-20"},
            {"key": "mystery", "type": "nope", "title": "x",
             "action_date": "2026-10-15"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            snap_path = tmp + "/reminders.json"
            calls = []

            def fake_run(cmd, **kwargs):
                calls.append(cmd)
                if "view" in cmd:
                    return mock.Mock(returncode=0, stdout="[]", stderr="")
                return mock.Mock(returncode=0, stdout="", stderr="")

            fake_stdin = mock.Mock()
            fake_stdin.read.return_value = json.dumps(candidates)
            with mock.patch.object(module.subprocess, "run",
                                   side_effect=fake_run), \
                    mock.patch.object(module.sys, "stdin", fake_stdin), \
                    mock.patch.object(sys, "stdout"):
                code = module.main(
                    today_override=datetime.date(2026, 10, 15),
                    snapshot_path=snap_path)
            snap = json.load(open(snap_path))
            self.assertEqual(snap["run_date"], "2026-10-15")
            self.assertEqual(snap["task_list"], "Planned")
            by_key = {i["key"]: i for i in snap["items"]}
            self.assertEqual(by_key["due"]["status"], "created")
            self.assertEqual(by_key["due"]["days_left"], 0)
            self.assertEqual(by_key["due"]["lead_days"], 0)
            self.assertEqual(by_key["due"]["note"], "2L")
            self.assertEqual(by_key["future"]["status"], "pending")
            self.assertEqual(by_key["mystery"]["status"], "unclassified")
            self.assertEqual(snap["summary"]["created"], 1)
            self.assertEqual(code, 1)


class PaymentHandlingTests(unittest.TestCase):
    """Each payment handling class only nudges when the owner must act."""

    run_helper = HelperTests.run_helper

    def run_snapshot(self, candidates, paid=None):
        module = load_helper()
        if paid is not None:
            module.paid_into = paid
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "reminders.json")
            original = module.main
            module.main = lambda today_override: original(
                today_override=today_override, snapshot_path=path)
            code, calls = self.run_helper(module, candidates, {})
            snapshot = json.loads(Path(path).read_text(encoding="utf-8"))
        adds = [c for c in calls if "add" in c]
        return code, adds, snapshot

    def test_manual_pay_keeps_current_behavior(self):
        code, adds, snapshot = self.run_snapshot([
            {"key": "bill-a", "type": "monthly", "title": "Pay bill A",
             "action_date": "2026-10-17", "handling": "manual-pay"},
            {"key": "unclassed-bill", "type": "monthly", "title": "Pay bill",
             "action_date": "2026-10-17"},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(len(adds), 2)
        self.assertEqual([i["status"] for i in snapshot["items"]], ["created", "created"])

    def test_auto_charged_rent_creates_nothing(self):
        # Regression: an automatic rent charge must never recreate a task.
        code, adds, snapshot = self.run_snapshot([
            {"key": "rent", "type": "monthly", "title": "Pay rent",
             "action_date": "2026-10-15", "handling": "auto-charge-no-action"},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(adds, [])
        self.assertEqual(snapshot["problems"], [])
        self.assertEqual(snapshot["items"][0]["status"], "auto")

    def test_auto_charge_no_action_reports_failed_charge_only(self):
        code, adds, snapshot = self.run_snapshot([
            {"key": "rent", "type": "monthly", "title": "Rent",
             "action_date": "2026-10-15", "handling": "auto-charge-no-action",
             "exception": "failed-charge"},
        ])
        self.assertEqual(code, 1)
        self.assertEqual(adds, [])
        self.assertEqual(snapshot["problems"], ["exception: rent: failed-charge"])
        self.assertEqual(snapshot["items"][0]["status"], "exception")

    def test_auto_charge_watch_silent_until_exception(self):
        code, adds, snapshot = self.run_snapshot([
            {"key": "streaming", "type": "monthly", "title": "Streaming",
             "action_date": "2026-10-15", "handling": "auto-charge-watch"},
            {"key": "insurance", "type": "monthly", "title": "Premium",
             "action_date": "2026-10-15", "handling": "auto-charge-watch",
             "exception": "amount-change", "note": "100.00 -> 120.00"},
        ])
        self.assertEqual(code, 1)
        self.assertEqual(adds, [])
        self.assertEqual([i["status"] for i in snapshot["items"]], ["auto", "exception"])
        self.assertEqual(snapshot["problems"],
                         ["exception: insurance: amount-change (100.00 -> 120.00)"])

    def test_auto_charge_record_tasks_only_on_charge_date(self):
        code, adds, snapshot = self.run_snapshot([
            {"key": "premium", "type": "annual_oneoff", "title": "Insurance premium",
             "action_date": "2026-10-15", "handling": "auto-charge-record",
             "note": "Record in budget"},
            {"key": "premium-later", "type": "annual_oneoff", "title": "Insurance",
             "action_date": "2026-10-20", "handling": "auto-charge-record"},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(len(adds), 1)
        self.assertIn("Record: Insurance premium", adds[0])
        self.assertEqual([i["status"] for i in snapshot["items"]], ["created", "auto"])

    def test_unknown_class_or_exception_is_unclassified(self):
        code, adds, snapshot = self.run_snapshot([
            {"key": "a", "type": "monthly", "title": "a",
             "action_date": "2026-10-15", "handling": "auto-magic"},
            {"key": "b", "type": "monthly", "title": "b",
             "action_date": "2026-10-15", "handling": "auto-charge-no-action",
             "exception": "amount-change"},
        ])
        self.assertEqual(code, 1)
        self.assertEqual(adds, [])
        self.assertEqual([i["status"] for i in snapshot["items"]],
                         ["unclassified", "unclassified"])


class PaidCheckTests(unittest.TestCase):
    """A manual payment already made this cycle needs no reminder task."""

    run_helper = HelperTests.run_helper
    run_snapshot = PaymentHandlingTests.run_snapshot

    def loan(self, **extra):
        return {"key": "loan-a", "type": "monthly", "title": "Pay loan A",
                "action_date": "2026-10-17", "paid_account": "Loan A", **extra}

    def test_paid_this_cycle_creates_no_task(self):
        seen = []
        code, adds, snapshot = self.run_snapshot(
            [self.loan()], paid=lambda account, due, current: seen.append((account, due)) or True)
        self.assertEqual(code, 0)
        self.assertEqual(adds, [])
        self.assertEqual(snapshot["items"][0]["status"], "paid")
        self.assertEqual(seen, [("Loan A", datetime.date(2026, 10, 17))])

    def test_not_paid_creates_the_task(self):
        code, adds, snapshot = self.run_snapshot([self.loan()], paid=lambda *a: False)
        self.assertEqual(len(adds), 1)
        self.assertEqual(snapshot["items"][0]["status"], "created")

    def test_unreadable_actual_still_creates_the_task(self):
        code, adds, snapshot = self.run_snapshot([self.loan()], paid=lambda *a: None)
        self.assertEqual(len(adds), 1)
        self.assertEqual(snapshot["items"][0]["status"], "created")

    def test_no_paid_account_never_checks(self):
        def boom(*a):
            raise AssertionError("checked")
        code, adds, snapshot = self.run_snapshot(
            [{"key": "b", "type": "monthly", "title": "b", "action_date": "2026-10-17"}], paid=boom)
        self.assertEqual(len(adds), 1)

    def test_outside_the_window_never_checks(self):
        def boom(*a):
            raise AssertionError("checked")
        code, adds, snapshot = self.run_snapshot([self.loan(action_date="2026-11-17")], paid=boom)
        self.assertEqual(snapshot["items"][0]["status"], "pending")

    def test_paid_account_must_be_text(self):
        code, adds, snapshot = self.run_snapshot([self.loan(paid_account=5)], paid=lambda *a: True)
        self.assertEqual(snapshot["items"][0]["status"], "unclassified")

    def actual(self, txns, accounts=({"id": "acc-a", "name": "Loan A"},)):
        module = load_helper()
        fake = mock.Mock()
        fake.mcp_call.return_value = {"accounts": list(accounts)}
        fake.http_json.return_value = (txns, {})
        module._snapshot_module = lambda: fake
        return module, fake

    def test_paid_into_counts_money_in_this_cycle_only(self):
        due, today = datetime.date(2026, 11, 21), datetime.date(2026, 11, 21)
        with mock.patch.dict("os.environ", {"ACTUAL_PRIMARY_BUDGET_FILE": "b"}):
            module, fake = self.actual([{"account": "acc-a", "amount": 50000, "date": "2026-11-17"}])
            self.assertTrue(module.paid_into("Loan A", due, today))
            since = "since_date=2026-11-01"
            self.assertIn(since, fake.http_json.call_args[0][0])
            module, _ = self.actual([{"account": "acc-a", "amount": -500, "date": "2026-11-17"},
                                     {"account": "acc-b", "amount": 50000, "date": "2026-11-17"}])
            self.assertFalse(module.paid_into("Loan A", due, today))
            module, _ = self.actual([], accounts=())
            self.assertIsNone(module.paid_into("Loan A", due, today))
            module, fake = self.actual([])
            fake.http_json.side_effect = OSError("down")
            self.assertIsNone(module.paid_into("Loan A", due, today))


if __name__ == "__main__":
    unittest.main()
