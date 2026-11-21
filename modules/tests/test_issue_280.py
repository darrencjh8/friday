"""#280: alert Darren when the nightly maintenance run is missed.

The hourly proactive-tick job checks Hermes' state.db for an API-server
session started since 02:00 SGT today whose first user message starts with
"Nightly maintenance". No such session by 07:00 means the nightly never
reached Friday, so the source emits one ALERT line, at most once a day.

Fixtures use only columns the deployed schema has: sessions.started_at
(epoch seconds), sessions.source, messages.content, messages.role. A query
referencing a column the fixture lacks raises sqlite3.OperationalError.
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

    def seed(self, sessions, messages):
        conn = sqlite3.connect(self.db)
        conn.execute("DROP TABLE IF EXISTS sessions")
        conn.execute("DROP TABLE IF EXISTS messages")
        conn.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, started_at REAL NOT NULL, source TEXT, created_source TEXT)")
        conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id INTEGER, role TEXT NOT NULL, content TEXT, api_content TEXT, timestamp REAL NOT NULL)")
        conn.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?)", sessions)
        conn.executemany(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
            messages,
        )
        conn.commit()
        conn.close()

    def test_marker_session_after_0200_is_silent(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_no_session_after_0200_alerts_once(self):
        self.seed([], [])
        items = tick.nightly_source(self.today, {}, {})
        self.assertEqual(items, [(KEY, ALERT)])
        seen = {KEY: self.today.isoformat()}
        self.assertEqual(tick.nightly_source(self.today, seen, {}), [])

    def test_before_0700_is_silent(self):
        self.set_now(datetime.datetime(2026, 11, 20, 6, 0, tzinfo=tick.SGT))
        self.seed([], [])
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_yesterdays_session_does_not_count(self):
        self.seed(
            [(1, epoch(2026, 11, 19, 3), "api_server", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 19, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_unmarked_session_after_0200_alerts(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", "What is the weather?", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_first_message_only(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [
                (1, 1, "user", "What is the weather?", epoch(2026, 11, 20, 3)),
                (2, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3, 5)),
            ],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_api_server_source_only(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "webui", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_created_source_ignored(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_started_at_not_min_timestamp(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 1), "api_server", None)],
            [(1, 1, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_first_user_message_ignores_non_user_rows(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [
                (1, 1, "tool", "Nightly maintenance run", epoch(2026, 11, 20, 3)),
                (2, 1, "user", "What is the weather?", epoch(2026, 11, 20, 3, 1)),
            ],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_first_user_message_null_content_alerts(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", None, epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_session_without_user_message_alerts(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "tool", "tool output", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [(KEY, ALERT)])

    def test_mixed_sessions_marker_second_is_silent(self):
        self.seed(
            [
                (1, epoch(2026, 11, 20, 3), "api_server", None),
                (2, epoch(2026, 11, 20, 3, 30), "api_server", None),
            ],
            [
                (1, 1, "user", "What is the weather?", epoch(2026, 11, 20, 3)),
                (2, 2, "user", "Nightly maintenance run", epoch(2026, 11, 20, 3, 30)),
            ],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_marker_with_leading_whitespace_is_silent(self):
        self.seed(
            [(1, epoch(2026, 11, 20, 3), "api_server", None)],
            [(1, 1, "user", "  Nightly maintenance run", epoch(2026, 11, 20, 3))],
        )
        self.assertEqual(tick.nightly_source(self.today, {}, []), [])

    def test_missing_state_db_is_silent(self):
        # No state.db yet (fresh Hermes / test harness): no session record
        # exists, so the source stays silent, like read_slots and
        # followups_source for a missing database.
        self.assertEqual(tick.nightly_source(self.today, {}, {}), [])

    def test_unreadable_state_db_raises(self):
        conn = sqlite3.connect(self.db)  # file exists, no sessions table
        conn.close()
        with self.assertRaises(sqlite3.OperationalError):
            tick.nightly_source(self.today, {}, {})


if __name__ == "__main__":
    unittest.main()
