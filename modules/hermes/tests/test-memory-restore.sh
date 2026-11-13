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
mkdir -p "$FAKE_REPO/topics"
printf 'topic fact\n' > "$FAKE_REPO/topics/accounts.md"

# Stubs: gh prints $GH_STUB_TOKEN; git clone logs its URL and copies the fake
# repo, or fails when CLONE_FAIL=1.
mkdir -p "$TMPDIR/stubbin"
cat > "$TMPDIR/stubbin/gh" <<'STUB'
#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
    printf '%s\n' "${GH_STUB_TOKEN:-ghp_test_token}"
fi
STUB
cat > "$TMPDIR/stubbin/git" <<STUB
#!/bin/sh
# memory-restore.sh calls: git clone -q URL DEST — dest is the last arg.
if [ "\$1" = clone ]; then
    [ "\${CLONE_FAIL:-0}" = 1 ] && exit 128
    printf '%s\n' "\$3" > "$TMPDIR/clone-url"
    for dest in "\$@"; do :; done
    mkdir -p "\$dest"
    cp -r "$FAKE_REPO/." "\$dest/" 2>/dev/null || true
    exit 0
fi
exit 0
STUB
chmod +x "$TMPDIR/stubbin/gh" "$TMPDIR/stubbin/git"

# run_restore DATA_DIR — runs the real script against a fixture data root.
run_restore() {
    MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$1/memories" \
    HERMES_DATA_DIR="$1" \
    PATH="$TMPDIR/stubbin:$PATH" \
        bash "$restore_script" >/dev/null 2>&1
}

echo "=== fresh volume restores everything ==="

DATA="$TMPDIR/fresh"
mkdir -p "$DATA"
run_restore "$DATA" && ok "fresh restore exits 0" || nope "fresh restore exit" "non-zero exit"

grep -q "core fact" "$DATA/memories/MEMORY.md" 2>/dev/null && ok "MEMORY.md restored" \
    || nope "fresh volume restores MEMORY.md" "missing"
grep -q "soul" "$DATA/SOUL.md" 2>/dev/null && ok "SOUL.md restored to the live path" \
    || nope "fresh volume restores SOUL.md" "missing from $DATA/SOUL.md"
grep -q "topic fact" "$DATA/memories/topics/accounts.md" 2>/dev/null && ok "fresh volume restores topics/" \
    || nope "fresh volume restores topics/" "memories/topics/accounts.md missing"
[ -f "$DATA/home/wiki/entities/accounts/banks-cards.md" ] && ok "wiki restored" \
    || nope "wiki restore" "nested entity missing"
grep -q "mnemo-bytes" "$DATA/mnemosyne/data/mnemosyne.db" 2>/dev/null && ok "mnemosyne.db restored" \
    || nope "mnemosyne restore" "missing"
[ -f "$DATA/profiles/architect/SOUL.md" ] && [ -f "$DATA/profiles/architect/config.yaml" ] \
    && [ -f "$DATA/profiles/architect/profile.yaml" ] && ok "profile files restored" \
    || nope "profile restore" "profile files missing"
[ -f "$DATA/active_profile" ] && ok "active profile pointer restored" \
    || nope "active profile restore" "_active not restored"
[ -d "$DATA/skills" ] && ok "skills dir created" || nope "skills restore" "skills dir missing"
[ ! -e "$DATA/.memory-restore-failed" ] && ok "success clears the marker" \
    || nope "marker after success" "marker still present"
ls -d "$DATA"/pre-restore-* >/dev/null 2>&1 && nope "first boot keep-copy" "pre-restore dir made on a first boot" \
    || ok "first boot makes no keep-copy"

echo ""
echo "=== existing volume is a no-op ==="

DATA="$TMPDIR/existing"
mkdir -p "$DATA/memories"
printf 'live core\n' > "$DATA/memories/MEMORY.md"
printf 'live soul\n' > "$DATA/SOUL.md"
rm -f "$TMPDIR/clone-url"
run_restore "$DATA" && ok "existing-volume restore exits 0" || nope "existing exit" "non-zero exit"
grep -q "live core" "$DATA/memories/MEMORY.md" && grep -q "live soul" "$DATA/SOUL.md" \
    && ok "existing volume keeps live MEMORY.md and SOUL.md" \
    || nope "existing volume no-op" "live file overwritten"
[ ! -e "$TMPDIR/clone-url" ] && ok "existing volume does not clone" \
    || nope "existing volume no-op" "restore cloned"

echo ""
echo "=== clone failure leaves the marker ==="

DATA="$TMPDIR/clonefail"
mkdir -p "$DATA"
CLONE_FAIL=1 run_restore "$DATA" && ok "clone failure exits 0 (boot never blocks)" \
    || nope "clone failure exit" "non-zero exit"
[ -f "$DATA/.memory-restore-failed" ] && ok "clone failure writes the marker" \
    || nope "clone failure marker" "marker missing"

echo ""
echo "=== failure after the clone leaves the marker ==="

if [ "$(id -u)" -eq 0 ]; then
    ok "skipped as root (permissions are not enforced)"
else
    DATA="$TMPDIR/postclonefail"
    mkdir -p "$DATA/profiles/architect"
    chmod 555 "$DATA/profiles/architect"
    run_restore "$DATA" || true
    chmod 755 "$DATA/profiles/architect"
    [ -f "$DATA/.memory-restore-failed" ] && ok "post-clone failure leaves the marker" \
        || nope "post-clone failure marker" "marker missing after a failed copy"
fi

echo ""
echo "=== read-only expense-tracker mount does not fail the restore ==="

# In production EXPENSE_TRACKER_DATA is a read-only bind mount owned by the
# expense-tracker service, so restore must never try to write it.
if [ "$(id -u)" -eq 0 ]; then
    ok "skipped as root (permissions are not enforced)"
else
    printf 'expense fact\n' > "$FAKE_REPO/expense-tracker/MEMORY.md"
    DATA="$TMPDIR/expensero"
    mkdir -p "$DATA" "$TMPDIR/expense-ro"
    chmod 555 "$TMPDIR/expense-ro"
    if EXPENSE_TRACKER_DATA="$TMPDIR/expense-ro" run_restore "$DATA" \
        && [ ! -e "$DATA/.memory-restore-failed" ]; then
        ok "memory_restore.expense_ro"
    else
        nope "memory_restore.expense_ro" "restore failed or left the marker with a read-only EXPENSE_TRACKER_DATA"
    fi
    chmod 755 "$TMPDIR/expense-ro"
    rm -f "$FAKE_REPO/expense-tracker/MEMORY.md"
fi

echo ""
echo "=== retry keeps a copy of live files first ==="

DATA="$TMPDIR/retry"
mkdir -p "$DATA/memories"
printf 'blank-window fact\n' > "$DATA/memories/MEMORY.md"
printf 'template soul\n' > "$DATA/SOUL.md"
touch "$DATA/.memory-restore-failed"
run_restore "$DATA" && ok "retry exits 0" || nope "retry exit" "non-zero exit"
grep -q "blank-window fact" "$DATA"/pre-restore-*/memories/MEMORY.md 2>/dev/null \
    && ok "retry keeps the live MEMORY.md under pre-restore-*/" \
    || nope "retry keep-copy" "live MEMORY.md not kept"
grep -q "template soul" "$DATA"/pre-restore-*/SOUL.md 2>/dev/null \
    && ok "retry keeps the live SOUL.md" || nope "retry keep-copy SOUL" "live SOUL.md not kept"
grep -q "core fact" "$DATA/memories/MEMORY.md" && ok "retry restores MEMORY.md from the repo" \
    || nope "retry restore" "MEMORY.md not restored"
[ ! -e "$DATA/.memory-restore-failed" ] && ok "retry clears the marker" \
    || nope "retry marker" "marker still present"

echo ""
echo "=== App token clones with x-access-token ==="

DATA="$TMPDIR/apptoken"
mkdir -p "$DATA"
GH_STUB_TOKEN=ghs_apptoken run_restore "$DATA" || true
grep -q "^https://x-access-token:ghs_apptoken@example.com/owner/repo" "$TMPDIR/clone-url" 2>/dev/null \
    && ok "ghs_ token uses x-access-token URL" \
    || nope "App token URL" "got: $(cat "$TMPDIR/clone-url" 2>/dev/null)"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
