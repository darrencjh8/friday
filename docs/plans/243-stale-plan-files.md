# Plan: delete 58 stale plan files (friday #243)

QUESTIONS
q: Delete exactly the 58 files the issue's scan listed (frozen at issue time, 2026-11-16 07:57 UTC), or recompute the stale set at build time (which would add 123-clear-high-dependabot-alerts.md and 198-sysstat-docker-image.md, and 202-pii-scan-false-positives.md hours later)? | assumption: frozen 58 — the issue is the unit of work; the weekly stale-plan scan re-lists stragglers on its next run.
q: Keep the 6 PII-allowlist files exempt permanently, or delete them once the allowlist entries are re-pointed? | assumption: keep exempt — the scan workflow itself exempts them, and modules/tests/test_issue_185.py reads the 185 file at test time.

## Goal

Delete the 58 stale `docs/plans/*.md` files named by friday #243 (last touched
before 2026-11-09 07:57:36 UTC), one commit, one PR, `fixes #243`. Pure
deletion, 4,181 lines removed, no other file changes.

## Fact-checks (verified 2026-11-17 in a fresh clone at HEAD 970a118)

- The issue's list is exact, not just the 20 shown. Re-running the scan
  workflow's own rule (committer date `<` 2026-11-09 07:57:36 UTC, the
  workflow's 6 exemptions, skip while the numbered issue is open) over the
  72 files in `docs/plans/` yields exactly 58 files: the 20 named in the
  issue plus 38 more. `123-clear-high-dependabot-alerts.md` is NOT in the
  58: its last commit is 2026-11-09 15:48 UTC, after the cutoff.
- Each of the 58 was confirmed individually:
  - 18 files name a closed friday issue (18, 20, 22, 24, 26, 28, 30, 48,
    119, 129, 131, 144, 151, 177, 184, 188, 192, 194 — all `closed` via
    `gh api`, 2026-11-17).
  - 7 files name an issue that does not exist in this repo (694, 799, 844,
    issue-372, issue-598, issue-627, issue-720 — all HTTP 404 via
    `gh api`): legacy darren-openclaw import numbers, no matching issue
    to keep them alive.
  - 33 files are unnumbered legacy plans with no issue to check; git
    history keeps their blobs.
  - No file in the 58 names an open issue: the only open-issue plan file
    is `220-persona-restore.md` (#220, still open), last touched
    2026-11-13, not stale.
- Nothing reads the 58. `grep -F` for each basename over the whole tree
  (excluding `.git` and `docs/`) returns 0 hits; no other plan file
  mentions any of them; no workflow besides `.github/workflows/
  stale-plan-scan.yml` mentions plans; README.md mentions `docs/plans/`
  only as a directory description. No open PR (245, 250, 251) touches
  any plan file.
- The dev-loop driver never reads plan files from main: `grep -r
  "docs/plans"` over the installed dev-loop skill (SKILL.md, policy.json,
  loop.py, state.py) returns nothing; the plan path comes from driver
  state, and its git reads are historical (`git show <commit>:<path>`),
  so deleting the files from HEAD breaks no driver lookup. Approval
  comments cite the plan hash, and the blob stays in git history, so past
  approvals stay verifiable.
- The 6 exempt files are the only ones with live references, and all 6
  are outside the 58: `185-pii-allowlist-false-positives.md` is read at
  test time by `modules/tests/test_issue_185.py:31` (deleting it fails
  that test), and `scripts/pii-scan-allowlist.json` names the other 5
  as the file where an allowlisted value occurs
  (695-portfolio-tracker-responses-auto-thinking.md,
  hermes-deepseek-flash-routing.md, litellm-account-pool-fallbacks.md,
  hermes-v0217-upgrade.md, pr-654-transfer-fix-review-findings.md).

## Files to delete (58, exact)

- 119-cron-no-wrap.md
- 129-gtasks-delete-completed.md
- 131-email-ignore-rules.md
- 144-deploy-diff-since-last-deploy.md
- 151-dots-notifications.md
- 177-persist-threshold-and-mcp.md
- 18-reminders-edit.md
- 184-docs-drift-guard.md
- 188-reaction-approves.md
- 192-seeded-cron-task-dates.md
- 194-jev-drift-advisory.md
- 20-reminders-sections-ui.md
- 22-reminders-ux.md
- 24-reminders-style.md
- 26-reminders-edit-mobile.md
- 28-autoclose-stale-daily-tasks.md
- 30-load-collision-notes-duplication.md
- 48-statement-zero-due-skip.md
- 694-expense-tracker-responses-llm-outage.md
- 799-actual-api-version-mismatch.md
- 844-reminders-dashboard.md
- actual-api-budget-list-cache.md
- claude-usage-diagnostics.md
- critical-dependabot.md
- cron-failure-marker.md
- cron-skill-protection.md
- dots-continuity.md
- friday-calendar-delete-dedupe-notion-daily.md
- gcal-add-events.md
- github-app-auth.md
- google-tasks-cli.md
- gtasks-profile-env.md
- hermes-adjudicator-commandcode-key.md
- hermes-api-server-conduit.md
- hermes-container-checkout-refresh.md
- hermes-cron-names-mnemosyne-curator.md
- hermes-disk-cleanup-seed.md
- hermes-gateway-stop-before-recreate.md
- hermes-memory-maintenance.md
- hermes-stable-v0222-refresh.md
- hermes-stop-grace.md
- hermes-webui-api-mode-routing.md
- hermes-webui-in-container.md
- high-dependabot.md
- issue-372-bill-payment-resolution.md
- issue-598-own-account-fast-transfer-pair.md
- issue-627-onedrive-silent-pull-failure.md
- issue-720-jev-classification-fallback.md
- memory-cron-notify-and-daily-compact.md
- notion-mcp-integration.md
- ops-log-capped-collection.md
- pii-scan-allowlist.md
- qpdf-password-stdin.md
- skill-merge-approval.md
- slack-profile-env.md
- taxonomy-without-classification.md
- wiki-google-task-reminders.md
- wiki-txn-window-complete.md

## Files that stay

- The 6 exempt files above (185 + the 5 allowlist-provenance files).
- The 7 fresh plan files (last touched 2026-11-10..14): 198, 202, 205,
  207, 211, 212, 220.
- This plan file itself (`243-stale-plan-files.md`).
- Not in this PR, caught by the next weekly scan: 123 (aged in
  2026-11-09 15:48 UTC, after the issue's cutoff), 198 (2026-11-10
  00:48 SGT), 202 (2026-11-10 11:08 SGT).

## Implementation

1. Branch from current `main` (e.g. `chore/243-stale-plan-files`).
2. Before deleting, re-derive the list with the workflow's rule at the
   build-time cutoff and diff it against the frozen 58 above. If any of
   the 58 is gone, newly referenced, or newly matching an open issue,
   STOP and report instead of deleting — do not silently adjust the list.
3. `git rm` exactly the 58 files. No other file changes: no allowlist
   edits (its entries pin commit hashes that stay in history), no
   workflow edits, no README edits.
4. One commit, message `chore(plans): delete 58 stale plan files older
   than 7 days (fixes #243)`. Push, open one PR with `fixes #243` in the
   body, Darren (darrencjh8) as requested reviewer.
5. Wait for ALL CI checks on the PR head to go green before presenting
   it for review; a failing check is investigated and fixed first, never
   presented as out of scope. Never merge — Darren merges.

## Validation (docs-only change: no RED control, green check only)

- `git status --porcelain` clean except the 58 deletions; `git diff
  --stat` shows 58 deleted files, 4,181 deletions, 0 additions.
- `python3 -m pytest modules/tests/test_issue_185.py -q` passes (the
  exempt 185 file is untouched).
- Re-run the scan rule after the deletion: 0 stale candidates remain
  (excluding the 6 exempt files).
- No full test suite locally; CI owns the suite.

## Rollback

`git revert` the PR. The blobs stay in git history either way, so a
revert restores the files byte-identical.

## Risks

- None material. The only known breakage from deleting a plan file
  (test_issue_185.py reading the 185 file) is excluded by exemption.
  The 5 allowlist-provenance files stay so their entries remain
  verifiable against a file on disk, not just in history.
