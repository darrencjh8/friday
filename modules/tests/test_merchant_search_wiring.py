"""Merchant web search reaches the expense tracker; the key alone turns it on."""

from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).parents[2]
COMPOSE = ROOT / "modules/docker-compose.yml"
WORKFLOW = ROOT / ".github/workflows/deploy.yml"


class MerchantSearchWiringTest(unittest.TestCase):
    def setUp(self):
        self.services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]

    def test_tracker_gets_the_hermes_firecrawl_key(self):
        self.assertIn("FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY:-}", self.services["expense-tracker"]["environment"])
        self.assertIn("FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}", self.services["hermes"]["environment"])

    def test_no_feature_flag(self):
        env = self.services["expense-tracker"]["environment"]
        self.assertFalse([e for e in env if e.startswith("MERCHANT_SEARCH_MODE")])
        self.assertNotIn("MERCHANT_SEARCH_MODE", WORKFLOW.read_text(encoding="utf-8"))

    def test_key_is_a_secret(self):
        self.assertIn("FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}", WORKFLOW.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
