import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("opencode_host", Path(__file__).parents[1] / "scripts" / "opencode_host.py")
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)


class TestOpencodeHost(unittest.TestCase):
    def test_latest_reads_newest_first_messages(self):
        # The API lists newest first; done means the newest entry is the idle marker.
        messages = [
            {"type": "idle", "time": {"created": 3}},
            {"type": "assistant", "time": {"created": 2}, "content": [{"type": "reasoning", "text": "x"}, {"type": "text", "text": "OK"}]},
            {"type": "user", "time": {"created": 1}},
        ]
        self.assertEqual(("OK", True), oc.latest(messages))
        self.assertEqual(("", False), oc.latest(messages[2:]))

    def test_bare_repo_names_resolve_under_the_host_workspace(self):
        self.assertEqual("/home/darren/workspace/friday", oc.directory("friday"))
        self.assertEqual("/srv/x", oc.directory("/srv/x"))

    def test_start_creates_a_session_in_the_repo_and_sends_the_task(self):
        calls = []

        def fake(method, path, body=None):
            calls.append((method, path, body))
            return {"id": "ses_1"} if path == "/session" else {}

        with patch.object(oc, "call", fake), patch("builtins.print"):
            oc.main(["start", "friday", "fix", "the", "bug"])
        self.assertEqual(("POST", "/session"), calls[0][:2])
        self.assertEqual({"directory": "/home/darren/workspace/friday"}, calls[0][2]["location"])
        self.assertEqual(("POST", "/session/ses_1/prompt", {"text": "fix the bug"}), calls[1])

    def test_missing_password_stops_before_any_request(self):
        with patch.dict(oc.os.environ, {}, clear=True), patch.object(oc.urllib.request, "urlopen") as urlopen:
            with self.assertRaises(SystemExit):
                oc.call("GET", "/session")
        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
