#!/bin/bash
# persona-sync.sh keeps a clone of the persona repo and copies its SOUL.md into the
# live SOUL.md between the friday-persona markers, leaving everything else alone.
set -euo pipefail

GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo "FAIL: $1 — $2"; fail=$((fail+1)); }

SCRIPT="$(cd "$(dirname "$0")" && pwd)/../scripts/persona-sync.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export PERSONA_REPO_URL="$TMPDIR/origin" PERSONA_DIR="$TMPDIR/workspace/friday-persona" SOUL_PATH="$TMPDIR/SOUL.md"
mkdir -p "$TMPDIR/workspace"

git init -q -b main "$TMPDIR/origin"
printf 'persona v1\n' >"$TMPDIR/origin/SOUL.md"
printf 'calendar v1\n' >"$TMPDIR/origin/calendar.md"
git -C "$TMPDIR/origin" add -A && git -C "$TMPDIR/origin" commit -qm v1

run() { bash "$SCRIPT" >"$TMPDIR/out" 2>&1; }

echo "=== SOUL.md without markers ==="
printf 'old persona\nhermes rules\n' >"$SOUL_PATH"
run
[ -f "$PERSONA_DIR/calendar.md" ] && ok "first run clones the persona repo" || nope "test_clone" "$(cat "$TMPDIR/out")"
[ "$(cat "$SOUL_PATH")" = "$(printf 'old persona\nhermes rules')" ] && ok "SOUL.md without markers is untouched" \
    || nope "test_no_markers_untouched" "$(cat "$SOUL_PATH")"

echo "=== SOUL.md with markers ==="
printf 'head\n<!-- friday-persona:start -->\nstale\n<!-- friday-persona:end -->\nhermes rules\n' >"$SOUL_PATH"
run
expected=$(printf 'head\n<!-- friday-persona:start -->\npersona v1\n<!-- friday-persona:end -->\nhermes rules')
[ "$(cat "$SOUL_PATH")" = "$expected" ] && ok "persona block is replaced, the rest is kept" \
    || nope "test_block_replaced" "$(cat "$SOUL_PATH")"

echo "=== a new persona commit is pulled ==="
printf 'persona v2\n' >"$TMPDIR/origin/SOUL.md"
printf 'calendar v2\n' >"$TMPDIR/origin/calendar.md"
git -C "$TMPDIR/origin" commit -qam v2
run
grep -qx 'persona v2' "$SOUL_PATH" && ! grep -qx 'persona v1' "$SOUL_PATH" && ok "SOUL.md follows the new commit" \
    || nope "test_follow_update" "$(cat "$SOUL_PATH")"
grep -qx 'calendar v2' "$PERSONA_DIR/calendar.md" && ok "the calendar fast-forwards" || nope "test_calendar_ff" "$(cat "$TMPDIR/out")"

echo "=== an unreachable repo never fails ==="
rm -rf "$PERSONA_DIR"
PERSONA_REPO_URL="$TMPDIR/missing" run && ok "clone failure exits 0" || nope "test_clone_failure_exit0" "$(cat "$TMPDIR/out")"
grep -qx 'persona v2' "$SOUL_PATH" && ok "clone failure leaves SOUL.md alone" || nope "test_clone_failure_soul" "$(cat "$SOUL_PATH")"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
