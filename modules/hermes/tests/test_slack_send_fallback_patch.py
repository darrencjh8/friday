"""Slack chat.postMessage fallbacks: msg_blocks_too_long and cannot_reply_to_message.

Applies patches/patch-slack-send-fallback.py to a verbatim copy of upstream v0.22.2
plugins/platforms/slack/adapter.py and drives the patched send helper with a fake client.
"""

import ast
import asyncio
import importlib.util
import logging
import unittest
from typing import Any, Callable, Dict, Optional
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-slack-send-fallback.py"
FIXTURE = HERE / "fixtures" / "upstream_slack_adapter_v0.22.2.py"
METHODS = ("_call_with_block_fallback", "_call_with_block_fallback_upstream",
           "_is_block_payload_rejection", "_slack_error_code")


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_slack_send_fallback", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SlackError(Exception):
    def __init__(self, code):
        super().__init__(f"The request to the Slack API failed. The server responded with: {{'ok': False, 'error': '{code}'}}")
        self.response = {"ok": False, "error": code}


class FakeClient:
    def __init__(self, errors):
        self.errors, self.calls = list(errors), []

    async def chat_postMessage(self, **kwargs):
        self.calls.append(kwargs)
        if self.errors:
            raise SlackError(self.errors.pop(0))
        return {"ok": True, "ts": "1.2"}


def build_adapter(source: str):
    tree = ast.parse(source)
    cls = next(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)
               and any(getattr(f, "name", "") == "_call_with_block_fallback" for f in n.body))
    body = [f for f in cls.body if getattr(f, "name", "") in METHODS]
    mod = ast.Module(body=[ast.ClassDef(name="A", bases=[], keywords=[], body=body, decorator_list=[])],
                     type_ignores=[])
    ns = {"logging": logging, "logger": logging.getLogger("fake.slack"),
          "Any": Any, "Callable": Callable, "Dict": Dict, "Optional": Optional}
    exec(compile(ast.fix_missing_locations(mod), "adapter_patched", "exec"), ns)
    return ns["A"]()


def call(source, errors, kwargs, verb="send"):
    client = FakeClient(errors)
    adapter = build_adapter(source)
    coro = adapter._call_with_block_fallback(lambda: client, "chat_postMessage", dict(kwargs), verb)
    try:
        return asyncio.run(coro), client, None
    except Exception as exc:
        return None, client, exc


BASE = {"channel": "C1", "text": "hi", "blocks": [{"type": "section"}], "thread_ts": "9.9"}


class SlackSendFallbackTest(unittest.TestCase):
    def setUp(self):
        self.patched = load_patch_module().patch_source(FIXTURE.read_text())

    def test_upstream_lacks_both_fallbacks(self):
        _, client, exc = call(FIXTURE.read_text(), ["msg_blocks_too_long"], BASE)
        self.assertIsNotNone(exc)
        _, client, exc = call(FIXTURE.read_text(), ["cannot_reply_to_message"], BASE)
        self.assertIsNotNone(exc)

    def test_blocks_too_long_retries_once_as_plain_text(self):
        with self.assertLogs("fake.slack", level="WARNING") as logs:
            result, client, exc = call(self.patched, ["msg_blocks_too_long"], BASE)
        self.assertIsNone(exc)
        self.assertEqual(len(client.calls), 2)
        self.assertNotIn("blocks", client.calls[1])
        self.assertEqual(client.calls[1]["text"], "hi")
        self.assertEqual(client.calls[1]["thread_ts"], "9.9")
        self.assertIn("without blocks", "\n".join(logs.output))

    def test_cannot_reply_retries_once_without_thread(self):
        kw = dict(BASE, reply_broadcast=True)
        with self.assertLogs("fake.slack", level="WARNING") as logs:
            result, client, exc = call(self.patched, ["cannot_reply_to_message"], kw)
        self.assertIsNone(exc)
        self.assertEqual(len(client.calls), 2)
        self.assertNotIn("thread_ts", client.calls[1])
        self.assertNotIn("reply_broadcast", client.calls[1])
        self.assertEqual(client.calls[1]["channel"], "C1")
        self.assertIn("without thread_ts", "\n".join(logs.output))

    def test_cannot_reply_then_blocks_too_long_each_retried_once(self):
        result, client, exc = call(self.patched, ["cannot_reply_to_message", "msg_blocks_too_long"], BASE)
        self.assertIsNone(exc)
        self.assertEqual(len(client.calls), 3)
        self.assertNotIn("thread_ts", client.calls[2])
        self.assertNotIn("blocks", client.calls[2])

    def test_never_loops(self):
        result, client, exc = call(self.patched, ["cannot_reply_to_message"] * 10, BASE)
        self.assertIsNotNone(exc)
        self.assertLessEqual(len(client.calls), 3)
        result, client, exc = call(self.patched, ["msg_blocks_too_long"] * 10, BASE)
        self.assertIsNotNone(exc)
        self.assertEqual(len(client.calls), 2)

    def test_unrelated_errors_and_edits_untouched(self):
        result, client, exc = call(self.patched, ["channel_not_found"], BASE)
        self.assertIsNotNone(exc)
        self.assertEqual(len(client.calls), 1)
        result, client, exc = call(self.patched, ["cannot_reply_to_message"], {"channel": "C1", "text": "x"})
        self.assertIsNotNone(exc)
        self.assertEqual(len(client.calls), 1)

    def test_success_is_single_call(self):
        result, client, exc = call(self.patched, [], BASE)
        self.assertEqual(result["ts"], "1.2")
        self.assertEqual(len(client.calls), 1)

    def test_patch_compiles_is_idempotent_and_fails_on_drift(self):
        mod = load_patch_module()
        compile(self.patched, "adapter_patched", "exec")
        self.assertEqual(mod.patch_source(self.patched), self.patched)
        with self.assertRaises(mod.PatchError):
            mod.patch_source("class SlackAdapter:\n    pass\n")


if __name__ == "__main__":
    unittest.main()
