#!/bin/bash
# persona-commit.sh publishes at most one allowed persona change a day, after a
# backup tag, never force-pushes, and parks refused or conflicting edits so the
# clone stays clean. The last case is the Phase 3 round trip: a published change
# reaches a fresh clone made by persona-sync.sh.
set -euo pipefail

GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo "FAIL: $1 — $2"; fail=$((fail+1)); }

SCRIPTS="$(cd "$(dirname "$0")" && pwd)/../scripts"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export PERSONA_DIR="$TMPDIR/clone" PERSONA_STATE_DIR="$TMPDIR/state" SOUL_PATH="$TMPDIR/SOUL.md"
ORIGIN="$TMPDIR/origin.git"
LOG='- 2026-11-14 (Hermes): likes rainy-day cafes now'

git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$TMPDIR/seed"
printf '# SOUL\nInterests: reading.\n\nEvolution log:\n- 2026-11-13: seeded\n' >"$TMPDIR/seed/SOUL.md"
printf 'Mon: gym\n' >"$TMPDIR/seed/calendar.md"
printf 'pink\n' >"$TMPDIR/seed/preferences.md"
printf 'look\n' >"$TMPDIR/seed/IDENTITY.md"
git -C "$TMPDIR/seed" add -A && git -C "$TMPDIR/seed" commit -qm seed && git -C "$TMPDIR/seed" push -q origin main
git clone -q "$ORIGIN" "$PERSONA_DIR"

run() { bash "$SCRIPTS/persona-commit.sh" "$@" >"$TMPDIR/out" 2>&1; }
clean() { [ -z "$(git -C "$PERSONA_DIR" status --porcelain)" ]; }
origin_has() { git -C "$ORIGIN" show "main:$1" | grep -qxF -- "$2"; }
other_agent() { # the other agent publishes a change to one file
    git -C "$TMPDIR/seed" pull -q origin main
    printf '%s\n' "$2" >"$TMPDIR/seed/$1"
    git -C "$TMPDIR/seed" commit -qam other && git -C "$TMPDIR/seed" push -q origin main
}

echo "=== refusals keep the edit and reset the clone ==="
printf 'new look\n' >"$PERSONA_DIR/IDENTITY.md"
printf '%s\n' "$LOG" >>"$PERSONA_DIR/SOUL.md"
set +e; run "edit look"; rc=$?; set -e
[ "$rc" = 2 ] && clean && ok "an IDENTITY.md edit is refused and the clone reset" || nope "test_identity_refused" "rc=$rc $(cat "$TMPDIR/out")"
grep -q 'new look' "$TMPDIR"/state/pending/*.patch && ok "the refused edit is kept as a patch" || nope "test_patch_kept" "no patch"

printf 'Mon: pilates\n' >"$PERSONA_DIR/calendar.md"
set +e; run "no log"; rc=$?; set -e
[ "$rc" = 2 ] && clean && ok "a change without an evolution log line is refused" || nope "test_log_required" "rc=$rc $(cat "$TMPDIR/out")"

echo "=== an allowed change is published after a backup tag ==="
printf 'Mon: pilates\n' >"$PERSONA_DIR/calendar.md"
printf '%s\n' "$LOG" >>"$PERSONA_DIR/SOUL.md"
run "Monday is pilates now" && ok "an allowed change exits 0" || nope "test_publish" "$(cat "$TMPDIR/out")"
origin_has calendar.md 'Mon: pilates' && origin_has SOUL.md "$LOG" && ok "origin has the change and its log line" \
    || nope "test_origin_updated" "$(git -C "$ORIGIN" log --oneline -3)"
[ "$(git -C "$ORIGIN" tag -l 'backup-*' | wc -l)" = 1 ] && ok "a backup tag was pushed first" || nope "test_backup_tag" "$(git -C "$ORIGIN" tag -l)"

echo "=== one change a day ==="
printf 'yellow\n' >"$PERSONA_DIR/preferences.md"
printf '%s\n' '- 2026-11-14 (Hermes): second' >>"$PERSONA_DIR/SOUL.md"
set +e; run "second"; rc=$?; set -e
[ "$rc" = 2 ] && clean && ! origin_has preferences.md yellow && ok "a second change the same day is refused" \
    || nope "test_once_a_day" "rc=$rc $(cat "$TMPDIR/out")"
rm -f "$PERSONA_STATE_DIR/last-publish"

echo "=== the other agent pushed first ==="
other_agent preferences.md 'pastel'
printf 'Tue: swim\n' >>"$PERSONA_DIR/calendar.md"
printf '%s\n' '- 2026-11-15 (Hermes): Tuesday swim' >>"$PERSONA_DIR/SOUL.md"
run "Tuesday swim" && origin_has preferences.md pastel && origin_has calendar.md 'Tue: swim' \
    && ok "different lines: both changes are kept" || nope "test_rebase_both_kept" "$(cat "$TMPDIR/out")"
rm -f "$PERSONA_STATE_DIR/last-publish"

other_agent calendar.md 'Mon: yoga'
git -C "$PERSONA_DIR" pull -q 2>/dev/null || true
git -C "$PERSONA_DIR" reset -q --hard HEAD~1
printf 'Mon: boxing\n' >"$PERSONA_DIR/calendar.md"
printf '%s\n' '- 2026-11-16 (Hermes): boxing' >>"$PERSONA_DIR/SOUL.md"
set +e; run "boxing"; rc=$?; set -e
[ "$rc" = 3 ] && clean && origin_has calendar.md 'Mon: yoga' && ok "same lines: stop, keep theirs, park ours" \
    || nope "test_conflict_stops" "rc=$rc $(cat "$TMPDIR/out")"

echo "=== round trip: a fresh volume sees the published change ==="
PERSONA_DIR="$TMPDIR/fresh" PERSONA_REPO_URL="$ORIGIN" bash "$SCRIPTS/persona-sync.sh" >/dev/null 2>&1 || true
grep -qxF -- '- 2026-11-15 (Hermes): Tuesday swim' "$TMPDIR/fresh/SOUL.md" && ok "a fresh clone has Hermes's change" || nope "test_round_trip" "$(cat "$TMPDIR/fresh/SOUL.md" 2>&1)"

echo "=== the reflection context ==="
export PERSONA_TARGET="$TMPDIR/target.md" PERSONA_REPO_URL="$ORIGIN"
rm -f "$PERSONA_STATE_DIR/last-publish"
out=$(bash "$SCRIPTS/persona-reflection.sh" 2>/dev/null)
grep -q '^Today: ' <<<"$out" && grep -q '(Hermes): Tuesday swim' <<<"$out" && grep -q '(none yet)' <<<"$out" \
    && ok "context has the date, the log and the target" || nope "test_context" "$out"
TZ=Asia/Singapore date +%F >"$PERSONA_STATE_DIR/last-publish"
[ -z "$(bash "$SCRIPTS/persona-reflection.sh" 2>/dev/null)" ] && ok "no context once a change was published today" \
    || nope "test_context_skips" "printed output"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
