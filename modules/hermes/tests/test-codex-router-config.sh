#!/bin/bash
# Verify Hermes uses the pooled Model Router provider.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.yaml"

has_provider() {
    grep -Eq '^providers:$' "$CONFIG" && grep -Eq '^    codex-router:$' "$CONFIG"
}

has_provider && ok "named Model Router provider exists" || nope "named Model Router provider" "missing"
grep -Eq '^        name: Model Router$' "$CONFIG" && ok "provider is labeled Model Router" || nope "provider label" "missing or wrong"
grep -Eq '^        api: http://codex-router:4100/v1$' "$CONFIG" && ok "provider uses internal router URL" || nope "provider URL" "missing or wrong"
grep -Eq '^        transport: codex_responses$' "$CONFIG" && ok "provider pins codex_responses transport" || nope "provider transport" "missing"
grep -Eq '^    provider: custom:codex-router$' "$CONFIG" && ok "Hermes uses named Model Router provider" || nope "Hermes provider" "missing"
grep -Eq '^    default: auto-thinking$' "$CONFIG" && ok "main model routes via auto-thinking" || nope "main model" "missing"
if grep -Rq 'model: commandcode/' "$CONFIG" "$SCRIPT_DIR/../profiles"; then
    nope "no commandcode primaries" "found commandcode/ model reference"
else
    ok "no commandcode primaries (Command Code retirement-ready)"
fi

if grep -REq 'gpt-5\.6-(terra|luna|sol)-[123]' "$SCRIPT_DIR/../config.yaml" "$SCRIPT_DIR/../profiles"; then
    nope "no account-pinned GPT aliases" "found account suffix"
else
    ok "no account-pinned GPT aliases"
fi

echo ""
echo "=== opencode CLI config is retired ==="

# The opencode CLI is no longer installed, so no canonical opencode.json may be
# baked or referenced by the image or its tests.
if [ -e "$SCRIPT_DIR/../opencode" ]; then
    nope "opencode config directory retired" "still present: $SCRIPT_DIR/../opencode"
else
    ok "opencode config directory retired"
fi

printf '\n=========================================\n'
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ]
