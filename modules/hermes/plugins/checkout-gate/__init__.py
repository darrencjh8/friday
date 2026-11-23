"""Ask the owner before Friday places an order or pays in the browser.

Card fills from the vault already need a tap (browser_vault asks before writing a
card into a page), but a shop that keeps a saved card never fills one. So any
browser call whose arguments name a final purchase button ("Place order",
"Pay now", "Buy now", ...) is sent to the human-approval gate, which shows an
Approve/Refuse card in Dots. Plugin approvals never go to the smart judge.

Cron runs have nobody to ask and `approvals.cron_mode: allow` would approve the
gate on its own, so there the call is blocked outright.

ponytail: this matches words in the call, so a click by coordinates on a
checkout page is not caught. Upgrade: also gate clicks while the page URL is a
checkout or payment page, read from the browser supervisor.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re

logger = logging.getLogger(__name__)

_TOOLS = frozenset({"browser_exec", "browser_cdp"})
_GAP = r"[\W_]*"  # spaces, dashes, underscores or nothing: "Place Order", "place-order", "BUY_NOW"
_PURCHASE_RE = re.compile(
    rf"place{_GAP}(your{_GAP})?order|pay{_GAP}now|buy{_GAP}now|confirm{_GAP}(and{_GAP})?pay|make{_GAP}payment"
    rf"|complete{_GAP}(purchase|order|payment)|submit{_GAP}(order|payment)",
    re.IGNORECASE,
)
_ASK = "Friday wants to place an order or pay in the browser. Approve only if the cart and total are right."
_BLOCKED = ("BLOCKED: placing an order or paying needs the owner's approval, and a scheduled run cannot ask. "
            "Stop at checkout and tell the owner what is in the cart.")


def _in_cron() -> bool:
    try:
        from tools import approval_context
        return bool(approval_context._is_cron_approval_context())
    except Exception:  # noqa: BLE001 - unknown context: the gate itself fails closed without a human
        return False


def _on_pre_tool_call(tool_name=None, args=None, **_kwargs):
    """Escalate a purchase-looking browser call to the owner; never raises."""
    try:
        if tool_name not in _TOOLS:
            return None
        text = json.dumps(args or {}, sort_keys=True, ensure_ascii=False)
        if not _PURCHASE_RE.search(text):
            return None
        if _in_cron():
            return {"action": "block", "message": _BLOCKED}
        # Per call, so "always" can only ever re-allow this exact call.
        digest = hashlib.sha256(text.encode()).hexdigest()[:16]
        return {"action": "approve", "message": _ASK, "rule_key": f"checkout:{digest}"}
    except Exception as error:  # noqa: BLE001
        logger.warning("checkout-gate hook error: %s", type(error).__name__)
        return {"action": "block", "message": _BLOCKED}


def register(ctx):
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
