#!/bin/sh
#
# Advance the Hermes container's own codex-router checkout.
#
# Dev-loop sessions inside the container drive the gate from their codex-router
# checkout (`codex/skills/dev-loop/scripts/loop.py`), so a checkout pinned to an
# old revision keeps running an old gate no matter what the reconciled skill roots
# hold. Measured 2026-09-25: /workspace/codex-router sat at 2e0fcfc, six commits
# behind origin/main, while the roots were current, so the deployed driver never
# reached a session (darren-openclaw#613).
#
# Two writers call this: the deploy, with the revision it checked out, and the boot
# hook, with no argument so it tracks origin/main and a recreated container heals
# itself.
#
# Usage: refresh-codex-router-checkout.sh [TARGET_REV]
#   TARGET_REV is any commit reachable from the fetched branch head. Without it the
#   script advances to the fetched head.
#
# Exit status: 0 when the checkout was advanced or deliberately left alone
# (absent, dirty, on another branch, detached, or already at the target). Non-zero
# when a clean checkout cannot reach the target, when another writer holds the lock
# past LOCK_WAIT_SECONDS, or when the fetch fails; the deploy counts any of those as
# a failure because they mean the environment disagrees with what was shipped.
#
# shellcheck shell=sh
set -eu

CHECKOUT=${CODEX_ROUTER_CHECKOUT:-/workspace/codex-router}
BRANCH=main
TARGET_REV=${1:-}
LOCK_WAIT_SECONDS=${CODEX_ROUTER_LOCK_WAIT_SECONDS:-120}

# `flock` takes seconds, so anything else would be reported as contention rather
# than as a bad setting.
case "$LOCK_WAIT_SECONDS" in
    ''|*[!0-9]*) LOCK_WAIT_SECONDS=120 ;;
esac
if [ "$LOCK_WAIT_SECONDS" -le 0 ]; then
    LOCK_WAIT_SECONDS=120
fi

if [ ! -d "$CHECKOUT/.git" ]; then
    echo "refresh-codex-router-checkout: no checkout at $CHECKOUT; skipping"
    exit 0
fi

# The short SHA for the skip notices, so a deploy log shows which revision stayed
# behind rather than only that something was skipped.
head_line() {
    git -C "$CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo unborn
}

# Writers serialize on a lock inside .git, so it is never untracked work. A hermes
# deploy recreates this container, which starts the boot hook on the same checkout
# while the deploy is still running this script.
if ! command -v flock >/dev/null 2>&1; then
    echo "refresh-codex-router-checkout: flock is required and missing; refusing to run unlocked" >&2
    exit 1
fi
exec 9>"$CHECKOUT/.git/codex-router-checkout.lock"
if ! flock -w "$LOCK_WAIT_SECONDS" 9; then
    echo "refresh-codex-router-checkout: another writer held $CHECKOUT for ${LOCK_WAIT_SECONDS}s; giving up" >&2
    exit 1
fi

cd "$CHECKOUT"

# Read the state inside the lock, so no other writer can move it under these checks.
# A dirty checkout, a session branch, or a detached HEAD all belong to someone else:
# skip them with a notice and never discard or rewrite their content.
# A failing `git status` is not an empty one: without this, a held index lock would
# read as "clean" and the run would fail later with a misleading divergence message.
status_out=$(git status --porcelain) || {
    echo "refresh-codex-router-checkout: $CHECKOUT: git status failed; leaving it alone" >&2
    exit 1
}
if [ -n "$status_out" ]; then
    echo "refresh-codex-router-checkout: $CHECKOUT is dirty; leaving it alone (HEAD $(head_line))"
    exit 0
fi
# The assignment form matters: on an unborn HEAD `rev-parse` prints HEAD *and*
# exits 128, so an `|| echo` inside the substitution would report "HEAD HEAD" and
# `set -eu` would abort before the comparison. Overwriting on failure keeps both
# the unborn and the detached case on the one notice below.
branch_name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || branch_name=HEAD
if [ "$branch_name" != "$BRANCH" ]; then
    echo "refresh-codex-router-checkout: $CHECKOUT is on '$branch_name', not $BRANCH; leaving it alone (HEAD $(head_line))"
    exit 0
fi

# The image's git has no credential helper, so one has to be supplied. Prefer the
# PAT the caller exports: both writers hold one (the boot hook exports GH_TOKEN,
# the deploy passes FRIDAY_PAT), while gh lives in the persisted volume that the
# deploy installs only *after* this gate, so a fetch that needs the gh binary
# deadlocks the deploy whenever that volume lost it (measured 2026-10-05: "gh: not
# found" -> checkout not advanced -> deploy failed -> the install step never ran).
# gh's helper stays as the fallback for a caller that exports no token; the token
# reaches the helper through the environment, never through the process arguments.
# The bound matters because the lock serializes writers, not time: a hung fetch
# would hold it and block the deploy's docker exec and the boot hook.
if [ -n "${GH_TOKEN:-}" ]; then
    # shellcheck disable=SC2016  # git expands $GH_TOKEN when it runs this helper, not now
    CREDENTIAL_HELPER='!f() { printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f'
else
    CREDENTIAL_HELPER='!gh auth git-credential'
fi
if ! timeout --kill-after=10 120 git -c "credential.helper=$CREDENTIAL_HELPER" fetch --quiet origin "$BRANCH"; then
    echo "refresh-codex-router-checkout: could not fetch origin $BRANCH" >&2
    exit 1
fi
# Read FETCH_HEAD once, while the lock still means this process is the only writer
# this script controls; re-reading it later would act on whatever a concurrent git
# command left there.
fetched=$(git rev-parse FETCH_HEAD)

if [ -n "$TARGET_REV" ]; then
    # Reachability from the fetched head is the contract, not local object
    # presence: a commit only this checkout holds must not be installed.
    if ! git merge-base --is-ancestor "$TARGET_REV" "$fetched" 2>/dev/null; then
        echo "refresh-codex-router-checkout: target $TARGET_REV is not on origin/$BRANCH" >&2
        exit 1
    fi
    # Boot can already have advanced past the revision a later deploy pins, and
    # that is the same end state: nothing to move.
    if git merge-base --is-ancestor "$TARGET_REV" HEAD 2>/dev/null; then
        echo "refresh-codex-router-checkout: $CHECKOUT already contains $TARGET_REV"
        echo "refresh-codex-router-checkout: $CHECKOUT is at $(head_line)"
        exit 0
    fi
    if ! git merge --ff-only --quiet "$TARGET_REV"; then
        echo "refresh-codex-router-checkout: $CHECKOUT cannot fast-forward to $TARGET_REV" >&2
        exit 1
    fi
else
    if ! git merge --ff-only --quiet "$fetched"; then
        echo "refresh-codex-router-checkout: $CHECKOUT cannot fast-forward to $fetched" >&2
        exit 1
    fi
fi

echo "refresh-codex-router-checkout: $CHECKOUT is at $(git rev-parse --short HEAD)"
