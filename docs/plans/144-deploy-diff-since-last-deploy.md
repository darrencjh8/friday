QUESTIONS
q: How does the detect step learn the last successful deploy's commit? | a: It calls the GitHub API with curl (curl is proven on the self-hosted runner: deploy.yml's own later step runs curl -fsSL on the host): GET /repos/{owner}/{repo}/actions/workflows/380193322/runs?branch=main&status=success&event=push&per_page=1, with Authorization: Bearer $GITHUB_TOKEN passed explicitly as env GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}. The head_sha is extracted with sed -n 's/.*"head_sha": *"\([0-9a-f]\{40\}\)".*/\1/p'. The workflow is identified by its numeric id 380193322, not its filename. No new secret, no new permission: listing runs needs actions: read, which the deploy job's actions: write already implies.
q: What happens when the base cannot be resolved for any reason? | a: One fallback for every case — no prior successful deploy, empty API result, non-2xx response, unparsable response, or a base that is not an ancestor of HEAD: deploy all components. There is no HEAD~1 fallback anywhere in the new logic.
q: The checkout uses fetch-depth: 2, so an older base commit may not be present locally, and a merge-base check fails in a shallow clone. How is that handled? | a: The checkout fetch-depth changes from 2 to 0 (full history). The base is then always present locally, no fetch of the base is needed, and git merge-base --is-ancestor works. Cost: a full clone on every deploy run, accepted because the deploy already builds images and correctness of the component set matters more than clone time.
q: GitHub Actions runs steps with bash -eo pipefail, so a failing curl or merge-base would kill the step before the fallback runs. How is that handled? | a: Every fallible line is guarded: the curl runs as $(curl ... || true), and the merge-base check is written as git merge-base --is-ancestor "$BASE_SHA" HEAD || { echo "components=all" >> "$GITHUB_OUTPUT"; exit 0; }. The test runs the step under bash -eo pipefail to match Actions.
q: Does the new logic apply to workflow_dispatch runs too? | a: Yes when the dispatched ref resolves to main (inputs.ref empty or "main"): the lookup runs the same way. For any other ref the step deploys all components, since "changes since the last main deploy" is meaningless for a non-main ref.
q: Which runs count as the last successful deploy? | a: Runs of deploy.yml (workflow id 380193322) on branch main with status success and event push. The event=push filter stops a single-component dispatch run from poisoning the base. The current run is not successful yet, so the lookup returns the previous deploy.
q: The already-dropped 2026-11-03 changes (#140 expense-tracker, #127 portfolio-tracker) predate the fix. How are they healed? | a: They are not healed by the fix itself: the first fixed run's base is still a pre-fix run that deployed only its own commit. After the PR merges, the owner (Darren) runs one manual workflow_dispatch with force_all=true, then verifies the running expense-tracker contains the #140 change and portfolio-tracker has the #127 zod upgrade. After that healing run, the last-successful base is sound and the fix protects later bursts.

# Plan: diff the deploy against the last successful deploy (issue #144)

## Goal

Fix friday #144: when several PRs merge within minutes, a queued deploy run
gets cancelled and the surviving run never ships the cancelled run's changes,
because it computes components with `git diff --name-only HEAD~1 HEAD`.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  command `python3 modules/tests/test_issue_144.py`, test id
  `tests.test_issue_144.TestIssue144.test_deploy_covers_cancelled_runs`.
  At base it fails: in a simulated burst (an initial commit, then
  expense-tracker, portfolio-tracker, hermes) with the last successful
  deploy at the initial commit, the step reports only `hermes`.
- Current state verified by file reads: `.github/workflows/deploy.yml`,
  "Detect changed modules" step, uses `CHANGED=$(git diff --name-only
  HEAD~1 HEAD ...)`; checkout uses `fetch-depth: 2`; concurrency group
  `production-deploy` with `cancel-in-progress: false`; deploy job runs on
  `self-hosted` with permissions `contents: read, actions: write`.
- In-repo precedent: `.github/workflows/sync-codex-router.yml` already
  queries the same runs endpoint (without the event filter), and
  `.github/workflows/test.yml` already uses `git merge-base` for a
  base-vs-head diff.

## Changes

1. `.github/workflows/deploy.yml`.
   - Checkout: `fetch-depth: 2` becomes `fetch-depth: 0`, so the base
     commit is always present and `git merge-base` works.
   - "Detect changed modules" step: add two env entries,
     `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and
     `DISPATCH_REF: ${{ inputs.ref || '' }}`.
   - Before the existing component mapping, resolve `BASE_SHA`:
     - If `LAST_SUCCESSFUL_DEPLOY_SHA` is set, use it. This override is
       test-harness-only: no workflow input or step env ever sets it in
       production.
     - Else, when the run is a push, or a dispatch whose ref is empty or
       `main`, call
       `curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
       "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/workflows/380193322/runs?branch=main&status=success&event=push&per_page=1"`
       (guarded with `|| true` so a failed request cannot kill the step
       under `bash -eo pipefail`) and take `.workflow_runs[0].head_sha`
       via `sed -n 's/.*"head_sha": *"\([0-9a-f]\{40\}\)".*/\1/p'`.
       A non-2xx response, an empty result, or an unparsable response
       means no base.
     - For a dispatch on any other ref, there is no base.
   - If there is no base, write `components=all` and exit. This is the
     single fallback for every unresolvable case.
   - Require the base to be an ancestor: `git merge-base --is-ancestor
     "$BASE_SHA" HEAD || { echo "components=all" >> "$GITHUB_OUTPUT";
     exit 0; }`. (If `BASE_SHA` equals HEAD, the diff is empty and the
     existing mapping already yields `all`.)
   - Diff `git diff --name-only "$BASE_SHA" HEAD` instead of
     `HEAD~1 HEAD`. The rest of the component mapping is unchanged.
   - The string `HEAD~1` does not appear anywhere in the new logic.
2. Tests:
   - `modules/tests/test_issue_144.py`: the reproduction control, kept
     as RED/GREEN (fails at base, passes at HEAD). It extracts the
     detect step from deploy.yml and runs it under `bash -eo pipefail`
     (matching GitHub Actions) in throwaway repos:
     - Override case: burst of initial + 3 module commits,
       `LAST_SUCCESSFUL_DEPLOY_SHA` set to the initial commit; assert
       the exact component set is
       `expense-tracker portfolio-tracker hermes`, not `all` and not a
       subset.
     - Full-clone case: a real `origin` remote with a full clone, so
       the no-fetch path is exercised.
     - Non-ancestor case: the override points at a commit on a
       divergent branch; assert `components=all`.
     - Lookup case: a stub `curl` on PATH returning a pretty-printed
       runs payload; assert the step uses the returned head_sha, and
       assert the stub saw `event=push` in the URL and an
       `Authorization: Bearer` header.
     - Failure case: stub `curl` failing and no override; assert
       `components=all`.
     - Dispatch case: `GITHUB_EVENT_NAME=workflow_dispatch` with
       `DISPATCH_REF=main` (lookup path) and with `DISPATCH_REF=other`
       (`components=all`).

## Remediation (owner, post-merge)

- After the PR merges, Darren runs one manual workflow_dispatch with
  `force_all=true`, then verifies the running expense-tracker contains
  the #140 change and portfolio-tracker has the #127 zod upgrade.
  Until that healing run, the fix only prevents future drops; it does
  not ship the already-dropped changes.

## Out of scope

- No change to the concurrency group or cancellation behaviour.
- No change to the codex-router submodule checkout; the diff covers the
  friday repo only, as before.
- No change to the build or deploy steps, and no production run, restart
  or rebuild by the agent. The fix is verified by the test and by CI on
  the PR only.
- No new secrets or permissions.

## Verification

- `python3 modules/tests/test_issue_144.py` passes at HEAD (was failing
  at base).
- The workflow is validated by a YAML parse plus a dry extraction of the
  detect step.
- Dev-loop review round, then push branch and create PR, no merge by
  the agent. The workflow file is deploy machinery, so the PR needs the
  owner's merge.
