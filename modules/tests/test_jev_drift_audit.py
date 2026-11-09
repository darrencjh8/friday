"""Tests for the Jev drift advisory. No live Jev calls: gates are pure
functions and the pair spec is validated against the current tree."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import jev_drift_audit as audit


class GateTests(unittest.TestCase):
    def test_confident_drift_passes(self):
        self.assertTrue(audit.gate_choice(0.97, 0.95))
        self.assertTrue(audit.gate_evidence(0.83))

    def test_i20_scenario_abstains(self):
        # A confident-but-wrong drifted verdict (0.7/0.62 on a clean pair)
        # must die at the evidence round, never confirm.
        self.assertTrue(audit.gate_choice(0.7, 0.62))
        self.assertFalse(audit.gate_evidence(0.55))

    def test_low_confidence_abstains(self):
        self.assertFalse(audit.gate_choice(0.48, 0.34))
        self.assertFalse(audit.gate_choice(0.9, 0.1))

    def test_threshold_values(self):
        self.assertEqual((audit.MIN_CONF, audit.MIN_MARGIN, audit.MIN_EVID),
                         (0.65, 0.3, 0.6))


class PairSpecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "scripts", "jev-drift-pairs.json")) as f:
            cls.pairs = json.load(f)["pairs"]

    def test_ids_unique(self):
        ids = [p["id"] for p in self.pairs]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_state_builds(self):
        for p in self.pairs:
            with self.subTest(pair=p["id"]):
                self.assertTrue(audit.build_state(p).strip(),
                                f"{p['id']}: empty state")

    def test_state_format(self):
        p = next(p for p in self.pairs if p["id"] == "j02")
        state = audit.build_state(p)
        self.assertIn("DOC (", state)
        self.assertIn("CODE:", state)
        self.assertNotIn("JEV_API_KEY", state)

    def test_required_anchors_present(self):
        # Each pair's state must contain its anchor facts: a locator that
        # silently matches nothing (or the wrong lines) is the failure
        # mode that once shipped a truncated list to the judge.
        for p in self.pairs:
            if "require" not in p:
                continue
            with self.subTest(pair=p["id"]):
                state = audit.build_state(p)
                for anchor in p["require"]:
                    self.assertIn(anchor, state, f"{p['id']}: anchor missing: {anchor}")

    def test_no_secrets_in_states(self):
        for p in self.pairs:
            with self.subTest(pair=p["id"]):
                state = audit.build_state(p)
                for secret in ("JEV_API_KEY", "BEGIN ", "sk-"):
                    self.assertNotIn(secret, state)


if __name__ == "__main__":
    unittest.main()
