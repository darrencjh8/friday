"""Issue #723: the learning offer store must not sit on a volume hermes mounts.

If the model's container could write the offer file it could mint an offer
itself, so the state directory is mounted into expense-tracker only.
"""

from pathlib import Path
import unittest

import yaml


COMPOSE = Path(__file__).parents[1] / "docker-compose.yml"
STATE_VOLUME = "/home/runner/data/expense-tracker/state:/app/state"


def services():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


class LearningStateVolumeTest(unittest.TestCase):
    def test_state_volume_only_on_expense_tracker(self):
        svc = services()
        self.assertIn(STATE_VOLUME, svc["expense-tracker"]["volumes"])
        for name, service in svc.items():
            if name == "expense-tracker":
                continue
            for volume in service.get("volumes", []):
                self.assertNotIn("expense-tracker/state", str(volume), name)

    def test_hermes_bot_settings_reach_expense_tracker(self):
        env = services()["expense-tracker"]["environment"]
        self.assertIn("TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}", env)
        self.assertIn("TELEGRAM_HOME_CHANNEL=${TELEGRAM_HOME_CHANNEL:-}", env)
        self.assertFalse([e for e in env if "LEARNING_BOT" in str(e)])

    def test_second_bot_is_gone_from_deploy(self):
        root = Path(__file__).parents[2]
        for path in (".github/workflows/deploy.yml", "modules/deploy.sh", "modules/docker-compose.yml"):
            self.assertNotIn("LEARNING_BOT", (root / path).read_text(), path)
        text = (root / ".github/workflows/deploy.yml").read_text()
        self.assertIn("TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}", text)
        self.assertIn("TELEGRAM_HOME_CHANNEL: ${{ vars.TELEGRAM_HOME_CHANNEL }}", text)


if __name__ == "__main__":
    unittest.main()
