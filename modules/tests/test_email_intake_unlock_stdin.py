"""The statement password reaches qpdf on stdin (issue #97).

A confined qpdf, as on the ubuntu-26.04 CI runners, cannot open a password
file, so every decrypt failed there. Synthetic password only; qpdf is faked.
"""

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hermes" / "plugins" / "email-intake"))

from intake import unlock  # noqa: E402


class PasswordOnStdinTest(unittest.TestCase):
    def test_the_password_goes_to_qpdf_on_stdin_not_a_file(self):
        calls = []

        def run(cmd, **kw):
            calls.append((cmd, kw))
            return subprocess.CompletedProcess(cmd, 2)

        self.assertIsNone(unlock.decrypt_pdf(b"%PDF /Encrypt", ["synthetic-pass-1"], run=run))
        (cmd, kw), = calls
        self.assertIn("--password-file=-", cmd)
        self.assertEqual(kw.get("input"), b"synthetic-pass-1")


if __name__ == "__main__":
    unittest.main()
