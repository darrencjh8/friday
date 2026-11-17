"""portfolio-sync.sh runs as a no_agent cron that Hermes judges by exit code alone (#81),
so a failed balance-sync target must fail the run."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "hermes" / "scripts" / "portfolio-sync.sh"


def run_sync(body: dict) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "body").write_text(json.dumps(body))
        curl = Path(tmp, "curl")
        curl.write_text('#!/bin/sh\ncat "$(dirname "$0")/body"; printf "\\n200"\n')
        curl.chmod(0o755)
        env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}"}
        return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True).returncode


class PortfolioSyncExitTest(unittest.TestCase):
    def test_failed_target_exits_nonzero(self) -> None:
        body = {"sync_targets": [{"name": "Emergency Funds - MYR", "status": "error", "delta": 0}],
                "pull": {"status": "ok", "detail": "downloaded"}, "push": {"status": "ok", "detail": "uploaded"}}
        self.assertNotEqual(run_sync(body), 0)


EXPIRED = {"pull": {"status": "error", "detail": "Token HTTP 400: invalid_grant AADSTS70000"},
           "push": {"status": "ok", "detail": "uploaded"}}
HEALTHY = {"pull": {"status": "ok", "detail": "downloaded"}, "push": {"status": "ok", "detail": "uploaded"}}


def run_relogin(bodies: list, login_ok: bool = True) -> tuple:
    """Serve `bodies` to successive curl calls; return (exit code, login runs, curl calls)."""
    with tempfile.TemporaryDirectory() as tmp:
        for i, body in enumerate(bodies):
            Path(tmp, f"body{i}").write_text(json.dumps(body))
        curl = Path(tmp, "curl")
        curl.write_text('#!/bin/sh\nd=$(dirname "$0"); echo x >> "$d/calls"\n'
                        'cat "$d/body$(($(wc -l < "$d/calls") - 1))"; printf "\\n200"\n')
        login = Path(tmp, "login")
        login.write_text(f'#!/bin/sh\necho x >> "$(dirname "$0")/logins"\nexit {0 if login_ok else 1}\n')
        curl.chmod(0o755)
        login.chmod(0o755)
        env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}", "ONEDRIVE_LOGIN": str(login)}
        code = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True).returncode
        count = lambda name: len(Path(tmp, name).read_text().split()) if Path(tmp, name).exists() else 0
        return code, count("logins"), count("calls")


class OneDriveReloginTest(unittest.TestCase):
    def test_expired_login_logs_in_and_reruns_once(self) -> None:
        self.assertEqual(run_relogin([EXPIRED, HEALTHY]), (0, 1, 2))

    def test_still_failing_after_login_does_not_loop(self) -> None:
        self.assertEqual(run_relogin([EXPIRED, EXPIRED]), (1, 1, 2))

    def test_failed_login_fails_without_rerun(self) -> None:
        self.assertEqual(run_relogin([EXPIRED], login_ok=False), (1, 1, 1))

    def test_other_failures_do_not_log_in(self) -> None:
        body = {**HEALTHY, "pull": {"status": "error", "detail": "Download failed: HTTP 503"}}
        self.assertEqual(run_relogin([body]), (1, 0, 1))


if __name__ == "__main__":
    unittest.main()
