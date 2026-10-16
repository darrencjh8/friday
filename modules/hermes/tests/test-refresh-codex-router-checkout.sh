#!/bin/bash
# Contract + behaviour tests for scripts/refresh-codex-router-checkout.sh.
#
# Dev-loop sessions inside the Hermes container drive the gate from the
# container's own codex-router checkout (`codex/skills/dev-loop/scripts/loop.py`),
# so a checkout pinned to an old revision keeps running an old gate whatever the
# reconciled skill roots hold. Measured 2026-09-25: /workspace/codex-router sat at
# 2e0fcfc, six commits behind origin/main, while the skill roots were current.
#
# The refresh must therefore advance a clean checkout, never touch a dirty one (a
# live session owns it), skip an absent one, and fail only when a clean checkout
# cannot fast-forward. The behaviour cases run against real repositories, so the
# fast-forward and the dirty guard are executed rather than grepped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$SCRIPT_DIR/.."
SCRIPT="$MODULE_DIR/scripts/refresh-codex-router-checkout.sh"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"
SEED_SCRIPT="$MODULE_DIR/50-seed-defaults"

fail=0
ok() { printf 'PASS %s\n' "$1"; }
nope() { printf 'FAIL %s\n' "$1"; fail=1; }

echo "=== the script ships and parses ==="
[ -f "$SCRIPT" ] && ok "refresh script exists" || nope "refresh script exists"
[ -x "$SCRIPT" ] && ok "refresh script is executable" || nope "refresh script is executable"
sh -n "$SCRIPT" && ok "refresh script parses as POSIX sh" || nope "refresh script parses as POSIX sh"

echo "=== both writers call the refresh ==="
grep -Fq -- 'refresh-codex-router-checkout.sh' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs the refresh" || nope "deploy.sh runs the refresh"
grep -Fq -- 'docker exec -e CODEX_ROUTER_LOCK_WAIT_SECONDS=300 -e GH_TOKEN="${FRIDAY_PAT:-}" -u hermes hermes' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs it as the checkout's owner" || nope "deploy.sh runs it as the checkout's owner"
# The router-or-hermes scope itself is asserted against the new block in
# test_deploy_workflow_router.py: matching it here also matched the sibling
# skills block, so it passed before the block existed.
grep -Fq -- 'refresh-codex-router-checkout.sh' "$SEED_SCRIPT" \
    && ok "the boot hook refreshes the checkout" || nope "the boot hook refreshes the checkout"
grep -Eq "GH_TOKEN=\"\\\$\\(cat /run/secrets/friday_pat\\)\" su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout\.sh'" "$SEED_SCRIPT" \
    && ok "the boot hook scopes the PAT for the baked refresh" || nope "the boot hook scopes the PAT for the baked refresh"

echo "=== the fetch authenticates with the caller's PAT, not with gh ==="
# The deploy installs gh (and ntn) into the container's persisted volume only
# after this gate, so a fetch that needs the gh binary deadlocks the deploy
# whenever that volume lost it: measured 2026-10-05, every deploy from 22:33Z
# died with "gh: not found" -> checkout not advanced -> deploy failed -> the
# install step that would have provided gh never ran. Both callers hold the PAT
# (the boot hook exports it, the deploy receives FRIDAY_PAT), so the helper this
# script builds must hand git that token itself and keep gh only as a fallback.
helper=$(sed -n "s/.*CREDENTIAL_HELPER='\(![^']*\)'.*/\1/p" "$SCRIPT" | head -1)
if [ -z "$helper" ]; then
    nope "the refresh builds a credential helper"
else
    ok "the refresh builds a credential helper"
fi

# Run the built helper through git's credential-helper protocol, so a broken
# snippet fails here rather than in a deploy that already reported success.
helper_rc=0
helper_out=$(printf 'protocol=https\nhost=github.com\n\n' \
    | GH_TOKEN=token-from-caller sh -c "${helper#!}" get 2>&1) || helper_rc=$?
if [ "$helper_rc" -eq 0 ] && printf '%s\n' "$helper_out" | grep -qx 'password=token-from-caller'; then
    ok "the helper yields an exported GH_TOKEN as the password"
else
    nope "the helper yields an exported GH_TOKEN as the password (rc=$helper_rc): $helper_out"
fi
helper_user=$(printf '%s\n' "$helper_out" | sed -n 's/^username=//p')
if [ "$helper_user" = "x-access-token" ]; then
    ok "the helper names the token user GitHub expects"
else
    nope "the helper names the token user GitHub expects (got: $helper_user)"
fi

grep -Fq -- "!gh auth git-credential" "$SCRIPT" \
    && ok "gh's helper stays as the fallback when no PAT is exported" \
    || nope "gh's helper stays as the fallback when no PAT is exported"
grep -Fq -- '-e GH_TOKEN=' "$DEPLOY_SCRIPT" \
    && ok "the deploy exports the PAT into the container refresh" \
    || nope "the deploy exports the PAT into the container refresh"

echo "=== behaviour against real repositories ==="
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

origin="$sandbox/origin.git"
git init -q --bare "$origin"
git -C "$origin" symbolic-ref HEAD refs/heads/main
git init -q "$sandbox/seed"
(
    cd "$sandbox/seed"
    git symbolic-ref HEAD refs/heads/main
    printf 'one\n' > file.txt
    git add file.txt
    git commit -qm one
    git remote add origin "$origin"
    git push -q origin main
)
git clone -q "$origin" "$sandbox/checkout"
checkout="$sandbox/checkout"

advance_origin() {
    (
        cd "$sandbox/seed"
        printf '%s\n' "$1" >> file.txt
        git commit -qam "$1"
        git push -q origin main
    )
}

run_refresh() {
    # Always through `sh`, never the shebang: the deploy runs `sh <path>`, so a
    # bash-only body must fail here rather than in production.
    rc=0
    out=$(CODEX_ROUTER_CHECKOUT="$checkout" sh "$SCRIPT" "$@" 2>&1) || rc=$?
}

# The deploy decides success from this script's report, not from its exit code:
# four skip outcomes exit 0. Run a case's captured output through the deploy
# block's own classifier, so the two files are bound by execution in both
# directions rather than by a token restated here.
CLASSIFIER=$(sed -n '/grep -q "is at "; then/,/^      fi$/p' "$DEPLOY_SCRIPT")
if [ -z "$CLASSIFIER" ]; then
    nope "the deploy block's checkout classifier is extractable"
fi

classify() {
    GREEN="" YELLOW="" NC="" CHECKOUT_OUTPUT="$1" bash -c "$CLASSIFIER" 2>/dev/null
}

# $1 label, $2 captured output, $3 expected: success or alone.
expect_classified() {
    line=$(classify "$2")
    if [ "$3" = success ]; then
        case "$line" in *"is at this deploy's revision"*) ok "$1" ;; *) nope "$1 (classifier said: $line)" ;; esac
    else
        case "$line" in *"left alone"*) ok "$1" ;; *) nope "$1 (classifier said: $line)" ;; esac
    fi
}

# Already current: a no-op the deploy can run on every push.
before=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$before" ]; then
    ok "an up-to-date checkout is left alone and exits 0"
else
    nope "an up-to-date checkout is left alone and exits 0 (rc=$rc): $out"
fi

# Behind: fast-forward to the fetched head, and name the revision it landed on so
# a deploy log carries the SHA the container ended up at.
advance_origin second
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$(git -C "$sandbox/seed" rev-parse HEAD)" ] \
    && printf '%s' "$out" | grep -q "$(git -C "$checkout" rev-parse --short HEAD)"; then
    ok "a clean stale checkout fast-forwards to origin/main and prints the new short SHA"
else
    nope "a clean stale checkout fast-forwards to origin/main and prints the new short SHA (rc=$rc): $out"
fi
expect_classified "the deploy reports a real advance as success" "$out" success

# An explicit target wins over the fetched head: the deploy pins the revision it
# checked out. HEAD is deliberately behind the target and the target is
# deliberately behind the fetched head, so an implementation that only
# fast-forwards to FETCH_HEAD lands on the wrong commit and fails here.
advance_origin third
advance_origin fourth
fetched=$(git -C "$sandbox/seed" rev-parse HEAD)
target=$(git -C "$sandbox/seed" rev-parse HEAD~1)
run_refresh "$target"
checkout_head=$(git -C "$checkout" rev-parse HEAD)
if [ "$rc" -eq 0 ] && [ "$checkout_head" = "$target" ] && [ "$checkout_head" != "$fetched" ]; then
    ok "an explicit revision is checked out instead of the fetched head"
else
    nope "an explicit revision is checked out instead of the fetched head (rc=$rc, head=$checkout_head, target=$target, fetched=$fetched): $out"
fi

# A target HEAD already contains is satisfied, not forced: boot may already have
# advanced past the revision a later deploy pins.
contained=$(git -C "$checkout" rev-parse HEAD~1 2>/dev/null || true)
run_refresh "$contained"
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$checkout_head" ]; then
    ok "a target the checkout already contains is a no-op"
else
    nope "a target the checkout already contains is a no-op (rc=$rc): $out"
fi

# On a session's own branch the base checkout is not ours to move.
git -C "$checkout" checkout -q -b session-work
advance_origin fifth
branch_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$branch_head" ] \
    && [ "$(git -C "$checkout" rev-parse --abbrev-ref HEAD)" = "session-work" ]; then
    ok "a checkout on another branch is skipped"
else
    nope "a checkout on another branch is skipped (rc=$rc): $out"
fi
expect_classified "the deploy leaves a session branch alone" "$out" alone
git -C "$checkout" checkout -q main

# A detached HEAD is a skip, not a silent success with an empty branch name.
git -C "$checkout" checkout -q --detach
detached_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$detached_head" ] \
    && printf '%s' "$out" | grep -q "on 'HEAD'"; then
    ok "a detached HEAD is skipped and named"
else
    nope "a detached HEAD is skipped and named (rc=$rc): $out"
fi
git -C "$checkout" checkout -q main

# An object that exists locally but is not on the fetched branch is not a valid
# target: reachability is the contract, not local object presence.
git -C "$checkout" checkout -q -b side-work
printf 'side\n' > "$checkout/side.txt"
git -C "$checkout" add side.txt
git -C "$checkout" commit -qm side
side_commit=$(git -C "$checkout" rev-parse HEAD)
git -C "$checkout" checkout -q main
side_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh "$side_commit"
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$side_head" ] \
    && printf '%s' "$out" | grep -q "is not on origin/"; then
    ok "a target only reachable locally is refused without moving"
else
    nope "a target only reachable locally is refused without moving (rc=$rc): $out"
fi

# Dirty: a live session owns the checkout. Leave the bytes and the HEAD alone.
printf 'session work\n' >> "$checkout/file.txt"
advance_origin sixth
dirty_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$dirty_head" ] \
    && grep -q 'session work' "$checkout/file.txt"; then
    ok "a dirty checkout is skipped with its work intact"
else
    nope "a dirty checkout is skipped with its work intact (rc=$rc): $out"
fi
expect_classified "the deploy leaves a dirty checkout alone" "$out" alone
git -C "$checkout" checkout -q -- file.txt

# Diverged: clean but not a fast-forward. That is an environment bug, not a skip.
(
    cd "$checkout"
    printf 'local\n' > local.txt
    git add local.txt
    git commit -qm local
)
run_refresh
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "cannot fast-forward"; then
    ok "a clean diverged checkout fails loudly instead of being forced"
else
    nope "a clean diverged checkout fails loudly instead of being forced: $out"
fi

# A target the fetch did not bring is an error, not a silent no-op: the deploy's
# revision and the branch it fetched must agree.
diverged_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh "$(git -C "$sandbox/seed" rev-parse HEAD)"
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ] \
    && printf '%s' "$out" | grep -q "cannot fast-forward"; then
    ok "a diverged checkout refuses a reachable target without moving"
else
    nope "a diverged checkout refuses a reachable target without moving (rc=$rc): $out"
fi
run_refresh 0000000000000000000000000000000000000000
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ] \
    && printf '%s' "$out" | grep -q "is not on origin/"; then
    ok "a target missing from the fetched history fails without moving"
else
    nope "a target missing from the fetched history fails without moving (rc=$rc): $out"
fi

# An unreachable origin is the most likely production failure (network, gh
# credentials). It must fail loudly and move nothing.
git -C "$checkout" remote set-url origin "$sandbox/absent.git"
run_refresh
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ] \
    && printf '%s' "$out" | grep -q "could not fetch origin"; then
    ok "an unreachable origin fails the fetch without moving HEAD"
else
    nope "an unreachable origin fails the fetch without moving HEAD (rc=$rc): $out"
fi
git -C "$checkout" remote set-url origin "$origin"

# Busy lock: another writer is refreshing the same checkout. The deploy must see
# a failure rather than report success on a revision it never applied.
(
    flock -w 5 9
    sleep 5
) 9>"$checkout/.git/codex-router-checkout.lock" &
lock_holder=$!
sleep 1
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$checkout" CODEX_ROUTER_LOCK_WAIT_SECONDS=1 sh "$SCRIPT" 2>&1) || rc=$?
wait "$lock_holder" 2>/dev/null || true
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ] \
    && printf '%s' "$out" | grep -q "giving up"; then
    ok "a held lock fails the run and leaves every ref alone"
else
    nope "a held lock fails the run and leaves every ref alone (rc=$rc): $out"
fi

# A non-integer lock bound falls back to the default instead of being handed to
# flock, so a typo cannot turn a free lock into a failed deploy. Its own checkout,
# because the shared one is deliberately diverged by this point.
git clone -q "$origin" "$sandbox/lockval"
advance_origin seventh
lockval_head=$(git -C "$sandbox/lockval" rev-parse HEAD)
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$sandbox/lockval" CODEX_ROUTER_LOCK_WAIT_SECONDS=soon sh "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && [ "$(git -C "$sandbox/lockval" rev-parse HEAD)" != "$lockval_head" ]; then
    ok "a non-integer lock bound falls back to the default and still advances"
else
    nope "a non-integer lock bound falls back to the default and still advances (rc=$rc): $out"
fi

# Unborn: a fresh `git init` has no commit, and `git rev-parse --abbrev-ref HEAD`
# exits 128 there, so the script must notice and skip instead of aborting.
git init -q "$sandbox/unborn"
git -C "$sandbox/unborn" symbolic-ref HEAD refs/heads/main
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$sandbox/unborn" CODEX_ROUTER_LOCK_WAIT_SECONDS=1 sh "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "on 'HEAD'"; then
    ok "an unborn checkout is skipped without aborting"
else
    nope "an unborn checkout is skipped without aborting (rc=$rc): $out"
fi
expect_classified "the deploy leaves an unborn checkout alone" "$out" alone

# Absent: a container that has not created the checkout yet is not an error.
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$sandbox/absent" CODEX_ROUTER_LOCK_WAIT_SECONDS=1 sh "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "an absent checkout is skipped and exits 0"
else
    nope "an absent checkout is skipped and exits 0 (rc=$rc): $out"
fi
expect_classified "the deploy leaves an absent checkout alone" "$out" alone

exit "$fail"
