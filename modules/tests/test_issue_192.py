"""Seeded cron jobs date every Google Task they create (issue #192).

proactive-tick creates Friday-list tasks from new mail through the
`gtasks tasks add` command in its seeded prompt. The prompt used to say
`-d YYYY-MM-DD` only when the email states the date, so most mail-derived
to-dos were created with no due date and never showed in the calendar.
The seeded prompt must require `-d` on every created task: the email's
date when one is stated, otherwise the creation date (the `Today:` date
at the top of the tick's data block, Asia/Singapore).

wiki-due-reminders already dates every task it creates (its helper passes
`-d <action_date>`); the second test pins that so a later change cannot
silently un-date that path.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

SEED = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "50-seed-defaults"
HELPER = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts" / "wiki-reminder-tasks.py"
BLOCK_MARKER = "# Seed proactive-tick cron job"


def proactive_tick_block() -> str:
    """Return the proactive-tick seeding block exactly as the image runs it."""
    text = SEED.read_text(encoding="utf-8")
    start = text.index("python3 <<'PYEOF' || true\n", text.index(BLOCK_MARKER))
    start += len("python3 <<'PYEOF' || true\n")
    code = text[start:text.index("\nPYEOF", start)]
    return code


def seed_proactive_tick(jobs_path: Path) -> subprocess.CompletedProcess:
    """Run the seeding block against a throwaway jobs file."""
    block = proactive_tick_block().replace(
        "/opt/data/cron/jobs.json", str(jobs_path))
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    return subprocess.run([sys.executable, "-c", block],
                          env=env, text=True, capture_output=True)


def seeded_prompt(jobs_path: Path) -> str:
    data = json.loads(jobs_path.read_text(encoding="utf-8"))
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    job = next(j for j in jobs if j.get("name") == "proactive-tick")
    return job["prompt"]


class TestIssue192(unittest.TestCase):
    def test_proactive_tick_dates_every_created_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "jobs.json"
            jobs_path.write_text(json.dumps({"jobs": []}))
            result = seed_proactive_tick(jobs_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            prompt = seeded_prompt(jobs_path)
        track = next(
            line for line in prompt.splitlines()
            if line.startswith("4. Track:"))
        self.assertIn('gtasks tasks add -l "Friday"', track)
        self.assertIn("-d <date>", track)
        # The old rule dated a task only when the email stated a date;
        # that is what left most tasks undated.
        self.assertNotIn("only when the email states the date", prompt)
        # Undated mail gets the creation date: the `Today:` date at the
        # top of the tick's data block (Asia/Singapore), named in the
        # Track step itself as the `-d` fallback.
        self.assertIn("Today:", track)

    def test_wiki_due_reminders_helper_always_dates_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bindir = tmp / "bin"
            bindir.mkdir()
            log = tmp / "gtasks.log"
            fake = bindir / "gtasks"
            fake.write_text(
                "#!/bin/sh\n"
                f'printf "%s\\n" "$*" >> "{log}"\n'
                'if [ "$4" = "view" ]; then echo "[]"; fi\n'
                "exit 0\n")
            fake.chmod(0o755)
            # Due tomorrow: inside the monthly 3-day lead window, and
            # never overdue no matter when the suite runs (a fixed date
            # goes overdue once the runner date passes it).
            action_date = (date.today() + timedelta(days=1)).isoformat()
            candidates = [{
                "key": "bill",
                "type": "monthly",
                "title": "Pay card bill",
                "action_date": action_date,
                "note": "",
            }]
            env = {**os.environ,
                   "PATH": f"{bindir}:{os.environ['PATH']}"}
            result = subprocess.run(
                [sys.executable, str(HELPER)],
                input=json.dumps(candidates),
                env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            # The notes arg carries a newline (the marker line), so the
            # logged call spans two lines; check the whole log.
            log_text = log.read_text()
        self.assertEqual(log_text.count("tasks add "), 1)
        self.assertIn(f"-d {action_date}", log_text)


if __name__ == "__main__":
    unittest.main()
