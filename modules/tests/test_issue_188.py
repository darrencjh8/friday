"""Repro for friday #188: a thumbs-up reaction on a pending approval does nothing.

At base, _on_user_reaction only forwards to _reaction_handler, which is never
registered, so the pending approval stays pending. After the fix, a 👍 on the
approval message resolves it as "once" (same as the approve button).
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


def main():
    adapter_mod = _load_adapter()
    resolved = []
    tools_pkg = types.ModuleType("tools")
    approval_mod = types.ModuleType("tools.approval")
    approval_mod.resolve_gateway_approval = lambda session_key, choice: resolved.append((session_key, choice))
    sys.modules["tools"] = tools_pkg
    sys.modules["tools.approval"] = approval_mod

    adapter = adapter_mod.DotsAdapter.__new__(adapter_mod.DotsAdapter)
    adapter._approvals = {"appr1": "session1"}
    adapter._reaction_handler = None
    adapter._history = _HistoryStub()
    pushed = []

    async def _push(event):
        pushed.append(event)

    adapter._push = _push

    async def run():
        await adapter._on_user_reaction({"message_id": "appr1", "emoji": "👍"})
        # Decision-neutral guards (must hold at base and at HEAD):
        await adapter._on_user_reaction({"message_id": "not-an-approval", "emoji": "👍"})
        adapter._approvals["appr2"] = "session2"
        await adapter._on_user_reaction({"message_id": "appr2", "emoji": None})
        # Reaction:removed must leave the approval pending (assert, don't pop).
        if "appr2" not in adapter._approvals:
            print(f"FAIL: {TEST_ID} reaction:removed wrongly resolved pending approval appr2")
            failures.append("removed")
        adapter._approvals.pop("appr2", None)

    failures = []
    asyncio.run(run())

    ok = not failures
    if ("session1", "once") not in resolved:
        print(f"FAIL: {TEST_ID} thumbs-up on pending approval did not resolve it (resolved={resolved})")
        ok = False
    if "appr1" in adapter._approvals:
        print(f"FAIL: {TEST_ID} approval appr1 still pending after thumbs-up")
        ok = False
    if len(resolved) != 1:
        print(f"FAIL: {TEST_ID} expected exactly one resolution, got {resolved}")
        ok = False
    print(f"{TEST_ID}: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
