"""deploy.sh runs its hermes steps only where hermes runs.

After the cutover the server keeps the stopped pre-cutover hermes container.
`docker inspect hermes` still succeeds there, so the skill sync, checkout
refresh and MCP reconnect must also ask hermes_here, or the server deploy fails
waiting for a container that will never start.
"""
from pathlib import Path
import os
import re
import subprocess
import unittest


DEPLOY = Path(__file__).parents[1] / "deploy.sh"


def hermes_here(**env):
    text = DEPLOY.read_text(encoding="utf-8")
    func = re.search(r"^hermes_here\(\) \{\n.*?^\}\n", text, re.S | re.M).group(0)
    base = {k: v for k, v in os.environ.items() if k not in ("HERMES_TARGET", "COMPOSE_FILE")}
    return subprocess.run(["bash", "-c", func + "hermes_here"], env={**base, **env}).returncode == 0


class HermesHereTests(unittest.TestCase):
    def test_server_target_runs_hermes_steps_on_the_server(self):
        self.assertTrue(hermes_here())
        self.assertTrue(hermes_here(HERMES_TARGET="server", COMPOSE_FILE="docker-compose.yml:docker-compose.server-lan.yml"))

    def test_laptop_target_skips_them_on_the_server(self):
        self.assertFalse(hermes_here(HERMES_TARGET="friday-laptop", COMPOSE_FILE="docker-compose.yml:docker-compose.server-lan.yml"))

    def test_laptop_target_runs_them_on_the_laptop(self):
        self.assertTrue(hermes_here(HERMES_TARGET="friday-laptop", COMPOSE_FILE="docker-compose.yml:docker-compose.laptop.yml"))

    def test_every_hermes_presence_check_also_asks_hermes_here(self):
        lines = [l for l in DEPLOY.read_text(encoding="utf-8").splitlines()
                 if "docker inspect hermes >/dev/null" in l]
        self.assertEqual(3, len(lines))
        for line in lines[1:]:
            self.assertIn("hermes_here", line)
        text = DEPLOY.read_text(encoding="utf-8")
        self.assertLess(text.index("elif ! hermes_here; then"), text.index(lines[0]))


if __name__ == "__main__":
    unittest.main()
