#!/bin/bash
# Sync ~/.hermes/memories/ to private git repo
set -e

[ -z "${MEMORY_REPO_URL}" ] && exit 0

# Auth: the stored gh App credential only. The long-lived PAT is not delivered
# to this script (it is scoped to the codex-router checkout refresh), so there is
# no PAT fallback here; with no usable credential the sync is skipped.
if AUTH_TOKEN=$(gh auth token 2>/dev/null); then
    :
elif [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_TOKEN="${GITHUB_TOKEN}"
else
    exit 0
fi

# GitHub App tokens (ghs_) need x-access-token as username; PATs work bare
if echo "$AUTH_TOKEN" | grep -q '^ghs_'; then
    REPO_URL="https://x-access-token:${AUTH_TOKEN}@${MEMORY_REPO_URL#https://}"
else
    REPO_URL="https://${AUTH_TOKEN}@${MEMORY_REPO_URL#https://}"
fi
CLONE_DIR="${MEMORY_CLONE_DIR:-/opt/data/memories-backup}"
SRC_DIR="${MEMORY_SRC_DIR:-/opt/data/memories}"
EXPENSE_DIR="${EXPENSE_TRACKER_DATA:-}"
# ponytail: one root for every live path below, so tests can point the whole
# script at a fixture tree with HERMES_DATA_DIR instead of touching /opt/data.
DATA_DIR="${HERMES_DATA_DIR:-/opt/data}"
MNEMOSYNE_DIR="${MNEMOSYNE_DATA_DIR:-$DATA_DIR/mnemosyne/data}"

# Fix read-only permissions from prior git operations
if [ -d "$CLONE_DIR" ]; then
    chmod -R u+w "$CLONE_DIR" 2>/dev/null || true
fi

if [ ! -d "$CLONE_DIR/.git" ]; then
    git clone "$REPO_URL" "$CLONE_DIR"
    cd "$CLONE_DIR"
    git config user.email "hermes-bot@example.com"
    git config user.name "Friday (Hermes Memory)"
    # Handle empty repo (no commits yet)
    if ! git rev-parse --verify main >/dev/null 2>&1; then
        git checkout -b main
        HAS_REMOTE=false
    else
        HAS_REMOTE=true
    fi
else
    cd "$CLONE_DIR"
    # Update remote URL with current token before pull (token may change between runs)
    git remote set-url origin "$REPO_URL" 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true
    HAS_REMOTE=true
fi

cp "$SRC_DIR/MEMORY.md" "$SRC_DIR/USER.md" "$CLONE_DIR/" 2>/dev/null || true
# Topic files hold the durable facts that do not fit the always-on memory core.
# They are memory, so a backup without them is incomplete. MEMORY.md/USER.md are
# copied by name above, which means the directory itself is not copied wholesale.
if [ -d "$SRC_DIR/topics" ]; then
    mkdir -p "$CLONE_DIR/topics"
    cp "$SRC_DIR"/topics/*.md "$CLONE_DIR/topics/" 2>/dev/null || true
fi
# Backup SOUL.md (evolves over time)
cp "$DATA_DIR/SOUL.md" "$CLONE_DIR/" 2>/dev/null || true
if [ -n "$EXPENSE_DIR" ]; then
    mkdir -p "$CLONE_DIR/expense-tracker"
    if [ -f "$EXPENSE_DIR/MEMORY.md" ]; then
        # Credential lines (statement passwords and the like) live in Bitwarden
        # and must never reach git history (#783); every other fact is copied
        # verbatim.
        grep -viE 'password|passcode|passwd|\bnric\b|date of birth|\bdob\b' \
            "$EXPENSE_DIR/MEMORY.md" > "$CLONE_DIR/expense-tracker/MEMORY.md" || true
    else
        echo "WARN: expense memory missing: $EXPENSE_DIR/MEMORY.md" >&2
    fi
    cp "$EXPENSE_DIR/mappings.json" "$CLONE_DIR/expense-tracker/" 2>/dev/null || true
fi

# ---- Kanban backup (SQL dump — safe on live WAL DB) ----
if command -v sqlite3 >/dev/null 2>&1; then
    mkdir -p "$CLONE_DIR/kanban"

    # Default board
    if [ -f "$DATA_DIR/kanban.db" ]; then
        sqlite3 "$DATA_DIR/kanban.db" ".dump" > "$CLONE_DIR/kanban/kanban.sql" 2>/dev/null || true
    fi

    # Named boards
    for board_db in "$DATA_DIR"/kanban/boards/*/kanban.db; do
        [ -f "$board_db" ] || continue
        slug=$(basename "$(dirname "$board_db")")
        sqlite3 "$board_db" ".dump" > "$CLONE_DIR/kanban/${slug}.sql" 2>/dev/null || true
    done
fi

# ---- Profile backup (identity metadata + per-profile memories) ----
mkdir -p "$CLONE_DIR/profiles"

# Sticky active profile
if [ -f "$DATA_DIR/active_profile" ]; then
    cp "$DATA_DIR/active_profile" "$CLONE_DIR/profiles/_active" 2>/dev/null || true
fi

# Named profiles
for profile_dir in "$DATA_DIR"/profiles/*/; do
    [ -d "$profile_dir" ] || continue
    name=$(basename "$profile_dir")
    mkdir -p "$CLONE_DIR/profiles/$name"

    # Description metadata
    if [ -f "$profile_dir/profile.yaml" ]; then
        cp "$profile_dir/profile.yaml" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi

    # Identity files: SOUL.md is the profile personality, config.yaml its
    # routing. Private repo, so no redaction.
    if [ -f "$profile_dir/SOUL.md" ]; then
        cp "$profile_dir/SOUL.md" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi
    if [ -f "$profile_dir/config.yaml" ]; then
        cp "$profile_dir/config.yaml" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi

    # Per-profile memories
    if [ -f "$profile_dir/memories/MEMORY.md" ]; then
        cp "$profile_dir/memories/MEMORY.md" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi
    if [ -f "$profile_dir/memories/USER.md" ]; then
        cp "$profile_dir/memories/USER.md" "$CLONE_DIR/profiles/$name/" 2>/dev/null || true
    fi
done

# ---- Skills backup ----
mkdir -p "$CLONE_DIR/skills"
cp -r "$DATA_DIR"/skills/* "$CLONE_DIR/skills/" 2>/dev/null || true

# ---- LLM wiki backup (curated pages + raw snapshots, whole tree) ----
if [ -d "$DATA_DIR/home/wiki" ]; then
    mkdir -p "$CLONE_DIR/wiki"
    cp -r "$DATA_DIR"/home/wiki/. "$CLONE_DIR/wiki/" 2>/dev/null || true
fi

# ---- Mnemosyne pilot backup (SQLite, safe on live WAL DB) ----
# Additive only: no-op when the provider was never installed. Single file in
# the repo, replaced in place — never timestamped fresh copies. Throttled to
# once per day while the rest of the backup still runs every 6h, so the git
# history does not take a binary blob per run. The sqlite3 path uses .backup
# with busy_timeout so a live gateway write cannot tear the copy; the no-
# sqlite3 fallback only copies when no WAL sidecar exists, else skips.
MNEMOSYNE_BACKUP_MAX_AGE_HOURS="${MNEMOSYNE_BACKUP_MAX_AGE_HOURS:-24}"
case "$MNEMOSYNE_BACKUP_MAX_AGE_HOURS" in ''|*[!0-9]*) MNEMOSYNE_BACKUP_MAX_AGE_HOURS=24 ;; esac
if [ -f "$MNEMOSYNE_DIR/mnemosyne.db" ]; then
    mkdir -p "$CLONE_DIR/mnemosyne"
    _mnemo_dest="$CLONE_DIR/mnemosyne/mnemosyne.db"
    _mnemo_due=true
    if [ -f "$_mnemo_dest" ] && command -v find >/dev/null 2>&1; then
        if [ -z "$(find "$_mnemo_dest" -mmin +"$((MNEMOSYNE_BACKUP_MAX_AGE_HOURS * 60))" 2>/dev/null)" ]; then
            _mnemo_due=false
        fi
    fi
    if [ "$_mnemo_due" = true ]; then
        if command -v sqlite3 >/dev/null 2>&1; then
            sqlite3 "$MNEMOSYNE_DIR/mnemosyne.db" "PRAGMA busy_timeout=5000;" ".backup '$_mnemo_dest'" 2>/dev/null || true
        elif [ ! -f "$MNEMOSYNE_DIR/mnemosyne.db-wal" ]; then
            # No sqlite3 and no WAL sidecar, so a plain copy is crash-consistent.
            # With a WAL sidecar present skip rather than tear the copy.
            cp "$MNEMOSYNE_DIR/mnemosyne.db" "$_mnemo_dest" 2>/dev/null || true
        fi
    fi
    unset _mnemo_dest _mnemo_due
fi

# ---- Cron jobs backup ----
mkdir -p "$CLONE_DIR/cron"
if [ -f "$DATA_DIR/cron/jobs.json" ]; then
    cp "$DATA_DIR/cron/jobs.json" "$CLONE_DIR/cron/" 2>/dev/null || true
fi

cd "$CLONE_DIR"
# Check if there are changes (handles empty repo with no HEAD)
if ! git rev-parse HEAD >/dev/null 2>&1; then
    HAS_CHANGES=true
elif ! git diff --quiet; then
    HAS_CHANGES=true
elif [ -n "$(git ls-files --others --exclude-standard)" ]; then
    HAS_CHANGES=true
else
    HAS_CHANGES=false
fi

if [ "$HAS_CHANGES" = true ]; then
    git add -A
    git commit -m "$(date -Iseconds)"
    if [ "$HAS_REMOTE" = true ]; then
        git push origin main
    else
        git push -u origin main
        HAS_REMOTE=true
    fi
fi
