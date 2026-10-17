"""Memory crons only message Darren when he can act, and compaction keeps up daily."""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SEED = (Path(__file__).resolve().parents[1] / "hermes" / "50-seed-defaults").read_text(encoding="utf-8")
BLOCKS = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)


def block(name):
    return next(b for b in BLOCKS if f'"name": "{name}"' in b)


def seed(name, jobs):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "jobs.json")
        json.dump({"jobs": jobs}, open(path, "w"))
        code = block(name).replace("/opt/data/cron/jobs.json", path).replace("/opt/data/config.yaml", os.path.join(tmp, "none.yaml"))
        subprocess.run([sys.executable, "-c", code], check=True, capture_output=True)
        return next(j for j in json.load(open(path))["jobs"] if j["name"] == name)


class MemoryCronNotifyTest(unittest.TestCase):
    def test_full_store_alone_does_not_notify(self):
        prompt = seed("memory-approve-queue", [])["prompt"]
        silent_rule = next(line for line in prompt.splitlines() if "reply exactly [SILENT]" in line)
        self.assertNotIn("95%", silent_rule)

    def test_compact_runs_daily(self):
        self.assertEqual(seed("memory-compact", [])["schedule"]["expr"], "30 7 * * *")

    def test_weekly_compact_schedule_migrates_to_daily(self):
        job = seed("memory-compact", [{"id": "x", "name": "memory-compact", "prompt": "old",
                                       "next_run_at": "2026-10-18T07:30:00+08:00",
                                       "schedule": {"kind": "cron", "expr": "30 7 * * 0", "display": "30 7 * * 0"},
                                       "schedule_display": "30 7 * * 0"}])
        self.assertEqual((job["schedule"]["expr"], job["schedule_display"], job["next_run_at"]), ("30 7 * * *", "30 7 * * *", None))

    def test_compact_handles_every_full_store(self):
        prompt = seed("memory-compact", [])["prompt"]
        self.assertNotIn("fullest", prompt)
        self.assertIn("compact-plan-user.json", prompt)


if __name__ == "__main__":
    unittest.main()
