"""Issue #783: wiki-finance-refresh treats the wiki as the mapping authority."""

from pathlib import Path
import unittest

SEED = Path(__file__).parents[1] / "hermes" / "50-seed-defaults"


class WikiRefreshPromptTest(unittest.TestCase):
    def test_refresh_no_longer_imports_tracker_mappings(self):
        text = SEED.read_text(encoding="utf-8")
        self.assertNotIn("Read expense-tracker card suffix/payee facts with targeted mapping queries", text)
        self.assertIn("never import mappings from it", text)

    def test_refresh_reports_the_proposal_queue_without_writing_it(self):
        text = SEED.read_text(encoding="utf-8")
        self.assertIn("/opt/data/expense-tracker-data/wiki-proposals.jsonl", text)
        self.assertIn("Proposed mappings", text)
        self.assertIn("never write a proposal into the wiki yourself", text)


if __name__ == "__main__":
    unittest.main()
