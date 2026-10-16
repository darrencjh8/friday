"""Security contracts for the narrow log-triage plugin tools."""

import datetime as dt
import importlib.util
import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/log-issue-triage/__init__.py"
spec = importlib.util.spec_from_file_location("log_issue_triage_plugin", PLUGIN_PATH)
triage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triage)


class LogIssueTriagePluginTest(unittest.TestCase):
    def setUp(self):
        triage._SNAPSHOTS.clear()
        triage._PROOFS.clear()
        self.state_tmp = tempfile.TemporaryDirectory()
        self.state_patch = patch.object(triage, "_STATE_ROOT", Path(self.state_tmp.name))
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.addCleanup(self.state_tmp.cleanup)

    def test_registers_only_narrow_plugin_tools(self):
        class Context:
            def __init__(self):
                self.tools = []

            def register_tool(self, **kwargs):
                self.tools.append(kwargs)

        context = Context()
        triage.register(context)
        self.assertEqual({tool["toolset"] for tool in context.tools}, {"log_issue_triage"})
        self.assertEqual(
            {tool["name"] for tool in context.tools},
            {"triage_collect_snapshot", "triage_run_reproducer", "triage_search_issues", "triage_publish_finding", "triage_check_cron_health", "triage_publish_cron_failure"},
        )

    def test_registered_handlers_return_json_strings(self):
        # The gateway rejects dict tool results ("unsupported result type: dict").
        class Context:
            def __init__(self):
                self.tools = {}

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs["handler"]

        context = Context()
        with patch.object(triage, "_cron_health", return_value={"status": "healthy"}):
            triage.register(context)
        result = context.tools["triage_check_cron_health"]({})
        self.assertIsInstance(result, str)
        self.assertEqual(json.loads(result), {"status": "healthy"})

    def test_cron_health_reports_scheduled_failure_and_persists_no_untrusted_finding(self):
        now = dt.datetime(2026, 10, 9, 0, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jobs.json").write_text(json.dumps({"jobs": [{
                "id": "job-1", "name": "broken-job", "enabled": True,
                "schedule": {"kind": "cron", "expr": "0 * * * *"},
                "deliver": "telegram", "last_status": "blocked_config",
                "last_run_at": "2026-10-08T23:00:01+00:00",
                "next_run_at": "2026-10-09T01:00:00+00:00",
            }]}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text(str(now.timestamp()), encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.execute("INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?)", (
                "job-1", "failed", "2026-10-08T23:00:01+00:00", "2026-10-08T23:00:02+00:00",
                "[blocked_config] Telegram unavailable", "failed", "2026-10-08T23:00:00+00:00",
            ))
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["finding_count"], 1)
        self.assertEqual(result["findings"][0]["job_id"], "job-1")
        self.assertIn("blocked_config", result["findings"][0]["detail"])
        self.assertNotIn("Authorization", result["findings"][0]["detail"])
        self.assertTrue(result["finding_id"] in triage._CRON_FINDINGS)

        with patch.object(triage, "_MAX_STATE_RECORDS", 2):
            for index in range(3):
                triage._persist_record("proofs", f"{index + 1:032x}", {"index": index})
        records = list((Path(self.state_tmp.name) / "proofs").glob("*.json"))
        self.assertEqual(len(records), 2)

    def test_cron_health_reports_overdue_invocation(self):
        now = dt.datetime(2026, 10, 9, 2, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jobs.json").write_text(json.dumps({"jobs": [{
                "id": "job-overdue", "name": "overdue-job", "enabled": True,
                "schedule": {"kind": "cron", "expr": "0 * * * *"},
                "last_status": "ok", "next_run_at": "2026-10-09T01:00:00+00:00",
            }]}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text(str(now.timestamp()), encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["findings"][0]["kind"], "invocation_missing")

    def test_cron_health_ignores_fresh_active_execution(self):
        now = dt.datetime(2026, 10, 9, 2, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jobs.json").write_text(json.dumps({"jobs": [{
                "id": "job-running", "name": "running-job", "enabled": True,
                "schedule": {"kind": "cron", "expr": "0 * * * *"},
            }]}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text(str(now.timestamp()), encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.execute("INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?)", (
                "job-running", "running", "2026-10-09T01:59:00+00:00", None, None, None, "2026-10-09T02:00:00+00:00",
            ))
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["finding_count"], 0)

    def test_cron_health_rejects_nonfinite_heartbeat(self):
        now = dt.datetime(2026, 10, 9, 2, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jobs.json").write_text(json.dumps({"jobs": []}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text("nan", encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["findings"][0]["kind"], "ticker_unavailable")

    def test_cron_health_treats_delivery_queued_metadata_as_success(self):
        now = dt.datetime(2026, 10, 9, 2, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "jobs.json").write_text(json.dumps({"jobs": [{
                "id": "job-queued", "name": "queued-job", "enabled": True,
                "schedule": {"kind": "cron", "expr": "0 * * * *"},
                "last_status": "delivery_queued", "last_delivery_queued": True,
            }]}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text(str(now.timestamp()), encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.execute("INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?)", (
                "job-queued", "completed", "2026-10-09T02:00:01+00:00", "2026-10-09T02:00:02+00:00",
                None, "queued", "2026-10-09T02:00:00+00:00",
            ))
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["finding_count"], 0)

        observed = dt.datetime(2026, 10, 9, 0, 0, tzinfo=dt.timezone.utc)
        first = triage._cron_finding("scheduler", "cron-scheduler", "ticker_stale", "ticker heartbeat is 301 seconds old", observed)
        second = triage._cron_finding("scheduler", "cron-scheduler", "ticker_stale", "ticker heartbeat is 900 seconds old", observed + dt.timedelta(minutes=10))
        self.assertEqual(first["finding_id"], second["finding_id"])

    def test_cron_health_returns_all_findings(self):
        now = dt.datetime(2026, 10, 9, 2, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = [{"id": f"job-{i}", "name": f"job-{i}", "enabled": True,
                     "schedule": {"kind": "cron", "expr": "0 * * * *"},
                     "next_run_at": "2026-10-09T01:00:00+00:00"} for i in range(60)]
            (root / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
            (root / "ticker_heartbeat").write_text(str(now.timestamp()), encoding="utf-8")
            db = sqlite3.connect(root / "executions.db")
            db.execute("CREATE TABLE executions (job_id TEXT, status TEXT, claimed_at TEXT, finished_at TEXT, error TEXT, delivery_outcome TEXT, scheduled_instant TEXT)")
            db.commit()
            db.close()
            with patch.object(triage, "_CRON_ROOT", root), patch.object(triage, "_now", return_value=now):
                result = triage._cron_health({})
        self.assertEqual(result["finding_count"], 60)
        self.assertEqual(len(result["findings"]), 60)

    def test_cron_health_publication_uses_live_finding_and_verifies_issue(self):
        finding = {
            "finding_id": "f" * 32, "job_id": "job-1", "job_name": "broken-job",
            "kind": "delivery_failed", "detail": "delivery outcome was failed",
            "observed_at": "2026-10-09T00:00:00+00:00", "schedule": {"kind": "cron", "expr": "0 * * * *"},
        }
        triage._CRON_FINDINGS[finding["finding_id"]] = finding
        url = "https://github.com/darrencjh8/friday/issues/913"
        captured = {}
        def fake_run(args, **kwargs):
            if args[:3] == ["gh", "issue", "list"]:
                return {"ok": True, "returncode": 0, "stdout": "[]", "stderr": ""}
            if args[:3] == ["gh", "issue", "create"]:
                captured["body"] = Path(args[-1]).read_text(encoding="utf-8")
                return {"ok": True, "returncode": 0, "stdout": url + "\n", "stderr": ""}
            if args[:3] == ["gh", "issue", "view"]:
                return {"ok": True, "returncode": 0, "stdout": json.dumps({
                    "number": 913, "title": "[cron] broken-job: delivery_failed",
                    "body": captured["body"], "url": url,
                }), "stderr": ""}
            raise AssertionError(args)
        with patch.object(triage, "_run", side_effect=fake_run):
            result = triage._publish_cron_failure({"finding_id": finding["finding_id"]})
        self.assertEqual(result["status"], "verified")
        self.assertIn(finding["finding_id"], captured["body"])

        snapshot = {"component": "hermes", "collection_errors": ["docker log failure"], "truncated": True}
        with patch.object(triage, "_run", return_value={"ok": True, "stdout": "", "stderr": ""}):
            with patch.object(triage.Path, "read_text", return_value=json.dumps(snapshot)):
                result = triage._collect({"component": "hermes"})
        self.assertEqual(result["status"], "partial")
        self.assertNotIn("collection_id", result)
        self.assertNotIn("hermes", triage._SNAPSHOTS)

    def test_clean_collection_is_persisted_for_a_later_plugin_process(self):
        snapshot = {
            "component": "hermes",
            "container_images": [{"image_id": "sha256:" + "b" * 64, "revision": "a" * 40}],
            "collection_errors": [],
            "truncated": False,
        }
        with tempfile.TemporaryDirectory() as tmp:
            state_root = Path(tmp) / "state"
            snapshot_root = Path(tmp) / "snapshots"
            snapshot_root.mkdir()
            (snapshot_root / "hermes.json").write_text(json.dumps(snapshot), encoding="utf-8")
            with patch.object(triage, "_STATE_ROOT", state_root), patch.object(triage, "_SNAPSHOT_ROOT", snapshot_root):
                with patch.object(triage, "_run", return_value={"ok": True, "stdout": "", "stderr": ""}):
                    result = triage._collect({"component": "hermes"})
                collection_id = result["collection_id"]
                triage._SNAPSHOTS.clear()
                self.assertEqual(triage._load_record("collections", collection_id)["component"], "hermes")

    def test_reproduction_requires_the_exact_collection_id(self):
        revision = "a" * 40
        image_id = "sha256:" + "b" * 64
        triage._SNAPSHOTS["collection-clean"] = {
            "component": "hermes",
            "container_images": [{"image_id": image_id, "revision": revision}],
        }
        with patch.object(triage, "_run") as run:
            result = triage._reproduce({
                "component": "hermes", "collection_id": "collection-two",
                "revision": revision, "command": "true", "fixture": "", "expected_exit_code": 0,
            })
        self.assertEqual(result["status"], "blocked")
        run.assert_not_called()

    def test_trivial_exit_with_model_chosen_code_is_not_reproduction_evidence(self):
        revision = "a" * 40
        triage._SNAPSHOTS["collection-clean"] = {
            "component": "hermes",
            "container_images": [{"image_id": "sha256:" + "b" * 64, "revision": revision}],
        }
        def fake_run(args, **kwargs):
            if args[:3] == ["gh", "repo", "clone"]:
                Path(args[4]).mkdir()
                return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}
            if args[0] == "docker":
                return {"ok": False, "returncode": 2, "stdout": "", "stderr": ""}
            return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}
        with patch.object(triage, "_run", side_effect=fake_run):
            result = triage._reproduce({
                "component": "hermes", "collection_id": "collection-clean",
                "revision": revision, "command": "python -m unittest -v tests.test_regression", "fixture": "",
            })
        self.assertEqual(result["status"], "execution_failed")
        self.assertFalse(result["completed"])

    def test_reproducer_enforces_networkless_readonly_container_and_image_revision(self):
        revision = "a" * 40
        image_id = "sha256:" + "b" * 64
        triage._SNAPSHOTS["collection-clean"] = {
            "component": "hermes",
            "container_images": [
                {"image_id": "sha256:" + "c" * 64, "revision": "d" * 40},
                {"image_id": image_id, "revision": revision},
            ],
        }
        seen = []
        docker_inputs = []

        def fake_run(args, **kwargs):
            seen.append(args)
            if args[:3] == ["gh", "repo", "clone"]:
                Path(args[4]).mkdir()
                (Path(args[4]) / "src.py").write_text("fixed source", encoding="utf-8")
                return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}
            if args[0] == "docker":
                docker_inputs.append(kwargs.get("input_bytes"))
                if len(docker_inputs) == 1:
                    return {"ok": True, "returncode": 0, "stdout": "Ran 1 test in 0.01s\nOK\n", "stderr": ""}
                return {"ok": False, "returncode": 1, "stdout": "test_bug (tests.test_regression.TestCase.test_bug) ... FAIL\n\nFAIL: test_bug (tests.test_regression.TestCase.test_bug)\nRan 1 test in 0.01s\n\nFAILED (failures=1)\n", "stderr": ""}
            return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}

        with patch.object(triage, "_run", side_effect=fake_run):
            result = triage._reproduce({
                "component": "hermes", "collection_id": "collection-clean", "revision": revision,
                "command": "python -m unittest -v tests.test_regression",
                "fixture": "sanitized fixture",
            })

        self.assertEqual(result["status"], "executed")
        triage._PROOFS.clear()
        self.assertTrue(triage._load_record("proofs", result["reproduction_id"])["completed"])
        docker = next(args for args in seen if args[0] == "docker")
        self.assertIn("--network=none", docker)
        self.assertIn("--read-only", docker)
        self.assertIn("--cap-drop=ALL", docker)
        self.assertIn("--security-opt=no-new-privileges", docker)
        self.assertIn("--pids-limit=64", docker)
        self.assertIn(image_id, docker)
        self.assertIn("-i", docker)
        self.assertNotIn("--mount", docker)
        self.assertIn("/triage:rw,nosuid,nodev,size=64m,mode=1777", docker)
        self.assertIn(revision, result["revision"])
        self.assertTrue(any("ulimit -f 32768" in arg and "head -c 65536" in arg for arg in docker))
        with tarfile.open(fileobj=io.BytesIO(docker_inputs[1])) as archive:
            self.assertEqual(set(archive.getnames()), {"src.py", "fixture.txt"})
        self.assertNotIn("/var/run/docker.sock", " ".join(docker))

    def test_reproducer_blocks_wrong_revision_before_fetch_or_execution(self):
        triage._SNAPSHOTS["collection-clean"] = {
            "component": "hermes",
            "container_images": [{"image_id": "sha256:" + "b" * 64, "revision": "a" * 40}],
        }
        with patch.object(triage, "_run") as run:
            result = triage._reproduce({
                "component": "hermes", "collection_id": "collection-clean", "revision": "c" * 40,
                "command": "python -m unittest -v tests.test_regression", "fixture": "",
            })
        self.assertEqual(result["status"], "blocked")
        run.assert_not_called()

    def test_publication_does_not_authorize_from_persisted_proof(self):
        proof_id = "a" * 32
        proof = {
            "reproduction_id": proof_id, "component": "hermes", "completed": True,
            "revision": "a" * 40, "image_id": "sha256:" + "b" * 64,
            "command": "python -m unittest -v tests.test_regression", "stdout": "failure",
        }
        triage._persist_record("proofs", proof_id, proof)
        result = triage._publish({
            "component": "hermes", "reproduction_id": proof_id,
            "title": "Defect", "body": "Evidence",
        })
        self.assertEqual(result["status"], "blocked")

    def test_reproduction_requires_fixture_sensitive_regression(self):
        revision = "a" * 40
        triage._SNAPSHOTS["collection-clean"] = {
            "component": "hermes",
            "container_images": [{"image_id": "sha256:" + "b" * 64, "revision": revision}],
        }
        docker_calls = []
        def fake_run(args, **kwargs):
            if args[:3] == ["gh", "repo", "clone"]:
                Path(args[4]).mkdir()
                return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}
            if args[0] == "docker":
                docker_calls.append((args, kwargs.get("input_bytes")))
                if len(docker_calls) == 1:
                    return {"ok": True, "returncode": 0, "stdout": "Ran 1 test in 0.01s\nOK\n", "stderr": ""}
                return {"ok": False, "returncode": 1, "stdout": "FAIL: test_bug (tests.test_regression.TestCase.test_bug)\nRan 1 test in 0.01s\nFAILED (failures=1)\n", "stderr": ""}
            return {"ok": True, "returncode": 0, "stdout": "", "stderr": ""}
        with patch.object(triage, "_run", side_effect=fake_run):
            result = triage._reproduce({
                "component": "hermes", "collection_id": "collection-clean", "revision": revision,
                "command": "python -m unittest -v tests.test_regression", "fixture": "incident",
            })
        self.assertEqual(result["status"], "executed")
        self.assertTrue(result["completed"])
        self.assertEqual(len(docker_calls), 2)
        with tarfile.open(fileobj=io.BytesIO(docker_calls[0][1])) as archive:
            self.assertNotIn("fixture.txt", archive.getnames())
        with tarfile.open(fileobj=io.BytesIO(docker_calls[1][1])) as archive:
            self.assertIn("fixture.txt", archive.getnames())

    def test_publication_blocks_sensitive_content(self):
        triage._PROOFS["proof"] = {"component": "hermes", "completed": True}
        result = triage._publish({
            "component": "hermes", "reproduction_id": "proof",
            "title": "Defect", "body": "Authorization: Basic dXNlcjpwYXNz",
        })
        self.assertEqual(result["status"], "blocked")

    def test_publication_blocks_chat_and_notion_tokens(self):
        triage._PROOFS["proof"] = {"component": "hermes", "completed": True}
        with patch.object(triage, "_run") as run:
            for body in (
                "token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
                "hook " + "https://hooks" + ".slack.com/services/T000/B000/XXXX",
                "key ntn_abc123def456789",
            ):
                result = triage._publish({
                    "component": "hermes", "reproduction_id": "proof",
                    "title": "Defect", "body": body,
                })
                self.assertEqual(result["status"], "blocked", body)
        run.assert_not_called()

    def test_publication_blocks_phone_and_short_account_identifiers(self):
        triage._PROOFS["proof"] = {
            "component": "hermes", "completed": True, "fixture_sensitive": True,
            "reproduction_id": "proof", "revision": "a" * 40,
            "image_id": "sha256:" + "b" * 64, "command": "python -m unittest -v tests.test_regression",
            "public_stdout": "FAIL: test_bug (tests.test_regression.TestCase.test_bug)\nRan 1 test in 0.01s\nFAILED (failures=1)",
        }
        with patch.object(triage, "_run") as run:
            for body in ("Contact +1-202-555-0123", "Contact 2025550123", "Contact 202/555/0123", "Contact (202)5550123", "Affected account 4605", "Affected account 123", "Affected member number 12345678", "acct_id=SG-4821", "cloud_secret_access_key=cloud-secret"):
                result = triage._publish({
                    "component": "hermes", "reproduction_id": "proof",
                    "title": "Defect", "body": body,
                })
                self.assertEqual(result["status"], "blocked")
        run.assert_not_called()

    def test_publication_rechecks_duplicate_and_verifies_created_issue(self):
        triage._PROOFS["proof"] = {
            "component": "hermes", "completed": True, "fixture_sensitive": True, "reproduction_id": "proof",
            "revision": "a" * 40, "image_id": "sha256:" + "b" * 64,
            "command": "python -m unittest -v tests.test_regression", "stdout": "test_bug (...) ... FAIL\nRan 1 test in 0.01s\nFAILED (failures=1)",
            "public_stdout": "FAIL: test_bug (tests.test_regression.TestCase.test_bug)\nRan 1 test in 0.01s\nFAILED (failures=1)",
        }
        url = "https://github.com/darrencjh8/friday/issues/812"
        issue_body = (
            "Sanitized evidence\n\nReproduction evidence ID: `proof` (revision `" + "a" * 40
            + "`, image `sha256:" + "b" * 64 + "`).\n\n"
            "Reproducer command: `python -m unittest -v tests.test_regression`\n\n"
            "```text\n" + "FAIL: test_bug (tests.test_regression.TestCase.test_bug)\nRan 1 test in 0.01s\nFAILED (failures=1)" + "\n```"
        )
        responses = [
            {"ok": True, "returncode": 0, "stdout": "[]", "stderr": ""},
            {"ok": True, "returncode": 0, "stdout": "[]", "stderr": ""},
            {"ok": True, "returncode": 0, "stdout": url + "\n", "stderr": ""},
            {"ok": True, "returncode": 0, "stdout": json.dumps({
                "number": 812, "title": "Defect", "body": issue_body, "url": url,
            }), "stderr": ""},
        ]
        with patch.object(triage, "_run", side_effect=responses) as run:
            result = triage._publish({
                "component": "hermes", "reproduction_id": "proof",
                "title": "Defect", "body": "Sanitized evidence",
            })
        self.assertEqual(result, {
            "status": "verified", "repository": "darrencjh8/friday",
            "number": 812, "url": url,
        })
        self.assertEqual(run.call_args_list[2].args[0][:3], ["gh", "issue", "create"])
        self.assertEqual(run.call_args_list[3].args[0][:3], ["gh", "issue", "view"])

    def test_publication_stops_on_exact_title_duplicate(self):
        triage._PROOFS["proof"] = {
            "component": "hermes", "completed": True, "fixture_sensitive": True, "reproduction_id": "proof",
            "revision": "a" * 40, "image_id": "sha256:" + "b" * 64,
            "command": "python -m unittest -v tests.test_regression", "stdout": "Failure test output",
        }
        responses = [
            {"ok": True, "stdout": "[]", "stderr": ""},
            {"ok": True, "stdout": '[{"number":3,"title":"Defect"}]', "stderr": ""},
        ]
        with patch.object(triage, "_run", side_effect=responses) as run:
            result = triage._publish({
                "component": "hermes", "reproduction_id": "proof",
                "title": "Defect", "body": "Sanitized evidence",
            })
        self.assertEqual(result["status"], "duplicate")
        self.assertEqual(run.call_count, 2)


class MainRepoOverrideTest(unittest.TestCase):
    """The repo is moving; TRIAGE_MAIN_REPO retargets every in-repo component."""

    def _load(self, env):
        with patch.dict("os.environ", env, clear=False):
            s = importlib.util.spec_from_file_location("triage_override", PLUGIN_PATH)
            mod = importlib.util.module_from_spec(s)
            s.loader.exec_module(mod)
        return mod

    def test_env_override_retargets_main_components(self):
        mod = self._load({"TRIAGE_MAIN_REPO": "darrencjh8/friday"})
        for comp in ("hermes", "expense-tracker", "portfolio-tracker", "actual-api"):
            self.assertEqual(mod._COMPONENT_REPOS[comp], "darrencjh8/friday")
        self.assertEqual(mod._COMPONENT_REPOS["codex-router"], "darrencjh8/codex-router")
        self.assertEqual(mod._MAIN_REPO, "darrencjh8/friday")

    def test_default_without_env(self):
        mod = self._load({"TRIAGE_MAIN_REPO": ""})
        self.assertEqual(mod._MAIN_REPO, "darrencjh8/friday")


class ActualApiCoverageTest(unittest.TestCase):
    """#740: actual-api is a production service, so triage must cover it."""

    def test_actual_api_routes_to_this_repo(self):
        self.assertEqual(triage._COMPONENT_REPOS["actual-api"], "darrencjh8/friday")
        self.assertIn("actual-api", triage._COMPONENTS)

    def test_collector_and_seed_prompt_list_actual_api(self):
        collect = (PLUGIN_PATH.parents[2] / "scripts/log-issue-triage-collect.py").read_text(encoding="utf-8")
        self.assertRegex(collect, r"ALLOWED_COMPONENTS = \{[^}]*\"actual-api\"")
        seed = (PLUGIN_PATH.parents[2] / "50-seed-defaults").read_text(encoding="utf-8")
        self.assertIn("expense-tracker/portfolio-tracker/actual-api to `darrencjh8/friday`", seed)


if __name__ == "__main__":
    unittest.main()
