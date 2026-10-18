#!/usr/bin/env python3
"""Keep full cached rich-message context for Telegram replies; fail closed on upstream drift."""

import sys
from pathlib import Path

ADAPTER = "/opt/hermes/plugins/platforms/telegram/adapter.py"
STORE = "/opt/hermes/gateway/rich_sent_store.py"
ADAPTER_MARKER = "# openclaw-patch: prefer cached Telegram rich reply source"
STORE_MARKER = "# openclaw-patch: long Telegram proposal reply context"

OLD_REPLY_BLOCK = '''        reply_to_text = message.reply_to_message.text or message.reply_to_message.caption or None
        if not reply_to_text:
            reply_to_text = self._extract_rich_reply_text(message.reply_to_message)
        if not reply_to_text:
            try:
                from gateway import rich_sent_store
                reply_to_text = rich_sent_store.lookup(str(message.chat.id), reply_to_id)
            except Exception:
                # Extract reply context if this message is a reply. Prefer Telegram's native partial quote
                # (message.quote, TextQuote) so a user replying to a single selected substring of a prior
                # multi-section message doesn't get the whole replied-to message injected into the agent's
                # context — which can cause the agent to act on unrelated actionable-looking text the user
                # didn't quote (#22619). Fall back to the full replied-to message text / caption when no
                # native quote is present.
                reply_to_text = None
        return reply_to_id, reply_to_text
'''

NEW_REPLY_BLOCK = f'''{ADAPTER_MARKER}
        # Native quote was handled above; cached rich content beats partial API echoes.
        try:
            from gateway import rich_sent_store
            reply_to_text = rich_sent_store.lookup(str(message.chat.id), reply_to_id)
        except Exception:
            reply_to_text = None
        if not reply_to_text:
            reply_to_text = message.reply_to_message.text or message.reply_to_message.caption or None
        if not reply_to_text:
            reply_to_text = self._extract_rich_reply_text(message.reply_to_message)
        return reply_to_id, reply_to_text
'''


class PatchError(Exception):
    pass


def patch_adapter(text: str) -> str:
    if ADAPTER_MARKER in text:
        return text
    if text.count(OLD_REPLY_BLOCK) != 1:
        raise PatchError("upstream Telegram _reply_context block not found exactly once")
    return text.replace(OLD_REPLY_BLOCK, NEW_REPLY_BLOCK)


def patch_store(text: str) -> str:
    if STORE_MARKER in text:
        return text
    old = "_MAX_TEXT_CHARS = 2000"
    new = f"_MAX_TEXT_CHARS = 20000 {STORE_MARKER}"
    if text.count(old) != 1:
        raise PatchError("upstream rich_sent_store text limit not found exactly once")
    return text.replace(old, new)


def main(argv: list[str]) -> int:
    adapter_path = Path(argv[1] if len(argv) > 1 else ADAPTER)
    store_path = Path(argv[2] if len(argv) > 2 else STORE)
    try:
        adapter = patch_adapter(adapter_path.read_text(encoding="utf-8"))
        store = patch_store(store_path.read_text(encoding="utf-8"))
        adapter_path.write_text(adapter, encoding="utf-8")
        store_path.write_text(store, encoding="utf-8")
    except (OSError, PatchError) as exc:
        print(f"patch-telegram-reply-context: {exc}", file=sys.stderr)
        return 1
    print(f"patch-telegram-reply-context: patched {adapter_path} and {store_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
