"""#247: weekly count of proactive-tick messages vs silence.

The volume script reads the last 7 SGT days of proactive-tick output files,
extracts the agent's final reply from the recorded frame, and prints one line
only when more than 21 messages were delivered.
"""

from __future__ import annotations

import datetime
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts" / "proactive-tick-volume.py"
spec = importlib.util.spec_from_file_location("proactive_tick_volume", SCRIPT)
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)

JOB_ID = "5bb972340ca3"

# Realistic job prompt: it mentions [SILENT] and [CRON_FAILURE] literally, so a
# classifier that greps the whole file would misread every agent-run file.
PROMPT = ("Hermes cron preamble\n\n## Script Output\n```\n## mail\nnothing new\n```\n\n"
          "9. If nothing needs him reply exactly [SILENT].\n"
          "FAILURE: make the first line exactly [CRON_FAILURE] when a step failed.\n")


def output_file(prompt, reply):
    """An agent-run file in the recorded frame format."""
    header = ("# Cron Job: proactive-tick\n\n**Job ID:** 5bb972340ca3\n"
              "**Run Time:** 2026-11-16 17:00:34\n**Schedule:** hourly 8am-9pm\n\n")
    return (header + f"**Prompt Characters:** {len(prompt)}\n## Prompt\n\n{prompt}\n\n"
            f"**Response Characters:** {len(reply)}\n## Response\n\n{reply}\n")


class TestVolume(unittest.TestCase):
    today = datetime.date(2026, 11, 20)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.out_dir = self.home / "cron" / "output" / JOB_ID
        self.out_dir.mkdir(parents=True)
        self.jobs = self.home / "cron" / "jobs.json"
        self.jobs.write_text(json.dumps({"jobs": [{"id": "other", "name": "memory-backup"},
                                                  {"id": JOB_ID, "name": "proactive-tick"}]}))
        self.notepad = self.home / "cron" / "notepad.db"
        for name, path in (("JOBS", self.jobs), ("NOTEPAD", self.notepad),
                           ("OUTPUT_ROOT", self.home / "cron" / "output")):
            patcher = mock.patch.object(volume, name, str(path))
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_file(self, name, text):
        path = self.out_dir / name
        path.write_text(text)
        return path

    def write_message(self, name, reply="Here is what needs you: the clinic replied."):
        return self.write_file(name, output_file(PROMPT, reply))

    def set_reported(self, value, job_id=JOB_ID):
        conn = sqlite3.connect(self.notepad)
        conn.execute("CREATE TABLE IF NOT EXISTS cron_notepad (job_id TEXT NOT NULL, key TEXT NOT NULL, "
                     "value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (job_id, key))")
        conn.execute("INSERT OR REPLACE INTO cron_notepad VALUES (?, 'reported', ?, '')", (job_id, value))
        conn.commit()
        conn.close()

    def run_main(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = volume.main(today=self.today)
        return code, out.getvalue()

    def test_message_silent_failure_counts(self):
        self.write_message("2026-11-20_08-00-00.md")
        self.write_file("2026-11-20_09-00-00.md", output_file(PROMPT, "[SILENT]"))
        self.write_file("2026-11-20_10-00-00.md", output_file(PROMPT, "[CRON_FAILURE]\nthe mail step failed"))
        counts = volume.summarize(self.today)
        self.assertEqual((counts["messages"], counts["silent"], counts["failed"]), (1, 1, 1))
        # A run with no output file is not counted: only the three files exist.
        self.assertEqual(counts["messages"] + counts["silent"] + counts["failed"], 3)

    def test_reply_extraction_from_realistic_transcript(self):
        silent = self.write_file("2026-11-20_08-00-00.md", output_file(PROMPT, "[SILENT]"))
        self.assertEqual(volume.classify_file(str(silent)), "silent")
        failed = self.write_file("2026-11-20_09-00-00.md",
                                 output_file(PROMPT, "[CRON_FAILURE]\nthe mail step failed"))
        self.assertEqual(volume.classify_file(str(failed)), "failure")
        # [SILENT] inside the prompt does not count: the reply is a message.
        message = self.write_message("2026-11-20_10-00-00.md")
        self.assertEqual(volume.classify_file(str(message)), "message")
        broken = self.write_file("2026-11-20_11-00-00.md", "# Cron Job: proactive-tick\n\nno frame here\n")
        self.assertEqual(volume.classify_file(str(broken)), "unreadable")

    def test_threshold_boundary(self):
        for i in range(21):
            day = 14 + i // 4
            self.write_message(f"2026-11-{day:02d}_{8 + i % 4:02d}-00-00.md")
        self.assertEqual(self.run_main(), (0, ""))
        self.write_message("2026-11-20_12-00-00.md")
        code, out = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(out, "Proactive messages, last 7 days: 22 (3.1/day), 0 silent, 0 failed, 0 items.\n")

    def test_items_from_reported(self):
        self.set_reported("2026-11-19: told him about the bill; 2026-11-20: told him about the clinic; "
                          "2026-11-10: too old to count")
        counts = volume.summarize(self.today)
        self.assertEqual(counts["items"], 2)
        self.assertEqual(volume.count_items(JOB_ID, self.today - datetime.timedelta(days=6), self.today), 2)

    def test_no_reported_key_means_zero_items(self):
        counts = volume.summarize(self.today)
        self.assertEqual(counts["items"], 0)

    def test_day_buckets_sgt(self):
        self.write_message("2026-11-13_23-59-59.md")  # before the 7-day window
        self.write_message("2026-11-14_00-00-01.md")  # first day of the window
        counts = volume.summarize(self.today)
        self.assertEqual(counts["messages"], 1)
        # A file whose name does not parse falls back to its mtime (SGT).
        mystery = self.write_message("no-timestamp.md")
        stamp = datetime.datetime(2026, 11, 19, 12, 0, tzinfo=volume.SGT).timestamp()
        os.utime(mystery, (stamp, stamp))
        counts = volume.summarize(self.today)
        self.assertEqual(counts["messages"], 2)

    def test_skipped_zero_byte_file_not_counted(self):
        (self.out_dir / "2026-11-20_08-00-00.md").write_bytes(b"")
        gate = self.write_file("2026-11-20_09-00-00.md",
                               "Script gate returned `wakeAgent=false` — agent skipped.\n")
        self.assertEqual(volume.classify_file(str(gate)), "skipped")
        counts = volume.summarize(self.today)
        self.assertEqual((counts["skipped"], counts["messages"], counts["silent"], counts["failed"]),
                         (2, 0, 0, 0))
        self.assertEqual(self.run_main(), (0, ""))

    def test_unreadable_frame_counted_separately(self):
        self.write_file("2026-11-20_08-00-00.md", "# Cron Job: proactive-tick\n\nno frame here\n")
        counts = volume.summarize(self.today)
        self.assertEqual((counts["unreadable"], counts["messages"], counts["silent"], counts["failed"]),
                         (1, 0, 0, 0))
        self.assertEqual(self.run_main(), (0, ""))

    def test_unreadable_inputs_fail(self):
        self.jobs.write_text("{not json")
        self.assertEqual(self.run_main()[0], 1)
        self.jobs.write_text(json.dumps({"jobs": [{"id": JOB_ID, "name": "proactive-tick"}]}))
        self.out_dir.rmdir()
        self.assertEqual(self.run_main()[0], 1)


if __name__ == "__main__":
    unittest.main()
