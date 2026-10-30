"""The gmail CLI only ever holds a gmail.readonly token and only issues GETs."""

import base64
import importlib.util
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


def load_gmail():
    spec = importlib.util.spec_from_file_location("gmail_module", SCRIPTS / "gmail.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READONLY = "https://www.googleapis.com/auth/gmail.readonly"


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class GmailReadOnlyTest(unittest.TestCase):
    def setUp(self):
        self.gmail = load_gmail()
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def login(self, granted_scope):
        g = self.gmail
        with mock.patch.object(g.gtasks, "_client_env", return_value=("cid", "csec")), \
                mock.patch.object(g.gtasks, "wait_for_code", return_value="code") as wait, \
                mock.patch.object(g.gtasks, "_post_token", return_value={
                    "access_token": "a", "refresh_token": "r", "expires_in": 3600, "scope": granted_scope}), \
                mock.patch("builtins.print") as printed:
            rc = g.main(["login"])
        url = printed.call_args_list[0].args[0].split("\n")[1]
        return rc, url, wait

    def test_login_asks_google_for_only_the_readonly_scope(self):
        rc, url, wait = self.login(READONLY)
        self.assertEqual(rc, 0)
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["scope"], [READONLY])
        self.assertEqual(wait.call_args.kwargs["paths"], ("/callback", "/gmail/callback"))
        token = self.gmail.load_token()
        self.assertEqual((token["client_id"], token["client_secret"], token["refresh_token"]), ("cid", "csec", "r"))

    def test_login_refuses_a_token_with_any_broader_scope(self):
        with self.assertRaises(SystemExit):
            self.login(READONLY + " https://www.googleapis.com/auth/gmail.send")
        self.assertIsNone(self.gmail.load_token())

    def test_refresh_uses_the_saved_client_without_env(self):
        self.gmail._save_token({"access_token": "old", "refresh_token": "r", "expiry": 0,
                                "client_id": "cid", "client_secret": "csec"})
        with mock.patch.object(self.gmail.gtasks, "_post_token",
                               return_value={"access_token": "new", "expires_in": 3600}) as post:
            self.assertEqual(self.gmail._valid_token()["access_token"], "new")
        self.assertEqual(post.call_args.args[0]["client_id"], "cid")

    def test_every_request_is_a_get(self):
        self.gmail._save_token({"access_token": "a", "refresh_token": "r", "expiry": 9e12,
                                "client_id": "c", "client_secret": "s"})
        requests = []

        def urlopen(req, timeout=None):
            requests.append(req)
            if "/messages/" in req.full_url:
                mid = req.full_url.split("/messages/")[1].split("?")[0]
                return _Response({"id": mid, "threadId": "t", "internalDate": {"b": "300", "a": "200",
                                                                               "z": "50"}[mid],
                                  "snippet": "Tom &amp; Jerry", "labelIds": ["INBOX"],
                                  "payload": {"headers": [{"name": "Subject", "value": "Hi " + mid}]}})
            return _Response({"messages": [{"id": "b"}, {"id": "a"}, {"id": "z"}]})

        with mock.patch("urllib.request.urlopen", urlopen):
            messages = self.gmail.list_messages(after_ms=100)
        self.assertEqual([m["id"] for m in messages], ["a", "b"])  # oldest first, older than cursor dropped
        self.assertEqual(messages[0]["snippet"], "Tom & Jerry")
        self.assertIn("after:0", urllib.parse.unquote_plus(requests[0].full_url))
        self.assertEqual({r.get_method() for r in requests}, {"GET"})

    def test_message_text_prefers_plain_and_falls_back_to_stripped_html(self):
        enc = lambda text: base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")
        both = {"mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": enc("plain body")}},
            {"mimeType": "text/html", "body": {"data": enc("<b>rich</b>")}}]}
        self.assertEqual(self.gmail.message_text(both), "plain body")
        html_only = {"mimeType": "text/html", "body": {"data": enc("<p>Pay&nbsp;by <b>Friday</b></p>")}}
        self.assertEqual(self.gmail.message_text(html_only), "Pay by Friday")

    def test_cli_has_no_write_commands(self):
        source = (SCRIPTS / "gmail.py").read_text(encoding="utf-8")
        self.assertNotIn("method=\"POST\"", source)
        for command in ("send", "trash", "delete", "modify", "archive"):
            with self.assertRaises(SystemExit):
                with mock.patch("sys.stderr"):
                    self.gmail.main([command])


if __name__ == "__main__":
    unittest.main()
