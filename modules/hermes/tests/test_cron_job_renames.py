"""Seeded cron jobs are renamed in place to descriptive names, never duplicated."""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SEED = (Path(__file__).resolve().parents[1] / "50-seed-defaults").read_text(encoding="utf-8")
BLOCKS = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", SEED, re.DOTALL)
RENAME = next(b for b in BLOCKS if "RENAMES = [" in b)
OLD_TO_NEW = {
    "memory-triage": "memory-approve-queue",
    "mnemosyne-vacuum": "memory-mnemosyne-vacuum",
    "self-wiki-reminders-daily": "wiki-due-reminders",
    "self-wiki-maintenance-and-reminders": "wiki-finance-refresh",
    "self-wiki-repos-weekly": "wiki-repo-docs",
    "log-issue-triage": "ops-log-issues",
    "github-app-auth-refresh": "ops-github-token-refresh",
    "portfolio-daily-sync": "finance-portfolio-sync",
}


def job(name, i):
    return {"id": f"id{i}", "name": name, "schedule": {"kind": "cron", "expr": f"{i} 3 * * *"}, "enabled": True}


class CronJobRenameTest(unittest.TestCase):
    def run_rename(self, jobs):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "jobs.json"
            path.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
            result = subprocess.run(["python3", "-c", RENAME.replace("/opt/data/cron/jobs.json", str(path))],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(path.read_text(encoding="utf-8"))["jobs"]

    def test_every_old_name_is_renamed_in_place(self):
        before = [job(name, i) for i, name in enumerate(OLD_TO_NEW)] + [job("operator-job", 99)]

        after = self.run_rename(before)

        self.assertEqual([j["name"] for j in after], list(OLD_TO_NEW.values()) + ["operator-job"])
        for old, new in zip(before, after):
            self.assertEqual((new["id"], new["schedule"], new["enabled"]), (old["id"], old["schedule"], old["enabled"]))

    def test_second_run_changes_nothing(self):
        once = self.run_rename([job(name, i) for i, name in enumerate(OLD_TO_NEW)])

        self.assertEqual(self.run_rename(once), once)

    def test_legacy_github_name_is_renamed_when_alone(self):
        after = self.run_rename([job("github-auth-refresh", 1)])

        self.assertEqual([j["name"] for j in after], ["ops-github-token-refresh"])

    def test_both_github_names_never_produce_duplicates(self):
        after = self.run_rename([job("github-auth-refresh", 1), job("github-app-auth-refresh", 2)])

        names = [j["name"] for j in after]
        self.assertEqual(names.count("ops-github-token-refresh"), 1)
        self.assertEqual(len(after), 2)

    def test_existing_new_name_is_not_overwritten(self):
        after = self.run_rename([job("wiki-due-reminders", 1), job("self-wiki-reminders-daily", 2)])

        self.assertEqual([(j["id"], j["name"]) for j in after],
                         [("id1", "wiki-due-reminders"), ("id2", "self-wiki-reminders-daily")])

    def test_seed_blocks_only_create_new_names(self):
        seeded = set(re.findall(r'^\s+"name": "([^"]+)"', SEED, re.MULTILINE))

        self.assertFalse(seeded & set(OLD_TO_NEW), seeded & set(OLD_TO_NEW))
        self.assertLessEqual(set(OLD_TO_NEW.values()) - {"ops-github-token-refresh"}, seeded)


if __name__ == "__main__":
    unittest.main()
