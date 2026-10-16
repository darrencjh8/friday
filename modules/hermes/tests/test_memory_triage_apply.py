"""Tests for `memory_triage.py apply` plan freshness.

The memory-approve-queue cron writes the queue listing to tmp/triage-queue.json and
then its verdict plan to tmp/triage-plan.json. A plan older than the listing
was judged against an earlier queue (on 2026-10-10 the agent's plan write
failed and the previous day's plan was applied), so apply must refuse it.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "memory_triage.py"

STUB_WA = """
MEMORY = "memory"
def list_pending(sub): return []
def get_pending(sub, pid): return None
def discard_pending(sub, pid): pass
def pending_count(sub): return 0
"""

STUB_MT = """
def load_on_disk_store(): return {}
def apply_memory_pending(payload, store): return {"success": True}
def _pin_matched_entries(store, payload): return None
"""


class ApplyFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / "home"
        (self.home / "memories").mkdir(parents=True)
        (self.home / "memories" / "MEMORY.md").write_text("m\n")
        (self.home / "memories" / "USER.md").write_text("u\n")
        (self.home / "tmp").mkdir()
        stub = root / "stub" / "tools"
        stub.mkdir(parents=True)
        (stub / "__init__.py").write_text("")
        (stub / "write_approval.py").write_text(STUB_WA)
        (stub / "memory_tool.py").write_text(STUB_MT)
        self.env = {**os.environ, "HERMES_HOME": str(self.home), "PYTHONPATH": str(root / "stub")}
        self.queue = self.home / "tmp" / "triage-queue.json"
        self.plan = self.home / "tmp" / "triage-plan.json"

    def tearDown(self):
        self.tmp.cleanup()

    def apply(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), "apply", "--plan", str(self.plan)],
                              env=self.env, capture_output=True, text=True)
        return proc.returncode, json.loads(proc.stdout)

    def write(self, queue_age, plan_age):
        self.queue.write_text("[]")
        self.plan.write_text(json.dumps({"approve": [], "discard": []}))
        now = 1_800_000_000
        os.utime(self.queue, (now - queue_age, now - queue_age))
        os.utime(self.plan, (now - plan_age, now - plan_age))

    def test_refuses_plan_older_than_queue_listing(self):
        self.write(queue_age=60, plan_age=86_400)
        rc, report = self.apply()
        self.assertNotEqual(rc, 0)
        self.assertFalse(report["ok"])
        self.assertIn("older than the queue listing", report["error"])

    def test_accepts_plan_written_after_listing(self):
        self.write(queue_age=120, plan_age=60)
        rc, report = self.apply()
        self.assertEqual(rc, 0, report)
        self.assertTrue(report["ok"])

    def test_no_listing_keeps_manual_apply_working(self):
        self.plan.write_text(json.dumps({"approve": [], "discard": []}))
        rc, report = self.apply()
        self.assertEqual(rc, 0, report)


if __name__ == "__main__":
    unittest.main()
