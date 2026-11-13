#!/bin/sh
#
# Publish Friday's one persona change for the day to the shared persona repo.
#
# The persona-reflection cron edits files in the persona clone ($PERSONA_DIR),
# then calls this with a one-line message. It follows the persona repo's own
# rules: one writer at a time, one change at a time, a backup tag of the last
# canonical state before every push, never a force-push, and a stop on a real
# conflict so the owner merges by hand.
#
# Refused, with the edit kept as a patch under $PENDING_DIR and the clone reset to
# origin/main so persona-sync keeps working:
# - a file other than SOUL.md, calendar.md or preferences.md changed;
# - SOUL.md does not gain an evolution log line naming Hermes;
# - a change was already published today (Asia/Singapore);
# - the rebase onto the other agent's newer commit conflicts.
#
# Exit status: 0 published or nothing to publish, 2 refused, 3 conflict,
# 1 any other failure (fetch, push).
#
# Usage: persona-commit.sh "<one-line message>"
#
# shellcheck shell=sh
set -eu

PERSONA_DIR=${PERSONA_DIR:-/workspace/friday-persona}
STATE_DIR=${PERSONA_STATE_DIR:-${HERMES_HOME:-/opt/data}/persona-reflection}
PENDING_DIR=$STATE_DIR/pending
MESSAGE=${1:-}
ALLOWED="SOUL.md calendar.md preferences.md"

log() { echo "persona-commit: $*"; }
[ -n "$MESSAGE" ] || { log "usage: persona-commit.sh \"<message>\""; exit 2; }
mkdir -p "$PENDING_DIR"
cd "$PERSONA_DIR"

AUTH_TOKEN=$(gh auth token 2>/dev/null) || AUTH_TOKEN=${GITHUB_TOKEN:-}
export AUTH_TOKEN
# shellcheck disable=SC2016  # git expands $AUTH_TOKEN when it runs the helper
HELPER='!f() { printf "username=x-access-token\npassword=%s\n" "$AUTH_TOKEN"; }; f'
g() { timeout 120 git -c "credential.helper=$HELPER" -c user.name="Friday (Hermes)" -c user.email="friday-hermes@users.noreply.github.com" "$@"; }

stamp=$(date -u +%Y%m%d-%H%M%S)
base=$(git rev-parse HEAD)
# Keep the edit, then put the clone back on origin/main, so nothing is lost and
# the next persona-sync is not blocked by a dirty clone.
park() {
    patch="$PENDING_DIR/$stamp.patch"
    git rebase --abort >/dev/null 2>&1 || true
    git add -A
    git diff --cached "$base" >"$patch" || true
    git reset --quiet --hard "@{u}"
    log "$1; the edit is kept at $patch and the clone is back on origin/main"
    exit "$2"
}

changed=$(git status --porcelain | cut -c4-)
[ -n "$changed" ] || { log "nothing changed; nothing to publish"; exit 0; }
for f in $changed; do
    case " $ALLOWED " in *" $f "*) ;; *) park "refused: $f may not be changed by Hermes" 2 ;; esac
done
if git diff --quiet -- SOUL.md || ! git diff -U0 -- SOUL.md | grep -q '^+- [0-9-]* *(Hermes)'; then
    park "refused: SOUL.md needs one new evolution log line '- YYYY-MM-DD (Hermes): ...'" 2
fi
today=$(TZ=Asia/Singapore date +%F)
[ "$(cat "$STATE_DIR/last-publish" 2>/dev/null || true)" != "$today" ] \
    || park "refused: a persona change was already published today" 2

g add -A
g commit --quiet -m "$MESSAGE (Hermes)"
for _ in 1 2; do
    g fetch --quiet origin main || { log "fetch failed"; park "not published" 1; }
    # Backup tag of the last canonical state, pushed before the change.
    tag="backup-$stamp-hermes-$(git rev-parse --short FETCH_HEAD)"
    g tag -f "$tag" FETCH_HEAD >/dev/null
    g push --quiet origin "refs/tags/$tag" || { log "could not push the backup tag"; park "not published" 1; }
    g rebase --quiet FETCH_HEAD >/dev/null 2>&1 || park "conflict: the other agent changed the same lines; the owner merges by hand" 3
    if g push --quiet origin HEAD:main; then
        echo "$today" >"$STATE_DIR/last-publish"
        git fetch --quiet origin main 2>/dev/null || true
        log "published $(git rev-parse --short HEAD) after backup tag $tag"
        "$(dirname "$0")/persona-sync.sh" || true
        exit 0
    fi
done
park "push rejected twice" 1
