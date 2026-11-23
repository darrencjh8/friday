import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


MODULES = Path(__file__).parents[1]
GUARD = MODULES / "lan-guard" / "guard.sh"

# Records each call and answers `-S DOCKER-USER` from the rules file, so the
# guard script runs against a fake chain.
FAKE_IPTABLES = """#!/bin/sh
echo "$*" >> "$CALLS"
if [ "$1" = "-S" ]; then cat "$RULES"; fi
"""


class LanGuardTests(unittest.TestCase):
    def run_guard(self, existing_rules=""):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        fake = tmp / "iptables"
        fake.write_text(FAKE_IPTABLES)
        fake.chmod(0o755)
        (tmp / "rules").write_text(existing_rules)
        result = subprocess.run(
            ["sh", str(GUARD)],
            env={
                "PATH": os.environ["PATH"],
                "IPTABLES": str(fake),
                "CALLS": str(tmp / "calls"),
                "RULES": str(tmp / "rules"),
                "SERVER_LAN_HOST": "198.51.100.10",
                "LAPTOP_LAN_HOST": "198.51.100.20",
                "GUARDED_PORTS": "8080 3000",
                "LAN_GUARD_ONCE": "1",
            },
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        return (tmp / "calls").read_text().splitlines()

    def test_drops_everyone_but_the_laptop_on_the_lan_address(self):
        calls = self.run_guard()
        inserts = [c for c in calls if c.startswith("-I DOCKER-USER")]
        self.assertEqual(2, len(inserts))
        for port, rule in zip(("8080", "3000"), inserts):
            self.assertIn("--ctorigdst 198.51.100.10", rule)
            self.assertIn(f"--ctorigdstport {port}", rule)
            self.assertIn("! -s 198.51.100.20", rule)
            self.assertIn("--comment friday-lan-guard", rule)
            self.assertTrue(rule.endswith("-j DROP"))

    def test_rerun_replaces_its_own_rules_only(self):
        existing = (
            "-N DOCKER-USER\n"
            "-A DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 -m comment --comment friday-lan-guard -j DROP\n"
            "-A DOCKER-USER -s 10.0.0.0/8 -j RETURN\n"
        )
        calls = self.run_guard(existing)
        deletes = [c for c in calls if c.startswith("-D ")]
        self.assertEqual(
            ["-D DOCKER-USER -p tcp -m conntrack --ctorigdstport 8080 -m comment --comment friday-lan-guard -j DROP"],
            deletes,
        )


@unittest.skipUnless(shutil.which("docker"), "needs the docker compose CLI")
class ServerLanOverrideTests(unittest.TestCase):
    def config(self, **env):
        return subprocess.run(
            ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.server-lan.yml",
             "config", "--format=json"],
            cwd=MODULES,
            env={**os.environ, **env},
            capture_output=True,
            text=True,
        )

    def test_modules_are_published_on_the_lan_address_too(self):
        result = self.config(SERVER_LAN_HOST="198.51.100.10", LAPTOP_LAN_HOST="198.51.100.20")
        self.assertEqual(0, result.returncode, result.stderr)
        services = json.loads(result.stdout)["services"]
        for name, port in (("expense-tracker", "8080"), ("portfolio-tracker", "8081"),
                           ("actual-api", "3000"), ("whisper", "8000")):
            published = {(p.get("host_ip"), p["published"]) for p in services[name]["ports"]}
            self.assertIn(("198.51.100.10", port), published, name)

        guard = services["lan-guard"]
        self.assertEqual("host", guard["network_mode"])
        self.assertIn("NET_ADMIN", guard["cap_add"])
        self.assertIn("GUARDED_PORTS", guard["environment"])
        self.assertEqual("8080 8081 3000 8000", guard["environment"]["GUARDED_PORTS"])

    def test_missing_addresses_fail_loudly(self):
        result = self.config(SERVER_LAN_HOST="", LAPTOP_LAN_HOST="")
        self.assertNotEqual(0, result.returncode)


class DeployAlwaysRaisesLanServicesTests(unittest.TestCase):
    """deploy.sh adds the override's services to every `up` while it is active."""

    def up_targets(self, compose_file, up_targets):
        script = (MODULES / "deploy.sh").read_text()
        start = script.index("if [[ \":${COMPOSE_FILE:-}:\" == *\":docker-compose.server-lan.yml:\"* ]]")
        block = script[start:script.index("\nfi\n", start) + 4]
        result = subprocess.run(
            ["bash", "-c", block + 'echo "$UP_TARGETS"'],
            env={"PATH": os.environ["PATH"], "COMPOSE_FILE": compose_file, "UP_TARGETS": up_targets},
            capture_output=True, text=True, check=True,
        )
        return result.stdout.split()

    def test_lan_services_join_a_hermes_only_deploy(self):
        targets = self.up_targets("docker-compose.yml:docker-compose.server-lan.yml", "hermes expense-tracker ")
        self.assertEqual(
            ["hermes", "expense-tracker", "lan-guard", "portfolio-tracker", "actual-api", "whisper"], targets)

    def test_nothing_added_without_the_override(self):
        for compose_file in ("docker-compose.yml", "docker-compose.yml:docker-compose.laptop.yml", ""):
            with self.subTest(compose_file=compose_file):
                self.assertEqual(["hermes"], self.up_targets(compose_file, "hermes"))


if __name__ == "__main__":
    unittest.main()
