"""A failed MCP OAuth token refresh must log the provider's error reason, not just the status.

Applies patches/patch-mcp-refresh-error-reason.py to a verbatim copy of the stable image's
tools/mcp_oauth_provider.py and checks the patched warning line.
"""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCH_PATH = HERE.parent / "patches" / "patch-mcp-refresh-error-reason.py"
FIXTURE = HERE / "fixtures" / "upstream_mcp_oauth_provider_stable.py"
UPSTREAM_LINE = 'self._hermes_logger.warning("Token refresh failed: %s", response.status_code)'


def load_patch_module():
    spec = importlib.util.spec_from_file_location("patch_mcp_refresh_error_reason", PATCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class McpRefreshErrorReasonPatchTest(unittest.TestCase):
    def test_upstream_logs_status_only(self):
        self.assertEqual(FIXTURE.read_text().count(UPSTREAM_LINE), 1)

    def test_patch_logs_sanitized_body_excerpt(self):
        patched = load_patch_module().patch_source(FIXTURE.read_text())
        self.assertNotIn(UPSTREAM_LINE, patched)
        self.assertIn('"Token refresh failed: %s %s", response.status_code,', patched)
        self.assertIn("_sanitize_error(", patched)
        compile(patched, "mcp_oauth_provider_patched", "exec")

    def test_patch_is_idempotent_and_fails_loudly_on_drift(self):
        mod = load_patch_module()
        once = mod.patch_source(FIXTURE.read_text())
        self.assertEqual(mod.patch_source(once), once)
        with self.assertRaises(mod.PatchError):
            mod.patch_source("class Provider:\n    pass\n")


if __name__ == "__main__":
    unittest.main()
