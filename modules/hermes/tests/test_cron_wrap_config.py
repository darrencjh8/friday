import unittest
from pathlib import Path

import yaml


class CronWrapConfigTest(unittest.TestCase):
    def test_cron_responses_are_not_wrapped(self):
        config_path = Path(__file__).parents[1] / "config.yaml"
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

        self.assertIs(config.get("cron", {}).get("wrap_response"), False)


if __name__ == "__main__":
    unittest.main()
