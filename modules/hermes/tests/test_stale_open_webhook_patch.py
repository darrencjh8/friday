"""Stale open webhook sessions must be reaped by upstream's automatic sweep.

Applies patches/patch-stale-open-webhook.py to a verbatim copy of upstream v0.22.2
hermes_state.py and checks the resulting source-level allowlist.
"""

import ast
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-stale-open-webhook.py"
FIXTURE = HERE / "fixtures" / "upstream_hermes_state_v0.22.2.py"

LIVE_CONVERSATION_SOURCES = {"slack", "telegram", "discord", "whatsapp", "signal", "webui"}


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_stale_open_webhook", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stale_sources(source: str):
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "_AUTO_PRUNE_STALE_OPEN_SOURCES":
            return ast.literal_eval(node.value)
    raise AssertionError("_AUTO_PRUNE_STALE_OPEN_SOURCES not found")


class StaleOpenWebhookPatchTest(unittest.TestCase):
    def test_upstream_does_not_reap_webhook(self):
        self.assertNotIn("webhook", stale_sources(FIXTURE.read_text()))

    def test_patch_adds_only_webhook(self):
        before = stale_sources(FIXTURE.read_text())
        after = stale_sources(load_patch_module().patch_source(FIXTURE.read_text()))
        self.assertEqual(after, before + ("webhook",))
        self.assertFalse(LIVE_CONVERSATION_SOURCES & set(after))

    def test_patched_source_still_compiles_and_only_that_block_changed(self):
        text = FIXTURE.read_text()
        patched = load_patch_module().patch_source(text)
        compile(patched, "hermes_state_patched", "exec")
        self.assertEqual(len(patched.splitlines()) - len(text.splitlines()), 1)

    def test_patch_is_idempotent_and_fails_loudly_on_drift(self):
        mod = load_patch_module()
        once = mod.patch_source(FIXTURE.read_text())
        self.assertEqual(mod.patch_source(once), once)
        with self.assertRaises(mod.PatchError):
            mod.patch_source("class SessionDB:\n    pass\n")


if __name__ == "__main__":
    unittest.main()
