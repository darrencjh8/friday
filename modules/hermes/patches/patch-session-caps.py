#!/usr/bin/env python3
"""Build-time patch for upstream hermes_state_maintenance.py: session count and size caps.

Upstream auto-prune only deletes ended sessions older than ``sessions.retention_days``. A busy
month can still grow state.db without bound inside that window, so this patch adds two optional
caps, read from the same ``sessions`` config block, that run right after the age prune and
before the VACUUM decision:

* ``max_sessions``: when the total session count is above it, delete the least recently active
  ended sessions until it fits.
* ``max_db_mb``: while the used bytes of state.db (pages not on the freelist) are above it,
  delete the least recently active ended sessions, in batches sized from the average
  bytes per session.

Both use upstream ``prune_sessions`` (so pinned rows, open rows, rows under a live write guard
and freshly orphan-reaped rows are never deleted, and transcript files go with their rows), and
0 or unset disables a cap. When both are set, whichever is tighter wins. Deleted rows count
toward ``pruned``, so the usual VACUUM gate reclaims the space.

Usage: patch-session-caps.py [path]   (default /opt/hermes/hermes_state_maintenance.py)
Idempotent; exits non-zero if the upstream text has drifted.
"""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes/hermes_state_maintenance.py"
MARKER = "# openclaw-patch: session count/size caps"

OLD_WIRING = '''            result["closed"] = len(closed)
'''

NEW_WIRING = '''            result["closed"] = len(closed)
            ''' + MARKER + '''
            result["capped"] = capped = _openclaw_enforce_caps(self, sessions_dir)
            result["pruned"] = pruned = pruned + capped
'''

HELPERS = '''

def _openclaw_cap_limits():
    """(max_sessions, max_db_mb) from the active profile's ``sessions`` config; 0 = off."""
    try:
        from hermes_cli.config import load_config
        cfg = (load_config() or {}).get("sessions") or {}
        return max(0, int(cfg.get("max_sessions") or 0)), max(0.0, float(cfg.get("max_db_mb") or 0))
    except Exception as exc:
        logger.warning("state.db session caps skipped: %s", exc)
        return 0, 0.0


def _openclaw_prune_oldest(db, count, sessions_dir):
    """Delete up to about *count* least recently active ended sessions; returns rows deleted.
    Rows prune_sessions refuses (write guards, fresh orphan reaps) widen the window instead of
    stalling the cap."""
    candidates = db.list_prune_candidates(older_than_days=None)
    take = max(1, count)
    while candidates:
        batch = candidates[:take]
        removed = db.prune_sessions(
            older_than_days=None, sessions_dir=sessions_dir, exclude_active_write_guards=True,
            last_active_before=float(batch[-1]["last_active"]) + 1e-6)
        if removed or take >= len(candidates):
            return removed
        take *= 2
    return 0


def _openclaw_used_bytes(db):
    values = db._page_pragmas(("page_count", "freelist_count", "page_size"),
                              "Could not read used DB size: %s")
    return None if values is None else (values[0] - values[1]) * values[2]


def _openclaw_enforce_caps(db, sessions_dir, limits=None):
    """Apply ``sessions.max_sessions`` and ``sessions.max_db_mb``; returns sessions deleted."""
    max_sessions, max_db_mb = _openclaw_cap_limits() if limits is None else limits
    removed = 0
    if max_sessions > 0:
        total = int(db._read_one("SELECT COUNT(*) FROM sessions")[0])
        while total - removed > max_sessions:
            got = _openclaw_prune_oldest(db, total - removed - max_sessions, sessions_dir)
            if not got:
                break
            removed += got
    if max_db_mb > 0:
        cap = max_db_mb * 1024 * 1024
        while True:
            used = _openclaw_used_bytes(db)
            if used is None or used <= cap:
                break
            # Size the batch from the average row footprint so one pass lands near the cap.
            total = int(db._read_one("SELECT COUNT(*) FROM sessions")[0])
            per_session = used / total if total else used
            need = int(-(-(used - cap) // per_session)) if per_session else 1
            got = _openclaw_prune_oldest(db, need, sessions_dir)
            if not got:
                break
            removed += got
    if removed:
        logger.info("state.db auto-maintenance: session caps (max_sessions=%d, max_db_mb=%g) "
                    "pruned %d session(s)", max_sessions, max_db_mb, removed)
    return removed
'''


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    if text.count(OLD_WIRING) != 1 or "def maybe_auto_prune_and_vacuum" not in text:
        raise PatchError("upstream auto-prune wiring not found exactly once; update the patch")
    return text.replace(OLD_WIRING, NEW_WIRING).rstrip("\n") + "\n" + HELPERS


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-session-caps: {exc}", file=sys.stderr)
        return 1
    print(f"patch-session-caps: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
