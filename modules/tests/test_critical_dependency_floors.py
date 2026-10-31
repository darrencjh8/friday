"""Lockfiles keep the patched versions of the critical and high Dependabot alerts.

Critical: proxy-addr < 2.0.8 (IP spoofing), protobufjs < 7.5.5 (code execution)
and tinypool < 2.1.2 (prototype pollution to RCE). protobufjs and tinypool are
held up by npm `overrides`, so dropping an override would quietly bring them back.
High: the non-major fixes for undici, fast-uri, the MCP SDK, nodemailer and the
rest (nightly decision 3 of 2026-10-30), and litellm in the Hermes codex-router image.
"""

import json
import re
import unittest
from pathlib import Path

MODULES = Path(__file__).resolve().parents[1]
# One floor per major line; a version on a newer major than every floor is not affected.
FLOORS = {
    "proxy-addr": [(2, 0, 8)],
    "protobufjs": [(7, 5, 5)],
    "tinypool": [(2, 1, 2)],
    "undici": [(7, 30, 1)],
    "fast-uri": [(3, 1, 7)],
    "@modelcontextprotocol/sdk": [(1, 32, 0)],
    "nodemailer": [(10, 0, 6)],
    "body-parser": [(1, 20, 9), (2, 4, 0)],
    "brace-expansion": [(1, 1, 16), (2, 1, 2)],
    "js-yaml": [(3, 15, 2)],
    "ip-address": [(10, 3, 1)],
    "deepmerge-ts": [(8, 0, 0)],
    "form-data": [(4, 0, 6)],
    "linkify-it": [(5, 0, 2)],
    "postcss": [(8, 5, 18)],
    "source-map-js": [(1, 2, 2)],
    "vite": [(7, 3, 7)],
    "browserslist": [(4, 28, 7)],
}
LOCKFILES = ["portfolio-tracker", "expense-tracker", "image-gen", "actual-api"]


def version(text):
    return tuple(int(part) for part in text.split("-")[0].split("."))


def floor_for(found, floors):
    same = [floor for floor in floors if floor[0] == found[0]]
    if same:
        return same[0]
    return min(floors) if found < min(floors) else None


class CriticalDependencyFloorTests(unittest.TestCase):
    def test_no_lockfile_resolves_a_vulnerable_version(self):
        for module in LOCKFILES:
            packages = json.loads((MODULES / module / "package-lock.json").read_text())["packages"]
            for path, meta in packages.items():
                name = path.rsplit("node_modules/", 1)[-1]
                if name in FLOORS and "version" in meta:
                    found = version(meta["version"])
                    floor = floor_for(found, FLOORS[name])
                    if floor:
                        with self.subTest(module=module, package=path):
                            self.assertGreaterEqual(found, floor)

    def test_hermes_router_litellm_is_patched(self):
        text = (MODULES / "hermes" / "requirements-codex-router.txt").read_text()
        pinned = re.search(r"^litellm\[proxy\]==(\S+)", text, re.M).group(1)
        self.assertGreaterEqual(version(pinned), (1, 100, 4))


if __name__ == "__main__":
    unittest.main()
