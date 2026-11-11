"""Version step of hermes-dots-release.yml.

Runs the real Version step from the workflow file with a stubbed `gh`
and asserts the version it computes. friday #207, code-review findings
M1 (round 1: no previous release; round 2: max version, not latest-created)
and L1 (round 2: assert the `name` step output too).
"""

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "hermes-dots-release.yml"


def version_step_script():
    workflow = yaml.safe_load(WORKFLOW.read_text())
    for step in workflow["jobs"]["release"]["steps"]:
        if step.get("name") == "Version":
            return step["run"]
    raise AssertionError("Version step not found in hermes-dots-release.yml")


def run_version_step(list_output, list_exit=0):
    """Run the Version step with `gh release list` printing list_output.

    The stub `gh` prints list_output for `release list` (JSON, as real
    `gh --json tagName` prints) and exits 1 for `release view` (the
    computed tag does not exist yet). Returns
    (returncode, env lines, output lines).
    """
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "bin"
        stub.mkdir()
        gh = stub / "gh"
        gh.write_text(
            "#!/bin/sh\n"
            'if [ "$2" = "view" ]; then exit 1; fi\n'
            f"printf '%s' \"$GH_STUB_LIST\"\n"
            f"exit {list_exit}\n"
        )
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        env = dict(os.environ)
        env["PATH"] = str(stub) + os.pathsep + env["PATH"]
        env["GH_TOKEN"] = "stub"
        env["GH_STUB_LIST"] = list_output
        env["GITHUB_OUTPUT"] = str(Path(tmp) / "output")
        env["GITHUB_ENV"] = str(Path(tmp) / "env")
        script = Path(tmp) / "version.sh"
        script.write_text(version_step_script())
        result = subprocess.run(
            ["bash", str(script)], cwd=tmp, env=env,
            capture_output=True, text=True, timeout=30,
        )
        env_lines = (
            Path(env["GITHUB_ENV"]).read_text().splitlines()
            if Path(env["GITHUB_ENV"]).exists() else []
        )
        output_lines = (
            Path(env["GITHUB_OUTPUT"]).read_text().splitlines()
            if Path(env["GITHUB_OUTPUT"]).exists() else []
        )
        return result.returncode, env_lines, output_lines, result.stderr


def check_last_tag():
    """Run the check job's tag lookup with a stubbed `gh` that returns
    releases in creation order (oldest first), so the max tag is not
    the last line of raw output. Returns the tag the lookup produces.
    """
    workflow = yaml.safe_load(WORKFLOW.read_text())
    check_script = next(
        step["run"]
        for step in workflow["jobs"]["check"]["steps"]
        if step.get("id") == "check"
    )
    lines = check_script.splitlines()
    start = next(
        i for i, line in enumerate(lines)
        if line.strip().startswith("tags_json=$(")
    )
    end = next(
        i for i, line in enumerate(lines)
        if line.strip().startswith("last=$(")
    )
    lookup = "\n".join(lines[start:end + 1])
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "bin"
        stub.mkdir()
        gh = stub / "gh"
        gh.write_text(
            "#!/bin/sh\n"
            'printf \'[{"tagName":"v0.2.0.5"},{"tagName":"v0.2.0.34"}]\'\n'
        )
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        env = dict(os.environ)
        env["PATH"] = str(stub) + os.pathsep + env["PATH"]
        env["GH_TOKEN"] = "stub"
        script = Path(tmp) / "check.sh"
        script.write_text(lookup + '\necho "$last"\n')
        result = subprocess.run(
            ["bash", str(script)], cwd=tmp, env=env,
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stderr
        return result.stdout.strip().splitlines()[-1]


class TestVersionStep(unittest.TestCase):
    def test_no_previous_release_empty_seeds_first_version(self):
        code, env_lines, output_lines, _ = run_version_step("")
        self.assertEqual(code, 0)
        self.assertIn("VERSION_NAME=0.2.0.0", env_lines)
        self.assertIn("VERSION_CODE=100", env_lines)
        self.assertIn("name=0.2.0.0", output_lines)

    def test_no_previous_release_null_seeds_first_version(self):
        code, env_lines, output_lines, _ = run_version_step("null")
        self.assertEqual(code, 0)
        self.assertIn("VERSION_NAME=0.2.0.0", env_lines)
        self.assertIn("VERSION_CODE=100", env_lines)
        self.assertIn("name=0.2.0.0", output_lines)

    def test_out_of_order_releases_use_max_version(self):
        code, env_lines, output_lines, stderr = run_version_step(
            '[{"tagName":"v0.2.0.34"},{"tagName":"v0.2.0.5"}]'
        )
        self.assertEqual(code, 0, stderr)
        self.assertIn("VERSION_NAME=0.2.0.35", env_lines)
        self.assertIn("VERSION_CODE=135", env_lines)
        self.assertIn("name=0.2.0.35", output_lines)

    def test_check_job_uses_max_version_too(self):
        self.assertEqual(check_last_tag(), "v0.2.0.34")

    def test_new_series_code_below_max_published_fails(self):
        code, _, _, stderr = run_version_step(
            '[{"tagName":"v0.2.1.0"},{"tagName":"v0.2.0.34"}]'
        )
        self.assertNotEqual(code, 0, stderr)
        self.assertIn("not above max published", stderr)

    def test_gh_failure_fails_closed(self):
        code, env_lines, output_lines, stderr = run_version_step(
            "", list_exit=1,
        )
        self.assertNotEqual(code, 0, stderr)
        self.assertIn("gh release list failed", stderr)
        self.assertNotIn("VERSION_NAME=0.2.0.0", env_lines)
        self.assertNotIn("name=0.2.0.0", output_lines)


if __name__ == "__main__":
    unittest.main()
