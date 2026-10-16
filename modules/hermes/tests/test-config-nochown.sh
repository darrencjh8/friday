#!/bin/bash
# Tests the no-chown config merge: hermes-owned writes, skip on no-change.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"

echo "=== config merge without chown ==="

grep -q "su -s /bin/sh hermes -c 'python3 - /opt/hermes-defaults/config.yaml" "$SEED_SCRIPT" \
    && ok "merge runs as hermes user" \
    || nope "hermes merge" "merge still runs as root"
grep -q "if existing != text:" "$SEED_SCRIPT" \
    && ok "merge skips write when nothing changed" \
    || nope "no-change skip" "merge rewrites every boot"
grep -q 'cp /opt/hermes-defaults/config.yaml /opt/data/config.yaml' "$SEED_SCRIPT" \
    && ok "first boot bootstraps from baked config" \
    || nope "first-boot bootstrap" "missing-file path lost"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
