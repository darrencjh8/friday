#!/usr/bin/env python3
"""Fetch the Claude Pro subscription usage snapshot for the codex-router admin UI.

UPSTREAM: GET https://api.anthropic.com/api/oauth/usage. This endpoint is
UNDOCUMENTED (it powers claude.ai's own Usage panel) and may change shape
without notice, so every response is validated and any surprise fails soft
(see below) rather than publishing a corrupt file.

READ-ONLY INVARIANTS (review these on every change):
- Credentials (~/.claude/.credentials.json) are opened read-only and NEVER
  refreshed, rewritten, or copied. A 401 self-heals when the Claude CLI next
  refreshes its own token; until then the previous snapshot stays in place.
- NO token or credential material is ever written to the output file, logs,
  or stdout: the published JSON carries utilization numbers only.
- On ANY failure (missing credentials, 401, network error, unexpected shape)
  the previous output file is left untouched and this exits non-zero. Only a
  fixed failure category (and numeric HTTP status) is sent to system logs;
  stdout and stderr stay quiet, and exception contents are never logged.
  The router's staleness rule turns the card stale by itself.

Output schema:
  {"five_hour": {...}|null, "seven_day": {...}|null,
   "seven_day_sonnet": {...}|null, "seven_day_opus": {...}|null,
   "fetched_at": <unix seconds>}
Buckets pass through as received (null stays null); extra upstream keys are
dropped. The write is atomic (tmp file + os.replace). Stdlib only.

Scheduling: installed into the host crontab by modules/deploy.sh (every 5
min); the deploy workflow creates the output directory. The three CLAUDE_*
environment variables below exist only so tests can point the helper at
fixtures; the cron call sets none of them.
"""

import json
import os
import sys
import syslog
import time
import urllib.error
import urllib.request

DEFAULT_CREDENTIALS_FILE = "/home/darren/.claude/.credentials.json"
DEFAULT_API_URL = "https://api.anthropic.com/api/oauth/usage"
DEFAULT_OUTPUT_FILE = "/home/runner/data/codex-router/claude-usage.json"

BUCKETS = ("five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus")
REQUIRED_BUCKETS = ("five_hour", "seven_day")


def load_token(path):
    """Return the OAuth access token from the Claude CLI credentials file.

    Handles both shapes: fields nested under "claudeAiOauth" or top-level.
    The file is only ever read; nothing here may write or refresh it.
    """
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("credentials file is not a JSON object")
    node = data.get("claudeAiOauth")
    if not isinstance(node, dict):
        node = data
    token = node.get("accessToken") or node.get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("no OAuth access token in credentials file")
    return token


def valid_bucket(value):
    """A bucket is null or an object carrying a numeric utilization."""
    if value is None:
        return True
    if not isinstance(value, dict):
        return False
    utilization = value.get("utilization")
    if isinstance(utilization, bool) or not isinstance(utilization, (int, float)):
        return False
    resets_at = value.get("resets_at")
    return resets_at is None or isinstance(resets_at, str)


def fetch_usage(api_url, token):
    """GET the usage endpoint and return the sanitized snapshot (sans fetched_at)."""
    request = urllib.request.Request(api_url)
    request.add_header("Authorization", "Bearer " + token)
    request.add_header("Content-Type", "application/json")
    request.add_header("anthropic-version", "2023-06-01")
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    if not isinstance(body, dict):
        raise ValueError("usage endpoint did not return a JSON object")
    for key in REQUIRED_BUCKETS:
        if key not in body or not valid_bucket(body[key]):
            raise ValueError(f"missing or malformed bucket: {key}")
    for key in BUCKETS:
        if key in body and not valid_bucket(body[key]):
            raise ValueError(f"malformed bucket: {key}")
    return {key: body.get(key) for key in BUCKETS}


def write_snapshot(snapshot, output_file):
    """Atomically replace the output file; the previous file is never mutated."""
    tmp_file = output_file + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle)
        handle.write("\n")
    os.replace(tmp_file, output_file)


def main():
    try:
        token = load_token(os.environ.get("CLAUDE_CREDENTIALS_FILE", DEFAULT_CREDENTIALS_FILE))
        snapshot = fetch_usage(os.environ.get("CLAUDE_USAGE_URL", DEFAULT_API_URL), token)
        snapshot["fetched_at"] = int(time.time())
        write_snapshot(snapshot, os.environ.get("CLAUDE_USAGE_OUT", DEFAULT_OUTPUT_FILE))
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError) and isinstance(error.code, int):
            reason = f"http_{error.code}"
        elif isinstance(error, (urllib.error.URLError, TimeoutError)):
            reason = "network"
        elif isinstance(error, ValueError):
            reason = "invalid_data"
        elif isinstance(error, OSError):
            reason = "filesystem"
        else:
            reason = "unexpected"
        try:
            syslog.syslog(syslog.LOG_WARNING, "claude-usage: collection failed: " + reason)
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
