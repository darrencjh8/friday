"""The Dots live screen attaches to the browser Hermes runs, and never launches one."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

PLUGIN = Path(__file__).parents[1] / "hermes/plugins/dots"
TASK = "task-1"
SESSION_URL = "http://127.0.0.1:9222"
RESOLVED_URL = "ws://127.0.0.1:9222/devtools/browser/abc"


class CapturedCDPInvalid(Exception):
    pass


def load_adapter():
    """Import the plugin with only the Hermes seams it needs at import time stubbed."""
    stubs = {name: MagicMock() for name in (
        "gateway", "gateway.config", "gateway.platforms", "gateway.platforms._shared",
        "gateway.platforms.event", "gateway.platforms.helpers", "hermes_constants",
    )}
    stubs["gateway.platforms.base"] = types.SimpleNamespace(BasePlatformAdapter=object, SendResult=MagicMock())
    spec = importlib.util.spec_from_file_location(
        "dots_under_test", PLUGIN / "adapter.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {**stubs, "dots_under_test": module}):
        spec.loader.exec_module(module)
    return module


class ScreenSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.adapter_module = load_adapter()
        self.registry = MagicMock()
        self.session = {"cdp_url": SESSION_URL}
        self.override = ""
        self.cdp = MagicMock(task_id=TASK)
        self.cdp.call.side_effect = lambda method, *a, **k: {"result": {
            "Page.getLayoutMetrics": {"cssVisualViewport": {"clientWidth": 100, "clientHeight": 50}},
            "Page.captureScreenshot": {"data": "jpeg"},
            "Page.getNavigationHistory": {"currentIndex": 0, "entries": [{"url": "https://example.com/", "title": "T"}]},
        }[method]}

        tools = {
            "tools": MagicMock(),
            "tools.browser_supervisor": types.SimpleNamespace(SUPERVISOR_REGISTRY=self.registry),
            "tools.browser_supervisor_capture": types.SimpleNamespace(CapturedCDPInvalid=CapturedCDPInvalid),
            "tools.browser_session": types.SimpleNamespace(session_for_task=lambda task: self.session),
            "tools.browser_session_cdp": types.SimpleNamespace(
                get_cdp_override=lambda: self.override,
                get_dialog_policy_config=lambda: ("must_respond", 300.0),
                resolve_cdp_override=lambda url: RESOLVED_URL,
            ),
        }
        patcher = patch.dict(sys.modules, tools)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.adapter = self.adapter_module.DotsAdapter.__new__(self.adapter_module.DotsAdapter)
        self.adapter._browser_task = TASK
        self.adapter._screen_cdp = None
        self.adapter._screen_sessions = {}
        self.adapter._screen_viewport = (1280, 720)
        self.adapter._screen_attach_warned = None
        self.adapter._visible_page_session = lambda cdp: "page"

    def test_attaches_to_the_session_browser_when_no_supervisor_is_live(self):
        started = []
        self.registry.get_or_start.side_effect = lambda **kw: started.append(kw)

        def capture(task, timeout):
            if not started:
                raise CapturedCDPInvalid("no supervisor")
            return self.cdp

        self.registry.capture.side_effect = capture

        frame = self.adapter._capture_frame(1.0)

        self.assertEqual("jpeg", frame["data"])
        self.assertEqual(
            [{"task_id": TASK, "cdp_url": RESOLVED_URL, "dialog_policy": "must_respond", "dialog_timeout_s": 300.0}],
            started,
        )

    def test_cdp_override_wins_like_hermes_own_attach(self):
        self.override = "ws://override/devtools/browser/x"
        self.registry.capture.return_value = self.cdp

        self.adapter._capture_frame(1.0)

        self.assertEqual("ws://override/devtools/browser/x", self.registry.get_or_start.call_args.kwargs["cdp_url"])

    def test_no_browser_session_never_starts_anything(self):
        self.session = {}
        self.registry.capture.side_effect = CapturedCDPInvalid("no supervisor")

        self.assertIsNone(self.adapter._capture_frame(1.0))
        self.registry.get_or_start.assert_not_called()

    def test_attach_failure_warns_once_per_task_with_the_cause(self):
        self.registry.get_or_start.side_effect = OSError("connection refused")
        self.registry.capture.side_effect = CapturedCDPInvalid("no supervisor")

        with self.assertLogs(self.adapter_module.logger, "WARNING") as logs:
            self.assertIsNone(self.adapter._capture_frame(1.0))
            self.assertIsNone(self.adapter._capture_frame(1.0))

        self.assertEqual(1, len(logs.records))
        self.assertIn("connection refused", logs.output[0])


if __name__ == "__main__":
    unittest.main()
