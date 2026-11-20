"""friday #271: quoted replies must stick on the host gateway.

hermes-dots #154 (PR #155) fixed this in its adapter; friday runs its own copy
in modules/hermes/plugins/dots/adapter.py, whose _on_user_message still builds
the user history event without reply_to/quote. These tests drive the real
intake handler with stubbed Hermes-core imports and assert on the stored event.
Ported from hermes-dots tests/test_issue_154.py.

Run from the repo root: python -m unittest modules/tests/test_issue_271_quoted_reply.py -v
"""

import asyncio
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_adapter():
    """Import adapter.py with the Hermes-core imports stubbed."""
    for name in ("gateway", "gateway.config", "gateway.platforms",
                 "gateway.platforms._shared", "gateway.platforms.base",
                 "gateway.platforms.event", "gateway.platforms.helpers",
                 "hermes_constants"):
        sys.modules.setdefault(name, types.ModuleType(name))
    for pkg in ("gateway", "gateway.platforms"):
        sys.modules[pkg].__path__ = []

    config = sys.modules["gateway.config"]
    config.Platform = lambda name: name
    config.PlatformConfig = type("PlatformConfig", (), {})

    shared = sys.modules["gateway.platforms._shared"]
    shared.extra_or_secret = lambda *a, **k: None
    shared.get_scoped_secret = lambda *a, **k: None
    shared.seed_extra_from_env = lambda *a, **k: None
    shared.send_error = lambda *a, **k: None

    class _FakeMessageType:
        TEXT = "text"
        VOICE = "voice"
        DOCUMENT = "document"
        PHOTO = "photo"
        VIDEO = "video"
        AUDIO = "audio"

    class _FakeMessageEvent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    event_mod = sys.modules["gateway.platforms.event"]
    event_mod.MessageEvent = _FakeMessageEvent
    event_mod.MessageType = _FakeMessageType

    base = sys.modules["gateway.platforms.base"]

    class _FakeBase:
        def __init__(self, config=None, platform=None):
            pass

    base.BasePlatformAdapter = _FakeBase
    base.SendResult = type("SendResult", (), {})

    helpers = sys.modules["gateway.platforms.helpers"]

    class _FakeDedup:
        def __init__(self, max_size=1000, ttl_seconds=600):
            self.seen = set()

        def is_duplicate(self, client_id):
            if client_id in self.seen:
                return True
            self.seen.add(client_id)
            return False

    helpers.MessageDeduplicator = _FakeDedup

    consts = sys.modules["hermes_constants"]
    consts.get_hermes_home = lambda: Path(tempfile.gettempdir())

    # friday's adapter imports .release_proxy, so load it as a package module.
    sys.path.insert(0, str(ROOT))
    return importlib.import_module("modules.hermes.plugins.dots.adapter")


class _FakeDots:
    def get(self, chat):
        return None


class _FakeWs:
    def __init__(self):
        self.closed = False
        self.sent = []

    async def send_str(self, text):
        self.sent.append(text)


class TestQuotedReply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mod = _load_adapter()
        adapter = self.mod.DotsAdapter.__new__(self.mod.DotsAdapter)
        adapter._history = self.mod._History(Path(self.tmp.name) / "history.db")
        adapter._dedup = self.mod.MessageDeduplicator()
        adapter._acks = {}
        adapter._clients = {}
        adapter._rooms = {}
        adapter._room_current = {}
        adapter._dots = _FakeDots()
        adapter._lang = "en"
        adapter._turns = {}
        adapter._timing = {}
        adapter._source = lambda chat, mid: {"chat_id": chat}
        adapter._channel_prompt = lambda chat: None
        self.handled = []
        adapter.handle_message = self._capture
        self.adapter = adapter
        self.ws = _FakeWs()

    async def _capture(self, event):
        self.handled.append(event)

    def tearDown(self):
        self.tmp.cleanup()

    def _frame(self, **extra):
        frame = {"type": "message", "client_id": "c1", "text": "yes, that one",
                 "chat": "owner"}
        frame.update(extra)
        return frame

    def test_quoted_reply_persisted(self):
        """A message frame carrying reply_to/quote stores both on the event."""
        asyncio.run(self.adapter._on_user_message(self._frame(
            reply_to="abc123",
            quote={"id": "abc123", "text": "original text", "sender": "agent"},
        ), self.ws))
        self.assertEqual(len(self.handled), 1)
        event = self.adapter._history.get(self.handled[0].message_id)
        self.assertEqual(event["reply_to"], "abc123")
        self.assertEqual(event["quote"],
                         {"id": "abc123", "text": "original text", "sender": "agent"})

    def test_malformed_reply_fields_dropped(self):
        """Non-string reply_to and a quote without id/text are not stored."""
        asyncio.run(self.adapter._on_user_message(self._frame(
            reply_to=123, quote={"id": "", "text": "x"}), self.ws))
        event = self.adapter._history.get(self.handled[0].message_id)
        self.assertNotIn("reply_to", event)
        self.assertNotIn("quote", event)

    def test_duplicate_resend_keeps_quote(self):
        """A quoted resend after a lost ack keeps the quote (no second event)."""
        frame = self._frame(reply_to="abc123", quote={"id": "abc123",
                                                      "text": "original text",
                                                      "sender": "agent"})
        asyncio.run(self.adapter._on_user_message(frame, self.ws))
        asyncio.run(self.adapter._on_user_message(frame, self.ws))
        self.assertEqual(len(self.handled), 1)
        events, _ = self.adapter._history.page("owner", None, 10)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["reply_to"], "abc123")
        self.assertEqual(events[0]["quote"]["text"], "original text")


if __name__ == "__main__":
    unittest.main()
