"""Selected webhook and cron notifications use the Dots platform."""

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]
CONFIG = ROOT / "modules/hermes/config.yaml"
SEED = ROOT / "modules/hermes/50-seed-defaults"


def tick_seed():
    blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED.read_text(encoding="utf-8"), re.DOTALL)
    return next(block for block in blocks if '"proactive-tick"' in block)


def run_tick_seed(jobs):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "jobs.json"
        path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
        code = tick_seed().replace("/opt/data/cron/jobs.json", str(path))
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        return json.loads(path.read_text(encoding="utf-8"))["jobs"]


class DotsNotificationDestinationsTest(unittest.TestCase):
    def test_proactive_tick_and_expense_webhook_deliver_to_dots(self):
        config = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
        route = config["platforms"]["webhook"]["extra"]["routes"]["notify"]
        with self.subTest("expense webhook"):
            self.assertEqual(route["deliver"], "dots")
            self.assertEqual(route["deliver_extra"]["chat_id"], "${DOTS_HOME_CHANNEL}")

        with self.subTest("new proactive tick"):
            [job] = run_tick_seed([])
            self.assertEqual(job["deliver"], "dots")

        with self.subTest("existing proactive tick migrates only delivery target"):
            [job] = run_tick_seed([{
                "id": "abc",
                "name": "proactive-tick",
                "schedule": {"kind": "cron", "expr": "0 12 * * *"},
                "enabled": False,
                "deliver": "telegram",
            }])
            self.assertEqual(job["deliver"], "dots")
            self.assertEqual(job["schedule"]["expr"], "0 12 * * *")
            self.assertIs(job["enabled"], False)


if __name__ == "__main__":
    unittest.main()
