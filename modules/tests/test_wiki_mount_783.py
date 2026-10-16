"""Issue #783 Phase 1: expense-tracker reads the wiki's finance pages.

Only the finance subtree is exposed, and only read-only: the tracker must never
be able to change the knowledge authority, and must not see the rest of the
wiki.
"""

from pathlib import Path
import unittest

import yaml


COMPOSE = Path(__file__).parents[1] / "docker-compose.yml"
WIKI_ACCOUNTS = "/home/runner/data/hermes/data/home/wiki/entities/accounts"
MOUNT = f"{WIKI_ACCOUNTS}:/wiki/accounts:ro"


def services():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


class WikiMountTest(unittest.TestCase):
    def test_expense_tracker_mounts_only_the_finance_pages_read_only(self):
        tracker = services()["expense-tracker"]
        self.assertIn(MOUNT, tracker["volumes"])
        self.assertIn("WIKI_DIR=/wiki/accounts", tracker["environment"])

    def test_no_other_wiki_path_is_mounted_into_a_tracker(self):
        for name in ("expense-tracker", "portfolio-tracker", "actual-api"):
            for volume in services()[name].get("volumes", []):
                volume = str(volume)
                if "/home/wiki" in volume:
                    self.assertEqual(volume, MOUNT, name)
                    self.assertTrue(volume.endswith(":ro"), name)


if __name__ == "__main__":
    unittest.main()
