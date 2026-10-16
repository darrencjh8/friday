from pathlib import Path
import os
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).parents[2]
DEPLOY_WORKFLOW = ROOT / ".github/workflows/deploy.yml"
COMPOSE_FILES = tuple(sorted(ROOT.glob("modules/**/docker-compose.yml")))
EXPECTED_LOG_DRIVER = "json-file"
EXPECTED_LOG_OPTIONS = {"max-size": "10m", "max-file": "3"}


def detection_script():
    """Return the shell run by the deploy workflow's changed-module step."""
    workflow = yaml.safe_load(DEPLOY_WORKFLOW.read_text(encoding="utf-8"))
    for step in workflow["jobs"]["deploy"]["steps"]:
        if step.get("name") == "Detect changed modules":
            return step["run"]
    raise AssertionError("deploy.yml has no 'Detect changed modules' step")


class ContainerLogRotationTests(unittest.TestCase):
    def test_every_service_caps_json_file_logs(self):
        self.assertTrue(COMPOSE_FILES, "no compose files discovered")
        for compose_file in COMPOSE_FILES:
            compose = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
            for name, service in compose["services"].items():
                with self.subTest(compose=compose_file.name, service=name):
                    logging = service.get("logging")
                    self.assertIsNotNone(logging, f"{name} has no logging config")
                    self.assertEqual(EXPECTED_LOG_DRIVER, logging.get("driver"))
                    self.assertEqual(EXPECTED_LOG_OPTIONS, logging.get("options"))


class DeployChangeDetectionTests(unittest.TestCase):
    def components_for_change(self, *changed_paths):
        """Run the real detection script against a repo whose last commit touched changed_paths."""
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            output_file = Path(tmp) / "github_output"
            output_file.touch()
            git = ["git", "-c", "user.email=test@example.com", "-c", "user.name=test"]

            subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
            (repo / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(git + ["add", "-A"], cwd=repo, check=True)
            subprocess.run(git + ["commit", "-q", "-m", "base"], cwd=repo, check=True)

            for changed_path in changed_paths:
                target = repo / changed_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("changed\n", encoding="utf-8")
            subprocess.run(git + ["add", "-A"], cwd=repo, check=True)
            subprocess.run(git + ["commit", "-q", "-m", "change"], cwd=repo, check=True)

            env = {
                **os.environ,
                "GITHUB_OUTPUT": str(output_file),
                "FORCE_ALL": "false",
                "DEPLOY_COMPONENTS_OVERRIDE": "",
            }
            subprocess.run(
                ["bash", "-e", "-c", detection_script()],
                cwd=repo,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            for line in output_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("components="):
                    return line.split("=", 1)[1].strip()
            raise AssertionError("detection script wrote no components output")

    def test_compose_change_redeploys_every_service(self):
        # Every service gains or keeps its logging config only when it is
        # recreated, so a compose change must deploy all components.
        self.assertEqual("all", self.components_for_change("modules/docker-compose.yml"))

    def test_single_module_change_still_deploys_only_that_module(self):
        self.assertEqual("hermes", self.components_for_change("modules/hermes/config.yaml"))

    def test_compose_backup_file_does_not_force_full_redeploy(self):
        # The compose rule must match the exact filename, so a sibling like
        # modules/docker-compose.yml.bak cannot drag in a full redeploy.
        self.assertEqual(
            "hermes",
            self.components_for_change(
                "modules/hermes/config.yaml", "modules/docker-compose.yml.bak"
            ),
        )

    def test_compose_backup_change_alone_still_redeploys_everything(self):
        # No component prefix matches, so the empty-components fallback keeps
        # the safe "deploy everything" default.
        self.assertEqual("all", self.components_for_change("modules/docker-compose.yml.bak"))

    def test_deploy_script_change_redeploys_everything(self):
        self.assertEqual("all", self.components_for_change("modules/deploy.sh"))

    def test_codex_router_front_change_deploys_router(self):
        # The front's Caddyfile is what 4100 serves, so a change to it is a
        # router deployment even though it lives outside modules/codex-router.
        self.assertEqual(
            "codex-router",
            self.components_for_change("modules/codex-router-front/Caddyfile"),
        )


if __name__ == "__main__":
    unittest.main()
