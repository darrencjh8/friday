"""migrate-hermes.yml moves Hermes's data between the server and the laptop.

The migrate step runs here against stubbed docker, ssh, df and hostname.
Both "machines" share one temporary DATA_ROOT; the ssh stub runs the remote
command locally with SIDE=laptop so the stubs can tell the two apart.
"""
from pathlib import Path
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github/workflows/migrate-hermes.yml"
TEMP_DIRS = []


def tearDownModule():
    for td in TEMP_DIRS:
        shutil.rmtree(td, ignore_errors=True)


def workflow(path=WORKFLOW):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def job():
    return workflow()["jobs"]["migrate"]


def step(name):
    for s in job()["steps"]:
        if s.get("name") == name:
            return s
    raise AssertionError(f"no step {name!r}")


STUBS = {
    "hostname": 'echo "server-ip other-ip"\n',
    "ssh": (
        'echo "ssh $*" >> "$LOG"\n'
        'for last; do :; done\n'
        'SIDE=laptop exec bash -c "$last"\n'
    ),
    # The server has no rsync: any use fails the run.
    "rsync": 'echo "rsync: command not found" >&2; exit 127\n',
    "df": (
        'side=${SIDE:-server}\n'
        'var="FREE_$side"\n'
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted"\n'
        'echo "disk 1 1 ${!var} 1% /"\n'
    ),
    # docker: hermes state per side lives in $STATE/<side>; `run` emulates
    # du and rsync; everything is logged with the side it ran on. rsync's
    # dry run prints $STATE/diff, and a copy exits with $STATE/rsync_rc.
    "docker": (
        'side=${SIDE:-server}\n'
        'echo "$side docker $*" >> "$LOG"\n'
        'case "$1" in\n'
        '  inspect) cat "$STATE/$side" 2>/dev/null || exit 1 ;;\n'
        '  stop) echo false > "$STATE/$side" ;;\n'
        '  build) cat > /dev/null ;;\n'
        '  run)\n'
        '    case "$*" in\n'
        '      *"du -sk"*) printf "1000\\t/src\\n" ;;\n'
        '      *"--dry-run"*) cat "$STATE/diff" 2>/dev/null || true ;;\n'
        '      *" rsync "*) exit "$(cat "$STATE/rsync_rc" 2>/dev/null || echo 0)" ;;\n'
        '    esac ;;\n'
        'esac\n'
    ),
}


def migrate(direction="to-laptop", dry_run="true", server="true", laptop="false",
            free_server=10_000_000, free_laptop=10_000_000, hostname_ip="server-ip",
            diff="", rsync_rc=0):
    """Run the migrate step; return (returncode, log lines, outputs, data root)."""
    script = step("Migrate hermes data")["run"]
    td = tempfile.mkdtemp()
    TEMP_DIRS.append(td)
    bin_dir = Path(td) / "bin"
    bin_dir.mkdir()
    for name, body in STUBS.items():
        stub = bin_dir / name
        stub.write_text("#!/bin/bash\n" + body)
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    state = Path(td) / "state"
    state.mkdir()
    (state / "server").write_text(server + "\n")
    (state / "laptop").write_text(laptop + "\n")
    (state / "diff").write_text(diff)
    (state / "rsync_rc").write_text(f"{rsync_rc}\n")
    data_root = Path(td) / "data"
    (data_root / "hermes" / "data").mkdir(parents=True)
    log = Path(td) / "log"
    log.touch()
    out = Path(td) / "out"
    out.touch()
    env = dict(os.environ, LOG=str(log), STATE=str(state), GITHUB_OUTPUT=str(out),
               GITHUB_RUN_ID="42", DATA_ROOT=str(data_root), DIRECTION=direction,
               DRY_RUN=dry_run, SERVER_LAN_HOST=hostname_ip, LAPTOP_LAN_HOST="laptop-ip",
               LAPTOP_SSH_KEY="not-a-key", FREE_server=str(free_server),
               FREE_laptop=str(free_laptop), TMPDIR=td,
               PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                          env=env, cwd=td, capture_output=True, text=True)
    outputs = dict(line.split("=", 1) for line in out.read_text().splitlines())
    return proc.returncode, log.read_text().splitlines(), outputs, data_root


def has(lines, *parts):
    return any(all(p in line for p in parts) for line in lines)


def copies(lines):
    """rsync runs that copy (not the final dry-run check), in order."""
    return [line for line in lines if " docker run " in f" {line}" and " rsync -aH " in line
            and "--dry-run" not in line]


class MigrateHermesWorkflowTests(unittest.TestCase):
    def test_inputs_default_to_a_dry_run_to_the_laptop(self):
        inputs = workflow()[True]["workflow_dispatch"]["inputs"]
        self.assertEqual({"type": "boolean", "default": True}, {k: inputs["dry_run"][k] for k in ("type", "default")})
        self.assertEqual("choice", inputs["direction"]["type"])
        self.assertEqual("to-laptop", inputs["direction"]["default"])
        self.assertEqual(["to-laptop", "to-server"], inputs["direction"]["options"])
        self.assertEqual(["workflow_dispatch"], list(workflow()[True]))

    def test_runs_on_the_server_in_darren_prod_and_never_overlaps_a_deploy(self):
        self.assertEqual("self-hosted", job()["runs-on"])
        self.assertEqual("darren-prod", job()["environment"]["name"])
        deploy = workflow(ROOT / ".github/workflows/deploy.yml")
        self.assertEqual(deploy["concurrency"], workflow()["concurrency"])
        self.assertEqual("production-deploy", workflow()["concurrency"]["group"])

    def test_dry_run_fills_the_stage_but_never_stops_or_moves_anything(self):
        for direction in ("to-laptop", "to-server"):
            with self.subTest(direction=direction):
                rc, log, outputs, _ = migrate(direction, "true", server="true", laptop="true")
                self.assertEqual(0, rc, log)
                self.assertEqual(1, len(copies(log)))
                self.assertFalse(has(log, "docker stop"))
                self.assertFalse(has(log, "mv /d/"))
                self.assertNotIn("stopped_hermes", outputs)

    def test_dry_run_tolerates_files_vanishing_while_hermes_runs(self):
        rc, log, _, _ = migrate("to-laptop", "true", rsync_rc=24)
        self.assertEqual(0, rc, log)

    def test_to_laptop_copies_twice_around_the_stop_then_renames_the_stage_on_the_laptop(self):
        rc, log, outputs, _ = migrate("to-laptop", "false")
        self.assertEqual(0, rc, log)
        self.assertEqual("true", outputs["stopped_hermes"])
        stops = [line for line in log if "docker stop" in line]
        self.assertEqual(["server docker stop -t 60 hermes"], stops)
        # The two copies log identical lines, so compare positions.
        first, final = [i for i, line in enumerate(log) if line in copies(log)]
        stop = log.index(stops[0])
        check = next(i for i, line in enumerate(log) if "--dry-run" in line)
        self.assertLess(first, stop)
        self.assertLess(stop, final)
        self.assertLess(final, check)
        for line in (log[first], log[final], log[check]):
            self.assertTrue(line.startswith("server docker run"))
            self.assertIn("/d/hermes/ darren@laptop-ip:/d/.migrate-hermes-stage/", line)
        finish = [line for line in log if "mv /d/.migrate-hermes-stage /d/hermes" in line and not line.startswith("ssh ")]
        self.assertEqual(1, len(finish))
        self.assertTrue(finish[0].startswith("laptop docker run"))
        self.assertIn("mv /d/hermes /d/hermes.bak-", finish[0])
        self.assertLess(check, log.index(finish[0]))

    def test_a_remaining_difference_stops_before_the_stage_is_moved(self):
        rc, log, outputs, _ = migrate("to-laptop", "false", diff=">f.st...... data/state.db\n")
        self.assertNotEqual(0, rc)
        self.assertEqual("true", outputs["stopped_hermes"])
        self.assertFalse(has(log, "mv /d/"))

    def test_a_failed_final_copy_stops_before_the_stage_is_moved(self):
        rc, log, _, _ = migrate("to-laptop", "false", rsync_rc=24)
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "mv /d/"))

    def test_rsync_runs_as_root_on_both_sides_and_keeps_owners(self):
        _, log, _, _ = migrate("to-laptop", "true")
        line = copies(log)[0]
        self.assertIn("rsync -aH --numeric-ids --delete", line)
        self.assertIn("--rsync-path=export DOCKER_CONFIG=/home/darren/.docker-friday; docker run --rm -i -v", line)
        self.assertIn("StrictHostKeyChecking=yes", line)
        for side in ("server", "laptop"):
            self.assertTrue(has(log, f"{side} docker build -q -t friday-rsync:1 -"))

    def test_skips_only_the_uv_caches(self):
        excludes = re.findall(r"--exclude=(\S+)", step("Migrate hermes data")["run"])
        self.assertEqual(["/data/cache/uv/", "/data/.cache/uv/"], excludes)

    def test_to_laptop_refuses_while_hermes_runs_on_the_laptop(self):
        rc, log, outputs, _ = migrate("to-laptop", "false", laptop="true")
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "docker stop"))
        self.assertEqual([], copies(log))
        self.assertNotIn("stopped_hermes", outputs)

    def test_to_server_refuses_while_hermes_runs_on_the_laptop(self):
        rc, log, _, _ = migrate("to-server", "false", server="false", laptop="true")
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "docker stop"))
        self.assertEqual([], copies(log))

    def test_to_server_refuses_while_hermes_runs_on_the_server(self):
        rc, log, _, _ = migrate("to-server", "false", server="true", laptop="false")
        self.assertNotEqual(0, rc)
        self.assertEqual([], copies(log))

    def test_to_server_pulls_from_the_laptop_and_renames_the_stage_on_the_server(self):
        rc, log, outputs, _ = migrate("to-server", "false", server="false", laptop="false")
        self.assertEqual(0, rc, log)
        self.assertNotIn("stopped_hermes", outputs)
        self.assertFalse(has(log, "docker stop"))
        for line in copies(log):
            self.assertIn("darren@laptop-ip:/d/hermes/ /d/.migrate-hermes-stage/", line)
        finish = next(line for line in log if "mv /d/.migrate-hermes-stage /d/hermes" in line and not line.startswith("ssh "))
        self.assertTrue(finish.startswith("server docker run"))
        self.assertIn("mv /d/hermes /d/hermes.bak-", finish)

    def test_fails_before_copying_when_the_receiving_side_lacks_space(self):
        rc, log, _, _ = migrate("to-laptop", "false", free_laptop=10)
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "docker stop"))
        self.assertEqual([], copies(log))

    def test_refuses_on_a_runner_that_is_not_the_server(self):
        rc, log, _, _ = migrate("to-laptop", "false", hostname_ip="elsewhere")
        self.assertNotEqual(0, rc)
        self.assertEqual([], log)

    def test_laptop_docker_uses_the_friday_docker_config(self):
        _, log, _, _ = migrate("to-laptop", "false")
        ssh = [line for line in log if line.startswith("ssh ")]
        self.assertTrue(ssh)
        for line in ssh:
            self.assertIn("export DOCKER_CONFIG=/home/darren/.docker-friday;", line)

    def test_deletes_nothing_outside_the_stage(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("rm -r", text)
        for line in text.splitlines():
            if "rm -f" in line:
                self.assertIn("KEY", line)

    def test_failure_restarts_the_server_hermes_it_stopped(self):
        restart = step("Restart the server's hermes after a failure")
        self.assertIn("failure()", restart["if"])
        self.assertIn("steps.migrate.outputs.stopped_hermes == 'true'", restart["if"])
        self.assertEqual("docker start hermes", restart["run"].strip())


if __name__ == "__main__":
    unittest.main()
