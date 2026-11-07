from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).parents[2]
COMPOSE_FILE = REPO_ROOT / "modules/docker-compose.yml"
HERMES_CONFIG = REPO_ROOT / "modules/hermes/config.yaml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github/workflows/deploy.yml"


def hermes_service():
    return yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))["services"]["hermes"]


class WebappWiringTests(unittest.TestCase):
    def test_baked_config_enables_the_webapp(self):
        # v0.23 serves the Desktop workspace in a browser from the gateway's
        # own listener (not the retired dashboard/WebUI). Off by default
        # upstream, so the baked file must turn it on or prod never serves it.
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        webapp = config["webapp"]
        self.assertTrue(webapp["enabled"])
        # 0.0.0.0: inside the container, loopback is unreachable from a
        # published port or a sidecar proxy (upstream docker docs).
        self.assertEqual("0.0.0.0", webapp["host"])
        self.assertEqual(9120, webapp["port"])
        # The real tailnet URL must not land in this public repo; it arrives
        # through the WEBAPP_PUBLIC_URL deploy variable and is resolved into
        # the live config at boot by 50-seed-defaults.
        self.assertIn("WEBAPP_PUBLIC_URL", webapp["public_url"])

    def test_webapp_is_published_on_host_loopback_only(self):
        ports = hermes_service()["ports"]
        self.assertIn("127.0.0.1:9120:9120", ports)
        self.assertNotIn("9119:9119", ports)
        self.assertNotIn("127.0.0.1:8787:8787", ports)
        for published in ports:
            self.assertFalse(
                published.startswith("9120:"),
                "webapp must not bind the LAN; Tailscale serve terminates TLS",
            )

    def test_webapp_has_a_signin_provider(self):
        # A non-loopback webapp host refuses to start with no auth provider;
        # it shares the dashboard's providers, so the basic-auth pair must be
        # wired through (their values stay in the darren-prod secrets).
        environment = hermes_service()["environment"]
        self.assertIn(
            "HERMES_DASHBOARD_BASIC_AUTH_USERNAME=${HERMES_DASHBOARD_BASIC_AUTH_USERNAME}",
            environment,
        )
        self.assertIn(
            "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=${HERMES_DASHBOARD_BASIC_AUTH_PASSWORD}",
            environment,
        )
        self.assertIn("WEBAPP_PUBLIC_URL=${WEBAPP_PUBLIC_URL:-}", environment)
        # The retired s6 dashboard slot stays down: HERMES_DASHBOARD itself
        # must not be set, only its auth pair above.
        self.assertEqual(
            [],
            [e for e in environment if e.split("=")[0] == "HERMES_DASHBOARD"],
        )

    def test_deploy_workflow_passes_webapp_wiring(self):
        text = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("HERMES_DASHBOARD_BASIC_AUTH_USERNAME", text)
        self.assertIn("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD", text)
        self.assertIn("WEBAPP_PUBLIC_URL", text)


if __name__ == "__main__":
    unittest.main()
