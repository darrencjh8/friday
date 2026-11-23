"""Issue #827: daily wiki reminders target Google Tasks list Planned safely."""

import importlib.util
from pathlib import Path
from unittest import mock
import unittest

SEED = Path(__file__).parents[1] / "hermes" / "50-seed-defaults"
HELPER = Path(__file__).parents[1] / "hermes" / "scripts" / "wiki-reminder-tasks.py"

_spec = importlib.util.spec_from_file_location("wiki_reminder_tasks", HELPER)
wrt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wrt)

CLI_MESSAGE = "Google token expired or revoked. Run `google login` again interactively to reconnect."


class WikiReminderTaskTests(unittest.TestCase):
    def test_daily_cron_targets_planned_with_duplicate_markers(self):
        text = SEED.read_text(encoding="utf-8")
        self.assertIn('"name": "wiki-due-reminders"', text)
        self.assertIn("Planned", text)
        self.assertIn("wiki-reminder-marker", text)
        self.assertIn("--include-completed", text)
        self.assertTrue(HELPER.is_file())
        helper = HELPER.read_text(encoding="utf-8")
        self.assertIn("Planned", helper)
        self.assertIn("wiki-reminder-marker", helper)
        self.assertIn("--include-completed", helper)

    def test_reminder_jobs_use_payment_handling_classes(self):
        text = SEED.read_text(encoding="utf-8")
        due = text.split('"name": "wiki-due-reminders"')[0].rsplit("PROMPT = ", 1)[1]
        tick = text.split("# Seed proactive-tick cron job")[1].split("MANAGED = {")[0]
        for prompt in (due, tick):
            for name in ("manual-pay", "auto-charge-no-action",
                         "auto-charge-watch", "auto-charge-record", "Handling"):
                self.assertIn(name, prompt)
        self.assertIn("recurring-payments.md", tick)

    def test_view_tasks_exit_3_reports_plain_message_only(self):
        # Issue #320: an expired token is the CLI's plain message, not a
        # "gtasks view failed:" tool error.
        proc = mock.Mock(returncode=3, stdout="", stderr=CLI_MESSAGE)
        with mock.patch.object(wrt.subprocess, "run", return_value=proc):
            with self.assertRaises(SystemExit) as caught:
                wrt.view_tasks()
        self.assertEqual(str(caught.exception), CLI_MESSAGE)

    def test_view_tasks_other_failure_keeps_prefix(self):
        proc = mock.Mock(returncode=1, stdout="", stderr="boom")
        with mock.patch.object(wrt.subprocess, "run", return_value=proc):
            with self.assertRaises(SystemExit) as caught:
                wrt.view_tasks()
        self.assertTrue(str(caught.exception).startswith("gtasks view failed:"))

    def test_status_is_checked_live_not_copied_from_the_wiki(self):
        text = SEED.read_text(encoding="utf-8")
        due = text.split('"name": "wiki-due-reminders"')[0].rsplit("PROMPT = ", 1)[1]
        self.assertIn("Status comes from the live sources, never from the wiki", due)
        self.assertIn("gmail list --query", due)
        self.assertIn("gcal events --days", due)
        self.assertIn("Never write a status into the wiki", due)
        seed = text.split("# Seed wiki-due-reminders cron job")[1].split("PYEOF")[1]
        self.assertIn('"gmail-readonly", "gcal-readonly"', seed)


if __name__ == "__main__":
    unittest.main()
