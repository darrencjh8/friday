"""Pre-run gates of the memory-compact and memory-approve-queue cron jobs."""

import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "hermes" / "scripts"
DAY = 86400


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.triage = self.home / "triage.sh"

    def tearDown(self):
        self.tmp.cleanup()

    def run_gate(self, script, listing):
        self.triage.write_text(f"cat <<'JSON'\n{json.dumps(listing)}\nJSON\n")
        env = {**os.environ, "HERMES_HOME": str(self.home), "MEMORY_TRIAGE": str(self.triage)}
        result = subprocess.run([sys.executable, str(SCRIPTS / script)], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()


class CompactGateTest(GateTest):
    def compact(self, memory, user="100/1375"):
        return self.run_gate("memory-compact-gate.py", {"memory_chars": {"memory": memory, "user": user}, "pending": []})

    def test_under_threshold_stays_silent(self):
        self.assertEqual(self.compact("1896/2800"), "")

    def test_full_store_wakes_once_until_sizes_change(self):
        self.assertIn("memory 2300/2800", self.compact("2300/2800"))
        self.assertEqual(self.compact("2300/2800"), "")
        self.assertIn("memory 2350/2800", self.compact("2350/2800"))

    def test_triage_error_fails_the_run(self):
        self.triage.write_text("echo '{\"memory_chars\": {\"error\": \"boom\"}}'\n")
        env = {**os.environ, "HERMES_HOME": str(self.home), "MEMORY_TRIAGE": str(self.triage)}
        result = subprocess.run([sys.executable, str(SCRIPTS / "memory-compact-gate.py")], env=env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


class QueueGateTest(GateTest):
    def queue(self, *records):
        pending = [{"id": i, "age_days": age} for i, age in records]
        return self.run_gate("memory-queue-gate.py", {"memory_chars": {}, "pending": pending})

    def test_empty_queue_stays_silent(self):
        self.assertEqual(self.queue(), "")

    def test_new_record_wakes_once(self):
        self.assertIn("1 new", self.queue(("a", 0.5)))
        self.assertEqual(self.queue(("a", 1.5)), "")
        self.assertIn("1 new", self.queue(("a", 2.5), ("b", 0.1)))

    def test_old_held_record_nags_weekly(self):
        self.queue(("a", 3))
        self.assertIn("1 held 7+ days", self.queue(("a", 7.2)))
        self.assertEqual(self.queue(("a", 8.2)), "")
        state = self.home / "cron" / "memory-queue-gate.json"
        data = json.loads(state.read_text())
        data["nagged"]["a"] = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
        state.write_text(json.dumps(data))
        self.assertIn("1 held 7+ days", self.queue(("a", 14.2)))


if __name__ == "__main__":
    unittest.main()
