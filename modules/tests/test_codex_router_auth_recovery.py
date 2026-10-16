import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

import yaml


ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "modules/codex-router-auth-recovery.py"
WORKFLOW = ROOT / ".github/workflows/recover-codex-router-auth.yml"
DEPLOY_WORKFLOW = ROOT / ".github/workflows/deploy.yml"


def load_script():
    if not SCRIPT.exists():
        raise AssertionError(f"recovery script is missing: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("codex_router_auth_recovery", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeManager:
    def __init__(self, results):
        self.results = list(results)
        self.started_accounts = []
        self.polled_accounts = []

    async def start(self, account):
        self.started_accounts.append(account)
        return {
            "verification_url": "https://auth.openai.com/codex/device",
            "user_code": "ABCD-EFGH",
            "poll_interval": 0,
            "device_auth_id": "must-not-be-printed",
        }

    async def result(self, account):
        self.polled_accounts.append(account)
        return self.results.pop(0)


async def no_sleep(_seconds):
    return None


class AuthRecoveryScriptTests(unittest.IsolatedAsyncioTestCase):
    async def test_prints_only_browser_details_and_completes_after_authorization(self):
        module = load_script()
        manager = FakeManager([
            {"status": "pending"},
            {"status": "complete", "available": True, "access_token": "must-not-be-printed"},
        ])
        output = []

        await module.recover("acct2", manager, sleep=no_sleep, output=output.append)

        self.assertEqual(manager.started_accounts, ["acct2"])
        self.assertEqual(manager.polled_accounts, ["acct2", "acct2"])
        rendered = "\n".join(output)
        self.assertIn("https://auth.openai.com/codex/device", rendered)
        self.assertIn("ABCD-EFGH", rendered)
        self.assertIn("acct2 is available", rendered)
        self.assertNotIn("must-not-be-printed", rendered)

    async def test_fails_when_authorized_account_does_not_become_available(self):
        module = load_script()
        manager = FakeManager([{"status": "complete", "available": False}])

        with self.assertRaisesRegex(RuntimeError, "did not become available"):
            await module.recover("acct1", manager, sleep=no_sleep, output=lambda _message: None)

    async def test_fails_when_device_code_expires(self):
        module = load_script()
        manager = FakeManager([{"status": "expired"}])

        with self.assertRaisesRegex(TimeoutError, "expired"):
            await module.recover("acct3", manager, sleep=no_sleep, output=lambda _message: None)

    async def test_fails_closed_on_an_unknown_login_status(self):
        module = load_script()
        manager = FakeManager([{"status": "rejected"}])

        with self.assertRaisesRegex(RuntimeError, "unexpected status"):
            await module.recover("acct1", manager, sleep=no_sleep, output=lambda _message: None)

    def test_cli_requires_exactly_one_account_argument(self):
        module = load_script()

        with mock.patch.object(sys, "argv", [str(SCRIPT)]):
            with self.assertRaisesRegex(SystemExit, "acct1\|acct2\|acct3"):
                module.main()


class AuthRecoveryWorkflowTests(unittest.TestCase):
    def test_workflow_is_manual_protected_and_serialized(self):
        workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        dispatch = workflow[True]["workflow_dispatch"]
        account = dispatch["inputs"]["account"]

        self.assertEqual(account["type"], "choice")
        self.assertEqual(account["options"], ["acct1", "acct2", "acct3"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        # Must share the deploy group: both jobs use the same self-hosted host,
        # the same workspace directory, and the same running containers.
        deploy = yaml.safe_load(DEPLOY_WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(
            workflow["concurrency"]["group"], deploy["concurrency"]["group"]
        )
        self.assertFalse(workflow["concurrency"]["cancel-in-progress"])
        job = workflow["jobs"]["recover"]
        self.assertEqual(job["runs-on"], "self-hosted")
        self.assertEqual(job["environment"], "darren-prod")
        self.assertEqual(job["timeout-minutes"], 20)

    def test_workflow_validates_the_slot_and_uses_the_running_router_container(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn('case "$ACCOUNT" in', text)
        self.assertIn("acct1|acct2|acct3", text)
        # The front is a caddy proxy with no python in it, so the recovery has to
        # exec into one of the router colours, preferring the front's own order.
        self.assertIn("for service in codex-router-a codex-router-b; do", text)
        self.assertIn('--filter "label=com.docker.compose.service=$service"', text)
        self.assertIn('if [ -z "$container_id" ]; then', text)
        self.assertIn('docker exec -i "$container_id" python -u - "$ACCOUNT"', text)
        self.assertIn("modules/codex-router-auth-recovery.py", text)
        self.assertIn("http://127.0.0.1:4100/v1/codex-router/status", text)
        self.assertNotIn("auth.json", text)
        self.assertNotIn("refresh_token", text)


if __name__ == "__main__":
    unittest.main()
