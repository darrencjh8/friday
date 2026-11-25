"""Dots gateway hardening for publishing it beyond the tailnet (Tailscale Funnel).

Runs inside the Hermes image (the adapter imports gateway internals):
    python3 -m unittest /path/to/test_dots_gateway_hardening.py
"""

import asyncio
import sys
import unittest
from types import SimpleNamespace

sys.path.append("/opt/hermes")
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402
from plugins.platforms.dots.adapter import DotsAdapter  # noqa: E402

TOKEN = "t" * 43


def gateway():
    adapter = object.__new__(DotsAdapter)
    adapter._token = TOKEN
    adapter._agent_id = "b7dd404ef0fcd08f"
    adapter._web_origins = set()
    adapter._update_repo = "owner/repo"
    adapter.platform = SimpleNamespace(value="dots")
    return adapter


def call(path, headers=None):
    """GET ``path`` on the gateway's real routes; returns (status, json body, refusal log lines)."""
    async def run():
        async with TestClient(TestServer(gateway()._app())) as client:
            response = await client.get(path, headers=headers or {})
            return response.status, await response.json()

    with unittest.TestCase().assertLogs("plugins.platforms.dots.adapter", "WARNING") as logs:
        status, body = asyncio.run(run())
        # assertLogs needs at least one record; a quiet request leaves only this one.
        __import__("logging").getLogger("plugins.platforms.dots.adapter").warning("end")
    return status, body, [line for line in logs.output if "Refused" in line]


class Health(unittest.TestCase):
    def test_anyone_learns_only_that_it_is_up(self):
        status, body, refused = call("/dots/health")
        self.assertEqual((200, {"ok": True}), (status, body))
        self.assertEqual([], refused)

    def test_a_token_holder_also_learns_which_profile_answers(self):
        _, body, _ = call("/dots/health", {"Authorization": f"Bearer {TOKEN}"})
        self.assertEqual({"ok": True, "agent_id": "b7dd404ef0fcd08f"}, body)


class Refusals(unittest.TestCase):
    def test_a_wrong_token_is_refused_and_logged_with_the_address_tailscale_saw(self):
        # A client can send its own X-Forwarded-For; Tailscale appends the real address last.
        status, _, refused = call("/dots/releases/latest?repo=owner/repo",
                                  {"Authorization": "Bearer guess", "X-Forwarded-For": "1.2.3.4, 203.0.113.9"})
        self.assertEqual(401, status)
        self.assertEqual(1, len(refused))
        self.assertIn("GET /dots/releases/latest from 203.0.113.9 (401)", refused[0])
        self.assertNotIn("guess", refused[0])


if __name__ == "__main__":
    unittest.main()
