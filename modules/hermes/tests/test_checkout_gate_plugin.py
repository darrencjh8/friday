"""Contracts for the checkout-gate pre_tool_call hook."""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins/checkout-gate/__init__.py"
spec = importlib.util.spec_from_file_location("checkout_gate_plugin", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def call(tool, code):
    return plugin._on_pre_tool_call(tool_name=tool, args={"code": code}, task_id="t")


class CheckoutGateTest(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(plugin, "_in_cron", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_register_hooks_pre_tool_call(self):
        hooks = []
        plugin.register(types.SimpleNamespace(register_hook=lambda name, fn: hooks.append((name, fn))))
        self.assertEqual(hooks, [("pre_tool_call", plugin._on_pre_tool_call)])

    def test_final_purchase_buttons_ask_the_owner(self):
        for code in ('click(text="Place Order")', "page.get_by_role('button', name='Place your order').click()",
                     'click("Pay now")', 'click("BUY_NOW")', "click('Confirm and pay')",
                     'click("Complete purchase")', 'click("Submit order")', 'click("Make payment")'):
            result = call("browser_exec", code)
            self.assertEqual(result["action"], "approve", code)
            self.assertTrue(result["rule_key"].startswith("checkout:"), code)

    def test_each_call_has_its_own_rule_key(self):
        one, two = call("browser_exec", 'click("Pay now")'), call("browser_exec", 'click("Pay now") # 2')
        self.assertNotEqual(one["rule_key"], two["rule_key"])
        self.assertEqual(one["rule_key"], call("browser_exec", 'click("Pay now")')["rule_key"])

    def test_cdp_calls_are_gated_too(self):
        result = plugin._on_pre_tool_call(tool_name="browser_cdp", args={"expression": "document.querySelector('#place-order').click()"})
        self.assertEqual(result["action"], "approve")

    def test_browsing_and_other_tools_pass(self):
        self.assertIsNone(call("browser_exec", 'goto("https://shopee.sg/search?q=usb+c+cable"); print(title())'))
        self.assertIsNone(call("browser_exec", 'click("Add to cart"); click("Proceed to checkout")'))
        self.assertIsNone(call("terminal", 'echo "Pay now"'))
        self.assertIsNone(plugin._on_pre_tool_call(tool_name="browser_exec", args=None))

    def test_cron_runs_are_blocked_not_asked(self):
        with patch.object(plugin, "_in_cron", return_value=True):
            result = call("browser_exec", 'click("Place order")')
        self.assertEqual(result["action"], "block")
        self.assertIn("scheduled run", result["message"])

    def test_cron_detection_reads_the_session_flag(self):
        fake = types.ModuleType("tools.approval_context")
        fake._is_cron_approval_context = lambda: True
        tools = types.ModuleType("tools")
        tools.approval_context = fake
        with patch.dict(sys.modules, {"tools": tools, "tools.approval_context": fake}):
            self.assertTrue(_real_in_cron())

    def test_missing_hermes_core_is_not_cron(self):
        with patch.dict(sys.modules, {"tools": None}):
            self.assertFalse(_real_in_cron())


def _real_in_cron():
    """The unpatched helper (setUp patches the module attribute)."""
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._in_cron()


if __name__ == "__main__":
    unittest.main()
