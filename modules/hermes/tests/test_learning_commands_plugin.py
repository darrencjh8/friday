"""Contracts for the /remember_<id> and /forget_<id> pre-dispatch hook (#723)."""

import asyncio
import importlib.util
import tempfile
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/learning-commands/__init__.py"
spec = importlib.util.spec_from_file_location("learning_commands_plugin", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

TOKEN = "123:test-token"
CHAT = "4242"
# Shared with modules/expense-tracker/tests/learning-commands-723.test.js.
VECTOR = ("remember", "ABCDEFGH", "a7f29839a966ef459f6f18be8b620e8319b0c31ad43894aed11ff1c9c5a1e9d8")
ENV = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_HOME_CHANNEL": CHAT, "TELEGRAM_ALLOWED_USERS": "4242,77"}


def make_event(text, platform="telegram", chat_id=CHAT, user_id="4242"):
    source = SimpleNamespace(platform=SimpleNamespace(value=platform), chat_id=chat_id, user_id=user_id)
    return SimpleNamespace(text=text, source=source)


def make_gateway():
    adapter = MagicMock()
    adapter.send = AsyncMock()
    gateway = MagicMock()
    gateway._delivery_adapter_for.return_value = adapter
    return gateway, adapter


def run(event, gateway):
    return asyncio.run(plugin._on_pre_gateway_dispatch(event=event, gateway=gateway, session_store=None))


MAPPING_PAGE = """---
title: Merchant to payee mappings
created: 2026-10-11
updated: 2026-10-11
type: entity
---

# Merchant to payee mappings

## Mappings

| Merchant key | Payee | Category override | Status | Source |
|---|---|---|---|---|
| `Alpha Cafe` | Food |  | confirmed | L1 |
| `Beta Mart` | Groceries |  | confirmed | L2 |

## Not migrated

- nothing
"""


def make_wiki():
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    (root / "entities/accounts").mkdir(parents=True)
    (root / plugin._MAPPING_PAGE).write_text(MAPPING_PAGE)
    (root / "log.md").write_text("# Log\n")
    return tmp, root


class LearningCommandsPluginTest(unittest.TestCase):
    def setUp(self):
        self._wiki_tmp, self.wiki = make_wiki()
        self.addCleanup(self._wiki_tmp.cleanup)
        patcher = patch.dict(os.environ, {**ENV, "WIKI_PATH": str(self.wiki)}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.gateway, self.adapter = make_gateway()

    def page(self):
        return (self.wiki / plugin._MAPPING_PAGE).read_text()

    def test_signature_matches_the_javascript_vector(self):
        action, offer_id, signature = VECTOR
        self.assertEqual(plugin.sign(action, offer_id, TOKEN), signature)
        self.assertEqual(plugin.sign(action, offer_id.lower(), TOKEN), signature)

    def test_register_hooks_pre_gateway_dispatch(self):
        ctx = MagicMock()
        plugin.register(ctx)
        ctx.register_hook.assert_called_once_with("pre_gateway_dispatch", plugin._on_pre_gateway_dispatch)

    def test_command_regex(self):
        for text in ("/remember_abc123", "/forget_a", "/remember_abc123@MyBot", "/forget_abc \n"):
            self.assertTrue(plugin._COMMAND_RE.match(text), text)
        for text in ("/remember_", "/remember_ABC", "/remember_" + "a" * 17, "/remember_abc extra",
                     "remember_abc", "/confirm_abc", "/remember_a-b", "hi /remember_abc"):
            self.assertIsNone(plugin._COMMAND_RE.match(text), text)

    def test_command_calls_tracker_with_signed_request_and_skips(self):
        with patch.object(plugin, "_call_tracker", return_value=(200, {
            "ok": True, "result": "remembered", "descriptor": "360 SAVE BONUS", "payee": "Bank Interest",
        })) as call:
            result = run(make_event("/remember_abcdefgh"), self.gateway)
        self.assertEqual(result["action"], "skip")
        call.assert_called_once_with("remember", "abcdefgh", TOKEN)
        self.adapter.send.assert_awaited_once_with(
            CHAT, 'Remembered: "360 SAVE BONUS" is Bank Interest (saved to the wiki)'
        )

    def test_request_headers_and_body(self):
        captured = {}

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"ok": true}'

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = {k.lower(): v for k, v in request.header_items()}
            captured["body"] = json.loads(request.data)
            return Response()

        with patch.object(plugin.urllib.request, "urlopen", fake_urlopen):
            plugin._call_tracker("remember", "abcdefgh", TOKEN)
        self.assertEqual(captured["url"], "http://expense-tracker:8080/learning/answer")
        self.assertEqual(captured["body"], {"id": "ABCDEFGH", "action": "remember"})
        self.assertEqual(captured["headers"]["x-learning-signature"], VECTOR[2])

    def test_url_override(self):
        with patch.dict(os.environ, {"LEARNING_ANSWER_URL": "http://localhost:9/x"}):
            captured = {}

            def fake_urlopen(request, timeout):
                captured["url"] = request.full_url
                raise OSError("down")

            with patch.object(plugin.urllib.request, "urlopen", fake_urlopen):
                with self.assertRaises(OSError):
                    plugin._call_tracker("forget", "abc", TOKEN)
        self.assertEqual(captured["url"], "http://localhost:9/x")

    def test_forget_and_expired_and_failure_replies(self):
        cases = [
            ("/forget_abc", (200, {"ok": True, "result": "forgotten", "descriptor": "X", "payee": "Y"}),
             'Not remembered: "X"'),
            ("/remember_abc", (404, {"ok": False, "reason": "expired"}), plugin._EXPIRED),
            ("/remember_abc", (500, {"ok": False, "reason": "not_saved"}), plugin._FAILED),
            ("/remember_abc", (403, {"ok": False}), plugin._FAILED),
        ]
        for text, tracker, expected in cases:
            gateway, adapter = make_gateway()
            with patch.object(plugin, "_call_tracker", return_value=tracker):
                self.assertEqual(run(make_event(text), gateway)["action"], "skip")
            adapter.send.assert_awaited_once_with(CHAT, expected)

    def test_tracker_error_replies_and_does_not_raise(self):
        with patch.object(plugin, "_call_tracker", side_effect=OSError("down")):
            result = run(make_event("/remember_abc"), self.gateway)
        self.assertEqual(result["action"], "skip")
        self.adapter.send.assert_awaited_once_with(CHAT, plugin._FAILED)

    def test_reply_failure_does_not_raise(self):
        self.adapter.send.side_effect = RuntimeError("telegram down")
        with patch.object(plugin, "_call_tracker", return_value=(200, {"ok": True, "result": "forgotten"})):
            self.assertEqual(run(make_event("/forget_abc"), self.gateway)["action"], "skip")

    def test_everything_else_passes_through_without_calling_the_tracker(self):
        events = [
            make_event("hello"),
            make_event("/remember_abc", platform="slack"),
            make_event("/remember_abc", chat_id="999"),
            make_event("/remember_abc", user_id="555"),
            make_event("/remember_abc extra"),
            make_event(None),
            SimpleNamespace(),
        ]
        with patch.object(plugin, "_call_tracker") as call:
            for event in events:
                self.assertIsNone(run(event, self.gateway), event)
        call.assert_not_called()
        self.adapter.send.assert_not_awaited()

    def test_unconfigured_env_passes_through(self):
        for missing in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL", "TELEGRAM_ALLOWED_USERS"):
            env = {k: v for k, v in ENV.items() if k != missing}
            with patch.dict(os.environ, env, clear=False):
                os.environ.pop(missing, None)
                with patch.object(plugin, "_call_tracker") as call:
                    self.assertIsNone(run(make_event("/remember_abc"), self.gateway), missing)
                call.assert_not_called()


class WikiRememberWriterTest(unittest.TestCase):
    """A /remember answer writes the approved mapping to the wiki (#783)."""

    def setUp(self):
        self._tmp, self.wiki = make_wiki()
        self.addCleanup(self._tmp.cleanup)
        patcher = patch.dict(os.environ, {**ENV, "WIKI_PATH": str(self.wiki)}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def page(self):
        return (self.wiki / plugin._MAPPING_PAGE).read_text()

    def test_appends_an_exact_key_row_inside_the_mappings_table(self):
        self.assertEqual(plugin._write_wiki_mapping("Gamma Diner 12", "Food", today="2026-10-12"), "added")
        page = self.page()
        table = page.split("## Mappings", 1)[1].split("## Not migrated", 1)[0]
        self.assertIn("| `Gamma Diner 12` | Food |  | confirmed | telegram-remember 2026-10-12 |", table)
        self.assertLess(page.index("`Gamma Diner 12`"), page.index("## Not migrated"))
        self.assertIn("updated: 2026-10-12", page)
        self.assertIn("Gamma Diner 12", (self.wiki / "log.md").read_text())

    def test_same_mapping_is_a_no_op(self):
        before = self.page()
        self.assertEqual(plugin._write_wiki_mapping("Alpha Cafe", "Food", today="2026-10-12"), "unchanged")
        self.assertEqual(self.page(), before)

    def test_a_new_payee_replaces_the_existing_row(self):
        self.assertEqual(plugin._write_wiki_mapping("Beta Mart", "Food", today="2026-10-12"), "replaced")
        page = self.page()
        self.assertIn("| `Beta Mart` | Food |  | confirmed | telegram-remember 2026-10-12 |", page)
        self.assertNotIn("| `Beta Mart` | Groceries |", page)
        self.assertEqual(page.count("`Beta Mart`"), 1)

    def test_rejects_text_that_would_break_the_table_or_carry_a_secret(self):
        for descriptor, payee in (("A|B", "Food"), ("A`B", "Food"), ("A\nB", "Food"), ("", "Food"),
                                  ("X", "Fo|od"), ("x" * 121, "Food"), ("Zeta password is abc", "Misc")):
            self.assertEqual(plugin._write_wiki_mapping(descriptor, payee, today="2026-10-12"), "rejected")
        self.assertEqual(self.page(), MAPPING_PAGE)

    def test_missing_page_is_reported_not_raised(self):
        (self.wiki / plugin._MAPPING_PAGE).unlink()
        self.assertEqual(plugin._write_wiki_mapping("Gamma", "Food", today="2026-10-12"), "missing")

    def test_remember_reply_says_when_the_wiki_write_failed(self):
        gateway, adapter = make_gateway()
        with patch.object(plugin, "_call_tracker", return_value=(200, {
            "ok": True, "result": "remembered", "descriptor": "A|B", "payee": "Food",
        })):
            run(make_event("/remember_abc"), gateway)
        adapter.send.assert_awaited_once_with(
            CHAT, 'Remembered: "A|B" is Food, but the wiki was not updated (rejected)'
        )

    def test_a_category_fills_the_override_column(self):
        self.assertEqual(plugin._write_wiki_mapping("Gamma Diner", "Food", today="2026-10-12", category="Snacks"), "added")
        self.assertIn("| `Gamma Diner` | Food | Snacks | confirmed | telegram-remember 2026-10-12 |", self.page())
        self.assertIn("Gamma Diner -> Food, category Snacks", (self.wiki / "log.md").read_text())

    def test_category_replace_rules(self):
        plugin._write_wiki_mapping("Beta Mart", "Groceries", today="2026-10-12", category="Snacks")
        # Same payee and category: nothing to do.
        self.assertEqual(plugin._write_wiki_mapping("Beta Mart", "Groceries", category="Snacks"), "unchanged")
        # A payee-only answer for the same payee keeps the override.
        self.assertEqual(plugin._write_wiki_mapping("Beta Mart", "Groceries"), "unchanged")
        self.assertIn("| `Beta Mart` | Groceries | Snacks |", self.page())
        # A new category replaces it.
        self.assertEqual(plugin._write_wiki_mapping("Beta Mart", "Groceries", today="2026-10-13", category="Food"), "replaced")
        self.assertIn("| `Beta Mart` | Groceries | Food | confirmed | telegram-remember 2026-10-13 |", self.page())
        # A new payee with no category clears the old override.
        self.assertEqual(plugin._write_wiki_mapping("Beta Mart", "Food", today="2026-10-14"), "replaced")
        self.assertIn("| `Beta Mart` | Food |  | confirmed | telegram-remember 2026-10-14 |", self.page())
        self.assertEqual(self.page().count("`Beta Mart`"), 1)

    def test_rejects_an_unsafe_category(self):
        for category in ("Fo|od", "Fo`od", "Fo\nod", "Food payee X", "x maps to y", "c" * 121):
            self.assertEqual(plugin._write_wiki_mapping("Gamma", "Food", category=category), "rejected", category)
        self.assertEqual(self.page(), MAPPING_PAGE)

    def test_remember_reply_and_wiki_row_carry_the_category(self):
        gateway, adapter = make_gateway()
        with patch.object(plugin, "_call_tracker", return_value=(200, {
            "ok": True, "result": "remembered", "descriptor": "Gamma Diner", "payee": "Food", "category": "Snacks",
        })):
            run(make_event("/remember_abc"), gateway)
        adapter.send.assert_awaited_once_with(
            CHAT, 'Remembered: "Gamma Diner" is Food, category Snacks (saved to the wiki)'
        )
        self.assertIn("| `Gamma Diner` | Food | Snacks |", self.page())

    def test_forget_never_touches_the_wiki(self):
        gateway, _ = make_gateway()
        before = self.page()
        with patch.object(plugin, "_call_tracker", return_value=(200, {
            "ok": True, "result": "forgotten", "descriptor": "Gamma", "payee": "Food",
        })):
            run(make_event("/forget_abc"), gateway)
        self.assertEqual(self.page(), before)


if __name__ == "__main__":
    unittest.main()
