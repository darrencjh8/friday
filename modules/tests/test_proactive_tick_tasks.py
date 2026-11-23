"""Issue #320: an expired Google token is one plain line, not a failed tick.

The gtasks CLI already exits 3 with a plain message when the token is expired
or revoked; proactive-tick collapsed that into a generic ALERT, which the tick
prompt turned into [CRON_FAILURE]. The mail and calendar sources fail the same
way through the same shared token.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts"

sys.path.insert(0, str(SCRIPTS))
import gtasks  # noqa: E402  (canonical import: never replace sys.modules["gtasks"])

_tspec = importlib.util.spec_from_file_location("proactive_tick", SCRIPTS / "proactive-tick.py")
tick = importlib.util.module_from_spec(_tspec)
_tspec.loader.exec_module(tick)

PLAIN_LINE = "Google Tasks reminders are paused — run `google login` again to reconnect."
CLI_MESSAGE = "Google token expired or revoked. Run `google login` again interactively to reconnect."


def expired_run(*args, **kwargs):
    return mock.Mock(returncode=3, stdout="", stderr=CLI_MESSAGE)


def failed_run(*args, **kwargs):
    return mock.Mock(returncode=1, stdout="", stderr="boom")


class TestFridayTasks(unittest.TestCase):
    def setUp(self):
        tick.friday_tasks.cache_clear()
        self.addCleanup(tick.friday_tasks.cache_clear)

    def test_friday_tasks_exit_3_raises_tasks_auth_expired(self):
        with mock.patch.object(tick.subprocess, "run", expired_run):
            with self.assertRaises(tick.TasksAuthExpired):
                tick.friday_tasks()

    def test_friday_tasks_other_failure_still_raises_runtime_error(self):
        with mock.patch.object(tick.subprocess, "run", failed_run):
            with self.assertRaises(RuntimeError):
                tick.friday_tasks()


class TestMainPlainLine(unittest.TestCase):
    def setUp(self):
        tick.friday_tasks.cache_clear()
        tick.upcoming_events.cache_clear()
        self.addCleanup(tick.friday_tasks.cache_clear)
        self.addCleanup(tick.upcoming_events.cache_clear)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name) / "state.json"
        patcher = mock.patch.object(tick, "STATE", str(self.state))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = tick.main()
        return code, out.getvalue()

    def test_main_reports_plain_line_once_a_day(self):
        with mock.patch.object(tick, "SOURCES", {"tasks": tick.tasks_source}), \
                mock.patch.object(tick.subprocess, "run", expired_run):
            code, first = self.run_main()
            self.assertEqual(code, 0)
            self.assertIn(PLAIN_LINE, first)
            self.assertNotIn("ALERT", first)
            code, second = self.run_main()
            self.assertEqual(code, 0)
            self.assertNotIn(PLAIN_LINE, second)

    def test_mail_source_auth_expired_is_plain_line_not_alert(self):
        self.state.write_text(json.dumps({"seen": {}, "cursors": {"gmail": 1}}))
        stub = mock.Mock()
        stub.list_messages.side_effect = gtasks.AuthExpired()
        with mock.patch.object(tick, "SOURCES", {"mail": tick.mail_source}), \
                mock.patch.object(tick, "google", lambda name: stub if name == "gmail" else None), \
                mock.patch.object(tick.subprocess, "run", expired_run):
            code, out = self.run_main()
            self.assertEqual(code, 0)
            self.assertIn(PLAIN_LINE, out)
            self.assertNotIn("ALERT", out)

    def test_calendar_source_auth_expired_is_plain_line_not_alert(self):
        stub = mock.Mock()
        stub.list_events.side_effect = gtasks.AuthExpired()
        with mock.patch.object(tick, "SOURCES", {"calendar": tick.calendar_source}), \
                mock.patch.object(tick, "google", lambda name: stub if name == "gcal" else None), \
                mock.patch.object(tick.subprocess, "run", expired_run):
            code, out = self.run_main()
            self.assertEqual(code, 0)
            self.assertIn(PLAIN_LINE, out)
            self.assertNotIn("ALERT", out)


if __name__ == "__main__":
    unittest.main()
