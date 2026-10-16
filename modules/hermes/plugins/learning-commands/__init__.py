"""Answer expense-tracker learning offers from tappable Telegram commands (#723).

The model must never hold the call that turns an offer into a fact. A
/remember_<id> or /forget_<id> message from the home chat is handled here,
before the model sees it, by calling the tracker with an HMAC the model cannot
compute (it has no access to the bot token).

The wiki is the knowledge authority (#783), and the tracker only reads it. So
an answered /remember is also written here, as one exact-key row on the wiki's
merchant mapping page: the user's tap is the approval, and this is the only
writer outside the wiki's own maintenance jobs.
"""

from __future__ import annotations

import asyncio
import datetime
import fcntl
import hashlib
import hmac
import json
import logging
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

_COMMAND_RE = re.compile(r"^/(remember|forget)_([a-z0-9]{1,16})(@[A-Za-z0-9_]+)?\s*$")
_DEFAULT_URL = "http://expense-tracker:8080/learning/answer"
_TIMEOUT_SECONDS = 15
_MAPPING_PAGE = "entities/accounts/merchant-payee-mappings.md"
_ROW_RE = re.compile(r"^\| `(?P<key>[^`]*)` \| (?P<payee>[^|]*?) \|")
_UNSAFE_RE = re.compile(r"[|`\r\n]|password|passcode|\bpin\b|\bnric\b", re.IGNORECASE)
_MAX_CELL = 120
_EXPIRED = "This offer has expired or was already answered."
_FAILED = "Something went wrong."


def _command_key(token: str) -> str:
    return hmac.new(token.encode(), b"learning-command", hashlib.sha256).hexdigest()


def sign(action: str, offer_id: str, token: str) -> str:
    """Hex HMAC-SHA256 over ``action:ID``, matching expense-tracker's learning-notify.js."""
    message = f"{action}:{offer_id.upper()}".encode()
    return hmac.new(_command_key(token).encode(), message, hashlib.sha256).hexdigest()


def _call_tracker(action: str, offer_id: str, token: str) -> tuple[int, dict]:
    url = os.environ.get("LEARNING_ANSWER_URL") or _DEFAULT_URL
    request = urllib.request.Request(
        url,
        data=json.dumps({"id": offer_id.upper(), "action": action}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Learning-Signature": sign(action, offer_id, token),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {}


def _wiki_root() -> Path:
    return Path(os.environ.get("WIKI_PATH") or "/opt/data/home/wiki")


def _safe_cell(value) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= _MAX_CELL and not _UNSAFE_RE.search(value)


def _write_wiki_mapping(descriptor, payee, today=None) -> str:
    """Add or replace one `descriptor` -> `payee` row; returns what happened. Never raises."""
    try:
        if not (_safe_cell(descriptor) and _safe_cell(payee)):
            return "rejected"
        descriptor, payee = descriptor.strip(), payee.strip()
        today = today or datetime.date.today().isoformat()
        root = _wiki_root()
        page = root / _MAPPING_PAGE
        if not page.is_file():
            return "missing"
        row = f"| `{descriptor}` | {payee} |  | confirmed | telegram-remember {today} |"
        with open(page, "r+", encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            lines = handle.read().split("\n")
            outcome, last_row = "added", None
            in_mappings = False
            for i, line in enumerate(lines):
                if line.startswith("## "):
                    in_mappings = line.strip() == "## Mappings"
                    continue
                match = _ROW_RE.match(line) if in_mappings else None
                if not match:
                    continue
                last_row = i
                if match.group("key") == descriptor:
                    if match.group("payee").strip() == payee:
                        return "unchanged"
                    lines[i], outcome = row, "replaced"
            if outcome == "added":
                if last_row is None:
                    return "missing"
                lines.insert(last_row + 1, row)
            text = re.sub(r"^updated: .*$", f"updated: {today}", "\n".join(lines), count=1, flags=re.M)
            tmp = page.with_name(page.name + ".tmp")
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, page)
        log = root / "log.md"
        if log.is_file():
            with open(log, "a", encoding="utf-8") as handle:
                handle.write(
                    f"\n## [{today}] remember | {descriptor} -> {payee} ({outcome})\n"
                    f"- Written by the learning-commands plugin from the owner's /remember tap.\n"
                )
        return outcome
    except Exception as error:  # noqa: BLE001 - the tap still gets an answer
        logger.warning("wiki remember write failed: %s", type(error).__name__)
        return "error"


def _reply_text(status: int, body: dict) -> str:
    if status == 404 and body.get("reason") == "expired":
        return _EXPIRED
    if status != 200 or not body.get("ok"):
        return _FAILED
    descriptor, payee = body.get("descriptor", ""), body.get("payee", "")
    if body.get("result") == "remembered":
        return f'Remembered: "{descriptor}" is {payee}'
    return f'Not remembered: "{descriptor}"'


def _is_home_chat(source) -> bool:
    platform = getattr(getattr(source, "platform", None), "value", None)
    home = os.environ.get("TELEGRAM_HOME_CHANNEL", "")
    if platform != "telegram" or not home or str(getattr(source, "chat_id", "")) != home:
        return False
    # This hook runs before Hermes's own authorization, so check the sender too.
    allowed = {u.strip() for u in os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",") if u.strip()}
    return str(getattr(source, "user_id", "")) in allowed


async def _on_pre_gateway_dispatch(event=None, gateway=None, **_kwargs):
    """Skip and answer a learning command; let every other message through. Never raises."""
    try:
        source = getattr(event, "source", None)
        text = getattr(event, "text", None)
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not token or not isinstance(text, str) or not _is_home_chat(source):
            return None
        match = _COMMAND_RE.match(text)
        if not match:
            return None
        action, offer_id = match.group(1), match.group(2)
        try:
            status, body = await asyncio.to_thread(_call_tracker, action, offer_id, token)
            reply = _reply_text(status, body)
            if status == 200 and body.get("ok") and body.get("result") == "remembered":
                written = await asyncio.to_thread(
                    _write_wiki_mapping, body.get("descriptor"), body.get("payee")
                )
                if written in ("added", "replaced", "unchanged"):
                    reply += " (saved to the wiki)"
                else:
                    reply += f", but the wiki was not updated ({written})"
        except Exception as error:  # noqa: BLE001 - the user still gets an answer
            logger.warning("learning answer failed: %s", type(error).__name__)
            reply = _FAILED
        try:
            adapter = gateway._delivery_adapter_for(source)
            if adapter:
                await adapter.send(source.chat_id, reply)
        except Exception as error:  # noqa: BLE001
            logger.warning("learning reply failed: %s", type(error).__name__)
        return {"action": "skip", "reason": "learning-command"}
    except Exception as error:  # noqa: BLE001
        logger.warning("learning-commands hook error: %s", type(error).__name__)
        return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)
