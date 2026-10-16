"""Issue #783 Phase 2: both trackers verify Hermes's processing requests.

The /process routes are signed with HERMES_WEBHOOK_SECRET; a tracker without
it refuses every request, so the secret must reach both services.
"""

from pathlib import Path
import unittest

import yaml

COMPOSE = Path(__file__).parents[1] / "docker-compose.yml"


class ProcessingSecretTest(unittest.TestCase):
    def test_both_trackers_receive_the_signing_secret(self):
        services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
        for name in ("expense-tracker", "portfolio-tracker"):
            env = services[name]["environment"]
            self.assertIn("HERMES_WEBHOOK_SECRET=${HERMES_WEBHOOK_SECRET}", env, name)


if __name__ == "__main__":
    unittest.main()
