"""Version and release decision of hermes-dots-desktop.yml.

Runs the real check step from the workflow file inside a scratch git repo
with a stubbed `gh`, and asserts the version and release flag it computes:
desktop tags are separate from the Android vX.Y.Z.N tags, and the daily run
releases only when desktop/ or web/ changed since the last desktop release.
"""

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "hermes-dots-desktop.yml"


def check_script():
    workflow = yaml.safe_load(WORKFLOW.read_text())
    return next(s["run"] for s in workflow["jobs"]["check"]["steps"] if s.get("id") == "check")


def git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def run_check(tags, event="schedule", release_input="", change=None):
    """tags: release tags gh lists. The repo has one commit tagged with each
    desktop tag, then (if `change`) a commit touching that path."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        repo.mkdir()
        git(repo, "init", "-q")
        (repo / "desktop").mkdir()
        (repo / "desktop" / "a").write_text("1")
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "base")
        for t in tags:
            git(repo, "tag", t)
        if change:
            path = repo / change
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("2")
            git(repo, "add", "-A")
            git(repo, "commit", "-qm", "change")
        stub = Path(tmp) / "bin"
        stub.mkdir()
        gh = stub / "gh"
        gh.write_text("#!/bin/sh\nprintf '%s' \"$GH_STUB_LIST\"\n")
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        out = Path(tmp) / "out"
        env = {**os.environ, "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}",
               "GH_STUB_LIST": "[" + ",".join(f'{{"tagName":"{t}"}}' for t in tags) + "]",
               "GITHUB_OUTPUT": str(out), "EVENT": event, "RELEASE_INPUT": release_input}
        result = subprocess.run(["bash", "-eo", "pipefail", "-c", check_script()], cwd=repo, env=env,
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        return dict(line.split("=", 1) for line in out.read_text().splitlines())


class TestDesktopVersion(unittest.TestCase):
    def test_first_release_is_0_1_0_and_ignores_android_tags(self):
        o = run_check(["v0.2.0.9"])
        self.assertEqual(o["version"], "0.1.0")
        self.assertEqual(o["release"], "true")

    def test_next_version_follows_the_highest_desktop_tag(self):
        o = run_check(["desktop-v0.1.2", "v0.2.0.9", "desktop-v0.1.10"], change="web/x")
        self.assertEqual(o["version"], "0.1.11")
        self.assertEqual(o["release"], "true")

    def test_schedule_skips_when_only_android_code_changed(self):
        o = run_check(["desktop-v0.1.3"], change="app/x")
        self.assertEqual(o["release"], "false")

    def test_dispatch_and_pull_request_publish_only_on_request(self):
        self.assertEqual(run_check(["desktop-v0.1.3"], "workflow_dispatch", "false", "desktop/x")["release"], "false")
        self.assertEqual(run_check(["desktop-v0.1.3"], "workflow_dispatch", "true")["release"], "true")
        self.assertEqual(run_check(["desktop-v0.1.3"], "pull_request", "", "desktop/x")["release"], "false")

    def test_releases_are_never_marked_latest(self):
        workflow = yaml.safe_load(WORKFLOW.read_text())
        script = "".join(s.get("run", "") for s in workflow["jobs"]["release"]["steps"])
        self.assertIn("--latest=false", script)


if __name__ == "__main__":
    unittest.main()
