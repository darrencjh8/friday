#!/usr/bin/env python3
"""Let cron sessions read Mnemosyne memory without writing to it.

mnemosyne-hermes 0.7.1 skips every non-primary context, cron included, so a
scheduled job cannot recall what was discussed in chat ("Mnemosyne not
initialized"). Dropping cron from skip_contexts alone would also store every
cron prompt and reply as episodic memory. This patch appends a wrapper to the
provider module that initializes the provider for cron, keeps recall and
prefetch, and turns every write path into a no-op for cron only.

The wrapper is fail-safe: when the plugin is reinstalled or upgraded the patch
is gone and the plugin falls back to its own default (cron skipped entirely).
The patch refuses any file other than the pinned 0.7.1 module, so an upgrade
has to re-check the write paths listed below before it re-enables cron recall.
"""

import hashlib
import os
import sys
from pathlib import Path

MARKER = "# friday-patch: mnemosyne read-only in cron"
# sha256 of mnemosyne_hermes/__init__.py in the mnemosyne-hermes 0.7.1 wheel.
PINNED_SHA256 = "f18551124ba86e58cf2b6d31bcb2628d9dd93588f06b822877c139a52d2fc77f"

TAIL = f'''

{MARKER}
def _friday_cron_readonly(cls):
    import functools

    # Allowlist, so a tool added by a later version is blocked until reviewed.
    read_tools = frozenset({{
        "mnemosyne_recall", "mnemosyne_recall_canonical", "mnemosyne_get",
        "mnemosyne_stats", "mnemosyne_triple_query", "mnemosyne_graph_query",
        "mnemosyne_shared_recall", "mnemosyne_scratchpad_read",
    }})

    def in_cron(self):
        return (getattr(self, "_agent_context", "") or "").strip().lower() == "cron"

    original_init = cls.initialize

    @functools.wraps(original_init)
    def initialize(self, session_id, **kwargs):
        if (kwargs.get("agent_context") or "").strip().lower() == "cron":
            configured = self._read_config_key("skip_contexts")
            if configured is None:
                contexts = set(self._skip_contexts)
            elif isinstance(configured, str):
                contexts = {{c.strip() for c in configured.split(",") if c.strip()}}
            else:
                contexts = {{str(c).strip() for c in configured if str(c).strip()}}
            kwargs["skip_contexts"] = sorted(contexts - {{"cron"}})
        return original_init(self, session_id, **kwargs)

    cls.initialize = initialize

    # sync_turn also drives auto-sleep and identity capture; on_session_end runs
    # consolidation; on_memory_write mirrors built-in memory writes.
    for name in ("sync_turn", "on_session_end", "on_memory_write"):
        original = getattr(cls, name)

        def skip_in_cron(self, *args, _original=original, **kwargs):
            if in_cron(self):
                return None
            return _original(self, *args, **kwargs)

        setattr(cls, name, functools.wraps(original)(skip_in_cron))

    original_tool = cls.handle_tool_call

    @functools.wraps(original_tool)
    def handle_tool_call(self, tool_name, args, **kwargs):
        if in_cron(self) and tool_name not in read_tools:
            return json.dumps({{"error": f"{{tool_name}} is read-only in cron sessions; "
                                         "record changes from a chat session instead."}})
        return original_tool(self, tool_name, args, **kwargs)

    cls.handle_tool_call = handle_tool_call


_friday_cron_readonly(MnemosyneMemoryProvider)
'''


class PatchError(Exception):
    pass


def patch(text: str, expected_sha256: str = PINNED_SHA256) -> str:
    if MARKER in text:
        return text
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != expected_sha256:
        raise PatchError(f"unexpected mnemosyne_hermes module (sha256 {digest}); not the pinned 0.7.1")
    return text + TAIL


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: patch-mnemosyne-cron-readonly.py <mnemosyne_hermes/__init__.py>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    try:
        text = path.read_text(encoding="utf-8")
        patched = patch(text)
        if patched != text:
            # The seed runs as root; keep the plugin environment's owner and mode so the
            # provider manager (running as hermes) can still reinstall over the file.
            st = path.stat()
            tmp = path.with_suffix(".py.tmp")
            tmp.write_text(patched, encoding="utf-8")
            os.chmod(tmp, st.st_mode)
            os.chown(tmp, st.st_uid, st.st_gid)
            tmp.replace(path)
            print(f"patch-mnemosyne-cron-readonly: patched {path}")
        else:
            print(f"patch-mnemosyne-cron-readonly: {path} already patched")
    except (OSError, PatchError) as exc:
        print(f"patch-mnemosyne-cron-readonly: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
