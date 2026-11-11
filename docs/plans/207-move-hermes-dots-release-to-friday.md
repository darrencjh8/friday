QUESTIONS
q: Does the existing cross-repo access input have write access to hermes-dots (needed to create the tag and release there)? | assumption: Yes — friday already uses it against private repos — but not verified; the implementer must verify it before merging, and if it cannot write there Darren creates a new stored access value in friday with write access to hermes-dots.
q: Do the five stored build values exist in friday? | assumption: No — Darren adds them under the same names before the first run.
q: Can the Friday App open a PR that adds .github/workflows/ files? | assumption: No — recorded precedent from friday #205 is that a push adding a workflow file was blocked for lack of workflows permission; the implementer must verify, and if it still holds the PR is opened by Darren or another agent with workflow write access.

# Plan: move hermes-dots Android release build to friday + separate codex-only ship without tests

Issue: darrencjh8/friday#207
Base: friday main `4d2c475`
Kind: feature (two new workflows; no app code changes)

## Fact-check (verified 2026-11-11, live main)

- friday is public; hermes-dots and codex-router are private. Actions minutes
  on a public repo are free; on a private repo they are paid. That is the whole
  reason for the move.
- The codex-router approach already works this way: friday
  `.github/workflows/codex-router-ci.yml` checks out private
  `darrencjh8/codex-router` into friday (via the existing cross-repo access
  input passed as `token:`) and runs on `ubuntu-latest` in friday.
- friday `.github/workflows/deploy.yml` ("Deploy to Production"): on push to
  main and on manual dispatch. Its `test` job calls the reusable
  `.github/workflows/test.yml` (friday module tests: expense-tracker,
  actual-api, portfolio-tracker — not codex-router unit tests) on dispatch
  only; its `deploy` job runs on the self-hosted runner, checks out friday
  plus codex-router into `modules/codex-router`, detects changed modules,
  runs `modules/build.sh` then `modules/deploy.sh --component <c>
  --non-interactive --skip-build`, and records the shipped codex-router SHA
  as an artifact. Codex-router unit tests run separately in
  `codex-router-ci.yml`, triggered by repository dispatch from codex-router.
- hermes-dots `.github/workflows/android-release.yml` (live main, matches the
  saved copy): schedule `0 22 * * *` (06:00 SGT), manual dispatch with a
  `force` input, a `check` job that skips when HEAD equals the latest release
  tag's commit, and a `release` job (Java 17, Android setup, Gradle,
  `./scripts/check-hardening.sh`, version step, Firebase + signing steps,
  `./gradlew --no-daemon testDebugUnitTest assembleRelease`, release via
  `softprops/action-gh-release` with no `repository:` input, so it releases
  in the repo the workflow runs in).
- hermes-dots latest release: `v0.2.0.34`, target `8c25e14`, created
  2026-11-11. `gradle.properties`: `appVersionName=0.2.0`,
  `appVersionCode=2`. The version step builds
  `VERSION_NAME=0.2.0.<run_number>` and `VERSION_CODE=100+<run_number>`,
  so the last published build has versionCode 134.
- `UPDATE_REPO` is baked into the app (`app/build.gradle.kts`,
  `AppUpdater.kt`): the in-app updater reads the latest release of that
  repo. The live workflow sets it to `${{ github.repository }}`; in friday
  that would be friday, so it must be set to `darrencjh8/hermes-dots`.

## Workflow 1: `friday/.github/workflows/hermes-dots-release.yml`

A copy of the live hermes-dots release workflow, moved to friday, with only
the cross-repo changes below. No change to the build itself.

- Triggers at first: `workflow_dispatch` only, with the same `force`
  boolean input. No `schedule:` yet — the schedule is added in a follow-up
  after PR B merges (see Implementation), so the two schedules can never
  both be live at once. The schedule, when added, is
  `schedule: [{cron: '0 22 * * *'}]` (06:00 SGT, unchanged).
- `permissions: contents: read` on the workflow. The friday workflow's own
  `GITHUB_TOKEN` cannot write to another repo, so every cross-repo step
  uses the existing cross-repo access input (the one `codex-router-ci.yml`
  and `deploy.yml` already pass as `token:` when checking out a private
  repo) instead.
- `concurrency: {group: hermes-dots-release, cancel-in-progress: false}`.
- `check` job (`ubuntu-latest`): check out `darrencjh8/hermes-dots`
  (`repository:`, `token:` = cross-repo access input, `fetch-depth: 0`).
  `gh release list --repo darrencjh8/hermes-dots --limit 1` for the latest
  tag; compare that tag's commit with the checked-out hermes-dots HEAD
  (never friday's `github.sha`). The `gh` step needs
  `env: GH_TOKEN: ${{ secrets.SUBMODULE_PAT }}` — the workflow's own
  `GITHUB_TOKEN` cannot read the private hermes-dots repo, so without
  this the check fails on the first run. `force: true` on manual dispatch
  releases anyway. Outputs `release: true/false`, same as today.
- `release` job (`ubuntu-latest`, `needs: check`,
  `if: needs.check.outputs.release == 'true'`, `timeout-minutes: 30`,
  `defaults.run.working-directory: hermes-dots` after checking the repo
  out to that path): setup-java 17, setup-android (platform-tools),
  setup-gradle,
  hardening check, Firebase step, signing step, Gradle build — all copied
  unchanged, same pinned action versions.
- Version step (the one real change): do NOT use `github.run_number`.
  A new workflow in friday starts its run number at 1, so
  `100 + run_number` would publish versionCode 101 and name `v0.2.0.1`,
  both below the last published 134 / `v0.2.0.34`. Instead read the latest
  hermes-dots release tag `v0.2.0.N`, set `NEXT=$((N + 1))`,
  `VERSION_NAME=0.2.0.${NEXT}`, `VERSION_CODE=$((100 + NEXT))`, and fail
  the job if the tag does not parse or the new code is not above the last
  published code. This stays correct no matter how many runs friday has.
- `UPDATE_REPO` env on the Gradle step: `darrencjh8/hermes-dots` (not
  `${{ github.repository }}`).
- Release step: `softprops/action-gh-release` with
  `repository: darrencjh8/hermes-dots`, `token:` = cross-repo access
  input, `tag_name: v<version>`, `name: Friday <version>`,
  `target_commitish:` = the checked-out hermes-dots HEAD SHA,
  same files and body — but with the checkout path prefixed:
  `hermes-dots/dist/*.apk`, `hermes-dots/dist/*.sha256`. The prefix is
  required: `working-directory` applies only to `run:` steps, while the
  release action resolves its `files:` globs against the workflow root
  (friday), so unprefixed globs would match nothing and publish a release
  with no APK. Nothing is released in friday.
- Prerequisite, done by Darren before the first run: the five stored
  values the build reads (Firebase file, release keystore + its three
  matching values, same names as in the live workflow) must exist in
  friday under the same names. If they are absent the build runs unsigned
  and publishes nothing, exactly as today. No stored value is ever handled
  by the worker or written in the plan, issue, or PR.

## Workflow 2: `friday/.github/workflows/deploy-codex-router.yml`

A copy of `deploy.yml`'s ship job only, with the component fixed.

- Triggers: `workflow_dispatch` only. Inputs: `ref` (branch/tag/SHA,
  default `main`), `environment` (default `darren-prod`). No push, no
  schedule.
- No test job at all: no `uses: ./.github/workflows/test.yml`, no call
  to `codex-router-ci.yml`, no unit tests. The job has no `needs: test`.
- One job, `runs-on: self-hosted`, same `permissions` and `environment`
  as the `deploy` job in `deploy.yml`.
- Steps, copied from the `deploy` job: check out friday at `ref` and
  codex-router into `modules/codex-router` (same inputs as today);
  `modules/build.sh --component codex-router`; `modules/deploy.sh
  --component codex-router --non-interactive --skip-build` with the same
  env block as the Deploy services step (the script only reads what the
  component needs; do not prune the env block — pruning risks dropping a
  value the codex-router path reads); record the shipped codex-router SHA
  and upload it as the `codex-router-sha` artifact.
- Omitted, on purpose: the changed-module detection (the component is
  fixed, there is nothing to detect) and the "Ensure Hermes container
  tooling" step (it is gated on the hermes component and would self-skip).
- `concurrency: {group: production-deploy, cancel-in-progress: false}` —
  the same group as `deploy.yml`, so a codex-only ship can never run at
  the same time as a full ship.

## What changes in hermes-dots

One change, in a separate PR after workflow 1 is verified: remove the
`schedule:` trigger from `.github/workflows/android-release.yml` and keep
`workflow_dispatch` as a manual fallback. That stops the minutes and the
double release while keeping a fallback if the friday workflow breaks.
Do not delete the file in this change.

## What does not change

- `deploy.yml`, `test.yml`, `codex-router-ci.yml`: untouched.
- hermes-dots app code, `gradle.properties`: untouched (the version is
  computed in CI, not bumped in the repo).
- Release naming: `Friday <version>`, APK `friday-<version>.apk` + sha256.
- The hermes-dots Gradle build still runs its own unit tests
  (`testDebugUnitTest`) as part of the build; only codex-router ships
  without tests, as asked.

## Verification

- Workflow 1: manual dispatch with `force: true` once new commits exist
  since `v0.2.0.34` (it publishes exactly what the next 06:00 run
  would). Check: the run appears under friday Actions; the release
  appears in hermes-dots releases with tag `v0.2.0.35` (or the next N),
  versionCode 135, APK + sha256 attached; NO release appears in friday;
  the APK installs and the in-app updater points at hermes-dots. Then
  watch the first 06:00 run: it releases only when new commits exist and
  skips on a quiet day. Schedule triggers do not run on PRs, so PR checks
  cannot verify the schedule — the manual dispatch and the first live
  run are the verification, and the plan says so honestly.
- Workflow 2: manual dispatch with `ref: main`. Check: the run log shows
  a single job and no test job of any kind; the `codex-router-sha`
  artifact holds the shipped revision; the router answers on the host.
- Rollback: re-add the `schedule:` trigger to the hermes-dots workflow
  (one-line revert) and disable or delete the two friday workflows.
  Releases already published stay published.

## Implementation (after approval)

1. PR A in friday: add `hermes-dots-release.yml` (dispatch-only, no
   schedule yet) and `deploy-codex-router.yml` (two files, one PR).
   Darren or another agent opens it if the App cannot (see QUESTIONS).
2. Verify workflow 1 by manual dispatch; verify workflow 2 by manual
   dispatch.
3. PR B in hermes-dots: remove the `schedule:` trigger from
   `android-release.yml`.
4. Follow-up in friday: add the `schedule:` trigger to
   `hermes-dots-release.yml`, only after PR B has merged.
5. Watch the first 06:00 run from friday.

## Validation for this plan (no behaviour change, so no RED test)

- `yamllint`/workflow YAML parse of the two new files once written
  (implementation step, not this plan).
- No code or test changes, so no test suite is owed by this change.
