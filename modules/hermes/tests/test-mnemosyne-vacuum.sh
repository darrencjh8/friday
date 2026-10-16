#!/bin/bash
# Tests mnemosyne-vacuum.sh. The Hermes image ships no sqlite3 CLI, so a PATH
# shim makes any call to it fail loudly: the script must use Python's sqlite3.
# `hermes` is a PATH shim too, recording the consolidation call it receives.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VACUUM_SCRIPT="$SCRIPT_DIR/../scripts/mnemosyne-vacuum.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

BIN="$TMPDIR/bin"
mkdir -p "$BIN"
cat > "$BIN/sqlite3" <<'SH'
#!/bin/sh
echo "sqlite3 CLI must not be used" >&2
exit 127
SH
cat > "$BIN/hermes" <<'SH'
#!/bin/sh
echo "$*" >> "$HERMES_CALLS"
if [ -n "${HERMES_SLEEP_FAIL:-}" ]; then echo '{"status": "error", "errors": 1}'; exit 1; fi
echo '{"status": "ok", "sessions_consolidated": 2, "items_consolidated": 7, "errors": 0}'
SH
chmod +x "$BIN/sqlite3" "$BIN/hermes"

make_home() {
    local home="$1"
    mkdir -p "$home/mnemosyne/data"
    python3 - "$home" <<'PY'
import sqlite3, sys
home = sys.argv[1]
c = sqlite3.connect(f"{home}/mnemosyne/data/mnemosyne.db")
c.executescript("CREATE TABLE working_memory(id INTEGER); INSERT INTO working_memory VALUES(1),(2);"
                "CREATE TABLE episodic_memory(id INTEGER);")
c.commit(); c.close()
s = sqlite3.connect(f"{home}/state.db")
s.executescript("CREATE TABLE sessions(id INTEGER, started_at REAL, ended_at REAL, last_activity_at REAL);"
                "INSERT INTO sessions VALUES(1, 0, 0, 0), (2, 0, NULL, strftime('%s','now'));")
s.commit(); s.close()
PY
}

run() {
    local home="$1"; shift
    env PATH="$BIN:$PATH" HERMES_HOME="$home" MNEMOSYNE_DATA_DIR="$home/mnemosyne/data" \
        HERMES_CALLS="$home/calls" "$@" bash "$VACUUM_SCRIPT" 2>&1
}

echo "=== absent DBs ==="
out=$(run "$TMPDIR/empty") && ok "absent DBs exit 0" || nope "absent DBs exit" "non-zero"
echo "$out" | grep -q "absent" && ok "absent mnemosyne reported" || nope "absent report" "$out"

echo "=== healthy DBs ==="
make_home "$TMPDIR/home"
out=$(run "$TMPDIR/home") && ok "healthy exit 0" || nope "healthy exit" "$out"
echo "$out" | grep -q "CLI must not be used" && nope "no sqlite3 CLI" "CLI called" || ok "no sqlite3 CLI"
echo "$out" | grep -qE '^\| integrity +\| ok' && ok "integrity row ok" || nope "integrity row" "$out"
echo "$out" | grep -qE '^\| working_memory +\| 2 ' && ok "working_memory count" || nope "working_memory" "$out"
echo "$out" | grep -qE '^\| sleep +\| 7 items from 2 sessions' && ok "sleep summary" || nope "sleep summary" "$out"
echo "$out" | grep -qE '^\| state.db sessions >30d +\| 1 ' && ok "old sessions counted" || nope "old sessions" "$out"
grep -qx "mnemosyne sleep --all-sessions" "$TMPDIR/home/calls" && ok "consolidates all sessions" \
    || nope "sleep call" "$(cat "$TMPDIR/home/calls" 2>/dev/null)"
echo "$out" | grep -qiE "delete|drop table" && nope "never deletes" "destructive word" || ok "never deletes"

echo "=== sleep failure ==="
make_home "$TMPDIR/sleepfail"
if out=$(run "$TMPDIR/sleepfail" HERMES_SLEEP_FAIL=1); then nope "sleep failure exits non-zero" "exit 0"; else ok "sleep failure exits non-zero"; fi
echo "$out" | grep -qE '^\| sleep +\| failed' && ok "sleep failure reported" || nope "sleep failure row" "$out"

echo "=== busy database ==="
make_home "$TMPDIR/busy"
python3 - "$TMPDIR/busy/mnemosyne/data/mnemosyne.db" "$TMPDIR/busy/locked" <<'PY' &
import sqlite3, sys, time, pathlib
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute("BEGIN EXCLUSIVE")
pathlib.Path(sys.argv[2]).touch()
time.sleep(6)
PY
holder=$!
for _ in $(seq 50); do [ -f "$TMPDIR/busy/locked" ] && break; sleep 0.1; done
out=$(run "$TMPDIR/busy" MNEMOSYNE_VACUUM_BUSY_TIMEOUT=1) && ok "busy exits 0" || nope "busy exit" "$out"
echo "$out" | grep -q "skipped (busy)" && ok "busy DB skipped and reported" || nope "busy report" "$out"
wait "$holder" || true

echo "=== corrupt database ==="
mkdir -p "$TMPDIR/corrupt/mnemosyne/data"
head -c 8192 /dev/urandom > "$TMPDIR/corrupt/mnemosyne/data/mnemosyne.db"
if out=$(run "$TMPDIR/corrupt"); then nope "corrupt exits non-zero" "exit 0"; else ok "corrupt exits non-zero"; fi
echo "$out" | grep -qE '^\| integrity +\| ' && ! echo "$out" | grep -qE '^\| integrity +\| ok' \
    && ok "corrupt integrity reported" || nope "corrupt integrity row" "$out"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
