#!/bin/bash
# Tests for modules/hermes/scripts/sync-codex-router-skills.sh — the single
# writer for codex-router-owned skills in the Hermes container.
# No `set -e`: an unexpected failure must print a FAIL line and let the rest of
# the suite run instead of aborting everything after it. The suite still exits
# non-zero, because the final `[[ "$fail" -eq 0 ]]` decides the status.
set -uo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC="$SCRIPT_DIR/../scripts/sync-codex-router-skills.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# run <source>  (isolated homes so nothing touches the real container)
run() {
    HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    sh "$SYNC" "$1"
}

fresh_fixture() {
    ROOT=$(mktemp -d "$TMPDIR/case.XXXXXX")
    SOURCE="$ROOT/source"
    PRIMARY="$ROOT/primary"
    SECONDARY="$ROOT/secondary"
    STATE="$ROOT/state"
    mkdir -p "$SOURCE/dev-loop/scripts" "$SOURCE/code-reviewer" "$SOURCE/not-a-skill"
    printf 'canonical dev-loop\n' > "$SOURCE/dev-loop/SKILL.md"
    printf 'loop v1\n' > "$SOURCE/dev-loop/scripts/loop.py"
    printf 'canonical code-reviewer\n' > "$SOURCE/code-reviewer/SKILL.md"
    printf 'ignore me\n' > "$SOURCE/not-a-skill/README.md"
    TARGETS=("$PRIMARY/skills" "$PRIMARY/.agents/skills" "$SECONDARY/.agents/skills")
}

echo "=== fresh sync reaches every root ==="
fresh_fixture
run "$SOURCE" >/dev/null
for target in "${TARGETS[@]}"; do
    if [[ -f "$target/dev-loop/scripts/loop.py" && -f "$target/code-reviewer/SKILL.md" ]]; then
        ok "synced canonical skills into $target"
    else
        nope "synced canonical skills into $target" "$(find "$target" -maxdepth 3 2>/dev/null | head)"
    fi
done

echo "=== non-skill directories are skipped ==="
if [[ ! -e "$PRIMARY/skills/not-a-skill" ]]; then
    ok "skipped a source directory without SKILL.md"
else
    nope "skipped a source directory without SKILL.md" "not-a-skill was copied"
fi

echo "=== idempotent rerun leaves no staging dirs ==="
run "$SOURCE" >/dev/null
if [[ -z "$(find "$PRIMARY" "$SECONDARY" -name '.*.staging.*' 2>/dev/null)" ]]; then
    ok "rerun left no staging directories"
else
    nope "rerun left no staging directories" "$(find "$PRIMARY" "$SECONDARY" -name '.*.staging.*')"
fi

echo "=== drift is replaced with the canonical bytes ==="
printf 'locally edited\n' > "$PRIMARY/skills/dev-loop/SKILL.md"
run "$SOURCE" >/dev/null
if [[ "$(cat "$PRIMARY/skills/dev-loop/SKILL.md")" == "canonical dev-loop" ]]; then
    ok "overwrote a drifted copy"
else
    nope "overwrote a drifted copy" "$(cat "$PRIMARY/skills/dev-loop/SKILL.md")"
fi

echo "=== a permission change in the source propagates ==="
printf 'loop v1\n' > "$SOURCE/dev-loop/scripts/loop.py"
chmod 755 "$SOURCE/dev-loop/scripts/loop.py"
chmod 700 "$SOURCE/dev-loop/scripts"
run "$SOURCE" >/dev/null
file_mode=$(stat -c '%a' "$PRIMARY/skills/dev-loop/scripts/loop.py")
dir_mode=$(stat -c '%a' "$PRIMARY/skills/dev-loop/scripts")
if [[ "$file_mode" == 755 && "$dir_mode" == 700 ]]; then
    ok "applied a source permission change to an identical tree (file and directory)"
else
    nope "applied a source permission change to an identical tree (file and directory)" \
        "file=$(stat -c '%a' "$PRIMARY/skills/dev-loop/scripts/loop.py" 2>/dev/null) dir=$dir_mode"
fi

echo "=== files dropped upstream are removed ==="
rm "$SOURCE/dev-loop/scripts/loop.py"
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/skills/dev-loop/scripts/loop.py" ]]; then
    ok "removed a file the source dropped"
else
    nope "removed a file the source dropped" "loop.py still present"
fi

echo "=== a symlink whose target drifted is reconciled ==="
# `diff -r` follows symlinks and compares target contents, so a link retargeted
# to a different file with identical bytes reads as equal, and the mode listing
# skips symlinks entirely. Without `--no-dereference` the runtime link points at
# the stale target forever.
fresh_fixture
printf 'same bytes\n' > "$SOURCE/dev-loop/t1"
printf 'same bytes\n' > "$SOURCE/dev-loop/t2"
ln -s t1 "$SOURCE/dev-loop/thing"
run "$SOURCE" >/dev/null
rm "$PRIMARY/skills/dev-loop/thing"
ln -s t2 "$PRIMARY/skills/dev-loop/thing"
run "$SOURCE" >/dev/null
if [[ "$(readlink "$PRIMARY/skills/dev-loop/thing")" == "t1" ]]; then
    ok "restored a symlink whose target drifted while the target bytes matched"
else
    nope "restored a symlink whose target drifted while the target bytes matched" \
        "thing -> $(readlink "$PRIMARY/skills/dev-loop/thing" 2>/dev/null)"
fi

echo "=== siblings the sync does not own are preserved ==="
mkdir -p "$PRIMARY/skills/hermes-troubleshooting"
printf 'openclaw-owned\n' > "$PRIMARY/skills/hermes-troubleshooting/SKILL.md"
run "$SOURCE" >/dev/null
if [[ "$(cat "$PRIMARY/skills/hermes-troubleshooting/SKILL.md")" == "openclaw-owned" ]]; then
    ok "preserved an openclaw-owned sibling skill"
else
    nope "preserved an openclaw-owned sibling skill" "sibling was modified"
fi

echo "=== opencode shadow roots are left alone and legacy backups are removed ==="
# The opencode CLI is gone, so nothing reads ~/.config/opencode/skills and the
# sync must no longer treat those paths as shadow roots. Content there is
# unrelated to this script and must survive untouched.
mkdir -p "$PRIMARY/.config/opencode/skills/dev-loop" \
         "$SECONDARY/.config/opencode/skills/code-reviewer" \
         "$PRIMARY/.config/opencode/skills/user-skill"
printf 'stale shadow\n' > "$PRIMARY/.config/opencode/skills/dev-loop/SKILL.md"
printf 'stale shadow\n' > "$SECONDARY/.config/opencode/skills/code-reviewer/SKILL.md"
printf 'user-owned\n' > "$PRIMARY/.config/opencode/skills/user-skill/SKILL.md"
# The merged installer writes the compatibility backup as a DIRECTORY
# (copytree); older runs left a single file. Both must be handled without
# aborting the run.
mkdir -p "$PRIMARY/skills/dev-loop.codex-router.bak"
printf 'stale dir backup\n' > "$PRIMARY/skills/dev-loop.codex-router.bak/SKILL.md"
printf 'stale\n' > "$SECONDARY/.agents/skills/code-reviewer.codex-router.bak"
# An unrelated user entry that merely carries the suffix must survive.
mkdir -p "$PRIMARY/skills/user-thing.codex-router.bak"
printf 'user-owned\n' > "$PRIMARY/skills/user-thing.codex-router.bak/SKILL.md"
run "$SOURCE" >/dev/null
if [[ -f "$PRIMARY/.config/opencode/skills/dev-loop/SKILL.md" \
      && -f "$SECONDARY/.config/opencode/skills/code-reviewer/SKILL.md" \
      && -f "$PRIMARY/.config/opencode/skills/user-skill/SKILL.md" ]]; then
    ok "left the retired opencode config roots untouched"
else
    nope "left the retired opencode config roots untouched" \
        "$(find "$PRIMARY/.config/opencode/skills" "$SECONDARY/.config/opencode/skills" 2>/dev/null)"
fi
if [[ ! -e "$PRIMARY/skills/dev-loop.codex-router.bak" \
      && ! -e "$SECONDARY/.agents/skills/code-reviewer.codex-router.bak" \
      && -f "$PRIMARY/skills/user-thing.codex-router.bak/SKILL.md" ]]; then
    ok "removed managed compatibility backups and kept an unrelated suffix entry"
else
    nope "removed managed compatibility backups and kept an unrelated suffix entry" \
        "$(find "$PRIMARY/skills" -maxdepth 1 -name '*.codex-router.bak' 2>/dev/null)"
fi

echo "=== manifest ledger is refreshed, not left claiming drift ==="
IDENTITY=$(python3 - "$PRIMARY/.agents/skills" <<'PY'
import hashlib, sys
print(hashlib.sha256(str(__import__("pathlib").Path(sys.argv[1]).resolve()).encode()).hexdigest()[:16])
PY
)
mkdir -p "$STATE/manifests/$IDENTITY"
cat > "$STATE/manifests/$IDENTITY/dev-loop.json" <<JSON
{
  "skill_name": "dev-loop",
  "canonical_source": "/old/source/dev-loop",
  "canonical_hash": "stale",
  "installed_path": "$PRIMARY/.agents/skills/dev-loop",
  "installed_hash": "stale",
  "managed_by": "codex-router"
}
JSON
run "$SOURCE" >/dev/null
if python3 - "$STATE/manifests/$IDENTITY/dev-loop.json" "$PRIMARY/.agents/skills/dev-loop" <<'PY'
import hashlib, json, pathlib, sys

record = json.loads(pathlib.Path(sys.argv[1]).read_text())
target = pathlib.Path(sys.argv[2])


def directory_hash(path):
    digest = hashlib.sha256()
    for file_path in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(file_path.relative_to(path).as_posix().encode() + b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


sys.exit(0 if record["installed_hash"] == directory_hash(target) else 1)
PY
then
    ok "refreshed the manifest installed_hash"
else
    nope "refreshed the manifest installed_hash" "ledger still records drift"
fi

echo "=== a whole skill dropped upstream is pruned ==="
printf 'stale backup\n' > "$PRIMARY/skills/code-reviewer.codex-router.bak"
rm -rf "$SOURCE/code-reviewer"
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/skills/code-reviewer" \
      && ! -e "$PRIMARY/.agents/skills/code-reviewer" \
      && ! -e "$SECONDARY/.agents/skills/code-reviewer" \
      && ! -e "$PRIMARY/skills/code-reviewer.codex-router.bak" ]]; then
    ok "pruned a retired skill and its compatibility backup from every root"
else
    nope "pruned a retired skill and its compatibility backup from every root" \
        "$(find "$PRIMARY/skills" "$PRIMARY/.agents/skills" "$SECONDARY/.agents/skills" -maxdepth 1 -name 'code-reviewer*' 2>/dev/null)"
fi

echo "=== a managed file without a trailing newline still prunes its last entry ==="
fresh_fixture
run "$SOURCE" >/dev/null
# Hand-edited state: no trailing newline after the final name. The last entry
# must still take part in the retirement sweep.
printf 'dev-loop\ncode-reviewer' > "$PRIMARY/.codex-router-managed-skills"
rm -rf "$SOURCE/code-reviewer"
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/skills/code-reviewer" \
      && ! -e "$PRIMARY/.agents/skills/code-reviewer" \
      && ! -e "$SECONDARY/.agents/skills/code-reviewer" ]]; then
    ok "pruned the last managed name when the file had no trailing newline"
else
    nope "pruned the last managed name when the file had no trailing newline" \
        "$(find "$PRIMARY" "$SECONDARY" -maxdepth 4 -name 'code-reviewer*' 2>/dev/null)"
fi

echo "=== stale staging litter is swept before the next run ==="
fresh_fixture
mkdir -p "$PRIMARY"
printf 'orphan\n' > "$PRIMARY/.codex-router-managed-skills.new.99999"
printf 'orphan\n' > "$PRIMARY/.codex-router-managed-skills.new.88888.tmp"
run "$SOURCE" >/dev/null
if [[ -z "$(find "$PRIMARY" -maxdepth 1 -name '*.new.*' 2>/dev/null)" \
      && -s "$PRIMARY/.codex-router-managed-skills" ]]; then
    ok "swept stale .new staging files and kept the current managed-name file"
else
    nope "swept stale .new staging files and kept the current managed-name file" \
        "$(find "$PRIMARY" -maxdepth 1 -name '*.new.*' 2>/dev/null)"
fi

echo "=== litter the sweep cannot remove is reported, not swallowed ==="
# `rm -f` can never remove a directory, so a staging or modes entry of that
# shape would fail on every run and never be cleaned up. The reconcile must
# still succeed, but that failure must not be discarded. Both sweep patterns are
# covered: a partial fix that reports one and swallows the other fails here.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-managed-skills.new.77777" \
         "$PRIMARY/.codex-router-modes.77777"
sweep_dir_rc=0
# Capture stderr alone: the boot hook keeps this breadcrumb only through its
# stderr redirect, so a report that moved to stdout must fail here. `2>&1
# >/dev/null` sends stderr to the captured stdout and the real stdout to the
# discard, in that order.
sweep_dir_err=$(run "$SOURCE" 2>&1 >/dev/null) || sweep_dir_rc=$?
if [[ "$sweep_dir_rc" -eq 0 \
      && "$sweep_dir_err" == *"could not sweep"*"codex-router-managed-skills.new.77777"* \
      && "$sweep_dir_err" == *"could not sweep"*"codex-router-modes.77777"* \
      && -d "$PRIMARY/.codex-router-managed-skills.new.77777" \
      && -d "$PRIMARY/.codex-router-modes.77777" \
      && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "reported unremovable staging and modes litter and still reconciled"
else
    nope "reported unremovable staging and modes litter and still reconciled" \
        "rc=$sweep_dir_rc err=$sweep_dir_err"
fi

echo "=== a busy lock fails closed, not silently ==="
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
echo $$ > "$PRIMARY/.codex-router-skills.lock.d/pid"
lock_rc=0
lock_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=1 \
    sh "$SYNC" "$SOURCE" 2>&1) || lock_rc=$?
rm -rf "$PRIMARY/.codex-router-skills.lock.d"
if [[ "$lock_rc" -ne 0 && "$lock_output" == *"could not acquire"* && ! -e "$PRIMARY/skills/dev-loop" ]]; then
    ok "a mkdir lock held by a live process exits non-zero without writing"
else
    nope "a mkdir lock held by a live process exits non-zero without writing" "rc=$lock_rc out=$lock_output"
fi

echo "=== a live flock holder blocks a second writer ==="
fresh_fixture
mkdir -p "$PRIMARY"
if command -v flock >/dev/null 2>&1; then
    ( flock -n 9 || exit 1; sleep 5 ) 9>"$PRIMARY/.codex-router-skills.lock" &
    holder=$!
    sleep 1
    flock_rc=0
    flock_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
        HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
        HERMES_MANIFEST_STATE_DIRS="$STATE" \
        HERMES_SKILL_LOCK_WAIT_SECONDS=1 \
        sh "$SYNC" "$SOURCE" 2>&1) || flock_rc=$?
    kill "$holder" 2>/dev/null || true
    wait "$holder" 2>/dev/null || true
    if [[ "$flock_rc" -ne 0 && "$flock_output" == *"could not acquire"* && ! -e "$PRIMARY/skills/dev-loop" ]]; then
        ok "a flock held by a live process exits non-zero without writing"
    else
        nope "a flock held by a live process exits non-zero without writing" "rc=$flock_rc out=$flock_output"
    fi
else
    ok "flock unavailable; flock case skipped"
fi

echo "=== the lock is released after a successful run ==="
fresh_fixture
run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/.codex-router-skills.lock.d" ]]; then
    ok "released the lock on exit"
else
    nope "released the lock on exit" "lock dir survived: $(find "$PRIMARY/.codex-router-skills.lock.d" 2>/dev/null)"
fi
# The default (flock) path never creates .lock.d, so exercise the fallback
# explicitly before asserting its release.
HERMES_SKILL_LOCK_MODE=mkdir run "$SOURCE" >/dev/null
if [[ ! -e "$PRIMARY/.codex-router-skills.lock.d" ]]; then
    ok "released the mkdir fallback lock on exit"
else
    nope "released the mkdir fallback lock on exit" \
        "$(find "$PRIMARY/.codex-router-skills.lock.d" 2>/dev/null)"
fi
# A second run must not stall on a lock the first run left behind.
if run "$SOURCE" >/dev/null; then
    ok "a second run acquires the released lock immediately"
else
    nope "a second run acquires the released lock immediately" "second run failed"
fi

echo "=== a lock left by a dead process is reclaimed ==="
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
# 4194305 is one past /proc/sys/kernel/pid_max (4194304), so no live pid can
# ever name it, and the reclaim path must clear the lock.
echo 4194305 > "$PRIMARY/.codex-router-skills.lock.d/pid"
stale_rc=0
stale_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=5 \
    sh "$SYNC" "$SOURCE" 2>&1) || stale_rc=$?
if [[ "$stale_rc" -eq 0 && -f "$PRIMARY/skills/dev-loop/SKILL.md" \
      && ! -e "$PRIMARY/.codex-router-skills.lock.d" ]]; then
    ok "reclaimed a fallback lock whose holder is gone"
else
    nope "reclaimed a fallback lock whose holder is gone" "rc=$stale_rc out=$stale_output"
fi

echo "=== a live lock is never reclaimed ==="
# The holder here is this test shell's own live pid, so `kill -0` succeeds and
# the lock is left alone for that reason. This pins the live-holder case, not
# the EPERM/`/proc`-hidden branch the script comments on: reaching that branch
# needs privilege to out-rank the holder's user or to hide /proc, neither of
# which the suite has.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
echo $$ > "$PRIMARY/.codex-router-skills.lock.d/pid"
ep_rc=0
ep_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=1 \
    sh "$SYNC" "$SOURCE" 2>&1) || ep_rc=$?
ep_pid=$(cat "$PRIMARY/.codex-router-skills.lock.d/pid" 2>/dev/null)
if [[ "$ep_rc" -ne 0 && "$ep_pid" == "$$" \
      && "$ep_output" == *"could not acquire"* ]]; then
    ok "left a live holder's lock in place instead of reclaiming it"
else
    nope "left a live holder's lock in place instead of reclaiming it" \
        "rc=$ep_rc pid=${ep_pid:-none} out=$ep_output"
fi
rm -rf "$PRIMARY/.codex-router-skills.lock.d"

echo "=== a corrupt pid file is reclaimed ==="
# A truncated write (`echo $$ > pid` failing on ENOSPC) leaves an empty file.
# `/proc//stat` resolves to `/proc/stat`, which is readable, so the empty pid
# must be handled before the /proc probe or the lock is stuck forever.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
: > "$PRIMARY/.codex-router-skills.lock.d/pid"
corrupt_rc=0
corrupt_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=5 \
    sh "$SYNC" "$SOURCE" 2>&1) || corrupt_rc=$?
if [[ "$corrupt_rc" -eq 0 && ! -e "$PRIMARY/.codex-router-skills.lock.d" \
      && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "reclaimed a lock whose pid file is empty"
else
    nope "reclaimed a lock whose pid file is empty" "rc=$corrupt_rc out=$corrupt_output"
fi

echo "=== a lock dir with no pid file is reclaimed ==="
# A holder killed between `mkdir` and writing its pid leaves an ownerless lock
# directory; without a reclaim the fallback stays wedged until a manual rm.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
nopid_rc=0
nopid_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=6 \
    sh "$SYNC" "$SOURCE" 2>&1) || nopid_rc=$?
if [[ "$nopid_rc" -eq 0 && ! -e "$PRIMARY/.codex-router-skills.lock.d" \
      && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "reclaimed a lock directory with no pid file"
else
    nope "reclaimed a lock directory with no pid file" "rc=$nopid_rc out=$nopid_output"
fi

echo "=== a padded pid file still names a live holder ==="
# A padded live pid must not be reclaimed. The whitespace strip is what lets the
# script see the embedded pid at all; the case that pins the strip is the padded
# dead pid below, since this padded live pid is refused by the non-digit branch
# even without it.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
printf ' %s \n' "$$" > "$PRIMARY/.codex-router-skills.lock.d/pid"
pad_rc=0
pad_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=1 \
    sh "$SYNC" "$SOURCE" 2>&1) || pad_rc=$?
pad_pid=$(cat "$PRIMARY/.codex-router-skills.lock.d/pid" 2>/dev/null)
if [[ "$pad_rc" -ne 0 && "$pad_pid" == " $$ " \
      && "$pad_output" == *"could not acquire"* ]]; then
    ok "refused to reclaim a whitespace-padded live pid"
else
    nope "refused to reclaim a whitespace-padded live pid" \
        "rc=$pad_rc pid=[${pad_pid:-none}] out=$pad_output"
fi
rm -rf "$PRIMARY/.codex-router-skills.lock.d"

echo "=== a padded dead pid is recognised as dead ==="
# This is the case that pins the whitespace strip: a padded *live* pid is left
# alone by the non-digit branch either way, but only a stripped dead pid can be
# probed and reclaimed, so removing the strip turns this into a timeout.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
printf ' 4194305 \n' > "$PRIMARY/.codex-router-skills.lock.d/pid"
pdead_rc=0
pdead_output=$(HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=5 \
    sh "$SYNC" "$SOURCE" 2>&1) || pdead_rc=$?
if [[ "$pdead_rc" -eq 0 && ! -e "$PRIMARY/.codex-router-skills.lock.d" \
      && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "reclaimed a whitespace-padded dead pid"
else
    nope "reclaimed a whitespace-padded dead pid" "rc=$pdead_rc out=$pdead_output"
fi

echo "=== the ownerless-lock debounce restarts for each new lock ==="
# The debounce must be re-armed per observation, not latched. Two ownerless
# locks are presented, the first at start and the second once the run has
# reclaimed the first. `sh -x` logs each arithmetic expansion's result, so the
# counter's trace separates the two behaviours exactly: a latched counter counts
# 0 1 2 3 4 before the second reclaim and stops (one value above the limit), a
# re-armed counter counts 0 1 2 3 then 0 1 2 3 again (two values below it).
# The second lock is supplied by the sleep shim below, so the case no longer
# depends on a background watcher winning a scheduling race.
fresh_fixture
mkdir -p "$PRIMARY/.codex-router-skills.lock.d"
# The second lock is presented deterministically: a PATH shim for `sleep`
# recreates the ownerless lock on the first sleep that observes it absent, which
# is exactly the sleep after the run's first reclaim and therefore immediately
# before the run's next acquire. No background watcher and no timing window:
# a loaded runner cannot lose this race (#539).
shim_dir="$ROOT/sleep-shim"
mkdir -p "$shim_dir"
cat > "$shim_dir/sleep" <<'SHIM'
#!/bin/sh
if [ ! -e "$SHIM_ONCE" ] && [ ! -d "$SHIM_LOCK" ]; then
    mkdir -p "$SHIM_LOCK" && : > "$SHIM_ONCE"
fi
# Absolute path on purpose: `command -v sleep` would find this shim again.
exec /bin/sleep "$@"
SHIM
chmod +x "$shim_dir/sleep"
dbg_once="$ROOT/dbg-second-lock"
dbg_rc=0
PATH="$shim_dir:$PATH" \
    SHIM_ONCE="$dbg_once" \
    SHIM_LOCK="$PRIMARY/.codex-router-skills.lock.d" \
    HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    HERMES_SKILL_LOCK_MODE=mkdir \
    HERMES_SKILL_LOCK_WAIT_SECONDS=20 \
    sh -x "$SYNC" "$SOURCE" >/dev/null 2>"$ROOT/trace" || dbg_rc=$?
dbg_trace=$(awk '/^\+ missing_pid=[0-9]+$/ {v=$0; sub(/.*=/, "", v); if (v == 0) z++; if (v + 0 > m) m = v + 0} END {print z + 0, m + 0}' \
    "$ROOT/trace" 2>/dev/null)
dbg_resets=${dbg_trace% *}
dbg_peak=${dbg_trace#* }
rm -rf "$PRIMARY/.codex-router-skills.lock.d"
# The counter must re-arm once per lock and its peak must be the debounce limit,
# so a latched counter (no reset after the first reclaim) and any change to the
# limit both fail here. One initial `0` plus one reset per lock is three zero
# entries, and a re-armed counter with a limit of three peaks at three (#545).
if [[ "$dbg_rc" -eq 0 && "$dbg_resets" -eq 3 && "$dbg_peak" -eq 3 && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "re-armed the ownerless-lock debounce for a later lock (${dbg_resets} resets, peak ${dbg_peak})"
else
    nope "re-armed the ownerless-lock debounce for a later lock" \
        "rc=$dbg_rc resets=${dbg_resets:-0} peak=${dbg_peak:-0}"
fi

# Not covered here, and not coverable on the CI runner: a preempted fallback
# writer whose cleanup must not delete its successor's lock (the `cat pid = $$`
# guard in the script's trap). Driving that end to end needs the writer to lose
# the lock while it is still alive, and the pid-file path only reclaims a lock
# the reconciler cannot prove live — which needs either privilege to out-rank
# the holder's user (so `kill -0` fails with EPERM) or the ability to make
# /proc/<pid>/stat unreadable. Neither is available in CI. The adjacent pieces
# are pinned instead: a live lock is left alone, a dead, padded-dead, or empty
# pid is reclaimed, and the ownerless-lock debounce re-arms per lock.
echo "=== an empty source never prunes the managed set ==="
fresh_fixture
run "$SOURCE" >/dev/null
rm -rf "$ROOT"/source/*
empty_rc=0
empty_output=$(run "$SOURCE" 2>&1) || empty_rc=$?
if [[ "$empty_rc" -ne 0 && "$empty_output" == *"refusing to prune"* \
      && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]]; then
    ok "an empty canonical source fails closed instead of deleting managed skills"
else
    nope "an empty canonical source fails closed instead of deleting managed skills" "rc=$empty_rc out=$empty_output"
fi

echo "=== a corrupt managed-name file cannot escape the roots ==="
fresh_fixture
mkdir -p "$PRIMARY"
printf '../escape\n' > "$PRIMARY/.codex-router-managed-skills"
mkdir -p "$ROOT/escape"
printf 'keep\n' > "$ROOT/escape/keep.txt"
run "$SOURCE" >/dev/null
if [[ -f "$ROOT/escape/keep.txt" ]]; then
    ok "refused a managed name that is not a single path segment"
else
    nope "refused a managed name that is not a single path segment" "escaped the managed roots"
fi

echo "=== the staged swap and reconcile run in one call ==="
fresh_fixture
mkdir -p "$ROOT/staged/dev-loop"
printf 'canonical dev-loop\n' > "$ROOT/staged/dev-loop/SKILL.md"
# Seed a ledger record under the isolated STATE dir. Without this the swapped
# run passes whether or not it honours HERMES_MANIFEST_STATE_DIRS, so the case
# would not cover the ledger isolation it claims to. The identity directory name
# is arbitrary: the reconciler globs manifests/*/*.json and never reads the hash.
SWAP_IDENTITY=$(python3 - "$PRIMARY/skills" <<'PY'
import hashlib, sys
print(hashlib.sha256(str(__import__("pathlib").Path(sys.argv[1]).resolve()).encode()).hexdigest()[:16])
PY
)
mkdir -p "$STATE/manifests/$SWAP_IDENTITY"
cat > "$STATE/manifests/$SWAP_IDENTITY/dev-loop.json" <<JSON
{
  "skill_name": "dev-loop",
  "canonical_source": "$ROOT/staged/dev-loop",
  "canonical_hash": "stale",
  "installed_path": "$PRIMARY/skills/dev-loop",
  "installed_hash": "stale",
  "managed_by": "codex-router"
}
JSON
if HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    HERMES_MANIFEST_STATE_DIRS="$STATE" \
    sh "$SYNC" "$ROOT/final" "$ROOT/staged" >/dev/null 2>&1 \
    && [[ -f "$ROOT/final/dev-loop/SKILL.md" ]] \
    && [[ ! -e "$ROOT/staged" ]] \
    && [[ -f "$PRIMARY/skills/dev-loop/SKILL.md" ]] \
    && [[ ! -e "$PRIMARY/.codex-router-skills.lock.d" ]]; then
    ok "swapped the staged tree, reconciled the roots, released the lock"
else
    nope "swapped the staged tree, reconciled the roots, released the lock" \
        "$(find "$ROOT" -maxdepth 3 2>/dev/null | head)"
fi
if python3 - "$STATE/manifests/$SWAP_IDENTITY/dev-loop.json" "$PRIMARY/skills/dev-loop" "$ROOT/final/dev-loop" <<'PY'
import json, pathlib, sys

record = json.loads(pathlib.Path(sys.argv[1]).read_text())
installed, canonical = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])

if record["installed_path"] != str(installed) or record["installed_hash"] == "stale":
    sys.exit(1)
if record["canonical_source"] != str(canonical) or record["canonical_hash"] == "stale":
    sys.exit(1)
sys.exit(0)
PY
then
    ok "the swapped run refreshed the ledger under the isolated state dir"
else
    nope "the swapped run refreshed the ledger under the isolated state dir" \
        "$(head -12 "$STATE/manifests/$SWAP_IDENTITY/dev-loop.json" 2>/dev/null)"
fi
if HERMES_SKILL_PRIMARY_HOME="$PRIMARY" \
    HERMES_SKILL_SECONDARY_HOME="$SECONDARY" \
    sh "$SYNC" "$ROOT/final2" "$ROOT/absent-staged" >/dev/null 2>&1; then
    nope "a missing staged tree fails closed" "exit 0"
else
    ok "a missing staged tree fails closed"
fi

echo "=== hermes-api is never installed, and an earlier copy is pruned ==="
fresh_fixture
mkdir -p "$SOURCE/hermes-api"
printf 'outside-only skill\n' > "$SOURCE/hermes-api/SKILL.md"
# Simulate a copy installed before the exclusion existed.
for target in "${TARGETS[@]}"; do mkdir -p "$target/hermes-api"; done
printf 'hermes-api\n' > "$PRIMARY/.codex-router-managed-skills"
run "$SOURCE" >/dev/null
leftover=$(for target in "${TARGETS[@]}"; do [[ -e "$target/hermes-api" ]] && echo "$target"; done)
if [[ -z "$leftover" && -f "$PRIMARY/skills/dev-loop/SKILL.md" ]] \
    && ! grep -qx hermes-api "$PRIMARY/.codex-router-managed-skills"; then
    ok "excluded hermes-api from every root and the managed list"
else
    nope "excluded hermes-api from every root and the managed list" "left in: $leftover"
fi

echo "=== absent source is a no-op ==="
if run "$TMPDIR/does-not-exist" >/dev/null 2>&1; then
    ok "absent source exits 0"
else
    nope "absent source exits 0" "non-zero exit"
fi

echo ""
echo "================================"
echo "  skills sync: $pass passed, $fail failed"
echo "================================"
[[ "$fail" -eq 0 ]]
