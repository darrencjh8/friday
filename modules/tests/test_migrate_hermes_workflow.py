"""migrate-hermes.yml moves Hermes's data between the server and the laptop.

The migrate step runs here against stubbed docker, ssh, df and hostname.
Both "machines" share one temporary DATA_ROOT; the ssh stub runs the remote
command locally with SIDE=laptop so the stubs can tell the two apart.
"""
from pathlib import Path
import os
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
    # du and the archive; everything is logged with the side it ran on.
    "docker": (
        'side=${SIDE:-server}\n'
        'echo "$side docker $*" >> "$LOG"\n'
        'case "$1" in\n'
        '  inspect) cat "$STATE/$side" 2>/dev/null || exit 1 ;;\n'
        '  stop) echo false > "$STATE/$side" ;;\n'
        '  run)\n'
        '    case "$*" in\n'
        '      *"du -sk"*) printf "1000\\t/src\\n" ;;\n'
        '      *"-cpf"*)\n'
        '        out=$(printf "%s\\n" "$@" | sed -n "s/:\\/out$//p")\n'
        '        echo archive > "$out/hermes.tar"\n'
        '        (cd "$out" && sha256sum hermes.tar > hermes.tar.sha256) ;;\n'
        '    esac ;;\n'
        'esac\n'
    ),
}


def migrate(direction="to-laptop", dry_run="true", server="true", laptop="false",
            free_server=10_000_000, free_laptop=10_000_000, hostname_ip="server-ip"):
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

    def test_dry_run_copies_and_verifies_but_never_stops_or_extracts(self):
        for direction in ("to-laptop", "to-server"):
            with self.subTest(direction=direction):
                rc, log, outputs, _ = migrate(direction, "true", server="true", laptop="true")
                self.assertEqual(0, rc, log)
                self.assertTrue(has(log, "ssh ", "cat ", "hermes.tar"))
                self.assertTrue(has(log, "-cpf"))
                self.assertFalse(has(log, "docker stop"))
                self.assertFalse(has(log, "-xpf"))
                self.assertFalse(has(log, "mv /d/hermes"))
                self.assertNotIn("stopped_hermes", outputs)

    def test_to_laptop_stops_only_server_hermes_then_extracts_on_the_laptop(self):
        rc, log, outputs, root = migrate("to-laptop", "false")
        self.assertEqual(0, rc, log)
        self.assertEqual("true", outputs["stopped_hermes"])
        stops = [line for line in log if "docker stop" in line]
        self.assertEqual(["server docker stop -t 60 hermes"], stops)
        stop = log.index(stops[0])
        archive = next(i for i, line in enumerate(log) if " docker run " in line and not line.startswith("ssh ") and "-cpf" in line)
        self.assertLess(stop, archive)
        self.assertTrue(log[archive].startswith("server "))
        extract = [line for line in log if " docker run " in line and not line.startswith("ssh ") and "-xpf" in line]
        self.assertEqual(1, len(extract))
        self.assertTrue(extract[0].startswith("laptop "))
        self.assertIn("mv /d/hermes /d/hermes.bak-", extract[0])
        # Only the run's own stage directory is removed.
        self.assertFalse((root / ".migrate-hermes-42").exists())
        self.assertTrue((root / "hermes" / "data").is_dir())

    def test_to_laptop_refuses_while_hermes_runs_on_the_laptop(self):
        rc, log, outputs, _ = migrate("to-laptop", "false", laptop="true")
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "docker stop"))
        self.assertFalse(has(log, "-cpf"))
        self.assertNotIn("stopped_hermes", outputs)

    def test_to_server_refuses_while_hermes_runs_on_the_laptop(self):
        rc, log, _, _ = migrate("to-server", "false", server="false", laptop="true")
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "docker stop"))
        self.assertFalse(has(log, "-cpf"))

    def test_to_server_refuses_while_hermes_runs_on_the_server(self):
        rc, log, _, _ = migrate("to-server", "false", server="true", laptop="false")
        self.assertNotEqual(0, rc)
        self.assertFalse(has(log, "-cpf"))

    def test_to_server_pulls_from_the_laptop_and_extracts_on_the_server(self):
        rc, log, outputs, _ = migrate("to-server", "false", server="false", laptop="false")
        self.assertEqual(0, rc, log)
        self.assertNotIn("stopped_hermes", outputs)
        self.assertFalse(has(log, "docker stop"))
        self.assertTrue(next(line for line in log if " docker run " in line and not line.startswith("ssh ") and "-cpf" in line).startswith("laptop "))
        self.assertTrue(has(log, "ssh ", "darren@laptop-ip", "cat '"))
        extract = next(line for line in log if " docker run " in line and not line.startswith("ssh ") and "-xpf" in line)
        self.assertTrue(extract.startswith("server "))
        self.assertIn("mv /d/hermes /d/hermes.bak-", extract)

    def test_fails_before_stopping_when_either_side_lacks_space(self):
        for kwargs in ({"free_server": 10}, {"free_laptop": 10}):
            with self.subTest(**kwargs):
                rc, log, _, _ = migrate("to-laptop", "false", **kwargs)
                self.assertNotEqual(0, rc)
                self.assertFalse(has(log, "docker stop"))
                self.assertFalse(has(log, "-cpf"))

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

    def test_deletes_nothing_but_its_own_archive(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("rm -rf", text)
        self.assertNotIn("rm -r ", text)
        for line in text.splitlines():
            if "rm -f" in line and "KEY" not in line:
                self.assertIn("hermes.tar", line)

    def test_failure_restarts_the_server_hermes_it_stopped(self):
        restart = step("Restart the server's hermes after a failure")
        self.assertIn("failure()", restart["if"])
        self.assertIn("steps.migrate.outputs.stopped_hermes == 'true'", restart["if"])
        self.assertEqual("docker start hermes", restart["run"].strip())


if __name__ == "__main__":
    unittest.main()
