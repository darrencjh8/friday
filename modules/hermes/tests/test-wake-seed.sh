#!/bin/bash
# Tests the wake-openwakeword boot seed: no PyYAML needed, pure grep.
# The upstream extra lives in /opt/hermes/.venv (image state, not volume
# state), so a fresh rebuild boots without pyopen_wakeword and /wake reports
# engine missing. The seed reinstalls it only when the import fails.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"
CONFIG="$SCRIPT_DIR/../config.yaml"

echo "=== wake-openwakeword boot seed ==="

grep -q 'pm install --extra wake-openwakeword' "$SEED_SCRIPT" \
    && ok "seed reinstalls the wake-openwakeword extra" \
    || nope "extra install" "pm install --extra wake-openwakeword missing from seed"
grep -q 'import pyopen_wakeword' "$SEED_SCRIPT" \
    && ok "seed guards on the pyopen_wakeword import" \
    || nope "import guard" "pyopen_wakeword import probe missing from seed"
grep -q '/opt/hermes/.venv/bin/python3' "$SEED_SCRIPT" \
    && ok "seed probes the image venv interpreter" \
    || nope "venv probe" "/opt/hermes/.venv/bin/python3 missing from seed"
grep -q 'WARNING: wake-openwakeword install failed' "$SEED_SCRIPT" \
    && ok "seed warns without aborting boot on install failure" \
    || nope "non-fatal install" "WARNING + non-fatal fallback missing from seed"
if grep -q 'pyopen-wakeword==' "$SEED_SCRIPT"; then
    nope "no raw version pin" "seed pins pyopen-wakeword directly; the upstream extra owns the pin"
else
    ok "no raw version pin (upstream extra owns it)"
fi
if grep -q 'wake_word\|wake-openwakeword\|pyopen_wakeword' "$CONFIG"; then
    nope "no baked wake config" "config.yaml carries a wake key; live wake_word.enabled=true must carry forward, not bake"
else
    ok "no baked wake config (live key carries forward)"
fi
if bash -n "$SEED_SCRIPT"; then
    ok "seed parses as shell"
else
    nope "shell syntax" "bash -n failed on $SEED_SCRIPT"
fi

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
