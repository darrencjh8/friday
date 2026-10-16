"""Bitwarden Secrets Manager wiring for Hermes (issue #783, Phase 2).

The machine-account token and project id come from GitHub Actions and reach
the hermes container like every other deployed secret. Hermes reads the
``secrets:`` block of config.yaml raw (no ``${VAR}`` expansion), so the seed
hook's placeholder pass must resolve the project id into the live file.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
COMPOSE = ROOT / "modules/docker-compose.yml"
DEPLOY_SH = ROOT / "modules/deploy.sh"
HERMES_CONFIG = ROOT / "modules/hermes/config.yaml"


class BitwardenSecretsWiringTests(unittest.TestCase):
    def test_workflow_passes_token_secret_and_project_variable(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("BWS_ACCESS_TOKEN: ${{ secrets.BWS_ACCESS_TOKEN }}", workflow)
        # The project id is not secret; it lives in Actions variables.
        self.assertIn("BWS_PROJECT: ${{ vars.BWS_PROJECT }}", workflow)
        self.assertNotIn("secrets.BWS_PROJECT", workflow)

    def test_compose_forwards_both_to_hermes_only(self):
        services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]

        hermes_env = services["hermes"]["environment"]
        self.assertIn("BWS_ACCESS_TOKEN=${BWS_ACCESS_TOKEN:-}", hermes_env)
        self.assertIn("BWS_PROJECT=${BWS_PROJECT:-}", hermes_env)
        for name, service in services.items():
            if name == "hermes":
                continue
            env = service.get("environment") or []
            self.assertFalse(
                any(str(item).startswith("BWS_") for item in env),
                f"{name} must not receive Bitwarden credentials",
            )

    def test_deploy_script_validates_both_as_optional(self):
        script = DEPLOY_SH.read_text(encoding="utf-8")

        self.assertIn('check_var_optional "BWS_ACCESS_TOKEN" "$HERMES_ENV"', script)
        self.assertIn('check_var_optional "BWS_PROJECT" "$HERMES_ENV"', script)

    def test_hermes_config_enables_bitwarden_for_the_us_region(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        bitwarden = config["secrets"]["bitwarden"]

        self.assertIs(bitwarden["enabled"], True)
        self.assertEqual(bitwarden["project_id"], "${BWS_PROJECT}")
        self.assertEqual(bitwarden["server_url"], "https://vault.bitwarden.com")
        self.assertEqual(bitwarden["access_token_env"], "BWS_ACCESS_TOKEN")

    def test_bitwarden_never_overrides_deployed_values(self):
        """The project holds statement passwords only; it must never replace a
        deployed credential such as TELEGRAM_BOT_TOKEN that shares a name."""
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))

        self.assertIs(config["secrets"]["bitwarden"]["override_existing"], False)


if __name__ == "__main__":
    unittest.main()
