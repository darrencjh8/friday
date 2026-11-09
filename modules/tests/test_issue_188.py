"""Repro for friday #188: a thumbs-up reaction on a pending approval does nothing.

At base, _on_user_reaction only forwards to _reaction_handler, which is never
registered, so the pending approval stays pending. After the fix, a 👍 on the
approval message resolves it as "once" (same as the approve button) and a 👎
resolves it as "deny". Skin-tone variants and the variation selector count.
Run from the repo root: python3 modules/tests/test_issue_188.py
"""
import asyncio
import sys
import types
from pathlib import Path

TEST_ID = "tests.test_issue_188.TestIssue188.test_thumbs_up_resolves_pending_approval"

ROOT = Path(__file__).resolve().parent.parent.parent


def _stub_host_modules():
    """The adapter imports host modules (gateway.*, hermes_constants) that are
    not in this repo. Stub the names it needs at import time."""
    gateway = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    config.Platform = type("Platform", (), {"__call__": lambda cls, v: v})
    config.PlatformConfig = type("PlatformConfig", (), {})
    platforms = types.ModuleType("gateway.platforms")
    shared = types.ModuleType("gateway.platforms._shared")
    shared.extra_or_secret = lambda *a, **k: ""
    shared.get_scoped_secret = lambda *a, **k: ""
    shared.seed_extra_from_env = lambda *a, **k: None
    shared.send_error = lambda *a, **k: None
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = type("BasePlatformAdapter", (), {"__init__": lambda self, **k: None})
    base.SendResult = type("SendResult", (), {})
    event = types.ModuleType("gateway.platforms.event")
    event.MessageEvent = type("MessageEvent", (), {})
    _mt = type("MessageType", (), {})
    for _name in ("TEXT", "PHOTO", "VIDEO", "AUDIO", "VOICE", "DOCUMENT"):
        setattr(_mt, _name, _name)
    event.MessageType = _mt
    helpers = types.ModuleType("gateway.platforms.helpers")
    helpers.MessageDeduplicator = type("MessageDeduplicator", (), {"__init__": lambda self, **k: None})
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: Path("/tmp/hermes-home-188")
    for name, mod in {
        "gateway": gateway, "gateway.config": config,
        "gateway.platforms": platforms, "gateway.platforms._shared": shared,
        "gateway.platforms.base": base, "gateway.platforms.event": event,
        "gateway.platforms.helpers": helpers, "hermes_constants": constants,
    }.items():
        sys.modules[name] = mod


def _load_adapter():
    _stub_host_modules()
    sys.path.insert(0, str(ROOT))
    import importlib
    return importlib.import_module("modules.hermes.plugins.dots.adapter")


class _HistoryStub:
    def __init__(self):
        self.updates = []

    def update(self, message_id, **kwargs):
        self.updates.append((message_id, kwargs))
        return True


class _Case:
    """One fresh adapter with a pending approval, plus captured side effects."""

    def __init__(self, adapter_mod, resolved, approval_id="appr1", session="session1",
                 handler=None):
        self.adapter = adapter_mod.DotsAdapter.__new__(adapter_mod.DotsAdapter)
        self.adapter._approvals = {approval_id: session}
        self.adapter._reaction_handler = handler
        self.adapter._history = _HistoryStub()
        self.pushed = []
        self.forwarded = []
        self.resolved = resolved

        async def _push(event):
            self.pushed.append(event)

        self.adapter._push = _push
        if handler is not None:
            async def _handler(event):
                self.forwarded.append(event)
            self.adapter._reaction_handler = _handler

    async def react(self, message_id, emoji):
        await self.adapter._on_user_reaction({"message_id": message_id, "emoji": emoji})


def main():
    adapter_mod = _load_adapter()
    resolved = []
    tools_pkg = types.ModuleType("tools")
    approval_mod = types.ModuleType("tools.approval")
    approval_mod.resolve_gateway_approval = lambda session_key, choice: resolved.append((session_key, choice))
    sys.modules["tools"] = tools_pkg
    sys.modules["tools.approval"] = approval_mod

    failures = []

    def check(label, cond):
        if not cond:
            failures.append(label)
            print(f"FAIL: {TEST_ID} {label}")

    async def run():
        # Core: 👍 resolves as "once", with approval_resolved push + history.
        case = _Case(adapter_mod, resolved)
        await case.react("appr1", "👍")
        check("thumbs-up on pending approval did not resolve it",
              ("session1", "once") in resolved and len(resolved) == 1)
        check("approval appr1 still pending after thumbs-up",
              "appr1" not in case.adapter._approvals)
        check("approval_resolved push missing after thumbs-up",
              {"type": "approval_resolved", "approval_id": "appr1",
               "choice": "once"} in case.pushed)
        check("history not updated resolved=once after thumbs-up",
              ("appr1", {"resolved": "once"}) in case.adapter._history.updates)

        # 👎 resolves as "deny".
        case = _Case(adapter_mod, resolved, approval_id="appr2", session="session2")
        await case.react("appr2", "👎")
        check("thumbs-down did not resolve as deny",
              ("session2", "deny") in resolved)
        check("history not updated resolved=deny after thumbs-down",
              ("appr2", {"resolved": "deny"}) in case.adapter._history.updates)

        # Skin-tone 👍 and variation-selector 👍 resolve.
        case = _Case(adapter_mod, resolved, approval_id="appr3", session="session3")
        await case.react("appr3", "👍🏻")
        check("skin-tone thumbs-up did not resolve", ("session3", "once") in resolved)
        case = _Case(adapter_mod, resolved, approval_id="appr4", session="session4")
        await case.react("appr4", "👍️")
        check("variation-selector thumbs-up did not resolve",
              ("session4", "once") in resolved)

        # Skin-tone 👎 resolves as "deny".
        case = _Case(adapter_mod, resolved, approval_id="appr5", session="session5")
        await case.react("appr5", "👎🏽")
        check("skin-tone thumbs-down did not resolve as deny",
              ("session5", "deny") in resolved)

        # 👍 on a non-approval message resolves nothing.
        before = len(resolved)
        case = _Case(adapter_mod, resolved)
        await case.react("not-an-approval", "👍")
        check("thumbs-up on non-approval resolved something",
              len(resolved) == before)

        # 👍 after the approval already resolved resolves nothing.
        case = _Case(adapter_mod, resolved, approval_id="appr6", session="session6")
        await case.react("appr6", "👍")
        before = len(resolved)
        await case.react("appr6", "👍")
        check("second thumbs-up after resolve resolved again",
              len(resolved) == before)

        # Duplicate 👍 then 👎: second frame is a no-op (one-shot pop).
        case = _Case(adapter_mod, resolved, approval_id="appr7", session="session7")
        await case.react("appr7", "👍")
        before = len(resolved)
        await case.react("appr7", "👎")
        check("thumbs-down after thumbs-up resolved again",
              len(resolved) == before and ("session7", "deny") not in resolved)

        # reaction:removed resolves nothing AND the approval stays pending.
        case = _Case(adapter_mod, resolved, approval_id="appr8", session="session8")
        await case.react("appr8", None)
        check("reaction:removed wrongly resolved pending approval",
              len(resolved) == before)
        check("reaction:removed wrongly dropped pending approval",
              "appr8" in case.adapter._approvals)

        # Other emoji resolves nothing.
        case = _Case(adapter_mod, resolved, approval_id="appr9", session="session9")
        await case.react("appr9", "❤️")
        check("heart reaction resolved something", len(resolved) == before)

        # Non-string emoji and empty message_id do not crash.
        case = _Case(adapter_mod, resolved, approval_id="appr10", session="session10")
        await case.react("appr10", 123)
        await case.react("", "👍")
        await case.react(None, "👍")
        check("non-string emoji or empty message_id resolved something",
              len(resolved) == before)

        # Reaction still forwarded to _reaction_handler when registered.
        case = _Case(adapter_mod, resolved, approval_id="appr11", session="session11",
                     handler=True)
        await case.react("appr11", "👍")
        check("reaction not forwarded to registered handler",
              len(case.forwarded) == 1
              and case.forwarded[0]["event_name"] == "reaction:added"
              and case.forwarded[0]["reaction"] == "👍")

    asyncio.run(run())

    ok = not failures
    print(f"{TEST_ID}: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
