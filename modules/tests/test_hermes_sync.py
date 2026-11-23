"""hermes-sync: the server <-> laptop folder sync (move-runtime-to-laptop.md, change 4).

The script runs against stub rsync/ssh/sqlite3/curl/openssl/sleep on PATH, so
these tests check what it would run, never touching a network or a real host.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
MODULES = ROOT / "modules"
SCRIPT = MODULES / "hermes-sync" / "sync.sh"

# Each stub appends "<name> <args>" to $CALLS. rsync fails while $FAIL exists;
# sleep heals it (removes $FAIL) once it has been called $HEAL_AFTER times.
STUBS = {
    "rsync": 'echo "rsync $*" >> "$CALLS"; [ ! -e "$FAIL" ] || { echo "connection refused" >&2; exit 12; }',
    "ssh": 'echo "ssh $*" >> "$CALLS"',
    "sqlite3": 'echo "sqlite3 $*" >> "$CALLS"',
    "curl": 'echo "curl $*" >> "$CALLS"',
    "openssl": 'cat >/dev/null; echo "HMAC-SHA2-256(stdin)= feedface"',
    "sleep": (
        'n=$(( $(cat "$SLEEPS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$SLEEPS"; '
        '[ "$n" != "${HEAL_AFTER:-}" ] || rm -f "$FAIL"'
    ),
}

ET_DIR = "/home/runner/data/expense-tracker/data"
ACCOUNTS = "/home/runner/data/hermes/data/home/wiki/entities/accounts"


class SyncScriptTests(unittest.TestCase):
    def run_sync(self, target="friday-laptop", runs=1, failing=False, **env):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        for name, body in STUBS.items():
            stub = bin_dir / name
            stub.write_text("#!/bin/sh\n" + body + "\n")
            stub.chmod(0o755)
        et = tmp / "et"
        et.mkdir()
        (et / "dedup.db").write_text("")
        (et / "wiki-proposals.jsonl").write_text("")
        if failing:
            (tmp / "fail").touch()
        result = subprocess.run(
            ["sh", str(SCRIPT)],
            env={
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "CALLS": str(tmp / "calls"),
                "FAIL": str(tmp / "fail"),
                "SLEEPS": str(tmp / "sleeps"),
                "LAPTOP_LAN_HOST": "198.51.100.20",
                "ET_DATA_DIR": str(et),
                "SNAPSHOT_DIR": str(tmp / "snap"),
                "STATE_DIR": str(tmp / "state"),
                "ACCOUNTS_DIR": str(tmp / "accounts"),
                "HERMES_SYNC_RUNS": str(runs),
                "HERMES_SYNC_INTERVAL": "0",
                **({"HERMES_TARGET": target} if target is not None else {}),
                **env,
            },
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        calls = (tmp / "calls").read_text().splitlines() if (tmp / "calls").exists() else []
        return calls, result.stdout, tmp

    def test_idle_unless_hermes_is_on_the_laptop(self):
        for target in (None, "server", ""):
            with self.subTest(target=target):
                calls, out, _ = self.run_sync(target=target)
                self.assertEqual([], calls)
                self.assertIn("idle", out)

    def test_pushes_expense_data_and_pulls_accounts(self):
        calls, out, tmp = self.run_sync()
        rsyncs = [c for c in calls if c.startswith("rsync ")]
        self.assertEqual(3, len(rsyncs), calls)
        push_files, push_snapshots, pull = rsyncs
        remote = "darren@198.51.100.20"

        # Live SQLite files go through the backup API, never a byte copy.
        self.assertIn(f"sqlite3 {tmp}/et/dedup.db .backup '{tmp}/snap/dedup.db'", calls)
        self.assertIn("--exclude=*.db", push_files)
        self.assertTrue(push_files.endswith(f"{tmp}/et/ {remote}:{tmp}/et/"), push_files)
        self.assertTrue(push_snapshots.endswith(f"{tmp}/snap/ {remote}:{tmp}/et/"), push_snapshots)
        self.assertIn("--mkpath", push_files)
        self.assertIn("-p 2222", push_files)

        # Laptop -> server never deletes and never replaces a newer server file.
        self.assertTrue(pull.endswith(f"{remote}:{tmp}/accounts/ {tmp}/accounts/"), pull)
        self.assertNotIn("--delete", pull)
        self.assertIn("--update", pull)
        # The only --delete is the push into the laptop's expense-tracker copy.
        self.assertEqual([push_files], [c for c in rsyncs if "--delete" in c])
        self.assertIn("hermes-sync: ok", out)

    def test_alerts_once_after_ten_failures_and_once_on_recovery(self):
        calls, out, _ = self.run_sync(
            runs=15, failing=True, HEAL_AFTER="12",
            NOTIFY_URL="http://hermes:8644/webhooks/notify", HERMES_WEBHOOK_SECRET="s3cret",
        )
        alerts = [c for c in calls if c.startswith("curl ")]
        self.assertEqual(2, len(alerts), alerts)
        self.assertIn("failed for 10 minutes", alerts[0])
        self.assertIn("recovered", alerts[1])
        for alert in alerts:
            self.assertIn("X-Webhook-Signature: feedface", alert)
            self.assertTrue(alert.endswith("http://hermes:8644/webhooks/notify"))
        self.assertIn("failed (10 in a row)", out)
        self.assertIn("connection refused", out)

    def test_no_alert_before_ten_failures(self):
        calls, _, _ = self.run_sync(runs=9, failing=True, NOTIFY_URL="http://hermes:8644/webhooks/notify")
        self.assertEqual([], [c for c in calls if c.startswith("curl ")])

    def test_stops_at_the_first_failed_step(self):
        calls, _, _ = self.run_sync(failing=True)
        self.assertEqual(1, len([c for c in calls if c.startswith("rsync ")]))


def server_lan_override():
    return yaml.safe_load((MODULES / "docker-compose.server-lan.yml").read_text(encoding="utf-8"))


class SyncServiceTests(unittest.TestCase):
    def test_service_mounts_exactly_the_two_synced_folders(self):
        service = server_lan_override()["services"]["hermes-sync"]
        self.assertEqual("unless-stopped", service["restart"])
        self.assertIn("HERMES_TARGET=${HERMES_TARGET:-server}", service["environment"])
        mounts = {v.split(":")[0]: v.split(":")[1] for v in service["volumes"]}
        self.assertEqual(ET_DIR, mounts[ET_DIR])
        self.assertEqual(ACCOUNTS, mounts[ACCOUNTS])
        self.assertEqual("/state", mounts["/home/runner/data/hermes-sync"])

    @unittest.skipUnless(shutil.which("docker"), "needs the docker compose CLI")
    def test_target_reaches_the_container_and_defaults_to_server(self):
        for target, expected in ((None, "server"), ("server", "server"), ("friday-laptop", "friday-laptop")):
            with self.subTest(target=target):
                env = {k: v for k, v in os.environ.items() if k != "HERMES_TARGET"}
                env.update(SERVER_LAN_HOST="198.51.100.10", LAPTOP_LAN_HOST="198.51.100.20")
                if target is not None:
                    env["HERMES_TARGET"] = target
                result = subprocess.run(
                    ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.server-lan.yml",
                     "config", "--format=json"],
                    cwd=MODULES, env=env, capture_output=True, text=True,
                )
                self.assertEqual(0, result.returncode, result.stderr)
                service = json.loads(result.stdout)["services"]["hermes-sync"]
                self.assertEqual(expected, service["environment"]["HERMES_TARGET"])
                self.assertIn("hermes=198.51.100.20", service["extra_hosts"])


class DeployWritesTheKeyTests(unittest.TestCase):
    """deploy.sh writes LAPTOP_SSH_KEY to a file only under the server LAN override."""

    def run_block(self, compose_file):
        script = (MODULES / "deploy.sh").read_text()
        start = script.index("# hermes-sync's key for the laptop")
        block = script[start:script.index("\nfi\n", start) + 4]
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        fake = tmp / "docker"
        fake.write_text('#!/bin/sh\necho "$*" > "$OUT.args"\ncat > "$OUT.stdin"\n')
        fake.chmod(0o755)
        subprocess.run(
            ["bash", "-c", block],
            env={"PATH": f"{tmp}:{os.environ['PATH']}", "COMPOSE_FILE": compose_file,
                 "LAPTOP_SSH_KEY": "KEY", "OUT": str(tmp / "out")},
            check=True,
        )
        return tmp / "out.args", tmp / "out.stdin"

    def test_key_goes_to_the_sync_state_dir_on_stdin(self):
        args, stdin = self.run_block("docker-compose.yml:docker-compose.server-lan.yml")
        self.assertIn("/home/runner/data/hermes-sync:/secrets", args.read_text())
        self.assertNotIn("KEY", args.read_text())
        self.assertEqual("KEY\n", stdin.read_text())

    def test_nothing_written_without_the_override(self):
        for compose_file in ("docker-compose.yml", "docker-compose.yml:docker-compose.laptop.yml"):
            with self.subTest(compose_file=compose_file):
                args, _ = self.run_block(compose_file)
                self.assertFalse(args.exists())

    def test_deploy_env_carries_the_key(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8"))
        for s in workflow["jobs"]["deploy"]["steps"]:
            if s.get("name") == "Deploy services":
                self.assertEqual("${{ secrets.LAPTOP_SSH_KEY }}", s["env"]["LAPTOP_SSH_KEY"])
                return
        self.fail("no Deploy services step")


if __name__ == "__main__":
    unittest.main()
