"""The monthly cron deletes completed Google Tasks (issue #129).

A completed wiki reminder dated today or later is kept: the daily reminder
job dedups on its marker and would otherwise create it again.
"""

import datetime
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "hermes" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import gtasks  # noqa: E402

TODAY = datetime.date(2026, 11, 1)


def load_clear():
    spec = importlib.util.spec_from_file_location("gtasks_clear", SCRIPTS / "gtasks-clear-completed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(tasks):
    """Run the cron against one list holding `tasks`; return the API calls made."""
    calls = []

    def api(method, path, body=None):
        calls.append((method, path))
        if path.startswith("/users/@me/lists"):
            return {"items": [{"id": "L"}]}
        if method == "GET":
            return {"items": tasks}
        return {}

    with mock.patch.object(gtasks, "_api", api):
        load_clear().main(today=TODAY)
    return calls


def deleted(calls):
    return [path.rsplit("/", 1)[1] for method, path in calls if method == "DELETE"]


def marker(date):
    return "Pay it\nwiki-reminder-marker:bill:card:%s" % date


class DeleteCompletedTest(unittest.TestCase):
    def test_deletes_completed_tasks_and_keeps_open_ones(self):
        calls = run([{"id": "done", "status": "completed"},
                     {"id": "open", "status": "needsAction"}])
        self.assertEqual(deleted(calls), ["done"])
        self.assertIn("showHidden=true", next(p for m, p in calls if m == "GET" and "/tasks" in p))

    def test_keeps_completed_reminder_dated_today_or_later(self):
        calls = run([{"id": "past", "status": "completed", "notes": marker("2026-10-31")},
                     {"id": "today", "status": "completed", "notes": marker("2026-11-01")},
                     {"id": "later", "status": "completed", "notes": marker("2026-12-05")},
                     {"id": "bad", "status": "completed", "notes": marker("someday")}])
        self.assertEqual(deleted(calls), ["past"])
        # The kept ones are still hidden, as before.
        self.assertIn(("POST", "/lists/L/clear"), calls)

    def test_keeps_completed_parent_with_open_subtask(self):
        calls = run([{"id": "parent", "status": "completed"},
                     {"id": "child", "status": "needsAction", "parent": "parent"}])
        self.assertEqual(deleted(calls), [])

    def test_keeps_completed_parent_of_kept_reminder(self):
        calls = run([{"id": "parent", "status": "completed"},
                     {"id": "child", "status": "completed", "parent": "parent", "notes": marker("2026-12-05")}])
        self.assertEqual(deleted(calls), [])

    def test_delete_error_fails_the_run(self):
        def api(method, path, body=None):
            if method == "DELETE":
                raise RuntimeError("Tasks API error: boom")
            return {"items": [{"id": "L"}]} if path.startswith("/users") else {"items": [{"id": "t", "status": "completed"}]}

        with mock.patch.object(gtasks, "_api", api), self.assertRaises(RuntimeError):
            load_clear().main(today=TODAY)


if __name__ == "__main__":
    unittest.main()
