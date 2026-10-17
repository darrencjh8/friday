"""Unit tests for reminders-server.py (stdlib only, ephemeral port)."""

import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

SERVER = Path(__file__).parents[1] / "hermes" / "scripts" / "reminders-server.py"

HABITS_DOC = """---
title: Daily habits
---

# Daily habits

## Daily candidates

| Candidate key | Title | action_date | type | Note |
|---|---|---|---|---|
| `habit-water` | Drink water | today | daily | |
| `habit-make-bed` | Make bed | today | daily | |

## Monthly candidate

| Candidate key | Title | Recurrence | type | Note |
|---|---|---|---|---|
| `monthly-clean-room` | Clean room | 1st of each month | monthly | Subtasks |
"""


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


class HabitsEditTests(unittest.TestCase):
    """Wiki-backed daily-habit editing (issue #18)."""

    TOKEN = "test-token-0123456789abcdef"

    def serve(self, doc=HABITS_DOC, token=TOKEN):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        snap = root / "reminders.json"
        snap.write_text(json.dumps({"items": [], "problems": []}))
        habits = root / "daily-habits.md"
        if doc is not None:
            habits.write_text(doc)
        module, server = load_server(snap)
        module.HABITS = str(habits)
        module.EDIT_TOKEN = token
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return ("http://127.0.0.1:%d" % server.server_address[1],
                module, habits)

    def get(self, base, path):
        with urllib.request.urlopen(base + path, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())

    def post(self, base, payload, token=TOKEN, raw=None):
        data = raw if raw is not None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + "/api/habits", data=data,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode()
            try:
                return exc.code, json.loads(body)
            except ValueError:
                return exc.code, {}

    def test_get_habits_lists_rows_open(self):
        base, _, _ = self.serve()
        status, body = self.get(base, "/api/habits")
        self.assertEqual(status, 200)
        keys = [h["key"] for h in body["habits"]]
        self.assertEqual(keys, ["habit-water", "habit-make-bed"])
        self.assertEqual(body["habits"][0]["title"], "Drink water")

    def test_get_habits_missing_file_is_empty(self):
        base, _, _ = self.serve(doc=None)
        status, body = self.get(base, "/api/habits")
        self.assertEqual(status, 200)
        self.assertEqual(body["habits"], [])

    def test_get_habits_missing_section_500(self):
        base, _, _ = self.serve(doc="# Daily habits\n\nno table here\n")
        try:
            self.get(base, "/api/habits")
            self.fail("expected HTTPError")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 500)

    def test_edit_needs_token(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "title": "x"},
                              token=None)
        self.assertEqual(status, 401)

    def test_edit_disabled_without_token_env(self):
        base, _, _ = self.serve(token="")
        status, _ = self.post(base, {"action": "add", "title": "x"})
        self.assertEqual(status, 403)

    def test_edit_wrong_token_403(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "title": "x"},
                              token="wrong")
        self.assertEqual(status, 403)

    def test_auth_before_body_read(self):
        # No token + oversize body must answer 401, not 413: auth first.
        base, _, _ = self.serve()
        status, _ = self.post(base, None, token=None, raw=b"x" * 20000)
        self.assertEqual(status, 401)

    def test_oversize_body_413(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, None, raw=b"x" * 20000)
        self.assertEqual(status, 413)

    def test_malformed_json_400(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, None, raw=b"{truncated")
        self.assertEqual(status, 400)

    def test_post_unknown_path_404(self):
        base, _, _ = self.serve()
        req = urllib.request.Request(base + "/nope", data=b"{}",
                                     method="POST")
        try:
            urllib.request.urlopen(req, timeout=10)
            self.fail("expected HTTPError")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 404)

    def test_add_habit_inserts_row(self):
        base, _, habits = self.serve()
        status, body = self.post(
            base, {"action": "add", "title": "Read 10 pages",
                   "note": "before bed"})
        self.assertEqual(status, 200)
        keys = [h["key"] for h in body["habits"]]
        self.assertIn("habit-read-10-pages", keys)
        text = habits.read_text()
        self.assertIn("| `habit-read-10-pages` | Read 10 pages | today |"
                      " daily | before bed |", text)
        # Monthly section preserved byte-for-byte.
        self.assertIn("| `monthly-clean-room` | Clean room |"
                      " 1st of each month | monthly | Subtasks |", text)

    def test_add_rejects_table_delimiters(self):
        base, _, habits = self.serve()
        before = habits.read_text()
        for bad in ("a|b", "a`b", "a\nb", "a\rb"):
            status, _ = self.post(base, {"action": "add", "title": bad})
            self.assertEqual(status, 400, bad)
        status, _ = self.post(base, {"action": "add", "title": "ok",
                                     "note": "x|y"})
        self.assertEqual(status, 400)
        self.assertEqual(habits.read_text(), before)

    def test_add_rejects_overlong(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "title": "t" * 121})
        self.assertEqual(status, 400)
        status, _ = self.post(base, {"action": "add", "title": "ok",
                                     "note": "n" * 501})
        self.assertEqual(status, 400)

    def test_add_rejects_duplicate_key(self):
        base, _, habits = self.serve()
        before = habits.read_text()
        status, _ = self.post(base, {"action": "add",
                                     "title": "Make bed"})
        self.assertEqual(status, 400)
        self.assertEqual(habits.read_text(), before)

    def test_add_rejects_bare_prefix_key(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "title": "!!!"})
        self.assertEqual(status, 400)

    def test_remove_habit_drops_row(self):
        base, _, habits = self.serve()
        status, body = self.post(base, {"action": "remove",
                                        "key": "habit-water"})
        self.assertEqual(status, 200)
        self.assertNotIn("habit-water",
                         [h["key"] for h in body["habits"]])
        text = habits.read_text()
        self.assertNotIn("habit-water", text)
        self.assertIn("habit-make-bed", text)

    def test_remove_unknown_key_404(self):
        base, _, habits = self.serve()
        before = habits.read_text()
        status, _ = self.post(base, {"action": "remove", "key": "habit-nope"})
        self.assertEqual(status, 404)
        self.assertEqual(habits.read_text(), before)

    def test_malformed_row_preserved_on_write(self):
        doc = HABITS_DOC.replace(
            "| `habit-make-bed` | Make bed | today | daily | |",
            "| broken row missing columns |\n"
            "| `habit-make-bed` | Make bed | today | daily | |")
        base, _, habits = self.serve(doc=doc)
        status, _ = self.post(base, {"action": "add", "title": "Stretch"})
        self.assertEqual(status, 200)
        self.assertIn("| broken row missing columns |", habits.read_text())

    def test_write_missing_section_500_no_write(self):
        base, _, habits = self.serve(doc="# Daily habits\n\nno table\n")
        before = habits.read_text()
        status, _ = self.post(base, {"action": "add", "title": "Stretch"})
        self.assertEqual(status, 500)
        self.assertEqual(habits.read_text(), before)


if __name__ == "__main__":
    unittest.main()
