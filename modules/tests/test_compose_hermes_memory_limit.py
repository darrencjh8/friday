from pathlib import Path
import unittest

import yaml


COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"


class HermesComposeConfigTests(unittest.TestCase):
    def test_hermes_memory_limit_is_three_gib(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertEqual("3g", compose["services"]["hermes"]["mem_limit"])

    def test_hermes_dashboard_is_enabled(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        environment = compose["services"]["hermes"]["environment"]

        # Upstream treats 1/true/yes (any case) as enabled, so pin the exact
        # enabled value instead of matching a handful of truthy spellings.
        self.assertIn("HERMES_DASHBOARD=1", environment)

    def test_hermes_dashboard_auth_credentials_are_configured(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        environment = compose["services"]["hermes"]["environment"]

        # The dashboard binds non-loopback (9119), so its auth gate fails
        # closed without a provider. Credentials come from CI secrets, so the
        # repo carries only ${VAR} references, never values.
        self.assertIn(
            "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${HERMES_DASHBOARD_BASIC_AUTH_USERNAME}",
            environment,
        )
        self.assertIn(
            "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${HERMES_DASHBOARD_BASIC_AUTH_PASSWORD}",
            environment,
        )

        repo_root = COMPOSE_FILE.parents[1]
        for relative in ("modules/deploy.sh", ".github/workflows/deploy.yml"):
            text = (repo_root / relative).read_text(encoding="utf-8")
            self.assertIn("HERMES_DASHBOARD_BASIC_AUTH_", text, relative)

    def test_codex_router_is_exposed_for_remote_clients(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertIn("0.0.0.0:4100:4100", compose["services"]["codex-router"]["ports"])


if __name__ == "__main__":
    unittest.main()
