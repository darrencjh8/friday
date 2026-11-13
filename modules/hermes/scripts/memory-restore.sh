#!/bin/bash
# Restore a fresh volume from the friday-memory repo.
# The live volume is the only writer: on an existing volume (memories/MEMORY.md
# present) this does nothing, so it can never overwrite an edit the 6-hourly
# memory-backup has not pushed yet. A failed restore leaves a marker that blocks
# memory-backup and makes the next boot retry. expense-tracker data is not
# restored: hermes sees it on a read-only mount owned by that service.
set -e

# ponytail: same single-root trick as memory-backup.sh — tests point the whole
# restore at a fixture tree with HERMES_DATA_DIR.
DATA_DIR="${HERMES_DATA_DIR:-/opt/data}"
MNEMOSYNE_DIR="${MNEMOSYNE_DATA_DIR:-$DATA_DIR/mnemosyne/data}"
SRC_DIR="${MEMORY_SRC_DIR:-$DATA_DIR/memories}"
MARKER="$DATA_DIR/.memory-restore-failed"
RETRY=false
[ -f "$MARKER" ] && RETRY=true

[ -z "${MEMORY_REPO_URL}" ] && exit 0
[ -f "$SRC_DIR/MEMORY.md" ] && ! $RETRY && exit 0

log() { echo "[memory-restore] $*" >&2; }

# Fail closed: set before anything else, cleared only on the last line, so any
# exit in between (set -e included) leaves it.
touch "$MARKER"

# Auth: the stored gh App credential only. The long-lived PAT is not delivered
# to this script (it is scoped to the codex-router checkout refresh), so there is
# no PAT fallback here; with no usable credential the restore fails and retries.
if AUTH_TOKEN=$(gh auth token 2>/dev/null); then
    :
elif [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_TOKEN="${GITHUB_TOKEN}"
else
    log "no auth token — restore failed, will retry next boot"
    exit 0
fi

# GitHub accepts any username with a PAT, so one form covers App and PAT tokens.
REPO_URL="https://x-access-token:${AUTH_TOKEN}@${MEMORY_REPO_URL#https://}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

log "cloning friday-memory repo..."
git clone -q "$REPO_URL" "$TMP_DIR" 2>/dev/null || { log "clone failed — will retry next boot"; exit 0; }

# A retry overwrites whatever she built on the unrestored volume, so keep it.
if $RETRY; then
    KEEP_DIR="$DATA_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    for p in memories/MEMORY.md memories/USER.md SOUL.md memories/topics; do
        [ -e "$DATA_DIR/$p" ] || continue
        mkdir -p "$KEEP_DIR/$(dirname "$p")"
        cp -r "$DATA_DIR/$p" "$KEEP_DIR/$p"
    done
    log "kept live files in $KEEP_DIR"
fi

mkdir -p "$SRC_DIR"

for f in MEMORY.md USER.md; do
    if [ -f "$TMP_DIR/$f" ]; then
        cp "$TMP_DIR/$f" "$SRC_DIR/"
        log "restored $f"
    fi
done

if [ -d "$TMP_DIR/topics" ]; then
    mkdir -p "$SRC_DIR/topics"
    cp -r "$TMP_DIR"/topics/. "$SRC_DIR/topics/"
    log "restored topics"
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
rm -f "$MARKER"
