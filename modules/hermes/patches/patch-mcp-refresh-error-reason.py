#!/usr/bin/env python3
"""Build-time patch for upstream tools/mcp_oauth_provider.py: log why an MCP token refresh failed.

Upstream logs a failed refresh as ``Token refresh failed: 400`` and drops the response body, so an
``invalid_grant`` (grant revoked or expired at the provider) looks the same as a WAF block or a bad
request. When the Notion MCP grant died on 2026-11-20 (#314) the logs could not say which.

A non-2xx refresh response carries no tokens, so this logs the same short, tag-stripped, redacted
excerpt that upstream's ``_handle_token_response`` already attaches to a failed code exchange. A 2xx
body (which holds the tokens) is still never logged.

Usage: patch-mcp-refresh-error-reason.py [path]   (default /opt/hermes/tools/mcp_oauth_provider.py)
Idempotent; exits non-zero if the upstream text has drifted, so an image bump that changes this
code fails the build instead of silently dropping the fix.
"""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes/tools/mcp_oauth_provider.py"
MARKER = "# openclaw-patch: log the refresh error reason"

OLD_LINE = '''            self._hermes_logger.warning("Token refresh failed: %s", response.status_code)
'''

NEW_LINES = '''            ''' + MARKER + '''
            from tools.mcp_tool_common import _sanitize_error
            excerpt = " ".join(re.sub(r"<[^>]+>", " ", response.text).split())[:200]
            self._hermes_logger.warning("Token refresh failed: %s %s", response.status_code,
                                        _sanitize_error(excerpt))
'''


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    if text.count(OLD_LINE) != 1:
        raise PatchError("upstream 'Token refresh failed' warning not found exactly once; update the patch")
    return text.replace(OLD_LINE, NEW_LINES)


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-mcp-refresh-error-reason: {exc}", file=sys.stderr)
        return 1
    print(f"patch-mcp-refresh-error-reason: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
