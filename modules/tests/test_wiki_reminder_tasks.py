"""Issue #827: daily wiki reminders target Google Tasks list Planned safely."""

from pathlib import Path
import unittest

SEED = Path(__file__).parents[1] / "hermes" / "50-seed-defaults"
HELPER = Path(__file__).parents[1] / "hermes" / "scripts" / "wiki-reminder-tasks.py"


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


if __name__ == "__main__":
    unittest.main()
