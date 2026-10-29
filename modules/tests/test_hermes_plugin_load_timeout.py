"""Issue #104: platform plugins must get time to load on a busy host.

Hermes abandons a plugin whose import + register() takes longer than
plugins.load_timeout_seconds (default 10 s). During deploy restarts the host is
swapping, and slack-platform and telegram-platform have taken 13-17 s, so the
gateway came up with no Slack or Telegram adapter until the next restart.
"""

from pathlib import Path
import unittest

import yaml

CONFIG_FILE = Path(__file__).parents[1] / "hermes" / "config.yaml"


class HermesPluginLoadTimeoutTests(unittest.TestCase):
    def test_plugin_load_deadline_has_headroom_for_a_busy_host(self):
        config = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8"))
        timeout = config.get("plugins", {}).get("load_timeout_seconds")
        self.assertIsNotNone(timeout, "plugins.load_timeout_seconds is unset, so the 10 s default applies")
        self.assertGreaterEqual(timeout, 60)


if __name__ == "__main__":
    unittest.main()
