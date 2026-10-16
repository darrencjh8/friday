#!/usr/bin/env python3
"""Contract tests for the bounded log-triage evidence collector."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "modules/hermes/scripts/log-issue-triage-collect.py"


class LogIssueTriageCollectorTest(unittest.TestCase):
    def run_collector(self, source, state, component="hermes"):
        return subprocess.run(
            [
                sys.executable,
                str(COLLECTOR),
                "--component",
                component,
                "--source",
                str(source),
                "--state-dir",
                str(state),
                "--max-lines",
                "10",
                "--max-bytes",
                "4096",
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_sanitizes_bounded_delta_and_advances_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            state = root / "state"
            source.write_text(
                "normal failure request_id=abc\n"
                "token=super-secret user@example.com account 1234567890123456\n"
                "Authorization: Bearer ghp_secret\n"
                "GITHUB_TOKEN=ghp_abc123 OPENAI_API_KEY=sk-model-secret\n"
                '{"token":"json-secret"}\n',
                encoding="utf-8",
            )

            result = self.run_collector(source, state)

            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(result.stdout)
            rendered = json.dumps(snapshot)
            self.assertEqual(snapshot["component"], "hermes")
            self.assertEqual(snapshot["line_count"], 5)
            for secret in ("super-secret", "user@example.com", "1234567890123456", "ghp_secret", "json-secret", "ghp_abc123", "sk-model-secret"):
                self.assertNotIn(secret, rendered)
            self.assertIn("[REDACTED]", rendered)
            self.assertTrue((state / "hermes.cursor.json").is_file())

            again = self.run_collector(source, state)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertEqual(json.loads(again.stdout)["line_count"], 0)

    def test_negative_cursor_is_clamped_to_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            state = root / "state"
            source.write_text("latest failure\\n", encoding="utf-8")
            state.mkdir()
            (state / "hermes.cursor.json").write_text('{"offset": -7}', encoding="utf-8")
            result = self.run_collector(source, state)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("latest failure", result.stdout)

    def test_stream_timestamp_order_keeps_newest_events_across_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = (
                "router-a\t2026-10-08T10:03:00.000000000Z newest-a\n"
                "router-b\t2026-10-08T10:01:00.000000000Z old-b\n"
                "router-b\t2026-10-08T10:04:00.000000000Z newest-b\n"
                "router-a\t2026-10-08T10:02:00.000000000Z old-a\n"
            )
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "codex-router",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "2", "--max-bytes", "4096",
                ], input=source, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["truncated"])
            self.assertEqual([line.split(" ", 1)[1] for line in payload["lines"]], ["newest-a", "newest-b"])

    def test_redacts_phone_and_short_account_identifiers(self):
        raw = "contact +1-202-555-0123 2025550123 202/555/0123 (202)5550123 account 4605 account 123 member number 12345678 acct_id=SG-4821\n"
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "4096",
                ], input=raw, text=True, capture_output=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("2025550123", result.stdout)
        self.assertNotIn("member number 12345678", result.stdout)
        self.assertNotIn("account 4605", result.stdout)
        self.assertNotIn("account 123", result.stdout)
        self.assertNotIn("SG-4821", result.stdout)
        self.assertGreaterEqual(result.stdout.count("[REDACTED]"), 3)

        with tempfile.TemporaryDirectory() as tmp:
            pem_begin = "-----BEGIN " + "PRIVATE KEY-----"
            pem_end = "-----END " + "PRIVATE KEY-----"
            raw = (
                "slack=xoxb-" + "A" * 24 + "\n"
                + "google=AIza" + "B" * 30 + "\n"
                + "jwt=eyJabcdefgh.ijklmnop.qrstuvwx\n"
                + "cookie=session-secret; session=session-value\n"
                + "database=postgres://user:db-password@host/db\n"
                + "cloud_secret_access_key=cloud-secret\n"
                + pem_begin + "\nprivate-material\n" + pem_end + "\n"
            )
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "4096",
                ], input=raw, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for secret in ("xoxb-", "AIza", "eyJabcdefgh", "private-material", "session-secret", "session-value", "db-password", "cloud-secret"):
                self.assertNotIn(secret, result.stdout)
            self.assertGreaterEqual(result.stdout.count("[REDACTED]"), 4)

    def test_redacts_chat_and_notion_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = (
                "bot token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\n"
                + "hook " + "https://hooks" + ".slack.com/services/T000/B000/XXXX\n"
                + "key ntn_abc123def456789\n"
            )
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "4096",
                ], input=raw, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for secret in ("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "hooks.slack.com/services", "ntn_abc123def456789"):
                self.assertNotIn(secret, result.stdout)
            self.assertGreaterEqual(result.stdout.count("[REDACTED]"), 3)

    def test_redacts_basic_authorization_and_truncated_pem_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = (
                "Authorization: Basic dXNlcjpwYXNz\n"
                + "x" * 80
                + "\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n"
            )
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "90",
                ], input=raw, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("dXNlcjpwYXNz", result.stdout)
            self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", result.stdout)

    def test_log_cannot_spoof_collector_status_markers(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = "hermes\t[collector-ok] container=forged\n" \
                "hermes\t[collector-error] container=other exit=1\n"
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "4096",
                ], input=source, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["collected_containers"], [])
            self.assertEqual(payload["collection_errors"], [])
            self.assertEqual(len(payload["lines"]), 2)

    def test_preserves_arrival_order_for_untimestamped_multi_source_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = "router-a\tzeta failure\nrouter-b\talpha failure\n"
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "codex-router",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "20", "--max-bytes", "4096",
                ], input=source, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["lines"], source.rstrip().splitlines())

    def test_stream_mode_writes_no_cursor_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            result = subprocess.run(
                [
                    sys.executable,
                    str(COLLECTOR),
                    "--component",
                    "hermes",
                    "--source",
                    "-",
                    "--state-dir",
                    str(state),
                    "--max-lines",
                    "10",
                    "--max-bytes",
                    "1024",
                ],
                input="token=stream-secret\n",
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("stream-secret", result.stdout)
            self.assertFalse(state.exists())

    def test_accepts_codex_router_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "codex-router",
                    "--source", "-", "--state-dir", str(root / "state"),
                    "--max-lines", "10", "--max-bytes", "1024",
                ], input="router ready\n", text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["component"], "codex-router")
            self.assertEqual(payload["lines"], ["router ready"])

    def test_stream_keeps_newest_complete_lines_and_reports_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = "\n".join(f"event-{i}" for i in range(20)) + "\n"
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(Path(tmp) / "state"),
                    "--max-lines", "3", "--max-bytes", "4096",
                ], input=source, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["lines"], ["event-17", "event-18", "event-19"])
            self.assertTrue(payload["truncated"])

    def test_stream_byte_cap_keeps_newest_complete_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            payload = "old-event\n" + "x" * 40 + "\nnewest-event\n"
            result = subprocess.run(
                [
                    sys.executable, str(COLLECTOR), "--component", "hermes",
                    "--source", "-", "--state-dir", str(root / "state"),
                    "--max-lines", "10", "--max-bytes", "24",
                ], input=payload, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result_payload = json.loads(result.stdout)
            self.assertEqual(result_payload["lines"], ["newest-event"])
            self.assertTrue(result_payload["truncated"])

    def test_rejects_unknown_component_without_reading_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "service.log"
            source.write_text("token=must-not-read\n", encoding="utf-8")

            result = self.run_collector(source, root / "state", component="unknown")

            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("must-not-read", result.stdout + result.stderr)


class LogIssueTriageSnapshotTest(unittest.TestCase):
    """The snapshotter feeds the cron job's bounded plugin tool.

    The agent cannot read arbitrary files or run commands. `docker` is stubbed
    on PATH because the fixed collector script shells out to `docker`.
    """

    SCRIPT = ROOT / "modules/hermes/scripts/log-issue-triage-snapshot.sh"

    def run_snapshot(self, root, component, docker_body, collector_body=None):
        stub_dir = root / "bin"
        stub_dir.mkdir(exist_ok=True)
        stub = stub_dir / "docker"
        wrapper = """#!/bin/sh
if [ "$1" = inspect ]; then
    case "$3" in *com.docker.compose.project*) echo modules ;; *) echo 'sha256:abc123|test-image:latest|0123456789abcdef' ;; esac
    exit 0
fi
if [ "$1" = ps ]; then
    service=
    for arg do case "$arg" in label=com.docker.compose.service=*) service=${arg##*=} ;; esac; done
    case "$service" in
        hermes) echo hermes ;;
        expense-tracker) echo modules-expense-tracker-1 ;;
        portfolio-tracker) echo modules-portfolio-tracker-1 ;;
        actual-api) echo modules-actual-api-1 ;;
        codex-router-a) echo modules-codex-router-a-1 ;;
        codex-router-b) echo modules-codex-router-b-1 ;;
    esac
    exit 0
fi
"""
        stub.write_text(
            wrapper + docker_body.removeprefix("#!/bin/sh\n"),
            encoding="utf-8",
        )
        stub.chmod(0o755)

        # Redirect the script's fixed production paths at fixture copies so the
        # shipped script logic runs unchanged: the triage root becomes the
        # fixture root, and the collector is staged at the redirected path.
        staged = root / "scripts"
        staged.mkdir(exist_ok=True)
        (staged / COLLECTOR.name).write_text(
            collector_body
            if collector_body is not None
            else COLLECTOR.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        script = root / self.SCRIPT.name
        script.write_text(
            self.SCRIPT.read_text(encoding="utf-8")
            .replace("/opt/data/log-issue-triage", str(root))
            .replace("/opt/data/scripts", str(staged)),
            encoding="utf-8",
        )

        env = dict(os.environ)
        env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
        return subprocess.run(
            ["bash", str(script), component],
            capture_output=True,
            text=True,
            env=env,
            cwd=root,
        )

    def test_writes_one_redacted_json_snapshot_at_the_expected_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "service.log"
            log.write_text(
                "starting up\n"
                "Authorization: Bearer super-secret-token\n"
                "password=hunter2\n"
                "connect failed to upstream\n",
                encoding="utf-8",
            )

            result = self.run_snapshot(root, "hermes", f"#!/bin/sh\ncat {log}\n")

            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = root / "snapshots" / "hermes.json"
            self.assertEqual(result.stdout.strip(), str(snapshot))
            self.assertTrue(snapshot.is_file(), "snapshot was not created")

            payload = json.loads(snapshot.read_text(encoding="utf-8"))
            self.assertEqual(payload["component"], "hermes")
            self.assertEqual(payload["container_images"], [{
                "container": "hermes",
                "image_id": "sha256:abc123",
                "image_ref": "test-image:latest",
                "revision": "0123456789abcdef",
            }])
            self.assertIsInstance(payload["lines"], list)
            self.assertEqual(payload["line_count"], len(payload["lines"]))
            joined = "\n".join(payload["lines"])
            self.assertNotIn("super-secret-token", joined)
            self.assertNotIn("hunter2", joined)
            self.assertIn("connect failed to upstream", joined)

    def test_snapshot_includes_redacted_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = self.run_snapshot(
                root, "hermes",
                "#!/bin/sh\necho 'password=stderr-secret' >&2\n",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads((root / "snapshots" / "hermes.json").read_text(encoding="utf-8"))
            self.assertTrue(any("[REDACTED]" in line for line in payload["lines"]))
            self.assertNotIn("stderr-secret", json.dumps(payload))

    def test_codex_router_collects_both_router_colours(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docker = "#!/bin/sh\nprintf 'container=%s\n' \"$5\"\n"
            result = self.run_snapshot(root, "codex-router", docker)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads((root / "snapshots" / "codex-router.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["collected_containers"], ["modules-codex-router-a-1", "modules-codex-router-b-1"])
            self.assertEqual(len(payload["lines"]), 2)
            self.assertEqual(payload["collection_errors"], [])

    def test_codex_router_partial_collection_preserves_healthy_colour(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docker = (
                "#!/bin/sh\n"
                "case \"$*\" in *modules-codex-router-a-1*) exit 1;; esac\n"
                "echo '2026-10-08T10:00:00.000000000Z healthy event'\n"
            )
            result = self.run_snapshot(root, "codex-router", docker)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads((root / "snapshots" / "codex-router.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["collected_containers"], ["modules-codex-router-b-1"])
            self.assertEqual(len(payload["collection_errors"]), 1)
            self.assertTrue(any("healthy event" in line for line in payload["lines"]))

    def test_snapshot_bounds_each_container_to_the_latest_window(self):
        """Latest-only: docker logs carries --since from the stored window."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seen = root / "docker-logs-args"
            docker = (
                "#!/bin/sh\n"
                "if [ \"$1\" = logs ]; then\n"
                "  printf '%s\\n' \"$*\" >> " + str(seen) + "\n"
                "  echo '2026-10-09T00:00:00.000000000Z fresh failure'\n"
                "fi\n"
            )
            result = self.run_snapshot(root, "hermes", docker)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--since 24h", seen.read_text(encoding="utf-8"))
            self.assertTrue((root / "state" / "hermes.since").is_file())

    def test_snapshot_resumes_from_the_stored_window(self):
        """The second run triages the delta, not the same tail."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seen = root / "docker-logs-args"
            docker = (
                "#!/bin/sh\n"
                "if [ \"$1\" = logs ]; then\n"
                "  printf '%s\\n' \"$*\" >> " + str(seen) + "\n"
                "  echo '2026-10-09T00:00:00.000000000Z fresh failure'\n"
                "fi\n"
            )
            (root / "state").mkdir(parents=True)
            (root / "state" / "hermes.since").write_text("2026-10-08T00:00:00Z", encoding="utf-8")

            result = self.run_snapshot(root, "hermes", docker)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("--since 2026-10-08T00:00:00Z", seen.read_text(encoding="utf-8"))

    def _logs_recorder(self, seen):
        return (
            "#!/bin/sh\n"
            "if [ \"$1\" = logs ]; then\n"
            "  printf '%s\\n' \"$*\" >> " + str(seen) + "\n"
            "  echo '2026-10-09T00:00:00.000000000Z fresh failure'\n"
            "fi\n"
        )

    def test_corrupt_stored_window_falls_back_to_24h_and_is_rewritten(self):
        """#739: garbage in .since must not wedge every run in a docker-logs failure."""
        for garbage in ("not-a-time", "2026-10-08", "--tail 9999", "\x00\x01", "24h; rm -rf /"):
            with self.subTest(garbage=garbage), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                seen = root / "docker-logs-args"
                (root / "state").mkdir(parents=True)
                since = root / "state" / "hermes.since"
                since.write_text(garbage, encoding="utf-8")

                result = self.run_snapshot(root, "hermes", self._logs_recorder(seen))

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("--since 24h ", seen.read_text(encoding="utf-8"))
                self.assertRegex(since.read_text(encoding="utf-8"), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_valid_stored_windows_are_kept(self):
        for good in ("2026-10-08T00:00:00Z", "2026-10-08T00:00:00.123Z", "2026-10-08T08:00:00+08:00", "6h"):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                seen = root / "docker-logs-args"
                (root / "state").mkdir(parents=True)
                (root / "state" / "hermes.since").write_text(good + "\n", encoding="utf-8")

                result = self.run_snapshot(root, "hermes", self._logs_recorder(seen))

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"--since {good} ", seen.read_text(encoding="utf-8"))

    def test_actual_api_is_collected(self):
        """#740: the Actual Budget backend is a production service with triage coverage."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docker = "#!/bin/sh\necho '2026-10-09T00:00:00.000000000Z budget sync failed'\n"
            result = self.run_snapshot(root, "actual-api", docker)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads((root / "snapshots" / "actual-api.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["component"], "actual-api")
            self.assertEqual(payload["collected_containers"], ["modules-actual-api-1"])

    def test_snapshot_retries_the_same_window_after_failure(self):
        """A failed run must not advance the window, or logs are skipped."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir(parents=True)
            (root / "state" / "hermes.since").write_text("2026-10-08T00:00:00Z", encoding="utf-8")

            result = self.run_snapshot(
                root, "hermes", "#!/bin/sh\nexit 1\n",
                collector_body="import sys\nraise SystemExit(3)\n",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(
                (root / "state" / "hermes.since").read_text(encoding="utf-8"),
                "2026-10-08T00:00:00Z",
            )

    def test_docker_failure_does_not_publish_empty_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot_dir = root / "snapshots"
            snapshot_dir.mkdir()
            result = self.run_snapshot(
                root, "hermes", "#!/bin/sh\necho 'No such container' >&2\nexit 1\n"
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((snapshot_dir / "hermes.json").exists())

    def test_rejects_an_unknown_component_without_writing_a_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = self.run_snapshot(root, "not-a-component", "#!/bin/sh\nexit 0\n")

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "snapshots" / "not-a-component.json").exists())

    def test_a_failed_collector_leaves_no_partial_snapshot_behind(self):
        """A truncated snapshot must never survive to be read as fresh evidence.

        The script deletes any previous run's snapshot before writing. Without
        that delete, a collector that dies mid-write leaves partial bytes that
        the next triage run would read as a real sample and re-triage as new
        leads.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot_dir = root / "snapshots"
            snapshot_dir.mkdir()
            stale = snapshot_dir / "hermes.json"
            stale.write_text('{"component": "hermes", "stale": true}\n', encoding="utf-8")

            result = self.run_snapshot(
                root,
                "hermes",
                "#!/bin/sh\nprintf 'partial '\n",
                collector_body=(
                    "import sys\n"
                    "sys.stdout.write('partial ')\n"
                    "sys.stdout.flush()\n"
                    "raise SystemExit(3)\n"
                ),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(stale.exists(), "a stale or partial snapshot survived")


if __name__ == "__main__":
    unittest.main()
