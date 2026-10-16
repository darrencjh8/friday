#!/usr/bin/env python3
"""Focused seed-block tests that avoid optional runtime dependencies."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "50-seed-defaults"


def extract_block(marker: str) -> str:
    text = SEED.read_text()
    pos = text.index(marker)
    tags = ("python3 <<'PYEOF' || true\n", "python3 <<'PYEOF'\n")
    for tag in tags:
        start = text.find(tag, pos)
        if start >= 0:
            end = text.find("\nPYEOF", start + len(tag))
            if end >= 0:
                return text[start + len(tag):end]
    raise AssertionError(f"seed block boundaries missing for {marker}")


def run_seed_block(block: str, jobs_path: Path) -> list[dict]:
    rendered = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
    subprocess.run(["python3", "-c", rendered], check=True, capture_output=True, text=True)
    return json.loads(jobs_path.read_text())["jobs"]


class SeedAppCronTests(unittest.TestCase):
    def test_app_refresh_seed_and_migration(self) -> None:
        block = extract_block("# Seed ops-github-token-refresh")
        rename = extract_block("# Rename seeded cron jobs")
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text('{"jobs": []}')

            jobs = run_seed_block(block, jobs_path)
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["name"], "ops-github-token-refresh")
            self.assertEqual(
                job["schedule"],
                {"kind": "interval", "minutes": 15, "display": "every 15m"},
            )
            self.assertEqual(job["schedule_display"], "every 15m")
            self.assertEqual(job["script"], "github-auth.sh")
            self.assertTrue(job["no_agent"])
            self.assertEqual(job["deliver"], "local")
            self.assertNotIn("prompt", job)

            run_seed_block(block, jobs_path)
            self.assertEqual(len(json.loads(jobs_path.read_text())["jobs"]), 1)

            jobs[0]["name"] = "github-auth-refresh"
            jobs[0]["schedule"] = {
                "kind": "interval",
                "minutes": 50,
                "display": "every 50m",
            }
            jobs[0]["schedule_display"] = "every 50m"
            jobs_path.write_text(json.dumps({"jobs": jobs}))
            run_seed_block(rename, jobs_path)
            migrated = run_seed_block(block, jobs_path)
            self.assertEqual(len(migrated), 1)
            self.assertEqual(migrated[0]["name"], "ops-github-token-refresh")
            self.assertEqual(migrated[0]["schedule"]["minutes"], 15)

    def test_boot_app_precedes_pat(self) -> None:
        text = SEED.read_text()
        block = text[text.index("Configure gh CLI authentication"):]
        block = block[:block.index("# The container's own codex-router checkout")]
        self.assertIn("GH_APP_ID", block)
        self.assertIn("github-auth.sh", block)
        # The fallback PAT arrives as the root-only secret file, not as an
        # ambient FRIDAY_PAT environment variable, and `su -m` carries the prefix
        # assignment to the helper so the single-quoted body needs no expansion.
        self.assertIn("/run/secrets/friday_pat", block)
        self.assertIn('GH_PAT="$PAT"', block)
        self.assertIn(
            "GH_PAT=\"$PAT\" su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/github-auth.sh'",
            block,
        )
        self.assertNotIn("FRIDAY_PAT", block)
        # The boot hook is the only reader of the secret file. It must require a
        # regular, readable, non-empty file so a directory left behind by a
        # missing-source bind mount cannot be used as a credential.
        self.assertIn("[ -f /run/secrets/friday_pat ] && [ -s /run/secrets/friday_pat ] && [ -r /run/secrets/friday_pat ]", block)
        # The retired flat token file is cleared on every boot.
        self.assertIn("rm -f /opt/data/.gh_token", block)
        helper = (ROOT / "scripts/github-auth.sh").read_text()
        self.assertIn('export HOME="${GH_HOME:-/opt/data/home}"', helper)

    def test_boot_refresh_scopes_pat_instead_of_ambient_gh_token(self) -> None:
        text = SEED.read_text()
        refresh = text[text.index("# The container's own codex-router checkout"):]
        refresh = refresh[:refresh.index("python3 -c '")]
        # The scoped credential is read from the secret file, never from an
        # ambient FRIDAY_PAT, and `su -m` passes the prefix assignment through.
        self.assertIn('GH_TOKEN="$(cat /run/secrets/friday_pat)"', refresh)
        self.assertNotIn("FRIDAY_PAT", refresh)
        self.assertIn(
            "GH_TOKEN=\"$(cat /run/secrets/friday_pat)\" su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh'",
            refresh,
        )
        self.assertIn("/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh", refresh)

    def test_seed_idempotence_runs_against_existing_jobs_file(self) -> None:
        text = (ROOT / "tests/test-50-seed-defaults.sh").read_text()
        marker = 'echo "--- idempotent (no duplicate) ---"'
        segment = text[text.index(marker):text.index('echo ""', text.index(marker) + len(marker))]
        self.assertIn("SEED_JOBS_PRIMED=1", segment)
        self.assertIn('run_seed_python "$github_auth_snippet"', segment)
        self.assertIn("count", segment)

    def test_auth_helper_pins_home_and_switches_app(self) -> None:
        text = (ROOT / "scripts/github-auth.sh").read_text()
        self.assertIn('export HOME="${GH_HOME:-/opt/data/home}"', text)
        self.assertIn('export GH_CONFIG_DIR=', text)
        self.assertIn("gh auth switch", text)
        self.assertIn("APP_SLUG", text)
        # One shared completeness predicate decides App vs fallback, and the
        # retired flat token file is cleared on every exit path.
        self.assertIn("app_config_complete", text)
        self.assertIn("cleanup_legacy_token", text)

    def test_boot_refresh_keeps_the_refresh_contract(self) -> None:
        # The scoped PAT and the App credential share one helper, so the boot
        # refresh must still pass an explicit GH_TOKEN to the same script path.
        text = SEED.read_text()
        refresh = text[text.index("# The container's own codex-router checkout"):]
        self.assertIn("GH_TOKEN=\"$(cat /run/secrets/friday_pat)\"", refresh)
        self.assertIn("refresh-codex-router-checkout.sh", refresh)
        self.assertIn('|| echo "WARNING: could not advance the codex-router checkout', refresh)


if __name__ == "__main__":
    unittest.main(verbosity=2)
