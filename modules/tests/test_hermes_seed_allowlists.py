"""Boot seeding of platform allowlists into the profile .env.

Hermes authorizes a chat caller through the per-profile secret scope, not
through the process environment, so an allowlist that exists only in the
container environment is invisible to the gate under
``gateway.multiplex_profiles``. The ``50-seed-defaults`` boot hook mirrors the
deployed ``*_ALLOWED_USERS`` variables into ``$HERMES_HOME/.env`` to close that
gap; this test runs the hook's own block against a throwaway home.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SEED = Path(__file__).resolve().parents[2] / "modules" / "hermes" / "50-seed-defaults"
BLOCK_START = "<<'PYALLOWLIST'"
BLOCK_END = "\nPYALLOWLIST\n"


def load_block() -> str:
    """Return the allowlist-mirroring python block exactly as the image runs it."""
    text = SEED.read_text()
    if BLOCK_START not in text:
        raise AssertionError(
            f"{SEED} no longer seeds platform allowlists into the profile .env"
        )
    body = text.split(BLOCK_START, 1)[1].split("\n", 1)[1]
    code, _, tail = body.partition(BLOCK_END)
    if not tail:
        raise AssertionError(f"unterminated PYALLOWLIST block in {SEED}")
    return code


class SeedAllowlistTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)
        self.env_path = self.home / ".env"
        self.block = load_block()

    def seed(self, **allowlists: str) -> subprocess.CompletedProcess:
        """Run the boot hook's block with just this home and these allowlists."""
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HERMES_HOME": str(self.home)}
        env.update(allowlists)
        return subprocess.run(
            [sys.executable, "-c", self.block],
            env=env,
            capture_output=True,
            text=True,
        )

    def test_mirrors_deployed_allowlists_and_keeps_the_rest_of_the_file(self) -> None:
        self.env_path.write_text(
            "# operator notes\n"
            "# SLACK_ALLOWED_USERS=stale-in-comment\n"
            "HERMES_HOME=/opt/data\n"
            "TELEGRAM_ALLOWED_USERS=1\n"
            "OPENCODE_ZEN_API_KEY=keep-me\n"
        )
        self.env_path.chmod(0o600)

        result = self.seed(
            SLACK_ALLOWED_USERS="U00000000AA",
            TELEGRAM_ALLOWED_USERS="486674959",
            GATEWAY_ALLOWED_USERS="UANYONE",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.env_path.read_text().splitlines()
        self.assertEqual(
            lines,
            [
                "# operator notes",
                "# SLACK_ALLOWED_USERS=stale-in-comment",
                "HERMES_HOME=/opt/data",
                "TELEGRAM_ALLOWED_USERS=486674959",
                "OPENCODE_ZEN_API_KEY=keep-me",
                "SLACK_ALLOWED_USERS=U00000000AA",
            ],
        )
        # The global allow-any switch must never be frozen into a profile file.
        self.assertNotIn("GATEWAY_ALLOWED_USERS", self.env_path.read_text())

    def test_second_run_changes_nothing(self) -> None:
        self.env_path.write_text("OPENCODE_ZEN_API_KEY=keep-me\n")
        self.env_path.chmod(0o600)

        self.assertEqual(self.seed(SLACK_ALLOWED_USERS="U00000000AA").returncode, 0)
        first = self.env_path.read_text()
        inode = self.env_path.stat().st_ino

        result = self.seed(SLACK_ALLOWED_USERS="U00000000AA")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_path.read_text(), first)
        self.assertEqual(self.env_path.stat().st_ino, inode, "unchanged .env must not be rewritten")

    def test_empty_value_never_removes_an_existing_key(self) -> None:
        original = "SLACK_ALLOWED_USERS=U00000000AA\n"
        self.env_path.write_text(original)
        self.env_path.chmod(0o600)

        result = self.seed(SLACK_ALLOWED_USERS="", TELEGRAM_ALLOWED_USERS="   ")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_path.read_text(), original)

    def test_creates_a_missing_env_owner_only(self) -> None:
        result = self.seed(TELEGRAM_ALLOWED_USERS="486674959")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_path.read_text(), "TELEGRAM_ALLOWED_USERS=486674959\n")
        self.assertEqual(self.env_path.stat().st_mode & 0o777, 0o600)

    def test_without_allowlists_the_home_is_left_untouched(self) -> None:
        result = self.seed()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.env_path.exists())

    def test_profile_env_values_are_plain_and_unquoted(self) -> None:
        """Guard the ponytail ceiling: ids are mirrored verbatim, whitespace trimmed."""
        self.seed(SLACK_ALLOWED_USERS=" U00000000AA , U00000000BB \n")

        self.assertIn(
            "SLACK_ALLOWED_USERS=U00000000AA , U00000000BB",
            self.env_path.read_text(),
        )

    def test_mirrors_telegram_delivery_credentials_for_cron(self) -> None:
        """Cron delivery reads TELEGRAM_BOT_TOKEN / TELEGRAM_HOME_CHANNEL through the profile
        secret scope; without them in the profile .env it fails with "no gateway credentials"."""
        self.env_path.write_text("OPENCODE_ZEN_API_KEY=keep-me\nTELEGRAM_BOT_TOKEN=stale\n")
        self.env_path.chmod(0o600)

        result = self.seed(
            TELEGRAM_BOT_TOKEN="123456:fake-token_value",
            TELEGRAM_HOME_CHANNEL="-1001234567890",
            TELEGRAM_UNRELATED_SETTING="not-mirrored",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.env_path.read_text().splitlines(),
            [
                "OPENCODE_ZEN_API_KEY=keep-me",
                "TELEGRAM_BOT_TOKEN=123456:fake-token_value",
                "TELEGRAM_HOME_CHANNEL=-1001234567890",
            ],
        )
        self.assertEqual(self.env_path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("fake-token_value", result.stdout)

    def test_mirrors_notion_key_for_cron_skill_preflight(self) -> None:
        """Cron preflight checks a skill's required env through the profile secret scope, so a
        NOTION_API_KEY only in the container env blocks every job with the notion skill attached."""
        result = self.seed(NOTION_API_KEY="ntn_fake-key")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("NOTION_API_KEY=ntn_fake-key", self.env_path.read_text().splitlines())
        self.assertNotIn("ntn_fake-key", result.stdout)

    def test_mirrors_opencode_server_password(self) -> None:
        """The profile authenticates to the host's `opencode serve` with this password."""
        result = self.seed(OPENCODE_SERVER_PASSWORD="fake-pass!")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OPENCODE_SERVER_PASSWORD=fake-pass!", self.env_path.read_text().splitlines())
        self.assertNotIn("fake-pass!", result.stdout)

    def test_mirrors_bitwarden_access_token(self) -> None:
        """Under multiplex_profiles the Bitwarden source reads the token through
        the profile secret scope, so it must be in the profile .env."""
        result = self.seed(BWS_ACCESS_TOKEN="0.fake-bws-token")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("BWS_ACCESS_TOKEN=0.fake-bws-token", self.env_path.read_text().splitlines())
        self.assertNotIn("0.fake-bws-token", result.stdout)

    def test_unset_telegram_credentials_never_remove_existing_keys(self) -> None:
        original = "TELEGRAM_BOT_TOKEN=keep\nTELEGRAM_HOME_CHANNEL=1\n"
        self.env_path.write_text(original)
        self.env_path.chmod(0o600)

        result = self.seed(TELEGRAM_BOT_TOKEN="", TELEGRAM_HOME_CHANNEL=" ")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_path.read_text(), original)

    def test_block_is_wired_into_the_boot_hook_and_fails_loudly(self) -> None:
        text = SEED.read_text()
        self.assertRegex(text, re.compile(r"python3 <<'PYALLOWLIST' \|\| echo \"WARNING:"))


if __name__ == "__main__":
    unittest.main()
