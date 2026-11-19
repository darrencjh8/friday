#!/bin/sh
#
# Publish Hermes's changes to the experience wiki (experience/ in the shared
# persona repo). Hermes calls it at the close of a piece of work when she learned
# a reusable fact. Same protocol as persona-commit.sh: a backup tag of the last
# canonical state before every push, never a force-push, and a stop on a real
# conflict so the owner merges by hand. Unlike persona-commit.sh there is no
# daily cap and no SOUL.md evolution line.
#
# Refused, with the edit kept as a patch under $PENDING_DIR and the clone reset to
# origin/main so persona-sync keeps working:
# - a path outside experience/ changed;
# - an existing file under experience/raw/ was edited or deleted (raw is immutable);
# - experience/wiki/log.md changed other than by appending at its end;
# - the message or added lines hold personal information (persona-pii-gate.py);
# - the rebase onto the other agent's newer commit conflicts.
#
# Exit status: 0 published or nothing to publish, 2 refused, 3 conflict,
# 1 any other failure (fetch, push).
#
# Usage: experience-commit.sh "<one-line message>"
#
# shellcheck shell=sh
set -eu

PERSONA_DIR=${PERSONA_DIR:-/workspace/friday-persona}
STATE_DIR=${PERSONA_STATE_DIR:-${HERMES_HOME:-/opt/data}/persona-reflection}
PENDING_DIR=$STATE_DIR/pending
MESSAGE=${1:-}
LOG_MD=experience/wiki/log.md

log() { echo "experience-commit: $*"; }
[ -n "$MESSAGE" ] || { log "usage: experience-commit.sh \"<message>\""; exit 2; }
mkdir -p "$PENDING_DIR"
cd "$PERSONA_DIR"

AUTH_TOKEN=$(gh auth token 2>/dev/null) || AUTH_TOKEN=${GITHUB_TOKEN:-}
export AUTH_TOKEN
# shellcheck disable=SC2016  # git expands $AUTH_TOKEN when it runs the helper
HELPER='!f() { printf "username=x-access-token\npassword=%s\n" "$AUTH_TOKEN"; }; f'
g() { timeout 120 git -c "credential.helper=$HELPER" -c user.name="Friday (Hermes)" -c user.email="friday-hermes@localhost" "$@"; }

stamp=$(date -u +%Y%m%d-%H%M%S)
base=$(git rev-parse HEAD)
park() {
    patch="$PENDING_DIR/$stamp.patch"
    git rebase --abort >/dev/null 2>&1 || true
    git add -A
    git diff --cached "$base" >"$patch" || true
    git reset --quiet --hard "@{u}"
    log "$1; the edit is kept at $patch and the clone is back on origin/main"
    exit "$2"
}

git add -A
git diff --cached --quiet && { log "nothing changed; nothing to publish"; exit 0; }
git diff --cached --name-status --no-renames | while read -r status path; do
    case $path in experience/*) ;; *) echo "$path may not be changed by experience-commit"; exit 1 ;; esac
    case $status:$path in [MD]:experience/raw/*) echo "$path is raw evidence and may not be edited or deleted"; exit 1 ;; esac
done >"$STATE_DIR/refusal" || park "refused: $(cat "$STATE_DIR/refusal")" 2
if ! git diff --cached --quiet -- "$LOG_MD" && git cat-file -e "HEAD:$LOG_MD" 2>/dev/null; then
    git show "HEAD:$LOG_MD" >"$STATE_DIR/log.old"
    head -c "$(wc -c <"$STATE_DIR/log.old")" "$LOG_MD" | cmp -s - "$STATE_DIR/log.old" \
        || park "refused: $LOG_MD is append-only" 2
fi
gate=$({ printf '%s\n' "$MESSAGE"; git diff --cached -U0 | sed -n '/^+++ /d; s/^+//p'; } \
    | python3 "$(dirname "$0")/persona-pii-gate.py") || park "refused: $gate" 2

g commit --quiet -m "$MESSAGE (Hermes)"
for _ in 1 2; do
    g fetch --quiet origin main || { log "fetch failed"; park "not published" 1; }
    # Backup tag of the last canonical state, pushed before the change.
    tag="backup-$stamp-hermes-$(git rev-parse --short FETCH_HEAD)"
    g tag -f "$tag" FETCH_HEAD >/dev/null
    g push --quiet origin "refs/tags/$tag" || { log "could not push the backup tag"; park "not published" 1; }
    g rebase --quiet FETCH_HEAD >/dev/null 2>&1 || park "conflict: the other agent changed the same lines; the owner merges by hand" 3
    if g push --quiet origin HEAD:main; then
        git fetch --quiet origin main 2>/dev/null || true
        log "published $(git rev-parse --short HEAD) after backup tag $tag"
        exit 0
    fi
done
park "push rejected twice" 1
