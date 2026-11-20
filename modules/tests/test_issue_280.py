"""#280: alert Darren when the nightly maintenance run is missed.

The hourly proactive-tick job checks Hermes' state.db for a session started
since 02:00 SGT today whose first message starts with "Nightly maintenance".
No such session by 07:00 means the nightly never reached Friday, so the
source emits one ALERT line, at most once a day.
"""

from __future__ import annotations

import datetime
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "scripts" / "proactive-tick.py"
spec = importlib.util.spec_from_file_location("proactive_tick", SCRIPT)
tick = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tick)

KEY = "nightly:missed"
ALERT = "ALERT: The nightly maintenance run did not reach Friday today"


def epoch(year, month, day, hour, minute=0):
    moment = datetime.datetime(year, month, day, hour, minute, tzinfo=tick.SGT)
    return int(moment.timestamp())


class TestNightlyMissed(unittest.TestCase):
    today = datetime.date(2026, 11, 20)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "state.db"
        patcher = mock.patch.object(tick, "STATE_DB", str(self.db), create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.set_now(datetime.datetime(2026, 11, 20, 8, 0, tzinfo=tick.SGT))

    def set_now(self, moment):
        class FakeDateTime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return moment

        patcher = mock.patch.object(tick.datetime, "datetime", FakeDateTime)
        patcher.start()
        self.addCleanup(patcher.stop)

    def seed_messages(self, rows):
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE messages (session_id TEXT, timestamp INTEGER, text TEXT, role TEXT)")
        conn.executemany("INSERT INTO messages VALUES (?, ?, ?, ?)", rows)
        conn.commit()
        conn.close()

    def test_marker_session_after_0200_is_silent(self):
        self.seed_messages([("s1", epoch(2026, 11, 20, 3), "Nightly maintenance run", "user")])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_no_session_after_0200_alerts_once(self):
        self.seed_messages([])
        items = tick.nightly_source(self.today, {}, {})
        self.assertEqual(items, [(KEY, ALERT)])
        seen = {KEY: self.today.isoformat()}
        self.assertEqual(tick.nightly_source(self.today, seen, {}), [])

    def test_before_0700_is_silent(self):
        self.set_now(datetime.datetime(2026, 11, 20, 6, 0, tzinfo=tick.SGT))
        self.seed_messages([])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_yesterdays_session_does_not_count(self):
        self.seed_messages([("s1", epoch(2026, 11, 19, 3), "Nightly maintenance run", "user")])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_unmarked_session_after_0200_alerts(self):
        self.seed_messages([("s1", epoch(2026, 11, 20, 3), "What is the weather?", "user")])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_first_message_only(self):
        self.seed_messages([
            ("s1", epoch(2026, 11, 20, 3), "What is the weather?", "user"),
            ("s1", epoch(2026, 11, 20, 3, 5), "Nightly maintenance run", "user"),
        ])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_missing_state_db_raises(self):
        with self.assertRaises(sqlite3.OperationalError):
            tick.nightly_source(self.today, {}, {})


if __name__ == "__main__":
    unittest.main()
