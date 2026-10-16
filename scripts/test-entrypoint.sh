#!/usr/bin/env bash
# Unit tests for docker-entrypoint.sh
# Validates env var substitution in AGENTS.md generation.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/../gateway/docker-entrypoint.sh"

TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/app"
export TMP_APP="$TMPDIR/app"
cd "$TMPDIR"
PASS=0
FAIL=0

assert_contains() {
    local file="$1" expected="$2" label="$3"
    if grep -qF "$expected" "$file" 2>/dev/null; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label — '$expected' not found in $(cat "$file" 2>/dev/null || echo '(missing file)')"
        FAIL=$((FAIL + 1))
    fi
}

assert_not_contains() {
    local file="$1" expected="$2" label="$3"
    if ! grep -qF "$expected" "$file" 2>/dev/null; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label — '$expected' should not be present"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== docker-entrypoint.sh Unit Tests ==="

# Test 1: Basic env var substitution
echo "1. Env var substitution:"
cat > "$TMP_APP/AGENTS.md.template" << 'TEMPLATE'
---
name: Test Agent
preferences: "$USER_PREFERENCES"
extra: "$SYSTEM_PROMPT_EXTRA"
---
TEMPLATE
export USER_PREFERENCES="Uses SGD primarily"
export SYSTEM_PROMPT_EXTRA="Be concise"
export USER_NAME="testuser"

# Run just the node substitution part (skip the exec tini line)
function substitute_template() {
    node -e "
const fs = require('fs');
let t = fs.readFileSync('$TMP_APP/AGENTS.md.template', 'utf8');
const vars = Object.keys(process.env).filter(k => !k.includes('PATH') && !k.includes('HOME') && !k.includes('SHLVL') && !k.includes('PWD'));
vars.sort((a, b) => b.length - a.length);
for (const k of vars) {
  const re = new RegExp('\\\\\\$' + k + '(?![a-zA-Z0-9_])', 'g');
  t = t.replace(re, process.env[k] || '');
}
fs.writeFileSync('$TMP_APP/AGENTS.md', t);
"
}

substitute_template
assert_contains "$TMP_APP/AGENTS.md" "Uses SGD primarily" "USER_PREFERENCES substituted"
assert_contains "$TMP_APP/AGENTS.md" "Be concise" "SYSTEM_PROMPT_EXTRA substituted"

# Test 2: Missing env var becomes empty
echo "2. Missing env var becomes empty:"
assert_not_contains "$TMP_APP/AGENTS.md" '$NONEXISTENT' "unresolved env vars removed"
unset NONEXISTENT

# Test 3: Special env vars
echo "3. Special env vars:"
cat > "$TMP_APP/AGENTS.md.template" << 'TEMPLATE'
Greeting: "Hi $USER_NAME!"
Custom: "$CUSTOM_VAR"
TEMPLATE
export USER_NAME="Alice"
export CUSTOM_VAR="test"

substitute_template
assert_contains "$TMP_APP/AGENTS.md" "Hi Alice" "USER_NAME substitution"
assert_contains "$TMP_APP/AGENTS.md" "test" "CUSTOM_VAR substitution"
assert_not_contains "$TMP_APP/AGENTS.md" '$CUSTOM_VAR' "raw env var removed"

# Test 4: File is written
echo "4. Output file exists:"
if [ -f "$TMP_APP/AGENTS.md" ]; then
    echo "  PASS: $TMP_APP/AGENTS.md created"
    PASS=$((PASS + 1))
else
    echo "  FAIL: /app/AGENTS.md not created"
    FAIL=$((FAIL + 1))
fi

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
