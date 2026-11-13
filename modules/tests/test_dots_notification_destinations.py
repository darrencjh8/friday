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


def seed_block(name):
    blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED.read_text(encoding="utf-8"), re.DOTALL)
    for block in blocks:
        if f'"name": "{name}"' in block:
            return block
    # The monthly no_agent jobs share one block and name their jobs through a
    # SEEDS mapping, so match the dynamic `"name": name` assignment instead.
    return next(block for block in blocks if f'"{name}"' in block and '"name": name' in block)


def run_seed(name, jobs):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "jobs.json"
        path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
        code = seed_block(name).replace("/opt/data/cron/jobs.json", str(path))
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        return json.loads(path.read_text(encoding="utf-8"))["jobs"]


def run_tick_seed(jobs):
    return run_seed("proactive-tick", jobs)


DOTS_CRON_JOBS = (
    "wiki-finance-refresh",
    "memory-compact",
    "memory-mnemosyne-forget",
    "wiki-due-reminders",
    "wiki-repo-docs",
    "gtasks-clear-completed",
    "notion-monthly-bills-reset",
    "actual-backup",
    "proactive-tick",
)


class DotsNotificationDestinationsTest(unittest.TestCase):
    def test_proactive_tick_and_expense_webhook_deliver_to_dots(self):
        config = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
        route = config["platforms"]["webhook"]["extra"]["routes"]["notify"]
        with self.subTest("expense webhook"):
            self.assertEqual(route["deliver"], "dots")
            self.assertEqual(route["deliver_extra"]["chat_id"], "${DOTS_HOME_CHANNEL}")
            self.assertIs(route["mirror_to_session"], True)

        with self.subTest("new proactive tick"):
            [job] = run_tick_seed([])
            self.assertEqual(job["deliver"], "dots")
            self.assertIs(job["attach_to_session"], True)

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
            self.assertIs(job["attach_to_session"], True)

    def test_new_dots_cron_jobs_attach_their_runs_to_a_session(self):
        for name in DOTS_CRON_JOBS:
            with self.subTest(name):
                job = next(j for j in run_seed(name, []) if j["name"] == name)
                self.assertEqual(job["deliver"], "dots")
                self.assertIs(job["attach_to_session"], True)

    def test_existing_dots_cron_jobs_gain_attachment_without_losing_settings(self):
        for name in DOTS_CRON_JOBS:
            with self.subTest(name):
                jobs = run_seed(name, [{
                    "id": "keep-me",
                    "name": name,
                    "schedule": {"kind": "cron", "expr": "5 6 * * 3", "display": "custom"},
                    "schedule_display": "custom",
                    "enabled": False,
                    "deliver": "dots",
                    "attach_to_session": False,
                    "user_note": "preserve",
                }])
                job = next(j for j in jobs if j["name"] == name)
                self.assertEqual(job["id"], "keep-me")
                self.assertEqual(job["schedule"]["expr"], "5 6 * * 3")
                self.assertEqual(job["schedule_display"], "custom")
                self.assertIs(job["enabled"], False)
                self.assertEqual(job["deliver"], "dots")
                self.assertEqual(job["user_note"], "preserve")
                self.assertIs(job["attach_to_session"], True)

    def test_telegram_cron_jobs_move_to_dots_once(self):
        block = re.search(r'dots_marker=.*?\nfi\n', SEED.read_text(encoding="utf-8"), re.DOTALL).group(0)
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path, marker = Path(tmp) / "jobs.json", Path(tmp) / "marker"
            script = block.replace("/opt/data/cron/jobs.json", str(jobs_path)).replace(
                "/opt/data/cron/.telegram-to-dots-migrated", str(marker))
            jobs_path.write_text(json.dumps({"jobs": [
                {"name": "a", "deliver": "telegram", "deliver_extra": {"chat_id": "1"}},
                {"name": "b", "deliver": "slack"},
                {"name": "c", "deliver": "local"},
                {"name": "skills-merge-proposals", "deliver": "telegram"},
            ]}), encoding="utf-8")
            subprocess.run(["sh", "-c", script], capture_output=True, text=True, check=True)
            jobs = json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"]
            self.assertEqual([j["deliver"] for j in jobs], ["dots", "slack", "local", "telegram"])
            self.assertNotIn("deliver_extra", jobs[0])
            self.assertTrue(marker.exists())

            # Once the marker exists, a job moved back to Telegram stays there.
            jobs[0]["deliver"] = "telegram"
            jobs_path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
            subprocess.run(["sh", "-c", script], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"][0]["deliver"], "telegram")

    def test_only_reply_approved_job_defaults_to_telegram(self):
        seeds = re.findall(r'"deliver": "telegram".*', SEED.read_text(encoding="utf-8"))
        self.assertEqual(len(seeds), 1)
        self.assertIn("approvals reply", seeds[0])


if __name__ == "__main__":
    unittest.main()
