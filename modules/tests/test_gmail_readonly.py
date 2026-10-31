"""`google login` grants one token; gmail only reads with it, gcal reads and (see test_gcal_add) only inserts."""

import base64
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


class GoogleLoginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.gtasks = importlib.reload(importlib.import_module("gtasks"))
        self.gmail = importlib.reload(importlib.import_module("gmail"))
        self.gcal = importlib.reload(importlib.import_module("gcal"))
        self.google = importlib.reload(importlib.import_module("google_login"))

    def login(self, granted):
        g = self.gtasks
        with mock.patch.object(g, "_client_env", return_value=("cid", "csec")), \
                mock.patch.object(g, "wait_for_code", return_value="code"), \
                mock.patch.object(g, "_post_token", return_value={
                    "access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": granted}), \
                mock.patch("builtins.print") as printed:
            self.google.main(["login"])
        return printed.call_args_list[0].args[0].split("\n")[1]

    def save(self, scopes=None):
        token = {"access_token": "a", "refresh_token": "r", "expiry": 9e12, "client_id": "c", "client_secret": "s"}
        if scopes is not None:
            token["scopes"] = scopes
        self.gtasks._save_token(token)

    def test_login_asks_for_exactly_tasks_read_only_mail_and_calendar_and_owned_events(self):
        url = self.login(" ".join([TASKS, GMAIL, CAL, CAL_EVENTS]))
        scope = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["scope"][0]
        self.assertEqual(set(scope.split()), {TASKS, GMAIL, CAL, CAL_EVENTS})
        token = self.gtasks._load_token()
        self.assertEqual(set(token["scopes"]), {TASKS, GMAIL, CAL, CAL_EVENTS})
        self.assertEqual((token["client_id"], token["client_secret"]), ("cid", "csec"))

    def test_login_refuses_a_token_with_any_broader_scope(self):
        with self.assertRaises(SystemExit):
            self.login(" ".join([TASKS, GMAIL, "https://www.googleapis.com/auth/gmail.send"]))
        self.assertIsNone(self.gtasks._load_token())

    def test_unticked_access_stays_off(self):
        self.login(TASKS)
        self.assertFalse(self.gmail.enabled())
        self.assertFalse(self.gcal.enabled())
        with self.assertRaises(self.gtasks.MissingScope):
            self.gmail.list_messages()

    def test_old_tasks_only_token_keeps_tasks_and_has_no_mail(self):
        self.save()
        self.assertEqual(self.gtasks.granted_scopes(), {TASKS})
        self.assertFalse(self.gmail.enabled())

    def test_refresh_uses_the_saved_client_without_env(self):
        self.gtasks._save_token({"access_token": "old", "refresh_token": "r", "expiry": 0,
                                 "client_id": "cid", "client_secret": "csec", "scopes": [GMAIL]})
        with mock.patch.dict(os.environ, {"GTASKS_CLIENT_ID": "", "GTASKS_CLIENT_SECRET": ""}), \
                mock.patch.object(self.gtasks, "_post_token",
                                  return_value={"access_token": "new", "expires_in": 3600}) as post:
            self.assertEqual(self.gtasks.token_for(GMAIL), "new")
        self.assertEqual(post.call_args.args[0]["client_id"], "cid")

    def test_gmail_and_gcal_only_issue_gets(self):
        self.save([TASKS, GMAIL, CAL])
        requests = []

        def urlopen(req, timeout=None):
            requests.append(req)
            if "/calendars/" in req.full_url:
                return _Response({"items": [{"id": "e1", "summary": "Dentist", "start": {"date": "2026-11-02"},
                                             "end": {"date": "2026-11-03"}}]})
            if "/messages/" in req.full_url:
                mid = req.full_url.split("/messages/")[1].split("?")[0]
                return _Response({"id": mid, "threadId": "t", "internalDate": {"b": "300", "a": "200", "z": "50"}[mid],
                                  "snippet": "Tom &amp; Jerry", "payload": {"headers": [{"name": "Subject", "value": mid}]}})
            return _Response({"messages": [{"id": "b"}, {"id": "a"}, {"id": "z"}]})

        with mock.patch("urllib.request.urlopen", urlopen):
            messages = self.gmail.list_messages(after_ms=100)
            events = self.gcal.list_events(7)
        self.assertEqual([m["id"] for m in messages], ["a", "b"])  # oldest first, older than cursor dropped
        self.assertEqual(messages[0]["snippet"], "Tom & Jerry")
        self.assertEqual(events[0]["start"], "2026-11-02")
        self.assertIn("singleEvents=true", requests[-1].full_url)
        self.assertEqual({r.get_method() for r in requests}, {"GET"})

    def test_message_text_prefers_plain_and_falls_back_to_stripped_html(self):
        enc = lambda text: base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")
        both = {"mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": enc("plain body")}},
            {"mimeType": "text/html", "body": {"data": enc("<b>rich</b>")}}]}
        self.assertEqual(self.gmail.message_text(both), "plain body")
        html_only = {"mimeType": "text/html", "body": {"data": enc("<p>Pay&nbsp;by <b>Friday</b></p>")}}
        self.assertEqual(self.gmail.message_text(html_only), "Pay by Friday")

    def test_read_clis_have_no_write_or_login_commands(self):
        self.assertNotIn('method="POST"', (SCRIPTS / "gmail.py").read_text(encoding="utf-8"))
        # gcal's one POST is the event insert in _insert(); test_gcal_add covers it.
        self.assertEqual((SCRIPTS / "gcal.py").read_text(encoding="utf-8").count('method="POST"'), 1)
        for cli, commands in ((self.gmail, ("send", "trash", "delete", "modify", "login")),
                              (self.gcal, ("create", "delete", "update", "login")),
                              (self.gtasks, ("login", "logout"))):
            for command in commands:
                with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
                    cli.main([command])


if __name__ == "__main__":
    unittest.main()
