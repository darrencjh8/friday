"""`gcal add` creates one event on the app-created "Friday" calendar, and nothing else.

The login gains calendar.app.created, so Google itself refuses any change to the
user's own calendars and events. The CLI only inserts: no attendees, no
invites, no links in event text, one event per source message.
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
CAL_APP = "https://www.googleapis.com/auth/calendar.app.created"
ALL = [TASKS, GMAIL, CAL, CAL_APP]
FRI = "fri123@group.calendar.google.com"
FRI_EVENTS = "/calendar/v3/calendars/" + urllib.parse.quote(FRI, safe="") + "/events"
PRIMARY_EVENTS = "/calendar/v3/calendars/primary/events"


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
        self.calendars = []      # calendarList items
        self.primary = []        # events on the user's primary calendar
        self.friday = []         # events on the Friday calendar

    def save(self, scopes):
        self.gtasks._save_token({"access_token": "a", "refresh_token": "r", "expiry": 9e12,
                                 "client_id": "c", "client_secret": "s", "scopes": scopes})

    def urlopen(self, req, timeout=None):
        self.requests.append(req)
        url = urllib.parse.urlparse(req.full_url)
        query = urllib.parse.parse_qs(url.query)
        if req.get_method() == "POST":
            if url.path.endswith("/calendar/v3/calendars"):
                return _Response({"id": FRI, "summary": "Friday"})
            return _Response({"id": "new1", "htmlLink": "https://calendar.google.com/event?eid=new1"})
        if url.path.endswith("/users/me/calendarList"):
            return _Response({"items": self.calendars})
        items = self.primary if url.path.endswith(PRIMARY_EVENTS) else self.friday
        if "privateExtendedProperty" in query:
            wanted = query["privateExtendedProperty"][0].split("=", 1)[1]
            items = [e for e in items if e.get("extendedProperties", {}).get("private", {})
                     .get("friday_source") == wanted]
        return _Response({"items": items})

    def add(self, *args):
        with mock.patch("urllib.request.urlopen", self.urlopen), \
                mock.patch("builtins.print") as printed:
            code = self.gcal.main(["add", *args])
        out = json.loads(printed.call_args.args[0]) if printed.call_args else None
        return code, out

    def posts(self, path_end=None):
        return [r for r in self.requests if r.get_method() == "POST"
                and (path_end is None or urllib.parse.urlparse(r.full_url).path.endswith(path_end))]

    def test_first_add_creates_the_friday_calendar_once_and_inserts_there(self):
        self.save(ALL)
        code, out = self.add("--title", "Dental: Example Clinic", "--start", "2026-11-05T10:00",
                             "--end", "2026-11-05T11:00", "--tz", "Asia/Singapore",
                             "--location", "1 Example Road", "--description", "Booking ABC123",
                             "--source", "gmail:m1")
        self.assertEqual((code, out["status"], out["id"], out["calendar"]), (0, "created", "new1", "Friday"))
        [made] = self.posts("/calendar/v3/calendars")
        self.assertEqual(json.loads(made.data)["summary"], "Friday")
        [post] = self.posts(FRI_EVENTS)
        url = urllib.parse.urlparse(post.full_url)
        self.assertEqual(urllib.parse.parse_qs(url.query)["sendUpdates"], ["none"])
        body = json.loads(post.data)
        self.assertEqual(body["summary"], "Dental: Example Clinic")
        self.assertEqual(body["start"], {"dateTime": "2026-11-05T10:00:00", "timeZone": "Asia/Singapore"})
        self.assertEqual(body["end"], {"dateTime": "2026-11-05T11:00:00", "timeZone": "Asia/Singapore"})
        self.assertEqual(body["location"], "1 Example Road")
        self.assertTrue(body["description"].startswith("Added by Friday from email (gmail:m1)."))
        self.assertIn("Booking ABC123", body["description"])
        self.assertEqual(body["extendedProperties"], {"private": {"friday_source": "gmail:m1"}})
        self.assertNotIn("attendees", body)
        self.assertNotIn("conferenceData", body)
        self.assertEqual(len(self.posts()), 2)  # the calendar, then the event; nothing on primary
        self.assertEqual(self.posts(PRIMARY_EVENTS), [])
        # Second add reuses the saved calendar id: no new calendar.
        self.requests.clear()
        self.add("--title", "Other", "--date", "2026-11-09", "--source", "gmail:m9")
        self.assertEqual(self.posts("/calendar/v3/calendars"), [])
        self.assertEqual(len(self.posts(FRI_EVENTS)), 1)

    def test_an_existing_friday_calendar_is_found_by_its_marker_not_recreated(self):
        self.save(ALL)
        self.calendars = [{"id": "someone@group", "summary": "Friday", "description": "a calendar the user made"},
                          {"id": FRI, "summary": "Friday", "description": self.gcal.FRIDAY_MARKER}]
        code, out = self.add("--title", "Pay card bill", "--date", "2026-11-20", "--source", "gmail:m2")
        self.assertEqual((code, out["status"]), (0, "created"))
        self.assertEqual(self.posts("/calendar/v3/calendars"), [])
        self.assertEqual(len(self.posts(FRI_EVENTS)), 1)

    def test_add_all_day_due_date_with_popup_reminder(self):
        self.save(ALL)
        code, out = self.add("--title", "Pay card bill", "--date", "2026-11-20",
                             "--reminder-minutes", "1440", "--source", "gmail:m2")
        self.assertEqual((code, out["status"]), (0, "created"))
        body = json.loads(self.posts(FRI_EVENTS)[0].data)
        self.assertEqual(body["start"], {"date": "2026-11-20"})
        self.assertEqual(body["end"], {"date": "2026-11-21"})
        self.assertEqual(body["reminders"], {"useDefault": False,
                                             "overrides": [{"method": "popup", "minutes": 1440}]})

    def test_links_are_stripped_from_event_text(self):
        self.save(ALL)
        self.add("--title", "Verify at https://phish.example/x now", "--date", "2026-11-20",
                 "--location", "www.phish.example", "--description", "Click http://phish.example/login",
                 "--source", "gmail:m5")
        body = json.loads(self.posts(FRI_EVENTS)[0].data)
        text = json.dumps(body)
        self.assertNotIn("phish.example", text)
        self.assertIn("[link removed]", body["summary"])

    def test_same_source_message_is_never_added_twice(self):
        self.save(ALL)
        self.friday = [{"id": "old1", "summary": "Anything", "htmlLink": "https://calendar.google.com/event?eid=old1",
                        "start": {"date": "2026-11-20"},
                        "extendedProperties": {"private": {"friday_source": "gmail:m2"}}}]
        code, out = self.add("--title", "Pay card bill", "--date", "2026-11-20", "--source", "gmail:m2")
        self.assertEqual((code, out["status"], out["id"]), (0, "exists", "old1"))
        self.assertEqual(self.posts(FRI_EVENTS), [])

    def test_same_title_within_a_day_on_primary_counts_as_existing(self):
        self.save(ALL)
        self.primary = [{"id": "manual1", "summary": "dental:  example clinic ",
                         "htmlLink": "https://calendar.google.com/event?eid=manual1",
                         "start": {"dateTime": "2026-11-05T09:30:00+08:00"}}]
        code, out = self.add("--title", "Dental: Example Clinic", "--start", "2026-11-05T10:00",
                             "--end", "2026-11-05T11:00", "--source", "gmail:m3")
        self.assertEqual((code, out["status"], out["id"]), (0, "exists", "manual1"))
        self.assertEqual(self.posts(FRI_EVENTS), [])
        window = [urllib.parse.parse_qs(urllib.parse.urlparse(r.full_url).query) for r in self.requests
                  if urllib.parse.urlparse(r.full_url).path.endswith(PRIMARY_EVENTS)]
        self.assertEqual(window[0]["timeMin"], ["2026-11-04T10:00:00+08:00"])
        self.assertEqual(window[0]["timeMax"], ["2026-11-06T10:00:00+08:00"])
        self.assertEqual(window[0]["maxResults"], ["2500"])

    def test_all_day_window_is_one_day_either_side_of_noon_singapore(self):
        self.save(ALL)
        self.add("--title", "Pay card bill", "--date", "2026-11-20", "--source", "gmail:m6")
        window = [urllib.parse.parse_qs(urllib.parse.urlparse(r.full_url).query) for r in self.requests
                  if urllib.parse.urlparse(r.full_url).path.endswith(PRIMARY_EVENTS)][0]
        self.assertEqual((window["timeMin"], window["timeMax"]),
                         (["2026-11-19T12:00:00+08:00"], ["2026-11-21T12:00:00+08:00"]))

    def test_add_needs_the_new_login(self):
        for scopes in ([TASKS, GMAIL, CAL], [TASKS, GMAIL, CAL_APP]):
            with self.subTest(scopes=scopes):
                self.save(scopes)
                with mock.patch("urllib.request.urlopen", self.urlopen), mock.patch("sys.stderr"):
                    code = self.gcal.main(["add", "--title", "X", "--date", "2026-11-20", "--source", "gmail:m4"])
                self.assertEqual(code, self.gmail.EXIT_AUTH_EXPIRED)
                self.assertEqual(self.requests, [])

    def test_add_rejects_bad_input_before_any_request(self):
        self.save(ALL)
        bad = [
            ["--title", "X", "--source", "gmail:m"],                                   # no date or start
            ["--title", "X", "--date", "2026-11-20", "--start", "2026-11-20T10:00", "--source", "gmail:m"],
            ["--title", "X", "--start", "2026-11-20T10:00", "--source", "gmail:m"],     # no end
            ["--title", "X", "--start", "2026-11-20T11:00", "--end", "2026-11-20T10:00", "--source", "gmail:m"],
            ["--title", "", "--date", "2026-11-20", "--source", "gmail:m"],
            ["--title", "X", "--date", "2026-11-20"],                                   # no source
            ["--title", "X", "--date", "2026-11-20", "--source", "web:abc"],            # not a mail source
            ["--title", "X", "--date", "20-11-2026", "--source", "gmail:m"],
            ["--title", "X", "--date", "2026-11-20", "--reminder-minutes", "-5", "--source", "gmail:m"],
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
        self.assertEqual(source.count('method="POST"'), 1)

    def test_login_asks_for_app_created_and_nothing_broader(self):
        login = importlib.reload(importlib.import_module("google_login"))
        g = self.gtasks
        with mock.patch.object(g, "_client_env", return_value=("cid", "csec")), \
                mock.patch.object(g, "wait_for_code", return_value="code"), \
                mock.patch.object(g, "_post_token", return_value={
                    "access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": " ".join(ALL)}), \
                mock.patch("builtins.print") as printed:
            login.main(["login"])
        url = printed.call_args_list[0].args[0].split("\n")[1]
        scope = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["scope"][0]
        self.assertEqual(set(scope.split()), set(ALL))
        self.assertEqual(set(g._load_token()["scopes"]), set(ALL))
        for broader in ("https://www.googleapis.com/auth/calendar",
                        "https://www.googleapis.com/auth/calendar.events",
                        "https://www.googleapis.com/auth/calendar.events.owned"):
            with self.subTest(broader=broader), \
                    mock.patch.object(g, "_client_env", return_value=("cid", "csec")), \
                    mock.patch.object(g, "wait_for_code", return_value="code"), \
                    mock.patch.object(g, "_post_token", return_value={
                        "access_token": "a", "refresh_token": "r", "expires_in": 3600,
                        "scope": " ".join(ALL + [broader])}), \
                    mock.patch("builtins.print"), self.assertRaises(SystemExit):
                login.main(["login"])


if __name__ == "__main__":
    unittest.main()
