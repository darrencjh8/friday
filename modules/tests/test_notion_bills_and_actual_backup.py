"""Monthly Notion bill reset and the nightly Actual backup trigger."""

import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERMES = Path(__file__).resolve().parents[1] / "hermes"
SCRIPTS = HERMES / "scripts"
SEED = HERMES / "50-seed-defaults"


def seed_block():
    text = SEED.read_text(encoding="utf-8")
    start = text.index("python3 <<'PYEOF' || true\n", text.index("# Seed two no_agent jobs"))
    start += len("python3 <<'PYEOF' || true\n")
    return text[start:text.index("\nPYEOF", start)]


class FakeServer:
    """Records requests; replies with handler(method, path, body) -> (status, json)."""

    def __init__(self, handler):
        self.calls = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def _do(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"null")
                outer.calls.append((self.command, self.path, body, self.headers.get("Authorization")))
                status, payload = handler(self.command, self.path, body)
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = _do

            def log_message(self, *args):
                pass

        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def close(self):
        self.httpd.shutdown()


class BillsResetTest(unittest.TestCase):
    def run_reset(self, handler):
        server = FakeServer(handler)
        self.addCleanup(server.close)
        with tempfile.TemporaryDirectory() as home:
            Path(home, ".env").write_text("NOTION_API_KEY=k\n")
            env = {k: v for k, v in os.environ.items() if k != "NOTION_API_KEY"}
            env.update(HERMES_HOME=home, NOTION_API_BASE=server.url)
            result = subprocess.run([sys.executable, str(SCRIPTS / "notion-monthly-bills-reset.py")],
                                    env=env, text=True, capture_output=True)
        return result, server.calls

    def test_resets_every_not_started_row_across_pages(self):
        def handler(method, path, body):
            if method == "POST":
                if body.get("start_cursor"):
                    return 200, {"results": [{"id": "r3"}], "has_more": False}
                return 200, {"results": [{"id": "r1"}, {"id": "r2"}], "has_more": True, "next_cursor": "c"}
            return 200, {}

        result, calls = self.run_reset(handler)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        query = calls[0]
        self.assertEqual(query[1], "/data_sources/c19a7504-49d9-4b95-94e6-8447aaa522d3/query")
        self.assertEqual(query[2]["filter"], {"property": "Status", "status": {"does_not_equal": "Not started"}})
        self.assertEqual(query[3], "Bearer k")
        patches = [(c[1], c[2]) for c in calls if c[0] == "PATCH"]
        self.assertEqual(patches, [(f"/pages/{r}", {"properties": {"Status": {"status": {"name": "Not started"}}}})
                                   for r in ("r1", "r2", "r3")])

    def test_api_error_fails_the_run(self):
        result, _ = self.run_reset(lambda m, p, b: (403, {"message": "no access"}))
        self.assertNotEqual(result.returncode, 0)


class ActualBackupTest(unittest.TestCase):
    def run_backup(self, status):
        server = FakeServer(lambda m, p, b: (status, {"files": []} if status == 200 else {"error": "boom"}))
        self.addCleanup(server.close)
        env = {**os.environ, "ACTUAL_BACKUP_ENDPOINT": server.url + "/backup/actual"}
        result = subprocess.run(["bash", str(SCRIPTS / "actual-backup.sh")], env=env, text=True, capture_output=True)
        return result, server.calls

    def test_success_is_silent(self):
        result, calls = self.run_backup(200)
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertEqual(calls[0][:2], ("POST", "/backup/actual"))

    def test_failure_exits_nonzero_with_reason(self):
        result, _ = self.run_backup(500)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 500", result.stderr)


class SeedTest(unittest.TestCase):
    def test_seeds_both_jobs_idempotently_and_keeps_dashboard_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            jobs = Path(tmp) / "jobs.json"
            block = seed_block().replace("/opt/data/cron/jobs.json", str(jobs))
            subprocess.run([sys.executable, "-c", block], check=True, capture_output=True)
            seeded = {j["name"]: j for j in json.loads(jobs.read_text())["jobs"]}
            self.assertEqual({n: (j["script"], j["no_agent"], j["schedule"]["expr"], j["deliver"]) for n, j in seeded.items()}, {
                "notion-monthly-bills-reset": ("notion-monthly-bills-reset.py", True, "0 0 1 * *", "telegram"),
                "actual-backup": ("actual-backup.sh", True, "0 0 1 * *", "telegram"),
            })
            data = json.loads(jobs.read_text())
            for j in data["jobs"]:
                j["enabled"] = False
            jobs.write_text(json.dumps(data))
            subprocess.run([sys.executable, "-c", block], check=True, capture_output=True)
            after = json.loads(jobs.read_text())["jobs"]
            self.assertEqual(len(after), 2)
            self.assertTrue(all(j["enabled"] is False for j in after))


if __name__ == "__main__":
    unittest.main()
