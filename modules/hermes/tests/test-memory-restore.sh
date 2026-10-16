#!/bin/bash
# End-to-end tests for memory-restore.sh with stubbed gh and git.
# Builds a fake friday-memory clone, runs the real script, checks the restore.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
restore_script="$SCRIPT_DIR/../scripts/memory-restore.sh"

# Fake friday-memory repo contents
FAKE_REPO="$TMPDIR/fake-repo"
mkdir -p "$FAKE_REPO/wiki/entities/accounts" "$FAKE_REPO/wiki/concepts" \
    "$FAKE_REPO/mnemosyne" "$FAKE_REPO/profiles/architect" \
    "$FAKE_REPO/skills" "$FAKE_REPO/expense-tracker"
printf 'core fact\n' > "$FAKE_REPO/MEMORY.md"
printf 'user fact\n' > "$FAKE_REPO/USER.md"
printf 'soul\n' > "$FAKE_REPO/SOUL.md"
printf '# Schema\n' > "$FAKE_REPO/wiki/SCHEMA.md"
printf 'banks content\n' > "$FAKE_REPO/wiki/entities/accounts/banks-cards.md"
printf 'routing\n' > "$FAKE_REPO/wiki/concepts/llm-routing.md"
printf 'mnemo-bytes\n' > "$FAKE_REPO/mnemosyne/mnemosyne.db"
printf 'arch soul\n' > "$FAKE_REPO/profiles/architect/SOUL.md"
printf 'api_key: test\n' > "$FAKE_REPO/profiles/architect/config.yaml"
printf 'desc\n' > "$FAKE_REPO/profiles/architect/profile.yaml"
printf 'default\n' > "$FAKE_REPO/profiles/_active"

# Stubs: gh prints a token, git clone copies the fake repo
mkdir -p "$TMPDIR/stubbin"
cat > "$TMPDIR/stubbin/gh" <<'STUB'
#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
    printf 'ghp_test_token\n'
fi
STUB
cat > "$TMPDIR/stubbin/git" <<STUB
#!/bin/sh
# memory-restore.sh calls: git clone -q URL DEST — dest is the last arg.
if [ "\$1" = clone ]; then
    for dest in "\$@"; do :; done
    mkdir -p "\$dest"
    cp -r "$FAKE_REPO/." "\$dest/" 2>/dev/null || true
    exit 0
fi
exit 0
STUB
chmod +x "$TMPDIR/stubbin/gh" "$TMPDIR/stubbin/git"

echo "=== wiki restore ==="

DATA="$TMPDIR/restore-data"
mkdir -p "$DATA/memories"  # non-first-boot: core files must NOT overwrite
printf 'live core\n' > "$DATA/memories/MEMORY.md"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$DATA/memories" \
HERMES_DATA_DIR="$DATA" \
PATH="$TMPDIR/stubbin:$PATH" \
    bash "$restore_script" >/dev/null 2>&1 || true

[ -f "$DATA/home/wiki/SCHEMA.md" ] && ok "wiki/SCHEMA.md restored" \
    || nope "wiki restore" "SCHEMA.md missing from $DATA/home/wiki"
[ -f "$DATA/home/wiki/entities/accounts/banks-cards.md" ] && ok "wiki nested entity restored" \
    || nope "wiki restore" "nested entity missing"
grep -q "live core" "$DATA/memories/MEMORY.md" 2>/dev/null \
    && ok "non-first-boot core untouched" \
    || nope "core restore" "live MEMORY.md overwritten on non-first boot"

echo ""
echo "=== mnemosyne restore ==="

[ -f "$DATA/mnemosyne/data/mnemosyne.db" ] && ok "mnemosyne.db restored" \
    || nope "mnemosyne restore" "mnemosyne.db missing from $DATA/mnemosyne/data"
grep -q "mnemo-bytes" "$DATA/mnemosyne/data/mnemosyne.db" 2>/dev/null \
    && ok "mnemosyne content preserved" \
    || nope "mnemosyne content" "content not preserved"

echo ""
echo "=== profile SOUL + config restore ==="

[ -f "$DATA/profiles/architect/SOUL.md" ] && ok "profile SOUL.md restored" \
    || nope "profile SOUL restore" "SOUL.md missing from $DATA/profiles/architect"
[ -f "$DATA/profiles/architect/config.yaml" ] && ok "profile config.yaml restored" \
    || nope "profile config restore" "config.yaml missing from $DATA/profiles/architect"
[ -f "$DATA/profiles/architect/profile.yaml" ] && ok "profile.yaml still restored" \
    || nope "profile.yaml restore" "regression: profile.yaml not restored"
[ -f "$DATA/active_profile" ] && ok "active profile pointer restored" \
    || nope "active profile restore" "_active not restored"

echo ""
echo "=== skills restore still no-clobber ==="

[ -d "$DATA/skills" ] && ok "skills dir created" \
    || nope "skills restore" "skills dir missing"

echo ""
echo "=== first boot restores core ==="

DATA2="$TMPDIR/restore-fresh"
mkdir -p "$DATA2"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$DATA2/memories" \
HERMES_DATA_DIR="$DATA2" \
PATH="$TMPDIR/stubbin:$PATH" \
    bash "$restore_script" >/dev/null 2>&1 || true

grep -q "core fact" "$DATA2/memories/MEMORY.md" 2>/dev/null \
    && ok "first-boot MEMORY.md restored" \
    || nope "first-boot restore" "MEMORY.md not restored on first boot"
[ -f "$DATA2/home/wiki/SCHEMA.md" ] && ok "first-boot wiki restored" \
    || nope "first-boot wiki" "wiki missing on first boot"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
