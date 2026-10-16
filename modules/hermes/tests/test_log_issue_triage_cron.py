"""Contract tests for the daily, conservative log issue triage cron."""

import json
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEED = (ROOT / "modules/hermes/50-seed-defaults").read_text(encoding="utf-8")
CONFIG = (ROOT / "modules/hermes/config.yaml").read_text(encoding="utf-8")


class LogIssueTriageCronTest(unittest.TestCase):
    def test_seeds_daily_singapore_job_with_local_delivery(self):
        self.assertIn('timezone: Asia/Singapore', CONFIG)
        self.assertIn('"name": "ops-log-issues"', SEED)
        self.assertIn('"expr": "30 18 * * *"', SEED)
        self.assertIn('"deliver": "local"', SEED)
        self.assertIn('"enabled_toolsets": ["log_issue_triage", "no_mcp"]', SEED)

    def test_seed_creates_idempotent_job_with_scoped_tools(self):
        blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
        block = next(block for block in blocks if "LOG_ISSUE_TRIAGE_PROMPT" in block)
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text('{"jobs": []}', encoding="utf-8")
            runnable = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
            first = subprocess.run(["python3", "-c", runnable], text=True, capture_output=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(["python3", "-c", runnable], text=True, capture_output=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            jobs = json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"]
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["name"], "ops-log-issues")
            self.assertEqual(job["schedule"]["expr"], "30 18 * * *")
            self.assertEqual(job["enabled_toolsets"], ["log_issue_triage", "no_mcp"])
            self.assertEqual(job["workdir"], "/opt/data/log-issue-triage")
            self.assertEqual(job["model"], "auto-thinking")
            self.assertEqual(job["provider"], "custom:codex-router")
            self.assertEqual(job["deliver"], "local")

    def test_seed_preserves_custom_delivery_and_migrates_legacy_telegram(self):
        blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
        block = next(block for block in blocks if "LOG_ISSUE_TRIAGE_PROMPT" in block)
        for delivery, expected in (("slack", "slack"), ("telegram", "local"), ("origin", "local"), (None, "local")):
            with self.subTest(delivery=delivery), tempfile.TemporaryDirectory() as tmp:
                jobs_path = Path(tmp) / "cron" / "jobs.json"
                jobs_path.parent.mkdir()
                jobs_path.write_text(json.dumps({"jobs": [{
                    "id": "existing", "name": "ops-log-issues", "deliver": delivery,
                    "schedule": {"kind": "cron", "expr": "30 18 * * *"},
                }]}), encoding="utf-8")
                runnable = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
                result = subprocess.run(["python3", "-c", runnable], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                job = json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"][0]
                self.assertEqual(job["deliver"], expected)
                self.assertEqual(job["model"], "auto-thinking")
                self.assertEqual(job["provider"], "custom:codex-router")

    def test_seed_refuses_corrupt_jobs_file(self):
        blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
        block = next(block for block in blocks if "LOG_ISSUE_TRIAGE_PROMPT" in block)
        with tempfile.TemporaryDirectory() as tmp:
            jobs_path = Path(tmp) / "cron" / "jobs.json"
            jobs_path.parent.mkdir()
            jobs_path.write_text("{not json", encoding="utf-8")
            runnable = block.replace("/opt/data/cron/jobs.json", str(jobs_path))
            result = subprocess.run(["sh", "-c", f"python3 -c {shlex.quote(runnable)} || true"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)  # `|| true` in the seed
            self.assertIn("refusing to replace corrupt cron jobs file", result.stderr)
            self.assertEqual(jobs_path.read_text(encoding="utf-8"), "{not json")

    def test_prompt_uses_constrained_collection_reproduction_and_publication_tools(self):
        match = re.search(r'LOG_ISSUE_TRIAGE_PROMPT = """(.*?)"""', SEED, re.DOTALL)
        self.assertIsNotNone(match)
        prompt = match.group(1)
        for required in (
            'triage_collect_snapshot',
            'triage_run_reproducer',
            'triage_search_issues',
            'triage_publish_finding',
            'read-only, resource-limited container',
            'fix plan',
            '`[SILENT]` is allowed only when all four collections',
        ):
            self.assertIn(required, prompt)

    def test_prompt_includes_cron_health_audit_and_issue_path(self):
        match = re.search(r'LOG_ISSUE_TRIAGE_PROMPT = """(.*?)"""', SEED, re.DOTALL)
        self.assertIsNotNone(match)
        prompt = match.group(1)
        for required in (
            "triage_check_cron_health",
            "triage_publish_cron_failure",
            "missed, late, failed, or undelivered",
            "every enabled cron job",
        ):
            self.assertIn(required, prompt)

        self.assertIn('"enabled_toolsets": ["log_issue_triage", "no_mcp"]', SEED)
        self.assertNotIn('"enabled_toolsets": ["terminal", "file"]', SEED)

    def test_prompt_uses_only_constrained_plugin_tools(self):
        """The agent can call the four constrained tools, not generic shell or file tools."""
        match = re.search(r'LOG_ISSUE_TRIAGE_PROMPT = """(.*?)"""', SEED, re.DOTALL)
        self.assertIsNotNone(match)
        prompt = match.group(1)
        self.assertNotIn('log-issue-triage-worker.sh', prompt)
        self.assertNotIn('OpenCode', prompt)
        self.assertNotIn('opencode', prompt)


if __name__ == "__main__":
    unittest.main()
