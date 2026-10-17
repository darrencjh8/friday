"""Argparse-level tests for the gtasks tasks done/undo --id extension."""

import importlib.util
import unittest
from pathlib import Path

GTASKS = Path(__file__).parents[1] / "hermes" / "scripts" / "gtasks.py"


def load_gtasks():
    spec = importlib.util.spec_from_file_location("gtasks_module", GTASKS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GtasksIdArgsTests(unittest.TestCase):
    def test_done_accepts_id(self):
        module = load_gtasks()
        args = module.build_parser().parse_args(
            ["tasks", "done", "-l", "Planned", "--id", "abc123"])
        self.assertEqual(args.action, "done")
        self.assertEqual(args.id, "abc123")
        self.assertEqual(args.list, "Planned")

    def test_undo_accepts_id(self):
        module = load_gtasks()
        args = module.build_parser().parse_args(
            ["tasks", "undo", "-l", "Planned", "--id", "abc123"])
        self.assertEqual(args.action, "undo")
        self.assertEqual(args.id, "abc123")

    def test_id_defaults_empty(self):
        module = load_gtasks()
        args = module.build_parser().parse_args(
            ["tasks", "view", "-l", "Planned"])
        self.assertEqual(args.id, "")


if __name__ == "__main__":
    unittest.main()
