"""Lockfiles keep the patched versions of the critical Dependabot alerts.

proxy-addr < 2.0.8 (IP spoofing), protobufjs < 7.5.5 (code execution) and
tinypool < 2.1.2 (prototype pollution to RCE). protobufjs and tinypool are held
up by npm `overrides`, so dropping an override would quietly bring them back.
"""

import json
import unittest
from pathlib import Path

MODULES = Path(__file__).resolve().parents[1]
FLOORS = {"proxy-addr": (2, 0, 8), "protobufjs": (7, 5, 5), "tinypool": (2, 1, 2)}
LOCKFILES = ["portfolio-tracker", "expense-tracker", "image-gen", "actual-api"]


def version(text):
    return tuple(int(part) for part in text.split("-")[0].split("."))


class CriticalDependencyFloorTests(unittest.TestCase):
    def test_no_lockfile_resolves_a_vulnerable_version(self):
        for module in LOCKFILES:
            packages = json.loads((MODULES / module / "package-lock.json").read_text())["packages"]
            for path, meta in packages.items():
                name = path.rsplit("node_modules/", 1)[-1]
                if name in FLOORS:
                    with self.subTest(module=module, package=path):
                        self.assertGreaterEqual(version(meta["version"]), FLOORS[name])


if __name__ == "__main__":
    unittest.main()
