"""The Dots phone-app platform ships in the Hermes image, off until DOTS_TOKEN is set."""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "modules/docker-compose.yml"
CONFIG = ROOT / "modules/hermes/config.yaml"
DOCKERFILE = ROOT / "modules/hermes/Dockerfile"
PLUGIN = ROOT / "modules/hermes/plugins/dots"
REVIEWER_CONFIG = ROOT / "modules/hermes/profiles/code-reviewer/config.yaml"
SEED = ROOT / "modules/hermes/50-seed-defaults"
WORKFLOW = ROOT / ".github/workflows/deploy.yml"


def hermes_service():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["hermes"]


class DotsPlatformWiringTest(unittest.TestCase):
    def test_plugin_is_vendored_and_copied_as_a_bundled_platform(self):
        for name in ("plugin.yaml", "__init__.py", "adapter.py"):
            self.assertTrue((PLUGIN / name).is_file(), name)
        self.assertIn(
            "COPY plugins/dots/ /opt/hermes/plugins/platforms/dots/",
            DOCKERFILE.read_text(encoding="utf-8"),
        )

    def test_gateway_is_published_on_host_loopback_only(self):
        self.assertIn("127.0.0.1:8788:8788", hermes_service()["ports"])

    def test_token_is_optional_and_browsers_stay_refused(self):
        env = hermes_service()["environment"]
        for line in ("DOTS_TOKEN=${DOTS_TOKEN:-}", "DOTS_BIND=0.0.0.0:8788",
                     "DOTS_ALLOWED_USERS=owner", "DOTS_HOME_CHANNEL=owner"):
            self.assertIn(line, env)
        self.assertFalse([line for line in env if line.startswith("DOTS_WEB_ORIGINS")])

    def test_private_release_proxy_is_configured_and_token_authenticated(self):
        env = hermes_service()["environment"]
        self.assertIn("DOTS_UPDATE_REPO=${DOTS_UPDATE_REPO:-darrencjh8/hermes-dots}", env)
        adapter = (PLUGIN / "adapter.py").read_text(encoding="utf-8")
        self.assertIn('app.router.add_get("/dots/releases/latest", self._handle_release_latest)', adapter)
        self.assertIn('app.router.add_get("/dots/releases/assets/{asset_id}", self._handle_release_asset)', adapter)
        self.assertIn("and self._authorized(request)", adapter)

    def test_deploy_passes_the_token_secret(self):
        self.assertIn("DOTS_TOKEN: ${{ secrets.DOTS_TOKEN }}", WORKFLOW.read_text(encoding="utf-8"))

    def test_settings_reach_the_profile_secret_scope(self):
        block = SEED.read_text(encoding="utf-8").split("mirrored_exact = (", 1)[1].split("\n)", 1)[0]
        for key in ("DOTS_TOKEN", "DOTS_BIND", "DOTS_HOME_CHANNEL"):
            self.assertIn(f'"{key}"', block)

    def test_reviewer_profile_does_not_build_a_second_adapter(self):
        config = yaml.safe_load(REVIEWER_CONFIG.read_text(encoding="utf-8"))
        self.assertIs(False, config["platforms"]["dots"]["enabled"])
        self.assertIn('("email_intake", "dots")', SEED.read_text(encoding="utf-8"))

    def test_tool_progress_stays_out_of_the_chat(self):
        config = yaml.safe_load(CONFIG.read_text(encoding="utf-8"))
        self.assertEqual("off", config["display"]["platforms"]["dots"]["tool_progress"])


if __name__ == "__main__":
    unittest.main()
