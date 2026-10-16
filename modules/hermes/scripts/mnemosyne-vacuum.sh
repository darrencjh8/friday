#!/bin/bash
# Weekly Mnemosyne maintenance (no_agent script-only cron).
#
# 1. Integrity check and row counts of the Mnemosyne DB.
# 2. `hermes mnemosyne sleep --all-sessions`: consolidates old working memories
#    of every session. Auto-sleep only consolidates a session holding more than
#    sleep_threshold rows, so short sessions are never consolidated otherwise.
# 3. SQLite VACUUM of the Mnemosyne DB and the Hermes session DBs.
#
# Never deletes memories or sessions; session deletion stays owned by
# sessions.auto_prune/retention_days, and sessions older than 30 days are only
# counted. The image ships no sqlite3 CLI, so all DB work goes through Python's
# sqlite3 module. A VACUUM that cannot get the lock within the busy timeout is a
# reported skip (the DB is intact; next week retries). The script exits non-zero
# only when integrity is not ok or consolidation fails, which raises Hermes'
# cron error alert. Output is a Markdown table.
set -u

export HERMES_HOME="${HERMES_HOME:-/opt/data}"
export MNEMOSYNE_DIR="${MNEMOSYNE_DATA_DIR:-$HERMES_HOME/mnemosyne/data}"
export SESSION_MAX_AGE_DAYS="${SESSION_MAX_AGE_DAYS:-30}"
export MNEMOSYNE_VACUUM_BUSY_TIMEOUT="${MNEMOSYNE_VACUUM_BUSY_TIMEOUT:-30}"

HERMES_BIN=$(command -v hermes || echo /opt/hermes/.venv/bin/hermes)
export SLEEP_JSON="" SLEEP_RC=0
if [ -f "$MNEMOSYNE_DIR/mnemosyne.db" ]; then
    SLEEP_JSON=$("$HERMES_BIN" mnemosyne sleep --all-sessions 2>/dev/null)
    SLEEP_RC=$?
fi

exec python3 - <<'PY'
import glob, json, os, sqlite3, sys, time

home = os.environ["HERMES_HOME"]
mdb = os.path.join(os.environ["MNEMOSYNE_DIR"], "mnemosyne.db")
timeout = float(os.environ["MNEMOSYNE_VACUUM_BUSY_TIMEOUT"])
max_age = int(os.environ["SESSION_MAX_AGE_DAYS"])
rows, failed = [], False


def size(path):
    try:
        return f"{os.path.getsize(path) / 1048576:.1f} MB"
    except OSError:
        return "?"


def vacuum(path):
    before = size(path)
    try:
        conn = sqlite3.connect(path, timeout=timeout, isolation_level=None)
        conn.execute("VACUUM")
        conn.close()
        return f"{before} → {size(path)}"
    except sqlite3.OperationalError as error:
        if "locked" in str(error) or "busy" in str(error):
            return f"{before}, VACUUM skipped (busy)"
        return f"{before}, VACUUM failed: {error}"


if not os.path.exists(mdb):
    rows.append(("mnemosyne.db", "absent, nothing to do"))
else:
    try:
        conn = sqlite3.connect(f"file:{mdb}?mode=ro", uri=True, timeout=timeout)
        check = conn.execute("PRAGMA integrity_check").fetchone()[0]
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("working_memory", "episodic_memory") if t in tables}
        conn.close()
    except sqlite3.OperationalError as error:
        busy = "locked" in str(error) or "busy" in str(error)
        check, counts = ("skipped (busy)" if busy else f"unreadable: {error}"), {}
    except sqlite3.DatabaseError as error:
        check, counts = f"unreadable: {error}", {}
    rows.append(("integrity", check))
    failed |= check not in ("ok", "skipped (busy)")
    for table, n in counts.items():
        rows.append((table, n))

    try:
        sleep = json.loads(os.environ.get("SLEEP_JSON") or "{}")
    except ValueError:
        sleep = {}
    if os.environ.get("SLEEP_RC") != "0" or sleep.get("errors"):
        rows.append(("sleep", f"failed ({sleep.get('status', 'no result')})"))
        failed = True
    elif sleep.get("status") == "no_op":
        rows.append(("sleep", "nothing old enough to consolidate"))
    else:
        rows.append(("sleep", f"{sleep.get('items_consolidated', 0)} items from "
                              f"{sleep.get('sessions_consolidated', 0)} sessions"))
    if check == "ok":
        rows.append(("mnemosyne.db", vacuum(mdb)))

cutoff = time.time() - max_age * 86400
for db in [os.path.join(home, "state.db")] + sorted(glob.glob(os.path.join(home, "profiles/*/state.db"))):
    if not os.path.exists(db):
        continue
    name = os.path.relpath(db, home)
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=timeout)
        old = conn.execute("SELECT COUNT(*) FROM sessions WHERE COALESCE(last_activity_at, ended_at, started_at) < ?", (cutoff,)).fetchone()[0]
        conn.close()
    except sqlite3.DatabaseError:
        old = "?"
    rows.append((f"{name} sessions >{max_age}d", f"{old} (report only)"))
    rows.append((name, vacuum(db)))

print("🧹 Mnemosyne weekly maintenance")
print()
print("| Check | Result |")
print("|---|---|")
for key, value in rows:
    print(f"| {key} | {value} |")
sys.exit(1 if failed else 0)
PY
