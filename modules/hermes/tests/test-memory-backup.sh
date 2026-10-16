#!/bin/bash
# Tests URL construction plus memory-backup.sh end-to-end with stubbed git and gh.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

# Extract the REPO_URL construction logic (lines 17-22 from memory-backup.sh)
build_repo_url() {
    local auth_token="$1"
    local memory_repo_url="${2:-https://example.com/owner/repo}"
    if echo "$auth_token" | grep -q '^ghs_'; then
        echo "https://x-access-token:${auth_token}@${memory_repo_url#https://}"
    else
        echo "https://${auth_token}@${memory_repo_url#https://}"
    fi
}

echo "=== REPO_URL construction ==="

result=$(build_repo_url "ghs_abc123token")
expected="https://x-access-token:ghs_abc123token@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "App token (ghs_) uses x-access-token: prefix" \
    || nope "App token prefix" "got: $result"

result=$(build_repo_url "ghp_classicPatToken")
expected="https://ghp_classicPatToken@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "PAT (ghp_) uses bare TOKEN@ format" \
    || nope "PAT bare format" "got: $result"

result=$(build_repo_url "github_pat_fineGrained")
expected="https://github_pat_fineGrained@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "Fine-grained PAT uses bare TOKEN@ format" \
    || nope "FG PAT bare format" "got: $result"

result=$(build_repo_url "ghs_abc" "https://example.com/darrencjh8/friday-memory")
expected="https://x-access-token:ghs_abc@example.com/darrencjh8/friday-memory"
[ "$result" = "$expected" ] && ok "App token with real repo URL" \
    || nope "App token real URL" "got: $result"

result=$(build_repo_url "ghp_xyz" "https://example.com/darrencjh8/friday-memory")
expected="https://ghp_xyz@example.com/darrencjh8/friday-memory"
[ "$result" = "$expected" ] && ok "PAT with real repo URL" \
    || nope "PAT real URL" "got: $result"

echo ""
echo "=== Token prefix detection edge cases ==="

# ghs_ should match at start only
result=$(build_repo_url "ghs_token_with_ghs_inside")
expected="https://x-access-token:ghs_token_with_ghs_inside@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "ghs_ at start, not middle" \
    || nope "ghs_ start only" "got: $result"

# Not starting with ghs_ should NOT use x-access-token
result=$(build_repo_url "abc_ghs_token")
expected="https://abc_ghs_token@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "ghs_ not at start → bare format" \
    || nope "ghs_ not at start" "got: $result"

echo ""
echo "=== topic files are copied into the backup repo ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
backup_script="$SCRIPT_DIR/../scripts/memory-backup.sh"
topic_src="$TMPDIR/memories"
topic_clone="$TMPDIR/memories-backup"
mkdir -p "$topic_src/topics" "$topic_clone/.git" "$TMPDIR/stubbin"
printf 'core fact\n' > "$topic_src/MEMORY.md"
printf 'user fact\n' > "$topic_src/USER.md"
printf 'card 1888 -> Delta Extra\n' > "$topic_src/topics/accounts.md"
printf 'NTUC FairPrice -> Groceries\n' > "$topic_src/topics/expenses.md"

# Stub git so the copy loop runs without a real repository or network access.
cat > "$TMPDIR/stubbin/git" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$TMPDIR/stubbin/git"

MEMORY_REPO_URL="https://example.com/owner/repo" \
GITHUB_TOKEN="ghp_test_token" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$topic_clone" \
PATH="$TMPDIR/stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true

[ -f "$topic_clone/topics/accounts.md" ] && ok "topics/accounts.md copied" \
    || nope "topics copied" "accounts.md missing from $topic_clone/topics"
[ -f "$topic_clone/topics/expenses.md" ] && ok "topics/expenses.md copied" \
    || nope "topics copied" "expenses.md missing from $topic_clone/topics"
grep -q "card 1888" "$topic_clone/topics/accounts.md" 2>/dev/null \
    && ok "topic file content preserved" \
    || nope "topic content" "content not preserved"
[ -f "$topic_clone/MEMORY.md" ] && ok "MEMORY.md still copied" \
    || nope "MEMORY.md copy" "regression: core store not copied"

echo ""
echo "=== expense-tracker memory copy ==="

expense_src="$TMPDIR/expense-memories"
expense_clone="$TMPDIR/expense-backup"
mkdir -p "$expense_src" "$expense_clone" "$TMPDIR/expense-stubbin"
printf '# Long-Term Memory\n\n## Facts\n\n- Alpha Cafe maps to Food payee\n- Zeta statement password is hunter22\n- Omega eStatement Password format: name plus digits\n- Card ending 1111 belongs to Zeta Card\n' > "$expense_src/MEMORY.md"
printf 'not memory\n' > "$expense_src/dedup.db"
printf 'not memory\n' > "$expense_src/metadata.json"
printf 'not memory\n' > "$expense_src/statement.db"
printf 'not memory\n' > "$expense_src/.env"

# Stub all git calls made by the backup script; clone creates local repository shape.
cat > "$TMPDIR/expense-stubbin/git" <<'STUB'
#!/bin/sh
if [ "$1" = clone ]; then
    mkdir -p "$3/.git"
    exit 0
fi
if [ "$1" = diff ]; then
    exit 1
fi
exit 0
STUB
cat > "$TMPDIR/expense-stubbin/gh" <<'STUB'
#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
    printf 'ghp_test_token\n'
fi
STUB
chmod +x "$TMPDIR/expense-stubbin/git" "$TMPDIR/expense-stubbin/gh"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$expense_clone" \
EXPENSE_TRACKER_DATA="$expense_src" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1

# Statement passwords live in Bitwarden (#783); the git backup must never hold
# a credential line, while every other fact is still copied verbatim.
backed="$expense_clone/expense-tracker/MEMORY.md"
grep -qx -- '- Alpha Cafe maps to Food payee' "$backed" 2>/dev/null \
    && grep -qx -- '- Card ending 1111 belongs to Zeta Card' "$backed" \
    && ok "expense-tracker MEMORY.md facts copied verbatim" \
    || nope "expense-tracker memory copy" "facts missing or changed"
if grep -qi 'password' "$backed" 2>/dev/null || grep -q 'hunter22' "$backed" 2>/dev/null; then
    nope "expense-tracker credential lines" "a password line reached the backup"
else
    ok "expense-tracker credential lines never reach the backup"
fi
[ -f "$expense_clone/expense-tracker/MEMORY.md" ] \
    && ok "expense-tracker copy exists before exclusion checks" \
    || nope "expense-tracker copy" "MEMORY.md missing"
for excluded in dedup.db metadata.json statement.db .env; do
    [ ! -e "$expense_clone/expense-tracker/$excluded" ] \
        && ok "expense-tracker $excluded excluded" \
        || nope "expense-tracker exclusions" "$excluded copied"
done

missing_clone="$TMPDIR/expense-backup-missing"
mkdir -p "$missing_clone"
if env -u EXPENSE_TRACKER_DATA \
    MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$missing_clone" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 \
    && [ ! -e "$missing_clone/expense-tracker/MEMORY.md" ]; then
    ok "unset expense directory creates no partial memory"
else
    nope "unset expense directory" "backup failed or created expense-tracker/MEMORY.md"
fi

empty_expense="$TMPDIR/empty-expense"
empty_clone="$TMPDIR/expense-backup-empty"
stale_memory="$TMPDIR/stale-expense-memory"
empty_log="$TMPDIR/empty-expense.log"
mkdir -p "$empty_expense" "$empty_clone/expense-tracker"
printf 'stale expense memory\n' > "$stale_memory"
cp "$stale_memory" "$empty_clone/expense-tracker/MEMORY.md"
if MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$empty_clone" \
    EXPENSE_TRACKER_DATA="$empty_expense" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >"$empty_log" 2>&1 \
    && grep -Fq "WARN: expense memory missing:" "$empty_log" \
    && cmp -s "$stale_memory" "$empty_clone/expense-tracker/MEMORY.md"; then
    ok "missing expense MEMORY.md warns without changing stale memory"
else
    nope "missing expense MEMORY.md" "backup lacked warning or changed stale memory"
fi

echo ""
echo "=== mnemosyne pilot backup (additive, no-op when absent) ==="

mnemo_src="$TMPDIR/mnemo-data"
mnemo_clone="$TMPDIR/mnemo-backup"
mkdir -p "$mnemo_src" "$mnemo_clone"
if MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$mnemo_clone" \
    MNEMOSYNE_DATA_DIR="$mnemo_src" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 \
    && [ ! -e "$mnemo_clone/mnemosyne/mnemosyne.db" ]; then
    ok "absent mnemosyne.db creates no backup file"
else
    nope "absent mnemosyne backup" "backup failed or created mnemosyne.db from nothing"
fi

if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$mnemo_src/mnemosyne.db" "CREATE TABLE t(x TEXT); INSERT INTO t VALUES('pilot');" 2>/dev/null || true
else
    printf 'pilot\n' > "$mnemo_src/mnemosyne.db"
fi
if MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$mnemo_clone" \
    MNEMOSYNE_DATA_DIR="$mnemo_src" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 \
    && [ -f "$mnemo_clone/mnemosyne/mnemosyne.db" ]; then
    ok "present mnemosyne.db backed up"
else
    nope "present mnemosyne backup" "mnemosyne.db missing from $mnemo_clone/mnemosyne"
fi

echo ""
echo "=== mnemosyne backup replaces in place, throttled daily ==="

_mnemo_dest="$mnemo_clone/mnemosyne/mnemosyne.db"
_mnemo_mtime1=$(stat -c%Y "$_mnemo_dest" 2>/dev/null || stat -f%m "$_mnemo_dest" 2>/dev/null)
sleep 1
MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$mnemo_clone" \
MNEMOSYNE_DATA_DIR="$mnemo_src" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true
_mnemo_mtime2=$(stat -c%Y "$_mnemo_dest" 2>/dev/null || stat -f%m "$_mnemo_dest" 2>/dev/null)
[ "$_mnemo_mtime1" = "$_mnemo_mtime2" ] && ok "fresh mnemosyne backup skipped (replace, not fresh copy)" \
    || nope "mnemosyne throttle" "backup rewrote a fresh copy within 24h"
touch -d '2 days ago' "$_mnemo_dest" 2>/dev/null || touch -t 202001010000 "$_mnemo_dest"
sleep 1
MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$mnemo_clone" \
MNEMOSYNE_DATA_DIR="$mnemo_src" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true
_mnemo_mtime3=$(stat -c%Y "$_mnemo_dest" 2>/dev/null || stat -f%m "$_mnemo_dest" 2>/dev/null)
[ "$_mnemo_mtime3" != "$_mnemo_mtime2" ] && ok "stale mnemosyne backup replaced in place" \
    || nope "mnemosyne replace" "stale backup older than 24h not refreshed"
ls "$mnemo_clone/mnemosyne/" | grep -Eq 'mnemosyne-[0-9]{8}' \
    && nope "mnemosyne timestamped copies" "found dated fresh copies beside mnemosyne.db" \
    || ok "single mnemosyne.db path, no dated copies"
unset _mnemo_dest _mnemo_mtime1 _mnemo_mtime2 _mnemo_mtime3

echo ""
echo "=== wiki tree is copied into the backup repo ==="

fake_root="$TMPDIR/fake-data"
wiki_clone="$TMPDIR/wiki-backup"
mkdir -p "$fake_root/home/wiki/entities/accounts" "$fake_root/home/wiki/concepts" \
    "$fake_root/home/wiki/raw/articles" "$wiki_clone"
printf '# Schema\n' > "$fake_root/home/wiki/SCHEMA.md"
printf '# Index\n' > "$fake_root/home/wiki/index.md"
printf 'banks content\n' > "$fake_root/home/wiki/entities/accounts/banks-cards.md"
printf 'routing content\n' > "$fake_root/home/wiki/concepts/llm-routing.md"
printf 'snapshot\n' > "$fake_root/home/wiki/raw/articles/snap.md"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$wiki_clone" \
HERMES_DATA_DIR="$fake_root" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true

[ -f "$wiki_clone/wiki/SCHEMA.md" ] && ok "wiki/SCHEMA.md copied" \
    || nope "wiki backup" "SCHEMA.md missing from $wiki_clone/wiki"
[ -f "$wiki_clone/wiki/entities/accounts/banks-cards.md" ] && ok "wiki nested entity copied" \
    || nope "wiki backup" "nested entity missing from $wiki_clone/wiki"
[ -f "$wiki_clone/wiki/raw/articles/snap.md" ] && ok "wiki raw snapshot copied" \
    || nope "wiki backup" "raw snapshot missing from $wiki_clone/wiki"
grep -q "routing content" "$wiki_clone/wiki/concepts/llm-routing.md" 2>/dev/null \
    && ok "wiki content preserved" \
    || nope "wiki content" "content not preserved"

rm -rf "$fake_root/home/wiki"
nowiki_clone="$TMPDIR/nowiki-backup"
mkdir -p "$nowiki_clone"
if MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$nowiki_clone" \
    HERMES_DATA_DIR="$fake_root" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 \
    && [ ! -e "$nowiki_clone/wiki" ]; then
    ok "absent wiki creates no backup dir"
else
    nope "absent wiki backup" "backup failed or created wiki/ from nothing"
fi

echo ""
echo "=== profile SOUL.md and config.yaml are copied ==="

prof_root="$TMPDIR/prof-data"
prof_clone="$TMPDIR/prof-backup"
mkdir -p "$prof_root/profiles/architect/memories" "$prof_clone"
printf 'arch soul\n' > "$prof_root/profiles/architect/SOUL.md"
printf 'api_key: test\n' > "$prof_root/profiles/architect/config.yaml"
printf 'desc\n' > "$prof_root/profiles/architect/profile.yaml"
printf 'mem\n' > "$prof_root/profiles/architect/memories/MEMORY.md"
printf 'default\n' > "$prof_root/active_profile"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$prof_clone" \
HERMES_DATA_DIR="$prof_root" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true

[ -f "$prof_clone/profiles/architect/SOUL.md" ] && ok "profile SOUL.md copied" \
    || nope "profile SOUL backup" "SOUL.md missing from $prof_clone/profiles/architect"
[ -f "$prof_clone/profiles/architect/config.yaml" ] && ok "profile config.yaml copied" \
    || nope "profile config backup" "config.yaml missing from $prof_clone/profiles/architect"
[ -f "$prof_clone/profiles/architect/profile.yaml" ] && ok "profile.yaml still copied" \
    || nope "profile.yaml copy" "regression: profile.yaml not copied"
[ -f "$prof_clone/profiles/_active" ] && ok "active profile pointer copied" \
    || nope "active profile copy" "_active missing from $prof_clone/profiles"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
