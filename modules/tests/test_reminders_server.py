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

FULL_DOC = HABITS_DOC.replace(
    "## Monthly candidate",
    """## Weekly candidates

| Candidate key | Title | Recurrence | type | Note |
|---|---|---|---|---|
| `weekly-laundry` | Do laundry | Sunday | weekly | |

## Monthly candidate""")


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
        keys = [h["key"] for h in body["daily"]]
        self.assertEqual(keys, ["habit-water", "habit-make-bed"])
        self.assertEqual(body["daily"][0]["title"], "Drink water")
        self.assertEqual([h["key"] for h in body["monthly"]],
                         ["monthly-clean-room"])
        self.assertEqual(body["monthly"][0]["when"], "1st of each month")
        self.assertEqual(body["weekly"], [])

    def test_get_habits_missing_file_is_empty(self):
        base, _, _ = self.serve(doc=None)
        status, body = self.get(base, "/api/habits")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"daily": [], "weekly": [], "monthly": []})

    def test_get_habits_missing_sections_read_empty(self):
        # Absent headings read as empty arrays (writes stay fail-closed).
        base, _, _ = self.serve(doc="# Daily habits\n\nno table here\n")
        status, body = self.get(base, "/api/habits")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"daily": [], "weekly": [], "monthly": []})

    def test_api_base_relative_to_mount(self):
        # Served under a path prefix (tailscale --set-path /reminders), so
        # absolute fetch("/api/...") would escape the mount and 404.
        source = SERVER.read_text()
        self.assertNotIn('fetch("/', source)
        self.assertIn("location.pathname", source)

    def test_no_store_header(self):
        base, _, _ = self.serve()
        with urllib.request.urlopen(base + "/", timeout=10) as resp:
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store")

    def test_edit_action_updates_row_in_place(self):
        base, _, hab = self.serve()
        self.post(base, {"action": "add", "section": "daily",
                         "title": "Take pills", "note": "with lunch"})
        status, body = self.get(base, "/api/habits")
        before = [h["key"] for h in body["daily"]]
        self.assertEqual(before[-1], "habit-take-pills")
        status, _ = self.post(base, {
            "action": "edit", "section": "daily",
            "key": "habit-take-pills",
            "title": "Take medicine", "note": "with breakfast"})
        self.assertEqual(status, 200)
        text = hab.read_text()
        self.assertIn("`habit-take-medicine`", text)
        self.assertIn("| Take medicine | today | daily | with breakfast |",
                      text)
        self.assertNotIn("Take pills", text)
        status, body = self.get(base, "/api/habits")
        keys = [h["key"] for h in body["daily"]]
        self.assertEqual(keys[-1], "habit-take-medicine")
        self.assertEqual(len(keys), len(before))
        # Same auth as add/remove.
        status, _ = self.post(base, {"action": "edit", "section": "daily",
                                     "key": "habit-take-medicine",
                                     "title": "X"}, token=None)
        self.assertEqual(status, 401)

    def test_edit_validation(self):
        base, _, hab = self.serve()
        # Unchanged title (note-only edit) succeeds: the collision check
        # must exclude the edited row itself.
        status, _ = self.post(base, {
            "action": "edit", "section": "daily", "key": "habit-water",
            "title": "Drink water", "note": "big glass"})
        self.assertEqual(status, 200)
        text = hab.read_text()
        self.assertIn("big glass", text)
        # Key stability: an unchanged title keeps the row's original key.
        self.assertIn("`habit-water`", text)
        # Unknown key.
        status, _ = self.post(base, {"action": "edit", "section": "daily",
                                     "key": "habit-nope", "title": "X"})
        self.assertEqual(status, 404)
        # Monthly edit requires when.
        status, _ = self.post(base, {"action": "edit", "section": "monthly",
                                     "key": "monthly-clean-room",
                                     "title": "Clean room", "note": ""})
        self.assertEqual(status, 400)
        # Bad chars.
        status, _ = self.post(base, {"action": "edit", "section": "daily",
                                     "key": "habit-water",
                                     "title": "Drink | water"})
        self.assertEqual(status, 400)
        # Duplicate of another row.
        status, _ = self.post(base, {"action": "edit", "section": "daily",
                                     "key": "habit-water",
                                     "title": "Make bed"})
        self.assertEqual(status, 400)
        self.assertIn("already exists",
                      self.post(base, {"action": "edit", "section": "daily",
                                       "key": "habit-water",
                                       "title": "Make bed"})[1]["error"])

    def test_edit_ui_and_mobile_scale_hooks(self):
        source = SERVER.read_text()
        self.assertIn("dataset.editingKey", source)
        self.assertIn('id="h-cancel"', source)
        self.assertIn("Saved.", source)
        self.assertIn('"add"|"edit"|"remove"', source)
        self.assertIn("table.snapshot", source)
        # Mobile scale: body override inside the media query, inputs
        # excluded (16px zoom guard), form stacks full-width.
        media = source.split("@media (max-width:600px)", 1)[1]
        self.assertIn("body{font:15px", media)
        self.assertIn("table{font-size:13px", media)
        # The override must be .f1/.f2-qualified to win the cascade
        # against #h-form .f1{flex:1;...} above it.
        seg = media.split("#h-form .f1", 1)[1]
        self.assertIn("flex:1 1 100%", seg.split("}", 1)[0])

    def test_add_form_and_feedback_hooks(self):
        # UX hooks the editor relies on; static because JS behavior is
        # not unit-testable here.
        source = SERVER.read_text()
        self.assertIn('id="h-form"', source)          # Enter-to-add form
        self.assertIn("Saving…", source)              # busy state
        self.assertIn("Added", source)                # success feedback
        self.assertIn('id="h-token-details"', source)  # auto-open on 401/403
        self.assertIn(".open = true", source)
        self.assertIn('id="h-count-daily"', source)   # count badges
        self.assertIn("max-width:600px", source)      # mobile padding

    def test_chips_and_button_style_hooks(self):
        source = SERVER.read_text()
        self.assertIn("chip", source)
        self.assertIn("btn-primary", source)
        self.assertIn("btn-quiet", source)
        # Round-1 review: no color-mix anywhere (older mobile would
        # silently drop it); tabs must survive CSS display rules.
        self.assertNotIn("color-mix", source)
        self.assertIn("[hidden]{display:none!important}", source)
        self.assertIn("position:sticky", source)
        self.assertLess(source.index("position:sticky"),
                        source.index("<main>"))

    def test_snapshot_grouping_hooks(self):
        # Pending/done partition + captions + tab bar wired in PAGE.
        source = SERVER.read_text()
        self.assertIn("Needs attention", source)
        self.assertIn("Done", source)
        self.assertIn("data-section", source)
        self.assertIn("switchTab(", source)
        self.assertIn('type="submit"', source)

    def test_meta_line_above_snapshot(self):
        # The run line describes the snapshot, so it must render after
        # the habits card (after the token block) and before the snapshot
        # table headers.
        source = SERVER.read_text()
        self.assertGreater(source.index('id="meta"'),
                           source.index('id="h-token-details"'))
        self.assertLess(source.index('id="meta"'),
                        source.index('id="rows"'))

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
        keys = [h["key"] for h in body["daily"]]
        self.assertIn("habit-read-10-pages", keys)
        text = habits.read_text()
        self.assertIn("| `habit-read-10-pages` | Read 10 pages | today |"
                      " daily | before bed |", text)
        # Monthly section preserved byte-for-byte.
        self.assertIn("| `monthly-clean-room` | Clean room |"
                      " 1st of each month | monthly | Subtasks |", text)

    def test_add_weekly_round_trip(self):
        base, _, habits = self.serve(doc=FULL_DOC)
        status, body = self.post(
            base, {"action": "add", "section": "weekly",
                   "title": "Water plants", "when": "Sunday",
                   "note": "balcony too"})
        self.assertEqual(status, 200)
        self.assertIn("weekly-water-plants",
                      [h["key"] for h in body["weekly"]])
        text = habits.read_text()
        self.assertIn("| `weekly-water-plants` | Water plants | Sunday |"
                      " weekly | balcony too |", text)
        # Other sections untouched.
        self.assertIn("| `habit-water` | Drink water | today | daily | |",
                      text)
        self.assertIn("| `monthly-clean-room` | Clean room |"
                      " 1st of each month | monthly | Subtasks |", text)

    def test_add_monthly_round_trip(self):
        base, _, habits = self.serve()
        status, body = self.post(
            base, {"action": "add", "section": "monthly",
                   "title": "Backup photos", "when": "15th of each month"})
        self.assertEqual(status, 200)
        self.assertIn("monthly-backup-photos",
                      [h["key"] for h in body["monthly"]])
        self.assertIn("| `monthly-backup-photos` | Backup photos |"
                      " 15th of each month | monthly |  |",
                      habits.read_text())

    def test_add_weekly_requires_when(self):
        base, _, habits = self.serve(doc=FULL_DOC)
        before = habits.read_text()
        status, _ = self.post(base, {"action": "add", "section": "weekly",
                                     "title": "Water plants"})
        self.assertEqual(status, 400)
        self.assertEqual(habits.read_text(), before)

    def test_unknown_section_400(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "section": "yearly",
                                     "title": "x"})
        self.assertEqual(status, 400)
        status, _ = self.post(base, {"action": "remove",
                                     "section": "yearly",
                                     "key": "habit-water"})
        self.assertEqual(status, 400)

    def test_remove_weekly_round_trip(self):
        base, _, habits = self.serve(doc=FULL_DOC)
        status, body = self.post(base, {"action": "remove",
                                        "section": "weekly",
                                        "key": "weekly-laundry"})
        self.assertEqual(status, 200)
        self.assertEqual([h["key"] for h in body["weekly"]], [])
        text = habits.read_text()
        self.assertNotIn("weekly-laundry", text)
        self.assertIn("habit-water", text)

    def test_remove_monthly_round_trip(self):
        base, _, habits = self.serve()
        status, body = self.post(base, {"action": "remove",
                                        "section": "monthly",
                                        "key": "monthly-clean-room"})
        self.assertEqual(status, 200)
        self.assertEqual(body["monthly"], [])
        text = habits.read_text()
        self.assertNotIn("monthly-clean-room", text)
        self.assertIn("habit-make-bed", text)

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
                                        "section": "daily",
                                        "key": "habit-water"})
        self.assertEqual(status, 200)
        self.assertNotIn("habit-water",
                         [h["key"] for h in body["daily"]])
        text = habits.read_text()
        self.assertNotIn("habit-water", text)
        self.assertIn("habit-make-bed", text)

    def test_remove_unknown_key_404(self):
        base, _, habits = self.serve()
        before = habits.read_text()
        status, _ = self.post(base, {"action": "remove", "section": "daily",
                                     "key": "habit-nope"})
        self.assertEqual(status, 404)
        self.assertEqual(habits.read_text(), before)

    def test_remove_without_section_defaults_daily(self):
        base, _, habits = self.serve()
        status, body = self.post(base, {"action": "remove",
                                        "key": "habit-water"})
        self.assertEqual(status, 200)
        self.assertNotIn("habit-water", habits.read_text())

    def test_add_rejects_unicode_line_boundaries(self):
        # splitlines() splits on these; a written row would break on re-read.
        base, _, habits = self.serve()
        before = habits.read_text()
        for ch in ("\u2028", "\u2029", "\x0b", "\x0c", "\x85"):
            status, _ = self.post(base, {"action": "add",
                                         "title": "a" + ch + "b"})
            self.assertEqual(status, 400, repr(ch))
        self.assertEqual(habits.read_text(), before)

    def test_non_ascii_token_403_not_crash(self):
        base, _, _ = self.serve()
        status, _ = self.post(base, {"action": "add", "title": "x"},
                              token="toké")
        self.assertEqual(status, 403)

    def test_bad_content_length(self):
        # Raw socket: http.client/urllib will not send these values, and
        # for "-1" the client must half-close so a fixed server can read
        # to EOF instead of deadlocking (the pre-fix behaviour).
        import socket
        base, _, _ = self.serve()
        port = int(base.rsplit(":", 1)[1])
        for value, want in (("-1", "413"), ("abc", "400")):
            sock = socket.create_connection(("127.0.0.1", port), timeout=10)
            sock.sendall(("POST /api/habits HTTP/1.0\r\n"
                          "Authorization: Bearer %s\r\n"
                          "Content-Length: %s\r\n\r\n"
                          % (self.TOKEN, value)).encode())
            sock.shutdown(socket.SHUT_WR)
            reply = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                reply += chunk
            sock.close()
            status = reply.split(b" ", 2)[1] if reply else b""
            self.assertEqual(status.decode(), want, value)

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
