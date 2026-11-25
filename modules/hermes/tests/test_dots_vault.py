"""Dots vault frames: the phone lists, adds and removes Hermes vault items; a browser cannot.

Runs inside the Hermes image (the adapter imports gateway internals):
    python3 -m unittest /path/to/test_dots_vault.py
"""

import asyncio
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.append("/opt/hermes")
from agent.vault_store import VaultStore  # noqa: E402
from plugins.platforms.dots.adapter import DotsAdapter  # noqa: E402

LOGIN = {"kind": "login", "label": "GitHub", "origin": "https://github.com",
         "secret": {"identifier_type": "email", "identifier": "me@example.com", "password": "hunter2-secret"}}


class Vault(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.store = VaultStore(self.dir.name)
        patcher = patch("agent.vault_store.get_vault_store", lambda: self.store)
        patcher.start()
        self.addCleanup(patcher.stop)

    def send(self, frame, web=None):
        adapter = object.__new__(DotsAdapter)
        adapter._push = AsyncMock()
        ws = object()
        adapter._clients = {ws: {"web": web}}
        adapter.platform = SimpleNamespace(value="dots")
        asyncio.run(adapter._on_frame(frame, ws))
        return adapter._push.await_args.args[0]

    def test_add_stores_the_login_and_replies_with_metadata_only(self):
        with self.assertLogs(level="DEBUG") as logs:
            reply = self.send({"type": "vault_add", "ref": "r1", "item": LOGIN})
        self.assertNotIn("hunter2-secret", "\n".join(logs.output))
        self.assertEqual(reply["ref"], "r1")
        self.assertNotIn("error", reply)
        [item] = reply["items"]
        self.assertEqual((item["kind"], item["label"], item["identifier"]), ("login", "GitHub", "me@example.com"))
        self.assertNotIn("hunter2-secret", json.dumps(reply))
        self.assertEqual(self.store.resolve_secret(item["id"])["password"], "hunter2-secret")

    def test_card_missing_required_fields_is_refused_without_echoing_values(self):
        card = {"kind": "payment", "label": "Visa", "secret": {"card_number": "4111111111111111"}}
        reply = self.send({"type": "vault_add", "item": card})
        self.assertIn("exp_month", reply["error"])
        self.assertNotIn("4111111111111111", json.dumps(reply))
        self.assertEqual(reply["items"], [])

    def test_address_and_remove(self):
        address = {"kind": "address", "label": "Home", "secret": {
            "address_line1": "1 Example Road", "city": "Singapore", "postal_code": "123456", "country": "Singapore"}}
        item_id = self.send({"type": "vault_add", "item": address})["items"][0]["id"]
        self.assertEqual(self.send({"type": "vault_get"})["items"][0]["kind"], "address")
        self.assertEqual(self.send({"type": "vault_remove", "id": item_id})["items"], [])
        self.assertEqual(self.send({"type": "vault_remove", "id": item_id})["error"], "not_found")

    def test_a_browser_is_refused(self):
        reply = self.send({"type": "vault_add", "item": LOGIN}, web="session-1")
        self.assertEqual(reply, {"type": "error", "code": "forbidden"})
        self.assertEqual(self.store.list_items(), [])


if __name__ == "__main__":
    unittest.main()
