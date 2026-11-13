#!/bin/sh
#
# Keep Friday's shared persona in step with the private persona repo.
#
# The persona repo is the single source of truth every Friday agent reads: SOUL.md
# (who she is), IDENTITY.md, calendar.md and preferences.md, all at the top level.
# Hermes only reads it. This script keeps a clone at $PERSONA_DIR on the persona
# repo's main branch, then copies the repo's SOUL.md into the live SOUL.md between
# the friday-persona markers. Everything outside the markers (Hermes-only rules,
# the codex-router block) is left alone, and a SOUL.md without the markers is not
# touched at all. The calendar and preferences are read from the clone in place.
#
# Runs as hermes at boot and from the persona-sync cron. Never blocks boot: a
# missing token, a failed fetch, or a dirty clone is logged and exits 0.
#
# shellcheck shell=sh
set -eu

PERSONA_REPO_URL=${PERSONA_REPO_URL:-https://github.com/darrencjh8/friday-persona.git}
PERSONA_DIR=${PERSONA_DIR:-/workspace/friday-persona}
SOUL=${SOUL_PATH:-${HERMES_HOME:-/opt/data}/SOUL.md}
START='<!-- friday-persona:start -->'
END='<!-- friday-persona:end -->'

log() { echo "persona-sync: $*"; }

# Same token order as memory-restore.sh. The token reaches git through the
# environment-backed helper, never through the process arguments.
AUTH_TOKEN=$(gh auth token 2>/dev/null) || AUTH_TOKEN=${GITHUB_TOKEN:-}
export AUTH_TOKEN
# shellcheck disable=SC2016  # git expands $AUTH_TOKEN when it runs the helper
HELPER='!f() { printf "username=x-access-token\npassword=%s\n" "$AUTH_TOKEN"; }; f'
case "$PERSONA_REPO_URL" in https://*) [ -n "$AUTH_TOKEN" ] || { log "no GitHub token; skipping"; exit 0; } ;; esac

if [ ! -d "$PERSONA_DIR/.git" ]; then
    timeout 120 git -c "credential.helper=$HELPER" clone --quiet --branch main "$PERSONA_REPO_URL" "$PERSONA_DIR" \
        || { log "clone failed"; exit 0; }
elif [ -n "$(git -C "$PERSONA_DIR" status --porcelain)" ]; then
    log "$PERSONA_DIR is dirty; leaving it alone"
else
    { timeout 120 git -C "$PERSONA_DIR" -c "credential.helper=$HELPER" fetch --quiet origin main \
        && git -C "$PERSONA_DIR" merge --ff-only --quiet FETCH_HEAD; } || log "could not fast-forward $PERSONA_DIR"
fi
log "$PERSONA_DIR is at $(git -C "$PERSONA_DIR" rev-parse --short HEAD)"

[ -s "$PERSONA_DIR/SOUL.md" ] || { log "no SOUL.md in the persona repo; SOUL.md unchanged"; exit 0; }
[ -f "$SOUL" ] || { log "no $SOUL; nothing to update"; exit 0; }
if ! grep -qxF "$START" "$SOUL" || ! grep -qxF "$END" "$SOUL"; then
    log "$SOUL has no friday-persona markers; SOUL.md unchanged"
    exit 0
fi

tmp="$SOUL.persona-sync.$$"
awk -v start="$START" -v end="$END" -v src="$PERSONA_DIR/SOUL.md" '
    $0 == start { print; while ((getline line < src) > 0) print line; skip = 1; next }
    $0 == end { skip = 0 }
    !skip { print }
' "$SOUL" >"$tmp"
if cmp -s "$tmp" "$SOUL"; then
    rm -f "$tmp"
    log "SOUL.md already current"
else
    mv "$tmp" "$SOUL"
    log "SOUL.md persona block updated"
fi
