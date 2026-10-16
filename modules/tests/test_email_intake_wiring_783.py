"""Issue #783 Phase 3b: email-intake ships in the Hermes image in shadow mode."""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "modules/docker-compose.yml"
DOCKERFILE = ROOT / "modules/hermes/Dockerfile"
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
SEED = ROOT / "modules/hermes/50-seed-defaults"


class EmailIntakeWiringTest(unittest.TestCase):
    def test_plugin_is_copied_as_a_bundled_platform(self):
        self.assertIn(
            "COPY plugins/email-intake/ /opt/hermes/plugins/platforms/email_intake/",
            DOCKERFILE.read_text(encoding="utf-8"),
        )

    def test_hermes_gets_imap_and_defaults_to_shadow_mode(self):
        env = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]["hermes"]["environment"]
        for line in ("IMAP_HOST=${IMAP_HOST}", "IMAP_USERNAME=${IMAP_USERNAME}",
                     "IMAP_PASSWORD=${IMAP_PASSWORD}", "EMAIL_INTAKE_MODE=${EMAIL_INTAKE_MODE:-shadow}"):
            self.assertIn(line, env)

    def test_mode_is_an_actions_variable_so_it_can_be_turned_off(self):
        self.assertIn("EMAIL_INTAKE_MODE: ${{ vars.EMAIL_INTAKE_MODE }}", WORKFLOW.read_text(encoding="utf-8"))

    def test_settings_reach_the_profile_secret_scope(self):
        text = SEED.read_text(encoding="utf-8")
        block = text.split("mirrored_exact = (", 1)[1].split("\n)", 1)[0]
        for key in ("IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD", "JEV_API_KEY", "EMAIL_INTAKE_MODE"):
            self.assertIn(f'"{key}"', block)


if __name__ == "__main__":
    unittest.main()


class EmailIntakeNotBackedUpTest(unittest.TestCase):
    def test_memory_backup_never_copies_the_intake_journal(self):
        script = (ROOT / "modules/hermes/scripts/memory-backup.sh").read_text(encoding="utf-8")
        self.assertNotIn("email-intake", script)
        self.assertNotIn('cp -r "$DATA_DIR"/.', script)
