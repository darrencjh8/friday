"""Issue #107: a deploy must stop the gateways before it recreates hermes.

Stopping the container leaves s6 to reach the gateways last, and deploys that
recorded no SIGTERM were killed at Docker's 60 s limit. Stopping the supervised
services first gives each gateway its own SIGTERM and its own grace period.
"""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULES = Path(__file__).parents[1]
DEPLOY = MODULES / "deploy.sh"
HELPER = MODULES / "hermes" / "scripts" / "deploy-gateway-stop.sh"


def run_helper(function, docker_exit=0):
    """Run one helper function under `set -e` with docker stubbed, returning (exit, docker args)."""
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "docker.log"
        stub = Path(tmp) / "docker"
        stub.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\nexit {docker_exit}\n')
        stub.chmod(0o755)
        result = subprocess.run(
            ["bash", "-c", f'set -euo pipefail; . "{HELPER}"; {function}'],
            env={**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}"},
        )
        return result.returncode, log.read_text() if log.exists() else ""


class GatewayStopHelperTests(unittest.TestCase):
    def test_stop_waits_for_every_gateway_to_finish(self):
        _, calls = run_helper("stop_hermes_gateways")
        self.assertIn("exec hermes", calls)
        self.assertIn("/run/hermes-service/gateway-*", calls)
        self.assertIn("-wD -T 45000 -d", calls)

    def test_start_brings_every_gateway_back(self):
        _, calls = run_helper("start_hermes_gateways")
        self.assertIn("/run/hermes-service/gateway-*", calls)
        self.assertIn("-u ", calls)

    def test_a_missing_container_does_not_abort_the_deploy(self):
        for function in ("stop_hermes_gateways", "start_hermes_gateways"):
            with self.subTest(function=function):
                code, _ = run_helper(function, docker_exit=1)
                self.assertEqual(0, code)


class DeployOrderTests(unittest.TestCase):
    def setUp(self):
        self.script = DEPLOY.read_text(encoding="utf-8")

    def test_gateways_stop_before_the_container_does(self):
        stop = self.script.index("  stop_hermes_gateways\n")
        self.assertLess(stop, self.script.index("docker stop hermes modules-portfolio-tracker-1"))
        self.assertLess(stop, self.script.index("--force-recreate $UP_TARGETS"))

    def test_gateways_come_back_when_up_leaves_the_container_alone(self):
        """Compose keeps a container whose image did not change, so nothing else restarts them."""
        start = self.script.index("  start_hermes_gateways\n")
        self.assertGreater(start, self.script.index("--remove-orphans $UP_TARGETS"))
        self.assertLess(start, self.script.index("# ---- health checks ----"))

    def test_a_failed_up_still_brings_gateways_back_and_fails_the_deploy(self):
        """Under `set -e` a bare failing `up` would exit before the gateways come back."""
        self.assertIn("--force-recreate $UP_TARGETS || up_status=$?", self.script)
        self.assertIn("--remove-orphans $UP_TARGETS || up_status=$?", self.script)
        self.assertLess(
            self.script.index("  start_hermes_gateways\n"),
            self.script.index('exit "$up_status"'),
        )


if __name__ == "__main__":
    unittest.main()
