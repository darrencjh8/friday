"""deploy.yml can deploy hermes to its own runner (docs/plans/move-runtime-to-laptop.md).

A manual run picks the target from the hermes_target dropdown (default
friday-laptop). A push to main uses the default in the workflow, `server` until
the cutover PR changes it: the server job keeps hermes and deploy-hermes is
skipped, exactly as before.
"""
from pathlib import Path
import os
import stat
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"


def workflow(path=WORKFLOW):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def jobs():
    return workflow()["jobs"]


PUSH_DEFAULT = "server"


def step(job, name):
    for s in jobs()[job]["steps"]:
        if s.get("name") == name:
            return s
    raise AssertionError(f"{job} has no step {name!r}")


def split(detected, target="server", compose_services=("hermes", "expense-tracker", "codex-router")):
    """Run the split step's script and return its outputs as a dict."""
    script = step("deploy", "Split hermes off to its own runner")["run"]
    with tempfile.TemporaryDirectory() as td:
        bin_dir = Path(td) / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "docker-compose"
        stub.write_text("#!/bin/sh\nprintf '%s\\n' " + " ".join(compose_services) + "\n")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        out = Path(td) / "out"
        env = dict(os.environ, GITHUB_OUTPUT=str(out), DETECTED=detected,
                   HERMES_TARGET=target,
                   PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
        # GitHub's default bash shell flags.
        subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                       env=env, check=True, cwd=td)
        return dict(line.split("=", 1) for line in out.read_text().splitlines())


class DeployHermesRunnerTests(unittest.TestCase):
    def test_deploy_job_defaults_to_the_self_hosted_runner(self):
        self.assertEqual("${{ vars.DEPLOY_RUNNER_LABEL || 'self-hosted' }}", jobs()["deploy"]["runs-on"])

    def test_target_comes_from_the_dropdown_or_the_push_default(self):
        expr = ("${{ github.event_name == 'workflow_dispatch' && inputs.hermes_target"
                f" || '{PUSH_DEFAULT}' }}}}")
        self.assertEqual(expr, workflow()["env"]["HERMES_TARGET"])
        for path in (WORKFLOW, ROOT / ".github/workflows/deploy-codex-router.yml"):
            with self.subTest(workflow=path.name):
                # PyYAML reads the bare `on:` key as True.
                choice = workflow(path)[True]["workflow_dispatch"]["inputs"]["hermes_target"]
                self.assertEqual("choice", choice["type"])
                self.assertEqual("friday-laptop", choice["default"])
                self.assertEqual(["friday-laptop", "server"], choice["options"])

    def test_deploy_hermes_runs_only_when_the_target_is_the_laptop(self):
        job = jobs()["deploy-hermes"]
        self.assertIn("(github.event_name == 'workflow_dispatch' && inputs.hermes_target"
                      f" || '{PUSH_DEFAULT}') == 'friday-laptop'", job["if"])
        self.assertEqual("friday-laptop", job["runs-on"])
        self.assertEqual(jobs()["deploy"]["environment"], job["environment"])
        deploy = step("deploy-hermes", "Deploy hermes")
        self.assertEqual("steps.changes.outputs.hermes == 'true'", deploy["if"])
        self.assertEqual(step("deploy", "Deploy services")["env"], deploy["env"])
        self.assertEqual("bash ./modules/deploy.sh --component hermes --non-interactive --skip-build", deploy["run"])

    def test_server_target_passes_the_detected_list_through(self):
        for detected in ("all", " hermes expense-tracker", " codex-router", "hermes"):
            with self.subTest(detected=detected):
                self.assertEqual(detected, split(detected)["components"])

    def test_laptop_target_drops_hermes_from_the_server_list(self):
        self.assertEqual("expense-tracker", split(" hermes expense-tracker", "friday-laptop")["components"])
        self.assertEqual("", split("hermes", "friday-laptop")["components"])
        self.assertEqual("expense-tracker codex-router", split("all", "friday-laptop")["components"])

    def test_reports_whether_hermes_deploys(self):
        self.assertEqual("true", split("all", "friday-laptop")["hermes"])
        self.assertEqual("true", split(" hermes expense-tracker")["hermes"])
        self.assertEqual("false", split(" codex-router", "friday-laptop")["hermes"])

    def test_server_skips_build_and_deploy_when_nothing_is_left(self):
        for name in ("Build images", "Deploy services"):
            self.assertEqual("steps.changes.outputs.components != ''", step("deploy", name)["if"])


if __name__ == "__main__":
    unittest.main()
