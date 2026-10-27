"""Cron jobs keep the skills and credentials they load (issue #57)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

HERMES = Path(__file__).resolve().parents[1] / "hermes"
CONFIG = HERMES / "config.yaml"
SEED = HERMES / "50-seed-defaults"
APPROVAL_SCRIPT = HERMES / "scripts" / "curator-proposal-approval.py"
PIN_MARKER = "# Pin every skill a cron job loads"


def seed_pin_block() -> str:
    text = SEED.read_text(encoding="utf-8")
    start = text.index("python3 <<'PYEOF' || true\n", text.index(PIN_MARKER))
    start += len("python3 <<'PYEOF' || true\n")
    return text[start:text.index("\nPYEOF", start)]


class ExecuteCodePassthroughTest(unittest.TestCase):
    def test_gtasks_credentials_reach_execute_code(self):
        # execute_code scrubs *_SECRET and unlisted names unless config lists them.
        terminal = yaml.safe_load(CONFIG.read_text())["terminal"]
        self.assertLessEqual({"GTASKS_CLIENT_ID", "GTASKS_CLIENT_SECRET"},
                             set(terminal.get("env_passthrough") or []))


class SeedPinsCronSkillsTest(unittest.TestCase):
    def test_every_cron_skill_is_pinned(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "cron").mkdir()
            (tmp / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
                {"name": "a", "skills": ["llm-wiki", "gtasks-cli"], "skill": "llm-wiki"},
                {"name": "b", "skills": [], "skill": "hermes-troubleshooting"},
                {"name": "c"},
                {"name": "d", "skills": ["bad;touch pwned"]},
            ]}))
            bindir = tmp / "bin"
            bindir.mkdir()
            log = tmp / "su.log"
            (bindir / "su").write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\n')
            (bindir / "su").chmod(0o755)
            block = seed_pin_block().replace("/opt/data/cron/jobs.json", str(tmp / "cron" / "jobs.json"))
            env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}"}
            result = subprocess.run([sys.executable, "-c", block], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = log.read_text().splitlines()
        self.assertEqual(sorted(calls), sorted(
            f"-s /bin/sh hermes -c hermes curator pin {name}"
            for name in ("gtasks-cli", "hermes-troubleshooting", "llm-wiki")))


class ApprovalRefusesCronSkillMergeTest(unittest.TestCase):
    def run_approval(self, merges, jobs):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            run_dir = home / "logs" / "curator" / "20261024-201547"
            run_dir.mkdir(parents=True)
            block = yaml.safe_dump({"consolidations": merges})
            raw = json.dumps({"llm_final": f"```yaml\n{block}```", "llm_error": None}).encode()
            (run_dir / "run.json").write_bytes(raw)
            (home / "cron").mkdir()
            (home / "cron" / "jobs.json").write_text(jobs if isinstance(jobs, str) else json.dumps({"jobs": jobs}))
            proposal = f"20261024-201547-{hashlib.sha256(raw).hexdigest()[:12]}"
            env = {**os.environ, "HERMES_HOME": str(home)}
            return subprocess.run([sys.executable, str(APPROVAL_SCRIPT), proposal, "all"],
                                  env=env, text=True, capture_output=True)

    def test_merge_of_cron_skill_is_refused(self):
        result = self.run_approval(
            [{"from": "cron-job-inspection", "into": "hermes-operations", "reason": "r"}],
            [{"name": "wiki-due-reminders", "skills": ["llm-wiki", "cron-job-inspection"]}])
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("cron-job-inspection", result.stderr)
        self.assertIn("wiki-due-reminders", result.stderr)

    def test_unreadable_jobs_file_refuses(self):
        result = self.run_approval([{"from": "old-notes", "into": "notes", "reason": "r"}], "{not json")
        self.assertEqual(result.returncode, 1, result.stdout)

    def test_merge_of_unused_skill_still_passes(self):
        result = self.run_approval(
            [{"from": "old-notes", "into": "notes", "reason": "r"}],
            [{"name": "wiki-due-reminders", "skills": ["llm-wiki"]}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["merges"][0]["from"], "old-notes")


if __name__ == "__main__":
    unittest.main()
