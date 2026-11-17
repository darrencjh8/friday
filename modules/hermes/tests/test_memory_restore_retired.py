"""Reproduction for friday #221: a fresh-volume restore must not bring back
retired profiles. Runs the real memory-restore.sh against a fixture
friday-memory repo holding a retired profile (architect) and a live one
(code-reviewer), with stubbed gh and git. At base test_retired_not_restored
fails; the live-profile case stays green so a fix cannot pass by skipping
every profile.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RESTORE_SCRIPT = os.path.join(SCRIPT_DIR, "..", "scripts", "memory-restore.sh")


class TestRestoreRetired(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.fake_repo = os.path.join(self.tmp, "fake-repo")
        for profile in ("architect", "code-reviewer"):
            os.makedirs(os.path.join(self.fake_repo, "profiles", profile))
        with open(os.path.join(self.fake_repo, "MEMORY.md"), "w") as f:
            f.write("core fact\n")
        with open(
            os.path.join(self.fake_repo, "profiles", "architect", "SOUL.md"), "w"
        ) as f:
            f.write("arch soul\n")
        with open(
            os.path.join(self.fake_repo, "profiles", "architect", "config.yaml"), "w"
        ) as f:
            f.write("api_key: test\n")
        with open(
            os.path.join(self.fake_repo, "profiles", "code-reviewer", "SOUL.md"), "w"
        ) as f:
            f.write("reviewer soul\n")
        # Active profile pointer names a retired profile (#221).
        with open(os.path.join(self.fake_repo, "profiles", "_active"), "w") as f:
            f.write("architect\n")
        # Stubs: gh prints a token; git clone copies the fixture repo.
        stubbin = os.path.join(self.tmp, "stubbin")
        os.makedirs(stubbin)
        with open(os.path.join(stubbin, "gh"), "w") as f:
            f.write('#!/bin/sh\necho ghp_test_token\n')
        with open(os.path.join(stubbin, "git"), "w") as f:
            f.write(
                "#!/bin/sh\n"
                "for dest in \"$@\"; do :; done\n"
                "mkdir -p \"$dest\"\n"
                "cp -r \"$FAKE_REPO/.\" \"$dest/\" 2>/dev/null || true\n"
                "exit 0\n"
            )
        os.chmod(os.path.join(stubbin, "gh"), 0o755)
        os.chmod(os.path.join(stubbin, "git"), 0o755)
        self.data = os.path.join(self.tmp, "fresh")
        os.makedirs(self.data)
        env = dict(os.environ)
        env.update(
            {
                "MEMORY_REPO_URL": "https://example.com/owner/repo",
                "MEMORY_SRC_DIR": os.path.join(self.data, "memories"),
                "HERMES_DATA_DIR": self.data,
                "FAKE_REPO": self.fake_repo,
                "PATH": stubbin + os.pathsep + env["PATH"],
            }
        )
        subprocess.run(
            ["bash", RESTORE_SCRIPT],
            env=env,
            capture_output=True,
            check=False,
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_active_pointer_to_retired_not_restored(self):
        self.assertFalse(
            os.path.exists(os.path.join(self.data, "active_profile")),
            "active profile pointer to retired profile architect was restored",
        )

    def test_live_profile_still_restored(self):
        self.assertTrue(
            os.path.isfile(
                os.path.join(self.data, "profiles", "code-reviewer", "SOUL.md")
            )
        )

    def test_retired_not_restored(self):
        self.assertFalse(
            os.path.exists(os.path.join(self.data, "profiles", "architect")),
            "retired profile architect was restored",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
