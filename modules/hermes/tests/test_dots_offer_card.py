"""Dots offer cards: a Remember/Forget tap is answered even while Friday is mid-turn.

Runs inside the Hermes image (the adapter imports gateway internals):
    python3 -m unittest /path/to/test_dots_offer_card.py
"""

import asyncio
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

sys.path.append("/opt/hermes")
from plugins.platforms.dots.adapter import DotsAdapter  # noqa: E402


def tap(card_id, hook_result):
    adapter = object.__new__(DotsAdapter)
    adapter._history = MagicMock()
    adapter._history.get.return_value = {"type": "approval", "chat": "owner"}
    adapter._push = AsyncMock()
    adapter.handle_message = AsyncMock()
    adapter._source = lambda chat, *_args: SimpleNamespace(chat_id=chat, user_id="owner")
    adapter.gateway_runner = MagicMock()
    adapter.gateway_runner._hm_pre_gateway_dispatch_hook = AsyncMock(return_value=hook_result)
    asyncio.run(adapter._on_approval({"approval_id": card_id, "choice": "once"}))
    return adapter


class OfferCardTap(unittest.TestCase):
    def test_remember_answered_by_the_plugin_never_reaches_the_agent(self):
        # A busy session would take the tap as a steer, which skips pre_gateway_dispatch.
        adapter = tap("learn_tssdh96w", None)
        event = adapter.gateway_runner._hm_pre_gateway_dispatch_hook.await_args.args[0]
        self.assertEqual(event.text, "/remember_tssdh96w")
        adapter.handle_message.assert_not_awaited()

    def test_remember_the_plugin_lets_through_still_goes_to_the_agent(self):
        adapter = tap("learn_tssdh96w", object())
        self.assertEqual(adapter.handle_message.await_args.args[0].text, "/remember_tssdh96w")

    def test_buy_goes_to_the_agent(self):
        adapter = tap("muse_12", None)
        adapter.gateway_runner._hm_pre_gateway_dispatch_hook.assert_not_awaited()
        self.assertIn("friday-persona#12 is approved", adapter.handle_message.await_args.args[0].text)


if __name__ == "__main__":
    unittest.main()
