QUESTIONS
q: Which Google Tasks list should receive reminder tasks? | a: Use the user-selected list `Planned`.
q: What lead time applies to each reminder type? | a: Use per-type lead days: claim or collect 60 days; cancellation or re-plan 30 days; annual or one-off date 7 days; monthly payment 3 days; fee waiver, reward, and post-charge checks 0 days (due on the statement or posting date). Create when `0 <= action_date - today <= lead_days`, with the Google Task due date equal to the action date. Process each candidate independently: create all classifiable due tasks first, then report each unclassified item individually without guessing or dropping valid work. Missed 0-day runs are never backfilled as tasks; the existing overdue digest path reports them for manual creation.
q: When should an annual-fee waiver call happen? | a: Only after the statement covering the fee month is available and the fee appears. Treat the wiki's explicit `Reminder date` as the action date, and tell the user to verify the fee line before calling. No advance lead is useful; use 0 days.
q: How should repeated daily runs avoid duplicate tasks? | a: Add a deterministic marker in task notes based on the wiki item and occurrence period; query `Planned` including completed tasks before creating. If a marker already exists, skip creation; if its due date conflicts with the current wiki date, report it without updating or duplicating the task.
q: Which wiki content is eligible? | a: Use only current, dated, actionable items in `entities/accounts/important-dates.md` and `entities/accounts/recurring-payments.md`; skip cancelled, historical, stale, ambiguous, undated, and overdue items. Do not infer dates.
q: How should the first task writes be handled? | a: Before implementing or deploying task-writing behavior, produce a candidate preview from the private wiki mirror and wait for the user's approval; no Google Tasks are created during preview, implementation, or validation.
q: Which failing control test demonstrates the feature? | a: `test_wiki_reminder_tasks.WikiReminderTaskTests.test_daily_cron_targets_planned_with_duplicate_markers` must fail at base and pass at HEAD.

# Wiki Reminder Google Tasks

## Goal
Extend the existing daily `wiki-due-reminders` cron to create one safe, deduplicated Google Task per eligible wiki action in the user-selected `Planned` list, using per-type lead times before its action date.

| Type | Lead | Example |
|---|---|---|
| Claim or collect | 60 days | Claim miles or rewards before renewal |
| Cancellation or re-plan | 30 days | Standard Chartered closure, CardUp re-plan |
| Annual or one-off date | 7 days | Microsoft 365, Google One, income-tax payment |
| Monthly payment | 3 days | GXS, Trust, Maxis |
| Fee waiver, reward, or post-charge check | 0 days (due on statement or posting date) | Waiver call, UNI$ or cashback verification |


## Scope
- Clarify annual-fee waiver timing in the private wiki: call only after the statement is available and the fee line appears; use the documented statement/reminder date as the call action date.
- Update the managed cron prompt step 2 to the same five-type lead table. The digest reports an item as due when `days_left <= lead_days` plus overdue-once; the helper creates a task only when `0 <= action_date - today <= lead_days`. Items inside the digest window but outside the creation window appear under a `Pending task creation` section, and `[SILENT]` applies only when nothing is digest-due, pending, overdue, conflicting, or unclassified.
- Add a small helper that receives candidate JSON on stdin, enforces the per-type lead window (`0 <= action_date - today <= lead_days`), reads the `Planned` list with completed tasks included, deduplicates by deterministic note marker, and invokes `gtasks` with argument arrays (no shell interpolation). Process each candidate independently: create every classifiable due task, then report conflicts, command failures, and each unclassified item individually; exit non-zero when any item needs operator attention, but never skip valid creates because one candidate is bad. Never update, delete, or move tasks.
- Extend the Hermes skill with the narrowly authorized cron behavior and the safe command boundaries.
- Add tests for per-type lead-window boundaries (including 60-day claim and 0-day due-date behavior), mixed-batch isolation where one unclassified candidate does not block valid creates, duplicate and completed-task detection, conflict handling, safe argument passing, and seed prompt wiring (including the digest `Pending task creation` section and `[SILENT]` rule).

## Out of scope
- OAuth setup, credentials, user tokens, or first-run Google Tasks writes.
- Changes to other cron jobs, Notion, Google Calendar, or wiki reminder dates.
- Editing or deleting existing Google Tasks.

## Verification
- RED control: `test_wiki_reminder_tasks.WikiReminderTaskTests.test_daily_cron_targets_planned_with_duplicate_markers` fails at the base and passes at HEAD.
- Run focused helper unit tests and `modules/hermes/tests/test-50-seed-defaults.sh` with the repository's test environment.
- Verify the Docker/CI Hermes image and cron seed path through the existing CI workflow.
- Before implementation or deployment can enable task writes, preview currently eligible wiki actions from the private wiki mirror and wait for the user's approval. Preview is read-only; no Google Tasks are created during preview or verification.

## Acceptance
- A daily rerun, including after a task is completed, does not create a second task when its marker is still present in `Planned`.
- No task is created outside its inclusive per-type lead window or for an invalid/overdue date.
- A task due date matches the wiki action date; annual-fee tasks instruct the user to check the fee appears on the issued statement before calling.
- User content is passed to `gtasks` without shell evaluation, and the target list is always `Planned`.
- Operator-selected cron schedule, enabled state, and delivery channel remain unchanged. Digest prompt step 2 moves to the same five-type lead table; an item reported as digest-due cannot be silently filtered by the helper, and not-yet-due creation candidates appear as pending.
