"""Guards the container network workaround for issue #553.

Docker containers here have no IPv6 route, DNS still returns an AAAA record
next to the A record, and Node's default family autoselection stalls on the
IPv6 attempt instead of handing over to IPv4. The request then dies with
ETIMEDOUT even though the same URL answers fine from the host, which is what
closed the Actual budget in the #549 incident.

`docker compose config` cannot see this: dropping the flag is valid Compose and
only shows up as intermittent production timeouts, so assert it here.
"""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
COMPOSE_FILES = tuple(sorted(ROOT.glob("modules/**/docker-compose.yml")))
EXPECTED = "NODE_OPTIONS=--no-network-family-autoselection"


def node_services():
    """Yield (compose file, service name, service) for every node service."""
    self_check = []
    for compose_file in COMPOSE_FILES:
        compose = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
        for name, service in compose["services"].items():
            build = service.get("build")
            if not build:
                continue
            path = (
                compose_file.parent
                / build["context"]
                / build.get("dockerfile", "Dockerfile")
            )
            if not path.exists():
                continue
            # Any stage may be the node one; the first FROM can build tooling.
            stages = path.read_text(encoding="utf-8").splitlines()
            if any(line.strip().startswith("FROM node:") for line in stages):
                self_check.append((compose_file, name, service))
    return self_check


class NodeServiceFamilyAutoselectionTests(unittest.TestCase):
    def test_node_services_disable_family_autoselection(self):
        services = node_services()
        self.assertTrue(services, "no node services discovered in the compose files")
        for compose_file, name, service in services:
            with self.subTest(compose=compose_file.name, service=name):
                self.assertIn(EXPECTED, service.get("environment") or [])
