import unittest
from pathlib import Path

import yaml


class DiskCleanupConfigTest(unittest.TestCase):
    def test_plugin_enabled_in_baked_config(self):
        config_path = Path(__file__).parents[1] / "config.yaml"
        config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

        self.assertIn("disk-cleanup", config.get("plugins", {}).get("enabled", []))


if __name__ == "__main__":
    unittest.main()
