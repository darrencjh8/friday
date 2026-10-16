#!/bin/bash
# The seed adds a topic-directory pointer to MEMORY.md. An agent-written pointer
# is worded differently from the seed's sentence, so the seed must recognise any
# reference to the topics directory instead of re-adding its own on every boot.
set -euo pipefail

GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo "FAIL: $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

ptr_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYPTR'[^\n]*\n(.*?)\nPYPTR", content, re.DOTALL)
print(blocks[-1] if blocks else "")
PY
)
[ -n "$ptr_block" ] && ok "seed has a MEMORY.md pointer block" || nope "pointer block" "not found"

echo "=== reworded pointer idempotency ==="
mkdir -p "$TMPDIR/memories"
printf '%s\n' 'Durable facts too big for core live in /opt/data/memories/topics/ - search there before recall answers.' > "$TMPDIR/memories/MEMORY.md"
printf 'memory:\n    memory_char_limit: 2800\n' > "$TMPDIR/config.yaml"
ptr_tmp=${ptr_block//\/opt\/data\/memories\/MEMORY.md/$TMPDIR\/memories\/MEMORY.md}
ptr_tmp=${ptr_tmp//\/opt\/data\/config.yaml/$TMPDIR\/config.yaml}
python3 -c "$ptr_tmp" >/dev/null 2>&1 || true

count=$(grep -c "memories/topics" "$TMPDIR/memories/MEMORY.md" || true)
[ "$count" = "1" ] && ok "reworded pointer is not duplicated" \
    || nope "test_reworded_pointer_idempotent" "occurrences: $count"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
