"""Contract tests for the Claude Pro usage snapshot helper + its deploy wiring.

The helper polls an undocumented Anthropic endpoint, so the upstream payload
below is a RECORDED shape (captured once from a live probe, values kept) and
every test runs against it or small mutations of it. No test touches the real
credentials file or the network.
"""

import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import yaml


ROOT = Path(__file__).parents[2]
HELPER = ROOT / "modules/fetch-claude-usage.py"
COMPOSE_FILE = ROOT / "modules/docker-compose.yml"
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
DEPLOY_SCRIPT = ROOT / "modules/deploy.sh"

USAGE_DIR = "/home/runner/data/codex-router"
USAGE_OUTPUT = USAGE_DIR + "/claude-usage.json"

# Recorded upstream shape (live probe 2026-10-11): buckets carry utilization +
# resets_at plus dollar fields; unused lanes are null; extra top-level keys
# (limits, spend, breakdowns, ...) must be dropped by the helper.
RECORDED_UPSTREAM = {
    "five_hour": {
        "utilization": 12.5,
        "resets_at": "2026-10-11T06:00:00.345963+00:00",
        "limit_dollars": None,
        "used_dollars": None,
        "remaining_dollars": None,
        "locked_reason": None,
    },
    "seven_day": {
        "utilization": 41.0,
        "resets_at": "2026-10-13T00:00:00.000000+00:00",
        "limit_dollars": None,
        "used_dollars": None,
        "remaining_dollars": None,
        "locked_reason": None,
    },
    "seven_day_sonnet": None,
    "seven_day_opus": None,
    "seven_day_breakdown": {"as_of": "2026-10-11T00:00:00+00:00", "rows": []},
    "limits": [{"kind": "session", "percent": 51}],
    "spend": {"percent": 3, "enabled": True},
    "extra_usage": {"is_enabled": False},
}

NESTED_CREDS = {"claudeAiOauth": {"accessToken": "test-access-token", "refreshToken": "test-refresh"}}
FLAT_CREDS = {"access_token": "test-access-token", "refresh_token": "test-refresh"}


def load_helper():
    if not HELPER.exists():
        raise AssertionError(f"usage helper is missing: {HELPER}")
    spec = importlib.util.spec_from_file_location("fetch_claude_usage", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    """Minimal context manager wrapping a JSON-serializable (or raw) body."""

    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        if isinstance(self._body, (dict, list)):
            return json.dumps(self._body).encode()
        return self._body


class HelperTests(unittest.TestCase):
    def run_main(self, module, creds, upstream, output_path, sent=None):
        creds_path = output_path.parent / "credentials.json"
        creds_path.write_text(json.dumps(creds), encoding="utf-8")

        def fake_urlopen(request, timeout=None):
            if sent is not None:
                sent["url"] = request.full_url
                sent["auth"] = request.get_header("Authorization")
            if isinstance(upstream, Exception):
                raise upstream
            return FakeResponse(upstream)

        env = {
            "CLAUDE_CREDENTIALS_FILE": str(creds_path),
            "CLAUDE_USAGE_URL": "http://localhost/usage",
            "CLAUDE_USAGE_OUT": str(output_path),
        }
        with mock.patch.dict("os.environ", env, clear=False), mock.patch.object(
            module.urllib.request, "urlopen", side_effect=fake_urlopen
        ):
            return module.main()

    # unittest has no tmp_path; per-test dirs via the stdlib instead.
    def make_tmp(self):
        import tempfile

        return Path(tempfile.mkdtemp(prefix="claude-usage-"))

    def test_publishes_sanitized_schema_and_drops_extra_keys(self):
        module = load_helper()
        tmp = self.make_tmp()
        out = tmp / "claude-usage.json"
        sent = {}
        before = __import__("time").time()

        rc = self.run_main(module, NESTED_CREDS, RECORDED_UPSTREAM, out, sent)

        after = __import__("time").time()
        self.assertEqual(rc, 0)
        snapshot = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(
            sorted(snapshot.keys()),
            ["fetched_at", "five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"],
        )
        # Buckets pass through as received, including nulls.
        self.assertEqual(snapshot["five_hour"], RECORDED_UPSTREAM["five_hour"])
        self.assertEqual(snapshot["seven_day"], RECORDED_UPSTREAM["seven_day"])
        self.assertIsNone(snapshot["seven_day_sonnet"])
        self.assertIsNone(snapshot["seven_day_opus"])
        self.assertIsInstance(snapshot["fetched_at"], int)
        # int() truncates, so allow a second of slack on the lower bound.
        self.assertTrue(before - 1 <= snapshot["fetched_at"] <= after + 1)
        # The request carried the token, but the file must not.
        self.assertEqual(sent["auth"], "Bearer test-access-token")
        self.assertNotIn("test-access-token", out.read_text(encoding="utf-8"))
        self.assertNotIn("test-refresh", out.read_text(encoding="utf-8"))
        self.assertFalse((tmp / "claude-usage.json.tmp").exists())

    def test_accepts_top_level_credential_shape(self):
        module = load_helper()
        tmp = self.make_tmp()
        out = tmp / "claude-usage.json"
        rc = self.run_main(module, FLAT_CREDS, RECORDED_UPSTREAM, out)
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["five_hour"]["utilization"], 12.5)

    def test_401_leaves_previous_file_and_exits_nonzero_quietly(self):
        module = load_helper()
        tmp = self.make_tmp()
        out = tmp / "claude-usage.json"
        out.write_text('{"previous": true}\n', encoding="utf-8")
        err = urllib.error.HTTPError(
            "http://localhost/usage", 401, "Unauthorized", {}, io.BytesIO(b"{}")
        )

        with mock.patch("sys.stdout", new_callable=io.StringIO) as stdout, mock.patch(
            "sys.stderr", new_callable=io.StringIO
        ) as stderr:
            rc = self.run_main(module, NESTED_CREDS, err, out)

        self.assertNotEqual(rc, 0)
        self.assertEqual(out.read_text(encoding="utf-8"), '{"previous": true}\n')
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")

    def test_unexpected_shape_leaves_previous_file(self):
        module = load_helper()
        tmp = self.make_tmp()
        out = tmp / "claude-usage.json"
        out.write_text('{"previous": true}\n', encoding="utf-8")
        for bad in ({"no_buckets": 1}, {"five_hour": None, "seven_day": {"utilization": "lots"}}):
            rc = self.run_main(module, NESTED_CREDS, bad, out)
            self.assertNotEqual(rc, 0)
            self.assertEqual(out.read_text(encoding="utf-8"), '{"previous": true}\n')

    def test_missing_credentials_leaves_previous_file(self):
        module = load_helper()
        tmp = self.make_tmp()
        out = tmp / "claude-usage.json"
        out.write_text('{"previous": true}\n', encoding="utf-8")
        env = {
            "CLAUDE_CREDENTIALS_FILE": str(tmp / "absent.json"),
            "CLAUDE_USAGE_URL": "http://localhost/usage",
            "CLAUDE_USAGE_OUT": str(out),
        }
        with mock.patch.dict("os.environ", env, clear=False):
            rc = module.main()
        self.assertNotEqual(rc, 0)
        self.assertEqual(out.read_text(encoding="utf-8"), '{"previous": true}\n')


class ComposeWiringTests(unittest.TestCase):
    def test_both_colours_mount_usage_dir_readonly_with_env(self):
        compose = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
        services = compose["services"]
        for colour in ("codex-router-a", "codex-router-b"):
            env_list = services[colour]["environment"]
            volumes = services[colour]["volumes"]
            # A directory bind, not a file bind: the helper publishes via
            # atomic tmp+rename, and a renamed file orphans a file bind at
            # the old inode (observed 2026-10-11: container froze at the
            # deploy-time snapshot while the host file stayed fresh).
            # Renames inside a bound directory stay visible.
            self.assertIn("CODEX_ROUTER_CLAUDE_USAGE_FILE=/claude-usage/claude-usage.json", env_list)
            self.assertIn(f"{USAGE_DIR}:/claude-usage:ro", volumes)
            for volume in volumes:
                self.assertNotIn("claude-usage.json:/claude-usage.json:ro", volume)


class DeployWiringTests(unittest.TestCase):
    def test_workflow_creates_usage_dir_and_detects_helper_changes(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        # Data-dirs mkdir covers the mount source dir.
        self.assertIn("hermes/{data,workspace},codex-router}", workflow)
        self.assertIn('grep -q "^modules/fetch-claude-usage.py"', workflow)
        self.assertIn('COMPONENTS="$COMPONENTS codex-router"', workflow)

    def test_deploy_script_grants_darren_write_and_drops_runner_cron(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        self.assertIn('USAGE_DIR="/home/runner/data/codex-router"', script)
        self.assertIn('mkdir -p "$USAGE_DIR"', script)
        self.assertIn("fetch-claude-usage.py", script)
        self.assertIn("claude-usage.json", script)
        # The helper runs as darren (owner-immune to the CLI's chmod-600
        # rewrites); deploy makes the runner-owned dir group-writable via the
        # shared docker group (plain modes: this fs ignores POSIX ACLs).
        self.assertIn("chgrp docker", script)
        self.assertIn("chmod 2770", script)
        # /home/runner is 700: without traverse on the parents darren's cron
        # can never reach the group-writable leaf.
        self.assertIn("chmod o+x /home/runner /home/runner/data", script)
        # Runner cron must not (re)install this helper: it can only fail once
        # the ACL mask is reset, so any leftover line is removed instead. The
        # old install piped a generated schedule line into crontab; only the
        # removal pipeline may remain.
        self.assertNotIn("printf '%s\\n' \"*/5", script)
        self.assertIn('grep -v "fetch-claude-usage.py"', script)
        self.assertIn("darren's crontab", script)

    def test_deploy_script_warns_when_snapshot_is_stale(self):
        script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        # Warn-only freshness gate against the router's 900s staleness rule;
        # must never fail the deploy (crontab line may not exist yet).
        self.assertIn("USAGE_FETCHED", script)
        self.assertIn("-lt 900", script)
        self.assertIn("snapshot fresh", script)
        self.assertIn("snapshot is stale or missing", script)


if __name__ == "__main__":
    unittest.main()
