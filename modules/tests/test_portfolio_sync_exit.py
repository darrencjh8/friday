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


if __name__ == "__main__":
    unittest.main()
