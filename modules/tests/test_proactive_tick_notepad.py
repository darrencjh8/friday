"""#240: proactive-tick remembers what it told the owner and keeps its own follow-ups.

Both live in the job's built-in Hermes cron notepad (`hermes cron notepad`), which
the scheduler injects into every run. The pre-run script reads the `followups`
key read-only, offers each due entry once a day until Friday deletes it, and
prints the job id so the agent can write the notepad on its first use.
"""

from __future__ import annotations

import datetime
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_issue_192 import seed_proactive_tick

SCRIPT = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts" / "proactive-tick.py"
spec = importlib.util.spec_from_file_location("proactive_tick", SCRIPT)
tick = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tick)

JOB_ID = "5bb972340ca3"


class TestFollowups(unittest.TestCase):
    today = datetime.date(2026, 11, 20)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.notepad = Path(tmp.name) / "notepad.db"
        self.jobs = Path(tmp.name) / "jobs.json"
        self.jobs.write_text(json.dumps({"jobs": [{"id": "other", "name": "memory-backup"},
                                                  {"id": JOB_ID, "name": "proactive-tick"}]}))
        for name, path in (("NOTEPAD", self.notepad), ("JOBS", self.jobs)):
            patcher = mock.patch.object(tick, name, str(path))
            patcher.start()
            self.addCleanup(patcher.stop)

    def set_followups(self, value, job_id=JOB_ID):
        conn = sqlite3.connect(self.notepad)
        conn.execute("CREATE TABLE IF NOT EXISTS cron_notepad (job_id TEXT NOT NULL, key TEXT NOT NULL, "
                     "value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (job_id, key))")
        conn.execute("INSERT OR REPLACE INTO cron_notepad VALUES (?, 'followups', ?, '')", (job_id, value))
        conn.commit()
        conn.close()

    def test_own_job_id_from_jobs_file(self):
        self.assertEqual(tick.own_job_id(), JOB_ID)

    def test_no_notepad_yet(self):
        self.assertEqual(tick.followups_source(self.today, {}, {}), [])

    def test_notepad_without_table(self):
        sqlite3.connect(self.notepad).close()
        self.assertEqual(tick.followups_source(self.today, {}, {}), [])

    def test_only_due_entries_are_offered(self):
        self.set_followups("2026-11-19 | did the clinic reply?; 2026-11-20 | confirm the booking;"
                           " 2026-11-25 | not yet\nno date here")
        items = tick.followups_source(self.today, {}, {})
        self.assertEqual([text for _, text in items],
                         ["2026-11-19 | did the clinic reply?", "2026-11-20 | confirm the booking"])

    def test_due_entry_offered_once_a_day_until_deleted(self):
        self.set_followups("2026-11-19 | did the clinic reply?")
        key, _ = tick.followups_source(self.today, {}, {})[0]
        seen = {key: self.today.isoformat()}
        self.assertEqual(tick.followups_source(self.today, seen, {}), [])
        self.assertEqual(len(tick.followups_source(self.today + datetime.timedelta(days=1), seen, {})), 1)

    def test_other_jobs_notes_are_ignored(self):
        self.set_followups("2026-11-19 | not mine", job_id="other")
        self.assertEqual(tick.followups_source(self.today, {}, {}), [])

    def test_followups_is_a_tick_source(self):
        self.assertIs(tick.SOURCES["followups"], tick.followups_source)


class TestNotepadPrompt(unittest.TestCase):
    def test_prompt_explains_reported_and_followups(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "jobs.json"
            result = seed_proactive_tick(jobs_path)
            self.assertEqual(result.returncode, 0, result.stderr)
            job = next(j for j in json.loads(jobs_path.read_text())["jobs"] if j["name"] == "proactive-tick")
        prompt = job["prompt"]
        self.assertIn("/opt/hermes/bin/hermes cron notepad <Job id> set", prompt)
        self.assertIn("`reported`", prompt)
        self.assertIn("never repeat", prompt)
        self.assertIn("`followups`", prompt)
        self.assertIn("never put them on his Google Tasks list or calendar", prompt)


if __name__ == "__main__":
    unittest.main()
