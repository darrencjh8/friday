#!/bin/bash
# Wrapper so the triage tool can be invoked from cron/terminal without the
# `python <script>` path guard biting.
# Usage: memory-triage.sh list|stats|apply --plan FILE|snapshots|restore --from DIR
set -euo pipefail
export HERMES_HOME="${HERMES_HOME:-/opt/data}"
PY=/opt/hermes/.venv/bin/python
if [ ! -x "$PY" ]; then
    PY=$(command -v python3 || true)
fi
if [ -z "$PY" ]; then
    echo "memory-triage: no python interpreter found" >&2
    exit 78
fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec "$PY" "$SCRIPT_DIR/memory_triage.py" "$@"
