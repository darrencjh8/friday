#!/bin/bash
# Tests the mnemosyne provider seed block: no PyYAML needed, pure grep.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"

echo "=== mnemosyne provider seed ==="

grep -q 'provider: mnemosyne' "$SEED_SCRIPT" \
    && ok "seed flips memory.provider to mnemosyne" \
    || nope "provider flip" "provider: mnemosyne missing from seed"
grep -q 'auto_sleep: true' "$SEED_SCRIPT" \
    && ok "seed sets auto_sleep true" \
    || nope "auto_sleep" "auto_sleep: true missing from seed"
grep -q 'sleep_threshold: 20' "$SEED_SCRIPT" \
    && ok "seed sets sleep_threshold 20" \
    || nope "sleep_threshold" "sleep_threshold: 20 missing from seed"
grep -q 'mnemosyne-hermes==0.7.1' "$SEED_SCRIPT" \
    && ok "seed pins mnemosyne-hermes 0.7.1" \
    || nope "hermes pin" "0.7.1 pin missing from seed"
grep -q 'mnemosyne-memory\[embeddings\]==3.15.1' "$SEED_SCRIPT" \
    && ok "seed pins mnemosyne-memory 3.15.1" \
    || nope "memory pin" "3.15.1 pin missing from seed"
grep -q 'load_memory_provider' "$SEED_SCRIPT" \
    && ok "seed gates flip on provider load check" \
    || nope "load gate" "provider load check missing from seed"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
