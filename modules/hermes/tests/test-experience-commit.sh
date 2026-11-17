#!/bin/bash
# experience-commit.sh publishes Hermes's changes to the experience wiki in the
# shared persona repo: only under experience/, raw evidence never rewritten, the
# log only appended, after the personal-information gate and a backup tag, never
# force-pushed. Refused or conflicting edits are parked and the clone reset.
set -euo pipefail

GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo "FAIL: $1 — $2"; fail=$((fail+1)); }

SCRIPTS="$(cd "$(dirname "$0")" && pwd)/../scripts"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export PERSONA_DIR="$TMPDIR/clone" PERSONA_STATE_DIR="$TMPDIR/state"
export JEV_API_KEY=test JEV_ENDPOINT="file://$TMPDIR/jev.json"
jev() { printf '{"answers":{"verdict":{"choice":"%s","confidence":0.9,"probabilities":{"a":0.9,"b":0.05}}}}' "$1" >"$TMPDIR/jev.json"; }
jev clean
ORIGIN="$TMPDIR/origin.git"
W=experience/wiki

git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$TMPDIR/seed"
mkdir -p "$TMPDIR/seed/$W/tooling" "$TMPDIR/seed/experience/raw/tools"
printf '# SOUL\n' >"$TMPDIR/seed/SOUL.md"
printf '# Log\n## [2026-11-16] ingest | seed\n' >"$TMPDIR/seed/$W/log.md"
printf 'Prefer gh.\n' >"$TMPDIR/seed/$W/tooling/gh.md"
printf 'excerpt\n' >"$TMPDIR/seed/experience/raw/tools/2026-11-16-tools.md"
git -C "$TMPDIR/seed" add -A && git -C "$TMPDIR/seed" commit -qm seed && git -C "$TMPDIR/seed" push -q origin main
git clone -q "$ORIGIN" "$PERSONA_DIR"

run() { bash "$SCRIPTS/experience-commit.sh" "$@" >"$TMPDIR/out" 2>&1; }
clean() { [ -z "$(git -C "$PERSONA_DIR" status --porcelain)" ]; }
origin_has() { git -C "$ORIGIN" show "main:$1" 2>/dev/null | grep -qxF -- "$2"; }
refused() { # $1 test name, $2 expected exit
    set +e; run "case"; rc=$?; set -e
    [ "$rc" = "$2" ] && clean && ls "$TMPDIR"/state/pending/*.patch >/dev/null 2>&1 \
        && ok "$1" || nope "$1" "rc=$rc $(cat "$TMPDIR/out")"
    rm -rf "$TMPDIR/state/pending"
}

echo "=== refusals keep the edit and reset the clone ==="
printf '# SOUL\nnew\n' >"$PERSONA_DIR/SOUL.md"; refused "test_outside_experience" 2
printf 'rewritten\n' >"$PERSONA_DIR/experience/raw/tools/2026-11-16-tools.md"; refused "test_raw_edit" 2
rm "$PERSONA_DIR/experience/raw/tools/2026-11-16-tools.md"; refused "test_raw_delete" 2
printf '# Log\n' >"$PERSONA_DIR/$W/log.md"; refused "test_log_not_append" 2
printf 'Prefer gh. Mail friend@corp.test\n' >"$PERSONA_DIR/$W/tooling/gh.md"; refused "test_gate_pattern" 2
jev personal; printf 'Prefer gh CLI.\n' >"$PERSONA_DIR/$W/tooling/gh.md"; refused "test_gate_jev" 2
jev clean

echo "=== an allowed change is published after a backup tag ==="
mkdir -p "$PERSONA_DIR/$W/ci-testing"
printf 'Never run full suites locally.\n' >"$PERSONA_DIR/$W/ci-testing/suites.md"
printf 'new excerpt\n' >"$PERSONA_DIR/experience/raw/tools/2026-11-17-tools.md"
printf '## [2026-11-17] ingest | suites\n' >>"$PERSONA_DIR/$W/log.md"
run "Add the local test-suite rule" && clean && ok "an allowed change exits 0" || nope "test_publish" "$(cat "$TMPDIR/out")"
origin_has "$W/ci-testing/suites.md" 'Never run full suites locally.' && origin_has "$W/log.md" '## [2026-11-17] ingest | suites' \
    && ok "origin has the new page and the log entry" || nope "test_origin_updated" "$(git -C "$ORIGIN" log --oneline -3)"
[ "$(git -C "$ORIGIN" tag -l 'backup-*' | wc -l)" = 1 ] && ok "a backup tag was pushed first" || nope "test_backup_tag" "$(git -C "$ORIGIN" tag -l)"
git -C "$ORIGIN" log -1 --format=%s main | grep -qx 'Add the local test-suite rule (Hermes)' && ok "the commit names Hermes" || nope "test_message" "$(git -C "$ORIGIN" log -1 --format=%s main)"

echo "=== no daily cap ==="
printf 'Prefer gh CLI over MCP.\n' >"$PERSONA_DIR/$W/tooling/gh.md"
run "Second change today" && origin_has "$W/tooling/gh.md" 'Prefer gh CLI over MCP.' && ok "a second change the same day publishes" \
    || nope "test_no_cap" "$(cat "$TMPDIR/out")"

echo "=== the other agent pushed first ==="
git -C "$TMPDIR/seed" pull -q origin main
printf 'Use gh.\n' >"$TMPDIR/seed/$W/tooling/gh.md"
git -C "$TMPDIR/seed" commit -qam other && git -C "$TMPDIR/seed" push -q origin main
printf 'Use the gh CLI.\n' >"$PERSONA_DIR/$W/tooling/gh.md"
refused "test_conflict_stops" 3
origin_has "$W/tooling/gh.md" 'Use gh.' && ok "the other agent's line is kept" || nope "test_conflict_theirs" "$(git -C "$ORIGIN" show main:$W/tooling/gh.md)"

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
