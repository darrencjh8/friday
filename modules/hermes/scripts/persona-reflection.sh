#!/bin/sh
#
# Pre-run context for the persona-reflection cron. Pulls the persona repo first,
# so the reflection reads what the other agent last published, then prints the
# date, the persona repo revision, the last evolution log lines, Hermes's own
# current target, and any edit parked by persona-commit.sh. The cron injects this
# into the job prompt. Prints nothing (the run is skipped) once a change was
# already published today.
#
# shellcheck shell=sh
set -eu

PERSONA_DIR=${PERSONA_DIR:-/workspace/friday-persona}
STATE_DIR=${PERSONA_STATE_DIR:-${HERMES_HOME:-/opt/data}/persona-reflection}
TARGET=${PERSONA_TARGET:-${HERMES_HOME:-/opt/data}/memories/topics/persona-target.md}
today=$(TZ=Asia/Singapore date +%F)

[ "$(cat "$STATE_DIR/last-publish" 2>/dev/null || true)" != "$today" ] || exit 0
"$(dirname "$0")/persona-sync.sh" >&2 || true
[ -f "$PERSONA_DIR/SOUL.md" ] || { echo "ALERT: no persona clone at $PERSONA_DIR; skip the reflection"; exit 0; }

echo "Today: $today (Asia/Singapore)"
echo "Persona repo: $PERSONA_DIR at $(git -C "$PERSONA_DIR" rev-parse --short HEAD)"
echo "Last evolution log lines:"
grep '^- [0-9]' "$PERSONA_DIR/SOUL.md" | tail -n 5 || echo "(none)"
echo "Your current target ($TARGET):"
cat "$TARGET" 2>/dev/null || echo "(none yet)"
parked=$(find "$STATE_DIR/pending" -name "*.patch" 2>/dev/null | sort | tail -n 3)
[ -z "$parked" ] || echo "Parked edits waiting for the owner: $parked"
