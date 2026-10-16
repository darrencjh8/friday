"""Book an email intake could not classify, as the owner chose (#783, cutover PR 2).

Live intake sends a review request for uncertain mail with three tappable
commands: /replay_<id>_tx, /replay_<id>_stmt and /replay_<id>_pf. The command
is handled here, before the model sees it: it only queues the owner's choice
in the intake journal. The intake service books it on its next run (one signed
tracker request, exactly once) and reports the result like any other email.

Only the home chat and an allowed user can replay, only mail still waiting for
review can be replayed, and nothing is queued while intake is in shadow mode.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sqlite3
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_COMMAND_RE = re.compile(r"^/replay_([0-9a-f]{10})_(tx|stmt|pf)(@[A-Za-z0-9_]+)?\s*$")
_CHOICES = {
    "tx": ("actual_budget", "transaction", "a transaction"),
    "stmt": ("actual_budget", "statement", "a statement"),
    "pf": ("portfolio", "transaction", "a portfolio entry"),
}
_DEFAULT_DATA_DIR = "/opt/data/email-intake"
_FAILED = "Something went wrong."


def _is_home_chat(source) -> bool:
    platform = getattr(getattr(source, "platform", None), "value", None)
    home = os.environ.get("TELEGRAM_HOME_CHANNEL", "")
    if platform != "telegram" or not home or str(getattr(source, "chat_id", "")) != home:
        return False
    # This hook runs before Hermes's own authorization, so check the sender too.
    allowed = {u.strip() for u in os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",") if u.strip()}
    return str(getattr(source, "user_id", "")) in allowed


def _queue(replay_id: str, choice: str) -> str:
    destination, subtype, label = _CHOICES[choice]
    if (os.environ.get("EMAIL_INTAKE_MODE", "") or "").strip().lower() != "live":
        return "Email intake is in shadow mode, so nothing was booked."
    path = Path(os.environ.get("EMAIL_INTAKE_DATA_DIR") or _DEFAULT_DATA_DIR) / "journal.db"
    if not path.exists():
        return _FAILED
    db = sqlite3.connect(str(path), timeout=10)
    try:
        rows = db.execute(
            "SELECT DISTINCT evidence_hash FROM messages WHERE status = 'shadow_uncertain' AND evidence_hash LIKE ?",
            (replay_id + "%",),
        ).fetchall()
        if len(rows) != 1:
            return "That email is not waiting for review (already handled, or unknown)."
        evidence_hash = rows[0][0]
        done = db.execute("SELECT 1 FROM replays WHERE evidence_hash = ?", (evidence_hash,)).fetchone()
        if done:
            return "That email was already replayed."
        db.execute("INSERT INTO replays VALUES (?,?,?,?,0)", (evidence_hash, destination, subtype, time.time()))
        db.commit()
    finally:
        db.close()
    return f"Queued: it will be booked as {label} within a few minutes."


async def _on_pre_gateway_dispatch(event=None, gateway=None, **_kwargs):
    """Skip and answer a replay command; let every other message through. Never raises."""
    try:
        source = getattr(event, "source", None)
        text = getattr(event, "text", None)
        if not isinstance(text, str) or not _is_home_chat(source):
            return None
        match = _COMMAND_RE.match(text)
        if not match:
            return None
        try:
            reply = await asyncio.to_thread(_queue, match.group(1), match.group(2))
        except Exception as error:  # noqa: BLE001 - the user still gets an answer
            logger.warning("replay command failed: %s", type(error).__name__)
            reply = _FAILED
        try:
            adapter = gateway._delivery_adapter_for(source)
            if adapter:
                await adapter.send(source.chat_id, reply)
        except Exception as error:  # noqa: BLE001
            logger.warning("replay reply failed: %s", type(error).__name__)
        return {"action": "skip", "reason": "intake-replay-command"}
    except Exception as error:  # noqa: BLE001
        logger.warning("intake-commands hook error: %s", type(error).__name__)
        return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)
