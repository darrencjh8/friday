"""Hermes's healthy-gated dependencies get a start window that a slow server can meet.

A deploy recreates portfolio-tracker and expense-tracker before hermes. If one
is not healthy in time, compose stops there and leaves hermes created but not
running, so these must not be marked unhealthy during a slow start.
"""
from pathlib import Path
import re
import unittest

import yaml


COMPOSE = Path(__file__).parents[1] / "docker-compose.yml"


def seconds(value):
    return sum(int(n) * {"s": 1, "m": 60}[u] for n, u in re.findall(r"(\d+)([sm])", value))


class HermesDependencyHealthcheckTests(unittest.TestCase):
    def test_healthy_gated_dependencies_allow_a_slow_start(self):
        services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
        gated = [name for name, dep in services["hermes"]["depends_on"].items()
                 if dep.get("condition") == "service_healthy"]
        self.assertEqual({"expense-tracker", "portfolio-tracker"}, set(gated))
        for name in gated:
            with self.subTest(service=name):
                check = services[name]["healthcheck"]
                self.assertGreaterEqual(seconds(check["start_period"]), 120)
                self.assertLessEqual(seconds(check["start_interval"]), 10)
                self.assertGreaterEqual(seconds(check["timeout"]), 10)


if __name__ == "__main__":
    unittest.main()
