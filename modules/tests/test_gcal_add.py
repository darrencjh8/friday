"""`gcal add` creates one event on the primary calendar, and nothing else.

The login gains calendar.events.owned (events on calendars Darren owns) so
Friday can add events she finds in mail. The CLI can only insert: no attendees,
no invites, no update or delete, and one event per source message.
"""

import importlib
import json
import os
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).parents[1] / "hermes" / "scripts"
sys.path.insert(0, str(SCRIPTS))

TASKS = "https://www.googleapis.com/auth/tasks"
GMAIL = "https://www.googleapis.com/auth/gmail.readonly"
CAL = "https://www.googleapis.com/auth/calendar.readonly"
CAL_EVENTS = "https://www.googleapis.com/auth/calendar.events.owned"


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class GcalAddTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.gtasks = importlib.reload(importlib.import_module("gtasks"))
        self.gmail = importlib.reload(importlib.import_module("gmail"))
        self.gcal = importlib.reload(importlib.import_module("gcal"))
        self.requests = []
        self.existing = []

    def save(self, scopes):
        self.gtasks._save_token({"access_token": "a", "refresh_token": "r", "expiry": 9e12,
                                 "client_id": "c", "client_secret": "s", "scopes": scopes})

    def urlopen(self, req, timeout=None):
        self.requests.append(req)
        if req.get_method() == "GET":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)
            if "privateExtendedProperty" in query:
                wanted = query["privateExtendedProperty"][0].split("=", 1)[1]
                return _Response({"items": [e for e in self.existing
                                            if e.get("extendedProperties", {}).get("private", {})
                                            .get("friday_source") == wanted]})
            return _Response({"items": self.existing})
        return _Response({"id": "new1", "htmlLink": "https://calendar.google.com/event?eid=new1"})

    def add(self, *args):
        with mock.patch("urllib.request.urlopen", self.urlopen), \
                mock.patch("builtins.print") as printed:
            code = self.gcal.main(["add", *args])
        out = json.loads(printed.call_args.args[0]) if printed.call_args else None
        return code, out

    def posts(self):
        return [r for r in self.requests if r.get_method() == "POST"]

    def test_add_timed_event_inserts_on_primary_without_invites(self):
        self.save([TASKS, GMAIL, CAL, CAL_EVENTS])
        code, out = self.add("--title", "Dental: Example Clinic", "--start", "2026-11-05T10:00",
                             "--end", "2026-11-05T11:00", "--tz", "Asia/Singapore",
                             "--location", "1 Example Road", "--description", "Booking ABC123",
                             "--source", "gmail:m1")
        self.assertEqual(code, 0)
        self.assertEqual(out["status"], "created")
        self.assertEqual(out["id"], "new1")
        [post] = self.posts()
        url = urllib.parse.urlparse(post.full_url)
        self.assertTrue(url.path.endswith("/calendars/primary/events"))
        self.assertEqual(urllib.parse.parse_qs(url.query)["sendUpdates"], ["none"])
        body = json.loads(post.data)
        self.assertEqual(body["summary"], "Dental: Example Clinic")
        self.assertEqual(body["start"], {"dateTime": "2026-11-05T10:00:00", "timeZone": "Asia/Singapore"})
        self.assertEqual(body["end"], {"dateTime": "2026-11-05T11:00:00", "timeZone": "Asia/Singapore"})
        self.assertEqual(body["location"], "1 Example Road")
        self.assertEqual(body["extendedProperties"], {"private": {"friday_source": "gmail:m1"}})
        self.assertNotIn("attendees", body)
        self.assertNotIn("conferenceData", body)
        self.assertEqual(len([r for r in self.requests if r.get_method() == "POST"]), 1)

    def test_add_all_day_due_date_with_popup_reminder(self):
        self.save([TASKS, GMAIL, CAL, CAL_EVENTS])
        code, out = self.add("--title", "Pay card bill", "--date", "2026-11-20",
                             "--reminder-minutes", "1440", "--source", "gmail:m2")
        self.assertEqual((code, out["status"]), (0, "created"))
        body = json.loads(self.posts()[0].data)
        self.assertEqual(body["start"], {"date": "2026-11-20"})
        self.assertEqual(body["end"], {"date": "2026-11-21"})
        self.assertEqual(body["reminders"], {"useDefault": False,
                                             "overrides": [{"method": "popup", "minutes": 1440}]})

    def test_same_source_message_is_never_added_twice(self):
        self.save([TASKS, GMAIL, CAL, CAL_EVENTS])
        self.existing = [{"id": "old1", "summary": "Anything", "htmlLink": "https://calendar.google.com/event?eid=old1",
                          "start": {"date": "2026-11-20"},
                          "extendedProperties": {"private": {"friday_source": "gmail:m2"}}}]
        code, out = self.add("--title", "Pay card bill", "--date", "2026-11-20", "--source", "gmail:m2")
        self.assertEqual((code, out["status"], out["id"]), (0, "exists", "old1"))
        self.assertEqual(self.posts(), [])

    def test_same_title_within_a_day_counts_as_existing(self):
        self.save([TASKS, GMAIL, CAL, CAL_EVENTS])
        self.existing = [{"id": "manual1", "summary": "dental:  example clinic ",
                          "htmlLink": "https://calendar.google.com/event?eid=manual1",
                          "start": {"dateTime": "2026-11-05T09:30:00+08:00"}}]
        code, out = self.add("--title", "Dental: Example Clinic", "--start", "2026-11-05T10:00",
                             "--end", "2026-11-05T11:00", "--source", "gmail:m3")
        self.assertEqual((code, out["status"], out["id"]), (0, "exists", "manual1"))
        self.assertEqual(self.posts(), [])

    def test_add_needs_the_owned_events_scope(self):
        self.save([TASKS, GMAIL, CAL])  # login from before this change
        with mock.patch("urllib.request.urlopen", self.urlopen), mock.patch("sys.stderr"):
            code = self.gcal.main(["add", "--title", "X", "--date", "2026-11-20", "--source", "gmail:m4"])
        self.assertEqual(code, self.gmail.EXIT_AUTH_EXPIRED)
        self.assertEqual(self.requests, [])

    def test_add_rejects_bad_input_before_any_request(self):
        self.save([TASKS, GMAIL, CAL, CAL_EVENTS])
        bad = [
            ["--title", "X", "--source", "gmail:m"],                                   # no date or start
            ["--title", "X", "--date", "2026-11-20", "--start", "2026-11-20T10:00", "--source", "gmail:m"],
            ["--title", "X", "--start", "2026-11-20T10:00", "--source", "gmail:m"],     # no end
            ["--title", "X", "--start", "2026-11-20T11:00", "--end", "2026-11-20T10:00", "--source", "gmail:m"],
            ["--title", "", "--date", "2026-11-20", "--source", "gmail:m"],
            ["--title", "X", "--date", "2026-11-20"],                                   # no source
            ["--title", "X", "--date", "20-11-2026", "--source", "gmail:m"],
            ["--title", "X", "--start", "2026-11-20T10:00", "--end", "2026-11-20T11:00", "--tz", "Mars/Base",
             "--source", "gmail:m"],
        ]
        for args in bad:
            with self.subTest(args=args), mock.patch("urllib.request.urlopen", self.urlopen), \
                    mock.patch("sys.stderr"):
                try:
                    code = self.gcal.main(["add", *args])
                except SystemExit as exc:
                    code = exc.code
                self.assertNotEqual(code, 0)
        self.assertEqual(self.requests, [])

    def test_there_is_still_no_edit_or_delete_command(self):
        for command in ("update", "delete", "move", "accept", "respond", "invite"):
            with self.subTest(command=command), self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                self.gcal.main([command])
        source = (SCRIPTS / "gcal.py").read_text(encoding="utf-8")
        for verb in ('"PUT"', '"PATCH"', '"DELETE"', '"attendees"', "conferenceData"):
            self.assertNotIn(verb, source)

    def test_login_asks_for_owned_events_and_nothing_broader(self):
        login = importlib.reload(importlib.import_module("google_login"))
        g = self.gtasks
        granted = " ".join([TASKS, GMAIL, CAL, CAL_EVENTS])
        with mock.patch.object(g, "_client_env", return_value=("cid", "csec")), \
                mock.patch.object(g, "wait_for_code", return_value="code"), \
                mock.patch.object(g, "_post_token", return_value={
                    "access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": granted}), \
                mock.patch("builtins.print") as printed:
            login.main(["login"])
        url = printed.call_args_list[0].args[0].split("\n")[1]
        scope = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["scope"][0]
        self.assertEqual(set(scope.split()), {TASKS, GMAIL, CAL, CAL_EVENTS})
        self.assertEqual(set(g._load_token()["scopes"]), {TASKS, GMAIL, CAL, CAL_EVENTS})
        for broader in ("https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"):
            with self.subTest(broader=broader), \
                    mock.patch.object(g, "_client_env", return_value=("cid", "csec")), \
                    mock.patch.object(g, "wait_for_code", return_value="code"), \
                    mock.patch.object(g, "_post_token", return_value={
                        "access_token": "a", "refresh_token": "r", "expires_in": 3600,
                        "scope": " ".join([TASKS, GMAIL, CAL, broader])}), \
                    mock.patch("builtins.print"), self.assertRaises(SystemExit):
                login.main(["login"])


if __name__ == "__main__":
    unittest.main()
