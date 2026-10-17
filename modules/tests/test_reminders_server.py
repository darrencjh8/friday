"""Unit tests for reminders-server.py (stdlib only, ephemeral port)."""

import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import HTTPServer
from pathlib import Path

SERVER = Path(__file__).parents[1] / "hermes" / "scripts" / "reminders-server.py"


def load_server(snapshot_path, port=0):
    spec = importlib.util.spec_from_file_location("reminders_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SNAPSHOT = str(snapshot_path)
    server = HTTPServer(("127.0.0.1", port), module.Handler)
    return module, server


class ServerTests(unittest.TestCase):
    def serve(self, snapshot):
        tmp = tempfile.TemporaryDirectory()
        path = Path(tmp.name) / "reminders.json"
        path.write_text(json.dumps(snapshot))
        module, server = load_server(path)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        self.addCleanup(tmp.cleanup)
        return "http://127.0.0.1:%d" % server.server_address[1]

    def get(self, base, path):
        with urllib.request.urlopen(base + path, timeout=10) as resp:
            return resp.status, resp.read().decode()

    def test_health_and_index(self):
        base = self.serve({"items": [], "problems": [],
                           "run_date": "2026-10-16",
                           "summary": {"created": 0, "skipped": 0,
                                       "pending": 0}})
        status, body = self.get(base, "/health")
        self.assertEqual(status, 200)
        self.assertIn("true", body)
        status, body = self.get(base, "/")
        self.assertEqual(status, 200)
        self.assertIn("<title>Reminders</title>", body)

    def test_api_returns_snapshot(self):
        snap = {"run_date": "2026-10-16", "items": [
            {"key": "habit-water", "type": "daily", "title": "Drink water",
             "action_date": "2026-10-16", "days_left": 0, "lead_days": 0,
             "status": "created", "note": ""}],
            "problems": [], "summary": {"created": 1, "skipped": 0,
                                        "pending": 0}}
        base = self.serve(snap)
        status, body = self.get(base, "/api/reminders")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["items"][0]["key"], "habit-water")

    def test_missing_snapshot_is_empty_state(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        module, server = load_server(Path(tmp.name) / "absent.json")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        base = "http://127.0.0.1:%d" % server.server_address[1]
        status, body = self.get(base, "/api/reminders")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["items"], [])

    def test_unknown_path_404(self):
        base = self.serve({"items": []})
        try:
            self.get(base, "/nope")
            self.fail("expected HTTPError")
        except Exception as exc:
            self.assertIn("404", str(exc))

    def test_titles_never_rendered_as_html(self):
        # Task titles/notes are untrusted data; the page must build DOM
        # with textContent, never innerHTML.
        source = SERVER.read_text()
        self.assertNotIn("innerHTML", source)
        self.assertIn("textContent", source)

    def test_corrupt_snapshot_serves_flagged_empty_state(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        bad = Path(tmp.name) / "reminders.json"
        bad.write_text("{truncated")
        module, server = load_server(bad)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        base = "http://127.0.0.1:%d" % server.server_address[1]
        status, body = self.get(base, "/api/reminders")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["items"], [])
        self.assertTrue(payload["problems"],
                        "corrupt snapshot must not look like never-ran")


if __name__ == "__main__":
    unittest.main()
