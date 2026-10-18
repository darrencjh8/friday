"""Failure diagnostics survive cron redirection without disclosing secrets."""
import io
import shutil
import syslog
import unittest
import urllib.error
from unittest import mock

import test_claude_usage as base


class FailureDiagnosticsTests(unittest.TestCase):
    def test_failures_log_only_fixed_categories_and_http_status(self):
        helper = base.load_helper()
        runner = base.HelperTests()
        tmp = runner.make_tmp()
        self.addCleanup(shutil.rmtree, tmp)
        output = tmp / "snapshot.json"
        previous = '{"previous": true}\n'
        output.write_text(previous)
        failures = [
            (urllib.error.HTTPError("https://secret.invalid/token", 401, "secret-token", {},
                                    io.BytesIO(b"secret-body")), "http_401"),
            (urllib.error.HTTPError("https://secret.invalid/token", 429, "secret-token", {},
                                    io.BytesIO(b"secret-body")), "http_429"),
            (urllib.error.URLError("secret-token"), "network"),
            (TimeoutError("secret-token"), "network"),
            (ValueError("secret-token"), "invalid_data"),
            (PermissionError("secret-token"), "filesystem"),
            (RuntimeError("secret-token"), "unexpected"),
        ]
        for error, category in failures:
            with self.subTest(category=category), mock.patch.object(syslog, "syslog") as log:
                self.assertEqual(runner.run_main(helper, base.NESTED_CREDS, error, output), 1)
                log.assert_called_once_with(syslog.LOG_WARNING, "claude-usage: collection failed: " + category)
                self.assertEqual(output.read_text(), previous)

    def test_logging_failure_preserves_nonzero_exit_and_snapshot(self):
        helper = base.load_helper()
        runner = base.HelperTests()
        tmp = runner.make_tmp()
        self.addCleanup(shutil.rmtree, tmp)
        output = tmp / "snapshot.json"
        output.write_text("{}\n")
        with mock.patch.object(syslog, "syslog", side_effect=OSError("unavailable")):
            self.assertEqual(runner.run_main(helper, base.NESTED_CREDS, ValueError("bad"), output), 1)
        self.assertEqual(output.read_text(), "{}\n")

    def test_success_does_not_log(self):
        helper = base.load_helper()
        runner = base.HelperTests()
        tmp = runner.make_tmp()
        self.addCleanup(shutil.rmtree, tmp)
        with mock.patch.object(syslog, "syslog") as log:
            self.assertEqual(runner.run_main(helper, base.NESTED_CREDS, base.RECORDED_UPSTREAM,
                                             tmp / "snapshot.json"), 0)
        log.assert_not_called()
