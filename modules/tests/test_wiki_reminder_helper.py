"""Unit tests for wiki-reminder-tasks.py (no gtasks calls)."""

import datetime
import importlib.util
import json
import sys
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
                    {"title": "t", "description": m, "due": d}
                    for m, d in existing.items()
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


if __name__ == "__main__":
    unittest.main()
