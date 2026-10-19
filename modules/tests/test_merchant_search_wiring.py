"""Merchant web search reaches the expense tracker, off unless switched on."""

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

    def test_mode_defaults_to_off(self):
        self.assertIn("MERCHANT_SEARCH_MODE=${MERCHANT_SEARCH_MODE:-off}", self.services["expense-tracker"]["environment"])

    def test_key_is_a_secret_and_mode_is_a_variable(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("FIRECRAWL_API_KEY: ${{ secrets.FIRECRAWL_API_KEY }}", text)
        self.assertIn("MERCHANT_SEARCH_MODE: ${{ vars.MERCHANT_SEARCH_MODE }}", text)


if __name__ == "__main__":
    unittest.main()
