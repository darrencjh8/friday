from pathlib import Path
import unittest

import yaml


COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"


class HermesComposeConfigTests(unittest.TestCase):
    def test_hermes_memory_limit_is_three_gib(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertEqual("3g", compose["services"]["hermes"]["mem_limit"])

    def test_hermes_dashboard_and_webui_are_not_run(self):
        # Both were removed to free memory on the 8 GB host (#157). The
        # upstream dashboard s6 slot stays down unless HERMES_DASHBOARD is
        # truthy, so no deploy input may set it. The v0.23 browser Webapp is a
        # different surface (gateway listener, 9120): it shares the
        # dashboard's basic-auth sign-in pair, which is the only
        # HERMES_DASHBOARD_-prefixed input allowed back.
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        environment = compose["services"]["hermes"]["environment"]
        self.assertEqual(
            [],
            [e for e in environment if e.split("=")[0] == "HERMES_DASHBOARD"],
        )
        self.assertEqual(
            [],
            [e for e in environment if e.startswith("HERMES_WEBUI")],
        )
        ports = compose["services"]["hermes"]["ports"]
        self.assertNotIn("9119:9119", ports)
        self.assertNotIn("127.0.0.1:8787:8787", ports)

        repo_root = COMPOSE_FILE.parents[1]
        for relative in ("modules/deploy.sh", ".github/workflows/deploy.yml"):
            text = (repo_root / relative).read_text(encoding="utf-8")
            self.assertNotIn("HERMES_DASHBOARD=1", text, relative)
            self.assertNotIn("HERMES_WEBUI", text, relative)

        dockerfile = (repo_root / "modules/hermes/Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("hermes-webui.git", dockerfile)
        self.assertNotIn("s6-rc.d/hermes-webui", dockerfile)
        self.assertFalse((repo_root / "modules/hermes/webui/s6-rc.d/hermes-webui").exists())

    def test_codex_router_is_exposed_for_remote_clients(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))

        self.assertIn("0.0.0.0:4100:4100", compose["services"]["codex-router"]["ports"])


if __name__ == "__main__":
    unittest.main()
