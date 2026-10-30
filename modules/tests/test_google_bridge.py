"""The bridge client only issues GETs and never leaks the bridge URL or key."""

import base64
import importlib.util
import io
import json
import os
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "hermes" / "scripts" / "google_bridge.py"
APPS_SCRIPT = Path(__file__).parents[1] / "hermes" / "apps-script" / "friday-bridge"
ENV = {"FRIDAY_BRIDGE_URL": "https://script.example.com/exec", "FRIDAY_BRIDGE_KEY": "k" * 40}


def load():
    spec = importlib.util.spec_from_file_location("google_bridge_module", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reply(payload):
    return io.BytesIO(json.dumps(payload).encode())


def enc(text):
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


class GoogleBridgeTest(unittest.TestCase):
    def setUp(self):
        self.bridge = load()
        patcher = mock.patch.dict(os.environ, ENV)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_calls_are_gets_with_the_key_and_command(self):
        requests = []

        def urlopen(req, timeout=None):
            requests.append(req)
            return reply({"messages": [{"id": "a", "snippet": "Tom &amp; Jerry"}]})

        with mock.patch("urllib.request.urlopen", urlopen):
            messages = self.bridge.list_messages(after_ms=100, limit=5)
        self.assertEqual(messages[0]["snippet"], "Tom & Jerry")
        query = urllib.parse.parse_qs(urllib.parse.urlparse(requests[0].full_url).query)
        self.assertEqual(query, {"key": ["k" * 40], "cmd": ["mail"], "after": ["100"], "limit": ["5"]})
        self.assertEqual(requests[0].get_method(), "GET")

    def test_errors_never_carry_the_url_or_key(self):
        failure = urllib.error.URLError("boom " + ENV["FRIDAY_BRIDGE_URL"] + "?key=" + ENV["FRIDAY_BRIDGE_KEY"])
        with mock.patch("urllib.request.urlopen", side_effect=failure):
            with self.assertRaises(self.bridge.BridgeError) as caught:
                self.bridge.list_events()
        self.assertNotIn(ENV["FRIDAY_BRIDGE_KEY"], str(caught.exception))
        self.assertNotIn("script.example.com", str(caught.exception))

    def test_a_refusal_is_an_error(self):
        with mock.patch("urllib.request.urlopen", return_value=reply({"error": "forbidden"})):
            with self.assertRaisesRegex(self.bridge.BridgeError, "forbidden"):
                self.bridge.list_events()

    def test_unconfigured_bridge_is_not_called(self):
        with mock.patch.dict(os.environ, {"FRIDAY_BRIDGE_KEY": ""}), \
                mock.patch("urllib.request.urlopen") as urlopen:
            self.assertFalse(self.bridge.configured())
            with self.assertRaises(self.bridge.BridgeError):
                self.bridge.list_events()
        urlopen.assert_not_called()

    def test_read_prefers_plain_text_and_falls_back_to_stripped_html(self):
        headers = [{"name": "Subject", "value": "Rent"}]
        both = {"headers": headers, "mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": enc("plain body")}},
            {"mimeType": "text/html", "body": {"data": enc("<b>rich</b>")}}]}
        with mock.patch("urllib.request.urlopen", return_value=reply({"message": {"payload": both}})):
            text = self.bridge.read_message("abc")
        self.assertIn("Subject: Rent", text)
        self.assertTrue(text.endswith("plain body"))
        html_only = {"mimeType": "text/html", "body": {"data": enc("<p>Pay&nbsp;by <b>Friday</b></p>")}}
        self.assertEqual(self.bridge.message_text(html_only), "Pay by Friday")

    def test_bridge_scopes_are_read_only(self):
        manifest = json.loads((APPS_SCRIPT / "appsscript.json").read_text())
        self.assertEqual(sorted(manifest["oauthScopes"]), [
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/gmail.readonly"])
        self.assertNotIn("POST", SCRIPT.read_text())
        self.assertNotIn("doPost", (APPS_SCRIPT / "Code.gs").read_text())


if __name__ == "__main__":
    unittest.main()
