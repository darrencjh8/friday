#!/usr/bin/env python3
"""Prefer the active profile's custom-provider transport in WebUI agent construction."""

import sys
from pathlib import Path

DEFAULT_PATH = "/opt/hermes-webui/api/streaming.py"
MARKER = "# openclaw-patch: active-profile custom-provider API mode"
OLD = """            if 'api_mode' in _agent_params:
                _agent_kwargs['api_mode'] = _rt.get('api_mode')
"""
NEW = """            """ + MARKER + """
            if 'api_mode' in _agent_params:
                # The detached worker's runtime resolver may not see this session's profile.
                try:
                    from hermes_cli.config import get_custom_provider_api_mode
                    _configured_api_mode = get_custom_provider_api_mode(
                        resolved_base_url or configured_base_url or '',
                        config=_cfg,
                    )
                except Exception:
                    _configured_api_mode = None
                _agent_kwargs['api_mode'] = _configured_api_mode or _rt.get('api_mode')
"""


class PatchError(Exception):
    pass


def patch_source(text: str) -> str:
    if MARKER in text:
        return text
    if text.count(OLD) != 1:
        raise PatchError("upstream API-mode assignment not found exactly once; update the patch")
    return text.replace(OLD, NEW, 1)


def main(argv) -> int:
    path = Path(argv[1] if len(argv) > 1 else DEFAULT_PATH)
    try:
        path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    except (PatchError, OSError) as exc:
        print(f"patch-webui-api-mode: {exc}", file=sys.stderr)
        return 1
    print(f"patch-webui-api-mode: patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
