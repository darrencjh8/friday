#!/usr/bin/env python3
"""Build-time patch for upstream gateway/lifecycle_ledger.py (issue #650).

Upstream runs ``PRAGMA quick_check(1)`` on state.db synchronously on the event
loop thread whenever the previous gateway life died uncleanly. On a multi-GB
store that is an hour or more of silent startup. This patch keeps the check but
runs it on a daemon thread:

* record_startup() returns immediately; the evidence dict and the first
  ``gateway.previous_unclean_exit`` exit-diag record carry
  ``state_db_integrity: "pending"`` (never "ok" for a check that has not run).
* The real verdict is logged and appended to gateway-exit-diag.log as a
  ``gateway.state_db_integrity_check`` record when the check finishes.

Usage: patch-lifecycle-ledger.py [path]   (default /opt/hermes/gateway/lifecycle_ledger.py)
The patch is idempotent and exits non-zero if the upstream text has drifted, so
an image bump that changes this code fails the build instead of silently
dropping the fix.
"""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes/gateway/lifecycle_ledger.py"
MARKER = "# openclaw-patch: issue-650 background integrity check"

OLD_BLOCK = '''def _report_unclean_exit(evidence: dict[str, Any], home: Optional[Path]) -> None:
    """Integrity-check the store, persist the exit-diag record, log at WARNING."""
    # The death may have torn the store; this is the only moment we know to look.
    verdict = evidence["state_db_integrity"] = check_state_db_integrity(home=home)
    if verdict not in ("ok", "absent"):
        logger.error(
            "state.db FAILED integrity check after an unclean gateway exit: %s — sessions may read as "
            "missing until it is repaired. Run `hermes doctor`.",
            verdict,
        )
'''

NEW_BLOCK = MARKER + '''
def _log_integrity_verdict(verdict: str) -> None:
    if verdict not in ("ok", "absent"):
        logger.error(
            "state.db FAILED integrity check after an unclean gateway exit: %s — sessions may read as "
            "missing until it is repaired. Run `hermes doctor`.",
            verdict,
        )


def _start_background_integrity_check(home: Optional[Path]) -> None:
    """Run the quick_check off the startup path; quick_check can take an hour on a multi-GB store."""
    import threading

    def _worker() -> None:
        started = time.monotonic()
        try:
            verdict = check_state_db_integrity(home=home)
        except Exception as exc:
            verdict = f"check-failed: {exc}"
        elapsed = round(time.monotonic() - started, 1)
        _log_integrity_verdict(verdict)
        logger.info("state.db integrity check finished in %.1fs: %s", elapsed, verdict)
        _append_exit_diag(
            {"ts": _now_iso(), "tag": "gateway.state_db_integrity_check", "pid": os.getpid(),
             "state_db_integrity": verdict, "elapsed_s": elapsed},
            home,
        )

    logger.warning(
        "state.db integrity check after an unclean exit is running in the background; "
        "its verdict will be logged when it finishes (can take a long time on a large store)."
    )
    threading.Thread(target=_worker, name="state-db-integrity-check", daemon=True).start()


def _report_unclean_exit(evidence: Dict[str, Any], home: Optional[Path]) -> None:
    """Persist the exit-diag record, log at WARNING, and integrity-check the store in the background."""
    # Not scanned yet: "pending" must never read as healthy. The verdict lands in a later record.
    evidence["state_db_integrity"] = "pending"
'''

OLD_TAIL = '''        evidence.get("last_heartbeat_mem"), evidence.get("suspected_oom", False),
    )
'''

# Started last so the "pending" record is always written before the verdict record.
NEW_TAIL = OLD_TAIL + "    _start_background_integrity_check(home)\n"


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    if text.count(OLD_BLOCK) != 1:
        raise PatchError("upstream _report_unclean_exit block not found exactly once; update the patch")
    if text.count(OLD_TAIL) != 1:
        raise PatchError("upstream _report_unclean_exit tail not found exactly once; update the patch")
    return text.replace(OLD_BLOCK, NEW_BLOCK).replace(OLD_TAIL, NEW_TAIL)


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-lifecycle-ledger: {exc}", file=sys.stderr)
        return 1
    print(f"patch-lifecycle-ledger: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
