# Advance the Hermes container's codex-router checkout

Issue: [#613](https://github.com/darrencjh8/friday/issues/613)

## Context

The Hermes container keeps its own codex-router checkout at `/workspace/codex-router`,
and dev-loop sessions drive the gate from **that** copy
(`python3 /workspace/codex-router/codex/skills/dev-loop/scripts/loop.py`). The
codex-router reconciler only writes the skill roots, so the checkout can sit at an
old revision while the roots are current.

Measured read-only on production Hermes, 2026-09-25 (the defect evidence; a reviewer
cannot re-run it, and the committed RED below only proves the guard was absent at
base, so this measurement is what the change is justified by):

- checkout `HEAD` = `2e0fcfc` (#122), 6 commits behind `origin/main`; its
  `state.py` is `41bd2f9c…`, state schema **3**
- the three reconciled roots hold canonical `c80dfb8` bytes (`state.py`
  `1f1c9618…`, schema **5**), verified per-file and by the installer's directory hash
- `/opt/data/state.db`: the container checkout's `loop.py` path appears in 895
  message rows, latest `2026-09-25T01:58Z`; the shipped skill copy in 13 rows,
  latest `2026-09-21T13:55Z`
- the five parked dev-loop states in `/workspace/issue-*` are schema 3, the
  generation of that checkout
- the checkout's remote is `https://github.com/darrencjh8/codex-router.git`, owned
  by the container's `hermes` user, whose git has no credential helper; gh is
  authenticated there through the boot hook's scoped `GH_TOKEN`, and
  `git -c credential.helper='!gh auth git-credential' ls-remote origin main`
  returns `c80dfb8`. Because that helper only runs for an HTTPS remote, the fetch
  depends on the remote staying HTTPS — a `git://` or `file://` remote would need
  no credentials, but a rewritten one could break it.

So a production dev-loop run executes a driver that predates #140, and the P0
retry-budget fix (#153) never reaches it.

## Change

### 1. New `modules/hermes/scripts/refresh-codex-router-checkout.sh`

One writer for the checkout. The deploy runs it as `sh <path>`, the boot hook execs
it, and the suite runs it as `sh "$SCRIPT"`, so the file is POSIX shell: its first
line is `#!/bin/sh`, it sets `set -eu`, and it carries `# shellcheck shell=sh` like
the skill reconciler. A bash-only body must not be able to pass the suite and then
fail a production deploy under dash.

Inputs and interface, exactly:

- `CHECKOUT=${CODEX_ROUTER_CHECKOUT:-/workspace/codex-router}` — the path override
  the behaviour suite drives the script through.
- `BRANCH=main` — a literal, not a knob: neither call site sets it and no test
  exercises another value, so a configurable branch would be untested flexibility.
- `LOCK_WAIT_SECONDS=${CODEX_ROUTER_LOCK_WAIT_SECONDS:-120}` — the lock bound. A
  value that is not a positive integer falls back to the default rather than being
  passed to `flock`, whose own failure would be reported as contention. `flock` is
  assumed present (the image and CI both have it, and the sibling reconciler
  already relies on it); a missing `flock` fails the run loudly instead of running
  unlocked.
- `TARGET_REV="${1:-}"`, optional. With it, the checkout must end at that revision;
  without it, at the fetched head. `${1:-}` rather than `$1`, because the boot hook
  always calls it with no argument and `set -u` would abort on a bare `$1`.

Order of operations, which is the whole contract:

1. If `$CHECKOUT/.git` is not a directory, print `no checkout at <path>; skipping`
   and exit 0. The lock file lives inside `.git`, so this guard must come first:
   acquiring the lock before it would fail the redirection and exit non-zero for a
   path the script promises to skip.
2. Acquire `flock` on `$CHECKOUT/.git/codex-router-checkout.lock`, waiting up to
   `LOCK_WAIT_SECONDS` (inside `.git`, so it never appears as untracked work). On
   timeout: print `another writer held <path> for <LOCK_WAIT_SECONDS>s; giving up`
   and exit 1, leaving every ref untouched. Taking the lock here — after the
   checkout is known to be a repository, before any state is read — is what makes
   the next two checks act on state no other writer can move.
3. Inside the lock, re-read the state: a dirty checkout (`git status --porcelain`
   non-empty) prints `<path> is dirty; leaving it alone` and exits 0; then
   `branch_name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || branch_name=HEAD`,
   and a `branch_name` that is not `BRANCH` prints
   `<path> is on '<branch>', not <branch>; leaving it alone` and exits 0. The `||`
   fallback is load-bearing twice over, not decoration: a detached HEAD makes
   `rev-parse` print `HEAD`, while an **unborn** HEAD (a fresh checkout with no
   commit) makes it exit 128, which under `set -eu` would abort the script instead of
   skipping — so the assignment must absorb that failure and let the comparison route
   both cases to the same notice. Both are a live session's state and are never
   stashed, reset, rebased, or forced.
4. Fetch, bounded: `timeout 120 git -c credential.helper='!gh auth git-credential'
   fetch --quiet origin "$BRANCH"`. The bound matters because the lock serializes
   writers, not time: a hung fetch would hold the lock and block the deploy's `docker
   exec` and the boot hook until their own budgets expire. `timeout` is assumed
   present, like `flock` — it is coreutils, which the image and CI both have. This updates `refs/remotes/origin/$BRANCH` and writes
   `FETCH_HEAD`;
   the no-argument case below advances to `FETCH_HEAD`, i.e. the head of that
   branch at fetch time. A fetch failure — the most likely production failure, from
   the network or gh's credentials — exits 1 with `could not fetch origin <branch>`.
5. Move `HEAD`, only by fast-forward:
   - with a target: a target that is not reachable from the fetched head
     (`git merge-base --is-ancestor "$TARGET" FETCH_HEAD`) exits 1 with `target
     <sha> is not on origin/<branch>`. Reachability is the contract, not local
     object presence: `git cat-file -e` would accept a local-only commit that the
     branch does not carry. A target `HEAD` already contains
     (`git merge-base --is-ancestor "$TARGET" HEAD`) is a no-op that exits 0,
     because boot can already have advanced past the revision a later deploy pins;
     otherwise `git merge --ff-only --quiet "$TARGET"`, and its failure exits 1;
   - without a target: `git merge --ff-only --quiet FETCH_HEAD`, and its failure
     exits 1.
6. Print `refresh-codex-router-checkout: <path> is at <git rev-parse --short HEAD>`
   on stdout, so the deploy log shows the revision the container ended on and the
   suite can assert it.

It runs as the container's `hermes` user, never touches a session checkout, and
contains none of the literals `reset --hard`, `stash`, `rebase`, `checkout -f`,
`push --force`, or `worktree` — comments included, because the guard test is a
substring check over the whole file.

### 2. `modules/deploy.sh`

A new sibling `if should_deploy "codex-router" || should_deploy "hermes"; then …
fi` block (not nested inside the skills payload block), marked
`# ---- Hermes container codex-router checkout ----`, placed after that payload
block and after the existing `failed=0` initialisation, before the Hermes gateway
health gate. No `all` arm: `should_deploy` returns 0 as soon as any component is
`all`, so under `--component all` — which `deploy.yml` passes when the changed files
match nothing watched, including this plan's own merge, or when the manual
`components: all` input is used — both named arms already match and the block is
reached. A `modules/hermes/`-only push is a `hermes` deploy, not an `all` one. The
5-minute `sync-codex-router.yml` router-only dispatch reaches it too. It:

- guards the host-side checkout (`[ ! -d "$ROOT/modules/codex-router" ]`) and the
  script (`[ ! -f "$CHECKOUT_SCRIPT" ]`): each prints a notice and, in CI only
  (`[ -n "${GITHUB_ACTIONS:-}" ]`), counts toward `failed`, exactly as the sibling
  block accounts for its own two; an absent container (`docker inspect hermes`)
  prints a notice and skips without counting, and a readiness timeout after the poll
  below counts toward `failed` everywhere, because a container that cannot run the
  refresh is a broken environment in CI and a local run should say so too;
- waits for the container the way the sibling block above does (up to 15 × 2s
  `docker exec hermes true`), because a `hermes` deploy recreates it and `docker
  exec` during init returns non-zero; the sibling's own poll is not enough, its
  result is not reused here;
- copies the script in (`docker cp` to `/tmp`) and runs it as the checkout's owner
  (`docker exec -u hermes hermes sh /tmp/refresh-codex-router-checkout.sh
  "$CHECKOUT_TARGET"`), with `CHECKOUT_TARGET=$(git -C "$ROOT/modules/codex-router"
  rev-parse HEAD)`;
- counts any failure toward `failed` unconditionally, matching the sibling block's
  counter; production deploys always run in CI, so this is the same outcome on the
  path that matters, and a local run still reports it;
- removes the copied script afterwards (`docker exec hermes rm -f
  /tmp/refresh-codex-router-checkout.sh`, best-effort, exactly as the sibling block
  removes its own staged script);
- captures the script's output and prints its outcome on the block's own lines:
  `--- Hermes Codex Router Checkout ---` before the run, then the success line
  `✓ hermes codex-router checkout is at this deploy's revision` **only** when that
  output carries the script's step-6 `is at` line, a distinct
  `⏭ hermes codex-router checkout left alone` when it exited 0 without advancing
  (absent, dirty, other branch, unborn), and `✗ hermes codex-router checkout could
  not be advanced` on a non-zero exit. Deriving the success line from the exit code
  alone reported success on a stale checkout for those four skip outcomes, which is
  the failure this change exists to prevent. The test pins all three strings.

The environment is therefore **advanced to at least the deployed revision**: the
container checkout is never behind what the deploy shipped, but a boot between
deploys can leave it ahead of the reconciled roots, which is why the target case
treats an already-contained revision as satisfied rather than as an error.

### 3. `modules/hermes/50-seed-defaults`

Run the same refresh on boot as `hermes` (`su -m -s /bin/sh hermes -c`), with no target
so it tracks `origin/main`; a recreated container heals itself. It runs the
image-baked copy `/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh`
(`COPY scripts/` in the Dockerfile, plus `chmod +x`): that copy changes exactly when
the hermes image is rebuilt, which is when this hook changes, while the deploy's own
`docker cp` copy is what refreshes the container between rebuilds. The call is a
line of its own **after** both the skills probe block's `fi` and the hook's
`gh auth login --with-token` block, with its own guarded redirect. Two reasons for
that position: `test-50-seed-defaults.sh` extracts and executes the probe block,
stubs only the reconcile script, and asserts the log equals exactly the stub's
output, so a call inside the block would run an unstubbed path and break an
assertion this plan lists in Verification; and the fetch needs a credential, which on a
fresh volume comes from the boot hook's scoped fallback PAT secret file
(`/run/secrets/friday_pat`).
The `gh auth login` block above is not what makes this work: the refresh uses a
one-shot credential because its checkout is separate from the App gh config.
The call is `GH_TOKEN="$(cat /run/secrets/friday_pat)" su -m -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh'`:
`-m` preserves the scoped credential for the legacy checkout refresh, so no inner
re-export is needed, while the service no longer carries an ambient `GH_TOKEN` that
would override the App account for unrelated gh commands. It carries a fallback (`|| echo "WARNING: could not advance the
codex-router checkout …"`), so a failed refresh logs and never fails the boot, and
it appends to the same `/opt/data/logs/codex-router-skills-sync.log` the reconcile
writes. Verification gains one boot-path check: after a container recreate or a
`50-seed-defaults` re-run on a fresh volume, the log must show either the advanced
SHA or a fetch error, never silence.

Why boot at all: `/workspace` is a host bind mount (`modules/docker-compose.yml`),
so a container recreate alone preserves the checkout. Boot covers the cases that do
not — a fresh or restored volume, and a checkout left behind by a failed deploy.

Accepted risk, session interaction: the refresh fast-forwards this checkout while a
live session may be executing the driver from it, and the newer driver refuses that
session's schema-3 state. Nothing here can reliably detect an in-flight session, so
the risk is accepted and documented; the remedy is the one
[#614](https://github.com/darrencjh8/friday/issues/614) already carries for
the parked states — archive `.agents/dev-loop-state.json` and re-init after the
session's work is captured. That issue's scope was widened to name this case.

Recovery: the script never forces, so a checkout that diverged from `origin/main`
(for example after a force-push to codex-router) keeps failing every deploy and
boot refresh. The documented escape hatch is run inside the container as `hermes`,
with the credential helper the plan's own context says is required:
`git -C /workspace/codex-router -c credential.helper='!gh auth git-credential' fetch
origin main && git -C /workspace/codex-router reset --hard origin/main`. The
`reset --hard` **discards uncommitted changes in that checkout**, which is why it is
an operator decision and not something the script does; `DEPLOY.md` records both
halves beside the script.

### 4. Tests and docs

`modules/hermes/tests/test-refresh-codex-router-checkout.sh` runs the script as
`sh "$SCRIPT"` (never via its shebang, so a bash-only body cannot pass here and
then fail a deploy under dash) and checks `sh -n`. It drives it against real
repositories through `CODEX_ROUTER_CHECKOUT`:

- an up-to-date checkout: no-op;
- a stale clean checkout: fast-forward to `FETCH_HEAD`, and stdout names the new
  short SHA (step 6);
- an explicit target: `HEAD` lands on that revision and *away* from the fetched
  head; a target `HEAD` already contains: no-op;
- a target that exists locally but is unreachable from the fetched head: exit 1,
  refs unchanged;
- a target missing from the fetched history (all-zeros): exit 1, refs unchanged;
- a dirty checkout: skip with the work intact; a wrong-branch checkout: skip; a
  detached HEAD: skip and the notice names `HEAD`;
- a diverged checkout: exit 1; an unreachable origin: fetch failure exits 1 with
  refs unchanged; an absent checkout: skip with exit 0;
- an unborn checkout (a fresh `git init` with no commits): skip with exit 0, because
  `git rev-parse --abbrev-ref HEAD` exits 128 there and the script must not abort;
- a busy lock (`CODEX_ROUTER_LOCK_WAIT_SECONDS=1` with the lock held): exit 1 with
  every ref unchanged.

It also pins both call sites, with the scope and marker assertions kept out of the
sibling block's text, and the Python test pins the boot call's position after the
hook's `gh auth login` block, its `su -m` environment preservation, the baked path
literal, and the copy/run/remove triple plus success echo of the deploy block.

`modules/tests/test_deploy_workflow_router.py::test_hermes_container_checkout_is_refreshed`
pins the deploy block (scope, marker, guards, readiness poll, `rev-parse HEAD`
target, `docker exec -u hermes`, `failed` counter), the script (POSIX `#!/bin/sh`
with `set -eu`, executable; dirty, branch, detached-HEAD and lock guards;
`--ff-only`; `credential.helper`; no destructive literal, comments included), and
the boot call (owner, the literal `/opt/hermes-defaults/scripts/refresh-codex-router-checkout.sh`
path, never-fail-the-boot fallback). The new suite is wired into the
`hermes-scripts` job of `.github/workflows/test.yml`, and `DEPLOY.md`'s inventory of
the scripts that reconcile the container gains the refresh and its recovery step.

## Questions and answers

Q: When the checkout cannot be advanced, what should the deploy do?
Assumption: Skip an absent, dirty, or other-branch checkout with a printed notice,
and fail the deploy when a clean checkout cannot reach the target — including a lock
that stays held past `LOCK_WAIT_SECONDS`, which exits non-zero because a silent skip
would report success with nothing verified. (Planner-inferred: the operator selected
the boot-parity and scope questions and left this one to this recommendation.)

Q: Should the refresh also run at container boot?
A: Yes. (Operator-selected.) The boot hook runs the same script as `hermes` with no
target, tracking `origin/main`, so a fresh or restored volume heals itself. Not a
plain recreate: `/workspace` is a host bind mount, so recreating the container keeps
the checkout; boot covers the volume cases and a checkout left by a failed deploy.

Q: Which deploys refresh the checkout?
A: Both a router-only deploy (`components=codex-router`) and a `hermes` deploy.
(Operator-selected.) That is the same scope as the skill reconcile.

Q: Which revision does the deploy target?
Assumption: The revision this deploy checked out (`git -C
"$ROOT/modules/codex-router" rev-parse HEAD`), not whatever `main` is at deploy
time, so the checkout is advanced to at least the deployed revision — not to exactly
one revision, because boot may already have moved it ahead of the reconciled roots.
(Planner-inferred, not operator-confirmed.)

Q: Which identity runs the refresh?
Assumption: The container's `hermes` user in both callers (`docker exec -u hermes`,
`su -m -s /bin/sh hermes -c`). (Planner-inferred, not operator-confirmed.) Verified: the
checkout is owned by `hermes`, running as root trips git's `dubious ownership`, and
root writes would leave objects the sessions cannot extend when they create
worktrees.

Q: How does the fetch authenticate?
Assumption: An inline `-c credential.helper='!gh auth git-credential'` on the fetch,
because the image's git has no credential helper and gh is already authenticated.
(Planner-inferred, not operator-confirmed.) Verified: `git ls-remote origin main`
returns `c80dfb8` with that helper. Nothing is persisted to git config.

Q: Can this disturb a session that is using the checkout?
Assumption: No. (Planner-inferred, not operator-confirmed.) The script operates on
the base repository only, never on a worktree, skips a dirty or other-branch
checkout entirely, and holds its lock across the fetch and the merge; a fetch plus
fast-forward leaves existing worktrees and stashes untouched.

Q: Can the refresh disturb a live session that is driving this checkout?
Assumption: It can, and that is an accepted risk rather than a guarded case.
(Planner-inferred, operator-confirmed as accepted risk.) A session executing the
driver from `/workspace/codex-router` can be fast-forwarded under itself, and the
newer driver then refuses its schema-3 state, exactly as the parked states are
refused. Nothing here can reliably detect an in-flight session, and a heuristic
guard would be worse than the risk; the remedy is #614's, whose scope now names this
case: archive `.agents/dev-loop-state.json` and re-init after the session's work is
captured.

Q: Do other checkouts in the container need the same treatment?
Assumption: No. (Planner-inferred, not operator-confirmed.) Searching the session
database for `dev-loop/scripts/loop.py` found this checkout as the only
repository-local driver source, plus the installed skill copies.

## Out of scope

- The five parked schema-3 states under `/workspace/issue-*`: the current driver
  refuses them (`state schema version 3 is not 5 … archive … and run loop.py
  init`). Before this change they resumed under the old driver; after it they
  cannot resume at all, which is the intended direction but an operator decision
  this change cannot make. Tracked in
  [#614](https://github.com/darrencjh8/friday/issues/614), which archives
  or re-inits each state that is still wanted.
- The dev-loop plan pack's Change scaffold: it looks for
  `.github/workflows/tests.yml`, reports "no test command" and "no test files" for
  this repository, and was bound to a dangling commit in round 1. Regenerating the
  pack here is automatic (the next `plan` run does it), but the filename assumption
  and the rest are the pack builder's, tracked in
  [codex-router#161](https://github.com/darrencjh8/codex-router/issues/161).
- `/opt/data/home/.codex/skills` (September generation). It is inert — no `codex`
  binary exists in the container — and the reconciler's shadow list does not cover
  that root. Cleaning it up is a separate decision.

## Verification

- `bash modules/hermes/tests/test-refresh-codex-router-checkout.sh`
- `python -m unittest modules.tests.test_deploy_workflow_router`
- `bash modules/hermes/tests/test-dev-loop-skill.sh`,
  `bash modules/hermes/tests/test-codex-router-skills-sync.sh`,
  `bash modules/hermes/tests/test-50-seed-defaults.sh`,
  `bash modules/hermes/tests/test-deploy.sh`
- `shellcheck modules/hermes/scripts/*.sh modules/hermes/50-seed-defaults`
- `DEPLOY.md` names the refresh beside the other container-reconciling scripts
- after merge the deploy log must print the checkout's new short SHA, and a fresh
  session's driver path must resolve to the deployed revision
