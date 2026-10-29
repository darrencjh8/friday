"""Issue #80: a busy gateway must get time to shut down before it is killed.

Two clocks kill it today. Docker's default stop timeout is 10 s, and the
s6-overlay /init inside the image SIGKILLs every process 3 s after its own
SIGTERM (S6_KILL_GRACETIME). A gateway mid-turn needs longer than either, so
each deploy restart was recorded as an unclean exit.
"""

from pathlib import Path
import unittest

import yaml

COMPOSE_FILE = Path(__file__).parents[1] / "docker-compose.yml"


class HermesStopGraceTests(unittest.TestCase):
    def setUp(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        self.hermes = compose["services"]["hermes"]

    def test_docker_waits_a_minute_before_sigkill(self):
        self.assertEqual("60s", self.hermes.get("stop_grace_period"))

    def test_s6_kill_grace_fits_inside_the_docker_window(self):
        env = dict(entry.split("=", 1) for entry in self.hermes["environment"])
        kill_ms = int(env.get("S6_KILL_GRACETIME", "3000"))
        self.assertEqual(45000, kill_ms)
        self.assertLess(kill_ms / 1000, 60)


if __name__ == "__main__":
    unittest.main()
