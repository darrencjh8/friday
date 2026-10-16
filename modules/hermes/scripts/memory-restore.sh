#!/bin/bash
# Restore memories from friday-memory repo on first boot.
# Skills are always synced on every boot (not just first).
set -e

# ponytail: same single-root trick as memory-backup.sh — tests point the whole
# restore at a fixture tree with HERMES_DATA_DIR.
DATA_DIR="${HERMES_DATA_DIR:-/opt/data}"
MNEMOSYNE_DIR="${MNEMOSYNE_DATA_DIR:-$DATA_DIR/mnemosyne/data}"
SRC_DIR="${MEMORY_SRC_DIR:-$DATA_DIR/memories}"
FIRST_BOOT=false
[ -f "$SRC_DIR/MEMORY.md" ] || FIRST_BOOT=true

[ -z "${MEMORY_REPO_URL}" ] && exit 0

log() { echo "[memory-restore] $*" >&2; }

# Auth: the stored gh App credential only. The long-lived PAT is not delivered
# to this script (it is scoped to the codex-router checkout refresh), so there is
# no PAT fallback here; with no usable credential the restore is skipped.
if AUTH_TOKEN=$(gh auth token 2>/dev/null); then
    :
elif [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_TOKEN="${GITHUB_TOKEN}"
else
    log "no auth token — skipping restore"
    exit 0
fi

REPO_URL="https://${AUTH_TOKEN}@${MEMORY_REPO_URL#https://}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

log "cloning friday-memory repo..."
git clone -q "$REPO_URL" "$TMP_DIR" 2>/dev/null || { log "clone failed — skipping"; exit 0; }

mkdir -p "$SRC_DIR"

# Restore core memory files (first boot only)
if $FIRST_BOOT; then
    for f in MEMORY.md USER.md; do
        if [ -f "$TMP_DIR/$f" ]; then
            cp "$TMP_DIR/$f" "$SRC_DIR/"
            log "restored $f"
        fi
    done
fi

# Restore SOUL.md if backed up
if [ -f "$TMP_DIR/SOUL.md" ]; then
    cp "$TMP_DIR/SOUL.md" "$DATA_DIR/"
    log "restored SOUL.md"
fi

# Restore LLM wiki (whole tree)
if [ -d "$TMP_DIR/wiki" ]; then
    mkdir -p "$DATA_DIR/home/wiki"
    cp -r "$TMP_DIR"/wiki/. "$DATA_DIR/home/wiki/" 2>/dev/null || true
    log "restored wiki"
fi

# Restore mnemosyne DB (replace in place, never merge)
if [ -f "$TMP_DIR/mnemosyne/mnemosyne.db" ]; then
    mkdir -p "$MNEMOSYNE_DIR"
    cp "$TMP_DIR/mnemosyne/mnemosyne.db" "$MNEMOSYNE_DIR/" 2>/dev/null || true
    log "restored mnemosyne.db"
fi

# Restore expense tracker data
EXPENSE_DIR="${EXPENSE_TRACKER_DATA:-}"
if [ -n "$EXPENSE_DIR" ]; then
    mkdir -p "$EXPENSE_DIR"
    for f in MEMORY.md mappings.json; do
        if [ -f "$TMP_DIR/expense-tracker/$f" ]; then
            cp "$TMP_DIR/expense-tracker/$f" "$EXPENSE_DIR/"
            log "restored expense-tracker/$f"
        fi
    done
fi

# Restore kanban
if [ -d "$TMP_DIR/kanban" ] && command -v sqlite3 >/dev/null 2>&1; then
    mkdir -p "$DATA_DIR/kanban/boards"
    for sql_file in "$TMP_DIR/kanban/"*.sql; do
        [ -f "$sql_file" ] || continue
        name=$(basename "$sql_file" .sql)
        if [ "$name" = "kanban" ]; then
            sqlite3 "$DATA_DIR/kanban.db" < "$sql_file" 2>/dev/null || true
        else
            mkdir -p "$DATA_DIR/kanban/boards/$name"
            sqlite3 "$DATA_DIR/kanban/boards/$name/kanban.db" < "$sql_file" 2>/dev/null || true
        fi
    done
    log "restored kanban"
fi

# Restore skills (no-clobber — baked-in skills from image take precedence)
if [ -d "$TMP_DIR/skills" ]; then
    mkdir -p "$DATA_DIR/skills"
    cp -rn "$TMP_DIR/skills/"* "$DATA_DIR/skills/" 2>/dev/null || true
    log "restored skills"
fi

# Restore profiles
if [ -d "$TMP_DIR/profiles" ]; then
    for profile_dir in "$TMP_DIR/profiles/"*/; do
        [ -d "$profile_dir" ] || continue
        name=$(basename "$profile_dir")
        [ "$name" = "_active" ] && continue
        mkdir -p "$DATA_DIR/profiles/$name/memories"
        if [ -f "$profile_dir/profile.yaml" ]; then
            cp "$profile_dir/profile.yaml" "$DATA_DIR/profiles/$name/"
        fi
        if [ -f "$profile_dir/SOUL.md" ]; then
            cp "$profile_dir/SOUL.md" "$DATA_DIR/profiles/$name/"
        fi
        if [ -f "$profile_dir/config.yaml" ]; then
            cp "$profile_dir/config.yaml" "$DATA_DIR/profiles/$name/"
        fi
        if [ -f "$profile_dir/MEMORY.md" ]; then
            cp "$profile_dir/MEMORY.md" "$DATA_DIR/profiles/$name/memories/"
        fi
        if [ -f "$profile_dir/USER.md" ]; then
            cp "$profile_dir/USER.md" "$DATA_DIR/profiles/$name/memories/"
        fi
    done
    # Restore active profile pointer
    if [ -f "$TMP_DIR/profiles/_active" ]; then
        cp "$TMP_DIR/profiles/_active" "$DATA_DIR/active_profile"
    fi
    log "restored profiles"
fi

log "memory restore complete"
