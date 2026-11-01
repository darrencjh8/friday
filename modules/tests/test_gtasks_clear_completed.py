"""Monthly clear of completed Google Tasks, and the dedup listing it relies on (deletion: test_gtasks_delete_completed)."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERMES = Path(__file__).resolve().parents[1] / "hermes"
SCRIPTS = HERMES / "scripts"
SEED = HERMES / "50-seed-defaults"
sys.path.insert(0, str(SCRIPTS))
import gtasks  # noqa: E402


def load_clear():
    spec = importlib.util.spec_from_file_location("gtasks_clear", SCRIPTS / "gtasks-clear-completed.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seed_block():
    text = SEED.read_text(encoding="utf-8")
    start = text.index("python3 <<'PYEOF' || true\n", text.index("# Seed gtasks-clear-completed"))
    start += len("python3 <<'PYEOF' || true\n")
    return text[start:text.index("\nPYEOF", start)]


class ClearCompletedTest(unittest.TestCase):
    def test_clears_every_list_across_pages(self):
        pages = {
            "/users/@me/lists?maxResults=100": {"items": [{"id": "a"}, {"id": "b"}], "nextPageToken": "p2"},
            "/users/@me/lists?maxResults=100&pageToken=p2": {"items": [{"id": "c"}]},
        }
        calls = []

        def api(method, path, body=None):
            calls.append((method, path, body))
            return pages.get(path, {})

        with mock.patch.object(gtasks, "_api", api):
            load_clear().main()
        self.assertEqual([c for c in calls if c[0] == "POST"],
                         [("POST", f"/lists/{i}/clear", {}) for i in "abc"])
        # No list holds tasks here, so nothing is deleted.
        self.assertFalse([c for c in calls if c[0] not in ("GET", "POST")])

    def test_api_error_fails_the_run(self):
        def api(method, path, body=None):
            raise RuntimeError("Tasks API error: boom")

        with mock.patch.object(gtasks, "_api", api), self.assertRaises(RuntimeError):
            load_clear().main()


class DedupListingTest(unittest.TestCase):
    def test_completed_listing_includes_hidden_and_pages(self):
        seen = []

        def api(method, path, body=None):
            seen.append(path)
            return {"items": [{"id": "1"}], "nextPageToken": "t"} if "pageToken" not in path else {"items": [{"id": "2"}]}

        with mock.patch.object(gtasks, "_api", api):
            items = gtasks._ordered_tasks("L", include_completed=True)
        self.assertEqual([t["id"] for t in items], ["1", "2"])
        self.assertIn("showHidden=true", seen[0])
        self.assertIn("pageToken=t", seen[1])

    def test_open_listing_hides_hidden(self):
        paths = []
        with mock.patch.object(gtasks, "_api", lambda m, p, b=None: paths.append(p) or {}):
            gtasks._ordered_tasks("L")
        self.assertIn("showHidden=false", paths[0])


class SeedTest(unittest.TestCase):
    def test_seeds_monthly_no_agent_job_and_keeps_dashboard_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp) / "jobs.json"
            block = seed_block().replace("/opt/data/cron/jobs.json", str(jobs))
            subprocess.run([sys.executable, "-c", block], check=True, capture_output=True)
            job = json.loads(jobs.read_text())["jobs"][0]
            self.assertEqual((job["name"], job["script"], job["no_agent"], job["schedule"]["expr"], job["deliver"]),
                             ("gtasks-clear-completed", "gtasks-clear-completed.py", True, "0 7 1 * *", "telegram"))
            data = json.loads(jobs.read_text())
            data["jobs"][0]["enabled"] = False
            data["jobs"][0]["script"] = "old.py"
            jobs.write_text(json.dumps(data))
            subprocess.run([sys.executable, "-c", block], check=True, capture_output=True)
            jobs_after = json.loads(jobs.read_text())["jobs"]
            self.assertEqual(len(jobs_after), 1)
            self.assertFalse(jobs_after[0]["enabled"])
            self.assertEqual(jobs_after[0]["script"], "gtasks-clear-completed.py")


if __name__ == "__main__":
    unittest.main()
