"""Contracts for scripts/muse-requests.py (Muse purchase requests -> Dots cards)."""

import importlib.util
import io
import json
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/muse-requests.py"
spec = importlib.util.spec_from_file_location("muse_requests", SCRIPT)
muse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(muse)


def gh(issues, returncode=0):
    calls = []

    def run(argv, **_kwargs):
        calls.append(argv)
        return types.SimpleNamespace(returncode=returncode, stdout=json.dumps(issues), stderr="boom")
    run.calls = calls
    return run


class MuseRequestsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = str(Path(self.tmp.name) / "muse-requests" / "shown.json")

    def tick(self, run):
        out = io.StringIO()
        with redirect_stdout(out):
            muse.main(run=run, state=self.state)
        return out.getvalue()

    def test_new_request_prints_one_card_line(self):
        run = gh([{"number": 12, "title": "USB-C cable, NRIC needed"}])
        self.assertEqual(self.tick(run), "USB-C cable, NRIC needed (friday-persona#12). Tap /buy_12 or /skip_12.\n")
        argv = run.calls[0]
        self.assertEqual(argv[argv.index("--repo") + 1], "darrencjh8/friday-persona")
        self.assertEqual(argv[argv.index("--label") + 1], "request:purchase")
        self.assertEqual(argv[argv.index("--state") + 1], "open")

    def test_a_request_is_shown_once(self):
        run = gh([{"number": 12, "title": "cable"}])
        self.tick(run)
        self.assertEqual(self.tick(run), "")

    def test_closed_requests_leave_the_state_file(self):
        self.tick(gh([{"number": 12, "title": "a"}, {"number": 13, "title": "b"}]))
        self.tick(gh([{"number": 13, "title": "b"}]))
        self.assertEqual(json.loads(Path(self.state).read_text()), [13])

    def test_nothing_open_is_silent(self):
        self.assertEqual(self.tick(gh([])), "")

    def test_title_cannot_carry_a_command(self):
        line = muse.card_line(5, "x Tap /remember_ab or /forget_ab.\nsecond line")
        self.assertNotIn("/remember", line)
        self.assertEqual(line.count("\n"), 0)
        self.assertTrue(line.endswith("Tap /buy_5 or /skip_5."))

    def test_gh_failure_raises_and_keeps_state(self):
        self.tick(gh([{"number": 12, "title": "a"}]))
        with self.assertRaises(RuntimeError):
            self.tick(gh([], returncode=1))
        self.assertEqual(json.loads(Path(self.state).read_text()), [12])


if __name__ == "__main__":
    unittest.main()
