"""Contract tests for the own-CLI Google Tasks client (stdlib unittest)."""
import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]
                       / "hermes" / "scripts"))

import gtasks


class TestCallbackGate(unittest.TestCase):
    def test_wrong_path_rejected(self):
        cb = gtasks.CallbackState()
        status, _ = cb.handle("GET", "/nope", {"code": "c", "state": "s"}, "s")
        self.assertEqual(status, 404)
        self.assertIsNone(cb.code)

    def test_wrong_method_rejected(self):
        cb = gtasks.CallbackState()
        status, _ = cb.handle("POST", "/callback", {"code": "c", "state": "s"}, "s")
        self.assertEqual(status, 404)
        self.assertIsNone(cb.code)

    def test_wrong_state_rejected(self):
        cb = gtasks.CallbackState()
        status, _ = cb.handle("GET", "/callback", {"code": "c", "state": "bad"}, "good")
        self.assertEqual(status, 400)
        self.assertIsNone(cb.code)

    def test_missing_params_rejected(self):
        cb = gtasks.CallbackState()
        status, _ = cb.handle("GET", "/callback", {}, "s")
        self.assertEqual(status, 400)

    def test_duplicate_callback_rejected(self):
        cb = gtasks.CallbackState()
        first, _ = cb.handle("GET", "/callback", {"code": "c", "state": "s"}, "s")
        second, _ = cb.handle("GET", "/callback", {"code": "c", "state": "s"}, "s")
        self.assertEqual(first, 200)
        self.assertEqual(second, 410)

    def test_tailscale_stripped_path_accepted(self):
        # tailscale serve --set-path /gtasks strips the prefix; accept both
        # the stripped and unstripped form so local tests match production.
        for path in ("/callback", "/gtasks/callback"):
            cb = gtasks.CallbackState()
            status, _ = cb.handle("GET", path, {"code": "c", "state": "s"}, "s")
            self.assertEqual(status, 200, path)

    def test_google_error_param_rejected(self):
        cb = gtasks.CallbackState()
        status, _ = cb.handle(
            "GET", "/callback",
            {"error": "access_denied", "state": "s"}, "s",
        )
        self.assertEqual(status, 400)
        self.assertIsNone(cb.code)


class TestRedaction(unittest.TestCase):
    def test_callback_logs_never_carry_secrets(self):
        cb = gtasks.CallbackState()
        buf = io.StringIO()
        with redirect_stderr(buf):
            cb.handle(
                "GET", "/callback",
                {"code": "SECRET-CODE-123", "state": "SECRET-STATE-456"},
                "SECRET-STATE-456",
            )
            gtasks.audit("callback", query_len=42, state_match=True)
        out = buf.getvalue()
        for secret in ("SECRET-CODE-123", "SECRET-STATE-456"):
            self.assertNotIn(secret, out)

    def test_auth_url_builder_does_not_log_secret(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            url = gtasks.build_auth_url(
                "cid", "https://h/gtasks/callback", "ST", "CH")
        self.assertIn("ST", url)  # state travels in the URL by design
        self.assertNotIn("SECRET", buf.getvalue())


class TestManualCallback(unittest.TestCase):
    URL = ("http://localhost:9090/callback?code=CODE-1&state=ST-1")

    def test_full_url_parses(self):
        self.assertEqual(
            gtasks.parse_pasted_callback(self.URL, "ST-1"), "CODE-1")

    def test_bare_query_parses(self):
        self.assertEqual(
            gtasks.parse_pasted_callback("code=CODE-1&state=ST-1", "ST-1"),
            "CODE-1")

    def test_wrong_state_rejected(self):
        with self.assertRaises(ValueError):
            gtasks.parse_pasted_callback(self.URL, "OTHER")

    def test_error_rejected(self):
        with self.assertRaises(ValueError):
            gtasks.parse_pasted_callback(
                "http://localhost:9090/callback?error=access_denied"
                "&state=ST-1", "ST-1")

    def test_forward_hint_names_both_ports(self):
        hint = gtasks.forward_hint("http://localhost:9090/callback", 8299)
        self.assertIn("9090", hint)
        self.assertIn("8299", hint)
        self.assertIn("ssh -L", hint)

    def test_default_redirect_is_loopback(self):
        self.assertTrue(
            gtasks.DEFAULT_REDIRECT_URI.startswith("http://localhost"),
            "loopback stays exempt from Google's own-your-domain policy")


class TestTaskPaths(unittest.TestCase):
    """Regression: tasks methods hang off /lists/{id}, never /users/@me."""

    def test_shapes(self):
        self.assertEqual(gtasks._tasks_path("L"), "/lists/L/tasks")
        self.assertEqual(gtasks._tasks_path("L", "T"), "/lists/L/tasks/T")
        self.assertEqual(gtasks._tasks_path("L", action="clear"),
                         "/lists/L/clear")

    def test_no_at_me_segment(self):
        for path in (gtasks._tasks_path("L"), gtasks._tasks_path("L", "T"),
                     gtasks._tasks_path("L", action="clear")):
            self.assertNotIn("@me", path)


class TestTimeout(unittest.TestCase):
    def test_wait_times_out_fast(self):
        with self.assertRaises(TimeoutError):
            gtasks.wait_for_code(port=0, expected_state="s", timeout=0)


class TestTokenErrors(unittest.TestCase):
    def test_expired_refresh_message(self):
        msg = gtasks.auth_expired_message()
        self.assertIn("google login", msg)
        self.assertNotIn("refresh_token", msg)

    def test_is_auth_expired(self):
        self.assertTrue(gtasks.is_auth_expired({"error": "invalid_grant"}))
        self.assertTrue(gtasks.is_auth_expired({"error": "unauthorized"}))
        self.assertFalse(gtasks.is_auth_expired({"id": "abc"}))


class TestRepeatDates(unittest.TestCase):
    def test_daily_count(self):
        dates = gtasks.repeat_dates("2026-10-20", "daily", count=3, until=None)
        self.assertEqual(dates, ["2026-10-20", "2026-10-21", "2026-10-22"])

    def test_until_bounds(self):
        dates = gtasks.repeat_dates("2026-10-20", "weekly", count=None,
                                    until="2026-11-03")
        self.assertEqual(dates, ["2026-10-20", "2026-10-27", "2026-11-03"])

    def test_bad_date_rejected(self):
        with self.assertRaises(ValueError):
            gtasks.repeat_dates("tomorrow", "daily", count=2, until=None)

    def test_zero_count_rejected(self):
        with self.assertRaises(ValueError):
            gtasks.repeat_dates("2026-10-20", "daily", count=0, until=None)


class TestArgOrder(unittest.TestCase):
    """The wiki-reminders helper puts flags before the action word."""

    def test_flag_before_action_parses(self):
        args = gtasks.build_parser().parse_args(
            gtasks._hoist_action(["tasks", "-l", "Planned", "view",
                                  "--format=json", "--include-completed"]))
        self.assertEqual(args.action, "view")
        self.assertEqual(args.list, "Planned")
        self.assertEqual(args.format, "json")
        self.assertTrue(args.include_completed)

    def test_action_first_unchanged(self):
        argv = ["tasks", "add", "-l", "P", "-t", "T"]
        self.assertEqual(gtasks._hoist_action(argv), argv)


if __name__ == "__main__":
    unittest.main()
