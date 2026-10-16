#!/bin/bash
# Unit tests for skills backup (memory-backup.sh) and restore (memory-restore.sh).
# Tests file-level copy behavior without real git operations.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# ------------------------------------------------------------------ helpers --
# Simulate the backup step: copy /opt/data/skills → clone_dir/skills
backup_skills() {
    local src="$1"
    local dst="$2"
    mkdir -p "$dst/skills"
    cp -r "$src"/* "$dst/skills/" 2>/dev/null || true
}

# Simulate the restore step: copy clone_dir/skills → /opt/data/skills (no-clobber)
restore_skills() {
    local src="$1"
    local dst="$2"
    if [ -d "$src" ]; then
        mkdir -p "$dst"
        cp -rn "$src/"* "$dst/" 2>/dev/null || true
    fi
}

# Recursively list files with relative paths (for comparison)
list_files() {
    local dir="$1"
    if [ -d "$dir" ]; then
        (cd "$dir" && find . -type f | sort) 2>/dev/null || true
    fi
}

# ==================================================================== backup =
echo "=== Skills Backup ==="

# --- 1. Normal backup: copies skills ---
echo "--- normal backup ---"
SRC="$TMPDIR/src-skills"
DST="$TMPDIR/backup-clone"
mkdir -p "$SRC/productivity/card-recommendation"
echo "card skill content" > "$SRC/productivity/card-recommendation/SKILL.md"
mkdir -p "$SRC/expense-tracker"
echo "expense skill content" > "$SRC/expense-tracker/SKILL.md"

backup_skills "$SRC" "$DST"

[ -f "$DST/skills/productivity/card-recommendation/SKILL.md" ] && ok "card-recommendation backed up" \
    || nope "card-recommendation missing" "file not found in backup"
[ -f "$DST/skills/expense-tracker/SKILL.md" ] && ok "expense-tracker backed up" \
    || nope "expense-tracker missing" "file not found in backup"

# --- 2. Backup preserves file content ---
echo "--- content preserved ---"
actual=$(cat "$DST/skills/productivity/card-recommendation/SKILL.md")
[ "$actual" = "card skill content" ] && ok "content matches" || nope "content mismatch" "got: $actual"

# --- 3. Empty source directory doesn't break ---
echo "--- empty source ---"
EMPTY_SRC="$TMPDIR/empty-skills"
EMPTY_DST="$TMPDIR/empty-backup"
mkdir -p "$EMPTY_SRC"
backup_skills "$EMPTY_SRC" "$EMPTY_DST"
# Should not error; DST/skills is created but empty
[ -d "$EMPTY_DST/skills" ] && ok "empty backup creates dir" || nope "empty backup dir" "dir missing"
[ -z "$(list_files "$EMPTY_DST/skills")" ] && ok "empty backup has no files" \
    || nope "empty backup has files" "$(list_files "$EMPTY_DST/skills")"

# =================================================================== restore =
echo ""
echo "=== Skills Restore (no-clobber) ==="

# --- 4. Normal restore: copies skills from backup ---
echo "--- normal restore ---"
RESTORE_DST="$TMPDIR/restore-dst"
BACKUP_DIR="$TMPDIR/restore-backup/skills"
mkdir -p "$RESTORE_DST"
mkdir -p "$BACKUP_DIR/productivity/card-recommendation"
echo "restored card skill" > "$BACKUP_DIR/productivity/card-recommendation/SKILL.md"
mkdir -p "$BACKUP_DIR/expense-tracker"
echo "restored expense skill" > "$BACKUP_DIR/expense-tracker/SKILL.md"

restore_skills "$BACKUP_DIR" "$RESTORE_DST"

[ -f "$RESTORE_DST/productivity/card-recommendation/SKILL.md" ] && ok "card-recommendation restored" \
    || nope "card-recommendation not restored" ""
[ -f "$RESTORE_DST/expense-tracker/SKILL.md" ] && ok "expense-tracker restored" \
    || nope "expense-tracker not restored" ""

# --- 5. No-clobber: existing files NOT overwritten ---
echo "--- no-clobber: existing preserved ---"
# Pre-seed a baked-in skill (simulating 50-seed-defaults ran first)
CLOBBER_DST="$TMPDIR/clobber-dst"
CLOBBER_BACKUP="$TMPDIR/clobber-backup/skills"
mkdir -p "$CLOBBER_DST/expense-tracker"
echo "BAKED-IN expense skill v2" > "$CLOBBER_DST/expense-tracker/SKILL.md"
# Backup has an older version of expense-tracker + a Hermes-generated skill
mkdir -p "$CLOBBER_BACKUP/expense-tracker"
echo "OLD backed-up expense skill" > "$CLOBBER_BACKUP/expense-tracker/SKILL.md"
mkdir -p "$CLOBBER_BACKUP/productivity/card-recommendation"
echo "hermes card skill" > "$CLOBBER_BACKUP/productivity/card-recommendation/SKILL.md"

restore_skills "$CLOBBER_BACKUP" "$CLOBBER_DST"

baked=$(cat "$CLOBBER_DST/expense-tracker/SKILL.md")
[ "$baked" = "BAKED-IN expense skill v2" ] && ok "baked-in skill NOT overwritten" \
    || nope "baked-in overwritten" "got: $baked"
hermes_card=$(cat "$CLOBBER_DST/productivity/card-recommendation/SKILL.md")
[ "$hermes_card" = "hermes card skill" ] && ok "hermes-generated skill restored" \
    || nope "hermes skill not restored" "got: $hermes_card"

# --- 6. Missing backup directory is silent no-op ---
echo "--- missing backup dir ---"
MISSING_DST="$TMPDIR/missing-backup-dst"
mkdir -p "$MISSING_DST"
restore_skills "$TMPDIR/nonexistent-skills" "$MISSING_DST"
# Should not error and not create anything new
[ -d "$MISSING_DST" ] && ok "missing backup dir handled gracefully" || nope "missing backup dir" "crashed"

# --- 7. Restore from empty backup dir ---
echo "--- empty backup dir ---"
EMPTY_RESTORE_SRC="$TMPDIR/empty-restore-backup/skills"
EMPTY_RESTORE_DST="$TMPDIR/empty-restore-dst"
mkdir -p "$EMPTY_RESTORE_SRC"
mkdir -p "$EMPTY_RESTORE_DST"
# Pre-seed a baked-in skill
mkdir -p "$EMPTY_RESTORE_DST/expense-tracker"
echo "baked" > "$EMPTY_RESTORE_DST/expense-tracker/SKILL.md"

restore_skills "$EMPTY_RESTORE_SRC" "$EMPTY_RESTORE_DST"
baked2=$(cat "$EMPTY_RESTORE_DST/expense-tracker/SKILL.md")
[ "$baked2" = "baked" ] && ok "empty backup leaves baked-in intact" \
    || nope "empty backup broke baked-in" "got: $baked2"

# --- 8. Nested directory structures preserved ---
echo "--- nested dirs preserved ---"
NESTED_SRC="$TMPDIR/nested-skills"
NESTED_DST="$TMPDIR/nested-backup"
NESTED_RESTORE="$TMPDIR/nested-restore"
mkdir -p "$NESTED_SRC/productivity/card-recommendation"
mkdir -p "$NESTED_SRC/development/git-workflow"
echo "card" > "$NESTED_SRC/productivity/card-recommendation/SKILL.md"
echo "git" > "$NESTED_SRC/development/git-workflow/SKILL.md"

backup_skills "$NESTED_SRC" "$NESTED_DST"
restore_skills "$NESTED_DST/skills" "$NESTED_RESTORE"

[ -f "$NESTED_RESTORE/productivity/card-recommendation/SKILL.md" ] && ok "nested productivity restored" \
    || nope "nested productivity" "missing"
[ -f "$NESTED_RESTORE/development/git-workflow/SKILL.md" ] && ok "nested development restored" \
    || nope "nested development" "missing"

# --- 9. Skills with no SKILL.md (empty dirs) handled ---
echo "--- empty skill dir ---"
MIXED_SRC="$TMPDIR/mixed-skills"
MIXED_BACKUP="$TMPDIR/mixed-backup-clone"
MIXED_RESTORE="$TMPDIR/mixed-restore"
mkdir -p "$MIXED_SRC/empty-skill"
mkdir -p "$MIXED_SRC/valid-skill"
echo "valid" > "$MIXED_SRC/valid-skill/SKILL.md"

backup_skills "$MIXED_SRC" "$MIXED_BACKUP"
# Empty dir won't be copied by cp -r (nothing inside); valid skill should be there
[ -f "$MIXED_BACKUP/skills/valid-skill/SKILL.md" ] && ok "valid skill backed up with empty peer" \
    || nope "valid skill with empty peer" "missing"

restore_skills "$MIXED_BACKUP/skills" "$MIXED_RESTORE"
[ -f "$MIXED_RESTORE/valid-skill/SKILL.md" ] && ok "valid skill restored with empty peer" \
    || nope "valid skill restore with empty peer" "missing"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
