import unittest
from pathlib import Path

import yaml


class CronWrapConfigTest(unittest.TestCase):
    def test_cron_responses_are_not_wrapped(self):
        config_path = Path(__file__).parents[1] / "config.yaml"
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

        self.assertIs(config.get("cron", {}).get("wrap_response"), False)

    def test_cron_output_keeps_a_week_of_proactive_ticks(self):
        # proactive-tick runs 14 times a day; issue #247 needs 7 days of output files.
        config_path = Path(__file__).parents[1] / "config.yaml"
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

        self.assertGreaterEqual(config.get("cron", {}).get("output_retention", 50), 7 * 14)


if __name__ == "__main__":
    unittest.main()
