"""Phase 4 of #220: Friday may send at most one self-initiated message a day.

proactive-tick offers a persona slot once a day from the evening on, and records
it as seen, so a second tick the same day never offers it again. The seeded
prompt lets her use the slot only with a real reason, keeps delivery on Dots,
and still forbids reporting what she learnt.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock

from test_issue_192 import seed_proactive_tick

SCRIPT = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts" / "proactive-tick.py"
spec = importlib.util.spec_from_file_location("proactive_tick", SCRIPT)
tick = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tick)


def at_hour(hour):
    fixed = datetime.datetime(2026, 11, 14, hour, 5, tzinfo=tick.SGT)
    fake = mock.Mock(wraps=datetime.datetime)
    fake.now.return_value = fixed
    return mock.patch.object(tick.datetime, "datetime", fake)


class TestPersonaSlot(unittest.TestCase):
    today = datetime.date(2026, 11, 14)

    def setUp(self):
        patcher = mock.patch.object(tick, "PERSONA_SOUL", __file__)  # any existing file
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_no_slot_without_the_persona_clone(self):
        with at_hour(21), mock.patch.object(tick, "PERSONA_SOUL", "/nonexistent/SOUL.md"):
            self.assertEqual(tick.persona_source(self.today, {}, {}), [])

    def test_no_slot_before_the_evening(self):
        with at_hour(tick.PERSONA_HOUR - 1):
            self.assertEqual(tick.persona_source(self.today, {}, {}), [])

    def test_one_slot_in_the_evening(self):
        with at_hour(tick.PERSONA_HOUR):
            items = tick.persona_source(self.today, {}, {})
        self.assertEqual([key for key, _ in items], ["persona:slot"])

    def test_slot_offered_once_a_day(self):
        seen = {"persona:slot": self.today.isoformat()}
        with at_hour(21):
            self.assertEqual(tick.persona_source(self.today, seen, {}), [])
        with at_hour(21):
            tomorrow = self.today + datetime.timedelta(days=1)
            self.assertEqual(len(tick.persona_source(tomorrow, seen, {})), 1)

    def test_persona_is_a_tick_source(self):
        self.assertIs(tick.SOURCES["persona"], tick.persona_source)


class TestPersonaPrompt(unittest.TestCase):
    def test_prompt_gates_the_persona_message(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "jobs.json"
            result = seed_proactive_tick(jobs_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            job = next(j for j in json.loads(jobs_path.read_text())["jobs"] if j["name"] == "proactive-tick")
        self.assertEqual(job["deliver"], "dots")
        prompt = job["prompt"]
        self.assertIn("only when the data has a `## persona` section", prompt)
        self.assertIn("only with a real reason", prompt)
        self.assertIn("Never tell him what you learnt", prompt)
        self.assertIn("you send no persona message (step 10), reply exactly [SILENT]", prompt)


if __name__ == "__main__":
    unittest.main()
