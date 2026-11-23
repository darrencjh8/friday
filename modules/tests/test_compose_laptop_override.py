import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


MODULES = Path(__file__).parents[1]


@unittest.skipUnless(shutil.which("docker"), "needs the docker compose CLI")
class LaptopOverrideTests(unittest.TestCase):
    def config(self, **env):
        result = subprocess.run(
            ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.laptop.yml",
             "config", "--format=json"],
            cwd=MODULES,
            env={**os.environ, **env},
            capture_output=True,
            text=True,
        )
        return result

    def test_hermes_points_at_the_server_and_starts_alone(self):
        result = self.config(SERVER_LAN_HOST="198.51.100.10", LAPTOP_LAN_HOST="198.51.100.20",
                             SERVER_SSH_USER="friday")
        self.assertEqual(0, result.returncode, result.stderr)
        hermes = json.loads(result.stdout)["services"]["hermes"]

        self.assertFalse(hermes.get("depends_on"))
        hosts = hermes["extra_hosts"]
        for name in ("codex-router", "expense-tracker", "portfolio-tracker", "actual-api", "whisper"):
            self.assertIn(name, str(hosts))
        self.assertNotIn("127.0.0.1", str(hosts))
        self.assertIn("198.51.100.10", str(hosts))

        published = {(p.get("host_ip"), p["published"]) for p in hermes["ports"]}
        for port in ("8642", "8300", "8788", "9120"):
            self.assertIn(("198.51.100.20", port), published)
            self.assertIn(("127.0.0.1", port), published)

    def test_module_docker_reaches_the_server_over_ssh(self):
        result = self.config(SERVER_LAN_HOST="198.51.100.10", LAPTOP_LAN_HOST="198.51.100.20",
                             SERVER_SSH_USER="friday")
        self.assertEqual(0, result.returncode, result.stderr)
        hermes = json.loads(result.stdout)["services"]["hermes"]

        self.assertEqual("ssh://friday@198.51.100.10", hermes["environment"]["MODULES_DOCKER_HOST"])
        mounts = {v["target"]: v for v in hermes["volumes"]}
        self.assertTrue(mounts["/run/secrets/server-ssh"]["read_only"])
        self.assertTrue(mounts["/etc/ssh/ssh_config.d/friday-server.conf"]["read_only"])
        # The base file's mounts, the docker socket among them, are kept.
        self.assertIn("/var/run/docker.sock", mounts)
        self.assertIn("/opt/data", mounts)

    def test_server_compose_leaves_the_modules_docker_host_unset(self):
        result = subprocess.run(
            ["docker", "compose", "-f", "docker-compose.yml", "config", "--format=json"],
            cwd=MODULES, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        hermes = json.loads(result.stdout)["services"]["hermes"]
        self.assertNotIn("MODULES_DOCKER_HOST", hermes.get("environment") or {})

    def test_missing_ssh_user_fails_loudly(self):
        result = self.config(SERVER_LAN_HOST="198.51.100.10", LAPTOP_LAN_HOST="198.51.100.20",
                             SERVER_SSH_USER="")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("SERVER_SSH_USER is required", result.stderr)

    def test_missing_addresses_fail_loudly(self):
        result = self.config(SERVER_LAN_HOST="", LAPTOP_LAN_HOST="")
        self.assertNotEqual(0, result.returncode)
        self.assertIn("is required on the hermes runner", result.stderr)


if __name__ == "__main__":
    unittest.main()
