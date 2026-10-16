#!/usr/bin/env python3
"""Build-time patch for upstream plugins/platforms/slack/adapter.py: recover two lost-reply errors.

Upstream ``_call_with_block_fallback`` already retries a rejected Block Kit payload once without
``blocks`` (the ``text`` chunk is already split by ``_post_chunks``/``truncate_message``), but its
recoverable codes are ``invalid_blocks``, ``msg_too_long`` and ``too_many_blocks``. Slack answers a
payload with more than 50 blocks (``rich_blocks: true``) with ``msg_blocks_too_long``, which is not
listed, so the reply is dropped. Upstream also has no fallback for ``cannot_reply_to_message`` (the
thread parent is deleted or cannot be replied to, with ``reply_to_mode: first`` and
``reply_in_thread: true``), so that reply is dropped too.

This patch (1) adds ``msg_blocks_too_long`` to the recoverable block codes and logs the block
fallback at WARNING, and (2) wraps the helper so a ``chat.postMessage`` failing with
``cannot_reply_to_message`` is retried once without ``thread_ts`` / ``reply_broadcast``, posting to
the channel. Each fallback runs at most once per send; nothing loops.

Usage: patch-slack-send-fallback.py [path]
(default /opt/hermes/plugins/platforms/slack/adapter.py)
Idempotent; exits non-zero if the upstream text has drifted.
"""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes/plugins/platforms/slack/adapter.py"
MARKER = "# openclaw-patch: slack send fallbacks"

OLD_CODES = '''        recoverable_codes = {"invalid_blocks", "msg_too_long", "too_many_blocks"}
'''
NEW_CODES = '''        recoverable_codes = {"invalid_blocks", "msg_too_long", "too_many_blocks", "msg_blocks_too_long"}
'''

OLD_LOG = '''                logger.info(
                    "[Slack] Block Kit payload rejected; retrying %s without blocks: %s", verb, e)
'''
NEW_LOG = '''                logger.warning(
                    "[Slack] Block Kit payload rejected; retrying %s without blocks: %s", verb, e)
'''

OLD_DEF = '''    async def _call_with_block_fallback(
        self, client_fn: Callable[[], Any], method: str, kwargs: dict[str, Any], verb: str) -> Any:
'''
NEW_DEF = '''    ''' + MARKER + '''
    @staticmethod
    def _slack_error_code(error: BaseException) -> str:
        response_get = getattr(getattr(error, "response", None), "get", None)
        if callable(response_get):
            try:
                code = response_get("error")
                if code:
                    return str(code)
            except Exception:
                pass
        return str(error)

    async def _call_with_block_fallback(
        self, client_fn: Callable[[], Any], method: str, kwargs: dict[str, Any], verb: str) -> Any:
        """Upstream block fallback, plus one retry without ``thread_ts`` on ``cannot_reply_to_message``."""
        try:
            return await self._call_with_block_fallback_upstream(client_fn, method, kwargs, verb)
        except Exception as e:
            if (method == "chat_postMessage" and kwargs.get("thread_ts")
                    and "cannot_reply_to_message" in self._slack_error_code(e)):
                retry_kwargs = {
                    k: v for k, v in kwargs.items() if k not in ("thread_ts", "reply_broadcast")}
                logger.warning(
                    "[Slack] cannot_reply_to_message; retrying %s without thread_ts "
                    "(posting to the channel): %s", verb, e)
                return await self._call_with_block_fallback_upstream(
                    client_fn, method, retry_kwargs, verb)
            raise

    async def _call_with_block_fallback_upstream(
        self, client_fn: Callable[[], Any], method: str, kwargs: dict[str, Any], verb: str) -> Any:
'''


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    for old in (OLD_CODES, OLD_LOG, OLD_DEF):
        if text.count(old) != 1:
            raise PatchError(f"upstream block not found exactly once; update the patch: {old.strip()[:60]}")
    return text.replace(OLD_CODES, NEW_CODES).replace(OLD_LOG, NEW_LOG).replace(OLD_DEF, NEW_DEF)


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-slack-send-fallback: {exc}", file=sys.stderr)
        return 1
    print(f"patch-slack-send-fallback: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
