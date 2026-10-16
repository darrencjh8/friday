#!/usr/bin/env python3
"""Build-time patch for upstream hermes_state.py: reap stale open webhook sessions.

Every webhook delivery gets its own one-shot session (chat id ``webhook:<route>:<delivery_id>``,
so its session key is never reused). Upstream closes it from the adapter's
``on_processing_complete`` hook, but a gateway restart or crash mid-run skips that hook, and
builds before upstream added the hook (between v2026.7.1 and v2026.7.7) never closed them at all.
``prune_sessions`` only deletes ended rows and the automatic stale-open sweep
(``SessionDB._AUTO_PRUNE_STALE_OPEN_SOURCES``) does not list ``webhook``, so those rows stay open
and unpruned forever.

This patch adds ``webhook`` to that tuple. The sweep closes (``startup_orphan_reap``, non-destructive,
resumable) only rows whose start and last activity are both older than ``retention_days``, so a
live delivery is never touched. slack, telegram and the other messaging sources are deliberately
left out: their sessions can be live conversations.

Usage: patch-stale-open-webhook.py [path]   (default /opt/hermes/hermes_state.py)
Idempotent; exits non-zero if the upstream text has drifted, so an image bump that changes this
code fails the build instead of silently dropping the fix.
"""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes/hermes_state.py"
MARKER = "# openclaw-patch: reap stale open webhook sessions"

OLD_BLOCK = '''    _AUTO_PRUNE_STALE_OPEN_SOURCES: tuple[str, ...] = (
        "cli", "cron", "kanban", "acp", "api_server", "subagent", "tool", "recovered",
    )
'''

NEW_BLOCK = '''    ''' + MARKER + '''
    _AUTO_PRUNE_STALE_OPEN_SOURCES: tuple[str, ...] = (
        "cli", "cron", "kanban", "acp", "api_server", "subagent", "tool", "recovered", "webhook",
    )
'''


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    if text.count(OLD_BLOCK) != 1:
        raise PatchError("upstream _AUTO_PRUNE_STALE_OPEN_SOURCES block not found exactly once; update the patch")
    return text.replace(OLD_BLOCK, NEW_BLOCK)


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-stale-open-webhook: {exc}", file=sys.stderr)
        return 1
    print(f"patch-stale-open-webhook: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
